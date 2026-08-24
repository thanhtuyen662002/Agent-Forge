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
 * Single authoritative context file path sanitizer.
 * Enforces repository-relative paths only, rejects absolute paths, directory traversal,
 * validates against PolicyService, canonicalizes separators, and sorts deterministically.
 */
export function sanitizeContextFiles(
  contextFiles: string[] = [],
  repositoryRoot: string
): { validFiles: string[]; error?: string } {
  const seen = new Set<string>();
  const validFiles: string[] = [];

  for (const rawPath of contextFiles) {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
      continue;
    }
    const trimmed = rawPath.trim();

    // Reject absolute paths unconditionally
    if (
      path.isAbsolute(trimmed) ||
      /^[a-zA-Z]:/.test(trimmed) ||
      trimmed.startsWith('/') ||
      trimmed.startsWith('\\')
    ) {
      return {
        validFiles: [],
        error: `CONTEXT_PATH_INVALID: Context path "${trimmed}" must be relative to repository root.`,
      };
    }

    // Reject directory traversal
    if (
      trimmed.startsWith('..') ||
      trimmed.includes('../') ||
      trimmed.includes('..\\') ||
      trimmed.split(/[\\/]/).includes('..')
    ) {
      return {
        validFiles: [],
        error: `CONTEXT_PATH_TRAVERSAL: Context path "${trimmed}" violates path containment.`,
      };
    }

    // Ensure resolved path does not escape repository root
    const normalizedRepo = path.resolve(repositoryRoot);
    const resolvedPath = path.resolve(normalizedRepo, trimmed);
    if (!resolvedPath.startsWith(normalizedRepo + path.sep) && resolvedPath !== normalizedRepo) {
      return {
        validFiles: [],
        error: `CONTEXT_PATH_TRAVERSAL: Context path "${trimmed}" resolves outside repository root.`,
      };
    }

    // Check against PolicyService
    const policyResult = PolicyService.evaluatePathAccess(resolvedPath, normalizedRepo, false);
    if (!policyResult.allowed) {
      return {
        validFiles: [],
        error: `CONTEXT_PATH_DENIED: Context path "${trimmed}" rejected: ${policyResult.reason}`,
      };
    }

    // Canonicalize separators to '/'
    const canonicalRel = trimmed.split(/[\\/]/).filter((seg) => seg.length > 0).join('/');
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
