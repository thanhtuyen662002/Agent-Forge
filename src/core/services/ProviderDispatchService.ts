import crypto from 'crypto';
import { ProviderRegistry } from '../adapters/ProviderRegistry';
import { Repository } from '../database/repositories';
import { EventService } from './EventService';
import { GitService } from './GitService';
import { AgentExecutionRequest, AgentExecutionResult } from '../adapters/ProviderAdapter';
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

    // 2. Validate Project, Task, and Attempt Existence & Revision Binding
    const project = this.repo.getProject(auth.project_id);
    if (!project) {
      return {
        executionId,
        status: 'FAILED',
        error: `EXECUTION_AUTHORIZATION_PROJECT_NOT_FOUND: Project "${auth.project_id}" not found.`,
      };
    }

    const task = this.repo.getTask(auth.task_id);
    if (!task) {
      return {
        executionId,
        status: 'FAILED',
        error: `EXECUTION_AUTHORIZATION_TASK_NOT_FOUND: Task "${auth.task_id}" not found.`,
      };
    }

    if (task.revision_count !== auth.task_revision) {
      return {
        executionId,
        status: 'FAILED',
        error: `EXECUTION_AUTHORIZATION_STALE_TASK_REVISION: Task revision (${task.revision_count}) differs from authorized revision (${auth.task_revision}).`,
      };
    }

    if (auth.attempt_id) {
      const attempt = this.repo.getTaskAttempt(auth.attempt_id);
      if (!attempt || attempt.task_id !== auth.task_id) {
        return {
          executionId,
          status: 'FAILED',
          error: `EXECUTION_AUTHORIZATION_ATTEMPT_MISMATCH: TaskAttempt "${auth.attempt_id}" does not belong to task "${auth.task_id}".`,
        };
      }
    }

    // 3. Validate Git Base SHA Authority
    if (task.base_sha && task.base_sha !== auth.base_sha) {
      return {
        executionId,
        status: 'FAILED',
        error: `EXECUTION_AUTHORIZATION_STALE_GIT_BASE: Current task base SHA "${task.base_sha}" differs from authorized base SHA "${auth.base_sha}".`,
      };
    }

    // 4. Validate Durable Routing Decision Binding
    const routingEvent = this.repo.getRoutingDecisionEvent(auth.routing_decision_id);
    if (!routingEvent) {
      return {
        executionId,
        status: 'FAILED',
        error: `EXECUTION_AUTHORIZATION_ROUTING_NOT_FOUND: Routing decision "${auth.routing_decision_id}" was not found.`,
      };
    }

    const routingPayload = routingEvent.structured_payload as Record<string, unknown>;
    if (routingPayload.projectId !== auth.project_id || routingPayload.taskId !== auth.task_id) {
      return {
        executionId,
        status: 'FAILED',
        error: 'EXECUTION_AUTHORIZATION_ROUTING_SCOPE_MISMATCH: Routing decision scope does not match authorization scope.',
      };
    }

    const routingOutcome = routingPayload.outcome as string;
    if (routingOutcome !== 'SELECTED' && routingOutcome !== 'MANUAL_HANDOFF_REQUIRED') {
      return {
        executionId,
        status: 'FAILED',
        error: `EXECUTION_AUTHORIZATION_ROUTING_INELIGIBLE: Routing outcome "${routingOutcome}" is not executable.`,
      };
    }

    // 5. Reload and Validate Provider and Resource Enablement
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

    // 6. Validate Registered Provider Adapter & Outcome Compatibility
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

    // 7. Verify Integrity of Canonical Hashes
    const parsedInstructions: string[] = JSON.parse(auth.canonical_instructions_json);
    const parsedContextFiles: string[] = JSON.parse(auth.context_files_json);

    const recomputedContextHash = computeContextManifestHash(parsedContextFiles);
    if (recomputedContextHash !== auth.context_manifest_hash) {
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
    });
    const recomputedPayloadHash = computePayloadHash(recomputedPayload);
    if (recomputedPayloadHash !== auth.instruction_payload_hash) {
      return {
        executionId,
        status: 'FAILED',
        error: 'EXECUTION_AUTHORIZATION_HASH_MISMATCH: Canonical execution payload hash recomputation failed.',
      };
    }

    // 8. ATOMIC CLAIM: Consume authorization before execution
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

    // 9. Reconstruct AgentExecutionRequest from approved durable state (caller supplies NO instructions)
    const request: AgentExecutionRequest = {
      projectId: auth.project_id,
      taskId: auth.task_id,
      attemptId: auth.attempt_id ?? undefined,
      instructions: parsedInstructions,
      contextFiles: parsedContextFiles,
    };

    // 10. Persist Dispatched Audit Event
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

    // 11. Execute the selected provider exactly once (NO retry, NO failover on failure)
    return adapter.execute(request);
  }
}
