import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorktreeMutationBoundary } from '../src/core/services/WorktreeMutationBoundary';

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

    it('fences relative mutation after attributes-only reparse conversion, which sharing pins cannot prevent', async () => {
      const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'sentinel'), 'keep');
      const program = String.raw`
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
} catch { @{fixtureError=$_.Exception.Message}|ConvertTo-Json -Compress }
`;
      const result = spawnSync(path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')],
        { windowsHide: true, encoding: 'utf8', input: JSON.stringify({ root: managed, outside }) + '\n' });
      if (result.status !== 0) throw new Error('REPARSE_FIXTURE_FAILED: ' + String(result.stderr).replace(/<[^>]*>|#< CLIXML/g, '').slice(0, 1200));
      const observed = JSON.parse(result.stdout) as { writeData: boolean; attributes: boolean };
      expect(observed.writeData).toBe(false);
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
