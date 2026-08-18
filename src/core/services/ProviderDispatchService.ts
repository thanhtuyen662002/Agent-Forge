import crypto from 'crypto';
import { ProviderRegistry } from '../adapters/ProviderRegistry';
import { RoutingDecision } from './ProviderRoutingService';
import { AgentExecutionRequest, AgentExecutionResult } from '../adapters/ProviderAdapter';

export class ProviderDispatchService {
  constructor(private providerRegistry: ProviderRegistry) {}

  /**
   * Dispatches task execution to the single selected provider adapter according to an approved RoutingDecision.
   * Does NOT perform post-dispatch retry or fallback.
   */
  public async dispatch(
    decision: RoutingDecision,
    request: AgentExecutionRequest
  ): Promise<AgentExecutionResult> {
    if (decision.outcome === 'SELECTED') {
      if (!decision.selectedProviderId) {
        return {
          executionId: crypto.randomUUID(),
          status: 'FAILED',
          error: 'DISPATCH_ERROR: Decision marked as SELECTED but selectedProviderId is missing.',
        };
      }
      const adapter = this.providerRegistry.resolve(decision.selectedProviderId);
      // Execute the selected provider exactly once
      return adapter.execute(request);
    }

    if (decision.outcome === 'MANUAL_HANDOFF_REQUIRED') {
      if (!decision.selectedProviderId) {
        return {
          executionId: crypto.randomUUID(),
          status: 'FAILED',
          error:
            'DISPATCH_ERROR: Decision marked as MANUAL_HANDOFF_REQUIRED but selectedProviderId is missing.',
        };
      }
      const adapter = this.providerRegistry.resolve(decision.selectedProviderId);
      // Execute Manual Bridge exactly once -> returns AWAITING_OWNER
      return adapter.execute(request);
    }

    if (decision.outcome === 'NO_ELIGIBLE_PROVIDER') {
      return {
        executionId: crypto.randomUUID(),
        status: 'FAILED',
        error: `NO_ELIGIBLE_PROVIDER: ${decision.reason}`,
      };
    }

    if (decision.outcome === 'NEEDS_OWNER') {
      return {
        executionId: crypto.randomUUID(),
        status: 'FAILED',
        error: `NEEDS_OWNER: ${decision.reason}`,
      };
    }

    return {
      executionId: crypto.randomUUID(),
      status: 'FAILED',
      error: `UNKNOWN_ROUTING_OUTCOME: Outcome "${(decision as any).outcome}" is unrecognized.`,
    };
  }
}
