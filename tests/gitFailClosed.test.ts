import { describe, it, expect, vi, afterEach } from 'vitest';
import { GitRevisionValidationError, GitService } from '../src/core/services/GitService';
import { ProcessRunner } from '../src/core/services/ProcessRunner';
import { EvidenceCollector } from '../src/core/autonomy/evidence';
import { createWorkOrder, WorkOrder } from '../src/core/autonomy/contracts';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
import { captureRepositoryRoot } from '../src/core/services/RepositoryRootIdentity';
import { RepositoryRootLease } from '../src/core/services/RepositoryRootLease';
import crypto from 'node:crypto';
import { CoderSubmissionAdjudicationService } from '../src/core/services/CoderSubmissionAdjudicationService';
import { renameReleasedFixture } from './helpers/renameReleasedFixture';

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createGitFixture(): { root: string; baseSha: string } {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'git-revision-boundary-')));
  runGit(root, ['init', '-q']);
  runGit(root, ['config', 'user.email', 'agent-forge-tests@example.invalid']);
  runGit(root, ['config', 'user.name', 'Agent Forge Tests']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'before\n', 'utf8');
  runGit(root, ['add', '--', 'tracked.txt']);
  runGit(root, ['commit', '-q', '-m', 'base']);
  const baseSha = runGit(root, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'after\n', 'utf8');
  return { root, baseSha };
}

describe('GitService Fail-Closed Behavior', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return status ERROR for non-existent directory', async () => {
    const res = await GitService.getStatus('d:/non-existent-directory-12345');
    expect(res.status).toBe('ERROR');
    expect(res.isClean).toBe(false);
    expect(res.errorMessage).toBeDefined();
  });

  it('should return status ERROR for non-git directory', async () => {
    const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-dir-')));
    try {
      const statusRes = await GitService.getStatus(tmp);
      expect(statusRes.status).toBe('ERROR');
      expect(statusRes.isClean).toBe(false);

      const diffRes = await GitService.getDiff(tmp);
      expect(diffRes.status).toBe('ERROR');

      const shaRes = await GitService.getHeadSha(tmp);
      expect(shaRes.status).toBe('ERROR');
      expect(shaRes.sha).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('preserves exact-SHA diff semantics while placing explicit Git option boundaries', async () => {
    const fixture = createGitFixture();
    try {
      const execute = vi.spyOn(ProcessRunner, 'execute');
      const result = await GitService.getDiff(fixture.root, fixture.baseSha.toUpperCase());

      expect(result.status).toBe('SUCCESS');
      expect(result.errorCode).toBeUndefined();
      expect(result.filesChanged).toEqual(['tracked.txt']);
      expect(result.diffContent).toContain('-before');
      expect(result.diffContent).toContain('+after');
      expect(execute).toHaveBeenCalledTimes(3);
      expect(execute.mock.calls.map(([options]) => options.args.slice(4))).toEqual([
        ['diff', '--no-ext-diff', '--no-textconv', '--end-of-options', fixture.baseSha, '--'],
        ['diff', '--no-ext-diff', '--no-textconv', '--stat', '--end-of-options', fixture.baseSha, '--'],
        ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--end-of-options', fixture.baseSha, '--'],
      ]);
      for (const [options] of execute.mock.calls) {
        expect(options.args.slice(0, 4)).toEqual(['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false']);
        expect(options.env).toEqual({ GIT_OPTIONAL_LOCKS: '0', GIT_WORK_TREE: options.cwd });
      }
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects malformed revisions before spawning Git and leaves the repository unchanged', async () => {
    const fixture = createGitFixture();
    const invalidRevisions = [
      '',
      'a'.repeat(39),
      'a'.repeat(41),
      'deadbeef',
      'HEAD',
      'HEAD^',
      '--stat',
      '--output=owned.txt',
      '--',
      '../outside',
      '..\\outside',
      './relative/path',
      'C:\\repo\\base',
      'D:/repo/base',
      '\\\\server\\share\\base',
      ` ${fixture.baseSha}`,
      `${fixture.baseSha} `,
      `${fixture.baseSha}\n`,
      `${fixture.baseSha}\r`,
      `${fixture.baseSha}\t`,
      `${fixture.baseSha}\0`,
      `${fixture.baseSha}é`,
      `Ａ${fixture.baseSha.slice(1)}`,
    ];
    const execute = vi.spyOn(ProcessRunner, 'execute');
    const headBefore = runGit(fixture.root, ['rev-parse', 'HEAD']);
    const statusBefore = runGit(fixture.root, ['status', '--porcelain']);

    try {
      for (const revision of invalidRevisions) {
        const result = await GitService.getDiff(fixture.root, revision);
        expect(result.status, revision).toBe('ERROR');
        expect(result.errorCode, revision).toBe('INVALID_GIT_REVISION');
        expect(result.errorMessage, revision).toBe(
          'INVALID_GIT_REVISION: revision must be an exact 40-character hexadecimal commit SHA.'
        );
        expect(result.diffContent, revision).toBe('');
        expect(result.diffStat, revision).toBe('');
        expect(result.filesChanged, revision).toEqual([]);
      }

      expect(execute).not.toHaveBeenCalled();
      expect(runGit(fixture.root, ['rev-parse', 'HEAD'])).toBe(headBefore);
      expect(runGit(fixture.root, ['status', '--porcelain'])).toBe(statusBefore);
      expect(fs.existsSync(path.join(fixture.root, 'owned.txt'))).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('exposes a typed validation result for non-string runtime input', async () => {
    const fixture = createGitFixture();
    const execute = vi.spyOn(ProcessRunner, 'execute');
    try {
      const result = await GitService.getDiff(fixture.root, 42 as unknown as string);
      expect(result.status).toBe('ERROR');
      expect(result.errorCode).toBe('INVALID_GIT_REVISION');
      expect(execute).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('fences the autonomy evidence collector before its first Git command', async () => {
    const fixture = createGitFixture();
    const execute = vi.fn();
    const collector = new EvidenceCollector({ execute });
    const order = createWorkOrder({
      taskId: 'revision-boundary',
      objective: 'collect evidence',
      baseSha: fixture.baseSha,
      branch: 'agent/revision-boundary',
      worktree: fixture.root,
      acceptanceCriteria: ['evidence is truthful'],
      workerId: 'test-worker',
    });
    const invalidRevisions = ['--stat', `C:\\repo\\base`, `${fixture.baseSha}\n`];

    try {
      for (const revision of invalidRevisions) {
        const forgedOrder = { ...order, base_sha: revision } as WorkOrder;
        await expect(collector.collect(forgedOrder)).rejects.toBeInstanceOf(GitRevisionValidationError);
      }
      expect(execute).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects a real repository junction or symlink before any Git process', async () => {
    const selected = createGitFixture();
    const unrelated = createGitFixture();
    const alias = path.join(selected.root, 'alias');
    const execute = vi.spyOn(ProcessRunner, 'execute');
    try {
      fs.symlinkSync(unrelated.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
      for (const result of [await GitService.getStatus(alias), await GitService.getHeadSha(alias),
        await GitService.getCurrentBranch(alias), await GitService.getDiff(alias, unrelated.baseSha)]) {
        expect(result).toMatchObject({ status: 'ERROR', errorCode: 'REPOSITORY_ROOT_ALIAS' });
      }
      expect(execute).not.toHaveBeenCalled();
      expect(runGit(unrelated.root, ['rev-parse', 'HEAD'])).toBe(unrelated.baseSha);
      expect(fs.readFileSync(path.join(unrelated.root, 'tracked.txt'), 'utf8')).toBe('after\n');
    } finally {
      fs.rmSync(selected.root, { recursive: true, force: true });
      fs.rmSync(unrelated.root, { recursive: true, force: true });
    }
  });

  it('rejects a changed selected identity before invoking Git on the replacement', async () => {
    const fixture = createGitFixture();
    const identity = captureRepositoryRoot(fixture.root);
    const original = fixture.root + '-original';
    const execute = vi.spyOn(ProcessRunner, 'execute');
    try {
      renameReleasedFixture(fixture.root, original); fs.mkdirSync(fixture.root);
      expect(await GitService.getStatus(fixture.root, identity))
        .toMatchObject({ status: 'ERROR', isClean: false, errorCode: 'REPOSITORY_ROOT_IDENTITY_CHANGED' });
      expect(await GitService.getHeadSha(fixture.root, identity))
        .toMatchObject({ status: 'ERROR', sha: null, errorCode: 'REPOSITORY_ROOT_IDENTITY_CHANGED' });
      expect(execute).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(original, 'tracked.txt'), 'utf8')).toBe('after\n');
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
      fs.rmSync(original, { recursive: true, force: true });
    }
  });

  it('discards a completed branch observation when the root changes before status collection', async () => {
    const fixture = createGitFixture();
    const original = fixture.root + '-original';
    const execute = vi.spyOn(ProcessRunner, 'execute');
    const originalAcquire = RepositoryRootLease.acquire;
    const originalClose = RepositoryRootLease.prototype.close;
    const activePins = new Set<RepositoryRootLease>();
    let replaced = false;
    vi.spyOn(RepositoryRootLease, 'acquire').mockImplementation(identity => {
      const lease = originalAcquire.call(RepositoryRootLease, identity);
      if (identity.canonicalPath === fixture.root) activePins.add(lease);
      return lease;
    });
    vi.spyOn(RepositoryRootLease.prototype, 'close').mockImplementation(function (this: RepositoryRootLease) {
      originalClose.call(this);
      activePins.delete(this);
      if (this.identity.canonicalPath !== fixture.root || replaced) return;
      // ProcessRunner also holds the actual invocation lease. Replace only
      // after every read pin has been released, never while another pin lives.
      if (activePins.size !== 0) return;
      renameReleasedFixture(fixture.root, original);
      replaced = true;
      fs.mkdirSync(fixture.root);
      fs.writeFileSync(path.join(fixture.root, 'sentinel'), 'replacement-owner');
    });
    try {
      const result = await GitService.getStatus(fixture.root);
      expect(result).toMatchObject({ status: 'ERROR', branch: 'UNKNOWN', isClean: false,
        errorCode: 'REPOSITORY_ROOT_IDENTITY_CHANGED', modifiedFiles: [], untrackedFiles: [] });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(replaced).toBe(true);
      expect(fs.readFileSync(path.join(original, 'tracked.txt'), 'utf8')).toBe('after\n');
      expect(fs.readFileSync(path.join(fixture.root, 'sentinel'), 'utf8')).toBe('replacement-owner');
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
      fs.rmSync(original, { recursive: true, force: true });
    }
  });

  it.each(['selected Git', 'adjudication fingerprint'] as const)('%s reads only the captured selected working tree when local Git config redirects core.worktree outside it', async reader => {
    const fixture = createGitFixture();
    const outside = fixture.root + '-outside';
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'tracked.txt'), 'outside-owner-fixture\n');
    try {
      const selectedDiffHash = crypto.createHash('sha256').update(runGit(fixture.root, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD']) + '\n').digest('hex');
      runGit(fixture.root, ['config', 'core.worktree', outside]);
      const receipt = captureRepositoryRoot(fixture.root);
      if (reader === 'selected Git') {
        const diff = await GitService.getDiff(fixture.root, fixture.baseSha, receipt);
        expect(diff.status).toBe('SUCCESS');
        expect(diff.diffContent).toContain('+after');
        expect(diff.diffContent).not.toContain('outside-owner-fixture');
      } else {
        const fingerprint = await new CoderSubmissionAdjudicationService({} as never, {} as never).captureCanonicalWorkspaceFingerprint(fixture.root, fixture.baseSha);
        expect(fingerprint.diff_hash).toBe(selectedDiffHash);
      }
      expect(fs.readFileSync(path.join(outside, 'tracked.txt'), 'utf8')).toBe('outside-owner-fixture\n');
    } finally {
      if (fs.realpathSync.native(outside) !== outside || !path.basename(outside).startsWith('git-revision-boundary-')) throw new Error('FIXTURE_BOUNDARY_CHANGED');
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    { reader: 'selected Git', driver: 'external' }, { reader: 'selected Git', driver: 'textconv' },
    { reader: 'adjudication fingerprint', driver: 'external' }, { reader: 'adjudication fingerprint', driver: 'textconv' },
  ])('$reader does not execute a repository-controlled $driver diff driver while collecting selected-root evidence', async ({ reader, driver }) => {
    const fixture = createGitFixture();
    const script = path.join(fixture.root, '.git', 'diff-driver.cjs');
    const marker = path.join(fixture.root, '.git', 'diff-driver-ran');
    fs.writeFileSync(script, "require('node:fs').writeFileSync(require('node:path').join(__dirname,'diff-driver-ran'),'executed');console.log('forged-driver-fixture');");
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    const command = quote(process.execPath.replace(/\\/g, '/')) + ' ' + quote(script.replace(/\\/g, '/'));
    try {
      if (driver === 'external') runGit(fixture.root, ['config', 'diff.external', command]);
      else {
        runGit(fixture.root, ['config', 'diff.fixture.textconv', command]);
        fs.writeFileSync(path.join(fixture.root, '.gitattributes'), '*.txt diff=fixture\n');
      }
      if (reader === 'adjudication fingerprint') {
        await new CoderSubmissionAdjudicationService({} as never, {} as never).captureCanonicalWorkspaceFingerprint(fixture.root, fixture.baseSha);
      } else {
        const result = await GitService.getDiff(fixture.root, fixture.baseSha, captureRepositoryRoot(fixture.root));
        expect(result.status).toBe('SUCCESS');
        expect(result.diffContent).toContain('+after');
        expect(result.diffContent).not.toContain('forged-driver-fixture');
      }
      expect(fs.existsSync(marker)).toBe(false);
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it('holds the original root across the final ProcessRunner invocation boundary', async () => {
    const fixture = createGitFixture();
    const original = fixture.root + '-original';
    const actual = ProcessRunner.execute.bind(ProcessRunner);
    let replacementBlocked = false;
    vi.spyOn(ProcessRunner, 'execute').mockImplementationOnce(async options => {
      if (process.platform === 'win32') {
        expect(() => fs.renameSync(fixture.root, original)).toThrow();
        replacementBlocked = true;
      } else {
        fs.renameSync(fixture.root, original); fs.mkdirSync(fixture.root);
        fs.writeFileSync(path.join(fixture.root, 'sentinel'), 'replacement-owner');
      }
      return actual(options);
    });
    try {
      const result = await GitService.getHeadSha(fixture.root);
      if (process.platform === 'win32') {
        expect(replacementBlocked).toBe(true);
        expect(result).toMatchObject({ status: 'SUCCESS', sha: fixture.baseSha });
        expect(fs.readFileSync(path.join(fixture.root, 'tracked.txt'), 'utf8')).toBe('after\n');
      } else {
        expect(result).toMatchObject({ status: 'ERROR', sha: null, errorCode: 'REPOSITORY_ROOT_IDENTITY_CHANGED' });
        expect(fs.readdirSync(fixture.root)).toEqual(['sentinel']);
        expect(fs.readFileSync(path.join(original, 'tracked.txt'), 'utf8')).toBe('after\n');
      }
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
      if (fs.existsSync(original)) fs.rmSync(original, { recursive: true, force: true });
    }
  });
});
