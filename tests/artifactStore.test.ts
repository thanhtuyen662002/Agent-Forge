import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ArtifactStore } from '../src/core/services/ArtifactStore';

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
});
