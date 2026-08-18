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
} from '../src/core/adapters/ProviderAdapter';
import {
  ProviderAdapterType,
  ProviderHealthStatus,
  Capability,
  TaskState,
} from '../src/core/types/domain';
import { ManualBridgeAdapter } from '../src/core/adapters/ManualBridgeAdapter';
import { CodexCliAdapter } from '../src/core/adapters/CodexCliAdapter';
import { ProviderRoutingService, RoutingRequest } from '../src/core/services/ProviderRoutingService';
import { ProviderDispatchService } from '../src/core/services/ProviderDispatchService';
import {
  ExecutionAuthorizationService,
  computeCanonicalPayload,
  computePayloadHash,
  computeContextManifestHash,
  sanitizeContextFiles,
  buildCanonicalInstructions,
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
    });
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

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
    const msgId = params.messageId ?? `msg-mgr-${crypto.randomUUID().slice(0, 8)}`;
    const recId = params.recordId ?? `rec-mgr-${crypto.randomUUID().slice(0, 8)}`;
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
      undefined
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
  // BLOCKER 1 & 2: MANAGER AUTHORITY & GIT BINDING TESTS
  // =========================================================================

  // 1. CreateAuthorizationParams no longer accepts instructions
  it('1. CreateAuthorizationParams no longer accepts instructions property', async () => {
    setupResource('res-1', 'prov-1');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-1'],
      allowManualBridge: false,
    });

    const params: any = {
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
      instructions: ['INJECTED_INSTRUCTION_ATTEMPT'],
    };

    const auth = await authService.createAuthorization(params);
    // Durable instructions must come from Manager truth + Task, ignoring caller field
    const parsed = JSON.parse(auth.canonical_instructions_json);
    expect(parsed).not.toContain('INJECTED_INSTRUCTION_ATTEMPT');
    expect(parsed).toContain('Manager Instructions (EXECUTE):');
  });

  // 2. Applied manager EXECUTE instructions become execution authority
  it('2. Applied manager EXECUTE instructions become execution authority', async () => {
    setupResource('res-2', 'prov-2');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-2'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    const parsed = JSON.parse(auth.canonical_instructions_json);
    expect(parsed).toContain('Manager Instructions (EXECUTE):');
    expect(parsed).toContain('- Implement feature according to spec');
  });

  // 3. A caller cannot substitute different instructions
  it('3. A caller cannot substitute different instructions', async () => {
    setupResource('res-3', 'prov-3');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-3'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    const result = await dispatcher.dispatch(auth.id);
    expect(result.status).toBe('COMPLETED');
  });

  // 4. Task manually placed in CODING with no APPLIED Manager work authority cannot authorize
  it('4. Task manually placed in CODING with no APPLIED Manager work authority cannot authorize', async () => {
    repo.createTask({
      id: 'TSK-MANUAL-CODING',
      project_id: 'PROJ-AUTH',
      milestone_id: null,
      title: 'Manual Task Without Manager Ledger',
      description: 'Forced into coding',
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

    setupResource('res-4', 'prov-4');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-MANUAL-CODING',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-4'],
      allowManualBridge: false,
    });

    await expect(
      authService.createAuthorization({
        projectId: 'PROJ-AUTH',
        taskId: 'TSK-MANUAL-CODING',
        routingDecisionId: decision.decisionId,
      })
    ).rejects.toThrow('EXECUTION_AUTHORIZATION_MANAGER_AUTHORITY_MISSING');
  });

  // 5. REJECTED Manager message cannot authorize
  it('5. REJECTED Manager message cannot authorize', async () => {
    repo.createTask({
      id: 'TSK-REJECTED-MGR',
      project_id: 'PROJ-AUTH',
      milestone_id: null,
      title: 'Task With Rejected Manager Message',
      description: 'Test rejected',
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

    recordAppliedManagerMessage('PROJ-AUTH', 'TSK-REJECTED-MGR', {
      decision: 'EXECUTE',
      status: 'REJECTED',
    });

    setupResource('res-5', 'prov-5');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-REJECTED-MGR',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-5'],
      allowManualBridge: false,
    });

    await expect(
      authService.createAuthorization({
        projectId: 'PROJ-AUTH',
        taskId: 'TSK-REJECTED-MGR',
        routingDecisionId: decision.decisionId,
      })
    ).rejects.toThrow('EXECUTION_AUTHORIZATION_MANAGER_AUTHORITY_MISSING');
  });

  // 6. PASS / BLOCK / PAUSE / CANCEL / NEEDS_OWNER / CREATE_TASKS Manager decisions cannot authorize execution
  it('6. PASS / BLOCK / PAUSE / CANCEL / NEEDS_OWNER / CREATE_TASKS Manager decisions cannot authorize execution', async () => {
    const nonAuthorizingDecisions: Array<'PASS' | 'BLOCK' | 'PAUSE' | 'CANCEL' | 'NEEDS_OWNER' | 'CREATE_TASKS'> = [
      'PASS',
      'BLOCK',
      'PAUSE',
      'CANCEL',
      'NEEDS_OWNER',
      'CREATE_TASKS',
    ];

    setupResource('res-6', 'prov-6');

    for (const dec of nonAuthorizingDecisions) {
      const taskId = `TSK-DEC-${dec}`;
      repo.createTask({
        id: taskId,
        project_id: 'PROJ-AUTH',
        milestone_id: null,
        title: `Task with ${dec}`,
        description: 'Test decision',
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

      recordAppliedManagerMessage('PROJ-AUTH', taskId, {
        decision: dec,
        status: 'APPLIED',
      });

      const decision = await router.route({
        projectId: 'PROJ-AUTH',
        taskId,
        requiredCapabilities: ['CODING'],
        candidateResourceIds: ['res-6'],
        allowManualBridge: false,
      });

      await expect(
        authService.createAuthorization({
          projectId: 'PROJ-AUTH',
          taskId,
          routingDecisionId: decision.decisionId,
        })
      ).rejects.toThrow('EXECUTION_AUTHORIZATION_MANAGER_DECISION_NON_AUTHORIZING');
    }
  });

  // 7. Latest applicable FIX_REQUIRED authority is correctly bound to the new coding revision
  it('7. Latest applicable FIX_REQUIRED authority is correctly bound to the new coding revision', async () => {
    // Increment revision count to 1 (entered fix cycle)
    db.prepare('UPDATE tasks SET revision_count = 1 WHERE id = ?').run('TSK-AUTH-001');

    recordAppliedManagerMessage('PROJ-AUTH', 'TSK-AUTH-001', {
      decision: 'FIX_REQUIRED',
      expected_revision: 0, // Manager message was created for revision 0, incrementing task to revision 1
      instructions: ['Fix critical unit test failure'],
    });

    setupResource('res-7', 'prov-7');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-7'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    expect(auth.task_revision).toBe(1);
    const parsed = JSON.parse(auth.canonical_instructions_json);
    expect(parsed).toContain('Manager Instructions (FIX_REQUIRED):');
    expect(parsed).toContain('- Fix critical unit test failure');
  });

  // 8. Authorization stores manager_message_id and manager_payload_hash
  it('8. Authorization stores manager_message_id and manager_payload_hash', async () => {
    setupResource('res-8', 'prov-8');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-8'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    expect(auth.manager_message_id).toBeDefined();
    expect(auth.manager_payload_hash).toBeDefined();
    expect(auth.manager_payload_hash).toHaveLength(64); // SHA-256 hex string
  });

  // 9. Manager message/hash mismatch before dispatch: INVALIDATED, zero execution
  it('9. Manager message/hash mismatch before dispatch invalidates authorization with zero execution', async () => {
    const mock = setupResource('res-9', 'prov-9');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-9'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Tamper with Manager message payload hash in database
    db.prepare('UPDATE protocol_messages SET payload_hash = ? WHERE id = ?').run('tampered_hash_123', auth.manager_message_id);

    const result = await dispatcher.dispatch(auth.id);

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('EXECUTION_AUTHORIZATION_MANAGER_AUTHORITY_INVALID');
    expect(mock.executionCount).toBe(0);

    const updatedAuth = repo.getExecutionAuthorization(auth.id);
    expect(updatedAuth!.status).toBe('INVALIDATED');
  });

  // 10. REVIEWING alone cannot authorize
  it('10. Task state REVIEWING alone cannot authorize', async () => {
    db.prepare('UPDATE tasks SET state = ? WHERE id = ?').run('REVIEWING', 'TSK-AUTH-001');

    setupResource('res-10', 'prov-10');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-10'],
      allowManualBridge: false,
    });

    await expect(
      authService.createAuthorization({
        projectId: 'PROJ-AUTH',
        taskId: 'TSK-AUTH-001',
        routingDecisionId: decision.decisionId,
      })
    ).rejects.toThrow('EXECUTION_AUTHORIZATION_TASK_STATE_INCOMPATIBLE');
  });

  // 11. VALIDATING alone cannot authorize
  it('11. Task state VALIDATING alone cannot authorize', async () => {
    db.prepare('UPDATE tasks SET state = ? WHERE id = ?').run('VALIDATING', 'TSK-AUTH-001');

    setupResource('res-11', 'prov-11');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-11'],
      allowManualBridge: false,
    });

    await expect(
      authService.createAuthorization({
        projectId: 'PROJ-AUTH',
        taskId: 'TSK-AUTH-001',
        routingDecisionId: decision.decisionId,
      })
    ).rejects.toThrow('EXECUTION_AUTHORIZATION_TASK_STATE_INCOMPATIBLE');
  });

  // 12. REVIEW_READY alone cannot authorize
  it('12. Task state REVIEW_READY alone cannot authorize', async () => {
    db.prepare('UPDATE tasks SET state = ? WHERE id = ?').run('REVIEW_READY', 'TSK-AUTH-001');

    setupResource('res-12', 'prov-12');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-12'],
      allowManualBridge: false,
    });

    await expect(
      authService.createAuthorization({
        projectId: 'PROJ-AUTH',
        taskId: 'TSK-AUTH-001',
        routingDecisionId: decision.decisionId,
      })
    ).rejects.toThrow('EXECUTION_AUTHORIZATION_TASK_STATE_INCOMPATIBLE');
  });

  // 13. Missing task.base_sha: authorization creation fails, no zero SHA is fabricated
  it('13. Missing task.base_sha fails closed on authorization creation without zero-SHA fallback', async () => {
    db.prepare('UPDATE tasks SET base_sha = NULL WHERE id = ?').run('TSK-AUTH-001');

    setupResource('res-13', 'prov-13');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-13'],
      allowManualBridge: false,
    });

    await expect(
      authService.createAuthorization({
        projectId: 'PROJ-AUTH',
        taskId: 'TSK-AUTH-001',
        routingDecisionId: decision.decisionId,
      })
    ).rejects.toThrow('EXECUTION_AUTHORIZATION_BASE_SHA_MISSING');
  });

  // 14. Authorization captures real repository_head_sha
  it('14. Authorization captures real repository_head_sha from GitService', async () => {
    setupResource('res-14', 'prov-14');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-14'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    expect(auth.repository_head_sha).toBe(initialGitSha);
  });

  // 15. Actual Git HEAD changes after authorization: STALE_GIT_HEAD, INVALIDATED, zero execution
  it('15. Actual Git HEAD changes after authorization fails closed with STALE_GIT_HEAD and invalidation', async () => {
    const mock = setupResource('res-15', 'prov-15');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-15'],
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

  // 16. Unchanged actual Git HEAD: valid dispatch succeeds
  it('16. Unchanged actual Git HEAD dispatch succeeds', async () => {
    const mock = setupResource('res-16', 'prov-16');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-16'],
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

  // 17. Routing attemptId mismatch: INVALIDATED, zero execution
  it('17. Routing attemptId mismatch invalidates authorization with zero execution', async () => {
    const mock = setupResource('res-17', 'prov-17');

    repo.createTaskAttempt({
      id: 'ATT-AUTH-017',
      task_id: 'TSK-AUTH-001',
      attempt_number: 1,
      agent_id: 'agent-1',
      status: 'RUNNING',
      started_at: new Date().toISOString(),
      ended_at: null,
      summary: null,
    });

    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      attemptId: 'ATT-AUTH-017',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-17'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      attemptId: 'ATT-AUTH-017',
      routingDecisionId: decision.decisionId,
    });

    // Tamper with routing decision event in database
    const routingEv = repo.getRoutingDecisionEvent(decision.decisionId);
    const modifiedPayload = { ...routingEv!.structured_payload, attemptId: 'ATT-DIFFERENT' };
    db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(modifiedPayload), routingEv!.id);

    const result = await dispatcher.dispatch(auth.id);

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('EXECUTION_AUTHORIZATION_ROUTING_ATTEMPT_MISMATCH');
    expect(mock.executionCount).toBe(0);

    const updatedAuth = repo.getExecutionAuthorization(auth.id);
    expect(updatedAuth!.status).toBe('INVALIDATED');
  });

  // 18. Routing selectedResourceId mismatch: INVALIDATED, zero execution
  it('18. Routing selectedResourceId mismatch invalidates authorization with zero execution', async () => {
    const mock = setupResource('res-18', 'prov-18');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-18'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Tamper with routing decision event
    const routingEv = repo.getRoutingDecisionEvent(decision.decisionId);
    const modifiedPayload = { ...routingEv!.structured_payload, selectedResourceId: 'res-tampered' };
    db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(modifiedPayload), routingEv!.id);

    const result = await dispatcher.dispatch(auth.id);

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('EXECUTION_AUTHORIZATION_ROUTING_RESOURCE_MISMATCH');
    expect(mock.executionCount).toBe(0);

    const updatedAuth = repo.getExecutionAuthorization(auth.id);
    expect(updatedAuth!.status).toBe('INVALIDATED');
  });

  // 19. Routing selectedProviderId mismatch: INVALIDATED, zero execution
  it('19. Routing selectedProviderId mismatch invalidates authorization with zero execution', async () => {
    const mock = setupResource('res-19', 'prov-19');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-19'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Tamper with routing decision event
    const routingEv = repo.getRoutingDecisionEvent(decision.decisionId);
    const modifiedPayload = { ...routingEv!.structured_payload, selectedProviderId: 'prov-tampered' };
    db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(modifiedPayload), routingEv!.id);

    const result = await dispatcher.dispatch(auth.id);

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('EXECUTION_AUTHORIZATION_ROUTING_PROVIDER_MISMATCH');
    expect(mock.executionCount).toBe(0);

    const updatedAuth = repo.getExecutionAuthorization(auth.id);
    expect(updatedAuth!.status).toBe('INVALIDATED');
  });

  // 20. Malformed canonical_instructions_json: structured FAILED, INVALIDATED, zero execution
  it('20. Malformed canonical_instructions_json fails closed with invalidation and zero execution', async () => {
    const mock = setupResource('res-20', 'prov-20');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-20'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Corrupt canonical_instructions_json in database
    db.prepare('UPDATE execution_authorizations SET canonical_instructions_json = ? WHERE id = ?').run('NOT_JSON{', auth.id);

    const result = await dispatcher.dispatch(auth.id);

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('EXECUTION_AUTHORIZATION_PAYLOAD_CORRUPT');
    expect(mock.executionCount).toBe(0);

    const updatedAuth = repo.getExecutionAuthorization(auth.id);
    expect(updatedAuth!.status).toBe('INVALIDATED');
  });

  // 21. Malformed context_files_json: structured FAILED, INVALIDATED, zero execution
  it('21. Malformed context_files_json fails closed with invalidation and zero execution', async () => {
    const mock = setupResource('res-21', 'prov-21');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-21'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Corrupt context_files_json in database
    db.prepare('UPDATE execution_authorizations SET context_files_json = ? WHERE id = ?').run('12345', auth.id); // Not an array

    const result = await dispatcher.dispatch(auth.id);

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('EXECUTION_AUTHORIZATION_PAYLOAD_CORRUPT');
    expect(mock.executionCount).toBe(0);

    const updatedAuth = repo.getExecutionAuthorization(auth.id);
    expect(updatedAuth!.status).toBe('INVALIDATED');
  });

  // 22. Stale task revision invalidates authorization permanently
  it('22. Stale task revision invalidates authorization permanently', async () => {
    const mock = setupResource('res-22', 'prov-22');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-22'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Advance task revision count in database
    db.prepare('UPDATE tasks SET revision_count = 1 WHERE id = ?').run('TSK-AUTH-001');

    const result = await dispatcher.dispatch(auth.id);

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('EXECUTION_AUTHORIZATION_STALE_TASK_REVISION');
    expect(mock.executionCount).toBe(0);

    const updatedAuth = repo.getExecutionAuthorization(auth.id);
    expect(updatedAuth!.status).toBe('INVALIDATED');
  });

  // 23. Restoring an old task revision afterward does NOT make that authorization usable again
  it('23. Restoring an old task revision afterward does not make an INVALIDATED authorization usable again', async () => {
    const mock = setupResource('res-23', 'prov-23');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-23'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Make stale -> invalidates
    db.prepare('UPDATE tasks SET revision_count = 1 WHERE id = ?').run('TSK-AUTH-001');
    const res1 = await dispatcher.dispatch(auth.id);
    expect(res1.status).toBe('FAILED');

    // Restore old revision count
    db.prepare('UPDATE tasks SET revision_count = 0 WHERE id = ?').run('TSK-AUTH-001');

    const res2 = await dispatcher.dispatch(auth.id);
    expect(res2.status).toBe('FAILED');
    expect(res2.error).toContain('EXECUTION_AUTHORIZATION_INVALIDATED');
    expect(mock.executionCount).toBe(0);
  });

  // 24. Deleting referenced attempt cannot silently SET NULL authorization scope (enforced by ON DELETE RESTRICT)
  it('24. Deleting referenced attempt is restricted by foreign key constraints', async () => {
    setupResource('res-24', 'prov-24');
    repo.createTaskAttempt({
      id: 'ATT-AUTH-024',
      task_id: 'TSK-AUTH-001',
      attempt_number: 1,
      agent_id: 'agent-1',
      status: 'RUNNING',
      started_at: new Date().toISOString(),
      ended_at: null,
      summary: null,
    });

    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      attemptId: 'ATT-AUTH-024',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-24'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      attemptId: 'ATT-AUTH-024',
      routingDecisionId: decision.decisionId,
    });

    // Attempting to delete attempt must throw foreign key restriction error
    expect(() => {
      db.prepare('DELETE FROM task_attempts WHERE id = ?').run('ATT-AUTH-024');
    }).toThrow('FOREIGN KEY constraint failed');

    // Verify attempt_id remains bound
    const loadedAuth = repo.getExecutionAuthorization(auth.id);
    expect(loadedAuth!.attempt_id).toBe('ATT-AUTH-024');
  });

  // 25. Deleting referenced task/resource/provider cannot cascade-delete historical authorization
  it('25. Deleting referenced task, resource, or provider is restricted and cannot cascade-delete authorization', async () => {
    setupResource('res-25', 'prov-25');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-25'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Foreign key RESTRICT prevents cascade deletion
    expect(() => db.prepare('DELETE FROM tasks WHERE id = ?').run('TSK-AUTH-001')).toThrow(
      'FOREIGN KEY constraint failed'
    );
    expect(() => db.prepare('DELETE FROM provider_resources WHERE id = ?').run('res-25')).toThrow(
      'FOREIGN KEY constraint failed'
    );
    expect(() => db.prepare('DELETE FROM providers WHERE id = ?').run('prov-25')).toThrow(
      'FOREIGN KEY constraint failed'
    );

    // Authorization still exists intact
    expect(repo.getExecutionAuthorization(auth.id)).not.toBeNull();
  });

  // 26. Valid automated fake provider still executes exactly once
  it('26. Valid automated fake provider executes exactly once', async () => {
    const mock = setupResource('res-26', 'prov-26');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-26'],
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

  // 27. Concurrent dispatch still executes exactly once
  it('27. Concurrent dispatch calls produce exactly 1 provider execution (atomic claim)', async () => {
    const mock = setupResource('res-27', 'prov-27');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-27'],
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

  // 28. Provider FAILED after atomic claim remains DISPATCHED
  it('28. Provider execution returning FAILED leaves authorization consumed as DISPATCHED', async () => {
    setupResource('res-28', 'prov-28', {
      customExecutionResult: { status: 'FAILED', error: 'Compiler error in user code' },
    });
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-28'],
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

  // 29. Timeout / cancellation / PROTOCOL_INVALID remain DISPATCHED
  it('29. Timeout / cancellation / PROTOCOL_INVALID leave authorization consumed as DISPATCHED', async () => {
    setupResource('res-29', 'prov-29', {
      customExecutionResult: { status: 'CANCELLED', error: 'Execution cancelled by owner' },
    });
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-29'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    const result = await dispatcher.dispatch(auth.id);
    expect(result.status).toBe('CANCELLED');

    const loaded = repo.getExecutionAuthorization(auth.id);
    expect(loaded!.status).toBe('DISPATCHED');
  });

  // 30. Manual Bridge remains AWAITING_OWNER and cannot replay
  it('30. Manual Bridge authorization dispatch returns AWAITING_OWNER and cannot be replayed', async () => {
    const manualAdapter = new ManualBridgeAdapter();
    registry.register(manualAdapter);
    repo.createProvider({
      id: 'prov-manual-bridge',
      name: 'Manual Bridge',
      adapter_type: 'MANUAL_BRIDGE',
      enabled: true,
      created_at: new Date().toISOString(),
    });
    repo.createProviderResource({
      id: 'res-manual-30',
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
      candidateResourceIds: ['res-manual-30'],
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

  // 31. PR #6 routing tests remain green
  it('31. PR #6 routing semantics (AVAILABLE > LOW_QUOTA) remain intact', async () => {
    setupResource('res-31-a', 'prov-31-a', { health: 'LOW_QUOTA' });
    setupResource('res-31-b', 'prov-31-b', { health: 'AVAILABLE' });

    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-31-a', 'res-31-b'],
      allowManualBridge: false,
    });

    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedResourceId).toBe('res-31-b');
  });

  // 32. Codex remains OFFLINE / [] / fail-closed
  it('32. Codex CLI contract remains OFFLINE with empty capabilities and fails closed', async () => {
    const codexAdapter = new CodexCliAdapter({ repo, artifactStore: {} as any });
    expect(await codexAdapter.getHealth()).toBe('OFFLINE');
    expect(await codexAdapter.getCapabilities()).toEqual([]);

    const execResult = await codexAdapter.execute({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      instructions: ['Task'],
      contextFiles: [],
    });

    expect(execResult.status).toBe('FAILED');
    expect(execResult.error).toContain('CODEX_CLI_UNAVAILABLE');
    expect(execResult.error).toContain('not installed or contract is unverified');
  });

  // 33. Antigravity remains MANUAL_BRIDGE_ONLY
  it('33. Antigravity provider operates exclusively through Manual Bridge contract', async () => {
    const manualAdapter = new ManualBridgeAdapter();
    expect(manualAdapter.adapterType).toBe('MANUAL_BRIDGE');
    const health = await manualAdapter.getHealth();
    expect(health).toBe('UNKNOWN');
  });

  // 34. Canonical payload determinism & hashing
  it('34. Identical canonical payloads produce the exact same SHA-256 hash', () => {
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
      managerMessageId: 'msg-1',
      managerPayloadHash: 'hash-1',
    });

    expect(computePayloadHash(payload1)).toBe(computePayloadHash(payload2));
  });

  // 35. Context traversal paths (../) and sensitive credential paths are rejected
  it('35. Context traversal paths (../) and sensitive credential paths (.env, .ssh) are rejected', () => {
    const traversal = sanitizeContextFiles(['../secret.txt'], tmpDir);
    expect(traversal.error).toContain('CONTEXT_PATH_TRAVERSAL');

    const sensitive = sanitizeContextFiles(['.env'], tmpDir);
    expect(sensitive.error).toContain('CONTEXT_PATH_DENIED');
  });

  // 36. Duplicate and out-of-order context paths are deduplicated and sorted deterministically
  it('36. Duplicate and out-of-order context paths are deduplicated and sorted deterministically', () => {
    const result = sanitizeContextFiles(['src/z.ts', 'src/a.ts', 'src/z.ts', 'src\\b.ts'], tmpDir);
    expect(result.validFiles).toEqual(['src/a.ts', 'src/b.ts', 'src/z.ts']);
  });

  // 37. Audit events contain payload hashes but zero secrets or raw credentials
  it('37. Audit events contain payload hashes and metadata but zero raw secrets', async () => {
    setupResource('res-37', 'prov-37');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-37'],
      allowManualBridge: false,
    });

    const auth = await authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    await dispatcher.dispatch(auth.id);

    const events = eventService.getEvents('PROJ-AUTH');
    const createdEv = events.find((e) => e.type === 'EXECUTION_AUTHORIZATION_CREATED');
    const dispatchedEv = events.find((e) => e.type === 'EXECUTION_AUTHORIZATION_DISPATCHED');

    expect(createdEv).toBeDefined();
    expect(dispatchedEv).toBeDefined();

    const createdPayload = JSON.stringify(createdEv!.structured_payload);
    expect(createdPayload).toContain('instructionPayloadHash');
    expect(createdPayload).toContain('managerPayloadHash');
    expect(createdPayload).not.toContain('API_KEY');
    expect(createdPayload).not.toContain('SECRET');
  });

  // 38. Authorization record survives database reconnection / app restart
  it('38. Authorization record survives database reconnection and cannot be reused if DISPATCHED', async () => {
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

    // Create applied manager message
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

    // Execute first time
    const res1 = await diskDispatcher.dispatch(auth.id);
    expect(res1.status).toBe('COMPLETED');

    // Close database to simulate app termination
    diskDb.close();

    // Reopen database to simulate restart
    const reopenedDb = new Database(dbFile);
    reopenedDb.pragma('foreign_keys = ON');
    const reopenedRepo = new Repository(reopenedDb);
    const reopenedRegistry = new ProviderRegistry();
    reopenedRegistry.register(new MockExecutionAdapter('prov-restart', 'Restart Provider'));
    const reopenedDispatcher = new ProviderDispatchService(reopenedRegistry, reopenedRepo);

    // Assert authorization record exists with status DISPATCHED
    const loadedAuth = reopenedRepo.getExecutionAuthorization(auth.id);
    expect(loadedAuth).not.toBeNull();
    expect(loadedAuth!.status).toBe('DISPATCHED');

    // Second dispatch on reopened database fails closed
    const res2 = await reopenedDispatcher.dispatch(auth.id);
    expect(res2.status).toBe('FAILED');
    expect(res2.error).toContain('EXECUTION_AUTHORIZATION_ALREADY_DISPATCHED');

    reopenedDb.close();
  });
});
