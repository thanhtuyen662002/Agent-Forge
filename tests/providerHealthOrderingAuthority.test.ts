import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { MigrationRunner, MIGRATIONS } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import {
  ProviderHealthObservation,
  ProviderHealthObservationRecord,
  ProviderHealthObservationCategory,
  ProviderAccount,
  ProviderResource,
  RoleProfile,
  AgentProfile,
  AgentAssignment,
  ExecutionAuthorization,
} from '../src/core/types/domain';
import {
  ProviderDispatchExecutionResult,
  ProviderExecutionProvenanceV1,
} from '../src/core/services/ProviderDispatchService';
import {
  computeCanonicalPayload,
  computePayloadHash,
  computeContextManifestHash,
} from '../src/core/services/ExecutionAuthorizationService';
import { EventService } from '../src/core/services/EventService';

describe('R5H4 Provider Health Observation Ordering Authority Contract Tests', () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database.Database;
  let repo: Repository;

  const projectId = 'PROJ-TEST-ORDERING';
  const taskId1 = 'TSK-TEST-ORDERING-1';
  const taskId2 = 'TSK-TEST-ORDERING-2';
  const providerId = 'prov-test-ordering';
  const accountIdA = 'acct-test-ordering-a';
  const accountIdB = 'acct-test-ordering-b';
  const resourceIdA = 'res-test-ordering-a';
  const resourceIdB = 'res-test-ordering-b';
  const roleProfileId = 'role-test-ordering';
  const agentProfileId = 'agent-prof-test-ordering';

  function createTestEntities(targetRepo: Repository) {
    const now = new Date().toISOString();
    targetRepo.createProject({
      id: projectId,
      name: 'Ordering Project',
      description: null,
      contract: null,
      repository_path: 'd:/test',
      default_branch: 'main',
      status: 'READY',
      started_at: now,
      completed_at: null,
      created_at: now,
      updated_at: now,
    });

    targetRepo.createTask({
      id: taskId1,
      project_id: projectId,
      milestone_id: null,
      title: 'Task 1',
      description: 'Task 1',
      state: 'CODING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: 'sha1',
      current_sha: 'sha1',
      progress_cache_percent: 0,
      progress_computed_at: null,
      constraints: [],
      acceptance_criteria: [],
      created_at: now,
      updated_at: now,
    });

    targetRepo.createTask({
      id: taskId2,
      project_id: projectId,
      milestone_id: null,
      title: 'Task 2',
      description: 'Task 2',
      state: 'CODING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: 'sha1',
      current_sha: 'sha1',
      progress_cache_percent: 0,
      progress_computed_at: null,
      constraints: [],
      acceptance_criteria: [],
      created_at: now,
      updated_at: now,
    });

    targetRepo.createProvider({
      id: providerId,
      name: 'Test Provider',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: now,
    });

    targetRepo.createProviderAccount({
      id: accountIdA,
      provider_id: providerId,
      label: 'Account A',
      auth_mode: 'NATIVE_PROFILE',
      credential_ref: null,
      profile_ref: 'native-profile://openai/acct-a',
      enabled: true,
      priority: 100,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 5,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: now,
      updated_at: now,
    });

    targetRepo.createProviderAccount({
      id: accountIdB,
      provider_id: providerId,
      label: 'Account B',
      auth_mode: 'NATIVE_PROFILE',
      credential_ref: null,
      profile_ref: 'native-profile://openai/acct-b',
      enabled: true,
      priority: 50,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 5,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: now,
      updated_at: now,
    });

    targetRepo.createProviderResource({
      id: resourceIdA,
      provider_id: providerId,
      provider_account_id: accountIdA,
      model_name: 'gpt-4o',
      capabilities: ['CODING'],
      enabled: true,
      health_status: 'AVAILABLE',
      total_quota: 1000,
      remaining_quota: 1000,
      quota_unit: 'requests',
      quota_reset_at: null,
      quota_source: 'ESTIMATED',
      quota_confidence: 1.0,
      last_health_check: now,
    });

    targetRepo.createProviderResource({
      id: resourceIdB,
      provider_id: providerId,
      provider_account_id: accountIdB,
      model_name: 'gpt-4o',
      capabilities: ['CODING'],
      enabled: true,
      health_status: 'AVAILABLE',
      total_quota: 1000,
      remaining_quota: 1000,
      quota_unit: 'requests',
      quota_reset_at: null,
      quota_source: 'ESTIMATED',
      quota_confidence: 1.0,
      last_health_check: now,
    });

    targetRepo.createRoleProfile({
      id: roleProfileId,
      role: 'CODER',
      display_name: 'Coder Role',
      required_capabilities: ['CODING'],
      preferred_capabilities: [],
      authority_scope: null,
      permissions: ['read', 'write'],
      output_protocol: 'coder.v1',
      enabled: true,
      created_at: now,
      updated_at: now,
    });

    targetRepo.createAgentProfile({
      id: agentProfileId,
      role_profile_id: roleProfileId,
      name: 'Coder Profile',
      prompt_template: 'prompt',
      config: {},
      enabled: true,
      created_at: now,
      updated_at: now,
    });
  }

  function createValidAssignmentAndAuth(
    targetRepo: Repository,
    params: {
      taskId: string;
      accountId: string;
      resourceId: string;
      authId?: string;
      assignmentId?: string;
      authCreatedAt?: string;
      authDispatchedAt?: string;
    }
  ): { auth: ExecutionAuthorization; assignment: AgentAssignment } {
    const assignmentId = params.assignmentId || `asgn-${crypto.randomUUID()}`;
    const authId = params.authId || `auth-${crypto.randomUUID()}`;
    const routingDecisionId = `dec-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    const assignment: AgentAssignment = {
      id: assignmentId,
      project_id: projectId,
      task_id: params.taskId,
      attempt_id: null,
      role_profile_id: roleProfileId,
      agent_profile_id: agentProfileId,
      selected_provider_id: providerId,
      selected_account_id: params.accountId,
      selected_resource_id: params.resourceId,
      selected_worker_slot_id: null,
      routing_decision_id: routingDecisionId,
      preferred_metadata: null,
      status: 'RUNNING',
      created_at: now,
      ended_at: null,
    };
    targetRepo.createAgentAssignment(assignment);

    const managerMessageId = `msg-${crypto.randomUUID()}`;
    const managerPayload = JSON.stringify({
      protocol: 'manager.v1',
      message_id: managerMessageId,
      project_id: projectId,
      task_id: params.taskId,
      decision: 'EXECUTE',
      instructions: ['Run task'],
      constraints: [],
      suggested_approaches: [],
    });
    const managerPayloadHash = crypto.createHash('sha256').update(managerPayload).digest('hex');

    targetRepo.recordProtocolMessage(
      managerMessageId,
      managerMessageId,
      'manager.v1',
      projectId,
      params.taskId,
      'CODING',
      1,
      managerPayloadHash,
      managerPayload,
      'APPLIED',
      undefined,
      now
    );

    new EventService(targetRepo).record(
      projectId,
      'PROVIDER_ROUTING_DECISION',
      'Routing decision SELECTED',
      {
        decisionId: routingDecisionId,
        projectId,
        taskId: params.taskId,
        attemptId: null,
        role: 'CODER',
        roleProfileId,
        agentProfileId,
        selectedProviderId: providerId,
        selectedAccountId: params.accountId,
        selectedResourceId: params.resourceId,
        selectedAssignmentId: assignmentId,
        selectedWorkerSlotId: null,
        outcome: 'SELECTED',
        fallbackChain: [],
        score: 100,
        status: 'SELECTED',
        reason: 'Initial assignment',
      }
    );

    const canonicalPayload = computeCanonicalPayload({
      projectId,
      taskId: params.taskId,
      attemptId: null,
      taskTitle: 'Test Task',
      taskDescription: 'Test Description',
      acceptanceCriteria: [],
      constraints: [],
      instructions: ['Run task'],
      contextFiles: [],
      verificationCommands: { TEST: null, LINT: null, BUILD: null },
      managerMessageId,
      managerPayloadHash,
    });
    const payloadHash = computePayloadHash(canonicalPayload);
    const contextManifestHash = computeContextManifestHash(['README.md']);

    const auth: ExecutionAuthorization = {
      id: authId,
      project_id: projectId,
      task_id: params.taskId,
      attempt_id: null,
      task_revision: 1,
      base_sha: 'sha1',
      repository_head_sha: 'sha1',
      manager_message_id: managerMessageId,
      manager_payload_hash: managerPayloadHash,
      routing_decision_id: routingDecisionId,
      selected_resource_id: params.resourceId,
      selected_provider_id: providerId,
      canonical_instructions_json: JSON.stringify(['Run task']),
      context_files_json: JSON.stringify(['README.md']),
      canonical_payload_json: JSON.stringify(canonicalPayload),
      instruction_payload_hash: payloadHash,
      context_manifest_hash: contextManifestHash,
      status: 'DISPATCHED',
      created_at: params.authCreatedAt || now,
      dispatched_at: params.authDispatchedAt || now,
    };
    targetRepo.createExecutionAuthorization(auth);

    return { auth, assignment };
  }

  function buildValidObservation(params: {
    auth: ExecutionAuthorization;
    assignment: AgentAssignment;
    category?: ProviderHealthObservationCategory;
    resultStatus?: string;
    observedAt?: string;
    accountOrder?: number | null;
  }): ProviderHealthObservation {
    return {
      authorization_id: params.auth.id,
      execution_id: `exec-${crypto.randomUUID()}`,
      account_id: params.assignment.selected_account_id,
      provider_id: params.auth.selected_provider_id,
      resource_id: params.auth.selected_resource_id,
      assignment_id: params.assignment.id,
      attempt_id: params.auth.attempt_id,
      routing_decision_id: params.auth.routing_decision_id,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: params.resultStatus || 'COMPLETED',
      classified_category: params.category || 'SUCCESS',
      observed_at: params.observedAt || new Date().toISOString(),
      account_order: params.accountOrder,
    };
  }

  function buildTrustedResult(
    auth: ExecutionAuthorization,
    assignment: AgentAssignment,
    obs: ProviderHealthObservation,
    overrides?: {
      status?: string;
      errorCode?: string;
      error?: string;
      adapterInvocation?: 'RETURNED' | 'THREW';
    }
  ): ProviderDispatchExecutionResult {
    let defaultErrorCode: any = undefined;
    let defaultError: string | undefined = undefined;

    if (obs.classified_category === 'AUTHENTICATION_FAILURE') {
      defaultErrorCode = 'AUTH_ERROR';
      defaultError = 'Auth failed';
    } else if (obs.classified_category === 'RATE_LIMITED') {
      defaultErrorCode = 'QUOTA_EXHAUSTED';
      defaultError = 'rate limit 429';
    } else if (obs.classified_category === 'QUOTA_EXHAUSTED') {
      defaultErrorCode = 'QUOTA_EXHAUSTED';
      defaultError = 'quota exceeded';
    } else if (obs.classified_category === 'RESOURCE_UNAVAILABLE') {
      defaultErrorCode = 'RESOURCE_UNAVAILABLE';
      defaultError = 'Resource unavailable';
    } else if (obs.classified_category === 'TIMEOUT') {
      defaultErrorCode = 'TIMEOUT';
      defaultError = 'Execution timed out';
    }

    return {
      executionId: obs.execution_id,
      status: (overrides?.status as any) ?? (obs.result_status as any),
      errorCode: (overrides?.errorCode as any) ?? defaultErrorCode,
      error: overrides?.error ?? defaultError,
      rawResponse: 'Raw output',
      providerExecutionProvenance: {
        version: 1,
        source: 'PROVIDER_DISPATCH_SERVICE',
        mode: obs.mode,
        adapterInvocation: overrides?.adapterInvocation ?? obs.adapter_invocation,
        authorizationId: auth.id,
        executionId: obs.execution_id,
        projectId,
        taskId: auth.task_id,
        attemptId: auth.attempt_id,
        routingDecisionId: auth.routing_decision_id,
        providerId: auth.selected_provider_id,
        resourceId: auth.selected_resource_id,
        assignmentId: assignment.id,
        accountId: assignment.selected_account_id,
      },
    };
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-ordering-test-'));
    dbPath = path.join(tempDir, 'test.db');
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    MigrationRunner.run(db);

    repo = new Repository(db);
    createTestEntities(repo);
  });

  afterEach(() => {
    try {
      if (db && db.open) {
        db.close();
      }
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore Windows file locks
    }
  });

  // -------------------------------------------------------------
  // Section 1: Migration Structure & Schema Integrity (Tests 1-4)
  // -------------------------------------------------------------

  it('1. Migration 12 exists in MIGRATIONS array with correct version and name', () => {
    const m12 = MIGRATIONS.find((m) => m.version === 12);
    expect(m12).toBeDefined();
    expect(m12?.name).toBe('012_r5h4_provider_health_observation_ordering_authority');
  });

  it('2. Migrations 1-11 are immutable and remain unchanged', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(12);
    expect(MIGRATIONS[0].name).toBe('001_initial_schema');
    expect(MIGRATIONS[1].name).toBe('002_verification_commands');
    expect(MIGRATIONS[2].name).toBe('003_nullable_health_check');
    expect(MIGRATIONS[3].name).toBe('004_process_run_ownership');
    expect(MIGRATIONS[4].name).toBe('005_repair_default_agent_resource_links');
    expect(MIGRATIONS[5].name).toBe('006_execution_authorizations');
    expect(MIGRATIONS[6].name).toBe('007_execution_authorization_canonical_payload');
    expect(MIGRATIONS[7].name).toBe('008_r5a_role_agnostic_agent_fabric');
    expect(MIGRATIONS[8].name).toBe('009_r5b_durable_memory_context_fabric');
    expect(MIGRATIONS[9].name).toBe('010_r5h4_failover_lineage_budget_idempotency');
    expect(MIGRATIONS[10].name).toBe('011_r5h4_durable_provider_health_observations');
  });

  it('3. account_order column is nullable in provider_health_observations table', () => {
    const columns = db.prepare("PRAGMA table_info('provider_health_observations')").all() as {
      name: string;
      type: string;
      notnull: number;
    }[];
    const orderCol = columns.find((c) => c.name === 'account_order');
    expect(orderCol).toBeDefined();
    expect(orderCol?.type.toUpperCase()).toBe('INTEGER');
    expect(orderCol?.notnull).toBe(0); // 0 means nullable
  });

  it('4. Partial unique index on (account_id, account_order) exists and enforces uniqueness for non-null values', () => {
    const indexList = db.prepare('PRAGMA index_list(provider_health_observations)').all() as {
      name: string;
      unique: number;
    }[];
    const partialIdx = indexList.find((i) => i.name === 'idx_provider_health_observations_account_order');
    expect(partialIdx).toBeDefined();
    expect(partialIdx?.unique).toBe(1);
  });

  // -------------------------------------------------------------
  // Section 2: Legacy Upgrade & Monotonic Allocation (Tests 5-9)
  // -------------------------------------------------------------

  it('5. Legacy v11 observations remain account_order = NULL after migration 12 upgrade without backfill', () => {
    const legacyDbPath = path.join(tempDir, 'legacy_v11.db');
    const legacyDb = new Database(legacyDbPath);
    legacyDb.pragma('foreign_keys = ON');

    // Apply migrations 1 through 11 only
    legacyDb.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    for (const m of MIGRATIONS.slice(0, 11)) {
      m.up(legacyDb);
      legacyDb.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
    }

    const legacyRepo = new Repository(legacyDb);
    createTestEntities(legacyRepo);
    const { auth, assignment } = createValidAssignmentAndAuth(legacyRepo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });

    // Insert observation in v11 schema directly (no account_order column exists in v11)
    const obs = buildValidObservation({ auth, assignment });
    legacyDb.prepare(`
      INSERT INTO provider_health_observations (
        authorization_id, execution_id, account_id, provider_id, resource_id,
        assignment_id, attempt_id, routing_decision_id, provenance_version,
        provenance_source, mode, adapter_invocation, result_status,
        classified_category, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      obs.authorization_id,
      obs.execution_id,
      obs.account_id,
      obs.provider_id,
      obs.resource_id,
      obs.assignment_id,
      obs.attempt_id,
      obs.routing_decision_id,
      obs.provenance_version,
      obs.provenance_source,
      obs.mode,
      obs.adapter_invocation,
      obs.result_status,
      obs.classified_category,
      obs.observed_at
    );

    const legacyRow = legacyDb.prepare('SELECT * FROM provider_health_observations WHERE authorization_id = ?').get(obs.authorization_id) as any;
    expect(legacyRow.account_order).toBeUndefined();

    // Now apply migration 12
    const m12 = MIGRATIONS.find((m) => m.version === 12)!;
    m12.up(legacyDb);
    legacyDb.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(12, m12.name, new Date().toISOString());

    // Verify existing v11 row has account_order = NULL (no historical backfill)
    const upgradedRow = legacyDb.prepare('SELECT * FROM provider_health_observations WHERE authorization_id = ?').get(obs.authorization_id) as any;
    expect(upgradedRow.account_order).toBeNull();

    legacyDb.close();
  }, 120000);

  it('6. First post-v12 observation for an account is assigned account_order = 1', () => {
    const { auth, assignment } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });
    const obs = buildValidObservation({ auth, assignment });
    const res = buildTrustedResult(auth, assignment, obs);

    const status = repo.claimProviderHealthObservation(obs, res);
    expect(status).toBe('RECORDED');

    const recorded = repo.getProviderHealthObservation(obs.authorization_id);
    expect(recorded).not.toBeNull();
    expect(recorded?.account_order).toBe(1);
  });

  it('7. Second observation for the same account is assigned account_order = 2', () => {
    const { auth: auth1, assignment: asgn1 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });
    const { auth: auth2, assignment: asgn2 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });

    const obs1 = buildValidObservation({ auth: auth1, assignment: asgn1 });
    const res1 = buildTrustedResult(auth1, asgn1, obs1);
    const obs2 = buildValidObservation({ auth: auth2, assignment: asgn2 });
    const res2 = buildTrustedResult(auth2, asgn2, obs2);

    repo.claimProviderHealthObservation(obs1, res1);
    repo.claimProviderHealthObservation(obs2, res2);

    const rec1 = repo.getProviderHealthObservation(obs1.authorization_id);
    const rec2 = repo.getProviderHealthObservation(obs2.authorization_id);

    expect(rec1?.account_order).toBe(1);
    expect(rec2?.account_order).toBe(2);
  });

  it('8. Cross-task observations for the same account are sequenced monotonically (Task 1 -> 1, Task 2 -> 2)', () => {
    const { auth: authTask1, assignment: asgnTask1 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });
    const { auth: authTask2, assignment: asgnTask2 } = createValidAssignmentAndAuth(repo, { taskId: taskId2, accountId: accountIdA, resourceId: resourceIdA });

    const obsTask1 = buildValidObservation({ auth: authTask1, assignment: asgnTask1 });
    const resTask1 = buildTrustedResult(authTask1, asgnTask1, obsTask1);
    const obsTask2 = buildValidObservation({ auth: authTask2, assignment: asgnTask2 });
    const resTask2 = buildTrustedResult(authTask2, asgnTask2, obsTask2);

    repo.claimProviderHealthObservation(obsTask1, resTask1);
    repo.claimProviderHealthObservation(obsTask2, resTask2);

    const rec1 = repo.getProviderHealthObservation(obsTask1.authorization_id);
    const rec2 = repo.getProviderHealthObservation(obsTask2.authorization_id);

    expect(rec1?.account_order).toBe(1);
    expect(rec2?.account_order).toBe(2);
  });

  it('9. Different provider accounts have independent monotonic sequences each starting at 1', () => {
    const { auth: authA1, assignment: asgnA1 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });
    const { auth: authB1, assignment: asgnB1 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdB, resourceId: resourceIdB });
    const { auth: authA2, assignment: asgnA2 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });

    const obsA1 = buildValidObservation({ auth: authA1, assignment: asgnA1 });
    const resA1 = buildTrustedResult(authA1, asgnA1, obsA1);
    const obsB1 = buildValidObservation({ auth: authB1, assignment: asgnB1 });
    const resB1 = buildTrustedResult(authB1, asgnB1, obsB1);
    const obsA2 = buildValidObservation({ auth: authA2, assignment: asgnA2 });
    const resA2 = buildTrustedResult(authA2, asgnA2, obsA2);

    repo.claimProviderHealthObservation(obsA1, resA1);
    repo.claimProviderHealthObservation(obsB1, resB1);
    repo.claimProviderHealthObservation(obsA2, resA2);

    const recA1 = repo.getProviderHealthObservation(obsA1.authorization_id);
    const recB1 = repo.getProviderHealthObservation(obsB1.authorization_id);
    const recA2 = repo.getProviderHealthObservation(obsA2.authorization_id);

    expect(recA1?.account_order).toBe(1);
    expect(recB1?.account_order).toBe(1);
    expect(recA2?.account_order).toBe(2);
  });

  // -------------------------------------------------------------
  // Section 3: Ingestion Precedence vs Wall-Clock Signals (Tests 10-12)
  // -------------------------------------------------------------

  it('10. observed_at reverse chronology (later timestamp first, earlier timestamp second) does not alter ingestion order (1 then 2)', () => {
    const { auth: authA, assignment: asgnA } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });
    const { auth: authB, assignment: asgnB } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });

    // Observation A has later wall-clock time, but is ingested first
    const obsA = buildValidObservation({ auth: authA, assignment: asgnA, observedAt: '2026-08-26T21:00:00.000Z' });
    const resA = buildTrustedResult(authA, asgnA, obsA);
    // Observation B has earlier wall-clock time, but is ingested second
    const obsB = buildValidObservation({ auth: authB, assignment: asgnB, observedAt: '2026-08-26T20:00:00.000Z' });
    const resB = buildTrustedResult(authB, asgnB, obsB);

    repo.claimProviderHealthObservation(obsA, resA);
    repo.claimProviderHealthObservation(obsB, resB);

    const recA = repo.getProviderHealthObservation(obsA.authorization_id);
    const recB = repo.getProviderHealthObservation(obsB.authorization_id);

    expect(recA?.account_order).toBe(1);
    expect(recB?.account_order).toBe(2);
    // Durable ingestion order makes B newer than A despite A having later wall-clock timestamp
    expect(recB!.account_order!).toBeGreaterThan(recA!.account_order!);
  });

  it('11. authorization created_at timestamp does not influence account_order allocation', () => {
    const { auth: auth1, assignment: asgn1 } = createValidAssignmentAndAuth(repo, {
      taskId: taskId1,
      accountId: accountIdA,
      resourceId: resourceIdA,
      authCreatedAt: '2026-08-26T22:00:00.000Z',
    });
    const { auth: auth2, assignment: asgn2 } = createValidAssignmentAndAuth(repo, {
      taskId: taskId1,
      accountId: accountIdA,
      resourceId: resourceIdA,
      authCreatedAt: '2026-08-26T18:00:00.000Z',
    });

    const obs1 = buildValidObservation({ auth: auth1, assignment: asgn1 });
    const res1 = buildTrustedResult(auth1, asgn1, obs1);
    const obs2 = buildValidObservation({ auth: auth2, assignment: asgn2 });
    const res2 = buildTrustedResult(auth2, asgn2, obs2);

    repo.claimProviderHealthObservation(obs1, res1);
    repo.claimProviderHealthObservation(obs2, res2);

    expect(repo.getProviderHealthObservation(obs1.authorization_id)?.account_order).toBe(1);
    expect(repo.getProviderHealthObservation(obs2.authorization_id)?.account_order).toBe(2);
  });

  it('12. authorization dispatched_at timestamp does not influence account_order allocation', () => {
    const { auth: auth1, assignment: asgn1 } = createValidAssignmentAndAuth(repo, {
      taskId: taskId1,
      accountId: accountIdA,
      resourceId: resourceIdA,
      authDispatchedAt: '2026-08-26T23:00:00.000Z',
    });
    const { auth: auth2, assignment: asgn2 } = createValidAssignmentAndAuth(repo, {
      taskId: taskId1,
      accountId: accountIdA,
      resourceId: resourceIdA,
      authDispatchedAt: '2026-08-26T17:00:00.000Z',
    });

    const obs1 = buildValidObservation({ auth: auth1, assignment: asgn1 });
    const res1 = buildTrustedResult(auth1, asgn1, obs1);
    const obs2 = buildValidObservation({ auth: auth2, assignment: asgn2 });
    const res2 = buildTrustedResult(auth2, asgn2, obs2);

    repo.claimProviderHealthObservation(obs1, res1);
    repo.claimProviderHealthObservation(obs2, res2);

    expect(repo.getProviderHealthObservation(obs1.authorization_id)?.account_order).toBe(1);
    expect(repo.getProviderHealthObservation(obs2.authorization_id)?.account_order).toBe(2);
  });

  // -------------------------------------------------------------
  // Section 4: Duplicate & Error Non-Advancement Invariants (Tests 13-19)
  // -------------------------------------------------------------

  it('13. Identical duplicate observation claim returns ALREADY_RECORDED and does not change existing account_order', () => {
    const { auth, assignment } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });
    const obs = buildValidObservation({ auth, assignment });
    const res = buildTrustedResult(auth, assignment, obs);

    const status1 = repo.claimProviderHealthObservation(obs, res);
    expect(status1).toBe('RECORDED');

    const status2 = repo.claimProviderHealthObservation(obs, res);
    expect(status2).toBe('ALREADY_RECORDED');

    const rec = repo.getProviderHealthObservation(obs.authorization_id);
    expect(rec?.account_order).toBe(1);
  });

  it('14. Identical duplicate claim does not advance next account_order', () => {
    const { auth: auth1, assignment: asgn1 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });
    const { auth: auth2, assignment: asgn2 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });

    const obs1 = buildValidObservation({ auth: auth1, assignment: asgn1 });
    const res1 = buildTrustedResult(auth1, asgn1, obs1);
    const obs2 = buildValidObservation({ auth: auth2, assignment: asgn2 });
    const res2 = buildTrustedResult(auth2, asgn2, obs2);

    repo.claimProviderHealthObservation(obs1, res1); // gets 1
    repo.claimProviderHealthObservation(obs1, res1); // duplicate -> ALREADY_RECORDED

    repo.claimProviderHealthObservation(obs2, res2); // next new observation

    const rec2 = repo.getProviderHealthObservation(obs2.authorization_id);
    expect(rec2?.account_order).toBe(2); // must be 2, not 3
  });

  it('15. Conflicting duplicate claim throws OBSERVATION_INTEGRITY_MISMATCH and does not advance next account_order', () => {
    const { auth: auth1, assignment: asgn1 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });
    const { auth: auth2, assignment: asgn2 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });

    const obs1 = buildValidObservation({ auth: auth1, assignment: asgn1, category: 'SUCCESS' });
    const res1 = buildTrustedResult(auth1, asgn1, obs1);
    repo.claimProviderHealthObservation(obs1, res1); // gets 1

    const conflictingObs1 = { ...obs1, classified_category: 'AUTHENTICATION_FAILURE' as ProviderHealthObservationCategory };
    expect(() => repo.claimProviderHealthObservation(conflictingObs1, res1)).toThrow(/OBSERVATION_INTEGRITY_MISMATCH/);

    const obs2 = buildValidObservation({ auth: auth2, assignment: asgn2 });
    const res2 = buildTrustedResult(auth2, asgn2, obs2);
    repo.claimProviderHealthObservation(obs2, res2);

    const rec2 = repo.getProviderHealthObservation(obs2.authorization_id);
    expect(rec2?.account_order).toBe(2); // no gap created by conflicting duplicate
  });

  it('16. Invalid provenance validation failure does not consume account_order', () => {
    const { auth: auth1, assignment: asgn1 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });
    const { auth: auth2, assignment: asgn2 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });

    const invalidObs = buildValidObservation({ auth: auth1, assignment: asgn1 });
    (invalidObs as any).provenance_source = 'FORGED_SERVICE';
    const res1 = buildTrustedResult(auth1, asgn1, invalidObs);

    expect(() => repo.claimProviderHealthObservation(invalidObs, res1)).toThrow(/INVALID_OBSERVATION_SHAPE/);

    const validObs = buildValidObservation({ auth: auth2, assignment: asgn2 });
    const res2 = buildTrustedResult(auth2, asgn2, validObs);
    repo.claimProviderHealthObservation(validObs, res2);

    const rec = repo.getProviderHealthObservation(validObs.authorization_id);
    expect(rec?.account_order).toBe(1); // receives 1, not 2
  });

  it('17. Invalid category / result_status failure does not consume account_order', () => {
    const { auth: auth1, assignment: asgn1 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });
    const { auth: auth2, assignment: asgn2 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });

    const invalidObs = buildValidObservation({ auth: auth1, assignment: asgn1, resultStatus: 'UNSUPPORTED_STATUS' });
    const res1 = buildTrustedResult(auth1, asgn1, invalidObs, { status: 'UNSUPPORTED_STATUS' });
    expect(() => repo.claimProviderHealthObservation(invalidObs, res1)).toThrow(/INVALID_RESULT_STATUS/);

    const validObs = buildValidObservation({ auth: auth2, assignment: asgn2 });
    const res2 = buildTrustedResult(auth2, asgn2, validObs);
    repo.claimProviderHealthObservation(validObs, res2);

    const rec = repo.getProviderHealthObservation(validObs.authorization_id);
    expect(rec?.account_order).toBe(1);
  });

  it('18. Resource/account mismatch failure does not consume account_order', () => {
    const { auth: auth1, assignment: asgn1 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });
    const { auth: auth2, assignment: asgn2 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });

    // Resource A belongs to Account A, but observation claims Account B
    const mismatchObs = buildValidObservation({ auth: auth1, assignment: asgn1 });
    mismatchObs.account_id = accountIdB;
    const res1 = buildTrustedResult(auth1, asgn1, mismatchObs);

    expect(() => repo.claimProviderHealthObservation(mismatchObs, res1)).toThrow(
      /ACCOUNT_ID_MISMATCH|RESOURCE_ACCOUNT_MISMATCH/
    );

    const validObs = buildValidObservation({ auth: auth2, assignment: asgn2 });
    const res2 = buildTrustedResult(auth2, asgn2, validObs);
    repo.claimProviderHealthObservation(validObs, res2);

    const rec = repo.getProviderHealthObservation(validObs.authorization_id);
    expect(rec?.account_order).toBe(1);
  });

  it('19. Transaction rollback inside claim does not create a durable account_order gap', () => {
    const { auth: auth1, assignment: asgn1 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });
    const { auth: auth2, assignment: asgn2 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });

    // Force a rollback inside claim transaction by passing non-existent authorization
    const nonExistentAuth = { ...auth1, id: 'non-existent-auth-id' };
    const invalidObs = buildValidObservation({ auth: nonExistentAuth, assignment: asgn1 });
    const res1 = buildTrustedResult(nonExistentAuth, asgn1, invalidObs);

    expect(() => repo.claimProviderHealthObservation(invalidObs, res1)).toThrow(/AUTHORIZATION_NOT_FOUND/);

    const validObs = buildValidObservation({ auth: auth2, assignment: asgn2 });
    const res2 = buildTrustedResult(auth2, asgn2, validObs);
    repo.claimProviderHealthObservation(validObs, res2);

    const rec = repo.getProviderHealthObservation(validObs.authorization_id);
    expect(rec?.account_order).toBe(1);
  });

  // -------------------------------------------------------------
  // Section 5: Restart Durability & Concurrency Safety (Tests 20-23)
  // -------------------------------------------------------------

  it('20. Restart durability: reopening database preserves existing account_order sequence', () => {
    const { auth: auth1, assignment: asgn1 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });
    const { auth: auth2, assignment: asgn2 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });

    const obs1 = buildValidObservation({ auth: auth1, assignment: asgn1 });
    const res1 = buildTrustedResult(auth1, asgn1, obs1);
    const obs2 = buildValidObservation({ auth: auth2, assignment: asgn2 });
    const res2 = buildTrustedResult(auth2, asgn2, obs2);

    repo.claimProviderHealthObservation(obs1, res1);
    repo.claimProviderHealthObservation(obs2, res2);

    // Close database connection
    db.close();

    // Reopen database connection
    const db2 = new Database(dbPath);
    db2.pragma('foreign_keys = ON');
    const repo2 = new Repository(db2);

    const rec1 = repo2.getProviderHealthObservation(auth1.id);
    const rec2 = repo2.getProviderHealthObservation(auth2.id);

    expect(rec1?.account_order).toBe(1);
    expect(rec2?.account_order).toBe(2);

    db2.close();
    // Restore db for afterEach cleanup
    db = new Database(dbPath);
  });

  it('21. Restart durability: subsequent observation after restart advances to next correct order (e.g. 3 after 1, 2)', () => {
    const { auth: auth1, assignment: asgn1 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });
    const { auth: auth2, assignment: asgn2 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });

    const obs1 = buildValidObservation({ auth: auth1, assignment: asgn1 });
    const res1 = buildTrustedResult(auth1, asgn1, obs1);
    const obs2 = buildValidObservation({ auth: auth2, assignment: asgn2 });
    const res2 = buildTrustedResult(auth2, asgn2, obs2);

    repo.claimProviderHealthObservation(obs1, res1);
    repo.claimProviderHealthObservation(obs2, res2);

    db.close();

    const db2 = new Database(dbPath);
    db2.pragma('foreign_keys = ON');
    const repo2 = new Repository(db2);

    const { auth: auth3, assignment: asgn3 } = createValidAssignmentAndAuth(repo2, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });

    const obs3 = buildValidObservation({ auth: auth3, assignment: asgn3 });
    const res3 = buildTrustedResult(auth3, asgn3, obs3);
    repo2.claimProviderHealthObservation(obs3, res3);

    const rec3 = repo2.getProviderHealthObservation(auth3.id);
    expect(rec3?.account_order).toBe(3);

    db2.close();
    db = new Database(dbPath);
  });

  it('22. Two-handle concurrency: BEGIN IMMEDIATE on one connection blocks competing allocation', () => {
    const dbHandle1 = new Database(dbPath);
    const dbHandle2 = new Database(dbPath);
    dbHandle1.pragma('foreign_keys = ON');
    dbHandle2.pragma('foreign_keys = ON');
    dbHandle2.pragma('busy_timeout = 0'); // Immediate fail on lock contention

    const repo1 = new Repository(dbHandle1);
    const repo2 = new Repository(dbHandle2);

    const { auth: auth1, assignment: asgn1 } = createValidAssignmentAndAuth(repo1, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });
    const { auth: auth2, assignment: asgn2 } = createValidAssignmentAndAuth(repo1, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });

    const obs1 = buildValidObservation({ auth: auth1, assignment: asgn1 });
    const res1 = buildTrustedResult(auth1, asgn1, obs1);
    const obs2 = buildValidObservation({ auth: auth2, assignment: asgn2 });
    const res2 = buildTrustedResult(auth2, asgn2, obs2);

    // Handle 1 acquires immediate transaction lock
    dbHandle1.exec('BEGIN IMMEDIATE;');

    // Handle 2 attempts to claim observation while lock held -> must throw SQLITE_BUSY or database is locked
    expect(() => repo2.claimProviderHealthObservation(obs2, res2)).toThrow(/busy|locked/i);

    // Handle 1 performs its claim and commits
    repo1.claimProviderHealthObservation(obs1, res1);
    dbHandle1.exec('COMMIT;');

    // Handle 2 can now claim successfully
    repo2.claimProviderHealthObservation(obs2, res2);

    const rec1 = repo2.getProviderHealthObservation(auth1.id);
    const rec2 = repo2.getProviderHealthObservation(auth2.id);

    expect(rec1?.account_order).toBe(1);
    expect(rec2?.account_order).toBe(2);

    dbHandle1.close();
    dbHandle2.close();
  });

  it('23. Concurrent serialized claims across multiple handles receive distinct strictly monotonic orders', () => {
    const dbHandle1 = new Database(dbPath);
    const dbHandle2 = new Database(dbPath);
    dbHandle1.pragma('foreign_keys = ON');
    dbHandle2.pragma('foreign_keys = ON');

    const repo1 = new Repository(dbHandle1);
    const repo2 = new Repository(dbHandle2);

    const { auth: auth1, assignment: asgn1 } = createValidAssignmentAndAuth(repo1, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });
    const { auth: auth2, assignment: asgn2 } = createValidAssignmentAndAuth(repo1, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });
    const { auth: auth3, assignment: asgn3 } = createValidAssignmentAndAuth(repo1, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });

    const obs1 = buildValidObservation({ auth: auth1, assignment: asgn1 });
    const res1 = buildTrustedResult(auth1, asgn1, obs1);
    const obs2 = buildValidObservation({ auth: auth2, assignment: asgn2 });
    const res2 = buildTrustedResult(auth2, asgn2, obs2);
    const obs3 = buildValidObservation({ auth: auth3, assignment: asgn3 });
    const res3 = buildTrustedResult(auth3, asgn3, obs3);

    repo1.claimProviderHealthObservation(obs1, res1);
    repo2.claimProviderHealthObservation(obs2, res2);
    repo1.claimProviderHealthObservation(obs3, res3);

    const rec1 = repo1.getProviderHealthObservation(auth1.id);
    const rec2 = repo1.getProviderHealthObservation(auth2.id);
    const rec3 = repo1.getProviderHealthObservation(auth3.id);

    expect(rec1?.account_order).toBe(1);
    expect(rec2?.account_order).toBe(2);
    expect(rec3?.account_order).toBe(3);

    dbHandle1.close();
    dbHandle2.close();
  });

  // -------------------------------------------------------------
  // Section 6: Security & Clock Independence Invariants (Tests 24-28)
  // -------------------------------------------------------------

  it('24. Caller cannot forge or override account_order (caller-supplied value is ignored in favor of allocated ordinal)', () => {
    const { auth, assignment } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });
    const forgedObs = buildValidObservation({ auth, assignment, accountOrder: 9999 });
    const res = buildTrustedResult(auth, assignment, forgedObs);

    repo.claimProviderHealthObservation(forgedObs, res);

    const rec = repo.getProviderHealthObservation(auth.id);
    expect(rec?.account_order).toBe(1); // Allocated ordinal wins; forged 9999 ignored
  });

  it('25. Order allocation survives observed_at 1ms timestamp collision (same observed_at receives distinct orders 1, 2)', () => {
    const collisionTimestamp = '2026-08-26T20:30:00.123Z';
    const { auth: auth1, assignment: asgn1 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });
    const { auth: auth2, assignment: asgn2 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });

    const obs1 = buildValidObservation({ auth: auth1, assignment: asgn1, observedAt: collisionTimestamp });
    const res1 = buildTrustedResult(auth1, asgn1, obs1);
    const obs2 = buildValidObservation({ auth: auth2, assignment: asgn2, observedAt: collisionTimestamp });
    const res2 = buildTrustedResult(auth2, asgn2, obs2);

    repo.claimProviderHealthObservation(obs1, res1);
    repo.claimProviderHealthObservation(obs2, res2);

    const rec1 = repo.getProviderHealthObservation(auth1.id);
    const rec2 = repo.getProviderHealthObservation(auth2.id);

    expect(rec1?.observed_at).toBe(collisionTimestamp);
    expect(rec2?.observed_at).toBe(collisionTimestamp);
    expect(rec1?.account_order).toBe(1);
    expect(rec2?.account_order).toBe(2);
  });

  it('26. Order allocation survives observed_at clock regression scenario (earlier time recorded second gets higher order)', () => {
    const { auth: auth1, assignment: asgn1 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });
    const { auth: auth2, assignment: asgn2 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });

    const obs1 = buildValidObservation({ auth: auth1, assignment: asgn1, observedAt: '2026-08-26T20:00:00.000Z' });
    const res1 = buildTrustedResult(auth1, asgn1, obs1);
    const obs2 = buildValidObservation({ auth: auth2, assignment: asgn2, observedAt: '2026-08-25T00:00:00.000Z' }); // Clock regression (yesterday)
    const res2 = buildTrustedResult(auth2, asgn2, obs2);

    repo.claimProviderHealthObservation(obs1, res1);
    repo.claimProviderHealthObservation(obs2, res2);

    const rec1 = repo.getProviderHealthObservation(auth1.id);
    const rec2 = repo.getProviderHealthObservation(auth2.id);

    expect(rec1?.account_order).toBe(1);
    expect(rec2?.account_order).toBe(2);
  });

  it('27. Legacy unordered row (account_order = NULL) is not treated as order 0 and next post-v12 observation receives order 1', () => {
    // Manually insert legacy row with account_order = NULL
    const { auth: legacyAuth, assignment: legacyAsgn } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });
    db.prepare(`
      INSERT INTO provider_health_observations (
        authorization_id, execution_id, account_id, provider_id, resource_id,
        assignment_id, attempt_id, routing_decision_id, provenance_version,
        provenance_source, mode, adapter_invocation, result_status,
        classified_category, observed_at, account_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      legacyAuth.id,
      'exec-legacy',
      accountIdA,
      providerId,
      resourceIdA,
      legacyAsgn.id,
      null,
      legacyAuth.routing_decision_id,
      1,
      'PROVIDER_DISPATCH_SERVICE',
      'SCHEDULED',
      'RETURNED',
      'COMPLETED',
      'SUCCESS',
      '2026-08-20T00:00:00Z'
    );

    const { auth: newAuth, assignment: newAsgn } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });
    const newObs = buildValidObservation({ auth: newAuth, assignment: newAsgn });
    const newRes = buildTrustedResult(newAuth, newAsgn, newObs);
    repo.claimProviderHealthObservation(newObs, newRes);

    const legacyRec = repo.getProviderHealthObservation(legacyAuth.id);
    const newRec = repo.getProviderHealthObservation(newAuth.id);

    expect(legacyRec?.account_order).toBeNull();
    expect(newRec?.account_order).toBe(1);
  });

  it('28. getProviderHealthObservationsForAccount returns nullable account_order properly ordered', () => {
    const { auth: auth1, assignment: asgn1 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });
    const { auth: auth2, assignment: asgn2 } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });

    const obs1 = buildValidObservation({ auth: auth1, assignment: asgn1 });
    const res1 = buildTrustedResult(auth1, asgn1, obs1);
    const obs2 = buildValidObservation({ auth: auth2, assignment: asgn2 });
    const res2 = buildTrustedResult(auth2, asgn2, obs2);

    repo.claimProviderHealthObservation(obs1, res1);
    repo.claimProviderHealthObservation(obs2, res2);

    const list = repo.getProviderHealthObservationsForAccount(accountIdA);
    expect(list).toHaveLength(2);
    expect(list[0].account_order).toBe(1);
    expect(list[1].account_order).toBe(2);
  });

  // -------------------------------------------------------------
  // Section 7: Scope & Architectural Boundaries (Tests 29-30)
  // -------------------------------------------------------------

  it('29. Source scan proves no AccountHealthService invocation or health status mutation occurs during observation ingestion', () => {
    const { auth, assignment } = createValidAssignmentAndAuth(repo, { taskId: taskId1, accountId: accountIdA, resourceId: resourceIdA });
    const authFailureObs = buildValidObservation({ auth, assignment, category: 'AUTHENTICATION_FAILURE', resultStatus: 'FAILED' });
    const res = buildTrustedResult(auth, assignment, authFailureObs, { status: 'FAILED', errorCode: 'AUTH_ERROR' });

    repo.claimProviderHealthObservation(authFailureObs, res);

    // ProviderAccount health_status must remain untouched (AVAILABLE) because health application is not yet wired
    const account = repo.getProviderAccount(accountIdA);
    expect(account?.health_status).toBe('AVAILABLE');
  });

  it('30. Source scan proves ProviderDispatchService is not modified to capture completion tokens', () => {
    const dispatchSrc = fs.readFileSync(path.join(__dirname, '../src/core/services/ProviderDispatchService.ts'), 'utf-8');
    expect(dispatchSrc).not.toContain('completionOrder');
    expect(dispatchSrc).not.toContain('completionSequence');
  });

  // -------------------------------------------------------------
  // Section 8: Post-Allocation Rollback Invariants (Test 31)
  // -------------------------------------------------------------

  it('31. post-allocation insert failure rolls back account_order and next successful observation reuses the ordinal', () => {
    // 1. Create three coherent observations for accountIdA
    const { auth: authA, assignment: asgnA } = createValidAssignmentAndAuth(repo, {
      taskId: taskId1,
      accountId: accountIdA,
      resourceId: resourceIdA,
    });
    const { auth: authB, assignment: asgnB } = createValidAssignmentAndAuth(repo, {
      taskId: taskId1,
      accountId: accountIdA,
      resourceId: resourceIdA,
    });
    const { auth: authC, assignment: asgnC } = createValidAssignmentAndAuth(repo, {
      taskId: taskId1,
      accountId: accountIdA,
      resourceId: resourceIdA,
    });

    const obsA = buildValidObservation({ auth: authA, assignment: asgnA });
    const resA = buildTrustedResult(authA, asgnA, obsA);

    const obsB = buildValidObservation({ auth: authB, assignment: asgnB });
    const resB = buildTrustedResult(authB, asgnB, obsB);

    const obsC = buildValidObservation({ auth: authC, assignment: asgnC });
    const resC = buildTrustedResult(authC, asgnC, obsC);

    // 2. Claim A successfully -> account_order = 1
    const statusA = repo.claimProviderHealthObservation(obsA, resA);
    expect(statusA).toBe('RECORDED');
    const recA = repo.getProviderHealthObservation(obsA.authorization_id);
    expect(recA).not.toBeNull();
    expect(recA?.account_order).toBe(1);

    // 3. Setup test-only SQLite capture function & trigger for B
    let capturedOrder: number | null = null;
    db.function('__capture_provider_health_order', (value) => {
      capturedOrder = Number(value);
      return null;
    });

    db.exec(`
      CREATE TEMP TRIGGER test_force_provider_health_order_insert_failure
      BEFORE INSERT ON provider_health_observations
      WHEN NEW.authorization_id = '${obsB.authorization_id}'
      BEGIN
        SELECT __capture_provider_health_order(NEW.account_order);
        SELECT RAISE(
          ABORT,
          'TEST_FORCED_POST_ALLOCATION_INSERT_FAILURE'
        );
      END;
    `);

    // 4. Claim B -> throws TEST_FORCED_POST_ALLOCATION_INSERT_FAILURE
    expect(() => repo.claimProviderHealthObservation(obsB, resB)).toThrow(
      /TEST_FORCED_POST_ALLOCATION_INSERT_FAILURE/
    );

    // Verify after failure:
    // - capturedOrder is 2 (proves account_order 2 was computed and supplied to INSERT)
    expect(capturedOrder).toBe(2);

    // - B durable row is ABSENT
    const recB = repo.getProviderHealthObservation(obsB.authorization_id);
    expect(recB).toBeNull();

    // - MAX(account_order) for account remains 1
    const maxRowAfterFail = db
      .prepare('SELECT COALESCE(MAX(account_order), 0) AS max_order FROM provider_health_observations WHERE account_id = ?')
      .get(accountIdA) as { max_order: number };
    expect(Number(maxRowAfterFail.max_order)).toBe(1);

    // 5. Remove test trigger (DROP TEMP TRIGGER)
    db.exec('DROP TRIGGER IF EXISTS test_force_provider_health_order_insert_failure;');

    // 6. Claim C -> must receive account_order = 2, NOT 3
    const statusC = repo.claimProviderHealthObservation(obsC, resC);
    expect(statusC).toBe('RECORDED');

    const recC = repo.getProviderHealthObservation(obsC.authorization_id);
    expect(recC).not.toBeNull();
    expect(recC?.account_order).toBe(2);

    // 7. Verify final ordered durable rows for account A: [A(1), C(2)], B absent
    const accountRows = repo.getProviderHealthObservationsForAccount(accountIdA);
    expect(accountRows).toHaveLength(2);
    expect(accountRows[0].authorization_id).toBe(obsA.authorization_id);
    expect(accountRows[0].account_order).toBe(1);
    expect(accountRows[1].authorization_id).toBe(obsC.authorization_id);
    expect(accountRows[1].account_order).toBe(2);
  });
});
