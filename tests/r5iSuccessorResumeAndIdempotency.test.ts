import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ProviderRegistry } from '../src/core/adapters/ProviderRegistry';
import { ProviderAdapter, QuotaSnapshotInfo } from '../src/core/adapters/ProviderAdapter';
import { EventService } from '../src/core/services/EventService';
import { WorkerSlotLeaseService } from '../src/core/services/WorkerSlotLeaseService';
import { GitWorktreeService } from '../src/core/services/GitWorktreeService';
import { ProviderDispatchService } from '../src/core/services/ProviderDispatchService';
import { ConcurrentExecutionScheduler } from '../src/core/services/ConcurrentExecutionScheduler';
import {
  ExecutionAuthorizationService,
  computeHandoffAuthorizationId,
  computeCanonicalPayload,
  computePayloadHash,
  computeContextManifestHash,
} from '../src/core/services/ExecutionAuthorizationService';
import {
  HandoffTransferService,
  computeSuccessorContextSpecHash,
} from '../src/core/services/HandoffTransferService';
import {
  ContextBuilderService,
  canonicalJsonStringify,
  computeSha256,
} from '../src/core/services/ContextBuilderService';
import { RoleAwareRoutingService } from '../src/core/services/RoleAwareRoutingService';
import {
  ProviderHealthStatus,
  ProviderAdapterType,
  Capability,
  ExecutionAuthorization,
  AgentAssignment,
  HandoffTransfer,
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
  public async execute(req: any): Promise<any> {
    return {
      status: 'COMPLETED',
      executionId: req.executionId,
      instructions: req.instructions,
      contextFiles: req.contextFiles,
    };
  }
  public async cancel(): Promise<void> {}
}

describe('R5I5 Successor Resume, Linearization, and Idempotency Authority', () => {
  let db: Database.Database;
  let repo: Repository;
  let eventService: EventService;
  let registry: ProviderRegistry;
  let adapterA: MockTestAdapter;
  let adapterB: MockTestAdapter;
  let leaseService: WorkerSlotLeaseService;
  let worktreeService: GitWorktreeService;
  let dispatchService: ProviderDispatchService;
  let scheduler: ConcurrentExecutionScheduler;
  let authService: ExecutionAuthorizationService;
  let handoffService: HandoffTransferService;
  let routingService: RoleAwareRoutingService;
  let contextBuilder: ContextBuilderService;

  let testDir: string;
  let repoDir: string;
  let managedDir: string;
  let gitExe: string;
  let baseSha: string;

  const projectId = 'proj-r5i5-1';
  const taskId = 'task-r5i5-1';
  const sourceAttemptId = 'att-r5i5-src';
  const sourceAssignmentId = 'asgn-r5i5-src';
  const successorAttemptId = 'att-r5i5-succ';
  const roleProfileId = 'role-coder-r5i5';
  const agentProfileId = 'agent-coder-r5i5';

  const providerAId = 'prov-a-r5i5';
  const accountAId = 'acc-a-r5i5';
  const resourceAId = 'res-a-r5i5';

  const providerBId = 'prov-b-r5i5';
  const accountBId = 'acc-b-r5i5';
  const resourceBId = 'res-b-r5i5';
  const slotBId = 'slot-b-r5i5';

  let defaultTransfer: HandoffTransfer;
  let defaultAssignment: AgentAssignment;
  let defaultRoutingDecisionId: string;
  let defaultSnapshotId: string;
  let defaultManifestId: string;
  let managerHash: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-r5i5-test-'));
    repoDir = path.join(testDir, 'repo');
    managedDir = path.join(testDir, 'managed');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(managedDir, { recursive: true });

    gitExe = execSync(process.platform === 'win32' ? 'where git' : 'which git', { encoding: 'utf-8' })
      .trim()
      .split(/\r?\n/)[0];

    execSync(`"${gitExe}" init`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`"${gitExe}" config user.name "R5I5 Tester"`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`"${gitExe}" config user.email "tester@example.com"`, { cwd: repoDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# R5I5 Test Repo\n');
    fs.writeFileSync(path.join(repoDir, 'src_file.ts'), 'export const x = 1;\n');
    execSync(`"${gitExe}" add README.md src_file.ts`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`"${gitExe}" commit -m "initial commit"`, { cwd: repoDir, stdio: 'ignore' });
    baseSha = execSync(`"${gitExe}" rev-parse HEAD`, { cwd: repoDir, encoding: 'utf-8' }).trim();

    db = new Database(':memory:');
    MigrationRunner.run(db);

    repo = new Repository(db);
    eventService = new EventService(repo);
    leaseService = new WorkerSlotLeaseService(repo);
    worktreeService = new GitWorktreeService({
      gitExecutable: gitExe,
      repositoryRoot: repoDir,
      managedRoot: managedDir,
    });

    adapterA = new MockTestAdapter(providerAId, 'Provider A Adapter');
    adapterB = new MockTestAdapter(providerBId, 'Provider B Adapter');
    registry = new ProviderRegistry();
    registry.register(adapterA);
    registry.register(adapterB);

    dispatchService = new ProviderDispatchService(registry, repo, eventService, worktreeService);
    scheduler = new ConcurrentExecutionScheduler(repo, leaseService, worktreeService, dispatchService);
    authService = new ExecutionAuthorizationService(repo, eventService);
    routingService = new RoleAwareRoutingService(repo, registry, eventService);
    contextBuilder = new ContextBuilderService(repo);
    handoffService = new HandoffTransferService(repo, contextBuilder, routingService);

    const nowIso = new Date().toISOString();

    // 1. Seed Project & Task
    repo.createProject({
      id: projectId,
      name: 'R5I5 Project',
      description: 'R5I5 Project Description',
      repository_path: repoDir,
      default_branch: 'main',
      status: 'READY',
      contract: null,
      started_at: null,
      completed_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    });

    repo.createTask({
      id: taskId,
      project_id: projectId,
      milestone_id: null,
      title: 'R5I5 Task Title',
      description: 'R5I5 Task Description',
      state: 'CODING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'LOW',
      assigned_agent_id: null,
      revision_count: 1,
      max_revisions: 5,
      base_sha: baseSha,
      current_sha: baseSha,
      progress_cache_percent: 50,
      progress_computed_at: nowIso,
      acceptance_criteria: ['Pass tests', 'Idempotent resume'],
      constraints: ['Verify worktree'],
      ownership_epoch: 2, // successor epoch
      created_at: nowIso,
      updated_at: nowIso,
    });

    // 2. Seed Roles & Profiles
    repo.createRoleProfile({
      id: roleProfileId,
      role: 'CODER',
      display_name: 'Coder Role',
      authority_scope: {},
      output_protocol: 'coder.v1',
      required_capabilities: ['CODING'],
      preferred_capabilities: [],
      permissions: [],
      enabled: true,
      created_at: nowIso,
      updated_at: nowIso,
    });

    repo.createAgentProfile({
      id: agentProfileId,
      role_profile_id: roleProfileId,
      name: 'Coder Agent Profile',
      prompt_template: null,
      config: null,
      enabled: true,
      created_at: nowIso,
      updated_at: nowIso,
    });

    // 3. Seed Source and Successor TaskAttempt
    repo.createTaskAttempt({
      id: sourceAttemptId,
      task_id: taskId,
      attempt_number: 1,
      status: 'HANDED_OFF',
      agent_profile_id: agentProfileId,
      agent_id: null,
      started_at: nowIso,
      ended_at: null,
      summary: null,
    });

    repo.createTaskAttempt({
      id: successorAttemptId,
      task_id: taskId,
      attempt_number: 2,
      status: 'PENDING',
      agent_profile_id: agentProfileId,
      agent_id: null,
      started_at: nowIso,
      ended_at: null,
      summary: null,
    });

    // 4. Seed Provider A (Source)
    repo.createProvider({
      id: providerAId,
      name: 'Provider A',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: nowIso,
    });

    repo.createProviderAccount({
      id: accountAId,
      provider_id: providerAId,
      label: 'Account A',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: 'wincred://agentforge/providerA/key',
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
      id: resourceAId,
      provider_id: providerAId,
      provider_account_id: accountAId,
      model_name: 'claude-3-7-sonnet',
      health_status: 'AVAILABLE',
      capabilities: ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION', 'REVIEW'],
      enabled: true,
      total_quota: 1000,
      remaining_quota: 1000,
      quota_unit: 'TOKENS',
      quota_reset_at: null,
      quota_source: 'PROVIDER_REPORTED',
      quota_confidence: 1.0,
      last_health_check: nowIso,
    });

    // 5. Seed Provider B (Successor)
    repo.createProvider({
      id: providerBId,
      name: 'Provider B',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: nowIso,
    });

    repo.createProviderAccount({
      id: accountBId,
      provider_id: providerBId,
      label: 'Account B',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: 'wincred://agentforge/providerB/key',
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
      id: resourceBId,
      provider_id: providerBId,
      provider_account_id: accountBId,
      model_name: 'gemini-2.5-pro',
      health_status: 'AVAILABLE',
      capabilities: ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION', 'REVIEW'],
      enabled: true,
      total_quota: 1000,
      remaining_quota: 1000,
      quota_unit: 'TOKENS',
      quota_reset_at: null,
      quota_source: 'PROVIDER_REPORTED',
      quota_confidence: 1.0,
      last_health_check: nowIso,
    });

    repo.createWorkerSlot({
      id: slotBId,
      provider_account_id: accountBId,
      provider_resource_id: resourceBId,
      slot_index: 0,
      status: 'IDLE',
      current_assignment_id: null,
      current_execution_id: null,
      heartbeat_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    });

    // 6. Seed Source Assignment
    repo.createAgentAssignment({
      id: sourceAssignmentId,
      project_id: projectId,
      task_id: taskId,
      attempt_id: sourceAttemptId,
      role_profile_id: roleProfileId,
      agent_profile_id: agentProfileId,
      selected_provider_id: providerAId,
      selected_account_id: accountAId,
      selected_resource_id: resourceAId,
      selected_worker_slot_id: null,
      routing_decision_id: 'dec-src-1',
      preferred_metadata: null,
      ended_at: null,
      status: 'HANDED_OFF',
      created_at: nowIso,
    });

    // 7. Seed Manager message
    const managerPayload = {
      protocol: 'manager.v1',
      message_id: 'msg-manager-1',
      project_id: projectId,
      task_id: taskId,
      decision: 'EXECUTE',
      instructions: ['Continue with successor execution'],
      expected_revision: 1,
      constraints: ['Verify worktree'],
    };
    const managerJson = JSON.stringify(managerPayload);
    managerHash = computeSha256(managerJson);
    const managerMsgId = 'msg-manager-1';
    repo.recordProtocolMessage(
      managerMsgId,
      managerMsgId,
      'manager.v1',
      projectId,
      taskId,
      'CODING',
      1,
      managerHash,
      managerJson,
      'APPLIED'
    );

    // 8. Seed Verification Command
    repo.createVerificationCommand({
      id: 'vcmd-test-1',
      project_id: projectId,
      name: 'Unit Tests',
      command_type: 'TEST',
      executable: 'npm',
      args: ['test'],
      enabled: true,
    });

    // 9. Seed Handoff Transfer in ROUTED state with R5I3 Context & R5I4 Route
    const transferId = 'transfer-r5i5-1';
    defaultRoutingDecisionId = 'dec-route-succ-1';
    const successorAssignmentId = 'asgn-r5i5-succ';

    // R5I3 Context snapshot & manifest via real computeSuccessorContextSpecHash
    const rawContextFiles = ['src_file.ts'];
    const rawCustomItems = [
      {
        itemType: 'PROJECT_MEMORY' as const,
        sourceType: 'MEMORY_STORE',
        sourceRef: 'project-notes',
        content: { note: 'Important project architectural invariant' },
        tokenEstimate: 25,
      },
      {
        itemType: 'TASK_MEMORY' as const,
        sourceType: 'TASK_STORE',
        sourceRef: 'task-progress',
        content: { step: 'Step 1 complete' },
        tokenEstimate: 15,
      },
    ];

    const contextSpecHash = computeSuccessorContextSpecHash({
      transferId,
      successorAttemptId,
      purpose: 'HANDOFF',
      handoffContextId: null,
      checkpointId: null,
      contextFiles: rawContextFiles,
      customItems: rawCustomItems,
    });

    defaultSnapshotId = `ctx-snap-ho-${computeSha256(`r5i-successor-context:${transferId}:${contextSpecHash}`).slice(0, 32)}`;
    defaultManifestId = `ctx-man-ho-${computeSha256(`r5i-successor-manifest:${transferId}:${contextSpecHash}`).slice(0, 32)}`;

    const buildRes = contextBuilder.buildContextSnapshot({
      projectId,
      taskId,
      attemptId: successorAttemptId,
      purpose: 'HANDOFF',
      snapshotId: defaultSnapshotId,
      manifestId: defaultManifestId,
      contextFiles: rawContextFiles,
      customItems: rawCustomItems,
    });

    // Record R5I4 Historical Routing Event with selectedAssignmentId = null
    const routeSpec: Record<string, unknown> = {
      transferId,
      successorAttemptId,
      roleProfileId,
      sourceProviderId: providerAId,
    };
    const routeSpecHash = computeSha256(canonicalJsonStringify(routeSpec));

    eventService.record(
      projectId,
      'ROLE_AWARE_ROUTING_DECISION',
      'Routing decision for successor',
      {
        projectId,
        taskId,
        attemptId: successorAttemptId,
        decisionId: defaultRoutingDecisionId,
        outcome: 'SELECTED',
        selectedProviderId: providerBId,
        selectedAccountId: accountBId,
        selectedResourceId: resourceBId,
        selectedAssignmentId: null, // R5I4 historical invariant: NULL
        roleProfileId,
      },
      taskId
    );

    // Create successor AgentAssignment
    defaultAssignment = {
      id: successorAssignmentId,
      project_id: projectId,
      task_id: taskId,
      attempt_id: successorAttemptId,
      role_profile_id: roleProfileId,
      agent_profile_id: agentProfileId,
      selected_provider_id: providerBId,
      selected_account_id: accountBId,
      selected_resource_id: resourceBId,
      selected_worker_slot_id: null,
      routing_decision_id: defaultRoutingDecisionId,
      preferred_metadata: {
        handoff_route_spec_version: 1,
        handoff_route_spec_hash: routeSpecHash,
        handoff_route_spec: routeSpec,
      },
      status: 'ASSIGNED',
      created_at: nowIso,
      ended_at: null,
    };
    repo.createAgentAssignment(defaultAssignment);

    // Create HandoffTransfer in ROUTED status
    defaultTransfer = {
      id: transferId,
      request_id: 'req-r5i5-1',
      task_id: taskId,
      source_attempt_id: sourceAttemptId,
      successor_attempt_id: successorAttemptId,
      source_assignment_id: sourceAssignmentId,
      successor_assignment_id: successorAssignmentId,
      successor_role_profile_id: roleProfileId,
      successor_agent_profile_id: agentProfileId,
      successor_context_snapshot_id: defaultSnapshotId,
      successor_context_spec_hash: contextSpecHash,
      handoff_context_id: null,
      checkpoint_id: null,
      source_authorization_id: null,
      successor_authorization_id: null,
      reason: 'Cross-provider successor routing complete',
      status: 'ROUTED',
      source_ownership_epoch: 1,
      successor_ownership_epoch: 2,
      version: 4,
      frozen_at: nowIso,
      quiescing_at: nowIso,
      relinquished_at: nowIso,
      accepted_at: null,
      completed_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    };
    repo.createHandoffTransfer(defaultTransfer);
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  // ==========================================
  // A. ROUTING / ASSIGNMENT BRIDGE (Tests 1-8)
  // ==========================================

  it('1. R5I4 routing event with selectedAssignmentId NULL resumes successfully', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({
      transferId: defaultTransfer.id,
    });
    expect(resumeRes.success).toBe(true);
    expect(resumeRes.authorization).toBeDefined();
    expect(resumeRes.authorization!.status).toBe('AUTHORIZED');
    expect(resumeRes.authorization!.assignment_id).toBe(defaultAssignment.id);
  });

  it('2. Historical routing event is logically immutable and not mutated', async () => {
    await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const routingEvent = repo.getRoutingDecisionEvent(defaultRoutingDecisionId);
    expect(routingEvent).toBeDefined();
    const payload = routingEvent!.structured_payload as Record<string, unknown>;
    expect(payload.selectedAssignmentId).toBeNull();
  });

  it('3. No rerouting occurs during R5I5 resume', async () => {
    const eventsBefore = (db.prepare('SELECT * FROM events WHERE task_id = ?').all(taskId) as any[]).length;
    await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const routingEvents = (db.prepare("SELECT * FROM events WHERE task_id = ? AND type = 'ROLE_AWARE_ROUTING_DECISION'").all(taskId) as any[]);
    expect(routingEvents.length).toBe(1); // exactly the 1 pre-existing event
  });

  it('4. auth.assignment_id exact handoff bridge links transfer and assignment', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const auth = resumeRes.authorization!;
    const transfer = repo.getHandoffTransfer(defaultTransfer.id)!;
    expect(transfer.successor_authorization_id).toBe(auth.id);
    expect(auth.assignment_id).toBe(transfer.successor_assignment_id);
  });

  it('5. non-null auth.assignment_id without matching HandoffTransfer fails closed in scheduler', async () => {
    const fakeAuth: ExecutionAuthorization = {
      id: 'auth-fake-bridge-1',
      project_id: projectId,
      task_id: taskId,
      attempt_id: sourceAttemptId,
      task_revision: 1,
      base_sha: baseSha,
      repository_head_sha: baseSha,
      manager_message_id: 'msg-manager-1',
      manager_payload_hash: 'hash-1',
      routing_decision_id: defaultRoutingDecisionId,
      selected_resource_id: resourceBId,
      selected_provider_id: providerBId,
      instruction_payload_hash: 'inst-hash-1',
      context_manifest_hash: 'manifest-hash-1',
      canonical_instructions_json: '[]',
      context_files_json: '[]',
      canonical_payload_json: null,
      status: 'AUTHORIZED',
      created_at: new Date().toISOString(),
      dispatched_at: null,
      task_ownership_epoch: 1,
      assignment_id: sourceAssignmentId, // sourceAssignmentId exists, but no transfer has successor_authorization_id = fakeAuth.id
    };
    repo.createExecutionAuthorization(fakeAuth);

    const schedRes = await scheduler.execute(fakeAuth.id);
    expect(schedRes.status).toBe('PREPARATION_FAILED');
    expect(schedRes.error).toMatch(/ROUTING_ASSIGNMENT_NOT_FOUND|PREPARATION_FAILED|No HandoffTransfer/);
  });

  it('6. wrong transfer assignment pointer fails closed in scheduler', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    // Mutate transfer's successor_assignment_id to mismatch auth.assignment_id
    db.prepare('UPDATE handoff_transfers SET successor_assignment_id = ? WHERE id = ?').run(sourceAssignmentId, defaultTransfer.id);

    const schedRes = await scheduler.execute(resumeRes.authorization!.id);
    expect(schedRes.status).toBe('PREPARATION_FAILED');
    expect(schedRes.error).toMatch(/ROUTING_ASSIGNMENT_NOT_FOUND|PREPARATION_FAILED|Durable binding invariant/);
  });

  it('7. wrong transfer attempt pointer fails closed in scheduler', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    // Mutate transfer's successor_attempt_id to mismatch auth.attempt_id
    db.prepare('UPDATE handoff_transfers SET successor_attempt_id = ? WHERE id = ?').run(sourceAttemptId, defaultTransfer.id);

    const schedRes = await scheduler.execute(resumeRes.authorization!.id);
    expect(schedRes.status).toBe('PREPARATION_FAILED');
    expect(schedRes.error).toMatch(/ROUTING_ASSIGNMENT_NOT_FOUND|PREPARATION_FAILED|Durable binding invariant/);
  });

  it('8. legacy auth.assignment_id NULL still uses selectedAssignmentId from routing payload', async () => {
    const legacyDecId = 'dec-legacy-1';
    const legacyAsgnId = 'asgn-legacy-1';
    repo.createAgentAssignment({
      id: legacyAsgnId,
      project_id: projectId,
      task_id: taskId,
      attempt_id: sourceAttemptId,
      role_profile_id: roleProfileId,
      agent_profile_id: agentProfileId,
      selected_provider_id: providerBId,
      selected_account_id: accountBId,
      selected_resource_id: resourceBId,
      selected_worker_slot_id: null,
      routing_decision_id: legacyDecId,
      preferred_metadata: null,
      ended_at: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
    });

    eventService.record(
      projectId,
      'ROLE_AWARE_ROUTING_DECISION',
      'Legacy routing decision',
      {
        projectId,
        taskId,
        attemptId: sourceAttemptId,
        decisionId: legacyDecId,
        outcome: 'SELECTED',
        selectedProviderId: providerBId,
        selectedAccountId: accountBId,
        selectedResourceId: resourceBId,
        selectedAssignmentId: legacyAsgnId, // Legacy has non-null assignment in event
        roleProfileId,
      },
      taskId
    );

    const effectiveConstraints = ['Verify worktree', 'Verify worktree'];
    const instructions = ['Continue with successor execution'];
    const contextFiles = ['src_file.ts'];
    const canonicalPayload = computeCanonicalPayload({
      projectId,
      taskId,
      attemptId: sourceAttemptId,
      taskTitle: 'R5I5 Task Title',
      taskDescription: 'R5I5 Task Description',
      acceptanceCriteria: ['Pass tests', 'Idempotent resume'],
      constraints: effectiveConstraints,
      instructions,
      contextFiles,
      verificationCommands: { TEST: null, LINT: null, BUILD: null },
      managerMessageId: 'msg-manager-1',
      managerPayloadHash: managerHash,
    });
    const canonicalPayloadJson = JSON.stringify(canonicalPayload);
    const instructionPayloadHash = computePayloadHash(canonicalPayload);
    const contextManifestHash = computeContextManifestHash(contextFiles);

    const legacyAuth: ExecutionAuthorization = {
      id: 'auth-legacy-1',
      project_id: projectId,
      task_id: taskId,
      attempt_id: sourceAttemptId,
      task_revision: 1,
      base_sha: baseSha,
      repository_head_sha: baseSha,
      manager_message_id: 'msg-manager-1',
      manager_payload_hash: managerHash,
      routing_decision_id: legacyDecId,
      selected_resource_id: resourceBId,
      selected_provider_id: providerBId,
      instruction_payload_hash: instructionPayloadHash,
      context_manifest_hash: contextManifestHash,
      canonical_instructions_json: JSON.stringify(instructions),
      context_files_json: JSON.stringify(contextFiles),
      canonical_payload_json: canonicalPayloadJson,
      status: 'AUTHORIZED',
      created_at: new Date().toISOString(),
      dispatched_at: null,
      task_ownership_epoch: 2,
      assignment_id: null, // Legacy auth has NULL assignment_id
    };
    repo.createExecutionAuthorization(legacyAuth);

    const schedRes = await scheduler.execute(legacyAuth.id);
    expect(schedRes.status).toBe('COMPLETED');
    expect(schedRes.assignmentId).toBe(legacyAsgnId);
  });

  // ==========================================
  // B. CONTEXT AUTHORITY (Tests 9-20)
  // ==========================================

  it('9. R5I3 deterministic snapshot/manifest revalidated during Phase EA and Phase EB', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(resumeRes.success).toBe(true);
    const auth = resumeRes.authorization!;
    expect(auth.context_files_json).toContain('src_file.ts');
  });

  it('10. HANDOFF_CONTEXT_EXECUTION_V1.snapshot_content_hash equals exact ContextSnapshot.content_hash, not manifest_hash', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const auth = resumeRes.authorization!;
    const instructions = JSON.parse(auth.canonical_instructions_json) as string[];
    const descriptor = JSON.parse(instructions[instructions.length - 1]);
    const snapshot = repo.getContextSnapshot(defaultSnapshotId)!;
    const manifest = repo.getContextManifest(defaultManifestId)!;

    expect(descriptor.snapshot_content_hash).toBe(snapshot.content_hash);
    expect(descriptor.manifest_hash).toBe(manifest.manifest_hash);
    expect(descriptor.snapshot_content_hash).not.toBe(manifest.manifest_hash);
  });

  it('11. ExecutionAuthorization.context_manifest_hash equals derived sorted contextFiles hash', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const auth = resumeRes.authorization!;
    const expectedHash = computeContextManifestHash(['src_file.ts']);
    expect(auth.context_manifest_hash).toBe(expectedHash);
  });

  it('12. context files derive only from CONTEXT_FILE_REFERENCE items', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const auth = resumeRes.authorization!;
    const files = JSON.parse(auth.context_files_json);
    expect(files).toEqual(['src_file.ts']);
  });

  it('13. caller cannot inject contextFiles override into resume API', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({
      transferId: defaultTransfer.id,
      // @ts-expect-error - testing invalid parameter injection
      contextFiles: ['evil.ts'],
    });
    expect(resumeRes.success).toBe(true);
    const files = JSON.parse(resumeRes.authorization!.context_files_json);
    expect(files).toEqual(['src_file.ts']);
  });

  it('14. malformed CONTEXT_FILE_REFERENCE fails closed', async () => {
    // Tamper with context item in DB before prepare
    db.prepare("UPDATE context_items SET content_json = 'INVALID_JSON' WHERE id = (SELECT id FROM context_items WHERE item_type = 'CONTEXT_FILE_REFERENCE' LIMIT 1)").run();

    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(resumeRes.success).toBe(false);
    expect(resumeRes.errorCode).toMatch(/CONTEXT_FILES_INVALID|CONTEXT_MANIFEST_INTEGRITY_FAILED/);
  });

  it('15. structured PROJECT_MEMORY reaches adapter instructions descriptor', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const auth = resumeRes.authorization!;
    const instructions = JSON.parse(auth.canonical_instructions_json) as string[];
    const descriptorText = instructions[instructions.length - 1];
    expect(descriptorText).toContain('Important project architectural invariant');
  });

  it('16. structured TASK_MEMORY reaches adapter instructions descriptor', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const auth = resumeRes.authorization!;
    const instructions = JSON.parse(auth.canonical_instructions_json) as string[];
    const descriptorText = instructions[instructions.length - 1];
    expect(descriptorText).toContain('Step 1 complete');
  });

  it('17. checkpoint/handoff structured context reaches adapter instructions in ordinal order', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const auth = resumeRes.authorization!;
    const instructions = JSON.parse(auth.canonical_instructions_json) as string[];
    expect(instructions[instructions.length - 2]).toBe('Handoff Successor Context (HANDOFF_CONTEXT_EXECUTION_V1):');
    const descriptor = JSON.parse(instructions[instructions.length - 1]);
    expect(descriptor.version).toBe(1);
    expect(descriptor.items.length).toBeGreaterThanOrEqual(2);
    expect(descriptor.items[0].ordinal).toBeLessThan(descriptor.items[1].ordinal);
  });

  it('18. structured ContextItem mutation after Phase EA before Phase EB fails closed', async () => {
    // Phase EA
    const prepareRes = await authService.prepareHandoffSuccessorAuthorization({
      transferId: defaultTransfer.id,
    });
    expect(prepareRes.success).toBe(true);

    // Mutate a ContextItem in DB
    db.prepare("UPDATE context_items SET content_json = '{\"tampered\": true}' WHERE id = (SELECT id FROM context_items WHERE item_type = 'PROJECT_MEMORY' LIMIT 1)").run();

    // Phase EB
    const resumeRes = repo.resumeHandoffSuccessorAuthorization({
      transferId: defaultTransfer.id,
      expectedVersion: defaultTransfer.version,
      candidate: prepareRes.candidate!,
    });
    expect(resumeRes.success).toBe(false);
  });

  it('19. context mutation after authorization before dispatch fails closed', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    // Invalidate manifest
    db.prepare("UPDATE context_manifests SET manifest_hash = 'corrupt' WHERE id = ?").run(defaultManifestId);

    const dispatchRes = await dispatchService.dispatchScheduled(resumeRes.authorization!.id);
    expect(dispatchRes.status).toBe('FAILED');
  });

  it('19b. ProviderDispatch context-mutation test reaches ACCEPTED state first, fails before claim', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);
    const acceptRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(acceptRes.success).toBe(true);
    expect(acceptRes.transfer!.status).toBe('ACCEPTED');

    // Mutate context items in DB
    db.prepare("UPDATE context_items SET content_json = '{\"tampered\": true}' WHERE id = (SELECT id FROM context_items WHERE item_type = 'PROJECT_MEMORY' LIMIT 1)").run();

    const dispatchRes = await dispatchService.dispatchScheduled(resumeRes.authorization!.id);
    expect(dispatchRes.status).toBe('FAILED');
    expect(dispatchRes.error).toMatch(/EXECUTION_AUTHORIZATION_HASH_MISMATCH|EXECUTION_AUTHORIZATION_INVALID/);

    // Prove authorization NOT claimed as DISPATCHED
    const auth = repo.getExecutionAuthorization(resumeRes.authorization!.id)!;
    expect(auth.status).not.toBe('DISPATCHED');
  });

  it('19c. ProviderDispatch route mutation after ACCEPTED fails before claim', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);
    const acceptRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(acceptRes.success).toBe(true);

    // Corrupt route metadata
    db.prepare("UPDATE agent_assignments SET preferred_metadata_json = '{\"corrupt\": true}' WHERE id = ?").run(defaultAssignment.id);

    const dispatchRes = await dispatchService.dispatchScheduled(resumeRes.authorization!.id);
    expect(dispatchRes.status).toBe('FAILED');
    expect(dispatchRes.error).toMatch(/ROUTE_METADATA_CORRUPTION|EXECUTION_AUTHORIZATION_INVALID/);

    const auth = repo.getExecutionAuthorization(resumeRes.authorization!.id)!;
    expect(auth.status).not.toBe('DISPATCHED');
  });

  it('19d. ProviderDispatch assignment provider corruption fails before claim', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);
    const acceptRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(acceptRes.success).toBe(true);

    // Mutate assignment provider to providerAId (mismatched provider)
    db.prepare('UPDATE agent_assignments SET selected_provider_id = ? WHERE id = ?').run(providerAId, defaultAssignment.id);

    const dispatchRes = await dispatchService.dispatchScheduled(resumeRes.authorization!.id);
    expect(dispatchRes.status).toBe('FAILED');
    expect(dispatchRes.error).toContain('EXECUTION_AUTHORIZATION_INVALID');

    const auth = repo.getExecutionAuthorization(resumeRes.authorization!.id)!;
    expect(auth.status).not.toBe('DISPATCHED');
  });

  it('20. manifest hash corruption in Phase EA fails closed', async () => {
    db.prepare("UPDATE context_manifests SET manifest_hash = 'tampered' WHERE id = ?").run(defaultManifestId);
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(resumeRes.success).toBe(false);
    expect(resumeRes.errorCode).toBe('CONTEXT_MANIFEST_INTEGRITY_FAILED');
  });

  // ==========================================
  // C. AUTHORIZATION / TOCTOU (Tests 21-34)
  // ==========================================

  it('21. deterministic authorization ID exact formula matches HANDOFF_SUCCESSOR_EXECUTION_AUTHORITY_V1', async () => {
    const prepareRes = await authService.prepareHandoffSuccessorAuthorization({
      transferId: defaultTransfer.id,
    });
    expect(prepareRes.success).toBe(true);
    const authority = prepareRes.authority!;
    const computedId = computeHandoffAuthorizationId(authority);
    expect(prepareRes.candidate!.id).toBe(computedId);
    expect(computedId.startsWith('auth-handoff-')).toBe(true);
  });

  it('21b. candidate deterministic authorization ID tampering fails Phase EB', async () => {
    const prepare = await authService.prepareHandoffSuccessorAuthorization({ transferId: defaultTransfer.id });
    const tamperedCandidate = { ...prepare.candidate!, id: 'auth-handoff-tampered-id' };
    const res = repo.resumeHandoffSuccessorAuthorization({
      transferId: defaultTransfer.id,
      expectedVersion: defaultTransfer.version,
      candidate: tamperedCandidate,
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('AUTHORIZATION_CONTENT_MISMATCH');
  });

  it('22. two concurrent resumes produce exactly one auth row in database', async () => {
    const [res1, res2] = await Promise.all([
      handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id }),
      handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id }),
    ]);

    expect(res1.success).toBe(true);
    expect(res2.success).toBe(true);
    expect(res1.authorization!.id).toBe(res2.authorization!.id);

    const rows = db.prepare('SELECT COUNT(*) as count FROM execution_authorizations WHERE task_id = ?').get(taskId) as { count: number };
    expect(rows.count).toBe(1);
  });

  it('23. loser transaction in contention leaves zero orphan authorization row', async () => {
    const prepare1 = await authService.prepareHandoffSuccessorAuthorization({ transferId: defaultTransfer.id });
    const prepare2 = await authService.prepareHandoffSuccessorAuthorization({ transferId: defaultTransfer.id });

    const res1 = repo.resumeHandoffSuccessorAuthorization({
      transferId: defaultTransfer.id,
      expectedVersion: defaultTransfer.version,
      candidate: prepare1.candidate!,
    });
    expect(res1.success).toBe(true);

    // Replay with prepare2
    const res2 = repo.resumeHandoffSuccessorAuthorization({
      transferId: defaultTransfer.id,
      expectedVersion: defaultTransfer.version,
      candidate: prepare2.candidate!,
    });
    expect(res2.success).toBe(true);
    expect(res2.alreadyAuthorized).toBe(true);

    const rows = db.prepare('SELECT COUNT(*) as count FROM execution_authorizations').all() as { count: number }[];
    expect(rows.length).toBe(1);
  });

  it('24. Manager superseded EA->EB fails closed', async () => {
    const prepare = await authService.prepareHandoffSuccessorAuthorization({ transferId: defaultTransfer.id });

    // Mark manager message as REJECTED in DB
    db.prepare("UPDATE protocol_messages SET status = 'REJECTED' WHERE id = 'msg-manager-1'").run();

    const res = repo.resumeHandoffSuccessorAuthorization({
      transferId: defaultTransfer.id,
      expectedVersion: defaultTransfer.version,
      candidate: prepare.candidate!,
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('MANAGER_AUTHORITY_INVALID');
  });

  it('24b. Manager raw durable authority change with same stored ID fails Phase EB', async () => {
    const prepare = await authService.prepareHandoffSuccessorAuthorization({ transferId: defaultTransfer.id });
    const tamperedPayload = {
      protocol: 'manager.v1',
      message_id: 'msg-manager-1',
      project_id: projectId,
      task_id: taskId,
      decision: 'AWAIT_OWNER',
      instructions: ['Tampered instruction'],
      expected_revision: 1,
    };
    db.prepare("UPDATE protocol_messages SET raw_payload = ? WHERE id = 'msg-manager-1'").run(JSON.stringify(tamperedPayload));
    const res = repo.resumeHandoffSuccessorAuthorization({
      transferId: defaultTransfer.id,
      expectedVersion: defaultTransfer.version,
      candidate: prepare.candidate!,
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('MANAGER_DECISION_NON_AUTHORIZING');
  });

  it('25. task revision mutation EA->EB fails closed', async () => {
    const prepare = await authService.prepareHandoffSuccessorAuthorization({ transferId: defaultTransfer.id });
    db.prepare('UPDATE tasks SET revision_count = 99 WHERE id = ?').run(taskId);

    const res = repo.resumeHandoffSuccessorAuthorization({
      transferId: defaultTransfer.id,
      expectedVersion: defaultTransfer.version,
      candidate: prepare.candidate!,
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('STALE_TASK_REVISION');
  });

  it('25a. task title mutation EA->EB fails candidate equality proof', async () => {
    const prepare = await authService.prepareHandoffSuccessorAuthorization({ transferId: defaultTransfer.id });
    db.prepare("UPDATE tasks SET title = 'New Title' WHERE id = ?").run(taskId);
    const res = repo.resumeHandoffSuccessorAuthorization({
      transferId: defaultTransfer.id,
      expectedVersion: defaultTransfer.version,
      candidate: prepare.candidate!,
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('AUTHORIZATION_CONTENT_MISMATCH');
  });

  it('25b. task description mutation EA->EB fails candidate equality proof', async () => {
    const prepare = await authService.prepareHandoffSuccessorAuthorization({ transferId: defaultTransfer.id });
    db.prepare("UPDATE tasks SET description = 'New Description' WHERE id = ?").run(taskId);
    const res = repo.resumeHandoffSuccessorAuthorization({
      transferId: defaultTransfer.id,
      expectedVersion: defaultTransfer.version,
      candidate: prepare.candidate!,
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('AUTHORIZATION_CONTENT_MISMATCH');
  });

  it('25c. task acceptance_criteria mutation EA->EB fails candidate equality proof', async () => {
    const prepare = await authService.prepareHandoffSuccessorAuthorization({ transferId: defaultTransfer.id });
    db.prepare("UPDATE tasks SET acceptance_criteria_json = ? WHERE id = ?").run(JSON.stringify(['Different Criteria']), taskId);
    const res = repo.resumeHandoffSuccessorAuthorization({
      transferId: defaultTransfer.id,
      expectedVersion: defaultTransfer.version,
      candidate: prepare.candidate!,
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('AUTHORIZATION_CONTENT_MISMATCH');
  });

  it('25d. task constraints mutation EA->EB fails candidate equality proof', async () => {
    const prepare = await authService.prepareHandoffSuccessorAuthorization({ transferId: defaultTransfer.id });
    db.prepare("UPDATE tasks SET constraints_json = ? WHERE id = ?").run(JSON.stringify(['New Constraint']), taskId);
    const res = repo.resumeHandoffSuccessorAuthorization({
      transferId: defaultTransfer.id,
      expectedVersion: defaultTransfer.version,
      candidate: prepare.candidate!,
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('AUTHORIZATION_CONTENT_MISMATCH');
  });

  it('26. task base_sha mutation EA->EB fails closed', async () => {
    const prepare = await authService.prepareHandoffSuccessorAuthorization({ transferId: defaultTransfer.id });
    db.prepare("UPDATE tasks SET base_sha = 'different_sha' WHERE id = ?").run(taskId);

    const res = repo.resumeHandoffSuccessorAuthorization({
      transferId: defaultTransfer.id,
      expectedVersion: defaultTransfer.version,
      candidate: prepare.candidate!,
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('BASE_SHA_MISSING');
  });

  it('27. verification commands mutation EA->EB fails closed if policy violates', async () => {
    const prepare = await authService.prepareHandoffSuccessorAuthorization({ transferId: defaultTransfer.id });

    // Add a forbidden verification command
    repo.createVerificationCommand({
      id: 'vcmd-bad',
      project_id: projectId,
      name: 'Bad Command',
      command_type: 'TEST',
      executable: 'git',
      args: ['reset', '--hard'],
      enabled: true,
    });

    const res = repo.resumeHandoffSuccessorAuthorization({
      transferId: defaultTransfer.id,
      expectedVersion: defaultTransfer.version,
      candidate: prepare.candidate!,
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('POLICY_DENIED');
  });

  it('27b. benign ALLOW verification command mutation EA->EB fails candidate equality', async () => {
    const prepare = await authService.prepareHandoffSuccessorAuthorization({ transferId: defaultTransfer.id });
    repo.createVerificationCommand({
      id: 'vcmd-allow-new',
      project_id: projectId,
      name: 'Lint Command',
      command_type: 'LINT',
      executable: 'npm',
      args: ['run', 'lint'],
      enabled: true,
    });
    const res = repo.resumeHandoffSuccessorAuthorization({
      transferId: defaultTransfer.id,
      expectedVersion: defaultTransfer.version,
      candidate: prepare.candidate!,
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('AUTHORIZATION_CONTENT_MISMATCH');
  });

  it('28. ownership epoch mutation EA->EB fails closed', async () => {
    const prepare = await authService.prepareHandoffSuccessorAuthorization({ transferId: defaultTransfer.id });
    db.prepare('UPDATE tasks SET ownership_epoch = 99 WHERE id = ?').run(taskId);

    const res = repo.resumeHandoffSuccessorAuthorization({
      transferId: defaultTransfer.id,
      expectedVersion: defaultTransfer.version,
      candidate: prepare.candidate!,
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('STALE_OWNERSHIP_EPOCH');
  });

  it('29. route metadata mutation EA->EB fails closed', async () => {
    const prepare = await authService.prepareHandoffSuccessorAuthorization({ transferId: defaultTransfer.id });
    db.prepare('UPDATE agent_assignments SET selected_resource_id = ? WHERE id = ?').run(resourceAId, defaultAssignment.id);

    const res = repo.resumeHandoffSuccessorAuthorization({
      transferId: defaultTransfer.id,
      expectedVersion: defaultTransfer.version,
      candidate: prepare.candidate!,
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('ROUTE_METADATA_CORRUPTION');
  });

  it('29b. routing event account mutation EA->EB fails closed', async () => {
    const prepare = await authService.prepareHandoffSuccessorAuthorization({ transferId: defaultTransfer.id });
    db.prepare("UPDATE events SET structured_payload_json = json_set(structured_payload_json, '$.selectedAccountId', 'acc-tampered') WHERE id = (SELECT id FROM events WHERE type = 'ROLE_AWARE_ROUTING_DECISION' LIMIT 1)").run();
    const res = repo.resumeHandoffSuccessorAuthorization({
      transferId: defaultTransfer.id,
      expectedVersion: defaultTransfer.version,
      candidate: prepare.candidate!,
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('ROUTING_DECISION_NOT_FOUND');
  });

  it('29c. routing event attemptId mutation EA->EB fails closed', async () => {
    const prepare = await authService.prepareHandoffSuccessorAuthorization({ transferId: defaultTransfer.id });
    db.prepare("UPDATE events SET structured_payload_json = json_set(structured_payload_json, '$.attemptId', 'att-tampered') WHERE id = (SELECT id FROM events WHERE type = 'ROLE_AWARE_ROUTING_DECISION' LIMIT 1)").run();
    const res = repo.resumeHandoffSuccessorAuthorization({
      transferId: defaultTransfer.id,
      expectedVersion: defaultTransfer.version,
      candidate: prepare.candidate!,
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('ROUTING_DECISION_NOT_FOUND');
  });

  it('29d. route canonical spec mutation without matching hash change fails', async () => {
    const asgn = repo.getAgentAssignment(defaultAssignment.id)!;
    const meta = asgn.preferred_metadata as any;
    meta.handoff_route_spec.extra = 'unhashed';
    db.prepare("UPDATE agent_assignments SET preferred_metadata_json = ? WHERE id = ?").run(JSON.stringify(meta), defaultAssignment.id);

    const prepareRes = await authService.prepareHandoffSuccessorAuthorization({ transferId: defaultTransfer.id });
    expect(prepareRes.success).toBe(false);
    expect(prepareRes.errorCode).toBe('ROUTE_METADATA_CORRUPT');
  });

  it('29e. stored route hash mutation fails', async () => {
    const asgn = repo.getAgentAssignment(defaultAssignment.id)!;
    const meta = asgn.preferred_metadata as any;
    meta.handoff_route_spec_hash = 'tampered_hash';
    db.prepare("UPDATE agent_assignments SET preferred_metadata_json = ? WHERE id = ?").run(JSON.stringify(meta), defaultAssignment.id);

    const prepareRes = await authService.prepareHandoffSuccessorAuthorization({ transferId: defaultTransfer.id });
    expect(prepareRes.success).toBe(false);
    expect(prepareRes.errorCode).toBe('ROUTE_METADATA_CORRUPT');
  });

  it('30. assignment mutation EA->EB fails closed', async () => {
    const prepare = await authService.prepareHandoffSuccessorAuthorization({ transferId: defaultTransfer.id });
    db.prepare('UPDATE agent_assignments SET attempt_id = ? WHERE id = ?').run(sourceAttemptId, defaultAssignment.id);

    const res = repo.resumeHandoffSuccessorAuthorization({
      transferId: defaultTransfer.id,
      expectedVersion: defaultTransfer.version,
      candidate: prepare.candidate!,
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('ROUTE_METADATA_CORRUPTION');
  });

  it('31. auth task_ownership_epoch equals successor epoch, never default 1', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(resumeRes.authorization!.task_ownership_epoch).toBe(2);
    expect(resumeRes.authorization!.task_ownership_epoch).not.toBe(1);
  });

  it('32. authorization content mismatch replay fails closed', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const auth = resumeRes.authorization!;

    // Attempt replay with mismatched candidate base_sha
    const corruptCandidate = { ...auth, base_sha: 'corrupted_sha' };
    const replayRes = repo.resumeHandoffSuccessorAuthorization({
      transferId: defaultTransfer.id,
      expectedVersion: resumeRes.transfer!.version,
      candidate: corruptCandidate,
    });
    expect(replayRes.success).toBe(false);
    expect(replayRes.errorCode).toBe('AUTHORIZATION_CONTENT_MISMATCH');
  });

  it('33. INVALIDATED auth never replaced', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    repo.invalidateExecutionAuthorization(resumeRes.authorization!.id);

    const retryRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(retryRes.success).toBe(false);
    expect(retryRes.errorCode).toBe('STATUS_CONFLICT');
  });

  it('34. DISPATCHED auth converges to already-dispatched replay without generating second row', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    repo.claimExecutionAuthorization(resumeRes.authorization!.id, new Date().toISOString());

    const retryRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(retryRes.success).toBe(true);
    expect(retryRes.alreadyAuthorized).toBe(true);
    expect(retryRes.authorization!.id).toBe(resumeRes.authorization!.id);
  });

  // ==========================================
  // D. OWNER POLICY (Tests 35-38)
  // ==========================================

  it('35. ALLOW verification command authorizes normally', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(resumeRes.success).toBe(true);
  });

  it('36. REQUIRES_OWNER_APPROVAL returns NEEDS_OWNER with zero auth created', async () => {
    repo.createVerificationCommand({
      id: 'vcmd-owner-1',
      project_id: projectId,
      name: 'Owner Script',
      command_type: 'TEST',
      executable: 'bash',
      args: ['-c', 'echo hi'],
      enabled: true,
    });

    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(resumeRes.success).toBe(false);
    expect(resumeRes.errorCode).toBe('NEEDS_OWNER');
  });

  it('37. DENY returns POLICY_DENIED with zero auth created', async () => {
    repo.createVerificationCommand({
      id: 'vcmd-deny-1',
      project_id: projectId,
      name: 'Deny Script',
      command_type: 'TEST',
      executable: 'git',
      args: ['reset', '--hard'],
      enabled: true,
    });

    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(resumeRes.success).toBe(false);
    expect(resumeRes.errorCode).toBe('POLICY_DENIED');
    const authRows = db.prepare('SELECT COUNT(*) as count FROM execution_authorizations').get() as { count: number };
    expect(authRows.count).toBe(0);
  });

  it('38. generic APPROVED row in approvals table cannot bypass process policy', async () => {
    db.prepare(`
      INSERT INTO approvals (id, project_id, task_id, requested_by, approved_by, action_type, status, created_at)
      VALUES ('appr-1', ?, ?, NULL, 'owner', 'EXECUTE', 'APPROVED', ?)
    `).run(projectId, taskId, new Date().toISOString());

    repo.createVerificationCommand({
      id: 'vcmd-deny-2',
      project_id: projectId,
      name: 'Deny Script 2',
      command_type: 'TEST',
      executable: 'git',
      args: ['reset', '--hard'],
      enabled: true,
    });

    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(resumeRes.success).toBe(false);
    expect(resumeRes.errorCode).toBe('POLICY_DENIED');
  });

  // ==========================================
  // E. HEALTH / QUOTA (Tests 39-45)
  // ==========================================

  it('39. provider disabled fails closed', async () => {
    db.prepare('UPDATE providers SET enabled = 0 WHERE id = ?').run(providerBId);
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(resumeRes.success).toBe(false);
    expect(resumeRes.errorCode).toBe('PROVIDER_DISABLED');
  });

  it('40. account AUTH_ERROR fails closed', async () => {
    db.prepare("UPDATE provider_accounts SET health_status = 'AUTH_ERROR' WHERE id = ?").run(accountBId);
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(resumeRes.success).toBe(false);
    expect(resumeRes.errorCode).toBe('PROVIDER_ACCOUNT_UNSAFE_HEALTH');
  });

  it('41. account COOLDOWN fails for scheduled execution', async () => {
    const futureIso = new Date(Date.now() + 60000).toISOString();
    db.prepare('UPDATE provider_accounts SET cooldown_until = ? WHERE id = ?').run(futureIso, accountBId);
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(resumeRes.success).toBe(false);
    expect(resumeRes.errorCode).toBe('PROVIDER_ACCOUNT_UNSAFE_HEALTH');
  });

  it('42. unsafe watermark fails closed', async () => {
    // Create an unapplied ordered provider health observation for account B
    const oldAuth: ExecutionAuthorization = {
      id: 'auth-obs-watermark-1',
      project_id: projectId,
      task_id: taskId,
      attempt_id: sourceAttemptId,
      task_revision: 1,
      base_sha: baseSha,
      repository_head_sha: baseSha,
      manager_message_id: 'msg-manager-1',
      manager_payload_hash: managerHash,
      routing_decision_id: defaultRoutingDecisionId,
      selected_resource_id: resourceBId,
      selected_provider_id: providerBId,
      instruction_payload_hash: 'h1',
      context_manifest_hash: 'h2',
      canonical_instructions_json: '[]',
      context_files_json: '[]',
      canonical_payload_json: null,
      status: 'DISPATCHED',
      created_at: new Date().toISOString(),
      dispatched_at: new Date().toISOString(),
      task_ownership_epoch: 1,
      assignment_id: sourceAssignmentId,
    };
    repo.createExecutionAuthorization(oldAuth);

    db.prepare(`
      INSERT INTO provider_health_observations (
        authorization_id, execution_id, account_id, provider_id, resource_id,
        assignment_id, attempt_id, routing_decision_id, provenance_version,
        provenance_source, mode, adapter_invocation, result_status,
        classified_category, observed_at, account_order, health_action_plan_version,
        health_action
      ) VALUES (
        'auth-obs-watermark-1', 'exec-obs-1', ?, ?, ?, ?, ?, ?, 1,
        'PROVIDER_DISPATCH_SERVICE', 'SCHEDULED', 'RETURNED', 'FAILED',
        'AUTH_ERROR', ?, 1, 1, 'RECORD_AUTH_ERROR'
      )
    `).run(
      accountBId,
      providerBId,
      resourceBId,
      sourceAssignmentId,
      sourceAttemptId,
      defaultRoutingDecisionId,
      new Date().toISOString()
    );

    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(resumeRes.success).toBe(false);
    expect(resumeRes.errorCode).toBe('PROVIDER_HEALTH_UNSAFE');
  });

  it('43. resource unsafe health fails closed', async () => {
    db.prepare("UPDATE provider_resources SET health_status = 'UNHEALTHY' WHERE id = ?").run(resourceBId);
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(resumeRes.success).toBe(false);
    expect(resumeRes.errorCode).toBe('PROVIDER_RESOURCE_UNSAFE_HEALTH');
  });

  it('44. authoritative non-null quota <= 0 fails closed', async () => {
    db.prepare("UPDATE provider_resources SET remaining_quota = 0, quota_source = 'PROVIDER_REPORTED' WHERE id = ?").run(resourceBId);
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(resumeRes.success).toBe(false);
    expect(resumeRes.errorCode).toBe('PROVIDER_RESOURCE_QUOTA_EXHAUSTED');
  });

  it('45. UNKNOWN/ESTIMATED quota does not fail solely because remaining quota is NULL', async () => {
    db.prepare("UPDATE provider_resources SET remaining_quota = NULL, quota_source = 'ESTIMATED' WHERE id = ?").run(resourceBId);
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(resumeRes.success).toBe(true);
  });

  // ==========================================
  // F. LEASE / ACCEPTANCE (Tests 46-60)
  // ==========================================

  it('46. scheduler performs exactly one first acquireForAssignment and accepts execution', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const schedRes = await scheduler.execute(resumeRes.authorization!.id);
    expect(schedRes.status).toBe('COMPLETED');

    const transfer = repo.getHandoffTransfer(defaultTransfer.id)!;
    expect(['ACCEPTED', 'COMPLETED']).toContain(transfer.status);
    expect(transfer.accepted_at).not.toBeNull();
  });

  it('46b. scheduler corrupted R5I route fails BEFORE lease creation', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    db.prepare("UPDATE agent_assignments SET preferred_metadata_json = '{\"corrupt\": true}' WHERE id = ?").run(defaultAssignment.id);

    const schedRes = await scheduler.execute(resumeRes.authorization!.id);
    expect(schedRes.status).toBe('PREPARATION_FAILED');
    expect(schedRes.errorCode).toBe('ROUTE_METADATA_CORRUPTION');

    // Prove ZERO lease created
    const leases = db.prepare('SELECT COUNT(*) as count FROM account_leases').get() as { count: number };
    expect(leases.count).toBe(0);
    const transfer = repo.getHandoffTransfer(defaultTransfer.id)!;
    expect(transfer.status).toBe('AUTHORIZED');
    const attempt = repo.getTaskAttempt(successorAttemptId)!;
    expect(attempt.status).toBe('PENDING');
    const assignment = repo.getAgentAssignment(defaultAssignment.id)!;
    expect(assignment.status).toBe('ASSIGNED');
  });

  it('46c. scheduler corrupted context fails BEFORE lease creation', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    db.prepare("UPDATE context_manifests SET manifest_hash = 'corrupt' WHERE id = ?").run(defaultManifestId);

    const schedRes = await scheduler.execute(resumeRes.authorization!.id);
    expect(schedRes.status).toBe('PREPARATION_FAILED');
    expect(schedRes.errorCode).toBe('CONTEXT_MANIFEST_INTEGRITY_FAILED');

    // Prove ZERO lease created
    const leases = db.prepare('SELECT COUNT(*) as count FROM account_leases').get() as { count: number };
    expect(leases.count).toBe(0);
    const transfer = repo.getHandoffTransfer(defaultTransfer.id)!;
    expect(transfer.status).toBe('AUTHORIZED');
    const attempt = repo.getTaskAttempt(successorAttemptId)!;
    expect(attempt.status).toBe('PENDING');
    const assignment = repo.getAgentAssignment(defaultAssignment.id)!;
    expect(assignment.status).toBe('ASSIGNED');
  });

  it('47. wrong lease token fails acceptance primitive', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);
    expect(leaseRes.status).toBe('ACQUIRED');

    const acceptRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: 'token-wrong',
      expectedSuccessorEpoch: 2,
    });
    expect(acceptRes.success).toBe(false);
    expect(acceptRes.errorCode).toBe('LEASE_TOKEN_MISMATCH');
  });

  it('47b. first ACCEPT with auth INVALIDATED fails closed with zero state mutation', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    repo.invalidateExecutionAuthorization(resumeRes.authorization!.id);
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);

    const acceptRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(acceptRes.success).toBe(false);
    expect(acceptRes.errorCode).toBe('STATUS_CONFLICT');

    // Verify zero mutation
    const transfer = repo.getHandoffTransfer(defaultTransfer.id)!;
    expect(transfer.status).toBe('AUTHORIZED');
    const attempt = repo.getTaskAttempt(successorAttemptId)!;
    expect(attempt.status).toBe('PENDING');
    const assignment = repo.getAgentAssignment(defaultAssignment.id)!;
    expect(assignment.status).toBe('ASSIGNED');
  });

  it('47c. first ACCEPT with auth DISPATCHED fails closed with zero state mutation', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    repo.claimExecutionAuthorization(resumeRes.authorization!.id, new Date().toISOString());
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);

    const acceptRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(acceptRes.success).toBe(false);
    expect(acceptRes.errorCode).toBe('STATUS_CONFLICT');

    const transfer = repo.getHandoffTransfer(defaultTransfer.id)!;
    expect(transfer.status).toBe('AUTHORIZED');
    const attempt = repo.getTaskAttempt(successorAttemptId)!;
    expect(attempt.status).toBe('PENDING');
    const assignment = repo.getAgentAssignment(defaultAssignment.id)!;
    expect(assignment.status).toBe('ASSIGNED');
  });

  it('47d. ACCEPT fails on corrupted route metadata before activation', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);

    // Corrupt route metadata
    db.prepare("UPDATE agent_assignments SET preferred_metadata_json = '{\"corrupt\": true}' WHERE id = ?").run(defaultAssignment.id);

    const acceptRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(acceptRes.success).toBe(false);
    expect(acceptRes.errorCode).toBe('ROUTE_METADATA_CORRUPTION');
  });

  it('47e. ACCEPT fails on corrupted R5I3 context before activation', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);

    // Corrupt context manifest
    db.prepare("UPDATE context_manifests SET manifest_hash = 'corrupt' WHERE id = ?").run(defaultManifestId);

    const acceptRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(acceptRes.success).toBe(false);
    expect(acceptRes.errorCode).toBe('CONTEXT_MANIFEST_INTEGRITY_FAILED');
  });

  it('48. expired lease fails acceptance primitive', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);
    expect(leaseRes.status).toBe('ACQUIRED');

    // Expire lease
    const pastIso = new Date(Date.now() - 5000).toISOString();
    db.prepare('UPDATE account_leases SET expires_at = ? WHERE id = ?').run(pastIso, (leaseRes as any).lease.id);

    const acceptRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(acceptRes.success).toBe(false);
    expect(acceptRes.errorCode).toBe('LEASE_EXPIRED');
  });

  it('49. released lease fails first acceptance', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);
    leaseService.release((leaseRes as any).lease.id, (leaseRes as any).lease.lease_token);

    const acceptRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(acceptRes.success).toBe(false);
    expect(acceptRes.errorCode).toBe('LEASE_RELEASED');
  });

  it('50. wrong slot/assignment lease chain fails acceptance', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);

    // Create another slot to test mismatch
    const slotOtherId = 'slot-other-r5i5';
    repo.createWorkerSlot({
      id: slotOtherId,
      provider_account_id: accountBId,
      provider_resource_id: resourceBId,
      slot_index: 1,
      status: 'IDLE',
      current_assignment_id: null,
      current_execution_id: null,
      heartbeat_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    db.prepare('UPDATE account_leases SET worker_slot_id = ? WHERE id = ?').run(slotOtherId, (leaseRes as any).lease.id);

    const acceptRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(acceptRes.success).toBe(false);
    expect(acceptRes.errorCode).toBe('LEASE_INTEGRITY_MISMATCH');
  });

  it('51. WorkerSlot remains LEASED after ACCEPTED', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);

    const acceptRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(acceptRes.success).toBe(true);

    const slot = repo.getWorkerSlot(slotBId)!;
    expect(slot.status).toBe('LEASED');
    expect(slot.status).not.toBe('RUNNING');
  });

  it('52. heartbeat remains valid after ACCEPTED', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);

    repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });

    const beatRes = leaseService.heartbeat((leaseRes as any).lease.id, (leaseRes as any).lease.lease_token, 60000);
    expect(beatRes.status).toBe('HEARTBEAT_ACKNOWLEDGED');
  });

  it('53. PENDING -> RUNNING occurs exactly once on TaskAttempt', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);

    const acceptRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(acceptRes.attempt!.status).toBe('RUNNING');
  });

  it('54. RUNNING attempt replay does not change started_at', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);

    const accept1 = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    const startedAt1 = accept1.attempt!.started_at;

    const accept2 = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(accept2.alreadyAccepted).toBe(true);
    expect(accept2.attempt!.started_at).toBe(startedAt1);
  });

  it('55. ASSIGNED -> RUNNING occurs exactly once on AgentAssignment', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);

    const acceptRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(acceptRes.assignment!.status).toBe('RUNNING');
  });

  it('56. RUNNING assignment replay is read-only', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);

    repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });

    const replayRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(replayRes.alreadyAccepted).toBe(true);
    expect(replayRes.assignment!.status).toBe('RUNNING');
  });

  it('57. AUTHORIZED -> ACCEPTED occurs exactly once on HandoffTransfer', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);

    const acceptRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(acceptRes.transfer!.status).toBe('ACCEPTED');
    expect(acceptRes.transfer!.version).toBe(defaultTransfer.version + 2); // 4 -> 5 (AUTH) -> 6 (ACCEPT)
  });

  it('58. ACCEPTED replay does not change accepted_at or increment version', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);

    const accept1 = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    const version1 = accept1.transfer!.version;
    const acceptedAt1 = accept1.transfer!.accepted_at;

    const accept2 = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(accept2.alreadyAccepted).toBe(true);
    expect(accept2.transfer!.version).toBe(version1);
    expect(accept2.transfer!.accepted_at).toBe(acceptedAt1);
  });

  it('58b. ACCEPTED replay fails on context corruption', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);
    const accept1 = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(accept1.success).toBe(true);

    // Corrupt manifest
    db.prepare("UPDATE context_manifests SET manifest_hash = 'corrupt' WHERE id = ?").run(defaultManifestId);

    const replayRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(replayRes.success).toBe(false);
    expect(replayRes.errorCode).toBe('CONTEXT_MANIFEST_INTEGRITY_FAILED');
  });

  it('58c. ACCEPTED replay fails on route corruption', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);
    const accept1 = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(accept1.success).toBe(true);

    // Corrupt route spec
    db.prepare("UPDATE agent_assignments SET preferred_metadata_json = '{\"corrupt\": true}' WHERE id = ?").run(defaultAssignment.id);

    const replayRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(replayRes.success).toBe(false);
    expect(replayRes.errorCode).toBe('ROUTE_METADATA_CORRUPTION');
  });

  it('59. historically released accepted lease replay is read-only and requires accepted_at inside interval', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);

    repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });

    // Release lease after acceptance
    leaseService.release((leaseRes as any).lease.id, (leaseRes as any).lease.lease_token);

    const replayRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(replayRes.success).toBe(true);
    expect(replayRes.alreadyAccepted).toBe(true);
  });

  it('59b. historically released replay rejects wrong token', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);
    repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    leaseService.release((leaseRes as any).lease.id, (leaseRes as any).lease.lease_token);

    const replayRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: 'token-wrong',
      expectedSuccessorEpoch: 2,
    });
    expect(replayRes.success).toBe(false);
    expect(replayRes.errorCode).toBe('LEASE_INTEGRITY_MISMATCH');
  });

  it('59c. historically released replay rejects wrong worker slot', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);
    repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    leaseService.release((leaseRes as any).lease.id, (leaseRes as any).lease.lease_token);

    // Create another valid worker slot to avoid foreign key error
    repo.createWorkerSlot({
      id: 'slot-tampered',
      provider_account_id: accountBId,
      provider_resource_id: resourceBId,
      slot_index: 99,
      status: 'IDLE',
      current_assignment_id: null,
      current_execution_id: null,
      heartbeat_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Tamper with worker_slot_id on historical lease
    db.prepare("UPDATE account_leases SET worker_slot_id = 'slot-tampered' WHERE id = ?").run((leaseRes as any).lease.id);

    const replayRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(replayRes.success).toBe(false);
    expect(replayRes.errorCode).toBe('LEASE_INTEGRITY_MISMATCH');
  });

  it('60. accept failure before dispatch releases owned lease and does not mark ACCEPTED', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    // Sabotage attempt to make acceptance fail
    db.prepare("UPDATE task_attempts SET status = 'FAILED' WHERE id = ?").run(successorAttemptId);

    const schedRes = await scheduler.execute(resumeRes.authorization!.id);
    expect(schedRes.status).toBe('PREPARATION_FAILED');
    expect(schedRes.error).toContain('ACCEPTANCE_FAILED');

    // Verify slot is idle/released
    const slot = repo.getWorkerSlot(slotBId)!;
    expect(slot.status).toBe('IDLE');
    const transfer = repo.getHandoffTransfer(defaultTransfer.id)!;
    expect(transfer.status).toBe('AUTHORIZED'); // not accepted
  });

  // ==========================================
  // G. DISPATCH (Tests 61-69)
  // ==========================================

  it('61. R5I dispatch refuses transfer in AUTHORIZED state', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    // Attempt direct dispatch without acceptance
    const dispatchRes = await dispatchService.dispatchScheduled(resumeRes.authorization!.id);
    expect(dispatchRes.status).toBe('FAILED');
    expect(dispatchRes.error).toContain('EXECUTION_AUTHORIZATION_NOT_ACCEPTED');
  });

  it('62. R5I dispatch requires transfer in ACCEPTED state', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(resumeRes.success).toBe(true);
    const schedRes = await scheduler.execute(resumeRes.authorization!.id);
    expect(schedRes.status).toBe('COMPLETED');
  });

  it('63. stale ownership epoch rejected before authorization claim', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);
    repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });

    // Stale task epoch
    db.prepare('UPDATE tasks SET ownership_epoch = 3 WHERE id = ?').run(taskId);

    const dispatchRes = await dispatchService.dispatchScheduled(resumeRes.authorization!.id);
    expect(dispatchRes.status).toBe('FAILED');
    expect(dispatchRes.error).toMatch(/EXECUTION_AUTHORIZATION_STALE_TASK_EPOCH|EXECUTION_AUTHORIZATION_INVALID/);
  });

  it('64. missing/expired/released active lease rejected before claim in scheduled dispatch', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);
    repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });

    // Release lease
    leaseService.release((leaseRes as any).lease.id, (leaseRes as any).lease.lease_token);

    const dispatchRes = await dispatchService.dispatchScheduled(resumeRes.authorization!.id);
    expect(dispatchRes.status).toBe('FAILED');
    expect(dispatchRes.error).toContain('SCHEDULED_LEASE_REQUIRED');
  });

  it('65. attempt not RUNNING rejected before dispatch claim', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);
    repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });

    db.prepare("UPDATE task_attempts SET status = 'FAILED' WHERE id = ?").run(successorAttemptId);

    const dispatchRes = await dispatchService.dispatchScheduled(resumeRes.authorization!.id);
    expect(dispatchRes.status).toBe('FAILED');
    expect(dispatchRes.error).toContain('EXECUTION_AUTHORIZATION_ATTEMPT_NOT_RUNNING');
  });

  it('66. assignment not RUNNING rejected before dispatch claim', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);
    repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });

    db.prepare("UPDATE agent_assignments SET status = 'HANDED_OFF' WHERE id = ?").run(defaultAssignment.id);

    const dispatchRes = await dispatchService.dispatchScheduled(resumeRes.authorization!.id);
    expect(dispatchRes.status).toBe('FAILED');
    expect(dispatchRes.error).toContain('ROUTING_ASSIGNMENT_STATUS_INVALID');
  });

  it('67. same authorization second dispatch claim rejected', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);
    repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });

    // First claim
    const claimed = repo.claimExecutionAuthorization(resumeRes.authorization!.id, new Date().toISOString());
    expect(claimed).toBe(true);

    // Second claim
    const claim2 = repo.claimExecutionAuthorization(resumeRes.authorization!.id, new Date().toISOString());
    expect(claim2).toBe(false);
  });

  it('68. legacy ProviderDispatch remains functional', async () => {
    const legacyDecId = 'dec-leg-dispatch';
    const legacyAsgnId = 'asgn-leg-dispatch';
    repo.createAgentAssignment({
      id: legacyAsgnId,
      project_id: projectId,
      task_id: taskId,
      attempt_id: sourceAttemptId,
      role_profile_id: roleProfileId,
      agent_profile_id: agentProfileId,
      selected_provider_id: providerBId,
      selected_account_id: accountBId,
      selected_resource_id: resourceBId,
      selected_worker_slot_id: null,
      routing_decision_id: legacyDecId,
      preferred_metadata: null,
      ended_at: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
    });

    eventService.record(
      projectId,
      'ROLE_AWARE_ROUTING_DECISION',
      'Legacy routing decision',
      {
        projectId,
        taskId,
        attemptId: sourceAttemptId,
        decisionId: legacyDecId,
        outcome: 'SELECTED',
        selectedProviderId: providerBId,
        selectedAccountId: accountBId,
        selectedResourceId: resourceBId,
        selectedAssignmentId: legacyAsgnId,
        roleProfileId,
      },
      taskId
    );

    const effectiveConstraints = ['Verify worktree', 'Verify worktree'];
    const instructions = ['Continue with successor execution'];
    const contextFiles = ['src_file.ts'];
    const canonicalPayload = computeCanonicalPayload({
      projectId,
      taskId,
      attemptId: sourceAttemptId,
      taskTitle: 'R5I5 Task Title',
      taskDescription: 'R5I5 Task Description',
      acceptanceCriteria: ['Pass tests', 'Idempotent resume'],
      constraints: effectiveConstraints,
      instructions,
      contextFiles,
      verificationCommands: { TEST: null, LINT: null, BUILD: null },
      managerMessageId: 'msg-manager-1',
      managerPayloadHash: managerHash,
    });
    const canonicalPayloadJson = JSON.stringify(canonicalPayload);
    const instructionPayloadHash = computePayloadHash(canonicalPayload);
    const contextManifestHash = computeContextManifestHash(contextFiles);

    const legacyAuth: ExecutionAuthorization = {
      id: 'auth-legacy-dispatch',
      project_id: projectId,
      task_id: taskId,
      attempt_id: sourceAttemptId,
      task_revision: 1,
      base_sha: baseSha,
      repository_head_sha: baseSha,
      manager_message_id: 'msg-manager-1',
      manager_payload_hash: managerHash,
      routing_decision_id: legacyDecId,
      selected_resource_id: resourceBId,
      selected_provider_id: providerBId,
      instruction_payload_hash: instructionPayloadHash,
      context_manifest_hash: contextManifestHash,
      canonical_instructions_json: JSON.stringify(instructions),
      context_files_json: JSON.stringify(contextFiles),
      canonical_payload_json: canonicalPayloadJson,
      status: 'AUTHORIZED',
      created_at: new Date().toISOString(),
      dispatched_at: null,
      task_ownership_epoch: 2,
      assignment_id: null,
    };
    repo.createExecutionAuthorization(legacyAuth);

    const res = await dispatchService.dispatch(legacyAuth.id);
    expect(res.status).toBe('COMPLETED');
  });

  it('69. legacy scheduler remains functional', async () => {
    const legacyDecId = 'dec-leg-sched';
    const legacyAsgnId = 'asgn-leg-sched';
    repo.createAgentAssignment({
      id: legacyAsgnId,
      project_id: projectId,
      task_id: taskId,
      attempt_id: sourceAttemptId,
      role_profile_id: roleProfileId,
      agent_profile_id: agentProfileId,
      selected_provider_id: providerBId,
      selected_account_id: accountBId,
      selected_resource_id: resourceBId,
      selected_worker_slot_id: null,
      routing_decision_id: legacyDecId,
      preferred_metadata: null,
      ended_at: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
    });

    eventService.record(
      projectId,
      'ROLE_AWARE_ROUTING_DECISION',
      'Legacy routing decision',
      {
        projectId,
        taskId,
        attemptId: sourceAttemptId,
        decisionId: legacyDecId,
        outcome: 'SELECTED',
        selectedProviderId: providerBId,
        selectedAccountId: accountBId,
        selectedResourceId: resourceBId,
        selectedAssignmentId: legacyAsgnId,
        roleProfileId,
      },
      taskId
    );

    const effectiveConstraints = ['Verify worktree', 'Verify worktree'];
    const instructions = ['Continue with successor execution'];
    const contextFiles = ['src_file.ts'];
    const canonicalPayload = computeCanonicalPayload({
      projectId,
      taskId,
      attemptId: sourceAttemptId,
      taskTitle: 'R5I5 Task Title',
      taskDescription: 'R5I5 Task Description',
      acceptanceCriteria: ['Pass tests', 'Idempotent resume'],
      constraints: effectiveConstraints,
      instructions,
      contextFiles,
      verificationCommands: { TEST: null, LINT: null, BUILD: null },
      managerMessageId: 'msg-manager-1',
      managerPayloadHash: managerHash,
    });
    const canonicalPayloadJson = JSON.stringify(canonicalPayload);
    const instructionPayloadHash = computePayloadHash(canonicalPayload);
    const contextManifestHash = computeContextManifestHash(contextFiles);

    const legacyAuth: ExecutionAuthorization = {
      id: 'auth-legacy-sched',
      project_id: projectId,
      task_id: taskId,
      attempt_id: sourceAttemptId,
      task_revision: 1,
      base_sha: baseSha,
      repository_head_sha: baseSha,
      manager_message_id: 'msg-manager-1',
      manager_payload_hash: managerHash,
      routing_decision_id: legacyDecId,
      selected_resource_id: resourceBId,
      selected_provider_id: providerBId,
      instruction_payload_hash: instructionPayloadHash,
      context_manifest_hash: contextManifestHash,
      canonical_instructions_json: JSON.stringify(instructions),
      context_files_json: JSON.stringify(contextFiles),
      canonical_payload_json: canonicalPayloadJson,
      status: 'AUTHORIZED',
      created_at: new Date().toISOString(),
      dispatched_at: null,
      task_ownership_epoch: 2,
      assignment_id: null,
    };
    repo.createExecutionAuthorization(legacyAuth);

    const res = await scheduler.execute(legacyAuth.id);
    expect(res.status).toBe('COMPLETED');
  });

  // ==========================================
  // H. BOUNDARY / REGRESSION (Tests 70-74)
  // ==========================================

  it('70. post-lease crash classified R5I6, no automatic second lease acquisition', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    // Simulate live lease acquired by crashed scheduler process
    const liveLease = leaseService.acquireForAssignment(defaultAssignment.id, 60000);
    expect(liveLease.status).toBe('ACQUIRED');

    // A replacement scheduler tries to run
    const schedRes = await scheduler.execute(resumeRes.authorization!.id);
    expect(schedRes.status).toBe('LEASE_ACQUIRE_FAILED');
    expect(schedRes.errorCode).toBe('ASSIGNMENT_ALREADY_LEASED');
  });

  it('71. post-ACCEPTED crash categorized R5I6', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const liveLease = leaseService.acquireForAssignment(defaultAssignment.id, 60000);

    repo.acceptHandoffSuccessorExecution({
      authorizationId: resumeRes.authorization!.id,
      leaseId: (liveLease as any).lease.id,
      leaseToken: (liveLease as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });

    // Process crashed with active lease; replacement cannot acquire lease / run
    const schedRes = await scheduler.execute(resumeRes.authorization!.id);
    expect(schedRes.status).toMatch(/LEASE_ACQUIRE_FAILED|PREPARATION_FAILED/);
  });

  it('72. R5H failover budget is untouched during normal or failed handoff resume', async () => {
    const failoversBefore = db.prepare('SELECT COUNT(*) as count FROM failover_transitions').get() as { count: number };
    await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const failoversAfter = db.prepare('SELECT COUNT(*) as count FROM failover_transitions').get() as { count: number };
    expect(failoversAfter.count).toBe(failoversBefore.count);
  });

  it('73. R5I3 context snapshot integrity invariant preserved across resume', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(resumeRes.success).toBe(true);
    const snap = repo.getContextSnapshot(defaultSnapshotId)!;
    expect(snap.purpose).toBe('HANDOFF');
  });

  it('74. R5I4 route-spec hash invariant preserved across resume', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(resumeRes.success).toBe(true);
    const asgn = repo.getAgentAssignment(defaultAssignment.id)!;
    const meta = asgn.preferred_metadata as any;
    expect(meta.handoff_route_spec_hash).toBeDefined();
  });

  // =========================================================================
  // I. R5I5 SECOND CORRECTIVE: PREDECESSOR CONTEXT & POST-AUTH FENCING (A-O)
  // =========================================================================

  it('75 (A-B). fixture transfer.successor_context_spec_hash equals output of computeSuccessorContextSpecHash for exact R5I3 inputs', async () => {
    const expectedSpecHash = computeSuccessorContextSpecHash({
      transferId: defaultTransfer.id,
      successorAttemptId,
      purpose: 'HANDOFF',
      handoffContextId: null,
      checkpointId: null,
      contextFiles: ['src_file.ts'],
      customItems: [
        {
          itemType: 'PROJECT_MEMORY',
          sourceType: 'MEMORY_STORE',
          sourceRef: 'project-notes',
          content: { note: 'Important project architectural invariant' },
          tokenEstimate: 25,
        },
        {
          itemType: 'TASK_MEMORY',
          sourceType: 'TASK_STORE',
          sourceRef: 'task-progress',
          content: { step: 'Step 1 complete' },
          tokenEstimate: 15,
        },
      ],
    });
    expect(defaultTransfer.successor_context_spec_hash).toBe(expectedSpecHash);
  });

  it('76 (C-D). snapshot and manifest IDs follow exact deterministic R5I3 formulas', async () => {
    const specHash = defaultTransfer.successor_context_spec_hash!;
    const expectedSnapshotId = `ctx-snap-ho-${computeSha256(`r5i-successor-context:${defaultTransfer.id}:${specHash}`).slice(0, 32)}`;
    const expectedManifestId = `ctx-man-ho-${computeSha256(`r5i-successor-manifest:${defaultTransfer.id}:${specHash}`).slice(0, 32)}`;

    expect(defaultSnapshotId).toBe(expectedSnapshotId);
    expect(defaultManifestId).toBe(expectedManifestId);
    expect(defaultTransfer.successor_context_snapshot_id).toBe(expectedSnapshotId);
  });

  it('77 (E). legacy/fake R5I5 tuple-hash is NOT treated as valid R5I3 context-spec authority', async () => {
    // Attempt to seed transfer with fake tuple hash
    const fakeTupleHash = computeSha256(canonicalJsonStringify({
      snapshotId: defaultSnapshotId,
      manifestId: defaultManifestId,
      manifestHash: 'fake-manifest-hash',
    }));
    db.prepare('UPDATE handoff_transfers SET successor_context_spec_hash = ? WHERE id = ?').run(fakeTupleHash, defaultTransfer.id);

    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(resumeRes.success).toBe(false);
    expect(resumeRes.errorCode).toMatch(/CONTEXT_MANIFEST_INTEGRITY_FAILED|CONTEXT_SPEC_HASH_MISMATCH|CONTEXT_SNAPSHOT_MISMATCH/);
  });

  it('78 (F). non-R5I3 snapshot ID is rejected in Phase EB and central validator', async () => {
    const nonR5i3SnapshotId = `ctx-snap-${defaultTransfer.id}-${successorAttemptId}-HANDOFF`;
    const nonR5i3ManifestId = `ctx-man-${nonR5i3SnapshotId}`;
    contextBuilder.buildContextSnapshot({
      projectId,
      taskId,
      attemptId: successorAttemptId,
      purpose: 'HANDOFF',
      snapshotId: nonR5i3SnapshotId,
      manifestId: nonR5i3ManifestId,
      contextFiles: ['src_file.ts'],
      customItems: [],
    });

    db.prepare('UPDATE handoff_transfers SET successor_context_snapshot_id = ? WHERE id = ?').run(nonR5i3SnapshotId, defaultTransfer.id);

    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(resumeRes.success).toBe(false);
    expect(resumeRes.errorCode).toMatch(/CONTEXT_MANIFEST_INTEGRITY_FAILED|CONTEXT_SNAPSHOT_MISMATCH/);
  });

  it('79 (G). non-R5I3 manifest ID is rejected', async () => {
    // Create manifest with non-deterministic ID
    const wrongManifestId = 'ctx-man-wrong-id';
    db.prepare('UPDATE context_manifests SET id = ? WHERE id = ?').run(wrongManifestId, defaultManifestId);

    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(resumeRes.success).toBe(false);
    expect(resumeRes.errorCode).toMatch(/CONTEXT_MANIFEST_NOT_FOUND|CONTEXT_MANIFEST_INTEGRITY_FAILED/);
  });

  it('80 (H). real R5I3-prepared context reaches Phase EA and Phase EB without false mismatch', async () => {
    const prepareRes = await authService.prepareHandoffSuccessorAuthorization({ transferId: defaultTransfer.id });
    expect(prepareRes.success).toBe(true);

    const resumeRes = repo.resumeHandoffSuccessorAuthorization({
      transferId: defaultTransfer.id,
      expectedVersion: defaultTransfer.version,
      candidate: prepareRes.candidate!,
    });
    expect(resumeRes.success).toBe(true);
    expect(resumeRes.authorization).toBeDefined();
  });

  it('81 (I). post-authorization coordinated route mutation fails central validator with AUTHORIZATION_CONTENT_MISMATCH', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(resumeRes.success).toBe(true);
    const authId = resumeRes.authorization!.id;

    // Mutate route spec and compute matching hash
    const mutatedRouteSpec: Record<string, unknown> = {
      transferId: defaultTransfer.id,
      successorAttemptId,
      roleProfileId,
      sourceProviderId: providerAId,
      tampered: true,
    };
    const mutatedRouteSpecHash = computeSha256(canonicalJsonStringify(mutatedRouteSpec));
    const mutatedMetadata = {
      handoff_route_spec_version: 1,
      handoff_route_spec_hash: mutatedRouteSpecHash,
      handoff_route_spec: mutatedRouteSpec,
    };
    db.prepare('UPDATE agent_assignments SET preferred_metadata_json = ? WHERE id = ?').run(
      JSON.stringify(mutatedMetadata),
      defaultAssignment.id
    );

    const validation = repo.validateHandoffSuccessorExecutionAuthority(authId);
    expect(validation.valid).toBe(false);
    expect(validation.errorCode).toBe('AUTHORIZATION_CONTENT_MISMATCH');
  });

  it('82 (J). post-authorization coordinated route mutation fails before first lease through ConcurrentExecutionScheduler', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    expect(resumeRes.success).toBe(true);
    const authId = resumeRes.authorization!.id;

    // Mutate route spec and matching hash
    const mutatedRouteSpec: Record<string, unknown> = {
      transferId: defaultTransfer.id,
      successorAttemptId,
      roleProfileId,
      sourceProviderId: providerAId,
      tampered: true,
    };
    const mutatedRouteSpecHash = computeSha256(canonicalJsonStringify(mutatedRouteSpec));
    const mutatedMetadata = {
      handoff_route_spec_version: 1,
      handoff_route_spec_hash: mutatedRouteSpecHash,
      handoff_route_spec: mutatedRouteSpec,
    };
    db.prepare('UPDATE agent_assignments SET preferred_metadata_json = ? WHERE id = ?').run(
      JSON.stringify(mutatedMetadata),
      defaultAssignment.id
    );

    const leasesBefore = (db.prepare('SELECT COUNT(*) as count FROM account_leases').get() as { count: number }).count;
    const schedRes = await scheduler.execute(authId);
    expect(schedRes.status).toBe('PREPARATION_FAILED');
    expect(schedRes.errorCode).toMatch(/AUTHORIZATION_CONTENT_MISMATCH|AUTHORIZATION_INVALID/);

    const leasesAfter = (db.prepare('SELECT COUNT(*) as count FROM account_leases').get() as { count: number }).count;
    expect(leasesAfter).toBe(leasesBefore);
  });

  it('83 (K). post-authorization coordinated route mutation fails first ACCEPT without mutating state', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const authId = resumeRes.authorization!.id;

    // Mutate route spec and matching hash
    const mutatedRouteSpec: Record<string, unknown> = {
      transferId: defaultTransfer.id,
      successorAttemptId,
      roleProfileId,
      sourceProviderId: providerAId,
      tampered: true,
    };
    const mutatedRouteSpecHash = computeSha256(canonicalJsonStringify(mutatedRouteSpec));
    const mutatedMetadata = {
      handoff_route_spec_version: 1,
      handoff_route_spec_hash: mutatedRouteSpecHash,
      handoff_route_spec: mutatedRouteSpec,
    };
    db.prepare('UPDATE agent_assignments SET preferred_metadata_json = ? WHERE id = ?').run(
      JSON.stringify(mutatedMetadata),
      defaultAssignment.id
    );

    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);
    const acceptRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: authId,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });

    expect(acceptRes.success).toBe(false);
    expect(acceptRes.errorCode).toBe('AUTHORIZATION_CONTENT_MISMATCH');

    // Verify zero state transitions
    const attempt = repo.getTaskAttempt(successorAttemptId)!;
    expect(attempt.status).toBe('PENDING');
    const asgn = repo.getAgentAssignment(defaultAssignment.id)!;
    expect(asgn.status).toBe('ASSIGNED');
    const transfer = repo.getHandoffTransfer(defaultTransfer.id)!;
    expect(transfer.status).toBe('AUTHORIZED');
  });

  it('84 (L). post-authorization coordinated route mutation after ACCEPTED fails replay', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const authId = resumeRes.authorization!.id;

    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);
    const acceptRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: authId,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(acceptRes.success).toBe(true);

    // Mutate route spec and matching hash after ACCEPTED
    const mutatedRouteSpec: Record<string, unknown> = {
      transferId: defaultTransfer.id,
      successorAttemptId,
      roleProfileId,
      sourceProviderId: providerAId,
      tampered: true,
    };
    const mutatedRouteSpecHash = computeSha256(canonicalJsonStringify(mutatedRouteSpec));
    const mutatedMetadata = {
      handoff_route_spec_version: 1,
      handoff_route_spec_hash: mutatedRouteSpecHash,
      handoff_route_spec: mutatedRouteSpec,
    };
    db.prepare('UPDATE agent_assignments SET preferred_metadata_json = ? WHERE id = ?').run(
      JSON.stringify(mutatedMetadata),
      defaultAssignment.id
    );

    const replayRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: authId,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });

    expect(replayRes.success).toBe(false);
    expect(replayRes.errorCode).toBe('AUTHORIZATION_CONTENT_MISMATCH');
  });

  it('85 (M). post-authorization coordinated route mutation before ProviderDispatch claim fails without DISPATCHED status', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const authId = resumeRes.authorization!.id;

    const leaseRes = leaseService.acquireForAssignment(defaultAssignment.id, 60000);
    const acceptRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: authId,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(acceptRes.success).toBe(true);

    // Mutate route spec and matching hash
    const mutatedRouteSpec: Record<string, unknown> = {
      transferId: defaultTransfer.id,
      successorAttemptId,
      roleProfileId,
      sourceProviderId: providerAId,
      tampered: true,
    };
    const mutatedRouteSpecHash = computeSha256(canonicalJsonStringify(mutatedRouteSpec));
    const mutatedMetadata = {
      handoff_route_spec_version: 1,
      handoff_route_spec_hash: mutatedRouteSpecHash,
      handoff_route_spec: mutatedRouteSpec,
    };
    db.prepare('UPDATE agent_assignments SET preferred_metadata_json = ? WHERE id = ?').run(
      JSON.stringify(mutatedMetadata),
      defaultAssignment.id
    );

    const dispatchRes = await dispatchService.dispatchScheduled(authId);
    expect(dispatchRes.status).toBe('FAILED');

    const auth = repo.getExecutionAuthorization(authId)!;
    expect(auth.status).not.toBe('DISPATCHED');
  });

  it('86 (N). mutating successor_context_spec_hash after authorization fails central validator', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const authId = resumeRes.authorization!.id;

    db.prepare("UPDATE handoff_transfers SET successor_context_spec_hash = 'tampered-spec-hash' WHERE id = ?").run(
      defaultTransfer.id
    );

    const validation = repo.validateHandoffSuccessorExecutionAuthority(authId);
    expect(validation.valid).toBe(false);
    expect(validation.errorCode).toMatch(/CONTEXT_SNAPSHOT_MISMATCH|AUTHORIZATION_CONTENT_MISMATCH/);
  });

  it('87 (O). paired mutated context spec hash + replacement deterministic context pointers fails because auth.id is bound to original context spec hash', async () => {
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId: defaultTransfer.id });
    const authId = resumeRes.authorization!.id;

    // Create a new valid context snapshot for a replacement spec hash
    const replacementSpecHash = computeSha256('replacement-context-spec');
    const replacementSnapId = `ctx-snap-ho-${computeSha256(`r5i-successor-context:${defaultTransfer.id}:${replacementSpecHash}`).slice(0, 32)}`;
    const replacementManId = `ctx-man-ho-${computeSha256(`r5i-successor-manifest:${defaultTransfer.id}:${replacementSpecHash}`).slice(0, 32)}`;

    contextBuilder.buildContextSnapshot({
      projectId,
      taskId,
      attemptId: successorAttemptId,
      purpose: 'HANDOFF',
      snapshotId: replacementSnapId,
      manifestId: replacementManId,
      contextFiles: ['src_file.ts'],
      customItems: [],
    });

    // Update transfer with paired replacement spec hash and replacement snapshot ID
    db.prepare('UPDATE handoff_transfers SET successor_context_spec_hash = ?, successor_context_snapshot_id = ? WHERE id = ?').run(
      replacementSpecHash,
      replacementSnapId,
      defaultTransfer.id
    );

    const validation = repo.validateHandoffSuccessorExecutionAuthority(authId);
    expect(validation.valid).toBe(false);
    expect(validation.errorCode).toBe('AUTHORIZATION_CONTENT_MISMATCH');
  });
});
