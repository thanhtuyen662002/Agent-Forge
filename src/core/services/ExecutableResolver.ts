import fs from 'fs';
import path from 'path';

/** Executables which cross a repository, recovery, or process-control boundary. */
export type TrustedExecutableKind = 'git' | 'taskkill' | 'cmd' | 'node' | 'npm' | 'codex' | 'agy' | 'gh' | 'generic';

export interface ExecutableResolverOptions {
  /** Override the host platform in deterministic resolver tests. */
  platform?: NodeJS.Platform;
  /** Environment used only for installation roots and PATH discovery. */
  env?: NodeJS.ProcessEnv;
  /** A test seam for paths which do not exist on the host running the test. */
  fileExists?: (candidate: string) => boolean;
  /** When supplied, this is used instead of stat(2) after fileExists succeeds. */
  fileIsRegularFile?: (candidate: string) => boolean;
  /** Allow an explicitly configured absolute path for a non-protected provider executable. */
  allowExplicitAbsolute?: boolean;
}

export interface TrustedEnvironmentOptions extends ExecutableResolverOptions {
  allowedEnvKeys?: readonly string[];
  /** Preserve a caller-authorized PATH override for legacy provider shims. */
  preserveAllowedPathOverride?: boolean;
}

const SAFE_INHERITED_ENV_KEYS = [
  'APPDATA',
  'HOME',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'NODE_ENV',
  // Installation roots are non-secret but required to resolve protected
  // binaries after the child environment has been minimized.
  'ProgramFiles',
  'PROGRAMFILES',
  'ProgramFiles(x86)',
  'PROGRAMFILES(X86)',
  'ProgramW6432',
  'PROGRAMW6432',
  'SYSTEMROOT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERPROFILE',
] as const;

const PATH_OVERRIDE_KEYS = new Set(['PATH', 'Path', 'PATHEXT', 'ComSpec', 'COMSPEC']);

function platformOf(options: ExecutableResolverOptions): NodeJS.Platform {
  return options.platform ?? process.platform;
}

function pathApi(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix;
}

function envOf(options: ExecutableResolverOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env;
}

function envValue(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  const direct = env[key];
  if (direct !== undefined) return direct;
  if (platform === 'win32') {
    const lower = key.toLowerCase();
    const matchingKey = Object.keys(env).find((candidate) => candidate.toLowerCase() === lower);
    if (matchingKey) return env[matchingKey];
    // Spreading process.env on Windows can lose case-insensitive aliases.
    // Preserve the host installation roots when a caller only overrides PATH.
    if (process.platform === 'win32') {
      const hostKey = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === lower);
      if (hostKey) return process.env[hostKey];
    }
  }
  return undefined;
}

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

function canonicalForComparison(candidate: string, platform: NodeJS.Platform): string {
  const api = pathApi(platform);
  const resolved = api.normalize(api.resolve(candidate));
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithinDirectory(candidate: string, root: string, platform: NodeJS.Platform): boolean {
  const api = pathApi(platform);
  const child = canonicalForComparison(candidate, platform);
  const parent = canonicalForComparison(root, platform);
  if (child === parent) return true;
  const relative = api.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !api.isAbsolute(relative);
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function basenameWithoutExtension(value: string, platform: NodeJS.Platform): string {
  const base = pathApi(platform).basename(value).toLowerCase();
  return base.replace(/\.(?:exe|com|cmd|bat)$/i, '');
}

function expectedBasenames(kind: TrustedExecutableKind, platform: NodeJS.Platform): string[] {
  const base = {
    git: ['git'],
    taskkill: ['taskkill'],
    cmd: ['cmd'],
    node: ['node'],
    npm: ['npm'],
    codex: ['codex'],
    agy: ['agy'],
    gh: ['gh'],
    generic: [],
  }[kind];
  if (platform !== 'win32') return base;
  return base;
}

function fileExistsDefault(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function trustedInstallationRoots(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, kind: TrustedExecutableKind): string[] {
  const api = pathApi(platform);
  const roots: string[] = [];
  const add = (value: string | undefined) => {
    if (!value || hasControlCharacters(value)) return;
    roots.push(api.normalize(value));
  };

  if (platform === 'win32') {
    const systemRoot = envValue(env, 'SystemRoot', platform) ?? envValue(env, 'SYSTEMROOT', platform) ?? 'C:\\Windows';
    const system32 = api.join(systemRoot, 'System32');
    if (kind === 'taskkill' || kind === 'cmd') add(system32);

    if (kind === 'git') {
      for (const programFiles of [envValue(env, 'ProgramFiles', platform), envValue(env, 'ProgramFiles(x86)', platform)]) {
        if (!programFiles) continue;
        add(api.join(programFiles, 'Git', 'cmd'));
        add(api.join(programFiles, 'Git', 'bin'));
      }
    }

    if (kind === 'codex') {
      const localAppData = envValue(env, 'LOCALAPPDATA', platform);
      const programFiles = envValue(env, 'ProgramFiles', platform);
      add(localAppData ? api.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin') : undefined);
      add(programFiles ? api.join(programFiles, 'OpenAI', 'Codex', 'bin') : undefined);
    }

    if (kind === 'node' || kind === 'npm' || kind === 'generic') {
      if (process.platform === 'win32') add(api.dirname(process.execPath));
      for (const programFiles of [envValue(env, 'ProgramFiles', platform), envValue(env, 'ProgramFiles(x86)', platform)]) {
        if (programFiles) add(api.join(programFiles, 'nodejs'));
      }
    }

    if (kind === 'gh') {
      for (const programFiles of [envValue(env, 'ProgramFiles', platform), envValue(env, 'ProgramFiles(x86)', platform)]) {
        if (programFiles) add(api.join(programFiles, 'GitHub CLI'));
      }
    }

    if (kind === 'agy' || kind === 'generic') {
      if (process.platform === 'win32') add(api.dirname(process.execPath));
    }
  } else {
    if (['git', 'node', 'npm', 'codex', 'agy', 'gh', 'generic'].includes(kind)) {
      add('/usr/bin');
      add('/bin');
      add('/usr/local/bin');
      add('/opt/homebrew/bin');
      if (process.platform !== 'win32') add(path.dirname(process.execPath));
    }
  }

  // Preserve the installation path spelling for process launches; comparison
  // helpers below perform case folding independently on Windows.
  return [...new Set(roots.map((root) => api.normalize(root)))];
}

function trustedPathEntries(options: ExecutableResolverOptions, kind: TrustedExecutableKind): string[] {
  const platform = platformOf(options);
  const env = envOf(options);
  const api = pathApi(platform);
  const roots = trustedInstallationRoots(platform, env, kind);
  const rawPath = platform === 'win32' ? (envValue(env, 'Path', platform) ?? envValue(env, 'PATH', platform) ?? '') : (envValue(env, 'PATH', platform) ?? '');
  const entries = rawPath.split(pathDelimiter(platform)).map((entry) => entry.trim()).filter(Boolean);
  return [...new Set(entries
    .map((entry) => api.normalize(entry))
    .filter((entry) => roots.some((root) => isWithinDirectory(entry, root, platform))))];
}

function candidateNames(requested: string, kind: TrustedExecutableKind, platform: NodeJS.Platform): string[] {
  const api = pathApi(platform);
  const hasExtension = Boolean(api.extname(requested));
  if (hasExtension) return [requested];
  if (platform === 'win32' && kind !== 'generic') return [`${requested}.exe`, `${requested}.com`, `${requested}.cmd`, `${requested}.bat`, requested];
  return [requested];
}

/**
 * Resolve a child-process executable without trusting an attacker-controlled
 * PATH. Protected names are searched only in OS/package-manager locations;
 * arbitrary provider binaries must be explicitly absolute unless they happen
 * to live in one of those trusted locations.
 */
export function resolveTrustedExecutable(requested: string, kind: TrustedExecutableKind = 'generic', options: ExecutableResolverOptions = {}): string | null {
  if (typeof requested !== 'string' || requested.trim() !== requested || requested.length === 0 || hasControlCharacters(requested)) return null;
  const platform = platformOf(options);
  const api = pathApi(platform);
  const env = envOf(options);
  const requestedBase = basenameWithoutExtension(requested, platform);
  const expected = expectedBasenames(kind, platform);
  if (expected.length > 0 && !expected.includes(requestedBase)) return null;

  const exists = options.fileExists ?? fileExistsDefault;
  const isRegular = options.fileIsRegularFile ?? exists;
  const explicitAbsolute = api.isAbsolute(requested);
  if (explicitAbsolute) {
    if (kind !== 'generic' && !expected.includes(requestedBase)) return null;
    if (kind !== 'generic' && !trustedInstallationRoots(platform, env, kind).some((root) => isWithinDirectory(requested, root, platform))) {
      return null;
    }
    if (!isRegular(requested)) return null;
    return api.normalize(requested);
  }

  const dirs = [...trustedInstallationRoots(platform, env, kind), ...trustedPathEntries(options, kind)];
  const names = candidateNames(requested, kind, platform);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = api.isAbsolute(name) ? name : api.join(dir, name);
      if (isRegular(candidate)) return api.normalize(candidate);
    }
  }

  if (kind === 'generic' && options.allowExplicitAbsolute && explicitAbsolute && isRegular(requested)) return api.normalize(requested);
  return null;
}

/**
 * Build a small inherited environment and a filtered, trusted PATH. Caller
 * overrides are copied only when explicitly allowlisted; PATH/control-shell
 * variables are never copied unless preserveAllowedPathOverride is requested
 * for a legacy provider shim.
 */
export function buildTrustedEnvironment(options: TrustedEnvironmentOptions = {}): NodeJS.ProcessEnv {
  const platform = platformOf(options);
  const source = envOf(options);
  const result: NodeJS.ProcessEnv = {};
  for (const key of SAFE_INHERITED_ENV_KEYS) {
    const value = envValue(source, key, platform);
    if (value !== undefined) result[key] = value;
  }

  const trustedDirs = [
    ...new Set([
      ...trustedInstallationRoots(platform, source, 'generic'),
      ...trustedInstallationRoots(platform, source, 'git'),
      ...trustedInstallationRoots(platform, source, 'node'),
      ...trustedInstallationRoots(platform, source, 'cmd'),
      ...trustedInstallationRoots(platform, source, 'gh'),
      ...trustedPathEntries(options, 'generic'),
    ]),
  ];
  const trustedPath = trustedDirs.join(pathDelimiter(platform));
  if (trustedPath) {
    result.PATH = trustedPath;
    if (platform === 'win32') result.Path = trustedPath;
  }
  if (platform === 'win32') {
    result.PATHEXT = envValue(source, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD';
    const cmd = resolveTrustedExecutable('cmd', 'cmd', options);
    if (cmd) {
      result.COMSPEC = cmd;
      result.ComSpec = cmd;
    }
  }

  const allowed = new Set(options.allowedEnvKeys ?? []);
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (!allowed.has(key) || value === undefined) continue;
    if (PATH_OVERRIDE_KEYS.has(key) && !options.preserveAllowedPathOverride) continue;
    if (hasControlCharacters(key) || hasControlCharacters(value)) continue;
    result[key] = value;
  }
  return result;
}

export function isProtectedExecutableName(requested: string): TrustedExecutableKind | null {
  if (typeof requested !== 'string') return null;
  const normalized = requested.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.(?:exe|com|cmd|bat)$/i, '');
  const match: TrustedExecutableKind[] = ['git', 'taskkill', 'cmd', 'node', 'npm', 'codex', 'agy', 'gh'];
  return match.includes(normalized as TrustedExecutableKind) ? normalized as TrustedExecutableKind : null;
}
