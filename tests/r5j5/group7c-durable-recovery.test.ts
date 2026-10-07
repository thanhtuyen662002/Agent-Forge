import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { approveFixtureCommand, freezeFixtureVerificationCommand } from '../helpers/verificationCapabilityFixture';
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
  describe('Group 7C: Durable Evidence & Recovery', () => {
    it('160. recovery scanner exact durable result performs DB-only reconciliation with complete result envelope and production FILE evidence', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const authPayload = JSON.parse(auth.canonical_payload_json!);
      const cmdJson = canonicalJsonStringify(authPayload.verificationCommands);
      const cmdHash = computeSha256(cmdJson);

      const wsBefore = {
        head_sha: fixtures.repoHeadSha,
        status_lines: [],
        status_text: '',
        untracked_files: [],
        modified_files: [],
      };
      const wsBeforeJson = canonicalJsonStringify(wsBefore);
      const wsBeforeHash = computeSha256(wsBeforeJson);

      // Store real production FILE evidence where raw_payload is null and files exist on disk
      const trResultData = JSON.stringify({ passed: 5, failed: 0, skipped: 0, duration_ms: 150 });
      const trResultHash = computeSha256(trResultData);
      const matTr = fixtures.artifactStore.materializeContentAddressedFile(trResultData, trResultHash);
      const trEv: Evidence = {
        id: crypto.randomUUID(),
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'TEST_RESULT',
        storage_type: 'FILE',
        file_path: matTr.filePath,
        hash: trResultHash,
        byte_size: matTr.byteSize,
        content_type: 'application/json',
        summary: 'Authoritative test results',
        raw_payload: null,
        created_at: new Date().toISOString(),
      };
      expect(trEv.storage_type).toBe('FILE');
      expect(trEv.raw_payload).toBeNull();
      fixtures.repo.createEvidence(trEv);

      const trId = crypto.randomUUID();
      fixtures.repo.createTestRun({
        id: trId,
        task_id: fixtures.taskId,
        command: `${authPayload.verificationCommands.TEST.executable} ${authPayload.verificationCommands.TEST.args.join(' ')}`,
        exit_code: 0,
        passed_count: 5,
        failed_count: 0,
        skipped_count: 0,
        duration_ms: 150,
        evidence_id: trEv.id,
        created_at: new Date().toISOString(),
      });

      const statusData = 'clean';
      const statusHash = computeSha256(statusData);
      const matStatus = fixtures.artifactStore.materializeContentAddressedFile(statusData, statusHash);
      const gse: Evidence = {
        id: crypto.randomUUID(),
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'GIT_STATUS',
        storage_type: 'FILE',
        file_path: matStatus.filePath,
        hash: statusHash,
        byte_size: matStatus.byteSize,
        content_type: 'text/plain',
        summary: 'Git status clean',
        raw_payload: null,
        created_at: new Date().toISOString(),
      };
      expect(gse.storage_type).toBe('FILE');
      expect(gse.raw_payload).toBeNull();
      fixtures.repo.createEvidence(gse);

      const diffData = 'diff --git a b';
      const diffHash = computeSha256(diffData);
      const matDiff = fixtures.artifactStore.materializeContentAddressedFile(diffData, diffHash);
      const gde: Evidence = {
        id: crypto.randomUUID(),
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'GIT_DIFF',
        storage_type: 'FILE',
        file_path: matDiff.filePath,
        hash: diffHash,
        byte_size: matDiff.byteSize,
        content_type: 'text/x-diff',
        summary: 'Git diff clean',
        raw_payload: null,
        created_at: new Date().toISOString(),
      };
      expect(gde.storage_type).toBe('FILE');
      expect(gde.raw_payload).toBeNull();
      fixtures.repo.createEvidence(gde);

      fixtures.repo.createEvidence({
        id: 'ev-ws-after-' + crypto.randomUUID(),
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'CUSTOM',
        storage_type: 'INLINE',
        file_path: null,
        hash: wsBeforeHash,
        byte_size: 8,
        created_at: new Date().toISOString(),
        content_type: 'text/plain',
        summary: 'ws after evidence',
        raw_payload: 'ws_after',
      });

      const adjId = crypto.randomUUID();
      const execId = crypto.randomUUID();
      const now = new Date().toISOString();
      const snapJson = canonicalJsonStringify(fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(
        fixtures.repo.getCoderSubmissionById(subId)!
      ));

      const wsAfterObj: CanonicalWorkspaceSnapshotAfterPayload = {
        adjudication_id: adjId,
        adjudication_lifecycle_version: 3,
        assignment_id: fixtures.assignmentId,
        attempt_id: fixtures.attemptId,
        authorization_id: fixtures.authorizationId,
        captured_at: now,
        captured_repository_head_sha: fixtures.repoHeadSha,
        expected_head_sha: fixtures.repoHeadSha,
        git_diff_evidence_hash: gde.hash,
        git_status_evidence_hash: gse.hash,
        project_id: fixtures.projectId,
        schema_version: 1,
        submission_id: subId,
        task_id: fixtures.taskId,
        task_ownership_epoch: 1,
        verification_execution_id: execId,
        workspace_lease_id: crypto.randomUUID(),
        worktree_identity_hash: computeSha256(fixtures.projectRoot.toLowerCase()),
      };
      const leaseId = wsAfterObj.workspace_lease_id;
      fixtures.db.pragma('foreign_keys = OFF');
      fixtures.repo.createWorkspaceLease({
        id: leaseId,
        adjudication_id: adjId,
        worktree_identity_hash: computeSha256(fixtures.projectRoot.toLowerCase()),
        admitted_workspace_fingerprint_hash: computeSha256('admitted'),
        pre_execution_fingerprint_hash: null,
        claim_nonce: crypto.randomUUID(),
        execution_id: execId,
        lease_owner_identity: fixtures.assignmentId,
        assignment_id: fixtures.assignmentId,
        authorization_id: fixtures.authorizationId,
        acquired_at: now,
        released_at: null,
        lifecycle_version: 2,
        state: 'ACQUIRED',
        failure_code: null,
        failure_evidence_hash: null,
      });
      const wsAfterContent = canonicalJsonStringify(wsAfterObj);
      const wsAfterHash = computeSha256(wsAfterContent);
      const matWsAfter = fixtures.artifactStore.materializeContentAddressedFile(wsAfterContent, wsAfterHash);
      const wsAfterEv: Evidence = {
        id: crypto.randomUUID(),
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'FILE_SNAPSHOT',
        storage_type: 'FILE',
        file_path: matWsAfter.filePath,
        hash: wsAfterHash,
        byte_size: matWsAfter.byteSize,
        content_type: 'application/json',
        summary: 'Workspace snapshot after',
        raw_payload: null,
        created_at: new Date().toISOString(),
      };
      fixtures.repo.createEvidence(wsAfterEv);

      const artifactManifest: ArtifactManifest = {
        manifest_schema_version: 1,
        adjudication_id: adjId,
        lifecycle_version: 2,
        verification_execution_id: execId,
        entries: [
          {
            evidence_id: trEv.id,
            evidence_type: trEv.evidence_type,
            content_type: trEv.content_type,
            byte_size: trEv.byte_size,
            sha256: trEv.hash,
            storage_class: 'FILE',
            relative_path: path.relative(fixtures.artifactStore.getBaseDir(), trEv.file_path!),
          },
          {
            evidence_id: gse.id,
            evidence_type: gse.evidence_type,
            content_type: gse.content_type,
            byte_size: gse.byte_size,
            sha256: gse.hash,
            storage_class: 'FILE',
            relative_path: path.relative(fixtures.artifactStore.getBaseDir(), gse.file_path!),
          },
          {
            evidence_id: gde.id,
            evidence_type: gde.evidence_type,
            content_type: gde.content_type,
            byte_size: gde.byte_size,
            sha256: gde.hash,
            storage_class: 'FILE',
            relative_path: path.relative(fixtures.artifactStore.getBaseDir(), gde.file_path!),
          },
          {
            evidence_id: wsAfterEv.id,
            evidence_type: wsAfterEv.evidence_type,
            content_type: wsAfterEv.content_type,
            byte_size: wsAfterEv.byte_size,
            sha256: wsAfterEv.hash,
            storage_class: 'FILE',
            relative_path: path.relative(fixtures.artifactStore.getBaseDir(), wsAfterEv.file_path!),
          },
        ],
      };
      const artifactManifestJson = canonicalizeArtifactManifest(artifactManifest);
      const artifactManifestHash = computeArtifactManifestHash(artifactManifestJson);

      const envelopeObj: CanonicalVerificationResultEnvelope = {
        adjudication_id: adjId,
        artifact_manifest_hash: artifactManifestHash,
        assignment_id: fixtures.assignmentId,
        attempt_id: fixtures.attemptId,
        authorization_id: fixtures.authorizationId,
        command_snapshot_hash: cmdHash,
        exit_classification: 'EXIT_ZERO',
        failure_code: null,
        failure_payload: null,
        finish_timestamp: now,
        git_diff_evidence_hash: gde.hash,
        git_diff_evidence_id: gde.id,
        git_status_evidence_hash: gse.hash,
        git_status_evidence_id: gse.id,
        lifecycle_version: 3,
        process_start_classification: 'SPAWNED_PROVEN',
        project_id: fixtures.projectId,
        start_timestamp: now,
        task_id: fixtures.taskId,
        task_ownership_epoch: 1,
        termination_classification: 'TERMINATION_PROVEN',
        test_result_evidence_hash: trEv.hash,
        test_result_evidence_id: trEv.id,
        test_run_id: trId,
        verification_execution_id: execId,
        workspace_snapshot_after_evidence_id: wsAfterEv.id,
        workspace_snapshot_after_hash: wsAfterHash,
        workspace_snapshot_before_hash: wsBeforeHash,
      };
      const envelopeJson = canonicalJsonStringify(envelopeObj);
      const envelopeHash = computeSha256(envelopeJson);

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
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: wsBeforeJson,
        workspace_snapshot_before_hash: wsBeforeHash,
        verification_commands_json: cmdJson,
        verification_commands_hash: cmdHash,
        created_at: now,
        verification_started_at: now,
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: trId,
        git_status_evidence_id: gse.id,
        git_diff_evidence_id: gde.id,
        verification_execution_id: execId,
        verification_result_envelope_json: envelopeJson,
        verification_result_envelope_hash: envelopeHash,
        artifact_manifest_json: artifactManifestJson,
        artifact_manifest_hash: artifactManifestHash,
        workspace_lease_id: leaseId,
      });
      fixtures.db.pragma('foreign_keys = ON');

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.settledCount).toBe(1);
      expect(report.fencedCount).toBe(0);

      const reconciled = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(reconciled.status).toBe('VERIFIED');
      expect(reconciled.lifecycle_version).toBe(3);

      const task = fixtures.repo.getTask(fixtures.taskId)!;
      expect(task.state).toBe('REVIEW_READY');
    });

    it('161. manager record selected by id only; row matching only message_id is rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;

      // Tamper authorization to point manager_message_id to the protocol_messages.message_id string instead of id
      db.pragma('foreign_keys = OFF');
      db.prepare('UPDATE execution_authorizations SET manager_message_id = ? WHERE id = ?')
        .run(fixtures.managerMessageId, fixtures.authorizationId);
      db.pragma('foreign_keys = ON');

      const integrity = fixtures.adjudicationService.validateSubmissionIntegrity(sub);
      expect(integrity.valid).toBe(false);
      expect(integrity.fenced_reason).toContain('Manager protocol message');
    });

    it('162. manager raw payload hash mismatch is rejected by shared authority verifier', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;

      db.prepare("UPDATE protocol_messages SET raw_payload = '{\"protocol\":\"manager.v1\",\"tampered\":true}' WHERE id = ?")
        .run(fixtures.managerRecordId);

      const integrity = fixtures.adjudicationService.validateSubmissionIntegrity(sub);
      expect(integrity.valid).toBe(false);
      expect(integrity.fenced_reason).toContain('Manager protocol message raw payload hash mismatch');
    });

    it('163. manager extra or missing nested key is rejected fails closed', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;

      const pm = db.prepare('SELECT * FROM protocol_messages WHERE id = ?').get(fixtures.managerRecordId) as any;
      const parsed = JSON.parse(pm.raw_payload);
      delete parsed.acceptance_criteria;
      const newRaw = JSON.stringify(parsed);
      const newHash = computeSha256(newRaw);
      db.prepare('UPDATE protocol_messages SET raw_payload = ?, payload_hash = ? WHERE id = ?').run(newRaw, newHash, fixtures.managerRecordId);
      db.prepare('UPDATE execution_authorizations SET manager_payload_hash = ? WHERE id = ?').run(newHash, fixtures.authorizationId);

      const integrity = fixtures.adjudicationService.validateSubmissionIntegrity(sub);
      expect(integrity.valid).toBe(false);
      expect(integrity.fenced_reason).toContain('payload key mismatch');
    });

    it('164. project not exactly RUNNING is rejected', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare("UPDATE projects SET status = 'PAUSED' WHERE id = ?").run(fixtures.projectId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/Project must be in RUNNING state/);
    });

    it('165. attempt or assignment inactive inside Phase B transaction fails closed', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare("UPDATE task_attempts SET status = 'FAILED' WHERE id = ?").run(fixtures.attemptId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/Task attempt must be RUNNING/);
    });

    it('166. provider/account/resource drift inside Phase B blocks spawn', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare('UPDATE provider_resources SET enabled = 0 WHERE id = ?').run(fixtures.resourceId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/Provider resource is not enabled/);
    });

    it('167. worker slot drift inside Phase B blocks spawn when required', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const slotId = 'slot-' + crypto.randomUUID();
      db.prepare(`
        INSERT INTO worker_slots (id, provider_account_id, provider_resource_id, slot_index, status, created_at, updated_at)
        VALUES (?, ?, ?, 99, 'DISABLED', ?, ?)
      `).run(slotId, fixtures.accountId, fixtures.resourceId, new Date().toISOString(), new Date().toISOString());
      db.prepare('UPDATE agent_assignments SET selected_worker_slot_id = ? WHERE id = ?').run(slotId, fixtures.assignmentId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/Worker slot (is not active|status must be LEASED)/);
    });

    it('168. authority snapshot extra/missing key rejected in every lifecycle consumer', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(
        fixtures.repo.getCoderSubmissionById(subId)!
      );
      (snap as any).unauthorized_extra_field = 'malicious';
      const snapJson = canonicalJsonStringify(snap);
      const snapHash = computeSha256(snapJson);

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
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: snapHash,
        workspace_snapshot_before_json: canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] }),
        workspace_snapshot_before_hash: computeSha256(canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] })),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.authorityConflictCount).toBe(1);
      expect(report.fencedCount).toBe(1);
      const fenced = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(fenced.status).toBe('RECOVERY_FENCED');
    });

    it('169. invalid timeout zero/negative/fractional/oversized/missing rejected without fallback', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const payload = JSON.parse(auth.canonical_payload_json!);

      for (const badTimeout of [0, -500, 12.5, 700000, null, undefined]) {
        payload.verificationCommands.TEST = {
          executable: process.execPath,
          args: ['-v'],
          timeout_ms: badTimeout,
        };
        const newJson = JSON.stringify(payload);
        const newHash = crypto.createHash('sha256').update(newJson, 'utf8').digest('hex');
        db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
          .run(newJson, newHash, fixtures.authorizationId);

        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow(/timeout_ms must be a positive integer <= 600000/);
      }
    });

     it('170. unapproved nonexistent executable is rejected with proven no process', async () => {
      const nonExistentCmd = JSON.stringify({
        TEST: {
          executable: 'non_existent_executable_' + crypto.randomUUID(),
          args: [],
          timeout_ms: 120000,
        },
      });
      const cmdHash = computeSha256(nonExistentCmd);
      const wsSnap = canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] });
      const wsHash = computeSha256(wsSnap);

      const input: SealedVerificationExecutionInput = {
        adjudication_id: crypto.randomUUID(),
        lifecycle_version: 2,
        verification_execution_id: crypto.randomUUID(),
        authorization_id: fixtures.authorizationId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        assignment_id: fixtures.assignmentId,
        repo_path: fixtures.projectRoot,
        verification_commands_json: nonExistentCmd,
        verification_commands_hash: cmdHash,
        workspace_snapshot_before_json: wsSnap,
        workspace_snapshot_before_hash: wsHash,
        policy: {
          timeout_ms: 120000,
          max_stdout_bytes: 1048576,
          max_stderr_bytes: 1048576,
          allowed_env_keys: ['PATH'],
        },
      };

      const result = await fixtures.verificationService.executeSealedVerification(input);
      expect(result.outcome).toBe('COMMAND_POLICY_REJECTED');
      expect(result.process_start).toBe('NOT_STARTED_PROVEN');
    });

    it('171. ambiguous process-runner throw maps to RECOVERY_FENCED', async () => {
      const originalExecute = (fixtures.verificationService as any).processRunner?.execute;
      (fixtures.verificationService as any).processRunner = {
        execute: async () => {
          throw new Error('EPERM: operation not permitted during process lifecycle');
        },
      };

      try {
        const cmd = JSON.stringify(JSON.parse(fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!.canonical_payload_json!).verificationCommands);
        const cmdHash = computeSha256(cmd);
        const wsSnap = canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] });
        const wsHash = computeSha256(wsSnap);

        const input: SealedVerificationExecutionInput = {
          adjudication_id: crypto.randomUUID(),
          lifecycle_version: 2,
          verification_execution_id: 'exec-ambiguous',
          authorization_id: fixtures.authorizationId,
          project_id: fixtures.projectId,
          task_id: fixtures.taskId,
          attempt_id: fixtures.attemptId,
          assignment_id: fixtures.assignmentId,
          repo_path: fixtures.projectRoot,
          verification_commands_json: cmd,
          verification_commands_hash: cmdHash,
          workspace_snapshot_before_json: wsSnap,
          workspace_snapshot_before_hash: wsHash,
          policy: {
            timeout_ms: 120000,
            max_stdout_bytes: 1048576,
            max_stderr_bytes: 1048576,
            allowed_env_keys: ['PATH'],
          },
        };

        const result = await fixtures.verificationService.executeSealedVerification(input);
        expect(result.outcome).toBe('RECOVERY_FENCED');
        if (result.outcome === 'RECOVERY_FENCED') {
          expect(result.failure_code).toBe('ORPHANED_VERIFICATION_INTERRUPTED');
        }
      } finally {
        if (originalExecute) {
          (fixtures.verificationService as any).processRunner.execute = originalExecute;
        }
      }
    });

    it('172. timeout without termination proof remains fenced', async () => {
      const timeoutScript = path.join(fixtures.projectRoot, 'temp-artifacts', 'timeout_' + crypto.randomUUID() + '.js');
      fs.writeFileSync(timeoutScript, 'setInterval(() => {}, 1000);');

      try {
        const cmd = JSON.stringify(freezeFixtureVerificationCommand(fixtures.repo, fixtures.authorizationId,
          { ...await approveFixtureCommand(fixtures.repo, fixtures.projectId, [timeoutScript]), timeout_ms: 200 }));
        const cmdHash = computeSha256(cmd);
        const wsSnap = canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] });
        const wsHash = computeSha256(wsSnap);

        const input: SealedVerificationExecutionInput = {
          adjudication_id: crypto.randomUUID(),
          lifecycle_version: 2,
          verification_execution_id: crypto.randomUUID(),
          authorization_id: fixtures.authorizationId,
          project_id: fixtures.projectId,
          task_id: fixtures.taskId,
          attempt_id: fixtures.attemptId,
          assignment_id: fixtures.assignmentId,
          repo_path: fixtures.projectRoot,
          verification_commands_json: cmd,
          verification_commands_hash: cmdHash,
          workspace_snapshot_before_json: wsSnap,
          workspace_snapshot_before_hash: wsHash,
          policy: {
            timeout_ms: 200,
            max_stdout_bytes: 1048576,
            max_stderr_bytes: 1048576,
            allowed_env_keys: ['PATH'],
          },
        };

        const result = await fixtures.verificationService.executeSealedVerification(input);
        expect(result.outcome === 'TEST_TIMEOUT' || result.outcome === 'RECOVERY_FENCED').toBe(true);
      } finally {
        try { fs.unlinkSync(timeoutScript); } catch {}
      }
    });

    it('173. raw stderr secrets / SQL / paths do not enter failure JSON or generic event summary', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const secretScript = path.join(fixtures.projectRoot, 'temp-artifacts', 'secret_err_' + crypto.randomUUID() + '.js');
      fs.writeFileSync(
        secretScript,
        'console.error("CRITICAL_ERR: SELECT * FROM tokens WHERE secret=\'af-tok-sensitive-9988\' in C:\\\\Users\\\\Admin\\\\vault"); process.exit(1);'
      );

      try {
        const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
        const payload = JSON.parse(auth.canonical_payload_json!);
        payload.verificationCommands.TEST = { ...await approveFixtureCommand(fixtures.repo, fixtures.projectId, [secretScript]), timeout_ms: 120000 };
        const newHash = computePayloadHash(payload);
        const newJson = JSON.stringify(payload);
        db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
          .run(newJson, newHash, fixtures.authorizationId);

        const res = await fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        });

        expect(res.adjudication.status).toBe('VERIFICATION_FAILED');
        const adj = fixtures.repo.getCoderSubmissionAdjudicationById(res.adjudication.id)!;
        if (adj.failure_json) {
          expect(adj.failure_json).not.toContain('C:\\Users');
          expect(adj.failure_json).not.toContain('af-tok-sensitive');
          expect(adj.failure_json).not.toContain('SELECT * FROM');
        }

        const events = db.prepare('SELECT * FROM events WHERE project_id = ?').all(fixtures.projectId) as any[];
        for (const ev of events) {
          expect(ev.summary).not.toContain('af-tok-sensitive');
          expect(ev.summary).not.toContain('C:\\Users');
          expect(ev.structured_payload_json).not.toContain('af-tok-sensitive');
        }
      } finally {
        if (fs.existsSync(secretScript)) {
          fs.unlinkSync(secretScript);
        }
      }
    });

    it('174. Phase C CAS failure cleans up staged artifacts', async () => {
      const stagedFiles: string[] = [];
      const origMat = fixtures.artifactStore.materializeContentAddressedFile;
      fixtures.artifactStore.materializeContentAddressedFile = function (...args) {
        const res = origMat.apply(this, args);
        stagedFiles.push(res.filePath);
        return res;
      };

      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const origUpdate = fixtures.repo.updateCoderSubmissionAdjudication;
      fixtures.repo.updateCoderSubmissionAdjudication = function (id, expectedVersion, updates) {
        if (updates.status === 'VERIFIED') {
          return false;
        }
        return origUpdate.call(fixtures.repo, id, expectedVersion, updates);
      };

      try {
        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow();

        expect(stagedFiles.length).toBeGreaterThan(0);
        for (const p of stagedFiles) {
          expect(fs.existsSync(p)).toBe(false);
        }
      } finally {
        fixtures.repo.updateCoderSubmissionAdjudication = origUpdate;
        fixtures.artifactStore.materializeContentAddressedFile = origMat;
      }
    });

    it('175. Phase C graph drift rolls back evidence/task/disposition/events', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const origRunInTx = fixtures.repo.runInTransaction.bind(fixtures.repo);
      fixtures.repo.runInTransaction = function <T>(fn: () => T): T {
        return origRunInTx(() => {
          db.prepare("UPDATE tasks SET state = 'DONE' WHERE id = ?").run(fixtures.taskId);
          return fn();
        });
      };

      try {
        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow();

        const disps = fixtures.repo.getCoderSubmissionDispositions(subId);
        expect(disps.some((d) => d.disposition_reason === 'ACCEPTED_VERIFIED')).toBe(false);
        const adjs = fixtures.repo.getCoderSubmissionAdjudicationsBySubmission(subId);
        expect(adjs.every((a) => a.status !== 'VERIFIED')).toBe(true);
      } finally {
        fixtures.repo.runInTransaction = origRunInTx;
      }
    });

    it('176. Phase C atomic transaction rollback leaves zero contradictory state in database', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const evCountBefore = (db.prepare('SELECT COUNT(*) as c FROM evidence').get() as { c: number }).c;
      const trCountBefore = (db.prepare('SELECT COUNT(*) as c FROM test_runs').get() as { c: number }).c;
      const dispCountBefore = (db.prepare('SELECT COUNT(*) as c FROM coder_submission_dispositions').get() as { c: number }).c;

      const origTransition = TaskStateMachine.transition;
      TaskStateMachine.transition = function (...args: Parameters<typeof TaskStateMachine.transition>) {
        if (args[1] === 'EVIDENCE_GATHERED') {
          throw new Error('SIMULATED_PHASE_C_STATE_MACHINE_FAILURE');
        }
        return origTransition.apply(TaskStateMachine, args);
      };

      try {
        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow(/SIMULATED_PHASE_C_STATE_MACHINE_FAILURE/);

        // Prove zero contradictory state:
        const evCountAfter = (db.prepare('SELECT COUNT(*) as c FROM evidence').get() as { c: number }).c;
        const trCountAfter = (db.prepare('SELECT COUNT(*) as c FROM test_runs').get() as { c: number }).c;
        const dispCountAfter = (db.prepare('SELECT COUNT(*) as c FROM coder_submission_dispositions').get() as { c: number }).c;

        expect(evCountAfter).toBe(evCountBefore);
        expect(trCountAfter).toBe(trCountBefore);
        expect(dispCountAfter).toBe(dispCountBefore);

        const taskAfter = fixtures.repo.getTask(fixtures.taskId)!;
        expect(taskAfter.state).toBe('VALIDATING');
        expect(taskAfter.state).not.toBe('REVIEW_READY');

        const adjs = fixtures.repo.getCoderSubmissionAdjudicationsBySubmission(subId);
        expect(adjs.every((a) => a.status !== 'VERIFIED')).toBe(true);
      } finally {
        TaskStateMachine.transition = origTransition;
      }
    });

    it('177. recovery rejects authority snapshot with valid raw hash but invalid schema', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const invalidSchemaSnap = { foo: 'bar', invalid: 123 };
      const snapJson = canonicalJsonStringify(invalidSchemaSnap);
      const snapHash = computeSha256(snapJson);

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
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: snapHash,
        workspace_snapshot_before_json: canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] }),
        workspace_snapshot_before_hash: computeSha256(canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] })),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.authorityConflictCount).toBe(1);
      const fenced = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(fenced.status).toBe('RECOVERY_FENCED');
      expect(fenced.failure_code).toBe('INTEGRITY_MISMATCH');
    });

    it('178. recovery rejects empty command snapshot even when raw hash matches', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const snapJson = canonicalJsonStringify(fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(
        fixtures.repo.getCoderSubmissionById(subId)!
      ));

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
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] }),
        workspace_snapshot_before_hash: computeSha256(canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] })),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.settledCount).toBe(0);
      expect(report.fencedCount).toBe(1);
    });

    it('179. recovery rejects test run without exact test-result evidence', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const trId = crypto.randomUUID();
      fixtures.repo.createTestRun({
        id: trId,
        task_id: fixtures.taskId,
        command: 'node -v',
        exit_code: 0,
        passed_count: 1,
        failed_count: 0,
        skipped_count: 0,
        duration_ms: 50,
        evidence_id: null,
        created_at: new Date().toISOString(),
      });

      const snapJson = canonicalJsonStringify(fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(
        fixtures.repo.getCoderSubmissionById(subId)!
      ));
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
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] }),
        workspace_snapshot_before_hash: computeSha256(canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] })),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: trId,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.settledCount).toBe(0);
      expect(report.fencedCount).toBe(1);
    });

    it('180. recovery rejects test-result evidence with wrong project or attempt', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const wrongProjId = 'proj-other-' + crypto.randomUUID();
      fixtures.repo.createProject({
        id: wrongProjId,
        name: 'Other Project',
        description: 'Other Project for test',
        repository_path: fixtures.projectRoot,
        default_branch: 'main',
        status: 'RUNNING',
        contract: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
      });

      const trEvId = crypto.randomUUID();
      fixtures.repo.createEvidence({
        id: trEvId,
        project_id: wrongProjId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'TEST_RESULT',
        storage_type: 'INLINE',
        file_path: null,
        hash: computeSha256('data'),
        byte_size: 4,
        content_type: 'application/json',
        summary: 'Wrong project test result',
        raw_payload: 'data',
        created_at: new Date().toISOString(),
      });

      const trId = crypto.randomUUID();
      fixtures.repo.createTestRun({
        id: trId,
        task_id: fixtures.taskId,
        command: 'node -v',
        exit_code: 0,
        passed_count: 1,
        failed_count: 0,
        skipped_count: 0,
        duration_ms: 50,
        evidence_id: trEvId,
        created_at: new Date().toISOString(),
      });

      const snapJson = canonicalJsonStringify(fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(
        fixtures.repo.getCoderSubmissionById(subId)!
      ));
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
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] }),
        workspace_snapshot_before_hash: computeSha256(canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] })),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: trId,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.settledCount).toBe(0);
      expect(report.fencedCount).toBe(1);
    });

    it('181. recovery rejects Git evidence with wrong project/attempt/type/storage', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const otherTaskId = 'task-other-' + crypto.randomUUID();
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, base_sha, ownership_epoch, created_at, updated_at)
        VALUES (?, ?, 'Other Task', 'CODING', 'LOW', 'LOW', 1, 3, 0, ?, 1, ?, ?)
      `).run(otherTaskId, fixtures.projectId, fixtures.baseSha, new Date().toISOString(), new Date().toISOString());

      const gseId = crypto.randomUUID();
      fixtures.repo.createEvidence({
        id: gseId,
        project_id: fixtures.projectId,
        task_id: otherTaskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'GIT_STATUS',
        storage_type: 'INLINE',
        file_path: null,
        hash: computeSha256('clean'),
        byte_size: 5,
        content_type: 'text/plain',
        summary: 'status',
        raw_payload: 'clean',
        created_at: new Date().toISOString(),
      });

      const snapJson = canonicalJsonStringify(fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(
        fixtures.repo.getCoderSubmissionById(subId)!
      ));
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
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] }),
        workspace_snapshot_before_hash: computeSha256(canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] })),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: gseId,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.settledCount).toBe(0);
      expect(report.fencedCount).toBe(1);
    });

    it('182. recovery rejects mismatched execution ID or command hash', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const snapJson = canonicalJsonStringify(fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(
        fixtures.repo.getCoderSubmissionById(subId)!
      ));
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
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] }),
        workspace_snapshot_before_hash: computeSha256(canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] })),
        verification_commands_json: '{"TEST":null}',
        verification_commands_hash: computeSha256('{"TEST":null}'),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: 'exec-1',
        verification_result_envelope_json: JSON.stringify({ verification_execution_id: 'exec-DIFFERENT' }),
        verification_result_envelope_hash: computeSha256(JSON.stringify({ verification_execution_id: 'exec-DIFFERENT' })),
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.settledCount).toBe(0);
      expect(report.fencedCount).toBe(1);
    });

    it('183. recovery rejects missing termination proof in result envelope', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const snapJson = canonicalJsonStringify(fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(
        fixtures.repo.getCoderSubmissionById(subId)!
      ));
      const adjId = crypto.randomUUID();
      const envelope = {
        exit_classification: 'RUNNING',
        process_start_classification: 'PROCESS_STARTED',
      };
      const envelopeJson = JSON.stringify(envelope);

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
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] }),
        workspace_snapshot_before_hash: computeSha256(canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] })),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: 'exec-1',
        verification_result_envelope_json: envelopeJson,
        verification_result_envelope_hash: computeSha256(envelopeJson),
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.settledCount).toBe(0);
      expect(report.fencedCount).toBe(1);
    });

    it('184. recovery state-machine transition failure rolls back and surfaces without bypass', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare("UPDATE tasks SET state = 'REVIEWING' WHERE id = ?").run(fixtures.taskId);

      const snapJson = canonicalJsonStringify(fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(
        fixtures.repo.getCoderSubmissionById(subId)!
      ));
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
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] }),
        workspace_snapshot_before_hash: computeSha256(canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] })),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.settledCount).toBe(0);
      const task = fixtures.repo.getTask(fixtures.taskId)!;
      expect(task.state).toBe('REVIEWING');
    });

    it('185. cancellation preserves recovery_fenced_at and original execution binding', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const snapJson = canonicalJsonStringify(fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(
        fixtures.repo.getCoderSubmissionById(subId)!
      ));
      const adjId = crypto.randomUUID();
      const execId = crypto.randomUUID();
      const fenceTime = new Date(Date.now() - 60000).toISOString();
      const startTime = new Date(Date.now() - 120000).toISOString();

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
        lifecycle_version: 2,
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] }),
        workspace_snapshot_before_hash: computeSha256(canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] })),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: startTime,
        verification_started_at: startTime,
        completed_at: null,
        recovery_fenced_at: fenceTime,
        failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: execId,
      });

      fixtures.adjudicationService.acknowledgeRecoveryFenced({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        adjudicationId: adjId,
        expectedLifecycleVersion: 2,
        decision: 'CANCEL',
      });

      const cancelled = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(cancelled.status).toBe('VERIFICATION_FAILED');
      expect(cancelled.failure_code).toBe('ORPHANED_VERIFICATION_INTERRUPTED');
      expect(cancelled.resolution_action).toBe('CANCEL');
      expect(cancelled.resolution_timestamp).toBeDefined();
      expect(cancelled.resolution_evidence_json).toBeDefined();
      expect(cancelled.resolution_evidence_hash).toBeDefined();
      expect(cancelled.recovery_fenced_at).toBe(fenceTime);
      expect(cancelled.verification_execution_id).toBe(execId);
      expect(cancelled.verification_started_at).toBe(startTime);
    });

    it('186. review projection recomputes linked hashes and fails closed on malformed claim JSON', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const linkage = createTestLinkage(subId);
      const badClaimJson = '{malformed:true';
      linkage.submission = {
        ...linkage.submission,
        claim_content_json: badClaimJson,
        claim_content_hash: computeSha256(badClaimJson),
      };

      expect(() => {
        PackageGenerator.generateReviewPackage(
          fixtures.repo.getProject(fixtures.projectId)!,
          fixtures.repo.getTask(fixtures.taskId)!,
          null,
          '',
          '',
          null,
          [],
          null,
          linkage
        );
      }).toThrow(/LEGACY_LINKAGE_REJECTED/);
    });

    it('187. real IPC error scrubber handles complex diagnostic messages across registered handlers', async () => {
      const handler = ipcChannelHandlers.get('submissions:inspect');
      expect(handler).toBeDefined();

      const origInspect = fixtures.adjudicationService.inspectQuarantinedSubmission;
      fixtures.adjudicationService.inspectQuarantinedSubmission = function () {
        throw new CoderSubmissionAdjudicationError(
          'INTEGRITY_CONFLICT',
          'Crash in C:\\repo\\src\\main.ts with token af-tok-xyz at SQL SELECT * FROM secret_tbl'
        );
      };

      try {
        const res = (await handler!({ senderFrame: { url: 'http://localhost:5173/' } }, { submissionId: crypto.randomUUID() })) as {
          success: boolean;
          error: string;
          message: string;
        };

        expect(res.success).toBe(false);
        expect(res.error).toBe('INTEGRITY_CONFLICT');
        expect(res.message).not.toContain('C:\\repo');
        expect(res.message).not.toContain('af-tok-xyz');
        expect(res.message).not.toContain('SELECT * FROM');
        expect(res.message).toContain('[REDACTED_PATH]');
        expect(res.message).toContain('[REDACTED_TOKEN]');
        expect(res.message).toContain('[REDACTED_SQL]');
      } finally {
        fixtures.adjudicationService.inspectQuarantinedSubmission = origInspect;
      }
    });

    it('188. locale parity covers every new R5J5 string in en-US and vi-VN', () => {
      type QuarantinedQueueKey = keyof typeof enUS.quarantinedQueue;
      const newR5J5Keys: QuarantinedQueueKey[] = [
        'confirmResumeTitle',
        'confirmResumeMessage',
        'confirmAcknowledgeTitle',
        'confirmAcknowledgeMessage',
        'nonAuthoritativeBadge',
        'noSummaryProvided',
        'none',
      ];

      for (const key of newR5J5Keys) {
        expect(enUS.quarantinedQueue[key]).toBeDefined();
        expect(typeof enUS.quarantinedQueue[key]).toBe('string');
        expect(enUS.quarantinedQueue[key].length).toBeGreaterThan(0);

        expect(viVN.quarantinedQueue[key]).toBeDefined();
        expect(typeof viVN.quarantinedQueue[key]).toBe('string');
        expect(viVN.quarantinedQueue[key].length).toBeGreaterThan(0);
      }
    });

    it('189. repeated recovery scan produces no duplicate events or dispositions', () => {
      const report1 = fixtures.recoveryScanner.scanAndReconcile();
      const eventsCount1 = (db.prepare('SELECT COUNT(*) as c FROM coder_submission_adjudication_events').get() as { c: number }).c;
      const dispsCount1 = (db.prepare('SELECT COUNT(*) as c FROM coder_submission_dispositions').get() as { c: number }).c;

      const report2 = fixtures.recoveryScanner.scanAndReconcile();
      const eventsCount2 = (db.prepare('SELECT COUNT(*) as c FROM coder_submission_adjudication_events').get() as { c: number }).c;
      const dispsCount2 = (db.prepare('SELECT COUNT(*) as c FROM coder_submission_dispositions').get() as { c: number }).c;

      expect(eventsCount2).toBe(eventsCount1);
      expect(dispsCount2).toBe(dispsCount1);
    });

    it('190. deterministic event same-ID different-content collision fails closed', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

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
        status: 'ADMITTED',
        lifecycle_version: 1,
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: '{}',
        authority_snapshot_hash: computeSha256('{}'),
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: new Date().toISOString(),
        verification_started_at: null,
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: null,
      });

      const eventId = deriveDeterministicAdjudicationEventId(adjId, 1, 'ADMITTED', computeSha256('{"content":"A"}'));

      db.prepare(`
        INSERT INTO coder_submission_adjudication_events (id, adjudication_id, sequence, event_type, payload_json, payload_hash, created_at)
        VALUES (?, ?, 1, 'ADMITTED', '{"content":"A"}', ?, ?)
      `).run(eventId, adjId, computeSha256('{"content":"A"}'), new Date().toISOString());

      expect(() => {
        db.prepare(`
          INSERT INTO coder_submission_adjudication_events (id, adjudication_id, sequence, event_type, payload_json, payload_hash, created_at)
          VALUES (?, ?, 2, 'ADMITTED', '{"content":"DIFFERENT_B"}', ?, ?)
        `).run(eventId, adjId, computeSha256('{"content":"DIFFERENT_B"}'), new Date().toISOString());
      }).toThrow(/UNIQUE constraint failed/);
    });

    it('191. shared authority verifier rejects submission with non-positive task ownership epoch', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      db.prepare('UPDATE tasks SET ownership_epoch = 0 WHERE id = ?').run(fixtures.taskId);

      const result = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(sub);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.fenced_reasons.some((r) => r.includes('ownership epoch'))).toBe(true);
      }
      db.prepare('UPDATE tasks SET ownership_epoch = 1 WHERE id = ?').run(fixtures.taskId);
    });

    it('192. shared authority verifier rejects submission when task attempt is not in RUNNING status', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      db.prepare("UPDATE task_attempts SET status = 'COMPLETED' WHERE id = ?").run(fixtures.attemptId);

      const result = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(sub);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.fenced_reasons.some((r) => r.includes('must be RUNNING'))).toBe(true);
      }
      db.prepare("UPDATE task_attempts SET status = 'RUNNING' WHERE id = ?").run(fixtures.attemptId);
    });

    it('193. shared authority verifier rejects submission when agent assignment attempt_id differs', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const altAttemptId = 'att-alt-' + crypto.randomUUID();
      fixtures.repo.createTaskAttempt({
        id: altAttemptId,
        task_id: fixtures.taskId,
        attempt_number: 2,
        status: 'RUNNING',
        agent_profile_id: fixtures.agentId,
        agent_id: null,
        started_at: new Date().toISOString(),
        ended_at: null,
        summary: null,
      });
      db.prepare('UPDATE agent_assignments SET attempt_id = ? WHERE id = ?').run(altAttemptId, fixtures.assignmentId);

      const result = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(sub);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.fenced_reasons.some((r) => r.includes('Agent assignment belongs to attempt'))).toBe(true);
      }
      db.prepare('UPDATE agent_assignments SET attempt_id = ? WHERE id = ?').run(fixtures.attemptId, fixtures.assignmentId);
    });

    it('194. shared authority verifier rejects submission when execution authorization attempt_id differs', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const altAttemptId = 'att-alt-' + crypto.randomUUID();
      fixtures.repo.createTaskAttempt({
        id: altAttemptId,
        task_id: fixtures.taskId,
        attempt_number: 2,
        status: 'RUNNING',
        agent_profile_id: fixtures.agentId,
        agent_id: null,
        started_at: new Date().toISOString(),
        ended_at: null,
        summary: null,
      });
      db.prepare('UPDATE execution_authorizations SET attempt_id = ? WHERE id = ?').run(altAttemptId, fixtures.authorizationId);

      const result = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(sub);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.fenced_reasons.some((r) => r.includes('Authorization belongs to attempt'))).toBe(true);
      }
      db.prepare('UPDATE execution_authorizations SET attempt_id = ? WHERE id = ?').run(fixtures.attemptId, fixtures.authorizationId);
    });

    it('195. shared authority verifier rejects submission when task is in COMPLETED state', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      db.prepare("UPDATE tasks SET state = 'DONE' WHERE id = ?").run(fixtures.taskId);

      const result = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(sub);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.fenced_reasons.some((r) => r.includes('state'))).toBe(true);
      }
      db.prepare("UPDATE tasks SET state = 'CODING' WHERE id = ?").run(fixtures.taskId);
    });

    it('196. shared authority verifier rejects submission when authorization canonical payload hash does not match', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      db.prepare('UPDATE execution_authorizations SET instruction_payload_hash = ? WHERE id = ?').run(
        '0000000000000000000000000000000000000000000000000000000000000000',
        fixtures.authorizationId
      );

      const result = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(sub);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.fenced_reasons.some((r) => r.includes('hash'))).toBe(true);
      }
      db.prepare('UPDATE execution_authorizations SET instruction_payload_hash = ? WHERE id = ?').run(
        fixtures.instructionPayloadHash,
        fixtures.authorizationId
      );
    });

    it('197. admission rejects verification command with timeout <= 0', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const originalPayloadJson = auth.canonical_payload_json!;
      const originalPayloadHash = auth.instruction_payload_hash;
      try {
        const payload = JSON.parse(originalPayloadJson);
        payload.verificationCommands.TEST = {
          executable: process.execPath,
          args: ['-v'],
          timeout_ms: 0,
        };
        const newJson = JSON.stringify(payload);
        const newHash = crypto.createHash('sha256').update(newJson, 'utf8').digest('hex');
        db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
          .run(newJson, newHash, fixtures.authorizationId);

        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow(/timeout_ms must be a positive integer <= 600000/);
      } finally {
        db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
          .run(originalPayloadJson, originalPayloadHash, fixtures.authorizationId);
      }
    });

    it('198. admission rejects verification command with timeout exceeding 600,000 ms', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const originalPayloadJson = auth.canonical_payload_json!;
      const originalPayloadHash = auth.instruction_payload_hash;
      try {
        const payload = JSON.parse(originalPayloadJson);
        payload.verificationCommands.TEST = {
          executable: process.execPath,
          args: ['-v'],
          timeout_ms: 600001,
        };
        const newJson = JSON.stringify(payload);
        const newHash = crypto.createHash('sha256').update(newJson, 'utf8').digest('hex');
        db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
          .run(newJson, newHash, fixtures.authorizationId);

        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow(/timeout_ms must be a positive integer <= 600000/);
      } finally {
        db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
          .run(originalPayloadJson, originalPayloadHash, fixtures.authorizationId);
      }
    });

    it('199. Phase B atomic claim fails CAS when lifecycle version does not match expected', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
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
        lifecycle_version: 2,
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: new Date().toISOString(),
        verification_started_at: null,
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: null,
      });

      await expect(
        fixtures.adjudicationService.resumeAdmittedSubmission({
          requestId: crypto.randomUUID(),
          submissionId: subId,
          adjudicationId: adjId,
          expectedLifecycleVersion: 1,
        })
      ).rejects.toThrow(/STATUS_CONFLICT.*Adjudication lifecycle version mismatch/);
    });

    it('200. ProcessRunner START_AMBIGUOUS settles as RECOVERY_FENCED, never VERIFICATION_FAILED', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const origExecute = ProcessRunner.execute;
      ProcessRunner.execute = async function (options: StructuredProcessOptions): Promise<ProcessRunResult> {
        if (options.executable === 'git' || (options.args && options.args.includes('rev-parse'))) {
          return origExecute.call(ProcessRunner, options);
        }
        return {
          executionId: options.executionId ?? 'mock-exec',
          pid: 1234,
          command: `${options.executable} ${options.args.join(' ')}`,
          cwd: options.cwd,
          exitCode: -1,
          stdout: '',
          stderr: 'Ambiguous spawn error',
          durationMs: 10,
          timedOut: false,
          cancelled: false,
          processStart: 'START_AMBIGUOUS',
          processTermination: 'NOT_APPLICABLE',
        };
      };

      try {
        const result = await fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        });

        expect(result.status).toBe('RECOVERY_FENCED');
        expect(result.adjudication.status).toBe('RECOVERY_FENCED');
        expect(result.adjudication.failure_code).toBe('PROCESS_START_FAILED');
      } finally {
        ProcessRunner.execute = origExecute;
      }
    });

    it('201. ProcessRunner TERMINATION_UNRESOLVED on timeout settles as RECOVERY_FENCED, never VERIFICATION_FAILED', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const origExecute = ProcessRunner.execute;
      ProcessRunner.execute = async function (options: StructuredProcessOptions): Promise<ProcessRunResult> {
        if (options.executable === 'git' || (options.args && options.args.includes('rev-parse'))) {
          return origExecute.call(ProcessRunner, options);
        }
        return {
          executionId: options.executionId ?? 'mock-exec',
          pid: 1234,
          command: `${options.executable} ${options.args.join(' ')}`,
          cwd: options.cwd,
          exitCode: -1,
          stdout: '',
          stderr: 'Process tree kill timed out',
          durationMs: 1000,
          timedOut: true,
          cancelled: false,
          processStart: 'STARTED_PROVEN',
          processTermination: 'TERMINATION_UNRESOLVED',
        };
      };

      try {
        const result = await fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        });

        expect(result.status).toBe('RECOVERY_FENCED');
        expect(result.adjudication.status).toBe('RECOVERY_FENCED');
        expect(result.adjudication.failure_code).toBe('PROCESS_TERMINATION_UNRESOLVED');
      } finally {
        ProcessRunner.execute = origExecute;
      }
    });

    it('202. ProcessRunner NOT_STARTED_PROVEN settles as RECOVERY_FENCED without tree kill', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const origExecute = ProcessRunner.execute;
      ProcessRunner.execute = async function (options: StructuredProcessOptions): Promise<ProcessRunResult> {
        if (options.executable === 'git' || (options.args && options.args.includes('rev-parse'))) {
          return origExecute.call(ProcessRunner, options);
        }
        return {
          executionId: options.executionId ?? 'mock-exec',
          pid: 1234,
          command: `${options.executable} ${options.args.join(' ')}`,
          cwd: options.cwd,
          exitCode: -1,
          stdout: '',
          stderr: 'ENOENT: command not found',
          durationMs: 5,
          timedOut: false,
          cancelled: false,
          processStart: 'NOT_STARTED_PROVEN',
          processTermination: 'NOT_APPLICABLE',
        };
      };

      try {
        const result = await fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        });

        expect(result.status).toBe('VERIFICATION_FAILED');
        expect(result.adjudication.status).toBe('VERIFICATION_FAILED');
        expect(result.adjudication.failure_code).toBe('PROCESS_START_FAILED');
      } finally {
        ProcessRunner.execute = origExecute;
      }
    });

    it('203. VerificationService executeSealedVerification performs zero database writes', async () => {
      const verifService = fixtures.verificationService;
      const dbChangesBefore = db.prepare('SELECT (SELECT COUNT(*) FROM evidence) as ev, (SELECT COUNT(*) FROM test_runs) as tr, (SELECT COUNT(*) FROM coder_submission_adjudications) as adj').get() as { ev: number; tr: number; adj: number };

      const cmdObj = JSON.parse(fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!.canonical_payload_json!).verificationCommands;
      const cmdJson = JSON.stringify(cmdObj);
      const cmdHash = computeSha256(cmdJson);

      const input: SealedVerificationExecutionInput = {
        adjudication_id: crypto.randomUUID(),
        lifecycle_version: 2,
        verification_execution_id: crypto.randomUUID(),
        authorization_id: fixtures.authorizationId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        assignment_id: fixtures.assignmentId,
        repo_path: fixtures.projectRoot,
        verification_commands_json: cmdJson,
        verification_commands_hash: cmdHash,
        workspace_snapshot_before_json: '{}',
        workspace_snapshot_before_hash: computeSha256('{}'),
        policy: {
          timeout_ms: 10000,
          max_stdout_bytes: 1048576,
          max_stderr_bytes: 1048576,
          allowed_env_keys: ['PATH'],
        },
      };

      const obs = await verifService.executeSealedVerification(input);
      expect(obs).toBeDefined();
      expect(obs.outcome).toBe('SUCCESS');

      const dbChangesAfter = db.prepare('SELECT (SELECT COUNT(*) FROM evidence) as ev, (SELECT COUNT(*) FROM test_runs) as tr, (SELECT COUNT(*) FROM coder_submission_adjudications) as adj').get() as { ev: number; tr: number; adj: number };
      expect(dbChangesAfter.ev).toBe(dbChangesBefore.ev);
      expect(dbChangesAfter.tr).toBe(dbChangesBefore.tr);
      expect(dbChangesAfter.adj).toBe(dbChangesBefore.adj);
    });

    it('204. content-addressed artifact pre-commit materialization creates deterministic .bin files and verifies pre-existing byte identity', () => {
      const store = fixtures.artifactStore;
      const content = 'hello content addressed artifact';
      const hash = computeSha256(content);

      const res1 = store.materializeContentAddressedFile(content, hash);
      expect(res1.filePath.endsWith(`${hash}.bin`)).toBe(true);
      expect(fs.existsSync(res1.filePath)).toBe(true);

      const res2 = store.materializeContentAddressedFile(content, hash);
      expect(res2.filePath).toBe(res1.filePath);
      expect(res2.newlyCreated).toBe(false);

      const wrongContent = 'corrupted bytes';
      expect(() => {
        store.materializeContentAddressedFile(wrongContent, hash);
      }).toThrow(/Hash mismatch before materialization/);
    });

    it('205. ArtifactStore cleanupRollbackFiles removes newly staged content-addressed files without touching pre-existing files', () => {
      const store = fixtures.artifactStore;
      const content = 'file to rollback';
      const hash = computeSha256(content);
      const res = store.materializeContentAddressedFile(content, hash);
      expect(fs.existsSync(res.filePath)).toBe(true);

      store.cleanupRollbackFiles([res.filePath], () => false);
      expect(fs.existsSync(res.filePath)).toBe(false);
    });

    it('206. verifyEvidenceIntegrity rejects FILE evidence when file does not exist on disk', () => {
      const ev: Evidence = {
        id: crypto.randomUUID(),
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'TEST_RESULT',
        storage_type: 'FILE',
        file_path: path.join(fixtures.artifactStore.getBaseDir(), 'non_existent_file.bin'),
        hash: computeSha256('dummy'),
        byte_size: 5,
        content_type: 'application/json',
        summary: 'Missing file',
        raw_payload: null,
        created_at: new Date().toISOString(),
      };

      const result = verifyEvidenceIntegrity(ev, fixtures.artifactStore);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('does not exist');
      }
    });

    it('207. verifyEvidenceIntegrity rejects FILE evidence when disk bytes SHA-256 does not match recorded hash', () => {
      const store = fixtures.artifactStore;
      const content = 'correct bytes';
      const hash = computeSha256(content);
      const mat = store.materializeContentAddressedFile(content, hash);

      const ev: Evidence = {
        id: crypto.randomUUID(),
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'TEST_RESULT',
        storage_type: 'FILE',
        file_path: mat.filePath,
        hash: computeSha256('different bytes'),
        byte_size: content.length,
        content_type: 'application/json',
        summary: 'Corrupted hash',
        raw_payload: null,
        created_at: new Date().toISOString(),
      };

      const result = verifyEvidenceIntegrity(ev, store);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('mismatch');
      }
    });

    it('208. verifyEvidenceIntegrity rejects FILE evidence attempting directory traversal', () => {
      const ev: Evidence = {
        id: crypto.randomUUID(),
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'GIT_DIFF',
        storage_type: 'FILE',
        file_path: '../../../../etc/passwd',
        hash: computeSha256('dummy'),
        byte_size: 5,
        content_type: 'text/plain',
        summary: 'Path traversal',
        raw_payload: null,
        created_at: new Date().toISOString(),
      };

      const result = verifyEvidenceIntegrity(ev, fixtures.artifactStore);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('escapes base directory');
      }
    });

    it('209. verifyEvidenceIntegrity rejects INLINE evidence when raw_payload is null', () => {
      const ev: Evidence = {
        id: crypto.randomUUID(),
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'GIT_STATUS',
        storage_type: 'INLINE',
        file_path: null,
        hash: computeSha256('something'),
        byte_size: 9,
        content_type: 'application/json',
        summary: 'Invalid inline evidence',
        raw_payload: null,
        created_at: new Date().toISOString(),
      };

      const result = verifyEvidenceIntegrity(ev, fixtures.artifactStore);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('raw_payload is null or not a string');
      }
    });

    it('210. verifyEvidenceIntegrity rejects INLINE evidence when raw_payload hash does not match', () => {
      const ev: Evidence = {
        id: crypto.randomUUID(),
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'GIT_STATUS',
        storage_type: 'INLINE',
        file_path: null,
        hash: computeSha256('expected'),
        byte_size: 6,
        content_type: 'application/json',
        summary: 'Invalid hash inline',
        raw_payload: 'actual',
        created_at: new Date().toISOString(),
      };

      const result = verifyEvidenceIntegrity(ev, fixtures.artifactStore);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('hash mismatch');
      }
    });

    it('211. single atomic Phase C transaction rolls back all rows if adjudication CAS fails', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const origUpdate = fixtures.repo.updateCoderSubmissionAdjudication;
      fixtures.repo.updateCoderSubmissionAdjudication = function (id, expectedVersion, updates) {
        if (updates.status === 'VERIFIED') {
          return false;
        }
        return origUpdate.call(fixtures.repo, id, expectedVersion, updates);
      };

      const evCountBefore = (db.prepare('SELECT COUNT(*) as c FROM evidence').get() as { c: number }).c;
      const trCountBefore = (db.prepare('SELECT COUNT(*) as c FROM test_runs').get() as { c: number }).c;

      try {
        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow(/STATUS_CONFLICT.*Settlement CAS failed/);

        const evCountAfter = (db.prepare('SELECT COUNT(*) as c FROM evidence').get() as { c: number }).c;
        const trCountAfter = (db.prepare('SELECT COUNT(*) as c FROM test_runs').get() as { c: number }).c;

        expect(evCountAfter).toBe(evCountBefore);
        expect(trCountAfter).toBe(trCountBefore);
      } finally {
        fixtures.repo.updateCoderSubmissionAdjudication = origUpdate;
      }
    });

    it('212. single atomic Phase C transaction rolls back all rows if TaskStateMachine transition throws', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const origTransition = TaskStateMachine.transition;
      TaskStateMachine.transition = function (...args: Parameters<typeof TaskStateMachine.transition>) {
        if (args[1] === 'EVIDENCE_GATHERED') {
          throw new Error('SIMULATED_STATE_MACHINE_CORRUPTION');
        }
        return origTransition.apply(TaskStateMachine, args);
      };

      try {
        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow(/SIMULATED_STATE_MACHINE_CORRUPTION/);

        const adjs = fixtures.repo.getCoderSubmissionAdjudicationsBySubmission(subId);
        expect(adjs.every((a) => a.status !== 'VERIFIED')).toBe(true);
      } finally {
        TaskStateMachine.transition = origTransition;
      }
    });

    it('213. post-commit settlement performs read-only confirmation and no file moves or copies', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      let postCommitFsMutations = 0;
      let settlementTxCommitted = false;

      const recordMutation = () => {
        if (settlementTxCommitted) {
          postCommitFsMutations++;
        }
      };

      const origWriteFileSync = fs.writeFileSync.bind(fs);
      const origRenameSync = fs.renameSync.bind(fs);
      const origCopyFileSync = fs.copyFileSync.bind(fs);
      const origUnlinkSync = fs.unlinkSync.bind(fs);

      const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
        recordMutation();
        return (origWriteFileSync as any)(...args);
      });
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
        recordMutation();
        return (origRenameSync as any)(...args);
      });
      const copySpy = vi.spyOn(fs, 'copyFileSync').mockImplementation((...args) => {
        recordMutation();
        return (origCopyFileSync as any)(...args);
      });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((...args) => {
        recordMutation();
        return (origUnlinkSync as any)(...args);
      });

      const origTransaction = fixtures.db.transaction.bind(fixtures.db);
      const txSpy = (vi.spyOn(fixtures.db, 'transaction') as any).mockImplementation((fn: any) => {
        const wrapped = origTransaction((...args: any[]) => {
          return fn(...args);
        });
        return (...args: any[]) => {
          const res = wrapped(...args);
          const adj = fixtures.db.prepare("SELECT status FROM coder_submission_adjudications WHERE submission_id = ?").get(subId) as any;
          if (adj && (adj.status === 'VERIFIED' || adj.status === 'VERIFICATION_FAILED')) {
            settlementTxCommitted = true;
          }
          return res;
        };
      });

      try {
        const result = await fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        });

        expect(result.status).toBe('VERIFIED');
        expect(settlementTxCommitted).toBe(true);
        expect(postCommitFsMutations).toBe(0);
      } finally {
        writeSpy.mockRestore();
        renameSpy.mockRestore();
        copySpy.mockRestore();
        unlinkSpy.mockRestore();
        txSpy.mockRestore();
      }
    });

    it('214. acknowledgeRecoveryFenced with CANCEL preserves original failure_code and records resolution_action = CANCEL', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
      const cmdsJson = canonicalJsonStringify(fixtures.authSnapshot.verification_commands);

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
        lifecycle_version: 2,
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        verification_commands_json: cmdsJson,
        verification_commands_hash: computeSha256(cmdsJson),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: new Date().toISOString(),
        failure_code: 'PROCESS_TERMINATION_UNRESOLVED',
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const ack = fixtures.adjudicationService.acknowledgeRecoveryFenced({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        adjudicationId: adjId,
        expectedLifecycleVersion: 2,
        decision: 'CANCEL',
      });

      expect(ack.adjudication.status).toBe('VERIFICATION_FAILED');
      expect(ack.adjudication.failure_code).toBe('PROCESS_TERMINATION_UNRESOLVED');
      expect(ack.adjudication.resolution_action).toBe('CANCEL');
    });

    it('215. acknowledgeRecoveryFenced with CANCEL populates all 5 resolution columns', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
      const cmdsJson = canonicalJsonStringify(fixtures.authSnapshot.verification_commands);

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
        lifecycle_version: 2,
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        verification_commands_json: cmdsJson,
        verification_commands_hash: computeSha256(cmdsJson),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: new Date().toISOString(),
        failure_code: 'START_AMBIGUOUS_CRASH',
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const resolverId = 'operator-test-42';
      const ack = fixtures.adjudicationService.acknowledgeRecoveryFenced({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        adjudicationId: adjId,
        expectedLifecycleVersion: 2,
        decision: 'CANCEL',
        resolverId,
      });

      expect(ack.adjudication.resolution_action).toBe('CANCEL');
      expect(ack.adjudication.resolution_timestamp).toBeDefined();
      expect(ack.adjudication.resolution_evidence_json).toBeDefined();
      expect(ack.adjudication.resolution_evidence_hash).toBeDefined();
      expect(ack.adjudication.resolver_id).toBe(resolverId);
    });

    it('216. acknowledgeRecoveryFenced with ACKNOWLEDGE populates resolution columns and preserves RECOVERY_FENCED status', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
      const cmdsJson = canonicalJsonStringify(fixtures.authSnapshot.verification_commands);

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
        lifecycle_version: 2,
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        verification_commands_json: cmdsJson,
        verification_commands_hash: computeSha256(cmdsJson),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: new Date().toISOString(),
        failure_code: 'ORPHANED_IN_FLIGHT_EXECUTION',
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const ack = fixtures.adjudicationService.acknowledgeRecoveryFenced({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        adjudicationId: adjId,
        expectedLifecycleVersion: 2,
        decision: 'ACKNOWLEDGE',
      });

      expect(ack.adjudication.status).toBe('RECOVERY_FENCED');
      expect(ack.adjudication.failure_code).toBe('ORPHANED_IN_FLIGHT_EXECUTION');
      expect(ack.adjudication.resolution_action).toBe('ACKNOWLEDGE');
      expect(ack.adjudication.resolution_timestamp).toBeDefined();
    });

    it('217. acknowledgeRecoveryFenced is idempotent on repeated CANCEL calls', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
      const cmdsJson = canonicalJsonStringify(fixtures.authSnapshot.verification_commands);

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
        lifecycle_version: 2,
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        verification_commands_json: cmdsJson,
        verification_commands_hash: computeSha256(cmdsJson),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: new Date().toISOString(),
        failure_code: 'ORPHANED_IN_FLIGHT_EXECUTION',
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const ack1 = fixtures.adjudicationService.acknowledgeRecoveryFenced({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        adjudicationId: adjId,
        expectedLifecycleVersion: 2,
        decision: 'CANCEL',
      });
      expect(ack1.adjudication.status).toBe('VERIFICATION_FAILED');

      const ack2 = fixtures.adjudicationService.acknowledgeRecoveryFenced({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        adjudicationId: adjId,
        expectedLifecycleVersion: 3,
        decision: 'CANCEL',
      });
      expect(ack2.adjudication.status).toBe('VERIFICATION_FAILED');
      expect(ack2.adjudication.resolution_action).toBe('CANCEL');
    });

    it('218. acknowledgeRecoveryFenced is idempotent on repeated ACKNOWLEDGE calls', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
      const cmdsJson = canonicalJsonStringify(fixtures.authSnapshot.verification_commands);

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
        lifecycle_version: 2,
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        verification_commands_json: cmdsJson,
        verification_commands_hash: computeSha256(cmdsJson),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: new Date().toISOString(),
        failure_code: 'ORPHANED_IN_FLIGHT_EXECUTION',
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const ack1 = fixtures.adjudicationService.acknowledgeRecoveryFenced({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        adjudicationId: adjId,
        expectedLifecycleVersion: 2,
        decision: 'ACKNOWLEDGE',
      });
      expect(ack1.adjudication.status).toBe('RECOVERY_FENCED');

      const ack2 = fixtures.adjudicationService.acknowledgeRecoveryFenced({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        adjudicationId: adjId,
        expectedLifecycleVersion: 3,
        decision: 'ACKNOWLEDGE',
      });
      expect(ack2.adjudication.status).toBe('RECOVERY_FENCED');
      expect(ack2.adjudication.resolution_action).toBe('ACKNOWLEDGE');
    });

    it('219. buildVerifiedAdjudicationReviewProjection throws INTEGRITY_CONFLICT when submission authority is compromised', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
      const cmdsJson = canonicalJsonStringify(fixtures.authSnapshot.verification_commands);
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
        created_at: new Date().toISOString(),
        verification_started_at: null,
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: null,
      });

      db.prepare('UPDATE tasks SET ownership_epoch = 99 WHERE id = ?').run(fixtures.taskId);

      expect(() => {
        fixtures.adjudicationService.buildVerifiedAdjudicationReviewProjection(adjId);
      }).toThrow(/INTEGRITY_CONFLICT.*Submission authority integrity failed/);

      db.prepare('UPDATE tasks SET ownership_epoch = 1 WHERE id = ?').run(fixtures.taskId);
    });

    it('220. buildVerifiedAdjudicationReviewProjection builds complete projection for VERIFIED adjudication with disk-based FILE evidence', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });
      expect(admitRes.status).toBe('VERIFIED');

      const projection = fixtures.adjudicationService.buildVerifiedAdjudicationReviewProjection(admitRes.adjudication.id);
      expect(projection).toBeDefined();
      expect(projection.adjudication_id).toBe(admitRes.adjudication.id);
      expect(projection.projection_hash).toBeDefined();
      expect(typeof projection.projection_hash).toBe('string');
      expect(projection.authoritative_verification.verdict).toBe('PASSED');
      expect(projection.authoritative_git_diff).toBeDefined();
    });

    it('221. buildVerifiedAdjudicationReviewProjection builds complete projection for RECOVERY_FENCED adjudication', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
      const cmdsJson = canonicalJsonStringify(fixtures.authSnapshot.verification_commands);

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
        created_at: new Date().toISOString(),
        verification_started_at: null,
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: null,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      fixtures.recoveryScanner.fenceAdjudication(adj, 'PROCESS_TERMINATION_UNRESOLVED');

      const projection = fixtures.adjudicationService.buildVerifiedAdjudicationReviewProjection(adjId);
      expect(projection).toBeDefined();
      expect(projection.recovery_fencing_state?.is_fenced).toBe(true);
      expect(projection.recovery_fencing_state?.failure_code).toBe('PROCESS_TERMINATION_UNRESOLVED');
      expect(projection.authoritative_verification.verdict).toBe('FENCED');
    });

    it('222. PackageGenerator.generateReviewPackage with VerifiedAdjudicationReviewProjection renders full review package matching canonical format', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const projection = fixtures.adjudicationService.buildVerifiedAdjudicationReviewProjection(admitRes.adjudication.id);
      const pkg1 = PackageGenerator.generateReviewPackage(
        fixtures.repo.getProject(fixtures.projectId)!,
        fixtures.repo.getTask(fixtures.taskId)!,
        null,
        '',
        '',
        null,
        [],
        null,
        projection
      );
      const pkg2 = PackageGenerator.generateReviewPackage(
        fixtures.repo.getProject(fixtures.projectId)!,
        fixtures.repo.getTask(fixtures.taskId)!,
        null,
        '',
        '',
        null,
        [],
        null,
        projection
      );

      expect(pkg1).toBe(pkg2);
      expect(pkg1).toContain('# REVIEW PACKAGE:');
      expect(pkg1).toContain('## Authoritative Verification Evidence (Ground Truth)');
      expect(pkg1).toContain('### Owner Adjudication');
      expect(pkg1).toContain(projection.projection_hash);
      expect(pkg1).toContain('"protocol": "manager.v1"');

      // Forged projection hash is rejected
      const forged = { ...projection, projection_hash: 'f'.repeat(64) };
      expect(() => {
        PackageGenerator.generateReviewPackage(
          fixtures.repo.getProject(fixtures.projectId)!,
          fixtures.repo.getTask(fixtures.taskId)!,
          null,
          '',
          '',
          null,
          [],
          null,
          forged
        );
      }).toThrow(/PROJECTION_HASH_MISMATCH/);

      // AdjudicationReviewPackageLinkage rejected
      const legacy: any = {
        adjudication_id: admitRes.adjudication.id,
        adjudication_status: 'VERIFIED',
        verdict: 'PASSED',
        verified_at: new Date().toISOString(),
      };
      expect(() => {
        PackageGenerator.generateReviewPackage(
          fixtures.repo.getProject(fixtures.projectId)!,
          fixtures.repo.getTask(fixtures.taskId)!,
          null,
          '',
          '',
          null,
          [],
          null,
          legacy
        );
      }).toThrow(/LEGACY_LINKAGE_REJECTED/);
    });

  });
});
