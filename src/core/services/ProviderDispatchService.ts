import crypto from 'crypto';
import { ProviderRegistry } from '../adapters/ProviderRegistry';
import { Repository } from '../database/repositories';
import { AgentExecutionRequest, AgentExecutionResult } from '../adapters/ProviderAdapter';

export class ProviderDispatchService {
  constructor(
    private providerRegistry: ProviderRegistry,
    private repo: Repository
  ) {}

  /**
   * Dispatches task execution according to an authoritative, durably persisted RoutingDecision event.
   * Validates scope, state enablement, and adapter mappings without re-probing telemetry.
   * Does NOT perform post-dispatch retry or failover.
   */
  public async dispatch(
    decisionId: string,
    request: AgentExecutionRequest
  ): Promise<AgentExecutionResult> {
    const executionId = crypto.randomUUID();

    // 1. Load the authoritative PROVIDER_ROUTING_DECISION event from durable storage
    const event = this.repo.getRoutingDecisionEvent(decisionId);
    if (!event) {
      return {
        executionId,
        status: 'FAILED',
        error: `ROUTING_DECISION_NOT_FOUND: Durable routing decision "${decisionId}" was not found in database.`,
      };
    }

    if (event.type !== 'PROVIDER_ROUTING_DECISION') {
      return {
        executionId,
        status: 'FAILED',
        error: `ROUTING_DECISION_TYPE_MISMATCH: Event "${decisionId}" has type "${event.type}", expected PROVIDER_ROUTING_DECISION.`,
      };
    }

    const payload = event.structured_payload as Record<string, unknown>;

    // 2. Validate Scope Binding: projectId, taskId, attemptId
    if (payload.projectId !== request.projectId) {
      return {
        executionId,
        status: 'FAILED',
        error: `ROUTING_DECISION_SCOPE_MISMATCH: Project ID mismatch (persisted decision: "${payload.projectId}", request: "${request.projectId}").`,
      };
    }

    if (payload.taskId !== request.taskId) {
      return {
        executionId,
        status: 'FAILED',
        error: `ROUTING_DECISION_SCOPE_MISMATCH: Task ID mismatch (persisted decision: "${payload.taskId}", request: "${request.taskId}").`,
      };
    }

    const persistedAttempt = (payload.attemptId as string | null | undefined) ?? null;
    const requestAttempt = request.attemptId ?? null;
    if (persistedAttempt !== requestAttempt) {
      return {
        executionId,
        status: 'FAILED',
        error: `ROUTING_DECISION_SCOPE_MISMATCH: Attempt ID mismatch (persisted decision: "${persistedAttempt}", request: "${requestAttempt}").`,
      };
    }

    // 3. Validate Outcome Dispatchability
    const outcome = payload.outcome as string;
    if (outcome !== 'SELECTED' && outcome !== 'MANUAL_HANDOFF_REQUIRED') {
      return {
        executionId,
        status: 'FAILED',
        error: `ROUTING_DECISION_NOT_DISPATCHABLE: Routing decision outcome "${outcome}" is not dispatchable (${payload.reason ?? 'ineligible'}).`,
      };
    }

    const selectedResourceId = payload.selectedResourceId as string | undefined;
    const selectedProviderId = payload.selectedProviderId as string | undefined;

    if (!selectedResourceId || !selectedProviderId) {
      return {
        executionId,
        status: 'FAILED',
        error:
          'ROUTING_DECISION_INVALID: Persisted routing decision missing selectedResourceId or selectedProviderId.',
      };
    }

    // 4. Reload and validate ProviderResource state
    const resource = this.repo.getProviderResource(selectedResourceId);
    if (!resource) {
      return {
        executionId,
        status: 'FAILED',
        error: `ROUTING_RESOURCE_NOT_FOUND: Selected resource "${selectedResourceId}" not found in database.`,
      };
    }

    if (!resource.enabled) {
      return {
        executionId,
        status: 'FAILED',
        error: `ROUTING_RESOURCE_DISABLED: Selected resource "${selectedResourceId}" is disabled.`,
      };
    }

    // 5. Reload and validate parent Provider state
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

    if (resource.provider_id !== selectedProviderId) {
      return {
        executionId,
        status: 'FAILED',
        error: `ROUTING_PROVIDER_MISMATCH: Resource provider_id "${resource.provider_id}" differs from selectedProviderId "${selectedProviderId}".`,
      };
    }

    // 6. Validate registered ProviderAdapter
    if (!this.providerRegistry.has(selectedProviderId)) {
      return {
        executionId,
        status: 'FAILED',
        error: `ROUTING_ADAPTER_UNREGISTERED: Provider adapter "${selectedProviderId}" is not registered in ProviderRegistry.`,
      };
    }

    const adapter = this.providerRegistry.resolve(selectedProviderId);

    // 7. Validate outcome and adapter type compatibility
    if (outcome === 'SELECTED' && adapter.adapterType === 'MANUAL_BRIDGE') {
      return {
        executionId,
        status: 'FAILED',
        error:
          'ROUTING_OUTCOME_ADAPTER_MISMATCH: Decision outcome is SELECTED but resolved adapter is MANUAL_BRIDGE.',
      };
    }

    if (outcome === 'MANUAL_HANDOFF_REQUIRED' && adapter.adapterType !== 'MANUAL_BRIDGE') {
      return {
        executionId,
        status: 'FAILED',
        error:
          'ROUTING_OUTCOME_ADAPTER_MISMATCH: Decision outcome is MANUAL_HANDOFF_REQUIRED but resolved adapter is not MANUAL_BRIDGE.',
      };
    }

    // 8. Execute the selected provider exactly once (NO re-probing, NO re-routing on failure)
    return adapter.execute(request);
  }
}
