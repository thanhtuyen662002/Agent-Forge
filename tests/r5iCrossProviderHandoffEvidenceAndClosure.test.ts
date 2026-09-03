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
    routingService = new RoleAwareRoutingService(repo, registry, eventService);
    contextBuilder = new ContextBuilderService(repo);
    handoffService = new HandoffTransferService(repo, contextBuilder, routingService);
    scanner = new ExecutionRecoveryScanner(db, repo, eventService);
  });

  afterEach(() => {
    if (db && db.open) {
      db.close();
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // Helper to seed initial static topology and predecessor fixture
  async function seedClosureTopology(options?: {
    projectId?: string;
    taskId?: string;
    predecessorAttemptId?: string;
    predecessorAssignmentId?: string;
    seedPredecessorAuth?: boolean;
    dispatchPredecessorAuth?: boolean;
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
        decisionId: predRdId,
        projectId: pid,
        taskId: tid,
        attemptId: predAttId,
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

        if (options?.dispatchPredecessorAuth) {
          repo.claimExecutionAuthorization(predAuthId, nowIso);
        }
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
    dispatchPredecessorAuth?: boolean;
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
      | 'ACCEPTED';
    executeMode?: 'SCHEDULER' | 'DISPATCH';
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

  // Canonical production handoff driver executing the genuine 13-step sequence
  async function runProductionHandoffFlow(
    options?: ProductionHandoffOptions
  ): Promise<ProductionHandoffContext> {
    const topo = await seedClosureTopology({
      projectId: options?.projectId,
      taskId: options?.taskId,
      predecessorAttemptId: options?.predecessorAttemptId,
      predecessorAssignmentId: options?.predecessorAssignmentId,
      seedPredecessorAuth: options?.seedPredecessorAuth,
      dispatchPredecessorAuth: options?.dispatchPredecessorAuth,
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

    // If stopping at ACCEPTED, acquire lease and accept execution authorization
    if (options?.stopAt === 'ACCEPTED') {
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
        leaseId,
        leaseToken,
        transfer: currentTransfer,
        authorization: updatedAuth,
        quiescenceEvaluation,
        prepareResult,
        routeResult,
        resumeResult,
      };
    }

    // Default canonical execution: execute full steps 9–13 through ConcurrentExecutionScheduler
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

  // Reusable complete authority snapshot helper for fail-closed tests
  function captureAuthoritySnapshot(database: Database.Database, flow: ProductionHandoffContext) {
    const snapshotId = flow.transfer.successor_context_snapshot_id ?? '';
    const auth = database.prepare('SELECT * FROM execution_authorizations WHERE id = ?').get(flow.authorizationId!) as any;
    const assignment = database.prepare('SELECT * FROM agent_assignments WHERE id = ?').get(flow.succAsgnId!) as any;

    return {
      authorityGraph: {
        task: database.prepare('SELECT * FROM tasks WHERE id = ?').get(flow.taskId),
        transfer: database.prepare('SELECT * FROM handoff_transfers WHERE id = ?').get(flow.transferId),
        attempt: database.prepare('SELECT * FROM task_attempts WHERE id = ?').get(flow.succAttId!),
        assignment: assignment,
        authorization: auth,
        account: database.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(flow.accountBId),
        resource: database.prepare('SELECT * FROM provider_resources WHERE id = ?').get(flow.resourceBId),
        lease: database.prepare('SELECT * FROM account_leases WHERE id = ?').get(flow.leaseId!),
        slot: database.prepare('SELECT * FROM worker_slots WHERE id = ?').get(flow.slotBId),
        contextSnapshot: database.prepare('SELECT * FROM context_snapshots WHERE id = ?').get(snapshotId),
        contextItems: database.prepare('SELECT * FROM context_items WHERE snapshot_id = ? ORDER BY id').all(snapshotId),
        contextManifest: database.prepare('SELECT * FROM context_manifests WHERE snapshot_id = ?').get(snapshotId),
      },
      events: database.prepare('SELECT * FROM events WHERE project_id = ? ORDER BY timestamp ASC, rowid ASC').all(flow.projectId) as any[],
    };
  }

  // Reusable complete domain capture helper for replay tests
  function captureFullDomainSnapshot(database: Database.Database) {
    return {
      projects: database.prepare('SELECT * FROM projects ORDER BY id').all(),
      tasks: database.prepare('SELECT * FROM tasks ORDER BY id').all(),
      protocol_messages: database.prepare('SELECT * FROM protocol_messages ORDER BY id').all(),
      handoff_transfers: database.prepare('SELECT * FROM handoff_transfers ORDER BY id').all(),
      task_attempts: database.prepare('SELECT * FROM task_attempts ORDER BY id').all(),
      agent_assignments: database.prepare('SELECT * FROM agent_assignments ORDER BY id').all(),
      execution_authorizations: database.prepare('SELECT * FROM execution_authorizations ORDER BY id').all(),
      account_leases: database.prepare('SELECT * FROM account_leases ORDER BY id').all(),
      worker_slots: database.prepare('SELECT * FROM worker_slots ORDER BY id').all(),
      events: database.prepare('SELECT * FROM events ORDER BY id').all(),
      context_snapshots: database.prepare('SELECT * FROM context_snapshots ORDER BY id').all(),
      context_items: database.prepare('SELECT * FROM context_items ORDER BY id').all(),
      context_manifests: database.prepare('SELECT * FROM context_manifests ORDER BY id').all(),
      execution_recovery_states: database.prepare('SELECT * FROM execution_recovery_states ORDER BY id').all(),
    };
  }

  // Reusable complete Project-2 isolation snapshot helper
  function captureProject2IsolationSnapshot(database: Database.Database, p2Flow: ProductionHandoffContext) {
    const p2Snapshots = database.prepare('SELECT * FROM context_snapshots WHERE task_id = ? ORDER BY id').all(p2Flow.taskId);
    const p2SnapshotIds = p2Snapshots.map((s: any) => s.id);
    const snapInClause = p2SnapshotIds.length > 0 ? `(${p2SnapshotIds.map(() => '?').join(',')})` : "('')";

    return {
      project: database.prepare('SELECT * FROM projects WHERE id = ?').get(p2Flow.projectId),
      tasks: database.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY id').all(p2Flow.projectId),
      protocol_messages: database.prepare('SELECT * FROM protocol_messages WHERE project_id = ? ORDER BY id').all(p2Flow.projectId),
      events: database.prepare('SELECT * FROM events WHERE project_id = ? ORDER BY id').all(p2Flow.projectId),
      transfers: database.prepare('SELECT * FROM handoff_transfers WHERE task_id = ? ORDER BY id').all(p2Flow.taskId),
      attempts: database.prepare('SELECT * FROM task_attempts WHERE task_id = ? ORDER BY id').all(p2Flow.taskId),
      assignments: database.prepare('SELECT * FROM agent_assignments WHERE project_id = ? ORDER BY id').all(p2Flow.projectId),
      authorizations: database.prepare('SELECT * FROM execution_authorizations WHERE project_id = ? ORDER BY id').all(p2Flow.projectId),
      accounts: database.prepare('SELECT * FROM provider_accounts WHERE id IN (?, ?) ORDER BY id').all(p2Flow.accountAId, p2Flow.accountBId),
      resources: database.prepare('SELECT * FROM provider_resources WHERE id IN (?, ?) ORDER BY id').all(p2Flow.resourceAId, p2Flow.resourceBId),
      slots: database.prepare('SELECT * FROM worker_slots WHERE provider_account_id IN (?, ?) ORDER BY id').all(p2Flow.accountAId, p2Flow.accountBId),
      leases: database.prepare('SELECT * FROM account_leases WHERE provider_account_id IN (?, ?) ORDER BY id').all(p2Flow.accountAId, p2Flow.accountBId),
      contextSnapshots: p2Snapshots,
      contextItems: p2SnapshotIds.length > 0
        ? database.prepare(`SELECT * FROM context_items WHERE snapshot_id IN ${snapInClause} ORDER BY id`).all(...p2SnapshotIds)
        : [],
      contextManifests: p2SnapshotIds.length > 0
        ? database.prepare(`SELECT * FROM context_manifests WHERE snapshot_id IN ${snapInClause} ORDER BY id`).all(...p2SnapshotIds)
        : [],
      recoveryStates: database.prepare('SELECT * FROM execution_recovery_states WHERE authorization_id = ? ORDER BY id').all(p2Flow.authorizationId!),
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

    // Prove production routing decision event contains exact scope bindings from request
    const routingEvent = repo.getRoutingDecisionEvent(decision.decisionId)!;
    expect(routingEvent).toBeDefined();
    expect(routingEvent.type).toBe('ROLE_AWARE_ROUTING_DECISION');
    const p = routingEvent.structured_payload as Record<string, unknown>;
    expect(p.projectId).toBe(flow.projectId);
    expect(p.taskId).toBe(flow.taskId);
    expect(p.attemptId).toBe(flow.succAttId!);
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

    // Assert exact scope agreement in stored routing decision event
    const routingEvent = repo.getRoutingDecisionEvent(decision.decisionId)!;
    const p = routingEvent.structured_payload as Record<string, unknown>;
    expect(p.projectId).toBe(auth.project_id);
    expect(p.taskId).toBe(auth.task_id);
    expect(p.attemptId).toBe(auth.attempt_id);
  });

  // 8. Successor cannot start before accepted handoff authority
  it('8. Successor cannot start before accepted handoff authority', async () => {
    // Flow stops legitimately at AUTHORIZED (before acceptance)
    const flow = await runProductionHandoffFlow({ stopAt: 'AUTHORIZED' });

    // Provider dispatch before ACCEPTED must fail closed specifically with EXECUTION_AUTHORIZATION_NOT_ACCEPTED
    const dispatchRes = await dispatchService.dispatch(flow.authorizationId!);

    expect(dispatchRes.status).toBe('FAILED');
    expect(dispatchRes.error).toContain('EXECUTION_AUTHORIZATION_NOT_ACCEPTED');
    expect(adapterB.invocationCount).toBe(0);
  });

  // 9. Predecessor cannot resume execution after relinquishment
  it('9. Predecessor cannot resume execution after relinquishment', async () => {
    // Initial predecessor fixture with predecessor auth claimed into DISPATCHED status
    const flow = await runProductionHandoffFlow({
      seedPredecessorAuth: true,
      dispatchPredecessorAuth: true,
      stopAt: 'RELINQUISHED',
    });

    // Snapshot predecessor authorization, task, and assignment after relinquishment and before stale claim
    const taskSnapshot = repo.getTask(flow.taskId)!;
    const predAuthSnapshot = repo.getExecutionAuthorization(flow.predAuthId!)!;
    const predAsgnSnapshot = repo.getAgentAssignment(flow.predAsgnId)!;

    expect(taskSnapshot.ownership_epoch).toBe(2);
    expect(predAuthSnapshot.status).toBe('DISPATCHED');
    expect(predAuthSnapshot.adapter_started_at).toBeNull();
    expect(predAsgnSnapshot.status).toBe('HANDED_OFF');

    // 1. Attempt adapter-start claim with stale epoch 1 fails specifically identifying epoch authority
    const startClaimRes = repo.claimAdapterExecutionStart({
      authorizationId: flow.predAuthId!,
      executionId: 'exec-stale-pred',
      expectedEpoch: 1,
    });
    expect(startClaimRes.success).toBe(false);
    expect(startClaimRes.error).toContain('OWNERSHIP_EPOCH_MISMATCH');

    // 2. Predecessor dispatch fails closed after relinquishment with applicable error code and reason
    const dispatchRes = await dispatchService.dispatch(flow.predAuthId!);
    expect(dispatchRes.status).toBe('FAILED');
    expect(dispatchRes.errorCode).toBe('RECOVERY_FENCED');
    expect(dispatchRes.error).toContain('EXECUTION_AUTHORIZATION_ALREADY_DISPATCHED');

    // 3. Prove zero execution ID, adapter timestamps, settlement evidence, deterministic settlement events, runtime result events and Provider-A invocations
    const predAuthAfter = repo.getExecutionAuthorization(flow.predAuthId!)!;
    const predAsgnAfter = repo.getAgentAssignment(flow.predAsgnId)!;
    const taskAfter = repo.getTask(flow.taskId)!;

    expect(predAuthAfter.execution_id).toBeNull();
    expect(predAuthAfter.adapter_started_at).toBeNull();
    expect(predAuthAfter.adapter_finished_at).toBeNull();
    expect(predAuthAfter.settlement_evidence_json).toBeNull();
    expect(predAuthAfter.settlement_evidence_hash).toBeNull();
    expect(predAuthAfter.settled_at).toBeNull();
    expect(predAuthAfter.settlement_status).toBeNull();

    const settlementEvents = db.prepare("SELECT * FROM events WHERE project_id = ? AND type LIKE 'HANDOFF_SUCCESSOR_EXECUTION_%'").all(flow.projectId);
    expect(settlementEvents.length).toBe(0);

    const runtimeEvents = db.prepare("SELECT * FROM events WHERE project_id = ? AND type = 'PROVIDER_RUNTIME_EXECUTION_RESULT'").all(flow.projectId);
    expect(runtimeEvents.length).toBe(0);

    expect(adapterA.invocationCount).toBe(0);

    // 4. Deep-compare task, predecessor assignment and predecessor authorization before and after both rejected operations
    expect(taskAfter).toEqual(taskSnapshot);
    expect(predAuthAfter).toEqual(predAuthSnapshot);
    expect(predAsgnAfter).toEqual(predAsgnSnapshot);
  });

  // 10. Adapter-start claim invokes Provider B exactly once
  it('10. Adapter-start claim invokes Provider B exactly once', async () => {
    const flow = await runProductionHandoffFlow();

    expect(flow.schedulerResult!.status).toBe('COMPLETED');
    expect(adapterB.invocationCount).toBe(1);
    expect(adapterA.invocationCount).toBe(0);
  });

  // 11. Concurrent/replayed dispatch through two physical connections produces exactly one adapter call
  it('11. Concurrent/replayed dispatch through two physical connections produces exactly one adapter call', async () => {
    const flow = await runProductionHandoffFlow({ stopAt: 'ACCEPTED' });

    // Open second physical connection with standard EventService
    const db2 = new Database(dbPath);
    db2.pragma('foreign_keys = ON');
    const repo2 = new Repository(db2);
    const eventService2 = new EventService(repo2);
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
        mode: 'SCHEDULED',
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
      adapterBReturnResult: spoofedReturnResult,
    });

    expect(flow.schedulerResult!.status).toBe('COMPLETED');
    expect(adapterB.invocationCount).toBe(1);
    expect(adapterA.invocationCount).toBe(0);

    const auth = repo.getExecutionAuthorization(flow.authorizationId!)!;
    const providerResult = flow.schedulerResult!.providerResult!;
    const prov = providerResult.providerExecutionProvenance!;

    // Assert authentic Provider B provenance stamped on providerResult
    expect(prov).toBeDefined();
    expect(prov.version).toBe(1);
    expect(prov.source).toBe('PROVIDER_DISPATCH_SERVICE');
    expect(prov.mode).toBe('SCHEDULED');
    expect(prov.adapterInvocation).toBe('RETURNED');
    expect(prov.authorizationId).toBe(flow.authorizationId);
    expect(prov.executionId).toBe(auth.execution_id);
    expect(prov.projectId).toBe(flow.projectId);
    expect(prov.taskId).toBe(flow.taskId);
    expect(prov.attemptId).toBe(flow.succAttId);
    expect(prov.routingDecisionId).toBe(flow.routingDecisionId);
    expect(prov.providerId).toBe(providerBId);
    expect(prov.accountId).toBe(flow.accountBId);
    expect(prov.resourceId).toBe(flow.resourceBId);
    expect(prov.assignmentId).toBe(flow.succAsgnId);

    // Assert none of the spoofed Provider-A values survive in the trusted provenance
    expect(prov.providerId).not.toBe(providerAId);
    expect(prov.accountId).not.toBe('spoofed-acc');
    expect(prov.resourceId).not.toBe('spoofed-res');
    expect(prov.authorizationId).not.toBe('spoofed-auth-id');
    expect(prov.executionId).not.toBe('spoofed-exec-id');
    expect(prov.assignmentId).not.toBe('spoofed-asgn-id');

    // Assert durable settlement evidence JSON
    const evidence = JSON.parse(auth.settlement_evidence_json!);
    expect(evidence.provider_id).toBe(providerBId);
    expect(evidence.account_id).toBe(flow.accountBId);
    expect(evidence.resource_id).toBe(flow.resourceBId);
    expect(evidence.assignment_id).toBe(flow.succAsgnId);
    expect(evidence.authorization_id).toBe(flow.authorizationId);
    expect(evidence.provider_id).not.toBe(providerAId);

    // Assert settlement_evidence_json.result_payload does not contain adapter-supplied providerExecutionProvenance
    expect((evidence.result_payload as any).providerExecutionProvenance).toBeUndefined();

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

    const expected19Keys = [
      'account_id',
      'assignment_id',
      'attempt_id',
      'authorization_id',
      'error_json',
      'execution_id',
      'finished_at',
      'lifecycle_version',
      'outcome',
      'ownership_epoch',
      'project_id',
      'provider_id',
      'resource_id',
      'result_payload',
      'routing_decision_id',
      'settlement_status',
      'started_at',
      'task_id',
      'transfer_id',
    ].sort();

    for (const { idSuffix, status, outcome, adapterResult } of testCases) {
      const flow = await runProductionHandoffFlow({
        projectId: `proj-13-${idSuffix}`,
        taskId: `task-13-${idSuffix}`,
        adapterBReturnResult: adapterResult,
      });

      const auth = repo.getExecutionAuthorization(flow.authorizationId!)!;
      const transfer = repo.getHandoffTransfer(flow.transferId)!;
      const attempt = repo.getTaskAttempt(flow.succAttId!)!;
      const assignment = repo.getAgentAssignment(flow.succAsgnId!)!;
      const task = repo.getTask(flow.taskId)!;
      const account = repo.getProviderAccount(flow.accountBId)!;
      const resource = repo.getProviderResource(flow.resourceBId)!;

      // 1. Assert stored evidence is a plain object with exactly the sorted 19 top-level keys
      const evidence = JSON.parse(auth.settlement_evidence_json!);
      expect(typeof evidence).toBe('object');
      expect(evidence).not.toBeNull();
      expect(Object.keys(evidence).sort()).toEqual(expected19Keys);

      // 2. Assert all identity and routing fields against durable rows
      expect(evidence.authorization_id).toBe(auth.id);
      expect(evidence.execution_id).toBe(auth.execution_id);
      expect(evidence.transfer_id).toBe(transfer.id);
      expect(evidence.project_id).toBe(task.project_id);
      expect(evidence.task_id).toBe(task.id);
      expect(evidence.attempt_id).toBe(attempt.id);
      expect(evidence.assignment_id).toBe(assignment.id);
      expect(evidence.provider_id).toBe(providerBId);
      expect(evidence.account_id).toBe(account.id);
      expect(evidence.resource_id).toBe(resource.id);
      expect(evidence.routing_decision_id).toBe(flow.routingDecisionId);
      expect(evidence.ownership_epoch).toBe(2);
      expect(evidence.lifecycle_version).toBe(1);

      // 3. Assert lifecycle, timestamps and payload equality
      expect(evidence.started_at).toBe(auth.adapter_started_at);
      expect(evidence.finished_at).toBe(auth.adapter_finished_at);
      expect(evidence.finished_at).toBe(auth.settled_at);
      expect(evidence.settlement_status).toBe(auth.settlement_status);
      expect(evidence.outcome).toBe(auth.adapter_outcome);
      expect(evidence.error_json).toBe(auth.adapter_error_json);

      const expectedSanitizedPayload = {
        ...adapterResult,
        instructions: JSON.parse(auth.canonical_instructions_json),
        contextFiles: JSON.parse(auth.context_files_json),
      };
      expect(evidence.result_payload).toEqual(expectedSanitizedPayload);

      // 4. Validate ISO timestamps and monotonic ordering
      expect(new Date(evidence.started_at).toISOString()).toBe(evidence.started_at);
      expect(new Date(evidence.finished_at).toISOString()).toBe(evidence.finished_at);
      expect(new Date(evidence.finished_at).getTime()).toBeGreaterThanOrEqual(new Date(evidence.started_at).getTime());

      // 5. Recompute canonical evidence hash
      const canonicalHash = computeSha256(canonicalJsonStringify(evidence));
      expect(auth.settlement_evidence_hash).toBe(canonicalHash);

      // 6. Derive deterministic settlement event ID and verify exact properties
      const derivedEventId = 'evt-res-' + computeSha256(`${auth.id}:${auth.execution_id}:${auth.settlement_evidence_hash}`).slice(0, 32);
      const eventType = status === 'COMPLETED'
        ? 'HANDOFF_SUCCESSOR_EXECUTION_COMPLETED'
        : status === 'CANCELLED'
        ? 'HANDOFF_SUCCESSOR_EXECUTION_CANCELLED'
        : 'HANDOFF_SUCCESSOR_EXECUTION_FAILED';

      const detEvent = db.prepare('SELECT * FROM events WHERE id = ?').get(derivedEventId) as any;
      expect(detEvent).toBeDefined();
      expect(detEvent.type).toBe(eventType);
      expect(detEvent.project_id).toBe(flow.projectId);
      expect(detEvent.task_id).toBe(flow.taskId);
      expect(detEvent.timestamp).toBe(evidence.finished_at);
      expect(detEvent.structured_payload_json).toBe(auth.settlement_evidence_json);

      // 7. Prove exactly one deterministic settlement event exists
      const allDetEvents = db.prepare("SELECT * FROM events WHERE project_id = ? AND type LIKE 'HANDOFF_SUCCESSOR_EXECUTION_%'").all(flow.projectId) as Array<{ id: string }>;
      expect(allDetEvents.length).toBe(1);
      expect(allDetEvents[0].id).toBe(derivedEventId);

      // 8. Runtime execution result event
      const executionEvents = db.prepare('SELECT * FROM events WHERE project_id = ? AND type = ?').all(
        flow.projectId,
        'PROVIDER_RUNTIME_EXECUTION_RESULT'
      );
      expect(executionEvents.length).toBe(1);

      // 9. handoff_transfers, task_attempts, and agent_assignments terminal states
      expect(transfer.status).toBe(status);
      expect(transfer.completed_at).toBe(auth.settled_at);
      expect(attempt.status).toBe(status);
      expect(attempt.ended_at).toBe(auth.settled_at);
      expect(assignment.status).toBe(status);
      expect(assignment.ended_at).toBe(auth.settled_at);

      // 10. Active lease released and matching slot returned to IDLE
      const activeLease = repo.getActiveLeaseForAssignment(flow.succAsgnId!);
      expect(activeLease).toBeNull();
      const slotB = repo.getWorkerSlot(flow.slotBId)!;
      expect(slotB.status).toBe('IDLE');
      expect(slotB.current_assignment_id).toBeNull();
      expect(slotB.current_execution_id).toBeNull();

      const slotA = repo.getWorkerSlot(flow.slotAId)!;
      expect(slotA.status).toBe('IDLE');
    }
  }, 60000);

  // 14. Successful settlement releases the exact guarded lease and returns only the matching slot to IDLE
  it('14. Successful settlement releases the exact guarded lease and returns only the matching slot to IDLE', async () => {
    const flow = await runProductionHandoffFlow();

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
    const flow = await runProductionHandoffFlow();
    expect(flow.schedulerResult!.status).toBe('COMPLETED');
    expect(adapterB.invocationCount).toBe(1);

    const auth = repo.getExecutionAuthorization(flow.authorizationId!)!;

    // Snapshot complete domain before replay
    const initialSnapshot = captureFullDomainSnapshot(db);
    const initialAdapterCount = adapterB.invocationCount;

    // 1. Replay through public HandoffTransferService methods
    const replayReq = handoffService.requestHandoff({
      requestId: flow.requestId,
      taskId: flow.taskId,
      sourceAttemptId: flow.predAttId,
      sourceAssignmentId: flow.predAsgnId,
      reason: 'PROVIDER_RATE_LIMIT_COOLDOWN',
      expectedSourceEpoch: 1,
    });
    expect(replayReq.success).toBe(false);

    const replayFreeze = handoffService.freezeHandoff({
      transferId: flow.transferId,
      expectedVersion: flow.transfer.version,
      frozenAt: new Date().toISOString(),
    });
    expect(replayFreeze.success).toBe(false);

    const replayQuiesce = handoffService.beginQuiescence({
      transferId: flow.transferId,
      expectedVersion: flow.transfer.version,
      quiescingAt: new Date().toISOString(),
    });
    expect(replayQuiesce.success).toBe(false);

    const readOnlyQuiesceEval = handoffService.evaluatePredecessorQuiescence(flow.transferId);
    expect(readOnlyQuiesceEval).toBeDefined();

    const replayRelinquish = handoffService.relinquishPredecessorOwnership({
      transferId: flow.transferId,
      expectedVersion: flow.transfer.version,
      expectedSourceEpoch: 1,
      relinquishedAt: new Date().toISOString(),
    });
    expect(replayRelinquish.success).toBe(false);

    const replayPrepare = handoffService.prepareHandoffSuccessor({
      transferId: flow.transferId,
      expectedVersion: flow.transfer.version,
      expectedSuccessorEpoch: 2,
      successorRoleProfileId: 'role-coder-closure',
      successorAgentProfileId: 'agent-succ-prof',
      buildContext: true,
      contextFiles: ['README.md'],
    });
    expect(replayPrepare.success).toBe(false);

    const replayRoute = await handoffService.routeHandoffSuccessor({
      transferId: flow.transferId,
      expectedVersion: flow.transfer.version,
      expectedSuccessorEpoch: 2,
    });
    expect(replayRoute.success).toBe(false);

    const replayResume = await handoffService.resumeHandoffSuccessor({
      transferId: flow.transferId,
      expectedVersion: flow.transfer.version,
    });
    expect(replayResume.success).toBe(false);

    // 2. Re-acquisition of a lease for the terminal assignment fails closed
    const reacquireLease = leaseService.acquireForAssignment(flow.succAsgnId!, 60000);
    expect(reacquireLease.status).toBe('FAILED');
    if (reacquireLease.status !== 'FAILED') {
      throw new Error(`Expected lease acquisition to fail, but status was ${reacquireLease.status}`);
    }
    expect(reacquireLease.code).toBe('ASSIGNMENT_NOT_ACQUIRABLE');
    expect(reacquireLease.error).toContain('ASSIGNMENT_NOT_ACQUIRABLE');

    // 3. acceptHandoffSuccessorExecution replay with real historical lease fails closed
    const historicalLeases = repo.getAccountLeasesByAssignment(flow.succAsgnId!);
    expect(historicalLeases.length).toBe(1);
    const histLease = historicalLeases[0];
    expect(histLease.assignment_id).toBe(flow.succAsgnId);
    expect(histLease.provider_account_id).toBe(flow.accountBId);
    expect(histLease.worker_slot_id).toBe(flow.slotBId);
    expect(histLease.released_at).not.toBeNull();
    expect(typeof histLease.lease_token).toBe('string');
    expect(histLease.lease_token.length).toBeGreaterThan(0);

    const replayAccept = repo.acceptHandoffSuccessorExecution({
      authorizationId: flow.authorizationId!,
      leaseId: histLease.id,
      leaseToken: histLease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(replayAccept.success).toBe(false);
    expect(replayAccept.errorCode).toBe('STATUS_CONFLICT');
    expect(replayAccept.error).toBeDefined();
    expect(replayAccept.error).toContain(flow.transfer.status);

    // 4. claimAdapterExecutionStart replay with stored execution ID returns idempotent success
    const replayStart = repo.claimAdapterExecutionStart({
      authorizationId: flow.authorizationId!,
      executionId: auth.execution_id!,
      expectedEpoch: 2,
      expectedLifecycleVersion: 1,
    });
    expect(replayStart.success).toBe(true);
    expect(replayStart.alreadyClaimed).toBe(true);

    // 5. settleExecutionResult replay reconstructed from stored canonical evidence returns idempotent success
    const storedEvidence = JSON.parse(auth.settlement_evidence_json!);
    const replaySettle = repo.settleExecutionResult({
      authorizationId: flow.authorizationId!,
      executionId: auth.execution_id!,
      outcome: auth.adapter_outcome!,
      status: auth.settlement_status!,
      finishedAt: auth.settled_at!,
      resultPayload: storedEvidence.result_payload,
      errorJson: auth.adapter_error_json,
    });
    expect(replaySettle.success).toBe(true);
    expect(replaySettle.alreadySettled).toBe(true);

    // 6. Scheduler and direct-dispatch replay against terminal settled authorization
    const replayScheduler = await scheduler.execute(flow.authorizationId!);
    expect(replayScheduler.status).toBe('RECOVERY_FENCED');

    const replayDispatch = await dispatchService.dispatch(flow.authorizationId!);
    expect(replayDispatch.status).toBe('FAILED');
    expect(replayDispatch.errorCode).toBe('RECOVERY_FENCED');

    // Deep-compare every domain table before and after replay
    const finalSnapshot = captureFullDomainSnapshot(db);
    expect(finalSnapshot).toEqual(initialSnapshot);

    // Explicitly prove zero second lease, execution ID, context items, recovery rows, events, or adapter invocations
    expect((db.prepare('SELECT COUNT(*) as c FROM account_leases').get() as { c: number }).c).toBe(initialSnapshot.account_leases.length);
    expect((db.prepare('SELECT COUNT(DISTINCT execution_id) as c FROM execution_authorizations WHERE execution_id IS NOT NULL').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) as c FROM context_snapshots').get() as { c: number }).c).toBe(initialSnapshot.context_snapshots.length);
    expect((db.prepare('SELECT COUNT(*) as c FROM context_items').get() as { c: number }).c).toBe(initialSnapshot.context_items.length);
    expect((db.prepare('SELECT COUNT(*) as c FROM context_manifests').get() as { c: number }).c).toBe(initialSnapshot.context_manifests.length);
    expect((db.prepare('SELECT COUNT(*) as c FROM execution_recovery_states').get() as { c: number }).c).toBe(initialSnapshot.execution_recovery_states.length);
    expect((db.prepare('SELECT COUNT(*) as c FROM events').get() as { c: number }).c).toBe(initialSnapshot.events.length);
    expect(adapterB.invocationCount).toBe(initialAdapterCount);
  });

  // 16. Stale ownership epoch and corrupted provider/account/resource bindings fail before adapter invocation with fail-closed invalidation as the single permitted authority mutation
  it('16. Stale ownership epoch and corrupted provider/account/resource bindings fail before adapter invocation with fail-closed invalidation as the single permitted authority mutation', async () => {
    const subcases: Array<{
      idSuffix: string;
      name: string;
      corrupt: (flow: ProductionHandoffContext) => void;
      expectedStatus: 'FAILED';
      expectedErrorCode: string | undefined;
      expectedErrorSubstring: string;
    }> = [
      {
        idSuffix: '1',
        name: 'Stale ownership epoch',
        corrupt: (flow: ProductionHandoffContext) => {
          db.prepare('UPDATE tasks SET ownership_epoch = 99 WHERE id = ?').run(flow.taskId);
        },
        expectedStatus: 'FAILED',
        expectedErrorCode: 'RESOURCE_UNAVAILABLE',
        expectedErrorSubstring: 'does not match authorization authority',
      },
      {
        idSuffix: '2',
        name: 'Routing provider mismatch',
        corrupt: (flow: ProductionHandoffContext) => {
          const routingEvent = repo.getRoutingDecisionEvent(flow.routingDecisionId!)!;
          const p = routingEvent.structured_payload as Record<string, unknown>;
          p.selectedProviderId = 'prov-mismatch-alpha';
          db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(
            JSON.stringify(p),
            routingEvent.id
          );
        },
        expectedStatus: 'FAILED',
        expectedErrorCode: undefined,
        expectedErrorSubstring: 'EXECUTION_AUTHORIZATION_ROUTING_PROVIDER_MISMATCH',
      },
      {
        idSuffix: '3',
        name: 'Routing account mismatch',
        corrupt: (flow: ProductionHandoffContext) => {
          const routingEvent = repo.getRoutingDecisionEvent(flow.routingDecisionId!)!;
          const p = routingEvent.structured_payload as Record<string, unknown>;
          p.selectedAccountId = 'acc-mismatch-beta';
          db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(
            JSON.stringify(p),
            routingEvent.id
          );
        },
        expectedStatus: 'FAILED',
        expectedErrorCode: 'RESOURCE_UNAVAILABLE',
        expectedErrorSubstring: 'payload does not match successor binding authority',
      },
      {
        idSuffix: '4',
        name: 'Routing resource mismatch',
        corrupt: (flow: ProductionHandoffContext) => {
          const routingEvent = repo.getRoutingDecisionEvent(flow.routingDecisionId!)!;
          const p = routingEvent.structured_payload as Record<string, unknown>;
          p.selectedResourceId = 'res-mismatch-beta';
          db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(
            JSON.stringify(p),
            routingEvent.id
          );
        },
        expectedStatus: 'FAILED',
        expectedErrorCode: undefined,
        expectedErrorSubstring: 'EXECUTION_AUTHORIZATION_ROUTING_RESOURCE_MISMATCH',
      },
      {
        idSuffix: '5',
        name: 'Resource-account mismatch',
        corrupt: (flow: ProductionHandoffContext) => {
          db.prepare('UPDATE provider_resources SET provider_account_id = ? WHERE id = ?').run(
            flow.accountAId,
            flow.authorization!.selected_resource_id
          );
        },
        expectedStatus: 'FAILED',
        expectedErrorCode: 'RESOURCE_UNAVAILABLE',
        expectedErrorSubstring: 'ROUTING_RESOURCE_ACCOUNT_MISMATCH',
      },
    ];

    for (const sc of subcases) {
      const flow = await runProductionHandoffFlow({
        projectId: `proj-16-${sc.idSuffix}`,
        taskId: `task-16-${sc.idSuffix}`,
        stopAt: 'ACCEPTED',
      });

      const initialAdapterCount = adapterB.invocationCount;

      // 1. Apply only the authorized corruption
      sc.corrupt(flow);

      // 2. Capture complete graph after corruption and before dispatch
      const preSnapshot = captureAuthoritySnapshot(db, flow);
      const preAuth = preSnapshot.authorityGraph.authorization as Record<string, unknown>;
      expect(preAuth.status).toBe('AUTHORIZED');

      // 3. Invoke real dispatch path
      const res = await dispatchService.dispatch(flow.authorizationId!);
      expect(res.status).toBe(sc.expectedStatus);
      expect(res.errorCode).toBe(sc.expectedErrorCode);
      expect(res.error).toBeDefined();
      expect(res.error).toContain(sc.expectedErrorSubstring);

      // 4. Capture complete graph after rejected dispatch
      const postSnapshot = captureAuthoritySnapshot(db, flow);

      // 5. Assert adapter invocation count is unchanged from baseline
      expect(adapterB.invocationCount).toBe(initialAdapterCount);

      // 6. Assert authorization has no execution ID, timestamps, or settlement evidence
      const postAuth = postSnapshot.authorityGraph.authorization as Record<string, unknown>;
      expect(postAuth.status).toBe('INVALIDATED');
      expect(postAuth.execution_id).toBeNull();
      expect(postAuth.adapter_started_at).toBeNull();
      expect(postAuth.adapter_finished_at).toBeNull();
      expect(postAuth.settled_at).toBeNull();
      expect(postAuth.settlement_status).toBeNull();
      expect(postAuth.settlement_evidence_json).toBeNull();
      expect(postAuth.settlement_evidence_hash).toBeNull();

      // 7. Deep-compare entire authorityGraph (accounting for status: INVALIDATED as the single permitted authority mutation)
      expect({
        ...postSnapshot.authorityGraph,
        authorization: { ...postAuth, status: 'AUTHORIZED' },
      }).toEqual(preSnapshot.authorityGraph);

      // 8. Assert event delta equals exactly one EXECUTION_AUTHORIZATION_REJECTED event
      const preEventIds = new Set(preSnapshot.events.map((e: { id: string }) => e.id));
      const postEvents = postSnapshot.events as Array<{ id: string; type: string; project_id: string; task_id: string; structured_payload_json: string | null }>;
      const newEvents = postEvents.filter((e) => !preEventIds.has(e.id));
      expect(newEvents.length).toBe(1);
      const rejEvent = newEvents[0];
      expect(rejEvent.type).toBe('EXECUTION_AUTHORIZATION_REJECTED');
      expect(rejEvent.project_id).toBe(flow.projectId);
      expect(rejEvent.task_id).toBe(flow.taskId);

      const rejPayload = JSON.parse(rejEvent.structured_payload_json ?? '{}');
      expect(rejPayload.authorizationId).toBe(flow.authorizationId);
      expect(rejPayload.projectId).toBe(flow.projectId);
      expect(rejPayload.taskId).toBe(flow.taskId);
      expect(rejPayload.reason).toBe(res.error);
      expect(rejPayload.status).toBe('INVALIDATED');
      expect(rejPayload.reason).toContain(sc.expectedErrorSubstring);

      // 9. Assert zero settlement or runtime-result events
      const detEvents = db.prepare("SELECT * FROM events WHERE project_id = ? AND type LIKE 'HANDOFF_SUCCESSOR_EXECUTION_%'").all(flow.projectId) as Array<{ id: string }>;
      expect(detEvents.length).toBe(0);

      const runtimeEvents = db.prepare("SELECT * FROM events WHERE project_id = ? AND type = 'PROVIDER_RUNTIME_EXECUTION_RESULT'").all(flow.projectId) as Array<{ id: string }>;
      expect(runtimeEvents.length).toBe(0);
    }
  }, 60000);

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

    // Reopen physical database with standard EventService and scan
    const dbRestarted = new Database(dbPath);
    dbRestarted.pragma('foreign_keys = ON');
    const repoRestarted = new Repository(dbRestarted);
    const eventServiceRestarted = new EventService(repoRestarted);
    const scannerRestarted = new ExecutionRecoveryScanner(
      dbRestarted,
      repoRestarted,
      eventServiceRestarted
    );

    const reconRes = scannerRestarted.reconcileAuthorization(flow.authorizationId!);
    expect(reconRes.classification).toBe('ADAPTER_IN_FLIGHT_UNRESOLVED');
    expect(reconRes.disposition).toBe('UNRESOLVED_FENCED');

    // Attempted dispatch remains recovery-fenced with zero adapter invocations
    const dispatchRestarted = new ProviderDispatchService(
      registry,
      repoRestarted,
      eventServiceRestarted,
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

    // Reopen physical database with standard EventService and reconcile
    const dbRestarted = new Database(dbPath);
    dbRestarted.pragma('foreign_keys = ON');
    const repoRestarted = new Repository(dbRestarted);
    const eventServiceRestarted = new EventService(repoRestarted);
    const scannerRestarted = new ExecutionRecoveryScanner(
      dbRestarted,
      repoRestarted,
      eventServiceRestarted
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
    const eventServiceRestarted = new EventService(repoRestarted);
    const scannerRestarted = new ExecutionRecoveryScanner(
      dbRestarted,
      repoRestarted,
      eventServiceRestarted
    );

    // First scan reconciles
    const firstScan = scannerRestarted.scanAndReconcile();
    expect(firstScan.scannedCount).toBeGreaterThanOrEqual(1);

    // Snapshot complete canonical rows after first scan
    const authsAfterFirst = dbRestarted.prepare('SELECT * FROM execution_authorizations ORDER BY id').all();
    const transfersAfterFirst = dbRestarted.prepare('SELECT * FROM handoff_transfers ORDER BY id').all();
    const attemptsAfterFirst = dbRestarted.prepare('SELECT * FROM task_attempts ORDER BY id').all();
    const assignmentsAfterFirst = dbRestarted.prepare('SELECT * FROM agent_assignments ORDER BY id').all();
    const recoveryAfterFirst = dbRestarted.prepare('SELECT * FROM execution_recovery_states ORDER BY id').all();
    const eventsAfterFirst = dbRestarted.prepare('SELECT * FROM events ORDER BY id').all();
    const leasesAfterFirst = dbRestarted.prepare('SELECT * FROM account_leases ORDER BY id').all();
    const slotsAfterFirst = dbRestarted.prepare('SELECT * FROM worker_slots ORDER BY id').all();

    // Second scan is deterministic no-op
    const secondScan = scannerRestarted.scanAndReconcile();
    expect(secondScan.alreadyReconciledCount).toBeGreaterThanOrEqual(1);

    const authsAfterSecond = dbRestarted.prepare('SELECT * FROM execution_authorizations ORDER BY id').all();
    const transfersAfterSecond = dbRestarted.prepare('SELECT * FROM handoff_transfers ORDER BY id').all();
    const attemptsAfterSecond = dbRestarted.prepare('SELECT * FROM task_attempts ORDER BY id').all();
    const assignmentsAfterSecond = dbRestarted.prepare('SELECT * FROM agent_assignments ORDER BY id').all();
    const recoveryAfterSecond = dbRestarted.prepare('SELECT * FROM execution_recovery_states ORDER BY id').all();
    const eventsAfterSecond = dbRestarted.prepare('SELECT * FROM events ORDER BY id').all();
    const leasesAfterSecond = dbRestarted.prepare('SELECT * FROM account_leases ORDER BY id').all();
    const slotsAfterSecond = dbRestarted.prepare('SELECT * FROM worker_slots ORDER BY id').all();

    // Deep comparison proves exact preservation and zero duplicate recovery/audit events
    expect(authsAfterSecond).toEqual(authsAfterFirst);
    expect(transfersAfterSecond).toEqual(transfersAfterFirst);
    expect(attemptsAfterSecond).toEqual(attemptsAfterFirst);
    expect(assignmentsAfterSecond).toEqual(assignmentsAfterFirst);
    expect(recoveryAfterSecond).toEqual(recoveryAfterFirst);
    expect(eventsAfterSecond).toEqual(eventsAfterFirst);
    expect(leasesAfterSecond).toEqual(leasesAfterFirst);
    expect(slotsAfterSecond).toEqual(slotsAfterFirst);

    dbRestarted.close();
    db = new Database(dbPath);
  }, 60000);

  // 20. Provider A -> Provider B evidence remains isolated from unrelated projects, attempts, accounts, and resources
  it('20. Provider A -> Provider B evidence remains isolated from unrelated projects, attempts, accounts, and resources', async () => {
    // 1. Execute Project 2 through a complete terminal production handoff via scheduler
    const p2Flow = await runProductionHandoffFlow({
      projectId: 'proj-closure-iso-2',
      taskId: 'task-closure-iso-2',
      predecessorAttemptId: 'att-iso-2-pred',
      predecessorAssignmentId: 'asgn-iso-2-pred',
    });
    expect(p2Flow.schedulerResult!.status).toBe('COMPLETED');

    // 2. Snapshot complete Project-2 isolation domain before Project 1 execution
    const p2Before = captureProject2IsolationSnapshot(db, p2Flow);

    // Verify Project 2 datasets are populated and non-empty
    expect(p2Before.tasks.length).toBeGreaterThan(0);
    expect(p2Before.protocol_messages.length).toBeGreaterThan(0);
    expect(p2Before.events.length).toBeGreaterThan(0);
    expect(p2Before.transfers.length).toBeGreaterThan(0);
    expect(p2Before.attempts.length).toBeGreaterThan(0);
    expect(p2Before.assignments.length).toBeGreaterThan(0);
    expect(p2Before.authorizations.length).toBeGreaterThan(0);
    expect(p2Before.accounts.length).toBeGreaterThan(0);
    expect(p2Before.resources.length).toBeGreaterThan(0);
    expect(p2Before.slots.length).toBeGreaterThan(0);
    expect(p2Before.leases.length).toBeGreaterThan(0);
    expect(p2Before.contextSnapshots.length).toBeGreaterThan(0);
    expect(p2Before.contextItems.length).toBeGreaterThan(0);
    expect(p2Before.contextManifests.length).toBeGreaterThan(0);

    // 3. Execute complete Provider A -> Provider B handoff for Project 1
    const p1Flow = await runProductionHandoffFlow({
      projectId: 'proj-closure-iso-1',
      taskId: 'task-closure-iso-1',
      predecessorAttemptId: 'att-iso-1-pred',
      predecessorAssignmentId: 'asgn-iso-1-pred',
    });
    expect(p1Flow.schedulerResult!.status).toBe('COMPLETED');

    // 4. Snapshot complete Project-2 isolation domain after Project 1 execution
    const p2After = captureProject2IsolationSnapshot(db, p2Flow);

    // 5. Canonically deep-compare all Project-2 datasets before and after
    expect(p2After).toEqual(p2Before);

    // 6. Prove Project-1 assignments and authorizations reference no Project-2 task, attempt, assignment, account or resource
    const p1AsgnsWithP2 = db.prepare(`
      SELECT * FROM agent_assignments
      WHERE project_id = ? AND (
        task_id = ? OR attempt_id IN (?, ?) OR selected_account_id IN (?, ?) OR selected_resource_id IN (?, ?)
      )
    `).all(p1Flow.projectId, p2Flow.taskId, p2Flow.predAttId, p2Flow.succAttId!, p2Flow.accountAId, p2Flow.accountBId, p2Flow.resourceAId, p2Flow.resourceBId);
    expect(p1AsgnsWithP2.length).toBe(0);

    const p1AuthsWithP2 = db.prepare(`
      SELECT * FROM execution_authorizations
      WHERE project_id = ? AND (
        task_id = ? OR attempt_id IN (?, ?) OR assignment_id IN (?, ?) OR selected_account_id IN (?, ?) OR selected_resource_id IN (?, ?)
      )
    `).all(p1Flow.projectId, p2Flow.taskId, p2Flow.predAttId, p2Flow.succAttId!, p2Flow.predAsgnId, p2Flow.succAsgnId!, p2Flow.accountAId, p2Flow.accountBId, p2Flow.resourceAId, p2Flow.resourceBId);
    expect(p1AuthsWithP2.length).toBe(0);

    // 7. Prove Project-2 assignments and authorizations reference no Project-1 task, attempt, assignment, account or resource
    const p2AsgnsWithP1 = db.prepare(`
      SELECT * FROM agent_assignments
      WHERE project_id = ? AND (
        task_id = ? OR attempt_id IN (?, ?) OR selected_account_id IN (?, ?) OR selected_resource_id IN (?, ?)
      )
    `).all(p2Flow.projectId, p1Flow.taskId, p1Flow.predAttId, p1Flow.succAttId!, p1Flow.accountAId, p1Flow.accountBId, p1Flow.resourceAId, p1Flow.resourceBId);
    expect(p2AsgnsWithP1.length).toBe(0);

    const p2AuthsWithP1 = db.prepare(`
      SELECT * FROM execution_authorizations
      WHERE project_id = ? AND (
        task_id = ? OR attempt_id IN (?, ?) OR assignment_id IN (?, ?) OR selected_account_id IN (?, ?) OR selected_resource_id IN (?, ?)
      )
    `).all(p2Flow.projectId, p1Flow.taskId, p1Flow.predAttId, p1Flow.succAttId!, p1Flow.predAsgnId, p1Flow.succAsgnId!, p1Flow.accountAId, p1Flow.accountBId, p1Flow.resourceAId, p1Flow.resourceBId);
    expect(p2AuthsWithP1.length).toBe(0);

    // 8. Prove transfers in each project reference only their own task, attempts, assignments and successor authorization
    const p1Transfers = db.prepare('SELECT * FROM handoff_transfers WHERE task_id = ?').all(p1Flow.taskId) as any[];
    for (const t of p1Transfers) {
      expect(t.task_id).toBe(p1Flow.taskId);
      expect(t.source_attempt_id).toBe(p1Flow.predAttId);
      expect(t.source_assignment_id).toBe(p1Flow.predAsgnId);
      expect(t.successor_attempt_id).toBe(p1Flow.succAttId);
      expect(t.successor_assignment_id).toBe(p1Flow.succAsgnId);
      expect(t.successor_authorization_id).toBe(p1Flow.authorizationId);
    }
    const p2Transfers = db.prepare('SELECT * FROM handoff_transfers WHERE task_id = ?').all(p2Flow.taskId) as any[];
    for (const t of p2Transfers) {
      expect(t.task_id).toBe(p2Flow.taskId);
      expect(t.source_attempt_id).toBe(p2Flow.predAttId);
      expect(t.source_assignment_id).toBe(p2Flow.predAsgnId);
      expect(t.successor_attempt_id).toBe(p2Flow.succAttId);
      expect(t.successor_assignment_id).toBe(p2Flow.succAsgnId);
      expect(t.successor_authorization_id).toBe(p2Flow.authorizationId);
    }

    // 9. Prove leases joined through assignments reject cross-project account/slot references
    const p1LeasesWithP2 = db.prepare(`
      SELECT l.* FROM account_leases l
      JOIN agent_assignments a ON l.assignment_id = a.id
      WHERE a.project_id = ? AND (
        l.provider_account_id IN (?, ?) OR l.worker_slot_id LIKE ? OR l.worker_slot_id LIKE ?
      )
    `).all(p1Flow.projectId, p2Flow.accountAId, p2Flow.accountBId, `%${p2Flow.taskId}%`, `%${p2Flow.taskId}%`);
    expect(p1LeasesWithP2.length).toBe(0);

    const p2LeasesWithP1 = db.prepare(`
      SELECT l.* FROM account_leases l
      JOIN agent_assignments a ON l.assignment_id = a.id
      WHERE a.project_id = ? AND (
        l.provider_account_id IN (?, ?) OR l.worker_slot_id LIKE ? OR l.worker_slot_id LIKE ?
      )
    `).all(p2Flow.projectId, p1Flow.accountAId, p1Flow.accountBId, `%${p1Flow.taskId}%`, `%${p1Flow.taskId}%`);
    expect(p2LeasesWithP1.length).toBe(0);

    // 10. Worker slots for either project's accounts must not contain the other project's assignment or execution ID
    const p1SlotsWithP2 = db.prepare(`
      SELECT * FROM worker_slots
      WHERE provider_account_id IN (?, ?) AND (
        current_assignment_id IN (?, ?) OR current_execution_id IN (
          SELECT execution_id FROM execution_authorizations WHERE project_id = ? AND execution_id IS NOT NULL
        )
      )
    `).all(p1Flow.accountAId, p1Flow.accountBId, p2Flow.predAsgnId, p2Flow.succAsgnId!, p2Flow.projectId);
    expect(p1SlotsWithP2.length).toBe(0);

    const p2SlotsWithP1 = db.prepare(`
      SELECT * FROM worker_slots
      WHERE provider_account_id IN (?, ?) AND (
        current_assignment_id IN (?, ?) OR current_execution_id IN (
          SELECT execution_id FROM execution_authorizations WHERE project_id = ? AND execution_id IS NOT NULL
        )
      )
    `).all(p2Flow.accountAId, p2Flow.accountBId, p1Flow.predAsgnId, p1Flow.succAsgnId!, p1Flow.projectId);
    expect(p2SlotsWithP1.length).toBe(0);

    // 11. Events and protocol messages must retain their own project/task bindings
    const p1Events = db.prepare('SELECT * FROM events WHERE project_id = ?').all(p1Flow.projectId) as any[];
    for (const e of p1Events) {
      expect(e.project_id).toBe(p1Flow.projectId);
      if (e.task_id) expect(e.task_id).toBe(p1Flow.taskId);
    }
    const p2Events = db.prepare('SELECT * FROM events WHERE project_id = ?').all(p2Flow.projectId) as any[];
    for (const e of p2Events) {
      expect(e.project_id).toBe(p2Flow.projectId);
      if (e.task_id) expect(e.task_id).toBe(p2Flow.taskId);
    }
    const p1Msgs = db.prepare('SELECT * FROM protocol_messages WHERE project_id = ?').all(p1Flow.projectId) as any[];
    for (const m of p1Msgs) {
      expect(m.project_id).toBe(p1Flow.projectId);
      expect(m.task_id).toBe(p1Flow.taskId);
    }
    const p2Msgs = db.prepare('SELECT * FROM protocol_messages WHERE project_id = ?').all(p2Flow.projectId) as any[];
    for (const m of p2Msgs) {
      expect(m.project_id).toBe(p2Flow.projectId);
      expect(m.task_id).toBe(p2Flow.taskId);
    }

    // 12. Routing-event payloads must be parsed and checked for project-local account/resource bindings
    const p1RoutingEvents = db.prepare("SELECT * FROM events WHERE project_id = ? AND type = 'ROLE_AWARE_ROUTING_DECISION'").all(p1Flow.projectId) as any[];
    for (const re of p1RoutingEvents) {
      const p = JSON.parse(re.structured_payload_json ?? '{}');
      expect(p.projectId).toBe(p1Flow.projectId);
      expect(p.taskId).toBe(p1Flow.taskId);
      expect([p1Flow.accountAId, p1Flow.accountBId]).toContain(p.selectedAccountId);
      expect([p1Flow.resourceAId, p1Flow.resourceBId]).toContain(p.selectedResourceId);
    }
    const p2RoutingEvents = db.prepare("SELECT * FROM events WHERE project_id = ? AND type = 'ROLE_AWARE_ROUTING_DECISION'").all(p2Flow.projectId) as any[];
    for (const re of p2RoutingEvents) {
      const p = JSON.parse(re.structured_payload_json ?? '{}');
      expect(p.projectId).toBe(p2Flow.projectId);
      expect(p.taskId).toBe(p2Flow.taskId);
      expect([p2Flow.accountAId, p2Flow.accountBId]).toContain(p.selectedAccountId);
      expect([p2Flow.resourceAId, p2Flow.resourceBId]).toContain(p.selectedResourceId);
    }

    // 13. Context snapshots, items and manifests must remain bound only to their own task/attempt lineage
    const p1Snapshots = db.prepare('SELECT * FROM context_snapshots WHERE task_id = ?').all(p1Flow.taskId) as any[];
    for (const s of p1Snapshots) {
      expect(s.task_id).toBe(p1Flow.taskId);
      expect([p1Flow.predAttId, p1Flow.succAttId]).toContain(s.attempt_id);
      const items = db.prepare('SELECT * FROM context_items WHERE snapshot_id = ?').all(s.id) as any[];
      expect(items.length).toBeGreaterThan(0);
      const manifests = db.prepare('SELECT * FROM context_manifests WHERE snapshot_id = ?').all(s.id) as any[];
      expect(manifests.length).toBeGreaterThan(0);
    }
    const p2Snapshots = db.prepare('SELECT * FROM context_snapshots WHERE task_id = ?').all(p2Flow.taskId) as any[];
    for (const s of p2Snapshots) {
      expect(s.task_id).toBe(p2Flow.taskId);
      expect([p2Flow.predAttId, p2Flow.succAttId]).toContain(s.attempt_id);
      const items = db.prepare('SELECT * FROM context_items WHERE snapshot_id = ?').all(s.id) as any[];
      expect(items.length).toBeGreaterThan(0);
      const manifests = db.prepare('SELECT * FROM context_manifests WHERE snapshot_id = ?').all(s.id) as any[];
      expect(manifests.length).toBeGreaterThan(0);
    }
  }, 120000);
});
