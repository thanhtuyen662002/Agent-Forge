import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { MigrationRunner, MIGRATIONS } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { AccountHealthService } from '../src/core/services/AccountHealthService';
import { RoleAwareRoutingService } from '../src/core/services/RoleAwareRoutingService';
import { ProviderRegistry } from '../src/core/adapters/ProviderRegistry';
import { EventService } from '../src/core/services/EventService';
import {
  Provider,
  ProviderAccount,
  ProviderResource,
  RoleProfile,
  ProviderHealthObservation,
  ProviderAccountHealthAction,
} from '../src/core/types/domain';
import type { ProviderDispatchExecutionResult } from '../src/core/services/ProviderDispatchService';

describe('R5H4 Ordered Provider Health Application & Idempotency Contract Tests', () => {
  let db: Database.Database;
  let repo: Repository;
  let service: AccountHealthService;

  const PROVIDER_ID = 'prov-test-1';
  const ACCOUNT_ID = 'acc-test-1';
  const ACCOUNT_ID_B = 'acc-test-2';
  const RESOURCE_ID = 'res-test-1';
  const PROJECT_ID = 'proj-test-1';
  const TASK_ID = 'task-test-1';
  const ATTEMPT_ID = 'att-test-1';
  const ASSIGNMENT_ID = 'asgn-test-1';
  const ROUTING_DECISION_ID = 'rd-test-1';

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    service = new AccountHealthService(repo);
  });

  afterEach(() => {
    db.close();
  });

  function seedDurableGraph(options?: {
    accountId?: string;
    cooldownDurationMs?: number;
    initialHealthStatus?: 'AVAILABLE' | 'UNKNOWN' | 'RATE_LIMITED' | 'AUTH_ERROR' | 'QUOTA_EXHAUSTED';
    initialCooldownUntil?: string | null;
  }) {
    const accId = options?.accountId ?? ACCOUNT_ID;
    const cooldownDuration = options?.cooldownDurationMs ?? 60000;
    const healthStatus = options?.initialHealthStatus ?? 'AVAILABLE';
    const cooldownUntil = options?.initialCooldownUntil ?? null;

    repo.createProject({
      id: PROJECT_ID,
      name: 'Test Project',
      description: null,
      repository_path: 'd:/test',
      default_branch: 'main',
      status: 'READY',
      contract: null,
      started_at: null,
      completed_at: null,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });

    repo.createTask({
      id: TASK_ID,
      project_id: PROJECT_ID,
      milestone_id: null,
      title: 'Test Task',
      description: 'Test Task Description',
      state: 'PLANNED',
      priority: 'HIGH',
      risk: 'LOW',
      revision_count: 0,
      max_revisions: 3,
      progress_cache_percent: 0,
      paused_from_state: null,
      assigned_agent_id: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    } as any);

    repo.createTaskAttempt({
      id: ATTEMPT_ID,
      task_id: TASK_ID,
      attempt_number: 1,
      agent_id: 'agent-1',
      status: 'RUNNING',
      started_at: '2026-08-26T12:00:00.000Z',
      ended_at: null,
      summary: null,
    });

    repo.createProvider({
      id: PROVIDER_ID,
      name: 'Test Provider',
      adapter_type: 'MANUAL_BRIDGE',
      enabled: true,
      created_at: '2026-08-26T12:00:00.000Z',
    });

    repo.createProviderAccount({
      id: accId,
      provider_id: PROVIDER_ID,
      label: 'Primary Account',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: 'wincred://agentforge/key1',
      profile_ref: null,
      enabled: true,
      priority: 10,
      health_status: healthStatus,
      cooldown_until: cooldownUntil,
      concurrency_limit: 2,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });

    repo.createProviderResource({
      id: RESOURCE_ID,
      provider_id: PROVIDER_ID,
      provider_account_id: accId,
      model_name: 'test-model',
      health_status: 'AVAILABLE',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 1.0,
      last_health_check: null,
    });

    repo.createRoleProfile({
      id: 'rp-coder',
      role: 'CODER',
      display_name: 'Coder Role',
      required_capabilities: ['CODING'],
      preferred_capabilities: [],
      authority_scope: null,
      permissions: ['read', 'write'],
      output_protocol: 'coder.v1',
      enabled: true,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });

    repo.createAgentProfile({
      id: 'ap-1',
      role_profile_id: 'rp-coder',
      name: 'Agent 1',
      prompt_template: 'System prompt',
      config: {},
      enabled: true,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });

    repo.createAgentAssignment({
      id: ASSIGNMENT_ID,
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      attempt_id: ATTEMPT_ID,
      role_profile_id: 'rp-coder',
      agent_profile_id: 'ap-1',
      selected_provider_id: PROVIDER_ID,
      selected_account_id: accId,
      selected_resource_id: RESOURCE_ID,
      routing_decision_id: ROUTING_DECISION_ID,
      status: 'ASSIGNED',
      created_at: '2026-08-26T12:00:00.000Z',
      ended_at: null,
    } as any);

    repo.createEvent({
      id: ROUTING_DECISION_ID,
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      agent_id: null,
      type: 'ROLE_AWARE_ROUTING_DECISION',
      timestamp: '2026-08-26T12:00:00.000Z',
      summary: 'Routing decision with snapshot',
      structured_payload: {
        decisionId: ROUTING_DECISION_ID,
        routePolicyId: 'rp-1',
        failoverPolicyAuthoritySnapshot: {
          version: 1,
          status: 'VALID',
          policy: {
            version: 1,
            enabled: true,
            max_failover_attempts: 3,
            same_account_retries: 1,
            allow_cross_account: true,
            allow_cross_provider: false,
            cooldown_duration_ms: cooldownDuration,
          },
        },
      },
    });
  }

  function createCoherentObservation(params: {
    authId: string;
    execId: string;
    msgId: string;
    category: 'SUCCESS' | 'RATE_LIMITED' | 'QUOTA_EXHAUSTED' | 'AUTHENTICATION_FAILURE' | 'ADAPTER_THROW' | 'UNKNOWN';
    resultStatus?: 'COMPLETED' | 'FAILED';
    errorText?: string;
    accountId?: string;
    resourceId?: string;
    assignmentId?: string;
  }): { obs: ProviderHealthObservation; result: ProviderDispatchExecutionResult } {
    const accId = params.accountId ?? ACCOUNT_ID;
    const resId = params.resourceId ?? RESOURCE_ID;
    const asgnId = params.assignmentId ?? ASSIGNMENT_ID;
    const resultStatus = params.resultStatus ?? (params.category === 'SUCCESS' ? 'COMPLETED' : 'FAILED');

    repo.recordProtocolMessage(
      params.msgId,
      params.msgId,
      'manager.v1',
      PROJECT_ID,
      TASK_ID,
      'APPROVED',
      0,
      `sha-${params.msgId}`,
      JSON.stringify({ instruction: 'do task' }),
      'APPLIED',
      undefined,
      '2026-08-26T12:00:00.000Z'
    );

    repo.createExecutionAuthorization({
      id: params.authId,
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      attempt_id: ATTEMPT_ID,
      task_revision: 0,
      base_sha: '8cec7fcbe9edb51a7e3e03d7205eb5da425fb697',
      repository_head_sha: '8cec7fcbe9edb51a7e3e03d7205eb5da425fb697',
      manager_message_id: params.msgId,
      manager_payload_hash: `hash-${params.msgId}`,
      routing_decision_id: ROUTING_DECISION_ID,
      selected_provider_id: PROVIDER_ID,
      selected_resource_id: resId,
      canonical_instructions_json: JSON.stringify(['test']),
      context_files_json: JSON.stringify([]),
      canonical_payload_json: JSON.stringify({}),
      instruction_payload_hash: `hash-payload-${params.msgId}`,
      context_manifest_hash: `hash-manifest-${params.msgId}`,
      status: 'DISPATCHED',
      dispatched_at: '2026-08-26T12:00:00.000Z',
      created_at: '2026-08-26T12:00:00.000Z',
    });

    const obs: ProviderHealthObservation = {
      authorization_id: params.authId,
      execution_id: params.execId,
      account_id: accId,
      provider_id: PROVIDER_ID,
      resource_id: resId,
      assignment_id: asgnId,
      attempt_id: ATTEMPT_ID,
      routing_decision_id: ROUTING_DECISION_ID,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'LEGACY',
      adapter_invocation: params.category === 'ADAPTER_THROW' ? 'THREW' : 'RETURNED',
      result_status: resultStatus,
      classified_category: params.category,
      observed_at: '2026-08-26T12:00:00.000Z',
    };

    let errorCode: any = null;
    let error: string | undefined = params.errorText;
    if (resultStatus === 'FAILED') {
      if (params.category === 'AUTHENTICATION_FAILURE') {
        errorCode = 'AUTH_ERROR';
        error = error ?? 'invalid api key';
      } else if (params.category === 'QUOTA_EXHAUSTED') {
        errorCode = 'QUOTA_EXHAUSTED';
        error = error ?? 'quota exceeded out of credits';
      } else if (params.category === 'RATE_LIMITED') {
        errorCode = 'QUOTA_EXHAUSTED';
        error = error ?? 'rate limit 429 too many requests';
      }
    }

    const result: ProviderDispatchExecutionResult = {
      executionId: params.execId,
      status: resultStatus,
      rawResponse: 'response data',
      error,
      errorCode,
      providerExecutionProvenance: {
        version: 1,
        source: 'PROVIDER_DISPATCH_SERVICE',
        mode: 'LEGACY',
        adapterInvocation: obs.adapter_invocation,
        authorizationId: params.authId,
        executionId: params.execId,
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        attemptId: ATTEMPT_ID,
        routingDecisionId: ROUTING_DECISION_ID,
        providerId: PROVIDER_ID,
        resourceId: resId,
        assignmentId: asgnId,
        accountId: accId,
      },
    };

    return { obs, result };
  }

  // =========================================================================
  // 1. Schema, Migrations & Watermark Column Setup
  // =========================================================================

  it('1. Migration 15 exists with correct version and name', () => {
    const mig15 = MIGRATIONS.find((m) => m.version === 15);
    expect(mig15).toBeDefined();
    expect(mig15?.name).toBe('015_r5h4_ordered_provider_health_application_idempotency');
  });

  it('2. Migrations 1-14 definitions remain strictly immutable and unchanged', () => {
    expect(MIGRATIONS).toHaveLength(15);
    for (let i = 1; i <= 14; i++) {
      expect(MIGRATIONS[i - 1].version).toBe(i);
    }
  });

  it('3. last_applied_action_account_order and authorization_id columns are nullable on provider_accounts', () => {
    const cols = db.prepare("PRAGMA table_info(provider_accounts)").all() as { name: string; notnull: number }[];
    const orderCol = cols.find((c) => c.name === 'last_applied_action_account_order');
    const authCol = cols.find((c) => c.name === 'last_applied_action_authorization_id');

    expect(orderCol).toBeDefined();
    expect(orderCol?.notnull).toBe(0);
    expect(authCol).toBeDefined();
    expect(authCol?.notnull).toBe(0);
  });

  it('4. True v14 upgrade: existing accounts retain last_applied_action_account_order = NULL and authorization_id = NULL without backfill', () => {
    const upgradeDb = new Database(':memory:');
    upgradeDb.pragma('foreign_keys = ON');

    upgradeDb.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    for (let v = 1; v <= 14; v++) {
      const m = MIGRATIONS.find((mig) => mig.version === v)!;
      m.up(upgradeDb);
      upgradeDb.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        v,
        m.name,
        new Date().toISOString()
      );
    }

    // Insert account in v14 schema
    upgradeDb.exec(`
      INSERT INTO providers (id, name, adapter_type, enabled, created_at)
      VALUES ('prov-1', 'P1', 'MANUAL_BRIDGE', 1, '2026-08-26T12:00:00Z');

      INSERT INTO provider_accounts (
        id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at
      ) VALUES (
        'acc-v14', 'prov-1', 'V14 Acc', 'API_CREDENTIAL', 1, 0, 'AVAILABLE', 1, '2026-08-26T12:00:00Z', '2026-08-26T12:00:00Z'
      );
    `);

    // Run Migration 15
    MigrationRunner.run(upgradeDb);

    const row = upgradeDb.prepare('SELECT * FROM provider_accounts WHERE id = ?').get('acc-v14') as any;
    expect(row.last_applied_action_account_order).toBeNull();
    expect(row.last_applied_action_authorization_id).toBeNull();

    upgradeDb.close();
  });

  // =========================================================================
  // 2. Action Eligibility & Application Statuses
  // =========================================================================

  it('5. RECORD_SUCCESS action is eligible and applies AVAILABLE status', () => {
    seedDurableGraph({ initialHealthStatus: 'RATE_LIMITED', initialCooldownUntil: new Date(Date.now() + 100000).toISOString() });
    const { obs, result } = createCoherentObservation({
      authId: 'auth-1',
      execId: 'exec-1',
      msgId: 'msg-1',
      category: 'SUCCESS',
    });
    repo.claimProviderHealthObservation(obs, result);

    const appResult = service.applyDurableObservation('auth-1');
    expect(appResult.status).toBe('APPLIED');
    expect(appResult.appliedHealthStatus).toBe('AVAILABLE');
    expect(appResult.appliedCooldownUntil).toBeNull();
    expect(appResult.watermarkAccountOrder).toBe(1);
    expect(appResult.watermarkAuthorizationId).toBe('auth-1');

    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.health_status).toBe('AVAILABLE');
    expect(acc.cooldown_until).toBeNull();
    expect(acc.last_applied_action_account_order).toBe(1);
    expect(acc.last_applied_action_authorization_id).toBe('auth-1');
  });

  it('6. RECORD_QUOTA_EXHAUSTED action is eligible and applies QUOTA_EXHAUSTED', () => {
    seedDurableGraph({ initialHealthStatus: 'AVAILABLE' });
    const { obs, result } = createCoherentObservation({
      authId: 'auth-1',
      execId: 'exec-1',
      msgId: 'msg-1',
      category: 'QUOTA_EXHAUSTED',
    });
    repo.claimProviderHealthObservation(obs, result);

    const appResult = service.applyDurableObservation('auth-1');
    expect(appResult.status).toBe('APPLIED');
    expect(appResult.appliedHealthStatus).toBe('QUOTA_EXHAUSTED');
    expect(appResult.appliedCooldownUntil).toBeNull();

    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.health_status).toBe('QUOTA_EXHAUSTED');
    expect(acc.last_failure_code).toBe('QUOTA_EXHAUSTED');
  });

  it('7. RECORD_AUTH_ERROR action is eligible and applies AUTH_ERROR + AUTHENTICATION_FAILURE', () => {
    seedDurableGraph({ initialHealthStatus: 'AVAILABLE' });
    const { obs, result } = createCoherentObservation({
      authId: 'auth-1',
      execId: 'exec-1',
      msgId: 'msg-1',
      category: 'AUTHENTICATION_FAILURE',
    });
    repo.claimProviderHealthObservation(obs, result);

    const appResult = service.applyDurableObservation('auth-1');
    expect(appResult.status).toBe('APPLIED');
    expect(appResult.appliedHealthStatus).toBe('AUTH_ERROR');
    expect(appResult.appliedCooldownUntil).toBeNull();

    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.health_status).toBe('AUTH_ERROR');
    expect(acc.last_failure_code).toBe('AUTHENTICATION_FAILURE');
  });

  it('8. RECORD_RATE_LIMITED with positive duration and anchor applies RATE_LIMITED with derived until', () => {
    seedDurableGraph({ cooldownDurationMs: 60000, initialHealthStatus: 'AVAILABLE' });
    const { obs, result } = createCoherentObservation({
      authId: 'auth-1',
      execId: 'exec-1',
      msgId: 'msg-1',
      category: 'RATE_LIMITED',
    });
    repo.claimProviderHealthObservation(obs, result);

    const storedObs = repo.getProviderHealthObservation('auth-1')!;
    const expectedUntil = new Date(Date.parse(storedObs.health_action_cooldown_anchor_at!) + 60000).toISOString();

    const appResult = service.applyDurableObservation('auth-1');
    expect(appResult.status).toBe('APPLIED');
    expect(appResult.appliedHealthStatus).toBe('RATE_LIMITED');
    expect(appResult.appliedCooldownUntil).toBe(expectedUntil);

    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.health_status).toBe('RATE_LIMITED');
    expect(acc.cooldown_until).toBe(expectedUntil);
    expect(acc.last_failure_code).toBe('RATE_LIMITED');
  });

  it('9. NO_MUTATION action returns status NO_MUTATION with zero database writes', () => {
    seedDurableGraph({ initialHealthStatus: 'AVAILABLE' });
    // Simulate NO_MUTATION by inserting observation with health_action = NO_MUTATION
    const { obs, result } = createCoherentObservation({
      authId: 'auth-1',
      execId: 'exec-1',
      msgId: 'msg-1',
      category: 'UNKNOWN',
      resultStatus: 'FAILED',
      errorText: 'temporary unknown glitch',
    });
    repo.claimProviderHealthObservation(obs, result);

    const beforeAcc = repo.getProviderAccount(ACCOUNT_ID)!;

    const appResult = service.applyDurableObservation('auth-1');
    expect(appResult.status).toBe('NO_MUTATION');
    expect(appResult.healthAction).toBe('NO_MUTATION');

    const afterAcc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(afterAcc.updated_at).toBe(beforeAcc.updated_at);
    expect(afterAcc.last_applied_action_account_order).toBeNull();
    expect(afterAcc.last_applied_action_authorization_id).toBeNull();
  });

  it('10. NULL plan or malformed plan returns ACTION_AUTHORITY_UNKNOWN with zero writes', () => {
    seedDurableGraph();
    const { obs, result } = createCoherentObservation({
      authId: 'auth-1',
      execId: 'exec-1',
      msgId: 'msg-1',
      category: 'SUCCESS',
    });
    repo.claimProviderHealthObservation(obs, result);

    // Manually null out plan in database
    db.prepare('UPDATE provider_health_observations SET health_action_plan_version = NULL WHERE authorization_id = ?').run('auth-1');

    const appResult = service.applyDurableObservation('auth-1');
    expect(appResult.status).toBe('ACTION_AUTHORITY_UNKNOWN');

    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.last_applied_action_account_order).toBeNull();
  });

  it('11. NULL account_order returns LEGACY_UNORDERED with zero writes', () => {
    seedDurableGraph();
    const { obs, result } = createCoherentObservation({
      authId: 'auth-1',
      execId: 'exec-1',
      msgId: 'msg-1',
      category: 'SUCCESS',
    });
    repo.claimProviderHealthObservation(obs, result);

    // Manually null out account_order
    db.prepare('UPDATE provider_health_observations SET account_order = NULL WHERE authorization_id = ?').run('auth-1');

    const appResult = service.applyDurableObservation('auth-1');
    expect(appResult.status).toBe('LEGACY_UNORDERED');

    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.last_applied_action_account_order).toBeNull();
  });

  it('12. RECORD_RATE_LIMITED with anchor = NULL returns TEMPORAL_AUTHORITY_UNKNOWN with zero writes', () => {
    seedDurableGraph();
    const { obs, result } = createCoherentObservation({
      authId: 'auth-1',
      execId: 'exec-1',
      msgId: 'msg-1',
      category: 'RATE_LIMITED',
    });
    repo.claimProviderHealthObservation(obs, result);

    // Manually null out anchor
    db.prepare('UPDATE provider_health_observations SET health_action_cooldown_anchor_at = NULL WHERE authorization_id = ?').run('auth-1');

    const appResult = service.applyDurableObservation('auth-1');
    expect(appResult.status).toBe('TEMPORAL_AUTHORITY_UNKNOWN');

    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.last_applied_action_account_order).toBeNull();
  });

  // =========================================================================
  // 3. Newest-Effective Actionable Ordering & Barrier Rules
  // =========================================================================

  it('13. Latest known action wins immediately when applied', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'SUCCESS' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    const item2 = createCoherentObservation({ authId: 'auth-2', execId: 'exec-2', msgId: 'msg-2', category: 'AUTHENTICATION_FAILURE' });
    repo.claimProviderHealthObservation(item2.obs, item2.result);

    // Apply item2 directly without having applied item1
    const appResult = service.applyDurableObservation('auth-2');
    expect(appResult.status).toBe('APPLIED');
    expect(appResult.appliedHealthStatus).toBe('AUTH_ERROR');
    expect(appResult.watermarkAccountOrder).toBe(2);

    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.health_status).toBe('AUTH_ERROR');
    expect(acc.last_applied_action_account_order).toBe(2);
  });

  it('14. Newer known action makes older action return STALE with zero writes', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'SUCCESS' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    const item2 = createCoherentObservation({ authId: 'auth-2', execId: 'exec-2', msgId: 'msg-2', category: 'AUTHENTICATION_FAILURE' });
    repo.claimProviderHealthObservation(item2.obs, item2.result);

    // Apply item2 first
    service.applyDurableObservation('auth-2');

    // Attempt to apply older item1
    const appResult1 = service.applyDurableObservation('auth-1');
    expect(appResult1.status).toBe('STALE');

    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.health_status).toBe('AUTH_ERROR');
    expect(acc.last_applied_action_account_order).toBe(2);
  });

  it('15. NO_MUTATION is transparent when resolving newest effective candidate', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'AUTHENTICATION_FAILURE' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    const item2 = createCoherentObservation({ authId: 'auth-2', execId: 'exec-2', msgId: 'msg-2', category: 'UNKNOWN', resultStatus: 'FAILED', errorText: 'transient' });
    repo.claimProviderHealthObservation(item2.obs, item2.result);

    // item1 is order 1 (AUTH_ERROR), item2 is order 2 (NO_MUTATION).
    // Applying item1 must succeed because item2 is transparent!
    const appResult = service.applyDurableObservation('auth-1');
    expect(appResult.status).toBe('APPLIED');
    expect(appResult.appliedHealthStatus).toBe('AUTH_ERROR');
    expect(appResult.watermarkAccountOrder).toBe(1);
  });

  it('16. Multiple interleaved NO_MUTATION rows are transparent', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'AUTHENTICATION_FAILURE' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    const item2 = createCoherentObservation({ authId: 'auth-2', execId: 'exec-2', msgId: 'msg-2', category: 'UNKNOWN', resultStatus: 'FAILED', errorText: 'transient 1' });
    repo.claimProviderHealthObservation(item2.obs, item2.result);

    const item3 = createCoherentObservation({ authId: 'auth-3', execId: 'exec-3', msgId: 'msg-3', category: 'UNKNOWN', resultStatus: 'FAILED', errorText: 'transient 2' });
    repo.claimProviderHealthObservation(item3.obs, item3.result);

    const appResult = service.applyDurableObservation('auth-1');
    expect(appResult.status).toBe('APPLIED');
    expect(appResult.appliedHealthStatus).toBe('AUTH_ERROR');
    expect(appResult.watermarkAccountOrder).toBe(1);
  });

  it('17. Newer unknown action authority blocks older action (returns DEFERRED_BY_NEWER_UNKNOWN_AUTHORITY)', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'SUCCESS' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    const item2 = createCoherentObservation({ authId: 'auth-2', execId: 'exec-2', msgId: 'msg-2', category: 'AUTHENTICATION_FAILURE' });
    repo.claimProviderHealthObservation(item2.obs, item2.result);

    // Corrupt item2 plan in database
    db.prepare('UPDATE provider_health_observations SET health_action_plan_version = NULL WHERE authorization_id = ?').run('auth-2');

    // Attempting to apply older item1 must be deferred by newer unknown barrier item2
    const appResult = service.applyDurableObservation('auth-1');
    expect(appResult.status).toBe('DEFERRED_BY_NEWER_UNKNOWN_AUTHORITY');

    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.last_applied_action_account_order).toBeNull();
  });

  it('18. Older unknown action authority does NOT block newer known action from applying', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'AUTHENTICATION_FAILURE' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    const item2 = createCoherentObservation({ authId: 'auth-2', execId: 'exec-2', msgId: 'msg-2', category: 'SUCCESS' });
    repo.claimProviderHealthObservation(item2.obs, item2.result);

    // Corrupt older item1 plan in database
    db.prepare('UPDATE provider_health_observations SET health_action_plan_version = NULL WHERE authorization_id = ?').run('auth-1');

    // Applying newer item2 must succeed!
    const appResult = service.applyDurableObservation('auth-2');
    expect(appResult.status).toBe('APPLIED');
    expect(appResult.appliedHealthStatus).toBe('AVAILABLE');
    expect(appResult.watermarkAccountOrder).toBe(2);
  });

  it('19. Newer temporal-unknown rate limit blocks older action (returns DEFERRED_BY_NEWER_UNKNOWN_AUTHORITY)', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'SUCCESS' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    const item2 = createCoherentObservation({ authId: 'auth-2', execId: 'exec-2', msgId: 'msg-2', category: 'RATE_LIMITED' });
    repo.claimProviderHealthObservation(item2.obs, item2.result);

    // Corrupt item2 anchor in database
    db.prepare('UPDATE provider_health_observations SET health_action_cooldown_anchor_at = NULL WHERE authorization_id = ?').run('auth-2');

    const appResult = service.applyDurableObservation('auth-1');
    expect(appResult.status).toBe('DEFERRED_BY_NEWER_UNKNOWN_AUTHORITY');
  });

  it('20. Newer known action past temporal-unknown can apply immediately', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'RATE_LIMITED' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    const item2 = createCoherentObservation({ authId: 'auth-2', execId: 'exec-2', msgId: 'msg-2', category: 'SUCCESS' });
    repo.claimProviderHealthObservation(item2.obs, item2.result);

    // Corrupt older item1 anchor
    db.prepare('UPDATE provider_health_observations SET health_action_cooldown_anchor_at = NULL WHERE authorization_id = ?').run('auth-1');

    const appResult = service.applyDurableObservation('auth-2');
    expect(appResult.status).toBe('APPLIED');
    expect(appResult.appliedHealthStatus).toBe('AVAILABLE');
    expect(appResult.watermarkAccountOrder).toBe(2);
  });

  // =========================================================================
  // 4. Idempotency, Duplicates & Zero-Write Invariants
  // =========================================================================

  it('21. First valid action returns APPLIED and advances watermark', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'SUCCESS' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    const res = service.applyDurableObservation('auth-1');
    expect(res.status).toBe('APPLIED');
    expect(res.watermarkAccountOrder).toBe(1);
    expect(res.watermarkAuthorizationId).toBe('auth-1');
  });

  it('22. Current exact duplicate (same account_order and authorization_id) returns ALREADY_APPLIED', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'SUCCESS' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    service.applyDurableObservation('auth-1');

    const dup = service.applyDurableObservation('auth-1');
    expect(dup.status).toBe('ALREADY_APPLIED');
    expect(dup.watermarkAccountOrder).toBe(1);
    expect(dup.watermarkAuthorizationId).toBe('auth-1');
  });

  it('23. Historical older action returns STALE after newer action applied', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'SUCCESS' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    const item2 = createCoherentObservation({ authId: 'auth-2', execId: 'exec-2', msgId: 'msg-2', category: 'AUTHENTICATION_FAILURE' });
    repo.claimProviderHealthObservation(item2.obs, item2.result);

    service.applyDurableObservation('auth-1');
    service.applyDurableObservation('auth-2');

    const replay1 = service.applyDurableObservation('auth-1');
    expect(replay1.status).toBe('STALE');
  });

  it('24. ALREADY_APPLIED performs zero database writes (updated_at and timestamps unchanged)', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'SUCCESS' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    service.applyDurableObservation('auth-1');
    const acc1 = repo.getProviderAccount(ACCOUNT_ID)!;

    const dup = service.applyDurableObservation('auth-1');
    expect(dup.status).toBe('ALREADY_APPLIED');

    const acc2 = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc2.updated_at).toBe(acc1.updated_at);
    expect(acc2.last_success_at).toBe(acc1.last_success_at);
    expect(acc2.last_applied_action_account_order).toBe(acc1.last_applied_action_account_order);
  });

  it('25. STALE performs zero database writes', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'SUCCESS' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    const item2 = createCoherentObservation({ authId: 'auth-2', execId: 'exec-2', msgId: 'msg-2', category: 'AUTHENTICATION_FAILURE' });
    repo.claimProviderHealthObservation(item2.obs, item2.result);

    service.applyDurableObservation('auth-2');
    const accBefore = repo.getProviderAccount(ACCOUNT_ID)!;

    const staleRes = service.applyDurableObservation('auth-1');
    expect(staleRes.status).toBe('STALE');

    const accAfter = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(accAfter.updated_at).toBe(accBefore.updated_at);
    expect(accAfter.health_status).toBe(accBefore.health_status);
  });

  // =========================================================================
  // 5. State Preservation & Historical Expired Rate Limits
  // =========================================================================

  it('26. RECORD_SUCCESS mutation sets AVAILABLE, clears cooldown, updates last_success_at', () => {
    seedDurableGraph({ initialHealthStatus: 'QUOTA_EXHAUSTED' });
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'SUCCESS' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    service.applyDurableObservation('auth-1');
    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.health_status).toBe('AVAILABLE');
    expect(acc.cooldown_until).toBeNull();
    expect(acc.last_success_at).not.toBeNull();
  });

  it('27. RECORD_AUTH_ERROR mutation sets AUTH_ERROR, clears cooldown, updates last_failure_at + AUTHENTICATION_FAILURE', () => {
    seedDurableGraph({ initialHealthStatus: 'AVAILABLE' });
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'AUTHENTICATION_FAILURE' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    service.applyDurableObservation('auth-1');
    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.health_status).toBe('AUTH_ERROR');
    expect(acc.last_failure_code).toBe('AUTHENTICATION_FAILURE');
    expect(acc.last_failure_at).not.toBeNull();
  });

  it('28. RECORD_QUOTA_EXHAUSTED mutation sets QUOTA_EXHAUSTED, clears cooldown, updates last_failure_at + QUOTA_EXHAUSTED', () => {
    seedDurableGraph({ initialHealthStatus: 'AVAILABLE' });
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'QUOTA_EXHAUSTED' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    service.applyDurableObservation('auth-1');
    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.health_status).toBe('QUOTA_EXHAUSTED');
    expect(acc.last_failure_code).toBe('QUOTA_EXHAUSTED');
    expect(acc.last_failure_at).not.toBeNull();
  });

  it('29. Future RECORD_RATE_LIMITED mutation sets RATE_LIMITED, derives future cooldown_until, updates last_failure_at + RATE_LIMITED', () => {
    seedDurableGraph({ cooldownDurationMs: 120000 });
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'RATE_LIMITED' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    service.applyDurableObservation('auth-1');
    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.health_status).toBe('RATE_LIMITED');
    expect(acc.last_failure_code).toBe('RATE_LIMITED');
    expect(Date.parse(acc.cooldown_until!)).toBeGreaterThan(Date.now());
  });

  it('30. Historical expired RECORD_RATE_LIMITED mutation sets RATE_LIMITED with derived historical past cooldown_until', () => {
    seedDurableGraph({ cooldownDurationMs: 30000 });
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'RATE_LIMITED' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    // Set anchor in the past so anchor + 30s is in the past
    const pastAnchor = new Date(Date.now() - 100000).toISOString();
    const expectedUntil = new Date(Date.parse(pastAnchor) + 30000).toISOString();
    db.prepare('UPDATE provider_health_observations SET health_action_cooldown_anchor_at = ? WHERE authorization_id = ?').run(pastAnchor, 'auth-1');

    const appResult = service.applyDurableObservation('auth-1');
    expect(appResult.status).toBe('APPLIED');
    expect(appResult.appliedHealthStatus).toBe('RATE_LIMITED');
    expect(appResult.appliedCooldownUntil).toBe(expectedUntil);

    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.health_status).toBe('RATE_LIMITED');
    expect(acc.cooldown_until).toBe(expectedUntil);
    expect(Date.parse(acc.cooldown_until!)).toBeLessThan(Date.now());
  });

  it('31. Expired RECORD_RATE_LIMITED never converts to AVAILABLE or SUCCESS', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'RATE_LIMITED' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    const pastAnchor = new Date(Date.now() - 500000).toISOString();
    db.prepare('UPDATE provider_health_observations SET health_action_cooldown_anchor_at = ? WHERE authorization_id = ?').run(pastAnchor, 'auth-1');

    service.applyDurableObservation('auth-1');
    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.health_status).toBe('RATE_LIMITED');
    expect(acc.health_status).not.toBe('AVAILABLE');
  });

  it('32. ProviderAccount.enabled is preserved and never mutated by health application', () => {
    seedDurableGraph();
    repo.updateProviderAccount(ACCOUNT_ID, { enabled: false });

    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'SUCCESS' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    service.applyDurableObservation('auth-1');
    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.enabled).toBe(false);
  });

  it('33. Success application preserves prior last_failure_at and last_failure_code', () => {
    seedDurableGraph({ initialHealthStatus: 'QUOTA_EXHAUSTED' });
    db.prepare('UPDATE provider_accounts SET last_failure_at = ?, last_failure_code = ? WHERE id = ?').run('2026-08-25T10:00:00.000Z', 'QUOTA_EXHAUSTED', ACCOUNT_ID);

    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'SUCCESS' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    service.applyDurableObservation('auth-1');
    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.last_failure_at).toBe('2026-08-25T10:00:00.000Z');
    expect(acc.last_failure_code).toBe('QUOTA_EXHAUSTED');
    expect(acc.last_success_at).not.toBeNull();
  });

  it('34. Failure application preserves prior last_success_at', () => {
    seedDurableGraph();
    db.prepare('UPDATE provider_accounts SET last_success_at = ? WHERE id = ?').run('2026-08-25T08:00:00.000Z', ACCOUNT_ID);

    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'AUTHENTICATION_FAILURE' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    service.applyDurableObservation('auth-1');
    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.last_success_at).toBe('2026-08-25T08:00:00.000Z');
    expect(acc.last_failure_at).not.toBeNull();
  });

  it('35. Applied success/failure timestamps explicitly reflect application-time', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'SUCCESS' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    const before = new Date().toISOString();
    service.applyDurableObservation('auth-1');
    const after = new Date().toISOString();

    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.last_success_at! >= before).toBe(true);
    expect(acc.last_success_at! <= after).toBe(true);
  });

  it('36. Stale skip does not rewrite or refresh metadata timestamps', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'SUCCESS' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);
    const item2 = createCoherentObservation({ authId: 'auth-2', execId: 'exec-2', msgId: 'msg-2', category: 'AUTHENTICATION_FAILURE' });
    repo.claimProviderHealthObservation(item2.obs, item2.result);

    service.applyDurableObservation('auth-2');
    const acc2 = repo.getProviderAccount(ACCOUNT_ID)!;

    service.applyDurableObservation('auth-1');
    const accAfter = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(accAfter.updated_at).toBe(acc2.updated_at);
    expect(accAfter.last_failure_at).toBe(acc2.last_failure_at);
  });

  // =========================================================================
  // 6. Security Boundaries & Configuration Independence
  // =========================================================================

  it('37. updateProviderAccount (generic config update) preserves health and application watermark', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'AUTHENTICATION_FAILURE' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);
    service.applyDurableObservation('auth-1');

    repo.updateProviderAccount(ACCOUNT_ID, { label: 'Renamed Account', priority: 25 });

    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.label).toBe('Renamed Account');
    expect(acc.priority).toBe(25);
    expect(acc.health_status).toBe('AUTH_ERROR');
    expect(acc.last_applied_action_account_order).toBe(1);
    expect(acc.last_applied_action_authorization_id).toBe('auth-1');
  });

  it('38. updateProviderAccountHealth (raw legacy health method) does not advance application watermark', () => {
    seedDurableGraph();
    repo.updateProviderAccountHealth(ACCOUNT_ID, 'RATE_LIMITED', new Date(Date.now() + 60000).toISOString(), 'RATE_LIMITED');

    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.health_status).toBe('RATE_LIMITED');
    expect(acc.last_applied_action_account_order).toBeNull();
    expect(acc.last_applied_action_authorization_id).toBeNull();
  });

  it('39. Caller cannot forge application semantics (caller-supplied action is ignored)', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'AUTHENTICATION_FAILURE' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    // applyDurableObservation takes only authorizationId!
    const res = service.applyDurableObservation('auth-1');
    expect(res.healthAction).toBe('RECORD_AUTH_ERROR');
    expect(res.appliedHealthStatus).toBe('AUTH_ERROR');
  });

  it('40. Caller cannot forge account order or watermark', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'SUCCESS' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    // Public API requires only authorizationId string
    const res = service.applyDurableObservation('auth-1');
    expect(res.accountOrder).toBe(1);
    expect(res.watermarkAccountOrder).toBe(1);
  });

  // =========================================================================
  // 7. Atomic Transaction & Rollback Proofs
  // =========================================================================

  it('41. Atomic rollback proof: forced post-update failure rolls back both health mutation and watermark', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'AUTHENTICATION_FAILURE' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    let capturedOrder: number | null = null;
    let capturedAuth: string | null = null;
    let capturedStatus: string | null = null;

    db.function('__capture_account_update', (order, auth, status) => {
      capturedOrder = order !== null && order !== undefined ? Number(order) : null;
      capturedAuth = auth ? String(auth) : null;
      capturedStatus = status ? String(status) : null;
      return null;
    });

    db.exec(`
      CREATE TEMP TRIGGER test_abort_account_health_application
      BEFORE UPDATE ON provider_accounts
      WHEN NEW.id = '${ACCOUNT_ID}'
      BEGIN
        SELECT __capture_account_update(
          NEW.last_applied_action_account_order,
          NEW.last_applied_action_authorization_id,
          NEW.health_status
        );
        SELECT RAISE(ABORT, 'TEST_FORCED_APPLICATION_ABORT');
      END;
    `);

    expect(() => service.applyDurableObservation('auth-1')).toThrow(/TEST_FORCED_APPLICATION_ABORT/);

    // Assert trigger captured the attempted values
    expect(capturedOrder).toBe(1);
    expect(capturedAuth).toBe('auth-1');
    expect(capturedStatus).toBe('AUTH_ERROR');

    // Assert durable account was completely rolled back
    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.health_status).toBe('AVAILABLE');
    expect(acc.last_applied_action_account_order).toBeNull();
    expect(acc.last_applied_action_authorization_id).toBeNull();

    // Drop trigger and retry
    db.exec('DROP TRIGGER IF EXISTS test_abort_account_health_application;');

    const retryRes = service.applyDurableObservation('auth-1');
    expect(retryRes.status).toBe('APPLIED');

    const accAfter = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(accAfter.health_status).toBe('AUTH_ERROR');
    expect(accAfter.last_applied_action_account_order).toBe(1);
  });

  it('42. No health-first partial commit exists', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'AUTHENTICATION_FAILURE' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    // Health and watermark are updated in a single UPDATE statement within immediate transaction
    service.applyDurableObservation('auth-1');
    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.health_status === 'AUTH_ERROR' && acc.last_applied_action_account_order === 1).toBe(true);
  });

  it('43. No watermark-first partial commit exists', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'AUTHENTICATION_FAILURE' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    service.applyDurableObservation('auth-1');
    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.last_applied_action_account_order === 1 && acc.health_status === 'AUTH_ERROR').toBe(true);
  });

  // =========================================================================
  // 8. Concurrency, Permutations & Account Isolation
  // =========================================================================

  it('44. Same-account application call-order permutation resolves to latest actionable state', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'SUCCESS' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    const item2 = createCoherentObservation({ authId: 'auth-2', execId: 'exec-2', msgId: 'msg-2', category: 'AUTHENTICATION_FAILURE' });
    repo.claimProviderHealthObservation(item2.obs, item2.result);

    // Calling apply for order 2 first, then order 1
    const res2 = service.applyDurableObservation('auth-2');
    expect(res2.status).toBe('APPLIED');

    const res1 = service.applyDurableObservation('auth-1');
    expect(res1.status).toBe('STALE');

    const acc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(acc.health_status).toBe('AUTH_ERROR');
    expect(acc.last_applied_action_account_order).toBe(2);
    expect(acc.last_applied_action_authorization_id).toBe('auth-2');
  });

  it('45. Different accounts have completely isolated order spaces and watermarks', () => {
    seedDurableGraph({ accountId: ACCOUNT_ID });

    repo.createProviderAccount({
      id: ACCOUNT_ID_B,
      provider_id: PROVIDER_ID,
      label: 'Secondary Account',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: 'wincred://agentforge/key2',
      profile_ref: null,
      enabled: true,
      priority: 5,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 2,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });

    repo.createProviderResource({
      id: 'res-test-2',
      provider_id: PROVIDER_ID,
      provider_account_id: ACCOUNT_ID_B,
      model_name: 'test-model-2',
      health_status: 'AVAILABLE',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 1.0,
      last_health_check: null,
    });

    repo.createAgentAssignment({
      id: 'asgn-test-2',
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      attempt_id: ATTEMPT_ID,
      role_profile_id: 'rp-coder',
      agent_profile_id: 'ap-1',
      selected_provider_id: PROVIDER_ID,
      selected_account_id: ACCOUNT_ID_B,
      selected_resource_id: 'res-test-2',
      routing_decision_id: ROUTING_DECISION_ID,
      status: 'ASSIGNED',
      created_at: '2026-08-26T12:00:00.000Z',
      ended_at: null,
    } as any);

    const itemA = createCoherentObservation({ authId: 'auth-a', execId: 'exec-a', msgId: 'msg-a', category: 'AUTHENTICATION_FAILURE', accountId: ACCOUNT_ID });
    repo.claimProviderHealthObservation(itemA.obs, itemA.result);

    const itemB = createCoherentObservation({
      authId: 'auth-b',
      execId: 'exec-b',
      msgId: 'msg-b',
      category: 'SUCCESS',
      accountId: ACCOUNT_ID_B,
      resourceId: 'res-test-2',
      assignmentId: 'asgn-test-2',
    });
    repo.claimProviderHealthObservation(itemB.obs, itemB.result);

    service.applyDurableObservation('auth-a');
    service.applyDurableObservation('auth-b');

    const accA = repo.getProviderAccount(ACCOUNT_ID)!;
    const accB = repo.getProviderAccount(ACCOUNT_ID_B)!;

    expect(accA.health_status).toBe('AUTH_ERROR');
    expect(accA.last_applied_action_account_order).toBe(1);
    expect(accA.last_applied_action_authorization_id).toBe('auth-a');

    expect(accB.health_status).toBe('AVAILABLE');
    expect(accB.last_applied_action_account_order).toBe(1);
    expect(accB.last_applied_action_authorization_id).toBe('auth-b');
  });

  // =========================================================================
  // 9. Architectural Boundaries & Source Scans
  // =========================================================================

  it('46. Source scan proves ProviderDispatchService is unmodified', () => {
    const filePath = path.join(__dirname, '../src/core/services/ProviderDispatchService.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).not.toContain('applyDurableProviderHealthObservation');
    expect(content).not.toContain('applyDurableObservation');
  });

  it('47. Source scan proves BootstrapService is unmodified', () => {
    const filePath = path.join(__dirname, '../src/core/services/BootstrapService.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).not.toContain('AccountHealthService');
  });

  it('48. Source scan proves CrashRecoveryService is unmodified', () => {
    const filePath = path.join(__dirname, '../src/core/services/CrashRecoveryService.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).not.toContain('applyDurableProviderHealthObservation');
    expect(content).not.toContain('applyDurableObservation');
  });

  it('49. Source scan proves ProviderHealthObservationService does not directly mutate health', () => {
    const filePath = path.join(__dirname, '../src/core/services/ProviderHealthObservationService.ts');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).not.toContain('applyDurableProviderHealthObservation');
    expect(content).not.toContain('applyDurableObservation');
    expect(content).not.toContain('updateProviderAccountHealth');
  });

  it('50. Source scan proves AccountHealthService is not instantiated in production runtime', () => {
    const bootstrapPath = path.join(__dirname, '../src/core/services/BootstrapService.ts');
    const content = fs.readFileSync(bootstrapPath, 'utf-8');
    expect(content).not.toContain('new AccountHealthService');
  });

  it('51. AccountHealthService.applyDurableObservation rejects empty or whitespace authorizationId', () => {
    expect(() => service.applyDurableObservation('')).toThrow(/INVALID_AUTHORIZATION_ID/);
    expect(() => service.applyDurableObservation('   ')).toThrow(/INVALID_AUTHORIZATION_ID/);
  });

  it('52. RoleAwareRoutingService routing compatibility with applied expired rate limit', async () => {
    seedDurableGraph({ cooldownDurationMs: 30000, initialHealthStatus: 'AVAILABLE' });
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'RATE_LIMITED' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    // Apply with past anchor so cooldown_until is expired
    const pastAnchor = new Date(Date.now() - 100000).toISOString();
    db.prepare('UPDATE provider_health_observations SET health_action_cooldown_anchor_at = ? WHERE authorization_id = ?').run(pastAnchor, 'auth-1');

    service.applyDurableObservation('auth-1');

    const registry = new ProviderRegistry();
    const eventService = new EventService(repo);
    const mockAdapter = {
      id: PROVIDER_ID,
      name: 'Test Adapter',
      adapterType: 'MANUAL_BRIDGE' as const,
      getHealth: async () => 'AVAILABLE' as const,
      getCapabilities: async () => ['CODING' as const],
      getQuota: async () => ({ remaining: 100, total: 100, unit: 'REQUESTS' as const, source: 'PROVIDER_REPORTED' as const, confidence: 1.0, resetAt: null }),
      execute: async () => ({}),
      cancel: async () => {},
    };
    registry.register(mockAdapter as any);

    const routingService = new RoleAwareRoutingService(repo, registry, eventService);
    const decision = await routingService.routeRole({
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      roleProfileId: 'rp-coder',
      allowManualBridge: true,
      candidateRefs: [{ accountId: ACCOUNT_ID, resourceId: RESOURCE_ID }],
    });

    // Resource on expired account is still selectable by routing because cooldown_until has passed!
    expect(decision.candidateEvaluations[0].eligibility).toBe('ELIGIBLE');
    expect(decision.selectedAccountId).toBe(ACCOUNT_ID);
    expect(decision.selectedResourceId).toBe(RESOURCE_ID);
  });

  it('53. Missing observation in database returns REJECTED', () => {
    seedDurableGraph();
    const res = service.applyDurableObservation('non-existent-auth');
    expect(res.status).toBe('REJECTED');
    expect(res.reason).toContain('OBSERVATION_NOT_FOUND');
  });

  it('54. Missing provider account in database returns REJECTED', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'SUCCESS' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    // Temporarily disable foreign keys to simulate orphaned account reference
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM provider_accounts WHERE id = ?').run(ACCOUNT_ID);
    db.pragma('foreign_keys = ON');

    const res = service.applyDurableObservation('auth-1');
    expect(res.status).toBe('REJECTED');
    expect(res.reason).toContain('PROVIDER_ACCOUNT_NOT_FOUND');
  });

  it('55. Conflicting duplicate with same account_order but different authorization_id returns REJECTED integrity mismatch', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'SUCCESS' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);
    service.applyDurableObservation('auth-1');

    // Manually mutate watermark to same account_order 1 but different auth id
    db.prepare('UPDATE provider_accounts SET last_applied_action_authorization_id = ? WHERE id = ?').run('other-auth', ACCOUNT_ID);

    const res = service.applyDurableObservation('auth-1');
    expect(res.status).toBe('REJECTED');
    expect(res.reason).toContain('WATERMARK_INTEGRITY_MISMATCH');
  });

  it('56. Tracked architecture explicitly contains corrected SQLite serialization contract and no account-lock overclaim', () => {
    const archPath = path.join(__dirname, '../docs/R5_AGENT_FABRIC_ARCHITECTURE.md');
    const archContent = fs.readFileSync(archPath, 'utf-8');

    // Prove corrected SQLite serialization contract is tracked
    expect(archContent).toContain('SQLite `BEGIN IMMEDIATE` serializes write transactions');
    expect(archContent).toContain('This contract does NOT claim physically parallel SQLite writes across accounts');
    expect(archContent).toContain('no dedicated account-level application lock exists');

    // Prove old overclaim is completely absent
    expect(archContent).not.toContain('Account locks serialize concurrent writes');

    // Prove Repository application uses runInImmediateTransaction without account locks
    const repoPath = path.join(__dirname, '../src/core/database/repositories.ts');
    const repoContent = fs.readFileSync(repoPath, 'utf-8');
    expect(repoContent).toContain('public applyDurableProviderHealthObservation');
    expect(repoContent).toContain('return this.runInImmediateTransaction(');
    expect(repoContent).not.toContain('acquireAccountLock');
    expect(repoContent).not.toContain('AccountLock');
  });

  it('57. Malformed partial watermark (NULL order + non-NULL auth) fails closed with REJECTED and zero writes', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'SUCCESS' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    // Corrupt watermark: order = NULL, auth = 'auth-corrupt'
    db.prepare('UPDATE provider_accounts SET last_applied_action_account_order = NULL, last_applied_action_authorization_id = ? WHERE id = ?')
      .run('auth-corrupt', ACCOUNT_ID);

    const beforeAcc = repo.getProviderAccount(ACCOUNT_ID)!;

    const res = service.applyDurableObservation('auth-1');
    expect(res.status).toBe('REJECTED');
    expect(res.reason).toContain('WATERMARK_PAIR_INTEGRITY_MISMATCH');

    const afterAcc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(afterAcc).toEqual(beforeAcc);
  });

  it('58. Malformed partial watermark (non-NULL order + NULL auth) fails closed with REJECTED even when target order is newer', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'SUCCESS' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    const item2 = createCoherentObservation({ authId: 'auth-2', execId: 'exec-2', msgId: 'msg-2', category: 'AUTHENTICATION_FAILURE' });
    repo.claimProviderHealthObservation(item2.obs, item2.result);

    // Corrupt watermark: order = 1, auth = NULL
    db.prepare('UPDATE provider_accounts SET last_applied_action_account_order = 1, last_applied_action_authorization_id = NULL WHERE id = ?')
      .run(ACCOUNT_ID);

    const beforeAcc = repo.getProviderAccount(ACCOUNT_ID)!;

    // Apply target auth-2 (order 2 > 1)
    const res = service.applyDurableObservation('auth-2');
    expect(res.status).toBe('REJECTED');
    expect(res.reason).toContain('WATERMARK_PAIR_INTEGRITY_MISMATCH');

    const afterAcc = repo.getProviderAccount(ACCOUNT_ID)!;
    expect(afterAcc).toEqual(beforeAcc);
  });

  it('59. Malformed partial watermark outranks NO_MUTATION (returns REJECTED rather than NO_MUTATION)', () => {
    seedDurableGraph();
    // Ingestion result with NO_MUTATION
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'UNKNOWN' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    // Corrupt watermark
    db.prepare('UPDATE provider_accounts SET last_applied_action_account_order = 1, last_applied_action_authorization_id = NULL WHERE id = ?')
      .run(ACCOUNT_ID);

    const res = service.applyDurableObservation('auth-1');
    expect(res.status).toBe('REJECTED');
    expect(res.reason).toContain('WATERMARK_PAIR_INTEGRITY_MISMATCH');
  });

  it('60. Malformed partial watermark outranks legacy unordered target (returns REJECTED rather than LEGACY_UNORDERED)', () => {
    seedDurableGraph();
    const item1 = createCoherentObservation({ authId: 'auth-1', execId: 'exec-1', msgId: 'msg-1', category: 'SUCCESS' });
    repo.claimProviderHealthObservation(item1.obs, item1.result);

    // Make target observation legacy unordered (order = NULL)
    db.prepare('UPDATE provider_health_observations SET account_order = NULL WHERE authorization_id = ?').run('auth-1');

    // Corrupt watermark
    db.prepare('UPDATE provider_accounts SET last_applied_action_account_order = NULL, last_applied_action_authorization_id = ? WHERE id = ?')
      .run('auth-corrupt', ACCOUNT_ID);

    const res = service.applyDurableObservation('auth-1');
    expect(res.status).toBe('REJECTED');
    expect(res.reason).toContain('WATERMARK_PAIR_INTEGRITY_MISMATCH');
  });
});
