import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ProductTaskAutonomyAdapter, VERIFICATION_REPORT_MAX_ATTEMPTS, VERIFICATION_REPORT_MAX_READ_BYTES,
  VERIFICATION_REPORT_MAX_OUTPUT_CHARACTERS } from '../src/core/autonomy/productTaskAdapter';
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

describe('bounded truthful verification evidence reports', () => {
  let root: string, db: Database.Database, repo: Repository, artifactStore: ArtifactStore;
  let adapter: ProductTaskAutonomyAdapter;
  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-report-evidence-')));
    db = new Database(':memory:'); db.pragma('foreign_keys=ON'); MigrationRunner.run(db);
    repo = new Repository(db);
    const now = new Date().toISOString();
    for (const id of ['report-project', 'foreign-project']) repo.createProject({
      id, name: id, description: null, repository_path: root, default_branch: 'main', status: 'RUNNING', contract: null,
      created_at: now, updated_at: now, started_at: null, completed_at: null,
    });
    db.prepare(`INSERT INTO role_profiles(id,role,display_name,required_capabilities_json,preferred_capabilities_json,
      permissions_json,enabled,created_at,updated_at) VALUES('report-role','CODER','Report Fixture','[]','[]','[]',1,?,?)`).run(now, now);
    db.prepare(`INSERT INTO agent_profiles(id,role_profile_id,name,enabled,created_at,updated_at)
      VALUES('report-agent','report-role','Report Fixture',1,?,?)`).run(now, now);
    for (const [id, project] of [['report-task', 'report-project'], ['foreign-task', 'foreign-project']]) {
      db.prepare(`INSERT INTO tasks(id,project_id,title,state,priority,risk,revision_count,max_revisions,
        progress_cache_percent,ownership_epoch,created_at,updated_at) VALUES(?,?,?,'VALIDATING','LOW','LOW',0,3,0,1,?,?)`)
        .run(id, project, id, now, now);
      repo.createTaskAttempt({ id: `${id}-attempt`, task_id: id, attempt_number: 1, agent_id: null, agent_profile_id: 'report-agent',
        status: 'RUNNING', started_at: now, ended_at: null, summary: null });
    }
    useThreshold(32 * 1024);
  });
  afterEach(() => {
    vi.restoreAllMocks(); db?.close();
    if (!path.isAbsolute(root) || fs.realpathSync.native(root) !== root || !path.basename(root).startsWith('af-report-evidence-')) {
      throw new Error('REPORT_FIXTURE_CLEANUP_DENIED');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  function useThreshold(threshold: number) {
    artifactStore = new ArtifactStore(path.join(root, 'artifacts'), threshold);
    adapter = new ProductTaskAutonomyAdapter({ repo, artifactStore });
  }
  function record(stdout = 'actual pass', stderr = '', exitCode = 0) {
    return adapter.recordVerificationObservation({ projectId: 'report-project', taskId: 'report-task',
      attemptId: 'report-task-attempt', command: 'test-command', status: exitCode === 0 ? 'COMPLETED' : 'FAILED',
      exitCode, passedCount: exitCode === 0 ? 1 : 0, failedCount: exitCode === 0 ? 0 : 1,
      durationMs: 1, stdout, stderr, workingDirectory: root });
  }
  function report() { return adapter.getTruthfulVerificationReport('report-task'); }

  it('preserves identical diagnostics across inline/file storage and the unchanged 32 KiB threshold', () => {
    const overhead = Buffer.byteLength('status=COMPLETED\nexitCode=0\n=== STDOUT ===\n\n=== STDERR ===\n');
    for (const bytes of [32767, 32768, 32769]) {
      const stdout = 'x'.repeat(bytes - overhead);
      const run = record(stdout);
      const evidence = repo.getEvidence(run.evidence_id!)!;
      expect(evidence.byte_size).toBe(bytes);
      expect(evidence.storage_type).toBe(bytes < 32768 ? 'INLINE' : 'FILE');
      expect(report().attempts.at(-1)).toMatchObject({ stdout, stderr: '', evidenceStatus: 'VERIFIED', success: true, outputTruncated: false });
    }
    const same = 'diagnostic across modes';
    useThreshold(100000); record(same, 'error line', 1);
    const inline = report().attempts.at(-1)!;
    useThreshold(0); record(same, 'error line', 1);
    const file = report().attempts.at(-1)!;
    expect([file.stdout, file.stderr, file.evidenceStatus, file.success]).toEqual([inline.stdout, inline.stderr, inline.evidenceStatus, inline.success]);
  });

  it.each(['missing', 'corrupt', 'reparse'] as const)('returns typed incomplete %s file evidence and preserves task/process state', kind => {
    useThreshold(0); const run = record('owned diagnostic'); const evidence = repo.getEvidence(run.evidence_id!)!;
    const beforeTask = repo.getTask('report-task');
    const beforeRuns = db.prepare('SELECT * FROM process_runs').all();
    let backup: string | undefined;
    if (kind === 'missing') fs.unlinkSync(evidence.file_path!);
    if (kind === 'corrupt') fs.writeFileSync(evidence.file_path!, 'unrelated replacement bytes');
    if (kind === 'reparse') {
      backup = path.join(root, 'original-artifacts'); fs.renameSync(path.join(root, 'artifacts'), backup);
      const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
      fs.copyFileSync(path.join(backup, path.basename(evidence.file_path!)), path.join(outside, path.basename(evidence.file_path!)));
      fs.symlinkSync(outside, path.join(root, 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    try {
      expect(report()).toMatchObject({ evidenceStatus: 'INCOMPLETE', evidenceErrorCode: 'VERIFICATION_EVIDENCE_READ_FAILED', latestAttemptPassed: false });
      expect(report().attempts[0]).toMatchObject({ stdout: '', stderr: 'VERIFICATION_EVIDENCE_READ_FAILED', success: false, exitCode: 0 });
      expect(repo.getTask('report-task')).toEqual(beforeTask);
      expect(db.prepare('SELECT * FROM process_runs').all()).toEqual(beforeRuns);
      if (kind === 'reparse') expect(fs.readdirSync(path.join(root, 'outside'))).toEqual([path.basename(evidence.file_path!)]);
    } finally {
      if (backup) { fs.unlinkSync(path.join(root, 'artifacts')); fs.renameSync(backup, path.join(root, 'artifacts')); }
    }
  });

  it.each(['project', 'task', 'attempt', 'process'] as const)('rejects %s substitution before reading its output', kind => {
    useThreshold(0); const run = record('must not disclose');
    if (kind === 'project') db.prepare("UPDATE evidence SET project_id='foreign-project' WHERE id=?").run(run.evidence_id);
    if (kind === 'task') db.prepare("UPDATE evidence SET task_id='foreign-task' WHERE id=?").run(run.evidence_id);
    if (kind === 'attempt') db.prepare("UPDATE evidence SET attempt_id='foreign-task-attempt' WHERE id=?").run(run.evidence_id);
    if (kind === 'process') db.prepare("UPDATE process_runs SET project_id='foreign-project' WHERE stdout_evidence_id=?").run(run.evidence_id);
    const read = vi.spyOn(artifactStore, 'readText');
    expect(report()).toMatchObject({ evidenceStatus: 'INCOMPLETE', latestAttemptPassed: false });
    expect(report().attempts[0].stdout).toBe(''); expect(read).not.toHaveBeenCalled();
  });

  it('discards a read if its task ownership epoch changes during the artifact observation', () => {
    record('old owner output'); const originalRead = artifactStore.readText.bind(artifactStore);
    vi.spyOn(artifactStore, 'readText').mockImplementation((evidence, max) => {
      const text = originalRead(evidence, max);
      expect(repo.bumpTaskOwnershipEpoch('report-task', 1).success).toBe(true); return text;
    });
    expect(report()).toMatchObject({ evidenceStatus: 'INCOMPLETE', evidenceErrorCode: 'VERIFICATION_EVIDENCE_SCOPE_CHANGED', latestAttemptPassed: false,
      attempts: [{ stdout: '', success: false, evidenceErrorCode: 'VERIFICATION_EVIDENCE_SCOPE_CHANGED' }] });
  });

  it('rejects oversized declared and actual inline payloads without trusting their metadata', () => {
    useThreshold(10000000); const run = record('bounded');
    db.prepare('UPDATE evidence SET byte_size=? WHERE id=?').run(VERIFICATION_REPORT_MAX_READ_BYTES + 1, run.evidence_id);
    const read = vi.spyOn(artifactStore, 'readText');
    expect(report().evidenceErrorCode).toBe('VERIFICATION_EVIDENCE_LIMIT_EXCEEDED'); expect(read).not.toHaveBeenCalled();
    db.prepare('UPDATE evidence SET byte_size=1,raw_payload=? WHERE id=?').run('x'.repeat(VERIFICATION_REPORT_MAX_READ_BYTES + 1), run.evidence_id);
    expect(report().evidenceErrorCode).toBe('VERIFICATION_EVIDENCE_READ_FAILED');
  });

  it('bounds report history and exposes a typed limit rather than dropping attempts silently', () => {
    for (let i = 0; i <= VERIFICATION_REPORT_MAX_ATTEMPTS; i++) record(`attempt ${i}`);
    const read = vi.spyOn(artifactStore, 'readText');
    expect(report()).toMatchObject({ totalAttempts: 65, evidenceStatus: 'INCOMPLETE', evidenceErrorCode: 'VERIFICATION_EVIDENCE_LIMIT_EXCEEDED', latestAttemptPassed: false });
    expect(report().attempts).toHaveLength(64); expect(read).not.toHaveBeenCalled();
  });

  it('enforces the cumulative read budget across individually bounded file-backed attempts', () => {
    useThreshold(0);
    for (let i = 0; i < 9; i++) record('x'.repeat(VERIFICATION_REPORT_MAX_READ_BYTES - 100));
    const read = vi.spyOn(artifactStore, 'readText');
    const observed = report();
    expect(observed.evidenceErrorCode).toBe('VERIFICATION_EVIDENCE_LIMIT_EXCEEDED');
    expect(observed.latestAttemptPassed).toBe(false); expect(read).toHaveBeenCalledTimes(8);
    expect(observed.attempts[8].evidenceStatus).toBe('INCOMPLETE');
  });

  it('rejects missing evidence references and ambiguous stdout/stderr framing', () => {
    const first = record(); db.prepare('UPDATE test_runs SET evidence_id=NULL WHERE id=?').run(first.id);
    expect(report().attempts[0].evidenceErrorCode).toBe('VERIFICATION_EVIDENCE_MISSING');
    record('literal === STDOUT ===\nambiguous output');
    expect(report().attempts[1].evidenceErrorCode).toBe('VERIFICATION_EVIDENCE_FORMAT_INVALID');
    expect(report().latestAttemptPassed).toBe(false);
  });

  it('rejects hash-valid binary bytes that cannot be decoded as UTF-8', () => {
    useThreshold(0); const run = record('text');
    const binary = Buffer.from([0xff, 0xfe]);
    const hash = crypto.createHash('sha256').update(binary).digest('hex');
    const file = artifactStore.materializeContentAddressedFile(binary, hash);
    db.prepare('UPDATE evidence SET file_path=?,hash=?,byte_size=? WHERE id=?').run(file.filePath, hash, binary.length, run.evidence_id);
    expect(report()).toMatchObject({ latestAttemptPassed: false, evidenceStatus: 'INCOMPLETE', evidenceErrorCode: 'VERIFICATION_EVIDENCE_READ_FAILED' });
  });

  it('redacts before explicit output truncation for both storage modes', () => {
    const secret = 'ghp_' + 'a'.repeat(28);
    const stdout = `diagnostic password=supersecretvalue ${secret}\n` + 'x'.repeat(50000);
    useThreshold(100000); record(stdout); const inline = report().attempts[0];
    useThreshold(0); record(stdout); const file = report().attempts[1];
    expect(file.stdout).toBe(inline.stdout); expect(file.outputTruncated).toBe(true);
    expect(file.stdout.length).toBeLessThanOrEqual(VERIFICATION_REPORT_MAX_OUTPUT_CHARACTERS);
    expect(file.stdout).toContain('VERIFICATION_REPORT_OUTPUT_TRUNCATED');
    expect(file.stdout).not.toContain(secret); expect(file.stdout).not.toContain('supersecretvalue');
    expect(file.stdout).toContain('[REDACTED_SECRET]');
  });

  it('retains failed reruns and recovers a cleaned-up content-addressed artifact only from verified identical bytes', () => {
    useThreshold(0); record('failure diagnostic', 'FAIL actual-case', 1); const run = record('real rerun passed');
    const evidence = repo.getEvidence(run.evidence_id!)!; const payload = artifactStore.readText(evidence);
    fs.unlinkSync(evidence.file_path!);
    expect(report().latestAttemptPassed).toBe(false);
    artifactStore.materializeContentAddressedFile(payload, evidence.hash);
    expect(report()).toMatchObject({ totalAttempts: 2, evidenceStatus: 'COMPLETE', latestAttemptPassed: true, isFirstPassSuccess: false, hadPriorFailure: true });
    expect(report().attempts[0].stderr).toBe('FAIL actual-case');
  });
});

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
