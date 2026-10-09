import { captureRepositoryRoot, RepositoryRootError } from '../services/RepositoryRootIdentity';
import { RepositoryRootLease } from '../services/RepositoryRootLease';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import {
  ProviderAdapter,
  QuotaSnapshotInfo,
  AgentExecutionRequest,
  AgentExecutionResult,
  RuntimeErrorCode,
} from './ProviderAdapter';
import { Capability, ProviderHealthStatus, ProviderAdapterType } from '../types/domain';
import { Repository } from '../database/repositories';
import { ArtifactStore } from '../services/ArtifactStore';
import { ProcessRunner, ProcessRunResult } from '../services/ProcessRunner';
import { PolicyService } from '../services/PolicyService';
import { ProtocolParser } from '../protocol/parser';
import { NonHandoffExecutionLifecycle } from '../services/NonHandoffExecutionLifecycle';
import { OutputSanitizationError, redactSensitiveText } from '../../shared/security/secretRedaction';
import { isOutputSanitizationErrorCode, safeDiagnosticText, sanitizeErrorDiagnostics, sanitizedDiagnosticError } from '../../shared/security/outputDiagnostics';
import {
  canonicalizePortableRelativePath,
  canonicalizePortableRelativePathList,
  ContextPathError,
} from '../context/ContextIntegrity';

const LOCAL_CLI_WORKSPACE_VERSION = 1;
const LOCAL_CLI_WORKSPACE_BASE = path.join(os.tmpdir(), 'agent-forge-local-cli-workspaces');
const LOCAL_CLI_WORKSPACE_MARKER_SUFFIX = '.workspace.json';
const LOCAL_CLI_WORKSPACE_STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const LOCAL_CLI_WORKSPACE_MAX_FILES = 256;
const LOCAL_CLI_WORKSPACE_MAX_BYTES = 16 * 1024 * 1024;
const LOCAL_CLI_FILE_MAX_BYTES = 4 * 1024 * 1024;
// Directory context is provider-controlled input. Bound both the number of
// directory entries inspected and the nesting depth before materializing any
// workspace files so a hostile tree cannot exhaust memory or recursion depth.
const LOCAL_CLI_WORKSPACE_MAX_TRAVERSAL_ENTRIES = 512;
const LOCAL_CLI_WORKSPACE_MAX_TRAVERSAL_DEPTH = 128;
const LOCAL_CLI_WORKSPACE_MAX_CONTEXT_PATHS = 128;

interface LocalCliFileIdentity {
  readonly key: string;
  readonly realPath: string;
}

interface LocalCliWorkspaceEntry {
  readonly relativePath: string;
  readonly sourcePath: string;
  readonly sourceIdentity: LocalCliFileIdentity;
  readonly sourceMode: number;
  readonly sourceHash: string;
  readonly byteSize: number;
}

interface LocalCliWorkspaceLease {
  readonly executionId: string;
  readonly ownerToken: string;
  readonly ownershipDigest: string;
  readonly sourceRoot: string;
  readonly workspaceRoot: string;
  readonly workspaceIdentity: LocalCliFileIdentity;
  readonly markerPath: string;
  readonly entries: ReadonlyArray<LocalCliWorkspaceEntry>;
}

interface LocalCliWorkspaceMarker {
  version: number;
  executionId: string;
  ownerToken: string;
  workspaceName: string;
  workspaceIdentityKey?: string;
  workspaceIdentityRealPath?: string;
  ownershipDigest: string;
  createdAt: string;
  state: 'ACTIVE' | 'CLEANING' | 'CLEANUP_FAILED';
}

export interface LocalCliWorkspaceRecoveryResult {
  recovered: string[];
  skipped: string[];
  failed: string[];
}

export class LocalCliWorkspaceError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'LocalCliWorkspaceError';
    this.code = code;
  }
}

const activeLocalCliWorkspaces = new Set<string>();
const recoveringLocalCliMarkers = new Set<string>();

function localCliErrno(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? String((error as { code: string }).code)
    : undefined;
}

function localCliIsMissing(error: unknown): boolean {
  return localCliErrno(error) === 'ENOENT';
}

function localCliRealpath(targetPath: string): string {
  // `realpathSync.native` can mix long and 8.3 spellings on Windows when a
  // newly-created descendant is resolved through a short parent.  The
  // portable resolver gives us one stable spelling for containment checks.
  return fs.realpathSync(targetPath);
}

function localCliIdentityKey(stat: fs.Stats): string {
  const device = process.platform === 'win32' ? 'win32' : String(stat.dev);
  return `${device}:${String(stat.ino)}:${String(stat.mode & 0o170000)}`;
}

function localCliSameIdentity(left: LocalCliFileIdentity, right: LocalCliFileIdentity): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  return left.key === right.key && normalize(left.realPath) === normalize(right.realPath);
}

function localCliCaptureIdentity(targetPath: string): LocalCliFileIdentity {
  const stat = fs.lstatSync(targetPath);
  return {
    key: localCliIdentityKey(stat),
    realPath: localCliRealpath(targetPath),
  };
}

function localCliValidWorkspaceName(workspaceName: string): boolean {
  return workspaceName.length > 0
    && workspaceName !== '.'
    && workspaceName !== '..'
    && path.basename(workspaceName) === workspaceName
    && !workspaceName.includes('/')
    && !workspaceName.includes('\\')
    && /^[a-zA-Z0-9_-]+$/.test(workspaceName);
}

function localCliContained(targetPath: string, rootPath: string, allowRoot = true): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  const relative = path.relative(normalize(rootPath), normalize(targetPath));
  return (allowRoot && relative === '') || (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !relative.startsWith('../') &&
    !relative.startsWith('..\\') &&
    !path.isAbsolute(relative)
  );
}

function localCliCanonicalRelative(rawPath: string): string {
  try {
    return canonicalizePortableRelativePath(rawPath);
  } catch (error) {
    if (error instanceof ContextPathError) {
      throw new LocalCliWorkspaceError(error.code, error.message.slice(error.code.length + 2));
    }
    throw new LocalCliWorkspaceError('CONTEXT_PATH_INVALID', 'context path could not be canonicalized safely');
  }
}

function localCliPolicyOrThrow(targetPath: string, rootPath: string, relativePath: string, isWrite: boolean): void {
  let policyRoot = rootPath;
  try {
    policyRoot = localCliRealpath(rootPath);
  } catch {
    // A missing root is still covered by the lexical policy.
  }
  let policyTarget = path.resolve(policyRoot, relativePath);
  try {
    policyTarget = localCliRealpath(targetPath);
  } catch {
    // Missing final paths remain covered by the lexical policy.
  }
  const decision = PolicyService.evaluateRealPathAccess(policyTarget, policyRoot, isWrite);
  if (!decision.allowed) {
    throw new LocalCliWorkspaceError('CONTEXT_PATH_DENIED', `policy denied ${relativePath}`);
  }
}

function localCliReadStableFile(filePath: string, rootPath: string): { buffer: Buffer; identity: LocalCliFileIdentity; mode: number } {
  let relative: string;
  try {
    relative = canonicalizePortableRelativePath(path.relative(rootPath, filePath));
  } catch (error) {
    if (error instanceof ContextPathError) {
      throw new LocalCliWorkspaceError(error.code, error.message.slice(error.code.length + 2));
    }
    throw new LocalCliWorkspaceError('CONTEXT_PATH_INVALID', 'context path could not be canonicalized safely');
  }
  localCliPolicyOrThrow(filePath, rootPath, relative, false);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    throw new LocalCliWorkspaceError('CONTEXT_PATH_INVALID', `context file disappeared: ${relative}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new LocalCliWorkspaceError('CONTEXT_REPARSE_POINT', `context file is not a regular file: ${relative}`);
  }
  const realPath = localCliRealpath(filePath);
  if (!localCliContained(realPath, rootPath)) {
    throw new LocalCliWorkspaceError('CONTEXT_REPARSE_POINT', `context file escaped the authorized root: ${relative}`);
  }
  const identity = { key: localCliIdentityKey(stat), realPath };
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  if (process.platform !== 'win32' && noFollow === 0) {
    throw new LocalCliWorkspaceError('WORKSPACE_BOUNDARY_UNAVAILABLE', 'platform cannot guarantee no-follow context reads');
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (localCliIdentityKey(opened) !== identity.key || opened.size > LOCAL_CLI_FILE_MAX_BYTES) {
      throw new LocalCliWorkspaceError('CONTEXT_FILE_CHANGED', `context file changed or exceeds the bounded read limit: ${relative}`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, LOCAL_CLI_FILE_MAX_BYTES - total + 1));
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) break;
      total += read;
      if (total > LOCAL_CLI_FILE_MAX_BYTES) {
        throw new LocalCliWorkspaceError('CONTEXT_LIMIT_EXCEEDED', `context file exceeds ${LOCAL_CLI_FILE_MAX_BYTES} bytes: ${relative}`);
      }
      chunks.push(chunk.subarray(0, read));
    }
    const after = fs.fstatSync(descriptor);
    if (localCliIdentityKey(after) !== identity.key || after.size !== opened.size) {
      throw new LocalCliWorkspaceError('CONTEXT_FILE_CHANGED', `context file changed while being copied: ${relative}`);
    }
    return { buffer: Buffer.concat(chunks, total), identity, mode: stat.mode };
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the primary failure */ }
    }
  }
}

function localCliEnsureWorkspaceParent(parentPath: string, workspaceRoot: string): void {
  const relative = path.relative(workspaceRoot, parentPath);
  if (!relative || relative === '.') return;
  let current = workspaceRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    const next = path.join(current, segment);
    try {
      const stat = fs.lstatSync(next);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LocalCliWorkspaceError('WORKSPACE_REPARSE_POINT', `workspace parent is not a real directory: ${segment}`);
    } catch (error) {
      if (!localCliIsMissing(error)) throw error;
      fs.mkdirSync(next);
      const created = fs.lstatSync(next);
      if (!created.isDirectory() || created.isSymbolicLink()) throw new LocalCliWorkspaceError('WORKSPACE_REPARSE_POINT', `workspace parent creation was unsafe: ${segment}`);
    }
    current = next;
  }
}

function localCliAtomicWrite(
  filePath: string,
  content: Buffer,
  rootPath: string,
  mode?: number,
  expectedIdentity?: LocalCliFileIdentity,
): void {
  const relative = path.relative(rootPath, filePath).replace(/\\/g, '/');
  localCliPolicyOrThrow(filePath, rootPath, relative, true);
  const parent = path.dirname(filePath);
  localCliEnsureWorkspaceParent(parent, rootPath);
  const parentIdentity = localCliCaptureIdentity(parent);
  const tempPath = path.join(parent, `.agent-forge-write-${crypto.randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let complete = false;
  try {
    descriptor = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    let offset = 0;
    while (offset < content.length) {
      const written = fs.writeSync(descriptor, content, offset, content.length - offset);
      if (written <= 0) throw new LocalCliWorkspaceError('WORKSPACE_WRITE_FAILED', `no progress while writing ${relative}`);
      offset += written;
    }
    fs.fsyncSync(descriptor);
    if (mode !== undefined) fs.fchmodSync(descriptor, mode & 0o7777);
    complete = true;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve primary failure */ }
    }
    if (!complete) {
      try { fs.unlinkSync(tempPath); } catch (error) { if (!localCliIsMissing(error)) { /* preserve primary failure */ } }
    }
  }
  try {
    const currentParent = localCliCaptureIdentity(parent);
    if (!localCliSameIdentity(parentIdentity, currentParent)) {
      throw new LocalCliWorkspaceError('WORKSPACE_PARENT_CHANGED', `parent directory changed during atomic write: ${relative}`);
    }
    let targetExists = true;
    let currentTarget: LocalCliFileIdentity | undefined;
    try {
      currentTarget = localCliCaptureIdentity(filePath);
    } catch (error) {
      if (!localCliIsMissing(error)) throw error;
      targetExists = false;
    }
    if (expectedIdentity) {
      if (!targetExists || !currentTarget || !localCliSameIdentity(expectedIdentity, currentTarget)) {
        throw new LocalCliWorkspaceError('WORKSPACE_TARGET_CHANGED', `target changed during atomic write: ${relative}`);
      }
    } else if (targetExists) {
      throw new LocalCliWorkspaceError('WORKSPACE_TARGET_EXISTS', `unexpected target already exists: ${relative}`);
    }
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch (cleanupError) { if (!localCliIsMissing(cleanupError)) { /* preserve rename failure */ } }
    if (error instanceof LocalCliWorkspaceError) throw error;
    throw new LocalCliWorkspaceError('WORKSPACE_ATOMIC_RENAME_FAILED', `atomic replacement failed for ${relative}`);
  }
}

function localCliMarkerPath(basePath: string, workspaceName: string): string {
  return path.join(basePath, `${workspaceName}${LOCAL_CLI_WORKSPACE_MARKER_SUFFIX}`);
}

function localCliWriteMarker(markerPath: string, marker: LocalCliWorkspaceMarker): void {
  const parent = path.dirname(markerPath);
  const tempPath = path.join(parent, `.agent-forge-marker-${crypto.randomUUID()}.tmp`);
  const content = Buffer.from(JSON.stringify(marker), 'utf8');
  let descriptor: number | undefined;
  let complete = false;
  try {
    descriptor = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    let offset = 0;
    while (offset < content.length) {
      const written = fs.writeSync(descriptor, content, offset, content.length - offset);
      if (written <= 0) throw new LocalCliWorkspaceError('WORKSPACE_MARKER_WRITE_FAILED', 'marker write made no progress');
      offset += written;
    }
    fs.fsyncSync(descriptor);
    complete = true;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the primary failure */ }
    }
    if (!complete) {
      try { fs.unlinkSync(tempPath); } catch (error) { if (!localCliIsMissing(error)) { /* preserve primary failure */ } }
    }
  }
  try {
    fs.renameSync(tempPath, markerPath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch (cleanupError) { if (!localCliIsMissing(cleanupError)) { /* preserve rename failure */ } }
    throw error;
  }
}

function localCliReadMarker(markerPath: string): LocalCliWorkspaceMarker | null {
  try {
    const stat = fs.lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Partial<LocalCliWorkspaceMarker>;
    if (
      parsed.version !== LOCAL_CLI_WORKSPACE_VERSION ||
      typeof parsed.executionId !== 'string' ||
      typeof parsed.ownerToken !== 'string' ||
      typeof parsed.workspaceName !== 'string' ||
      ((parsed.workspaceIdentityKey !== undefined || parsed.workspaceIdentityRealPath !== undefined) &&
        (typeof parsed.workspaceIdentityKey !== 'string' ||
          parsed.workspaceIdentityKey.length === 0 ||
          typeof parsed.workspaceIdentityRealPath !== 'string' ||
          parsed.workspaceIdentityRealPath.length === 0)) ||
      typeof parsed.ownershipDigest !== 'string' ||
      typeof parsed.createdAt !== 'string' ||
      !['ACTIVE', 'CLEANING', 'CLEANUP_FAILED'].includes(String(parsed.state)) ||
      !localCliValidWorkspaceName(parsed.workspaceName)
    ) return null;
    return parsed as LocalCliWorkspaceMarker;
  } catch {
    return null;
  }
}

function localCliEnsureBase(basePath: string): void {
  fs.mkdirSync(basePath, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(basePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LocalCliWorkspaceError('WORKSPACE_BOUNDARY_INVALID', 'workspace base is not a real directory');
  if (process.platform !== 'win32') {
    try { fs.chmodSync(basePath, 0o700); } catch {
      throw new LocalCliWorkspaceError('WORKSPACE_BOUNDARY_INVALID', 'workspace base permissions could not be restricted');
    }
    const restricted = fs.lstatSync(basePath);
    if ((restricted.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && restricted.uid !== process.getuid())) {
      throw new LocalCliWorkspaceError('WORKSPACE_BOUNDARY_INVALID', 'workspace base is not private to the Agent Forge user');
    }
  }
}

export function recoverOrphanedLocalCliWorkspaces(
  basePath: string = LOCAL_CLI_WORKSPACE_BASE,
  now: number = Date.now(),
  staleAfterMs: number = LOCAL_CLI_WORKSPACE_STALE_AFTER_MS,
): LocalCliWorkspaceRecoveryResult {
  const result: LocalCliWorkspaceRecoveryResult = { recovered: [], skipped: [], failed: [] };
  try { localCliEnsureBase(basePath); } catch { return result; }
  for (const markerName of fs.readdirSync(basePath).filter((name) => name.endsWith(LOCAL_CLI_WORKSPACE_MARKER_SUFFIX))) {
    if (recoveringLocalCliMarkers.has(markerName)) {
      result.skipped.push(markerName);
      continue;
    }
    recoveringLocalCliMarkers.add(markerName);
    try {
    const markerPath = path.join(basePath, markerName);
    const marker = localCliReadMarker(markerPath);
    if (!marker || activeLocalCliWorkspaces.has(marker.executionId)) {
      result.skipped.push(markerName);
      continue;
    }
    // Bind the marker filename to the workspace named by its contents before
    // resolving any cleanup target. A forged marker must never redirect
    // recovery to a different live workspace.
    if (markerName !== path.basename(localCliMarkerPath(basePath, marker.workspaceName))) {
      result.skipped.push(markerName);
      continue;
    }
    const age = now - Date.parse(marker.createdAt);
    if (!Number.isFinite(age) || age < staleAfterMs) {
      result.skipped.push(markerName);
      continue;
    }
    const workspacePath = path.join(basePath, marker.workspaceName);
    try {
      // Markers written before identity fencing was introduced are retained
      // for manual recovery rather than being allowed to delete blindly.
      if (!marker.workspaceIdentityKey || !marker.workspaceIdentityRealPath) {
        result.skipped.push(markerName);
        continue;
      }
      const workspaceStat = fs.lstatSync(workspacePath);
      if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) throw new Error('workspace is not a real directory');
      const currentIdentity = localCliCaptureIdentity(workspacePath);
      if (!localCliSameIdentity(
        { key: marker.workspaceIdentityKey, realPath: marker.workspaceIdentityRealPath },
        currentIdentity,
      )) {
        result.skipped.push(markerName);
        continue;
      }
      fs.rmSync(workspacePath, { recursive: true, force: true });
      fs.unlinkSync(markerPath);
      result.recovered.push(marker.workspaceName);
    } catch (error) {
      // Another recovery process may have completed the same cleanup between
      // the identity check and unlink. Treat that idempotent outcome as
      // success instead of recreating a misleading failure marker.
      if (localCliIsMissing(error)) {
        result.recovered.push(marker.workspaceName);
        continue;
      }
      try { localCliWriteMarker(markerPath, { ...marker, state: 'CLEANUP_FAILED' }); } catch { /* preserve the recovery failure */ }
      result.failed.push(marker.workspaceName);
    }
    } finally {
      recoveringLocalCliMarkers.delete(markerName);
    }
  }
  return result;
}

function localCliCleanupWorkspace(lease: LocalCliWorkspaceLease): void {
  try {
    const marker = localCliReadMarker(lease.markerPath);
    if (!marker || marker.executionId !== lease.executionId || marker.ownerToken !== lease.ownerToken || marker.ownershipDigest !== lease.ownershipDigest || marker.workspaceName !== path.basename(lease.workspaceRoot)) {
      throw new LocalCliWorkspaceError('WORKSPACE_OWNERSHIP_MISMATCH', 'workspace cleanup marker did not match the active owner');
    }
    localCliWriteMarker(lease.markerPath, { ...marker, state: 'CLEANING' });
    const currentIdentity = localCliCaptureIdentity(lease.workspaceRoot);
    const stat = fs.lstatSync(lease.workspaceRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !localCliSameIdentity(lease.workspaceIdentity, currentIdentity)) throw new LocalCliWorkspaceError('WORKSPACE_REPARSE_POINT', 'workspace changed or became a reparse point before cleanup');
    fs.rmSync(lease.workspaceRoot, { recursive: true, force: true });
    fs.unlinkSync(lease.markerPath);
  } catch (error) {
    try {
      const marker = localCliReadMarker(lease.markerPath);
      if (marker) localCliWriteMarker(lease.markerPath, { ...marker, state: 'CLEANUP_FAILED' });
    } catch { /* the marker itself may be unavailable; preserve primary failure */ }
    throw error instanceof LocalCliWorkspaceError
      ? error
      : new LocalCliWorkspaceError('WORKSPACE_CLEANUP_FAILED', 'workspace cleanup failed');
  } finally {
    activeLocalCliWorkspaces.delete(lease.executionId);
  }
}

function localCliCollectContextFiles(sourceRoot: string, contextFiles: string[]): LocalCliWorkspaceEntry[] {
  if (contextFiles.length > LOCAL_CLI_WORKSPACE_MAX_CONTEXT_PATHS) {
    throw new LocalCliWorkspaceError('CONTEXT_LIMIT_EXCEEDED', 'authorized context contains too many paths');
  }
  const realRoot = localCliRealpath(sourceRoot);
  const discovered = new Map<string, LocalCliWorkspaceEntry>();
  let discoveredBytes = 0;
  let traversalEntries = 0;
  const add = (absolutePath: string, explicit: boolean, depth: number): void => {
    if (depth > LOCAL_CLI_WORKSPACE_MAX_TRAVERSAL_DEPTH) {
      throw new LocalCliWorkspaceError('CONTEXT_LIMIT_EXCEEDED', 'authorized context exceeds the directory nesting limit');
    }
    let relative: string;
    try {
      // Canonicalize before lstat/realpath/policy work for this entry.  The
      // directory name came from the filesystem, but it still crosses the
      // manifest boundary and must obey exactly the same portable rules as an
      // explicitly supplied path.
      relative = canonicalizePortableRelativePath(path.relative(sourceRoot, absolutePath));
    } catch (error) {
      if (error instanceof ContextPathError) {
        throw new LocalCliWorkspaceError(error.code, error.message.slice(error.code.length + 2));
      }
      throw new LocalCliWorkspaceError('CONTEXT_PATH_INVALID', 'context path could not be canonicalized safely');
    }
    let stat: fs.Stats;
    try { stat = fs.lstatSync(absolutePath); } catch (error) { if (localCliIsMissing(error)) return; throw error; }
    if (stat.isSymbolicLink()) throw new LocalCliWorkspaceError('CONTEXT_REPARSE_POINT', `symbolic link context is forbidden: ${relative}`);
    try { localCliPolicyOrThrow(absolutePath, realRoot, relative, false); } catch (error) {
      if (!explicit && error instanceof LocalCliWorkspaceError && error.code === 'CONTEXT_PATH_DENIED') return;
      throw error;
    }
    const resolved = localCliRealpath(absolutePath);
    if (!localCliContained(resolved, realRoot)) throw new LocalCliWorkspaceError('CONTEXT_REPARSE_POINT', `context escaped the source root: ${relative}`);
    if (stat.isDirectory()) {
      const children: string[] = [];
      const directory = fs.opendirSync(absolutePath);
      try {
        while (true) {
          const entry = directory.readSync();
          if (entry === null) break;
          traversalEntries += 1;
          if (traversalEntries > LOCAL_CLI_WORKSPACE_MAX_TRAVERSAL_ENTRIES) {
            throw new LocalCliWorkspaceError('CONTEXT_LIMIT_EXCEEDED', 'authorized context exceeds the directory entry limit');
          }
          children.push(entry.name);
        }
      } finally {
        directory.closeSync();
      }
      for (const child of children.sort()) add(path.join(absolutePath, child), false, depth + 1);
      return;
    }
    if (!stat.isFile()) return;
    const file = localCliReadStableFile(absolutePath, realRoot);
    const key = process.platform === 'win32' ? relative.toLowerCase() : relative;
    if (!discovered.has(key)) {
      if (
        discovered.size >= LOCAL_CLI_WORKSPACE_MAX_FILES ||
        discoveredBytes + file.buffer.byteLength > LOCAL_CLI_WORKSPACE_MAX_BYTES
      ) {
        throw new LocalCliWorkspaceError('CONTEXT_LIMIT_EXCEEDED', 'authorized context exceeds the bounded workspace limit');
      }
      discoveredBytes += file.buffer.byteLength;
      discovered.set(key, {
        relativePath: relative,
        sourcePath: absolutePath,
        sourceIdentity: file.identity,
        sourceMode: file.mode,
        sourceHash: crypto.createHash('sha256').update(file.buffer).digest('hex'),
        byteSize: file.buffer.byteLength,
      });
    }
  };

  const caseInsensitivePaths = new Map<string, string>();
  for (const rawPath of contextFiles) {
    const relative = localCliCanonicalRelative(rawPath);
    if (process.platform === 'win32' || process.platform === 'darwin') {
      const folded = relative.toLocaleLowerCase('en-US');
      const prior = caseInsensitivePaths.get(folded);
      if (prior !== undefined && prior !== relative) {
        throw new LocalCliWorkspaceError('CONTEXT_PATH_ALIAS', 'case-colliding context path aliases are not allowed on this filesystem');
      }
      caseInsensitivePaths.set(folded, relative);
    }
    const absolute = path.resolve(sourceRoot, relative);
    if (!localCliContained(absolute, sourceRoot)) throw new LocalCliWorkspaceError('CONTEXT_PATH_INVALID', `context escaped the source root: ${relative}`);
    localCliPolicyOrThrow(absolute, realRoot, relative, false);
    try { fs.lstatSync(absolute); } catch (error) { if (localCliIsMissing(error)) continue; throw error; }
    add(absolute, true, relative.split('/').filter(Boolean).length);
  }
  return [...discovered.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function localCliPrepareWorkspace(
  sourceRoot: string,
  contextFiles: string[],
  executionId: string,
  ownershipDigest: string,
): LocalCliWorkspaceLease {
  const absoluteSourceRoot = path.resolve(sourceRoot);
  const sourceStat = fs.lstatSync(absoluteSourceRoot);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new LocalCliWorkspaceError('WORKSPACE_BOUNDARY_INVALID', 'source root is not a real directory');
  const sourceRealRoot = localCliRealpath(absoluteSourceRoot);
  localCliPolicyOrThrow(sourceRealRoot, sourceRealRoot, '.', false);
  const entries = localCliCollectContextFiles(sourceRealRoot, contextFiles);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.byteSize, 0);
  if (totalBytes > LOCAL_CLI_WORKSPACE_MAX_BYTES) throw new LocalCliWorkspaceError('CONTEXT_LIMIT_EXCEEDED', `authorized context exceeds ${LOCAL_CLI_WORKSPACE_MAX_BYTES} bytes`);
  localCliEnsureBase(LOCAL_CLI_WORKSPACE_BASE);
  recoverOrphanedLocalCliWorkspaces();
  const ownerToken = crypto.randomUUID();
  const safeExecutionId = executionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const workspaceName = `${safeExecutionId}-${crypto.randomUUID()}`;
  const workspaceRoot = path.join(LOCAL_CLI_WORKSPACE_BASE, workspaceName);
  const markerPath = localCliMarkerPath(LOCAL_CLI_WORKSPACE_BASE, workspaceName);
  let workspaceIdentity: LocalCliFileIdentity | undefined;
  try {
    fs.mkdirSync(workspaceRoot, { recursive: false, mode: 0o700 });
    workspaceIdentity = localCliCaptureIdentity(workspaceRoot);
    const marker: LocalCliWorkspaceMarker = {
      version: LOCAL_CLI_WORKSPACE_VERSION,
      executionId,
      ownerToken,
      workspaceName,
      workspaceIdentityKey: workspaceIdentity.key,
      workspaceIdentityRealPath: workspaceIdentity.realPath,
      ownershipDigest,
      createdAt: new Date().toISOString(),
      state: 'ACTIVE',
    };
    localCliWriteMarker(markerPath, marker);
    activeLocalCliWorkspaces.add(executionId);
    let copiedBytes = 0;
    for (const entry of entries) {
      const source = localCliReadStableFile(entry.sourcePath, sourceRealRoot);
      copiedBytes += source.buffer.byteLength;
      if (copiedBytes > LOCAL_CLI_WORKSPACE_MAX_BYTES) {
        throw new LocalCliWorkspaceError('CONTEXT_LIMIT_EXCEEDED', `authorized context exceeds ${LOCAL_CLI_WORKSPACE_MAX_BYTES} bytes while being copied`);
      }
      const target = path.join(workspaceRoot, entry.relativePath);
      localCliEnsureWorkspaceParent(path.dirname(target), workspaceRoot);
      localCliAtomicWrite(target, source.buffer, workspaceRoot, entry.sourceMode);
    }
    return { executionId, ownerToken, ownershipDigest, sourceRoot: sourceRealRoot, workspaceRoot, workspaceIdentity, markerPath, entries };
  } catch (error) {
    activeLocalCliWorkspaces.delete(executionId);
    let cleanupFailed = false;
    if (workspaceIdentity) {
      try {
        const currentIdentity = localCliCaptureIdentity(workspaceRoot);
        if (!localCliSameIdentity(workspaceIdentity, currentIdentity)) {
          throw new LocalCliWorkspaceError('WORKSPACE_REPARSE_POINT', 'workspace changed during preparation cleanup');
        }
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
      } catch {
        cleanupFailed = true;
      }
    } else {
      // If identity capture itself failed, do not remove by path alone. Keep
      // a cleanup-failed marker so recovery can be reviewed manually without
      // risking deletion of a replacement directory.
      cleanupFailed = true;
    }
    if (!cleanupFailed) {
      try {
        fs.unlinkSync(markerPath);
      } catch (cleanupError) {
        if (!localCliIsMissing(cleanupError)) cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      try {
        const marker = localCliReadMarker(markerPath);
        if (marker) {
          localCliWriteMarker(markerPath, { ...marker, state: 'CLEANUP_FAILED' });
        } else if (fs.existsSync(workspaceRoot)) {
          localCliWriteMarker(markerPath, {
            version: LOCAL_CLI_WORKSPACE_VERSION,
            executionId,
            ownerToken,
            workspaceName,
            workspaceIdentityKey: workspaceIdentity?.key,
            workspaceIdentityRealPath: workspaceIdentity?.realPath,
            ownershipDigest,
            createdAt: new Date().toISOString(),
            state: 'CLEANUP_FAILED',
          });
        }
      } catch { /* preserve the original preparation failure */ }
    }
    throw error instanceof LocalCliWorkspaceError ? error : new LocalCliWorkspaceError('WORKSPACE_PREPARE_FAILED', 'could not prepare isolated workspace');
  }
}

function localCliSynchronizeWorkspace(lease: LocalCliWorkspaceLease): void {
  const pending: Array<{
    entry: LocalCliWorkspaceEntry;
    sourceBuffer: Buffer;
    sourceHash: string;
    sourceMode: number;
    workspaceBuffer: Buffer;
    workspaceHash: string;
  }> = [];

  // Preflight every authorized source and workspace entry before writing any
  // source file. A later conflict must not leave an earlier entry partially
  // synchronized when the overall execution is rejected.
  for (const entry of lease.entries) {
    const sourceRoot = localCliRealpath(lease.sourceRoot);
    const current = localCliReadStableFile(entry.sourcePath, sourceRoot);
    if (!localCliSameIdentity(entry.sourceIdentity, current.identity) || crypto.createHash('sha256').update(current.buffer).digest('hex') !== entry.sourceHash) {
      throw new LocalCliWorkspaceError('WORKSPACE_SYNC_CONFLICT', `authorized source changed during execution: ${entry.relativePath}`);
    }
    const workspacePath = path.join(lease.workspaceRoot, entry.relativePath);
    const workspace = localCliReadStableFile(workspacePath, lease.workspaceRoot);
    const workspaceHash = crypto.createHash('sha256').update(workspace.buffer).digest('hex');
    if (workspaceHash === entry.sourceHash) continue;
    pending.push({
      entry,
      sourceBuffer: current.buffer,
      sourceHash: entry.sourceHash,
      sourceMode: current.mode,
      workspaceBuffer: workspace.buffer,
      workspaceHash,
    });
  }

  const applied: Array<{ item: typeof pending[number]; appliedIdentity: LocalCliFileIdentity }> = [];
  try {
    for (const item of pending) {
      const { entry } = item;
      const sourceRoot = localCliRealpath(lease.sourceRoot);
      const current = localCliReadStableFile(entry.sourcePath, sourceRoot);
      if (!localCliSameIdentity(entry.sourceIdentity, current.identity) || crypto.createHash('sha256').update(current.buffer).digest('hex') !== entry.sourceHash) {
        throw new LocalCliWorkspaceError('WORKSPACE_SYNC_CONFLICT', `authorized source changed during execution: ${entry.relativePath}`);
      }
      localCliAtomicWrite(entry.sourcePath, item.workspaceBuffer, sourceRoot, entry.sourceMode, entry.sourceIdentity);
      // Atomic replacement intentionally creates a new file identity. Keep
      // that identity so rollback can fence against a concurrent replacement
      // without incorrectly comparing it to the pre-execution inode.
      const appliedIdentity = localCliCaptureIdentity(entry.sourcePath);
      applied.push({ item, appliedIdentity });
      const verified = localCliReadStableFile(entry.sourcePath, sourceRoot);
      if (crypto.createHash('sha256').update(verified.buffer).digest('hex') !== item.workspaceHash) {
        throw new LocalCliWorkspaceError('WORKSPACE_SYNC_FAILED', `authorized source could not be verified after synchronization: ${entry.relativePath}`);
      }
    }
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const { item, appliedIdentity } of [...applied].reverse()) {
      try {
        const sourceRoot = localCliRealpath(lease.sourceRoot);
        const current = localCliReadStableFile(item.entry.sourcePath, sourceRoot);
        const currentHash = crypto.createHash('sha256').update(current.buffer).digest('hex');
        if (!localCliSameIdentity(appliedIdentity, current.identity)) {
          throw new LocalCliWorkspaceError('WORKSPACE_SYNC_ROLLBACK_CONFLICT', `authorized source identity changed during rollback: ${item.entry.relativePath}`);
        }
        if ((current.mode & 0o7777) !== (item.sourceMode & 0o7777)) {
          throw new LocalCliWorkspaceError('WORKSPACE_SYNC_ROLLBACK_CONFLICT', `authorized source mode changed during rollback: ${item.entry.relativePath}`);
        }
        // A concurrent writer owns the file once its content no longer matches
        // the provider result. Never overwrite that newer content while trying
        // to restore an earlier entry.
        if (currentHash === item.sourceHash) continue;
        if (currentHash !== item.workspaceHash) {
          throw new LocalCliWorkspaceError('WORKSPACE_SYNC_ROLLBACK_CONFLICT', `authorized source changed during rollback: ${item.entry.relativePath}`);
        }
        localCliAtomicWrite(item.entry.sourcePath, item.sourceBuffer, sourceRoot, item.sourceMode, appliedIdentity);
        const restored = localCliReadStableFile(item.entry.sourcePath, sourceRoot);
        if (crypto.createHash('sha256').update(restored.buffer).digest('hex') !== item.sourceHash) {
          throw new LocalCliWorkspaceError('WORKSPACE_SYNC_ROLLBACK_FAILED', `authorized source could not be restored: ${item.entry.relativePath}`);
        }
      } catch {
        rollbackFailures.push(item.entry.relativePath);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new LocalCliWorkspaceError(
        'WORKSPACE_SYNC_ROLLBACK_FAILED',
        `authorized synchronization failed and could not be rolled back: ${rollbackFailures.join(', ')}`,
      );
    }
    throw error;
  }
}

export interface LocalCliAdapterOptions {
  executable?: string;
  timeoutMs?: number;
  useStdin?: boolean;
  env?: Record<string, string>;
  repo?: Repository;
  artifactStore?: ArtifactStore;
}

export abstract class LocalCliAdapterBase implements ProviderAdapter {
  public abstract readonly id: string;
  public abstract readonly name: string;
  public readonly adapterType: ProviderAdapterType = 'LOCAL_CLI';

  protected executable: string;
  protected timeoutMs: number;
  protected useStdin: boolean;
  protected env?: Record<string, string>;
  protected repo?: Repository;
  protected artifactStore?: ArtifactStore;
  private activeExecutions = new Map<string, { cancelRequested: boolean; processStarted: boolean }>();

  constructor(options?: LocalCliAdapterOptions) {
    this.executable = options?.executable || this.getDefaultExecutable();
    this.timeoutMs = options?.timeoutMs ?? 120000;
    this.useStdin = options?.useStdin ?? true;
    this.env = options?.env;
    this.repo = options?.repo;
    this.artifactStore = options?.artifactStore;
  }

  protected abstract getDefaultExecutable(): string;
  public abstract getCapabilities(): Promise<Capability[]>;

  protected resolveExecutionEnvironment(_request?: AgentExecutionRequest): Record<string, string> | undefined {
    return this.env;
  }

  protected getAllowedEnvironmentOverrideKeys(_request?: AgentExecutionRequest): string[] {
    return [];
  }

  protected extractProtocolText(_request: AgentExecutionRequest, rawStdout: string): string | null {
    return rawStdout;
  }

  protected classifyProviderProcessFailure(
    _request: AgentExecutionRequest,
    _result: ProcessRunResult
  ): { errorCode: RuntimeErrorCode; error: string } | null {
    return null;
  }

  public setRepository(repo: Repository): void {
    this.repo = repo;
  }

  public setArtifactStore(artifactStore: ArtifactStore): void {
    this.artifactStore = artifactStore;
  }

  public setExecutable(executable: string): void {
    this.executable = executable;
  }

  public async getQuota(): Promise<QuotaSnapshotInfo> {
    // Local CLIs do not provide authoritative machine-readable quota telemetry
    return {
      remaining: null,
      total: null,
      unit: 'REQUESTS',
      source: 'UNKNOWN',
      confidence: 0.0,
      resetAt: null,
    };
  }

  /** Run a version probe from a disposable directory, never the application cwd. */
  protected async executeHealthProbe(
    env?: Record<string, string>,
    allowedEnvKeys: string[] = [],
  ): Promise<ProcessRunResult> {
    const healthWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-local-cli-health-'));
    try {
      return await ProcessRunner.execute({
        executable: this.executable,
        args: ['--version'],
        cwd: healthWorkspace,
        timeoutMs: 5000,
        allowShell: false,
        env,
        allowedEnvKeys,
      });
    } finally {
      try { fs.rmSync(healthWorkspace, { recursive: true, force: true }); } catch { /* health is best effort */ }
    }
  }

  public async getHealth(): Promise<ProviderHealthStatus> {
    try {
      // Execute a non-destructive version probe
      const res = await this.executeHealthProbe(this.env, this.getAllowedEnvironmentOverrideKeys());

      if (res.cancelled) {
        return 'UNHEALTHY';
      }

      if (res.exitCode === 0 && !res.errorCode && !res.outputLimitExceeded && !res.timedOut) {
        return 'AVAILABLE';
      }

      const combinedErr = `${res.stdout} ${res.stderr}`.toLowerCase();
      if (
        combinedErr.includes('auth') ||
        combinedErr.includes('unauthorized') ||
        combinedErr.includes('login') ||
        combinedErr.includes('not logged in') ||
        combinedErr.includes('token')
      ) {
        return 'AUTH_ERROR';
      }

      return 'OFFLINE';
    } catch {
      return 'OFFLINE';
    }
  }

  protected buildPrompt(request: AgentExecutionRequest): string {
    const lines: string[] = [
      `TASK ID: ${request.taskId}`,
      `PROJECT ID: ${request.projectId}`,
      '',
      'INSTRUCTIONS:',
      ...request.instructions.map((i) => `- ${i}`),
    ];

    if (request.contextFiles.length > 0) {
      lines.push('');
      lines.push('CONTEXT FILES:');
      lines.push(...request.contextFiles.map((f) => `- ${f}`));
    }

    lines.push('');
    lines.push('OUTPUT REQUIREMENT:');
    lines.push(
      'Emit a valid JSON coder.v1 protocol object conforming to the CoderProtocol schema upon task completion.'
    );

    return lines.join('\n');
  }

  protected buildExecutionArgs(request: AgentExecutionRequest, _prompt: string): string[] {
    // When using stdin, no extra arguments needed beyond default execution mode
    return [];
  }

  public async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const isScheduled = !!(request.runtimeBinding?.executionId ?? request.executionId);
    const executionId = request.runtimeBinding?.executionId ?? request.executionId ?? crypto.randomUUID();
    const rootLeases: RepositoryRootLease[] = [];

    if (isScheduled) {
      if (this.activeExecutions.has(executionId)) {
        return {
          executionId,
          status: 'FAILED',
          errorCode: 'PROCESS_LAUNCH_FAILED',
          error: `LOCAL_CLI_EXECUTION_ALREADY_ACTIVE: Canonical execution ID "${executionId}" is already active in LocalCliAdapterBase.`,
        };
      }
      this.activeExecutions.set(executionId, { cancelRequested: false, processStarted: false });
    }

    try {
      // 1. Mandatory Repository Dependency Gate: Fail closed immediately if repo is absent (no spawn, no process.cwd fallback)
      if (!this.repo) {
        return {
          executionId,
          status: 'FAILED',
          error: 'PROVIDER_REPOSITORY_NOT_CONFIGURED: Local CLI adapter requires a configured Repository to resolve durable project working directory.',
        };
      }

      // 2. Resolve execution root directory (Scheduled Workspace or Legacy Project Repository Path)
      let executionRoot: string;
      const workspace = request.runtimeBinding?.workspace;

      if (workspace) {
        // Defense-in-depth structural validation of ProviderDispatch-produced workspace binding
        if (
          !workspace.workingDirectory ||
          typeof workspace.workingDirectory !== 'string' ||
          !path.isAbsolute(workspace.workingDirectory)
        ) {
          return {
            executionId,
            status: 'FAILED',
            error: `INVALID_WORKSPACE_BINDING: workingDirectory must be an absolute path (received "${workspace?.workingDirectory}").`,
          };
        }
        if (!workspace.sourceSha || typeof workspace.sourceSha !== 'string' || !/^[0-9a-fA-F]{40}$/.test(workspace.sourceSha)) {
          return {
            executionId,
            status: 'FAILED',
            error: `INVALID_WORKSPACE_BINDING: sourceSha must be a 40-character hexadecimal string (received "${workspace?.sourceSha}").`,
          };
        }
        if (!workspace.workerSlotId || typeof workspace.workerSlotId !== 'string' || workspace.workerSlotId.trim() === '') {
          return {
            executionId,
            status: 'FAILED',
            error: 'INVALID_WORKSPACE_BINDING: workerSlotId must be a non-empty string.',
          };
        }
        if (!workspace.ownershipDigest || typeof workspace.ownershipDigest !== 'string' || workspace.ownershipDigest.trim() === '') {
          return {
            executionId,
            status: 'FAILED',
            error: 'INVALID_WORKSPACE_BINDING: ownershipDigest must be a non-empty string.',
          };
        }

        const wsPath = path.normalize(path.resolve(workspace.workingDirectory));
        if (!fs.existsSync(wsPath)) {
          return {
            executionId,
            status: 'FAILED',
            error: `INVALID_WORKSPACE_BINDING: Workspace working directory does not exist: ${wsPath}`,
          };
        }
        try {
          const wsStat = fs.statSync(wsPath);
          if (!wsStat.isDirectory()) {
            return {
              executionId,
              status: 'FAILED',
              error: `INVALID_WORKSPACE_BINDING: Workspace working directory is not a directory: ${wsPath}`,
            };
          }
        } catch (err: any) {
          return {
            executionId,
            status: 'FAILED',
            error: `INVALID_WORKSPACE_BINDING: Cannot access workspace working directory: ${sanitizeErrorDiagnostics(err).message}`,
          };
        }
        executionRoot = wsPath;
      } else {
        // Legacy path resolution from durable Project database entity
        const project = this.repo.getProjectForRepositoryUse(request.projectId);
        if (!project) {
          return {
            executionId,
            status: 'FAILED',
            error: `PROJECT_NOT_FOUND: Project "${request.projectId}" not found in database.`,
          };
        }

        if (!project.repository_path || typeof project.repository_path !== 'string') {
          return {
            executionId,
            status: 'FAILED',
            error: `INVALID_PROJECT_REPOSITORY_PATH: Project "${request.projectId}" does not have a valid repository_path configured.`,
          };
        }

        const repoPath = path.normalize(path.resolve(project.repository_path));
        if (!fs.existsSync(repoPath)) {
          return {
            executionId,
            status: 'FAILED',
            error: `REPOSITORY_PATH_NOT_FOUND: Configured project repository path does not exist on disk: ${repoPath}`,
          };
        }
        try {
          const stat = fs.statSync(repoPath);
          if (!stat.isDirectory()) {
            return {
              executionId,
              status: 'FAILED',
              error: `REPOSITORY_PATH_NOT_DIRECTORY: Configured project repository path is not a directory: ${repoPath}`,
            };
          }
        } catch (err: any) {
          return {
            executionId,
            status: 'FAILED',
            error: `REPOSITORY_PATH_ACCESS_ERROR: Cannot access configured project repository path: ${sanitizeErrorDiagnostics(err).message}`,
          };
        }
        executionRoot = repoPath;
      }

      // 3. Mandatory PolicyService Evaluation Gate for Working Directory Access
      const selectedRoot = this.repo.getProjectRepositoryIdentity(request.projectId);
      rootLeases.push(RepositoryRootLease.acquire(selectedRoot));
      const sameRoot = process.platform === 'win32'
        ? executionRoot.toLowerCase() === selectedRoot.canonicalPath.toLowerCase()
        : executionRoot === selectedRoot.canonicalPath;
      if (!sameRoot) rootLeases.push(RepositoryRootLease.acquire(captureRepositoryRoot(executionRoot)));
      const workingDirPolicy = PolicyService.evaluateRealPathAccess(executionRoot, executionRoot, false);
      if (!workingDirPolicy.allowed) {
        return {
          executionId,
          status: 'FAILED',
          errorCode: 'POLICY_DENIAL',
          error: `SECURITY_POLICY_VIOLATION: Execution root directory access denied: ${workingDirPolicy.reason} (${workingDirPolicy.decision})`,
        };
      }

      // 4. Validate Context Files (must be strictly inside executionRoot, no path traversal)
      if (request.contextFiles.length > LOCAL_CLI_WORKSPACE_MAX_CONTEXT_PATHS) {
        return {
          executionId,
          status: 'FAILED',
          errorCode: 'POLICY_DENIAL',
          error: 'CONTEXT_LIMIT_EXCEEDED: authorized context contains too many paths',
        };
      }
      let canonicalContextFiles: string[];
      try {
        // Canonicalize the complete list before path.resolve or PolicyService
        // can inspect even the first entry.  This also rejects case aliases
        // before any filesystem operation on case-insensitive hosts.
        canonicalContextFiles = canonicalizePortableRelativePathList(request.contextFiles);
      } catch (error) {
        const contextError = error instanceof ContextPathError
          ? new LocalCliWorkspaceError(error.code, error.message.slice(error.code.length + 2))
          : error instanceof LocalCliWorkspaceError
            ? error
            : new LocalCliWorkspaceError('CONTEXT_PATH_INVALID', 'context path could not be canonicalized safely');
        const compatibilityDetail = contextError.code === 'CONTEXT_PATH_TRAVERSAL'
          ? ' SECURITY_POLICY_VIOLATION: Context file violates security policy because it is outside the authorized project root.'
          : '';
        return {
          executionId,
          status: 'FAILED',
          errorCode: 'POLICY_DENIAL',
          error: `${contextError.message}${compatibilityDetail}`,
        };
      }
      for (const canonicalContextFile of canonicalContextFiles) {
        const canonicalTarget = path.normalize(path.resolve(executionRoot, canonicalContextFile));
        const filePolicy = PolicyService.evaluateRealPathAccess(canonicalTarget, executionRoot, false);
        if (!filePolicy.allowed) {
          return {
            executionId,
            status: 'FAILED',
            errorCode: 'POLICY_DENIAL',
            error: `SECURITY_POLICY_VIOLATION: Context file violates security policy: ${filePolicy.reason} (${filePolicy.decision})`,
          };
        }
      }

      // 5. Build prompt and CLI arguments
      // Use the exact validated spelling for both provider instructions and
      // workspace preparation.  This avoids showing the provider an alias
      // that resolves differently from the files actually copied into cwd.
      const canonicalRequest: AgentExecutionRequest = {
        ...request,
        contextFiles: canonicalContextFiles,
      };
      const prompt = this.buildPrompt(canonicalRequest);
      const args = this.buildExecutionArgs(canonicalRequest, prompt);
      const executionEnv = this.resolveExecutionEnvironment(canonicalRequest);
      const allowedEnvKeys = this.getAllowedEnvironmentOverrideKeys(canonicalRequest);

      // 5b. Pre-spawn cancellation check
      const control = isScheduled ? this.activeExecutions.get(executionId) : undefined;
      if (control?.cancelRequested) {
        return {
          executionId,
          status: 'CANCELLED',
          errorCode: 'CANCELLED',
          error: 'Execution was cancelled before process spawn.',
        };
      }

      let localWorkspace: LocalCliWorkspaceLease;
      try {
        localWorkspace = localCliPrepareWorkspace(
          executionRoot,
          canonicalContextFiles,
          executionId,
          request.runtimeBinding?.workspace?.ownershipDigest ?? '',
        );
      } catch (error) {
        const workspaceError = error instanceof LocalCliWorkspaceError ? error.message : 'WORKSPACE_PREPARE_FAILED: isolated provider workspace could not be prepared';
        return {
          executionId,
          status: 'FAILED',
          errorCode: 'POLICY_DENIAL',
          error: safeDiagnosticText(workspaceError),
        };
      }

      try {
        if (control?.cancelRequested) {
          return {
            executionId,
            status: 'CANCELLED',
            errorCode: 'CANCELLED',
            error: 'Execution was cancelled before process spawn.',
          };
        }
        if (control) {
          control.processStarted = true;
        }

        // 6. Execute through ProcessRunner with durable ownership and safe minimal environment.
        // The child sees only the isolated workspace; the source worktree is
        // synchronized back only after a valid coder.v1 protocol is returned.
        const processResult = await ProcessRunner.execute({
          executable: this.executable,
          args,
          cwd: localWorkspace.workspaceRoot,
          timeoutMs: this.timeoutMs,
          env: executionEnv,
          allowedEnvKeys,
          allowShell: false,
          repo: this.repo,
          artifactStore: this.artifactStore,
          projectId: request.projectId,
          taskId: request.taskId,
          attemptId: request.attemptId ?? null,
          stdin: this.useStdin ? prompt : undefined,
          executionId: isScheduled ? executionId : undefined,
        });
        processResult.stdout = redactSensitiveText(processResult.stdout);
        processResult.stderr = redactSensitiveText(processResult.stderr);
        rootLeases.forEach(lease => lease.assertActive());

      // 7. Map cancellation truthfully
      if (processResult.cancelled || processResult.errorCode === 'CANCELLED') {
        return {
          executionId: processResult.executionId,
          status: 'CANCELLED',
          errorCode: 'CANCELLED',
          rawResponse: processResult.stdout,
          error: 'Execution was cancelled.',
          stdoutEvidenceId: processResult.stdoutEvidenceId,
          stderrEvidenceId: processResult.stderrEvidenceId,
        };
      }

      // 8. Map timeout / output limit / nonzero process exit truthfully
      if (isOutputSanitizationErrorCode(processResult.errorCode)) {
        return { executionId: processResult.executionId, status: 'FAILED', errorCode: processResult.errorCode,
          rawResponse: processResult.stdout, error: processResult.stderr,
          stdoutEvidenceId: processResult.stdoutEvidenceId, stderrEvidenceId: processResult.stderrEvidenceId };
      }
      if (processResult.timedOut || processResult.errorCode === 'TIMEOUT') {
        return {
          executionId: processResult.executionId,
          status: 'FAILED',
          errorCode: 'TIMEOUT',
          rawResponse: processResult.stdout,
          error: `Process timed out after ${this.timeoutMs}ms.`,
          stdoutEvidenceId: processResult.stdoutEvidenceId,
          stderrEvidenceId: processResult.stderrEvidenceId,
        };
      }

      if (processResult.outputLimitExceeded || processResult.errorCode === 'OUTPUT_LIMIT_EXCEEDED') {
        return {
          executionId: processResult.executionId,
          status: 'FAILED',
          errorCode: 'OUTPUT_LIMIT_EXCEEDED',
          rawResponse: processResult.stdout,
          error: 'Process output limit exceeded.',
          stdoutEvidenceId: processResult.stdoutEvidenceId,
          stderrEvidenceId: processResult.stderrEvidenceId,
        };
      }

      if (processResult.errorCode === 'PROCESS_LAUNCH_FAILED') {
        return {
          executionId: processResult.executionId,
          status: 'FAILED',
          errorCode: 'PROCESS_LAUNCH_FAILED',
          rawResponse: processResult.stdout,
          error: processResult.stderr || 'Failed to launch process.',
          stdoutEvidenceId: processResult.stdoutEvidenceId,
          stderrEvidenceId: processResult.stderrEvidenceId,
        };
      }

      if (processResult.exitCode !== 0) {
        const refinedFailure = this.classifyProviderProcessFailure(request, processResult);
        if (refinedFailure) {
          return {
            executionId: processResult.executionId,
            status: 'FAILED',
            errorCode: refinedFailure.errorCode,
            rawResponse: processResult.stdout,
            error: refinedFailure.error,
            stdoutEvidenceId: processResult.stdoutEvidenceId,
            stderrEvidenceId: processResult.stderrEvidenceId,
          };
        }

        return {
          executionId: processResult.executionId,
          status: 'FAILED',
          errorCode: 'NONZERO_EXIT',
          rawResponse: processResult.stdout,
          error: processResult.stderr || `Process exited with code ${processResult.exitCode}`,
          stdoutEvidenceId: processResult.stdoutEvidenceId,
          stderrEvidenceId: processResult.stderrEvidenceId,
        };
      }

      // 9. Protocol validation: Process exit 0 alone is NOT task completion
      const extracted = this.extractProtocolText(request, processResult.stdout);
      const protocolText = extracted === null ? null : redactSensitiveText(extracted);

      if (protocolText === null) {
        return {
          executionId: processResult.executionId,
          status: 'FAILED',
          errorCode: 'PROTOCOL_INVALID',
          rawResponse: processResult.stdout,
          error: 'PROTOCOL_INVALID: Process completed with exit code 0, but output extractor did not produce a valid protocol payload.',
          stdoutEvidenceId: processResult.stdoutEvidenceId,
          stderrEvidenceId: processResult.stderrEvidenceId,
        };
      }

      const parseResult = ProtocolParser.parse(protocolText);

      if (parseResult.success && parseResult.data?.type === 'coder.v1') {
        if (control?.cancelRequested) {
          return { executionId: processResult.executionId, status: 'CANCELLED', errorCode: 'CANCELLED',
            error: 'Execution was cancelled before workspace publication.', rawResponse: processResult.stdout,
            stdoutEvidenceId: processResult.stdoutEvidenceId, stderrEvidenceId: processResult.stderrEvidenceId };
        }
        try {
          const publish = () => localCliSynchronizeWorkspace(localWorkspace);
          if (request.executionId) {
            if (!new NonHandoffExecutionLifecycle(this.repo).publishIfCurrent(processResult.executionId, publish)) {
              return { executionId: processResult.executionId, status: 'FAILED', errorCode: 'RECOVERY_FENCED',
                error: 'NON_HANDOFF_PUBLICATION_FENCED: Durable execution authority changed before workspace publication.',
                rawResponse: processResult.stdout, stdoutEvidenceId: processResult.stdoutEvidenceId,
                stderrEvidenceId: processResult.stderrEvidenceId };
            }
          } else {
            publish();
          }
        } catch (error) {
          const syncError = error instanceof LocalCliWorkspaceError ? error.message : 'WORKSPACE_SYNC_FAILED: authorized workspace changes could not be verified';
          return {
            executionId: processResult.executionId,
            status: 'FAILED',
            errorCode: 'EXECUTION_FAILED',
            rawResponse: processResult.stdout,
            error: safeDiagnosticText(syncError),
            stdoutEvidenceId: processResult.stdoutEvidenceId,
            stderrEvidenceId: processResult.stderrEvidenceId,
          };
        }
        return {
          executionId: processResult.executionId,
          status: 'COMPLETED',
          outputProtocol: parseResult.rawJson,
          rawResponse: processResult.stdout,
          stdoutEvidenceId: processResult.stdoutEvidenceId,
          stderrEvidenceId: processResult.stderrEvidenceId,
        };
      }

      // Protocol was missing, malformed, or wrong protocol type
      return {
        executionId: processResult.executionId,
        status: 'FAILED',
        errorCode: 'PROTOCOL_INVALID',
        rawResponse: processResult.stdout,
        error: `PROTOCOL_INVALID: Process completed with exit code 0, but payload did not contain a valid CoderReport protocol (${parseResult.error || 'protocol missing or invalid type'}).`,
        stdoutEvidenceId: processResult.stdoutEvidenceId,
        stderrEvidenceId: processResult.stderrEvidenceId,
      };
      } finally {
        try {
          localCliCleanupWorkspace(localWorkspace);
        } catch {
          // A provider result cannot be reported as success when cleanup
          // ownership was not proven.  Returning from finally intentionally
          // overrides every earlier branch with a typed failure.
          return {
            executionId,
            status: 'FAILED',
            errorCode: 'EXECUTION_FAILED',
            error: 'WORKSPACE_CLEANUP_FAILED: isolated provider workspace cleanup was not verified.',
          };
        }
      }
    } catch (error) {
      if (error instanceof OutputSanitizationError) {
        return { executionId, status: 'FAILED', errorCode: error.code, error: error.message };
      }
      if (!(error instanceof RepositoryRootError)) throw sanitizedDiagnosticError(error);
      return { executionId, status: 'FAILED', errorCode: error.code, error: error.message };
    } finally {
      for (const lease of rootLeases.reverse()) lease.close();
      if (isScheduled) {
        this.activeExecutions.delete(executionId);
      }
    }
  }

  public async cancel(executionId: string): Promise<void> {
    const control = this.activeExecutions.get(executionId);
    if (control) {
      control.cancelRequested = true;
      if (control.processStarted) {
        ProcessRunner.cancel(executionId);
      }
      return;
    }
    ProcessRunner.cancel(executionId);
  }
}
