import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { EventService } from '../src/core/services/EventService';
import { ProjectService } from '../src/core/services/ProjectService';
import { TaskService } from '../src/core/services/TaskService';
import { VerificationService } from '../src/core/services/VerificationService';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import { PackageGenerator } from '../src/core/protocol/packageGenerator';
import { ManagerProtocol, CoderProtocol } from '../src/core/types/protocols';
import { Task, ProjectContract } from '../src/core/types/domain';

describe('Real End-to-End Orchestration Integration Lifecycle', () => {
  let gitRepoDir: string;
  let tmpDataDir: string;
  let dbPath: string;
  let db: Database.Database;
  let repo: Repository;
  let eventService: EventService;
  let projectService: ProjectService;
  let artifactStore: ArtifactStore;
  let verificationService: VerificationService;
  let taskService: TaskService;
  let baseSha: string;

  beforeEach(() => {
    // 1. Create a real temporary Git repository
    gitRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-e2e-git-'));
    execSync('git init', { cwd: gitRepoDir });
    execSync('git config user.name "E2E Agent"', { cwd: gitRepoDir });
    execSync('git config user.email "agent@agentforge.local"', { cwd: gitRepoDir });

    // Create baseline files and a real Node/test runner script
    const baselineFile = path.join(gitRepoDir, 'feature.js');
    fs.writeFileSync(baselineFile, 'module.exports = { value: 1 };\n', 'utf8');

    // Create a safe test runner script
    const testScript = path.join(gitRepoDir, 'run_tests.js');
    fs.writeFileSync(
      testScript,
      'const f = require("./feature.js"); if (f.value === 42) { console.log("2 tests passed cleanly"); process.exit(0); } else { console.error("Assertion failed: expected 42"); process.exit(1); }',
      'utf8'
    );

    // Baseline commit
    execSync('git add .', { cwd: gitRepoDir });
    execSync('git commit -m "chore: baseline commit"', { cwd: gitRepoDir });
    baseSha = execSync('git rev-parse HEAD', { cwd: gitRepoDir }).toString().trim();

    // 2. Initialize durable backend
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-e2e-data-'));
    dbPath = path.join(tmpDataDir, 'agent-forge.db');
    const artifactsDir = path.join(tmpDataDir, 'artifacts');

    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    MigrationRunner.run(db);

    repo = new Repository(db);
    eventService = new EventService(repo);
    projectService = new ProjectService(repo, eventService);
    artifactStore = new ArtifactStore(artifactsDir);
    verificationService = new VerificationService(repo, artifactStore);
    taskService = new TaskService(repo, eventService, verificationService, artifactStore);
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(gitRepoDir, { recursive: true, force: true });
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    } catch {}
  });

  it('should execute the full orchestration lifecycle with real Git and real ProcessRunner without state shortcuts', async () => {
    // 1. Setup Project through ProjectService
    const project = projectService.createProject(
      'Real E2E Project',
      'End to end verification without shortcuts',
      gitRepoDir,
      'main'
    );

    const contract: ProjectContract = {
      goal: 'Update feature value to 42 and pass test suite',
      business_context: 'Core product requirement',
      architecture_constraints: ['Zero arbitrary shell execution'],
      technical_constraints: [],
      security_requirements: ['Strict policy validation'],
      acceptance_criteria: ['Feature returns 42', 'Verification tests pass'],
      non_goals: [],
      definition_of_done: ['Automated test suite passes'],
      testing_requirements: ['run_tests.js must return exit code 0'],
      owner_policies: [],
    };
    projectService.importContract(project.id, contract);
    projectService.transitionStatus(project.id, 'PLAN_APPROVED');
    projectService.transitionStatus(project.id, 'START_PROJECT');

    // Configure a durable verification command
    const testCmdId = 'cmd-test-1';
    repo.createVerificationCommand({
      id: testCmdId,
      project_id: project.id,
      name: 'E2E Test Runner',
      command_type: 'TEST',
      executable: 'node',
      args: [path.join(gitRepoDir, 'run_tests.js')],
      timeout_ms: 30000,
      enabled: true,
    });

    // 2. Create Task through trusted TaskService WITHOUT manual baseSha injection
    const task = taskService.createTask({
      id: 'TSK-REAL-001',
      projectId: project.id,
      title: 'Update feature to 42',
      description: 'Modify feature.js to return 42 so tests pass',
      priority: 'HIGH',
      risk: 'LOW',
      acceptanceCriteria: ['feature.js returns 42', 'run_tests.js passes'],
      constraints: [],
    });

    // Assert base_sha is NULL before execution begins
    expect(task.base_sha).toBeNull();
    expect(repo.getTask(task.id)!.base_sha).toBeNull();

    // 3. Manager EXECUTE Protocol Applied -> Binds exact Git commit HEAD SHA and transitions to CODING
    const managerExecMsg: ManagerProtocol = {
      protocol: 'manager.v1',
      message_id: 'msg-exec-real-1',
      project_id: project.id,
      task_id: task.id,
      decision: 'EXECUTE',
      priority: 'HIGH',
      risk: 'LOW',
      instructions: ['Update feature.js to value 42'],
      acceptance_criteria: ['feature.js returns 42', 'run_tests.js passes'],
      constraints: [],
      review_issues: [],
      expected_task_state: 'PLANNED',
      expected_revision: 0,
    };
    const execRes = await taskService.applyManagerDecision(managerExecMsg, JSON.stringify(managerExecMsg));
    expect(execRes.success).toBe(true);

    const taskInCoding = repo.getTask(task.id)!;
    expect(taskInCoding.state).toBe('CODING');
    expect(taskInCoding.base_sha).toBe(baseSha); // Immutably bound to exact git rev-parse HEAD commit!

    // 4. Generate Work Order containing exact bound commit SHA
    const workOrder = PackageGenerator.generateWorkOrder(project, taskInCoding, repo);
    expect(workOrder).toContain(`WORK ORDER: ${task.id}`);
    expect(workOrder).toContain(baseSha);
    expect(workOrder).toContain('Update feature to 42');

    // 5. Simulate Coder Modifying the Tracked File in Real Git
    const targetFile = path.join(gitRepoDir, 'feature.js');
    fs.writeFileSync(targetFile, 'module.exports = { value: 42 };\n', 'utf8');

    // 6. Coder COMPLETED Report Applied -> Task transitions to VALIDATING
    const coderReportMsg: CoderProtocol = {
      protocol: 'coder.v1',
      message_id: 'msg-cdr-real-1',
      project_id: project.id,
      task_id: task.id,
      attempt: 1,
      status: 'COMPLETED',
      completed: ['Updated feature.js to 42'],
      remaining: [],
      files_claimed_changed: ['feature.js'],
      tests_claimed: ['node run_tests.js passed'],
      blockers: [],
      review_requested: true,
      expected_task_state: 'CODING',
      expected_revision: 0,
    };
    const coderRes = taskService.applyCoderReport(coderReportMsg, JSON.stringify(coderReportMsg));
    expect(coderRes.success).toBe(true);
    expect(repo.getTask(task.id)!.state).toBe('VALIDATING');

    // 7. Execute Real Validation Flow (Queries Git diff, executes ProcessRunner test suite)
    const valRes = await taskService.executeValidationFlow(task.id, testCmdId);
    expect(valRes.success).toBe(true);
    expect(valRes.testRun.exit_code).toBe(0);
    expect(valRes.gitDiff.status).toBe('SUCCESS');
    expect(valRes.gitDiff.filesChanged).toContain('feature.js');
    expect(valRes.finalTaskState).toBe('REVIEW_READY');

    // Assert task state in DB is REVIEW_READY without any direct repo mutation shortcuts!
    const taskAfterVal = repo.getTask(task.id)!;
    expect(taskAfterVal.state).toBe('REVIEW_READY');

    // 8. Start Review through Real Orchestration API -> Task transitions to REVIEWING
    const reviewStartRes = taskService.startReview(task.id);
    expect(reviewStartRes.success).toBe(true);
    expect(reviewStartRes.task!.state).toBe('REVIEWING');
    expect(repo.getTask(task.id)!.state).toBe('REVIEWING');

    // 9. Generate Review Package from Durable Evidence
    const latestTestRun = repo.getLatestTestRun(task.id);
    const gitDiffEv = repo.getLatestEvidence(task.id, 'GIT_DIFF');
    const diffContent = gitDiffEv ? artifactStore.read(gitDiffEv) : '';

    const reviewPackage = PackageGenerator.generateReviewPackage(
      project,
      repo.getTask(task.id)!,
      coderReportMsg,
      gitDiffEv?.summary || '',
      diffContent,
      latestTestRun,
      []
    );

    // Verify Review Package contains all required real elements
    expect(reviewPackage).toContain(`REVIEW PACKAGE: ${task.id}`);
    expect(reviewPackage).toContain('feature.js');
    expect(reviewPackage).toContain('+module.exports = { value: 42 };'); // Real diff hunk!
    expect(reviewPackage).toContain('🟢 PASSED');
    expect(reviewPackage).toContain('node'); // Test command
    expect(reviewPackage).toContain(baseSha); // Base SHA

    // 10. Manager PASS Decision Applied -> Task reaches DONE
    const managerPassMsg: ManagerProtocol = {
      protocol: 'manager.v1',
      message_id: 'msg-pass-real-1',
      project_id: project.id,
      task_id: task.id,
      decision: 'PASS',
      priority: 'HIGH',
      risk: 'LOW',
      instructions: ['Changes verified against live Git evidence. Approved.'],
      acceptance_criteria: [],
      constraints: [],
      review_issues: [],
      expected_task_state: 'REVIEWING',
      expected_revision: 0,
    };
    const passRes = await taskService.applyManagerDecision(managerPassMsg, JSON.stringify(managerPassMsg));
    expect(passRes.success).toBe(true);

    const taskDone = repo.getTask(task.id)!;
    expect(taskDone.state).toBe('DONE');
    expect(taskDone.progress_cache_percent).toBe(100);

    // 11. Close Database, Reopen, Run Migrations, and Verify Full Persistence
    db.close();

    const reopenedDb = new Database(dbPath);
    reopenedDb.pragma('foreign_keys = ON');
    MigrationRunner.run(reopenedDb);

    const restartedRepo = new Repository(reopenedDb);
    const persistedTask = restartedRepo.getTask(task.id)!;
    expect(persistedTask.state).toBe('DONE');
    expect(persistedTask.progress_cache_percent).toBe(100);

    const persistedTestRun = restartedRepo.getLatestTestRun(task.id)!;
    expect(persistedTestRun.exit_code).toBe(0);
    expect(persistedTestRun.evidence_id).toBeDefined();

    const processRuns = restartedRepo.getProcessRunsByTask(task.id);
    expect(processRuns.length).toBeGreaterThan(0);
    expect(processRuns[0].stdout_evidence_id).toBeDefined();

    const persistedMessages = restartedRepo.getProtocolMessagesByTask(task.id);
    expect(persistedMessages.length).toBe(3); // EXECUTE, CODER, PASS

    reopenedDb.close();
  });

  it('should block transition to REVIEW_READY if Git evidence fails even when tests pass', async () => {
    const nonGitDir = path.join(tmpDataDir, 'non_git_workspace');
    fs.mkdirSync(nonGitDir, { recursive: true });

    const project = projectService.createProject(
      'Git Failure Test Project',
      'Verify fail-closed on git error',
      nonGitDir,
      'main'
    );

    const task: Task = {
      id: 'TSK-GIT-FAIL',
      project_id: project.id,
      milestone_id: null,
      title: 'Task with broken git path',
      description: null,
      state: 'VALIDATING',
      paused_from_state: null,
      priority: 'MEDIUM',
      risk: 'LOW',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createTask(task);

    // Configure test command pointing to safe script
    const safeScript = path.join(tmpDataDir, 'always_pass.js');
    fs.writeFileSync(safeScript, 'process.exit(0);', 'utf8');

    const testCmdId = 'cmd-pass-1';
    repo.createVerificationCommand({
      id: testCmdId,
      project_id: project.id,
      name: 'Always Pass Test',
      command_type: 'TEST',
      executable: 'node',
      args: [safeScript],
      timeout_ms: 10000,
      enabled: true,
    });

    const res = await taskService.executeValidationFlow(task.id, testCmdId);
    expect(res.success).toBe(false);
    expect(res.gitStatus.status).toBe('ERROR');
    expect(res.testRun.exit_code).toBe(0); // Test passed, but Git failed!

    // Assert task did NOT advance to REVIEW_READY; returned to CODING via TESTS_FAILED
    const taskAfter = repo.getTask(task.id)!;
    expect(taskAfter.state).toBe('CODING');
    expect(taskAfter.revision_count).toBe(1);
  });
});
