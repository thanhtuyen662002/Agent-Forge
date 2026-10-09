import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureRepositoryRoot } from '../src/core/services/RepositoryRootIdentity';
import { RepositoryRootLease } from '../src/core/services/RepositoryRootLease';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
}

// A separate real process attempts attributes-only reparse conversion. An
// unpinned empty control must convert, so unavailable attack setup cannot pass.
const reparseProgram = String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text; using Microsoft.Win32.SafeHandles;
public static class RootLeaseAttack {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool DeviceIoControl(SafeFileHandle h,uint code,byte[] input,int length,IntPtr output,int size,out int returned,IntPtr overlapped);
 public static bool Convert(string root,string outside) {
  using(SafeFileHandle h=CreateFileW(root,0x100,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
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
   int returned; return DeviceIoControl(h,0x900a4,bytes,bytes.Length,IntPtr.Zero,0,out returned,IntPtr.Zero);
  }
 }
}
'@
$request=[Console]::ReadLine()|ConvertFrom-Json
@{ control=[RootLeaseAttack]::Convert($request.empty,$request.outside); selected=[RootLeaseAttack]::Convert($request.root,$request.outside) }|ConvertTo-Json -Compress
`;

describe('captured repository read lease', () => {
  let fixture: string;
  let repository: string;
  let head: string;
  let lease: RepositoryRootLease | undefined;

  beforeEach(() => {
    fixture = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-root-lease-')));
    repository = path.join(fixture, 'répository-😀');
    fs.mkdirSync(repository);
    git(repository, ['init', '-q', '--initial-branch=main']);
    fs.writeFileSync(path.join(repository, 'tracked.txt'), 'selected-owner');
    git(repository, ['add', '--', 'tracked.txt']);
    git(repository, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture']);
    head = git(repository, ['rev-parse', 'HEAD']);
  });

  afterEach(() => {
    lease?.close(); lease = undefined;
    if (!path.basename(fixture).startsWith('af-root-lease-') || fs.realpathSync.native(fixture) !== fixture) throw new Error('FIXTURE_BOUNDARY_CHANGED');
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  it('reads the actual selected Git tree while holding ordinary identities and releases every pin', () => {
    lease = RepositoryRootLease.acquire(captureRepositoryRoot(repository));
    expect(() => lease!.assertActive()).not.toThrow();
    expect(git(lease.cwd, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(lease.cwd, ['-c', 'core.fsmonitor=false', 'status', '--porcelain'])).toBe('');
    const indexBefore = fs.readFileSync(path.join(repository, '.git', 'index'));
    expect(git(lease.cwd, ['diff', '--stat'])).toBe('');
    expect(fs.readFileSync(path.join(repository, '.git', 'index'))).toEqual(indexBefore);
    lease.close();
    expect(() => lease!.assertActive()).toThrow('REPOSITORY_ROOT_IDENTITY_UNAVAILABLE');
    fs.renameSync(repository, repository + '-moved');
    expect(fs.readFileSync(path.join(repository + '-moved', 'tracked.txt'), 'utf8')).toBe('selected-owner');
  });

  it('rejects a stale selected root before obtaining authority over a replacement', () => {
    const identity = captureRepositoryRoot(repository);
    fs.renameSync(repository, repository + '-original');
    fs.mkdirSync(repository);
    fs.writeFileSync(path.join(repository, 'sentinel'), 'replacement-owner');
    expect(() => RepositoryRootLease.acquire(identity)).toThrow('REPOSITORY_ROOT_IDENTITY_CHANGED');
    expect(fs.readdirSync(repository)).toEqual(['sentinel']);
    expect(fs.readFileSync(path.join(repository + '-original', 'tracked.txt'), 'utf8')).toBe('selected-owner');
  });

  it('rejects a real leaf or ancestor alias without following the outside owner', () => {
    const alias = path.join(fixture, 'alias');
    fs.symlinkSync(repository, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => RepositoryRootLease.acquire(captureRepositoryRoot(alias))).toThrow('REPOSITORY_ROOT_ALIAS');
    expect(fs.readFileSync(path.join(repository, 'tracked.txt'), 'utf8')).toBe('selected-owner');
  });

  it.runIf(process.platform === 'win32')('prevents root, parent and pinned-child replacement through actual Windows handles', () => {
    lease = RepositoryRootLease.acquire(captureRepositoryRoot(repository));
    expect(() => fs.renameSync(repository, repository + '-moved')).toThrow();
    expect(() => fs.renameSync(fixture, fixture + '-moved')).toThrow();
    expect(() => fs.renameSync(path.join(repository, '.git'), path.join(repository, '.git-moved'))).toThrow();
    expect(() => fs.rmdirSync(repository)).toThrow();
    expect(git(lease.cwd, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it.runIf(process.platform === 'win32')('denies a real attributes-only junction attack after acquisition and preserves outside bytes', () => {
    const outside = path.join(fixture, 'outside');
    const empty = path.join(fixture, 'empty-control');
    fs.mkdirSync(outside); fs.mkdirSync(empty);
    fs.writeFileSync(path.join(outside, 'sentinel'), 'outside-must-survive');
    lease = RepositoryRootLease.acquire(captureRepositoryRoot(repository));
    const observed = spawnSync(path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(reparseProgram, 'utf16le').toString('base64')],
      { input: JSON.stringify({ root: repository, outside, empty }) + '\n', encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 16384 });
    expect(observed.status).toBe(0);
    expect(JSON.parse(observed.stdout.trim())).toEqual({ control: true, selected: false });
    expect(fs.lstatSync(repository).isSymbolicLink()).toBe(false);
    expect(git(lease.cwd, ['rev-parse', 'HEAD'])).toBe(head);
    expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('outside-must-survive');
    expect(fs.readdirSync(outside)).toEqual(['sentinel']);
    fs.unlinkSync(empty);
  });

  it.runIf(process.platform === 'win32')('fails closed for an empty unprovable root and releases its partially acquired ancestry', () => {
    const empty = path.join(fixture, 'unprovable-root'); fs.mkdirSync(empty);
    expect(() => RepositoryRootLease.acquire(captureRepositoryRoot(empty))).toThrow('REPOSITORY_ROOT_IDENTITY_UNAVAILABLE');
    fs.renameSync(empty, empty + '-moved');
    fs.renameSync(fixture, fixture + '-moved');
    fs.renameSync(fixture + '-moved', fixture);
    expect(fs.readdirSync(empty + '-moved')).toEqual([]);
  });

  it.runIf(process.platform === 'linux')('retains descriptor cwd across a last-invocation path swap and rejects the stale observation', () => {
    lease = RepositoryRootLease.acquire(captureRepositoryRoot(repository));
    fs.renameSync(repository, repository + '-original');
    fs.mkdirSync(repository);
    fs.writeFileSync(path.join(repository, 'sentinel'), 'replacement-owner');
    expect(git(lease.cwd, ['rev-parse', 'HEAD'])).toBe(head);
    expect(() => lease!.assertActive()).toThrow('REPOSITORY_ROOT_IDENTITY_CHANGED');
    expect(fs.readdirSync(repository)).toEqual(['sentinel']);
    expect(fs.readFileSync(path.join(repository + '-original', 'tracked.txt'), 'utf8')).toBe('selected-owner');
  });
});
