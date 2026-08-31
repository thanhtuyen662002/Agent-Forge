import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

import { MigrationRunner, MIGRATIONS } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ProviderRegistry } from '../src/core/adapters/ProviderRegistry';
import { ProviderAdapter, QuotaSnapshotInfo } from '../src/core/adapters/ProviderAdapter';
import { EventService } from '../src/core/services/EventService';
import { WorkerSlotLeaseService, SlotLeaseSuccess } from '../src/core/services/WorkerSlotLeaseService';
import { GitWorktreeService } from '../src/core/services/GitWorktreeService';
import { ProviderDispatchService } from '../src/core/services/ProviderDispatchService';
import { ConcurrentExecutionScheduler } from '../src/core/services/ConcurrentExecutionScheduler';
import { ExecutionRecoveryScanner } from '../src/core/services/ExecutionRecoveryScanner';
import { CrashRecoveryService } from '../src/core/services/CrashRecoveryService';
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

class MockRecoveryTestAdapter implements ProviderAdapter {
  public invocationCount = 0;
  public lastRequest: any = null;

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly adapterType: ProviderAdapterType = 'LOCAL_CLI',
    private shouldThrow: boolean = false,
    private returnResult: any = { status: 'COMPLETED' }
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
      throw new Error('MOCK_ADAPTER_SIMULATED_CRASH');
    }
    return {
      ...this.returnResult,
      executionId: req.executionId,
      instructions: req.instructions,
      contextFiles: req.contextFiles,
    };
  }
  public async cancel(): Promise<void> {}
}

describe('R5I6 Crash Recovery, Execution Lifecycle Linearization, and Durable Audit Stream Authority', () => {
  let db: Database.Database;
  let repo: Repository;
  let eventService: EventService;
  let registry: ProviderRegistry;
  let adapterA: MockRecoveryTestAdapter;
  let leaseService: WorkerSlotLeaseService;
  let worktreeService: GitWorktreeService;
  let dispatchService: ProviderDispatchService;
  let scheduler: ConcurrentExecutionScheduler;
  let scanner: ExecutionRecoveryScanner;
  let crashRecoveryService: CrashRecoveryService;
  let authService: ExecutionAuthorizationService;
  let routingService: RoleAwareRoutingService;
  let contextBuilder: ContextBuilderService;
  let handoffService: HandoffTransferService;

  let tempDir: string;
  let repoDir: string;
  let worktreesDir: string;
  let baseCommitSha: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-r5i6-test-'));
    repoDir = path.join(tempDir, 'repo');
    worktreesDir = path.join(tempDir, 'worktrees');

    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(worktreesDir, { recursive: true });

    const gitExe = execSync(process.platform === 'win32' ? 'where git' : 'which git', { encoding: 'utf-8' })
      .trim()
      .split(/\r?\n/)[0];

    execSync(`"${gitExe}" init -b main`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`"${gitExe}" config user.name "Test Runner"`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`"${gitExe}" config user.email "test@runner.com"`, { cwd: repoDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(repoDir, 'README.md'), '# R5I6 Test Repo\n');
    fs.writeFileSync(path.join(repoDir, 'src_file.ts'), 'export const a = 1;\n');
    execSync(`"${gitExe}" add .`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`"${gitExe}" commit -m "initial commit"`, { cwd: repoDir, stdio: 'ignore' });
    baseCommitSha = execSync(`"${gitExe}" rev-parse HEAD`, { cwd: repoDir, encoding: 'utf-8' }).trim();

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);

    repo = new Repository(db);
    eventService = new EventService(repo);
    registry = new ProviderRegistry();

    adapterA = new MockRecoveryTestAdapter('prov-a', 'Provider Alpha', 'LOCAL_CLI');
    registry.register(adapterA);

    leaseService = new WorkerSlotLeaseService(repo);
    worktreeService = new GitWorktreeService({
      gitExecutable: gitExe,
      repositoryRoot: repoDir,
      managedRoot: worktreesDir,
    });
    dispatchService = new ProviderDispatchService(registry, repo, eventService, worktreeService);
    scheduler = new ConcurrentExecutionScheduler(repo, leaseService, worktreeService, dispatchService);
    scanner = new ExecutionRecoveryScanner(db, repo, eventService);
    crashRecoveryService = new CrashRecoveryService(db, repo, eventService);
    authService = new ExecutionAuthorizationService(repo, eventService);
    routingService = new RoleAwareRoutingService(repo, registry, eventService);
    contextBuilder = new ContextBuilderService(repo);
    handoffService = new HandoffTransferService(repo, contextBuilder, routingService);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  async function seedStandardTopology(options?: {
    transferId?: string;
    taskId?: string;
    attemptPredId?: string;
    attemptSuccId?: string;
    asgnPredId?: string;
    asgnSuccId?: string;
    acquireLease?: boolean;
    acceptSuccessor?: boolean;
  }) {
    const nowIso = new Date().toISOString();
    const projectId = 'proj-1';
    const taskId = options?.taskId ?? 'tsk-1';
    const transferId = options?.transferId ?? 'xfer-1';
    const attemptPredId = options?.attemptPredId ?? 'att-pred';
    const attemptSuccId = options?.attemptSuccId ?? 'att-succ';
    const asgnPredId = options?.asgnPredId ?? 'asgn-pred';
    const asgnSuccId = options?.asgnSuccId ?? 'asgn-succ';

    // 1. Seed Project & Task
    const existingProject = repo.getProject(projectId);
    if (!existingProject) {
      repo.createProject({
        id: projectId,
        name: 'Project 1',
        description: null,
        repository_path: repoDir,
        default_branch: 'main',
        status: 'READY',
        contract: null,
        created_at: nowIso,
        updated_at: nowIso,
        started_at: null,
        completed_at: null,
      });
    }

    repo.createTask({
      id: taskId,
      project_id: projectId,
      milestone_id: null,
      title: 'Task 1',
      description: 'Task Description',
      state: 'CODING',
      priority: 'MEDIUM',
      risk: 'LOW',
      revision_count: 1,
      max_revisions: 5,
      progress_cache_percent: 0,
      paused_from_state: null,
      assigned_agent_id: null,
      acceptance_criteria: ['Pass tests'],
      constraints: ['No regression'],
      ownership_epoch: 2,
      base_sha: baseCommitSha,
      current_sha: null,
      progress_computed_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    });

    // 2. Roles and Profiles
    const existingRole = repo.getRoleProfile('role-1');
    if (!existingRole) {
      db.prepare(`
        INSERT INTO role_profiles (id, role, display_name, required_capabilities_json, preferred_capabilities_json, permissions_json, enabled, created_at, updated_at)
        VALUES ('role-1', 'CODER', 'Coder Role', '["CODING"]', '[]', '[]', 1, ?, ?)
      `).run(nowIso, nowIso);
    }

    const existingProf = repo.getAgentProfile('agent-prof-1');
    if (!existingProf) {
      db.prepare(`
        INSERT INTO agent_profiles (id, role_profile_id, name, enabled, created_at, updated_at)
        VALUES ('agent-prof-1', 'role-1', 'Agent Coder', 1, ?, ?)
      `).run(nowIso, nowIso);
    }

    // 3. Provider & Account & Resource & Slot
    const existingProv = repo.getProvider('prov-a');
    if (!existingProv) {
      db.prepare(`INSERT INTO providers (id, name, adapter_type, enabled, created_at) VALUES ('prov-a', 'Provider Alpha', 'LOCAL_CLI', 1, ?)`).run(nowIso);
    }

    const existingAcc = repo.getProviderAccount('acc-1');
    if (!existingAcc) {
      db.prepare(`
        INSERT INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at)
        VALUES ('acc-1', 'prov-a', 'Account 1', 'NATIVE_PROFILE', 1, 10, 'AVAILABLE', 20, ?, ?)
      `).run(nowIso, nowIso);
    } else {
      db.prepare(`UPDATE provider_accounts SET concurrency_limit = 20 WHERE id = 'acc-1'`).run();
    }

    const existingRes = repo.getProviderResource('res-1');
    if (!existingRes) {
      db.prepare(`
        INSERT INTO provider_resources (id, provider_id, provider_account_id, model_name, health_status, capabilities_json, enabled, total_quota, remaining_quota, quota_unit, quota_source, quota_confidence, last_health_check)
        VALUES ('res-1', 'prov-a', 'acc-1', 'alpha-model', 'AVAILABLE', '["CODING"]', 1, 1000, 1000, 'REQUESTS', 'PROVIDER_REPORTED', 1.0, ?)
      `).run(nowIso);
    }

    const slotId = options?.asgnSuccId && options.asgnSuccId !== 'asgn-succ' ? `slot-${options.asgnSuccId}` : 'slot-1';
    const existingSlot = repo.getWorkerSlot(slotId);
    if (!existingSlot) {
      const nextIndex = (db.prepare("SELECT COALESCE(MAX(slot_index), -1) + 1 AS next_idx FROM worker_slots WHERE provider_account_id = 'acc-1'").get() as any).next_idx;
      db.prepare(`
        INSERT INTO worker_slots (id, provider_account_id, provider_resource_id, slot_index, status, created_at, updated_at)
        VALUES (?, 'acc-1', 'res-1', ?, 'IDLE', ?, ?)
      `).run(slotId, nextIndex, nowIso, nowIso);
    }

    // 4. Task Attempts
    repo.createTaskAttempt({
      id: attemptPredId,
      task_id: taskId,
      attempt_number: 1,
      status: 'HANDED_OFF',
      agent_profile_id: 'agent-prof-1',
      agent_id: null,
      started_at: nowIso,
      ended_at: null,
      summary: null,
    });

    repo.createTaskAttempt({
      id: attemptSuccId,
      task_id: taskId,
      attempt_number: 2,
      status: 'PENDING',
      agent_profile_id: 'agent-prof-1',
      agent_id: null,
      started_at: nowIso,
      ended_at: null,
      summary: null,
    });

    // 5. Predecessor Assignment
    repo.createAgentAssignment({
      id: asgnPredId,
      project_id: projectId,
      task_id: taskId,
      attempt_id: attemptPredId,
      role_profile_id: 'role-1',
      agent_profile_id: 'agent-prof-1',
      selected_provider_id: 'prov-a',
      selected_account_id: 'acc-1',
      selected_resource_id: 'res-1',
      selected_worker_slot_id: null,
      routing_decision_id: 'dec-pred',
      preferred_metadata: null,
      status: 'HANDED_OFF',
      created_at: nowIso,
      ended_at: null,
    });

    // 6. Protocol Message
    const msgId = `msg-${taskId}`;
    const managerPayload = {
      protocol: 'manager.v1',
      message_id: msgId,
      project_id: projectId,
      task_id: taskId,
      decision: 'EXECUTE',
      instructions: ['Continue with successor execution'],
      expected_revision: 1,
      constraints: ['Verify worktree'],
    };
    const managerJson = JSON.stringify(managerPayload);
    const managerHash = computeSha256(managerJson);
    repo.recordProtocolMessage(
      msgId,
      msgId,
      'manager.v1',
      projectId,
      taskId,
      'CODING',
      1,
      managerHash,
      managerJson,
      'APPLIED'
    );

    // 7. Context snapshot & manifest & route spec
    const rawContextFiles = ['src_file.ts'];
    const rawCustomItems = [
      {
        itemType: 'PROJECT_MEMORY' as const,
        sourceType: 'MEMORY_STORE',
        sourceRef: 'project-notes',
        content: { note: 'Note 1' },
        tokenEstimate: 20,
      },
    ];

    const contextSpecHash = computeSuccessorContextSpecHash({
      transferId,
      successorAttemptId: attemptSuccId,
      purpose: 'HANDOFF',
      handoffContextId: null,
      checkpointId: null,
      contextFiles: rawContextFiles,
      customItems: rawCustomItems,
    });

    const snapshotId = `ctx-snap-ho-${computeSha256(`r5i-successor-context:${transferId}:${contextSpecHash}`).slice(0, 32)}`;
    const manifestId = `ctx-man-ho-${computeSha256(`r5i-successor-manifest:${transferId}:${contextSpecHash}`).slice(0, 32)}`;

    contextBuilder.buildContextSnapshot({
      projectId,
      taskId,
      attemptId: attemptSuccId,
      purpose: 'HANDOFF',
      snapshotId,
      manifestId,
      contextFiles: rawContextFiles,
      customItems: rawCustomItems,
    });

    const routeSpec: Record<string, unknown> = {
      transferId,
      successorAttemptId: attemptSuccId,
      roleProfileId: 'role-1',
      sourceProviderId: 'prov-a',
    };
    const routeSpecHash = computeSha256(canonicalJsonStringify(routeSpec));
    const routingDecisionId = `dec-route-${taskId}`;

    eventService.record(
      projectId,
      'ROLE_AWARE_ROUTING_DECISION',
      'Routing decision for successor',
      {
        projectId,
        taskId,
        attemptId: attemptSuccId,
        decisionId: routingDecisionId,
        outcome: 'SELECTED',
        selectedProviderId: 'prov-a',
        selectedAccountId: 'acc-1',
        selectedResourceId: 'res-1',
        selectedAssignmentId: null,
        roleProfileId: 'role-1',
      },
      taskId
    );

    // 8. Successor Assignment & Handoff Transfer in ROUTED status
    repo.createAgentAssignment({
      id: asgnSuccId,
      project_id: projectId,
      task_id: taskId,
      attempt_id: attemptSuccId,
      role_profile_id: 'role-1',
      agent_profile_id: 'agent-prof-1',
      selected_provider_id: 'prov-a',
      selected_account_id: 'acc-1',
      selected_resource_id: 'res-1',
      selected_worker_slot_id: null,
      routing_decision_id: routingDecisionId,
      preferred_metadata: {
        handoff_route_spec_version: 1,
        handoff_route_spec_hash: routeSpecHash,
        handoff_route_spec: routeSpec,
      },
      status: 'ASSIGNED',
      created_at: nowIso,
      ended_at: null,
    });

    repo.createHandoffTransfer({
      id: transferId,
      request_id: `req-${transferId}`,
      task_id: taskId,
      source_attempt_id: attemptPredId,
      successor_attempt_id: attemptSuccId,
      source_assignment_id: asgnPredId,
      successor_assignment_id: asgnSuccId,
      successor_role_profile_id: 'role-1',
      successor_agent_profile_id: 'agent-prof-1',
      successor_context_snapshot_id: snapshotId,
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
    });

    // 9. Resume successor to derive AUTHORIZED transfer and ExecutionAuthorization
    const resumeRes = await handoffService.resumeHandoffSuccessor({ transferId });
    if (!resumeRes.success) {
      throw new Error(`Failed to resume handoff successor: ${resumeRes.error}`);
    }

    const auth = resumeRes.authorization!;
    let transfer = repo.getHandoffTransfer(transferId)!;

    let leaseRes: any = null;
    if (options?.acquireLease) {
      leaseRes = leaseService.acquireForAssignment(asgnSuccId, 3600000);
      if (leaseRes.status !== 'ACQUIRED') {
        throw new Error(`Failed to acquire slot lease for ${asgnSuccId}: ${leaseRes.error}`);
      }

      if (options?.acceptSuccessor) {
        repo.acceptHandoffSuccessorExecution({
          authorizationId: auth.id,
          leaseId: leaseRes.lease.id,
          leaseToken: leaseRes.lease.lease_token,
          expectedSuccessorEpoch: 2,
        });
        transfer = repo.getHandoffTransfer(transferId)!;
      }
    }

    return { auth, transfer, leaseRes };
  }

  // 1. Migration 20 fresh install
  it('1. should cleanly apply Migration 20 on a fresh database', () => {
    const testDb = new Database(':memory:');
    MigrationRunner.run(testDb);
    const count = (testDb.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as any).c;
    expect(count).toBe(20);

    const tables = (testDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((t) => t.name);
    expect(tables).toContain('execution_recovery_states');

    const authColumns = (testDb.prepare("PRAGMA table_info(execution_authorizations)").all() as any[]).map((c) => c.name);
    expect(authColumns).toContain('lifecycle_version');
    expect(authColumns).toContain('selected_account_id');
    expect(authColumns).toContain('adapter_started_at');
    expect(authColumns).toContain('adapter_finished_at');
    expect(authColumns).toContain('settled_at');
    expect(authColumns).toContain('settlement_evidence_hash');
    testDb.close();
  });

  // 2. Migration 19 -> 20 populated upgrade
  it('2. should upgrade a populated Migration-19 database to Migration 20 preserving historical integrity', () => {
    const upgradeDb = new Database(':memory:');
    upgradeDb.pragma('foreign_keys = ON');
    upgradeDb.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    // Run migrations 1 through 19
    for (const m of MIGRATIONS.filter((m) => m.version <= 19)) {
      m.up(upgradeDb);
      upgradeDb.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
    }

    const preCount = (upgradeDb.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as any).c;
    expect(preCount).toBe(19);

    // Apply remaining migrations (Migration 20)
    MigrationRunner.run(upgradeDb);

    const postCount = (upgradeDb.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as any).c;
    expect(postCount).toBe(20);
    upgradeDb.close();
  });

  // 3. Historical rows keep null lifecycle version
  it('3. should retain NULL lifecycle_version on historical authorizations after upgrade', () => {
    const testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    for (const m of MIGRATIONS.filter((m) => m.version <= 19)) {
      m.up(testDb);
      testDb.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
    }

    // Insert historical authorization in v19 schema
    testDb.prepare(`
      INSERT INTO projects (id, name, repository_path, default_branch, status, created_at, updated_at)
      VALUES ('p-hist', 'Proj', 'd:/test', 'main', 'READY', datetime('now'), datetime('now'))
    `).run();
    testDb.prepare(`
      INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, base_sha, created_at, updated_at)
      VALUES ('t-hist', 'p-hist', 'Task', 'PLANNED', 'LOW', 'LOW', 1, 3, 0, 'sha1', datetime('now'), datetime('now'))
    `).run();
    testDb.prepare(`INSERT INTO providers (id, name, adapter_type, enabled, created_at) VALUES ('p-h', 'P', 'LOCAL_CLI', 1, datetime('now'))`).run();
    testDb.prepare(`
      INSERT INTO provider_resources (id, provider_id, model_name, health_status, capabilities_json, enabled, total_quota, remaining_quota, quota_unit, quota_source, quota_confidence, last_health_check)
      VALUES ('r-h', 'p-h', 'model', 'AVAILABLE', '[]', 1, 100, 100, 'REQUESTS', 'MANUAL', 1.0, datetime('now'))
    `).run();
    testDb.prepare(`
      INSERT INTO protocol_messages (id, message_id, protocol, project_id, task_id, expected_task_state, expected_revision, payload_hash, raw_payload, status, created_at, processed_at)
      VALUES ('msg1', 'msg1', 'manager.v1', 'p-hist', 't-hist', 'PLANNED', 1, 'h1', '{}', 'APPLIED', datetime('now'), datetime('now'))
    `).run();
    testDb.prepare(`
      INSERT INTO execution_authorizations (
        id, project_id, task_id, task_revision, base_sha, repository_head_sha, manager_message_id, manager_payload_hash,
        routing_decision_id, selected_resource_id, selected_provider_id, instruction_payload_hash, context_manifest_hash,
        canonical_instructions_json, context_files_json, status, created_at
      ) VALUES ('auth-hist', 'p-hist', 't-hist', 1, 'sha1', 'sha1', 'msg1', 'h1', 'dec1', 'r-h', 'p-h', 'iph', 'cmh', '[]', '[]', 'AUTHORIZED', datetime('now'))
    `).run();

    // Now run migration 20
    MigrationRunner.run(testDb);

    const row = testDb.prepare('SELECT lifecycle_version FROM execution_authorizations WHERE id = ?').get('auth-hist') as any;
    expect(row.lifecycle_version).toBeNull();
    testDb.close();
  });

  // 4. RC verifier requires exactly 20 migrations
  it('4. should require exactly 20 migrations in static contract count', () => {
    expect(MIGRATIONS.length).toBe(20);
    const verifierScript = fs.readFileSync(path.join(process.cwd(), 'scripts/verify-demo-rc-win.ps1'), 'utf-8');
    expect(verifierScript).toContain('Expected exactly 20 migrations');
    expect(verifierScript).not.toContain('Expected exactly 19 migrations');
  });

  // 5. First acceptance arms lifecycle version atomically
  it('5. should arm lifecycle_version = 1 atomically on first successor acceptance', async () => {
    const { auth, leaseRes } = await seedStandardTopology({ acquireLease: true });
    const acceptRes = repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(acceptRes.success).toBe(true);

    const updatedAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(updatedAuth.lifecycle_version).toBe(1);
  });

  // 6. Adapter start claim occurs immediately before invocation
  it('6. should claim adapter start linearization point immediately before adapter.execute', async () => {
    const { auth } = await seedStandardTopology();
    const leaseRes = leaseService.acquireForAssignment('asgn-succ', 60000) as SlotLeaseSuccess;
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });

    const dispatchRes = await dispatchService.dispatch(auth.id);
    expect(dispatchRes.status).toBe('COMPLETED');
    expect(adapterA.invocationCount).toBe(1);

    const updatedAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(updatedAuth.adapter_started_at).not.toBeNull();
    expect(updatedAuth.adapter_finished_at).not.toBeNull();
  });

  // 7. Failed start claim prevents adapter invocation
  it('7. should not call adapter if adapter start claim fails', async () => {
    const { auth } = await seedStandardTopology();
    const leaseRes = leaseService.acquireForAssignment('asgn-succ', 60000) as SlotLeaseSuccess;
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });

    // Invalidate authorization prior to dispatch
    repo.invalidateExecutionAuthorization(auth.id);

    const dispatchRes = await dispatchService.dispatch(auth.id);
    expect(dispatchRes.status).toBe('FAILED');
    expect(adapterA.invocationCount).toBe(0);
  });

  // 8. Adapter is invoked exactly once
  it('8. should invoke adapter exactly once per valid dispatch', async () => {
    const { auth } = await seedStandardTopology();
    const leaseRes = leaseService.acquireForAssignment('asgn-succ', 60000) as SlotLeaseSuccess;
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });

    await dispatchService.dispatch(auth.id);
    expect(adapterA.invocationCount).toBe(1);

    // Second dispatch attempt fails closed and does not re-invoke adapter
    const secondRes = await dispatchService.dispatch(auth.id);
    expect(secondRes.status).toBe('FAILED');
    expect(adapterA.invocationCount).toBe(1);
  });

  // 9. Adapter return settles lifecycle/result/terminal states atomically
  it('9. should settle lifecycle, canonical result, and terminal states atomically on adapter return', async () => {
    const { auth } = await seedStandardTopology();
    const leaseRes = leaseService.acquireForAssignment('asgn-succ', 60000) as SlotLeaseSuccess;
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });

    const res = await dispatchService.dispatch(auth.id);
    expect(res.status).toBe('COMPLETED');

    const updatedAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(updatedAuth.settled_at).not.toBeNull();
    expect(updatedAuth.settlement_evidence_hash).not.toBeNull();
    expect(updatedAuth.adapter_outcome).toBe('RETURNED');

    const transfer = repo.getHandoffTransfer('xfer-1')!;
    expect(transfer.status).toBe('COMPLETED');

    const attempt = repo.getTaskAttempt('att-succ')!;
    expect(attempt.status).toBe('COMPLETED');

    const assignment = repo.getAgentAssignment('asgn-succ')!;
    expect(assignment.status).toBe('COMPLETED');
  });

  // 10. Adapter throw settles trusted failure atomically
  it('10. should settle trusted failure atomically when adapter throws', async () => {
    const { auth } = await seedStandardTopology();
    const crashAdapter = new MockRecoveryTestAdapter('prov-a', 'Provider Alpha', 'LOCAL_CLI', true);
    registry = new ProviderRegistry();
    registry.register(crashAdapter);
    dispatchService = new ProviderDispatchService(registry, repo, eventService, worktreeService);

    const leaseRes = leaseService.acquireForAssignment('asgn-succ', 60000) as SlotLeaseSuccess;
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });

    const res = await dispatchService.dispatch(auth.id);
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('ADAPTER_EXECUTION_THREW');

    const updatedAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(updatedAuth.settled_at).not.toBeNull();
    expect(updatedAuth.adapter_outcome).toBe('THREW');
    expect(updatedAuth.adapter_error_json).toContain('MOCK_ADAPTER_SIMULATED_CRASH');

    const transfer = repo.getHandoffTransfer('xfer-1')!;
    expect(transfer.status).toBe('FAILED');
  });

  // 11. Spoofed adapter provenance is discarded
  it('11. should discard spoofed providerExecutionProvenance from raw adapter output', async () => {
    const { auth } = await seedStandardTopology();
    const spoofAdapter = new MockRecoveryTestAdapter('prov-a', 'Provider Alpha', 'LOCAL_CLI', false, {
      status: 'COMPLETED',
      providerExecutionProvenance: {
        version: 999,
        source: 'SPOOFED_UNTRUSTED_ADAPTER',
        authorizationId: 'fake-auth',
      },
    });
    registry = new ProviderRegistry();
    registry.register(spoofAdapter);
    dispatchService = new ProviderDispatchService(registry, repo, eventService, worktreeService);

    const leaseRes = leaseService.acquireForAssignment('asgn-succ', 60000) as SlotLeaseSuccess;
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });

    const res = await dispatchService.dispatch(auth.id);
    expect(res.status).toBe('COMPLETED');
    expect(res.providerExecutionProvenance?.source).toBe('PROVIDER_DISPATCH_SERVICE');
    expect(res.providerExecutionProvenance?.authorizationId).toBe(auth.id);
  });

  // 12. Atomic settlement: idempotent replay
  it('12. should handle identical settlement replay idempotently', async () => {
    const { auth } = await seedStandardTopology();
    const leaseRes = leaseService.acquireForAssignment('asgn-succ', 60000) as SlotLeaseSuccess;
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });
    const settle1 = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-1',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: { status: 'COMPLETED' },
    });
    expect(settle1.success).toBe(true);
    expect(settle1.alreadySettled).toBe(false);

    const settle2 = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-1',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      finishedAt: settle1.settledAt,
      resultPayload: { status: 'COMPLETED' },
    });
    expect(settle2.success).toBe(true);
    expect(settle2.alreadySettled).toBe(true);
  });

  // 13. Conflicting settlement is rejected
  it('13. should reject contradictory settlement attempt fail-closed', async () => {
    const { auth } = await seedStandardTopology();
    const leaseRes = leaseService.acquireForAssignment('asgn-succ', 60000) as SlotLeaseSuccess;
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });
    const settle1 = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-1',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: { status: 'COMPLETED' },
    });
    expect(settle1.success).toBe(true);

    const settle2 = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-1',
      outcome: 'THREW',
      status: 'FAILED',
      resultPayload: { status: 'FAILED' },
    });
    expect(settle2.success).toBe(false);
    expect(settle2.error).toContain('SETTLEMENT_CONFLICT');
  });

  // 14. Crash after acceptance but before dispatch claim (Window 1)
  it('14. should reconcile Window 1 crash (after acceptance, before dispatch) as PRE_ADAPTER_NOT_STARTED', async () => {
    const { auth } = await seedStandardTopology();
    const leaseRes = leaseService.acquireForAssignment('asgn-succ', 60000) as SlotLeaseSuccess;
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    db.prepare(`UPDATE account_leases SET expires_at = datetime('now', '-10 minutes') WHERE id = ?`).run(leaseRes.lease.id);

    // Simulate crash right after acceptance
    const report = scanner.scanAndReconcile();
    expect(report.scannedCount).toBe(1);
    expect(report.preAdapterNotStartedCount).toBe(1);
    expect(report.items[0].classification).toBe('PRE_ADAPTER_NOT_STARTED');
    expect(report.items[0].disposition).toBe('TERMINALIZED_SAFE_EXPIRED');
    expect(report.items[0].mutatedTerminalState).toBe(true);
    expect(report.items[0].mutatedResources).toBe(true);

    const updatedAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(updatedAuth.status).toBe('INVALIDATED');

    const transfer = repo.getHandoffTransfer('xfer-1')!;
    expect(transfer.status).toBe('FAILED');

    const activeLease = repo.getActiveLeaseForAssignment('asgn-succ');
    expect(activeLease).toBeNull();
  });

  // 15. Crash after dispatch claim but before adapter start (Window 2)
  it('15. should reconcile Window 2 crash (after dispatch claim, before adapter start) as PRE_ADAPTER_NOT_STARTED', async () => {
    const { auth } = await seedStandardTopology();
    const leaseRes = leaseService.acquireForAssignment('asgn-succ', 60000) as SlotLeaseSuccess;
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });

    // Claim dispatch but crash before adapter_started_at with expired lease
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    db.prepare(`UPDATE account_leases SET expires_at = datetime('now', '-10 minutes') WHERE id = ?`).run(leaseRes.lease.id);

    const report = scanner.scanAndReconcile();
    expect(report.preAdapterNotStartedCount).toBe(1);
    expect(report.items[0].disposition).toBe('TERMINALIZED_SAFE_EXPIRED');
  });

  // 16. Post-claim routing rejection before adapter start
  it('16. should handle post-claim routing rejection before adapter start without starting adapter', async () => {
    const { auth } = await seedStandardTopology();
    const leaseRes = leaseService.acquireForAssignment('asgn-succ', 60000) as SlotLeaseSuccess;
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });

    // Make account UNHEALTHY to trigger post-claim routing safety rejection
    db.prepare(`UPDATE provider_accounts SET health_status = 'OFFLINE' WHERE id = 'acc-1'`).run();

    const dispatchRes = await dispatchService.dispatchScheduled(auth.id);
    expect(dispatchRes.status).toBe('FAILED');
    expect(adapterA.invocationCount).toBe(0);

    const updatedAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(updatedAuth.adapter_started_at).toBeNull();
  });

  // 17. Crash during adapter call (Window 3)
  it('17. should classify Window 3 crash (during adapter call) as ADAPTER_IN_FLIGHT_UNRESOLVED and keep resources fenced', async () => {
    const { auth } = await seedStandardTopology();
    const leaseRes = leaseService.acquireForAssignment('asgn-succ', 60000) as SlotLeaseSuccess;
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });

    // Crash during adapter execution
    const report = scanner.scanAndReconcile();
    expect(report.adapterInFlightUnresolvedCount).toBe(1);
    expect(report.items[0].disposition).toBe('UNRESOLVED_FENCED');
    expect(report.items[0].mutatedTerminalState).toBe(false);
    expect(report.items[0].mutatedResources).toBe(false);

    // Confirm lease remains fenced
    const activeLease = repo.getActiveLeaseForAssignment('asgn-succ');
    expect(activeLease).not.toBeNull();
  });

  // 18. Expired lease with unresolved termination retains all fencing
  it('18. should retain fencing even if lease expires when termination is unconfirmed', async () => {
    const { auth } = await seedStandardTopology();
    const leaseRes = leaseService.acquireForAssignment('asgn-succ', 1000) as SlotLeaseSuccess;
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });

    // Expire lease
    db.prepare(`UPDATE account_leases SET expires_at = datetime('now', '-1 minute') WHERE id = ?`).run(leaseRes.lease.id);

    const report = scanner.scanAndReconcile();
    expect(report.adapterInFlightUnresolvedCount).toBe(1);
    expect(report.items[0].disposition).toBe('UNRESOLVED_FENCED');

    const slot = repo.getWorkerSlot('slot-1')!;
    expect(slot.status).toBe('LEASED');
  });

  // 19. Cancellation request without confirmed termination remains unresolved
  it('19. should keep execution unresolved if cancellation was requested but termination is not confirmed', async () => {
    const { auth } = await seedStandardTopology();
    const leaseRes = leaseService.acquireForAssignment('asgn-succ', 60000) as SlotLeaseSuccess;
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });
    repo.markCancellationRequested({
      authorizationId: auth.id,
      executionId: 'exec-1',
    });

    const report = scanner.scanAndReconcile();
    expect(report.adapterInFlightUnresolvedCount).toBe(1);
    expect(report.items[0].disposition).toBe('UNRESOLVED_FENCED');
  });

  // 20. Confirmed timeout termination terminalizes safely (Window 4)
  it('20. should terminalize safely when timeout termination is confirmed', async () => {
    const { auth } = await seedStandardTopology();
    const leaseRes = leaseService.acquireForAssignment('asgn-succ', 60000) as SlotLeaseSuccess;
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });
    const termEvidenceJson = canonicalJsonStringify({ timeoutMs: 30000 });
    repo.confirmExecutionTermination({
      authorizationId: auth.id,
      executionId: 'exec-1',
      terminationStatus: 'CONFIRMED_TERMINATED',
      terminationSource: 'PROVIDER_ADAPTER_TIMEOUT',
      terminationReason: 'EXECUTION_TIMEOUT',
      terminationProofSource: 'PROVIDER_FINAL_ACK',
      terminationEvidenceJson: termEvidenceJson,
    });

    const report = scanner.scanAndReconcile();
    expect(report.adapterTerminatedTimeoutCount).toBe(1);
    expect(report.items[0].disposition).toBe('TERMINALIZED_CONFIRMED_TIMEOUT');
    expect(report.items[0].mutatedTerminalState).toBe(true);
    expect(report.items[0].mutatedResources).toBe(true);

    const transfer = repo.getHandoffTransfer('xfer-1')!;
    expect(transfer.status).toBe('FAILED');
    expect(repo.getActiveLeaseForAssignment('asgn-succ')).toBeNull();
  });

  // 21. Confirmed cancellation terminalizes safely
  it('21. should terminalize as CANCELLED when cancellation termination is confirmed', async () => {
    const { auth } = await seedStandardTopology();
    const leaseRes = leaseService.acquireForAssignment('asgn-succ', 60000) as SlotLeaseSuccess;
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });
    const termEvidenceJson = canonicalJsonStringify({ cancelledBy: 'OPERATOR' });
    repo.confirmExecutionTermination({
      authorizationId: auth.id,
      executionId: 'exec-1',
      terminationStatus: 'CONFIRMED_TERMINATED',
      terminationSource: 'OPERATOR_CANCELLED',
      terminationReason: 'EXECUTION_CANCELLED',
      terminationProofSource: 'LOCAL_PROCESS_EXIT',
      terminationEvidenceJson: termEvidenceJson,
    });

    const report = scanner.scanAndReconcile();
    expect(report.adapterTerminatedTimeoutCount).toBe(1);
    expect(report.items[0].disposition).toBe('TERMINALIZED_CONFIRMED_CANCELLED');

    const transfer = repo.getHandoffTransfer('xfer-1')!;
    expect(transfer.status).toBe('CANCELLED');
  });

  // 22. Mismatched termination execution ID fails closed
  it('22. should reject termination confirmation if execution ID does not match', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });
    const confirmRes = repo.confirmExecutionTermination({
      authorizationId: auth.id,
      executionId: 'exec-wrong',
      terminationStatus: 'CONFIRMED_TERMINATED',
      terminationSource: 'PROVIDER_TIMEOUT',
      terminationReason: 'EXECUTION_TIMEOUT',
      terminationProofSource: 'PROVIDER_FINAL_ACK',
      terminationEvidenceJson: '{"test":true}',
    });
    expect(confirmRes.success).toBe(false);
    expect(confirmRes.error).toContain('EXECUTION_ID_MISMATCH');
  });

  // 23. Contradictory termination source fails closed
  it('23. should reject contradictory termination source when already confirmed', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });
    const termEvidenceJsonA = canonicalJsonStringify({ source: 'A' });
    const termEvidenceJsonB = canonicalJsonStringify({ source: 'B' });
    repo.confirmExecutionTermination({
      authorizationId: auth.id,
      executionId: 'exec-1',
      terminationStatus: 'CONFIRMED_TERMINATED',
      terminationSource: 'TIMEOUT_A',
      terminationReason: 'EXECUTION_TIMEOUT',
      terminationProofSource: 'LOCAL_PROCESS_EXIT',
      terminationEvidenceJson: termEvidenceJsonA,
    });
    const res2 = repo.confirmExecutionTermination({
      authorizationId: auth.id,
      executionId: 'exec-1',
      terminationStatus: 'CONFIRMED_TERMINATED',
      terminationSource: 'TIMEOUT_B',
      terminationReason: 'EXECUTION_TIMEOUT',
      terminationProofSource: 'LOCAL_PROCESS_EXIT',
      terminationEvidenceJson: termEvidenceJsonB,
    });
    expect(res2.success).toBe(false);
    expect(res2.error).toContain('TERMINATION_SOURCE_CONFLICT');
  });

  // 24. Finished marker without result evidence fails closed
  it('24. should classify as ADAPTER_FINISHED_RESULT_MISSING when adapter finished but result evidence is missing', async () => {
    const { auth } = await seedStandardTopology();
    const leaseRes = leaseService.acquireForAssignment('asgn-succ', 60000) as SlotLeaseSuccess;
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });
    // Mark finished without settlement
    db.prepare(`UPDATE execution_authorizations SET adapter_finished_at = datetime('now'), adapter_outcome = 'RETURNED' WHERE id = ?`).run(auth.id);

    const report = scanner.scanAndReconcile();
    expect(report.adapterFinishedResultMissingCount).toBe(1);
    expect(report.items[0].disposition).toBe('RESULT_MISSING_FENCED');
    expect(report.items[0].mutatedTerminalState).toBe(false);
  });

  // 25. Result evidence with incomplete terminal state reconciles (Window 5)
  it('25. should reconcile Window 5 crash (durable result persisted, incomplete terminal state) as RESULT_PERSISTED_STATE_INCOMPLETE', async () => {
    const { auth } = await seedStandardTopology();
    const leaseRes = leaseService.acquireForAssignment('asgn-succ', 60000) as SlotLeaseSuccess;
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });

    const nowIso = new Date().toISOString();
    const evidencePayload = {
      authorization_id: auth.id,
      execution_id: 'exec-1',
      transfer_id: 'xfer-1',
      project_id: auth.project_id,
      task_id: auth.task_id,
      attempt_id: auth.attempt_id,
      assignment_id: auth.assignment_id,
      provider_id: auth.selected_provider_id,
      resource_id: auth.selected_resource_id,
      account_id: 'acc-1',
      routing_decision_id: auth.routing_decision_id,
      ownership_epoch: 2,
      lifecycle_version: 1,
      settlement_status: 'COMPLETED',
      outcome: 'RETURNED',
      started_at: nowIso,
      finished_at: nowIso,
      result_payload: { status: 'COMPLETED' },
      error_json: null,
    };
    const evidenceJson = canonicalJsonStringify(evidencePayload);
    const evidenceHash = computeSha256(evidenceJson);

    // Durably settle authorization but simulate crash before transfer/attempt/assignment or lease cleanup
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
    `).run(nowIso, nowIso, nowIso, evidenceJson, evidenceHash, auth.id);

    const report = scanner.scanAndReconcile();
    expect(report.resultPersistedStateIncompleteCount).toBe(1);
    expect(report.items[0].disposition).toBe('TERMINAL_STATE_RECONCILED');
    expect(report.items[0].mutatedTerminalState).toBe(true);
    expect(report.items[0].mutatedResources).toBe(true);

    const transfer = repo.getHandoffTransfer('xfer-1')!;
    expect(transfer.status).toBe('COMPLETED');
    expect(repo.getActiveLeaseForAssignment('asgn-succ')).toBeNull();
  });

  // 26. Crash after settlement but before lease release
  it('26. should cleanly release orphan lease when result is settled', async () => {
    const { auth } = await seedStandardTopology();
    const leaseRes = leaseService.acquireForAssignment('asgn-succ', 60000) as SlotLeaseSuccess;
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });

    const nowIso = new Date().toISOString();
    const evidencePayload = {
      authorization_id: auth.id,
      execution_id: 'exec-1',
      transfer_id: 'xfer-1',
      project_id: auth.project_id,
      task_id: auth.task_id,
      attempt_id: auth.attempt_id,
      assignment_id: auth.assignment_id,
      provider_id: auth.selected_provider_id,
      resource_id: auth.selected_resource_id,
      account_id: 'acc-1',
      routing_decision_id: auth.routing_decision_id,
      ownership_epoch: 2,
      lifecycle_version: 1,
      settlement_status: 'COMPLETED',
      outcome: 'RETURNED',
      started_at: nowIso,
      finished_at: nowIso,
      result_payload: { status: 'COMPLETED' },
      error_json: null,
    };
    const evidenceJson = canonicalJsonStringify(evidencePayload);
    const evidenceHash = computeSha256(evidenceJson);

    // Settle authorization durably but simulate crash before release
    db.prepare(`
      UPDATE execution_authorizations
      SET adapter_started_at = ?,
          adapter_finished_at = ?,
          settlement_status = 'COMPLETED',
          settled_at = ?,
          adapter_outcome = 'RETURNED',
          settlement_evidence_json = ?,
          settlement_evidence_hash = ?
      WHERE id = ?
    `).run(nowIso, nowIso, nowIso, evidenceJson, evidenceHash, auth.id);

    const report = scanner.scanAndReconcile();
    expect(report.resultPersistedStateIncompleteCount).toBe(1);
    expect(report.items[0].disposition).toBe('TERMINAL_STATE_RECONCILED');
    expect(report.items[0].mutatedResources).toBe(true);

    expect(repo.getActiveLeaseForAssignment('asgn-succ')).toBeNull();
    const slot = repo.getWorkerSlot('slot-1')!;
    expect(slot.status).toBe('IDLE');
  });

  // 27. Exact lease/slot cleanup is idempotent
  it('27. should idempotently handle repeated lease cleanup', async () => {
    await seedStandardTopology();
    const leaseRes = leaseService.acquireForAssignment('asgn-succ', 60000) as SlotLeaseSuccess;
    repo.releaseAccountLeaseAndIdleSlot(leaseRes.lease.id, 'slot-1');
    expect(repo.getActiveLeaseForAssignment('asgn-succ')).toBeNull();

    // Re-running cleanup does not throw or corrupt slot
    expect(() => repo.releaseAccountLeaseAndIdleSlot(leaseRes.lease.id, 'slot-1')).not.toThrow();
    const slot = repo.getWorkerSlot('slot-1')!;
    expect(slot.status).toBe('IDLE');
  });

  // 28. Dirty or unknown worktree is never deleted
  it('28. should never delete dirty or unknown worktrees during crash recovery', async () => {
    const { auth } = await seedStandardTopology();
    const leaseRes = leaseService.acquireForAssignment('asgn-succ', 60000) as SlotLeaseSuccess;
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });

    // Create a dummy worktree file on disk
    const dummyPath = path.join(worktreesDir, 'dirty-tree');
    fs.mkdirSync(dummyPath, { recursive: true });
    fs.writeFileSync(path.join(dummyPath, 'dirty.txt'), 'dirty content');

    scanner.scanAndReconcile();

    // Worktree folder must remain on disk
    expect(fs.existsSync(dummyPath)).toBe(true);
    expect(fs.existsSync(path.join(dummyPath, 'dirty.txt'))).toBe(true);
  });

  // 29. Historical unversioned dispatched execution remains unresolved
  it('29. should keep historical unversioned dispatched execution unresolved fail-closed', async () => {
    const { auth } = await seedStandardTopology();
    db.prepare(`UPDATE execution_authorizations SET lifecycle_version = NULL, status = 'DISPATCHED' WHERE id = ?`).run(auth.id);

    const report = scanner.scanAndReconcile();
    expect(report.legacyUnclassifiableCount).toBe(1);
    expect(report.items[0].disposition).toBe('LEGACY_UNRESOLVED_FENCED');
  });

  // 30. Binding or ownership-epoch corruption is rejected
  it('30. should reject candidate with corrupted bindings as AUTHORITY_CONFLICT', async () => {
    await seedStandardTopology();
    // Insert another valid task to satisfy FK but create binding mismatch with auth
    db.prepare(`
      INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, base_sha, created_at, updated_at)
      VALUES ('tsk-mismatch', 'proj-1', 'Mismatch Task', 'PLANNED', 'LOW', 'LOW', 1, 3, 0, ?, ?, ?)
    `).run(baseCommitSha, new Date().toISOString(), new Date().toISOString());

    db.prepare(`UPDATE handoff_transfers SET task_id = 'tsk-mismatch' WHERE id = 'xfer-1'`).run();

    const report = scanner.scanAndReconcile();
    expect(report.authorityConflictCount).toBe(1);
    expect(report.items[0].classification).toBe('AUTHORITY_CONFLICT');
    expect(report.items[0].disposition).toBe('REJECTED_INTEGRITY_CONFLICT');
  });

  // 31. Settle execution result detects hash mismatch
  it('31. should reject settlement conflict if evidence hash does not match', async () => {
    const { auth } = await seedStandardTopology();
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });

    const dummyHash = computeSha256('dummy-settlement-payload');
    db.prepare(`
      UPDATE execution_authorizations
      SET settlement_status = 'COMPLETED',
          settled_at = datetime('now'),
          adapter_started_at = datetime('now'),
          adapter_outcome = 'RETURNED',
          status = 'DISPATCHED',
          execution_id = 'exec-1',
          settlement_evidence_json = '{"dummy":true}',
          settlement_evidence_hash = ?
      WHERE id = ?
    `).run(dummyHash, auth.id);

    const res = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-1',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: { different: 'payload' },
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('SETTLEMENT_CONFLICT');
  });

  // 32. No reroute, second successor, second assignment, or second authorization
  it('32. should never create second successor, assignment, or authorization during recovery', async () => {
    await seedStandardTopology();
    const preAuthCount = (db.prepare('SELECT COUNT(*) as c FROM execution_authorizations').get() as any).c;
    const preXferCount = (db.prepare('SELECT COUNT(*) as c FROM handoff_transfers').get() as any).c;
    const preAsgnCount = (db.prepare('SELECT COUNT(*) as c FROM agent_assignments').get() as any).c;

    scanner.scanAndReconcile();

    const postAuthCount = (db.prepare('SELECT COUNT(*) as c FROM execution_authorizations').get() as any).c;
    const postXferCount = (db.prepare('SELECT COUNT(*) as c FROM handoff_transfers').get() as any).c;
    const postAsgnCount = (db.prepare('SELECT COUNT(*) as c FROM agent_assignments').get() as any).c;

    expect(postAuthCount).toBe(preAuthCount);
    expect(postXferCount).toBe(preXferCount);
    expect(postAsgnCount).toBe(preAsgnCount);
  });

  // 33. Multiple candidates are processed deterministically
  it('33. should process multiple candidates in deterministic chronological order', async () => {
    const res1 = await seedStandardTopology({ transferId: 'xfer-1', taskId: 'tsk-1', attemptPredId: 'att-pred-1', attemptSuccId: 'att-succ-1', asgnPredId: 'asgn-pred-1', asgnSuccId: 'asgn-succ-1' });
    const res2 = await seedStandardTopology({ transferId: 'xfer-2', taskId: 'tsk-2', attemptPredId: 'att-pred-2', attemptSuccId: 'att-succ-2', asgnPredId: 'asgn-pred-2', asgnSuccId: 'asgn-succ-2' });

    const report = scanner.scanAndReconcile();
    expect(report.scannedCount).toBe(2);
    expect(report.items[0].authorizationId).toBe(res1.auth.id);
    expect(report.items[1].authorizationId).toBe(res2.auth.id);
  });

  // 34. One corrupt candidate does not partially mutate another
  it('34. should isolate transactions so a corrupt candidate does not affect other candidates', async () => {
    const res1 = await seedStandardTopology({ transferId: 'xfer-1', taskId: 'tsk-1', attemptPredId: 'att-pred-1', attemptSuccId: 'att-succ-1', asgnPredId: 'asgn-pred-1', asgnSuccId: 'asgn-succ-1', acquireLease: true });
    const res2 = await seedStandardTopology({ transferId: 'xfer-2', taskId: 'tsk-2', attemptPredId: 'att-pred-2', attemptSuccId: 'att-succ-2', asgnPredId: 'asgn-pred-2', asgnSuccId: 'asgn-succ-2' });

    // Arm candidate 1 as DISPATCHED with expired lease
    const leaseRes1 = res1.leaseRes;
    db.prepare(`UPDATE account_leases SET expires_at = datetime('now', '-10 seconds') WHERE id = ?`).run(leaseRes1.lease.id);
    db.prepare(`UPDATE execution_authorizations SET lifecycle_version = 1, status = 'DISPATCHED' WHERE id = ?`).run(res1.auth.id);

    // Corrupt binding on transfer 2 to a valid mismatched task
    db.prepare(`UPDATE handoff_transfers SET task_id = 'tsk-1' WHERE id = 'xfer-2'`).run();

    const report = scanner.scanAndReconcile();
    expect(report.scannedCount).toBe(2);
    expect(report.items[0].classification).toBe('PRE_ADAPTER_NOT_STARTED');
    expect(report.items[1].classification).toBe('AUTHORITY_CONFLICT');

    // First candidate reconciled successfully despite second candidate failing
    const transfer1 = repo.getHandoffTransfer('xfer-1')!;
    expect(transfer1.status).toBe('FAILED');
  });

  // 35. Repeated restart produces no duplicate audit events
  it('35. should not append duplicate audit events on repeated recovery scans with unchanged evidence', async () => {
    const { auth, leaseRes } = await seedStandardTopology({ acquireLease: true });
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    db.prepare(`UPDATE account_leases SET expires_at = datetime('now', '-10 seconds') WHERE id = ?`).run(leaseRes.lease.id);

    // First scan reconciles and emits event
    scanner.scanAndReconcile();
    const recoveryEvents1 = db.prepare("SELECT * FROM events WHERE type LIKE 'EXECUTION_RECOVERY_%'").all() as any[];
    expect(recoveryEvents1.length).toBe(1);

    // Second scan with unchanged state
    scanner.scanAndReconcile();
    const recoveryEvents2 = db.prepare("SELECT * FROM events WHERE type LIKE 'EXECUTION_RECOVERY_%'").all() as any[];
    expect(recoveryEvents2.length).toBe(1);
  });

  // 36. Startup recovery report counts are exact
  it('36. should return exact counts in CrashRecoveryService startup recovery report', async () => {
    await seedStandardTopology();
    const report = crashRecoveryService.performStartupRecovery();
    expect(report.migrationsApplied).toBe(true);
    expect(report.executionRecovery).toBeDefined();
    expect(report.executionRecovery?.scannedCount).toBe(1);
  });

  // 37. Existing R5I5 resume/replay contracts remain green
  it('37. should uphold R5I5 idempotent replay contract without regression', async () => {
    const { auth, leaseRes } = await seedStandardTopology({ acquireLease: true });
    const accept1 = repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(accept1.success).toBe(true);
    expect(accept1.alreadyAccepted).toBe(false);

    const accept2 = repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    expect(accept2.success).toBe(true);
    expect(accept2.alreadyAccepted).toBe(true);
  });

  // 38. Existing scheduler, provider dispatch, restart recovery, R5I3, and R5I4 regressions remain green
  it('38. should execute scheduled dispatch through full pipeline end-to-end', async () => {
    const { auth } = await seedStandardTopology();

    const schedRes = await scheduler.execute(auth.id);

    expect(schedRes.status).toBe('COMPLETED');
    expect(schedRes.providerResult?.status).toBe('COMPLETED');
  });

  // 39. Adapter claim gating: alreadyClaimed prevents adapter invocation
  it('39. should prevent adapter invocation when authorization is already claimed', async () => {
    const { auth, leaseRes } = await seedStandardTopology({ acquireLease: true });
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());

    // First claim succeeds
    const claim1 = repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });
    expect(claim1.success).toBe(true);
    expect(claim1.alreadyClaimed).toBe(false);

    // Second claim reports alreadyClaimed: true (idempotent replay)
    const claim2 = repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });
    expect(claim2.success).toBe(true);
    expect(claim2.alreadyClaimed).toBe(true);
  });

  // 40. Adapter claim gating: epoch mismatch rejects claim
  it('40. should reject adapter claim when ownership epoch mismatches', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());

    const claimRes = repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 999, // Mismatched epoch
    });
    expect(claimRes.success).toBe(false);
    expect(claimRes.alreadyClaimed).toBe(false);
    expect(claimRes.error).toContain('OWNERSHIP_EPOCH_MISMATCH');
  });

  // 41. Atomic settlement: rejects unknown result status
  it('41. should reject settlement with unknown result status fail-closed', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });

    const settleRes = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-1',
      outcome: 'RETURNED',
      status: 'INVALID_STATUS' as any,
      resultPayload: { test: true },
    });
    expect(settleRes.success).toBe(false);
    expect(settleRes.error).toContain('UNKNOWN_RESULT_STATUS');
  });

  // 42. Atomic settlement: rolls back when expected row count mismatches
  it('42. should roll back settlement transaction if transfer is not in modifiable state', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });

    // Prematurely set transfer to COMPLETED so the settlement update changes === 0
    db.prepare(`UPDATE handoff_transfers SET status = 'COMPLETED' WHERE id = 'xfer-1'`).run();

    const res = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-1',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: { test: true },
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/TRANSFER_NOT_ACCEPTED/);

    // Verify auth was NOT settled due to rollback
    const reloadedAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(reloadedAuth.settled_at).toBeNull();
  });

  // 43. Atomic settlement: deterministic event ID
  it('43. should create deterministic canonical event ID during settlement', async () => {
    const { auth, leaseRes } = await seedStandardTopology({ acquireLease: true });
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });

    const fixedTimestamp = new Date(Date.now() + 1000).toISOString();
    const settleRes = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-1',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      finishedAt: fixedTimestamp,
      resultPayload: { step: 'done' },
    });
    expect(settleRes.success).toBe(true);

    const event = db.prepare("SELECT * FROM events WHERE type = 'HANDOFF_SUCCESSOR_EXECUTION_COMPLETED'").get() as any;
    expect(event).toBeDefined();
    expect(event.id).toMatch(/^evt-res-[a-f0-9]{32}$/);
  });

  // 44. Recovery scanner: recomputed evidence hash mismatch -> AUTHORITY_CONFLICT
  it('44. should classify as AUTHORITY_CONFLICT when stored settlement evidence hash does not match canonical recomputed hash', async () => {
    const { auth } = await seedStandardTopology();
    db.prepare(`
      UPDATE execution_authorizations
      SET settlement_status = 'COMPLETED',
          settled_at = datetime('now'),
          adapter_outcome = 'RETURNED',
          settlement_evidence_json = '{"authorization_id":"${auth.id}","execution_id":"exec-1","tampered":true}',
          settlement_evidence_hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      WHERE id = ?
    `).run(auth.id);

    const report = scanner.scanAndReconcile();
    expect(report.authorityConflictCount).toBe(1);
    expect(report.items[0].classification).toBe('AUTHORITY_CONFLICT');
    expect(report.items[0].disposition).toBe('REJECTED_INTEGRITY_CONFLICT');
  });

  // 45. Recovery scanner: malformed settlement evidence JSON -> AUTHORITY_CONFLICT
  it('45. should classify as AUTHORITY_CONFLICT when settlement evidence JSON is malformed', async () => {
    const { auth } = await seedStandardTopology();
    db.prepare(`
      UPDATE execution_authorizations
      SET settlement_status = 'COMPLETED',
          settled_at = datetime('now'),
          adapter_outcome = 'RETURNED',
          settlement_evidence_json = '{malformed json',
          settlement_evidence_hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      WHERE id = ?
    `).run(auth.id);

    const report = scanner.scanAndReconcile();
    expect(report.authorityConflictCount).toBe(1);
    expect(report.items[0].classification).toBe('AUTHORITY_CONFLICT');
    expect(report.items[0].disposition).toBe('REJECTED_INTEGRITY_CONFLICT');
  });

  // 46. Guarded lease release: slot reassigned to another assignment is not idled
  it('46. should abort guarded slot release without idling slot if slot has been reassigned', async () => {
    const { leaseRes } = await seedStandardTopology({ acquireLease: true });

    // Simulate slot reassigned to another assignment
    db.prepare(`UPDATE worker_slots SET current_assignment_id = 'asgn-other' WHERE id = ?`).run(leaseRes.lease.worker_slot_id);

    const releaseRes = repo.releaseGuardedAccountLeaseAndIdleSlot({
      leaseId: leaseRes.lease.id,
      expectedAssignmentId: 'asgn-succ',
      expectedAccountId: 'acc-1',
      expectedSlotId: leaseRes.lease.worker_slot_id,
      expectedExecutionId: null,
    });
    expect(releaseRes.success).toBe(false);
    expect(releaseRes.error).toMatch(/SLOT_ASSIGNMENT_MISMATCH/);

    // Slot remains assigned to asgn-other and lease was not released
    const slot = repo.getWorkerSlot(leaseRes.lease.worker_slot_id)!;
    expect(slot.current_assignment_id).toBe('asgn-other');
    const lease = repo.getActiveLeaseForAssignment('asgn-succ');
    expect(lease).not.toBeNull();
  });

  // 47. Recovery scanner: repeated scan with identical evidence increments no versions and produces no mutations
  it('47. should not increment recovery_version or mutate rows on repeated scan with identical evidence', async () => {
    const { auth, leaseRes } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    db.prepare("UPDATE account_leases SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(leaseRes.lease.id);

    // First scan creates recovery state version 1
    const report1 = scanner.scanAndReconcile();
    expect(report1.reconciledCount).toBe(1);
    expect(report1.items[0].disposition).toBe('TERMINALIZED_SAFE_EXPIRED');

    // Second scan finds already reconciled record
    const report2 = scanner.scanAndReconcile();
    expect(report2.alreadyReconciledCount).toBe(1);
    expect(report2.items[0].disposition).toBe('NO_OP_ALREADY_RECONCILED');
  });

  // 48. Termination source: unconfirmed or non-standard termination kind does not infer cancellation
  it('48. should keep execution in ADAPTER_IN_FLIGHT_UNRESOLVED when termination source is unknown', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });
    // Set unknown termination source
    db.prepare(`
      UPDATE execution_authorizations
      SET termination_status = 'UNRESOLVED',
          termination_source = 'UNKNOWN_EXTERNAL_SIGNAL'
      WHERE id = ?
    `).run(auth.id);

    const report = scanner.scanAndReconcile();
    expect(report.adapterInFlightUnresolvedCount).toBe(1);
    expect(report.items[0].disposition).toBe('UNRESOLVED_FENCED');
  });

  // 49. Unresolved in-flight state: unconfirmed termination remains ADAPTER_IN_FLIGHT_UNRESOLVED
  it('49. should keep execution in ADAPTER_IN_FLIGHT_UNRESOLVED when termination is UNRESOLVED', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });
    db.prepare(`
      UPDATE execution_authorizations
      SET termination_status = 'UNRESOLVED',
          cancellation_requested_at = datetime('now')
      WHERE id = ?
    `).run(auth.id);

    const report = scanner.scanAndReconcile();
    expect(report.adapterInFlightUnresolvedCount).toBe(1);
    expect(report.items[0].disposition).toBe('UNRESOLVED_FENCED');
  });

  // 50. Dispatch settlement failure returns RECOVERY_FENCED, retaining lease, slot, and worktree
  it('50. should return RECOVERY_FENCED on settlement failure and retain lease, slot, and worktree', async () => {
    const { auth } = await seedStandardTopology();

    // Spy on settleExecutionResult to simulate database / transaction failure during settlement
    vi.spyOn(repo, 'settleExecutionResult').mockReturnValueOnce({
      success: false,
      alreadySettled: false,
      settledAt: '',
      evidenceHash: '',
      error: 'SIMULATED_SETTLEMENT_TRANSACTION_FAILURE: Simulated DB constraint failure',
    });

    const schedRes = await scheduler.execute(auth.id);
    expect(schedRes.status).toBe('RECOVERY_FENCED');
    expect(schedRes.providerResult?.errorCode).toBe('SETTLEMENT_FAILED');

    // Execution authorization remains DISPATCHED and started, recoverable by scanner
    const reloadedAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(reloadedAuth.adapter_started_at).not.toBeNull();
    expect(reloadedAuth.settled_at).toBeNull();

    // Lease remains active and unreleased for recovery fencing
    const activeLease = repo.getActiveLeaseForAssignment('asgn-succ');
    expect(activeLease).not.toBeNull();

    // Slot remains in LEASED state
    const slot = repo.getWorkerSlot(activeLease!.worker_slot_id)!;
    expect(slot.status).toBe('LEASED');
  });

  // 51. Recovery-fenced execution cannot start another successor or adapter
  it('51. should reject subsequent execution starts on a recovery-fenced authorization', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });

    // Attempting to claim adapter execution start again for same authorization fails
    const secondClaim = repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-2',
      expectedEpoch: 2,
    });
    expect(secondClaim.success).toBe(false);
    expect(secondClaim.error).toMatch(/EXECUTION_ID_CONFLICT|EXECUTION_ALREADY_STARTED/);
  });

  // 52. RETURNED + FAILED remains FAILED through incomplete-state recovery
  it('52. should recover incomplete state as FAILED when outcome is RETURNED and settlement_status is FAILED', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });

    const finishIso = '2026-08-29T12:00:00.000Z';
    const evidence = {
      authorization_id: auth.id,
      execution_id: 'exec-1',
      transfer_id: 'xfer-1',
      project_id: auth.project_id,
      task_id: auth.task_id,
      attempt_id: auth.attempt_id,
      assignment_id: auth.assignment_id,
      provider_id: auth.selected_provider_id,
      resource_id: auth.selected_resource_id,
      account_id: 'acc-1',
      routing_decision_id: auth.routing_decision_id,
      ownership_epoch: 2,
      lifecycle_version: 1,
      settlement_status: 'FAILED',
      outcome: 'RETURNED',
      started_at: '2026-08-29T11:00:00.000Z',
      finished_at: finishIso,
      result_payload: { status: 'FAILED' },
      error_json: null,
    };
    const evidenceJson = canonicalJsonStringify(evidence);
    const evidenceHash = computeSha256(evidenceJson);

    // Simulate crash after auth settlement update but before transfer update
    db.prepare(`
      UPDATE execution_authorizations
      SET adapter_started_at = '2026-08-29T11:00:00.000Z',
          settlement_status = 'FAILED',
          adapter_finished_at = ?,
          adapter_outcome = 'RETURNED',
          settled_at = ?,
          settlement_evidence_json = ?,
          settlement_evidence_hash = ?
      WHERE id = ?
    `).run(finishIso, finishIso, evidenceJson, evidenceHash, auth.id);

    const report = scanner.scanAndReconcile();
    expect(report.resultPersistedStateIncompleteCount).toBe(1);
    expect(report.items[0].disposition).toBe('TERMINAL_STATE_RECONCILED');

    const transfer = repo.getHandoffTransfer('xfer-1')!;
    expect(transfer.status).toBe('FAILED');
    const attempt = repo.getTaskAttempt('att-succ')!;
    expect(attempt.status).toBe('FAILED');
    const assignment = repo.getAgentAssignment('asgn-succ')!;
    expect(assignment.status).toBe('FAILED');
  });

  // 53. RETURNED + CANCELLED remains CANCELLED through incomplete-state recovery
  it('53. should recover incomplete state as CANCELLED when outcome is RETURNED and settlement_status is CANCELLED', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });

    const finishIso = '2026-08-29T12:00:00.000Z';
    const evidence = {
      authorization_id: auth.id,
      execution_id: 'exec-1',
      transfer_id: 'xfer-1',
      project_id: auth.project_id,
      task_id: auth.task_id,
      attempt_id: auth.attempt_id,
      assignment_id: auth.assignment_id,
      provider_id: auth.selected_provider_id,
      resource_id: auth.selected_resource_id,
      account_id: 'acc-1',
      routing_decision_id: auth.routing_decision_id,
      ownership_epoch: 2,
      lifecycle_version: 1,
      settlement_status: 'CANCELLED',
      outcome: 'RETURNED',
      started_at: '2026-08-29T11:00:00.000Z',
      finished_at: finishIso,
      result_payload: { status: 'CANCELLED' },
      error_json: null,
    };
    const evidenceJson = canonicalJsonStringify(evidence);
    const evidenceHash = computeSha256(evidenceJson);

    db.prepare(`
      UPDATE execution_authorizations
      SET adapter_started_at = '2026-08-29T11:00:00.000Z',
          settlement_status = 'CANCELLED',
          adapter_finished_at = ?,
          adapter_outcome = 'RETURNED',
          settled_at = ?,
          settlement_evidence_json = ?,
          settlement_evidence_hash = ?
      WHERE id = ?
    `).run(finishIso, finishIso, evidenceJson, evidenceHash, auth.id);

    const report = scanner.scanAndReconcile();
    expect(report.resultPersistedStateIncompleteCount).toBe(1);
    expect(report.items[0].disposition).toBe('TERMINAL_STATE_RECONCILED');

    const transfer = repo.getHandoffTransfer('xfer-1')!;
    expect(transfer.status).toBe('CANCELLED');
  });

  // 54. Conflicting terminal states are never overwritten
  it('54. should classify as AUTHORITY_CONFLICT when transfer has conflicting terminal state against settlement_status', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });

    const finishIso = '2026-08-29T12:00:00.000Z';
    const evidence = {
      authorization_id: auth.id,
      execution_id: 'exec-1',
      lifecycle_version: 1,
      task_id: auth.task_id,
      project_id: auth.project_id,
      attempt_id: auth.attempt_id,
      assignment_id: auth.assignment_id,
      settlement_status: 'COMPLETED',
      outcome: 'RETURNED',
      finished_at: finishIso,
      result_payload: { status: 'COMPLETED' },
      error_json: null,
    };
    const evidenceJson = canonicalJsonStringify(evidence);
    const evidenceHash = computeSha256(evidenceJson);

    // Set auth to settled as COMPLETED, but transfer already terminal as FAILED
    db.prepare(`
      UPDATE execution_authorizations
      SET settlement_status = 'COMPLETED',
          adapter_finished_at = ?,
          adapter_outcome = 'RETURNED',
          settled_at = ?,
          settlement_evidence_json = ?,
          settlement_evidence_hash = ?
      WHERE id = ?
    `).run(finishIso, finishIso, evidenceJson, evidenceHash, auth.id);
    db.prepare(`UPDATE handoff_transfers SET status = 'FAILED' WHERE id = 'xfer-1'`).run();

    const report = scanner.scanAndReconcile();
    expect(report.authorityConflictCount).toBe(1);
    expect(report.items[0].classification).toBe('AUTHORITY_CONFLICT');
    expect(report.items[0].disposition).toBe('REJECTED_INTEGRITY_CONFLICT');

    // Transfer status was NOT overwritten
    const transfer = repo.getHandoffTransfer('xfer-1')!;
    expect(transfer.status).toBe('FAILED');
  });

  // 55. Fresh AUTHORIZED and unexpired pre-adapter records are not terminalized
  it('55. should not terminalize fresh AUTHORIZED authorizations or unexpired active leases', async () => {
    const { auth } = await seedStandardTopology();
    // Auth is AUTHORIZED, not DISPATCHED
    expect(auth.status).toBe('AUTHORIZED');

    const report = scanner.scanAndReconcile();
    expect(report.unresolvedCount).toBe(1);
    expect(report.items[0].classification).toBe('PRE_ADAPTER_NOT_STARTED');
    expect(report.items[0].disposition).toBe('UNRESOLVED_FENCED');
    expect(report.items[0].mutatedTerminalState).toBe(false);

    // Auth remains AUTHORIZED
    const reloadedAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(reloadedAuth.status).toBe('AUTHORIZED');
  });

  // 56. Missing attempt/assignment/transfer bindings fail settlement
  it('56. should fail settlement when attempt, assignment, or transfer bindings are missing', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });

    // Delete task attempt with FK check temporarily disabled to test binding check
    db.pragma('foreign_keys = OFF');
    db.prepare(`DELETE FROM task_attempts WHERE id = 'att-succ'`).run();
    db.pragma('foreign_keys = ON');

    const settleRes = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-1',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: {},
    });
    expect(settleRes.success).toBe(false);
    expect(settleRes.error).toMatch(/ATTEMPT_NOT_FOUND/);

    // Authorization remains unsettled
    const reloadedAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(reloadedAuth.settled_at).toBeNull();
  });

  // 57. Settlement from ROUTED, AUTHORIZED, PENDING, or ASSIGNED fails
  it('57. should reject settlement when authorization is not in DISPATCHED state', async () => {
    const { auth } = await seedStandardTopology();
    // Auth is in AUTHORIZED status
    const settleRes = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-1',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: {},
    });
    expect(settleRes.success).toBe(false);
    expect(settleRes.error).toMatch(/INVALID_AUTH_STATUS/);
  });

  // 58. Wrong account, routing decision, provider, resource, or epoch fails settlement
  it('58. should reject settlement on mismatch of provider, resource, account, or epoch', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });

    // Mutate task ownership epoch
    db.prepare(`UPDATE tasks SET ownership_epoch = 99 WHERE id = ?`).run(auth.task_id);

    const settleRes = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-1',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: {},
    });
    expect(settleRes.success).toBe(false);
    expect(settleRes.error).toMatch(/OWNERSHIP_EPOCH_MISMATCH/);
  });

  // 59. Guarded release rejects wrong lease-slot binding
  it('59. should reject guarded lease release if expected slot does not match lease slot', async () => {
    const { leaseRes } = await seedStandardTopology({ acquireLease: true });

    const res = repo.releaseGuardedAccountLeaseAndIdleSlot({
      leaseId: leaseRes.lease.id,
      expectedAssignmentId: 'asgn-succ',
      expectedAccountId: 'acc-1',
      expectedSlotId: 'slot-wrong',
      expectedExecutionId: null,
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/SLOT_NOT_FOUND|LEASE_SLOT_MISMATCH/);
  });

  // 60. Guarded release rejects current_execution_id mismatch
  it('60. should reject guarded lease release if current_execution_id on slot mismatches', async () => {
    const { leaseRes } = await seedStandardTopology({ acquireLease: true });
    db.prepare(`UPDATE worker_slots SET current_execution_id = 'exec-active' WHERE id = ?`).run(leaseRes.lease.worker_slot_id);

    const res = repo.releaseGuardedAccountLeaseAndIdleSlot({
      leaseId: leaseRes.lease.id,
      expectedAssignmentId: 'asgn-succ',
      expectedAccountId: 'acc-1',
      expectedSlotId: leaseRes.lease.worker_slot_id,
      expectedExecutionId: 'exec-different',
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/SLOT_EXECUTION_MISMATCH/);
  });

  // 61. Guarded release failure rolls back terminal mutations
  it('61. should roll back terminal mutations when guarded lease release fails during recovery scan', async () => {
    const { auth, leaseRes } = await seedStandardTopology({ acquireLease: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());

    // Mutate slot status to BREAK guarded release
    db.prepare(`UPDATE worker_slots SET status = 'OFFLINE' WHERE id = ?`).run(leaseRes.lease.worker_slot_id);

    // Set auth to expired pre-adapter state
    db.prepare(`UPDATE account_leases SET expires_at = datetime('now', '-10 minutes') WHERE id = ?`).run(leaseRes.lease.id);

    const report = scanner.scanAndReconcile();
    expect(report.authorityConflictCount).toBe(1);
    expect(report.items[0].classification).toBe('AUTHORITY_CONFLICT');

    // Transfer status was NOT modified due to rollback
    const transfer = repo.getHandoffTransfer('xfer-1')!;
    expect(transfer.status).toBe('AUTHORIZED');
  });

  // 62. Unacknowledged cancellation remains unresolved even with cancellation_requested_at
  it('62. should keep execution as ADAPTER_IN_FLIGHT_UNRESOLVED when cancellation is unacknowledged', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });
    repo.markCancellationRequested({
      authorizationId: auth.id,
      executionId: 'exec-1',
    });

    // Termination status is UNRESOLVED / proof source is CANCEL_UNACKNOWLEDGED
    db.prepare(`
      UPDATE execution_authorizations
      SET termination_status = 'UNRESOLVED',
          termination_proof_source = 'CANCEL_UNACKNOWLEDGED'
      WHERE id = ?
    `).run(auth.id);

    const report = scanner.scanAndReconcile();
    expect(report.adapterInFlightUnresolvedCount).toBe(1);
    expect(report.items[0].disposition).toBe('UNRESOLVED_FENCED');
    expect(report.items[0].mutatedTerminalState).toBe(false);
  });

  // 63. Missing or corrupt structured termination proof cannot terminalize
  it('63. should reject terminalization when structured termination evidence hash is corrupted', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });

    db.prepare(`
      UPDATE execution_authorizations
      SET termination_status = 'CONFIRMED_TERMINATED',
          termination_source = 'PROVIDER_FINAL_ACK',
          termination_proof_source = 'PROVIDER_FINAL_ACK',
          termination_reason = 'EXECUTION_TIMEOUT',
          termination_confirmed_at = datetime('now'),
          terminated_at = datetime('now'),
          termination_evidence_json = '{"proof":"corrupted"}',
          termination_evidence_hash = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
      WHERE id = ?
    `).run(auth.id);

    const report = scanner.scanAndReconcile();
    expect(report.authorityConflictCount).toBe(1);
    expect(report.items[0].classification).toBe('AUTHORITY_CONFLICT');
  });

  // 64. Recovery event ID is deterministic and deduplicated
  it('64. should generate deterministic recovery event ID and deduplicate across repeated scans', async () => {
    const { auth } = await seedStandardTopology();
    db.prepare(`UPDATE execution_authorizations SET status = 'INVALIDATED' WHERE id = ?`).run(auth.id);
    db.prepare(`UPDATE handoff_transfers SET status = 'FAILED' WHERE id = 'xfer-1'`).run();
    db.prepare(`UPDATE task_attempts SET status = 'FAILED' WHERE id = 'att-succ'`).run();
    db.prepare(`UPDATE agent_assignments SET status = 'FAILED' WHERE id = 'asgn-succ'`).run();

    scanner.scanAndReconcile();
    const eventCount1 = (db.prepare('SELECT COUNT(*) as c FROM events').get() as any).c;

    scanner.scanAndReconcile();
    const eventCount2 = (db.prepare('SELECT COUNT(*) as c FROM events').get() as any).c;

    expect(eventCount1).toBe(eventCount2);
  });

  // 65. Actual ProviderDispatchService replay test uses adapter spy and proves zero duplicate calls
  it('65. should prove zero duplicate adapter calls on dispatch replay', async () => {
    const { auth, leaseRes } = await seedStandardTopology({ acquireLease: true });
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });

    const executeSpy = vi.spyOn(adapterA, 'execute');

    // First dispatch execution
    const res1 = await dispatchService.dispatch(auth.id);
    expect(res1.status).toBe('COMPLETED');
    expect(executeSpy).toHaveBeenCalledTimes(1);

    // Second dispatch execution replay fails closed without calling adapter
    const res2 = await dispatchService.dispatch(auth.id);
    expect(res2.status).toBe('FAILED');
    // Adapter execute was NOT called a second time
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  // 66. Adapter start timestamp is generated at the start-claim transaction, not dispatch entry
  it('66. should generate adapter start timestamp atomically during claimAdapterExecutionStart', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());

    const beforeClaim = new Date().toISOString();
    const claimRes = repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-atomic-start',
      expectedEpoch: 2,
    });
    expect(claimRes.success).toBe(true);

    const reloadedAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(reloadedAuth.adapter_started_at).not.toBeNull();
    expect(new Date(reloadedAuth.adapter_started_at!).getTime()).toBeGreaterThanOrEqual(new Date(beforeClaim).getTime());
  });

  // 67. Invalid lifecycle versions and non-hex hashes fail at the database boundary
  it('67. should reject invalid lifecycle versions and non-hex hashes at database CHECK constraint', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO execution_authorizations (
          id, project_id, task_id, attempt_id, task_revision, base_sha, repository_head_sha,
          manager_message_id, manager_payload_hash, routing_decision_id, selected_resource_id,
          selected_provider_id, instruction_payload_hash, context_manifest_hash,
          canonical_instructions_json, context_files_json, status, created_at, lifecycle_version
        ) VALUES (
          'auth-invalid-lc', 'proj-1', 'task-1', 'att-1', 1, 'sha', 'sha',
          'msg-1', 'hash', 'rd-1', 'res-1',
          'prov-1', 'hash', 'hash',
          '{}', '[]', 'AUTHORIZED', datetime('now'), 99
        )
      `).run();
    }).toThrow(/CHECK constraint failed/);

    expect(() => {
      db.prepare(`
        INSERT INTO execution_recovery_states (
          id, authorization_id, transfer_id, recovery_classification, disposition,
          canonical_evidence_json, evidence_hash, first_detected_at, last_scanned_at, created_at, updated_at
        ) VALUES (
          'rec-invalid-hash', 'auth-1', 'xfer-1', 'ALREADY_RECONCILED', 'NO_OP_ALREADY_RECONCILED',
          '{}', 'INVALID-NON-HEX-HASH', datetime('now'), datetime('now'), datetime('now'), datetime('now')
        )
      `).run();
    }).toThrow(/CHECK constraint failed/);
  });

  // 68. Settlement fails closed if adapter outcome is incompatible with settlement status
  it('68. should reject incompatible adapter outcome and settlement status combinations', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });

    // THREW with COMPLETED is incompatible
    const settleRes = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-1',
      outcome: 'THREW',
      status: 'COMPLETED',
      resultPayload: {},
    });
    expect(settleRes.success).toBe(false);
    expect(settleRes.error).toMatch(/INCOMPATIBLE_OUTCOME_STATUS/);
  });

  // 69. Caller-supplied old start timestamp cannot control persisted claim time
  it('69. should ignore caller-supplied start timestamp and generate adapter_started_at inside transaction', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());

    const oldTimestamp = '2020-01-01T00:00:00.000Z';
    const claimRes = (repo.claimAdapterExecutionStart as any)({
      authorizationId: auth.id,
      executionId: 'exec-ignore-caller-time',
      expectedEpoch: 2,
      startedAt: oldTimestamp,
    });

    expect(claimRes.success).toBe(true);
    expect(claimRes.startedAt).not.toBe(oldTimestamp);
    const reloadedAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(reloadedAuth.adapter_started_at).not.toBe(oldTimestamp);
    expect(new Date(reloadedAuth.adapter_started_at!).getFullYear()).toBeGreaterThan(2020);
  });

  // 70. claimAdapterExecutionStart rejects null or invalid expected epoch for lifecycle-v1 auth
  it('70. should reject null or invalid expected epoch during claimAdapterExecutionStart for lifecycle-v1 auth', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());

    const claimRes = repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-null-epoch',
      expectedEpoch: null as any,
      expectedLifecycleVersion: 1,
    });
    expect(claimRes.success).toBe(false);
    expect(claimRes.error).toMatch(/INVALID_EXPECTED_EPOCH/);
  });

  // 71. claimAdapterExecutionStart rolls back auth claim when worker slot update fails
  it('71. should roll back authorization claim if worker slot execution stamping fails', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());

    // Tamper slot to status IDLE so slot check/update will fail
    db.prepare("UPDATE worker_slots SET status = 'IDLE' WHERE id = 'slot-1'").run();

    const claimRes = repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-stamp-fail',
      expectedEpoch: 2,
      expectedLifecycleVersion: 1,
    });
    expect(claimRes.success).toBe(false);
    expect(claimRes.error).toMatch(/WORKER_SLOT_NOT_READY|WORKER_SLOT_EXECUTION_STAMP_FAILED/);

    // Auth must NOT be claimed
    const reloadedAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(reloadedAuth.execution_id).toBeNull();
    expect(reloadedAuth.adapter_started_at).toBeNull();
  });

  // 72. Guarded slot release fails when expected executionId is provided but slot current_execution_id is null
  it('72. should reject guarded slot release when expected executionId is provided but slot current_execution_id is null', async () => {
    const { leaseRes } = await seedStandardTopology({ acquireLease: true });

    const releaseRes = repo.releaseGuardedAccountLeaseAndIdleSlot({
      leaseId: leaseRes.lease.id,
      expectedAssignmentId: 'asgn-succ',
      expectedAccountId: 'acc-1',
      expectedSlotId: 'slot-1',
      expectedExecutionId: 'exec-expected-non-null',
    });
    expect(releaseRes.success).toBe(false);
    expect(releaseRes.error).toMatch(/SLOT_EXECUTION_MISMATCH/);
  });

  // 73. Guarded slot release fails when expected executionId is null but slot current_execution_id is set
  it('73. should reject guarded slot release when expected executionId is null but slot current_execution_id is set', async () => {
    const { leaseRes } = await seedStandardTopology({ acquireLease: true });

    db.prepare("UPDATE worker_slots SET current_execution_id = 'exec-already-set' WHERE id = 'slot-1'").run();

    const releaseRes = repo.releaseGuardedAccountLeaseAndIdleSlot({
      leaseId: leaseRes.lease.id,
      expectedAssignmentId: 'asgn-succ',
      expectedAccountId: 'acc-1',
      expectedSlotId: 'slot-1',
      expectedExecutionId: null,
    });
    expect(releaseRes.success).toBe(false);
    expect(releaseRes.error).toMatch(/SLOT_EXECUTION_MISMATCH/);
  });

  // 74. Guarded slot release atomically clears both current_assignment_id and current_execution_id and marks status IDLE
  it('74. should atomically clear both assignment_id and execution_id and set status IDLE on matching release', async () => {
    const { leaseRes } = await seedStandardTopology({ acquireLease: true });

    db.prepare("UPDATE worker_slots SET current_execution_id = 'exec-exact-match' WHERE id = 'slot-1'").run();

    const releaseRes = repo.releaseGuardedAccountLeaseAndIdleSlot({
      leaseId: leaseRes.lease.id,
      expectedAssignmentId: 'asgn-succ',
      expectedAccountId: 'acc-1',
      expectedSlotId: 'slot-1',
      expectedExecutionId: 'exec-exact-match',
    });
    expect(releaseRes.success).toBe(true);

    const slot = repo.getWorkerSlot('slot-1')!;
    expect(slot.status).toBe('IDLE');
    expect(slot.current_assignment_id).toBeNull();
    expect(slot.current_execution_id).toBeNull();
  });

  // 75. Settlement requires all 12 non-null canonical bindings in evidence
  it('75. should reject settlement when required canonical bindings are missing or contradictory', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-binding-test',
      expectedEpoch: 2,
    });

    // Mismatched routing decision id on assignment
    db.prepare("UPDATE agent_assignments SET routing_decision_id = 'rd-tampered' WHERE id = 'asgn-succ'").run();

    const settleRes = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-binding-test',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: {},
    });
    expect(settleRes.success).toBe(false);
    expect(settleRes.error).toMatch(/BINDING_MISMATCH/);
  });

  // 76. Settlement non-monotonic timestamp validation rejects finishedAt preceding startedAt
  it('76. should reject settlement when finishedAt precedes adapter_started_at', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-time-test',
      expectedEpoch: 2,
    });

    const settleRes = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-time-test',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      finishedAt: '2020-01-01T00:00:00.000Z',
      resultPayload: {},
    });
    expect(settleRes.success).toBe(false);
    expect(settleRes.error).toMatch(/NON_MONOTONIC_TIMESTAMPS/);
  });

  // 77. Settlement idempotent replay with omitted finishedAt recomputes identical evidence hash and performs 0 DB mutations
  it('77. should allow idempotent settlement replay with omitted finishedAt and perform zero mutations', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-replay-test',
      expectedEpoch: 2,
    });

    const settle1 = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-replay-test',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: { data: 123 },
    });
    expect(settle1.success).toBe(true);

    const initialEventsCount = (db.prepare('SELECT count(*) as count FROM events').get() as any).count;

    const settle2 = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-replay-test',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: { data: 123 },
    });
    expect(settle2.success).toBe(true);
    expect(settle2.alreadySettled).toBe(true);
    expect(settle2.evidenceHash).toBe(settle1.evidenceHash);

    const postEventsCount = (db.prepare('SELECT count(*) as count FROM events').get() as any).count;
    expect(postEventsCount).toBe(initialEventsCount);
  });

  // 78. Settlement replay with conflicting outcome fails closed
  it('78. should fail settlement replay with SETTLEMENT_CONFLICT when replay outcome mismatches', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-conflict-test',
      expectedEpoch: 2,
    });

    const settle1 = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-conflict-test',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: {},
    });
    expect(settle1.success).toBe(true);

    const settle2 = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-conflict-test',
      outcome: 'THREW',
      status: 'FAILED',
      resultPayload: {},
    });
    expect(settle2.success).toBe(false);
    expect(settle2.error).toMatch(/SETTLEMENT_CONFLICT/);
  });

  // 79. Recovery scanner pre-adapter report-only returns zero DB and event mutations for bare DISPATCHED without lease proof
  it('79. should return report-only unresolved with 0 DB mutations for bare DISPATCHED without lease proof', async () => {
    const { auth } = await seedStandardTopology();
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());

    const eventsBefore = (db.prepare('SELECT count(*) as count FROM events').get() as any).count;
    const recoveryBefore = (db.prepare('SELECT count(*) as count FROM execution_recovery_states').get() as any).count;

    const report = scanner.scanAndReconcile();
    expect(report.items.length).toBe(1);
    expect(report.items[0].classification).toBe('PRE_ADAPTER_NOT_STARTED');
    expect(report.items[0].disposition).toBe('UNRESOLVED_FENCED');

    const eventsAfter = (db.prepare('SELECT count(*) as count FROM events').get() as any).count;
    const recoveryAfter = (db.prepare('SELECT count(*) as count FROM execution_recovery_states').get() as any).count;
    expect(eventsAfter).toBe(eventsBefore);
    expect(recoveryAfter).toBe(recoveryBefore);
  });

  // 80. Recovery scanner enforces confirmed termination proof source authority and rejects unproven sources
  it('80. should classify as AUTHORITY_CONFLICT when termination evidence is tampered or non-monotonic', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });

    db.prepare(`
      UPDATE execution_authorizations
      SET termination_status = 'CONFIRMED_TERMINATED',
          termination_source = 'LOCAL_HEARTBEAT_MONITOR',
          termination_reason = 'EXECUTION_TIMEOUT',
          termination_proof_source = 'LOCAL_PROCESS_EXIT',
          termination_confirmed_at = '2026-08-30T10:00:00.000Z',
          terminated_at = '2026-08-30T11:00:00.000Z',
          termination_evidence_json = '{"proof":1}',
          termination_evidence_hash = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
      WHERE id = ?
    `).run(auth.id);

    const report = scanner.scanAndReconcile();
    expect(report.authorityConflictCount).toBe(1);
    expect(report.items[0].classification).toBe('AUTHORITY_CONFLICT');
    expect(report.items[0].disposition).toBe('REJECTED_INTEGRITY_CONFLICT');
  });

  // 81. Recovery scanner preserves resolved recovery record byte-for-byte and emits no duplicate events on second scan
  it('81. should preserve resolved recovery record byte-for-byte and emit zero events on second scan', async () => {
    const { auth, leaseRes } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());

    // Expire lease to allow safe expiration
    db.prepare("UPDATE account_leases SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(leaseRes.lease.id);

    const report1 = scanner.scanAndReconcile();
    expect(report1.reconciledCount).toBe(1);
    expect(report1.items[0].disposition).toBe('TERMINALIZED_SAFE_EXPIRED');

    const stateRow1 = repo.getExecutionRecoveryState(auth.id)!;
    const eventsCount1 = (db.prepare('SELECT count(*) as count FROM events').get() as any).count;

    const report2 = scanner.scanAndReconcile();
    expect(report2.alreadyReconciledCount).toBe(1);
    expect(report2.items[0].disposition).toBe('NO_OP_ALREADY_RECONCILED');

    const stateRow2 = repo.getExecutionRecoveryState(auth.id)!;
    const eventsCount2 = (db.prepare('SELECT count(*) as count FROM events').get() as any).count;

    expect(stateRow2.recovery_version).toBe(stateRow1.recovery_version);
    expect(stateRow2.evidence_hash).toBe(stateRow1.evidence_hash);
    expect(stateRow2.updated_at).toBe(stateRow1.updated_at);
    expect(eventsCount2).toBe(eventsCount1);
  });

  // 82. Recovery scanner rethrows conflict persistence failure visibly without swallowing
  it('82. should fail visibly when conflict persistence throws inside scanAndReconcile', async () => {
    const { auth } = await seedStandardTopology();
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());

    // Tamper routing_decision_id on assignment so scanner encounters AUTHORITY_CONFLICT and attempts to persist recovery state
    db.prepare("UPDATE agent_assignments SET routing_decision_id = 'rd-conflict' WHERE id = 'asgn-succ'").run();

    vi.spyOn(repo, 'upsertExecutionRecoveryState').mockImplementation(() => {
      throw new Error('SIMULATED_DB_FATAL_DISK_IO');
    });

    expect(() => {
      scanner.scanAndReconcile();
    }).toThrow(/SIMULATED_DB_FATAL_DISK_IO/);
  });

  // 83. Null lifecycle authorization claim fails without mutation
  it('83. Null lifecycle authorization claim fails without mutation', async () => {
    const { auth } = await seedStandardTopology();
    db.prepare("UPDATE execution_authorizations SET lifecycle_version = NULL, status = 'DISPATCHED', dispatched_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      auth.id
    );

    const claimRes = repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-null-lifecycle',
      expectedEpoch: 2,
    });

    expect(claimRes.success).toBe(false);
    expect(claimRes.error).toContain('LIFECYCLE_VERSION_MISMATCH');

    const checkAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(checkAuth.adapter_started_at).toBeNull();
    expect(checkAuth.execution_id).toBeNull();
  });

  // 84. Null authorization ownership epoch fails
  it('84. Null authorization ownership epoch fails', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());

    const claimRes = repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-null-epoch',
      expectedEpoch: 0,
    });

    expect(claimRes.success).toBe(false);
    expect(claimRes.error).toContain('INVALID_EXPECTED_EPOCH');

    const checkAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(checkAuth.adapter_started_at).toBeNull();
  });

  // 85. Stale authorization ownership epoch fails
  it('85. Stale authorization ownership epoch fails', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());

    // Bump task epoch to 3
    repo.bumpTaskOwnershipEpoch(auth.task_id, 2);

    const claimRes = repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-stale-epoch',
      expectedEpoch: 2, // Stale! Task epoch is 3
    });

    expect(claimRes.success).toBe(false);
    expect(claimRes.error).toContain('OWNERSHIP_EPOCH_MISMATCH');

    const checkAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(checkAuth.adapter_started_at).toBeNull();
  });

  // 86. Missing or mismatched assignment/slot/account causes claim rollback
  it('86. Missing or mismatched assignment/slot/account causes claim rollback', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());

    // 1. Missing assignment (or assignment on different task)
    repo.createTask({
      id: 'tsk-other-86',
      project_id: 'proj-1',
      milestone_id: null,
      title: 'T',
      description: 'T',
      state: 'CODING',
      priority: 'LOW',
      risk: 'LOW',
      revision_count: 1,
      max_revisions: 5,
      progress_cache_percent: 0,
      paused_from_state: null,
      assigned_agent_id: null,
      ownership_epoch: 1,
      base_sha: baseCommitSha,
      current_sha: null,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    repo.createTaskAttempt({
      id: 'att-other-86',
      task_id: 'tsk-other-86',
      attempt_number: 1,
      status: 'PENDING',
      agent_profile_id: 'agent-prof-1',
      agent_id: null,
      started_at: new Date().toISOString(),
      ended_at: null,
      summary: null,
    });
    repo.createAgentAssignment({
      id: 'asgn-other-86',
      project_id: 'proj-1',
      task_id: 'tsk-other-86',
      attempt_id: 'att-other-86',
      role_profile_id: 'role-1',
      agent_profile_id: 'agent-prof-1',
      selected_provider_id: 'prov-a',
      selected_account_id: 'acc-1',
      selected_resource_id: 'res-1',
      selected_worker_slot_id: null,
      routing_decision_id: 'dec-other-86',
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    });

    db.prepare("UPDATE execution_authorizations SET assignment_id = 'asgn-other-86' WHERE id = ?").run(auth.id);
    const claimRes1 = repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-mismatch-1',
      expectedEpoch: 2,
    });
    expect(claimRes1.success).toBe(false);
    expect(claimRes1.error).toContain('ASSIGNMENT_BINDING_MISMATCH');
    db.prepare("UPDATE execution_authorizations SET assignment_id = 'asgn-succ' WHERE id = ?").run(auth.id);

    // 2. Mismatched account
    db.prepare(`
      INSERT INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at)
      VALUES ('acc-other-86', 'prov-a', 'Other 86', 'NATIVE_PROFILE', 1, 10, 'AVAILABLE', 2, ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString());
    db.prepare("UPDATE agent_assignments SET selected_account_id = 'acc-other-86' WHERE id = 'asgn-succ'").run();

    const claimRes2 = repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-mismatch-2',
      expectedEpoch: 2,
    });
    expect(claimRes2.success).toBe(false);
    expect(claimRes2.error).toContain('ASSIGNMENT_BINDING_MISMATCH');
    db.prepare("UPDATE agent_assignments SET selected_account_id = 'acc-1' WHERE id = 'asgn-succ'").run();

    // 3. Idle worker slot so it is not in LEASED status
    db.prepare("UPDATE worker_slots SET status = 'IDLE', current_assignment_id = NULL WHERE id = 'slot-1'").run();

    const claimRes3 = repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-mismatch-3',
      expectedEpoch: 2,
    });

    expect(claimRes3.success).toBe(false);
    expect(claimRes3.error).toContain('WORKER_SLOT_NOT_READY');

    // Confirm authorization update rolled back
    const checkAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(checkAuth.adapter_started_at).toBeNull();
    expect(checkAuth.execution_id).toBeNull();
  });

  // 87. Omitted expectedExecutionId fails guarded release
  it('87. Omitted expectedExecutionId fails guarded release', async () => {
    const { leaseRes } = await seedStandardTopology({ acquireLease: true });

    const releaseRes = repo.releaseGuardedAccountLeaseAndIdleSlot({
      leaseId: leaseRes.lease.id,
      expectedAssignmentId: 'asgn-succ',
      expectedAccountId: 'acc-1',
      expectedSlotId: leaseRes.lease.worker_slot_id,
      expectedExecutionId: undefined as any,
    });

    expect(releaseRes.success).toBe(false);
    expect(releaseRes.error).toContain('GUARDED_RELEASE_EXECUTION_ID_REQUIRED');

    const lease = repo.getAccountLease(leaseRes.lease.id)!;
    expect(lease.released_at).toBeNull();
    const slot = repo.getWorkerSlot(leaseRes.lease.worker_slot_id)!;
    expect(slot.status).toBe('LEASED');
  });

  // 88. Initial settlement rejects null authorization account binding
  it('88. Initial settlement rejects null authorization account binding', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-settle-null-acc',
      expectedEpoch: 2,
    });

    // Create mismatched account to satisfy FK constraint on provider_resources
    db.prepare(`
      INSERT INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at)
      VALUES ('acc-other-88', 'prov-a', 'Account Other 88', 'NATIVE_PROFILE', 1, 10, 'AVAILABLE', 2, ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString());
    db.prepare("UPDATE provider_resources SET provider_account_id = 'acc-other-88' WHERE id = 'res-1'").run();

    const settleRes = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-settle-null-acc',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: { output: 'test' },
    });

    expect(settleRes.success).toBe(false);
    expect(settleRes.error).toContain('BINDING_MISMATCH');

    const checkAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(checkAuth.settled_at).toBeNull();
  });

  // 89. Settlement replay rejects tampered or missing transfer/attempt/assignment/account graph
  it('89. Settlement replay rejects tampered or missing transfer/attempt/assignment/account graph', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-replay-tamper',
      expectedEpoch: 2,
    });

    const settleRes1 = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-replay-tamper',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: { output: 'ok' },
    });
    expect(settleRes1.success).toBe(true);

    // Tamper transfer successor attempt ID (insert valid attempt to satisfy FK)
    repo.createTaskAttempt({
      id: 'att-tampered-89',
      task_id: auth.task_id,
      attempt_number: 99,
      status: 'PENDING',
      agent_profile_id: 'agent-prof-1',
      agent_id: null,
      started_at: new Date().toISOString(),
      ended_at: null,
      summary: null,
    });
    db.prepare("UPDATE handoff_transfers SET successor_attempt_id = 'att-tampered-89' WHERE id = 'xfer-1'").run();

    const replayRes1 = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-replay-tamper',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: { output: 'ok' },
    });

    expect(replayRes1.success).toBe(false);
    expect(replayRes1.error).toContain('SETTLEMENT_CONFLICT');
    db.prepare("UPDATE handoff_transfers SET successor_attempt_id = 'att-succ' WHERE id = 'xfer-1'").run();

    // Tamper assignment routing_decision_id
    db.prepare("UPDATE agent_assignments SET routing_decision_id = 'dec-tampered-89' WHERE id = 'asgn-succ'").run();

    const replayRes2 = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-replay-tamper',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: { output: 'ok' },
    });

    expect(replayRes2.success).toBe(false);
    expect(replayRes2.error).toContain('SETTLEMENT_CONFLICT');
  });

  // 90. Settlement replay rejects missing canonical evidence keys even when a new hash is supplied
  it('90. Settlement replay rejects missing canonical evidence keys even when a new hash is supplied', async () => {
    const { auth, transfer } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-replay-keys',
      expectedEpoch: 2,
    });

    const settleRes = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-replay-keys',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: { ok: 1 },
    });
    expect(settleRes.success).toBe(true);

    // Mutate stored evidence to drop 'routing_decision_id' and update hash to match partial json
    const partialEvidence = {
      authorization_id: auth.id,
      execution_id: 'exec-replay-keys',
      transfer_id: transfer.id,
      project_id: 'proj-1',
      task_id: 'tsk-1',
      attempt_id: 'att-succ',
      assignment_id: 'asgn-succ',
      provider_id: 'prov-a',
      resource_id: 'res-1',
      account_id: 'acc-1',
      // routing_decision_id missing!
      ownership_epoch: 2,
      lifecycle_version: 1,
      settlement_status: 'COMPLETED',
      outcome: 'RETURNED',
      started_at: '2026-08-27T00:00:00.000Z',
      finished_at: '2026-08-27T00:01:00.000Z',
      result_payload: { ok: 1 },
    };
    const partialJson = JSON.stringify(partialEvidence);
    const partialHash = computeSha256(partialJson);

    db.prepare('UPDATE execution_authorizations SET settlement_evidence_json = ?, settlement_evidence_hash = ? WHERE id = ?').run(
      partialJson,
      partialHash,
      auth.id
    );

    const replayRes = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-replay-keys',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: { ok: 1 },
    });

    expect(replayRes.success).toBe(false);
    expect(replayRes.error).toContain('SETTLEMENT_CONFLICT');
  });

  // 91. Settlement rejects invalid ISO timestamps
  it('91. Settlement rejects invalid ISO timestamps', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-invalid-ts',
      expectedEpoch: 2,
    });

    const settleRes = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-invalid-ts',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      finishedAt: 'not-an-iso-timestamp',
      resultPayload: { output: 1 },
    });

    expect(settleRes.success).toBe(false);
    expect(settleRes.error).toContain('INVALID_ISO_TIMESTAMP');
  });

  // 92. Termination replay rejects evidence, reason, proof or timestamp contradiction
  it('92. Termination replay rejects evidence, reason, proof or timestamp contradiction', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-term-contradict',
      expectedEpoch: 2,
    });

    const confirm1 = repo.confirmExecutionTermination({
      authorizationId: auth.id,
      executionId: 'exec-term-contradict',
      terminationStatus: 'CONFIRMED_TERMINATED',
      terminationSource: 'PROCESS_EXIT_0',
      terminationReason: 'EXECUTION_TIMEOUT',
      terminationProofSource: 'LOCAL_PROCESS_EXIT',
      terminationEvidenceJson: JSON.stringify({ exitCode: 0 }),
      confirmedAt: '2026-08-27T00:05:00.000Z',
      terminatedAt: '2026-08-27T00:05:00.000Z',
    });
    expect(confirm1.success).toBe(true);

    // Contradictory reason
    const contradictReason = repo.confirmExecutionTermination({
      authorizationId: auth.id,
      executionId: 'exec-term-contradict',
      terminationStatus: 'CONFIRMED_TERMINATED',
      terminationSource: 'PROCESS_EXIT_0',
      terminationReason: 'EXECUTION_CANCELLED',
      terminationProofSource: 'LOCAL_PROCESS_EXIT',
      terminationEvidenceJson: JSON.stringify({ exitCode: 0 }),
    });
    expect(contradictReason.success).toBe(false);
    expect(contradictReason.error).toContain('TERMINATION_SOURCE_CONFLICT');

    // Contradictory proof source
    const contradictProof = repo.confirmExecutionTermination({
      authorizationId: auth.id,
      executionId: 'exec-term-contradict',
      terminationStatus: 'CONFIRMED_TERMINATED',
      terminationSource: 'PROCESS_EXIT_0',
      terminationReason: 'EXECUTION_TIMEOUT',
      terminationProofSource: 'PROVIDER_FINAL_ACK',
      terminationEvidenceJson: JSON.stringify({ exitCode: 0 }),
    });
    expect(contradictProof.success).toBe(false);
    expect(contradictProof.error).toContain('TERMINATION_SOURCE_CONFLICT');

    // Contradictory proof payload
    const contradictPayload = repo.confirmExecutionTermination({
      authorizationId: auth.id,
      executionId: 'exec-term-contradict',
      terminationStatus: 'CONFIRMED_TERMINATED',
      terminationSource: 'PROCESS_EXIT_0',
      terminationReason: 'EXECUTION_TIMEOUT',
      terminationProofSource: 'LOCAL_PROCESS_EXIT',
      terminationEvidenceJson: JSON.stringify({ exitCode: 999 }),
    });
    expect(contradictPayload.success).toBe(false);
    expect(contradictPayload.error).toContain('TERMINATION_SOURCE_CONFLICT');
  });

  // 93. Fresh AUTHORIZED scan is database/event mutation-free
  it('93. Fresh AUTHORIZED scan is database/event mutation-free', async () => {
    const { auth } = await seedStandardTopology();
    const eventsBefore = (db.prepare('SELECT count(*) as count FROM events').get() as any).count;

    const res = scanner.reconcileAuthorization(auth.id);
    expect(res.classification).toBe('PRE_ADAPTER_NOT_STARTED');
    expect(res.disposition).toBe('UNRESOLVED_FENCED');
    expect(res.mutatedTerminalState).toBe(false);
    expect(res.mutatedResources).toBe(false);

    const stateRow = repo.getExecutionRecoveryState(auth.id);
    expect(stateRow).toBeNull();
    const eventsAfter = (db.prepare('SELECT count(*) as count FROM events').get() as any).count;
    expect(eventsAfter).toBe(eventsBefore);
  });

  // 94. Unexpired leased pre-adapter scan is database/event mutation-free
  it('94. Unexpired leased pre-adapter scan is database/event mutation-free', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    const eventsBefore = (db.prepare('SELECT count(*) as count FROM events').get() as any).count;

    const res = scanner.reconcileAuthorization(auth.id);
    expect(res.classification).toBe('PRE_ADAPTER_NOT_STARTED');
    expect(res.disposition).toBe('UNRESOLVED_FENCED');

    const stateRow = repo.getExecutionRecoveryState(auth.id);
    expect(stateRow).toBeNull();
    const eventsAfter = (db.prepare('SELECT count(*) as count FROM events').get() as any).count;
    expect(eventsAfter).toBe(eventsBefore);
  });

  // 95. Scanner rejects missing lifecycle-v1 graph/evidence fields
  it('95. Scanner rejects missing lifecycle-v1 graph/evidence fields', async () => {
    const { auth, transfer } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });

    const nowIso = new Date().toISOString();
    const completeEvidence = {
      authorization_id: auth.id,
      execution_id: 'exec-1',
      transfer_id: transfer.id,
      project_id: auth.project_id,
      task_id: auth.task_id,
      attempt_id: auth.attempt_id,
      assignment_id: auth.assignment_id,
      provider_id: auth.selected_provider_id,
      resource_id: auth.selected_resource_id,
      account_id: 'acc-1',
      routing_decision_id: auth.routing_decision_id,
      ownership_epoch: 2,
      lifecycle_version: 1,
      settlement_status: 'COMPLETED',
      outcome: 'RETURNED',
      started_at: nowIso,
      finished_at: nowIso,
      result_payload: { status: 'COMPLETED' },
      error_json: null,
    };

    // Test removing each of ALL 19 required settlement fields one-by-one with properly recomputed hash
    const all19Fields = [
      'authorization_id',
      'execution_id',
      'transfer_id',
      'project_id',
      'task_id',
      'attempt_id',
      'assignment_id',
      'provider_id',
      'resource_id',
      'account_id',
      'routing_decision_id',
      'ownership_epoch',
      'lifecycle_version',
      'settlement_status',
      'outcome',
      'started_at',
      'finished_at',
      'result_payload',
      'error_json',
    ];

    for (const field of all19Fields) {
      const partialEvidence: any = { ...completeEvidence };
      delete partialEvidence[field];
      const partialJson = canonicalJsonStringify(partialEvidence);
      const partialHash = computeSha256(partialJson);

      db.prepare(`
        UPDATE execution_authorizations
        SET settled_at = ?,
            settlement_status = 'COMPLETED',
            adapter_outcome = 'RETURNED',
            adapter_finished_at = ?,
            settlement_evidence_json = ?,
            settlement_evidence_hash = ?
        WHERE id = ?
      `).run(nowIso, nowIso, partialJson, partialHash, auth.id);

      const res = scanner.reconcileAuthorization(auth.id);
      expect(res.classification).toBe('AUTHORITY_CONFLICT');
      expect(res.disposition).toBe('REJECTED_INTEGRITY_CONFLICT');
      expect(res.error).toMatch(new RegExp(`(missing required field "${field}"|contains invalid number of fields)`));
    }
  });

  // 96. Recovery mutation rolls back when ledger or event persistence fails
  it('96. Recovery mutation rolls back when ledger or event persistence fails', async () => {
    const { auth, leaseRes } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    db.prepare("UPDATE account_leases SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(leaseRes.lease.id);

    // Case A: Thrown error
    const spy1 = vi.spyOn(repo, 'insertDeterministicEvent').mockImplementation(() => {
      throw new Error('SIMULATED_EVENT_PERSISTENCE_CRASH');
    });

    expect(() => {
      scanner.reconcileAuthorization(auth.id);
    }).toThrow(/SIMULATED_EVENT_PERSISTENCE_CRASH/);

    let checkAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(checkAuth.status).toBe('DISPATCHED');
    let transfer = repo.getHandoffTransferBySuccessorAuthId(auth.id)!;
    expect(transfer.status).toBe('ACCEPTED');
    spy1.mockRestore();

    // Case B: Returns false
    const spy2 = vi.spyOn(repo, 'insertDeterministicEvent').mockReturnValue(false);

    expect(() => {
      scanner.reconcileAuthorization(auth.id);
    }).toThrow(/RECOVERY_EVENT_INSERT_FAILED/);

    checkAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(checkAuth.status).toBe('DISPATCHED');
    transfer = repo.getHandoffTransferBySuccessorAuthId(auth.id)!;
    expect(transfer.status).toBe('ACCEPTED');
    spy2.mockRestore();
  });

  // 97. Migration-19 confirmed legacy row upgrades safely to unresolved
  it('97. Migration-19 confirmed legacy row upgrades safely to unresolved', () => {
    const testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    // Run migrations 1 through 19
    const migrations1To19 = MIGRATIONS.filter((m) => m.version <= 19);
    for (const m of migrations1To19) {
      testDb.transaction(() => {
        m.up(testDb);
        testDb.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          m.version,
          m.name,
          new Date().toISOString()
        );
      })();
    }

    testDb.exec(`
      INSERT INTO projects (id, name, repository_path, status, created_at, updated_at)
      VALUES ('p-up', 'P-Up', '/repo', 'RUNNING', '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
      INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, created_at, updated_at)
      VALUES ('t-up', 'p-up', 'T-Up', 'CODING', 'MEDIUM', 'LOW', 0, 5, 0.0, '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
      INSERT INTO task_attempts (id, task_id, attempt_number, agent_id, status, started_at)
      VALUES ('att-up', 't-up', 1, 'agent-1', 'RUNNING', '2026-08-27T00:00:00Z');
      INSERT INTO protocol_messages (id, message_id, protocol, project_id, task_id, payload_hash, raw_payload, status, created_at, processed_at)
      VALUES ('msg-up', 'msg-id-up', 'manager.v1', 'p-up', 't-up', 'hash-mgr', '{}', 'APPLIED', '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
      INSERT INTO providers (id, name, adapter_type, enabled, created_at)
      VALUES ('prov-up', 'CLI Provider', 'LOCAL_CLI', 1, '2026-08-27T00:00:00Z');
      INSERT INTO provider_resources (id, provider_id, model_name, health_status, capabilities_json, enabled, quota_source, quota_confidence, last_health_check)
      VALUES ('res-up', 'prov-up', 'gpt-4o', 'AVAILABLE', '[]', 1, 'UNKNOWN', 0.0, '2026-08-27T00:00:00Z');

      INSERT INTO execution_authorizations (
        id, project_id, task_id, attempt_id, task_revision, base_sha, repository_head_sha,
        manager_message_id, manager_payload_hash, routing_decision_id, selected_resource_id,
        selected_provider_id, instruction_payload_hash, context_manifest_hash,
        canonical_instructions_json, context_files_json, status, created_at,
        dispatched_at, execution_id, adapter_started_at,
        termination_status, termination_source, termination_confirmed_at
      ) VALUES (
        'auth-legacy-unprovable', 'p-up', 't-up', 'att-up', 1, 'sha1', 'sha2',
        'msg-up', 'hash-mgr', 'rd-up', 'res-up', 'prov-up', 'h-inst', 'h-ctx',
        '[]', '[]', 'DISPATCHED', '2026-08-27T00:00:00Z',
        '2026-08-27T00:01:00Z', 'exec-legacy', '2026-08-27T00:02:00Z',
        'CONFIRMED_TERMINATED', 'UNKNOWN_TIMEOUT_KILL', '2026-08-27T00:05:00Z'
      );
    `);

    // Run Migration 20
    const m20 = MIGRATIONS.find((m) => m.version === 20)!;
    testDb.transaction(() => {
      m20.up(testDb);
      testDb.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m20.version,
        m20.name,
        new Date().toISOString()
      );
    })();

    const upgradedAuth = testDb.prepare('SELECT * FROM execution_authorizations WHERE id = ?').get('auth-legacy-unprovable') as any;
    expect(upgradedAuth.termination_status).toBe('UNRESOLVED');
    expect(upgradedAuth.termination_confirmed_at).toBeNull();
    expect(upgradedAuth.terminated_at).toBeNull();
  });

  // 98. Migration constraints reject partial confirmed and invalid unacknowledged groups
  it('98. Migration constraints reject partial confirmed and invalid unacknowledged groups', () => {
    // Attempt inserting CONFIRMED_TERMINATED with missing proof source -> must throw CHECK constraint failed
    expect(() => {
      db.exec(`
        INSERT INTO execution_authorizations (
          id, project_id, task_id, attempt_id, task_revision, base_sha, repository_head_sha,
          manager_message_id, manager_payload_hash, routing_decision_id, selected_resource_id,
          selected_provider_id, instruction_payload_hash, context_manifest_hash,
          canonical_instructions_json, context_files_json, status, created_at,
          termination_status, termination_source, termination_confirmed_at
        ) VALUES (
          'auth-bad-confirmed', 'proj-1', 'task-1', 'att-1', 1, 'sha1', 'sha2',
          'msg-1', 'hash-mgr', 'rd-1', 'res-1', 'prov-1', 'h1', 'h2',
          '[]', '[]', 'DISPATCHED', '2026-08-27T00:00:00Z',
          'CONFIRMED_TERMINATED', 'KILL_SIGNAL', '2026-08-27T00:05:00Z'
        );
      `);
    }).toThrow(/CHECK constraint failed/);

    // Attempt inserting UNRESOLVED with non-null termination_confirmed_at -> must throw CHECK constraint failed
    expect(() => {
      db.exec(`
        INSERT INTO execution_authorizations (
          id, project_id, task_id, attempt_id, task_revision, base_sha, repository_head_sha,
          manager_message_id, manager_payload_hash, routing_decision_id, selected_resource_id,
          selected_provider_id, instruction_payload_hash, context_manifest_hash,
          canonical_instructions_json, context_files_json, status, created_at,
          termination_status, termination_source, termination_confirmed_at
        ) VALUES (
          'auth-bad-unresolved', 'proj-1', 'task-1', 'att-1', 1, 'sha1', 'sha2',
          'msg-1', 'hash-mgr', 'rd-1', 'res-1', 'prov-1', 'h1', 'h2',
          '[]', '[]', 'DISPATCHED', '2026-08-27T00:00:00Z',
          'UNRESOLVED', 'TIMEOUT_PENDING', '2026-08-27T00:05:00Z'
        );
      `);
    }).toThrow(/CHECK constraint failed/);
  });

  // 99. Direct lifecycle-v1 claim with missing assignment fails closed
  it('99. Direct lifecycle-v1 claim with missing assignment fails closed', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());

    repo.createTask({
      id: 'tsk-other-99',
      project_id: 'proj-1',
      milestone_id: null,
      title: 'T',
      description: 'T',
      state: 'CODING',
      priority: 'LOW',
      risk: 'LOW',
      revision_count: 1,
      max_revisions: 5,
      progress_cache_percent: 0,
      paused_from_state: null,
      assigned_agent_id: null,
      ownership_epoch: 1,
      base_sha: baseCommitSha,
      current_sha: null,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    repo.createTaskAttempt({
      id: 'att-other-99',
      task_id: 'tsk-other-99',
      attempt_number: 1,
      status: 'PENDING',
      agent_profile_id: 'agent-prof-1',
      agent_id: null,
      started_at: new Date().toISOString(),
      ended_at: null,
      summary: null,
    });
    repo.createAgentAssignment({
      id: 'asgn-other-99',
      project_id: 'proj-1',
      task_id: 'tsk-other-99',
      attempt_id: 'att-other-99',
      role_profile_id: 'role-1',
      agent_profile_id: 'agent-prof-1',
      selected_provider_id: 'prov-a',
      selected_account_id: 'acc-1',
      selected_resource_id: 'res-1',
      selected_worker_slot_id: null,
      routing_decision_id: 'dec-other-99',
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    });

    db.prepare("UPDATE execution_authorizations SET assignment_id = 'asgn-other-99' WHERE id = ?").run(auth.id);

    const claimRes = repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-missing-asgn',
      expectedEpoch: 2,
    });

    expect(claimRes.success).toBe(false);
    expect(claimRes.error).toContain('ASSIGNMENT_BINDING_MISMATCH');

    const checkAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(checkAuth.adapter_started_at).toBeNull();
  });

  // 100. Lifecycle-v1 dispatch with missing assignment invokes no adapter
  it('100. Lifecycle-v1 dispatch with missing assignment invokes no adapter', async () => {
    const { auth } = await seedStandardTopology();
    vi.spyOn(repo, 'getExecutionAuthorization').mockReturnValue({
      ...auth,
      lifecycle_version: 1,
      assignment_id: null as any,
    });

    const adapterSpy = vi.spyOn(adapterA, 'execute');

    const res = await dispatchService.dispatch(auth.id);
    expect(res.status).toBe('FAILED');
    expect(res.errorCode).toBe('RECOVERY_FENCED');
    expect(adapterSpy).not.toHaveBeenCalled();
    adapterSpy.mockRestore();
  });

  // 101. Lease account mismatch rolls back claim
  it('101. Lease account mismatch rolls back claim', async () => {
    const { auth, leaseRes } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());

    // Insert other account and mismatch lease provider_account_id
    db.prepare(`
      INSERT INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at)
      VALUES ('acc-lease-mismatch', 'prov-a', 'Account Mismatch', 'NATIVE_PROFILE', 1, 10, 'AVAILABLE', 2, ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString());

    db.prepare("UPDATE account_leases SET provider_account_id = 'acc-lease-mismatch' WHERE id = ?").run(leaseRes.lease.id);

    const claimRes = repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-lease-mismatch',
      expectedEpoch: 2,
    });

    expect(claimRes.success).toBe(false);
    expect(claimRes.error).toContain('ACTIVE_LEASE_NOT_FOUND');

    const checkAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(checkAuth.adapter_started_at).toBeNull();
    const slot = repo.getWorkerSlot('slot-1')!;
    expect(slot.current_execution_id).toBeNull();
  });

  // 102. Settlement replay rejects tampered transfer successor attempt/assignment
  it('102. Settlement replay rejects tampered transfer successor attempt/assignment', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-replay-successor-tamper',
      expectedEpoch: 2,
    });

    const settleRes = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-replay-successor-tamper',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: { success: true },
    });
    expect(settleRes.success).toBe(true);

    // Tamper transfer successor_assignment_id (insert valid assignment to satisfy FK)
    repo.createAgentAssignment({
      id: 'asgn-tampered-102',
      project_id: auth.project_id,
      task_id: auth.task_id,
      attempt_id: 'att-succ',
      role_profile_id: 'role-1',
      agent_profile_id: 'agent-prof-1',
      selected_provider_id: 'prov-a',
      selected_account_id: 'acc-1',
      selected_resource_id: 'res-1',
      selected_worker_slot_id: null,
      routing_decision_id: 'dec-route-tsk-1',
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    });
    db.prepare("UPDATE handoff_transfers SET successor_assignment_id = 'asgn-tampered-102' WHERE id = 'xfer-1'").run();

    const replayRes = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-replay-successor-tamper',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: { success: true },
    });

    expect(replayRes.success).toBe(false);
    expect(replayRes.error).toContain('SETTLEMENT_CONFLICT');
  });

  // 103. Settlement replay rejects assignment provider/resource/routing tampering
  it('103. Settlement replay rejects assignment provider/resource/routing tampering', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-replay-asgn-tamper',
      expectedEpoch: 2,
    });

    const settleRes = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-replay-asgn-tamper',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: { ok: true },
    });
    expect(settleRes.success).toBe(true);

    // Tamper assignment selected_resource_id (insert valid resource to satisfy FK)
    db.prepare(`
      INSERT INTO provider_resources (id, provider_id, provider_account_id, model_name, health_status, capabilities_json, enabled, total_quota, remaining_quota, quota_unit, quota_source, quota_confidence, last_health_check)
      VALUES ('res-tampered-103', 'prov-a', 'acc-1', 'tampered-model', 'AVAILABLE', '["CODING"]', 1, 1000, 1000, 'REQUESTS', 'PROVIDER_REPORTED', 1.0, ?)
    `).run(new Date().toISOString());
    db.prepare("UPDATE agent_assignments SET selected_resource_id = 'res-tampered-103' WHERE id = 'asgn-succ'").run();

    const replayRes = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-replay-asgn-tamper',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: { ok: true },
    });

    expect(replayRes.success).toBe(false);
    expect(replayRes.error).toContain('SETTLEMENT_CONFLICT');
  });

  // 104. Termination canonical-envelope field tampering fails closed
  it('104. Termination canonical-envelope field tampering fails closed', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-term-tamper',
      expectedEpoch: 2,
    });

    const confirmRes = repo.confirmExecutionTermination({
      authorizationId: auth.id,
      executionId: 'exec-term-tamper',
      terminationStatus: 'CONFIRMED_TERMINATED',
      terminationSource: 'PROCESS_EXIT_0',
      terminationReason: 'EXECUTION_TIMEOUT',
      terminationProofSource: 'LOCAL_PROCESS_EXIT',
      terminationEvidenceJson: JSON.stringify({ code: 0 }),
      confirmedAt: '2026-08-27T00:05:00.000Z',
      terminatedAt: '2026-08-27T00:05:00.000Z',
    });
    expect(confirmRes.success).toBe(true);

    // Case 1: Tamper stored envelope JSON without recomputing hash
    const tamperedEnvelopeUnchangedHash = {
      authorization_id: auth.id,
      execution_id: 'exec-term-tamper',
      termination_status: 'CONFIRMED_TERMINATED',
      termination_source: 'PROCESS_EXIT_0',
      termination_reason: 'EXECUTION_CANCELLED', // Tampered!
      proof_source: 'LOCAL_PROCESS_EXIT',
      confirmed_at: '2026-08-27T00:05:00.000Z',
      terminated_at: '2026-08-27T00:05:00.000Z',
      proof_payload: { code: 0 },
    };
    db.prepare("UPDATE execution_authorizations SET termination_evidence_json = ? WHERE id = ?").run(
      JSON.stringify(tamperedEnvelopeUnchangedHash),
      auth.id
    );

    const replayRes1 = repo.confirmExecutionTermination({
      authorizationId: auth.id,
      executionId: 'exec-term-tamper',
      terminationStatus: 'CONFIRMED_TERMINATED',
      terminationSource: 'PROCESS_EXIT_0',
      terminationReason: 'EXECUTION_TIMEOUT',
      terminationProofSource: 'LOCAL_PROCESS_EXIT',
      terminationEvidenceJson: JSON.stringify({ code: 0 }),
    });
    expect(replayRes1.success).toBe(false);
    expect(replayRes1.error).toContain('TERMINATION_SOURCE_CONFLICT');

    // Case 2: Tamper stored envelope JSON AND recompute hash (mismatch against DB column termination_reason)
    const recomputedHash = computeSha256(canonicalJsonStringify(tamperedEnvelopeUnchangedHash));
    db.prepare("UPDATE execution_authorizations SET termination_evidence_json = ?, termination_evidence_hash = ? WHERE id = ?").run(
      JSON.stringify(tamperedEnvelopeUnchangedHash),
      recomputedHash,
      auth.id
    );

    const replayRes2 = repo.confirmExecutionTermination({
      authorizationId: auth.id,
      executionId: 'exec-term-tamper',
      terminationStatus: 'CONFIRMED_TERMINATED',
      terminationSource: 'PROCESS_EXIT_0',
      terminationReason: 'EXECUTION_TIMEOUT',
      terminationProofSource: 'LOCAL_PROCESS_EXIT',
      terminationEvidenceJson: JSON.stringify({ code: 0 }),
    });
    expect(replayRes2.success).toBe(false);
    expect(replayRes2.error).toContain('TERMINATION_SOURCE_CONFLICT');
  });

  // 105. Lifecycle-v1 unhandled scanner state becomes authority conflict
  it('105. Lifecycle-v1 unhandled scanner state becomes authority conflict', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());

    const dummyHash = computeSha256('dummy-settlement-payload');
    db.prepare(`
      UPDATE execution_authorizations
      SET status = 'INVALIDATED',
          adapter_started_at = '2026-08-27T00:00:00Z',
          adapter_finished_at = '2026-08-27T00:01:00Z',
          settled_at = '2026-08-27T00:01:00Z',
          settlement_status = 'CANCELLED',
          settlement_evidence_json = '{}',
          settlement_evidence_hash = ?
      WHERE id = ?
    `).run(dummyHash, auth.id);
    db.prepare("UPDATE handoff_transfers SET status = 'COMPLETED' WHERE id = 'xfer-1'").run(); // cause conflict against CANCELLED

    const conflictRes = scanner.reconcileAuthorization(auth.id);
    expect(conflictRes.classification).toBe('AUTHORITY_CONFLICT');
    expect(conflictRes.disposition).toBe('REJECTED_INTEGRITY_CONFLICT');
  });

  // 106. Missing transfer never creates an empty-ID recovery ledger; false event insertion rolls back
  it('106. Missing transfer never creates an empty-ID recovery ledger; false event insertion rolls back', async () => {
    // Case A: Genuinely missing transfer fails visibly and writes zero recovery rows
    const { auth } = await seedStandardTopology();
    db.prepare("DELETE FROM handoff_transfers WHERE successor_authorization_id = ?").run(auth.id);

    expect(() => {
      scanner.reconcileAuthorization(auth.id);
    }).toThrow(/HandoffTransfer for successor authorization/);

    const emptyTransferLedgers = db.prepare("SELECT * FROM execution_recovery_states WHERE transfer_id = '' OR authorization_id = ?").all(auth.id);
    expect(emptyTransferLedgers.length).toBe(0);

    // Clean up auth from Case A so it does not interfere with scanAndReconcile in Case B
    db.prepare("DELETE FROM execution_authorizations WHERE id = ?").run(auth.id);

    // Case B: False event insertion through scanAndReconcile throws and rolls back recovery
    const { auth: auth2, leaseRes } = await seedStandardTopology({
      taskId: 'tsk-106b',
      transferId: 'xfer-106b',
      asgnSuccId: 'asgn-106b',
      attemptSuccId: 'att-106b',
      asgnPredId: 'asgn-pred-106b',
      attemptPredId: 'att-pred-106b',
      acquireLease: true,
      acceptSuccessor: true,
    });
    repo.claimExecutionAuthorization(auth2.id, new Date().toISOString());
    db.prepare("UPDATE account_leases SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(leaseRes.lease.id);

    const spy = vi.spyOn(repo, 'insertDeterministicEvent').mockReturnValue(false);

    expect(() => {
      scanner.scanAndReconcile();
    }).toThrow(/RECOVERY_EVENT_INSERT_FAILED/);

    const checkAuth = repo.getExecutionAuthorization(auth2.id)!;
    expect(checkAuth.status).toBe('DISPATCHED');
    spy.mockRestore();
  });

  // 107. Empty required settlement field plus recomputed hash is rejected
  it('107. Empty required settlement field plus recomputed hash is rejected', async () => {
    const { auth, transfer } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-107',
      expectedEpoch: 2,
    });

    const nowIso = new Date().toISOString();
    const emptyStringEvidence = {
      authorization_id: auth.id,
      execution_id: 'exec-107',
      transfer_id: transfer.id,
      project_id: auth.project_id,
      task_id: auth.task_id,
      attempt_id: auth.attempt_id,
      assignment_id: auth.assignment_id,
      provider_id: auth.selected_provider_id,
      resource_id: auth.selected_resource_id,
      account_id: 'acc-1',
      routing_decision_id: '   ', // Empty whitespace string!
      ownership_epoch: 2,
      lifecycle_version: 1,
      settlement_status: 'COMPLETED',
      outcome: 'RETURNED',
      started_at: nowIso,
      finished_at: nowIso,
      result_payload: { ok: true },
      error_json: null,
    };
    const emptyJson = canonicalJsonStringify(emptyStringEvidence);
    const emptyHash = computeSha256(emptyJson);

    db.prepare(`
      UPDATE execution_authorizations
      SET settled_at = ?,
          settlement_status = 'COMPLETED',
          adapter_outcome = 'RETURNED',
          adapter_finished_at = ?,
          settlement_evidence_json = ?,
          settlement_evidence_hash = ?
      WHERE id = ?
    `).run(nowIso, nowIso, emptyJson, emptyHash, auth.id);

    const res = scanner.reconcileAuthorization(auth.id);
    expect(res.classification).toBe('AUTHORITY_CONFLICT');
    expect(res.disposition).toBe('REJECTED_INTEGRITY_CONFLICT');
    expect(res.error).toContain('is empty or not a string');
  });

  // 108. Stored termination envelope field deletion is rejected
  it('108. Stored termination envelope field deletion is rejected', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-term-108',
      expectedEpoch: 2,
    });

    repo.confirmExecutionTermination({
      authorizationId: auth.id,
      executionId: 'exec-term-108',
      terminationStatus: 'CONFIRMED_TERMINATED',
      terminationSource: 'PROCESS_EXIT_0',
      terminationReason: 'EXECUTION_TIMEOUT',
      terminationProofSource: 'LOCAL_PROCESS_EXIT',
      terminationEvidenceJson: JSON.stringify({ code: 0 }),
      confirmedAt: '2026-08-27T00:05:00.000Z',
      terminatedAt: '2026-08-27T00:05:00.000Z',
    });

    // Delete proof_payload from stored envelope and recompute hash
    const envelopeWithoutPayload: any = {
      authorization_id: auth.id,
      execution_id: 'exec-term-108',
      termination_status: 'CONFIRMED_TERMINATED',
      termination_source: 'PROCESS_EXIT_0',
      termination_reason: 'EXECUTION_TIMEOUT',
      proof_source: 'LOCAL_PROCESS_EXIT',
      confirmed_at: '2026-08-27T00:05:00.000Z',
      terminated_at: '2026-08-27T00:05:00.000Z',
    };
    const jsonWithoutPayload = canonicalJsonStringify(envelopeWithoutPayload);
    const hashWithoutPayload = computeSha256(jsonWithoutPayload);

    db.prepare("UPDATE execution_authorizations SET termination_evidence_json = ?, termination_evidence_hash = ? WHERE id = ?").run(
      jsonWithoutPayload,
      hashWithoutPayload,
      auth.id
    );

    const replayRes = repo.confirmExecutionTermination({
      authorizationId: auth.id,
      executionId: 'exec-term-108',
      terminationStatus: 'CONFIRMED_TERMINATED',
      terminationSource: 'PROCESS_EXIT_0',
      terminationReason: 'EXECUTION_TIMEOUT',
      terminationProofSource: 'LOCAL_PROCESS_EXIT',
      terminationEvidenceJson: JSON.stringify({ code: 0 }),
    });

    expect(replayRes.success).toBe(false);
    expect(replayRes.error).toMatch(/(missing required envelope field "proof_payload"|contains invalid number of fields)/);
  });

  // 109. Stored termination envelope metadata tampering is rejected even when its hash is recomputed
  it('109. Stored termination envelope metadata tampering is rejected even when its hash is recomputed', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-term-109',
      expectedEpoch: 2,
    });

    repo.confirmExecutionTermination({
      authorizationId: auth.id,
      executionId: 'exec-term-109',
      terminationStatus: 'CONFIRMED_TERMINATED',
      terminationSource: 'PROCESS_EXIT_0',
      terminationReason: 'EXECUTION_TIMEOUT',
      terminationProofSource: 'LOCAL_PROCESS_EXIT',
      terminationEvidenceJson: JSON.stringify({ code: 0 }),
      confirmedAt: '2026-08-27T00:05:00.000Z',
      terminatedAt: '2026-08-27T00:05:00.000Z',
    });

    // Tamper termination source in envelope and recompute hash
    const tamperedEnvelope = {
      authorization_id: auth.id,
      execution_id: 'exec-term-109',
      termination_status: 'CONFIRMED_TERMINATED',
      termination_source: 'TAMPERED_PROCESS_SOURCE', // Tampered!
      termination_reason: 'EXECUTION_TIMEOUT',
      proof_source: 'LOCAL_PROCESS_EXIT',
      confirmed_at: '2026-08-27T00:05:00.000Z',
      terminated_at: '2026-08-27T00:05:00.000Z',
      proof_payload: { code: 0 },
    };
    const tamperedJson = canonicalJsonStringify(tamperedEnvelope);
    const tamperedHash = computeSha256(tamperedJson);

    db.prepare("UPDATE execution_authorizations SET termination_evidence_json = ?, termination_evidence_hash = ? WHERE id = ?").run(
      tamperedJson,
      tamperedHash,
      auth.id
    );

    const replayRes = repo.confirmExecutionTermination({
      authorizationId: auth.id,
      executionId: 'exec-term-109',
      terminationStatus: 'CONFIRMED_TERMINATED',
      terminationSource: 'PROCESS_EXIT_0',
      terminationReason: 'EXECUTION_TIMEOUT',
      terminationProofSource: 'LOCAL_PROCESS_EXIT',
      terminationEvidenceJson: JSON.stringify({ code: 0 }),
    });

    expect(replayRes.success).toBe(false);
    expect(replayRes.error).toContain('Stored termination envelope fields mismatch database record columns');
  });

  // 110. Scanner rejects termination-envelope tampering
  it('110. Scanner rejects termination-envelope tampering', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-term-110',
      expectedEpoch: 2,
    });

    repo.confirmExecutionTermination({
      authorizationId: auth.id,
      executionId: 'exec-term-110',
      terminationStatus: 'CONFIRMED_TERMINATED',
      terminationSource: 'PROCESS_EXIT_0',
      terminationReason: 'EXECUTION_TIMEOUT',
      terminationProofSource: 'LOCAL_PROCESS_EXIT',
      terminationEvidenceJson: JSON.stringify({ code: 0 }),
      confirmedAt: '2026-08-27T00:05:00.000Z',
      terminatedAt: '2026-08-27T00:05:00.000Z',
    });

    // Case A: Tamper envelope JSON without recomputing hash
    db.prepare("UPDATE execution_authorizations SET termination_evidence_json = '{\"tampered\": true}' WHERE id = ?").run(auth.id);
    const resA = scanner.reconcileAuthorization(auth.id);
    expect(resA.classification).toBe('AUTHORITY_CONFLICT');
    expect(resA.disposition).toBe('REJECTED_INTEGRITY_CONFLICT');

    // Case B: Tamper envelope JSON AND recompute hash (mismatch against DB column termination_reason)
    const tamperedEnvelope = {
      authorization_id: auth.id,
      execution_id: 'exec-term-110',
      termination_status: 'CONFIRMED_TERMINATED',
      termination_source: 'PROCESS_EXIT_0',
      termination_reason: 'EXECUTION_CANCELLED', // Tampered!
      proof_source: 'LOCAL_PROCESS_EXIT',
      confirmed_at: '2026-08-27T00:05:00.000Z',
      terminated_at: '2026-08-27T00:05:00.000Z',
      proof_payload: { code: 0 },
    };
    const tamperedJson = canonicalJsonStringify(tamperedEnvelope);
    const tamperedHash = computeSha256(tamperedJson);

    db.prepare("UPDATE execution_authorizations SET termination_evidence_json = ?, termination_evidence_hash = ? WHERE id = ?").run(
      tamperedJson,
      tamperedHash,
      auth.id
    );

    const resB = scanner.reconcileAuthorization(auth.id);
    expect(resB.classification).toBe('AUTHORITY_CONFLICT');
    expect(resB.disposition).toBe('REJECTED_INTEGRITY_CONFLICT');
    expect(resB.error).toContain('mismatch');
  });

  // 111. Account-to-provider mismatch blocks adapter-start claim with zero mutation
  it('111. Account-to-provider mismatch blocks adapter-start claim with zero mutation', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());

    // Insert prov-b and account belonging to prov-b
    db.prepare(`
      INSERT INTO providers (id, name, adapter_type, enabled, created_at)
      VALUES ('prov-b-111', 'Provider B 111', 'LOCAL_CLI', 1, ?)
    `).run(new Date().toISOString());

    db.prepare(`
      INSERT INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at)
      VALUES ('acc-prov-b-111', 'prov-b-111', 'Account B 111', 'NATIVE_PROFILE', 1, 10, 'AVAILABLE', 2, ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString());

    // Set auth and assignment account to acc-prov-b-111 while provider remains prov-a
    db.prepare("UPDATE agent_assignments SET selected_account_id = 'acc-prov-b-111' WHERE id = 'asgn-succ'").run();
    db.prepare("UPDATE execution_authorizations SET selected_account_id = 'acc-prov-b-111' WHERE id = ?").run(auth.id);

    const claimRes = repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-mismatch-111',
      expectedEpoch: 2,
    });

    expect(claimRes.success).toBe(false);
    expect(claimRes.error).toContain('PROVIDER_ACCOUNT_MISMATCH');

    const checkAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(checkAuth.adapter_started_at).toBeNull();
    const slot = repo.getWorkerSlot('slot-1')!;
    expect(slot.current_execution_id).toBeNull();
  });

  // 112. Resource-to-provider mismatch blocks claim
  it('112. Resource-to-provider mismatch blocks claim', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());

    // Insert prov-b and resource on prov-b
    db.prepare(`
      INSERT INTO providers (id, name, adapter_type, enabled, created_at)
      VALUES ('prov-b-112', 'Provider B 112', 'LOCAL_CLI', 1, ?)
    `).run(new Date().toISOString());

    db.prepare(`
      INSERT INTO provider_resources (id, provider_id, provider_account_id, model_name, health_status, capabilities_json, enabled, total_quota, remaining_quota, quota_unit, quota_source, quota_confidence, last_health_check)
      VALUES ('res-prov-b-112', 'prov-b-112', 'acc-1', 'model-b', 'AVAILABLE', '["CODING"]', 1, 1000, 1000, 'REQUESTS', 'PROVIDER_REPORTED', 1.0, ?)
    `).run(new Date().toISOString());

    db.prepare("UPDATE agent_assignments SET selected_resource_id = 'res-prov-b-112' WHERE id = 'asgn-succ'").run();
    db.prepare("UPDATE execution_authorizations SET selected_resource_id = 'res-prov-b-112' WHERE id = ?").run(auth.id);

    const claimRes = repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-mismatch-112',
      expectedEpoch: 2,
    });

    expect(claimRes.success).toBe(false);
    expect(claimRes.error).toContain('PROVIDER_RESOURCE_MISMATCH');

    const checkAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(checkAuth.adapter_started_at).toBeNull();
  });

  // 113. Resource-to-account mismatch blocks claim
  it('113. Resource-to-account mismatch blocks claim', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());

    // Insert acc-other-113 on prov-a
    db.prepare(`
      INSERT INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at)
      VALUES ('acc-other-113', 'prov-a', 'Other 113', 'NATIVE_PROFILE', 1, 10, 'AVAILABLE', 2, ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString());

    // Update resource provider_account_id to acc-other-113 while auth is acc-1
    db.prepare("UPDATE provider_resources SET provider_account_id = 'acc-other-113' WHERE id = 'res-1'").run();

    const claimRes = repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-mismatch-113',
      expectedEpoch: 2,
    });

    expect(claimRes.success).toBe(false);
    expect(claimRes.error).toContain('PROVIDER_RESOURCE_MISMATCH');

    const checkAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(checkAuth.adapter_started_at).toBeNull();
  });

  // 114. Assignment-attempt mismatch blocks claim
  it('114. Assignment-attempt mismatch blocks claim', async () => {
    const { auth } = await seedStandardTopology({ acquireLease: true, acceptSuccessor: true });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());

    // Insert separate attempt
    repo.createTaskAttempt({
      id: 'att-other-114',
      task_id: auth.task_id,
      attempt_number: 99,
      status: 'PENDING',
      agent_profile_id: 'agent-prof-1',
      agent_id: null,
      started_at: new Date().toISOString(),
      ended_at: null,
      summary: null,
    });

    // Update assignment to point to att-other-114 while auth points to att-succ
    db.prepare("UPDATE agent_assignments SET attempt_id = 'att-other-114' WHERE id = 'asgn-succ'").run();

    const claimRes = repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-mismatch-114',
      expectedEpoch: 2,
    });

    expect(claimRes.success).toBe(false);
    expect(claimRes.error).toContain('ASSIGNMENT_BINDING_MISMATCH');

    const checkAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(checkAuth.adapter_started_at).toBeNull();
  });

  // 115. Event insertion returning false bubbles from scanAndReconcile and rolls back
  it('115. Event insertion returning false bubbles from scanAndReconcile and rolls back', async () => {
    const { auth, leaseRes } = await seedStandardTopology({
      taskId: 'tsk-115',
      transferId: 'xfer-115',
      asgnSuccId: 'asgn-115',
      attemptSuccId: 'att-115',
      asgnPredId: 'asgn-pred-115',
      attemptPredId: 'att-pred-115',
      acquireLease: true,
      acceptSuccessor: true,
    });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    db.prepare("UPDATE account_leases SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(leaseRes.lease.id);

    const spy = vi.spyOn(repo, 'insertDeterministicEvent').mockReturnValue(false);

    expect(() => {
      scanner.scanAndReconcile();
    }).toThrow(/RECOVERY_EVENT_INSERT_FAILED/);

    const checkAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(checkAuth.status).toBe('DISPATCHED');
    const transfer = repo.getHandoffTransferBySuccessorAuthId(auth.id)!;
    expect(transfer.status).toBe('ACCEPTED');
    spy.mockRestore();
  });

  // 116. Event insertion throwing bubbles from scanAndReconcile and rolls back
  it('116. Event insertion throwing bubbles from scanAndReconcile and rolls back', async () => {
    const { auth, leaseRes } = await seedStandardTopology({
      taskId: 'tsk-116',
      transferId: 'xfer-116',
      asgnSuccId: 'asgn-116',
      attemptSuccId: 'att-116',
      asgnPredId: 'asgn-pred-116',
      attemptPredId: 'att-pred-116',
      acquireLease: true,
      acceptSuccessor: true,
    });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    db.prepare("UPDATE account_leases SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(leaseRes.lease.id);

    const spy = vi.spyOn(repo, 'insertDeterministicEvent').mockImplementation(() => {
      throw new Error('FATAL_EVENT_DISK_FULL');
    });

    expect(() => {
      scanner.scanAndReconcile();
    }).toThrow(/FATAL_EVENT_DISK_FULL/);

    const checkAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(checkAuth.status).toBe('DISPATCHED');
    const transfer = repo.getHandoffTransferBySuccessorAuthId(auth.id)!;
    expect(transfer.status).toBe('ACCEPTED');
    spy.mockRestore();
  });

  // 117. Missing transfer creates neither a recovery row nor an empty transfer ID via scanAndReconcile
  it('117. Missing transfer creates neither a recovery row nor an empty transfer ID via scanAndReconcile', async () => {
    const { auth } = await seedStandardTopology({
      taskId: 'tsk-117',
      transferId: 'xfer-117',
      asgnSuccId: 'asgn-117',
      attemptSuccId: 'att-117',
      asgnPredId: 'asgn-pred-117',
      attemptPredId: 'att-pred-117',
    });

    // Delete transfer to create orphan
    db.prepare("DELETE FROM handoff_transfers WHERE id = 'xfer-117'").run();

    expect(() => {
      scanner.scanAndReconcile();
    }).toThrow(new RegExp(`HandoffTransfer for successor authorization "${auth.id}" not found`));

    const recoveryRows = db.prepare("SELECT * FROM execution_recovery_states WHERE authorization_id = ? OR transfer_id = ''").all(auth.id);
    expect(recoveryRows.length).toBe(0);
    const events = db.prepare("SELECT * FROM events WHERE structured_payload_json LIKE ?").all(`%${auth.id}%`);
    expect(events.length).toBe(0);
  });

  // 118. Settlement evidence with an additional top-level authority field and recomputed hash is rejected
  it('118. Settlement evidence with an additional top-level authority field and recomputed hash is rejected', async () => {
    const { auth, transfer } = await seedStandardTopology({
      taskId: 'tsk-118',
      transferId: 'xfer-118',
      asgnSuccId: 'asgn-118',
      attemptSuccId: 'att-118',
      asgnPredId: 'asgn-pred-118',
      attemptPredId: 'att-pred-118',
      acquireLease: true,
      acceptSuccessor: true,
    });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-118',
      expectedEpoch: 2,
    });

    const nowIso = new Date().toISOString();
    const completeEvidence: any = {
      authorization_id: auth.id,
      execution_id: 'exec-118',
      transfer_id: transfer.id,
      project_id: auth.project_id,
      task_id: auth.task_id,
      attempt_id: auth.attempt_id,
      assignment_id: auth.assignment_id,
      provider_id: auth.selected_provider_id,
      resource_id: auth.selected_resource_id,
      account_id: 'acc-1',
      routing_decision_id: auth.routing_decision_id,
      ownership_epoch: 2,
      lifecycle_version: 1,
      settlement_status: 'COMPLETED',
      outcome: 'RETURNED',
      started_at: nowIso,
      finished_at: nowIso,
      result_payload: { ok: true },
      error_json: null,
      extra_authority_field: 'UNAUTHORIZED_INJECTION',
    };

    const extraJson = canonicalJsonStringify(completeEvidence);
    const extraHash = computeSha256(extraJson);

    db.prepare(`
      UPDATE execution_authorizations
      SET settled_at = ?,
          settlement_status = 'COMPLETED',
          adapter_outcome = 'RETURNED',
          adapter_finished_at = ?,
          settlement_evidence_json = ?,
          settlement_evidence_hash = ?
      WHERE id = ?
    `).run(nowIso, nowIso, extraJson, extraHash, auth.id);

    // Test Scanner rejects extra field
    const scanRes = scanner.reconcileAuthorization(auth.id);
    expect(scanRes.classification).toBe('AUTHORITY_CONFLICT');
    expect(scanRes.disposition).toBe('REJECTED_INTEGRITY_CONFLICT');
    expect(scanRes.error).toContain('contains invalid number of fields');

    // Test Repository replay rejects extra field
    const replayRes = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-118',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: { ok: true },
    });
    expect(replayRes.success).toBe(false);
    expect(replayRes.error).toContain('SETTLEMENT_CONFLICT');
  });

  // 119. Termination replay with an additional top-level field and recomputed hash is rejected
  it('119. Termination replay with an additional top-level field and recomputed hash is rejected', async () => {
    const { auth } = await seedStandardTopology({
      taskId: 'tsk-119',
      transferId: 'xfer-119',
      asgnSuccId: 'asgn-119',
      attemptSuccId: 'att-119',
      asgnPredId: 'asgn-pred-119',
      attemptPredId: 'att-pred-119',
      acquireLease: true,
      acceptSuccessor: true,
    });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-119',
      expectedEpoch: 2,
    });

    const confirmRes = repo.confirmExecutionTermination({
      authorizationId: auth.id,
      executionId: 'exec-119',
      terminationStatus: 'CONFIRMED_TERMINATED',
      terminationSource: 'PROCESS_EXIT_0',
      terminationReason: 'EXECUTION_TIMEOUT',
      terminationProofSource: 'LOCAL_PROCESS_EXIT',
      terminationEvidenceJson: JSON.stringify({ code: 0 }),
      confirmedAt: '2026-08-27T00:05:00.000Z',
      terminatedAt: '2026-08-27T00:05:00.000Z',
    });
    expect(confirmRes.success).toBe(true);

    const extraEnvelope: any = {
      authorization_id: auth.id,
      execution_id: 'exec-119',
      termination_status: 'CONFIRMED_TERMINATED',
      termination_source: 'PROCESS_EXIT_0',
      termination_reason: 'EXECUTION_TIMEOUT',
      proof_source: 'LOCAL_PROCESS_EXIT',
      confirmed_at: '2026-08-27T00:05:00.000Z',
      terminated_at: '2026-08-27T00:05:00.000Z',
      proof_payload: { code: 0 },
      extra_field: 'ILLEGAL_KEY',
    };
    const extraHash = computeSha256(canonicalJsonStringify(extraEnvelope));

    db.prepare(`
      UPDATE execution_authorizations
      SET termination_evidence_json = ?,
          termination_evidence_hash = ?
      WHERE id = ?
    `).run(JSON.stringify(extraEnvelope), extraHash, auth.id);

    const replayRes = repo.confirmExecutionTermination({
      authorizationId: auth.id,
      executionId: 'exec-119',
      terminationStatus: 'CONFIRMED_TERMINATED',
      terminationSource: 'PROCESS_EXIT_0',
      terminationReason: 'EXECUTION_TIMEOUT',
      terminationProofSource: 'LOCAL_PROCESS_EXIT',
      terminationEvidenceJson: JSON.stringify({ code: 0 }),
    });
    expect(replayRes.success).toBe(false);
    expect(replayRes.error).toContain('TERMINATION_SOURCE_CONFLICT');
  });

  // 120. Scanner rejects an additional termination-envelope field with recomputed hash
  it('120. Scanner rejects an additional termination-envelope field with recomputed hash', async () => {
    const { auth } = await seedStandardTopology({
      taskId: 'tsk-120',
      transferId: 'xfer-120',
      asgnSuccId: 'asgn-120',
      attemptSuccId: 'att-120',
      asgnPredId: 'asgn-pred-120',
      attemptPredId: 'att-pred-120',
      acquireLease: true,
      acceptSuccessor: true,
    });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-120',
      expectedEpoch: 2,
    });

    const extraEnvelope: any = {
      authorization_id: auth.id,
      execution_id: 'exec-120',
      termination_status: 'CONFIRMED_TERMINATED',
      termination_source: 'PROCESS_EXIT_0',
      termination_reason: 'EXECUTION_TIMEOUT',
      proof_source: 'LOCAL_PROCESS_EXIT',
      confirmed_at: '2026-08-27T00:05:00.000Z',
      terminated_at: '2026-08-27T00:05:00.000Z',
      proof_payload: { code: 0 },
      tampered_metadata: 'INJECTED_FIELD',
    };
    const extraHash = computeSha256(canonicalJsonStringify(extraEnvelope));

    db.prepare(`
      UPDATE execution_authorizations
      SET termination_status = 'CONFIRMED_TERMINATED',
          termination_source = 'PROCESS_EXIT_0',
          termination_reason = 'EXECUTION_TIMEOUT',
          termination_proof_source = 'LOCAL_PROCESS_EXIT',
          termination_confirmed_at = '2026-08-27T00:05:00.000Z',
          terminated_at = '2026-08-27T00:05:00.000Z',
          termination_evidence_json = ?,
          termination_evidence_hash = ?
      WHERE id = ?
    `).run(JSON.stringify(extraEnvelope), extraHash, auth.id);

    const scanRes = scanner.reconcileAuthorization(auth.id);
    expect(scanRes.classification).toBe('AUTHORITY_CONFLICT');
    expect(scanRes.disposition).toBe('REJECTED_INTEGRITY_CONFLICT');
    expect(scanRes.error).toContain('contains invalid number of fields');
  });

  // 121. Settlement error_json tampering with recomputed hash is rejected
  it('121. Settlement error_json tampering with recomputed hash is rejected', async () => {
    const { auth, transfer } = await seedStandardTopology({
      taskId: 'tsk-121',
      transferId: 'xfer-121',
      asgnSuccId: 'asgn-121',
      attemptSuccId: 'att-121',
      asgnPredId: 'asgn-pred-121',
      attemptPredId: 'att-pred-121',
      acquireLease: true,
      acceptSuccessor: true,
    });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-121',
      expectedEpoch: 2,
    });

    const nowIso = new Date().toISOString();
    // In database, adapter_error_json is null, but stored evidence claims '{"code": "ERR_MODIFIED"}'
    const tamperedEvidence = {
      authorization_id: auth.id,
      execution_id: 'exec-121',
      transfer_id: transfer.id,
      project_id: auth.project_id,
      task_id: auth.task_id,
      attempt_id: auth.attempt_id,
      assignment_id: auth.assignment_id,
      provider_id: auth.selected_provider_id,
      resource_id: auth.selected_resource_id,
      account_id: 'acc-1',
      routing_decision_id: auth.routing_decision_id,
      ownership_epoch: 2,
      lifecycle_version: 1,
      settlement_status: 'COMPLETED',
      outcome: 'RETURNED',
      started_at: nowIso,
      finished_at: nowIso,
      result_payload: { ok: true },
      error_json: '{"code": "ERR_MODIFIED"}',
    };
    const tamperedHash = computeSha256(canonicalJsonStringify(tamperedEvidence));

    db.prepare(`
      UPDATE execution_authorizations
      SET settled_at = ?,
          settlement_status = 'COMPLETED',
          adapter_outcome = 'RETURNED',
          adapter_error_json = NULL,
          adapter_finished_at = ?,
          settlement_evidence_json = ?,
          settlement_evidence_hash = ?
      WHERE id = ?
    `).run(nowIso, nowIso, JSON.stringify(tamperedEvidence), tamperedHash, auth.id);

    // Scanner check
    const scanRes = scanner.reconcileAuthorization(auth.id);
    expect(scanRes.classification).toBe('AUTHORITY_CONFLICT');
    expect(scanRes.disposition).toBe('REJECTED_INTEGRITY_CONFLICT');
    expect(scanRes.error).toContain('error_json mismatch');

    // Replay check
    const replayRes = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-121',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: { ok: true },
    });
    expect(replayRes.success).toBe(false);
    expect(replayRes.error).toContain('SETTLEMENT_CONFLICT');
  });

  // 122. Initial settlement rejects a null resource-account binding with zero mutations
  it('122. Initial settlement rejects a null resource-account binding with zero mutations', async () => {
    const { auth } = await seedStandardTopology({
      taskId: 'tsk-122',
      transferId: 'xfer-122',
      asgnSuccId: 'asgn-122',
      attemptSuccId: 'att-122',
      asgnPredId: 'asgn-pred-122',
      attemptPredId: 'att-pred-122',
      acquireLease: true,
      acceptSuccessor: true,
    });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-122',
      expectedEpoch: 2,
    });

    // Set provider_account_id = NULL on resource
    db.prepare("UPDATE provider_resources SET provider_account_id = NULL WHERE id = 'res-1'").run();

    const settleRes = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-122',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: { ok: true },
    });

    expect(settleRes.success).toBe(false);
    expect(settleRes.error).toContain('PROVIDER_RESOURCE_MISMATCH');

    const checkAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(checkAuth.settled_at).toBeNull();
    expect(checkAuth.settlement_status).toBeNull();
  });

  // 123. Settlement replay rejects a null resource-account binding without further mutations
  it('123. Settlement replay rejects a null resource-account binding without further mutations', async () => {
    const { auth } = await seedStandardTopology({
      taskId: 'tsk-123',
      transferId: 'xfer-123',
      asgnSuccId: 'asgn-123',
      attemptSuccId: 'att-123',
      asgnPredId: 'asgn-pred-123',
      attemptPredId: 'att-pred-123',
      acquireLease: true,
      acceptSuccessor: true,
    });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-123',
      expectedEpoch: 2,
    });

    const settleRes = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-123',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: { ok: true },
    });
    expect(settleRes.success).toBe(true);

    // Corrupt resource provider_account_id to NULL
    db.prepare("UPDATE provider_resources SET provider_account_id = NULL WHERE id = 'res-1'").run();

    const replayRes = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-123',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: { ok: true },
    });

    expect(replayRes.success).toBe(false);
    expect(replayRes.error).toContain('SETTLEMENT_CONFLICT');
  });

  // 124. Settlement rejects account-to-provider corruption occurring after adapter-start claim
  it('124. Settlement rejects account-to-provider corruption occurring after adapter-start claim', async () => {
    const { auth } = await seedStandardTopology({
      taskId: 'tsk-124',
      transferId: 'xfer-124',
      asgnSuccId: 'asgn-124',
      attemptSuccId: 'att-124',
      asgnPredId: 'asgn-pred-124',
      attemptPredId: 'att-pred-124',
      acquireLease: true,
      acceptSuccessor: true,
    });
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-124',
      expectedEpoch: 2,
    });

    // Insert prov-b and mutate acc-1 to point to prov-b
    db.prepare(`
      INSERT INTO providers (id, name, adapter_type, enabled, created_at)
      VALUES ('prov-b-124', 'Provider B 124', 'LOCAL_CLI', 1, ?)
    `).run(new Date().toISOString());
    db.prepare("UPDATE provider_accounts SET provider_id = 'prov-b-124' WHERE id = 'acc-1'").run();

    const settleRes = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-124',
      outcome: 'RETURNED',
      status: 'COMPLETED',
      resultPayload: { ok: true },
    });

    expect(settleRes.success).toBe(false);
    expect(settleRes.error).toContain('PROVIDER_ACCOUNT_MISMATCH');

    const checkAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(checkAuth.settled_at).toBeNull();
  });

  // 125. Startup scanAndReconcile() detects an orphan lifecycle-v1 authorization, throws, and writes no ledger/event
  it('125. Startup scanAndReconcile() detects an orphan lifecycle-v1 authorization, throws, and writes no ledger/event', async () => {
    const { auth } = await seedStandardTopology({
      taskId: 'tsk-125',
      transferId: 'xfer-125',
      asgnSuccId: 'asgn-125',
      attemptSuccId: 'att-125',
      asgnPredId: 'asgn-pred-125',
      attemptPredId: 'att-pred-125',
    });

    // Delete handoff transfer so auth is an orphan
    db.prepare("DELETE FROM handoff_transfers WHERE id = 'xfer-125'").run();

    const eventsBefore = (db.prepare('SELECT count(*) as count FROM events').get() as any).count;
    const recoveryRowsBefore = (db.prepare('SELECT count(*) as count FROM execution_recovery_states').get() as any).count;

    expect(() => {
      scanner.scanAndReconcile();
    }).toThrow(new RegExp(`HandoffTransfer for successor authorization "${auth.id}" not found`));

    const eventsAfter = (db.prepare('SELECT count(*) as count FROM events').get() as any).count;
    const recoveryRowsAfter = (db.prepare('SELECT count(*) as count FROM execution_recovery_states').get() as any).count;

    expect(eventsAfter).toBe(eventsBefore);
    expect(recoveryRowsAfter).toBe(recoveryRowsBefore);
  });
});
