import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ProcessRunner } from '../services/ProcessRunner';
import { isIssuedVerificationProcessBoundary, VerificationProcessBoundary } from '../types/verificationCapability';
import { GitRevisionValidationError, validateGitRevision } from '../services/GitService';
import { GitEvidence, WorkOrder, sanitizeAutonomyText } from './contracts';

export interface EvidenceRunner {
  execute(options: { executable: string; args: string[]; cwd: string; timeoutMs?: number; allowShell?: boolean;
    verificationBoundary?: VerificationProcessBoundary }): Promise<{
    exitCode: number; stdout: string; stderr: string; durationMs: number;
  }>;
}

const defaultRunner: EvidenceRunner = {
  execute: async (options) => ProcessRunner.execute(options),
};

function parseNames(output: string): string[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export interface ApprovedVerificationInvocation {
  command: string;
  executable: string;
  args: string[];
  timeoutMs: number;
  verificationBoundary: VerificationProcessBoundary;
}

export class EvidenceCollector {
  constructor(private readonly runner: EvidenceRunner = defaultRunner) {}

  async collect(order: WorkOrder, testCommands: string[] = [], approvedCommands?: ApprovedVerificationInvocation[]): Promise<GitEvidence> {
    const cwd = path.resolve(order.worktree);
    if (!fs.existsSync(cwd)) throw new Error(`WORKTREE_NOT_FOUND: ${cwd}`);
    // WorkOrder schema validation normally checks this field, but callers can
    // still pass a forged object at runtime. Validate again at the process
    // boundary so malformed revisions never reach Git (or mutate evidence).
    const baseSha = validateGitRevision(order.base_sha);
    if (!baseSha) {
      // Evidence collection always requires a baseline revision. The helper
      // uses null/undefined for GitService's working-tree-diff API, so turn
      // that otherwise valid sentinel into the same typed fail-closed error.
      throw new GitRevisionValidationError();
    }
    const runGit = async (args: string[]) => {
      const result = await this.runner.execute({ executable: 'git', args, cwd, timeoutMs: 60_000, allowShell: false });
      if (result.exitCode !== 0) throw new Error(`GIT_EVIDENCE_FAILED: ${sanitizeAutonomyText(result.stderr)}`);
      return result;
    };
    const head = await runGit(['rev-parse', 'HEAD']);
    if (head.exitCode !== 0 || !/^[0-9a-f]{40}$/i.test(head.stdout.trim())) {
      throw new Error(`HEAD_RESOLUTION_FAILED: ${sanitizeAutonomyText(head.stderr || head.stdout)}`);
    }
    const status = await runGit(['status', '--porcelain=v1', '-uall']);
    const names = await runGit(['diff', '--name-only', '-z', '--end-of-options', baseSha, '--']);
    const diff = await runGit(['diff', '--no-ext-diff', '--no-textconv', '--binary', '--end-of-options', baseSha, '--']);
    const untracked = await runGit(['ls-files', '--others', '--exclude-standard', '-z']);
    const changedFiles = [...new Set([...names.stdout.split('\0'), ...untracked.stdout.split('\0')].filter(Boolean))].sort();
    const snapshots = changedFiles.map((name) => {
      const target = path.resolve(cwd, name);
      const relative = path.relative(cwd, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('EVIDENCE_PATH_ESCAPE');
      if (!fs.existsSync(target)) return { path: name, deleted: true };
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error(`UNSUPPORTED_EVIDENCE_FILE: ${name}`);
      const bytes = fs.readFileSync(target);
      return { path: name, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), content: bytes.toString('utf8') };
    });
    const rawDiff = `${diff.stdout}\nWorking file snapshots (includes untracked):\n${JSON.stringify(snapshots)}`;
    const snapshotSha = crypto.createHash('sha256').update(JSON.stringify({ head: head.stdout.trim(), status: status.stdout, diff: rawDiff })).digest('hex');
    const tests = [];
    for (const [index, command] of testCommands.entries()) {
      const approved = approvedCommands?.[index];
      if (!approved || approvedCommands?.length !== testCommands.length || approved.command !== command ||
          !isIssuedVerificationProcessBoundary(approved.verificationBoundary)) {
        tests.push({ command, exitCode: -1, stdout: '', stderr: 'OWNER_APPROVAL_REQUIRED', durationMs: 0 });
        continue;
      }
      const test = await this.runner.execute({ executable: approved.executable, args: [...approved.args], cwd,
        timeoutMs: approved.timeoutMs, allowShell: false, verificationBoundary: approved.verificationBoundary });
      tests.push({ command, exitCode: test.exitCode, stdout: sanitizeAutonomyText(test.stdout), stderr: sanitizeAutonomyText(test.stderr), durationMs: test.durationMs });
    }
    return {
      headSha: head.stdout.trim().toLowerCase(),
      snapshotSha,
      status: sanitizeAutonomyText(status.stdout),
      changedFiles,
      diff: sanitizeAutonomyText(rawDiff, 8 * 1024 * 1024),
      tests,
    };
  }
}
