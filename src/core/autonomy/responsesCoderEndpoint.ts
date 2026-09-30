import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { z } from 'zod';
import {
  AgentExecutionRequest,
  AgentExecutionResult,
  QuotaSnapshotInfo,
} from '../adapters/ProviderAdapter';
import { ExecutionAuthorization } from '../types/domain';
import { assertPathContained } from '../services/ArtifactStore';
import {
  WorkOrder,
  sanitizeAutonomyText,
} from './contracts';
import {
  CoderEndpointTransport,
  ProviderEndpointConfig,
  ProviderEndpointHealthState,
  isEndpointEligible,
  parseProviderEndpointConfig,
} from './providerEndpoint';
import type { ProviderRun } from './providers';
import {
  endpointUrl,
  assertProviderResponseOrigin,
  failedRun,
  outputText,
  ProviderResponseBoundaryError,
  ProviderResponseTooLargeError,
  readResponseTextBounded,
  redactValue,
  redactEndpointDiagnostics,
  referencedEnvironmentName,
  responseId,
  ResponsesEndpointTransportOptions,
} from './responsesEndpoint';
import { isPathContainedInBoundary } from './productTaskAdapter';
import type { RepairContextPackage } from './repairContext';
import { buildTrustedEnvironment, resolveTrustedExecutable } from '../services/ExecutableResolver';
import { PolicyService } from '../services/PolicyService';

type FetchLike = typeof fetch;

export const CoderEditFileSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
}).strict();
export type CoderEditFile = z.infer<typeof CoderEditFileSchema>;

export const CoderEditBundleSchema = z.object({
  protocol_version: z.literal('coderbundle.v1'),
  task_id: z.string().trim().min(1),
  authorization_id: z.string().trim().min(1),
  source_head: z.string().trim().regex(/^[0-9a-f]{40}$/i, 'must be a 40-character Git SHA'),
  allowed_paths: z.array(z.string().trim().min(1)),
  proposed_edits: z.array(CoderEditFileSchema),
  summary: z.string().optional(),
  addressed_finding_ids: z.array(z.string().trim().min(1)).optional(),
  unresolved_finding_ids: z.array(z.string().trim().min(1)).optional(),
  implementation_summary: z.string().optional(),
  changed_files: z.array(z.string().trim().min(1)).optional(),
  known_risks: z.array(z.string().trim().min(1)).optional(),
}).strict();
export type CoderEditBundle = z.infer<typeof CoderEditBundleSchema>;

export const CoderBundleJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'protocol_version',
    'task_id',
    'authorization_id',
    'source_head',
    'allowed_paths',
    'proposed_edits',
    'summary',
  ],
  properties: {
    protocol_version: {
      type: 'string',
      enum: ['coderbundle.v1'],
    },
    task_id: {
      type: 'string',
    },
    authorization_id: {
      type: 'string',
    },
    source_head: {
      type: 'string',
    },
    allowed_paths: {
      type: 'array',
      items: {
        type: 'string',
      },
    },
    proposed_edits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: {
          path: {
            type: 'string',
          },
          content: {
            type: 'string',
          },
        },
      },
    },
    summary: {
      type: 'string',
    },
  },
} as const;

export const RepairCoderBundleJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'protocol_version',
    'task_id',
    'authorization_id',
    'source_head',
    'allowed_paths',
    'proposed_edits',
    'summary',
  ],
  properties: {
    ...CoderBundleJsonSchema.properties,
    addressed_finding_ids: {
      type: 'array',
      items: {
        type: 'string',
      },
    },
    unresolved_finding_ids: {
      type: 'array',
      items: {
        type: 'string',
      },
    },
    implementation_summary: {
      type: 'string',
    },
    changed_files: {
      type: 'array',
      items: {
        type: 'string',
      },
    },
    known_risks: {
      type: 'array',
      items: {
        type: 'string',
      },
    },
  },
} as const;

export const CODER_BUNDLE_JSON_SCHEMA = CoderBundleJsonSchema;

export function parseCoderEditBundle(raw: string): CoderEditBundle {
  const trimmed = raw.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('CONTRACT_INVALID: coder output did not contain valid JSON');
  }

  const result = CoderEditBundleSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`CONTRACT_INVALID: coder output did not contain a valid coderbundle.v1 object: ${result.error.message}`);
  }

  return result.data;
}

export interface CoderValidationContext {
  taskId: string;
  authorizationId: string;
  sourceHead: string;
  allowedPaths: string[];
  forbiddenPaths?: string[];
  worktree?: string;
}

function canonicalRelativePath(rawPath: string, field: string): string {
  const slashPath = rawPath.replace(/\\/g, '/');
  if (path.posix.isAbsolute(slashPath) || path.win32.isAbsolute(rawPath) || /^[a-zA-Z]:/.test(rawPath)) {
    throw new Error(`PATH_TRAVERSAL: Absolute paths are forbidden in ${field}: ${rawPath}`);
  }
  if (slashPath === '..' || slashPath.startsWith('../') || slashPath.includes('/../')) {
    throw new Error(`PATH_TRAVERSAL: Path traversal is forbidden in ${field}: ${rawPath}`);
  }
  // A colon in a Windows path component denotes an alternate data stream
  // (for example, `source.ts:secret`).  Reject it on every platform so a
  // bundle accepted on POSIX cannot become an out-of-policy write on Windows.
  // Windows also strips trailing dots and spaces from path components, which
  // would make two distinct protocol paths address the same native file.
  const components = slashPath.split('/');
  if (components.some((component) => component.includes(':'))) {
    throw new Error(`PATH_TRAVERSAL: Alternate data streams are forbidden in ${field}: ${rawPath}`);
  }
  if (components.some((component) => /[ .]$/.test(component))) {
    throw new Error(`NON_CANONICAL_PATH: Windows-trimmed path components are forbidden in ${field}: ${rawPath}`);
  }
  const canonical = path.posix.normalize(slashPath);
  if (
    canonical !== slashPath ||
    canonical === '.' ||
    canonical === '..'
  ) {
    throw new Error(`NON_CANONICAL_PATH: ${field} must use one canonical relative path: ${rawPath}`);
  }
  return canonical;
}

function canonicalBoundaryPath(rawPath: string, field: string): string {
  const slashPath = rawPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const canonical = path.posix.normalize(slashPath);
  if (canonical !== slashPath || canonical === '.' || canonical.includes('/../')) {
    throw new Error(`NON_CANONICAL_PATH: ${field} must use one canonical path: ${rawPath}`);
  }
  return canonical;
}

function filesystemPathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

const CODER_CONTEXT_MAX_FILES = 64;
const CODER_CONTEXT_MAX_BYTES = 512 * 1024;
// Stop directory enumeration before an oversized authorized tree can be
// materialized in memory.  The file and byte limits below remain the
// protocol-facing limits; this bound only caps traversal work for rejected
// requests.
const CODER_CONTEXT_MAX_ENTRIES = CODER_CONTEXT_MAX_FILES * 8;
const CODER_CONTEXT_MAX_DEPTH = 128;
const CODER_EDIT_MAX_BYTES = 1024 * 1024;
const CODER_EDIT_TOTAL_MAX_BYTES = 8 * 1024 * 1024;

interface CoderPathIdentity {
  readonly key: string;
  readonly realPath: string;
}

interface CoderPathSnapshot {
  readonly absolutePath: string;
  readonly parentIdentities: ReadonlyArray<{ path: string; identity: CoderPathIdentity }>;
  readonly leafIdentity?: CoderPathIdentity;
  readonly leafIsDirectory?: boolean;
  readonly leafIsFile?: boolean;
  readonly leafMode?: number;
}

interface CoderWorktreeAnchor {
  readonly path: string;
  readonly realPath: string;
  readonly identity: CoderPathIdentity;
}

function coderErrno(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? String((error as { code: string }).code)
    : undefined;
}

function coderIsMissing(error: unknown): boolean {
  return coderErrno(error) === 'ENOENT';
}

function coderRealpath(targetPath: string): string {
  const realpath = fs.realpathSync.native ?? fs.realpathSync;
  return realpath(targetPath);
}

function coderIdentityKey(stat: fs.Stats): string {
  // Windows device numbers are not stable between lstat/fstat.  NTFS file
  // indexes remain stable, so omit dev on that platform while retaining the
  // file type in every identity.
  const device = process.platform === 'win32' ? 'win32' : String(stat.dev);
  return `${device}:${String(stat.ino)}:${String(stat.mode & 0o170000)}`;
}

function coderSameIdentity(left: CoderPathIdentity, right: CoderPathIdentity): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  return left.key === right.key && normalize(left.realPath) === normalize(right.realPath);
}

function coderContainedRealPath(candidate: string, root: string, allowRoot = true): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  const relative = path.relative(normalize(root), normalize(candidate));
  return (allowRoot && relative === '') || (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !relative.startsWith('../') &&
    !relative.startsWith('..\\') &&
    !path.isAbsolute(relative)
  );
}

function coderPolicyOrThrow(targetPath: string, root: string, relative: string, operation: 'read' | 'write'): void {
  // Windows temporary paths can contain an 8.3 alias (for example
  // `C:\\Users\\VOTHAN~1`) while the anchored root uses its long form.
  // Normalize existing targets through the OS before delegating to the shared
  // policy; use the anchored long root for missing final paths.
  let policyTarget = path.resolve(root, relative);
  try {
    policyTarget = coderRealpath(targetPath);
  } catch {
    // Missing final files remain subject to the lexical policy below.
  }
  const decision = PolicyService.evaluateRealPathAccess(policyTarget, root, operation === 'write');
  if (!decision.allowed) {
    // Keep diagnostics relative and generic.  PolicyService reasons may
    // contain absolute local paths or sensitive filename fragments.
    throw new Error(`CODER_PATH_POLICY_DENIED: ${operation} is not authorized for ${relative}`);
  }
}

function captureCoderAnchor(worktree: string): CoderWorktreeAnchor {
  const absolute = path.resolve(worktree);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    throw new Error(`WORKTREE_NOT_FOUND: Authorized worktree does not exist: ${worktree}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('WORKTREE_NOT_FOUND: Authorized worktree must be a real directory');
  }
  const realPath = coderRealpath(absolute);
  if (!coderContainedRealPath(realPath, realPath)) {
    throw new Error('WORKTREE_BOUNDARY_UNVERIFIED: Authorized worktree real path could not be established');
  }
  coderPolicyOrThrow(realPath, realPath, '.', 'read');
  return {
    path: absolute,
    realPath,
    identity: { key: coderIdentityKey(stat), realPath },
  };
}

function assertCoderAnchorStable(anchor: CoderWorktreeAnchor): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(anchor.path);
  } catch {
    throw new Error('WORKTREE_BOUNDARY_CHANGED: Authorized worktree disappeared during the operation');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('WORKTREE_BOUNDARY_CHANGED: Authorized worktree became a reparse point');
  }
  const realPath = coderRealpath(anchor.path);
  if (!coderSameIdentity(anchor.identity, { key: coderIdentityKey(stat), realPath })) {
    throw new Error('WORKTREE_BOUNDARY_CHANGED: Authorized worktree identity changed during the operation');
  }
}

function coderRelativePath(anchor: CoderWorktreeAnchor, absolutePath: string): string {
  const relative = path.relative(anchor.path, absolutePath).replace(/\\/g, '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error('CODER_PATH_INVALID: path escaped the authorized worktree');
  }
  return relative;
}

function captureCoderPathSnapshot(
  targetPath: string,
  anchor: CoderWorktreeAnchor,
  options: { allowMissingLeaf?: boolean; requireFile?: boolean } = {},
): CoderPathSnapshot {
  const absolute = path.resolve(targetPath);
  const relative = coderRelativePath(anchor, absolute);
  try {
    assertPathContained(absolute, anchor.path);
  } catch {
    throw new Error(`CODER_PATH_INVALID: ${relative}`);
  }
  coderPolicyOrThrow(absolute, anchor.realPath, relative, 'read');

  const parentIdentities: Array<{ path: string; identity: CoderPathIdentity }> = [];
  const parent = path.dirname(absolute);
  const parentRelative = path.relative(anchor.path, parent);
  let current = anchor.path;
  if (parentRelative && parentRelative !== '.') {
    for (const segment of parentRelative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      let parentStat: fs.Stats;
      try {
        parentStat = fs.lstatSync(current);
      } catch (error) {
        if (coderIsMissing(error)) break;
        throw new Error(`CODER_PATH_INVALID: parent could not be inspected: ${relative}`);
      }
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
        throw new Error(`CODER_PATH_INVALID: parent is not a real directory: ${relative}`);
      }
      const parentRealPath = coderRealpath(current);
      if (!coderContainedRealPath(parentRealPath, anchor.realPath)) {
        throw new Error(`CODER_PATH_INVALID: parent escaped the authorized worktree: ${relative}`);
      }
      coderPolicyOrThrow(current, anchor.realPath, path.relative(anchor.path, current).replace(/\\/g, '/'), 'read');
      parentIdentities.push({
        path: current,
        identity: { key: coderIdentityKey(parentStat), realPath: parentRealPath },
      });
    }
  }

  let leafIdentity: CoderPathIdentity | undefined;
  let leafIsDirectory: boolean | undefined;
  let leafIsFile: boolean | undefined;
  let leafMode: number | undefined;
  try {
    const leafStat = fs.lstatSync(absolute);
    if (leafStat.isSymbolicLink()) throw new Error(`CODER_PATH_INVALID: symbolic link is forbidden: ${relative}`);
    const leafRealPath = coderRealpath(absolute);
    if (!coderContainedRealPath(leafRealPath, anchor.realPath)) {
      throw new Error(`CODER_PATH_INVALID: path resolved outside the authorized worktree: ${relative}`);
    }
    coderPolicyOrThrow(absolute, anchor.realPath, relative, 'read');
    leafIdentity = { key: coderIdentityKey(leafStat), realPath: leafRealPath };
    leafIsDirectory = leafStat.isDirectory();
    leafIsFile = leafStat.isFile();
    leafMode = leafStat.mode;
    if (options.requireFile && !leafStat.isFile()) {
      throw new Error(`CODER_PATH_INVALID: edit target is not a regular file: ${relative}`);
    }
  } catch (error) {
    if (!coderIsMissing(error)) throw error;
    if (!options.allowMissingLeaf) throw new Error(`CODER_PATH_INVALID: target disappeared: ${relative}`);
  }

  return { absolutePath: absolute, parentIdentities, leafIdentity, leafIsDirectory, leafIsFile, leafMode };
}

function assertCoderSnapshotUnchanged(snapshot: CoderPathSnapshot, anchor: CoderWorktreeAnchor): void {
  const current = captureCoderPathSnapshot(snapshot.absolutePath, anchor, { allowMissingLeaf: true });
  if (current.parentIdentities.length !== snapshot.parentIdentities.length) {
    throw new Error('CODER_PATH_CHANGED: parent path identity changed during the operation');
  }
  for (let index = 0; index < snapshot.parentIdentities.length; index += 1) {
    const expected = snapshot.parentIdentities[index];
    const actual = current.parentIdentities[index];
    if (expected.path !== actual.path || !coderSameIdentity(expected.identity, actual.identity)) {
      throw new Error('CODER_PATH_CHANGED: parent path identity changed during the operation');
    }
  }
  if (Boolean(snapshot.leafIdentity) !== Boolean(current.leafIdentity)) {
    throw new Error('CODER_PATH_CHANGED: target existence changed during the operation');
  }
  if (snapshot.leafIdentity && current.leafIdentity && !coderSameIdentity(snapshot.leafIdentity, current.leafIdentity)) {
    throw new Error('CODER_PATH_CHANGED: target identity changed during the operation');
  }
}

function openCoderFile(filePath: string, flags: number, mode?: number): number {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  if (process.platform !== 'win32' && noFollow === 0) {
    throw new Error('CODER_BOUNDARY_UNAVAILABLE: platform cannot guarantee no-follow file access');
  }
  return fs.openSync(filePath, flags | noFollow, mode);
}

function readCoderFile(
  snapshot: CoderPathSnapshot,
  anchor: CoderWorktreeAnchor,
  maxBytes: number,
): Buffer {
  if (!snapshot.leafIdentity || !snapshot.leafIsFile) {
    throw new Error(`SOURCE_CONTEXT_PATH_INVALID: source is not a regular file: ${coderRelativePath(anchor, snapshot.absolutePath)}`);
  }
  assertCoderSnapshotUnchanged(snapshot, anchor);
  let descriptor: number | undefined;
  try {
    // O_NONBLOCK keeps a replacement FIFO/device from stalling the main
    // process before its non-regular-file identity can be rejected.  It is a
    // no-op for regular files and is unavailable on a few platforms.
    const nonBlocking = typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0;
    descriptor = openCoderFile(snapshot.absolutePath, fs.constants.O_RDONLY | nonBlocking);
    const openedStat = fs.fstatSync(descriptor);
    if (!openedStat.isFile()) {
      throw new Error('CODER_PATH_CHANGED: source file became a non-regular file before it was read');
    }
    const openedIdentity: CoderPathIdentity = {
      key: coderIdentityKey(openedStat),
      realPath: coderRealpath(snapshot.absolutePath),
    };
    if (!coderSameIdentity(snapshot.leafIdentity, openedIdentity) || !coderContainedRealPath(openedIdentity.realPath, anchor.realPath)) {
      throw new Error('CODER_PATH_CHANGED: source file identity changed before it was read');
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total + 1));
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`SOURCE_CONTEXT_LIMIT_EXCEEDED: file exceeds ${maxBytes} bytes`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const afterStat = fs.fstatSync(descriptor);
    if (coderIdentityKey(afterStat) !== openedIdentity.key || afterStat.size !== openedStat.size) {
      throw new Error('CODER_PATH_CHANGED: source file changed while it was read');
    }
    const result = Buffer.concat(chunks, total);
    assertCoderSnapshotUnchanged(snapshot, anchor);
    return result;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the original error */ }
    }
  }
}

function writeCoderAll(descriptor: number, content: Buffer): void {
  let offset = 0;
  while (offset < content.length) {
    const written = fs.writeSync(descriptor, content, offset, content.length - offset);
    if (written <= 0) throw new Error('CODER_WRITE_NO_PROGRESS');
    offset += written;
  }
}

function ensureCoderParentDirectories(parent: string, anchor: CoderWorktreeAnchor): void {
  const relative = path.relative(anchor.path, parent);
  if (!relative || relative === '.') return;
  let current = anchor.path;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    assertCoderAnchorStable(anchor);
    const next = path.join(current, segment);
    const nextRelative = path.relative(anchor.path, next).replace(/\\/g, '/');
    coderPolicyOrThrow(next, anchor.realPath, nextRelative, 'write');
    try {
      const stat = fs.lstatSync(next);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`CODER_PATH_INVALID: parent is not a real directory: ${nextRelative}`);
      const real = coderRealpath(next);
      if (!coderContainedRealPath(real, anchor.realPath)) throw new Error(`CODER_PATH_INVALID: parent escaped the authorized worktree: ${nextRelative}`);
    } catch (error) {
      if (!coderIsMissing(error)) throw error;
      // Create one component at a time.  A recursive mkdir could follow a
      // replacement symlink in an unchecked intermediate component.
      try {
        fs.mkdirSync(next);
      } catch (mkdirError) {
        if (!coderIsMissing(mkdirError) && coderErrno(mkdirError) !== 'EEXIST') throw mkdirError;
      }
      const created = fs.lstatSync(next);
      if (!created.isDirectory() || created.isSymbolicLink() || !coderContainedRealPath(coderRealpath(next), anchor.realPath)) {
        throw new Error(`CODER_PATH_INVALID: newly created parent is not safely contained: ${nextRelative}`);
      }
    }
    current = next;
  }
}

interface CoderEditOriginal {
  readonly path: string;
  readonly absolutePath: string;
  readonly content?: Buffer;
  readonly snapshot: CoderPathSnapshot;
  /** Identity/content produced by this bundle, once its replacement commits. */
  writtenIdentity?: CoderPathIdentity;
  writtenContent?: Buffer;
}

interface CoderAtomicWriteFailure extends Error {
  readonly replacementIdentity?: CoderPathIdentity;
}

function coderReplacementIdentity(error: unknown): CoderPathIdentity | undefined {
  if (!error || typeof error !== 'object' || !('replacementIdentity' in error)) return undefined;
  const candidate = (error as { replacementIdentity?: unknown }).replacementIdentity;
  if (!candidate || typeof candidate !== 'object') return undefined;
  const identity = candidate as Partial<CoderPathIdentity>;
  return typeof identity.key === 'string' && typeof identity.realPath === 'string'
    ? { key: identity.key, realPath: identity.realPath }
    : undefined;
}

function createCoderTempFile(parent: string, content: Buffer, anchor: CoderWorktreeAnchor): string {
  const tempPath = path.join(parent, `.agent-forge-coder-${crypto.randomUUID()}.tmp`);
  const relative = coderRelativePath(anchor, tempPath);
  coderPolicyOrThrow(tempPath, anchor.realPath, relative, 'write');
  let descriptor: number | undefined;
  let complete = false;
  try {
    descriptor = openCoderFile(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    writeCoderAll(descriptor, content);
    fs.fsyncSync(descriptor);
    complete = true;
    return tempPath;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the original error */ }
    }
    if (!complete) {
      try { removeCoderTempFile(tempPath); } catch { /* preserve the original write failure */ }
    }
  }
}

function removeCoderTempFile(tempPath: string): void {
  try { fs.unlinkSync(tempPath); } catch (error) { if (!coderIsMissing(error)) throw error; }
}

function writeCoderFileAtomically(
  original: CoderEditOriginal,
  content: Buffer,
  anchor: CoderWorktreeAnchor,
): CoderPathIdentity {
  ensureCoderParentDirectories(path.dirname(original.absolutePath), anchor);
  const current = captureCoderPathSnapshot(original.absolutePath, anchor, { allowMissingLeaf: true });
  if (Boolean(original.snapshot.leafIdentity) !== Boolean(current.leafIdentity) ||
      (original.snapshot.leafIdentity && current.leafIdentity && !coderSameIdentity(original.snapshot.leafIdentity, current.leafIdentity))) {
    throw new Error(`CODER_PATH_CHANGED: target changed before atomic replacement: ${original.path}`);
  }
  assertCoderSnapshotUnchanged(current, anchor);
  const tempPath = createCoderTempFile(path.dirname(original.absolutePath), content, anchor);
  let renamed = false;
  let replacementIdentity: CoderPathIdentity | undefined;
  try {
    if (original.snapshot.leafIdentity && original.snapshot.leafMode !== undefined) {
      // Replacement should retain the existing executable/read-only mode;
      // newly created files deliberately keep the private 0600 temp mode.
      fs.chmodSync(tempPath, original.snapshot.leafMode & 0o7777);
    }
    assertCoderSnapshotUnchanged(current, anchor);
    fs.renameSync(tempPath, original.absolutePath);
    renamed = true;
    const post = captureCoderPathSnapshot(original.absolutePath, anchor, { allowMissingLeaf: false, requireFile: true });
    replacementIdentity = post.leafIdentity;
    if (!replacementIdentity) throw new Error(`CODER_EDIT_POSTCONDITION_FAILED: replacement identity was not available: ${original.path}`);
    const verified = readCoderFile(post, anchor, CODER_EDIT_MAX_BYTES);
    if (!verified.equals(content)) throw new Error(`CODER_EDIT_POSTCONDITION_FAILED: replacement content was not verified: ${original.path}`);
    return replacementIdentity;
  } catch (error) {
    if (!renamed) {
      try { removeCoderTempFile(tempPath); } catch { /* preserve primary failure */ }
    }
    // A post-rename failure must carry the identity we observed immediately
    // after replacement.  Rollback can then refuse to overwrite a concurrent
    // replacement instead of guessing which file it is allowed to restore.
    if (renamed && replacementIdentity && error && typeof error === 'object') {
      Object.defineProperty(error, 'replacementIdentity', {
        configurable: true,
        enumerable: false,
        value: replacementIdentity,
      });
    }
    throw error as CoderAtomicWriteFailure;
  }
}

function rollbackCoderEdit(original: CoderEditOriginal, anchor: CoderWorktreeAnchor): void {
  // If the replacement never committed, there is nothing this rollback owns.
  // In particular, never delete a target that appeared after a failed create.
  if (!original.writtenIdentity) return;
  const current = captureCoderPathSnapshot(original.absolutePath, anchor, { allowMissingLeaf: true });
  if (!current.leafIdentity || !coderSameIdentity(original.writtenIdentity, current.leafIdentity)) {
    throw new Error(`CODER_EDIT_ROLLBACK_FAILED: target was replaced concurrently: ${original.path}`);
  }
  if (!original.writtenContent) {
    throw new Error(`CODER_EDIT_ROLLBACK_FAILED: replacement content was not retained: ${original.path}`);
  }
  const currentContent = readCoderFile(current, anchor, CODER_EDIT_MAX_BYTES);
  if (!currentContent.equals(original.writtenContent)) {
    throw new Error(`CODER_EDIT_ROLLBACK_FAILED: target content changed concurrently: ${original.path}`);
  }
  if (!original.content) {
    if (!current.leafIsFile) throw new Error(`CODER_EDIT_ROLLBACK_FAILED: target became a non-regular file: ${original.path}`);
    fs.unlinkSync(original.absolutePath);
    const after = captureCoderPathSnapshot(original.absolutePath, anchor, { allowMissingLeaf: true });
    if (after.leafIdentity) throw new Error(`CODER_EDIT_ROLLBACK_FAILED: new target could not be removed: ${original.path}`);
    return;
  }
  writeCoderFileAtomically({ ...original, snapshot: current, writtenIdentity: undefined, writtenContent: undefined }, original.content, anchor);
}

export function validateCoderEditBundle(
  bundle: CoderEditBundle,
  context: CoderValidationContext,
): CoderEditBundle {
  if (bundle.task_id !== context.taskId) {
    throw new Error(`CONTRACT_INVALID: Task ID mismatch in coder edit bundle: expected ${context.taskId}, got ${bundle.task_id}`);
  }
  if (bundle.authorization_id !== context.authorizationId) {
    throw new Error(`CONTRACT_INVALID: Authorization ID mismatch in coder edit bundle: expected ${context.authorizationId}, got ${bundle.authorization_id}`);
  }
  if (bundle.source_head.toLowerCase() !== context.sourceHead.toLowerCase()) {
    throw new Error(`STALE_SOURCE_HEAD: Coder edit bundle source HEAD mismatch: expected ${context.sourceHead}, got ${bundle.source_head}`);
  }

  // Require allowed_paths to match the authorized list exactly
  const contextAllowed = context.allowedPaths.map((p) => canonicalRelativePath(p, 'authorized allowed_paths'));
  const bundleAllowed = bundle.allowed_paths.map((p) => canonicalRelativePath(p, 'bundle allowed_paths'));

  if (new Set(bundleAllowed.map(filesystemPathKey)).size !== bundleAllowed.length) {
    throw new Error('CONTRACT_INVALID: Coder edit bundle contains duplicate allowed_paths');
  }
  if (new Set(contextAllowed.map(filesystemPathKey)).size !== contextAllowed.length) {
    throw new Error('CONTRACT_INVALID: Authorized context contains duplicate allowed_paths');
  }

  if (
    bundleAllowed.length !== contextAllowed.length ||
    bundleAllowed.some((entry, idx) => filesystemPathKey(entry) !== filesystemPathKey(contextAllowed[idx]))
  ) {
    throw new Error(`UNAUTHORIZED_PATH: Coder edit bundle declared allowed_paths does not match authorized paths exactly`);
  }

  const forbidden = (context.forbiddenPaths ?? ['.git']).map((entry) => canonicalBoundaryPath(entry, 'forbidden_paths'));
  const seenEditPaths = new Set<string>();

  for (const edit of bundle.proposed_edits) {
    if (typeof edit.content !== 'string') {
      throw new Error(`CONTRACT_INVALID: Proposed edit content must be a string: ${edit.path}`);
    }

    const normPath = canonicalRelativePath(edit.path, 'proposed_edits.path');
    const editKey = filesystemPathKey(normPath);

    // Reject duplicate edit paths
    if (seenEditPaths.has(editKey)) {
      throw new Error(`CONTRACT_INVALID: Duplicate edit path in proposed_edits: ${edit.path}`);
    }
    seenEditPaths.add(editKey);

    // Check forbidden paths FIRST so explicitly forbidden paths like .git are classified as FORBIDDEN_PATH
    const isForbidden = forbidden.some((entry) => isPathContainedInBoundary(normPath, entry));
    if (isForbidden) {
      throw new Error(`FORBIDDEN_PATH: Proposed edit path is in forbidden paths: ${edit.path}`);
    }

    // Check containment in allowed paths
    const isAllowed = contextAllowed.some((entry) => isPathContainedInBoundary(normPath, entry));
    if (!isAllowed) {
      throw new Error(`UNAUTHORIZED_PATH: Proposed edit path is not in allowed paths: ${edit.path}`);
    }

    if (context.worktree) {
      const fullPath = path.resolve(context.worktree, normPath);
      try {
        assertPathContained(fullPath, context.worktree);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`PATH_TRAVERSAL: ${msg}`);
      }
    }
  }

  if (bundle.changed_files) {
    for (const f of bundle.changed_files) {
      const normPath = canonicalRelativePath(f, 'changed_files');
      const isForbidden = forbidden.some((entry) => isPathContainedInBoundary(normPath, entry));
      if (isForbidden) {
        throw new Error(`FORBIDDEN_PATH: Declared changed_files path is in forbidden paths: ${f}`);
      }
      const isAllowed = contextAllowed.some((entry) => isPathContainedInBoundary(normPath, entry));
      if (!isAllowed) {
        throw new Error(`UNAUTHORIZED_PATH: Declared changed_files path is not in allowed paths: ${f}`);
      }
    }
  }

  return bundle;
}

export function applyCoderEditBundle(
  worktree: string,
  bundle: CoderEditBundle,
  context?: Omit<CoderValidationContext, 'worktree'>,
): { changedFiles: string[] } {
  const anchor = captureCoderAnchor(worktree);
  const resolvedWorktree = anchor.path;

  // A routed edit is writable only after Git independently proves the exact
  // source HEAD. Missing Git, a non-repository worktree, malformed output, and
  // process errors all fail closed before filesystem mutation.
  const gitExecutable = resolveTrustedExecutable('git', 'git');
  if (!gitExecutable) {
    throw new Error('SOURCE_HEAD_UNVERIFIED: Trusted Git executable is unavailable');
  }
  const gitHead = spawnSync(gitExecutable, ['rev-parse', 'HEAD'], {
    cwd: resolvedWorktree,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    env: buildTrustedEnvironment({ env: process.env }),
  });
  if (gitHead.error || gitHead.status !== 0) {
    throw new Error('SOURCE_HEAD_UNVERIFIED: Unable to establish the authorized worktree Git HEAD');
  }
  const currentHead = gitHead.stdout.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(currentHead)) {
    throw new Error('SOURCE_HEAD_UNVERIFIED: Git returned an invalid HEAD');
  }
  if (currentHead !== bundle.source_head.toLowerCase()) {
    throw new Error(`STALE_SOURCE_HEAD: Current Git HEAD (${currentHead}) does not match bundle source HEAD (${bundle.source_head})`);
  }

  if (context) {
    validateCoderEditBundle(bundle, { ...context, worktree: resolvedWorktree });
  }

  assertCoderAnchorStable(anchor);

  let totalEditBytes = 0;
  const originals: CoderEditOriginal[] = [];

  // Complete security and size preflight across every proposed edit before
  // any filesystem mutation.  Existing files are read through an opened
  // descriptor and their identity is retained for the commit fence.
  for (const edit of bundle.proposed_edits) {
    const normPath = canonicalRelativePath(edit.path, 'proposed_edits.path');
    const content = Buffer.from(edit.content, 'utf8');
    if (content.byteLength > CODER_EDIT_MAX_BYTES) {
      throw new Error(`CODER_EDIT_LIMIT_EXCEEDED: ${normPath} exceeds ${CODER_EDIT_MAX_BYTES} bytes`);
    }
    totalEditBytes += content.byteLength;
    if (totalEditBytes > CODER_EDIT_TOTAL_MAX_BYTES) {
      throw new Error(`CODER_EDIT_LIMIT_EXCEEDED: proposed edits exceed ${CODER_EDIT_TOTAL_MAX_BYTES} bytes`);
    }

    const dest = path.resolve(resolvedWorktree, normPath);
    try {
      assertPathContained(dest, resolvedWorktree);
    } catch {
      throw new Error(`PATH_TRAVERSAL: ${normPath}`);
    }
    coderPolicyOrThrow(dest, anchor.realPath, normPath, 'write');
    const snapshot = captureCoderPathSnapshot(dest, anchor, { allowMissingLeaf: true });
    let previous: Buffer | undefined;
    if (snapshot.leafIdentity) {
      if (!snapshot.leafIsFile) throw new Error(`CODER_PATH_INVALID: edit target is not a regular file: ${normPath}`);
      previous = readCoderFile(snapshot, anchor, CODER_EDIT_MAX_BYTES);
    }
    originals.push({ path: normPath, absolutePath: dest, content: previous, snapshot });
  }

  const attempted: CoderEditOriginal[] = [];
  try {
    for (let index = 0; index < originals.length; index += 1) {
      const original = originals[index];
      attempted.push(original);
      const replacement = Buffer.from(bundle.proposed_edits[index].content, 'utf8');
      try {
        original.writtenIdentity = writeCoderFileAtomically(original, replacement, anchor);
        original.writtenContent = replacement;
      } catch (error) {
        const replacementIdentity = coderReplacementIdentity(error);
        if (replacementIdentity) {
          original.writtenIdentity = replacementIdentity;
          original.writtenContent = replacement;
        }
        throw error;
      }
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const original of [...attempted].reverse()) {
      try {
        rollbackCoderEdit(original, anchor);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`CODER_EDIT_ROLLBACK_FAILED: ${rollbackErrors.join('; ')}`);
    }
    throw error;
  }

  return { changedFiles: originals.map((entry) => entry.path) };
}

export interface CoderResourceBinding {
  resourceId: string;
  providerId: string;
  providerAccountId: string | null;
  adapterType: 'MANUAL_BRIDGE' | 'LOCAL_CLI' | 'API' | 'MOCK';
  providerEnabled: boolean;
  resourceEnabled: boolean;
  resourceHealth: string;
  capabilities: string[];
  accountEnabled?: boolean | null;
  accountHealth?: string | null;
  accountCooldownUntil?: string | null;
}

function bindingMatches(auth: ExecutionAuthorization, binding?: CoderResourceBinding | null): boolean {
  if (!binding) return false;
  if (binding.resourceId !== auth.selected_resource_id || binding.providerId !== auth.selected_provider_id) return false;
  if (binding.providerAccountId !== (auth.selected_account_id ?? null)) return false;
  return true;
}

function bindingIsAvailable(binding: CoderResourceBinding): boolean {
  if (!binding.providerEnabled || !binding.resourceEnabled) return false;
  if (!binding.capabilities.includes('CODING')) return false;
  if (!['AVAILABLE', 'LOW_QUOTA'].includes(binding.resourceHealth)) return false;
  if (binding.accountEnabled === false) return false;
  if (binding.accountHealth && !['AVAILABLE', 'LOW_QUOTA'].includes(binding.accountHealth)) return false;
  if (binding.accountCooldownUntil) {
    const cooldownUntil = Date.parse(binding.accountCooldownUntil);
    // A malformed cooldown is an unavailable account state. Treating an
    // invalid timestamp as expired would silently route work around the
    // durable capacity decision that produced the binding.
    if (!Number.isFinite(cooldownUntil) || cooldownUntil > Date.now()) return false;
  }
  return true;
}

export function isOmniRouteAuthorization(
  auth: ExecutionAuthorization,
  binding?: CoderResourceBinding | null,
  endpoint?: ProviderEndpointConfig | ProviderEndpointConfig[] | null,
): boolean {
  if (!endpoint) return false;
  const matched = Array.isArray(endpoint)
    ? endpoint.find((ep) =>
      ep.resource_id === auth.selected_resource_id &&
      ep.role === 'CODER' &&
      ep.adapter_type === 'EXTERNAL_ROUTER'
    )
    : (endpoint.resource_id === auth.selected_resource_id &&
      endpoint.role === 'CODER' &&
      endpoint.adapter_type === 'EXTERNAL_ROUTER' ? endpoint : null);
  return !!matched && bindingMatches(auth, binding);
}

export interface AgyCoderIdentity {
  providerId: string;
  resourceId: string;
}

export function isAgyAuthorization(
  auth: ExecutionAuthorization,
  binding?: CoderResourceBinding | null,
  identity?: AgyCoderIdentity | null,
): boolean {
  return !!identity &&
    auth.selected_provider_id === identity.providerId &&
    auth.selected_resource_id === identity.resourceId &&
    bindingMatches(auth, binding) &&
    binding?.adapterType === 'LOCAL_CLI';
}

export type CoderProviderSelection =
  | { provider: 'OMNIROUTE'; error?: never }
  | { provider: 'AGY'; error?: never }
  | { provider: 'NONE'; error: string };

export function resolveCoderProvider(
  auth?: ExecutionAuthorization | null,
  binding?: CoderResourceBinding | null,
  endpoint?: ProviderEndpointConfig | ProviderEndpointConfig[] | null,
  agyIdentity?: AgyCoderIdentity | null,
): CoderProviderSelection {
  if (!auth) {
    return { provider: 'NONE', error: 'AUTHORIZATION_MISSING: ExecutionAuthorization required for coder execution' };
  }
  const isOmni = isOmniRouteAuthorization(auth, binding, endpoint);
  const isAgy = isAgyAuthorization(auth, binding, agyIdentity);
  if (isOmni && isAgy) {
    return {
      provider: 'NONE',
      error: `AUTHORIZATION_AMBIGUOUS: ExecutionAuthorization has conflicting provider selection (${auth.selected_provider_id}/${auth.selected_resource_id})`,
    };
  }
  if (!bindingMatches(auth, binding)) {
    return {
      provider: 'NONE',
      error: `AUTHORIZATION_RESOURCE_BINDING_INVALID: ExecutionAuthorization does not match a registered provider resource (${auth.selected_provider_id}/${auth.selected_resource_id})`,
    };
  }
  if (!bindingIsAvailable(binding!)) {
    return {
      provider: 'NONE',
      error: `AUTHORIZED_CODER_UNAVAILABLE: Selected coder resource is disabled, unhealthy, cooled down, or lacks CODING capability (${auth.selected_provider_id}/${auth.selected_resource_id})`,
    };
  }
  if (isOmni) {
    if (binding!.adapterType !== 'API') {
      return {
        provider: 'NONE',
        error: `AUTHORIZATION_RESOURCE_BINDING_INVALID: Selected OmniRoute resource is not registered to the API adapter (${auth.selected_resource_id})`,
      };
    }
    const targetEndpoint = Array.isArray(endpoint)
      ? endpoint.find((ep) => ep.resource_id === auth.selected_resource_id)
      : endpoint;
    if (!targetEndpoint || !isEndpointEligible(targetEndpoint)) {
      return {
        provider: 'NONE',
        error: `AUTHORIZED_CODER_UNAVAILABLE: Selected OmniRoute endpoint is unavailable or under cooldown (${auth.selected_resource_id})`,
      };
    }
    return { provider: 'OMNIROUTE' };
  }
  if (isAgy) {
    return { provider: 'AGY' };
  }
  return {
    provider: 'NONE',
    error: `AUTHORIZATION_UNKNOWN_PROVIDER: ExecutionAuthorization selects unrecognized coder provider (${auth.selected_provider_id}/${auth.selected_resource_id})`,
  };
}

interface AuthorizedSourceFile {
  path: string;
  content: string;
}

function collectAuthorizedSourceContext(order: WorkOrder): AuthorizedSourceFile[] {
  const anchor = captureCoderAnchor(order.worktree);
  const worktree = anchor.path;
  const forbidden = order.forbidden_paths;
  const candidates = [...new Set([...order.context_files, ...order.allowed_paths])];
  const files = new Map<string, string>();
  let visitedEntries = 0;
  const add = (absolute: string, explicitCandidate: boolean, depth = 0) => {
    visitedEntries += 1;
    if (visitedEntries > CODER_CONTEXT_MAX_ENTRIES) {
      throw new Error(`SOURCE_CONTEXT_LIMIT_EXCEEDED: authorized context exceeds ${CODER_CONTEXT_MAX_ENTRIES} traversed entries`);
    }
    if (depth > CODER_CONTEXT_MAX_DEPTH) {
      throw new Error(`SOURCE_CONTEXT_LIMIT_EXCEEDED: authorized context exceeds ${CODER_CONTEXT_MAX_DEPTH} directory levels`);
    }
    assertCoderAnchorStable(anchor);
    const relative = coderRelativePath(anchor, absolute);
    let snapshot: CoderPathSnapshot;
    try {
      snapshot = captureCoderPathSnapshot(absolute, anchor, { allowMissingLeaf: false });
    } catch (error) {
      // Caller-forbidden paths are silently omitted for compatibility, while
      // centralized sensitive-path policy is always surfaced for an explicit
      // candidate and skipped only while recursively walking a directory.
      if (!explicitCandidate && /CODER_PATH_POLICY_DENIED/i.test(error instanceof Error ? error.message : String(error))) return;
      throw error;
    }
    if (!snapshot.leafIdentity) return;
    if (forbidden.some((entry) => isPathContainedInBoundary(relative, entry))) {
      if (explicitCandidate) {
        throw new Error(`SOURCE_CONTEXT_PATH_INVALID: forbidden source path: ${relative}`);
      }
      return;
    }
    if (snapshot.leafIsDirectory) {
      // Directory enumeration is fenced by an identity check both sides.  A
      // replaced directory therefore fails closed instead of following the
      // replacement into another tree.
      assertCoderSnapshotUnchanged(snapshot, anchor);
      const children: string[] = [];
      let directory: fs.Dir | undefined;
      try {
        directory = fs.opendirSync(absolute);
        while (true) {
          const entry = directory.readSync();
          if (!entry) break;
          children.push(entry.name);
          if (visitedEntries + children.length > CODER_CONTEXT_MAX_ENTRIES) {
            throw new Error(`SOURCE_CONTEXT_LIMIT_EXCEEDED: authorized context exceeds ${CODER_CONTEXT_MAX_ENTRIES} traversed entries`);
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('SOURCE_CONTEXT_LIMIT_EXCEEDED:')) throw error;
        throw new Error(`SOURCE_CONTEXT_PATH_INVALID: directory could not be read: ${relative}`);
      } finally {
        try { directory?.closeSync(); } catch { /* preserve the original read failure */ }
      }
      assertCoderSnapshotUnchanged(snapshot, anchor);
      for (const child of children.sort()) add(path.join(absolute, child), false, depth + 1);
    } else {
      if (!snapshot.leafIsFile) {
        throw new Error(`SOURCE_CONTEXT_PATH_INVALID: source is not a regular file: ${relative}`);
      }
      const key = filesystemPathKey(relative);
      if (!files.has(key)) {
        if (files.size >= CODER_CONTEXT_MAX_FILES) {
          throw new Error(`SOURCE_CONTEXT_LIMIT_EXCEEDED: more than ${CODER_CONTEXT_MAX_FILES} authorized source files`);
        }
        files.set(key, relative);
      }
    }
  };

  for (const candidate of candidates) {
    const relative = canonicalRelativePath(candidate.replace(/^\.\//, ''), 'context_files');
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) {
      throw new Error(`SOURCE_CONTEXT_PATH_INVALID: ${candidate}`);
    }
    const absolute = path.resolve(worktree, relative);
    try {
      assertPathContained(absolute, worktree);
    } catch {
      throw new Error(`SOURCE_CONTEXT_PATH_INVALID: ${relative}`);
    }
    // Policy is evaluated even for a missing final path so a direct `.env`
    // or credentials candidate cannot be used as a future disclosure path.
    coderPolicyOrThrow(absolute, anchor.realPath, relative, 'read');
    try {
      fs.lstatSync(absolute);
    } catch (error) {
      if (coderIsMissing(error)) continue;
      throw new Error(`SOURCE_CONTEXT_PATH_INVALID: ${relative}`);
    }
    add(absolute, true);
  }

  const unique = [...files.values()].sort((left, right) => filesystemPathKey(left).localeCompare(filesystemPathKey(right)));
  if (unique.length > CODER_CONTEXT_MAX_FILES) throw new Error(`SOURCE_CONTEXT_LIMIT_EXCEEDED: more than ${CODER_CONTEXT_MAX_FILES} authorized source files`);
  let totalBytes = 0;
  return unique.map((relative) => {
    const absolute = path.resolve(worktree, relative);
    const snapshot = captureCoderPathSnapshot(absolute, anchor, { allowMissingLeaf: false });
    const buffer = readCoderFile(snapshot, anchor, CODER_CONTEXT_MAX_BYTES);
    totalBytes += buffer.byteLength;
    if (totalBytes > CODER_CONTEXT_MAX_BYTES) throw new Error(`SOURCE_CONTEXT_LIMIT_EXCEEDED: authorized source exceeds ${CODER_CONTEXT_MAX_BYTES} bytes`);
    if (buffer.includes(0)) throw new Error(`SOURCE_CONTEXT_BINARY_UNSUPPORTED: ${relative}`);
    return { path: relative, content: buffer.toString('utf8') };
  });
}

export interface CoderDoctorResult {
  run: ProviderRun;
  compatible: boolean;
  healthState: ProviderEndpointHealthState;
  bundle?: CoderEditBundle;
  error?: string;
}

export class ResponsesCoderEndpointTransport implements CoderEndpointTransport {
  private readonly fetchImpl: FetchLike;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: ResponsesEndpointTransportOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.environment = options.environment ?? process.env;
  }

  private redactContractDiagnostic(configInput: ProviderEndpointConfig, error: unknown): string {
    const config = parseProviderEndpointConfig(configInput);
    const envName = referencedEnvironmentName(config.auth_source);
    const authValue = envName ? this.environment[envName] : undefined;
    return redactEndpointDiagnostics(
      error instanceof Error ? error.message : String(error),
      authValue,
      config.base_url,
    );
  }

  async getHealth(config: ProviderEndpointConfig): Promise<ProviderEndpointHealthState> {
    const probe = await this.contract(config);
    return probe.healthState;
  }

  async getQuota(_config: ProviderEndpointConfig): Promise<QuotaSnapshotInfo> {
    return {
      remaining: null,
      total: null,
      unit: 'ROUTE_REQUESTS',
      source: 'UNKNOWN',
      confidence: 0,
      resetAt: null,
    };
  }

  async cancel(_config: ProviderEndpointConfig, _executionId: string): Promise<void> {
    // Router execution is non-persistent and cancelled by closing connection
  }

  async execute(config: ProviderEndpointConfig, request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    void config;
    void request;
    // Generic ProviderAdapter execution does not carry the durable task,
    // authorization, source HEAD, and path scope needed for coderbundle.v1.
    // Routed coding is therefore available only through executeWorkOrder,
    // where the Supervisor validates and applies the proposal.
    return {
      executionId: crypto.randomUUID(),
      status: 'FAILED',
      error: 'STRUCTURED_WORK_ORDER_REQUIRED: routed coder execution requires durable coderbundle.v1 authority',
      errorCode: 'PROTOCOL_INVALID',
    };
  }

  async executeWorkOrder(
    configInput: ProviderEndpointConfig,
    order: WorkOrder,
    authorizationId: string,
    repairContext?: RepairContextPackage,
  ): Promise<{ run: ProviderRun; bundle?: CoderEditBundle }> {
    let sourceFiles: AuthorizedSourceFile[];
    try {
      sourceFiles = collectAuthorizedSourceContext(order);
    } catch (error) {
      const message = sanitizeAutonomyText(error instanceof Error ? error.message : String(error));
      return { run: failedRun('CONTRACT_INVALID', message, Date.now()) };
    }
    const activeRepairContext = repairContext ?? order.repair_context;
    const isRepair = !!activeRepairContext;
    const prompt = [
      isRepair
        ? 'You are the Agent Forge routed repair coder. You return proposed edits to resolve reviewer findings only; you do not execute tests or edit Git.'
        : 'You are the Agent Forge routed coder. You return proposed edits only; you do not execute tests or edit Git.',
      'Return exactly one JSON object matching coderbundle.v1 and no markdown.',
      'Every proposed edit must specify a relative path within allowed_paths and complete replacement file contents.',
      'Preserve task_id, authorization_id, source_head, and allowed_paths exactly as specified below.',
      ...(isRepair ? [
        'Report addressed_finding_ids, unresolved_finding_ids, implementation_summary, changed_files, and known_risks.',
        'Do not repeat known failed approaches.',
      ] : []),
      JSON.stringify({
        protocol_version: 'coderbundle.v1',
        task_id: order.task_id,
        authorization_id: authorizationId,
        source_head: order.base_sha,
        allowed_paths: order.allowed_paths,
        forbidden_paths: order.forbidden_paths,
        objective: order.objective,
        acceptance_criteria: order.acceptance_criteria,
        context_files: order.context_files,
        authorized_source_files: sourceFiles,
        constraints: order.constraints,
        ...(isRepair ? { repair_context: activeRepairContext } : {}),
      }),
    ].join('\n');

    const result = await this.request(
      configInput,
      prompt,
      isRepair ? RepairCoderBundleJsonSchema : CoderBundleJsonSchema,
    );
    if (result.run.status !== 'SUCCESSFUL_PROCESS_EXIT' || !result.text) {
      return { run: result.run };
    }

    try {
      const bundle = parseCoderEditBundle(result.text);
      validateCoderEditBundle(bundle, {
        taskId: order.task_id,
        authorizationId,
        sourceHead: order.base_sha,
        allowedPaths: order.allowed_paths,
        forbiddenPaths: order.forbidden_paths,
        worktree: order.worktree,
      });
      return { run: result.run, bundle };
    } catch (error) {
      const msg = this.redactContractDiagnostic(configInput, error);
      return {
        run: {
          ...result.run,
          status: 'CONTRACT_INVALID',
          error: msg,
          stderr: msg,
        },
      };
    }
  }

  async contract(configInput: ProviderEndpointConfig): Promise<CoderDoctorResult> {
    const dummyTask = 'doctor-probe';
    const dummyAuth = 'auth-doctor-probe';
    const dummySha = '0'.repeat(40);
    const probePrompt = [
      'You are the Agent Forge coder contract probe.',
      'Return exactly one JSON object matching coderbundle.v1. Do not edit any files.',
      JSON.stringify({
        protocol_version: 'coderbundle.v1',
        task_id: dummyTask,
        authorization_id: dummyAuth,
        source_head: dummySha,
        allowed_paths: ['doctor-probe.txt'],
        proposed_edits: [{ path: 'doctor-probe.txt', content: 'CODER_OK' }],
      }),
    ].join('\n');

    const result = await this.request(configInput, probePrompt);
    if (result.run.status !== 'SUCCESSFUL_PROCESS_EXIT' || !result.text) {
      return {
        run: result.run,
        compatible: false,
        healthState: result.healthState,
        error: result.run.error ?? result.run.stderr,
      };
    }

    try {
      const bundle = parseCoderEditBundle(result.text);
      validateCoderEditBundle(bundle, {
        taskId: dummyTask,
        authorizationId: dummyAuth,
        sourceHead: dummySha,
        allowedPaths: ['doctor-probe.txt'],
        forbiddenPaths: ['.git'],
      });
      if (bundle.proposed_edits.length === 0) throw new Error('ROUTE_CONTRACT_INVALID: probe returned no proposed edits');
      return {
        run: result.run,
        compatible: true,
        healthState: 'AVAILABLE',
        bundle,
      };
    } catch (error) {
      const msg = this.redactContractDiagnostic(configInput, error);
      return {
        run: {
          ...result.run,
          status: 'CONTRACT_INVALID',
          error: msg,
          stderr: msg,
        },
        compatible: false,
        healthState: 'CONTRACT_INVALID',
        error: msg,
      };
    }
  }

  private async request(
    configInput: ProviderEndpointConfig,
    prompt: string,
    schema: Record<string, unknown> = CoderBundleJsonSchema,
  ): Promise<{ run: ProviderRun; text?: string; healthState: ProviderEndpointHealthState }> {
    const started = Date.now();
    let config: ProviderEndpointConfig;
    try {
      config = parseProviderEndpointConfig(configInput);
    } catch {
      return {
        run: failedRun('CONTRACT_INVALID', 'PROVIDER_ENDPOINT_CONFIG_INVALID', started),
        healthState: 'CONTRACT_INVALID',
      };
    }
    if (!config.base_url) {
      return {
        run: failedRun('CONTRACT_INVALID', 'PROVIDER_ENDPOINT_BASE_URL_MISSING', started),
        healthState: 'CONTRACT_INVALID',
      };
    }
    const envName = referencedEnvironmentName(config.auth_source);
    if (!envName) {
      return {
        run: failedRun('AUTH_ERROR', 'PROVIDER_ENDPOINT_AUTH_SOURCE_UNSUPPORTED', started),
        healthState: 'AUTH_ERROR',
      };
    }
    const authValue = this.environment[envName];
    if (!authValue) {
      return {
        run: failedRun('AUTH_ERROR', `PROVIDER_ENDPOINT_AUTH_ENV_MISSING: ${envName}`, started),
        healthState: 'AUTH_ERROR',
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeout_ms);
    try {
      const response = await this.fetchImpl(endpointUrl(config.base_url), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [config.auth_header_name]: authValue,
        },
        credentials: 'omit',
        redirect: 'error',
        body: JSON.stringify({
          model: config.model_or_route,
          input: prompt,
          text: {
            format: {
              type: 'json_schema',
              name: 'coder_edit_bundle',
              strict: true,
              schema,
            },
          },
          store: false,
        }),
        signal: controller.signal,
      });

      assertProviderResponseOrigin(response, endpointUrl(config.base_url));
      const raw = await readResponseTextBounded(response);
      const safeRaw = redactValue(raw, authValue, config.base_url);

      if (response.status === 401 || response.status === 403) {
        return {
          run: failedRun('AUTH_ERROR', `ROUTE_AUTH_ERROR HTTP ${response.status}: ${safeRaw}`, started),
          healthState: 'AUTH_ERROR',
        };
      }
      if (response.status === 402 || (!response.ok && /insufficient[_ -]?quota|capacity.*exhaust|spend.?limit/i.test(safeRaw))) {
        return {
          run: failedRun('QUOTA_OR_RATE_LIMIT', `ROUTE_CAPACITY_EXHAUSTED HTTP ${response.status}: ${safeRaw}`, started),
          healthState: 'CAPACITY_EXHAUSTED',
        };
      }
      if (response.status === 429) {
        return {
          run: failedRun('QUOTA_OR_RATE_LIMIT', `ROUTE_RATE_LIMITED HTTP 429: ${safeRaw}`, started),
          healthState: 'RATE_LIMITED',
        };
      }
      if (!response.ok) {
        return {
          run: failedRun('FAILED_PROCESS_EXIT', `ROUTE_SERVER_FAILURE HTTP ${response.status}: ${safeRaw}`, started),
          healthState: 'DEGRADED',
        };
      }

      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return {
          run: failedRun('CONTRACT_INVALID', 'ROUTE_CONTRACT_INVALID: response was not JSON', started),
          healthState: 'CONTRACT_INVALID',
        };
      }

      const text = outputText(payload);
      if (!text) {
        return {
          run: failedRun('CONTRACT_INVALID', 'ROUTE_CONTRACT_INVALID: no Responses output text', started),
          healthState: 'CONTRACT_INVALID',
        };
      }

      const safeText = redactValue(text, authValue, config.base_url);
      return {
        text,
        healthState: 'AVAILABLE',
        run: {
          status: 'SUCCESSFUL_PROCESS_EXIT',
          exitCode: 0,
          executionId: responseId(payload),
          stdout: safeText,
          stderr: '',
          durationMs: Date.now() - started,
        },
      };
    } catch (error) {
      if (error instanceof ProviderResponseBoundaryError || error instanceof ProviderResponseTooLargeError) {
        return {
          run: failedRun('CONTRACT_INVALID', error.message, started),
          healthState: 'CONTRACT_INVALID',
        };
      }
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          run: failedRun('TIMEOUT', 'ROUTE_TIMEOUT', started),
          healthState: 'OFFLINE',
        };
      }
      return {
        run: failedRun(
          'PROCESS_NOT_FOUND',
          `ROUTE_OFFLINE: ${redactValue(error instanceof Error ? error.message : String(error), authValue, config.base_url)}`,
          started,
        ),
        healthState: 'OFFLINE',
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
