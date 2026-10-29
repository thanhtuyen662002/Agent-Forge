import { Repository } from '../database/repositories';
import { widenTaskContext } from './TaskContextWidening';
import { ensureProjectDependencies, validateVerificationEnv } from './ProjectVerificationEnvironment';
import { EventService } from './EventService';
import { TaskService, captureAuthorizedTaskTransitionBinding } from './TaskService';
import { VerificationService } from './VerificationService';
import { GitWorktreeService } from './GitWorktreeService';
import { ProjectStopFenceService } from './ProjectStopFenceService';
import type { ExecutionAuthorization } from '../types/domain';
import type { TaskTrigger } from '../state/taskStateMachine';
import { EvidenceCollector } from '../autonomy/evidence';
import type { WorkOrder } from '../autonomy/contracts';

export const VERIFICATION_PASSED_EVENT = 'AUTOMATION_VERIFICATION_PASSED';
export const VERIFICATION_FAILED_EVENT = 'AUTOMATION_VERIFICATION_FAILED';
export const VERIFICATION_SKIPPED_EVENT = 'AUTOMATION_VERIFICATION_NOT_RUN';
const DEPENDENCY_RETRY_AFTER_MS = 10 * 60_000;

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
    private readonly evidence: Pick<EvidenceCollector, 'collect'> = new EvidenceCollector(),
    private readonly installDependencies: typeof ensureProjectDependencies = ensureProjectDependencies,
  ) {}

  /** A failed dependency install is retried after this time, per project (#336). */
  private readonly dependencyRetryAfter = new Map<string, number>();

  /**
   * Content identity of the coder's uncommitted work: HEAD stays at the base, so
   * (headSha, snapshotSha) is what a later review must be bound to.
   */
  private async snapshot(worktree: string, baseSha: string): Promise<{ headSha: string; snapshotSha: string; changedFiles: string[] } | null> {
    try {
      const collected = await this.evidence.collect({ worktree, base_sha: baseSha } as WorkOrder);
      if (!collected.snapshotSha) return null;
      return { headSha: collected.headSha, snapshotSha: collected.snapshotSha, changedFiles: collected.changedFiles };
    } catch {
      return null;
    }
  }

  /**
   * True when this settled execution already has a final verification outcome.
   * VERIFICATION_NOT_CONFIGURED is not final: once the owner approves a TEST
   * command, the same settled work is verified on the next pass.
   */
  public hasOutcome(auth: ExecutionAuthorization): boolean {
    return this.eventsFor(auth).some((event) => event.type !== VERIFICATION_SKIPPED_EVENT ||
      (event.structured_payload as { reasonCode?: unknown } | null)?.reasonCode !== 'VERIFICATION_NOT_CONFIGURED');
  }

  private eventsFor(auth: ExecutionAuthorization) {
    return this.repo.getProjectEventsOfTypes(auth.project_id, [VERIFICATION_PASSED_EVENT, VERIFICATION_FAILED_EVENT, VERIFICATION_SKIPPED_EVENT]).filter((event) =>
      (event.structured_payload as { authorizationId?: unknown } | null)?.authorizationId === auth.id);
  }

  public async verify(authorizationId: string, worktrees: GitWorktreeService): Promise<AutomatedVerificationOutcome> {
    const auth = this.repo.getExecutionAuthorization(authorizationId);
    if (!auth || auth.lifecycle_version !== 1 || !auth.assignment_id || auth.settlement_status !== 'COMPLETED' || !auth.settled_at) {
      return { outcome: 'NOT_RUN', reasonCode: 'NOT_A_COMPLETED_PRODUCT_EXECUTION' };
    }
    const notRun = (reasonCode: string) => {
      // One event per reason, so a repeated re-check does not flood the timeline.
      const already = this.eventsFor(auth).some((event) => event.type === VERIFICATION_SKIPPED_EVENT &&
        (event.structured_payload as { reasonCode?: unknown } | null)?.reasonCode === reasonCode);
      if (!already) this.record(auth, VERIFICATION_SKIPPED_EVENT, `Automated verification for task ${auth.task_id} did not run: ${reasonCode}.`, { reasonCode });
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

    // Locked npm dependencies, when the owner opted in (#336): installed beside the worktrees,
    // never into one. An install failure is the environment's, not the coder's: nothing is
    // recorded against the run, and it is verified again after a delay.
    if (this.repo.getProjectInstallDependencies(project.id)) {
      if ((this.dependencyRetryAfter.get(project.id) ?? 0) > Date.now()) return { outcome: 'NOT_RUN', reasonCode: 'DEPENDENCY_INSTALL_RETRY_PENDING' };
      let env: Record<string, string> = {};
      try { env = validateVerificationEnv(this.repo.getProjectVerificationEnv(project.id)); } catch { /* none */ }
      const installed = await this.installDependencies(worktree, env);
      if (installed.status === 'FAILED') {
        this.dependencyRetryAfter.set(project.id, Date.now() + DEPENDENCY_RETRY_AFTER_MS);
        this.events.record(project.id, 'AUTOMATION_DEPENDENCY_INSTALL_FAILED',
          `Installing the locked dependencies for task ${task.id} failed (${installed.reasonCode}); verification retries later.`,
          { authorizationId: auth.id, reasonCode: installed.reasonCode, lockSha256: installed.lockSha256 ?? null }, task.id);
        return { outcome: 'NOT_RUN', reasonCode: installed.reasonCode };
      }
      if (installed.status === 'INSTALLED') {
        this.events.record(project.id, 'AUTOMATION_DEPENDENCIES_INSTALLED',
          `Installed the locked dependencies of project ${project.id} for verification.`, { lockSha256: installed.lockSha256 }, task.id);
      }
    }

    const before = await this.snapshot(worktree, auth.repository_head_sha);
    if (!before) return notRun('EVIDENCE_UNAVAILABLE');
    if (!this.transition(task.id, 'SUBMIT_REPORT')) return notRun('TASK_TRANSITION_REJECTED');

    // The coder's own report counts (#308): a coder that says it is blocked or failed
    // (found in VidFlow M1: "the files of the earlier tasks are missing") is not
    // verified and reviewed as done; the task goes back for another revision.
    const report = this.coderReport(auth);
    if (report && (report.status === 'BLOCKED' || report.status === 'FAILED')) {
      const reasonCode = `CODER_${report.status}`;
      const contextAdded = widenTaskContext(this.repo, auth.project_id, auth.task_id, report.blockers);
      this.transition(task.id, 'TESTS_FAILED');
      this.record(auth, VERIFICATION_FAILED_EVENT, `Automated verification of task ${task.id} did not run: the coder reported ${report.status}.`, {
        reasonCode, blockers: report.blockers, contextAdded, testRunId: null, worktree,
        headSha: before.headSha, snapshotSha: before.snapshotSha, changedFiles: before.changedFiles,
      });
      return { outcome: 'FAILED', reasonCode, testRunId: null };
    }

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

    // Verification must not change the work it verified (or the result is about something else).
    const after = await this.snapshot(worktree, auth.repository_head_sha);
    if (passed && (!after || after.snapshotSha !== before.snapshotSha || after.headSha !== before.headSha)) {
      passed = false;
      reasonCode = 'WORKTREE_CHANGED_DURING_VERIFICATION';
    }
    const evidence = { headSha: before.headSha, snapshotSha: before.snapshotSha, changedFiles: before.changedFiles };
    if (passed && this.transition(task.id, 'EVIDENCE_GATHERED')) {
      this.record(auth, VERIFICATION_PASSED_EVENT, `Automated verification passed for task ${task.id}; ready for review.`,
        { testRunId, worktree, ...evidence });
      return { outcome: 'PASSED', testRunId: testRunId! };
    }
    // A failure, an unrunnable command or a rejected transition never becomes success.
    const run = testRunId ? this.repo.getTestRun(testRunId) : null;
    const output = run?.evidence_id ? this.repo.getEvidenceById(run.evidence_id)?.raw_payload ?? '' : '';
    const contextAdded = widenTaskContext(this.repo, auth.project_id, auth.task_id, [output]);
    this.transition(task.id, 'TESTS_FAILED');
    this.record(auth, VERIFICATION_FAILED_EVENT, `Automated verification failed for task ${task.id}: ${reasonCode}.`,
      { reasonCode, testRunId, worktree, contextAdded, ...evidence });
    return { outcome: 'FAILED', reasonCode, testRunId };
  }

  /** The coder.v1 report of the run, when the coder gave one; only its status and blockers are read. */
  private coderReport(auth: ExecutionAuthorization): { status: string; blockers: string[] } | null {
    const settled = this.repo.getProjectEventsOfTypes(auth.project_id, ['PRODUCT_EXECUTION_COMPLETED'], auth.task_id).find((event) =>
      (event.structured_payload as { authorization_id?: unknown } | null)?.authorization_id === auth.id);
    const payload = settled?.structured_payload as { result_payload?: { outputProtocol?: unknown } } | null | undefined;
    const text = payload?.result_payload?.outputProtocol;
    if (typeof text !== 'string') return null;
    try {
      const parsed = JSON.parse(text) as { protocol?: unknown; status?: unknown; blockers?: unknown };
      if (parsed?.protocol !== 'coder.v1' || typeof parsed.status !== 'string') return null;
      const blockers = Array.isArray(parsed.blockers)
        ? parsed.blockers.filter((item): item is string => typeof item === 'string').slice(0, 5).map((item) => item.slice(0, 300))
        : [];
      return { status: parsed.status.toUpperCase(), blockers };
    } catch {
      return null;
    }
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
