import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeCheckoutIndex, ManagedGitWorktreeMutation, parseCheckoutTree } from '../src/core/services/ManagedGitWorktreeMutation';

describe('immutable checkout tree admission', () => {
  const oid = 'a'.repeat(40);
  it('retains mode, exact object ID and byte-sorted non-ASCII names', () => {
    const tree = Buffer.from(`100755 blob ${oid}\tz/script\0` + `100644 blob ${oid}\tÀ.txt\0` + `100644 blob ${oid}\ta.txt\0`);
    const entries = parseCheckoutTree(tree);
    expect(entries.map(entry => entry.name)).toEqual(['a.txt', 'z/script', 'À.txt']);
    expect(entries[1].mode).toBe(0o100755);
    const index = encodeCheckoutIndex(entries);
    expect(index.subarray(-20)).toEqual(crypto.createHash('sha1').update(index.subarray(0, -20)).digest());
  });
  it('rejects traversal, NTFS aliases, git pointers, unsupported objects and truncated records before mutation', () => {
    for (const name of ['../outside', 'C:/outside', 'file:stream', '.git/config', 'nested/.GIT/HEAD', 'trailing.', 'NUL', 'COM1.txt', 'nested\\outside']) {
      expect(() => parseCheckoutTree(Buffer.from(`100644 blob ${oid}\t${name}\0`))).toThrow();
    }
    expect(() => parseCheckoutTree(Buffer.from(`120000 blob ${oid}\tlink\0`))).toThrow();
    expect(() => parseCheckoutTree(Buffer.from(`160000 commit ${oid}\tsubmodule\0`))).toThrow();
    expect(() => parseCheckoutTree(Buffer.from(`100644 blob ${oid}\tfile`))).toThrow();
    expect(() => parseCheckoutTree(Buffer.from(`100644 blob ${oid}\tA\0` + `100644 blob ${oid}\ta\0`))).toThrow('ALIAS_COLLISION');
    expect(() => parseCheckoutTree(Buffer.from(`100644 blob ${oid}\tA\0` + `100644 blob ${oid}\ta/file\0`))).toThrow('ALIAS_COLLISION');
  });
});

describe.skipIf(process.platform !== 'win32')('real captured checkout and Git administration (service acceptance remains separate)', () => {
  let root: string, repo: string, managed: string, git: string, sha: string;
  let mutation: ManagedGitWorktreeMutation | undefined;
  const digest = '1'.repeat(64), child = `afw-${digest.slice(0, 32)}`;
  const bytes = Buffer.from([0, 10, 13, 255, 254, 192, 128, 0, 34, 36, 96]);
  let run: (args: string[], cwd?: string) => string;
  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-captured-git-')));
    repo = path.join(root, 'repo'); managed = path.join(root, 'managed');
    fs.mkdirSync(repo); fs.mkdirSync(managed);
    git = execFileSync('where.exe', ['git.exe'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
    run = (args, cwd = repo) => execFileSync(git, args, { cwd, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    run(['init', '--quiet']); run(['config', 'core.autocrlf', 'false']);
    fs.mkdirSync(path.join(repo, 'nested'));
    fs.writeFileSync(path.join(repo, 'nested', 'binary.bin'), bytes);
    fs.writeFileSync(path.join(repo, '.gitattributes'), 'nested/binary.bin export-ignore\nsubstitute.txt export-subst\n');
    fs.writeFileSync(path.join(repo, 'substitute.txt'), '$Format:%H$\n');
    fs.writeFileSync(path.join(repo, 'empty'), '');
    run(['add', '.']); run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Fixture']);
    sha = run(['rev-parse', 'HEAD']).trim();
    // Fixture-only initialization. Production initialization is a pending
    // captured-parent integration gate, deliberately not a path fallback.
    fs.mkdirSync(path.join(repo, '.git', 'worktrees'));
  });
  afterEach(async () => {
    await mutation?.close(); mutation = undefined;
    if (fs.realpathSync.native(root) !== root || !path.basename(root).startsWith('af-captured-git-')) throw new Error('FIXTURE_BOUNDARY_CHANGED');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates a real detached locked worktree with all exact blobs and a Git-readable full index', async () => {
    mutation = await ManagedGitWorktreeMutation.prepare({ gitExecutable: git, repositoryRoot: repo, managedRoot: managed }, child);
    const target = await mutation.create(sha, digest);
    expect(run(['rev-parse', 'HEAD'], target).trim()).toBe(sha);
    expect(run(['branch', '--show-current'], target).trim()).toBe('');
    expect(run(['status', '--porcelain', '-uall'], target).trim()).toBe('');
    expect(run(['ls-files', '--stage'], target)).toContain('nested/binary.bin');
    const entries = run(['worktree', 'list', '--porcelain']);
    expect(entries).toContain(`worktree ${target.replace(/\\/g, '/')}\nHEAD ${sha}\ndetached\n`);
    expect(entries).toContain('locked AgentForge managed assignment ' + digest.slice(0, 16));
    expect(fs.readFileSync(path.join(target, 'nested', 'binary.bin'))).toEqual(bytes);
    expect(fs.readFileSync(path.join(target, 'substitute.txt'), 'utf8')).toBe('$Format:%H$\n');
    expect(fs.readFileSync(path.join(repo, 'nested', 'binary.bin'))).toEqual(bytes);
    const owner = JSON.parse(fs.readFileSync(path.join(repo, '.git', 'worktrees', child, 'agent-forge-owner.json'), 'utf8'));
    expect(owner.ownershipDigest).toBe(digest);
    expect(owner.targetIdentity.fileId).toBe(fs.lstatSync(target, { bigint: true }).ino.toString());
    expect(owner.targetIdentity.volume).not.toBe('0');
    await mutation.rollbackCreated();
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(path.join(repo, '.git', 'worktrees', child))).toBe(false);
    expect(run(['worktree', 'list', '--porcelain'])).not.toContain(child);
    expect(fs.readFileSync(path.join(repo, 'nested', 'binary.bin'))).toEqual(bytes);
  });

  it('does not delete an existing checkout or sibling metadata when reservation fails', async () => {
    const occupied = path.join(managed, child); fs.mkdirSync(occupied); fs.writeFileSync(path.join(occupied, 'sentinel'), 'keep');
    const sibling = path.join(repo, '.git', 'worktrees', 'other-owner'); fs.mkdirSync(sibling); fs.writeFileSync(path.join(sibling, 'sentinel'), 'keep');
    mutation = await ManagedGitWorktreeMutation.prepare({ gitExecutable: git, repositoryRoot: repo, managedRoot: managed }, child);
    await expect(mutation.create(sha, digest)).rejects.toThrow();
    await mutation.rollbackCreated();
    expect(fs.readFileSync(path.join(occupied, 'sentinel'), 'utf8')).toBe('keep');
    expect(fs.readFileSync(path.join(sibling, 'sentinel'), 'utf8')).toBe('keep');
  });

  it('rolls back only its reserved checkout if another owner already holds the matching admin name', async () => {
    const occupied = path.join(repo, '.git', 'worktrees', child); fs.mkdirSync(occupied); fs.writeFileSync(path.join(occupied, 'sentinel'), 'keep');
    mutation = await ManagedGitWorktreeMutation.prepare({ gitExecutable: git, repositoryRoot: repo, managedRoot: managed }, child);
    await expect(mutation.create(sha, digest)).rejects.toThrow();
    await mutation.rollbackCreated();
    expect(fs.existsSync(path.join(managed, child))).toBe(false);
    expect(fs.readFileSync(path.join(occupied, 'sentinel'), 'utf8')).toBe('keep');
  });

  it('initializes a missing Git admin parent through captured ancestors and leaves the source unchanged', async () => {
    fs.rmdirSync(path.join(repo, '.git', 'worktrees'));
    mutation = await ManagedGitWorktreeMutation.prepare({ gitExecutable: git, repositoryRoot: repo, managedRoot: managed }, child);
    const target = await mutation.create(sha, digest);
    expect(run(['status', '--porcelain', '-uall'], target).trim()).toBe('');
    expect(fs.existsSync(path.join(repo, '.git', 'worktrees', child))).toBe(true);
    expect(run(['status', '--porcelain', '-uall']).trim()).toBe('');
    await mutation.rollbackCreated();
  });

  it('captures both persisted native owner identities before independent Git checks and removes only those trees', async () => {
    mutation = await ManagedGitWorktreeMutation.prepare({ gitExecutable: git, repositoryRoot: repo, managedRoot: managed }, child);
    const target = await mutation.create(sha, digest);
    await mutation.close();
    const sibling = path.join(repo, '.git', 'worktrees', 'other-owner'); fs.mkdirSync(sibling); fs.writeFileSync(path.join(sibling, 'sentinel'), 'keep');
    mutation = await ManagedGitWorktreeMutation.prepare({ gitExecutable: git, repositoryRoot: repo, managedRoot: managed }, child, false);
    await expect(mutation.removeOwned()).rejects.toThrow('NOT_ADMITTED');
    expect(await mutation.captureOwned(sha, digest)).toBe(target);
    expect(run(['rev-parse', 'HEAD'], target).trim()).toBe(sha);
    expect(run(['branch', '--show-current'], target).trim()).toBe('');
    expect(run(['status', '--porcelain', '-uall'], target).trim()).toBe('');
    expect(() => fs.writeFileSync(path.join(target, 'empty'), 'changed')).toThrow();
    expect(() => fs.writeFileSync(path.join(repo, '.git', 'worktrees', child, 'HEAD'), 'changed')).toThrow();
    await mutation.removeOwned();
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(path.join(repo, '.git', 'worktrees', child))).toBe(false);
    expect(fs.readFileSync(path.join(sibling, 'sentinel'), 'utf8')).toBe('keep');
    expect(fs.readFileSync(path.join(repo, 'nested', 'binary.bin'))).toEqual(bytes);
  });

  it('denies stale target identity even when a replacement copies the former Git pointer and receipt', async () => {
    mutation = await ManagedGitWorktreeMutation.prepare({ gitExecutable: git, repositoryRoot: repo, managedRoot: managed }, child);
    const target = await mutation.create(sha, digest);
    await mutation.close();
    fs.renameSync(target, target + '-old');
    fs.mkdirSync(target);
    fs.copyFileSync(path.join(target + '-old', '.git'), path.join(target, '.git'));
    fs.writeFileSync(path.join(target, 'new-owner-sentinel'), 'keep');
    mutation = await ManagedGitWorktreeMutation.prepare({ gitExecutable: git, repositoryRoot: repo, managedRoot: managed }, child, false);
    await expect(mutation.captureOwned(sha, digest)).rejects.toThrow('OWNER_RECEIPT_MISMATCH');
    await expect(mutation.removeOwned()).rejects.toThrow('NOT_ADMITTED');
    expect(fs.readFileSync(path.join(target, 'new-owner-sentinel'), 'utf8')).toBe('keep');
    expect(fs.readFileSync(path.join(target + '-old', 'nested', 'binary.bin'))).toEqual(bytes);
    expect(fs.existsSync(path.join(repo, '.git', 'worktrees', child, 'HEAD'))).toBe(true);
  });

  it('denies a redirected Git pointer without changing the outside repository or either owned tree', async () => {
    mutation = await ManagedGitWorktreeMutation.prepare({ gitExecutable: git, repositoryRoot: repo, managedRoot: managed }, child);
    const target = await mutation.create(sha, digest); await mutation.close();
    fs.writeFileSync(path.join(target, '.git'), `gitdir: ${path.join(repo, '.git').replace(/\\/g, '/')}\n`);
    mutation = await ManagedGitWorktreeMutation.prepare({ gitExecutable: git, repositoryRoot: repo, managedRoot: managed }, child, false);
    await expect(mutation.captureOwned(sha, digest)).rejects.toThrow('GIT_POINTER_MISMATCH');
    await expect(mutation.removeOwned()).rejects.toThrow('NOT_ADMITTED');
    expect(fs.readFileSync(path.join(target, 'nested', 'binary.bin'))).toEqual(bytes);
    expect(run(['rev-parse', 'HEAD']).trim()).toBe(sha);
    expect(fs.existsSync(path.join(repo, '.git', 'worktrees', child, 'HEAD'))).toBe(true);
  });

  it('retains a dirty owned checkout and metadata after captured independent clean-state verification', async () => {
    mutation = await ManagedGitWorktreeMutation.prepare({ gitExecutable: git, repositoryRoot: repo, managedRoot: managed }, child);
    const target = await mutation.create(sha, digest); await mutation.close();
    fs.writeFileSync(path.join(target, 'empty'), 'dirty');
    mutation = await ManagedGitWorktreeMutation.prepare({ gitExecutable: git, repositoryRoot: repo, managedRoot: managed }, child, false);
    await mutation.captureOwned(sha, digest);
    await expect(mutation.removeOwned()).rejects.toThrow('WORKTREE_DIRTY');
    expect(fs.readFileSync(path.join(target, 'empty'), 'utf8')).toBe('dirty');
    expect(fs.existsSync(path.join(repo, '.git', 'worktrees', child, 'HEAD'))).toBe(true);
  });
});
