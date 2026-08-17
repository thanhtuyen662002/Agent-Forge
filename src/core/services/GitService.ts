import { ProcessRunner } from './ProcessRunner';
import { PolicyService } from './PolicyService';

export interface GitStatusSummary {
  branch: string;
  isClean: boolean;
  modifiedFiles: string[];
  untrackedFiles: string[];
  aheadCount: number;
  behindCount: number;
}

export interface GitDiffSummary {
  diffStat: string;
  diffContent: string;
  filesChanged: string[];
  insertions: number;
  deletions: number;
}

export class GitService {
  public static async getHeadSha(repoPath: string): Promise<string> {
    const res = await ProcessRunner.execute({
      executable: 'git',
      args: ['rev-parse', 'HEAD'],
      cwd: repoPath,
      timeoutMs: 10000,
    });
    if (res.exitCode !== 0) {
      return 'UNKNOWN_SHA';
    }
    return res.stdout.trim();
  }

  public static async getCurrentBranch(repoPath: string): Promise<string> {
    const res = await ProcessRunner.execute({
      executable: 'git',
      args: ['branch', '--show-current'],
      cwd: repoPath,
      timeoutMs: 10000,
    });
    if (res.exitCode !== 0) {
      return 'main';
    }
    return res.stdout.trim() || 'HEAD';
  }

  public static async getStatus(repoPath: string): Promise<GitStatusSummary> {
    const branch = await this.getCurrentBranch(repoPath);
    const res = await ProcessRunner.execute({
      executable: 'git',
      args: ['status', '--porcelain'],
      cwd: repoPath,
      timeoutMs: 15000,
    });

    if (res.exitCode !== 0) {
      return {
        branch,
        isClean: true,
        modifiedFiles: [],
        untrackedFiles: [],
        aheadCount: 0,
        behindCount: 0,
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
      branch,
      isClean: lines.length === 0,
      modifiedFiles,
      untrackedFiles,
      aheadCount: 0,
      behindCount: 0,
    };
  }

  public static async getDiff(repoPath: string, baseSha?: string | null): Promise<GitDiffSummary> {
    const args = baseSha ? ['diff', baseSha] : ['diff', 'HEAD'];

    // 1. Get raw diff
    const diffRes = await ProcessRunner.execute({
      executable: 'git',
      args,
      cwd: repoPath,
      timeoutMs: 20000,
    });

    // 2. Get diff stat
    const statRes = await ProcessRunner.execute({
      executable: 'git',
      args: [...args, '--stat'],
      cwd: repoPath,
      timeoutMs: 20000,
    });

    // 3. Get list of changed files
    const nameRes = await ProcessRunner.execute({
      executable: 'git',
      args: [...args, '--name-only'],
      cwd: repoPath,
      timeoutMs: 20000,
    });

    const filesChanged = nameRes.stdout
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.length > 0);

    return {
      diffStat: statRes.stdout.trim() || 'No changes detected.',
      diffContent: diffRes.stdout.trim(),
      filesChanged,
      insertions: 0,
      deletions: 0,
    };
  }
}
