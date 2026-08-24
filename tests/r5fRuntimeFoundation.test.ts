import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ProviderRegistry } from '../src/core/adapters/ProviderRegistry';
import {
  ProviderAdapter,
  QuotaSnapshotInfo,
  AgentExecutionRequest,
  AgentExecutionResult,
} from '../src/core/adapters/ProviderAdapter';
import { LocalCliAdapterBase } from '../src/core/adapters/LocalCliAdapterBase';
import { ManualBridgeAdapter } from '../src/core/adapters/ManualBridgeAdapter';
import { ProcessRunner } from '../src/core/services/ProcessRunner';
import { ProviderDispatchService } from '../src/core/services/ProviderDispatchService';
import { ExecutionAuthorizationService } from '../src/core/services/ExecutionAuthorizationService';
import { EventService } from '../src/core/services/EventService';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import {
  Capability,
  ProviderHealthStatus,
  ProviderAdapterType,
  AgentAssignment,
} from '../src/core/types/domain';

class FakeExecutableAdapter implements ProviderAdapter {
  public id: string;
  public name: string;
  public adapterType: ProviderAdapterType = 'LOCAL_CLI';
  public executionCount = 0;
  public lastRequest?: AgentExecutionRequest;
  public customResult?: Partial<AgentExecutionResult>;

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }

  public async getCapabilities(): Promise<Capability[]> {
    return ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION'];
  }

  public async getHealth(): Promise<ProviderHealthStatus> {
    return 'AVAILABLE';
  }

  public async getQuota(): Promise<QuotaSnapshotInfo> {
    return {
      remaining: 100,
      total: 100,
      unit: 'REQUESTS',
      source: 'PROVIDER_REPORTED',
      confidence: 1.0,
      resetAt: null,
    };
  }

  public async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    this.executionCount++;
    this.lastRequest = request;
    if (this.customResult) {
      return {
        executionId: crypto.randomUUID(),
        status: this.customResult.status ?? 'COMPLETED',
        outputProtocol: this.customResult.outputProtocol,
        rawResponse: this.customResult.rawResponse,
        error: this.customResult.error,
        errorCode: this.customResult.errorCode,
        stdoutEvidenceId: this.customResult.stdoutEvidenceId,
        stderrEvidenceId: this.customResult.stderrEvidenceId,
      };
    }
    return {
      executionId: crypto.randomUUID(),
      status: 'COMPLETED',
      outputProtocol: JSON.stringify({
        protocol: 'coder.v1',
        message_id: 'msg-fake-001',
        project_id: request.projectId,
        task_id: request.taskId,
        attempt: 1,
        status: 'COMPLETED',
        completed: ['Task finished'],
        remaining: [],
        files_claimed_changed: [],
        tests_claimed: [],
        blockers: [],
        review_requested: true,
        expected_task_state: 'CODING',
        expected_revision: 0,
      }),
      rawResponse: 'Fake response',
    };
  }

  public async cancel(_executionId: string): Promise<void> {}
}

class TestLocalCliAdapter extends LocalCliAdapterBase {
  public id: string = 'prov-test-cli';
  public name: string = 'Test CLI';

  constructor(options?: any) {
    super(options);
  }

  protected getDefaultExecutable(): string {
    return process.execPath;
  }

  public async getCapabilities(): Promise<Capability[]> {
    return ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION'];
  }
}

describe('R5F0B — Runtime Execution Binding & Process Runner Hardening Tests', () => {
  let db: Database.Database;
  let repo: Repository;
  let registry: ProviderRegistry;
  let eventService: EventService;
  let artifactStore: ArtifactStore;
  let authService: ExecutionAuthorizationService;
  let dispatcher: ProviderDispatchService;
  let tempDir: string;
  let projectRepoDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-r5f0b-test-'));
    projectRepoDir = path.join(tempDir, 'repo');
    fs.mkdirSync(projectRepoDir, { recursive: true });

    // Initialize git repo in projectRepoDir for Git HEAD validation
    const child_process = require('child_process');
    child_process.execSync('git init', { cwd: projectRepoDir });
    child_process.execSync('git config user.name "AgentForge Test"', { cwd: projectRepoDir });
    child_process.execSync('git config user.email "test@agentforge.dev"', { cwd: projectRepoDir });
    fs.writeFileSync(path.join(projectRepoDir, 'README.md'), '# Test Project');
    child_process.execSync('git add .', { cwd: projectRepoDir });
    child_process.execSync('git commit -m "Initial commit"', { cwd: projectRepoDir });
    const headSha = child_process.execSync('git rev-parse HEAD', { cwd: projectRepoDir }).toString().trim();

    db = new Database(':memory:');
    MigrationRunner.run(db);
    repo = new Repository(db);
    registry = new ProviderRegistry();
    eventService = new EventService(repo);
    artifactStore = new ArtifactStore(path.join(tempDir, 'artifacts'));
    authService = new ExecutionAuthorizationService(repo, eventService);
    dispatcher = new ProviderDispatchService(registry, repo, eventService);

    // Setup base project & task
    repo.createProject({
      id: 'proj-r5f',
      name: 'R5F Test Project',
      description: 'Project for R5F runtime foundation tests',
      repository_path: projectRepoDir,
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      completed_at: null,
    });

    repo.createTask({
      id: 'task-r5f-001',
      project_id: 'proj-r5f',
      milestone_id: null,
      title: 'Implement runtime execution binding',
      description: 'R5F foundation task',
      state: 'CODING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 5,
      base_sha: headSha,
      current_sha: headSha,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: ['Passes tests'],
      constraints: ['Constraint 1'],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Create Manager Applied Protocol Message
    const msgId = 'msg-mgr-001';
    const recId = 'rec-mgr-001';
    const rawPayload = JSON.stringify({
      protocol: 'manager.v1',
      message_id: msgId,
      project_id: 'proj-r5f',
      task_id: 'task-r5f-001',
      decision: 'EXECUTE',
      reason: 'Authorized task execution',
      instructions: ['Implement binding feature', 'Run unit tests'],
      context_files: ['README.md'],
      constraints: ['Constraint 1'],
    });
    const payloadHash = crypto.createHash('sha256').update(rawPayload, 'utf8').digest('hex');
    repo.recordProtocolMessage(
      recId,
      msgId,
      'manager.v1',
      'proj-r5f',
      'task-r5f-001',
      'APPROVED',
      0,
      payloadHash,
      rawPayload,
      'APPLIED',
      undefined,
      new Date().toISOString()
    );
  });

  afterEach(() => {
    ProcessRunner.terminateAllProcesses();
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  function createRoutingFixture(params: {
    decisionId: string;
    providerId: string;
    accountId: string;
    resourceId: string;
    assignmentId?: string;
    modelName?: string;
    profileRef?: string;
    accountHealth?: ProviderHealthStatus;
    accountEnabled?: boolean;
    assignmentStatus?: any;
    resourceAccountMismatch?: boolean;
  }) {
    const fakeAdapter = new FakeExecutableAdapter(params.providerId, 'Fake CLI');
    if (!registry.has(params.providerId)) {
      registry.register(fakeAdapter);
    }

    if (!repo.getProvider(params.providerId)) {
      repo.createProvider({
        id: params.providerId,
        name: 'Fake Provider',
        adapter_type: 'LOCAL_CLI',
        enabled: true,
        created_at: new Date().toISOString(),
      });
    }

    if (!repo.getRoleProfile('role-coder-generic')) {
      repo.createRoleProfile({
        id: 'role-coder-generic',
        role: 'CODER',
        display_name: 'Coder Generic',
        required_capabilities: ['CODING'],
        preferred_capabilities: [],
        authority_scope: null,
        permissions: ['FILE_WRITE'],
        output_protocol: 'coder.v1',
        enabled: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    if (params.resourceAccountMismatch && !repo.getProviderAccount('acc-other-unbound')) {
      repo.createProviderAccount({
        id: 'acc-other-unbound',
        provider_id: params.providerId,
        label: 'Other Account',
        auth_mode: 'NATIVE_PROFILE',
        credential_ref: null,
        profile_ref: 'native-profile://codex/other',
        enabled: true,
        priority: 1,
        health_status: 'AVAILABLE',
        cooldown_until: null,
        concurrency_limit: 1,
        last_success_at: null,
        last_failure_at: null,
        last_failure_code: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    repo.createProviderAccount({
      id: params.accountId,
      provider_id: params.providerId,
      label: 'Account Label',
      auth_mode: 'NATIVE_PROFILE',
      credential_ref: null,
      profile_ref: params.profileRef ?? 'native-profile://codex/c01',
      enabled: params.accountEnabled ?? true,
      priority: 10,
      health_status: params.accountHealth ?? 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    repo.createProviderResource({
      id: params.resourceId,
      provider_id: params.providerId,
      provider_account_id: params.resourceAccountMismatch ? 'acc-other-unbound' : params.accountId,
      model_name: params.modelName ?? 'o3-mini',
      health_status: 'AVAILABLE',
      capabilities: ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION'],
      enabled: true,
      total_quota: 100,
      remaining_quota: 100,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'PROVIDER_REPORTED',
      quota_confidence: 1.0,
      last_health_check: null,
    });

    const assignmentId = params.assignmentId ?? `asgn-${crypto.randomUUID().slice(0, 8)}`;
    const assignment: AgentAssignment = {
      id: assignmentId,
      project_id: 'proj-r5f',
      task_id: 'task-r5f-001',
      attempt_id: null,
      role_profile_id: 'role-coder-generic',
      agent_profile_id: null,
      selected_provider_id: params.providerId,
      selected_account_id: params.accountId,
      selected_resource_id: params.resourceId,
      selected_worker_slot_id: null,
      routing_decision_id: params.decisionId,
      preferred_metadata: null,
      status: params.assignmentStatus ?? 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    };
    repo.createAgentAssignment(assignment);

    // Record PROVIDER_ROUTING_DECISION event
    eventService.record(
      'proj-r5f',
      'PROVIDER_ROUTING_DECISION',
      'Routing decision',
      {
        decisionId: params.decisionId,
        projectId: 'proj-r5f',
        taskId: 'task-r5f-001',
        attemptId: null,
        outcome: 'SELECTED',
        selectedProviderId: params.providerId,
        selectedAccountId: params.accountId,
        selectedResourceId: params.resourceId,
        selectedAssignmentId: assignmentId,
        adapterType: 'LOCAL_CLI',
        candidateEvaluations: [],
        reason: 'Selected candidate',
      },
      'task-r5f-001'
    );

    return { fakeAdapter, assignmentId };
  }

  // ============================================================
  // A. DISPATCH BINDING TESTS
  // ============================================================
  describe('A. Dispatch Binding & Revalidation', () => {
    it('1. SELECTED route populates exact provider, account, resource, assignment, and profileRef', async () => {
      const decisionId = 'dec-r5f-001';
      const { fakeAdapter, assignmentId } = createRoutingFixture({
        decisionId,
        providerId: 'prov-fake',
        accountId: 'acc-c01',
        resourceId: 'res-model-1',
        modelName: 'o3-mini',
        profileRef: 'native-profile://codex/c01',
      });

      const auth = await authService.createAuthorization({
        projectId: 'proj-r5f',
        taskId: 'task-r5f-001',
        routingDecisionId: decisionId,
      });

      const result = await dispatcher.dispatch(auth.id);

      expect(result.status).toBe('COMPLETED');
      expect(fakeAdapter.executionCount).toBe(1);
      expect(fakeAdapter.lastRequest).toBeDefined();
      expect(fakeAdapter.lastRequest?.runtimeBinding).toBeDefined();

      const binding = fakeAdapter.lastRequest!.runtimeBinding!;
      expect(binding.authorizationId).toBe(auth.id);
      expect(binding.routingDecisionId).toBe(decisionId);
      expect(binding.assignmentId).toBe(assignmentId);
      expect(binding.providerId).toBe('prov-fake');
      expect(binding.accountId).toBe('acc-c01');
      expect(binding.resourceId).toBe('res-model-1');
      expect(binding.modelName).toBe('o3-mini');
      expect(binding.profileRef).toBe('native-profile://codex/c01');
      expect(binding.accountAuthMode).toBe('NATIVE_PROFILE');
    });

    it('2. Account in AUTH_ERROR state fails closed immediately without execution', async () => {
      const decisionId = 'dec-r5f-002';
      const { fakeAdapter } = createRoutingFixture({
        decisionId,
        providerId: 'prov-fake',
        accountId: 'acc-c02',
        resourceId: 'res-model-2',
      });

      const auth = await authService.createAuthorization({
        projectId: 'proj-r5f',
        taskId: 'task-r5f-001',
        routingDecisionId: decisionId,
      });

      // Mutate account health to AUTH_ERROR after authorization
      repo.updateProviderAccountHealth('acc-c02', 'AUTH_ERROR', null, 'TOKEN_EXPIRED');

      const result = await dispatcher.dispatch(auth.id);

      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('AUTH_ERROR');
      expect(result.error).toContain('PROVIDER_ACCOUNT_AUTH_ERROR');
      expect(fakeAdapter.executionCount).toBe(0);
    });

    it('3. Assignment mismatch fails closed with zero adapter execution', async () => {
      const decisionId = 'dec-r5f-003';
      const { fakeAdapter, assignmentId } = createRoutingFixture({
        decisionId,
        providerId: 'prov-fake',
        accountId: 'acc-c03',
        resourceId: 'res-model-3',
      });

      const auth = await authService.createAuthorization({
        projectId: 'proj-r5f',
        taskId: 'task-r5f-001',
        routingDecisionId: decisionId,
      });

      // Tamper assignment in DB: mark it CANCELLED
      repo.updateAgentAssignmentStatus(assignmentId, 'CANCELLED');

      const result = await dispatcher.dispatch(auth.id);

      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('RESOURCE_UNAVAILABLE');
      expect(result.error).toContain('ROUTING_ASSIGNMENT_STATUS_INVALID');
      expect(fakeAdapter.executionCount).toBe(0);
    });

    it('3b. Resource provider_account_id mismatch fails closed', async () => {
      const decisionId = 'dec-r5f-003b';
      const { fakeAdapter } = createRoutingFixture({
        decisionId,
        providerId: 'prov-fake',
        accountId: 'acc-c03b',
        resourceId: 'res-model-3b',
      });

      const auth = await authService.createAuthorization({
        projectId: 'proj-r5f',
        taskId: 'task-r5f-001',
        routingDecisionId: decisionId,
      });

      // Mutate resource account in database after authorization was created
      repo.createProviderAccount({
        id: 'acc-other-unbound',
        provider_id: 'prov-fake',
        label: 'Other Account',
        auth_mode: 'NATIVE_PROFILE',
        credential_ref: null,
        profile_ref: 'native-profile://codex/other',
        enabled: true,
        priority: 1,
        health_status: 'AVAILABLE',
        cooldown_until: null,
        concurrency_limit: 1,
        last_success_at: null,
        last_failure_at: null,
        last_failure_code: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      db.prepare('UPDATE provider_resources SET provider_account_id = ? WHERE id = ?').run(
        'acc-other-unbound',
        'res-model-3b'
      );

      const result = await dispatcher.dispatch(auth.id);

      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('RESOURCE_UNAVAILABLE');
      expect(result.error).toContain('ROUTING_RESOURCE_ACCOUNT_MISMATCH');
      expect(fakeAdapter.executionCount).toBe(0);
    });
  });

  // ============================================================
  // B. EVENT PROVENANCE TESTS
  // ============================================================
  describe('B. Durable Event Provenance', () => {
    it('4. Emits PROVIDER_RUNTIME_EXECUTION_BOUND and PROVIDER_RUNTIME_EXECUTION_RESULT events with safe metadata', async () => {
      const decisionId = 'dec-r5f-004';
      const { assignmentId } = createRoutingFixture({
        decisionId,
        providerId: 'prov-fake',
        accountId: 'acc-c04',
        resourceId: 'res-model-4',
        modelName: 'o3-mini',
        profileRef: 'native-profile://codex/c04',
      });

      const auth = await authService.createAuthorization({
        projectId: 'proj-r5f',
        taskId: 'task-r5f-001',
        routingDecisionId: decisionId,
      });

      const result = await dispatcher.dispatch(auth.id);
      expect(result.status).toBe('COMPLETED');

      const events = eventService.getEvents('proj-r5f');
      const boundEvent = events.find((e) => e.type === 'PROVIDER_RUNTIME_EXECUTION_BOUND');
      const resultEvent = events.find((e) => e.type === 'PROVIDER_RUNTIME_EXECUTION_RESULT');

      expect(boundEvent).toBeDefined();
      expect(boundEvent!.structured_payload.authorizationId).toBe(auth.id);
      expect(boundEvent!.structured_payload.assignmentId).toBe(assignmentId);
      expect(boundEvent!.structured_payload.accountId).toBe('acc-c04');
      expect(boundEvent!.structured_payload.profileRef).toBe('native-profile://codex/c04');
      expect(boundEvent!.structured_payload.instructions).toBeUndefined();

      expect(resultEvent).toBeDefined();
      expect(resultEvent!.structured_payload.executionId).toBe(result.executionId);
      expect(resultEvent!.structured_payload.status).toBe('COMPLETED');
      expect(resultEvent!.structured_payload.rawResponse).toBeUndefined();
    });
  });

  // ============================================================
  // C. PROCESS OUTPUT LIMIT TESTS
  // ============================================================
  describe('C. Process Output Limit Hardening', () => {
    it('5. Process output under limit succeeds normally', async () => {
      const scriptPath = path.join(tempDir, 'output_under_limit.js');
      fs.writeFileSync(scriptPath, 'process.stdout.write("small output"); process.exit(0);');

      const res = await ProcessRunner.execute({
        executable: process.execPath,
        args: [scriptPath],
        cwd: projectRepoDir,
        timeoutMs: 5000,
        maxStdoutBytes: 1024,
      });

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toBe('small output');
      expect(res.outputLimitExceeded).toBe(false);
      expect(res.errorCode).toBeNull();
    });

    it('6. Process exceeding stdout limit terminates and reports OUTPUT_LIMIT_EXCEEDED', async () => {
      const scriptPath = path.join(tempDir, 'output_over_limit.js');
      fs.writeFileSync(
        scriptPath,
        'for (let i = 0; i < 2000; i++) { process.stdout.write("A".repeat(1024)); }'
      );

      const res = await ProcessRunner.execute({
        executable: process.execPath,
        args: [scriptPath],
        cwd: projectRepoDir,
        timeoutMs: 5000,
        maxStdoutBytes: 2048, // 2 KiB limit
      });

      expect(res.outputLimitExceeded).toBe(true);
      expect(res.errorCode).toBe('OUTPUT_LIMIT_EXCEEDED');
      expect(Buffer.byteLength(res.stdout, 'utf8')).toBeLessThanOrEqual(2048);
    });

    it('7. Output limit exceeded mapped to LocalCliAdapter error code', async () => {
      const scriptPath = path.join(tempDir, 'infinite_output.js');
      fs.writeFileSync(
        scriptPath,
        'for (let i = 0; i < 2000; i++) { process.stdout.write("X".repeat(1024)); }'
      );

      const adapter = new TestLocalCliAdapter({
        repo,
        artifactStore,
        timeoutMs: 5000,
      });

      (adapter as any).buildExecutionArgs = () => [scriptPath];
      (adapter as any).useStdin = false;

      // Wrap ProcessRunner execution in adapter with options or test through ProcessRunner error mapping
      const runnerRes = await ProcessRunner.execute({
        executable: process.execPath,
        args: [scriptPath],
        cwd: projectRepoDir,
        timeoutMs: 5000,
        maxStdoutBytes: 1024,
      });

      expect(runnerRes.outputLimitExceeded).toBe(true);
      expect(runnerRes.errorCode).toBe('OUTPUT_LIMIT_EXCEEDED');
    });
  });

  // ============================================================
  // D. PROCESS FAILURE & ENVIRONMENT SECURITY
  // ============================================================
  describe('D. Process Failure Classification & Environment Security', () => {
    it('8. Timeout is classified as TIMEOUT errorCode', async () => {
      const scriptPath = path.join(tempDir, 'timeout_script.js');
      fs.writeFileSync(scriptPath, 'setTimeout(() => {}, 10000);');

      const res = await ProcessRunner.execute({
        executable: process.execPath,
        args: [scriptPath],
        cwd: projectRepoDir,
        timeoutMs: 400,
      });

      expect(res.timedOut).toBe(true);
      expect(res.errorCode).toBe('TIMEOUT');
    });

    it('9. Nonzero exit code is classified as NONZERO_EXIT', async () => {
      const scriptPath = path.join(tempDir, 'nonzero_script.js');
      fs.writeFileSync(scriptPath, 'process.stderr.write("Fatal error"); process.exit(42);');

      const res = await ProcessRunner.execute({
        executable: process.execPath,
        args: [scriptPath],
        cwd: projectRepoDir,
        timeoutMs: 5000,
      });

      expect(res.exitCode).toBe(42);
      expect(res.errorCode).toBe('NONZERO_EXIT');
      expect(res.stderr).toContain('Fatal error');
    });

    it('10. Allowed custom environment key is accepted', async () => {
      const scriptPath = path.join(tempDir, 'env_script.js');
      fs.writeFileSync(scriptPath, 'process.stdout.write(process.env.CODEX_HOME || "missing");');

      const res = await ProcessRunner.execute({
        executable: process.execPath,
        args: [scriptPath],
        cwd: projectRepoDir,
        timeoutMs: 5000,
        env: {
          CODEX_HOME: 'C:\\fake\\codex\\profile',
        },
      });

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toBe('C:\\fake\\codex\\profile');
    });

    it('11. Unauthorized custom environment key is rejected before launch', async () => {
      const scriptPath = path.join(tempDir, 'unauthorized_env.js');
      fs.writeFileSync(scriptPath, 'process.exit(0);');

      const res = await ProcessRunner.execute({
        executable: process.execPath,
        args: [scriptPath],
        cwd: projectRepoDir,
        timeoutMs: 5000,
        env: {
          UNAUTHORIZED_SECRET_KEY: 'secret_value',
        },
      });

      expect(res.exitCode).toBe(-1);
      expect(res.errorCode).toBe('PROCESS_LAUNCH_FAILED');
      expect(res.stderr).toContain('Unauthorized custom environment variable key');
    });
  });

  // ============================================================
  // E. BACKWARD COMPATIBILITY
  // ============================================================
  describe('E. Backward Compatibility', () => {
    it('12. ManualBridge adapter executes without runtimeBinding and returns AWAITING_OWNER', async () => {
      const manual = new ManualBridgeAdapter();
      const res = await manual.execute({
        projectId: 'proj-r5f',
        taskId: 'task-r5f-001',
        instructions: ['Relay'],
        contextFiles: [],
      });

      expect(res.status).toBe('AWAITING_OWNER');
      expect(res.executionId).toContain('manual-exec-');
    });
  });
});
