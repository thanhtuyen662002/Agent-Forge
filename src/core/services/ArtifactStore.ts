import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Evidence, EvidenceType, EvidenceStorageType } from '../types/domain';
import {
  ArtifactManifest,
  ArtifactManifestEntry,
  ARTIFACT_MANIFEST_ENTRY_KEYS,
  ARTIFACT_MANIFEST_KEYS,
} from '../types/adjudication';

export type ArtifactIntegrityErrorCode =
  | 'ARTIFACT_ROOT_INVALID'
  | 'ARTIFACT_ROOT_CHANGED'
  | 'ARTIFACT_PARENT_MISSING'
  | 'ARTIFACT_PARENT_CHANGED'
  | 'ARTIFACT_REPARSE_POINT'
  | 'ARTIFACT_PATH_UNVERIFIED'
  | 'ARTIFACT_NOFOLLOW_UNAVAILABLE'
  | 'ARTIFACT_ATOMIC_PUBLISH_UNAVAILABLE'
  | 'ARTIFACT_BASE_DIRECTORY_REQUIRED';

/**
 * Raised when the artifact boundary cannot be proven for the complete
 * operation.  Callers must treat this as an integrity failure, never as a
 * provider or ordinary I/O failure that can be retried against another path.
 */
export class ArtifactIntegrityError extends Error {
  public readonly code: ArtifactIntegrityErrorCode;
  public readonly artifactPath?: string;

  public constructor(code: ArtifactIntegrityErrorCode, message: string, artifactPath?: string) {
    super(`[ArtifactStore] ${code}: ${message}`);
    this.name = 'ArtifactIntegrityError';
    this.code = code;
    this.artifactPath = artifactPath;
  }
}

interface ArtifactPathIdentity {
  readonly key: string;
  readonly realPath: string;
}

interface ArtifactPathSnapshot {
  readonly absolutePath: string;
  readonly identities: ReadonlyArray<ArtifactPathIdentity>;
  readonly leafIdentity?: ArtifactPathIdentity;
}

interface ArtifactRootAnchor {
  readonly baseDir: string;
  readonly rootIdentity: ArtifactPathIdentity;
  readonly descriptor: number | null;
  readonly descriptorPath: string | null;
}

const POSIX_DESCRIPTOR_ANCHOR =
  process.platform === 'linux' &&
  typeof fs.constants.O_DIRECTORY === 'number' &&
  typeof fs.constants.O_NOFOLLOW === 'number' &&
  fs.existsSync('/proc/self/fd');

/**
 * Linux exposes a descriptor-relative `/proc/self/fd` path plus O_NOFOLLOW,
 * so all artifact operations can stay attached to the directory that was
 * checked.  Node's portable Windows API does not expose the Win32
 * FILE_FLAG_OPEN_REPARSE_POINT/handle-relative calls needed for the same
 * guarantee (and other non-Linux platforms may lack `/proc/self/fd`).  Those
 * fallbacks use lstat/realpath identity fences and reject every observed
 * root, parent, leaf, or atomic-publish change with a typed integrity error;
 * the limitation is deliberately explicit so a caller cannot mistake the
 * fallback for an absolute no-reparse guarantee.
 */

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === code);
}

function errnoCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? String((error as { code: string }).code)
    : undefined;
}

function canonicalRealPath(targetPath: string): string {
  try {
    const realpath = fs.realpathSync.native ?? fs.realpathSync;
    return realpath(targetPath);
  } catch (error) {
    throw new ArtifactIntegrityError('ARTIFACT_PATH_UNVERIFIED', 'real path could not be resolved', targetPath);
  }
}

function identityKey(stat: fs.Stats): string {
  // dev/ino are stable on POSIX and available on NTFS in Node 22.  The mode
  // component prevents a replaced directory/file from comparing equal on a
  // filesystem that reports a reused inode quickly.
  return `${String(stat.dev)}:${String(stat.ino)}:${String(stat.mode & 0o170000)}`;
}

function sameIdentity(left: ArtifactPathIdentity, right: ArtifactPathIdentity): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  return left.key === right.key && normalize(left.realPath) === normalize(right.realPath);
}

function captureDirectoryIdentity(directoryPath: string, code: ArtifactIntegrityErrorCode = 'ARTIFACT_ROOT_INVALID'): ArtifactPathIdentity {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directoryPath);
  } catch (error) {
    throw new ArtifactIntegrityError(code, `directory cannot be inspected (${errnoCode(error) ?? 'IO_ERROR'})`, directoryPath);
  }
  if (!stat.isDirectory()) {
    throw new ArtifactIntegrityError(code, 'artifact boundary component is not a directory', directoryPath);
  }
  if (stat.isSymbolicLink()) {
    throw new ArtifactIntegrityError('ARTIFACT_REPARSE_POINT', 'symbolic links and junctions are not permitted in the artifact boundary', directoryPath);
  }
  return { key: identityKey(stat), realPath: canonicalRealPath(directoryPath) };
}

function isContainedRealPath(targetPath: string, rootRealPath: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  const target = normalize(targetPath);
  const root = normalize(rootRealPath);
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function createRootAnchor(baseDir: string): ArtifactRootAnchor {
  const absoluteBase = path.resolve(baseDir);
  const rootIdentity = captureDirectoryIdentity(absoluteBase);
  let descriptor: number | null = null;
  let descriptorPath: string | null = null;

  if (POSIX_DESCRIPTOR_ANCHOR) {
    const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
    try {
      descriptor = fs.openSync(absoluteBase, flags);
      descriptorPath = `/proc/self/fd/${descriptor}`;
      const opened = fs.fstatSync(descriptor);
      if (identityKey(opened) !== rootIdentity.key) {
        throw new ArtifactIntegrityError('ARTIFACT_ROOT_CHANGED', 'artifact root changed while opening its directory descriptor', absoluteBase);
      }
    } catch (error) {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch { /* preserve integrity failure */ }
      }
      if (error instanceof ArtifactIntegrityError) throw error;
      throw new ArtifactIntegrityError('ARTIFACT_NOFOLLOW_UNAVAILABLE', 'descriptor-relative artifact access is unavailable', absoluteBase);
    }
  }

  return { baseDir: absoluteBase, rootIdentity, descriptor, descriptorPath };
}

function closeRootAnchor(anchor: ArtifactRootAnchor): void {
  if (anchor.descriptor !== null) {
    try {
      fs.closeSync(anchor.descriptor);
    } catch {
      // The operation result remains authoritative; a closed descriptor is
      // best-effort cleanup and cannot make an already published artifact less
      // safe.
    }
  }
}

function anchoredPath(anchor: ArtifactRootAnchor, absolutePath: string): string {
  if (anchor.descriptorPath === null) return absolutePath;
  const relative = path.relative(anchor.baseDir, absolutePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ArtifactIntegrityError('ARTIFACT_PATH_UNVERIFIED', 'path is not a non-empty child of the anchored artifact root', absolutePath);
  }
  return path.posix.join(anchor.descriptorPath, relative.replaceAll('\\', '/'));
}

function inspectArtifactPath(anchor: ArtifactRootAnchor, targetPath: string): ArtifactPathSnapshot {
  let absolutePath: string;
  try {
    absolutePath = assertPathContained(targetPath, anchor.baseDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/SYMLINK_NOT_PERMITTED|symbolic link|junction/i.test(message)) {
      throw new ArtifactIntegrityError('ARTIFACT_REPARSE_POINT', 'artifact path contains a symbolic link or junction', targetPath);
    }
    throw new ArtifactIntegrityError('ARTIFACT_PATH_UNVERIFIED', 'artifact path failed lexical containment validation', targetPath);
  }
  const relative = path.relative(anchor.baseDir, absolutePath);
  const segments = relative.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) {
    throw new ArtifactIntegrityError('ARTIFACT_PATH_UNVERIFIED', 'artifact root itself is not an artifact file', absolutePath);
  }

  const identities: ArtifactPathIdentity[] = [anchor.rootIdentity];
  let current = anchor.baseDir;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = path.join(current, segments[index]);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) {
        throw new ArtifactIntegrityError('ARTIFACT_PARENT_MISSING', 'all artifact parent directories must exist before a sensitive operation', current);
      }
      throw new ArtifactIntegrityError('ARTIFACT_PATH_UNVERIFIED', `artifact parent cannot be inspected (${errnoCode(error) ?? 'IO_ERROR'})`, current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ArtifactIntegrityError('ARTIFACT_REPARSE_POINT', 'artifact parent is not a real directory', current);
    }
    const identity = { key: identityKey(stat), realPath: canonicalRealPath(current) };
    if (!isContainedRealPath(identity.realPath, anchor.rootIdentity.realPath)) {
      throw new ArtifactIntegrityError('ARTIFACT_REPARSE_POINT', 'artifact parent resolves outside the configured root', current);
    }
    identities.push(identity);
  }

  // Existing leaves are checked before use.  Missing leaves are allowed for
  // exclusive creation, but their parents are never allowed to be missing.
  let leafIdentity: ArtifactPathIdentity | undefined;
  try {
    const leafStat = fs.lstatSync(absolutePath);
    if (leafStat.isSymbolicLink()) {
      throw new ArtifactIntegrityError('ARTIFACT_REPARSE_POINT', 'artifact leaf is a symbolic link or junction', absolutePath);
    }
    const leafRealPath = canonicalRealPath(absolutePath);
    if (!isContainedRealPath(leafRealPath, anchor.rootIdentity.realPath)) {
      throw new ArtifactIntegrityError('ARTIFACT_REPARSE_POINT', 'artifact leaf resolves outside the configured root', absolutePath);
    }
    leafIdentity = { key: identityKey(leafStat), realPath: leafRealPath };
  } catch (error) {
    if (error instanceof ArtifactIntegrityError) throw error;
    if (!isErrno(error, 'ENOENT')) {
      throw new ArtifactIntegrityError('ARTIFACT_PATH_UNVERIFIED', `artifact leaf cannot be inspected (${errnoCode(error) ?? 'IO_ERROR'})`, absolutePath);
    }
  }

  return { absolutePath, identities, leafIdentity };
}

function verifyArtifactPathSnapshot(anchor: ArtifactRootAnchor, snapshot: ArtifactPathSnapshot): void {
  const currentRoot = captureDirectoryIdentity(anchor.baseDir);
  if (!sameIdentity(currentRoot, anchor.rootIdentity)) {
    throw new ArtifactIntegrityError('ARTIFACT_ROOT_CHANGED', 'artifact root identity changed during the operation', anchor.baseDir);
  }

  const relative = path.relative(anchor.baseDir, snapshot.absolutePath);
  const segments = relative.split(/[\\/]+/).filter(Boolean);
  let current = anchor.baseDir;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = path.join(current, segments[index]);
    let identity: ArtifactPathIdentity;
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new ArtifactIntegrityError('ARTIFACT_PARENT_CHANGED', 'artifact parent became a symbolic link or non-directory', current);
      }
      identity = { key: identityKey(stat), realPath: canonicalRealPath(current) };
    } catch (error) {
      if (error instanceof ArtifactIntegrityError) throw error;
      throw new ArtifactIntegrityError('ARTIFACT_PARENT_CHANGED', 'artifact parent disappeared during the operation', current);
    }
    const expected = snapshot.identities[index + 1];
    if (!expected || !sameIdentity(identity, expected)) {
      throw new ArtifactIntegrityError('ARTIFACT_PARENT_CHANGED', 'artifact parent identity changed during the operation', current);
    }
  }

  try {
    const leafStat = fs.lstatSync(snapshot.absolutePath);
    if (leafStat.isSymbolicLink()) {
      throw new ArtifactIntegrityError('ARTIFACT_REPARSE_POINT', 'artifact leaf became a symbolic link or junction', snapshot.absolutePath);
    }
    const leafIdentity = { key: identityKey(leafStat), realPath: canonicalRealPath(snapshot.absolutePath) };
    if (!isContainedRealPath(leafIdentity.realPath, anchor.rootIdentity.realPath)) {
      throw new ArtifactIntegrityError('ARTIFACT_REPARSE_POINT', 'artifact leaf resolves outside the configured root', snapshot.absolutePath);
    }
    if (snapshot.leafIdentity && !sameIdentity(leafIdentity, snapshot.leafIdentity)) {
      throw new ArtifactIntegrityError('ARTIFACT_PATH_UNVERIFIED', 'artifact leaf identity changed during the operation', snapshot.absolutePath);
    }
  } catch (error) {
    if (error instanceof ArtifactIntegrityError) throw error;
    if (!isErrno(error, 'ENOENT')) {
      throw new ArtifactIntegrityError('ARTIFACT_PATH_UNVERIFIED', 'artifact leaf could not be verified after the operation', snapshot.absolutePath);
    }
  }
}

function openArtifactFile(filePath: string, flags: number, mode?: number): number {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  try {
    return fs.openSync(filePath, flags | noFollow, mode);
  } catch (error) {
    if (noFollow === 0 && process.platform !== 'win32') {
      throw new ArtifactIntegrityError('ARTIFACT_NOFOLLOW_UNAVAILABLE', 'the platform cannot guarantee no-follow file access', filePath);
    }
    throw error;
  }
}

function readArtifactBytes(anchor: ArtifactRootAnchor, absolutePath: string): Buffer {
  const descriptor = openArtifactFile(anchoredPath(anchor, absolutePath), fs.constants.O_RDONLY);
  try {
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeAll(descriptor: number, content: Buffer): void {
  let offset = 0;
  while (offset < content.length) {
    const written = fs.writeSync(descriptor, content, offset, content.length - offset);
    if (written <= 0) throw new Error('WRITE_NO_PROGRESS');
    offset += written;
  }
}

function unlinkArtifactFile(anchor: ArtifactRootAnchor, absolutePath: string): void {
  try {
    fs.unlinkSync(anchoredPath(anchor, absolutePath));
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
}

function syncAnchoredDirectory(anchor: ArtifactRootAnchor, artifactPath: string): void {
  if (anchor.descriptor === null) return;
  try {
    fs.fsyncSync(anchor.descriptor);
  } catch {
    throw new ArtifactIntegrityError('ARTIFACT_ATOMIC_PUBLISH_UNAVAILABLE', 'published artifact metadata could not be synchronized', artifactPath);
  }
}

function publishArtifactNoReplace(anchor: ArtifactRootAnchor, temporaryPath: string, finalPath: string): 'PUBLISHED' | 'EXISTS' {
  try {
    // link() is an atomic no-replace publication primitive on the same
    // filesystem.  Unlike rename(), it cannot silently overwrite a destination
    // that appeared between the preflight check and publication.
    fs.linkSync(anchoredPath(anchor, temporaryPath), anchoredPath(anchor, finalPath));
    unlinkArtifactFile(anchor, temporaryPath);
    syncAnchoredDirectory(anchor, finalPath);
    return 'PUBLISHED';
  } catch (error) {
    if (isErrno(error, 'EEXIST')) return 'EXISTS';
    const code = errnoCode(error);
    if (code === 'ENOSYS' || code === 'EOPNOTSUPP' || code === 'EXDEV' || code === 'EPERM') {
      throw new ArtifactIntegrityError('ARTIFACT_ATOMIC_PUBLISH_UNAVAILABLE', 'the platform cannot provide an atomic no-replace publication primitive', finalPath);
    }
    throw error;
  }
}

/**
 * Checks if child path is safely contained within parent directory without string prefix bugs.
 * Rejects traversal (..), absolute escapes, drive/UNC changes, sibling prefixes (<root>-evil),
 * parent symlinks/junctions, and leaf symlinks.
 */
export function assertPathContained(targetPath: string, rootDir: string): string {
  const isWin = process.platform === 'win32';
  const absRoot = path.resolve(rootDir);
  const absTarget = path.resolve(targetPath);

  const rootParsed = path.parse(absRoot);
  const targetParsed = path.parse(absTarget);

  // The root itself is a trust boundary. Checking only child components is
  // insufficient when a caller supplies a symlink/junction as the root and
  // then creates a new target beneath it (there is no existing target for the
  // real-path check to inspect yet).
  if (fs.existsSync(absRoot)) {
    try {
      if (fs.lstatSync(absRoot).isSymbolicLink()) {
        throw new Error('[ArtifactStore] Security violation: Evidence root is a symbolic link or junction (SYMLINK_NOT_PERMITTED)');
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('Security violation')) throw err;
      throw new Error('[ArtifactStore] Security violation: Cannot verify evidence root');
    }
  }

  // 1. Root / Drive / UNC change check
  const rootDrive = isWin ? rootParsed.root.toLowerCase() : rootParsed.root;
  const targetDrive = isWin ? targetParsed.root.toLowerCase() : targetParsed.root;
  if (rootDrive !== targetDrive) {
    throw new Error('[ArtifactStore] Security violation: Cross-root, drive, or UNC path traversal rejected (ILLEGAL_PATH_TRAVERSAL)');
  }

  // 2. Relative containment check (handles .., absolute, sibling prefixes like <root>-evil)
  const rel = path.relative(isWin ? absRoot.toLowerCase() : absRoot, isWin ? absTarget.toLowerCase() : absTarget);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('[ArtifactStore] Security violation: Path escapes evidence root directory (ILLEGAL_PATH_TRAVERSAL)');
  }

  // 3. Reject symlinks or junctions in any parent component between root and target
  const segments = path.relative(absRoot, absTarget).split(/[/\\]+/).filter(Boolean);
  let current = absRoot;
  for (let i = 0; i < segments.length - 1; i++) {
    current = path.join(current, segments[i]);
    if (fs.existsSync(current)) {
      try {
        const lstat = fs.lstatSync(current);
        if (lstat.isSymbolicLink()) {
          throw new Error('[ArtifactStore] Security violation: Parent path component is a symbolic link or junction (SYMLINK_NOT_PERMITTED)');
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('Security violation')) throw err;
        throw new Error('[ArtifactStore] Security violation: Cannot verify path component');
      }
    }
  }

  // 4. Reject leaf symlink
  if (fs.existsSync(absTarget)) {
    try {
      const lstat = fs.lstatSync(absTarget);
      if (lstat.isSymbolicLink()) {
        throw new Error('[ArtifactStore] Security violation: Leaf target is a symbolic link (SYMLINK_NOT_PERMITTED)');
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('Security violation')) throw err;
      throw new Error('[ArtifactStore] Security violation: Cannot verify target file');
    }

    // 5. Ensure resolved real path remains inside real root
    try {
      const realRoot = fs.realpathSync(absRoot);
      const realTarget = fs.realpathSync(absTarget);
      const realRootDrive = isWin ? path.parse(realRoot).root.toLowerCase() : path.parse(realRoot).root;
      const realTargetDrive = isWin ? path.parse(realTarget).root.toLowerCase() : path.parse(realTarget).root;
      if (realRootDrive !== realTargetDrive) {
        throw new Error('[ArtifactStore] Security violation: Real path cross-root traversal rejected (ILLEGAL_PATH_TRAVERSAL)');
      }
      const realRel = path.relative(isWin ? realRoot.toLowerCase() : realRoot, isWin ? realTarget.toLowerCase() : realTarget);
      if (realRel === '' || realRel.startsWith('..') || path.isAbsolute(realRel)) {
        throw new Error('[ArtifactStore] Security violation: Resolved real path escapes evidence root (ILLEGAL_PATH_TRAVERSAL)');
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('Security violation')) throw err;
      throw new Error('[ArtifactStore] Security violation: Cannot resolve real path');
    }
  }

  return absTarget;
}

/**
 * Builds canonical JSON representation of an ArtifactManifest with sorted keys and ordered entries.
 * Rejects arrays, manufacturing of placeholder IDs, missing keys, extra keys, and aliases.
 */
export function canonicalizeArtifactManifest(manifest: ArtifactManifest): string {
  if (Array.isArray(manifest) || !manifest || typeof manifest !== 'object') {
    throw new Error('[ArtifactManifest] Manifest must be a non-null plain object');
  }

  const manifestKeys = Object.keys(manifest).sort();
  const expectedManifestKeys = [...ARTIFACT_MANIFEST_KEYS].sort();
  if (
    manifestKeys.length !== expectedManifestKeys.length ||
    manifestKeys.some((k, i) => k !== expectedManifestKeys[i])
  ) {
    throw new Error('[ArtifactManifest] Invalid manifest property set');
  }

  if (manifest.manifest_schema_version !== 1) {
    throw new Error('[ArtifactManifest] Unsupported manifest_schema_version');
  }

  if (!Array.isArray(manifest.entries)) {
    throw new Error('[ArtifactManifest] Manifest entries must be an array');
  }

  // Sort entries deterministically by evidence_id ascending
  const sortedEntries = [...manifest.entries].sort((a, b) =>
    (a.evidence_id || a.relative_path || '').localeCompare(b.evidence_id || b.relative_path || '')
  );

  const validatedEntries = sortedEntries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('[ArtifactManifest] Manifest entry must be a non-null plain object');
    }
    const entryKeys = Object.keys(entry).sort();
    const expectedEntryKeys = [...ARTIFACT_MANIFEST_ENTRY_KEYS].sort();
    if (
      entryKeys.length !== expectedEntryKeys.length ||
      entryKeys.some((k, i) => k !== expectedEntryKeys[i])
    ) {
      throw new Error('[ArtifactManifest] Invalid manifest entry property set');
    }
    if (typeof entry.evidence_id !== 'string' || !entry.evidence_id) {
      throw new Error('[ArtifactManifest] Manifest entry evidence_id must be non-empty string');
    }
    if (typeof entry.byte_size !== 'number' || entry.byte_size < 0 || !Number.isInteger(entry.byte_size)) {
      throw new Error('[ArtifactManifest] Manifest entry byte_size must be a non-negative integer');
    }
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error('[ArtifactManifest] Manifest entry sha256 must be a 64-char lowercase hex string');
    }
    if (typeof entry.relative_path !== 'string' || !entry.relative_path) {
      throw new Error('[ArtifactManifest] Manifest entry relative_path must be non-empty string');
    }
    if (typeof entry.content_type !== 'string' || !entry.content_type) {
      throw new Error('[ArtifactManifest] Manifest entry content_type must be non-empty string');
    }
    if (typeof entry.evidence_type !== 'string' || !entry.evidence_type) {
      throw new Error('[ArtifactManifest] Manifest entry evidence_type must be non-empty string');
    }
    if (entry.storage_class !== 'FILE' && entry.storage_class !== 'INLINE') {
      throw new Error('[ArtifactManifest] Manifest entry storage_class must be FILE or INLINE');
    }
    return {
      byte_size: entry.byte_size,
      content_type: entry.content_type,
      evidence_id: entry.evidence_id,
      evidence_type: entry.evidence_type,
      relative_path: entry.relative_path,
      sha256: entry.sha256,
      storage_class: entry.storage_class,
    };
  });

  const canonicalObj = {
    adjudication_id: manifest.adjudication_id,
    entries: validatedEntries,
    lifecycle_version: manifest.lifecycle_version,
    manifest_schema_version: manifest.manifest_schema_version,
    verification_execution_id: manifest.verification_execution_id,
  };

  return JSON.stringify(canonicalObj);
}

export function computeArtifactManifestHash(manifestJsonOrObj: string | ArtifactManifest): string {
  let manifest: ArtifactManifest;
  if (typeof manifestJsonOrObj === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestJsonOrObj);
    } catch (parseErr: unknown) {
      throw new Error('[ArtifactManifest] Malformed manifest JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('[ArtifactManifest] Manifest must be a non-null plain object');
    }
    manifest = parsed as ArtifactManifest;
  } else {
    manifest = manifestJsonOrObj;
  }
  const canonicalJson = canonicalizeArtifactManifest(manifest);
  return crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

export function parseAndVerifyArtifactManifest(
  manifestJson: string,
  expectedHash?: string
): ArtifactManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson);
  } catch (parseErr: unknown) {
    throw new Error('[ArtifactManifest] Malformed manifest JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[ArtifactManifest] Manifest must be a non-null plain object');
  }
  const manifest = parsed as ArtifactManifest;
  const canonicalJson = canonicalizeArtifactManifest(manifest);
  const hash = crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
  if (expectedHash !== undefined) {
    if (typeof expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHash)) {
      throw new Error('[ArtifactManifest] Expected manifest hash must be a 64-char lowercase hex string');
    }
    if (hash !== expectedHash) {
      throw new Error(`[ArtifactManifest] Manifest hash mismatch: MANIFEST_HASH_MISMATCH (expected ${expectedHash}, got ${hash})`);
    }
  }
  return JSON.parse(canonicalJson) as ArtifactManifest;
}

export const ALLOWED_FS_CODES = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'EBUSY',
  'ENOTEMPTY',
  'EEXIST',
  'EMFILE',
  'ENFILE',
  'EISDIR',
]);

export function sanitizeFsErrorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const rawCode = (err as { code: unknown }).code;
    if (typeof rawCode === 'string' && ALLOWED_FS_CODES.has(rawCode)) {
      return rawCode;
    }
  }
  return 'IO_ERROR';
}

export class ArtifactStore {
  public static assertPathContained(targetPath: string, rootDir: string): string {
    return assertPathContained(targetPath, rootDir);
  }

  public static materializeContentAddressedFile(
    targetDir: string,
    expectedHash: string,
    content: string | Buffer
  ): string {
    const store = new ArtifactStore(targetDir);
    const result = store.materializeContentAddressedFile(content, expectedHash);
    return result.filePath;
  }

  private baseDir: string | null = null;
  private thresholdBytes: number;

  constructor(customBaseDir?: string, thresholdBytes: number = 32 * 1024) {
    this.baseDir = customBaseDir ?? null;
    this.thresholdBytes = thresholdBytes;
  }

  public setBaseDir(customBaseDir: string): void {
    this.baseDir = customBaseDir;
  }

  public getBaseDir(): string {
    if (!this.baseDir) {
      throw new Error('[ArtifactStore] Base directory is not configured. Call setBaseDir() first.');
    }
    try {
      fs.mkdirSync(this.baseDir, { recursive: true });
    } catch (error) {
      throw new ArtifactIntegrityError('ARTIFACT_ROOT_INVALID', `artifact root cannot be created (${errnoCode(error) ?? 'IO_ERROR'})`, this.baseDir);
    }
    // Re-check after mkdir.  A concurrent replacement can turn a newly
    // created root into a junction/reparse point before a child is opened.
    captureDirectoryIdentity(path.resolve(this.baseDir));
    return this.baseDir;
  }

  private withRootAnchor<T>(targetPaths: string[], operation: (anchor: ArtifactRootAnchor, snapshots: ReadonlyArray<ArtifactPathSnapshot>) => T): T {
    const baseDir = path.resolve(this.getBaseDir());
    const anchor = createRootAnchor(baseDir);
    let snapshots: ArtifactPathSnapshot[] = [];
    try {
      snapshots = targetPaths.map((targetPath) => inspectArtifactPath(anchor, targetPath));
      const result = operation(anchor, snapshots);
      snapshots.forEach((snapshot) => verifyArtifactPathSnapshot(anchor, snapshot));
      return result;
    } catch (error) {
      // A root/parent swap takes precedence over an ordinary I/O error: the
      // caller must not retry an operation against an untrusted path.
      try {
        snapshots.forEach((snapshot) => verifyArtifactPathSnapshot(anchor, snapshot));
      } catch (integrityError) {
        throw integrityError;
      }
      throw error;
    } finally {
      closeRootAnchor(anchor);
    }
  }

  public store(
    id: string,
    projectId: string,
    taskId: string | null,
    attemptId: string | null,
    evidenceType: EvidenceType,
    summary: string,
    payload: string,
    contentType: string = 'text/plain'
  ): Evidence {
    const hash = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
    const byteSize = Buffer.byteLength(payload, 'utf8');
    const now = new Date().toISOString();

    if (byteSize < this.thresholdBytes) {
      return {
        id,
        project_id: projectId,
        task_id: taskId,
        attempt_id: attemptId,
        evidence_type: evidenceType,
        storage_type: 'INLINE',
        file_path: null,
        hash,
        byte_size: byteSize,
        content_type: contentType,
        summary,
        raw_payload: payload,
        created_at: now,
      };
    }

    const baseDir = this.getBaseDir();
    const finalPath = path.join(baseDir, `${hash}.bin`);
    assertPathContained(finalPath, baseDir);
    this.materializeContentAddressedFile(payload, hash);

    return {
      id,
      project_id: projectId,
      task_id: taskId,
      attempt_id: attemptId,
      evidence_type: evidenceType,
      storage_type: 'FILE',
      file_path: finalPath,
      hash,
      byte_size: byteSize,
      content_type: contentType,
      summary,
      raw_payload: null,
      created_at: now,
    };
  }

  public stage(
    id: string,
    projectId: string,
    taskId: string | null,
    attemptId: string | null,
    evidenceType: EvidenceType,
    summary: string,
    payload: string,
    contentType: string = 'text/plain'
  ): {
    evidence: Evidence;
    stagedPath: string | null;
    finalPath: string | null;
    isStagedFile: boolean;
  } {
    const hash = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
    const byteSize = Buffer.byteLength(payload, 'utf8');
    const now = new Date().toISOString();

    const baseDir = this.getBaseDir();
    const stagedPath = path.join(baseDir, `staged_${id}_${hash}.bin`);
    const finalPath = path.join(baseDir, `${hash}.bin`);

    const buf = Buffer.from(payload, 'utf8');
    this.withRootAnchor([stagedPath, finalPath], (anchor) => {
      let descriptor: number | null = null;
      let stageErr: Error | null = null;
      try {
        const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
        descriptor = openArtifactFile(anchoredPath(anchor, stagedPath), flags, 0o600);
        writeAll(descriptor, buf);
        fs.fsyncSync(descriptor);
      } catch (writeErr: unknown) {
        const code = errnoCode(writeErr) ?? '';
        stageErr = new Error(code === 'EEXIST' ? 'STAGE_EXCLUSIVE_CREATE_FAILED: EEXIST' : 'STAGE_EXCLUSIVE_CREATE_FAILED');
      } finally {
        if (descriptor !== null) {
          try {
            fs.closeSync(descriptor);
          } catch {
            if (!stageErr) stageErr = new Error('STAGE_DESCRIPTOR_CLOSE_FAILED');
          }
        }
      }

      if (stageErr) {
        try {
          unlinkArtifactFile(anchor, stagedPath);
        } catch {
          throw new Error(`[ArtifactStore] Failed to stage file exclusively: ${stageErr.message}: CLEANUP_DEBT_STAGING_UNLINK_FAILED`);
        }
        throw new Error(`[ArtifactStore] Failed to stage file exclusively: ${stageErr.message}`);
      }
    });

    const evidence: Evidence = {
      id,
      project_id: projectId,
      task_id: taskId,
      attempt_id: attemptId,
      evidence_type: evidenceType,
      storage_type: 'FILE',
      file_path: finalPath,
      hash,
      byte_size: byteSize,
      content_type: contentType,
      summary,
      raw_payload: null,
      created_at: now,
    };

    return { evidence, stagedPath, finalPath, isStagedFile: true };
  }

  public finalizeStagedFile(stagedPath: string, finalPath: string, expectedHash: string): void {
    this.withRootAnchor([stagedPath, finalPath], (anchor) => {
      const stagedAnchored = anchoredPath(anchor, path.resolve(stagedPath));
      const finalAnchored = anchoredPath(anchor, path.resolve(finalPath));
      if (!fs.existsSync(stagedAnchored)) {
        if (fs.existsSync(finalAnchored)) {
          const existingContent = readArtifactBytes(anchor, path.resolve(finalPath));
          const existingHash = crypto.createHash('sha256').update(existingContent).digest('hex');
          if (existingHash === expectedHash) return;
          throw new Error('[ArtifactStore] Finalized artifact hash mismatch');
        }
        throw new Error('[ArtifactStore] Staged file missing before finalization');
      }

      const outcome = publishArtifactNoReplace(anchor, path.resolve(stagedPath), path.resolve(finalPath));
      if (outcome === 'EXISTS') {
        const existingContent = readArtifactBytes(anchor, path.resolve(finalPath));
        const existingHash = crypto.createHash('sha256').update(existingContent).digest('hex');
        if (existingHash === expectedHash) {
          try {
            unlinkArtifactFile(anchor, path.resolve(stagedPath));
          } catch {
            throw new Error('[ArtifactStore] Finalization collision cleanup failed: CLEANUP_DEBT_STAGED_UNLINK_FAILED');
          }
          return;
        }
        throw new Error('[ArtifactStore] Content conflict: destination exists with differing content');
      }

      // Verify final content through the anchored descriptor after publication.
      const finalContent = readArtifactBytes(anchor, path.resolve(finalPath));
      const finalHash = crypto.createHash('sha256').update(finalContent).digest('hex');
      if (finalHash !== expectedHash) {
        throw new Error('[ArtifactStore] Finalized artifact hash mismatch');
      }
    });
  }

  public cleanupStagedFile(stagedPath: string): void {
    if (!stagedPath) {
      return;
    }
    this.withRootAnchor([stagedPath], (anchor) => {
      const anchored = anchoredPath(anchor, path.resolve(stagedPath));
      if (!fs.existsSync(anchored)) return;

      let lastError: Error | null = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          unlinkArtifactFile(anchor, path.resolve(stagedPath));
          return;
        } catch {
          lastError = new Error('UNLINK_FAILED');
        }
      }

      if (lastError && fs.existsSync(anchored)) {
        throw new Error('[STAGING_CLEANUP_FAILED] Failed to delete staged file: UNLINK_FAILED');
      }
    });
  }

  public read(evidence: Evidence): string {
    if (evidence.storage_type === 'INLINE') {
      if (evidence.raw_payload === null) {
        throw new Error(`[ArtifactStore] Evidence ${evidence.id} is marked INLINE but has null payload.`);
      }
      return evidence.raw_payload;
    }

    if (!evidence.file_path) {
      throw new Error(`[ArtifactStore] Evidence file path is missing.`);
    }

    const content = this.readBuffer(evidence.file_path);
    const computedHash = crypto.createHash('sha256').update(content).digest('hex');

    if (computedHash !== evidence.hash) {
      throw new Error(
        `[ArtifactStore] Integrity violation: SHA-256 hash mismatch for artifact "${evidence.id}".`
      );
    }

    return content.toString('utf8');
  }

  /**
   * Reads an artifact through the anchored root descriptor where Linux can
   * provide one, and through a pre/post identity fence elsewhere.  Consumers
   * that need byte-accurate hashes should use this method instead of opening
   * evidence paths directly.
   */
  public readBuffer(filePath: string): Buffer {
    return this.withRootAnchor([filePath], (anchor) => {
      const absolutePath = path.resolve(filePath);
      const anchored = anchoredPath(anchor, absolutePath);
      if (!fs.existsSync(anchored)) {
        throw new Error('[ArtifactStore] Evidence file missing on disk.');
      }
      try {
        return readArtifactBytes(anchor, absolutePath);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) throw new Error('[ArtifactStore] Evidence file missing on disk.');
        throw error;
      }
    });
  }

  public materializeContentAddressedFile(
    content: string | Buffer,
    expectedHash?: string
  ): { filePath: string; hash: string; byteSize: number; newlyCreated: boolean } {
    const baseDir = this.getBaseDir();
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const hash = crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
    if (expectedHash && hash !== expectedHash.toLowerCase()) {
      throw new Error('[ArtifactStore] Hash mismatch before materialization');
    }

    const finalPath = path.join(baseDir, `${hash}.bin`);
    const tempName = `.tmp_${crypto.randomUUID()}_${hash}.bin`;
    const tempPath = path.join(baseDir, tempName);

    return this.withRootAnchor([finalPath, tempPath], (anchor) => {
      const finalAnchored = anchoredPath(anchor, finalPath);
      if (fs.existsSync(finalAnchored)) {
        const existing = readArtifactBytes(anchor, finalPath);
        const existingHash = crypto.createHash('sha256').update(existing).digest('hex').toLowerCase();
        if (existingHash !== hash || existing.byteLength !== buf.byteLength || !existing.equals(buf)) {
          throw new Error('[ArtifactStore] Content conflict: existing content-addressed artifact does not match bytes or hash (HASH_COLLISION_MISMATCH)');
        }
        return { filePath: finalPath, hash, byteSize: buf.byteLength, newlyCreated: false };
      }

      let descriptor: number | null = null;
      let matErr: Error | null = null;
      try {
        const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
        descriptor = openArtifactFile(anchoredPath(anchor, tempPath), flags, 0o600);
        writeAll(descriptor, buf);
        fs.fsyncSync(descriptor);
      } catch (writeErr: unknown) {
        matErr = new Error('TEMP_EXCLUSIVE_CREATE_FAILED');
      } finally {
        if (descriptor !== null) {
          try {
            fs.closeSync(descriptor);
          } catch {
            if (!matErr) matErr = new Error('DESCRIPTOR_CLOSE_FAILED');
          }
        }
      }

      if (matErr) {
        try {
          unlinkArtifactFile(anchor, tempPath);
        } catch {
          throw new Error(`[ArtifactStore] Temp file materialization failed: ${matErr.message}: CLEANUP_DEBT_TEMP_UNLINK_FAILED`);
        }
        throw new Error(`[ArtifactStore] Temp file materialization failed: ${matErr.message}`);
      }

      const tempBytes = readArtifactBytes(anchor, tempPath);
      const tempHash = crypto.createHash('sha256').update(tempBytes).digest('hex').toLowerCase();
      if (tempHash !== hash || tempBytes.byteLength !== buf.byteLength || !tempBytes.equals(buf)) {
        try {
          unlinkArtifactFile(anchor, tempPath);
        } catch {
          throw new Error('[ArtifactStore] Temp file verification failed before atomic rename (CLEANUP_DEBT_TEMP_UNLINK_FAILED)');
        }
        throw new Error('[ArtifactStore] Temp file verification failed before atomic rename');
      }

      let outcome: 'PUBLISHED' | 'EXISTS';
      try {
        outcome = publishArtifactNoReplace(anchor, tempPath, finalPath);
      } catch (publishError) {
        try {
          unlinkArtifactFile(anchor, tempPath);
        } catch {
          throw new Error('[ArtifactStore] Materialization failed during atomic rename: ATOMIC_RENAME_FAILED (CLEANUP_DEBT_TEMP_UNLINK_FAILED)');
        }
        throw publishError;
      }

      if (outcome === 'EXISTS') {
        try {
          unlinkArtifactFile(anchor, tempPath);
        } catch {
          throw new Error('[ArtifactStore] Content conflict: collision cleanup failed: CLEANUP_DEBT_TEMP_UNLINK_FAILED');
        }
        const existing = readArtifactBytes(anchor, finalPath);
        const existingHash = crypto.createHash('sha256').update(existing).digest('hex').toLowerCase();
        if (existingHash === hash && existing.byteLength === buf.byteLength && existing.equals(buf)) {
          return { filePath: finalPath, hash, byteSize: buf.byteLength, newlyCreated: false };
        }
        throw new Error('[ArtifactStore] Content conflict: concurrent destination exists with differing bytes');
      }

      const written = readArtifactBytes(anchor, finalPath);
      const writtenHash = crypto.createHash('sha256').update(written).digest('hex').toLowerCase();
      if (writtenHash !== hash || written.byteLength !== buf.byteLength || !written.equals(buf)) {
        throw new Error('[ArtifactStore] Materialization verification failed');
      }

      return { filePath: finalPath, hash, byteSize: buf.byteLength, newlyCreated: true };
    });
  }

  public static sanitizeFsErrorCode(err: unknown): string {
    return sanitizeFsErrorCode(err);
  }

  public static cleanupRollbackFiles(
    filePaths: string[],
    isFileReferencedDurable?: (fp: string) => boolean,
    baseDir?: string
  ): { cleanedCount: number; failures: Array<{ path: string; error: string }> } {
    if (!baseDir && filePaths.some(Boolean)) {
      throw new ArtifactIntegrityError('ARTIFACT_BASE_DIRECTORY_REQUIRED', 'rollback cleanup requires an explicit artifact root');
    }
    const failures: Array<{ path: string; error: string }> = [];
    let cleanedCount = 0;

    if (!baseDir) return { cleanedCount, failures };
    const root = path.resolve(baseDir);
    const anchor = createRootAnchor(root);
    const snapshots = new Map<string, ArtifactPathSnapshot>();
    try {
      for (const fp of filePaths) {
        try {
          if (!fp) continue;
          const snapshot = inspectArtifactPath(anchor, fp);
          snapshots.set(fp, snapshot);

          if (isFileReferencedDurable && isFileReferencedDurable(fp)) continue;

          const anchored = anchoredPath(anchor, snapshot.absolutePath);
          if (fs.existsSync(anchored)) {
            unlinkArtifactFile(anchor, snapshot.absolutePath);
            cleanedCount++;
          }
          verifyArtifactPathSnapshot(anchor, snapshot);
        } catch (cleanErr: unknown) {
          const code = cleanErr instanceof ArtifactIntegrityError ? cleanErr.code : sanitizeFsErrorCode(cleanErr);
          failures.push({
            path: path.basename(fp),
            error: `UNLINK_FAILED_${code}`,
          });
        }
      }
      try {
        snapshots.forEach((snapshot) => verifyArtifactPathSnapshot(anchor, snapshot));
      } catch (integrityError) {
        if (integrityError instanceof ArtifactIntegrityError) {
          failures.push({ path: path.basename(integrityError.artifactPath ?? root), error: `UNLINK_FAILED_${integrityError.code}` });
        } else {
          throw integrityError;
        }
      }
    } finally {
      closeRootAnchor(anchor);
    }
    return { cleanedCount, failures };
  }

  public cleanupRollbackFiles(
    filePaths: string[],
    isFileReferencedDurable?: (fp: string) => boolean
  ): { cleanedCount: number; failures: Array<{ path: string; error: string }> } {
    return ArtifactStore.cleanupRollbackFiles(filePaths, isFileReferencedDurable, this.getBaseDir());
  }
}

export function verifyEvidenceIntegrity(
  evidence: Evidence,
  artifactStore: ArtifactStore
): { valid: boolean; reason?: string } {
  if (evidence.storage_type === 'INLINE') {
    if (typeof evidence.raw_payload !== 'string') {
      return { valid: false, reason: `INLINE evidence ${evidence.id} raw_payload is null or not a string` };
    }
    if (evidence.file_path !== null) {
      return { valid: false, reason: `INLINE evidence ${evidence.id} file_path must be null` };
    }
    const computedHash = crypto.createHash('sha256').update(evidence.raw_payload, 'utf8').digest('hex');
    if (computedHash !== evidence.hash) {
      return { valid: false, reason: `INLINE evidence ${evidence.id} hash mismatch: expected ${evidence.hash}, got ${computedHash}` };
    }
    const computedByteSize = Buffer.byteLength(evidence.raw_payload, 'utf8');
    if (computedByteSize !== evidence.byte_size) {
      return { valid: false, reason: `INLINE evidence ${evidence.id} byte size mismatch: expected ${evidence.byte_size}, got ${computedByteSize}` };
    }
    return { valid: true };
  }

  if (evidence.storage_type === 'FILE') {
    if (!evidence.file_path) {
      return { valid: false, reason: `FILE evidence ${evidence.id} file_path is missing` };
    }

    try {
      const fileBytes = artifactStore.readBuffer(evidence.file_path);
      const computedHash = crypto.createHash('sha256').update(fileBytes).digest('hex');
      if (computedHash !== evidence.hash) {
        return { valid: false, reason: `FILE evidence ${evidence.id} content hash mismatch: expected ${evidence.hash}, got ${computedHash}` };
      }
      if (fileBytes.length !== evidence.byte_size) {
        return { valid: false, reason: `FILE evidence ${evidence.id} byte size mismatch: expected ${evidence.byte_size}, got ${fileBytes.length}` };
      }
    } catch (readErr: unknown) {
      if (readErr instanceof ArtifactIntegrityError || (readErr instanceof Error && /ILLEGAL_PATH_TRAVERSAL|Evidence file path is missing/.test(readErr.message))) {
        return { valid: false, reason: `FILE evidence ${evidence.id} path escapes base directory: ILLEGAL_PATH_TRAVERSAL` };
      }
      if (isErrno(readErr, 'ENOENT') || (readErr instanceof Error && /file missing on disk/i.test(readErr.message))) {
        return { valid: false, reason: `FILE evidence ${evidence.id} file does not exist on disk` };
      }
      return { valid: false, reason: `FILE evidence ${evidence.id} read failed: FILE_READ_ERROR` };
    }

    return { valid: true };
  }

  return { valid: false, reason: `Unknown evidence storage type: ${evidence.storage_type}` };
}

export const defaultArtifactStore = new ArtifactStore();
