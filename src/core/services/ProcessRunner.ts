import { spawn, ChildProcess } from 'child_process';
import crypto from 'crypto';
import { PolicyService } from './PolicyService';
import { Repository } from '../database/repositories';

export interface ProcessRunResult {
  executionId: string;
  pid: number | null;
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
}

export interface StructuredProcessOptions {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  allowShell?: boolean;
  repo?: Repository;
}

export class ProcessRunner {
  private static activeProcesses = new Map<
    string,
    { process: ChildProcess; command: string; isCancelled: boolean }
  >();

  private static SECRET_PATTERNS = [
    /AKIA[0-9A-Z]{16}/g, // AWS Access Key
    /Bearer\s+[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/g, // JWT / Bearer
    /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/g, // Private Key
    /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g, // GitHub Token
  ];

  // Minimal safe environment variable keys
  private static SAFE_ENV_VARS = [
    'PATH',
    'Path',
    'SYSTEMROOT',
    'SystemRoot',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOME',
    'LANG',
    'LC_ALL',
    'TERM',
    'APPDATA',
    'LOCALAPPDATA',
    'COMSPEC',
    'PATHEXT',
    'NODE_ENV',
  ];

  private static buildMinimalEnv(customEnv?: Record<string, string>): NodeJS.ProcessEnv {
    const minimal: NodeJS.ProcessEnv = {};
    for (const key of this.SAFE_ENV_VARS) {
      if (process.env[key]) {
        minimal[key] = process.env[key];
      }
    }
    if (customEnv) {
      Object.assign(minimal, customEnv);
    }
    return minimal;
  }

  public static scrubSecrets(text: string): string {
    let scrubbed = text;
    for (const pattern of this.SECRET_PATTERNS) {
      scrubbed = scrubbed.replace(pattern, '[REDACTED_SECRET]');
    }
    return scrubbed;
  }

  public static async execute(options: StructuredProcessOptions): Promise<ProcessRunResult> {
    const executionId = crypto.randomUUID();
    const timeoutMs = options.timeoutMs ?? 60000;
    const commandStr = `${options.executable} ${options.args.join(' ')}`;
    const startTime = Date.now();
    const startIso = new Date(startTime).toISOString();

    // 1. Mandatory PolicyService Evaluation Gate
    const policy = PolicyService.evaluateProcessExecution(
      options.executable,
      options.args,
      options.allowShell ?? false
    );

    if (!policy.allowed) {
      if (options.repo) {
        options.repo.createProcessRun({
          id: executionId,
          pid: null,
          command: commandStr,
          working_directory: options.cwd,
          status: 'FAILED',
          start_time: startIso,
        });
        options.repo.updateProcessRun(executionId, 'FAILED', -1, new Date().toISOString(), null, null);
      }

      return {
        executionId,
        pid: null,
        command: commandStr,
        cwd: options.cwd,
        exitCode: -1,
        stdout: '',
        stderr: `Security Policy Violation: ${policy.reason} (${policy.decision})`,
        durationMs: 0,
        timedOut: false,
        cancelled: false,
      };
    }

    // Persist RUNNING process run in database if repository provided
    if (options.repo) {
      options.repo.createProcessRun({
        id: executionId,
        pid: null,
        command: commandStr,
        working_directory: options.cwd,
        status: 'RUNNING',
        start_time: startIso,
      });
    }

    return new Promise((resolve) => {
      let stdoutAcc = '';
      let stderrAcc = '';
      let isTimedOut = false;

      // Spawn child process directly with minimal sanitized environment
      const child = spawn(options.executable, options.args, {
        cwd: options.cwd,
        shell: options.allowShell ?? false,
        env: this.buildMinimalEnv(options.env),
        windowsHide: true,
      });

      const procEntry = { process: child, command: commandStr, isCancelled: false };
      this.activeProcesses.set(executionId, procEntry);

      const timer = setTimeout(() => {
        isTimedOut = true;
        this.killProcessTree(child);
      }, timeoutMs);

      if (child.stdout) {
        child.stdout.on('data', (data) => {
          stdoutAcc += data.toString('utf8');
        });
      }

      if (child.stderr) {
        child.stderr.on('data', (data) => {
          stderrAcc += data.toString('utf8');
        });
      }

      child.on('error', (err) => {
        clearTimeout(timer);
        const wasCancelled = procEntry.isCancelled;
        this.activeProcesses.delete(executionId);
        const durationMs = Date.now() - startTime;
        const endIso = new Date().toISOString();

        if (options.repo) {
          options.repo.updateProcessRun(
            executionId,
            wasCancelled ? 'CANCELLED' : 'FAILED',
            -1,
            endIso
          );
        }

        resolve({
          executionId,
          pid: child.pid ?? null,
          command: commandStr,
          cwd: options.cwd,
          exitCode: -1,
          stdout: this.scrubSecrets(stdoutAcc),
          stderr: this.scrubSecrets(`Failed to start process: ${err.message}`),
          durationMs,
          timedOut: isTimedOut,
          cancelled: wasCancelled,
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        const wasCancelled = procEntry.isCancelled;
        this.activeProcesses.delete(executionId);
        const durationMs = Date.now() - startTime;
        const endIso = new Date().toISOString();

        let terminalStatus: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' = 'COMPLETED';
        if (wasCancelled) {
          terminalStatus = 'CANCELLED';
        } else if (isTimedOut) {
          terminalStatus = 'TIMED_OUT';
        } else if (code !== 0) {
          terminalStatus = 'FAILED';
        }

        if (options.repo) {
          options.repo.updateProcessRun(executionId, terminalStatus, code ?? (isTimedOut ? -2 : 0), endIso);
        }

        resolve({
          executionId,
          pid: child.pid ?? null,
          command: commandStr,
          cwd: options.cwd,
          exitCode: code ?? (isTimedOut ? -2 : 0),
          stdout: this.scrubSecrets(stdoutAcc),
          stderr: this.scrubSecrets(stderrAcc),
          durationMs,
          timedOut: isTimedOut,
          cancelled: wasCancelled,
        });
      });
    });
  }

  public static cancel(executionId: string): boolean {
    const entry = this.activeProcesses.get(executionId);
    if (entry) {
      entry.isCancelled = true;
      this.killProcessTree(entry.process);
      this.activeProcesses.delete(executionId);
      return true;
    }
    return false;
  }

  public static terminateAllProcesses(): number {
    const count = this.activeProcesses.size;
    for (const [id, entry] of this.activeProcesses.entries()) {
      entry.isCancelled = true;
      this.killProcessTree(entry.process);
      this.activeProcesses.delete(id);
    }
    return count;
  }

  public static getActiveProcessCount(): number {
    return this.activeProcesses.size;
  }

  private static killProcessTree(child: ChildProcess): void {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', child.pid.toString(), '/f', '/t'], { windowsHide: true });
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      // Process already terminated
    }
  }
}
