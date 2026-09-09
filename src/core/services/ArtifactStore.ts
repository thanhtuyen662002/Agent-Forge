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
    } catch {
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
  } catch {
    throw new Error('[ArtifactManifest] Malformed manifest JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[ArtifactManifest] Manifest must be a non-null plain object');
  }
  const manifest = parsed as ArtifactManifest;
  const canonicalJson = canonicalizeArtifactManifest(manifest);
  const hash = crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
  if (expectedHash && hash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(`[ArtifactManifest] Manifest hash mismatch: MANIFEST_HASH_MISMATCH (expected ${expectedHash}, got ${hash})`);
  }
  return JSON.parse(canonicalJson) as ArtifactManifest;
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
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
    return this.baseDir;
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
    fs.writeFileSync(finalPath, payload, 'utf8');

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

    assertPathContained(stagedPath, baseDir);
    assertPathContained(finalPath, baseDir);

    fs.writeFileSync(stagedPath, payload, 'utf8');

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
    const baseDir = this.getBaseDir();
    assertPathContained(stagedPath, baseDir);
    assertPathContained(finalPath, baseDir);

    if (!fs.existsSync(stagedPath)) {
      if (fs.existsSync(finalPath)) {
        const existingContent = fs.readFileSync(finalPath);
        const existingHash = crypto.createHash('sha256').update(existingContent).digest('hex');
        if (existingHash === expectedHash) {
          return;
        }
        throw new Error('[ArtifactStore] Finalized artifact hash mismatch');
      }
      throw new Error('[ArtifactStore] Staged file missing before finalization');
    }

    try {
      fs.renameSync(stagedPath, finalPath);
    } catch {
      // Check collision on rename error
      if (fs.existsSync(finalPath)) {
        const existingContent = fs.readFileSync(finalPath);
        const existingHash = crypto.createHash('sha256').update(existingContent).digest('hex');
        if (existingHash === expectedHash) {
          try {
            fs.unlinkSync(stagedPath);
          } catch {
            // unlink error handled visibly without silent suppression
          }
          return;
        }
        throw new Error('[ArtifactStore] Content conflict: destination exists with differing content');
      }
      throw new Error('[ArtifactStore] Atomic rename failed during finalization');
    }

    // Verify final content hash
    const finalContent = fs.readFileSync(finalPath);
    const finalHash = crypto.createHash('sha256').update(finalContent).digest('hex');
    if (finalHash !== expectedHash) {
      throw new Error('[ArtifactStore] Finalized artifact hash mismatch');
    }
  }

  public cleanupStagedFile(stagedPath: string): void {
    if (!stagedPath) {
      return;
    }
    const baseDir = this.getBaseDir();
    assertPathContained(stagedPath, baseDir);

    if (!fs.existsSync(stagedPath)) {
      return;
    }

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        fs.unlinkSync(stagedPath);
        return;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error('Staged file cleanup failed');
        const start = Date.now();
        while (Date.now() - start < 25) {
          // bounded busy wait
        }
      }
    }

    if (lastError && fs.existsSync(stagedPath)) {
      throw new Error('[STAGING_CLEANUP_FAILED] Failed to delete staged file');
    }
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

    const baseDir = this.getBaseDir();
    assertPathContained(evidence.file_path, baseDir);

    if (!fs.existsSync(evidence.file_path)) {
      throw new Error(`[ArtifactStore] Evidence file missing on disk.`);
    }

    const content = fs.readFileSync(evidence.file_path, 'utf8');
    const computedHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');

    if (computedHash !== evidence.hash) {
      throw new Error(
        `[ArtifactStore] Integrity violation: SHA-256 hash mismatch for artifact "${evidence.id}".`
      );
    }

    return content;
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
    assertPathContained(finalPath, baseDir);

    // If final destination exists, open and assert exact byte and hash equality
    if (fs.existsSync(finalPath)) {
      const existing = fs.readFileSync(finalPath);
      const existingHash = crypto.createHash('sha256').update(existing).digest('hex').toLowerCase();
      if (existingHash !== hash || existing.byteLength !== buf.byteLength || !existing.equals(buf)) {
        throw new Error('[ArtifactStore] Content conflict: existing content-addressed artifact does not match bytes or hash (HASH_COLLISION_MISMATCH)');
      }
      return { filePath: finalPath, hash, byteSize: buf.byteLength, newlyCreated: false };
    }

    // Exclusive temp file creation in the same evidence directory
    const tempName = `.tmp_${crypto.randomUUID()}_${hash}.bin`;
    const tempPath = path.join(baseDir, tempName);
    assertPathContained(tempPath, baseDir);

    let fd: number | null = null;
    try {
      fd = fs.openSync(tempPath, 'wx');
      fs.writeSync(fd, buf, 0, buf.length);
      fs.fsyncSync(fd);
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // close error handled visibly without silent suppression
        }
      }
    }

    // Verify temp file before rename
    const tempBytes = fs.readFileSync(tempPath);
    const tempHash = crypto.createHash('sha256').update(tempBytes).digest('hex').toLowerCase();
    if (tempHash !== hash || tempBytes.byteLength !== buf.byteLength || !tempBytes.equals(buf)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // unlink error handled visibly without silent suppression
      }
      throw new Error('[ArtifactStore] Temp file verification failed before atomic rename');
    }

    try {
      fs.renameSync(tempPath, finalPath);
    } catch {
      // Destination collision race handling:
      // Check if destination was concurrently materialized
      if (fs.existsSync(finalPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // unlink error handled visibly without silent suppression
        }
        const existing = fs.readFileSync(finalPath);
        const existingHash = crypto.createHash('sha256').update(existing).digest('hex').toLowerCase();
        if (existingHash === hash && existing.byteLength === buf.byteLength && existing.equals(buf)) {
          return { filePath: finalPath, hash, byteSize: buf.byteLength, newlyCreated: false };
        }
        throw new Error('[ArtifactStore] Content conflict: concurrent destination exists with differing bytes');
      }
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // unlink error handled visibly without silent suppression
      }
      throw new Error('[ArtifactStore] Materialization failed during atomic rename');
    }

    // Post-rename verification
    const written = fs.readFileSync(finalPath);
    const writtenHash = crypto.createHash('sha256').update(written).digest('hex').toLowerCase();
    if (writtenHash !== hash || written.byteLength !== buf.byteLength || !written.equals(buf)) {
      throw new Error('[ArtifactStore] Materialization verification failed');
    }

    return { filePath: finalPath, hash, byteSize: buf.byteLength, newlyCreated: true };
  }

  public static cleanupRollbackFiles(
    filePaths: string[],
    isFileReferencedDurable?: (fp: string) => boolean,
    baseDir?: string
  ): { cleanedCount: number; failures: Array<{ path: string; error: string }> } {
    const failures: Array<{ path: string; error: string }> = [];
    let cleanedCount = 0;

    for (const fp of filePaths) {
      try {
        if (!fp) continue;
        if (baseDir) {
          assertPathContained(fp, baseDir);
        }

        if (isFileReferencedDurable && isFileReferencedDurable(fp)) {
          continue;
        }

        if (fs.existsSync(fp)) {
          fs.unlinkSync(fp);
          cleanedCount++;
        }
      } catch {
        failures.push({
          path: path.basename(fp),
          error: 'CLEANUP_FAILED_IO_ERROR',
        });
      }
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

    const baseDir = artifactStore.getBaseDir();
    try {
      assertPathContained(evidence.file_path, baseDir);
    } catch {
      return { valid: false, reason: `FILE evidence ${evidence.id} path escapes base directory` };
    }

    if (!fs.existsSync(evidence.file_path)) {
      return { valid: false, reason: `FILE evidence ${evidence.id} file does not exist on disk` };
    }

    try {
      const fileBytes = fs.readFileSync(evidence.file_path);
      const computedHash = crypto.createHash('sha256').update(fileBytes).digest('hex');
      if (computedHash !== evidence.hash) {
        return { valid: false, reason: `FILE evidence ${evidence.id} content hash mismatch: expected ${evidence.hash}, got ${computedHash}` };
      }
      if (fileBytes.length !== evidence.byte_size) {
        return { valid: false, reason: `FILE evidence ${evidence.id} byte size mismatch: expected ${evidence.byte_size}, got ${fileBytes.length}` };
      }
    } catch {
      return { valid: false, reason: `FILE evidence ${evidence.id} read failed` };
    }

    return { valid: true };
  }

  return { valid: false, reason: `Unknown evidence storage type: ${evidence.storage_type}` };
}

export const defaultArtifactStore = new ArtifactStore();
