import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Evidence, EvidenceType, EvidenceStorageType } from '../types/domain';

export class ArtifactStore {
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
    const filePath = path.join(baseDir, `${hash}.bin`);
    fs.writeFileSync(filePath, payload, 'utf8');

    return {
      id,
      project_id: projectId,
      task_id: taskId,
      attempt_id: attemptId,
      evidence_type: evidenceType,
      storage_type: 'FILE',
      file_path: filePath,
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
    if (!fs.existsSync(stagedPath)) {
      if (fs.existsSync(finalPath)) {
        // Already finalized
        const existingContent = fs.readFileSync(finalPath);
        const existingHash = crypto.createHash('sha256').update(existingContent).digest('hex');
        if (existingHash === expectedHash) {
          return;
        }
      }
      throw new Error(`[ArtifactStore] Staged file missing before finalization: "${stagedPath}".`);
    }

    // Move or copy to final path
    try {
      fs.renameSync(stagedPath, finalPath);
    } catch {
      // Fallback to copy and unlink
      fs.copyFileSync(stagedPath, finalPath);
      fs.unlinkSync(stagedPath);
    }

    // Verify final content hash
    const finalContent = fs.readFileSync(finalPath);
    const finalHash = crypto.createHash('sha256').update(finalContent).digest('hex');
    if (finalHash !== expectedHash) {
      throw new Error(
        `[ArtifactStore] Finalized artifact hash mismatch: expected ${expectedHash}, got ${finalHash}`
      );
    }
  }

  public cleanupStagedFile(stagedPath: string): void {
    if (!stagedPath || !fs.existsSync(stagedPath)) {
      return;
    }

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        fs.unlinkSync(stagedPath);
        return;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Bounded busy wait backoff
        const start = Date.now();
        while (Date.now() - start < 25) {
          // busy wait
        }
      }
    }

    if (lastError && fs.existsSync(stagedPath)) {
      throw new Error(`[STAGING_CLEANUP_FAILED] Failed to delete staged file "${stagedPath}": ${lastError.message}`);
    }
  }

  public read(evidence: Evidence): string {
    if (evidence.storage_type === 'INLINE') {
      if (evidence.raw_payload === null) {
        throw new Error(`[ArtifactStore] Evidence ${evidence.id} is marked INLINE but has null payload.`);
      }
      return evidence.raw_payload;
    }

    if (!evidence.file_path || !fs.existsSync(evidence.file_path)) {
      throw new Error(`[ArtifactStore] Evidence file missing on disk: "${evidence.file_path}".`);
    }

    const content = fs.readFileSync(evidence.file_path, 'utf8');
    const computedHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');

    if (computedHash !== evidence.hash) {
      throw new Error(
        `[ArtifactStore] Integrity violation: SHA-256 hash mismatch for artifact "${evidence.id}". Expected ${evidence.hash}, found ${computedHash}.`
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
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    if (expectedHash && hash !== expectedHash) {
      throw new Error(`[ArtifactStore] Hash mismatch before materialization: expected ${expectedHash}, computed ${hash}`);
    }

    const finalPath = path.join(baseDir, `${hash}.bin`);

    // Path containment check
    const normalizedFinal = path.resolve(finalPath);
    const normalizedBase = path.resolve(baseDir);
    if (!normalizedFinal.startsWith(normalizedBase)) {
      throw new Error(`[ArtifactStore] Security violation: Path escape detected (${finalPath})`);
    }

    if (fs.existsSync(finalPath)) {
      // Check existing content identity
      const existing = fs.readFileSync(finalPath);
      const existingHash = crypto.createHash('sha256').update(existing).digest('hex');
      if (existingHash !== hash || existing.length !== buf.length) {
        throw new Error(`[ArtifactStore] Content conflict at ${finalPath}: hash mismatch for existing content-addressed artifact`);
      }
      return { filePath: finalPath, hash, byteSize: buf.length, newlyCreated: false };
    }

    // Atomic write via temp file in same directory
    const tempName = `.tmp_${crypto.randomUUID()}_${hash}.bin`;
    const tempPath = path.join(baseDir, tempName);
    fs.writeFileSync(tempPath, buf);

    try {
      fs.renameSync(tempPath, finalPath);
    } catch (renameErr: unknown) {
      // Fallback for Windows file system rename conflicts
      if (fs.existsSync(finalPath)) {
        const existing = fs.readFileSync(finalPath);
        const existingHash = crypto.createHash('sha256').update(existing).digest('hex');
        if (existingHash === hash) {
          try {
            fs.unlinkSync(tempPath);
          } catch (unlinkErr: unknown) {
            console.debug(`[ArtifactStore] Note: unable to remove temporary file ${tempPath}: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`);
          }
          return { filePath: finalPath, hash, byteSize: buf.length, newlyCreated: false };
        }
      }
      fs.copyFileSync(tempPath, finalPath);
      try {
        fs.unlinkSync(tempPath);
      } catch (unlinkErr: unknown) {
        console.debug(`[ArtifactStore] Note: unable to remove temporary file ${tempPath}: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`);
      }
    }

    // Reverification of finalized file
    const written = fs.readFileSync(finalPath);
    const writtenHash = crypto.createHash('sha256').update(written).digest('hex');
    if (writtenHash !== hash) {
      throw new Error(`[ArtifactStore] Materialization corrupted for ${finalPath}: expected ${hash}, read ${writtenHash}`);
    }

    return { filePath: finalPath, hash, byteSize: buf.length, newlyCreated: true };
  }

  public cleanupRollbackFiles(
    filePaths: string[],
    isFileReferencedDurable: (fp: string) => boolean
  ): { cleanedCount: number; failures: string[] } {
    const failures: string[] = [];
    let cleanedCount = 0;
    const baseDir = this.getBaseDir();
    const normalizedBase = path.resolve(baseDir);

    for (const fp of filePaths) {
      try {
        if (!fp) continue;
        const normalizedFp = path.resolve(fp);
        if (!normalizedFp.startsWith(normalizedBase)) {
          failures.push('Security: path outside baseDir: [REDACTED_PATH]');
          continue;
        }

        // Prove that no durable evidence row references this file
        if (isFileReferencedDurable(fp)) {
          continue;
        }

        if (fs.existsSync(fp)) {
          fs.unlinkSync(fp);
          cleanedCount++;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`Cleanup error: [REDACTED_ERROR]`);
      }
    }
    return { cleanedCount, failures };
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

    // Path containment check
    const baseDir = artifactStore.getBaseDir();
    const resolvedPath = path.resolve(evidence.file_path);
    const resolvedBase = path.resolve(baseDir);
    if (!resolvedPath.startsWith(resolvedBase)) {
      return { valid: false, reason: `FILE evidence ${evidence.id} path escapes base directory` };
    }

    if (!fs.existsSync(resolvedPath)) {
      return { valid: false, reason: `FILE evidence ${evidence.id} file does not exist on disk` };
    }

    // Symlink escape check
    try {
      const lstat = fs.lstatSync(resolvedPath);
      if (lstat.isSymbolicLink()) {
        const real = fs.realpathSync(resolvedPath);
        if (!real.startsWith(resolvedBase)) {
          return { valid: false, reason: `FILE evidence ${evidence.id} symlink escapes base directory` };
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, reason: `FILE evidence ${evidence.id} file access error: ${msg}` };
    }

    try {
      const fileBytes = fs.readFileSync(resolvedPath);
      const computedHash = crypto.createHash('sha256').update(fileBytes).digest('hex');
      if (computedHash !== evidence.hash) {
        return { valid: false, reason: `FILE evidence ${evidence.id} content hash mismatch: expected ${evidence.hash}, got ${computedHash}` };
      }
      if (fileBytes.length !== evidence.byte_size) {
        return { valid: false, reason: `FILE evidence ${evidence.id} byte size mismatch: expected ${evidence.byte_size}, got ${fileBytes.length}` };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, reason: `FILE evidence ${evidence.id} read failed: ${msg}` };
    }

    return { valid: true };
  }

  return { valid: false, reason: `Unknown evidence storage type: ${evidence.storage_type}` };
}

export const defaultArtifactStore = new ArtifactStore();
