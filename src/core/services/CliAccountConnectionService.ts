import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NativeProfileResolver } from '../credentials/NativeProfileResolver';
import type { Repository } from '../database/repositories';
import { AccountHealthService } from './AccountHealthService';
import { buildTrustedEnvironment, resolveTrustedExecutable } from './ExecutableResolver';

export type CliSignInErrorCode =
  | 'ACCOUNT_NOT_FOUND' | 'NOT_A_SUPPORTED_CLI_ACCOUNT' | 'PROFILE_UNAVAILABLE' | 'CLI_UNAVAILABLE' | 'UNSUPPORTED_PLATFORM';

export type CliVerifyReason = 'VERIFIED' | 'NOT_SIGNED_IN' | 'NOT_A_SUBSCRIPTION_LOGIN' | 'VERIFY_FAILED' | 'ALREADY_IN_USE';

interface CliDriver {
  label: string;
  profileProvider: 'claude' | 'gemini';
  envKey: 'CLAUDE_CONFIG_DIR' | 'GEMINI_CLI_HOME';
  executableName: string;
  loginArgs: string[];
  verify: (run: CliRunner, executable: string, env: NodeJS.ProcessEnv, profileDirectory: string) => Promise<CliVerifyReason>;
}

export interface CliRunResult { exitCode: number | null; stdout: string }
export interface CliRunner {
  /** Runs a short, non-interactive check and captures bounded stdout. */
  run(executable: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<CliRunResult>;
  /** Opens a visible terminal where the owner completes the CLI's own browser sign-in. */
  openTerminal(executable: string, args: string[], env: NodeJS.ProcessEnv): void;
}

const MAX_OUTPUT_BYTES = 256 * 1024;
/** A path that can be placed inside a cmd.exe command line without any interpretation. */
const SAFE_WINDOWS_PATH = /^[A-Za-z]:\\[^"&|<>^%!\r\n]*$/;

export class NodeCliRunner implements CliRunner {
  public run(executable: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<CliRunResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let bytes = 0;
      let settled = false;
      const done = (result: CliRunResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(executable, args, { env, cwd: os.tmpdir(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        resolve({ exitCode: null, stdout: '' });
        return;
      }
      const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } done({ exitCode: null, stdout }); }, timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes <= MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8');
      });
      child.on('error', () => done({ exitCode: null, stdout }));
      child.on('close', (code) => done({ exitCode: code, stdout }));
    });
  }

  public openTerminal(executable: string, args: string[], env: NodeJS.ProcessEnv): void {
    if (process.platform !== 'win32') throw new Error('UNSUPPORTED_PLATFORM');
    if (!SAFE_WINDOWS_PATH.test(executable) || args.some((arg) => !/^[a-z-]+$/i.test(arg))) throw new Error('UNSAFE_COMMAND');
    // cmd.exe /d /c start "<title>" cmd.exe /k ""<exe>" <args>": every part is validated above.
    const command = `/d /c start "Agent Forge sign-in" cmd.exe /k ""${executable}"${args.length ? ` ${args.join(' ')}` : ''}"`;
    const child = spawn('cmd.exe', [command], { env, cwd: os.tmpdir(), shell: false, detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
    child.on('error', () => undefined);
    child.unref();
  }
}

const DRIVERS: Record<string, CliDriver> = {
  'prov-claude-code-cli': {
    label: 'Claude Code', profileProvider: 'claude', envKey: 'CLAUDE_CONFIG_DIR', executableName: 'claude', loginArgs: ['auth', 'login'],
    // `claude auth status` prints JSON and exits 0 when signed in, 1 when not.
    async verify(run, executable, env) {
      const result = await run.run(executable, ['auth', 'status'], env, 30_000);
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
    label: 'Gemini', profileProvider: 'gemini', envKey: 'GEMINI_CLI_HOME', executableName: 'gemini', loginArgs: [],
    // Headless Gemini exits 41 without a cached login; a minimal read-only prompt proves the login works.
    async verify(run, executable, env, profileDirectory) {
      if (!fs.existsSync(path.join(profileDirectory, '.gemini', 'oauth_creds.json'))) return 'NOT_SIGNED_IN'; // Presence only; never read.
      const result = await run.run(executable, ['-p', 'Reply with the single word OK.', '-o', 'json', '--approval-mode', 'plan'], env, 90_000);
      if (result.exitCode === 0) return 'VERIFIED';
      return result.exitCode === 41 ? 'NOT_SIGNED_IN' : 'VERIFY_FAILED';
    },
  },
};

export interface CliAccountConnectionOptions {
  runner?: CliRunner;
  resolveExecutable?: (name: string) => string | null;
  profileResolver?: Pick<NativeProfileResolver, 'resolve'>;
  onVerified?: (accountId: string) => void | Promise<void>;
}

/**
 * In-app sign-in for Claude Code and Gemini CLI accounts (#242). The owner
 * signs in through the CLI's own browser flow in a terminal opened with the
 * account's isolated profile (`CLAUDE_CONFIG_DIR` / `GEMINI_CLI_HOME`); only
 * the CLI handles credentials. Verification runs the CLI's own check and, when
 * it proves a signed-in profile, initializes the never-used account through
 * the single health writer.
 */
export class CliAccountConnectionService {
  private readonly runner: CliRunner;
  private readonly resolveExecutable: (name: string) => string | null;
  private readonly profileResolver: Pick<NativeProfileResolver, 'resolve'>;
  private readonly onVerified: CliAccountConnectionOptions['onVerified'];

  constructor(private readonly repo: Repository, options: CliAccountConnectionOptions = {}) {
    this.runner = options.runner ?? new NodeCliRunner();
    this.resolveExecutable = options.resolveExecutable ?? ((name) => resolveTrustedExecutable(name, 'generic'));
    this.profileResolver = options.profileResolver ?? new NativeProfileResolver();
    this.onVerified = options.onVerified;
  }

  private prepare(accountId: string):
    { ok: true; driver: CliDriver; executable: string; env: NodeJS.ProcessEnv; profileDirectory: string; profileRef: string; providerId: string } |
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
    const executable = this.resolveExecutable(driver.executableName);
    if (!executable || (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable))) return { ok: false, errorCode: 'CLI_UNAVAILABLE' };
    const env = buildTrustedEnvironment({ allowedEnvKeys: [driver.envKey], customEnv: { [driver.envKey]: profileDirectory } });
    return { ok: true, driver, executable, env, profileDirectory, profileRef: account.profile_ref, providerId: account.provider_id };
  }

  /** Opens the CLI's sign-in in a terminal bound to this account's profile. */
  public startSignIn(accountId: string): { success: true; cli: string } | { success: false; errorCode: CliSignInErrorCode } {
    const prepared = this.prepare(accountId);
    if (!prepared.ok) return { success: false, errorCode: prepared.errorCode };
    try {
      this.runner.openTerminal(prepared.executable, prepared.driver.loginArgs, prepared.env);
    } catch (error) {
      return { success: false, errorCode: error instanceof Error && error.message === 'UNSUPPORTED_PLATFORM' ? 'UNSUPPORTED_PLATFORM' : 'CLI_UNAVAILABLE' };
    }
    return { success: true, cli: prepared.driver.label };
  }

  /** Runs the CLI's own sign-in check for the account's profile; nothing is inferred. */
  public async verify(accountId: string): Promise<{ success: true; verified: boolean; reasonCode: CliVerifyReason } | { success: false; errorCode: CliSignInErrorCode }> {
    const prepared = this.prepare(accountId);
    if (!prepared.ok) return { success: false, errorCode: prepared.errorCode };
    let reason: CliVerifyReason;
    try {
      reason = await prepared.driver.verify(this.runner, prepared.executable, prepared.env, prepared.profileDirectory);
    } catch {
      reason = 'VERIFY_FAILED';
    }
    if (reason !== 'VERIFIED') return { success: true, verified: false, reasonCode: reason };
    const account = this.repo.getProviderAccount(accountId);
    if (account?.health_status === 'UNKNOWN') {
      const initialized = AccountHealthService.create(this.repo)
        .initializeVerifiedAccount(accountId, { providerId: prepared.providerId, profileRef: prepared.profileRef });
      // A routed or leased UNKNOWN account is never flipped by a sign-in check.
      if (!initialized) return { success: true, verified: true, reasonCode: 'ALREADY_IN_USE' };
    }
    await this.onVerified?.(accountId);
    return { success: true, verified: true, reasonCode: 'VERIFIED' };
  }
}
