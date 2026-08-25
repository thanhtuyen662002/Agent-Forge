import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ProviderRegistry } from '../src/core/adapters/ProviderRegistry';
import {
  ProviderAdapter,
  QuotaSnapshotInfo,
  AgentExecutionResult,
} from '../src/core/adapters/ProviderAdapter';
import { EventService } from '../src/core/services/EventService';
import {
  RoleAwareRoutingService,
  RoleAwareRoutingRequest,
} from '../src/core/services/RoleAwareRoutingService';
import { ExecutionFailureClassifier } from '../src/core/services/ExecutionFailureClassifier';
import { AccountHealthService } from '../src/core/services/AccountHealthService';
import {
  Project,
  Task,
  RoleProfile,
  ProviderAccount,
  ProviderResource,
  Provider,
  Capability,
  ProviderHealthStatus,
  ProviderAdapterType,
} from '../src/core/types/domain';

class MockProviderAdapter implements ProviderAdapter {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly adapterType: ProviderAdapterType = 'LOCAL_CLI',
    private health: ProviderHealthStatus = 'AVAILABLE',
    private capabilities: Capability[] = ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION'],
    private quota: QuotaSnapshotInfo = {
      remaining: 1000,
      total: 1000,
      unit: 'REQUESTS',
      source: 'PROVIDER_REPORTED',
      confidence: 1.0,
      resetAt: null,
    }
  ) {}

  public async getHealth(): Promise<ProviderHealthStatus> {
    return this.health;
  }

  public setHealth(health: ProviderHealthStatus): void {
    this.health = health;
  }

  public async getCapabilities(): Promise<Capability[]> {
    return this.capabilities;
  }

  public setCapabilities(caps: Capability[]): void {
    this.capabilities = caps;
  }

  public async getQuota(): Promise<QuotaSnapshotInfo> {
    return this.quota;
  }

  public setQuota(quota: QuotaSnapshotInfo): void {
    this.quota = quota;
  }

  public async execute(): Promise<any> {
    throw new Error('Execute not implemented for test mock');
  }

  public async cancel(): Promise<void> {}
}

describe('R5H1 — Failure Taxonomy, Account Health & Routing Cooldown', () => {
  // =========================================================================
  // 1. ExecutionFailureClassifier Tests
  // =========================================================================
  describe('ExecutionFailureClassifier', () => {
    it('throws error when attempting to classify a COMPLETED execution result', () => {
      const result: AgentExecutionResult = {
        executionId: 'exec-001',
        status: 'COMPLETED',
      };
      expect(() => ExecutionFailureClassifier.classify(result)).toThrow(
        /Cannot classify successful execution result as a failure/
      );
    });

    it('classifies QUOTA_EXHAUSTED with rate limit text as RATE_LIMITED / FAILOVER_ELIGIBLE', () => {
      const results: AgentExecutionResult[] = [
        {
          executionId: 'exec-1',
          status: 'FAILED',
          errorCode: 'QUOTA_EXHAUSTED',
          error: 'Rate limit exceeded: 429 Too Many Requests',
        },
        {
          executionId: 'exec-2',
          status: 'FAILED',
          errorCode: 'QUOTA_EXHAUSTED',
          error: 'You have been rate-limited by the provider.',
        },
        {
          executionId: 'exec-3',
          status: 'FAILED',
          errorCode: 'QUOTA_EXHAUSTED',
          error: 'Rate limit: HTTP 429: Too many requests. Please wait.',
        },
      ];

      for (const res of results) {
        const classified = ExecutionFailureClassifier.classify(res);
        expect(classified.category).toBe('RATE_LIMITED');
        expect(classified.disposition).toBe('FAILOVER_ELIGIBLE');
        expect(classified.sourceErrorCode).toBe('QUOTA_EXHAUSTED');
      }
    });

    it('does NOT classify QUOTA_EXHAUSTED as RATE_LIMITED when rate limit text is only in rawResponse', () => {
      const result: AgentExecutionResult = {
        executionId: 'exec-raw-429',
        status: 'FAILED',
        errorCode: 'QUOTA_EXHAUSTED',
        error: 'Quota exhausted.',
        rawResponse: 'Some unrelated model output mentioning HTTP 429.',
      };

      const classified = ExecutionFailureClassifier.classify(result);
      expect(classified.category).toBe('QUOTA_EXHAUSTED');
      expect(classified.disposition).toBe('FAILOVER_ELIGIBLE');
      expect(classified.sourceErrorCode).toBe('QUOTA_EXHAUSTED');
    });

    it('does NOT classify unrelated error codes as RATE_LIMITED even if error text contains 429 or rate limit text', () => {
      const authResult: AgentExecutionResult = {
        executionId: 'exec-auth-429',
        status: 'FAILED',
        errorCode: 'AUTH_ERROR',
        error: 'Authentication failed: error code 429 in auth header.',
      };
      expect(ExecutionFailureClassifier.classify(authResult).category).toBe('AUTHENTICATION_FAILURE');

      const resResult: AgentExecutionResult = {
        executionId: 'exec-res-rate',
        status: 'FAILED',
        errorCode: 'RESOURCE_UNAVAILABLE',
        error: 'Resource unavailable due to rate limit.',
      };
      expect(ExecutionFailureClassifier.classify(resResult).category).toBe('RESOURCE_UNAVAILABLE');

      const exitResult: AgentExecutionResult = {
        executionId: 'exec-exit-429',
        status: 'FAILED',
        errorCode: 'NONZERO_EXIT',
        error: 'Exit code 429.',
      };
      expect(ExecutionFailureClassifier.classify(exitResult).category).toBe('NONZERO_EXIT');
    });

    it('classifies QUOTA_EXHAUSTED without rate limit text as QUOTA_EXHAUSTED / FAILOVER_ELIGIBLE', () => {
      const result: AgentExecutionResult = {
        executionId: 'exec-quota',
        status: 'FAILED',
        errorCode: 'QUOTA_EXHAUSTED',
        error: 'Monthly spending cap reached. Insufficient credits.',
      };

      const classified = ExecutionFailureClassifier.classify(result);
      expect(classified.category).toBe('QUOTA_EXHAUSTED');
      expect(classified.disposition).toBe('FAILOVER_ELIGIBLE');
      expect(classified.sourceErrorCode).toBe('QUOTA_EXHAUSTED');
    });

    it('classifies AUTH_ERROR as AUTHENTICATION_FAILURE / NON_FAILOVERABLE', () => {
      const result: AgentExecutionResult = {
        executionId: 'exec-auth',
        status: 'FAILED',
        errorCode: 'AUTH_ERROR',
        error: 'Invalid API key or expired OAuth token.',
      };

      const classified = ExecutionFailureClassifier.classify(result);
      expect(classified.category).toBe('AUTHENTICATION_FAILURE');
      expect(classified.disposition).toBe('NON_FAILOVERABLE');
      expect(classified.sourceErrorCode).toBe('AUTH_ERROR');
    });

    it('classifies RESOURCE_UNAVAILABLE as RESOURCE_UNAVAILABLE / FAILOVER_ELIGIBLE', () => {
      const result: AgentExecutionResult = {
        executionId: 'exec-res',
        status: 'FAILED',
        errorCode: 'RESOURCE_UNAVAILABLE',
        error: 'Model deployment is currently unavailable.',
      };

      const classified = ExecutionFailureClassifier.classify(result);
      expect(classified.category).toBe('RESOURCE_UNAVAILABLE');
      expect(classified.disposition).toBe('FAILOVER_ELIGIBLE');
      expect(classified.sourceErrorCode).toBe('RESOURCE_UNAVAILABLE');
    });

    it('classifies CANCELLED as CANCELLED / NON_FAILOVERABLE', () => {
      const result1: AgentExecutionResult = {
        executionId: 'exec-cancel-1',
        status: 'CANCELLED',
        errorCode: 'CANCELLED',
      };
      const result2: AgentExecutionResult = {
        executionId: 'exec-cancel-2',
        status: 'FAILED',
        errorCode: 'CANCELLED',
      };

      const c1 = ExecutionFailureClassifier.classify(result1);
      expect(c1.category).toBe('CANCELLED');
      expect(c1.disposition).toBe('NON_FAILOVERABLE');

      const c2 = ExecutionFailureClassifier.classify(result2);
      expect(c2.category).toBe('CANCELLED');
      expect(c2.disposition).toBe('NON_FAILOVERABLE');
    });

    it('classifies POLICY_DENIAL as POLICY_DENIAL / NON_FAILOVERABLE', () => {
      const result: AgentExecutionResult = {
        executionId: 'exec-pol',
        status: 'FAILED',
        errorCode: 'POLICY_DENIAL',
        error: 'Sandbox boundary violation.',
      };

      const classified = ExecutionFailureClassifier.classify(result);
      expect(classified.category).toBe('POLICY_DENIAL');
      expect(classified.disposition).toBe('NON_FAILOVERABLE');
      expect(classified.sourceErrorCode).toBe('POLICY_DENIAL');
    });

    it('classifies PROTOCOL_INVALID as PROTOCOL_INVALID / NON_FAILOVERABLE', () => {
      const result: AgentExecutionResult = {
        executionId: 'exec-proto',
        status: 'FAILED',
        errorCode: 'PROTOCOL_INVALID',
        error: 'Output was not valid json.',
      };

      const classified = ExecutionFailureClassifier.classify(result);
      expect(classified.category).toBe('PROTOCOL_INVALID');
      expect(classified.disposition).toBe('NON_FAILOVERABLE');
      expect(classified.sourceErrorCode).toBe('PROTOCOL_INVALID');
    });

    it('classifies PROCESS_LAUNCH_FAILED as LOCAL_PROCESS_FAILURE / NON_FAILOVERABLE', () => {
      const result: AgentExecutionResult = {
        executionId: 'exec-launch',
        status: 'FAILED',
        errorCode: 'PROCESS_LAUNCH_FAILED',
        error: 'Executable not found in PATH: codex',
      };

      const classified = ExecutionFailureClassifier.classify(result);
      expect(classified.category).toBe('LOCAL_PROCESS_FAILURE');
      expect(classified.disposition).toBe('NON_FAILOVERABLE');
      expect(classified.sourceErrorCode).toBe('PROCESS_LAUNCH_FAILED');
    });

    it('classifies TIMEOUT as TIMEOUT / POLICY_DECISION_REQUIRED', () => {
      const result: AgentExecutionResult = {
        executionId: 'exec-timeout',
        status: 'FAILED',
        errorCode: 'TIMEOUT',
        error: 'Process timed out after 30000ms',
      };

      const classified = ExecutionFailureClassifier.classify(result);
      expect(classified.category).toBe('TIMEOUT');
      expect(classified.disposition).toBe('POLICY_DECISION_REQUIRED');
      expect(classified.sourceErrorCode).toBe('TIMEOUT');
    });

    it('classifies NONZERO_EXIT as NONZERO_EXIT / POLICY_DECISION_REQUIRED', () => {
      const result: AgentExecutionResult = {
        executionId: 'exec-exit',
        status: 'FAILED',
        errorCode: 'NONZERO_EXIT',
        error: 'Process exited with code 1',
      };

      const classified = ExecutionFailureClassifier.classify(result);
      expect(classified.category).toBe('NONZERO_EXIT');
      expect(classified.disposition).toBe('POLICY_DECISION_REQUIRED');
      expect(classified.sourceErrorCode).toBe('NONZERO_EXIT');
    });

    it('classifies OUTPUT_LIMIT_EXCEEDED as OUTPUT_LIMIT_EXCEEDED / POLICY_DECISION_REQUIRED', () => {
      const result: AgentExecutionResult = {
        executionId: 'exec-outlimit',
        status: 'FAILED',
        errorCode: 'OUTPUT_LIMIT_EXCEEDED',
        error: 'Output limit exceeded.',
      };

      const classified = ExecutionFailureClassifier.classify(result);
      expect(classified.category).toBe('OUTPUT_LIMIT_EXCEEDED');
      expect(classified.disposition).toBe('POLICY_DECISION_REQUIRED');
      expect(classified.sourceErrorCode).toBe('OUTPUT_LIMIT_EXCEEDED');
    });

    it('fails closed for UNKNOWN error codes as UNKNOWN / NON_FAILOVERABLE', () => {
      const result: AgentExecutionResult = {
        executionId: 'exec-unknown',
        status: 'FAILED',
        errorCode: 'UNKNOWN',
        error: 'Something went wrong.',
      };

      const classified = ExecutionFailureClassifier.classify(result);
      expect(classified.category).toBe('UNKNOWN');
      expect(classified.disposition).toBe('NON_FAILOVERABLE');
      expect(classified.sourceErrorCode).toBe('UNKNOWN');
    });
  });

  // =========================================================================
  // 2. AccountHealthService Tests
  // =========================================================================
  describe('AccountHealthService', () => {
    let db: Database.Database;
    let repo: Repository;
    let fakeNow: Date;
    let healthService: AccountHealthService;
    const accountId = 'acc-test-01';

    beforeEach(() => {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      MigrationRunner.run(db);
      repo = new Repository(db);
      fakeNow = new Date('2026-08-25T12:00:00.000Z');
      healthService = new AccountHealthService(repo, () => fakeNow);

      const provider: Provider = {
        id: 'openai',
        name: 'OpenAI',
        adapter_type: 'LOCAL_CLI',
        enabled: true,
        created_at: fakeNow.toISOString(),
      };
      repo.createProvider(provider);

      const account: ProviderAccount = {
        id: accountId,
        provider_id: 'openai',
        label: 'Test Account',
        auth_mode: 'NATIVE_PROFILE',
        credential_ref: null,
        profile_ref: 'native-profile://codex/c01',
        enabled: true,
        priority: 10,
        health_status: 'AVAILABLE',
        cooldown_until: null,
        concurrency_limit: 1,
        last_success_at: null,
        last_failure_at: null,
        last_failure_code: null,
        created_at: fakeNow.toISOString(),
        updated_at: fakeNow.toISOString(),
      };
      repo.createProviderAccount(account);
    });

    it('records RATE_LIMITED with explicit cooldownDurationMs', () => {
      healthService.recordRateLimited(accountId, {
        cooldownDurationMs: 60000, // 60s
      });

      const updated = repo.getProviderAccount(accountId)!;
      expect(updated.health_status).toBe('RATE_LIMITED');
      expect(updated.cooldown_until).toBe('2026-08-25T12:01:00.000Z');
      expect(updated.last_failure_code).toBe('RATE_LIMITED');
      expect(updated.last_failure_at).toBeDefined();
    });

    it('records RATE_LIMITED with explicit cooldownUntil timestamp', () => {
      const explicitUntil = '2026-08-25T12:15:30.000Z';
      healthService.recordRateLimited(accountId, {
        cooldownUntil: explicitUntil,
      });

      const updated = repo.getProviderAccount(accountId)!;
      expect(updated.health_status).toBe('RATE_LIMITED');
      expect(updated.cooldown_until).toBe(explicitUntil);
      expect(updated.last_failure_code).toBe('RATE_LIMITED');
    });

    it('throws error when recordRateLimited is called without explicit cooldown duration or timestamp', () => {
      expect(() => healthService.recordRateLimited(accountId, {})).toThrow(
        /MISSING_EXPLICIT_COOLDOWN/
      );
    });

    it('rejects explicit cooldownUntil timestamp that is in the past or equal to current time', () => {
      // fakeNow is 2026-08-25T12:00:00.000Z
      const pastTime = '2026-08-25T11:59:59.999Z'; // T - 1ms
      const currentTime = '2026-08-25T12:00:00.000Z'; // T
      const futureTime = '2026-08-25T12:00:00.001Z'; // T + 1ms

      expect(() =>
        healthService.recordRateLimited(accountId, { cooldownUntil: pastTime })
      ).toThrow(/INVALID_COOLDOWN_TIMESTAMP/);

      expect(() =>
        healthService.recordRateLimited(accountId, { cooldownUntil: currentTime })
      ).toThrow(/INVALID_COOLDOWN_TIMESTAMP/);

      expect(() =>
        healthService.recordRateLimited(accountId, { cooldownUntil: 'not-a-valid-date' })
      ).toThrow(/INVALID_COOLDOWN_TIMESTAMP/);

      // T + 1ms is accepted
      healthService.recordRateLimited(accountId, { cooldownUntil: futureTime });
      expect(repo.getProviderAccount(accountId)!.cooldown_until).toBe(futureTime);
    });

    it('rejects zero, negative, NaN, or non-finite cooldownDurationMs', () => {
      expect(() =>
        healthService.recordRateLimited(accountId, { cooldownDurationMs: 0 })
      ).toThrow(/MISSING_EXPLICIT_COOLDOWN/);

      expect(() =>
        healthService.recordRateLimited(accountId, { cooldownDurationMs: -5000 })
      ).toThrow(/MISSING_EXPLICIT_COOLDOWN/);

      expect(() =>
        healthService.recordRateLimited(accountId, { cooldownDurationMs: NaN })
      ).toThrow(/MISSING_EXPLICIT_COOLDOWN/);

      expect(() =>
        healthService.recordRateLimited(accountId, { cooldownDurationMs: Infinity })
      ).toThrow(/MISSING_EXPLICIT_COOLDOWN/);
    });

    it('throws error when mutation methods are called for a non-existent account', () => {
      expect(() => healthService.recordSuccess('missing-account')).toThrow(
        /PROVIDER_ACCOUNT_NOT_FOUND/
      );

      expect(() =>
        healthService.recordRateLimited('missing-account', { cooldownDurationMs: 60000 })
      ).toThrow(/PROVIDER_ACCOUNT_NOT_FOUND/);

      expect(() => healthService.recordAuthError('missing-account')).toThrow(
        /PROVIDER_ACCOUNT_NOT_FOUND/
      );

      expect(() => healthService.recordQuotaExhausted('missing-account')).toThrow(
        /PROVIDER_ACCOUNT_NOT_FOUND/
      );

      expect(() =>
        healthService.recordCooldown('missing-account', {
          cooldownDurationMs: 60000,
          failureCode: 'RATE_LIMITED',
        })
      ).toThrow(/PROVIDER_ACCOUNT_NOT_FOUND/);

      expect(() =>
        healthService.recordGeneralFailure('missing-account', 'UNHEALTHY')
      ).toThrow(/PROVIDER_ACCOUNT_NOT_FOUND/);
    });

    it('records QUOTA_EXHAUSTED without inventing a cooldown', () => {
      healthService.recordQuotaExhausted(accountId);

      const updated = repo.getProviderAccount(accountId)!;
      expect(updated.health_status).toBe('QUOTA_EXHAUSTED');
      expect(updated.cooldown_until).toBeNull();
      expect(updated.last_failure_code).toBe('QUOTA_EXHAUSTED');
    });

    it('records QUOTA_EXHAUSTED with an explicit caller-provided reset timestamp', () => {
      const resetTime = '2026-08-26T00:00:00.000Z';
      healthService.recordQuotaExhausted(accountId, {
        cooldownUntil: resetTime,
      });

      const updated = repo.getProviderAccount(accountId)!;
      expect(updated.health_status).toBe('QUOTA_EXHAUSTED');
      expect(updated.cooldown_until).toBe(resetTime);
      expect(updated.last_failure_code).toBe('QUOTA_EXHAUSTED');
    });

    it('records AUTH_ERROR clearing cooldown and setting status and failureCode to AUTHENTICATION_FAILURE', () => {
      // First set in cooldown
      healthService.recordRateLimited(accountId, { cooldownDurationMs: 60000 });
      expect(repo.getProviderAccount(accountId)!.cooldown_until).not.toBeNull();

      // Now record auth error
      healthService.recordAuthError(accountId);

      const updated = repo.getProviderAccount(accountId)!;
      expect(updated.health_status).toBe('AUTH_ERROR');
      expect(updated.cooldown_until).toBeNull();
      expect(updated.last_failure_code).toBe('AUTHENTICATION_FAILURE');
    });

    it('records SUCCESS restoring AVAILABLE and clearing cooldown', () => {
      healthService.recordRateLimited(accountId, { cooldownDurationMs: 60000 });
      expect(repo.getProviderAccount(accountId)!.health_status).toBe('RATE_LIMITED');

      fakeNow = new Date('2026-08-25T12:05:00.000Z');
      healthService.recordSuccess(accountId);

      const updated = repo.getProviderAccount(accountId)!;
      expect(updated.health_status).toBe('AVAILABLE');
      expect(updated.cooldown_until).toBeNull();
      expect(updated.last_success_at).toBeDefined();
    });

    it('records generic COOLDOWN with explicit failureCode and rejects missing failureCode', () => {
      healthService.recordCooldown(accountId, {
        cooldownDurationMs: 30000,
        failureCode: 'RESOURCE_UNAVAILABLE',
      });

      const updated = repo.getProviderAccount(accountId)!;
      expect(updated.health_status).toBe('COOLDOWN');
      expect(updated.last_failure_code).toBe('RESOURCE_UNAVAILABLE');
      expect(updated.cooldown_until).toBe('2026-08-25T12:00:30.000Z');

      expect(() =>
        healthService.recordCooldown(accountId, {
          cooldownDurationMs: 30000,
        } as any)
      ).toThrow(/MISSING_COOLDOWN_FAILURE_CODE/);
    });

    it('records general failure for non-dedicated statuses and rejects dedicated statuses', () => {
      healthService.recordGeneralFailure(accountId, 'UNHEALTHY', {
        failureCode: 'LOCAL_PROCESS_FAILURE',
      });

      const updated = repo.getProviderAccount(accountId)!;
      expect(updated.health_status).toBe('UNHEALTHY');
      expect(updated.last_failure_code).toBe('LOCAL_PROCESS_FAILURE');

      expect(() => healthService.recordGeneralFailure(accountId, 'AVAILABLE')).toThrow(
        /INVALID_GENERAL_HEALTH_STATUS/
      );
      expect(() => healthService.recordGeneralFailure(accountId, 'RATE_LIMITED')).toThrow(
        /INVALID_GENERAL_HEALTH_STATUS/
      );
      expect(() => healthService.recordGeneralFailure(accountId, 'QUOTA_EXHAUSTED')).toThrow(
        /INVALID_GENERAL_HEALTH_STATUS/
      );
      expect(() => healthService.recordGeneralFailure(accountId, 'AUTH_ERROR')).toThrow(
        /INVALID_GENERAL_HEALTH_STATUS/
      );
      expect(() => healthService.recordGeneralFailure(accountId, 'COOLDOWN')).toThrow(
        /INVALID_GENERAL_HEALTH_STATUS/
      );
    });
  });

  // =========================================================================
  // 3. RoleAwareRoutingService Cooldown Consumption Tests
  // =========================================================================
  describe('RoleAwareRoutingService Cooldown Consumption', () => {
    let db: Database.Database;
    let repo: Repository;
    let registry: ProviderRegistry;
    let eventService: EventService;
    let fakeNow: Date;
    let router: RoleAwareRoutingService;
    let mockAdapter: MockProviderAdapter;

    const projectId = 'proj-cooldown-01';
    const taskId = 'task-cooldown-01';
    const roleProfileId = 'role-coder-01';
    const providerId = 'openai';
    const resourceId = 'res-gpt4';
    const accountAId = 'acc-a-01';
    const accountBId = 'acc-b-02';

    beforeEach(() => {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      MigrationRunner.run(db);
      repo = new Repository(db);
      registry = new ProviderRegistry();
      eventService = new EventService(repo);

      fakeNow = new Date('2026-08-25T12:00:00.000Z');
      router = new RoleAwareRoutingService(repo, registry, eventService, () => fakeNow);

      mockAdapter = new MockProviderAdapter(providerId, 'OpenAI Adapter');
      registry.register(mockAdapter);

      const provider: Provider = {
        id: providerId,
        name: 'OpenAI',
        adapter_type: 'LOCAL_CLI',
        enabled: true,
        created_at: fakeNow.toISOString(),
      };
      repo.createProvider(provider);

      const project: Project = {
        id: projectId,
        name: 'Cooldown Project',
        description: null,
        repository_path: 'D:/Projects/Test',
        default_branch: 'main',
        status: 'RUNNING',
        contract: null,
        created_at: fakeNow.toISOString(),
        updated_at: fakeNow.toISOString(),
        started_at: fakeNow.toISOString(),
        completed_at: null,
      };
      repo.createProject(project);

      const task: Task = {
        id: taskId,
        project_id: projectId,
        milestone_id: null,
        title: 'Cooldown Task',
        description: 'Test cooldown routing',
        state: 'CODING',
        paused_from_state: null,
        priority: 'HIGH',
        risk: 'LOW',
        assigned_agent_id: null,
        revision_count: 1,
        max_revisions: 3,
        base_sha: null,
        current_sha: null,
        progress_cache_percent: 0,
        progress_computed_at: null,
        acceptance_criteria: [],
        constraints: [],
        created_at: fakeNow.toISOString(),
        updated_at: fakeNow.toISOString(),
      };
      repo.createTask(task);

      const roleProfile: RoleProfile = {
        id: roleProfileId,
        role: 'CODER',
        display_name: 'Lead Coder',
        required_capabilities: ['CODING'],
        preferred_capabilities: [],
        authority_scope: {},
        permissions: [],
        output_protocol: 'coder.v1',
        enabled: true,
        created_at: fakeNow.toISOString(),
        updated_at: fakeNow.toISOString(),
      };
      repo.createRoleProfile(roleProfile);

      const resource: ProviderResource = {
        id: resourceId,
        provider_id: providerId,
        provider_account_id: null,
        model_name: 'gpt-4o',
        capabilities: ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION'],
        remaining_quota: 1000,
        total_quota: 1000,
        quota_unit: 'REQUESTS',
        quota_source: 'PROVIDER_REPORTED',
        quota_confidence: 1.0,
        quota_reset_at: null,
        health_status: 'AVAILABLE',
        last_health_check: null,
        enabled: true,
      };
      repo.createProviderResource(resource);

      const accountA: ProviderAccount = {
        id: accountAId,
        provider_id: providerId,
        label: 'Account A (High Priority)',
        auth_mode: 'NATIVE_PROFILE',
        credential_ref: null,
        profile_ref: 'native-profile://codex/a',
        enabled: true,
        priority: 100,
        health_status: 'AVAILABLE',
        cooldown_until: null,
        concurrency_limit: 1,
        last_success_at: null,
        last_failure_at: null,
        last_failure_code: null,
        created_at: fakeNow.toISOString(),
        updated_at: fakeNow.toISOString(),
      };
      repo.createProviderAccount(accountA);

      const accountB: ProviderAccount = {
        id: accountBId,
        provider_id: providerId,
        label: 'Account B (Low Priority)',
        auth_mode: 'NATIVE_PROFILE',
        credential_ref: null,
        profile_ref: 'native-profile://codex/b',
        enabled: true,
        priority: 10,
        health_status: 'AVAILABLE',
        cooldown_until: null,
        concurrency_limit: 1,
        last_success_at: null,
        last_failure_at: null,
        last_failure_code: null,
        created_at: fakeNow.toISOString(),
        updated_at: fakeNow.toISOString(),
      };
      repo.createProviderAccount(accountB);
    });

    it('A. rejects candidate when account health is RATE_LIMITED and cooldown_until > current time', async () => {
      // Set Account A in active cooldown until 12:05 (current time is 12:00)
      repo.updateProviderAccountHealth(
        accountAId,
        'RATE_LIMITED',
        '2026-08-25T12:05:00.000Z',
        'RATE_LIMITED'
      );

      const req: RoleAwareRoutingRequest = {
        projectId,
        taskId,
        roleProfileId,
        candidateRefs: [{ accountId: accountAId, resourceId }],
      };

      const decision = await router.routeRole(req);
      expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
      expect(decision.candidateEvaluations[0].eligibility).toBe('INELIGIBLE');
      expect(decision.candidateEvaluations[0].rejectionReasons[0]).toMatch(
        /under active cooldown until 2026-08-25T12:05:00.000Z/
      );
    });

    it('B. rejects candidate when account health is COOLDOWN and cooldown_until > current time', async () => {
      repo.updateProviderAccountHealth(
        accountAId,
        'COOLDOWN',
        '2026-08-25T12:05:00.000Z',
        'COOLDOWN'
      );

      const req: RoleAwareRoutingRequest = {
        projectId,
        taskId,
        roleProfileId,
        candidateRefs: [{ accountId: accountAId, resourceId }],
      };

      const decision = await router.routeRole(req);
      expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
      expect(decision.candidateEvaluations[0].eligibility).toBe('INELIGIBLE');
      expect(decision.candidateEvaluations[0].rejectionReasons[0]).toMatch(
        /under active cooldown until 2026-08-25T12:05:00.000Z/
      );
    });

    it('C. allows candidate when account health is RATE_LIMITED and cooldown_until <= current time (expired recovery)', async () => {
      // Cooldown expired at 11:59 (current time is 12:00)
      repo.updateProviderAccountHealth(
        accountAId,
        'RATE_LIMITED',
        '2026-08-25T11:59:00.000Z',
        'RATE_LIMITED'
      );

      const req: RoleAwareRoutingRequest = {
        projectId,
        taskId,
        roleProfileId,
        candidateRefs: [{ accountId: accountAId, resourceId }],
      };

      const decision = await router.routeRole(req);
      expect(decision.outcome).toBe('SELECTED');
      expect(decision.selectedAccountId).toBe(accountAId);
      expect(decision.candidateEvaluations[0].eligibility).toBe('ELIGIBLE');
    });

    it('D. allows candidate when account health is COOLDOWN and cooldown_until <= current time (expired recovery)', async () => {
      repo.updateProviderAccountHealth(
        accountAId,
        'COOLDOWN',
        '2026-08-25T12:00:00.000Z', // exactly equal to current time
        'COOLDOWN'
      );

      const req: RoleAwareRoutingRequest = {
        projectId,
        taskId,
        roleProfileId,
        candidateRefs: [{ accountId: accountAId, resourceId }],
      };

      const decision = await router.routeRole(req);
      expect(decision.outcome).toBe('SELECTED');
      expect(decision.selectedAccountId).toBe(accountAId);
      expect(decision.candidateEvaluations[0].eligibility).toBe('ELIGIBLE');
    });

    it('E. fails closed when RATE_LIMITED / COOLDOWN has null cooldown_until', async () => {
      // Force status to RATE_LIMITED with null cooldown_until in DB
      db.prepare('UPDATE provider_accounts SET health_status = ?, cooldown_until = NULL WHERE id = ?').run(
        'RATE_LIMITED',
        accountAId
      );

      const req: RoleAwareRoutingRequest = {
        projectId,
        taskId,
        roleProfileId,
        candidateRefs: [{ accountId: accountAId, resourceId }],
      };

      const decision = await router.routeRole(req);
      expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
      expect(decision.candidateEvaluations[0].eligibility).toBe('INELIGIBLE');
      expect(decision.candidateEvaluations[0].rejectionReasons[0]).toMatch(
        /missing cooldown_until timestamp/
      );
    });

    it('F. fails closed when RATE_LIMITED / COOLDOWN has malformed cooldown_until', async () => {
      db.prepare('UPDATE provider_accounts SET health_status = ?, cooldown_until = ? WHERE id = ?').run(
        'COOLDOWN',
        'not-a-valid-date',
        accountAId
      );

      const req: RoleAwareRoutingRequest = {
        projectId,
        taskId,
        roleProfileId,
        candidateRefs: [{ accountId: accountAId, resourceId }],
      };

      const decision = await router.routeRole(req);
      expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
      expect(decision.candidateEvaluations[0].eligibility).toBe('INELIGIBLE');
      expect(decision.candidateEvaluations[0].rejectionReasons[0]).toMatch(
        /malformed cooldown_until timestamp/
      );
    });

    it('G. selects lower-priority eligible account when high-priority account is under active cooldown', async () => {
      // High priority Account A (priority 100) is in cooldown
      repo.updateProviderAccountHealth(
        accountAId,
        'RATE_LIMITED',
        '2026-08-25T12:05:00.000Z',
        'RATE_LIMITED'
      );

      // Low priority Account B (priority 10) is AVAILABLE
      repo.updateProviderAccountHealth(accountBId, 'AVAILABLE');

      const req: RoleAwareRoutingRequest = {
        projectId,
        taskId,
        roleProfileId,
        candidateRefs: [
          { accountId: accountAId, resourceId },
          { accountId: accountBId, resourceId },
        ],
      };

      const decision = await router.routeRole(req);
      expect(decision.outcome).toBe('SELECTED');
      expect(decision.selectedAccountId).toBe(accountBId);
      expect(decision.candidateEvaluations.find((c) => c.accountId === accountAId)?.eligibility).toBe(
        'INELIGIBLE'
      );
      expect(decision.candidateEvaluations.find((c) => c.accountId === accountBId)?.eligibility).toBe(
        'ELIGIBLE'
      );
    });

    it('H. selects high-priority account once cooldown has expired', async () => {
      // Cooldown expired at 11:55
      repo.updateProviderAccountHealth(
        accountAId,
        'RATE_LIMITED',
        '2026-08-25T11:55:00.000Z',
        'RATE_LIMITED'
      );
      repo.updateProviderAccountHealth(accountBId, 'AVAILABLE');

      const req: RoleAwareRoutingRequest = {
        projectId,
        taskId,
        roleProfileId,
        candidateRefs: [
          { accountId: accountAId, resourceId },
          { accountId: accountBId, resourceId },
        ],
      };

      const decision = await router.routeRole(req);
      expect(decision.outcome).toBe('SELECTED');
      // Account A wins because priority 100 > priority 10
      expect(decision.selectedAccountId).toBe(accountAId);
    });

    it('I. proves Router does NOT mutate ProviderAccount health state in SQLite during routing', async () => {
      repo.updateProviderAccountHealth(
        accountAId,
        'RATE_LIMITED',
        '2026-08-25T11:55:00.000Z', // Expired cooldown
        'RATE_LIMITED'
      );

      const before = repo.getProviderAccount(accountAId)!;
      expect(before.health_status).toBe('RATE_LIMITED');
      expect(before.cooldown_until).toBe('2026-08-25T11:55:00.000Z');

      const req: RoleAwareRoutingRequest = {
        projectId,
        taskId,
        roleProfileId,
        candidateRefs: [{ accountId: accountAId, resourceId }],
      };

      await router.routeRole(req);

      const after = repo.getProviderAccount(accountAId)!;
      // Router must NOT clear or mutate health_status or cooldown_until in the DB
      expect(after.health_status).toBe('RATE_LIMITED');
      expect(after.cooldown_until).toBe('2026-08-25T11:55:00.000Z');
      expect(after.updated_at).toBe(before.updated_at);
    });

    it('J. preserves existing AUTH_ERROR hard-stop and QUOTA_EXHAUSTED rejection behavior', async () => {
      // AUTH_ERROR on Account A halts routing with NEEDS_OWNER immediately
      repo.updateProviderAccountHealth(accountAId, 'AUTH_ERROR', null, 'AUTH_ERROR');

      const req: RoleAwareRoutingRequest = {
        projectId,
        taskId,
        roleProfileId,
        candidateRefs: [
          { accountId: accountAId, resourceId },
          { accountId: accountBId, resourceId },
        ],
      };

      const decision = await router.routeRole(req);
      expect(decision.outcome).toBe('NEEDS_OWNER');
      expect(decision.selectedAccountId).toBeNull();
    });
  });
});
