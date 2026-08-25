import { AgentExecutionResult, RuntimeErrorCode } from '../adapters/ProviderAdapter';

export type ProviderFailureCategory =
  | 'RATE_LIMITED'
  | 'QUOTA_EXHAUSTED'
  | 'AUTHENTICATION_FAILURE'
  | 'RESOURCE_UNAVAILABLE'
  | 'CANCELLED'
  | 'POLICY_DENIAL'
  | 'PROTOCOL_INVALID'
  | 'LOCAL_PROCESS_FAILURE'
  | 'TIMEOUT'
  | 'NONZERO_EXIT'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'UNKNOWN';

export type FailoverDisposition =
  | 'FAILOVER_ELIGIBLE'
  | 'NON_FAILOVERABLE'
  | 'POLICY_DECISION_REQUIRED';

export interface ClassifiedExecutionFailure {
  category: ProviderFailureCategory;
  disposition: FailoverDisposition;
  sourceErrorCode: RuntimeErrorCode | null;
  reason: string;
}

export class ExecutionFailureClassifier {
  private static readonly RATE_LIMIT_REGEX =
    /(?:rate[\s_-]*limit|rate[\s_-]*limited|too many requests|\b429\b)/i;

  /**
   * Deterministically classifies an execution failure into a provider-neutral category
   * and failover disposition without credential inspection or external side-effects.
   */
  public static classify(result: AgentExecutionResult): ClassifiedExecutionFailure {
    if (result.status === 'COMPLETED') {
      throw new Error('Cannot classify successful execution result as a failure.');
    }

    if (result.status === 'CANCELLED' || result.errorCode === 'CANCELLED') {
      return {
        category: 'CANCELLED',
        disposition: 'NON_FAILOVERABLE',
        sourceErrorCode: result.errorCode ?? 'CANCELLED',
        reason: 'Execution was cancelled by caller or supervisor.',
      };
    }

    const code = result.errorCode;
    const errorText = (result.error ?? '').trim();

    // 1. Quota / Rate-limit checks
    if (code === 'QUOTA_EXHAUSTED') {
      if (this.RATE_LIMIT_REGEX.test(errorText)) {
        return {
          category: 'RATE_LIMITED',
          disposition: 'FAILOVER_ELIGIBLE',
          sourceErrorCode: code,
          reason: 'Provider execution failed due to rate limiting.',
        };
      }
      return {
        category: 'QUOTA_EXHAUSTED',
        disposition: 'FAILOVER_ELIGIBLE',
        sourceErrorCode: code,
        reason: 'Provider execution failed due to quota exhaustion.',
      };
    }

    // 2. Authentication failure (NEEDS_OWNER / non-failoverable)
    if (code === 'AUTH_ERROR') {
      return {
        category: 'AUTHENTICATION_FAILURE',
        disposition: 'NON_FAILOVERABLE',
        sourceErrorCode: code,
        reason: 'Provider authentication failed. Requires manual owner intervention.',
      };
    }

    // 3. Resource unavailable
    if (code === 'RESOURCE_UNAVAILABLE') {
      return {
        category: 'RESOURCE_UNAVAILABLE',
        disposition: 'FAILOVER_ELIGIBLE',
        sourceErrorCode: code,
        reason: 'Requested provider model resource is currently unavailable.',
      };
    }

    // 4. Policy denial
    if (code === 'POLICY_DENIAL') {
      return {
        category: 'POLICY_DENIAL',
        disposition: 'NON_FAILOVERABLE',
        sourceErrorCode: code,
        reason: 'Execution denied by security or path access policy.',
      };
    }

    // 5. Protocol invalid
    if (code === 'PROTOCOL_INVALID') {
      return {
        category: 'PROTOCOL_INVALID',
        disposition: 'NON_FAILOVERABLE',
        sourceErrorCode: code,
        reason:
          'Provider completed execution but returned malformed or missing protocol output.',
      };
    }

    // 6. Local process launch failure
    if (code === 'PROCESS_LAUNCH_FAILED') {
      return {
        category: 'LOCAL_PROCESS_FAILURE',
        disposition: 'NON_FAILOVERABLE',
        sourceErrorCode: code,
        reason: 'Failed to launch local CLI process.',
      };
    }

    // 7. Policy-dependent failure categories
    if (code === 'TIMEOUT') {
      return {
        category: 'TIMEOUT',
        disposition: 'POLICY_DECISION_REQUIRED',
        sourceErrorCode: code,
        reason: 'Process execution timed out.',
      };
    }

    if (code === 'NONZERO_EXIT') {
      return {
        category: 'NONZERO_EXIT',
        disposition: 'POLICY_DECISION_REQUIRED',
        sourceErrorCode: code,
        reason: 'Process exited with non-zero exit code.',
      };
    }

    if (code === 'OUTPUT_LIMIT_EXCEEDED') {
      return {
        category: 'OUTPUT_LIMIT_EXCEEDED',
        disposition: 'POLICY_DECISION_REQUIRED',
        sourceErrorCode: code,
        reason: 'Process output exceeded maximum byte limit.',
      };
    }

    // 8. Unsupported client
    if (code === 'UNSUPPORTED_CLIENT') {
      return {
        category: 'UNKNOWN',
        disposition: 'NON_FAILOVERABLE',
        sourceErrorCode: code,
        reason: 'Provider returned unsupported client runtime status.',
      };
    }

    // Default: Fail-closed as UNKNOWN
    return {
      category: 'UNKNOWN',
      disposition: 'NON_FAILOVERABLE',
      sourceErrorCode: code ?? null,
      reason: 'Unknown or unclassified provider failure.',
    };
  }
}
