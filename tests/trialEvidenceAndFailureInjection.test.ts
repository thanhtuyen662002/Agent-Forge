import crypto from 'crypto';
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
import { ArtifactIntegrityError, ArtifactStore } from '../src/core/services/ArtifactStore';
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

describe('ArtifactStore containment hardening', () => {
  it('preserves valid content-addressed round trips while preparing the race boundary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-artifact-store-'));
    try {
      const store = new ArtifactStore(root, 0);
      const payload = 'stable artifact payload';
      const hash = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
      const materialized = store.materializeContentAddressedFile(payload, hash);
      expect(store.read({
        id: 'artifact-round-trip',
        project_id: 'project-1',
        task_id: null,
        attempt_id: null,
        evidence_type: 'TEST_RESULT',
        storage_type: 'FILE',
        file_path: materialized.filePath,
        hash,
        byte_size: Buffer.byteLength(payload, 'utf8'),
        content_type: 'text/plain',
        summary: 'round trip',
        raw_payload: null,
        created_at: new Date().toISOString(),
      })).toBe(payload);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when an artifact parent is missing instead of recreating it implicitly', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-artifact-missing-parent-'));
    try {
      const store = new ArtifactStore(root, 0);
      expect(() => store.readBuffer(path.join(root, 'missing-parent', 'artifact.bin'))).toThrowError(
        expect.objectContaining({ code: 'ARTIFACT_PARENT_MISSING' })
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a parent replaced by a symlink or junction before a read can escape', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-artifact-reparse-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-artifact-outside-'));
    try {
      const parent = path.join(root, 'nested');
      const outsideFile = path.join(outside, 'artifact.bin');
      fs.mkdirSync(parent, { recursive: true });
      fs.writeFileSync(outsideFile, 'outside', 'utf8');
      const target = path.join(parent, 'artifact.bin');
      fs.writeFileSync(target, 'inside', 'utf8');
      fs.rmSync(parent, { recursive: true, force: true });
      try {
        fs.symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && ['EPERM', 'EACCES'].includes(String((error as { code: unknown }).code))) return;
        throw error;
      }
      const store = new ArtifactStore(root, 0);
      expect(() => store.readBuffer(target)).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/ARTIFACT_REPARSE_POINT|ARTIFACT_PATH_UNVERIFIED/) })
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('keeps case-folded Windows paths bound to the same artifact identity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-artifact-case-'));
    try {
      const store = new ArtifactStore(root, 0);
      const payload = 'case-folded artifact';
      const hash = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
      const filePath = store.materializeContentAddressedFile(payload, hash).filePath;
      const equivalentPath = process.platform === 'win32' ? filePath.toUpperCase() : filePath;
      expect(store.readBuffer(equivalentPath).toString('utf8')).toBe(payload);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('makes concurrent staged cleanup idempotent and leaves no staged file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-artifact-cleanup-'));
    try {
      const store = new ArtifactStore(root, 0);
      const staged = store.stage('concurrent-cleanup', 'project-1', null, null, 'TEST_RESULT', 'cleanup', 'cleanup payload');
      await Promise.all([
        Promise.resolve().then(() => store.cleanupStagedFile(staged.stagedPath!)),
        Promise.resolve().then(() => store.cleanupStagedFile(staged.stagedPath!)),
      ]);
      expect(fs.existsSync(staged.stagedPath!)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('exposes typed integrity failures to evidence verification instead of treating boundary races as provider I/O', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-artifact-integrity-'));
    try {
      const store = new ArtifactStore(root, 0);
      const evidence = {
        id: 'missing-parent',
        project_id: 'project-1',
        task_id: null,
        attempt_id: null,
        evidence_type: 'TEST_RESULT' as const,
        storage_type: 'FILE' as const,
        file_path: path.join(root, 'missing', 'artifact.bin'),
        hash: '0'.repeat(64),
        byte_size: 0,
        content_type: 'text/plain',
        summary: 'integrity',
        raw_payload: null,
        created_at: new Date().toISOString(),
      };
      let error: unknown;
      try {
        store.readBuffer(evidence.file_path);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ArtifactIntegrityError);
      expect((error as ArtifactIntegrityError).code).toBe('ARTIFACT_PARENT_MISSING');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
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
    const tokenRedacted = buildTrialEvidenceManifest({ ...baseManifest(), notes: 'token: super-secret-value' });
    expect(tokenRedacted.manifest.notes).toBe('[REDACTED_SECRET]');
    const secretRedacted = buildTrialEvidenceManifest({ ...baseManifest(), notes: 'secret=super-secret-value' });
    expect(secretRedacted.manifest.notes).toBe('[REDACTED_SECRET]');
    const compositeRedacted = buildTrialEvidenceManifest({
      ...baseManifest(),
      notes: 'secretToken: super-secret-value | eyJabcdefghijk.abcdefghijkl.abcdefghijkl | https://user:super-secret-value@example.invalid/path',
    });
    expect(compositeRedacted.manifest.notes).not.toContain('super-secret-value');
    expect(compositeRedacted.manifest.notes).not.toContain('eyJabcdefghijk');
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
