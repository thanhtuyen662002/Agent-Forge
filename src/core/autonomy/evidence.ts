import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ProcessRunner } from '../services/ProcessRunner';
import { GitEvidence, WorkOrder, sanitizeAutonomyText } from './contracts';

export interface EvidenceRunner {
  execute(options: { executable: string; args: string[]; cwd: string; timeoutMs?: number; allowShell?: boolean }): Promise<{
    exitCode: number; stdout: string; stderr: string; durationMs: number;
  }>;
}

const defaultRunner: EvidenceRunner = {
  execute: async (options) => ProcessRunner.execute(options),
};

function parseNames(output: string): string[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function splitCommand(command: string): string[] {
  // Required tests are operator-authored strings, not shell scripts. Preserve
  // quoted `node -e`/PowerShell arguments without invoking a shell.
  return (command.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+/g) ?? [])
    .map((part) => part.length >= 2 && ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) ? part.slice(1, -1) : part);
}

export class EvidenceCollector {
  constructor(private readonly runner: EvidenceRunner = defaultRunner) {}

  async collect(order: WorkOrder, testCommands: string[] = []): Promise<GitEvidence> {
    const cwd = path.resolve(order.worktree);
    if (!fs.existsSync(cwd)) throw new Error(`WORKTREE_NOT_FOUND: ${cwd}`);
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
    const names = await runGit(['diff', '--name-only', '-z', order.base_sha]);
    const diff = await runGit(['diff', '--no-ext-diff', '--no-textconv', '--binary', order.base_sha]);
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
    for (const command of testCommands) {
      const [executable, ...args] = command === 'agentforge:proof'
        ? [process.execPath, path.resolve(__dirname, '../../electron/proofVerifier.js')]
        : splitCommand(command.trim());
      if (!executable) {
        tests.push({ command, exitCode: -1, stdout: '', stderr: 'EMPTY_TEST_COMMAND', durationMs: 0 });
        continue;
      }
      const test = await this.runner.execute({ executable, args, cwd, timeoutMs: 20 * 60_000, allowShell: false });
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
