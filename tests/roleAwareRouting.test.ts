import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ProviderRegistry } from '../src/core/adapters/ProviderRegistry';
import { ProviderAdapter, QuotaSnapshotInfo } from '../src/core/adapters/ProviderAdapter';
import { EventService } from '../src/core/services/EventService';
import { ProviderRoutingService } from '../src/core/services/ProviderRoutingService';
import {
  RoleAwareRoutingService,
  RoleAwareRoutingRequest,
} from '../src/core/services/RoleAwareRoutingService';
import {
  Project,
  Task,
  RoleProfile,
  ProviderAccount,
  ProviderResource,
  Provider,
  SeparationPolicy,
  AgentAssignment,
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
    throw new Error('Execute not implemented for test adapter');
  }

  public async cancel(): Promise<void> {}
}

describe('R5E — Role-Aware Router & Separation / Diversity Policy', () => {
  let db: Database.Database;
  let repo: Repository;
  let registry: ProviderRegistry;
  let eventService: EventService;
  let legacyRouter: ProviderRoutingService;
  let roleRouter: RoleAwareRoutingService;

  const projectId = 'proj-r5e-001';
  const taskId = 'task-r5e-001';

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    registry = new ProviderRegistry();
    eventService = new EventService(repo);
    legacyRouter = new ProviderRoutingService(repo, registry, eventService);
    roleRouter = new RoleAwareRoutingService(repo, registry, eventService);

    // Setup base Project and Task
    const now = new Date().toISOString();
    const project: Project = {
      id: projectId,
      name: 'R5E Test Project',
      description: 'Project for testing role-aware routing',
      repository_path: 'D:/Projects/Agent-Forge',
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: now,
      updated_at: now,
      started_at: now,
      completed_at: null,
    };
    repo.createProject(project);

    const task: Task = {
      id: taskId,
      project_id: projectId,
      milestone_id: null,
      title: 'R5E Test Task',
      description: 'Task for testing role routing',
      state: 'APPROVED',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'HIGH',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: '6068f583e0f51f146691870e5066c4bc324f847e',
      current_sha: '6068f583e0f51f146691870e5066c4bc324f847e',
      progress_cache_percent: 0.0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: now,
      updated_at: now,
    };
    repo.createTask(task);

    // Create task attempts for attempts used in tests
    for (let i = 1; i <= 5; i++) {
      repo.createTaskAttempt({
        id: `attempt-00${i}`,
        task_id: taskId,
        attempt_number: i,
        agent_id: 'default-agent',
        status: 'RUNNING',
        started_at: now,
        ended_at: null,
        summary: `Attempt ${i}`,
      });
    }
  });

  afterEach(() => {
    db.close();
  });

  function setupProvider(
    providerId: string,
    accountCount: number = 2,
    adapterType: ProviderAdapterType = 'LOCAL_CLI',
    health: ProviderHealthStatus = 'AVAILABLE'
  ) {
    const now = new Date().toISOString();
    const provider: Provider = {
      id: providerId,
      name: `Provider ${providerId}`,
      adapter_type: adapterType,
      enabled: true,
      created_at: now,
    };
    repo.createProvider(provider);

    const adapter = new MockProviderAdapter(providerId, `Mock ${providerId}`, adapterType, health);
    registry.register(adapter);

    const accounts: ProviderAccount[] = [];
    const resources: ProviderResource[] = [];

    for (let i = 1; i <= accountCount; i++) {
      const accountId = `acc-${providerId}-${i}`;
      const account: ProviderAccount = {
        id: accountId,
        provider_id: providerId,
        label: `Account ${providerId} #${i}`,
        auth_mode: 'NATIVE_PROFILE',
        credential_ref: null,
        profile_ref: `native-profile://${providerId}/p${i}`,
        enabled: true,
        priority: i === 1 ? 10 : 5,
        health_status: health,
        cooldown_until: null,
        concurrency_limit: 2,
        last_success_at: null,
        last_failure_at: null,
        last_failure_code: null,
        created_at: now,
        updated_at: now,
      };
      repo.createProviderAccount(account);
      accounts.push(account);

      const resourceId = `res-${providerId}-${i}`;
      const resource: ProviderResource = {
        id: resourceId,
        provider_id: providerId,
        provider_account_id: accountId,
        model_name: `model-${providerId}`,
        capabilities: ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION', 'TERMINAL'],
        remaining_quota: 1000,
        total_quota: 1000,
        quota_unit: 'REQUESTS',
        quota_source: 'PROVIDER_REPORTED',
        quota_confidence: 1.0,
        quota_reset_at: null,
        health_status: health,
        last_health_check: null,
        enabled: true,
      };
      repo.createProviderResource(resource);
      resources.push(resource);
    }

    return { provider, adapter, accounts, resources, resource: resources[0] };
  }

  function setupRoleProfile(
    roleId: string,
    role: 'CODER' | 'REVIEWER' | 'PLANNER' = 'CODER',
    requiredCaps: Capability[] = ['CODING', 'FILESYSTEM_EDIT']
  ): RoleProfile {
    const now = new Date().toISOString();
    const profile: RoleProfile = {
      id: roleId,
      role,
      display_name: `Role Profile ${roleId}`,
      required_capabilities: requiredCaps,
      preferred_capabilities: ['TEST_EXECUTION'],
      authority_scope: null,
      permissions: ['read', 'write'],
      output_protocol: 'coder.v1',
      enabled: true,
      created_at: now,
      updated_at: now,
    };
    repo.createRoleProfile(profile);
    return profile;
  }

  // 1. RoleProfile is not hard-bound to provider/account
  it('1. ROLE_PROFILE_PROVIDER_INDEPENDENCE: RoleProfile can be routed without embedding provider/account IDs in role', async () => {
    setupProvider('codex');
    setupProvider('gemini');
    const roleProfile = setupRoleProfile('role-coder', 'CODER');

    const req: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId: roleProfile.id,
    };

    const decision = await roleRouter.routeRole(req);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedProviderId).toBeDefined();
    expect(decision.selectedAccountId).toBeDefined();
    expect(decision.selectedResourceId).toBeDefined();
    expect(roleProfile).not.toHaveProperty('provider_id');
    expect(roleProfile).not.toHaveProperty('account_id');
  });

  // 2. Required capability removes ineligible resources
  it('2. REQUIRED_CAPABILITY_FILTER: Candidate lacking a required role capability is rejected', async () => {
    const { resources, adapter } = setupProvider('codex');
    adapter.setCapabilities(['TERMINAL']); // missing CODING
    for (const res of resources) {
      db.prepare('UPDATE provider_resources SET capabilities_json = ? WHERE id = ?').run(
        JSON.stringify(['TERMINAL']),
        res.id
      );
    }

    const roleProfile = setupRoleProfile('role-coder', 'CODER', ['CODING']);

    const req: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId: roleProfile.id,
    };

    const decision = await roleRouter.routeRole(req);
    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    expect(decision.candidateEvaluations[0].eligibility).toBe('INELIGIBLE');
    expect(decision.candidateEvaluations[0].rejectionReasons[0]).toContain(
      'Required capabilities [CODING] not satisfied'
    );
  });

  // 3. Explicit provider/account policy requirement cannot be bypassed
  it('3. EXPLICIT_REQUIRED_ACCOUNT_CANNOT_BE_BYPASSED: If account A is REQUIRED, account B cannot be selected merely because it scores higher', async () => {
    setupProvider('codex', 2);
    const roleProfile = setupRoleProfile('role-coder', 'CODER');

    const req: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId: roleProfile.id,
      requiredAccountId: 'acc-codex-2', // account 2 has lower priority (5 vs 10)
    };

    const decision = await roleRouter.routeRole(req);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedAccountId).toBe('acc-codex-2');
  });

  // 4. same_execution_forbidden rejects self-review
  it('4. SAME_EXECUTION_SELF_REVIEW_FORBIDDEN: Reviewer candidate matching prohibited execution provenance is rejected', async () => {
    setupProvider('codex', 2);
    const coderRole = setupRoleProfile('role-coder', 'CODER');
    const reviewerRole = setupRoleProfile('role-reviewer', 'REVIEWER');

    const now = new Date().toISOString();
    // Create coder assignment
    const coderAssignment: AgentAssignment = {
      id: 'assign-coder-001',
      project_id: projectId,
      task_id: taskId,
      attempt_id: 'attempt-001',
      role_profile_id: coderRole.id,
      agent_profile_id: null,
      selected_provider_id: 'codex',
      selected_account_id: 'acc-codex-1',
      selected_resource_id: 'res-codex-1',
      selected_worker_slot_id: null,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'COMPLETED',
      created_at: now,
      ended_at: now,
    };
    repo.createAgentAssignment(coderAssignment);

    // Create Separation Policy with same_execution_forbidden = true
    const sepPolicy: SeparationPolicy = {
      id: 'sep-strict-001',
      name: 'Strict Separation',
      same_execution_forbidden: true,
      same_session_forbidden: true,
      same_account_policy: 'ALLOW',
      same_provider_policy: 'ALLOW',
      same_model_policy: 'ALLOW',
      risk_threshold: 'HIGH',
      applicability: null,
      enabled: true,
      created_at: now,
      updated_at: now,
    };
    repo.createSeparationPolicy(sepPolicy);

    // Attempt to route reviewer under the same attempt_id
    const req: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      attemptId: 'attempt-001',
      roleProfileId: reviewerRole.id,
      separationPolicyId: sepPolicy.id,
      reviewedAssignmentId: coderAssignment.id,
    };

    const decision = await roleRouter.routeRole(req);
    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    expect(decision.candidateEvaluations[0].rejectionReasons[0]).toContain(
      'SAME_EXECUTION_FORBIDDEN: Self-review rejected.'
    );
  });

  // 5. reviewer with different execution can be eligible
  it('5. DIFFERENT_EXECUTION_REVIEW_ALLOWED: A distinct execution/session may review when other constraints pass', async () => {
    setupProvider('codex', 2);
    const coderRole = setupRoleProfile('role-coder', 'CODER');
    const reviewerRole = setupRoleProfile('role-reviewer', 'REVIEWER');

    const now = new Date().toISOString();
    const coderAssignment: AgentAssignment = {
      id: 'assign-coder-002',
      project_id: projectId,
      task_id: taskId,
      attempt_id: 'attempt-001',
      role_profile_id: coderRole.id,
      agent_profile_id: null,
      selected_provider_id: 'codex',
      selected_account_id: 'acc-codex-1',
      selected_resource_id: 'res-codex-1',
      selected_worker_slot_id: null,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'COMPLETED',
      created_at: now,
      ended_at: now,
    };
    repo.createAgentAssignment(coderAssignment);

    const sepPolicy: SeparationPolicy = {
      id: 'sep-diff-exec-001',
      name: 'Diff Exec Separation',
      same_execution_forbidden: true,
      same_session_forbidden: true,
      same_account_policy: 'ALLOW',
      same_provider_policy: 'ALLOW',
      same_model_policy: 'ALLOW',
      risk_threshold: 'HIGH',
      applicability: null,
      enabled: true,
      created_at: now,
      updated_at: now,
    };
    repo.createSeparationPolicy(sepPolicy);

    // Route reviewer under a distinct attempt_id
    const req: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      attemptId: 'attempt-002',
      roleProfileId: reviewerRole.id,
      separationPolicyId: sepPolicy.id,
      reviewedAssignmentId: coderAssignment.id,
    };

    const decision = await roleRouter.routeRole(req);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedProviderId).toBe('codex');
  });

  // 6. DIFFERENT_ACCOUNT_REQUIRED rejects same-account reviewer
  it('6. DIFFERENT_ACCOUNT_REQUIRED: Same account rejected; different account eligible', async () => {
    setupProvider('codex', 2);
    const coderRole = setupRoleProfile('role-coder', 'CODER');
    const reviewerRole = setupRoleProfile('role-reviewer', 'REVIEWER');

    const now = new Date().toISOString();
    const coderAssignment: AgentAssignment = {
      id: 'assign-coder-003',
      project_id: projectId,
      task_id: taskId,
      attempt_id: 'attempt-001',
      role_profile_id: coderRole.id,
      agent_profile_id: null,
      selected_provider_id: 'codex',
      selected_account_id: 'acc-codex-1',
      selected_resource_id: 'res-codex-1',
      selected_worker_slot_id: null,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'COMPLETED',
      created_at: now,
      ended_at: now,
    };
    repo.createAgentAssignment(coderAssignment);

    const sepPolicy: SeparationPolicy = {
      id: 'sep-diff-acc-001',
      name: 'Different Account Required',
      same_execution_forbidden: true,
      same_session_forbidden: true,
      same_account_policy: 'REQUIRE_DIFFERENT',
      same_provider_policy: 'ALLOW',
      same_model_policy: 'ALLOW',
      risk_threshold: 'HIGH',
      applicability: null,
      enabled: true,
      created_at: now,
      updated_at: now,
    };
    repo.createSeparationPolicy(sepPolicy);

    const req: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      attemptId: 'attempt-002',
      roleProfileId: reviewerRole.id,
      separationPolicyId: sepPolicy.id,
      reviewedAssignmentId: coderAssignment.id,
    };

    const decision = await roleRouter.routeRole(req);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedAccountId).toBe('acc-codex-2');
    const acc1Eval = decision.candidateEvaluations.find((c) => c.accountId === 'acc-codex-1');
    expect(acc1Eval?.eligibility).toBe('INELIGIBLE');
    expect(acc1Eval?.rejectionReasons[0]).toContain('DIFFERENT_ACCOUNT_REQUIRED');
  });

  // 7. DIFFERENT_ACCOUNT_PREFERRED prefers another account but falls back when policy allows
  it('7. DIFFERENT_ACCOUNT_PREFERRED: Prefers another account when available; falls back to same account when only candidate', async () => {
    setupProvider('codex', 2);
    const coderRole = setupRoleProfile('role-coder', 'CODER');
    const reviewerRole = setupRoleProfile('role-reviewer', 'REVIEWER');

    const now = new Date().toISOString();
    const coderAssignment: AgentAssignment = {
      id: 'assign-coder-004',
      project_id: projectId,
      task_id: taskId,
      attempt_id: 'attempt-001',
      role_profile_id: coderRole.id,
      agent_profile_id: null,
      selected_provider_id: 'codex',
      selected_account_id: 'acc-codex-1',
      selected_resource_id: 'res-codex-1',
      selected_worker_slot_id: null,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'COMPLETED',
      created_at: now,
      ended_at: now,
    };
    repo.createAgentAssignment(coderAssignment);

    const sepPolicy: SeparationPolicy = {
      id: 'sep-pref-acc-001',
      name: 'Different Account Preferred',
      same_execution_forbidden: true,
      same_session_forbidden: true,
      same_account_policy: 'PREFER_DIFFERENT',
      same_provider_policy: 'ALLOW',
      same_model_policy: 'ALLOW',
      risk_threshold: 'HIGH',
      applicability: null,
      enabled: true,
      created_at: now,
      updated_at: now,
    };
    repo.createSeparationPolicy(sepPolicy);

    // Case A: Both accounts available -> selects account 2 due to preference bonus
    const reqA: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      attemptId: 'attempt-002',
      roleProfileId: reviewerRole.id,
      separationPolicyId: sepPolicy.id,
      reviewedAssignmentId: coderAssignment.id,
    };

    const decisionA = await roleRouter.routeRole(reqA);
    expect(decisionA.outcome).toBe('SELECTED');
    expect(decisionA.selectedAccountId).toBe('acc-codex-2');

    // Case B: Only account 1 is available (account 2 disabled) -> falls back to account 1
    db.prepare('UPDATE provider_accounts SET enabled = 0 WHERE id = ?').run('acc-codex-2');

    const reqB: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      attemptId: 'attempt-003',
      roleProfileId: reviewerRole.id,
      separationPolicyId: sepPolicy.id,
      reviewedAssignmentId: coderAssignment.id,
    };

    const decisionB = await roleRouter.routeRole(reqB);
    expect(decisionB.outcome).toBe('SELECTED');
    expect(decisionB.selectedAccountId).toBe('acc-codex-1');
  });

  // 8. DIFFERENT_PROVIDER_REQUIRED rejects same provider
  it('8. DIFFERENT_PROVIDER_REQUIRED: Same provider rejected; different provider selected', async () => {
    setupProvider('codex');
    setupProvider('gemini');
    const coderRole = setupRoleProfile('role-coder', 'CODER');
    const reviewerRole = setupRoleProfile('role-reviewer', 'REVIEWER');

    const now = new Date().toISOString();
    const coderAssignment: AgentAssignment = {
      id: 'assign-coder-005',
      project_id: projectId,
      task_id: taskId,
      attempt_id: 'attempt-001',
      role_profile_id: coderRole.id,
      agent_profile_id: null,
      selected_provider_id: 'codex',
      selected_account_id: 'acc-codex-1',
      selected_resource_id: 'res-codex-1',
      selected_worker_slot_id: null,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'COMPLETED',
      created_at: now,
      ended_at: now,
    };
    repo.createAgentAssignment(coderAssignment);

    const sepPolicy: SeparationPolicy = {
      id: 'sep-diff-prov-001',
      name: 'Different Provider Required',
      same_execution_forbidden: true,
      same_session_forbidden: true,
      same_account_policy: 'ALLOW',
      same_provider_policy: 'REQUIRE_DIFFERENT',
      same_model_policy: 'ALLOW',
      risk_threshold: 'HIGH',
      applicability: null,
      enabled: true,
      created_at: now,
      updated_at: now,
    };
    repo.createSeparationPolicy(sepPolicy);

    const req: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      attemptId: 'attempt-002',
      roleProfileId: reviewerRole.id,
      separationPolicyId: sepPolicy.id,
      reviewedAssignmentId: coderAssignment.id,
    };

    const decision = await roleRouter.routeRole(req);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedProviderId).toBe('gemini');
  });

  // 9. DIFFERENT_PROVIDER_PREFERRED affects ranking without turning into a hard requirement
  it('9. DIFFERENT_PROVIDER_PREFERRED: Different provider ranks higher but fallback remains possible', async () => {
    setupProvider('codex');
    setupProvider('gemini');
    const coderRole = setupRoleProfile('role-coder', 'CODER');
    const reviewerRole = setupRoleProfile('role-reviewer', 'REVIEWER');

    const now = new Date().toISOString();
    const coderAssignment: AgentAssignment = {
      id: 'assign-coder-006',
      project_id: projectId,
      task_id: taskId,
      attempt_id: 'attempt-001',
      role_profile_id: coderRole.id,
      agent_profile_id: null,
      selected_provider_id: 'codex',
      selected_account_id: 'acc-codex-1',
      selected_resource_id: 'res-codex-1',
      selected_worker_slot_id: null,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'COMPLETED',
      created_at: now,
      ended_at: now,
    };
    repo.createAgentAssignment(coderAssignment);

    const sepPolicy: SeparationPolicy = {
      id: 'sep-pref-prov-001',
      name: 'Different Provider Preferred',
      same_execution_forbidden: true,
      same_session_forbidden: true,
      same_account_policy: 'ALLOW',
      same_provider_policy: 'PREFER_DIFFERENT',
      same_model_policy: 'ALLOW',
      risk_threshold: 'HIGH',
      applicability: null,
      enabled: true,
      created_at: now,
      updated_at: now,
    };
    repo.createSeparationPolicy(sepPolicy);

    const req: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      attemptId: 'attempt-002',
      roleProfileId: reviewerRole.id,
      separationPolicyId: sepPolicy.id,
      reviewedAssignmentId: coderAssignment.id,
    };

    const decision = await roleRouter.routeRole(req);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedProviderId).toBe('gemini');
  });

  // 10. DIFFERENT_MODEL_REQUIRED rejects same model
  it('10. DIFFERENT_MODEL_REQUIRED: Same model resource rejected where policy requires diversity', async () => {
    setupProvider('codex');
    const coderRole = setupRoleProfile('role-coder', 'CODER');
    const reviewerRole = setupRoleProfile('role-reviewer', 'REVIEWER');

    const now = new Date().toISOString();
    const coderAssignment: AgentAssignment = {
      id: 'assign-coder-007',
      project_id: projectId,
      task_id: taskId,
      attempt_id: 'attempt-001',
      role_profile_id: coderRole.id,
      agent_profile_id: null,
      selected_provider_id: 'codex',
      selected_account_id: 'acc-codex-1',
      selected_resource_id: 'res-codex-1',
      selected_worker_slot_id: null,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'COMPLETED',
      created_at: now,
      ended_at: now,
    };
    repo.createAgentAssignment(coderAssignment);

    const sepPolicy: SeparationPolicy = {
      id: 'sep-diff-mod-001',
      name: 'Different Model Required',
      same_execution_forbidden: true,
      same_session_forbidden: true,
      same_account_policy: 'ALLOW',
      same_provider_policy: 'ALLOW',
      same_model_policy: 'REQUIRE_DIFFERENT',
      risk_threshold: 'HIGH',
      applicability: null,
      enabled: true,
      created_at: now,
      updated_at: now,
    };
    repo.createSeparationPolicy(sepPolicy);

    const req: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      attemptId: 'attempt-002',
      roleProfileId: reviewerRole.id,
      separationPolicyId: sepPolicy.id,
      reviewedAssignmentId: coderAssignment.id,
    };

    const decision = await roleRouter.routeRole(req);
    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    expect(decision.candidateEvaluations[0].rejectionReasons[0]).toContain(
      'DIFFERENT_MODEL_REQUIRED'
    );
  });

  // 11. DIFFERENT_MODEL_PREFERRED affects ranking with fallback
  it('11. DIFFERENT_MODEL_PREFERRED: Different model ranks higher but fallback remains possible', async () => {
    setupProvider('codex');
    const now = new Date().toISOString();
    // Add second model resource attached to acc-codex-2
    const res2: ProviderResource = {
      id: 'res-codex-gpt4',
      provider_id: 'codex',
      provider_account_id: 'acc-codex-2',
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
    repo.createProviderResource(res2);

    const coderRole = setupRoleProfile('role-coder', 'CODER');
    const reviewerRole = setupRoleProfile('role-reviewer', 'REVIEWER');

    const coderAssignment: AgentAssignment = {
      id: 'assign-coder-008',
      project_id: projectId,
      task_id: taskId,
      attempt_id: 'attempt-001',
      role_profile_id: coderRole.id,
      agent_profile_id: null,
      selected_provider_id: 'codex',
      selected_account_id: 'acc-codex-1',
      selected_resource_id: 'res-codex-1',
      selected_worker_slot_id: null,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'COMPLETED',
      created_at: now,
      ended_at: now,
    };
    repo.createAgentAssignment(coderAssignment);

    const sepPolicy: SeparationPolicy = {
      id: 'sep-pref-mod-001',
      name: 'Different Model Preferred',
      same_execution_forbidden: true,
      same_session_forbidden: true,
      same_account_policy: 'ALLOW',
      same_provider_policy: 'ALLOW',
      same_model_policy: 'PREFER_DIFFERENT',
      risk_threshold: 'HIGH',
      applicability: null,
      enabled: true,
      created_at: now,
      updated_at: now,
    };
    repo.createSeparationPolicy(sepPolicy);

    const req: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      attemptId: 'attempt-002',
      roleProfileId: reviewerRole.id,
      separationPolicyId: sepPolicy.id,
      reviewedAssignmentId: coderAssignment.id,
    };

    const decision = await roleRouter.routeRole(req);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedResourceId).toBe('res-codex-gpt4');
  });

  // 12. deterministic routing for equal candidates
  it('12. DETERMINISTIC_SELECTION: Equivalent candidate set always selects the same stable candidate', async () => {
    setupProvider('codex', 3);
    const roleProfile = setupRoleProfile('role-coder', 'CODER');

    const req: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId: roleProfile.id,
    };

    const decision1 = await roleRouter.routeRole(req);
    const decision2 = await roleRouter.routeRole(req);
    const decision3 = await roleRouter.routeRole(req);

    expect(decision1.selectedAccountId).toBe(decision2.selectedAccountId);
    expect(decision2.selectedAccountId).toBe(decision3.selectedAccountId);
  });

  // 13. disabled/unhealthy candidate rejected
  it('13. DISABLED_OR_UNHEALTHY_REJECTED: Current provider-routing health eligibility remains respected', async () => {
    const { adapter } = setupProvider('codex', 1, 'LOCAL_CLI', 'OFFLINE');
    adapter.setHealth('OFFLINE');
    const roleProfile = setupRoleProfile('role-coder', 'CODER');

    const req: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId: roleProfile.id,
    };

    const decision = await roleRouter.routeRole(req);
    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    expect(decision.candidateEvaluations[0].eligibility).toBe('INELIGIBLE');
  });

  // 14. AUTH_ERROR candidate cannot silently fail over
  it('14. AUTH_ERROR_HARD_STOP_PRESERVED: R5E must not convert an existing AUTH_ERROR hard stop into silent alternate route selection', async () => {
    setupProvider('codex', 1, 'LOCAL_CLI', 'AUTH_ERROR');
    setupProvider('gemini', 1, 'LOCAL_CLI', 'AVAILABLE');
    const roleProfile = setupRoleProfile('role-coder', 'CODER');

    const req: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId: roleProfile.id,
      candidateRefs: [
        { accountId: 'acc-codex-1', resourceId: 'res-codex-1' },
        { accountId: 'acc-gemini-1', resourceId: 'res-gemini-1' },
      ],
    };

    const decision = await roleRouter.routeRole(req);
    expect(decision.outcome).toBe('NEEDS_OWNER');
    expect(decision.reason).toContain('AUTH_ERROR');
    expect(decision.selectedProviderId).toBeNull();
  });

  // 15. actual assignment records selected role/provider/account/resource separately
  it('15. ASSIGNMENT_BINDING_SEPARATE_IDENTITIES: Selected assignment binds role/provider/account/resource separately', async () => {
    setupProvider('codex', 2);
    const roleProfile = setupRoleProfile('role-coder', 'CODER');

    const req: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId: roleProfile.id,
      persistAssignment: true,
    };

    const decision = await roleRouter.routeRole(req);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedAssignmentId).toBeDefined();

    const assignment = repo.getAgentAssignment(decision.selectedAssignmentId!);
    expect(assignment).toBeDefined();
    expect(assignment!.role_profile_id).toBe(roleProfile.id);
    expect(assignment!.selected_provider_id).toBe('codex');
    expect(assignment!.selected_account_id).toBe(decision.selectedAccountId);
    expect(assignment!.selected_resource_id).toBe(decision.selectedResourceId);
    expect(assignment!.status).toBe('ASSIGNED');
  });

  // 16. Rejected candidate reason is durable/structured in decision evidence
  it('16. ROUTE_DECISION_AUDIT_REJECTION_REASONS: Rejected candidate reason is durable/structured in decision evidence', async () => {
    setupProvider('codex', 2);
    const roleProfile = setupRoleProfile('role-coder', 'CODER');

    const req: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId: roleProfile.id,
      requiredAccountId: 'acc-codex-1',
    };

    const decision = await roleRouter.routeRole(req);
    const rejectedCand = decision.candidateEvaluations.find((c) => c.accountId === 'acc-codex-2');
    expect(rejectedCand).toBeDefined();
    expect(rejectedCand!.eligibility).toBe('INELIGIBLE');
    expect(rejectedCand!.rejectionReasons[0]).toContain('REQUIRED_ACCOUNT_MISMATCH');
  });

  // 17. requested/preferred vs selected difference is auditable
  it('17. REQUESTED_PREFERRED_SELECTED_DIFFERENCE_AUDITABLE: When preference cannot be honored, requested and selected values remain distinguishable in audit result', async () => {
    setupProvider('codex', 1);
    const roleProfile = setupRoleProfile('role-coder', 'CODER');

    const req: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId: roleProfile.id,
      preferredProviderId: 'gemini', // preferred gemini, but only codex is available
    };

    const decision = await roleRouter.routeRole(req);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.requestedConstraints.preferredProviderId).toBe('gemini');
    expect(decision.selectedProviderId).toBe('codex');
  });

  // 18. Hard constraints are never weakened automatically
  it('18. NO_ELIGIBLE_CANDIDATE_FAILS_CLOSED: Hard constraints are never weakened automatically', async () => {
    setupProvider('codex', 1);
    const roleProfile = setupRoleProfile('role-coder', 'CODER');

    const req: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId: roleProfile.id,
      requiredProviderId: 'gemini', // non-existent required provider
    };

    const decision = await roleRouter.routeRole(req);
    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    expect(decision.selectedProviderId).toBeNull();
  });

  // 19. legacy routing compatibility remains intact where R5E is not explicitly engaged
  it('19. LEGACY_PROVIDER_ROUTING_COMPATIBILITY: Existing ProviderRoutingService behavior remains unchanged', async () => {
    setupProvider('codex', 1);
    const decision = await legacyRouter.route({
      projectId,
      taskId,
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-codex-1'],
      allowManualBridge: false,
    });

    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedResourceId).toBe('res-codex-1');
    expect(decision.selectedProviderId).toBe('codex');
  });
});
