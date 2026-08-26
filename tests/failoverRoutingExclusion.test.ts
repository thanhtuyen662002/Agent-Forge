import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ProviderRegistry } from '../src/core/adapters/ProviderRegistry';
import { ProviderAdapter, QuotaSnapshotInfo } from '../src/core/adapters/ProviderAdapter';
import { EventService } from '../src/core/services/EventService';
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

describe('R5H3 — Routing Exclusion & Audit Contract', () => {
  let db: Database.Database;
  let repo: Repository;
  let registry: ProviderRegistry;
  let eventService: EventService;
  let roleRouter: RoleAwareRoutingService;

  const projectId = 'proj-r5h3-001';
  const taskId = 'task-r5h3-001';
  const roleProfileId = 'role-coder-r5h3';

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    registry = new ProviderRegistry();
    eventService = new EventService(repo);
    roleRouter = new RoleAwareRoutingService(repo, registry, eventService);

    const now = new Date().toISOString();

    // 1. Base Project & Task
    const project: Project = {
      id: projectId,
      name: 'R5H3 Test Project',
      description: 'Project for testing router exclusion contract',
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
      title: 'R5H3 Test Task',
      description: 'Task for testing router exclusions',
      state: 'APPROVED',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'HIGH',
      assigned_agent_id: null,
      revision_count: 1,
      max_revisions: 3,
      base_sha: 'de9e77b14b730066b9ef70b386db6b50327683f2',
      current_sha: 'de9e77b14b730066b9ef70b386db6b50327683f2',
      progress_cache_percent: 0.0,
      progress_computed_at: null,
      acceptance_criteria: ['Exclusions work deterministically'],
      constraints: ['Strict bounded reasons'],
      created_at: now,
      updated_at: now,
    };
    repo.createTask(task);

    // 2. RoleProfile for Coder
    const roleProfile: RoleProfile = {
      id: roleProfileId,
      role: 'CODER',
      display_name: 'Primary Coder Role',
      required_capabilities: ['CODING', 'FILESYSTEM_EDIT'],
      preferred_capabilities: ['TEST_EXECUTION'],
      authority_scope: null,
      permissions: ['read', 'write'],
      output_protocol: 'coder.v1',
      enabled: true,
      created_at: now,
      updated_at: now,
    };
    repo.createRoleProfile(roleProfile);

    // 3. Setup Providers: OpenAI, Anthropic, Gemini
    const provOpenAI: Provider = {
      id: 'prov-openai',
      name: 'OpenAI Provider',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: now,
    };
    const provAnthropic: Provider = {
      id: 'prov-anthropic',
      name: 'Anthropic Provider',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: now,
    };
    const provGemini: Provider = {
      id: 'prov-gemini',
      name: 'Gemini Provider',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: now,
    };
    repo.createProvider(provOpenAI);
    repo.createProvider(provAnthropic);
    repo.createProvider(provGemini);

    const adapterOpenAI = new MockProviderAdapter('prov-openai', 'OpenAI');
    const adapterAnthropic = new MockProviderAdapter('prov-anthropic', 'Anthropic');
    const adapterGemini = new MockProviderAdapter('prov-gemini', 'Gemini');
    registry.register(adapterOpenAI);
    registry.register(adapterAnthropic);
    registry.register(adapterGemini);

    // 4. Setup ProviderAccounts
    // acc-openai-1: priority 10 (Highest initial preference)
    const accOpenAI1: ProviderAccount = {
      id: 'acc-openai-1',
      provider_id: 'prov-openai',
      label: 'OpenAI Main Account',
      auth_mode: 'NATIVE_PROFILE',
      credential_ref: null,
      profile_ref: 'native-profile://openai/p1',
      health_status: 'AVAILABLE',
      cooldown_until: null,
      last_failure_code: null,
      last_failure_at: null,
      last_success_at: null,
      concurrency_limit: 2,
      priority: 10,
      enabled: true,
      created_at: now,
      updated_at: now,
    };
    // acc-openai-2: priority 5
    const accOpenAI2: ProviderAccount = {
      id: 'acc-openai-2',
      provider_id: 'prov-openai',
      label: 'OpenAI Backup Account',
      auth_mode: 'NATIVE_PROFILE',
      credential_ref: null,
      profile_ref: 'native-profile://openai/p2',
      health_status: 'AVAILABLE',
      cooldown_until: null,
      last_failure_code: null,
      last_failure_at: null,
      last_success_at: null,
      concurrency_limit: 2,
      priority: 5,
      enabled: true,
      created_at: now,
      updated_at: now,
    };
    // acc-anthropic-1: priority 8
    const accAnthropic1: ProviderAccount = {
      id: 'acc-anthropic-1',
      provider_id: 'prov-anthropic',
      label: 'Anthropic Main Account',
      auth_mode: 'NATIVE_PROFILE',
      credential_ref: null,
      profile_ref: 'native-profile://anthropic/p1',
      health_status: 'AVAILABLE',
      cooldown_until: null,
      last_failure_code: null,
      last_failure_at: null,
      last_success_at: null,
      concurrency_limit: 2,
      priority: 8,
      enabled: true,
      created_at: now,
      updated_at: now,
    };
    // acc-gemini-1: priority 2
    const accGemini1: ProviderAccount = {
      id: 'acc-gemini-1',
      provider_id: 'prov-gemini',
      label: 'Gemini Main Account',
      auth_mode: 'NATIVE_PROFILE',
      credential_ref: null,
      profile_ref: 'native-profile://gemini/p1',
      health_status: 'AVAILABLE',
      cooldown_until: null,
      last_failure_code: null,
      last_failure_at: null,
      last_success_at: null,
      concurrency_limit: 2,
      priority: 2,
      enabled: true,
      created_at: now,
      updated_at: now,
    };
    repo.createProviderAccount(accOpenAI1);
    repo.createProviderAccount(accOpenAI2);
    repo.createProviderAccount(accAnthropic1);
    repo.createProviderAccount(accGemini1);

    // 5. Setup ProviderResources
    const resOpenAI1: ProviderResource = {
      id: 'res-openai-gpt4-1',
      provider_id: 'prov-openai',
      provider_account_id: 'acc-openai-1',
      model_name: 'gpt-4o',
      health_status: 'AVAILABLE',
      last_health_check: null,
      capabilities: ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION'],
      enabled: true,
      total_quota: 1000,
      remaining_quota: 1000,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'PROVIDER_REPORTED',
      quota_confidence: 1.0,
    };
    const resOpenAI2: ProviderResource = {
      id: 'res-openai-gpt4-2',
      provider_id: 'prov-openai',
      provider_account_id: 'acc-openai-2',
      model_name: 'gpt-4o',
      health_status: 'AVAILABLE',
      last_health_check: null,
      capabilities: ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION'],
      enabled: true,
      total_quota: 1000,
      remaining_quota: 1000,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'PROVIDER_REPORTED',
      quota_confidence: 1.0,
    };
    const resAnthropic1: ProviderResource = {
      id: 'res-claude-sonnet',
      provider_id: 'prov-anthropic',
      provider_account_id: 'acc-anthropic-1',
      model_name: 'claude-3-5-sonnet',
      health_status: 'AVAILABLE',
      last_health_check: null,
      capabilities: ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION'],
      enabled: true,
      total_quota: 1000,
      remaining_quota: 1000,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'PROVIDER_REPORTED',
      quota_confidence: 1.0,
    };
    const resGemini1: ProviderResource = {
      id: 'res-gemini-pro',
      provider_id: 'prov-gemini',
      provider_account_id: 'acc-gemini-1',
      model_name: 'gemini-1.5-pro',
      health_status: 'AVAILABLE',
      last_health_check: null,
      capabilities: ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION'],
      enabled: true,
      total_quota: 1000,
      remaining_quota: 1000,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'PROVIDER_REPORTED',
      quota_confidence: 1.0,
    };
    repo.createProviderResource(resOpenAI1);
    repo.createProviderResource(resOpenAI2);
    repo.createProviderResource(resAnthropic1);
    repo.createProviderResource(resGemini1);
  });

  afterEach(() => {
    db.close();
  });

  it('1. NO exclusions => existing deterministic routing behavior unchanged', async () => {
    const request: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId,
    };

    const decision = await roleRouter.routeRole(request);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedAccountId).toBe('acc-openai-1');
    expect(decision.selectedResourceId).toBe('res-openai-gpt4-1');
    expect(decision.selectedProviderId).toBe('prov-openai');
    expect(decision.requestedConstraints.excludedCandidateIds).toEqual([]);
    expect(decision.requestedConstraints.excludedAccountIds).toEqual([]);
    expect(decision.requestedConstraints.excludedProviderIds).toEqual([]);
  });

  it('2. excludedCandidateIds contains highest-ranked candidate => candidate remains in evaluations as INELIGIBLE => another eligible candidate wins', async () => {
    const request: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId,
      excludedCandidateIds: ['acc-openai-1:res-openai-gpt4-1'],
    };

    const decision = await roleRouter.routeRole(request);
    expect(decision.outcome).toBe('SELECTED');
    // acc-anthropic-1 has priority 8 vs acc-openai-2 priority 5
    expect(decision.selectedAccountId).toBe('acc-anthropic-1');
    expect(decision.selectedResourceId).toBe('res-claude-sonnet');
    expect(decision.selectedProviderId).toBe('prov-anthropic');

    const excludedEval = decision.candidateEvaluations.find(
      (c) => c.candidateId === 'acc-openai-1:res-openai-gpt4-1'
    );
    expect(excludedEval).toBeDefined();
    expect(excludedEval?.eligibility).toBe('INELIGIBLE');
    expect(excludedEval?.preferenceScore).toBe(0);
    expect(excludedEval?.rejectionReasons).toContain('FAILOVER_EXCLUDED_CANDIDATE');
  });

  it('3. excludedAccountIds => every candidate under that account is ineligible', async () => {
    const request: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId,
      excludedAccountIds: ['acc-openai-1', 'acc-openai-2'],
    };

    const decision = await roleRouter.routeRole(request);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedAccountId).toBe('acc-anthropic-1');
    expect(decision.selectedProviderId).toBe('prov-anthropic');

    const eval1 = decision.candidateEvaluations.find(
      (c) => c.candidateId === 'acc-openai-1:res-openai-gpt4-1'
    );
    const eval2 = decision.candidateEvaluations.find(
      (c) => c.candidateId === 'acc-openai-2:res-openai-gpt4-2'
    );
    expect(eval1?.eligibility).toBe('INELIGIBLE');
    expect(eval1?.rejectionReasons).toContain('FAILOVER_EXCLUDED_ACCOUNT');
    expect(eval2?.eligibility).toBe('INELIGIBLE');
    expect(eval2?.rejectionReasons).toContain('FAILOVER_EXCLUDED_ACCOUNT');
  });

  it('4. excludedProviderIds => every candidate under that provider is ineligible', async () => {
    const request: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId,
      excludedProviderIds: ['prov-openai', 'prov-anthropic'],
    };

    const decision = await roleRouter.routeRole(request);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedAccountId).toBe('acc-gemini-1');
    expect(decision.selectedResourceId).toBe('res-gemini-pro');
    expect(decision.selectedProviderId).toBe('prov-gemini');

    const openAIEval1 = decision.candidateEvaluations.find((c) => c.candidateId === 'acc-openai-1:res-openai-gpt4-1');
    const openAIEval2 = decision.candidateEvaluations.find((c) => c.candidateId === 'acc-openai-2:res-openai-gpt4-2');
    const anthropicEval = decision.candidateEvaluations.find((c) => c.providerId === 'prov-anthropic');
    expect(openAIEval1?.eligibility).toBe('INELIGIBLE');
    expect(openAIEval1?.rejectionReasons).toContain('FAILOVER_EXCLUDED_PROVIDER');
    expect(openAIEval2?.eligibility).toBe('INELIGIBLE');
    expect(openAIEval2?.rejectionReasons).toContain('FAILOVER_EXCLUDED_PROVIDER');
    expect(anthropicEval?.eligibility).toBe('INELIGIBLE');
    expect(anthropicEval?.rejectionReasons).toContain('FAILOVER_EXCLUDED_PROVIDER');
  });

  it('5. candidate matching multiple exclusions => distinct bounded reason codes without duplicates in stable ordering', async () => {
    const request: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId,
      excludedCandidateIds: ['acc-openai-1:res-openai-gpt4-1'],
      excludedAccountIds: ['acc-openai-1'],
      excludedProviderIds: ['prov-openai'],
    };

    const decision = await roleRouter.routeRole(request);
    const evalItem = decision.candidateEvaluations.find(
      (c) => c.candidateId === 'acc-openai-1:res-openai-gpt4-1'
    );
    expect(evalItem).toBeDefined();
    expect(evalItem?.eligibility).toBe('INELIGIBLE');
    expect(evalItem?.rejectionReasons).toEqual([
      'FAILOVER_EXCLUDED_CANDIDATE',
      'FAILOVER_EXCLUDED_ACCOUNT',
      'FAILOVER_EXCLUDED_PROVIDER',
    ]);
  });

  it('6. all candidates excluded => NO_ELIGIBLE_PROVIDER and no assignment created', async () => {
    const request: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId,
      excludedProviderIds: ['prov-openai', 'prov-anthropic', 'prov-gemini'],
      persistAssignment: true,
    };

    const decision = await roleRouter.routeRole(request);
    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    expect(decision.selectedAccountId).toBeNull();
    expect(decision.selectedResourceId).toBeNull();
    expect(decision.selectedProviderId).toBeNull();
    expect(decision.selectedAssignmentId).toBeNull();

    const assignments = repo.getAgentAssignmentsByTask(taskId);
    expect(assignments.length).toBe(0);
    expect(decision.candidateEvaluations.length).toBeGreaterThan(0);
  });

  it('7. persistAssignment=true => assignment is created only for non-excluded winner', async () => {
    const request: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId,
      excludedCandidateIds: ['acc-openai-1:res-openai-gpt4-1'],
      persistAssignment: true,
    };

    const decision = await roleRouter.routeRole(request);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedAssignmentId).not.toBeNull();

    const assignment = repo.getAgentAssignment(decision.selectedAssignmentId!);
    expect(assignment).toBeDefined();
    expect(assignment?.selected_account_id).toBe('acc-anthropic-1');
    expect(assignment?.selected_resource_id).toBe('res-claude-sonnet');
    expect(assignment?.selected_provider_id).toBe('prov-anthropic');
  });

  it('8. requiredProviderId / requiredAccountId cannot override explicit exclusion', async () => {
    const request: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId,
      requiredProviderId: 'prov-openai',
      requiredAccountId: 'acc-openai-1',
      excludedCandidateIds: ['acc-openai-1:res-openai-gpt4-1'],
    };

    const decision = await roleRouter.routeRole(request);
    // acc-openai-1:res-openai-gpt4-1 is excluded, and no other openai-1 resource exists, so routing must fail
    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    expect(decision.selectedAccountId).toBeNull();
  });

  it('9. preferred provider/account/resource cannot override exclusion', async () => {
    const request: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId,
      preferredProviderId: 'prov-openai',
      preferredAccountId: 'acc-openai-1',
      preferredResourceId: 'res-openai-gpt4-1',
      excludedCandidateIds: ['acc-openai-1:res-openai-gpt4-1'],
    };

    const decision = await roleRouter.routeRole(request);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedAccountId).not.toBe('acc-openai-1');
    expect(decision.selectedAccountId).toBe('acc-openai-2');
    expect(decision.selectedResourceId).toBe('res-openai-gpt4-2');
  });

  it('10. remaining eligible candidates retain stable deterministic tie-break', async () => {
    // Exclude OpenAI-1 and Anthropic-1. Remaining: OpenAI-2 (priority 5), Gemini-1 (priority 2).
    const request: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId,
      excludedCandidateIds: ['acc-openai-1:res-openai-gpt4-1', 'acc-anthropic-1:res-claude-sonnet'],
    };

    const decision1 = await roleRouter.routeRole(request);
    const decision2 = await roleRouter.routeRole(request);

    expect(decision1.outcome).toBe('SELECTED');
    expect(decision1.selectedAccountId).toBe('acc-openai-2');
    expect(decision2.selectedAccountId).toBe('acc-openai-2');
    expect(decision1.selectedResourceId).toBe(decision2.selectedResourceId);
  });

  it('11. active cooldown remains honored alongside exclusions', async () => {
    // Set active cooldown on acc-anthropic-1
    const futureTime = new Date(Date.now() + 60000).toISOString();
    repo.updateProviderAccountHealth('acc-anthropic-1', 'RATE_LIMITED', futureTime, 'RATE_LIMITED');

    // Exclude acc-openai-1
    const request: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId,
      excludedCandidateIds: ['acc-openai-1:res-openai-gpt4-1'],
    };

    const decision = await roleRouter.routeRole(request);
    expect(decision.outcome).toBe('SELECTED');
    // acc-anthropic-1 is in active cooldown, so acc-openai-2 (priority 5) wins!
    expect(decision.selectedAccountId).toBe('acc-openai-2');

    const anthropicEval = decision.candidateEvaluations.find(
      (c) => c.candidateId === 'acc-anthropic-1:res-claude-sonnet'
    );
    expect(anthropicEval?.eligibility).toBe('INELIGIBLE');
    expect(anthropicEval?.rejectionReasons.some((r) => r.includes('active cooldown'))).toBe(true);
  });

  it('12. non-excluded automated AUTH_ERROR remains NEEDS_OWNER', async () => {
    const anthropicAdapter = registry.resolve('prov-anthropic') as MockProviderAdapter;
    anthropicAdapter.setHealth('AUTH_ERROR');

    // Exclude OpenAI main & backup
    const request: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId,
      excludedCandidateIds: ['acc-openai-1:res-openai-gpt4-1', 'acc-openai-2:res-openai-gpt4-2'],
    };

    const decision = await roleRouter.routeRole(request);
    expect(decision.outcome).toBe('NEEDS_OWNER');
    expect(decision.reason).toContain('AUTH_ERROR');
  });

  it('13. unknown exclusion ID remains in requestedConstraints with zero applied match => otherwise normal routing', async () => {
    const request: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId,
      excludedCandidateIds: ['acc-ghost:res-ghost'],
      excludedAccountIds: ['acc-nonexistent'],
      excludedProviderIds: ['prov-nonexistent'],
    };

    const decision = await roleRouter.routeRole(request);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedAccountId).toBe('acc-openai-1');
    expect(decision.requestedConstraints.excludedCandidateIds).toEqual(['acc-ghost:res-ghost']);
    expect(decision.requestedConstraints.excludedAccountIds).toEqual(['acc-nonexistent']);
    expect(decision.requestedConstraints.excludedProviderIds).toEqual(['prov-nonexistent']);

    const events = eventService.getEvents(projectId);
    const routingEvent = events.find((e) => e.type === 'ROLE_AWARE_ROUTING_DECISION');
    const payload = routingEvent?.structured_payload as any;
    expect(payload.appliedExclusions).toEqual([]);
  });

  it('14. ROLE_AWARE_ROUTING_DECISION durable event contains requested exclusion sets', async () => {
    const request: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId,
      excludedCandidateIds: ['acc-openai-1:res-openai-gpt4-1'],
      excludedAccountIds: ['acc-openai-2'],
      excludedProviderIds: ['prov-gemini'],
    };

    await roleRouter.routeRole(request);

    const events = eventService.getEvents(projectId);
    const routingEvent = events.find((e) => e.type === 'ROLE_AWARE_ROUTING_DECISION');
    expect(routingEvent).toBeDefined();

    const payload = routingEvent?.structured_payload as any;
    expect(payload.requestedConstraints).toBeDefined();
    expect(payload.requestedConstraints.excludedCandidateIds).toEqual(['acc-openai-1:res-openai-gpt4-1']);
    expect(payload.requestedConstraints.excludedAccountIds).toEqual(['acc-openai-2']);
    expect(payload.requestedConstraints.excludedProviderIds).toEqual(['prov-gemini']);
  });

  it('15. ROLE_AWARE_ROUTING_DECISION durable event contains bounded appliedExclusions for matched candidates', async () => {
    const request: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId,
      excludedCandidateIds: ['acc-openai-1:res-openai-gpt4-1'],
      excludedAccountIds: ['acc-anthropic-1'],
    };

    await roleRouter.routeRole(request);

    const events = eventService.getEvents(projectId);
    const routingEvent = events.find((e) => e.type === 'ROLE_AWARE_ROUTING_DECISION');
    const payload = routingEvent?.structured_payload as any;

    expect(payload.appliedExclusions).toBeDefined();
    expect(Array.isArray(payload.appliedExclusions)).toBe(true);

    const candidateMatch = payload.appliedExclusions.find(
      (a: any) => a.candidateId === 'acc-openai-1:res-openai-gpt4-1'
    );
    expect(candidateMatch).toBeDefined();
    expect(candidateMatch.accountId).toBe('acc-openai-1');
    expect(candidateMatch.providerId).toBe('prov-openai');
    expect(candidateMatch.resourceId).toBe('res-openai-gpt4-1');
    expect(candidateMatch.reasonCodes).toEqual(['FAILOVER_EXCLUDED_CANDIDATE']);

    const accountMatch = payload.appliedExclusions.find(
      (a: any) => a.candidateId === 'acc-anthropic-1:res-claude-sonnet'
    );
    expect(accountMatch).toBeDefined();
    expect(accountMatch.reasonCodes).toEqual(['FAILOVER_EXCLUDED_ACCOUNT']);
  });

  it('16. durable appliedExclusions contains no raw provider response / credential / profile / token data', async () => {
    const request: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId,
      excludedCandidateIds: ['acc-openai-1:res-openai-gpt4-1'],
    };

    await roleRouter.routeRole(request);

    const events = eventService.getEvents(projectId);
    const routingEvent = events.find((e) => e.type === 'ROLE_AWARE_ROUTING_DECISION');
    const payload = routingEvent?.structured_payload as any;

    for (const applied of payload.appliedExclusions) {
      const keys = Object.keys(applied);
      expect(keys.sort()).toEqual(['accountId', 'candidateId', 'providerId', 'reasonCodes', 'resourceId'].sort());
      for (const code of applied.reasonCodes) {
        expect(['FAILOVER_EXCLUDED_CANDIDATE', 'FAILOVER_EXCLUDED_ACCOUNT', 'FAILOVER_EXCLUDED_PROVIDER']).toContain(code);
      }
    }
  });

  it('17. excluded candidate remains visible in candidateEvaluations', async () => {
    const request: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId,
      excludedCandidateIds: ['acc-openai-1:res-openai-gpt4-1'],
    };

    const decision = await roleRouter.routeRole(request);
    const candidateEval = decision.candidateEvaluations.find(
      (c) => c.candidateId === 'acc-openai-1:res-openai-gpt4-1'
    );

    expect(candidateEval).toBeDefined();
    expect(candidateEval?.candidateId).toBe('acc-openai-1:res-openai-gpt4-1');
    expect(candidateEval?.accountLabel).toBe('OpenAI Main Account');
    expect(candidateEval?.modelName).toBe('gpt-4o');
    expect(candidateEval?.eligibility).toBe('INELIGIBLE');
    expect(candidateEval?.preferenceScore).toBe(0);
  });

  it('18. candidateRefs existing behavior is unchanged', async () => {
    const request: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId,
      candidateRefs: [
        { accountId: 'acc-anthropic-1', resourceId: 'res-claude-sonnet' },
        { accountId: 'acc-gemini-1', resourceId: 'res-gemini-pro' },
      ],
    };

    const decision = await roleRouter.routeRole(request);
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedAccountId).toBe('acc-anthropic-1');
    expect(decision.candidateEvaluations.length).toBe(2);
  });

  it('19. rejects invalid/malformed exclusion arrays and elements', async () => {
    await expect(
      roleRouter.routeRole({
        projectId,
        taskId,
        roleProfileId,
        excludedCandidateIds: 'not-an-array' as any,
      })
    ).rejects.toThrow('INVALID_ROUTING_REQUEST: excludedCandidateIds must be an array of strings');

    await expect(
      roleRouter.routeRole({
        projectId,
        taskId,
        roleProfileId,
        excludedCandidateIds: [''],
      })
    ).rejects.toThrow('INVALID_ROUTING_REQUEST: excludedCandidateIds elements must be non-empty');

    await expect(
      roleRouter.routeRole({
        projectId,
        taskId,
        roleProfileId,
        excludedAccountIds: ['  acc-with-whitespace  '],
      })
    ).rejects.toThrow('INVALID_ROUTING_REQUEST: excludedAccountIds elements must be non-empty canonical');
  });

  it('20. canonicalizes duplicate exclusion IDs into unique sets', async () => {
    const request: RoleAwareRoutingRequest = {
      projectId,
      taskId,
      roleProfileId,
      excludedCandidateIds: ['acc-openai-1:res-openai-gpt4-1', 'acc-openai-1:res-openai-gpt4-1'],
    };

    const decision = await roleRouter.routeRole(request);
    expect(decision.requestedConstraints.excludedCandidateIds).toEqual(['acc-openai-1:res-openai-gpt4-1']);
  });
});
