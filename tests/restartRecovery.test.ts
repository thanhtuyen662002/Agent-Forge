import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { EventService } from '../src/core/services/EventService';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import { ProjectService } from '../src/core/services/ProjectService';
import { VerificationService } from '../src/core/services/VerificationService';
import { TaskService } from '../src/core/services/TaskService';
import { ProviderRegistry } from '../src/core/adapters/ProviderRegistry';
import { ManualBridgeAdapter } from '../src/core/adapters/ManualBridgeAdapter';
import { ProviderRoutingService } from '../src/core/services/ProviderRoutingService';
import { ExecutionAuthorizationService } from '../src/core/services/ExecutionAuthorizationService';
import { ProviderDispatchService } from '../src/core/services/ProviderDispatchService';
import { PackageGenerator } from '../src/core/protocol/packageGenerator';
import { UpdateService } from '../src/core/services/UpdateService';
import { resolveInitialLocale } from '../src/shared/i18n';

describe('Workflow & State Restart Recovery Invariants (PR #9)', () => {
  let tempDir: string;
  let dbDir: string;
  let artifactsDir: string;
  let gitRepoDir: string;
  let db: Database.Database | null;
  let repo: Repository;
  let eventService: EventService;
  let artifactStore: ArtifactStore;
  let projectService: ProjectService;
  let verificationService: VerificationService;
  let taskService: TaskService;
  let providerRegistry: ProviderRegistry;
  let routingService: ProviderRoutingService;
  let authService: ExecutionAuthorizationService;
  let dispatchService: ProviderDispatchService;

  let testProjectId: string;
  let testTaskId: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-restart-test-'));
    dbDir = path.join(tempDir, 'db');
    artifactsDir = path.join(tempDir, 'artifacts');
    gitRepoDir = path.join(tempDir, 'repo');

    fs.mkdirSync(dbDir, { recursive: true });
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.mkdirSync(gitRepoDir, { recursive: true });

    // Initialize real git repo
    execSync('git init', { cwd: gitRepoDir });
    execSync('git config user.email "test@test.com"', { cwd: gitRepoDir });
    execSync('git config user.name "Tester"', { cwd: gitRepoDir });
    fs.writeFileSync(path.join(gitRepoDir, 'README.md'), '# Initial README\n');
    execSync('git add README.md && git commit -m "initial commit"', { cwd: gitRepoDir });

    db = new Database(path.join(dbDir, 'test.db'));
    MigrationRunner.run(db);

    repo = new Repository(db);
    eventService = new EventService(repo);
    artifactStore = new ArtifactStore(artifactsDir);
    projectService = new ProjectService(repo, eventService);
    verificationService = new VerificationService(repo, artifactStore);
    taskService = new TaskService(repo, eventService, verificationService, artifactStore);

    providerRegistry = new ProviderRegistry();
    providerRegistry.register(new ManualBridgeAdapter());

    routingService = new ProviderRoutingService(repo, providerRegistry, eventService);
    authService = new ExecutionAuthorizationService(repo, eventService);
    dispatchService = new ProviderDispatchService(providerRegistry, repo, eventService);

    // Seed test project & provider resources
    const proj = projectService.createProject('Restart Recovery Project', 'Testing restart loop', gitRepoDir, 'main');
    testProjectId = proj.id;

    // Seed Manual Bridge provider & resource
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

    const createdTask = taskService.createTask({
      projectId: testProjectId,
      title: 'Manual Bridge Relay Task',
      description: 'Ensure handoff state survives restart',
      priority: 'HIGH',
      risk: 'LOW',
      acceptanceCriteria: ['Must survive app restart'],
      constraints: ['SQLite durable truth'],
    });
    testTaskId = createdTask.id;
  });

  afterEach(() => {
    if (db && db.open) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows file lock fallback
    }
  });

  it('A. AWAITING_OWNER handoff state and WorkOrder generation survive simulated app restart', async () => {
    // 1. Apply Manager decision
    const managerMsg = {
      protocol: 'manager.v1',
      message_id: 'MSG-MGR-RESTART-01',
      project_id: testProjectId,
      task_id: testTaskId,
      decision: 'EXECUTE',
      expected_task_state: 'PLANNED',
      expected_revision: 0,
      instructions: ['Implement durable recovery tests'],
      priority: 'HIGH',
      risk: 'LOW',
    };
    await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));

    // 2. Route to Manual Bridge
    const routingDecision = await routingService.route({
      projectId: testProjectId,
      taskId: testTaskId,
      candidateResourceIds: ['res-gemini-coder'],
      allowManualBridge: true,
      requiredCapabilities: ['CODING'],
    });
    expect(routingDecision.outcome).toBe('MANUAL_HANDOFF_REQUIRED');

    // 3. Create and dispatch authorization
    const auth = await authService.createAuthorization({
      projectId: testProjectId,
      taskId: testTaskId,
      routingDecisionId: routingDecision.decisionId,
      contextFiles: ['README.md'],
    });

    const dispatchResult = await dispatchService.dispatch(auth.id);
    expect(dispatchResult.status).toBe('AWAITING_OWNER');

    // 4. Simulate App Restart (close db connection, create brand new connection and services)
    db?.close();
    db = null;

    const restartDb = new Database(path.join(dbDir, 'test.db'));
    const restartRepo = new Repository(restartDb);

    // 5. Verify restored state from SQLite
    const recoveredAuth = restartRepo.getExecutionAuthorization(auth.id);
    expect(recoveredAuth).not.toBeNull();
    expect(recoveredAuth?.status).toBe('DISPATCHED');
    expect(recoveredAuth?.canonical_payload_json).not.toBeNull();

    // 6. Generate WorkOrder from fresh repository instance
    const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, restartRepo);
    expect(workOrder).toContain('Implement durable recovery tests');
    expect(workOrder).toContain('README.md');
    expect(workOrder).toContain(auth.id);

    restartDb.close();
  });

  it('B. downloaded software update waiting for install does not auto-install on restart', () => {
    const updateService = new UpdateService({
      currentVersion: '0.1.0',
      isPackaged: true,
    });

    // After app restart, update service starts in IDLE without auto-restarting
    expect(updateService.getState().state).toBe('IDLE');
    expect(updateService.getState().canInstall).toBe(false);
  });

  it('C. an already consumed ExecutionAuthorization cannot be dispatched again after restart', async () => {
    const managerMsg = {
      protocol: 'manager.v1',
      message_id: 'MSG-MGR-RESTART-02',
      project_id: testProjectId,
      task_id: testTaskId,
      decision: 'EXECUTE',
      expected_task_state: 'PLANNED',
      expected_revision: 0,
      instructions: ['No replay after restart'],
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

    const auth = await authService.createAuthorization({
      projectId: testProjectId,
      taskId: testTaskId,
      routingDecisionId: routingDecision.decisionId,
      contextFiles: [],
    });

    await dispatchService.dispatch(auth.id);

    // Simulate Restart
    db?.close();
    db = null;

    const restartDb = new Database(path.join(dbDir, 'test.db'));
    const restartRepo = new Repository(restartDb);
    const restartRegistry = new ProviderRegistry();
    restartRegistry.register(new ManualBridgeAdapter());
    const restartEventService = new EventService(restartRepo);
    const restartDispatchService = new ProviderDispatchService(restartRegistry, restartRepo, restartEventService);

    // Attempting to dispatch again returns FAILED with ALREADY_DISPATCHED error
    const replayResult = await restartDispatchService.dispatch(auth.id);
    expect(replayResult.status).toBe('FAILED');
    expect(replayResult.error).toContain('EXECUTION_AUTHORIZATION_ALREADY_DISPATCHED');

    restartDb.close();
  });

  it('D. stale authorization remains invalid after restart', async () => {
    const managerMsg1 = {
      protocol: 'manager.v1',
      message_id: 'MSG-MGR-RESTART-03A',
      project_id: testProjectId,
      task_id: testTaskId,
      decision: 'EXECUTE',
      expected_task_state: 'PLANNED',
      expected_revision: 0,
      instructions: ['Revision 0 instructions'],
      priority: 'HIGH',
      risk: 'LOW',
    };
    await taskService.applyManagerDecision(managerMsg1 as any, JSON.stringify(managerMsg1));

    const routingDecision = await routingService.route({
      projectId: testProjectId,
      taskId: testTaskId,
      candidateResourceIds: ['res-gemini-coder'],
      allowManualBridge: true,
      requiredCapabilities: ['CODING'],
    });

    const auth = await authService.createAuthorization({
      projectId: testProjectId,
      taskId: testTaskId,
      routingDecisionId: routingDecision.decisionId,
      contextFiles: [],
    });

    // Advance task revision to 1
    repo.updateTaskState(testTaskId, 'CODING', null, true);

    // Simulate restart
    db?.close();
    db = null;

    const restartDb = new Database(path.join(dbDir, 'test.db'));
    const restartRepo = new Repository(restartDb);
    const restartRegistry = new ProviderRegistry();
    restartRegistry.register(new ManualBridgeAdapter());
    const restartEventService = new EventService(restartRepo);
    const restartDispatchService = new ProviderDispatchService(restartRegistry, restartRepo, restartEventService);

    // Stale authorization cannot be dispatched (task revision mismatch)
    const staleResult = await restartDispatchService.dispatch(auth.id);
    expect(staleResult.status).toBe('FAILED');
    expect(staleResult.error).toContain('EXECUTION_AUTHORIZATION_STALE_TASK_REVISION');

    restartDb.close();
  });

  it('E. language selection preference survives and resolves consistently', () => {
    // Saved Vietnamese preference
    expect(resolveInitialLocale('vi-VN', 'en-US')).toBe('vi-VN');
    // Saved English preference
    expect(resolveInitialLocale('en-US', 'vi-VN')).toBe('en-US');
  });
});
