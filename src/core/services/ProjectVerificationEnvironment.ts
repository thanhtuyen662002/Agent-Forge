import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ProcessRunner } from './ProcessRunner';
import { redactSensitiveText } from '../../shared/security/secretRedaction';

/**
 * Project verification environment (#336). Found preparing VidFlow M2–M9: project tests
 * could not import any npm dependency (Playwright, Electron, React), because managed
 * worktrees never had node_modules, and could not find tools such as ffmpeg, because the
 * verification PATH holds only System32 (they would have skipped and "passed").
 *
 * - Owner-set variables (for example VIDFLOW_FFMPEG or PLAYWRIGHT_BROWSERS_PATH) are
 *   added to the verification environment. Names that steer the process, the profile
 *   or credentials are refused; values must be plain and secret-free.
 * - When the owner opts in, `npm ci` installs the project's locked dependencies once per
 *   package-lock.json into `<managed root>/node_modules`. Every worktree of the project
 *   sits directly below that folder, so Node resolves its imports there; nothing is
 *   written into a worktree, and its snapshot stays exactly the coder's work.
 */

const NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const RESERVED_NAMES = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'LANG', 'LC_ALL', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'ELECTRON_RUN_AS_NODE',
]);
const CREDENTIAL_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|COOKIE|AUTH|CREDENTIAL|SESSION)/;
export const MAX_VERIFICATION_ENV_ENTRIES = 16;
const MAX_VALUE_LENGTH = 1024;
/** One install of a large dependency tree (Electron, Playwright) on a cold cache. */
export const DEPENDENCY_INSTALL_TIMEOUT_MS = 20 * 60_000;
const LOCK_MARKER = '.agent-forge-lock-sha256';

export class VerificationEnvironmentError extends Error {
  constructor(public readonly code: 'VERIFICATION_ENV_INVALID', public readonly name_: string) {
    super(`${code}: ${name_}`);
  }
}

/** Validates owner-set verification variables; returns a clean copy or throws VERIFICATION_ENV_INVALID. */
export function validateVerificationEnv(env: unknown): Record<string, string> {
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new VerificationEnvironmentError('VERIFICATION_ENV_INVALID', '(object)');
  const entries = Object.entries(env as Record<string, unknown>);
  if (entries.length > MAX_VERIFICATION_ENV_ENTRIES) throw new VerificationEnvironmentError('VERIFICATION_ENV_INVALID', '(too many)');
  const clean: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!NAME_PATTERN.test(name) || RESERVED_NAMES.has(name) || name.startsWith('NPM_CONFIG_') || CREDENTIAL_NAME.test(name)) {
      throw new VerificationEnvironmentError('VERIFICATION_ENV_INVALID', name);
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_VALUE_LENGTH || /[\0\r\n]/.test(value) ||
        redactSensitiveText(value) !== value) {
      throw new VerificationEnvironmentError('VERIFICATION_ENV_INVALID', name);
    }
    clean[name] = value;
  }
  return clean;
}

/** The install command is npm ci unless a test supplies a stand-in. */
export interface InstallOptions { timeoutMs?: number; executable?: string; args?: string[] }

export type DependencyInstallResult =
  | { status: 'NO_LOCKFILE' | 'CURRENT' | 'INSTALLED'; lockSha256?: string }
  | { status: 'FAILED'; reasonCode: string; lockSha256?: string };

/**
 * Makes `<managedRoot>/node_modules` match the worktree's package-lock.json, running
 * `npm ci` in a private staging folder and moving the result into place only on success.
 */
export async function ensureProjectDependencies(worktree: string, env: Record<string, string>,
  options: InstallOptions = {}): Promise<DependencyInstallResult> {
  // Parallel verifications of one project share the folder: one install at a time.
  const managedRoot = path.dirname(worktree);
  const previous = installsInFlight.get(managedRoot) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => installOnce(worktree, env, options));
  installsInFlight.set(managedRoot, run);
  try {
    return await run;
  } finally {
    if (installsInFlight.get(managedRoot) === run) installsInFlight.delete(managedRoot);
  }
}

const installsInFlight = new Map<string, Promise<DependencyInstallResult>>();

/**
 * Windows briefly locks a freshly written tree (antivirus, indexer): moving or removing it
 * then fails with EBUSY or EPERM (Phiếu Lương, #370). Such a step is retried for a few
 * seconds before it fails.
 */
async function withBusyRetry<T>(step: () => T, attempts = 8, delayMs = 500): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return step();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (attempt >= attempts || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY')) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function installOnce(worktree: string, env: Record<string, string>,
  options: InstallOptions): Promise<DependencyInstallResult> {
  const lockPath = path.join(worktree, 'package-lock.json');
  const manifestPath = path.join(worktree, 'package.json');
  if (!fs.statSync(lockPath, { throwIfNoEntry: false })?.isFile() || !fs.statSync(manifestPath, { throwIfNoEntry: false })?.isFile()) {
    return { status: 'NO_LOCKFILE' };
  }
  const lock = fs.readFileSync(lockPath);
  const lockSha256 = crypto.createHash('sha256').update(lock).update(fs.readFileSync(manifestPath)).digest('hex');
  const managedRoot = path.dirname(worktree);
  const target = path.join(managedRoot, 'node_modules');
  const marker = path.join(target, LOCK_MARKER);
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === lockSha256) return { status: 'CURRENT', lockSha256 };

  const staging = path.join(managedRoot, `.agent-forge-deps-${lockSha256.slice(0, 16)}`);
  await withBusyRetry(() => fs.rmSync(staging, { recursive: true, force: true }));
  fs.mkdirSync(staging, { recursive: true });
  fs.copyFileSync(manifestPath, path.join(staging, 'package.json'));
  fs.copyFileSync(lockPath, path.join(staging, 'package-lock.json'));
  const result = await ProcessRunner.execute({
    executable: options.executable ?? 'npm',
    args: options.args ?? ['ci', '--no-audit', '--no-fund'],
    cwd: staging,
    timeoutMs: options.timeoutMs ?? DEPENDENCY_INSTALL_TIMEOUT_MS,
    env: { ...env, npm_config_cache: path.join(managedRoot, '.agent-forge-npm-cache') },
    allowedEnvKeys: [...Object.keys(env), 'npm_config_cache'],
  });
  const installed = path.join(staging, 'node_modules');
  // A project without dependencies installs nothing; an empty tree is still current.
  if (result.exitCode === 0 && !fs.existsSync(installed)) fs.mkdirSync(installed);
  if (result.exitCode !== 0) {
    await withBusyRetry(() => fs.rmSync(staging, { recursive: true, force: true }));
    return { status: 'FAILED', reasonCode: result.timedOut ? 'DEPENDENCY_INSTALL_TIMEOUT' : 'DEPENDENCY_INSTALL_FAILED', lockSha256 };
  }
  // A previous tree is replaced only after the new one installed completely. A move that
  // still fails after the retries is a failed install (retried later), never a thrown error.
  try {
    await withBusyRetry(() => fs.rmSync(target, { recursive: true, force: true }));
    await withBusyRetry(() => fs.renameSync(installed, target));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* Cleaned on the next install. */ }
    return { status: 'FAILED', reasonCode: `DEPENDENCY_INSTALL_${typeof code === 'string' && /^[A-Z]+$/.test(code) ? code : 'MOVE_FAILED'}`, lockSha256 };
  }
  fs.writeFileSync(marker, lockSha256, 'utf8');
  await withBusyRetry(() => fs.rmSync(staging, { recursive: true, force: true })).catch(() => undefined);
  return { status: 'INSTALLED', lockSha256 };
}
