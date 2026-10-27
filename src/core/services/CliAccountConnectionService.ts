import type { AntigravityCredentialSlots } from '../credentials/AntigravityCredentialSlots';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NativeProfileResolver } from '../credentials/NativeProfileResolver';
import type { Repository } from '../database/repositories';
import { AccountHealthService } from './AccountHealthService';
import { buildTrustedEnvironment, resolveTrustedExecutable } from './ExecutableResolver';
import { ProcessRunner } from './ProcessRunner';
import { classifyAntigravityFailure } from '../adapters/AntigravityCliAdapter';

export type CliSignInErrorCode =
  | 'ACCOUNT_NOT_FOUND' | 'NOT_A_SUPPORTED_CLI_ACCOUNT' | 'PROFILE_UNAVAILABLE' | 'CLI_UNAVAILABLE' | 'UNSUPPORTED_PLATFORM';

export type CliVerifyReason = 'VERIFIED' | 'NOT_SIGNED_IN' | 'NOT_A_SUBSCRIPTION_LOGIN' | 'VERIFY_FAILED' | 'ALREADY_IN_USE';


interface CliDriver {
  label: string;
  profileProvider: 'claude' | 'gemini' | 'antigravity';
  /** The variables that point the CLI at the account's profile. */
  profileEnv: (profileDirectory: string) => Record<string, string>;
  loginArgs: string[];
  verify: (check: (args: string[], timeoutMs: number) => Promise<CliRunResult>, profileDirectory: string) => Promise<CliVerifyReason>;
}

export interface CliRunResult { exitCode: number | null; stdout: string; stderr?: string }
export interface CliRunner {
  /** Runs a short, non-interactive check in `cwd` with only the profile variable added to a minimal environment. */
  run(executable: string, args: string[], profileEnv: Record<string, string>, cwd: string, timeoutMs: number): Promise<CliRunResult>;
  /** Opens a visible terminal where the owner completes the CLI's own browser sign-in. */
  openTerminal(executable: string, args: string[], profileEnv: Record<string, string>, cwd: string): void;
}

/** A path that can be placed inside a cmd.exe command line without any interpretation. */
const SAFE_WINDOWS_PATH = /^[A-Za-z]:\\[^"&|<>^%!\r\n]*[^"&|<>^%!\r\n\\]$/;

export class NodeCliRunner implements CliRunner {
  public async run(executable: string, args: string[], profileEnv: Record<string, string>, cwd: string, timeoutMs: number): Promise<CliRunResult> {
    // ProcessRunner: minimal environment, trusted cmd.exe for .cmd shims, no shell, bounded output, no durable rows.
    const result = await ProcessRunner.execute({
      executable, args, cwd, timeoutMs, env: profileEnv, allowedEnvKeys: Object.keys(profileEnv), allowShell: false,
      maxStdoutBytes: 256 * 1024, maxStderrBytes: 64 * 1024, deferPersistence: true,
    });
    return { exitCode: result.timedOut || result.cancelled ? null : result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  public openTerminal(executable: string, args: string[], profileEnv: Record<string, string>, cwd: string): void {
    if (process.platform !== 'win32') throw new Error('UNSUPPORTED_PLATFORM');
    // Never a cmd.exe found through cwd or PATH, and no AutoRun commands (/d) in either shell.
    const cmd = resolveTrustedExecutable('cmd', 'cmd', { env: process.env });
    if (!cmd || !SAFE_WINDOWS_PATH.test(cmd) || !SAFE_WINDOWS_PATH.test(executable) || args.some((arg) => !/^[a-z-]+$/i.test(arg))) {
      throw new Error('UNSAFE_COMMAND');
    }
    // cmd /d /c start "<title>" "<cmd>" /d /k ""<cli>" <args>": every part is validated above.
    const command = `/d /c start "Agent Forge sign-in" "${cmd}" /d /k ""${executable}"${args.length ? ` ${args.join(' ')}` : ''}"`;
    const env = buildTrustedEnvironment({ allowedEnvKeys: Object.keys(profileEnv), customEnv: profileEnv });
    const child = spawn(cmd, [command], { env, cwd, shell: false, detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
    child.on('error', () => undefined);
    child.unref();
  }
}

const DRIVERS: Record<string, CliDriver> = {
  'prov-claude-code-cli': {
    label: 'Claude Code', profileProvider: 'claude', profileEnv: (directory) => ({ CLAUDE_CONFIG_DIR: directory }), loginArgs: ['auth', 'login'],
    // `claude auth status` prints JSON and exits 0 when signed in, 1 when not.
    async verify(check) {
      const result = await check(['auth', 'status'], 30_000);
      if (result.exitCode === 1) return 'NOT_SIGNED_IN';
      if (result.exitCode !== 0) return 'VERIFY_FAILED';
      try {
        const method = (JSON.parse(result.stdout) as { authMethod?: unknown }).authMethod;
        if (method === 'none') return 'NOT_SIGNED_IN';
        return method === 'claude.ai' || method === 'oauth_token' ? 'VERIFIED' : 'NOT_A_SUBSCRIPTION_LOGIN';
      } catch {
        return 'VERIFY_FAILED';
      }
    },
  },
  'prov-gemini-cli': {
    label: 'Gemini', profileProvider: 'gemini', profileEnv: (directory) => ({ GEMINI_CLI_HOME: directory }), loginArgs: [],
    // Headless Gemini exits 41 without a cached login; a minimal read-only prompt proves the login works.
    async verify(check, profileDirectory) {
      if (!fs.existsSync(path.join(profileDirectory, '.gemini', 'oauth_creds.json'))) return 'NOT_SIGNED_IN'; // Presence only; never read.
      const result = await check(['-p', 'Reply with the single word OK.', '-o', 'json', '--approval-mode', 'plan'], 90_000);
      if (result.exitCode === 0) return 'VERIFIED';
      return result.exitCode === 41 ? 'NOT_SIGNED_IN' : 'VERIFY_FAILED';
    },
  },
  'prov-antigravity-cli': {
    // The Google sign-in is machine-wide (OS credential store); the terminal opens agy itself to sign in.
    label: 'Antigravity', profileProvider: 'antigravity', profileEnv: (directory) => ({ USERPROFILE: directory, HOME: directory }), loginArgs: [],
    // A minimal read-only prompt proves the sign-in. A quota error still proves it: the provider accepted the account.
    async verify(check) {
      const result = await check(['--output-format', 'json', '--mode', 'plan', '--disable-slash-commands', '-p', 'Reply with the single word OK.'], 90_000);
      if (result.exitCode === 0) return 'VERIFIED';
      const failure = classifyAntigravityFailure(result.stdout, result.stderr ?? '');
      if (failure?.errorCode === 'QUOTA_EXHAUSTED') return 'VERIFIED';
      return failure?.errorCode === 'AUTH_ERROR' ? 'NOT_SIGNED_IN' : 'VERIFY_FAILED';
    },
  },
};

export interface CliAccountConnectionOptions {
  runner?: CliRunner;
  /** The executable the provider's adapter runs, so the check proves exactly that binary. */
  executableFor: (providerId: string) => string | null;
  profileResolver?: Pick<NativeProfileResolver, 'resolve'>;
  onVerified?: (accountId: string) => void | Promise<void>;
  /** Per-account Antigravity sign-ins (#304): agy itself keeps only one machine-wide sign-in. */
  antigravitySlots?: AntigravityCredentialSlots | null;
}

/**
 * In-app sign-in for Claude Code and Gemini CLI accounts (#242). The owner
 * signs in through the CLI's own browser flow in a terminal opened with the
 * account's isolated profile (`CLAUDE_CONFIG_DIR` / `GEMINI_CLI_HOME`); only
 * the CLI handles credentials. Verification runs the CLI's own check with the
 * adapter's executable from an empty private directory and, when it proves a
 * signed-in profile, initializes the never-used account through the single
 * health writer.
 */
export class CliAccountConnectionService {
  private readonly runner: CliRunner;
  private readonly executableFor: (providerId: string) => string | null;
  private readonly profileResolver: Pick<NativeProfileResolver, 'resolve'>;
  private readonly antigravitySlots: AntigravityCredentialSlots | null;
  private readonly onVerified: CliAccountConnectionOptions['onVerified'];

  constructor(private readonly repo: Repository, options: CliAccountConnectionOptions) {
    this.runner = options.runner ?? new NodeCliRunner();
    this.executableFor = options.executableFor;
    this.profileResolver = options.profileResolver ?? new NativeProfileResolver();
    this.antigravitySlots = options.antigravitySlots ?? null;
    this.onVerified = options.onVerified;
  }

  private prepare(accountId: string):
    { ok: true; driver: CliDriver; executable: string; profileEnv: Record<string, string>; profileDirectory: string; profileRef: string; providerId: string } |
    { ok: false; errorCode: CliSignInErrorCode } {
    const account = this.repo.getProviderAccount(accountId);
    if (!account || !account.enabled) return { ok: false, errorCode: 'ACCOUNT_NOT_FOUND' };
    const driver = DRIVERS[account.provider_id];
    if (!driver || account.auth_mode !== 'NATIVE_PROFILE' || !account.profile_ref) return { ok: false, errorCode: 'NOT_A_SUPPORTED_CLI_ACCOUNT' };
    let profileDirectory: string;
    try {
      const profile = this.profileResolver.resolve(account.profile_ref);
      profileDirectory = profile.profileDirectory;
      if (profile.provider !== driver.profileProvider || !path.isAbsolute(profileDirectory) || /[\u0000-\u001f\u007f]/.test(profileDirectory)) {
        return { ok: false, errorCode: 'PROFILE_UNAVAILABLE' };
      }
      fs.mkdirSync(profileDirectory, { recursive: true }); // Never inspects profile contents.
    } catch {
      return { ok: false, errorCode: 'PROFILE_UNAVAILABLE' };
    }
    const executable = this.executableFor(account.provider_id);
    if (!executable || !path.isAbsolute(executable) || !fs.existsSync(executable)) return { ok: false, errorCode: 'CLI_UNAVAILABLE' };
    return { ok: true, driver, executable, profileEnv: driver.profileEnv(profileDirectory), profileDirectory, profileRef: account.profile_ref, providerId: account.provider_id };
  }

  /** Opens the CLI's sign-in in a terminal bound to this account's profile. */
  public async startSignIn(accountId: string): Promise<{ success: true; cli: string } | { success: false; errorCode: CliSignInErrorCode }> {
    const prepared = this.prepare(accountId);
    if (!prepared.ok) return { success: false, errorCode: prepared.errorCode };
    try {
      // The machine-wide sign-in is set aside, so agy asks for this account's own sign-in (#304).
      if (prepared.providerId === 'prov-antigravity-cli' && this.antigravitySlots) await this.antigravitySlots.prepareSignIn(accountId);
      this.runner.openTerminal(prepared.executable, prepared.driver.loginArgs, prepared.profileEnv, prepared.profileDirectory);
    } catch (error) {
      return { success: false, errorCode: error instanceof Error && error.message === 'UNSUPPORTED_PLATFORM' ? 'UNSUPPORTED_PLATFORM' : 'CLI_UNAVAILABLE' };
    }
    return { success: true, cli: prepared.driver.label };
  }

  /** Runs the CLI's own sign-in check for the account's profile; nothing is inferred. */
  public async verify(accountId: string): Promise<{ success: true; verified: boolean; reasonCode: CliVerifyReason } | { success: false; errorCode: CliSignInErrorCode }> {
    const prepared = this.prepare(accountId);
    if (!prepared.ok) return { success: false, errorCode: prepared.errorCode };
    // An empty private directory, so no project files near the check are loaded.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-cli-check-'));
    let reason: CliVerifyReason;
    try {
      const check = () => prepared.driver.verify(
        (args, timeoutMs) => this.runner.run(prepared.executable, args, prepared.profileEnv, cwd, timeoutMs), prepared.profileDirectory);
      // Antigravity: the check runs on this account's own sign-in, and a fresh sign-in becomes its slot (#304).
      reason = prepared.providerId === 'prov-antigravity-cli' && this.antigravitySlots
        ? await this.antigravitySlots.checkSignIn(accountId, check, (result) => result === 'VERIFIED')
        : await check();
    } catch {
      reason = 'VERIFY_FAILED';
    } finally {
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    if (reason !== 'VERIFIED') return { success: true, verified: false, reasonCode: reason };
    const health = this.repo.getProviderAccount(accountId)?.health_status;
    if (health === 'UNKNOWN') {
      const initialized = AccountHealthService.create(this.repo)
        .initializeVerifiedAccount(accountId, { providerId: prepared.providerId, profileRef: prepared.profileRef });
      // A routed or leased UNKNOWN account is never flipped by a sign-in check;
      // a concurrent check that already initialized it still counts as verified.
      if (!initialized && this.repo.getProviderAccount(accountId)?.health_status !== 'AVAILABLE') {
        return { success: true, verified: false, reasonCode: 'ALREADY_IN_USE' };
      }
    } else if (health === 'AUTH_ERROR') {
      // An expired login that the CLI now proves signed in again (#247).
      const recovered = AccountHealthService.create(this.repo)
        .recordReauthenticated(accountId, { providerId: prepared.providerId, profileRef: prepared.profileRef });
      if (!recovered) return { success: true, verified: false, reasonCode: 'ALREADY_IN_USE' };
    } else if (health !== 'AVAILABLE' && health !== 'LOW_QUOTA') {
      // Other recorded failures (cooldown, quota, rate limit) are not cleared by a sign-in check.
      return { success: true, verified: false, reasonCode: 'ALREADY_IN_USE' };
    }
    await this.onVerified?.(accountId);
    return { success: true, verified: true, reasonCode: 'VERIFIED' };
  }
}
