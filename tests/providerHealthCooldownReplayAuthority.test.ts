import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Repository } from '../src/core/database/repositories';
import { MigrationRunner, MIGRATIONS } from '../src/core/database/migrations';
import { AccountHealthService } from '../src/core/services/AccountHealthService';
import { ProviderDispatchExecutionResult } from '../src/core/services/ProviderDispatchService';
import { ProviderHealthObservation } from '../src/core/types/domain';
import * as fs from 'fs';
import * as path from 'path';

describe('R5H4 Provider Health Cooldown Replay Authority Contract Tests', () => {
  let db: Database.Database;
  let repo: Repository;

  const PROJECT_ID = 'proj-cooldown-auth-1';
  const TASK_ID = 'task-cooldown-auth-1';
  const ATTEMPT_ID = 'att-cooldown-auth-1';
  const PROVIDER_ID = 'prov-cooldown-1';
  const ACCOUNT_ID = 'acc-cooldown-1';
  const RESOURCE_ID = 'res-cooldown-1';
  const ASSIGNMENT_ID = 'asgn-cooldown-1';
  const ROUTING_DECISION_ID = 'dec-cooldown-1';
  const EXECUTION_ID = 'exec-cooldown-1';
  const AUTH_ID = 'auth-cooldown-1';

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedDurableGraph(options?: {
    cooldownDurationMs?: number | null;
    includeSnapshot?: boolean;
  }) {
    const cooldownDuration = options && 'cooldownDurationMs' in options ? options.cooldownDurationMs : 60000;
    const includeSnapshot = options?.includeSnapshot ?? true;

    repo.createProject({
      id: PROJECT_ID,
      name: 'Cooldown Auth Project',
      description: 'Cooldown Auth Project Description',
      repository_path: 'd:/cooldown-repo',
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
      title: 'Cooldown Auth Task',
      description: 'Cooldown Auth Task Description',
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
      name: 'Cooldown Provider',
      adapter_type: 'MANUAL_BRIDGE',
      enabled: true,
      created_at: '2026-08-26T12:00:00.000Z',
    });

    repo.createProviderAccount({
      id: ACCOUNT_ID,
      provider_id: PROVIDER_ID,
      label: 'Cooldown Account 1',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: 'wincred://agentforge/cooldown_key_1',
      profile_ref: null,
      enabled: true,
      priority: 1,
      concurrency_limit: 5,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });

    repo.createProviderResource({
      id: RESOURCE_ID,
      provider_id: PROVIDER_ID,
      provider_account_id: ACCOUNT_ID,
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
      id: 'ap-coder',
      role_profile_id: 'rp-coder',
      name: 'Coder Profile',
      prompt_template: 'System Prompt',
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
      agent_profile_id: 'ap-coder',
      selected_provider_id: PROVIDER_ID,
      selected_account_id: ACCOUNT_ID,
      selected_resource_id: RESOURCE_ID,
      routing_decision_id: ROUTING_DECISION_ID,
      status: 'ASSIGNED',
      created_at: '2026-08-26T12:00:00.000Z',
      ended_at: null,
    } as any);

    repo.recordProtocolMessage(
      'msg-1',
      'msg-1',
      'manager.v1',
      PROJECT_ID,
      TASK_ID,
      'APPROVED',
      0,
      'sha-msg-1',
      JSON.stringify({ instruction: 'test' }),
      'APPLIED',
      undefined,
      '2026-08-26T12:00:00.000Z'
    );

    repo.createExecutionAuthorization({
      id: AUTH_ID,
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      attempt_id: ATTEMPT_ID,
      task_revision: 0,
      base_sha: '8cec7fcbe9edb51a7e3e03d7205eb5da425fb697',
      repository_head_sha: '8cec7fcbe9edb51a7e3e03d7205eb5da425fb697',
      manager_message_id: 'msg-1',
      manager_payload_hash: 'hash-1',
      routing_decision_id: ROUTING_DECISION_ID,
      selected_provider_id: PROVIDER_ID,
      selected_resource_id: RESOURCE_ID,
      canonical_instructions_json: JSON.stringify(['test']),
      context_files_json: JSON.stringify([]),
      canonical_payload_json: JSON.stringify({}),
      instruction_payload_hash: 'hash-payload-1',
      context_manifest_hash: 'hash-manifest-1',
      status: 'DISPATCHED',
      dispatched_at: '2026-08-26T12:00:00.000Z',
      created_at: '2026-08-26T12:00:00.000Z',
    });

    if (includeSnapshot) {
      repo.createEvent({
        id: ROUTING_DECISION_ID,
        project_id: PROJECT_ID,
        task_id: TASK_ID,
        agent_id: null,
        type: 'ROLE_AWARE_ROUTING_DECISION',
        timestamp: new Date().toISOString(),
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
  }

  function createResult(status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'AWAITING_OWNER', categoryText?: string): ProviderDispatchExecutionResult {
    let errorCode: any = null;
    let error = categoryText;
    if (status === 'FAILED') {
      if (categoryText === 'invalid api key') {
        errorCode = 'AUTH_ERROR';
      } else if (categoryText === 'quota exceeded') {
        errorCode = 'QUOTA_EXHAUSTED';
        error = 'quota exceeded out of credits';
      } else {
        errorCode = 'QUOTA_EXHAUSTED';
        error = 'rate limit 429 too many requests';
      }
    }
    return {
      executionId: EXECUTION_ID,
      status,
      rawResponse: 'result text',
      error,
      errorCode,
      providerExecutionProvenance: {
        version: 1,
        source: 'PROVIDER_DISPATCH_SERVICE',
        mode: 'LEGACY',
        adapterInvocation: 'RETURNED',
        authorizationId: AUTH_ID,
        executionId: EXECUTION_ID,
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        attemptId: ATTEMPT_ID,
        routingDecisionId: ROUTING_DECISION_ID,
        providerId: PROVIDER_ID,
        resourceId: RESOURCE_ID,
        assignmentId: ASSIGNMENT_ID,
        accountId: ACCOUNT_ID,
      },
    };
  }

  function createObservation(category: any, observedAt?: string): ProviderHealthObservation {
    return {
      authorization_id: AUTH_ID,
      execution_id: EXECUTION_ID,
      account_id: ACCOUNT_ID,
      provider_id: PROVIDER_ID,
      resource_id: RESOURCE_ID,
      assignment_id: ASSIGNMENT_ID,
      attempt_id: ATTEMPT_ID,
      routing_decision_id: ROUTING_DECISION_ID,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'LEGACY',
      adapter_invocation: 'RETURNED',
      result_status: category === 'SUCCESS' ? 'COMPLETED' : 'FAILED',
      classified_category: category,
      observed_at: observedAt ?? new Date().toISOString(),
    };
  }

  // =========================================================================
  // 1. Schema & Migration Immutability
  // =========================================================================

  it('1. Migration 14 exists with correct version and name', () => {
    const mig14 = MIGRATIONS.find((m) => m.version === 14);
    expect(mig14).toBeDefined();
    expect(mig14?.name).toBe('014_r5h4_provider_health_cooldown_replay_authority');
  });

  it('2. Migrations 1-13 definitions remain strictly immutable and unchanged', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(14);
    expect(MIGRATIONS[0].version).toBe(1);
    expect(MIGRATIONS[11].name).toBe('012_r5h4_provider_health_observation_ordering_authority');
    expect(MIGRATIONS[12].name).toBe('013_r5h4_durable_provider_health_action_plan_authority');
    expect(MIGRATIONS[13].name).toBe('014_r5h4_provider_health_cooldown_replay_authority');
  });

  it('3. health_action_cooldown_anchor_at column is nullable in provider_health_observations', () => {
    const tableInfo = db.prepare('PRAGMA table_info(provider_health_observations)').all() as { name: string; notnull: number; type: string }[];
    const anchorCol = tableInfo.find((c) => c.name === 'health_action_cooldown_anchor_at');
    expect(anchorCol).toBeDefined();
    expect(anchorCol?.notnull).toBe(0);
    expect(anchorCol?.type).toBe('TEXT');
  });

  it('4. No health_action_cooldown_until column is added to the database', () => {
    const tableInfo = db.prepare('PRAGMA table_info(provider_health_observations)').all() as { name: string }[];
    const untilCol = tableInfo.find((c) => c.name === 'health_action_cooldown_until');
    expect(untilCol).toBeUndefined();
  });

  // =========================================================================
  // 2. True v13 Upgrade Test & No Backfill
  // =========================================================================

  it('5. True v13 upgrade test: existing v13 rows retain health_action_cooldown_anchor_at = NULL without backfill', () => {
    const upgradeDb = new Database(':memory:');
    upgradeDb.pragma('foreign_keys = ON');

    // Run migrations 1 through 13 manually
    for (let v = 1; v <= 13; v++) {
      const m = MIGRATIONS.find((mig) => mig.version === v)!;
      m.up(upgradeDb);
      upgradeDb.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);`);
      upgradeDb.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        v,
        m.name,
        new Date().toISOString()
      );
    }

    // Insert a valid v13 observation with RECORD_RATE_LIMITED and duration
    upgradeDb.exec(`
      INSERT INTO projects (id, name, repository_path, default_branch, status, created_at, updated_at) VALUES ('p1', 'P1', 'd:/p1', 'main', 'READY', '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z');
      INSERT INTO tasks (id, project_id, title, state, priority, risk, max_revisions, acceptance_criteria_json, constraints_json, created_at, updated_at) VALUES ('t1', 'p1', 'T1', 'PLANNED', 'HIGH', 'LOW', 3, '[]', '[]', '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z');
      INSERT INTO providers (id, name, adapter_type, enabled, created_at) VALUES ('prov1', 'Prov1', 'MANUAL_BRIDGE', 1, '2026-08-20T00:00:00Z');
      INSERT INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, concurrency_limit, created_at, updated_at) VALUES ('acc1', 'prov1', 'Acc1', 'API_CREDENTIAL', 1, 1, 5, '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z');
      INSERT INTO provider_resources (id, provider_id, model_name, health_status, capabilities_json, enabled, provider_account_id) VALUES ('res1', 'prov1', 'm1', 'AVAILABLE', '[]', 1, 'acc1');
      INSERT INTO role_profiles (id, role, display_name, required_capabilities_json, preferred_capabilities_json, permissions_json, enabled, created_at, updated_at) VALUES ('rp1', 'CODER', 'Role', '[]', '[]', '[]', 1, '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z');
      INSERT INTO agent_assignments (id, project_id, task_id, role_profile_id, status, selected_provider_id, selected_account_id, selected_resource_id, routing_decision_id, created_at) VALUES ('asgn1', 'p1', 't1', 'rp1', 'ASSIGNED', 'prov1', 'acc1', 'res1', 'dec1', '2026-08-20T00:00:00Z');
      INSERT INTO protocol_messages (id, message_id, protocol, project_id, task_id, expected_task_state, expected_revision, payload_hash, raw_payload, status, created_at, processed_at) VALUES ('msg1', 'msg1', 'manager.v1', 'p1', 't1', 'APPROVED', 0, 'h1', '{}', 'APPLIED', '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z');
      INSERT INTO execution_authorizations (id, project_id, task_id, task_revision, base_sha, repository_head_sha, manager_message_id, manager_payload_hash, instruction_payload_hash, context_manifest_hash, canonical_instructions_json, context_files_json, routing_decision_id, selected_provider_id, selected_resource_id, status, created_at) VALUES ('auth1', 'p1', 't1', 0, 'sha1', 'sha1', 'msg1', 'h1', 'h1', 'h1', '[]', '[]', 'dec1', 'prov1', 'res1', 'DISPATCHED', '2026-08-20T00:00:00Z');

      INSERT INTO provider_health_observations (
        authorization_id, execution_id, account_id, provider_id, resource_id, assignment_id, attempt_id, routing_decision_id,
        provenance_version, provenance_source, mode, adapter_invocation, result_status, classified_category, observed_at,
        account_order, health_action_plan_version, health_action, health_action_cooldown_duration_ms
      ) VALUES (
        'auth1', 'exec1', 'acc1', 'prov1', 'res1', 'asgn1', NULL, 'dec1',
        1, 'PROVIDER_DISPATCH_SERVICE', 'LEGACY', 'RETURNED', 'FAILED', 'RATE_LIMITED', '2026-08-20T10:00:00.000Z',
        1, 1, 'RECORD_RATE_LIMITED', 45000
      );
    `);

    // Apply migration 14
    const m14 = MIGRATIONS.find((m) => m.version === 14)!;
    m14.up(upgradeDb);

    const row = upgradeDb.prepare('SELECT * FROM provider_health_observations WHERE authorization_id = ?').get('auth1') as any;
    expect(row.health_action).toBe('RECORD_RATE_LIMITED');
    expect(row.health_action_cooldown_duration_ms).toBe(45000);
    expect(row.health_action_cooldown_anchor_at).toBeNull();

    upgradeDb.close();
  });

  // =========================================================================
  // 3. Modern Fresh Ingestion & Temporal Anchor Allocation
  // =========================================================================

  it('6. New modern RECORD_RATE_LIMITED observation generates an authoritative non-null anchor', () => {
    seedDurableGraph({ cooldownDurationMs: 60000 });
    const beforeClaim = new Date().getTime();

    const obs = createObservation('RATE_LIMITED');
    const res = createResult('FAILED', 'rate limit 429');

    const claimRes = repo.claimProviderHealthObservation(obs, res);
    expect(claimRes).toBe('RECORDED');

    const afterClaim = new Date().getTime();

    const stored = repo.getProviderHealthObservation(AUTH_ID);
    expect(stored).not.toBeNull();
    expect(stored!.health_action).toBe('RECORD_RATE_LIMITED');
    expect(stored!.health_action_cooldown_duration_ms).toBe(60000);
    expect(stored!.health_action_cooldown_anchor_at).not.toBeNull();

    const anchorMs = Date.parse(stored!.health_action_cooldown_anchor_at!);
    expect(isNaN(anchorMs)).toBe(false);
    expect(anchorMs).toBeGreaterThanOrEqual(beforeClaim);
    expect(anchorMs).toBeLessThanOrEqual(afterClaim);
  });

  it('7. Cooldown anchor is allocated after action derivation inside atomic claim', () => {
    seedDurableGraph({ cooldownDurationMs: 90000 });
    const obs = createObservation('RATE_LIMITED');
    const res = createResult('FAILED', 'rate limit 429');

    repo.claimProviderHealthObservation(obs, res);
    const stored = repo.getProviderHealthObservation(AUTH_ID);
    expect(stored!.health_action_cooldown_anchor_at).not.toBeNull();
    expect(stored!.health_action_plan_version).toBe(1);
  });

  it('8. Derived cooldown until = anchor + duration uniquely and accurately', () => {
    seedDurableGraph({ cooldownDurationMs: 120000 });
    const obs = createObservation('RATE_LIMITED');
    const res = createResult('FAILED', 'rate limit 429');

    repo.claimProviderHealthObservation(obs, res);
    const stored = repo.getProviderHealthObservation(AUTH_ID);

    const anchorMs = Date.parse(stored!.health_action_cooldown_anchor_at!);
    const derivedUntilMs = anchorMs + stored!.health_action_cooldown_duration_ms!;
    const derivedUntilIso = new Date(derivedUntilMs).toISOString();

    expect(derivedUntilMs).toBe(anchorMs + 120000);
    expect(new Date(derivedUntilIso).getTime()).toBe(derivedUntilMs);
  });

  it('9. Null or non-positive cooldown duration produces anchor = NULL', () => {
    seedDurableGraph({ cooldownDurationMs: 0 });
    const obs = createObservation('RATE_LIMITED');
    const res = createResult('FAILED', 'rate limit 429');

    repo.claimProviderHealthObservation(obs, res);
    const stored = repo.getProviderHealthObservation(AUTH_ID);
    expect(stored!.health_action_cooldown_anchor_at).toBeNull();
  });

  // =========================================================================
  // 4. Non-Rate-Limited Actions & Legacy Observations Persist Anchor = NULL
  // =========================================================================

  it('10. RECORD_SUCCESS action persists health_action_cooldown_anchor_at = NULL', () => {
    seedDurableGraph();
    const obs = createObservation('SUCCESS');
    const res = createResult('COMPLETED');

    repo.claimProviderHealthObservation(obs, res);
    const stored = repo.getProviderHealthObservation(AUTH_ID);
    expect(stored!.health_action).toBe('RECORD_SUCCESS');
    expect(stored!.health_action_cooldown_duration_ms).toBeNull();
    expect(stored!.health_action_cooldown_anchor_at).toBeNull();
  });

  it('11. RECORD_QUOTA_EXHAUSTED action persists health_action_cooldown_anchor_at = NULL', () => {
    seedDurableGraph();
    const obs = createObservation('QUOTA_EXHAUSTED');
    const res = createResult('FAILED', 'quota exceeded');

    repo.claimProviderHealthObservation(obs, res);
    const stored = repo.getProviderHealthObservation(AUTH_ID);
    expect(stored!.health_action).toBe('RECORD_QUOTA_EXHAUSTED');
    expect(stored!.health_action_cooldown_duration_ms).toBeNull();
    expect(stored!.health_action_cooldown_anchor_at).toBeNull();
  });

  it('12. RECORD_AUTH_ERROR action persists health_action_cooldown_anchor_at = NULL', () => {
    seedDurableGraph();
    const obs = createObservation('AUTHENTICATION_FAILURE');
    const res = createResult('FAILED', 'invalid api key');

    repo.claimProviderHealthObservation(obs, res);
    const stored = repo.getProviderHealthObservation(AUTH_ID);
    expect(stored!.health_action).toBe('RECORD_AUTH_ERROR');
    expect(stored!.health_action_cooldown_duration_ms).toBeNull();
    expect(stored!.health_action_cooldown_anchor_at).toBeNull();
  });

  it('13. NO_MUTATION action (e.g. rate limit with missing cooldown) persists health_action_cooldown_anchor_at = NULL', () => {
    seedDurableGraph({ cooldownDurationMs: null });
    const obs = createObservation('RATE_LIMITED');
    const res = createResult('FAILED', 'rate limit 429');

    repo.claimProviderHealthObservation(obs, res);
    const stored = repo.getProviderHealthObservation(AUTH_ID);
    expect(stored!.health_action).toBe('NO_MUTATION');
    expect(stored!.health_action_cooldown_duration_ms).toBeNull();
    expect(stored!.health_action_cooldown_anchor_at).toBeNull();
  });

  it('14. Legacy observation without routing snapshot persists health_action_cooldown_anchor_at = NULL', () => {
    seedDurableGraph({ includeSnapshot: false });
    const obs = createObservation('RATE_LIMITED');
    const res = createResult('FAILED', 'rate limit 429');

    repo.claimProviderHealthObservation(obs, res);
    const stored = repo.getProviderHealthObservation(AUTH_ID);
    expect(stored!.health_action_plan_version).toBeNull();
    expect(stored!.health_action).toBeNull();
    expect(stored!.health_action_cooldown_duration_ms).toBeNull();
    expect(stored!.health_action_cooldown_anchor_at).toBeNull();
  });

  // =========================================================================
  // 5. Anti-Forgery & Authority Verification
  // =========================================================================

  it('15. Caller-forged anchor in observation input is ignored by repository', () => {
    seedDurableGraph({ cooldownDurationMs: 60000 });
    const forgedAnchor = '2030-01-01T00:00:00.000Z';
    const obs = createObservation('RATE_LIMITED') as any;
    obs.health_action_cooldown_anchor_at = forgedAnchor;

    const res = createResult('FAILED', 'rate limit 429');
    repo.claimProviderHealthObservation(obs, res);

    const stored = repo.getProviderHealthObservation(AUTH_ID);
    expect(stored!.health_action_cooldown_anchor_at).not.toBe(forgedAnchor);
    const anchorYear = new Date(stored!.health_action_cooldown_anchor_at!).getFullYear();
    expect(anchorYear).not.toBe(2030);
  });

  it('16. observed_at is distinct from repository-allocated cooldown anchor', () => {
    seedDurableGraph({ cooldownDurationMs: 60000 });
    const arbitraryObservedAt = '2026-01-01T12:00:00.000Z';
    const obs = createObservation('RATE_LIMITED', arbitraryObservedAt);
    const res = createResult('FAILED', 'rate limit 429');

    repo.claimProviderHealthObservation(obs, res);
    const stored = repo.getProviderHealthObservation(AUTH_ID);

    expect(stored!.observed_at).toBe(arbitraryObservedAt);
    expect(stored!.health_action_cooldown_anchor_at).not.toBe(arbitraryObservedAt);
    expect(Date.parse(stored!.health_action_cooldown_anchor_at!)).toBeGreaterThan(Date.parse(arbitraryObservedAt));
  });

  it('17. Identical duplicate claim retains original anchor and does not recompute with new clock', () => {
    seedDurableGraph({ cooldownDurationMs: 60000 });
    const obs = createObservation('RATE_LIMITED');
    const res = createResult('FAILED', 'rate limit 429');

    repo.claimProviderHealthObservation(obs, res);
    const firstStored = repo.getProviderHealthObservation(AUTH_ID);
    const originalAnchor = firstStored!.health_action_cooldown_anchor_at;

    // Second claim
    const duplicateRes = repo.claimProviderHealthObservation(obs, res);
    expect(duplicateRes).toBe('ALREADY_RECORDED');

    const secondStored = repo.getProviderHealthObservation(AUTH_ID);
    expect(secondStored!.health_action_cooldown_anchor_at).toBe(originalAnchor);
  });

  it('18. Conflicting duplicate claim fails closed and does not alter anchor', () => {
    seedDurableGraph({ cooldownDurationMs: 60000 });
    const obs = createObservation('RATE_LIMITED');
    const res = createResult('FAILED', 'rate limit 429');

    repo.claimProviderHealthObservation(obs, res);
    const firstStored = repo.getProviderHealthObservation(AUTH_ID);

    const conflictingObs = { ...obs, classified_category: 'SUCCESS' as any };
    expect(() => repo.claimProviderHealthObservation(conflictingObs, res)).toThrow(/OBSERVATION_INTEGRITY_MISMATCH/);

    const afterConflict = repo.getProviderHealthObservation(AUTH_ID);
    expect(afterConflict!.health_action_cooldown_anchor_at).toBe(firstStored!.health_action_cooldown_anchor_at);
  });

  // =========================================================================
  // 6. Atomicity, Restart Durability & Deterministic Replay
  // =========================================================================

  it('19. Transaction rollback proof: aborted insert leaves no partial anchor or action plan', () => {
    seedDurableGraph({ cooldownDurationMs: 60000 });

    // Install an abort trigger on provider_health_observations
    db.exec(`
      CREATE TRIGGER test_abort_observation
      BEFORE INSERT ON provider_health_observations
      BEGIN
        SELECT RAISE(ABORT, 'INTENTIONAL_TEST_ABORT');
      END;
    `);

    const obs = createObservation('RATE_LIMITED');
    const res = createResult('FAILED', 'rate limit 429');

    expect(() => repo.claimProviderHealthObservation(obs, res)).toThrow(/INTENTIONAL_TEST_ABORT/);

    const stored = repo.getProviderHealthObservation(AUTH_ID);
    expect(stored).toBeNull();

    const count = (db.prepare('SELECT COUNT(*) as cnt FROM provider_health_observations').get() as { cnt: number }).cnt;
    expect(count).toBe(0);
  });

  it('20. Restart durability: database close and reopen preserves identical anchor and duration', () => {
    // Write to in-memory, transfer buffer or test across instances
    const serialized = db.serialize();
    seedDurableGraph({ cooldownDurationMs: 45000 });
    const obs = createObservation('RATE_LIMITED');
    const res = createResult('FAILED', 'rate limit 429');
    repo.claimProviderHealthObservation(obs, res);

    const beforeClose = repo.getProviderHealthObservation(AUTH_ID)!;
    const backupDb = new Database(db.serialize());
    const backupRepo = new Repository(backupDb);

    const afterReopen = backupRepo.getProviderHealthObservation(AUTH_ID)!;
    expect(afterReopen.health_action_cooldown_anchor_at).toBe(beforeClose.health_action_cooldown_anchor_at);
    expect(afterReopen.health_action_cooldown_duration_ms).toBe(beforeClose.health_action_cooldown_duration_ms);

    backupDb.close();
  });

  it('21. Restart preserves derived cooldown until identically', () => {
    seedDurableGraph({ cooldownDurationMs: 75000 });
    const obs = createObservation('RATE_LIMITED');
    const res = createResult('FAILED', 'rate limit 429');
    repo.claimProviderHealthObservation(obs, res);

    const stored1 = repo.getProviderHealthObservation(AUTH_ID)!;
    const until1 = Date.parse(stored1.health_action_cooldown_anchor_at!) + stored1.health_action_cooldown_duration_ms!;

    const backupDb = new Database(db.serialize());
    const backupRepo = new Repository(backupDb);
    const stored2 = backupRepo.getProviderHealthObservation(AUTH_ID)!;
    const until2 = Date.parse(stored2.health_action_cooldown_anchor_at!) + stored2.health_action_cooldown_duration_ms!;

    expect(until2).toBe(until1);
    backupDb.close();
  });

  it('22. Delayed replay computes the exact same absolute cooldown until without extension', () => {
    seedDurableGraph({ cooldownDurationMs: 60000 });
    const obs = createObservation('RATE_LIMITED');
    const res = createResult('FAILED', 'rate limit 429');
    repo.claimProviderHealthObservation(obs, res);

    const stored = repo.getProviderHealthObservation(AUTH_ID)!;

    // Derived at T1
    const untilT1 = Date.parse(stored.health_action_cooldown_anchor_at!) + stored.health_action_cooldown_duration_ms!;

    // Derived at T2 (simulate 30 minutes later)
    const simulatedT2 = Date.now() + 1800000;
    const untilT2 = Date.parse(stored.health_action_cooldown_anchor_at!) + stored.health_action_cooldown_duration_ms!;

    expect(untilT2).toBe(untilT1);
  });

  it('23. Duplicate replay derivation produces identical absolute until', () => {
    seedDurableGraph({ cooldownDurationMs: 60000 });
    const obs = createObservation('RATE_LIMITED');
    const res = createResult('FAILED', 'rate limit 429');
    repo.claimProviderHealthObservation(obs, res);

    const storedA = repo.getProviderHealthObservation(AUTH_ID)!;
    const untilA = Date.parse(storedA.health_action_cooldown_anchor_at!) + storedA.health_action_cooldown_duration_ms!;

    const storedB = repo.getProviderHealthObservation(AUTH_ID)!;
    const untilB = Date.parse(storedB.health_action_cooldown_anchor_at!) + storedB.health_action_cooldown_duration_ms!;

    expect(untilB).toBe(untilA);
  });

  it('24. Post-persistence system clock movement does not alter derived cooldown until', () => {
    seedDurableGraph({ cooldownDurationMs: 60000 });
    const obs = createObservation('RATE_LIMITED');
    const res = createResult('FAILED', 'rate limit 429');
    repo.claimProviderHealthObservation(obs, res);

    const stored = repo.getProviderHealthObservation(AUTH_ID)!;
    const derivedUntil = Date.parse(stored.health_action_cooldown_anchor_at!) + stored.health_action_cooldown_duration_ms!;

    // Regardless of what Date.now() returns in the future or past, anchor + duration is invariant
    expect(derivedUntil).toBe(Date.parse(stored.health_action_cooldown_anchor_at!) + 60000);
  });

  // =========================================================================
  // 7. Expired Rate-Limit Semantics & Precedence
  // =========================================================================

  it('25. Legacy v13 RATE_LIMITED observation with anchor = NULL is recognized as temporal authority unknown', () => {
    seedDurableGraph();
    // Simulate legacy v13 row
    db.prepare(`
      INSERT INTO provider_health_observations (
        authorization_id, execution_id, account_id, provider_id, resource_id, assignment_id, attempt_id, routing_decision_id,
        provenance_version, provenance_source, mode, adapter_invocation, result_status, classified_category, observed_at,
        account_order, health_action_plan_version, health_action, health_action_cooldown_duration_ms, health_action_cooldown_anchor_at
      ) VALUES (
        '${AUTH_ID}', '${EXECUTION_ID}', '${ACCOUNT_ID}', '${PROVIDER_ID}', '${RESOURCE_ID}', '${ASSIGNMENT_ID}', '${ATTEMPT_ID}', '${ROUTING_DECISION_ID}',
        1, 'PROVIDER_DISPATCH_SERVICE', 'LEGACY', 'RETURNED', 'FAILED', 'RATE_LIMITED', '2026-08-20T10:00:00.000Z',
        99, 1, 'RECORD_RATE_LIMITED', 60000, NULL
      );
    `).run();

    const row = repo.getProviderHealthObservation(AUTH_ID)!;
    expect(row.health_action).toBe('RECORD_RATE_LIMITED');
    expect(row.health_action_cooldown_duration_ms).toBe(60000);
    expect(row.health_action_cooldown_anchor_at).toBeNull();
  });

  it('26. Source scan proves Migration 14 performs no observed_at or migration-time backfill', () => {
    const migrationsSource = fs.readFileSync(path.join(__dirname, '../src/core/database/migrations.ts'), 'utf-8');
    const mig14Def = migrationsSource.slice(migrationsSource.indexOf("014_r5h4_provider_health_cooldown_replay_authority"));
    expect(mig14Def).not.toContain('UPDATE provider_health_observations');
    expect(mig14Def).not.toContain('SET health_action_cooldown_anchor_at');
    expect(mig14Def).not.toContain('observed_at');
  });

  it('27. Expired derived cooldown does not convert RECORD_RATE_LIMITED into NO_MUTATION', () => {
    seedDurableGraph({ cooldownDurationMs: 1000 }); // 1 second cooldown
    const obs = createObservation('RATE_LIMITED');
    const res = createResult('FAILED', 'rate limit 429');
    repo.claimProviderHealthObservation(obs, res);

    const stored = repo.getProviderHealthObservation(AUTH_ID)!;
    expect(stored.health_action).toBe('RECORD_RATE_LIMITED');
    expect(stored.health_action_cooldown_duration_ms).toBe(1000);
    expect(stored.health_action_cooldown_anchor_at).not.toBeNull();
  });

  it('28. Expired RECORD_RATE_LIMITED is never mapped to AVAILABLE or SUCCESS', () => {
    seedDurableGraph({ cooldownDurationMs: 1000 });
    const obs = createObservation('RATE_LIMITED');
    const res = createResult('FAILED', 'rate limit 429');
    repo.claimProviderHealthObservation(obs, res);

    const stored = repo.getProviderHealthObservation(AUTH_ID)!;
    expect(stored.health_action).not.toBe('RECORD_SUCCESS');
  });

  it('29. Source scan proves observation claim and anchor allocation invoke no AccountHealthService', () => {
    const repoSource = fs.readFileSync(path.join(__dirname, '../src/core/database/repositories.ts'), 'utf-8');
    const claimMethod = repoSource.slice(
      repoSource.indexOf('public claimProviderHealthObservation('),
      repoSource.indexOf('private mapProviderHealthObservation(')
    );
    expect(claimMethod).not.toContain('AccountHealthService');
    expect(claimMethod).not.toContain('updateProviderAccountHealth');
  });

  it('30. Source scan proves no application state columns are added to schema', () => {
    const tableInfo = db.prepare('PRAGMA table_info(provider_accounts)').all() as { name: string }[];
    const colNames = tableInfo.map((c) => c.name);
    expect(colNames).not.toContain('last_applied_account_order');
    expect(colNames).not.toContain('last_processed_account_order');
    expect(colNames).not.toContain('health_revision');
  });

  it('31. Source scan proves ProviderHealthObservationService does not generate cooldown anchors', () => {
    const obsServiceSource = fs.readFileSync(path.join(__dirname, '../src/core/services/ProviderHealthObservationService.ts'), 'utf-8');
    expect(obsServiceSource).not.toContain('health_action_cooldown_anchor_at');
  });

  it('32. Source scan proves ProviderDispatchService is unmodified', () => {
    const dispatchSource = fs.readFileSync(path.join(__dirname, '../src/core/services/ProviderDispatchService.ts'), 'utf-8');
    expect(dispatchSource).not.toContain('health_action_cooldown_anchor_at');
    expect(dispatchSource).not.toContain('cooldown_until');
  });

  // =========================================================================
  // 8. Routing & AccountHealthService API Gaps Verified
  // =========================================================================

  it('33. AccountHealthService.recordRateLimited rejects historical past cooldown timestamps', () => {
    const healthService = new AccountHealthService(repo, () => new Date('2026-08-27T12:00:00.000Z'));
    seedDurableGraph();

    const pastTimestamp = '2026-08-27T11:00:00.000Z';
    expect(() => {
      healthService.recordRateLimited(ACCOUNT_ID, { cooldownUntil: pastTimestamp });
    }).toThrow(/INVALID_COOLDOWN_TIMESTAMP: Cooldown timestamp must be strictly in the future/);
  });

  it('34. Low-level Repository.updateProviderAccountHealth accepts past cooldown_until', () => {
    seedDurableGraph();
    const pastTimestamp = '2026-08-27T10:00:00.000Z';

    repo.updateProviderAccountHealth(ACCOUNT_ID, 'RATE_LIMITED', pastTimestamp, 'RATE_LIMITED');
    const account = repo.getProviderAccount(ACCOUNT_ID)!;

    expect(account.health_status).toBe('RATE_LIMITED');
    expect(account.cooldown_until).toBe(pastTimestamp);
    expect(account.last_failure_code).toBe('RATE_LIMITED');
  });
});
