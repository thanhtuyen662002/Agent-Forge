import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ProviderRegistry } from '../src/core/adapters/ProviderRegistry';
import { EventService } from '../src/core/services/EventService';
import { RoleAwareRoutingService } from '../src/core/services/RoleAwareRoutingService';
import { ProviderAdapter, AgentExecutionResult, AgentExecutionRequest, RuntimeErrorCode } from '../src/core/adapters/ProviderAdapter';
import {
  ProviderHealthObservation,
  ProviderAccountHealthAction,
  FailoverPolicyAuthoritySnapshotV1,
} from '../src/core/types/domain';
import { ProviderDispatchExecutionResult } from '../src/core/services/ProviderDispatchService';

class TestMockAdapter implements ProviderAdapter {
  public id = 'prov-test';
  public name = 'Test Provider';
  public adapterType = 'MOCK' as const;
  public async getCapabilities() { return []; }
  public async getHealth() { return 'AVAILABLE' as const; }
  public async getQuota() {
    return {
      remaining: null,
      total: null,
      unit: 'REQUESTS',
      source: 'UNKNOWN' as const,
      confidence: 1.0,
      resetAt: null,
    };
  }
  public async execute(req: AgentExecutionRequest): Promise<AgentExecutionResult> {
    return {
      status: 'COMPLETED',
      executionId: 'exec-1',
    };
  }
  public async cancel(executionId: string): Promise<void> {}
}

describe('R5H4 Durable Provider Health Action Plan Authority & Routing Snapshot Contract', () => {
  let db: Database.Database;
  let repo: Repository;
  let eventService: EventService;
  let registry: ProviderRegistry;
  let routingService: RoleAwareRoutingService;

  const mockDate = new Date('2026-08-26T12:00:00.000Z');
  const clock = () => mockDate;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);

    repo = new Repository(db);
    eventService = new EventService(repo);
    registry = new ProviderRegistry();
    registry.register(new TestMockAdapter());
    routingService = new RoleAwareRoutingService(repo, registry, eventService, clock);

    // Setup base fixtures
    repo.createProject({
      id: 'proj-1',
      name: 'Action Plan Project',
      description: 'Project for action plan test',
      repository_path: '/test/repo',
      default_branch: 'main',
      status: 'READY',
      contract: null,
      started_at: null,
      completed_at: null,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });

    repo.createTask({
      id: 'task-1',
      project_id: 'proj-1',
      milestone_id: null,
      title: 'Task 1',
      description: 'Task 1 description',
      state: 'PLANNED',
      priority: 'HIGH',
      risk: 'MEDIUM',
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

    repo.createProvider({
      id: 'prov-test',
      name: 'Test Provider',
      adapter_type: 'MOCK',
      enabled: true,
      created_at: '2026-08-26T12:00:00.000Z',
    });

    repo.createProviderAccount({
      id: 'acc-1',
      provider_id: 'prov-test',
      label: 'Account 1',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: 'wincred://agentforge/test_key_1',
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

    repo.createProviderAccount({
      id: 'acc-2',
      provider_id: 'prov-test',
      label: 'Account 2',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: 'wincred://agentforge/test_key_2',
      profile_ref: null,
      enabled: true,
      priority: 2,
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
      id: 'res-1',
      provider_id: 'prov-test',
      provider_account_id: 'acc-1',
      model_name: 'model-primary',
      health_status: 'AVAILABLE',
      capabilities: [],
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
      display_name: 'Coder Profile',
      required_capabilities: [],
      preferred_capabilities: [],
      authority_scope: null,
      permissions: [],
      output_protocol: null,
      enabled: true,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });

    repo.recordProtocolMessage(
      'rec-1',
      'msg-1',
      'manager.v1',
      'proj-1',
      'task-1',
      'APPROVED',
      0,
      'sha-msg-1',
      JSON.stringify({ instruction: 'test' }),
      'APPLIED',
      undefined,
      '2026-08-26T12:00:00.000Z'
    );
  });

  afterEach(() => {
    db.close();
  });

  // Helper to create an authorization
  function createTestAuthorization(authId: string, routingDecisionId: string, accountId: string = 'acc-1'): void {
    repo.createExecutionAuthorization({
      id: authId,
      project_id: 'proj-1',
      task_id: 'task-1',
      attempt_id: null,
      task_revision: 0,
      base_sha: 'sha-base',
      repository_head_sha: 'sha-head',
      manager_message_id: 'rec-1',
      manager_payload_hash: 'hash-mgr',
      routing_decision_id: routingDecisionId,
      selected_resource_id: 'res-1',
      selected_provider_id: 'prov-test',
      instruction_payload_hash: 'hash-inst',
      context_manifest_hash: 'hash-ctx',
      canonical_instructions_json: JSON.stringify({ instruction: 'test' }),
      context_files_json: JSON.stringify({}),
      canonical_payload_json: JSON.stringify({}),
      status: 'DISPATCHED',
      created_at: '2026-08-26T12:00:00.000Z',
      dispatched_at: '2026-08-26T12:00:01.000Z',
    });
  }

  // Helper to build coherent execution result
  function buildTestResult(
    authId: string,
    execId: string,
    status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'AWAITING_OWNER',
    routingDecisionId: string,
    adapterInvocation: 'RETURNED' | 'THREW' = 'RETURNED',
    error?: string,
    assignmentId: string = 'assign-1',
    accountId: string = 'acc-1',
    errorCode?: RuntimeErrorCode | null
  ): ProviderDispatchExecutionResult {
    return {
      status,
      executionId: execId,
      rawResponse: status === 'COMPLETED' ? 'success' : undefined,
      error,
      errorCode,
      providerExecutionProvenance: {
        version: 1,
        source: 'PROVIDER_DISPATCH_SERVICE',
        mode: 'SCHEDULED',
        adapterInvocation,
        authorizationId: authId,
        executionId: execId,
        projectId: 'proj-1',
        taskId: 'task-1',
        attemptId: null,
        routingDecisionId,
        providerId: 'prov-test',
        resourceId: 'res-1',
        assignmentId,
        accountId,
      },
    };
  }

  // 1. Action enum bounded
  it('1. ProviderAccountHealthAction values are bounded to canonical set', () => {
    const validActions: ProviderAccountHealthAction[] = [
      'NO_MUTATION',
      'RECORD_SUCCESS',
      'RECORD_RATE_LIMITED',
      'RECORD_QUOTA_EXHAUSTED',
      'RECORD_AUTH_ERROR',
    ];
    expect(validActions).toHaveLength(5);
  });

  // 2. Snapshot version bounded
  it('2. FailoverPolicyAuthoritySnapshotV1 version is strictly 1', () => {
    const validSnapshot: FailoverPolicyAuthoritySnapshotV1 = {
      version: 1,
      status: 'VALID',
      policy: { version: 1, enabled: true, max_failover_attempts: 2, same_account_retries: 0, allow_cross_account: true, allow_cross_provider: false },
    };
    expect(validSnapshot.version).toBe(1);
  });

  // 3. Routing event persists routePolicyId
  it('3. Routing event persists routePolicyId in structured event payload', async () => {
    repo.createRoutePolicy({
      id: 'pol-1',
      name: 'Policy 1',
      required_capabilities: [],
      preferred_capabilities: [],
      provider_account_policy: null,
      allow_manual_bridge: false,
      failover_policy: { version: 1, enabled: true, max_failover_attempts: 2, same_account_retries: 0, allow_cross_account: true, allow_cross_provider: false, cooldown_duration_ms: 45000 },
      risk_policy: null,
      enabled: true,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });

    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      routePolicyId: 'pol-1',
      persistAssignment: true,
    });

    const events = repo.getEvents('proj-1');
    const routingEvent = events.find((e) => e.type === 'ROLE_AWARE_ROUTING_DECISION');
    expect(routingEvent).toBeDefined();
    expect(routingEvent?.structured_payload.routePolicyId).toBe('pol-1');
  });

  // 4. Routing event persists ABSENT snapshot
  it('4. Routing event persists ABSENT snapshot when routePolicyId is not supplied', async () => {
    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      persistAssignment: true,
    });

    expect(decision.failoverPolicyAuthoritySnapshot).toEqual({ version: 1, status: 'ABSENT' });
    const events = repo.getEvents('proj-1');
    const routingEvent = events.find((e) => e.type === 'ROLE_AWARE_ROUTING_DECISION');
    expect(routingEvent?.structured_payload.failoverPolicyAuthoritySnapshot).toEqual({ version: 1, status: 'ABSENT' });
  });

  // 5. Routing event persists VALID snapshot
  it('5. Routing event persists VALID snapshot with canonical FailoverPolicyV1', async () => {
    repo.createRoutePolicy({
      id: 'pol-valid',
      name: 'Valid Policy',
      required_capabilities: [],
      preferred_capabilities: [],
      provider_account_policy: null,
      allow_manual_bridge: false,
      failover_policy: { version: 1, enabled: true, max_failover_attempts: 3, same_account_retries: 1, allow_cross_account: true, allow_cross_provider: false, cooldown_duration_ms: 60000 },
      risk_policy: null,
      enabled: true,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });

    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      routePolicyId: 'pol-valid',
      persistAssignment: true,
    });

    expect(decision.failoverPolicyAuthoritySnapshot.status).toBe('VALID');
    if (decision.failoverPolicyAuthoritySnapshot.status === 'VALID') {
      expect(decision.failoverPolicyAuthoritySnapshot.policy.enabled).toBe(true);
      expect((decision.failoverPolicyAuthoritySnapshot.policy as any).cooldown_duration_ms).toBe(60000);
    }
  });

  // 6. Routing event persists INVALID without arbitrary raw blob
  it('6. Routing event persists INVALID without arbitrary raw blob when policy is malformed', async () => {
    db.prepare(`
      INSERT INTO route_policies (
        id, name, required_capabilities_json, preferred_capabilities_json, provider_account_policy_json,
        allow_manual_bridge, failover_policy_json, risk_policy_json, enabled, created_at, updated_at
      ) VALUES (
        'pol-invalid', 'Invalid Pol', '[]', '[]', NULL, 0, '{"invalid_structure": true, "secret_key": "secret"}', NULL, 1, '2026-08-26T12:00:00.000Z', '2026-08-26T12:00:00.000Z'
      )
    `).run();

    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      routePolicyId: 'pol-invalid',
      persistAssignment: true,
    });

    expect(decision.failoverPolicyAuthoritySnapshot).toEqual({ version: 1, status: 'INVALID' });
    const events = repo.getEvents('proj-1');
    const routingEvent = events.find((e) => e.type === 'ROLE_AWARE_ROUTING_DECISION');
    expect(routingEvent?.structured_payload.failoverPolicyAuthoritySnapshot).toEqual({ version: 1, status: 'INVALID' });
    expect(JSON.stringify(routingEvent?.structured_payload)).not.toContain('secret_key');
  });

  // 7. Post-routing RoutePolicy mutation does not alter snapshot
  it('7. Post-routing RoutePolicy mutation does not alter durable routing event snapshot', async () => {
    repo.createRoutePolicy({
      id: 'pol-freeze',
      name: 'Freeze Policy',
      required_capabilities: [],
      preferred_capabilities: [],
      provider_account_policy: null,
      allow_manual_bridge: false,
      failover_policy: { version: 1, enabled: true, max_failover_attempts: 2, same_account_retries: 0, allow_cross_account: true, allow_cross_provider: false, cooldown_duration_ms: 60000 },
      risk_policy: null,
      enabled: true,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });

    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      routePolicyId: 'pol-freeze',
      persistAssignment: true,
    });

    repo.updateRoutePolicy('pol-freeze', {
      failover_policy: { version: 1, enabled: true, max_failover_attempts: 10, same_account_retries: 5, allow_cross_account: false, allow_cross_provider: false, cooldown_duration_ms: 999999 },
    });

    const events = repo.getEvents('proj-1');
    const routingEvent = events.find((e) => e.structured_payload.decisionId === decision.decisionId);
    expect((routingEvent?.structured_payload as any).failoverPolicyAuthoritySnapshot.policy.cooldown_duration_ms).toBe(60000);
  });

  // 8. Legacy routing event still permits observation
  it('8. Legacy routing event without policy snapshot still permits observation ingestion', async () => {
    eventService.record('proj-1', 'ROLE_AWARE_ROUTING_DECISION', 'Legacy decision', {
      decisionId: 'dec-legacy-1',
      roleProfileId: 'rp-coder',
      role: 'CODER',
      outcome: 'SELECTED',
      selectedProviderId: 'prov-test',
      selectedAccountId: 'acc-1',
      selectedResourceId: 'res-1',
      selectedAssignmentId: 'assign-leg-1',
    }, 'task-1');

    repo.createAgentAssignment({
      id: 'assign-leg-1',
      project_id: 'proj-1',
      task_id: 'task-1',
      attempt_id: null,
      role_profile_id: 'rp-coder',
      agent_profile_id: null,
      selected_provider_id: 'prov-test',
      selected_account_id: 'acc-1',
      selected_resource_id: 'res-1',
      selected_worker_slot_id: null,
      routing_decision_id: 'dec-legacy-1',
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: '2026-08-26T12:00:00.000Z',
      ended_at: null,
    });

    createTestAuthorization('auth-leg-1', 'dec-legacy-1');
    const result = buildTestResult('auth-leg-1', 'exec-leg-1', 'COMPLETED', 'dec-legacy-1', 'RETURNED', undefined, 'assign-leg-1');

    const obs: ProviderHealthObservation = {
      authorization_id: 'auth-leg-1',
      execution_id: 'exec-leg-1',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: 'assign-leg-1',
      attempt_id: null,
      routing_decision_id: 'dec-legacy-1',
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'COMPLETED',
      classified_category: 'SUCCESS',
      observed_at: '2026-08-26T12:05:00.000Z',
    };

    const claimStatus = repo.claimProviderHealthObservation(obs, result);
    expect(claimStatus).toBe('RECORDED');

    const recorded = repo.getProviderHealthObservation('auth-leg-1');
    expect(recorded).not.toBeNull();
    expect(recorded?.account_order).toBe(1);
    expect(recorded?.health_action_plan_version).toBeNull();
    expect(recorded?.health_action).toBeNull();
    expect(recorded?.health_action_cooldown_duration_ms).toBeNull();
  });

  // 9. Legacy routing event yields NULL action plan
  it('9. Legacy routing event yields NULL action plan fields on observation', async () => {
    eventService.record('proj-1', 'ROLE_AWARE_ROUTING_DECISION', 'Legacy decision 2', {
      decisionId: 'dec-legacy-2',
      roleProfileId: 'rp-coder',
      role: 'CODER',
      outcome: 'SELECTED',
      selectedProviderId: 'prov-test',
      selectedAccountId: 'acc-1',
      selectedResourceId: 'res-1',
      selectedAssignmentId: 'assign-leg-2',
    }, 'task-1');

    repo.createAgentAssignment({
      id: 'assign-leg-2',
      project_id: 'proj-1',
      task_id: 'task-1',
      attempt_id: null,
      role_profile_id: 'rp-coder',
      agent_profile_id: null,
      selected_provider_id: 'prov-test',
      selected_account_id: 'acc-1',
      selected_resource_id: 'res-1',
      selected_worker_slot_id: null,
      routing_decision_id: 'dec-legacy-2',
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: '2026-08-26T12:00:00.000Z',
      ended_at: null,
    });

    createTestAuthorization('auth-leg-2', 'dec-legacy-2');
    const result = buildTestResult('auth-leg-2', 'exec-leg-2', 'COMPLETED', 'dec-legacy-2', 'RETURNED', undefined, 'assign-leg-2');

    const obs: ProviderHealthObservation = {
      authorization_id: 'auth-leg-2',
      execution_id: 'exec-leg-2',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: 'assign-leg-2',
      attempt_id: null,
      routing_decision_id: 'dec-legacy-2',
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'COMPLETED',
      classified_category: 'SUCCESS',
      observed_at: '2026-08-26T12:05:00.000Z',
    };

    repo.claimProviderHealthObservation(obs, result);
    const recorded = repo.getProviderHealthObservation('auth-leg-2');
    expect(recorded?.health_action_plan_version).toBeNull();
    expect(recorded?.health_action).toBeNull();
    expect(recorded?.health_action_cooldown_duration_ms).toBeNull();
  });

  // 10. NULL action plan distinct from NO_MUTATION
  it('10. NULL action plan is structurally distinct from NO_MUTATION', async () => {
    repo.createRoutePolicy({
      id: 'pol-disabled',
      name: 'Disabled Policy',
      required_capabilities: [],
      preferred_capabilities: [],
      provider_account_policy: null,
      allow_manual_bridge: false,
      failover_policy: { version: 1, enabled: false },
      risk_policy: null,
      enabled: true,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });

    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      routePolicyId: 'pol-disabled',
      persistAssignment: true,
    });

    createTestAuthorization('auth-no-mut', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-no-mut', 'exec-no-mut', 'FAILED', decision.decisionId, 'RETURNED', 'HTTP 429 rate limit exceeded', assignmentId, 'acc-1', 'QUOTA_EXHAUSTED');

    const obs: ProviderHealthObservation = {
      authorization_id: 'auth-no-mut',
      execution_id: 'exec-no-mut',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'FAILED',
      classified_category: 'RATE_LIMITED',
      observed_at: '2026-08-26T12:06:00.000Z',
    };

    repo.claimProviderHealthObservation(obs, result);
    const recorded = repo.getProviderHealthObservation('auth-no-mut');
    expect(recorded?.health_action_plan_version).toBe(1);
    expect(recorded?.health_action).toBe('NO_MUTATION');
    expect(recorded?.health_action_cooldown_duration_ms).toBeNull();
  });

  // 11. SUCCESS -> RECORD_SUCCESS
  it('11. SUCCESS category derives RECORD_SUCCESS with version 1 and null cooldown', async () => {
    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      persistAssignment: true,
    });

    createTestAuthorization('auth-succ', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-succ', 'exec-succ', 'COMPLETED', decision.decisionId, 'RETURNED', undefined, assignmentId);

    const obs: ProviderHealthObservation = {
      authorization_id: 'auth-succ',
      execution_id: 'exec-succ',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'COMPLETED',
      classified_category: 'SUCCESS',
      observed_at: '2026-08-26T12:07:00.000Z',
    };

    repo.claimProviderHealthObservation(obs, result);
    const recorded = repo.getProviderHealthObservation('auth-succ');
    expect(recorded?.health_action_plan_version).toBe(1);
    expect(recorded?.health_action).toBe('RECORD_SUCCESS');
    expect(recorded?.health_action_cooldown_duration_ms).toBeNull();
  });

  // 12. QUOTA -> RECORD_QUOTA_EXHAUSTED
  it('12. QUOTA_EXHAUSTED category derives RECORD_QUOTA_EXHAUSTED with version 1 and null cooldown', async () => {
    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      persistAssignment: true,
    });

    createTestAuthorization('auth-quota', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-quota', 'exec-quota', 'FAILED', decision.decisionId, 'RETURNED', 'quota exceeded for account', assignmentId, 'acc-1', 'QUOTA_EXHAUSTED');

    const obs: ProviderHealthObservation = {
      authorization_id: 'auth-quota',
      execution_id: 'exec-quota',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'FAILED',
      classified_category: 'QUOTA_EXHAUSTED',
      observed_at: '2026-08-26T12:08:00.000Z',
    };

    repo.claimProviderHealthObservation(obs, result);
    const recorded = repo.getProviderHealthObservation('auth-quota');
    expect(recorded?.health_action_plan_version).toBe(1);
    expect(recorded?.health_action).toBe('RECORD_QUOTA_EXHAUSTED');
    expect(recorded?.health_action_cooldown_duration_ms).toBeNull();
  });

  // 13. AUTH -> RECORD_AUTH_ERROR
  it('13. AUTHENTICATION_FAILURE category derives RECORD_AUTH_ERROR with version 1 and null cooldown', async () => {
    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      persistAssignment: true,
    });

    createTestAuthorization('auth-err', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-err', 'exec-auth-err', 'FAILED', decision.decisionId, 'RETURNED', 'invalid api key 401 unauthorized', assignmentId, 'acc-1', 'AUTH_ERROR');

    const obs: ProviderHealthObservation = {
      authorization_id: 'auth-err',
      execution_id: 'exec-auth-err',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'FAILED',
      classified_category: 'AUTHENTICATION_FAILURE',
      observed_at: '2026-08-26T12:09:00.000Z',
    };

    repo.claimProviderHealthObservation(obs, result);
    const recorded = repo.getProviderHealthObservation('auth-err');
    expect(recorded?.health_action_plan_version).toBe(1);
    expect(recorded?.health_action).toBe('RECORD_AUTH_ERROR');
    expect(recorded?.health_action_cooldown_duration_ms).toBeNull();
  });

  // 14. RATE_LIMITED + 60s -> RECORD_RATE_LIMITED / 60000
  it('14. RATE_LIMITED category with valid snapshot containing 60s cooldown derives RECORD_RATE_LIMITED and 60000ms duration', async () => {
    repo.createRoutePolicy({
      id: 'pol-60s',
      name: '60s Policy',
      required_capabilities: [],
      preferred_capabilities: [],
      provider_account_policy: null,
      allow_manual_bridge: false,
      failover_policy: { version: 1, enabled: true, max_failover_attempts: 2, same_account_retries: 0, allow_cross_account: true, allow_cross_provider: false, cooldown_duration_ms: 60000 },
      risk_policy: null,
      enabled: true,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });

    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      routePolicyId: 'pol-60s',
      persistAssignment: true,
    });

    createTestAuthorization('auth-rl-60', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-rl-60', 'exec-rl-60', 'FAILED', decision.decisionId, 'RETURNED', 'HTTP 429 Too Many Requests', assignmentId, 'acc-1', 'QUOTA_EXHAUSTED');

    const obs: ProviderHealthObservation = {
      authorization_id: 'auth-rl-60',
      execution_id: 'exec-rl-60',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'FAILED',
      classified_category: 'RATE_LIMITED',
      observed_at: '2026-08-26T12:10:00.000Z',
    };

    repo.claimProviderHealthObservation(obs, result);
    const recorded = repo.getProviderHealthObservation('auth-rl-60');
    expect(recorded?.health_action_plan_version).toBe(1);
    expect(recorded?.health_action).toBe('RECORD_RATE_LIMITED');
    expect(recorded?.health_action_cooldown_duration_ms).toBe(60000);
  });

  // 15. RATE_LIMITED without cooldown -> NO_MUTATION
  it('15. RATE_LIMITED category on enabled policy without explicit cooldown derives NO_MUTATION', async () => {
    repo.createRoutePolicy({
      id: 'pol-no-cd',
      name: 'No CD Policy',
      required_capabilities: [],
      preferred_capabilities: [],
      provider_account_policy: null,
      allow_manual_bridge: false,
      failover_policy: { version: 1, enabled: true, max_failover_attempts: 2, same_account_retries: 0, allow_cross_account: true, allow_cross_provider: false },
      risk_policy: null,
      enabled: true,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });

    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      routePolicyId: 'pol-no-cd',
      persistAssignment: true,
    });

    createTestAuthorization('auth-rl-nocd', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-rl-nocd', 'exec-rl-nocd', 'FAILED', decision.decisionId, 'RETURNED', 'HTTP 429 rate limited', assignmentId, 'acc-1', 'QUOTA_EXHAUSTED');

    const obs: ProviderHealthObservation = {
      authorization_id: 'auth-rl-nocd',
      execution_id: 'exec-rl-nocd',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'FAILED',
      classified_category: 'RATE_LIMITED',
      observed_at: '2026-08-26T12:11:00.000Z',
    };

    repo.claimProviderHealthObservation(obs, result);
    const recorded = repo.getProviderHealthObservation('auth-rl-nocd');
    expect(recorded?.health_action).toBe('NO_MUTATION');
    expect(recorded?.health_action_cooldown_duration_ms).toBeNull();
  });

  // 16. RATE_LIMITED absent policy -> NO_MUTATION
  it('16. RATE_LIMITED category with ABSENT policy snapshot derives NO_MUTATION', async () => {
    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      persistAssignment: true,
    });

    createTestAuthorization('auth-rl-abs', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-rl-abs', 'exec-rl-abs', 'FAILED', decision.decisionId, 'RETURNED', 'HTTP 429 rate limit', assignmentId, 'acc-1', 'QUOTA_EXHAUSTED');

    const obs: ProviderHealthObservation = {
      authorization_id: 'auth-rl-abs',
      execution_id: 'exec-rl-abs',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'FAILED',
      classified_category: 'RATE_LIMITED',
      observed_at: '2026-08-26T12:12:00.000Z',
    };

    repo.claimProviderHealthObservation(obs, result);
    const recorded = repo.getProviderHealthObservation('auth-rl-abs');
    expect(recorded?.health_action).toBe('NO_MUTATION');
  });

  // 17. RATE_LIMITED disabled policy -> NO_MUTATION
  it('17. RATE_LIMITED category with disabled failover policy derives NO_MUTATION', async () => {
    repo.createRoutePolicy({
      id: 'pol-dis-cd',
      name: 'Disabled Policy with CD',
      required_capabilities: [],
      preferred_capabilities: [],
      provider_account_policy: null,
      allow_manual_bridge: false,
      failover_policy: { version: 1, enabled: false },
      risk_policy: null,
      enabled: true,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });

    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      routePolicyId: 'pol-dis-cd',
      persistAssignment: true,
    });

    createTestAuthorization('auth-rl-dis', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-rl-dis', 'exec-rl-dis', 'FAILED', decision.decisionId, 'RETURNED', 'HTTP 429 rate limit', assignmentId, 'acc-1', 'QUOTA_EXHAUSTED');

    const obs: ProviderHealthObservation = {
      authorization_id: 'auth-rl-dis',
      execution_id: 'exec-rl-dis',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'FAILED',
      classified_category: 'RATE_LIMITED',
      observed_at: '2026-08-26T12:13:00.000Z',
    };

    repo.claimProviderHealthObservation(obs, result);
    const recorded = repo.getProviderHealthObservation('auth-rl-dis');
    expect(recorded?.health_action).toBe('NO_MUTATION');
  });

  // 18. RATE_LIMITED invalid policy -> NO_MUTATION
  it('18. RATE_LIMITED category with INVALID policy snapshot derives NO_MUTATION', async () => {
    db.prepare(`
      INSERT INTO route_policies (
        id, name, required_capabilities_json, preferred_capabilities_json, provider_account_policy_json,
        allow_manual_bridge, failover_policy_json, risk_policy_json, enabled, created_at, updated_at
      ) VALUES (
        'pol-inv-cd', 'Invalid CD Pol', '[]', '[]', NULL, 0, '{"version": 1, "enabled": true, "cooldown_duration_ms": -500}', NULL, 1, '2026-08-26T12:00:00.000Z', '2026-08-26T12:00:00.000Z'
      )
    `).run();

    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      routePolicyId: 'pol-inv-cd',
      persistAssignment: true,
    });

    createTestAuthorization('auth-rl-inv', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-rl-inv', 'exec-rl-inv', 'FAILED', decision.decisionId, 'RETURNED', 'HTTP 429 rate limit', assignmentId, 'acc-1', 'QUOTA_EXHAUSTED');

    const obs: ProviderHealthObservation = {
      authorization_id: 'auth-rl-inv',
      execution_id: 'exec-rl-inv',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'FAILED',
      classified_category: 'RATE_LIMITED',
      observed_at: '2026-08-26T12:14:00.000Z',
    };

    repo.claimProviderHealthObservation(obs, result);
    const recorded = repo.getProviderHealthObservation('auth-rl-inv');
    expect(recorded?.health_action).toBe('NO_MUTATION');
  });

  // 19. Same RATE_LIMITED category distinguishes actionable vs no-action
  it('19. Two observations with identical RATE_LIMITED category clearly distinguish RECORD_RATE_LIMITED from NO_MUTATION', async () => {
    // Setup A: with 60s cooldown
    repo.createRoutePolicy({
      id: 'pol-diff-a',
      name: 'Policy A',
      required_capabilities: [],
      preferred_capabilities: [],
      provider_account_policy: null,
      allow_manual_bridge: false,
      failover_policy: { version: 1, enabled: true, max_failover_attempts: 2, same_account_retries: 0, allow_cross_account: true, allow_cross_provider: false, cooldown_duration_ms: 60000 },
      risk_policy: null,
      enabled: true,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });
    const decA = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      routePolicyId: 'pol-diff-a',
      persistAssignment: true,
    });
    createTestAuthorization('auth-diff-a', decA.decisionId);
    const resA = buildTestResult('auth-diff-a', 'exec-diff-a', 'FAILED', decA.decisionId, 'RETURNED', 'HTTP 429 rate limit', decA.selectedAssignmentId!, 'acc-1', 'QUOTA_EXHAUSTED');
    repo.claimProviderHealthObservation({
      authorization_id: 'auth-diff-a',
      execution_id: 'exec-diff-a',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: decA.selectedAssignmentId!,
      attempt_id: null,
      routing_decision_id: decA.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'FAILED',
      classified_category: 'RATE_LIMITED',
      observed_at: '2026-08-26T12:10:00.000Z',
    }, resA);

    // Setup B: without cooldown
    repo.createRoutePolicy({
      id: 'pol-diff-b',
      name: 'Policy B',
      required_capabilities: [],
      preferred_capabilities: [],
      provider_account_policy: null,
      allow_manual_bridge: false,
      failover_policy: { version: 1, enabled: true, max_failover_attempts: 2, same_account_retries: 0, allow_cross_account: true, allow_cross_provider: false },
      risk_policy: null,
      enabled: true,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });
    const decB = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      routePolicyId: 'pol-diff-b',
      persistAssignment: true,
    });
    createTestAuthorization('auth-diff-b', decB.decisionId);
    const resB = buildTestResult('auth-diff-b', 'exec-diff-b', 'FAILED', decB.decisionId, 'RETURNED', 'HTTP 429 rate limit', decB.selectedAssignmentId!, 'acc-1', 'QUOTA_EXHAUSTED');
    repo.claimProviderHealthObservation({
      authorization_id: 'auth-diff-b',
      execution_id: 'exec-diff-b',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: decB.selectedAssignmentId!,
      attempt_id: null,
      routing_decision_id: decB.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'FAILED',
      classified_category: 'RATE_LIMITED',
      observed_at: '2026-08-26T12:11:00.000Z',
    }, resB);

    const obsActionable = repo.getProviderHealthObservation('auth-diff-a');
    const obsNoAction = repo.getProviderHealthObservation('auth-diff-b');

    expect(obsActionable?.classified_category).toBe('RATE_LIMITED');
    expect(obsNoAction?.classified_category).toBe('RATE_LIMITED');

    expect(obsActionable?.health_action).toBe('RECORD_RATE_LIMITED');
    expect(obsActionable?.health_action_cooldown_duration_ms).toBe(60000);

    expect(obsNoAction?.health_action).toBe('NO_MUTATION');
    expect(obsNoAction?.health_action_cooldown_duration_ms).toBeNull();
  });

  // 20. AWAITING_OWNER -> NO_MUTATION
  it('20. AWAITING_OWNER derives NO_MUTATION with version 1', async () => {
    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      persistAssignment: true,
    });

    createTestAuthorization('auth-owner', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-owner', 'exec-owner', 'AWAITING_OWNER', decision.decisionId, 'RETURNED', undefined, assignmentId);

    const obs: ProviderHealthObservation = {
      authorization_id: 'auth-owner',
      execution_id: 'exec-owner',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'AWAITING_OWNER',
      classified_category: 'AWAITING_OWNER',
      observed_at: '2026-08-26T12:15:00.000Z',
    };

    repo.claimProviderHealthObservation(obs, result);
    const recorded = repo.getProviderHealthObservation('auth-owner');
    expect(recorded?.health_action).toBe('NO_MUTATION');
  });

  // 21. ADAPTER_THROW -> NO_MUTATION
  it('21. ADAPTER_THROW derives NO_MUTATION with version 1', async () => {
    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      persistAssignment: true,
    });

    createTestAuthorization('auth-threw', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-threw', 'exec-threw', 'FAILED', decision.decisionId, 'THREW', 'uncaught JS crash in adapter', assignmentId);

    const obs: ProviderHealthObservation = {
      authorization_id: 'auth-threw',
      execution_id: 'exec-threw',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'THREW',
      result_status: 'FAILED',
      classified_category: 'ADAPTER_THROW',
      observed_at: '2026-08-26T12:16:00.000Z',
    };

    repo.claimProviderHealthObservation(obs, result);
    const recorded = repo.getProviderHealthObservation('auth-threw');
    expect(recorded?.health_action).toBe('NO_MUTATION');
  });

  // 22. CANCELLED -> NO_MUTATION
  it('22. CANCELLED derives NO_MUTATION with version 1', async () => {
    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      persistAssignment: true,
    });

    createTestAuthorization('auth-cancel', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-cancel', 'exec-cancel', 'CANCELLED', decision.decisionId, 'RETURNED', 'Execution cancelled', assignmentId);

    const obs: ProviderHealthObservation = {
      authorization_id: 'auth-cancel',
      execution_id: 'exec-cancel',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'CANCELLED',
      classified_category: 'CANCELLED',
      observed_at: '2026-08-26T12:17:00.000Z',
    };

    repo.claimProviderHealthObservation(obs, result);
    const recorded = repo.getProviderHealthObservation('auth-cancel');
    expect(recorded?.health_action).toBe('NO_MUTATION');
  });

  // 23. Unknown / local failure -> NO_MUTATION
  it('23. Local process / unknown failure derives NO_MUTATION', async () => {
    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      persistAssignment: true,
    });

    createTestAuthorization('auth-local', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-local', 'exec-local', 'FAILED', decision.decisionId, 'RETURNED', 'spawn ENOMEM local failure', assignmentId, 'acc-1', 'PROCESS_LAUNCH_FAILED');

    const obs: ProviderHealthObservation = {
      authorization_id: 'auth-local',
      execution_id: 'exec-local',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'FAILED',
      classified_category: 'LOCAL_PROCESS_FAILURE',
      observed_at: '2026-08-26T12:18:00.000Z',
    };

    repo.claimProviderHealthObservation(obs, result);
    const recorded = repo.getProviderHealthObservation('auth-local');
    expect(recorded?.health_action).toBe('NO_MUTATION');
  });

  // 24. Caller forged action ignored
  it('24. Caller cannot forge authoritative health_action on input observation', async () => {
    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      persistAssignment: true,
    });

    createTestAuthorization('auth-forge-act', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-forge-act', 'exec-forge-act', 'COMPLETED', decision.decisionId, 'RETURNED', undefined, assignmentId);

    const obs: ProviderHealthObservation = {
      authorization_id: 'auth-forge-act',
      execution_id: 'exec-forge-act',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'COMPLETED',
      classified_category: 'SUCCESS',
      observed_at: '2026-08-26T12:19:00.000Z',
      health_action: 'NO_MUTATION', // Caller attempts to forge NO_MUTATION on a COMPLETED result
      health_action_plan_version: 1,
    };

    repo.claimProviderHealthObservation(obs, result);
    const recorded = repo.getProviderHealthObservation('auth-forge-act');
    expect(recorded?.health_action).toBe('RECORD_SUCCESS'); // Evaluated purely by repository engine
  });

  // 25. Caller forged duration ignored
  it('25. Caller cannot forge authoritative health_action_cooldown_duration_ms on input', async () => {
    repo.createRoutePolicy({
      id: 'pol-cd-30',
      name: '30s CD',
      required_capabilities: [],
      preferred_capabilities: [],
      provider_account_policy: null,
      allow_manual_bridge: false,
      failover_policy: { version: 1, enabled: true, max_failover_attempts: 2, same_account_retries: 0, allow_cross_account: true, allow_cross_provider: false, cooldown_duration_ms: 30000 },
      risk_policy: null,
      enabled: true,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });

    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      routePolicyId: 'pol-cd-30',
      persistAssignment: true,
    });

    createTestAuthorization('auth-forge-dur', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-forge-dur', 'exec-forge-dur', 'FAILED', decision.decisionId, 'RETURNED', 'HTTP 429 rate limited', assignmentId, 'acc-1', 'QUOTA_EXHAUSTED');

    const obs: ProviderHealthObservation = {
      authorization_id: 'auth-forge-dur',
      execution_id: 'exec-forge-dur',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'FAILED',
      classified_category: 'RATE_LIMITED',
      observed_at: '2026-08-26T12:20:00.000Z',
      health_action_cooldown_duration_ms: 999999, // Forged duration
    };

    repo.claimProviderHealthObservation(obs, result);
    const recorded = repo.getProviderHealthObservation('auth-forge-dur');
    expect(recorded?.health_action_cooldown_duration_ms).toBe(30000); // Canonical policy snapshot wins
  });

  // 26. Account / Action coherence
  it('26. Incoherent account target in provenance fails observation claim', async () => {
    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      persistAssignment: true,
    });

    createTestAuthorization('auth-incoh-acc', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-incoh-acc', 'exec-incoh-acc', 'COMPLETED', decision.decisionId, 'RETURNED', undefined, assignmentId);
    (result.providerExecutionProvenance as any).accountId = 'acc-2'; // Incoherent with observation acc-1

    const obs: ProviderHealthObservation = {
      authorization_id: 'auth-incoh-acc',
      execution_id: 'exec-incoh-acc',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'COMPLETED',
      classified_category: 'SUCCESS',
      observed_at: '2026-08-26T12:21:00.000Z',
    };

    expect(() => repo.claimProviderHealthObservation(obs, result)).toThrow(/ACCOUNT_ID_MISMATCH/);
  });

  // 27. Authorization / Action coherence
  it('27. Incoherent authorizationId in provenance fails observation claim', async () => {
    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      persistAssignment: true,
    });

    createTestAuthorization('auth-incoh-auth', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-incoh-auth', 'exec-incoh-auth', 'COMPLETED', decision.decisionId, 'RETURNED', undefined, assignmentId);
    (result.providerExecutionProvenance as any).authorizationId = 'auth-other';

    const obs: ProviderHealthObservation = {
      authorization_id: 'auth-incoh-auth',
      execution_id: 'exec-incoh-auth',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'COMPLETED',
      classified_category: 'SUCCESS',
      observed_at: '2026-08-26T12:22:00.000Z',
    };

    expect(() => repo.claimProviderHealthObservation(obs, result)).toThrow(/AUTHORIZATION_ID_MISMATCH/);
  });

  // 28. Category / Action coherence
  it('28. Incoherent classified_category with result status fails observation claim', async () => {
    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      persistAssignment: true,
    });

    createTestAuthorization('auth-incoh-cat', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-incoh-cat', 'exec-incoh-cat', 'COMPLETED', decision.decisionId, 'RETURNED', undefined, assignmentId);

    const obs: ProviderHealthObservation = {
      authorization_id: 'auth-incoh-cat',
      execution_id: 'exec-incoh-cat',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'COMPLETED',
      classified_category: 'RATE_LIMITED', // Incoherent with COMPLETED
      observed_at: '2026-08-26T12:23:00.000Z',
    };

    expect(() => repo.claimProviderHealthObservation(obs, result)).toThrow(/OBSERVATION_CATEGORY_MISMATCH/);
  });

  // 29. Duplicate identical observation returns ALREADY_RECORDED and retains original action plan
  it('29. Duplicate identical observation returns ALREADY_RECORDED and retains original action plan', async () => {
    repo.createRoutePolicy({
      id: 'pol-dup-test',
      name: 'Dup Policy',
      required_capabilities: [],
      preferred_capabilities: [],
      provider_account_policy: null,
      allow_manual_bridge: false,
      failover_policy: { version: 1, enabled: true, max_failover_attempts: 2, same_account_retries: 0, allow_cross_account: true, allow_cross_provider: false, cooldown_duration_ms: 60000 },
      risk_policy: null,
      enabled: true,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });

    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      routePolicyId: 'pol-dup-test',
      persistAssignment: true,
    });

    createTestAuthorization('auth-dup-test', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-dup-test', 'exec-dup-test', 'FAILED', decision.decisionId, 'RETURNED', 'HTTP 429 rate limited', assignmentId, 'acc-1', 'QUOTA_EXHAUSTED');

    const obs: ProviderHealthObservation = {
      authorization_id: 'auth-dup-test',
      execution_id: 'exec-dup-test',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'FAILED',
      classified_category: 'RATE_LIMITED',
      observed_at: '2026-08-26T12:10:00.000Z',
    };

    repo.claimProviderHealthObservation(obs, result);
    const recorded = repo.getProviderHealthObservation('auth-dup-test');
    expect(recorded).not.toBeNull();

    const dupObs: ProviderHealthObservation = { ...obs };
    const status = repo.claimProviderHealthObservation(dupObs);
    expect(status).toBe('ALREADY_RECORDED');

    const afterDup = repo.getProviderHealthObservation('auth-dup-test');
    expect(afterDup?.health_action).toBe('RECORD_RATE_LIMITED');
    expect(afterDup?.health_action_cooldown_duration_ms).toBe(60000);
  });

  // 30. Duplicate does not use changed current policy
  it('30. Duplicate claim does not re-evaluate or use mutated RoutePolicy', async () => {
    repo.createRoutePolicy({
      id: 'pol-dup-mutate',
      name: 'Dup Mutate Policy',
      required_capabilities: [],
      preferred_capabilities: [],
      provider_account_policy: null,
      allow_manual_bridge: false,
      failover_policy: { version: 1, enabled: true, max_failover_attempts: 2, same_account_retries: 0, allow_cross_account: true, allow_cross_provider: false, cooldown_duration_ms: 60000 },
      risk_policy: null,
      enabled: true,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });

    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      routePolicyId: 'pol-dup-mutate',
      persistAssignment: true,
    });

    createTestAuthorization('auth-dup-mut', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-dup-mut', 'exec-dup-mut', 'FAILED', decision.decisionId, 'RETURNED', 'HTTP 429 rate limited', assignmentId, 'acc-1', 'QUOTA_EXHAUSTED');

    const obs: ProviderHealthObservation = {
      authorization_id: 'auth-dup-mut',
      execution_id: 'exec-dup-mut',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'FAILED',
      classified_category: 'RATE_LIMITED',
      observed_at: '2026-08-26T12:10:00.000Z',
    };

    repo.claimProviderHealthObservation(obs, result);

    // Mutate policy after claim
    repo.updateRoutePolicy('pol-dup-mutate', {
      failover_policy: { version: 1, enabled: false },
    });

    const dupObs: ProviderHealthObservation = { ...obs };
    const status = repo.claimProviderHealthObservation(dupObs);
    expect(status).toBe('ALREADY_RECORDED');

    const after = repo.getProviderHealthObservation('auth-dup-mut');
    expect(after?.health_action).toBe('RECORD_RATE_LIMITED');
    expect(after?.health_action_cooldown_duration_ms).toBe(60000);
  });

  // 31. Restart preserves action
  it('31. Re-instantiating repository (simulating restart) preserves exact persisted health_action', async () => {
    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      persistAssignment: true,
    });

    createTestAuthorization('auth-rst-succ', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-rst-succ', 'exec-rst-succ', 'COMPLETED', decision.decisionId, 'RETURNED', undefined, assignmentId);
    repo.claimProviderHealthObservation({
      authorization_id: 'auth-rst-succ',
      execution_id: 'exec-rst-succ',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'COMPLETED',
      classified_category: 'SUCCESS',
      observed_at: '2026-08-26T12:07:00.000Z',
    }, result);

    const newRepo = new Repository(db);
    const recordedSucc = newRepo.getProviderHealthObservation('auth-rst-succ');
    expect(recordedSucc?.health_action).toBe('RECORD_SUCCESS');
  });

  // 32. Restart preserves rate duration
  it('32. Restart preserves exact health_action_cooldown_duration_ms', async () => {
    repo.createRoutePolicy({
      id: 'pol-rst-dur',
      name: 'Restart Dur Policy',
      required_capabilities: [],
      preferred_capabilities: [],
      provider_account_policy: null,
      allow_manual_bridge: false,
      failover_policy: { version: 1, enabled: true, max_failover_attempts: 2, same_account_retries: 0, allow_cross_account: true, allow_cross_provider: false, cooldown_duration_ms: 60000 },
      risk_policy: null,
      enabled: true,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });

    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      routePolicyId: 'pol-rst-dur',
      persistAssignment: true,
    });

    createTestAuthorization('auth-rst-dur', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-rst-dur', 'exec-rst-dur', 'FAILED', decision.decisionId, 'RETURNED', 'HTTP 429 rate limit', assignmentId, 'acc-1', 'QUOTA_EXHAUSTED');
    repo.claimProviderHealthObservation({
      authorization_id: 'auth-rst-dur',
      execution_id: 'exec-rst-dur',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'FAILED',
      classified_category: 'RATE_LIMITED',
      observed_at: '2026-08-26T12:10:00.000Z',
    }, result);

    const newRepo = new Repository(db);
    const recordedRl = newRepo.getProviderHealthObservation('auth-rst-dur');
    expect(recordedRl?.health_action_cooldown_duration_ms).toBe(60000);
  });

  // 33. Current RoutePolicy mutation does not alter persisted action
  it('33. Mutating or deleting RoutePolicy does not alter already-persisted observation action plans', async () => {
    repo.createRoutePolicy({
      id: 'pol-del-test',
      name: 'Del Test Policy',
      required_capabilities: [],
      preferred_capabilities: [],
      provider_account_policy: null,
      allow_manual_bridge: false,
      failover_policy: { version: 1, enabled: true, max_failover_attempts: 2, same_account_retries: 0, allow_cross_account: true, allow_cross_provider: false, cooldown_duration_ms: 60000 },
      risk_policy: null,
      enabled: true,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });

    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      routePolicyId: 'pol-del-test',
      persistAssignment: true,
    });

    createTestAuthorization('auth-del-test', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-del-test', 'exec-del-test', 'FAILED', decision.decisionId, 'RETURNED', 'HTTP 429 rate limit', assignmentId, 'acc-1', 'QUOTA_EXHAUSTED');
    repo.claimProviderHealthObservation({
      authorization_id: 'auth-del-test',
      execution_id: 'exec-del-test',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'FAILED',
      classified_category: 'RATE_LIMITED',
      observed_at: '2026-08-26T12:10:00.000Z',
    }, result);

    db.prepare('DELETE FROM route_policies').run();

    const recorded = repo.getProviderHealthObservation('auth-del-test');
    expect(recorded?.health_action).toBe('RECORD_RATE_LIMITED');
    expect(recorded?.health_action_cooldown_duration_ms).toBe(60000);
  });

  // 34. Raw provider error absent from action plan
  it('34. Action plan columns do not store raw provider error messages', () => {
    const columns = (db.prepare('PRAGMA table_info(provider_health_observations)').all() as { name: string }[]).map((c) => c.name);
    expect(columns).not.toContain('reason');
    expect(columns).not.toContain('error');
    expect(columns).not.toContain('raw_payload');
  });

  // 35. Credentials/secrets absent
  it('35. Action plan columns and snapshots do not contain credential references or secrets', async () => {
    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      persistAssignment: true,
    });

    createTestAuthorization('auth-sec-test', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-sec-test', 'exec-sec-test', 'COMPLETED', decision.decisionId, 'RETURNED', undefined, assignmentId);
    repo.claimProviderHealthObservation({
      authorization_id: 'auth-sec-test',
      execution_id: 'exec-sec-test',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'COMPLETED',
      classified_category: 'SUCCESS',
      observed_at: '2026-08-26T12:07:00.000Z',
    }, result);

    const row = db.prepare('SELECT * FROM provider_health_observations WHERE authorization_id = ?').get('auth-sec-test') as Record<string, unknown>;
    const rowStr = JSON.stringify(row);
    expect(rowStr).not.toContain('wincred');
    expect(rowStr).not.toContain('test_key_1');
  });

  // 36. Action derivation rollback leaves no partial observation/action
  it('36. Transaction rollback on observation error leaves no partial observation or action plan', async () => {
    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      persistAssignment: true,
    });

    createTestAuthorization('auth-rb-test', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-rb-test', 'exec-rb-test', 'COMPLETED', decision.decisionId, 'RETURNED', undefined, assignmentId);

    const corruptObs: ProviderHealthObservation = {
      authorization_id: 'auth-rb-test',
      execution_id: 'exec-rb-test',
      account_id: 'acc-nonexistent', // Will fail FK / coherence
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'COMPLETED',
      classified_category: 'SUCCESS',
      observed_at: '2026-08-26T12:24:00.000Z',
    };

    expect(() => repo.claimProviderHealthObservation(corruptObs, result)).toThrow();
    const recorded = repo.getProviderHealthObservation('auth-rb-test');
    expect(recorded).toBeNull();
  });

  // 37. Existing account_order rollback semantics retained
  it('37. Account order sequence is not incremented on rolled-back observation failure', async () => {
    const countBefore = (db.prepare('SELECT MAX(account_order) as max_ord FROM provider_health_observations WHERE account_id = ?').get('acc-1') as { max_ord: number | null }).max_ord ?? 0;

    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      persistAssignment: true,
    });

    createTestAuthorization('auth-ord-rb', decision.decisionId);
    const assignmentId = decision.selectedAssignmentId!;
    const result = buildTestResult('auth-ord-rb', 'exec-ord-rb', 'COMPLETED', decision.decisionId, 'RETURNED', undefined, assignmentId);
    (result as any).status = 'INVALID_STATUS'; // Trigger failure

    const obs: ProviderHealthObservation = {
      authorization_id: 'auth-ord-rb',
      execution_id: 'exec-ord-rb',
      account_id: 'acc-1',
      provider_id: 'prov-test',
      resource_id: 'res-1',
      assignment_id: assignmentId,
      attempt_id: null,
      routing_decision_id: decision.decisionId,
      provenance_version: 1,
      provenance_source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'SCHEDULED',
      adapter_invocation: 'RETURNED',
      result_status: 'COMPLETED',
      classified_category: 'SUCCESS',
      observed_at: '2026-08-26T12:25:00.000Z',
    };

    expect(() => repo.claimProviderHealthObservation(obs, result)).toThrow();
    const countAfter = (db.prepare('SELECT MAX(account_order) as max_ord FROM provider_health_observations WHERE account_id = ?').get('acc-1') as { max_ord: number | null }).max_ord ?? 0;
    expect(countAfter).toBe(countBefore);
  });

  // 38. No AccountHealthService invocation
  it('38. ProviderAccount health fields remain unmutated throughout observation ingestion', () => {
    const account = repo.getProviderAccount('acc-1');
    expect(account?.health_status).toBe('AVAILABLE');
    expect(account?.cooldown_until).toBeNull();
    expect(account?.last_success_at).toBeNull();
    expect(account?.last_failure_at).toBeNull();
  });

  // 39. Cooldown duration check strictly enforces positive integers
  it('39. Migration 13 check constraint rejects non-positive or non-null cooldown durations', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO provider_health_observations (
          authorization_id, execution_id, account_id, provider_id, resource_id, assignment_id,
          routing_decision_id, provenance_version, provenance_source, mode, adapter_invocation,
          result_status, classified_category, observed_at, health_action_plan_version, health_action, health_action_cooldown_duration_ms
        ) VALUES (
          'auth-chk-cd', 'exec-chk-cd', 'acc-1', 'prov-test', 'res-1', 'assign-1',
          'dec-1', 1, 'PROVIDER_DISPATCH_SERVICE', 'SCHEDULED', 'RETURNED',
          'FAILED', 'RATE_LIMITED', '2026-08-26T12:26:00.000Z', 1, 'RECORD_RATE_LIMITED', 0
        )
      `).run();
    }).toThrow();
  });

  // 40. Action check constraint strictly enforces bounded actions
  it('40. Migration 13 check constraint rejects arbitrary health actions', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO provider_health_observations (
          authorization_id, execution_id, account_id, provider_id, resource_id, assignment_id,
          routing_decision_id, provenance_version, provenance_source, mode, adapter_invocation,
          result_status, classified_category, observed_at, health_action_plan_version, health_action
        ) VALUES (
          'auth-chk-act', 'exec-chk-act', 'acc-1', 'prov-test', 'res-1', 'assign-1',
          'dec-1', 1, 'PROVIDER_DISPATCH_SERVICE', 'SCHEDULED', 'RETURNED',
          'FAILED', 'UNKNOWN', '2026-08-26T12:27:00.000Z', 1, 'SYNTHETIC_ACTION'
        )
      `).run();
    }).toThrow();
  });

  // 41. Separation failure after freeze preserves original snapshot
  it('41. Separation failure after freeze preserves original snapshot when RoutePolicy is mutated mid-routing', async () => {
    repo.createRoutePolicy({
      id: 'pol-sep-race',
      name: 'Sep Race Policy',
      required_capabilities: [],
      preferred_capabilities: [],
      provider_account_policy: null,
      allow_manual_bridge: false,
      failover_policy: { version: 1, enabled: true, max_failover_attempts: 2, same_account_retries: 0, allow_cross_account: true, allow_cross_provider: false, cooldown_duration_ms: 60000 },
      risk_policy: null,
      enabled: true,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });

    const originalGetSep = repo.getSeparationPolicy.bind(repo);
    repo.getSeparationPolicy = (id: string) => {
      repo.updateRoutePolicy('pol-sep-race', {
        failover_policy: { version: 1, enabled: true, max_failover_attempts: 10, same_account_retries: 5, allow_cross_account: false, allow_cross_provider: false, cooldown_duration_ms: 900000 },
      });
      return null;
    };

    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      routePolicyId: 'pol-sep-race',
      separationPolicyId: 'sep-missing',
    });

    repo.getSeparationPolicy = originalGetSep;

    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    expect(decision.failoverPolicyAuthoritySnapshot.status).toBe('VALID');
    if (decision.failoverPolicyAuthoritySnapshot.status === 'VALID') {
      expect((decision.failoverPolicyAuthoritySnapshot.policy as any).cooldown_duration_ms).toBe(60000);
    }

    const events = repo.getEvents('proj-1');
    const event = events.find((e) => e.structured_payload.decisionId === decision.decisionId);
    expect(event).toBeDefined();
    expect((event?.structured_payload as any).failoverPolicyAuthoritySnapshot.policy.cooldown_duration_ms).toBe(60000);
  });

  // 42. Reviewed assignment failure after freeze preserves original snapshot
  it('42. Reviewed assignment failure after freeze preserves original snapshot when RoutePolicy is mutated mid-routing', async () => {
    repo.createRoutePolicy({
      id: 'pol-rev-race',
      name: 'Rev Race Policy',
      required_capabilities: [],
      preferred_capabilities: [],
      provider_account_policy: null,
      allow_manual_bridge: false,
      failover_policy: { version: 1, enabled: true, max_failover_attempts: 2, same_account_retries: 0, allow_cross_account: true, allow_cross_provider: false, cooldown_duration_ms: 60000 },
      risk_policy: null,
      enabled: true,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });

    const originalGetAssign = repo.getAgentAssignment.bind(repo);
    repo.getAgentAssignment = (id: string) => {
      repo.updateRoutePolicy('pol-rev-race', {
        failover_policy: { version: 1, enabled: true, max_failover_attempts: 10, same_account_retries: 5, allow_cross_account: false, allow_cross_provider: false, cooldown_duration_ms: 900000 },
      });
      return null;
    };

    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      routePolicyId: 'pol-rev-race',
      reviewedAssignmentId: 'assign-nonexistent',
    });

    repo.getAgentAssignment = originalGetAssign;

    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    expect(decision.failoverPolicyAuthoritySnapshot.status).toBe('VALID');
    if (decision.failoverPolicyAuthoritySnapshot.status === 'VALID') {
      expect((decision.failoverPolicyAuthoritySnapshot.policy as any).cooldown_duration_ms).toBe(60000);
    }

    const events = repo.getEvents('proj-1');
    const event = events.find((e) => e.structured_payload.decisionId === decision.decisionId);
    expect(event).toBeDefined();
    expect((event?.structured_payload as any).failoverPolicyAuthoritySnapshot.policy.cooldown_duration_ms).toBe(60000);
  });

  // 43. Empty candidate failure after freeze preserves original snapshot
  it('43. Empty candidate failure after freeze preserves original snapshot when RoutePolicy is mutated mid-routing', async () => {
    repo.createRoutePolicy({
      id: 'pol-empty-race',
      name: 'Empty Race Policy',
      required_capabilities: [],
      preferred_capabilities: [],
      provider_account_policy: null,
      allow_manual_bridge: false,
      failover_policy: { version: 1, enabled: true, max_failover_attempts: 2, same_account_retries: 0, allow_cross_account: true, allow_cross_provider: false, cooldown_duration_ms: 60000 },
      risk_policy: null,
      enabled: true,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });

    const originalGetAccounts = repo.getAllProviderAccounts.bind(repo);
    repo.getAllProviderAccounts = () => {
      repo.updateRoutePolicy('pol-empty-race', {
        failover_policy: { version: 1, enabled: true, max_failover_attempts: 10, same_account_retries: 5, allow_cross_account: false, allow_cross_provider: false, cooldown_duration_ms: 900000 },
      });
      return [];
    };

    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      routePolicyId: 'pol-empty-race',
    });

    repo.getAllProviderAccounts = originalGetAccounts;

    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    expect(decision.failoverPolicyAuthoritySnapshot.status).toBe('VALID');
    if (decision.failoverPolicyAuthoritySnapshot.status === 'VALID') {
      expect((decision.failoverPolicyAuthoritySnapshot.policy as any).cooldown_duration_ms).toBe(60000);
    }

    const events = repo.getEvents('proj-1');
    const event = events.find((e) => e.structured_payload.decisionId === decision.decisionId);
    expect(event).toBeDefined();
    expect((event?.structured_payload as any).failoverPolicyAuthoritySnapshot.policy.cooldown_duration_ms).toBe(60000);
  });

  // 44. No eligible candidate failure after freeze preserves original snapshot
  it('44. No eligible candidate failure after freeze preserves original snapshot when RoutePolicy is mutated mid-routing', async () => {
    repo.createRoutePolicy({
      id: 'pol-noelig-race',
      name: 'No Elig Race Policy',
      required_capabilities: ['UNSATISFIABLE_CAPABILITY' as any],
      preferred_capabilities: [],
      provider_account_policy: null,
      allow_manual_bridge: false,
      failover_policy: { version: 1, enabled: true, max_failover_attempts: 2, same_account_retries: 0, allow_cross_account: true, allow_cross_provider: false, cooldown_duration_ms: 60000 },
      risk_policy: null,
      enabled: true,
      created_at: '2026-08-26T12:00:00.000Z',
      updated_at: '2026-08-26T12:00:00.000Z',
    });

    const decision = await routingService.routeRole({
      projectId: 'proj-1',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      routePolicyId: 'pol-noelig-race',
    });

    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    expect(decision.failoverPolicyAuthoritySnapshot.status).toBe('VALID');
    if (decision.failoverPolicyAuthoritySnapshot.status === 'VALID') {
      expect((decision.failoverPolicyAuthoritySnapshot.policy as any).cooldown_duration_ms).toBe(60000);
    }

    const events = repo.getEvents('proj-1');
    const event = events.find((e) => e.structured_payload.decisionId === decision.decisionId);
    expect(event).toBeDefined();
    expect((event?.structured_payload as any).failoverPolicyAuthoritySnapshot.policy.cooldown_duration_ms).toBe(60000);
  });

  // 45. Pre-freeze fail-closed does 0 getRoutePolicy lookups
  it('45. Pre-freeze fail-closed does 0 getRoutePolicy lookups and yields ABSENT snapshot on missing project', async () => {
    let getRoutePolicyCalls = 0;
    const originalGetRoutePolicy = repo.getRoutePolicy.bind(repo);
    repo.getRoutePolicy = (id: string) => {
      getRoutePolicyCalls++;
      return originalGetRoutePolicy(id);
    };

    const decision = await routingService.routeRole({
      projectId: 'proj-nonexistent',
      taskId: 'task-1',
      roleProfileId: 'rp-coder',
      routePolicyId: 'pol-60s',
    });

    repo.getRoutePolicy = originalGetRoutePolicy;

    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    expect(getRoutePolicyCalls).toBe(0);
    expect(decision.failoverPolicyAuthoritySnapshot).toEqual({ version: 1, status: 'ABSENT' });
  });
});
