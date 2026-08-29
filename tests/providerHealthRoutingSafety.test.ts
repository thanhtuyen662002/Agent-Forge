import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { performance } from 'perf_hooks';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import {
  ProviderHealthObservation,
  ProviderAccount,
  ProviderResource,
  RoleProfile,
  AgentProfile,
  AgentAssignment,
  ExecutionAuthorization,
  RoutePolicy,
  ProviderAdapterType,
} from '../src/core/types/domain';
import {
  ProviderDispatchService,
  ProviderDispatchExecutionResult,
  ProviderExecutionProvenanceV1,
} from '../src/core/services/ProviderDispatchService';
import {
  computeCanonicalPayload,
  computePayloadHash,
  computeContextManifestHash,
} from '../src/core/services/ExecutionAuthorizationService';
import { EventService } from '../src/core/services/EventService';
import { ProviderRegistry } from '../src/core/adapters/ProviderRegistry';
import { ProviderAdapter, AgentExecutionRequest, AgentExecutionResult } from '../src/core/adapters/ProviderAdapter';
import { RoleAwareRoutingService, RoleAwareRoutingRequest } from '../src/core/services/RoleAwareRoutingService';
import { ProviderRoutingService, RoutingRequest } from '../src/core/services/ProviderRoutingService';

class MockTestAdapter implements ProviderAdapter {
  public id = 'prov-test-safety';
  public name = 'Test Safety Provider';
  public adapterType: ProviderAdapterType = 'LOCAL_CLI';
  public executionCount = 0;
  public lastRequest?: AgentExecutionRequest;
  public shouldThrow = false;
  public liveHealth: any = 'AVAILABLE';

  public async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    this.executionCount++;
    this.lastRequest = request;
    if (this.shouldThrow) {
      throw new Error('Adapter execution failure');
    }
    return {
      executionId: crypto.randomUUID(),
      status: 'COMPLETED',
      rawResponse: JSON.stringify({ test: true }),
    };
  }

  public async cancel(_executionId: string): Promise<void> {}

  public async getHealth(): Promise<any> {
    return this.liveHealth;
  }

  public async getQuota(): Promise<any> {
    return {
      remaining: 1000,
      total: 1000,
      unit: 'REQUESTS',
      source: 'MEASURED',
      confidence: 1.0,
      resetAt: null,
    };
  }

  public async getCapabilities(): Promise<any> {
    return ['CODING'];
  }
}

describe('R5H4 Provider Health Routing Safety & Liveness Guard Contract Tests', () => {
  const isR5i5DiagEnabled = (): boolean => process.platform === 'win32' && process.env.R5I5_DIAG === '1';
  let safetySuiteHookCount = 0;
  let safetySuiteHookTotalMs = 0;
  let safetySuiteHookMinMs = Infinity;
  let safetySuiteHookMaxMs = 0;
  let safetySuiteMigrationTotalMs = 0;
  let safetySuiteGitTotalMs = 0;

  let tempDir: string;
  let dbPath: string;
  let repoDir: string;
  let baseSha: string;
  let db: Database.Database;
  let repo: Repository;
  let eventService: EventService;
  let registry: ProviderRegistry;
  let mockAdapter: MockTestAdapter;

  const projectId = 'PROJ-TEST-SAFETY';
  const taskId = 'TSK-TEST-SAFETY-1';
  const providerId = 'prov-test-safety';
  const accountIdA = 'acct-test-safety-a';
  const accountIdB = 'acct-test-safety-b';
  const resourceIdA = 'res-test-safety-a';
  const resourceIdB = 'res-test-safety-b';
  const roleProfileId = 'role-test-safety';
  const agentProfileId = 'agent-prof-test-safety';

  beforeEach(() => {
    const diagEnabled = isR5i5DiagEnabled();
    const hookStart = diagEnabled ? performance.now() : 0;
    let gitMs = 0;
    let migMs = 0;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-safety-test-'));
    dbPath = path.join(tempDir, 'safety-test.db');
    repoDir = path.join(tempDir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });

    const gitStart = diagEnabled ? performance.now() : 0;
    require('child_process').execSync('git init', { cwd: repoDir, stdio: 'pipe' });
    require('child_process').execSync('git config user.name "Tester"', { cwd: repoDir, stdio: 'pipe' });
    require('child_process').execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test\n');
    require('child_process').execSync('git add README.md', { cwd: repoDir, stdio: 'pipe' });
    require('child_process').execSync('git commit -m "init"', { cwd: repoDir, stdio: 'pipe' });
    baseSha = require('child_process').execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf-8' }).trim();
    if (diagEnabled) gitMs = performance.now() - gitStart;

    db = new Database(dbPath);
    const migStart = diagEnabled ? performance.now() : 0;
    MigrationRunner.run(db);
    if (diagEnabled) migMs = performance.now() - migStart;

    repo = new Repository(db);
    eventService = new EventService(repo);

    mockAdapter = new MockTestAdapter();
    registry = new ProviderRegistry();
    registry.register(mockAdapter);

    createBaselineEntities();

    if (diagEnabled) {
      const hookElapsed = performance.now() - hookStart;
      safetySuiteHookCount++;
      safetySuiteHookTotalMs += hookElapsed;
      safetySuiteHookMinMs = Math.min(safetySuiteHookMinMs, hookElapsed);
      safetySuiteHookMaxMs = Math.max(safetySuiteHookMaxMs, hookElapsed);
      safetySuiteMigrationTotalMs += migMs;
      safetySuiteGitTotalMs += gitMs;

      if (safetySuiteHookCount <= 2 || hookElapsed >= 5000) {
        const record = {
          marker: 'R5I5_DIAG',
          schema_version: '1.0',
          run_context: 'github_actions',
          scope: 'providerHealthRoutingSafety',
          phase: 'beforeEach',
          event: 'HOOK_SUMMARY',
          wall_clock_utc: new Date().toISOString(),
          hook_index: safetySuiteHookCount,
          elapsed_ms: hookElapsed,
          git_setup_ms: gitMs,
          migration_ms: migMs,
          system_free_memory_bytes: os.freemem(),
          rss_bytes: process.memoryUsage().rss,
        };
        console.log('R5I5_DIAG ' + JSON.stringify(record));
      }
    }
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  afterAll(() => {
    if (isR5i5DiagEnabled() && safetySuiteHookCount > 0) {
      const record = {
        marker: 'R5I5_DIAG',
        schema_version: '1.0',
        run_context: 'github_actions',
        scope: 'providerHealthRoutingSafety',
        phase: 'suite_summary',
        event: 'SUITE_HOOK_AGGREGATE',
        wall_clock_utc: new Date().toISOString(),
        hook_count: safetySuiteHookCount,
        hook_total_elapsed_ms: safetySuiteHookTotalMs,
        hook_min_elapsed_ms: safetySuiteHookMinMs,
        hook_max_elapsed_ms: safetySuiteHookMaxMs,
        migration_total_elapsed_ms: safetySuiteMigrationTotalMs,
        git_setup_total_elapsed_ms: safetySuiteGitTotalMs,
        system_free_memory_bytes: os.freemem(),
        rss_bytes: process.memoryUsage().rss,
      };
      console.log('R5I5_DIAG ' + JSON.stringify(record));
    }
  });

  function createBaselineEntities() {
    const now = new Date().toISOString();
    repo.createProject({
      id: projectId,
      name: 'Safety Project',
      description: null,
      contract: null,
      repository_path: repoDir,
      default_branch: 'main',
      status: 'READY',
      started_at: now,
      completed_at: null,
      created_at: now,
      updated_at: now,
    });

    repo.createTask({
      id: taskId,
      project_id: projectId,
      milestone_id: null,
      title: 'Safety Task',
      description: 'Test task for routing safety',
      state: 'CODING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: baseSha,
      current_sha: baseSha,
      progress_cache_percent: 0,
      progress_computed_at: null,
      constraints: [],
      acceptance_criteria: [],
      created_at: now,
      updated_at: now,
    });

    repo.createProvider({
      id: providerId,
      name: 'Test Safety Provider',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: now,
    });

    repo.createProviderAccount({
      id: accountIdA,
      provider_id: providerId,
      label: 'Account A',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: 'wincred://AgentForge/test-a',
      profile_ref: null,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      priority: 1,
      concurrency_limit: 10,
      enabled: true,
      created_at: now,
      updated_at: now,
    });

    repo.createProviderAccount({
      id: accountIdB,
      provider_id: providerId,
      label: 'Account B',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: 'wincred://AgentForge/test-b',
      profile_ref: null,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      priority: 1,
      concurrency_limit: 10,
      enabled: true,
      created_at: now,
      updated_at: now,
    });

    repo.createProviderResource({
      id: resourceIdA,
      provider_id: providerId,
      provider_account_id: accountIdA,
      model_name: 'test-model-a',
      health_status: 'AVAILABLE',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: 1000,
      remaining_quota: 1000,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MEASURED',
      quota_confidence: 1.0,
      last_health_check: now,
    });

    repo.createProviderResource({
      id: resourceIdB,
      provider_id: providerId,
      provider_account_id: accountIdB,
      model_name: 'test-model-b',
      health_status: 'AVAILABLE',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: 1000,
      remaining_quota: 1000,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MEASURED',
      quota_confidence: 1.0,
      last_health_check: now,
    });

    repo.createRoleProfile({
      id: roleProfileId,
      role: 'CODER',
      display_name: 'Coder Role',
      required_capabilities: ['CODING'],
      preferred_capabilities: [],
      authority_scope: null,
      permissions: [],
      output_protocol: null,
      enabled: true,
      created_at: now,
      updated_at: now,
    });

    repo.createAgentProfile({
      id: agentProfileId,
      role_profile_id: roleProfileId,
      name: 'Agent Profile',
      prompt_template: null,
      config: null,
      enabled: true,
      created_at: now,
      updated_at: now,
    });

    const managerPayload = JSON.stringify({
      protocol: 'manager.v1',
      message_id: 'msg-1',
      project_id: projectId,
      task_id: taskId,
      decision: 'EXECUTE',
      instructions: ['Execute safely'],
      constraints: [],
      suggested_approaches: [],
    });
    const managerPayloadHash = crypto.createHash('sha256').update(managerPayload).digest('hex');

    repo.recordProtocolMessage(
      'msg-1',
      'msg-1',
      'manager.v1',
      projectId,
      taskId,
      'CODING',
      0,
      managerPayloadHash,
      managerPayload,
      'APPLIED',
      undefined,
      now
    );
  }

  interface Test24DiagAccumulator {
    authLookupCount: number;
    authLookupTotalMs: number;
    authCreateCount: number;
    authCreateTotalMs: number;
    assignmentLookupCount: number;
    assignmentLookupTotalMs: number;
    assignmentCreateCount: number;
    assignmentCreateTotalMs: number;
    observationInsertCount: number;
    observationInsertTotalMs: number;
    iterationDurationsMs: number[];
  }
  let currentTest24Diag: Test24DiagAccumulator | null = null;

  function insertObservationDirectly(obs: {
    authorization_id: string;
    execution_id?: string;
    account_id: string;
    provider_id?: string;
    resource_id?: string;
    assignment_id?: string;
    attempt_id?: string | null;
    routing_decision_id?: string;
    provenance_version?: number;
    provenance_source?: string;
    mode?: string;
    adapter_invocation?: string;
    result_status?: string;
    classified_category?: string;
    observed_at?: string;
    account_order?: number | null;
    health_action_plan_version?: number | null;
    health_action?: string | null;
    health_action_cooldown_duration_ms?: number | null;
    health_action_cooldown_anchor_at?: string | null;
  }) {
    const now = new Date().toISOString();
    const effectiveResourceId = obs.resource_id ?? (obs.account_id === accountIdB ? resourceIdB : resourceIdA);
    const diag = currentTest24Diag;
    const iterStart = diag ? performance.now() : 0;

    // Ensure execution_authorizations row exists
    const alStart = diag ? performance.now() : 0;
    const existingAuth = repo.getExecutionAuthorization(obs.authorization_id);
    if (diag) {
      diag.authLookupTotalMs += performance.now() - alStart;
      diag.authLookupCount++;
    }

    if (!existingAuth) {
      const acStart = diag ? performance.now() : 0;
      repo.createExecutionAuthorization({
        id: obs.authorization_id,
        project_id: projectId,
        task_id: taskId,
        attempt_id: obs.attempt_id ?? null,
        task_revision: 0,
        base_sha: baseSha,
        repository_head_sha: baseSha,
        manager_message_id: 'msg-1',
        manager_payload_hash: 'mhash1',
        routing_decision_id: obs.routing_decision_id ?? 'dec-1',
        selected_provider_id: obs.provider_id ?? providerId,
        selected_resource_id: effectiveResourceId,
        canonical_instructions_json: JSON.stringify(['test']),
        context_files_json: JSON.stringify([]),
        canonical_payload_json: JSON.stringify({}),
        instruction_payload_hash: 'hash1',
        context_manifest_hash: 'hash2',
        status: 'DISPATCHED',
        created_at: now,
        dispatched_at: now,
      });
      if (diag) {
        diag.authCreateTotalMs += performance.now() - acStart;
        diag.authCreateCount++;
      }
    }

    // Ensure agent_assignments row exists
    const assignmentId = obs.assignment_id ?? `asgn-${obs.authorization_id}`;
    const aslStart = diag ? performance.now() : 0;
    const existingAsgn = repo.getAgentAssignment(assignmentId);
    if (diag) {
      diag.assignmentLookupTotalMs += performance.now() - aslStart;
      diag.assignmentLookupCount++;
    }

    if (!existingAsgn) {
      const ascStart = diag ? performance.now() : 0;
      repo.createAgentAssignment({
        id: assignmentId,
        project_id: projectId,
        task_id: taskId,
        attempt_id: obs.attempt_id ?? null,
        role_profile_id: roleProfileId,
        agent_profile_id: agentProfileId,
        selected_provider_id: obs.provider_id ?? providerId,
        selected_account_id: obs.account_id,
        selected_resource_id: effectiveResourceId,
        selected_worker_slot_id: null,
        routing_decision_id: obs.routing_decision_id ?? 'dec-1',
        preferred_metadata: null,
        status: 'ASSIGNED',
        created_at: now,
        ended_at: null,
      });
      if (diag) {
        diag.assignmentCreateTotalMs += performance.now() - ascStart;
        diag.assignmentCreateCount++;
      }
    }

    const oiStart = diag ? performance.now() : 0;
    db.prepare(`
      INSERT INTO provider_health_observations (
        authorization_id, execution_id, account_id, provider_id, resource_id,
        assignment_id, attempt_id, routing_decision_id, provenance_version,
        provenance_source, mode, adapter_invocation, result_status,
        classified_category, observed_at, account_order,
        health_action_plan_version, health_action,
        health_action_cooldown_duration_ms, health_action_cooldown_anchor_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?
      )
    `).run(
      obs.authorization_id,
      obs.execution_id ?? crypto.randomUUID(),
      obs.account_id,
      obs.provider_id ?? providerId,
      effectiveResourceId,
      assignmentId,
      obs.attempt_id ?? null,
      obs.routing_decision_id ?? 'dec-1',
      obs.provenance_version ?? 1,
      obs.provenance_source ?? 'PROVIDER_DISPATCH_SERVICE',
      obs.mode ?? 'LEGACY',
      obs.adapter_invocation ?? 'RETURNED',
      obs.result_status ?? 'COMPLETED',
      obs.classified_category ?? 'SUCCESS',
      obs.observed_at ?? now,
      obs.account_order ?? null,
      obs.health_action_plan_version !== undefined ? obs.health_action_plan_version : 1,
      obs.health_action !== undefined ? obs.health_action : 'RECORD_SUCCESS',
      obs.health_action_cooldown_duration_ms ?? null,
      obs.health_action_cooldown_anchor_at ?? null
    );
    if (diag) {
      diag.observationInsertTotalMs += performance.now() - oiStart;
      diag.observationInsertCount++;
      diag.iterationDurationsMs.push(performance.now() - iterStart);
    }
  }

  function setAccountWatermark(
    accountId: string,
    order: number | null,
    authId: string | null
  ) {
    db.prepare(`
      UPDATE provider_accounts
      SET last_applied_action_account_order = ?,
          last_applied_action_authorization_id = ?
      WHERE id = ?
    `).run(order, authId, accountId);
  }

  // ============================================================
  // SECTION 43: REPOSITORY ROUTING SAFETY TESTS
  // ============================================================

  it('1. returns SAFE when account has no observations and null watermark', () => {
    const safety = repo.evaluateProviderHealthRoutingSafety(accountIdA);
    expect(safety.status).toBe('SAFE');
    expect(safety.effectiveHeadAccountOrder).toBeNull();
    expect(safety.watermarkAccountOrder).toBeNull();
  });

  it('2. returns SAFE when account has only legacy observations (account_order = null) and null watermark', () => {
    insertObservationDirectly({
      authorization_id: 'auth-legacy-1',
      account_id: accountIdA,
      account_order: null,
      health_action: null,
    });
    const safety = repo.evaluateProviderHealthRoutingSafety(accountIdA);
    expect(safety.status).toBe('SAFE');
    expect(safety.effectiveHeadAccountOrder).toBeNull();
  });

  it('3. returns SAFE when account has only NO_MUTATION ordered observations and null watermark', () => {
    insertObservationDirectly({
      authorization_id: 'auth-nomut-1',
      account_id: accountIdA,
      account_order: 1,
      health_action_plan_version: 1,
      health_action: 'NO_MUTATION',
    });
    const safety = repo.evaluateProviderHealthRoutingSafety(accountIdA);
    expect(safety.status).toBe('SAFE');
    expect(safety.effectiveHeadAccountOrder).toBeNull();
  });

  it('4. returns SAFE when applied RECORD_SUCCESS matches watermark', () => {
    insertObservationDirectly({
      authorization_id: 'auth-succ-1',
      account_id: accountIdA,
      account_order: 10,
      health_action_plan_version: 1,
      health_action: 'RECORD_SUCCESS',
    });
    setAccountWatermark(accountIdA, 10, 'auth-succ-1');

    const safety = repo.evaluateProviderHealthRoutingSafety(accountIdA);
    expect(safety.status).toBe('SAFE');
    expect(safety.effectiveHeadAccountOrder).toBe(10);
    expect(safety.effectiveHeadAuthorizationId).toBe('auth-succ-1');
  });

  it('5. returns SAFE from safety authority when applied RECORD_AUTH_ERROR matches watermark', () => {
    insertObservationDirectly({
      authorization_id: 'auth-err-1',
      account_id: accountIdA,
      account_order: 10,
      health_action_plan_version: 1,
      health_action: 'RECORD_AUTH_ERROR',
    });
    setAccountWatermark(accountIdA, 10, 'auth-err-1');

    const safety = repo.evaluateProviderHealthRoutingSafety(accountIdA);
    expect(safety.status).toBe('SAFE');
    expect(safety.effectiveHeadAccountOrder).toBe(10);
  });

  it('6. returns PENDING_APPLICATION when newest RECORD_SUCCESS is not yet applied (watermark null)', () => {
    insertObservationDirectly({
      authorization_id: 'auth-succ-2',
      account_id: accountIdA,
      account_order: 1,
      health_action_plan_version: 1,
      health_action: 'RECORD_SUCCESS',
    });

    const safety = repo.evaluateProviderHealthRoutingSafety(accountIdA);
    expect(safety.status).toBe('PENDING_APPLICATION');
    expect(safety.effectiveHeadAccountOrder).toBe(1);
    expect(safety.effectiveHeadAuthorizationId).toBe('auth-succ-2');
  });

  it('7. returns PENDING_APPLICATION when newest RECORD_AUTH_ERROR is not yet applied', () => {
    insertObservationDirectly({
      authorization_id: 'auth-err-2',
      account_id: accountIdA,
      account_order: 5,
      health_action_plan_version: 1,
      health_action: 'RECORD_AUTH_ERROR',
    });

    const safety = repo.evaluateProviderHealthRoutingSafety(accountIdA);
    expect(safety.status).toBe('PENDING_APPLICATION');
    expect(safety.effectiveHeadAccountOrder).toBe(5);
  });

  it('8. returns PENDING_APPLICATION when newest RECORD_QUOTA_EXHAUSTED is not yet applied', () => {
    insertObservationDirectly({
      authorization_id: 'auth-quota-1',
      account_id: accountIdA,
      account_order: 7,
      health_action_plan_version: 1,
      health_action: 'RECORD_QUOTA_EXHAUSTED',
    });

    const safety = repo.evaluateProviderHealthRoutingSafety(accountIdA);
    expect(safety.status).toBe('PENDING_APPLICATION');
  });

  it('9. returns PENDING_APPLICATION when newest valid RECORD_RATE_LIMITED is not yet applied', () => {
    insertObservationDirectly({
      authorization_id: 'auth-rate-1',
      account_id: accountIdA,
      account_order: 8,
      health_action_plan_version: 1,
      health_action: 'RECORD_RATE_LIMITED',
      health_action_cooldown_duration_ms: 60000,
      health_action_cooldown_anchor_at: new Date().toISOString(),
    });

    const safety = repo.evaluateProviderHealthRoutingSafety(accountIdA);
    expect(safety.status).toBe('PENDING_APPLICATION');
  });

  it('10. returns ACTION_AUTHORITY_UNKNOWN when effective head lacks valid action plan', () => {
    insertObservationDirectly({
      authorization_id: 'auth-unknown-1',
      account_id: accountIdA,
      account_order: 12,
      health_action_plan_version: null,
      health_action: null,
    });

    const safety = repo.evaluateProviderHealthRoutingSafety(accountIdA);
    expect(safety.status).toBe('ACTION_AUTHORITY_UNKNOWN');
    expect(safety.effectiveHeadAccountOrder).toBe(12);
  });

  it('11. returns TEMPORAL_AUTHORITY_UNKNOWN when effective head RECORD_RATE_LIMITED has missing anchor', () => {
    insertObservationDirectly({
      authorization_id: 'auth-rate-no-anchor',
      account_id: accountIdA,
      account_order: 15,
      health_action_plan_version: 1,
      health_action: 'RECORD_RATE_LIMITED',
      health_action_cooldown_duration_ms: 60000,
      health_action_cooldown_anchor_at: null,
    });

    const safety = repo.evaluateProviderHealthRoutingSafety(accountIdA);
    expect(safety.status).toBe('TEMPORAL_AUTHORITY_UNKNOWN');
    expect(safety.effectiveHeadAccountOrder).toBe(15);
  });

  it('12. returns SAFE when applied effective head is followed by newer NO_MUTATION rows', () => {
    insertObservationDirectly({
      authorization_id: 'auth-succ-10',
      account_id: accountIdA,
      account_order: 10,
      health_action_plan_version: 1,
      health_action: 'RECORD_SUCCESS',
    });
    insertObservationDirectly({
      authorization_id: 'auth-nomut-11',
      account_id: accountIdA,
      account_order: 11,
      health_action_plan_version: 1,
      health_action: 'NO_MUTATION',
    });
    setAccountWatermark(accountIdA, 10, 'auth-succ-10');

    const safety = repo.evaluateProviderHealthRoutingSafety(accountIdA);
    expect(safety.status).toBe('SAFE');
    expect(safety.effectiveHeadAccountOrder).toBe(10);
    expect(safety.effectiveHeadAuthorizationId).toBe('auth-succ-10');
  });

  it('13. returns ACTION_AUTHORITY_UNKNOWN when applied head is followed by newer unknown action', () => {
    insertObservationDirectly({
      authorization_id: 'auth-succ-10',
      account_id: accountIdA,
      account_order: 10,
      health_action_plan_version: 1,
      health_action: 'RECORD_SUCCESS',
    });
    insertObservationDirectly({
      authorization_id: 'auth-unknown-11',
      account_id: accountIdA,
      account_order: 11,
      health_action_plan_version: null,
      health_action: null,
    });
    setAccountWatermark(accountIdA, 10, 'auth-succ-10');

    const safety = repo.evaluateProviderHealthRoutingSafety(accountIdA);
    expect(safety.status).toBe('ACTION_AUTHORITY_UNKNOWN');
    expect(safety.effectiveHeadAccountOrder).toBe(11);
  });

  it('14. returns SAFE when older unknown row is followed by newer applied known row', () => {
    insertObservationDirectly({
      authorization_id: 'auth-unknown-5',
      account_id: accountIdA,
      account_order: 5,
      health_action_plan_version: null,
      health_action: null,
    });
    insertObservationDirectly({
      authorization_id: 'auth-succ-10',
      account_id: accountIdA,
      account_order: 10,
      health_action_plan_version: 1,
      health_action: 'RECORD_SUCCESS',
    });
    setAccountWatermark(accountIdA, 10, 'auth-succ-10');

    const safety = repo.evaluateProviderHealthRoutingSafety(accountIdA);
    expect(safety.status).toBe('SAFE');
    expect(safety.effectiveHeadAccountOrder).toBe(10);
  });

  it('15. returns WATERMARK_INTEGRITY_MISMATCH on partial watermark pair (order without auth)', () => {
    setAccountWatermark(accountIdA, 10, null);
    const safety = repo.evaluateProviderHealthRoutingSafety(accountIdA);
    expect(safety.status).toBe('WATERMARK_INTEGRITY_MISMATCH');
  });

  it('16. returns WATERMARK_INTEGRITY_MISMATCH on empty string watermark auth', () => {
    setAccountWatermark(accountIdA, 10, '');
    const safety = repo.evaluateProviderHealthRoutingSafety(accountIdA);
    expect(safety.status).toBe('WATERMARK_INTEGRITY_MISMATCH');
  });

  it('17. returns WATERMARK_INTEGRITY_MISMATCH on whitespace-only watermark auth', () => {
    setAccountWatermark(accountIdA, 10, '   ');
    const safety = repo.evaluateProviderHealthRoutingSafety(accountIdA);
    expect(safety.status).toBe('WATERMARK_INTEGRITY_MISMATCH');
  });

  it('18. returns WATERMARK_INTEGRITY_MISMATCH on orphan watermark auth (referenced observation does not exist)', () => {
    setAccountWatermark(accountIdA, 10, 'auth-non-existent');
    const safety = repo.evaluateProviderHealthRoutingSafety(accountIdA);
    expect(safety.status).toBe('WATERMARK_INTEGRITY_MISMATCH');
  });

  it('19. returns WATERMARK_INTEGRITY_MISMATCH when watermark references observation for different account', () => {
    insertObservationDirectly({
      authorization_id: 'auth-acct-b',
      account_id: accountIdB,
      account_order: 10,
      health_action_plan_version: 1,
      health_action: 'RECORD_SUCCESS',
    });
    setAccountWatermark(accountIdA, 10, 'auth-acct-b');

    const safety = repo.evaluateProviderHealthRoutingSafety(accountIdA);
    expect(safety.status).toBe('WATERMARK_INTEGRITY_MISMATCH');
  });

  it('20. returns WATERMARK_INTEGRITY_MISMATCH when watermark points to a NO_MUTATION observation', () => {
    insertObservationDirectly({
      authorization_id: 'auth-nomut-10',
      account_id: accountIdA,
      account_order: 10,
      health_action_plan_version: 1,
      health_action: 'NO_MUTATION',
    });
    setAccountWatermark(accountIdA, 10, 'auth-nomut-10');

    const safety = repo.evaluateProviderHealthRoutingSafety(accountIdA);
    expect(safety.status).toBe('WATERMARK_INTEGRITY_MISMATCH');
  });

  it('21. returns PENDING_APPLICATION when watermark is behind effective head', () => {
    insertObservationDirectly({
      authorization_id: 'auth-succ-10',
      account_id: accountIdA,
      account_order: 10,
      health_action_plan_version: 1,
      health_action: 'RECORD_SUCCESS',
    });
    insertObservationDirectly({
      authorization_id: 'auth-err-11',
      account_id: accountIdA,
      account_order: 11,
      health_action_plan_version: 1,
      health_action: 'RECORD_AUTH_ERROR',
    });
    setAccountWatermark(accountIdA, 10, 'auth-succ-10');

    const safety = repo.evaluateProviderHealthRoutingSafety(accountIdA);
    expect(safety.status).toBe('PENDING_APPLICATION');
    expect(safety.effectiveHeadAccountOrder).toBe(11);
  });

  it('22. returns WATERMARK_INTEGRITY_MISMATCH when watermark order is ahead of effective head', () => {
    insertObservationDirectly({
      authorization_id: 'auth-succ-10',
      account_id: accountIdA,
      account_order: 10,
      health_action_plan_version: 1,
      health_action: 'RECORD_SUCCESS',
    });
    insertObservationDirectly({
      authorization_id: 'auth-succ-15',
      account_id: accountIdA,
      account_order: 15,
      health_action_plan_version: 1,
      health_action: 'RECORD_SUCCESS',
    });
    // Watermark points to 15, but let's say effective head is at 10 (e.g. 15 was deleted or modified)
    // Here 15 is the head so let's set watermark to 20
    insertObservationDirectly({
      authorization_id: 'auth-orphan-20',
      account_id: accountIdA,
      account_order: 20,
      health_action_plan_version: 1,
      health_action: 'RECORD_SUCCESS',
    });
    // Delete row 20 to make watermark ahead of actual head
    db.prepare('DELETE FROM provider_health_observations WHERE authorization_id = ?').run('auth-orphan-20');
    setAccountWatermark(accountIdA, 20, 'auth-orphan-20');

    const safety = repo.evaluateProviderHealthRoutingSafety(accountIdA);
    expect(safety.status).toBe('WATERMARK_INTEGRITY_MISMATCH');
  });

  it('23. returns WATERMARK_INTEGRITY_MISMATCH on same order but different authorization ID', () => {
    insertObservationDirectly({
      authorization_id: 'auth-actual-10',
      account_id: accountIdA,
      account_order: 10,
      health_action_plan_version: 1,
      health_action: 'RECORD_SUCCESS',
    });
    insertObservationDirectly({
      authorization_id: 'auth-other-row',
      account_id: accountIdB,
      account_order: 10,
      health_action_plan_version: 1,
      health_action: 'RECORD_SUCCESS',
    });
    setAccountWatermark(accountIdA, 10, 'auth-other-row');

    const safety = repo.evaluateProviderHealthRoutingSafety(accountIdA);
    expect(safety.status).toBe('WATERMARK_INTEGRITY_MISMATCH');
  });

  it('24. >100 newer NO_MUTATION rows do not hide older effective head (ROUTING_SAFETY_MORE_THAN_100_ROWS_PROVEN)', () => {
    const diagEnabled = isR5i5DiagEnabled();
    let diagAccumulator: Test24DiagAccumulator | null = null;
    let testStart = 0;
    let watermarkMs = 0;
    let routingEvalMs = 0;

    if (diagEnabled) {
      testStart = performance.now();
      diagAccumulator = {
        authLookupCount: 0,
        authLookupTotalMs: 0,
        authCreateCount: 0,
        authCreateTotalMs: 0,
        assignmentLookupCount: 0,
        assignmentLookupTotalMs: 0,
        assignmentCreateCount: 0,
        assignmentCreateTotalMs: 0,
        observationInsertCount: 0,
        observationInsertTotalMs: 0,
        iterationDurationsMs: [],
      };
      currentTest24Diag = diagAccumulator;
    }

    try {
      insertObservationDirectly({
        authorization_id: 'auth-head-1',
        account_id: accountIdA,
        account_order: 1,
        health_action_plan_version: 1,
        health_action: 'RECORD_SUCCESS',
      });

      // Insert 120 transparent NO_MUTATION rows
      for (let i = 2; i <= 121; i++) {
        insertObservationDirectly({
          authorization_id: `auth-nomut-${i}`,
          account_id: accountIdA,
          account_order: i,
          health_action_plan_version: 1,
          health_action: 'NO_MUTATION',
        });
      }

      const wmStart = diagEnabled ? performance.now() : 0;
      setAccountWatermark(accountIdA, 1, 'auth-head-1');
      if (diagEnabled) watermarkMs = performance.now() - wmStart;

      const evalStart = diagEnabled ? performance.now() : 0;
      const safety = repo.evaluateProviderHealthRoutingSafety(accountIdA);
      if (diagEnabled) routingEvalMs = performance.now() - evalStart;

      expect(safety.status).toBe('SAFE');
      expect(safety.effectiveHeadAccountOrder).toBe(1);
      expect(safety.effectiveHeadAuthorizationId).toBe('auth-head-1');
    } finally {
      if (diagEnabled && diagAccumulator) {
        currentTest24Diag = null;
        const totalElapsed = performance.now() - testStart;
        const durations = diagAccumulator.iterationDurationsMs;
        const iterCount = durations.length;
        const iterTotal = durations.reduce((a, b) => a + b, 0);
        const iterMin = iterCount > 0 ? Math.min(...durations) : 0;
        const iterMax = iterCount > 0 ? Math.max(...durations) : 0;
        const iterMean = iterCount > 0 ? iterTotal / iterCount : 0;

        const sorted = [...durations].sort((a, b) => a - b);
        const p50 = iterCount > 0 ? sorted[Math.floor(iterCount * 0.5)] : 0;
        const p95 = iterCount > 0 ? sorted[Math.floor(iterCount * 0.95)] : 0;

        const first10 = durations.slice(0, 10);
        const last10 = durations.slice(-10);
        const first10Mean = first10.length > 0 ? first10.reduce((a, b) => a + b, 0) / first10.length : 0;
        const last10Mean = last10.length > 0 ? last10.reduce((a, b) => a + b, 0) / last10.length : 0;

        const record = {
          marker: 'R5I5_DIAG',
          schema_version: '1.0',
          run_context: 'github_actions',
          scope: 'providerHealthRoutingSafety',
          phase: 'test24',
          event: 'TEST24_SUMMARY',
          wall_clock_utc: new Date().toISOString(),
          elapsed_ms: totalElapsed,
          counts: {
            iteration_count: iterCount,
            auth_lookup_count: diagAccumulator.authLookupCount,
            auth_create_count: diagAccumulator.authCreateCount,
            assignment_lookup_count: diagAccumulator.assignmentLookupCount,
            assignment_create_count: diagAccumulator.assignmentCreateCount,
            observation_insert_count: diagAccumulator.observationInsertCount,
          },
          timing_ms: {
            iteration_total_ms: iterTotal,
            iteration_min_ms: iterMin,
            iteration_max_ms: iterMax,
            iteration_mean_ms: iterMean,
            iteration_p50_ms: p50,
            iteration_p95_ms: p95,
            first_10_mean_ms: first10Mean,
            last_10_mean_ms: last10Mean,
            auth_lookup_total_ms: diagAccumulator.authLookupTotalMs,
            auth_create_total_ms: diagAccumulator.authCreateTotalMs,
            assignment_lookup_total_ms: diagAccumulator.assignmentLookupTotalMs,
            assignment_create_total_ms: diagAccumulator.assignmentCreateTotalMs,
            observation_insert_total_ms: diagAccumulator.observationInsertTotalMs,
            watermark_ms: watermarkMs,
            routing_evaluation_ms: routingEvalMs,
          },
          telemetry: {
            rss_bytes: process.memoryUsage().rss,
            heap_used_bytes: process.memoryUsage().heapUsed,
            system_free_memory_bytes: os.freemem(),
          },
        };
        console.log('R5I5_DIAG ' + JSON.stringify(record));
      }
    }
  });

  // ============================================================
  // SECTION 44: ROLE-AWARE ROUTING TESTS
  // ============================================================

  it('25. RoleAwareRoutingService excludes unsafe account candidate before adapter probe', async () => {
    insertObservationDirectly({
      authorization_id: 'auth-err-pending',
      account_id: accountIdA,
      account_order: 1,
      health_action_plan_version: 1,
      health_action: 'RECORD_AUTH_ERROR',
    });
    // Watermark is null -> PENDING_APPLICATION

    const router = new RoleAwareRoutingService(repo, registry, eventService);
    const request: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId,
      requiredAccountId: accountIdA,
    };

    const decision = await router.routeRole(request);
    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    const evalA = decision.candidateEvaluations.find((c) => c.accountId === accountIdA);
    expect(evalA).toBeDefined();
    expect(evalA?.eligibility).toBe('INELIGIBLE');
    expect(evalA?.rejectionReasons.some((r) => r.includes('PROVIDER_HEALTH_UNRESOLVED_AUTHORITY') && r.includes('PENDING_APPLICATION'))).toBe(true);
  });

  it('26. RoleAwareRoutingService excludes PENDING_APPLICATION account', async () => {
    insertObservationDirectly({
      authorization_id: 'auth-succ-unapplied',
      account_id: accountIdA,
      account_order: 1,
      health_action_plan_version: 1,
      health_action: 'RECORD_SUCCESS',
    });

    const router = new RoleAwareRoutingService(repo, registry, eventService);
    const request: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId,
      requiredAccountId: accountIdA,
    };

    const decision = await router.routeRole(request);
    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
  });

  it('27. RoleAwareRoutingService excludes ACTION_AUTHORITY_UNKNOWN account', async () => {
    insertObservationDirectly({
      authorization_id: 'auth-unknown-act',
      account_id: accountIdA,
      account_order: 1,
      health_action_plan_version: null,
      health_action: null,
    });

    const router = new RoleAwareRoutingService(repo, registry, eventService);
    const request: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId,
      requiredAccountId: accountIdA,
    };

    const decision = await router.routeRole(request);
    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    const evalA = decision.candidateEvaluations.find((c) => c.accountId === accountIdA);
    expect(evalA?.rejectionReasons.some((r) => r.includes('ACTION_AUTHORITY_UNKNOWN'))).toBe(true);
  });

  it('28. RoleAwareRoutingService excludes TEMPORAL_AUTHORITY_UNKNOWN account', async () => {
    insertObservationDirectly({
      authorization_id: 'auth-unknown-temp',
      account_id: accountIdA,
      account_order: 1,
      health_action_plan_version: 1,
      health_action: 'RECORD_RATE_LIMITED',
      health_action_cooldown_duration_ms: null,
      health_action_cooldown_anchor_at: null,
    });

    const router = new RoleAwareRoutingService(repo, registry, eventService);
    const request: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId,
      requiredAccountId: accountIdA,
    };

    const decision = await router.routeRole(request);
    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    const evalA = decision.candidateEvaluations.find((c) => c.accountId === accountIdA);
    expect(evalA?.rejectionReasons.some((r) => r.includes('TEMPORAL_AUTHORITY_UNKNOWN'))).toBe(true);
  });

  it('29. RoleAwareRoutingService selects alternate safe account when one account is unsafe', async () => {
    // Account A is unsafe (PENDING_APPLICATION)
    insertObservationDirectly({
      authorization_id: 'auth-a-pending',
      account_id: accountIdA,
      account_order: 1,
      health_action_plan_version: 1,
      health_action: 'RECORD_AUTH_ERROR',
    });

    // Account B is safe (applied SUCCESS)
    insertObservationDirectly({
      authorization_id: 'auth-b-applied',
      account_id: accountIdB,
      account_order: 1,
      health_action_plan_version: 1,
      health_action: 'RECORD_SUCCESS',
    });
    setAccountWatermark(accountIdB, 1, 'auth-b-applied');

    const router = new RoleAwareRoutingService(repo, registry, eventService);
    const request: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId,
    };

    const decision = await router.routeRole(request);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedAccountId).toBe(accountIdB);
    const evalA = decision.candidateEvaluations.find((c) => c.accountId === accountIdA);
    expect(evalA?.eligibility).toBe('INELIGIBLE');
  });

  it('30. safety check in RoleAwareRoutingService does not mutate account state', async () => {
    const beforeAccount = repo.getProviderAccount(accountIdA);
    const router = new RoleAwareRoutingService(repo, registry, eventService);
    await router.routeRole({
      projectId,
      taskId,
      roleProfileId,
    });
    const afterAccount = repo.getProviderAccount(accountIdA);

    expect(afterAccount?.health_status).toBe(beforeAccount?.health_status);
    expect(afterAccount?.cooldown_until).toBe(beforeAccount?.cooldown_until);
    expect(afterAccount?.updated_at).toBe(beforeAccount?.updated_at);
    expect(afterAccount?.enabled).toBe(beforeAccount?.enabled);
  });

  // ============================================================
  // SECTION 45: LEGACY PROVIDER ROUTING TESTS
  // ============================================================

  it('31. ProviderRoutingService excludes account-bound resource when bound account is unsafe', async () => {
    insertObservationDirectly({
      authorization_id: 'auth-bound-unsafe',
      account_id: accountIdA,
      account_order: 1,
      health_action_plan_version: 1,
      health_action: 'RECORD_AUTH_ERROR',
    });

    const router = new ProviderRoutingService(repo, registry, eventService);
    const request: RoutingRequest = {
      projectId,
      taskId,
      requiredCapabilities: ['CODING'],
      candidateResourceIds: [resourceIdA],
      allowManualBridge: false,
    };

    const decision = await router.route(request);
    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    const evalRes = decision.candidateEvaluations.find((c) => c.resourceId === resourceIdA);
    expect(evalRes?.eligibility).toBe('INELIGIBLE');
    expect(evalRes?.rejectionReasons.some((r) => r.includes('PROVIDER_HEALTH_UNRESOLVED_AUTHORITY'))).toBe(true);
  });

  it('32. ProviderRoutingService leaves unbound resource (provider_account_id = null) unchanged', async () => {
    const now = new Date().toISOString();
    const unboundResId = 'res-unbound-test';
    repo.createProviderResource({
      id: unboundResId,
      provider_id: providerId,
      provider_account_id: null,
      model_name: 'test-model-unbound',
      health_status: 'AVAILABLE',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: 1000,
      remaining_quota: 1000,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MEASURED',
      quota_confidence: 1.0,
      last_health_check: now,
    });

    const router = new ProviderRoutingService(repo, registry, eventService);
    const request: RoutingRequest = {
      projectId,
      taskId,
      requiredCapabilities: ['CODING'],
      candidateResourceIds: [unboundResId],
      allowManualBridge: false,
    };

    const decision = await router.route(request);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedResourceId).toBe(unboundResId);
  });

  it('33. ProviderRoutingService account-bound safety check runs before live adapter probe', async () => {
    insertObservationDirectly({
      authorization_id: 'auth-bound-unsafe-2',
      account_id: accountIdA,
      account_order: 1,
      health_action_plan_version: 1,
      health_action: 'RECORD_AUTH_ERROR',
    });

    let probeCalled = false;
    mockAdapter.getHealth = async () => {
      probeCalled = true;
      return 'AVAILABLE';
    };

    const router = new ProviderRoutingService(repo, registry, eventService);
    await router.route({
      projectId,
      taskId,
      requiredCapabilities: ['CODING'],
      candidateResourceIds: [resourceIdA],
      allowManualBridge: false,
    });

    expect(probeCalled).toBe(false);
  });

  // ============================================================
  // SECTION 46, 47, 48: DISPATCH TESTS
  // ============================================================

  function createValidAuthorization(authId: string, accountId: string, resourceId: string): string {
    const now = new Date().toISOString();
    const assignmentId = `asgn-${authId}`;
    const routingDecisionId = `dec-${authId}`;

    repo.createAgentAssignment({
      id: assignmentId,
      project_id: projectId,
      task_id: taskId,
      attempt_id: null,
      role_profile_id: roleProfileId,
      agent_profile_id: agentProfileId,
      selected_provider_id: providerId,
      selected_account_id: accountId,
      selected_resource_id: resourceId,
      selected_worker_slot_id: null,
      routing_decision_id: routingDecisionId,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: now,
      ended_at: null,
    });

    const managerPayload = JSON.stringify({
      protocol: 'manager.v1',
      message_id: 'msg-1',
      project_id: projectId,
      task_id: taskId,
      decision: 'EXECUTE',
      instructions: ['Execute safely'],
      constraints: [],
      suggested_approaches: [],
    });
    const managerPayloadHash = crypto.createHash('sha256').update(managerPayload).digest('hex');

    const canonicalPayload = computeCanonicalPayload({
      projectId,
      taskId,
      attemptId: null,
      taskTitle: 'Safety Task',
      taskDescription: 'Test task for routing safety',
      acceptanceCriteria: [],
      constraints: [],
      instructions: ['Execute safely'],
      contextFiles: [],
      verificationCommands: { TEST: null, LINT: null, BUILD: null },
      managerMessageId: 'msg-1',
      managerPayloadHash,
    });
    const instructionPayloadHash = computePayloadHash(canonicalPayload);
    const contextManifestHash = computeContextManifestHash([]);

    // Insert routing decision record in events/repository
    const routingPayload = {
      decisionId: routingDecisionId,
      projectId,
      taskId,
      attemptId: null,
      outcome: 'SELECTED',
      selectedProviderId: providerId,
      selectedResourceId: resourceId,
      selectedAccountId: accountId,
      selectedAssignmentId: assignmentId,
      roleProfileId,
    };

    eventService.record(
      projectId,
      'PROVIDER_ROUTING_DECISION',
      'Routing decision for safety dispatch test',
      routingPayload,
      taskId
    );

    repo.createExecutionAuthorization({
      id: authId,
      project_id: projectId,
      task_id: taskId,
      attempt_id: null,
      task_revision: 0,
      base_sha: baseSha,
      repository_head_sha: baseSha,
      manager_message_id: 'msg-1',
      manager_payload_hash: managerPayloadHash,
      routing_decision_id: routingDecisionId,
      selected_provider_id: providerId,
      selected_resource_id: resourceId,
      canonical_instructions_json: JSON.stringify(['Execute safely']),
      context_files_json: JSON.stringify([]),
      canonical_payload_json: JSON.stringify(canonicalPayload),
      instruction_payload_hash: instructionPayloadHash,
      context_manifest_hash: contextManifestHash,
      status: 'AUTHORIZED',
      created_at: now,
      dispatched_at: null,
    });

    return authId;
  }

  it('34. ProviderDispatchService pre-claim check fails closed on unsafe account -> adapter not invoked', async () => {
    insertObservationDirectly({
      authorization_id: 'auth-preclaim-unsafe',
      account_id: accountIdA,
      account_order: 1,
      health_action_plan_version: 1,
      health_action: 'RECORD_AUTH_ERROR',
    });

    const authId = 'auth-dispatch-preclaim-test';
    createValidAuthorization(authId, accountIdA, resourceIdA);

    const dispatcher = new ProviderDispatchService(registry, repo, eventService);
    const result = await dispatcher.dispatch(authId);

    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('RESOURCE_UNAVAILABLE');
    expect(result.error).toContain('EXECUTION_AUTHORIZATION_ROUTING_UNSAFE');
    expect(mockAdapter.executionCount).toBe(0);

    const auth = repo.getExecutionAuthorization(authId);
    expect(auth?.status).toBe('INVALIDATED');
  });

  it('35. ProviderDispatchService post-claim check fails closed when account becomes unsafe after claim -> adapter not invoked', async () => {
    const authId = 'auth-dispatch-postclaim-test';
    createValidAuthorization(authId, accountIdA, resourceIdA);

    // Instrument evaluateProviderHealthRoutingSafety to become unsafe after claim
    const originalEval = repo.evaluateProviderHealthRoutingSafety.bind(repo);
    let callCount = 0;
    repo.evaluateProviderHealthRoutingSafety = (accId: string) => {
      callCount++;
      if (callCount === 1) {
        // Pre-claim check returns SAFE
        return {
          status: 'SAFE',
          accountId: accId,
          watermarkAccountOrder: null,
          watermarkAuthorizationId: null,
          effectiveHeadAccountOrder: null,
          effectiveHeadAuthorizationId: null,
          effectiveHeadHealthAction: null,
        };
      } else {
        // Post-claim check returns PENDING_APPLICATION
        return {
          status: 'PENDING_APPLICATION',
          accountId: accId,
          watermarkAccountOrder: null,
          watermarkAuthorizationId: null,
          effectiveHeadAccountOrder: 2,
          effectiveHeadAuthorizationId: 'auth-race-2',
          effectiveHeadHealthAction: 'RECORD_AUTH_ERROR',
          reason: 'Race condition simulated',
        };
      }
    };

    const dispatcher = new ProviderDispatchService(registry, repo, eventService);
    const result = await dispatcher.dispatch(authId);

    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('RESOURCE_UNAVAILABLE');
    expect(result.error).toContain('EXECUTION_DISPATCH_ROUTING_UNSAFE');
    expect(mockAdapter.executionCount).toBe(0);

    repo.evaluateProviderHealthRoutingSafety = originalEval;
  });

  it('36. ProviderDispatchService post-claim unsafe does not roll authorization status backward', async () => {
    const authId = 'auth-dispatch-status-test';
    createValidAuthorization(authId, accountIdA, resourceIdA);

    const originalEval = repo.evaluateProviderHealthRoutingSafety.bind(repo);
    let callCount = 0;
    repo.evaluateProviderHealthRoutingSafety = (accId: string) => {
      callCount++;
      if (callCount === 1) {
        return {
          status: 'SAFE',
          accountId: accId,
          watermarkAccountOrder: null,
          watermarkAuthorizationId: null,
          effectiveHeadAccountOrder: null,
          effectiveHeadAuthorizationId: null,
          effectiveHeadHealthAction: null,
        };
      } else {
        return {
          status: 'ACTION_AUTHORITY_UNKNOWN',
          accountId: accId,
          watermarkAccountOrder: null,
          watermarkAuthorizationId: null,
          effectiveHeadAccountOrder: 5,
          effectiveHeadAuthorizationId: 'auth-unknown-5',
          effectiveHeadHealthAction: null,
        };
      }
    };

    const dispatcher = new ProviderDispatchService(registry, repo, eventService);
    await dispatcher.dispatch(authId);

    const auth = repo.getExecutionAuthorization(authId);
    expect(auth?.status).toBe('DISPATCHED');

    repo.evaluateProviderHealthRoutingSafety = originalEval;
  });

  it('37. ProviderDispatchService succeeds when account is safe across pre-claim and post-claim checks', async () => {
    insertObservationDirectly({
      authorization_id: 'auth-succ-applied-ok',
      account_id: accountIdA,
      account_order: 1,
      health_action_plan_version: 1,
      health_action: 'RECORD_SUCCESS',
    });
    setAccountWatermark(accountIdA, 1, 'auth-succ-applied-ok');

    const authId = 'auth-dispatch-safe-test';
    createValidAuthorization(authId, accountIdA, resourceIdA);

    const dispatcher = new ProviderDispatchService(registry, repo, eventService);
    const result = await dispatcher.dispatch(authId);

    expect(result.status).toBe('COMPLETED');
    expect(mockAdapter.executionCount).toBe(1);
  });

  it('38. ProviderDispatchService safety failure does not mutate account health or enabled flags', async () => {
    insertObservationDirectly({
      authorization_id: 'auth-preclaim-mutate-check',
      account_id: accountIdA,
      account_order: 1,
      health_action_plan_version: 1,
      health_action: 'RECORD_AUTH_ERROR',
    });

    const beforeAccount = repo.getProviderAccount(accountIdA);

    const authId = 'auth-dispatch-mutate-test';
    createValidAuthorization(authId, accountIdA, resourceIdA);

    const dispatcher = new ProviderDispatchService(registry, repo, eventService);
    await dispatcher.dispatch(authId);

    const afterAccount = repo.getProviderAccount(accountIdA);
    expect(afterAccount?.health_status).toBe(beforeAccount?.health_status);
    expect(afterAccount?.enabled).toBe(beforeAccount?.enabled);
    expect(afterAccount?.cooldown_until).toBe(beforeAccount?.cooldown_until);
  });

  it('39. Post-claim race test: new authority committed after claim is caught before adapter invocation (POST_CLAIM_NEW_AUTHORITY_CAUGHT_BEFORE_ADAPTER)', async () => {
    const authId = 'auth-dispatch-race-linearization';
    createValidAuthorization(authId, accountIdA, resourceIdA);

    // Initial state: account is safe with watermark=1
    insertObservationDirectly({
      authorization_id: 'auth-init-1',
      account_id: accountIdA,
      account_order: 1,
      health_action_plan_version: 1,
      health_action: 'RECORD_SUCCESS',
    });
    setAccountWatermark(accountIdA, 1, 'auth-init-1');

    // Hook claimExecutionAuthorization to insert a new durable unapplied observation right after claim
    const originalClaim = repo.claimExecutionAuthorization.bind(repo);
    repo.claimExecutionAuthorization = (claimAuthId: string, claimedAt: string) => {
      const claimed = originalClaim(claimAuthId, claimedAt);
      if (claimed) {
        // Concurrently insert an actionable observation (order 2) that makes account PENDING_APPLICATION
        insertObservationDirectly({
          authorization_id: 'auth-concurrent-race-2',
          account_id: accountIdA,
          account_order: 2,
          health_action_plan_version: 1,
          health_action: 'RECORD_AUTH_ERROR',
        });
      }
      return claimed;
    };

    const dispatcher = new ProviderDispatchService(registry, repo, eventService);
    const result = await dispatcher.dispatch(authId);

    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('RESOURCE_UNAVAILABLE');
    expect(result.error).toContain('EXECUTION_DISPATCH_ROUTING_UNSAFE');
    expect(mockAdapter.executionCount).toBe(0);

    repo.claimExecutionAuthorization = originalClaim;
  });
});
