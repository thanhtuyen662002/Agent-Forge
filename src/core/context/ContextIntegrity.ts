import crypto from 'crypto';
import path from 'path';
import { PolicyService } from '../services/PolicyService';
import {
  ContextSnapshot,
  ContextItem,
  ContextManifest,
} from '../types/domain';

export function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Deterministically stringifies an object by recursively sorting its keys using code-unit comparison.
 */
export function canonicalJsonStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return '[' + obj.map((item) => canonicalJsonStringify(item)).join(',') + ']';
  }

  const keys = Object.keys(obj as Record<string, unknown>).sort(codeUnitCompare);
  const pairs = keys.map((key) => {
    const val = (obj as Record<string, unknown>)[key];
    return JSON.stringify(key) + ':' + canonicalJsonStringify(val);
  });
  return '{' + pairs.join(',') + '}';
}

/**
 * Computes SHA-256 hash of a string in UTF-8 encoding.
 */
export function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Stable error codes used by the portable context path boundary.  These errors
 * deliberately do not include the untrusted path value: context paths can
 * contain secret-bearing names and are often persisted in rejection events.
 */
export type ContextPathErrorCode =
  | 'CONTEXT_PATH_INVALID'
  | 'CONTEXT_PATH_TRAVERSAL'
  | 'CONTEXT_PATH_AMBIGUOUS'
  | 'CONTEXT_PATH_ALIAS'
  | 'CONTEXT_PATH_RESERVED'
  | 'CONTEXT_PATH_LIMIT_EXCEEDED';

export class ContextPathError extends Error {
  public readonly code: ContextPathErrorCode;

  public constructor(code: ContextPathErrorCode, reason: string) {
    super(`${code}: ${reason}`);
    this.name = 'ContextPathError';
    this.code = code;
  }
}

// These bounds are intentionally independent of the host platform.  A
// manifest created on POSIX can later be dispatched on Windows, so accepting a
// path that only one filesystem can represent would make the manifest
// non-portable and would make authorization depend on where it is consumed.
export const PORTABLE_CONTEXT_PATH_MAX_LENGTH = 4096;
export const PORTABLE_CONTEXT_PATH_MAX_COMPONENTS = 128;
export const PORTABLE_CONTEXT_PATH_MAX_COMPONENT_LENGTH = 255;

const PORTABLE_RESERVED_DEVICE_NAMES = new Set([
  'AUX',
  'CLOCK$',
  'CON',
  'CONIN$',
  'CONOUT$',
  'NUL',
  'PRN',
]);

function isPortableReservedDeviceComponent(component: string): boolean {
  // Windows treats a device name as reserved even when an extension follows
  // it (for example, `CON.txt`).  Superscript 1/2/3 are also accepted by the
  // Windows device-name parser for COM/LPT aliases.
  const stem = component.split('.')[0].toUpperCase();
  if (PORTABLE_RESERVED_DEVICE_NAMES.has(stem)) return true;
  return /^(?:COM|LPT)(?:[1-9]|[¹²³])$/.test(stem);
}

/**
 * Canonicalize one context path without touching the filesystem.
 *
 * The returned value always uses `/` separators and contains only explicit,
 * non-empty ordinary relative components.  The function is deliberately
 * lexical: callers must still perform lstat/realpath/identity checks immediately
 * before reading, because canonicalization alone cannot fence a filesystem
 * race or a reparse point.
 */
export function canonicalizePortableRelativePath(rawPath: unknown): string {
  if (typeof rawPath !== 'string') {
    throw new ContextPathError('CONTEXT_PATH_INVALID', 'context paths must be strings');
  }
  if (rawPath.length === 0 || rawPath.trim().length === 0) {
    throw new ContextPathError('CONTEXT_PATH_INVALID', 'context paths must be non-empty');
  }
  if (rawPath.length > PORTABLE_CONTEXT_PATH_MAX_LENGTH) {
    throw new ContextPathError('CONTEXT_PATH_LIMIT_EXCEEDED', 'context path exceeds the portable length limit');
  }
  // Trimming would silently authorize a different filename.  Reject leading
  // and trailing whitespace instead of changing the manifest's meaning.
  if (rawPath !== rawPath.trim()) {
    if (rawPath.startsWith(' ') || rawPath.startsWith('\t')) {
      throw new ContextPathError('CONTEXT_PATH_AMBIGUOUS', 'context paths cannot have surrounding whitespace');
    }
    // A trailing space is a Windows trailing-space alias, so retain the more
    // specific error class used for component-level trailing aliases.
    if (rawPath.endsWith(' ') || rawPath.endsWith('.')) {
      throw new ContextPathError('CONTEXT_PATH_ALIAS', 'trailing dot and space aliases are not portable');
    }
    throw new ContextPathError('CONTEXT_PATH_AMBIGUOUS', 'context paths cannot have surrounding whitespace');
  }
  if (/[\u0000-\u001f\u007f]/.test(rawPath)) {
    throw new ContextPathError('CONTEXT_PATH_INVALID', 'context paths cannot contain control characters');
  }

  const hasForwardSeparators = rawPath.includes('/');
  const hasBackwardSeparators = rawPath.includes('\\');
  if (hasForwardSeparators && hasBackwardSeparators) {
    throw new ContextPathError('CONTEXT_PATH_AMBIGUOUS', 'mixed path separators are not portable');
  }

  // Check the original spelling before converting separators.  This makes
  // UNC, drive-relative, and extended-length Windows forms unambiguously
  // invalid on every host.
  if (
    rawPath.startsWith('/') ||
    rawPath.startsWith('\\') ||
    rawPath.startsWith('\\\\?\\') ||
    rawPath.startsWith('\\\\.\\') ||
    rawPath.startsWith('//?/') ||
    rawPath.startsWith('//./')
  ) {
    throw new ContextPathError(
      'CONTEXT_PATH_INVALID',
      'must be relative to repository root; absolute, UNC, or extended-length paths are not allowed',
    );
  }
  // A colon anywhere is either a drive/drive-relative path or an alternate
  // data stream component.  Neither form is a portable regular file path.
  if (rawPath.includes(':')) {
    throw new ContextPathError(
      'CONTEXT_PATH_INVALID',
      'must be relative to repository root; drive and alternate data stream paths are not allowed',
    );
  }

  let canonical = rawPath.replace(/\\/g, '/');
  // Preserve the historical manifest spelling for one harmless leading
  // `./` alias by canonicalizing it away.  Interior dot components and
  // repeated `./` aliases remain rejected below because they can hide a
  // different path after a platform normalization step.
  if (canonical.startsWith('./')) {
    canonical = canonical.slice(2);
  }
  const components = canonical.split('/');
  if (canonical.length === 0) {
    throw new ContextPathError('CONTEXT_PATH_INVALID', 'context paths must be non-empty');
  }
  if (components.length > PORTABLE_CONTEXT_PATH_MAX_COMPONENTS) {
    throw new ContextPathError('CONTEXT_PATH_LIMIT_EXCEEDED', 'context path contains too many components');
  }
  if (components.some((component) => component.length === 0)) {
    throw new ContextPathError('CONTEXT_PATH_AMBIGUOUS', 'context paths cannot contain empty or repeated components');
  }

  for (const component of components) {
    if (component === '.') {
      throw new ContextPathError('CONTEXT_PATH_AMBIGUOUS', 'dot components are not portable aliases');
    }
    if (component === '..') {
      throw new ContextPathError('CONTEXT_PATH_TRAVERSAL', 'violates path containment; parent traversal is not allowed');
    }
    if (component.length > PORTABLE_CONTEXT_PATH_MAX_COMPONENT_LENGTH) {
      throw new ContextPathError('CONTEXT_PATH_LIMIT_EXCEEDED', 'a context path component exceeds the portable length limit');
    }
    if (component.endsWith('.') || component.endsWith(' ')) {
      throw new ContextPathError('CONTEXT_PATH_ALIAS', 'trailing dot and space aliases are not portable');
    }
    // Filesystems with Unicode normalization can make two different strings
    // address one object.  Requiring NFC avoids authorizing one spelling and
    // later reading another after a cross-platform handoff.
    if (component.normalize('NFC') !== component) {
      throw new ContextPathError('CONTEXT_PATH_ALIAS', 'non-canonical Unicode aliases are not portable');
    }
    if (isPortableReservedDeviceComponent(component)) {
      throw new ContextPathError('CONTEXT_PATH_RESERVED', 'reserved device names are not allowed');
    }
  }

  return canonical;
}

/**
 * Single authoritative context file path sanitizer.
 * Enforces repository-relative paths only, rejects absolute paths, directory traversal,
 * validates against PolicyService, canonicalizes separators, and sorts deterministically.
 */
export function sanitizeContextFiles(
  contextFiles: string[] = [],
  repositoryRoot: string
): { validFiles: string[]; error?: string } {
  const seen = new Set<string>();
  // A Windows/macOS case-insensitive volume can resolve two spellings to one
  // file.  Reject those aliases instead of silently deduplicating one of them;
  // POSIX keeps its normal case-sensitive semantics.
  const seenCaseInsensitive = new Map<string, string>();
  const validFiles: string[] = [];

  for (const rawPath of contextFiles) {
    let canonicalRel: string;
    try {
      // This must remain the first operation involving the user-controlled
      // path.  In particular, do not call path.resolve, lstat, or realpath
      // before the portable lexical checks have completed.
      canonicalRel = canonicalizePortableRelativePath(rawPath);
    } catch (error) {
      if (error instanceof ContextPathError) {
        return { validFiles: [], error: error.message };
      }
      return { validFiles: [], error: 'CONTEXT_PATH_INVALID: context path could not be canonicalized safely' };
    }

    // Ensure resolved path does not escape repository root
    const normalizedRepo = path.resolve(repositoryRoot);
    const resolvedPath = path.resolve(normalizedRepo, canonicalRel);
    if (!resolvedPath.startsWith(normalizedRepo + path.sep) && resolvedPath !== normalizedRepo) {
      return {
        validFiles: [],
        error: 'CONTEXT_PATH_TRAVERSAL: violates path containment; context path resolves outside repository root',
      };
    }

    // Check against PolicyService
    const policyResult = PolicyService.evaluateRealPathAccess(resolvedPath, normalizedRepo, false);
    if (!policyResult.allowed) {
      return {
        validFiles: [],
        error: `CONTEXT_PATH_DENIED: context path rejected by policy: ${policyResult.reason}`,
      };
    }

    if (process.platform === 'win32' || process.platform === 'darwin') {
      const folded = canonicalRel.toLocaleLowerCase('en-US');
      const prior = seenCaseInsensitive.get(folded);
      if (prior !== undefined && prior !== canonicalRel) {
        return {
          validFiles: [],
          error: 'CONTEXT_PATH_ALIAS: case-colliding context path aliases are not allowed on this filesystem',
        };
      }
      seenCaseInsensitive.set(folded, canonicalRel);
    }
    if (!seen.has(canonicalRel)) {
      seen.add(canonicalRel);
      validFiles.push(canonicalRel);
    }
  }

  validFiles.sort(codeUnitCompare);
  return { validFiles };
}

export interface SnapshotSummaryDescriptor {
  projectId: string;
  taskId: string;
  attemptId: string | null;
  assignmentId: string | null;
  purpose: string;
  builderVersion: string;
  items: Array<{
    ordinal: number;
    itemType: string;
    sourceType: string;
    sourceRef: string | null;
    contentHash: string;
  }>;
}

export function computeSnapshotContentHash(descriptor: SnapshotSummaryDescriptor): string {
  return computeSha256(canonicalJsonStringify(descriptor));
}

export interface ManifestDataDescriptor {
  manifest_version: string;
  project_id: string;
  task_id: string;
  attempt_id: string | null;
  assignment_id: string | null;
  purpose: string;
  builder_version: string;
  item_count: number;
  items: Array<{
    ordinal: number;
    item_type: string;
    source_type: string;
    source_ref: string | null;
    content_hash: string;
    token_estimate: number | null;
  }>;
}

export function computeManifestPayloadAndHash(descriptor: ManifestDataDescriptor): {
  manifestJson: string;
  manifestHash: string;
} {
  const manifestJson = canonicalJsonStringify(descriptor);
  const manifestHash = computeSha256(manifestJson);
  return { manifestJson, manifestHash };
}

export interface ContextManifestIntegrityResult {
  valid: boolean;
  error?: string;
  manifest?: ContextManifest;
  snapshot?: ContextSnapshot;
  items?: ContextItem[];
}

export interface MinimalContextRepository {
  getContextManifest(id: string): ContextManifest | null;
  getContextSnapshot(id: string): ContextSnapshot | null;
  getContextItemsBySnapshot(snapshotId: string): ContextItem[];
}

/**
 * Reusable, fail-closed ContextManifest and ContextSnapshot integrity verifier.
 */
export function verifyContextManifestIntegrity(
  repo: MinimalContextRepository,
  manifestIdOrManifest: string | ContextManifest
): ContextManifestIntegrityResult {
  const manifest: ContextManifest | null =
    typeof manifestIdOrManifest === 'string'
      ? repo.getContextManifest(manifestIdOrManifest)
      : manifestIdOrManifest;

  if (!manifest) {
    return {
      valid: false,
      error: `MANIFEST_NOT_FOUND: ContextManifest "${typeof manifestIdOrManifest === 'string' ? manifestIdOrManifest : 'provided'}" not found.`,
    };
  }

  const snapshot = repo.getContextSnapshot(manifest.snapshot_id);
  if (!snapshot) {
    return {
      valid: false,
      error: `SNAPSHOT_NOT_FOUND: ContextSnapshot "${manifest.snapshot_id}" for manifest "${manifest.id}" not found.`,
    };
  }

  const items = repo.getContextItemsBySnapshot(manifest.snapshot_id);

  // 1. Verify item count
  if (manifest.item_count !== items.length) {
    return {
      valid: false,
      error: `ITEM_COUNT_MISMATCH: Manifest specifies item_count ${manifest.item_count} but found ${items.length} items.`,
    };
  }

  // 2. Verify contiguous ordinals 0..item_count-1
  for (let i = 0; i < items.length; i++) {
    if (items[i].ordinal !== i) {
      return {
        valid: false,
        error: `NON_CONTIGUOUS_ORDINALS: Expected item at index ${i} to have ordinal ${i}, found ${items[i].ordinal}.`,
      };
    }
  }

  // 3. Verify each item's content_hash == SHA256(content_json)
  for (const item of items) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(item.content_json);
    } catch {
      return {
        valid: false,
        error: `INVALID_ITEM_JSON: ContextItem "${item.id}" contains invalid content_json.`,
      };
    }

    const recomputedHash = computeSha256(item.content_json);
    if (item.content_hash !== recomputedHash) {
      return {
        valid: false,
        error: `ITEM_HASH_MISMATCH: ContextItem "${item.id}" content_hash "${item.content_hash}" does not match SHA-256 of content_json ("${recomputedHash}").`,
      };
    }
  }

  // 4. Recompute expected ContextSnapshot content_hash
  const expectedSnapshotSummary: SnapshotSummaryDescriptor = {
    projectId: snapshot.project_id,
    taskId: snapshot.task_id,
    attemptId: snapshot.attempt_id,
    assignmentId: snapshot.assignment_id,
    purpose: snapshot.purpose,
    builderVersion: snapshot.builder_version,
    items: items.map((i) => ({
      ordinal: i.ordinal,
      itemType: i.item_type,
      sourceType: i.source_type,
      sourceRef: i.source_ref,
      contentHash: i.content_hash,
    })),
  };

  const expectedSnapshotContentHash = computeSnapshotContentHash(expectedSnapshotSummary);
  if (snapshot.content_hash !== expectedSnapshotContentHash) {
    return {
      valid: false,
      error: `SNAPSHOT_HASH_MISMATCH: ContextSnapshot "${snapshot.id}" content_hash "${snapshot.content_hash}" does not match recomputed hash "${expectedSnapshotContentHash}".`,
    };
  }

  // 5. Recompute expected ContextManifest payload and hash
  const expectedManifestDescriptor: ManifestDataDescriptor = {
    manifest_version: manifest.manifest_version,
    project_id: snapshot.project_id,
    task_id: snapshot.task_id,
    attempt_id: snapshot.attempt_id,
    assignment_id: snapshot.assignment_id,
    purpose: snapshot.purpose,
    builder_version: snapshot.builder_version,
    item_count: items.length,
    items: items.map((i) => ({
      ordinal: i.ordinal,
      item_type: i.item_type,
      source_type: i.source_type,
      source_ref: i.source_ref,
      content_hash: i.content_hash,
      token_estimate: i.token_estimate,
    })),
  };

  const { manifestJson: expectedManifestJson, manifestHash: expectedManifestHash } =
    computeManifestPayloadAndHash(expectedManifestDescriptor);

  if (manifest.manifest_hash !== expectedManifestHash) {
    return {
      valid: false,
      error: `MANIFEST_HASH_MISMATCH: ContextManifest "${manifest.id}" manifest_hash "${manifest.manifest_hash}" does not match recomputed hash "${expectedManifestHash}".`,
    };
  }

  try {
    const parsedManifest = JSON.parse(manifest.manifest_json);
    if (canonicalJsonStringify(parsedManifest) !== expectedManifestJson) {
      return {
        valid: false,
        error: `MANIFEST_JSON_MISMATCH: ContextManifest "${manifest.id}" manifest_json does not match canonical descriptor.`,
      };
    }
  } catch {
    return {
      valid: false,
      error: `INVALID_MANIFEST_JSON: ContextManifest "${manifest.id}" contains invalid manifest_json.`,
    };
  }

  return {
    valid: true,
    manifest,
    snapshot,
    items,
  };
}

/**
 * Cross-object attempt binding consistency validator.
 * Validates that all non-null/non-undefined attempt IDs participating in a durable provenance object agree.
 * Permissive of null/undefined values (which are ignored).
 * Fails closed with deterministic error if more than 1 distinct non-null attempt ID is present.
 */
export function assertConsistentAttemptBindings(
  contextDescription: string,
  bindings: Array<{ label: string; attemptId: string | null | undefined }>
): void {
  const nonNullBindings = bindings.filter(
    (b) => b.attemptId !== null && b.attemptId !== undefined && typeof b.attemptId === 'string' && b.attemptId.trim() !== ''
  );
  const distinctAttempts = Array.from(new Set(nonNullBindings.map((b) => b.attemptId)));
  if (distinctAttempts.length > 1) {
    const details = nonNullBindings.map((b) => `${b.label}: "${b.attemptId}"`).join(', ');
    throw new Error(`[Repository] ${contextDescription} failed: conflicting attempt bindings (${details}).`);
  }
}
