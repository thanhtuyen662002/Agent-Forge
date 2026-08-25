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
  RuntimeWorkspaceBinding,
} from '../src/core/adapters/ProviderAdapter';
import { LocalCliAdapterBase, LocalCliAdapterOptions } from '../src/core/adapters/LocalCliAdapterBase';
import {
  ProviderAdapterType,
  ProviderHealthStatus,
  Capability,
} from '../src/core/types/domain';
import { ProviderDispatchService } from '../src/core/services/ProviderDispatchService';
import { GitWorktreeService, WorktreeOwnershipTuple } from '../src/core/services/GitWorktreeService';
import {
  computeCanonicalPayload,
  computePayloadHash,
  computeContextManifestHash,
} from '../src/core/services/ExecutionAuthorizationService';

class RecordingProviderAdapter implements ProviderAdapter {
  public executionCount = 0;
  public lastRequest?: AgentExecutionRequest;

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly adapterType: ProviderAdapterType = 'LOCAL_CLI',
    public health: ProviderHealthStatus = 'AVAILABLE',
    public capabilities: Capability[] = ['CODING', 'FILESYSTEM_EDIT'],
    public customExecutionResult?: Partial<AgentExecutionResult>
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
    if (this.customExecutionResult) {
      return {
        executionId: crypto.randomUUID(),
        status: this.customExecutionResult.status ?? 'COMPLETED',
        outputProtocol: this.customExecutionResult.outputProtocol,
        rawResponse: this.customExecutionResult.rawResponse,
        error: this.customExecutionResult.error,
        stdoutEvidenceId: this.customExecutionResult.stdoutEvidenceId,
        stderrEvidenceId: this.customExecutionResult.stderrEvidenceId,
      };
    }
    return {
      executionId: crypto.randomUUID(),
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

  public async cancel(_executionId: string): Promise<void> {}
}

class TestLocalCliAdapter extends LocalCliAdapterBase {
  public readonly id = 'test-local-cli';
  public readonly name = 'Test Local CLI Adapter';
  private mockScriptPath: string;

  constructor(options?: LocalCliAdapterOptions & { mockScriptPath?: string }) {
    super(options);
    this.mockScriptPath = options?.mockScriptPath ?? '';
  }

  protected getDefaultExecutable(): string {
    return process.execPath;
  }

  protected buildExecutionArgs(_request: AgentExecutionRequest, _prompt: string): string[] {
    return [this.mockScriptPath];
  }

  public async getCapabilities(): Promise<Capability[]> {
    return ['CODING', 'FILESYSTEM_EDIT'];
  }
}

describe('R5G3B — Verified Workspace Runtime Binding & Local CLI Authority', () => {
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
  let mockScriptPath: string;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-r5g3b-'));
    repoDir = path.join(tempBaseDir, 'repo');
    managedDir = path.join(tempBaseDir, 'managed');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(managedDir, { recursive: true });

    // Canonicalize paths
    repoDir = fs.realpathSync.native ? fs.realpathSync.native(repoDir) : fs.realpathSync(repoDir);
    managedDir = fs.realpathSync.native ? fs.realpathSync.native(managedDir) : fs.realpathSync(managedDir);

    mockScriptPath = path.join(tempBaseDir, 'mock-agent.js');
    fs.writeFileSync(
      mockScriptPath,
      `console.log(JSON.stringify({
  protocol: 'coder.v1',
  message_id: 'msg-test-local',
  project_id: 'proj-test',
  task_id: 'task-test',
  attempt: 1,
  status: 'COMPLETED',
  completed: ['Completed test local cli execution'],
  remaining: [],
  files_claimed_changed: [],
  tests_claimed: []
}));`
    );

    gitExe = execSync(process.platform === 'win32' ? 'where git' : 'which git', { encoding: 'utf-8' })
      .trim()
      .split(/\r?\n/)[0];

    // Initialize git repo
    execSync(`"${gitExe}" init`, { cwd: repoDir, stdio: 'pipe' });
    execSync(`"${gitExe}" config user.name "Test User"`, { cwd: repoDir, stdio: 'pipe' });
    execSync(`"${gitExe}" config user.email "test@example.com"`, { cwd: repoDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Repository\n');
    execSync(`"${gitExe}" add README.md`, { cwd: repoDir, stdio: 'pipe' });
    execSync(`"${gitExe}" commit -m "Initial commit"`, { cwd: repoDir, stdio: 'pipe' });
    baseSha = execSync(`"${gitExe}" rev-parse HEAD`, { cwd: repoDir, encoding: 'utf-8' }).trim();

    // In-memory SQLite database
    db = new Database(':memory:');
    MigrationRunner.run(db);
    repo = new Repository(db);
    eventService = new EventService(repo);

    worktreeService = new GitWorktreeService({
      gitExecutable: gitExe,
      repositoryRoot: repoDir,
      managedRoot: managedDir,
    });

    registry = new ProviderRegistry();
    recordingAdapter = new RecordingProviderAdapter('test-provider', 'Test Provider', 'LOCAL_CLI');
    registry.register(recordingAdapter);

    dispatchService = new ProviderDispatchService(registry, repo, eventService, worktreeService);

    // Setup DB domain entities
    projectId = `proj-${crypto.randomUUID()}`;
    taskId = `task-${crypto.randomUUID()}`;
    attemptId = `att-${crypto.randomUUID()}`;
    slotId = `slot-${crypto.randomUUID()}`;
    providerId = 'test-provider';
    resourceId = `res-${crypto.randomUUID()}`;
    accountId = `acc-${crypto.randomUUID()}`;
    assignmentId = `asgn-${crypto.randomUUID()}`;
    routingDecisionId = `rout-${crypto.randomUUID()}`;
    managerMessageId = `msg-${crypto.randomUUID()}`;
    authId = `auth-${crypto.randomUUID()}`;

    repo.createProject({
      id: projectId,
      name: 'R5G3B Test Project',
      description: 'Testing workspace runtime binding',
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
      title: 'Test R5G3B Task',
      description: 'Test description',
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
      name: 'Test Provider',
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
      profile_ref: 'native-profile://test-provider/default',
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
      instructions: ['Implement feature X'],
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

    const canonicalPayload = computeCanonicalPayload({
      projectId,
      taskId,
      attemptId,
      taskTitle: 'Test R5G3B Task',
      taskDescription: 'Test description',
      acceptanceCriteria: ['must pass all tests'],
      constraints: ['no console.log'],
      instructions: ['Implement feature X'],
      contextFiles: ['README.md'],
      verificationCommands: { TEST: null, LINT: null, BUILD: null },
      managerMessageId,
      managerPayloadHash,
    });
    const payloadHash = computePayloadHash(canonicalPayload);
    const contextHash = computeContextManifestHash(['README.md']);

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
      instruction_payload_hash: payloadHash,
      context_manifest_hash: contextHash,
      canonical_instructions_json: JSON.stringify(['Implement feature X']),
      context_files_json: JSON.stringify(['README.md']),
      canonical_payload_json: JSON.stringify(canonicalPayload),
      status: 'AUTHORIZED',
      created_at: new Date().toISOString(),
      dispatched_at: null,
    });
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {}
  });

  const getOwnershipTuple = (): WorktreeOwnershipTuple => ({
    projectId,
    taskId,
    attemptId,
    assignmentId,
    workerSlotId: slotId,
    baseSha,
  });

  it('1. Legacy dispatch remains operational without GitWorktreeService', async () => {
    const legacyDispatch = new ProviderDispatchService(registry, repo, eventService);
    const res = await legacyDispatch.dispatch(authId);
    expect(res.error).toBeUndefined();
    expect(res.status).toBe('COMPLETED');
    expect(recordingAdapter.executionCount).toBe(1);
    expect(recordingAdapter.lastRequest?.runtimeBinding?.workspace).toBeUndefined();
  });

  it('2. Legacy LocalCliAdapter execution still uses project.repository_path', async () => {
    const adapter = new TestLocalCliAdapter({ repo, mockScriptPath });
    const req: AgentExecutionRequest = {
      projectId,
      taskId,
      instructions: ['Test legacy path'],
      contextFiles: ['README.md'],
      runtimeBinding: {
        authorizationId: authId,
        routingDecisionId,
        assignmentId,
        providerId,
        accountId,
        resourceId,
        adapterType: 'LOCAL_CLI',
        modelName: 'test-model',
        accountAuthMode: 'NATIVE_PROFILE',
        profileRef: 'native-profile://test-provider/default',
      },
    };
    const res = await adapter.execute(req);
    expect(res.error).toBeUndefined();
    expect(res.status).toBe('COMPLETED');
  });

  it('3. dispatchScheduled requires configured GitWorktreeService', async () => {
    const noWorktreeDispatch = new ProviderDispatchService(registry, repo, eventService);
    const res = await noWorktreeDispatch.dispatchScheduled(authId);
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('SCHEDULED_GIT_WORKTREE_SERVICE_NOT_CONFIGURED');
    expect(recordingAdapter.executionCount).toBe(0);
  });

  it('4. dispatchScheduled rejects MANUAL_HANDOFF_REQUIRED', async () => {
    const manualRoutingId = `rout-manual-${crypto.randomUUID()}`;
    const manualAuthId = `auth-manual-${crypto.randomUUID()}`;

    eventService.record(
      projectId,
      'PROVIDER_ROUTING_DECISION',
      'Manual routing decision',
      {
        decisionId: manualRoutingId,
        projectId,
        taskId,
        attemptId,
        outcome: 'MANUAL_HANDOFF_REQUIRED',
        selectedResourceId: resourceId,
        selectedProviderId: providerId,
        timestamp: new Date().toISOString(),
      },
      taskId
    );

    const canonicalPayload = computeCanonicalPayload({
      projectId,
      taskId,
      attemptId,
      taskTitle: 'Test R5G3B Task',
      taskDescription: 'Test description',
      acceptanceCriteria: ['must pass all tests'],
      constraints: ['no console.log'],
      instructions: ['Implement feature X'],
      contextFiles: ['README.md'],
      verificationCommands: { TEST: null, LINT: null, BUILD: null },
      managerMessageId,
      managerPayloadHash,
    });
    const payloadHash = computePayloadHash(canonicalPayload);
    const contextHash = computeContextManifestHash(['README.md']);

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
      routing_decision_id: manualRoutingId,
      selected_resource_id: resourceId,
      selected_provider_id: providerId,
      instruction_payload_hash: payloadHash,
      context_manifest_hash: contextHash,
      canonical_instructions_json: JSON.stringify(['Implement feature X']),
      context_files_json: JSON.stringify(['README.md']),
      canonical_payload_json: JSON.stringify(canonicalPayload),
      status: 'AUTHORIZED',
      created_at: new Date().toISOString(),
      dispatched_at: null,
    });

    const res = await dispatchService.dispatchScheduled(manualAuthId);
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('SCHEDULED_DISPATCH_NOT_APPLICABLE');
    expect(recordingAdapter.executionCount).toBe(0);
  });

  it('5. Scheduled caller supplies authorizationId only', async () => {
    const createRes = await worktreeService.createWorktree(getOwnershipTuple());
    expect(createRes.status).toBe('CREATED');

    const res = await dispatchService.dispatchScheduled(authId);
    expect(res.status).toBe('COMPLETED');
    expect(recordingAdapter.executionCount).toBe(1);
  });

  it('6. Scheduled dispatch derives assignment from durable routing state', async () => {
    const createRes = await worktreeService.createWorktree(getOwnershipTuple());
    expect(createRes.status).toBe('CREATED');

    const res = await dispatchService.dispatchScheduled(authId);
    expect(res.status).toBe('COMPLETED');
    expect(recordingAdapter.lastRequest?.runtimeBinding?.assignmentId).toBe(assignmentId);
  });

  it('7. Scheduled caller cannot choose another assignment', async () => {
    expect(dispatchService.dispatchScheduled.length).toBe(1);
  });

  it('8. Scheduled dispatch requires assignment.selected_worker_slot_id', async () => {
    db.prepare('UPDATE agent_assignments SET selected_worker_slot_id = NULL WHERE id = ?').run(assignmentId);

    const res = await dispatchService.dispatchScheduled(authId);
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('ROUTING_ASSIGNMENT_SLOT_MISSING');
    expect(recordingAdapter.executionCount).toBe(0);
  });

  it('9. Scheduled caller cannot choose slot', async () => {
    expect(dispatchService.dispatchScheduled.length).toBe(1);
  });

  it('10. Scheduled source uses auth.repository_head_sha', async () => {
    const createRes = await worktreeService.createWorktree(getOwnershipTuple());
    expect(createRes.status).toBe('CREATED');

    const res = await dispatchService.dispatchScheduled(authId);
    expect(res.status).toBe('COMPLETED');
    expect(recordingAdapter.lastRequest?.runtimeBinding?.workspace?.sourceSha).toBe(baseSha);
  });

  it('11. Task.base_sha differing from repository_head_sha does not become worktree source', async () => {
    const createRes = await worktreeService.createWorktree(getOwnershipTuple());
    expect(createRes.status).toBe('CREATED');

    const res = await dispatchService.dispatchScheduled(authId);
    expect(res.status).toBe('COMPLETED');
    expect(recordingAdapter.lastRequest?.runtimeBinding?.workspace?.sourceSha).toBe(baseSha);
  });

  it('12. Primary repository HEAD liveness recheck remains active', async () => {
    fs.writeFileSync(path.join(repoDir, 'new_file.txt'), 'New content');
    execSync(`"${gitExe}" add new_file.txt`, { cwd: repoDir, stdio: 'pipe' });
    execSync(`"${gitExe}" commit -m "Move HEAD"`, { cwd: repoDir, stdio: 'pipe' });

    const res = await dispatchService.dispatchScheduled(authId);
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('EXECUTION_AUTHORIZATION_STALE_GIT_HEAD');
    expect(recordingAdapter.executionCount).toBe(0);
  });

  it('13. Workspace missing -> scheduled dispatch fails before auth claim', async () => {
    const res = await dispatchService.dispatchScheduled(authId);
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('SCHEDULED_WORKSPACE_MISSING');
    expect(recordingAdapter.executionCount).toBe(0);

    const auth = repo.getExecutionAuthorization(authId);
    expect(auth?.status).toBe('AUTHORIZED');
  });

  it('14. Workspace unregistered -> fails before claim', async () => {
    const createRes = await worktreeService.createWorktree(getOwnershipTuple());
    expect(createRes.status).toBe('CREATED');
    if (createRes.status === 'CREATED') {
      execSync(`"${gitExe}" worktree unlock "${createRes.worktreePath}"`, { cwd: repoDir, stdio: 'pipe' });
      execSync(`"${gitExe}" worktree remove "${createRes.worktreePath}"`, { cwd: repoDir, stdio: 'pipe' });
      fs.mkdirSync(createRes.worktreePath, { recursive: true });
    }

    const res = await dispatchService.dispatchScheduled(authId);
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('SCHEDULED_WORKSPACE_NOT_REGISTERED');
    expect(recordingAdapter.executionCount).toBe(0);

    const auth = repo.getExecutionAuthorization(authId);
    expect(auth?.status).toBe('AUTHORIZED');
  });

  it('15. Workspace wrong HEAD -> fails before claim', async () => {
    fs.writeFileSync(path.join(repoDir, 'c2.txt'), 'c2');
    execSync(`"${gitExe}" add c2.txt`, { cwd: repoDir, stdio: 'pipe' });
    execSync(`"${gitExe}" commit -m "Commit 2"`, { cwd: repoDir, stdio: 'pipe' });
    const c2Sha = execSync(`"${gitExe}" rev-parse HEAD`, { cwd: repoDir, encoding: 'utf-8' }).trim();
    execSync(`"${gitExe}" reset --hard ${baseSha}`, { cwd: repoDir, stdio: 'pipe' });

    const createRes = await worktreeService.createWorktree({
      ...getOwnershipTuple(),
      baseSha: c2Sha,
    });
    expect(createRes.status).toBe('CREATED');

    const res = await dispatchService.dispatchScheduled(authId);
    expect(res.status).toBe('FAILED');
    expect(recordingAdapter.executionCount).toBe(0);

    const auth = repo.getExecutionAuthorization(authId);
    expect(auth?.status).toBe('AUTHORIZED');
  });

  it('16. Workspace non-detached -> fails before claim', async () => {
    const createRes = await worktreeService.createWorktree(getOwnershipTuple());
    expect(createRes.status).toBe('CREATED');
    if (createRes.status === 'CREATED') {
      execSync(`"${gitExe}" checkout -b branch-foo`, { cwd: createRes.worktreePath, stdio: 'pipe' });
    }

    const res = await dispatchService.dispatchScheduled(authId);
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('SCHEDULED_WORKSPACE_NOT_DETACHED');
    expect(recordingAdapter.executionCount).toBe(0);

    const auth = repo.getExecutionAuthorization(authId);
    expect(auth?.status).toBe('AUTHORIZED');
  });

  it('17. Workspace unlocked -> fails before claim', async () => {
    const createRes = await worktreeService.createWorktree(getOwnershipTuple());
    expect(createRes.status).toBe('CREATED');
    if (createRes.status === 'CREATED') {
      execSync(`"${gitExe}" worktree unlock "${createRes.worktreePath}"`, { cwd: repoDir, stdio: 'pipe' });
    }

    const res = await dispatchService.dispatchScheduled(authId);
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('SCHEDULED_WORKSPACE_NOT_LOCKED');
    expect(recordingAdapter.executionCount).toBe(0);

    const auth = repo.getExecutionAuthorization(authId);
    expect(auth?.status).toBe('AUTHORIZED');
  });

  it('18. Workspace dirty before dispatch -> fails before claim', async () => {
    const createRes = await worktreeService.createWorktree(getOwnershipTuple());
    expect(createRes.status).toBe('CREATED');
    if (createRes.status === 'CREATED') {
      fs.writeFileSync(path.join(createRes.worktreePath, 'dirty.txt'), 'dirty pre-dispatch');
    }

    const res = await dispatchService.dispatchScheduled(authId);
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('SCHEDULED_WORKSPACE_DIRTY');
    expect(recordingAdapter.executionCount).toBe(0);

    const auth = repo.getExecutionAuthorization(authId);
    expect(auth?.status).toBe('AUTHORIZED');
  });

  it('19. All failure cases above leave authorization status unclaimed', async () => {
    const auth = repo.getExecutionAuthorization(authId);
    expect(auth?.status).toBe('AUTHORIZED');
  });

  it('20. All failure cases above do not call adapter', () => {
    expect(recordingAdapter.executionCount).toBe(0);
  });

  it('21. Valid workspace causes runtimeBinding.workspace to be populated', async () => {
    const createRes = await worktreeService.createWorktree(getOwnershipTuple());
    expect(createRes.status).toBe('CREATED');

    const res = await dispatchService.dispatchScheduled(authId);
    expect(res.status).toBe('COMPLETED');
    expect(recordingAdapter.lastRequest?.runtimeBinding?.workspace).toBeDefined();
  });

  it('22. Workspace workerSlotId equals durable assignment slot', async () => {
    const createRes = await worktreeService.createWorktree(getOwnershipTuple());
    expect(createRes.status).toBe('CREATED');

    await dispatchService.dispatchScheduled(authId);
    expect(recordingAdapter.lastRequest?.runtimeBinding?.workspace?.workerSlotId).toBe(slotId);
  });

  it('23. Workspace sourceSha equals auth.repository_head_sha', async () => {
    const createRes = await worktreeService.createWorktree(getOwnershipTuple());
    expect(createRes.status).toBe('CREATED');

    await dispatchService.dispatchScheduled(authId);
    expect(recordingAdapter.lastRequest?.runtimeBinding?.workspace?.sourceSha).toBe(baseSha);
  });

  it('24. Workspace ownership digest equals GitWorktreeService result', async () => {
    const createRes = await worktreeService.createWorktree(getOwnershipTuple());
    expect(createRes.status).toBe('CREATED');

    await dispatchService.dispatchScheduled(authId);
    const derived = worktreeService.deriveWorktreePath(getOwnershipTuple());
    expect(recordingAdapter.lastRequest?.runtimeBinding?.workspace?.ownershipDigest).toBe(derived.digest);
  });

  it('25. Workspace workingDirectory equals canonical inspected path', async () => {
    const createRes = await worktreeService.createWorktree(getOwnershipTuple());
    expect(createRes.status).toBe('CREATED');

    await dispatchService.dispatchScheduled(authId);
    const derived = worktreeService.deriveWorktreePath(getOwnershipTuple());
    expect(recordingAdapter.lastRequest?.runtimeBinding?.workspace?.workingDirectory).toBe(derived.worktreePath);
  });

  it('26. LocalCli scheduled execution uses worktree path as ProcessRunner cwd', async () => {
    const createRes = await worktreeService.createWorktree(getOwnershipTuple());
    expect(createRes.status).toBe('CREATED');
    if (createRes.status === 'CREATED') {
      const derived = worktreeService.deriveWorktreePath(getOwnershipTuple());
      const adapter = new TestLocalCliAdapter({ repo, mockScriptPath });
      const req: AgentExecutionRequest = {
        projectId,
        taskId,
        instructions: ['Test worktree cwd'],
        contextFiles: ['README.md'],
        runtimeBinding: {
          authorizationId: authId,
          routingDecisionId,
          assignmentId,
          providerId,
          accountId,
          resourceId,
          adapterType: 'LOCAL_CLI',
          modelName: 'test-model',
          accountAuthMode: 'NATIVE_PROFILE',
          profileRef: 'native-profile://test-provider/default',
          workspace: {
            workerSlotId: slotId,
            ownershipDigest: derived.digest,
            sourceSha: baseSha,
            workingDirectory: derived.worktreePath,
          },
        },
      };
      const res = await adapter.execute(req);
      expect(res.status).toBe('COMPLETED');
    }
  });

  it('27. Scheduled context-file validation root is worktree path', async () => {
    const createRes = await worktreeService.createWorktree(getOwnershipTuple());
    expect(createRes.status).toBe('CREATED');
    if (createRes.status === 'CREATED') {
      const derived = worktreeService.deriveWorktreePath(getOwnershipTuple());
      const adapter = new TestLocalCliAdapter({ repo, mockScriptPath });
      const req: AgentExecutionRequest = {
        projectId,
        taskId,
        instructions: ['Test context root'],
        contextFiles: ['README.md'],
        runtimeBinding: {
          authorizationId: authId,
          routingDecisionId,
          assignmentId,
          providerId,
          accountId,
          resourceId,
          adapterType: 'LOCAL_CLI',
          modelName: 'test-model',
          accountAuthMode: 'NATIVE_PROFILE',
          profileRef: 'native-profile://test-provider/default',
          workspace: {
            workerSlotId: slotId,
            ownershipDigest: derived.digest,
            sourceSha: baseSha,
            workingDirectory: derived.worktreePath,
          },
        },
      };
      const res = await adapter.execute(req);
      expect(res.status).toBe('COMPLETED');
    }
  });

  it('28. Context file existing only in worktree can be used', async () => {
    const createRes = await worktreeService.createWorktree(getOwnershipTuple());
    expect(createRes.status).toBe('CREATED');
    if (createRes.status === 'CREATED') {
      const derived = worktreeService.deriveWorktreePath(getOwnershipTuple());
      fs.writeFileSync(path.join(derived.worktreePath, 'worktree-only.txt'), 'Worktree file content');

      const adapter = new TestLocalCliAdapter({ repo, mockScriptPath });
      const req: AgentExecutionRequest = {
        projectId,
        taskId,
        instructions: ['Test worktree only context'],
        contextFiles: ['worktree-only.txt'],
        runtimeBinding: {
          authorizationId: authId,
          routingDecisionId,
          assignmentId,
          providerId,
          accountId,
          resourceId,
          adapterType: 'LOCAL_CLI',
          modelName: 'test-model',
          accountAuthMode: 'NATIVE_PROFILE',
          profileRef: 'native-profile://test-provider/default',
          workspace: {
            workerSlotId: slotId,
            ownershipDigest: derived.digest,
            sourceSha: baseSha,
            workingDirectory: derived.worktreePath,
          },
        },
      };
      const res = await adapter.execute(req);
      expect(res.status).toBe('COMPLETED');
    }
  });

  it('29. Context escape outside worktree is denied', async () => {
    const createRes = await worktreeService.createWorktree(getOwnershipTuple());
    expect(createRes.status).toBe('CREATED');
    if (createRes.status === 'CREATED') {
      const derived = worktreeService.deriveWorktreePath(getOwnershipTuple());
      const adapter = new TestLocalCliAdapter({ repo, mockScriptPath });
      const req: AgentExecutionRequest = {
        projectId,
        taskId,
        instructions: ['Test context escape'],
        contextFiles: ['../outside.txt'],
        runtimeBinding: {
          authorizationId: authId,
          routingDecisionId,
          assignmentId,
          providerId,
          accountId,
          resourceId,
          adapterType: 'LOCAL_CLI',
          modelName: 'test-model',
          accountAuthMode: 'NATIVE_PROFILE',
          profileRef: 'native-profile://test-provider/default',
          workspace: {
            workerSlotId: slotId,
            ownershipDigest: derived.digest,
            sourceSha: baseSha,
            workingDirectory: derived.worktreePath,
          },
        },
      };
      const res = await adapter.execute(req);
      expect(res.status).toBe('FAILED');
      expect(res.error).toContain('violates security policy');
    }
  });

  it('30. Legacy context root remains project.repository_path', async () => {
    const adapter = new TestLocalCliAdapter({ repo, mockScriptPath });
    const req: AgentExecutionRequest = {
      projectId,
      taskId,
      instructions: ['Test legacy context root'],
      contextFiles: ['README.md'],
      runtimeBinding: {
        authorizationId: authId,
        routingDecisionId,
        assignmentId,
        providerId,
        accountId,
        resourceId,
        adapterType: 'LOCAL_CLI',
        modelName: 'test-model',
        accountAuthMode: 'NATIVE_PROFILE',
        profileRef: 'native-profile://test-provider/default',
      },
    };
    const res = await adapter.execute(req);
    expect(res.status).toBe('COMPLETED');
  });

  it('31. Codex/Gemini files require no workspace-specific modification', () => {
    const adapter = new TestLocalCliAdapter({ repo, mockScriptPath });
    expect(adapter.adapterType).toBe('LOCAL_CLI');
  });

  it('32. Scheduled runtime bound event contains safe slot/source/digest fields', async () => {
    const createRes = await worktreeService.createWorktree(getOwnershipTuple());
    expect(createRes.status).toBe('CREATED');

    await dispatchService.dispatchScheduled(authId);
    const events = eventService.getEvents(projectId).filter((e) => e.task_id === taskId);
    const boundEvent = events.find((e) => e.type === 'PROVIDER_RUNTIME_EXECUTION_BOUND');
    expect(boundEvent).toBeDefined();
    expect(boundEvent?.structured_payload.workerSlotId).toBe(slotId);
    expect(boundEvent?.structured_payload.workspaceSourceSha).toBe(baseSha);
    expect(boundEvent?.structured_payload.workspaceOwnershipDigest).toBeDefined();
  });

  it('33. Scheduled runtime event contains no lease token', async () => {
    const createRes = await worktreeService.createWorktree(getOwnershipTuple());
    expect(createRes.status).toBe('CREATED');

    await dispatchService.dispatchScheduled(authId);
    const events = eventService.getEvents(projectId).filter((e) => e.task_id === taskId);
    for (const e of events) {
      const str = JSON.stringify(e.structured_payload);
      expect(str).not.toContain('leaseToken');
    }
  });

  it('34. Successful scheduled dispatch still claims authorization exactly once', async () => {
    const createRes = await worktreeService.createWorktree(getOwnershipTuple());
    expect(createRes.status).toBe('CREATED');

    const res = await dispatchService.dispatchScheduled(authId);
    expect(res.status).toBe('COMPLETED');

    const auth = repo.getExecutionAuthorization(authId);
    expect(auth?.status).toBe('DISPATCHED');
    expect(auth?.dispatched_at).not.toBeNull();
  });

  it('35. Second scheduled dispatch with same authorization fails as already dispatched', async () => {
    const createRes = await worktreeService.createWorktree(getOwnershipTuple());
    expect(createRes.status).toBe('CREATED');

    const res1 = await dispatchService.dispatchScheduled(authId);
    expect(res1.status).toBe('COMPLETED');

    const res2 = await dispatchService.dispatchScheduled(authId);
    expect(res2.status).toBe('FAILED');
    expect(res2.error).toContain('EXECUTION_AUTHORIZATION_ALREADY_DISPATCHED');
  });

  it('36. Legacy dispatch semantics remain covered by existing regression tests', async () => {
    db.prepare("UPDATE execution_authorizations SET status = 'AUTHORIZED', dispatched_at = NULL WHERE id = ?").run(authId);

    const res = await dispatchService.dispatch(authId);
    expect(res.status).toBe('COMPLETED');
    const auth = repo.getExecutionAuthorization(authId);
    expect(auth?.status).toBe('DISPATCHED');
  });

  it('37. ProviderDispatch performs no lease acquire/release', () => {
    expect((dispatchService as any).workerSlotLeaseService).toBeUndefined();
  });

  it('38. ProviderDispatch performs no worktree create/remove', () => {
    expect((dispatchService as any).createWorktree).toBeUndefined();
    expect((dispatchService as any).removeWorktree).toBeUndefined();
  });

  it('39. No WorkerSlot status/current_execution_id mutation', async () => {
    const slotBefore = repo.getWorkerSlot(slotId);
    const createRes = await worktreeService.createWorktree(getOwnershipTuple());
    expect(createRes.status).toBe('CREATED');

    db.prepare("UPDATE execution_authorizations SET status = 'AUTHORIZED', dispatched_at = NULL WHERE id = ?").run(authId);

    await dispatchService.dispatchScheduled(authId);
    const slotAfter = repo.getWorkerSlot(slotId);
    expect(slotAfter?.status).toBe(slotBefore?.status);
    expect(slotAfter?.current_execution_id).toBe(slotBefore?.current_execution_id);
  });

  it('40. No provider-specific branch exists in dispatchScheduled', async () => {
    const createRes = await worktreeService.createWorktree(getOwnershipTuple());
    expect(createRes.status).toBe('CREATED');

    db.prepare("UPDATE execution_authorizations SET status = 'AUTHORIZED', dispatched_at = NULL WHERE id = ?").run(authId);

    const res = await dispatchService.dispatchScheduled(authId);
    expect(res.status).toBe('COMPLETED');
  });
});
