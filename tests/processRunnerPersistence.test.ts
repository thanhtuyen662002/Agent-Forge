import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ProcessRunner } from '../src/core/services/ProcessRunner';

describe('ProcessRunner Persistence & Cancellation', () => {
  let db: Database.Database;
  let repo: Repository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should persist process run record in SQLite and record terminal exit code', async () => {
    const res = await ProcessRunner.execute({
      executable: 'node',
      args: ['-e', 'console.log("hello from process runner"); process.exit(0);'],
      cwd: process.cwd(),
      repo,
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('hello from process runner');

    const runRecord = repo.getProcessRun(res.executionId);
    expect(runRecord).not.toBeNull();
    expect(runRecord.status).toBe('COMPLETED');
    expect(runRecord.exit_code).toBe(0);
  });

  it('should reject policy violating executable and persist failure without spawning', async () => {
    const res = await ProcessRunner.execute({
      executable: 'cmd.exe',
      args: ['/c', 'dir'],
      cwd: process.cwd(),
      allowShell: true,
      repo,
    });

    expect(res.exitCode).toBe(-1);
    expect(res.stderr).toContain('Security Policy Violation');

    const runRecord = repo.getProcessRun(res.executionId);
    expect(runRecord).not.toBeNull();
    expect(runRecord.status).toBe('FAILED');
  });
});
