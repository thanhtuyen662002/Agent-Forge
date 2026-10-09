import { captureRepositoryRoot } from '../src/core/services/RepositoryRootIdentity';
import { execFileSync as initializeFixtureGit } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { VerificationCapabilityService } from '../src/core/services/VerificationCapabilityService';
import { registerIpcHandlers, IpcSenderTrustError } from '../src/electron/ipcHandlers';

const native = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<any>>(),
  confirm: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, listener: any) => native.handlers.set(channel, listener) },
  dialog: { showMessageBox: native.confirm, showOpenDialog: vi.fn() },
  app: { getPath: vi.fn() },
}));

describe('native owner verification capability IPC', () => {
  let root: string;
  let database: Database.Database;
  let repo: Repository;
  const trusted = { senderFrame: { url: 'http://localhost:5173/settings' } };
  const save = (commands: unknown, extra = {}) => native.handlers.get('verification:saveCommands')!(trusted, { projectId: 'P', commands, ...extra });
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    native.handlers.clear();
    native.confirm.mockReset().mockResolvedValue({ response: 1 });
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-cap-ipc-')));
    database = new Database(':memory:');
    database.pragma('foreign_keys=ON');
    MigrationRunner.run(database);
    repo = new Repository(database);
    const now = new Date().toISOString();
    if (!fs.existsSync(path.join(root, '.git'))) initializeFixtureGit('git', ['init', '-q', '--template=', '--initial-branch=main'], { cwd: root, stdio: 'ignore', windowsHide: true });
    repo.createProject({ id: 'P', name: 'Owned test project', repository_path: root, default_branch: 'main',
      description: null, status: 'READY', contract: null, created_at: now, updated_at: now, started_at: null, completed_at: null }, captureRepositoryRoot(root));
    registerIpcHandlers(repo, {} as any, {} as any, {} as any, {} as any, undefined, undefined, undefined, undefined, {} as any);
  });
  afterEach(() => {
    database.close();
    vi.restoreAllMocks();
    if (fs.realpathSync.native(root) !== root || !path.basename(root).startsWith('af-cap-ipc-')) throw new Error('FIXTURE_BOUNDARY_CHANGED');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('requires explicit native confirmation despite a trusted renderer frame', async () => {
    expect(await save({ TEST: 'node --version' })).toEqual({ success: false, error: 'OWNER_APPROVAL_REQUIRED' });
    expect(repo.getVerificationCommandsByProject('P')).toEqual([]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM verification_capabilities').get()).toEqual({ count: 0 });
    expect(native.confirm).toHaveBeenCalledWith(expect.objectContaining({ buttons: ['Approve', 'Cancel'], defaultId: 1, cancelId: 1 }));
  });

  it('rejects transport approval claims and untrusted senders before any native prompt', async () => {
    expect(await save({ TEST: 'node --version' }, { ownerApproved: true })).toMatchObject({ success: false });
    await expect(native.handlers.get('verification:saveCommands')!({ senderFrame: { url: 'https://remote.example/' } },
      { projectId: 'P', commands: { TEST: 'node --version' } })).rejects.toBeInstanceOf(IpcSenderTrustError);
    expect(native.confirm).not.toHaveBeenCalled();
  });

  it('persists exact approved grants and revokes previously sealed references on replacement and removal', async () => {
    native.confirm.mockResolvedValue({ response: 0 });
    const first = await save({ TEST: 'node --version' });
    expect(first.success).toBe(true);
    const old = first.commands[0];
    const service = new VerificationCapabilityService(repo);
    expect(service.validate(old.capability, 'P', old.executable, old.args, root)).toMatchObject({ project_id: 'P' });
    const second = await save({ TEST: 'node --help' });
    expect(second.success).toBe(true);
    expect(() => service.validate(old.capability, 'P', old.executable, old.args, root)).toThrow('CAPABILITY_REVOKED');
    expect(await save({ TEST: null })).toEqual({ success: true, commands: [] });
    expect(() => service.validate(second.commands[0].capability, 'P', second.commands[0].executable, second.commands[0].args, root)).toThrow('CAPABILITY_REVOKED');
  });

  it.each(['node -e evil()', 'npm exec anything', 'npx package', 'mshta evil.hta', 'wscript evil.vbs', 'cscript evil.vbs',
    'rundll32 evil.dll,entry', 'regsvr32 evil.dll', 'python -c evil()', 'node ../outside.js'])('rejects %s without offering approval', async (command) => {
    native.confirm.mockResolvedValue({ response: 0 });
    expect(await save({ TEST: command })).toMatchObject({ success: false });
    expect(native.confirm).not.toHaveBeenCalled();
    expect(repo.getVerificationCommandsByProject('P')).toEqual([]);
  });

  it('detects script changes during native confirmation and creates no grant', async () => {
    fs.writeFileSync(path.join(root, 'verify.js'), 'process.exit(0);');
    native.confirm.mockImplementation(async () => {
      fs.writeFileSync(path.join(root, 'verify.js'), 'process.exit(1);');
      return { response: 0 };
    });
    expect(await save({ TEST: 'node verify.js' })).toMatchObject({ success: false });
    expect(repo.getVerificationCommandsByProject('P')).toEqual([]);
  });

  it('preserves a safe npm test by approving its direct bound script, with no npm or lifecycle indirection', async () => {
    fs.writeFileSync(path.join(root, 'verify.js'), 'process.exit(0);');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node verify.js' } }));
    native.confirm.mockResolvedValue({ response: 0 });
    const saved = await save({ TEST: 'npm test' });
    expect(saved.success).toBe(true);
    expect(saved.commands[0].args).toEqual(['verify.js']);
    expect(path.basename(saved.commands[0].executable).toLowerCase()).toMatch(/^node(?:\.exe)?$/);
    const service = new VerificationCapabilityService(repo);
    // package.json is no longer an execution input after owner approval.
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'npm exec malicious' } }));
    expect(() => service.validate(saved.commands[0].capability, 'P', saved.commands[0].executable, saved.commands[0].args, root)).not.toThrow();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node verify.js', pretest: 'node unexpected.js' } }));
    native.confirm.mockClear();
    expect(await save({ TEST: 'npm test' })).toMatchObject({ success: false });
    expect(native.confirm).not.toHaveBeenCalled();
  });

  it('serializes confirmation and refuses to overwrite a concurrently changed command set', async () => {
    let finish!: (value: { response: number }) => void;
    native.confirm.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = save({ TEST: 'node --version' });
    expect(await save({ TEST: 'node --help' })).toEqual({ success: false, error: 'CAPABILITY_APPROVAL_IN_PROGRESS' });
    repo.setProjectVerificationCommands('P', { TEST: { executable: 'node', args: ['legacy.js'] } });
    finish({ response: 0 });
    expect(await pending).toEqual({ success: false, error: 'CAPABILITY_BINDING_MISMATCH' });
    expect(repo.getVerificationCommandsByProject('P')[0].capability).toBeNull();
    expect(database.prepare("SELECT COUNT(*) AS count FROM verification_capabilities WHERE state='ACTIVE'").get()).toEqual({ count: 0 });
  });
});
