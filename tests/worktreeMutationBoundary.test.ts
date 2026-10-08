import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorktreeMutationBoundary } from '../src/core/services/WorktreeMutationBoundary';
import { WINDOWS_DIRECTORY_BOOTSTRAP, WINDOWS_DIRECTORY_BOUNDARY } from '../src/core/services/worktreeBoundaryScripts';

const reparseProgram = String.raw`
$ErrorActionPreference='Stop'
try {
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text; using Microsoft.Win32.SafeHandles;
public static class ReparseAttack {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool DeviceIoControl(SafeFileHandle h,uint code,byte[] input,int length,IntPtr output,int size,out int returned,IntPtr overlapped);
 public static bool Try(string root,string outside,uint access) {
  using(SafeFileHandle h=CreateFileW(root,access,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
   if(h.IsInvalid) return false;
   string substitute="\\??\\"+outside;
   byte[] paths=Encoding.Unicode.GetBytes(substitute+"\0"+outside+"\0");
   byte[] bytes=new byte[16+paths.Length];
   Array.Copy(BitConverter.GetBytes(0xa0000003u),0,bytes,0,4);
   Array.Copy(BitConverter.GetBytes((ushort)(8+paths.Length)),0,bytes,4,2);
   Array.Copy(BitConverter.GetBytes((ushort)(substitute.Length*2)),0,bytes,10,2);
   Array.Copy(BitConverter.GetBytes((ushort)((substitute.Length+1)*2)),0,bytes,12,2);
   Array.Copy(BitConverter.GetBytes((ushort)(outside.Length*2)),0,bytes,14,2);
   Array.Copy(paths,0,bytes,16,paths.Length);
   int returned; return DeviceIoControl(h,0x000900a4,bytes,bytes.Length,IntPtr.Zero,0,out returned,IntPtr.Zero);
  }
 }
}
'@
$request=[Console]::ReadLine()|ConvertFrom-Json
@{ writeData=[ReparseAttack]::Try($request.root,$request.outside,0x40000000); attributes=[ReparseAttack]::Try($request.root,$request.outside,0x100) }|ConvertTo-Json -Compress
} catch { @{fixtureError='REPARSE_FIXTURE_FAILED'}|ConvertTo-Json -Compress }
`;

function convertReparse(target: string, outside: string): { writeData: boolean; attributes: boolean } {
  const result = spawnSync(path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(reparseProgram, 'utf16le').toString('base64')],
    { windowsHide: true, encoding: 'utf8', input: JSON.stringify({ root: target, outside }) + '\n' });
  if (result.status !== 0) throw new Error('REPARSE_FIXTURE_FAILED');
  const observed = JSON.parse(result.stdout) as { writeData: boolean; attributes: boolean };
  expect(observed.writeData).toBe(false);
  expect(observed.attributes).toBe(true);
  return observed;
}

async function nativeHarness(source: string, managed: string, initial: Record<string, string> = {}, expectedAcquisition = true) {
  const child = spawn(path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_DIRECTORY_BOOTSTRAP, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: 'pipe' });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const request = (data: Record<string, string>) => new Promise<{ ok: boolean }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('NATIVE_FIXTURE_TIMEOUT')); }, 15_000);
    lines.once('line', line => { clearTimeout(timer); resolve(JSON.parse(line)); });
    child.stdin.write(JSON.stringify(data) + '\n');
  });
  child.stdin.write(JSON.stringify(source) + '\n');
  expect((await request({ root: managed, ...initial })).ok).toBe(expectedAcquisition);
  return { request, close: async () => {
    if (child.exitCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill(), 2000);
      child.once('close', () => { clearTimeout(timer); lines.close(); resolve(); });
      child.stdin.end(JSON.stringify({ op: 'close' }) + '\n');
    });
  } };
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error('NATIVE_BARRIER_NOT_REACHED');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const childName = 'afw-' + '1'.repeat(32);
describe('kernel worktree directory primitives (not complete service acceptance)', () => {
  let root: string;
  let managed: string;
  let boundary: WorktreeMutationBoundary | undefined;
  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-worktree-kernel-')));
    managed = path.join(root, 'managed');
    fs.mkdirSync(managed);
  });
  afterEach(async () => {
    await boundary?.close(); boundary = undefined;
    const link = path.join(managed, childName);
    if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
    if (fs.realpathSync.native(root) !== root || !path.basename(root).startsWith('af-worktree-kernel-')) throw new Error('FIXTURE_BOUNDARY_CHANGED');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('rejects unsupported native platforms before creating or deleting a child', async () => {
    const sentinel = path.join(managed, 'sentinel'); fs.writeFileSync(sentinel, 'keep');
    await expect(WorktreeMutationBoundary.acquire(managed)).rejects.toThrow('UNSUPPORTED_MUTATION_BOUNDARY');
    expect(fs.readdirSync(managed)).toEqual(['sentinel']);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('keep');
  });

  describe.skipIf(process.platform !== 'win32')('real Windows handle fences', () => {
    beforeEach(async () => { boundary = await WorktreeMutationBoundary.acquire(managed); });

    it('blocks managed-root and ancestor rename after acquisition', () => {
      expect(() => fs.renameSync(managed, managed + '-moved')).toThrow();
      expect(() => fs.renameSync(root, root + '-moved')).toThrow();
      expect(fs.existsSync(managed)).toBe(true);
    });

    it('serializes helpers through a captured exclusive operation handle and releases it on helper exit', async () => {
      const owner = { pid: process.pid, token: crypto.randomUUID(), createdAt: Date.now() };
      expect(await boundary!.acquireOperationLock(owner)).toBe(true);
      const contender = await WorktreeMutationBoundary.acquire(managed);
      try {
        expect(await contender.acquireOperationLock({ ...owner, token: crypto.randomUUID() })).toBe(false);
        await boundary!.close(); boundary = undefined;
        expect(await contender.acquireOperationLock({ ...owner, token: crypto.randomUUID() })).toBe(true);
      } finally { await contender.close(); }
      expect(fs.existsSync(path.join(managed, '.agent-forge-worktree-operation.lock'))).toBe(false);
    });

    it('recovers a dead legacy owner but retains a live legacy owner regardless of age', async () => {
      const lock = path.join(managed, '.agent-forge-worktree-operation.lock');
      const owner = { pid: process.pid, token: crypto.randomUUID(), createdAt: Date.now() };
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() - 10 * 60_000 }));
      expect(await boundary!.acquireOperationLock(owner)).toBe(false);
      expect(JSON.parse(fs.readFileSync(lock, 'utf8')).pid).toBe(process.pid);
      fs.writeFileSync(lock, JSON.stringify({ pid: 999999999, createdAt: Date.now() }));
      expect(await boundary!.acquireOperationLock(owner)).toBe(true);
      await boundary!.close(); boundary = undefined;
      expect(fs.existsSync(lock)).toBe(false);
    });

    it('denies a hardlinked legacy operation file without overwriting the outside sentinel', async () => {
      await boundary!.close(); boundary = undefined;
      const outside = path.join(root, 'outside-lock'); fs.writeFileSync(outside, JSON.stringify({ pid: 999999999 }));
      const lock = path.join(managed, '.agent-forge-worktree-operation.lock'); fs.linkSync(outside, lock);
      boundary = await WorktreeMutationBoundary.acquire(managed);
      expect(await boundary!.acquireOperationLock({ pid: process.pid, token: crypto.randomUUID(), createdAt: Date.now() })).toBe(false);
      expect(JSON.parse(fs.readFileSync(outside, 'utf8')).pid).toBe(999999999);
      expect(fs.statSync(outside).nlink).toBe(2);
    });

    it('keeps a relative create contained when an empty parent becomes a junction after the last check', async () => {
      const marker = path.join(root, 'native-entered'), release = path.join(root, 'native-release');
      const syscall = 'int result = NtCreateFile(out handle, access, ref attributes';
      expect(WINDOWS_DIRECTORY_BOUNDARY.split(syscall)).toHaveLength(2);
      const source = WINDOWS_DIRECTORY_BOUNDARY.replace(syscall,
        `if (name == "escape" && create) { File.WriteAllText(${JSON.stringify(marker)}, "entered"); while (!File.Exists(${JSON.stringify(release)})) System.Threading.Thread.Sleep(5); }\n      ${syscall}`);
      const outside = path.join(root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'sentinel'), 'keep');
      const harness = await nativeHarness(source, managed);
      try {
        expect((await harness.request({ op: 'reserve', name: childName })).ok).toBe(true);
        expect((await harness.request({ op: 'mkdir', name: childName, path: 'nested' })).ok).toBe(true);
        const creating = harness.request({ op: 'file', name: childName, path: 'nested/escape' });
        await waitForFile(marker);
        convertReparse(path.join(managed, childName, 'nested'), outside);
        fs.writeFileSync(release, 'continue');
        await creating;
        expect(fs.readdirSync(outside)).toEqual(['sentinel']);
        expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('keep');
      } finally {
        fs.writeFileSync(release, 'continue'); await harness.close();
      }
    });

    it('deletes only the captured empty object when it becomes a junction immediately before disposition', async () => {
      const marker = path.join(root, 'native-entered'), release = path.join(root, 'native-release');
      const syscall = 'if (!SetFileInformationByHandle(node.Handle, 21,';
      expect(WINDOWS_DIRECTORY_BOUNDARY.split(syscall)).toHaveLength(2);
      const source = WINDOWS_DIRECTORY_BOUNDARY.replace(syscall,
        `File.WriteAllText(${JSON.stringify(marker)}, "entered"); while (!File.Exists(${JSON.stringify(release)})) System.Threading.Thread.Sleep(5);\n      ${syscall}`);
      const outside = path.join(root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'sentinel'), 'keep');
      const harness = await nativeHarness(source, managed);
      try {
        expect((await harness.request({ op: 'reserve', name: childName })).ok).toBe(true);
        expect((await harness.request({ op: 'seal', name: childName })).ok).toBe(true);
        const deleting = harness.request({ op: 'delete-tree', name: childName });
        await waitForFile(marker);
        convertReparse(path.join(managed, childName), outside);
        fs.writeFileSync(release, 'continue');
        await deleting;
        expect(fs.readdirSync(outside)).toEqual(['sentinel']);
        expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('keep');
      } finally { fs.writeFileSync(release, 'continue'); await harness.close(); }
    });

    it('initializes missing parent segments through ordinary captured ancestors and rejects an alias in the chain', async () => {
      await boundary!.close(); boundary = undefined;
      const missing = path.join(root, 'new-parent', 'new-root');
      const initialized = await WorktreeMutationBoundary.acquire(missing, true);
      try {
        expect(fs.lstatSync(missing).isDirectory()).toBe(true);
        expect(() => fs.renameSync(path.dirname(missing), path.dirname(missing) + '-moved')).toThrow();
      } finally { await initialized.close(); }
      const outside = path.join(root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'sentinel'), 'keep');
      const alias = path.join(root, 'alias'); fs.symlinkSync(outside, alias, 'junction');
      try {
        await expect(WorktreeMutationBoundary.acquire(path.join(alias, 'new-root'), true)).rejects.toThrow();
        expect(fs.readdirSync(outside)).toEqual(['sentinel']);
      } finally { fs.unlinkSync(alias); }
    });

    it('refuses missing-parent creation when the checked existing anchor was replaced before native acquisition', async () => {
      const expected = fs.lstatSync(managed, { bigint: true });
      await boundary!.close(); boundary = undefined;
      const original = managed + '-old'; fs.renameSync(managed, original); fs.mkdirSync(managed);
      fs.writeFileSync(path.join(managed, 'new-owner-sentinel'), 'keep');
      const requested = path.join(managed, 'new-parent', 'new-root');
      const harness = await nativeHarness(WINDOWS_DIRECTORY_BOUNDARY, requested, { initialize: '1', anchor: managed,
        anchorId: expected.ino.toString(), anchorCreated: (expected.birthtimeNs / 100n + 116444736000000000n).toString() }, false);
      await harness.close();
      expect(fs.readdirSync(managed)).toEqual(['new-owner-sentinel']);
      expect(fs.readFileSync(path.join(managed, 'new-owner-sentinel'), 'utf8')).toBe('keep');
      expect(fs.readdirSync(original)).toEqual([]);
    });

    it('resolves a genuine Windows short spelling through no-follow captured segments during missing-root initialization', async () => {
      const program = String.raw`
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class ShortFixture {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetShortPathNameW(string p,StringBuilder result,uint size);
 public static string Get(string p) { var result=new StringBuilder(32768); uint size=GetShortPathNameW(p,result,(uint)result.Capacity); if(size==0||size>=result.Capacity)throw new Exception("SHORT_PATH_UNAVAILABLE"); return result.ToString(); }
}
'@
$request=[Console]::ReadLine()|ConvertFrom-Json
[ShortFixture]::Get([string]$request.path)
`;
      const result = spawnSync(path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')],
        { windowsHide: true, encoding: 'utf8', input: JSON.stringify({ path: managed }) + '\n' });
      expect(result.status).toBe(0);
      // Filesystems with 8.3 naming disabled return the full spelling. Both
      // supported spellings are exercised without enabling volume settings.
      const short = result.stdout.trim();
      const missing = path.join(short, 'alias-parent', 'alias-root');
      const initialized = await WorktreeMutationBoundary.acquire(missing, true);
      try {
        expect(initialized.managedRoot).toBe(fs.realpathSync.native(missing));
        const candidate = await initialized.reserveChild(childName);
        expect(candidate).toBe(path.join(fs.realpathSync.native(missing), childName));
        await initialized.deleteEmptyChild(childName);
      } finally { await initialized.close(); }
    });

    it('fences relative mutation after attributes-only reparse conversion, which sharing pins cannot prevent', async () => {
      const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'sentinel'), 'keep');
      const observed = convertReparse(managed, outside);
      if (observed.attributes) {
        expect(fs.lstatSync(managed).isSymbolicLink()).toBe(true);
        await expect(boundary!.reserveChild(childName)).rejects.toThrow();
      }
      expect(fs.readdirSync(outside)).toEqual(['sentinel']);
      expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('keep');
    });

    it('atomically reserves and pins a new directory and deletes only its captured empty object', async () => {
      const candidate = await boundary!.reserveChild(childName);
      expect(() => fs.renameSync(candidate, candidate + '-moved')).toThrow();
      await boundary!.deleteEmptyChild(childName);
      expect(fs.existsSync(candidate)).toBe(false);
      expect(fs.existsSync(managed)).toBe(true);
    });

    it('allows ordinary Git-style child writes while denying target replacement', async () => {
      const candidate = await boundary!.reserveChild(childName);
      fs.mkdirSync(path.join(candidate, 'nested'));
      fs.writeFileSync(path.join(candidate, 'nested', 'tracked'), 'fixture');
      expect(fs.readFileSync(path.join(candidate, 'nested', 'tracked'), 'utf8')).toBe('fixture');
      expect(() => fs.renameSync(candidate, candidate + '-moved')).toThrow();
      await expect(boundary!.deleteEmptyChild(childName)).rejects.toThrow();
      expect(fs.readFileSync(path.join(candidate, 'nested', 'tracked'), 'utf8')).toBe('fixture');
    });

    it('does not claim or overwrite a pre-existing child during reservation', async () => {
      const candidate = path.join(managed, childName); fs.mkdirSync(candidate);
      fs.writeFileSync(path.join(candidate, 'sentinel'), 'keep');
      await expect(boundary!.reserveChild(childName)).rejects.toThrow();
      expect(fs.readFileSync(path.join(candidate, 'sentinel'), 'utf8')).toBe('keep');
    });

    it('captures an existing ordinary child and pins its same native identity', async () => {
      const candidate = path.join(managed, childName); fs.mkdirSync(candidate);
      expect(await boundary!.captureChild(childName)).toBe(candidate);
      expect(() => fs.renameSync(candidate, candidate + '-moved')).toThrow();
      await boundary!.deleteEmptyChild(childName);
      expect(fs.existsSync(candidate)).toBe(false);
    });

    it('writes binary and empty files through captured parents, then removes a sealed tree by handle', async () => {
      const candidate = await boundary!.reserveChild(childName);
      await boundary!.createDirectory(childName, 'nested');
      await boundary!.createDirectory(childName, 'nested/deeper');
      const bytes = Buffer.alloc(24_577);
      for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
      await boundary!.writeNewFile(childName, 'nested/deeper/binary.bin', bytes);
      await boundary!.writeNewFile(childName, 'empty', Buffer.alloc(0));
      expect(fs.readFileSync(path.join(candidate, 'nested/deeper/binary.bin'))).toEqual(bytes);
      expect(fs.statSync(path.join(candidate, 'empty')).size).toBe(0);
      expect(() => fs.renameSync(path.join(candidate, 'nested'), path.join(candidate, 'moved'))).toThrow();
      expect(() => fs.writeFileSync(path.join(candidate, 'empty'), 'changed')).toThrow();
      await expect(boundary!.deleteCapturedTree(childName)).rejects.toThrow();
      expect(fs.existsSync(candidate)).toBe(true);
      await boundary!.sealTree(childName);
      await expect(boundary!.writeNewFile(childName, 'late', Buffer.from('late'))).rejects.toThrow();
      await boundary!.deleteCapturedTree(childName);
      expect(fs.existsSync(candidate)).toBe(false);
      expect(fs.existsSync(managed)).toBe(true);
    });

    it('captures existing nested files before deletion and preserves an outside read-only hardlink', async () => {
      const candidate = path.join(managed, childName); fs.mkdirSync(candidate);
      const outside = path.join(root, 'outside-sentinel'); fs.writeFileSync(outside, 'keep');
      fs.mkdirSync(path.join(candidate, 'nested'));
      fs.linkSync(outside, path.join(candidate, 'nested', 'linked'));
      fs.chmodSync(outside, 0o444);
      try {
        await boundary!.captureChild(childName);
        await boundary!.sealTree(childName);
        expect(() => fs.writeFileSync(path.join(candidate, 'nested', 'linked'), 'changed')).toThrow();
        expect(() => fs.renameSync(path.join(candidate, 'nested'), path.join(candidate, 'moved'))).toThrow();
        await boundary!.deleteCapturedTree(childName);
        expect(fs.existsSync(candidate)).toBe(false);
        expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
        expect(fs.statSync(outside).nlink).toBe(1);
        expect(fs.statSync(outside).mode & 0o200).toBe(0);
      } finally { fs.chmodSync(outside, 0o666); }
    });

    it('denies nested reparse traversal before any captured tree deletion', async () => {
      const candidate = path.join(managed, childName); fs.mkdirSync(candidate);
      const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'sentinel'), 'keep');
      fs.writeFileSync(path.join(candidate, 'owned'), 'owned');
      fs.symlinkSync(outside, path.join(candidate, 'nested'), 'junction');
      try {
        await boundary!.captureChild(childName);
        await expect(boundary!.sealTree(childName)).rejects.toThrow();
        await expect(boundary!.deleteCapturedTree(childName)).rejects.toThrow();
        expect(fs.readFileSync(path.join(candidate, 'owned'), 'utf8')).toBe('owned');
        expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('keep');
      } finally { await boundary!.close(); fs.unlinkSync(path.join(candidate, 'nested')); }
    });

    it('rejects nested alias names and existing-file writes without overwriting an owned sentinel', async () => {
      const candidate = await boundary!.reserveChild(childName);
      await boundary!.writeNewFile(childName, 'sentinel', Buffer.from('keep'));
      for (const relative of ['../outside', 'nested/../outside', 'C:/outside', 'nested\\outside', 'NUL', 'file:stream', 'trail.', 'trail ']) {
        await expect(boundary!.writeNewFile(childName, relative, Buffer.from('changed'))).rejects.toThrow();
      }
      await expect(boundary!.writeNewFile(childName, 'sentinel', Buffer.from('changed'))).rejects.toThrow();
      expect(fs.readFileSync(path.join(candidate, 'sentinel'), 'utf8')).toBe('keep');
    });

    it('rejects an existing junction without touching its outside sentinel', async () => {
      const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'sentinel'), 'keep');
      fs.symlinkSync(outside, path.join(managed, childName), 'junction');
      await expect(boundary!.captureChild(childName)).rejects.toThrow();
      expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('keep');
    });

    it('rejects a configured root junction without reserving any outside child', async () => {
      const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'sentinel'), 'keep');
      const alias = path.join(root, 'alias'); fs.symlinkSync(outside, alias, 'junction');
      try {
        await expect(WorktreeMutationBoundary.acquire(alias)).rejects.toThrow('BOUNDARY_ROOT_ALIAS_DENIED');
        expect(fs.readdirSync(outside)).toEqual(['sentinel']);
      } finally { fs.unlinkSync(alias); }
    });

    it('allows real Git checkout into an atomically reserved, pinned empty child', async () => {
      const git = execFileSync('where.exe', ['git.exe'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
      const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
      const run = (args: string[], cwd = repo) => execFileSync(git, args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      run(['init', '--quiet']);
      fs.mkdirSync(path.join(repo, 'nested'));
      fs.writeFileSync(path.join(repo, 'nested', 'tracked'), 'real Git fixture');
      run(['add', '.']);
      run(['-c', 'user.name=BoundaryFixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Fixture']);
      const sha = run(['rev-parse', 'HEAD']).trim();
      const candidate = await boundary!.reserveChild(childName);
      run(['worktree', 'add', '--detach', candidate, sha]);
      expect(run(['rev-parse', 'HEAD'], candidate).trim()).toBe(sha);
      expect(fs.readFileSync(path.join(candidate, 'nested', 'tracked'), 'utf8')).toBe('real Git fixture');
      expect(() => fs.renameSync(candidate, candidate + '-moved')).toThrow();
    });

    it('rejects traversal, aliases and uncaptured deletion while keeping the root', async () => {
      await expect(boundary!.reserveChild('../outside')).rejects.toThrow();
      await expect(boundary!.captureChild('AFW-' + '1'.repeat(32))).rejects.toThrow();
      await expect(boundary!.deleteEmptyChild(childName)).rejects.toThrow();
      expect(fs.readdirSync(managed)).toEqual([]);
    });

    it('releases handles on close and prevents use of a released guard', async () => {
      const candidate = await boundary!.reserveChild(childName);
      await boundary!.close();
      fs.renameSync(candidate, candidate + '-moved');
      await expect(boundary!.reserveChild('afw-' + '2'.repeat(32))).rejects.toThrow('BOUNDARY_CLOSED_OR_BUSY');
    });
  });
});
