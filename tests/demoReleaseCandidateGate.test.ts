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
import { ProviderRoutingService } from '../src/core/services/ProviderRoutingService';
import {
  ExecutionAuthorizationService,
  computeCanonicalPayload,
  computePayloadHash,
  computeContextManifestHash,
} from '../src/core/services/ExecutionAuthorizationService';
import { ProviderDispatchService } from '../src/core/services/ProviderDispatchService';
import { PackageGenerator } from '../src/core/protocol/packageGenerator';
import { ProtocolParser } from '../src/core/protocol/parser';
import { UpdateService } from '../src/core/services/UpdateService';
import { ProjectContract } from '../src/core/types/domain';
import { ManagerProtocol, CoderProtocol } from '../src/core/types/protocols';

describe('PR #10 — AgentForge Demo & Release Candidate Gate Contract Tests', () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-rc-gate-'));
    dbDir = path.join(tempDir, 'db');
    artifactsDir = path.join(tempDir, 'artifacts');
    gitRepoDir = path.join(tempDir, 'repo');

    fs.mkdirSync(dbDir, { recursive: true });
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.mkdirSync(gitRepoDir, { recursive: true });

    // Initialize real temporary Git repository
    execSync('git init', { cwd: gitRepoDir });
    execSync('git config user.name "RC Gate Test"', { cwd: gitRepoDir });
    execSync('git config user.email "rc-gate@agentforge.local"', { cwd: gitRepoDir });

    const featureFile = path.join(gitRepoDir, 'feature.js');
    fs.writeFileSync(featureFile, 'module.exports = { value: 1 };\n', 'utf8');

    const testScript = path.join(gitRepoDir, 'run_tests.js');
    fs.writeFileSync(
      testScript,
      'const f = require("./feature.js"); if (f.value === 42) { console.log("2 tests passed cleanly"); process.exit(0); } else { console.error("Assertion failed: expected 42"); process.exit(1); }',
      'utf8'
    );

    execSync('git add .', { cwd: gitRepoDir });
    execSync('git commit -m "chore: initial commit"', { cwd: gitRepoDir });
    initialGitSha = execSync('git rev-parse HEAD', { cwd: gitRepoDir }).toString().trim();

    // Initialize real SQLite database with all 7 durable migrations
    const dbPath = path.join(dbDir, 'agent-forge.db');
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    MigrationRunner.run(db);

    repo = new Repository(db);
    eventService = new EventService(repo);
    artifactStore = new ArtifactStore(artifactsDir);
    projectService = new ProjectService(repo, eventService);
    verificationService = new VerificationService(repo, artifactStore);
    taskService = new TaskService(repo, eventService, verificationService, artifactStore);
    emergencyStopService = new EmergencyStopService(repo, eventService);

    providerRegistry = new ProviderRegistry();
    const manualBridgeAdapter = new ManualBridgeAdapter();
    const codexCliAdapter = new CodexCliAdapter({ repo, artifactStore });
    providerRegistry.register(manualBridgeAdapter);
    providerRegistry.register(codexCliAdapter);

    routingService = new ProviderRoutingService(repo, providerRegistry, eventService);
    authorizationService = new ExecutionAuthorizationService(repo, eventService);
    dispatchService = new ProviderDispatchService(providerRegistry, repo, eventService);

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

    // Create real Project and Task
    const project = projectService.createProject(
      'Demo RC Project',
      'Windows Demo Release Candidate Verification',
      gitRepoDir,
      'main'
    );
    testProjectId = project.id;

    const contract: ProjectContract = {
      goal: 'Update feature value to 42 and pass test suite',
      business_context: 'Core product requirement for demo readiness',
      architecture_constraints: ['No arbitrary shell execution'],
      technical_constraints: [],
      security_requirements: ['Strict policy validation'],
      acceptance_criteria: ['Feature returns 42', 'run_tests.js passes with exit code 0'],
      non_goals: [],
      definition_of_done: ['Automated test suite passes'],
      testing_requirements: ['node run_tests.js must succeed'],
      owner_policies: [],
    };
    projectService.importContract(testProjectId, contract);

    const task = taskService.createTask({
      projectId: testProjectId,
      title: 'RC-DEMO-001',
      description: 'Implement feature value 42 update',
    });
    testTaskId = task.id;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // Helper to establish valid manager EXECUTE authority and move task to CODING
  async function applyExecuteDecision(taskId: string): Promise<void> {
    repo.updateTaskState(taskId, 'PLANNED');
    const managerDecision: ManagerProtocol = {
      protocol: 'manager.v1',
      message_id: crypto.randomUUID(),
      project_id: testProjectId,
      task_id: taskId,
      decision: 'EXECUTE',
      priority: 'MEDIUM',
      risk: 'LOW',
      instructions: ['Update feature.js to return { value: 42 } so run_tests.js passes.'],
      acceptance_criteria: ['Feature returns 42'],
      constraints: [],
      review_issues: [],
      expected_task_state: 'PLANNED',
      expected_revision: 0,
    };
    const res = await taskService.applyManagerDecision(managerDecision, JSON.stringify(managerDecision));
    expect(res.success).toBe(true);
  }

  // =========================================================================
  // Section 5: Real Core Services Demo E2E Happy Path Flow
  // =========================================================================
  it('should execute the full real core services Owner demo lifecycle without shortcuts using authorized manual handoff', async () => {
    // 1. Advance task to PLANNED then apply Manager decision (manager.v1) -> moves task to CODING
    await applyExecuteDecision(testTaskId);

    const taskAfterManager = repo.getTask(testTaskId)!;
    expect(taskAfterManager.state).toBe('CODING');

    // 2. Owner explicitly selects candidate: Manual Bridge
    const routeDecision = await routingService.route({
      projectId: testProjectId,
      taskId: testTaskId,
      candidateResourceIds: ['res-gemini-coder'],
      allowManualBridge: true,
      requiredCapabilities: ['CODING'],
    });
    expect(routeDecision.outcome).toBe('MANUAL_HANDOFF_REQUIRED');
    expect(routeDecision.selectedResourceId).toBe('res-gemini-coder');

    // 3. Durable routing event recorded in SQLite
    const routingEvents = repo.getEvents(testProjectId).filter((e) => e.type === 'PROVIDER_ROUTING_DECISION');
    expect(routingEvents.length).toBe(1);
    expect(routingEvents[0].structured_payload.outcome).toBe('MANUAL_HANDOFF_REQUIRED');

    // 4. Create Execution Authorization from durable decision -> Status AUTHORIZED
    const auth = await authorizationService.createAuthorization({
      projectId: testProjectId,
      taskId: testTaskId,
      routingDecisionId: routeDecision.decisionId,
    });
    expect(auth.id).toBeDefined();
    expect(auth.status).toBe('AUTHORIZED');

    // 5. One-time dispatch -> executes Manual Bridge and returns status AWAITING_OWNER
    const dispatchResult = await dispatchService.dispatch(auth.id);
    expect(dispatchResult.status).toBe('AWAITING_OWNER');
    expect(dispatchResult.executionId).toBeDefined();

    // Verify authorization status is now DISPATCHED in SQLite
    const dispatchedAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(dispatchedAuth.status).toBe('DISPATCHED');
    expect(dispatchedAuth.dispatched_at).toBeDefined();

    // 6. Generate REAL authorization-bound manual WorkOrder (PR #8 API)
    const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
    expect(workOrder).toBeDefined();

    // Assert all required envelope fields and frozen instruction
    expect(workOrder).toContain(auth.id);
    expect(workOrder).toContain(testProjectId);
    expect(workOrder).toContain(testTaskId);
    expect(workOrder).toContain(auth.manager_message_id);
    expect(workOrder).toContain(routeDecision.decisionId);
    expect(workOrder).toContain('res-gemini-coder');
    expect(workOrder).toContain('prov-manual-bridge');
    expect(workOrder).toContain('Update feature.js to return { value: 42 } so run_tests.js passes.');
    expect(workOrder).toContain('coder.v1');

    // 7. Simulate Owner manually updating Git repository with Gemini Coder changes
    const featureFile = path.join(gitRepoDir, 'feature.js');
    fs.writeFileSync(featureFile, 'module.exports = { value: 42 };\n', 'utf8');

    // 8. Owner pastes resulting valid coder.v1 protocol message into Coder Inbox
    const coderReport: CoderProtocol = {
      protocol: 'coder.v1',
      message_id: crypto.randomUUID(),
      project_id: testProjectId,
      task_id: testTaskId,
      attempt: 1,
      status: 'COMPLETED',
      completed: ['Updated feature.js value to 42 as instructed.'],
      remaining: [],
      files_claimed_changed: ['feature.js'],
      tests_claimed: ['node run_tests.js: 2 tests passed cleanly'],
      blockers: [],
      review_requested: true,
      expected_task_state: 'CODING',
      expected_revision: 0,
    };

    const coderApplyResult = taskService.applyCoderReport(
      coderReport,
      JSON.stringify(coderReport)
    );
    expect(coderApplyResult.success).toBe(true);

    const taskAfterCoder = repo.getTask(testTaskId)!;
    expect(taskAfterCoder.state).toBe('VALIDATING');

    // 9. Automated Verification Service executes real Git validation against test script
    const testCmdId = crypto.randomUUID();
    repo.createVerificationCommand({
      id: testCmdId,
      project_id: testProjectId,
      name: 'Test runner check',
      command_type: 'TEST',
      executable: 'node',
      args: ['run_tests.js'],
      enabled: true,
    });

    const valRes = await taskService.executeValidationFlow(testTaskId, testCmdId);
    expect(valRes.success).toBe(true);
    expect(valRes.testRun.exit_code).toBe(0);
    expect(valRes.finalTaskState).toBe('REVIEW_READY');

    const taskAfterValidation = repo.getTask(testTaskId)!;
    expect(taskAfterValidation.state).toBe('REVIEW_READY');

    // 10. Generate review package with authoritative evidence from SQLite
    const latestTestRun = repo.getLatestTestRun(testTaskId);
    const gitDiffEv = repo.getLatestEvidence(testTaskId, 'GIT_DIFF');
    expect(latestTestRun).toBeDefined();
    expect(gitDiffEv).toBeDefined();

    const project = repo.getProject(testProjectId)!;
    const reviewPackage = PackageGenerator.generateReviewPackage(
      project,
      taskAfterValidation,
      coderReport,
      gitDiffEv!.summary || 'Git Diff recorded.',
      artifactStore.read(gitDiffEv!),
      latestTestRun,
      [],
      gitDiffEv!
    );
    expect(reviewPackage).toContain('REVIEW PACKAGE');
    expect(reviewPackage).toContain('RC-DEMO-001');
    expect(reviewPackage).toContain('value: 42');
  });

  // =========================================================================
  // Section 6: Negative E2E Contracts (10 Focused Contract Invariants)
  // =========================================================================

  // Contract 1: Pre-dispatch call to generateAuthorizedManualWorkOrder fails closed
  it('Negative Contract 1: Pre-dispatch generateAuthorizedManualWorkOrder fails closed with EXECUTION_AUTHORIZATION_NOT_DISPATCHED', async () => {
    await applyExecuteDecision(testTaskId);

    const routeDecision = await routingService.route({
      projectId: testProjectId,
      taskId: testTaskId,
      candidateResourceIds: ['res-gemini-coder'],
      allowManualBridge: true,
      requiredCapabilities: ['CODING'],
    });

    const auth = await authorizationService.createAuthorization({
      projectId: testProjectId,
      taskId: testTaskId,
      routingDecisionId: routeDecision.decisionId,
    });
    expect(auth.status).toBe('AUTHORIZED');

    // Calling before dispatch MUST throw EXECUTION_AUTHORIZATION_NOT_DISPATCHED
    expect(() => {
      PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
    }).toThrow(/EXECUTION_AUTHORIZATION_NOT_DISPATCHED/);

    // After dispatch, status is DISPATCHED and call succeeds
    const dispatchResult = await dispatchService.dispatch(auth.id);
    expect(dispatchResult.status).toBe('AWAITING_OWNER');
    expect(repo.getExecutionAuthorization(auth.id)!.status).toBe('DISPATCHED');

    const workOrder = PackageGenerator.generateAuthorizedManualWorkOrder(auth.id, repo);
    expect(workOrder).toBeDefined();
    expect(workOrder).toContain(auth.id);
  });

  // Contract 2: Consumed authorization cannot execute twice
  it('Negative Contract 2: Consumed authorization cannot execute twice (fails closed with EXECUTION_AUTHORIZATION_ALREADY_DISPATCHED)', async () => {
    await applyExecuteDecision(testTaskId);

    const routeDecision = await routingService.route({
      projectId: testProjectId,
      taskId: testTaskId,
      candidateResourceIds: ['res-gemini-coder'],
      allowManualBridge: true,
      requiredCapabilities: ['CODING'],
    });
    const auth = await authorizationService.createAuthorization({
      projectId: testProjectId,
      taskId: testTaskId,
      routingDecisionId: routeDecision.decisionId,
    });

    // First dispatch succeeds
    const dispatch1 = await dispatchService.dispatch(auth.id);
    expect(dispatch1.status).toBe('AWAITING_OWNER');

    // Second dispatch with same auth.id fails closed
    const dispatch2 = await dispatchService.dispatch(auth.id);
    expect(dispatch2.status).toBe('FAILED');
    expect(dispatch2.error).toContain('EXECUTION_AUTHORIZATION_ALREADY_DISPATCHED');
  });

  // Contract 3: Task state mismatch invalidates authorization at dispatch time
  it('Negative Contract 3: Task state mismatch invalidates authorization at dispatch time', async () => {
    await applyExecuteDecision(testTaskId);

    const routeDecision = await routingService.route({
      projectId: testProjectId,
      taskId: testTaskId,
      candidateResourceIds: ['res-gemini-coder'],
      allowManualBridge: true,
      requiredCapabilities: ['CODING'],
    });
    const auth = await authorizationService.createAuthorization({
      projectId: testProjectId,
      taskId: testTaskId,
      routingDecisionId: routeDecision.decisionId,
    });

    // Task state changes before dispatch (e.g. moved to BLOCKED)
    repo.updateTaskState(testTaskId, 'BLOCKED');

    // Dispatch fails closed because task is no longer in CODING
    const dispatch = await dispatchService.dispatch(auth.id);
    expect(dispatch.status).toBe('FAILED');
    expect(dispatch.error).toContain('EXECUTION_AUTHORIZATION_STALE_TASK_STATE');
  });

  // Contract 4: Task revision mutation invalidates stale authority
  it('Negative Contract 4: Task revision mutation invalidates stale authority', async () => {
    await applyExecuteDecision(testTaskId);

    const routeDecision = await routingService.route({
      projectId: testProjectId,
      taskId: testTaskId,
      candidateResourceIds: ['res-gemini-coder'],
      allowManualBridge: true,
      requiredCapabilities: ['CODING'],
    });
    const auth = await authorizationService.createAuthorization({
      projectId: testProjectId,
      taskId: testTaskId,
      routingDecisionId: routeDecision.decisionId,
    });

    // Increment task revision
    repo.updateTaskState(testTaskId, 'CODING', null, true);

    const dispatch = await dispatchService.dispatch(auth.id);
    expect(dispatch.status).toBe('FAILED');
    expect(dispatch.error).toContain('EXECUTION_AUTHORIZATION_STALE_TASK_REVISION');
  });

  // Contract 5: coder.v1 for wrong task/project is rejected
  it('Negative Contract 5: coder.v1 report targeting wrong project is rejected and recorded as REJECTED', async () => {
    await applyExecuteDecision(testTaskId);

    const foreignCoderReport: CoderProtocol = {
      protocol: 'coder.v1',
      message_id: crypto.randomUUID(),
      project_id: 'proj-foreign-id',
      task_id: testTaskId,
      attempt: 1,
      status: 'COMPLETED',
      completed: ['Spoofed report'],
      remaining: [],
      files_claimed_changed: [],
      tests_claimed: [],
      blockers: [],
      review_requested: true,
      expected_task_state: 'CODING',
    };

    const result = taskService.applyCoderReport(
      foreignCoderReport,
      JSON.stringify(foreignCoderReport)
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cross-project conflict');

    const recorded = repo.getProtocolMessagesByTask(testTaskId);
    expect(
      recorded.some(
        (m) =>
          m.status === 'REJECTED' &&
          typeof m.rejection_reason === 'string' &&
          m.rejection_reason.includes('Cross-project conflict')
      )
    ).toBe(true);
  });

  // Contract 6: Malformed coder.v1 is rejected
  it('Negative Contract 6: Malformed coder.v1 is rejected by protocol parser', () => {
    const malformedRaw = JSON.stringify({
      protocol: 'coder.v1',
      message_id: '123', // not a uuid
    });

    const parsed = ProtocolParser.parse(malformedRaw);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeDefined();
  });

  // Contract 7: Duplicate coder report does not corrupt durable state
  it('Negative Contract 7: Replayed coder.v1 report when task already left CODING is rejected safely', async () => {
    await applyExecuteDecision(testTaskId);

    const coderReport1: CoderProtocol = {
      protocol: 'coder.v1',
      message_id: crypto.randomUUID(),
      project_id: testProjectId,
      task_id: testTaskId,
      attempt: 1,
      status: 'COMPLETED',
      completed: ['Valid report 1'],
      remaining: [],
      files_claimed_changed: [],
      tests_claimed: [],
      blockers: [],
      review_requested: true,
      expected_task_state: 'CODING',
    };

    // First application moves to VALIDATING
    const res1 = taskService.applyCoderReport(coderReport1, JSON.stringify(coderReport1));
    expect(res1.success).toBe(true);
    expect(repo.getTask(testTaskId)!.state).toBe('VALIDATING');

    // A second coder report with expected_task_state 'CODING' fails closed because task is now in VALIDATING
    const coderReport2: CoderProtocol = {
      ...coderReport1,
      message_id: crypto.randomUUID(),
    };
    const res2 = taskService.applyCoderReport(coderReport2, JSON.stringify(coderReport2));
    expect(res2.success).toBe(false);
    expect(res2.error).toContain('Stale state conflict');
    expect(repo.getTask(testTaskId)!.state).toBe('VALIDATING');
  });

  // Contract 8: Restart cannot restore consumed authorization back to AUTHORIZED
  it('Negative Contract 8: Restart preserves DISPATCHED authorization status in SQLite', async () => {
    await applyExecuteDecision(testTaskId);

    const routeDecision = await routingService.route({
      projectId: testProjectId,
      taskId: testTaskId,
      candidateResourceIds: ['res-gemini-coder'],
      allowManualBridge: true,
      requiredCapabilities: ['CODING'],
    });
    const auth = await authorizationService.createAuthorization({
      projectId: testProjectId,
      taskId: testTaskId,
      routingDecisionId: routeDecision.decisionId,
    });

    await dispatchService.dispatch(auth.id);

    // Close DB connection and reopen (simulating app restart)
    db.close();

    const reopenedDb = new Database(path.join(dbDir, 'agent-forge.db'));
    reopenedDb.pragma('foreign_keys = ON');
    const newRepo = new Repository(reopenedDb);

    const reloadedAuth = newRepo.getExecutionAuthorization(auth.id)!;
    expect(reloadedAuth.status).toBe('DISPATCHED');
    expect(reloadedAuth.dispatched_at).toBeDefined();

    reopenedDb.close();

    // Reopen original db for afterEach cleanup
    db = new Database(path.join(dbDir, 'agent-forge.db'));
  });

  // Contract 9: Owner candidate omission does not silently auto-select every provider
  it('Negative Contract 9: Unlisted provider candidates are not probed or selected', async () => {
    await applyExecuteDecision(testTaskId);

    // Only specify manual bridge candidate, omitting Codex
    const routeDecision = await routingService.route({
      projectId: testProjectId,
      taskId: testTaskId,
      candidateResourceIds: ['res-gemini-coder'],
      allowManualBridge: true,
      requiredCapabilities: ['CODING'],
    });

    expect(routeDecision.outcome).toBe('MANUAL_HANDOFF_REQUIRED');
    expect(routeDecision.selectedResourceId).toBe('res-gemini-coder');

    // Evaluated candidates list must only contain res-gemini-coder
    expect(routeDecision.candidateEvaluations.length).toBe(1);
    expect(routeDecision.candidateEvaluations[0].resourceId).toBe('res-gemini-coder');
  });

  // Contract 10: Updater cannot trigger provider dispatch
  it('Negative Contract 10: UpdateService operates completely isolated from execution dispatch', () => {
    const updateService = new UpdateService({
      currentVersion: '0.1.0',
      isPackaged: true,
      isCodeSigned: false,
    });

    // UpdateService has no access to ProviderDispatchService, ExecutionAuthorization, or DB dispatch
    expect((updateService as any).dispatchService).toBeUndefined();
    expect((updateService as any).authorizationService).toBeUndefined();
    expect((updateService as any).repo).toBeUndefined();

    // Initial state is strictly IDLE
    const summary = updateService.getState();
    expect(summary.state).toBe('IDLE');
    expect(summary.currentVersion).toBe('0.1.0');
    expect(summary.canInstall).toBe(false);
  });

  // =========================================================================
  // Section 7: Static Negative Contracts for RC Verification Rules
  // =========================================================================
  describe('RC Verification Script Static Rules & Invariants', () => {
    function evaluateRcConfig(options: {
      providerText: string;
      appUpdateText?: string;
      migrationCount: number;
      installerExists: boolean;
      unpackedExists: boolean;
      appUpdateExists: boolean;
    }): { valid: boolean; failures: string[] } {
      const failures: string[] = [];
      const credRegex = /(token:|password:|Authorization:|Bearer\s|ghp_|github_pat_)/i;

      // Provider check
      const hasGithub = /provider:\s*github/i.test(options.providerText);
      const hasOwner = /owner:\s*thanhtuyen662002/i.test(options.providerText);
      const hasRepo = /repo:\s*Agent-Forge/i.test(options.providerText);
      if (!(hasGithub && hasOwner && hasRepo)) {
        failures.push('INVALID_PROVIDER');
      }

      // Credentials in builder
      if (credRegex.test(options.providerText)) {
        failures.push('BUILDER_CREDENTIALS_FOUND');
      }

      // Migration count
      if (options.migrationCount !== 7) {
        failures.push('INVALID_MIGRATION_COUNT');
      }

      // Installer existence
      if (!options.installerExists) {
        failures.push('MISSING_INSTALLER');
      }

      // Unpacked existence
      if (!options.unpackedExists) {
        failures.push('MISSING_UNPACKED_EXE');
      }

      // Packaged app-update.yml
      if (!options.appUpdateExists) {
        failures.push('MISSING_PACKAGED_APP_UPDATE_YML');
      } else if (options.appUpdateText) {
        const hasPkgGithub = /provider:\s*github/i.test(options.appUpdateText);
        const hasPkgOwner = /owner:\s*thanhtuyen662002/i.test(options.appUpdateText);
        const hasPkgRepo = /repo:\s*Agent-Forge/i.test(options.appUpdateText);
        if (!(hasPkgGithub && hasPkgOwner && hasPkgRepo)) {
          failures.push('INVALID_APP_UPDATE_CONFIG');
        }
        if (credRegex.test(options.appUpdateText)) {
          failures.push('APP_UPDATE_CREDENTIALS_FOUND');
        }
      }

      return { valid: failures.length === 0, failures };
    }

    it('RC Rule 1: Wrong provider (e.g. generic/s3) fails verification', () => {
      const res = evaluateRcConfig({
        providerText: 'provider: generic\nurl: https://example.com',
        migrationCount: 7,
        installerExists: true,
        unpackedExists: true,
        appUpdateExists: true,
      });
      expect(res.valid).toBe(false);
      expect(res.failures).toContain('INVALID_PROVIDER');
    });

    it('RC Rule 2: Embedded credentials in builder config fails verification', () => {
      const res = evaluateRcConfig({
        providerText: 'provider: github\nowner: thanhtuyen662002\nrepo: Agent-Forge\ntoken: ghp_12345secret',
        migrationCount: 7,
        installerExists: true,
        unpackedExists: true,
        appUpdateExists: true,
      });
      expect(res.valid).toBe(false);
      expect(res.failures).toContain('BUILDER_CREDENTIALS_FOUND');
    });

    it('RC Rule 3: Missing installer file fails verification', () => {
      const res = evaluateRcConfig({
        providerText: 'provider: github\nowner: thanhtuyen662002\nrepo: Agent-Forge',
        migrationCount: 7,
        installerExists: false,
        unpackedExists: true,
        appUpdateExists: true,
      });
      expect(res.valid).toBe(false);
      expect(res.failures).toContain('MISSING_INSTALLER');
    });

    it('RC Rule 4: Incorrect migration count (!= 7) fails verification', () => {
      const res = evaluateRcConfig({
        providerText: 'provider: github\nowner: thanhtuyen662002\nrepo: Agent-Forge',
        migrationCount: 6,
        installerExists: true,
        unpackedExists: true,
        appUpdateExists: true,
      });
      expect(res.valid).toBe(false);
      expect(res.failures).toContain('INVALID_MIGRATION_COUNT');
    });

    it('RC Rule 5: Missing packaged app-update.yml fails verification', () => {
      const res = evaluateRcConfig({
        providerText: 'provider: github\nowner: thanhtuyen662002\nrepo: Agent-Forge',
        migrationCount: 7,
        installerExists: true,
        unpackedExists: true,
        appUpdateExists: false,
      });
      expect(res.valid).toBe(false);
      expect(res.failures).toContain('MISSING_PACKAGED_APP_UPDATE_YML');
    });
  });
});
