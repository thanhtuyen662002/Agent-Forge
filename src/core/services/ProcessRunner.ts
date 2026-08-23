import { spawn, ChildProcess } from 'child_process';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { PolicyService } from './PolicyService';
import { Repository } from '../database/repositories';
import { ArtifactStore } from './ArtifactStore';

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
  stdoutEvidenceId?: string | null;
  stderrEvidenceId?: string | null;
}

export interface StructuredProcessOptions {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  allowShell?: boolean;
  repo?: Repository;
  artifactStore?: ArtifactStore;
  projectId?: string;
  taskId?: string;
  attemptId?: string | null;
  stdin?: string;
}

interface ResolvedInvocation {
  executable: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
  error?: string;
}

export class ProcessRunner {
  private static activeProcesses = new Map<
    string,
    { process: ChildProcess; command: string; isCancelled: boolean; repo?: Repository }
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

  /**
   * Resolves a trusted, absolute path to cmd.exe on Windows.
   * Ignores caller-supplied custom options.env.COMSPEC to prevent execution hijacking.
   * Validates that the candidate path is absolute, has basename 'cmd.exe', exists as a regular file,
   * and contains no control characters, quotes, or metacharacters.
   */
  private static resolveTrustedCmdExe(): string | null {
    const candidates: (string | undefined)[] = [
      process.env.ComSpec,
      process.env.COMSPEC,
      path.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'cmd.exe'),
    ];

    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'string') continue;
      const trimmed = candidate.trim();
      if (!path.isAbsolute(trimmed)) continue;
      if (path.basename(trimmed).toLowerCase() !== 'cmd.exe') continue;
      if (/[\x00\r\n"&|<>^%!()]/.test(trimmed)) continue;

      try {
        if (fs.existsSync(trimmed)) {
          const stat = fs.statSync(trimmed);
          if (stat.isFile()) {
            return path.resolve(trimmed);
          }
        }
      } catch {
        // Continue to next candidate on filesystem error
      }
    }

    return null;
  }

  /**
   * Resolves platform-specific executable invocations while preserving logical command identity.
   * On Windows, resolves bare commands against PATH and PATHEXT.
   * If a .cmd or .bat shim (such as npm.cmd) is resolved, it is safely invoked through trusted cmd.exe
   * with explicit /d /v:off /s /c flags and strict path and argument validation to prevent shell injection.
   */
  private static resolvePlatformInvocation(
    executable: string,
    args: string[],
    env: NodeJS.ProcessEnv
  ): ResolvedInvocation {
    if (process.platform !== 'win32') {
      return { executable, args, windowsVerbatimArguments: false };
    }

    const pathVar = env.PATH || env.Path || process.env.PATH || process.env.Path || '';
    const pathExtVar = env.PATHEXT || process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
    const extensions = pathExtVar.split(';').map((e) => e.trim().toLowerCase()).filter(Boolean);

    let resolvedPath: string | null = null;

    // 1. Direct path check if executable contains path separators
    if (executable.includes('/') || executable.includes('\\')) {
      const ext = path.extname(executable).toLowerCase();
      if (ext && fs.existsSync(executable)) {
        resolvedPath = path.resolve(executable);
      } else {
        for (const e of extensions) {
          const candidate = executable + e;
          if (fs.existsSync(candidate)) {
            resolvedPath = path.resolve(candidate);
            break;
          }
        }
      }
    } else {
      // 2. Search directories on PATH
      const dirs = pathVar.split(path.delimiter).filter(Boolean);
      const hasExt = Boolean(path.extname(executable));

      for (const dir of dirs) {
        if (hasExt) {
          const candidate = path.join(dir, executable);
          if (fs.existsSync(candidate)) {
            resolvedPath = path.resolve(candidate);
            break;
          }
        } else {
          for (const ext of extensions) {
            const candidate = path.join(dir, executable + ext);
            if (fs.existsSync(candidate)) {
              resolvedPath = path.resolve(candidate);
              break;
            }
          }
          if (resolvedPath) break;
        }
      }
    }

    if (!resolvedPath) {
      // Retain direct executable and args so spawn produces standard ENOENT
      return { executable, args, windowsVerbatimArguments: false };
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    if (ext === '.exe' || ext === '.com') {
      return { executable: resolvedPath, args, windowsVerbatimArguments: false };
    }

    if (ext === '.cmd' || ext === '.bat') {
      // 1. Validate resolved shim path
      if (!path.isAbsolute(resolvedPath)) {
        return {
          executable,
          args,
          error: `Resolved command shim path is not absolute: "${resolvedPath}".`,
        };
      }

      try {
        if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
          return {
            executable,
            args,
            error: `Resolved command shim does not exist or is not a file: "${resolvedPath}".`,
          };
        }
      } catch (err: any) {
        return {
          executable,
          args,
          error: `Cannot access resolved command shim: ${err.message}`,
        };
      }

      // Reject paths containing expansion characters (%), quotes, newlines, or control chars
      if (/[\x00\r\n"%!]/.test(resolvedPath)) {
        return {
          executable,
          args,
          error: `Unsafe characters or expansion sequence in resolved command shim path: "${resolvedPath}".`,
        };
      }

      // 2. Resolve trusted cmd.exe (ignoring custom options.env.COMSPEC)
      const trustedCmd = this.resolveTrustedCmdExe();
      if (!trustedCmd) {
        return {
          executable,
          args,
          error: 'Cannot securely resolve trusted cmd.exe command processor on Windows.',
        };
      }

      // 3. Strict fail-closed validation for command shim arguments
      for (const arg of args) {
        if (/[\x00\r\n]/.test(arg)) {
          return {
            executable,
            args,
            error: 'Unsafe characters in command shim argument: newline or control character detected.',
          };
        }
        if (/[&|<>^%"()!]/.test(arg)) {
          return {
            executable,
            args,
            error: `Unsafe shell metacharacter in command shim argument: "${arg}".`,
          };
        }
      }

      const formattedArgs = args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg));
      const fullCommandLine = `"${resolvedPath}" ${formattedArgs.join(' ')}`.trim();

      return {
        executable: trustedCmd,
        args: ['/d', '/v:off', '/s', '/c', `"${fullCommandLine}"`],
        windowsVerbatimArguments: true,
      };
    }

    return { executable: resolvedPath, args, windowsVerbatimArguments: false };
  }

  public static async execute(options: StructuredProcessOptions): Promise<ProcessRunResult> {
    const executionId = crypto.randomUUID();
    const timeoutMs = options.timeoutMs ?? 60000;
    const commandStr = [options.executable, ...options.args].join(' ');
    const startTime = Date.now();
    const startIso = new Date(startTime).toISOString();

    // 1. Mandatory PolicyService Evaluation Gate (evaluated on raw logical command)
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
          project_id: options.projectId ?? null,
          task_id: options.taskId ?? null,
          attempt_id: options.attemptId ?? null,
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

    // 2. Resolve safe platform invocation (Windows shim vs direct binary)
    const minimalEnv = this.buildMinimalEnv(options.env);
    if (process.platform === 'win32') {
      const trustedCmd = this.resolveTrustedCmdExe();
      if (trustedCmd) {
        minimalEnv.COMSPEC = trustedCmd;
        minimalEnv.ComSpec = trustedCmd;
      }
    }
    const invocation = this.resolvePlatformInvocation(options.executable, options.args, minimalEnv);

    if (invocation.error) {
      if (options.repo) {
        options.repo.createProcessRun({
          id: executionId,
          pid: null,
          project_id: options.projectId ?? null,
          task_id: options.taskId ?? null,
          attempt_id: options.attemptId ?? null,
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
        stderr: `Process execution rejected: ${invocation.error}`,
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
        project_id: options.projectId ?? null,
        task_id: options.taskId ?? null,
        attempt_id: options.attemptId ?? null,
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
      const child = spawn(invocation.executable, invocation.args, {
        cwd: options.cwd,
        shell: options.allowShell ?? false,
        env: minimalEnv,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments ?? false,
      });

      if (child.pid && options.repo) {
        options.repo.updateProcessRunPid(executionId, child.pid);
      }

      const procEntry = { process: child, command: commandStr, isCancelled: false, repo: options.repo };
      this.activeProcesses.set(executionId, procEntry);

      const timer = setTimeout(() => {
        isTimedOut = true;
        this.killProcessTree(child);
      }, timeoutMs);

      // Safe stdin writing when provided
      if (options.stdin !== undefined && child.stdin) {
        child.stdin.on('error', () => {
          // Ignore EPIPE if child process exits early or closes stdin
        });
        try {
          child.stdin.write(options.stdin, 'utf8', () => {
            try {
              child.stdin?.end();
            } catch {
              // Ignore
            }
          });
        } catch {
          // Ignore
        }
      }

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

        let stdoutEvidenceId: string | null = null;
        let stderrEvidenceId: string | null = null;

        // Persist outputs as Evidence if artifactStore & projectId are configured
        if (options.artifactStore && options.repo && options.projectId) {
          if (stdoutAcc.trim().length > 0) {
            const ev = options.artifactStore.store(
              crypto.randomUUID(),
              options.projectId,
              options.taskId ?? null,
              null,
              'PROCESS_LOG',
              `Stdout for ${commandStr}`,
              this.scrubSecrets(stdoutAcc),
              'text/plain'
            );
            options.repo.createEvidence(ev);
            stdoutEvidenceId = ev.id;
          }
          if (stderrAcc.trim().length > 0) {
            const ev = options.artifactStore.store(
              crypto.randomUUID(),
              options.projectId,
              options.taskId ?? null,
              null,
              'PROCESS_LOG',
              `Stderr for ${commandStr}`,
              this.scrubSecrets(stderrAcc),
              'text/plain'
            );
            options.repo.createEvidence(ev);
            stderrEvidenceId = ev.id;
          }
        }

        if (options.repo) {
          try {
            options.repo.updateProcessRun(
              executionId,
              terminalStatus,
              code ?? (isTimedOut ? -2 : wasCancelled ? -1 : 0),
              endIso,
              stdoutEvidenceId,
              stderrEvidenceId
            );
          } catch {
            // DB connection may be closed if test teardown completed
          }
        }

        resolve({
          executionId,
          pid: child.pid ?? null,
          command: commandStr,
          cwd: options.cwd,
          exitCode: code ?? (isTimedOut ? -2 : wasCancelled ? -1 : 0),
          stdout: this.scrubSecrets(stdoutAcc),
          stderr: this.scrubSecrets(stderrAcc),
          durationMs,
          timedOut: isTimedOut,
          cancelled: wasCancelled,
          stdoutEvidenceId,
          stderrEvidenceId,
        });
      });
    });
  }

  public static cancel(executionId: string): boolean {
    const entry = this.activeProcesses.get(executionId);
    if (entry) {
      entry.isCancelled = true;
      if (entry.repo) {
        entry.repo.updateProcessRun(executionId, 'CANCELLED', -1, new Date().toISOString());
      }
      this.killProcessTree(entry.process);
      return true;
    }
    return false;
  }

  public static terminateAllProcesses(): number {
    const count = this.activeProcesses.size;
    for (const [id, entry] of this.activeProcesses.entries()) {
      entry.isCancelled = true;
      if (entry.repo) {
        entry.repo.updateProcessRun(id, 'CANCELLED', -1, new Date().toISOString());
      }
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
