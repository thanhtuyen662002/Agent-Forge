import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ProcessRunner } from '../src/core/services/ProcessRunner';
import { ArtifactStore } from '../src/core/services/ArtifactStore';

describe('ProcessRunner Persistence, PID Tracking & Cancellation', () => {
  let tmpDir: string;
  let db: Database.Database;
  let repo: Repository;
  let artifactStore: ArtifactStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-test-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    artifactStore = new ArtifactStore(path.join(tmpDir, 'artifacts'));
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('should block node -e inline evaluation without spawning child process and preserve direct task/project ownership', async () => {
    repo.createProject({
      id: 'PROJ-DENIED',
      name: 'Policy Denied Project',
      description: null,
      repository_path: tmpDir,
      default_branch: 'main',
      status: 'READY',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    });

    repo.createTask({
      id: 'TSK-DENIED',
      project_id: 'PROJ-DENIED',
      milestone_id: null,
      title: 'Task with policy violation',
      description: null,
      state: 'CODING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'HIGH',
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
    });

    const res = await ProcessRunner.execute({
      executable: 'node',
      args: ['-e', 'console.log("blocked");'],
      cwd: tmpDir,
      repo,
      projectId: 'PROJ-DENIED',
      taskId: 'TSK-DENIED',
    });

    expect(res.exitCode).toBe(-1);
    expect(res.pid).toBeNull();
    expect(res.stderr).toContain('Security Policy Violation');

    const runRecord = repo.getProcessRun(res.executionId);
    expect(runRecord).not.toBeNull();
    expect(runRecord.status).toBe('FAILED');
    expect(runRecord.task_id).toBe('TSK-DENIED');
    expect(runRecord.project_id).toBe('PROJ-DENIED');
    expect(runRecord.pid).toBeNull();

    // Verify discoverable via getProcessRunsByTask
    const taskRuns = repo.getProcessRunsByTask('TSK-DENIED');
    expect(taskRuns).toHaveLength(1);
    expect(taskRuns[0].id).toBe(res.executionId);
    expect(taskRuns[0].project_id).toBe('PROJ-DENIED');
    expect(taskRuns[0].status).toBe('FAILED');
  });

  it('should execute a safe script file, track PID, and persist stdout evidence in SQLite', async () => {
    const scriptPath = path.join(tmpDir, 'safe_script.js');
    fs.writeFileSync(scriptPath, 'console.log("Safe script execution output."); process.exit(0);', 'utf8');

    // Create a mock project for evidence association
    repo.createProject({
      id: 'PROJ-PROC',
      name: 'Process Project',
      description: null,
      repository_path: tmpDir,
      default_branch: 'main',
      status: 'READY',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    });

    const res = await ProcessRunner.execute({
      executable: 'node',
      args: [scriptPath],
      cwd: tmpDir,
      repo,
      artifactStore,
      projectId: 'PROJ-PROC',
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Safe script execution output.');
    expect(res.pid).toBeTypeOf('number');

    const runRecord = repo.getProcessRun(res.executionId);
    expect(runRecord).not.toBeNull();
    expect(runRecord.status).toBe('COMPLETED');
    expect(runRecord.exit_code).toBe(0);
    expect(runRecord.pid).toBe(res.pid);
    expect(runRecord.stdout_evidence_id).toBeDefined();
  });

  it('should associate process runs directly with task_id and remain discoverable even with empty output or policy denials', async () => {
    repo.createProject({
      id: 'PROJ-EMPTY',
      name: 'Empty Process Project',
      description: null,
      repository_path: tmpDir,
      default_branch: 'main',
      status: 'READY',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    });

    repo.createTask({
      id: 'TSK-EMPTY-PROC',
      project_id: 'PROJ-EMPTY',
      milestone_id: null,
      title: 'Task with silent process',
      description: null,
      state: 'CODING',
      paused_from_state: null,
      priority: 'LOW',
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
    });

    const silentScript = path.join(tmpDir, 'silent.js');
    fs.writeFileSync(silentScript, 'process.exit(0);', 'utf8'); // Emits zero stdout and stderr

    const res = await ProcessRunner.execute({
      executable: 'node',
      args: [silentScript],
      cwd: tmpDir,
      repo,
      projectId: 'PROJ-EMPTY',
      taskId: 'TSK-EMPTY-PROC',
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('');

    // Query directly by task_id - must be discoverable despite zero output / no evidence record
    const taskRuns = repo.getProcessRunsByTask('TSK-EMPTY-PROC');
    expect(taskRuns).toHaveLength(1);
    expect(taskRuns[0].id).toBe(res.executionId);
    expect(taskRuns[0].task_id).toBe('TSK-EMPTY-PROC');
    expect(taskRuns[0].project_id).toBe('PROJ-EMPTY');
    expect(taskRuns[0].status).toBe('COMPLETED');
    expect(taskRuns[0].stdout_evidence_id).toBeNull();
  });

  it('should cancel a running process, terminate its tree, and record CANCELLED in DB', async () => {
    const longScript = path.join(tmpDir, 'long_script.js');
    fs.writeFileSync(
      longScript,
      'setInterval(() => { console.log("still running"); }, 1000);',
      'utf8'
    );

    const execPromise = ProcessRunner.execute({
      executable: 'node',
      args: [longScript],
      cwd: tmpDir,
      repo,
    });

    // Wait 150ms for process to spawn and establish PID
    await new Promise((r) => setTimeout(r, 150));

    // Get active execution ID and cancel it
    const activeRuns = db.prepare("SELECT id FROM process_runs WHERE status = 'RUNNING'").all() as { id: string }[];
    expect(activeRuns.length).toBeGreaterThan(0);
    const activeId = activeRuns[0].id;

    const cancelledOk = ProcessRunner.cancel(activeId);
    expect(cancelledOk).toBe(true);

    const res = await execPromise;
    expect(res.cancelled).toBe(true);

    const finalRecord = repo.getProcessRun(activeId);
    expect(finalRecord).not.toBeNull();
    expect(finalRecord.status).toBe('CANCELLED');
  });
});
