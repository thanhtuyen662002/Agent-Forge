import crypto from 'crypto';
import path from 'path';
import { Repository } from '../database/repositories';
import { verifyContextManifestIntegrity } from '../context/ContextIntegrity';
import { CanonicalExecutionPayloadSchema, computePayloadHash } from '../services/ExecutionAuthorizationService';
import { ArtifactStore } from '../services/ArtifactStore';
import { EventService } from '../services/EventService';
import { TaskService } from '../services/TaskService';
import {
  AcquireSlotLeaseResult,
  ReleaseLeaseResult,
  WorkerSlotLeaseService,
} from '../services/WorkerSlotLeaseService';
import { TaskStateMachine, TaskTrigger } from '../state/taskStateMachine';
import { AgentAssignment, ExecutionAuthorization, ProcessRun, Task, TestRun } from '../types/domain';
import { AutonomousTaskSpec, ManagerReview, WorkOrder, createWorkOrder } from './contracts';
import {
  BuildManagerContextParams,
  ManagerContextPackage,
  buildManagerContextPackage,
} from './managerPool';
import { AutonomyStore, LegacyAutonomyInventoryReport } from './store';

/** Consolidation remains deliberately single-worker until a real product task proof passes. */
export const MAX_AGY_WORKERS = 1;

export interface ProductTaskAuthority {
  task: Task;
  authorization: ExecutionAuthorization;
  assignment: AgentAssignment;
}

export interface AuthorityValidationResult {
  valid: boolean;
  authority?: ProductTaskAuthority;
  code?: string;
  error?: string;
}

export interface VerificationAttemptSummary {
  attemptNumber: number;
  testRunId: string;
  command: string;
  passedCount: number;
  failedCount: number;
  skippedCount: number;
  durationMs: number;
  exitCode: number;
  evidenceId: string | null;
  createdAt: string;
  success: boolean;
}

export interface TruthfulVerificationReport {
  taskId: string;
  totalAttempts: number;
  isFirstPassSuccess: boolean;
  latestAttemptPassed: boolean;
  hadPriorFailure: boolean;
  attempts: VerificationAttemptSummary[];
}

export interface ProductTaskAutonomyAdapterOptions {
  repo: Repository;
  leaseService?: WorkerSlotLeaseService;
  artifactStore: ArtifactStore;
  autonomyStore?: AutonomyStore;
  taskService?: TaskService;
  maxWorkers?: number;
}

export interface AuthorizedWorkOrderInput {
  authorizationId: string;
  currentHeadSha: string;
  workerId: string;
  branch: string;
  worktree: string;
  allowedPaths: string[];
  forbiddenPaths?: string[];
  dependencies?: string[];
}

export interface ExecuteProductTaskParams extends AuthorizedWorkOrderInput {
  runCoder: (workOrder: WorkOrder) => Promise<{ success: boolean; currentHeadSha: string; error?: string }>;
  runVerification: (authority: ProductTaskAuthority) => Promise<TestRun>;
  conductReview: (context: ManagerContextPackage) => Promise<ManagerReview>;
  managerContext?: Omit<BuildManagerContextParams, 'workOrder' | 'currentHead'>;
}

export interface ExecuteProductTaskResult {
  success: boolean;
  finalTaskState: string;
  leaseAcquired: boolean;
  leaseReleased: boolean;
  workOrder?: WorkOrder;
  verificationReport?: TruthfulVerificationReport;
  review?: ManagerReview;
  staleReview?: boolean;
  error?: string;
}

function fail(code: string, error: string): AuthorityValidationResult {
  return { valid: false, code, error };
}

function renderCommand(command: { executable: string; args: string[] }): string {
  return [command.executable, ...command.args].map((part) => JSON.stringify(part)).join(' ');
}

/**
 * Adapter from the proven self-host executor into existing product authority.
 * It owns no task lifecycle table: transitions target `tasks`, while capacity
 * locks target product `account_leases` through WorkerSlotLeaseService.
 */
export class ProductTaskAutonomyAdapter {
  private readonly leaseService: WorkerSlotLeaseService;
  private readonly taskService: TaskService;
  public readonly maxWorkers: number;

  constructor(private readonly options: ProductTaskAutonomyAdapterOptions) {
    this.leaseService = options.leaseService ?? new WorkerSlotLeaseService(options.repo);
    this.taskService = options.taskService ?? new TaskService(options.repo, new EventService(options.repo));
    this.maxWorkers = options.maxWorkers ?? MAX_AGY_WORKERS;
    if (this.maxWorkers !== MAX_AGY_WORKERS) {
      throw new Error('PRODUCT_TASK_CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS_1');
    }
  }

  private get repo(): Repository {
    return this.options.repo;
  }

  public validateAuthority(input: { authorizationId: string; currentHeadSha: string }): AuthorityValidationResult {
    const authorization = this.repo.getExecutionAuthorization(input.authorizationId);
    if (!authorization) return fail('AUTHORIZATION_NOT_FOUND', `ExecutionAuthorization "${input.authorizationId}" was not found.`);
    if (authorization.status !== 'AUTHORIZED' && authorization.status !== 'DISPATCHED') {
      return fail('AUTHORIZATION_NOT_ACTIVE', `ExecutionAuthorization "${authorization.id}" is ${authorization.status}.`);
    }

    const task = this.repo.getTask(authorization.task_id);
    if (!task) return fail('TASK_NOT_FOUND', `Task "${authorization.task_id}" was not found.`);
    if (!authorization.assignment_id) return fail('ASSIGNMENT_NOT_BOUND', 'ExecutionAuthorization has no durable assignment binding.');
    const assignment = this.repo.getAgentAssignment(authorization.assignment_id);
    if (!assignment) return fail('ASSIGNMENT_NOT_FOUND', `AgentAssignment "${authorization.assignment_id}" was not found.`);

    if (task.project_id !== authorization.project_id || assignment.project_id !== task.project_id) {
      return fail('PROJECT_ID_MISMATCH', 'Task, authorization, and assignment project bindings differ.');
    }
    if (assignment.task_id !== task.id) return fail('TASK_ID_MISMATCH', 'Assignment is bound to a different task.');
    if (authorization.attempt_id !== assignment.attempt_id) return fail('ATTEMPT_ID_MISMATCH', 'Authorization and assignment attempt bindings differ.');
    if (
      authorization.task_revision !== task.revision_count ||
      (authorization.expected_task_revision !== undefined && authorization.expected_task_revision !== task.revision_count)
    ) {
      return fail('TASK_REVISION_MISMATCH', 'ExecutionAuthorization is stale for the current task revision.');
    }
    if (authorization.task_ownership_epoch !== task.ownership_epoch) {
      return fail('OWNERSHIP_EPOCH_MISMATCH', 'ExecutionAuthorization is fenced by the current task ownership epoch.');
    }
    if (authorization.base_sha !== task.base_sha || authorization.repository_head_sha !== input.currentHeadSha) {
      return fail('EXACT_HEAD_MISMATCH', 'Authorization base/repository HEAD does not match durable task and observed repository HEAD.');
    }
    if (
      assignment.selected_provider_id !== authorization.selected_provider_id ||
      assignment.selected_account_id !== authorization.selected_account_id ||
      assignment.selected_resource_id !== authorization.selected_resource_id
    ) {
      return fail('ROUTING_BINDING_MISMATCH', 'Authorization and assignment provider/account/resource bindings differ.');
    }

    const provider = this.repo.getProvider(assignment.selected_provider_id);
    const account = this.repo.getProviderAccount(assignment.selected_account_id);
    const resource = this.repo.getProviderResource(assignment.selected_resource_id);
    if (!provider || !account || !resource) return fail('ROUTING_RESOURCE_NOT_FOUND', 'Durable provider/account/resource chain is incomplete.');
    if (!provider.enabled || !account.enabled || !resource.enabled) return fail('ROUTING_RESOURCE_DISABLED', 'Durable provider/account/resource chain is disabled.');
    if (account.provider_id !== provider.id || resource.provider_id !== provider.id || resource.provider_account_id !== account.id) {
      return fail('ROUTING_BINDING_MISMATCH', 'Durable provider/account/resource foreign bindings differ.');
    }

    if (!authorization.canonical_payload_json) return fail('CANONICAL_PAYLOAD_MISSING', 'ExecutionAuthorization has no canonical payload.');
    let canonicalPayload;
    try {
      canonicalPayload = CanonicalExecutionPayloadSchema.parse(JSON.parse(authorization.canonical_payload_json));
    } catch (error) {
      return fail('CANONICAL_PAYLOAD_INVALID', error instanceof Error ? error.message : String(error));
    }
    if (computePayloadHash(canonicalPayload) !== authorization.instruction_payload_hash) {
      return fail('CANONICAL_PAYLOAD_HASH_MISMATCH', 'ExecutionAuthorization canonical payload failed hash verification.');
    }
    if (
      canonicalPayload.projectId !== task.project_id ||
      canonicalPayload.taskId !== task.id ||
      canonicalPayload.attemptId !== authorization.attempt_id ||
      canonicalPayload.taskTitle !== task.title ||
      canonicalPayload.taskDescription !== task.description
    ) {
      return fail('CANONICAL_PAYLOAD_BINDING_MISMATCH', 'Canonical payload no longer matches durable task identity.');
    }

    const manifest = this.repo.getContextManifestByHash(authorization.context_manifest_hash);
    if (!manifest) return fail('CONTEXT_MANIFEST_NOT_FOUND', 'Authorization does not reference an existing ContextManifest.');
    const manifestResult = verifyContextManifestIntegrity(this.repo, manifest);
    if (!manifestResult.valid || !manifestResult.snapshot) {
      return fail('CONTEXT_MANIFEST_INVALID', manifestResult.error ?? 'ContextManifest integrity verification failed.');
    }
    if (
      manifestResult.snapshot.project_id !== task.project_id ||
      manifestResult.snapshot.task_id !== task.id ||
      manifestResult.snapshot.attempt_id !== authorization.attempt_id ||
      manifestResult.snapshot.assignment_id !== assignment.id
    ) {
      return fail('CONTEXT_MANIFEST_BINDING_MISMATCH', 'ContextManifest is not bound to the authorized task/attempt/assignment.');
    }

    return { valid: true, authority: { task, authorization, assignment } };
  }

  public buildAuthorizedWorkOrder(input: AuthorizedWorkOrderInput): WorkOrder {
    const validated = this.validateAuthority(input);
    if (!validated.valid || !validated.authority) throw new Error(`${validated.code}: ${validated.error}`);
    if (!path.isAbsolute(input.worktree)) throw new Error('WORKTREE_MUST_BE_ABSOLUTE');
    if (!input.allowedPaths.length) throw new Error('ALLOWED_PATHS_REQUIRED');

    const { task, authorization, assignment } = validated.authority;
    const payload = CanonicalExecutionPayloadSchema.parse(JSON.parse(authorization.canonical_payload_json!));
    const requiredTests = Object.values(payload.verificationCommands)
      .filter((command): command is { executable: string; args: string[] } => command !== null)
      .map(renderCommand);
    if (!requiredTests.length) throw new Error('DETERMINISTIC_TESTS_REQUIRED');
    const attempt = assignment.attempt_id ? this.repo.getTaskAttempt(assignment.attempt_id) : null;

    const spec: AutonomousTaskSpec = {
      taskId: task.id,
      workerId: input.workerId,
      objective: task.description ?? task.title,
      baseSha: authorization.base_sha,
      branch: input.branch,
      worktree: input.worktree,
      dependencies: input.dependencies ?? [],
      allowedPaths: input.allowedPaths,
      forbiddenPaths: input.forbiddenPaths ?? ['.git'],
      acceptanceCriteria: [...payload.acceptanceCriteria],
      requiredTests,
      contextFiles: [...payload.contextFiles],
      constraints: [...payload.constraints, ...payload.instructions],
      attempt: attempt?.attempt_number ?? task.revision_count + 1,
      leaseEpoch: task.ownership_epoch ?? 1,
    };
    return createWorkOrder(spec);
  }

  public acquireWorkerSlotLease(assignmentId: string): AcquireSlotLeaseResult {
    const active = this.repo.getAllWorkerSlots().filter((slot) => slot.status === 'LEASED' || slot.status === 'RUNNING');
    if (active.length >= this.maxWorkers && !active.some((slot) => slot.current_assignment_id === assignmentId)) {
      return { status: 'FAILED', code: 'ACCOUNT_CAPACITY_EXHAUSTED', error: 'MAX_WORKERS_EXCEEDED: consolidation is fenced to one Antigravity worker.' };
    }
    return this.leaseService.acquireForAssignment(assignmentId);
  }

  public releaseWorkerSlotLease(leaseId: string, leaseToken: string): ReleaseLeaseResult {
    return this.leaseService.release(leaseId, leaseToken);
  }

  public transitionTask(taskId: string, trigger: TaskTrigger): Task {
    const task = this.repo.getTask(taskId);
    if (!task) throw new Error(`TASK_NOT_FOUND: ${taskId}`);
    // Validate the transition locally for a deterministic error, then let
    // TaskService perform the epoch-fenced authoritative mutation.
    TaskStateMachine.transition(task.state, trigger, {
      pausedFromState: task.paused_from_state,
      revisionCount: task.revision_count,
      maxRevisions: task.max_revisions,
    });
    const result = this.taskService.transitionAuthorizedTask(task.id, trigger, task.ownership_epoch ?? 1);
    if (!result.success || !result.task) throw new Error(result.error ?? 'AUTHORIZED_TASK_TRANSITION_FAILED');
    return result.task;
  }

  /** Persists one observed verification process and its TestRun; reruns append, never overwrite. */
  public recordVerificationObservation(input: {
    projectId: string;
    taskId: string;
    attemptId: string | null;
    command: string;
    status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
    exitCode: number | null;
    passedCount: number;
    failedCount: number;
    skippedCount?: number;
    durationMs: number;
    stdout?: string;
    stderr?: string;
    workingDirectory: string;
  }): TestRun {
    const startedAt = new Date(Date.now() - input.durationMs).toISOString();
    const finishedAt = new Date().toISOString();
    const evidenceId = crypto.randomUUID();
    const evidence = this.options.artifactStore.store(
      evidenceId,
      input.projectId,
      input.taskId,
      input.attemptId,
      'TEST_RESULT',
      `Verification attempt ${input.status}: ${input.command}`,
      `status=${input.status}\nexitCode=${String(input.exitCode)}\n=== STDOUT ===\n${input.stdout ?? ''}\n=== STDERR ===\n${input.stderr ?? ''}`,
    );
    this.repo.createEvidence(evidence);

    const processRunId = crypto.randomUUID();
    const processRun: Pick<ProcessRun, 'id' | 'pid' | 'command' | 'working_directory' | 'status' | 'start_time'> & {
      project_id: string;
      task_id: string;
      attempt_id: string | null;
    } = {
      id: processRunId,
      pid: null,
      project_id: input.projectId,
      task_id: input.taskId,
      attempt_id: input.attemptId,
      command: input.command,
      working_directory: input.workingDirectory,
      status: 'RUNNING',
      start_time: startedAt,
    };
    this.repo.createProcessRun(processRun);
    this.repo.updateProcessRun(processRunId, input.status, input.exitCode, finishedAt, evidenceId, null);

    const run: TestRun = {
      id: crypto.randomUUID(),
      task_id: input.taskId,
      command: input.command,
      passed_count: input.passedCount,
      failed_count: input.failedCount,
      skipped_count: input.skippedCount ?? 0,
      duration_ms: input.durationMs,
      exit_code: input.exitCode ?? -1,
      evidence_id: evidenceId,
      created_at: finishedAt,
    };
    this.repo.createTestRun(run);
    return run;
  }

  public getTruthfulVerificationReport(taskId: string): TruthfulVerificationReport {
    const attempts = this.repo.getTestRunsByTaskId(taskId).map((run, index) => ({
      attemptNumber: index + 1,
      testRunId: run.id,
      command: run.command,
      passedCount: run.passed_count,
      failedCount: run.failed_count,
      skippedCount: run.skipped_count,
      durationMs: run.duration_ms,
      exitCode: run.exit_code,
      evidenceId: run.evidence_id,
      createdAt: run.created_at,
      success: run.exit_code === 0 && run.failed_count === 0,
    }));
    const latestAttemptPassed = attempts.at(-1)?.success ?? false;
    return {
      taskId,
      totalAttempts: attempts.length,
      isFirstPassSuccess: attempts.length === 1 && latestAttemptPassed,
      latestAttemptPassed,
      hadPriorFailure: attempts.slice(0, -1).some((attempt) => !attempt.success),
      attempts,
    };
  }

  public validateReviewFreshness(review: ManagerReview, currentHeadSha: string): { fresh: boolean; error?: string } {
    if (review.reviewed_head_sha !== currentHeadSha) {
      return { fresh: false, error: `EXACT_HEAD_FENCING_VIOLATION: reviewed ${review.reviewed_head_sha}, observed ${currentHeadSha}.` };
    }
    return { fresh: true };
  }

  public buildManagerContext(
    workOrder: WorkOrder,
    currentHead: string,
    additions: Omit<BuildManagerContextParams, 'workOrder' | 'currentHead'> = {},
  ): ManagerContextPackage {
    const db = this.repo.getDatabase();
    return buildManagerContextPackage({
      workOrder,
      currentHead,
      actualDiff: additions.actualDiff,
      changedFiles: additions.changedFiles,
      deterministicTests: additions.deterministicTests ?? this.getTruthfulVerificationReport(workOrder.task_id).attempts,
      previousManagerDecisions: additions.previousManagerDecisions ?? db.prepare('SELECT verdict,summary,created_at FROM reviews WHERE task_id=? ORDER BY created_at').all(workOrder.task_id),
      repairHistory: additions.repairHistory ?? db.prepare('SELECT attempt_number,status,summary FROM task_attempts WHERE task_id=? ORDER BY attempt_number').all(workOrder.task_id),
      prState: additions.prState ?? {},
      ciState: additions.ciState ?? {},
      architecturePolicyContext: additions.architecturePolicyContext ?? [
        'Product tasks and TaskStateMachine are the sole lifecycle authority.',
        'ExecutionAuthorization, ownership epoch, account lease, tests, and exact-head review are mandatory.',
        'GitHub protections and CI evidence cannot be bypassed by provider switching.',
      ],
    });
  }

  public inventoryLegacyAutonomyState(): LegacyAutonomyInventoryReport {
    if (!this.options.autonomyStore) throw new Error('AUTONOMY_COMPATIBILITY_STORE_NOT_CONFIGURED');
    return this.options.autonomyStore.inventoryLegacyState();
  }

  public isProductTaskAuthoritative(): true {
    return true;
  }

  public async executeProductTask(input: ExecuteProductTaskParams): Promise<ExecuteProductTaskResult> {
    const validated = this.validateAuthority(input);
    if (!validated.valid || !validated.authority) {
      return { success: false, finalTaskState: 'UNKNOWN', leaseAcquired: false, leaseReleased: false, error: `${validated.code}: ${validated.error}` };
    }
    const workOrder = this.buildAuthorizedWorkOrder(input);
    const acquired = this.acquireWorkerSlotLease(validated.authority.assignment.id);
    if (acquired.status !== 'ACQUIRED') {
      return { success: false, finalTaskState: validated.authority.task.state, leaseAcquired: false, leaseReleased: false, workOrder, error: acquired.error };
    }

    let result: ExecuteProductTaskResult;
    try {
      let task = this.repo.getTask(validated.authority.task.id)!;
      if (task.state === 'APPROVED' || task.state === 'QUEUED') task = this.transitionTask(task.id, 'DISPATCH');
      if (task.state === 'DISPATCHED') task = this.transitionTask(task.id, 'START_CODING');
      if (task.state !== 'CODING') throw new Error(`PRODUCT_TASK_NOT_CODING: ${task.state}`);

      const coder = await input.runCoder(workOrder);
      if (!coder.success) throw new Error(coder.error ?? 'CODER_EXECUTION_FAILED');
      this.repo.updateTaskShas(task.id, undefined, coder.currentHeadSha);
      task = this.transitionTask(task.id, 'SUBMIT_REPORT');

      await input.runVerification(validated.authority);
      const verificationReport = this.getTruthfulVerificationReport(task.id);
      if (!verificationReport.latestAttemptPassed) {
        task = this.transitionTask(task.id, 'TESTS_FAILED');
        result = { success: false, finalTaskState: task.state, leaseAcquired: true, leaseReleased: false, workOrder, verificationReport, error: 'VERIFICATION_FAILED' };
      } else {
        task = this.transitionTask(task.id, 'EVIDENCE_GATHERED');
        task = this.transitionTask(task.id, 'START_REVIEW');
        const context = this.buildManagerContext(workOrder, coder.currentHeadSha, input.managerContext);
        const review = await input.conductReview(context);
        const freshness = this.validateReviewFreshness(review, coder.currentHeadSha);
        if (!freshness.fresh) {
          result = { success: false, finalTaskState: task.state, leaseAcquired: true, leaseReleased: false, workOrder, verificationReport, review, staleReview: true, error: freshness.error };
        } else if (review.verdict !== 'PASS') {
          task = this.transitionTask(task.id, review.verdict === 'REPAIR' ? 'FIX_VERDICT' : 'MAX_REVISIONS_EXCEEDED');
          result = { success: false, finalTaskState: task.state, leaseAcquired: true, leaseReleased: false, workOrder, verificationReport, review, error: `MANAGER_${review.verdict}` };
        } else {
          task = this.transitionTask(task.id, 'PASS_VERDICT');
          result = { success: true, finalTaskState: task.state, leaseAcquired: true, leaseReleased: false, workOrder, verificationReport, review };
        }
      }
    } catch (error) {
      result = { success: false, finalTaskState: this.repo.getTask(validated.authority.task.id)?.state ?? 'UNKNOWN', leaseAcquired: true, leaseReleased: false, workOrder, error: error instanceof Error ? error.message : String(error) };
    }

    const released = this.releaseWorkerSlotLease(acquired.lease.id, acquired.lease.lease_token);
    result.leaseReleased = released.status === 'RELEASED';
    if (released.status === 'FAILED' && !result.error) result.error = released.error;
    return result;
  }
}

export const ProductTaskAutonomyService = ProductTaskAutonomyAdapter;
export const ProductTaskAutonomyIntegrationService = ProductTaskAutonomyAdapter;
