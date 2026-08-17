import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { EventService } from '../src/core/services/EventService';
import { TaskService } from '../src/core/services/TaskService';
import { VerificationService } from '../src/core/services/VerificationService';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import { PackageGenerator } from '../src/core/protocol/packageGenerator';
import { ManagerProtocol, CoderProtocol } from '../src/core/types/protocols';
import { Task, Project } from '../src/core/types/domain';

describe('End-to-End Core MVP Orchestration Lifecycle', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database;
  let repo: Repository;
  let eventService: EventService;
  let artifactStore: ArtifactStore;
  let verificationService: VerificationService;
  let taskService: TaskService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-e2e-'));
    dbPath = path.join(tmpDir, 'test.db');
    const artifactsDir = path.join(tmpDir, 'artifacts');

    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    MigrationRunner.run(db);

    repo = new Repository(db);
    eventService = new EventService(repo);
    artifactStore = new ArtifactStore(artifactsDir);
    verificationService = new VerificationService(repo, artifactStore);
    taskService = new TaskService(repo, eventService, verificationService, artifactStore);
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('should execute full MVP lifecycle from Project creation to DONE and verify restart persistence', async () => {
    // 1. Create Project
    const project: Project = {
      id: 'PROJ-E2E',
      name: 'E2E Test Engine',
      description: 'End-to-end orchestration lifecycle verification',
      repository_path: tmpDir,
      default_branch: 'main',
      status: 'READY',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    };
    repo.createProject(project);

    // 2. Import Contract
    const contract = {
      goal: 'Build verified module',
      business_context: 'Core engine',
      architecture_constraints: ['Zero arbitrary shell execution'],
      technical_constraints: [],
      security_requirements: ['Strict validation'],
      acceptance_criteria: ['Pass all tests'],
      non_goals: [],
      definition_of_done: ['Tests pass cleanly'],
      testing_requirements: ['100% pass'],
      owner_policies: [],
    };
    repo.updateProjectContract('PROJ-E2E', contract);

    // 3. Create Task
    const task: Task = {
      id: 'TSK-E2E-001',
      project_id: 'PROJ-E2E',
      milestone_id: null,
      title: 'Implement Core Feature',
      description: 'Implement core feature logic and tests',
      state: 'PLANNED',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: 'HEAD',
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: new Date().toISOString(),
      acceptance_criteria: ['Feature works', 'Tests pass'],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createTask(task);

    // 4. Manager EXECUTE Decision applied -> CODING
    const managerExecMsg: ManagerProtocol = {
      protocol: 'manager.v1',
      message_id: 'msg-exec-e2e',
      project_id: 'PROJ-E2E',
      task_id: 'TSK-E2E-001',
      decision: 'EXECUTE',
      priority: 'HIGH',
      risk: 'MEDIUM',
      instructions: ['Implement feature according to contract'],
      acceptance_criteria: ['Feature works', 'Tests pass'],
      constraints: [],
      review_issues: [],
      expected_task_state: 'PLANNED',
      expected_revision: 0,
    };
    const execRes = taskService.applyManagerDecision(managerExecMsg, JSON.stringify(managerExecMsg));
    expect(execRes.success).toBe(true);
    expect(repo.getTask('TSK-E2E-001')!.state).toBe('CODING');

    // 5. Generate Work Order
    const workOrder = PackageGenerator.generateWorkOrder(project, repo.getTask('TSK-E2E-001')!);
    expect(workOrder).toContain('WORK ORDER: TSK-E2E-001');
    expect(workOrder).toContain('Implement Core Feature');

    // 6. Coder COMPLETED report applied -> VALIDATING
    const coderReportMsg: CoderProtocol = {
      protocol: 'coder.v1',
      message_id: 'msg-cdr-e2e',
      project_id: 'PROJ-E2E',
      task_id: 'TSK-E2E-001',
      attempt: 1,
      status: 'COMPLETED',
      completed: ['Created feature module'],
      remaining: [],
      files_claimed_changed: ['src/feature.ts'],
      tests_claimed: ['Unit tests passing'],
      blockers: [],
      review_requested: true,
      expected_task_state: 'CODING',
      expected_revision: 0,
    };
    const coderRes = taskService.applyCoderReport(coderReportMsg, JSON.stringify(coderReportMsg));
    expect(coderRes.success).toBe(true);
    expect(repo.getTask('TSK-E2E-001')!.state).toBe('VALIDATING');

    // 7. Persist Test Run evidence
    const testEvidence = artifactStore.store(
      'ev-test-e2e',
      'PROJ-E2E',
      'TSK-E2E-001',
      null,
      'TEST_RESULT',
      'E2E Test Run',
      '=== STDOUT ===\n2 passed, 0 failed',
      'text/plain'
    );
    repo.createEvidence(testEvidence);

    repo.createTestRun({
      id: 'tr-e2e-001',
      task_id: 'TSK-E2E-001',
      command: 'npm test',
      passed_count: 2,
      failed_count: 0,
      skipped_count: 0,
      duration_ms: 120,
      exit_code: 0,
      evidence_id: testEvidence.id,
      created_at: new Date().toISOString(),
    });

    // Advance to REVIEW_READY
    repo.updateTaskState('TSK-E2E-001', 'REVIEW_READY');

    // 8. Generate Review Package with real authoritative evidence
    const latestTestRun = repo.getLatestTestRun('TSK-E2E-001');
    expect(latestTestRun).not.toBeNull();
    expect(latestTestRun!.passed_count).toBe(2);

    const reviewPackage = PackageGenerator.generateReviewPackage(
      project,
      repo.getTask('TSK-E2E-001')!,
      coderReportMsg,
      'src/feature.ts | 10 ++++++++++',
      '+ export const feature = () => true;',
      latestTestRun,
      []
    );
    expect(reviewPackage).toContain('REVIEW PACKAGE: TSK-E2E-001');
    expect(reviewPackage).toContain('🟢 PASSED');
    expect(reviewPackage).toContain('2 Passed | 0 Failed');

    // Advance to REVIEWING
    repo.updateTaskState('TSK-E2E-001', 'REVIEWING');

    // 9. Manager PASS Decision applied -> DONE
    const managerPassMsg: ManagerProtocol = {
      protocol: 'manager.v1',
      message_id: 'msg-pass-e2e',
      project_id: 'PROJ-E2E',
      task_id: 'TSK-E2E-001',
      decision: 'PASS',
      priority: 'HIGH',
      risk: 'MEDIUM',
      instructions: ['Approved and verified'],
      acceptance_criteria: [],
      constraints: [],
      review_issues: [],
      expected_task_state: 'REVIEWING',
      expected_revision: 0,
    };
    const passRes = taskService.applyManagerDecision(managerPassMsg, JSON.stringify(managerPassMsg));
    expect(passRes.success).toBe(true);

    const doneTask = repo.getTask('TSK-E2E-001')!;
    expect(doneTask.state).toBe('DONE');
    expect(doneTask.progress_cache_percent).toBe(100);

    // 10. Restart Simulation: Close and Reopen Database
    db.close();

    const restartedDb = new Database(dbPath);
    restartedDb.pragma('foreign_keys = ON');
    const restartedRepo = new Repository(restartedDb);

    const persistedTask = restartedRepo.getTask('TSK-E2E-001')!;
    expect(persistedTask.state).toBe('DONE');
    expect(persistedTask.progress_cache_percent).toBe(100);

    const persistedTestRun = restartedRepo.getLatestTestRun('TSK-E2E-001')!;
    expect(persistedTestRun.exit_code).toBe(0);
    expect(persistedTestRun.passed_count).toBe(2);

    const persistedMessages = restartedRepo.getProtocolMessagesByTask('TSK-E2E-001');
    expect(persistedMessages.length).toBe(3); // EXECUTE, CODER, PASS

    restartedDb.close();
  });
});
