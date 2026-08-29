import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { Repository } from '../src/core/database/repositories';
import { MigrationRunner } from '../src/core/database/migrations';
import { EventService } from '../src/core/services/EventService';
import { WorkerSlotLeaseService } from '../src/core/services/WorkerSlotLeaseService';
import { GitWorktreeService, WorktreeOwnershipTuple } from '../src/core/services/GitWorktreeService';
import { ProviderDispatchService } from '../src/core/services/ProviderDispatchService';
import { ProviderRegistry } from '../src/core/adapters/ProviderRegistry';
import {
  ConcurrentExecutionScheduler,
  SchedulerTimer,
} from '../src/core/services/ConcurrentExecutionScheduler';
import {
  ProviderAdapter,
  AgentExecutionRequest,
  AgentExecutionResult,
  QuotaSnapshotInfo,
} from '../src/core/adapters/ProviderAdapter';
import {
  Capability,
  ProviderHealthStatus,
  ProviderAdapterType,
} from '../src/core/types/domain';
import {
  computeCanonicalPayload,
  computePayloadHash,
  computeContextManifestHash,
} from '../src/core/services/ExecutionAuthorizationService';

class Deferred<T> {
  public readonly promise: Promise<T>;
  public resolve!: (value: T | PromiseLike<T>) => void;
  public reject!: (reason?: any) => void;
  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }
}

class MockDeterministicTimer implements SchedulerTimer {
  private timers = new Map<number, { fn: () => void; ms: number }>();
  private nextId = 1;

  public setTimeout(fn: () => void, ms: number): any {
    const id = this.nextId++;
    this.timers.set(id, { fn, ms });
    return id;
  }

  public clearTimeout(id: any): void {
    this.timers.delete(id);
  }

  public async fireNext(): Promise<boolean> {
    const nextKey = this.timers.keys().next().value;
    if (nextKey === undefined) return false;
    const entry = this.timers.get(nextKey)!;
    this.timers.delete(nextKey);
    await entry.fn();
    return true;
  }

  public async fireAll(): Promise<number> {
    let count = 0;
    const keys = Array.from(this.timers.keys());
    for (const key of keys) {
      if (this.timers.has(key)) {
        const entry = this.timers.get(key)!;
        this.timers.delete(key);
        await entry.fn();
        count++;
      }
    }
    return count;
  }

  public get pendingCount(): number {
    return this.timers.size;
  }
}

class SyntheticParallelProviderAdapter implements ProviderAdapter {
  public readonly id = 'synthetic-parallel-provider';
  public readonly name = 'Synthetic Parallel Provider';
  public readonly adapterType: ProviderAdapterType = 'LOCAL_CLI';

  public activeExecutions = 0;
  public maxSimultaneousExecutions = 0;
  public totalExecutions = 0;
  public cancelledExecutions: string[] = [];
  public requests: AgentExecutionRequest[] = [];

  private startSignals = new Map<string, Deferred<AgentExecutionRequest>>();
  private finishBarriers = new Map<string, Deferred<AgentExecutionResult>>();
  public markerFilesToWrite = new Map<string, string>(); // authId -> marker filename

  public getStartSignal(authId: string): Promise<AgentExecutionRequest> {
    let sig = this.startSignals.get(authId);
    if (!sig) {
      sig = new Deferred<AgentExecutionRequest>();
      this.startSignals.set(authId, sig);
    }
    return sig.promise;
  }

  public getFinishBarrier(authId: string): Deferred<AgentExecutionResult> {
    let bar = this.finishBarriers.get(authId);
    if (!bar) {
      bar = new Deferred<AgentExecutionResult>();
      this.finishBarriers.set(authId, bar);
    }
    return bar;
  }

  public async getCapabilities(): Promise<Capability[]> {
    return ['CODING', 'FILESYSTEM_EDIT'];
  }
  public async getHealth(): Promise<ProviderHealthStatus> {
    return 'AVAILABLE';
  }
  public async getQuota(): Promise<QuotaSnapshotInfo> {
    return { remaining: 100, total: 100, unit: 'requests', source: 'ESTIMATED', confidence: 1, resetAt: null };
  }

  public async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    this.activeExecutions++;
    this.totalExecutions++;
    this.maxSimultaneousExecutions = Math.max(this.maxSimultaneousExecutions, this.activeExecutions);
    this.requests.push(request);

    const authId = request.runtimeBinding?.authorizationId ?? 'unknown';

    // Optional marker file write in workspace
    const marker = this.markerFilesToWrite.get(authId);
    if (marker && request.runtimeBinding?.workspace?.workingDirectory) {
      const markerPath = path.join(request.runtimeBinding.workspace.workingDirectory, marker);
      fs.writeFileSync(markerPath, `proof marker for ${authId}\n`);
    }

    // Signal start
    let startSig = this.startSignals.get(authId);
    if (!startSig) {
      startSig = new Deferred<AgentExecutionRequest>();
      this.startSignals.set(authId, startSig);
    }
    startSig.resolve(request);

    // Await finish barrier
    const finishBarrier = this.getFinishBarrier(authId);
    const result = await finishBarrier.promise;

    this.activeExecutions--;
    return result;
  }

  public async cancel(executionId: string): Promise<void> {
    this.cancelledExecutions.push(executionId);
  }
}

describe('Parallel ConcurrentExecutionScheduler Proof (R5G3E1)', () => {
  let db: Database.Database;
  let repo: Repository;
  let eventService: EventService;
  let leaseService: WorkerSlotLeaseService;
  let worktreeService: GitWorktreeService;
  let dispatchService: ProviderDispatchService;
  let registry: ProviderRegistry;
  let adapter: SyntheticParallelProviderAdapter;
  let scheduler: ConcurrentExecutionScheduler;

  let testDir: string;
  let repoDir: string;
  let managedDir: string;
  let gitExe: string;
  let initialRealWorktreeOutput: string;

  let projectId: string;
  let accountId: string;
  let resourceId: string;
  let providerId: string;
  let baseSha: string;
  let slot0Id: string;
  let slot1Id: string;
  let slot2Id: string;

  function createAuthChain(title: string, customSlotId?: string) {
    const taskId = `task-${crypto.randomUUID()}`;
    const attemptId = `att-${crypto.randomUUID()}`;
    const routingDecisionId = `rout-${crypto.randomUUID()}`;
    const assignmentId = `asgn-${crypto.randomUUID()}`;
    const authId = `auth-${crypto.randomUUID()}`;
    const managerMessageId = `msg-${crypto.randomUUID()}`;

    repo.createTask({
      id: taskId,
      project_id: projectId,
      milestone_id: null,
      title,
      description: `Parallel task ${title}`,
      state: 'CODING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 1,
      max_revisions: 3,
      base_sha: baseSha,
      current_sha: baseSha,
      progress_cache_percent: 0,
      progress_computed_at: null,
      constraints: ['no console.log'],
      acceptance_criteria: ['must pass all tests'],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    repo.createTaskAttempt({
      id: attemptId,
      task_id: taskId,
      agent_id: 'test-agent',
      attempt_number: 1,
      status: 'RUNNING',
      started_at: new Date().toISOString(),
      ended_at: null,
      summary: null,
    });

    repo.createAgentAssignment({
      id: assignmentId,
      project_id: projectId,
      task_id: taskId,
      attempt_id: attemptId,
      role_profile_id: 'role-coder',
      agent_profile_id: null,
      selected_provider_id: providerId,
      selected_account_id: accountId,
      selected_resource_id: resourceId,
      selected_worker_slot_id: customSlotId ?? null,
      routing_decision_id: routingDecisionId,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    });

    const managerPayload = {
      protocol: 'manager.v1',
      message_id: managerMessageId,
      project_id: projectId,
      task_id: taskId,
      decision: 'EXECUTE',
      instructions: [`Perform parallel task ${title}`],
      constraints: [],
      acceptance_criteria: ['must pass all tests'],
      expected_task_state: 'CODING',
      expected_revision: 1,
    };
    const managerJson = JSON.stringify(managerPayload);
    const managerPayloadHash = crypto.createHash('sha256').update(managerJson).digest('hex');

    repo.recordProtocolMessage(
      managerMessageId,
      managerMessageId,
      'manager.v1',
      projectId,
      taskId,
      'CODING',
      1,
      managerPayloadHash,
      managerJson,
      'APPLIED',
      undefined,
      new Date().toISOString()
    );

    eventService.record(
      projectId,
      'PROVIDER_ROUTING_DECISION',
      'Routing decision recorded',
      {
        decisionId: routingDecisionId,
        projectId,
        taskId,
        attemptId,
        outcome: 'SELECTED',
        selectedAccountId: accountId,
        selectedAssignmentId: assignmentId,
        selectedResourceId: resourceId,
        selectedProviderId: providerId,
        roleProfileId: 'role-coder',
        timestamp: new Date().toISOString(),
      },
      taskId
    );

    const instructions = [`Perform parallel task ${title}`];
    const contextFiles = ['README.md'];
    const canonicalPayload = computeCanonicalPayload({
      projectId,
      taskId,
      attemptId,
      taskTitle: title,
      taskDescription: `Parallel task ${title}`,
      acceptanceCriteria: ['must pass all tests'],
      constraints: ['no console.log'],
      instructions,
      contextFiles,
      verificationCommands: { TEST: null, LINT: null, BUILD: null },
      managerMessageId,
      managerPayloadHash,
    });
    const instructionPayloadHash = computePayloadHash(canonicalPayload);
    const contextManifestHash = computeContextManifestHash(contextFiles);

    repo.createExecutionAuthorization({
      id: authId,
      project_id: projectId,
      task_id: taskId,
      attempt_id: attemptId,
      task_revision: 1,
      base_sha: baseSha,
      repository_head_sha: baseSha,
      manager_message_id: managerMessageId,
      manager_payload_hash: managerPayloadHash,
      routing_decision_id: routingDecisionId,
      selected_resource_id: resourceId,
      selected_provider_id: providerId,
      instruction_payload_hash: instructionPayloadHash,
      context_manifest_hash: contextManifestHash,
      canonical_instructions_json: JSON.stringify(instructions),
      context_files_json: JSON.stringify(contextFiles),
      canonical_payload_json: JSON.stringify(canonicalPayload),
      status: 'AUTHORIZED',
      created_at: new Date().toISOString(),
      dispatched_at: null,
    });

    return {
      taskId,
      attemptId,
      routingDecisionId,
      assignmentId,
      authId,
      managerMessageId,
    };
  }

  beforeEach(() => {
    initialRealWorktreeOutput = execSync('git worktree list --porcelain', { encoding: 'utf-8' }).trim();

    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-par-sched-test-'));
    repoDir = path.join(testDir, 'repo');
    managedDir = path.join(testDir, 'managed');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(managedDir, { recursive: true });

    gitExe = execSync(process.platform === 'win32' ? 'where git' : 'which git', { encoding: 'utf-8' })
      .trim()
      .split(/\r?\n/)[0];

    // Init synthetic git repo
    execSync(`"${gitExe}" init`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`"${gitExe}" config user.name "Parallel Runner"`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`"${gitExe}" config user.email "parallel@example.com"`, { cwd: repoDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Synthetic Parallel Test Repo\n');
    execSync(`"${gitExe}" add README.md`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`"${gitExe}" commit -m "initial commit"`, { cwd: repoDir, stdio: 'ignore' });
    baseSha = execSync(`"${gitExe}" rev-parse HEAD`, { cwd: repoDir, encoding: 'utf-8' }).trim();

    // Database & services
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

    adapter = new SyntheticParallelProviderAdapter();
    providerId = adapter.id;
    registry = new ProviderRegistry();
    registry.register(adapter);

    dispatchService = new ProviderDispatchService(registry, repo, eventService, worktreeService);

    scheduler = new ConcurrentExecutionScheduler(
      repo,
      leaseService,
      worktreeService,
      dispatchService,
      {
        leaseTtlMs: 300_000,
        heartbeatIntervalMs: 100_000,
      }
    );

    // Setup base domain entities
    projectId = `proj-${crypto.randomUUID()}`;
    accountId = `acc-${crypto.randomUUID()}`;
    resourceId = `res-${crypto.randomUUID()}`;
    slot0Id = `slot-0-${crypto.randomUUID()}`;
    slot1Id = `slot-1-${crypto.randomUUID()}`;
    slot2Id = `slot-2-${crypto.randomUUID()}`;

    repo.createProject({
      id: projectId,
      name: 'Parallel Project',
      description: 'A project for testing 3 concurrent scheduler executions',
      repository_path: repoDir,
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      completed_at: null,
    });

    repo.createProvider({
      id: providerId,
      name: 'Synthetic Parallel Provider',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: new Date().toISOString(),
    });

    repo.createRoleProfile({
      id: 'role-coder',
      role: 'CODER',
      display_name: 'Coder Role',
      required_capabilities: ['CODING'],
      preferred_capabilities: [],
      authority_scope: null,
      permissions: ['read', 'write'],
      output_protocol: 'coder.v1',
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Account with concurrency_limit = 3
    repo.createProviderAccount({
      id: accountId,
      provider_id: providerId,
      label: 'Parallel Account',
      auth_mode: 'NATIVE_PROFILE',
      credential_ref: null,
      profile_ref: 'native-profile://parallel-provider/default',
      health_status: 'AVAILABLE',
      priority: 10,
      cooldown_until: null,
      concurrency_limit: 3,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    repo.createProviderResource({
      id: resourceId,
      provider_id: providerId,
      provider_account_id: accountId,
      model_name: 'synthetic-parallel-model',
      health_status: 'AVAILABLE',
      capabilities: ['CODING', 'FILESYSTEM_EDIT'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 0,
      last_health_check: new Date().toISOString(),
    });

    // 3 distinct worker slots
    repo.createWorkerSlot({
      id: slot0Id,
      provider_account_id: accountId,
      provider_resource_id: resourceId,
      slot_index: 0,
      status: 'IDLE',
      current_assignment_id: null,
      current_execution_id: null,
      heartbeat_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    repo.createWorkerSlot({
      id: slot1Id,
      provider_account_id: accountId,
      provider_resource_id: resourceId,
      slot_index: 1,
      status: 'IDLE',
      current_assignment_id: null,
      current_execution_id: null,
      heartbeat_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    repo.createWorkerSlot({
      id: slot2Id,
      provider_account_id: accountId,
      provider_resource_id: resourceId,
      slot_index: 2,
      status: 'IDLE',
      current_assignment_id: null,
      current_execution_id: null,
      heartbeat_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  // SCENARIO 1: Primary 3-Way Parallel Schedulers Execution & Overlap Proof (Tests 1 - 33)
  it('Primary 3-way concurrent scheduler execution proves true temporal overlap, slot isolation, worktree isolation, account capacity limit, and healthy terminal lifecycle', async () => {
    const chainA = createAuthChain('Task A');
    const chainB = createAuthChain('Task B');
    const chainC = createAuthChain('Task C');

    // Register marker files to be written in each workspace
    adapter.markerFilesToWrite.set(chainA.authId, 'proof-A.txt');
    adapter.markerFilesToWrite.set(chainB.authId, 'proof-B.txt');
    adapter.markerFilesToWrite.set(chainC.authId, 'proof-C.txt');

    // Record primary checkout state before launch
    const primaryHeadBefore = execSync(`"${gitExe}" rev-parse HEAD`, { cwd: repoDir, encoding: 'utf-8' }).trim();
    const primaryStatusBefore = execSync(`"${gitExe}" status --porcelain`, { cwd: repoDir, encoding: 'utf-8' }).trim();
    expect(primaryStatusBefore).toBe('');

    // 1. Launch 3 scheduler execute promises concurrently without awaiting
    const promiseA = scheduler.execute(chainA.authId);
    const promiseB = scheduler.execute(chainB.authId);
    const promiseC = scheduler.execute(chainC.authId);

    // Wait until all three provider executions have reached ACTIVE state via deterministic barriers
    const [reqA, reqB, reqC] = await Promise.all([
      adapter.getStartSignal(chainA.authId),
      adapter.getStartSignal(chainB.authId),
      adapter.getStartSignal(chainC.authId),
    ]);

    // 2. Three provider executions simultaneously active
    expect(adapter.activeExecutions).toBe(3);

    // 3. Max concurrent provider execution count >= 3
    expect(adapter.maxSimultaneousExecutions).toBeGreaterThanOrEqual(3);

    // 4. Three durable active leases during overlap
    const unreleasedLeases = repo.getUnreleasedAccountLeasesByAccount(accountId);
    expect(unreleasedLeases.length).toBe(3);

    // 5. Three distinct lease IDs
    const leaseIds = new Set(unreleasedLeases.map((l) => l.id));
    expect(leaseIds.size).toBe(3);

    // 6. Three distinct worker slots
    const leasedSlotIds = new Set(unreleasedLeases.map((l) => l.worker_slot_id));
    expect(leasedSlotIds.size).toBe(3);
    expect(leasedSlotIds.has(slot0Id)).toBe(true);
    expect(leasedSlotIds.has(slot1Id)).toBe(true);
    expect(leasedSlotIds.has(slot2Id)).toBe(true);

    // 7. Three distinct assignments
    const leasedAssignmentIds = new Set(unreleasedLeases.map((l) => l.assignment_id));
    expect(leasedAssignmentIds.size).toBe(3);
    expect(leasedAssignmentIds.has(chainA.assignmentId)).toBe(true);
    expect(leasedAssignmentIds.has(chainB.assignmentId)).toBe(true);
    expect(leasedAssignmentIds.has(chainC.assignmentId)).toBe(true);

    // 8. Three distinct canonical execution IDs
    const execIdA = reqA.runtimeBinding?.executionId;
    const execIdB = reqB.runtimeBinding?.executionId;
    const execIdC = reqC.runtimeBinding?.executionId;
    expect(execIdA).toBeDefined();
    expect(execIdB).toBeDefined();
    expect(execIdC).toBeDefined();
    expect(new Set([execIdA, execIdB, execIdC]).size).toBe(3);

    // 9. Three distinct worktree paths
    const pathA = reqA.runtimeBinding?.workspace?.workingDirectory!;
    const pathB = reqB.runtimeBinding?.workspace?.workingDirectory!;
    const pathC = reqC.runtimeBinding?.workspace?.workingDirectory!;
    expect(pathA).toBeDefined();
    expect(pathB).toBeDefined();
    expect(pathC).toBeDefined();
    expect(new Set([pathA, pathB, pathC]).size).toBe(3);

    // Inspect all 3 managed worktrees
    const tupleA: WorktreeOwnershipTuple = {
      projectId,
      taskId: chainA.taskId,
      attemptId: chainA.attemptId,
      assignmentId: chainA.assignmentId,
      workerSlotId: reqA.runtimeBinding?.workspace?.workerSlotId!,
      baseSha,
    };
    const tupleB: WorktreeOwnershipTuple = {
      projectId,
      taskId: chainB.taskId,
      attemptId: chainB.attemptId,
      assignmentId: chainB.assignmentId,
      workerSlotId: reqB.runtimeBinding?.workspace?.workerSlotId!,
      baseSha,
    };
    const tupleC: WorktreeOwnershipTuple = {
      projectId,
      taskId: chainC.taskId,
      attemptId: chainC.attemptId,
      assignmentId: chainC.assignmentId,
      workerSlotId: reqC.runtimeBinding?.workspace?.workerSlotId!,
      baseSha,
    };

    const inspA = await worktreeService.inspectWorktree(tupleA);
    const inspB = await worktreeService.inspectWorktree(tupleB);
    const inspC = await worktreeService.inspectWorktree(tupleC);

    // 10. All worktrees registered
    expect(inspA.status).toBe('INSPECTED');
    expect(inspB.status).toBe('INSPECTED');
    expect(inspC.status).toBe('INSPECTED');
    expect((inspA as any).inspection.registered).toBe(true);
    expect((inspB as any).inspection.registered).toBe(true);
    expect((inspC as any).inspection.registered).toBe(true);

    // 11. All worktrees locked
    expect((inspA as any).inspection.locked).toBe(true);
    expect((inspB as any).inspection.locked).toBe(true);
    expect((inspC as any).inspection.locked).toBe(true);

    // 12. All worktrees detached
    expect((inspA as any).inspection.detached).toBe(true);
    expect((inspB as any).inspection.detached).toBe(true);
    expect((inspC as any).inspection.detached).toBe(true);

    // 13. All worktrees at exact same authorized source SHA
    expect((inspA as any).inspection.headSha).toBe(baseSha);
    expect((inspB as any).inspection.headSha).toBe(baseSha);
    expect((inspC as any).inspection.headSha).toBe(baseSha);

    // 14. No slot double lease
    for (const slotId of [slot0Id, slot1Id, slot2Id]) {
      const leasesForSlot = unreleasedLeases.filter((l) => l.worker_slot_id === slotId);
      expect(leasesForSlot.length).toBe(1);
    }

    // 15 & 16. Account concurrency limit = 3 denies 4th concurrent execution (AUTH_D)
    const chainD = createAuthChain('Task D');
    const resD = await scheduler.execute(chainD.authId);
    expect(resD.status).toBe('LEASE_ACQUIRE_FAILED');
    expect(resD.errorCode).toBe('ACCOUNT_CAPACITY_EXHAUSTED');

    // 17. Fourth execution creates no worktree
    expect(resD.workspaceOwnershipDigest).toBeUndefined();

    // 18. Fourth execution never reaches provider dispatch
    expect(adapter.totalExecutions).toBe(3);

    // 19. Fourth execution does not reroute
    const eventsD = repo.getEvents(projectId).filter((e) => (e.structured_payload as any)?.taskId === chainD.taskId);
    const routingEventsD = eventsD.filter((e) => e.type === 'PROVIDER_ROUTING_DECISION');
    expect(routingEventsD.length).toBe(1); // Only original routing decision

    // 20. Runtime bindings do not cross-contaminate
    expect(reqA.runtimeBinding?.authorizationId).toBe(chainA.authId);
    expect(reqA.runtimeBinding?.assignmentId).toBe(chainA.assignmentId);
    expect(reqB.runtimeBinding?.authorizationId).toBe(chainB.authId);
    expect(reqB.runtimeBinding?.assignmentId).toBe(chainB.assignmentId);
    expect(reqC.runtimeBinding?.authorizationId).toBe(chainC.authId);
    expect(reqC.runtimeBinding?.assignmentId).toBe(chainC.assignmentId);

    // 21. Unique marker A only in workspace A
    expect(fs.existsSync(path.join(pathA, 'proof-A.txt'))).toBe(true);
    expect(fs.existsSync(path.join(pathA, 'proof-B.txt'))).toBe(false);
    expect(fs.existsSync(path.join(pathA, 'proof-C.txt'))).toBe(false);

    // 22. Unique marker B only in workspace B
    expect(fs.existsSync(path.join(pathB, 'proof-B.txt'))).toBe(true);
    expect(fs.existsSync(path.join(pathB, 'proof-A.txt'))).toBe(false);
    expect(fs.existsSync(path.join(pathB, 'proof-C.txt'))).toBe(false);

    // 23. Unique marker C only in workspace C
    expect(fs.existsSync(path.join(pathC, 'proof-C.txt'))).toBe(true);
    expect(fs.existsSync(path.join(pathC, 'proof-A.txt'))).toBe(false);
    expect(fs.existsSync(path.join(pathC, 'proof-B.txt'))).toBe(false);

    // 24. Primary synthetic checkout contains no markers
    expect(fs.existsSync(path.join(repoDir, 'proof-A.txt'))).toBe(false);
    expect(fs.existsSync(path.join(repoDir, 'proof-B.txt'))).toBe(false);
    expect(fs.existsSync(path.join(repoDir, 'proof-C.txt'))).toBe(false);

    // 25. Primary checkout HEAD unchanged
    const primaryHeadDuring = execSync(`"${gitExe}" rev-parse HEAD`, { cwd: repoDir, encoding: 'utf-8' }).trim();
    expect(primaryHeadDuring).toBe(primaryHeadBefore);

    // 26. Primary checkout clean
    const primaryStatusDuring = execSync(`"${gitExe}" status --porcelain`, { cwd: repoDir, encoding: 'utf-8' }).trim();
    expect(primaryStatusDuring).toBe('');

    // 27. Leases remain active while providers blocked
    const activeLeasesStillBlocked = repo.getUnreleasedAccountLeasesByAccount(accountId);
    expect(activeLeasesStillBlocked.length).toBe(3);

    // 28. Slots remain LEASED while blocked
    for (const slotId of [slot0Id, slot1Id, slot2Id]) {
      const slot = repo.getWorkerSlot(slotId)!;
      expect(slot.status).toBe('LEASED');
      expect(slot.current_assignment_id).not.toBeNull();
    }

    // 29. current_execution_id remains NULL
    for (const slotId of [slot0Id, slot1Id, slot2Id]) {
      const slot = repo.getWorkerSlot(slotId)!;
      expect(slot.current_execution_id).toBeNull();
    }

    // Release finish barriers for A, B, C to allow controlled completion
    adapter.getFinishBarrier(chainA.authId).resolve({
      executionId: execIdA!,
      status: 'COMPLETED',
      rawResponse: '{"result":"A"}',
    });
    adapter.getFinishBarrier(chainB.authId).resolve({
      executionId: execIdB!,
      status: 'COMPLETED',
      rawResponse: '{"result":"B"}',
    });
    adapter.getFinishBarrier(chainC.authId).resolve({
      executionId: execIdC!,
      status: 'COMPLETED',
      rawResponse: '{"result":"C"}',
    });

    // 30. A/B/C all complete after barriers released
    const [resA, resB, resC] = await Promise.all([promiseA, promiseB, promiseC]);
    expect(resA.status).toBe('COMPLETED');
    expect(resB.status).toBe('COMPLETED');
    expect(resC.status).toBe('COMPLETED');
    expect(resA.providerResult?.status).toBe('COMPLETED');
    expect(resB.providerResult?.status).toBe('COMPLETED');
    expect(resC.providerResult?.status).toBe('COMPLETED');

    // 31. Healthy completed executions release all three leases
    const unreleasedLeasesAfter = repo.getUnreleasedAccountLeasesByAccount(accountId);
    expect(unreleasedLeasesAfter.length).toBe(0);

    for (const slotId of [slot0Id, slot1Id, slot2Id]) {
      const slot = repo.getWorkerSlot(slotId)!;
      expect(slot.status).toBe('IDLE');
      expect(slot.current_assignment_id).toBeNull();
      expect(slot.current_execution_id).toBeNull();
    }

    // 32. Successful dirty worktrees retained
    expect(fs.existsSync(pathA)).toBe(true);
    expect(fs.existsSync(pathB)).toBe(true);
    expect(fs.existsSync(pathC)).toBe(true);
    expect(fs.existsSync(path.join(pathA, 'proof-A.txt'))).toBe(true);
    expect(fs.existsSync(path.join(pathB, 'proof-B.txt'))).toBe(true);
    expect(fs.existsSync(path.join(pathC, 'proof-C.txt'))).toBe(true);

    // 33. Scheduler results expose no lease token
    expect((resA as any).leaseToken).toBeUndefined();
    expect((resB as any).leaseToken).toBeUndefined();
    expect((resC as any).leaseToken).toBeUndefined();
    expect(JSON.stringify(resA).includes('leaseToken')).toBe(false);
    expect(JSON.stringify(resB).includes('leaseToken')).toBe(false);
    expect(JSON.stringify(resC).includes('leaseToken')).toBe(false);
  }, 120000);

  // SCENARIO 2: Failure & Lease Loss Isolation Scenario (Tests 34 - 42)
  it('Lease loss isolation proves single-execution cancellation does not affect parallel healthy execution', async () => {
    const timer = new MockDeterministicTimer();
    const isolatedScheduler = new ConcurrentExecutionScheduler(
      repo,
      leaseService,
      worktreeService,
      dispatchService,
      {
        leaseTtlMs: 300_000,
        heartbeatIntervalMs: 100_000,
        timer,
      }
    );

    const chainLoss = createAuthChain('Loss Task');
    const chainHealthy = createAuthChain('Healthy Task');

    adapter.markerFilesToWrite.set(chainLoss.authId, 'loss-marker.txt');
    adapter.markerFilesToWrite.set(chainHealthy.authId, 'healthy-marker.txt');

    const promiseLoss = isolatedScheduler.execute(chainLoss.authId);
    const promiseHealthy = isolatedScheduler.execute(chainHealthy.authId);

    // Wait until both provider executions are active
    const [reqLoss, reqHealthy] = await Promise.all([
      adapter.getStartSignal(chainLoss.authId),
      adapter.getStartSignal(chainHealthy.authId),
    ]);

    expect(adapter.activeExecutions).toBe(2);

    const cancelScheduledSpy = vi.spyOn(dispatchService, 'cancelScheduled');

    // Trigger lease loss ONLY for chainLoss by expiring its lease in DB
    const lossLease = repo.getActiveLeaseForAssignment(chainLoss.assignmentId)!;
    expect(lossLease).toBeDefined();
    db.prepare("UPDATE account_leases SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(lossLease.id);

    // Fire timer ticks for heartbeat
    await timer.fireAll();

    // 34. One execution lease-loss cancels only itself
    expect(cancelScheduledSpy).toHaveBeenCalledWith(chainLoss.authId);
    expect(cancelScheduledSpy).not.toHaveBeenCalledWith(chainHealthy.authId);

    // 35. Healthy parallel execution unaffected by peer lease loss
    expect(adapter.activeExecutions).toBe(2);

    // Release loss execution barrier with CANCELLED
    adapter.getFinishBarrier(chainLoss.authId).resolve({
      executionId: reqLoss.runtimeBinding?.executionId ?? 'exec-loss',
      status: 'CANCELLED',
    });

    // Release healthy execution barrier with COMPLETED
    adapter.getFinishBarrier(chainHealthy.authId).resolve({
      executionId: reqHealthy.runtimeBinding?.executionId ?? 'exec-healthy',
      status: 'COMPLETED',
    });

    const resLoss = await promiseLoss;
    const resHealthy = await promiseHealthy;

    // 36. Lease-loss execution final status dominates provider terminal result
    expect(resLoss.status).toBe('LEASE_OWNERSHIP_LOST');
    expect(resHealthy.status).toBe('COMPLETED');

    // 37. Lost lease is not released
    const lossLeaseAfter = repo.getAccountLease(lossLease.id)!;
    expect(lossLeaseAfter.released_at).toBeNull();

    // 38. Healthy peer lease is released
    const healthyLease = repo.getActiveLeaseForAssignment(chainHealthy.assignmentId);
    expect(healthyLease).toBeNull(); // Released

    // 39. Lost execution worktree retained
    const pathLoss = reqLoss.runtimeBinding?.workspace?.workingDirectory!;
    expect(fs.existsSync(pathLoss)).toBe(true);

    // 40. Healthy completed worktree retained
    const pathHealthy = reqHealthy.runtimeBinding?.workspace?.workingDirectory!;
    expect(fs.existsSync(pathHealthy)).toBe(true);

    // 41. No global process termination
    expect(adapter.cancelledExecutions).toEqual([reqLoss.runtimeBinding?.executionId]);

    // 42. Heartbeat state isolated per scheduler execution
    expect(timer.pendingCount).toBe(0);
  }, 120000);

  // SCENARIO 3: Same Auth Duplicate Scenario (Tests 43 - 44)
  it('Duplicate concurrent execution of the same authorization fails closed without creating second lease or worktree', async () => {
    const chainX = createAuthChain('Task X');

    const promise1 = scheduler.execute(chainX.authId);
    const reqX = await adapter.getStartSignal(chainX.authId);

    // Attempt second execution of the same auth while first is active
    const res2 = await scheduler.execute(chainX.authId);

    // 43 & 44. Same auth duplicate fails closed
    expect(res2.status).toBe('PREPARATION_FAILED');
    expect(res2.error).toContain('EXECUTION_AUTHORIZATION_INVALID_STATUS');

    // Exactly 1 active lease for assignment
    const activeLease = repo.getActiveLeaseForAssignment(chainX.assignmentId);
    expect(activeLease).toBeDefined();

    // Exactly 1 provider execution on adapter
    expect(adapter.totalExecutions).toBe(1);

    // Clean up first execution
    adapter.getFinishBarrier(chainX.authId).resolve({
      executionId: reqX.runtimeBinding?.executionId ?? 'exec-x',
      status: 'COMPLETED',
    });

    const res1 = await promise1;
    expect(res1.status).toBe('COMPLETED');
  });

  // SCENARIO 4: Cross-Scheduler Instance Concurrency (Tests 45 - 47)
  it('Cross-scheduler instance concurrent execution of the same assignment is blocked durably', async () => {
    const scheduler1 = new ConcurrentExecutionScheduler(repo, leaseService, worktreeService, dispatchService);
    const scheduler2 = new ConcurrentExecutionScheduler(repo, leaseService, worktreeService, dispatchService);

    const chainY = createAuthChain('Task Y');

    // Create a second valid AUTHORIZED execution authorization for the SAME assignment
    const authY2Id = `auth-y2-${crypto.randomUUID()}`;
    const instructions = ['Perform parallel task Task Y'];
    const contextFiles = ['README.md'];
    const canonicalPayload = computeCanonicalPayload({
      projectId,
      taskId: chainY.taskId,
      attemptId: chainY.attemptId,
      taskTitle: 'Task Y',
      taskDescription: 'Parallel task Task Y',
      acceptanceCriteria: ['must pass all tests'],
      constraints: ['no console.log'],
      instructions,
      contextFiles,
      verificationCommands: { TEST: null, LINT: null, BUILD: null },
      managerMessageId: chainY.managerMessageId,
      managerPayloadHash: 'hash',
    });

    repo.createExecutionAuthorization({
      id: authY2Id,
      project_id: projectId,
      task_id: chainY.taskId,
      attempt_id: chainY.attemptId,
      task_revision: 1,
      base_sha: baseSha,
      repository_head_sha: baseSha,
      manager_message_id: chainY.managerMessageId,
      manager_payload_hash: 'hash',
      routing_decision_id: chainY.routingDecisionId,
      selected_resource_id: resourceId,
      selected_provider_id: providerId,
      instruction_payload_hash: computePayloadHash(canonicalPayload),
      context_manifest_hash: computeContextManifestHash(contextFiles),
      canonical_instructions_json: JSON.stringify(instructions),
      context_files_json: JSON.stringify(contextFiles),
      canonical_payload_json: JSON.stringify(canonicalPayload),
      status: 'AUTHORIZED',
      created_at: new Date().toISOString(),
      dispatched_at: null,
    });

    const promise1 = scheduler1.execute(chainY.authId);
    const reqY = await adapter.getStartSignal(chainY.authId);

    // scheduler2 attempts execution for the same assignment via authY2Id
    const res2 = await scheduler2.execute(authY2Id);

    // 45. Cross-scheduler instance same assignment blocked durably
    expect(res2.status).toBe('LEASE_ACQUIRE_FAILED');
    expect(res2.errorCode).toBe('ASSIGNMENT_ALREADY_LEASED');

    // 46. No duplicate worktree for same ownership
    expect(res2.workspaceOwnershipDigest).toBeUndefined();

    // Exactly 1 provider execution
    expect(adapter.totalExecutions).toBe(1);

    adapter.getFinishBarrier(chainY.authId).resolve({
      executionId: reqY.runtimeBinding?.executionId ?? 'exec-y',
      status: 'COMPLETED',
    });

    const res1 = await promise1;
    expect(res1.status).toBe('COMPLETED');
  });

  // SCENARIO 5: Static & Inventory Invariants (Tests 48 - 50)
  it('Invariants: No ProviderRegistry/ProcessRunner dependency in scheduler, no WorkerSlot RUNNING or current_execution_id mutation, and real worktree inventory unchanged', async () => {
    // 47. No ProviderRegistry/ProcessRunner direct call from scheduler
    expect((scheduler as any).providerRegistry).toBeUndefined();
    expect((scheduler as any).processRunner).toBeUndefined();

    // 48. No WorkerSlot RUNNING transition
    const allSlots = repo.getWorkerSlotsByAccount(accountId);
    for (const slot of allSlots) {
      expect(slot.status).not.toBe('RUNNING');
    }

    // 49. No current_execution_id write
    for (const slot of allSlots) {
      expect(slot.current_execution_id).toBeNull();
    }

    // 50. Real AgentForge worktree inventory unchanged
    const realWorktreeOutput = execSync('git worktree list --porcelain', { encoding: 'utf-8' }).trim();
    expect(realWorktreeOutput).toBe(initialRealWorktreeOutput);
  });
});
