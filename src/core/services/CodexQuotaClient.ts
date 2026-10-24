import { spawn } from 'child_process';
import type { EventEmitter } from 'events';
import os from 'os';
import path from 'path';
import type { Readable, Writable } from 'stream';
import { z } from 'zod';
import { buildTrustedEnvironment, resolveTrustedExecutable } from './ExecutableResolver';

export interface CodexRateLimitWindow {
  usedPercent: number;
  resetsAt: number | null;
  windowDurationMins: number | null;
}

export type CodexRateLimitResult = {
  status: 'OK';
  primary: CodexRateLimitWindow;
  secondary: CodexRateLimitWindow | null;
  planType: string | null;
} | {
  status: 'UNAUTHENTICATED' | 'UNAVAILABLE' | 'MALFORMED' | 'TIMEOUT';
  /** Static, sanitized explanation; never the CLI's output or error text. */
  message: string;
};

export interface CodexQuotaReader {
  readRateLimits(profileDirectory: string): Promise<CodexRateLimitResult>;
}

export interface CodexQuotaProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface CodexQuotaSpawnOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  shell: false;
  windowsHide: true;
  stdio: ['pipe', 'pipe', 'ignore'];
}

export interface CodexQuotaSpawner {
  spawn(executable: string, args: string[], options: CodexQuotaSpawnOptions): CodexQuotaProcess;
}

export class NodeCodexQuotaSpawner implements CodexQuotaSpawner {
  public spawn(executable: string, args: string[], options: CodexQuotaSpawnOptions): CodexQuotaProcess {
    return spawn(executable, args, options);
  }
}

export interface CodexQuotaClientOptions {
  spawner?: CodexQuotaSpawner;
  resolveExecutable?: () => string | null;
  /** Total deadline, including initialization; at most 15 seconds. */
  timeoutMs?: number;
}

// Generated app-server schemas permit additional fields. Strip them, while
// strictly validating consumed values without coercion or guessed defaults.
const windowSchema = z.object({
  usedPercent: z.number().int().min(0).max(100),
  resetsAt: z.number().int().min(0).max(8_640_000_000_000).nullish(),
  windowDurationMins: z.number().int().positive().nullish(),
});
const responseSchema = z.object({
  rateLimits: z.object({
    primary: windowSchema.nullish(),
    secondary: windowSchema.nullish(),
    planType: z.enum([
      'free', 'go', 'plus', 'pro', 'prolite', 'promax', 'team',
      'self_serve_business_prolite', 'self_serve_business_usage_based', 'business',
      'ent26', 'enterprise_cbp_automation', 'enterprise_cbp_usage_based',
      'enterprise', 'edu', 'edu_plus', 'edu_pro', 'unknown',
    ]).nullish(),
    rateLimitReachedType: z.enum([
      'rate_limit_reached', 'workspace_owner_credits_depleted',
      'workspace_member_credits_depleted', 'workspace_owner_usage_limit_reached',
      'workspace_member_usage_limit_reached',
    ]).nullish(),
    credits: z.object({
      hasCredits: z.boolean(),
      unlimited: z.boolean(),
      balance: z.string().nullish(),
    }).nullish(),
  }),
});
const initializeSchema = z.object({
  userAgent: z.string(),
  codexHome: z.string(),
  platformFamily: z.string(),
  platformOs: z.string(),
});
const rpcErrorSchema = z.object({ code: z.number().int(), message: z.string() });
const MAX_OUTPUT_BYTES = 1024 * 1024;

function normalizeWindow(window: z.infer<typeof windowSchema>): CodexRateLimitWindow {
  return {
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt ?? null,
    windowDurationMins: window.windowDurationMins ?? null,
  };
}

/** One short-lived, read-only app-server session per isolated native profile. */
export class CodexQuotaClient implements CodexQuotaReader {
  private readonly spawner: CodexQuotaSpawner;
  private readonly resolveExecutable: () => string | null;
  private readonly timeoutMs: number;

  constructor(options: CodexQuotaClientOptions = {}) {
    this.spawner = options.spawner ?? new NodeCodexQuotaSpawner();
    this.resolveExecutable = options.resolveExecutable ?? (() => resolveTrustedExecutable('codex', 'codex'));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 15_000) {
      throw new RangeError('Quota read timeout must be between 1 and 15000 milliseconds.');
    }
  }

  public async readRateLimits(profileDirectory: string): Promise<CodexRateLimitResult> {
    if (!path.isAbsolute(profileDirectory) || /[\u0000-\u001f\u007f]/.test(profileDirectory)) {
      return { status: 'UNAVAILABLE', message: 'A valid isolated Codex profile directory is required.' };
    }
    let child: CodexQuotaProcess;
    try {
      const executable = this.resolveExecutable();
      // Windows command shims require a shell; only launch a direct executable.
      if (!executable || (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable))) {
        return { status: 'UNAVAILABLE', message: 'A trusted Codex executable is unavailable.' };
      }
      child = this.spawner.spawn(executable, ['app-server'], {
        env: buildTrustedEnvironment({ allowedEnvKeys: ['CODEX_HOME'], customEnv: { CODEX_HOME: profileDirectory } }),
        cwd: os.tmpdir(),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      return { status: 'UNAVAILABLE', message: 'Codex quota telemetry could not be started.' };
    }

    return new Promise<CodexRateLimitResult>((resolve) => {
      let settled = false;
      let pendingId = 1;
      let buffer = '';
      let outputBytes = 0;
      const finish = (result: CodexRateLimitResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        buffer = '';
        child.stdout.removeListener('data', onData);
        child.removeListener('close', onClose);
        // Keep error handlers attached to absorb late EPIPE/process errors.
        try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
        child.stdin.destroy();
        child.stdout.destroy();
        resolve(result);
      };
      const malformed = () => finish({ status: 'MALFORMED', message: 'Codex returned malformed quota telemetry.' });
      const unavailable = () => finish({ status: 'UNAVAILABLE', message: 'Codex quota telemetry is unavailable.' });
      const onClose = () => buffer.trim() ? malformed() : unavailable();
      const send = (message: object) => {
        if (settled) return;
        try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { unavailable(); }
      };
      const onLine = (line: string) => {
        let value: unknown;
        try { value = JSON.parse(line); } catch { malformed(); return; }
        if (!value || typeof value !== 'object' || Array.isArray(value)) { malformed(); return; }
        const message = value as Record<string, unknown>;
        if (message.id !== pendingId) {
          // Notifications and unrelated response IDs cannot satisfy a read.
          if (typeof message.method !== 'string' && typeof message.id !== 'number' && typeof message.id !== 'string') malformed();
          return;
        }
        if ('error' in message) {
          const error = rpcErrorSchema.safeParse(message.error);
          if (!error.success || 'result' in message) { malformed(); return; }
          const authRequired = error.data.code === 401 || error.data.code === 403 ||
            /not (?:logged|signed) in|unauthenticated|unauthorized|authentication (?:is )?required|requires? chatgpt auth|missing authentication/i.test(error.data.message);
          finish(authRequired
            ? { status: 'UNAUTHENTICATED', message: 'Codex authentication is required for quota telemetry.' }
            : { status: 'UNAVAILABLE', message: 'Codex could not provide quota telemetry.' });
          return;
        }
        if (pendingId === 1) {
          const initialized = initializeSchema.safeParse(message.result);
          if (!initialized.success) { malformed(); return; }
          const normalize = (directory: string) => process.platform === 'win32'
            ? path.resolve(directory).toLowerCase() : path.resolve(directory);
          if (!path.isAbsolute(initialized.data.codexHome) || normalize(initialized.data.codexHome) !== normalize(profileDirectory)) {
            finish({ status: 'UNAVAILABLE', message: 'Codex did not initialize the requested isolated profile.' });
            return;
          }
          pendingId = 2;
          send({ method: 'initialized' });
          // No login, threads, turns, execution, or reserve/credit mutations.
          send({ id: 2, method: 'account/rateLimits/read', params: {} });
          return;
        }
        const parsed = responseSchema.safeParse(message.result);
        if (!parsed.success) { malformed(); return; }
        const snapshot = parsed.data.rateLimits;
        if (!snapshot.primary) {
          finish({ status: 'UNAVAILABLE', message: 'Codex did not report a primary quota window.' });
          return;
        }
        finish({
          status: 'OK',
          primary: normalizeWindow(snapshot.primary),
          secondary: snapshot.secondary ? normalizeWindow(snapshot.secondary) : null,
          planType: snapshot.planType ?? null,
        });
      };
      const onData = (chunk: string | Buffer) => {
        if (settled) return;
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_OUTPUT_BYTES) { malformed(); return; }
        buffer += chunk.toString();
        let newline: number;
        while (!settled && (newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) onLine(line);
        }
      };
      const deadline = setTimeout(() => finish({ status: 'TIMEOUT', message: 'Codex quota telemetry timed out.' }), this.timeoutMs);
      deadline.unref?.();
      child.on('error', unavailable);
      child.once('close', onClose);
      child.stdin.on('error', unavailable);
      child.stdout.on('error', unavailable);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', onData);
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent_forge_quota', version: '1.0.0' } } });
    });
  }
}
