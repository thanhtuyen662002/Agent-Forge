import { captureRepositoryRoot } from '../src/core/services/RepositoryRootIdentity';
import { execFileSync as initializeFixtureGit } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { VerificationCapabilityService } from '../src/core/services/VerificationCapabilityService';

const OWNER = '1'.repeat(64);
const OTHER = '2'.repeat(64);
describe('durable owner verification capabilities', () => {
  let root: string;
  let projectRoot: string;
  let database: Database.Database;
  let repo: Repository;
  let service: VerificationCapabilityService;
  let owner: string;
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-capability-')));
    projectRoot = path.join(root, 'project');
    fs.mkdirSync(projectRoot);
    database = new Database(path.join(root, 'state.sqlite'));
    database.pragma('foreign_keys=ON');
    MigrationRunner.run(database);
    repo = new Repository(database);
    const now = new Date().toISOString();
    if (!fs.existsSync(path.join(projectRoot, '.git'))) initializeFixtureGit('git', ['init', '-q', '--template=', '--initial-branch=main'], { cwd: projectRoot, stdio: 'ignore', windowsHide: true });
    repo.createProject({ id: 'P', name: 'Capability fixture', description: null, repository_path: projectRoot,
      default_branch: 'main', status: 'READY', contract: null, created_at: now, updated_at: now, started_at: null, completed_at: null }, captureRepositoryRoot(projectRoot));
    owner = OWNER;
    service = new VerificationCapabilityService(repo, () => owner);
  });
  afterEach(() => {
    database.close();
    const canonical = fs.realpathSync.native(root);
    if (canonical !== root || !path.basename(root).startsWith('af-capability-')) throw new Error('FIXTURE_BOUNDARY_CHANGED');
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  const proposal = () => service.propose('P', process.execPath, ['--version'], projectRoot);

  it('keeps legacy command rows unapproved and persists an explicit owner confirmation', async () => {
    repo.createVerificationCommand({ id: 'legacy', project_id: 'P', name: 'old', command_type: 'TEST', executable: process.execPath, args: ['--version'] });
    expect(database.prepare('SELECT capability_id FROM verification_commands WHERE id=?').get('legacy')).toEqual({ capability_id: null });
    const confirm = vi.fn(async () => true);
    const pending = proposal();
    const reference = await service.approve(pending, confirm);
    expect(confirm).toHaveBeenCalledOnce();
    expect(reference).toMatchObject({ version: 1, owner_principal: OWNER });
    expect(pending.executable.path).toBe(fs.realpathSync.native(process.execPath));
    const row = database.prepare('SELECT * FROM verification_capabilities WHERE id=?').get(reference.id) as any;
    expect(row.state).toBe('ACTIVE');
    expect(JSON.parse(row.approval_json)).toMatchObject({ method: 'OS_AUTHENTICATED_NATIVE_CONFIRMATION', owner_principal: OWNER, payload_hash: reference.payload_hash });
    expect(service.validate(reference, 'P', pending.executable.path, pending.args, projectRoot)).toEqual(pending);
    database.close();
    database = new Database(path.join(root, 'state.sqlite'));
    repo = new Repository(database);
    service = new VerificationCapabilityService(repo, () => owner);
    expect(service.validate(reference, 'P', pending.executable.path, pending.args, projectRoot)).toEqual(pending);
  });

  it('creates no capability after refused confirmation', async () => {
    await expect(service.approve(proposal(), async () => false)).rejects.toMatchObject({ code: 'OWNER_APPROVAL_REQUIRED' });
    expect(database.prepare('SELECT count(*) AS count FROM verification_capabilities').get()).toEqual({ count: 0 });
  });

  it('rejects owner replacement while the confirmation is pending', async () => {
    await expect(service.approve(proposal(), async () => { owner = OTHER; return true; })).rejects.toMatchObject({ code: 'CAPABILITY_OWNER_MISMATCH' });
  });

  it('rejects cross-project, changed argv, missing grant and owner mismatch', async () => {
    const pending = proposal();
    const reference = await service.approve(pending, async () => true);
    expect(() => service.validate(reference, 'other', pending.executable.path, pending.args, projectRoot)).toThrow('CAPABILITY_BINDING_MISMATCH');
    expect(() => service.validate(reference, 'P', pending.executable.path, ['--help'], projectRoot)).toThrow('CAPABILITY_BINDING_MISMATCH');
    expect(() => service.validate({ ...reference, id: 'missing' }, 'P', pending.executable.path, pending.args, projectRoot)).toThrow('CAPABILITY_NOT_FOUND');
    owner = OTHER;
    expect(() => service.validate(reference, 'P', pending.executable.path, pending.args, projectRoot)).toThrow('CAPABILITY_OWNER_MISMATCH');
  });

  it('fences stale capability versions and durable revocation', async () => {
    const pending = proposal();
    const reference = await service.approve(pending, async () => true);
    expect(() => service.validate({ ...reference, version: 2 }, 'P', pending.executable.path, pending.args, projectRoot)).toThrow('CAPABILITY_VERSION_MISMATCH');
    service.revoke(reference);
    expect(database.prepare('SELECT state,version FROM verification_capabilities WHERE id=?').get(reference.id)).toEqual({ state: 'REVOKED', version: 2 });
    expect(() => service.validate(reference, 'P', pending.executable.path, pending.args, projectRoot)).toThrow('CAPABILITY_REVOKED');
  });

  it('rejects a tampered proposal before any owner confirmation', async () => {
    const pending = proposal();
    const confirm = vi.fn(async () => true);
    await expect(service.approve({ ...pending, executable: { ...pending.executable, sha256: '0'.repeat(64) } }, confirm)).rejects.toMatchObject({ code: 'CAPABILITY_BINDING_MISMATCH' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('binds a canonical script and refuses content drift before execution', async () => {
    const script = path.join(projectRoot, 'check.js');
    fs.writeFileSync(script, 'process.exit(0);');
    const pending = service.propose('P', process.execPath, ['check.js'], projectRoot);
    const reference = await service.approve(pending, async () => true);
    expect(pending.scripts[0].binding.path).toBe(fs.realpathSync.native(script));
    fs.writeFileSync(script, 'process.exit(1);');
    expect(() => service.validate(reference, 'P', pending.executable.path, pending.args, projectRoot)).toThrow('CONTENT_HASH_CHANGED');
  });

  it('fences script mutation during an approval and creates no grant', async () => {
    const script = path.join(projectRoot, 'check.js');
    fs.writeFileSync(script, 'process.exit(0);');
    const pending = service.propose('P', process.execPath, ['check.js'], projectRoot);
    await expect(service.approve(pending, async () => { fs.writeFileSync(script, 'process.exit(1);'); return true; })).rejects.toMatchObject({ code: 'CONTENT_HASH_CHANGED' });
    expect(database.prepare('SELECT count(*) AS count FROM verification_capabilities').get()).toEqual({ count: 0 });
  });

  it('rejects replacement identity even when script bytes are unchanged', async () => {
    const script = path.join(projectRoot, 'check.js');
    const bytes = 'process.exit(0);';
    fs.writeFileSync(script, bytes);
    const pending = service.propose('P', process.execPath, ['check.js'], projectRoot);
    const reference = await service.approve(pending, async () => true);
    fs.renameSync(script, path.join(projectRoot, 'old-check.js'));
    fs.writeFileSync(script, bytes);
    expect(() => service.validate(reference, 'P', pending.executable.path, pending.args, projectRoot)).toThrow('PATH_IDENTITY_CHANGED');
  });

  it('rejects a script escaping the approved project root', () => {
    const script = path.join(root, 'outside.js');
    fs.writeFileSync(script, 'process.exit(0);');
    expect(() => service.propose('P', process.execPath, ['../outside.js'], projectRoot)).toThrow('CAPABILITY_PATH_ESCAPE');
  });

  it.each([['node', ['-e', 'process.exit(0)']], ['npm', ['exec', 'anything']], ['mshta', ['file.hta']], ['python', ['-c', 'print(1)']]] as Array<[string,string[]]>)('rejects risky candidate %s before approval', (exe, args) => {
    expect(() => service.propose('P', exe, args, projectRoot)).toThrow('INVALID_VERIFICATION_CAPABILITY');
  });
});
