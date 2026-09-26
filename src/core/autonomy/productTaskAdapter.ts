import crypto from 'crypto';
import path from 'path';
import { Repository } from '../database/repositories';
import { verifyContextManifestIntegrity } from '../context/ContextIntegrity';
import {
  CanonicalExecutionPayloadSchema,
  computePayloadHash,
} from '../services/ExecutionAuthorizationService';
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
import { AutonomousTaskSpec, ManagerReview, ManagerReviewSchema, WorkOrder, createWorkOrder } from './contracts';
import { EvidenceCollector } from './evidence';
import {
  BuildManagerContextParams,
  ManagerContextPackage,
  buildManagerContextPackage,
} from './managerPool';
import { AutonomyStore, LegacyAutonomyInventoryReport } from './store';
import {
  evaluateRepairConvergence,
  recoverRepairConvergence,
  stableFindingSignature,
} from './repairConvergence';

/** Consolidation supports an explicitly configured two-worker maximum (1 or 2). */
export const MAX_AGY_WORKERS = 2;

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
  evidenceCollector?: Pick<EvidenceCollector, 'collect'>;
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

export interface ValidateAuthorityInput {
  authorizationId: string;
  currentHeadSha: string;
  workerId?: string;
  branch?: string;
  worktree?: string;
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  requireScopeMatch?: boolean;
}

export function areStringArraysIdentical(a?: string[], b?: string[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export interface ExecuteProductTaskParams extends AuthorizedWorkOrderInput {
  runCoder: (workOrder: WorkOrder) => Promise<{ success: boolean; currentHeadSha: string; error?: string }>;
  runVerification: (authority: ProductTaskAuthority, workOrder?: WorkOrder) => Promise<TestRun>;
  conductReview: (context: ManagerContextPackage) => Promise<ManagerReview>;
  managerContext?: Omit<BuildManagerContextParams, 'workOrder' | 'currentHead'>;
  evidenceCollector?: Pick<EvidenceCollector, 'collect'>;
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
  observedHeadSha?: string;
  observedSnapshotSha?: string;
}

function fail(code: string, error: string): AuthorityValidationResult {
  return { valid: false, code, error };
}

export function renderCommand(command: { executable: string; args: string[] }): string {
  return [command.executable, ...command.args].map((part) => JSON.stringify(part)).join(' ');
}

export function isPathContainedInBoundary(filePath: string, boundaryPath: string): boolean {
  const normFile = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const normBoundary = boundaryPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (normBoundary === '' || normBoundary === '.') return true;
  return normFile === normBoundary || normFile.startsWith(`${normBoundary}/`);
}

export function validateChangedFilesBoundaries(
  changedFiles: string[],
  allowedPaths: string[],
  forbiddenPaths: string[] = [],
): { valid: boolean; violatingFile?: string } {
  for (const file of changedFiles) {
    const isAllowed = allowedPaths.some((entry) => isPathContainedInBoundary(file, entry));
    const isForbidden = forbiddenPaths.some((entry) => isPathContainedInBoundary(file, entry));
    if (!isAllowed || isForbidden) {
      return { valid: false, violatingFile: file };
    }
  }
  return { valid: true };
}

const RETRYABLE_REVIEW_FAILURE_MARKERS = [
  'ALL_MANAGER_RESOURCES_UNAVAILABLE',
  'ROUTE_CAPACITY_EXHAUSTED',
  'CAPACITY_EXHAUSTED',
  'CREDITS_EXHAUSTED',
  'QUOTA_OR_RATE_LIMIT',
  'RATE_LIMITED',
  'AUTH_ERROR',
  'TIMEOUT',
  'OFFLINE',
  'COOLDOWN',
  'CONTRACT_INVALID',
  'MANAGER_REVIEW_FAILED',
] as const;

/**
 * Reviewer transport/resource failures are execution availability failures, not
 * semantic findings. They may retry from CODING without consuming task
 * revision budget. Exact-head/snapshot violations and explicit REPAIR verdicts
 * are intentionally excluded and continue through FIX_VERDICT.
 */
export function isRetryableReviewProviderFailure(error: string): boolean {
  const normalized = error.toUpperCase();
  return RETRYABLE_REVIEW_FAILURE_MARKERS.some((marker) => normalized.includes(marker));
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
  public readonly evidenceCollector?: Pick<EvidenceCollector, 'collect'>;

  constructor(private readonly options: ProductTaskAutonomyAdapterOptions) {
    this.leaseService = options.leaseService ?? new WorkerSlotLeaseService(options.repo);
    this.taskService = options.taskService ?? new TaskService(options.repo, new EventService(options.repo));
    const rawWorkers = options.maxWorkers ?? (process.env.MAX_AGY_WORKERS !== undefined ? Number(process.env.MAX_AGY_WORKERS) : 1);
    if (!Number.isInteger(rawWorkers) || rawWorkers < 1 || rawWorkers > 2) {
      throw new Error('PRODUCT_TASK_CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS_BOUNDS: ProductTaskAutonomyAdapter accepts maxWorkers integers from 1 through 2');
    }
    this.maxWorkers = rawWorkers;
    this.evidenceCollector = options.evidenceCollector;
  }

  private get repo(): Repository {
    return this.options.repo;
  }

  public validateAuthority(input: ValidateAuthorityInput): AuthorityValidationResult {
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

    if (!canonicalPayload.executionScope) {
      return fail('EXECUTION_SCOPE_MISSING', 'ExecutionAuthorization canonical payload is missing required executionScope.');
    }
    const authorizedScope = canonicalPayload.executionScope;
    if (!path.isAbsolute(authorizedScope.worktree) && !path.win32.isAbsolute(authorizedScope.worktree) && !path.posix.isAbsolute(authorizedScope.worktree)) {
      return fail('WORKTREE_MUST_BE_ABSOLUTE', 'Authorized executionScope worktree must be an absolute path.');
    }
    if (!authorizedScope.allowedPaths || authorizedScope.allowedPaths.length === 0) {
      return fail('ALLOWED_PATHS_REQUIRED', 'Authorized executionScope allowedPaths must contain at least one path.');
    }

    const hasAnyRuntimeScope =
      input.branch !== undefined ||
      input.worktree !== undefined ||
      input.allowedPaths !== undefined ||
      input.forbiddenPaths !== undefined;

    if (input.requireScopeMatch || hasAnyRuntimeScope) {
      if (
        input.branch === undefined ||
        input.worktree === undefined ||
        input.allowedPaths === undefined ||
        input.forbiddenPaths === undefined
      ) {
        return fail(
          'RUNTIME_SCOPE_MISSING',
          'Runtime execution scope (branch, worktree, allowedPaths, forbiddenPaths) is required and cannot be omitted.'
        );
      }
      if (input.branch !== authorizedScope.branch) {
        return fail(
          'BRANCH_MISMATCH',
          `Runtime branch "${input.branch}" does not match authorized branch "${authorizedScope.branch}".`
        );
      }
      if (input.worktree !== authorizedScope.worktree) {
        return fail(
          'WORKTREE_MISMATCH',
          `Runtime worktree "${input.worktree}" does not match authorized worktree "${authorizedScope.worktree}".`
        );
      }
      if (!areStringArraysIdentical(input.allowedPaths, authorizedScope.allowedPaths)) {
        return fail(
          'ALLOWED_PATHS_MISMATCH',
          `Runtime allowedPaths [${input.allowedPaths.join(', ')}] do not match authorized allowedPaths [${authorizedScope.allowedPaths.join(', ')}].`
        );
      }
      if (!areStringArraysIdentical(input.forbiddenPaths, authorizedScope.forbiddenPaths)) {
        return fail(
          'FORBIDDEN_PATHS_MISMATCH',
          `Runtime forbiddenPaths [${input.forbiddenPaths.join(', ')}] do not match authorized forbiddenPaths [${authorizedScope.forbiddenPaths.join(', ')}].`
        );
      }
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
    const validated = this.validateAuthority({ ...input, requireScopeMatch: true });
    if (!validated.valid || !validated.authority) throw new Error(`${validated.code}: ${validated.error}`);

    const { task, authorization, assignment } = validated.authority;
    const payload = CanonicalExecutionPayloadSchema.parse(JSON.parse(authorization.canonical_payload_json!));
    const authorizedScope = payload.executionScope!;
    if (!path.isAbsolute(authorizedScope.worktree) && !path.win32.isAbsolute(authorizedScope.worktree) && !path.posix.isAbsolute(authorizedScope.worktree)) {
      throw new Error('WORKTREE_MUST_BE_ABSOLUTE');
    }
    if (!authorizedScope.allowedPaths.length) throw new Error('ALLOWED_PATHS_REQUIRED');

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
      branch: authorizedScope.branch,
      worktree: authorizedScope.worktree,
      dependencies: input.dependencies ?? [],
      allowedPaths: [...authorizedScope.allowedPaths],
      forbiddenPaths: [...authorizedScope.forbiddenPaths],
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
      return { status: 'FAILED', code: 'ACCOUNT_CAPACITY_EXHAUSTED', error: `MAX_WORKERS_EXCEEDED: consolidation is fenced to ${this.maxWorkers} Antigravity worker${this.maxWorkers === 1 ? '' : 's'}.` };
    }
    return this.leaseService.acquireForAssignment(assignmentId);
  }

  public releaseWorkerSlotLease(leaseId: string, leaseToken: string): ReleaseLeaseResult {
    return this.leaseService.release(leaseId, leaseToken);
  }

  public transitionTask(taskId: string, trigger: TaskTrigger, expectedOwnershipEpoch?: number): Task {
    const task = this.repo.getTask(taskId);
    if (!task) throw new Error(`TASK_NOT_FOUND: ${taskId}`);
    // Validate the transition locally for a deterministic error, then let
    // TaskService perform the epoch-fenced authoritative mutation.
    TaskStateMachine.transition(task.state, trigger, {
      pausedFromState: task.paused_from_state,
      revisionCount: task.revision_count,
      maxRevisions: task.max_revisions,
    });
    const epoch = expectedOwnershipEpoch ?? task.ownership_epoch ?? 1;
    const result = this.taskService.transitionAuthorizedTask(task.id, trigger, epoch);
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

  public validateReviewFreshness(
    review: ManagerReview,
    currentHeadSha: string,
    evidenceSnapshotSha?: string,
    currentSnapshotSha?: string,
  ): { fresh: boolean; error?: string } {
    if (review.reviewed_head_sha.toLowerCase() !== currentHeadSha.toLowerCase()) {
      return { fresh: false, error: `EXACT_HEAD_FENCING_VIOLATION: reviewed ${review.reviewed_head_sha}, observed ${currentHeadSha}.` };
    }
    if (evidenceSnapshotSha !== undefined && currentSnapshotSha !== undefined && evidenceSnapshotSha !== currentSnapshotSha) {
      return { fresh: false, error: `WORKING_TREE_SNAPSHOT_FENCING_VIOLATION: reviewed snapshot ${evidenceSnapshotSha}, observed ${currentSnapshotSha}.` };
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
    const validated = this.validateAuthority({ ...input, requireScopeMatch: true });
    if (!validated.valid || !validated.authority) {
      return { success: false, finalTaskState: 'UNKNOWN', leaseAcquired: false, leaseReleased: false, error: `${validated.code}: ${validated.error}` };
    }
    const workOrder = this.buildAuthorizedWorkOrder(input);
    const acquired = this.acquireWorkerSlotLease(validated.authority.assignment.id);
    if (acquired.status !== 'ACQUIRED') {
      return { success: false, finalTaskState: validated.authority.task.state, leaseAcquired: false, leaseReleased: false, workOrder, error: acquired.error };
    }

    const evidenceCollector = input.evidenceCollector ?? this.evidenceCollector ?? new EvidenceCollector();

    let result: ExecuteProductTaskResult;
    try {
      const authorityEpoch = validated.authority.task.ownership_epoch ?? 1;
      let task = this.repo.getTask(validated.authority.task.id)!;
      if (task.state === 'APPROVED' || task.state === 'QUEUED') task = this.transitionTask(task.id, 'DISPATCH', authorityEpoch);
      if (task.state === 'DISPATCHED' || task.state === 'FIX_REQUIRED') task = this.transitionTask(task.id, 'START_CODING', authorityEpoch);
      if (task.state !== 'CODING') throw new Error(`PRODUCT_TASK_NOT_CODING: ${task.state}`);

      const coder = await input.runCoder(workOrder);
      if (!coder.success) throw new Error(coder.error ?? 'CODER_EXECUTION_FAILED');

      // Independently observe Git HEAD and working-tree snapshot before review, never trusting only runCoder claims
      const preReviewEvidence = await evidenceCollector.collect(workOrder, []);
      if (coder.currentHeadSha && coder.currentHeadSha.toLowerCase() !== preReviewEvidence.headSha.toLowerCase()) {
        throw new Error(`CODER_HEAD_MISMATCH: coder claimed ${coder.currentHeadSha}, observed ${preReviewEvidence.headSha}`);
      }

      // Fail closed before verification/review if independently collected changedFiles include
      // any path outside workOrder.allowed_paths or inside workOrder.forbidden_paths
      const boundaryCheck = validateChangedFilesBoundaries(
        preReviewEvidence.changedFiles,
        workOrder.allowed_paths,
        workOrder.forbidden_paths,
      );
      if (!boundaryCheck.valid) {
        throw new Error('WORKER_PATH_VIOLATION');
      }

      this.repo.updateTaskShas(task.id, undefined, preReviewEvidence.headSha);
      task = this.transitionTask(task.id, 'SUBMIT_REPORT', authorityEpoch);

      // Verification acceptance strictly requires a newly persisted TestRun
      // and its process/evidence lineage from this authorization attempt.
      const priorTestRunIds = new Set(this.repo.getTestRunsByTaskId(task.id).map((run) => run.id));
      const currentTestRun = await input.runVerification(validated.authority, workOrder);
      const verificationReport = this.getTruthfulVerificationReport(task.id);
      const persistedCurrentRun = currentTestRun ? this.repo.getTestRun(currentTestRun.id) : null;
      const currentEvidence = persistedCurrentRun?.evidence_id
        ? this.repo.getEvidence(persistedCurrentRun.evidence_id)
        : null;
      const currentProcess = persistedCurrentRun?.evidence_id
        ? this.repo.getProcessRunsByTask(task.id).find((run) =>
          run.stdout_evidence_id === persistedCurrentRun.evidence_id ||
          run.stderr_evidence_id === persistedCurrentRun.evidence_id)
        : null;
      const currentRunBound = Boolean(
        currentTestRun &&
        persistedCurrentRun &&
        !priorTestRunIds.has(currentTestRun.id) &&
        persistedCurrentRun.task_id === validated.authority.task.id &&
        persistedCurrentRun.evidence_id === currentTestRun.evidence_id &&
        currentEvidence?.project_id === validated.authority.task.project_id &&
        currentEvidence?.task_id === validated.authority.task.id &&
        currentEvidence?.attempt_id === validated.authority.authorization.attempt_id &&
        currentProcess?.project_id === validated.authority.task.project_id &&
        currentProcess?.task_id === validated.authority.task.id &&
        currentProcess?.attempt_id === validated.authority.authorization.attempt_id &&
        currentProcess?.working_directory === workOrder.worktree
      );
      const currentTestRunPassed = Boolean(
        currentRunBound &&
        persistedCurrentRun!.exit_code === 0 &&
        persistedCurrentRun!.failed_count === 0 &&
        currentProcess?.status === 'COMPLETED' &&
        currentProcess.exit_code === 0
      );

      if (!currentTestRunPassed) {
        task = this.transitionTask(task.id, 'TESTS_FAILED', authorityEpoch);
        const verificationError = !currentTestRun
          ? 'CURRENT_VERIFICATION_TEST_RUN_MISSING'
          : !currentRunBound
            ? 'CURRENT_VERIFICATION_AUTHORITY_BINDING_INVALID'
            : 'VERIFICATION_FAILED';
        result = {
          success: false,
          finalTaskState: task.state,
          leaseAcquired: true,
          leaseReleased: false,
          workOrder,
          verificationReport,
          error: verificationError,
        };
      } else {
        task = this.transitionTask(task.id, 'EVIDENCE_GATHERED', authorityEpoch);
        task = this.transitionTask(task.id, 'START_REVIEW', authorityEpoch);
        const context = this.buildManagerContext(workOrder, preReviewEvidence.headSha, {
          ...input.managerContext,
          actualDiff: input.managerContext?.actualDiff ?? preReviewEvidence.diff,
          changedFiles: input.managerContext?.changedFiles ?? preReviewEvidence.changedFiles,
        });
        const rawReview = await input.conductReview(context);
        const parsedReview = ManagerReviewSchema.safeParse(rawReview);
        if (!parsedReview.success) {
          throw new Error(`CONTRACT_INVALID: conductReview returned invalid review contract: ${parsedReview.error.message}`);
        }
        const review: ManagerReview = parsedReview.data;

        // Independently observe a fresh Git HEAD and working-tree snapshot after manager review
        const postReviewEvidence = await evidenceCollector.collect(workOrder, []);
        const freshness = this.validateReviewFreshness(
          review,
          postReviewEvidence.headSha,
          preReviewEvidence.snapshotSha,
          postReviewEvidence.snapshotSha,
        );
        const refreshedAuthority = this.validateAuthority({
          authorizationId: input.authorizationId,
          currentHeadSha: postReviewEvidence.headSha,
          branch: input.branch,
          worktree: input.worktree,
          allowedPaths: input.allowedPaths,
          forbiddenPaths: input.forbiddenPaths,
          requireScopeMatch: true,
        });
        if (!freshness.fresh) {
          task = this.transitionTask(task.id, 'FIX_VERDICT', authorityEpoch);
          result = {
            success: false,
            finalTaskState: task.state,
            leaseAcquired: true,
            leaseReleased: false,
            workOrder,
            verificationReport,
            review,
            staleReview: true,
            observedHeadSha: postReviewEvidence.headSha,
            observedSnapshotSha: postReviewEvidence.snapshotSha,
            error: freshness.error,
          };
        } else if (!refreshedAuthority.valid) {
          if (refreshedAuthority.code !== 'OWNERSHIP_EPOCH_MISMATCH') {
            task = this.transitionTask(task.id, 'FIX_VERDICT', authorityEpoch);
          }
          result = {
            success: false,
            finalTaskState: task.state,
            leaseAcquired: true,
            leaseReleased: false,
            workOrder,
            verificationReport,
            review,
            staleReview: true,
            observedHeadSha: postReviewEvidence.headSha,
            observedSnapshotSha: postReviewEvidence.snapshotSha,
            error: `AUTHORITY_FENCED_DURING_EXECUTION: ${refreshedAuthority.code}: ${refreshedAuthority.error}`,
          };
        } else if (review.verdict !== 'PASS') {
          let repairError = `MANAGER_${review.verdict}`;
          if (review.verdict === 'REPAIR' && this.options.autonomyStore) {
            const repairRows = this.options.autonomyStore.getDatabase().prepare(`
              SELECT payload_json
              FROM autonomy_events
              WHERE work_order_id=? AND event_type='PRODUCT_REPAIR_REQUIRED'
              ORDER BY created_at,id
            `).all(task.id) as Array<{ payload_json: string }>;
            const recovered = recoverRepairConvergence(repairRows.map((row) => row.payload_json));
            const observation = {
              signature: stableFindingSignature(
                review,
                verificationReport.latestAttemptPassed,
                freshness.fresh,
              ),
              snapshotSha: postReviewEvidence.snapshotSha ?? '',
            };
            const convergence = evaluateRepairConvergence(
              recovered.previousRepair,
              observation,
              recovered.repairLoops,
              task.max_revisions,
            );

            if (convergence.outcome === 'SEMANTIC_NO_PROGRESS') {
              this.options.autonomyStore.event(task.id, 'PRODUCT_SEMANTIC_NO_PROGRESS', {
                review,
                verified: verificationReport.latestAttemptPassed,
                fresh: freshness.fresh,
                ...observation,
                repairLoops: recovered.repairLoops,
              });
              task = this.transitionTask(task.id, 'MAX_REVISIONS_EXCEEDED', authorityEpoch);
              repairError = 'SEMANTIC_NO_PROGRESS';
            } else if (convergence.outcome === 'MAX_REPAIR_LOOPS_EXCEEDED') {
              this.options.autonomyStore.event(task.id, 'PRODUCT_MAX_REPAIR_LOOPS_EXCEEDED', {
                review,
                verified: verificationReport.latestAttemptPassed,
                fresh: freshness.fresh,
                ...observation,
                repairLoops: convergence.nextRepairLoops,
              });
              task = this.transitionTask(task.id, 'MAX_REVISIONS_EXCEEDED', authorityEpoch);
              repairError = 'MAX_REPAIR_LOOPS_EXCEEDED';
            } else {
              this.options.autonomyStore.event(task.id, 'PRODUCT_REPAIR_REQUIRED', {
                review,
                verified: verificationReport.latestAttemptPassed,
                fresh: freshness.fresh,
                ...observation,
                repairLoops: convergence.nextRepairLoops,
              });
              task = this.transitionTask(task.id, 'FIX_VERDICT', authorityEpoch);
            }
          } else {
            task = this.transitionTask(task.id, review.verdict === 'REPAIR' ? 'FIX_VERDICT' : 'MAX_REVISIONS_EXCEEDED', authorityEpoch);
          }
          result = {
            success: false,
            finalTaskState: task.state,
            leaseAcquired: true,
            leaseReleased: false,
            workOrder,
            verificationReport,
            review,
            observedHeadSha: postReviewEvidence.headSha,
            observedSnapshotSha: postReviewEvidence.snapshotSha,
            error: repairError,
          };
        } else {
          task = this.transitionTask(task.id, 'PASS_VERDICT', authorityEpoch);
          result = {
            success: true,
            finalTaskState: task.state,
            leaseAcquired: true,
            leaseReleased: false,
            workOrder,
            verificationReport,
            review,
            observedHeadSha: postReviewEvidence.headSha,
            observedSnapshotSha: postReviewEvidence.snapshotSha,
          };
        }
      }
    } catch (error) {
      const currentTask = this.repo.getTask(validated.authority.task.id);
      let finalTaskState = currentTask?.state ?? 'UNKNOWN';
      const authorityEpoch = validated.authority.task.ownership_epoch ?? 1;
      const executionError = error instanceof Error ? error.message : String(error);
      let reportedError = executionError;
      if (currentTask && currentTask.state === 'REVIEWING') {
        const currentEpoch = currentTask.ownership_epoch ?? authorityEpoch;
        if (currentEpoch === authorityEpoch) {
          try {
            const retryableProviderFailure = isRetryableReviewProviderFailure(executionError);
            const recovered = this.transitionTask(
              currentTask.id,
              retryableProviderFailure ? 'REVIEW_RETRY' : 'FIX_VERDICT',
              authorityEpoch,
            );
            finalTaskState = recovered.state;
          } catch (recoveryError) {
            finalTaskState = this.repo.getTask(currentTask.id)?.state ?? currentTask.state;
            const recoveryMessage = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
            reportedError = recoveryMessage.includes('OWNERSHIP_EPOCH_MISMATCH')
              ? `AUTHORITY_FENCED_DURING_EXECUTION: ${recoveryMessage}`
              : `REVIEW_RESUME_FAILED: ${recoveryMessage}; original error: ${executionError}`;
          }
        } else {
          reportedError = `AUTHORITY_FENCED_DURING_EXECUTION: OWNERSHIP_EPOCH_MISMATCH: expected ${authorityEpoch}, current ${String(currentEpoch)}.`;
        }
      }
      result = {
        success: false,
        finalTaskState,
        leaseAcquired: true,
        leaseReleased: false,
        workOrder,
        error: reportedError,
      };
    }

    const released = this.releaseWorkerSlotLease(acquired.lease.id, acquired.lease.lease_token);
    result.leaseReleased = released.status === 'RELEASED';
    if (released.status === 'FAILED' && !result.error) result.error = released.error;
    return result;
  }
}

export const ProductTaskAutonomyService = ProductTaskAutonomyAdapter;
export const ProductTaskAutonomyIntegrationService = ProductTaskAutonomyAdapter;
