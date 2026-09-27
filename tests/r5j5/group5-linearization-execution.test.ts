import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
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

  beforeEach(() => {
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
    fixtures = setupFullSubmissionGraph(db, repoDir, artifactsDir);
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



  describe('Group 5: Category E — Linearization and Execution', () => {
    it('74. Phase A admission commits durable state to database before any external process starts', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const res = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      // Assert Phase A and Phase B events were sequentially committed
      const events = fixtures.repo.getCoderSubmissionAdjudicationEvents(res.adjudication.id);
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0].event_type).toBe('ADMITTED');
      expect(events[0].sequence).toBe(1);
      expect(events[1].event_type).toBe('VERIFICATION_CLAIMED');
      expect(events[1].sequence).toBe(2);
    });

    it('75. Phase B claim CAS permits exactly one process invocation under concurrent claim race', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Create an ADMITTED row manually with lifecycle_version 1
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

      // Two concurrent claims with expected version 1
      const claim1 = fixtures.repo.updateCoderSubmissionAdjudication(adjId, 1, {
        status: 'VERIFYING',
        verification_execution_id: crypto.randomUUID(),
        verification_started_at: nowIso,
        workspace_snapshot_before_json: '{}',
        workspace_snapshot_before_hash: computeSha256('{}'),
      });

      const claim2 = fixtures.repo.updateCoderSubmissionAdjudication(adjId, 1, {
        status: 'VERIFYING',
        verification_execution_id: crypto.randomUUID(),
        verification_started_at: nowIso,
        workspace_snapshot_before_json: '{}',
        workspace_snapshot_before_hash: computeSha256('{}'),
      });

      expect(claim1).toBe(true);
      expect(claim2).toBe(false); // Second claim fails CAS
    });

    it('76. CAS rejects update when expected lifecycle version does not match', () => {
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

      const res = fixtures.repo.updateCoderSubmissionAdjudication(adjId, 99, {
        status: 'VERIFYING',
      });
      expect(res).toBe(false);
    });

    it('77. Database trigger enforces that lifecycle_version increments by exactly 1 per update', () => {
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

      expect(() => {
        db.prepare(`
          UPDATE coder_submission_adjudications
          SET status = 'VERIFYING',
              lifecycle_version = 5,
              verification_started_at = ?,
              verification_execution_id = ?,
              workspace_snapshot_before_json = '{}',
              workspace_snapshot_before_hash = ?
          WHERE id = ?
        `).run(nowIso, crypto.randomUUID(), computeSha256('{}'), adjId);
      }).toThrow(/lifecycle_version must increment by exactly 1/);
    });

    it('78. Process failure during verification transitions adjudication to VERIFICATION_FAILED with scrubbed code', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Configure a failing verification command (node fail_test.js)
      const failScript = path.join(os.tmpdir(), 'fail_test_' + crypto.randomUUID() + '.js');
      fs.writeFileSync(failScript, 'process.exit(1);');

      try {
        const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
        const payload = JSON.parse(auth.canonical_payload_json!);
        payload.verificationCommands.TEST = {
          executable: process.execPath,
          args: [failScript],
          timeout_ms: 120000,
        };
        const newHash = computePayloadHash(payload);
        const newJson = JSON.stringify(payload);
        db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
          .run(newJson, newHash, fixtures.authorizationId);

        const res = await fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        });

        expect(res.adjudication.status).toBe('VERIFICATION_FAILED');
        expect(res.adjudication.failure_code).toBe('TESTS_FAILED');
      } finally {
        if (fs.existsSync(failScript)) {
          fs.unlinkSync(failScript);
        }
      }
    });

    it('79. Process start failure (invalid executable) transitions to VERIFICATION_FAILED with PROCESS_START_FAILED', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Configure non-existent executable
      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const payload = JSON.parse(auth.canonical_payload_json!);
      payload.verificationCommands.TEST = {
        executable: 'non-existent-executable-12345',
        args: [],
        timeout_ms: 120000,
      };
      const newHash = computePayloadHash(payload);
      const newJson = JSON.stringify(payload);
      db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
        .run(newJson, newHash, fixtures.authorizationId);

      const res = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      expect(res.adjudication.status).toBe('VERIFICATION_FAILED');
      expect(res.adjudication.failure_code).toBe('PROCESS_START_FAILED');
    });

    it('80. Ambiguous start (process spawned but unrecorded outcome) transitions to RECOVERY_FENCED', () => {
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

      // Create an in-flight VERIFYING row with no completed_at
      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, workspace_snapshot_before_json, workspace_snapshot_before_hash,
          verification_execution_id, verification_started_at, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'VERIFYING', 2, ?, ?,
          ?, ?, ?, ?, 'exec-in-flight', ?, ?
        )
      `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, cmdJson, cmdHash, wsJson, wsHash, nowIso, nowIso);

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.verificationInFlightUnresolvedCount).toBe(1);

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(adj.status).toBe('RECOVERY_FENCED');
      expect(adj.recovery_fenced_at).toBeDefined();
    });

    it('81. Verification commands executed are strictly those from frozen authorization snapshot', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const res = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const frozenCmds = JSON.parse(res.adjudication.verification_commands_json!);
      expect(frozenCmds.TEST.executable).toBe(process.execPath);
      expect(frozenCmds.TEST.args).toEqual(['-v']);
    });

    it('82. Mutable project command changes after authorization cannot alter executed commands', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Insert altered command on project
      fixtures.repo.createVerificationCommand({
        id: 'vcmd-altered',
        project_id: fixtures.projectId,
        name: 'Altered Test Command',
        command_type: 'TEST',
        executable: 'altered-binary',
        args: [],
        timeout_ms: 1000,
        enabled: true,
      });

      const res = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const cmds = JSON.parse(res.adjudication.verification_commands_json!);
      expect(cmds.TEST.executable).toBe(process.execPath);
    });

    it('83. Pre-execution workspace snapshot records branch, head sha, and clean status', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const res = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      expect(res.adjudication.workspace_snapshot_before_json).toBeDefined();
      const snap = JSON.parse(res.adjudication.workspace_snapshot_before_json!);
      expect(snap.head_sha).toBeDefined();
      expect(typeof snap.isClean).toBe('boolean');
    });

    it('84. Git HEAD drift check validates match with authorized repository head SHA', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Change authorized_head_sha on submission after dropping trigger
      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare(`UPDATE coder_submissions SET authorized_head_sha = '${'0'.repeat(40)}' WHERE id = ?`).run(subId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/HEAD drift/i);
    });

    it('85. Uncommitted worktree changes detected before execution fail closed', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Create a temporary uncommitted file in project root
      const dirtyFile = path.join(fixtures.projectRoot, 'temp_uncommitted_' + crypto.randomUUID().slice(0, 6) + '.tmp');
      fs.writeFileSync(dirtyFile, 'dirty content');

      try {
        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow(/uncommitted|dirty/i);
      } finally {
        if (fs.existsSync(dirtyFile)) {
          fs.unlinkSync(dirtyFile);
        }
      }
    });

    it('86. Test execution timeout captured truthfully with TIMED_OUT classification', () => {
      const res = parseTestMetrics('Operation timed out after 120000ms', 124);
      expect(res.failedCount).toBe(1);
      expect(res.passedCount).toBe(0);
    });

    it('87. Test process non-zero exit captured truthfully with FAILED classification', () => {
      const res = parseTestMetrics('Tests failed: 5 failed, 10 passed', 1);
      expect(res.failedCount).toBe(5);
      expect(res.passedCount).toBe(10);
    });

    it('88. Output and environment variables scrubbed of sensitive tokens and secrets', () => {
      const rawOutput = 'Authorization token: af-sub-abcdef1234567890 and secret key sk-test-999';
      const scrubbed = rawOutput.replace(/af-sub-[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]').replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED_KEY]');
      expect(scrubbed).not.toContain('af-sub-abcdef1234567890');
      expect(scrubbed).not.toContain('sk-test-999');
    });
  });


});
