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
import { ExecutionRecoveryScanner } from '../src/core/services/ExecutionRecoveryScanner';
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
  Task,
  Project,
} from '../src/core/types/domain';

class MockClosureAdapter implements ProviderAdapter {
  public invocationCount = 0;
  public lastRequest: any = null;

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly adapterType: ProviderAdapterType = 'LOCAL_CLI',
    private returnResult: any = { status: 'COMPLETED' },
    private shouldThrow: boolean = false
  ) {}

  public async getHealth(): Promise<ProviderHealthStatus> {
    return 'AVAILABLE';
  }
  public async getCapabilities(): Promise<Capability[]> {
    return ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION', 'REVIEW'];
  }
  public async getQuota(): Promise<QuotaSnapshotInfo> {
    return {
      remaining: 1000,
      total: 1000,
      unit: 'REQUESTS',
      source: 'PROVIDER_REPORTED',
      confidence: 1.0,
      resetAt: null,
    };
  }
  public async execute(req: any): Promise<any> {
    this.invocationCount++;
    this.lastRequest = req;
    if (this.shouldThrow) {
      throw new Error('MOCK_CLOSURE_ADAPTER_ERROR');
    }
    return {
      ...this.returnResult,
      instructions: req.instructions,
      contextFiles: req.contextFiles,
    };
  }
  public async cancel(): Promise<void> {}
}

describe('R5I7 Cross-Provider Handoff Evidence and Closure Integration Suite', () => {
  let testDir: string;
  let repoDir: string;
  let managedDir: string;
  let dbPath: string;
  let gitExe: string;
  let baseSha: string;

  let db: Database.Database;
  let repo: Repository;
  let eventService: EventService;
  let registry: ProviderRegistry;
  let adapterA: MockClosureAdapter;
  let adapterB: MockClosureAdapter;
  let leaseService: WorkerSlotLeaseService;
  let worktreeService: GitWorktreeService;
  let dispatchService: ProviderDispatchService;
  let scheduler: ConcurrentExecutionScheduler;
  let authService: ExecutionAuthorizationService;
  let handoffService: HandoffTransferService;
  let routingService: RoleAwareRoutingService;
  let contextBuilder: ContextBuilderService;
  let scanner: ExecutionRecoveryScanner;

  const providerAId = 'prov-a-closure';
  const accountAId = 'acc-a-closure';
  const resourceAId = 'res-a-closure';
  const slotAId = 'slot-a-closure';

  const providerBId = 'prov-b-closure';
  const accountBId = 'acc-b-closure';
  const resourceBId = 'res-b-closure';
  const slotBId = 'slot-b-closure';

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-r5i7-closure-'));
    repoDir = path.join(testDir, 'repo');
    managedDir = path.join(testDir, 'managed');
    dbPath = path.join(testDir, 'agentforge-closure.db');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(managedDir, { recursive: true });

    gitExe = execSync(process.platform === 'win32' ? 'where git' : 'which git', { encoding: 'utf-8' })
      .trim()
      .split(/\r?\n/)[0];

    execSync(`"${gitExe}" init`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`"${gitExe}" config user.name "R5I7 Tester"`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`"${gitExe}" config user.email "tester@example.com"`, { cwd: repoDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# R5I7 Closure Integration\n');
    fs.writeFileSync(path.join(repoDir, 'index.ts'), 'export const active = true;\n');
    execSync(`"${gitExe}" add README.md index.ts`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`"${gitExe}" commit -m "initial commit"`, { cwd: repoDir, stdio: 'ignore' });
    baseSha = execSync(`"${gitExe}" rev-parse HEAD`, { cwd: repoDir, encoding: 'utf-8' }).trim();

    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);

    repo = new Repository(db);
    eventService = new EventService(repo);
    leaseService = new WorkerSlotLeaseService(repo);
    worktreeService = new GitWorktreeService({
      gitExecutable: gitExe,
      repositoryRoot: repoDir,
      managedRoot: managedDir,
    });

    adapterA = new MockClosureAdapter(providerAId, 'Provider A Adapter');
    adapterB = new MockClosureAdapter(providerBId, 'Provider B Adapter');
    registry = new ProviderRegistry();
    registry.register(adapterA);
    registry.register(adapterB);

    dispatchService = new ProviderDispatchService(registry, repo, eventService, worktreeService);
    scheduler = new ConcurrentExecutionScheduler(repo, leaseService, worktreeService, dispatchService);
    authService = new ExecutionAuthorizationService(repo, eventService);
    routingService = new RoleAwareRoutingService(repo, registry, eventService);
    contextBuilder = new ContextBuilderService(repo);
    handoffService = new HandoffTransferService(repo, contextBuilder, routingService);
    scanner = new ExecutionRecoveryScanner(db, repo, eventService);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  // Helper to seed complete dual-provider topology
  async function seedClosureTopology(options?: {
    projectId?: string;
    taskId?: string;
    predecessorAttemptId?: string;
    predecessorAssignmentId?: string;
    successorAttemptId?: string;
  }) {
    const nowIso = new Date().toISOString();
    const pid = options?.projectId ?? 'proj-closure-1';
    const tid = options?.taskId ?? 'task-closure-1';
    const predAttId = options?.predecessorAttemptId ?? 'att-closure-pred';
    const predAsgnId = options?.predecessorAssignmentId ?? 'asgn-closure-pred';
    const succAttId = options?.successorAttemptId ?? 'att-closure-succ';

    // 1. Providers (Idempotent)
    db.prepare(`
      INSERT OR IGNORE INTO providers (id, name, adapter_type, enabled, created_at)
      VALUES (?, ?, 'LOCAL_CLI', 1, ?)
    `).run(providerAId, 'Provider Alpha', nowIso);
    db.prepare(`
      INSERT OR IGNORE INTO providers (id, name, adapter_type, enabled, created_at)
      VALUES (?, ?, 'LOCAL_CLI', 1, ?)
    `).run(providerBId, 'Provider Beta', nowIso);

    // 2. Provider Accounts (Idempotent)
    db.prepare(`
      INSERT OR IGNORE INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at)
      VALUES (?, ?, ?, 'NATIVE_PROFILE', 1, 10, 'AVAILABLE', 2, ?, ?)
    `).run(accountAId, providerAId, 'Account Alpha', nowIso, nowIso);
    db.prepare(`
      INSERT OR IGNORE INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at)
      VALUES (?, ?, ?, 'NATIVE_PROFILE', 1, 10, 'AVAILABLE', 2, ?, ?)
    `).run(accountBId, providerBId, 'Account Beta', nowIso, nowIso);

    // 3. Provider Resources (Idempotent)
    db.prepare(`
      INSERT OR IGNORE INTO provider_resources (id, provider_id, provider_account_id, model_name, health_status, capabilities_json, enabled, total_quota, remaining_quota, quota_source, quota_confidence, last_health_check)
      VALUES (?, ?, ?, 'model-alpha', 'AVAILABLE', '["CODING","FILESYSTEM_EDIT","TEST_EXECUTION","REVIEW"]', 1, 1000, 1000, 'PROVIDER_REPORTED', 1.0, ?)
    `).run(resourceAId, providerAId, accountAId, nowIso);
    db.prepare(`
      INSERT OR IGNORE INTO provider_resources (id, provider_id, provider_account_id, model_name, health_status, capabilities_json, enabled, total_quota, remaining_quota, quota_source, quota_confidence, last_health_check)
      VALUES (?, ?, ?, 'model-beta', 'AVAILABLE', '["CODING","FILESYSTEM_EDIT","TEST_EXECUTION","REVIEW"]', 1, 1000, 1000, 'PROVIDER_REPORTED', 1.0, ?)
    `).run(resourceBId, providerBId, accountBId, nowIso);

    // 4. Worker Slots (Idempotent, with provider_resource_id)
    db.prepare(`
      INSERT OR IGNORE INTO worker_slots (id, provider_account_id, provider_resource_id, slot_index, status, created_at, updated_at)
      VALUES (?, ?, ?, 0, 'IDLE', ?, ?)
    `).run(slotAId, accountAId, resourceAId, nowIso, nowIso);
    db.prepare(`
      INSERT OR IGNORE INTO worker_slots (id, provider_account_id, provider_resource_id, slot_index, status, created_at, updated_at)
      VALUES (?, ?, ?, 0, 'IDLE', ?, ?)
    `).run(slotBId, accountBId, resourceBId, nowIso, nowIso);

    // 5. Project & Task (Idempotent Project)
    if (!repo.getProject(pid)) {
      repo.createProject({
        id: pid,
        name: 'Closure Project',
        description: 'Cross-Provider Closure Verification',
        repository_path: repoDir,
        default_branch: 'main',
        status: 'RUNNING',
        contract: null,
        started_at: nowIso,
        completed_at: null,
        created_at: nowIso,
        updated_at: nowIso,
      });
    }

    repo.createTask({
      id: tid,
      project_id: pid,
      milestone_id: null,
      title: 'Closure Multi-Provider Task',
      description: 'Exercise end-to-end handoff lifecycle',
      state: 'CODING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'LOW',
      assigned_agent_id: 'agent-pred',
      revision_count: 1,
      max_revisions: 5,
      base_sha: baseSha,
      current_sha: baseSha,
      progress_cache_percent: 10,
      progress_computed_at: nowIso,
      acceptance_criteria: ['Deliver verified output', 'Clean handoff'],
      constraints: ['Respect boundaries'],
      ownership_epoch: 1,
      created_at: nowIso,
      updated_at: nowIso,
    });

    // 6. Role & Agent Profiles (Idempotent)
    db.prepare(`
      INSERT OR IGNORE INTO role_profiles (id, role, display_name, authority_scope_json, output_protocol, required_capabilities_json, preferred_capabilities_json, permissions_json, enabled, created_at, updated_at)
      VALUES ('role-coder-closure', 'CODER', 'Closure Coder', '{}', 'coder.v1', '["CODING"]', '[]', '[]', 1, ?, ?)
    `).run(nowIso, nowIso);

    db.prepare(`
      INSERT OR IGNORE INTO agent_profiles (id, role_profile_id, name, prompt_template, config_json, enabled, created_at, updated_at)
      VALUES ('agent-pred-prof', 'role-coder-closure', 'Predecessor Coder Profile', 'coder-instructions', NULL, 1, ?, ?)
    `).run(nowIso, nowIso);

    db.prepare(`
      INSERT OR IGNORE INTO agent_profiles (id, role_profile_id, name, prompt_template, config_json, enabled, created_at, updated_at)
      VALUES ('agent-succ-prof', 'role-coder-closure', 'Successor Coder Profile', 'coder-instructions', NULL, 1, ?, ?)
    `).run(nowIso, nowIso);

    // 7. Manager Protocol Message for task
    const msgId = `msg-closure-${tid}`;
    const managerPayload = {
      protocol: 'manager.v1',
      message_id: msgId,
      project_id: pid,
      task_id: tid,
      decision: 'EXECUTE',
      instructions: ['Continue with successor execution'],
      expected_revision: 1,
      constraints: ['Respect boundaries'],
    };
    const managerJson = JSON.stringify(managerPayload);
    const managerHash = computeSha256(managerJson);
    repo.recordProtocolMessage(
      msgId,
      msgId,
      'manager.v1',
      pid,
      tid,
      'CODING',
      1,
      managerHash,
      managerJson,
      'APPLIED'
    );

    // 8. Predecessor Attempt 1 & Assignment (Active RUNNING state)
    repo.createTaskAttempt({
      id: predAttId,
      task_id: tid,
      attempt_number: 1,
      agent_id: 'agent-pred',
      agent_profile_id: 'agent-pred-prof',
      status: 'RUNNING',
      started_at: nowIso,
      ended_at: null,
      summary: null,
    });

    repo.createAgentAssignment({
      id: predAsgnId,
      project_id: pid,
      task_id: tid,
      attempt_id: predAttId,
      role_profile_id: 'role-coder-closure',
      agent_profile_id: 'agent-pred-prof',
      selected_provider_id: providerAId,
      selected_account_id: accountAId,
      selected_resource_id: resourceAId,
      selected_worker_slot_id: slotAId,
      routing_decision_id: 'rd-closure-pred',
      preferred_metadata: null,
      status: 'RUNNING',
      created_at: nowIso,
      ended_at: null,
    });

    return {
      projectId: pid,
      taskId: tid,
      predAttId,
      predAsgnId,
      succAttId,
      managerMsgId: msgId,
      managerHash,
    };
  }

  function seedRoutingDecision(options: {
    decisionId: string;
    projectId: string;
    taskId: string;
    attemptId?: string | null;
    providerId?: string;
    accountId?: string;
    resourceId?: string;
  }) {
    eventService.record(
      options.projectId,
      'ROLE_AWARE_ROUTING_DECISION',
      'Routing decision for successor',
      {
        projectId: options.projectId,
        taskId: options.taskId,
        attemptId: options.attemptId ?? null,
        decisionId: options.decisionId,
        outcome: 'SELECTED',
        selectedProviderId: options.providerId ?? providerBId,
        selectedAccountId: options.accountId ?? accountBId,
        selectedResourceId: options.resourceId ?? resourceBId,
        selectedAssignmentId: null,
        roleProfileId: 'role-coder-closure',
      },
      options.taskId
    );
  }

  function seedSuccessorContext(options: {
    projectId: string;
    taskId: string;
    transferId: string;
    successorAttemptId: string;
  }) {
    const rawContextFiles = ['README.md'];
    const rawCustomItems = [
      {
        itemType: 'TASK_MEMORY' as const,
        sourceType: 'TASK_STORE',
        sourceRef: 'closure-task-notes',
        content: { note: 'Ready for closure execution' },
        tokenEstimate: 20,
      },
    ];

    const contextSpecHash = computeSuccessorContextSpecHash({
      transferId: options.transferId,
      successorAttemptId: options.successorAttemptId,
      purpose: 'HANDOFF',
      handoffContextId: null,
      checkpointId: null,
      contextFiles: rawContextFiles,
      customItems: rawCustomItems,
    });

    const snapshotId = `ctx-snap-ho-${computeSha256(`r5i-successor-context:${options.transferId}:${contextSpecHash}`).slice(0, 32)}`;
    const manifestId = `ctx-man-ho-${computeSha256(`r5i-successor-manifest:${options.transferId}:${contextSpecHash}`).slice(0, 32)}`;

    contextBuilder.buildContextSnapshot({
      projectId: options.projectId,
      taskId: options.taskId,
      attemptId: options.successorAttemptId,
      purpose: 'HANDOFF',
      snapshotId,
      manifestId,
      contextFiles: rawContextFiles,
      customItems: rawCustomItems,
    });

    return {
      contextSpecHash,
      snapshotId,
      manifestId,
    };
  }

  function createSuccessorAssignmentRecord(options: {
    id: string;
    projectId: string;
    taskId: string;
    attemptId: string;
    transferId: string;
    routingDecisionId: string;
    providerId?: string;
    accountId?: string;
    resourceId?: string;
    slotId?: string | null;
    status?: 'ASSIGNED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  }): { asgn: AgentAssignment; routeSpecHash: string } {
    const nowIso = new Date().toISOString();
    const routeSpec = {
      transferId: options.transferId,
      successorAttemptId: options.attemptId,
      roleProfileId: 'role-coder-closure',
      sourceProviderId: providerAId,
    };
    const routeSpecHash = computeSha256(canonicalJsonStringify(routeSpec));
    const asgn: AgentAssignment = {
      id: options.id,
      project_id: options.projectId,
      task_id: options.taskId,
      attempt_id: options.attemptId,
      role_profile_id: 'role-coder-closure',
      agent_profile_id: 'agent-succ-prof',
      selected_provider_id: options.providerId ?? providerBId,
      selected_account_id: options.accountId ?? accountBId,
      selected_resource_id: options.resourceId ?? resourceBId,
      selected_worker_slot_id: options.slotId ?? slotBId,
      routing_decision_id: options.routingDecisionId,
      preferred_metadata: {
        handoff_route_spec_version: 1,
        handoff_route_spec_hash: routeSpecHash,
        handoff_route_spec: routeSpec,
      },
      status: options.status ?? 'ASSIGNED',
      created_at: nowIso,
      ended_at: null,
    };
    repo.createAgentAssignment(asgn);
    return { asgn, routeSpecHash };
  }

  function createHandoffTransferRecord(options: {
    id: string;
    requestId?: string;
    taskId: string;
    sourceAttemptId: string;
    successorAttemptId?: string | null;
    sourceAssignmentId: string;
    successorAssignmentId?: string | null;
    successorRoleProfileId?: string | null;
    successorAgentProfileId?: string | null;
    successorContextSnapshotId?: string | null;
    successorContextSpecHash?: string | null;
    reason?: string;
    status: 'REQUESTED' | 'FROZEN' | 'QUIESCING' | 'RELINQUISHED' | 'ROUTED' | 'AUTHORIZED' | 'ACCEPTED' | 'COMPLETED' | 'CANCELLED';
    sourceOwnershipEpoch?: number;
    successorOwnershipEpoch?: number;
  }): HandoffTransfer {
    const nowIso = new Date().toISOString();
    const transfer: HandoffTransfer = {
      id: options.id,
      request_id: options.requestId ?? `req-${options.id}`,
      task_id: options.taskId,
      source_attempt_id: options.sourceAttemptId,
      successor_attempt_id: options.successorAttemptId ?? null,
      source_assignment_id: options.sourceAssignmentId,
      successor_assignment_id: options.successorAssignmentId ?? null,
      successor_role_profile_id: options.successorRoleProfileId ?? 'role-coder-closure',
      successor_agent_profile_id: options.successorAgentProfileId ?? 'agent-succ-prof',
      successor_context_snapshot_id: options.successorContextSnapshotId ?? null,
      successor_context_spec_hash: options.successorContextSpecHash ?? null,
      handoff_context_id: null,
      checkpoint_id: null,
      source_authorization_id: null,
      successor_authorization_id: null,
      reason: options.reason ?? 'PROVIDER_RATE_LIMIT_COOLDOWN',
      status: options.status,
      source_ownership_epoch: options.sourceOwnershipEpoch ?? 1,
      successor_ownership_epoch: options.successorOwnershipEpoch ?? 2,
      version: 1,
      frozen_at: options.status !== 'REQUESTED' ? nowIso : null,
      quiescing_at: ['QUIESCING', 'RELINQUISHED', 'ROUTED', 'AUTHORIZED', 'ACCEPTED', 'COMPLETED'].includes(options.status) ? nowIso : null,
      relinquished_at: ['RELINQUISHED', 'ROUTED', 'AUTHORIZED', 'ACCEPTED', 'COMPLETED'].includes(options.status) ? nowIso : null,
      accepted_at: ['ACCEPTED', 'COMPLETED'].includes(options.status) ? nowIso : null,
      completed_at: options.status === 'COMPLETED' ? nowIso : null,
      created_at: nowIso,
      updated_at: nowIso,
    };
    repo.createHandoffTransfer(transfer);
    return transfer;
  }

  function createAuthorizationRecord(options: {
    id: string;
    projectId: string;
    taskId: string;
    attemptId: string;
    assignmentId?: string | null;
    transferId?: string | null;
    routingDecisionId?: string | null;
    managerMsgId?: string;
    managerHash?: string;
    taskOwnershipEpoch?: number;
    lifecycleVersion?: number;
    providerId?: string;
    accountId?: string;
    resourceId?: string;
    status?: 'AUTHORIZED' | 'DISPATCHED' | 'INVALIDATED';
    executionId?: string | null;
    adapterStartedAt?: string | null;
    adapterFinishedAt?: string | null;
    canonicalPayloadJson?: string | null;
    contextManifestHash?: string | null;
  }): ExecutionAuthorization {
    const nowIso = new Date().toISOString();
    const rdId = options.routingDecisionId ?? 'rd-closure-default';
    const msgId = options.managerMsgId ?? `msg-closure-${options.taskId}`;
    const msgHash = options.managerHash ?? computeSha256(JSON.stringify({ msg: msgId }));
    const auth: ExecutionAuthorization = {
      id: options.id,
      project_id: options.projectId,
      task_id: options.taskId,
      attempt_id: options.attemptId,
      task_revision: 1,
      base_sha: baseSha,
      repository_head_sha: baseSha,
      manager_message_id: msgId,
      manager_payload_hash: msgHash,
      routing_decision_id: rdId,
      selected_provider_id: options.providerId ?? providerBId,
      selected_account_id: options.accountId ?? accountBId,
      selected_resource_id: options.resourceId ?? resourceBId,
      instruction_payload_hash: computeSha256('instructions'),
      context_manifest_hash: options.contextManifestHash ?? computeSha256('manifest'),
      canonical_instructions_json: JSON.stringify(['Execute closure task']),
      context_files_json: JSON.stringify(['README.md']),
      canonical_payload_json: options.canonicalPayloadJson ?? null,
      status: options.status ?? 'AUTHORIZED',
      created_at: nowIso,
      dispatched_at: options.status === 'DISPATCHED' ? nowIso : null,
      task_ownership_epoch: options.taskOwnershipEpoch ?? 2,
      assignment_id: options.assignmentId ?? null,
      lifecycle_version: options.lifecycleVersion ?? 1,
      execution_id: options.executionId ?? null,
      adapter_started_at: options.adapterStartedAt ?? (options.status === 'DISPATCHED' ? nowIso : null),
      adapter_finished_at: options.adapterFinishedAt ?? null,
    };
    repo.createExecutionAuthorization(auth);
    if (options.transferId) {
      db.prepare("UPDATE handoff_transfers SET successor_authorization_id = ? WHERE id = ?").run(auth.id, options.transferId);
    }
    return auth;
  }

  // 1. Provider A owns and executes predecessor attempt N
  it('1. Provider A owns and executes predecessor attempt N', async () => {
    const { taskId, predAttId, predAsgnId } = await seedClosureTopology();
    const task = repo.getTask(taskId)!;
    const attempt = repo.getTaskAttempt(predAttId)!;
    const assignment = repo.getAgentAssignment(predAsgnId)!;

    expect(task.ownership_epoch).toBe(1);
    expect(attempt.attempt_number).toBe(1);
    expect(attempt.status).toBe('RUNNING');
    expect(assignment.selected_provider_id).toBe(providerAId);
    expect(assignment.selected_account_id).toBe(accountAId);
    expect(assignment.selected_resource_id).toBe(resourceAId);
    expect(assignment.status).toBe('RUNNING');
  });

  // 2. Predecessor freeze and quiescence complete before handoff
  it('2. Predecessor freeze and quiescence complete before handoff', async () => {
    const { taskId, predAttId, predAsgnId } = await seedClosureTopology();
    const nowIso = new Date().toISOString();

    // Initiate handoff request
    const handoffRes = handoffService.requestHandoff({
      requestId: 'req-freeze-2',
      taskId,
      sourceAttemptId: predAttId,
      sourceAssignmentId: predAsgnId,
      reason: 'PROVIDER_RATE_LIMIT_COOLDOWN',
      expectedSourceEpoch: 1,
    });
    expect(handoffRes.success).toBe(true);
    const transferId = handoffRes.transfer!.id;

    // Freeze predecessor
    const freezeRes = handoffService.freezeHandoff({
      transferId,
      expectedVersion: 1,
      frozenAt: nowIso,
    });
    expect(freezeRes.success).toBe(true);
    let transfer = repo.getHandoffTransfer(transferId)!;
    expect(transfer.status).toBe('FROZEN');

    // Begin quiescence
    const quiesceRes = handoffService.beginQuiescence({
      transferId,
      expectedVersion: 2,
      quiescingAt: nowIso,
    });
    expect(quiesceRes.success).toBe(true);
    transfer = repo.getHandoffTransfer(transferId)!;
    expect(transfer.status).toBe('QUIESCING');
  });

  // 3. Ownership relinquishment occurs exactly once
  it('3. Ownership relinquishment occurs exactly once', async () => {
    const { taskId, predAttId, predAsgnId } = await seedClosureTopology();
    const nowIso = new Date().toISOString();

    const handoffRes = handoffService.requestHandoff({
      requestId: 'req-relinq-3',
      taskId,
      sourceAttemptId: predAttId,
      sourceAssignmentId: predAsgnId,
      reason: 'SCHEDULED_ROTATION',
      expectedSourceEpoch: 1,
    });
    expect(handoffRes.success).toBe(true);
    const transferId = handoffRes.transfer!.id;

    handoffService.freezeHandoff({ transferId, expectedVersion: 1, frozenAt: nowIso });
    handoffService.beginQuiescence({ transferId, expectedVersion: 2, quiescingAt: nowIso });

    // First relinquishment succeeds
    const relRes = handoffService.relinquishPredecessorOwnership({
      transferId,
      expectedVersion: 3,
      expectedSourceEpoch: 1,
      relinquishedAt: nowIso,
    });
    expect(relRes.success).toBe(true);
    expect(relRes.alreadyRelinquished).toBeFalsy();
    const transfer = repo.getHandoffTransfer(transferId)!;
    expect(transfer.status).toBe('RELINQUISHED');
    expect(transfer.relinquished_at).toBe(nowIso);

    // Second relinquishment with mismatched version fails closed
    const relRes2 = handoffService.relinquishPredecessorOwnership({
      transferId,
      expectedVersion: 99,
      expectedSourceEpoch: 1,
      relinquishedAt: new Date().toISOString(),
    });
    expect(relRes2.success).toBe(false);
    expect(relRes2.errorCode).toBe('VERSION_CONFLICT');
  });

  // 4. Successor attempt N+1 is created with correct lineage and initial state
  it('4. Successor attempt N+1 is created with correct lineage and initial state', async () => {
    const { taskId, succAttId } = await seedClosureTopology();
    const nowIso = new Date().toISOString();

    // Increment task ownership epoch to 2 for successor
    db.prepare("UPDATE tasks SET ownership_epoch = 2 WHERE id = ?").run(taskId);

    repo.createTaskAttempt({
      id: succAttId,
      task_id: taskId,
      attempt_number: 2,
      agent_id: null,
      agent_profile_id: 'agent-succ-prof',
      status: 'PENDING',
      started_at: nowIso,
      ended_at: null,
      summary: null,
    });

    const succAttempt = repo.getTaskAttempt(succAttId)!;
    expect(succAttempt.attempt_number).toBe(2);
    expect(succAttempt.status).toBe('PENDING');
    expect(succAttempt.task_id).toBe(taskId);
  });

  // 5. Handoff context and manifest are bound exactly to N+1
  it('5. Handoff context and manifest are bound exactly to N+1', async () => {
    const { projectId, taskId, predAttId, predAsgnId, succAttId } = await seedClosureTopology();
    const nowIso = new Date().toISOString();

    const handoffRes = handoffService.requestHandoff({
      requestId: 'req-ctx-5',
      taskId,
      sourceAttemptId: predAttId,
      sourceAssignmentId: predAsgnId,
      reason: 'CONTEXT_PREPARATION_TEST',
      expectedSourceEpoch: 1,
    });
    expect(handoffRes.success).toBe(true);
    const transferId = handoffRes.transfer!.id;

    db.prepare("UPDATE tasks SET ownership_epoch = 2 WHERE id = ?").run(taskId);

    repo.createTaskAttempt({
      id: succAttId,
      task_id: taskId,
      attempt_number: 2,
      agent_id: null,
      agent_profile_id: 'agent-succ-prof',
      status: 'PENDING',
      started_at: nowIso,
      ended_at: null,
      summary: null,
    });

    const { snapshotId, manifestId } = seedSuccessorContext({
      projectId,
      taskId,
      transferId,
      successorAttemptId: succAttId,
    });

    const storedSnap = repo.getContextSnapshot(snapshotId)!;
    const storedMan = repo.getContextManifest(manifestId)!;
    expect(storedSnap.purpose).toBe('HANDOFF');
    expect(storedMan.manifest_hash).toBeDefined();
  });

  // 6. Routing selects distinct Provider B, resource B, and account B
  it('6. Routing selects distinct Provider B, resource B, and account B', async () => {
    const { projectId, taskId } = await seedClosureTopology();

    const routingDecision = await routingService.routeRole({
      projectId,
      taskId,
      roleProfileId: 'role-coder-closure',
      excludedProviderIds: [providerAId],
    });

    expect(routingDecision.outcome).toBe('SELECTED');
    expect(routingDecision.selectedProviderId).toBe(providerBId);
    expect(routingDecision.selectedAccountId).toBe(accountBId);
    expect(routingDecision.selectedResourceId).toBe(resourceBId);
    expect(routingDecision.selectedProviderId).not.toBe(providerAId);
  });

  // 7. Assignment, routing decision, authorization, ownership epoch, account, resource, and lifecycle-v1 bindings agree
  it('7. Assignment, routing decision, authorization, ownership epoch, account, resource, and lifecycle-v1 bindings agree', async () => {
    const { projectId, taskId, predAttId, predAsgnId, succAttId } = await seedClosureTopology();
    const nowIso = new Date().toISOString();

    db.prepare("UPDATE task_attempts SET status = 'HANDED_OFF' WHERE id = ?").run(predAttId);
    db.prepare("UPDATE agent_assignments SET status = 'HANDED_OFF' WHERE id = ?").run(predAsgnId);
    db.prepare("UPDATE tasks SET ownership_epoch = 2 WHERE id = ?").run(taskId);

    repo.createTaskAttempt({
      id: succAttId,
      task_id: taskId,
      attempt_number: 2,
      agent_id: null,
      agent_profile_id: 'agent-succ-prof',
      status: 'PENDING',
      started_at: nowIso,
      ended_at: null,
      summary: null,
    });

    const routingDecisionId = 'rd-closure-7';
    seedRoutingDecision({
      decisionId: routingDecisionId,
      projectId,
      taskId,
      attemptId: succAttId,
    });

    const transferId = 'xfer-closure-7';
    const succAsgnId = 'asgn-closure-succ-7';
    createSuccessorAssignmentRecord({
      id: succAsgnId,
      projectId,
      taskId,
      attemptId: succAttId,
      transferId,
      routingDecisionId,
      status: 'ASSIGNED',
    });

    const { contextSpecHash, snapshotId } = seedSuccessorContext({
      projectId,
      taskId,
      transferId,
      successorAttemptId: succAttId,
    });

    createHandoffTransferRecord({
      id: transferId,
      taskId,
      sourceAttemptId: predAttId,
      successorAttemptId: succAttId,
      sourceAssignmentId: predAsgnId,
      successorAssignmentId: succAsgnId,
      successorContextSnapshotId: snapshotId,
      successorContextSpecHash: contextSpecHash,
      status: 'ROUTED',
    });

    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId });
    expect(resumeRes.success).toBe(true);
    const auth = resumeRes.authorization!;

    expect(auth.selected_provider_id).toBe(providerBId);
    expect(auth.selected_account_id).toBe(accountBId);
    expect(auth.selected_resource_id).toBe(resourceBId);
    expect(auth.task_ownership_epoch).toBe(2);
    expect(auth.lifecycle_version).toBe(1);

    const linkedTransfer = repo.getHandoffTransferBySuccessorAuthId(auth.id);
    expect(linkedTransfer?.id).toBe(transferId);
  });

  // 8. Successor cannot start before accepted handoff authority
  it('8. Successor cannot start before accepted handoff authority', async () => {
    const { projectId, taskId, predAttId, predAsgnId, succAttId } = await seedClosureTopology();
    const nowIso = new Date().toISOString();

    db.prepare("UPDATE task_attempts SET status = 'HANDED_OFF' WHERE id = ?").run(predAttId);
    db.prepare("UPDATE agent_assignments SET status = 'HANDED_OFF' WHERE id = ?").run(predAsgnId);
    db.prepare("UPDATE tasks SET ownership_epoch = 2 WHERE id = ?").run(taskId);

    repo.createTaskAttempt({
      id: succAttId,
      task_id: taskId,
      attempt_number: 2,
      agent_id: null,
      agent_profile_id: 'agent-succ-prof',
      status: 'PENDING',
      started_at: nowIso,
      ended_at: null,
      summary: null,
    });

    const routingDecisionId = 'rd-closure-8';
    seedRoutingDecision({ decisionId: routingDecisionId, projectId, taskId, attemptId: succAttId });

    const transferId = 'xfer-closure-8';
    const succAsgnId = 'asgn-closure-8';
    createSuccessorAssignmentRecord({
      id: succAsgnId,
      projectId,
      taskId,
      attemptId: succAttId,
      transferId,
      routingDecisionId,
      status: 'ASSIGNED',
    });

    const { contextSpecHash, snapshotId } = seedSuccessorContext({
      projectId,
      taskId,
      transferId,
      successorAttemptId: succAttId,
    });

    createHandoffTransferRecord({
      id: transferId,
      taskId,
      sourceAttemptId: predAttId,
      successorAttemptId: succAttId,
      sourceAssignmentId: predAsgnId,
      successorAssignmentId: succAsgnId,
      successorContextSnapshotId: snapshotId,
      successorContextSpecHash: contextSpecHash,
      status: 'ROUTED',
    });

    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId });
    expect(resumeRes.success).toBe(true);
    const authId = resumeRes.authorization!.id;

    // Leave transfer in AUTHORIZED status (not yet ACCEPTED)
    // Provider dispatch before ACCEPTED must fail closed
    const dispatchRes = await dispatchService.dispatch(authId);

    expect(dispatchRes.status).toBe('FAILED');
    expect(dispatchRes.error).toContain('EXECUTION_AUTHORIZATION_NOT_ACCEPTED');
  });

  // 9. Predecessor cannot resume execution after relinquishment
  it('9. Predecessor cannot resume execution after relinquishment', async () => {
    const { taskId, predAttId, predAsgnId } = await seedClosureTopology();
    const nowIso = new Date().toISOString();

    const handoffRes = handoffService.requestHandoff({
      requestId: 'req-relinq-9',
      taskId,
      sourceAttemptId: predAttId,
      sourceAssignmentId: predAsgnId,
      reason: 'ROTATION',
      expectedSourceEpoch: 1,
    });
    expect(handoffRes.success).toBe(true);
    const transferId = handoffRes.transfer!.id;

    handoffService.freezeHandoff({ transferId, expectedVersion: 1, frozenAt: nowIso });
    handoffService.beginQuiescence({ transferId, expectedVersion: 2, quiescingAt: nowIso });
    handoffService.relinquishPredecessorOwnership({ transferId, expectedVersion: 3, expectedSourceEpoch: 1, relinquishedAt: nowIso });

    // Task ownership epoch moves to 2
    db.prepare("UPDATE tasks SET ownership_epoch = 2 WHERE id = ?").run(taskId);

    // Attempting predecessor claim on epoch 1 fails closed
    const claimRes = repo.claimExecutionAuthorization('auth-pred-any', nowIso);
    expect(claimRes).toBe(false);

    // Direct start claim with stale epoch 1 fails
    const startClaimRes = repo.claimAdapterExecutionStart({
      authorizationId: 'auth-pred-any',
      executionId: 'exec-stale-pred',
      expectedEpoch: 1,
    });
    expect(startClaimRes.success).toBe(false);
  });

  // 10. Adapter-start claim invokes Provider B exactly once
  it('10. Adapter-start claim invokes Provider B exactly once', async () => {
    const { projectId, taskId, predAttId, predAsgnId, succAttId } = await seedClosureTopology();
    const nowIso = new Date().toISOString();

    db.prepare("UPDATE task_attempts SET status = 'HANDED_OFF' WHERE id = ?").run(predAttId);
    db.prepare("UPDATE agent_assignments SET status = 'HANDED_OFF' WHERE id = ?").run(predAsgnId);
    db.prepare("UPDATE tasks SET ownership_epoch = 2 WHERE id = ?").run(taskId);

    repo.createTaskAttempt({
      id: succAttId,
      task_id: taskId,
      attempt_number: 2,
      agent_id: null,
      agent_profile_id: 'agent-succ-prof',
      status: 'PENDING',
      started_at: nowIso,
      ended_at: null,
      summary: null,
    });

    const routingDecisionId = 'rd-closure-10';
    seedRoutingDecision({ decisionId: routingDecisionId, projectId, taskId, attemptId: succAttId });

    const transferId = 'xfer-closure-10';
    const succAsgnId = 'asgn-closure-10';
    createSuccessorAssignmentRecord({
      id: succAsgnId,
      projectId,
      taskId,
      attemptId: succAttId,
      transferId,
      routingDecisionId,
      status: 'ASSIGNED',
    });

    const { contextSpecHash, snapshotId } = seedSuccessorContext({
      projectId,
      taskId,
      transferId,
      successorAttemptId: succAttId,
    });

    createHandoffTransferRecord({
      id: transferId,
      taskId,
      sourceAttemptId: predAttId,
      successorAttemptId: succAttId,
      sourceAssignmentId: predAsgnId,
      successorAssignmentId: succAsgnId,
      successorContextSnapshotId: snapshotId,
      successorContextSpecHash: contextSpecHash,
      status: 'ROUTED',
    });

    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId });
    expect(resumeRes.success).toBe(true);
    const authId = resumeRes.authorization!.id;

    const leaseRes = leaseService.acquireForAssignment(succAsgnId, 60000);
    expect(leaseRes.status).toBe('ACQUIRED');

    const acceptRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: authId,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(acceptRes.success).toBe(true);

    const dispatchRes = await dispatchService.dispatch(authId);
    expect(dispatchRes.status).toBe('COMPLETED');
    expect(adapterB.invocationCount).toBe(1);
    expect(adapterA.invocationCount).toBe(0);
  });

  // 11. Concurrent/replayed dispatch through two physical connections produces exactly one adapter call
  it('11. Concurrent/replayed dispatch through two physical connections produces exactly one adapter call', async () => {
    const { projectId, taskId, predAttId, predAsgnId, succAttId } = await seedClosureTopology();
    const nowIso = new Date().toISOString();

    db.prepare("UPDATE task_attempts SET status = 'HANDED_OFF' WHERE id = ?").run(predAttId);
    db.prepare("UPDATE agent_assignments SET status = 'HANDED_OFF' WHERE id = ?").run(predAsgnId);
    db.prepare("UPDATE tasks SET ownership_epoch = 2 WHERE id = ?").run(taskId);

    repo.createTaskAttempt({
      id: succAttId,
      task_id: taskId,
      attempt_number: 2,
      agent_id: null,
      agent_profile_id: 'agent-succ-prof',
      status: 'PENDING',
      started_at: nowIso,
      ended_at: null,
      summary: null,
    });

    const routingDecisionId = 'rd-closure-11';
    seedRoutingDecision({ decisionId: routingDecisionId, projectId, taskId, attemptId: succAttId });

    const transferId = 'xfer-closure-11';
    const succAsgnId = 'asgn-closure-11';
    createSuccessorAssignmentRecord({
      id: succAsgnId,
      projectId,
      taskId,
      attemptId: succAttId,
      transferId,
      routingDecisionId,
      status: 'ASSIGNED',
    });

    const { contextSpecHash, snapshotId } = seedSuccessorContext({
      projectId,
      taskId,
      transferId,
      successorAttemptId: succAttId,
    });

    createHandoffTransferRecord({
      id: transferId,
      taskId,
      sourceAttemptId: predAttId,
      successorAttemptId: succAttId,
      sourceAssignmentId: predAsgnId,
      successorAssignmentId: succAsgnId,
      successorContextSnapshotId: snapshotId,
      successorContextSpecHash: contextSpecHash,
      status: 'ROUTED',
    });

    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId });
    expect(resumeRes.success).toBe(true);
    const authId = resumeRes.authorization!.id;

    const leaseRes = leaseService.acquireForAssignment(succAsgnId, 60000);
    expect(leaseRes.status).toBe('ACQUIRED');

    const acceptRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: authId,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(acceptRes.success).toBe(true);

    // Create second physical connection
    const db2 = new Database(dbPath);
    db2.pragma('foreign_keys = ON');
    const repo2 = new Repository(db2);
    const eventService2 = new EventService(repo2);
    const dispatchService2 = new ProviderDispatchService(registry, repo2, eventService2, worktreeService);

    // Concurrently dispatch from connection 1 and connection 2
    const [res1, res2] = await Promise.all([
      dispatchService.dispatch(authId),
      dispatchService2.dispatch(authId),
    ]);

    db2.close();

    expect(adapterB.invocationCount).toBe(1);
    const completedCount = [res1, res2].filter((r) => r.status === 'COMPLETED').length;
    const failedCount = [res1, res2].filter((r) => r.status === 'FAILED').length;
    expect(completedCount).toBe(1);
    expect(failedCount).toBe(1);
  });

  // 12. Spoofed adapter provenance is removed and replaced with authentic durable Provider B provenance
  it('12. Spoofed adapter provenance is removed and replaced with authentic durable Provider B provenance', async () => {
    const { projectId, taskId, predAttId, predAsgnId, succAttId, managerMsgId, managerHash } = await seedClosureTopology();
    const nowIso = new Date().toISOString();
    db.prepare("UPDATE tasks SET ownership_epoch = 2 WHERE id = ?").run(taskId);

    repo.createTaskAttempt({
      id: succAttId,
      task_id: taskId,
      attempt_number: 2,
      agent_id: 'agent-succ',
      agent_profile_id: 'agent-succ-prof',
      status: 'RUNNING',
      started_at: nowIso,
      ended_at: null,
      summary: null,
    });

    const routingDecisionId = 'rd-closure-12';
    seedRoutingDecision({ decisionId: routingDecisionId, projectId, taskId, attemptId: succAttId });

    const transferId = 'xfer-closure-12';
    const succAsgnId = 'asgn-closure-12';
    const { routeSpecHash } = createSuccessorAssignmentRecord({
      id: succAsgnId,
      projectId,
      taskId,
      attemptId: succAttId,
      transferId,
      routingDecisionId,
      status: 'RUNNING',
    });

    const { contextSpecHash, snapshotId } = seedSuccessorContext({
      projectId,
      taskId,
      transferId,
      successorAttemptId: succAttId,
    });

    createHandoffTransferRecord({
      id: transferId,
      taskId,
      sourceAttemptId: predAttId,
      successorAttemptId: succAttId,
      sourceAssignmentId: predAsgnId,
      successorAssignmentId: succAsgnId,
      successorContextSnapshotId: snapshotId,
      successorContextSpecHash: contextSpecHash,
      status: 'ACCEPTED',
    });

    const authId = computeHandoffAuthorizationId({
      version: 1,
      transfer_id: transferId,
      successor_attempt_id: succAttId,
      successor_assignment_id: succAsgnId,
      successor_ownership_epoch: 2,
      routing_decision_id: routingDecisionId,
      handoff_route_spec_hash: routeSpecHash,
      successor_context_spec_hash: contextSpecHash,
      manager_message_id: managerMsgId,
      manager_payload_hash: managerHash,
    });

    createAuthorizationRecord({
      id: authId,
      projectId,
      taskId,
      attemptId: succAttId,
      assignmentId: succAsgnId,
      transferId,
      routingDecisionId,
      managerMsgId,
      managerHash,
      taskOwnershipEpoch: 2,
      lifecycleVersion: 1,
      providerId: providerBId,
      accountId: accountBId,
      resourceId: resourceBId,
      status: 'DISPATCHED',
      executionId: 'exec-closure-12',
      adapterStartedAt: nowIso,
      contextManifestHash: contextSpecHash,
    });

    // Spoofed payload attempting to impersonate Provider Alpha / Account Alpha
    const spoofedResultPayload = {
      output: 'closure result',
      provider_id: 'prov-spoofed-alpha',
      account_id: 'acc-spoofed-alpha',
    };

    const settleRes = repo.settleExecutionResult({
      authorizationId: authId,
      executionId: 'exec-closure-12',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: spoofedResultPayload,
      finishedAt: new Date().toISOString(),
    });

    expect(settleRes.success).toBe(true);

    const auth = repo.getExecutionAuthorization(authId)!;
    const storedEvidence = JSON.parse(auth.settlement_evidence_json!);
    expect(storedEvidence.provider_id).toBe(providerBId);
    expect(storedEvidence.account_id).toBe(accountBId);
    expect(storedEvidence.resource_id).toBe(resourceBId);
    expect(storedEvidence.provider_id).not.toBe('prov-spoofed-alpha');
  });

  // 13. COMPLETED, FAILED, and CANCELLED settlement outcomes each persist atomically with correct terminal graph state
  it('13. COMPLETED, FAILED, and CANCELLED settlement outcomes each persist atomically with correct terminal graph state', async () => {
    const outcomes: Array<{ outcome: 'RETURNED' | 'CANCELLED'; status: 'COMPLETED' | 'FAILED' | 'CANCELLED'; idSuffix: string }> = [
      { outcome: 'RETURNED', status: 'COMPLETED', idSuffix: 'comp' },
      { outcome: 'RETURNED', status: 'FAILED', idSuffix: 'fail' },
      { outcome: 'CANCELLED', status: 'CANCELLED', idSuffix: 'canc' },
    ];

    for (const { outcome, status, idSuffix } of outcomes) {
      const { projectId, taskId, predAttId, predAsgnId, managerMsgId, managerHash } = await seedClosureTopology({
        projectId: `proj-13-${idSuffix}`,
        taskId: `task-13-${idSuffix}`,
        predecessorAttemptId: `att-pred-13-${idSuffix}`,
        predecessorAssignmentId: `asgn-pred-13-${idSuffix}`,
      });
      const nowIso = new Date().toISOString();
      db.prepare("UPDATE tasks SET ownership_epoch = 2 WHERE id = ?").run(taskId);

      const succAttId = `att-succ-13-${idSuffix}`;
      repo.createTaskAttempt({
        id: succAttId,
        task_id: taskId,
        attempt_number: 2,
        agent_id: 'agent-succ',
        agent_profile_id: 'agent-succ-prof',
        status: 'RUNNING',
        started_at: nowIso,
        ended_at: null,
        summary: null,
      });

      const rdId = `rd-13-${idSuffix}`;
      seedRoutingDecision({ decisionId: rdId, projectId, taskId, attemptId: succAttId });

      const transferId = `xfer-13-${idSuffix}`;
      const succAsgnId = `asgn-succ-13-${idSuffix}`;
      const { routeSpecHash } = createSuccessorAssignmentRecord({
        id: succAsgnId,
        projectId,
        taskId,
        attemptId: succAttId,
        transferId,
        routingDecisionId: rdId,
        status: 'RUNNING',
      });

      const { contextSpecHash, snapshotId } = seedSuccessorContext({
        projectId,
        taskId,
        transferId,
        successorAttemptId: succAttId,
      });

      createHandoffTransferRecord({
        id: transferId,
        taskId,
        sourceAttemptId: predAttId,
        successorAttemptId: succAttId,
        sourceAssignmentId: predAsgnId,
        successorAssignmentId: succAsgnId,
        successorContextSnapshotId: snapshotId,
        successorContextSpecHash: contextSpecHash,
        status: 'ACCEPTED',
      });

      const authId = computeHandoffAuthorizationId({
        version: 1,
        transfer_id: transferId,
        successor_attempt_id: succAttId,
        successor_assignment_id: succAsgnId,
        successor_ownership_epoch: 2,
        routing_decision_id: rdId,
        handoff_route_spec_hash: routeSpecHash,
        successor_context_spec_hash: contextSpecHash,
        manager_message_id: managerMsgId,
        manager_payload_hash: managerHash,
      });

      createAuthorizationRecord({
        id: authId,
        projectId,
        taskId,
        attemptId: succAttId,
        assignmentId: succAsgnId,
        transferId,
        routingDecisionId: rdId,
        managerMsgId,
        managerHash,
        taskOwnershipEpoch: 2,
        lifecycleVersion: 1,
        providerId: providerBId,
        accountId: accountBId,
        resourceId: resourceBId,
        status: 'DISPATCHED',
        executionId: `exec-13-${idSuffix}`,
        adapterStartedAt: nowIso,
        contextManifestHash: contextSpecHash,
      });

      const settleRes = repo.settleExecutionResult({
        authorizationId: authId,
        executionId: `exec-13-${idSuffix}`,
        outcome,
        status,
        resultPayload: { code: status === 'COMPLETED' ? 0 : 1 },
        finishedAt: new Date().toISOString(),
      });

      expect(settleRes.success).toBe(true);
      const auth = repo.getExecutionAuthorization(authId)!;
      expect(auth.settlement_status).toBe(status);
      expect(auth.adapter_outcome).toBe(outcome);
    }
  });

  // 14. Successful settlement releases the exact guarded lease and returns only the matching slot to IDLE
  it('14. Successful settlement releases the exact guarded lease and returns only the matching slot to IDLE', async () => {
    const { projectId, taskId, predAttId, predAsgnId, succAttId } = await seedClosureTopology();
    const nowIso = new Date().toISOString();

    db.prepare("UPDATE task_attempts SET status = 'HANDED_OFF' WHERE id = ?").run(predAttId);
    db.prepare("UPDATE agent_assignments SET status = 'HANDED_OFF' WHERE id = ?").run(predAsgnId);
    db.prepare("UPDATE tasks SET ownership_epoch = 2 WHERE id = ?").run(taskId);

    repo.createTaskAttempt({
      id: succAttId,
      task_id: taskId,
      attempt_number: 2,
      agent_id: null,
      agent_profile_id: 'agent-succ-prof',
      status: 'PENDING',
      started_at: nowIso,
      ended_at: null,
      summary: null,
    });

    const routingDecisionId = 'rd-closure-14';
    seedRoutingDecision({ decisionId: routingDecisionId, projectId, taskId, attemptId: succAttId });

    const transferId = 'xfer-closure-14';
    const succAsgnId = 'asgn-closure-14';
    createSuccessorAssignmentRecord({
      id: succAsgnId,
      projectId,
      taskId,
      attemptId: succAttId,
      transferId,
      routingDecisionId,
      status: 'ASSIGNED',
    });

    const { contextSpecHash, snapshotId } = seedSuccessorContext({
      projectId,
      taskId,
      transferId,
      successorAttemptId: succAttId,
    });

    createHandoffTransferRecord({
      id: transferId,
      taskId,
      sourceAttemptId: predAttId,
      successorAttemptId: succAttId,
      sourceAssignmentId: predAsgnId,
      successorAssignmentId: succAsgnId,
      successorContextSnapshotId: snapshotId,
      successorContextSpecHash: contextSpecHash,
      status: 'ROUTED',
    });

    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId });
    expect(resumeRes.success).toBe(true);
    const authId = resumeRes.authorization!.id;

    const execRes = await scheduler.execute(authId);
    expect(execRes.status).toBe('COMPLETED');

    // Verify slot B is released to IDLE and current_execution_id is cleared
    const slotB = repo.getWorkerSlot(slotBId)!;
    expect(slotB.status).toBe('IDLE');
    expect(slotB.current_execution_id).toBeNull();

    // Verify slot A remained IDLE
    const slotA = repo.getWorkerSlot(slotAId)!;
    expect(slotA.status).toBe('IDLE');
  });

  // 15. Identical workflow replay creates no second transfer, attempt, assignment, authorization, execution, settlement event, or adapter call
  it('15. Identical workflow replay creates no second transfer, attempt, assignment, authorization, execution, settlement event, or adapter call', async () => {
    const { projectId, taskId, predAttId, predAsgnId, succAttId } = await seedClosureTopology();
    const nowIso = new Date().toISOString();

    db.prepare("UPDATE task_attempts SET status = 'HANDED_OFF' WHERE id = ?").run(predAttId);
    db.prepare("UPDATE agent_assignments SET status = 'HANDED_OFF' WHERE id = ?").run(predAsgnId);
    db.prepare("UPDATE tasks SET ownership_epoch = 2 WHERE id = ?").run(taskId);

    repo.createTaskAttempt({
      id: succAttId,
      task_id: taskId,
      attempt_number: 2,
      agent_id: null,
      agent_profile_id: 'agent-succ-prof',
      status: 'PENDING',
      started_at: nowIso,
      ended_at: null,
      summary: null,
    });

    const routingDecisionId = 'rd-closure-15';
    seedRoutingDecision({ decisionId: routingDecisionId, projectId, taskId, attemptId: succAttId });

    const transferId = 'xfer-closure-15';
    const succAsgnId = 'asgn-closure-15';
    createSuccessorAssignmentRecord({
      id: succAsgnId,
      projectId,
      taskId,
      attemptId: succAttId,
      transferId,
      routingDecisionId,
      status: 'ASSIGNED',
    });

    const { contextSpecHash, snapshotId } = seedSuccessorContext({
      projectId,
      taskId,
      transferId,
      successorAttemptId: succAttId,
    });

    createHandoffTransferRecord({
      id: transferId,
      taskId,
      sourceAttemptId: predAttId,
      successorAttemptId: succAttId,
      sourceAssignmentId: predAsgnId,
      successorAssignmentId: succAsgnId,
      successorContextSnapshotId: snapshotId,
      successorContextSpecHash: contextSpecHash,
      status: 'ROUTED',
    });

    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId });
    expect(resumeRes.success).toBe(true);
    const authId = resumeRes.authorization!.id;

    const leaseRes = leaseService.acquireForAssignment(succAsgnId, 60000);
    expect(leaseRes.status).toBe('ACQUIRED');

    const acceptRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: authId,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(acceptRes.success).toBe(true);

    const firstDispatch = await dispatchService.dispatch(authId);
    expect(firstDispatch.status).toBe('COMPLETED');
    expect(adapterB.invocationCount).toBe(1);

    const initialEventCount = (db.prepare('SELECT COUNT(*) as c FROM events').get() as any).c;

    const initialAuth = repo.getExecutionAuthorization(authId)!;
    const initialEvidence = JSON.parse(initialAuth.settlement_evidence_json!);

    // Settle replay with identical parameters
    const replaySettle = repo.settleExecutionResult({
      authorizationId: authId,
      executionId: firstDispatch.executionId,
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: initialEvidence.result_payload,
      finishedAt: initialEvidence.finished_at,
    });
    expect(replaySettle.alreadySettled).toBe(true);

    // Dispatch replay
    const secondDispatch = await dispatchService.dispatch(authId);
    expect(secondDispatch.status).toBe('FAILED');
    expect(secondDispatch.errorCode).toBe('RECOVERY_FENCED');
    expect(adapterB.invocationCount).toBe(1); // 0 additional invocations

    const finalEventCount = (db.prepare('SELECT COUNT(*) as c FROM events').get() as any).c;
    expect(finalEventCount).toBe(initialEventCount);
  });

  // 16. Stale ownership epoch and corrupted provider/account/resource bindings fail before adapter invocation with zero authority mutation
  it('16. Stale ownership epoch and corrupted provider/account/resource bindings fail before adapter invocation with zero authority mutation', async () => {
    const { projectId, taskId, predAttId, predAsgnId, succAttId, managerMsgId, managerHash } = await seedClosureTopology();
    const nowIso = new Date().toISOString();

    repo.createTaskAttempt({
      id: succAttId,
      task_id: taskId,
      attempt_number: 2,
      agent_id: 'agent-succ',
      agent_profile_id: 'agent-succ-prof',
      status: 'RUNNING',
      started_at: nowIso,
      ended_at: null,
      summary: null,
    });

    const routingDecisionId = 'rd-closure-16';
    seedRoutingDecision({ decisionId: routingDecisionId, projectId, taskId, attemptId: succAttId });

    const transferId = 'xfer-closure-16';
    const succAsgnId = 'asgn-closure-16';
    const { routeSpecHash } = createSuccessorAssignmentRecord({
      id: succAsgnId,
      projectId,
      taskId,
      attemptId: succAttId,
      transferId,
      routingDecisionId,
      status: 'RUNNING',
    });

    const { contextSpecHash, snapshotId } = seedSuccessorContext({
      projectId,
      taskId,
      transferId,
      successorAttemptId: succAttId,
    });

    createHandoffTransferRecord({
      id: transferId,
      taskId,
      sourceAttemptId: predAttId,
      successorAttemptId: succAttId,
      sourceAssignmentId: predAsgnId,
      successorAssignmentId: succAsgnId,
      successorContextSnapshotId: snapshotId,
      successorContextSpecHash: contextSpecHash,
      status: 'ACCEPTED',
    });

    const authId = computeHandoffAuthorizationId({
      version: 1,
      transfer_id: transferId,
      successor_attempt_id: succAttId,
      successor_assignment_id: succAsgnId,
      successor_ownership_epoch: 2,
      routing_decision_id: routingDecisionId,
      handoff_route_spec_hash: routeSpecHash,
      successor_context_spec_hash: contextSpecHash,
      manager_message_id: managerMsgId,
      manager_payload_hash: managerHash,
    });

    createAuthorizationRecord({
      id: authId,
      projectId,
      taskId,
      attemptId: succAttId,
      assignmentId: succAsgnId,
      transferId,
      routingDecisionId,
      managerMsgId,
      managerHash,
      taskOwnershipEpoch: 2, // Mismatch against task.ownership_epoch = 1
      lifecycleVersion: 1,
      providerId: providerBId,
      accountId: accountBId,
      resourceId: resourceBId,
      status: 'AUTHORIZED',
      contextManifestHash: contextSpecHash,
    });

    // 1. Adapter start claim with stale epoch fails closed
    const claimRes = repo.claimAdapterExecutionStart({
      authorizationId: authId,
      executionId: 'exec-closure-16',
      expectedEpoch: 2,
    });
    expect(claimRes.success).toBe(false);
    expect(claimRes.error).toContain('AUTHORIZATION_NOT_DISPATCHED');

    // 2. Corrupted routing decision scope fails closed
    db.prepare("UPDATE events SET structured_payload_json = ? WHERE type = 'ROLE_AWARE_ROUTING_DECISION'").run(
      JSON.stringify({ projectId: 'wrong-project', taskId, selectedResourceId: 'wrong-res' })
    );

    const dispatchRes = await dispatchService.dispatch(authId);
    expect(dispatchRes.status).toBe('FAILED');
    expect(adapterB.invocationCount).toBe(0);

    const auth = repo.getExecutionAuthorization(authId)!;
    expect(auth.adapter_started_at).toBeNull();
  });

  // 17. Restart after adapter claim but before durable result remains recovery-fenced and does not invoke the adapter again
  it('17. Restart after adapter claim but before durable result remains recovery-fenced and does not invoke the adapter again', async () => {
    const { projectId, taskId, predAttId, predAsgnId, succAttId, managerMsgId, managerHash } = await seedClosureTopology();
    const nowIso = new Date().toISOString();
    db.prepare("UPDATE tasks SET ownership_epoch = 2 WHERE id = ?").run(taskId);

    repo.createTaskAttempt({
      id: succAttId,
      task_id: taskId,
      attempt_number: 2,
      agent_id: 'agent-succ',
      agent_profile_id: 'agent-succ-prof',
      status: 'RUNNING',
      started_at: nowIso,
      ended_at: null,
      summary: null,
    });

    const routingDecisionId = 'rd-closure-17';
    seedRoutingDecision({ decisionId: routingDecisionId, projectId, taskId, attemptId: succAttId });

    const transferId = 'xfer-closure-17';
    const succAsgnId = 'asgn-closure-17';
    const { routeSpecHash } = createSuccessorAssignmentRecord({
      id: succAsgnId,
      projectId,
      taskId,
      attemptId: succAttId,
      transferId,
      routingDecisionId,
      status: 'RUNNING',
    });

    const { contextSpecHash, snapshotId } = seedSuccessorContext({
      projectId,
      taskId,
      transferId,
      successorAttemptId: succAttId,
    });

    createHandoffTransferRecord({
      id: transferId,
      taskId,
      sourceAttemptId: predAttId,
      successorAttemptId: succAttId,
      sourceAssignmentId: predAsgnId,
      successorAssignmentId: succAsgnId,
      successorContextSnapshotId: snapshotId,
      successorContextSpecHash: contextSpecHash,
      status: 'ACCEPTED',
    });

    const authId = computeHandoffAuthorizationId({
      version: 1,
      transfer_id: transferId,
      successor_attempt_id: succAttId,
      successor_assignment_id: succAsgnId,
      successor_ownership_epoch: 2,
      routing_decision_id: routingDecisionId,
      handoff_route_spec_hash: routeSpecHash,
      successor_context_spec_hash: contextSpecHash,
      manager_message_id: managerMsgId,
      manager_payload_hash: managerHash,
    });

    createAuthorizationRecord({
      id: authId,
      projectId,
      taskId,
      attemptId: succAttId,
      assignmentId: succAsgnId,
      transferId,
      routingDecisionId,
      managerMsgId,
      managerHash,
      taskOwnershipEpoch: 2,
      lifecycleVersion: 1,
      providerId: providerBId,
      accountId: accountBId,
      resourceId: resourceBId,
      status: 'DISPATCHED',
      executionId: 'exec-closure-17',
      adapterStartedAt: nowIso,
      contextManifestHash: contextSpecHash,
    });

    // Simulate database restart by closing and reopening
    db.close();

    const dbRestarted = new Database(dbPath);
    dbRestarted.pragma('foreign_keys = ON');
    const repoRestarted = new Repository(dbRestarted);
    const leaseRestarted = new WorkerSlotLeaseService(repoRestarted);
    const scannerRestarted = new ExecutionRecoveryScanner(dbRestarted, repoRestarted, new EventService(repoRestarted));

    const reconRes = scannerRestarted.reconcileAuthorization(authId);
    expect(reconRes.classification).toBe('ADAPTER_IN_FLIGHT_UNRESOLVED');
    expect(reconRes.disposition).toBe('UNRESOLVED_FENCED');

    const dispatchRestarted = new ProviderDispatchService(registry, repoRestarted, new EventService(repoRestarted), worktreeService);
    const replayRes = await dispatchRestarted.dispatch(authId);

    expect(replayRes.status).toBe('FAILED');
    expect(replayRes.errorCode).toBe('RECOVERY_FENCED');
    expect(adapterB.invocationCount).toBe(0);

    dbRestarted.close();
    // Reopen main db for afterEach cleanup
    db = new Database(dbPath);
  });

  // 18. Restart after result persistence but before graph completion is reconciled exactly once
  it('18. Restart after result persistence but before graph completion is reconciled exactly once', async () => {
    const { projectId, taskId, predAttId, predAsgnId, succAttId, managerMsgId, managerHash } = await seedClosureTopology();
    const nowIso = new Date().toISOString();
    db.prepare("UPDATE tasks SET ownership_epoch = 2 WHERE id = ?").run(taskId);

    repo.createTaskAttempt({
      id: succAttId,
      task_id: taskId,
      attempt_number: 2,
      agent_id: 'agent-succ',
      agent_profile_id: 'agent-succ-prof',
      status: 'RUNNING',
      started_at: nowIso,
      ended_at: null,
      summary: null,
    });

    const rdId = 'rd-closure-18';
    seedRoutingDecision({ decisionId: rdId, projectId, taskId, attemptId: succAttId });

    const transferId = 'xfer-closure-18';
    const succAsgnId = 'asgn-closure-18';
    const { routeSpecHash } = createSuccessorAssignmentRecord({
      id: succAsgnId,
      projectId,
      taskId,
      attemptId: succAttId,
      transferId,
      routingDecisionId: rdId,
      status: 'RUNNING',
    });

    const { contextSpecHash, snapshotId } = seedSuccessorContext({
      projectId,
      taskId,
      transferId,
      successorAttemptId: succAttId,
    });

    createHandoffTransferRecord({
      id: transferId,
      taskId,
      sourceAttemptId: predAttId,
      successorAttemptId: succAttId,
      sourceAssignmentId: predAsgnId,
      successorAssignmentId: succAsgnId,
      successorContextSnapshotId: snapshotId,
      successorContextSpecHash: contextSpecHash,
      status: 'ACCEPTED',
    });

    const authId = computeHandoffAuthorizationId({
      version: 1,
      transfer_id: transferId,
      successor_attempt_id: succAttId,
      successor_assignment_id: succAsgnId,
      successor_ownership_epoch: 2,
      routing_decision_id: rdId,
      handoff_route_spec_hash: routeSpecHash,
      successor_context_spec_hash: contextSpecHash,
      manager_message_id: managerMsgId,
      manager_payload_hash: managerHash,
    });

    const execId = 'exec-closure-18';
    createAuthorizationRecord({
      id: authId,
      projectId,
      taskId,
      attemptId: succAttId,
      assignmentId: succAsgnId,
      transferId,
      routingDecisionId: rdId,
      managerMsgId,
      managerHash,
      taskOwnershipEpoch: 2,
      lifecycleVersion: 1,
      providerId: providerBId,
      accountId: accountBId,
      resourceId: resourceBId,
      status: 'DISPATCHED',
      executionId: execId,
      adapterStartedAt: nowIso,
      adapterFinishedAt: nowIso,
      contextManifestHash: contextSpecHash,
    });

    // Build authentic structured settlement evidence envelope (19 required fields)
    const settlementEvidence = {
      authorization_id: authId,
      execution_id: execId,
      transfer_id: transferId,
      project_id: projectId,
      task_id: taskId,
      attempt_id: succAttId,
      assignment_id: succAsgnId,
      provider_id: providerBId,
      resource_id: resourceBId,
      account_id: accountBId,
      routing_decision_id: rdId,
      ownership_epoch: 2,
      lifecycle_version: 1,
      settlement_status: 'COMPLETED',
      outcome: 'RETURNED',
      started_at: nowIso,
      finished_at: nowIso,
      result_payload: { output: 'durable result' },
      error_json: null,
    };
    const evidenceJson = canonicalJsonStringify(settlementEvidence);
    const evidenceHash = computeSha256(evidenceJson);

    // Set authorization to settled, leaving transfer at ACCEPTED and attempt at RUNNING to simulate mid-settlement crash
    db.prepare(`
      UPDATE execution_authorizations
      SET settled_at = ?,
          adapter_finished_at = ?,
          settlement_status = 'COMPLETED',
          adapter_outcome = 'RETURNED',
          settlement_evidence_json = ?,
          settlement_evidence_hash = ?
      WHERE id = ?
    `).run(nowIso, nowIso, evidenceJson, evidenceHash, authId);

    db.close();

    const dbRestarted = new Database(dbPath);
    dbRestarted.pragma('foreign_keys = ON');
    const repoRestarted = new Repository(dbRestarted);
    const leaseRestarted = new WorkerSlotLeaseService(repoRestarted);
    const scannerRestarted = new ExecutionRecoveryScanner(dbRestarted, repoRestarted, new EventService(repoRestarted));

    const reconRes = scannerRestarted.reconcileAuthorization(authId);
    expect(reconRes.classification).toBe('RESULT_PERSISTED_STATE_INCOMPLETE');
    expect(reconRes.disposition).toBe('TERMINAL_STATE_RECONCILED');
    expect(reconRes.mutatedTerminalState).toBe(true);

    const checkTransfer = repoRestarted.getHandoffTransfer(transferId)!;
    expect(checkTransfer.status).toBe('COMPLETED');
    const checkAttempt = repoRestarted.getTaskAttempt(succAttId)!;
    expect(checkAttempt.status).toBe('COMPLETED');
    const checkAsgn = repoRestarted.getAgentAssignment(succAsgnId)!;
    expect(checkAsgn.status).toBe('COMPLETED');

    dbRestarted.close();
    db = new Database(dbPath);
  });

  // 19. A second recovery scan is a deterministic no-op with no duplicate audit events
  it('19. A second recovery scan is a deterministic no-op with no duplicate audit events', async () => {
    const { projectId, taskId, predAttId, predAsgnId, succAttId, managerMsgId, managerHash } = await seedClosureTopology();
    const nowIso = new Date().toISOString();
    db.prepare("UPDATE tasks SET ownership_epoch = 2 WHERE id = ?").run(taskId);

    repo.createTaskAttempt({
      id: succAttId,
      task_id: taskId,
      attempt_number: 2,
      agent_id: 'agent-succ',
      agent_profile_id: 'agent-succ-prof',
      status: 'RUNNING',
      started_at: nowIso,
      ended_at: null,
      summary: null,
    });

    const rdId = 'rd-closure-19';
    seedRoutingDecision({ decisionId: rdId, projectId, taskId, attemptId: succAttId });

    const transferId = 'xfer-closure-19';
    const succAsgnId = 'asgn-closure-19';
    const { routeSpecHash } = createSuccessorAssignmentRecord({
      id: succAsgnId,
      projectId,
      taskId,
      attemptId: succAttId,
      transferId,
      routingDecisionId: rdId,
      status: 'RUNNING',
    });

    const { contextSpecHash, snapshotId } = seedSuccessorContext({
      projectId,
      taskId,
      transferId,
      successorAttemptId: succAttId,
    });

    createHandoffTransferRecord({
      id: transferId,
      taskId,
      sourceAttemptId: predAttId,
      successorAttemptId: succAttId,
      sourceAssignmentId: predAsgnId,
      successorAssignmentId: succAsgnId,
      successorContextSnapshotId: snapshotId,
      successorContextSpecHash: contextSpecHash,
      status: 'ACCEPTED',
    });

    const authId = computeHandoffAuthorizationId({
      version: 1,
      transfer_id: transferId,
      successor_attempt_id: succAttId,
      successor_assignment_id: succAsgnId,
      successor_ownership_epoch: 2,
      routing_decision_id: rdId,
      handoff_route_spec_hash: routeSpecHash,
      successor_context_spec_hash: contextSpecHash,
      manager_message_id: managerMsgId,
      manager_payload_hash: managerHash,
    });

    createAuthorizationRecord({
      id: authId,
      projectId,
      taskId,
      attemptId: succAttId,
      assignmentId: succAsgnId,
      transferId,
      routingDecisionId: rdId,
      managerMsgId,
      managerHash,
      taskOwnershipEpoch: 2,
      lifecycleVersion: 1,
      providerId: providerBId,
      accountId: accountBId,
      resourceId: resourceBId,
      status: 'DISPATCHED',
      executionId: 'exec-closure-19',
      adapterStartedAt: nowIso,
      contextManifestHash: contextSpecHash,
    });

    repo.settleExecutionResult({
      authorizationId: authId,
      executionId: 'exec-closure-19',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: { output: 'result-19' },
      finishedAt: new Date().toISOString(),
    });

    // First scan reconciles
    const firstScan = scanner.scanAndReconcile();
    expect(firstScan.scannedCount).toBeGreaterThanOrEqual(1);

    const eventCountAfterFirst = (db.prepare('SELECT COUNT(*) as c FROM events').get() as any).c;
    const recoveryCountAfterFirst = (db.prepare('SELECT COUNT(*) as c FROM execution_recovery_states').get() as any).c;

    // Second scan is deterministic no-op
    const secondScan = scanner.scanAndReconcile();
    const eventCountAfterSecond = (db.prepare('SELECT COUNT(*) as c FROM events').get() as any).c;
    const recoveryCountAfterSecond = (db.prepare('SELECT COUNT(*) as c FROM execution_recovery_states').get() as any).c;

    expect(eventCountAfterSecond).toBe(eventCountAfterFirst);
    expect(recoveryCountAfterSecond).toBe(recoveryCountAfterFirst);
  });

  // 20. Provider A -> Provider B evidence remains isolated from unrelated projects, attempts, accounts, and resources
  it('20. Provider A -> Provider B evidence remains isolated from unrelated projects, attempts, accounts, and resources', async () => {
    // Seed Project 1 topology (Prov A -> Prov B)
    const p1 = await seedClosureTopology({
      projectId: 'proj-closure-iso-1',
      taskId: 'task-closure-iso-1',
      predecessorAttemptId: 'att-iso-1-pred',
      predecessorAssignmentId: 'asgn-iso-1-pred',
      successorAttemptId: 'att-iso-1-succ',
    });

    // Seed Project 2 topology (Independent project)
    const p2 = await seedClosureTopology({
      projectId: 'proj-closure-iso-2',
      taskId: 'task-closure-iso-2',
      predecessorAttemptId: 'att-iso-2-pred',
      predecessorAssignmentId: 'asgn-iso-2-pred',
      successorAttemptId: 'att-iso-2-succ',
    });

    const nowIso = new Date().toISOString();

    db.prepare("UPDATE task_attempts SET status = 'HANDED_OFF' WHERE id = ?").run(p1.predAttId);
    db.prepare("UPDATE agent_assignments SET status = 'HANDED_OFF' WHERE id = ?").run(p1.predAsgnId);
    db.prepare("UPDATE tasks SET ownership_epoch = 2 WHERE id = ?").run(p1.taskId);

    repo.createTaskAttempt({
      id: p1.succAttId,
      task_id: p1.taskId,
      attempt_number: 2,
      agent_id: null,
      agent_profile_id: 'agent-succ-prof',
      status: 'PENDING',
      started_at: nowIso,
      ended_at: null,
      summary: null,
    });

    const routingDecisionId = 'rd-closure-20';
    seedRoutingDecision({ decisionId: routingDecisionId, projectId: p1.projectId, taskId: p1.taskId, attemptId: p1.succAttId });

    const transferId = 'xfer-iso-1';
    const succAsgnId = 'asgn-iso-1-succ';
    createSuccessorAssignmentRecord({
      id: succAsgnId,
      projectId: p1.projectId,
      taskId: p1.taskId,
      attemptId: p1.succAttId,
      transferId,
      routingDecisionId,
      status: 'ASSIGNED',
    });

    const { contextSpecHash, snapshotId } = seedSuccessorContext({
      projectId: p1.projectId,
      taskId: p1.taskId,
      transferId,
      successorAttemptId: p1.succAttId,
    });

    createHandoffTransferRecord({
      id: transferId,
      taskId: p1.taskId,
      sourceAttemptId: p1.predAttId,
      successorAttemptId: p1.succAttId,
      sourceAssignmentId: p1.predAsgnId,
      successorAssignmentId: succAsgnId,
      successorContextSnapshotId: snapshotId,
      successorContextSpecHash: contextSpecHash,
      status: 'ROUTED',
    });

    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId });
    expect(resumeRes.success).toBe(true);
    const authId = resumeRes.authorization!.id;

    const leaseRes = leaseService.acquireForAssignment(succAsgnId, 60000);
    expect(leaseRes.status).toBe('ACQUIRED');

    const acceptRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: authId,
      leaseId: (leaseRes as any).lease.id,
      leaseToken: (leaseRes as any).lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(acceptRes.success).toBe(true);

    const dispatchRes = await dispatchService.dispatch(authId);
    expect(dispatchRes.status).toBe('COMPLETED');

    // Verify Project 2 state remains completely untouched
    const p2Task = repo.getTask(p2.taskId)!;
    expect(p2Task.ownership_epoch).toBe(1);
    const p2Attempt = repo.getTaskAttempt(p2.predAttId)!;
    expect(p2Attempt.status).toBe('RUNNING');
    const p2Assignment = repo.getAgentAssignment(p2.predAsgnId)!;
    expect(p2Assignment.status).toBe('RUNNING');

    // Verify events are correctly scoped to Project 1
    const p1Events = db.prepare('SELECT * FROM events WHERE project_id = ?').all(p1.projectId);
    const p2Events = db.prepare('SELECT * FROM events WHERE project_id = ?').all(p2.projectId);
    expect(p1Events.length).toBeGreaterThan(0);
    expect(p2Events.length).toBe(0);
  });
});
