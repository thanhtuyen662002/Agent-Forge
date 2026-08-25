import { describe, it, expect } from 'vitest';
import { FailoverPolicyParser } from '../src/core/services/FailoverPolicyParser';
import { FailoverDecisionService } from '../src/core/services/FailoverDecisionService';
import {
  ExecutionFailureClassifier,
  ClassifiedExecutionFailure,
} from '../src/core/services/ExecutionFailureClassifier';
import {
  FailoverPolicyV1,
  EnabledFailoverPolicyV1,
  DisabledFailoverPolicyV1,
} from '../src/core/types/domain';

describe('R5H2: FailoverPolicyParser and FailoverDecisionService Contract', () => {
  // =========================================================================
  // 1. FailoverPolicyParser Tests
  // =========================================================================
  describe('FailoverPolicyParser', () => {
    it('1. returns ABSENT when input is null or undefined', () => {
      expect(FailoverPolicyParser.parse(null)).toEqual({ status: 'ABSENT' });
      expect(FailoverPolicyParser.parse(undefined)).toEqual({ status: 'ABSENT' });
    });

    it('2. returns INVALID when input is not a plain object or is an array', () => {
      expect(FailoverPolicyParser.parse('string')).toEqual({
        status: 'INVALID',
        error: 'Failover policy must be a JSON object.',
      });
      expect(FailoverPolicyParser.parse(123)).toEqual({
        status: 'INVALID',
        error: 'Failover policy must be a JSON object.',
      });
      expect(FailoverPolicyParser.parse([])).toEqual({
        status: 'INVALID',
        error: 'Failover policy must be a JSON object.',
      });
    });

    it('3. returns INVALID when version is missing or not integer 1', () => {
      expect(FailoverPolicyParser.parse({ enabled: false })).toEqual({
        status: 'INVALID',
        error: 'Failover policy is missing required "version" field.',
      });
      expect(FailoverPolicyParser.parse({ version: 2, enabled: false })).toEqual({
        status: 'INVALID',
        error: 'Unsupported failover policy version: 2. Only version 1 is supported.',
      });
      expect(FailoverPolicyParser.parse({ version: '1', enabled: false })).toEqual({
        status: 'INVALID',
        error: 'Unsupported failover policy version: 1. Only version 1 is supported.',
      });
      expect(FailoverPolicyParser.parse({ version: 1.5, enabled: false })).toEqual({
        status: 'INVALID',
        error: 'Unsupported failover policy version: 1.5. Only version 1 is supported.',
      });
    });

    it('4. returns INVALID when enabled is missing or not a boolean', () => {
      expect(FailoverPolicyParser.parse({ version: 1 })).toEqual({
        status: 'INVALID',
        error: 'Failover policy is missing required "enabled" boolean field.',
      });
      expect(FailoverPolicyParser.parse({ version: 1, enabled: 'true' })).toEqual({
        status: 'INVALID',
        error: '"enabled" field in failover policy must be a boolean.',
      });
      expect(FailoverPolicyParser.parse({ version: 1, enabled: 1 })).toEqual({
        status: 'INVALID',
        error: '"enabled" field in failover policy must be a boolean.',
      });
    });

    it('5. returns VALID for a minimal disabled policy and rejects unknown fields', () => {
      const validDisabled = FailoverPolicyParser.parse({
        version: 1,
        enabled: false,
      });
      expect(validDisabled).toEqual({
        status: 'VALID',
        policy: {
          version: 1,
          enabled: false,
        },
      });

      const invalidDisabled = FailoverPolicyParser.parse({
        version: 1,
        enabled: false,
        max_failover_attempts: 2,
      });
      expect(invalidDisabled.status).toBe('INVALID');
      if (invalidDisabled.status === 'INVALID') {
        expect(invalidDisabled.error).toContain('Unknown top-level field');
      }
    });

    it('6. returns VALID for a valid explicit enabled policy', () => {
      const valid = FailoverPolicyParser.parse({
        version: 1,
        enabled: true,
        max_failover_attempts: 3,
        same_account_retries: 1,
        allow_cross_account: true,
        allow_cross_provider: false,
        cooldown_duration_ms: 30000,
        failure_actions: {
          TIMEOUT: 'FAILOVER',
          NONZERO_EXIT: 'STOP',
        },
      });

      expect(valid).toEqual({
        status: 'VALID',
        policy: {
          version: 1,
          enabled: true,
          max_failover_attempts: 3,
          same_account_retries: 1,
          allow_cross_account: true,
          allow_cross_provider: false,
          cooldown_duration_ms: 30000,
          failure_actions: {
            TIMEOUT: 'FAILOVER',
            NONZERO_EXIT: 'STOP',
          },
        },
      });
    });

    it('7. strictly rejects unknown top-level fields (typos, extra props)', () => {
      const typo = FailoverPolicyParser.parse({
        version: 1,
        enabled: true,
        max_failover_attempts: 2,
        same_account_retries: 1,
        allow_cross_account: true,
        allow_cross_provder: true, // Typo!
      });
      expect(typo.status).toBe('INVALID');
      if (typo.status === 'INVALID') {
        expect(typo.error).toContain('Unknown top-level field "allow_cross_provder"');
      }
    });

    it('8. strictly validates max_failover_attempts', () => {
      const base = {
        version: 1,
        enabled: true,
        same_account_retries: 1,
        allow_cross_account: true,
        allow_cross_provider: true,
      };

      // Missing
      expect(FailoverPolicyParser.parse(base).status).toBe('INVALID');
      // Negative
      expect(FailoverPolicyParser.parse({ ...base, max_failover_attempts: -1 }).status).toBe(
        'INVALID'
      );
      // Fractional
      expect(FailoverPolicyParser.parse({ ...base, max_failover_attempts: 1.5 }).status).toBe(
        'INVALID'
      );
      // NaN
      expect(FailoverPolicyParser.parse({ ...base, max_failover_attempts: NaN }).status).toBe(
        'INVALID'
      );
      // Infinity
      expect(
        FailoverPolicyParser.parse({ ...base, max_failover_attempts: Infinity }).status
      ).toBe('INVALID');
      // Zero is allowed
      expect(FailoverPolicyParser.parse({ ...base, max_failover_attempts: 0 }).status).toBe(
        'VALID'
      );
    });

    it('9. strictly validates same_account_retries', () => {
      const base = {
        version: 1,
        enabled: true,
        max_failover_attempts: 2,
        allow_cross_account: true,
        allow_cross_provider: true,
      };

      // Missing
      expect(FailoverPolicyParser.parse(base).status).toBe('INVALID');
      // Negative
      expect(FailoverPolicyParser.parse({ ...base, same_account_retries: -1 }).status).toBe(
        'INVALID'
      );
      // Fractional
      expect(FailoverPolicyParser.parse({ ...base, same_account_retries: 0.5 }).status).toBe(
        'INVALID'
      );
      // Zero is allowed
      expect(FailoverPolicyParser.parse({ ...base, same_account_retries: 0 }).status).toBe(
        'VALID'
      );
    });

    it('10. strictly validates allow_cross_account and allow_cross_provider booleans', () => {
      const base = {
        version: 1,
        enabled: true,
        max_failover_attempts: 2,
        same_account_retries: 1,
      };

      expect(
        FailoverPolicyParser.parse({
          ...base,
          allow_cross_account: 'true',
          allow_cross_provider: true,
        }).status
      ).toBe('INVALID');
      expect(
        FailoverPolicyParser.parse({
          ...base,
          allow_cross_account: true,
          allow_cross_provider: null,
        }).status
      ).toBe('INVALID');
    });

    it('11. strictly validates optional cooldown_duration_ms', () => {
      const base = {
        version: 1,
        enabled: true,
        max_failover_attempts: 2,
        same_account_retries: 1,
        allow_cross_account: true,
        allow_cross_provider: true,
      };

      // 0 is invalid (must be strictly > 0)
      expect(
        FailoverPolicyParser.parse({ ...base, cooldown_duration_ms: 0 }).status
      ).toBe('INVALID');
      // Negative
      expect(
        FailoverPolicyParser.parse({ ...base, cooldown_duration_ms: -5000 }).status
      ).toBe('INVALID');
      // Fractional
      expect(
        FailoverPolicyParser.parse({ ...base, cooldown_duration_ms: 100.5 }).status
      ).toBe('INVALID');
      // NaN / Infinity
      expect(
        FailoverPolicyParser.parse({ ...base, cooldown_duration_ms: NaN }).status
      ).toBe('INVALID');
      expect(
        FailoverPolicyParser.parse({ ...base, cooldown_duration_ms: Infinity }).status
      ).toBe('INVALID');
      // Positive integer is valid
      const valid = FailoverPolicyParser.parse({ ...base, cooldown_duration_ms: 60000 });
      expect(valid.status).toBe('VALID');
      if (valid.status === 'VALID' && valid.policy.enabled) {
        expect(valid.policy.cooldown_duration_ms).toBe(60000);
      }
    });

    it('12. strictly validates failure_actions object, keys, and values', () => {
      const base = {
        version: 1,
        enabled: true,
        max_failover_attempts: 2,
        same_account_retries: 1,
        allow_cross_account: true,
        allow_cross_provider: true,
      };

      // Not an object
      expect(
        FailoverPolicyParser.parse({ ...base, failure_actions: 'FAILOVER' }).status
      ).toBe('INVALID');
      expect(
        FailoverPolicyParser.parse({ ...base, failure_actions: ['TIMEOUT'] }).status
      ).toBe('INVALID');

      // Unknown key
      expect(
        FailoverPolicyParser.parse({
          ...base,
          failure_actions: { RATE_LIMITED: 'FAILOVER' },
        }).status
      ).toBe('INVALID');

      // Unknown value
      expect(
        FailoverPolicyParser.parse({
          ...base,
          failure_actions: { TIMEOUT: 'RETRY_LATER' },
        }).status
      ).toBe('INVALID');

      // Valid failure_actions
      const valid = FailoverPolicyParser.parse({
        ...base,
        failure_actions: {
          TIMEOUT: 'FAILOVER',
          NONZERO_EXIT: 'STOP',
          OUTPUT_LIMIT_EXCEEDED: 'FAILOVER',
        },
      });
      expect(valid.status).toBe('VALID');
    });
  });

  // =========================================================================
  // 2. FailoverDecisionService Tests
  // =========================================================================
  describe('FailoverDecisionService', () => {
    const defaultEnabledPolicy: EnabledFailoverPolicyV1 = {
      version: 1,
      enabled: true,
      max_failover_attempts: 2,
      same_account_retries: 1,
      allow_cross_account: true,
      allow_cross_provider: false,
      cooldown_duration_ms: 45000,
    };

    const disabledPolicy: DisabledFailoverPolicyV1 = {
      version: 1,
      enabled: false,
    };

    it('1. permits failover for FAILOVER_ELIGIBLE failure categories within attempt budget', () => {
      const rateLimitFailure: ClassifiedExecutionFailure = {
        category: 'RATE_LIMITED',
        disposition: 'FAILOVER_ELIGIBLE',
        sourceErrorCode: 'QUOTA_EXHAUSTED',
        reason: 'Provider execution failed due to rate limiting.',
      };

      const decision0 = FailoverDecisionService.evaluate({
        failure: rateLimitFailure,
        policy: defaultEnabledPolicy,
        failoverAttemptsUsed: 0,
      });

      expect(decision0).toEqual({
        outcome: 'FAILOVER_ALLOWED',
        category: 'RATE_LIMITED',
        reason: 'Failover permitted by policy for RATE_LIMITED.',
        cooldownDurationMs: 45000,
      });

      const decision1 = FailoverDecisionService.evaluate({
        failure: rateLimitFailure,
        policy: defaultEnabledPolicy,
        failoverAttemptsUsed: 1,
      });

      expect(decision1.outcome).toBe('FAILOVER_ALLOWED');

      // QUOTA_EXHAUSTED
      const quotaFailure: ClassifiedExecutionFailure = {
        category: 'QUOTA_EXHAUSTED',
        disposition: 'FAILOVER_ELIGIBLE',
        sourceErrorCode: 'QUOTA_EXHAUSTED',
        reason: 'Provider execution failed due to quota exhaustion.',
      };
      expect(
        FailoverDecisionService.evaluate({
          failure: quotaFailure,
          policy: defaultEnabledPolicy,
          failoverAttemptsUsed: 0,
        }).outcome
      ).toBe('FAILOVER_ALLOWED');

      // RESOURCE_UNAVAILABLE
      const resourceFailure: ClassifiedExecutionFailure = {
        category: 'RESOURCE_UNAVAILABLE',
        disposition: 'FAILOVER_ELIGIBLE',
        sourceErrorCode: 'RESOURCE_UNAVAILABLE',
        reason: 'Model resource unavailable.',
      };
      expect(
        FailoverDecisionService.evaluate({
          failure: resourceFailure,
          policy: defaultEnabledPolicy,
          failoverAttemptsUsed: 0,
        }).outcome
      ).toBe('FAILOVER_ALLOWED');
    });

    it('2. returns FAILOVER_ATTEMPTS_EXHAUSTED when attempt count reaches or exceeds max', () => {
      const rateLimitFailure: ClassifiedExecutionFailure = {
        category: 'RATE_LIMITED',
        disposition: 'FAILOVER_ELIGIBLE',
        sourceErrorCode: 'QUOTA_EXHAUSTED',
        reason: 'Rate limit hit',
      };

      // When attemptsUsed == max (2)
      const exhausted = FailoverDecisionService.evaluate({
        failure: rateLimitFailure,
        policy: defaultEnabledPolicy,
        failoverAttemptsUsed: 2,
      });

      expect(exhausted).toEqual({
        outcome: 'FAILOVER_ATTEMPTS_EXHAUSTED',
        category: 'RATE_LIMITED',
        reason: 'Maximum failover attempts reached (2/2).',
      });

      // When attemptsUsed > max (3)
      const overExhausted = FailoverDecisionService.evaluate({
        failure: rateLimitFailure,
        policy: defaultEnabledPolicy,
        failoverAttemptsUsed: 3,
      });
      expect(overExhausted.outcome).toBe('FAILOVER_ATTEMPTS_EXHAUSTED');

      // When max_failover_attempts == 0 and attemptsUsed == 0
      const zeroBudgetPolicy: EnabledFailoverPolicyV1 = {
        ...defaultEnabledPolicy,
        max_failover_attempts: 0,
      };
      const zeroExhausted = FailoverDecisionService.evaluate({
        failure: rateLimitFailure,
        policy: zeroBudgetPolicy,
        failoverAttemptsUsed: 0,
      });
      expect(zeroExhausted.outcome).toBe('FAILOVER_ATTEMPTS_EXHAUSTED');
    });

    it('3. enforces NON-FAILOVERABLE precedence (never overridden by policy or attempt budget)', () => {
      const nonFailoverableCategories: Array<{
        category: ClassifiedExecutionFailure['category'];
        sourceErrorCode: any;
      }> = [
        { category: 'AUTHENTICATION_FAILURE', sourceErrorCode: 'AUTH_ERROR' },
        { category: 'CANCELLED', sourceErrorCode: 'CANCELLED' },
        { category: 'POLICY_DENIAL', sourceErrorCode: 'POLICY_DENIAL' },
        { category: 'PROTOCOL_INVALID', sourceErrorCode: 'PROTOCOL_INVALID' },
        { category: 'LOCAL_PROCESS_FAILURE', sourceErrorCode: 'PROCESS_LAUNCH_FAILED' },
        { category: 'UNKNOWN', sourceErrorCode: 'UNKNOWN' },
      ];

      for (const item of nonFailoverableCategories) {
        const failure: ClassifiedExecutionFailure = {
          category: item.category,
          disposition: 'NON_FAILOVERABLE',
          sourceErrorCode: item.sourceErrorCode,
          reason: `Test reason for ${item.category}`,
        };

        const decision = FailoverDecisionService.evaluate({
          failure,
          policy: defaultEnabledPolicy,
          failoverAttemptsUsed: 0,
        });

        expect(decision.outcome).toBe('NON_FAILOVERABLE');
        expect(decision.category).toBe(item.category);
      }
    });

    it('4. preserves POLICY_DECISION_REQUIRED when no explicit failure_action is defined', () => {
      const policyDepCategories: Array<ClassifiedExecutionFailure['category']> = [
        'TIMEOUT',
        'NONZERO_EXIT',
        'OUTPUT_LIMIT_EXCEEDED',
      ];

      for (const cat of policyDepCategories) {
        const failure: ClassifiedExecutionFailure = {
          category: cat,
          disposition: 'POLICY_DECISION_REQUIRED',
          sourceErrorCode: cat as any,
          reason: `Policy decision required for ${cat}`,
        };

        const decision = FailoverDecisionService.evaluate({
          failure,
          policy: defaultEnabledPolicy, // No failure_actions configured
          failoverAttemptsUsed: 0,
        });

        expect(decision.outcome).toBe('POLICY_DECISION_REQUIRED');
        expect(decision.category).toBe(cat);
      }
    });

    it('5. evaluates explicit failure_actions (FAILOVER vs STOP)', () => {
      const policyWithActions: EnabledFailoverPolicyV1 = {
        ...defaultEnabledPolicy,
        failure_actions: {
          TIMEOUT: 'FAILOVER',
          NONZERO_EXIT: 'STOP',
        },
      };

      const timeoutFailure: ClassifiedExecutionFailure = {
        category: 'TIMEOUT',
        disposition: 'POLICY_DECISION_REQUIRED',
        sourceErrorCode: 'TIMEOUT',
        reason: 'Process timed out',
      };

      // TIMEOUT with explicit FAILOVER action -> FAILOVER_ALLOWED (with cooldown)
      const timeoutDecision = FailoverDecisionService.evaluate({
        failure: timeoutFailure,
        policy: policyWithActions,
        failoverAttemptsUsed: 0,
      });
      expect(timeoutDecision).toEqual({
        outcome: 'FAILOVER_ALLOWED',
        category: 'TIMEOUT',
        reason: 'Failover permitted for TIMEOUT by explicit policy action.',
        cooldownDurationMs: 45000,
      });

      // TIMEOUT with explicit FAILOVER action but exhausted budget -> FAILOVER_ATTEMPTS_EXHAUSTED
      const timeoutExhausted = FailoverDecisionService.evaluate({
        failure: timeoutFailure,
        policy: policyWithActions,
        failoverAttemptsUsed: 2,
      });
      expect(timeoutExhausted.outcome).toBe('FAILOVER_ATTEMPTS_EXHAUSTED');

      // NONZERO_EXIT with explicit STOP action -> NON_FAILOVERABLE
      const nonzeroFailure: ClassifiedExecutionFailure = {
        category: 'NONZERO_EXIT',
        disposition: 'POLICY_DECISION_REQUIRED',
        sourceErrorCode: 'NONZERO_EXIT',
        reason: 'Process exited with code 1',
      };
      const nonzeroDecision = FailoverDecisionService.evaluate({
        failure: nonzeroFailure,
        policy: policyWithActions,
        failoverAttemptsUsed: 0,
      });
      expect(nonzeroDecision).toEqual({
        outcome: 'NON_FAILOVERABLE',
        category: 'NONZERO_EXIT',
        reason: 'Explicit policy action for NONZERO_EXIT is STOP.',
      });

      // OUTPUT_LIMIT_EXCEEDED without action -> POLICY_DECISION_REQUIRED
      const outputLimitFailure: ClassifiedExecutionFailure = {
        category: 'OUTPUT_LIMIT_EXCEEDED',
        disposition: 'POLICY_DECISION_REQUIRED',
        sourceErrorCode: 'OUTPUT_LIMIT_EXCEEDED',
        reason: 'Output limit exceeded',
      };
      const outputLimitDecision = FailoverDecisionService.evaluate({
        failure: outputLimitFailure,
        policy: policyWithActions,
        failoverAttemptsUsed: 0,
      });
      expect(outputLimitDecision.outcome).toBe('POLICY_DECISION_REQUIRED');
    });

    it('6. returns AUTOMATED_FAILOVER_DISABLED when policy is explicitly disabled', () => {
      const rateLimitFailure: ClassifiedExecutionFailure = {
        category: 'RATE_LIMITED',
        disposition: 'FAILOVER_ELIGIBLE',
        sourceErrorCode: 'QUOTA_EXHAUSTED',
        reason: 'Rate limit hit',
      };

      const decision = FailoverDecisionService.evaluate({
        failure: rateLimitFailure,
        policy: disabledPolicy,
        failoverAttemptsUsed: 0,
      });
      expect(decision.outcome).toBe('AUTOMATED_FAILOVER_DISABLED');
    });

    it('7. returns AUTOMATED_FAILOVER_DISABLED when policy is null, undefined, or ABSENT', () => {
      const rateLimitFailure: ClassifiedExecutionFailure = {
        category: 'RATE_LIMITED',
        disposition: 'FAILOVER_ELIGIBLE',
        sourceErrorCode: 'QUOTA_EXHAUSTED',
        reason: 'Rate limit hit',
      };

      expect(
        FailoverDecisionService.evaluate({
          failure: rateLimitFailure,
          policy: null,
          failoverAttemptsUsed: 0,
        }).outcome
      ).toBe('AUTOMATED_FAILOVER_DISABLED');

      expect(
        FailoverDecisionService.evaluate({
          failure: rateLimitFailure,
          policy: undefined,
          failoverAttemptsUsed: 0,
        }).outcome
      ).toBe('AUTOMATED_FAILOVER_DISABLED');

      expect(
        FailoverDecisionService.evaluate({
          failure: rateLimitFailure,
          policy: { status: 'ABSENT' },
          failoverAttemptsUsed: 0,
        }).outcome
      ).toBe('AUTOMATED_FAILOVER_DISABLED');
    });

    it('8. returns INVALID_POLICY and fails closed on malformed policy or invalid attempts input', () => {
      const rateLimitFailure: ClassifiedExecutionFailure = {
        category: 'RATE_LIMITED',
        disposition: 'FAILOVER_ELIGIBLE',
        sourceErrorCode: 'QUOTA_EXHAUSTED',
        reason: 'Rate limit hit',
      };

      // Invalid policy object
      const invalidPolicyDecision = FailoverDecisionService.evaluate({
        failure: rateLimitFailure,
        policy: { version: 1, enabled: true, max_failover_attempts: -1 } as any,
        failoverAttemptsUsed: 0,
      });
      expect(invalidPolicyDecision.outcome).toBe('INVALID_POLICY');

      // Parsed INVALID policy
      const parsedInvalidDecision = FailoverDecisionService.evaluate({
        failure: rateLimitFailure,
        policy: { status: 'INVALID', error: 'Malformed policy' },
        failoverAttemptsUsed: 0,
      });
      expect(parsedInvalidDecision.outcome).toBe('INVALID_POLICY');

      // Negative attempts count
      const negativeAttemptsDecision = FailoverDecisionService.evaluate({
        failure: rateLimitFailure,
        policy: defaultEnabledPolicy,
        failoverAttemptsUsed: -1,
      });
      expect(negativeAttemptsDecision.outcome).toBe('INVALID_POLICY');

      // Fractional attempts count
      const fractionalAttemptsDecision = FailoverDecisionService.evaluate({
        failure: rateLimitFailure,
        policy: defaultEnabledPolicy,
        failoverAttemptsUsed: 1.5,
      });
      expect(fractionalAttemptsDecision.outcome).toBe('INVALID_POLICY');

      // NaN attempts count
      const nanAttemptsDecision = FailoverDecisionService.evaluate({
        failure: rateLimitFailure,
        policy: defaultEnabledPolicy,
        failoverAttemptsUsed: NaN,
      });
      expect(nanAttemptsDecision.outcome).toBe('INVALID_POLICY');
    });

    it('9. end-to-end integration: integrates with ExecutionFailureClassifier without mutation', () => {
      const simulatedResult = {
        executionId: 'exec-101',
        status: 'FAILED' as const,
        errorCode: 'QUOTA_EXHAUSTED' as const,
        error: '429 Rate limit exceeded',
      };

      const classified = ExecutionFailureClassifier.classify(simulatedResult);
      expect(classified.category).toBe('RATE_LIMITED');
      expect(classified.disposition).toBe('FAILOVER_ELIGIBLE');

      const decision = FailoverDecisionService.evaluate({
        failure: classified,
        policy: defaultEnabledPolicy,
        failoverAttemptsUsed: 0,
      });

      expect(decision.outcome).toBe('FAILOVER_ALLOWED');
      expect(decision.cooldownDurationMs).toBe(45000);
    });
  });
});
