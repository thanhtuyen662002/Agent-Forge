import {
  ProviderDispatchExecutionResult,
} from './ProviderDispatchService';
import {
  ExecutionFailureClassifier,
  ProviderFailureCategory,
} from './ExecutionFailureClassifier';
import {
  FailoverPolicyParseResult,
  EnabledFailoverPolicyV1,
} from '../types/domain';

export type ProviderAccountHealthAction =
  | 'NO_MUTATION'
  | 'RECORD_SUCCESS'
  | 'RECORD_RATE_LIMITED'
  | 'RECORD_QUOTA_EXHAUSTED'
  | 'RECORD_AUTH_ERROR';

export type HealthActionCategory =
  | 'SUCCESS'
  | ProviderFailureCategory
  | 'AWAITING_OWNER'
  | null;

export interface ProviderAccountHealthActionPlan {
  action: ProviderAccountHealthAction;
  accountId: string | null;
  executionId: string | null;
  authorizationId: string | null;
  category: HealthActionCategory;
  cooldownDurationMs: number | null;
  reason: string;
}

export interface FailureHealthMutationPolicyParams {
  providerResult: ProviderDispatchExecutionResult;
  policyResult?: FailoverPolicyParseResult | null;
}

export class FailureHealthMutationPolicyService {
  /**
   * Pure, deterministic policy service that interprets execution outcomes and
   * classifies failure evidence into a proposed ProviderAccount health action plan.
   *
   * NEVER mutates SQLite state, launches execution, performs database writes,
   * inspects secrets, or relies on system clocks.
   *
   * @param params Input containing providerResult and optional typed policyResult.
   * @returns Proposed ProviderAccountHealthActionPlan.
   */
  public static evaluate(
    params: FailureHealthMutationPolicyParams
  ): ProviderAccountHealthActionPlan {
    const { providerResult, policyResult } = params;

    if (!providerResult || typeof providerResult !== 'object') {
      return {
        action: 'NO_MUTATION',
        accountId: null,
        executionId: null,
        authorizationId: null,
        category: null,
        cooldownDurationMs: null,
        reason: 'INVALID_INPUT: providerResult is missing or invalid.',
      };
    }

    const provenance = providerResult.providerExecutionProvenance;

    // 1. Precondition: Trusted provider provenance required
    if (!provenance || typeof provenance !== 'object') {
      return {
        action: 'NO_MUTATION',
        accountId: null,
        executionId: providerResult.executionId ?? null,
        authorizationId: null,
        category: null,
        cooldownDurationMs: null,
        reason: 'PROVENANCE_MISSING: Execution has no trusted provider provenance.',
      };
    }

    // 2. Validate provenance structure & coherence
    if (provenance.version !== 1) {
      return {
        action: 'NO_MUTATION',
        accountId: null,
        executionId: providerResult.executionId ?? null,
        authorizationId: provenance.authorizationId ?? null,
        category: null,
        cooldownDurationMs: null,
        reason: 'MALFORMED_PROVENANCE: Provenance version must be 1.',
      };
    }

    if (provenance.source !== 'PROVIDER_DISPATCH_SERVICE') {
      return {
        action: 'NO_MUTATION',
        accountId: null,
        executionId: providerResult.executionId ?? null,
        authorizationId: provenance.authorizationId ?? null,
        category: null,
        cooldownDurationMs: null,
        reason: 'MALFORMED_PROVENANCE: Provenance source must be PROVIDER_DISPATCH_SERVICE.',
      };
    }

    if (provenance.executionId !== providerResult.executionId) {
      return {
        action: 'NO_MUTATION',
        accountId: null,
        executionId: providerResult.executionId ?? null,
        authorizationId: provenance.authorizationId ?? null,
        category: null,
        cooldownDurationMs: null,
        reason: 'INCOHERENT_EXECUTION_ID: Provenance executionId does not match result executionId.',
      };
    }

    // 3. Validate non-empty account target (no synthetic inference)
    if (
      !provenance.accountId ||
      typeof provenance.accountId !== 'string' ||
      provenance.accountId.trim() === ''
    ) {
      return {
        action: 'NO_MUTATION',
        accountId: null,
        executionId: provenance.executionId,
        authorizationId: provenance.authorizationId,
        category: null,
        cooldownDurationMs: null,
        reason: 'NULL_OR_EMPTY_ACCOUNT_ID: Provenance has no valid non-empty accountId target.',
      };
    }

    const accountId = provenance.accountId;
    const executionId = provenance.executionId;
    const authorizationId = provenance.authorizationId;

    // 4. Handle adapter invocation THREW (internal adapter crash, not remote provider fault)
    if (provenance.adapterInvocation === 'THREW') {
      if (providerResult.status === 'COMPLETED') {
        return {
          action: 'NO_MUTATION',
          accountId,
          executionId,
          authorizationId,
          category: 'UNKNOWN',
          cooldownDurationMs: null,
          reason: 'INCOHERENT_PROVENANCE_RESULT: Incoherent adapterInvocation THREW with status COMPLETED.',
        };
      }
      return {
        action: 'NO_MUTATION',
        accountId,
        executionId,
        authorizationId,
        category: 'UNKNOWN',
        cooldownDurationMs: null,
        reason: 'ADAPTER_THROW: Adapter execution threw an unhandled exception; no provider account health mutation.',
      };
    }

    // 5. Handle adapter invocation RETURNED
    if (providerResult.status === 'COMPLETED') {
      return {
        action: 'RECORD_SUCCESS',
        accountId,
        executionId,
        authorizationId,
        category: 'SUCCESS',
        cooldownDurationMs: null,
        reason: 'COMPLETED_SUCCESS: Provider execution completed successfully.',
      };
    }

    if (providerResult.status === 'AWAITING_OWNER') {
      return {
        action: 'NO_MUTATION',
        accountId,
        executionId,
        authorizationId,
        category: 'AWAITING_OWNER',
        cooldownDurationMs: null,
        reason: 'AWAITING_OWNER: Execution awaiting owner intervention; no account health mutation.',
      };
    }

    // 6. Classify failure using canonical ExecutionFailureClassifier
    const failure = ExecutionFailureClassifier.classify(providerResult);

    switch (failure.category) {
      case 'RATE_LIMITED': {
        if (
          policyResult &&
          policyResult.status === 'VALID' &&
          policyResult.policy.enabled === true
        ) {
          const enabledPolicy = policyResult.policy as EnabledFailoverPolicyV1;
          if (
            typeof enabledPolicy.cooldown_duration_ms === 'number' &&
            Number.isFinite(enabledPolicy.cooldown_duration_ms) &&
            enabledPolicy.cooldown_duration_ms > 0
          ) {
            return {
              action: 'RECORD_RATE_LIMITED',
              accountId,
              executionId,
              authorizationId,
              category: 'RATE_LIMITED',
              cooldownDurationMs: enabledPolicy.cooldown_duration_ms,
              reason: 'RATE_LIMITED: Provider execution was rate limited; explicit policy cooldown applied.',
            };
          }
        }
        return {
          action: 'NO_MUTATION',
          accountId,
          executionId,
          authorizationId,
          category: 'RATE_LIMITED',
          cooldownDurationMs: null,
          reason: 'RATE_LIMITED_EXPLICIT_COOLDOWN_REQUIRED: Rate limiting proven but explicit cooldown duration is missing in failover policy.',
        };
      }

      case 'QUOTA_EXHAUSTED':
        return {
          action: 'RECORD_QUOTA_EXHAUSTED',
          accountId,
          executionId,
          authorizationId,
          category: 'QUOTA_EXHAUSTED',
          cooldownDurationMs: null,
          reason: 'QUOTA_EXHAUSTED: Provider execution failed due to quota exhaustion.',
        };

      case 'AUTHENTICATION_FAILURE':
        return {
          action: 'RECORD_AUTH_ERROR',
          accountId,
          executionId,
          authorizationId,
          category: 'AUTHENTICATION_FAILURE',
          cooldownDurationMs: null,
          reason: 'AUTHENTICATION_FAILURE: Provider execution failed with authentication error.',
        };

      case 'RESOURCE_UNAVAILABLE':
        return {
          action: 'NO_MUTATION',
          accountId,
          executionId,
          authorizationId,
          category: 'RESOURCE_UNAVAILABLE',
          cooldownDurationMs: null,
          reason: 'RESOURCE_UNAVAILABLE_SCOPE_UNRESOLVED: Resource unavailability scope is unresolved; no account health mutation.',
        };

      case 'TIMEOUT':
        return {
          action: 'NO_MUTATION',
          accountId,
          executionId,
          authorizationId,
          category: 'TIMEOUT',
          cooldownDurationMs: null,
          reason: 'TIMEOUT: Process execution timed out; no account health mutation.',
        };

      case 'NONZERO_EXIT':
        return {
          action: 'NO_MUTATION',
          accountId,
          executionId,
          authorizationId,
          category: 'NONZERO_EXIT',
          cooldownDurationMs: null,
          reason: 'NONZERO_EXIT: Process exited with non-zero code; no account health mutation.',
        };

      case 'OUTPUT_LIMIT_EXCEEDED':
        return {
          action: 'NO_MUTATION',
          accountId,
          executionId,
          authorizationId,
          category: 'OUTPUT_LIMIT_EXCEEDED',
          cooldownDurationMs: null,
          reason: 'OUTPUT_LIMIT_EXCEEDED: Process output limit exceeded; no account health mutation.',
        };

      case 'CANCELLED':
        return {
          action: 'NO_MUTATION',
          accountId,
          executionId,
          authorizationId,
          category: 'CANCELLED',
          cooldownDurationMs: null,
          reason: 'CANCELLED: Execution cancelled; no account health mutation.',
        };

      case 'POLICY_DENIAL':
        return {
          action: 'NO_MUTATION',
          accountId,
          executionId,
          authorizationId,
          category: 'POLICY_DENIAL',
          cooldownDurationMs: null,
          reason: 'POLICY_DENIAL: Execution denied by security policy; no account health mutation.',
        };

      case 'PROTOCOL_INVALID':
        return {
          action: 'NO_MUTATION',
          accountId,
          executionId,
          authorizationId,
          category: 'PROTOCOL_INVALID',
          cooldownDurationMs: null,
          reason: 'PROTOCOL_INVALID: Provider returned malformed protocol output; no account health mutation.',
        };

      case 'LOCAL_PROCESS_FAILURE':
        return {
          action: 'NO_MUTATION',
          accountId,
          executionId,
          authorizationId,
          category: 'LOCAL_PROCESS_FAILURE',
          cooldownDurationMs: null,
          reason: 'LOCAL_PROCESS_FAILURE: Local process launch failed; no account health mutation.',
        };

      case 'UNKNOWN':
      default:
        return {
          action: 'NO_MUTATION',
          accountId,
          executionId,
          authorizationId,
          category: 'UNKNOWN',
          cooldownDurationMs: null,
          reason: 'UNKNOWN: Unknown provider failure; no account health mutation.',
        };
    }
  }
}
