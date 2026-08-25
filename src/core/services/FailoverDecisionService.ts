import {
  FailoverPolicyParseResult,
  EnabledFailoverPolicyV1,
  PolicyDependentFailureCategory,
  FailoverDecision,
} from '../types/domain';
import {
  ClassifiedExecutionFailure,
} from './ExecutionFailureClassifier';

export interface FailoverDecisionParams {
  failure: ClassifiedExecutionFailure;
  policyResult: FailoverPolicyParseResult;
  failoverAttemptsUsed: number;
}

export class FailoverDecisionService {
  /**
   * Pure, deterministic decision authority that evaluates a classified execution failure
   * against a typed FailoverPolicyParseResult and attempt counter.
   *
   * NEVER launches execution, mutates database state, or overrides non-failoverable hard stops.
   * Consumes strictly trusted FailoverPolicyParseResult produced by FailoverPolicyParser.
   *
   * @param params Input containing classified failure, policyResult, and failover attempts count.
   * @returns FailoverDecision with bounded outcome, category, and reason.
   */
  public static evaluate(params: FailoverDecisionParams): FailoverDecision {
    const { failure, policyResult, failoverAttemptsUsed } = params;

    // 1. Validate attempts count input fail-closed
    if (
      typeof failoverAttemptsUsed !== 'number' ||
      !Number.isFinite(failoverAttemptsUsed) ||
      !Number.isInteger(failoverAttemptsUsed) ||
      failoverAttemptsUsed < 0
    ) {
      return {
        outcome: 'INVALID_POLICY',
        category: failure.category,
        reason: 'INVALID_DECISION_INPUT: failoverAttemptsUsed must be a finite, non-negative integer (>= 0).',
      };
    }

    // 2. Validate policyResult shape & status
    if (
      !policyResult ||
      typeof policyResult !== 'object' ||
      !('status' in policyResult)
    ) {
      return {
        outcome: 'INVALID_POLICY',
        category: failure.category,
        reason: 'Failover policy result is invalid or unrecognized.',
      };
    }

    if (policyResult.status === 'INVALID') {
      return {
        outcome: 'INVALID_POLICY',
        category: failure.category,
        reason: `Failover policy is invalid: ${policyResult.error}`,
      };
    }

    if (policyResult.status === 'ABSENT') {
      return {
        outcome: 'AUTOMATED_FAILOVER_DISABLED',
        category: failure.category,
        reason: 'Automated failover is not configured (policy absent).',
      };
    }

    if (policyResult.status !== 'VALID') {
      return {
        outcome: 'INVALID_POLICY',
        category: failure.category,
        reason: 'Unrecognized failover policy parse status.',
      };
    }

    // 3. Disabled policy evaluation
    if (policyResult.policy.enabled === false) {
      return {
        outcome: 'AUTOMATED_FAILOVER_DISABLED',
        category: failure.category,
        reason: 'Automated failover is explicitly disabled in policy.',
      };
    }

    const enabledPolicy = policyResult.policy as EnabledFailoverPolicyV1;

    // 4. Precedence A: NON-FAILOVERABLE Precedence (hard-stop categories can NEVER be overridden)
    if (failure.disposition === 'NON_FAILOVERABLE') {
      return {
        outcome: 'NON_FAILOVERABLE',
        category: failure.category,
        reason: failure.reason,
      };
    }

    // 5. Precedence B: POLICY_DECISION_REQUIRED Categories (TIMEOUT, NONZERO_EXIT, OUTPUT_LIMIT_EXCEEDED)
    if (failure.disposition === 'POLICY_DECISION_REQUIRED') {
      const categoryKey = failure.category as PolicyDependentFailureCategory;
      const explicitAction = enabledPolicy.failure_actions?.[categoryKey];

      // Missing explicit action: retain POLICY_DECISION_REQUIRED regardless of attempt budget
      if (!explicitAction) {
        return {
          outcome: 'POLICY_DECISION_REQUIRED',
          category: failure.category,
          reason: `Policy decision required for ${failure.category}; no explicit failure_action configured.`,
        };
      }

      // Explicit STOP action: non-failoverable stop regardless of attempt budget
      if (explicitAction === 'STOP') {
        return {
          outcome: 'NON_FAILOVERABLE',
          category: failure.category,
          reason: `Explicit policy action for ${failure.category} is STOP.`,
        };
      }

      // Explicit FAILOVER action: evaluate attempt budget
      if (explicitAction === 'FAILOVER') {
        if (failoverAttemptsUsed >= enabledPolicy.max_failover_attempts) {
          return {
            outcome: 'FAILOVER_ATTEMPTS_EXHAUSTED',
            category: failure.category,
            reason: `Maximum failover attempts reached (${failoverAttemptsUsed}/${enabledPolicy.max_failover_attempts}).`,
          };
        }

        const decision: FailoverDecision = {
          outcome: 'FAILOVER_ALLOWED',
          category: failure.category,
          reason: `Failover permitted for ${failure.category} by explicit policy action.`,
        };
        if (enabledPolicy.cooldown_duration_ms !== undefined) {
          decision.cooldownDurationMs = enabledPolicy.cooldown_duration_ms;
        }
        return decision;
      }
    }

    // 6. Precedence C: FAILOVER_ELIGIBLE Categories (RATE_LIMITED, QUOTA_EXHAUSTED, RESOURCE_UNAVAILABLE)
    if (failure.disposition === 'FAILOVER_ELIGIBLE') {
      if (failoverAttemptsUsed >= enabledPolicy.max_failover_attempts) {
        return {
          outcome: 'FAILOVER_ATTEMPTS_EXHAUSTED',
          category: failure.category,
          reason: `Maximum failover attempts reached (${failoverAttemptsUsed}/${enabledPolicy.max_failover_attempts}).`,
        };
      }

      const decision: FailoverDecision = {
        outcome: 'FAILOVER_ALLOWED',
        category: failure.category,
        reason: `Failover permitted by policy for ${failure.category}.`,
      };
      if (enabledPolicy.cooldown_duration_ms !== undefined) {
        decision.cooldownDurationMs = enabledPolicy.cooldown_duration_ms;
      }
      return decision;
    }

    // Default fail-closed
    return {
      outcome: 'NON_FAILOVERABLE',
      category: failure.category,
      reason: 'Unrecognized failure disposition; fail-closed as non-failoverable.',
    };
  }
}
