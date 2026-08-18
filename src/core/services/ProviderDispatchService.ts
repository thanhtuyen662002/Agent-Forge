import crypto from 'crypto';
import { ProviderRegistry } from '../adapters/ProviderRegistry';
import { Repository } from '../database/repositories';
import { EventService } from './EventService';
import { GitService } from './GitService';
import { ProtocolParser } from '../protocol/parser';
import { AgentExecutionRequest, AgentExecutionResult } from '../adapters/ProviderAdapter';
import { ExecutionAuthorization } from '../types/domain';
import {
  computeCanonicalPayload,
  computePayloadHash,
  computeContextManifestHash,
} from './ExecutionAuthorizationService';

export class ProviderDispatchService {
  constructor(
    private providerRegistry: ProviderRegistry,
    private repo: Repository,
    private eventService?: EventService
  ) {}

  /**
   * Dispatches task execution bound to an immutable, durably persisted ExecutionAuthorization.
   * Atomically claims the authorization to prevent duplicate/concurrent executions.
   * Derives all execution instructions internally from approved durable state.
   */
  public async dispatch(authorizationId: string): Promise<AgentExecutionResult> {
    const executionId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

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

    // 7. Reload and Validate Provider and Resource Enablement
    const resource = this.repo.getProviderResource(auth.selected_resource_id);
    if (!resource) {
      return {
        executionId,
        status: 'FAILED',
        error: `ROUTING_RESOURCE_NOT_FOUND: Selected resource "${auth.selected_resource_id}" not found in database.`,
      };
    }

    if (!resource.enabled) {
      return {
        executionId,
        status: 'FAILED',
        error: `ROUTING_RESOURCE_DISABLED: Selected resource "${auth.selected_resource_id}" is disabled.`,
      };
    }

    const provider = this.repo.getProvider(resource.provider_id);
    if (!provider) {
      return {
        executionId,
        status: 'FAILED',
        error: `ROUTING_PROVIDER_NOT_FOUND: Parent provider "${resource.provider_id}" not found in database.`,
      };
    }

    if (!provider.enabled) {
      return {
        executionId,
        status: 'FAILED',
        error: `ROUTING_PROVIDER_DISABLED: Parent provider "${resource.provider_id}" is disabled.`,
      };
    }

    if (resource.provider_id !== auth.selected_provider_id) {
      return {
        executionId,
        status: 'FAILED',
        error: `ROUTING_PROVIDER_MISMATCH: Resource provider_id "${resource.provider_id}" differs from authorized provider "${auth.selected_provider_id}".`,
      };
    }

    // 8. Validate Registered Provider Adapter & Outcome Compatibility
    if (!this.providerRegistry.has(auth.selected_provider_id)) {
      return {
        executionId,
        status: 'FAILED',
        error: `ROUTING_ADAPTER_UNREGISTERED: Provider adapter "${auth.selected_provider_id}" is not registered in ProviderRegistry.`,
      };
    }

    const adapter = this.providerRegistry.resolve(auth.selected_provider_id);
    if (routingOutcome === 'SELECTED' && adapter.adapterType === 'MANUAL_BRIDGE') {
      return {
        executionId,
        status: 'FAILED',
        error:
          'ROUTING_OUTCOME_ADAPTER_MISMATCH: Decision outcome is SELECTED but resolved adapter is MANUAL_BRIDGE.',
      };
    }

    if (routingOutcome === 'MANUAL_HANDOFF_REQUIRED' && adapter.adapterType !== 'MANUAL_BRIDGE') {
      return {
        executionId,
        status: 'FAILED',
        error:
          'ROUTING_OUTCOME_ADAPTER_MISMATCH: Decision outcome is MANUAL_HANDOFF_REQUIRED but resolved adapter is not MANUAL_BRIDGE.',
      };
    }

    // 9. Verify Integrity of Canonical Hashes
    const recomputedContextHash = computeContextManifestHash(parsedContextFiles);
    if (recomputedContextHash !== auth.context_manifest_hash) {
      this.repo.invalidateExecutionAuthorization(auth.id);
      this.recordRejectionEvent(auth, 'EXECUTION_AUTHORIZATION_HASH_MISMATCH: Context manifest hash recomputation failed.');
      return {
        executionId,
        status: 'FAILED',
        error: 'EXECUTION_AUTHORIZATION_HASH_MISMATCH: Context manifest hash recomputation failed.',
      };
    }

    const recomputedPayload = computeCanonicalPayload({
      projectId: auth.project_id,
      taskId: auth.task_id,
      attemptId: auth.attempt_id,
      taskTitle: task.title,
      taskDescription: task.description,
      acceptanceCriteria: task.acceptance_criteria ?? [],
      constraints: task.constraints ?? [],
      instructions: parsedInstructions,
      contextFiles: parsedContextFiles,
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
      };
    }

    // 10. ATOMIC CLAIM: Consume authorization before execution
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

    // 11. Reconstruct AgentExecutionRequest from approved durable state (caller supplies NO instructions)
    const request: AgentExecutionRequest = {
      projectId: auth.project_id,
      taskId: auth.task_id,
      attemptId: auth.attempt_id ?? undefined,
      instructions: parsedInstructions,
      contextFiles: parsedContextFiles,
    };

    // 12. Persist Dispatched Audit Event
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

    // 13. Execute the selected provider exactly once (NO retry, NO failover on failure)
    return adapter.execute(request);
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
