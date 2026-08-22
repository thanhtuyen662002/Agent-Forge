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

describe('WorkOrder Verification Guidance Truthfulness & Immutability Hardening', () => {
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
  // CASE A: Frozen TEST truth (Authorized WorkOrder shows exact TEST and unconfigured LINT/BUILD)
  // =========================================================================
  it('CASE A: Authorized WorkOrder reflects durable TEST=node verify.js and unconfigured LINT/BUILD without invented npm defaults', async () => {
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

    expect(workOrder).toContain('- **Test**: `node verify.js`');
    expect(workOrder).toContain('- **Lint**: Not configured');
    expect(workOrder).toContain('- **Build**: Not configured');

    expect(workOrder).not.toContain('`npm test`');
    expect(workOrder).not.toContain('`npm run lint`');
    expect(workOrder).not.toContain('`npm run build`');
    expect(workOrder).not.toContain('npm run lint');
    expect(workOrder).not.toContain('npm run build');
  });

  // =========================================================================
  // CASE B: Settings mutation after authorization does NOT alter Authorized WorkOrder
  // =========================================================================
  it('CASE B: Settings mutation after authorization does not alter Authorized WorkOrder (frozen snapshot immutability)', async () => {
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

    // Now mutate project verification configuration in SQLite using official repo method
    repo.setProjectVerificationCommands(testProjectId, {
      TEST: {
        executable: 'pytest',
        args: ['-v', 'test_mutated.py'],
      },
      LINT: {
        executable: 'eslint',
        args: ['.'],
      },
    });

    const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);

    // Must STILL render frozen node verify.js
    expect(workOrder).toContain('- **Test**: `node verify.js`');
    expect(workOrder).not.toContain('pytest');
    expect(workOrder).not.toContain('test_mutated.py');

    // LINT was added after authorization was created, so frozen snapshot still says Not configured
    expect(workOrder).toContain('- **Lint**: Not configured');
    expect(workOrder).not.toContain('eslint');
  });

  // =========================================================================
  // CASE C: Deterministic regeneration (byte-identical)
  // =========================================================================
  it('CASE C: Multiple generations of Authorized WorkOrder from the same authorization are byte-for-byte identical', async () => {
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

    const workOrder1 = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);
    // Introduce artificial delay
    await new Promise((resolve) => setTimeout(resolve, 50));
    const workOrder2 = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);

    expect(workOrder1).toBe(workOrder2);
  });

  // =========================================================================
  // CASE D: No fabricated file claim
  // =========================================================================
  it('CASE D: Authorized WorkOrder does not contain fabricated file claim src/example.ts', async () => {
    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);

    expect(workOrder).not.toContain('src/example.ts');
  });

  // =========================================================================
  // CASE E: No fabricated test claim in response template
  // =========================================================================
  it('CASE E: Authorized WorkOrder response template does not contain pre-populated success claims', async () => {
    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);

    expect(workOrder).not.toContain('npm test: all tests passing');
    expect(workOrder).not.toContain('Summary of what was implemented');
  });

  // =========================================================================
  // CASE F: Safe empty claim arrays in JSON response template
  // =========================================================================
  it('CASE F: Response template contains truthful empty default arrays', async () => {
    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);

    expect(workOrder).toContain('"completed": []');
    expect(workOrder).toContain('"remaining": []');
    expect(workOrder).toContain('"files_claimed_changed": []');
    expect(workOrder).toContain('"tests_claimed": []');
    expect(workOrder).toContain('"blockers": []');
  });

  // =========================================================================
  // CASE G: Tampered verification snapshot fails closed
  // =========================================================================
  it('CASE G: Tampered verification snapshot inside canonical_payload_json fails closed', async () => {
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
    const auth = repo.getExecutionAuthorization(authId)!;

    const payload = JSON.parse(auth.canonical_payload_json!);
    // Tamper verificationCommands inside canonical_payload_json
    payload.verificationCommands.TEST = { executable: 'malicious_runner', args: ['--hack'] };

    db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ? WHERE id = ?').run(
      JSON.stringify(payload),
      auth.id
    );

    expect(() => {
      PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
    }).toThrow(/EXECUTION_AUTHORIZATION_TAMPERED: Instruction payload hash mismatch/);
  });

  // =========================================================================
  // CASE H: Cross-project isolation between Project A and Project B
  // =========================================================================
  it('CASE H: Cross-project isolation ensures Project A verification command is never leaked into Project B WorkOrder', async () => {
    repo.createVerificationCommand({
      id: 'vc-proj-a',
      project_id: testProjectId,
      name: 'Project A Tests',
      command_type: 'TEST',
      executable: 'node',
      args: ['verify.js'],
      enabled: true,
    });

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

    const authAId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const authBId = await createAndDispatchManualHandoff(projBId, taskB.id);

    const workOrderA = PackageGenerator.generateAuthorizedManualWorkOrder(authAId, repo);
    const workOrderB = PackageGenerator.generateAuthorizedManualWorkOrder(authBId, repo);

    expect(workOrderA).toContain('- **Test**: `node verify.js`');
    expect(workOrderA).not.toContain('run_tests.py');

    expect(workOrderB).toContain('- **Test**: `python run_tests.py`');
    expect(workOrderB).not.toContain('verify.js');
  });

  // =========================================================================
  // CASE I: Disabled verification commands become null / Not configured
  // =========================================================================
  it('CASE I: Disabled verification commands are frozen as null and rendered as Not configured', async () => {
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
    const auth = repo.getExecutionAuthorization(authId)!;
    const parsedPayload = JSON.parse(auth.canonical_payload_json!);

    expect(parsedPayload.verificationCommands.TEST).toBeNull();

    const authWorkOrder = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);
    expect(authWorkOrder).toContain('- **Test**: Not configured');
    expect(authWorkOrder).not.toContain('pytest');
  });

  // =========================================================================
  // CASE J: Old authorization without verificationCommands snapshot fails closed
  // =========================================================================
  it('CASE J: Old authorization missing verificationCommands snapshot fails closed with explicit error', async () => {
    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const auth = repo.getExecutionAuthorization(authId)!;

    // Simulate old pre-snapshot payload
    const legacyPayload = JSON.parse(auth.canonical_payload_json!);
    delete legacyPayload.verificationCommands;

    db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ? WHERE id = ?').run(
      JSON.stringify(legacyPayload),
      auth.id
    );

    expect(() => {
      PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
    }).toThrow(/AUTHORIZED_WORKORDER_VERIFICATION_SNAPSHOT_MISSING/);
  });

  // =========================================================================
  // CASE K: Legacy WorkOrder template is truthful and deterministic
  // =========================================================================
  it('CASE K: Legacy WorkOrder response template has no fabricated claims and is deterministic', async () => {
    repo.createVerificationCommand({
      id: 'vc-test-01',
      project_id: testProjectId,
      name: 'Test Suite',
      command_type: 'TEST',
      executable: 'node',
      args: ['verify.js'],
      enabled: true,
    });

    const legacyWO1 = PackageGenerator.generateWorkOrder(testProject, testTask, repo);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const legacyWO2 = PackageGenerator.generateWorkOrder(testProject, testTask, repo);

    expect(legacyWO1).toBe(legacyWO2);
    expect(legacyWO1).not.toContain('src/example.ts');
    expect(legacyWO1).not.toContain('npm test: all tests passing');
    expect(legacyWO1).not.toContain('Summary of what was implemented');
    expect(legacyWO1).toContain('"files_claimed_changed": []');
    expect(legacyWO1).toContain('"tests_claimed": []');
    expect(legacyWO1).toContain(`"message_id": "msg-cdr-${testTask.id}-rev${testTask.revision_count}"`);
  });

  // =========================================================================
  // CASE L: Arguments needing quoting are rendered deterministically/unambiguously
  // =========================================================================
  it('CASE L: Arguments needing quoting (spaces, quotes, flags) are rendered deterministically and unambiguously', async () => {
    repo.createVerificationCommand({
      id: 'vc-quoted-test',
      project_id: testProjectId,
      name: 'Quoted Args Test',
      command_type: 'TEST',
      executable: 'node',
      args: ['--test', 'test suite/integration spec.js', '--filter="all tests"'],
      enabled: true,
    });

    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const authWorkOrder = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);

    expect(authWorkOrder).toContain('- **Test**: `node --test "test suite/integration spec.js" \'--filter="all tests"\'`');
  });
});
