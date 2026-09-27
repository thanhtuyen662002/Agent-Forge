import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  collectRedactedTrialLogs,
  verifyRedactedTrialLogCollectionFile,
} from '../src/core/autonomy/trialLogCollector';

function fixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-trial-logs-'));
}

describe('redacted trial log collector', () => {
  it('collects sorted files, redacts secrets, writes atomically, and verifies', () => {
    const root = fixture();
    try {
      fs.mkdirSync(path.join(root, 'logs', 'nested'), { recursive: true });
      fs.writeFileSync(path.join(root, 'logs', 'z.log'), 'Bearer abcdefghijklmnop\napi_key=super-secret-value\n');
      fs.writeFileSync(path.join(root, 'logs', 'nested', 'a.log'), 'ordinary diagnostic\n');
      const options = {
        rootDir: root,
        inputRelativePaths: ['logs'],
        outputRelativePath: 'evidence/redacted-logs.json',
        collectedAt: '2026-09-27T00:00:00.000Z',
      };

      const first = collectRedactedTrialLogs(options);
      expect(first.collection.files.map((entry) => entry.relativePath)).toEqual([
        'logs/nested/a.log',
        'logs/z.log',
      ]);
      expect(first.collection.files[1].content).toContain('[REDACTED_SECRET]');
      expect(first.collection.files[1].content).not.toContain('Bearer abcdefghijklmnop');
      expect(first.collection.files[1].content).not.toContain('super-secret-value');
      expect(first.collection.totalByteSize).toBeGreaterThan(0);

      const verified = verifyRedactedTrialLogCollectionFile(first.filePath, root);
      expect(verified.sha256).toBe(first.sha256);
      expect(verified.byteSize).toBe(first.byteSize);

      const second = collectRedactedTrialLogs(options);
      expect(second.sha256).toBe(first.sha256);
      expect(second.canonicalJson).toBe(first.canonicalJson);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects traversal, output/input overlap, invalid timestamps, and oversized files', () => {
    const root = fixture();
    try {
      fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(root, 'logs', 'one.log'), 'one');
      expect(() => collectRedactedTrialLogs({
        rootDir: root,
        inputRelativePaths: ['../outside'],
        outputRelativePath: 'evidence/out.json',
      })).toThrow(/TRIAL_LOG_COLLECTION_INVALID/);
      expect(() => collectRedactedTrialLogs({
        rootDir: root,
        inputRelativePaths: ['logs'],
        outputRelativePath: 'logs/collection.json',
      })).toThrow(/output path cannot be inside an input directory/);
      expect(() => collectRedactedTrialLogs({
        rootDir: root,
        inputRelativePaths: ['logs'],
        outputRelativePath: 'evidence/out.json',
        collectedAt: 'not-a-date',
      })).toThrow(/collectedAt/);
      expect(() => collectRedactedTrialLogs({
        rootDir: root,
        inputRelativePaths: ['logs'],
        outputRelativePath: 'evidence/out.json',
        maxBytesPerFile: 2,
      })).toThrow(/exceeds the configured byte limit/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects symlink inputs when the host permits symlink creation', () => {
    const root = fixture();
    const outside = path.join(path.dirname(root), `agent-forge-outside-${path.basename(root)}.log`);
    const link = path.join(root, 'linked.log');
    try {
      fs.writeFileSync(outside, 'outside');
      try {
        fs.symlinkSync(outside, link, process.platform === 'win32' ? 'file' : undefined);
      } catch {
        return;
      }
      expect(() => collectRedactedTrialLogs({
        rootDir: root,
        inputRelativePaths: ['linked.log'],
        outputRelativePath: 'evidence/out.json',
      })).toThrow(/symbolic link|junction/i);
    } finally {
      try { fs.unlinkSync(link); } catch { /* already absent */ }
      try { fs.unlinkSync(outside); } catch { /* already absent */ }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a tampered collection and a conflicting overwrite', () => {
    const root = fixture();
    try {
      fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(root, 'logs', 'one.log'), 'one');
      const options = {
        rootDir: root,
        inputRelativePaths: ['logs/one.log'],
        outputRelativePath: 'evidence/out.json',
        collectedAt: '2026-09-27T00:00:00.000Z',
      };
      const result = collectRedactedTrialLogs(options);
      const raw = fs.readFileSync(result.filePath, 'utf8');
      fs.writeFileSync(result.filePath, raw.replace(/("sha256":")[0-9a-f]+("[,}])/, `$1${'0'.repeat(64)}$2`));
      expect(() => verifyRedactedTrialLogCollectionFile(result.filePath, root)).toThrow(/canonical|digest|malformed/i);
      fs.writeFileSync(result.filePath, raw);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      fs.writeFileSync(result.filePath, `${JSON.stringify({
        totalByteSize: parsed.totalByteSize,
        files: parsed.files,
        collectedAt: parsed.collectedAt,
        schemaVersion: parsed.schemaVersion,
      })}\n`);
      expect(() => verifyRedactedTrialLogCollectionFile(result.filePath, root)).toThrow(/canonical/i);
      fs.writeFileSync(result.filePath, raw);
      fs.writeFileSync(path.join(root, 'logs', 'one.log'), 'changed');
      expect(() => collectRedactedTrialLogs(options)).toThrow(/different digest/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
