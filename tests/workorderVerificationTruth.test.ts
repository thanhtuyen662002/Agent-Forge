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
import {
  ExecutionAuthorizationService,
  computeCanonicalPayload,
  computePayloadHash,
  CanonicalExecutionPayloadSchema,
  VerificationCommandSnapshotSchema,
  VerificationCommandsSnapshotSchema,
} from '../src/core/services/ExecutionAuthorizationService';
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
      acceptanceCriteria: ['Must render node verify.js', 'Must not invent defaults'],
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
  // PR15 RETENTION TESTS
  // =========================================================================

  it('PR15-1. Legacy WorkOrder uses durable project verification truth without invented npm defaults', () => {
    repo.setProjectVerificationCommands(testProjectId, {
      TEST: { executable: 'node', args: ['verify.js'] },
      LINT: null,
      BUILD: null,
    });

    const workOrder = PackageGenerator.generateWorkOrder(testProject, testTask, repo);

    expect(workOrder).toContain('- **Test**: `node verify.js`');
    expect(workOrder).toContain('- **Lint**: Not configured');
    expect(workOrder).toContain('- **Build**: Not configured');
    expect(workOrder).not.toContain('`npm test`');
    expect(workOrder).not.toContain('`npm run lint`');
    expect(workOrder).not.toContain('`npm run build`');
  });

  it('PR15-2. Legacy WorkOrder cross-project isolation: Project A command never leaks to Project B', () => {
    repo.setProjectVerificationCommands(testProjectId, {
      TEST: { executable: 'node', args: ['verify.js'] },
    });

    const projBId = 'PROJ-TEST-002';
    const projB: Project = {
      id: projBId,
      name: 'Project B',
      description: 'Project B',
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
      title: 'Task B',
      description: 'Task B description',
      priority: 'MEDIUM',
      risk: 'LOW',
      acceptanceCriteria: [],
      constraints: [],
    });

    repo.setProjectVerificationCommands(projBId, {
      TEST: { executable: 'python', args: ['run_tests.py'] },
    });

    const woA = PackageGenerator.generateWorkOrder(testProject, testTask, repo);
    const woB = PackageGenerator.generateWorkOrder(projB, taskB, repo);

    expect(woA).toContain('- **Test**: `node verify.js`');
    expect(woA).not.toContain('run_tests.py');

    expect(woB).toContain('- **Test**: `python run_tests.py`');
    expect(woB).not.toContain('verify.js');
  });

  it('PR15-3. Disabled verification commands render Not configured for both authorized and legacy paths', async () => {
    db.prepare(`
      INSERT INTO verification_commands (id, project_id, name, command_type, executable, args_json, timeout_ms, enabled)
      VALUES (?, ?, ?, ?, ?, ?, 60000, 0)
    `).run('vc-disabled-1', testProjectId, 'Disabled Test', 'TEST', 'pytest', JSON.stringify(['-v']));

    const legacyWO = PackageGenerator.generateWorkOrder(testProject, testTask, repo);
    expect(legacyWO).toContain('- **Test**: Not configured');

    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const authWO = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);
    expect(authWO).toContain('- **Test**: Not configured');
  });

  it('PR15-4. Completely unconfigured project: TEST, LINT, and BUILD all render Not configured', async () => {
    const legacyWO = PackageGenerator.generateWorkOrder(testProject, testTask, repo);
    expect(legacyWO).toContain('- **Test**: Not configured');
    expect(legacyWO).toContain('- **Lint**: Not configured');
    expect(legacyWO).toContain('- **Build**: Not configured');

    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const authWO = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);
    expect(authWO).toContain('- **Test**: Not configured');
    expect(authWO).toContain('- **Lint**: Not configured');
    expect(authWO).toContain('- **Build**: Not configured');
  });

  it('PR15-5. Caller-supplied verification override remains impossible: generateWorkOrder requires Repository', () => {
    repo.setProjectVerificationCommands(testProjectId, {
      TEST: { executable: 'node', args: ['verify.js'] },
    });

    // Passing repository renders durable SQLite truth
    const workOrder = PackageGenerator.generateWorkOrder(testProject, testTask, repo);
    expect(workOrder).toContain('- **Test**: `node verify.js`');
  });

  it('PR15-6. Complex and quoted arguments rendering for TEST, LINT, and BUILD across both paths', async () => {
    repo.setProjectVerificationCommands(testProjectId, {
      TEST: { executable: 'node', args: ['--test', 'test suite/integration spec.js', '--filter="all tests"'] },
      LINT: { executable: 'eslint', args: ['--rule', '{"semi": "error"}', 'src/'] },
      BUILD: { executable: 'bash', args: ['-c', 'npm run build --prefix "app frontend"'] },
    });

    const legacyWO = PackageGenerator.generateWorkOrder(testProject, testTask, repo);
    expect(legacyWO).toContain('- **Test**: `node --test "test suite/integration spec.js" \'--filter="all tests"\'`');
    expect(legacyWO).toContain('- **Lint**: `eslint --rule \'{"semi": "error"}\' src/`');
    expect(legacyWO).toContain('- **Build**: `bash -c \'npm run build --prefix "app frontend"\'`');

    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const authWO = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);
    expect(authWO).toContain('- **Test**: `node --test "test suite/integration spec.js" \'--filter="all tests"\'`');
    expect(authWO).toContain('- **Lint**: `eslint --rule \'{"semi": "error"}\' src/`');
    expect(authWO).toContain('- **Build**: `bash -c \'npm run build --prefix "app frontend"\'`');
  });

  // =========================================================================
  // IMMUTABILITY CASES A THROUGH L
  // =========================================================================

  it('CASE A: Authorized WorkOrder reflects durable TEST=node verify.js and unconfigured LINT/BUILD', async () => {
    repo.setProjectVerificationCommands(testProjectId, {
      TEST: { executable: 'node', args: ['verify.js'] },
    });

    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);

    expect(workOrder).toContain('- **Test**: `node verify.js`');
    expect(workOrder).toContain('- **Lint**: Not configured');
    expect(workOrder).toContain('- **Build**: Not configured');
  });

  it('CASE B: Settings mutation after authorization does not alter Authorized WorkOrder (frozen snapshot immutability)', async () => {
    repo.setProjectVerificationCommands(testProjectId, {
      TEST: { executable: 'node', args: ['verify.js'] },
    });

    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);

    // Mutate project verification configuration in SQLite
    repo.setProjectVerificationCommands(testProjectId, {
      TEST: { executable: 'pytest', args: ['-v', 'test_mutated.py'] },
      LINT: { executable: 'eslint', args: ['.'] },
    });

    const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);

    // Must STILL render frozen node verify.js
    expect(workOrder).toContain('- **Test**: `node verify.js`');
    expect(workOrder).not.toContain('pytest');
    expect(workOrder).not.toContain('test_mutated.py');
    expect(workOrder).toContain('- **Lint**: Not configured');
    expect(workOrder).not.toContain('eslint');
  });

  it('CASE C: Multiple generations of Authorized WorkOrder from the same authorization are byte-for-byte identical', async () => {
    repo.setProjectVerificationCommands(testProjectId, {
      TEST: { executable: 'node', args: ['verify.js'] },
    });

    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);

    const workOrder1 = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const workOrder2 = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);

    expect(workOrder1).toBe(workOrder2);
  });

  it('CASE D: Authorized WorkOrder does not contain fabricated file claim src/example.ts', async () => {
    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);

    expect(workOrder).not.toContain('src/example.ts');
  });

  it('CASE E: Authorized WorkOrder response template does not contain pre-populated success claims', async () => {
    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);

    expect(workOrder).not.toContain('npm test: all tests passing');
    expect(workOrder).not.toContain('Summary of what was implemented');
  });

  it('CASE F: Response template contains truthful empty default arrays', async () => {
    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);

    expect(workOrder).toContain('"completed": []');
    expect(workOrder).toContain('"remaining": []');
    expect(workOrder).toContain('"files_claimed_changed": []');
    expect(workOrder).toContain('"tests_claimed": []');
    expect(workOrder).toContain('"blockers": []');
  });

  it('CASE G: Tampered verification snapshot inside canonical_payload_json fails closed', async () => {
    repo.setProjectVerificationCommands(testProjectId, {
      TEST: { executable: 'node', args: ['verify.js'] },
    });

    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const auth = repo.getExecutionAuthorization(authId)!;

    const payload = JSON.parse(auth.canonical_payload_json!);
    payload.verificationCommands.TEST = { executable: 'malicious_runner', args: ['--hack'] };

    db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ? WHERE id = ?').run(
      JSON.stringify(payload),
      auth.id
    );

    expect(() => {
      PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
    }).toThrow(/EXECUTION_AUTHORIZATION_TAMPERED: Instruction payload hash mismatch/);
  });

  it('CASE H: Cross-project isolation ensures Project A verification command is never leaked into Project B WorkOrder', async () => {
    repo.setProjectVerificationCommands(testProjectId, {
      TEST: { executable: 'node', args: ['verify.js'] },
    });

    const projBId = 'PROJ-TEST-002';
    const projB: Project = {
      id: projBId,
      name: 'Project B',
      description: 'Project B',
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
      title: 'Task B',
      description: 'Task B description',
      priority: 'MEDIUM',
      risk: 'LOW',
      acceptanceCriteria: ['Project B criterion'],
      constraints: [],
    });

    repo.setProjectVerificationCommands(projBId, {
      TEST: { executable: 'python', args: ['run_tests.py'] },
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

  it('CASE I: Disabled verification commands are frozen as null and rendered as Not configured', async () => {
    db.prepare(`
      INSERT INTO verification_commands (id, project_id, name, command_type, executable, args_json, timeout_ms, enabled)
      VALUES (?, ?, ?, ?, ?, ?, 60000, 0)
    `).run('vc-disabled-test', testProjectId, 'Disabled Test', 'TEST', 'pytest', JSON.stringify(['-v']));

    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const auth = repo.getExecutionAuthorization(authId)!;
    const parsedPayload = JSON.parse(auth.canonical_payload_json!);

    expect(parsedPayload.verificationCommands.TEST).toBeNull();

    const authWorkOrder = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);
    expect(authWorkOrder).toContain('- **Test**: Not configured');
    expect(authWorkOrder).not.toContain('pytest');
  });

  it('CASE J: Old authorization missing verificationCommands snapshot fails closed with explicit error', async () => {
    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const auth = repo.getExecutionAuthorization(authId)!;

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

  it('CASE K: Legacy WorkOrder response template has no fabricated claims and is deterministic', async () => {
    repo.setProjectVerificationCommands(testProjectId, {
      TEST: { executable: 'node', args: ['verify.js'] },
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

  it('CASE L: Arguments needing quoting are rendered deterministically and unambiguously', async () => {
    repo.setProjectVerificationCommands(testProjectId, {
      TEST: { executable: 'node', args: ['--test', 'test suite/integration spec.js', '--filter="all tests"'] },
    });

    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const authWorkOrder = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);

    expect(authWorkOrder).toContain('- **Test**: `node --test "test suite/integration spec.js" \'--filter="all tests"\'`');
  });

  // =========================================================================
  // NEW STRICT TAMPER & SCHEMA HARDENING TESTS (CASES M THROUGH R)
  // =========================================================================

  it('CASE M: Nested TEST unknown field causes Authorized WorkOrder generation to fail strict schema validation', async () => {
    repo.setProjectVerificationCommands(testProjectId, {
      TEST: { executable: 'node', args: ['verify.js'] },
    });

    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const auth = repo.getExecutionAuthorization(authId)!;

    const payload = JSON.parse(auth.canonical_payload_json!);
    payload.verificationCommands.TEST.extra = 'malicious_injected_field';

    db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ? WHERE id = ?').run(
      JSON.stringify(payload),
      auth.id
    );

    expect(() => {
      PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
    }).toThrow(/EXECUTION_AUTHORIZATION_CORRUPTED: Invalid canonical_payload_json/);
  });

  it('CASE N: Unknown verification command key causes Authorized WorkOrder generation to fail strict schema validation', async () => {
    repo.setProjectVerificationCommands(testProjectId, {
      TEST: { executable: 'node', args: ['verify.js'] },
    });

    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const auth = repo.getExecutionAuthorization(authId)!;

    const payload = JSON.parse(auth.canonical_payload_json!);
    payload.verificationCommands.EXTRA_COMMAND = { executable: 'injected', args: [] };

    db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ? WHERE id = ?').run(
      JSON.stringify(payload),
      auth.id
    );

    expect(() => {
      PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
    }).toThrow(/EXECUTION_AUTHORIZATION_CORRUPTED: Invalid canonical_payload_json/);
  });

  it('CASE O: Dispatch rejects a canonical payload containing nested unknown field before provider execution and invalidates authorization', async () => {
    repo.updateTaskState(testTaskId, 'PLANNED');
    const managerMsg = {
      protocol: 'manager.v1',
      message_id: `MSG-MGR-STRICT-O`,
      project_id: testProjectId,
      task_id: testTaskId,
      decision: 'EXECUTE',
      expected_task_state: 'PLANNED',
      expected_revision: 0,
      instructions: ['Strict dispatch verification test.'],
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

    // Tamper payload before dispatch with unknown nested field
    const payload = JSON.parse(auth.canonical_payload_json!);
    payload.verificationCommands.TEST = { executable: 'node', args: ['verify.js'], injectedExtraField: 'bad' };

    db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ? WHERE id = ?').run(
      JSON.stringify(payload),
      auth.id
    );

    const dispatchResult = await dispatchService.dispatch(auth.id);

    expect(dispatchResult.status).toBe('FAILED');
    expect(dispatchResult.error).toContain('EXECUTION_AUTHORIZATION_PAYLOAD_CORRUPT');

    const updatedAuth = repo.getExecutionAuthorization(auth.id);
    expect(updatedAuth!.status).toBe('INVALIDATED');
  });

  it('CASE P: computeCanonicalPayload strictly requires verificationCommands parameter (schema validation contract)', () => {
    const explicitPayload = computeCanonicalPayload({
      projectId: testProjectId,
      taskId: testTaskId,
      attemptId: null,
      taskTitle: 'Title',
      taskDescription: 'Desc',
      acceptanceCriteria: ['AC1'],
      constraints: ['C1'],
      instructions: ['Inst1'],
      contextFiles: ['README.md'],
      verificationCommands: {
        TEST: { executable: 'node', args: ['verify.js'] },
        LINT: null,
        BUILD: null,
      },
      managerMessageId: 'msg-mgr-1',
      managerPayloadHash: 'hash-mgr-1',
    });

    expect(explicitPayload.verificationCommands.TEST).toEqual({
      executable: 'node',
      args: ['verify.js'],
    });
    expect(explicitPayload.verificationCommands.LINT).toBeNull();
    expect(explicitPayload.verificationCommands.BUILD).toBeNull();
  });

  it('CASE Q: Old authorization missing verificationCommands snapshot fails closed under CanonicalExecutionPayloadSchema', () => {
    const rawOldPayload = {
      projectId: testProjectId,
      taskId: testTaskId,
      attemptId: null,
      taskTitle: 'Title',
      taskDescription: 'Desc',
      acceptanceCriteria: ['AC1'],
      constraints: ['C1'],
      instructions: ['Inst1'],
      contextFiles: ['README.md'],
      managerMessageId: 'msg-mgr-1',
      managerPayloadHash: 'hash-mgr-1',
    };

    const parseResult = CanonicalExecutionPayloadSchema.safeParse(rawOldPayload);
    expect(parseResult.success).toBe(false);
  });

  it('CASE R: Explicit all-null verification snapshot is valid for a genuinely unconfigured project', () => {
    const unconfiguredPayload = computeCanonicalPayload({
      projectId: testProjectId,
      taskId: testTaskId,
      attemptId: null,
      taskTitle: 'Unconfigured Project Task',
      taskDescription: 'No verification configured',
      acceptanceCriteria: [],
      constraints: [],
      instructions: ['Do work'],
      contextFiles: [],
      verificationCommands: {
        TEST: null,
        LINT: null,
        BUILD: null,
      },
      managerMessageId: 'msg-mgr-2',
      managerPayloadHash: 'hash-mgr-2',
    });

    const parseResult = CanonicalExecutionPayloadSchema.safeParse(unconfiguredPayload);
    expect(parseResult.success).toBe(true);
    if (parseResult.success) {
      expect(parseResult.data.verificationCommands).toEqual({
        TEST: null,
        LINT: null,
        BUILD: null,
      });
    }
  });

  it('CASE S: Tampered surrounding whitespace in verificationCommands.TEST.executable fails closed for Authorized WorkOrder generation', async () => {
    repo.setProjectVerificationCommands(testProjectId, {
      TEST: { executable: 'node', args: ['verify.js'] },
    });

    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const auth = repo.getExecutionAuthorization(authId)!;

    const payload = JSON.parse(auth.canonical_payload_json!);
    payload.verificationCommands.TEST.executable = ' node ';

    db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ? WHERE id = ?').run(
      JSON.stringify(payload),
      auth.id
    );

    expect(() => {
      PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
    }).toThrow(/EXECUTION_AUTHORIZATION_CORRUPTED: Invalid canonical_payload_json/);
  });

  it('CASE T: Tampered surrounding whitespace in verificationCommands.TEST.executable fails closed at dispatch, invalidating authorization without reaching provider', async () => {
    repo.updateTaskState(testTaskId, 'PLANNED');
    const managerMsg = {
      protocol: 'manager.v1',
      message_id: `MSG-MGR-STRICT-T`,
      project_id: testProjectId,
      task_id: testTaskId,
      decision: 'EXECUTE',
      expected_task_state: 'PLANNED',
      expected_revision: 0,
      instructions: ['Strict dispatch whitespace test.'],
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

    // Tamper executable with surrounding whitespace
    const payload = JSON.parse(auth.canonical_payload_json!);
    payload.verificationCommands.TEST = { executable: ' node ', args: ['verify.js'] };

    db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ? WHERE id = ?').run(
      JSON.stringify(payload),
      auth.id
    );

    const dispatchResult = await dispatchService.dispatch(auth.id);

    expect(dispatchResult.status).toBe('FAILED');
    expect(dispatchResult.error).toContain('EXECUTION_AUTHORIZATION_PAYLOAD_CORRUPT');

    const updatedAuth = repo.getExecutionAuthorization(auth.id);
    expect(updatedAuth!.status).toBe('INVALIDATED');
  });

  it('CASE U: Canonical valid executable ("node") with args (["verify.js"]) passes authorization, dispatch, and deterministic WorkOrder generation', async () => {
    repo.setProjectVerificationCommands(testProjectId, {
      TEST: { executable: 'node', args: ['verify.js'] },
    });

    const authId = await createAndDispatchManualHandoff(testProjectId, testTaskId);
    const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);

    expect(workOrder).toContain('- **Test**: `node verify.js`');
  });

  it('CASE V: Whitespace-only or empty executable cannot pass VerificationCommandSnapshotSchema', () => {
    expect(VerificationCommandSnapshotSchema.safeParse({ executable: '', args: [] }).success).toBe(false);
    expect(VerificationCommandSnapshotSchema.safeParse({ executable: ' ', args: [] }).success).toBe(false);
    expect(VerificationCommandSnapshotSchema.safeParse({ executable: '   ', args: [] }).success).toBe(false);
    expect(VerificationCommandSnapshotSchema.safeParse({ executable: 'node', args: [] }).success).toBe(true);
  });

  it('CASE W: Top-level unknown field in canonical payload fails closed under CanonicalExecutionPayloadSchema', () => {
    const payloadWithUnknown = {
      projectId: testProjectId,
      taskId: testTaskId,
      attemptId: null,
      taskTitle: 'Title',
      taskDescription: 'Desc',
      acceptanceCriteria: ['AC1'],
      constraints: ['C1'],
      instructions: ['Inst1'],
      contextFiles: ['README.md'],
      verificationCommands: {
        TEST: { executable: 'node', args: ['verify.js'] },
        LINT: null,
        BUILD: null,
      },
      managerMessageId: 'msg-mgr-1',
      managerPayloadHash: 'hash-mgr-1',
      extraTopLevelField: 'injected',
    };

    const parseResult = CanonicalExecutionPayloadSchema.safeParse(payloadWithUnknown);
    expect(parseResult.success).toBe(false);
  });
});
