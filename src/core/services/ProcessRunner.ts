import { spawn, ChildProcess } from 'child_process';
import crypto from 'crypto';

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
}

export class ProcessRunner {
  private static activeProcesses = new Map<string, { process: ChildProcess; command: string }>();

  private static SECRET_PATTERNS = [
    /AKIA[0-9A-Z]{16}/g, // AWS Access Key
    /Bearer\s+[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/g, // JWT / Bearer
    /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/g, // Private Key
    /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g, // GitHub Token
  ];

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

    return new Promise((resolve) => {
      let stdoutAcc = '';
      let stderrAcc = '';
      let isTimedOut = false;
      let isCancelled = false;

      // Spawn child process directly without shell by default
      const child = spawn(options.executable, options.args, {
        cwd: options.cwd,
        shell: options.allowShell ?? false,
        env: {
          ...process.env,
          ...options.env,
        },
        windowsHide: true,
      });

      this.activeProcesses.set(executionId, { process: child, command: commandStr });

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
        this.activeProcesses.delete(executionId);
        const durationMs = Date.now() - startTime;
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
          cancelled: isCancelled,
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        this.activeProcesses.delete(executionId);
        const durationMs = Date.now() - startTime;

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
          cancelled: isCancelled,
        });
      });
    });
  }

  public static cancel(executionId: string): boolean {
    const entry = this.activeProcesses.get(executionId);
    if (entry) {
      this.killProcessTree(entry.process);
      this.activeProcesses.delete(executionId);
      return true;
    }
    return false;
  }

  public static terminateAllProcesses(): number {
    const count = this.activeProcesses.size;
    for (const [id, entry] of this.activeProcesses.entries()) {
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
