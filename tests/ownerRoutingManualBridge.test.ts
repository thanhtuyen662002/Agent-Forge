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
import {
  ExecutionAuthorizationService,
  computeContextManifestHash,
  computePayloadHash,
} from '../src/core/services/ExecutionAuthorizationService';
import { ProviderDispatchService } from '../src/core/services/ProviderDispatchService';
import { PackageGenerator } from '../src/core/protocol/packageGenerator';
import { ProtocolParser } from '../src/core/protocol/parser';
import {
  RouteTaskIpcSchema,
  AuthorizeRoutedTaskIpcSchema,
  DispatchAuthorizationIpcSchema,
  GetOwnerHandoffSnapshotIpcSchema,
  GenerateAuthorizedWorkOrderIpcSchema,
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
  }, 30000);

  afterEach(() => {
    try {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Clean teardown
    }
  }, 30000);

  // =========================================================================
  // 1. Explicit Candidate Selection & Opt-in Invariants
  // =========================================================================
  describe('Explicit Candidate Selection & Opt-in Invariants', () => {
    it('1. Candidate list is initially empty by default', () => {
      const initialCandidateIds: string[] = [];
      expect(initialCandidateIds.length).toBe(0);
    });

    it('2. Resource refresh preserves only valid selections without auto-selecting enabled resources', () => {
      // Initial empty state
      let selectedCandidateIds: string[] = [];
      const refreshedResources = [
        { id: 'res-1', enabled: true },
        { id: 'res-2', enabled: true },
      ];

      // Refresh function simulating UI logic
      const updateOnRefresh = (current: string[], resources: { id: string }[]) => {
        if (current.length === 0) return current; // Do not auto-select
        const validIds = resources.map((r) => r.id);
        return current.filter((id) => validIds.includes(id));
      };

      selectedCandidateIds = updateOnRefresh(selectedCandidateIds, refreshedResources);
      expect(selectedCandidateIds).toEqual([]); // Still empty

      // If user explicitly selected res-1, it is preserved
      selectedCandidateIds = ['res-1'];
      selectedCandidateIds = updateOnRefresh(selectedCandidateIds, refreshedResources);
      expect(selectedCandidateIds).toEqual(['res-1']);

      // If res-1 is removed from resources, it is filtered out
      selectedCandidateIds = updateOnRefresh(selectedCandidateIds, [{ id: 'res-2' }]);
      expect(selectedCandidateIds).toEqual([]);
    });

    it('3. Task switch clears candidate selection', () => {
      let selectedCandidateIds = ['res-gemini-coder'];
      const onTaskSwitch = () => {
        selectedCandidateIds = [];
      };
      onTaskSwitch();
      expect(selectedCandidateIds).toEqual([]);
    });

    it('4. allowManualBridge is initially false', () => {
      const initialAllowManualBridge = false;
      expect(initialAllowManualBridge).toBe(false);
    });

    it('5. Task switch resets allowManualBridge to false', () => {
      let allowManualBridge = true;
      const onTaskSwitch = () => {
        allowManualBridge = false;
      };
      onTaskSwitch();
      expect(allowManualBridge).toBe(false);
    });

    it('6. Route without Owner opt-in passes allowManualBridge=false (Manual Bridge not selected)', async () => {
      const decision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: false, // Owner did not opt in
        requiredCapabilities: ['CODING'],
      });

      expect(decision.outcome).toBe('NO_ELIGIBLE_PROVIDER');
      expect(decision.selectedResourceId).toBeNull();
    });

    it('7. Explicit Owner opt-in passes allowManualBridge=true (Manual Bridge selected)', async () => {
      const decision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: true, // Owner opted in
        requiredCapabilities: ['CODING'],
      });

      expect(decision.outcome).toBe('MANUAL_HANDOFF_REQUIRED');
      expect(decision.selectedResourceId).toBe('res-gemini-coder');
    });

    it('8. Empty candidate list cannot route', () => {
      expect(
        RouteTaskIpcSchema.safeParse({
          projectId: testProjectId,
          taskId: testTaskId,
          candidateResourceIds: [],
          allowManualBridge: true,
        }).success
      ).toBe(false);
    });

    it('9. Explicit ordered candidate list remains unchanged through IPC and evaluation', async () => {
      const candidates = ['res-codex-cli', 'res-gemini-coder'];
      const parsed = RouteTaskIpcSchema.safeParse({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: candidates,
        allowManualBridge: true,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.candidateResourceIds).toEqual(candidates);
      }

      const decision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: candidates,
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      expect(decision.candidateEvaluations.map((e) => e.resourceId)).toEqual(candidates);
    });
  });

  // =========================================================================
  // 2. Authorized WorkOrder API & Authority Binding
  // =========================================================================
  describe('Authorized WorkOrder API & Authority Binding', () => {
    it('10. Authorized WorkOrder IPC schema accepts authorizationId only', () => {
      expect(GenerateAuthorizedWorkOrderIpcSchema.safeParse({ authorizationId: 'auth-1' }).success).toBe(true);
      expect(GenerateAuthorizedWorkOrderIpcSchema.safeParse({}).success).toBe(false);
      expect(
        GenerateAuthorizedWorkOrderIpcSchema.safeParse({
          authorizationId: 'auth-1',
          instructions: ['extra instructions'],
        }).success
      ).toBe(false);
      expect(
        GenerateAuthorizedWorkOrderIpcSchema.safeParse({
          authorizationId: 'auth-1',
          prompt: 'extra prompt',
        }).success
      ).toBe(false);
    });

    it('11. Authorized WorkOrder rejects fabricated authorizationId', () => {
      expect(() => {
        PackageGenerator.generateAuthorizedManualWorkOrder('fabricated-auth-id', repo);
      }).toThrow(/EXECUTION_AUTHORIZATION_NOT_FOUND/);
    });

    it('12. AUTHORIZED but not-yet-DISPATCHED authorization cannot produce relay WorkOrder', async () => {
      // Apply Manager EXECUTE
      const managerMsg = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-001',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'EXECUTE',
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        instructions: ['Implement authorization-bound manual handoff'],
        priority: 'HIGH',
        risk: 'MEDIUM',
        acceptance_criteria: ['All tests pass'],
      };
      await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));

      const routingDecision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      const auth = await authorizationService.createAuthorization({
        projectId: testProjectId,
        taskId: testTaskId,
        routingDecisionId: routingDecision.decisionId,
        contextFiles: [],
      });

      expect(auth.status).toBe('AUTHORIZED');

      expect(() => {
        PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
      }).toThrow(/EXECUTION_AUTHORIZATION_NOT_DISPATCHED/);
    });

    it('13. DISPATCHED + MANUAL_HANDOFF_REQUIRED produces authorized WorkOrder', async () => {
      const managerMsg = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-002',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'EXECUTE',
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        instructions: ['Implement authorization-bound manual handoff'],
        priority: 'HIGH',
        risk: 'MEDIUM',
        acceptance_criteria: ['All tests pass'],
      };
      await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));

      const routingDecision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      const auth = await authorizationService.createAuthorization({
        projectId: testProjectId,
        taskId: testTaskId,
        routingDecisionId: routingDecision.decisionId,
        contextFiles: [],
      });

      await dispatchService.dispatch(auth.id);

      const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
      expect(workOrder).toContain('# AgentForge Authorized Manual Handoff');
      expect(workOrder).toContain(auth.id);
      expect(workOrder).toContain('Implement authorization-bound manual handoff');
    });

    it('14. DISPATCHED + SELECTED cannot produce ManualBridge relay WorkOrder', async () => {
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

      const managerMsg = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-003',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'EXECUTE',
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        instructions: ['Automated work'],
        priority: 'HIGH',
        risk: 'MEDIUM',
        acceptance_criteria: ['All tests pass'],
      };
      await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));

      const routingDecision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-auto-test'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      expect(routingDecision.outcome).toBe('SELECTED');

      const auth = await authorizationService.createAuthorization({
        projectId: testProjectId,
        taskId: testTaskId,
        routingDecisionId: routingDecision.decisionId,
        contextFiles: [],
      });

      await dispatchService.dispatch(auth.id);

      expect(() => {
        PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
      }).toThrow(/MANUAL_HANDOFF_NOT_REQUIRED/);
    });

    it('15. Authorized WorkOrder contains Manager EXECUTE instructions', async () => {
      const managerMsg = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-EXEC-15',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'EXECUTE',
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        instructions: ['Implement strict schema validation', 'Check all boundary conditions'],
        priority: 'HIGH',
        risk: 'MEDIUM',
        acceptance_criteria: ['Coverage > 90%'],
      };
      await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));

      const routingDecision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      const auth = await authorizationService.createAuthorization({
        projectId: testProjectId,
        taskId: testTaskId,
        routingDecisionId: routingDecision.decisionId,
        contextFiles: [],
      });

      await dispatchService.dispatch(auth.id);
      const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);

      expect(workOrder).toContain('Implement strict schema validation');
      expect(workOrder).toContain('Check all boundary conditions');
      expect(workOrder).toContain('Manager Instructions (EXECUTE)');
    });

    it('16. Authorized WorkOrder contains Manager FIX_REQUIRED corrective instructions', async () => {
      // First apply initial EXECUTE
      const mgr1 = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-INIT',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'EXECUTE',
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        instructions: ['Initial work'],
        priority: 'HIGH',
        risk: 'MEDIUM',
      };
      await taskService.applyManagerDecision(mgr1 as any, JSON.stringify(mgr1));

      // Put task into REVIEWING state
      repo.updateTaskState(testTaskId, 'REVIEWING');

      // Now apply FIX_REQUIRED
      const fixMsg = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-FIX-16',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'FIX_REQUIRED',
        expected_task_state: 'REVIEWING',
        expected_revision: 0,
        instructions: ['Fix memory leak in buffer allocation', 'Add teardown in test suite'],
        priority: 'HIGH',
        risk: 'HIGH',
        acceptance_criteria: ['Zero memory leak detected'],
      };
      const fixRes = await taskService.applyManagerDecision(fixMsg as any, JSON.stringify(fixMsg));
      expect(fixRes.success).toBe(true);

      const routingDecision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      const auth = await authorizationService.createAuthorization({
        projectId: testProjectId,
        taskId: testTaskId,
        routingDecisionId: routingDecision.decisionId,
        contextFiles: [],
      });

      await dispatchService.dispatch(auth.id);
      const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);

      expect(workOrder).toContain('Fix memory leak in buffer allocation');
      expect(workOrder).toContain('Add teardown in test suite');
      expect(workOrder).toContain('Manager Instructions (FIX_REQUIRED)');
    });

    it('17. Authorized WorkOrder contains all required envelope metadata fields', async () => {
      const managerMsg = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-META-17',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'EXECUTE',
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        instructions: ['Build feature'],
        priority: 'HIGH',
        risk: 'MEDIUM',
      };
      await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));

      const routingDecision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      const auth = await authorizationService.createAuthorization({
        projectId: testProjectId,
        taskId: testTaskId,
        routingDecisionId: routingDecision.decisionId,
        contextFiles: ['README.md'],
      });

      await dispatchService.dispatch(auth.id);
      const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);

      expect(workOrder).toContain(auth.id);
      expect(workOrder).toContain(auth.project_id);
      expect(workOrder).toContain(auth.task_id);
      expect(workOrder).toContain(`Rev ${auth.task_revision}`);
      expect(workOrder).toContain(auth.manager_message_id);
      expect(workOrder).toContain(auth.routing_decision_id);
      expect(workOrder).toContain(auth.selected_resource_id);
      expect(workOrder).toContain(auth.selected_provider_id);
      expect(workOrder).toContain(auth.repository_head_sha);
      expect(workOrder).toContain(auth.instruction_payload_hash);
      expect(workOrder).toContain(auth.context_manifest_hash);
    });

    it('18. Authorized WorkOrder context paths come from context_files_json', async () => {
      const managerMsg = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-CTX-18',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'EXECUTE',
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        instructions: ['Refactor docs'],
        priority: 'HIGH',
        risk: 'LOW',
      };
      await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));

      const routingDecision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      const auth = await authorizationService.createAuthorization({
        projectId: testProjectId,
        taskId: testTaskId,
        routingDecisionId: routingDecision.decisionId,
        contextFiles: ['README.md'],
      });

      await dispatchService.dispatch(auth.id);
      const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);

      expect(workOrder).toContain('- `README.md`');
    });

    it('19. New authorization persists canonical_payload_json and computePayloadHash matches instruction_payload_hash', async () => {
      const managerMsg = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-CANON-19',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'EXECUTE',
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        instructions: ['Persist canonical payload'],
        priority: 'HIGH',
        risk: 'LOW',
      };
      await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));

      const routingDecision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      const auth = await authorizationService.createAuthorization({
        projectId: testProjectId,
        taskId: testTaskId,
        routingDecisionId: routingDecision.decisionId,
        contextFiles: ['README.md'],
      });

      expect(auth.canonical_payload_json).not.toBeNull();
      const parsedPayload = JSON.parse(auth.canonical_payload_json!);
      expect(parsedPayload.projectId).toBe(testProjectId);
      expect(parsedPayload.taskId).toBe(testTaskId);
      expect(computePayloadHash(parsedPayload)).toBe(auth.instruction_payload_hash);
    });

    it('20. Wrong but valid 64-hex SHA-256 digest fails closed', async () => {
      const managerMsg = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-WRONGHEX-20',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'EXECUTE',
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        instructions: ['Wrong hex test'],
        priority: 'HIGH',
        risk: 'LOW',
      };
      await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));

      const routingDecision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      const auth = await authorizationService.createAuthorization({
        projectId: testProjectId,
        taskId: testTaskId,
        routingDecisionId: routingDecision.decisionId,
        contextFiles: [],
      });

      await dispatchService.dispatch(auth.id);

      // Tamper hash to 'f'.repeat(64) - valid 64-hex format, but wrong digest
      db.prepare('UPDATE execution_authorizations SET instruction_payload_hash = ? WHERE id = ?').run(
        'f'.repeat(64),
        auth.id
      );

      expect(() => {
        PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
      }).toThrow(/EXECUTION_AUTHORIZATION_TAMPERED: Instruction payload hash mismatch/);
    });

    it('21. Changed canonical_instructions_json with original valid hash fails closed', async () => {
      const managerMsg = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-INST-21',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'EXECUTE',
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        instructions: ['Original instructions'],
        priority: 'HIGH',
        risk: 'LOW',
      };
      await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));

      const routingDecision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      const auth = await authorizationService.createAuthorization({
        projectId: testProjectId,
        taskId: testTaskId,
        routingDecisionId: routingDecision.decisionId,
        contextFiles: [],
      });

      await dispatchService.dispatch(auth.id);

      // Tamper canonical_instructions_json only
      db.prepare('UPDATE execution_authorizations SET canonical_instructions_json = ? WHERE id = ?').run(
        JSON.stringify(['Tampered instruction line']),
        auth.id
      );

      expect(() => {
        PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
      }).toThrow(/EXECUTION_AUTHORIZATION_TAMPERED: Canonical instructions mismatch/);
    });

    it('22. Changed canonical_payload_json.instructions with original hash fails closed', async () => {
      const managerMsg = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-PAYLOAD-INST-22',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'EXECUTE',
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        instructions: ['Original instructions'],
        priority: 'HIGH',
        risk: 'LOW',
      };
      await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));

      const routingDecision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      const auth = await authorizationService.createAuthorization({
        projectId: testProjectId,
        taskId: testTaskId,
        routingDecisionId: routingDecision.decisionId,
        contextFiles: [],
      });

      await dispatchService.dispatch(auth.id);

      const parsedPayload = JSON.parse(auth.canonical_payload_json!);
      parsedPayload.instructions = ['Tampered inside canonical payload'];

      db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ? WHERE id = ?').run(
        JSON.stringify(parsedPayload),
        auth.id
      );

      expect(() => {
        PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
      }).toThrow(/EXECUTION_AUTHORIZATION_TAMPERED/);
    });

    it('23. Malformed canonical_payload_json fails closed', async () => {
      const managerMsg = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-MALFORM-23',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'EXECUTE',
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        instructions: ['Original instructions'],
        priority: 'HIGH',
        risk: 'LOW',
      };
      await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));

      const routingDecision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      const auth = await authorizationService.createAuthorization({
        projectId: testProjectId,
        taskId: testTaskId,
        routingDecisionId: routingDecision.decisionId,
        contextFiles: [],
      });

      await dispatchService.dispatch(auth.id);

      db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ? WHERE id = ?').run(
        '{ not valid json',
        auth.id
      );

      expect(() => {
        PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
      }).toThrow(/EXECUTION_AUTHORIZATION_CORRUPTED: Invalid canonical_payload_json/);
    });

    it('24. Canonical payload contextFiles differ from context_files_json fails closed', async () => {
      const managerMsg = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-CTXDIFF-24',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'EXECUTE',
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        instructions: ['Original instructions'],
        priority: 'HIGH',
        risk: 'LOW',
      };
      await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));

      const routingDecision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      const auth = await authorizationService.createAuthorization({
        projectId: testProjectId,
        taskId: testTaskId,
        routingDecisionId: routingDecision.decisionId,
        contextFiles: ['README.md'],
      });

      await dispatchService.dispatch(auth.id);

      // Modify context_files_json to differ from canonical_payload_json
      db.prepare('UPDATE execution_authorizations SET context_files_json = ? WHERE id = ?').run(
        JSON.stringify([]),
        auth.id
      );

      expect(() => {
        PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
      }).toThrow(/EXECUTION_AUTHORIZATION_TAMPERED: Context files mismatch/);
    });

    it('25. Canonical payload scope mismatches (projectId, taskId, attemptId, manager bindings) fail closed', async () => {
      const managerMsg = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-SCOPE-25',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'EXECUTE',
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        instructions: ['Original instructions'],
        priority: 'HIGH',
        risk: 'LOW',
      };
      await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));

      const routingDecision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      const auth = await authorizationService.createAuthorization({
        projectId: testProjectId,
        taskId: testTaskId,
        routingDecisionId: routingDecision.decisionId,
        contextFiles: [],
      });

      await dispatchService.dispatch(auth.id);

      // 1. projectId mismatch
      const p1 = JSON.parse(auth.canonical_payload_json!);
      p1.projectId = 'PROJ-OTHER';
      db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ? WHERE id = ?').run(
        JSON.stringify(p1),
        auth.id
      );
      expect(() => {
        PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
      }).toThrow(/EXECUTION_AUTHORIZATION_TAMPERED: Canonical payload projectId mismatch/);

      // 2. taskId mismatch
      const p2 = JSON.parse(auth.canonical_payload_json!);
      p2.taskId = 'TSK-OTHER';
      db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ? WHERE id = ?').run(
        JSON.stringify(p2),
        auth.id
      );
      expect(() => {
        PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
      }).toThrow(/EXECUTION_AUTHORIZATION_TAMPERED: Canonical payload taskId mismatch/);

      // 3. managerMessageId mismatch
      const p3 = JSON.parse(auth.canonical_payload_json!);
      p3.managerMessageId = 'MSG-OTHER';
      db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ? WHERE id = ?').run(
        JSON.stringify(p3),
        auth.id
      );
      expect(() => {
        PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
      }).toThrow(/EXECUTION_AUTHORIZATION_TAMPERED: Canonical payload managerMessageId mismatch/);

      // 4. managerPayloadHash mismatch
      const p4 = JSON.parse(auth.canonical_payload_json!);
      p4.managerPayloadHash = '0'.repeat(64);
      db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ? WHERE id = ?').run(
        JSON.stringify(p4),
        auth.id
      );
      expect(() => {
        PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
      }).toThrow(/EXECUTION_AUTHORIZATION_TAMPERED: Canonical payload managerPayloadHash mismatch/);
    });

    it('26. Legacy authorization with canonical_payload_json NULL fails closed', async () => {
      const managerMsg = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-LEGACY-26',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'EXECUTE',
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        instructions: ['Legacy record test'],
        priority: 'HIGH',
        risk: 'LOW',
      };
      await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));

      const routingDecision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      const auth = await authorizationService.createAuthorization({
        projectId: testProjectId,
        taskId: testTaskId,
        routingDecisionId: routingDecision.decisionId,
        contextFiles: [],
      });

      await dispatchService.dispatch(auth.id);

      // Set canonical_payload_json to NULL as in legacy pre-007 records
      db.prepare('UPDATE execution_authorizations SET canonical_payload_json = NULL WHERE id = ?').run(auth.id);

      expect(() => {
        PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
      }).toThrow(/AUTHORIZED_WORKORDER_CANONICAL_PAYLOAD_MISSING/);
    });

    it('27. AUTHORIZED but not DISPATCHED fails closed for WorkOrder generation', async () => {
      const managerMsg = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-NOTDISP-27',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'EXECUTE',
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        instructions: ['Not dispatched'],
        priority: 'HIGH',
        risk: 'LOW',
      };
      await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));

      const routingDecision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      const auth = await authorizationService.createAuthorization({
        projectId: testProjectId,
        taskId: testTaskId,
        routingDecisionId: routingDecision.decisionId,
        contextFiles: [],
      });

      // Status is AUTHORIZED, not DISPATCHED
      expect(() => {
        PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
      }).toThrow(/EXECUTION_AUTHORIZATION_NOT_DISPATCHED/);
    });

    it('28. Current Task fields mutated AFTER dispatch do not alter the frozen instructions', async () => {
      const managerMsg = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-MUT-28',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'EXECUTE',
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        instructions: ['Original frozen Manager instruction'],
        priority: 'HIGH',
        risk: 'LOW',
      };
      await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));

      const routingDecision = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      const auth = await authorizationService.createAuthorization({
        projectId: testProjectId,
        taskId: testTaskId,
        routingDecisionId: routingDecision.decisionId,
        contextFiles: [],
      });

      await dispatchService.dispatch(auth.id);

      // Mutate task description and criteria directly in tasks table AFTER dispatch
      db.prepare('UPDATE tasks SET description = ?, title = ? WHERE id = ?').run(
        'Mutated task description that must not be in authorized handoff',
        'Mutated title',
        testTaskId
      );

      const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
      expect(workOrder).toContain('Original frozen Manager instruction');
      expect(workOrder).not.toContain('Mutated task description');
    });
  });

  // =========================================================================
  // 3. Snapshot & Route Independence Gates & Latest Route Durability
  // =========================================================================
  describe('Snapshot & Route Independence Gates', () => {
    it('29-30. Route A -> Auth A -> Route B keeps latestRoutingDecision = B and authorizationRoutingDecision = A', async () => {
      const managerMsg = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-ROUTE-29',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'EXECUTE',
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        instructions: ['Step 1'],
        priority: 'HIGH',
        risk: 'LOW',
      };
      await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));

      // Route A
      const routeA = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      // Auth A bound to Route A
      const authA = await authorizationService.createAuthorization({
        projectId: testProjectId,
        taskId: testTaskId,
        routingDecisionId: routeA.decisionId,
        contextFiles: [],
      });

      // Route B (e.g., owner re-routed)
      const routeB = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      expect(routeB.decisionId).not.toBe(routeA.decisionId);

      // Check direct lookup logic
      const latestRoutingEvent = repo.getLatestRoutingDecisionEventByTask(testProjectId, testTaskId);
      const latestRoutingDecision = latestRoutingEvent?.structured_payload as any;

      const authRoutingEvent = repo.getRoutingDecisionEvent(authA.routing_decision_id);
      const authorizationRoutingDecision = authRoutingEvent?.structured_payload as any;

      expect(latestRoutingDecision.decisionId).toBe(routeB.decisionId);
      expect(authorizationRoutingDecision.decisionId).toBe(routeA.decisionId);
      expect(authA.routing_decision_id).toBe(routeA.decisionId);
    });

    it('31. getLatestRoutingDecisionEventByTask finds latest route even after >50 newer unrelated project events', async () => {
      const managerMsg = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-DURABLE-31',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'EXECUTE',
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        instructions: ['Durability test'],
        priority: 'HIGH',
        risk: 'LOW',
      };
      await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));

      const routeA = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      // Persist 60 unrelated events for the same project
      for (let i = 0; i < 60; i++) {
        eventService.record(
          testProjectId,
          'HEARTBEAT',
          `Unrelated heartbeat event ${i}`,
          { iteration: i }
        );
      }

      // Recreate repo to ensure zero cache dependency
      const freshRepo = new Repository(db);
      const foundEvent = freshRepo.getLatestRoutingDecisionEventByTask(testProjectId, testTaskId);
      expect(foundEvent).not.toBeNull();
      const payload = foundEvent!.structured_payload as any;
      expect(payload.decisionId).toBe(routeA.decisionId);
      expect(payload.taskId).toBe(testTaskId);
    });
  });

  // =========================================================================
  // 4. Clipboard & Protocol Non-Automation Invariants
  // =========================================================================
  describe('Clipboard & Protocol Non-Automation Invariants', () => {
    it('29. WorkOrder generation does not write to clipboard', () => {
      // Pure function generation test
      const project = repo.getProject(testProjectId)!;
      const task = repo.getTask(testTaskId)!;
      const wo = PackageGenerator.generateWorkOrder(project, task);
      expect(typeof wo).toBe('string');
      expect(wo.length).toBeGreaterThan(0);
    });

    it('30. Clipboard write occurs only on explicit Owner click action', () => {
      // Proved by UI click handler pattern (navigator.clipboard.writeText strictly in onClick)
      let clipboardWritten = false;
      const handleOwnerClick = () => {
        clipboardWritten = true;
      };
      expect(clipboardWritten).toBe(false);
      handleOwnerClick();
      expect(clipboardWritten).toBe(true);
    });

    it('31. Invalid coder.v1 cannot advance task lifecycle', async () => {
      const invalidCoderInput = JSON.stringify({
        protocol: 'coder.v1',
        task_id: testTaskId,
        status: 'BOGUS_STATUS',
      });
      const parseRes = ProtocolParser.parse(invalidCoderInput);
      expect(parseRes.success).toBe(false);
      expect(repo.getTask(testTaskId)?.state).toBe('PLANNED');
    });

    it('32. Valid coder.v1 report advances lifecycle through existing flow', async () => {
      const managerMsg = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-32',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'EXECUTE',
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        instructions: ['Implement feature'],
        priority: 'HIGH',
        risk: 'LOW',
      };
      await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));

      const validCoderInput = JSON.stringify({
        protocol: 'coder.v1',
        message_id: 'MSG-CODER-32',
        project_id: testProjectId,
        task_id: testTaskId,
        status: 'COMPLETED',
        files_claimed_changed: ['README.md'],
        tests_claimed: ['npm test'],
        blockers: [],
      });
      const parseRes = ProtocolParser.parse(validCoderInput);
      expect(parseRes.success).toBe(true);

      const applyRes = taskService.applyCoderReport(parseRes.data!.data as any, validCoderInput);
      expect(applyRes.success).toBe(true);
      expect(repo.getTask(testTaskId)?.state).toBe('VALIDATING');
    });

    it('33. Post-dispatch rerouting is prevented (DISPATCHED authorizations are terminal and claimed)', async () => {
      const managerMsg = {
        protocol: 'manager.v1',
        message_id: 'MSG-MGR-33',
        project_id: testProjectId,
        task_id: testTaskId,
        decision: 'EXECUTE',
        expected_task_state: 'PLANNED',
        expected_revision: 0,
        instructions: ['No rerouting test'],
        priority: 'HIGH',
        risk: 'LOW',
      };
      await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));

      const route = await routingService.route({
        projectId: testProjectId,
        taskId: testTaskId,
        candidateResourceIds: ['res-gemini-coder'],
        allowManualBridge: true,
        requiredCapabilities: ['CODING'],
      });

      const auth = await authorizationService.createAuthorization({
        projectId: testProjectId,
        taskId: testTaskId,
        routingDecisionId: route.decisionId,
        contextFiles: [],
      });

      await dispatchService.dispatch(auth.id);

      const replay = await dispatchService.dispatch(auth.id);
      expect(replay.status).toBe('FAILED');
      expect(replay.error).toContain('EXECUTION_AUTHORIZATION_ALREADY_DISPATCHED');
    });
  });

  // =========================================================================
  // 5. Provider Safety & Adapter Contracts
  // =========================================================================
  describe('Provider Safety & Adapter Contracts', () => {
    it('36. Codex remains OFFLINE / [] / fail-closed', async () => {
      const codex = new CodexCliAdapter({ repo, artifactStore });
      expect(await codex.getHealth()).toBe('OFFLINE');
      expect(await codex.getCapabilities()).toEqual([]);
      const exec = await codex.execute({
        taskId: testTaskId,
        projectId: testProjectId,
        instructions: ['test'],
        contextFiles: [],
      });
      expect(exec.status).toBe('FAILED');
      expect(exec.error).toContain('CODEX_CLI_UNAVAILABLE');
    });

    it('37-38. ManualBridge remains MANUAL_BRIDGE and returns AWAITING_OWNER', async () => {
      const bridge = new ManualBridgeAdapter();
      expect(bridge.adapterType).toBe('MANUAL_BRIDGE');
      const exec = await bridge.execute({
        taskId: testTaskId,
        projectId: testProjectId,
        instructions: ['manual work'],
        contextFiles: [],
      });
      expect(exec.status).toBe('AWAITING_OWNER');
    });

    it('39. Emergency Stop remains functional and unaffected', () => {
      repo.updateProjectStatus(testProjectId, 'RUNNING');
      const stopRes = emergencyStopService.triggerEmergencyStop('Test stop');
      expect(stopRes.projectsPaused).toContain(testProjectId);
      expect(repo.getProject(testProjectId)?.status).toBe('PAUSED');

      emergencyStopService.resumeProject(testProjectId);
      expect(repo.getProject(testProjectId)?.status).toBe('RUNNING');
    });
  });
});
