import {
  FailoverPolicyV1,
  FailoverPolicyParseResult,
  EnabledFailoverPolicyV1,
  DisabledFailoverPolicyV1,
  PolicyDependentFailureCategory,
  FailoverPolicyAction,
} from '../types/domain';

const ALLOWED_DISABLED_KEYS = new Set(['version', 'enabled']);

const ALLOWED_ENABLED_KEYS = new Set([
  'version',
  'enabled',
  'max_failover_attempts',
  'same_account_retries',
  'allow_cross_account',
  'allow_cross_provider',
  'cooldown_duration_ms',
  'failure_actions',
]);

const ALLOWED_FAILURE_ACTION_KEYS = new Set<PolicyDependentFailureCategory>([
  'TIMEOUT',
  'NONZERO_EXIT',
  'OUTPUT_LIMIT_EXCEEDED',
]);

const ALLOWED_FAILURE_ACTION_VALUES = new Set<FailoverPolicyAction>([
  'FAILOVER',
  'STOP',
]);

export class FailoverPolicyParser {
  /**
   * Strictly and deterministically parses and validates a FailoverPolicy object.
   * Pure and side-effect free (no clock, no repository, no network, no credentials).
   *
   * @param input Raw unvalidated failover policy payload (from RoutePolicy.failover_policy or caller)
   * @returns FailoverPolicyParseResult ({ status: 'VALID', policy } | { status: 'ABSENT' } | { status: 'INVALID', error })
   */
  public static parse(input: unknown): FailoverPolicyParseResult {
    if (input === null || input === undefined) {
      return { status: 'ABSENT' };
    }

    if (typeof input !== 'object' || Array.isArray(input)) {
      return {
        status: 'INVALID',
        error: 'Failover policy must be a JSON object.',
      };
    }

    const record = input as Record<string, unknown>;

    // 1. Version validation
    if (!('version' in record)) {
      return {
        status: 'INVALID',
        error: 'Failover policy is missing required "version" field.',
      };
    }

    if (
      typeof record.version !== 'number' ||
      !Number.isInteger(record.version) ||
      record.version !== 1
    ) {
      return {
        status: 'INVALID',
        error: `Unsupported failover policy version: ${String(record.version)}. Only version 1 is supported.`,
      };
    }

    // 2. Enabled flag validation
    if (!('enabled' in record)) {
      return {
        status: 'INVALID',
        error: 'Failover policy is missing required "enabled" boolean field.',
      };
    }

    if (typeof record.enabled !== 'boolean') {
      return {
        status: 'INVALID',
        error: '"enabled" field in failover policy must be a boolean.',
      };
    }

    // 3. Disabled policy branch
    if (record.enabled === false) {
      for (const key of Object.keys(record)) {
        if (!ALLOWED_DISABLED_KEYS.has(key)) {
          return {
            status: 'INVALID',
            error: `Unknown top-level field "${key}" in disabled failover policy.`,
          };
        }
      }

      const disabledPolicy: DisabledFailoverPolicyV1 = {
        version: 1,
        enabled: false,
      };
      return {
        status: 'VALID',
        policy: disabledPolicy,
      };
    }

    // 4. Enabled policy branch - Strict key checking
    for (const key of Object.keys(record)) {
      if (!ALLOWED_ENABLED_KEYS.has(key)) {
        return {
          status: 'INVALID',
          error: `Unknown top-level field "${key}" in enabled failover policy.`,
        };
      }
    }

    // 5. Required numeric fields validation
    if (!('max_failover_attempts' in record)) {
      return {
        status: 'INVALID',
        error: 'Enabled failover policy is missing required "max_failover_attempts" field.',
      };
    }
    if (
      typeof record.max_failover_attempts !== 'number' ||
      !Number.isFinite(record.max_failover_attempts) ||
      !Number.isInteger(record.max_failover_attempts) ||
      record.max_failover_attempts < 0
    ) {
      return {
        status: 'INVALID',
        error: '"max_failover_attempts" must be a finite, non-negative integer (>= 0).',
      };
    }

    if (!('same_account_retries' in record)) {
      return {
        status: 'INVALID',
        error: 'Enabled failover policy is missing required "same_account_retries" field.',
      };
    }
    if (
      typeof record.same_account_retries !== 'number' ||
      !Number.isFinite(record.same_account_retries) ||
      !Number.isInteger(record.same_account_retries) ||
      record.same_account_retries < 0
    ) {
      return {
        status: 'INVALID',
        error: '"same_account_retries" must be a finite, non-negative integer (>= 0).',
      };
    }

    // 6. Required boolean permissions validation
    if (!('allow_cross_account' in record)) {
      return {
        status: 'INVALID',
        error: 'Enabled failover policy is missing required "allow_cross_account" boolean field.',
      };
    }
    if (typeof record.allow_cross_account !== 'boolean') {
      return {
        status: 'INVALID',
        error: '"allow_cross_account" must be a boolean.',
      };
    }

    if (!('allow_cross_provider' in record)) {
      return {
        status: 'INVALID',
        error: 'Enabled failover policy is missing required "allow_cross_provider" boolean field.',
      };
    }
    if (typeof record.allow_cross_provider !== 'boolean') {
      return {
        status: 'INVALID',
        error: '"allow_cross_provider" must be a boolean.',
      };
    }

    // 7. Optional cooldown_duration_ms validation
    if ('cooldown_duration_ms' in record && record.cooldown_duration_ms !== undefined) {
      if (
        typeof record.cooldown_duration_ms !== 'number' ||
        !Number.isFinite(record.cooldown_duration_ms) ||
        !Number.isInteger(record.cooldown_duration_ms) ||
        record.cooldown_duration_ms <= 0
      ) {
        return {
          status: 'INVALID',
          error: '"cooldown_duration_ms" must be a finite, strictly positive integer (> 0).',
        };
      }
    }

    // 8. Optional failure_actions validation
    if ('failure_actions' in record && record.failure_actions !== undefined) {
      if (
        typeof record.failure_actions !== 'object' ||
        record.failure_actions === null ||
        Array.isArray(record.failure_actions)
      ) {
        return {
          status: 'INVALID',
          error: '"failure_actions" must be an object map of category actions.',
        };
      }

      const actions = record.failure_actions as Record<string, unknown>;
      for (const [actionKey, actionVal] of Object.entries(actions)) {
        if (!ALLOWED_FAILURE_ACTION_KEYS.has(actionKey as PolicyDependentFailureCategory)) {
          return {
            status: 'INVALID',
            error: `Unknown key "${actionKey}" in failure_actions. Allowed keys: TIMEOUT, NONZERO_EXIT, OUTPUT_LIMIT_EXCEEDED.`,
          };
        }
        if (!ALLOWED_FAILURE_ACTION_VALUES.has(actionVal as FailoverPolicyAction)) {
          return {
            status: 'INVALID',
            error: `Invalid action "${String(actionVal)}" for failure_actions.${actionKey}. Allowed values: FAILOVER, STOP.`,
          };
        }
      }
    }

    const enabledPolicy: EnabledFailoverPolicyV1 = {
      version: 1,
      enabled: true,
      max_failover_attempts: record.max_failover_attempts,
      same_account_retries: record.same_account_retries,
      allow_cross_account: record.allow_cross_account,
      allow_cross_provider: record.allow_cross_provider,
    };

    if (
      'cooldown_duration_ms' in record &&
      record.cooldown_duration_ms !== undefined
    ) {
      enabledPolicy.cooldown_duration_ms = record.cooldown_duration_ms as number;
    }

    if ('failure_actions' in record && record.failure_actions !== undefined) {
      enabledPolicy.failure_actions = {
        ...(record.failure_actions as Partial<Record<PolicyDependentFailureCategory, FailoverPolicyAction>>),
      };
    }

    return {
      status: 'VALID',
      policy: enabledPolicy,
    };
  }
}
