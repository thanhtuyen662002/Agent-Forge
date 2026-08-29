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

  async function seedStandardTopology(options?: { transferId?: string; taskId?: string; attemptPredId?: string; attemptSuccId?: string; asgnPredId?: string; asgnSuccId?: string }) {
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
        VALUES ('acc-1', 'prov-a', 'Account 1', 'NATIVE_PROFILE', 1, 10, 'AVAILABLE', 2, ?, ?)
      `).run(nowIso, nowIso);
    }

    const existingRes = repo.getProviderResource('res-1');
    if (!existingRes) {
      db.prepare(`
        INSERT INTO provider_resources (id, provider_id, provider_account_id, model_name, health_status, capabilities_json, enabled, total_quota, remaining_quota, quota_unit, quota_source, quota_confidence, last_health_check)
        VALUES ('res-1', 'prov-a', 'acc-1', 'alpha-model', 'AVAILABLE', '["CODING"]', 1, 1000, 1000, 'REQUESTS', 'PROVIDER_REPORTED', 1.0, ?)
      `).run(nowIso);
    }

    const existingSlot = repo.getWorkerSlot('slot-1');
    if (!existingSlot) {
      db.prepare(`
        INSERT INTO worker_slots (id, provider_account_id, provider_resource_id, slot_index, status, created_at, updated_at)
        VALUES ('slot-1', 'acc-1', 'res-1', 0, 'IDLE', ?, ?)
      `).run(nowIso, nowIso);
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
    const transfer = repo.getHandoffTransfer(transferId)!;

    return { auth, transfer };
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
    const { auth } = await seedStandardTopology();
    const leaseRes = leaseService.acquireForAssignment('asgn-succ', 60000) as SlotLeaseSuccess;
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

  // 12. Identical settlement replay is idempotent
  it('12. should handle identical settlement replay idempotently', async () => {
    const { auth } = await seedStandardTopology();
    const settle1 = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-1',
      outcome: 'RETURNED',
      resultPayload: { status: 'COMPLETED' },
    });
    expect(settle1.success).toBe(true);
    expect(settle1.alreadySettled).toBe(false);

    const settle2 = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-1',
      outcome: 'RETURNED',
      finishedAt: settle1.settledAt,
      resultPayload: { status: 'COMPLETED' },
    });
    expect(settle2.success).toBe(true);
    expect(settle2.alreadySettled).toBe(true);
  });

  // 13. Conflicting settlement is rejected
  it('13. should reject contradictory settlement attempt fail-closed', async () => {
    const { auth } = await seedStandardTopology();
    const settle1 = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-1',
      outcome: 'RETURNED',
      resultPayload: { status: 'COMPLETED' },
    });
    expect(settle1.success).toBe(true);

    const settle2 = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-1',
      outcome: 'THREW',
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

    // Claim dispatch but crash before adapter_started_at
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());

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
      startedAt: new Date().toISOString(),
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
      startedAt: new Date().toISOString(),
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
    repo.confirmExecutionTermination({
      authorizationId: auth.id,
      executionId: 'exec-1',
      terminationStatus: 'CONFIRMED_TERMINATED',
      terminationSource: 'PROVIDER_ADAPTER_TIMEOUT',
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
    repo.confirmExecutionTermination({
      authorizationId: auth.id,
      executionId: 'exec-1',
      terminationStatus: 'CONFIRMED_TERMINATED',
      terminationSource: 'OPERATOR_CANCELLED',
    });

    const report = scanner.scanAndReconcile();
    expect(report.adapterTerminatedTimeoutCount).toBe(1);
    expect(report.items[0].disposition).toBe('TERMINALIZED_CONFIRMED_CANCELLED');

    const transfer = repo.getHandoffTransfer('xfer-1')!;
    expect(transfer.status).toBe('CANCELLED');
  });

  // 22. Mismatched termination execution ID fails closed
  it('22. should reject termination confirmation if execution ID does not match', async () => {
    const { auth } = await seedStandardTopology();
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
    });
    expect(confirmRes.success).toBe(false);
    expect(confirmRes.error).toContain('EXECUTION_ID_MISMATCH');
  });

  // 23. Contradictory termination source fails closed
  it('23. should reject contradictory termination source when already confirmed', async () => {
    const { auth } = await seedStandardTopology();
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    repo.claimAdapterExecutionStart({
      authorizationId: auth.id,
      executionId: 'exec-1',
      expectedEpoch: 2,
    });
    repo.confirmExecutionTermination({
      authorizationId: auth.id,
      executionId: 'exec-1',
      terminationStatus: 'CONFIRMED_TERMINATED',
      terminationSource: 'TIMEOUT_A',
    });
    const res2 = repo.confirmExecutionTermination({
      authorizationId: auth.id,
      executionId: 'exec-1',
      terminationStatus: 'CONFIRMED_TERMINATED',
      terminationSource: 'TIMEOUT_B',
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

    // Durably settle authorization but simulate crash before transfer/attempt/assignment or lease cleanup
    db.prepare(`
      UPDATE execution_authorizations
      SET adapter_finished_at = datetime('now'),
          adapter_outcome = 'RETURNED',
          settled_at = datetime('now'),
          settlement_evidence_json = '{"status":"COMPLETED"}',
          settlement_evidence_hash = 'hash-complete'
      WHERE id = ?
    `).run(auth.id);

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
    // Settle authorization durably but simulate crash before release
    db.prepare(`
      UPDATE execution_authorizations
      SET adapter_started_at = datetime('now'),
          adapter_finished_at = datetime('now'),
          settled_at = datetime('now'),
          adapter_outcome = 'RETURNED',
          settlement_evidence_json = '{"status":"COMPLETED"}',
          settlement_evidence_hash = 'hash-complete'
      WHERE id = ?
    `).run(auth.id);

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

  // 31. Evidence-hash corruption is rejected
  it('31. should reject settlement conflict if evidence hash does not match', async () => {
    const { auth } = await seedStandardTopology();
    db.prepare(`
      UPDATE execution_authorizations
      SET settled_at = datetime('now'),
          adapter_outcome = 'RETURNED',
          settlement_evidence_hash = 'correct-hash'
      WHERE id = ?
    `).run(auth.id);

    const res = repo.settleExecutionResult({
      authorizationId: auth.id,
      executionId: 'exec-1',
      outcome: 'RETURNED',
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
    const res1 = await seedStandardTopology({ transferId: 'xfer-1', taskId: 'tsk-1', attemptPredId: 'att-pred-1', attemptSuccId: 'att-succ-1', asgnPredId: 'asgn-pred-1', asgnSuccId: 'asgn-succ-1' });
    const res2 = await seedStandardTopology({ transferId: 'xfer-2', taskId: 'tsk-2', attemptPredId: 'att-pred-2', attemptSuccId: 'att-succ-2', asgnPredId: 'asgn-pred-2', asgnSuccId: 'asgn-succ-2' });

    // Arm candidate 1
    db.prepare(`UPDATE execution_authorizations SET lifecycle_version = 1 WHERE id = ?`).run(res1.auth.id);

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
    const { auth } = await seedStandardTopology();
    const leaseRes = leaseService.acquireForAssignment('asgn-succ', 60000) as SlotLeaseSuccess;
    repo.acceptHandoffSuccessorExecution({
      authorizationId: auth.id,
      leaseId: leaseRes.lease.id,
      leaseToken: leaseRes.lease.lease_token,
      expectedSuccessorEpoch: 2,
    });

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
    const { auth } = await seedStandardTopology();
    const leaseRes = leaseService.acquireForAssignment('asgn-succ', 60000) as SlotLeaseSuccess;
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
});
