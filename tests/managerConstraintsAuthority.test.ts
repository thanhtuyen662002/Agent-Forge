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
} from '../src/core/services/ExecutionAuthorizationService';
import { ProviderDispatchService } from '../src/core/services/ProviderDispatchService';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import { VerificationService } from '../src/core/services/VerificationService';
import { PackageGenerator } from '../src/core/protocol/packageGenerator';
import { Project, Task } from '../src/core/types/domain';

describe('Manager Constraints Authority Binding to ExecutionAuthorization and WorkOrder', () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-mgr-constraints-test-'));
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

    testProjectId = 'PROJ-CONSTRAINTS-001';
    testProject = {
      id: testProjectId,
      name: 'Manager Constraints Test Project',
      description: 'Testing manager constraints authority propagation',
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
      title: 'Manager Constraints Task',
      description: 'Validate manager constraints survival into WorkOrder',
      priority: 'HIGH',
      risk: 'LOW',
      acceptanceCriteria: ['AC 1'],
      constraints: [],
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

  async function createAndDispatchWithManager(
    projectId: string,
    taskId: string,
    managerConstraints: string[] = [],
    managerInstructions: string[] = ['Implement feature.'],
    taskConstraints?: string[]
  ): Promise<string> {
    if (taskConstraints) {
      db.prepare('UPDATE tasks SET constraints_json = ? WHERE id = ?').run(
        JSON.stringify(taskConstraints),
        taskId
      );
    }
    repo.updateTaskState(taskId, 'PLANNED');
    const managerMsg = {
      protocol: 'manager.v1',
      message_id: `MSG-MGR-${crypto.randomUUID()}`,
      project_id: projectId,
      task_id: taskId,
      decision: 'EXECUTE',
      expected_task_state: 'PLANNED',
      expected_revision: 0,
      instructions: managerInstructions,
      constraints: managerConstraints,
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

  it('CASE A: Manager constraints survive into canonical payload and Authorized WorkOrder when task constraints empty', async () => {
    const managerConstraints = [
      'Only modify src/index.ts',
      'Do not change dependencies in package.json',
      'No network access during tests',
    ];

    const authId = await createAndDispatchWithManager(testProjectId, testTaskId, managerConstraints);
    const auth = repo.getExecutionAuthorization(authId)!;

    const payload = JSON.parse(auth.canonical_payload_json!);
    expect(payload.constraints).toEqual(managerConstraints);

    const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);

    expect(workOrder).toContain('## Authorized Constraints');
    for (const c of managerConstraints) {
      expect(workOrder).toContain(`- ${c}`);
    }
  });

  it('CASE B: Task constraints followed by Manager constraints are merged into effective constraints in exact order', async () => {
    const taskConstraints = ['task constraint 1', 'task constraint 2'];
    const managerConstraints = ['manager constraint 1', 'manager constraint 2'];

    const authId = await createAndDispatchWithManager(
      testProjectId,
      testTaskId,
      managerConstraints,
      ['Execute task.'],
      taskConstraints
    );

    const auth = repo.getExecutionAuthorization(authId)!;
    const payload = JSON.parse(auth.canonical_payload_json!);

    expect(payload.constraints).toEqual([
      'task constraint 1',
      'task constraint 2',
      'manager constraint 1',
      'manager constraint 2',
    ]);

    const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);
    expect(workOrder).toContain('## Authorized Constraints');
    expect(workOrder).toContain('- task constraint 1');
    expect(workOrder).toContain('- task constraint 2');
    expect(workOrder).toContain('- manager constraint 1');
    expect(workOrder).toContain('- manager constraint 2');
  });

  it('CASE C: Empty Manager constraints preserve existing Task-only behavior', async () => {
    const taskConstraints = ['pre-existing task constraint'];
    const authId = await createAndDispatchWithManager(
      testProjectId,
      testTaskId,
      [],
      ['Execute task.'],
      taskConstraints
    );

    const auth = repo.getExecutionAuthorization(authId)!;
    const payload = JSON.parse(auth.canonical_payload_json!);

    expect(payload.constraints).toEqual(['pre-existing task constraint']);

    const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);
    expect(workOrder).toContain('## Authorized Constraints');
    expect(workOrder).toContain('- pre-existing task constraint');
  });

  it('CASE D: Changing effective constraints produces different instruction_payload_hash values', () => {
    const baseParams = {
      projectId: testProjectId,
      taskId: testTaskId,
      attemptId: null,
      taskTitle: 'Title',
      taskDescription: 'Desc',
      acceptanceCriteria: ['AC1'],
      instructions: ['Inst1'],
      contextFiles: ['README.md'],
      verificationCommands: { TEST: null, LINT: null, BUILD: null },
      managerMessageId: 'msg-mgr-1',
      managerPayloadHash: 'hash-mgr-1',
    };

    const payload1 = computeCanonicalPayload({
      ...baseParams,
      constraints: ['Constraint A'],
    });

    const payload2 = computeCanonicalPayload({
      ...baseParams,
      constraints: ['Constraint B'],
    });

    const hash1 = computePayloadHash(payload1);
    const hash2 = computePayloadHash(payload2);

    expect(hash1).not.toBe(hash2);
  });

  it('CASE E: Mutating live task or manager records after authorization does not alter frozen constraints in Authorized WorkOrder', async () => {
    const managerConstraints = ['Frozen manager constraint'];
    const authId = await createAndDispatchWithManager(testProjectId, testTaskId, managerConstraints);

    // Mutate live task in SQLite
    db.prepare('UPDATE tasks SET constraints_json = ? WHERE id = ?').run(
      JSON.stringify(['Mutated post-authorization task constraint']),
      testTaskId
    );

    const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);

    expect(workOrder).toContain('- Frozen manager constraint');
    expect(workOrder).not.toContain('Mutated post-authorization task constraint');
  });

  it('CASE F: Tampered constraints inside canonical_payload_json fail closed for both WorkOrder generation and dispatch', async () => {
    repo.setProjectVerificationCommands(testProjectId, {
      TEST: { executable: 'node', args: ['verify.js'] },
    });

    repo.updateTaskState(testTaskId, 'PLANNED');
    const managerMsg = {
      protocol: 'manager.v1',
      message_id: `MSG-MGR-TAMPER-F`,
      project_id: testProjectId,
      task_id: testTaskId,
      decision: 'EXECUTE',
      expected_task_state: 'PLANNED',
      expected_revision: 0,
      instructions: ['Tamper test instructions.'],
      constraints: ['Original constraint'],
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

    // 1. Dispatch before tamper
    await dispatchService.dispatch(auth.id);

    // 2. Tamper constraints in canonical_payload_json without updating instruction_payload_hash
    const payload = JSON.parse(auth.canonical_payload_json!);
    payload.constraints = ['Malicious injected constraint'];

    db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ? WHERE id = ?').run(
      JSON.stringify(payload),
      auth.id
    );

    expect(() => {
      PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
    }).toThrow(/EXECUTION_AUTHORIZATION_TAMPERED: Instruction payload hash mismatch/);

    // 3. Test that dispatch also fails closed on tampered constraints
    const freshAuth = await authorizationService.createAuthorization({
      projectId: testProjectId,
      taskId: testTaskId,
      routingDecisionId: routingDecision.decisionId,
      contextFiles: ['README.md'],
    });

    const freshPayload = JSON.parse(freshAuth.canonical_payload_json!);
    freshPayload.constraints = ['Tampered before dispatch'];

    db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ? WHERE id = ?').run(
      JSON.stringify(freshPayload),
      freshAuth.id
    );

    const dispatchResult = await dispatchService.dispatch(freshAuth.id);
    expect(dispatchResult.status).toBe('FAILED');
    expect(dispatchResult.error).toContain('EXECUTION_AUTHORIZATION_HASH_MISMATCH');

    const updatedAuth = repo.getExecutionAuthorization(freshAuth.id);
    expect(updatedAuth!.status).toBe('INVALIDATED');
  });

  it('CASE G: Multiple generations of Authorized WorkOrder from the same authorization are byte-for-byte deterministic', async () => {
    const managerConstraints = ['Deterministic constraint 1', 'Deterministic constraint 2'];
    const authId = await createAndDispatchWithManager(testProjectId, testTaskId, managerConstraints);

    const wo1 = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const wo2 = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);

    expect(wo1).toBe(wo2);
  });

  it('CASE H: Exact B2 regression with 4 Manager constraints and verification snapshot', async () => {
    repo.setProjectVerificationCommands(testProjectId, {
      TEST: { executable: 'node', args: ['verify.js'] },
      LINT: null,
      BUILD: null,
    });

    const b2ManagerConstraints = [
      'Only sum.js may be modified.',
      'Do not modify verify.js or README.md.',
      'Do not add dependencies or package files.',
      'Do not rewrite Git history or alter the frozen baseline commit.',
    ];

    const authId = await createAndDispatchWithManager(
      testProjectId,
      testTaskId,
      b2ManagerConstraints,
      ['Fix subtraction bug in sum.js so verify.js passes.']
    );

    const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(authId, repo);

    // All 4 Manager constraints appear in the Authorized Constraints section
    expect(workOrder).toContain('## Authorized Constraints');
    expect(workOrder).toContain('- Only sum.js may be modified.');
    expect(workOrder).toContain('- Do not modify verify.js or README.md.');
    expect(workOrder).toContain('- Do not add dependencies or package files.');
    expect(workOrder).toContain('- Do not rewrite Git history or alter the frozen baseline commit.');

    // Verification guidance reflects truthful durable SQLite commands
    expect(workOrder).toContain('- **Test**: `node verify.js`');
    expect(workOrder).toContain('- **Lint**: Not configured');
    expect(workOrder).toContain('- **Build**: Not configured');
  });
});
