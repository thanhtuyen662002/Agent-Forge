import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
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
    public quota: QuotaSnapshotInfo = {
      remaining: null,
      total: null,
      unit: 'REQUESTS',
      source: 'UNKNOWN',
      confidence: 0.0,
      resetAt: null,
    },
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
    return this.quota;
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
        message_id: 'msg-exec-mock',
        project_id: request.projectId,
        task_id: request.taskId,
        attempt: 1,
        status: 'COMPLETED',
        completed: ['Task successfully finished'],
        remaining: [],
        files_claimed_changed: [],
        tests_claimed: [],
        blockers: [],
        review_requested: true,
        expected_task_state: 'CODING',
        expected_revision: 0,
      }),
      rawResponse: 'Execution finished successfully',
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

  function setupResource(
    resourceId: string,
    providerId: string,
    options: {
      health?: ProviderHealthStatus;
      capabilities?: Capability[];
      adapterType?: ProviderAdapterType;
      enabled?: boolean;
      providerEnabled?: boolean;
      customExecutionResult?: Partial<AgentExecutionResult>;
    } = {}
  ): MockExecutionAdapter {
    const mock = new MockExecutionAdapter(
      providerId,
      `Mock ${providerId}`,
      options.adapterType ?? 'LOCAL_CLI',
      options.health ?? 'AVAILABLE',
      options.capabilities ?? ['CODING', 'FILESYSTEM_EDIT'],
      { remaining: null, total: null, unit: 'REQUESTS', source: 'UNKNOWN', confidence: 0, resetAt: null },
      options.customExecutionResult
    );
    registry.register(mock);

    repo.createProvider({
      id: providerId,
      name: `Provider ${providerId}`,
      adapter_type: options.adapterType ?? 'LOCAL_CLI',
      enabled: options.providerEnabled ?? true,
      created_at: new Date().toISOString(),
    });

    repo.createProviderResource({
      id: resourceId,
      provider_id: providerId,
      model_name: `Model for ${resourceId}`,
      health_status: options.health ?? 'AVAILABLE',
      capabilities: options.capabilities ?? ['CODING', 'FILESYSTEM_EDIT'],
      enabled: options.enabled ?? true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 0,
      last_health_check: new Date().toISOString(),
    });

    return mock;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-auth-test-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);

    repo = new Repository(db);
    eventService = new EventService(repo);
    registry = new ProviderRegistry();
    router = new ProviderRoutingService(repo, registry, eventService);
    dispatcher = new ProviderDispatchService(registry, repo, eventService);
    authService = new ExecutionAuthorizationService(repo, eventService);

    // Create default project and task in APPROVED state
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
      started_at: new Date().toISOString(),
      completed_at: null,
    });

    repo.createTask({
      id: 'TSK-AUTH-001',
      project_id: 'PROJ-AUTH',
      milestone_id: null,
      title: 'Implement Core Feature',
      description: 'Approved coding task with strict constraints',
      state: 'APPROVED',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 3,
      max_revisions: 5,
      base_sha: 'a1b2c3d4e5f60000000000000000000000000000',
      current_sha: 'a1b2c3d4e5f60000000000000000000000000000',
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: ['Feature works correctly', 'Unit tests pass'],
      constraints: ['No external network requests', 'Strict type safety'],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });

  // 1. Unknown project cannot authorize
  it('1. Unknown project cannot authorize and throws EXECUTION_AUTHORIZATION_FAILED', async () => {
    setupResource('res-1', 'prov-1');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-1'],
      allowManualBridge: false,
    });

    expect(() =>
      authService.createAuthorization({
        projectId: 'PROJ-UNKNOWN',
        taskId: 'TSK-AUTH-001',
        routingDecisionId: decision.decisionId,
      })
    ).toThrow('Project "PROJ-UNKNOWN" not found');
  });

  // 2. Unknown task cannot authorize
  it('2. Unknown task cannot authorize and throws EXECUTION_AUTHORIZATION_FAILED', async () => {
    setupResource('res-2', 'prov-2');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-2'],
      allowManualBridge: false,
    });

    expect(() =>
      authService.createAuthorization({
        projectId: 'PROJ-AUTH',
        taskId: 'TSK-UNKNOWN',
        routingDecisionId: decision.decisionId,
      })
    ).toThrow('Task "TSK-UNKNOWN" not found');
  });

  // 3. Cross-project task cannot authorize
  it('3. Cross-project task cannot authorize', async () => {
    repo.createProject({
      id: 'PROJ-OTHER',
      name: 'Other Project',
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

    setupResource('res-3', 'prov-3');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-3'],
      allowManualBridge: false,
    });

    expect(() =>
      authService.createAuthorization({
        projectId: 'PROJ-OTHER',
        taskId: 'TSK-AUTH-001',
        routingDecisionId: decision.decisionId,
      })
    ).toThrow('does not belong to project');
  });

  // 4. Invalid attempt ownership cannot authorize
  it('4. Invalid attempt ownership cannot authorize', async () => {
    repo.createTask({
      id: 'TSK-OTHER-4',
      project_id: 'PROJ-AUTH',
      milestone_id: null,
      title: 'Other Task',
      description: null,
      state: 'APPROVED',
      paused_from_state: null,
      priority: 'MEDIUM',
      risk: 'LOW',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 5,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    repo.createTaskAttempt({
      id: 'ATT-FOR-OTHER',
      task_id: 'TSK-OTHER-4',
      attempt_number: 1,
      agent_id: 'agent-1',
      status: 'RUNNING',
      started_at: new Date().toISOString(),
      ended_at: null,
      summary: null,
    });

    setupResource('res-4', 'prov-4');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-4'],
      allowManualBridge: false,
    });

    expect(() =>
      authService.createAuthorization({
        projectId: 'PROJ-AUTH',
        taskId: 'TSK-AUTH-001',
        attemptId: 'ATT-FOR-OTHER',
        routingDecisionId: decision.decisionId,
      })
    ).toThrow('does not belong to task');
  });

  // 5. Task without approved execution authority cannot authorize
  it('5. Tasks in unapproved states (CREATED, PLANNED, PAUSED, DONE, etc.) cannot authorize', async () => {
    const unapprovedStates: TaskState[] = [
      'CREATED',
      'PLANNED',
      'PAUSED',
      'BLOCKED',
      'WAITING_FOR_CAPACITY',
      'WAITING_FOR_AUTHORITY',
      'NEEDS_HUMAN',
      'DONE',
      'FAILED',
      'CANCELLED',
    ];

    setupResource('res-5', 'prov-5');

    for (const st of unapprovedStates) {
      db.prepare('UPDATE tasks SET state = ? WHERE id = ?').run(st, 'TSK-AUTH-001');

      const decision = await router.route({
        projectId: 'PROJ-AUTH',
        taskId: 'TSK-AUTH-001',
        requiredCapabilities: ['CODING'],
        candidateResourceIds: ['res-5'],
        allowManualBridge: false,
      });

      expect(() =>
        authService.createAuthorization({
          projectId: 'PROJ-AUTH',
          taskId: 'TSK-AUTH-001',
          routingDecisionId: decision.decisionId,
        })
      ).toThrow('does not have approved execution authority');
    }
  });

  // 6. Routing decision not found cannot authorize
  it('6. Non-existent routing decision cannot authorize', () => {
    expect(() =>
      authService.createAuthorization({
        projectId: 'PROJ-AUTH',
        taskId: 'TSK-AUTH-001',
        routingDecisionId: 'dec-non-existent-999',
      })
    ).toThrow('Routing decision "dec-non-existent-999" not found');
  });

  // 7. Routing decision scope mismatch cannot authorize
  it('7. Routing decision scope mismatch (task mismatch) cannot authorize', async () => {
    repo.createTask({
      id: 'TSK-AUTH-002',
      project_id: 'PROJ-AUTH',
      milestone_id: null,
      title: 'Second Task',
      description: null,
      state: 'APPROVED',
      paused_from_state: null,
      priority: 'MEDIUM',
      risk: 'LOW',
      assigned_agent_id: null,
      revision_count: 1,
      max_revisions: 5,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    setupResource('res-7', 'prov-7');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-7'],
      allowManualBridge: false,
    });

    expect(() =>
      authService.createAuthorization({
        projectId: 'PROJ-AUTH',
        taskId: 'TSK-AUTH-002',
        routingDecisionId: decision.decisionId,
      })
    ).toThrow('Routing decision task mismatch');
  });

  // 8. NO_ELIGIBLE_PROVIDER cannot authorize
  it('8. NO_ELIGIBLE_PROVIDER routing outcome cannot create authorization', async () => {
    setupResource('res-offline-8', 'prov-8', { health: 'OFFLINE' });
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-offline-8'],
      allowManualBridge: false,
    });
    expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');

    expect(() =>
      authService.createAuthorization({
        projectId: 'PROJ-AUTH',
        taskId: 'TSK-AUTH-001',
        routingDecisionId: decision.decisionId,
      })
    ).toThrow('Routing outcome "NO_ELIGIBLE_PROVIDER" cannot produce execution authorization');
  });

  // 9. NEEDS_OWNER cannot authorize
  it('9. NEEDS_OWNER routing outcome (e.g. AUTH_ERROR) cannot create authorization', async () => {
    setupResource('res-auth-err-9', 'prov-9', { health: 'AUTH_ERROR' });
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-auth-err-9'],
      allowManualBridge: false,
    });
    expect(decision.outcome).toBe('NEEDS_OWNER');

    expect(() =>
      authService.createAuthorization({
        projectId: 'PROJ-AUTH',
        taskId: 'TSK-AUTH-001',
        routingDecisionId: decision.decisionId,
      })
    ).toThrow('Routing outcome "NEEDS_OWNER" cannot produce execution authorization');
  });

  // 10. Valid SELECTED route creates authorization
  it('10. Valid SELECTED route creates durable authorization with status AUTHORIZED', async () => {
    setupResource('res-10', 'prov-10');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-10'],
      allowManualBridge: false,
    });
    expect(decision.outcome).toBe('SELECTED');

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    expect(auth.id).toBeDefined();
    expect(auth.status).toBe('AUTHORIZED');
    expect(auth.selected_resource_id).toBe('res-10');
    expect(auth.selected_provider_id).toBe('prov-10');
  });

  // 11. Valid MANUAL_HANDOFF_REQUIRED creates authorization
  it('11. Valid MANUAL_HANDOFF_REQUIRED creates durable authorization', async () => {
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
      id: 'res-manual-11',
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
      candidateResourceIds: ['res-manual-11'],
      allowManualBridge: true,
    });
    expect(decision.outcome).toBe('MANUAL_HANDOFF_REQUIRED');

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    expect(auth.status).toBe('AUTHORIZED');
    expect(auth.selected_provider_id).toBe('prov-manual-bridge');
  });

  // 12. Authorization binds project/task/attempt
  it('12. Authorization strictly binds project, task, and attempt', async () => {
    repo.createTaskAttempt({
      id: 'ATT-AUTH-12',
      task_id: 'TSK-AUTH-001',
      attempt_number: 1,
      agent_id: 'agent-1',
      status: 'RUNNING',
      started_at: new Date().toISOString(),
      ended_at: null,
      summary: null,
    });

    setupResource('res-12', 'prov-12');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      attemptId: 'ATT-AUTH-12',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-12'],
      allowManualBridge: false,
    });

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      attemptId: 'ATT-AUTH-12',
      routingDecisionId: decision.decisionId,
    });

    expect(auth.project_id).toBe('PROJ-AUTH');
    expect(auth.task_id).toBe('TSK-AUTH-001');
    expect(auth.attempt_id).toBe('ATT-AUTH-12');
  });

  // 13. Authorization binds task revision
  it('13. Authorization binds the current task revision count', async () => {
    setupResource('res-13', 'prov-13');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-13'],
      allowManualBridge: false,
    });

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    expect(auth.task_revision).toBe(3); // from task fixture
  });

  // 14. Authorization binds base SHA
  it('14. Authorization binds the expected Git base SHA', async () => {
    setupResource('res-14', 'prov-14');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-14'],
      allowManualBridge: false,
    });

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    expect(auth.base_sha).toBe('a1b2c3d4e5f60000000000000000000000000000');
  });

  // 15. Authorization binds routing decision ID
  it('15. Authorization durably references the routing decision ID', async () => {
    setupResource('res-15', 'prov-15');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-15'],
      allowManualBridge: false,
    });

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    expect(auth.routing_decision_id).toBe(decision.decisionId);
  });

  // 16. Authorization binds selected resource/provider
  it('16. Authorization binds the resolved provider and resource IDs', async () => {
    setupResource('res-16', 'prov-16');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-16'],
      allowManualBridge: false,
    });

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    expect(auth.selected_resource_id).toBe('res-16');
    expect(auth.selected_provider_id).toBe('prov-16');
  });

  // 17. Canonical payload is deterministic
  it('17. Canonical payload builder preserves ordered fields deterministically', () => {
    const p1 = computeCanonicalPayload({
      projectId: 'P1',
      taskId: 'T1',
      attemptId: null,
      taskTitle: 'Title',
      taskDescription: 'Desc',
      acceptanceCriteria: ['AC2', 'AC1'],
      constraints: ['C2', 'C1'],
      instructions: ['I1'],
      contextFiles: ['b.ts', 'a.ts'],
    });

    expect(p1.projectId).toBe('P1');
    expect(p1.taskTitle).toBe('Title');
    expect(p1.acceptanceCriteria).toEqual(['AC2', 'AC1']);
  });

  // 18. Same payload generates same hash
  it('18. Identical canonical payloads produce the exact same SHA-256 hash', () => {
    const payloadA = computeCanonicalPayload({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      attemptId: null,
      taskTitle: 'Title',
      taskDescription: 'Desc',
      acceptanceCriteria: ['AC1'],
      constraints: ['C1'],
      instructions: ['Inst1'],
      contextFiles: ['src/index.ts'],
    });

    const payloadB = computeCanonicalPayload({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      attemptId: null,
      taskTitle: 'Title',
      taskDescription: 'Desc',
      acceptanceCriteria: ['AC1'],
      constraints: ['C1'],
      instructions: ['Inst1'],
      contextFiles: ['src/index.ts'],
    });

    expect(computePayloadHash(payloadA)).toBe(computePayloadHash(payloadB));
  });

  // 19. Changed instruction changes hash
  it('19. Changing instructions changes instructionPayloadHash', () => {
    const base = {
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      attemptId: null,
      taskTitle: 'Title',
      taskDescription: 'Desc',
      acceptanceCriteria: ['AC1'],
      constraints: ['C1'],
      instructions: ['Original Instructions'],
      contextFiles: ['src/index.ts'],
    };

    const hash1 = computePayloadHash(computeCanonicalPayload(base));
    const hash2 = computePayloadHash(
      computeCanonicalPayload({ ...base, instructions: ['Modified Instructions'] })
    );

    expect(hash1).not.toBe(hash2);
  });

  // 20. Changed acceptance criteria changes hash
  it('20. Changing acceptance criteria changes instructionPayloadHash', () => {
    const base = {
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      attemptId: null,
      taskTitle: 'Title',
      taskDescription: 'Desc',
      acceptanceCriteria: ['Original AC'],
      constraints: ['C1'],
      instructions: ['Inst'],
      contextFiles: ['src/index.ts'],
    };

    const hash1 = computePayloadHash(computeCanonicalPayload(base));
    const hash2 = computePayloadHash(
      computeCanonicalPayload({ ...base, acceptanceCriteria: ['Different AC'] })
    );

    expect(hash1).not.toBe(hash2);
  });

  // 21. Changed context manifest changes hash
  it('21. Changing context manifest changes contextManifestHash', () => {
    const hash1 = computeContextManifestHash(['src/a.ts', 'src/b.ts']);
    const hash2 = computeContextManifestHash(['src/a.ts', 'src/c.ts']);
    expect(hash1).not.toBe(hash2);
  });

  // 22. Context traversal rejected
  it('22. Context traversal paths (../) are rejected during authorization', () => {
    const result = sanitizeContextFiles(['../outside.ts', 'src/safe.ts'], tmpDir);
    expect(result.error).toContain('CONTEXT_PATH_TRAVERSAL');
    expect(result.validFiles).toEqual([]);
  });

  // 23. Sensitive context path rejected
  it('23. Sensitive credential paths (.env, .ssh, .aws) are rejected', () => {
    expect(sanitizeContextFiles(['.env'], tmpDir).error).toContain('CONTEXT_PATH_DENIED');
    expect(sanitizeContextFiles(['.ssh/id_rsa'], tmpDir).error).toContain('CONTEXT_PATH_DENIED');
    expect(sanitizeContextFiles(['.aws/credentials'], tmpDir).error).toContain('CONTEXT_PATH_DENIED');
  });

  // 24. Duplicate context paths rejected/canonicalized deterministically
  it('24. Duplicate and out-of-order context paths are deduplicated and sorted deterministically', () => {
    const result = sanitizeContextFiles(['src/z.ts', 'src/a.ts', 'src/z.ts', 'src/b.ts'], tmpDir);
    expect(result.error).toBeUndefined();
    expect(result.validFiles).toEqual(['src/a.ts', 'src/b.ts', 'src/z.ts']);
  });

  // 25. Dispatch accepts authorizationId only
  it('25. ProviderDispatchService accepts authorizationId only (no caller instructions parameter)', () => {
    expect(dispatcher.dispatch.length).toBe(1);
  });

  // 26. Caller cannot substitute instructions at dispatch
  it('26. Instructions executed by provider originate strictly from durable authorization state', async () => {
    let capturedRequest: AgentExecutionRequest | null = null;
    const mock = setupResource('res-26', 'prov-26');
    mock.execute = async (req) => {
      mock.executionCount++;
      capturedRequest = req;
      return { executionId: crypto.randomUUID(), status: 'COMPLETED' };
    };

    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-26'],
      allowManualBridge: false,
    });

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
      instructions: ['Approved Durable Instruction Set'],
    });

    await dispatcher.dispatch(auth.id);

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.instructions).toEqual(['Approved Durable Instruction Set']);
  });

  // 27. Fabricated authorizationId yields zero execution
  it('27. Fabricated authorizationId yields zero provider executions', async () => {
    const mock = setupResource('res-27', 'prov-27');
    const result = await dispatcher.dispatch('fabricated-auth-id-999');

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('EXECUTION_AUTHORIZATION_NOT_FOUND');
    expect(mock.executionCount).toBe(0);
  });

  // 28. Stale task revision yields zero execution
  it('28. Modifying task revision after authorization fails closed with zero execution', async () => {
    const mock = setupResource('res-28', 'prov-28');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-28'],
      allowManualBridge: false,
    });

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Mutate task revision in database
    db.prepare('UPDATE tasks SET revision_count = 4 WHERE id = ?').run('TSK-AUTH-001');

    const result = await dispatcher.dispatch(auth.id);

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('EXECUTION_AUTHORIZATION_STALE_TASK_REVISION');
    expect(mock.executionCount).toBe(0);
  });

  // 29. Changed route/resource mapping yields zero execution
  it('29. Altering selected_provider_id in provider resource fails closed at dispatch', async () => {
    const mock = setupResource('res-29', 'prov-29');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-29'],
      allowManualBridge: false,
    });

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Alter provider mapping
    repo.createProvider({
      id: 'prov-alt',
      name: 'Alt Provider',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: new Date().toISOString(),
    });
    db.prepare('UPDATE provider_resources SET provider_id = ? WHERE id = ?').run('prov-alt', 'res-29');

    const result = await dispatcher.dispatch(auth.id);

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('ROUTING_PROVIDER_MISMATCH');
    expect(mock.executionCount).toBe(0);
  });

  // 30. Disabled resource after authorization yields zero execution
  it('30. Disabling selected resource after authorization fails closed with zero execution', async () => {
    const mock = setupResource('res-30', 'prov-30');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-30'],
      allowManualBridge: false,
    });

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    db.prepare('UPDATE provider_resources SET enabled = 0 WHERE id = ?').run('res-30');

    const result = await dispatcher.dispatch(auth.id);

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('ROUTING_RESOURCE_DISABLED');
    expect(mock.executionCount).toBe(0);
  });

  // 31. Disabled provider after authorization yields zero execution
  it('31. Disabling parent provider after authorization fails closed with zero execution', async () => {
    const mock = setupResource('res-31', 'prov-31');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-31'],
      allowManualBridge: false,
    });

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    db.prepare('UPDATE providers SET enabled = 0 WHERE id = ?').run('prov-31');

    const result = await dispatcher.dispatch(auth.id);

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('ROUTING_PROVIDER_DISABLED');
    expect(mock.executionCount).toBe(0);
  });

  // 32. Git/base mismatch yields zero execution
  it('32. Mismatch in task base SHA after authorization fails closed with zero execution', async () => {
    const mock = setupResource('res-32', 'prov-32');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-32'],
      allowManualBridge: false,
    });

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    db.prepare('UPDATE tasks SET base_sha = ? WHERE id = ?').run(
      'b2c3d4e5f6000000000000000000000000000000',
      'TSK-AUTH-001'
    );

    const result = await dispatcher.dispatch(auth.id);

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('EXECUTION_AUTHORIZATION_STALE_GIT_BASE');
    expect(mock.executionCount).toBe(0);
  });

  // 33. Valid automated fake provider executes exactly once
  it('33. Valid automated provider executes exactly once', async () => {
    const mock = setupResource('res-33', 'prov-33');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-33'],
      allowManualBridge: false,
    });

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    const result = await dispatcher.dispatch(auth.id);

    expect(result.status).toBe('COMPLETED');
    expect(mock.executionCount).toBe(1);
  });

  // 34. Second dispatch of same authorization executes zero times
  it('34. Second dispatch attempt on the same authorization fails with ALREADY_DISPATCHED and 0 executions', async () => {
    const mock = setupResource('res-34', 'prov-34');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-34'],
      allowManualBridge: false,
    });

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    const firstResult = await dispatcher.dispatch(auth.id);
    expect(firstResult.status).toBe('COMPLETED');
    expect(mock.executionCount).toBe(1);

    const secondResult = await dispatcher.dispatch(auth.id);
    expect(secondResult.status).toBe('FAILED');
    expect(secondResult.error).toContain('EXECUTION_AUTHORIZATION_ALREADY_DISPATCHED');
    expect(mock.executionCount).toBe(1); // Provider NOT executed again
  });

  // 35. Two competing dispatch calls produce exactly one provider execution
  it('35. Concurrent dispatch calls produce exactly 1 provider execution (atomic claim)', async () => {
    const mock = setupResource('res-35', 'prov-35');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-35'],
      allowManualBridge: false,
    });

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    // Run both dispatches in parallel
    const [resA, resB] = await Promise.all([
      dispatcher.dispatch(auth.id),
      dispatcher.dispatch(auth.id),
    ]);

    expect(mock.executionCount).toBe(1);
    const statuses = [resA.status, resB.status];
    expect(statuses).toContain('COMPLETED');
    expect(statuses).toContain('FAILED');
  });

  // 36. Provider FAILED after start leaves authorization consumed
  it('36. Provider execution returning FAILED leaves authorization consumed as DISPATCHED', async () => {
    const mock = setupResource('res-36', 'prov-36', {
      customExecutionResult: { status: 'FAILED', error: 'Process crashed' },
    });

    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-36'],
      allowManualBridge: false,
    });

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    const result = await dispatcher.dispatch(auth.id);
    expect(result.status).toBe('FAILED');
    expect(mock.executionCount).toBe(1);

    const savedAuth = repo.getExecutionAuthorization(auth.id);
    expect(savedAuth!.status).toBe('DISPATCHED');

    // Attempting replay fails
    const replayResult = await dispatcher.dispatch(auth.id);
    expect(replayResult.status).toBe('FAILED');
    expect(replayResult.error).toContain('EXECUTION_AUTHORIZATION_ALREADY_DISPATCHED');
  });

  // 37. PROTOCOL_INVALID after start leaves authorization consumed
  it('37. Provider returning PROTOCOL_INVALID leaves authorization consumed', async () => {
    const mock = setupResource('res-37', 'prov-37', {
      customExecutionResult: { status: 'FAILED', error: 'PROTOCOL_INVALID: missing coder.v1' },
    });

    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-37'],
      allowManualBridge: false,
    });

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    const result = await dispatcher.dispatch(auth.id);
    expect(result.status).toBe('FAILED');

    const savedAuth = repo.getExecutionAuthorization(auth.id);
    expect(savedAuth!.status).toBe('DISPATCHED');
  });

  // 38. Timeout after start leaves authorization consumed
  it('38. Provider timeout leaves authorization consumed', async () => {
    const mock = setupResource('res-38', 'prov-38', {
      customExecutionResult: { status: 'FAILED', error: 'Process timed out after 30000ms' },
    });

    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-38'],
      allowManualBridge: false,
    });

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    const result = await dispatcher.dispatch(auth.id);
    expect(result.status).toBe('FAILED');

    const savedAuth = repo.getExecutionAuthorization(auth.id);
    expect(savedAuth!.status).toBe('DISPATCHED');
  });

  // 39. Cancellation after start leaves authorization consumed
  it('39. Cancellation leaves authorization consumed', async () => {
    const mock = setupResource('res-39', 'prov-39', {
      customExecutionResult: { status: 'CANCELLED', error: 'Execution was cancelled.' },
    });

    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-39'],
      allowManualBridge: false,
    });

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    const result = await dispatcher.dispatch(auth.id);
    expect(result.status).toBe('CANCELLED');

    const savedAuth = repo.getExecutionAuthorization(auth.id);
    expect(savedAuth!.status).toBe('DISPATCHED');
  });

  // 40. No automatic routing/failover occurs after dispatch
  it('40. No second provider executes after dispatch failure (strict zero post-dispatch failover)', async () => {
    const failingMock = setupResource('res-primary-40', 'prov-p40', {
      customExecutionResult: { status: 'FAILED', error: 'Crash' },
    });
    const backupMock = setupResource('res-backup-40', 'prov-b40');

    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-primary-40', 'res-backup-40'],
      allowManualBridge: false,
    });

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    const result = await dispatcher.dispatch(auth.id);
    expect(result.status).toBe('FAILED');
    expect(failingMock.executionCount).toBe(1);
    expect(backupMock.executionCount).toBe(0); // Zero failover
  });

  // 41. Manual Bridge valid authorization returns AWAITING_OWNER
  it('41. Manual Bridge authorization dispatch returns AWAITING_OWNER', async () => {
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
      id: 'res-manual-41',
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
      candidateResourceIds: ['res-manual-41'],
      allowManualBridge: true,
    });

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    const result = await dispatcher.dispatch(auth.id);
    expect(result.status).toBe('AWAITING_OWNER');
  });

  // 42. Manual Bridge authorization cannot be replayed
  it('42. Manual Bridge authorization cannot be replayed after dispatch', async () => {
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
      id: 'res-manual-42',
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
      candidateResourceIds: ['res-manual-42'],
      allowManualBridge: true,
    });

    const auth = authService.createAuthorization({
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

  // 43. Authorization survives restart
  it('43. Authorization record survives database reconnection / app restart', async () => {
    const dbFile = path.join(tmpDir, 'restart_test.db');
    const diskDb = new Database(dbFile);
    MigrationRunner.run(diskDb);
    const diskRepo = new Repository(diskDb);
    const diskEvents = new EventService(diskRepo);
    const diskAuthService = new ExecutionAuthorizationService(diskRepo, diskEvents);
    const diskRouter = new ProviderRoutingService(diskRepo, registry, diskEvents);

    diskRepo.createProject({
      id: 'PROJ-DISK',
      name: 'Disk Project',
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
      id: 'TSK-DISK-001',
      project_id: 'PROJ-DISK',
      milestone_id: null,
      title: 'Disk Task',
      description: null,
      state: 'APPROVED',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'LOW',
      assigned_agent_id: null,
      revision_count: 1,
      max_revisions: 5,
      base_sha: '1111111111111111111111111111111111111111',
      current_sha: '1111111111111111111111111111111111111111',
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    setupResource('res-disk', 'prov-disk');
    diskRepo.createProvider({
      id: 'prov-disk',
      name: 'Disk Provider',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: new Date().toISOString(),
    });
    diskRepo.createProviderResource({
      id: 'res-disk',
      provider_id: 'prov-disk',
      model_name: 'Disk Model',
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
      projectId: 'PROJ-DISK',
      taskId: 'TSK-DISK-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-disk'],
      allowManualBridge: false,
    });

    const auth = diskAuthService.createAuthorization({
      projectId: 'PROJ-DISK',
      taskId: 'TSK-DISK-001',
      routingDecisionId: decision.decisionId,
    });

    diskDb.close();

    // Reopen DB instance simulating process restart
    const reopenedDb = new Database(dbFile);
    const reopenedRepo = new Repository(reopenedDb);
    const loadedAuth = reopenedRepo.getExecutionAuthorization(auth.id);

    expect(loadedAuth).not.toBeNull();
    expect(loadedAuth!.id).toBe(auth.id);
    expect(loadedAuth!.status).toBe('AUTHORIZED');
    expect(loadedAuth!.task_id).toBe('TSK-DISK-001');

    reopenedDb.close();
  });

  // 44. Consumed authorization remains consumed after restart
  it('44. Consumed authorization remains DISPATCHED after restart and cannot be reused', async () => {
    const dbFile = path.join(tmpDir, 'restart_consumed_test.db');
    const diskDb = new Database(dbFile);
    MigrationRunner.run(diskDb);
    const diskRepo = new Repository(diskDb);
    const diskEvents = new EventService(diskRepo);
    const diskAuthService = new ExecutionAuthorizationService(diskRepo, diskEvents);
    const diskRouter = new ProviderRoutingService(diskRepo, registry, diskEvents);
    const diskDispatcher = new ProviderDispatchService(registry, diskRepo, diskEvents);

    diskRepo.createProject({
      id: 'PROJ-DISK-44',
      name: 'Disk Project',
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
      id: 'TSK-DISK-44',
      project_id: 'PROJ-DISK-44',
      milestone_id: null,
      title: 'Disk Task',
      description: null,
      state: 'APPROVED',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'LOW',
      assigned_agent_id: null,
      revision_count: 1,
      max_revisions: 5,
      base_sha: '2222222222222222222222222222222222222222',
      current_sha: '2222222222222222222222222222222222222222',
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    setupResource('res-disk-44', 'prov-disk-44');
    diskRepo.createProvider({
      id: 'prov-disk-44',
      name: 'Disk Provider',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: new Date().toISOString(),
    });
    diskRepo.createProviderResource({
      id: 'res-disk-44',
      provider_id: 'prov-disk-44',
      model_name: 'Disk Model',
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
      projectId: 'PROJ-DISK-44',
      taskId: 'TSK-DISK-44',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-disk-44'],
      allowManualBridge: false,
    });

    const auth = diskAuthService.createAuthorization({
      projectId: 'PROJ-DISK-44',
      taskId: 'TSK-DISK-44',
      routingDecisionId: decision.decisionId,
    });

    await diskDispatcher.dispatch(auth.id);
    diskDb.close();

    // Reopen DB
    const reopenedDb = new Database(dbFile);
    const reopenedRepo = new Repository(reopenedDb);
    const reopenedDispatcher = new ProviderDispatchService(registry, reopenedRepo);

    const replayResult = await reopenedDispatcher.dispatch(auth.id);
    expect(replayResult.status).toBe('FAILED');
    expect(replayResult.error).toContain('EXECUTION_AUTHORIZATION_ALREADY_DISPATCHED');

    reopenedDb.close();
  });

  // 45. Creation event persists
  it('45. Creation audit event EXECUTION_AUTHORIZATION_CREATED is persisted to SQLite', async () => {
    setupResource('res-45', 'prov-45');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-45'],
      allowManualBridge: false,
    });

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    const events = repo.getEvents('PROJ-AUTH');
    const createEvent = events.find((e) => e.type === 'EXECUTION_AUTHORIZATION_CREATED');
    expect(createEvent).toBeDefined();
    const payload = createEvent!.structured_payload as Record<string, unknown>;
    expect(payload.authorizationId).toBe(auth.id);
    expect(payload.instructionPayloadHash).toBe(auth.instruction_payload_hash);
  });

  // 46. Dispatch event persists
  it('46. Dispatch audit event EXECUTION_AUTHORIZATION_DISPATCHED is persisted to SQLite', async () => {
    setupResource('res-46', 'prov-46');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-46'],
      allowManualBridge: false,
    });

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    await dispatcher.dispatch(auth.id);

    const events = repo.getEvents('PROJ-AUTH');
    const dispatchEvent = events.find((e) => e.type === 'EXECUTION_AUTHORIZATION_DISPATCHED');
    expect(dispatchEvent).toBeDefined();
    const payload = dispatchEvent!.structured_payload as Record<string, unknown>;
    expect(payload.authorizationId).toBe(auth.id);
    expect(payload.status).toBe('DISPATCHED');
  });

  // 47. Rejection event persists where appropriate
  it('47. Rejection audit event EXECUTION_AUTHORIZATION_REJECTED is persisted when authorization is rejected', async () => {
    setupResource('res-47', 'prov-47');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-47'],
      allowManualBridge: false,
    });

    // Mutate task to unapproved state
    db.prepare('UPDATE tasks SET state = ? WHERE id = ?').run('PAUSED', 'TSK-AUTH-001');

    expect(() =>
      authService.createAuthorization({
        projectId: 'PROJ-AUTH',
        taskId: 'TSK-AUTH-001',
        routingDecisionId: decision.decisionId,
      })
    ).toThrow();

    const events = repo.getEvents('PROJ-AUTH');
    const rejectEvent = events.find((e) => e.type === 'EXECUTION_AUTHORIZATION_REJECTED');
    expect(rejectEvent).toBeDefined();
  });

  // 48. Event payload contains hashes but no secrets
  it('48. Audit events contain payload hashes but zero secrets or raw credentials', async () => {
    setupResource('res-48', 'prov-48');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-48'],
      allowManualBridge: false,
    });

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
      instructions: ['Instructions with sensitive context'],
    });

    const events = repo.getEvents('PROJ-AUTH');
    const eventJson = JSON.stringify(events);
    expect(eventJson).toContain(auth.instruction_payload_hash);
    expect(eventJson).not.toContain('Instructions with sensitive context');
  });

  // 49. Task state is not falsely marked DONE by authorization/dispatch
  it('49. Task state remains unaltered by authorization creation and dispatch', async () => {
    setupResource('res-49', 'prov-49');
    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-49'],
      allowManualBridge: false,
    });

    const auth = authService.createAuthorization({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      routingDecisionId: decision.decisionId,
    });

    await dispatcher.dispatch(auth.id);

    const currentTask = repo.getTask('TSK-AUTH-001');
    expect(currentTask!.state).toBe('APPROVED'); // State not mutated
  });

  // 50. Codex PR #5 contract remains unchanged
  it('50. Codex CLI contract remains OFFLINE with empty capabilities and fails closed', async () => {
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

  // 51. PR #6 routing semantics remain unchanged
  it('51. PR #6 routing semantics (AVAILABLE > LOW_QUOTA, explicit candidate order) remain intact', async () => {
    const mockA = setupResource('res-51-a', 'prov-51-a', { health: 'LOW_QUOTA' });
    const mockB = setupResource('res-51-b', 'prov-51-b', { health: 'AVAILABLE' });

    const decision = await router.route({
      projectId: 'PROJ-AUTH',
      taskId: 'TSK-AUTH-001',
      requiredCapabilities: ['CODING'],
      candidateResourceIds: ['res-51-a', 'res-51-b'],
      allowManualBridge: false,
    });

    // Tier 1 AVAILABLE takes priority over Tier 2 LOW_QUOTA
    expect(decision.outcome).toBe('SELECTED');
    expect(decision.selectedResourceId).toBe('res-51-b');
  });
});
