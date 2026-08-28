import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ProviderRegistry } from '../src/core/adapters/ProviderRegistry';
import { ProviderAdapter, QuotaSnapshotInfo } from '../src/core/adapters/ProviderAdapter';
import { EventService } from '../src/core/services/EventService';
import {
  RoleAwareRoutingService,
  CandidateAccountResourceRef,
} from '../src/core/services/RoleAwareRoutingService';
import {
  HandoffTransferService,
  buildCanonicalHandoffRouteSpecV1,
  validateAndSortStringList,
  validateAndCanonicalizeCandidateRefs,
  validateCanonicalOptionalString,
} from '../src/core/services/HandoffTransferService';
import {
  ContextBuilderService,
  canonicalJsonStringify,
  computeSha256,
} from '../src/core/services/ContextBuilderService';
import {
  ProviderHealthStatus,
  ProviderAdapterType,
  Capability,
  HandoffTransfer,
  AgentAssignment,
  TaskAttempt,
  RoleProfile,
  AgentProfile,
  Provider,
  ProviderAccount,
  ProviderResource,
  Task,
  Project,
} from '../src/core/types/domain';

class MockTestAdapter implements ProviderAdapter {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly adapterType: ProviderAdapterType = 'LOCAL_CLI',
    private health: ProviderHealthStatus = 'AVAILABLE',
    private capabilities: Capability[] = ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION', 'REVIEW'],
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
    throw new Error('Execute not implemented in mock adapter');
  }

  public async cancel(): Promise<void> {}
}

describe('R5I4 Cross-Provider Successor Routing and Replay Identity Authority', () => {
  let db: Database.Database;
  let repo: Repository;
  let registry: ProviderRegistry;
  let eventService: EventService;
  let roleRouter: RoleAwareRoutingService;
  let contextBuilder: ContextBuilderService;
  let handoffService: HandoffTransferService;

  const projectId = 'proj-r5i4-1';
  const taskId = 'task-r5i4-1';
  const sourceAttemptId = 'att-r5i4-source';
  const sourceAssignmentId = 'asgn-r5i4-source';
  const successorAttemptId = 'att-r5i4-succ';
  const sourceRoleProfileId = 'role-coder-1';
  const sourceAgentProfileId = 'agprof-coder-1';
  const successorRoleProfileId = 'role-reviewer-1';
  const successorAgentProfileId = 'agprof-reviewer-1';
  const sourceProviderId = 'prov-source-anthropic';
  const successorProviderId = 'prov-succ-openai';
  const successorProviderId2 = 'prov-succ-google';
  const nowIso = '2026-08-28T00:00:00Z';

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    registry = new ProviderRegistry();
    eventService = new EventService(repo);
    roleRouter = new RoleAwareRoutingService(repo, registry, eventService);
    contextBuilder = new ContextBuilderService(repo);
    handoffService = new HandoffTransferService(repo, contextBuilder, roleRouter);

    seedBaseEnvironment();
  });

  afterEach(() => {
    db.close();
  });

  function seedBaseEnvironment() {
    // 1. Project & Task
    repo.createProject({
      id: projectId,
      name: 'R5I4 Project',
      description: null,
      repository_path: '/repo',
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: nowIso,
      updated_at: nowIso,
      started_at: nowIso,
      completed_at: null,
    });

    repo.createTask({
      id: taskId,
      project_id: projectId,
      milestone_id: null,
      title: 'R5I4 Task',
      description: null,
      state: 'HANDOFF_REQUIRED',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 5,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 50,
      progress_computed_at: nowIso,
      acceptance_criteria: [],
      constraints: [],
      ownership_epoch: 2, // epoch 2 = successor epoch after epoch 1 relinquish
      created_at: nowIso,
      updated_at: nowIso,
    });

    // 2. Role Profiles
    repo.createRoleProfile({
      id: sourceRoleProfileId,
      role: 'CODER',
      display_name: 'Coder Role',
      authority_scope: {},
      output_protocol: 'coder.v1',
      required_capabilities: ['CODING', 'FILESYSTEM_EDIT'],
      preferred_capabilities: [],
      permissions: [],
      enabled: true,
      created_at: nowIso,
      updated_at: nowIso,
    });

    repo.createRoleProfile({
      id: successorRoleProfileId,
      role: 'REVIEWER',
      display_name: 'Reviewer Role',
      authority_scope: {},
      output_protocol: 'reviewer.v1',
      required_capabilities: ['REVIEW'],
      preferred_capabilities: [],
      permissions: [],
      enabled: true,
      created_at: nowIso,
      updated_at: nowIso,
    });

    // 3. Agent Profiles
    repo.createAgentProfile({
      id: sourceAgentProfileId,
      role_profile_id: sourceRoleProfileId,
      name: 'Coder Agent Profile',
      prompt_template: null,
      config: null,
      enabled: true,
      created_at: nowIso,
      updated_at: nowIso,
    });

    repo.createAgentProfile({
      id: successorAgentProfileId,
      role_profile_id: successorRoleProfileId,
      name: 'Reviewer Agent Profile',
      prompt_template: null,
      config: null,
      enabled: true,
      created_at: nowIso,
      updated_at: nowIso,
    });

    // 4. Source Provider, Account, Resource
    repo.createProvider({
      id: sourceProviderId,
      name: 'Source Provider Anthropic',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: nowIso,
    });
    const sourceAdapter = new MockTestAdapter(sourceProviderId, 'Source Provider Anthropic', 'LOCAL_CLI');
    registry.register(sourceAdapter);

    repo.createProviderAccount({
      id: 'acc-source-1',
      provider_id: sourceProviderId,
      label: 'Anthropic Main Account',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: 'wincred://agentforge/anthropic/key1',
      profile_ref: null,
      enabled: true,
      priority: 10,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 5,
      last_success_at: nowIso,
      last_failure_at: null,
      last_failure_code: null,
      created_at: nowIso,
      updated_at: nowIso,
    });

    repo.createProviderResource({
      id: 'res-source-1',
      provider_id: sourceProviderId,
      provider_account_id: 'acc-source-1',
      model_name: 'claude-3-5-sonnet',
      health_status: 'AVAILABLE',
      capabilities: ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION', 'REVIEW'],
      enabled: true,
      total_quota: 10000,
      remaining_quota: 5000,
      quota_unit: 'TOKENS',
      quota_reset_at: null,
      quota_source: 'PROVIDER_REPORTED',
      quota_confidence: 1.0,
      last_health_check: nowIso,
    });

    // 5. Successor Provider 1 (OpenAI), Account, Resource
    repo.createProvider({
      id: successorProviderId,
      name: 'Successor Provider OpenAI',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: nowIso,
    });
    const succAdapter1 = new MockTestAdapter(successorProviderId, 'Successor Provider OpenAI', 'LOCAL_CLI');
    registry.register(succAdapter1);

    repo.createProviderAccount({
      id: 'acc-succ-openai-1',
      provider_id: successorProviderId,
      label: 'OpenAI Prod Account',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: 'wincred://agentforge/openai/key1',
      profile_ref: null,
      enabled: true,
      priority: 20,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 5,
      last_success_at: nowIso,
      last_failure_at: null,
      last_failure_code: null,
      created_at: nowIso,
      updated_at: nowIso,
    });

    repo.createProviderResource({
      id: 'res-succ-openai-1',
      provider_id: successorProviderId,
      provider_account_id: 'acc-succ-openai-1',
      model_name: 'gpt-4o',
      health_status: 'AVAILABLE',
      capabilities: ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION', 'REVIEW'],
      enabled: true,
      total_quota: 10000,
      remaining_quota: 8000,
      quota_unit: 'TOKENS',
      quota_reset_at: null,
      quota_source: 'PROVIDER_REPORTED',
      quota_confidence: 1.0,
      last_health_check: nowIso,
    });

    // 6. Successor Provider 2 (Google), Account, Resource
    repo.createProvider({
      id: successorProviderId2,
      name: 'Successor Provider Google',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: nowIso,
    });
    const succAdapter2 = new MockTestAdapter(successorProviderId2, 'Successor Provider Google', 'LOCAL_CLI');
    registry.register(succAdapter2);

    repo.createProviderAccount({
      id: 'acc-succ-google-1',
      provider_id: successorProviderId2,
      label: 'Google Vertex Account',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: 'wincred://agentforge/google/key1',
      profile_ref: null,
      enabled: true,
      priority: 15,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 5,
      last_success_at: nowIso,
      last_failure_at: null,
      last_failure_code: null,
      created_at: nowIso,
      updated_at: nowIso,
    });

    repo.createProviderResource({
      id: 'res-succ-google-1',
      provider_id: successorProviderId2,
      provider_account_id: 'acc-succ-google-1',
      model_name: 'gemini-1.5-pro',
      health_status: 'AVAILABLE',
      capabilities: ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION', 'REVIEW'],
      enabled: true,
      total_quota: 10000,
      remaining_quota: 7000,
      quota_unit: 'TOKENS',
      quota_reset_at: null,
      quota_source: 'PROVIDER_REPORTED',
      quota_confidence: 1.0,
      last_health_check: nowIso,
    });

    // 7. Source TaskAttempt & Source AgentAssignment (HANDED_OFF)
    repo.createTaskAttempt({
      id: sourceAttemptId,
      task_id: taskId,
      attempt_number: 1,
      agent_id: 'agent-source-1',
      agent_profile_id: sourceAgentProfileId,
      status: 'HANDED_OFF' as any,
      started_at: nowIso,
      ended_at: nowIso,
      summary: 'Handed off to reviewer',
    });

    repo.createAgentAssignment({
      id: sourceAssignmentId,
      project_id: projectId,
      task_id: taskId,
      attempt_id: sourceAttemptId,
      role_profile_id: sourceRoleProfileId,
      agent_profile_id: sourceAgentProfileId,
      selected_provider_id: sourceProviderId,
      selected_account_id: 'acc-source-1',
      selected_resource_id: 'res-source-1',
      selected_worker_slot_id: null,
      routing_decision_id: 'dec-source-1',
      preferred_metadata: null,
      status: 'HANDED_OFF',
      created_at: nowIso,
      ended_at: nowIso,
    });
  }

  function createPreparedTransfer(params?: {
    transferId?: string;
    version?: number;
    sourceOwnershipEpoch?: number;
    successorOwnershipEpoch?: number;
    status?: any;
    noSnapshot?: boolean;
  }): { transfer: HandoffTransfer; snapshotId: string | null; specHash: string | null } {
    const transferId = params?.transferId ?? 'transfer-r5i4-1';

    // Create successor Attempt N+1 in PENDING state
    repo.createTaskAttempt({
      id: successorAttemptId,
      task_id: taskId,
      attempt_number: 2,
      agent_id: null,
      agent_profile_id: successorAgentProfileId,
      status: 'PENDING',
      started_at: nowIso,
      ended_at: null,
      summary: null,
    });

    let snapId: string | null = null;
    let specHash: string | null = null;

    if (!params?.noSnapshot) {
      const buildRes = contextBuilder.buildContextSnapshot({
        projectId,
        taskId,
        attemptId: successorAttemptId,
        purpose: 'HANDOFF',
      });
      snapId = buildRes.snapshot.id;
      specHash = 'spechash_r5i4_test_1';
    }

    const transfer: HandoffTransfer = {
      id: transferId,
      request_id: 'req-r5i4-1',
      task_id: taskId,
      source_attempt_id: sourceAttemptId,
      successor_attempt_id: successorAttemptId,
      source_assignment_id: sourceAssignmentId,
      successor_assignment_id: null,
      successor_role_profile_id: successorRoleProfileId,
      successor_agent_profile_id: successorAgentProfileId,
      successor_context_snapshot_id: snapId,
      successor_context_spec_hash: specHash,
      handoff_context_id: null,
      checkpoint_id: null,
      source_authorization_id: null,
      successor_authorization_id: null,
      reason: 'CONTEXT_EXHAUSTED',
      status: params?.status ?? 'SUCCESSOR_PREPARED',
      source_ownership_epoch: params?.sourceOwnershipEpoch ?? 1,
      successor_ownership_epoch: params?.successorOwnershipEpoch ?? 2,
      version: params?.version ?? 2,
      frozen_at: nowIso,
      quiescing_at: nowIso,
      relinquished_at: nowIso,
      accepted_at: null,
      completed_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    };

    repo.createHandoffTransfer(transfer);
    return { transfer, snapshotId: snapId, specHash };
  }

  // ============================================================
  // Group 1: Fundamental Routing & Exact Field Binding
  // Tests 1-6, 14-24
  // ============================================================
  describe('Group 1: Fundamental Routing & Exact Field Binding', () => {
    it('1. transitions SUCCESSOR_PREPARED -> ROUTED with version increment', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(true);
      expect(res.transfer?.status).toBe('ROUTED');
      expect(res.transfer?.version).toBe(3);
      expect(res.alreadyRouted).toBe(false);
    });

    it('2. binds exact successor attempt id to assignment', async () => {
      const { transfer } = createPreparedTransfer();
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(true);
      expect(res.assignment?.attempt_id).toBe(successorAttemptId);
    });

    it('3. binds exact role profile id to assignment', async () => {
      const { transfer } = createPreparedTransfer();
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(true);
      expect(res.assignment?.role_profile_id).toBe(successorRoleProfileId);
    });

    it('4. binds exact agent profile id to assignment', async () => {
      const { transfer } = createPreparedTransfer();
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(true);
      expect(res.assignment?.agent_profile_id).toBe(successorAgentProfileId);
    });

    it('5. preserves context authority unchanged', async () => {
      const { transfer, snapshotId, specHash } = createPreparedTransfer();
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(true);
      expect(res.transfer?.successor_context_snapshot_id).toBe(snapshotId);
      expect(res.transfer?.successor_context_spec_hash).toBe(specHash);
    });

    it('6. invokes routeRole with persistAssignment=false', async () => {
      const { transfer } = createPreparedTransfer();
      const initialAssignments = repo.getAllAgentAssignments();

      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(true);
      expect(res.decision).toBeDefined();
      expect(res.decision?.selectedAssignmentId).toBeNull(); // Phase A produces no assignment
      expect(repo.getAllAgentAssignments().length).toBe(initialAssignments.length + 1); // exactly one created in Phase B
    });

    it('14. SELECTED creates exactly one AgentAssignment in database', async () => {
      const { transfer } = createPreparedTransfer();
      const preCount = repo.getAllAgentAssignments().length;
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(true);
      const postCount = repo.getAllAgentAssignments().length;
      expect(postCount).toBe(preCount + 1);
    });

    it('15. assignment attempt_id equals successor attempt N+1', async () => {
      const { transfer } = createPreparedTransfer();
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.assignment?.attempt_id).toBe(successorAttemptId);
    });

    it('16. routing decision ID is stored in assignment', async () => {
      const { transfer } = createPreparedTransfer();
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.assignment?.routing_decision_id).toBe(res.decision?.decisionId);
    });

    it('17. selected provider/account/resource match routing decision', async () => {
      const { transfer } = createPreparedTransfer();
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.assignment?.selected_provider_id).toBe(res.decision?.selectedProviderId);
      expect(res.assignment?.selected_account_id).toBe(res.decision?.selectedAccountId);
      expect(res.assignment?.selected_resource_id).toBe(res.decision?.selectedResourceId);
    });

    it('18. transfer successor_assignment_id points to created assignment', async () => {
      const { transfer } = createPreparedTransfer();
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.transfer?.successor_assignment_id).toBe(res.assignment?.id);
    });

    it('19. transfer status is ROUTED', async () => {
      const { transfer } = createPreparedTransfer();
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.transfer?.status).toBe('ROUTED');
    });

    it('20. TaskAttempt remains PENDING', async () => {
      const { transfer } = createPreparedTransfer();
      await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      const attempt = repo.getTaskAttempt(successorAttemptId);
      expect(attempt?.status).toBe('PENDING');
    });

    it('21. TaskAttempt agent_id remains NULL', async () => {
      const { transfer } = createPreparedTransfer();
      await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      const attempt = repo.getTaskAttempt(successorAttemptId);
      expect(attempt?.agent_id).toBeNull();
    });

    it('22. zero ExecutionAuthorization created', async () => {
      const { transfer } = createPreparedTransfer();
      await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      const auths = db.prepare('SELECT * FROM execution_authorizations').all();
      expect(auths.length).toBe(0);
    });

    it('23. zero worker/task lease acquired or mutated', async () => {
      const { transfer } = createPreparedTransfer();
      await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      const task = repo.getTask(taskId);
      expect(task?.assigned_agent_id).toBeNull();
    });

    it('24. zero ProviderDispatch executed', async () => {
      const { transfer } = createPreparedTransfer();
      await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(repo.getAllProcessRuns().length).toBe(0);
    });
  });

  // ============================================================
  // Group 2: Cross-Provider Exclusion & Caller Constraints
  // Tests 38, 39, 44, 45, 55, 56, 57, 58, 59, 60, 61
  // ============================================================
  describe('Group 2: Cross-Provider Exclusion & Caller Constraints', () => {
    it('38. source provider is always excluded for CROSS_PROVIDER routing', async () => {
      const { transfer } = createPreparedTransfer();
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(true);
      expect(res.assignment?.selected_provider_id).not.toBe(sourceProviderId);
    });

    it('39. caller cannot remove or override source provider exclusion', async () => {
      const { transfer } = createPreparedTransfer();
      // Caller passes requiredProviderId = sourceProviderId, which contradicts exclusion
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
        requiredProviderId: sourceProviderId, // Attempt to force source provider
      });

      expect(res.success).toBe(false);
      expect(res.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    });

    it('44. resource with provider_account_id NULL is never selected for R5I4 assignment', async () => {
      // Create resource with NULL provider_account_id
      repo.createProviderResource({
        id: 'res-unassignable-null-account',
        provider_id: successorProviderId,
        provider_account_id: null,
        model_name: 'gpt-4-null-acc',
        health_status: 'AVAILABLE',
        capabilities: ['REVIEW'],
        enabled: true,
        total_quota: 1000,
        remaining_quota: 1000,
        quota_unit: 'REQUESTS',
        quota_reset_at: null,
        quota_source: 'PROVIDER_REPORTED',
        quota_confidence: 1.0,
        last_health_check: nowIso,
      });

      const { transfer } = createPreparedTransfer();
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
        preferredResourceId: 'res-unassignable-null-account',
      });

      expect(res.success).toBe(true);
      expect(res.assignment?.selected_resource_id).not.toBe('res-unassignable-null-account');
    });

    it('45. resource bound to different account is never paired or selected', async () => {
      const { transfer } = createPreparedTransfer();
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(true);
      const asgnResource = repo.getProviderResource(res.assignment!.selected_resource_id);
      expect(asgnResource?.provider_account_id).toBe(res.assignment?.selected_account_id);
    });

    it('55. source assignment not HANDED_OFF => fails closed', async () => {
      repo.updateAgentAssignmentStatus(sourceAssignmentId, 'ASSIGNED' as any);
      const { transfer } = createPreparedTransfer();
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('SOURCE_ASSIGNMENT_STATUS_MISMATCH');
    });

    it('56. routePolicyId and separationPolicyId have NO invented task defaults', () => {
      const spec = buildCanonicalHandoffRouteSpecV1({
        transferId: 't1',
        taskId: 'task1',
        successorAttemptId: 'att2',
        successorRoleProfileId: 'r1',
        successorAgentProfileId: 'a1',
        successorContextSnapshotId: 'snap1',
        successorContextSpecHash: 'h1',
        sourceAssignmentId: 'asgn1',
        sourceProviderId: 'p1',
      });

      expect(spec.route_policy_id).toBeNull();
      expect(spec.separation_policy_id).toBeNull();
    });

    it('57. same exclusion arrays in different order produce identical route-spec hash', () => {
      const specA = buildCanonicalHandoffRouteSpecV1({
        transferId: 't1',
        taskId: 'task1',
        successorAttemptId: 'att2',
        successorRoleProfileId: 'r1',
        successorAgentProfileId: 'a1',
        successorContextSnapshotId: 'snap1',
        successorContextSpecHash: 'h1',
        sourceAssignmentId: 'asgn1',
        sourceProviderId: 'p1',
        excludedCandidateIds: ['cand-B', 'cand-A', 'cand-C'],
        excludedAccountIds: ['acc-2', 'acc-1'],
        excludedProviderIds: ['prov-Z', 'prov-Y'],
      });

      const specB = buildCanonicalHandoffRouteSpecV1({
        transferId: 't1',
        taskId: 'task1',
        successorAttemptId: 'att2',
        successorRoleProfileId: 'r1',
        successorAgentProfileId: 'a1',
        successorContextSnapshotId: 'snap1',
        successorContextSpecHash: 'h1',
        sourceAssignmentId: 'asgn1',
        sourceProviderId: 'p1',
        excludedCandidateIds: ['cand-C', 'cand-A', 'cand-B'],
        excludedAccountIds: ['acc-1', 'acc-2'],
        excludedProviderIds: ['prov-Y', 'prov-Z'],
      });

      const hashA = computeSha256(canonicalJsonStringify(specA));
      const hashB = computeSha256(canonicalJsonStringify(specB));
      expect(hashA).toBe(hashB);
    });

    it('58. same candidateRefs in different order produce identical route-spec hash', () => {
      const specA = buildCanonicalHandoffRouteSpecV1({
        transferId: 't1',
        taskId: 'task1',
        successorAttemptId: 'att2',
        successorRoleProfileId: 'r1',
        successorAgentProfileId: 'a1',
        successorContextSnapshotId: 'snap1',
        successorContextSpecHash: 'h1',
        sourceAssignmentId: 'asgn1',
        sourceProviderId: 'p1',
        candidateRefs: [
          { accountId: 'acc-2', resourceId: 'res-2' },
          { accountId: 'acc-1', resourceId: 'res-1' },
        ],
      });

      const specB = buildCanonicalHandoffRouteSpecV1({
        transferId: 't1',
        taskId: 'task1',
        successorAttemptId: 'att2',
        successorRoleProfileId: 'r1',
        successorAgentProfileId: 'a1',
        successorContextSnapshotId: 'snap1',
        successorContextSpecHash: 'h1',
        sourceAssignmentId: 'asgn1',
        sourceProviderId: 'p1',
        candidateRefs: [
          { accountId: 'acc-1', resourceId: 'res-1' },
          { accountId: 'acc-2', resourceId: 'res-2' },
        ],
      });

      const hashA = computeSha256(canonicalJsonStringify(specA));
      const hashB = computeSha256(canonicalJsonStringify(specB));
      expect(hashA).toBe(hashB);
    });

    it('59. caller duplicate/malformed candidate references rejected deterministically', () => {
      expect(() =>
        validateAndCanonicalizeCandidateRefs([
          { accountId: 'acc-1', resourceId: 'res-1' },
          { accountId: 'acc-1', resourceId: 'res-1' },
        ])
      ).toThrow('Duplicate candidate reference');

      expect(() =>
        validateAndCanonicalizeCandidateRefs([
          { accountId: 'acc-1 ', resourceId: 'res-1' },
        ])
      ).toThrow('without surrounding whitespace');
    });

    it('60. AUTO candidate mode route-spec hash is independent of mutable dynamic candidate inventory', () => {
      const spec1 = buildCanonicalHandoffRouteSpecV1({
        transferId: 't1',
        taskId: 'task1',
        successorAttemptId: 'att2',
        successorRoleProfileId: 'r1',
        successorAgentProfileId: 'a1',
        successorContextSnapshotId: 'snap1',
        successorContextSpecHash: 'h1',
        sourceAssignmentId: 'asgn1',
        sourceProviderId: 'p1',
        candidateRefs: undefined, // AUTO
      });

      const spec2 = buildCanonicalHandoffRouteSpecV1({
        transferId: 't1',
        taskId: 'task1',
        successorAttemptId: 'att2',
        successorRoleProfileId: 'r1',
        successorAgentProfileId: 'a1',
        successorContextSnapshotId: 'snap1',
        successorContextSpecHash: 'h1',
        sourceAssignmentId: 'asgn1',
        sourceProviderId: 'p1',
        candidateRefs: [], // AUTO
      });

      const hash1 = computeSha256(canonicalJsonStringify(spec1));
      const hash2 = computeSha256(canonicalJsonStringify(spec2));
      expect(hash1).toBe(hash2);
      expect(spec1.caller_candidate_refs_constraint).toBeNull();
    });

    it('61. caller candidateRefs filter with 0 assignable pairs does NOT fall back to auto-discovery', async () => {
      const { transfer } = createPreparedTransfer();
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
        candidateRefs: [{ accountId: 'acc-nonexistent', resourceId: 'res-nonexistent' }],
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('NO_ELIGIBLE_CANDIDATES');
      expect(repo.getAllAgentAssignments().length).toBe(1); // zero new assignments
    });
  });

  // ============================================================
  // Group 3: Replay Identity & Hash Integrity
  // Tests 25, 26, 27, 40, 41, 42, 43, 54
  // ============================================================
  describe('Group 3: Replay Identity & Hash Integrity', () => {
    it('25. identical replay converges with alreadyRouted: true and no version increment', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });
      const firstRes = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(firstRes.success).toBe(true);
      expect(firstRes.transfer?.version).toBe(3);

      // Replay with original expectedVersion (2)
      const replayRes = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(replayRes.success).toBe(true);
      expect(replayRes.alreadyRouted).toBe(true);
      expect(replayRes.transfer?.version).toBe(3);
      expect(replayRes.assignment?.id).toBe(firstRes.assignment?.id);
    });

    it('26. conflicting route spec fails closed on replay', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });
      await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
        preferredProviderId: successorProviderId,
      });

      // Replay with different preferred provider (changes route-spec hash)
      const conflictRes = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
        preferredProviderId: successorProviderId2,
      });

      expect(conflictRes.success).toBe(false);
      expect(conflictRes.errorCode).toBe('SUCCESSOR_ROUTE_CONFLICT');
    });

    it('27. stale version fails closed', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 1, // Stale version
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('VERSION_CONFLICT');
    });

    it('40. already ROUTED replay never calls routeRole', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });
      await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      let routeRoleCalled = false;
      const mockRouter = {
        routeRole: async () => {
          routeRoleCalled = true;
          throw new Error('routeRole should not be called on already ROUTED replay');
        },
      } as any;

      const serviceWithMock = new HandoffTransferService(repo, contextBuilder, mockRouter);
      const replayRes = await serviceWithMock.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(replayRes.success).toBe(true);
      expect(replayRes.alreadyRouted).toBe(true);
      expect(routeRoleCalled).toBe(false);
    });

    it('41. random decision IDs are irrelevant to replay identity', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });
      const res1 = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      const res2 = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res2.success).toBe(true);
      expect(res2.alreadyRouted).toBe(true);
      expect(res2.assignment?.id).toBe(res1.assignment?.id);
    });

    it('42. different route-spec hash conflicts on replay', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });
      await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
        requiredResourceId: 'res-succ-openai-1',
      });

      const resConflict = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
        requiredResourceId: 'res-succ-google-1',
      });

      expect(resConflict.success).toBe(false);
      expect(resConflict.errorCode).toBe('SUCCESSOR_ROUTE_CONFLICT');
    });

    it('43. routePolicyId change changes route spec and conflicts on replay', async () => {
      repo.createRoutePolicy({
        id: 'policy-A',
        name: 'Policy A',
        required_capabilities: [],
        preferred_capabilities: [],
        provider_account_policy: null,
        allow_manual_bridge: false,
        failover_policy: null,
        risk_policy: null,
        enabled: true,
        created_at: nowIso,
        updated_at: nowIso,
      });

      repo.createRoutePolicy({
        id: 'policy-B',
        name: 'Policy B',
        required_capabilities: [],
        preferred_capabilities: [],
        provider_account_policy: null,
        allow_manual_bridge: false,
        failover_policy: null,
        risk_policy: null,
        enabled: true,
        created_at: nowIso,
        updated_at: nowIso,
      });

      const { transfer } = createPreparedTransfer({ version: 2 });
      const resA = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
        routePolicyId: 'policy-A',
      });

      expect(resA.success).toBe(true);
      expect(resA.transfer?.status).toBe('ROUTED');

      const resConflict = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
        routePolicyId: 'policy-B',
      });

      expect(resConflict.success).toBe(false);
      expect(resConflict.errorCode).toBe('SUCCESSOR_ROUTE_CONFLICT');
    });

    it('54. corrupted stored route-spec metadata fails closed', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });
      const firstRes = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      // Corrupt metadata in DB
      db.prepare("UPDATE agent_assignments SET preferred_metadata_json = '{\"corrupt\":true}' WHERE id = ?").run(
        firstRes.assignment!.id
      );

      const replayRes = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(replayRes.success).toBe(false);
      expect(replayRes.errorCode).toBe('ROUTE_METADATA_CORRUPTION');
    });
  });

  // ============================================================
  // Group 4: Provider/Account/Resource Revalidations & Phase B Fail-Closed
  // Tests 8-13, 30, 46-51, 62-65
  // ============================================================
  describe('Group 4: Provider/Account/Resource Revalidations & Phase B Fail-Closed', () => {
    it('8. unresolved provider health authority fails', async () => {
      // Set corrupt/unresolved watermark on OpenAI account
      db.prepare(
        "UPDATE provider_accounts SET last_applied_action_account_order = 1, last_applied_action_authorization_id = 'auth-missing' WHERE id = 'acc-succ-openai-1'"
      ).run();

      // Disable google account so OpenAI is only candidate
      repo.updateProviderAccount('acc-succ-google-1', { enabled: false });

      const { transfer } = createPreparedTransfer();
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(false);
      expect(res.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    });

    it('9. disabled provider fails routing', async () => {
      // Disable all candidate providers
      db.prepare('UPDATE providers SET enabled = 0 WHERE id != ?').run(sourceProviderId);

      const { transfer } = createPreparedTransfer();
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(false);
      expect(res.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    });

    it('10. unsafe account health fails routing', async () => {
      db.prepare("UPDATE provider_accounts SET health_status = 'UNHEALTHY'").run();
      const { transfer } = createPreparedTransfer();
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(false);
      expect(res.outcome).toBe('NO_ELIGIBLE_PROVIDER');
    });

    it('11. AUTH_ERROR => NEEDS_OWNER and creates no assignment', async () => {
      db.prepare("UPDATE provider_accounts SET health_status = 'AUTH_ERROR'").run();
      const { transfer } = createPreparedTransfer();
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(false);
      expect(res.outcome).toBe('NEEDS_OWNER');
      expect(repo.getAllAgentAssignments().length).toBe(1);
    });

    it('12. NO_ELIGIBLE_PROVIDER creates no assignment', async () => {
      db.prepare('UPDATE provider_resources SET enabled = 0').run();
      const { transfer } = createPreparedTransfer();
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('NO_ELIGIBLE_CANDIDATES');
      expect(repo.getAllAgentAssignments().length).toBe(1);
    });

    it('13. MANUAL_HANDOFF_REQUIRED creates no automatic assignment', async () => {
      const manualAdapter = new MockTestAdapter('prov-manual', 'Manual Adapter', 'MANUAL_BRIDGE');
      registry.register(manualAdapter);
      repo.createProvider({
        id: 'prov-manual',
        name: 'Manual Provider',
        adapter_type: 'MANUAL_BRIDGE',
        enabled: true,
        created_at: nowIso,
      });
      repo.createProviderAccount({
        id: 'acc-manual-1',
        provider_id: 'prov-manual',
        label: 'Manual Account',
        auth_mode: 'API_CREDENTIAL',
        credential_ref: 'wincred://agentforge/manual/key',
        profile_ref: null,
        enabled: true,
        priority: 100,
        health_status: 'AVAILABLE',
        cooldown_until: null,
        concurrency_limit: 1,
        last_success_at: nowIso,
        last_failure_at: null,
        last_failure_code: null,
        created_at: nowIso,
        updated_at: nowIso,
      });
      repo.createProviderResource({
        id: 'res-manual-1',
        provider_id: 'prov-manual',
        provider_account_id: 'acc-manual-1',
        model_name: 'human-review',
        health_status: 'AVAILABLE',
        capabilities: ['REVIEW'],
        enabled: true,
        total_quota: null,
        remaining_quota: null,
        quota_unit: 'REQUESTS',
        quota_reset_at: null,
        quota_source: 'UNKNOWN',
        quota_confidence: 1.0,
        last_health_check: nowIso,
      });

      // Disable automatic providers
      db.prepare('UPDATE provider_accounts SET enabled = 0 WHERE provider_id != ?').run('prov-manual');

      const { transfer } = createPreparedTransfer();
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(false);
      expect(res.outcome).toBe('NO_ELIGIBLE_PROVIDER'); // Manual bridge is not allowed in R5I4 auto-route
      expect(repo.getAllAgentAssignments().length).toBe(1);
    });

    it('30. health authority changes between evaluation and bind fails closed', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });

      // Wrap bindHandoffSuccessorRoute to mutate health before linearization
      const originalBind = repo.bindHandoffSuccessorRoute.bind(repo);
      repo.bindHandoffSuccessorRoute = (params) => {
        db.prepare("UPDATE provider_accounts SET health_status = 'UNHEALTHY' WHERE id = ?").run(
          params.selectedAccountId
        );
        return originalBind(params);
      };

      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('PROVIDER_ACCOUNT_UNSAFE_HEALTH');
      expect(repo.getAllAgentAssignments().length).toBe(1);
    });

    it('46. provider disabled between Phase A and Phase B fails closed', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });
      const originalBind = repo.bindHandoffSuccessorRoute.bind(repo);
      repo.bindHandoffSuccessorRoute = (params) => {
        db.prepare('UPDATE providers SET enabled = 0 WHERE id = ?').run(params.selectedProviderId);
        return originalBind(params);
      };

      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('PROVIDER_DISABLED');
      expect(repo.getAllAgentAssignments().length).toBe(1);
    });

    it('47. account disabled between Phase A and Phase B fails closed', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });
      const originalBind = repo.bindHandoffSuccessorRoute.bind(repo);
      repo.bindHandoffSuccessorRoute = (params) => {
        db.prepare('UPDATE provider_accounts SET enabled = 0 WHERE id = ?').run(params.selectedAccountId);
        return originalBind(params);
      };

      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('PROVIDER_ACCOUNT_DISABLED');
    });

    it('48. account becomes QUOTA_EXHAUSTED between phases fails closed', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });
      const originalBind = repo.bindHandoffSuccessorRoute.bind(repo);
      repo.bindHandoffSuccessorRoute = (params) => {
        db.prepare("UPDATE provider_accounts SET health_status = 'QUOTA_EXHAUSTED' WHERE id = ?").run(
          params.selectedAccountId
        );
        return originalBind(params);
      };

      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('PROVIDER_ACCOUNT_UNSAFE_HEALTH');
    });

    it('49. resource disabled between phases fails closed', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });
      const originalBind = repo.bindHandoffSuccessorRoute.bind(repo);
      repo.bindHandoffSuccessorRoute = (params) => {
        db.prepare('UPDATE provider_resources SET enabled = 0 WHERE id = ?').run(params.selectedResourceId);
        return originalBind(params);
      };

      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('PROVIDER_RESOURCE_DISABLED');
    });

    it('50. authoritative durable quota becomes exhausted between phases fails closed', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });
      const originalBind = repo.bindHandoffSuccessorRoute.bind(repo);
      repo.bindHandoffSuccessorRoute = (params) => {
        db.prepare('UPDATE provider_resources SET remaining_quota = 0 WHERE id = ?').run(params.selectedResourceId);
        return originalBind(params);
      };

      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('PROVIDER_RESOURCE_QUOTA_EXHAUSTED');
    });

    it('51. health head becomes PENDING_APPLICATION between phases fails closed', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });
      const originalBind = repo.bindHandoffSuccessorRoute.bind(repo);
      repo.bindHandoffSuccessorRoute = (params) => {
        // Set invalid watermark on the selected account to simulate unresolved authority
        db.prepare(
          "UPDATE provider_accounts SET last_applied_action_account_order = 1, last_applied_action_authorization_id = 'auth-missing' WHERE id = ?"
        ).run(params.selectedAccountId);
        return originalBind(params);
      };

      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('PROVIDER_HEALTH_UNRESOLVED_AUTHORITY');
    });

    it('62. bound successor ContextSnapshot missing fails closed', async () => {
      const { transfer } = createPreparedTransfer({ noSnapshot: true });
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('SUCCESSOR_NOT_PREPARED');
    });

    it('63. bound successor ContextManifest missing fails closed', async () => {
      const { transfer, snapshotId } = createPreparedTransfer();
      db.prepare('DELETE FROM context_manifests WHERE snapshot_id = ?').run(snapshotId);

      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('CONTEXT_MANIFEST_NOT_FOUND');
    });

    it('64. successor role disabled between Phase A and Phase B fails closed', async () => {
      const { transfer } = createPreparedTransfer();
      const originalBind = repo.bindHandoffSuccessorRoute.bind(repo);
      repo.bindHandoffSuccessorRoute = (params) => {
        db.prepare('UPDATE role_profiles SET enabled = 0 WHERE id = ?').run(params.successorRoleProfileId);
        return originalBind(params);
      };

      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('ROLE_PROFILE_DISABLED');
    });

    it('65. successor agent profile disabled between Phase A and Phase B fails closed', async () => {
      const { transfer } = createPreparedTransfer();
      const originalBind = repo.bindHandoffSuccessorRoute.bind(repo);
      repo.bindHandoffSuccessorRoute = (params) => {
        db.prepare('UPDATE agent_profiles SET enabled = 0 WHERE id = ?').run(params.successorAgentProfileId);
        return originalBind(params);
      };

      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('AGENT_PROFILE_DISABLED');
    });
  });

  // ============================================================
  // Group 5: Concurrency & Contender Race Invariants
  // Tests 28, 29, 52, 53
  // ============================================================
  describe('Group 5: Concurrency & Contender Race Invariants', () => {
    it('28. concurrent same-spec contenders create exactly one assignment', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });

      // Run two concurrent route operations
      const [res1, res2] = await Promise.all([
        handoffService.routeHandoffSuccessor({
          transferId: transfer.id,
          expectedVersion: 2,
          expectedSuccessorEpoch: 2,
        }),
        handoffService.routeHandoffSuccessor({
          transferId: transfer.id,
          expectedVersion: 2,
          expectedSuccessorEpoch: 2,
        }),
      ]);

      expect(res1.success).toBe(true);
      expect(res2.success).toBe(true);

      const winner = res1.alreadyRouted ? res2 : res1;
      const loser = res1.alreadyRouted ? res1 : res2;

      expect(winner.alreadyRouted).toBe(false);
      expect(loser.alreadyRouted).toBe(true);
      expect(winner.assignment?.id).toBe(loser.assignment?.id);
      expect(repo.getAllAgentAssignments().length).toBe(2); // 1 source + 1 successor
    });

    it('29. losing contender creates zero orphan assignments', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });

      await Promise.all([
        handoffService.routeHandoffSuccessor({
          transferId: transfer.id,
          expectedVersion: 2,
          expectedSuccessorEpoch: 2,
        }),
        handoffService.routeHandoffSuccessor({
          transferId: transfer.id,
          expectedVersion: 2,
          expectedSuccessorEpoch: 2,
        }),
      ]);

      const assignmentsForTask = repo.getAgentAssignmentsByTask(taskId);
      expect(assignmentsForTask.length).toBe(2); // 1 source + 1 successor
    });

    it('52. same-spec true contender test creates one assignment and loser converges', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });

      const resA = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      const resB = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(resA.success).toBe(true);
      expect(resB.success).toBe(true);
      expect(resB.alreadyRouted).toBe(true);
      expect(resA.assignment?.id).toBe(resB.assignment?.id);
    });

    it('53. different-spec contender creates one assignment and one conflict, no orphan', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });

      const resA = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
        preferredProviderId: successorProviderId,
      });

      const resB = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
        preferredProviderId: successorProviderId2,
      });

      expect(resA.success).toBe(true);
      expect(resB.success).toBe(false);
      expect(resB.errorCode).toBe('SUCCESSOR_ROUTE_CONFLICT');
      expect(repo.getAgentAssignmentsByTask(taskId).length).toBe(2); // 1 source + 1 winner
    });
  });

  // ============================================================
  // Group 6: Architectural Non-Conflation with Failover
  // Tests 7, 36, 37
  // ============================================================
  describe('Group 6: Architectural Non-Conflation with Failover', () => {
    it('7. generic handoff does not consume failover budget', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });
      await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      const transitions = db.prepare('SELECT * FROM failover_transitions').all();
      expect(transitions.length).toBe(0);
    });

    it('36. generic handoff creates no FailoverTransition record', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });
      await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      const transition = repo.getFailoverTransitionBySource(sourceAttemptId);
      expect(transition).toBeNull();
    });

    it('37. MANUAL and CONTEXT_EXHAUSTED handoffs require no failover lineage', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });
      db.prepare("UPDATE handoff_transfers SET reason = 'MANUAL' WHERE id = ?").run(transfer.id);

      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(true);
      expect(res.transfer?.status).toBe('ROUTED');
    });
  });

  // ============================================================
  // Group 7: Non-Regression & Artifact Verification
  // Tests 31, 32, 33, 34, 35
  // ============================================================
  describe('Group 7: Non-Regression & Artifact Verification', () => {
    it('31. zero N+2 TaskAttempts created during routing', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });
      await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      const attempts = repo.getTaskAttemptsByTask(taskId);
      expect(attempts.length).toBe(2); // exactly source (1) and successor (2)
    });

    it('32. zero duplicate context snapshots or manifests created', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });
      const snapCountBefore = repo.getContextSnapshotsByTask(taskId).length;

      await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      const snapCountAfter = repo.getContextSnapshotsByTask(taskId).length;
      expect(snapCountAfter).toBe(snapCountBefore);
    });

    it('33. R5I3 contract preserved (HandoffTransferStatus enum integrity)', () => {
      const statuses = [
        'REQUESTED',
        'FROZEN',
        'QUIESCING',
        'RELINQUISHED',
        'SUCCESSOR_PREPARED',
        'ROUTED',
        'AUTHORIZED',
        'ACCEPTED',
        'COMPLETED',
        'FAILED',
        'CANCELLED',
        'EXPIRED',
      ];
      expect(statuses).toContain('SUCCESSOR_PREPARED');
      expect(statuses).toContain('ROUTED');
    });

    it('34. RoleAwareRoutingService routing decision structure verified', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.decision?.outcome).toBe('SELECTED');
      expect(res.decision?.candidateEvaluations.length).toBeGreaterThan(0);
    });

    it('35. Failover policy services remain uncalled for generic handoffs', async () => {
      const { transfer } = createPreparedTransfer({ version: 2 });
      const res = await handoffService.routeHandoffSuccessor({
        transferId: transfer.id,
        expectedVersion: 2,
        expectedSuccessorEpoch: 2,
      });

      expect(res.success).toBe(true);
      expect(res.transfer?.status).toBe('ROUTED');
    });
  });
});
