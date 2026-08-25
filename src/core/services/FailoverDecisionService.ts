import {
  FailoverPolicyV1,
  FailoverPolicyParseResult,
  EnabledFailoverPolicyV1,
  PolicyDependentFailureCategory,
  FailoverDecision,
} from '../types/domain';
import {
  ClassifiedExecutionFailure,
} from './ExecutionFailureClassifier';
import { FailoverPolicyParser } from './FailoverPolicyParser';

export interface FailoverDecisionParams {
  failure: ClassifiedExecutionFailure;
  policy: FailoverPolicyV1 | FailoverPolicyParseResult | Record<string, unknown> | null | undefined;
  failoverAttemptsUsed: number;
}

export class FailoverDecisionService {
  /**
   * Pure, deterministic decision authority that evaluates a classified execution failure
   * against an explicit failover policy and attempt counter.
   *
   * NEVER launches execution, mutates database state, or overrides non-failoverable hard stops.
   *
   * @param params Input containing classified failure, policy (or parsed policy), and failover attempts count.
   * @returns FailoverDecision with bounded outcome, category, and reason.
   */
  public static evaluate(params: FailoverDecisionParams): FailoverDecision {
    const { failure, policy, failoverAttemptsUsed } = params;

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

    // 2. Resolve policy to parsed form
    let parsedPolicy: FailoverPolicyV1;
    if (policy && typeof policy === 'object' && 'status' in policy) {
      const parseResult = policy as FailoverPolicyParseResult;
      if (parseResult.status === 'INVALID') {
        return {
          outcome: 'INVALID_POLICY',
          category: failure.category,
          reason: `Failover policy is invalid: ${parseResult.error}`,
        };
      }
      if (parseResult.status === 'ABSENT') {
        return {
          outcome: 'AUTOMATED_FAILOVER_DISABLED',
          category: failure.category,
          reason: 'Automated failover is not configured (policy absent).',
        };
      }
      parsedPolicy = parseResult.policy;
    } else {
      const parseResult = FailoverPolicyParser.parse(policy);
      if (parseResult.status === 'INVALID') {
        return {
          outcome: 'INVALID_POLICY',
          category: failure.category,
          reason: `Failover policy is invalid: ${parseResult.error}`,
        };
      }
      if (parseResult.status === 'ABSENT') {
        return {
          outcome: 'AUTOMATED_FAILOVER_DISABLED',
          category: failure.category,
          reason: 'Automated failover is not configured (policy absent).',
        };
      }
      parsedPolicy = parseResult.policy;
    }

    // 3. Disabled policy evaluation
    if (parsedPolicy.enabled === false) {
      return {
        outcome: 'AUTOMATED_FAILOVER_DISABLED',
        category: failure.category,
        reason: 'Automated failover is explicitly disabled in policy.',
      };
    }

    const enabledPolicy = parsedPolicy as EnabledFailoverPolicyV1;

    // 4. NON-FAILOVERABLE Precedence: hard-stop categories can NEVER be overridden
    if (failure.disposition === 'NON_FAILOVERABLE') {
      return {
        outcome: 'NON_FAILOVERABLE',
        category: failure.category,
        reason: failure.reason,
      };
    }

    // 5. Attempt Budget Enforcement
    if (failoverAttemptsUsed >= enabledPolicy.max_failover_attempts) {
      return {
        outcome: 'FAILOVER_ATTEMPTS_EXHAUSTED',
        category: failure.category,
        reason: `Maximum failover attempts reached (${failoverAttemptsUsed}/${enabledPolicy.max_failover_attempts}).`,
      };
    }

    // 6. Policy Evaluation based on Failure Category & Disposition
    if (failure.disposition === 'FAILOVER_ELIGIBLE') {
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

    if (failure.disposition === 'POLICY_DECISION_REQUIRED') {
      const categoryKey = failure.category as PolicyDependentFailureCategory;
      const explicitAction = enabledPolicy.failure_actions?.[categoryKey];

      if (explicitAction === 'FAILOVER') {
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

      if (explicitAction === 'STOP') {
        return {
          outcome: 'NON_FAILOVERABLE',
          category: failure.category,
          reason: `Explicit policy action for ${failure.category} is STOP.`,
        };
      }

      // No explicit action configured -> retain truthful POLICY_DECISION_REQUIRED
      return {
        outcome: 'POLICY_DECISION_REQUIRED',
        category: failure.category,
        reason: `Policy decision required for ${failure.category}; no explicit failure_action configured.`,
      };
    }

    // Default fail-closed
    return {
      outcome: 'NON_FAILOVERABLE',
      category: failure.category,
      reason: 'Unrecognized failure disposition; fail-closed as non-failoverable.',
    };
  }
}
