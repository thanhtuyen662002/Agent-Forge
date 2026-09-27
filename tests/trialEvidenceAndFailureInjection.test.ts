import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildTrialEvidenceManifest,
  canonicalizeTrialEvidenceManifest,
  computeTrialEvidenceManifestSha256,
  parseAndVerifyTrialEvidenceManifest,
  redactTrialEvidenceText,
  writeTrialEvidenceManifest,
  ProductionTrialEvidenceManifest,
} from '../src/core/autonomy/trialEvidence';
import {
  DeterministicFailureInjectionError,
  DeterministicFailureInjectionHarness,
  FAILURE_INJECTION_IDS,
} from '../src/core/autonomy/failureInjection';

type TrialManifestInput = Omit<ProductionTrialEvidenceManifest, 'schemaVersion' | 'createdAt'> & { createdAt?: string };

function baseManifest(): TrialManifestInput {
  return {
    trialId: 'trial-2026-09-27',
    phase: 'R5L1' as const,
    source: {
      commitSha: 'a'.repeat(40),
      treeSha: 'b'.repeat(40),
      ciRunId: 'ci-123',
    },
    artifacts: {
      installerSha256: 'c'.repeat(64),
      appSha256: null,
      databaseProjectionSha256: 'd'.repeat(64),
    },
    lifecycleIds: ['task-1', 'attempt-1'],
    contextHashes: { authority: 'e'.repeat(64) },
    outcome: 'PASS' as const,
    evidence: [{
      evidenceId: 'ev-1',
      relativePath: 'r5l1/ev-1.json',
      sha256: 'f'.repeat(64),
      byteSize: 12,
      contentType: 'application/json',
      redacted: true,
    }],
    approvals: { operatorIds: ['operator-1'], approverIds: ['approver-1'] },
    retention: { location: 'evidence/r5l1', retentionClass: 'R5L' },
    notes: 'synthetic rehearsal',
  };
}

describe('production trial evidence manifest', () => {
  it('builds deterministic canonical JSON and hash', () => {
    const first = buildTrialEvidenceManifest(baseManifest(),);
    const second = buildTrialEvidenceManifest({ ...baseManifest(), createdAt: first.manifest.createdAt });
    expect(first.canonicalJson).toBe(second.canonicalJson);
    expect(first.sha256).toBe(second.sha256);
    expect(computeTrialEvidenceManifestSha256(first.manifest)).toBe(first.sha256);
  });

  it('sorts evidence, IDs, and context keys before hashing', () => {
    const input = baseManifest();
    input.lifecycleIds = ['z', 'a'];
    input.contextHashes = { z: '1'.repeat(64), a: '2'.repeat(64) };
    input.evidence = [
      { evidenceId: 'z', relativePath: 'r/z.json', sha256: '3'.repeat(64), byteSize: 1, contentType: 'application/json', redacted: true },
      { evidenceId: 'a', relativePath: 'r/a.json', sha256: '4'.repeat(64), byteSize: 1, contentType: 'application/json', redacted: true },
    ];
    const result = buildTrialEvidenceManifest(input);
    expect(result.manifest.lifecycleIds).toEqual(['a', 'z']);
    expect(result.manifest.evidence.map((item) => item.evidenceId)).toEqual(['a', 'z']);
    expect(Object.keys(result.manifest.contextHashes)).toEqual(['a', 'z']);
  });

  it('redacts known credentials while verification rejects raw secrets', () => {
    const redacted = redactTrialEvidenceText('Bearer abcdefghijklmnop and ghp_123456789012345678901234567890123456');
    expect(redacted).toContain('[REDACTED_SECRET]');
    expect(() => buildTrialEvidenceManifest({ ...baseManifest(), notes: 'api_key=super-secret-value' })).not.toThrow();
    const raw = JSON.stringify({ ...baseManifest(), notes: 'api_key=super-secret-value', schemaVersion: 1, createdAt: new Date().toISOString() });
    const built = buildTrialEvidenceManifest(baseManifest());
    expect(() => parseAndVerifyTrialEvidenceManifest(raw, built.sha256)).toThrow(/TRIAL_EVIDENCE_INVALID/);
    expect(() => buildTrialEvidenceManifest({
      ...baseManifest(),
      approvals: { operatorIds: ['AKIAABCDEFGHIJKLMNOP'], approverIds: ['approver-1'] },
    })).toThrow(/secret-like/);
  });

  it('rejects traversal and malformed hashes', () => {
    expect(() => buildTrialEvidenceManifest({ ...baseManifest(), evidence: [{ ...baseManifest().evidence[0], relativePath: '../secret' }] })).toThrow(/relativePath/);
    expect(() => buildTrialEvidenceManifest({ ...baseManifest(), source: { ...baseManifest().source, commitSha: 'x'.repeat(40) } })).toThrow(/commitSha/);
    expect(() => buildTrialEvidenceManifest({ ...baseManifest(), artifacts: { ...baseManifest().artifacts, installerSha256: 'A'.repeat(64) } })).toThrow(/installerSha256/);
  });

  it('writes atomically, verifies on disk, and refuses conflicting overwrite', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-trial-evidence-'));
    try {
      const result = buildTrialEvidenceManifest(baseManifest());
      const written = writeTrialEvidenceManifest(root, 'r5l1/manifest.json', result);
      expect(fs.existsSync(written.filePath)).toBe(true);
      expect(parseAndVerifyTrialEvidenceManifest(fs.readFileSync(written.filePath, 'utf8'), result.sha256).sha256).toBe(result.sha256);
      expect(writeTrialEvidenceManifest(root, 'r5l1/manifest.json', result).sha256).toBe(result.sha256);
      const changed = buildTrialEvidenceManifest({ ...baseManifest(), outcome: 'HOLD' as const, createdAt: result.manifest.createdAt });
      expect(() => writeTrialEvidenceManifest(root, 'r5l1/manifest.json', changed)).toThrow(/different digest/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a tampered result before creating an evidence file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-trial-evidence-tampered-'));
    try {
      const result = buildTrialEvidenceManifest(baseManifest());
      const tampered = { ...result, canonicalJson: '{}', sha256: '0'.repeat(64) };
      expect(() => writeTrialEvidenceManifest(root, 'r5l1/manifest.json', tampered)).toThrow(/canonical JSON or SHA-256/);
      expect(fs.existsSync(path.join(root, 'r5l1'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('deterministic failure injection harness', () => {
  it('supports every R5L failure ID and produces repeatable snapshots', () => {
    for (const id of FAILURE_INJECTION_IDS) {
      const first = new DeterministicFailureInjectionHarness({ [id]: { triggerOnInvocation: 2 } });
      first.checkpoint(id);
      expect(() => first.checkpoint(id)).toThrow(DeterministicFailureInjectionError);
      expect(first.snapshot()[1].injected).toBe(true);
      const second = new DeterministicFailureInjectionHarness({ [id]: { triggerOnInvocation: 2 } });
      second.checkpoint(id);
      expect(() => second.checkpoint(id)).toThrow(DeterministicFailureInjectionError);
      expect(second.snapshotHash()).toBe(first.snapshotHash());
    }
  });

  it('does not inject without an explicit rule and does not run the operation after injection', () => {
    const harness = new DeterministicFailureInjectionHarness({ 'FI-11': { triggerOnInvocation: 1, code: 'PROJECTION_DRIFT' } });
    let ran = false;
    expect(() => harness.execute('FI-11', () => { ran = true; })).toThrow(/PROJECTION_DRIFT/);
    expect(ran).toBe(false);
    expect(harness.execute('FI-10', () => 42)).toBe(42);
  });

  it('rejects invalid rules and unknown IDs', () => {
    expect(() => new DeterministicFailureInjectionHarness({ 'FI-01': { triggerOnInvocation: 0 } })).toThrow(/INVALID_RULE/);
    expect(() => new DeterministicFailureInjectionHarness({ 'FI-99': { triggerOnInvocation: 1 } } as never)).toThrow(/UNKNOWN_ID/);
  });
});
