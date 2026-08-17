import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Evidence, EvidenceType, EvidenceStorageType } from '../types/domain';

export class ArtifactStore {
  private baseDir: string;
  private thresholdBytes: number;

  constructor(customBaseDir?: string, thresholdBytes: number = 32 * 1024) {
    this.baseDir = customBaseDir ?? path.resolve(process.cwd(), '.agent-forge', 'artifacts');
    this.thresholdBytes = thresholdBytes;

    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  public setBaseDir(customBaseDir: string): void {
    this.baseDir = customBaseDir;
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
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

    const filePath = path.join(this.baseDir, `${hash}.bin`);
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
