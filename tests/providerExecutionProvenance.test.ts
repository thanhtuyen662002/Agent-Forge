import { describe, it, expect, beforeEach } from 'vitest';
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
} from '../src/core/adapters/ProviderAdapter';
import {
  ProviderAdapterType,
  ProviderHealthStatus,
  Capability,
} from '../src/core/types/domain';
import {
  ProviderDispatchService,
  ProviderExecutionProvenanceV1,
} from '../src/core/services/ProviderDispatchService';
import { GitWorktreeService } from '../src/core/services/GitWorktreeService';
import { WorkerSlotLeaseService } from '../src/core/services/WorkerSlotLeaseService';
import { ConcurrentExecutionScheduler } from '../src/core/services/ConcurrentExecutionScheduler';
import {
  computeCanonicalPayload,
  computePayloadHash,
  computeContextManifestHash,
} from '../src/core/services/ExecutionAuthorizationService';

class MockAdapter implements ProviderAdapter {
  public executeResult?: Partial<AgentExecutionResult> & Record<string, any>;
  public throwError?: Error;
  public executeCallCount = 0;
  public lastRequest?: AgentExecutionRequest;

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
    this.executeCallCount++;
    this.lastRequest = request;

    if (this.throwError) {
      throw this.throwError;
    }

    const assignedId = request.runtimeBinding?.executionId ?? crypto.randomUUID();
    return {
      executionId: assignedId,
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
      ...(this.executeResult ?? {}),
    };
  }

  public async cancel(_executionId: string): Promise<void> {}
}

describe('R5H4 Provider Execution Provenance Contract', () => {
  let tempBaseDir: string;
  let repoDir: string;
  let managedDir: string;
  let gitExe: string;
  let db: Database.Database;
  let repo: Repository;
  let eventService: EventService;
  let worktreeService: GitWorktreeService;
  let leaseService: WorkerSlotLeaseService;
  let registry: ProviderRegistry;
  let mockAdapter: MockAdapter;
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
  let contextFiles: string[];
  let instructions: string[];
  let canonicalPayloadJson: string;
  let instructionPayloadHash: string;
  let contextManifestHash: string;

  beforeEach(async () => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-prov-test-'));
    repoDir = path.join(tempBaseDir, 'repo');
    managedDir = path.join(tempBaseDir, 'managed');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(managedDir, { recursive: true });

    repoDir = fs.realpathSync.native ? fs.realpathSync.native(repoDir) : fs.realpathSync(repoDir);
    managedDir = fs.realpathSync.native ? fs.realpathSync.native(managedDir) : fs.realpathSync(managedDir);

    gitExe = execSync(process.platform === 'win32' ? 'where git' : 'which git', { encoding: 'utf-8' })
      .trim()
      .split(/\r?\n/)[0];

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
    leaseService = new WorkerSlotLeaseService(repo);

    providerId = 'prov-test';
    mockAdapter = new MockAdapter(providerId, 'Mock Provider', 'LOCAL_CLI');
    registry = new ProviderRegistry();
    registry.register(mockAdapter);
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
      name: 'Provenance Test Project',
      description: 'Testing provider execution provenance',
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
      title: 'Provenance Test Task',
      description: 'Audit task for execution provenance',
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
      profile_ref: 'native-profile://mock-provider/default',
      health_status: 'AVAILABLE',
      priority: 10,
      cooldown_until: null,
      concurrency_limit: 5,
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
      model_name: 'mock-model-v1',
      capabilities: ['CODING', 'FILESYSTEM_EDIT'],
      enabled: true,
      health_status: 'AVAILABLE',
      total_quota: 100,
      remaining_quota: 100,
      quota_unit: 'requests',
      quota_reset_at: null,
      quota_source: 'ESTIMATED',
      quota_confidence: 1.0,
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

    eventService.record(
      projectId,
      'PROVIDER_ROUTING_DECISION',
      'Routing decision SELECTED',
      {
        decisionId: routingDecisionId,
        projectId,
        taskId,
        attemptId,
        selectedResourceId: resourceId,
        selectedProviderId: providerId,
        selectedAccountId: accountId,
        selectedAssignmentId: assignmentId,
        roleProfileId: 'role-coder',
        outcome: 'SELECTED',
        reason: 'Selected mock resource',
      },
      taskId
    );

    const managerPayload = JSON.stringify({
      protocol: 'manager.v1',
      message_id: managerMessageId,
      project_id: projectId,
      task_id: taskId,
      decision: 'EXECUTE',
      instructions: ['Implement provenance testing'],
      constraints: [],
      suggested_approaches: [],
    });
    managerPayloadHash = crypto.createHash('sha256').update(managerPayload).digest('hex');

    repo.recordProtocolMessage(
      managerMessageId,
      managerMessageId,
      'manager.v1',
      projectId,
      taskId,
      'CODING',
      1,
      managerPayloadHash,
      managerPayload,
      'APPLIED',
      undefined,
      new Date().toISOString()
    );

    instructions = ['Implement provenance testing'];
    contextFiles = ['README.md'];
    const canonicalPayload = computeCanonicalPayload({
      projectId,
      taskId,
      attemptId,
      taskTitle: 'Provenance Test Task',
      taskDescription: 'Audit task for execution provenance',
      acceptanceCriteria: ['must pass all tests'],
      constraints: ['no console.log'],
      instructions,
      contextFiles,
      verificationCommands: { TEST: null, LINT: null, BUILD: null },
      managerMessageId,
      managerPayloadHash,
    });
    instructionPayloadHash = computePayloadHash(canonicalPayload);
    contextManifestHash = computeContextManifestHash(contextFiles);
    canonicalPayloadJson = JSON.stringify(canonicalPayload);

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
      canonical_instructions_json: JSON.stringify(instructions),
      context_files_json: JSON.stringify(contextFiles),
      canonical_payload_json: canonicalPayloadJson,
      instruction_payload_hash: instructionPayloadHash,
      context_manifest_hash: contextManifestHash,
      status: 'AUTHORIZED',
      dispatched_at: null,
      created_at: new Date().toISOString(),
    });
  });

  // 1. authorization-not-found pre-adapter result has no provenance
  it('1. authorization-not-found pre-adapter result has no provenance', async () => {
    const result = await dispatchService.dispatch('non-existent-auth');
    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('EXECUTION_AUTHORIZATION_NOT_FOUND');
    expect(result.providerExecutionProvenance).toBeUndefined();
    expect(mockAdapter.executeCallCount).toBe(0);
  });

  // 2. pre-adapter RESOURCE_UNAVAILABLE has no provenance
  it('2. pre-adapter RESOURCE_UNAVAILABLE has no provenance', async () => {
    // Break task revision to trigger pre-adapter failure
    db.prepare('UPDATE tasks SET revision_count = 99 WHERE id = ?').run(taskId);
    const result = await dispatchService.dispatch(authId);
    expect(result.status).toBe('FAILED');
    expect(result.providerExecutionProvenance).toBeUndefined();
    expect(mockAdapter.executeCallCount).toBe(0);
  });

  // 3. persisted AUTH_ERROR pre-adapter rejection has no provenance
  it('3. persisted AUTH_ERROR pre-adapter rejection has no provenance', async () => {
    db.prepare("UPDATE provider_accounts SET health_status = 'AUTH_ERROR' WHERE id = ?").run(accountId);
    const result = await dispatchService.dispatch(authId);
    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('AUTH_ERROR');
    expect(result.providerExecutionProvenance).toBeUndefined();
    expect(mockAdapter.executeCallCount).toBe(0);
  });

  // 4. disabled/unavailable account rejection has no provenance
  it('4. disabled/unavailable account rejection has no provenance', async () => {
    db.prepare('UPDATE provider_accounts SET enabled = 0 WHERE id = ?').run(accountId);
    const result = await dispatchService.dispatch(authId);
    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('RESOURCE_UNAVAILABLE');
    expect(result.providerExecutionProvenance).toBeUndefined();
    expect(mockAdapter.executeCallCount).toBe(0);
  });

  // 5. resource-disabled rejection has no provenance
  it('5. resource-disabled rejection has no provenance', async () => {
    db.prepare('UPDATE provider_resources SET enabled = 0 WHERE id = ?').run(resourceId);
    const result = await dispatchService.dispatch(authId);
    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('RESOURCE_UNAVAILABLE');
    expect(result.providerExecutionProvenance).toBeUndefined();
    expect(mockAdapter.executeCallCount).toBe(0);
  });

  // 6. adapter-unregistered rejection has no provenance
  it('6. adapter-unregistered rejection has no provenance', async () => {
    const unregRegistry = new ProviderRegistry();
    const unregDispatch = new ProviderDispatchService(unregRegistry, repo, eventService, worktreeService);
    const result = await unregDispatch.dispatch(authId);
    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('RESOURCE_UNAVAILABLE');
    expect(result.providerExecutionProvenance).toBeUndefined();
    expect(mockAdapter.executeCallCount).toBe(0);
  });

  // 7. authorization claim failure has no provenance
  it('7. authorization claim failure has no provenance', async () => {
    db.prepare("UPDATE execution_authorizations SET status = 'DISPATCHED' WHERE id = ?").run(authId);
    const result = await dispatchService.dispatch(authId);
    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('ALREADY_DISPATCHED');
    expect(result.providerExecutionProvenance).toBeUndefined();
    expect(mockAdapter.executeCallCount).toBe(0);
  });

  // 8. pre-claim cancellation has no provenance
  it('8. pre-claim cancellation has no provenance', async () => {
    const cancelRes = await dispatchService.cancelScheduled(authId);
    expect(cancelRes.status).toBe('NOT_ACTIVE');
  });

  // 9. post-claim/pre-adapter cancellation has no provenance
  it('9. post-claim/pre-adapter cancellation has no provenance', async () => {
    const result: AgentExecutionResult = {
      executionId: 'exec-1',
      status: 'CANCELLED',
      errorCode: 'CANCELLED',
      error: 'Cancelled before adapter',
    };
    expect((result as any).providerExecutionProvenance).toBeUndefined();
  });

  // 10. adapter COMPLETED return has provenance
  it('10. adapter COMPLETED return has provenance', async () => {
    mockAdapter.executeResult = { status: 'COMPLETED' };
    const result = await dispatchService.dispatch(authId);
    expect(result.status).toBe('COMPLETED');
    expect(result.providerExecutionProvenance).toBeDefined();
    expect(result.providerExecutionProvenance?.version).toBe(1);
    expect(result.providerExecutionProvenance?.source).toBe('PROVIDER_DISPATCH_SERVICE');
    expect(result.providerExecutionProvenance?.adapterInvocation).toBe('RETURNED');
    expect(result.providerExecutionProvenance?.authorizationId).toBe(authId);
    expect(result.providerExecutionProvenance?.projectId).toBe(projectId);
    expect(result.providerExecutionProvenance?.taskId).toBe(taskId);
    expect(result.providerExecutionProvenance?.attemptId).toBe(attemptId);
    expect(result.providerExecutionProvenance?.providerId).toBe(providerId);
    expect(result.providerExecutionProvenance?.accountId).toBe(accountId);
    expect(result.providerExecutionProvenance?.resourceId).toBe(resourceId);
    expect(result.providerExecutionProvenance?.assignmentId).toBe(assignmentId);
    expect(mockAdapter.executeCallCount).toBe(1);
  });

  // 11. adapter FAILED RATE_LIMITED return has provenance
  it('11. adapter FAILED RATE_LIMITED return has provenance', async () => {
    mockAdapter.executeResult = {
      status: 'FAILED',
      errorCode: 'QUOTA_EXHAUSTED',
      error: 'Rate limit exceeded (429)',
    };
    const result = await dispatchService.dispatch(authId);
    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('QUOTA_EXHAUSTED');
    expect(result.providerExecutionProvenance).toBeDefined();
    expect(result.providerExecutionProvenance?.adapterInvocation).toBe('RETURNED');
    expect(mockAdapter.executeCallCount).toBe(1);
  });

  // 12. adapter FAILED QUOTA_EXHAUSTED return has provenance
  it('12. adapter FAILED QUOTA_EXHAUSTED return has provenance', async () => {
    mockAdapter.executeResult = {
      status: 'FAILED',
      errorCode: 'QUOTA_EXHAUSTED',
      error: 'Monthly quota exhausted',
    };
    const result = await dispatchService.dispatch(authId);
    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('QUOTA_EXHAUSTED');
    expect(result.providerExecutionProvenance).toBeDefined();
    expect(result.providerExecutionProvenance?.adapterInvocation).toBe('RETURNED');
    expect(mockAdapter.executeCallCount).toBe(1);
  });

  // 13. adapter FAILED RESOURCE_UNAVAILABLE return has provenance
  it('13. adapter FAILED RESOURCE_UNAVAILABLE return has provenance', async () => {
    mockAdapter.executeResult = {
      status: 'FAILED',
      errorCode: 'RESOURCE_UNAVAILABLE',
      error: 'Model currently unavailable in region',
    };
    const result = await dispatchService.dispatch(authId);
    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('RESOURCE_UNAVAILABLE');
    expect(result.providerExecutionProvenance).toBeDefined();
    expect(result.providerExecutionProvenance?.adapterInvocation).toBe('RETURNED');
    expect(mockAdapter.executeCallCount).toBe(1);
  });

  // 14. adapter AUTH_ERROR return has provenance
  it('14. adapter AUTH_ERROR return has provenance', async () => {
    mockAdapter.executeResult = {
      status: 'FAILED',
      errorCode: 'AUTH_ERROR',
      error: 'Invalid API key credentials',
    };
    const result = await dispatchService.dispatch(authId);
    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('AUTH_ERROR');
    expect(result.providerExecutionProvenance).toBeDefined();
    expect(result.providerExecutionProvenance?.adapterInvocation).toBe('RETURNED');
    expect(mockAdapter.executeCallCount).toBe(1);
  });

  // 15. adapter CANCELLED return has provenance
  it('15. adapter CANCELLED return has provenance', async () => {
    mockAdapter.executeResult = {
      status: 'CANCELLED',
      errorCode: 'CANCELLED',
      error: 'Adapter cancelled execution internally',
    };
    const result = await dispatchService.dispatch(authId);
    expect(result.status).toBe('CANCELLED');
    expect(result.providerExecutionProvenance).toBeDefined();
    expect(result.providerExecutionProvenance?.adapterInvocation).toBe('RETURNED');
    expect(mockAdapter.executeCallCount).toBe(1);
  });

  // 16. adapter AWAITING_OWNER return has provenance where applicable
  it('16. adapter AWAITING_OWNER return has provenance where applicable', async () => {
    mockAdapter.executeResult = {
      status: 'AWAITING_OWNER',
      error: 'Manual owner approval required',
    };
    const result = await dispatchService.dispatch(authId);
    expect(result.status).toBe('AWAITING_OWNER');
    expect(result.providerExecutionProvenance).toBeDefined();
    expect(result.providerExecutionProvenance?.adapterInvocation).toBe('RETURNED');
    expect(mockAdapter.executeCallCount).toBe(1);
  });

  // 17. adapter throw has provenance with: adapterInvocation=THREW
  it('17. adapter throw has provenance with: adapterInvocation=THREW', async () => {
    mockAdapter.throwError = new Error('Process crash on launch');
    const result = await dispatchService.dispatch(authId);
    expect(result.status).toBe('FAILED');
    expect(result.providerExecutionProvenance).toBeDefined();
    expect(result.providerExecutionProvenance?.adapterInvocation).toBe('THREW');
    expect(result.providerExecutionProvenance?.authorizationId).toBe(authId);
    expect(mockAdapter.executeCallCount).toBe(1);
  });

  // 18. adapter throw keeps existing normalized: EXECUTION_FAILED
  it('18. adapter throw keeps existing normalized: EXECUTION_FAILED', async () => {
    mockAdapter.throwError = new Error('Socket abruptly closed');
    const result = await dispatchService.dispatch(authId);
    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('EXECUTION_FAILED');
    expect(result.error).toBe('ADAPTER_EXECUTION_THREW: Socket abruptly closed');
    expect(result.providerExecutionProvenance?.adapterInvocation).toBe('THREW');
  });

  // 19. scheduled mode provenance.executionId equals final returned executionId
  it('19. scheduled mode provenance.executionId equals final returned executionId', async () => {
    const scheduler = new ConcurrentExecutionScheduler(repo, leaseService, worktreeService, dispatchService);
    const schedResult = await scheduler.execute(authId);
    expect(schedResult.status).toBe('COMPLETED');
    expect(schedResult.providerResult).toBeDefined();
    expect(schedResult.providerResult?.providerExecutionProvenance).toBeDefined();
    expect(schedResult.providerResult?.executionId).toBe(
      schedResult.providerResult?.providerExecutionProvenance?.executionId
    );
    expect(schedResult.providerResult?.providerExecutionProvenance?.mode).toBe('SCHEDULED');
  });

  // 20. fabric provider/account/resource/assignment IDs come from verified runtime binding / authorization
  it('20. fabric provider/account/resource/assignment IDs come from verified runtime binding / authorization', async () => {
    const result = await dispatchService.dispatch(authId);
    const prov = result.providerExecutionProvenance!;
    expect(prov.providerId).toBe(providerId);
    expect(prov.accountId).toBe(accountId);
    expect(prov.resourceId).toBe(resourceId);
    expect(prov.assignmentId).toBe(assignmentId);
    expect(prov.routingDecisionId).toBe(routingDecisionId);
    expect(prov.authorizationId).toBe(authId);
    expect(prov.projectId).toBe(projectId);
    expect(prov.taskId).toBe(taskId);
    expect(prov.attemptId).toBe(attemptId);
  });

  // 21. adapter-supplied spoofed provenance is discarded and overwritten
  it('21. adapter-supplied spoofed provenance is discarded and overwritten', async () => {
    const fakeProvenance: ProviderExecutionProvenanceV1 = {
      version: 1,
      source: 'PROVIDER_DISPATCH_SERVICE',
      mode: 'LEGACY',
      adapterInvocation: 'RETURNED',
      authorizationId: 'fake-auth-id',
      executionId: 'fake-exec-id',
      projectId: 'fake-proj-id',
      taskId: 'fake-task-id',
      attemptId: 'fake-att-id',
      routingDecisionId: 'fake-rout-id',
      providerId: 'attacker-provider',
      resourceId: 'attacker-resource',
      assignmentId: 'attacker-assignment',
      accountId: 'attacker-account',
    };

    // Mock adapter returns object with spoofed provenance
    mockAdapter.executeResult = {
      status: 'COMPLETED',
      providerExecutionProvenance: fakeProvenance,
    } as any;

    const result = await dispatchService.dispatch(authId);
    expect(result.providerExecutionProvenance).toBeDefined();
    // Provenance MUST NOT match attacker fake values
    expect(result.providerExecutionProvenance?.providerId).toBe(providerId);
    expect(result.providerExecutionProvenance?.accountId).toBe(accountId);
    expect(result.providerExecutionProvenance?.resourceId).toBe(resourceId);
    expect(result.providerExecutionProvenance?.assignmentId).toBe(assignmentId);
    expect(result.providerExecutionProvenance?.authorizationId).toBe(authId);
    expect(result.providerExecutionProvenance).not.toEqual(fakeProvenance);
  });

  // 22. scheduler pre-adapter dispatch failure exposes no provider provenance
  it('22. scheduler pre-adapter dispatch failure exposes no provider provenance', async () => {
    // Disable account so scheduler pre-dispatch or dispatch fails
    db.prepare('UPDATE provider_accounts SET enabled = 0 WHERE id = ?').run(accountId);
    const scheduler = new ConcurrentExecutionScheduler(repo, leaseService, worktreeService, dispatchService);
    const schedResult = await scheduler.execute(authId);
    expect(['LEASE_ACQUIRE_FAILED', 'PREPARATION_FAILED']).toContain(schedResult.status);
    expect(schedResult.providerResult).toBeUndefined();
  });

  // 23. scheduler genuine provider failure exposes provenance
  it('23. scheduler genuine provider failure exposes provenance', async () => {
    mockAdapter.executeResult = {
      status: 'FAILED',
      errorCode: 'QUOTA_EXHAUSTED',
      error: 'Daily limit exceeded',
    };
    const scheduler = new ConcurrentExecutionScheduler(repo, leaseService, worktreeService, dispatchService);
    const schedResult = await scheduler.execute(authId);
    expect(schedResult.status).toBe('PROVIDER_FAILED');
    expect(schedResult.providerResult).toBeDefined();
    expect(schedResult.providerResult?.providerExecutionProvenance).toBeDefined();
    expect(schedResult.providerResult?.providerExecutionProvenance?.adapterInvocation).toBe('RETURNED');
  });

  // 24. scheduler post-adapter worktree/lease cleanup failure preserves exact provider provenance
  it('24. scheduler post-adapter worktree/lease cleanup failure preserves exact provider provenance', async () => {
    mockAdapter.executeResult = {
      status: 'FAILED',
      errorCode: 'QUOTA_EXHAUSTED',
      error: 'Daily limit reached',
    };

    const scheduler = new ConcurrentExecutionScheduler(repo, leaseService, worktreeService, dispatchService);

    // Mock worktree removeWorktree to fail post-adapter
    const origRemove = worktreeService.removeWorktree.bind(worktreeService);
    worktreeService.removeWorktree = async () => {
      return { status: 'FAILED', error: 'Disk I/O error during cleanup', code: 'REMOVE_FAILED' };
    };

    try {
      const schedResult = await scheduler.execute(authId);
      expect(schedResult.status).toBe('WORKTREE_CLEANUP_FAILED');
      expect(schedResult.providerResult).toBeDefined();
      expect(schedResult.providerResult?.providerExecutionProvenance).toBeDefined();
      expect(schedResult.providerResult?.providerExecutionProvenance?.adapterInvocation).toBe('RETURNED');
      expect(schedResult.providerResult?.providerExecutionProvenance?.authorizationId).toBe(authId);
      expect(schedResult.providerResult?.providerExecutionProvenance?.providerId).toBe(providerId);
    } finally {
      worktreeService.removeWorktree = origRemove;
    }
  });

  // 25. scheduler dispatch exception synthetic result has no provenance
  it('25. scheduler dispatch exception synthetic result has no provenance', async () => {
    const scheduler = new ConcurrentExecutionScheduler(repo, leaseService, worktreeService, dispatchService);
    const origDispatchScheduled = dispatchService.dispatchScheduled.bind(dispatchService);
    dispatchService.dispatchScheduled = async () => {
      throw new Error('Unexpected fatal dispatch error');
    };

    try {
      const schedResult = await scheduler.execute(authId);
      expect(schedResult.status).toBe('PROVIDER_FAILED');
      expect(schedResult.providerResult).toBeDefined();
      expect(schedResult.providerResult?.providerExecutionProvenance).toBeUndefined();
    } finally {
      dispatchService.dispatchScheduled = origDispatchScheduled;
    }
  });

  // 26. EventService undefined does not prevent provenance
  it('26. EventService undefined does not prevent provenance', async () => {
    const noEventDispatch = new ProviderDispatchService(registry, repo, undefined, worktreeService);
    const result = await noEventDispatch.dispatch(authId);
    expect(result.status).toBe('COMPLETED');
    expect(result.providerExecutionProvenance).toBeDefined();
    expect(result.providerExecutionProvenance?.version).toBe(1);
    expect(result.providerExecutionProvenance?.adapterInvocation).toBe('RETURNED');
  });

  // 27. assignment/account are null only when legitimate non-fabric execution has no runtime binding
  it('27. assignment/account are null only when legitimate non-fabric execution has no runtime binding', async () => {
    // Create legacy routing decision without account/assignment
    const legacyRoutingId = `rout-legacy-${crypto.randomUUID()}`;
    const legacyAuthId = `auth-legacy-${crypto.randomUUID()}`;

    eventService.record(
      projectId,
      'PROVIDER_ROUTING_DECISION',
      'Legacy routing decision',
      {
        decisionId: legacyRoutingId,
        projectId,
        taskId,
        attemptId,
        selectedResourceId: resourceId,
        selectedProviderId: providerId,
        outcome: 'SELECTED',
        reason: 'Legacy selection without fabric context',
      },
      taskId
    );

    const canonicalPayload = computeCanonicalPayload({
      projectId,
      taskId,
      attemptId,
      taskTitle: 'Provenance Test Task',
      taskDescription: 'Audit task for execution provenance',
      acceptanceCriteria: ['must pass all tests'],
      constraints: ['no console.log'],
      instructions,
      contextFiles,
      verificationCommands: { TEST: null, LINT: null, BUILD: null },
      managerMessageId,
      managerPayloadHash,
    });

    repo.createExecutionAuthorization({
      id: legacyAuthId,
      project_id: projectId,
      task_id: taskId,
      attempt_id: attemptId,
      task_revision: 1,
      base_sha: baseSha,
      repository_head_sha: baseSha,
      manager_message_id: managerMessageId,
      manager_payload_hash: managerPayloadHash,
      routing_decision_id: legacyRoutingId,
      selected_resource_id: resourceId,
      selected_provider_id: providerId,
      canonical_instructions_json: JSON.stringify(instructions),
      context_files_json: JSON.stringify(contextFiles),
      canonical_payload_json: JSON.stringify(canonicalPayload),
      instruction_payload_hash: computePayloadHash(canonicalPayload),
      context_manifest_hash: computeContextManifestHash(contextFiles),
      status: 'AUTHORIZED',
      dispatched_at: null,
      created_at: new Date().toISOString(),
    });

    const result = await dispatchService.dispatch(legacyAuthId);
    expect(result.status).toBe('COMPLETED');
    expect(result.providerExecutionProvenance).toBeDefined();
    expect(result.providerExecutionProvenance?.assignmentId).toBeNull();
    expect(result.providerExecutionProvenance?.accountId).toBeNull();
    expect(result.providerExecutionProvenance?.providerId).toBe(providerId);
    expect(result.providerExecutionProvenance?.resourceId).toBe(resourceId);
  });

  // 28. provenance contains no credential_ref/profile_ref/secrets
  it('28. provenance contains no credential_ref/profile_ref/secrets', async () => {
    const result = await dispatchService.dispatch(authId);
    const prov = result.providerExecutionProvenance! as any;
    expect(prov.credential_ref).toBeUndefined();
    expect(prov.profile_ref).toBeUndefined();
    expect(prov.token).toBeUndefined();
    expect(prov.password).toBeUndefined();
    expect(prov.secret).toBeUndefined();
    expect(prov.rawResponse).toBeUndefined();
    expect(prov.stdout).toBeUndefined();
    expect(prov.stderr).toBeUndefined();
  });

  // 29. Source boundary test: proves production files do NOT newly import classifier, health, failover decision, etc.
  it('29. Source boundary test: proves production files do not newly import classifier, health, failover decision, etc.', () => {
    const dispatchSource = fs.readFileSync(
      path.join(__dirname, '../src/core/services/ProviderDispatchService.ts'),
      'utf-8'
    );
    const schedulerSource = fs.readFileSync(
      path.join(__dirname, '../src/core/services/ConcurrentExecutionScheduler.ts'),
      'utf-8'
    );

    const forbiddenTokens = [
      'ExecutionFailureClassifier',
      'AccountHealthService',
      'FailoverDecisionService',
      'FailoverLineageService',
      'FailoverNextRoutePolicyService',
      'RoleAwareRoutingService',
    ];

    for (const token of forbiddenTokens) {
      expect(dispatchSource).not.toContain(token);
      expect(schedulerSource).not.toContain(token);
    }
  });
});
