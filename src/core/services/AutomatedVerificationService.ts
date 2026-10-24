import { Repository } from '../database/repositories';
import { EventService } from './EventService';
import { TaskService, captureAuthorizedTaskTransitionBinding } from './TaskService';
import { VerificationService } from './VerificationService';
import { GitWorktreeService } from './GitWorktreeService';
import { ProjectStopFenceService } from './ProjectStopFenceService';
import type { ExecutionAuthorization } from '../types/domain';
import type { TaskTrigger } from '../state/taskStateMachine';

export const VERIFICATION_PASSED_EVENT = 'AUTOMATION_VERIFICATION_PASSED';
export const VERIFICATION_FAILED_EVENT = 'AUTOMATION_VERIFICATION_FAILED';
export const VERIFICATION_SKIPPED_EVENT = 'AUTOMATION_VERIFICATION_NOT_RUN';

export type AutomatedVerificationOutcome =
  | { outcome: 'PASSED'; testRunId: string }
  | { outcome: 'FAILED'; reasonCode: string; testRunId: string | null }
  | { outcome: 'NOT_RUN'; reasonCode: string };

/**
 * Verifies a settled COMPLETED product coder execution in the exact managed
 * worktree its authorization names (#230). It runs only the project's
 * owner-approved TEST command through VerificationService and the capability
 * fence, and moves the task only through TaskService.transitionAuthorizedTask:
 * CODING --SUBMIT_REPORT--> VALIDATING --EVIDENCE_GATHERED--> REVIEW_READY, or
 * VALIDATING --TESTS_FAILED--> CODING (next revision). Review stays with the
 * existing Manager/owner path; nothing is merged or integrated.
 */
export class AutomatedVerificationService {
  constructor(
    private readonly repo: Repository,
    private readonly events: EventService,
    private readonly tasks: TaskService,
    private readonly verification: VerificationService,
  ) {}

  /** True when this settled execution already has a durable verification result or skip. */
  public hasOutcome(auth: ExecutionAuthorization): boolean {
    return this.repo.getEventsByProject(auth.project_id).some((event) =>
      [VERIFICATION_PASSED_EVENT, VERIFICATION_FAILED_EVENT, VERIFICATION_SKIPPED_EVENT].includes(event.type) &&
      (event.structured_payload as { authorizationId?: unknown } | null)?.authorizationId === auth.id);
  }

  public async verify(authorizationId: string, worktrees: GitWorktreeService): Promise<AutomatedVerificationOutcome> {
    const auth = this.repo.getExecutionAuthorization(authorizationId);
    if (!auth || auth.lifecycle_version !== 1 || !auth.assignment_id || auth.settlement_status !== 'COMPLETED' || !auth.settled_at) {
      return { outcome: 'NOT_RUN', reasonCode: 'NOT_A_COMPLETED_PRODUCT_EXECUTION' };
    }
    const notRun = (reasonCode: string) => {
      this.record(auth, VERIFICATION_SKIPPED_EVENT, `Automated verification for task ${auth.task_id} did not run: ${reasonCode}.`, { reasonCode });
      return { outcome: 'NOT_RUN' as const, reasonCode };
    };

    const project = this.repo.getProjectMetadata(auth.project_id);
    const task = this.repo.getTask(auth.task_id);
    if (!project || !task) return notRun('PROJECT_OR_TASK_MISSING');
    if (project.status !== 'RUNNING' || this.repo.isProjectTrashed(project.id) || this.repo.isTaskTrashed(task.id)) {
      // Not recorded: a paused project may be resumed and verified later.
      return { outcome: 'NOT_RUN', reasonCode: 'PROJECT_NOT_RUNNING' };
    }
    try { new ProjectStopFenceService(this.repo).assertProjectRunningAllowed(project.id); } catch {
      return { outcome: 'NOT_RUN', reasonCode: 'PROJECT_STOPPED' };
    }
    if (task.state !== 'CODING' || task.revision_count !== auth.task_revision || (task.ownership_epoch ?? 1) !== auth.task_ownership_epoch) {
      return notRun('TASK_MOVED_ON');
    }
    if (!this.repo.getVerificationCommandsByProject(project.id).some((command) => command.command_type === 'TEST')) {
      return notRun('VERIFICATION_NOT_CONFIGURED');
    }

    // The worktree must be the exact, registered, unmoved one the authorization names.
    let worktree: string;
    try {
      worktree = JSON.parse(auth.canonical_payload_json ?? '{}').executionScope?.worktree;
    } catch { return notRun('EXECUTION_SCOPE_INVALID'); }
    const assignment = this.repo.getAgentAssignment(auth.assignment_id);
    if (!worktree || !assignment?.selected_worker_slot_id) return notRun('EXECUTION_SCOPE_INVALID');
    const tuple = {
      projectId: auth.project_id, taskId: auth.task_id, attemptId: auth.attempt_id ?? null, assignmentId: assignment.id,
      workerSlotId: assignment.selected_worker_slot_id, baseSha: auth.repository_head_sha, ownershipEpoch: auth.task_ownership_epoch,
    };
    const inspected = await worktrees.inspectWorktree(tuple);
    if (inspected.status !== 'INSPECTED' || !inspected.inspection.registered || !inspected.inspection.exists ||
        !inspected.inspection.sourceMatch || inspected.inspection.managedPath !== worktree) {
      return notRun('WORKTREE_NOT_VERIFIABLE');
    }

    if (!this.transition(task.id, 'SUBMIT_REPORT')) return notRun('TASK_TRANSITION_REJECTED');

    let testRunId: string | null = null;
    let passed = false;
    let reasonCode = 'TESTS_FAILED';
    try {
      const run = await this.verification.runTests(project.id, task.id, auth.attempt_id ?? null, worktree, undefined, { authorizationId: auth.id });
      testRunId = run.id;
      passed = run.exit_code === 0 && run.failed_count === 0;
    } catch (error) {
      reasonCode = (error instanceof Error && /^([A-Z_]+)/.exec(error.message)?.[1]) || 'VERIFICATION_ERROR';
    }

    if (passed && this.transition(task.id, 'EVIDENCE_GATHERED')) {
      this.record(auth, VERIFICATION_PASSED_EVENT, `Automated verification passed for task ${task.id}; ready for review.`,
        { testRunId, worktree, headSha: inspected.inspection.headSha });
      return { outcome: 'PASSED', testRunId: testRunId! };
    }
    // A failure, an unrunnable command or a rejected transition never becomes success.
    this.transition(task.id, 'TESTS_FAILED');
    this.record(auth, VERIFICATION_FAILED_EVENT, `Automated verification failed for task ${task.id}: ${reasonCode}.`,
      { reasonCode, testRunId, worktree, headSha: inspected.inspection.headSha });
    return { outcome: 'FAILED', reasonCode, testRunId };
  }

  private transition(taskId: string, trigger: TaskTrigger): boolean {
    const current = this.repo.getTask(taskId);
    if (!current || this.repo.isTaskTrashed(taskId)) return false;
    return this.tasks.transitionAuthorizedTask(taskId, trigger, captureAuthorizedTaskTransitionBinding(current)).success;
  }

  private record(auth: ExecutionAuthorization, type: string, summary: string, payload: Record<string, unknown>): void {
    this.events.record(auth.project_id, type, summary, { authorizationId: auth.id, ...payload }, auth.task_id);
  }
}
