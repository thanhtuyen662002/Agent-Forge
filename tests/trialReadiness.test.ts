import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildTrialEvidenceManifest,
  type ProductionTrialEvidenceManifest,
} from '../src/core/autonomy/trialEvidence';
import {
  evaluateTrialReadiness,
  type TrialReadinessInput,
} from '../src/core/autonomy/trialReadiness';
import { FAILURE_INJECTION_IDS } from '../src/core/autonomy/failureInjection';
import { main as autonomyCliMain } from '../src/electron/autonomyCli';

type TrialManifestInput = Omit<ProductionTrialEvidenceManifest, 'schemaVersion' | 'createdAt'> & { createdAt?: string };

function baseManifest(phase: ProductionTrialEvidenceManifest['phase'] = 'R5L1'): ProductionTrialEvidenceManifest {
  const result = buildTrialEvidenceManifest({
    trialId: 'trial-readiness',
    phase,
    source: {
      commitSha: 'a'.repeat(40),
      treeSha: 'b'.repeat(40),
      ciRunId: 'ci-readiness',
    },
    artifacts: {
      installerSha256: phase === 'R5L2' || phase === 'R5L4' ? 'c'.repeat(64) : null,
      appSha256: phase === 'R5L2' || phase === 'R5L4' ? 'd'.repeat(64) : null,
      databaseProjectionSha256: phase === 'R5L0' ? null : 'e'.repeat(64),
    },
    lifecycleIds: ['task-readiness'],
    contextHashes: { authority: 'f'.repeat(64) },
    outcome: 'PASS',
    evidence: [{
      evidenceId: 'evidence-readiness',
      relativePath: 'trial/readiness.json',
      sha256: '1'.repeat(64),
      byteSize: 1,
      contentType: 'application/json',
      redacted: true,
    }],
    approvals: { operatorIds: ['operator-readiness'], approverIds: ['approver-readiness'] },
    retention: { location: 'trial/readiness', retentionClass: 'R5L' },
    notes: null,
  } satisfies TrialManifestInput);
  return result.manifest;
}

function sourceInput(overrides: Partial<TrialReadinessInput> = {}): TrialReadinessInput {
  return {
    approvedSource: { commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40) },
    observedSource: { commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), cleanWorktree: true },
    ciPassed: true,
    designatedOperatorIds: ['operator-readiness'],
    designatedApproverIds: ['approver-readiness'],
    ...overrides,
  };
}

describe('trial readiness preflight', () => {
  it('returns READY for a complete R5L1 synthetic fixture preflight', () => {
    const result = evaluateTrialReadiness(baseManifest('R5L1'), sourceInput({
      managerAuthorized: true,
      buildPassed: true,
      reviewerBuilt: true,
      databaseBackupSha256: '2'.repeat(64),
      observedArtifacts: { databaseProjectionSha256: 'e'.repeat(64) },
      syntheticProviderAccountIds: ['synthetic-coder', 'synthetic-reviewer'],
      separationPolicy: 'REQUIRE_DIFFERENT',
      fixtureRepository: 'fixture-repository',
      previousPhaseOutcomes: { R5L0: 'PASS' },
    }));
    expect(result.status).toBe('READY');
    expect(result.blockingReasons).toEqual([]);
    expect(result.checks.every((item) => item.status === 'PASS')).toBe(true);
  });

  it('holds when exact source, approval, or synthetic fixture inputs are absent', () => {
    const result = evaluateTrialReadiness(baseManifest('R5L1'), sourceInput({
      approvedSource: { commitSha: '0'.repeat(40), treeSha: 'b'.repeat(40) },
      observedSource: { commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), cleanWorktree: false },
      designatedApproverIds: ['different-approver'],
      managerAuthorized: false,
    }));
    expect(result.status).toBe('HOLD');
    expect(result.blockingReasons.some((reason) => reason.startsWith('source.approved_exact:'))).toBe(true);
    expect(result.blockingReasons.some((reason) => reason.startsWith('source.clean_worktree:'))).toBe(true);
    expect(result.blockingReasons.some((reason) => reason.startsWith('approvals.identity_binding:'))).toBe(true);
    expect(result.blockingReasons.some((reason) => reason.startsWith('providers.synthetic_separation:'))).toBe(true);
  });

  it('requires all independent live controls for R5L2, including two distinct accounts', () => {
    const manifest = baseManifest('R5L2');
    const incomplete = evaluateTrialReadiness(manifest, sourceInput({
      executiveAuthorized: true,
      databaseBackupSha256: '2'.repeat(64),
      observedArtifacts: { installerSha256: 'c'.repeat(64), appSha256: 'd'.repeat(64), databaseProjectionSha256: 'e'.repeat(64) },
      liveProviderAccountIds: ['live-one'],
      credentialResolutionVerified: true,
      diskFreeGb: 8,
      redactionActive: true,
      networkStable: true,
      quotaSufficient: true,
      retentionLocationDesignated: true,
      previousPhaseOutcomes: { R5L0: 'PASS', R5L1: 'PASS' },
    }));
    expect(incomplete.status).toBe('HOLD');
    expect(incomplete.blockingReasons.some((reason) => reason.startsWith('providers.live_separation:'))).toBe(true);

    const complete = evaluateTrialReadiness(manifest, sourceInput({
      executiveAuthorized: true,
      databaseBackupSha256: '2'.repeat(64),
      observedArtifacts: { installerSha256: 'c'.repeat(64), appSha256: 'd'.repeat(64), databaseProjectionSha256: 'e'.repeat(64) },
      liveProviderAccountIds: ['live-coder', 'live-reviewer'],
      credentialResolutionVerified: true,
      diskFreeGb: 8,
      redactionActive: true,
      networkStable: true,
      quotaSufficient: true,
      retentionLocationDesignated: true,
      previousPhaseOutcomes: { R5L0: 'PASS', R5L1: 'PASS' },
    }));
    expect(complete.status).toBe('READY');

    const mismatchedArtifact = evaluateTrialReadiness(manifest, sourceInput({
      executiveAuthorized: true,
      databaseBackupSha256: '2'.repeat(64),
      observedArtifacts: { installerSha256: 'c'.repeat(64), appSha256: '0'.repeat(64), databaseProjectionSha256: 'e'.repeat(64) },
      liveProviderAccountIds: ['live-coder', 'live-reviewer'],
      credentialResolutionVerified: true,
      diskFreeGb: 8,
      redactionActive: true,
      networkStable: true,
      quotaSufficient: true,
      retentionLocationDesignated: true,
      previousPhaseOutcomes: { R5L0: 'PASS', R5L1: 'PASS' },
    }));
    expect(mismatchedArtifact.status).toBe('HOLD');
    expect(mismatchedArtifact.blockingReasons.some((reason) => reason.startsWith('artifacts.application_observed:'))).toBe(true);
  });

  it('requires FI-01 through FI-15 evidence or explicit waivers for R5L3', () => {
    const manifest = baseManifest('R5L3');
    const evidence = [...FAILURE_INJECTION_IDS];
    evidence.pop();
    const missing = evaluateTrialReadiness(manifest, sourceInput({
      injectionAuthorized: true,
      baselineDatabaseSha256: '2'.repeat(64),
      failureInjectionEvidenceIds: evidence,
      previousPhaseOutcomes: { R5L0: 'PASS', R5L1: 'PASS', R5L2: 'PASS' },
    }));
    expect(missing.status).toBe('HOLD');
    expect(missing.blockingReasons.some((reason) => reason.startsWith('failure_injection.coverage:'))).toBe(true);

    const waived = evaluateTrialReadiness(manifest, sourceInput({
      injectionAuthorized: true,
      baselineDatabaseSha256: '2'.repeat(64),
      failureInjectionEvidenceIds: evidence,
      failureInjectionWaivers: ['FI-15'],
      previousPhaseOutcomes: { R5L0: 'PASS', R5L1: 'PASS', R5L2: 'PASS' },
    }));
    expect(waived.status).toBe('READY');
  });

  it('requires release approval, complete artifacts, previous passes, and retention for R5L4', () => {
    const manifest = baseManifest('R5L4');
    const result = evaluateTrialReadiness(manifest, sourceInput({
      releaseApproved: true,
      retentionLocationDesignated: true,
      observedArtifacts: { installerSha256: 'c'.repeat(64), appSha256: 'd'.repeat(64), databaseProjectionSha256: 'e'.repeat(64) },
      previousPhaseOutcomes: { R5L0: 'PASS', R5L1: 'PASS', R5L2: 'PASS', R5L3: 'HOLD' },
    }));
    expect(result.status).toBe('HOLD');
    expect(result.blockingReasons.some((reason) => reason.startsWith('phases.R5L3.pass:'))).toBe(true);

    const complete = evaluateTrialReadiness(manifest, sourceInput({
      releaseApproved: true,
      retentionLocationDesignated: true,
      observedArtifacts: { installerSha256: 'c'.repeat(64), appSha256: 'd'.repeat(64), databaseProjectionSha256: 'e'.repeat(64) },
      previousPhaseOutcomes: { R5L0: 'PASS', R5L1: 'PASS', R5L2: 'PASS', R5L3: 'PASS' },
    }));
    expect(complete.status).toBe('READY');
  });

  it('revalidates a manifest instead of trusting a structurally similar object', () => {
    const malformed = { ...baseManifest('R5L0'), source: { ...baseManifest('R5L0').source, commitSha: 'not-a-sha' } } as ProductionTrialEvidenceManifest;
    expect(() => evaluateTrialReadiness(malformed, sourceInput({ managerAuthorized: true }))).toThrow(/TRIAL_EVIDENCE_INVALID/);
  });

  it('runs the manifest, verification, and readiness CLI commands without mutating external state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-readiness-cli-'));
    const previousRuntimeRoot = process.env.AGENT_FORGE_RUNTIME_ROOT;
    try {
      process.env.AGENT_FORGE_RUNTIME_ROOT = root;
      const inputPath = path.join(root, 'manifest-input.json');
      const readinessPath = path.join(root, 'readiness-input.json');
      fs.writeFileSync(inputPath, JSON.stringify(baseManifest('R5L1')));
      fs.writeFileSync(readinessPath, JSON.stringify(sourceInput({
        managerAuthorized: true,
        buildPassed: true,
        reviewerBuilt: true,
        databaseBackupSha256: '2'.repeat(64),
        syntheticProviderAccountIds: ['synthetic-coder', 'synthetic-reviewer'],
        separationPolicy: 'REQUIRE_DIFFERENT',
        fixtureRepository: 'fixture-repository',
        previousPhaseOutcomes: { R5L0: 'PASS' },
      })));

      expect(await autonomyCliMain(['node', 'autonomyCli.ts', 'trial-manifest', inputPath, 'trial/manifest.json'])).toBe(0);
      const manifestPath = path.join(root, 'trial', 'manifest.json');
      expect(await autonomyCliMain(['node', 'autonomyCli.ts', 'verify-trial-manifest', manifestPath])).toBe(0);
      expect(await autonomyCliMain(['node', 'autonomyCli.ts', 'trial-readiness', manifestPath, readinessPath])).toBe(0);
      expect(fs.existsSync(path.join(root, 'trial', 'manifest.json'))).toBe(true);
    } finally {
      if (previousRuntimeRoot === undefined) delete process.env.AGENT_FORGE_RUNTIME_ROOT;
      else process.env.AGENT_FORGE_RUNTIME_ROOT = previousRuntimeRoot;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
