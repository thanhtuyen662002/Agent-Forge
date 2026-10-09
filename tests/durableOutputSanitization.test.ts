import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import { AutonomyStore } from '../src/core/autonomy/store';
import { createWorkOrder, ManagerReview } from '../src/core/autonomy/contracts';
import { buildTrialEvidenceManifest, parseAndVerifyTrialEvidenceManifest, ProductionTrialEvidenceManifest,
  redactTrialEvidenceText } from '../src/core/autonomy/trialEvidence';
import { OUTPUT_MAX_TEXT_CHARACTERS } from '../src/shared/security/secretRedaction';

// Deliberately synthetic and unusable. Assert booleans/hashes so a failing
// persistence regression never echoes the credential-shaped fixture.
const secret = 'AF_TEST_ONLY_OUTPUT_CREDENTIAL';
const untrusted = 'password=' + secret;
const hash = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

describe('durable output sanitization boundaries', () => {
  let root: string;
  let db: Database.Database;
  let store: AutonomyStore;
  let workOrderId: string;

  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-durable-output-')));
    db = new Database(':memory:');
    store = new AutonomyStore(db);
    workOrderId = store.createWorkOrder(createWorkOrder({
      taskId: 'fixture-task', issueNumber: null, workerId: 'agy-01', objective: 'fixture objective',
      baseSha: 'a'.repeat(40), branch: 'agent/fixture-task', worktree: root,
      acceptanceCriteria: ['fixture acceptance'], requiredTests: [],
    })).id;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    if (!path.basename(root).startsWith('af-durable-output-') || fs.realpathSync.native(root) !== root) throw new Error('FIXTURE_BOUNDARY_CHANGED');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(['inline', 'file', 'staged'] as const)('sanitizes actual %s artifact bytes and summary before hashing or publication', mode => {
    const artifacts = new ArtifactStore(root, mode === 'inline' ? 1024 : 1);
    const staged = mode === 'staged' ? artifacts.stage('evidence', 'P', 'T', null, 'CUSTOM', untrusted, untrusted) : null;
    const evidence = staged?.evidence ?? artifacts.store('evidence', 'P', 'T', null, 'CUSTOM', untrusted, untrusted);
    if (staged) {
      const stagedBytes = fs.readFileSync(staged.stagedPath!, 'utf8');
      expect(stagedBytes.includes(secret)).toBe(false);
      artifacts.finalizeStagedFile(staged.stagedPath!, staged.finalPath!, evidence.hash);
    }
    const observed = artifacts.read(evidence);
    expect(observed.includes(secret)).toBe(false);
    expect(evidence.summary.includes(secret)).toBe(false);
    expect(observed.includes('[REDACTED_SECRET]')).toBe(true);
    expect(evidence.hash).toBe(hash(observed));
    expect(evidence.byte_size).toBe(Buffer.byteLength(observed, 'utf8'));
    if (evidence.file_path) expect(fs.readFileSync(evidence.file_path, 'utf8')).toBe(observed);
    else expect(evidence.raw_payload).toBe(observed);
  });

  it('sanitizes real SQLite run output without changing the failed execution observation', () => {
    const id = store.recordRun(workOrderId, 'fixture-provider', { status: 'FAILED', exitCode: 9, stdout: untrusted, stderr: untrusted, durationMs: 17 });
    const row = db.prepare('SELECT * FROM autonomy_runs WHERE id=?').get(id) as { stdout: string; stderr: string; status: string; exit_code: number; duration_ms: number };
    expect((row.stdout + row.stderr).includes(secret)).toBe(false);
    expect(row).toMatchObject({ status: 'FAILED', exit_code: 9, duration_ms: 17 });
  });

  function review(): ManagerReview {
    return { protocol_version: 'managerreview.v1', verdict: 'PASS', reviewed_head_sha: 'a'.repeat(40), risk: 'LOW', notes: untrusted,
      required_actions: [untrusted], findings: [{ severity: 'LOW', title: untrusted, description: untrusted,
        evidence: untrusted, required_action: untrusted, acceptance_evidence: untrusted }] };
  }

  it('sanitizes every review field and its real audit event while preserving source and verdict', () => {
    store.recordReview(workOrderId, review());
    const stored = db.prepare('SELECT payload_json,verdict,reviewed_head_sha FROM autonomy_reviews').get() as { payload_json: string; verdict: string; reviewed_head_sha: string };
    const event = db.prepare("SELECT payload_json FROM autonomy_events WHERE event_type='MANAGER_REVIEWED'").get() as { payload_json: string };
    expect((stored.payload_json + event.payload_json).includes(secret)).toBe(false);
    expect(stored).toMatchObject({ verdict: 'PASS', reviewed_head_sha: 'a'.repeat(40) });
    expect(JSON.parse(stored.payload_json)).toEqual(JSON.parse(event.payload_json));
  });

  it.each(['malformed', 'cyclic'] as const)('rejects a %s review with fixed error and no partial PASS or event', variant => {
    const unsafe = review() as unknown as Record<string, unknown>;
    unsafe.notes = variant === 'malformed' ? 17 : unsafe;
    let code: unknown;
    try { store.recordReview(workOrderId, unsafe as unknown as ManagerReview); }
    catch (error) { code = (error as { code?: unknown }).code; }
    expect(code).toBe('OUTPUT_TYPE_INVALID');
    expect(db.prepare('SELECT COUNT(*) AS count FROM autonomy_reviews').get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM autonomy_events WHERE event_type='MANAGER_REVIEWED'").get()).toEqual({ count: 0 });
  });

  it('sanitizes nested direct audit payloads before real SQLite persistence', () => {
    store.event(workOrderId, 'FIXTURE', { reason: untrusted, nested: { apiKey: secret } });
    const row = db.prepare("SELECT payload_json FROM autonomy_events WHERE event_type='FIXTURE'").get() as { payload_json: string };
    expect(row.payload_json.includes(secret)).toBe(false);
  });

  it('rejects oversized success-shaped runs and reviews before persisting any success', () => {
    const oversized = 'x'.repeat(OUTPUT_MAX_TEXT_CHARACTERS + 1);
    expect(() => store.recordRun(workOrderId, 'fixture-provider', {
      status: 'COMPLETED', exitCode: 0, stdout: oversized, stderr: '', durationMs: 1,
    })).toThrow('OUTPUT_SIZE_EXCEEDED');
    expect(() => store.recordReview(workOrderId, { ...review(), notes: oversized })).toThrow('OUTPUT_SIZE_EXCEEDED');
    expect(db.prepare('SELECT COUNT(*) AS count FROM autonomy_runs').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM autonomy_reviews').get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM autonomy_events WHERE event_type='MANAGER_REVIEWED'").get()).toEqual({ count: 0 });
  });

  it('rolls review and event back together when actual audit persistence fails', () => {
    vi.spyOn(store, 'event').mockImplementationOnce(() => { throw new Error('INJECTED_AUDIT_FAILURE'); });
    expect(() => store.recordReview(workOrderId, review())).toThrow('INJECTED_AUDIT_FAILURE');
    expect(db.prepare('SELECT COUNT(*) AS count FROM autonomy_reviews').get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM autonomy_events WHERE event_type='MANAGER_REVIEWED'").get()).toEqual({ count: 0 });
  });

  it('sanitizes direct content publication and rejects an unsafe caller-supplied raw hash before any file is published', () => {
    const artifacts = new ArtifactStore(root);
    const result = artifacts.materializeContentAddressedFile(untrusted);
    const observed = fs.readFileSync(result.filePath, 'utf8');
    expect(observed.includes(secret)).toBe(false);
    expect(result.hash).toBe(hash(observed));
    const entries = fs.readdirSync(root);
    expect(() => artifacts.materializeContentAddressedFile(untrusted, hash(untrusted))).toThrow('OUTPUT_REDACTION_UNSAFE');
    expect(fs.readdirSync(root)).toEqual(entries);
  });

  it('preserves ordinary binary bytes but rejects credential-shaped UTF8/UTF16 buffers before publication', () => {
    const artifacts = new ArtifactStore(root);
    const binary = Buffer.from([0, 255, 128, 7, 13, 10]);
    const result = artifacts.materializeContentAddressedFile(binary);
    expect(fs.readFileSync(result.filePath)).toEqual(binary);
    const entries = fs.readdirSync(root);
    for (const encoding of ['utf8', 'utf16le'] as const) {
      expect(() => artifacts.materializeContentAddressedFile(Buffer.from(untrusted, encoding))).toThrow('OUTPUT_REDACTION_UNSAFE');
    }
    expect(fs.readdirSync(root)).toEqual(entries);
  });

  it('applies the shared provider-prefix policy to trial text', () => {
    const fixtureKey = 'sk-proj-' + 'AF_TEST_ONLY_'.repeat(4);
    const observed = redactTrialEvidenceText('diagnostic ' + fixtureKey);
    expect(observed.includes(fixtureKey)).toBe(false);
    expect(observed.includes('[REDACTED_SECRET]')).toBe(true);
  });

  it.each(['trialId', 'contextKey', 'evidenceId', 'lifecycleId', 'operatorId', 'approverId', 'ciRunId', 'retentionPath'] as const)(
    'rejects raw credential-shaped %s in trial manifests without echoing the original', field => {
      const fixtureKey = 'sk-proj-' + 'AF_TEST_ONLY_'.repeat(4);
      const input: ProductionTrialEvidenceManifest = {
        schemaVersion: 1, trialId: 'fixture-trial', phase: 'R5L1', createdAt: '2026-01-01T00:00:00.000Z',
        source: { commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), ciRunId: 'fixture-ci' },
        artifacts: { installerSha256: null, appSha256: null, databaseProjectionSha256: null },
        lifecycleIds: [], contextHashes: {}, outcome: 'HOLD', evidence: [],
        approvals: { operatorIds: [], approverIds: [] }, retention: { location: 'logs', retentionClass: 'fixture' }, notes: null,
      };
      if (field === 'trialId') input.trialId = fixtureKey;
      if (field === 'contextKey') input.contextHashes[fixtureKey] = 'c'.repeat(64);
      if (field === 'evidenceId') input.evidence.push({ evidenceId: fixtureKey, relativePath: 'fixture.log', sha256: 'c'.repeat(64), byteSize: 0, contentType: 'text/plain', redacted: true });
      if (field === 'lifecycleId') input.lifecycleIds.push(fixtureKey);
      if (field === 'operatorId') input.approvals.operatorIds.push(fixtureKey);
      if (field === 'approverId') input.approvals.approverIds.push(fixtureKey);
      if (field === 'ciRunId') input.source.ciRunId = fixtureKey;
      if (field === 'retentionPath') input.retention.location = fixtureKey;
      for (const operation of [() => buildTrialEvidenceManifest(input), () => parseAndVerifyTrialEvidenceManifest(JSON.stringify(input))]) {
        let message = '';
        try { operation(); } catch (error) { message = (error as Error).message; }
        expect(message.startsWith('TRIAL_EVIDENCE_INVALID:')).toBe(true);
        expect(message.includes(fixtureKey)).toBe(false);
      }
    });
});
