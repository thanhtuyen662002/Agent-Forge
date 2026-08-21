import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { EventService } from '../src/core/services/EventService';
import { TaskService } from '../src/core/services/TaskService';
import { ProviderRegistry } from '../src/core/adapters/ProviderRegistry';
import { ManualBridgeAdapter } from '../src/core/adapters/ManualBridgeAdapter';
import { ProviderRoutingService } from '../src/core/services/ProviderRoutingService';
import { ExecutionAuthorizationService } from '../src/core/services/ExecutionAuthorizationService';
import { ProviderDispatchService } from '../src/core/services/ProviderDispatchService';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import { VerificationService } from '../src/core/services/VerificationService';
import { PackageGenerator } from '../src/core/protocol/packageGenerator';
import { Project, Task } from '../src/core/types/domain';

describe('WorkOrder Verification Guidance Truthfulness', () => {
  let db: Database.Database;
  let repo: Repository;
  let eventService: EventService;
  let taskService: TaskService;
  let registry: ProviderRegistry;
  let routingService: ProviderRoutingService;
  let authorizationService: ExecutionAuthorizationService;
  let dispatchService: ProviderDispatchService;
  let artifactStore: ArtifactStore;
  let verificationService: VerificationService;

  let testProjectId: string;
  let testTaskId: string;
  let testProject: Project;
  let testTask: Task;

  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-workorder-truth-test-'));
    execSync('git init', { cwd: tempDir });
    execSync('git config user.email "test@agentforge.test"', { cwd: tempDir });
    execSync('git config user.name "Tester"', { cwd: tempDir });
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# Initial README\n');
    execSync('git add . && git commit -m "initial commit"', { cwd: tempDir });

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);

    repo = new Repository(db);
    eventService = new EventService(repo);
    artifactStore = new ArtifactStore(tempDir);
    verificationService = new VerificationService(repo, artifactStore);
    taskService = new TaskService(repo, eventService, verificationService, artifactStore);

    registry = new ProviderRegistry();
    registry.register(new ManualBridgeAdapter());

    routingService = new ProviderRoutingService(repo, registry, eventService);
    authorizationService = new ExecutionAuthorizationService(repo, eventService);
    dispatchService = new ProviderDispatchService(registry, repo, eventService);

    // Seed Manual Bridge provider & resource in database
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

    testProjectId = 'PROJ-TEST-001';
    testProject = {
      id: testProjectId,
      name: 'Truthful Verification Project A',
      description: 'Testing verification truth in WorkOrders',
      repository_path: tempDir,
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      completed_at: null,
    };
    repo.createProject(testProject);

    const t = taskService.createTask({
      projectId: testProjectId,
      title: 'Verification Truth Task',
      description: 'Validate WorkOrder guidance reflects durable SQLite truth',
      priority: 'HIGH',
      risk: 'LOW',
      acceptanceCriteria: ['Must render node verify.js', 'Must not invent npm test'],
      constraints: ['No invented defaults'],
    });
    testTaskId = t.id;
    testTask = repo.getTask(testTaskId)!;
  });

  afterEach(() => {
    try {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Cleanup
    }
  });

  async function createAndDispatchManualHandoff(projectId: string, taskId: string): Promise<string> {
    repo.updateTaskState(taskId, 'PLANNED');
    const managerMsg = {
      protocol: 'manager.v1',
      message_id: `MSG-MGR-${crypto.randomUUID()}`,
      project_id: projectId,
      task_id: taskId,
      decision: 'EXECUTE',
      expected_task_state: 'PLANNED',
      expected_revision: 0,
      instructions: ['Implement truthful verification handling.'],
      priority: 'HIGH',
      risk: 'LOW',
    };
    await taskService.applyManagerDecision(managerMsg as any, JSON.stringify(managerMsg));

    const routingDecision = await routingService.route({
      projectId,
      taskId,
      candidateResourceIds: ['res-gemini-coder'],
      allowManualBridge: true,
      requiredCapabilities: ['CODING'],
    });

    const auth = await authorizationService.createAuthorization({
      projectId,
      taskId,
      routingDecisionId: routingDecision.decisionId,
      contextFiles: ['README.md'],
    });

    await dispatchService.dispatch(auth.id);
    return auth.id;
  }

  // =========================================================================
  // CASE A: Authorized WorkOrder with TEST=node verify.js and unconfigured LINT/BUILD
  // =========================================================================
  it('CASE A: Authorized WorkOrder reflects durable TEST=node verify.js and unconfigured LINT/BUILD without invented npm defaults', async () => {
    // Configure durable verification command: TEST only
    repo.createVerificationCommand({
      id: 'vc-test-01',
      project_id: testProjectId,
      name: 'Test Suite',
      command_type: 'TEST',
      executable: 'node',
      args: ['verify.js'],
      enabled: true,
    });

    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);

    const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);

    // Must contain exact configured command
    expect(workOrder).toContain('- **Test**: `node verify.js`');

    // Must explicitly indicate LINT and BUILD are unconfigured
    expect(workOrder).toContain('- **Lint**: Not configured');
    expect(workOrder).toContain('- **Build**: Not configured');

    // Must NOT contain blind npm defaults
    expect(workOrder).not.toContain('`npm test`');
    expect(workOrder).not.toContain('`npm run lint`');
    expect(workOrder).not.toContain('`npm run build`');
    expect(workOrder).not.toContain('npm run lint');
    expect(workOrder).not.toContain('npm run build');
  });

  // =========================================================================
  // CASE B: Legacy WorkOrder uses the same durable SQLite truth
  // =========================================================================
  it('CASE B: Legacy WorkOrder uses durable SQLite truth from Repository without npm defaults', () => {
    repo.createVerificationCommand({
      id: 'vc-test-02',
      project_id: testProjectId,
      name: 'Test Suite',
      command_type: 'TEST',
      executable: 'node',
      args: ['verify.js'],
      enabled: true,
    });

    const workOrder = PackageGenerator.generateWorkOrder(testProject, testTask, repo);

    expect(workOrder).toContain('- **Test**: `node verify.js`');
    expect(workOrder).toContain('- **Lint**: Not configured');
    expect(workOrder).toContain('- **Build**: Not configured');

    expect(workOrder).not.toContain('`npm test`');
    expect(workOrder).not.toContain('`npm run lint`');
    expect(workOrder).not.toContain('`npm run build`');
  });

  // =========================================================================
  // CASE C: Cross-project isolation between Project A and Project B
  // =========================================================================
  it('CASE C: Cross-project isolation ensures Project A verification command is never leaked into Project B WorkOrder', async () => {
    // Project A has TEST = node verify.js
    repo.createVerificationCommand({
      id: 'vc-proj-a',
      project_id: testProjectId,
      name: 'Project A Tests',
      command_type: 'TEST',
      executable: 'node',
      args: ['verify.js'],
      enabled: true,
    });

    // Create Project B with TEST = python run_tests.py
    const projBId = 'PROJ-TEST-002';
    const projB: Project = {
      id: projBId,
      name: 'Truthful Verification Project B',
      description: 'Project B with different verification command',
      repository_path: tempDir,
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      completed_at: null,
    };
    repo.createProject(projB);

    const taskB = taskService.createTask({
      projectId: projBId,
      title: 'Task on Project B',
      description: 'Project B task',
      priority: 'MEDIUM',
      risk: 'LOW',
      acceptanceCriteria: ['Project B criterion'],
      constraints: [],
    });

    repo.createVerificationCommand({
      id: 'vc-proj-b',
      project_id: projBId,
      name: 'Project B Tests',
      command_type: 'TEST',
      executable: 'python',
      args: ['run_tests.py'],
      enabled: true,
    });

    // Generate Authorized WorkOrders for both
    const authAId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const authBId = await createAndDispatchManualHandoff(projBId, taskB.id);

    const workOrderA = PackageGenerator.generateAuthorizedManualWorkOrder(authAId, repo);
    const workOrderB = PackageGenerator.generateAuthorizedManualWorkOrder(authBId, repo);

    // Project A has node verify.js, NOT python run_tests.py
    expect(workOrderA).toContain('- **Test**: `node verify.js`');
    expect(workOrderA).not.toContain('run_tests.py');

    // Project B has python run_tests.py, NOT node verify.js
    expect(workOrderB).toContain('- **Test**: `python run_tests.py`');
    expect(workOrderB).not.toContain('verify.js');

    // Legacy WorkOrders also isolate strictly
    const legacyWOA = PackageGenerator.generateWorkOrder(testProject, testTask, repo);
    const legacyWOB = PackageGenerator.generateWorkOrder(projB, taskB, repo);

    expect(legacyWOA).toContain('- **Test**: `node verify.js`');
    expect(legacyWOA).not.toContain('run_tests.py');

    expect(legacyWOB).toContain('- **Test**: `python run_tests.py`');
    expect(legacyWOB).not.toContain('verify.js');
  });

  // =========================================================================
  // CASE D: Disabled verification commands are not presented as configured
  // =========================================================================
  it('CASE D: Disabled verification commands are not presented as configured', async () => {
    // Disabled TEST command (enabled = false)
    repo.createVerificationCommand({
      id: 'vc-disabled-test',
      project_id: testProjectId,
      name: 'Disabled Test',
      command_type: 'TEST',
      executable: 'pytest',
      args: ['-v'],
      enabled: false,
    });

    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const authWorkOrder = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);
    const legacyWorkOrder = PackageGenerator.generateWorkOrder(testProject, testTask, repo);

    expect(authWorkOrder).toContain('- **Test**: Not configured');
    expect(authWorkOrder).toContain('- **Lint**: Not configured');
    expect(authWorkOrder).toContain('- **Build**: Not configured');
    expect(authWorkOrder).not.toContain('pytest');

    expect(legacyWorkOrder).toContain('- **Test**: Not configured');
    expect(legacyWorkOrder).toContain('- **Lint**: Not configured');
    expect(legacyWorkOrder).toContain('- **Build**: Not configured');
    expect(legacyWorkOrder).not.toContain('pytest');
  });

  // =========================================================================
  // CASE E: Arguments needing quoting are rendered deterministically/unambiguously
  // =========================================================================
  it('CASE E: Arguments needing quoting (spaces, quotes, flags) are rendered deterministically and unambiguously', async () => {
    repo.createVerificationCommand({
      id: 'vc-quoted-test',
      project_id: testProjectId,
      name: 'Quoted Args Test',
      command_type: 'TEST',
      executable: 'node',
      args: ['--test', 'test suite/integration spec.js', '--filter="all tests"'],
      enabled: true,
    });

    repo.createVerificationCommand({
      id: 'vc-quoted-lint',
      project_id: testProjectId,
      name: 'Quoted Args Lint',
      command_type: 'LINT',
      executable: 'eslint',
      args: ['src/**/*.{ts,tsx}', '--rule', 'semi: [2, "always"]'],
      enabled: true,
    });

    repo.createVerificationCommand({
      id: 'vc-quoted-build',
      project_id: testProjectId,
      name: 'Quoted Args Build',
      command_type: 'BUILD',
      executable: 'npm',
      args: ['run', 'build:prod --release'],
      enabled: true,
    });

    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const authWorkOrder = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);
    const legacyWorkOrder = PackageGenerator.generateWorkOrder(testProject, testTask, repo);

    // Spaces are safely quoted
    expect(authWorkOrder).toContain('- **Test**: `node --test "test suite/integration spec.js" \'--filter="all tests"\'`');
    expect(authWorkOrder).toContain('- **Lint**: `eslint src/**/*.{ts,tsx} --rule \'semi: [2, "always"]\'`');
    expect(authWorkOrder).toContain('- **Build**: `npm run "build:prod --release"`');

    expect(legacyWorkOrder).toContain('- **Test**: `node --test "test suite/integration spec.js" \'--filter="all tests"\'`');
    expect(legacyWorkOrder).toContain('- **Lint**: `eslint src/**/*.{ts,tsx} --rule \'semi: [2, "always"]\'`');
    expect(legacyWorkOrder).toContain('- **Build**: `npm run "build:prod --release"`');
  });

  // =========================================================================
  // CASE F: Complete absence of verification commands yields clean unconfigured output
  // =========================================================================
  it('CASE F: Completely unconfigured project renders all three types as Not configured', async () => {
    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const authWorkOrder = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);
    const legacyWorkOrder = PackageGenerator.generateWorkOrder(testProject, testTask, repo);

    expect(authWorkOrder).toContain('- **Test**: Not configured');
    expect(authWorkOrder).toContain('- **Lint**: Not configured');
    expect(authWorkOrder).toContain('- **Build**: Not configured');

    expect(legacyWorkOrder).toContain('- **Test**: Not configured');
    expect(legacyWorkOrder).toContain('- **Lint**: Not configured');
    expect(legacyWorkOrder).toContain('- **Build**: Not configured');
  });

  // =========================================================================
  // CASE G: Caller-supplied verification command objects are strictly rejected
  // =========================================================================
  it('CASE G: Caller cannot supply verification command overrides to bypass durable SQLite truth', () => {
    // Attempting to pass an unauthorized command object instead of Repository fails closed
    expect(() => {
      (PackageGenerator.generateWorkOrder as any)(testProject, testTask, {
        test: 'malicious-or-stale-command',
      });
    }).toThrow();

    // Authoritative Repository produces truthful "Not configured"
    const truthfulWorkOrder = PackageGenerator.generateWorkOrder(testProject, testTask, repo);
    expect(truthfulWorkOrder).toContain('- **Test**: Not configured');
    expect(truthfulWorkOrder).not.toContain('malicious-or-stale-command');
  });
});
