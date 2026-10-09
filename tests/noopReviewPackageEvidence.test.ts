import { captureRepositoryRoot } from '../src/core/services/RepositoryRootIdentity';
import { execFileSync as initializeFixtureGit } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { EventService } from '../src/core/services/EventService';
import { ProjectService } from '../src/core/services/ProjectService';
import { TaskService } from '../src/core/services/TaskService';
import { VerificationService } from '../src/core/services/VerificationService';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import { EmergencyStopService } from '../src/core/services/EmergencyStopService';
import { registerIpcHandlers } from '../src/electron/ipcHandlers';
import type { Review } from '../src/core/types/domain';

// Mock electron's ipcMain, dialog, app
const ipcHandlers = new Map<string, Function>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: Function) => {
      ipcHandlers.set(channel, listener);
    },
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  app: {
    getPath: vi.fn().mockReturnValue(os.tmpdir()),
  },
}));

describe('No-Op Review Package Evidence Hardening (Fail-Closed & Clean Fallback)', () => {
  let tmpDataDir: string;
  let dbPath: string;
  let db: Database.Database;
  let repo: Repository;
  let eventService: EventService;
  let projectService: ProjectService;
  let artifactStore: ArtifactStore;
  let verificationService: VerificationService;
  let taskService: TaskService;
  let emergencyStopService: EmergencyStopService;

  const projectId = 'PROJ-TEST-NOOP';
  const taskId = 'TSK-TEST-NOOP';
  const validSha = '5cd8391fa41242c476d418d04c7c2c33efe2ae21';

  beforeEach(() => {
    ipcHandlers.clear();

    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-noop-test-'));
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
    emergencyStopService = new EmergencyStopService(repo, eventService);

    registerIpcHandlers(
      repo,
      projectService,
      taskService,
      verificationService,
      emergencyStopService
    );

    // Setup base project and task
    if (!fs.existsSync(path.join(tmpDataDir, '.git'))) initializeFixtureGit('git', ['init', '-q', '--template=', '--initial-branch=main'], { cwd: tmpDataDir, stdio: 'ignore', windowsHide: true });
    repo.createProject({
      id: projectId,
      name: 'No-Op Evidence Test Project',
      description: null,
      repository_path: tmpDataDir,
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    }, captureRepositoryRoot(tmpDataDir));

    repo.createTask({
      id: taskId,
      project_id: projectId,
      milestone_id: null,
      title: 'Prove No-Op Review Package',
      description: 'Test task for review package generation under no-op conditions.',
      state: 'REVIEW_READY',
      paused_from_state: null,
      priority: 'MEDIUM',
      risk: 'LOW',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: validSha,
      current_sha: validSha,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: ['Criterion 1'],
      constraints: ['Constraint 1'],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    } catch {}
  });

  const invokeGenerateReviewPackage = async (pId = projectId, tId = taskId) => {
    const handler = ipcHandlers.get('protocol:generateReviewPackage');
    if (!handler) throw new Error('protocol:generateReviewPackage handler not registered');
    return await handler({ senderFrame: { url: 'http://localhost:5173/' } }, { projectId: pId, taskId: tId });
  };

  function fixtureReview(text: string): Review {
    const id = crypto.randomUUID();
    return { id, task_id: taskId, attempt_id: null, reviewer_agent_id: null, verdict: 'FIX_REQUIRED',
      summary: text, created_at: new Date().toISOString(), issues: [{ id: crypto.randomUUID(), review_id: id,
        severity: 'REQUIRED', title: text, file_path: 'src/ordinary.ts', line_number: 3,
        description: text, resolved: false }] };
  }

  function ordinaryDiff() {
    const evidence = artifactStore.store(crypto.randomUUID(), projectId, taskId, null, 'GIT_DIFF',
      'Git Diff: 1 file changed', 'diff --git a/file.js b/file.js\n+ordinary line', 'text/x-diff');
    repo.createEvidence(evidence);
    return evidence;
  }

  it('sanitizes direct review diagnostics in actual SQLite before any review or issue is published', () => {
    const secret = 'AF_TEST_ONLY_REVIEW_CREDENTIAL';
    const review = fixtureReview('password=' + secret);
    repo.createReview(review);
    const durable = repo.getReviewsByTask(taskId);
    expect(JSON.stringify(durable).includes(secret)).toBe(false);
    expect(durable).toMatchObject([{ id: review.id, task_id: taskId, verdict: 'FIX_REQUIRED',
      issues: [{ id: review.issues![0].id, severity: 'REQUIRED', file_path: 'src/ordinary.ts', line_number: 3 }] }]);
    expect(review.summary.includes(secret)).toBe(true);
  });

  it.each(['compound', 'accessor', 'malformed'] as const)('rejects %s review diagnostics with zero partial SQLite rows and no getter invocation', variant => {
    const review = fixtureReview('ordinary review diagnostic');
    let getterCalls = 0;
    if (variant === 'compound') review.issues![0].description = 'api_key:{first:"AF_TEST_ONLY_REVIEW_CREDENTIAL",second:17}';
    if (variant === 'accessor') Object.defineProperty(review.issues![0], 'title', { enumerable: true,
      get: () => { getterCalls++; return 'password=AF_TEST_ONLY_REVIEW_CREDENTIAL'; } });
    if (variant === 'malformed') (review.issues![0] as unknown as Record<string, unknown>).description = 17;
    let code: unknown;
    try { repo.createReview(review); } catch (error) { code = (error as { code?: unknown }).code; }
    expect(code).toBe(variant === 'compound' ? 'OUTPUT_REDACTION_UNSAFE' : 'OUTPUT_TYPE_INVALID');
    expect(getterCalls).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM reviews').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM review_issues').get()).toEqual({ count: 0 });
  });

  it('sanitizes a legacy diff summary in the actual generated IPC review package without rewriting evidence bytes or hash', async () => {
    const secret = 'AF_TEST_ONLY_LEGACY_REVIEW_CREDENTIAL';
    const evidence = ordinaryDiff();
    db.prepare('UPDATE evidence SET summary=? WHERE id=?').run('password=' + secret, evidence.id);
    const result = await invokeGenerateReviewPackage();
    expect(result.success).toBe(true);
    expect(result.reviewPackage.includes(secret)).toBe(false);
    expect(result.reviewPackage.includes('+ordinary line')).toBe(true);
    const stored = repo.getEvidence(evidence.id)!;
    expect(stored.hash === evidence.hash && stored.raw_payload === evidence.raw_payload).toBe(true);
    expect(stored.summary.includes(secret)).toBe(true);
  });

  it('sanitizes legacy review titles, descriptions and test diagnostics in the actual IPC package', async () => {
    const secret = 'AF_TEST_ONLY_LEGACY_REVIEW_CREDENTIAL';
    ordinaryDiff();
    const review = fixtureReview('ordinary review diagnostic');
    repo.createReview(review);
    db.prepare('UPDATE review_issues SET title=?,description=? WHERE review_id=?')
      .run('password=' + secret, 'api_key=' + secret, review.id);
    repo.createTestRun({ id: crypto.randomUUID(), task_id: taskId, command: 'ordinary verification command',
      passed_count: 1, failed_count: 0, skipped_count: 0, duration_ms: 1, exit_code: 0,
      evidence_id: null, created_at: new Date().toISOString() });
    db.prepare('UPDATE test_runs SET command=? WHERE task_id=?').run('api_key=' + secret, taskId);
    const result = await invokeGenerateReviewPackage();
    expect(result.success).toBe(true);
    expect(result.reviewPackage.includes(secret)).toBe(false);
    expect(result.reviewPackage.includes('1 Passed | 0 Failed | 0 Skipped')).toBe(true);
    expect(repo.getReviewsByTask(taskId)[0].issues![0].title.includes(secret)).toBe(true);
  });

  it('rejects unsafe legacy diff bytes before advancing the task or laundering their original evidence identity', async () => {
    const secret = 'AF_TEST_ONLY_LEGACY_REVIEW_CREDENTIAL';
    const evidence = ordinaryDiff();
    const payload = 'api_key=' + secret;
    const hash = crypto.createHash('sha256').update(payload).digest('hex');
    db.prepare('UPDATE evidence SET raw_payload=?,hash=?,byte_size=? WHERE id=?')
      .run(payload, hash, Buffer.byteLength(payload), evidence.id);
    await expect(invokeGenerateReviewPackage()).rejects.toMatchObject({ code: 'OUTPUT_REDACTION_UNSAFE' });
    expect(repo.getTask(taskId)?.state).toBe('REVIEW_READY');
    const stored = repo.getEvidence(evidence.id)!;
    expect(stored.hash === hash && stored.raw_payload === payload).toBe(true);
  });

  it('CASE A: Standard diff path succeeds when durable GIT_DIFF exists', async () => {
    // 1. Create passing TestRun
    const testRunId = 'tr-' + crypto.randomUUID();
    repo.createTestRun({
      id: testRunId,
      task_id: taskId,
      command: 'npm test',
      passed_count: 3,
      failed_count: 0,
      skipped_count: 0,
      duration_ms: 150,
      exit_code: 0,
      evidence_id: null,
      created_at: new Date().toISOString(),
    });

    // 2. Create standard GIT_DIFF evidence
    const diffEv = artifactStore.store(
      crypto.randomUUID(),
      projectId,
      taskId,
      null,
      'GIT_DIFF',
      'Git Diff: 1 file changed',
      'diff --git a/file.js b/file.js\n+added line',
      'text/x-diff'
    );
    repo.createEvidence(diffEv);

    const res = await invokeGenerateReviewPackage();
    expect(res.success).toBe(true);
    expect(res.reviewPackage).toContain('# REVIEW PACKAGE:');
    expect(res.reviewPackage).toContain('+added line');
    expect(res.reviewPackage).toContain('Git Diff: 1 file changed');

    // Task advanced to REVIEWING
    const updatedTask = repo.getTask(taskId);
    expect(updatedTask?.state).toBe('REVIEWING');
    expect(updatedTask?.revision_count).toBe(0);
  });

  it('CASE B: Clean no-op success generates review package and advances state without GIT_DIFF', async () => {
    // 1. Create passing TestRun (5 passed, 0 failed, 1 skipped)
    const testRunId = 'tr-' + crypto.randomUUID();
    repo.createTestRun({
      id: testRunId,
      task_id: taskId,
      command: 'npm test',
      passed_count: 5,
      failed_count: 0,
      skipped_count: 1,
      duration_ms: 300,
      exit_code: 0,
      evidence_id: null,
      created_at: new Date().toISOString(),
    });

    // 2. Create durable clean GIT_STATUS evidence
    const gitStatusData = {
      status: 'SUCCESS',
      branch: 'main',
      isClean: true,
      modifiedFiles: [],
      untrackedFiles: [],
      aheadCount: 0,
      behindCount: 0,
    };
    const statusEv = artifactStore.store(
      crypto.randomUUID(),
      projectId,
      taskId,
      null,
      'GIT_STATUS',
      'Git Status: Clean on main',
      JSON.stringify(gitStatusData, null, 2),
      'application/json'
    );
    repo.createEvidence(statusEv);

    // Initial check: no GIT_DIFF evidence exists
    expect(repo.getLatestEvidence(taskId, 'GIT_DIFF')).toBeNull();

    const res = await invokeGenerateReviewPackage();
    expect(res.success).toBe(true);
    expect(res.reviewPackage).toContain('# REVIEW PACKAGE:');
    expect(res.reviewPackage).toContain('(No git diff detected)');
    expect(res.reviewPackage).toContain('Git Diff: 0 files changed (validated clean no-op working tree)');
    expect(res.reviewPackage).toContain('5 Passed | 0 Failed | 1 Skipped');

    // Verify task transitioned exactly once: REVIEW_READY -> REVIEWING
    const updatedTask = repo.getTask(taskId);
    expect(updatedTask?.state).toBe('REVIEWING');
    expect(updatedTask?.revision_count).toBe(0);

    // Verify no new test run was created
    const testRuns = db.prepare('SELECT * FROM test_runs WHERE task_id = ?').all(taskId) as any[];
    expect(testRuns.length).toBe(1);
    expect(testRuns[0].id).toBe(testRunId);
  });

  it('CASE C: Missing GIT_STATUS evidence causes rejection and preserves REVIEW_READY', async () => {
    // 1. Create passing TestRun
    repo.createTestRun({
      id: 'tr-' + crypto.randomUUID(),
      task_id: taskId,
      command: 'npm test',
      passed_count: 5,
      failed_count: 0,
      skipped_count: 0,
      duration_ms: 200,
      exit_code: 0,
      evidence_id: null,
      created_at: new Date().toISOString(),
    });

    // No GIT_STATUS and no GIT_DIFF
    const res = await invokeGenerateReviewPackage();
    expect(res.success).toBe(false);
    expect(res.error).toContain('AUTHORITATIVE_DIFF_EVIDENCE_MISSING');
    expect(res.error).toContain('No durable GIT_STATUS evidence found');

    const updatedTask = repo.getTask(taskId);
    expect(updatedTask?.state).toBe('REVIEW_READY');
    expect(updatedTask?.revision_count).toBe(0);
    expect(repo.getReviewsByTask(taskId).length).toBe(0);
  });

  it('CASE D: Dirty Git status causes rejection and preserves REVIEW_READY', async () => {
    // 1. Create passing TestRun
    repo.createTestRun({
      id: 'tr-' + crypto.randomUUID(),
      task_id: taskId,
      command: 'npm test',
      passed_count: 5,
      failed_count: 0,
      skipped_count: 0,
      duration_ms: 200,
      exit_code: 0,
      evidence_id: null,
      created_at: new Date().toISOString(),
    });

    // 2. Create DIRTY GIT_STATUS evidence
    const gitStatusData = {
      status: 'SUCCESS',
      branch: 'main',
      isClean: false,
      modifiedFiles: ['src/untracked.js'],
      untrackedFiles: [],
    };
    const statusEv = artifactStore.store(
      crypto.randomUUID(),
      projectId,
      taskId,
      null,
      'GIT_STATUS',
      'Git Status: Modified',
      JSON.stringify(gitStatusData),
      'application/json'
    );
    repo.createEvidence(statusEv);

    const res = await invokeGenerateReviewPackage();
    expect(res.success).toBe(false);
    expect(res.error).toContain('AUTHORITATIVE_DIFF_EVIDENCE_MISSING');
    expect(res.error).toContain('reports working tree is not clean');

    const updatedTask = repo.getTask(taskId);
    expect(updatedTask?.state).toBe('REVIEW_READY');
    expect(updatedTask?.revision_count).toBe(0);
    expect(repo.getReviewsByTask(taskId).length).toBe(0);
  });

  it('CASE E: Base SHA and Current SHA mismatch causes rejection and preserves REVIEW_READY', async () => {
    // Update task to have mismatched SHA
    db.prepare('UPDATE tasks SET current_sha = ? WHERE id = ?').run('different_sha_12345', taskId);

    // 1. Create passing TestRun
    repo.createTestRun({
      id: 'tr-' + crypto.randomUUID(),
      task_id: taskId,
      command: 'npm test',
      passed_count: 5,
      failed_count: 0,
      skipped_count: 0,
      duration_ms: 200,
      exit_code: 0,
      evidence_id: null,
      created_at: new Date().toISOString(),
    });

    // 2. Create clean GIT_STATUS evidence
    const gitStatusData = {
      status: 'SUCCESS',
      branch: 'main',
      isClean: true,
      modifiedFiles: [],
      untrackedFiles: [],
    };
    const statusEv = artifactStore.store(
      crypto.randomUUID(),
      projectId,
      taskId,
      null,
      'GIT_STATUS',
      'Git Status: Clean',
      JSON.stringify(gitStatusData),
      'application/json'
    );
    repo.createEvidence(statusEv);

    const res = await invokeGenerateReviewPackage();
    expect(res.success).toBe(false);
    expect(res.error).toContain('AUTHORITATIVE_DIFF_EVIDENCE_MISSING');
    expect(res.error).toContain('Base SHA');
    expect(res.error).toContain('differs from current SHA');

    const updatedTask = repo.getTask(taskId);
    expect(updatedTask?.state).toBe('REVIEW_READY');
    expect(updatedTask?.revision_count).toBe(0);
    expect(repo.getReviewsByTask(taskId).length).toBe(0);
  });

  it('CASE F: Failed or missing TestRun causes rejection and preserves REVIEW_READY', async () => {
    // 1. Clean GIT_STATUS
    const statusEv = artifactStore.store(
      crypto.randomUUID(),
      projectId,
      taskId,
      null,
      'GIT_STATUS',
      'Git Status: Clean',
      JSON.stringify({ status: 'SUCCESS', isClean: true }),
      'application/json'
    );
    repo.createEvidence(statusEv);

    // Subcase F1: No TestRun
    let res = await invokeGenerateReviewPackage();
    expect(res.success).toBe(false);
    expect(res.error).toContain('AUTHORITATIVE_DIFF_EVIDENCE_MISSING');
    expect(res.error).toContain('No authoritative TestRun found');
    expect(repo.getTask(taskId)?.state).toBe('REVIEW_READY');

    // Subcase F2: TestRun with exit_code === 1
    repo.createTestRun({
      id: 'tr-fail-' + crypto.randomUUID(),
      task_id: taskId,
      command: 'npm test',
      passed_count: 2,
      failed_count: 1,
      skipped_count: 0,
      duration_ms: 200,
      exit_code: 1,
      evidence_id: null,
      created_at: new Date().toISOString(),
    });

    res = await invokeGenerateReviewPackage();
    expect(res.success).toBe(false);
    expect(res.error).toContain('AUTHORITATIVE_DIFF_EVIDENCE_MISSING');
    expect(res.error).toContain('non-zero exit code');

    const updatedTask = repo.getTask(taskId);
    expect(updatedTask?.state).toBe('REVIEW_READY');
    expect(updatedTask?.revision_count).toBe(0);
    expect(repo.getReviewsByTask(taskId).length).toBe(0);
  });

  it('CASE G1: Malformed JSON GIT_STATUS payload causes rejection and preserves REVIEW_READY', async () => {
    // 1. Passing TestRun
    repo.createTestRun({
      id: 'tr-' + crypto.randomUUID(),
      task_id: taskId,
      command: 'npm test',
      passed_count: 5,
      failed_count: 0,
      skipped_count: 0,
      duration_ms: 200,
      exit_code: 0,
      evidence_id: null,
      created_at: new Date().toISOString(),
    });

    // Malformed JSON payload
    const malformedEv = artifactStore.store(
      crypto.randomUUID(),
      projectId,
      taskId,
      null,
      'GIT_STATUS',
      'Git Status: Broken',
      'NOT_VALID_JSON_BODY { [',
      'application/json'
    );
    repo.createEvidence(malformedEv);

    const res = await invokeGenerateReviewPackage();
    expect(res.success).toBe(false);
    expect(res.error).toContain('AUTHORITATIVE_DIFF_EVIDENCE_MISSING');
    expect(res.error).toContain('not valid JSON');
    expect(repo.getTask(taskId)?.state).toBe('REVIEW_READY');
  });

  it('CASE G2: Non-SUCCESS GIT_STATUS status field causes rejection and preserves REVIEW_READY', async () => {
    // 1. Passing TestRun
    repo.createTestRun({
      id: 'tr-' + crypto.randomUUID(),
      task_id: taskId,
      command: 'npm test',
      passed_count: 5,
      failed_count: 0,
      skipped_count: 0,
      duration_ms: 200,
      exit_code: 0,
      evidence_id: null,
      created_at: new Date().toISOString(),
    });

    // Non-SUCCESS status field in JSON
    const failedStatusEv = artifactStore.store(
      crypto.randomUUID(),
      projectId,
      taskId,
      null,
      'GIT_STATUS',
      'Git Status: Failed command',
      JSON.stringify({ status: 'ERROR', isClean: true }),
      'application/json'
    );
    repo.createEvidence(failedStatusEv);

    const res = await invokeGenerateReviewPackage();
    expect(res.success).toBe(false);
    expect(res.error).toContain('AUTHORITATIVE_DIFF_EVIDENCE_MISSING');
    expect(res.error).toContain('status is not SUCCESS');

    const updatedTask = repo.getTask(taskId);
    expect(updatedTask?.state).toBe('REVIEW_READY');
    expect(updatedTask?.revision_count).toBe(0);
    expect(repo.getReviewsByTask(taskId).length).toBe(0);
  });

  it('CASE H: Incompatible task state causes rejection', async () => {
    // Set task to PLANNED
    db.prepare('UPDATE tasks SET state = ? WHERE id = ?').run('PLANNED', taskId);

    repo.createTestRun({
      id: 'tr-' + crypto.randomUUID(),
      task_id: taskId,
      command: 'npm test',
      passed_count: 5,
      failed_count: 0,
      skipped_count: 0,
      duration_ms: 200,
      exit_code: 0,
      evidence_id: null,
      created_at: new Date().toISOString(),
    });

    const statusEv = artifactStore.store(
      crypto.randomUUID(),
      projectId,
      taskId,
      null,
      'GIT_STATUS',
      'Git Status: Clean',
      JSON.stringify({ status: 'SUCCESS', isClean: true }),
      'application/json'
    );
    repo.createEvidence(statusEv);

    const res = await invokeGenerateReviewPackage();
    expect(res.success).toBe(false);
    expect(res.error).toContain('AUTHORITATIVE_DIFF_EVIDENCE_MISSING');
    expect(res.error).toContain('Task is not in REVIEW_READY or REVIEWING state');

    expect(repo.getTask(taskId)?.state).toBe('PLANNED');
  });
});
