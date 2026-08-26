import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  FailureHealthMutationPolicyService,
  ProviderAccountHealthActionPlan,
} from '../src/core/services/FailureHealthMutationPolicyService';
import {
  ProviderDispatchExecutionResult,
  ProviderExecutionProvenanceV1,
} from '../src/core/services/ProviderDispatchService';
import {
  FailoverPolicyParseResult,
} from '../src/core/types/domain';

function makeProvenance(overrides?: Partial<ProviderExecutionProvenanceV1>): ProviderExecutionProvenanceV1 {
  return {
    version: 1,
    source: 'PROVIDER_DISPATCH_SERVICE',
    mode: 'SCHEDULED',
    adapterInvocation: 'RETURNED',
    authorizationId: 'auth-123',
    executionId: 'exec-123',
    projectId: 'proj-123',
    taskId: 'task-123',
    attemptId: 'att-123',
    routingDecisionId: 'dec-123',
    providerId: 'codex',
    resourceId: 'res-codex-1',
    assignmentId: 'assign-123',
    accountId: 'acc-codex-1',
    ...overrides,
  };
}

function makeValidPolicy(cooldownDurationMs = 60000): FailoverPolicyParseResult {
  return {
    status: 'VALID',
    policy: {
      version: 1,
      enabled: true,
      max_failover_attempts: 3,
      same_account_retries: 0,
      allow_cross_account: true,
      allow_cross_provider: true,
      cooldown_duration_ms: cooldownDurationMs,
      failure_actions: {
        TIMEOUT: 'FAILOVER',
        NONZERO_EXIT: 'STOP',
        OUTPUT_LIMIT_EXCEEDED: 'FAILOVER',
      },
    },
  };
}

describe('FailureHealthMutationPolicyService (R5H4)', () => {
  // 1. no provenance => NO_MUTATION
  it('1. returns NO_MUTATION when providerResult has no provenance', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-1',
      status: 'FAILED',
      errorCode: 'AUTH_ERROR',
      error: 'Invalid API key',
    };

    const plan = FailureHealthMutationPolicyService.evaluate({ providerResult: result });
    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.accountId).toBeNull();
    expect(plan.category).toBeNull();
    expect(plan.reason).toContain('PROVENANCE_MISSING');
  });

  // 2. null account => NO_MUTATION
  it('2. returns NO_MUTATION when provenance has null accountId (legacy / non-fabric)', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-2',
      status: 'COMPLETED',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-2',
        accountId: null,
      }),
    };

    const plan = FailureHealthMutationPolicyService.evaluate({ providerResult: result });
    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.accountId).toBeNull();
    expect(plan.reason).toContain('NULL_OR_EMPTY_ACCOUNT_ID');
  });

  // 3. empty account => NO_MUTATION
  it('3. returns NO_MUTATION when provenance has whitespace/empty accountId', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-3',
      status: 'COMPLETED',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-3',
        accountId: '   ',
      }),
    };

    const plan = FailureHealthMutationPolicyService.evaluate({ providerResult: result });
    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.accountId).toBeNull();
    expect(plan.reason).toContain('NULL_OR_EMPTY_ACCOUNT_ID');
  });

  // 4. bad provenance version => NO_MUTATION
  it('4. returns NO_MUTATION when provenance version is not 1', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-4',
      status: 'COMPLETED',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-4',
        version: 2 as any,
      }),
    };

    const plan = FailureHealthMutationPolicyService.evaluate({ providerResult: result });
    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.reason).toContain('MALFORMED_PROVENANCE');
  });

  // 5. bad provenance source => NO_MUTATION
  it('5. returns NO_MUTATION when provenance source is not PROVIDER_DISPATCH_SERVICE', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-5',
      status: 'COMPLETED',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-5',
        source: 'ADAPTER' as any,
      }),
    };

    const plan = FailureHealthMutationPolicyService.evaluate({ providerResult: result });
    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.reason).toContain('MALFORMED_PROVENANCE');
  });

  // 6. executionId mismatch => NO_MUTATION
  it('6. returns NO_MUTATION when provenance executionId does not match result executionId', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-6-actual',
      status: 'COMPLETED',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-6-spoofed',
      }),
    };

    const plan = FailureHealthMutationPolicyService.evaluate({ providerResult: result });
    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.reason).toContain('INCOHERENT_EXECUTION_ID');
  });

  // 7. THREW + FAILED => NO_MUTATION
  it('7. returns NO_MUTATION with UNKNOWN category when adapterInvocation is THREW and status is FAILED', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-7',
      status: 'FAILED',
      errorCode: 'EXECUTION_FAILED',
      error: 'ADAPTER_EXECUTION_THREW: Crash',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-7',
        adapterInvocation: 'THREW',
      }),
    };

    const plan = FailureHealthMutationPolicyService.evaluate({ providerResult: result });
    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.accountId).toBe('acc-codex-1');
    expect(plan.category).toBe('UNKNOWN');
    expect(plan.cooldownDurationMs).toBeNull();
    expect(plan.reason).toContain('ADAPTER_THROW');
  });

  // 8. THREW + COMPLETED incoherent => NO_MUTATION
  it('8. returns NO_MUTATION when adapterInvocation THREW is paired incoherently with COMPLETED', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-8',
      status: 'COMPLETED',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-8',
        adapterInvocation: 'THREW',
      }),
    };

    const plan = FailureHealthMutationPolicyService.evaluate({ providerResult: result });
    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.reason).toContain('INCOHERENT_PROVENANCE_RESULT');
  });

  // 9. RETURNED + COMPLETED => RECORD_SUCCESS
  it('9. returns RECORD_SUCCESS with category SUCCESS when RETURNED adapter execution completes successfully', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-9',
      status: 'COMPLETED',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-9',
        adapterInvocation: 'RETURNED',
      }),
    };

    const plan = FailureHealthMutationPolicyService.evaluate({ providerResult: result });
    expect(plan.action).toBe('RECORD_SUCCESS');
    expect(plan.accountId).toBe('acc-codex-1');
    expect(plan.executionId).toBe('exec-9');
    expect(plan.authorizationId).toBe('auth-123');
    expect(plan.category).toBe('SUCCESS');
    expect(plan.cooldownDurationMs).toBeNull();
    expect(plan.reason).toContain('COMPLETED_SUCCESS');
  });

  // 10. RETURNED + AWAITING_OWNER => NO_MUTATION
  it('10. returns NO_MUTATION with category AWAITING_OWNER when status is AWAITING_OWNER', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-10',
      status: 'AWAITING_OWNER',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-10',
        adapterInvocation: 'RETURNED',
      }),
    };

    const plan = FailureHealthMutationPolicyService.evaluate({ providerResult: result });
    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.accountId).toBe('acc-codex-1');
    expect(plan.category).toBe('AWAITING_OWNER');
    expect(plan.cooldownDurationMs).toBeNull();
    expect(plan.reason).toContain('AWAITING_OWNER');
  });

  // 11. QUOTA_EXHAUSTED + rate-limit text + valid enabled policy cooldown => RECORD_RATE_LIMITED
  it('11. returns RECORD_RATE_LIMITED with exact policy cooldown duration when rate limited and policy is valid & enabled', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-11',
      status: 'FAILED',
      errorCode: 'QUOTA_EXHAUSTED',
      error: 'HTTP 429 Too Many Requests: Rate limit reached',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-11',
      }),
    };

    const policyResult = makeValidPolicy(120000);
    const plan = FailureHealthMutationPolicyService.evaluate({
      providerResult: result,
      policyResult,
    });

    expect(plan.action).toBe('RECORD_RATE_LIMITED');
    expect(plan.accountId).toBe('acc-codex-1');
    expect(plan.category).toBe('RATE_LIMITED');
    expect(plan.cooldownDurationMs).toBe(120000);
    expect(plan.reason).toContain('RATE_LIMITED');
  });

  // 12. same rate-limit with ABSENT policy => NO_MUTATION
  it('12. returns NO_MUTATION when rate limited but policy is ABSENT (no invented cooldown)', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-12',
      status: 'FAILED',
      errorCode: 'QUOTA_EXHAUSTED',
      error: 'rate limit exceeded',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-12',
      }),
    };

    const plan = FailureHealthMutationPolicyService.evaluate({
      providerResult: result,
      policyResult: { status: 'ABSENT' },
    });

    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.accountId).toBe('acc-codex-1');
    expect(plan.category).toBe('RATE_LIMITED');
    expect(plan.cooldownDurationMs).toBeNull();
    expect(plan.reason).toContain('RATE_LIMITED_EXPLICIT_COOLDOWN_REQUIRED');
  });

  // 13. same rate-limit with INVALID policy => NO_MUTATION
  it('13. returns NO_MUTATION when rate limited but policy is INVALID', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-13',
      status: 'FAILED',
      errorCode: 'QUOTA_EXHAUSTED',
      error: 'rate limited',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-13',
      }),
    };

    const plan = FailureHealthMutationPolicyService.evaluate({
      providerResult: result,
      policyResult: { status: 'INVALID', error: 'Malformed policy' },
    });

    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.category).toBe('RATE_LIMITED');
    expect(plan.cooldownDurationMs).toBeNull();
    expect(plan.reason).toContain('RATE_LIMITED_EXPLICIT_COOLDOWN_REQUIRED');
  });

  // 14. same rate-limit with disabled policy => NO_MUTATION
  it('14. returns NO_MUTATION when rate limited but policy is disabled', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-14',
      status: 'FAILED',
      errorCode: 'QUOTA_EXHAUSTED',
      error: '429 rate limit',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-14',
      }),
    };

    const policyResult: FailoverPolicyParseResult = {
      status: 'VALID',
      policy: {
        version: 1,
        enabled: false,
      },
    };

    const plan = FailureHealthMutationPolicyService.evaluate({
      providerResult: result,
      policyResult,
    });

    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.category).toBe('RATE_LIMITED');
    expect(plan.cooldownDurationMs).toBeNull();
    expect(plan.reason).toContain('RATE_LIMITED_EXPLICIT_COOLDOWN_REQUIRED');
  });

  // 15. same rate-limit with enabled policy but no cooldown => NO_MUTATION
  it('15. returns NO_MUTATION when rate limited and policy is enabled but has no cooldown_duration_ms', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-15',
      status: 'FAILED',
      errorCode: 'QUOTA_EXHAUSTED',
      error: 'rate limit reached',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-15',
      }),
    };

    const policyResult: FailoverPolicyParseResult = {
      status: 'VALID',
      policy: {
        version: 1,
        enabled: true,
        max_failover_attempts: 3,
        same_account_retries: 0,
        allow_cross_account: true,
        allow_cross_provider: true,
        // cooldown_duration_ms omitted
      },
    };

    const plan = FailureHealthMutationPolicyService.evaluate({
      providerResult: result,
      policyResult,
    });

    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.category).toBe('RATE_LIMITED');
    expect(plan.cooldownDurationMs).toBeNull();
    expect(plan.reason).toContain('RATE_LIMITED_EXPLICIT_COOLDOWN_REQUIRED');
  });

  // 16. plain QUOTA_EXHAUSTED => RECORD_QUOTA_EXHAUSTED
  it('16. returns RECORD_QUOTA_EXHAUSTED for plain quota exhaustion without rate limit text', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-16',
      status: 'FAILED',
      errorCode: 'QUOTA_EXHAUSTED',
      error: 'Monthly usage limit reached on account billing tier.',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-16',
      }),
    };

    const plan = FailureHealthMutationPolicyService.evaluate({ providerResult: result });
    expect(plan.action).toBe('RECORD_QUOTA_EXHAUSTED');
    expect(plan.accountId).toBe('acc-codex-1');
    expect(plan.category).toBe('QUOTA_EXHAUSTED');
    expect(plan.cooldownDurationMs).toBeNull();
    expect(plan.reason).toContain('QUOTA_EXHAUSTED');
  });

  // 17. quota action ignores policy cooldown_duration_ms
  it('17. verifies plain QUOTA_EXHAUSTED outputs cooldownDurationMs=null even when policy provides a cooldown', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-17',
      status: 'FAILED',
      errorCode: 'QUOTA_EXHAUSTED',
      error: 'Monthly token credits depleted.',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-17',
      }),
    };

    const policyResult = makeValidPolicy(300000);
    const plan = FailureHealthMutationPolicyService.evaluate({
      providerResult: result,
      policyResult,
    });

    expect(plan.action).toBe('RECORD_QUOTA_EXHAUSTED');
    expect(plan.category).toBe('QUOTA_EXHAUSTED');
    expect(plan.cooldownDurationMs).toBeNull();
  });

  // 18. AUTH_ERROR => RECORD_AUTH_ERROR
  it('18. returns RECORD_AUTH_ERROR for authentic AUTH_ERROR failure with trusted provenance', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-18',
      status: 'FAILED',
      errorCode: 'AUTH_ERROR',
      error: 'Invalid API credential or token revoked',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-18',
      }),
    };

    const plan = FailureHealthMutationPolicyService.evaluate({ providerResult: result });
    expect(plan.action).toBe('RECORD_AUTH_ERROR');
    expect(plan.accountId).toBe('acc-codex-1');
    expect(plan.category).toBe('AUTHENTICATION_FAILURE');
    expect(plan.cooldownDurationMs).toBeNull();
    expect(plan.reason).toContain('AUTHENTICATION_FAILURE');
  });

  // 19. RESOURCE_UNAVAILABLE => NO_MUTATION
  it('19. returns NO_MUTATION for RESOURCE_UNAVAILABLE because semantic scope is unresolved', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-19',
      status: 'FAILED',
      errorCode: 'RESOURCE_UNAVAILABLE',
      error: 'Model gpt-5-preview is currently overloaded in region us-east',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-19',
      }),
    };

    const plan = FailureHealthMutationPolicyService.evaluate({ providerResult: result });
    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.accountId).toBe('acc-codex-1');
    expect(plan.category).toBe('RESOURCE_UNAVAILABLE');
    expect(plan.cooldownDurationMs).toBeNull();
    expect(plan.reason).toContain('RESOURCE_UNAVAILABLE_SCOPE_UNRESOLVED');
  });

  // 20. CANCELLED => NO_MUTATION
  it('20. returns NO_MUTATION when execution status or errorCode is CANCELLED', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-20',
      status: 'CANCELLED',
      errorCode: 'CANCELLED',
      error: 'Execution cancelled by supervisor',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-20',
      }),
    };

    const plan = FailureHealthMutationPolicyService.evaluate({ providerResult: result });
    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.category).toBe('CANCELLED');
    expect(plan.cooldownDurationMs).toBeNull();
  });

  // 21. POLICY_DENIAL => NO_MUTATION
  it('21. returns NO_MUTATION for POLICY_DENIAL (security boundary should not poison account)', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-21',
      status: 'FAILED',
      errorCode: 'POLICY_DENIAL',
      error: 'Path access forbidden',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-21',
      }),
    };

    const plan = FailureHealthMutationPolicyService.evaluate({ providerResult: result });
    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.category).toBe('POLICY_DENIAL');
    expect(plan.cooldownDurationMs).toBeNull();
  });

  // 22. PROTOCOL_INVALID => NO_MUTATION
  it('22. returns NO_MUTATION for PROTOCOL_INVALID (format/output defect is not account health failure)', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-22',
      status: 'FAILED',
      errorCode: 'PROTOCOL_INVALID',
      error: 'Malformed JSON output',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-22',
      }),
    };

    const plan = FailureHealthMutationPolicyService.evaluate({ providerResult: result });
    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.category).toBe('PROTOCOL_INVALID');
    expect(plan.cooldownDurationMs).toBeNull();
  });

  // 23. PROCESS_LAUNCH_FAILED => NO_MUTATION
  it('23. returns NO_MUTATION for PROCESS_LAUNCH_FAILED (local CLI/OS launch failure)', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-23',
      status: 'FAILED',
      errorCode: 'PROCESS_LAUNCH_FAILED',
      error: 'ENOENT: codex binary not found',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-23',
      }),
    };

    const plan = FailureHealthMutationPolicyService.evaluate({ providerResult: result });
    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.category).toBe('LOCAL_PROCESS_FAILURE');
    expect(plan.cooldownDurationMs).toBeNull();
  });

  // 24. TIMEOUT => NO_MUTATION
  it('24. returns NO_MUTATION for TIMEOUT (task duration limit is not account failure)', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-24',
      status: 'FAILED',
      errorCode: 'TIMEOUT',
      error: 'Execution timed out after 300000ms',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-24',
      }),
    };

    const policyResult = makeValidPolicy();
    const plan = FailureHealthMutationPolicyService.evaluate({
      providerResult: result,
      policyResult,
    });

    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.category).toBe('TIMEOUT');
    expect(plan.cooldownDurationMs).toBeNull();
  });

  // 25. NONZERO_EXIT => NO_MUTATION
  it('25. returns NO_MUTATION for NONZERO_EXIT (process exit code is task level failure)', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-25',
      status: 'FAILED',
      errorCode: 'NONZERO_EXIT',
      error: 'Process exited with code 1',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-25',
      }),
    };

    const plan = FailureHealthMutationPolicyService.evaluate({ providerResult: result });
    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.category).toBe('NONZERO_EXIT');
    expect(plan.cooldownDurationMs).toBeNull();
  });

  // 26. OUTPUT_LIMIT_EXCEEDED => NO_MUTATION
  it('26. returns NO_MUTATION for OUTPUT_LIMIT_EXCEEDED', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-26',
      status: 'FAILED',
      errorCode: 'OUTPUT_LIMIT_EXCEEDED',
      error: 'Output byte limit exceeded',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-26',
      }),
    };

    const plan = FailureHealthMutationPolicyService.evaluate({ providerResult: result });
    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.category).toBe('OUTPUT_LIMIT_EXCEEDED');
    expect(plan.cooldownDurationMs).toBeNull();
  });

  // 27. UNSUPPORTED_CLIENT => NO_MUTATION
  it('27. returns NO_MUTATION with UNKNOWN category for UNSUPPORTED_CLIENT', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-27',
      status: 'FAILED',
      errorCode: 'UNSUPPORTED_CLIENT',
      error: 'Unsupported client feature',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-27',
      }),
    };

    const plan = FailureHealthMutationPolicyService.evaluate({ providerResult: result });
    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.category).toBe('UNKNOWN');
    expect(plan.cooldownDurationMs).toBeNull();
  });

  // 28. EXECUTION_FAILED => NO_MUTATION
  it('28. returns NO_MUTATION with UNKNOWN category for generic EXECUTION_FAILED', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-28',
      status: 'FAILED',
      errorCode: 'EXECUTION_FAILED',
      error: 'Generic execution failure',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-28',
      }),
    };

    const plan = FailureHealthMutationPolicyService.evaluate({ providerResult: result });
    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.category).toBe('UNKNOWN');
    expect(plan.cooldownDurationMs).toBeNull();
  });

  // 29. UNKNOWN => NO_MUTATION
  it('29. returns NO_MUTATION for unknown/unclassified error codes', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-29',
      status: 'FAILED',
      errorCode: 'SOME_UNRECOGNIZED_CODE' as any,
      error: 'Something strange happened',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-29',
      }),
    };

    const plan = FailureHealthMutationPolicyService.evaluate({ providerResult: result });
    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.category).toBe('UNKNOWN');
    expect(plan.cooldownDurationMs).toBeNull();
  });

  // 30. rawResponse contains 429 but ordinary quota error does NOT become rate limit
  it('30. proves rawResponse is ignored and error text alone governs rate-limit classification', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-30',
      status: 'FAILED',
      errorCode: 'QUOTA_EXHAUSTED',
      error: 'Monthly allowance exhausted',
      rawResponse: { httpStatus: 429, message: 'rate limit in rawResponse' } as any,
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-30',
      }),
    };

    const policyResult = makeValidPolicy(60000);
    const plan = FailureHealthMutationPolicyService.evaluate({
      providerResult: result,
      policyResult,
    });

    // Because error text does NOT contain rate limit regex, it remains QUOTA_EXHAUSTED
    expect(plan.action).toBe('RECORD_QUOTA_EXHAUSTED');
    expect(plan.category).toBe('QUOTA_EXHAUSTED');
    expect(plan.cooldownDurationMs).toBeNull();
  });

  // 31. error text 429 on AUTH_ERROR does not become rate limit
  it('31. proves rate limit regex is strictly scoped to QUOTA_EXHAUSTED errorCode, not AUTH_ERROR', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-31',
      status: 'FAILED',
      errorCode: 'AUTH_ERROR',
      error: '429 Token revoked / Rate limit on auth endpoint',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-31',
      }),
    };

    const policyResult = makeValidPolicy(60000);
    const plan = FailureHealthMutationPolicyService.evaluate({
      providerResult: result,
      policyResult,
    });

    expect(plan.action).toBe('RECORD_AUTH_ERROR');
    expect(plan.category).toBe('AUTHENTICATION_FAILURE');
    expect(plan.cooldownDurationMs).toBeNull();
  });

  // 32. plan never contains rawResponse/stdout/stderr/secrets
  it('32. verifies output plan contains zero secret-bearing, raw error, or process stream fields', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-32',
      status: 'FAILED',
      errorCode: 'QUOTA_EXHAUSTED',
      error: 'Secret key sk-12345 exhausted rate limit: 429',
      stdoutEvidenceId: 'stdout-1',
      stderrEvidenceId: 'stderr-1',
      rawResponse: { secretToken: 'secret-xyz' } as any,
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-32',
      }),
    };

    const policyResult = makeValidPolicy(60000);
    const plan = FailureHealthMutationPolicyService.evaluate({
      providerResult: result,
      policyResult,
    });

    const keys = Object.keys(plan);
    const forbiddenKeys = [
      'credential_ref',
      'profile_ref',
      'token',
      'password',
      'secret',
      'rawResponse',
      'stdout',
      'stderr',
      'stdoutEvidenceId',
      'stderrEvidenceId',
      'error',
    ];

    for (const forbidden of forbiddenKeys) {
      expect(keys).not.toContain(forbidden);
    }
    expect(plan.reason).not.toContain('sk-12345');
    expect(plan.reason).not.toContain('secret-xyz');
  });

  // 33. policy FAILOVER/STOP is irrelevant to health action for TIMEOUT
  it('33. verifies policy failure_actions (FAILOVER vs STOP) do not alter health action for TIMEOUT', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-33',
      status: 'FAILED',
      errorCode: 'TIMEOUT',
      error: 'Timed out',
      providerExecutionProvenance: makeProvenance({
        executionId: 'exec-33',
      }),
    };

    const policyFailover: FailoverPolicyParseResult = {
      status: 'VALID',
      policy: {
        version: 1,
        enabled: true,
        max_failover_attempts: 3,
        same_account_retries: 0,
        allow_cross_account: true,
        allow_cross_provider: true,
        failure_actions: { TIMEOUT: 'FAILOVER' },
      },
    };

    const policyStop: FailoverPolicyParseResult = {
      status: 'VALID',
      policy: {
        version: 1,
        enabled: true,
        max_failover_attempts: 3,
        same_account_retries: 0,
        allow_cross_account: true,
        allow_cross_provider: true,
        failure_actions: { TIMEOUT: 'STOP' },
      },
    };

    const planFailover = FailureHealthMutationPolicyService.evaluate({
      providerResult: result,
      policyResult: policyFailover,
    });
    const planStop = FailureHealthMutationPolicyService.evaluate({
      providerResult: result,
      policyResult: policyStop,
    });

    expect(planFailover.action).toBe('NO_MUTATION');
    expect(planStop.action).toBe('NO_MUTATION');
  });

  // 34. policy parse input not required for quota/auth/success semantics
  it('34. verifies policyResult is completely optional for SUCCESS, QUOTA_EXHAUSTED, and AUTH_ERROR', () => {
    const successResult: ProviderDispatchExecutionResult = {
      executionId: 'exec-34a',
      status: 'COMPLETED',
      providerExecutionProvenance: makeProvenance({ executionId: 'exec-34a' }),
    };
    const quotaResult: ProviderDispatchExecutionResult = {
      executionId: 'exec-34b',
      status: 'FAILED',
      errorCode: 'QUOTA_EXHAUSTED',
      error: 'Credits depleted',
      providerExecutionProvenance: makeProvenance({ executionId: 'exec-34b' }),
    };
    const authResult: ProviderDispatchExecutionResult = {
      executionId: 'exec-34c',
      status: 'FAILED',
      errorCode: 'AUTH_ERROR',
      error: 'Bad key',
      providerExecutionProvenance: makeProvenance({ executionId: 'exec-34c' }),
    };

    expect(FailureHealthMutationPolicyService.evaluate({ providerResult: successResult }).action).toBe('RECORD_SUCCESS');
    expect(FailureHealthMutationPolicyService.evaluate({ providerResult: quotaResult }).action).toBe('RECORD_QUOTA_EXHAUSTED');
    expect(FailureHealthMutationPolicyService.evaluate({ providerResult: authResult }).action).toBe('RECORD_AUTH_ERROR');
  });

  // 35. rate-limit output copies exact cooldown_duration_ms without Date.now
  it('35. verifies rate-limit output preserves exact policy cooldown_duration_ms integer without wall-clock timestamps', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-35',
      status: 'FAILED',
      errorCode: 'QUOTA_EXHAUSTED',
      error: '429 Rate limit reached',
      providerExecutionProvenance: makeProvenance({ executionId: 'exec-35' }),
    };

    const policyResult = makeValidPolicy(45000);
    const plan = FailureHealthMutationPolicyService.evaluate({
      providerResult: result,
      policyResult,
    });

    expect(plan.action).toBe('RECORD_RATE_LIMITED');
    expect(plan.cooldownDurationMs).toBe(45000);
    // Ensure no ISO date string or timestamp calculation was added
    expect((plan as any).cooldownUntil).toBeUndefined();
  });

  // 36. returned CANCELLED with provenance remains NO_MUTATION
  it('36. verifies provider-returned CANCELLED with proven adapter execution remains NO_MUTATION', () => {
    const result: ProviderDispatchExecutionResult = {
      executionId: 'exec-36',
      status: 'CANCELLED',
      errorCode: 'CANCELLED',
      error: 'Provider task aborted by user',
      providerExecutionProvenance: makeProvenance({ executionId: 'exec-36' }),
    };

    const plan = FailureHealthMutationPolicyService.evaluate({ providerResult: result });
    expect(plan.action).toBe('NO_MUTATION');
    expect(plan.category).toBe('CANCELLED');
    expect(plan.cooldownDurationMs).toBeNull();
  });

  // 37. Source boundary test: proves FailureHealthMutationPolicyService has zero forbidden imports
  it('37. Source boundary test: proves FailureHealthMutationPolicyService has zero forbidden imports/dependencies', () => {
    const servicePath = path.resolve(__dirname, '../src/core/services/FailureHealthMutationPolicyService.ts');
    const content = fs.readFileSync(servicePath, 'utf-8');

    const forbiddenTerms = [
      'AccountHealthService',
      'Repository',
      'Database',
      'FailoverDecisionService',
      'FailoverLineageService',
      'FailoverNextRoutePolicyService',
      'RoleAwareRoutingService',
      'ConcurrentExecutionScheduler',
      'ExecutionAuthorizationService',
      'ProviderRegistry',
      'Date.now',
      'new Date',
      'updateProviderAccountHealth',
    ];

    for (const term of forbiddenTerms) {
      expect(content).not.toContain(term);
    }
  });
});
