import { describe, it, expect, vi, afterEach } from 'vitest';
import { GitRevisionValidationError, GitService } from '../src/core/services/GitService';
import { ProcessRunner } from '../src/core/services/ProcessRunner';
import { EvidenceCollector } from '../src/core/autonomy/evidence';
import { createWorkOrder, WorkOrder } from '../src/core/autonomy/contracts';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createGitFixture(): { root: string; baseSha: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-revision-boundary-'));
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-dir-'));
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
      expect(execute.mock.calls.map(([options]) => options.args)).toEqual([
        ['diff', '--end-of-options', fixture.baseSha, '--'],
        ['diff', '--stat', '--end-of-options', fixture.baseSha, '--'],
        ['diff', '--name-only', '--end-of-options', fixture.baseSha, '--'],
      ]);
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
});
