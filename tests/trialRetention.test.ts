import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildTrialRetentionDesignation,
  isTrialRetentionDesignationBound,
  parseAndVerifyTrialRetentionDesignation,
  writeTrialRetentionDesignation,
} from '../src/core/autonomy/trialRetention';
import { buildTrialEvidenceManifest } from '../src/core/autonomy/trialEvidence';

const manifestSha256 = 'a'.repeat(64);

function baseDesignation() {
  return {
    trialId: 'trial-retention',
    phase: 'R5L2' as const,
    manifestSha256,
    location: 'trial-evidence/r5l2',
    retentionClass: 'R5L',
    designatedBy: ['security-lead'],
    designatedAt: '2026-09-27T00:00:00.000Z',
  };
}

describe('trial evidence retention designation', () => {
  it('canonicalizes a durable designation and verifies its digest', () => {
    const result = buildTrialRetentionDesignation(baseDesignation());
    expect(result.designation.schemaVersion).toBe(1);
    expect(result.canonicalJson).toBe(JSON.stringify(result.designation));
    expect(parseAndVerifyTrialRetentionDesignation(result.canonicalJson, result.sha256)).toEqual(result);
  });

  it('rejects traversal, invalid hashes, and non-canonical timestamps', () => {
    expect(() => buildTrialRetentionDesignation({ ...baseDesignation(), location: '../outside' })).toThrow(/location/);
    expect(() => buildTrialRetentionDesignation({ ...baseDesignation(), manifestSha256: 'A'.repeat(64) })).toThrow(/manifestSha256/);
    expect(() => buildTrialRetentionDesignation({ ...baseDesignation(), designatedAt: '2026-09-27' })).toThrow(/designatedAt/);
  });

  it('writes atomically, is idempotent, and rejects conflicting overwrite', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-retention-'));
    try {
      const result = buildTrialRetentionDesignation(baseDesignation());
      const written = writeTrialRetentionDesignation(root, 'trial-evidence/retention.json', result);
      expect(fs.existsSync(written.filePath)).toBe(true);
      expect(written.sha256).toBe(result.sha256);
      expect(writeTrialRetentionDesignation(root, 'trial-evidence/retention.json', result)).toEqual(written);
      const changed = buildTrialRetentionDesignation({ ...baseDesignation(), designatedBy: ['security-lead', 'auditor'] });
      expect(() => writeTrialRetentionDesignation(root, 'trial-evidence/retention.json', changed)).toThrow(/different digest/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a tampered result before creating a retention file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-retention-tampered-'));
    try {
      const result = buildTrialRetentionDesignation(baseDesignation());
      const tampered = { ...result, canonicalJson: '{}', sha256: '0'.repeat(64) };
      expect(() => writeTrialRetentionDesignation(root, 'trial-evidence/retention.json', tampered)).toThrow(/canonical JSON or SHA-256/);
      expect(fs.existsSync(path.join(root, 'trial-evidence'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds a designation to the exact trial manifest digest and location', () => {
    const manifest = buildTrialEvidenceManifest({
      trialId: baseDesignation().trialId,
      phase: baseDesignation().phase,
      createdAt: '2026-09-27T00:00:00.000Z',
      source: { commitSha: 'b'.repeat(40), treeSha: 'c'.repeat(40), ciRunId: 'ci-retention' },
      artifacts: { installerSha256: 'd'.repeat(64), appSha256: 'e'.repeat(64), databaseProjectionSha256: 'f'.repeat(64) },
      lifecycleIds: ['trial-retention-run'],
      contextHashes: { authority: '1'.repeat(64) },
      outcome: 'PASS',
      evidence: [],
      approvals: { operatorIds: ['security-lead'], approverIds: ['approver'] },
      retention: { location: baseDesignation().location, retentionClass: baseDesignation().retentionClass },
      notes: null,
    });
    const designation = buildTrialRetentionDesignation({
      ...baseDesignation(),
      manifestSha256: manifest.sha256,
    }).designation;
    expect(isTrialRetentionDesignationBound(manifest.manifest, designation)).toBe(true);
    expect(isTrialRetentionDesignationBound(manifest.manifest, { ...designation, location: 'other' })).toBe(false);
  });

  it('fails closed when the designation path is replaced by a link', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-retention-link-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-retention-outside-'));
    try {
      const result = buildTrialRetentionDesignation(baseDesignation());
      const destination = path.join(root, 'trial-evidence');
      try {
        fs.symlinkSync(outside, destination, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && ['EPERM', 'EACCES'].includes(String((error as { code: unknown }).code))) return;
        throw error;
      }
      expect(() => writeTrialRetentionDesignation(root, 'trial-evidence/retention.json', result)).toThrow(/reparse|symbolic|junction|path/i);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not read an oversized existing designation into memory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-retention-large-'));
    try {
      const result = buildTrialRetentionDesignation(baseDesignation());
      const destination = path.join(root, 'trial-evidence');
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, 'retention.json'), Buffer.alloc(1024 * 1024 + 1, 0x41));
      expect(() => writeTrialRetentionDesignation(root, 'trial-evidence/retention.json', result)).toThrow(/byte limit|too large|configured/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
