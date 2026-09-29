import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ProcessRunner } from '../src/core/services/ProcessRunner';

describe('ProcessRunner startup and timeout recovery', () => {
  let db: Database.Database;
  let repo: Repository;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'process-runner-recovery-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
  });

  afterEach(async () => {
    await ProcessRunner.terminateAllProcesses();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('terminalizes a RUNNING row when spawn throws synchronously', async () => {
    const executionId = crypto.randomUUID();
    const scriptPath = path.join(tempDir, 'sync-spawn-failure.js');
    fs.writeFileSync(scriptPath, 'process.exit(0);', 'utf8');

    const result = await ProcessRunner.execute({
      executionId,
      executable: process.execPath,
      args: [scriptPath],
      // Node validates cwd synchronously. Keep this runtime-only invalid value
      // out of the public TypeScript contract while exercising the failure path.
      cwd: 123 as unknown as string,
      repo,
    });

    expect(result.executionId).toBe(executionId);
    expect(result.errorCode).toBe('PROCESS_LAUNCH_FAILED');
    expect(result.processStart).toBe('NOT_STARTED_PROVEN');
    expect(result.processTermination).toBe('NOT_APPLICABLE');
    expect(result.stderr).toContain('Failed to start process');
    expect(result.stderr).toContain('ERR_INVALID_ARG_TYPE');
    expect(result.stderr).not.toContain('Received type');

    const row = repo.getProcessRun(executionId);
    expect(row).not.toBeNull();
    expect(row.status).toBe('FAILED');
    expect(row.exit_code).toBe(-1);
    expect(row.end_time).toBeTruthy();
  });

  it('fences a synchronous startup failure when terminal persistence fails, then retries idempotently', async () => {
    const executionId = crypto.randomUUID();
    const scriptPath = path.join(tempDir, 'fenced-spawn-failure.js');
    fs.writeFileSync(scriptPath, 'process.exit(0);', 'utf8');

    const originalUpdate = repo.updateProcessRun.bind(repo);
    repo.updateProcessRun = (() => {
      throw new Error('simulated database outage');
    }) as Repository['updateProcessRun'];

    await expect(
      ProcessRunner.execute({
        executionId,
        executable: process.execPath,
        args: [scriptPath],
        cwd: 123 as unknown as string,
        repo,
      })
    ).rejects.toThrow('DURABLE_TERMINAL_UPDATE_FAILED');

    expect(repo.getProcessRun(executionId)?.status).toBe('RUNNING');
    expect(ProcessRunner.getPersistenceFencedEntry(executionId)?.status).toBe('PERSISTENCE_FENCED');
    expect(ProcessRunner.getActiveProcessCount()).toBeGreaterThanOrEqual(1);

    repo.updateProcessRun = originalUpdate;
    const retried = await ProcessRunner.retryPersistenceFenced(executionId, repo);
    expect(retried.errorCode).toBe('PROCESS_LAUNCH_FAILED');
    expect(repo.getProcessRun(executionId)?.status).toBe('FAILED');
    expect(ProcessRunner.getPersistenceFencedEntry(executionId)).toBeUndefined();
  });

  it('settles and terminates the child when PID persistence fails during startup', async () => {
    const executionId = crypto.randomUUID();
    const scriptPath = path.join(tempDir, 'pid-persistence-failure.js');
    fs.writeFileSync(scriptPath, 'setTimeout(() => {}, 10000);', 'utf8');

    const originalUpdatePid = repo.updateProcessRunPid.bind(repo);
    repo.updateProcessRunPid = (() => {
      throw new Error('simulated PID persistence outage');
    }) as Repository['updateProcessRunPid'];

    const result = await ProcessRunner.execute({
      executionId,
      executable: process.execPath,
      args: [scriptPath],
      cwd: tempDir,
      repo,
    });

    repo.updateProcessRunPid = originalUpdatePid;
    expect(result.errorCode).toBe('PROCESS_LAUNCH_FAILED');
    expect(result.processStart).toBe('START_AMBIGUOUS');
    expect(repo.getProcessRun(executionId)?.status).toBe('FAILED');
    expect(ProcessRunner.getActiveProcessCount()).toBe(0);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['nan', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['over maximum', ProcessRunner.MAX_TIMEOUT_MS + 1],
    ['wrong runtime type', '1000'],
  ])('rejects %s timeout values without starting a process', async (_label, timeoutMs) => {
    const scriptPath = path.join(tempDir, 'invalid-timeout.js');
    fs.writeFileSync(scriptPath, 'process.exit(0);', 'utf8');

    const result = await ProcessRunner.execute({
      executable: process.execPath,
      args: [scriptPath],
      cwd: tempDir,
      timeoutMs: timeoutMs as unknown as number,
    });

    expect(result.errorCode).toBe('PROCESS_LAUNCH_FAILED');
    expect(result.stderr).toContain('INVALID_TIMEOUT_MS');
    expect(result.processStart).toBe('NOT_STARTED_PROVEN');
    expect(ProcessRunner.getActiveProcessCount()).toBe(0);
  });

  it('accepts the maximum timer-safe timeout and clears it after normal completion', async () => {
    const scriptPath = path.join(tempDir, 'maximum-timeout.js');
    fs.writeFileSync(scriptPath, 'process.exit(0);', 'utf8');

    const result = await ProcessRunner.execute({
      executable: process.execPath,
      args: [scriptPath],
      cwd: tempDir,
      timeoutMs: ProcessRunner.MAX_TIMEOUT_MS,
    });

    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBeNull();
    expect(ProcessRunner.getActiveProcessCount()).toBe(0);
  });
});
