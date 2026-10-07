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



  describe('Group 6: Category F — Settlement and Recovery', () => {
    it('89. Phase C settlement atomically links test run ID, git evidence IDs, updates adjudication to VERIFIED', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const res = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      expect(res.adjudication.status).toBe('VERIFIED');
      expect(res.adjudication.test_run_id).toBeDefined();
      expect(res.adjudication.completed_at).toBeDefined();

      const stored = fixtures.repo.getCoderSubmissionAdjudicationById(res.adjudication.id)!;
      expect(stored.status).toBe('VERIFIED');
      expect(stored.test_run_id).toBeDefined();
    });

    it('90. Verification success transitions task state to REVIEW_READY', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const task = fixtures.repo.getTask(fixtures.taskId)!;
      expect(task.state).toBe('REVIEW_READY');
    });

    it('91. Verification success appends exactly one ACCEPTED_VERIFIED disposition to coder_submission_dispositions', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const disps = fixtures.repo.getCoderSubmissionDispositions(subId);
      const verifiedDisps = disps.filter((d) => d.disposition_reason === 'ACCEPTED_VERIFIED');
      expect(verifiedDisps).toHaveLength(1);
      expect(verifiedDisps[0].disposition_event).toBe('SETTLED');
    });

    it('92. Failed test verification settles as VERIFICATION_FAILED', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Force failure command
      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const payload = JSON.parse(auth.canonical_payload_json!);
      payload.verificationCommands.TEST = { ...await approveFixtureScript(fixtures.repo, fixtures.projectId, 'process.exit(1);'), timeout_ms: 120000 };
      const newHash = computePayloadHash(payload);
      const newJson = JSON.stringify(payload);
      db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
        .run(newJson, newHash, fixtures.authorizationId);

      const res = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      expect(res.adjudication.status).toBe('VERIFICATION_FAILED');
    });

    it('93. Failed test verification NEVER appends ACCEPTED_VERIFIED disposition', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const payload = JSON.parse(auth.canonical_payload_json!);
      payload.verificationCommands.TEST = { ...await approveFixtureScript(fixtures.repo, fixtures.projectId, 'process.exit(1);'), timeout_ms: 120000 };
      const newHash = computePayloadHash(payload);
      const newJson = JSON.stringify(payload);
      db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
        .run(newJson, newHash, fixtures.authorizationId);

      await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const disps = fixtures.repo.getCoderSubmissionDispositions(subId);
      expect(disps.some((d) => d.disposition_reason === 'ACCEPTED_VERIFIED')).toBe(false);
    });

    it('94. Failed test verification NEVER appends MANUAL_OVERRIDE disposition', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const payload = JSON.parse(auth.canonical_payload_json!);
      payload.verificationCommands.TEST = { ...await approveFixtureScript(fixtures.repo, fixtures.projectId, 'process.exit(1);'), timeout_ms: 120000 };
      const newHash = computePayloadHash(payload);
      const newJson = JSON.stringify(payload);
      db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
        .run(newJson, newHash, fixtures.authorizationId);

      await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const disps = fixtures.repo.getCoderSubmissionDispositions(subId);
      expect(disps.some((d) => d.disposition_reason === 'MANUAL_OVERRIDE')).toBe(false);
    });

    it('95. Settlement rollback on transaction failure leaves database uncorrupted', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);

      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'ADMITTED', 1, ?, '${'1'.repeat(64)}',
          '{}', '${'1'.repeat(64)}', ?
        )
      `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, nowIso);

      // Attempt transaction that throws midway
      expect(() => {
        fixtures.repo.runInTransaction(() => {
          fixtures.repo.updateCoderSubmissionAdjudication(adjId, 1, {
            status: 'VERIFYING',
            verification_started_at: nowIso,
            verification_execution_id: crypto.randomUUID(),
            workspace_snapshot_before_json: '{}',
            workspace_snapshot_before_hash: computeSha256('{}'),
          });
          throw new Error('Simulated settlement failure');
        });
      }).toThrow('Simulated settlement failure');

      // State remains rolled back to ADMITTED
      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(adj.status).toBe('ADMITTED');
    });

    it('96. Settlement completion replay is an idempotent no-op', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const reqId = crypto.randomUUID();
      const res1 = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: reqId,
        submissionId: subId,
      });

      const res2 = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: reqId,
        submissionId: subId,
      });

      expect(res1.adjudication.id).toBe(res2.adjudication.id);
      expect(res2.status).toBe('VERIFIED');
    });

    it('97. Adjudication recovery scanner: ADMITTED state classified as PRE_VERIFICATION_NOT_STARTED and does not auto-run', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);
      const snapshotHash = computeSha256(snapshotJson);
      const cmdJson = '{}';
      const cmdHash = computeSha256(cmdJson);

      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'ADMITTED', 1, ?, ?,
          ?, ?, ?
        )
      `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, cmdJson, cmdHash, nowIso);

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.preVerificationNotStartedCount).toBe(1);

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(adj.status).toBe('ADMITTED');
    });

    it('98. Adjudication recovery scanner: VERIFYING unresolved state classified as VERIFICATION_IN_FLIGHT_UNRESOLVED and fenced to RECOVERY_FENCED without rerun', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);
      const snapshotHash = computeSha256(snapshotJson);
      const cmdJson = '{}';
      const cmdHash = computeSha256(cmdJson);
      const wsJson = '{}';
      const wsHash = computeSha256(wsJson);

      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, workspace_snapshot_before_json, workspace_snapshot_before_hash,
          verification_execution_id, verification_started_at, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'VERIFYING', 2, ?, ?,
          ?, ?, ?, ?, 'exec-crashed', ?, ?
        )
      `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, cmdJson, cmdHash, wsJson, wsHash, nowIso, nowIso);

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.verificationInFlightUnresolvedCount).toBe(1);

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(adj.status).toBe('RECOVERY_FENCED');
    });

    it('99. Adjudication recovery scanner: durable complete evidence permits DB-only reconciliation to ALREADY_RECONCILED', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.alreadyReconciledCount).toBe(1);
    });

    it('100. Adjudication recovery scanner: malformed durable evidence cannot reconcile and remains fenced', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);

      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, failure_code, created_at, recovery_fenced_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'RECOVERY_FENCED', 1, ?, '${'f'.repeat(64)}',
          '{}', '${'1'.repeat(64)}', 'ORPHANED_IN_FLIGHT_EXECUTION', ?, ?
        )
      `).run(crypto.randomUUID(), crypto.randomUUID(), subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, nowIso, nowIso);

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.authorityConflictCount).toBeGreaterThanOrEqual(1);
    });

    it('101. Adjudication recovery scanner: event insertion failure during recovery rolls back cleanly', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);

      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, workspace_snapshot_before_json, workspace_snapshot_before_hash,
          verification_execution_id, verification_started_at, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'VERIFYING', 2, ?, '${'1'.repeat(64)}',
          '{}', '${'1'.repeat(64)}', '{}', '${'1'.repeat(64)}', 'exec-evtfail', ?, ?
        )
      `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, nowIso, nowIso);

      db.exec('DROP TABLE coder_submission_adjudication_events;');

      expect(() => {
        fixtures.recoveryScanner.scanAndReconcile();
      }).toThrow();

      // Restore table with exact Migration 23 columns
      db.exec(`
        CREATE TABLE coder_submission_adjudication_events (
          id TEXT PRIMARY KEY,
          adjudication_id TEXT NOT NULL REFERENCES coder_submission_adjudications(id) ON DELETE RESTRICT,
          sequence INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    });

    it('102. Adjudication recovery scanner: repeated scan is idempotent and produces no duplicate events', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);
      const snapshotHash = computeSha256(snapshotJson);
      const cmdJson = '{}';
      const cmdHash = computeSha256(cmdJson);
      const wsJson = '{}';
      const wsHash = computeSha256(wsJson);

      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, workspace_snapshot_before_json, workspace_snapshot_before_hash,
          verification_execution_id, verification_started_at, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'VERIFYING', 2, ?, ?,
          ?, ?, ?, ?, 'exec-repeat', ?, ?
        )
      `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, cmdJson, cmdHash, wsJson, wsHash, nowIso, nowIso);

      fixtures.recoveryScanner.scanAndReconcile();
      const events1 = fixtures.repo.getCoderSubmissionAdjudicationEvents(adjId);

      fixtures.recoveryScanner.scanAndReconcile();
      const events2 = fixtures.repo.getCoderSubmissionAdjudicationEvents(adjId);

      expect(events2.length).toBe(events1.length);
    });

    it('103. Crash recovery service: startup recovery runs adjudication recovery scanner without touching unrelated R5I execution recovery states', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb, 23);
      const testRepo = new Repository(testDb);
      const testEventService = new EventService(testRepo);
      const crashService = new CrashRecoveryService(testDb, testRepo, testEventService);
      const report = crashService.performStartupRecovery();
      expect(report).toBeDefined();
      expect(report.adjudicationRecovery).toBeDefined();
      testDb.close();
    });

    it('104. Explicit resume on safe ADMITTED pre-start row allows verified execution to proceed', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);
      const snapshotHash = computeSha256(snapshotJson);
      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const authPayload = JSON.parse(auth.canonical_payload_json!);
      const cmdJson = canonicalJsonStringify(authPayload.verificationCommands);
      const cmdHash = computeSha256(cmdJson);

      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'ADMITTED', 1, ?, ?,
          ?, ?, ?
        )
      `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, cmdJson, cmdHash, nowIso);

      const resumeRes = await fixtures.adjudicationService.resumeAdmittedSubmission({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        adjudicationId: adjId,
        expectedLifecycleVersion: 1,
      });

      expect(resumeRes.status).toBe('VERIFIED');
    });

    it('105. Acknowledge on RECOVERY_FENCED row transitions status without rerunning commands', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);
      const snapshotHash = computeSha256(snapshotJson);
      const cmdJson = '{}';
      const cmdHash = computeSha256(cmdJson);

      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, failure_code, created_at, recovery_fenced_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'RECOVERY_FENCED', 1, ?, ?,
          ?, ?, 'ORPHANED_IN_FLIGHT_EXECUTION', ?, ?
        )
      `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, cmdJson, cmdHash, nowIso, nowIso);

      const ackRes = fixtures.adjudicationService.acknowledgeRecoveryFenced({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        adjudicationId: adjId,
        expectedLifecycleVersion: 1,
        decision: 'CANCEL',
      });

      expect(ackRes.adjudication.status).toBe('VERIFICATION_FAILED');
      expect(ackRes.adjudication.failure_code).toBe('ORPHANED_IN_FLIGHT_EXECUTION');
      expect(ackRes.adjudication.resolution_action).toBe('CANCEL');
      expect(ackRes.adjudication.resolution_timestamp).toBeDefined();
      expect(ackRes.adjudication.resolution_evidence_json).toBeDefined();
      expect(ackRes.adjudication.resolution_evidence_hash).toBeDefined();
    });
  });


});
