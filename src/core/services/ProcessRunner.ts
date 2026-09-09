import { spawn, ChildProcess } from 'child_process';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { PolicyService } from './PolicyService';
import { Repository } from '../database/repositories';
import { ArtifactStore } from './ArtifactStore';

export type ProcessStartTruth = 'NOT_STARTED_PROVEN' | 'STARTED_PROVEN' | 'START_AMBIGUOUS';
export type ProcessTerminationTruth =
  | 'NOT_APPLICABLE'
  | 'PROCESS_TREE_TERMINATED_PROVEN'
  | 'TERMINATION_UNRESOLVED';

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
  outputLimitExceeded?: boolean;
  errorCode?: 'TIMEOUT' | 'CANCELLED' | 'PROCESS_LAUNCH_FAILED' | 'NONZERO_EXIT' | 'OUTPUT_LIMIT_EXCEEDED' | null;
  stdoutEvidenceId?: string | null;
  stderrEvidenceId?: string | null;
  processStart: ProcessStartTruth;
  processTermination: ProcessTerminationTruth;
}

export interface StructuredProcessOptions {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  env?: Record<string, string>;
  allowedEnvKeys?: string[];
  allowShell?: boolean;
  repo?: Repository;
  artifactStore?: ArtifactStore;
  projectId?: string;
  taskId?: string;
  attemptId?: string | null;
  stdin?: string;
  executionId?: string;
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
  private static terminationPromises = new Map<number, Promise<ProcessTerminationTruth>>();

  public static readonly DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024; // 8 MiB default
  public static readonly MAX_ALLOWED_OUTPUT_BYTES = 32 * 1024 * 1024; // 32 MiB hard cap

  private static validateCustomEnv(
    customEnv?: Record<string, string>,
    allowedEnvKeys?: string[]
  ): string | null {
    if (!customEnv || Object.keys(customEnv).length === 0) return null;
    if (!allowedEnvKeys || allowedEnvKeys.length === 0) {
      const firstKey = Object.keys(customEnv)[0];
      return `Unauthorized custom environment variable key: "${firstKey}". No allowedEnvKeys were authorized.`;
    }
    const allowedSet = new Set(allowedEnvKeys);
    for (const key of Object.keys(customEnv)) {
      if (!allowedSet.has(key)) {
        return `Unauthorized custom environment variable key: "${key}".`;
      }
    }
    return null;
  }

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

  private static buildMinimalEnv(
    customEnv?: Record<string, string>,
    allowedEnvKeys?: string[]
  ): NodeJS.ProcessEnv {
    const minimal: NodeJS.ProcessEnv = {};
    for (const key of this.SAFE_ENV_VARS) {
      if (process.env[key]) {
        minimal[key] = process.env[key];
      }
    }
    if (customEnv && allowedEnvKeys && allowedEnvKeys.length > 0) {
      const allowedSet = new Set(allowedEnvKeys);
      for (const [k, v] of Object.entries(customEnv)) {
        if (allowedSet.has(k)) {
          minimal[k] = v;
        }
      }
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
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          executable,
          args,
          error: `Cannot access resolved command shim: ${errMsg}`,
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
    let executionId: string;
    const commandStr = [options.executable, ...options.args].join(' ');

    if (options.executionId !== undefined) {
      if (
        typeof options.executionId !== 'string' ||
        !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(options.executionId)
      ) {
        return {
          executionId: typeof options.executionId === 'string' ? options.executionId : 'INVALID_ID',
          pid: null,
          command: this.scrubSecrets(commandStr),
          cwd: options.cwd,
          exitCode: -1,
          stdout: '',
          stderr: `INVALID_EXECUTION_ID: Supplied executionId "${options.executionId}" is not a valid canonical UUID.`,
          durationMs: 0,
          timedOut: false,
          cancelled: false,
          outputLimitExceeded: false,
          errorCode: 'PROCESS_LAUNCH_FAILED',
          processStart: 'NOT_STARTED_PROVEN',
          processTermination: 'NOT_APPLICABLE',
        };
      }
      if (this.activeProcesses.has(options.executionId)) {
        return {
          executionId: options.executionId,
          pid: null,
          command: this.scrubSecrets(commandStr),
          cwd: options.cwd,
          exitCode: -1,
          stdout: '',
          stderr: `DUPLICATE_ACTIVE_PROCESS_ID: Execution ID "${options.executionId}" is already active in ProcessRunner.`,
          durationMs: 0,
          timedOut: false,
          cancelled: false,
          outputLimitExceeded: false,
          errorCode: 'PROCESS_LAUNCH_FAILED',
          processStart: 'NOT_STARTED_PROVEN',
          processTermination: 'NOT_APPLICABLE',
        };
      }
      executionId = options.executionId;
    } else {
      executionId = crypto.randomUUID();
    }

    const timeoutMs = options.timeoutMs ?? 60000;
    const startTime = Date.now();
    const startIso = new Date(startTime).toISOString();

    const maxStdout =
      options.maxStdoutBytes !== undefined && options.maxStdoutBytes > 0
        ? Math.min(options.maxStdoutBytes, this.MAX_ALLOWED_OUTPUT_BYTES)
        : this.DEFAULT_MAX_OUTPUT_BYTES;
    const maxStderr =
      options.maxStderrBytes !== undefined && options.maxStderrBytes > 0
        ? Math.min(options.maxStderrBytes, this.MAX_ALLOWED_OUTPUT_BYTES)
        : this.DEFAULT_MAX_OUTPUT_BYTES;

    // 1. Mandatory PolicyService Evaluation Gate (evaluated on raw logical command)
    const policy = PolicyService.evaluateProcessExecution(
      options.executable,
      options.args,
      options.allowShell ?? false
    );

    if (!policy.allowed) {
      if (options.repo) {
        try {
          options.repo.createProcessRun({
            id: executionId,
            pid: null,
            project_id: options.projectId ?? null,
            task_id: options.taskId ?? null,
            attempt_id: options.attemptId ?? null,
            command: this.scrubSecrets(commandStr),
            working_directory: options.cwd,
            status: 'FAILED',
            start_time: startIso,
          });
          options.repo.updateProcessRun(executionId, 'FAILED', -1, new Date().toISOString(), null, null);
        } catch {
          // Ignore collision or persistence error on rejection path
        }
      }

      return {
        executionId,
        pid: null,
        command: this.scrubSecrets(commandStr),
        cwd: options.cwd,
        exitCode: -1,
        stdout: '',
        stderr: `Security Policy Violation: ${policy.reason} (${policy.decision})`,
        durationMs: 0,
        timedOut: false,
        cancelled: false,
        outputLimitExceeded: false,
        errorCode: 'PROCESS_LAUNCH_FAILED',
        processStart: 'NOT_STARTED_PROVEN',
        processTermination: 'NOT_APPLICABLE',
      };
    }

    // 2. Custom Environment Allowlist Validation Gate
    const envValidationError = this.validateCustomEnv(options.env, options.allowedEnvKeys);
    if (envValidationError) {
      if (options.repo) {
        try {
          options.repo.createProcessRun({
            id: executionId,
            pid: null,
            project_id: options.projectId ?? null,
            task_id: options.taskId ?? null,
            attempt_id: options.attemptId ?? null,
            command: this.scrubSecrets(commandStr),
            working_directory: options.cwd,
            status: 'FAILED',
            start_time: startIso,
          });
          options.repo.updateProcessRun(executionId, 'FAILED', -1, new Date().toISOString(), null, null);
        } catch {
          // Ignore collision or persistence error on rejection path
        }
      }

      return {
        executionId,
        pid: null,
        command: this.scrubSecrets(commandStr),
        cwd: options.cwd,
        exitCode: -1,
        stdout: '',
        stderr: `Process execution rejected: ${envValidationError}`,
        durationMs: 0,
        timedOut: false,
        cancelled: false,
        outputLimitExceeded: false,
        errorCode: 'PROCESS_LAUNCH_FAILED',
        processStart: 'NOT_STARTED_PROVEN',
        processTermination: 'NOT_APPLICABLE',
      };
    }

    // 3. Resolve safe platform invocation (Windows shim vs direct binary)
    const minimalEnv = this.buildMinimalEnv(options.env, options.allowedEnvKeys);
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
          command: this.scrubSecrets(commandStr),
          working_directory: options.cwd,
          status: 'FAILED',
          start_time: startIso,
        });
        options.repo.updateProcessRun(executionId, 'FAILED', -1, new Date().toISOString(), null, null);
      }

      return {
        executionId,
        pid: null,
        command: this.scrubSecrets(commandStr),
        cwd: options.cwd,
        exitCode: -1,
        stdout: '',
        stderr: `Process execution rejected: ${invocation.error}`,
        durationMs: 0,
        timedOut: false,
        cancelled: false,
        outputLimitExceeded: false,
        errorCode: 'PROCESS_LAUNCH_FAILED',
        processStart: 'NOT_STARTED_PROVEN',
        processTermination: 'NOT_APPLICABLE',
      };
    }

    // Persist RUNNING process run in database if repository provided
    if (options.repo) {
      try {
        options.repo.createProcessRun({
          id: executionId,
          pid: null,
          project_id: options.projectId ?? null,
          task_id: options.taskId ?? null,
          attempt_id: options.attemptId ?? null,
          command: this.scrubSecrets(commandStr),
          working_directory: options.cwd,
          status: 'RUNNING',
          start_time: startIso,
        });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          executionId,
          pid: null,
          command: this.scrubSecrets(commandStr),
          cwd: options.cwd,
          exitCode: -1,
          stdout: '',
          stderr: `PERSISTED_PROCESS_RUN_COLLISION: Failed to create process run record for ID "${executionId}": ${errMsg}`,
          durationMs: 0,
          timedOut: false,
          cancelled: false,
          outputLimitExceeded: false,
          errorCode: 'PROCESS_LAUNCH_FAILED',
          processStart: 'NOT_STARTED_PROVEN',
          processTermination: 'NOT_APPLICABLE',
        };
      }
    }

    return new Promise((resolve) => {
      let stdoutAcc = '';
      let stderrAcc = '';
      let stdoutByteCount = 0;
      let stderrByteCount = 0;
      let isTimedOut = false;
      let isOutputLimitExceeded = false;

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

      let startTruth: ProcessStartTruth = 'STARTED_PROVEN';
      let terminationTruth: ProcessTerminationTruth = 'NOT_APPLICABLE';

      const timer = setTimeout(() => {
        isTimedOut = true;
        ProcessRunner.terminateProcessTree(child);
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
        child.stdout.on('data', (data: Buffer | string) => {
          if (isOutputLimitExceeded) return;
          const chunkBuf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
          const chunkLen = chunkBuf.length;

          if (stdoutByteCount + chunkLen > maxStdout) {
            isOutputLimitExceeded = true;
            const remaining = maxStdout - stdoutByteCount;
            if (remaining > 0) {
              stdoutAcc += chunkBuf.subarray(0, remaining).toString('utf8');
              stdoutByteCount += remaining;
            }
            ProcessRunner.terminateProcessTree(child);
            return;
          }

          stdoutAcc += chunkBuf.toString('utf8');
          stdoutByteCount += chunkLen;
        });
      }

      if (child.stderr) {
        child.stderr.on('data', (data: Buffer | string) => {
          if (isOutputLimitExceeded) return;
          const chunkBuf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
          const chunkLen = chunkBuf.length;

          if (stderrByteCount + chunkLen > maxStderr) {
            isOutputLimitExceeded = true;
            const remaining = maxStderr - stderrByteCount;
            if (remaining > 0) {
              stderrAcc += chunkBuf.subarray(0, remaining).toString('utf8');
              stderrByteCount += remaining;
            }
            ProcessRunner.terminateProcessTree(child);
            return;
          }

          stderrAcc += chunkBuf.toString('utf8');
          stderrByteCount += chunkLen;
        });
      }

      child.on('error', async (err) => {
        clearTimeout(timer);
        const wasCancelled = procEntry.isCancelled;
        this.activeProcesses.delete(executionId);
        const durationMs = Date.now() - startTime;
        const endIso = new Date().toISOString();

        let finalErrorCode: 'TIMEOUT' | 'CANCELLED' | 'PROCESS_LAUNCH_FAILED' | 'NONZERO_EXIT' | 'OUTPUT_LIMIT_EXCEEDED' =
          'PROCESS_LAUNCH_FAILED';
        if (wasCancelled) {
          finalErrorCode = 'CANCELLED';
        } else if (isTimedOut) {
          finalErrorCode = 'TIMEOUT';
        } else if (isOutputLimitExceeded) {
          finalErrorCode = 'OUTPUT_LIMIT_EXCEEDED';
        }

        if (options.repo) {
          options.repo.updateProcessRun(
            executionId,
            wasCancelled ? 'CANCELLED' : 'FAILED',
            -1,
            endIso
          );
        }

        const hasPid = typeof child.pid === 'number' && child.pid > 0;
        let termStatus: ProcessTerminationTruth = 'NOT_APPLICABLE';
        if (hasPid) {
          termStatus = await ProcessRunner.terminateProcessTree(child);
        }
        const startStatus: ProcessStartTruth = hasPid ? 'START_AMBIGUOUS' : 'NOT_STARTED_PROVEN';

        resolve({
          executionId,
          pid: child.pid ?? null,
          command: this.scrubSecrets(commandStr),
          cwd: options.cwd,
          exitCode: -1,
          stdout: this.scrubSecrets(stdoutAcc),
          stderr: this.scrubSecrets(`Failed to start process: ${err.message}`),
          durationMs,
          timedOut: isTimedOut,
          cancelled: wasCancelled,
          outputLimitExceeded: isOutputLimitExceeded,
          errorCode: finalErrorCode,
          processStart: startStatus,
          processTermination: termStatus,
        });
      });

      child.on('close', async (code) => {
        clearTimeout(timer);
        const wasCancelled = procEntry.isCancelled;
        this.activeProcesses.delete(executionId);
        const durationMs = Date.now() - startTime;
        const endIso = new Date().toISOString();

        let terminalStatus: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' = 'COMPLETED';
        let finalErrorCode: 'TIMEOUT' | 'CANCELLED' | 'PROCESS_LAUNCH_FAILED' | 'NONZERO_EXIT' | 'OUTPUT_LIMIT_EXCEEDED' | null =
          null;

        if (wasCancelled) {
          terminalStatus = 'CANCELLED';
          finalErrorCode = 'CANCELLED';
        } else if (isTimedOut) {
          terminalStatus = 'TIMED_OUT';
          finalErrorCode = 'TIMEOUT';
        } else if (isOutputLimitExceeded) {
          terminalStatus = 'FAILED';
          finalErrorCode = 'OUTPUT_LIMIT_EXCEEDED';
        } else if (code !== 0) {
          terminalStatus = 'FAILED';
          finalErrorCode = 'NONZERO_EXIT';
        }

        if (isTimedOut || wasCancelled || isOutputLimitExceeded) {
          terminationTruth = await ProcessRunner.terminateProcessTree(child);
        } else {
          terminationTruth = 'PROCESS_TREE_TERMINATED_PROVEN';
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
              `Stdout for ${this.scrubSecrets(commandStr)}`,
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
              `Stderr for ${this.scrubSecrets(commandStr)}`,
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
              code ?? (isTimedOut ? -2 : wasCancelled ? -1 : isOutputLimitExceeded ? -3 : 0),
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
          command: this.scrubSecrets(commandStr),
          cwd: options.cwd,
          exitCode: code ?? (isTimedOut ? -2 : wasCancelled ? -1 : isOutputLimitExceeded ? -3 : 0),
          stdout: this.scrubSecrets(stdoutAcc),
          stderr: this.scrubSecrets(
            isOutputLimitExceeded
              ? `${stderrAcc}\n[Process output limit exceeded]`.trim()
              : stderrAcc
          ),
          durationMs,
          timedOut: isTimedOut,
          cancelled: wasCancelled,
          outputLimitExceeded: isOutputLimitExceeded,
          errorCode: finalErrorCode,
          stdoutEvidenceId,
          stderrEvidenceId,
          processStart: startTruth,
          processTermination: terminationTruth,
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
      this.terminateProcessTree(entry.process);
      return true;
    }
    return false;
  }

  public static async cancelAsync(executionId: string): Promise<ProcessTerminationTruth> {
    const entry = this.activeProcesses.get(executionId);
    if (entry) {
      entry.isCancelled = true;
      if (entry.repo) {
        entry.repo.updateProcessRun(executionId, 'CANCELLED', -1, new Date().toISOString());
      }
      return this.terminateProcessTree(entry.process);
    }
    return 'NOT_APPLICABLE';
  }

  public static terminateAllProcesses(): number {
    const count = this.activeProcesses.size;
    for (const [id, entry] of this.activeProcesses.entries()) {
      entry.isCancelled = true;
      if (entry.repo) {
        entry.repo.updateProcessRun(id, 'CANCELLED', -1, new Date().toISOString());
      }
      this.terminateProcessTree(entry.process);
      this.activeProcesses.delete(id);
    }
    return count;
  }

  public static async terminateAllProcessesAsync(): Promise<{ count: number; unproven: number; allTerminatedProven: boolean }> {
    const count = this.activeProcesses.size;
    const promises: Promise<ProcessTerminationTruth>[] = [];
    for (const [id, entry] of this.activeProcesses.entries()) {
      entry.isCancelled = true;
      if (entry.repo) {
        entry.repo.updateProcessRun(id, 'CANCELLED', -1, new Date().toISOString());
      }
      promises.push(this.terminateProcessTree(entry.process));
      this.activeProcesses.delete(id);
    }
    const results = await Promise.all(promises);
    const unproven = results.filter((r) => r !== 'PROCESS_TREE_TERMINATED_PROVEN' && r !== 'NOT_APPLICABLE').length;
    return { count, unproven, allTerminatedProven: unproven === 0 };
  }

  public static getActiveProcessCount(): number {
    return this.activeProcesses.size;
  }

  public static terminateProcessTree(
    child: ChildProcess,
    timeoutMs = 5000
  ): Promise<ProcessTerminationTruth> {
    if (!child.pid) return Promise.resolve('NOT_APPLICABLE');
    const pid = child.pid;
    const existing = this.terminationPromises.get(pid);
    if (existing) {
      return existing;
    }

    const promise = (async (): Promise<ProcessTerminationTruth> => {
      try {
        if (process.platform === 'win32') {
          const taskkillExitCode = await new Promise<number | null>((resolve) => {
            let tk: ChildProcess;
            try {
              tk = spawn('taskkill', ['/F', '/T', '/PID', pid.toString()], {
                windowsHide: true,
                stdio: 'ignore',
              });
            } catch {
              return resolve(null);
            }
            const timer = setTimeout(() => {
              try {
                tk.kill('SIGKILL');
              } catch {
                // termination attempt bounded
              }
              resolve(null);
            }, timeoutMs);
            tk.on('error', () => {
              clearTimeout(timer);
              resolve(null);
            });
            tk.on('close', (closeCode) => {
              clearTimeout(timer);
              resolve(closeCode);
            });
          });

          // Explicit bounded post-kill liveness verification
          const isDead = await ProcessRunner.verifyProcessDeadWithDeadline(pid, timeoutMs);

          if (isDead && (taskkillExitCode === 0 || taskkillExitCode === 128)) {
            return 'PROCESS_TREE_TERMINATED_PROVEN';
          }
          return 'TERMINATION_UNRESOLVED';
        } else {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            try {
              child.kill('SIGKILL');
            } catch {
              // fallback kill bounded
            }
          }
          const isDead = await ProcessRunner.verifyProcessDeadWithDeadline(pid, timeoutMs);
          return isDead ? 'PROCESS_TREE_TERMINATED_PROVEN' : 'TERMINATION_UNRESOLVED';
        }
      } catch {
        return 'TERMINATION_UNRESOLVED';
      } finally {
        this.terminationPromises.delete(pid);
      }
    })();

    this.terminationPromises.set(pid, promise);
    return promise;
  }

  public static async verifyProcessDeadWithDeadline(pid: number, timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + Math.min(timeoutMs, 2000);
    while (Date.now() <= deadline) {
      try {
        process.kill(pid, 0);
        // Still alive
        await new Promise((r) => setTimeout(r, 25));
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === 'ESRCH') {
          return true;
        }
        return false;
      }
    }
    return false;
  }

  public async verifyProcessDeadWithDeadline(pid: number, timeoutMs = 2000): Promise<boolean> {
    return ProcessRunner.verifyProcessDeadWithDeadline(pid, timeoutMs);
  }

  public async terminateAllProcessesAsync(): Promise<void> {
    await ProcessRunner.terminateAllProcessesAsync();
  }

  public static async killProcessTreeAsync(
    child: ChildProcess,
    timeoutMs = 5000
  ): Promise<ProcessTerminationTruth> {
    return this.terminateProcessTree(child, timeoutMs);
  }
}
