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



  describe('Group 4: Category D — Admission Authority', () => {
    it('57. Complete live graph is admitted successfully (status VERIFIED, lifecycle_version 3)', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const res = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      expect(res.adjudication.action).toBe('ADMIT_VERIFICATION');
      expect(res.adjudication.status).toBe('VERIFIED');
      expect(res.adjudication.lifecycle_version).toBe(3);
      expect(res.adjudication.verification_commands_json).toBeDefined();
      expect(res.adjudication.verification_commands_hash).toHaveLength(64);
    });

    it('58. Inactive project (status != RUNNING) is fenced from admission', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare("UPDATE projects SET status = 'COMPLETED' WHERE id = ?").run(fixtures.projectId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/project.*RUNNING/i);
    });

    it('59. Non-CODING task (state != CODING) is fenced from admission', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare("UPDATE tasks SET state = 'REVIEW_READY' WHERE id = ?").run(fixtures.taskId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/task.*CODING/i);
    });

    it('60. Task ownership epoch mismatch is fenced from admission', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Increment task ownership epoch to 2
      db.prepare('UPDATE tasks SET ownership_epoch = 2 WHERE id = ?').run(fixtures.taskId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/epoch mismatch/i);
    });

    it('61. Inactive task attempt (status != RUNNING) is fenced from admission', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare("UPDATE task_attempts SET status = 'COMPLETED' WHERE id = ?").run(fixtures.attemptId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/attempt.*RUNNING/i);
    });

    it('62. Inactive agent assignment (status != ASSIGNED) is fenced from admission', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare("UPDATE agent_assignments SET status = 'COMPLETED' WHERE id = ?").run(fixtures.assignmentId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/assignment.*ASSIGNED/i);
    });

    it('63. Ineligible authorization status (status != DISPATCHED) is fenced from admission', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare("UPDATE execution_authorizations SET status = 'INVALIDATED' WHERE id = ?").run(fixtures.authorizationId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/authorization.*DISPATCHED/i);
    });

    it('64. Provider / account / resource mismatch between authorization and assignment is fenced', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const prov2 = 'prov-second-' + crypto.randomUUID();
      db.prepare("INSERT INTO providers (id, name, adapter_type, enabled, created_at) VALUES (?, 'Second Prov', 'LOCAL_CLI', 1, ?)").run(prov2, nowIso);
      db.prepare("UPDATE agent_assignments SET selected_provider_id = ? WHERE id = ?").run(prov2, fixtures.assignmentId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/provider mismatch/i);
    });

    it('65. Terminal disposition on submission is fenced from admission', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      fixtures.adjudicationService.rejectSubmission({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        reason: 'Operator rejected',
      });

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/already terminal|already settled or rejected/i);
    });

    it('66. Existing active adjudication (ADMITTED, VERIFYING, RECOVERY_FENCED) is fenced by partial unique index', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);
      const snapshotHash = computeSha256(snapshotJson);

      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'ADMITTED', 1, ?, ?,
          '{}', '${'1'.repeat(64)}', ?
        )
      `).run(crypto.randomUUID(), crypto.randomUUID(), subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, nowIso);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/already has an active adjudication|VERIFICATION_IN_FLIGHT/i);
    });

    it('67. Live git HEAD drift before task mutation is fenced from admission', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Tamper authorized repository head sha
      db.prepare(`UPDATE execution_authorizations SET repository_head_sha = '${'f'.repeat(40)}' WHERE id = ?`).run(fixtures.authorizationId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/HEAD drift/i);
    });

    it('68. Missing frozen command snapshot in authorization payload is fenced from admission', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const payload = JSON.parse(auth.canonical_payload_json!);
      delete payload.verificationCommands;
      const newJson = JSON.stringify(payload);
      const newHash = crypto.createHash('sha256').update(newJson, 'utf8').digest('hex');

      db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
        .run(newJson, newHash, fixtures.authorizationId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/frozen verification commands|COMMAND_SNAPSHOT_INVALID|canonical_payload_json has invalid property set/i);
    });

    it('69. Malformed frozen command snapshot hash mismatch is fenced from admission', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Mutate canonical_payload_json without updating hash
      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const payload = JSON.parse(auth.canonical_payload_json!);
      payload.verificationCommands.TEST.executable = 'tampered';
      db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ? WHERE id = ?')
        .run(JSON.stringify(payload), fixtures.authorizationId);

      // Mutate instruction_payload_hash to mismatch
      db.prepare("UPDATE execution_authorizations SET instruction_payload_hash = ? WHERE id = ?").run('1'.repeat(64), fixtures.authorizationId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/integrity|payload hash mismatch|INSTRUCTION_PAYLOAD_HASH_MISMATCH/i);
    });

    it('70. Coder-supplied verification commands in submission are strictly ignored in favor of frozen snapshot', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      // Untrusted coder submits dangerous command
      const maliciousPayload = createValidSubmissionPayload(fixtures, subId, {
        tests_claimed: ['rm -rf /'],
        summary: 'Injected dangerous command',
      });
      fixtures.mcpService.submitCoderClaim(maliciousPayload, plaintextToken);

      const res = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const cmds = JSON.parse(res.adjudication.verification_commands_json!);
      expect(cmds.TEST.executable).toBe(fs.realpathSync.native(process.execPath));
      expect(cmds.TEST.args).toEqual(['-v']);
      expect(JSON.stringify(cmds)).not.toContain('rm -rf');
    });

    it('71. Admission transaction is atomic: failure to record generic event rolls back entire adjudication', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.exec('DROP TABLE coder_submission_adjudication_events;');

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow();

      const active = fixtures.repo.getActiveCoderSubmissionAdjudication(subId);
      expect(active).toBeNull();
    });

    it('72. Task state transitions to REVIEW_READY on successful admission and verification', async () => {
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

    it('73. Admission records canonical workspace snapshot before execution', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const res = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      expect(res.adjudication.workspace_snapshot_before_json).toBeDefined();
      expect(res.adjudication.workspace_snapshot_before_hash).toHaveLength(64);
    });
  });


});
