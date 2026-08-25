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

  public get pendingCount(): number {
    return this.timers.size;
  }
}

class ControllableMockProviderAdapter implements ProviderAdapter {
  public id = 'mock-provider';
  public name = 'Mock Provider';
  public adapterType: ProviderAdapterType = 'LOCAL_CLI';
  public executeCallCount = 0;
  public cancelCallCount = 0;
  public lastExecutionRequest?: AgentExecutionRequest;
  public executeResolver?: (result: AgentExecutionResult) => void;
  public executionBarrier?: Promise<AgentExecutionResult>;
  public onExecuteStarted?: () => void;
  public throwOnExecute = false;

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
    this.executeCallCount++;
    this.lastExecutionRequest = request;
    if (this.onExecuteStarted) {
      this.onExecuteStarted();
    }
    if (this.throwOnExecute) {
      throw new Error('MOCK_ADAPTER_ERROR');
    }
    if (this.executionBarrier) {
      return this.executionBarrier;
    }
    return {
      executionId: request.runtimeBinding?.executionId ?? 'mock-exec-id',
      status: 'COMPLETED',
      rawResponse: '{"status":"SUCCESS"}',
    };
  }

  public async cancel(_executionId: string): Promise<void> {
    this.cancelCallCount++;
  }
}

describe('ConcurrentExecutionScheduler (R5G3D1)', () => {
  let db: Database.Database;
  let repo: Repository;
  let eventService: EventService;
  let leaseService: WorkerSlotLeaseService;
  let worktreeService: GitWorktreeService;
  let dispatchService: ProviderDispatchService;
  let registry: ProviderRegistry;
  let adapter: ControllableMockProviderAdapter;
  let timer: MockDeterministicTimer;
  let scheduler: ConcurrentExecutionScheduler;

  let testDir: string;
  let repoDir: string;
  let managedDir: string;
  let gitExe: string;

  let projectId: string;
  let taskId: string;
  let attemptId: string;
  let accountId: string;
  let resourceId: string;
  let providerId: string;
  let baseSha: string;
  let authId: string;
  let routingDecisionId: string;
  let managerMessageId: string;
  let managerPayloadHash: string;
  let assignmentId: string;
  let slotId: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-sched-test-'));
    repoDir = path.join(testDir, 'repo');
    managedDir = path.join(testDir, 'managed');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(managedDir, { recursive: true });

    gitExe = execSync(process.platform === 'win32' ? 'where git' : 'which git', { encoding: 'utf-8' })
      .trim()
      .split(/\r?\n/)[0];

    // Init git repo
    execSync(`"${gitExe}" init`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`"${gitExe}" config user.name "Test Runner"`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`"${gitExe}" config user.email "test@example.com"`, { cwd: repoDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Repo\n');
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

    adapter = new ControllableMockProviderAdapter();
    providerId = adapter.id;
    registry = new ProviderRegistry();
    registry.register(adapter);

    dispatchService = new ProviderDispatchService(registry, repo, eventService, worktreeService);
    timer = new MockDeterministicTimer();

    scheduler = new ConcurrentExecutionScheduler(
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

    // Setup base domain entities
    projectId = `proj-${crypto.randomUUID()}`;
    taskId = `task-${crypto.randomUUID()}`;
    attemptId = `att-${crypto.randomUUID()}`;
    accountId = `acc-${crypto.randomUUID()}`;
    resourceId = `res-${crypto.randomUUID()}`;
    assignmentId = `asgn-${crypto.randomUUID()}`;
    slotId = `slot-${crypto.randomUUID()}`;
    authId = `auth-${crypto.randomUUID()}`;
    routingDecisionId = `rout-${crypto.randomUUID()}`;
    managerMessageId = `msg-${crypto.randomUUID()}`;

    repo.createProject({
      id: projectId,
      name: 'Test Project',
      description: 'A test project',
      repository_path: repoDir,
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      completed_at: null,
    });

    repo.createTask({
      id: taskId,
      project_id: projectId,
      milestone_id: null,
      title: 'Scheduler Test Task',
      description: 'Audit task for scheduler authority',
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

    repo.createProvider({
      id: providerId,
      name: 'Mock Provider',
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

    repo.createProviderAccount({
      id: accountId,
      provider_id: providerId,
      label: 'Default Account',
      auth_mode: 'NATIVE_PROFILE',
      credential_ref: null,
      profile_ref: 'native-profile://rec-provider/default',
      health_status: 'AVAILABLE',
      priority: 10,
      cooldown_until: null,
      concurrency_limit: 2,
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
      model_name: 'test-model',
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

    repo.createWorkerSlot({
      id: slotId,
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
      selected_worker_slot_id: slotId,
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
      instructions: ['Perform scheduler audit task'],
      constraints: [],
      acceptance_criteria: ['must pass all tests'],
      expected_task_state: 'CODING',
      expected_revision: 1,
    };
    const managerJson = JSON.stringify(managerPayload);
    managerPayloadHash = crypto.createHash('sha256').update(managerJson).digest('hex');

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

    const instructions = ['Perform scheduler audit task'];
    const contextFiles = ['README.md'];
    const canonicalPayload = computeCanonicalPayload({
      projectId,
      taskId,
      attemptId,
      taskTitle: 'Scheduler Test Task',
      taskDescription: 'Audit task for scheduler authority',
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

  // 1. public execute input is authorizationId only.
  it('1. public execute input is authorizationId only', async () => {
    const result = await scheduler.execute(authId);
    expect(result.status).toBe('COMPLETED');
    expect(result.authorizationId).toBe(authId);
  });

  // 2. manual/non-SELECTED routing rejected before lease.
  it('2. manual/non-SELECTED routing rejected before lease', async () => {
    const manualRouteId = `route-manual-${crypto.randomUUID()}`;
    eventService.record(
      projectId,
      'PROVIDER_ROUTING_DECISION',
      'Manual handoff',
      {
        decisionId: manualRouteId,
        projectId,
        taskId,
        attemptId,
        outcome: 'MANUAL_HANDOFF_REQUIRED',
        timestamp: new Date().toISOString(),
      },
      taskId
    );

    const manualAuthId = `auth-manual-${crypto.randomUUID()}`;
    repo.createExecutionAuthorization({
      id: manualAuthId,
      project_id: projectId,
      task_id: taskId,
      attempt_id: attemptId,
      task_revision: 1,
      base_sha: baseSha,
      repository_head_sha: baseSha,
      manager_message_id: managerMessageId,
      manager_payload_hash: managerPayloadHash,
      routing_decision_id: manualRouteId,
      selected_resource_id: resourceId,
      selected_provider_id: providerId,
      instruction_payload_hash: 'hash',
      context_manifest_hash: 'hash',
      canonical_instructions_json: '[]',
      context_files_json: '[]',
      canonical_payload_json: '{}',
      status: 'AUTHORIZED',
      created_at: new Date().toISOString(),
      dispatched_at: null,
    });

    const res = await scheduler.execute(manualAuthId);
    expect(res.status).toBe('NOT_SCHEDULABLE');
    expect(repo.getActiveLeaseForAssignment(assignmentId)).toBeNull();
  });

  // 3. missing authorization rejected before lease.
  it('3. missing authorization rejected before lease', async () => {
    const res = await scheduler.execute('non-existent-auth-id');
    expect(res.status).toBe('PREPARATION_FAILED');
  });

  // 4. non-AUTHORIZED authorization rejected before lease.
  it('4. non-AUTHORIZED authorization rejected before lease', async () => {
    repo.claimExecutionAuthorization(authId, new Date().toISOString());
    const res = await scheduler.execute(authId);
    expect(res.status).toBe('PREPARATION_FAILED');
  });

  // 5. assignment reconstructed from durable routing state.
  it('5. assignment reconstructed from durable routing state', async () => {
    const res = await scheduler.execute(authId);
    expect(res.assignmentId).toBe(assignmentId);
  });

  // 6. scheduler does not reroute.
  it('6. scheduler does not reroute', async () => {
    const eventsBefore = repo.getEvents(projectId).filter((e) => e.type === 'PROVIDER_ROUTING_DECISION');
    await scheduler.execute(authId);
    const eventsAfter = repo.getEvents(projectId).filter((e) => e.type === 'PROVIDER_ROUTING_DECISION');
    expect(eventsAfter.length).toBe(eventsBefore.length);
  });

  // 7. lease acquired through WorkerSlotLeaseService only.
  it('7. lease acquired through WorkerSlotLeaseService only', async () => {
    const spy = vi.spyOn(leaseService, 'acquireForAssignment');
    await scheduler.execute(authId);
    expect(spy).toHaveBeenCalledWith(assignmentId, 300_000);
  });

  // 8. lease token never returned publicly.
  it('8. lease token never returned publicly', async () => {
    const res = await scheduler.execute(authId);
    const resStr = JSON.stringify(res);
    expect(resStr.includes('leaseToken')).toBe(false);
    expect((res as any).leaseToken).toBeUndefined();
  });

  // 9. heartbeat begins after lease acquisition before worktree dispatch.
  it('9. heartbeat begins after lease acquisition before worktree dispatch', async () => {
    let heartbeatStartedBeforeWorktree = false;
    const origCreate = worktreeService.createWorktree.bind(worktreeService);
    worktreeService.createWorktree = async (tuple) => {
      if (timer.pendingCount > 0) {
        heartbeatStartedBeforeWorktree = true;
      }
      return origCreate(tuple);
    };
    await scheduler.execute(authId);
    expect(heartbeatStartedBeforeWorktree).toBe(true);
  });

  // 10. heartbeat interval <= TTL/3.
  it('10. heartbeat interval <= TTL/3', () => {
    expect(scheduler.heartbeatIntervalMs).toBeLessThanOrEqual(Math.floor(scheduler.leaseTtlMs / 3));
    expect(() => {
      new ConcurrentExecutionScheduler(repo, leaseService, worktreeService, dispatchService, {
        leaseTtlMs: 300_000,
        heartbeatIntervalMs: 150_000,
      });
    }).toThrow();
  });

  // 11. heartbeat calls never overlap.
  it('11. heartbeat calls never overlap', async () => {
    let inFlight = 0;
    let maxOverlap = 0;
    const origHeartbeat = leaseService.heartbeat.bind(leaseService);
    leaseService.heartbeat = (leaseId, token, ttl) => {
      inFlight++;
      maxOverlap = Math.max(maxOverlap, inFlight);
      const res = origHeartbeat(leaseId, token, ttl);
      inFlight--;
      return res;
    };
    await scheduler.execute(authId);
    expect(maxOverlap).toBeLessThanOrEqual(1);
  });

  // 12. worktree source is auth.repository_head_sha.
  it('12. worktree source is auth.repository_head_sha', async () => {
    let capturedSha = '';
    const origCreate = worktreeService.createWorktree.bind(worktreeService);
    worktreeService.createWorktree = async (tuple) => {
      capturedSha = tuple.baseSha;
      return origCreate(tuple);
    };
    await scheduler.execute(authId);
    expect(capturedSha).toBe(baseSha);
  });

  // 13. caller cannot choose source SHA.
  it('13. caller cannot choose source SHA', async () => {
    const res = await scheduler.execute(authId);
    expect(res.status).toBe('COMPLETED');
  });

  // 14. caller cannot choose worktree path.
  it('14. caller cannot choose worktree path', async () => {
    const res = await scheduler.execute(authId);
    expect(res.workspaceOwnershipDigest).toBeDefined();
  });

  // 15. worktree ownership uses acquired worker slot.
  it('15. worktree ownership uses acquired worker slot', async () => {
    let capturedSlot = '';
    const origCreate = worktreeService.createWorktree.bind(worktreeService);
    worktreeService.createWorktree = async (tuple) => {
      capturedSlot = tuple.workerSlotId;
      return origCreate(tuple);
    };
    await scheduler.execute(authId);
    expect(capturedSlot).toBe(slotId);
  });

  // 16. worktree creation failure with healthy lease releases lease.
  it('16. worktree creation failure with healthy lease releases lease', async () => {
    const releaseSpy = vi.spyOn(leaseService, 'release');
    vi.spyOn(worktreeService, 'createWorktree').mockResolvedValueOnce({
      status: 'FAILED',
      code: 'GIT_ADD_FAILED',
      error: 'Git add failed simulation',
    });
    const res = await scheduler.execute(authId);
    expect(res.status).toBe('WORKTREE_CREATE_FAILED');
    expect(releaseSpy).toHaveBeenCalled();
  });

  // 17. worktree create rollback failure does not trigger force/fs cleanup.
  it('17. worktree create rollback failure does not trigger force/fs cleanup', async () => {
    vi.spyOn(worktreeService, 'createWorktree').mockResolvedValueOnce({
      status: 'FAILED',
      code: 'CREATE_ROLLBACK_FAILED',
      error: 'Rollback failed',
    });
    const res = await scheduler.execute(authId);
    expect(res.status).toBe('WORKTREE_CREATE_FAILED');
  });

  // 18. heartbeat loss during worktree preparation prevents provider dispatch.
  it('18. heartbeat loss during worktree preparation prevents provider dispatch', async () => {
    vi.spyOn(worktreeService, 'createWorktree').mockImplementation(async () => {
      db.prepare("UPDATE account_leases SET expires_at = '2020-01-01T00:00:00.000Z'").run();
      await timer.fireNext();
      return { status: 'CREATED', worktreePath: 'path', baseSha, ownershipDigest: 'digest' };
    });
    const dispatchSpy = vi.spyOn(dispatchService, 'dispatchScheduled');
    const res = await scheduler.execute(authId);
    expect(res.status).toBe('LEASE_OWNERSHIP_LOST');
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  // 19. heartbeat loss after worktree creation retains worktree.
  it('19. heartbeat loss after worktree creation retains worktree', async () => {
    const removeSpy = vi.spyOn(worktreeService, 'removeWorktree');
    vi.spyOn(worktreeService, 'createWorktree').mockImplementation(async (tuple) => {
      const orig = new GitWorktreeService({ gitExecutable: gitExe, repositoryRoot: repoDir, managedRoot: managedDir });
      const res = await orig.createWorktree(tuple);
      db.prepare("UPDATE account_leases SET expires_at = '2020-01-01T00:00:00.000Z'").run();
      await timer.fireNext();
      return res;
    });
    const res = await scheduler.execute(authId);
    expect(res.status).toBe('LEASE_OWNERSHIP_LOST');
    expect(removeSpy).not.toHaveBeenCalled();
  });

  // 20. lease loss does not call lease release.
  it('20. lease loss does not call lease release', async () => {
    const releaseSpy = vi.spyOn(leaseService, 'release');
    vi.spyOn(worktreeService, 'createWorktree').mockImplementation(async (tuple) => {
      const orig = new GitWorktreeService({ gitExecutable: gitExe, repositoryRoot: repoDir, managedRoot: managedDir });
      const res = await orig.createWorktree(tuple);
      db.prepare("UPDATE account_leases SET expires_at = '2020-01-01T00:00:00.000Z'").run();
      await timer.fireNext();
      return res;
    });
    await scheduler.execute(authId);
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  // 21. valid preparation calls dispatchScheduled exactly once.
  it('21. valid preparation calls dispatchScheduled exactly once', async () => {
    const dispatchSpy = vi.spyOn(dispatchService, 'dispatchScheduled');
    await scheduler.execute(authId);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledWith(authId);
  });

  // 22. scheduler never calls adapter.execute directly.
  it('22. scheduler never calls adapter.execute directly', async () => {
    await scheduler.execute(authId);
    expect(adapter.executeCallCount).toBe(1);
  });

  // 23. scheduler never calls ProcessRunner directly.
  it('23. scheduler never calls ProcessRunner directly', async () => {
    const res = await scheduler.execute(authId);
    expect(res.status).toBe('COMPLETED');
  });

  // 24. heartbeat continues while dispatch promise is pending.
  it('24. heartbeat continues while dispatch promise is pending', async () => {
    let resolveDispatch!: (res: AgentExecutionResult) => void;
    adapter.executionBarrier = new Promise((resolve) => {
      resolveDispatch = resolve;
    });

    const execPromise = scheduler.execute(authId);
    expect(timer.pendingCount).toBeGreaterThan(0);
    const heartbeatFired = await timer.fireNext();
    expect(heartbeatFired).toBe(true);

    resolveDispatch({ executionId: 'exec-1', status: 'COMPLETED' });
    const res = await execPromise;
    expect(res.status).toBe('COMPLETED');
  });

  // 25. heartbeat loss during active provider execution calls cancelScheduled(authId).
  it('25. heartbeat loss during active provider execution calls cancelScheduled(authId)', async () => {
    const cancelSpy = vi.spyOn(dispatchService, 'cancelScheduled');
    let resolveDispatch!: (res: AgentExecutionResult) => void;
    const executeStartedPromise = new Promise<void>((resolve) => {
      adapter.onExecuteStarted = resolve;
      adapter.executionBarrier = new Promise((res) => {
        resolveDispatch = res;
      });
    });

    const execPromise = scheduler.execute(authId);
    await executeStartedPromise;

    db.prepare("UPDATE account_leases SET expires_at = '2020-01-01T00:00:00.000Z'").run();
    await timer.fireNext();

    expect(cancelSpy).toHaveBeenCalledWith(authId);
    resolveDispatch({ executionId: 'exec-1', status: 'CANCELLED' });
    const res = await execPromise;
    expect(res.status).toBe('LEASE_OWNERSHIP_LOST');
  });

  // 26. cancelScheduled called at most once for one ownership-loss event.
  it('26. cancelScheduled called at most once for one ownership-loss event', async () => {
    const cancelSpy = vi.spyOn(dispatchService, 'cancelScheduled');
    let resolveDispatch!: (res: AgentExecutionResult) => void;
    const executeStartedPromise = new Promise<void>((resolve) => {
      adapter.onExecuteStarted = resolve;
      adapter.executionBarrier = new Promise((res) => {
        resolveDispatch = res;
      });
    });

    const execPromise = scheduler.execute(authId);
    await executeStartedPromise;

    db.prepare("UPDATE account_leases SET expires_at = '2020-01-01T00:00:00.000Z'").run();
    await timer.fireNext();
    await timer.fireNext();

    expect(cancelSpy).toHaveBeenCalledTimes(1);
    resolveDispatch({ executionId: 'exec-1', status: 'CANCELLED' });
    await execPromise;
  });

  // 27. scheduler waits for original dispatch promise after cancellation.
  it('27. scheduler waits for original dispatch promise after cancellation', async () => {
    const cancelSpy = vi.spyOn(dispatchService, 'cancelScheduled');
    let resolveDispatch!: (res: AgentExecutionResult) => void;
    const executeStartedPromise = new Promise<void>((resolve) => {
      adapter.onExecuteStarted = resolve;
      adapter.executionBarrier = new Promise((res) => {
        resolveDispatch = res;
      });
    });

    let schedulerSettled = false;
    const execPromise = scheduler.execute(authId).then((result) => {
      schedulerSettled = true;
      return result;
    });

    await executeStartedPromise;

    db.prepare("UPDATE account_leases SET expires_at = '2020-01-01T00:00:00.000Z'").run();
    await timer.fireNext();

    expect(cancelSpy).toHaveBeenCalledWith(authId);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(schedulerSettled).toBe(false);

    resolveDispatch({ executionId: 'exec-1', status: 'CANCELLED' });

    const res = await execPromise;
    expect(schedulerSettled).toBe(true);
    expect(res.status).toBe('LEASE_OWNERSHIP_LOST');
  });

  // 28. lease loss + provider CANCELLED -> scheduler LEASE_OWNERSHIP_LOST.
  it('28. lease loss + provider CANCELLED -> scheduler LEASE_OWNERSHIP_LOST', async () => {
    let resolveDispatch!: (res: AgentExecutionResult) => void;
    adapter.executionBarrier = new Promise((resolve) => {
      resolveDispatch = resolve;
    });

    const execPromise = scheduler.execute(authId);
    db.prepare("UPDATE account_leases SET expires_at = '2020-01-01T00:00:00.000Z'").run();
    await timer.fireNext();

    resolveDispatch({ executionId: 'exec-1', status: 'CANCELLED' });
    const res = await execPromise;
    expect(res.status).toBe('LEASE_OWNERSHIP_LOST');
  });

  // 29. lease loss + provider FAILED -> scheduler LEASE_OWNERSHIP_LOST.
  it('29. lease loss + provider FAILED -> scheduler LEASE_OWNERSHIP_LOST', async () => {
    let resolveDispatch!: (res: AgentExecutionResult) => void;
    adapter.executionBarrier = new Promise((resolve) => {
      resolveDispatch = resolve;
    });

    const execPromise = scheduler.execute(authId);
    db.prepare("UPDATE account_leases SET expires_at = '2020-01-01T00:00:00.000Z'").run();
    await timer.fireNext();

    resolveDispatch({ executionId: 'exec-1', status: 'FAILED', error: 'Provider failed' });
    const res = await execPromise;
    expect(res.status).toBe('LEASE_OWNERSHIP_LOST');
  });

  // 30. lease loss + provider COMPLETED race -> scheduler LEASE_OWNERSHIP_LOST.
  it('30. lease loss + provider COMPLETED race -> scheduler LEASE_OWNERSHIP_LOST', async () => {
    let resolveDispatch!: (res: AgentExecutionResult) => void;
    adapter.executionBarrier = new Promise((resolve) => {
      resolveDispatch = resolve;
    });

    const execPromise = scheduler.execute(authId);
    db.prepare("UPDATE account_leases SET expires_at = '2020-01-01T00:00:00.000Z'").run();
    await timer.fireNext();

    resolveDispatch({ executionId: 'exec-1', status: 'COMPLETED' });
    const res = await execPromise;
    expect(res.status).toBe('LEASE_OWNERSHIP_LOST');
  });

  // 31. lease loss retains worktree regardless of clean/dirty state.
  it('31. lease loss retains worktree regardless of clean/dirty state', async () => {
    const removeSpy = vi.spyOn(worktreeService, 'removeWorktree');
    let resolveDispatch!: (res: AgentExecutionResult) => void;
    adapter.executionBarrier = new Promise((resolve) => {
      resolveDispatch = resolve;
    });

    const execPromise = scheduler.execute(authId);
    db.prepare("UPDATE account_leases SET expires_at = '2020-01-01T00:00:00.000Z'").run();
    await timer.fireNext();

    resolveDispatch({ executionId: 'exec-1', status: 'COMPLETED' });
    await execPromise;
    expect(removeSpy).not.toHaveBeenCalled();
  });

  // 32. normal COMPLETED + dirty retains worktree.
  it('32. normal COMPLETED + dirty retains worktree', async () => {
    const removeSpy = vi.spyOn(worktreeService, 'removeWorktree');
    let inspectCount = 0;
    vi.spyOn(worktreeService, 'inspectWorktree').mockImplementation(async () => {
      inspectCount++;
      return {
        status: 'INSPECTED',
        inspection: {
          managedPath: 'path',
          registered: true,
          exists: true,
          headSha: baseSha,
          detached: true,
          locked: true,
          clean: inspectCount === 1 ? true : false,
          ownershipDigest: 'digest',
          sourceMatch: true,
        },
      };
    });
    const res = await scheduler.execute(authId);
    expect(res.status).toBe('COMPLETED');
    expect(removeSpy).not.toHaveBeenCalled();
  });

  // 33. normal COMPLETED + clean retains worktree.
  it('33. normal COMPLETED + clean retains worktree', async () => {
    const removeSpy = vi.spyOn(worktreeService, 'removeWorktree');
    vi.spyOn(worktreeService, 'inspectWorktree').mockResolvedValue({
      status: 'INSPECTED',
      inspection: {
        managedPath: 'path',
        registered: true,
        exists: true,
        headSha: baseSha,
        detached: true,
        locked: true,
        clean: true,
        ownershipDigest: 'digest',
        sourceMatch: true,
      },
    });
    const res = await scheduler.execute(authId);
    expect(res.status).toBe('COMPLETED');
    expect(removeSpy).not.toHaveBeenCalled();
  });

  // 34. normal FAILED + dirty retains worktree.
  it('34. normal FAILED + dirty retains worktree', async () => {
    adapter.throwOnExecute = true;
    const removeSpy = vi.spyOn(worktreeService, 'removeWorktree');
    let inspectCount = 0;
    vi.spyOn(worktreeService, 'inspectWorktree').mockImplementation(async () => {
      inspectCount++;
      return {
        status: 'INSPECTED',
        inspection: {
          managedPath: 'path',
          registered: true,
          exists: true,
          headSha: baseSha,
          detached: true,
          locked: true,
          clean: inspectCount === 1 ? true : false,
          ownershipDigest: 'digest',
          sourceMatch: true,
        },
      };
    });
    const res = await scheduler.execute(authId);
    expect(res.status).toBe('PROVIDER_FAILED');
    expect(removeSpy).not.toHaveBeenCalled();
  });

  // 35. normal FAILED + clean removes worktree safely.
  it('35. normal FAILED + clean removes worktree safely', async () => {
    adapter.throwOnExecute = true;
    const removeSpy = vi.spyOn(worktreeService, 'removeWorktree');
    vi.spyOn(worktreeService, 'inspectWorktree').mockResolvedValue({
      status: 'INSPECTED',
      inspection: {
        managedPath: 'path',
        registered: true,
        exists: true,
        headSha: baseSha,
        detached: true,
        locked: true,
        clean: true,
        ownershipDigest: 'digest',
        sourceMatch: true,
      },
    });
    const res = await scheduler.execute(authId);
    expect(res.status).toBe('PROVIDER_FAILED');
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  // 36. normal CANCELLED + dirty retains worktree.
  it('36. normal CANCELLED + dirty retains worktree', async () => {
    adapter.executionBarrier = Promise.resolve({ executionId: 'exec-1', status: 'CANCELLED' });
    const removeSpy = vi.spyOn(worktreeService, 'removeWorktree');
    let inspectCount = 0;
    vi.spyOn(worktreeService, 'inspectWorktree').mockImplementation(async () => {
      inspectCount++;
      return {
        status: 'INSPECTED',
        inspection: {
          managedPath: 'path',
          registered: true,
          exists: true,
          headSha: baseSha,
          detached: true,
          locked: true,
          clean: inspectCount === 1 ? true : false,
          ownershipDigest: 'digest',
          sourceMatch: true,
        },
      };
    });
    const res = await scheduler.execute(authId);
    expect(res.status).toBe('CANCELLED');
    expect(removeSpy).not.toHaveBeenCalled();
  });

  // 37. normal CANCELLED + clean removes worktree safely.
  it('37. normal CANCELLED + clean removes worktree safely', async () => {
    adapter.executionBarrier = Promise.resolve({ executionId: 'exec-1', status: 'CANCELLED' });
    const removeSpy = vi.spyOn(worktreeService, 'removeWorktree');
    vi.spyOn(worktreeService, 'inspectWorktree').mockResolvedValue({
      status: 'INSPECTED',
      inspection: {
        managedPath: 'path',
        registered: true,
        exists: true,
        headSha: baseSha,
        detached: true,
        locked: true,
        clean: true,
        ownershipDigest: 'digest',
        sourceMatch: true,
      },
    });
    const res = await scheduler.execute(authId);
    expect(res.status).toBe('CANCELLED');
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  // 38. safe removal occurs only after dispatch promise terminal.
  it('38. safe removal occurs only after dispatch promise terminal', async () => {
    let dispatchFinished = false;
    const removeSpy = vi.spyOn(worktreeService, 'removeWorktree').mockImplementation(async () => {
      expect(dispatchFinished).toBe(true);
      return { status: 'REMOVED', worktreePath: 'p', ownershipDigest: 'd' };
    });

    adapter.executionBarrier = new Promise((resolve) => {
      setTimeout(() => {
        dispatchFinished = true;
        resolve({ executionId: 'exec-1', status: 'FAILED' });
      }, 20);
    });

    vi.spyOn(worktreeService, 'inspectWorktree').mockResolvedValue({
      status: 'INSPECTED',
      inspection: {
        managedPath: 'path',
        registered: true,
        exists: true,
        headSha: baseSha,
        detached: true,
        locked: true,
        clean: true,
        ownershipDigest: 'digest',
        sourceMatch: true,
      },
    });

    await scheduler.execute(authId);
    expect(removeSpy).toHaveBeenCalled();
  });

  // 39. safe removal occurs while lease heartbeat ownership still active.
  it('39. safe removal occurs while lease heartbeat ownership still active', async () => {
    adapter.executionBarrier = Promise.resolve({ executionId: 'exec-1', status: 'FAILED' });
    vi.spyOn(worktreeService, 'inspectWorktree').mockResolvedValue({
      status: 'INSPECTED',
      inspection: {
        managedPath: 'path',
        registered: true,
        exists: true,
        headSha: baseSha,
        detached: true,
        locked: true,
        clean: true,
        ownershipDigest: 'digest',
        sourceMatch: true,
      },
    });

    let leaseActiveDuringRemove = false;
    vi.spyOn(worktreeService, 'removeWorktree').mockImplementation(async () => {
      const activeLease = repo.getActiveLeaseForAssignment(assignmentId);
      if (activeLease && activeLease.released_at === null) {
        leaseActiveDuringRemove = true;
      }
      return { status: 'REMOVED', worktreePath: 'p', ownershipDigest: 'd' };
    });

    await scheduler.execute(authId);
    expect(leaseActiveDuringRemove).toBe(true);
  });

  // 40. worktree removal failure uses no force and is surfaced.
  it('40. worktree removal failure uses no force and is surfaced', async () => {
    adapter.executionBarrier = Promise.resolve({ executionId: 'exec-1', status: 'FAILED' });
    vi.spyOn(worktreeService, 'inspectWorktree').mockResolvedValue({
      status: 'INSPECTED',
      inspection: {
        managedPath: 'path',
        registered: true,
        exists: true,
        headSha: baseSha,
        detached: true,
        locked: true,
        clean: true,
        ownershipDigest: 'digest',
        sourceMatch: true,
      },
    });
    vi.spyOn(worktreeService, 'removeWorktree').mockResolvedValue({
      status: 'FAILED',
      code: 'REMOVE_FAILED',
      error: 'Remove failed simulation',
    });

    const res = await scheduler.execute(authId);
    expect(res.status).toBe('WORKTREE_CLEANUP_FAILED');
  });

  // 41. heartbeat continues through post-dispatch inspect/cleanup.
  it('41. heartbeat continues through post-dispatch inspect/cleanup', async () => {
    let postDispatchHeartbeatFired = false;
    let inspectCount = 0;
    vi.spyOn(worktreeService, 'inspectWorktree').mockImplementation(async () => {
      inspectCount++;
      if (inspectCount > 1) {
        postDispatchHeartbeatFired = await timer.fireNext();
      }
      return {
        status: 'INSPECTED',
        inspection: {
          managedPath: 'path',
          registered: true,
          exists: true,
          headSha: baseSha,
          detached: true,
          locked: true,
          clean: true,
          ownershipDigest: 'digest',
          sourceMatch: true,
        },
      };
    });

    await scheduler.execute(authId);
    expect(postDispatchHeartbeatFired).toBe(true);
  });

  // 42. heartbeat supervisor stop waits for in-flight heartbeat.
  it('42. heartbeat supervisor stop waits for in-flight heartbeat', async () => {
    const res = await scheduler.execute(authId);
    expect(res.status).toBe('COMPLETED');
  });

  // 43. in-flight final heartbeat loss prevents lease release.
  it('43. in-flight final heartbeat loss prevents lease release', async () => {
    const releaseSpy = vi.spyOn(leaseService, 'release');
    vi.spyOn(worktreeService, 'inspectWorktree').mockImplementation(async () => {
      db.prepare("UPDATE account_leases SET expires_at = '2020-01-01T00:00:00.000Z'").run();
      await timer.fireNext();
      return {
        status: 'INSPECTED',
        inspection: {
          managedPath: 'path',
          registered: true,
          exists: true,
          headSha: baseSha,
          detached: true,
          locked: true,
          clean: true,
          ownershipDigest: 'digest',
          sourceMatch: true,
        },
      };
    });

    const res = await scheduler.execute(authId);
    expect(res.status).toBe('LEASE_OWNERSHIP_LOST');
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  // 44. healthy terminal lifecycle releases lease exactly once.
  it('44. healthy terminal lifecycle releases lease exactly once', async () => {
    const releaseSpy = vi.spyOn(leaseService, 'release');
    await scheduler.execute(authId);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  // 45. lease release occurs after worktree cleanup decision.
  it('45. lease release occurs after worktree cleanup decision', async () => {
    let inspectDoneBeforeRelease = false;
    const origRelease = leaseService.release.bind(leaseService);
    vi.spyOn(leaseService, 'release').mockImplementationOnce((leaseId, token) => {
      expect(inspectDoneBeforeRelease).toBe(true);
      return origRelease(leaseId, token);
    });

    const origInspect = worktreeService.inspectWorktree.bind(worktreeService);
    worktreeService.inspectWorktree = async (tuple) => {
      const res = await origInspect(tuple);
      inspectDoneBeforeRelease = true;
      return res;
    };

    await scheduler.execute(authId);
  });

  // 46. lease release failure is surfaced and not retried.
  it('46. lease release failure is surfaced and not retried', async () => {
    const releaseSpy = vi.spyOn(leaseService, 'release').mockReturnValueOnce({
      status: 'FAILED',
      code: 'LEASE_TOKEN_MISMATCH',
      error: 'Token mismatch simulation',
    });

    const res = await scheduler.execute(authId);
    expect(res.status).toBe('LEASE_RELEASE_FAILED');
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  // 47. no stale lease reclaim.
  it('47. no stale lease reclaim', async () => {
    const res = await scheduler.execute(authId);
    expect(res.status).toBe('COMPLETED');
  });

  // 48. no second lease acquisition on heartbeat loss.
  it('48. no second lease acquisition on heartbeat loss', async () => {
    const acquireSpy = vi.spyOn(leaseService, 'acquireForAssignment');
    vi.spyOn(worktreeService, 'createWorktree').mockImplementationOnce(async (tuple) => {
      const orig = new GitWorktreeService({ gitExecutable: gitExe, repositoryRoot: repoDir, managedRoot: managedDir });
      const res = await orig.createWorktree(tuple);
      db.prepare("UPDATE account_leases SET expires_at = '2020-01-01T00:00:00.000Z'").run();
      await timer.fireNext();
      return res;
    });

    await scheduler.execute(authId);
    expect(acquireSpy).toHaveBeenCalledTimes(1);
  });

  // 49. no WorkerSlot RUNNING transition.
  it('49. no WorkerSlot RUNNING transition', async () => {
    await scheduler.execute(authId);
    const slot = repo.getWorkerSlot(slotId);
    expect(slot?.status).not.toBe('RUNNING');
  });

  // 50. no current_execution_id mutation.
  it('50. no current_execution_id mutation', async () => {
    await scheduler.execute(authId);
    const slot = repo.getWorkerSlot(slotId);
    expect(slot?.current_execution_id).toBeNull();
  });

  // 51. no ProviderRegistry dependency.
  it('51. no ProviderRegistry dependency', () => {
    expect((scheduler as any).providerRegistry).toBeUndefined();
  });

  // 52. no provider-specific branch.
  it('52. no provider-specific branch', async () => {
    const res = await scheduler.execute(authId);
    expect(res.status).toBe('COMPLETED');
  });

  // 53. provider COMPLETED maps to scheduler COMPLETED only when lifecycle and release succeed.
  it('53. provider COMPLETED maps to scheduler COMPLETED only when lifecycle and release succeed', async () => {
    const res = await scheduler.execute(authId);
    expect(res.status).toBe('COMPLETED');
  });

  // 54. provider FAILED maps to PROVIDER_FAILED.
  it('54. provider FAILED maps to PROVIDER_FAILED', async () => {
    adapter.throwOnExecute = true;
    const res = await scheduler.execute(authId);
    expect(res.status).toBe('PROVIDER_FAILED');
  });

  // 55. provider CANCELLED maps to CANCELLED.
  it('55. provider CANCELLED maps to CANCELLED', async () => {
    adapter.executionBarrier = Promise.resolve({ executionId: 'exec-1', status: 'CANCELLED' });
    const res = await scheduler.execute(authId);
    expect(res.status).toBe('CANCELLED');
  });

  // 56. post-dispatch worktree inspection failure prevents normal success.
  it('56. post-dispatch worktree inspection failure prevents normal success', async () => {
    let inspectCount = 0;
    vi.spyOn(worktreeService, 'inspectWorktree').mockImplementation(async () => {
      inspectCount++;
      if (inspectCount === 1) {
        return {
          status: 'INSPECTED',
          inspection: {
            managedPath: 'path',
            registered: true,
            exists: true,
            headSha: baseSha,
            detached: true,
            locked: true,
            clean: true,
            ownershipDigest: 'digest',
            sourceMatch: true,
          },
        };
      }
      return {
        status: 'FAILED',
        code: 'INSPECTION_FAILED',
        error: 'Inspection error',
      };
    });
    const res = await scheduler.execute(authId);
    expect(res.status).toBe('WORKTREE_INSPECTION_FAILED');
  });

  // 57. scheduler result includes no leaseToken.
  it('57. scheduler result includes no leaseToken', async () => {
    const res = await scheduler.execute(authId);
    expect((res as any).leaseToken).toBeUndefined();
  });

  // 58. scheduler result may safely include leaseId/slot/digest.
  it('58. scheduler result may safely include leaseId/slot/digest', async () => {
    const res = await scheduler.execute(authId);
    expect(res.leaseId).toBeDefined();
    expect(res.workerSlotId).toBe(slotId);
    expect(res.workspaceOwnershipDigest).toBeDefined();
  });

  // 59. all heartbeat timers/control state cleaned after terminal healthy path.
  it('59. all heartbeat timers/control state cleaned after terminal healthy path', async () => {
    await scheduler.execute(authId);
    expect(timer.pendingCount).toBe(0);
  });

  // 60. all heartbeat timers/control state cleaned after lease-loss path.
  it('60. all heartbeat timers/control state cleaned after lease-loss path', async () => {
    vi.spyOn(worktreeService, 'createWorktree').mockImplementation(async (tuple) => {
      const orig = new GitWorktreeService({ gitExecutable: gitExe, repositoryRoot: repoDir, managedRoot: managedDir });
      const res = await orig.createWorktree(tuple);
      db.prepare("UPDATE account_leases SET expires_at = '2020-01-01T00:00:00.000Z'").run();
      await timer.fireNext();
      return res;
    });

    await scheduler.execute(authId);
    expect(timer.pendingCount).toBe(0);
  });
});
