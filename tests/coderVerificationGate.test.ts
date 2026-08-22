import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { EventService } from '../src/core/services/EventService';
import { TaskService } from '../src/core/services/TaskService';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import { VerificationService, shouldRunCoderVerification } from '../src/core/services/VerificationService';
import { CoderProtocol } from '../src/core/types/protocols';
import { Project, Task } from '../src/core/types/domain';

describe('Coder Auto-Verification State Gate (PR18)', () => {
  let db: Database.Database;
  let repo: Repository;
  let eventService: EventService;
  let artifactStore: ArtifactStore;
  let verificationService: VerificationService;
  let taskService: TaskService;

  let tempDir: string;
  let testProject: Project;
  let testTask: Task;
  let baseCommitSha: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-coder-verif-test-'));
    execSync('git init -b main', { cwd: tempDir });
    execSync('git config user.email "test@agentforge.test"', { cwd: tempDir });
    execSync('git config user.name "Tester"', { cwd: tempDir });

    fs.writeFileSync(path.join(tempDir, 'README.md'), '# Test Fixture\n');
    fs.writeFileSync(
      path.join(tempDir, 'sum.js'),
      'function sum(a, b) {\n  return a - b;\n}\nmodule.exports = { sum };\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'verify.js'),
      'const { sum } = require("./sum");\nif (sum(2, 3) !== 5) process.exit(1);\nconsole.log("PASS");\n'
    );
    execSync('git add . && git commit -m "initial baseline"', { cwd: tempDir });
    baseCommitSha = execSync('git rev-parse HEAD', { cwd: tempDir }).toString().trim();

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);

    repo = new Repository(db);
    eventService = new EventService(repo);
    artifactStore = new ArtifactStore(tempDir);
    verificationService = new VerificationService(repo, artifactStore);
    taskService = new TaskService(repo, eventService, verificationService, artifactStore);

    testProject = {
      id: 'PROJ-VERIF-GATE',
      name: 'Verification Gate Test Project',
      description: 'Testing coder auto-verification gating',
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

    testTask = {
      id: 'TSK-VERIF-001',
      project_id: 'PROJ-VERIF-GATE',
      milestone_id: null,
      title: 'Fix sum implementation',
      description: 'Make sum return a + b',
      state: 'CODING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'LOW',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: baseCommitSha,
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: new Date().toISOString(),
      acceptance_criteria: ['sum(2, 3) returns 5'],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createTask(testTask);

    repo.createVerificationCommand({
      id: 'vc-test-node',
      project_id: 'PROJ-VERIF-GATE',
      name: 'Node Verify',
      command_type: 'TEST',
      executable: 'node',
      args: ['verify.js'],
      timeout_ms: 60000,
      enabled: true,
    });
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  function getTestRuns(taskId: string) {
    return db.prepare('SELECT * FROM test_runs WHERE task_id = ? ORDER BY created_at ASC').all(taskId) as any[];
  }

  // =========================================================================
  // Pure Invariant Unit Tests
  // =========================================================================
  describe('Pure Invariant: shouldRunCoderVerification', () => {
    it('returns true ONLY when postApplyTaskState is VALIDATING', () => {
      expect(shouldRunCoderVerification('VALIDATING')).toBe(true);
      expect(shouldRunCoderVerification('CODING')).toBe(false);
      expect(shouldRunCoderVerification('BLOCKED')).toBe(false);
      expect(shouldRunCoderVerification('NEEDS_HUMAN')).toBe(false);
      expect(shouldRunCoderVerification('REVIEW_READY')).toBe(false);
      expect(shouldRunCoderVerification('REVIEWING')).toBe(false);
      expect(shouldRunCoderVerification('DONE')).toBe(false);
      expect(shouldRunCoderVerification('PLANNED')).toBe(false);
      expect(shouldRunCoderVerification(null)).toBe(false);
      expect(shouldRunCoderVerification(undefined)).toBe(false);
    });
  });

  // =========================================================================
  // End-to-End Simulation Helper
  // =========================================================================
  async function applyCoderAndConditionallyVerify(coderMsg: CoderProtocol) {
    const applyRes = taskService.applyCoderReport(coderMsg, JSON.stringify(coderMsg));
    let verificationRan = false;
    let verificationResult: any = null;

    if (applyRes.success && applyRes.task && shouldRunCoderVerification(applyRes.task.state)) {
      verificationRan = true;
      verificationResult = await taskService.executeValidationFlow(applyRes.task.id);
    }

    return {
      applyRes,
      verificationRan,
      verificationResult,
      finalTask: repo.getTask(coderMsg.task_id)!,
    };
  }

  // =========================================================================
  // CASE A — Completed review submission
  // =========================================================================
  it('CASE A: completed review submission transitions to VALIDATING and runs verification', async () => {
    // Fix sum.js so verification will pass
    fs.writeFileSync(
      path.join(tempDir, 'sum.js'),
      'function sum(a, b) {\n  return a + b;\n}\nmodule.exports = { sum };\n'
    );

    const msg: CoderProtocol = {
      protocol: 'coder.v1',
      message_id: 'msg-case-a',
      project_id: 'PROJ-VERIF-GATE',
      task_id: 'TSK-VERIF-001',
      attempt: 1,
      status: 'COMPLETED',
      completed: ['Fixed sum logic'],
      remaining: [],
      files_claimed_changed: ['sum.js'],
      tests_claimed: ['node verify.js passed'],
      blockers: [],
      review_requested: true,
      expected_task_state: 'CODING',
      expected_revision: 0,
    };

    const res = await applyCoderAndConditionallyVerify(msg);
    expect(res.applyRes.success).toBe(true);
    expect(res.applyRes.task!.state).toBe('VALIDATING');
    expect(res.verificationRan).toBe(true);
    expect(res.finalTask.state).toBe('REVIEW_READY');
    expect(res.finalTask.revision_count).toBe(0);

    const testRuns = getTestRuns('TSK-VERIF-001');
    expect(testRuns.length).toBe(1);
    expect(testRuns[0].exit_code).toBe(0);
  });

  // =========================================================================
  // CASE B — Completed without review
  // =========================================================================
  it('CASE B: completed without review leaves task in CODING with 0 verification calls', async () => {
    const msg: CoderProtocol = {
      protocol: 'coder.v1',
      message_id: 'msg-case-b',
      project_id: 'PROJ-VERIF-GATE',
      task_id: 'TSK-VERIF-001',
      attempt: 1,
      status: 'COMPLETED',
      completed: ['Work done but keeping in development'],
      remaining: [],
      files_claimed_changed: ['sum.js'],
      tests_claimed: [],
      blockers: [],
      review_requested: false,
      expected_task_state: 'CODING',
      expected_revision: 0,
    };

    const res = await applyCoderAndConditionallyVerify(msg);
    expect(res.applyRes.success).toBe(true);
    expect(res.applyRes.task!.state).toBe('CODING');
    expect(res.verificationRan).toBe(false);
    expect(res.finalTask.state).toBe('CODING');
    expect(res.finalTask.revision_count).toBe(0);

    const testRuns = getTestRuns('TSK-VERIF-001');
    expect(testRuns.length).toBe(0);
  });

  // =========================================================================
  // CASE C — IN_PROGRESS
  // =========================================================================
  it('CASE C: IN_PROGRESS leaves task in CODING with 0 verification calls and unchanged revision', async () => {
    const msg: CoderProtocol = {
      protocol: 'coder.v1',
      message_id: 'msg-case-c',
      project_id: 'PROJ-VERIF-GATE',
      task_id: 'TSK-VERIF-001',
      attempt: 1,
      status: 'IN_PROGRESS',
      completed: ['Partial progress'],
      remaining: ['Need more work'],
      files_claimed_changed: ['sum.js'],
      tests_claimed: [],
      blockers: [],
      review_requested: false,
      expected_task_state: 'CODING',
      expected_revision: 0,
    };

    const res = await applyCoderAndConditionallyVerify(msg);
    expect(res.applyRes.success).toBe(true);
    expect(res.applyRes.task!.state).toBe('CODING');
    expect(res.verificationRan).toBe(false);
    expect(res.finalTask.state).toBe('CODING');
    expect(res.finalTask.revision_count).toBe(0);

    const testRuns = getTestRuns('TSK-VERIF-001');
    expect(testRuns.length).toBe(0);
  });

  // =========================================================================
  // CASE D — BLOCKED
  // =========================================================================
  it('CASE D: BLOCKED transitions task to BLOCKED with 0 verification calls', async () => {
    const msg: CoderProtocol = {
      protocol: 'coder.v1',
      message_id: 'msg-case-d',
      project_id: 'PROJ-VERIF-GATE',
      task_id: 'TSK-VERIF-001',
      attempt: 1,
      status: 'BLOCKED',
      completed: [],
      remaining: ['All'],
      files_claimed_changed: [],
      tests_claimed: [],
      blockers: ['Missing upstream dependency'],
      review_requested: false,
      expected_task_state: 'CODING',
      expected_revision: 0,
    };

    const res = await applyCoderAndConditionallyVerify(msg);
    expect(res.applyRes.success).toBe(true);
    expect(res.applyRes.task!.state).toBe('BLOCKED');
    expect(res.verificationRan).toBe(false);
    expect(res.finalTask.state).toBe('BLOCKED');
    expect(res.finalTask.revision_count).toBe(0);

    const testRuns = getTestRuns('TSK-VERIF-001');
    expect(testRuns.length).toBe(0);
  });

  // =========================================================================
  // CASE E — FAILED (revision incremented exactly once to 1, not 2)
  // =========================================================================
  it('CASE E: FAILED increments revision to 1 with 0 verification calls (NOT 2)', async () => {
    const msg: CoderProtocol = {
      protocol: 'coder.v1',
      message_id: 'msg-case-e',
      project_id: 'PROJ-VERIF-GATE',
      task_id: 'TSK-VERIF-001',
      attempt: 1,
      status: 'FAILED',
      completed: [],
      remaining: ['Retry required'],
      files_claimed_changed: [],
      tests_claimed: ['Unit tests failed'],
      blockers: [],
      review_requested: false,
      expected_task_state: 'CODING',
      expected_revision: 0,
    };

    const res = await applyCoderAndConditionallyVerify(msg);
    expect(res.applyRes.success).toBe(true);
    expect(res.applyRes.task!.state).toBe('CODING');
    expect(res.verificationRan).toBe(false);
    expect(res.finalTask.state).toBe('CODING');
    expect(res.finalTask.revision_count).toBe(1); // Exactly 1, NOT 2

    const testRuns = getTestRuns('TSK-VERIF-001');
    expect(testRuns.length).toBe(0);
  });

  // =========================================================================
  // CASE F — FAILED at revision threshold (escalates to NEEDS_HUMAN, 0 verification)
  // =========================================================================
  it('CASE F: FAILED at max revision threshold transitions to NEEDS_HUMAN with 0 verification calls', async () => {
    // Set task to revision 2 (max_revisions = 3, so next failure hits 3 and escalates to NEEDS_HUMAN)
    db.prepare('UPDATE tasks SET revision_count = 2 WHERE id = ?').run('TSK-VERIF-001');

    const msg: CoderProtocol = {
      protocol: 'coder.v1',
      message_id: 'msg-case-f',
      project_id: 'PROJ-VERIF-GATE',
      task_id: 'TSK-VERIF-001',
      attempt: 1,
      status: 'FAILED',
      completed: [],
      remaining: ['Cannot solve'],
      files_claimed_changed: [],
      tests_claimed: [],
      blockers: [],
      review_requested: false,
      expected_task_state: 'CODING',
      expected_revision: 2,
    };

    const res = await applyCoderAndConditionallyVerify(msg);
    expect(res.applyRes.success).toBe(true);
    expect(res.applyRes.task!.state).toBe('NEEDS_HUMAN');
    expect(res.verificationRan).toBe(false);
    expect(res.finalTask.state).toBe('NEEDS_HUMAN');
    expect(res.finalTask.revision_count).toBe(3);

    const testRuns = getTestRuns('TSK-VERIF-001');
    expect(testRuns.length).toBe(0);
  });

  // =========================================================================
  // CASE G — Failed real validation (VALIDATING -> TESTS_FAILED -> CODING Rev 1)
  // =========================================================================
  it('CASE G: failed real validation results in exactly 1 TestRun and revision incremented to 1', async () => {
    // Keep buggy sum.js (returns a - b), so verify.js will fail (exit code 1)
    const msg: CoderProtocol = {
      protocol: 'coder.v1',
      message_id: 'msg-case-g',
      project_id: 'PROJ-VERIF-GATE',
      task_id: 'TSK-VERIF-001',
      attempt: 1,
      status: 'COMPLETED',
      completed: ['Attempted fix'],
      remaining: [],
      files_claimed_changed: ['sum.js'],
      tests_claimed: [],
      blockers: [],
      review_requested: true,
      expected_task_state: 'CODING',
      expected_revision: 0,
    };

    const res = await applyCoderAndConditionallyVerify(msg);
    expect(res.applyRes.success).toBe(true);
    expect(res.applyRes.task!.state).toBe('VALIDATING');
    expect(res.verificationRan).toBe(true);
    expect(res.finalTask.state).toBe('CODING');
    expect(res.finalTask.revision_count).toBe(1); // Incremented once by TESTS_FAILED

    const testRuns = getTestRuns('TSK-VERIF-001');
    expect(testRuns.length).toBe(1);
    expect(testRuns[0].exit_code).toBe(1);
  });

  // =========================================================================
  // CASE H — Successful validation (VALIDATING -> EVIDENCE_GATHERED -> REVIEW_READY Rev 0)
  // =========================================================================
  it('CASE H: successful validation results in exactly 1 TestRun and REVIEW_READY with unchanged revision', async () => {
    // Fix sum.js
    fs.writeFileSync(
      path.join(tempDir, 'sum.js'),
      'function sum(a, b) {\n  return a + b;\n}\nmodule.exports = { sum };\n'
    );

    const msg: CoderProtocol = {
      protocol: 'coder.v1',
      message_id: 'msg-case-h',
      project_id: 'PROJ-VERIF-GATE',
      task_id: 'TSK-VERIF-001',
      attempt: 1,
      status: 'COMPLETED',
      completed: ['Corrected sum function'],
      remaining: [],
      files_claimed_changed: ['sum.js'],
      tests_claimed: ['node verify.js passed'],
      blockers: [],
      review_requested: true,
      expected_task_state: 'CODING',
      expected_revision: 0,
    };

    const res = await applyCoderAndConditionallyVerify(msg);
    expect(res.applyRes.success).toBe(true);
    expect(res.applyRes.task!.state).toBe('VALIDATING');
    expect(res.verificationRan).toBe(true);
    expect(res.finalTask.state).toBe('REVIEW_READY');
    expect(res.finalTask.revision_count).toBe(0);

    const testRuns = getTestRuns('TSK-VERIF-001');
    expect(testRuns.length).toBe(1);
    expect(testRuns[0].exit_code).toBe(0);
  });

  // =========================================================================
  // CASE I — Duplicate coder message
  // =========================================================================
  it('CASE I: duplicate coder message does not trigger second verification or state mutation', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'sum.js'),
      'function sum(a, b) {\n  return a + b;\n}\nmodule.exports = { sum };\n'
    );

    const msg: CoderProtocol = {
      protocol: 'coder.v1',
      message_id: 'msg-case-i-duplicate',
      project_id: 'PROJ-VERIF-GATE',
      task_id: 'TSK-VERIF-001',
      attempt: 1,
      status: 'COMPLETED',
      completed: ['First submission'],
      remaining: [],
      files_claimed_changed: ['sum.js'],
      tests_claimed: ['node verify.js passed'],
      blockers: [],
      review_requested: true,
      expected_task_state: 'CODING',
      expected_revision: 0,
    };

    // First apply
    const res1 = await applyCoderAndConditionallyVerify(msg);
    expect(res1.applyRes.success).toBe(true);
    expect(res1.verificationRan).toBe(true);
    expect(res1.finalTask.state).toBe('REVIEW_READY');

    const testRunsAfterFirst = getTestRuns('TSK-VERIF-001');
    expect(testRunsAfterFirst.length).toBe(1);

    // Second apply with identical message_id
    const res2 = await applyCoderAndConditionallyVerify(msg);
    expect(res2.applyRes.success).toBe(true);
    expect((res2.applyRes as any).isDuplicate).toBe(true);
    expect(res2.verificationRan).toBe(false); // No second verification
    expect(res2.finalTask.state).toBe('REVIEW_READY'); // Unchanged

    const testRunsAfterSecond = getTestRuns('TSK-VERIF-001');
    expect(testRunsAfterSecond.length).toBe(1); // No duplicate test run
  });

  // =========================================================================
  // CASE J — Stale revision coder message
  // =========================================================================
  it('CASE J: stale revision coder message is rejected before verification with 0 verification calls', async () => {
    const msg: CoderProtocol = {
      protocol: 'coder.v1',
      message_id: 'msg-case-j-stale',
      project_id: 'PROJ-VERIF-GATE',
      task_id: 'TSK-VERIF-001',
      attempt: 1,
      status: 'COMPLETED',
      completed: ['Work from old revision'],
      remaining: [],
      files_claimed_changed: ['sum.js'],
      tests_claimed: [],
      blockers: [],
      review_requested: true,
      expected_task_state: 'CODING',
      expected_revision: 99, // Stale revision (current is 0)
    };

    const res = await applyCoderAndConditionallyVerify(msg);
    expect(res.applyRes.success).toBe(false);
    expect(res.applyRes.error).toContain('Stale revision conflict');
    expect(res.verificationRan).toBe(false);
    expect(res.finalTask.state).toBe('CODING');
    expect(res.finalTask.revision_count).toBe(0);

    const testRuns = getTestRuns('TSK-VERIF-001');
    expect(testRuns.length).toBe(0);
  });
});
