import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ArtifactIntegrityError, assertPathContained } from '../services/ArtifactStore';
import { redactTrialEvidenceText } from './trialEvidence';
import { sanitizeAutonomyText } from './contracts';

/**
 * The collector is intentionally a small, local-only evidence primitive.  It
 * reads explicitly selected files below one runtime root, applies the same
 * autonomy sanitizer used by persisted process/manager output, and writes a
 * deterministic JSON bundle.  It does not discover credentials, invoke
 * providers, or upload evidence anywhere.
 */

export const REDACTED_LOG_COLLECTION_SCHEMA_VERSION = 1 as const;
export const REDACTED_LOG_DEFAULT_MAX_FILES = 256;
export const REDACTED_LOG_DEFAULT_MAX_BYTES_PER_FILE = 4 * 1024 * 1024;
export const REDACTED_LOG_DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const REDACTED_LOG_MAX_FILES = 512;
export const REDACTED_LOG_MAX_BYTES_PER_FILE = 8 * 1024 * 1024;
export const REDACTED_LOG_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const REDACTED_LOG_MAX_OUTPUT_BYTES = 40 * 1024 * 1024;

const SHA256 = /^[0-9a-f]{64}$/;

export interface RedactedTrialLogEntry {
  relativePath: string;
  contentType: 'text/plain';
  content: string;
  byteSize: number;
  sha256: string;
  redacted: true;
}
export interface RedactedTrialLogCollection {
  schemaVersion: typeof REDACTED_LOG_COLLECTION_SCHEMA_VERSION;
  collectedAt: string;
  files: RedactedTrialLogEntry[];
  totalByteSize: number;
}

export interface CollectRedactedTrialLogsOptions {
  /** Runtime root. Every input and output path must remain below this root. */
  rootDir: string;
  /** Relative files or directories below rootDir to collect. */
  inputRelativePaths: string[];
  /** Relative output file below rootDir. */
  outputRelativePath: string;
  /** Optional canonical timestamp. Defaults to the current UTC timestamp. */
  collectedAt?: string;
  maxFiles?: number;
  maxBytesPerFile?: number;
  maxTotalBytes?: number;
}

export interface RedactedTrialLogCollectionResult {
  collection: RedactedTrialLogCollection;
  canonicalJson: string;
  filePath: string;
  /** SHA-256 of the exact bytes written to file, including the final newline. */
  sha256: string;
  byteSize: number;
}

interface BoundedLimits {
  maxFiles: number;
  maxBytesPerFile: number;
  maxTotalBytes: number;
}

/**
 * A root anchor kept open for the complete trial filesystem operation.  Linux
 * uses descriptor-relative `/proc/self/fd` paths plus O_NOFOLLOW.  Windows
 * does not expose an equivalent portable Node API, so it uses identity fences
 * and fails closed whenever an observed root/parent identity changes.
 */
export interface TrialFilesystemRoot {
  readonly baseDir: string;
  readonly rootIdentity: TrialPathIdentity;
  readonly descriptor: number | null;
  readonly descriptorPath: string | null;
}

interface TrialPathIdentity {
  readonly key: string;
  readonly realPath: string;
}

interface TrialParentSnapshot {
  readonly path: string;
  readonly identity: TrialPathIdentity;
}

const TRIAL_POSIX_DESCRIPTOR_ANCHOR =
  process.platform === 'linux' &&
  typeof fs.constants.O_DIRECTORY === 'number' &&
  typeof fs.constants.O_NOFOLLOW === 'number' &&
  fs.existsSync('/proc/self/fd');

function trialErrnoCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? String((error as { code: string }).code)
    : undefined;
}

function trialIdentityKey(stat: fs.Stats): string {
  const device = process.platform === 'win32' ? 'win32' : String(stat.dev);
  return `${device}:${String(stat.ino)}:${String(stat.mode & 0o170000)}`;
}

function trialRealPath(target: string): string {
  try {
    const realpath = fs.realpathSync.native ?? fs.realpathSync;
    return realpath(target);
  } catch {
    throw new ArtifactIntegrityError('ARTIFACT_PATH_UNVERIFIED', 'trial path real path could not be resolved', target);
  }
}

function trialSameIdentity(left: TrialPathIdentity, right: TrialPathIdentity): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  return left.key === right.key && normalize(left.realPath) === normalize(right.realPath);
}

function trialContained(root: string, target: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  const relative = path.relative(normalize(root), normalize(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function trialCaptureIdentity(target: string, code: 'ARTIFACT_ROOT_INVALID' | 'ARTIFACT_ROOT_CHANGED' | 'ARTIFACT_PARENT_CHANGED' | 'ARTIFACT_PATH_UNVERIFIED' = 'ARTIFACT_PATH_UNVERIFIED'): TrialPathIdentity {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    throw new ArtifactIntegrityError(code, `trial path cannot be inspected (${trialErrnoCode(error) ?? 'IO_ERROR'})`, target);
  }
  if (stat.isSymbolicLink()) {
    throw new ArtifactIntegrityError('ARTIFACT_REPARSE_POINT', 'trial path contains a symbolic link or junction', target);
  }
  return { key: trialIdentityKey(stat), realPath: trialRealPath(target) };
}

function trialOpenRoot(rootDir: string): TrialFilesystemRoot {
  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    throw new ArtifactIntegrityError('ARTIFACT_ROOT_INVALID', 'trial root must be a non-empty path', rootDir);
  }
  const baseDir = path.resolve(rootDir);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(baseDir);
  } catch (error) {
    throw new ArtifactIntegrityError('ARTIFACT_ROOT_INVALID', `trial root cannot be inspected (${trialErrnoCode(error) ?? 'IO_ERROR'})`, baseDir);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ArtifactIntegrityError('ARTIFACT_REPARSE_POINT', 'trial root must be a real directory', baseDir);
  }
  const rootIdentity = { key: trialIdentityKey(stat), realPath: trialRealPath(baseDir) };
  let descriptor: number | null = null;
  let descriptorPath: string | null = null;
  if (TRIAL_POSIX_DESCRIPTOR_ANCHOR) {
    try {
      descriptor = fs.openSync(baseDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      descriptorPath = `/proc/self/fd/${descriptor}`;
      if (trialIdentityKey(fs.fstatSync(descriptor)) !== rootIdentity.key) {
        throw new ArtifactIntegrityError('ARTIFACT_ROOT_CHANGED', 'trial root changed while opening its descriptor', baseDir);
      }
    } catch (error) {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch { /* preserve integrity failure */ }
      }
      descriptor = null;
      descriptorPath = null;
      if (error instanceof ArtifactIntegrityError) throw error;
      throw new ArtifactIntegrityError('ARTIFACT_NOFOLLOW_UNAVAILABLE', 'descriptor-relative trial access is unavailable', baseDir);
    }
  } else if (process.platform !== 'win32' && typeof fs.constants.O_NOFOLLOW !== 'number') {
    throw new ArtifactIntegrityError('ARTIFACT_NOFOLLOW_UNAVAILABLE', 'the platform cannot guarantee no-follow trial access', baseDir);
  }
  return { baseDir, rootIdentity, descriptor, descriptorPath };
}

export function openTrialFilesystemRoot(rootDir: string, create = false): TrialFilesystemRoot {
  if (create) {
    try { fs.mkdirSync(path.resolve(rootDir), { recursive: true }); } catch (error) {
      throw new ArtifactIntegrityError('ARTIFACT_ROOT_INVALID', `trial root cannot be created (${trialErrnoCode(error) ?? 'IO_ERROR'})`, rootDir);
    }
  }
  return trialOpenRoot(rootDir);
}

export function closeTrialFilesystemRoot(root: TrialFilesystemRoot): void {
  if (root.descriptor !== null) {
    try { fs.closeSync(root.descriptor); } catch { /* best effort */ }
  }
}

function trialRelativeSegments(root: TrialFilesystemRoot, target: string): string[] {
  const absolute = path.resolve(target);
  try { assertPathContained(absolute, root.baseDir); } catch (error) {
    throw new ArtifactIntegrityError('ARTIFACT_PATH_UNVERIFIED', error instanceof Error ? error.message : 'trial path escapes root', target);
  }
  const relative = path.relative(root.baseDir, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ArtifactIntegrityError('ARTIFACT_PATH_UNVERIFIED', 'trial path is not a non-empty root child', target);
  }
  return relative.split(/[\\/]+/).filter(Boolean);
}

function trialCaptureParents(root: TrialFilesystemRoot, target: string): TrialParentSnapshot[] {
  const segments = trialRelativeSegments(root, target);
  const snapshots: TrialParentSnapshot[] = [];
  let current = root.baseDir;
  snapshots.push({ path: current, identity: root.rootIdentity });
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = path.join(current, segments[index]);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); } catch (error) {
      throw new ArtifactIntegrityError('ARTIFACT_PARENT_MISSING', `trial parent cannot be inspected (${trialErrnoCode(error) ?? 'IO_ERROR'})`, current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ArtifactIntegrityError('ARTIFACT_REPARSE_POINT', 'trial parent is not a real directory', current);
    }
    const identity = { key: trialIdentityKey(stat), realPath: trialRealPath(current) };
    if (!trialContained(root.rootIdentity.realPath, identity.realPath)) {
      throw new ArtifactIntegrityError('ARTIFACT_REPARSE_POINT', 'trial parent resolves outside the configured root', current);
    }
    snapshots.push({ path: current, identity });
  }
  return snapshots;
}

function trialVerifyParents(root: TrialFilesystemRoot, snapshots: readonly TrialParentSnapshot[]): void {
  const currentRoot = trialCaptureIdentity(root.baseDir, 'ARTIFACT_ROOT_CHANGED');
  if (!trialSameIdentity(currentRoot, root.rootIdentity)) {
    throw new ArtifactIntegrityError('ARTIFACT_ROOT_CHANGED', 'trial root identity changed during the operation', root.baseDir);
  }
  for (const snapshot of snapshots) {
    const current = trialCaptureIdentity(snapshot.path, 'ARTIFACT_PARENT_CHANGED');
    if (!trialSameIdentity(current, snapshot.identity)) {
      throw new ArtifactIntegrityError('ARTIFACT_PARENT_CHANGED', 'trial parent identity changed during the operation', snapshot.path);
    }
  }
}

interface TrialDirectoryHandle {
  readonly path: string;
  readonly descriptor: number | null;
  readonly snapshots: readonly TrialParentSnapshot[];
}

function trialOpenDirectory(root: TrialFilesystemRoot, directory: string, createMissing: boolean): TrialDirectoryHandle {
  const absolute = path.resolve(directory);
  if (absolute === path.resolve(root.baseDir)) {
    return {
      path: root.descriptorPath ?? root.baseDir,
      descriptor: null,
      snapshots: [{ path: root.baseDir, identity: root.rootIdentity }],
    };
  }
  const segments = trialRelativeSegments(root, absolute);
  if (!root.descriptorPath || root.descriptor === null) {
    if (createMissing) {
      let current = root.baseDir;
      for (const segment of segments) {
        current = path.join(current, segment);
        try { fs.mkdirSync(current); } catch (error) {
          if (trialErrnoCode(error) !== 'EEXIST') throw error;
        }
      }
    }
    const parentSnapshots = [
      ...trialCaptureParents(root, absolute),
      { path: absolute, identity: trialCaptureIdentity(absolute, 'ARTIFACT_PARENT_CHANGED') },
    ];
    const identity = trialCaptureIdentity(absolute, 'ARTIFACT_PARENT_CHANGED');
    if (!trialContained(root.rootIdentity.realPath, identity.realPath)) {
      throw new ArtifactIntegrityError('ARTIFACT_REPARSE_POINT', 'trial directory resolves outside the configured root', absolute);
    }
    return { path: absolute, descriptor: null, snapshots: parentSnapshots };
  }

  let currentFd = root.descriptor;
  let currentPath = root.descriptorPath;
  for (const segment of segments) {
    const candidate = path.posix.join(currentPath, segment);
    const previousFd = currentFd;
    try {
      currentFd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if (createMissing && trialErrnoCode(error) === 'ENOENT') {
        try { fs.mkdirSync(candidate); } catch (mkdirError) {
          if (trialErrnoCode(mkdirError) !== 'EEXIST') throw mkdirError;
        }
        currentFd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      } else if (trialErrnoCode(error) === 'ELOOP') {
        throw new ArtifactIntegrityError('ARTIFACT_REPARSE_POINT', 'trial directory became a symbolic link or junction', absolute);
      } else {
        throw new ArtifactIntegrityError('ARTIFACT_PARENT_CHANGED', 'trial directory could not be opened safely', absolute);
      }
    }
    if (previousFd !== root.descriptor && previousFd !== currentFd) {
      try { fs.closeSync(previousFd); } catch { /* preserve the newly opened directory */ }
    }
    if (currentFd !== root.descriptor) {
      currentPath = `/proc/self/fd/${currentFd}`;
    }
  }
  const parentSnapshots = [
    ...trialCaptureParents(root, absolute),
    { path: absolute, identity: trialCaptureIdentity(absolute, 'ARTIFACT_PARENT_CHANGED') },
  ];
  return { path: currentPath, descriptor: currentFd === root.descriptor ? null : currentFd, snapshots: parentSnapshots };
}

function trialCloseDirectory(handle: TrialDirectoryHandle): void {
  if (handle.descriptor !== null) {
    try { fs.closeSync(handle.descriptor); } catch { /* preserve operation result */ }
  }
}

function trialBufferToUtf8(buffer: Buffer, field: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch {
    fail(`${field} is not valid UTF-8`);
  }
}

export function readTrialFileBounded(root: TrialFilesystemRoot, filePath: string, maximumBytes: number, field: string): { bytes: Buffer; text: string; byteSize: number } {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) fail(`${field} has an invalid byte limit`);
  const absolute = path.resolve(filePath);
  const parent = path.dirname(absolute);
  const snapshots = trialCaptureParents(root, absolute);
  const handle = trialOpenDirectory(root, parent, false);
  let fd: number | undefined;
  try {
    const leaf = root.descriptorPath && handle.path.startsWith('/proc/self/fd/')
      ? path.posix.join(handle.path, path.basename(absolute))
      : absolute;
    const stat = fs.lstatSync(leaf);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new ArtifactIntegrityError('ARTIFACT_REPARSE_POINT', `${field} is not a regular file`, absolute);
    }
    if (stat.size > maximumBytes) fail(`${field} exceeds the configured byte limit`);
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(leaf, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd);
    if (trialIdentityKey(opened) !== trialIdentityKey(stat)) {
      throw new ArtifactIntegrityError('ARTIFACT_PATH_UNVERIFIED', `${field} identity changed before opening`, absolute);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const chunkSize = Math.min(64 * 1024, maximumBytes + 1);
    while (total <= maximumBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(chunkSize, maximumBytes + 1 - total));
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      chunks.push(buffer.subarray(0, count));
      total += count;
      if (total > maximumBytes) fail(`${field} exceeds the configured byte limit`);
    }
    const bytes = Buffer.concat(chunks, total);
    trialVerifyParents(root, snapshots);
    return { bytes, text: trialBufferToUtf8(bytes, field), byteSize: total };
  } catch (error: unknown) {
    if (error instanceof ArtifactIntegrityError || (error instanceof Error && error.message.startsWith('TRIAL_LOG_COLLECTION_INVALID:'))) throw error;
    if (trialErrnoCode(error) === 'ENOENT') throw new ArtifactIntegrityError('ARTIFACT_PATH_UNVERIFIED', `${field} is missing`, absolute);
    throw new ArtifactIntegrityError('ARTIFACT_PATH_UNVERIFIED', `${field} could not be read safely`, absolute);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* preserve read result */ }
    }
    trialCloseDirectory(handle);
  }
}

function trialWriteAll(fd: number, payload: Buffer): void {
  let offset = 0;
  while (offset < payload.length) {
    const written = fs.writeSync(fd, payload, offset, payload.length - offset);
    if (written <= 0) throw new Error('WRITE_NO_PROGRESS');
    offset += written;
  }
}

function trialSafeUnlink(root: TrialFilesystemRoot, target: string, expectedKey?: string): void {
  const absolute = path.resolve(target);
  const parent = path.dirname(absolute);
  const handle = trialOpenDirectory(root, parent, false);
  try {
    const leaf = root.descriptorPath && handle.path.startsWith('/proc/self/fd/')
      ? path.posix.join(handle.path, path.basename(absolute))
      : absolute;
    let stat: fs.Stats;
    try { stat = fs.lstatSync(leaf); } catch (error) {
      if (trialErrnoCode(error) === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || (expectedKey && trialIdentityKey(stat) !== expectedKey)) {
      throw new ArtifactIntegrityError('ARTIFACT_PATH_UNVERIFIED', 'temporary trial file identity changed before cleanup', absolute);
    }
    fs.unlinkSync(leaf);
    trialVerifyParents(root, handle.snapshots);
  } finally {
    trialCloseDirectory(handle);
  }
}

export function ensureTrialDirectory(root: TrialFilesystemRoot, directory: string): void {
  const handle = trialOpenDirectory(root, path.resolve(directory), true);
  try { trialVerifyParents(root, handle.snapshots); } finally { trialCloseDirectory(handle); }
}

export function writeTrialFileAtomic(root: TrialFilesystemRoot, outputPath: string, payload: Buffer, maximumBytes: number, field: string): void {
  if (payload.byteLength > maximumBytes) fail(`${field} exceeds the configured byte limit`);
  const absolute = path.resolve(outputPath);
  const parent = path.dirname(absolute);
  ensureTrialDirectory(root, parent);
  const before = (() => {
    try { return readTrialFileBounded(root, absolute, maximumBytes, field); } catch (error) {
      if (error instanceof ArtifactIntegrityError && /missing/i.test(error.message)) return undefined;
      if (error instanceof ArtifactIntegrityError && error.code === 'ARTIFACT_PATH_UNVERIFIED' && /missing/i.test(error.message)) return undefined;
      throw error;
    }
  })();
  if (before) {
    if (!before.bytes.equals(payload)) fail(`${field} already exists with a different digest`);
    return;
  }

  const temporaryPath = `${absolute}.tmp-${crypto.randomUUID()}`;
  const handle = trialOpenDirectory(root, parent, false);
  let fd: number | undefined;
  let temporaryKey: string | undefined;
  try {
    const leaf = root.descriptorPath && handle.path.startsWith('/proc/self/fd/')
      ? path.posix.join(handle.path, path.basename(temporaryPath))
      : temporaryPath;
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(leaf, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    temporaryKey = trialIdentityKey(fs.fstatSync(fd));
    trialWriteAll(fd, payload);
    fs.fsyncSync(fd);
  } catch (error: unknown) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* preserve original failure */ }
      fd = undefined;
    }
    try { if (temporaryKey) trialSafeUnlink(root, temporaryPath, temporaryKey); } catch { /* preserve original failure */ }
    if (error instanceof ArtifactIntegrityError) throw error;
    throw new ArtifactIntegrityError('ARTIFACT_ATOMIC_PUBLISH_UNAVAILABLE', `${field} temporary file could not be created safely`, temporaryPath);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* preserve write result */ }
    }
  }

  try {
    const temporaryLeaf = root.descriptorPath && handle.path.startsWith('/proc/self/fd/')
      ? path.posix.join(handle.path, path.basename(temporaryPath))
      : temporaryPath;
    const finalLeaf = root.descriptorPath && handle.path.startsWith('/proc/self/fd/')
      ? path.posix.join(handle.path, path.basename(absolute))
      : absolute;
    try {
      fs.linkSync(temporaryLeaf, finalLeaf);
    } catch (error: unknown) {
      if (trialErrnoCode(error) !== 'EEXIST') {
        const code = trialErrnoCode(error);
        if (code === 'ENOSYS' || code === 'EOPNOTSUPP' || code === 'EXDEV' || code === 'EPERM') {
          throw new ArtifactIntegrityError('ARTIFACT_ATOMIC_PUBLISH_UNAVAILABLE', `${field} atomic no-replace publication is unavailable`, absolute);
        }
        throw error;
      }
      const existing = readTrialFileBounded(root, absolute, maximumBytes, field);
      if (!existing.bytes.equals(payload)) fail(`${field} already exists with a different digest`);
      trialSafeUnlink(root, temporaryPath, temporaryKey);
      return;
    }
    // A nested directory handle can be synced directly.  For files directly
    // below the anchored root, the root descriptor is the directory handle;
    // keep it open for the lifetime of the operation and sync it here instead
    // of closing it through `trialCloseDirectory`.
    const directoryDescriptor = handle.descriptor ?? root.descriptor;
    if (directoryDescriptor !== null) {
      try { fs.fsyncSync(directoryDescriptor); } catch {
        throw new ArtifactIntegrityError('ARTIFACT_ATOMIC_PUBLISH_UNAVAILABLE', `${field} directory metadata could not be synchronized`, absolute);
      }
    }
    trialSafeUnlink(root, temporaryPath, temporaryKey);
    trialVerifyParents(root, handle.snapshots);
    const written = readTrialFileBounded(root, absolute, maximumBytes, field);
    if (!written.bytes.equals(payload)) {
      throw new ArtifactIntegrityError('ARTIFACT_PATH_UNVERIFIED', `${field} changed after atomic publication`, absolute);
    }
  } catch (error: unknown) {
    try { trialSafeUnlink(root, temporaryPath, temporaryKey); } catch { /* preserve original integrity failure */ }
    if (error instanceof ArtifactIntegrityError || (error instanceof Error && error.message.startsWith('TRIAL_LOG_COLLECTION_INVALID:'))) throw error;
    throw new ArtifactIntegrityError('ARTIFACT_ATOMIC_PUBLISH_UNAVAILABLE', `${field} atomic publication failed`, absolute);
  } finally {
    trialCloseDirectory(handle);
  }
}

function fail(message: string): never {
  throw new Error(`TRIAL_LOG_COLLECTION_INVALID: ${message}`);
}

function isWindowsPath(): boolean {
  return process.platform === 'win32';
}

function comparablePath(value: string): string {
  return isWindowsPath() ? value.toLowerCase() : value;
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(comparablePath(root), comparablePath(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeRelativePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    fail(`${field} must be a non-empty path of at most 512 characters`);
  }
  const normalized = value.replace(/\\/g, '/');
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.includes('\u0000')
  ) {
    fail(`${field} must be relative to the runtime root`);
  }
  const parts = normalized.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    fail(`${field} contains an empty, dot, or traversal segment`);
  }
  return parts.join('/');
}

function validateTimestamp(value: unknown): string {
  if (value === undefined) return new Date().toISOString();
  if (typeof value !== 'string' || value.length > 64) {
    fail('collectedAt must be a canonical ISO timestamp');
  }
  let canonical: string;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    fail('collectedAt must be a canonical ISO timestamp');
  }
  if (canonical !== value) fail('collectedAt must be a canonical ISO timestamp');
  return value;
}

function validateLimits(options: CollectRedactedTrialLogsOptions): BoundedLimits {
  const maxFiles = options.maxFiles ?? REDACTED_LOG_DEFAULT_MAX_FILES;
  const maxBytesPerFile = options.maxBytesPerFile ?? REDACTED_LOG_DEFAULT_MAX_BYTES_PER_FILE;
  const maxTotalBytes = options.maxTotalBytes ?? REDACTED_LOG_DEFAULT_MAX_TOTAL_BYTES;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > REDACTED_LOG_MAX_FILES) {
    fail(`maxFiles must be an integer from 1 through ${REDACTED_LOG_MAX_FILES}`);
  }
  if (!Number.isSafeInteger(maxBytesPerFile) || maxBytesPerFile < 1 || maxBytesPerFile > REDACTED_LOG_MAX_BYTES_PER_FILE) {
    fail(`maxBytesPerFile must be an integer from 1 through ${REDACTED_LOG_MAX_BYTES_PER_FILE}`);
  }
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > REDACTED_LOG_MAX_TOTAL_BYTES) {
    fail(`maxTotalBytes must be an integer from 1 through ${REDACTED_LOG_MAX_TOTAL_BYTES}`);
  }
  if (maxBytesPerFile > maxTotalBytes) fail('maxBytesPerFile cannot exceed maxTotalBytes');
  return { maxFiles, maxBytesPerFile, maxTotalBytes };
}

function ensureOutputPath(root: TrialFilesystemRoot, relativePath: string): string {
  const outputPath = path.resolve(root.baseDir, relativePath);
  try { assertPathContained(outputPath, root.baseDir); } catch {
    fail('output path escapes runtime root');
  }
  if (fs.existsSync(outputPath)) {
    const stat = fs.lstatSync(outputPath);
    if (stat.isSymbolicLink()) fail('output path is a symbolic link or junction');
    if (!stat.isFile()) fail('output path must be a regular file');
  }
  return outputPath;
}

function secureDirectoryEntries(root: TrialFilesystemRoot, directory: string, field: string): fs.Dirent[] {
  const handle = trialOpenDirectory(root, directory, false);
  try {
    const entries = fs.readdirSync(handle.path, { withFileTypes: true });
    trialVerifyParents(root, handle.snapshots);
    return entries.sort((left, right) => left.name.localeCompare(right.name));
  } catch (error: unknown) {
    if (error instanceof ArtifactIntegrityError) throw error;
    throw new ArtifactIntegrityError('ARTIFACT_PATH_UNVERIFIED', field + ' could not be enumerated safely', directory);
  } finally {
    trialCloseDirectory(handle);
  }
}

function securePathType(root: TrialFilesystemRoot, target: string, field: string): 'file' | 'directory' {
  const absolute = path.resolve(target);
  const parent = path.dirname(absolute);
  const snapshots = trialCaptureParents(root, absolute);
  const handle = trialOpenDirectory(root, parent, false);
  try {
    const leaf = root.descriptorPath && handle.path.startsWith('/proc/self/fd/')
      ? path.posix.join(handle.path, path.basename(absolute))
      : absolute;
    const stat = fs.lstatSync(leaf);
    if (stat.isSymbolicLink()) fail(field + ' is a symbolic link or junction');
    if (stat.isFile()) {
      trialVerifyParents(root, snapshots);
      return 'file';
    }
    if (stat.isDirectory()) {
      trialVerifyParents(root, snapshots);
      return 'directory';
    }
    fail(field + ' is not a regular file or directory');
  } catch (error: unknown) {
    if (error instanceof ArtifactIntegrityError || (error instanceof Error && error.message.startsWith('TRIAL_LOG_COLLECTION_INVALID:'))) throw error;
    throw new ArtifactIntegrityError('ARTIFACT_PATH_UNVERIFIED', field + ' cannot be inspected safely', absolute);
  } finally {
    trialCloseDirectory(handle);
  }
}

function enumerateFiles(root: TrialFilesystemRoot, relativePath: string, outputPath: string, limits: BoundedLimits, files: string[]): void {
  const absolutePath = path.join(root.baseDir, relativePath);
  const kind = securePathType(root, absolutePath, 'input path ' + relativePath);
  if (kind === 'file') {
    if (path.resolve(absolutePath) === path.resolve(outputPath)) fail('output path cannot also be an input log');
    files.push(relativePath);
    if (files.length > limits.maxFiles) fail('input contains more than ' + limits.maxFiles + ' files');
    return;
  }
  if (isContained(absolutePath, outputPath)) fail('output path cannot be inside an input directory');
  const entries = secureDirectoryEntries(root, absolutePath, 'input path ' + relativePath);
  for (const entry of entries) {
    const childRelative = relativePath + '/' + entry.name;
    const childAbsolute = path.join(root.baseDir, childRelative);
    if (entry.isSymbolicLink()) fail('input path ' + childRelative + ' is a symbolic link or junction');
    if (entry.isDirectory()) {
      enumerateFiles(root, childRelative, outputPath, limits, files);
    } else if (entry.isFile()) {
      securePathType(root, childAbsolute, 'input path ' + childRelative);
      if (path.resolve(childAbsolute) === path.resolve(outputPath)) fail('output path cannot also be an input log');
      files.push(childRelative);
      if (files.length > limits.maxFiles) fail('input contains more than ' + limits.maxFiles + ' files');
    } else {
      fail('input path ' + childRelative + ' is not a regular file');
    }
  }
}

function canonicalizeCollection(collection: RedactedTrialLogCollection): string {
  return JSON.stringify({
    schemaVersion: collection.schemaVersion,
    collectedAt: collection.collectedAt,
    files: collection.files.map((entry) => ({
      relativePath: entry.relativePath,
      contentType: entry.contentType,
      content: entry.content,
      byteSize: entry.byteSize,
      sha256: entry.sha256,
      redacted: entry.redacted,
    })),
    totalByteSize: collection.totalByteSize,
  });
}

function hashBytes(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Collects and atomically writes redacted logs beneath `rootDir`.
 *
 * The operation is synchronous by design: a trial evidence capture is a
 * bounded operator action, and synchronous reads make the byte limits and
 * deterministic ordering auditable.
 */
export function collectRedactedTrialLogs(options: CollectRedactedTrialLogsOptions): RedactedTrialLogCollectionResult {
  const secureRoot = openTrialFilesystemRoot(options.rootDir);
  const root = secureRoot.baseDir;
  try {
  const limits = validateLimits(options);
  if (!Array.isArray(options.inputRelativePaths) || options.inputRelativePaths.length === 0 || options.inputRelativePaths.length > limits.maxFiles) {
    fail(`inputRelativePaths must contain between 1 and ${limits.maxFiles} entries`);
  }
  const inputPaths = [...new Set(options.inputRelativePaths.map((value, index) => normalizeRelativePath(value, `inputRelativePaths[${index}]`)))].sort();
  const outputRelativePath = normalizeRelativePath(options.outputRelativePath, 'outputRelativePath');
  const outputPath = ensureOutputPath(secureRoot, outputRelativePath);
  const files: string[] = [];
  for (const relativePath of inputPaths) enumerateFiles(secureRoot, relativePath, outputPath, limits, files);
  const uniqueFiles = [...new Set(files)].sort();
  if (uniqueFiles.length > limits.maxFiles) fail(`input contains more than ${limits.maxFiles} files`);

  let totalSourceBytes = 0;
  const entries: RedactedTrialLogEntry[] = [];
  for (const relativePath of uniqueFiles) {
    const absolutePath = path.join(root, relativePath);
    const raw = readTrialFileBounded(secureRoot, absolutePath, limits.maxBytesPerFile, `input path ${relativePath}`);
    if (totalSourceBytes > limits.maxTotalBytes - raw.byteSize) fail('input logs exceed the configured total byte limit');
    totalSourceBytes += raw.byteSize;
    const sanitized = redactTrialEvidenceText(sanitizeAutonomyText(raw.text, limits.maxBytesPerFile));
    const sanitizedByteSize = Buffer.byteLength(sanitized, 'utf8');
    if (sanitizedByteSize > limits.maxBytesPerFile) fail(`redacted input path ${relativePath} exceeds the configured byte limit`);
    entries.push({
      relativePath,
      contentType: 'text/plain',
      content: sanitized,
      byteSize: sanitizedByteSize,
      sha256: hashBytes(sanitized),
      redacted: true,
    });
  }
  const collection: RedactedTrialLogCollection = {
    schemaVersion: REDACTED_LOG_COLLECTION_SCHEMA_VERSION,
    collectedAt: validateTimestamp(options.collectedAt),
    files: entries,
    totalByteSize: entries.reduce((sum, entry) => sum + entry.byteSize, 0),
  };
  const canonicalJson = canonicalizeCollection(collection);
  const payload = Buffer.from(`${canonicalJson}\n`, 'utf8');
  if (payload.byteLength > REDACTED_LOG_MAX_OUTPUT_BYTES) fail(`collection output exceeds ${REDACTED_LOG_MAX_OUTPUT_BYTES} bytes`);
  const sha256 = hashBytes(payload);
  writeTrialFileAtomic(secureRoot, outputPath, payload, REDACTED_LOG_MAX_OUTPUT_BYTES, 'collection output');
  return { collection, canonicalJson, filePath: outputPath, sha256, byteSize: payload.byteLength };
  } finally {
    closeTrialFilesystemRoot(secureRoot);
  }
}

/** Strictly validates a collector result read from disk and returns its digest. */
export function verifyRedactedTrialLogCollectionFile(filePath: string, rootDir: string): { collection: RedactedTrialLogCollection; sha256: string; byteSize: number } {
  const secureRoot = openTrialFilesystemRoot(rootDir);
  try {
  const raw = readTrialFileBounded(secureRoot, path.resolve(filePath), REDACTED_LOG_MAX_OUTPUT_BYTES, 'collection output');
  let parsed: unknown;
  try { parsed = JSON.parse(raw.text); } catch { fail('collection output is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('collection output must be an object');
  const collection = parsed as RedactedTrialLogCollection;
  const collectionKeys = Object.keys(collection as object).sort();
  if (collectionKeys.join(',') !== 'collectedAt,files,schemaVersion,totalByteSize' || collection.schemaVersion !== REDACTED_LOG_COLLECTION_SCHEMA_VERSION || !Array.isArray(collection.files)) fail('collection schema is unsupported');
  if (collection.files.length > REDACTED_LOG_MAX_FILES || typeof collection.collectedAt !== 'string' || validateTimestamp(collection.collectedAt) !== collection.collectedAt || !Number.isSafeInteger(collection.totalByteSize) || collection.totalByteSize < 0) {
    fail('collection metadata is malformed');
  }
  const canonicalJson = canonicalizeCollection(collection);
  if (raw.text !== `${canonicalJson}\n`) fail('collection output is not canonical');
  let previousPath = '';
  let totalByteSize = 0;
  for (const entry of collection.files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('collection entry is malformed');
    const entryKeys = Object.keys(entry as object).sort();
    if (entryKeys.join(',') !== 'byteSize,content,contentType,redacted,relativePath,sha256' || entry.contentType !== 'text/plain' || entry.redacted !== true || typeof entry.content !== 'string' || typeof entry.relativePath !== 'string' || normalizeRelativePath(entry.relativePath, 'collection entry relativePath') !== entry.relativePath || entry.relativePath <= previousPath || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256) || entry.sha256 !== hashBytes(entry.content) || redactTrialEvidenceText(sanitizeAutonomyText(entry.content, REDACTED_LOG_MAX_BYTES_PER_FILE)) !== entry.content || !Number.isSafeInteger(entry.byteSize) || entry.byteSize < 0 || entry.byteSize !== Buffer.byteLength(entry.content, 'utf8') || entry.byteSize > REDACTED_LOG_MAX_BYTES_PER_FILE) {
      fail('collection entry is malformed or has an invalid digest');
    }
    previousPath = entry.relativePath;
    totalByteSize += entry.byteSize;
  }
  if (totalByteSize !== collection.totalByteSize) fail('collection totalByteSize does not match entries');
  if (totalByteSize > REDACTED_LOG_MAX_TOTAL_BYTES) fail('collection exceeds the configured total byte limit');
  return { collection, sha256: hashBytes(raw.bytes), byteSize: raw.byteSize };
  } finally {
    closeTrialFilesystemRoot(secureRoot);
  }
}
