import crypto from 'crypto';
import path from 'path';
import { Repository } from '../database/repositories';
import { verifyContextManifestIntegrity } from '../context/ContextIntegrity';
import {
  CanonicalExecutionPayloadSchema,
  computePayloadHash,
} from '../services/ExecutionAuthorizationService';
import { ArtifactStore } from '../services/ArtifactStore';
import { ProcessRunner } from '../services/ProcessRunner';
import { redactTrialEvidenceText } from './trialEvidence';
import { VerificationCapabilityService } from '../services/VerificationCapabilityService';
import { EventService } from '../services/EventService';
import { TaskService, captureAuthorizedTaskTransitionBinding } from '../services/TaskService';
import {
  AcquireSlotLeaseResult,
  ReleaseLeaseResult,
  WorkerSlotLeaseService,
} from '../services/WorkerSlotLeaseService';
import { TaskTrigger } from '../state/taskStateMachine';
import { AgentAssignment, ExecutionAuthorization, ProcessRun, Task, TaskMutationBinding, TestRun } from '../types/domain';
import { AutonomousTaskSpec, ManagerReview, ManagerReviewSchema, WorkOrder, createWorkOrder } from './contracts';
import { ApprovedVerificationInvocation, EvidenceCollector } from './evidence';
import { VerificationCapabilityReference } from '../types/verificationCapability';
import {
  BuildManagerContextParams,
  ManagerContextPackage,
  buildManagerContextPackage,
} from './managerPool';
import { AutonomyStore, LegacyAutonomyInventoryReport } from './store';
import {
  RepairContextPackage,
  RepairOutcome,
  buildRepairContextPackage,
  computeNormalizedPatchHash,
  deriveFindingId,
  detectNoProgress,
  extractFailingTestSignatures,
  getEscalationStage,
  normalizeReviewerFindings,
  reconcileFindingClosure,
} from './repairContext';
import type { CoderEditBundle } from './responsesCoderEndpoint';
import {
  createProductLeaseRecoveryMarkerEvent,
  ProductLeaseRecoveryMarkerInput,
  productLeaseOwnerFingerprint,
} from '../services/ProductLeaseRecoveryScanner';

/** Consolidation supports an explicitly configured two-worker maximum (1 or 2). */
export const MAX_AGY_WORKERS = 2;
export const VERIFICATION_REPORT_MAX_ATTEMPTS = 64;
export const VERIFICATION_REPORT_MAX_READ_BYTES = 1024 * 1024;
export const VERIFICATION_REPORT_MAX_TOTAL_READ_BYTES = 8 * 1024 * 1024;
export const VERIFICATION_REPORT_MAX_OUTPUT_CHARACTERS = 32 * 1024;

export type VerificationEvidenceErrorCode =
  | 'VERIFICATION_EVIDENCE_MISSING'
  | 'VERIFICATION_EVIDENCE_SCOPE_INVALID'
  | 'VERIFICATION_EVIDENCE_SCOPE_CHANGED'
  | 'VERIFICATION_EVIDENCE_PROCESS_INVALID'
  | 'VERIFICATION_EVIDENCE_METADATA_INVALID'
  | 'VERIFICATION_EVIDENCE_LIMIT_EXCEEDED'
  | 'VERIFICATION_EVIDENCE_READ_FAILED'
  | 'VERIFICATION_EVIDENCE_FORMAT_INVALID';

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
  stdout: string;
  stderr: string;
  evidenceStatus: 'VERIFIED' | 'INCOMPLETE';
  evidenceErrorCode?: VerificationEvidenceErrorCode;
  outputTruncated: boolean;
}

export interface TruthfulVerificationReport {
  taskId: string;
  totalAttempts: number;
  isFirstPassSuccess: boolean;
  latestAttemptPassed: boolean;
  hadPriorFailure: boolean;
  attempts: VerificationAttemptSummary[];
  evidenceStatus: 'COMPLETE' | 'INCOMPLETE';
  evidenceErrorCode?: VerificationEvidenceErrorCode;
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
  runCoder: (workOrder: WorkOrder) => Promise<{ success: boolean; currentHeadSha: string; error?: string; bundle?: CoderEditBundle }>;
  runVerification: (
    authority: ProductTaskAuthority,
    workOrder?: WorkOrder,
    binding?: TaskMutationBinding,
  ) => Promise<TestRun>;
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
  /** Execution outcome remains in `success`; cleanup is reported separately. */
  leaseCleanup?: ProductLeaseCleanupResult;
}

export interface ProductLeaseCleanupResult {
  status: 'RELEASED' | 'RECOVERY_REQUIRED';
  leaseId: string;
  markerEventId?: string | null;
  code?: string;
  error?: string;
  ownerTokenSha256?: string;
}

function fail(code: string, error: string): AuthorityValidationResult {
  return { valid: false, code, error };
}

export function renderCommand(command: { executable: string; args: string[] }): string {
  return [command.executable, ...command.args].map((part) => JSON.stringify(part)).join(' ');
}

export function isPathContainedInBoundary(filePath: string, boundaryPath: string): boolean {
  const normalize = (value: string): string => {
    const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
    return normalized.replace(/\/+$/, '');
  };
  const normFile = normalize(filePath);
  const normBoundary = normalize(boundaryPath);
  if (normBoundary === '' || normBoundary === '.') return true;
  if (normFile === '..' || normFile.startsWith('../') || normBoundary === '..' || normBoundary.startsWith('../')) return false;
  const fileKey = process.platform === 'win32' ? normFile.toLowerCase() : normFile;
  const boundaryKey = process.platform === 'win32' ? normBoundary.toLowerCase() : normBoundary;
  return fileKey === boundaryKey || fileKey.startsWith(`${boundaryKey}/`);
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
    try {
      const project = this.repo.getProject(task.project_id);
      if (!project) throw new Error('CAPABILITY_PROJECT_MISSING');
      new VerificationCapabilityService(this.repo).validateSnapshot(task.project_id,
        canonicalPayload.verificationCommands, project.repository_path);
    } catch {
      return fail('VERIFICATION_CAPABILITY_REJECTED', 'Verification capability is missing, stale or revoked.');
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
    // Repair context is executable input. Reuse it only when every durable
    // identity still belongs to this exact authorization attempt; selecting by
    // task alone could replay stale findings, snapshots, or provider routing.
    const repairContext = this.options.autonomyStore?.getLatestRepairContext(task.id, {
      authorizationId: authorization.id,
      ownershipEpoch: authorization.task_ownership_epoch ?? task.ownership_epoch ?? 1,
      baseSha: authorization.base_sha,
      currentHeadSha: authorization.repository_head_sha,
      selectedProviderId: authorization.selected_provider_id,
      selectedResourceId: authorization.selected_resource_id,
    }) ?? undefined;

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
      repairContext,
    };
    return createWorkOrder(spec);
  }

  public createVerificationInvocations(authority: ProductTaskAuthority, order: WorkOrder): ApprovedVerificationInvocation[] {
    const authorization = this.repo.getExecutionAuthorization(authority.authorization.id);
    if (!authorization || authorization.status === 'INVALIDATED' || authorization.task_id !== order.task_id ||
        authorization.project_id !== authority.task.project_id || !authorization.canonical_payload_json) {
      throw new Error('VERIFICATION_AUTHORIZATION_REJECTED');
    }
    const payload = CanonicalExecutionPayloadSchema.parse(JSON.parse(authorization.canonical_payload_json));
    if (computePayloadHash(payload) !== authorization.instruction_payload_hash ||
        !payload.executionScope || payload.executionScope.worktree !== order.worktree) {
      throw new Error('VERIFICATION_SCOPE_REJECTED');
    }
    const commands = Object.values(payload.verificationCommands).filter((command) => command !== null);
    if (!areStringArraysIdentical(commands.map(renderCommand), order.required_tests)) throw new Error('VERIFICATION_COMMAND_SNAPSHOT_MISMATCH');
    const capabilities = new VerificationCapabilityService(this.repo);
    capabilities.validateSnapshot(authorization.project_id, payload.verificationCommands, order.worktree, authorization.id);
    return commands.map((command) => ({
      command: renderCommand(command), executable: command.executable, args: [...command.args], timeoutMs: command.timeout_ms ?? 120000,
      verificationBoundary: capabilities.createProcessBoundary(command.capability as VerificationCapabilityReference,
        authorization.project_id, command.executable, command.args, order.worktree, authorization.id),
    }));
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

  private recordLeaseCleanupFailure(
    authority: ProductTaskAuthority,
    lease: Extract<AcquireSlotLeaseResult, { status: 'ACQUIRED' }>['lease'],
    code: string,
    error: string,
  ): ProductLeaseCleanupResult {
    const markerInput: ProductLeaseRecoveryMarkerInput = {
      leaseId: lease.id,
      assignmentId: lease.assignment_id,
      taskId: authority.task.id,
      projectId: authority.task.project_id,
      accountId: lease.provider_account_id,
      workerSlotId: lease.worker_slot_id,
      leaseToken: lease.lease_token,
      reasonCode: code,
      reason: error,
      observedAt: new Date().toISOString(),
    };
    const marker = createProductLeaseRecoveryMarkerEvent(markerInput);
    let markerEventId: string | null = null;
    try {
      this.repo.createDeterministicGenericEvent(marker);
      markerEventId = marker.id;
    } catch {
      // The release may have failed because SQLite is busy or closing. The
      // adapter still returns a typed recovery result; startup scanning will
      // rediscover the unreleased row and retry without losing the outcome.
    }
    return {
      status: 'RECOVERY_REQUIRED',
      leaseId: lease.id,
      markerEventId,
      code,
      error,
      ownerTokenSha256: productLeaseOwnerFingerprint(lease.lease_token),
    };
  }

  public transitionTask(task: Task, trigger: TaskTrigger): Task {
    if (!task || typeof task !== 'object') throw new Error('INVALID_TASK_TRANSITION_BINDING');
    const result = this.taskService.transitionAuthorizedTask(task.id, trigger, captureAuthorizedTaskTransitionBinding(task));
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
    expectedRevision?: number;
    expectedOwnershipEpoch?: number;
    expectedState?: Task['state'];
    executionId?: string;
  }): TestRun {
    const currentTask = this.repo.getTask(input.taskId);
    if (!currentTask) throw new Error(`TASK_NOT_FOUND: ${input.taskId}`);
    const expectedRevision = input.expectedRevision ?? currentTask.revision_count;
    const expectedOwnershipEpoch = input.expectedOwnershipEpoch ?? (currentTask.ownership_epoch ?? 1);
    const expectedState = input.expectedState ?? currentTask.state;
    const executionId = input.executionId ?? crypto.randomUUID();
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
    try {
      this.repo.runInImmediateTransaction(() => {
        const liveTask = this.repo.getTask(input.taskId);
        const liveEpoch = liveTask?.ownership_epoch ?? 1;
        if (
          !liveTask ||
          liveTask.project_id !== input.projectId ||
          liveTask.revision_count !== expectedRevision ||
          liveEpoch !== expectedOwnershipEpoch ||
          liveTask.state !== expectedState
        ) {
          throw new Error(
            `STALE_VALIDATION_RESULT: execution ${executionId} no longer owns task ${input.taskId}.`,
          );
        }
        this.repo.createEvidence(evidence);
        this.repo.createProcessRun(processRun);
        this.repo.updateProcessRun(processRunId, input.status, input.exitCode, finishedAt, evidenceId, null);
        this.repo.createTestRun(run);
      });
    } catch (error) {
      if (evidence.file_path) {
        this.options.artifactStore.cleanupRollbackFiles(
          [evidence.file_path],
          (filePath) => this.repo.isEvidenceFilePathReferenced(filePath),
        );
      }
      throw error;
    }
    return run;
  }

  public getTruthfulVerificationReport(taskId: string): TruthfulVerificationReport {
    const task = this.repo.getTask(taskId);
    const db = this.repo.getDatabase();
    const totalAttempts = (db.prepare('SELECT COUNT(*) AS count FROM test_runs WHERE task_id=?').get(taskId) as { count: number }).count;
    const runs = db.prepare(`SELECT * FROM test_runs WHERE task_id=? ORDER BY created_at ASC, rowid ASC LIMIT ?`)
      .all(taskId, VERIFICATION_REPORT_MAX_ATTEMPTS) as TestRun[];
    let remainingReadBytes = VERIFICATION_REPORT_MAX_TOTAL_READ_BYTES;
    let reportError: VerificationEvidenceErrorCode | undefined = !task ? 'VERIFICATION_EVIDENCE_SCOPE_INVALID'
      : totalAttempts > VERIFICATION_REPORT_MAX_ATTEMPTS ? 'VERIFICATION_EVIDENCE_LIMIT_EXCEEDED' : undefined;
    const attempts: VerificationAttemptSummary[] = runs.map((run, index) => {
      let stdout = '', stderr = '';
      let evidenceErrorCode: VerificationEvidenceErrorCode | undefined = reportError;
      let outputTruncated = false;
      const reject = (code: VerificationEvidenceErrorCode): never => { throw new Error(code); };
      try {
        if (evidenceErrorCode) reject(evidenceErrorCode);
        if (!run.evidence_id) reject('VERIFICATION_EVIDENCE_MISSING');
        const evidence = this.repo.getEvidence(run.evidence_id!);
        if (!evidence) reject('VERIFICATION_EVIDENCE_MISSING');
        if (evidence!.project_id !== task!.project_id || evidence!.task_id !== taskId ||
            (evidence!.attempt_id !== null && this.repo.getTaskAttempt(evidence!.attempt_id)?.task_id !== taskId)) {
          reject('VERIFICATION_EVIDENCE_SCOPE_INVALID');
        }
        if (evidence!.evidence_type !== 'TEST_RESULT' || evidence!.content_type !== 'text/plain' ||
            !['INLINE', 'FILE'].includes(evidence!.storage_type) || !/^[a-f0-9]{64}$/.test(evidence!.hash) ||
            !Number.isSafeInteger(evidence!.byte_size) || evidence!.byte_size < 0) reject('VERIFICATION_EVIDENCE_METADATA_INVALID');
        // A positive I/O bound also covers empty/corrupt size metadata without
        // triggering ArtifactStore's default-bound fallback. Charge failed
        // reads too; their bytes cannot disappear from the cumulative budget.
        const readLimit = Math.max(1, evidence!.byte_size);
        if (readLimit > Math.min(VERIFICATION_REPORT_MAX_READ_BYTES, remainingReadBytes)) {
          reject('VERIFICATION_EVIDENCE_LIMIT_EXCEEDED');
        }
        const processes = db.prepare(`SELECT project_id,task_id,attempt_id,status,exit_code FROM process_runs
          WHERE stdout_evidence_id=? OR stderr_evidence_id=? LIMIT 2`).all(evidence!.id, evidence!.id) as Array<{
          project_id: string; task_id: string; attempt_id: string | null; status: string; exit_code: number | null;
        }>;
        if (processes.length > 1 || processes.some(process => process.project_id !== task!.project_id ||
            process.task_id !== taskId || process.attempt_id !== evidence!.attempt_id) ||
            (run.exit_code === 0 && (processes.length !== 1 || processes[0].status !== 'COMPLETED' || processes[0].exit_code !== 0))) {
          reject('VERIFICATION_EVIDENCE_PROCESS_INVALID');
        }
        let payload: string;
        remainingReadBytes -= readLimit;
        try { payload = this.options.artifactStore.readText(evidence!, readLimit); }
        catch { reject('VERIFICATION_EVIDENCE_READ_FAILED'); }
        const stdoutMarker = '=== STDOUT ===\n', stderrMarker = '\n=== STDERR ===\n';
        const start = payload!.indexOf(stdoutMarker);
        const separator = payload!.indexOf(stderrMarker, start + stdoutMarker.length);
        if (start < 0) {
          if (run.exit_code === 0) reject('VERIFICATION_EVIDENCE_FORMAT_INVALID');
          // Configuration failures have a verified plain diagnostic, not a
          // process stdout/stderr envelope. Preserve it as failed stderr.
          stderr = payload!;
        } else {
          if (separator < 0 || payload!.indexOf(stdoutMarker, start + stdoutMarker.length) >= 0 ||
              payload!.indexOf(stderrMarker, separator + stderrMarker.length) >= 0) reject('VERIFICATION_EVIDENCE_FORMAT_INVALID');
          stdout = payload!.slice(start + stdoutMarker.length, separator);
          stderr = payload!.slice(separator + stderrMarker.length);
        }
        const bound = (value: string): string => {
          const safe = redactTrialEvidenceText(ProcessRunner.scrubSecrets(value));
          if (safe.length <= VERIFICATION_REPORT_MAX_OUTPUT_CHARACTERS) return safe;
          outputTruncated = true;
          const marker = '\n[VERIFICATION_REPORT_OUTPUT_TRUNCATED]';
          return safe.slice(0, VERIFICATION_REPORT_MAX_OUTPUT_CHARACTERS - marker.length) + marker;
        };
        stdout = bound(stdout); stderr = bound(stderr);
      } catch (error) {
        const known: VerificationEvidenceErrorCode[] = [
          'VERIFICATION_EVIDENCE_MISSING', 'VERIFICATION_EVIDENCE_SCOPE_INVALID', 'VERIFICATION_EVIDENCE_SCOPE_CHANGED',
          'VERIFICATION_EVIDENCE_PROCESS_INVALID', 'VERIFICATION_EVIDENCE_METADATA_INVALID', 'VERIFICATION_EVIDENCE_LIMIT_EXCEEDED',
          'VERIFICATION_EVIDENCE_READ_FAILED', 'VERIFICATION_EVIDENCE_FORMAT_INVALID',
        ];
        evidenceErrorCode = error instanceof Error && known.includes(error.message as VerificationEvidenceErrorCode)
          ? error.message as VerificationEvidenceErrorCode : 'VERIFICATION_EVIDENCE_READ_FAILED';
        stdout = ''; stderr = evidenceErrorCode;
      }
      return {
        attemptNumber: index + 1,
        testRunId: run.id,
        command: redactTrialEvidenceText(ProcessRunner.scrubSecrets(run.command)).slice(0, 4096),
        passedCount: run.passed_count,
        failedCount: run.failed_count,
        skippedCount: run.skipped_count,
        durationMs: run.duration_ms,
        exitCode: run.exit_code,
        evidenceId: run.evidence_id,
        createdAt: run.created_at,
        success: !evidenceErrorCode && run.exit_code === 0 && run.failed_count === 0,
        stdout, stderr, outputTruncated,
        evidenceStatus: evidenceErrorCode ? 'INCOMPLETE' : 'VERIFIED', evidenceErrorCode,
      };
    });
    const liveTask = this.repo.getTask(taskId);
    if (task && (!liveTask || liveTask.project_id !== task.project_id || liveTask.revision_count !== task.revision_count ||
        (liveTask.ownership_epoch ?? 1) !== (task.ownership_epoch ?? 1))) {
      reportError = 'VERIFICATION_EVIDENCE_SCOPE_CHANGED';
      for (const attempt of attempts) Object.assign(attempt, { stdout: '', stderr: reportError, success: false,
        evidenceStatus: 'INCOMPLETE', evidenceErrorCode: reportError, outputTruncated: false });
    }
    reportError ??= attempts.find(attempt => attempt.evidenceErrorCode)?.evidenceErrorCode;
    const latestAttemptPassed = !reportError && (attempts.at(-1)?.success ?? false);
    return {
      taskId,
      totalAttempts,
      isFirstPassSuccess: attempts.length === 1 && latestAttemptPassed,
      latestAttemptPassed,
      hadPriorFailure: attempts.slice(0, -1).some((attempt) => attempt.exitCode !== 0 || attempt.failedCount > 0),
      attempts,
      evidenceStatus: reportError ? 'INCOMPLETE' : 'COMPLETE', evidenceErrorCode: reportError,
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

  private mapAttemptsToGitEvidenceTests(
    attempts: VerificationAttemptSummary[]
  ): Array<{ command: string; exitCode: number; stdout: string; stderr: string; durationMs: number }> {
    return attempts.map((attempt) => ({
      command: attempt.command,
      exitCode: attempt.exitCode,
      stdout: attempt.stdout,
      stderr: attempt.stderr,
      durationMs: attempt.durationMs,
    }));
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
    let observedVerificationReport: TruthfulVerificationReport | undefined;
    const authorityEpoch = validated.authority.task.ownership_epoch ?? 1;
    let task = { ...validated.authority.task };
    try {
      if (task.state === 'APPROVED' || task.state === 'QUEUED') task = this.transitionTask(task, 'DISPATCH');
      if (task.state === 'DISPATCHED' || task.state === 'FIX_REQUIRED') task = this.transitionTask(task, 'START_CODING');
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

      task = this.repo.runInImmediateTransaction(() => {
        const transitioned = this.transitionTask(task, 'SUBMIT_REPORT');
        this.repo.updateTaskShas(transitioned.id, undefined, preReviewEvidence.headSha);
        return this.repo.getTask(transitioned.id)!;
      });

      // Verification acceptance strictly requires a newly persisted TestRun
      // and its process/evidence lineage from this authorization attempt.
      const priorTestRunIds = new Set(this.repo.getTestRunsByTaskId(task.id).map((run) => run.id));
      const verificationBinding: TaskMutationBinding = {
        expectedRevision: task.revision_count,
        expectedOwnershipEpoch: authorityEpoch,
        expectedState: task.state,
        executionId: validated.authority.authorization.execution_id ?? validated.authority.authorization.id,
      };
      const verificationProject = this.repo.getProject(task.project_id);
      if (!verificationProject) throw new Error('VERIFICATION_CAPABILITY_PROJECT_MISSING');
      const verificationPayload = CanonicalExecutionPayloadSchema.parse(JSON.parse(validated.authority.authorization.canonical_payload_json!));
      const capabilities = new VerificationCapabilityService(this.repo);
      capabilities.validateSnapshot(task.project_id, verificationPayload.verificationCommands,
        verificationProject.repository_path, validated.authority.authorization.id);
      const currentTestRun = await input.runVerification(validated.authority, workOrder, verificationBinding);
      const afterVerificationTask = this.repo.getTask(task.id);
      const afterVerificationEpoch = afterVerificationTask?.ownership_epoch ?? authorityEpoch;
      if (
        !afterVerificationTask ||
        afterVerificationTask.revision_count !== verificationBinding.expectedRevision ||
        afterVerificationEpoch !== authorityEpoch ||
        afterVerificationTask.state !== verificationBinding.expectedState
      ) {
        throw new Error(
          `STALE_VALIDATION_RESULT: execution ${verificationBinding.executionId} completed after task reassignment or revision change.`,
        );
      }
      capabilities.validateSnapshot(task.project_id, verificationPayload.verificationCommands,
        verificationProject.repository_path, validated.authority.authorization.id);
      const verificationReport = this.getTruthfulVerificationReport(task.id);
      observedVerificationReport = verificationReport;
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
        verificationReport.evidenceStatus === 'COMPLETE' &&
        currentRunBound &&
        persistedCurrentRun!.exit_code === 0 &&
        persistedCurrentRun!.failed_count === 0 &&
        currentProcess?.status === 'COMPLETED' &&
        currentProcess.exit_code === 0
      );

      if (!currentTestRunPassed) {
        task = this.transitionTask(task, 'TESTS_FAILED');
        const verificationError = verificationReport.evidenceStatus !== 'COMPLETE'
          ? verificationReport.evidenceErrorCode ?? 'VERIFICATION_EVIDENCE_READ_FAILED'
          : !currentTestRun
          ? 'CURRENT_VERIFICATION_TEST_RUN_MISSING'
          : !currentRunBound
            ? 'CURRENT_VERIFICATION_AUTHORITY_BINDING_INVALID'
            : 'VERIFICATION_FAILED';

        const failingSignatures = extractFailingTestSignatures(
          this.mapAttemptsToGitEvidenceTests(verificationReport.attempts)
        );

        let noProgress = undefined;
        if (workOrder.repair_context && verificationReport.evidenceStatus === 'COMPLETE' &&
            !verificationReport.attempts.some(attempt => attempt.outputTruncated)) {
          noProgress = detectNoProgress({
            repairContext: workOrder.repair_context,
            currentEvidence: {
              ...preReviewEvidence,
              tests: this.mapAttemptsToGitEvidenceTests(verificationReport.attempts),
            },
            coderBundle: coder.bundle,
          });
        }

        if (this.options.autonomyStore) {
          if (noProgress?.hasNoProgress) {
            this.options.autonomyStore.recordRepairNoProgress(task.id, noProgress);
          }
          this.options.autonomyStore.recordRepairOutcome(task.id, {
            protocol_version: 'repairoutcome.v1',
            task_id: task.id,
            attempt: workOrder.attempt,
            status: noProgress?.hasNoProgress ? 'NO_PROGRESS' : 'FAILED',
            resolved_finding_ids: workOrder.repair_context?.resolved_finding_ids ?? [],
            unresolved_finding_ids: workOrder.repair_context?.unresolved_finding_ids ?? [],
            no_progress_category: noProgress?.category ?? null,
            escalation_stage: getEscalationStage(workOrder.attempt),
            summary: noProgress?.hasNoProgress
              ? `REPAIR_NO_PROGRESS: ${noProgress.category}: ${noProgress.reason}`
              : `Verification tests failed in attempt ${workOrder.attempt}`,
            head_sha: preReviewEvidence.headSha,
            snapshot_sha: preReviewEvidence.snapshotSha ?? '0'.repeat(40),
            created_at: new Date().toISOString(),
          });

          const nextAttempt = workOrder.attempt + 1;
          const nextPackage = buildRepairContextPackage({
            taskId: task.id,
            authorizationId: validated.authority.authorization.id,
            ownershipEpoch: authorityEpoch,
            attempt: nextAttempt,
            baseSha: workOrder.base_sha,
            currentHeadSha: preReviewEvidence.headSha,
            currentSnapshotSha: preReviewEvidence.snapshotSha ?? '0'.repeat(40),
            originalObjective: workOrder.objective,
            acceptanceCriteria: workOrder.acceptance_criteria,
            allowedPaths: workOrder.allowed_paths,
            forbiddenPaths: workOrder.forbidden_paths,
            requiredTests: workOrder.required_tests,
            reviewerFindings: workOrder.repair_context?.previous_reviewer_findings ?? [],
            requiredActions: workOrder.repair_context?.required_actions ?? [],
            previousResolvedFindingIds: workOrder.repair_context?.resolved_finding_ids ?? [],
            previousCoderActions: [
              ...(workOrder.repair_context?.previous_coder_actions ?? []),
              {
                attempt: workOrder.attempt,
                changed_files: coder.bundle?.changed_files ?? preReviewEvidence.changedFiles,
                diff_summary: preReviewEvidence.diff,
                test_results: verificationReport.attempts.map((a) => ({
                  command: a.command,
                  exitCode: a.exitCode,
                  passed: a.success,
                  durationMs: a.durationMs,
                })),
                addressed_finding_ids: coder.bundle?.addressed_finding_ids ?? [],
                unresolved_finding_ids: coder.bundle?.unresolved_finding_ids ?? [],
                implementation_summary: coder.bundle?.implementation_summary,
                known_risks: coder.bundle?.known_risks ?? [],
                snapshot_sha: preReviewEvidence.snapshotSha,
                head_sha: preReviewEvidence.headSha,
                patch_hash: computeNormalizedPatchHash(preReviewEvidence.diff),
              },
            ],
            knownFailedApproaches: [
              ...(workOrder.repair_context?.known_failed_approaches ?? []),
              {
                attempt: workOrder.attempt,
                description: `Verification tests failed in attempt ${workOrder.attempt}`,
                test_failure_signatures: failingSignatures,
              },
              ...(noProgress?.hasNoProgress ? [{
                attempt: workOrder.attempt,
                description: `No-progress detected (${noProgress.category}): ${noProgress.reason}`,
                test_failure_signatures: [],
                category: noProgress.category,
              }] : []),
            ],
            selectedResourceId: validated.authority.authorization.selected_resource_id,
            selectedProviderId: validated.authority.authorization.selected_provider_id,
          });
          this.options.autonomyStore.recordRepairContext(task.id, nextPackage);
        }

        result = {
          success: false,
          finalTaskState: task.state,
          leaseAcquired: true,
          leaseReleased: false,
          workOrder,
          verificationReport,
          error: noProgress?.hasNoProgress ? `REPAIR_NO_PROGRESS: ${noProgress.category}: ${noProgress.reason}` : verificationError,
        };
      } else {
        task = this.transitionTask(task, 'EVIDENCE_GATHERED');
        task = this.transitionTask(task, 'START_REVIEW');
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

        let reconciledClosure = undefined;
        let noProgress = undefined;
        if (workOrder.repair_context && !verificationReport.attempts.some(attempt => attempt.outputTruncated)) {
          const mappedRepairTests = this.mapAttemptsToGitEvidenceTests(verificationReport.attempts);
          reconciledClosure = reconcileFindingClosure({
            repairContext: workOrder.repair_context,
            coderBundle: coder.bundle,
            observedEvidence: {
              ...preReviewEvidence,
              tests: mappedRepairTests,
            },
            latestReview: review,
          });

          noProgress = detectNoProgress({
            repairContext: workOrder.repair_context,
            currentEvidence: {
              ...preReviewEvidence,
              tests: mappedRepairTests,
            },
            coderBundle: coder.bundle,
            reconciledClosure,
            latestReview: review,
          });

          if (noProgress.hasNoProgress && this.options.autonomyStore) {
            this.options.autonomyStore.recordRepairNoProgress(task.id, noProgress);
          }
        }

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
          task = this.transitionTask(task, 'FIX_VERDICT');
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
            task = this.transitionTask(task, 'FIX_VERDICT');
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
          const isNoProgress = noProgress?.hasNoProgress;
          if (this.options.autonomyStore) {
            this.options.autonomyStore.recordRepairOutcome(task.id, {
              protocol_version: 'repairoutcome.v1',
              task_id: task.id,
              attempt: workOrder.attempt,
              status: isNoProgress ? 'NO_PROGRESS' : (workOrder.attempt >= 3 ? 'BLOCKED' : 'ESCALATED'),
              resolved_finding_ids: reconciledClosure?.resolvedFindingIds ?? [],
              unresolved_finding_ids: reconciledClosure?.unresolvedFindingIds ?? normalizeReviewerFindings(review.findings).map((f) => f.finding_id),
              no_progress_category: noProgress?.category ?? null,
              escalation_stage: getEscalationStage(workOrder.attempt),
              summary: isNoProgress ? `REPAIR_NO_PROGRESS: ${noProgress?.category}: ${noProgress?.reason}` : `Repair attempt ${workOrder.attempt} requires further iteration (verdict=${review.verdict}).`,
              head_sha: postReviewEvidence.headSha,
              snapshot_sha: postReviewEvidence.snapshotSha ?? preReviewEvidence.snapshotSha ?? '0'.repeat(40),
              created_at: new Date().toISOString(),
            });

            const nextAttempt = workOrder.attempt + 1;
            const nextPackage = buildRepairContextPackage({
              taskId: task.id,
              authorizationId: validated.authority.authorization.id,
              ownershipEpoch: authorityEpoch,
              attempt: nextAttempt,
              baseSha: workOrder.base_sha,
              currentHeadSha: postReviewEvidence.headSha,
              currentSnapshotSha: postReviewEvidence.snapshotSha ?? preReviewEvidence.snapshotSha ?? '0'.repeat(40),
              originalObjective: workOrder.objective,
              acceptanceCriteria: workOrder.acceptance_criteria,
              allowedPaths: workOrder.allowed_paths,
              forbiddenPaths: workOrder.forbidden_paths,
              requiredTests: workOrder.required_tests,
              reviewerFindings: review.findings,
              requiredActions: review.required_actions,
              previousResolvedFindingIds: reconciledClosure?.resolvedFindingIds ?? [],
              previousCoderActions: [
                ...(workOrder.repair_context?.previous_coder_actions ?? []),
                {
                  attempt: workOrder.attempt,
                  changed_files: coder.bundle?.changed_files ?? preReviewEvidence.changedFiles,
                  diff_summary: preReviewEvidence.diff,
                  test_results: verificationReport.attempts.map((a) => ({
                    command: a.command,
                    exitCode: a.exitCode,
                    passed: a.success,
                    durationMs: a.durationMs,
                  })),
                  addressed_finding_ids: coder.bundle?.addressed_finding_ids ?? [],
                  unresolved_finding_ids: coder.bundle?.unresolved_finding_ids ?? [],
                  implementation_summary: coder.bundle?.implementation_summary,
                  known_risks: coder.bundle?.known_risks ?? [],
                  snapshot_sha: preReviewEvidence.snapshotSha,
                  head_sha: preReviewEvidence.headSha,
                  patch_hash: computeNormalizedPatchHash(preReviewEvidence.diff),
                },
              ],
              knownFailedApproaches: [
                ...(workOrder.repair_context?.known_failed_approaches ?? []),
                ...(isNoProgress ? [{
                  attempt: workOrder.attempt,
                  description: `No-progress detected (${noProgress?.category}): ${noProgress?.reason}`,
                  test_failure_signatures: [],
                  category: noProgress?.category,
                }] : []),
              ],
              selectedResourceId: validated.authority.authorization.selected_resource_id,
              selectedProviderId: validated.authority.authorization.selected_provider_id,
            });
            this.options.autonomyStore.recordRepairContext(task.id, nextPackage);
          }

          task = this.transitionTask(task, review.verdict === 'REPAIR' ? 'FIX_VERDICT' : 'MAX_REVISIONS_EXCEEDED');
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
            error: isNoProgress ? `REPAIR_NO_PROGRESS: ${noProgress?.category}: ${noProgress?.reason}` : `MANAGER_${review.verdict}`,
          };
        } else {
          observedVerificationReport = this.getTruthfulVerificationReport(task.id);
          if (observedVerificationReport.evidenceStatus !== 'COMPLETE' ||
              !observedVerificationReport.attempts.find(attempt => attempt.testRunId === persistedCurrentRun!.id)?.success) {
            throw new Error(observedVerificationReport.evidenceErrorCode ?? 'VERIFICATION_EVIDENCE_PROCESS_INVALID');
          }
          if (this.options.autonomyStore) {
            this.options.autonomyStore.recordRepairOutcome(task.id, {
              protocol_version: 'repairoutcome.v1',
              task_id: task.id,
              attempt: workOrder.attempt,
              status: 'CONVERGED',
              resolved_finding_ids: reconciledClosure?.resolvedFindingIds ?? normalizeReviewerFindings(workOrder.repair_context?.previous_reviewer_findings ?? []).map((f) => f.finding_id),
              unresolved_finding_ids: [],
              escalation_stage: getEscalationStage(workOrder.attempt),
              summary: `Repair converged successfully at attempt ${workOrder.attempt}`,
              head_sha: postReviewEvidence.headSha,
              snapshot_sha: postReviewEvidence.snapshotSha ?? preReviewEvidence.snapshotSha ?? '0'.repeat(40),
              created_at: new Date().toISOString(),
            });
          }
          task = this.transitionTask(task, 'PASS_VERDICT');
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
      const executionError = error instanceof Error ? error.message : String(error);
      let reportedError = executionError;
      if (currentTask && task.state === 'REVIEWING') {
        const currentEpoch = currentTask.ownership_epoch ?? authorityEpoch;
        if (currentEpoch === authorityEpoch) {
          try {
            const recovered = this.transitionTask(task, 'FIX_VERDICT');
            finalTaskState = recovered.state;
          } catch (recoveryError) {
            finalTaskState = this.repo.getTask(currentTask.id)?.state ?? currentTask.state;
            const recoveryMessage = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
            reportedError = recoveryMessage.includes('OWNERSHIP_EPOCH_MISMATCH') || recoveryMessage.includes('STALE_TASK_TRANSITION')
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
        verificationReport: observedVerificationReport,
        error: reportedError,
      };
    }

    let released: ReleaseLeaseResult;
    try {
      released = this.releaseWorkerSlotLease(acquired.lease.id, acquired.lease.lease_token);
    } catch (error) {
      const cleanupError = error instanceof Error ? error.message : String(error);
      released = {
        status: 'FAILED',
        code: 'LEASE_RELEASE_FAILED',
        error: `LEASE_RELEASE_FAILED: ${cleanupError}`,
      };
    }

    result.leaseReleased = released.status === 'RELEASED';
    if (released.status === 'RELEASED') {
      result.leaseCleanup = {
        status: 'RELEASED',
        leaseId: acquired.lease.id,
      };
    } else {
      result.leaseCleanup = this.recordLeaseCleanupFailure(
        validated.authority,
        acquired.lease,
        released.code,
        released.error,
      );
    }
    return result;
  }
}

export const ProductTaskAutonomyService = ProductTaskAutonomyAdapter;
export const ProductTaskAutonomyIntegrationService = ProductTaskAutonomyAdapter;
