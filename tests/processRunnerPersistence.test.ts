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

  it('should block node -e inline evaluation without spawning child process', async () => {
    const res = await ProcessRunner.execute({
      executable: 'node',
      args: ['-e', 'console.log("blocked");'],
      cwd: process.cwd(),
      repo,
    });

    expect(res.exitCode).toBe(-1);
    expect(res.pid).toBeNull();
    expect(res.stderr).toContain('Security Policy Violation');

    const runRecord = repo.getProcessRun(res.executionId);
    expect(runRecord).not.toBeNull();
    expect(runRecord.status).toBe('FAILED');
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
