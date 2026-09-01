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
import { ProviderDispatchService, ProviderDispatchExecutionResult } from '../src/core/services/ProviderDispatchService';
import { ConcurrentExecutionScheduler, SchedulerExecutionResult } from '../src/core/services/ConcurrentExecutionScheduler';
import { ExecutionRecoveryScanner } from '../src/core/services/ExecutionRecoveryScanner';
import {
  ExecutionAuthorizationService,
  computeCanonicalPayload,
  computePayloadHash,
  computeContextManifestHash,
} from '../src/core/services/ExecutionAuthorizationService';
import {
  HandoffTransferService,
  PredecessorQuiescenceResult,
  HandoffPrepareSuccessorResult,
  HandoffRouteSuccessorResult,
  HandoffResumeSuccessorResult,
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

class MockClosureAdapter implements ProviderAdapter {
  public invocationCount = 0;
  public lastRequest: any = null;
  public executionLog: Array<{ executionId: string; timestamp: string }> = [];

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly adapterType: ProviderAdapterType = 'LOCAL_CLI',
    public returnResult: any = { status: 'COMPLETED' },
    public shouldThrow: boolean = false
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
    this.executionLog.push({
      executionId: req.runtimeBinding?.executionId || 'unknown',
      timestamp: new Date().toISOString(),
    });
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

class ClosureEventService extends EventService {
  constructor(private r: Repository) {
    super(r);
  }

  public override record(
    projectId: string,
    type: string,
    summary: string,
    structuredPayload: Record<string, unknown> = {},
    taskId: string | null = null,
    agentId: string | null = null
  ) {
    if (type === 'ROLE_AWARE_ROUTING_DECISION' && taskId) {
      const attempts = this.r.getTaskAttemptsByTask(taskId);
      const pendingAttempt = attempts.find((a) => a.status === 'PENDING') || attempts[attempts.length - 1];
      structuredPayload = {
        projectId,
        taskId,
        attemptId: structuredPayload.attemptId ?? (pendingAttempt ? pendingAttempt.id : null),
        ...structuredPayload,
      };
    }
    return super.record(projectId, type, summary, structuredPayload, taskId, agentId);
  }
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
  const providerBId = 'prov-b-closure';

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
    eventService = new ClosureEventService(repo);
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

  // Helper to seed initial static topology and predecessor fixture
  async function seedClosureTopology(options?: {
    projectId?: string;
    taskId?: string;
    predecessorAttemptId?: string;
    predecessorAssignmentId?: string;
    seedPredecessorAuth?: boolean;
  }) {
    const nowIso = new Date().toISOString();
    const pid = options?.projectId ?? 'proj-closure-1';
    const tid = options?.taskId ?? 'task-closure-1';
    const predAttId = options?.predecessorAttemptId ?? `att-pred-${tid}`;
    const predAsgnId = options?.predecessorAssignmentId ?? `asgn-pred-${tid}`;
    const accountAId = `acc-a-${tid}`;
    const resourceAId = `res-a-${tid}`;
    const slotAId = `slot-a-${tid}-0`;
    const accountBId = `acc-b-${tid}`;
    const resourceBId = `res-b-${tid}`;
    const slotBId = `slot-b-${tid}-0`;

    // 1. Static Topology: Providers (Alpha & Beta)
    db.prepare(`
      INSERT OR IGNORE INTO providers (id, name, adapter_type, enabled, created_at)
      VALUES (?, ?, 'LOCAL_CLI', 1, ?)
    `).run(providerAId, 'Provider Alpha', nowIso);
    db.prepare(`
      INSERT OR IGNORE INTO providers (id, name, adapter_type, enabled, created_at)
      VALUES (?, ?, 'LOCAL_CLI', 1, ?)
    `).run(providerBId, 'Provider Beta', nowIso);

    // 2. Static Topology: Provider Accounts
    db.prepare(`
      INSERT OR IGNORE INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at)
      VALUES (?, ?, ?, 'NATIVE_PROFILE', 1, 10, 'AVAILABLE', 10, ?, ?)
    `).run(accountAId, providerAId, `Account Alpha ${tid}`, nowIso, nowIso);
    db.prepare(`
      INSERT OR IGNORE INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at)
      VALUES (?, ?, ?, 'NATIVE_PROFILE', 1, 10, 'AVAILABLE', 10, ?, ?)
    `).run(accountBId, providerBId, `Account Beta ${tid}`, nowIso, nowIso);

    // 3. Static Topology: Provider Resources
    db.prepare(`
      INSERT OR IGNORE INTO provider_resources (id, provider_id, provider_account_id, model_name, health_status, capabilities_json, enabled, total_quota, remaining_quota, quota_source, quota_confidence, last_health_check)
      VALUES (?, ?, ?, 'model-alpha', 'AVAILABLE', '["CODING","FILESYSTEM_EDIT","TEST_EXECUTION","REVIEW"]', 1, 1000, 1000, 'PROVIDER_REPORTED', 1.0, ?)
    `).run(resourceAId, providerAId, accountAId, nowIso);
    db.prepare(`
      INSERT OR IGNORE INTO provider_resources (id, provider_id, provider_account_id, model_name, health_status, capabilities_json, enabled, total_quota, remaining_quota, quota_source, quota_confidence, last_health_check)
      VALUES (?, ?, ?, 'model-beta', 'AVAILABLE', '["CODING","FILESYSTEM_EDIT","TEST_EXECUTION","REVIEW"]', 1, 1000, 1000, 'PROVIDER_REPORTED', 1.0, ?)
    `).run(resourceBId, providerBId, accountBId, nowIso);

    // 4. Static Topology: Worker Slots (5 slots per account)
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT OR IGNORE INTO worker_slots (id, provider_account_id, provider_resource_id, slot_index, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'IDLE', ?, ?)
      `).run(`slot-a-${tid}-${i}`, accountAId, resourceAId, i, nowIso, nowIso);
      db.prepare(`
        INSERT OR IGNORE INTO worker_slots (id, provider_account_id, provider_resource_id, slot_index, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'IDLE', ?, ?)
      `).run(`slot-b-${tid}-${i}`, accountBId, resourceBId, i, nowIso, nowIso);
    }

    // 5. Initial Fixture: Project & Task
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

    if (!repo.getTask(tid)) {
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
        constraints: [],
        ownership_epoch: 1,
        created_at: nowIso,
        updated_at: nowIso,
      });
    }

    // 6. Role & Agent Profiles
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
      instructions: ['Continue with handoff lifecycle execution'],
      expected_revision: 1,
      constraints: ['Respect boundaries'],
    };
    const managerJson = JSON.stringify(managerPayload);
    const managerHash = computeSha256(managerJson);
    if (!repo.getProtocolMessageById(msgId)) {
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
    }

    // 8. Predecessor Attempt 1 & Assignment (Active RUNNING state)
    if (!repo.getTaskAttempt(predAttId)) {
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
    }

    const predRdId = `rd-closure-pred-${tid}`;
    eventService.record(
      pid,
      'ROLE_AWARE_ROUTING_DECISION',
      'Predecessor routing decision',
      {
        projectId: pid,
        taskId: tid,
        attemptId: predAttId,
        decisionId: predRdId,
        outcome: 'SELECTED',
        selectedProviderId: providerAId,
        selectedAccountId: accountAId,
        selectedResourceId: resourceAId,
        selectedAssignmentId: predAsgnId,
        roleProfileId: 'role-coder-closure',
      },
      tid
    );

    if (!repo.getAgentAssignment(predAsgnId)) {
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
        routing_decision_id: predRdId,
        preferred_metadata: null,
        status: 'RUNNING',
        created_at: nowIso,
        ended_at: null,
      });
    }

    let predAuthId: string | undefined;
    if (options?.seedPredecessorAuth) {
      predAuthId = `auth-pred-${tid}`;
      if (!repo.getExecutionAuthorization(predAuthId)) {
        const predInstructions = ['Continue with handoff lifecycle execution'];
        const predContextFiles = ['README.md'];
        const predCanonicalPayload = computeCanonicalPayload({
          projectId: pid,
          taskId: tid,
          attemptId: predAttId,
          taskTitle: 'Closure Multi-Provider Task',
          taskDescription: 'Exercise end-to-end handoff lifecycle',
          acceptanceCriteria: ['Deliver verified output', 'Clean handoff'],
          constraints: ['Respect boundaries'],
          instructions: predInstructions,
          contextFiles: predContextFiles,
          verificationCommands: { TEST: null, LINT: null, BUILD: null },
          managerMessageId: msgId,
          managerPayloadHash: managerHash,
        });
        const predPayloadHash = computePayloadHash(predCanonicalPayload);
        const predContextHash = computeContextManifestHash(predContextFiles);

        const authPred: ExecutionAuthorization = {
          id: predAuthId,
          project_id: pid,
          task_id: tid,
          attempt_id: predAttId,
          task_revision: 1,
          base_sha: baseSha,
          repository_head_sha: baseSha,
          manager_message_id: msgId,
          manager_payload_hash: managerHash,
          routing_decision_id: predRdId,
          selected_provider_id: providerAId,
          selected_account_id: accountAId,
          selected_resource_id: resourceAId,
          instruction_payload_hash: predPayloadHash,
          context_manifest_hash: predContextHash,
          canonical_instructions_json: JSON.stringify(predInstructions),
          context_files_json: JSON.stringify(predContextFiles),
          canonical_payload_json: JSON.stringify(predCanonicalPayload),
          status: 'AUTHORIZED',
          created_at: nowIso,
          dispatched_at: null,
          task_ownership_epoch: 1,
          assignment_id: null,
          lifecycle_version: null,
          execution_id: null,
          adapter_started_at: null,
          adapter_finished_at: null,
        };
        repo.createExecutionAuthorization(authPred);
      }
    }

    return {
      projectId: pid,
      taskId: tid,
      predAttId,
      predAsgnId,
      predAuthId,
      accountAId,
      resourceAId,
      slotAId,
      accountBId,
      resourceBId,
      slotBId,
      managerMsgId: msgId,
      managerHash,
    };
  }

  interface ProductionHandoffOptions {
    projectId?: string;
    taskId?: string;
    predecessorAttemptId?: string;
    predecessorAssignmentId?: string;
    seedPredecessorAuth?: boolean;
    successorRoleProfileId?: string;
    successorAgentProfileId?: string;
    reason?: string;
    contextFiles?: string[];
    customItems?: Array<{
      itemType?: any;
      sourceType: string;
      sourceRef?: string | null;
      content: Record<string, unknown> | unknown[];
      tokenEstimate?: number | null;
    }>;
    stopAt?:
      | 'REQUESTED'
      | 'FROZEN'
      | 'QUIESCING'
      | 'RELINQUISHED'
      | 'PREPARED'
      | 'ROUTED'
      | 'AUTHORIZED'
      | 'ACCEPTED'
      | 'DISPATCHED'
      | 'SCHEDULED_EXECUTED';
    executeMode?: 'DISPATCH' | 'SCHEDULER';
    adapterBReturnResult?: any;
    adapterBShouldThrow?: boolean;
  }

  interface ProductionHandoffContext {
    projectId: string;
    taskId: string;
    predAttId: string;
    predAsgnId: string;
    predAuthId?: string;
    accountAId: string;
    resourceAId: string;
    slotAId: string;
    accountBId: string;
    resourceBId: string;
    slotBId: string;
    transferId: string;
    requestId: string;
    succAttId?: string;
    succAsgnId?: string;
    routingDecisionId?: string;
    authorizationId?: string;
    leaseId?: string;
    leaseToken?: string;
    transfer: HandoffTransfer;
    authorization?: ExecutionAuthorization;
    dispatchResult?: ProviderDispatchExecutionResult;
    schedulerResult?: SchedulerExecutionResult;
    quiescenceEvaluation?: PredecessorQuiescenceResult;
    prepareResult?: HandoffPrepareSuccessorResult;
    routeResult?: HandoffRouteSuccessorResult;
    resumeResult?: HandoffResumeSuccessorResult;
  }

  // Shared production handoff driver executing the real production sequence
  async function runProductionHandoffFlow(
    options?: ProductionHandoffOptions
  ): Promise<ProductionHandoffContext> {
    const topo = await seedClosureTopology({
      projectId: options?.projectId,
      taskId: options?.taskId,
      predecessorAttemptId: options?.predecessorAttemptId,
      predecessorAssignmentId: options?.predecessorAssignmentId,
      seedPredecessorAuth: options?.seedPredecessorAuth,
    });

    if (options?.adapterBReturnResult) {
      adapterB.returnResult = options.adapterBReturnResult;
    }
    if (options?.adapterBShouldThrow !== undefined) {
      adapterB.shouldThrow = options.adapterBShouldThrow;
    }

    const nowIso = new Date().toISOString();
    const requestId = `req-ho-${topo.taskId}-${Date.now()}`;

    // 1. requestHandoff
    const reqRes = handoffService.requestHandoff({
      requestId,
      taskId: topo.taskId,
      sourceAttemptId: topo.predAttId,
      sourceAssignmentId: topo.predAsgnId,
      reason: options?.reason ?? 'PROVIDER_RATE_LIMIT_COOLDOWN',
      expectedSourceEpoch: 1,
    });
    if (!reqRes.success || !reqRes.transfer) {
      throw new Error(`[ProductionDriver] requestHandoff failed: ${reqRes.error}`);
    }
    const transferId = reqRes.transfer.id;
    let currentTransfer = reqRes.transfer;

    if (options?.stopAt === 'REQUESTED') {
      return {
        projectId: topo.projectId,
        taskId: topo.taskId,
        predAttId: topo.predAttId,
        predAsgnId: topo.predAsgnId,
        predAuthId: topo.predAuthId,
        accountAId: topo.accountAId,
        resourceAId: topo.resourceAId,
        slotAId: topo.slotAId,
        accountBId: topo.accountBId,
        resourceBId: topo.resourceBId,
        slotBId: topo.slotBId,
        transferId,
        requestId,
        transfer: currentTransfer,
      };
    }

    // 2. freezeHandoff
    const freezeRes = handoffService.freezeHandoff({
      transferId,
      expectedVersion: currentTransfer.version,
      frozenAt: nowIso,
    });
    if (!freezeRes.success || !freezeRes.transfer) {
      throw new Error(`[ProductionDriver] freezeHandoff failed: ${freezeRes.error}`);
    }
    currentTransfer = freezeRes.transfer;

    if (options?.stopAt === 'FROZEN') {
      return {
        projectId: topo.projectId,
        taskId: topo.taskId,
        predAttId: topo.predAttId,
        predAsgnId: topo.predAsgnId,
        predAuthId: topo.predAuthId,
        accountAId: topo.accountAId,
        resourceAId: topo.resourceAId,
        slotAId: topo.slotAId,
        accountBId: topo.accountBId,
        resourceBId: topo.resourceBId,
        slotBId: topo.slotBId,
        transferId,
        requestId,
        transfer: currentTransfer,
      };
    }

    // 3. beginQuiescence
    const quiesceRes = handoffService.beginQuiescence({
      transferId,
      expectedVersion: currentTransfer.version,
      quiescingAt: nowIso,
    });
    if (!quiesceRes.success || !quiesceRes.transfer) {
      throw new Error(`[ProductionDriver] beginQuiescence failed: ${quiesceRes.error}`);
    }
    currentTransfer = quiesceRes.transfer;

    if (options?.stopAt === 'QUIESCING') {
      return {
        projectId: topo.projectId,
        taskId: topo.taskId,
        predAttId: topo.predAttId,
        predAsgnId: topo.predAsgnId,
        predAuthId: topo.predAuthId,
        accountAId: topo.accountAId,
        resourceAId: topo.resourceAId,
        slotAId: topo.slotAId,
        accountBId: topo.accountBId,
        resourceBId: topo.resourceBId,
        slotBId: topo.slotBId,
        transferId,
        requestId,
        transfer: currentTransfer,
      };
    }

    // 4. evaluatePredecessorQuiescence
    const quiescenceEvaluation = handoffService.evaluatePredecessorQuiescence(transferId);
    if (!quiescenceEvaluation.safeToRelinquish) {
      throw new Error(
        `[ProductionDriver] evaluatePredecessorQuiescence indicated unsafe: ${quiescenceEvaluation.reason}`
      );
    }

    // 5. relinquishPredecessorOwnership
    const relRes = handoffService.relinquishPredecessorOwnership({
      transferId,
      expectedVersion: currentTransfer.version,
      expectedSourceEpoch: 1,
      relinquishedAt: nowIso,
    });
    if (!relRes.success || !relRes.transfer) {
      throw new Error(`[ProductionDriver] relinquishPredecessorOwnership failed: ${relRes.error}`);
    }
    currentTransfer = relRes.transfer;

    if (options?.stopAt === 'RELINQUISHED') {
      return {
        projectId: topo.projectId,
        taskId: topo.taskId,
        predAttId: topo.predAttId,
        predAsgnId: topo.predAsgnId,
        predAuthId: topo.predAuthId,
        accountAId: topo.accountAId,
        resourceAId: topo.resourceAId,
        slotAId: topo.slotAId,
        accountBId: topo.accountBId,
        resourceBId: topo.resourceBId,
        slotBId: topo.slotBId,
        transferId,
        requestId,
        transfer: currentTransfer,
        quiescenceEvaluation,
      };
    }

    // 6. prepareHandoffSuccessor
    const prepareResult = handoffService.prepareHandoffSuccessor({
      transferId,
      expectedVersion: currentTransfer.version,
      expectedSuccessorEpoch: 2,
      successorRoleProfileId: options?.successorRoleProfileId ?? 'role-coder-closure',
      successorAgentProfileId: options?.successorAgentProfileId ?? 'agent-succ-prof',
      buildContext: true,
      contextFiles: options?.contextFiles ?? ['README.md'],
      customItems: options?.customItems ?? [
        {
          itemType: 'TASK_MEMORY',
          sourceType: 'TASK_STORE',
          sourceRef: 'closure-task-notes',
          content: { note: 'Ready for closure execution' },
          tokenEstimate: 20,
        },
      ],
    });
    if (!prepareResult.success || !prepareResult.transfer || !prepareResult.successorAttempt) {
      throw new Error(`[ProductionDriver] prepareHandoffSuccessor failed: ${prepareResult.error}`);
    }
    currentTransfer = prepareResult.transfer;
    const succAttId = prepareResult.successorAttempt.id;

    if (options?.stopAt === 'PREPARED') {
      return {
        projectId: topo.projectId,
        taskId: topo.taskId,
        predAttId: topo.predAttId,
        predAsgnId: topo.predAsgnId,
        predAuthId: topo.predAuthId,
        accountAId: topo.accountAId,
        resourceAId: topo.resourceAId,
        slotAId: topo.slotAId,
        accountBId: topo.accountBId,
        resourceBId: topo.resourceBId,
        slotBId: topo.slotBId,
        transferId,
        requestId,
        succAttId,
        transfer: currentTransfer,
        quiescenceEvaluation,
        prepareResult,
      };
    }

    // 7. routeHandoffSuccessor
    const routeResult = await handoffService.routeHandoffSuccessor({
      transferId,
      expectedVersion: currentTransfer.version,
      expectedSuccessorEpoch: 2,
    });
    if (!routeResult.success || !routeResult.transfer || !routeResult.assignment || !routeResult.decision) {
      throw new Error(`[ProductionDriver] routeHandoffSuccessor failed: ${routeResult.error}`);
    }
    currentTransfer = routeResult.transfer;
    const succAsgnId = routeResult.assignment.id;
    const routingDecisionId = routeResult.decision.decisionId;

    if (options?.stopAt === 'ROUTED') {
      return {
        projectId: topo.projectId,
        taskId: topo.taskId,
        predAttId: topo.predAttId,
        predAsgnId: topo.predAsgnId,
        predAuthId: topo.predAuthId,
        accountAId: topo.accountAId,
        resourceAId: topo.resourceAId,
        slotAId: topo.slotAId,
        accountBId: topo.accountBId,
        resourceBId: topo.resourceBId,
        slotBId: topo.slotBId,
        transferId,
        requestId,
        succAttId,
        succAsgnId,
        routingDecisionId,
        transfer: currentTransfer,
        quiescenceEvaluation,
        prepareResult,
        routeResult,
      };
    }

    // 8. resumeHandoffSuccessor
    const resumeResult = await handoffService.resumeHandoffSuccessor({
      transferId,
      expectedVersion: currentTransfer.version,
    });
    if (!resumeResult.success || !resumeResult.transfer || !resumeResult.authorization) {
      throw new Error(`[ProductionDriver] resumeHandoffSuccessor failed: ${resumeResult.error}`);
    }
    currentTransfer = resumeResult.transfer;
    const authorization = resumeResult.authorization;
    const authorizationId = authorization.id;

    if (options?.stopAt === 'AUTHORIZED') {
      return {
        projectId: topo.projectId,
        taskId: topo.taskId,
        predAttId: topo.predAttId,
        predAsgnId: topo.predAsgnId,
        predAuthId: topo.predAuthId,
        accountAId: topo.accountAId,
        resourceAId: topo.resourceAId,
        slotAId: topo.slotAId,
        accountBId: topo.accountBId,
        resourceBId: topo.resourceBId,
        slotBId: topo.slotBId,
        transferId,
        requestId,
        succAttId,
        succAsgnId,
        routingDecisionId,
        authorizationId,
        transfer: currentTransfer,
        authorization,
        quiescenceEvaluation,
        prepareResult,
        routeResult,
        resumeResult,
      };
    }

    // If running with ConcurrentExecutionScheduler, let the scheduler handle lease acquire, acceptance, and execution
    if (options?.executeMode === 'SCHEDULER' || options?.stopAt === 'SCHEDULED_EXECUTED') {
      const schedulerResult = await scheduler.execute(authorizationId);
      currentTransfer = repo.getHandoffTransfer(transferId)!;
      const updatedAuth = repo.getExecutionAuthorization(authorizationId)!;
      return {
        projectId: topo.projectId,
        taskId: topo.taskId,
        predAttId: topo.predAttId,
        predAsgnId: topo.predAsgnId,
        predAuthId: topo.predAuthId,
        accountAId: topo.accountAId,
        resourceAId: topo.resourceAId,
        slotAId: topo.slotAId,
        accountBId: topo.accountBId,
        resourceBId: topo.resourceBId,
        slotBId: topo.slotBId,
        transferId,
        requestId,
        succAttId,
        succAsgnId,
        routingDecisionId,
        authorizationId,
        transfer: currentTransfer,
        authorization: updatedAuth,
        schedulerResult,
        quiescenceEvaluation,
        prepareResult,
        routeResult,
        resumeResult,
      };
    }

    // 9. Scheduler lease acquisition and acceptance
    const leaseRes = leaseService.acquireForAssignment(succAsgnId, 60000);
    if (leaseRes.status !== 'ACQUIRED') {
      throw new Error(`[ProductionDriver] lease acquire failed: ${leaseRes.error}`);
    }
    const leaseId = leaseRes.lease.id;
    const leaseToken = leaseRes.lease.lease_token;

    const acceptRes = repo.acceptHandoffSuccessorExecution({
      authorizationId,
      leaseId,
      leaseToken,
      expectedSuccessorEpoch: 2,
    });
    if (!acceptRes.success) {
      throw new Error(`[ProductionDriver] acceptHandoffSuccessorExecution failed: ${acceptRes.error}`);
    }
    currentTransfer = repo.getHandoffTransfer(transferId)!;

    if (options?.stopAt === 'ACCEPTED') {
      return {
        projectId: topo.projectId,
        taskId: topo.taskId,
        predAttId: topo.predAttId,
        predAsgnId: topo.predAsgnId,
        predAuthId: topo.predAuthId,
        accountAId: topo.accountAId,
        resourceAId: topo.resourceAId,
        slotAId: topo.slotAId,
        accountBId: topo.accountBId,
        resourceBId: topo.resourceBId,
        slotBId: topo.slotBId,
        transferId,
        requestId,
        succAttId,
        succAsgnId,
        routingDecisionId,
        authorizationId,
        leaseId,
        leaseToken,
        transfer: currentTransfer,
        authorization,
        quiescenceEvaluation,
        prepareResult,
        routeResult,
        resumeResult,
      };
    }

    // Direct ProviderDispatchService execution
    const dispatchResult = await dispatchService.dispatch(authorizationId);
    currentTransfer = repo.getHandoffTransfer(transferId)!;
    const updatedAuth = repo.getExecutionAuthorization(authorizationId)!;

    // Release the worker slot lease so slots are freed for subsequent executions
    try {
      leaseService.release(leaseId, leaseToken);
    } catch {}

    return {
      projectId: topo.projectId,
      taskId: topo.taskId,
      predAttId: topo.predAttId,
      predAsgnId: topo.predAsgnId,
      predAuthId: topo.predAuthId,
      accountAId: topo.accountAId,
      resourceAId: topo.resourceAId,
      slotAId: topo.slotAId,
      accountBId: topo.accountBId,
      resourceBId: topo.resourceBId,
      slotBId: topo.slotBId,
      transferId,
      requestId,
      succAttId,
      succAsgnId,
      routingDecisionId,
      authorizationId,
      leaseId,
      leaseToken,
      transfer: currentTransfer,
      authorization: updatedAuth,
      dispatchResult,
      quiescenceEvaluation,
      prepareResult,
      routeResult,
      resumeResult,
    };
  }

  // 1. Provider A owns and executes predecessor attempt N
  it('1. Provider A owns and executes predecessor attempt N', async () => {
    const topo = await seedClosureTopology({ seedPredecessorAuth: true });

    // Execute Provider A through authentic production dispatch
    const dispatchRes = await dispatchService.dispatch(topo.predAuthId!);

    expect(dispatchRes.status).toBe('COMPLETED');
    expect(adapterA.invocationCount).toBe(1);
    expect(adapterB.invocationCount).toBe(0);

    const task = repo.getTask(topo.taskId)!;
    const attempt = repo.getTaskAttempt(topo.predAttId)!;
    const assignment = repo.getAgentAssignment(topo.predAsgnId)!;

    expect(task.ownership_epoch).toBe(1);
    expect(attempt.attempt_number).toBe(1);
    expect(attempt.status).toBe('RUNNING');
    expect(assignment.selected_provider_id).toBe(providerAId);
    expect(assignment.selected_account_id).toBe(topo.accountAId);
    expect(assignment.selected_resource_id).toBe(topo.resourceAId);
    expect(assignment.status).toBe('RUNNING');

    // Assert authentic Provider A execution provenance stamped by dispatch
    const provenance = dispatchRes.providerExecutionProvenance!;
    expect(provenance.providerId).toBe(providerAId);
    expect(provenance.accountId).toBe(topo.accountAId);
    expect(provenance.resourceId).toBe(topo.resourceAId);
  });

  // 2. Predecessor freeze and quiescence complete before handoff
  it('2. Predecessor freeze and quiescence complete before handoff', async () => {
    const flow = await runProductionHandoffFlow({ stopAt: 'QUIESCING' });

    expect(flow.transfer.status).toBe('QUIESCING');
    expect(flow.transfer.frozen_at).toBeDefined();
    expect(flow.transfer.quiescing_at).toBeDefined();

    // Quiescence evaluation through HandoffTransferService
    const quiescenceEval = handoffService.evaluatePredecessorQuiescence(flow.transferId);
    expect(quiescenceEval.safeToRelinquish).toBe(true);
    expect(quiescenceEval.unresolvedAuthorizationIds.length).toBe(0);
  });

  // 3. Ownership relinquishment occurs exactly once
  it('3. Ownership relinquishment occurs exactly once', async () => {
    const flow = await runProductionHandoffFlow({ stopAt: 'RELINQUISHED' });

    // Relinquishment atomically mutated transfer, task epoch, and predecessor assignment
    expect(flow.transfer.status).toBe('RELINQUISHED');
    expect(flow.transfer.relinquished_at).toBeDefined();

    const task = repo.getTask(flow.taskId)!;
    expect(task.ownership_epoch).toBe(2);

    const predAssignment = repo.getAgentAssignment(flow.predAsgnId)!;
    expect(predAssignment.status).toBe('HANDED_OFF');

    // Relinquishment replay with mismatched version fails closed and performs zero mutation
    const relRes2 = handoffService.relinquishPredecessorOwnership({
      transferId: flow.transferId,
      expectedVersion: 99,
      expectedSourceEpoch: 1,
      relinquishedAt: new Date().toISOString(),
    });
    expect(relRes2.success).toBe(false);
    expect(relRes2.errorCode).toBe('VERSION_CONFLICT');

    // Assert database state remained unchanged
    const taskAfter = repo.getTask(flow.taskId)!;
    expect(taskAfter.ownership_epoch).toBe(2);
    expect(repo.getAgentAssignment(flow.predAsgnId)!.status).toBe('HANDED_OFF');
  });

  // 4. Successor attempt N+1 is created with correct lineage and initial state
  it('4. Successor attempt N+1 is created with correct lineage and initial state', async () => {
    const flow = await runProductionHandoffFlow({ stopAt: 'PREPARED' });

    const succAttempt = repo.getTaskAttempt(flow.succAttId!)!;
    expect(succAttempt.attempt_number).toBe(2);
    expect(succAttempt.status).toBe('PENDING');
    expect(succAttempt.agent_id).toBeNull();
    expect(succAttempt.task_id).toBe(flow.taskId);
  });

  // 5. Handoff context and manifest are bound exactly to N+1
  it('5. Handoff context and manifest are bound exactly to N+1', async () => {
    const flow = await runProductionHandoffFlow({
      stopAt: 'PREPARED',
      contextFiles: ['README.md', 'index.ts'],
      customItems: [
        {
          itemType: 'TASK_MEMORY',
          sourceType: 'TASK_STORE',
          sourceRef: 'closure-task-notes',
          content: { note: 'Verified context binding' },
          tokenEstimate: 25,
        },
      ],
    });

    const transfer = repo.getHandoffTransfer(flow.transferId)!;
    expect(transfer.successor_context_snapshot_id).toBeDefined();
    expect(transfer.successor_context_spec_hash).toBeDefined();

    const snapshot = repo.getContextSnapshot(transfer.successor_context_snapshot_id!)!;
    const manifest = repo.getContextManifestBySnapshotId(snapshot.id)!;

    expect(snapshot.purpose).toBe('HANDOFF');
    expect(snapshot.task_id).toBe(flow.taskId);
    expect(snapshot.attempt_id).toBe(flow.succAttId!);
    expect(manifest.manifest_hash).toBeDefined();
  });

  // 6. Routing selects distinct Provider B, resource B, and account B
  it('6. Routing selects distinct Provider B, resource B, and account B', async () => {
    const flow = await runProductionHandoffFlow({ stopAt: 'ROUTED' });
    const decision = flow.routeResult!.decision!;

    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedProviderId).toBe(providerBId);
    expect(decision.selectedProviderId).not.toBe(providerAId);
    expect(decision.selectedAccountId).toBe(flow.accountBId);
    expect(decision.selectedResourceId).toBe(flow.resourceBId);
  });

  // 7. Assignment, routing decision, authorization, ownership epoch, account, resource, and lifecycle-v1 bindings agree
  it('7. Assignment, routing decision, authorization, ownership epoch, account, resource, and lifecycle-v1 bindings agree', async () => {
    const flow = await runProductionHandoffFlow({ stopAt: 'AUTHORIZED' });
    const auth = flow.authorization!;
    const transfer = repo.getHandoffTransfer(flow.transferId)!;
    const assignment = repo.getAgentAssignment(flow.succAsgnId!)!;
    const decision = flow.routeResult!.decision!;

    expect(auth.selected_provider_id).toBe(providerBId);
    expect(auth.selected_account_id).toBe(flow.accountBId);
    expect(auth.selected_resource_id).toBe(flow.resourceBId);
    expect(auth.task_ownership_epoch).toBe(2);
    expect(auth.lifecycle_version).toBe(1);
    expect(auth.assignment_id).toBe(assignment.id);
    expect(auth.routing_decision_id).toBe(decision.decisionId);
    expect(transfer.successor_authorization_id).toBe(auth.id);
  });

  // 8. Successor cannot start before accepted handoff authority
  it('8. Successor cannot start before accepted handoff authority', async () => {
    // Flow stops legitimately at AUTHORIZED (before acceptance)
    const flow = await runProductionHandoffFlow({ stopAt: 'AUTHORIZED' });

    // Provider dispatch before ACCEPTED must fail closed specifically with EXECUTION_AUTHORIZATION_NOT_ACCEPTED
    const dispatchRes = await dispatchService.dispatch(flow.authorizationId!);

    expect(dispatchRes.status).toBe('FAILED');
    expect(dispatchRes.error).toContain('EXECUTION_AUTHORIZATION_NOT_ACCEPTED');
  });

  // 9. Predecessor cannot resume execution after relinquishment
  it('9. Predecessor cannot resume execution after relinquishment', async () => {
    // Run legitimate handoff sequence with predecessor auth seeded up to relinquishment (epoch becomes 2)
    const flow = await runProductionHandoffFlow({
      seedPredecessorAuth: true,
      stopAt: 'RELINQUISHED',
    });

    // Adapter start claim with stale epoch 1 fails closed
    const startClaimRes = repo.claimAdapterExecutionStart({
      authorizationId: flow.predAuthId!,
      executionId: 'exec-stale-pred',
      expectedEpoch: 1,
    });
    expect(startClaimRes.success).toBe(false);

    // Predecessor dispatch fails closed and Provider A is never invoked
    const dispatchRes = await dispatchService.dispatch(flow.predAuthId!);
    expect(dispatchRes.status).toBe('FAILED');
    expect(adapterA.invocationCount).toBe(0);
  });

  // 10. Adapter-start claim invokes Provider B exactly once
  it('10. Adapter-start claim invokes Provider B exactly once', async () => {
    const flow = await runProductionHandoffFlow({ stopAt: 'DISPATCHED' });

    expect(flow.dispatchResult!.status).toBe('COMPLETED');
    expect(adapterB.invocationCount).toBe(1);
    expect(adapterA.invocationCount).toBe(0);
  });

  // 11. Concurrent/replayed dispatch through two physical connections produces exactly one adapter call
  it('11. Concurrent/replayed dispatch through two physical connections produces exactly one adapter call', async () => {
    const flow = await runProductionHandoffFlow({ stopAt: 'ACCEPTED' });

    // Open second physical connection
    const db2 = new Database(dbPath);
    db2.pragma('foreign_keys = ON');
    const repo2 = new Repository(db2);
    const eventService2 = new ClosureEventService(repo2);
    const dispatchService2 = new ProviderDispatchService(registry, repo2, eventService2, worktreeService);

    // Concurrently dispatch from connection 1 and connection 2
    const [res1, res2] = await Promise.all([
      dispatchService.dispatch(flow.authorizationId!),
      dispatchService2.dispatch(flow.authorizationId!),
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
    // Configure Provider B adapter to return spoofed Provider A values across recognized provenance fields
    const spoofedReturnResult = {
      status: 'COMPLETED' as const,
      output: 'closure result with spoofed provenance',
      providerExecutionProvenance: {
        version: 1,
        source: 'PROVIDER_DISPATCH_SERVICE',
        mode: 'LEGACY',
        adapterInvocation: 'RETURNED',
        authorizationId: 'spoofed-auth-id',
        executionId: 'spoofed-exec-id',
        projectId: 'spoofed-proj-id',
        taskId: 'spoofed-task-id',
        attemptId: 'spoofed-attempt-id',
        routingDecisionId: 'spoofed-rd-id',
        providerId: providerAId,
        resourceId: 'spoofed-res',
        assignmentId: 'spoofed-asgn-id',
        accountId: 'spoofed-acc',
      },
      provider_id: providerAId,
      account_id: 'spoofed-acc',
      resource_id: 'spoofed-res',
    };

    const flow = await runProductionHandoffFlow({
      stopAt: 'DISPATCHED',
      adapterBReturnResult: spoofedReturnResult,
    });

    expect(flow.dispatchResult!.status).toBe('COMPLETED');
    expect(adapterB.invocationCount).toBe(1);
    expect(adapterA.invocationCount).toBe(0);

    // Assert spoofed provenance is absent from return result and authentic Provider B provenance is stamped
    const provenance = flow.dispatchResult!.providerExecutionProvenance!;
    expect(provenance.providerId).toBe(providerBId);
    expect(provenance.accountId).toBe(flow.accountBId);
    expect(provenance.resourceId).toBe(flow.resourceBId);
    expect(provenance.assignmentId).toBe(flow.succAsgnId);
    expect(provenance.authorizationId).toBe(flow.authorizationId);
    expect(provenance.executionId).toBe(flow.dispatchResult!.executionId);

    // Assert durable settlement evidence is stamped authentically and canonical evidence hash verifies
    const auth = repo.getExecutionAuthorization(flow.authorizationId!)!;
    const evidence = JSON.parse(auth.settlement_evidence_json!);
    expect(evidence.provider_id).toBe(providerBId);
    expect(evidence.account_id).toBe(flow.accountBId);
    expect(evidence.resource_id).toBe(flow.resourceBId);
    expect(evidence.assignment_id).toBe(flow.succAsgnId);
    expect(evidence.authorization_id).toBe(flow.authorizationId);
    expect(evidence.execution_id).toBe(flow.dispatchResult!.executionId);
    expect(evidence.provider_id).not.toBe(providerAId);

    const recomputedHash = computeSha256(canonicalJsonStringify(evidence));
    expect(auth.settlement_evidence_hash).toBe(recomputedHash);
  });

  // 13. COMPLETED, FAILED, and CANCELLED settlement outcomes each persist atomically with correct terminal graph state
  it('13. COMPLETED, FAILED, and CANCELLED settlement outcomes each persist atomically with correct terminal graph state', async () => {
    const testCases = [
      {
        idSuffix: 'comp',
        status: 'COMPLETED' as const,
        outcome: 'RETURNED' as const,
        adapterResult: { status: 'COMPLETED' as const, result: 'success' },
      },
      {
        idSuffix: 'fail',
        status: 'FAILED' as const,
        outcome: 'RETURNED' as const,
        adapterResult: { status: 'FAILED' as const, error: 'simulated provider failure' },
      },
      {
        idSuffix: 'canc',
        status: 'CANCELLED' as const,
        outcome: 'CANCELLED' as const,
        adapterResult: { status: 'CANCELLED' as const, error: 'simulated cancellation' },
      },
    ];

    for (const { idSuffix, status, outcome, adapterResult } of testCases) {
      const flow = await runProductionHandoffFlow({
        projectId: `proj-13-${idSuffix}`,
        taskId: `task-13-${idSuffix}`,
        stopAt: 'DISPATCHED',
        adapterBReturnResult: adapterResult,
      });

      const auth = repo.getExecutionAuthorization(flow.authorizationId!)!;
      const transfer = repo.getHandoffTransfer(flow.transferId)!;
      const attempt = repo.getTaskAttempt(flow.succAttId!)!;
      const assignment = repo.getAgentAssignment(flow.succAsgnId!)!;

      // 1. execution_authorizations terminal state
      expect(auth.settlement_status).toBe(status);
      expect(auth.adapter_outcome).toBe(outcome);
      expect(auth.settled_at).toBeDefined();
      expect(auth.adapter_finished_at).toBeDefined();
      expect(auth.settlement_evidence_json).toBeDefined();
      expect(auth.settlement_evidence_hash).toBeDefined();

      // 2. handoff_transfers terminal state
      if (status === 'COMPLETED') {
        expect(transfer.status).toBe('COMPLETED');
        expect(transfer.completed_at).toBeDefined();
      }

      // 3. task_attempts terminal state
      expect(attempt.status).toBe(status);
      expect(attempt.ended_at).toBeDefined();

      // 4. agent_assignments terminal state
      expect(assignment.status).toBe(status);
      expect(assignment.ended_at).toBeDefined();

      // 5. Settlement evidence hash integrity
      const evidence = JSON.parse(auth.settlement_evidence_json!);
      expect(computeSha256(canonicalJsonStringify(evidence))).toBe(auth.settlement_evidence_hash);
    }
  });

  // 14. Successful settlement releases the exact guarded lease and returns only the matching slot to IDLE
  it('14. Successful settlement releases the exact guarded lease and returns only the matching slot to IDLE', async () => {
    const flow = await runProductionHandoffFlow({
      stopAt: 'SCHEDULED_EXECUTED',
      executeMode: 'SCHEDULER',
    });

    expect(flow.schedulerResult!.status).toBe('COMPLETED');

    // Verify active lease for assignment is released
    const activeLease = repo.getActiveLeaseForAssignment(flow.succAsgnId!);
    expect(activeLease).toBeNull();

    // Verify only the bound slot (Slot Beta) is returned to IDLE and pointers cleared
    const slotB = repo.getWorkerSlot(flow.slotBId)!;
    expect(slotB.status).toBe('IDLE');
    expect(slotB.current_assignment_id).toBeNull();
    expect(slotB.current_execution_id).toBeNull();

    // Verify unrelated slot (Slot Alpha) remains unchanged and IDLE
    const slotA = repo.getWorkerSlot(flow.slotAId)!;
    expect(slotA.status).toBe('IDLE');
  });

  // 15. Identical workflow replay creates no second transfer, attempt, assignment, authorization, execution, settlement event, or adapter call
  it('15. Identical workflow replay creates no second transfer, attempt, assignment, authorization, execution, settlement event, or adapter call', async () => {
    const flow = await runProductionHandoffFlow({ stopAt: 'DISPATCHED' });
    expect(flow.dispatchResult!.status).toBe('COMPLETED');
    expect(adapterB.invocationCount).toBe(1);

    // Snapshot counts and durable IDs after first execution
    const initialTransfers = db.prepare('SELECT id, version, status FROM handoff_transfers').all();
    const initialAttempts = db.prepare('SELECT id, status FROM task_attempts').all();
    const initialAssignments = db.prepare('SELECT id, status FROM agent_assignments').all();
    const initialAuths = db.prepare('SELECT id, status, settlement_status FROM execution_authorizations').all();
    const initialEvents = db.prepare('SELECT id, type FROM events').all();
    const initialAdapterCount = adapterB.invocationCount;

    // Replay transfer creation with identical request attributes via durable repo
    const initialTransfer = repo.getHandoffTransfer(flow.transferId)!;
    const replayTransfer = repo.createHandoffTransfer(initialTransfer);
    expect(replayTransfer.success).toBe(true);
    expect(replayTransfer.duplicate).toBe(true);
    expect(replayTransfer.transfer.id).toBe(flow.transferId);

    // Replay dispatch against already dispatched and settled authorization
    const replayDispatch = await dispatchService.dispatch(flow.authorizationId!);
    expect(replayDispatch.status).toBe('FAILED');
    expect(replayDispatch.errorCode).toBe('RECOVERY_FENCED');

    // Assert zero mutation to counts, identical durable records, and zero additional adapter invocations
    const finalTransfers = db.prepare('SELECT id, version, status FROM handoff_transfers').all();
    const finalAttempts = db.prepare('SELECT id, status FROM task_attempts').all();
    const finalAssignments = db.prepare('SELECT id, status FROM agent_assignments').all();
    const finalAuths = db.prepare('SELECT id, status, settlement_status FROM execution_authorizations').all();
    const finalEvents = db.prepare('SELECT id, type FROM events').all();
    const finalAdapterCount = adapterB.invocationCount;

    expect(finalTransfers).toEqual(initialTransfers);
    expect(finalAttempts).toEqual(initialAttempts);
    expect(finalAssignments).toEqual(initialAssignments);
    expect(finalAuths).toEqual(initialAuths);
    expect(finalEvents.length).toBe(initialEvents.length);
    expect(finalAdapterCount).toBe(initialAdapterCount);
  });

  // 16. Stale ownership epoch and corrupted provider/account/resource bindings fail before adapter invocation with zero authority mutation
  it('16. Stale ownership epoch and corrupted provider/account/resource bindings fail before adapter invocation with zero authority mutation', async () => {
    // Subcase 1: Stale ownership epoch
    {
      const flow = await runProductionHandoffFlow({
        projectId: 'proj-16-1',
        taskId: 'task-16-1',
        stopAt: 'ACCEPTED',
      });
      // Adversarial corruption: Mutate task ownership epoch to stale value
      db.prepare('UPDATE tasks SET ownership_epoch = 99 WHERE id = ?').run(flow.taskId);

      const res = await dispatchService.dispatch(flow.authorizationId!);
      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('RESOURCE_UNAVAILABLE');
      expect(res.error).toContain('does not match authorization authority');
      expect(adapterB.invocationCount).toBe(0);

      const auth = repo.getExecutionAuthorization(flow.authorizationId!)!;
      expect(auth.adapter_started_at).toBeNull();
      expect(auth.settlement_status).toBeNull();
      expect(auth.settled_at).toBeNull();
    }

    // Subcase 2: Provider mismatch
    {
      const flow = await runProductionHandoffFlow({
        projectId: 'proj-16-2',
        taskId: 'task-16-2',
        stopAt: 'ACCEPTED',
      });
      // Adversarial corruption: Corrupt routing event provider
      const routingEvent = repo.getRoutingDecisionEvent(flow.routingDecisionId!)!;
      const p = routingEvent.structured_payload as any;
      p.selectedProviderId = 'prov-mismatch-alpha';
      db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(
        JSON.stringify(p),
        routingEvent.id
      );

      const res = await dispatchService.dispatch(flow.authorizationId!);
      expect(res.status).toBe('FAILED');
      expect(res.error).toContain('EXECUTION_AUTHORIZATION_ROUTING_PROVIDER_MISMATCH');
      expect(adapterB.invocationCount).toBe(0);

      const auth = repo.getExecutionAuthorization(flow.authorizationId!)!;
      expect(auth.adapter_started_at).toBeNull();
      expect(auth.settlement_status).toBeNull();
    }

    // Subcase 3: Account mismatch
    {
      const flow = await runProductionHandoffFlow({
        projectId: 'proj-16-3',
        taskId: 'task-16-3',
        stopAt: 'ACCEPTED',
      });
      // Adversarial corruption: Corrupt routing payload selected account
      const routingEvent = repo.getRoutingDecisionEvent(flow.routingDecisionId!)!;
      const p = routingEvent.structured_payload as any;
      p.selectedAccountId = 'acc-mismatch-beta';
      db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(
        JSON.stringify(p),
        routingEvent.id
      );

      const res = await dispatchService.dispatch(flow.authorizationId!);
      expect(res.status).toBe('FAILED');
      expect(res.error).toContain('Routing decision event');
      expect(res.error).toContain('payload does not match successor binding authority');
      expect(adapterB.invocationCount).toBe(0);

      const auth = repo.getExecutionAuthorization(flow.authorizationId!)!;
      expect(auth.adapter_started_at).toBeNull();
      expect(auth.settlement_status).toBeNull();
    }

    // Subcase 4: Resource mismatch
    {
      const flow = await runProductionHandoffFlow({
        projectId: 'proj-16-4',
        taskId: 'task-16-4',
        stopAt: 'ACCEPTED',
      });
      // Adversarial corruption: Corrupt routing payload selected resource
      const routingEvent = repo.getRoutingDecisionEvent(flow.routingDecisionId!)!;
      const p = routingEvent.structured_payload as any;
      p.selectedResourceId = 'res-mismatch-beta';
      db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(
        JSON.stringify(p),
        routingEvent.id
      );

      const res = await dispatchService.dispatch(flow.authorizationId!);
      expect(res.status).toBe('FAILED');
      expect(res.error).toContain('EXECUTION_AUTHORIZATION_ROUTING_RESOURCE_MISMATCH');
      expect(adapterB.invocationCount).toBe(0);

      const auth = repo.getExecutionAuthorization(flow.authorizationId!)!;
      expect(auth.adapter_started_at).toBeNull();
      expect(auth.settlement_status).toBeNull();
    }

    // Subcase 5: Resource-account mismatch
    {
      const flow = await runProductionHandoffFlow({
        projectId: 'proj-16-5',
        taskId: 'task-16-5',
        stopAt: 'ACCEPTED',
      });
      // Adversarial corruption: Change provider_resources.provider_account_id to mismatched account
      db.prepare('UPDATE provider_resources SET provider_account_id = ? WHERE id = ?').run(
        flow.accountAId,
        flow.authorization!.selected_resource_id
      );

      const res = await dispatchService.dispatch(flow.authorizationId!);
      expect(res.status).toBe('FAILED');
      expect(res.error).toContain('ROUTING_RESOURCE_ACCOUNT_MISMATCH');
      expect(adapterB.invocationCount).toBe(0);

      const auth = repo.getExecutionAuthorization(flow.authorizationId!)!;
      expect(auth.adapter_started_at).toBeNull();
      expect(auth.settlement_status).toBeNull();
    }
  });

  // 17. Restart after adapter claim but before durable result remains recovery-fenced and does not invoke the adapter again
  it('17. Restart after adapter claim but before durable result remains recovery-fenced and does not invoke the adapter again', async () => {
    const flow = await runProductionHandoffFlow({ stopAt: 'ACCEPTED' });

    // Cross the real authorization claim and adapter-start claim
    const nowIso = new Date().toISOString();
    const claimAuth = repo.claimExecutionAuthorization(flow.authorizationId!, nowIso);
    expect(claimAuth).toBe(true);

    const claimStart = repo.claimAdapterExecutionStart({
      authorizationId: flow.authorizationId!,
      executionId: 'exec-17-crash',
      expectedEpoch: 2,
      expectedLifecycleVersion: 1,
    });
    expect(claimStart.success).toBe(true);

    // Simulate process loss by closing database before durable result
    db.close();

    // Reopen physical database and scan
    const dbRestarted = new Database(dbPath);
    dbRestarted.pragma('foreign_keys = ON');
    const repoRestarted = new Repository(dbRestarted);
    const scannerRestarted = new ExecutionRecoveryScanner(
      dbRestarted,
      repoRestarted,
      new ClosureEventService(repoRestarted)
    );

    const reconRes = scannerRestarted.reconcileAuthorization(flow.authorizationId!);
    expect(reconRes.classification).toBe('ADAPTER_IN_FLIGHT_UNRESOLVED');
    expect(reconRes.disposition).toBe('UNRESOLVED_FENCED');

    // Attempted dispatch remains recovery-fenced with zero adapter invocations
    const dispatchRestarted = new ProviderDispatchService(
      registry,
      repoRestarted,
      new ClosureEventService(repoRestarted),
      worktreeService
    );
    const replayRes = await dispatchRestarted.dispatch(flow.authorizationId!);

    expect(replayRes.status).toBe('FAILED');
    expect(replayRes.errorCode).toBe('RECOVERY_FENCED');
    expect(adapterB.invocationCount).toBe(0);

    dbRestarted.close();
    db = new Database(dbPath);
  });

  // 18. Restart after result persistence but before graph completion is reconciled exactly once
  it('18. Restart after result persistence but before graph completion is reconciled exactly once', async () => {
    const flow = await runProductionHandoffFlow({ stopAt: 'ACCEPTED' });

    // Cross real claims
    const nowIso = new Date().toISOString();
    repo.claimExecutionAuthorization(flow.authorizationId!, nowIso);
    const execId = 'exec-closure-18';
    repo.claimAdapterExecutionStart({
      authorizationId: flow.authorizationId!,
      executionId: execId,
      expectedEpoch: 2,
      expectedLifecycleVersion: 1,
    });

    // Build authentic structured settlement evidence envelope matching scanner integrity rules
    const settlementEvidence = {
      authorization_id: flow.authorizationId!,
      execution_id: execId,
      transfer_id: flow.transferId,
      project_id: flow.projectId,
      task_id: flow.taskId,
      attempt_id: flow.succAttId!,
      assignment_id: flow.succAsgnId!,
      provider_id: providerBId,
      resource_id: flow.resourceBId,
      account_id: flow.accountBId,
      routing_decision_id: flow.routingDecisionId!,
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

    // Crash injection: Persist canonical settlement result only on authorization, leaving transfer at ACCEPTED and attempt at RUNNING to simulate mid-settlement crash before graph completion
    db.prepare(`
      UPDATE execution_authorizations
      SET adapter_started_at = ?,
          adapter_finished_at = ?,
          adapter_outcome = 'RETURNED',
          settlement_status = 'COMPLETED',
          settled_at = ?,
          settlement_evidence_json = ?,
          settlement_evidence_hash = ?
      WHERE id = ?
    `).run(nowIso, nowIso, nowIso, evidenceJson, evidenceHash, flow.authorizationId!);

    db.close();

    // Reopen physical database and reconcile
    const dbRestarted = new Database(dbPath);
    dbRestarted.pragma('foreign_keys = ON');
    const repoRestarted = new Repository(dbRestarted);
    const scannerRestarted = new ExecutionRecoveryScanner(
      dbRestarted,
      repoRestarted,
      new ClosureEventService(repoRestarted)
    );

    const reconRes = scannerRestarted.reconcileAuthorization(flow.authorizationId!);
    expect(reconRes.classification).toBe('RESULT_PERSISTED_STATE_INCOMPLETE');
    expect(reconRes.disposition).toBe('TERMINAL_STATE_RECONCILED');
    expect(reconRes.mutatedTerminalState).toBe(true);

    // Assert graph completed exactly once
    const checkTransfer = repoRestarted.getHandoffTransfer(flow.transferId)!;
    expect(checkTransfer.status).toBe('COMPLETED');
    const checkAttempt = repoRestarted.getTaskAttempt(flow.succAttId!)!;
    expect(checkAttempt.status).toBe('COMPLETED');
    const checkAsgn = repoRestarted.getAgentAssignment(flow.succAsgnId!)!;
    expect(checkAsgn.status).toBe('COMPLETED');

    dbRestarted.close();
    db = new Database(dbPath);
  });

  // 19. A second recovery scan is a deterministic no-op with no duplicate audit events
  it('19. A second recovery scan is a deterministic no-op with no duplicate audit events', async () => {
    const flow = await runProductionHandoffFlow({ stopAt: 'ACCEPTED' });

    const nowIso = new Date().toISOString();
    repo.claimExecutionAuthorization(flow.authorizationId!, nowIso);
    const execId = 'exec-closure-19';
    repo.claimAdapterExecutionStart({
      authorizationId: flow.authorizationId!,
      executionId: execId,
      expectedEpoch: 2,
      expectedLifecycleVersion: 1,
    });

    const settlementEvidence = {
      authorization_id: flow.authorizationId!,
      execution_id: execId,
      transfer_id: flow.transferId,
      project_id: flow.projectId,
      task_id: flow.taskId,
      attempt_id: flow.succAttId!,
      assignment_id: flow.succAsgnId!,
      provider_id: providerBId,
      resource_id: flow.resourceBId,
      account_id: flow.accountBId,
      routing_decision_id: flow.routingDecisionId!,
      ownership_epoch: 2,
      lifecycle_version: 1,
      settlement_status: 'COMPLETED',
      outcome: 'RETURNED',
      started_at: nowIso,
      finished_at: nowIso,
      result_payload: { output: 'result-19' },
      error_json: null,
    };
    const evidenceJson = canonicalJsonStringify(settlementEvidence);
    const evidenceHash = computeSha256(evidenceJson);

    // Crash injection: Persist canonical settlement result only on authorization, leaving transfer at ACCEPTED and attempt at RUNNING
    db.prepare(`
      UPDATE execution_authorizations
      SET adapter_started_at = ?,
          adapter_finished_at = ?,
          adapter_outcome = 'RETURNED',
          settlement_status = 'COMPLETED',
          settled_at = ?,
          settlement_evidence_json = ?,
          settlement_evidence_hash = ?
      WHERE id = ?
    `).run(nowIso, nowIso, nowIso, evidenceJson, evidenceHash, flow.authorizationId!);

    db.close();

    const dbRestarted = new Database(dbPath);
    dbRestarted.pragma('foreign_keys = ON');
    const repoRestarted = new Repository(dbRestarted);
    const scannerRestarted = new ExecutionRecoveryScanner(
      dbRestarted,
      repoRestarted,
      new ClosureEventService(repoRestarted)
    );

    // First scan reconciles
    const firstScan = scannerRestarted.scanAndReconcile();
    expect(firstScan.scannedCount).toBeGreaterThanOrEqual(1);

    const eventCountAfterFirst = (dbRestarted.prepare('SELECT COUNT(*) as c FROM events').get() as any).c;
    const recoveryCountAfterFirst = (
      dbRestarted.prepare('SELECT COUNT(*) as c FROM execution_recovery_states').get() as any
    ).c;

    // Second scan is deterministic no-op
    const secondScan = scannerRestarted.scanAndReconcile();
    const eventCountAfterSecond = (dbRestarted.prepare('SELECT COUNT(*) as c FROM events').get() as any).c;
    const recoveryCountAfterSecond = (
      dbRestarted.prepare('SELECT COUNT(*) as c FROM execution_recovery_states').get() as any
    ).c;

    expect(eventCountAfterSecond).toBe(eventCountAfterFirst);
    expect(recoveryCountAfterSecond).toBe(recoveryCountAfterFirst);

    dbRestarted.close();
    db = new Database(dbPath);
  });

  // 20. Provider A -> Provider B evidence remains isolated from unrelated projects, attempts, accounts, and resources
  it('20. Provider A -> Provider B evidence remains isolated from unrelated projects, attempts, accounts, and resources', async () => {
    // Seed Project 2 topology
    const p2 = await seedClosureTopology({
      projectId: 'proj-closure-iso-2',
      taskId: 'task-closure-iso-2',
      predecessorAttemptId: 'att-iso-2-pred',
      predecessorAssignmentId: 'asgn-iso-2-pred',
    });

    // Snapshot Project 2 rows before Project 1 execution
    const p2TaskBefore = repo.getTask(p2.taskId)!;
    const p2AttemptBefore = repo.getTaskAttempt(p2.predAttId)!;
    const p2AssignmentBefore = repo.getAgentAssignment(p2.predAsgnId)!;
    const p2TransfersBefore = db.prepare('SELECT * FROM handoff_transfers WHERE task_id = ?').all(p2.taskId);
    const p2AuthsBefore = db.prepare('SELECT * FROM execution_authorizations WHERE project_id = ?').all(p2.projectId);
    const p2EventsBefore = db.prepare('SELECT * FROM events WHERE project_id = ?').all(p2.projectId);

    // Run full production handoff only for Project 1
    const p1Flow = await runProductionHandoffFlow({
      projectId: 'proj-closure-iso-1',
      taskId: 'task-closure-iso-1',
      predecessorAttemptId: 'att-iso-1-pred',
      predecessorAssignmentId: 'asgn-iso-1-pred',
      stopAt: 'DISPATCHED',
    });

    expect(p1Flow.dispatchResult!.status).toBe('COMPLETED');

    // Snapshot Project 2 rows after Project 1 execution
    const p2TaskAfter = repo.getTask(p2.taskId)!;
    const p2AttemptAfter = repo.getTaskAttempt(p2.predAttId)!;
    const p2AssignmentAfter = repo.getAgentAssignment(p2.predAsgnId)!;
    const p2TransfersAfter = db.prepare('SELECT * FROM handoff_transfers WHERE task_id = ?').all(p2.taskId);
    const p2AuthsAfter = db.prepare('SELECT * FROM execution_authorizations WHERE project_id = ?').all(p2.projectId);
    const p2EventsAfter = db.prepare('SELECT * FROM events WHERE project_id = ?').all(p2.projectId);

    // Assert Project 2 state remains completely untouched and identical
    expect(p2TaskAfter).toEqual(p2TaskBefore);
    expect(p2AttemptAfter).toEqual(p2AttemptBefore);
    expect(p2AssignmentAfter).toEqual(p2AssignmentBefore);
    expect(p2TransfersAfter).toEqual(p2TransfersBefore);
    expect(p2AuthsAfter).toEqual(p2AuthsBefore);
    expect(p2EventsAfter).toEqual(p2EventsBefore);

    // Verify Project 1 generated events while Project 2 has only initial event
    const p1Events = db.prepare('SELECT * FROM events WHERE project_id = ?').all('proj-closure-iso-1');
    expect(p1Events.length).toBeGreaterThan(p2EventsAfter.length);
  });
});
