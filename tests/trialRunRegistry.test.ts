import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../src/core/database/migrations';
import { AutonomyStore } from '../src/core/autonomy/store';
import { buildTrialEvidenceManifest } from '../src/core/autonomy/trialEvidence';
import {
  TrialRunRegistry,
  type TrialRunRecord,
} from '../src/core/autonomy/trialRegistry';
import { main as autonomyCliMain } from '../src/electron/autonomyCli';

function fixtureManifest() {
  return buildTrialEvidenceManifest({
    trialId: 'trial-registry',
    phase: 'R5L1',
    source: {
      commitSha: 'a'.repeat(40),
      treeSha: 'b'.repeat(40),
      ciRunId: 'ci-registry',
    },
    artifacts: {
      installerSha256: null,
      appSha256: null,
      databaseProjectionSha256: 'c'.repeat(64),
    },
    lifecycleIds: ['task-registry'],
    contextHashes: { context: 'd'.repeat(64) },
    outcome: 'HOLD',
    evidence: [{
      evidenceId: 'evidence-registry',
      relativePath: 'trial/registry.json',
      sha256: 'e'.repeat(64),
      byteSize: 1,
      contentType: 'application/json',
      redacted: true,
    }],
    approvals: { operatorIds: ['operator-registry'], approverIds: [] },
    retention: { location: 'trial/registry', retentionClass: 'R5L' },
    notes: null,
  });
}

function createRegistry(): { db: Database.Database; registry: TrialRunRegistry } {
  const db = new Database(':memory:');
  MigrationRunner.run(db);
  // AutonomyStore owns the idempotent extension schema used by the registry.
  new AutonomyStore(db);
  return { db, registry: new TrialRunRegistry(db) };
}

describe('durable production trial run registry', () => {
  it('persists a manifest-bound run and is idempotent for the same identity', () => {
    const { db, registry } = createRegistry();
    const manifest = fixtureManifest();
    const first = registry.register(manifest.manifest, manifest.sha256, 'run-01');
    const second = registry.register(manifest.manifest, manifest.sha256, 'run-01');

    expect(first).toMatchObject<Partial<TrialRunRecord>>({
      trialId: 'trial-registry',
      runId: 'run-01',
      phase: 'R5L1',
      state: 'REGISTERED',
      manifestSha256: manifest.sha256,
    });
    expect(second).toEqual(first);
    expect(registry.listEvents('trial-registry', 'run-01').map((event) => event.sequence)).toEqual([1]);
    db.close();
  });

  it('fails closed when an existing run identity is rebound to another manifest', () => {
    const { db, registry } = createRegistry();
    const manifest = fixtureManifest();
    registry.register(manifest.manifest, manifest.sha256, 'run-01');
    const altered = fixtureManifest();
    altered.manifest.notes = 'different manifest';
    const alteredSha = buildTrialEvidenceManifest(altered.manifest).sha256;
    expect(() => registry.register(altered.manifest, alteredSha, 'run-01')).toThrow('TRIAL_RUN_IDENTITY_CONFLICT');
    expect(registry.get('trial-registry', 'run-01')?.manifestSha256).toBe(manifest.sha256);
    db.close();
  });

  it('stores canonicalized identity fields when given a structurally typed raw manifest', () => {
    const { db, registry } = createRegistry();
    const built = fixtureManifest();
    const raw = JSON.parse(built.canonicalJson) as ReturnType<typeof fixtureManifest>['manifest'];
    raw.source.commitSha = raw.source.commitSha.toUpperCase();
    raw.source.treeSha = raw.source.treeSha.toUpperCase();
    const record = registry.register(raw, undefined, 'run-canonical');
    expect(record.sourceCommitSha).toBe('a'.repeat(40));
    expect(record.sourceTreeSha).toBe('b'.repeat(40));
    db.close();
  });

  it('enforces monotonic fail-closed transitions and records an ordered audit trail', () => {
    const { db, registry } = createRegistry();
    const manifest = fixtureManifest();
    registry.register(manifest.manifest, manifest.sha256, 'run-01');
    expect(() => registry.complete('trial-registry', 'run-01', 'PASS')).toThrow('TRIAL_RUN_STATE_CONFLICT');
    expect(registry.start('trial-registry', 'run-01').state).toBe('RUNNING');
    expect(registry.start('trial-registry', 'run-01').state).toBe('RUNNING');
    expect(registry.complete('trial-registry', 'run-01', 'PASS').state).toBe('PASS');
    expect(registry.complete('trial-registry', 'run-01', 'PASS').state).toBe('PASS');
    expect(() => registry.complete('trial-registry', 'run-01', 'HOLD')).toThrow('TRIAL_RUN_STATE_CONFLICT');
    expect(registry.listEvents('trial-registry', 'run-01').map((event) => event.state)).toEqual(['REGISTERED', 'RUNNING', 'PASS']);
    db.close();
  });

  it('returns HOLD for unknown runs instead of inventing a registry record', () => {
    const { db, registry } = createRegistry();
    expect(registry.get('missing-trial', 'missing-run')).toBeNull();
    expect(registry.require('missing-trial', 'missing-run')).toMatchObject({
      status: 'HOLD',
      reason: 'TRIAL_RUN_NOT_FOUND',
    });
    db.close();
  });

  it('exposes register/start/complete/list through the local CLI contract', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-trial-run-cli-'));
    const previousRuntimeRoot = process.env.AGENT_FORGE_RUNTIME_ROOT;
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      process.env.AGENT_FORGE_RUNTIME_ROOT = root;
      const manifestPath = path.join(root, 'manifest.json');
      fs.writeFileSync(manifestPath, `${fixtureManifest().canonicalJson}\n`, 'utf8');
      expect(await autonomyCliMain(['node', 'autonomyCli.ts', 'trial-run-register', manifestPath, 'run-cli'])).toBe(0);
      expect(await autonomyCliMain(['node', 'autonomyCli.ts', 'trial-run-start', 'trial-registry', 'run-cli'])).toBe(0);
      expect(await autonomyCliMain(['node', 'autonomyCli.ts', 'trial-run-complete', 'trial-registry', 'run-cli', 'HOLD'])).toBe(0);
      expect(await autonomyCliMain(['node', 'autonomyCli.ts', 'trial-run-list', 'trial-registry'])).toBe(0);
      const output = stdoutWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(output).toContain('"runId":"run-cli"');
      expect(output).toContain('"state":"HOLD"');
    } finally {
      if (previousRuntimeRoot === undefined) delete process.env.AGENT_FORGE_RUNTIME_ROOT;
      else process.env.AGENT_FORGE_RUNTIME_ROOT = previousRuntimeRoot;
      stdoutWrite.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
