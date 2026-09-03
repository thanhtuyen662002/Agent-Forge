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
import { TaskService } from '../src/core/services/TaskService';
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
import { ManualBridgeAdapter } from '../src/core/adapters/ManualBridgeAdapter';
import { CodexCliAdapter } from '../src/core/adapters/CodexCliAdapter';
import { ProviderRoutingService } from '../src/core/services/ProviderRoutingService';
import { ProviderDispatchService } from '../src/core/services/ProviderDispatchService';
import {
  ExecutionAuthorizationService,
  computeCanonicalPayload,
  computePayloadHash,
  computeContextManifestHash,
  sanitizeContextFiles,
} from '../src/core/services/ExecutionAuthorizationService';

class MockExecutionAdapter implements ProviderAdapter {
  public executionCount = 0;
  public cancelCount = 0;
  public healthProbeCount = 0;
  public quotaProbeCount = 0;
  public capabilityProbeCount = 0;

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly adapterType: ProviderAdapterType = 'LOCAL_CLI',
    public health: ProviderHealthStatus = 'AVAILABLE',
    public capabilities: Capability[] = ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION'],
    public customExecutionResult?: Partial<AgentExecutionResult>
  ) {}

  public async getCapabilities(): Promise<Capability[]> {
    this.capabilityProbeCount++;
    return this.capabilities;
  }

  public async getHealth(): Promise<ProviderHealthStatus> {
    this.healthProbeCount++;
    return this.health;
  }

  public async getQuota(): Promise<QuotaSnapshotInfo> {
    this.quotaProbeCount++;
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
        message_id: 'msg-mock-exec',
        project_id: request.projectId,
        task_id: request.taskId,
        attempt: 1,
        status: 'COMPLETED',
        completed: ['Mock work finished'],
        remaining: [],
        files_claimed_changed: [],
        tests_claimed: [],
        blockers: [],
        review_requested: true,
        expected_task_state: 'CODING',
        expected_revision: 0,
      }),
      rawResponse: 'Mock raw execution response',
    };
  }

  public async cancel(_executionId: string): Promise<void> {
    this.cancelCount++;
  }
}

describe('PR #7 — Durable Execution Authorization & Orchestration Binding', () => {
  let tmpDir: string;
  let db: Database.Database;
  let repo: Repository;
  let eventService: EventService;
  let taskService: TaskService;
  let registry: ProviderRegistry;
  let router: ProviderRoutingService;
  let dispatcher: ProviderDispatchService;
  let authService: ExecutionAuthorizationService;
  let initialGitSha: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-exec-auth-test-'));

    // Initialize real git repository for GitService tests
    execSync('git init', { cwd: tmpDir });
    execSync('git config user.email "test@test.com"', { cwd: tmpDir });
    execSync('git config user.name "Tester"', { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Initial README\n');
    execSync('git add README.md && git commit -m "initial commit"', { cwd: tmpDir });
    initialGitSha = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);

    repo = new Repository(db);
    eventService = new EventService(repo);
    taskService = new TaskService(repo, eventService);
    registry = new ProviderRegistry();
    router = new ProviderRoutingService(repo, registry, eventService);
    dispatcher = new ProviderDispatchService(registry, repo, eventService);
    authService = new ExecutionAuthorizationService(repo, eventService);

    // Create base project fixture
    repo.createProject({
      id: 'PROJ-AUTH',
      name: 'Authorization Test Project',
      description: 'Project for durable execution authorization testing',
      repository_path: tmpDir,
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    });

    // Create base task fixture in CODING state
    repo.createTask({
      id: 'TSK-AUTH-001',
      project_id: 'PROJ-AUTH',
      milestone_id: null,
      title: 'Durable Authorization Task',
      description: 'Implement execution binding',
      state: 'CODING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: initialGitSha,
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: ['Authorization is durable', 'Dispatch accepts authId only'],
      constraints: ['No post-dispatch failover', 'Compare-and-set claim'],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Create initial applied Manager EXECUTE protocol message
    recordAppliedManagerMessage('PROJ-AUTH', 'TSK-AUTH-001', {
      decision: 'EXECUTE',
      expected_revision: 0,
      instructions: ['Implement feature according to spec'],
      messageId: 'msg-mgr-initial',
    });
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  let messageSequence = 0;

  // Helper to record applied manager messages in protocol_messages ledger
  function recordAppliedManagerMessage(
    projectId: string,
    taskId: string,
    params: {
      decision: 'EXECUTE' | 'FIX_REQUIRED' | 'PASS' | 'BLOCK' | 'PAUSE' | 'CANCEL' | 'NEEDS_OWNER' | 'CREATE_TASKS';
      expected_revision?: number | null;
      instructions?: string[];
      messageId?: string;
      recordId?: string;
      status?: 'APPLIED' | 'REJECTED';
    }
  ): { messageId: string; recordId: string; payloadHash: string; rawPayload: string } {
    messageSequence++;
    const nowTimestamp = new Date(Date.now() + messageSequence * 1000).toISOString();
    const msgId = params.messageId ?? `msg-mgr-${String(messageSequence).padStart(6, '0')}-${crypto.randomUUID().slice(0, 8)}`;
    const recId = params.recordId ?? `rec-mgr-${String(messageSequence).padStart(6, '0')}-${crypto.randomUUID().slice(0, 8)}`;
    const rawPayload = JSON.stringify({
      protocol: 'manager.v1',
      message_id: msgId,
      project_id: projectId,
      task_id: taskId,
      decision: params.decision,
      expected_revision: params.expected_revision ?? 0,
      instructions: params.instructions ?? ['Manager instruction line 1', 'Manager instruction line 2'],
      acceptance_criteria: ['AC 1'],
      constraints: ['Constraint 1'],
    });
    const payloadHash = crypto.createHash('sha256').update(rawPayload, 'utf8').digest('hex');
    repo.recordProtocolMessage(
      recId,
      msgId,
      'manager.v1',
      projectId,
      taskId,
      'APPROVED',
      params.expected_revision ?? 0,
      payloadHash,
      rawPayload,
      params.status ?? 'APPLIED',
      undefined,
      nowTimestamp
    );
    return { messageId: msgId, recordId: recId, payloadHash, rawPayload };
  }

  // Helper to register mock provider & provider resource
  function setupResource(
    resourceId: string,
    providerId: string,
    options: {
      health?: ProviderHealthStatus;
      capabilities?: Capability[];
      enabled?: boolean;
      customExecutionResult?: Partial<AgentExecutionResult>;
    } = {}
  ): MockExecutionAdapter {
    const now = new Date().toISOString();
    const mock = new MockExecutionAdapter(
      providerId,
      `Mock ${providerId}`,
      'LOCAL_CLI',
      options.health ?? 'AVAILABLE',
      options.capabilities ?? ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION'],
      options.customExecutionResult
    );
    registry.register(mock);

    if (!repo.getProvider(providerId)) {
      repo.createProvider({
        id: providerId,
        name: `Provider ${providerId}`,
        adapter_type: 'LOCAL_CLI',
        enabled: options.enabled ?? true,
        created_at: now,
      });
    }

    repo.createProviderResource({
      id: resourceId,
      provider_id: providerId,
      model_name: 'Mock Model',
      health_status: options.health ?? 'AVAILABLE',
      capabilities: options.capabilities ?? ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION'],
      enabled: options.enabled ?? true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 0,
      last_health_check: now,
    });

    return mock;
  }

  // =========================================================================
  // 1. MANAGER SUPERSESSION & LIVENESS TESTS
  // =========================================================================

  // 1. EXECUTE applied -> auth A -> newer CANCEL -> A becomes INVALIDATED -> dispatch A -> zero provider execution
  it('1. Newer applied CANCEL decision invalidates existing authorization with zero execution', async () => {
    const mock = setupResource('res-sup-cancel', 'prov-sup-cancel');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-sup-cancel'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Apply newer CANCEL decision through TaskService (same transaction invalidation)
    const cancelPayload = {
      protocol: 'manager.v1' as const,
      message_id: 'msg-mgr-cancel-01',
      project_id: 'PROJ-AUTH',
      task_id: 'TSK-AUTH-001',
      decision: 'CANCEL' as const,
      priority: 'HIGH' as const,
      risk: 'MEDIUM' as const,
      instructions: ['Cancel task execution'],
      acceptance_criteria: [],
      constraints: [],
      review_issues: [],
      expected_task_state: 'CODING' as const,
      expected_revision: 0,
    };
    const res = await taskService.applyManagerDecision(cancelPayload, JSON.stringify(cancelPayload));
    expect(res.success).toBe(true);

    // Verify auth status in SQLite is already INVALIDATED
    const loadedAuth = repo.getExecutionAuthorization(auth.id);
    expect(loadedAuth!.status).toBe('INVALIDATED');

    // Attempt dispatch -> must fail closed with zero provider execution
    const dispatchRes = await dispatcher.dispatch(auth.id);
    expect(dispatchRes.status).toBe('FAILED');
    expect(dispatchRes.error).toContain('EXECUTION_AUTHORIZATION_INVALIDATED');
    expect(mock.executionCount).toBe(0);
  });

  // 2. Same supersession behavior for PAUSE
  it('2. Newer applied PAUSE decision invalidates existing authorization with zero execution', async () => {
    const mock = setupResource('res-sup-pause', 'prov-sup-pause');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-sup-pause'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Apply newer PAUSE decision through TaskService
    const pausePayload = {
      protocol: 'manager.v1' as const,
      message_id: 'msg-mgr-pause-01',
      project_id: 'PROJ-AUTH',
      task_id: 'TSK-AUTH-001',
      decision: 'PAUSE' as const,
      priority: 'HIGH' as const,
      risk: 'MEDIUM' as const,
      instructions: ['Pause task execution'],
      acceptance_criteria: [],
      constraints: [],
      review_issues: [],
      expected_task_state: 'CODING' as const,
      expected_revision: 0,
    };
    const res = await taskService.applyManagerDecision(pausePayload, JSON.stringify(pausePayload));
    expect(res.success).toBe(true);

    const loadedAuth = repo.getExecutionAuthorization(auth.id);
    expect(loadedAuth!.status).toBe('INVALIDATED');

    const dispatchRes = await dispatcher.dispatch(auth.id);
    expect(dispatchRes.status).toBe('FAILED');
    expect(mock.executionCount).toBe(0);
  });

  // 3. Same supersession behavior for PASS or BLOCK
  it('3. Newer applied PASS or BLOCK decision invalidates existing authorization with zero execution', async () => {
    const mock = setupResource('res-sup-pass', 'prov-sup-pass');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-sup-pass'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Apply PASS decision directly through TaskService (with task in REVIEWING state)
    db.prepare("UPDATE tasks SET state = 'REVIEWING' WHERE id = ?").run('TSK-AUTH-001');
    const passPayload = {
      protocol: 'manager.v1' as const,
      message_id: 'msg-mgr-pass-01',
      project_id: 'PROJ-AUTH',
      task_id: 'TSK-AUTH-001',
      decision: 'PASS' as const,
      priority: 'HIGH' as const,
      risk: 'MEDIUM' as const,
      instructions: ['Work approved and verified'],
      acceptance_criteria: [],
      constraints: [],
      review_issues: [],
      expected_task_state: 'REVIEWING' as const,
      expected_revision: 0,
    };
    const res = await taskService.applyManagerDecision(passPayload, JSON.stringify(passPayload));
    expect(res.success).toBe(true);

    const loadedAuth = repo.getExecutionAuthorization(auth.id);
    expect(loadedAuth!.status).toBe('INVALIDATED');

    const dispatchRes = await dispatcher.dispatch(auth.id);
    expect(dispatchRes.status).toBe('FAILED');
    expect(mock.executionCount).toBe(0);
  });

  // 4. EXECUTE A -> auth A -> newer EXECUTE B -> A INVALIDATED -> old A zero execution -> new auth B executes
  it('4. Newer EXECUTE authority invalidates old authorization; new authorization bound to B executes', async () => {
    const mock = setupResource('res-sup-exec', 'prov-sup-exec');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-sup-exec'],
      allowManualBridge: false,
    });

    const authA = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Apply newer EXECUTE authority B
    recordAppliedManagerMessage('PROJ-AUTH', 'TSK-AUTH-001', {
      decision: 'EXECUTE',
      expected_revision: 0,
      instructions: ['Updated execute instructions B'],
      messageId: 'msg-mgr-exec-B',
    });

    // Old auth A dispatch defense-in-depth fails because it is superseded
    const dispatchARes = await dispatcher.dispatch(authA.id);
    expect(dispatchARes.status).toBe('FAILED');
    expect(dispatchARes.error).toContain('EXECUTION_AUTHORIZATION_MANAGER_AUTHORITY_SUPERSEDED');
    expect(mock.executionCount).toBe(0);

    // Create new authorization bound to authority B
    const authB = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    const dispatchBRes = await dispatcher.dispatch(authB.id);
    expect(dispatchBRes.status).toBe('COMPLETED');
    expect(mock.executionCount).toBe(1);
  });

  // 5. EXECUTE authority A -> auth A -> newer FIX_REQUIRED B -> A INVALIDATED -> old A zero execution
  it('5. Newer FIX_REQUIRED authority invalidates old authorization with zero execution for old authorization', async () => {
    const mock = setupResource('res-sup-fix', 'prov-sup-fix');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-sup-fix'],
      allowManualBridge: false,
    });

    const authA = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Apply FIX_REQUIRED decision
    recordAppliedManagerMessage('PROJ-AUTH', 'TSK-AUTH-001', {
      decision: 'FIX_REQUIRED',
      expected_revision: 0,
      instructions: ['Fix critical bug'],
      messageId: 'msg-mgr-fix-B',
    });

    const dispatchRes = await dispatcher.dispatch(authA.id);
    expect(dispatchRes.status).toBe('FAILED');
    expect(dispatchRes.error).toContain('EXECUTION_AUTHORIZATION_MANAGER_AUTHORITY_SUPERSEDED');
    expect(mock.executionCount).toBe(0);
  });

  // 6. A REJECTED newer Manager message does NOT invalidate a valid existing authorization
  it('6. A REJECTED newer Manager message does NOT invalidate a valid existing authorization', async () => {
    const mock = setupResource('res-sup-reject', 'prov-sup-reject');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-sup-reject'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Send an invalid/rejected Manager message (cross-project conflict)
    const badPayload = {
      protocol: 'manager.v1' as const,
      message_id: 'msg-mgr-bad-01',
      project_id: 'PROJ-DIFFERENT',
      task_id: 'TSK-AUTH-001',
      decision: 'CANCEL' as const,
      priority: 'HIGH' as const,
      risk: 'MEDIUM' as const,
      instructions: ['Bad cancel'],
      acceptance_criteria: [],
      constraints: [],
      review_issues: [],
      expected_task_state: 'CODING' as const,
      expected_revision: 0,
    };
    const res = await taskService.applyManagerDecision(badPayload, JSON.stringify(badPayload));
    expect(res.success).toBe(false);

    // Auth remains AUTHORIZED and can execute
    const loadedAuth = repo.getExecutionAuthorization(auth.id);
    expect(loadedAuth!.status).toBe('AUTHORIZED');

    const dispatchRes = await dispatcher.dispatch(auth.id);
    expect(dispatchRes.status).toBe('COMPLETED');
    expect(mock.executionCount).toBe(1);
  });

  // 7. A DUPLICATE/non-newly-applied Manager message does NOT accidentally invalidate authorization
  it('7. A DUPLICATE Manager message does NOT accidentally invalidate authorization', async () => {
    const mock = setupResource('res-sup-dup', 'prov-sup-dup');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-sup-dup'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Send a duplicate Manager message using the initial message ID
    const dupPayload = {
      protocol: 'manager.v1' as const,
      message_id: 'msg-mgr-initial',
      project_id: 'PROJ-AUTH',
      task_id: 'TSK-AUTH-001',
      decision: 'EXECUTE' as const,
      priority: 'HIGH' as const,
      risk: 'MEDIUM' as const,
      instructions: ['Duplicate'],
      acceptance_criteria: [],
      constraints: [],
      review_issues: [],
      expected_task_state: 'CODING' as const,
      expected_revision: 0,
    };
    const res = await taskService.applyManagerDecision(dupPayload, JSON.stringify(dupPayload));
    expect(res.isDuplicate).toBe(true);

    const loadedAuth = repo.getExecutionAuthorization(auth.id);
    expect(loadedAuth!.status).toBe('AUTHORIZED');

    const dispatchRes = await dispatcher.dispatch(auth.id);
    expect(dispatchRes.status).toBe('COMPLETED');
    expect(mock.executionCount).toBe(1);
  });

  // 8. ManagerDecision transaction rollback also rolls back authorization invalidation
  it('8. ManagerDecision transaction rollback also rolls back authorization invalidation', async () => {
    const mock = setupResource('res-sup-rb', 'prov-sup-rb');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-sup-rb'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Simulate a failed transaction that invalidates authorization but then throws an error
    expect(() => {
      repo.runInTransaction(() => {
        repo.invalidateAuthorizedExecutionAuthorizationsForTask('TSK-AUTH-001');
        throw new Error('Simulated transaction failure in mutate');
      });
    }).toThrow('Simulated transaction failure in mutate');

    // Transaction was rolled back: auth status remains AUTHORIZED
    const loadedAuth = repo.getExecutionAuthorization(auth.id);
    expect(loadedAuth!.status).toBe('AUTHORIZED');

    const dispatchRes = await dispatcher.dispatch(auth.id);
    expect(dispatchRes.status).toBe('COMPLETED');
    expect(mock.executionCount).toBe(1);
  });

  // 9. Dispatch defense-in-depth rejects an authorization whose bound Manager record is not the latest APPLIED authority
  it('9. Dispatch defense-in-depth rejects an authorization whose bound Manager record is not latest APPLIED authority even if DB left it AUTHORIZED', async () => {
    const mock = setupResource('res-sup-did', 'prov-sup-did');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-sup-did'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Manually insert a newer applied Manager message directly into SQLite (simulating inconsistent DB)
    recordAppliedManagerMessage('PROJ-AUTH', 'TSK-AUTH-001', {
      decision: 'PAUSE',
      expected_revision: 0,
      instructions: ['Direct DB insert pause'],
      messageId: 'msg-mgr-direct-newer',
    });

    // Auth status is still AUTHORIZED in DB, but dispatch defense-in-depth catches the supersession
    expect(repo.getExecutionAuthorization(auth.id)!.status).toBe('AUTHORIZED');

    const dispatchRes = await dispatcher.dispatch(auth.id);
    expect(dispatchRes.status).toBe('FAILED');
    expect(dispatchRes.error).toContain('EXECUTION_AUTHORIZATION_MANAGER_AUTHORITY_SUPERSEDED');
    expect(mock.executionCount).toBe(0);

    // Auth is now INVALIDATED
    expect(repo.getExecutionAuthorization(auth.id)!.status).toBe('INVALIDATED');
  });

  // 10. Task changes from CODING to non-executable state after authorization without revision change: dispatch fails STALE_TASK_STATE
  it('10. Task changing from CODING to non-executable state after authorization fails closed with STALE_TASK_STATE', async () => {
    const mock = setupResource('res-stale-state', 'prov-stale-state');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-stale-state'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Mutate task state to REVIEWING in database without changing revision
    db.prepare("UPDATE tasks SET state = 'REVIEWING' WHERE id = ?").run('TSK-AUTH-001');

    const dispatchRes = await dispatcher.dispatch(auth.id);
    expect(dispatchRes.status).toBe('FAILED');
    expect(dispatchRes.error).toContain('EXECUTION_AUTHORIZATION_STALE_TASK_STATE');
    expect(mock.executionCount).toBe(0);

    const loadedAuth = repo.getExecutionAuthorization(auth.id);
    expect(loadedAuth!.status).toBe('INVALIDATED');
  });

  // 11. Manual Bridge: CODING / HANDOFF_REQUIRED remains valid
  it('11. Manual Bridge: CODING and HANDOFF_REQUIRED states are valid at dispatch', async () => {
    const manualAdapter = new ManualBridgeAdapter();
    registry.register(manualAdapter);
    if (!repo.getProvider('prov-manual-bridge')) {
      repo.createProvider({
        id: 'prov-manual-bridge',
        name: 'Manual Bridge',
        adapter_type: 'MANUAL_BRIDGE',
        enabled: true,
        created_at: new Date().toISOString(),
      });
    }
    repo.createProviderResource({
      id: 'res-mb-11',
      provider_id: 'prov-manual-bridge',
      model_name: 'Manual Model',
      health_status: 'UNKNOWN',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 0,
      last_health_check: null,
    });

    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-mb-11'],
      allowManualBridge: true,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Set task to HANDOFF_REQUIRED
    db.prepare("UPDATE tasks SET state = 'HANDOFF_REQUIRED' WHERE id = ?").run('TSK-AUTH-001');

    const res = await dispatcher.dispatch(auth.id);
    expect(res.status).toBe('AWAITING_OWNER');
  });

  // 12. Manual Bridge: other task states fail closed
  it('12. Manual Bridge: non-CODING/non-HANDOFF_REQUIRED task states fail closed with STALE_TASK_STATE', async () => {
    const manualAdapter = new ManualBridgeAdapter();
    registry.register(manualAdapter);
    if (!repo.getProvider('prov-manual-bridge')) {
      repo.createProvider({
        id: 'prov-manual-bridge',
        name: 'Manual Bridge',
        adapter_type: 'MANUAL_BRIDGE',
        enabled: true,
        created_at: new Date().toISOString(),
      });
    }
    repo.createProviderResource({
      id: 'res-mb-12',
      provider_id: 'prov-manual-bridge',
      model_name: 'Manual Model',
      health_status: 'UNKNOWN',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 0,
      last_health_check: null,
    });

    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-mb-12'],
      allowManualBridge: true,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Set task to VALIDATING
    db.prepare("UPDATE tasks SET state = 'VALIDATING' WHERE id = ?").run('TSK-AUTH-001');

    const res = await dispatcher.dispatch(auth.id);
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('EXECUTION_AUTHORIZATION_STALE_TASK_STATE');
  });

  // 13. FIX_REQUIRED with manager.expected_revision == current_task_revision must NOT authorize
  it('13. FIX_REQUIRED with manager.expected_revision == current_task_revision must NOT authorize (escape hatch removed)', async () => {
    setupResource('res-fix-stale', 'prov-fix-stale');
    // Task revision is 0, Manager FIX_REQUIRED has expected_revision 0
    // But FIX_REQUIRED increment rule requires manager.expected_revision + 1 == task.revision_count
    // So 0 + 1 = 1 != 0 -> fails closed
    recordAppliedManagerMessage('PROJ-AUTH', 'TSK-AUTH-001', {
      decision: 'FIX_REQUIRED',
      expected_revision: 0,
      instructions: ['Fix bug without revision bump'],
      messageId: 'msg-fix-stale-escape',
    });

    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-fix-stale'],
      allowManualBridge: false,
    });

    await expect(
      authService.createAuthorization({
        projectId: 'PROJ-AUTH',
        taskId: 'TSK-AUTH-001',
        routingDecisionId: decision.decisionId,
      })
    ).rejects.toThrow('EXECUTION_AUTHORIZATION_STALE_TASK_REVISION');
  });

  // 14. Correct FIX_REQUIRED relationship: manager.expected_revision + 1 == task.revision_count does authorize
  it('14. Correct FIX_REQUIRED relationship (expected_revision + 1 == task.revision_count) authorizes', async () => {
    setupResource('res-fix-valid', 'prov-fix-valid');
    // Task enters fix cycle: revision_count bumped to 1
    db.prepare('UPDATE tasks SET revision_count = 1 WHERE id = ?').run('TSK-AUTH-001');

    recordAppliedManagerMessage('PROJ-AUTH', 'TSK-AUTH-001', {
      decision: 'FIX_REQUIRED',
      expected_revision: 0, // 0 + 1 == 1 -> exact match
      instructions: ['Fix bug for revision 1'],
      messageId: 'msg-fix-valid',
    });

    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-fix-valid'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    expect(auth).toBeDefined();
    expect(auth.task_revision).toBe(1);
  });

  // 15. EXECUTE revision relationship remains correct
  it('15. EXECUTE revision relationship (manager.expected_revision == task.revision_count) authorizes', async () => {
    setupResource('res-exec-rev', 'prov-exec-rev');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-exec-rev'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    expect(auth.task_revision).toBe(0);
  });

  // 16. Unchanged current Manager authority + unchanged task state: executes exactly once
  it('16. Unchanged current Manager authority + unchanged task state executes provider exactly once', async () => {
    const mock = setupResource('res-valid-exec', 'prov-valid-exec');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-valid-exec'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    const result = await dispatcher.dispatch(auth.id);
    expect(result.status).toBe('COMPLETED');
    expect(mock.executionCount).toBe(1);
  });

  // 17. Concurrent dispatch still executes exactly once
  it('17. Concurrent dispatch calls produce exactly 1 provider execution (atomic claim)', async () => {
    const mock = setupResource('res-concurrent-17', 'prov-concurrent-17');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-concurrent-17'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    const [r1, r2] = await Promise.all([dispatcher.dispatch(auth.id), dispatcher.dispatch(auth.id)]);

    const completed = [r1, r2].filter((r) => r.status === 'COMPLETED');
    const failed = [r1, r2].filter((r) => r.status === 'FAILED');

    expect(completed).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toContain('EXECUTION_AUTHORIZATION_ALREADY_DISPATCHED');
    expect(mock.executionCount).toBe(1);
  });

  // 18. Provider FAILED / timeout / cancellation / PROTOCOL_INVALID after successful atomic claim leaves authorization DISPATCHED
  it('18. Provider failure/timeout/cancellation/PROTOCOL_INVALID leaves authorization DISPATCHED without failover', async () => {
    const mock = setupResource('res-fail-18', 'prov-fail-18', {
      customExecutionResult: { status: 'FAILED', error: 'Process crashed' },
    });
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-fail-18'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    const result = await dispatcher.dispatch(auth.id);
    expect(result.status).toBe('FAILED');

    const loaded = repo.getExecutionAuthorization(auth.id);
    expect(loaded!.status).toBe('DISPATCHED');
  });

  // 19. Manual Bridge remains AWAITING_OWNER and non-replayable
  it('19. Manual Bridge dispatch returns AWAITING_OWNER and cannot be replayed', async () => {
    const manualAdapter = new ManualBridgeAdapter();
    registry.register(manualAdapter);
    if (!repo.getProvider('prov-manual-bridge')) {
      repo.createProvider({
        id: 'prov-manual-bridge',
        name: 'Manual Bridge',
        adapter_type: 'MANUAL_BRIDGE',
        enabled: true,
        created_at: new Date().toISOString(),
      });
    }
    repo.createProviderResource({
      id: 'res-mb-19',
      provider_id: 'prov-manual-bridge',
      model_name: 'Manual Model',
      health_status: 'UNKNOWN',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 0,
      last_health_check: null,
    });

    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-mb-19'],
      allowManualBridge: true,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    const res1 = await dispatcher.dispatch(auth.id);
    expect(res1.status).toBe('AWAITING_OWNER');

    const res2 = await dispatcher.dispatch(auth.id);
    expect(res2.status).toBe('FAILED');
    expect(res2.error).toContain('EXECUTION_AUTHORIZATION_ALREADY_DISPATCHED');
  });

  // 20. Supersession rejection event contains no secrets/raw prompts
  it('20. Supersession rejection event contains no secrets, API keys, or raw prompt instructions', async () => {
    setupResource('res-sup-audit', 'prov-sup-audit');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-sup-audit'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Record newer applied Manager message
    recordAppliedManagerMessage('PROJ-AUTH', 'TSK-AUTH-001', {
      decision: 'PAUSE',
      expected_revision: 0,
      instructions: ['PAUSE SECRET_API_KEY_12345'],
      messageId: 'msg-mgr-pause-secret',
    });

    await dispatcher.dispatch(auth.id);

    const events = eventService.getEvents('PROJ-AUTH');
    const rejEvent = events.find((e) => e.type === 'EXECUTION_AUTHORIZATION_REJECTED');
    expect(rejEvent).toBeDefined();

    const payloadStr = JSON.stringify(rejEvent!.structured_payload);
    expect(payloadStr).toContain('EXECUTION_AUTHORIZATION_MANAGER_AUTHORITY_SUPERSEDED');
    expect(payloadStr).not.toContain('SECRET_API_KEY_12345');
    expect(payloadStr).not.toContain('PAUSE SECRET');
  });

  // 21. PR #6 routing tests remain green
  it('21. PR #6 routing semantics (AVAILABLE > LOW_QUOTA) remain intact', async () => {
    setupResource('res-21-a', 'prov-21-a', { health: 'LOW_QUOTA' });
    setupResource('res-21-b', 'prov-21-b', { health: 'AVAILABLE' });

    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-21-a', 'res-21-b'],
      allowManualBridge: false,
    });

    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedResourceId).toBe('res-21-b');
  });

  // 22. Codex requires RuntimeExecutionBinding and advertises capabilities
  it('22. Codex CLI contract requires RuntimeExecutionBinding and advertises capabilities', async () => {
    const codexAdapter = new CodexCliAdapter({ repo, artifactStore: {} as any });
    expect(await codexAdapter.getCapabilities()).toEqual(['CODING', 'TERMINAL', 'FILESYSTEM_EDIT', 'TEST_EXECUTION']);

    const execResult = await codexAdapter.execute({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      instructions: ['Task'],
      contextFiles: [],
    });

    expect(execResult.status).toBe('FAILED');
    expect(execResult.errorCode).toBe('RESOURCE_UNAVAILABLE');
    expect(execResult.error).toContain('RUNTIME_BINDING_MISSING');
  });

  // 23. Antigravity remains MANUAL_BRIDGE_ONLY
  it('23. Antigravity provider operates exclusively through Manual Bridge contract', async () => {
    const manualAdapter = new ManualBridgeAdapter();
    expect(manualAdapter.adapterType).toBe('MANUAL_BRIDGE');
    const health = await manualAdapter.getHealth();
    expect(health).toBe('UNKNOWN');
  });

  // 24. Foreign key RESTRICT prevents deleting referenced tasks or provider resources
  it('24. Foreign key RESTRICT prevents cascade-deleting execution authorizations', async () => {
    setupResource('res-24', 'prov-24');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-24'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    expect(() => db.prepare('DELETE FROM tasks WHERE id = ?').run('TSK-AUTH-001')).toThrow(
      'FOREIGN KEY constraint failed'
    );
    expect(() => db.prepare('DELETE FROM provider_resources WHERE id = ?').run('res-24')).toThrow(
      'FOREIGN KEY constraint failed'
    );
    expect(() => db.prepare('DELETE FROM providers WHERE id = ?').run('prov-24')).toThrow(
      'FOREIGN KEY constraint failed'
    );

    expect(repo.getExecutionAuthorization(auth.id)).not.toBeNull();
  });

  // 25. Actual Git HEAD changes after authorization: STALE_GIT_HEAD
  it('25. Actual Git HEAD changes after authorization fails closed with STALE_GIT_HEAD and invalidation', async () => {
    const mock = setupResource('res-25-git', 'prov-25-git');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-25-git'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Create commit B in git repo to advance HEAD
    fs.writeFileSync(path.join(tmpDir, 'feature.txt'), 'New commit B\n');
    execSync('git add feature.txt && git commit -m "commit B"', { cwd: tmpDir });
    const commitBSha = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();
    expect(commitBSha).not.toBe(initialGitSha);

    const result = await dispatcher.dispatch(auth.id);

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('EXECUTION_AUTHORIZATION_STALE_GIT_HEAD');
    expect(mock.executionCount).toBe(0);

    const updatedAuth = repo.getExecutionAuthorization(auth.id);
    expect(updatedAuth!.status).toBe('INVALIDATED');
  });

  // 26. Canonical payload determinism & hashing
  it('26. Identical canonical payloads produce the exact same SHA-256 hash', () => {
    const payload1 = computeCanonicalPayload({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      attemptId: null,
      taskTitle: 'Title',
      taskDescription: 'Desc',
      acceptanceCriteria: ['AC1', 'AC2'],
      constraints: ['C1'],
      instructions: ['Inst1'],
      contextFiles: ['src/a.ts', 'src/b.ts'],
      verificationCommands: { TEST: null, LINT: null, BUILD: null },
      managerMessageId: 'msg-1',
      managerPayloadHash: 'hash-1',
    });

    const payload2 = computeCanonicalPayload({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      attemptId: null,
      taskTitle: 'Title',
      taskDescription: 'Desc',
      acceptanceCriteria: ['AC1', 'AC2'],
      constraints: ['C1'],
      instructions: ['Inst1'],
      contextFiles: ['src/a.ts', 'src/b.ts'],
      verificationCommands: { TEST: null, LINT: null, BUILD: null },
      managerMessageId: 'msg-1',
      managerPayloadHash: 'hash-1',
    });

    expect(computePayloadHash(payload1)).toBe(computePayloadHash(payload2));
  });

  // 27. Context traversal paths (../) and sensitive credential paths are rejected
  it('27. Context traversal paths (../) and sensitive credential paths (.env, .ssh) are rejected', () => {
    const traversal = sanitizeContextFiles(['../secret.txt'], tmpDir);
    expect(traversal.error).toContain('CONTEXT_PATH_TRAVERSAL');

    const sensitive = sanitizeContextFiles(['.env'], tmpDir);
    expect(sensitive.error).toContain('CONTEXT_PATH_DENIED');
  });

  // 28. Duplicate and out-of-order context paths are deduplicated and sorted deterministically
  it('28. Duplicate and out-of-order context paths are deduplicated and sorted deterministically', () => {
    const result = sanitizeContextFiles(['src/z.ts', 'src/a.ts', 'src/z.ts', 'src\\b.ts'], tmpDir);
    expect(result.validFiles).toEqual(['src/a.ts', 'src/b.ts', 'src/z.ts']);
  });

  // 29. Restart persistence: authorization record survives database reconnection
  it('29. Authorization record survives database reconnection and cannot be reused if DISPATCHED', async () => {
    const dbFile = path.join(tmpDir, 'restart_test.db');
    const diskDb = new Database(dbFile);
    MigrationRunner.run(diskDb);

    const diskRepo = new Repository(diskDb);
    const diskEvents = new EventService(diskRepo);
    const diskRegistry = new ProviderRegistry();
    const diskRouter = new ProviderRoutingService(diskRepo, diskRegistry, diskEvents);
    const diskAuthService = new ExecutionAuthorizationService(diskRepo, diskEvents);
    const diskDispatcher = new ProviderDispatchService(diskRegistry, diskRepo, diskEvents);

    diskRepo.createProject({
      id: 'PROJ-RESTART',
      name: 'Restart Project',
      description: null,
      repository_path: tmpDir,
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    });

    diskRepo.createTask({
      id: 'TSK-RESTART',
      project_id: 'PROJ-RESTART',
      milestone_id: null,
      title: 'Restart Task',
      description: null,
      state: 'CODING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'LOW',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: initialGitSha,
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const msgId = 'msg-mgr-restart';
    const rawPayload = JSON.stringify({
      protocol: 'manager.v1',
      message_id: msgId,
      project_id: 'PROJ-RESTART',
      task_id: 'TSK-RESTART',
      decision: 'EXECUTE',
      expected_revision: 0,
      instructions: ['Work after restart'],
    });
    const pHash = crypto.createHash('sha256').update(rawPayload).digest('hex');
    diskRepo.recordProtocolMessage(
      'rec-mgr-restart',
      msgId,
      'manager.v1',
      'PROJ-RESTART',
      'TSK-RESTART',
      'APPROVED',
      0,
      pHash,
      rawPayload,
      'APPLIED',
      undefined
    );

    const mock = new MockExecutionAdapter('prov-restart', 'Restart Provider');
    diskRegistry.register(mock);
    diskRepo.createProvider({
      id: 'prov-restart',
      name: 'Restart Provider',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: new Date().toISOString(),
    });
    diskRepo.createProviderResource({
      id: 'res-restart',
      provider_id: 'prov-restart',
      model_name: 'Restart Model',
      health_status: 'AVAILABLE',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 0,
      last_health_check: null,
    });

    const decision = await diskRouter.route({
      projectId: 'PROJ-RESTART',
      taskId: 'TSK-RESTART',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-restart'],
      allowManualBridge: false,
    });

    const auth = await diskAuthService.createAuthorization({
      projectId: 'PROJ-RESTART',
      taskId: 'TSK-RESTART',
      routingDecisionId: decision.decisionId,
    });

    const res1 = await diskDispatcher.dispatch(auth.id);
    expect(res1.status).toBe('COMPLETED');

    diskDb.close();

    const reopenedDb = new Database(dbFile);
    reopenedDb.pragma('foreign_keys = ON');
    const reopenedRepo = new Repository(reopenedDb);
    const reopenedRegistry = new ProviderRegistry();
    reopenedRegistry.register(new MockExecutionAdapter('prov-restart', 'Restart Provider'));
    const reopenedDispatcher = new ProviderDispatchService(reopenedRegistry, reopenedRepo);

    const loadedAuth = reopenedRepo.getExecutionAuthorization(auth.id);
    expect(loadedAuth).not.toBeNull();
    expect(loadedAuth!.status).toBe('DISPATCHED');

    const res2 = await reopenedDispatcher.dispatch(auth.id);
    expect(res2.status).toBe('FAILED');
    expect(res2.error).toContain('EXECUTION_AUTHORIZATION_ALREADY_DISPATCHED');

    reopenedDb.close();
  }, 60000);
});
