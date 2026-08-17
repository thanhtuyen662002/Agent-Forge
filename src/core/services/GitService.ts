import { ProcessRunner } from './ProcessRunner';
import { PolicyService } from './PolicyService';
import { GitStatusSummary, GitDiffSummary } from '../types/domain';

export interface GitShaResult {
  status: 'SUCCESS' | 'ERROR' | 'UNKNOWN';
  sha: string | null;
  errorMessage?: string;
}

export interface GitBranchResult {
  status: 'SUCCESS' | 'ERROR' | 'UNKNOWN';
  branch: string | null;
  errorMessage?: string;
}

export class GitService {
  public static async getHeadSha(repoPath: string): Promise<GitShaResult> {
    const policy = PolicyService.evaluatePathAccess(repoPath, repoPath, false);
    if (!policy.allowed) {
      return {
        status: 'ERROR',
        sha: null,
        errorMessage: `Path policy denial: ${policy.reason}`,
      };
    }

    const res = await ProcessRunner.execute({
      executable: 'git',
      args: ['rev-parse', 'HEAD'],
      cwd: repoPath,
      timeoutMs: 10000,
    });

    if (res.exitCode !== 0 || !res.stdout.trim()) {
      return {
        status: 'ERROR',
        sha: null,
        errorMessage: res.stderr.trim() || 'Failed to resolve HEAD SHA (not a git repository or no commits)',
      };
    }

    return {
      status: 'SUCCESS',
      sha: res.stdout.trim(),
    };
  }

  public static async getCurrentBranch(repoPath: string): Promise<GitBranchResult> {
    const policy = PolicyService.evaluatePathAccess(repoPath, repoPath, false);
    if (!policy.allowed) {
      return {
        status: 'ERROR',
        branch: null,
        errorMessage: `Path policy denial: ${policy.reason}`,
      };
    }

    const res = await ProcessRunner.execute({
      executable: 'git',
      args: ['branch', '--show-current'],
      cwd: repoPath,
      timeoutMs: 10000,
    });

    if (res.exitCode !== 0) {
      return {
        status: 'ERROR',
        branch: null,
        errorMessage: res.stderr.trim() || 'Failed to determine current branch',
      };
    }

    return {
      status: 'SUCCESS',
      branch: res.stdout.trim() || 'HEAD',
    };
  }

  public static async getStatus(repoPath: string): Promise<GitStatusSummary> {
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

    const branchRes = await this.getCurrentBranch(repoPath);
    const branchName = branchRes.status === 'SUCCESS' && branchRes.branch ? branchRes.branch : 'UNKNOWN';

    const res = await ProcessRunner.execute({
      executable: 'git',
      args: ['status', '--porcelain'],
      cwd: repoPath,
      timeoutMs: 15000,
    });

    if (res.exitCode !== 0) {
      return {
        status: 'ERROR',
        branch: branchName,
        isClean: false,
        modifiedFiles: [],
        untrackedFiles: [],
        aheadCount: 0,
        behindCount: 0,
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

  public static async getDiff(repoPath: string, baseSha?: string | null): Promise<GitDiffSummary> {
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

    const args = baseSha ? ['diff', baseSha] : ['diff', 'HEAD'];

    // 1. Get raw diff
    const diffRes = await ProcessRunner.execute({
      executable: 'git',
      args,
      cwd: repoPath,
      timeoutMs: 20000,
    });

    if (diffRes.exitCode !== 0) {
      return {
        status: 'ERROR',
        diffStat: '',
        diffContent: '',
        filesChanged: [],
        insertions: 0,
        deletions: 0,
        errorMessage: diffRes.stderr.trim() || 'Git diff command failed',
      };
    }

    // 2. Get diff stat
    const statRes = await ProcessRunner.execute({
      executable: 'git',
      args: [...args, '--stat'],
      cwd: repoPath,
      timeoutMs: 20000,
    });

    if (statRes.exitCode !== 0) {
      return {
        status: 'ERROR',
        diffStat: '',
        diffContent: '',
        filesChanged: [],
        insertions: 0,
        deletions: 0,
        errorMessage: statRes.stderr.trim() || 'Git diff --stat command failed',
      };
    }

    // 3. Get list of changed files
    const nameRes = await ProcessRunner.execute({
      executable: 'git',
      args: [...args, '--name-only'],
      cwd: repoPath,
      timeoutMs: 20000,
    });

    if (nameRes.exitCode !== 0) {
      return {
        status: 'ERROR',
        diffStat: '',
        diffContent: '',
        filesChanged: [],
        insertions: 0,
        deletions: 0,
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
