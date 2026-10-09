import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import { ProcessRunner, type ProcessRunResult } from '../src/core/services/ProcessRunner';
import { captureRepositoryRoot } from '../src/core/services/RepositoryRootIdentity';

// Synthetic fixtures only. Boolean/hash assertions keep rejected output out
// of assertion diagnostics; this file runs through the protected test runner.
const secret = 'AF_TEST_ONLY_RUNTIME_CREDENTIAL';
const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

describe('real process output and durable observation sanitization', () => {
  let root: string;
  let db: Database.Database;
  let repo: Repository;
  let artifacts: ArtifactStore;

  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-runtime-output-')));
    execFileSync('git', ['init', '-q', '--template=', '--initial-branch=main'], { cwd: root, stdio: 'ignore', windowsHide: true });
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    artifacts = new ArtifactStore(path.join(root, 'artifacts'), 1);
    repo.createProject({ id: 'runtime-output-project', name: 'Fixture', description: null,
      repository_path: root, default_branch: 'main', status: 'READY', contract: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), started_at: null, completed_at: null,
    }, captureRepositoryRoot(root));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    if (!path.basename(root).startsWith('af-runtime-output-') || fs.realpathSync.native(root) !== root) {
      throw new Error('FIXTURE_BOUNDARY_CHANGED');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  function script(stdout: string, stderr = 'ordinary failure diagnostic', argument?: string): string {
    const scriptPath = path.join(root, 'fixture.cjs');
    fs.writeFileSync(scriptPath, 'process.stdout.write(' + JSON.stringify(stdout) + ');' +
      'process.stderr.write(' + JSON.stringify(stderr) + ');' +
      (argument ? 'if(process.argv[2]!==' + JSON.stringify(argument) + ') process.exitCode=9;' : ''), 'utf8');
    return scriptPath;
  }

  function assertEvidence(id: string | null | undefined, expected: string): void {
    expect(typeof id === 'string').toBe(true);
    const evidence = repo.getEvidence(id!);
    expect(evidence !== null).toBe(true);
    const bytes = artifacts.read(evidence!);
    expect(bytes.includes(secret)).toBe(false);
    expect(bytes === expected).toBe(true);
    expect(evidence!.hash === sha256(bytes)).toBe(true);
    expect(evidence!.byte_size === Buffer.byteLength(bytes)).toBe(true);
    expect(evidence!.summary.includes(secret)).toBe(false);
  }

  it('redacts the returned process matrix and actual SQLite/file bytes without rewriting executable arguments', async () => {
    const matrix = [
      'sk-proj-' + secret.repeat(2), 'AIza' + secret, 'npm_' + secret,
      'api_key=' + secret, 'password="' + secret + '\nsecond-fixture-line"',
      'https://fixture-user:' + secret + '@example.invalid/path', 'Bearer ' + secret,
      'eyJhbGciOiJub25lIn0.eyJmaXh0dXJlIjp0cnVlfQ.' + secret,
      '-----BEGIN PRIVATE KEY-----\n' + secret + '\n-----END PRIVATE KEY-----',
      JSON.stringify(JSON.stringify({ password: secret })),
      'OPENAI_API_KEY=' + secret, 'AWS_SESSION_TOKEN=' + secret,
    ].join('\n');
    const argument = 'password=' + secret;
    const result = await ProcessRunner.execute({ executable: process.execPath,
      args: [script(matrix, 'api_key=' + secret, argument), argument], cwd: root,
      repo, artifactStore: artifacts, projectId: 'runtime-output-project' });
    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBeNull();
    expect((result.stdout + result.stderr + result.command).includes(secret)).toBe(false);
    expect(result.stdout.includes('[REDACTED_SECRET]')).toBe(true);
    expect(result.processStart).toBe('STARTED_PROVEN');
    expect(result.processTermination).toBe('PROCESS_TREE_TERMINATED_PROVEN');
    const run = repo.getProcessRun(result.executionId);
    expect(run.status).toBe('COMPLETED');
    expect(run.exit_code).toBe(0);
    expect(run.command.includes(secret)).toBe(false);
    assertEvidence(result.stdoutEvidenceId, result.stdout);
    assertEvidence(result.stderrEvidenceId, result.stderr);
  });

  it.each([false, true])('fails unsafe zero-exit output with truthful lifecycle and no partial success, defer=%s', async deferPersistence => {
    const unsafe = 'api_key:{first:"' + secret + '",second:"fixture-second-member"}';
    let result: ProcessRunResult | undefined;
    let rejected = false;
    try {
      result = await ProcessRunner.execute({ executable: process.execPath,
        args: [script(unsafe)], cwd: root, repo, artifactStore: artifacts,
        projectId: 'runtime-output-project', deferPersistence });
    } catch { rejected = true; }
    expect(rejected).toBe(false);
    expect(result?.errorCode).toBe('OUTPUT_REDACTION_UNSAFE');
    expect(result?.exitCode).toBe(0);
    expect(result?.processStart).toBe('STARTED_PROVEN');
    expect(result?.processTermination).toBe('PROCESS_TREE_TERMINATED_PROVEN');
    expect((result!.stdout + result!.stderr).includes(secret)).toBe(false);
    expect(result!.stdout).toBe('');
    expect(ProcessRunner.getActiveProcessCount()).toBe(0);
    if (deferPersistence) {
      expect(repo.getProcessRun(result!.executionId) == null).toBe(true);
      expect(db.prepare('SELECT COUNT(*) AS count FROM evidence').get()).toEqual({ count: 0 });
    } else {
      const run = repo.getProcessRun(result!.executionId);
      expect(run.status).toBe('FAILED');
      expect(run.exit_code).toBe(0);
      expect(run.pid === result!.pid).toBe(true);
      expect(run.end_time !== null).toBe(true);
      expect(run.stdout_evidence_id).toBeNull();
      assertEvidence(result!.stderrEvidenceId, result!.stderr);
    }
  });

  it('retries a durable fence without converting unsafe zero-exit output into COMPLETED', async () => {
    const update = vi.spyOn(repo, 'updateProcessRun').mockImplementationOnce(() => { throw new Error('password=' + secret); });
    let rejected = false;
    try {
      await ProcessRunner.execute({ executable: process.execPath, args: [script('api_key:{first:"' + secret + '",second:17}')],
        cwd: root, repo, artifactStore: artifacts, projectId: 'runtime-output-project' });
    } catch (error) { rejected = error instanceof Error && !error.message.includes(secret); }
    expect(rejected).toBe(true);
    const entries = ProcessRunner.getPersistenceFencedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].result.exitCode).toBe(0);
    expect(entries[0].result.errorCode).toBe('OUTPUT_REDACTION_UNSAFE');
    update.mockRestore();
    const recovered = await ProcessRunner.retryPersistenceFenced(entries[0].executionId, repo);
    expect(recovered.exitCode).toBe(0);
    expect(repo.getProcessRun(recovered.executionId).status).toBe('FAILED');
    expect(ProcessRunner.getActiveProcessCount()).toBe(0);
  });

  it('protects direct diagnostic writes and rejects alternate inline evidence without laundering its hash', () => {
    repo.createProcessRun({ id: 'direct-process', pid: null, project_id: 'runtime-output-project', command: 'password=' + secret,
      working_directory: root, status: 'FAILED', start_time: new Date().toISOString() });
    expect(repo.getProcessRun('direct-process').command.includes(secret)).toBe(false);
    const unsafe = 'api_key=' + secret;
    let code: unknown;
    try {
      repo.createEvidence({ id: 'unsafe-evidence', project_id: 'runtime-output-project', task_id: null, attempt_id: null,
        evidence_type: 'CUSTOM', storage_type: 'INLINE', file_path: null, hash: sha256(unsafe), byte_size: Buffer.byteLength(unsafe),
        content_type: 'text/plain', summary: unsafe, raw_payload: unsafe, created_at: new Date().toISOString() });
    } catch (error) { code = (error as { code?: unknown }).code; }
    expect(code).toBe('OUTPUT_REDACTION_UNSAFE');
    expect(repo.getEvidence('unsafe-evidence')).toBeNull();
  });
});
