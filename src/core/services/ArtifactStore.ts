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
}

export const defaultArtifactStore = new ArtifactStore();
