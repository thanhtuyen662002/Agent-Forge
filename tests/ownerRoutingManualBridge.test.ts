import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { EventService } from '../src/core/services/EventService';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import { ProjectService } from '../src/core/services/ProjectService';
import { TaskService } from '../src/core/services/TaskService';
import { VerificationService } from '../src/core/services/VerificationService';
import { EmergencyStopService } from '../src/core/services/EmergencyStopService';
import { ProviderRegistry } from '../src/core/adapters/ProviderRegistry';
import { ManualBridgeAdapter } from '../src/core/adapters/ManualBridgeAdapter';
import { CodexCliAdapter } from '../src/core/adapters/CodexCliAdapter';
import {
  ProviderAdapter,
  AgentExecutionRequest,
  AgentExecutionResult,
  QuotaSnapshotInfo,
} from '../src/core/adapters/ProviderAdapter';
import { ProviderHealthStatus, Capability, ProviderAdapterType } from '../src/core/types/domain';
import { ProviderRoutingService } from '../src/core/services/ProviderRoutingService';
import { ExecutionAuthorizationService } from '../src/core/services/ExecutionAuthorizationService';
import { ProviderDispatchService } from '../src/core/services/ProviderDispatchService';
import { PackageGenerator } from '../src/core/protocol/packageGenerator';
import { ProtocolParser } from '../src/core/protocol/parser';
import {
  RouteTaskIpcSchema,
  AuthorizeRoutedTaskIpcSchema,
  DispatchAuthorizationIpcSchema,
  GetOwnerHandoffSnapshotIpcSchema,
} from '../src/core/types/ipc';

class MockAutomatedAdapter implements ProviderAdapter {
  public readonly id = 'prov-test-automated';
  public readonly name = 'Automated Test Adapter';
  public readonly adapterType: ProviderAdapterType = 'LOCAL_CLI';
  public executions: AgentExecutionRequest[] = [];

  public async getCapabilities(): Promise<Capability[]> {
    return ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION'];
  }

  public async getHealth(): Promise<ProviderHealthStatus> {
    return 'AVAILABLE';
  }

  public async getQuota(): Promise<QuotaSnapshotInfo> {
    return {
      remaining: 50,
      total: 100,
      unit: 'REQUESTS',
      source: 'MEASURED',
      confidence: 1.0,
      resetAt: null,
    };
  }

  public async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    this.executions.push(request);
    return {
      executionId: crypto.randomUUID(),
      status: 'COMPLETED',
      outputProtocol: 'Automated test execution completed.',
    };
  }

  public async cancel(_executionId: string): Promise<void> {}
}

describe('Owner Routing & Manual Bridge Handoff Loop (PR #8)', () => {
  let tempDir: string;
  let dbDir: string;
  let artifactsDir: string;
  let gitRepoDir: string;
  let db: Database.Database;
  let repo: Repository;
  let eventService: EventService;
  let artifactStore: ArtifactStore;
  let projectService: ProjectService;
  let verificationService: VerificationService;
  let taskService: TaskService;
  let emergencyStopService: EmergencyStopService;
  let providerRegistry: ProviderRegistry;
  let routingService: ProviderRoutingService;
  let authorizationService: ExecutionAuthorizationService;
  let dispatchService: ProviderDispatchService;

  let testProjectId: string;
  let testTaskId: string;
  let initialGitSha: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-pr8-test-'));
    dbDir = path.join(tempDir, 'db');
    artifactsDir = path.join(tempDir, 'artifacts');
    gitRepoDir = path.join(tempDir, 'repo');

    fs.mkdirSync(dbDir, { recursive: true });
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.mkdirSync(gitRepoDir, { recursive: true });

    // Initialize real git repo for GitService tests
    execSync('git init', { cwd: gitRepoDir });
    execSync('git config user.email "test@test.com"', { cwd: gitRepoDir });
    execSync('git config user.name "Tester"', { cwd: gitRepoDir });
    fs.writeFileSync(path.join(gitRepoDir, 'README.md'), '# Initial README\n');
    execSync('git add README.md && git commit -m "initial commit"', { cwd: gitRepoDir });
    initialGitSha = execSync('git rev-parse HEAD', { cwd: gitRepoDir }).toString().trim();

    db = new Database(path.join(dbDir, 'test.db'));
    MigrationRunner.run(db);

    repo = new Repository(db);
    eventService = new EventService(repo);
    artifactStore = new ArtifactStore(artifactsDir);
    projectService = new ProjectService(repo, eventService);
    verificationService = new VerificationService(repo, artifactStore);
    taskService = new TaskService(repo, eventService, verificationService, artifactStore);
    emergencyStopService = new EmergencyStopService(repo, eventService);

    providerRegistry = new ProviderRegistry();
    providerRegistry.register(new ManualBridgeAdapter());
    providerRegistry.register(new CodexCliAdapter({ repo, artifactStore }));

    routingService = new ProviderRoutingService(repo, providerRegistry, eventService);
    authorizationService = new ExecutionAuthorizationService(repo, eventService);
    dispatchService = new ProviderDispatchService(providerRegistry, repo, eventService);

    // Seed test project & provider resources
    const proj = projectService.createProject('PR8 Test Project', 'Testing owner routing loop', gitRepoDir, 'main');
    testProjectId = proj.id;

    // Seed Manual Bridge provider & resources
    repo.createProvider({
      id: 'prov-manual-bridge',
      name: 'Owner Manual Bridge',
      adapter_type: 'MANUAL_BRIDGE',
      enabled: true,
      created_at: new Date().toISOString(),
    });

    repo.createProviderResource({
      id: 'res-gemini-coder',
      provider_id: 'prov-manual-bridge',
      model_name: 'Gemini Coder',
      health_status: 'UNKNOWN',
      capabilities: ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 0.0,
      last_health_check: null,
    });

    repo.createProviderResource({
      id: 'res-codex-cli',
      provider_id: 'prov-manual-bridge',
      model_name: 'Codex CLI Disabled',
      health_status: 'UNHEALTHY',
      capabilities: ['CODING'],
      enabled: false,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 0.0,
      last_health_check: null,
    });

    // Create a task
    const t = taskService.createTask({
      projectId: testProjectId,
      title: 'PR8 Owner Routing Task',
      description: 'Implement secure manual relay workflow',
      priority: 'HIGH',
      risk: 'MEDIUM',
      acceptanceCriteria: ['Must route deterministically', 'Must authorize strictly from Manager ledger'],
      constraints: ['No browser automation'],
    });
    testTaskId = t.id;
  });

  afterEach(() => {
    try {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Clean teardown
    }
  });

  // =========================================================================
  // 1. IPC Schema Strictness & Validation Gates
  // =========================================================================
  describe('IPC Schema Strictness & Validation Gates', () => {
    it('validates project and task identifiers in route request', () => {
      expect(RouteTaskIpcSchema.safeParse({}).success).toBe(false);
      expect(RouteTaskIpcSchema.safeParse({ projectId: '', taskId: 'T-1', candidateResourceIds: ['res-1'] }).success).toBe(false);
      expect(RouteTaskIpcSchema.safeParse({ projectId: 'P-1', taskId: '', candidateResourceIds: ['res-1'] }).success).toBe(false);
      expect(RouteTaskIpcSchema.safeParse({ projectId: 'P-1', taskId: 'T-1', candidateResourceIds: [] }).success).toBe(false);
      expect(
        RouteTaskIpcSchema.safeParse({
          projectId: 'P-1',
          taskId: 'T-1',
          candidateResourceIds: ['res-1'],
          allowManualBridge: true,
        }).success
      ).toBe(true);
    });

    it('rejects candidate resource IDs with empty strings', () => {
      const res = RouteTaskIpcSchema.safeParse({
        projectId: 'P-1',
        taskId: 'T-1',
        candidateResourceIds: [''],
      });
      expect(res.success).toBe(false);
    });

    it('rejects execution instructions in route request (strict IPC schema)', () => {
      const res = RouteTaskIpcSchema.safeParse({
        projectId: 'P-1',
        taskId: 'T-1',
        candidateResourceIds: ['res-1'],
        instructions: ['renderer instructions override'], // FORBIDDEN
      });
      expect(res.success).toBe(false);
    });

    it('rejects prompt or execution overrides in authorization request (strict IPC schema)', () => {
      const res = AuthorizeRoutedTaskIpcSchema.safeParse({
        projectId: 'P-1',
        taskId: 'T-1',
        routingDecisionId: 'DEC-1',
        instructions: ['renderer instructions override'], // FORBIDDEN
        prompt: 'renderer prompt override', // FORBIDDEN
        selectedProvider: 'prov-evil', // FORBIDDEN
      });
      expect(res.success).toBe(false);
    });

    it('accepts authorizationId ONLY in dispatch IPC request (strict schema)', () => {
      expect(DispatchAuthorizationIpcSchema.safeParse({}).success).toBe(false);
      expect(DispatchAuthorizationIpcSchema.safeParse({ authorizationId: '' }).success).toBe(false);
      expect(DispatchAuthorizationIpcSchema.safeParse({ authorizationId: 'auth-123' }).success).toBe(true);

      // Rejects extra parameters such as instructions or provider
      const withExtra = DispatchAuthorizationIpcSchema.safeParse({
        authorizationId: 'auth-123',
        instructions: ['bad'],
        provider: 'prov-evil',
      });
      expect(withExtra.success).toBe(false);
    });

    it('validates handoff snapshot IPC schema', () => {
      expect(GetOwnerHandoffSnapshotIpcSchema.safeParse({}).success).toBe(false);
      expect(GetOwnerHandoffSnapshotIpcSchema.safeParse({ taskId: '' }).success).toBe(false);
      expect(GetOwnerHandoffSnapshotIpcSchema.safeParse({ taskId: 'T-1' }).success).toBe(true);
    });
  });

  // =========================================================================
  // 2. Candidate Order & Provider Routing
  // =========================================================================
  describe('Candidate Order & Provider Routing', () => {
    it('preserves explicit candidate order when passed to ProviderRoutingService', async () => {
      const res1 = 'res-codex-cli';
      const res2 = 'res-gemini-coder';

      const decision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: [res1, res2],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      expect(decision.candidateEvaluations.length).toBe(2);
      expect(decision.candidateEvaluations[0].resourceId).toBe(res1);
      expect(decision.candidateEvaluations[1].resourceId).toBe(res2);
    });

    it('excludes ManualBridge when allowManualBridge is false', async () => {
      const decision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: false, // Disallowed
        requiredCapabilities: ['CODING'],
      });

      expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
      expect(decision.selectedResourceId).toBeNull();
    });

    it('selects ManualBridge when allowManualBridge is true and resource is eligible', async () => {
      const decision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      expect(decision.outcome).toBe('MANUAL_HANDOFF_REQUIRED');
      expect(decision.selectedResourceId).toBe('res-gemini-coder');
      expect(decision.selectedProviderId).toBe('prov-manual-bridge');
    });

    it('evaluates disabled resources as ineligible', async () => {
      const decision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-codex-cli'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
      expect(decision.candidateEvaluations[0].eligibility).toBe('INELIGIBLE');
      expect(decision.candidateEvaluations[0].rejectionReasons.length).toBeGreaterThan(0);
    });

    it('routes to automated provider when an eligible automated provider is registered', async () => {
      const mockAuto = new MockAutomatedAdapter();
      providerRegistry.register(mockAuto);

      repo.createProvider({
        id: mockAuto.id,
        name: 'Automated Test CLI',
        adapter_type: 'LOCAL_CLI',
        enabled: true,
        created_at: new Date().toISOString(),
      });

      repo.createProviderResource({
        id: 'res-auto-test',
        provider_id: mockAuto.id,
        model_name: 'Automated Model',
        health_status: 'AVAILABLE',
        capabilities: ['CODING'],
        enabled: true,
        total_quota: 100,
        remaining_quota: 50,
        quota_unit: 'REQUESTS',
        quota_reset_at: null,
        quota_source: 'MEASURED',
        quota_confidence: 1.0,
        last_health_check: null,
      });

      const decision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-auto-test', 'res-gemini-coder'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      expect(decision.outcome).toBe('SELECTED');
      expect(decision.selectedResourceId).toBe('res-auto-test');
      expect(decision.selectedProviderId).toBe(mockAuto.id);
    });
  });

  // =========================================================================
  // 3. Durable Execution Authorization & Dispatch Boundary
  // =========================================================================
  describe('Durable Execution Authorization & Dispatch Boundary', () => {
    it('creates execution authorization bound to applied manager authority and real git HEAD', async () => {
      // Apply Manager EXECUTE decision (transitions task from PLANNED to CODING)
      const managerMsg = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-001',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'EXECUTE',
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        instructions: ['Implement secure token validation'],
        priority: 'HIGH',
        risk: 'MEDIUM',
        acceptance_criteria: ['All tests pass'],
      };
      const applyRes = await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));
      expect(applyRes.success).toBe(true);

      const taskInCoding = repo.getTask(testTaskId)!;
      expect(taskInCoding.state).toBe('CODING');

      // Route
      const routingDecision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });
      expect(routingDecision.outcome).toBe('MANUAL_HANDOFF_REQUIRED');

      // Authorize
      const auth = await authorizationService.createAuthorization({
        projectId: testProjectId,
        taskId: testTaskId,
        routingDecisionId: routingDecision.decisionId,
        contextFiles: [],
      });

      expect(auth.status).toBe('AUTHORIZED');
      expect(auth.manager_message_id).toBeDefined();
      expect(auth.selected_resource_id).toBe('res-gemini-coder');
      expect(auth.instruction_payload_hash).toBeDefined();
      expect(auth.context_manifest_hash).toBeDefined();
      expect(auth.repository_head_sha).toBe(initialGitSha);

      // Dispatch via authorizationId ONLY
      const result = await dispatchService.dispatch(auth.id);
      expect(result.status).toBe('AWAITING_OWNER');

      // Re-query auth from SQLite to verify atomic CAS claim
      const updatedAuth = repo.getExecutionAuthorization(auth.id);
      expect(updatedAuth?.status).toBe('DISPATCHED');
      expect(updatedAuth?.dispatched_at).toBeDefined();

      // Replay must fail closed with zero provider executions
      const replayResult = await dispatchService.dispatch(auth.id);
      expect(replayResult.status).toBe('FAILED');
      expect(replayResult.error).toContain('EXECUTION_AUTHORIZATION_ALREADY_DISPATCHED');
    });

    it('rejects fake or unpersisted routingDecisionId during authorization', async () => {
      const managerMsg = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-002',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'EXECUTE',
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        instructions: ['Valid instructions'],
        priority: 'HIGH',
        risk: 'MEDIUM',
        acceptance_criteria: ['Criteria'],
      };
      await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));

      await expect(
        authorizationService.createAuthorization({
          projectId: testProjectId,
          taskId: testTaskId,
          routingDecisionId: 'fake-decision-id-not-in-db',
          contextFiles: [],
        })
      ).rejects.toThrow('Routing decision "fake-decision-id-not-in-db" not found in database');
    });

    it('rejects authorization when Manager decision has not been applied to task', async () => {
      // Route without applied manager decision
      const routingDecision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      await expect(
        authorizationService.createAuthorization({
          projectId: testProjectId,
          taskId: testTaskId,
          routingDecisionId: routingDecision.decisionId,
          contextFiles: [],
        })
      ).rejects.toThrow('EXECUTION_AUTHORIZATION_FAILED');
    });
  });

  // =========================================================================
  // 4. WorkOrder Generation & Owner Clipboard Safety
  // =========================================================================
  describe('WorkOrder Generation & Owner Clipboard Safety', () => {
    it('generates authoritative WorkOrder markdown matching durable task spec', async () => {
      const project = repo.getProject(testProjectId)!;
      const task = repo.getTask(testTaskId)!;

      const workOrder = PackageGenerator.generateWorkOrder(project, task);
      expect(workOrder).toContain('WORK ORDER');
      expect(workOrder).toContain(task.title);
      expect(workOrder).toContain('Must route deterministically');
      expect(workOrder).toContain('No browser automation');
    });

    it('does not allow editing the authoritative execution payload in-place', async () => {
      const project = repo.getProject(testProjectId)!;
      const task = repo.getTask(testTaskId)!;

      const workOrder = PackageGenerator.generateWorkOrder(project, task);
      expect(task.title).toBe('PR8 Owner Routing Task');
      expect(workOrder).toContain('PR8 Owner Routing Task');
    });
  });

  // =========================================================================
  // 5. Coder Report Application & Validation Gates
  // =========================================================================
  describe('Coder Report Application & Validation Gates', () => {
    it('rejects malformed coder report without advancing task state', async () => {
      const invalidCoderInput = JSON.stringify({
        protocol: 'coder.v1',
        task_id: testTaskId,
        status: 'INVALID_STATUS', // Bad status enum
      });

      const parseRes = ProtocolParser.parse(invalidCoderInput);
      expect(parseRes.success).toBe(false);

      const taskBefore = repo.getTask(testTaskId);
      expect(taskBefore?.state).toBe('PLANNED');
    });

    it('processes valid coder report and enters validation flow', async () => {
      // Apply Manager EXECUTE decision to transition task to CODING
      const managerMsg = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-CODING-001',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'EXECUTE',
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        instructions: ['Implement secure token validation'],
        priority: 'HIGH',
        risk: 'MEDIUM',
        acceptance_criteria: ['All tests pass'],
      };
      await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));

      const validCoderInput = JSON.stringify({
        protocol: 'coder.v1',
        message_id: 'MSG-CODER-001',
        project_id: testProjectId,
        task_id: testTaskId,
        status: 'COMPLETED',
        files_claimed_changed: ['src/core/router.ts'],
        tests_claimed: ['tests/router.test.ts'],
        blockers: [],
      });

      const parseRes = ProtocolParser.parse(validCoderInput);
      expect(parseRes.success).toBe(true);
      expect(parseRes.data?.type).toBe('coder.v1');

      const applyRes = taskService.applyCoderReport(parseRes.data!.data as any, validCoderInput);
      expect(applyRes.success).toBe(true);

      const taskAfter = repo.getTask(testTaskId);
      expect(taskAfter?.state).toBe('VALIDATING');
    });
  });

  // =========================================================================
  // 6. Security Invariants & Provider Safety
  // =========================================================================
  describe('Security Invariants & Provider Safety', () => {
    it('maintains Codex contract: OFFLINE, capabilities empty, FAIL_CLOSED_NO_SPAWN', async () => {
      const codex = new CodexCliAdapter({ repo, artifactStore });
      expect(codex.id).toBe('prov-codex-cli');
      expect(codex.adapterType).toBe('LOCAL_CLI');

      const health = await codex.getHealth();
      expect(health).toBe('OFFLINE');

      const quota = await codex.getQuota();
      expect(quota.source).toBe('UNKNOWN');
      expect(quota.confidence).toBe(0.0);

      const execRes = await codex.execute({
        taskId: testTaskId,
        projectId: testProjectId,
        instructions: ['test'],
        contextFiles: [],
      });
      expect(execRes.status).toBe('FAILED');
      expect(execRes.error).toContain('CODEX_CLI_UNAVAILABLE');
    });

    it('maintains Manual Bridge contract: AWAITING_OWNER', async () => {
      const bridge = new ManualBridgeAdapter();
      expect(bridge.id).toBe('prov-manual-bridge');
      expect(bridge.adapterType).toBe('MANUAL_BRIDGE');

      const execRes = await bridge.execute({
        taskId: testTaskId,
        projectId: testProjectId,
        instructions: ['manual work'],
        contextFiles: [],
      });
      expect(execRes.status).toBe('AWAITING_OWNER');
    });

    it('maintains Emergency Stop functionality', async () => {
      // Transition project to RUNNING so emergency stop can pause it
      repo.updateProjectStatus(testProjectId, 'RUNNING');

      const stopRes = emergencyStopService.triggerEmergencyStop('Owner triggered stop in test');
      expect(stopRes.timestamp).toBeDefined();
      expect(stopRes.projectsPaused).toContain(testProjectId);

      const projAfter = repo.getProject(testProjectId);
      expect(projAfter?.status).toBe('PAUSED');

      const resumeRes = emergencyStopService.resumeProject(testProjectId);
      expect(resumeRes).toBe(true);

      const projResumed = repo.getProject(testProjectId);
      expect(projResumed?.status).toBe('RUNNING');
    });
  });
});
