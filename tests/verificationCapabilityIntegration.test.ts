import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ProcessRunner } from '../src/core/services/ProcessRunner';
import { VerificationCapabilityService } from '../src/core/services/VerificationCapabilityService';

describe('issued capability process boundary', () => {
  let root: string;
  let database: Database.Database;
  let service: VerificationCapabilityService;
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-cap-process-')));
    database = new Database(':memory:');
    database.pragma('foreign_keys=ON');
    MigrationRunner.run(database);
    const repo = new Repository(database);
    const now = new Date().toISOString();
    repo.createProject({ id: 'P', name: 'Process fixture', description: null, repository_path: root, default_branch: 'main',
      status: 'READY', contract: null, created_at: now, updated_at: now, started_at: null, completed_at: null });
    service = new VerificationCapabilityService(repo, () => '1'.repeat(64));
  });
  afterEach(() => {
    database.close();
    vi.restoreAllMocks();
    if (fs.realpathSync.native(root) !== root || !path.basename(root).startsWith('af-cap-process-')) throw new Error('FIXTURE_BOUNDARY_CHANGED');
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function approve(args: string[]) {
    const payload = service.propose('P', process.execPath, args, root);
    const reference = await service.approve(payload, async () => true);
    const boundary = service.createProcessBoundary(reference, 'P', payload.executable.path, payload.args, root);
    return { payload, reference, boundary };
  }

  it('starts the exact approved executable with the boundary environment', async () => {
    const script = path.join(root, 'environment.js');
    fs.writeFileSync(script, "process.stdout.write(JSON.stringify({value:process.env.AF_CAPABILITY_SENTINEL??null,profile:process.env.USERPROFILE??null,home:process.env.HOME??null,path:process.env.PATH}));");
    const { payload, boundary } = await approve(['environment.js']);
    const result = await ProcessRunner.execute({ executable: payload.executable.path, args: payload.args, cwd: root, timeoutMs: 10000,
      verificationBoundary: boundary, env: { AF_CAPABILITY_SENTINEL: 'fixture-value-must-not-inherit' }, allowedEnvKeys: ['AF_CAPABILITY_SENTINEL'] });
    expect(result.processStart).toBe('STARTED_PROVEN');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ value: null, profile: '', home: '', path: boundary.environment.PATH });
    expect(boundary.environment).not.toHaveProperty('NODE_OPTIONS');
  });

  it('revalidates revocation immediately before spawn', async () => {
    const { payload, reference, boundary } = await approve(['--version']);
    service.revoke(reference);
    const result = await ProcessRunner.execute({ executable: payload.executable.path, args: payload.args, cwd: root, timeoutMs: 10000, verificationBoundary: boundary });
    expect(result).toMatchObject({ pid: null, processStart: 'NOT_STARTED_PROVEN', errorCode: 'PROCESS_LAUNCH_FAILED' });
    expect(result.exitCode).not.toBe(0);
  });

  it('rejects argv drift and a copied unissued boundary without starting a child', async () => {
    const { payload, boundary } = await approve(['--version']);
    const drift = await ProcessRunner.execute({ executable: payload.executable.path, args: ['--help'], cwd: root, timeoutMs: 10000, verificationBoundary: boundary });
    expect(drift).toMatchObject({ pid: null, processStart: 'NOT_STARTED_PROVEN', errorCode: 'PROCESS_LAUNCH_FAILED' });
    const copied = await ProcessRunner.execute({ executable: payload.executable.path, args: payload.args, cwd: root, timeoutMs: 10000, verificationBoundary: { ...boundary } });
    expect(copied).toMatchObject({ pid: null, processStart: 'NOT_STARTED_PROVEN', errorCode: 'PROCESS_LAUNCH_FAILED' });
  });

  it('rejects script mutation after boundary creation and preserves process start truth', async () => {
    const script = path.join(root, 'check.js');
    fs.writeFileSync(script, 'process.stdout.write("old");');
    const { payload, boundary } = await approve(['check.js']);
    fs.writeFileSync(script, 'process.stdout.write("changed");');
    const result = await ProcessRunner.execute({ executable: payload.executable.path, args: payload.args, cwd: root, timeoutMs: 10000, verificationBoundary: boundary });
    expect(result).toMatchObject({ pid: null, processStart: 'NOT_STARTED_PROVEN', errorCode: 'PROCESS_LAUNCH_FAILED' });
    expect(result.stdout).toBe('');
  });

  it('rejects shell opt-in even with an issued boundary', async () => {
    const { payload, boundary } = await approve(['--version']);
    const result = await ProcessRunner.execute({ executable: payload.executable.path, args: payload.args, cwd: root, timeoutMs: 10000, allowShell: true, verificationBoundary: boundary });
    expect(result).toMatchObject({ pid: null, processStart: 'NOT_STARTED_PROVEN', errorCode: 'PROCESS_LAUNCH_FAILED' });
  });
});
