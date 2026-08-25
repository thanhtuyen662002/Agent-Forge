import crypto from 'crypto';
import { ProviderRegistry } from '../adapters/ProviderRegistry';
import { Repository } from '../database/repositories';
import { EventService } from './EventService';
import { GitService } from './GitService';
import { ProtocolParser } from '../protocol/parser';
import {
  AgentExecutionRequest,
  AgentExecutionResult,
  RuntimeExecutionBinding,
  ProviderAdapter,
} from '../adapters/ProviderAdapter';
import {
  ExecutionAuthorization,
  ProviderAccount,
  AgentAssignment,
} from '../types/domain';
import { GitWorktreeService, WorktreeOwnershipTuple, WorktreeInspection } from './GitWorktreeService';
import {
  computeCanonicalPayload,
  computePayloadHash,
  computeContextManifestHash,
  CanonicalExecutionPayloadSchema,
  CanonicalExecutionPayload,
} from './ExecutionAuthorizationService';

export type ScheduledCancellationStatus =
  | 'CANCEL_REQUESTED'
  | 'ALREADY_REQUESTED'
  | 'NOT_ACTIVE'
  | 'ADAPTER_CANCEL_FAILED';

export interface ScheduledCancellationResult {
  status: ScheduledCancellationStatus;
  authorizationId: string;
  executionId?: string;
  error?: string;
}

interface ScheduledDispatchControl {
  executionId: string;
  phase: 'PREPARING' | 'EXECUTING';
  adapter: ProviderAdapter | null;
  cancelRequested: boolean;
  startedAt: string;
}

export class ProviderDispatchService {
  private activeDispatches = new Map<string, ScheduledDispatchControl>();

  constructor(
    private providerRegistry: ProviderRegistry,
    private repo: Repository,
    private eventService?: EventService,
    private gitWorktreeService?: GitWorktreeService
  ) {}

  public setGitWorktreeService(service: GitWorktreeService): void {
    this.gitWorktreeService = service;
  }

  /**
   * Cancels an active scheduled execution if it is currently in PREPARING or EXECUTING phase.
   * Caller supplies only authorizationId.
   */
  public async cancelScheduled(authorizationId: string): Promise<ScheduledCancellationResult> {
    const control = this.activeDispatches.get(authorizationId);
    if (!control) {
      return {
        status: 'NOT_ACTIVE',
        authorizationId,
      };
    }

    if (control.cancelRequested) {
      return {
        status: 'ALREADY_REQUESTED',
        authorizationId,
        executionId: control.executionId,
      };
    }

    control.cancelRequested = true;

    if (control.phase === 'EXECUTING' && control.adapter) {
      try {
        await control.adapter.cancel(control.executionId);
      } catch (err: any) {
        return {
          status: 'ADAPTER_CANCEL_FAILED',
          authorizationId,
          executionId: control.executionId,
          error: `Adapter cancellation threw: ${err.message}`,
        };
      }
    }

    return {
      status: 'CANCEL_REQUESTED',
      authorizationId,
      executionId: control.executionId,
    };
  }

  /**
   * Dispatches task execution bound to an immutable, durably persisted ExecutionAuthorization in legacy mode.
   * Atomically claims the authorization to prevent duplicate/concurrent executions.
   * Derives all execution instructions internally from approved durable state.
   */
  public async dispatch(authorizationId: string): Promise<AgentExecutionResult> {
    return this.dispatchInternal(authorizationId, 'LEGACY');
  }

  /**
   * Dispatches task execution bound to an immutable, durably persisted ExecutionAuthorization in scheduled mode.
   * Verifies that the required worker slot and isolated Git worktree are already prepared, locked, and clean.
   * Populates RuntimeExecutionBinding with verified workspace metadata for adapter execution.
   */
  public async dispatchScheduled(authorizationId: string): Promise<AgentExecutionResult> {
    return this.dispatchInternal(authorizationId, 'SCHEDULED');
  }

  private async dispatchInternal(
    authorizationId: string,
    mode: 'LEGACY' | 'SCHEDULED'
  ): Promise<AgentExecutionResult> {
    const executionId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    let control: ScheduledDispatchControl | undefined;
    if (mode === 'SCHEDULED') {
      if (this.activeDispatches.has(authorizationId)) {
        return {
          executionId,
          status: 'FAILED',
          errorCode: 'RESOURCE_UNAVAILABLE',
          error: `SCHEDULED_DISPATCH_ALREADY_ACTIVE: A scheduled execution for authorization "${authorizationId}" is already in progress.`,
        };
      }
      control = {
        executionId,
        phase: 'PREPARING',
        adapter: null,
        cancelRequested: false,
        startedAt: nowIso,
      };
      this.activeDispatches.set(authorizationId, control);
    }

    try {

    // 1. Fetch authorization metadata for initial existence check
    const auth = this.repo.getExecutionAuthorization(authorizationId);
    if (!auth) {
      return {
        executionId,
        status: 'FAILED',
        error: `EXECUTION_AUTHORIZATION_NOT_FOUND: Execution authorization "${authorizationId}" was not found in database.`,
      };
    }

    if (auth.status === 'DISPATCHED') {
      return {
        executionId,
        status: 'FAILED',
        error: `EXECUTION_AUTHORIZATION_ALREADY_DISPATCHED: Execution authorization "${authorizationId}" has already been consumed.`,
      };
    }

    if (auth.status === 'INVALIDATED') {
      return {
        executionId,
        status: 'FAILED',
        error: `EXECUTION_AUTHORIZATION_INVALIDATED: Execution authorization "${authorizationId}" has been invalidated.`,
      };
    }

    // 2. Structured Durable Payload Validation (Safe JSON parse & shape validation)
    let parsedInstructions: string[];
    let parsedContextFiles: string[];
    try {
      const rawInst = JSON.parse(auth.canonical_instructions_json);
      const rawCtx = JSON.parse(auth.context_files_json);
      if (!Array.isArray(rawInst) || !rawInst.every((x) => typeof x === 'string')) {
        throw new Error('canonical_instructions_json is not an array of strings');
      }
      if (!Array.isArray(rawCtx) || !rawCtx.every((x) => typeof x === 'string')) {
        throw new Error('context_files_json is not an array of strings');
      }
      parsedInstructions = rawInst;
      parsedContextFiles = rawCtx;
    } catch (err: any) {
      this.repo.invalidateExecutionAuthorization(auth.id);
      this.recordRejectionEvent(auth, `EXECUTION_AUTHORIZATION_PAYLOAD_CORRUPT: ${err.message}`);
      return {
        executionId,
        status: 'FAILED',
        error: `EXECUTION_AUTHORIZATION_PAYLOAD_CORRUPT: Malformed durable canonical payload or context files in authorization record (${err.message}).`,
      };
    }

    // 3. Validate Project, Task, and Attempt Existence & Revision Binding
    const project = this.repo.getProject(auth.project_id);
    if (!project) {
      this.repo.invalidateExecutionAuthorization(auth.id);
      this.recordRejectionEvent(auth, `Project "${auth.project_id}" not found.`);
      return {
        executionId,
        status: 'FAILED',
        error: `EXECUTION_AUTHORIZATION_PROJECT_NOT_FOUND: Project "${auth.project_id}" not found.`,
      };
    }

    const task = this.repo.getTask(auth.task_id);
    if (!task) {
      this.repo.invalidateExecutionAuthorization(auth.id);
      this.recordRejectionEvent(auth, `Task "${auth.task_id}" not found.`);
      return {
        executionId,
        status: 'FAILED',
        error: `EXECUTION_AUTHORIZATION_TASK_NOT_FOUND: Task "${auth.task_id}" not found.`,
      };
    }

    if (task.revision_count !== auth.task_revision) {
      this.repo.invalidateExecutionAuthorization(auth.id);
      this.recordRejectionEvent(
        auth,
        `EXECUTION_AUTHORIZATION_STALE_TASK_REVISION: Task revision (${task.revision_count}) differs from authorized revision (${auth.task_revision}).`
      );
      return {
        executionId,
        status: 'FAILED',
        error: `EXECUTION_AUTHORIZATION_STALE_TASK_REVISION: Task revision (${task.revision_count}) differs from authorized revision (${auth.task_revision}).`,
      };
    }

    if (task.base_sha !== auth.base_sha) {
      this.repo.invalidateExecutionAuthorization(auth.id);
      this.recordRejectionEvent(
        auth,
        `EXECUTION_AUTHORIZATION_STALE_GIT_BASE: Current task base SHA "${task.base_sha}" differs from authorized base SHA "${auth.base_sha}".`
      );
      return {
        executionId,
        status: 'FAILED',
        error: `EXECUTION_AUTHORIZATION_STALE_GIT_BASE: Current task base SHA "${task.base_sha}" differs from authorized base SHA "${auth.base_sha}".`,
      };
    }

    if (auth.attempt_id) {
      const attempt = this.repo.getTaskAttempt(auth.attempt_id);
      if (!attempt || attempt.task_id !== auth.task_id) {
        this.repo.invalidateExecutionAuthorization(auth.id);
        this.recordRejectionEvent(
          auth,
          `EXECUTION_AUTHORIZATION_ATTEMPT_MISMATCH: TaskAttempt "${auth.attempt_id}" does not belong to task "${auth.task_id}".`
        );
        return {
          executionId,
          status: 'FAILED',
          error: `EXECUTION_AUTHORIZATION_ATTEMPT_MISMATCH: TaskAttempt "${auth.attempt_id}" does not belong to task "${auth.task_id}".`,
        };
      }
    }

    // 4. Real Git Repository HEAD Authority Check at Dispatch
    const gitHeadRes = await GitService.getHeadSha(project.repository_path);
    if (gitHeadRes.status !== 'SUCCESS' || !gitHeadRes.sha || gitHeadRes.sha !== auth.repository_head_sha) {
      this.repo.invalidateExecutionAuthorization(auth.id);
      const currentSha = gitHeadRes.sha ?? 'UNKNOWN';
      const reason = `EXECUTION_AUTHORIZATION_STALE_GIT_HEAD: Current Git HEAD "${currentSha}" differs from authorized repository HEAD "${auth.repository_head_sha}".`;
      this.recordRejectionEvent(auth, reason);
      return {
        executionId,
        status: 'FAILED',
        error: reason,
      };
    }

    // 5. Manager Protocol Authority Re-verification at Dispatch
    const managerRecord =
      this.repo.getProtocolMessageByRecordId(auth.manager_message_id) ||
      this.repo.getProtocolMessageById(auth.manager_message_id);

    if (
      !managerRecord ||
      managerRecord.status !== 'APPLIED' ||
      managerRecord.protocol !== 'manager.v1' ||
      managerRecord.project_id !== auth.project_id ||
      managerRecord.task_id !== auth.task_id ||
      managerRecord.payload_hash !== auth.manager_payload_hash
    ) {
      this.repo.invalidateExecutionAuthorization(auth.id);
      const reason =
        'EXECUTION_AUTHORIZATION_MANAGER_AUTHORITY_INVALID: Bound Manager protocol message missing, unapplied, or payload hash mismatch.';
      this.recordRejectionEvent(auth, reason);
      return {
        executionId,
        status: 'FAILED',
        error: reason,
      };
    }

    // Defense-in-depth: Validate bound Manager message is still the CURRENT/LATEST applied Manager authority
    const latestAppliedManager = this.repo.getLatestAppliedManagerProtocolMessage(auth.task_id, auth.project_id);
    if (
      !latestAppliedManager ||
      String(latestAppliedManager.id) !== auth.manager_message_id ||
      String(latestAppliedManager.payload_hash) !== auth.manager_payload_hash
    ) {
      this.repo.invalidateExecutionAuthorization(auth.id);
      const reason =
        'EXECUTION_AUTHORIZATION_MANAGER_AUTHORITY_SUPERSEDED: Bound Manager authority has been superseded by a newer applied Manager message.';
      this.recordRejectionEvent(auth, reason);
      return {
        executionId,
        status: 'FAILED',
        error: reason,
      };
    }

    const parseResult = ProtocolParser.parse(String(managerRecord.raw_payload));
    if (!parseResult.success || !parseResult.data || parseResult.data.type !== 'manager.v1') {
      this.repo.invalidateExecutionAuthorization(auth.id);
      const reason =
        'EXECUTION_AUTHORIZATION_MANAGER_AUTHORITY_INVALID: Bound Manager protocol message is no longer a valid EXECUTE or FIX_REQUIRED decision.';
      this.recordRejectionEvent(auth, reason);
      return {
        executionId,
        status: 'FAILED',
        error: reason,
      };
    }

    const managerData = parseResult.data.data;
    if (managerData.decision !== 'EXECUTE' && managerData.decision !== 'FIX_REQUIRED') {
      this.repo.invalidateExecutionAuthorization(auth.id);
      const reason =
        'EXECUTION_AUTHORIZATION_MANAGER_AUTHORITY_INVALID: Bound Manager protocol message is no longer a valid EXECUTE or FIX_REQUIRED decision.';
      this.recordRejectionEvent(auth, reason);
      return {
        executionId,
        status: 'FAILED',
        error: reason,
      };
    }

    // 6. Full Routing Re-binding at Dispatch
    const routingEvent = this.repo.getRoutingDecisionEvent(auth.routing_decision_id);
    if (!routingEvent) {
      this.repo.invalidateExecutionAuthorization(auth.id);
      this.recordRejectionEvent(auth, `Routing decision "${auth.routing_decision_id}" not found.`);
      return {
        executionId,
        status: 'FAILED',
        error: `EXECUTION_AUTHORIZATION_ROUTING_NOT_FOUND: Routing decision "${auth.routing_decision_id}" was not found.`,
      };
    }

    const routingPayload = routingEvent.structured_payload as Record<string, unknown>;
    if (routingPayload.projectId !== auth.project_id || routingPayload.taskId !== auth.task_id) {
      this.repo.invalidateExecutionAuthorization(auth.id);
      const reason = 'EXECUTION_AUTHORIZATION_ROUTING_SCOPE_MISMATCH: Routing decision scope does not match authorization scope.';
      this.recordRejectionEvent(auth, reason);
      return {
        executionId,
        status: 'FAILED',
        error: reason,
      };
    }

    const routingAttempt = (routingPayload.attemptId as string | null | undefined) ?? null;
    if (routingAttempt !== auth.attempt_id) {
      this.repo.invalidateExecutionAuthorization(auth.id);
      const reason = `EXECUTION_AUTHORIZATION_ROUTING_ATTEMPT_MISMATCH: Routing decision attempt "${routingAttempt}" does not match authorization attempt "${auth.attempt_id}".`;
      this.recordRejectionEvent(auth, reason);
      return {
        executionId,
        status: 'FAILED',
        error: reason,
      };
    }

    if (routingPayload.selectedResourceId !== auth.selected_resource_id) {
      this.repo.invalidateExecutionAuthorization(auth.id);
      const reason = `EXECUTION_AUTHORIZATION_ROUTING_RESOURCE_MISMATCH: Routing decision resource "${routingPayload.selectedResourceId}" does not match authorization resource "${auth.selected_resource_id}".`;
      this.recordRejectionEvent(auth, reason);
      return {
        executionId,
        status: 'FAILED',
        error: reason,
      };
    }

    if (routingPayload.selectedProviderId !== auth.selected_provider_id) {
      this.repo.invalidateExecutionAuthorization(auth.id);
      const reason = `EXECUTION_AUTHORIZATION_ROUTING_PROVIDER_MISMATCH: Routing decision provider "${routingPayload.selectedProviderId}" does not match authorization provider "${auth.selected_provider_id}".`;
      this.recordRejectionEvent(auth, reason);
      return {
        executionId,
        status: 'FAILED',
        error: reason,
      };
    }

    const routingOutcome = routingPayload.outcome as string;
    if (routingOutcome !== 'SELECTED' && routingOutcome !== 'MANUAL_HANDOFF_REQUIRED') {
      this.repo.invalidateExecutionAuthorization(auth.id);
      const reason = `EXECUTION_AUTHORIZATION_ROUTING_INELIGIBLE: Routing outcome "${routingOutcome}" is not executable.`;
      this.recordRejectionEvent(auth, reason);
      return {
        executionId,
        status: 'FAILED',
        error: reason,
      };
    }

    if (mode === 'SCHEDULED' && routingOutcome === 'MANUAL_HANDOFF_REQUIRED') {
      return {
        executionId,
        status: 'FAILED',
        errorCode: 'RESOURCE_UNAVAILABLE',
        error: 'SCHEDULED_DISPATCH_NOT_APPLICABLE: Scheduled dispatch is not applicable to MANUAL_HANDOFF_REQUIRED decisions.',
      };
    }

    // 7. Dispatch-Time Task State Liveness Check
    if (routingOutcome === 'SELECTED') {
      if (task.state !== 'CODING') {
        this.repo.invalidateExecutionAuthorization(auth.id);
        const reason = `EXECUTION_AUTHORIZATION_STALE_TASK_STATE: Current task state "${task.state}" is incompatible with automated routing outcome "SELECTED" (expected CODING).`;
        this.recordRejectionEvent(auth, reason);
        return {
          executionId,
          status: 'FAILED',
          error: reason,
        };
      }
    } else if (routingOutcome === 'MANUAL_HANDOFF_REQUIRED') {
      if (task.state !== 'CODING' && task.state !== 'HANDOFF_REQUIRED') {
        this.repo.invalidateExecutionAuthorization(auth.id);
        const reason = `EXECUTION_AUTHORIZATION_STALE_TASK_STATE: Current task state "${task.state}" is incompatible with Manual Bridge outcome "MANUAL_HANDOFF_REQUIRED" (expected CODING or HANDOFF_REQUIRED).`;
        this.recordRejectionEvent(auth, reason);
        return {
          executionId,
          status: 'FAILED',
          error: reason,
        };
      }
    }

    // 8. R5F Account and Assignment Rebinding (for SELECTED routing outcome)
    let account: ProviderAccount | null = null;
    let assignment: AgentAssignment | null = null;

    const hasFabricContext =
      routingPayload.selectedAccountId !== undefined ||
      routingPayload.selectedAssignmentId !== undefined ||
      routingPayload.roleProfileId !== undefined;

    if (routingOutcome === 'SELECTED' && hasFabricContext) {
      const selectedAccountId = routingPayload.selectedAccountId;
      if (typeof selectedAccountId !== 'string' || selectedAccountId.trim().length === 0) {
        this.repo.invalidateExecutionAuthorization(auth.id);
        const reason = 'ROUTING_ACCOUNT_ID_MISSING: Selected routing decision missing valid selectedAccountId.';
        this.recordRejectionEvent(auth, reason);
        return { executionId, status: 'FAILED', error: reason, errorCode: 'RESOURCE_UNAVAILABLE' };
      }

      const selectedAssignmentId = routingPayload.selectedAssignmentId;
      if (typeof selectedAssignmentId !== 'string' || selectedAssignmentId.trim().length === 0) {
        this.repo.invalidateExecutionAuthorization(auth.id);
        const reason = 'ROUTING_ASSIGNMENT_ID_MISSING: Selected routing decision missing valid selectedAssignmentId.';
        this.recordRejectionEvent(auth, reason);
        return { executionId, status: 'FAILED', error: reason, errorCode: 'RESOURCE_UNAVAILABLE' };
      }

      account = this.repo.getProviderAccount(selectedAccountId);
      if (!account) {
        this.repo.invalidateExecutionAuthorization(auth.id);
        const reason = `ROUTING_ACCOUNT_NOT_FOUND: Selected provider account "${selectedAccountId}" was not found in database.`;
        this.recordRejectionEvent(auth, reason);
        return { executionId, status: 'FAILED', error: reason, errorCode: 'RESOURCE_UNAVAILABLE' };
      }

      if (!account.enabled) {
        this.repo.invalidateExecutionAuthorization(auth.id);
        const reason = `ROUTING_ACCOUNT_DISABLED: Selected provider account "${account.id}" is disabled.`;
        this.recordRejectionEvent(auth, reason);
        return { executionId, status: 'FAILED', error: reason, errorCode: 'RESOURCE_UNAVAILABLE' };
      }

      if (account.provider_id !== auth.selected_provider_id) {
        this.repo.invalidateExecutionAuthorization(auth.id);
        const reason = `ROUTING_ACCOUNT_PROVIDER_MISMATCH: Account provider_id "${account.provider_id}" differs from authorized provider "${auth.selected_provider_id}".`;
        this.recordRejectionEvent(auth, reason);
        return { executionId, status: 'FAILED', error: reason, errorCode: 'RESOURCE_UNAVAILABLE' };
      }

      if (account.health_status === 'AUTH_ERROR') {
        this.repo.invalidateExecutionAuthorization(auth.id);
        const reason = `PROVIDER_ACCOUNT_AUTH_ERROR: Selected provider account "${account.id}" is in AUTH_ERROR state.`;
        this.recordRejectionEvent(auth, reason);
        return { executionId, status: 'FAILED', error: reason, errorCode: 'AUTH_ERROR' };
      }

      if (
        account.health_status === 'OFFLINE' ||
        account.health_status === 'UNHEALTHY' ||
        account.health_status === 'DISABLED'
      ) {
        this.repo.invalidateExecutionAuthorization(auth.id);
        const reason = `ROUTING_ACCOUNT_UNAVAILABLE: Selected provider account "${account.id}" has health status "${account.health_status}".`;
        this.recordRejectionEvent(auth, reason);
        return { executionId, status: 'FAILED', error: reason, errorCode: 'RESOURCE_UNAVAILABLE' };
      }

      assignment = this.repo.getAgentAssignment(selectedAssignmentId);
      if (!assignment) {
        this.repo.invalidateExecutionAuthorization(auth.id);
        const reason = `ROUTING_ASSIGNMENT_NOT_FOUND: Selected assignment "${selectedAssignmentId}" was not found in database.`;
        this.recordRejectionEvent(auth, reason);
        return { executionId, status: 'FAILED', error: reason, errorCode: 'RESOURCE_UNAVAILABLE' };
      }

      if (
        assignment.id !== selectedAssignmentId ||
        assignment.project_id !== auth.project_id ||
        assignment.task_id !== auth.task_id ||
        assignment.attempt_id !== auth.attempt_id ||
        assignment.selected_provider_id !== auth.selected_provider_id ||
        assignment.selected_account_id !== account.id ||
        assignment.selected_resource_id !== auth.selected_resource_id ||
        assignment.routing_decision_id !== auth.routing_decision_id
      ) {
        this.repo.invalidateExecutionAuthorization(auth.id);
        const reason = `ROUTING_ASSIGNMENT_SCOPE_MISMATCH: AgentAssignment "${assignment.id}" scope does not match authorization and routing decision.`;
        this.recordRejectionEvent(auth, reason);
        return { executionId, status: 'FAILED', error: reason, errorCode: 'RESOURCE_UNAVAILABLE' };
      }

      if (
        assignment.status === 'COMPLETED' ||
        assignment.status === 'FAILED' ||
        assignment.status === 'CANCELLED' ||
        assignment.status === 'HANDED_OFF'
      ) {
        this.repo.invalidateExecutionAuthorization(auth.id);
        const reason = `ROUTING_ASSIGNMENT_STATUS_INVALID: AgentAssignment "${assignment.id}" is in terminal state "${assignment.status}".`;
        this.recordRejectionEvent(auth, reason);
        return { executionId, status: 'FAILED', error: reason, errorCode: 'RESOURCE_UNAVAILABLE' };
      }
    }

    // 8b. Scheduled Mode Workspace Inspection & Verification (BEFORE claim)
    let inspectedWorkspace: WorktreeInspection | undefined;
    if (mode === 'SCHEDULED') {
      if (!this.gitWorktreeService) {
        return {
          executionId,
          status: 'FAILED',
          errorCode: 'RESOURCE_UNAVAILABLE',
          error: 'SCHEDULED_GIT_WORKTREE_SERVICE_NOT_CONFIGURED: Scheduled dispatch requires a configured GitWorktreeService.',
        };
      }

      if (!assignment || !assignment.selected_worker_slot_id || assignment.selected_worker_slot_id.trim().length === 0) {
        return {
          executionId,
          status: 'FAILED',
          errorCode: 'RESOURCE_UNAVAILABLE',
          error: 'ROUTING_ASSIGNMENT_SLOT_MISSING: Scheduled dispatch requires assignment to have a valid selected_worker_slot_id.',
        };
      }

      const ownershipTuple: WorktreeOwnershipTuple = {
        projectId: auth.project_id,
        taskId: auth.task_id,
        attemptId: auth.attempt_id ?? null,
        assignmentId: assignment.id,
        workerSlotId: assignment.selected_worker_slot_id,
        baseSha: auth.repository_head_sha,
      };

      const inspectResult = await this.gitWorktreeService.inspectWorktree(ownershipTuple);
      if (inspectResult.status !== 'INSPECTED') {
        return {
          executionId,
          status: 'FAILED',
          errorCode: 'RESOURCE_UNAVAILABLE',
          error: `SCHEDULED_WORKSPACE_INSPECTION_FAILED: Worktree inspection failed: ${inspectResult.error}`,
        };
      }

      const insp = inspectResult.inspection;
      if (!insp.exists) {
        return {
          executionId,
          status: 'FAILED',
          errorCode: 'RESOURCE_UNAVAILABLE',
          error: `SCHEDULED_WORKSPACE_MISSING: Worktree directory does not exist: ${insp.managedPath}`,
        };
      }
      if (!insp.registered) {
        return {
          executionId,
          status: 'FAILED',
          errorCode: 'RESOURCE_UNAVAILABLE',
          error: `SCHEDULED_WORKSPACE_NOT_REGISTERED: Worktree "${insp.managedPath}" is not registered in Git porcelain list.`,
        };
      }
      if (!insp.sourceMatch || !insp.headSha || insp.headSha.toLowerCase() !== auth.repository_head_sha.toLowerCase()) {
        return {
          executionId,
          status: 'FAILED',
          errorCode: 'RESOURCE_UNAVAILABLE',
          error: `SCHEDULED_WORKSPACE_HEAD_MISMATCH: Worktree HEAD ("${insp.headSha}") does not match authorized repository HEAD ("${auth.repository_head_sha}").`,
        };
      }
      if (!insp.detached) {
        return {
          executionId,
          status: 'FAILED',
          errorCode: 'RESOURCE_UNAVAILABLE',
          error: `SCHEDULED_WORKSPACE_NOT_DETACHED: Worktree "${insp.managedPath}" is not in detached HEAD state.`,
        };
      }
      if (!insp.locked) {
        return {
          executionId,
          status: 'FAILED',
          errorCode: 'RESOURCE_UNAVAILABLE',
          error: `SCHEDULED_WORKSPACE_NOT_LOCKED: Worktree "${insp.managedPath}" is not locked.`,
        };
      }
      if (!insp.clean) {
        return {
          executionId,
          status: 'FAILED',
          errorCode: 'RESOURCE_UNAVAILABLE',
          error: `SCHEDULED_WORKSPACE_DIRTY: Worktree "${insp.managedPath}" has uncommitted or untracked changes before dispatch.`,
        };
      }

      inspectedWorkspace = insp;
    }

    // 9. Reload and Validate Provider and Resource Enablement
    const resource = this.repo.getProviderResource(auth.selected_resource_id);
    if (!resource) {
      return {
        executionId,
        status: 'FAILED',
        error: `ROUTING_RESOURCE_NOT_FOUND: Selected resource "${auth.selected_resource_id}" not found in database.`,
        errorCode: 'RESOURCE_UNAVAILABLE',
      };
    }

    if (!resource.enabled) {
      return {
        executionId,
        status: 'FAILED',
        error: `ROUTING_RESOURCE_DISABLED: Selected resource "${auth.selected_resource_id}" is disabled.`,
        errorCode: 'RESOURCE_UNAVAILABLE',
      };
    }

    if (account && resource.provider_account_id != null && resource.provider_account_id !== account.id) {
      this.repo.invalidateExecutionAuthorization(auth.id);
      const reason = `ROUTING_RESOURCE_ACCOUNT_MISMATCH: Selected resource "${resource.id}" requires account "${resource.provider_account_id}" but routing selected account "${account.id}".`;
      this.recordRejectionEvent(auth, reason);
      return {
        executionId,
        status: 'FAILED',
        error: reason,
        errorCode: 'RESOURCE_UNAVAILABLE',
      };
    }

    const provider = this.repo.getProvider(resource.provider_id);
    if (!provider) {
      return {
        executionId,
        status: 'FAILED',
        error: `ROUTING_PROVIDER_NOT_FOUND: Parent provider "${resource.provider_id}" not found in database.`,
        errorCode: 'RESOURCE_UNAVAILABLE',
      };
    }

    if (!provider.enabled) {
      return {
        executionId,
        status: 'FAILED',
        error: `ROUTING_PROVIDER_DISABLED: Parent provider "${resource.provider_id}" is disabled.`,
        errorCode: 'RESOURCE_UNAVAILABLE',
      };
    }

    if (resource.provider_id !== auth.selected_provider_id) {
      return {
        executionId,
        status: 'FAILED',
        error: `ROUTING_PROVIDER_MISMATCH: Resource provider_id "${resource.provider_id}" differs from authorized provider "${auth.selected_provider_id}".`,
        errorCode: 'RESOURCE_UNAVAILABLE',
      };
    }

    // 10. Validate Registered Provider Adapter & Outcome Compatibility
    if (!this.providerRegistry.has(auth.selected_provider_id)) {
      return {
        executionId,
        status: 'FAILED',
        error: `ROUTING_ADAPTER_UNREGISTERED: Provider adapter "${auth.selected_provider_id}" is not registered in ProviderRegistry.`,
        errorCode: 'RESOURCE_UNAVAILABLE',
      };
    }

    const adapter = this.providerRegistry.resolve(auth.selected_provider_id);
    if (provider.adapter_type !== adapter.adapterType) {
      this.repo.invalidateExecutionAuthorization(auth.id);
      const reason = `ROUTING_ADAPTER_TYPE_MISMATCH: Provider adapter_type "${provider.adapter_type}" does not match resolved adapter type "${adapter.adapterType}".`;
      this.recordRejectionEvent(auth, reason);
      return {
        executionId,
        status: 'FAILED',
        error: reason,
        errorCode: 'RESOURCE_UNAVAILABLE',
      };
    }

    if (routingOutcome === 'SELECTED' && adapter.adapterType === 'MANUAL_BRIDGE') {
      return {
        executionId,
        status: 'FAILED',
        error:
          'ROUTING_OUTCOME_ADAPTER_MISMATCH: Decision outcome is SELECTED but resolved adapter is MANUAL_BRIDGE.',
        errorCode: 'RESOURCE_UNAVAILABLE',
      };
    }

    if (routingOutcome === 'MANUAL_HANDOFF_REQUIRED' && adapter.adapterType !== 'MANUAL_BRIDGE') {
      return {
        executionId,
        status: 'FAILED',
        error:
          'ROUTING_OUTCOME_ADAPTER_MISMATCH: Decision outcome is MANUAL_HANDOFF_REQUIRED but resolved adapter is not MANUAL_BRIDGE.',
        errorCode: 'RESOURCE_UNAVAILABLE',
      };
    }

    // 11. Strict Canonical Payload Schema Validation and Integrity of Canonical Hashes
    if (!auth.canonical_payload_json || auth.canonical_payload_json.trim() === '') {
      this.repo.invalidateExecutionAuthorization(auth.id);
      this.recordRejectionEvent(auth, 'EXECUTION_AUTHORIZATION_PAYLOAD_CORRUPT: Canonical execution payload JSON is missing.');
      return {
        executionId,
        status: 'FAILED',
        error: 'EXECUTION_AUTHORIZATION_PAYLOAD_CORRUPT: Canonical execution payload JSON is missing.',
        errorCode: 'PROTOCOL_INVALID',
      };
    }

    let parsedCanonicalPayload: CanonicalExecutionPayload;
    try {
      const rawParsed = JSON.parse(auth.canonical_payload_json);
      const schemaValidation = CanonicalExecutionPayloadSchema.safeParse(rawParsed);
      if (!schemaValidation.success) {
        this.repo.invalidateExecutionAuthorization(auth.id);
        this.recordRejectionEvent(auth, 'EXECUTION_AUTHORIZATION_PAYLOAD_CORRUPT: Canonical execution payload schema invalid.');
        return {
          executionId,
          status: 'FAILED',
          error: 'EXECUTION_AUTHORIZATION_PAYLOAD_CORRUPT: Canonical execution payload schema invalid.',
          errorCode: 'PROTOCOL_INVALID',
        };
      }
      parsedCanonicalPayload = schemaValidation.data;
    } catch {
      this.repo.invalidateExecutionAuthorization(auth.id);
      this.recordRejectionEvent(auth, 'EXECUTION_AUTHORIZATION_PAYLOAD_CORRUPT: Canonical execution payload malformed JSON.');
      return {
        executionId,
        status: 'FAILED',
        error: 'EXECUTION_AUTHORIZATION_PAYLOAD_CORRUPT: Canonical execution payload malformed JSON.',
        errorCode: 'PROTOCOL_INVALID',
      };
    }

    const recomputedContextHash = computeContextManifestHash(parsedContextFiles);
    if (recomputedContextHash !== auth.context_manifest_hash) {
      this.repo.invalidateExecutionAuthorization(auth.id);
      this.recordRejectionEvent(auth, 'EXECUTION_AUTHORIZATION_HASH_MISMATCH: Context manifest hash recomputation failed.');
      return {
        executionId,
        status: 'FAILED',
        error: 'EXECUTION_AUTHORIZATION_HASH_MISMATCH: Context manifest hash recomputation failed.',
        errorCode: 'PROTOCOL_INVALID',
      };
    }

    const effectiveConstraints: string[] = [
      ...(task.constraints ?? []),
      ...(managerData.constraints ?? []),
    ];

    if (
      parsedCanonicalPayload.constraints.length !== effectiveConstraints.length ||
      !parsedCanonicalPayload.constraints.every((val, idx) => val === effectiveConstraints[idx])
    ) {
      this.repo.invalidateExecutionAuthorization(auth.id);
      this.recordRejectionEvent(
        auth,
        'EXECUTION_AUTHORIZATION_HASH_MISMATCH: Canonical execution payload constraints mismatch.'
      );
      return {
        executionId,
        status: 'FAILED',
        error: 'EXECUTION_AUTHORIZATION_HASH_MISMATCH: Canonical execution payload constraints mismatch.',
        errorCode: 'PROTOCOL_INVALID',
      };
    }

    const recomputedPayload = computeCanonicalPayload({
      projectId: auth.project_id,
      taskId: auth.task_id,
      attemptId: auth.attempt_id,
      taskTitle: task.title,
      taskDescription: task.description,
      acceptanceCriteria: task.acceptance_criteria ?? [],
      constraints: effectiveConstraints,
      instructions: parsedInstructions,
      contextFiles: parsedContextFiles,
      verificationCommands: parsedCanonicalPayload.verificationCommands,
      managerMessageId: auth.manager_message_id,
      managerPayloadHash: auth.manager_payload_hash,
    });
    const recomputedPayloadHash = computePayloadHash(recomputedPayload);
    if (recomputedPayloadHash !== auth.instruction_payload_hash) {
      this.repo.invalidateExecutionAuthorization(auth.id);
      this.recordRejectionEvent(auth, 'EXECUTION_AUTHORIZATION_HASH_MISMATCH: Canonical execution payload hash recomputation failed.');
      return {
        executionId,
        status: 'FAILED',
        error: 'EXECUTION_AUTHORIZATION_HASH_MISMATCH: Canonical execution payload hash recomputation failed.',
        errorCode: 'PROTOCOL_INVALID',
      };
    }

    // 11b. Pre-claim cancellation check for scheduled execution
    if (mode === 'SCHEDULED' && control?.cancelRequested) {
      return {
        executionId,
        status: 'CANCELLED',
        errorCode: 'CANCELLED',
        error: 'Execution was cancelled during scheduled preparation.',
      };
    }

    // 12. ATOMIC CLAIM: Consume authorization before execution
    const claimed = this.repo.claimExecutionAuthorization(authorizationId, nowIso);
    if (!claimed) {
      // Re-read current status to explain why claim failed
      const currentAuth = this.repo.getExecutionAuthorization(authorizationId);
      if (!currentAuth || currentAuth.status === 'DISPATCHED') {
        return {
          executionId,
          status: 'FAILED',
          error: `EXECUTION_AUTHORIZATION_ALREADY_DISPATCHED: Authorization "${authorizationId}" was already claimed by another execution.`,
        };
      }
      return {
        executionId,
        status: 'FAILED',
        error: `EXECUTION_AUTHORIZATION_CLAIM_FAILED: Could not claim authorization "${authorizationId}" (status: ${currentAuth.status}).`,
      };
    }

    // 13. Construct RuntimeExecutionBinding & Reconstruct AgentExecutionRequest
    let runtimeBinding: RuntimeExecutionBinding | undefined;
    if (routingOutcome === 'SELECTED' && account && assignment) {
      runtimeBinding = {
        authorizationId: auth.id,
        routingDecisionId: auth.routing_decision_id,
        assignmentId: assignment.id,
        providerId: auth.selected_provider_id,
        accountId: account.id,
        resourceId: auth.selected_resource_id,
        adapterType: adapter.adapterType,
        modelName: resource.model_name,
        accountAuthMode: account.auth_mode,
        profileRef: account.profile_ref ?? null,
      };

      if (mode === 'SCHEDULED') {
        runtimeBinding.executionId = executionId;
        if (inspectedWorkspace && assignment.selected_worker_slot_id) {
          runtimeBinding.workspace = {
            workerSlotId: assignment.selected_worker_slot_id,
            ownershipDigest: inspectedWorkspace.ownershipDigest,
            sourceSha: auth.repository_head_sha,
            workingDirectory: inspectedWorkspace.managedPath,
          };
        }
      }
    }

    const request: AgentExecutionRequest = {
      projectId: auth.project_id,
      taskId: auth.task_id,
      attemptId: auth.attempt_id ?? undefined,
      instructions: parsedInstructions,
      contextFiles: parsedContextFiles,
      runtimeBinding,
    };

    // 14. Persist Dispatched Audit Event
    if (this.eventService) {
      this.eventService.record(
        auth.project_id,
        'EXECUTION_AUTHORIZATION_DISPATCHED',
        `Execution authorization ${authorizationId} dispatched to provider ${auth.selected_provider_id}`,
        {
          authorizationId,
          projectId: auth.project_id,
          taskId: auth.task_id,
          attemptId: auth.attempt_id,
          taskRevision: auth.task_revision,
          baseSha: auth.base_sha,
          repositoryHeadSha: auth.repository_head_sha,
          managerMessageId: auth.manager_message_id,
          managerPayloadHash: auth.manager_payload_hash,
          routingDecisionId: auth.routing_decision_id,
          selectedResourceId: auth.selected_resource_id,
          selectedProviderId: auth.selected_provider_id,
          instructionPayloadHash: auth.instruction_payload_hash,
          contextManifestHash: auth.context_manifest_hash,
          status: 'DISPATCHED',
        },
        auth.task_id
      );
    }

    // 15. Emit PROVIDER_RUNTIME_EXECUTION_BOUND event
    if (this.eventService && runtimeBinding) {
      const boundPayload: Record<string, unknown> = {
        authorizationId: runtimeBinding.authorizationId,
        routingDecisionId: runtimeBinding.routingDecisionId,
        assignmentId: runtimeBinding.assignmentId,
        projectId: auth.project_id,
        taskId: auth.task_id,
        attemptId: auth.attempt_id,
        providerId: runtimeBinding.providerId,
        accountId: runtimeBinding.accountId,
        resourceId: runtimeBinding.resourceId,
        adapterType: runtimeBinding.adapterType,
        modelName: runtimeBinding.modelName,
        profileRef: runtimeBinding.profileRef,
      };

      if (runtimeBinding.workspace) {
        boundPayload.workerSlotId = runtimeBinding.workspace.workerSlotId;
        boundPayload.workspaceOwnershipDigest = runtimeBinding.workspace.ownershipDigest;
        boundPayload.workspaceSourceSha = runtimeBinding.workspace.sourceSha;
      }

      this.eventService.record(
        auth.project_id,
        'PROVIDER_RUNTIME_EXECUTION_BOUND',
        `Runtime execution bound for task ${auth.task_id} to provider ${auth.selected_provider_id}, account ${runtimeBinding.accountId}, model ${runtimeBinding.modelName}`,
        boundPayload,
        auth.task_id
      );
    }

    // 15b. Post-claim / pre-adapter cancellation check for scheduled execution
    if (mode === 'SCHEDULED' && control?.cancelRequested) {
      return {
        executionId,
        status: 'CANCELLED',
        errorCode: 'CANCELLED',
        error: 'Execution was cancelled before adapter execution.',
      };
    }

    if (mode === 'SCHEDULED' && control) {
      control.phase = 'EXECUTING';
      control.adapter = adapter;
    }

    // 16. Execute the selected provider exactly once (NO retry, NO failover on failure)
    let result: AgentExecutionResult;
    try {
      result = await adapter.execute(request);
      if (mode === 'SCHEDULED') {
        result = {
          ...result,
          executionId,
        };
      }
    } catch (err: any) {
      result = {
        executionId,
        status: 'FAILED',
        errorCode: 'EXECUTION_FAILED',
        error: `ADAPTER_EXECUTION_THREW: ${err.message}`,
      };
    }

    // 17. Emit PROVIDER_RUNTIME_EXECUTION_RESULT event
    if (this.eventService && runtimeBinding) {
      this.eventService.record(
        auth.project_id,
        'PROVIDER_RUNTIME_EXECUTION_RESULT',
        `Runtime execution ${result.executionId} finished with status ${result.status} for task ${auth.task_id}`,
        {
          executionId: result.executionId,
          authorizationId: auth.id,
          assignmentId: runtimeBinding.assignmentId,
          providerId: runtimeBinding.providerId,
          accountId: runtimeBinding.accountId,
          resourceId: runtimeBinding.resourceId,
          status: result.status,
          errorCode: result.errorCode ?? null,
          stdoutEvidenceId: result.stdoutEvidenceId ?? null,
          stderrEvidenceId: result.stderrEvidenceId ?? null,
        },
        auth.task_id
      );
    }

    return result;
    } finally {
      if (mode === 'SCHEDULED') {
        this.activeDispatches.delete(authorizationId);
      }
    }
  }

  private recordRejectionEvent(auth: ExecutionAuthorization, reason: string): void {
    if (!this.eventService) return;
    this.eventService.record(
      auth.project_id,
      'EXECUTION_AUTHORIZATION_REJECTED',
      `Execution authorization rejected during dispatch for task ${auth.task_id}: ${reason}`,
      {
        authorizationId: auth.id,
        projectId: auth.project_id,
        taskId: auth.task_id,
        attemptId: auth.attempt_id,
        managerMessageId: auth.manager_message_id,
        routingDecisionId: auth.routing_decision_id,
        reason,
        instructionPayloadHash: auth.instruction_payload_hash,
        contextManifestHash: auth.context_manifest_hash,
        status: 'INVALIDATED',
      },
      auth.task_id
    );
  }
}
