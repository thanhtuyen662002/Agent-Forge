import { ProcessRunner } from './ProcessRunner';
import { PolicyService } from './PolicyService';
import { GitStatusSummary, GitDiffSummary } from '../types/domain';
import { assertRepositoryRootIdentity, captureRepositoryRoot, RepositoryRootError, RepositoryRootErrorCode, RepositoryRootIdentity } from './RepositoryRootIdentity';
import { RepositoryRootLease } from './RepositoryRootLease';

/**
 * Error codes returned when an evidence/review revision fails validation.
 *
 * Git evidence is consumed as an authoritative record, so a malformed
 * revision must be rejected before ProcessRunner is reached.  Keep the code
 * stable and do not echo the supplied value: callers may have passed an
 * option, path, or control sequence that must never reach a log.
 */
export type GitDiffErrorCode = 'INVALID_GIT_REVISION' | RepositoryRootErrorCode;

/** Typed validation failure for an untrusted Git revision. */
export class GitRevisionValidationError extends Error {
  public readonly code: GitDiffErrorCode = 'INVALID_GIT_REVISION';

  public constructor() {
    super('INVALID_GIT_REVISION: revision must be an exact 40-character hexadecimal commit SHA.');
    this.name = 'GitRevisionValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Validate and normalize a revision supplied by a task/evidence boundary.
 *
 * `undefined` and `null` deliberately mean "working tree diff" for the
 * existing GitService API.  Once a revision is supplied, however, it must be
 * exactly a full commit SHA.  This excludes abbreviated refs, option-like
 * values, paths (including Windows paths), whitespace, control characters,
 * and Unicode look-alikes before any Git process can be started.
 */
export function validateGitRevision(revision: unknown): string | null {
  if (revision === undefined || revision === null) return null;
  if (typeof revision !== 'string' || revision.length !== 40 || !/^[0-9a-fA-F]{40}$/.test(revision)) {
    throw new GitRevisionValidationError();
  }
  return revision.toLowerCase();
}

export type GitDiffResult = GitDiffSummary & {
  errorCode?: GitDiffErrorCode;
};

export interface GitShaResult {
  status: 'SUCCESS' | 'ERROR' | 'UNKNOWN';
  sha: string | null;
  errorMessage?: string;
  errorCode?: RepositoryRootErrorCode;
}

export interface GitBranchResult {
  status: 'SUCCESS' | 'ERROR' | 'UNKNOWN';
  branch: string | null;
  errorMessage?: string;
  errorCode?: RepositoryRootErrorCode;
}

export type GitStatusResult = GitStatusSummary & { errorCode?: RepositoryRootErrorCode };

export class GitService {
  private static observeRoot(repoPath: string, expected?: RepositoryRootIdentity): { identity?: RepositoryRootIdentity; errorCode?: RepositoryRootErrorCode; errorMessage?: string } {
    try {
      const current = captureRepositoryRoot(repoPath);
      if (expected) {
        assertRepositoryRootIdentity(expected);
        if (JSON.stringify(current) !== JSON.stringify(expected)) throw new RepositoryRootError('REPOSITORY_ROOT_IDENTITY_CHANGED');
      }
      return { identity: expected ?? current };
    } catch (error) {
      const failure = error instanceof RepositoryRootError ? error : new RepositoryRootError('REPOSITORY_ROOT_IDENTITY_UNAVAILABLE');
      return { errorCode: failure.code, errorMessage: failure.message };
    }
  }

  private static async read(identity: RepositoryRootIdentity, args: string[], timeoutMs: number): Promise<{
    exitCode: number; stdout: string; stderr: string; errorCode?: RepositoryRootErrorCode;
  }> {
    let lease: RepositoryRootLease | undefined;
    try {
      lease = RepositoryRootLease.acquire(identity);
      const result = await ProcessRunner.execute({
        executable: 'git',
        args: ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args],
        cwd: lease.cwd,
        repositoryIdentity: identity,
        timeoutMs,
        // core.worktree in local config must never select another directory.
        // Linux names the captured descriptor here, not its replaceable path.
        env: { GIT_OPTIONAL_LOCKS: '0', GIT_WORK_TREE: lease.cwd },
        allowedEnvKeys: ['GIT_OPTIONAL_LOCKS', 'GIT_WORK_TREE'],
      });
      // Windows keeps the selected name pinned; Linux Git uses the held root
      // descriptor even if its pathname is swapped. Discard stale observations.
      lease.assertActive();
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      if (!(error instanceof RepositoryRootError)) throw error;
      return { exitCode: -1, stdout: '', stderr: error.message, errorCode: error.code };
    } finally { lease?.close(); }
  }

  public static async getHeadSha(repoPath: string, expectedRoot?: RepositoryRootIdentity): Promise<GitShaResult> {
    const root = this.observeRoot(repoPath, expectedRoot);
    if (!root.identity) return { status: 'ERROR', sha: null, errorCode: root.errorCode, errorMessage: root.errorMessage };
    const policy = PolicyService.evaluatePathAccess(repoPath, repoPath, false);
    if (!policy.allowed) {
      return {
        status: 'ERROR',
        sha: null,
        errorMessage: `Path policy denial: ${policy.reason}`,
      };
    }

    const res = await this.read(root.identity, ['rev-parse', 'HEAD'], 10000);

    if (res.exitCode !== 0 || !res.stdout.trim()) {
      return {
        status: 'ERROR',
        sha: null,
        errorCode: res.errorCode,
        errorMessage: res.stderr.trim() || 'Failed to resolve HEAD SHA (not a git repository or no commits)',
      };
    }

    return {
      status: 'SUCCESS',
      sha: res.stdout.trim(),
    };
  }

  public static async getCurrentBranch(repoPath: string, expectedRoot?: RepositoryRootIdentity): Promise<GitBranchResult> {
    const root = this.observeRoot(repoPath, expectedRoot);
    if (!root.identity) return { status: 'ERROR', branch: null, errorCode: root.errorCode, errorMessage: root.errorMessage };
    const policy = PolicyService.evaluatePathAccess(repoPath, repoPath, false);
    if (!policy.allowed) {
      return {
        status: 'ERROR',
        branch: null,
        errorMessage: `Path policy denial: ${policy.reason}`,
      };
    }

    const res = await this.read(root.identity, ['branch', '--show-current'], 10000);

    if (res.exitCode !== 0) {
      return {
        status: 'ERROR',
        branch: null,
        errorCode: res.errorCode,
        errorMessage: res.stderr.trim() || 'Failed to determine current branch',
      };
    }

    return {
      status: 'SUCCESS',
      branch: res.stdout.trim() || 'HEAD',
    };
  }

  public static async getStatus(repoPath: string, expectedRoot?: RepositoryRootIdentity): Promise<GitStatusResult> {
    const root = this.observeRoot(repoPath, expectedRoot);
    if (!root.identity) return { status: 'ERROR', branch: 'UNKNOWN', isClean: false,
      modifiedFiles: [], untrackedFiles: [], aheadCount: 0, behindCount: 0,
      errorCode: root.errorCode, errorMessage: root.errorMessage };
    const policy = PolicyService.evaluatePathAccess(repoPath, repoPath, false);
    if (!policy.allowed) {
      return {
        status: 'ERROR',
        branch: 'UNKNOWN',
        isClean: false,
        modifiedFiles: [],
        untrackedFiles: [],
        aheadCount: 0,
        behindCount: 0,
        errorMessage: `Path policy denial: ${policy.reason}`,
      };
    }

    const branchRes = await this.getCurrentBranch(repoPath, root.identity);
    if (branchRes.errorCode) return { status: 'ERROR', branch: 'UNKNOWN', isClean: false,
      modifiedFiles: [], untrackedFiles: [], aheadCount: 0, behindCount: 0,
      errorCode: branchRes.errorCode, errorMessage: branchRes.errorMessage };
    const branchName = branchRes.status === 'SUCCESS' && branchRes.branch ? branchRes.branch : 'UNKNOWN';

    const res = await this.read(root.identity, ['status', '--porcelain'], 15000);

    if (res.exitCode !== 0) {
      return {
        status: 'ERROR',
        branch: res.errorCode ? 'UNKNOWN' : branchName,
        isClean: false,
        modifiedFiles: [],
        untrackedFiles: [],
        aheadCount: 0,
        behindCount: 0,
        errorCode: res.errorCode,
        errorMessage: res.stderr.trim() || 'Git status command failed',
      };
    }

    const lines = res.stdout.split('\n').filter((l) => l.trim().length > 0);
    const modifiedFiles: string[] = [];
    const untrackedFiles: string[] = [];

    for (const line of lines) {
      const statusPrefix = line.substring(0, 2);
      const filePath = line.substring(3).trim();
      if (statusPrefix === '??') {
        untrackedFiles.push(filePath);
      } else {
        modifiedFiles.push(filePath);
      }
    }

    return {
      status: 'SUCCESS',
      branch: branchName,
      isClean: lines.length === 0,
      modifiedFiles,
      untrackedFiles,
      aheadCount: 0,
      behindCount: 0,
    };
  }

  public static async getDiff(repoPath: string, baseSha?: string | null, expectedRoot?: RepositoryRootIdentity): Promise<GitDiffResult> {
    let validatedBaseSha: string | null;
    try {
      validatedBaseSha = validateGitRevision(baseSha);
    } catch (error: unknown) {
      if (error instanceof GitRevisionValidationError) {
        return {
          status: 'ERROR',
          diffStat: '',
          diffContent: '',
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          errorCode: error.code,
          errorMessage: error.message,
        };
      }
      throw error;
    }

    const root = this.observeRoot(repoPath, expectedRoot);
    if (!root.identity) return { status: 'ERROR', diffStat: '', diffContent: '', filesChanged: [],
      insertions: 0, deletions: 0, errorCode: root.errorCode, errorMessage: root.errorMessage };
    const policy = PolicyService.evaluatePathAccess(repoPath, repoPath, false);
    if (!policy.allowed) {
      return {
        status: 'ERROR',
        diffStat: '',
        diffContent: '',
        filesChanged: [],
        insertions: 0,
        deletions: 0,
        errorMessage: `Path policy denial: ${policy.reason}`,
      };
    }

    // Keep command options before the revision and terminate the revision
    // list before any path arguments.  Exact SHA validation above means the
    // revision itself cannot be an option, while --end-of-options makes this
    // invariant explicit for Git's revision parser and the trailing -- keeps
    // future path additions from being interpreted as options.
    const args = validatedBaseSha
      ? ['diff', '--no-ext-diff', '--no-textconv', '--end-of-options', validatedBaseSha, '--']
      : ['diff', '--no-ext-diff', '--no-textconv'];

    // 1. Get raw diff
    const diffRes = await this.read(root.identity, args, 20000);

    if (diffRes.exitCode !== 0) {
      return {
        status: 'ERROR',
        diffStat: '',
        diffContent: '',
        filesChanged: [],
        insertions: 0,
        deletions: 0,
        errorCode: diffRes.errorCode,
        errorMessage: diffRes.stderr.trim() || 'Git diff command failed',
      };
    }

    // 2. Get diff stat
    const statRes = await this.read(root.identity, validatedBaseSha
        ? ['diff', '--no-ext-diff', '--no-textconv', '--stat', '--end-of-options', validatedBaseSha, '--']
        : ['diff', '--no-ext-diff', '--no-textconv', '--stat'], 20000);

    if (statRes.exitCode !== 0) {
      return {
        status: 'ERROR',
        diffStat: '',
        diffContent: '',
        filesChanged: [],
        insertions: 0,
        deletions: 0,
        errorCode: statRes.errorCode,
        errorMessage: statRes.stderr.trim() || 'Git diff --stat command failed',
      };
    }

    // 3. Get list of changed files
    const nameRes = await this.read(root.identity, validatedBaseSha
        ? ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--end-of-options', validatedBaseSha, '--']
        : ['diff', '--no-ext-diff', '--no-textconv', '--name-only'], 20000);

    if (nameRes.exitCode !== 0) {
      return {
        status: 'ERROR',
        diffStat: '',
        diffContent: '',
        filesChanged: [],
        insertions: 0,
        deletions: 0,
        errorCode: nameRes.errorCode,
        errorMessage: nameRes.stderr.trim() || 'Git diff --name-only command failed',
      };
    }

    const filesChanged = nameRes.stdout
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.length > 0);

    return {
      status: 'SUCCESS',
      diffStat: statRes.stdout.trim() || '0 files changed',
      diffContent: diffRes.stdout.trim(),
      filesChanged,
      insertions: 0,
      deletions: 0,
    };
  }
}
