import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ArtifactIntegrityError, ArtifactStore } from '../src/core/services/ArtifactStore';

describe('ArtifactStore', () => {
  const testDir = path.resolve(process.cwd(), '.test-artifacts');

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should store small payload inline in evidence record', () => {
    const store = new ArtifactStore(testDir, 1024); // 1KB threshold
    const smallPayload = 'Small test output';

    const evidence = store.store(
      'ev-1',
      'proj-1',
      'task-1',
      'att-1',
      'TEST_RESULT',
      'Unit test run',
      smallPayload
    );

    expect(evidence.storage_type).toBe('INLINE');
    expect(evidence.raw_payload).toBe(smallPayload);
    expect(evidence.file_path).toBeNull();

    const readBack = store.read(evidence);
    expect(readBack).toBe(smallPayload);
  });

  it('should store large payload on disk and verify SHA-256 integrity on read', () => {
    const store = new ArtifactStore(testDir, 100); // 100 bytes threshold
    const largePayload = 'A'.repeat(500);

    const evidence = store.store(
      'ev-2',
      'proj-1',
      'task-1',
      'att-1',
      'GIT_DIFF',
      'Large git diff',
      largePayload
    );

    expect(evidence.storage_type).toBe('FILE');
    expect(evidence.raw_payload).toBeNull();
    expect(evidence.file_path).not.toBeNull();
    expect(fs.existsSync(evidence.file_path!)).toBe(true);

    const readBack = store.read(evidence);
    expect(readBack).toBe(largePayload);
  });

  it('uses a bounded anchored read and rejects malformed UTF-8', () => {
    const store = new ArtifactStore(testDir, 0);
    fs.mkdirSync(testDir, { recursive: true });
    const invalidPath = path.join(testDir, 'invalid.bin');
    const invalidBytes = Buffer.from([0xc3, 0x28]);
    fs.writeFileSync(invalidPath, invalidBytes);
    const evidence = {
      id: 'ev-invalid-utf8',
      project_id: 'proj-1',
      task_id: 'task-1',
      attempt_id: null,
      evidence_type: 'FILE_SNAPSHOT' as const,
      storage_type: 'FILE' as const,
      file_path: invalidPath,
      hash: crypto.createHash('sha256').update(invalidBytes).digest('hex'),
      byte_size: invalidBytes.length,
      content_type: 'text/plain',
      summary: 'invalid',
      raw_payload: null,
      created_at: new Date().toISOString(),
    };

    expect(() => store.readText(evidence)).toThrow(ArtifactIntegrityError);
    expect(() => store.readText(evidence)).toThrow(/not valid UTF-8/);

    const oversized = Buffer.alloc(10, 0x61);
    const oversizedPath = path.join(testDir, 'oversized.bin');
    fs.writeFileSync(oversizedPath, oversized);
    const oversizedEvidence = {
      ...evidence,
      id: 'ev-oversized',
      file_path: oversizedPath,
      hash: crypto.createHash('sha256').update(oversized).digest('hex'),
      byte_size: oversized.length,
    };
    expect(() => store.readText(oversizedEvidence, 4)).toThrow(/ARTIFACT_SIZE_EXCEEDED/);
  });

  it('validates inline evidence bytes before returning a projection payload', () => {
    const store = new ArtifactStore(testDir);
    const evidence = {
      id: 'ev-inline-invalid',
      project_id: 'proj-1',
      task_id: 'task-1',
      attempt_id: null,
      evidence_type: 'TEST_RESULT' as const,
      storage_type: 'INLINE' as const,
      file_path: null,
      hash: '0'.repeat(64),
      byte_size: 3,
      content_type: 'text/plain',
      summary: 'invalid',
      raw_payload: 'abc',
      created_at: new Date().toISOString(),
    };

    expect(() => store.readText(evidence)).toThrow(/inline evidence.*hash or byte size mismatch/i);
  });
});
