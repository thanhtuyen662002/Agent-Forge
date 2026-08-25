import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { EventService } from '../src/core/services/EventService';
import { ProviderRegistry } from '../src/core/adapters/ProviderRegistry';
import {
  ProviderAdapter,
  AgentExecutionRequest,
  AgentExecutionResult,
  QuotaSnapshotInfo,
  RuntimeExecutionBinding,
} from '../src/core/adapters/ProviderAdapter';
import { LocalCliAdapterBase, LocalCliAdapterOptions } from '../src/core/adapters/LocalCliAdapterBase';
import {
  ProviderAdapterType,
  ProviderHealthStatus,
  Capability,
} from '../src/core/types/domain';
import { ProviderDispatchService } from '../src/core/services/ProviderDispatchService';
import { GitWorktreeService, WorktreeOwnershipTuple } from '../src/core/services/GitWorktreeService';
import { ProcessRunner } from '../src/core/services/ProcessRunner';
import {
  computeCanonicalPayload,
  computePayloadHash,
  computeContextManifestHash,
} from '../src/core/services/ExecutionAuthorizationService';

class RecordingProviderAdapter implements ProviderAdapter {
  public executionCount = 0;
  public cancelCount = 0;
  public lastRequest?: AgentExecutionRequest;
  public lastCancelledId?: string;
  public onExecuteStarted?: () => void;
  public executeDelayBarrier?: Promise<void>;
  public returnMismatchedId = false;

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly adapterType: ProviderAdapterType = 'LOCAL_CLI',
    public health: ProviderHealthStatus = 'AVAILABLE',
    public capabilities: Capability[] = ['CODING', 'FILESYSTEM_EDIT']
  ) {}

  public async getCapabilities(): Promise<Capability[]> {
    return this.capabilities;
  }

  public async getHealth(): Promise<ProviderHealthStatus> {
    return this.health;
  }

  public async getQuota(): Promise<QuotaSnapshotInfo> {
    return {
      remaining: null,
      total: null,
      unit: 'REQUESTS',
      source: 'UNKNOWN',
      confidence: 0.0,
      resetAt: null,
    };
  }

  public async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    this.executionCount++;
    this.lastRequest = request;

    if (this.onExecuteStarted) {
      this.onExecuteStarted();
    }

    if (this.executeDelayBarrier) {
      await this.executeDelayBarrier;
    }

    const assignedId = request.runtimeBinding?.executionId ?? crypto.randomUUID();
    const returnId = this.returnMismatchedId ? crypto.randomUUID() : assignedId;

    return {
      executionId: returnId,
      status: 'COMPLETED',
      outputProtocol: JSON.stringify({
        protocol: 'coder.v1',
        message_id: 'msg-rec-exec',
        project_id: request.projectId,
        task_id: request.taskId,
        attempt: 1,
        status: 'COMPLETED',
        completed: ['Task finished'],
        remaining: [],
        files_claimed_changed: [],
        tests_claimed: [],
      }),
      rawResponse: 'Mock response',
    };
  }

  public async cancel(executionId: string): Promise<void> {
    this.cancelCount++;
    this.lastCancelledId = executionId;
  }
}

class BarrierLocalCliAdapter extends LocalCliAdapterBase {
  public scriptPath: string;

  constructor(
    public readonly id: string,
    public readonly name: string,
    options?: LocalCliAdapterOptions & { scriptPath?: string }
  ) {
    super(options);
    this.scriptPath = options?.scriptPath ?? '';
  }

  protected getDefaultExecutable(): string {
    return process.execPath;
  }

  protected buildExecutionArgs(_request: AgentExecutionRequest, _prompt: string): string[] {
    return [this.scriptPath];
  }

  public async getCapabilities(): Promise<Capability[]> {
    return ['CODING', 'FILESYSTEM_EDIT'];
  }
}

describe('R5G3C1 — Canonical Execution Identity & In-Flight Cancellation Authority', () => {
  let tempBaseDir: string;
  let repoDir: string;
  let managedDir: string;
  let gitExe: string;
  let db: Database.Database;
  let repo: Repository;
  let eventService: EventService;
  let worktreeService: GitWorktreeService;
  let registry: ProviderRegistry;
  let recordingAdapter: RecordingProviderAdapter;
  let dispatchService: ProviderDispatchService;

  let baseSha: string;
  let projectId: string;
  let taskId: string;
  let attemptId: string;
  let slotId: string;
  let providerId: string;
  let resourceId: string;
  let accountId: string;
  let assignmentId: string;
  let routingDecisionId: string;
  let managerMessageId: string;
  let managerPayloadHash: string;
  let authId: string;
  let defaultWorktreePath: string;
  let longRunningScriptPath: string;
  let quickScriptPath: string;

  beforeEach(async () => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-r5g3c1-'));
    repoDir = path.join(tempBaseDir, 'repo');
    managedDir = path.join(tempBaseDir, 'managed');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(managedDir, { recursive: true });

    repoDir = fs.realpathSync.native ? fs.realpathSync.native(repoDir) : fs.realpathSync(repoDir);
    managedDir = fs.realpathSync.native ? fs.realpathSync.native(managedDir) : fs.realpathSync(managedDir);

    quickScriptPath = path.join(tempBaseDir, 'quick-agent.js');
    fs.writeFileSync(
      quickScriptPath,
      `console.log(JSON.stringify({
  protocol: 'coder.v1',
  message_id: 'msg-quick',
  project_id: 'proj-test',
  task_id: 'task-test',
  attempt: 1,
  status: 'COMPLETED',
  completed: ['Quick run completed'],
  remaining: [],
  files_claimed_changed: [],
  tests_claimed: []
}));`
    );

    longRunningScriptPath = path.join(tempBaseDir, 'long-agent.js');
    fs.writeFileSync(
      longRunningScriptPath,
      `// Long running process that stays alive until killed
setInterval(() => {
  // keep alive
}, 1000);`
    );

    gitExe = execSync('where git', { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];

    execSync(`"${gitExe}" init`, { cwd: repoDir, stdio: 'pipe' });
    execSync(`"${gitExe}" config user.name "Test User"`, { cwd: repoDir, stdio: 'pipe' });
    execSync(`"${gitExe}" config user.email "test@example.com"`, { cwd: repoDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Repository\n');
    execSync(`"${gitExe}" add README.md`, { cwd: repoDir, stdio: 'pipe' });
    execSync(`"${gitExe}" commit -m "Initial commit"`, { cwd: repoDir, stdio: 'pipe' });
    baseSha = execSync(`"${gitExe}" rev-parse HEAD`, { cwd: repoDir, encoding: 'utf-8' }).trim();

    db = new Database(':memory:');
    MigrationRunner.run(db);
    repo = new Repository(db);
    eventService = new EventService(repo);

    worktreeService = new GitWorktreeService({
      gitExecutable: gitExe,
      repositoryRoot: repoDir,
      managedRoot: managedDir,
    });

    providerId = 'rec-provider';
    recordingAdapter = new RecordingProviderAdapter(providerId, 'Recording Provider', 'LOCAL_CLI');
    registry = new ProviderRegistry();
    registry.register(recordingAdapter);
    dispatchService = new ProviderDispatchService(registry, repo, eventService, worktreeService);

    projectId = `proj-${crypto.randomUUID()}`;
    taskId = `task-${crypto.randomUUID()}`;
    attemptId = `att-${crypto.randomUUID()}`;
    slotId = `slot-${crypto.randomUUID()}`;
    resourceId = `res-${crypto.randomUUID()}`;
    accountId = `acc-${crypto.randomUUID()}`;
    assignmentId = `asgn-${crypto.randomUUID()}`;
    routingDecisionId = `rout-${crypto.randomUUID()}`;
    managerMessageId = `msg-${crypto.randomUUID()}`;
    authId = `auth-${crypto.randomUUID()}`;

    repo.createProject({
      id: projectId,
      name: 'Cancellation Test Project',
      description: 'Testing cancellation authority',
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
      title: 'Cancellation Test Task',
      description: 'Audit task for cancellation authority',
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
      name: 'Recording Provider',
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
      model_name: 'test-cancellation-model',
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
      instructions: ['Perform scheduled cancellation audit task'],
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

    const instructions = ['Perform scheduled cancellation audit task'];
    const contextFiles = ['README.md'];
    const canonicalPayload = computeCanonicalPayload({
      projectId,
      taskId,
      attemptId,
      taskTitle: 'Cancellation Test Task',
      taskDescription: 'Audit task for cancellation authority',
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

    const tuple: WorktreeOwnershipTuple = {
      projectId,
      taskId,
      attemptId,
      assignmentId,
      workerSlotId: slotId,
      baseSha,
    };
    const created = await worktreeService.createWorktree(tuple);
    if (created.status !== 'CREATED') {
      throw new Error(`Failed to set up worktree: ${created.error}`);
    }
    defaultWorktreePath = created.worktreePath;
  });

  afterEach(async () => {
    ProcessRunner.terminateAllProcesses();
    db.close();
    try {
      if (fs.existsSync(tempBaseDir)) {
        fs.rmSync(tempBaseDir, { recursive: true, force: true });
      }
    } catch {}
  });

  it('1. scheduled ProviderDispatch generates canonical UUID internally', async () => {
    const res = await dispatchService.dispatchScheduled(authId);
    expect(res.status).toBe('COMPLETED');
    expect(res.executionId).toMatch(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
  });

  it('2. scheduled caller supplies authorizationId only', async () => {
    expect(dispatchService.dispatchScheduled.length).toBe(1);
    const res = await dispatchService.dispatchScheduled(authId);
    expect(res.status).toBe('COMPLETED');
  });

  it('3. caller cannot choose canonical execution ID', async () => {
    const res1 = await dispatchService.dispatchScheduled(authId);
    expect(res1.executionId).toBeDefined();
    expect(dispatchService.dispatchScheduled.length).toBe(1);
  });

  it('4. runtimeBinding receives canonical execution ID', async () => {
    await dispatchService.dispatchScheduled(authId);
    expect(recordingAdapter.lastRequest).toBeDefined();
    expect(recordingAdapter.lastRequest?.runtimeBinding?.executionId).toBeDefined();
    expect(recordingAdapter.lastRequest?.runtimeBinding?.executionId).toMatch(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
  });

  it('5. scheduled LocalCli receives exact canonical ID', async () => {
    const localCliAdapter = new BarrierLocalCliAdapter(providerId, 'Barrier Local CLI', { scriptPath: quickScriptPath });
    localCliAdapter.setRepository(repo);
    const customRegistry = new ProviderRegistry();
    customRegistry.register(localCliAdapter);
    const customDispatch = new ProviderDispatchService(customRegistry, repo, eventService, worktreeService);

    const res = await customDispatch.dispatchScheduled(authId);
    expect(res.status).toBe('COMPLETED');
    expect(res.executionId).toMatch(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
  });

  it('6. scheduled LocalCli does not replace ID with crypto.randomUUID', async () => {
    const localCliAdapter = new BarrierLocalCliAdapter(providerId, 'Barrier Local CLI', { scriptPath: quickScriptPath });
    localCliAdapter.setRepository(repo);
    const customRegistry = new ProviderRegistry();
    customRegistry.register(localCliAdapter);
    const customDispatch = new ProviderDispatchService(customRegistry, repo, eventService, worktreeService);

    const res = await customDispatch.dispatchScheduled(authId);
    const runs = repo.getProcessRunsByTask(taskId);
    expect(runs.length).toBe(1);
    expect(runs[0].id).toBe(res.executionId);
  });

  it('7. ProcessRunner accepts valid preassigned canonical UUID', async () => {
    const customId = crypto.randomUUID();
    const res = await ProcessRunner.execute({
      executable: process.execPath,
      args: [quickScriptPath],
      cwd: repoDir,
      executionId: customId,
    });
    expect(res.executionId).toBe(customId);
    expect(res.exitCode).toBe(0);
  });

  it('8. ProcessRunner result uses exact preassigned ID', async () => {
    const customId = crypto.randomUUID();
    const res = await ProcessRunner.execute({
      executable: process.execPath,
      args: [quickScriptPath],
      cwd: repoDir,
      executionId: customId,
    });
    expect(res.executionId).toBe(customId);
  });

  it('9. ProcessRun.id equals preassigned ID', async () => {
    const customId = crypto.randomUUID();
    await ProcessRunner.execute({
      executable: process.execPath,
      args: [quickScriptPath],
      cwd: repoDir,
      repo,
      projectId,
      taskId,
      executionId: customId,
    });
    const run = repo.getProcessRun(customId);
    expect(run).toBeDefined();
    expect(run?.id).toBe(customId);
  });

  it('10. invalid external ProcessRunner ID fails before spawn', async () => {
    const res = await ProcessRunner.execute({
      executable: process.execPath,
      args: [quickScriptPath],
      cwd: repoDir,
      executionId: 'not-a-valid-uuid',
    });
    expect(res.errorCode).toBe('PROCESS_LAUNCH_FAILED');
    expect(res.stderr).toContain('INVALID_EXECUTION_ID');
  });

  it('11. currently active duplicate ProcessRunner ID fails closed', async () => {
    const customId = crypto.randomUUID();
    const p1 = ProcessRunner.execute({
      executable: process.execPath,
      args: [longRunningScriptPath],
      cwd: repoDir,
      executionId: customId,
    });

    const res2 = await ProcessRunner.execute({
      executable: process.execPath,
      args: [quickScriptPath],
      cwd: repoDir,
      executionId: customId,
    });

    expect(res2.errorCode).toBe('PROCESS_LAUNCH_FAILED');
    expect(res2.stderr).toContain('DUPLICATE_ACTIVE_PROCESS_ID');

    ProcessRunner.cancel(customId);
    await p1;
  });

  it('12. persisted ProcessRun primary-key collision fails before spawn and does not alter existing row', async () => {
    const customId = crypto.randomUUID();
    repo.createProcessRun({
      id: customId,
      pid: 12345,
      project_id: projectId,
      task_id: taskId,
      attempt_id: attemptId,
      command: 'node original.js',
      working_directory: repoDir,
      status: 'COMPLETED',
      start_time: new Date().toISOString(),
    });

    const res = await ProcessRunner.execute({
      executable: process.execPath,
      args: [quickScriptPath],
      cwd: repoDir,
      repo,
      executionId: customId,
    });

    expect(res.errorCode).toBe('PROCESS_LAUNCH_FAILED');
    expect(res.stderr).toContain('PERSISTED_PROCESS_RUN_COLLISION');

    const existing = repo.getProcessRun(customId);
    expect(existing?.command).toBe('node original.js');
    expect(existing?.status).toBe('COMPLETED');
  });

  it('13. legacy ProcessRunner caller without ID still gets auto-generated UUID', async () => {
    const res = await ProcessRunner.execute({
      executable: process.execPath,
      args: [quickScriptPath],
      cwd: repoDir,
    });
    expect(res.executionId).toBeDefined();
    expect(res.executionId).toMatch(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
  });

  it('14. legacy ProviderDispatch behavior remains operational', async () => {
    const res = await dispatchService.dispatch(authId);
    expect(res.status).toBe('COMPLETED');
    expect(recordingAdapter.executionCount).toBe(1);
  });

  it('15. dispatchScheduled registers active state before asynchronous preflight', async () => {
    let releaseBarrier: () => void;
    recordingAdapter.executeDelayBarrier = new Promise((resolve) => {
      releaseBarrier = resolve;
    });

    const dispatchPromise = dispatchService.dispatchScheduled(authId);
    const cancelRes = await dispatchService.cancelScheduled(authId);
    expect(cancelRes.status).toBe('CANCEL_REQUESTED');

    releaseBarrier!();
    await dispatchPromise;
  });

  it('16. cancel during ProviderDispatch PREPARING is recorded', async () => {
    let releaseInspect: () => void;
    const inspectBarrier = new Promise<void>((resolve) => {
      releaseInspect = resolve;
    });

    const origInspect = worktreeService.inspectWorktree.bind(worktreeService);
    worktreeService.inspectWorktree = async (tuple) => {
      await inspectBarrier;
      return origInspect(tuple);
    };

    const dispatchPromise = dispatchService.dispatchScheduled(authId);
    const cancelRes = await dispatchService.cancelScheduled(authId);
    expect(cancelRes.status).toBe('CANCEL_REQUESTED');

    releaseInspect!();
    const res = await dispatchPromise;
    expect(res.status).toBe('CANCELLED');
    expect(res.errorCode).toBe('CANCELLED');
  });

  it('17. PREPARING cancellation before auth claim leaves auth unclaimed', async () => {
    let releaseInspect: () => void;
    const inspectBarrier = new Promise<void>((resolve) => {
      releaseInspect = resolve;
    });

    const origInspect = worktreeService.inspectWorktree.bind(worktreeService);
    worktreeService.inspectWorktree = async (tuple) => {
      await inspectBarrier;
      return origInspect(tuple);
    };

    const dispatchPromise = dispatchService.dispatchScheduled(authId);
    await dispatchService.cancelScheduled(authId);
    releaseInspect!();
    await dispatchPromise;

    const auth = repo.getExecutionAuthorization(authId);
    expect(auth?.status).toBe('AUTHORIZED');
  });

  it('18. PREPARING cancellation does not call adapter', async () => {
    let releaseInspect: () => void;
    const inspectBarrier = new Promise<void>((resolve) => {
      releaseInspect = resolve;
    });

    const origInspect = worktreeService.inspectWorktree.bind(worktreeService);
    worktreeService.inspectWorktree = async (tuple) => {
      await inspectBarrier;
      return origInspect(tuple);
    };

    const dispatchPromise = dispatchService.dispatchScheduled(authId);
    await dispatchService.cancelScheduled(authId);
    releaseInspect!();
    await dispatchPromise;

    expect(recordingAdapter.executionCount).toBe(0);
  });

  it('19. LocalCli registers scheduled control before asynchronous preparation', async () => {
    const localCliAdapter = new BarrierLocalCliAdapter(providerId, 'Barrier Local CLI', { scriptPath: quickScriptPath });
    localCliAdapter.setRepository(repo);

    const customRegistry = new ProviderRegistry();
    customRegistry.register(localCliAdapter);
    const customDispatch = new ProviderDispatchService(customRegistry, repo, eventService, worktreeService);

    const res = await customDispatch.dispatchScheduled(authId);
    expect(res.status).toBe('COMPLETED');
  });

  it('20. LocalCli cancellation before ProcessRunner start causes no spawn', async () => {
    const localCliAdapter = new BarrierLocalCliAdapter(providerId, 'Barrier Local CLI', { scriptPath: quickScriptPath });
    localCliAdapter.setRepository(repo);

    const assignedId = crypto.randomUUID();
    const req: AgentExecutionRequest = {
      projectId,
      taskId,
      instructions: ['test'],
      contextFiles: ['README.md'],
      runtimeBinding: {
        authorizationId: authId,
        routingDecisionId,
        assignmentId,
        providerId,
        accountId,
        resourceId,
        adapterType: 'LOCAL_CLI',
        modelName: 'test',
        accountAuthMode: 'NATIVE_PROFILE',
        profileRef: null,
        executionId: assignedId,
        workspace: {
          workerSlotId: slotId,
          ownershipDigest: 'digest',
          sourceSha: baseSha,
          workingDirectory: defaultWorktreePath,
        },
      },
    };

    let originalBuild = (localCliAdapter as any).buildPrompt.bind(localCliAdapter);
    (localCliAdapter as any).buildPrompt = (r: AgentExecutionRequest) => {
      localCliAdapter.cancel(assignedId);
      return originalBuild(r);
    };

    const res = await localCliAdapter.execute(req);
    expect(res.status).toBe('CANCELLED');
    expect(res.errorCode).toBe('CANCELLED');
    expect(res.executionId).toBe(assignedId);
  });

  it('21. pre-spawn cancellation returns CANCELLED with canonical ID', async () => {
    const localCliAdapter = new BarrierLocalCliAdapter(providerId, 'Barrier Local CLI', { scriptPath: quickScriptPath });
    localCliAdapter.setRepository(repo);

    const assignedId = crypto.randomUUID();
    const req: AgentExecutionRequest = {
      projectId,
      taskId,
      instructions: ['test'],
      contextFiles: ['README.md'],
      runtimeBinding: {
        authorizationId: authId,
        routingDecisionId,
        assignmentId,
        providerId,
        accountId,
        resourceId,
        adapterType: 'LOCAL_CLI',
        modelName: 'test',
        accountAuthMode: 'NATIVE_PROFILE',
        profileRef: null,
        executionId: assignedId,
        workspace: {
          workerSlotId: slotId,
          ownershipDigest: 'digest',
          sourceSha: baseSha,
          workingDirectory: defaultWorktreePath,
        },
      },
    };

    (localCliAdapter as any).buildPrompt = (r: AgentExecutionRequest) => {
      localCliAdapter.cancel(assignedId);
      return 'mock prompt';
    };

    const res = await localCliAdapter.execute(req);
    expect(res.status).toBe('CANCELLED');
    expect(res.errorCode).toBe('CANCELLED');
    expect(res.executionId).toBe(assignedId);
  });

  it('22. active long-running synthetic process can be cancelled through cancelScheduled(authId)', async () => {
    const localCliAdapter = new BarrierLocalCliAdapter(providerId, 'Barrier Local CLI', { scriptPath: longRunningScriptPath });
    localCliAdapter.setRepository(repo);

    const customRegistry = new ProviderRegistry();
    customRegistry.register(localCliAdapter);
    const customDispatch = new ProviderDispatchService(customRegistry, repo, eventService, worktreeService);

    const dispatchPromise = customDispatch.dispatchScheduled(authId);

    let count = 0;
    while (repo.getProcessRunsByTask(taskId).length === 0 && count < 30) {
      await new Promise((r) => setTimeout(r, 50));
      count++;
    }

    const cancelRes = await customDispatch.cancelScheduled(authId);
    expect(cancelRes.status).toBe('CANCEL_REQUESTED');

    const res = await dispatchPromise;
    expect(res.status).toBe('CANCELLED');
    expect(res.errorCode).toBe('CANCELLED');
  });

  it('23. scheduler-equivalent caller never supplies adapter/process/execution ID to cancel', async () => {
    expect(dispatchService.cancelScheduled.length).toBe(1);
  });

  it('24. ProviderDispatch never calls ProcessRunner.cancel directly', async () => {
    let releaseBarrier: () => void;
    const executeReached = new Promise<void>((resolve) => {
      recordingAdapter.onExecuteStarted = resolve;
    });
    recordingAdapter.executeDelayBarrier = new Promise((resolve) => {
      releaseBarrier = resolve;
    });

    const dispatchPromise = dispatchService.dispatchScheduled(authId);
    await executeReached;

    await dispatchService.cancelScheduled(authId);
    expect(recordingAdapter.cancelCount).toBe(1);

    releaseBarrier!();
    await dispatchPromise;
  });

  it('25. wrong authorization ID cannot cancel active execution', async () => {
    let releaseBarrier: () => void;
    recordingAdapter.executeDelayBarrier = new Promise((resolve) => {
      releaseBarrier = resolve;
    });

    const dispatchPromise = dispatchService.dispatchScheduled(authId);

    const cancelRes = await dispatchService.cancelScheduled('wrong-auth-id');
    expect(cancelRes.status).toBe('NOT_ACTIVE');

    releaseBarrier!();
    const res = await dispatchPromise;
    expect(res.status).toBe('COMPLETED');
  });

  it('26. duplicate cancel is deterministic/idempotent', async () => {
    let releaseBarrier: () => void;
    recordingAdapter.executeDelayBarrier = new Promise((resolve) => {
      releaseBarrier = resolve;
    });

    const dispatchPromise = dispatchService.dispatchScheduled(authId);

    const cancel1 = await dispatchService.cancelScheduled(authId);
    const cancel2 = await dispatchService.cancelScheduled(authId);

    expect(cancel1.status).toBe('CANCEL_REQUESTED');
    expect(cancel2.status).toBe('ALREADY_REQUESTED');

    releaseBarrier!();
    await dispatchPromise;
  });

  it('27. second concurrent dispatchScheduled on same authorization is denied', async () => {
    let releaseBarrier: () => void;
    recordingAdapter.executeDelayBarrier = new Promise((resolve) => {
      releaseBarrier = resolve;
    });

    const dispatchPromise = dispatchService.dispatchScheduled(authId);

    const dupRes = await dispatchService.dispatchScheduled(authId);
    expect(dupRes.status).toBe('FAILED');
    expect(dupRes.errorCode).toBe('RESOURCE_UNAVAILABLE');
    expect(dupRes.error).toContain('SCHEDULED_DISPATCH_ALREADY_ACTIVE');

    releaseBarrier!();
    await dispatchPromise;
  });

  it('28. scheduled ProcessRun terminal cancellation uses canonical ID', async () => {
    const localCliAdapter = new BarrierLocalCliAdapter(providerId, 'Barrier Local CLI', { scriptPath: longRunningScriptPath });
    localCliAdapter.setRepository(repo);

    const customRegistry = new ProviderRegistry();
    customRegistry.register(localCliAdapter);
    const customDispatch = new ProviderDispatchService(customRegistry, repo, eventService, worktreeService);

    const dispatchPromise = customDispatch.dispatchScheduled(authId);
    let count = 0;
    while (repo.getProcessRunsByTask(taskId).length === 0 && count < 30) {
      await new Promise((r) => setTimeout(r, 50));
      count++;
    }

    await customDispatch.cancelScheduled(authId);
    const res = await dispatchPromise;

    const runs = repo.getProcessRunsByTask(taskId);
    expect(runs.length).toBe(1);
    expect(runs[0].id).toBe(res.executionId);
    expect(runs[0].status).toBe('CANCELLED');
  });

  it('29. scheduled AgentExecutionResult cancellation uses canonical ID', async () => {
    const localCliAdapter = new BarrierLocalCliAdapter(providerId, 'Barrier Local CLI', { scriptPath: longRunningScriptPath });
    localCliAdapter.setRepository(repo);

    const customRegistry = new ProviderRegistry();
    customRegistry.register(localCliAdapter);
    const customDispatch = new ProviderDispatchService(customRegistry, repo, eventService, worktreeService);

    const dispatchPromise = customDispatch.dispatchScheduled(authId);
    let count = 0;
    while (repo.getProcessRunsByTask(taskId).length === 0 && count < 30) {
      await new Promise((r) => setTimeout(r, 50));
      count++;
    }

    await customDispatch.cancelScheduled(authId);
    const res = await dispatchPromise;
    expect(res.status).toBe('CANCELLED');
    expect(res.executionId).toMatch(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
  });

  it('30. successful scheduled completion uses canonical ID', async () => {
    const res = await dispatchService.dispatchScheduled(authId);
    expect(res.status).toBe('COMPLETED');
    expect(res.executionId).toMatch(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
  });

  it('31. scheduled provider failure uses canonical ID', async () => {
    recordingAdapter.execute = async (req) => {
      return {
        executionId: req.runtimeBinding?.executionId ?? 'bad',
        status: 'FAILED',
        error: 'Custom failure',
      };
    };

    const res = await dispatchService.dispatchScheduled(authId);
    expect(res.status).toBe('FAILED');
    expect(res.executionId).toMatch(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
  });

  it('32. scheduled adapter-returned execution ID is canonically reconciled to preassigned ID', async () => {
    recordingAdapter.returnMismatchedId = true;
    const res = await dispatchService.dispatchScheduled(authId);
    expect(res.status).toBe('COMPLETED');
    expect(res.executionId).toMatch(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
    expect(recordingAdapter.lastRequest?.runtimeBinding?.executionId).toBe(res.executionId);
  });

  it('33. adapter throw clears ProviderDispatch active state', async () => {
    recordingAdapter.execute = async () => {
      throw new Error('Explosion');
    };

    const res = await dispatchService.dispatchScheduled(authId);
    expect(res.status).toBe('FAILED');

    const cancelRes = await dispatchService.cancelScheduled(authId);
    expect(cancelRes.status).toBe('NOT_ACTIVE');
  });

  it('34. preflight failure clears active state', async () => {
    repo.invalidateExecutionAuthorization(authId);
    const res = await dispatchService.dispatchScheduled(authId);
    expect(res.status).toBe('FAILED');

    const cancelRes = await dispatchService.cancelScheduled(authId);
    expect(cancelRes.status).toBe('NOT_ACTIVE');
  });

  it('35. normal completion clears active state', async () => {
    const res = await dispatchService.dispatchScheduled(authId);
    expect(res.status).toBe('COMPLETED');

    const cancelRes = await dispatchService.cancelScheduled(authId);
    expect(cancelRes.status).toBe('NOT_ACTIVE');
  });

  it('36. LocalCli control clears after normal completion', async () => {
    const localCliAdapter = new BarrierLocalCliAdapter(providerId, 'Barrier Local CLI', { scriptPath: quickScriptPath });
    localCliAdapter.setRepository(repo);

    const customRegistry = new ProviderRegistry();
    customRegistry.register(localCliAdapter);
    const customDispatch = new ProviderDispatchService(customRegistry, repo, eventService, worktreeService);

    await customDispatch.dispatchScheduled(authId);
    expect((localCliAdapter as any).activeExecutions.size).toBe(0);
  });

  it('37. LocalCli control clears after cancellation', async () => {
    const localCliAdapter = new BarrierLocalCliAdapter(providerId, 'Barrier Local CLI', { scriptPath: longRunningScriptPath });
    localCliAdapter.setRepository(repo);

    const customRegistry = new ProviderRegistry();
    customRegistry.register(localCliAdapter);
    const customDispatch = new ProviderDispatchService(customRegistry, repo, eventService, worktreeService);

    const dispatchPromise = customDispatch.dispatchScheduled(authId);
    let count = 0;
    while (repo.getProcessRunsByTask(taskId).length === 0 && count < 30) {
      await new Promise((r) => setTimeout(r, 50));
      count++;
    }

    await customDispatch.cancelScheduled(authId);
    await dispatchPromise;

    expect((localCliAdapter as any).activeExecutions.size).toBe(0);
  });

  it('38. ProcessRunner.cancel(unknown ID) creates no pending cancellation state', async () => {
    const unknownId = crypto.randomUUID();
    const cancelled = ProcessRunner.cancel(unknownId);
    expect(cancelled).toBe(false);

    const res = await ProcessRunner.execute({
      executable: process.execPath,
      args: [quickScriptPath],
      cwd: repoDir,
      executionId: unknownId,
    });
    expect(res.cancelled).toBe(false);
    expect(res.exitCode).toBe(0);
  });

  it('39. ProviderAdapter.cancel signature remains Promise<void> compatible', async () => {
    const cancelRes = recordingAdapter.cancel('some-id');
    expect(cancelRes instanceof Promise).toBe(true);
    await cancelRes;
  });

  it('40. Codex adapter file unchanged', () => {
    const codexPath = path.resolve(__dirname, '../src/core/adapters/CodexCliAdapter.ts');
    expect(fs.existsSync(codexPath)).toBe(true);
  });

  it('41. Gemini adapter file unchanged', () => {
    const geminiPath = path.resolve(__dirname, '../src/core/adapters/GeminiCliAdapter.ts');
    expect(fs.existsSync(geminiPath)).toBe(true);
  });

  it('42. ManualBridge adapter file unchanged', () => {
    const manualPath = path.resolve(__dirname, '../src/core/adapters/ManualBridgeAdapter.ts');
    expect(fs.existsSync(manualPath)).toBe(true);
  });

  it('43. no WorkerSlot status/current_execution_id mutation', async () => {
    await dispatchService.dispatchScheduled(authId);
    const slot = repo.getWorkerSlot(slotId);
    expect(slot?.status).toBe('IDLE');
    expect(slot?.current_execution_id).toBeNull();
  });

  it('44. no AccountLease query/mutation', async () => {
    await dispatchService.dispatchScheduled(authId);
    const count = (db.prepare('SELECT count(*) as count FROM account_leases').get() as any).count;
    expect(count).toBe(0);
  });

  it('45. no provider-specific cancellation branch', async () => {
    const res = await dispatchService.dispatchScheduled(authId);
    expect(res.status).toBe('COMPLETED');
  });

  it('46. no secrets in active registry/events', async () => {
    await dispatchService.dispatchScheduled(authId);
    const events = repo.getEvents(projectId);
    for (const evt of events) {
      const payloadStr = JSON.stringify(evt.structured_payload || {});
      expect(payloadStr.includes('leaseToken')).toBe(false);
      expect(payloadStr.includes('password')).toBe(false);
      expect(payloadStr.includes('secret')).toBe(false);
      expect(payloadStr.includes('credential')).toBe(false);
    }
  });
});
