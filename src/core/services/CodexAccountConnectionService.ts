import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { NativeProfileResolver } from '../credentials/NativeProfileResolver';
import type { Repository } from '../database/repositories';
import { NodeCodexQuotaSpawner, type CodexQuotaProcess, type CodexQuotaSpawner } from './CodexQuotaClient';
import { buildTrustedEnvironment, resolveTrustedExecutable } from './ExecutableResolver';

export type DeviceLoginStartErrorCode =
  | 'ACCOUNT_NOT_FOUND' | 'NOT_A_CODEX_ACCOUNT' | 'PROFILE_UNAVAILABLE'
  | 'CODEX_UNAVAILABLE' | 'LOGIN_ALREADY_IN_PROGRESS' | 'PROTOCOL_ERROR' | 'TIMEOUT';

export type DeviceLoginStartResult = {
  success: true;
  sessionId: string;
  accountId: string;
  userCode: string;
  verificationUrl: string;
  /** ISO timestamp for the service's total deadline, including initialization. */
  expiresAt: string;
} | { success: false; errorCode: DeviceLoginStartErrorCode };

export interface DeviceLoginStatus {
  state: 'WAITING_FOR_USER' | 'SIGNED_IN' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
  accountId: string;
  userCode?: string;
  verificationUrl?: string;
  expiresAt: string;
  errorCode?: DeviceLoginStartErrorCode | 'LOGIN_FAILED';
}

export interface CodexAccountConnectionServiceOptions {
  spawner?: CodexQuotaSpawner;
  resolveExecutable?: () => string | null;
  profileResolver?: Pick<NativeProfileResolver, 'resolve'>;
  now?: () => string;
  /** Total deadline, including initialization; defaults to 15 minutes, at most 30. */
  timeoutMs?: number;
  onSignedIn?: (accountId: string) => void | Promise<void>;
}

// Like the quota client, strip extension fields but never coerce consumed fields.
const initializeSchema = z.object({
  userAgent: z.string(), codexHome: z.string(), platformFamily: z.string(), platformOs: z.string(),
});
const loginStartSchema = z.object({
  type: z.literal('chatgptDeviceCode'),
  loginId: z.string().min(1),
  userCode: z.string().min(1).max(32).refine((value) => !/[^a-z0-9-]/i.test(value)),
  verificationUrl: z.string().refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password &&
        (url.hostname === 'auth.openai.com' || url.hostname.endsWith('.openai.com') || url.hostname === 'chatgpt.com');
    } catch { return false; }
  }),
});
const completionIdentitySchema = z.object({ loginId: z.string().min(1) });
const completionSchema = completionIdentitySchema.extend({ success: z.boolean(), error: z.string().nullable() });
const rpcErrorSchema = z.object({ code: z.number().int(), message: z.string() });
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Optional profile-bound login. Only the native CLI handles/persists credentials. */
export class CodexAccountConnectionService {
  private readonly spawner: CodexQuotaSpawner;
  private readonly resolveExecutable: () => string | null;
  private readonly profileResolver: Pick<NativeProfileResolver, 'resolve'> | undefined;
  private readonly now: () => string;
  private readonly timeoutMs: number;
  private readonly onSignedIn: CodexAccountConnectionServiceOptions['onSignedIn'];
  private readonly sessions = new Map<string, DeviceLoginStatus>();
  private readonly active = new Map<string, { cancel: () => void }>();
  private disposed = false;

  constructor(private readonly repo: Repository, options: CodexAccountConnectionServiceOptions = {}) {
    this.spawner = options.spawner ?? new NodeCodexQuotaSpawner();
    this.resolveExecutable = options.resolveExecutable ?? (() => resolveTrustedExecutable('codex', 'codex'));
    this.profileResolver = options.profileResolver;
    this.now = options.now ?? (() => new Date().toISOString());
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
    this.onSignedIn = options.onSignedIn;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30 * 60_000) {
      throw new RangeError('Login timeout must be between 1 and 1800000 milliseconds.');
    }
  }

  public async startDeviceLogin(accountId: string): Promise<DeviceLoginStartResult> {
    if (this.disposed) return { success: false, errorCode: 'CODEX_UNAVAILABLE' };
    const account = this.repo.getProviderAccount(accountId);
    // Disabled accounts are unavailable for onboarding, just like missing ones.
    if (!account || !account.enabled) return { success: false, errorCode: 'ACCOUNT_NOT_FOUND' };
    if (account.provider_id !== 'prov-codex-cli' || account.auth_mode !== 'NATIVE_PROFILE') {
      return { success: false, errorCode: 'NOT_A_CODEX_ACCOUNT' };
    }
    if (this.active.has(accountId)) return { success: false, errorCode: 'LOGIN_ALREADY_IN_PROGRESS' };

    let profileDirectory: string;
    try {
      if (!account.profile_ref) return { success: false, errorCode: 'PROFILE_UNAVAILABLE' };
      const profile = (this.profileResolver ?? new NativeProfileResolver()).resolve(account.profile_ref);
      profileDirectory = profile.profileDirectory;
      if (profile.provider !== 'codex' || !path.isAbsolute(profileDirectory) || /[\u0000-\u001f\u007f]/.test(profileDirectory)) {
        return { success: false, errorCode: 'PROFILE_UNAVAILABLE' };
      }
      // Never inspect profile contents, including native authentication files.
      fs.mkdirSync(profileDirectory, { recursive: true });
    } catch { return { success: false, errorCode: 'PROFILE_UNAVAILABLE' }; }

    const expiresAt = new Date(Date.parse(this.now()) + this.timeoutMs).toISOString();
    let child: CodexQuotaProcess;
    try {
      const executable = this.resolveExecutable();
      if (!executable || (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable))) {
        return { success: false, errorCode: 'CODEX_UNAVAILABLE' };
      }
      child = this.spawner.spawn(executable, ['app-server'], {
        env: buildTrustedEnvironment({ allowedEnvKeys: ['CODEX_HOME'], customEnv: { CODEX_HOME: profileDirectory } }),
        cwd: os.tmpdir(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch { return { success: false, errorCode: 'CODEX_UNAVAILABLE' }; }

    const sessionId = randomUUID();
    const status: DeviceLoginStatus = { state: 'WAITING_FOR_USER', accountId, expiresAt };
    this.sessions.set(sessionId, status);
    return new Promise<DeviceLoginStartResult>((resolve) => {
      let finished = false;
      let started = false;
      let pendingId: 1 | 2 | null = 1;
      let loginId: string | null = null;
      let buffer = '';
      let outputBytes = 0;
      const finish = (state: DeviceLoginStatus['state'], errorCode?: DeviceLoginStatus['errorCode']) => {
        if (finished) return;
        finished = true;
        status.state = state;
        status.errorCode = errorCode;
        delete status.userCode;
        delete status.verificationUrl;
        clearTimeout(deadline);
        buffer = '';
        this.active.delete(accountId);
        child.stdout.removeListener('data', onData);
        child.removeListener('close', onClose);
        if (state === 'CANCELLED' && loginId) {
          // Fence terminal state before writing, so synchronous replies/errors
          // cannot turn cancellation into success or failure.
          try { child.stdin.write(`${JSON.stringify({ id: 3, method: 'account/login/cancel', params: { loginId } })}\n`); } catch { /* Still cancel locally. */ }
        }
        loginId = null;
        // Retain error handlers to absorb late process errors/EPIPE after kill.
        try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
        child.stdin.destroy();
        child.stdout.destroy();
        if (!started) {
          this.sessions.delete(sessionId);
          resolve({ success: false, errorCode: errorCode === 'LOGIN_FAILED' || !errorCode ? 'CODEX_UNAVAILABLE' : errorCode });
        }
        if (state === 'SIGNED_IN') {
          // Quota/health verification belongs to the caller. Hook failures must
          // neither leak provider text nor turn into unhandled rejections.
          try { void Promise.resolve(this.onSignedIn?.(accountId)).catch(() => undefined); } catch { /* Hook failed. */ }
        }
      };
      const malformed = () => finish('FAILED', 'PROTOCOL_ERROR');
      const unavailable = () => finish('FAILED', 'CODEX_UNAVAILABLE');
      const onClose = () => buffer.trim() ? malformed() : unavailable();
      const send = (message: object) => {
        if (finished) return;
        try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { unavailable(); }
      };
      const onLine = (line: string) => {
        let value: unknown;
        try { value = JSON.parse(line); } catch { malformed(); return; }
        if (!value || typeof value !== 'object' || Array.isArray(value)) { malformed(); return; }
        const message = value as Record<string, unknown>;
        if (message.method === 'account/login/completed' && !('id' in message)) {
          const identity = completionIdentitySchema.safeParse(message.params);
          if (!identity.success) { malformed(); return; }
          if (identity.data.loginId !== loginId) return;
          const completed = completionSchema.safeParse(message.params);
          if (!completed.success) { malformed(); return; }
          finish(completed.data.success ? 'SIGNED_IN' : 'FAILED', completed.data.success ? undefined : 'LOGIN_FAILED');
          return;
        }
        if (pendingId === null || message.id !== pendingId) {
          if (typeof message.method !== 'string' && typeof message.id !== 'number' && typeof message.id !== 'string') malformed();
          return;
        }
        if ('error' in message) {
          if (!rpcErrorSchema.safeParse(message.error).success || 'result' in message) malformed();
          else unavailable();
          return;
        }
        if (pendingId === 1) {
          const initialized = initializeSchema.safeParse(message.result);
          if (!initialized.success) { malformed(); return; }
          const normalize = (directory: string) => process.platform === 'win32'
            ? path.resolve(directory).toLowerCase() : path.resolve(directory);
          if (!path.isAbsolute(initialized.data.codexHome) || normalize(initialized.data.codexHome) !== normalize(profileDirectory)) {
            finish('FAILED', 'PROFILE_UNAVAILABLE');
            return;
          }
          pendingId = 2;
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/login/start', params: { type: 'chatgptDeviceCode' } });
          return;
        }
        const parsed = loginStartSchema.safeParse(message.result);
        if (!parsed.success) { malformed(); return; }
        pendingId = null;
        loginId = parsed.data.loginId;
        status.userCode = parsed.data.userCode;
        status.verificationUrl = parsed.data.verificationUrl;
        started = true;
        resolve({ success: true, sessionId, accountId, userCode: parsed.data.userCode, verificationUrl: parsed.data.verificationUrl, expiresAt });
      };
      const onData = (chunk: string | Buffer) => {
        if (finished) return;
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_OUTPUT_BYTES) { malformed(); return; }
        buffer += chunk.toString();
        let newline: number;
        while (!finished && (newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) onLine(line);
        }
      };
      const deadline = setTimeout(() => finish('TIMED_OUT', 'TIMEOUT'), this.timeoutMs);
      deadline.unref?.();
      this.active.set(accountId, { cancel: () => finish('CANCELLED') });
      child.on('error', unavailable);
      child.once('close', onClose);
      child.stdin.on('error', unavailable);
      child.stdout.on('error', unavailable);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', onData);
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent_forge_login', version: '1.0.0' } } });
    });
  }

  public getLoginStatus(sessionId: string): DeviceLoginStatus | null {
    const status = this.sessions.get(sessionId);
    return status ? { ...status } : null;
  }

  public cancelLogin(sessionId: string): void {
    const status = this.sessions.get(sessionId);
    if (status?.state === 'WAITING_FOR_USER') this.active.get(status.accountId)?.cancel();
  }

  public dispose(): void {
    this.disposed = true;
    for (const session of this.active.values()) session.cancel();
  }
}
