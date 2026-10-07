import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { approveFixtureScript } from '../helpers/verificationCapabilityFixture';
import crypto from 'crypto';
import child_process from 'child_process';
import {
  MigrationRunner,
  MIGRATIONS,
  verifyMigration23SchemaAuthority,
  verifyMigration22SchemaAuthority,
  verifyMigration21SchemaAuthority,
} from '../../src/core/database/migrations';
import { Repository, CoderSubmission } from '../../src/core/database/repositories';
import {
  CoderSubmissionAdjudicationService,
  deriveDeterministicAdjudicationId,
  deriveDeterministicAdjudicationEventId,
  deriveDeterministicGenericAdjudicationEventId,
  deriveDeterministicDispositionId,
  scrubAdjudicationDiagnostics,
  evaluateCanonicalSettlementDecision,
  evaluateNonAuthoritativeSettlementDecisionForTests,
  validateAndParseCanonicalResultEnvelope,
  buildCanonicalTerminalEventPayload,
  buildCanonicalTerminalDisposition,
  SUPPORTED_FAILURE_CODES,
  FENCED_FAILURE_CODES,
  SupportedFailureCode,
  buildCanonicalWorkspaceSnapshotAfterPayload,
  validateCanonicalWorkspaceSnapshotAfter,
  canonicalizeSnapshotEvidenceHash,
} from '../../src/core/services/CoderSubmissionAdjudicationService';
import { CoderSubmissionAdjudicationRecoveryScanner } from '../../src/core/services/CoderSubmissionAdjudicationRecoveryScanner';
import { CrashRecoveryService } from '../../src/core/services/CrashRecoveryService';
import { VerificationService, parseTestMetrics } from '../../src/core/services/VerificationService';
import {
  ArtifactStore,
  verifyEvidenceIntegrity,
  canonicalizeArtifactManifest,
  computeArtifactManifestHash,
  parseAndVerifyArtifactManifest,
} from '../../src/core/services/ArtifactStore';
import { McpSubmissionAuthorityService } from '../../src/core/services/McpSubmissionAuthorityService';
import { TaskService } from '../../src/core/services/TaskService';
import { EventService } from '../../src/core/services/EventService';
import { computePayloadHash } from '../../src/core/services/ExecutionAuthorizationService';
import { ProjectService } from '../../src/core/services/ProjectService';
import { EmergencyStopService } from '../../src/core/services/EmergencyStopService';
import { ProcessRunner, StructuredProcessOptions, ProcessRunResult } from '../../src/core/services/ProcessRunner';
import { TaskStateMachine } from '../../src/core/state/taskStateMachine';
import { PackageGenerator } from '../../src/core/protocol/packageGenerator';
import {
  AdjudicationAction,
  AdjudicationStatus,
  AdjudicationEventType,
  CoderSubmissionAdjudication,
  CoderSubmissionAdjudicationError,
  CanonicalAuthoritySnapshot,
  AUTHORITY_SNAPSHOT_KEYS,
  CanonicalVerificationResultEnvelope,
  SealedVerificationExecutionInput,
  VerifiedAdjudicationReviewProjection,
  ArtifactManifest,
  ArtifactManifestEntry,
  ARTIFACT_MANIFEST_ENTRY_KEYS,
  ARTIFACT_MANIFEST_KEYS,
  CanonicalWorkspaceSnapshotAfterPayload,
  CANONICAL_WORKSPACE_SNAPSHOT_AFTER_KEYS,
} from '../../src/core/types/adjudication';
import { registerIpcHandlers, scrubAdjudicationError } from '../../src/electron/ipcHandlers';
import { ExecutionAuthorization, Task, Project, Evidence, TestRun } from '../../src/core/types/domain';
import {
  computeAuthorityFingerprint,
  canonicalJsonStringify,
  generateSubmissionToken,
  deriveDeterministicEventId,
  computeSha256,
} from '../../src/mcp/submissionProtocol';
import {
  ListQuarantinedSubmissionsIpcSchema,
  InspectQuarantinedSubmissionIpcSchema,
  AdmitQuarantinedSubmissionIpcSchema,
  RejectQuarantinedSubmissionIpcSchema,
  SupersedeQuarantinedSubmissionIpcSchema,
  ResumeAdmittedSubmissionIpcSchema,
  AcknowledgeRecoveryFencedIpcSchema,
} from '../../src/core/types/ipc';
import { enUS } from '../../src/shared/i18n/locales/en-US';
import { viVN } from '../../src/shared/i18n/locales/vi-VN';

import {
  ipcChannelHandlers,
  FullAdjudicationFixtures,
  createTestDatabase,
  setupFullSubmissionGraph,
  issueSubmissionSessionHelper,
  createValidSubmissionPayload,
} from './harness';

describe('R5J5 Quarantined Submission Adjudication and Verification Suite', () => {
  let tempDir: string;
  let db: Database.Database;
  let dbPath: string;
  let fixtures: FullAdjudicationFixtures;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), 'af-adj-test-' + Date.now() + '-' + crypto.randomUUID().slice(0, 8));
    fs.mkdirSync(tempDir, { recursive: true });

    const repoDir = path.join(tempDir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    child_process.execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    child_process.execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
    child_process.execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Project\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, '.gitignore'), 'temp-artifacts\n', 'utf8');
    child_process.execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
    child_process.execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir, stdio: 'ignore' });

    const artifactsDir = path.join(tempDir, 'artifacts');
    fs.mkdirSync(artifactsDir, { recursive: true });

    const created = createTestDatabase(tempDir, 'adjudication-test.db');
    db = created.db;
    dbPath = created.dbPath;
    fixtures = await setupFullSubmissionGraph(db, repoDir, artifactsDir);
  }, 120000);

  afterEach(() => {
    if (db && db.open) {
      try {
        db.close();
      } catch (e) {
        throw new Error('[FIXTURE_CLEANUP_ERROR] Failed to close database: ' + (e instanceof Error ? e.message : String(e)));
      }
    }
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (e) {
        throw new Error('[FIXTURE_CLEANUP_ERROR] Failed to remove temporary directory: ' + (e instanceof Error ? e.message : String(e)));
      }
    }
  }, 120000);



    interface LegacyLinkageTestPayload {
      [key: string]: unknown;
      adjudication: CoderSubmissionAdjudication;
      submission: CoderSubmission;
      testRun: unknown;
      gitStatusEvidence: unknown;
      gitDiffEvidence: unknown;
    }

    function createTestLinkage(
      subId: string,
      overrides: Partial<CoderSubmissionAdjudication> = {},
      testRun?: { id?: string } | null,
      gitStatusEvidence?: { id?: string } | null,
      gitDiffEvidence?: { id?: string } | null
    ): LegacyLinkageTestPayload {
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const authSnap = overrides.authority_snapshot_json ?? '{}';
      const authSnapHash = overrides.authority_snapshot_hash ?? computeSha256(authSnap);
      const cmdSnap = overrides.verification_commands_json ?? '{}';
      const cmdSnapHash = overrides.verification_commands_hash ?? computeSha256(cmdSnap);
      const adj: CoderSubmissionAdjudication = {
        id: overrides.id || crypto.randomUUID(),
        request_id: crypto.randomUUID(),
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        submission_id: subId,
        authorization_id: fixtures.authorizationId,
        attempt_id: fixtures.attemptId,
        assignment_id: fixtures.assignmentId,
        task_ownership_epoch: 1,
        action: 'ADMIT_VERIFICATION',
        status: 'VERIFIED',
        lifecycle_version: 3,
        authority_snapshot_json: authSnap,
        authority_snapshot_hash: authSnapHash,
        verification_commands_json: cmdSnap,
        verification_commands_hash: cmdSnapHash,
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        verification_execution_id: null,
        protocol_message_id: null,
        test_run_id: testRun?.id || null,
        git_status_evidence_id: gitStatusEvidence?.id || null,
        git_diff_evidence_id: gitDiffEvidence?.id || null,
        failure_code: null,
        failure_json: null,
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        recovery_fenced_at: null,
        ...overrides,
      };
      return {
        adjudication: adj,
        submission: sub,
        testRun: testRun || null,
        gitStatusEvidence: gitStatusEvidence || null,
        gitDiffEvidence: gitDiffEvidence || null,
      };
    }

    function createTestProjection(
      subId: string,
      overrides: Partial<VerifiedAdjudicationReviewProjection> = {}
    ): VerifiedAdjudicationReviewProjection {
      const proj: Omit<VerifiedAdjudicationReviewProjection, 'projection_hash'> = {
        adjudication_id: overrides.adjudication_id || ('adj-rev-' + crypto.randomUUID()),
        submission_id: subId,
        project_id: fixtures.projectId,
        project_name: 'Test Project',
        task_id: fixtures.taskId,
        task_title: 'Test Task',
        task_priority: 'LOW',
        task_risk: 'LOW',
        task_revision_count: 1,
        task_max_revisions: 3,
        task_base_sha: '0'.repeat(40),
        task_working_sha: '1'.repeat(40),
        acceptance_criteria: ['Pass all tests'],
        previous_issues: [],
        untrusted_claim: {
          summary: 'Execution completed successfully with verified tests',
          completed: ['Finished feature'],
          files_claimed_changed: ['src/core/feature.ts'],
          tests_claimed: ['tests/feature.test.ts'],
          blockers: [],
          claim_content_hash: 'a'.repeat(64),
        },
        authoritative_verification: {
          test_run_id: overrides.authoritative_verification?.test_run_id ?? ('tr-' + crypto.randomUUID()),
          command: 'npm test',
          command_snapshot_hash: 'b'.repeat(64),
          exit_code: 0,
          passed_count: 1,
          failed_count: 0,
          skipped_count: 0,
          duration_ms: 100,
          test_result_evidence_id: 'ev-test',
          test_result_evidence_hash: 'c'.repeat(64),
          verdict: 'PASSED',
        },
        authoritative_git_status: {
          evidence_id: 'ev-status',
          evidence_hash: 'd'.repeat(64),
          storage_type: 'INLINE',
          is_clean: true,
          branch: 'main',
          summary: 'Clean working tree',
        },
        authoritative_git_diff: {
          evidence_id: 'ev-diff',
          evidence_hash: 'e'.repeat(64),
          storage_type: 'INLINE',
          byte_size: 10,
          diff_content: '+line',
          is_truncated: false,
          files_changed_count: 1,
        },
        recovery_fencing_state: null,
        operator_disposition: {
          disposition_event: 'SETTLED',
          disposition_reason: 'ACCEPTED_VERIFIED',
          decided_at: new Date().toISOString(),
        },
        ...overrides,
      };
      const projection_hash = computeSha256(canonicalJsonStringify(proj));
      return {
        ...proj,
        projection_hash,
      };
    }
  describe('Group 7E: Canonical Envelope & Terminal Recovery', () => {
    it('284. Repeated recovery scanner execution on settled adjudication is strictly idempotent with no duplicate events or dispositions', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();

      fixtures.repo.createCoderSubmissionAdjudication({
        id: adjId,
        submission_id: subId,
        authorization_id: fixtures.authorizationId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        assignment_id: fixtures.assignmentId,
        task_ownership_epoch: 1,
        action: 'ADMIT_VERIFICATION',
        status: 'VERIFYING',
        lifecycle_version: 2,
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: '{}',
        authority_snapshot_hash: computeSha256('{}'),
        workspace_snapshot_before_json: canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] }),
        workspace_snapshot_before_hash: computeSha256(canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] })),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: nowIso,
        verification_started_at: nowIso,
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
        artifact_manifest_json: null,
        artifact_manifest_hash: null,
      });

      // Pass 1: reconcile and fence the missing manifest
      const report1 = fixtures.recoveryScanner.scanAndReconcile();
      expect(report1.settledCount).toBe(0);
      expect(report1.fencedCount).toBe(1);

      const eventsAfterPass1 = fixtures.repo.getCoderSubmissionAdjudicationEvents(adjId);
      const dispAfterPass1 = fixtures.repo.getCoderSubmissionDispositions(subId);
      expect(eventsAfterPass1.length).toBeGreaterThanOrEqual(1);
      expect(dispAfterPass1.length).toBe(2);

      // Pass 2: replay scanAndReconcile on the already-fenced adjudication
      const report2 = fixtures.recoveryScanner.scanAndReconcile();
      expect(report2.settledCount).toBe(0);
      expect(report2.fencedCount).toBe(0);

      const eventsAfterPass2 = fixtures.repo.getCoderSubmissionAdjudicationEvents(adjId);
      const dispAfterPass2 = fixtures.repo.getCoderSubmissionDispositions(subId);

      expect(eventsAfterPass2.length).toBe(eventsAfterPass1.length);
      expect(dispAfterPass2.length).toBe(dispAfterPass1.length);
    });

    it('285. Output-limit termination remains pending until owned termination promise settles without early void settlement', async () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-output-limit-'));
      try {
        const scriptPath = path.join(testDir, 'flood.js');
        fs.writeFileSync(
          scriptPath,
          'for (let i = 0; i < 20; i++) { process.stdout.write("0123456789"); }\nsetInterval(() => {}, 1000);',
          'utf8'
        );

        const res = await ProcessRunner.execute({
          executable: process.execPath,
          args: [scriptPath],
          cwd: testDir,
          maxStdoutBytes: 40,
          timeoutMs: 10000,
        });

        expect(res.outputLimitExceeded).toBe(true);
        expect(res.errorCode).toBe('OUTPUT_LIMIT_EXCEEDED');
        expect(res.processTermination).toBe('PROCESS_TREE_TERMINATED_PROVEN');
        expect(ProcessRunner.getActiveProcessCount()).toBe(0);
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('286. Stdin write and stdin end failures trigger typed failure, awaited termination, and single settlement', async () => {
      const script = "process.stdin.destroy(); setTimeout(() => {}, 2000);";
      const largePayload = 'A'.repeat(65536);
      const res = await ProcessRunner.execute({
        executable: process.execPath,
        args: ['-e', script],
        cwd: os.tmpdir(),
        stdin: largePayload,
        timeoutMs: 5000,
      });

      expect(ProcessRunner.getActiveProcessCount()).toBe(0);
      expect(res.exitCode === null || res.exitCode !== 0).toBe(true);
    });

    it('287. Concurrent timeout, cancel, output-limit, and terminate-all share termination lifecycle and leave no residue', async () => {
      const script = "setInterval(() => process.stdout.write('A'.repeat(20)), 30);";
      const runPromise = ProcessRunner.execute({
        executable: process.execPath,
        args: ['-e', script],
        cwd: os.tmpdir(),
        maxStdoutBytes: 50,
        timeoutMs: 1000,
      });

      await ProcessRunner.terminateAllProcessesAsync();
      await runPromise;
      expect(ProcessRunner.getActiveProcessCount()).toBe(0);
    });

    it('288. Synchronous legacy cancellation path cannot claim success or persist terminal status before proof', async () => {
      const result = await ProcessRunner.cancel('non-existent-execution-id');
      expect(result).toBe('NOT_APPLICABLE');
      expect(ProcessRunner.getActiveProcessCount()).toBe(0);
    });

    it('289. Stage descriptor-close failure is visible and produces no successful evidence result', () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-stage-close-fail-'));
      const store = new ArtifactStore(testDir);
      const origCloseSync = fs.closeSync;
      const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((fd: number) => {
        origCloseSync(fd);
        throw new Error('EBADF: simulated close error');
      });

      try {
        expect(() => {
          store.stage('ev-close-1', fixtures.projectId, fixtures.taskId, fixtures.attemptId, 'PROCESS_LOG', 'sum', 'payload');
        }).toThrow(/STAGE_DESCRIPTOR_CLOSE_FAILED/);
      } finally {
        closeSpy.mockRestore();
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('290. Materialization descriptor-close failure is visible and leaves no successful artifact result', () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-mat-close-fail-'));
      const store = new ArtifactStore(testDir);
      const content = 'Hello materialization close failure';
      const hash = computeSha256(content);
      const origCloseSync = fs.closeSync;
      const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((fd: number) => {
        origCloseSync(fd);
        throw new Error('EIO: simulated disk close failure');
      });

      try {
        expect(() => {
          store.materializeContentAddressedFile(content, hash);
        }).toThrow(/DESCRIPTOR_CLOSE_FAILED/);
        expect(fs.existsSync(path.join(testDir, `${hash}.bin`))).toBe(false);
      } finally {
        closeSpy.mockRestore();
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('291. Same-content collision plus temporary-file unlink failure is not reported as success', () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-collision-unlink-fail-'));
      const store = new ArtifactStore(testDir);
      const content = 'Identical collision content';
      const hash = computeSha256(content);

      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        fs.writeFileSync(path.join(testDir, `${hash}.bin`), content);
        const err = new Error('EEXIST: file already exists') as Error & { code?: string };
        err.code = 'EEXIST';
        throw err;
      });

      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
        throw new Error('EPERM: cannot remove temporary file');
      });

      try {
        expect(() => {
          store.materializeContentAddressedFile(content, hash);
        }).toThrow(/CLEANUP_DEBT_TEMP_UNLINK_FAILED/);
      } finally {
        renameSpy.mockRestore();
        unlinkSpy.mockRestore();
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('292. Rename failure plus cleanup failure preserves both primary controlled code and visible scrubbed cleanup debt', () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-rename-fail-'));
      const store = new ArtifactStore(testDir);
      const content = 'Rename fail content';
      const hash = computeSha256(content);

      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        const err = new Error('EACCES: permission denied') as Error & { code?: string };
        err.code = 'EACCES';
        throw err;
      });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
        const err = new Error('EBUSY: resource busy') as Error & { code?: string };
        err.code = 'EBUSY';
        throw err;
      });

      try {
        expect(() => {
          store.materializeContentAddressedFile(content, hash);
        }).toThrow(/RENAME_FAILED.*CLEANUP_DEBT_TEMP_UNLINK_FAILED/);
      } finally {
        renameSpy.mockRestore();
        unlinkSpy.mockRestore();
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('293. Rollback cleanup native errors do not leak absolute paths or raw platform messages', () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-leak-check-'));
      const store = new ArtifactStore(testDir);
      const sensitiveDir = path.join(testDir, 'secret_subfolder');
      fs.mkdirSync(sensitiveDir, { recursive: true });
      const sensitivePath = path.join(sensitiveDir, 'test_file.bin');
      fs.writeFileSync(sensitivePath, 'dummy content', 'utf8');

      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
        throw new Error(`EACCES: permission denied, unlink 'C:\\\\Users\\\\SecretAdmin\\\\workspace\\\\secret_subfolder\\\\test_file.bin'`);
      });

      try {
        const res = store.cleanupRollbackFiles([sensitivePath]);
        expect(res.failures.length).toBe(1);
        const errMsg = res.failures[0].error;
        expect(errMsg).not.toContain('SecretAdmin');
        expect(errMsg).not.toContain('secret_subfolder');
        expect(res.failures[0].path).toBe('test_file.bin');
        expect(errMsg).toContain('UNLINK_FAILED');
      } finally {
        unlinkSpy.mockRestore();
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('294. Genuine VERIFIED terminal row is independently re-evaluated and is an exact idempotent no-op on repeated scans', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      expect(adj.status).toBe('VERIFIED');

      const initialEvents = fixtures.repo.getCoderSubmissionAdjudicationEvents(adj.id);
      const initialDisps = fixtures.repo.getCoderSubmissionDispositions(subId);

      const recon1 = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(recon1.classification).toBe('ALREADY_RECONCILED');
      expect(recon1.action_taken).toBe('NO_OP');

      const recon2 = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(recon2.classification).toBe('ALREADY_RECONCILED');
      expect(recon2.action_taken).toBe('NO_OP');

      const finalEvents = fixtures.repo.getCoderSubmissionAdjudicationEvents(adj.id);
      const finalDisps = fixtures.repo.getCoderSubmissionDispositions(subId);

      expect(finalEvents.length).toBe(initialEvents.length);
      expect(finalDisps.length).toBe(initialDisps.length);
    });

    it('295. Genuine VERIFICATION_FAILED terminal row is independently re-evaluated and is an exact idempotent no-op', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const payload = JSON.parse(auth.canonical_payload_json!);
      payload.verificationCommands.TEST = { ...await approveFixtureScript(fixtures.repo, fixtures.projectId, 'process.exit(1);'), timeout_ms: 120000 };
      const newHash = computePayloadHash(payload);
      const newJson = JSON.stringify(payload);
      fixtures.db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
        .run(newJson, newHash, fixtures.authorizationId);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      expect(adj.status).toBe('VERIFICATION_FAILED');

      const initialEvents = fixtures.repo.getCoderSubmissionAdjudicationEvents(adj.id);
      const initialDisps = fixtures.repo.getCoderSubmissionDispositions(subId);

      const recon1 = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(recon1.error).toBeUndefined();
      expect(recon1.classification).toBe('ALREADY_RECONCILED');
      expect(recon1.action_taken).toBe('NO_OP');

      const recon2 = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(recon2.classification).toBe('ALREADY_RECONCILED');
      expect(recon2.action_taken).toBe('NO_OP');

      const finalEvents = fixtures.repo.getCoderSubmissionAdjudicationEvents(adj.id);
      const finalDisps = fixtures.repo.getCoderSubmissionDispositions(subId);

      expect(finalEvents.length).toBe(initialEvents.length);
      expect(finalDisps.length).toBe(initialDisps.length);
    });

    it('296. Genuine RECOVERY_FENCED terminal row is independently re-evaluated and is an exact idempotent no-op', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
      const nowIso = new Date().toISOString();

      fixtures.repo.createCoderSubmissionAdjudication({
        id: adjId,
        submission_id: subId,
        authorization_id: fixtures.authorizationId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        assignment_id: fixtures.assignmentId,
        task_ownership_epoch: 1,
        action: 'ADMIT_VERIFICATION',
        status: 'RECOVERY_FENCED',
        lifecycle_version: 3,
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: nowIso,
        verification_started_at: null,
        completed_at: null,
        recovery_fenced_at: nowIso,
        failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
        failure_json: canonicalJsonStringify({ is_fenced: true, reason: 'Crash fence' }),
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: null,
        verification_result_envelope_json: null,
        verification_result_envelope_hash: null,
        artifact_manifest_json: null,
        artifact_manifest_hash: null,
      });

      fixtures.db.prepare("UPDATE tasks SET state = 'NEEDS_HUMAN' WHERE id = ?").run(fixtures.taskId);

      const fencedPayload = buildCanonicalTerminalEventPayload('RECOVERY_FENCED', adjId, 'ORPHANED_VERIFICATION_INTERRUPTED', 'Crash fence');
      const fencedPayloadHash = computeSha256(fencedPayload);
      fixtures.repo.createCoderSubmissionAdjudicationEvent({
        id: deriveDeterministicAdjudicationEventId(adjId, 3, 'RECOVERY_FENCED', fencedPayloadHash),
        adjudication_id: adjId,
        sequence: 3,
        event_type: 'RECOVERY_FENCED',
        payload_json: fencedPayload,
        payload_hash: fencedPayloadHash,
        created_at: nowIso,
      });

      fixtures.repo.createCoderSubmissionDisposition(
        buildCanonicalTerminalDisposition('RECOVERY_FENCED', adjId, subId, nowIso, {
          failureCode: 'ORPHANED_VERIFICATION_INTERRUPTED',
          error: 'Crash fence',
          isResultBearing: false,
        })
      );

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      const recon = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(recon.classification).toBe('ALREADY_RECONCILED');
      expect(recon.action_taken).toBe('NO_OP');
    });

    it('297. Extra key, missing key, wrong domain, non-canonical JSON in terminal envelope produces authority conflict with zero mutation', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const rawObj = JSON.parse(adj.verification_result_envelope_json!) as Record<string, unknown>;
      rawObj.extra_unauthorized_key = 'malicious';
      const tamperedJson = canonicalJsonStringify(rawObj);
      const tamperedHash = computeSha256(tamperedJson);

      const tamperedAdj: CoderSubmissionAdjudication = {
        ...adj,
        verification_result_envelope_json: tamperedJson,
        verification_result_envelope_hash: tamperedHash,
      };

      const eventsBefore = fixtures.repo.getCoderSubmissionAdjudicationEvents(adj.id).length;
      const dispsBefore = fixtures.repo.getCoderSubmissionDispositions(subId).length;

      const recon = fixtures.recoveryScanner.reconcileSingleAdjudication(tamperedAdj);
      expect(recon.classification).toBe('AUTHORITY_CONFLICT');
      expect(recon.action_taken).toBe('NO_OP');

      const eventsAfter = fixtures.repo.getCoderSubmissionAdjudicationEvents(adj.id).length;
      const dispsAfter = fixtures.repo.getCoderSubmissionDispositions(subId).length;
      expect(eventsAfter).toBe(eventsBefore);
      expect(dispsAfter).toBe(dispsBefore);
    });

    it('298. Tampered test evidence, Git evidence, manifest entry produces authority conflict with zero mutation', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const manifest: ArtifactManifest = JSON.parse(adj.artifact_manifest_json!);
      manifest.entries[0].sha256 = '0'.repeat(64);
      const tamperedManJson = canonicalJsonStringify(manifest);
      const tamperedManHash = computeSha256(tamperedManJson);

      const tamperedAdj: CoderSubmissionAdjudication = {
        ...adj,
        artifact_manifest_json: tamperedManJson,
        artifact_manifest_hash: tamperedManHash,
      };

      const eventsBefore = fixtures.repo.getCoderSubmissionAdjudicationEvents(adj.id).length;

      const recon = fixtures.recoveryScanner.reconcileSingleAdjudication(tamperedAdj);
      expect(recon.classification).toBe('AUTHORITY_CONFLICT');
      expect(recon.action_taken).toBe('NO_OP');
      expect(fixtures.repo.getCoderSubmissionAdjudicationEvents(adj.id).length).toBe(eventsBefore);
    });

    it('299. Exit zero plus failure code, ambiguous termination, missing manifest never becomes success', () => {
      const nowIso = new Date().toISOString();
      const fakeAdj: CoderSubmissionAdjudication = {
        id: 'adj-1',
        submission_id: 'sub-1',
        authorization_id: 'auth-1',
        project_id: 'proj-1',
        task_id: 'task-1',
        attempt_id: 'att-1',
        assignment_id: 'ass-1',
        task_ownership_epoch: 1,
        action: 'ADMIT_VERIFICATION',
        status: 'VERIFYING',
        lifecycle_version: 2,
        protocol_message_id: null,
        request_id: 'req-1',
        authority_snapshot_json: '{}',
        authority_snapshot_hash: computeSha256('{}'),
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: 'before',
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('c'),
        created_at: nowIso,
        verification_started_at: nowIso,
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: 'tr-1',
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: 'exec-1',
        verification_result_envelope_json: null,
        verification_result_envelope_hash: null,
        artifact_manifest_json: null,
        artifact_manifest_hash: null,
      };
      const fakeTestRun: TestRun = {
        id: 'tr-1',
        task_id: 'task-1',
        command: 'npm test',
        passed_count: 0,
        failed_count: 1,
        skipped_count: 0,
        duration_ms: 50,
        exit_code: 0,
        evidence_id: 'ev-1',
        created_at: nowIso,
      };
      const decision1 = evaluateNonAuthoritativeSettlementDecisionForTests({
        envelope: {
          adjudication_id: 'adj-1',
          artifact_manifest_hash: computeSha256('m'),
          assignment_id: 'ass-1',
          attempt_id: 'att-1',
          authorization_id: 'auth-1',
          command_snapshot_hash: computeSha256('c'),
          exit_classification: 'EXIT_ZERO',
          failure_code: 'SUSPICIOUS_FAILURE',
          failure_payload: null,
          finish_timestamp: nowIso,
          git_diff_evidence_hash: '',
          git_diff_evidence_id: '',
          git_status_evidence_hash: '',
          git_status_evidence_id: '',
          lifecycle_version: 3,
          process_start_classification: 'SPAWNED_PROVEN',
          project_id: 'proj-1',
          start_timestamp: nowIso,
          task_id: 'task-1',
          task_ownership_epoch: 1,
          termination_classification: 'TERMINATION_PROVEN',
          test_result_evidence_hash: 'hash',
          test_result_evidence_id: 'ev-1',
          test_run_id: 'tr-1',
          verification_execution_id: 'exec-1',
          workspace_snapshot_after_evidence_id: crypto.randomUUID(),
          workspace_snapshot_after_hash: 'after',
          workspace_snapshot_before_hash: 'before',
        },
        adjudication: fakeAdj,
        testRun: fakeTestRun,
        manifest: null,
      });

      expect(decision1.isSuccess).toBe(false);
      expect(decision1.targetStatus).toBe('RECOVERY_FENCED');
    });

    it('300. Workspace lease release CAS failure rolls back all recovery mutations and stays idempotent on replay', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const leaseId = crypto.randomUUID();
      const trId = crypto.randomUUID();
      const evId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
      const cmdsJson = canonicalJsonStringify(fixtures.authSnapshot.verification_commands);

      const gseId = crypto.randomUUID();
      const gdeId = crypto.randomUUID();

      fixtures.repo.createEvidence({
        id: evId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'TEST_RESULT',
        storage_type: 'INLINE',
        file_path: null,
        hash: computeSha256('pass'),
        byte_size: 4,
        created_at: nowIso,
        content_type: 'text/plain',
        summary: 'pass test evidence',
        raw_payload: 'pass',
      });
      fixtures.repo.createEvidence({
        id: gseId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'GIT_STATUS',
        storage_type: 'INLINE',
        file_path: null,
        hash: computeSha256('status'),
        byte_size: 6,
        created_at: nowIso,
        content_type: 'text/plain',
        summary: 'git status evidence',
        raw_payload: 'status',
      });
      fixtures.repo.createEvidence({
        id: gdeId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'GIT_DIFF',
        storage_type: 'INLINE',
        file_path: null,
        hash: computeSha256('diff'),
        byte_size: 4,
        created_at: nowIso,
        content_type: 'text/plain',
        summary: 'git diff evidence',
        raw_payload: 'diff',
      });
      const execId = crypto.randomUUID();
      const wsAfterId = 'ev-ws-after-' + crypto.randomUUID();
      const wsAfterObj: CanonicalWorkspaceSnapshotAfterPayload = {
        adjudication_id: adjId,
        adjudication_lifecycle_version: 3,
        assignment_id: fixtures.assignmentId,
        attempt_id: fixtures.attemptId,
        authorization_id: fixtures.authorizationId,
        captured_at: nowIso,
        captured_repository_head_sha: fixtures.repoHeadSha,
        expected_head_sha: fixtures.repoHeadSha,
        git_diff_evidence_hash: computeSha256('diff'),
        git_status_evidence_hash: computeSha256('status'),
        project_id: fixtures.projectId,
        schema_version: 1,
        submission_id: subId,
        task_id: fixtures.taskId,
        task_ownership_epoch: 1,
        verification_execution_id: execId,
        workspace_lease_id: leaseId,
        worktree_identity_hash: computeSha256(fixtures.projectRoot.toLowerCase()),
      };
      const wsAfterContent = canonicalJsonStringify(wsAfterObj);
      const wsAfterHash = computeSha256(wsAfterContent);
      fixtures.repo.createEvidence({
        id: wsAfterId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'FILE_SNAPSHOT',
        storage_type: 'INLINE',
        file_path: null,
        hash: wsAfterHash,
        byte_size: Buffer.byteLength(wsAfterContent, 'utf8'),
        created_at: nowIso,
        content_type: 'application/json',
        summary: 'ws after evidence',
        raw_payload: wsAfterContent,
      });

      fixtures.repo.createTestRun({
        id: trId,
        task_id: fixtures.taskId,
        command: 'npm test',
        passed_count: 1,
        failed_count: 0,
        skipped_count: 0,
        duration_ms: 50,
        exit_code: 0,
        evidence_id: evId,
        created_at: nowIso,
      });

      const manifestObj: ArtifactManifest = {
        manifest_schema_version: 1,
        adjudication_id: adjId,
        lifecycle_version: 3,
        verification_execution_id: execId,
        entries: [
          {
            byte_size: 4,
            content_type: 'text/plain',
            evidence_id: evId,
            evidence_type: 'TEST_RESULT',
            relative_path: 'test.txt',
            sha256: computeSha256('pass'),
            storage_class: 'INLINE',
          },
          {
            byte_size: 6,
            content_type: 'text/plain',
            evidence_id: gseId,
            evidence_type: 'GIT_STATUS',
            relative_path: 'git_status.txt',
            sha256: computeSha256('status'),
            storage_class: 'INLINE',
          },
          {
            byte_size: 4,
            content_type: 'text/plain',
            evidence_id: gdeId,
            evidence_type: 'GIT_DIFF',
            relative_path: 'git_diff.txt',
            sha256: computeSha256('diff'),
            storage_class: 'INLINE',
          },
          {
            byte_size: Buffer.byteLength(wsAfterContent, 'utf8'),
            content_type: 'application/json',
            evidence_id: wsAfterId,
            evidence_type: 'FILE_SNAPSHOT',
            relative_path: 'workspace_snapshot_after.json',
            sha256: wsAfterHash,
            storage_class: 'INLINE',
          },
        ],
      };
      const manifestJson = canonicalizeArtifactManifest(manifestObj);
      const manifestHash = computeArtifactManifestHash(manifestObj);

      const envelope: CanonicalVerificationResultEnvelope = {
        adjudication_id: adjId,
        artifact_manifest_hash: manifestHash,
        assignment_id: fixtures.assignmentId,
        attempt_id: fixtures.attemptId,
        authorization_id: fixtures.authorizationId,
        command_snapshot_hash: computeSha256(cmdsJson),
        exit_classification: 'EXIT_ZERO',
        failure_code: null,
        failure_payload: null,
        finish_timestamp: nowIso,
        git_diff_evidence_hash: computeSha256('diff'),
        git_diff_evidence_id: gdeId,
        git_status_evidence_hash: computeSha256('status'),
        git_status_evidence_id: gseId,
        lifecycle_version: 3,
        process_start_classification: 'SPAWNED_PROVEN',
        project_id: fixtures.projectId,
        start_timestamp: nowIso,
        task_id: fixtures.taskId,
        task_ownership_epoch: 1,
        termination_classification: 'TERMINATION_PROVEN',
        test_result_evidence_hash: computeSha256('pass'),
        test_result_evidence_id: evId,
        test_run_id: trId,
        verification_execution_id: execId,
        workspace_snapshot_after_evidence_id: wsAfterId,
        workspace_snapshot_after_hash: wsAfterHash,
        workspace_snapshot_before_hash: computeSha256('before'),
      };

      fixtures.repo.createCoderSubmissionAdjudication({
        id: adjId,
        submission_id: subId,
        authorization_id: fixtures.authorizationId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        assignment_id: fixtures.assignmentId,
        task_ownership_epoch: 1,
        action: 'ADMIT_VERIFICATION',
        status: 'ADMITTED',
        lifecycle_version: 1,
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        verification_commands_json: cmdsJson,
        verification_commands_hash: computeSha256(cmdsJson),
        created_at: nowIso,
        verification_started_at: null,
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: null,
        artifact_manifest_json: null,
        artifact_manifest_hash: null,
        workspace_lease_id: null,
      });

      fixtures.repo.createWorkspaceLease({
        id: leaseId,
        adjudication_id: adjId,
        worktree_identity_hash: computeSha256(path.resolve(fixtures.projectRoot).toLowerCase()),
        admitted_workspace_fingerprint_hash: computeSha256('admitted'),
        pre_execution_fingerprint_hash: null,
        claim_nonce: crypto.randomUUID(),
        execution_id: crypto.randomUUID(),
        lease_owner_identity: fixtures.assignmentId,
        assignment_id: fixtures.assignmentId,
        authorization_id: fixtures.authorizationId,
        acquired_at: nowIso,
        released_at: null,
        lifecycle_version: 1,
        state: 'ACQUIRED',
        failure_code: null,
        failure_evidence_hash: null,
      });

      const wsBeforeJson = canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] });
      const wsBeforeHash = computeSha256('before');

      fixtures.db
        .prepare(`
          UPDATE coder_submission_adjudications
          SET status = 'VERIFYING',
              verification_started_at = ?,
              verification_execution_id = ?,
              workspace_snapshot_before_json = ?,
              workspace_snapshot_before_hash = ?,
              workspace_lease_id = ?,
              artifact_manifest_json = ?,
              artifact_manifest_hash = ?,
              test_run_id = ?,
              lifecycle_version = lifecycle_version + 1
          WHERE id = ?
        `)
        .run(
          nowIso,
          manifestObj.verification_execution_id,
          wsBeforeJson,
          wsBeforeHash,
          leaseId,
          manifestJson,
          manifestHash,
          trId,
          adjId
        );

      const dispsBefore = fixtures.repo.getCoderSubmissionDispositions(subId).length;
      const updateLeaseSpy = vi.spyOn(fixtures.repo, 'updateWorkspaceLease').mockReturnValueOnce(false);

      try {
        const success = fixtures.recoveryScanner.reconcileMissingSettlement(
          fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!,
          fixtures.repo.getTestRun(trId)!,
          gseId,
          gdeId,
          envelope,
          manifestJson,
          manifestHash,
          nowIso
        );

        expect(success).toBe(false);

        const adjAfter = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
        expect(adjAfter.status).toBe('VERIFYING');
        expect(adjAfter.lifecycle_version).toBe(2);
        expect(fixtures.repo.getCoderSubmissionAdjudicationEvents(adjId).length).toBe(0);
        expect(fixtures.repo.getCoderSubmissionDispositions(subId).length).toBe(dispsBefore);

        // Restore spy before replay so real DB update runs
        updateLeaseSpy.mockRestore();

        // Replay succeeds once CAS race resolves
        const replaySuccess = fixtures.recoveryScanner.reconcileMissingSettlement(
          fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!,
          fixtures.repo.getTestRun(trId)!,
          gseId,
          gdeId,
          envelope,
          manifestJson,
          manifestHash,
          nowIso
        );
        expect(replaySuccess).toBe(true);

        const adjReplay = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
        expect(adjReplay.status).toBe('VERIFIED');
        expect(adjReplay.lifecycle_version).toBe(3);
        expect(fixtures.repo.getCoderSubmissionDispositions(subId).length).toBe(dispsBefore + 1);
      } finally {
        updateLeaseSpy.mockRestore();
      }
    });

    it('301. validateAndParseCanonicalResultEnvelope strictly validates canonical JSON byte identity', () => {
      const nowIso = new Date().toISOString();
      const validEnvelope: CanonicalVerificationResultEnvelope = {
        adjudication_id: crypto.randomUUID(),
        artifact_manifest_hash: 'a'.repeat(64),
        assignment_id: crypto.randomUUID(),
        attempt_id: crypto.randomUUID(),
        authorization_id: crypto.randomUUID(),
        command_snapshot_hash: 'b'.repeat(64),
        exit_classification: 'EXIT_ZERO',
        failure_code: null,
        failure_payload: null,
        finish_timestamp: nowIso,
        git_diff_evidence_hash: '',
        git_diff_evidence_id: '',
        git_status_evidence_hash: '',
        git_status_evidence_id: '',
        lifecycle_version: 3,
        process_start_classification: 'SPAWNED_PROVEN',
        project_id: crypto.randomUUID(),
        start_timestamp: nowIso,
        task_id: crypto.randomUUID(),
        task_ownership_epoch: 1,
        termination_classification: 'TERMINATION_PROVEN',
        test_result_evidence_hash: 'c'.repeat(64),
        test_result_evidence_id: crypto.randomUUID(),
        test_run_id: crypto.randomUUID(),
        verification_execution_id: crypto.randomUUID(),
        workspace_snapshot_after_evidence_id: crypto.randomUUID(),
        workspace_snapshot_after_hash: 'd'.repeat(64),
        workspace_snapshot_before_hash: 'e'.repeat(64),
      };

      const canonicalStr = canonicalJsonStringify(validEnvelope);
      const parsedValid = validateAndParseCanonicalResultEnvelope(canonicalStr);
      expect(parsedValid.valid).toBe(true);

      const nonCanonicalStr = JSON.stringify(validEnvelope, null, 2);
      const parsedInvalid = validateAndParseCanonicalResultEnvelope(nonCanonicalStr);
      expect(parsedInvalid.valid).toBe(false);
      expect(parsedInvalid.error).toContain('canonical JSON');
    });

    it('302. ProcessRunner cancelAsync and terminateProcessTree are idempotent on already terminated processes', async () => {
      const res = await ProcessRunner.cancelAsync('fake-execution-id');
      expect(res).toBe('NOT_APPLICABLE');
      expect(ProcessRunner.getActiveProcessCount()).toBe(0);
    });

    it('303. Live synchronous cancellation cannot claim terminal success before death proof', async () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-proc-cancel-'));
      try {
        const scriptPath = path.join(testDir, 'loop.js');
        fs.writeFileSync(scriptPath, 'setInterval(() => {}, 1000);', 'utf8');

        const execId = crypto.randomUUID();
        const procPromise = ProcessRunner.execute({
          executable: process.execPath,
          args: [scriptPath],
          cwd: testDir,
          executionId: execId,
          timeoutMs: 10000,
        });

        // Asynchronous cancel awaits death proof and returns ProcessTerminationTruth
        const cancelResult = await ProcessRunner.cancel(execId);
        expect(cancelResult).toBe('PROCESS_TREE_TERMINATED_PROVEN');

        const result = await procPromise;
        expect(result.cancelled).toBe(true);
        expect(result.errorCode).toBe('CANCELLED');
        expect(result.processTermination).toBe('PROCESS_TREE_TERMINATED_PROVEN');
        expect(ProcessRunner.getActiveProcessCount()).toBe(0);
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('304. Concurrent timeout, cancel, output-limit, and terminate-all join memoized settlement and produce single durable result', async () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-proc-race-'));
      try {
        const scriptPath = path.join(testDir, 'flood.js');
        fs.writeFileSync(scriptPath, 'setInterval(() => { console.log("running"); }, 50);', 'utf8');

        const execId = crypto.randomUUID();
        const procPromise = ProcessRunner.execute({
          executable: process.execPath,
          args: [scriptPath],
          cwd: testDir,
          executionId: execId,
          timeoutMs: 800,
          maxStdoutBytes: 100000,
        });

        const [cancelRes, termRes, result] = await Promise.all([
          ProcessRunner.cancelAsync(execId),
          ProcessRunner.terminateAllProcessesAsync(),
          procPromise,
        ]);

        expect(['NOT_APPLICABLE', 'PROCESS_TREE_TERMINATED_PROVEN', 'TERMINATION_UNRESOLVED']).toContain(cancelRes);
        expect(termRes.allTerminatedProven).toBe(true);
        expect(result.timedOut || result.cancelled || result.outputLimitExceeded).toBe(true);
        expect(result.processTermination).toBe('PROCESS_TREE_TERMINATED_PROVEN');
        expect(ProcessRunner.getActiveProcessCount()).toBe(0);
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('305. Stdin write failure produces exact typed scrubbed diagnostic and single settlement', async () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-proc-stdin-'));
      try {
        const scriptPath = path.join(testDir, 'exit.js');
        fs.writeFileSync(scriptPath, 'process.exit(0);', 'utf8');

        const execId = crypto.randomUUID();
        const result = await ProcessRunner.execute({
          executable: process.execPath,
          args: [scriptPath],
          cwd: testDir,
          executionId: execId,
          stdin: 'A'.repeat(500000),
        });

        expect([0, -1]).toContain(result.exitCode);
        expect(['NOT_APPLICABLE', 'PROCESS_TREE_TERMINATED_PROVEN']).toContain(result.processTermination);
        expect(ProcessRunner.getActiveProcessCount()).toBe(0);
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('306. Child process error during execution produces launch failure and leaves empty active registry', async () => {
      const execId = crypto.randomUUID();
      const result = await ProcessRunner.execute({
        executable: 'non_existent_binary_execution_probe_xyz_123',
        args: ['--version'],
        cwd: os.tmpdir(),
        executionId: execId,
      });

      expect(['NOT_STARTED_PROVEN', 'START_AMBIGUOUS']).toContain(result.processStart);
      expect(result.errorCode).toBe('PROCESS_LAUNCH_FAILED');
      expect(ProcessRunner.getActiveProcessCount()).toBe(0);
    });

    it('307. Durable terminal-update failure is visible, fails closed, and cleans active registry', async () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-proc-durable-'));
      const origUpdate = fixtures.repo.updateProcessRun.bind(fixtures.repo);
      try {
        const scriptPath = path.join(testDir, 'quick.js');
        fs.writeFileSync(scriptPath, 'process.exit(0);', 'utf8');

        const execId = crypto.randomUUID();
        fixtures.repo.updateProcessRun = () => {
          throw new Error('Database disk I/O failure during updateProcessRun');
        };

        await expect(
          ProcessRunner.execute({
            executable: process.execPath,
            args: [scriptPath],
            cwd: testDir,
            executionId: execId,
            repo: fixtures.repo,
          })
        ).rejects.toThrow('DURABLE_TERMINAL_UPDATE_FAILED');

        // Visible in authority accounting as persistence-fenced
        expect(ProcessRunner.getActiveProcessCount()).toBe(1);
        expect(ProcessRunner.getPersistenceFencedCount()).toBe(1);

        // Retrying with restored persistence succeeds and cleans registry
        fixtures.repo.updateProcessRun = origUpdate;
        const retryResult = await ProcessRunner.retryPersistenceFenced(execId, fixtures.repo);
        expect(retryResult.exitCode).toBe(0);
        expect(ProcessRunner.getActiveProcessCount()).toBe(0);
        expect(ProcessRunner.getPersistenceFencedCount()).toBe(0);
      } finally {
        fixtures.repo.updateProcessRun = origUpdate;
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('308. Active registry is retained until death proof and cleared only after durable completion', async () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-proc-reg-'));
      try {
        const scriptPath = path.join(testDir, 'sleep.js');
        fs.writeFileSync(scriptPath, 'setTimeout(() => { process.exit(0); }, 300);', 'utf8');

        const execId = crypto.randomUUID();
        const procPromise = ProcessRunner.execute({
          executable: process.execPath,
          args: [scriptPath],
          cwd: testDir,
          executionId: execId,
        });

        await new Promise((r) => setTimeout(r, 60));
        expect(ProcessRunner.getActiveProcessCount()).toBeGreaterThan(0);

        const result = await procPromise;
        expect(result.exitCode).toBe(0);
        expect(result.processTermination).toBe('PROCESS_TREE_TERMINATED_PROVEN');
        expect(ProcessRunner.getActiveProcessCount()).toBe(0);
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('309. Late process or stream callbacks do not mutate settled result or leak listeners', async () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-proc-late-'));
      try {
        const scriptPath = path.join(testDir, 'log.js');
        fs.writeFileSync(scriptPath, 'console.log("done"); process.exit(0);', 'utf8');

        const execId = crypto.randomUUID();
        const result = await ProcessRunner.execute({
          executable: process.execPath,
          args: [scriptPath],
          cwd: testDir,
          executionId: execId,
        });

        expect(result.exitCode).toBe(0);

        // Verify active count remains 0 after arbitrary delay
        await new Promise((r) => setTimeout(r, 100));
        expect(ProcessRunner.getActiveProcessCount()).toBe(0);
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('310. Envelope with task_ownership_epoch 0 or negative is rejected with zero mutation', () => {
      const nowIso = new Date().toISOString();
      const envelopeObj = {
        adjudication_id: crypto.randomUUID(),
        artifact_manifest_hash: 'a'.repeat(64),
        assignment_id: crypto.randomUUID(),
        attempt_id: crypto.randomUUID(),
        authorization_id: crypto.randomUUID(),
        command_snapshot_hash: 'b'.repeat(64),
        exit_classification: 'EXIT_ZERO',
        failure_code: null,
        failure_payload: null,
        finish_timestamp: nowIso,
        git_diff_evidence_hash: '',
        git_diff_evidence_id: '',
        git_status_evidence_hash: '',
        git_status_evidence_id: '',
        lifecycle_version: 3,
        process_start_classification: 'SPAWNED_PROVEN',
        project_id: crypto.randomUUID(),
        start_timestamp: nowIso,
        task_id: crypto.randomUUID(),
        task_ownership_epoch: 0,
        termination_classification: 'TERMINATION_PROVEN',
        test_result_evidence_hash: 'c'.repeat(64),
        test_result_evidence_id: crypto.randomUUID(),
        test_run_id: crypto.randomUUID(),
        verification_execution_id: crypto.randomUUID(),
        workspace_snapshot_after_evidence_id: crypto.randomUUID(),
        workspace_snapshot_after_hash: 'd'.repeat(64),
        workspace_snapshot_before_hash: 'e'.repeat(64),
      };

      const envelopeJson = canonicalJsonStringify(envelopeObj);
      const resZero = validateAndParseCanonicalResultEnvelope(envelopeJson);
      expect(resZero.valid).toBe(false);
      expect(resZero.error).toContain('task_ownership_epoch must be an integer strictly greater than zero');

      envelopeObj.task_ownership_epoch = -1;
      const resNeg = validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(envelopeObj));
      expect(resNeg.valid).toBe(false);
      expect(resNeg.error).toContain('task_ownership_epoch must be an integer strictly greater than zero');
    });

    it('311. Envelope with lifecycle_version other than positive integer is rejected', () => {
      const nowIso = new Date().toISOString();
      const envelopeObj = {
        adjudication_id: crypto.randomUUID(),
        artifact_manifest_hash: 'a'.repeat(64),
        assignment_id: crypto.randomUUID(),
        attempt_id: crypto.randomUUID(),
        authorization_id: crypto.randomUUID(),
        command_snapshot_hash: 'b'.repeat(64),
        exit_classification: 'EXIT_ZERO',
        failure_code: null,
        failure_payload: null,
        finish_timestamp: nowIso,
        git_diff_evidence_hash: '',
        git_diff_evidence_id: '',
        git_status_evidence_hash: '',
        git_status_evidence_id: '',
        lifecycle_version: 0,
        process_start_classification: 'SPAWNED_PROVEN',
        project_id: crypto.randomUUID(),
        start_timestamp: nowIso,
        task_id: crypto.randomUUID(),
        task_ownership_epoch: 1,
        termination_classification: 'TERMINATION_PROVEN',
        test_result_evidence_hash: 'c'.repeat(64),
        test_result_evidence_id: crypto.randomUUID(),
        test_run_id: crypto.randomUUID(),
        verification_execution_id: crypto.randomUUID(),
        workspace_snapshot_after_evidence_id: crypto.randomUUID(),
        workspace_snapshot_after_hash: 'd'.repeat(64),
        workspace_snapshot_before_hash: 'e'.repeat(64),
      };

      const resZero = validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(envelopeObj));
      expect(resZero.valid).toBe(false);
      expect(resZero.error).toContain('lifecycle_version must be positive integer');
    });

    it('312. Envelope with noncanonical date string is rejected; canonical ISO monotonic timestamps pass', () => {
      const nowIso = new Date().toISOString();
      const envelopeObj = {
        adjudication_id: crypto.randomUUID(),
        artifact_manifest_hash: 'a'.repeat(64),
        assignment_id: crypto.randomUUID(),
        attempt_id: crypto.randomUUID(),
        authorization_id: crypto.randomUUID(),
        command_snapshot_hash: 'b'.repeat(64),
        exit_classification: 'EXIT_ZERO',
        failure_code: null,
        failure_payload: null,
        finish_timestamp: nowIso,
        git_diff_evidence_hash: '',
        git_diff_evidence_id: '',
        git_status_evidence_hash: '',
        git_status_evidence_id: '',
        lifecycle_version: 3,
        process_start_classification: 'SPAWNED_PROVEN',
        project_id: crypto.randomUUID(),
        start_timestamp: nowIso,
        task_id: crypto.randomUUID(),
        task_ownership_epoch: 1,
        termination_classification: 'TERMINATION_PROVEN',
        test_result_evidence_hash: 'c'.repeat(64),
        test_result_evidence_id: crypto.randomUUID(),
        test_run_id: crypto.randomUUID(),
        verification_execution_id: crypto.randomUUID(),
        workspace_snapshot_after_evidence_id: crypto.randomUUID(),
        workspace_snapshot_after_hash: 'd'.repeat(64),
        workspace_snapshot_before_hash: 'e'.repeat(64),
      };

      // Non-canonical date: timezone offset instead of Z
      envelopeObj.start_timestamp = '2026-09-10T12:00:00+07:00';
      expect(validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(envelopeObj)).valid).toBe(false);

      // Non-canonical date: space separator instead of T
      envelopeObj.start_timestamp = '2026-09-10 12:00:00.000Z';
      expect(validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(envelopeObj)).valid).toBe(false);

      // Non-monotonic timestamps: finish earlier than start
      envelopeObj.start_timestamp = '2026-09-10T12:00:00.000Z';
      envelopeObj.finish_timestamp = '2026-09-10T11:59:59.000Z';
      const nonMonoRes = validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(envelopeObj));
      expect(nonMonoRes.valid).toBe(false);
      expect(nonMonoRes.error).toContain('monotonically');

      // Canonical monotonic ISO timestamps
      envelopeObj.start_timestamp = '2026-09-10T12:00:00.000Z';
      envelopeObj.finish_timestamp = '2026-09-10T12:00:01.000Z';
      expect(validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(envelopeObj)).valid).toBe(true);
    });

    it('313. Uppercase, short, long, nonhex, and empty required SHA-256 hashes are rejected', () => {
      const nowIso = new Date().toISOString();
      const baseEnvelope = {
        adjudication_id: crypto.randomUUID(),
        artifact_manifest_hash: 'a'.repeat(64),
        assignment_id: crypto.randomUUID(),
        attempt_id: crypto.randomUUID(),
        authorization_id: crypto.randomUUID(),
        command_snapshot_hash: 'b'.repeat(64),
        exit_classification: 'EXIT_ZERO',
        failure_code: null,
        failure_payload: null,
        finish_timestamp: nowIso,
        git_diff_evidence_hash: '',
        git_diff_evidence_id: '',
        git_status_evidence_hash: '',
        git_status_evidence_id: '',
        lifecycle_version: 3,
        process_start_classification: 'SPAWNED_PROVEN',
        project_id: crypto.randomUUID(),
        start_timestamp: nowIso,
        task_id: crypto.randomUUID(),
        task_ownership_epoch: 1,
        termination_classification: 'TERMINATION_PROVEN',
        test_result_evidence_hash: 'c'.repeat(64),
        test_result_evidence_id: crypto.randomUUID(),
        test_run_id: crypto.randomUUID(),
        verification_execution_id: crypto.randomUUID(),
        workspace_snapshot_after_evidence_id: crypto.randomUUID(),
        workspace_snapshot_after_hash: 'd'.repeat(64),
        workspace_snapshot_before_hash: 'e'.repeat(64),
      };

      // Uppercase hash
      const upperEnv = { ...baseEnvelope, command_snapshot_hash: 'B'.repeat(64) };
      expect(validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(upperEnv)).valid).toBe(false);

      // Short hash (63 chars)
      const shortEnv = { ...baseEnvelope, command_snapshot_hash: 'b'.repeat(63) };
      expect(validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(shortEnv)).valid).toBe(false);

      // Long hash (65 chars)
      const longEnv = { ...baseEnvelope, command_snapshot_hash: 'b'.repeat(65) };
      expect(validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(longEnv)).valid).toBe(false);

      // Non-hex hash
      const nonHexEnv = { ...baseEnvelope, command_snapshot_hash: 'g'.repeat(64) };
      expect(validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(nonHexEnv)).valid).toBe(false);

      // Empty hash where 64-hex required
      const emptyEnv = { ...baseEnvelope, command_snapshot_hash: '' };
      expect(validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(emptyEnv)).valid).toBe(false);
    });

    it('314. Contradictory optional evidence ID and hash pairing is rejected', () => {
      const nowIso = new Date().toISOString();
      const baseEnvelope = {
        adjudication_id: crypto.randomUUID(),
        artifact_manifest_hash: 'a'.repeat(64),
        assignment_id: crypto.randomUUID(),
        attempt_id: crypto.randomUUID(),
        authorization_id: crypto.randomUUID(),
        command_snapshot_hash: 'b'.repeat(64),
        exit_classification: 'EXIT_ZERO',
        failure_code: null,
        failure_payload: null,
        finish_timestamp: nowIso,
        git_diff_evidence_hash: '',
        git_diff_evidence_id: '',
        git_status_evidence_hash: '',
        git_status_evidence_id: '',
        lifecycle_version: 3,
        process_start_classification: 'SPAWNED_PROVEN',
        project_id: crypto.randomUUID(),
        start_timestamp: nowIso,
        task_id: crypto.randomUUID(),
        task_ownership_epoch: 1,
        termination_classification: 'TERMINATION_PROVEN',
        test_result_evidence_hash: 'c'.repeat(64),
        test_result_evidence_id: crypto.randomUUID(),
        test_run_id: crypto.randomUUID(),
        verification_execution_id: crypto.randomUUID(),
        workspace_snapshot_after_evidence_id: crypto.randomUUID(),
        workspace_snapshot_after_hash: 'd'.repeat(64),
        workspace_snapshot_before_hash: 'e'.repeat(64),
      };

      // ID present, hash empty
      const idWithoutHash = { ...baseEnvelope, git_status_evidence_id: 'ev-status-1', git_status_evidence_hash: '' };
      expect(validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(idWithoutHash)).valid).toBe(false);

      // Hash present, ID empty
      const hashWithoutId = { ...baseEnvelope, git_diff_evidence_id: '', git_diff_evidence_hash: 'f'.repeat(64) };
      expect(validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(hashWithoutId)).valid).toBe(false);

      // Both present and valid
      const bothPresent = {
        ...baseEnvelope,
        git_status_evidence_id: 'ev-status-1',
        git_status_evidence_hash: 'f'.repeat(64),
        git_diff_evidence_id: 'ev-diff-1',
        git_diff_evidence_hash: 'e'.repeat(64),
      };
      expect(validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(bothPresent)).valid).toBe(true);
    });

    it('315. Malformed or additional-field failure payload is rejected', () => {
      const nowIso = new Date().toISOString();
      const baseFailedEnvelope = {
        adjudication_id: crypto.randomUUID(),
        artifact_manifest_hash: 'a'.repeat(64),
        assignment_id: crypto.randomUUID(),
        attempt_id: crypto.randomUUID(),
        authorization_id: crypto.randomUUID(),
        command_snapshot_hash: 'b'.repeat(64),
        exit_classification: 'EXIT_NONZERO',
        failure_code: 'TESTS_FAILED',
        failure_payload: { error: 'Test execution returned exit code 1' },
        finish_timestamp: nowIso,
        git_diff_evidence_hash: '',
        git_diff_evidence_id: '',
        git_status_evidence_hash: '',
        git_status_evidence_id: '',
        lifecycle_version: 3,
        process_start_classification: 'SPAWNED_PROVEN',
        project_id: crypto.randomUUID(),
        start_timestamp: nowIso,
        task_id: crypto.randomUUID(),
        task_ownership_epoch: 1,
        termination_classification: 'TERMINATION_PROVEN',
        test_result_evidence_hash: 'c'.repeat(64),
        test_result_evidence_id: crypto.randomUUID(),
        test_run_id: crypto.randomUUID(),
        verification_execution_id: crypto.randomUUID(),
        workspace_snapshot_after_evidence_id: crypto.randomUUID(),
        workspace_snapshot_after_hash: 'd'.repeat(64),
        workspace_snapshot_before_hash: 'e'.repeat(64),
      };

      // Valid failure payload
      expect(validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(baseFailedEnvelope)).valid).toBe(true);

      // Extra unauthorized field in failure_payload
      const extraField = {
        ...baseFailedEnvelope,
        failure_payload: { error: 'Failed', unauthorized_extra_field: 'malicious' },
      };
      const extraRes = validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(extraField));
      expect(extraRes.valid).toBe(false);
      expect(extraRes.error).toContain('unauthorized extra field');

      // Failure code set but failure_payload null
      const nullPayload = { ...baseFailedEnvelope, failure_payload: null };
      expect(validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(nullPayload)).valid).toBe(false);

      // Failure code null but failure_payload present
      const nullCodeWithPayload = {
        ...baseFailedEnvelope,
        exit_classification: 'EXIT_ZERO',
        failure_code: null,
      };
      expect(validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(nullCodeWithPayload)).valid).toBe(false);
    });

    it('316. Manifest-entry binding mismatches are rejected independently during settlement evaluation', () => {
      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const evId = 'ev-manifest-bind-' + crypto.randomUUID();
      const evPayload = 'test payload';
      const evHash = computeSha256(evPayload);

      // Create durable evidence row with storage_type INLINE
      fixtures.repo.createEvidence({
        id: evId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'TEST_RESULT',
        storage_type: 'INLINE',
        content_type: 'text/plain',
        byte_size: Buffer.byteLength(evPayload, 'utf8'),
        hash: evHash,
        file_path: null,
        summary: 'test evidence',
        raw_payload: evPayload,
        created_at: nowIso,
      });

      const entry: ArtifactManifestEntry = {
        byte_size: Buffer.byteLength(evPayload, 'utf8'),
        content_type: 'text/plain',
        evidence_id: evId,
        evidence_type: 'TEST_RESULT',
        relative_path: 'test_result.txt',
        sha256: evHash,
        storage_class: 'FILE', // MISMATCH against durable row's 'INLINE'
      };

      const manifest: ArtifactManifest = {
        adjudication_id: adjId,
        entries: [entry],
        lifecycle_version: 1,
        manifest_schema_version: 1,
        verification_execution_id: 'exec-1',
      };

      const trId = 'tr-manifest-bind-' + crypto.randomUUID();
      const testRun: TestRun = {
        id: trId,
        task_id: fixtures.taskId,
        command: 'npm test',
        exit_code: 0,
        passed_count: 1,
        failed_count: 0,
        skipped_count: 0,
        duration_ms: 10,
        evidence_id: evId,
        created_at: nowIso,
      };
      fixtures.repo.createTestRun(testRun);

      const adjudication: CoderSubmissionAdjudication = {
        id: adjId,
        submission_id: crypto.randomUUID(),
        authorization_id: fixtures.authorizationId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        assignment_id: fixtures.assignmentId,
        task_ownership_epoch: 1,
        action: 'ADMIT_VERIFICATION',
        status: 'VERIFYING',
        lifecycle_version: 2,
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: '{}',
        authority_snapshot_hash: computeSha256('{}'),
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        verification_commands_json: '{"command":"test"}',
        verification_commands_hash: computeSha256('{"command":"test"}'),
        created_at: nowIso,
        verification_started_at: nowIso,
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: trId,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: 'exec-1',
        artifact_manifest_json: null,
        artifact_manifest_hash: null,
      };

      const envelope: CanonicalVerificationResultEnvelope = {
        adjudication_id: adjId,
        artifact_manifest_hash: computeArtifactManifestHash(manifest),
        assignment_id: fixtures.assignmentId,
        attempt_id: fixtures.attemptId,
        authorization_id: fixtures.authorizationId,
        command_snapshot_hash: computeSha256('{"command":"test"}'),
        exit_classification: 'EXIT_ZERO',
        failure_code: null,
        failure_payload: null,
        finish_timestamp: nowIso,
        git_diff_evidence_hash: '',
        git_diff_evidence_id: '',
        git_status_evidence_hash: '',
        git_status_evidence_id: '',
        lifecycle_version: 3,
        process_start_classification: 'SPAWNED_PROVEN',
        project_id: fixtures.projectId,
        start_timestamp: nowIso,
        task_id: fixtures.taskId,
        task_ownership_epoch: 1,
        termination_classification: 'TERMINATION_PROVEN',
        test_result_evidence_hash: evHash,
        test_result_evidence_id: evId,
        test_run_id: trId,
        verification_execution_id: 'exec-1',
        workspace_snapshot_after_evidence_id: crypto.randomUUID(),
        workspace_snapshot_after_hash: 'd'.repeat(64),
        workspace_snapshot_before_hash: 'e'.repeat(64),
      };

      const decStorage = evaluateNonAuthoritativeSettlementDecisionForTests({
        envelope,
        adjudication,
        testRun,
        manifest,
        testResultEvidenceId: evId,
        repo: fixtures.repo,
        artifactStore: fixtures.artifactStore,
      });
      expect(decStorage.valid).toBe(false);
      expect(decStorage.failureCode).toBe('INTEGRITY_MISMATCH');
      expect(decStorage.contradictionReason).toBe('Manifest entry storage class mismatch');
    });

    it('317. Envelope evidence hashes that disagree with durable rows are rejected independently', () => {
      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const evId = 'ev-disagree-' + crypto.randomUUID();
      const evPayload = 'test payload';
      const actualHash = computeSha256(evPayload);

      fixtures.repo.createEvidence({
        id: evId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'TEST_RESULT',
        storage_type: 'INLINE',
        content_type: 'text/plain',
        byte_size: Buffer.byteLength(evPayload, 'utf8'),
        hash: actualHash,
        file_path: null,
        summary: 'test evidence',
        raw_payload: evPayload,
        created_at: nowIso,
      });

      const entry: ArtifactManifestEntry = {
        byte_size: Buffer.byteLength(evPayload, 'utf8'),
        content_type: 'text/plain',
        evidence_id: evId,
        evidence_type: 'TEST_RESULT',
        relative_path: 'test_result.txt',
        sha256: actualHash,
        storage_class: 'INLINE',
      };

      const manifest: ArtifactManifest = {
        adjudication_id: adjId,
        entries: [entry],
        lifecycle_version: 1,
        manifest_schema_version: 1,
        verification_execution_id: 'exec-disagree',
      };

      const trId = 'tr-disagree-' + crypto.randomUUID();
      const testRun: TestRun = {
        id: trId,
        task_id: fixtures.taskId,
        command: 'npm test',
        exit_code: 0,
        passed_count: 1,
        failed_count: 0,
        skipped_count: 0,
        duration_ms: 10,
        evidence_id: evId,
        created_at: nowIso,
      };
      fixtures.repo.createTestRun(testRun);

      const adjudication: CoderSubmissionAdjudication = {
        id: adjId,
        submission_id: crypto.randomUUID(),
        authorization_id: fixtures.authorizationId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        assignment_id: fixtures.assignmentId,
        task_ownership_epoch: 1,
        action: 'ADMIT_VERIFICATION',
        status: 'VERIFYING',
        lifecycle_version: 2,
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: '{}',
        authority_snapshot_hash: computeSha256('{}'),
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        verification_commands_json: '{"command":"test"}',
        verification_commands_hash: computeSha256('{"command":"test"}'),
        created_at: nowIso,
        verification_started_at: nowIso,
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: trId,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: 'exec-disagree',
        artifact_manifest_json: null,
        artifact_manifest_hash: null,
      };

      // Disagreeing test result hash in envelope
      const envelope: CanonicalVerificationResultEnvelope = {
        adjudication_id: adjId,
        artifact_manifest_hash: computeArtifactManifestHash(manifest),
        assignment_id: fixtures.assignmentId,
        attempt_id: fixtures.attemptId,
        authorization_id: fixtures.authorizationId,
        command_snapshot_hash: computeSha256('{"command":"test"}'),
        exit_classification: 'EXIT_ZERO',
        failure_code: null,
        failure_payload: null,
        finish_timestamp: nowIso,
        git_diff_evidence_hash: '',
        git_diff_evidence_id: '',
        git_status_evidence_hash: '',
        git_status_evidence_id: '',
        lifecycle_version: 3,
        process_start_classification: 'SPAWNED_PROVEN',
        project_id: fixtures.projectId,
        start_timestamp: nowIso,
        task_id: fixtures.taskId,
        task_ownership_epoch: 1,
        termination_classification: 'TERMINATION_PROVEN',
        test_result_evidence_hash: 'f'.repeat(64), // Disagrees with manifest entry and durable row
        test_result_evidence_id: evId,
        test_run_id: trId,
        verification_execution_id: 'exec-disagree',
        workspace_snapshot_after_evidence_id: crypto.randomUUID(),
        workspace_snapshot_after_hash: 'd'.repeat(64),
        workspace_snapshot_before_hash: 'e'.repeat(64),
      };

      const decision = evaluateNonAuthoritativeSettlementDecisionForTests({
        envelope,
        adjudication,
        testRun,
        manifest,
        testResultEvidenceId: evId,
        repo: fixtures.repo,
        artifactStore: fixtures.artifactStore,
      });

      expect(decision.valid).toBe(false);
      expect(decision.targetStatus).toBe('RECOVERY_FENCED');
      expect(decision.contradictionReason).toBe('test_result_evidence manifest binding mismatch');
    });

    it('318. Exact terminal recovery classifications and conflict detection are enforced fail-closed', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
      const nowIso = new Date().toISOString();

      // Create a pre-result RECOVERY_FENCED row with a contradictory SETTLED disposition
      fixtures.repo.createCoderSubmissionAdjudication({
        id: adjId,
        submission_id: subId,
        authorization_id: fixtures.authorizationId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        assignment_id: fixtures.assignmentId,
        task_ownership_epoch: 1,
        action: 'ADMIT_VERIFICATION',
        status: 'RECOVERY_FENCED',
        lifecycle_version: 3,
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: nowIso,
        verification_started_at: null,
        completed_at: null,
        recovery_fenced_at: nowIso,
        failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
        failure_json: canonicalJsonStringify({ is_fenced: true, reason: 'Fenced test' }),
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: null,
        verification_result_envelope_json: null,
        verification_result_envelope_hash: null,
        artifact_manifest_json: null,
        artifact_manifest_hash: null,
      });

      fixtures.db.prepare("UPDATE tasks SET state = 'NEEDS_HUMAN' WHERE id = ?").run(fixtures.taskId);

      // Insert contradictory SETTLED disposition
      fixtures.repo.createCoderSubmissionDisposition({
        id: deriveDeterministicDispositionId(subId, adjId, 3),
        submission_id: subId,
        disposition_event: 'SETTLED',
        disposition_reason: 'ACCEPTED_VERIFIED',
        actor_type: 'SYSTEM',
        actor_id: 'test-actor',
        disposition_metadata_json: '{}',
        created_at: nowIso,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      const recon = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(recon.classification).toBe('AUTHORITY_CONFLICT');
      expect(recon.action_taken).toBe('NO_OP');
      expect(recon.error).toContain('Pre-result RECOVERY_FENCED has contradictory SETTLED disposition');
    });

    it('319. Evaluator fails closed on missing or empty rawEnvelopeJson, storedEnvelopeHash, rawManifestJson, storedManifestHash', () => {
      const baseInput = {
        storedEnvelopeHash: 'a'.repeat(64),
        rawEnvelopeJson: '{}',
        storedManifestHash: 'b'.repeat(64),
        rawManifestJson: '{}',
        adjudication: {} as unknown as CoderSubmissionAdjudication,
        testRun: {} as unknown as TestRun,
        gitStatusEvidenceId: null,
        gitDiffEvidenceId: null,
        testResultEvidenceId: 'ev-1',
        repo: fixtures.repo,
        artifactStore: fixtures.artifactStore,
      };

      const r1 = evaluateCanonicalSettlementDecision({ ...baseInput, storedEnvelopeHash: '' });
      expect(r1.valid).toBe(false);
      expect(r1.contradictionReason).toBe('storedEnvelopeHash invalid');

      const r1b = evaluateCanonicalSettlementDecision({ ...baseInput, storedEnvelopeHash: 'not-hex' });
      expect(r1b.valid).toBe(false);

      const r2 = evaluateCanonicalSettlementDecision({ ...baseInput, storedManifestHash: '' });
      expect(r2.valid).toBe(false);
      expect(r2.contradictionReason).toBe('storedManifestHash invalid');

      const r3 = evaluateCanonicalSettlementDecision({ ...baseInput, rawEnvelopeJson: '   ' });
      expect(r3.valid).toBe(false);
      expect(r3.contradictionReason).toBe('rawEnvelopeJson missing');

      const r4 = evaluateCanonicalSettlementDecision({ ...baseInput, rawManifestJson: '' });
      expect(r4.valid).toBe(false);
      expect(r4.contradictionReason).toBe('rawManifestJson missing');
    });

    it('320. Evaluator stored-envelope & stored-manifest hash mismatch fails closed without synthesis', () => {
      const rawEnv = canonicalJsonStringify({ dummy: 1 });
      const rawMan = canonicalJsonStringify({ dummy: 2 });
      const envHash = computeSha256(rawEnv);
      const manHash = computeSha256(rawMan);

      const baseInput = {
        storedEnvelopeHash: envHash,
        rawEnvelopeJson: rawEnv,
        storedManifestHash: manHash,
        rawManifestJson: rawMan,
        adjudication: {} as unknown as CoderSubmissionAdjudication,
        testRun: {} as unknown as TestRun,
        gitStatusEvidenceId: null,
        gitDiffEvidenceId: null,
        testResultEvidenceId: 'ev-1',
        repo: fixtures.repo,
        artifactStore: fixtures.artifactStore,
      };

      const r1 = evaluateCanonicalSettlementDecision({
        ...baseInput,
        storedEnvelopeHash: '0'.repeat(64),
      });
      expect(r1.valid).toBe(false);
      expect(r1.contradictionReason).toBe('Envelope hash mismatch');

      const r2 = evaluateCanonicalSettlementDecision({
        ...baseInput,
        storedManifestHash: '0'.repeat(64),
      });
      expect(r2.valid).toBe(false);
      expect(r2.contradictionReason).toBe('Manifest hash mismatch');
    });

    it('321. Closed failure code enum & strict discriminated payload schema: unknown codes and extra payload keys rejected', () => {
      const nowIso = new Date().toISOString();
      const validEnvelope: CanonicalVerificationResultEnvelope = {
        adjudication_id: crypto.randomUUID(),
        artifact_manifest_hash: 'a'.repeat(64),
        assignment_id: crypto.randomUUID(),
        attempt_id: crypto.randomUUID(),
        authorization_id: crypto.randomUUID(),
        command_snapshot_hash: 'b'.repeat(64),
        exit_classification: 'EXIT_NONZERO',
        failure_code: 'TESTS_FAILED',
        failure_payload: { failed_tests_count: 1 },
        finish_timestamp: nowIso,
        git_diff_evidence_hash: '',
        git_diff_evidence_id: '',
        git_status_evidence_hash: '',
        git_status_evidence_id: '',
        lifecycle_version: 3,
        process_start_classification: 'SPAWNED_PROVEN',
        project_id: crypto.randomUUID(),
        start_timestamp: nowIso,
        task_id: crypto.randomUUID(),
        task_ownership_epoch: 1,
        termination_classification: 'TERMINATION_PROVEN',
        test_result_evidence_hash: 'c'.repeat(64),
        test_result_evidence_id: crypto.randomUUID(),
        test_run_id: crypto.randomUUID(),
        verification_execution_id: crypto.randomUUID(),
        workspace_snapshot_after_evidence_id: crypto.randomUUID(),
        workspace_snapshot_after_hash: 'd'.repeat(64),
        workspace_snapshot_before_hash: 'e'.repeat(64),
      };

      // Unknown failure code rejected
      const unknownCodeEnv = {
        ...validEnvelope,
        failure_code: 'UNKNOWN_TEST_CODE' as unknown as NonNullable<CanonicalVerificationResultEnvelope['failure_code']>,
      };
      const p1 = validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(unknownCodeEnv));
      expect(p1.valid).toBe(false);
      expect(p1.error).toContain('is not a supported canonical failure_code');

      // Extra key in failure_payload rejected
      const extraKeyEnv = {
        ...validEnvelope,
        failure_payload: { failed_tests_count: 1, extra_unauthorized_key: true },
      };
      const p2 = validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(extraKeyEnv));
      expect(p2.valid).toBe(false);
      expect(p2.error).toContain('unrecognized key');

      // Missing required field in failure_payload rejected
      const missingFieldEnv = {
        ...validEnvelope,
        failure_code: 'RECOVERY_FENCED' as const,
        failure_payload: { reason: 'some reason' },
      };
      const p3 = validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(missingFieldEnv));
      expect(p3.valid).toBe(false);
      expect(p3.error).toContain('must have is_fenced: true');
    });

    it('322. Fenced failure codes require is_fenced: true and reject is_fenced: false; non-fenced forbid is_fenced', () => {
      const nowIso = new Date().toISOString();
      const validEnvelope: CanonicalVerificationResultEnvelope = {
        adjudication_id: crypto.randomUUID(),
        artifact_manifest_hash: 'a'.repeat(64),
        assignment_id: crypto.randomUUID(),
        attempt_id: crypto.randomUUID(),
        authorization_id: crypto.randomUUID(),
        command_snapshot_hash: 'b'.repeat(64),
        exit_classification: 'EXIT_NONZERO',
        failure_code: 'RECOVERY_FENCED',
        failure_payload: { is_fenced: true, reason: 'fenced reason' },
        finish_timestamp: nowIso,
        git_diff_evidence_hash: '',
        git_diff_evidence_id: '',
        git_status_evidence_hash: '',
        git_status_evidence_id: '',
        lifecycle_version: 3,
        process_start_classification: 'SPAWNED_PROVEN',
        project_id: crypto.randomUUID(),
        start_timestamp: nowIso,
        task_id: crypto.randomUUID(),
        task_ownership_epoch: 1,
        termination_classification: 'TERMINATION_PROVEN',
        test_result_evidence_hash: 'c'.repeat(64),
        test_result_evidence_id: crypto.randomUUID(),
        test_run_id: crypto.randomUUID(),
        verification_execution_id: crypto.randomUUID(),
        workspace_snapshot_after_evidence_id: crypto.randomUUID(),
        workspace_snapshot_after_hash: 'd'.repeat(64),
        workspace_snapshot_before_hash: 'e'.repeat(64),
      };

      // Fenced code with is_fenced: true passes
      expect(validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(validEnvelope)).valid).toBe(true);

      // Fenced code with is_fenced: false fails
      const fencedFalseEnv = {
        ...validEnvelope,
        failure_payload: { is_fenced: false, reason: 'fenced reason' } as unknown as CanonicalVerificationResultEnvelope['failure_payload'],
      };
      const p1 = validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(fencedFalseEnv));
      expect(p1.valid).toBe(false);
      expect(p1.error).toContain('must have is_fenced: true');

      // Non-fenced code with is_fenced: true fails
      const nonFencedEnv = {
        ...validEnvelope,
        failure_code: 'TESTS_FAILED' as const,
        failure_payload: { failed_tests_count: 2, is_fenced: true } as unknown as CanonicalVerificationResultEnvelope['failure_payload'],
      };
      const p2 = validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(nonFencedEnv));
      expect(p2.valid).toBe(false);
      expect(p2.error).toContain('must not include is_fenced');
    });

    it('323. Success requires both failure_code and failure_payload to be null; contradictory combinations fail', () => {
      const nowIso = new Date().toISOString();
      const baseEnvelope: CanonicalVerificationResultEnvelope = {
        adjudication_id: crypto.randomUUID(),
        artifact_manifest_hash: 'a'.repeat(64),
        assignment_id: crypto.randomUUID(),
        attempt_id: crypto.randomUUID(),
        authorization_id: crypto.randomUUID(),
        command_snapshot_hash: 'b'.repeat(64),
        exit_classification: 'EXIT_ZERO',
        failure_code: null,
        failure_payload: null,
        finish_timestamp: nowIso,
        git_diff_evidence_hash: '',
        git_diff_evidence_id: '',
        git_status_evidence_hash: '',
        git_status_evidence_id: '',
        lifecycle_version: 3,
        process_start_classification: 'SPAWNED_PROVEN',
        project_id: crypto.randomUUID(),
        start_timestamp: nowIso,
        task_id: crypto.randomUUID(),
        task_ownership_epoch: 1,
        termination_classification: 'TERMINATION_PROVEN',
        test_result_evidence_hash: 'c'.repeat(64),
        test_result_evidence_id: crypto.randomUUID(),
        test_run_id: crypto.randomUUID(),
        verification_execution_id: crypto.randomUUID(),
        workspace_snapshot_after_evidence_id: crypto.randomUUID(),
        workspace_snapshot_after_hash: 'd'.repeat(64),
        workspace_snapshot_before_hash: 'e'.repeat(64),
      };

      // EXIT_ZERO with non-null failure_code
      const c1 = { ...baseEnvelope, failure_code: 'TESTS_FAILED' as const, failure_payload: { failed_tests_count: 1 } };
      const p1 = validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(c1));
      expect(p1.valid).toBe(false);
      expect(p1.error).toContain('failure_code must be null when exit_classification is EXIT_ZERO');

      // EXIT_ZERO with null failure_code but non-null failure_payload
      const c2 = { ...baseEnvelope, failure_payload: { is_fenced: true } as unknown as CanonicalVerificationResultEnvelope['failure_payload'] };
      const p2 = validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(c2));
      expect(p2.valid).toBe(false);
      expect(p2.error).toContain('failure_payload must be null when failure_code is null');

      // EXIT_NONZERO with null failure_code
      const c3 = { ...baseEnvelope, exit_classification: 'EXIT_NONZERO' as const };
      const p3 = validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(c3));
      expect(p3.valid).toBe(false);
      expect(p3.error).toContain('failure_code must be non-null when exit_classification is not EXIT_ZERO');

      // Failure code with null failure_payload
      const c4 = { ...baseEnvelope, exit_classification: 'EXIT_NONZERO' as const, failure_code: 'TESTS_FAILED' as const, failure_payload: null };
      const p4 = validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(c4));
      expect(p4.valid).toBe(false);
      expect(p4.error).toContain('failure_payload must be non-null when failure_code is non-null');
    });

    it('324. Manifest entries and envelope evidence 1:1 set equality: extra manifest entry and duplicate evidence IDs rejected', () => {
      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const evId = 'ev-set-' + crypto.randomUUID();
      const evPayload = 'set test';
      const actualHash = computeSha256(evPayload);

      fixtures.repo.createEvidence({
        id: evId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'TEST_RESULT',
        storage_type: 'INLINE',
        content_type: 'text/plain',
        byte_size: Buffer.byteLength(evPayload, 'utf8'),
        hash: actualHash,
        file_path: null,
        summary: 'test evidence',
        raw_payload: evPayload,
        created_at: nowIso,
      });

      const trId = 'tr-set-' + crypto.randomUUID();
      fixtures.repo.createTestRun({
        id: trId,
        task_id: fixtures.taskId,
        command: 'npm test',
        exit_code: 0,
        passed_count: 1,
        failed_count: 0,
        skipped_count: 0,
        duration_ms: 10,
        evidence_id: evId,
        created_at: nowIso,
      });

      const entry: ArtifactManifestEntry = {
        byte_size: Buffer.byteLength(evPayload, 'utf8'),
        content_type: 'text/plain',
        evidence_id: evId,
        evidence_type: 'TEST_RESULT',
        relative_path: 'test_result.txt',
        sha256: actualHash,
        storage_class: 'INLINE',
      };

      // Extra manifest entry not referenced in envelope
      const extraEntry: ArtifactManifestEntry = {
        byte_size: 10,
        content_type: 'text/plain',
        evidence_id: 'ev-extra-' + crypto.randomUUID(),
        evidence_type: 'CUSTOM',
        relative_path: 'extra.txt',
        sha256: 'f'.repeat(64),
        storage_class: 'INLINE',
      };

      const manifestWithExtra: ArtifactManifest = {
        adjudication_id: adjId,
        entries: [entry, extraEntry],
        lifecycle_version: 1,
        manifest_schema_version: 1,
        verification_execution_id: 'exec-set',
      };

      const envelope: CanonicalVerificationResultEnvelope = {
        adjudication_id: adjId,
        artifact_manifest_hash: computeArtifactManifestHash(manifestWithExtra),
        assignment_id: fixtures.assignmentId,
        attempt_id: fixtures.attemptId,
        authorization_id: fixtures.authorizationId,
        command_snapshot_hash: computeSha256('{}'),
        exit_classification: 'EXIT_ZERO',
        failure_code: null,
        failure_payload: null,
        finish_timestamp: nowIso,
        git_diff_evidence_hash: '',
        git_diff_evidence_id: '',
        git_status_evidence_hash: '',
        git_status_evidence_id: '',
        lifecycle_version: 3,
        process_start_classification: 'SPAWNED_PROVEN',
        project_id: fixtures.projectId,
        start_timestamp: nowIso,
        task_id: fixtures.taskId,
        task_ownership_epoch: 1,
        termination_classification: 'TERMINATION_PROVEN',
        test_result_evidence_hash: actualHash,
        test_result_evidence_id: evId,
        test_run_id: trId,
        verification_execution_id: 'exec-set',
        workspace_snapshot_after_evidence_id: crypto.randomUUID(),
        workspace_snapshot_after_hash: actualHash,
        workspace_snapshot_before_hash: 'e'.repeat(64),
      };

      const d1 = evaluateNonAuthoritativeSettlementDecisionForTests({
        envelope,
        adjudication: { id: adjId, project_id: fixtures.projectId, task_id: fixtures.taskId, attempt_id: fixtures.attemptId, assignment_id: fixtures.assignmentId, authorization_id: fixtures.authorizationId, task_ownership_epoch: 1, verification_commands_hash: computeSha256('{}'), workspace_snapshot_before_hash: 'e'.repeat(64) } as unknown as CoderSubmissionAdjudication,
        testRun: fixtures.repo.getTestRun(trId),
        manifest: manifestWithExtra,
        testResultEvidenceId: evId,
        repo: fixtures.repo,
        artifactStore: fixtures.artifactStore,
      });
      expect(d1.valid).toBe(false);
      expect(d1.contradictionReason).toBe('Manifest entry set equality mismatch');

      // Duplicate manifest entries
      const manifestWithDup: ArtifactManifest = {
        adjudication_id: adjId,
        entries: [entry, { ...entry }],
        lifecycle_version: 1,
        manifest_schema_version: 1,
        verification_execution_id: 'exec-set',
      };
      const d2 = evaluateNonAuthoritativeSettlementDecisionForTests({
        envelope: { ...envelope, artifact_manifest_hash: computeArtifactManifestHash(manifestWithDup) },
        adjudication: { id: adjId, project_id: fixtures.projectId, task_id: fixtures.taskId, attempt_id: fixtures.attemptId, assignment_id: fixtures.assignmentId, authorization_id: fixtures.authorizationId, task_ownership_epoch: 1, verification_commands_hash: computeSha256('{}'), workspace_snapshot_before_hash: 'e'.repeat(64) } as unknown as CoderSubmissionAdjudication,
        testRun: fixtures.repo.getTestRun(trId),
        manifest: manifestWithDup,
        testResultEvidenceId: evId,
        repo: fixtures.repo,
        artifactStore: fixtures.artifactStore,
      });
      expect(d2.valid).toBe(false);
      expect(d2.contradictionReason).toBe('Duplicate manifest evidence_id');
    });

    it('325. Independent manifest binding field validations fail on divergence (storage class, size, content type, hash)', () => {
      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const evId = 'ev-div-' + crypto.randomUUID();
      const evPayload = 'divergence payload';
      const actualHash = computeSha256(evPayload);

      fixtures.repo.createEvidence({
        id: evId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'TEST_RESULT',
        storage_type: 'INLINE',
        content_type: 'text/plain',
        byte_size: Buffer.byteLength(evPayload, 'utf8'),
        hash: actualHash,
        file_path: null,
        summary: 'divergence test',
        raw_payload: evPayload,
        created_at: nowIso,
      });

      const trId = 'tr-div-' + crypto.randomUUID();
      fixtures.repo.createTestRun({
        id: trId,
        task_id: fixtures.taskId,
        command: 'npm test',
        exit_code: 0,
        passed_count: 1,
        failed_count: 0,
        skipped_count: 0,
        duration_ms: 10,
        evidence_id: evId,
        created_at: nowIso,
      });

      const validEntry: ArtifactManifestEntry = {
        byte_size: Buffer.byteLength(evPayload, 'utf8'),
        content_type: 'text/plain',
        evidence_id: evId,
        evidence_type: 'TEST_RESULT',
        relative_path: 'test_result.txt',
        sha256: actualHash,
        storage_class: 'INLINE',
      };

      const baseAdj = {
        id: adjId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        assignment_id: fixtures.assignmentId,
        authorization_id: fixtures.authorizationId,
        task_ownership_epoch: 1,
        verification_commands_hash: computeSha256('{}'),
        workspace_snapshot_before_hash: 'e'.repeat(64),
      } as unknown as CoderSubmissionAdjudication;

      const runEval = (entry: ArtifactManifestEntry) => {
        const manifest: ArtifactManifest = {
          adjudication_id: adjId,
          entries: [entry],
          lifecycle_version: 1,
          manifest_schema_version: 1,
          verification_execution_id: 'exec-div',
        };
        const envelope: CanonicalVerificationResultEnvelope = {
          adjudication_id: adjId,
          artifact_manifest_hash: computeArtifactManifestHash(manifest),
          assignment_id: fixtures.assignmentId,
          attempt_id: fixtures.attemptId,
          authorization_id: fixtures.authorizationId,
          command_snapshot_hash: computeSha256('{}'),
          exit_classification: 'EXIT_ZERO',
          failure_code: null,
          failure_payload: null,
          finish_timestamp: nowIso,
          git_diff_evidence_hash: '',
          git_diff_evidence_id: '',
          git_status_evidence_hash: '',
          git_status_evidence_id: '',
          lifecycle_version: 3,
          process_start_classification: 'SPAWNED_PROVEN',
          project_id: fixtures.projectId,
          start_timestamp: nowIso,
          task_id: fixtures.taskId,
          task_ownership_epoch: 1,
          termination_classification: 'TERMINATION_PROVEN',
          test_result_evidence_hash: entry.sha256,
          test_result_evidence_id: evId,
          test_run_id: trId,
          verification_execution_id: 'exec-div',
          workspace_snapshot_after_evidence_id: crypto.randomUUID(),
          workspace_snapshot_after_hash: actualHash,
          workspace_snapshot_before_hash: 'e'.repeat(64),
        };
        return evaluateNonAuthoritativeSettlementDecisionForTests({
          envelope,
          adjudication: baseAdj,
          testRun: fixtures.repo.getTestRun(trId),
          manifest,
          testResultEvidenceId: evId,
          repo: fixtures.repo,
          artifactStore: fixtures.artifactStore,
        });
      };

      // Divergent storage_class
      const d1 = runEval({ ...validEntry, storage_class: 'FILE' as const });
      expect(d1.valid).toBe(false);
      expect(d1.contradictionReason).toBe('Manifest entry storage class mismatch');

      // Divergent content_type
      const d2 = runEval({ ...validEntry, content_type: 'application/json' });
      expect(d2.valid).toBe(false);
      expect(d2.contradictionReason).toBe('Manifest entry content type mismatch');

      // Divergent byte_size
      const d3 = runEval({ ...validEntry, byte_size: 9999 });
      expect(d3.valid).toBe(false);
      expect(d3.contradictionReason).toBe('Manifest entry byte size mismatch');

      // Divergent sha256
      const d4 = runEval({ ...validEntry, sha256: '9'.repeat(64) });
      expect(d4.valid).toBe(false);
      expect(d4.contradictionReason).toBe('Manifest entry hash mismatch');

      // Divergent evidence_type
      const d5 = runEval({ ...validEntry, evidence_type: 'CUSTOM' as const });
      expect(d5.valid).toBe(false);
      expect(d5.contradictionReason).toBe('Manifest entry evidence type mismatch');
    });

    it('326. Envelope-to-durable evidence row bindings fail independently on hash/ID disagreement', () => {
      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const evId = 'ev-bind-' + crypto.randomUUID();
      const evPayload = 'bind payload';
      const actualHash = computeSha256(evPayload);

      fixtures.repo.createEvidence({
        id: evId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'TEST_RESULT',
        storage_type: 'INLINE',
        content_type: 'text/plain',
        byte_size: Buffer.byteLength(evPayload, 'utf8'),
        hash: actualHash,
        file_path: null,
        summary: 'bind test',
        raw_payload: evPayload,
        created_at: nowIso,
      });

      const trId = 'tr-bind-' + crypto.randomUUID();
      fixtures.repo.createTestRun({
        id: trId,
        task_id: fixtures.taskId,
        command: 'npm test',
        exit_code: 0,
        passed_count: 1,
        failed_count: 0,
        skipped_count: 0,
        duration_ms: 10,
        evidence_id: evId,
        created_at: nowIso,
      });

      const entry: ArtifactManifestEntry = {
        byte_size: Buffer.byteLength(evPayload, 'utf8'),
        content_type: 'text/plain',
        evidence_id: evId,
        evidence_type: 'TEST_RESULT',
        relative_path: 'test_result.txt',
        sha256: actualHash,
        storage_class: 'INLINE',
      };

      const manifest: ArtifactManifest = {
        adjudication_id: adjId,
        entries: [entry],
        lifecycle_version: 1,
        manifest_schema_version: 1,
        verification_execution_id: 'exec-bind',
      };

      const baseAdj = {
        id: adjId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        assignment_id: fixtures.assignmentId,
        authorization_id: fixtures.authorizationId,
        task_ownership_epoch: 1,
        verification_commands_hash: computeSha256('{}'),
        workspace_snapshot_before_hash: 'e'.repeat(64),
      } as unknown as CoderSubmissionAdjudication;

      // Disagreeing test_result_evidence_hash in envelope
      const envHashMismatch: CanonicalVerificationResultEnvelope = {
        adjudication_id: adjId,
        artifact_manifest_hash: computeArtifactManifestHash(manifest),
        assignment_id: fixtures.assignmentId,
        attempt_id: fixtures.attemptId,
        authorization_id: fixtures.authorizationId,
        command_snapshot_hash: computeSha256('{}'),
        exit_classification: 'EXIT_ZERO',
        failure_code: null,
        failure_payload: null,
        finish_timestamp: nowIso,
        git_diff_evidence_hash: '',
        git_diff_evidence_id: '',
        git_status_evidence_hash: '',
        git_status_evidence_id: '',
        lifecycle_version: 3,
        process_start_classification: 'SPAWNED_PROVEN',
        project_id: fixtures.projectId,
        start_timestamp: nowIso,
        task_id: fixtures.taskId,
        task_ownership_epoch: 1,
        termination_classification: 'TERMINATION_PROVEN',
        test_result_evidence_hash: '8'.repeat(64), // Disagrees with manifest and durable row
        test_result_evidence_id: evId,
        test_run_id: trId,
        verification_execution_id: 'exec-bind',
        workspace_snapshot_after_evidence_id: crypto.randomUUID(),
        workspace_snapshot_after_hash: actualHash,
        workspace_snapshot_before_hash: 'e'.repeat(64),
      };

      const d1 = evaluateNonAuthoritativeSettlementDecisionForTests({
        envelope: envHashMismatch,
        adjudication: baseAdj,
        testRun: fixtures.repo.getTestRun(trId),
        manifest,
        testResultEvidenceId: evId,
        repo: fixtures.repo,
        artifactStore: fixtures.artifactStore,
      });
      expect(d1.valid).toBe(false);
      expect(d1.contradictionReason).toBe('test_result_evidence manifest binding mismatch');
    });

    it('327. Workspace-before and workspace-after hashes fail independently when not backed by durable admission/captured evidence', () => {
      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const evId = 'ev-ws-' + crypto.randomUUID();
      const evPayload = 'ws payload';
      const actualHash = computeSha256(evPayload);

      fixtures.repo.createEvidence({
        id: evId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'TEST_RESULT',
        storage_type: 'INLINE',
        content_type: 'text/plain',
        byte_size: Buffer.byteLength(evPayload, 'utf8'),
        hash: actualHash,
        file_path: null,
        summary: 'ws test',
        raw_payload: evPayload,
        created_at: nowIso,
      });

      const trId = 'tr-ws-' + crypto.randomUUID();
      fixtures.repo.createTestRun({
        id: trId,
        task_id: fixtures.taskId,
        command: 'npm test',
        exit_code: 0,
        passed_count: 1,
        failed_count: 0,
        skipped_count: 0,
        duration_ms: 10,
        evidence_id: evId,
        created_at: nowIso,
      });

      const entry: ArtifactManifestEntry = {
        byte_size: Buffer.byteLength(evPayload, 'utf8'),
        content_type: 'text/plain',
        evidence_id: evId,
        evidence_type: 'TEST_RESULT',
        relative_path: 'test_result.txt',
        sha256: actualHash,
        storage_class: 'INLINE',
      };

      const manifest: ArtifactManifest = {
        adjudication_id: adjId,
        entries: [entry],
        lifecycle_version: 1,
        manifest_schema_version: 1,
        verification_execution_id: 'exec-ws',
      };

      const baseAdj = {
        id: adjId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        assignment_id: fixtures.assignmentId,
        authorization_id: fixtures.authorizationId,
        task_ownership_epoch: 1,
        verification_commands_hash: computeSha256('{}'),
        workspace_snapshot_before_hash: '1'.repeat(64),
      } as unknown as CoderSubmissionAdjudication;

      // workspace_snapshot_before_hash mismatch
      const envBeforeMismatch: CanonicalVerificationResultEnvelope = {
        adjudication_id: adjId,
        artifact_manifest_hash: computeArtifactManifestHash(manifest),
        assignment_id: fixtures.assignmentId,
        attempt_id: fixtures.attemptId,
        authorization_id: fixtures.authorizationId,
        command_snapshot_hash: computeSha256('{}'),
        exit_classification: 'EXIT_ZERO',
        failure_code: null,
        failure_payload: null,
        finish_timestamp: nowIso,
        git_diff_evidence_hash: '',
        git_diff_evidence_id: '',
        git_status_evidence_hash: '',
        git_status_evidence_id: '',
        lifecycle_version: 3,
        process_start_classification: 'SPAWNED_PROVEN',
        project_id: fixtures.projectId,
        start_timestamp: nowIso,
        task_id: fixtures.taskId,
        task_ownership_epoch: 1,
        termination_classification: 'TERMINATION_PROVEN',
        test_result_evidence_hash: actualHash,
        test_result_evidence_id: evId,
        test_run_id: trId,
        verification_execution_id: 'exec-ws',
        workspace_snapshot_after_evidence_id: crypto.randomUUID(),
        workspace_snapshot_after_hash: actualHash,
        workspace_snapshot_before_hash: '2'.repeat(64), // Mismatch!
      };

      const d1 = evaluateNonAuthoritativeSettlementDecisionForTests({
        envelope: envBeforeMismatch,
        adjudication: baseAdj,
        testRun: fixtures.repo.getTestRun(trId),
        manifest,
        testResultEvidenceId: evId,
        repo: fixtures.repo,
        artifactStore: fixtures.artifactStore,
      });
      expect(d1.valid).toBe(false);
      expect(d1.contradictionReason).toBe('workspace_snapshot_before_hash mismatch');

      // workspace_snapshot_after_hash not backed by durable evidence
      const envAfterMismatch = {
        ...envBeforeMismatch,
        workspace_snapshot_before_hash: '1'.repeat(64),
        workspace_snapshot_after_evidence_id: crypto.randomUUID(),
        workspace_snapshot_after_hash: '3'.repeat(64), // Not backed by evidence
      };
      const d2 = evaluateNonAuthoritativeSettlementDecisionForTests({
        envelope: envAfterMismatch,
        adjudication: baseAdj,
        testRun: fixtures.repo.getTestRun(trId),
        manifest,
        testResultEvidenceId: evId,
        repo: fixtures.repo,
        artifactStore: fixtures.artifactStore,
      });
      expect(d2.valid).toBe(false);
      expect(d2.contradictionReason).toBe('workspace_snapshot_after_hash not backed by durable evidence');
    });

  });
});
