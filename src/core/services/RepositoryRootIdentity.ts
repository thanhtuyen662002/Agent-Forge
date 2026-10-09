import fs from 'node:fs';
import path from 'node:path';

export type RepositoryRootErrorCode =
  | 'REPOSITORY_ROOT_INVALID_PATH'
  | 'REPOSITORY_ROOT_MISSING'
  | 'REPOSITORY_ROOT_NOT_DIRECTORY'
  | 'REPOSITORY_ROOT_ALIAS'
  | 'REPOSITORY_ROOT_IDENTITY_UNAVAILABLE'
  | 'REPOSITORY_ROOT_IDENTITY_CHANGED'
  | 'REPOSITORY_ROOT_UNBOUND'
  | 'REPOSITORY_ROOT_BINDING_BLOCKED';

const reasons: Record<RepositoryRootErrorCode, string> = {
  REPOSITORY_ROOT_INVALID_PATH: 'Select an absolute local repository directory without portable or device aliases.',
  REPOSITORY_ROOT_MISSING: 'The repository directory is missing. Select an existing repository directory.',
  REPOSITORY_ROOT_NOT_DIRECTORY: 'The repository root and every parent must be ordinary directories.',
  REPOSITORY_ROOT_ALIAS: 'Select the real repository directory; symlink, junction and path aliases are not allowed.',
  REPOSITORY_ROOT_IDENTITY_UNAVAILABLE: 'The repository directory identity could not be verified safely.',
  REPOSITORY_ROOT_IDENTITY_CHANGED: 'The selected repository or a parent changed. Select the repository again.',
  REPOSITORY_ROOT_UNBOUND: 'This project has no verified repository selection. Select its repository before repository operations.',
  REPOSITORY_ROOT_BINDING_BLOCKED: 'Initial repository confirmation requires an inactive project without execution history. Create a new project for a new repository identity.',
};

export class RepositoryRootError extends Error {
  constructor(public readonly code: RepositoryRootErrorCode) {
    super(`${code}: ${reasons[code]}`);
    this.name = 'RepositoryRootError';
  }
}

interface DirectoryComponent {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly createdNs: string;
}

/** Serializable observation; it does not claim to be a kernel mutation lease. */
export interface RepositoryRootIdentity {
  readonly version: 1;
  readonly platform: NodeJS.Platform;
  readonly canonicalPath: string;
  readonly components: readonly DirectoryComponent[];
}

function localPath(rawPath: string): string {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.length > 32_767 || /[\x00-\x1f\x7f]/.test(rawPath) ||
      /^[/\\]{2}/.test(rawPath) || !path.isAbsolute(rawPath) ||
      (process.platform === 'win32' ? !/^[a-z]:[/\\]/i.test(rawPath) : rawPath.includes('\\'))) {
    throw new RepositoryRootError('REPOSITORY_ROOT_INVALID_PATH');
  }
  const normalized = path.normalize(rawPath);
  const segments = normalized.slice(path.parse(normalized).root.length).split(path.sep).filter(Boolean);
  if (segments.length > 128 || (process.platform === 'win32' && segments.some(segment =>
    /[:*?"<>|]/.test(segment) || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(segment)))) {
    throw new RepositoryRootError('REPOSITORY_ROOT_INVALID_PATH');
  }
  return normalized;
}

function observe(candidate: string): DirectoryComponent {
  let stat: fs.BigIntStats;
  try { stat = fs.lstatSync(candidate, { bigint: true }); }
  catch (error) {
    throw new RepositoryRootError((error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'REPOSITORY_ROOT_MISSING' : 'REPOSITORY_ROOT_IDENTITY_UNAVAILABLE');
  }
  if (stat.isSymbolicLink()) throw new RepositoryRootError('REPOSITORY_ROOT_ALIAS');
  if (!stat.isDirectory()) throw new RepositoryRootError('REPOSITORY_ROOT_NOT_DIRECTORY');
  if (stat.ino === 0n || stat.birthtimeNs <= 0n) throw new RepositoryRootError('REPOSITORY_ROOT_IDENTITY_UNAVAILABLE');
  return Object.freeze({ path: candidate, device: stat.dev.toString(), inode: stat.ino.toString(), createdNs: stat.birthtimeNs.toString() });
}

function components(candidate: string): readonly DirectoryComponent[] {
  let current = path.parse(candidate).root;
  const result = [observe(current)];
  for (const part of candidate.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    result.push(observe(current));
  }
  return Object.freeze(result);
}

function same(left: readonly DirectoryComponent[], right: readonly DirectoryComponent[]): boolean {
  return left.length === right.length && left.every((item, i) => item.path === right[i].path &&
    item.device === right[i].device && item.inode === right[i].inode && item.createdNs === right[i].createdNs);
}

export function captureRepositoryRoot(rawPath: string): RepositoryRootIdentity {
  const normalized = localPath(rawPath);
  const initial = components(normalized);
  let canonicalPath: string;
  try { canonicalPath = fs.realpathSync.native(normalized); }
  catch { throw new RepositoryRootError('REPOSITORY_ROOT_IDENTITY_UNAVAILABLE'); }
  const comparable = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (comparable(canonicalPath) !== comparable(normalized)) throw new RepositoryRootError('REPOSITORY_ROOT_ALIAS');
  if (!same(initial, components(normalized))) throw new RepositoryRootError('REPOSITORY_ROOT_IDENTITY_CHANGED');
  const canonicalComponents = components(canonicalPath);
  if (initial.length !== canonicalComponents.length || initial.some((item, i) => item.device !== canonicalComponents[i].device ||
      item.inode !== canonicalComponents[i].inode || item.createdNs !== canonicalComponents[i].createdNs)) {
    throw new RepositoryRootError('REPOSITORY_ROOT_IDENTITY_CHANGED');
  }
  return Object.freeze({ version: 1, platform: process.platform, canonicalPath, components: canonicalComponents });
}

export function assertRepositoryRootIdentity(identity: RepositoryRootIdentity): void {
  if (!identity || identity.version !== 1 || identity.platform !== process.platform ||
      typeof identity.canonicalPath !== 'string' || !Array.isArray(identity.components) ||
      identity.components.length === 0 || identity.components.length > 129 || identity.components.some(component =>
        !component || typeof component.path !== 'string' || component.path.length > 32_767 ||
        [component.device, component.inode, component.createdNs].some(value => typeof value !== 'string' || !/^[0-9]{1,30}$/.test(value)))) {
    throw new RepositoryRootError('REPOSITORY_ROOT_IDENTITY_UNAVAILABLE');
  }
  let current: RepositoryRootIdentity;
  try { current = captureRepositoryRoot(identity.canonicalPath); }
  catch { throw new RepositoryRootError('REPOSITORY_ROOT_IDENTITY_CHANGED'); }
  if (identity.canonicalPath !== current.canonicalPath || !same(identity.components, current.components)) {
    throw new RepositoryRootError('REPOSITORY_ROOT_IDENTITY_CHANGED');
  }
}
