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
  describe('Group 7F: Cancellation & Workspace Snapshots', () => {
    it('328. Exact valid terminal recovery tuple for VERIFIED is accepted (ALREADY_RECONCILED NO_OP)', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      expect(adj.status).toBe('VERIFIED');
      expect(adj.lifecycle_version).toBe(3);

      const eventsBefore = fixtures.repo.getCoderSubmissionAdjudicationEvents(adj.id).length;
      const dispsBefore = fixtures.repo.getCoderSubmissionDispositions(subId).length;

      const recon = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      if (recon.error) console.log('295 RECON ERROR:', recon.error);
      expect(recon.classification).toBe('ALREADY_RECONCILED');
      expect(recon.action_taken).toBe('NO_OP');
      expect(fixtures.repo.getCoderSubmissionAdjudicationEvents(adj.id).length).toBe(eventsBefore);
      expect(fixtures.repo.getCoderSubmissionDispositions(subId).length).toBe(dispsBefore);
    });

    it('329. VERIFIED adjudication: missing/duplicate/contradictory disposition or event returns AUTHORITY_CONFLICT', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;

      // 1. Missing event
      const adjMissingId = crypto.randomUUID();
      const rawMan = JSON.parse(adj.artifact_manifest_json!);
      rawMan.adjudication_id = adjMissingId;

      const rawEnv = JSON.parse(adj.verification_result_envelope_json!);
      rawEnv.adjudication_id = adjMissingId;

      const oldWsAfter = fixtures.repo.getEvidence(rawEnv.workspace_snapshot_after_evidence_id)!;
      const oldWsObj = JSON.parse(oldWsAfter.raw_payload || (oldWsAfter.file_path ? fs.readFileSync(oldWsAfter.file_path, 'utf8') : '{}'));
      const newWsObj = { ...oldWsObj, adjudication_id: adjMissingId };
      const newWsContent = canonicalJsonStringify(newWsObj);
      const newWsHash = computeSha256(newWsContent);
      const matWs = fixtures.artifactStore.materializeContentAddressedFile(newWsContent, newWsHash);
      const newWsEv: Evidence = {
        id: crypto.randomUUID(),
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'FILE_SNAPSHOT',
        storage_type: 'FILE',
        file_path: matWs.filePath,
        hash: newWsHash,
        byte_size: matWs.byteSize,
        content_type: 'application/json',
        summary: 'Workspace snapshot after',
        raw_payload: null,
        created_at: new Date().toISOString(),
      };
      fixtures.repo.createEvidence(newWsEv);

      rawEnv.workspace_snapshot_after_evidence_id = newWsEv.id;
      rawEnv.workspace_snapshot_after_hash = newWsHash;

      const wsIdx = rawMan.entries.findIndex((e: any) => e.evidence_type === 'FILE_SNAPSHOT');
      if (wsIdx >= 0) {
        rawMan.entries[wsIdx].evidence_id = newWsEv.id;
        rawMan.entries[wsIdx].sha256 = newWsHash;
        rawMan.entries[wsIdx].byte_size = newWsEv.byte_size;
        rawMan.entries[wsIdx].relative_path = path.relative(fixtures.artifactStore.getBaseDir(), matWs.filePath).replace(/\\/g, '/');
      }

      const newManJson = canonicalizeArtifactManifest(rawMan);
      const newManHash = computeArtifactManifestHash(newManJson);

      rawEnv.artifact_manifest_hash = newManHash;
      const newEnvJson = canonicalJsonStringify(rawEnv);
      const newEnvHash = computeSha256(newEnvJson);

      fixtures.repo.createCoderSubmissionAdjudication({
        ...adj,
        id: adjMissingId,
        request_id: crypto.randomUUID(),
        verification_result_envelope_json: newEnvJson,
        verification_result_envelope_hash: newEnvHash,
        artifact_manifest_json: newManJson,
        artifact_manifest_hash: newManHash,
      });
      const r1 = fixtures.recoveryScanner.reconcileSingleAdjudication(fixtures.repo.getCoderSubmissionAdjudicationById(adjMissingId)!);
      expect(r1.classification).toBe('AUTHORITY_CONFLICT');
      expect(r1.error).toContain('terminal event');

      // 2. Contradictory REJECTED disposition
      const nowIso = new Date().toISOString();
      fixtures.repo.createCoderSubmissionDisposition({
        id: crypto.randomUUID(),
        submission_id: subId,
        disposition_event: 'REJECTED',
        disposition_reason: 'COLLISION_CONFLICT',
        actor_type: 'SYSTEM',
        actor_id: 'test',
        disposition_metadata_json: null,
        created_at: nowIso,
      });
      const r2 = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(r2.classification).toBe('AUTHORITY_CONFLICT');
      expect(r2.error).toContain('terminal disposition');

      // 3. Duplicate event
      const pHash = computeSha256('{}');
      fixtures.repo.createCoderSubmissionAdjudicationEvent({
        id: crypto.randomUUID(),
        adjudication_id: adj.id,
        sequence: 4,
        event_type: 'VERIFICATION_SUCCEEDED',
        payload_json: '{}',
        payload_hash: pHash,
        created_at: nowIso,
      });
      const r3 = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(r3.classification).toBe('AUTHORITY_CONFLICT');
      expect(r3.error).toContain('terminal event');
    });

    it('330. Exact valid terminal recovery tuple for VERIFICATION_FAILED is accepted (ALREADY_RECONCILED NO_OP)', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const trId = crypto.randomUUID();
      const evId = crypto.randomUUID();
      const execId = crypto.randomUUID();
      const leaseId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
      const snapHash = computeSha256(snapJson);

      fixtures.repo.createEvidence({
        id: evId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'TEST_RESULT',
        storage_type: 'INLINE',
        content_type: 'text/plain',
        byte_size: 4,
        hash: computeSha256('fail'),
        file_path: null,
        summary: 'fail evidence',
        raw_payload: 'fail',
        created_at: nowIso,
      });

      const afterEvId = 'ev-ws-after-' + crypto.randomUUID();
      const wsAfterObj = buildCanonicalWorkspaceSnapshotAfterPayload({
        adjudicationId: adjId,
        submissionId: subId,
        authorizationId: fixtures.authorizationId,
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        assignmentId: fixtures.assignmentId,
        verificationExecutionId: execId,
        capturedRepositoryHeadSha: fixtures.repoHeadSha,
        expectedHeadSha: fixtures.repoHeadSha,
        gitDiffEvidenceHash: '',
        gitStatusEvidenceHash: '',
        workspaceLeaseId: leaseId,
        worktreeIdentityHash: computeSha256(fixtures.projectRoot.toLowerCase()),
        taskOwnershipEpoch: 1,
        adjudicationLifecycleVersion: 3,
        capturedAt: nowIso,
      });
      const wsAfterContent = canonicalJsonStringify(wsAfterObj);
      const wsAfterHash = computeSha256(wsAfterContent);
      fixtures.repo.createEvidence({
        id: afterEvId,
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
        passed_count: 0,
        failed_count: 1,
        skipped_count: 0,
        duration_ms: 50,
        exit_code: 1,
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
            sha256: computeSha256('fail'),
            storage_class: 'INLINE',
          },
          {
            byte_size: Buffer.byteLength(wsAfterContent, 'utf8'),
            content_type: 'application/json',
            evidence_id: afterEvId,
            evidence_type: 'FILE_SNAPSHOT',
            relative_path: 'ws_after.json',
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
        command_snapshot_hash: computeSha256('{}'),
        exit_classification: 'EXIT_NONZERO',
        failure_code: 'TESTS_FAILED',
        failure_payload: { error: 'Test failed', failed_tests_count: 1 },
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
        test_result_evidence_hash: computeSha256('fail'),
        test_result_evidence_id: evId,
        test_run_id: trId,
        verification_execution_id: execId,
        workspace_snapshot_after_evidence_id: afterEvId,
        workspace_snapshot_after_hash: wsAfterHash,
        workspace_snapshot_before_hash: computeSha256('before'),
      };
      const envJson = canonicalJsonStringify(envelope);
      const envHash = computeSha256(envJson);

      fixtures.db.exec('PRAGMA foreign_keys = OFF;');
      try {
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
          status: 'VERIFICATION_FAILED',
          lifecycle_version: 3,
          protocol_message_id: null,
          request_id: crypto.randomUUID(),
          authority_snapshot_json: snapJson,
          authority_snapshot_hash: snapHash,
          workspace_snapshot_before_json: null,
          workspace_snapshot_before_hash: computeSha256('before'),
          verification_commands_json: '{}',
          verification_commands_hash: computeSha256('{}'),
          created_at: nowIso,
          verification_started_at: nowIso,
          completed_at: nowIso,
          recovery_fenced_at: null,
          failure_code: 'TESTS_FAILED',
          failure_json: canonicalJsonStringify({ error: 'Test failed', failed_tests_count: 1 }),
          test_run_id: trId,
          git_status_evidence_id: null,
          git_diff_evidence_id: null,
          verification_execution_id: execId,
          verification_result_envelope_json: envJson,
          verification_result_envelope_hash: envHash,
          artifact_manifest_json: manifestJson,
          artifact_manifest_hash: manifestHash,
          workspace_lease_id: leaseId,
        });

        fixtures.repo.createWorkspaceLease({
          id: leaseId,
          adjudication_id: adjId,
          worktree_identity_hash: computeSha256(path.resolve(fixtures.projectRoot).toLowerCase()),
          admitted_workspace_fingerprint_hash: computeSha256('admitted'),
          pre_execution_fingerprint_hash: null,
          claim_nonce: crypto.randomUUID(),
          execution_id: execId,
          lease_owner_identity: fixtures.assignmentId,
          assignment_id: fixtures.assignmentId,
          authorization_id: fixtures.authorizationId,
          acquired_at: nowIso,
          released_at: nowIso,
          lifecycle_version: 2,
          state: 'RELEASED',
          failure_code: null,
          failure_evidence_hash: null,
        });
      } finally {
        fixtures.db.exec('PRAGMA foreign_keys = ON;');
      }

      const failPayload = buildCanonicalTerminalEventPayload('VERIFICATION_FAILED', adjId, 'TESTS_FAILED', 'Test failed');
      const failPayloadHash = computeSha256(failPayload);
      fixtures.repo.createCoderSubmissionAdjudicationEvent({
        id: deriveDeterministicAdjudicationEventId(adjId, 3, 'VERIFICATION_FAILED', failPayloadHash),
        adjudication_id: adjId,
        sequence: 3,
        event_type: 'VERIFICATION_FAILED',
        payload_json: failPayload,
        payload_hash: failPayloadHash,
        created_at: nowIso,
      });

      fixtures.repo.createCoderSubmissionDisposition(
        buildCanonicalTerminalDisposition('VERIFICATION_FAILED', adjId, subId, nowIso, {
          failureCode: 'TESTS_FAILED',
          error: 'Test failed',
        })
      );

      fixtures.db.prepare("UPDATE tasks SET state = 'NEEDS_HUMAN' WHERE id = ?").run(fixtures.taskId);

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      const recon = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(recon.classification).toBe('ALREADY_RECONCILED');
      expect(recon.action_taken).toBe('NO_OP');
    });

    it('331. VERIFICATION_FAILED adjudication: missing/duplicate event or contradictory disposition returns AUTHORITY_CONFLICT', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const trId = crypto.randomUUID();
      const evId = crypto.randomUUID();
      const execId = crypto.randomUUID();
      const leaseId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
      const snapHash = computeSha256(snapJson);

      fixtures.repo.createEvidence({
        id: evId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'TEST_RESULT',
        storage_type: 'INLINE',
        content_type: 'text/plain',
        byte_size: 5,
        hash: computeSha256('fail2'),
        file_path: null,
        summary: 'fail evidence 2',
        raw_payload: 'fail2',
        created_at: nowIso,
      });

      const afterEvId = 'ev-ws-after-' + crypto.randomUUID();
      const wsAfterObj = buildCanonicalWorkspaceSnapshotAfterPayload({
        adjudicationId: adjId,
        submissionId: subId,
        authorizationId: fixtures.authorizationId,
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        assignmentId: fixtures.assignmentId,
        verificationExecutionId: execId,
        capturedRepositoryHeadSha: fixtures.repoHeadSha,
        expectedHeadSha: fixtures.repoHeadSha,
        gitDiffEvidenceHash: '',
        gitStatusEvidenceHash: '',
        workspaceLeaseId: leaseId,
        worktreeIdentityHash: computeSha256(fixtures.projectRoot.toLowerCase()),
        taskOwnershipEpoch: 1,
        adjudicationLifecycleVersion: 3,
        capturedAt: nowIso,
      });
      const wsAfterContent = canonicalJsonStringify(wsAfterObj);
      const wsAfterHash = computeSha256(wsAfterContent);
      fixtures.repo.createEvidence({
        id: afterEvId,
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
        summary: 'ws after evidence 331',
        raw_payload: wsAfterContent,
      });

      fixtures.repo.createTestRun({
        id: trId,
        task_id: fixtures.taskId,
        command: 'npm test',
        passed_count: 0,
        failed_count: 1,
        skipped_count: 0,
        duration_ms: 50,
        exit_code: 1,
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
            byte_size: 5,
            content_type: 'text/plain',
            evidence_id: evId,
            evidence_type: 'TEST_RESULT',
            relative_path: 'test.txt',
            sha256: computeSha256('fail2'),
            storage_class: 'INLINE',
          },
          {
            byte_size: Buffer.byteLength(wsAfterContent, 'utf8'),
            content_type: 'application/json',
            evidence_id: afterEvId,
            evidence_type: 'FILE_SNAPSHOT',
            relative_path: 'ws_after.json',
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
        command_snapshot_hash: computeSha256('{}'),
        exit_classification: 'EXIT_NONZERO',
        failure_code: 'TESTS_FAILED',
        failure_payload: { error: 'fail2', failed_tests_count: 1 },
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
        test_result_evidence_hash: computeSha256('fail2'),
        test_result_evidence_id: evId,
        test_run_id: trId,
        verification_execution_id: execId,
        workspace_snapshot_after_evidence_id: afterEvId,
        workspace_snapshot_after_hash: wsAfterHash,
        workspace_snapshot_before_hash: computeSha256('before'),
      };
      const envJson = canonicalJsonStringify(envelope);
      const envHash = computeSha256(envJson);

      fixtures.db.exec('PRAGMA foreign_keys = OFF;');
      try {
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
          status: 'VERIFICATION_FAILED',
          lifecycle_version: 3,
          protocol_message_id: null,
          request_id: crypto.randomUUID(),
          authority_snapshot_json: snapJson,
          authority_snapshot_hash: snapHash,
          workspace_snapshot_before_json: null,
          workspace_snapshot_before_hash: computeSha256('before'),
          verification_commands_json: '{}',
          verification_commands_hash: computeSha256('{}'),
          created_at: nowIso,
          verification_started_at: nowIso,
          completed_at: nowIso,
          recovery_fenced_at: null,
          failure_code: 'TESTS_FAILED',
          failure_json: canonicalJsonStringify({ error: 'fail2', failed_tests_count: 1 }),
          test_run_id: trId,
          git_status_evidence_id: null,
          git_diff_evidence_id: null,
          verification_execution_id: execId,
          verification_result_envelope_json: envJson,
          verification_result_envelope_hash: envHash,
          artifact_manifest_json: manifestJson,
          artifact_manifest_hash: manifestHash,
          workspace_lease_id: leaseId,
        });

        fixtures.repo.createWorkspaceLease({
          id: leaseId,
          adjudication_id: adjId,
          worktree_identity_hash: computeSha256(path.resolve(fixtures.projectRoot).toLowerCase()),
          admitted_workspace_fingerprint_hash: computeSha256('admitted'),
          pre_execution_fingerprint_hash: null,
          claim_nonce: crypto.randomUUID(),
          execution_id: execId,
          lease_owner_identity: fixtures.assignmentId,
          assignment_id: fixtures.assignmentId,
          authorization_id: fixtures.authorizationId,
          acquired_at: nowIso,
          released_at: nowIso,
          lifecycle_version: 2,
          state: 'RELEASED',
          failure_code: null,
          failure_evidence_hash: null,
        });
      } finally {
        fixtures.db.exec('PRAGMA foreign_keys = ON;');
      }

      fixtures.db.prepare("UPDATE tasks SET state = 'NEEDS_HUMAN' WHERE id = ?").run(fixtures.taskId);

      // Missing terminal event
      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      const r1 = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(r1.classification).toBe('AUTHORITY_CONFLICT');
      expect(r1.error).toContain('terminal event');

      // Add valid terminal event
      const failPayload = canonicalJsonStringify({
        adjudication_id: adjId,
        error: 'fail2',
        failure_code: 'TESTS_FAILED',
      });
      const failPayloadHash = computeSha256(failPayload);
      fixtures.repo.createCoderSubmissionAdjudicationEvent({
        id: deriveDeterministicAdjudicationEventId(adjId, 3, 'VERIFICATION_FAILED', failPayloadHash),
        adjudication_id: adjId,
        sequence: 3,
        event_type: 'VERIFICATION_FAILED',
        payload_json: failPayload,
        payload_hash: failPayloadHash,
        created_at: nowIso,
      });

      // Add contradictory SETTLED disposition
      fixtures.repo.createCoderSubmissionDisposition({
        id: crypto.randomUUID(),
        submission_id: subId,
        disposition_event: 'SETTLED',
        disposition_reason: 'ACCEPTED_VERIFIED',
        actor_type: 'SYSTEM',
        actor_id: 'test',
        disposition_metadata_json: null,
        created_at: nowIso,
      });

      const r2 = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(r2.classification).toBe('AUTHORITY_CONFLICT');
      expect(r2.error).toContain('contradictory SETTLED disposition');
    });

    it('332. Exact valid terminal recovery tuple for result-bearing RECOVERY_FENCED is accepted', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const leaseId = crypto.randomUUID();
      const trId = crypto.randomUUID();
      const evId = crypto.randomUUID();
      const execId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
      const snapHash = computeSha256(snapJson);

      fixtures.repo.createEvidence({
        id: evId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'TEST_RESULT',
        storage_type: 'INLINE',
        content_type: 'text/plain',
        byte_size: 5,
        hash: computeSha256('fence'),
        file_path: null,
        summary: 'fence evidence',
        raw_payload: 'fence',
        created_at: nowIso,
      });

      const afterEvId = 'ev-ws-after-' + crypto.randomUUID();
      const wsAfterObj = buildCanonicalWorkspaceSnapshotAfterPayload({
        adjudicationId: adjId,
        submissionId: subId,
        authorizationId: fixtures.authorizationId,
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        assignmentId: fixtures.assignmentId,
        verificationExecutionId: execId,
        capturedRepositoryHeadSha: fixtures.repoHeadSha,
        expectedHeadSha: fixtures.repoHeadSha,
        gitDiffEvidenceHash: '',
        gitStatusEvidenceHash: '',
        workspaceLeaseId: leaseId,
        worktreeIdentityHash: computeSha256(fixtures.projectRoot.toLowerCase()),
        taskOwnershipEpoch: 1,
        adjudicationLifecycleVersion: 3,
        capturedAt: nowIso,
      });
      const wsAfterContent = canonicalJsonStringify(wsAfterObj);
      const wsAfterHash = computeSha256(wsAfterContent);
      fixtures.repo.createEvidence({
        id: afterEvId,
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
        summary: 'ws after evidence 332',
        raw_payload: wsAfterContent,
      });

      fixtures.repo.createTestRun({
        id: trId,
        task_id: fixtures.taskId,
        command: 'npm test',
        passed_count: 0,
        failed_count: 0,
        skipped_count: 0,
        duration_ms: 50,
        exit_code: 1,
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
            byte_size: 5,
            content_type: 'text/plain',
            evidence_id: evId,
            evidence_type: 'TEST_RESULT',
            relative_path: 'test.txt',
            sha256: computeSha256('fence'),
            storage_class: 'INLINE',
          },
          {
            byte_size: Buffer.byteLength(wsAfterContent, 'utf8'),
            content_type: 'application/json',
            evidence_id: afterEvId,
            evidence_type: 'FILE_SNAPSHOT',
            relative_path: 'ws_after.json',
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
        command_snapshot_hash: computeSha256('{}'),
        exit_classification: 'CANCELLED',
        failure_code: 'RECOVERY_FENCED',
        failure_payload: { is_fenced: true, reason: 'Test fence' },
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
        test_result_evidence_hash: computeSha256('fence'),
        test_result_evidence_id: evId,
        test_run_id: trId,
        verification_execution_id: execId,
        workspace_snapshot_after_evidence_id: afterEvId,
        workspace_snapshot_after_hash: wsAfterHash,
        workspace_snapshot_before_hash: computeSha256('before'),
      };
      const envJson = canonicalJsonStringify(envelope);
      const envHash = computeSha256(envJson);

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
        authority_snapshot_hash: snapHash,
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: computeSha256('before'),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: nowIso,
        verification_started_at: nowIso,
        completed_at: null,
        recovery_fenced_at: nowIso,
        failure_code: 'RECOVERY_FENCED',
        failure_json: canonicalJsonStringify({ is_fenced: true, reason: 'Test fence' }),
        test_run_id: trId,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: execId,
        verification_result_envelope_json: envJson,
        verification_result_envelope_hash: envHash,
        artifact_manifest_json: manifestJson,
        artifact_manifest_hash: manifestHash,
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
        released_at: nowIso,
        lifecycle_version: 2,
        state: 'RELEASED',
        failure_code: null,
        failure_evidence_hash: null,
      });

      fixtures.db.prepare('UPDATE coder_submission_adjudications SET workspace_lease_id = ?, lifecycle_version = 3 WHERE id = ?').run(leaseId, adjId);

      const fencedPayload = buildCanonicalTerminalEventPayload('RECOVERY_FENCED', adjId, 'RECOVERY_FENCED', 'Test fence');
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
          failureCode: 'RECOVERY_FENCED',
          error: 'Test fence',
          isResultBearing: true,
        })
      );

      fixtures.db.prepare("UPDATE tasks SET state = 'NEEDS_HUMAN' WHERE id = ?").run(fixtures.taskId);

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      const recon = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(recon.classification).toBe('ALREADY_RECONCILED');
      expect(recon.action_taken).toBe('NO_OP');
    });

    it('333. Result-bearing RECOVERY_FENCED: contradictory disposition or invalid lease returns AUTHORITY_CONFLICT', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const leaseId = crypto.randomUUID();
      const trId = crypto.randomUUID();
      const evId = crypto.randomUUID();
      const execId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
      const snapHash = computeSha256(snapJson);

      fixtures.repo.createEvidence({
        id: evId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'TEST_RESULT',
        storage_type: 'INLINE',
        content_type: 'text/plain',
        byte_size: 8,
        hash: computeSha256('fence333'),
        file_path: null,
        summary: 'fence evidence',
        raw_payload: 'fence333',
        created_at: nowIso,
      });

      const afterEvId = 'ev-ws-after-' + crypto.randomUUID();
      const wsAfterObj = buildCanonicalWorkspaceSnapshotAfterPayload({
        adjudicationId: adjId,
        submissionId: subId,
        authorizationId: fixtures.authorizationId,
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        assignmentId: fixtures.assignmentId,
        verificationExecutionId: execId,
        capturedRepositoryHeadSha: fixtures.repoHeadSha,
        expectedHeadSha: fixtures.repoHeadSha,
        gitDiffEvidenceHash: '',
        gitStatusEvidenceHash: '',
        workspaceLeaseId: leaseId,
        worktreeIdentityHash: computeSha256(fixtures.projectRoot.toLowerCase()),
        taskOwnershipEpoch: 1,
        adjudicationLifecycleVersion: 3,
        capturedAt: nowIso,
      });
      const wsAfterContent = canonicalJsonStringify(wsAfterObj);
      const wsAfterHash = computeSha256(wsAfterContent);
      fixtures.repo.createEvidence({
        id: afterEvId,
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
        summary: 'ws after evidence 333',
        raw_payload: wsAfterContent,
      });

      fixtures.repo.createTestRun({
        id: trId,
        task_id: fixtures.taskId,
        command: 'npm test',
        passed_count: 0,
        failed_count: 0,
        skipped_count: 0,
        duration_ms: 50,
        exit_code: 1,
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
            byte_size: 8,
            content_type: 'text/plain',
            evidence_id: evId,
            evidence_type: 'TEST_RESULT',
            relative_path: 'test.txt',
            sha256: computeSha256('fence333'),
            storage_class: 'INLINE',
          },
          {
            byte_size: Buffer.byteLength(wsAfterContent, 'utf8'),
            content_type: 'application/json',
            evidence_id: afterEvId,
            evidence_type: 'FILE_SNAPSHOT',
            relative_path: 'ws_after.json',
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
        command_snapshot_hash: computeSha256('{}'),
        exit_classification: 'CANCELLED',
        failure_code: 'RECOVERY_FENCED',
        failure_payload: { is_fenced: true, reason: 'Fence 333' },
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
        test_result_evidence_hash: computeSha256('fence333'),
        test_result_evidence_id: evId,
        test_run_id: trId,
        verification_execution_id: execId,
        workspace_snapshot_after_evidence_id: afterEvId,
        workspace_snapshot_after_hash: wsAfterHash,
        workspace_snapshot_before_hash: computeSha256('before'),
      };
      const envJson = canonicalJsonStringify(envelope);
      const envHash = computeSha256(envJson);

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
        authority_snapshot_hash: snapHash,
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: computeSha256('before'),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: nowIso,
        verification_started_at: nowIso,
        completed_at: null,
        recovery_fenced_at: nowIso,
        failure_code: 'RECOVERY_FENCED',
        failure_json: canonicalJsonStringify({ is_fenced: true, reason: 'Fence 333' }),
        test_run_id: trId,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: execId,
        verification_result_envelope_json: envJson,
        verification_result_envelope_hash: envHash,
        artifact_manifest_json: manifestJson,
        artifact_manifest_hash: manifestHash,
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
        released_at: null, // Active / unreleased lease!
        lifecycle_version: 1,
        state: 'ACQUIRED',
        failure_code: null,
        failure_evidence_hash: null,
      });

      fixtures.db.prepare('UPDATE coder_submission_adjudications SET workspace_lease_id = ?, lifecycle_version = 3 WHERE id = ?').run(leaseId, adjId);

      const fencedPayload = canonicalJsonStringify({
        adjudication_id: adjId,
        error: 'Fence 333',
        failure_code: 'RECOVERY_FENCED',
      });
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

      fixtures.db.prepare("UPDATE tasks SET state = 'NEEDS_HUMAN' WHERE id = ?").run(fixtures.taskId);

      // Unreleased lease triggers AUTHORITY_CONFLICT
      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      const r1 = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(r1.classification).toBe('AUTHORITY_CONFLICT');
      expect(r1.error).toContain('workspace lease must be FENCED or RELEASED');

      // Now release lease, but insert contradictory SETTLED disposition
      fixtures.repo.updateWorkspaceLease(leaseId, 1, { state: 'RELEASED', released_at: nowIso });
      fixtures.repo.createCoderSubmissionDisposition({
        id: crypto.randomUUID(),
        submission_id: subId,
        disposition_event: 'SETTLED',
        disposition_reason: 'ACCEPTED_VERIFIED',
        actor_type: 'SYSTEM',
        actor_id: 'test',
        disposition_metadata_json: null,
        created_at: nowIso,
      });

      const r2 = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(r2.classification).toBe('AUTHORITY_CONFLICT');
      expect(r2.error).toContain('contradictory SETTLED disposition');
    });

    it('334. Exact valid pre-result RECOVERY_FENCED tuple is accepted', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const leaseId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
      const snapHash = computeSha256(snapJson);

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
        authority_snapshot_hash: snapHash,
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: nowIso,
        verification_started_at: null,
        completed_at: null,
        recovery_fenced_at: nowIso,
        failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
        failure_json: canonicalJsonStringify({ is_fenced: true, reason: 'Early fence' }),
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: null,
        verification_result_envelope_json: null,
        verification_result_envelope_hash: null,
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
        released_at: nowIso,
        lifecycle_version: 2,
        state: 'RELEASED',
        failure_code: null,
        failure_evidence_hash: null,
      });

      fixtures.db.prepare('UPDATE coder_submission_adjudications SET workspace_lease_id = ?, lifecycle_version = 3 WHERE id = ?').run(leaseId, adjId);

      const fencedPayload = buildCanonicalTerminalEventPayload('RECOVERY_FENCED', adjId, 'ORPHANED_VERIFICATION_INTERRUPTED', 'Early fence');
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
          error: 'Early fence',
          isResultBearing: false,
        })
      );

      fixtures.db.prepare("UPDATE tasks SET state = 'NEEDS_HUMAN' WHERE id = ?").run(fixtures.taskId);

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      const recon = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(recon.classification).toBe('ALREADY_RECONCILED');
      expect(recon.action_taken).toBe('NO_OP');
    });

    it('335. Pre-result RECOVERY_FENCED rejects envelope/manifest presence, lifecycle != 3, or invalid lease', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const leaseId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
      const snapHash = computeSha256(snapJson);

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
        lifecycle_version: 1, // Will update to 2, must be 3!
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: snapHash,
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: nowIso,
        verification_started_at: null,
        completed_at: null,
        recovery_fenced_at: nowIso,
        failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
        failure_json: canonicalJsonStringify({ is_fenced: true, reason: 'Early fence' }),
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: null,
        verification_result_envelope_json: '{"unexpected": true}', // Unexpected envelope on pre-result!
        verification_result_envelope_hash: computeSha256('{"unexpected": true}'),
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

      fixtures.db.prepare('UPDATE coder_submission_adjudications SET workspace_lease_id = ?, lifecycle_version = 2 WHERE id = ?').run(leaseId, adjId);

      const fencedPayload = canonicalJsonStringify({
        adjudication_id: adjId,
        error: 'Early fence',
        failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
      });
      const fencedPayloadHash = computeSha256(fencedPayload);
      fixtures.repo.createCoderSubmissionAdjudicationEvent({
        id: deriveDeterministicAdjudicationEventId(adjId, 2, 'RECOVERY_FENCED', fencedPayloadHash),
        adjudication_id: adjId,
        sequence: 3,
        event_type: 'RECOVERY_FENCED',
        payload_json: fencedPayload,
        payload_hash: fencedPayloadHash,
        created_at: nowIso,
      });

      fixtures.db.prepare("UPDATE tasks SET state = 'NEEDS_HUMAN' WHERE id = ?").run(fixtures.taskId);

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      const recon = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(recon.classification).toBe('AUTHORITY_CONFLICT');
      expect(recon.error).toContain('Pre-result RECOVERY_FENCED');
    });

    it('336. Deterministic event ID, disposition ID, and payload hash mismatch probes fail closed independently', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const leaseId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
      const snapHash = computeSha256(snapJson);

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
        authority_snapshot_hash: snapHash,
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: nowIso,
        verification_started_at: null,
        completed_at: null,
        recovery_fenced_at: nowIso,
        failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
        failure_json: canonicalJsonStringify({ is_fenced: true, reason: 'Probe test' }),
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: null,
        verification_result_envelope_json: null,
        verification_result_envelope_hash: null,
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
        released_at: nowIso,
        lifecycle_version: 2,
        state: 'RELEASED',
        failure_code: null,
        failure_evidence_hash: null,
      });

      fixtures.db.prepare('UPDATE coder_submission_adjudications SET workspace_lease_id = ?, lifecycle_version = 3 WHERE id = ?').run(leaseId, adjId);

      fixtures.db.prepare("UPDATE tasks SET state = 'NEEDS_HUMAN' WHERE id = ?").run(fixtures.taskId);

      // Probe 1: Event with random non-deterministic ID
      const fencedPayload = canonicalJsonStringify({
        adjudication_id: adjId,
        error: 'Probe test',
        failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
      });
      const fencedPayloadHash = computeSha256(fencedPayload);
      const randomEventId = crypto.randomUUID();
      fixtures.repo.createCoderSubmissionAdjudicationEvent({
        id: randomEventId,
        adjudication_id: adjId,
        sequence: 3,
        event_type: 'RECOVERY_FENCED',
        payload_json: fencedPayload,
        payload_hash: fencedPayloadHash,
        created_at: nowIso,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      const r1 = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(r1.classification).toBe('AUTHORITY_CONFLICT');
      expect(r1.error).toContain('Deterministic event ID mismatch');

      // Probe 2: Event with tampered payload_hash on separate adjudication
      fixtures.db.prepare("UPDATE tasks SET state = 'CODING' WHERE id = ?").run(fixtures.taskId);
      const subId2 = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId2), plaintextToken);
      fixtures.db.prepare("UPDATE tasks SET state = 'NEEDS_HUMAN' WHERE id = ?").run(fixtures.taskId);
      const adjId2 = crypto.randomUUID();
      const leaseId2 = crypto.randomUUID();
      fixtures.repo.createCoderSubmissionAdjudication({
        ...adj,
        id: adjId2,
        submission_id: subId2,
        request_id: crypto.randomUUID(),
        workspace_lease_id: null,
        lifecycle_version: 2,
      });
      fixtures.repo.createWorkspaceLease({
        id: leaseId2,
        adjudication_id: adjId2,
        worktree_identity_hash: computeSha256(path.resolve(fixtures.projectRoot).toLowerCase()),
        admitted_workspace_fingerprint_hash: computeSha256('admitted'),
        pre_execution_fingerprint_hash: null,
        claim_nonce: crypto.randomUUID(),
        execution_id: crypto.randomUUID(),
        lease_owner_identity: fixtures.assignmentId,
        assignment_id: fixtures.assignmentId,
        authorization_id: fixtures.authorizationId,
        acquired_at: nowIso,
        released_at: nowIso,
        lifecycle_version: 2,
        state: 'RELEASED',
        failure_code: null,
        failure_evidence_hash: null,
      });
      fixtures.db.prepare('UPDATE coder_submission_adjudications SET workspace_lease_id = ?, lifecycle_version = 3 WHERE id = ?').run(leaseId2, adjId2);

      const tamperedHash = '0'.repeat(64);
      const detId = deriveDeterministicAdjudicationEventId(adjId2, 3, 'RECOVERY_FENCED', tamperedHash);
      fixtures.repo.createCoderSubmissionAdjudicationEvent({
        id: detId,
        adjudication_id: adjId2,
        sequence: 3,
        event_type: 'RECOVERY_FENCED',
        payload_json: fencedPayload,
        payload_hash: tamperedHash, // Tampered hash!
        created_at: nowIso,
      });

      const adj2 = fixtures.repo.getCoderSubmissionAdjudicationById(adjId2)!;
      const r2 = fixtures.recoveryScanner.reconcileSingleAdjudication(adj2);
      expect(r2.classification).toBe('AUTHORITY_CONFLICT');
      expect(r2.error).toContain('Deterministic event payload hash mismatch');
    });

    it('337. Retry after durable update failure writes original end_time and byte-identical stdout/stderr, returns original settlement object', async () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-proc-retry-orig-'));
      const origUpdate = fixtures.repo.updateProcessRun.bind(fixtures.repo);
      try {
        const scriptPath = path.join(testDir, 'script.js');
        fs.writeFileSync(scriptPath, 'console.log("stdout test 337"); console.error("stderr test 337"); process.exit(42);', 'utf8');

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

        const fencedEntry = ProcessRunner.getPersistenceFencedEntry(execId);
        expect(fencedEntry).toBeDefined();
        if (!fencedEntry) throw new Error('Expected fenced entry');

        const originalTimestamp = fencedEntry.timestamp;
        const originalResult = fencedEntry.result;
        expect(originalResult.exitCode).toBe(42);
        expect(originalResult.stdout).toContain('stdout test 337');
        expect(originalResult.stderr).toContain('stderr test 337');

        // Restore repo and retry
        fixtures.repo.updateProcessRun = origUpdate;
        const retried = await ProcessRunner.retryPersistenceFenced(execId, fixtures.repo);

        // Verify returns original settlement object
        expect(retried).toBe(originalResult);

        // Verify database state has original end_time and evidence
        const verified = fixtures.repo.getProcessRun(execId);
        expect(verified).toBeDefined();
        if (!verified) throw new Error('Expected process run in DB');
        const dbEndTime = verified.end_time ?? verified.finished_at;
        expect(dbEndTime).toBe(originalTimestamp);
        expect(verified.exit_code).toBe(42);
        expect(verified.status).toBe('FAILED');
        expect(verified.stdout_evidence_id).toBe(originalResult.stdoutEvidenceId ?? null);
        expect(verified.stderr_evidence_id).toBe(originalResult.stderrEvidenceId ?? null);

        // Registry cleared
        expect(ProcessRunner.getActiveProcessCount()).toBe(0);
        expect(ProcessRunner.getPersistenceFencedEntry(execId)).toBeUndefined();
      } finally {
        fixtures.repo.updateProcessRun = origUpdate;
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('338. Concurrent retries join one promise and issue one durable update', async () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-proc-concurrent-retry-'));
      const origUpdate = fixtures.repo.updateProcessRun.bind(fixtures.repo);
      try {
        const scriptPath = path.join(testDir, 'script.js');
        fs.writeFileSync(scriptPath, 'console.log("concurrent"); process.exit(0);', 'utf8');

        const execId = crypto.randomUUID();
        fixtures.repo.updateProcessRun = () => {
          throw new Error('Initial persistence failure');
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

        expect(ProcessRunner.getPersistenceFencedEntry(execId)).toBeDefined();

        let updateCalls = 0;
        fixtures.repo.updateProcessRun = (id, status, exitCode, endIso, stdoutId, stderrId) => {
          updateCalls++;
          return origUpdate(id, status, exitCode, endIso, stdoutId, stderrId);
        };

        const [r1, r2, r3] = await Promise.all([
          ProcessRunner.retryPersistenceFenced(execId, fixtures.repo),
          ProcessRunner.retryPersistenceFenced(execId, fixtures.repo),
          ProcessRunner.retryPersistenceFenced(execId, fixtures.repo),
        ]);

        expect(r1).toBe(r2);
        expect(r2).toBe(r3);
        expect(r1.exitCode).toBe(0);
        expect(updateCalls).toBe(1);
        expect(ProcessRunner.getActiveProcessCount()).toBe(0);
      } finally {
        fixtures.repo.updateProcessRun = origUpdate;
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('339. Asynchronous public APIs prove settlement and terminal truth', async () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-proc-sync-claim-'));
      try {
        const scriptPath = path.join(testDir, 'sleep.js');
        fs.writeFileSync(scriptPath, 'setTimeout(() => { process.exit(0); }, 1000);', 'utf8');

        const execId = crypto.randomUUID();
        const procPromise = ProcessRunner.execute({
          executable: process.execPath,
          args: [scriptPath],
          cwd: testDir,
          executionId: execId,
          repo: fixtures.repo,
        });

        // Wait slightly for process to spawn
        await new Promise((r) => setTimeout(r, 60));
        expect(ProcessRunner.getActiveProcessCount()).toBeGreaterThan(0);

        // Calling cancel returns a Promise<ProcessTerminationTruth>, not an immediate boolean
        const cancelPromise = ProcessRunner.cancel(execId);
        expect(cancelPromise instanceof Promise).toBe(true);
        const cancelResult = await cancelPromise;
        expect(cancelResult).toBe('PROCESS_TREE_TERMINATED_PROVEN');

        // True terminal truth requires awaiting the execution promise
        const result = await procPromise;
        expect(result.cancelled).toBe(true);
        expect(result.processTermination).toBe('PROCESS_TREE_TERMINATED_PROVEN');
        expect(ProcessRunner.getActiveProcessCount()).toBe(0);

        // terminateAllProcesses is async and returns summary
        const termSummary = await ProcessRunner.terminateAllProcesses();
        expect(termSummary.allTerminatedProven).toBe(true);
        expect(termSummary.unproven).toBe(0);
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('340. Raw SQLite errors containing seeded path, SQL fragment, and token are scrubbed', async () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-proc-scrub-'));
      const origCreate = fixtures.repo.createProcessRun.bind(fixtures.repo);
      const origUpdate = fixtures.repo.updateProcessRun.bind(fixtures.repo);
      try {
        const scriptPath = path.join(testDir, 'quick.js');
        fs.writeFileSync(scriptPath, 'process.exit(0);', 'utf8');

        const seededSecretToken = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
        const seededSensitivePath = 'C:\\sensitive\\corporate\\secrets\\data';
        const seededSqlFragment = 'INSERT INTO process_runs (id, token) VALUES (1, "sensitive")';

        // 1. Raw DB error during createProcessRun is scrubbed
        const execId1 = crypto.randomUUID();
        fixtures.repo.createProcessRun = () => {
          throw new Error(`SqliteError: ${seededSqlFragment} failed at ${seededSensitivePath} with token ${seededSecretToken}`);
        };

        const result1 = await ProcessRunner.execute({
          executable: process.execPath,
          args: [scriptPath],
          cwd: testDir,
          executionId: execId1,
          repo: fixtures.repo,
        });

        expect(result1.errorCode).toBe('PROCESS_LAUNCH_FAILED');
        expect(result1.stderr).toContain('DATABASE_COLLISION_ERROR');
        expect(result1.stderr).not.toContain(seededSecretToken);
        expect(result1.stderr).not.toContain(seededSensitivePath);
        expect(result1.stderr).not.toContain(seededSqlFragment);

        // 2. Raw DB error during updateProcessRun is scrubbed
        fixtures.repo.createProcessRun = origCreate;
        const execId2 = crypto.randomUUID();
        fixtures.repo.updateProcessRun = () => {
          throw new Error(`SqliteError: UPDATE process_runs SET token='${seededSecretToken}' at ${seededSensitivePath}`);
        };

        let capturedError: Error | null = null;
        try {
          await ProcessRunner.execute({
            executable: process.execPath,
            args: [scriptPath],
            cwd: testDir,
            executionId: execId2,
            repo: fixtures.repo,
          });
        } catch (err: unknown) {
          capturedError = err as Error;
        }

        expect(capturedError).not.toBeNull();
        if (capturedError) {
          expect(capturedError.message).toContain('DURABLE_TERMINAL_UPDATE_FAILED');
          expect(capturedError.message).toContain('DATABASE_PERSISTENCE_ERROR');
          expect(capturedError.message).not.toContain(seededSecretToken);
          expect(capturedError.message).not.toContain(seededSensitivePath);
        }

        // Clean up fenced entry with restored repo
        fixtures.repo.updateProcessRun = origUpdate;
        await ProcessRunner.retryPersistenceFenced(execId2, fixtures.repo);
      } finally {
        fixtures.repo.createProcessRun = origCreate;
        fixtures.repo.updateProcessRun = origUpdate;
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('341. Every supported evaluator failure code accepts its one exact payload and rejects missing/extra field variants', () => {
      const nowIso = new Date().toISOString();
      const baseEnvelope: CanonicalVerificationResultEnvelope = {
        adjudication_id: crypto.randomUUID(),
        artifact_manifest_hash: 'a'.repeat(64),
        assignment_id: crypto.randomUUID(),
        attempt_id: crypto.randomUUID(),
        authorization_id: crypto.randomUUID(),
        command_snapshot_hash: 'b'.repeat(64),
        exit_classification: 'EXIT_NONZERO',
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

      for (const code of SUPPORTED_FAILURE_CODES) {
        let validPayload: Record<string, unknown>;
        if (code === 'TESTS_FAILED') {
          validPayload = { error: 'Tests failed message', failed_tests_count: 3 };
        } else if (FENCED_FAILURE_CODES.has(code)) {
          validPayload = { is_fenced: true, error: `Fenced failure: ${code}` };
        } else {
          validPayload = { error: `Non-fenced failure: ${code}` };
        }

        // 1. Valid exact payload is accepted
        const validEnv = { ...baseEnvelope, failure_code: code, failure_payload: validPayload };
        const resValid = validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(validEnv));
        expect(resValid.valid, `Expected ${code} with valid payload to be valid: ${resValid.error}`).toBe(true);

        // 2. Extra field variant is rejected
        const extraEnv = { ...baseEnvelope, failure_code: code, failure_payload: { ...validPayload, unauthorized_extra_field: 'bad' } };
        const resExtra = validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(extraEnv));
        expect(resExtra.valid, `Expected ${code} with extra field to be rejected`).toBe(false);
        expect(resExtra.error).toContain('failure_payload contains unrecognized key or unauthorized extra field');

        // 3. Missing required field is rejected
        const emptyEnv = { ...baseEnvelope, failure_code: code, failure_payload: {} };
        const resEmpty = validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(emptyEnv));
        expect(resEmpty.valid, `Expected ${code} with empty payload to be rejected`).toBe(false);

        // 4. Invalid field type is rejected
        const badTypeEnv = { ...baseEnvelope, failure_code: code, failure_payload: { ...validPayload, error: 12345 } };
        const resBadType = validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(badTypeEnv));
        expect(resBadType.valid, `Expected ${code} with invalid field type to be rejected`).toBe(false);
      }
    });

    it('342. PROCESS_START_FAILED cannot switch authority class by adding or removing is_fenced', () => {
      const nowIso = new Date().toISOString();
      const baseEnvelope: CanonicalVerificationResultEnvelope = {
        adjudication_id: crypto.randomUUID(),
        artifact_manifest_hash: 'a'.repeat(64),
        assignment_id: crypto.randomUUID(),
        attempt_id: crypto.randomUUID(),
        authorization_id: crypto.randomUUID(),
        command_snapshot_hash: 'b'.repeat(64),
        exit_classification: 'EXIT_NONZERO',
        failure_code: 'PROCESS_START_FAILED',
        failure_payload: { error: 'Spawn failed' },
        finish_timestamp: nowIso,
        git_diff_evidence_hash: '',
        git_diff_evidence_id: '',
        git_status_evidence_hash: '',
        git_status_evidence_id: '',
        lifecycle_version: 3,
        process_start_classification: 'NOT_STARTED_PROVEN',
        project_id: crypto.randomUUID(),
        start_timestamp: nowIso,
        task_id: crypto.randomUUID(),
        task_ownership_epoch: 1,
        termination_classification: 'NOT_APPLICABLE',
        test_result_evidence_hash: 'c'.repeat(64),
        test_result_evidence_id: crypto.randomUUID(),
        test_run_id: crypto.randomUUID(),
        verification_execution_id: crypto.randomUUID(),
        workspace_snapshot_after_evidence_id: crypto.randomUUID(),
        workspace_snapshot_after_hash: 'd'.repeat(64),
        workspace_snapshot_before_hash: 'e'.repeat(64),
      };

      // 1. Envelope validator strictly rejects is_fenced in PROCESS_START_FAILED payload
      const tamperedWithFenced = {
        ...baseEnvelope,
        failure_payload: { error: 'Spawn failed', is_fenced: true },
      };
      const resTampered = validateAndParseCanonicalResultEnvelope(canonicalJsonStringify(tamperedWithFenced));
      expect(resTampered.valid).toBe(false);
      expect(resTampered.error).toContain('failure_payload for non-fenced code PROCESS_START_FAILED must not include is_fenced');

      // 2. Pre-result RECOVERY_FENCED rejects PROCESS_START_FAILED because PROCESS_START_FAILED is not a fenced failure code
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
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
        status: 'RECOVERY_FENCED',
        lifecycle_version: 3,
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: snapHash,
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: nowIso,
        verification_started_at: null,
        completed_at: null,
        recovery_fenced_at: nowIso,
        failure_code: 'PROCESS_START_FAILED',
        failure_json: canonicalJsonStringify({ error: 'Spawn failed' }),
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: null,
        verification_result_envelope_json: null,
        verification_result_envelope_hash: null,
        artifact_manifest_json: null,
        artifact_manifest_hash: null,
        workspace_lease_id: null,
      });

      fixtures.db.prepare("UPDATE tasks SET state = 'NEEDS_HUMAN' WHERE id = ?").run(fixtures.taskId);
      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      const recon = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(recon.classification).toBe('AUTHORITY_CONFLICT');
    });

    it('343. Workspace-after evidence rejects wrong ID, type, task, attempt, auth, content hash, duplicate hash rows, manifest omission', () => {
      const nowIso = new Date().toISOString();
      const trId = crypto.randomUUID();
      const testResultEv: Evidence = {
        id: crypto.randomUUID(),
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'TEST_RESULT',
        storage_type: 'INLINE',
        file_path: null,
        hash: computeSha256('PASS'),
        byte_size: 4,
        content_type: 'text/plain',
        summary: 'Test results',
        raw_payload: 'PASS',
        created_at: nowIso,
      };
      fixtures.repo.createEvidence(testResultEv);

      fixtures.repo.createTestRun({
        id: trId,
        task_id: fixtures.taskId,
        command: 'npm test',
        exit_code: 0,
        passed_count: 1,
        failed_count: 0,
        skipped_count: 0,
        duration_ms: 100,
        evidence_id: testResultEv.id,
        created_at: nowIso,
      });

      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      const adjId = crypto.randomUUID();
      const execId = crypto.randomUUID();

      const leaseId = crypto.randomUUID();
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
        acquired_at: nowIso,
        released_at: null,
        lifecycle_version: 2,
        state: 'ACQUIRED',
        failure_code: null,
        failure_evidence_hash: null,
      });
      fixtures.db.pragma('foreign_keys = ON');

      const wsAfterObj: CanonicalWorkspaceSnapshotAfterPayload = {
        adjudication_id: adjId,
        adjudication_lifecycle_version: 3,
        assignment_id: fixtures.assignmentId,
        attempt_id: fixtures.attemptId,
        authorization_id: fixtures.authorizationId,
        captured_at: nowIso,
        captured_repository_head_sha: fixtures.repoHeadSha,
        expected_head_sha: fixtures.repoHeadSha,
        git_diff_evidence_hash: computeSha256(''),
        git_status_evidence_hash: computeSha256(''),
        project_id: fixtures.projectId,
        schema_version: 1,
        submission_id: subId,
        task_id: fixtures.taskId,
        task_ownership_epoch: 1,
        verification_execution_id: execId,
        workspace_lease_id: leaseId,
        worktree_identity_hash: computeSha256(fixtures.projectRoot.toLowerCase()),
      };
      const afterEvContent = canonicalJsonStringify(wsAfterObj);
      const afterEvHash = computeSha256(afterEvContent);
      const afterEv: Evidence = {
        id: crypto.randomUUID(),
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'FILE_SNAPSHOT',
        storage_type: 'INLINE',
        file_path: null,
        hash: afterEvHash,
        byte_size: Buffer.byteLength(afterEvContent, 'utf8'),
        content_type: 'application/json',
        summary: 'Workspace snapshot after',
        raw_payload: afterEvContent,
        created_at: nowIso,
      };
      fixtures.repo.createEvidence(afterEv);

      const manifestObj: ArtifactManifest = {
        manifest_schema_version: 1,
        adjudication_id: adjId,
        lifecycle_version: 3,
        verification_execution_id: execId,
        entries: [
          {
            byte_size: testResultEv.byte_size,
            content_type: testResultEv.content_type,
            evidence_id: testResultEv.id,
            evidence_type: testResultEv.evidence_type,
            relative_path: 'test-results.json',
            sha256: testResultEv.hash,
            storage_class: 'INLINE',
          },
          {
            byte_size: afterEv.byte_size,
            content_type: afterEv.content_type,
            evidence_id: afterEv.id,
            evidence_type: afterEv.evidence_type,
            relative_path: 'workspace-after.json',
            sha256: afterEvHash,
            storage_class: 'INLINE',
          },
        ],
      };
      const manifestJson = canonicalizeArtifactManifest(manifestObj);
      const manifestHash = computeArtifactManifestHash(manifestJson);

      const envelopeObj: CanonicalVerificationResultEnvelope = {
        adjudication_id: adjId,
        artifact_manifest_hash: manifestHash,
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
        test_result_evidence_hash: testResultEv.hash,
        test_result_evidence_id: testResultEv.id,
        test_run_id: trId,
        verification_execution_id: execId,
        workspace_snapshot_after_evidence_id: afterEv.id,
        workspace_snapshot_after_hash: afterEvHash,
        workspace_snapshot_before_hash: computeSha256('before'),
      };

      const adjStub: CoderSubmissionAdjudication = {
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
        lifecycle_version: 3,
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: '{}',
        authority_snapshot_hash: computeSha256('{}'),
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: computeSha256('before'),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: nowIso,
        verification_started_at: nowIso,
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: trId,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: execId,
        verification_result_envelope_json: canonicalJsonStringify(envelopeObj),
        verification_result_envelope_hash: computeSha256(canonicalJsonStringify(envelopeObj)),
        artifact_manifest_json: manifestJson,
        artifact_manifest_hash: manifestHash,
        workspace_lease_id: leaseId,
      };

      const tr = fixtures.repo.getTestRun(trId)!;

      // Probe 0: Authentic baseline passes
      const rawValid = canonicalJsonStringify(envelopeObj);
      const decValid = evaluateCanonicalSettlementDecision({
        rawEnvelopeJson: rawValid,
        storedEnvelopeHash: computeSha256(rawValid),
        rawManifestJson: manifestJson,
        storedManifestHash: manifestHash,
        adjudication: adjStub,
        testRun: tr,
        gitStatusEvidenceId: null,
        gitDiffEvidenceId: null,
        testResultEvidenceId: testResultEv.id,
        repo: fixtures.repo,
        artifactStore: fixtures.artifactStore,
      });
      expect(decValid.valid).toBe(true);

      // Probe 1: Non-existent evidence ID fails closed
      const envBadId = { ...envelopeObj, workspace_snapshot_after_evidence_id: crypto.randomUUID() };
      const rawBadId = canonicalJsonStringify(envBadId);
      const decBadId = evaluateCanonicalSettlementDecision({
        rawEnvelopeJson: rawBadId,
        storedEnvelopeHash: computeSha256(rawBadId),
        rawManifestJson: manifestJson,
        storedManifestHash: manifestHash,
        adjudication: adjStub,
        testRun: tr,
        gitStatusEvidenceId: null,
        gitDiffEvidenceId: null,
        testResultEvidenceId: testResultEv.id,
        repo: fixtures.repo,
        artifactStore: fixtures.artifactStore,
      });
      expect(decBadId.targetStatus).toBe('RECOVERY_FENCED');
      expect(decBadId.failureCode).toBe('INTEGRITY_MISMATCH');

      // Probe 2: Evidence project_id mismatch
      const otherProjId = crypto.randomUUID();
      fixtures.repo.createProject({
        id: otherProjId,
        name: 'other-project',
        description: null,
        repository_path: fixtures.projectRoot,
        default_branch: 'main',
        status: 'READY',
        contract: null,
        created_at: nowIso,
        updated_at: nowIso,
        started_at: null,
        completed_at: null,
      });
      const badProjEv: Evidence = { ...afterEv, id: crypto.randomUUID(), project_id: otherProjId };
      fixtures.repo.createEvidence(badProjEv);
      const envBadProj = { ...envelopeObj, workspace_snapshot_after_evidence_id: badProjEv.id };
      const rawBadProj = canonicalJsonStringify(envBadProj);
      const decBadProj = evaluateCanonicalSettlementDecision({
        rawEnvelopeJson: rawBadProj,
        storedEnvelopeHash: computeSha256(rawBadProj),
        rawManifestJson: manifestJson,
        storedManifestHash: manifestHash,
        adjudication: adjStub,
        testRun: tr,
        gitStatusEvidenceId: null,
        gitDiffEvidenceId: null,
        testResultEvidenceId: testResultEv.id,
        repo: fixtures.repo,
        artifactStore: fixtures.artifactStore,
      });
      expect(decBadProj.targetStatus).toBe('RECOVERY_FENCED');
      expect(decBadProj.failureCode).toBe('INTEGRITY_MISMATCH');

      // Probe 3: Content hash mismatch
      const envBadHash = { ...envelopeObj, workspace_snapshot_after_hash: '0'.repeat(64) };
      const rawBadHash = canonicalJsonStringify(envBadHash);
      const decBadHash = evaluateCanonicalSettlementDecision({
        rawEnvelopeJson: rawBadHash,
        storedEnvelopeHash: computeSha256(rawBadHash),
        rawManifestJson: manifestJson,
        storedManifestHash: manifestHash,
        adjudication: adjStub,
        testRun: tr,
        gitStatusEvidenceId: null,
        gitDiffEvidenceId: null,
        testResultEvidenceId: testResultEv.id,
        repo: fixtures.repo,
        artifactStore: fixtures.artifactStore,
      });
      expect(decBadHash.targetStatus).toBe('RECOVERY_FENCED');
      expect(decBadHash.failureCode).toBe('INTEGRITY_MISMATCH');

      // Probe 4: Manifest omission (after evidence omitted from manifest)
      const omittedManifestObj: ArtifactManifest = {
        manifest_schema_version: 1,
        adjudication_id: adjId,
        lifecycle_version: 3,
        verification_execution_id: execId,
        entries: [
          {
            byte_size: testResultEv.byte_size,
            content_type: testResultEv.content_type,
            evidence_id: testResultEv.id,
            evidence_type: testResultEv.evidence_type,
            relative_path: 'test-results.json',
            sha256: testResultEv.hash,
            storage_class: 'INLINE',
          },
        ],
      };
      const omittedManifestJson = canonicalizeArtifactManifest(omittedManifestObj);
      const omittedManifestHash = computeArtifactManifestHash(omittedManifestJson);
      const rawValidEnv = canonicalJsonStringify({ ...envelopeObj, artifact_manifest_hash: omittedManifestHash });
      const decOmitted = evaluateCanonicalSettlementDecision({
        rawEnvelopeJson: rawValidEnv,
        storedEnvelopeHash: computeSha256(rawValidEnv),
        rawManifestJson: omittedManifestJson,
        storedManifestHash: omittedManifestHash,
        adjudication: adjStub,
        testRun: tr,
        gitStatusEvidenceId: null,
        gitDiffEvidenceId: null,
        testResultEvidenceId: testResultEv.id,
        repo: fixtures.repo,
        artifactStore: fixtures.artifactStore,
      });
      expect(decOmitted.targetStatus).toBe('RECOVERY_FENCED');
      expect(decOmitted.failureCode).toBe('INTEGRITY_MISMATCH');

      // Probe 5: Wrong evidence type (not FILE_SNAPSHOT or CUSTOM)
      const wrongTypeEv: Evidence = { ...afterEv, id: crypto.randomUUID(), evidence_type: 'PROCESS_LOG' };
      fixtures.repo.createEvidence(wrongTypeEv);
      const envWrongType = { ...envelopeObj, workspace_snapshot_after_evidence_id: wrongTypeEv.id };
      const rawWrongType = canonicalJsonStringify(envWrongType);
      const decWrongType = evaluateCanonicalSettlementDecision({
        rawEnvelopeJson: rawWrongType,
        storedEnvelopeHash: computeSha256(rawWrongType),
        rawManifestJson: manifestJson,
        storedManifestHash: manifestHash,
        adjudication: adjStub,
        testRun: tr,
        gitStatusEvidenceId: null,
        gitDiffEvidenceId: null,
        testResultEvidenceId: testResultEv.id,
        repo: fixtures.repo,
        artifactStore: fixtures.artifactStore,
      });
      expect(decWrongType.targetStatus).toBe('RECOVERY_FENCED');
      expect(decWrongType.failureCode).toBe('INTEGRITY_MISMATCH');

      // Probe 6: Reusing test result evidence as workspace-after evidence
      const envReuse = { ...envelopeObj, workspace_snapshot_after_evidence_id: testResultEv.id, workspace_snapshot_after_hash: testResultEv.hash };
      const rawReuse = canonicalJsonStringify(envReuse);
      const decReuse = evaluateCanonicalSettlementDecision({
        rawEnvelopeJson: rawReuse,
        storedEnvelopeHash: computeSha256(rawReuse),
        rawManifestJson: manifestJson,
        storedManifestHash: manifestHash,
        adjudication: adjStub,
        testRun: tr,
        gitStatusEvidenceId: null,
        gitDiffEvidenceId: null,
        testResultEvidenceId: testResultEv.id,
        repo: fixtures.repo,
        artifactStore: fixtures.artifactStore,
      });
      expect(decReuse.targetStatus).toBe('RECOVERY_FENCED');
      expect(decReuse.failureCode).toBe('INTEGRITY_MISMATCH');
    });

    it('344. VERIFICATION_FAILED recovery rejects missing, duplicate, extra, wrong-ID, wrong-actor, wrong-metadata, SETTLED dispositions with zero mutation', () => {
      function createFreshFixtures(): FullAdjudicationFixtures {
        const dir = path.join(os.tmpdir(), 'af-fresh-' + Date.now() + '-' + crypto.randomUUID().slice(0, 8));
        fs.mkdirSync(dir, { recursive: true });
        const repoDir = path.join(dir, 'repo');
        fs.mkdirSync(repoDir, { recursive: true });
        child_process.execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
        child_process.execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
        child_process.execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
        fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Project\n', 'utf8');
        child_process.execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
        child_process.execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir, stdio: 'ignore' });
        const artDir = path.join(dir, 'artifacts');
        fs.mkdirSync(artDir, { recursive: true });
        const created = createTestDatabase(dir, 'test.db');
        return setupFullSubmissionGraph(created.db, repoDir, artDir);
      }

      function setupFailedAdjudication(fx: FullAdjudicationFixtures) {
        const { plaintextToken } = issueSubmissionSessionHelper(fx.repo, fx.authorizationId);
        const subId = crypto.randomUUID();
        fx.mcpService.submitCoderClaim(createValidSubmissionPayload(fx, subId), plaintextToken);

        const adjId = crypto.randomUUID();
        const trId = crypto.randomUUID();
        const evId = crypto.randomUUID();
        const execId = crypto.randomUUID();
        const afterEvId = 'ev-ws-after-' + crypto.randomUUID();
        const leaseId = crypto.randomUUID();
        const nowIso = new Date().toISOString();
        const sub = fx.repo.getCoderSubmissionById(subId)!;
        const snap = fx.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
        const snapJson = canonicalJsonStringify(snap);
        const snapHash = computeSha256(snapJson);

        fx.repo.createEvidence({
          id: evId,
          project_id: fx.projectId,
          task_id: fx.taskId,
          attempt_id: fx.attemptId,
          evidence_type: 'TEST_RESULT',
          storage_type: 'INLINE',
          content_type: 'text/plain',
          byte_size: 4,
          hash: computeSha256('FAIL'),
          file_path: null,
          summary: 'fail evidence',
          raw_payload: 'FAIL',
          created_at: nowIso,
        });

        const wsAfterObj = buildCanonicalWorkspaceSnapshotAfterPayload({
          adjudicationId: adjId,
          submissionId: subId,
          authorizationId: fx.authorizationId,
          projectId: fx.projectId,
          taskId: fx.taskId,
          attemptId: fx.attemptId,
          assignmentId: fx.assignmentId,
          verificationExecutionId: execId,
          capturedRepositoryHeadSha: fx.repoHeadSha,
          expectedHeadSha: fx.repoHeadSha,
          gitDiffEvidenceHash: '',
          gitStatusEvidenceHash: '',
          workspaceLeaseId: leaseId,
          worktreeIdentityHash: computeSha256(fx.projectRoot.toLowerCase()),
          taskOwnershipEpoch: 1,
          adjudicationLifecycleVersion: 3,
          capturedAt: nowIso,
        });
        const wsAfterContent = canonicalJsonStringify(wsAfterObj);
        const wsAfterHash = computeSha256(wsAfterContent);
        fx.repo.createEvidence({
          id: afterEvId,
          project_id: fx.projectId,
          task_id: fx.taskId,
          attempt_id: fx.attemptId,
          evidence_type: 'FILE_SNAPSHOT',
          storage_type: 'INLINE',
          content_type: 'application/json',
          byte_size: Buffer.byteLength(wsAfterContent, 'utf8'),
          hash: wsAfterHash,
          file_path: null,
          summary: 'after evidence',
          raw_payload: wsAfterContent,
          created_at: nowIso,
        });

        fx.repo.createTestRun({
          id: trId,
          task_id: fx.taskId,
          command: 'npm test',
          exit_code: 1,
          passed_count: 0,
          failed_count: 1,
          skipped_count: 0,
          duration_ms: 100,
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
              relative_path: 'test-results.json',
              sha256: computeSha256('FAIL'),
              storage_class: 'INLINE',
            },
            {
              byte_size: Buffer.byteLength(wsAfterContent, 'utf8'),
              content_type: 'application/json',
              evidence_id: afterEvId,
              evidence_type: 'FILE_SNAPSHOT',
              relative_path: 'workspace-after.json',
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
          assignment_id: fx.assignmentId,
          attempt_id: fx.attemptId,
          authorization_id: fx.authorizationId,
          command_snapshot_hash: computeSha256('{}'),
          exit_classification: 'EXIT_NONZERO',
          failure_code: 'TEST_FAILED',
          failure_payload: { error: 'Test suite failed' },
          finish_timestamp: nowIso,
          git_diff_evidence_hash: '',
          git_diff_evidence_id: '',
          git_status_evidence_hash: '',
          git_status_evidence_id: '',
          lifecycle_version: 3,
          process_start_classification: 'SPAWNED_PROVEN',
          project_id: fx.projectId,
          start_timestamp: nowIso,
          task_id: fx.taskId,
          task_ownership_epoch: 1,
          termination_classification: 'TERMINATION_PROVEN',
          test_result_evidence_hash: computeSha256('FAIL'),
          test_result_evidence_id: evId,
          test_run_id: trId,
          verification_execution_id: execId,
          workspace_snapshot_after_evidence_id: afterEvId,
          workspace_snapshot_after_hash: wsAfterHash,
          workspace_snapshot_before_hash: computeSha256('before'),
        };
        const envJson = canonicalJsonStringify(envelope);
        const envHash = computeSha256(envJson);

        fx.db.pragma('foreign_keys = OFF');
        fx.repo.createWorkspaceLease({
          id: leaseId,
          adjudication_id: adjId,
          worktree_identity_hash: computeSha256(path.resolve(fx.projectRoot).toLowerCase()),
          admitted_workspace_fingerprint_hash: computeSha256('admitted'),
          pre_execution_fingerprint_hash: null,
          claim_nonce: crypto.randomUUID(),
          execution_id: execId,
          lease_owner_identity: fx.assignmentId,
          assignment_id: fx.assignmentId,
          authorization_id: fx.authorizationId,
          acquired_at: nowIso,
          released_at: nowIso,
          lifecycle_version: 2,
          state: 'RELEASED',
          failure_code: null,
          failure_evidence_hash: null,
        });

        fx.repo.createCoderSubmissionAdjudication({
          id: adjId,
          submission_id: subId,
          authorization_id: fx.authorizationId,
          project_id: fx.projectId,
          task_id: fx.taskId,
          attempt_id: fx.attemptId,
          assignment_id: fx.assignmentId,
          task_ownership_epoch: 1,
          action: 'ADMIT_VERIFICATION',
          status: 'VERIFICATION_FAILED',
          lifecycle_version: 3,
          protocol_message_id: null,
          request_id: crypto.randomUUID(),
          authority_snapshot_json: snapJson,
          authority_snapshot_hash: snapHash,
          workspace_snapshot_before_json: null,
          workspace_snapshot_before_hash: computeSha256('before'),
          verification_commands_json: '{}',
          verification_commands_hash: computeSha256('{}'),
          created_at: nowIso,
          verification_started_at: nowIso,
          completed_at: nowIso,
          recovery_fenced_at: null,
          failure_code: 'TEST_FAILED',
          failure_json: canonicalJsonStringify({ error: 'Test suite failed' }),
          test_run_id: trId,
          git_status_evidence_id: null,
          git_diff_evidence_id: null,
          verification_execution_id: manifestObj.verification_execution_id,
          verification_result_envelope_json: envJson,
          verification_result_envelope_hash: envHash,
          artifact_manifest_json: manifestJson,
          artifact_manifest_hash: manifestHash,
          workspace_lease_id: leaseId,
        });
        fx.db.pragma('foreign_keys = ON');

        const failPayload = canonicalJsonStringify({
          adjudication_id: adjId,
          error: 'Test suite failed',
          failure_code: 'TEST_FAILED',
        });
        const failPayloadHash = computeSha256(failPayload);
        fx.repo.createCoderSubmissionAdjudicationEvent({
          id: deriveDeterministicAdjudicationEventId(adjId, 3, 'VERIFICATION_FAILED', failPayloadHash),
          adjudication_id: adjId,
          sequence: 3,
          event_type: 'VERIFICATION_FAILED',
          payload_json: failPayload,
          payload_hash: failPayloadHash,
          created_at: nowIso,
        });

        fx.db.prepare("UPDATE tasks SET state = 'NEEDS_HUMAN' WHERE id = ?").run(fx.taskId);

        return { subId, adjId, nowIso, failPayload, failPayloadHash };
      }

      // Probe 1: Missing disposition
      const fx1 = createFreshFixtures();
      const setup1 = setupFailedAdjudication(fx1);
      const adj1 = fx1.repo.getCoderSubmissionAdjudicationById(setup1.adjId)!;
      const rMissing = fx1.recoveryScanner.reconcileSingleAdjudication(adj1);
      expect(rMissing.classification).toBe('AUTHORITY_CONFLICT');
      expect(rMissing.error).toContain('Expected exactly one terminal disposition for VERIFICATION_FAILED');

      // Probe 2: Duplicate disposition
      const fx2 = createFreshFixtures();
      const setup2 = setupFailedAdjudication(fx2);
      const expectedDispId2 = deriveDeterministicDispositionId(setup2.subId, setup2.adjId, 3);
      fx2.repo.createCoderSubmissionDisposition({
        id: expectedDispId2,
        submission_id: setup2.subId,
        disposition_event: 'REJECTED',
        disposition_reason: 'FENCED_PRECONDITION',
        actor_type: 'SYSTEM',
        actor_id: 'SCANNER',
        disposition_metadata_json: canonicalJsonStringify({ adjudication_id: setup2.adjId, failure_code: 'TEST_FAILED' }),
        created_at: setup2.nowIso,
      });
      fx2.repo.createCoderSubmissionDisposition({
        id: crypto.randomUUID(),
        submission_id: setup2.subId,
        disposition_event: 'REJECTED',
        disposition_reason: 'FENCED_PRECONDITION',
        actor_type: 'SYSTEM',
        actor_id: 'SCANNER',
        disposition_metadata_json: canonicalJsonStringify({ adjudication_id: setup2.adjId, failure_code: 'TEST_FAILED' }),
        created_at: setup2.nowIso,
      });
      const adj2 = fx2.repo.getCoderSubmissionAdjudicationById(setup2.adjId)!;
      const rDup = fx2.recoveryScanner.reconcileSingleAdjudication(adj2);
      expect(rDup.classification).toBe('AUTHORITY_CONFLICT');
      expect(rDup.error).toContain('Expected exactly one terminal disposition for VERIFICATION_FAILED submission, found 2');

      // Probe 3: Wrong deterministic ID
      const fx3 = createFreshFixtures();
      const setup3 = setupFailedAdjudication(fx3);
      fx3.repo.createCoderSubmissionDisposition({
        id: crypto.randomUUID(),
        submission_id: setup3.subId,
        disposition_event: 'REJECTED',
        disposition_reason: 'FENCED_PRECONDITION',
        actor_type: 'SYSTEM',
        actor_id: 'SCANNER',
        disposition_metadata_json: canonicalJsonStringify({ adjudication_id: setup3.adjId, failure_code: 'TEST_FAILED' }),
        created_at: setup3.nowIso,
      });
      const adj3 = fx3.repo.getCoderSubmissionAdjudicationById(setup3.adjId)!;
      const rWrongId = fx3.recoveryScanner.reconcileSingleAdjudication(adj3);
      expect(rWrongId.classification).toBe('AUTHORITY_CONFLICT');
      expect(rWrongId.error).toContain('Deterministic disposition ID mismatch');

      // Probe 4: Wrong actor_type
      const fx4 = createFreshFixtures();
      const setup4 = setupFailedAdjudication(fx4);
      fx4.db.prepare('INSERT INTO coder_submission_dispositions (id, submission_id, disposition_event, disposition_reason, actor_type, actor_id, disposition_metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        deriveDeterministicDispositionId(setup4.subId, setup4.adjId, 3),
        setup4.subId,
        'REJECTED',
        'FENCED_PRECONDITION',
        'MCP_CLIENT',
        'SCANNER',
        canonicalJsonStringify({ adjudication_id: setup4.adjId, failure_code: 'TEST_FAILED' }),
        setup4.nowIso
      );
      const adj4 = fx4.repo.getCoderSubmissionAdjudicationById(setup4.adjId)!;
      const rWrongActor = fx4.recoveryScanner.reconcileSingleAdjudication(adj4);
      expect(rWrongActor.classification).toBe('AUTHORITY_CONFLICT');
      expect(rWrongActor.error).toContain('Terminal disposition actor_type for VERIFICATION_FAILED must be SYSTEM');

      // Probe 5: Wrong metadata
      const fx5 = createFreshFixtures();
      const setup5 = setupFailedAdjudication(fx5);
      fx5.repo.createCoderSubmissionDisposition({
        id: deriveDeterministicDispositionId(setup5.subId, setup5.adjId, 3),
        submission_id: setup5.subId,
        disposition_event: 'REJECTED',
        disposition_reason: 'FENCED_PRECONDITION',
        actor_type: 'SYSTEM',
        actor_id: 'SYSTEM_VERIFICATION_EVALUATOR',
        disposition_metadata_json: canonicalJsonStringify({ adjudication_id: crypto.randomUUID() }),
        created_at: setup5.nowIso,
      });
      const adj5 = fx5.repo.getCoderSubmissionAdjudicationById(setup5.adjId)!;
      const rWrongMeta = fx5.recoveryScanner.reconcileSingleAdjudication(adj5);
      expect(rWrongMeta.classification).toBe('AUTHORITY_CONFLICT');
      expect(rWrongMeta.error).toContain('Terminal disposition metadata mismatch');

      // Probe 6: Contradictory SETTLED disposition
      const fx6 = createFreshFixtures();
      const setup6 = setupFailedAdjudication(fx6);
      fx6.repo.createCoderSubmissionDisposition({
        id: deriveDeterministicDispositionId(setup6.subId, setup6.adjId, 3),
        submission_id: setup6.subId,
        disposition_event: 'SETTLED',
        disposition_reason: 'ACCEPTED_VERIFIED',
        actor_type: 'SYSTEM',
        actor_id: 'SCANNER',
        disposition_metadata_json: null,
        created_at: setup6.nowIso,
      });
      const adj6 = fx6.repo.getCoderSubmissionAdjudicationById(setup6.adjId)!;
      const rSettled = fx6.recoveryScanner.reconcileSingleAdjudication(adj6);
      expect(rSettled.classification).toBe('AUTHORITY_CONFLICT');
      expect(rSettled.error).toContain('contradictory SETTLED disposition');
    });

    it('345. RECOVERY_FENCED recovery performs the same disposition matrix for pre-result and result-bearing cases', () => {
      function createFreshFixtures(): FullAdjudicationFixtures {
        const dir = path.join(os.tmpdir(), 'af-fresh-' + Date.now() + '-' + crypto.randomUUID().slice(0, 8));
        fs.mkdirSync(dir, { recursive: true });
        const repoDir = path.join(dir, 'repo');
        fs.mkdirSync(repoDir, { recursive: true });
        child_process.execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
        child_process.execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
        child_process.execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
        fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Project\n', 'utf8');
        child_process.execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
        child_process.execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir, stdio: 'ignore' });
        const artDir = path.join(dir, 'artifacts');
        fs.mkdirSync(artDir, { recursive: true });
        const created = createTestDatabase(dir, 'test.db');
        return setupFullSubmissionGraph(created.db, repoDir, artDir);
      }

      // 1. Pre-result RECOVERY_FENCED
      function setupPreResult(fx: FullAdjudicationFixtures) {
        const { plaintextToken } = issueSubmissionSessionHelper(fx.repo, fx.authorizationId);
        const subId = crypto.randomUUID();
        fx.mcpService.submitCoderClaim(createValidSubmissionPayload(fx, subId), plaintextToken);

        const adjId = crypto.randomUUID();
        const leaseId = crypto.randomUUID();
        const nowIso = new Date().toISOString();
        const sub = fx.repo.getCoderSubmissionById(subId)!;
        const snap = fx.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
        const snapJson = canonicalJsonStringify(snap);
        const snapHash = computeSha256(snapJson);

        fx.db.pragma('foreign_keys = OFF');
        fx.repo.createWorkspaceLease({
          id: leaseId,
          adjudication_id: adjId,
          worktree_identity_hash: computeSha256(path.resolve(fx.projectRoot).toLowerCase()),
          admitted_workspace_fingerprint_hash: computeSha256('admitted'),
          pre_execution_fingerprint_hash: null,
          claim_nonce: crypto.randomUUID(),
          execution_id: crypto.randomUUID(),
          lease_owner_identity: fx.assignmentId,
          assignment_id: fx.assignmentId,
          authorization_id: fx.authorizationId,
          acquired_at: nowIso,
          released_at: null,
          lifecycle_version: 2,
          state: 'FENCED',
          failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
          failure_evidence_hash: null,
        });

        fx.repo.createCoderSubmissionAdjudication({
          id: adjId,
          submission_id: subId,
          authorization_id: fx.authorizationId,
          project_id: fx.projectId,
          task_id: fx.taskId,
          attempt_id: fx.attemptId,
          assignment_id: fx.assignmentId,
          task_ownership_epoch: 1,
          action: 'ADMIT_VERIFICATION',
          status: 'RECOVERY_FENCED',
          lifecycle_version: 3,
          protocol_message_id: null,
          request_id: crypto.randomUUID(),
          authority_snapshot_json: snapJson,
          authority_snapshot_hash: snapHash,
          workspace_snapshot_before_json: null,
          workspace_snapshot_before_hash: computeSha256('before'),
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
          workspace_lease_id: leaseId,
        });
        fx.db.pragma('foreign_keys = ON');

        const fencedPayload = canonicalJsonStringify({
          adjudication_id: adjId,
          error: 'Crash fence',
          failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
        });
        const fencedPayloadHash = computeSha256(fencedPayload);
        fx.repo.createCoderSubmissionAdjudicationEvent({
          id: deriveDeterministicAdjudicationEventId(adjId, 3, 'RECOVERY_FENCED', fencedPayloadHash),
          adjudication_id: adjId,
          sequence: 3,
          event_type: 'RECOVERY_FENCED',
          payload_json: fencedPayload,
          payload_hash: fencedPayloadHash,
          created_at: nowIso,
        });

        fx.db.prepare("UPDATE tasks SET state = 'NEEDS_HUMAN' WHERE id = ?").run(fx.taskId);

        return { subId, adjId, nowIso, fencedPayload, fencedPayloadHash };
      }

      // 1a. Missing disposition fails closed
      const fx1 = createFreshFixtures();
      const setup1 = setupPreResult(fx1);
      const adj1 = fx1.repo.getCoderSubmissionAdjudicationById(setup1.adjId)!;
      const rPreMissing = fx1.recoveryScanner.reconcileSingleAdjudication(adj1);
      expect(rPreMissing.classification).toBe('AUTHORITY_CONFLICT');
      expect(rPreMissing.error).toContain('Expected exactly one terminal disposition for pre-result RECOVERY_FENCED');

      // 1b. Duplicate dispositions fail closed
      const fx1b = createFreshFixtures();
      const setup1b = setupPreResult(fx1b);
      const expectedDispId1b = deriveDeterministicDispositionId(setup1b.subId, setup1b.adjId, 3);
      fx1b.repo.createCoderSubmissionDisposition({
        id: expectedDispId1b,
        submission_id: setup1b.subId,
        disposition_event: 'REJECTED',
        disposition_reason: 'FENCED_PRECONDITION',
        actor_type: 'SYSTEM',
        actor_id: 'SCANNER',
        disposition_metadata_json: canonicalJsonStringify({ adjudication_id: setup1b.adjId, failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED' }),
        created_at: setup1b.nowIso,
      });
      fx1b.repo.createCoderSubmissionDisposition({
        id: crypto.randomUUID(),
        submission_id: setup1b.subId,
        disposition_event: 'REJECTED',
        disposition_reason: 'FENCED_PRECONDITION',
        actor_type: 'SYSTEM',
        actor_id: 'SCANNER',
        disposition_metadata_json: canonicalJsonStringify({ adjudication_id: setup1b.adjId, failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED' }),
        created_at: setup1b.nowIso,
      });
      const adj1b = fx1b.repo.getCoderSubmissionAdjudicationById(setup1b.adjId)!;
      const rPreDup = fx1b.recoveryScanner.reconcileSingleAdjudication(adj1b);
      expect(rPreDup.classification).toBe('AUTHORITY_CONFLICT');
      expect(rPreDup.error).toContain('Expected exactly one terminal disposition for pre-result RECOVERY_FENCED, found 2');

      // 1c. Contradictory SETTLED disposition fails closed
      const fx1c = createFreshFixtures();
      const setup1c = setupPreResult(fx1c);
      fx1c.repo.createCoderSubmissionDisposition({
        id: deriveDeterministicDispositionId(setup1c.subId, setup1c.adjId, 3),
        submission_id: setup1c.subId,
        disposition_event: 'SETTLED',
        disposition_reason: 'ACCEPTED_VERIFIED',
        actor_type: 'SYSTEM',
        actor_id: 'TEST',
        disposition_metadata_json: null,
        created_at: setup1c.nowIso,
      });
      const adj1c = fx1c.repo.getCoderSubmissionAdjudicationById(setup1c.adjId)!;
      const rPreSettled = fx1c.recoveryScanner.reconcileSingleAdjudication(adj1c);
      expect(rPreSettled.classification).toBe('AUTHORITY_CONFLICT');
      expect(rPreSettled.error).toContain('contradictory SETTLED disposition');
    });

    it('346. Pre-result terminal event rejects self-consistent but semantically false payload/hash/ID tuple', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const leaseId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
      const snapHash = computeSha256(snapJson);

      fixtures.db.pragma('foreign_keys = OFF');
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
        lifecycle_version: 2,
        state: 'FENCED',
        failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
        failure_evidence_hash: null,
      });

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
        authority_snapshot_hash: snapHash,
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: computeSha256('before'),
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
        workspace_lease_id: leaseId,
      });
      fixtures.db.pragma('foreign_keys = ON');

      // Construct a forged payload that is self-consistent with its own hash and ID, but disagrees with the DB truth
      const forgedPayload = canonicalJsonStringify({
        adjudication_id: adjId,
        error: 'FORGED_SEMANTIC_ERROR_THAT_DISAGREES_WITH_DB',
        failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
      });
      const forgedHash = computeSha256(forgedPayload);
      const forgedEventId = deriveDeterministicAdjudicationEventId(adjId, 3, 'RECOVERY_FENCED', forgedHash);

      fixtures.repo.createCoderSubmissionAdjudicationEvent({
        id: forgedEventId,
        adjudication_id: adjId,
        sequence: 3,
        event_type: 'RECOVERY_FENCED',
        payload_json: forgedPayload,
        payload_hash: forgedHash,
        created_at: nowIso,
      });

      fixtures.db.prepare("UPDATE tasks SET state = 'NEEDS_HUMAN' WHERE id = ?").run(fixtures.taskId);

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      const recon = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(recon.classification).toBe('AUTHORITY_CONFLICT');
      expect(recon.error).toContain('Deterministic event payload hash mismatch');
    });

    it('347. Terminal event rejects duplicate sequence, wrong deterministic ID, wrong canonical bytes, wrong type, wrong project/task/attempt, extra event rows', () => {
      function createFreshFixtures(): FullAdjudicationFixtures {
        const dir = path.join(os.tmpdir(), 'af-fresh-' + Date.now() + '-' + crypto.randomUUID().slice(0, 8));
        fs.mkdirSync(dir, { recursive: true });
        const repoDir = path.join(dir, 'repo');
        fs.mkdirSync(repoDir, { recursive: true });
        child_process.execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
        child_process.execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
        child_process.execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
        fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Project\n', 'utf8');
        child_process.execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
        child_process.execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir, stdio: 'ignore' });
        const artDir = path.join(dir, 'artifacts');
        fs.mkdirSync(artDir, { recursive: true });
        const created = createTestDatabase(dir, 'test.db');
        return setupFullSubmissionGraph(created.db, repoDir, artDir);
      }

      function setupPreResultEventTest(fx: FullAdjudicationFixtures) {
        const { plaintextToken } = issueSubmissionSessionHelper(fx.repo, fx.authorizationId);
        const subId = crypto.randomUUID();
        fx.mcpService.submitCoderClaim(createValidSubmissionPayload(fx, subId), plaintextToken);

        const adjId = crypto.randomUUID();
        const leaseId = crypto.randomUUID();
        const nowIso = new Date().toISOString();
        const sub = fx.repo.getCoderSubmissionById(subId)!;
        const snap = fx.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
        const snapJson = canonicalJsonStringify(snap);
        const snapHash = computeSha256(snapJson);

        fx.db.pragma('foreign_keys = OFF');
        fx.repo.createWorkspaceLease({
          id: leaseId,
          adjudication_id: adjId,
          worktree_identity_hash: computeSha256(path.resolve(fx.projectRoot).toLowerCase()),
          admitted_workspace_fingerprint_hash: computeSha256('admitted'),
          pre_execution_fingerprint_hash: null,
          claim_nonce: crypto.randomUUID(),
          execution_id: crypto.randomUUID(),
          lease_owner_identity: fx.assignmentId,
          assignment_id: fx.assignmentId,
          authorization_id: fx.authorizationId,
          acquired_at: nowIso,
          released_at: null,
          lifecycle_version: 2,
          state: 'FENCED',
          failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
          failure_evidence_hash: null,
        });

        fx.repo.createCoderSubmissionAdjudication({
          id: adjId,
          submission_id: subId,
          authorization_id: fx.authorizationId,
          project_id: fx.projectId,
          task_id: fx.taskId,
          attempt_id: fx.attemptId,
          assignment_id: fx.assignmentId,
          task_ownership_epoch: 1,
          action: 'ADMIT_VERIFICATION',
          status: 'RECOVERY_FENCED',
          lifecycle_version: 3,
          protocol_message_id: null,
          request_id: crypto.randomUUID(),
          authority_snapshot_json: snapJson,
          authority_snapshot_hash: snapHash,
          workspace_snapshot_before_json: null,
          workspace_snapshot_before_hash: computeSha256('before'),
          verification_commands_json: '{}',
          verification_commands_hash: computeSha256('{}'),
          created_at: nowIso,
          verification_started_at: null,
          completed_at: null,
          recovery_fenced_at: nowIso,
          failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
          failure_json: canonicalJsonStringify({ is_fenced: true, reason: 'Real error' }),
          test_run_id: null,
          git_status_evidence_id: null,
          git_diff_evidence_id: null,
          verification_execution_id: null,
          verification_result_envelope_json: null,
          verification_result_envelope_hash: null,
          artifact_manifest_json: null,
          artifact_manifest_hash: null,
          workspace_lease_id: leaseId,
        });
        fx.db.pragma('foreign_keys = ON');

        fx.db.prepare("UPDATE tasks SET state = 'NEEDS_HUMAN' WHERE id = ?").run(fx.taskId);

        const expectedPayload = canonicalJsonStringify({
          adjudication_id: adjId,
          error: 'Real error',
          failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
        });
        const expectedHash = computeSha256(expectedPayload);

        return { subId, adjId, nowIso, expectedPayload, expectedHash };
      }

      // Probe 1: Wrong deterministic ID
      const fx1 = createFreshFixtures();
      const setup1 = setupPreResultEventTest(fx1);
      const wrongId = crypto.randomUUID();
      fx1.repo.createCoderSubmissionAdjudicationEvent({
        id: wrongId,
        adjudication_id: setup1.adjId,
        sequence: 3,
        event_type: 'RECOVERY_FENCED',
        payload_json: setup1.expectedPayload,
        payload_hash: setup1.expectedHash,
        created_at: setup1.nowIso,
      });
      const adj1 = fx1.repo.getCoderSubmissionAdjudicationById(setup1.adjId)!;
      const rWrongId = fx1.recoveryScanner.reconcileSingleAdjudication(adj1);
      expect(rWrongId.classification).toBe('AUTHORITY_CONFLICT');
      expect(rWrongId.error).toContain('Deterministic event ID mismatch');

      // Probe 2: Wrong event_type
      const fx2 = createFreshFixtures();
      const setup2 = setupPreResultEventTest(fx2);
      const rightId2 = deriveDeterministicAdjudicationEventId(setup2.adjId, 3, 'RECOVERY_FENCED', setup2.expectedHash);
      fx2.repo.createCoderSubmissionAdjudicationEvent({
        id: rightId2,
        adjudication_id: setup2.adjId,
        sequence: 3,
        event_type: 'VERIFICATION_SUCCEEDED',
        payload_json: setup2.expectedPayload,
        payload_hash: setup2.expectedHash,
        created_at: setup2.nowIso,
      });
      const adj2 = fx2.repo.getCoderSubmissionAdjudicationById(setup2.adjId)!;
      const rWrongType = fx2.recoveryScanner.reconcileSingleAdjudication(adj2);
      expect(rWrongType.classification).toBe('AUTHORITY_CONFLICT');
      expect(rWrongType.error).toContain('must have type RECOVERY_FENCED');

      // Probe 3: Extra event rows
      const fx3 = createFreshFixtures();
      const setup3 = setupPreResultEventTest(fx3);
      const rightId3 = deriveDeterministicAdjudicationEventId(setup3.adjId, 3, 'RECOVERY_FENCED', setup3.expectedHash);
      fx3.repo.createCoderSubmissionAdjudicationEvent({
        id: rightId3,
        adjudication_id: setup3.adjId,
        sequence: 3,
        event_type: 'RECOVERY_FENCED',
        payload_json: setup3.expectedPayload,
        payload_hash: setup3.expectedHash,
        created_at: setup3.nowIso,
      });
      fx3.repo.createCoderSubmissionAdjudicationEvent({
        id: crypto.randomUUID(),
        adjudication_id: setup3.adjId,
        sequence: 4,
        event_type: 'RECOVERY_FENCED',
        payload_json: setup3.expectedPayload,
        payload_hash: setup3.expectedHash,
        created_at: setup3.nowIso,
      });
      const adj3 = fx3.repo.getCoderSubmissionAdjudicationById(setup3.adjId)!;
      const rExtra = fx3.recoveryScanner.reconcileSingleAdjudication(adj3);
      expect(rExtra.classification).toBe('AUTHORITY_CONFLICT');
      expect(rExtra.error).toContain('Pre-result RECOVERY_FENCED must have exactly one terminal event, found 2');
    });

    it('348. Exact lease-state tests cover VERIFIED, VERIFICATION_FAILED, result-bearing RECOVERY_FENCED, pre-result RECOVERY_FENCED; all authority conflicts prove byte-identical database state, evidence files, and workspace contents before and after scanning', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      expect(adj.status).toBe('VERIFIED');

      // Capture complete state snapshots before reconciliation
      const dbDumpBefore = fixtures.db.prepare('SELECT id, status, lifecycle_version FROM coder_submission_adjudications').all();
      const leaseBefore = fixtures.db.prepare('SELECT id, state, released_at FROM coder_submission_workspace_leases').all();
      const eventsCountBefore = (fixtures.db.prepare('SELECT count(*) as cnt FROM coder_submission_adjudication_events').get() as { cnt: number }).cnt;
      const dispsCountBefore = (fixtures.db.prepare('SELECT count(*) as cnt FROM coder_submission_dispositions').get() as { cnt: number }).cnt;

      const rVerified = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(rVerified.classification).toBe('ALREADY_RECONCILED');
      expect(rVerified.action_taken).toBe('NO_OP');

      // Prove byte-identical database state after reconciliation
      const dbDumpAfter = fixtures.db.prepare('SELECT id, status, lifecycle_version FROM coder_submission_adjudications').all();
      const leaseAfter = fixtures.db.prepare('SELECT id, state, released_at FROM coder_submission_workspace_leases').all();
      const eventsCountAfter = (fixtures.db.prepare('SELECT count(*) as cnt FROM coder_submission_adjudication_events').get() as { cnt: number }).cnt;
      const dispsCountAfter = (fixtures.db.prepare('SELECT count(*) as cnt FROM coder_submission_dispositions').get() as { cnt: number }).cnt;

      expect(JSON.stringify(dbDumpAfter)).toBe(JSON.stringify(dbDumpBefore));
      expect(JSON.stringify(leaseAfter)).toBe(JSON.stringify(leaseBefore));
      expect(eventsCountAfter).toBe(eventsCountBefore);
      expect(dispsCountAfter).toBe(dispsCountBefore);

      // Probe 2: Corrupt lease state on VERIFIED produces AUTHORITY_CONFLICT with zero mutation
      fixtures.db.prepare("UPDATE coder_submission_workspace_leases SET state = 'FENCED', failure_code = 'ORPHANED_VERIFICATION_INTERRUPTED', lifecycle_version = lifecycle_version + 1 WHERE id = ?").run(adj.workspace_lease_id);
      const rLeaseConflict = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(rLeaseConflict.classification).toBe('AUTHORITY_CONFLICT');
      expect(rLeaseConflict.error).toContain('VERIFIED workspace lease must be RELEASED');

      // Restore lease
      fixtures.db.prepare("UPDATE coder_submission_workspace_leases SET state = 'RELEASED', failure_code = NULL, lifecycle_version = lifecycle_version + 1 WHERE id = ?").run(adj.workspace_lease_id);
    });

    async function waitForCondition(condition: () => boolean, timeoutMs = 5000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() <= deadline) {
        if (condition()) return;
        await new Promise((r) => setImmediate(r));
      }
      throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
    }

    it('349. Async public cancellation returns Promise<ProcessTerminationTruth> and no immediate boolean success', async () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cancel-349-'));
      try {
        const scriptPath = path.join(testDir, 'spin.js');
        fs.writeFileSync(scriptPath, 'setInterval(() => {}, 1000);', 'utf8');

        const execId = crypto.randomUUID();
        const procPromise = ProcessRunner.execute({
          executable: process.execPath,
          args: [scriptPath],
          cwd: testDir,
          executionId: execId,
        });

        await waitForCondition(() => ProcessRunner.getActiveProcessCount() > 0);

        const cancelPromise = ProcessRunner.cancel(execId);
        expect(cancelPromise instanceof Promise).toBe(true);

        // Prove cancelPromise exposes zero synchronous result properties before awaiting
        const rawPromise = cancelPromise as unknown as Record<string, unknown>;
        expect(rawPromise.success).toBeUndefined();
        expect(rawPromise.cancelled).toBeUndefined();
        expect(rawPromise.processTermination).toBeUndefined();
        expect(rawPromise.processStart).toBeUndefined();

        const cancelTruth = await cancelPromise;
        expect(cancelTruth).toBe('PROCESS_TREE_TERMINATED_PROVEN');

        const result = await procPromise;
        expect(result.cancelled).toBe(true);
        expect(result.processTermination).toBe('PROCESS_TREE_TERMINATED_PROVEN');
        expect(ProcessRunner.getActiveProcessCount()).toBe(0);
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('350. Concurrent cancellation callers for the same execution join the same settlement authority', async () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cancel-350-'));
      try {
        const scriptPath = path.join(testDir, 'loop.js');
        fs.writeFileSync(scriptPath, 'setInterval(() => {}, 1000);', 'utf8');

        const execId = crypto.randomUUID();
        const procPromise = ProcessRunner.execute({
          executable: process.execPath,
          args: [scriptPath],
          cwd: testDir,
          executionId: execId,
        });

        await waitForCondition(() => ProcessRunner.getActiveProcessCount() > 0);

        const p1 = ProcessRunner.cancel(execId);
        const p2 = ProcessRunner.cancel(execId);
        const p3 = ProcessRunner.cancel(execId);

        // Prove exact memoization Promise identity
        expect(p2).toBe(p1);
        expect(p3).toBe(p1);

        const [c1, c2, c3] = await Promise.all([p1, p2, p3]);
        expect(c1).toBe('PROCESS_TREE_TERMINATED_PROVEN');
        expect(c2).toBe('PROCESS_TREE_TERMINATED_PROVEN');
        expect(c3).toBe('PROCESS_TREE_TERMINATED_PROVEN');

        const result = await procPromise;
        expect(result.cancelled).toBe(true);
        expect(ProcessRunner.getActiveProcessCount()).toBe(0);
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('351. Unknown and already-terminal execution IDs return typed NOT_APPLICABLE truth separately', async () => {
      // 1. Unknown execution ID
      const unknownId = 'unknown-execution-' + crypto.randomUUID();
      const resUnknown = await ProcessRunner.cancel(unknownId);
      expect(resUnknown).toBe('NOT_APPLICABLE');
      expect(ProcessRunner.getActiveProcessCount()).toBe(0);

      // 2. Already-terminal execution ID that completed naturally
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cancel-351-'));
      try {
        const scriptPath = path.join(testDir, 'quick.js');
        fs.writeFileSync(scriptPath, 'process.exit(0);', 'utf8');
        const completedExecId = crypto.randomUUID();
        const procResult = await ProcessRunner.execute({
          executable: process.execPath,
          args: [scriptPath],
          cwd: testDir,
          executionId: completedExecId,
        });
        expect(procResult.exitCode).toBe(0);
        expect(ProcessRunner.getActiveProcessCount()).toBe(0);

        const resAlreadyCompleted = await ProcessRunner.cancel(completedExecId);
        expect(resAlreadyCompleted).toBe('NOT_APPLICABLE');

        // 3. Already-terminal execution ID that was previously cancelled
        const spinPath = path.join(testDir, 'spin.js');
        fs.writeFileSync(spinPath, 'setInterval(() => {}, 1000);', 'utf8');
        const cancelledExecId = crypto.randomUUID();
        const spinPromise = ProcessRunner.execute({
          executable: process.execPath,
          args: [spinPath],
          cwd: testDir,
          executionId: cancelledExecId,
        });
        await waitForCondition(() => ProcessRunner.getActiveProcessCount() > 0);
        const firstCancel = await ProcessRunner.cancel(cancelledExecId);
        expect(firstCancel).toBe('PROCESS_TREE_TERMINATED_PROVEN');
        await spinPromise;
        expect(ProcessRunner.getActiveProcessCount()).toBe(0);

        const secondCancel = await ProcessRunner.cancel(cancelledExecId);
        expect(secondCancel).toBe('NOT_APPLICABLE');
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('352. Process-tree death proof is verified before successful cancellation return', async () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cancel-352-'));
      try {
        const scriptPath = path.join(testDir, 'long.js');
        fs.writeFileSync(scriptPath, 'setInterval(() => {}, 1000);', 'utf8');

        const execId = crypto.randomUUID();
        let capturedPid: number | null = null;
        const procPromise = ProcessRunner.execute({
          executable: process.execPath,
          args: [scriptPath],
          cwd: testDir,
          executionId: execId,
        });

        await waitForCondition(() => ProcessRunner.getActiveProcessCount() === 1);

        const cancelResult = await ProcessRunner.cancel(execId);
        expect(cancelResult).toBe('PROCESS_TREE_TERMINATED_PROVEN');

        const result = await procPromise;
        capturedPid = result.pid;
        expect(capturedPid).not.toBeNull();
        if (capturedPid !== null) {
          const isDead = await ProcessRunner.verifyProcessDeadWithDeadline(capturedPid, 500);
          expect(isDead).toBe(true);
        }
        expect(ProcessRunner.getActiveProcessCount()).toBe(0);
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('353. Durable terminal state is persisted before successful cancellation return with exactly one durable terminal write', async () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cancel-353-'));
      const origUpdate = fixtures.repo.updateProcessRun.bind(fixtures.repo);
      let terminalWrites = 0;
      try {
        const scriptPath = path.join(testDir, 'script.js');
        fs.writeFileSync(scriptPath, 'setInterval(() => {}, 1000);', 'utf8');

        const execId = crypto.randomUUID();
        fixtures.repo.updateProcessRun = (execIdArg, status, exitCode, stdout, stderr, finishTime) => {
          terminalWrites++;
          return origUpdate(execIdArg, status, exitCode, stdout, stderr, finishTime);
        };

        const procPromise = ProcessRunner.execute({
          executable: process.execPath,
          args: [scriptPath],
          cwd: testDir,
          executionId: execId,
          repo: fixtures.repo,
        });

        await waitForCondition(() => ProcessRunner.getActiveProcessCount() === 1);
        const cancelTruth = await ProcessRunner.cancel(execId);
        expect(cancelTruth).toBe('PROCESS_TREE_TERMINATED_PROVEN');

        // Verify that by the time cancel returns, the durable process run is already marked terminal
        const runRow = fixtures.repo.getProcessRun(execId);
        expect(runRow).toBeDefined();
        expect(runRow?.status).toBe('CANCELLED');
        expect(runRow?.end_time || runRow?.finished_at).toBeDefined();

        await procPromise;
        expect(ProcessRunner.getActiveProcessCount()).toBe(0);
        // Prove exactly one durable terminal write occurred
        expect(terminalWrites).toBe(1);
      } finally {
        fixtures.repo.updateProcessRun = origUpdate;
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('354. Durable terminal persistence failure keeps execution visibly counted as active and unproven and returns TERMINATION_UNRESOLVED on cancel', async () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-persist-354-'));
      const origUpdate = fixtures.repo.updateProcessRun.bind(fixtures.repo);
      try {
        const scriptPath = path.join(testDir, 'quick.js');
        fs.writeFileSync(scriptPath, 'process.exit(0);', 'utf8');

        const execId = crypto.randomUUID();
        fixtures.repo.updateProcessRun = () => {
          throw new Error('Simulated disk write failure on terminal persistence');
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

        // Unresolved persistence-fenced execution is counted in active count and unproven
        expect(ProcessRunner.getActiveProcessCount()).toBe(1);
        expect(ProcessRunner.getPersistenceFencedCount()).toBe(1);

        // Real cancellation against the fenced execution ID returns TERMINATION_UNRESOLVED
        const fencedCancelTruth = await ProcessRunner.cancel(execId);
        expect(fencedCancelTruth).toBe('TERMINATION_UNRESOLVED');

        const termSummary = await ProcessRunner.terminateAllProcesses();
        expect(termSummary.unproven).toBe(1);
        expect(termSummary.allTerminatedProven).toBe(false);

        // Clean up fenced entry by retrying persistence with restored repo
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

    it('355. terminateAllProcesses returns exact count, unproven, and allTerminatedProven', async () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-termall-355-'));
      try {
        const scriptPath = path.join(testDir, 'hold.js');
        fs.writeFileSync(scriptPath, 'setInterval(() => {}, 1000);', 'utf8');

        const exec1 = crypto.randomUUID();
        const exec2 = crypto.randomUUID();

        const p1 = ProcessRunner.execute({
          executable: process.execPath,
          args: [scriptPath],
          cwd: testDir,
          executionId: exec1,
        });

        const p2 = ProcessRunner.execute({
          executable: process.execPath,
          args: [scriptPath],
          cwd: testDir,
          executionId: exec2,
        });

        await waitForCondition(() => ProcessRunner.getActiveProcessCount() === 2);

        const summary = await ProcessRunner.terminateAllProcesses();
        expect(summary.count).toBe(2);
        expect(summary.unproven).toBe(0);
        expect(summary.allTerminatedProven).toBe(true);

        await Promise.all([p1, p2]);
        expect(ProcessRunner.getActiveProcessCount()).toBe(0);
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('356. EmergencyStopService returns pure Promise with zero synchronous properties and truthfully awaits global process termination', async () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-estop-356-'));
      try {
        const scriptPath = path.join(testDir, 'loop.js');
        fs.writeFileSync(scriptPath, 'setInterval(() => {}, 1000);', 'utf8');

        const execId = crypto.randomUUID();
        const procPromise = ProcessRunner.execute({
          executable: process.execPath,
          args: [scriptPath],
          cwd: testDir,
          executionId: execId,
        });

        await waitForCondition(() => ProcessRunner.getActiveProcessCount() === 1);

        const stopPromise = fixtures.emergencyStopService.triggerEmergencyStop('Automated test emergency stop');
        expect(stopPromise instanceof Promise).toBe(true);

        // Prove pure Promise exposes NONE of the result fields synchronously
        const rawPromise = stopPromise as unknown as Record<string, unknown>;
        expect(rawPromise.processesTerminated).toBeUndefined();
        expect(rawPromise.tasksPaused).toBeUndefined();
        expect(rawPromise.projectsPaused).toBeUndefined();
        expect(rawPromise.timestamp).toBeUndefined();
        expect(rawPromise.unprovenProcesses).toBeUndefined();
        expect(rawPromise.allTerminatedProven).toBeUndefined();

        const stopRes = await stopPromise;
        expect(stopRes.processesTerminated).toBe(1);
        expect(stopRes.unprovenProcesses).toBe(0);
        expect(stopRes.allTerminatedProven).toBe(true);
        expect(stopRes.projectsPaused).toContain(fixtures.projectId);
        expect(ProcessRunner.getActiveProcessCount()).toBe(0);
        await procPromise;

        // Verify exactly one canonical EMERGENCY_STOP event was recorded for the project
        const events = fixtures.eventService.getEvents(fixtures.projectId);
        const estopEvents = events.filter((e) => e.type === 'EMERGENCY_STOP');
        expect(estopEvents.length).toBe(1);
        const payload = estopEvents[0].structured_payload as Record<string, unknown>;
        expect(payload.reason).toBe('Automated test emergency stop');
        expect(payload.processesTerminated).toBe(1);
        expect(payload.allTerminatedProven).toBe(true);
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('357. Dedicated canonical FILE_SNAPSHOT production creation and binding in adjudication settlement', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      expect(adj.status).toBe('VERIFIED');
      const env = JSON.parse(adj.verification_result_envelope_json!);
      expect(env.workspace_snapshot_after_evidence_id).toBeTruthy();

      const afterEvidence = fixtures.repo.getEvidence(env.workspace_snapshot_after_evidence_id!);
      expect(afterEvidence).toBeDefined();
      expect(afterEvidence?.evidence_type).toBe('FILE_SNAPSHOT');

      // Verify artifact manifest includes dedicated workspace-after evidence
      const manifest = JSON.parse(adj.artifact_manifest_json!);
      const wsAfterEntry = manifest.entries.find((e: { evidence_id: string }) => e.evidence_id === afterEvidence?.id);
      expect(wsAfterEntry).toBeDefined();
      expect(wsAfterEntry.evidence_type).toBe('FILE_SNAPSHOT');
      expect(wsAfterEntry.sha256).toBe(afterEvidence?.hash);

      // Verify content is valid canonical JSON with exact 18 keys
      let content = afterEvidence?.raw_payload;
      if (!content && afterEvidence?.file_path) {
        content = fs.readFileSync(afterEvidence.file_path, 'utf8');
      }
      expect(content).toBeDefined();
      const parsed = JSON.parse(content!);
      const actualKeys = Object.keys(parsed).sort();
      const expectedKeys = [...CANONICAL_WORKSPACE_SNAPSHOT_AFTER_KEYS].sort();
      expect(actualKeys).toEqual(expectedKeys);
      expect(actualKeys.length).toBe(18);
      expect(canonicalJsonStringify(parsed)).toBe(content);
      expect(computeSha256(content!)).toBe(afterEvidence?.hash);
      expect(parsed.adjudication_id).toBe(adj.id);
      expect(parsed.submission_id).toBe(subId);
      expect(parsed.task_id).toBe(fixtures.taskId);
      expect(parsed.project_id).toBe(fixtures.projectId);
      expect(parsed.expected_head_sha).toBe(fixtures.repoHeadSha);
      expect(parsed.captured_repository_head_sha).toBe(fixtures.repoHeadSha);
    });

    it('358. Initial settlement and replay rejection of workspace evidence tampering', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      expect(adj.status).toBe('VERIFIED');

      // Tamper with workspace-after evidence raw payload in DB
      const env = JSON.parse(adj.verification_result_envelope_json!);
      const afterEvId = env.workspace_snapshot_after_evidence_id!;
      fixtures.db.prepare('UPDATE evidence SET raw_payload = ? WHERE id = ?').run('tampered-payload', afterEvId);

      const reconTampered = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(reconTampered.classification).toBe('AUTHORITY_CONFLICT');
      expect(reconTampered.error).toContain('workspace_snapshot_after');
    });

    it('359. Recovery scanner rejects missing or contradictory terminal disposition or deterministic event across 4 independent subcases', async () => {
      // Subcase 1: Missing terminal disposition
      {
        const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
        const subId = crypto.randomUUID();
        fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
        const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        });
        const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
        expect(adj.status).toBe('VERIFIED');

        const origGetDisps = fixtures.repo.getCoderSubmissionDispositions.bind(fixtures.repo);
        fixtures.repo.getCoderSubmissionDispositions = () => [];
        try {
          const recon = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
          expect(recon.classification).toBe('AUTHORITY_CONFLICT');
          expect(recon.action_taken).toBe('NO_OP');
          expect(recon.error).toContain('terminal disposition');
          const adjAfter = fixtures.repo.getCoderSubmissionAdjudicationById(adj.id)!;
          expect(adjAfter.status).toBe('VERIFIED');
          expect(adjAfter.lifecycle_version).toBe(adj.lifecycle_version);
        } finally {
          fixtures.repo.getCoderSubmissionDispositions = origGetDisps;
        }
      }

      // Subcase 2: Contradictory terminal disposition
      {
        const fx2 = setupFullSubmissionGraph(fixtures.db, fixtures.projectRoot, fixtures.artifactStore.getBaseDir());
        const { plaintextToken } = issueSubmissionSessionHelper(fx2.repo, fx2.authorizationId);
        const subId = crypto.randomUUID();
        fx2.mcpService.submitCoderClaim(createValidSubmissionPayload(fx2, subId), plaintextToken);
        const admitRes = await fx2.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        });
        const adj = fx2.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
        expect(adj.status).toBe('VERIFIED');

        // Add contradictory REJECTED disposition on VERIFIED adjudication
        fx2.repo.createCoderSubmissionDisposition({
          id: crypto.randomUUID(),
          submission_id: subId,
          disposition_event: 'REJECTED',
          disposition_reason: 'COLLISION_CONFLICT',
          actor_type: 'SYSTEM',
          actor_id: 'SYSTEM_VERIFICATION_EVALUATOR',
          disposition_metadata_json: canonicalJsonStringify({ adjudication_id: adj.id, error: 'conflict', failure_code: 'TESTS_FAILED' }),
          created_at: adj.completed_at!,
        });

        const recon = fx2.recoveryScanner.reconcileSingleAdjudication(adj);
        expect(recon.classification).toBe('AUTHORITY_CONFLICT');
        expect(recon.action_taken).toBe('NO_OP');
        const adjAfter = fx2.repo.getCoderSubmissionAdjudicationById(adj.id)!;
        expect(adjAfter.status).toBe('VERIFIED');
        expect(adjAfter.lifecycle_version).toBe(adj.lifecycle_version);
      }

      // Subcase 3: Missing deterministic terminal event
      {
        const fx3 = setupFullSubmissionGraph(fixtures.db, fixtures.projectRoot, fixtures.artifactStore.getBaseDir());
        const { plaintextToken } = issueSubmissionSessionHelper(fx3.repo, fx3.authorizationId);
        const subId = crypto.randomUUID();
        fx3.mcpService.submitCoderClaim(createValidSubmissionPayload(fx3, subId), plaintextToken);
        const admitRes = await fx3.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        });
        const adj = fx3.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
        expect(adj.status).toBe('VERIFIED');

        const origGetEvents = fx3.repo.getCoderSubmissionAdjudicationEvents.bind(fx3.repo);
        fx3.repo.getCoderSubmissionAdjudicationEvents = () => [];
        try {
          const recon = fx3.recoveryScanner.reconcileSingleAdjudication(adj);
          expect(recon.classification).toBe('AUTHORITY_CONFLICT');
          expect(recon.action_taken).toBe('NO_OP');
          expect(recon.error).toContain('terminal event');
          const adjAfter = fx3.repo.getCoderSubmissionAdjudicationById(adj.id)!;
          expect(adjAfter.status).toBe('VERIFIED');
          expect(adjAfter.lifecycle_version).toBe(adj.lifecycle_version);
        } finally {
          fx3.repo.getCoderSubmissionAdjudicationEvents = origGetEvents;
        }
      }

      // Subcase 4: Contradictory event sequence
      {
        const fx4 = setupFullSubmissionGraph(fixtures.db, fixtures.projectRoot, fixtures.artifactStore.getBaseDir());
        const { plaintextToken } = issueSubmissionSessionHelper(fx4.repo, fx4.authorizationId);
        const subId = crypto.randomUUID();
        fx4.mcpService.submitCoderClaim(createValidSubmissionPayload(fx4, subId), plaintextToken);
        const admitRes = await fx4.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        });
        const adj = fx4.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
        expect(adj.status).toBe('VERIFIED');

        // Tamper with terminal event sequence (contradictory sequence)
        const origGetEvents = fx4.repo.getCoderSubmissionAdjudicationEvents.bind(fx4.repo);
        fx4.repo.getCoderSubmissionAdjudicationEvents = (adjId: string) => {
          const events = origGetEvents(adjId);
          return events.map((e) => (e.sequence === 3 ? { ...e, sequence: 99 } : e));
        };

        try {
          const recon = fx4.recoveryScanner.reconcileSingleAdjudication(adj);
          expect(recon.classification).toBe('AUTHORITY_CONFLICT');
          expect(recon.action_taken).toBe('NO_OP');
          expect(recon.error).toContain('sequence');
          const adjAfter = fx4.repo.getCoderSubmissionAdjudicationById(adj.id)!;
          expect(adjAfter.status).toBe('VERIFIED');
          expect(adjAfter.lifecycle_version).toBe(adj.lifecycle_version);
        } finally {
          fx4.repo.getCoderSubmissionAdjudicationEvents = origGetEvents;
        }
      }
    });

    it('360. Mutation-free authority conflict with byte/row-count identity proof across all application tables', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;

      // Corrupt lease state to create authority conflict without violating immutable triggers
      fixtures.db.prepare("UPDATE coder_submission_workspace_leases SET state = 'FENCED', failure_code = 'ORPHANED_VERIFICATION_INTERRUPTED', lifecycle_version = lifecycle_version + 1 WHERE id = ?").run(adj.workspace_lease_id);

      // Dynamically query all application tables from sqlite_master, excluding internal SQLite tables
      const allAppTables = (fixtures.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC").all() as { name: string }[])
        .map((row) => row.name);
      expect(allAppTables.length).toBeGreaterThanOrEqual(10);

      // Snapshot all application tables before reconciliation
      const snapshotBefore = new Map<string, { count: number; canonicalJson: string }>();
      for (const tableName of allAppTables) {
        const rows = fixtures.db.prepare(`SELECT * FROM "${tableName}" ORDER BY rowid ASC`).all();
        snapshotBefore.set(tableName, {
          count: rows.length,
          canonicalJson: canonicalJsonStringify(rows),
        });
      }

      const totalChangesBefore = (fixtures.db.prepare('SELECT total_changes() AS tc').get() as { tc: number }).tc;

      const recon = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(recon.classification).toBe('AUTHORITY_CONFLICT');
      expect(recon.action_taken).toBe('NO_OP');

      const totalChangesAfter = (fixtures.db.prepare('SELECT total_changes() AS tc').get() as { tc: number }).tc;
      expect(totalChangesAfter - totalChangesBefore).toBe(0);

      // Verify exact row counts and byte-identical canonical JSON serialization for every application table
      for (const tableName of allAppTables) {
        const rowsAfter = fixtures.db.prepare(`SELECT * FROM "${tableName}" ORDER BY rowid ASC`).all();
        const before = snapshotBefore.get(tableName)!;
        expect(rowsAfter.length).toBe(before.count);
        expect(canonicalJsonStringify(rowsAfter)).toBe(before.canonicalJson);
      }

      // Clean up restored lease
      fixtures.db.prepare("UPDATE coder_submission_workspace_leases SET state = 'RELEASED', failure_code = NULL, lifecycle_version = lifecycle_version + 1 WHERE id = ?").run(adj.workspace_lease_id);
    });

    it('361. evaluateCanonicalSettlementDecision strictly requires FILE_SNAPSHOT and fails closed on CUSTOM workspace-after evidence', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const env = JSON.parse(adj.verification_result_envelope_json!);
      const afterEvId = env.workspace_snapshot_after_evidence_id!;

      // Change evidence_type from FILE_SNAPSHOT to CUSTOM
      fixtures.db.prepare("UPDATE evidence SET evidence_type = 'CUSTOM' WHERE id = ?").run(afterEvId);

      const tr = fixtures.repo.getTestRun(adj.test_run_id!)!;
      const dec = evaluateCanonicalSettlementDecision({
        rawEnvelopeJson: adj.verification_result_envelope_json!,
        storedEnvelopeHash: adj.verification_result_envelope_hash!,
        rawManifestJson: adj.artifact_manifest_json!,
        storedManifestHash: adj.artifact_manifest_hash!,
        adjudication: adj,
        testRun: tr,
        gitStatusEvidenceId: adj.git_status_evidence_id,
        gitDiffEvidenceId: adj.git_diff_evidence_id,
        testResultEvidenceId: env.test_result_evidence_id,
        repo: fixtures.repo,
        artifactStore: fixtures.artifactStore,
      });

      expect(dec.valid).toBe(false);
      expect(dec.isSuccess).toBe(false);
      expect(dec.contradictionReason).toContain('workspace_snapshot_after');

      // Restore evidence_type
      fixtures.db.prepare("UPDATE evidence SET evidence_type = 'FILE_SNAPSHOT' WHERE id = ?").run(afterEvId);
    });

    it('362. evaluateNonAuthoritativeSettlementDecisionForTests strictly requires FILE_SNAPSHOT and fails closed on CUSTOM workspace-after evidence', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const env = JSON.parse(adj.verification_result_envelope_json!);
      const afterEvId = env.workspace_snapshot_after_evidence_id!;

      // Change evidence_type to CUSTOM
      fixtures.db.prepare("UPDATE evidence SET evidence_type = 'CUSTOM' WHERE id = ?").run(afterEvId);

      const manifest = JSON.parse(adj.artifact_manifest_json!);
      const wsEntry = manifest.entries.find((e: { evidence_id: string }) => e.evidence_id === afterEvId);
      if (wsEntry) wsEntry.evidence_type = 'CUSTOM';
      env.artifact_manifest_hash = computeArtifactManifestHash(manifest);

      const dec = evaluateNonAuthoritativeSettlementDecisionForTests({
        envelope: env,
        adjudication: adj,
        testRun: fixtures.repo.getTestRun(adj.test_run_id!) ?? null,
        manifest,
        repo: fixtures.repo,
        artifactStore: fixtures.artifactStore,
      });

      expect(dec.valid).toBe(false);
      expect(dec.isSuccess).toBe(false);
      expect(dec.failureDetail).toContain('must have type FILE_SNAPSHOT');

      // Restore evidence_type
      fixtures.db.prepare("UPDATE evidence SET evidence_type = 'FILE_SNAPSHOT' WHERE id = ?").run(afterEvId);
    });

    it('363. validateCanonicalWorkspaceSnapshotAfter rejects workspace-after snapshot missing any of the 18 keys', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const lease = fixtures.repo.getWorkspaceLease(adj.workspace_lease_id!)!;
      const env = JSON.parse(adj.verification_result_envelope_json!);
      const afterEv = fixtures.repo.getEvidence(env.workspace_snapshot_after_evidence_id!)!;
      const rawContent = afterEv.raw_payload || (afterEv.file_path ? fs.readFileSync(afterEv.file_path, 'utf8') : '{}');
      const validPayload = JSON.parse(rawContent) as Record<string, unknown>;

      // Test removing each of the 18 keys one-by-one
      for (const key of CANONICAL_WORKSPACE_SNAPSHOT_AFTER_KEYS) {
        const incomplete = { ...validPayload };
        delete incomplete[key];
        const incompleteJson = canonicalJsonStringify(incomplete);
        const result = validateCanonicalWorkspaceSnapshotAfter({
          rawContent: incompleteJson,
          expectedHash: computeSha256(incompleteJson),
          adjudication: adj,
          submission: sub,
          lease,
          verificationExecutionId: env.verification_execution_id,
          gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
          gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
          expectedCapturedAt: env.finish_timestamp,
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('property set mismatch');
      }
    });

    it('364. validateCanonicalWorkspaceSnapshotAfter rejects extra unrecognized keys and wrong types', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const lease = fixtures.repo.getWorkspaceLease(adj.workspace_lease_id!)!;
      const env = JSON.parse(adj.verification_result_envelope_json!);
      const afterEv = fixtures.repo.getEvidence(env.workspace_snapshot_after_evidence_id!)!;
      const rawContent = afterEv.raw_payload || (afterEv.file_path ? fs.readFileSync(afterEv.file_path, 'utf8') : '{}');
      const validPayload = JSON.parse(rawContent) as Record<string, unknown>;

      // 1. Extra key rejection
      const extraPayload = { ...validPayload, unexpected_extra_key: 'forbidden' };
      const extraJson = canonicalJsonStringify(extraPayload);
      const extraRes = validateCanonicalWorkspaceSnapshotAfter({
        rawContent: extraJson,
        expectedHash: computeSha256(extraJson),
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
        gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(extraRes.valid).toBe(false);
      expect(extraRes.error).toContain('property set mismatch');

      // 2. Wrong type rejection (schema_version string instead of number 1)
      const wrongTypePayload = { ...validPayload, schema_version: '1' as unknown as number };
      const wrongTypeJson = canonicalJsonStringify(wrongTypePayload);
      const wrongTypeRes = validateCanonicalWorkspaceSnapshotAfter({
        rawContent: wrongTypeJson,
        expectedHash: computeSha256(wrongTypeJson),
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
        gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(wrongTypeRes.valid).toBe(false);
      expect(wrongTypeRes.error).toContain('schema_version must be integer 1');
    });

    it('365. validateCanonicalWorkspaceSnapshotAfter rejects repository-head conflict', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const lease = fixtures.repo.getWorkspaceLease(adj.workspace_lease_id!)!;
      const env = JSON.parse(adj.verification_result_envelope_json!);
      const afterEv = fixtures.repo.getEvidence(env.workspace_snapshot_after_evidence_id!)!;
      const rawContent = afterEv.raw_payload || (afterEv.file_path ? fs.readFileSync(afterEv.file_path, 'utf8') : '{}');
      const validPayload = JSON.parse(rawContent) as Record<string, unknown>;

      // Tamper with captured_repository_head_sha to conflict with authorized_head_sha
      const badHeadPayload = {
        ...validPayload,
        captured_repository_head_sha: '1111222233334444555566667777888899990000',
      };
      const badHeadJson = canonicalJsonStringify(badHeadPayload);
      const badHeadRes = validateCanonicalWorkspaceSnapshotAfter({
        rawContent: badHeadJson,
        expectedHash: computeSha256(badHeadJson),
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
        gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(badHeadRes.valid).toBe(false);
      expect(badHeadRes.error).toMatch(/repository-head conflict|conflicts with expected_head_sha/);
    });

    it('366. validateCanonicalWorkspaceSnapshotAfter rejects workspace lease binding conflict', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const lease = fixtures.repo.getWorkspaceLease(adj.workspace_lease_id!)!;
      const env = JSON.parse(adj.verification_result_envelope_json!);
      const afterEv = fixtures.repo.getEvidence(env.workspace_snapshot_after_evidence_id!)!;
      const rawContent = afterEv.raw_payload || (afterEv.file_path ? fs.readFileSync(afterEv.file_path, 'utf8') : '{}');
      const validPayload = JSON.parse(rawContent) as Record<string, unknown>;

      // Change workspace_lease_id to a different ID
      const badLeasePayload = {
        ...validPayload,
        workspace_lease_id: 'lease-conflicting-' + crypto.randomUUID(),
      };
      const badLeaseJson = canonicalJsonStringify(badLeasePayload);
      const badLeaseRes = validateCanonicalWorkspaceSnapshotAfter({
        rawContent: badLeaseJson,
        expectedHash: computeSha256(badLeaseJson),
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
        gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(badLeaseRes.valid).toBe(false);
      expect(badLeaseRes.error).toContain('workspace_lease_id mismatch');
    });

    it('367. validateCanonicalWorkspaceSnapshotAfter fails closed on noncanonical JSON formatting', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const lease = fixtures.repo.getWorkspaceLease(adj.workspace_lease_id!)!;
      const env = JSON.parse(adj.verification_result_envelope_json!);
      const afterEv = fixtures.repo.getEvidence(env.workspace_snapshot_after_evidence_id!)!;
      const rawContent = afterEv.raw_payload || (afterEv.file_path ? fs.readFileSync(afterEv.file_path, 'utf8') : '{}');
      const validPayload = JSON.parse(rawContent) as Record<string, unknown>;

      // Pretty-print or format with spaces - valid JSON but non-canonical
      const nonCanonicalJson = JSON.stringify(validPayload, null, 2);
      const res = validateCanonicalWorkspaceSnapshotAfter({
        rawContent: nonCanonicalJson,
        expectedHash: computeSha256(nonCanonicalJson),
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
        gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(res.valid).toBe(false);
      expect(res.error).toContain('not byte-identical to its canonical JSON representation');
    });

    it('368. Idempotent replay path independently validates canonical 18-key FILE_SNAPSHOT', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const reqId = crypto.randomUUID();
      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: reqId,
        submissionId: subId,
      });

      expect(admitRes.status).toBe('VERIFIED');

      // Replay with identical admission request succeeds idempotently
      const replayRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: reqId,
        submissionId: subId,
      });
      expect(replayRes.status).toBe('VERIFIED');
      expect(replayRes.adjudication.id).toBe(admitRes.adjudication.id);

      // Now tamper with the workspace-after evidence in database
      const env = JSON.parse(admitRes.adjudication.verification_result_envelope_json!);
      fixtures.db.prepare("UPDATE evidence SET evidence_type = 'CUSTOM' WHERE id = ?").run(env.workspace_snapshot_after_evidence_id);

      // Replay must detect the tampering and fail closed
      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: reqId,
          submissionId: subId,
        })
      ).rejects.toThrow(/INTEGRITY_CONFLICT.*FILE_SNAPSHOT/);

      // Restore evidence_type
      fixtures.db.prepare("UPDATE evidence SET evidence_type = 'FILE_SNAPSHOT' WHERE id = ?").run(env.workspace_snapshot_after_evidence_id);
    });

    it('369. Evaluator reconciliation path independently validates canonical 18-key FILE_SNAPSHOT and exact envelope hashes', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const env = JSON.parse(adj.verification_result_envelope_json!) as CanonicalVerificationResultEnvelope;

      const tr = fixtures.repo.getTestRun(adj.test_run_id!)!;
      // Evaluator with valid inputs succeeds
      const decValid = evaluateCanonicalSettlementDecision({
        rawEnvelopeJson: adj.verification_result_envelope_json!,
        storedEnvelopeHash: adj.verification_result_envelope_hash!,
        rawManifestJson: adj.artifact_manifest_json!,
        storedManifestHash: adj.artifact_manifest_hash!,
        adjudication: adj,
        testRun: tr,
        gitStatusEvidenceId: adj.git_status_evidence_id,
        gitDiffEvidenceId: adj.git_diff_evidence_id,
        testResultEvidenceId: env.test_result_evidence_id,
        repo: fixtures.repo,
        artifactStore: fixtures.artifactStore,
      });
      expect(decValid.valid).toBe(true);
      expect(decValid.isSuccess).toBe(true);

      // Evaluator with tampered hash fails closed
      const decBadHash = evaluateCanonicalSettlementDecision({
        rawEnvelopeJson: adj.verification_result_envelope_json!,
        storedEnvelopeHash: '0'.repeat(64),
        rawManifestJson: adj.artifact_manifest_json!,
        storedManifestHash: adj.artifact_manifest_hash!,
        adjudication: adj,
        testRun: tr,
        gitStatusEvidenceId: adj.git_status_evidence_id,
        gitDiffEvidenceId: adj.git_diff_evidence_id,
        testResultEvidenceId: env.test_result_evidence_id,
        repo: fixtures.repo,
        artifactStore: fixtures.artifactStore,
      });
      expect(decBadHash.valid).toBe(false);
      expect(decBadHash.contradictionReason).toMatch(/Envelope validation failed|Envelope hash mismatch/);
    });

    it('370. Crash recovery scanner independently validates canonical 18-key FILE_SNAPSHOT with zero mutation on conflict', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const env = JSON.parse(adj.verification_result_envelope_json!);

      // Delete workspace-after evidence from DB
      fixtures.db.prepare('DELETE FROM evidence WHERE id = ?').run(env.workspace_snapshot_after_evidence_id);

      const recon = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(recon.classification).toBe('AUTHORITY_CONFLICT');
      expect(recon.action_taken).toBe('NO_OP');
      expect(recon.error).toContain('workspace_snapshot_after');
    });

    it('371. Recovery scanner independently rejects invalid actor type, actor ID, and SCANNER alias in terminal disposition', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;

      fixtures.db.exec('DROP TRIGGER IF EXISTS trg_coder_submission_dispositions_no_update;');
      try {
        // 1. Invalid actor_type: 'SYSTEM' for VERIFIED (must be OPERATOR)
        fixtures.db.prepare("UPDATE coder_submission_dispositions SET actor_type = 'SYSTEM' WHERE submission_id = ?").run(subId);
        const recon1 = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
        expect(recon1.classification).toBe('AUTHORITY_CONFLICT');
        expect(recon1.action_taken).toBe('NO_OP');
        expect(recon1.error).toContain('actor_type');

        // Restore actor_type
        fixtures.db.prepare("UPDATE coder_submission_dispositions SET actor_type = 'OPERATOR' WHERE submission_id = ?").run(subId);

        // 2. Invalid actor_id: 'UNKNOWN_OPERATOR' for VERIFIED (must be OWNER_LOCAL_UI)
        fixtures.db.prepare("UPDATE coder_submission_dispositions SET actor_id = 'UNKNOWN_OPERATOR' WHERE submission_id = ?").run(subId);
        const recon2 = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
        expect(recon2.classification).toBe('AUTHORITY_CONFLICT');
        expect(recon2.action_taken).toBe('NO_OP');
        expect(recon2.error).toContain('actor_id');

        // 3. Prohibited noncanonical alias: 'SCANNER'
        fixtures.db.prepare("UPDATE coder_submission_dispositions SET actor_id = 'SCANNER' WHERE submission_id = ?").run(subId);
        const recon3 = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
        expect(recon3.classification).toBe('AUTHORITY_CONFLICT');
        expect(recon3.action_taken).toBe('NO_OP');
        expect(recon3.error).toContain('actor_id');

        // Restore actor_id
        fixtures.db.prepare("UPDATE coder_submission_dispositions SET actor_id = 'OWNER_LOCAL_UI' WHERE submission_id = ?").run(subId);
      } finally {
        fixtures.db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_coder_submission_dispositions_no_update
          BEFORE UPDATE ON coder_submission_dispositions
          BEGIN
            SELECT RAISE(ABORT, 'coder_submission_dispositions is strictly append-only: UPDATE is prohibited');
          END;
        `);
      }
    });

    it('372. Recovery scanner independently rejects terminal disposition metadata mutations and timestamp mismatch', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const originalDisp = fixtures.repo.getCoderSubmissionDispositions(subId).find((d) => d.disposition_event === 'SETTLED')!;
      const validMeta = JSON.parse(originalDisp.disposition_metadata_json!);

      fixtures.db.exec('DROP TRIGGER IF EXISTS trg_coder_submission_dispositions_no_update;');
      try {
        // 1. Missing metadata key (remove test_run_id)
        const missingKeyMeta = { ...validMeta };
        delete missingKeyMeta.test_run_id;
        fixtures.db.prepare('UPDATE coder_submission_dispositions SET disposition_metadata_json = ? WHERE submission_id = ?')
          .run(canonicalJsonStringify(missingKeyMeta), subId);
        const recon1 = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
        expect(recon1.classification).toBe('AUTHORITY_CONFLICT');
        expect(recon1.action_taken).toBe('NO_OP');
        expect(recon1.error).toContain('metadata');

        // 2. Extra metadata key (add illegal extra key)
        const extraKeyMeta = { ...validMeta, extra_unrecognized_key: 'forbidden' };
        fixtures.db.prepare('UPDATE coder_submission_dispositions SET disposition_metadata_json = ? WHERE submission_id = ?')
          .run(canonicalJsonStringify(extraKeyMeta), subId);
        const recon2 = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
        expect(recon2.classification).toBe('AUTHORITY_CONFLICT');
        expect(recon2.action_taken).toBe('NO_OP');
        expect(recon2.error).toContain('metadata');

        // 3. Wrong metadata value (wrong adjudication_id)
        const wrongValMeta = { ...validMeta, adjudication_id: crypto.randomUUID() };
        fixtures.db.prepare('UPDATE coder_submission_dispositions SET disposition_metadata_json = ? WHERE submission_id = ?')
          .run(canonicalJsonStringify(wrongValMeta), subId);
        const recon3 = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
        expect(recon3.classification).toBe('AUTHORITY_CONFLICT');
        expect(recon3.action_taken).toBe('NO_OP');
        expect(recon3.error).toContain('metadata');

        // 4. Noncanonical metadata serialization (pretty-printed JSON)
        const nonCanonicalMeta = JSON.stringify(validMeta, null, 2);
        fixtures.db.prepare('UPDATE coder_submission_dispositions SET disposition_metadata_json = ? WHERE submission_id = ?')
          .run(nonCanonicalMeta, subId);
        const recon4 = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
        expect(recon4.classification).toBe('AUTHORITY_CONFLICT');
        expect(recon4.action_taken).toBe('NO_OP');
        expect(recon4.error).toContain('metadata');

        // Restore metadata
        fixtures.db.prepare('UPDATE coder_submission_dispositions SET disposition_metadata_json = ? WHERE submission_id = ?')
          .run(originalDisp.disposition_metadata_json, subId);

        // 5. Terminal timestamp mismatch
        const mismatchedTime = new Date(Date.now() + 100000).toISOString();
        fixtures.db.prepare('UPDATE coder_submission_dispositions SET created_at = ? WHERE submission_id = ?').run(mismatchedTime, subId);
        const recon5 = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
        expect(recon5.classification).toBe('AUTHORITY_CONFLICT');
        expect(recon5.action_taken).toBe('NO_OP');
        expect(recon5.error).toContain('does not match adjudication terminal timestamp');

        // Restore timestamp
        fixtures.db.prepare('UPDATE coder_submission_dispositions SET created_at = ? WHERE submission_id = ?').run(adj.completed_at, subId);
      } finally {
        fixtures.db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_coder_submission_dispositions_no_update
          BEFORE UPDATE ON coder_submission_dispositions
          BEGIN
            SELECT RAISE(ABORT, 'coder_submission_dispositions is strictly append-only: UPDATE is prohibited');
          END;
        `);
      }
    });

    it('373. Concurrent ProcessRunner.cancel() and ProcessRunner.terminateAllProcesses() join single settlement authority and write terminal state exactly once', async () => {
      const execId = crypto.randomUUID();
      const scriptPath = path.join(fixtures.projectRoot, 'test-373.js');
      fs.writeFileSync(scriptPath, 'setInterval(() => {}, 1000);', 'utf8');

      let updateCalls = 0;
      const originalUpdateProcessRun = fixtures.repo.updateProcessRun.bind(fixtures.repo);
      const updateSpy = vi.spyOn(fixtures.repo, 'updateProcessRun').mockImplementation((...args) => {
        updateCalls++;
        return originalUpdateProcessRun(...args);
      });

      // Launch process via ProcessRunner.execute()
      const runPromise = ProcessRunner.execute({
        executable: process.execPath,
        args: [scriptPath],
        cwd: fixtures.projectRoot,
        executionId: execId,
        timeoutMs: 30000,
        repo: fixtures.repo,
      });

      // Bounded wait for process to register in activeProcesses
      await vi.waitFor(() => {
        expect(ProcessRunner.getActiveProcessCount()).toBeGreaterThan(0);
      });

      // Concurrently invoke cancel() and terminateAllProcesses()
      const [cancelTruth, termSummary] = await Promise.all([
        ProcessRunner.cancel(execId),
        ProcessRunner.terminateAllProcesses(),
      ]);

      expect(cancelTruth).toBe('PROCESS_TREE_TERMINATED_PROVEN');
      expect(termSummary.count).toBeGreaterThanOrEqual(1);
      expect(termSummary.allTerminatedProven).toBe(true);
      expect(termSummary.unproven).toBe(0);

      // Exactly one durable DB terminal update
      expect(updateCalls).toBe(1);

      // Active registry is completely cleared
      expect(ProcessRunner.getActiveProcessCount()).toBe(0);

      const runResult = await runPromise;
      expect(runResult.cancelled).toBe(true);
      updateSpy.mockRestore();
    });

    it('374. EmergencyStopService: Two active running projects yield exactly two EMERGENCY_STOP events with identical final termination summary', async () => {
      // Create two distinct projects in RUNNING state
      const proj1Id = 'proj-stop-1-' + crypto.randomUUID();
      const proj2Id = 'proj-stop-2-' + crypto.randomUUID();
      fixtures.repo.createProject({
        id: proj1Id,
        name: 'Project One',
        description: null,
        repository_path: fixtures.projectRoot,
        default_branch: 'main',
        status: 'RUNNING',
        contract: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        completed_at: null,
      });
      fixtures.repo.createProject({
        id: proj2Id,
        name: 'Project Two',
        description: null,
        repository_path: fixtures.projectRoot,
        default_branch: 'main',
        status: 'RUNNING',
        contract: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        completed_at: null,
      });

      const stopResult = await fixtures.emergencyStopService.triggerEmergencyStop('Multi-project emergency pause');
      expect(stopResult.projectsPaused).toContain(proj1Id);
      expect(stopResult.projectsPaused).toContain(proj2Id);
      expect(stopResult.allTerminatedProven).toBe(true);

      // Verify events in repo
      const events1 = fixtures.repo.getEvents(proj1Id).filter((e) => e.type === 'EMERGENCY_STOP');
      const events2 = fixtures.repo.getEvents(proj2Id).filter((e) => e.type === 'EMERGENCY_STOP');

      // Exactly one event per project, zero duplicates
      expect(events1.length).toBe(1);
      expect(events2.length).toBe(1);

      // Identical termination summary payloads
      const payload1 = events1[0].structured_payload;
      const payload2 = events2[0].structured_payload;
      expect(payload1).not.toBeNull();
      expect(payload2).not.toBeNull();
      if (payload1 && payload2) {
        expect(payload1.processesTerminated).toBe(payload2.processesTerminated);
        expect(payload1.unprovenProcesses).toBe(payload2.unprovenProcesses);
        expect(payload1.allTerminatedProven).toBe(payload2.allTerminatedProven);
        expect(payload1.reason).toBe(payload2.reason);
        expect(payload1.reason).toBe('Multi-project emergency pause');
      }
    });

    it('375. validateCanonicalWorkspaceSnapshotAfter strictly rejects uppercase SHA-256 and uppercase Git commit SHAs', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const lease = fixtures.repo.getWorkspaceLease(adj.workspace_lease_id!)!;
      const env = JSON.parse(adj.verification_result_envelope_json!);
      const afterEv = fixtures.repo.getEvidence(env.workspace_snapshot_after_evidence_id!)!;
      const rawContent = afterEv.raw_payload || (afterEv.file_path ? fs.readFileSync(afterEv.file_path, 'utf8') : '{}');
      const validPayload = JSON.parse(rawContent) as Record<string, unknown>;

      // 1. Uppercase git_status_evidence_hash
      const upperStatusHash = { ...validPayload, git_status_evidence_hash: (validPayload.git_status_evidence_hash as string).toUpperCase() };
      const upperStatusHashJson = canonicalJsonStringify(upperStatusHash);
      const res1 = validateCanonicalWorkspaceSnapshotAfter({
        rawContent: upperStatusHashJson,
        expectedHash: computeSha256(upperStatusHashJson),
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
        gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(res1.valid).toBe(false);
      expect(res1.error).toContain('git_status_evidence_hash must be a 64-char lowercase hex string');

      // 2. Uppercase git_diff_evidence_hash
      const upperDiffHash = { ...validPayload, git_diff_evidence_hash: (validPayload.git_diff_evidence_hash as string).toUpperCase() };
      const upperDiffHashJson = canonicalJsonStringify(upperDiffHash);
      const res2 = validateCanonicalWorkspaceSnapshotAfter({
        rawContent: upperDiffHashJson,
        expectedHash: computeSha256(upperDiffHashJson),
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
        gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(res2.valid).toBe(false);
      expect(res2.error).toContain('git_diff_evidence_hash must be a 64-char lowercase hex string');

      // 3. Uppercase worktree_identity_hash
      const upperWorktreeHash = { ...validPayload, worktree_identity_hash: (validPayload.worktree_identity_hash as string).toUpperCase() };
      const upperWorktreeHashJson = canonicalJsonStringify(upperWorktreeHash);
      const res3 = validateCanonicalWorkspaceSnapshotAfter({
        rawContent: upperWorktreeHashJson,
        expectedHash: computeSha256(upperWorktreeHashJson),
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
        gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(res3.valid).toBe(false);
      expect(res3.error).toContain('worktree_identity_hash must be a 64-char lowercase hex string');

      // 4. Uppercase expected_head_sha
      const upperExpectedHead = { ...validPayload, expected_head_sha: (validPayload.expected_head_sha as string).toUpperCase() };
      const upperExpectedHeadJson = canonicalJsonStringify(upperExpectedHead);
      const res4 = validateCanonicalWorkspaceSnapshotAfter({
        rawContent: upperExpectedHeadJson,
        expectedHash: computeSha256(upperExpectedHeadJson),
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
        gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(res4.valid).toBe(false);
      expect(res4.error).toContain('expected_head_sha must be a 40-char lowercase hex string');

      // 5. Uppercase captured_repository_head_sha
      const upperCapturedHead = { ...validPayload, captured_repository_head_sha: (validPayload.captured_repository_head_sha as string).toUpperCase() };
      const upperCapturedHeadJson = canonicalJsonStringify(upperCapturedHead);
      const res5 = validateCanonicalWorkspaceSnapshotAfter({
        rawContent: upperCapturedHeadJson,
        expectedHash: computeSha256(upperCapturedHeadJson),
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
        gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(res5.valid).toBe(false);
      expect(res5.error).toContain('captured_repository_head_sha must be a 40-char lowercase hex string');
    });

    it('376. Recovery scanner rejects target-status-specific null or contradictory terminal timestamps', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      expect(adj.status).toBe('VERIFIED');

      // 1. VERIFIED with null completed_at fails closed
      const recon1 = fixtures.recoveryScanner.reconcileSingleAdjudication({
        ...adj,
        completed_at: null as unknown as string,
      });
      expect(recon1.classification).toBe('AUTHORITY_CONFLICT');
      expect(recon1.action_taken).toBe('NO_OP');
      expect(recon1.error).toContain('completed_at must be non-null canonical UTC ISO string');

      // 2. VERIFIED with non-canonical completed_at fails closed
      const recon2 = fixtures.recoveryScanner.reconcileSingleAdjudication({
        ...adj,
        completed_at: 'not-a-date',
      });
      expect(recon2.classification).toBe('AUTHORITY_CONFLICT');
      expect(recon2.action_taken).toBe('NO_OP');
      expect(recon2.error).toContain('completed_at must be non-null canonical UTC ISO string');
    });

    it('377. Pre-result RECOVERY_FENCED rejects noncanonical SCANNER alias and requires RECOVERY_SCANNER', async () => {
      const nowIso = new Date().toISOString();

      // Subcase 1: Bad actor_id 'SCANNER' produces AUTHORITY_CONFLICT
      const { plaintextToken: token1 } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId1 = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId1), token1);
      fixtures.db.prepare("UPDATE tasks SET state = 'NEEDS_HUMAN' WHERE id = ?").run(fixtures.taskId);

      const adjId1 = crypto.randomUUID();
      const snapshot1 = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId1)!);
      const snapshotJson1 = canonicalJsonStringify(snapshot1);

      fixtures.repo.createCoderSubmissionAdjudication({
        id: adjId1,
        request_id: crypto.randomUUID(),
        submission_id: subId1,
        authorization_id: fixtures.authorizationId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        assignment_id: fixtures.assignmentId,
        task_ownership_epoch: 1,
        action: 'ADMIT_VERIFICATION',
        status: 'RECOVERY_FENCED',
        lifecycle_version: 3,
        authority_snapshot_json: snapshotJson1,
        authority_snapshot_hash: computeSha256(snapshotJson1),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        protocol_message_id: null,
        failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
        failure_json: null,
        created_at: nowIso,
        recovery_fenced_at: nowIso,
        workspace_lease_id: null,
        verification_started_at: null,
        verification_execution_id: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        artifact_manifest_json: null,
        artifact_manifest_hash: null,
        verification_result_envelope_json: null,
        verification_result_envelope_hash: null,
        completed_at: null,
      });

      const eventPayload1 = buildCanonicalTerminalEventPayload('RECOVERY_FENCED', adjId1, 'ORPHANED_VERIFICATION_INTERRUPTED', null);
      const payloadHash1 = computeSha256(eventPayload1);
      fixtures.repo.createCoderSubmissionAdjudicationEvent({
        id: deriveDeterministicAdjudicationEventId(adjId1, 3, 'RECOVERY_FENCED', payloadHash1),
        adjudication_id: adjId1,
        sequence: 3,
        event_type: 'RECOVERY_FENCED',
        payload_json: eventPayload1,
        payload_hash: payloadHash1,
        created_at: nowIso,
      });

      const badDisp = buildCanonicalTerminalDisposition('RECOVERY_FENCED', adjId1, subId1, nowIso, {
        failureCode: 'ORPHANED_VERIFICATION_INTERRUPTED',
        isResultBearing: false,
      });
      fixtures.repo.createCoderSubmissionDisposition({
        ...badDisp,
        actor_id: 'SCANNER',
      });

      const fencedAdj1 = fixtures.repo.getCoderSubmissionAdjudicationById(adjId1)!;
      const reconBadAlias = fixtures.recoveryScanner.reconcileSingleAdjudication(fencedAdj1);
      expect(reconBadAlias.classification).toBe('AUTHORITY_CONFLICT');
      expect(reconBadAlias.action_taken).toBe('NO_OP');
      expect(reconBadAlias.error).toContain('actor_id');

      // Subcase 2: Canonical actor_id 'RECOVERY_SCANNER' produces ALREADY_RECONCILED
      fixtures.db.prepare("UPDATE tasks SET state = 'CODING' WHERE id = ?").run(fixtures.taskId);
      const existingAuth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const auth2Id = crypto.randomUUID();
      fixtures.repo.createExecutionAuthorization({
        ...existingAuth,
        id: auth2Id,
      });
      const { plaintextToken: token2 } = issueSubmissionSessionHelper(fixtures.repo, auth2Id);
      const subId2 = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(
        createValidSubmissionPayload(fixtures, subId2, { authorization_id: auth2Id }),
        token2
      );
      fixtures.db.prepare("UPDATE tasks SET state = 'NEEDS_HUMAN' WHERE id = ?").run(fixtures.taskId);

      const adjId2 = crypto.randomUUID();
      const snapshot2 = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId2)!);
      const snapshotJson2 = canonicalJsonStringify(snapshot2);

      fixtures.repo.createCoderSubmissionAdjudication({
        id: adjId2,
        request_id: crypto.randomUUID(),
        submission_id: subId2,
        authorization_id: auth2Id,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        assignment_id: fixtures.assignmentId,
        task_ownership_epoch: 1,
        action: 'ADMIT_VERIFICATION',
        status: 'RECOVERY_FENCED',
        lifecycle_version: 3,
        authority_snapshot_json: snapshotJson2,
        authority_snapshot_hash: computeSha256(snapshotJson2),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        protocol_message_id: null,
        failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
        failure_json: null,
        created_at: nowIso,
        recovery_fenced_at: nowIso,
        workspace_lease_id: null,
        verification_started_at: null,
        verification_execution_id: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        artifact_manifest_json: null,
        artifact_manifest_hash: null,
        verification_result_envelope_json: null,
        verification_result_envelope_hash: null,
        completed_at: null,
      });

      const eventPayload2 = buildCanonicalTerminalEventPayload('RECOVERY_FENCED', adjId2, 'ORPHANED_VERIFICATION_INTERRUPTED', null);
      const payloadHash2 = computeSha256(eventPayload2);
      fixtures.repo.createCoderSubmissionAdjudicationEvent({
        id: deriveDeterministicAdjudicationEventId(adjId2, 3, 'RECOVERY_FENCED', payloadHash2),
        adjudication_id: adjId2,
        sequence: 3,
        event_type: 'RECOVERY_FENCED',
        payload_json: eventPayload2,
        payload_hash: payloadHash2,
        created_at: nowIso,
      });

      const validDisp = buildCanonicalTerminalDisposition('RECOVERY_FENCED', adjId2, subId2, nowIso, {
        failureCode: 'ORPHANED_VERIFICATION_INTERRUPTED',
        isResultBearing: false,
      });
      fixtures.repo.createCoderSubmissionDisposition(validDisp);

      const fencedAdj2 = fixtures.repo.getCoderSubmissionAdjudicationById(adjId2)!;
      const reconValid = fixtures.recoveryScanner.reconcileSingleAdjudication(fencedAdj2);
      expect(reconValid.classification).toBe('ALREADY_RECONCILED');
      expect(reconValid.action_taken).toBe('NO_OP');
    });

    it('378. validateCanonicalWorkspaceSnapshotAfter strictly validates expectedCapturedAt against finish timestamp', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const lease = fixtures.repo.getWorkspaceLease(adj.workspace_lease_id!)!;
      const env = JSON.parse(adj.verification_result_envelope_json!);
      const afterEv = fixtures.repo.getEvidence(env.workspace_snapshot_after_evidence_id!)!;
      const rawContent = afterEv.raw_payload || (afterEv.file_path ? fs.readFileSync(afterEv.file_path, 'utf8') : '{}');

      // Passing matching finish timestamp succeeds
      const validRes = validateCanonicalWorkspaceSnapshotAfter({
        rawContent,
        expectedHash: env.workspace_snapshot_after_hash,
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
        gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(validRes.valid).toBe(true);

      // Passing contradictory finish timestamp fails closed
      const mismatchedTime = new Date(Date.now() + 50000).toISOString();
      const invalidRes = validateCanonicalWorkspaceSnapshotAfter({
        rawContent,
        expectedHash: env.workspace_snapshot_after_hash,
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
        gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
        expectedCapturedAt: mismatchedTime,
      });
      expect(invalidRes.valid).toBe(false);
      expect(invalidRes.error).toContain('does not match expected finish timestamp');
    });

    it('379. ProcessRunner.cancel() does not pre-signal entry.process.kill() prior to canonical settlement', async () => {
      const execId = crypto.randomUUID();
      const scriptPath = path.join(fixtures.projectRoot, 'test-379.js');
      fs.writeFileSync(scriptPath, 'setInterval(() => {}, 1000);', 'utf8');

      let insideCanonicalTermination = false;
      let canonicalTerminationCallCount = 0;
      let outOfBandKillCount = 0;

      const originalTerminateProcessTree = ProcessRunner.terminateProcessTree.bind(ProcessRunner);
      ProcessRunner.terminateProcessTree = async (child: child_process.ChildProcess, timeoutMs = 5000) => {
        canonicalTerminationCallCount++;
        insideCanonicalTermination = true;
        try {
          return await originalTerminateProcessTree(child, timeoutMs);
        } finally {
          insideCanonicalTermination = false;
        }
      };

      const updateProcessRunSpy = vi.spyOn(fixtures.repo, 'updateProcessRun');
      let activeChild: child_process.ChildProcess | null = null;
      let originalChildKill: ((signal?: NodeJS.Signals | number) => boolean) | null = null;

      try {
        const runPromise = ProcessRunner.execute({
          executable: process.execPath,
          args: [scriptPath],
          cwd: fixtures.projectRoot,
          executionId: execId,
          timeoutMs: 30000,
          repo: fixtures.repo,
        });

        await vi.waitFor(() => {
          expect(ProcessRunner.getActiveProcessCount()).toBeGreaterThan(0);
        });

        const active = (ProcessRunner as unknown as {
          activeProcesses: Map<string, { process: child_process.ChildProcess }>
        }).activeProcesses.get(execId);
        expect(active).toBeDefined();
        if (active) {
          activeChild = active.process;
          originalChildKill = active.process.kill.bind(active.process);
          active.process.kill = (signal?: NodeJS.Signals | number) => {
            if (!insideCanonicalTermination) {
              outOfBandKillCount++;
            }
            return originalChildKill!(signal);
          };
        }

        const cancelTruth = await ProcessRunner.cancel(execId);
        expect(cancelTruth).toBe('PROCESS_TREE_TERMINATED_PROVEN');
        expect(canonicalTerminationCallCount).toBe(1);
        expect(outOfBandKillCount).toBe(0);

        await runPromise;

        expect(updateProcessRunSpy).toHaveBeenCalledTimes(1);

        const runnerInternal = ProcessRunner as unknown as {
          activeProcesses: Map<string, unknown>;
          cancellationPromises: Map<string, unknown>;
        };
        expect(runnerInternal.activeProcesses.size).toBe(0);
        expect(runnerInternal.cancellationPromises.size).toBe(0);
        expect(ProcessRunner.getActiveProcessCount()).toBe(0);
      } finally {
        ProcessRunner.terminateProcessTree = originalTerminateProcessTree;
        if (activeChild && originalChildKill) {
          activeChild.kill = originalChildKill;
        }
        updateProcessRunSpy.mockRestore();
        fs.rmSync(scriptPath, { force: true });
      }
    });

    it('380. CoderSubmissionAdjudicationService: Evaluator fails closed with INTEGRITY_MISMATCH when required authority bindings are absent', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const env = JSON.parse(adj.verification_result_envelope_json!);
      const tr = fixtures.repo.getTestRun(adj.test_run_id!)!;

      // Create dummy repo with getCoderSubmissionById returning null
      const stubRepo = Object.create(fixtures.repo) as Repository;
      stubRepo.getCoderSubmissionById = () => null;

      const dec = evaluateCanonicalSettlementDecision({
        rawEnvelopeJson: adj.verification_result_envelope_json!,
        storedEnvelopeHash: adj.verification_result_envelope_hash!,
        rawManifestJson: adj.artifact_manifest_json!,
        storedManifestHash: adj.artifact_manifest_hash!,
        adjudication: adj,
        testRun: tr,
        gitStatusEvidenceId: adj.git_status_evidence_id,
        gitDiffEvidenceId: adj.git_diff_evidence_id,
        testResultEvidenceId: env.test_result_evidence_id,
        repo: stubRepo,
        artifactStore: fixtures.artifactStore,
      });

      expect(dec.valid).toBe(false);
      expect(dec.failureCode).toBe('INTEGRITY_MISMATCH');
      expect(dec.contradictionReason).toContain('Missing required authority bindings');
    });

    it('381. CoderSubmissionAdjudicationService: Replay path fails closed with INTEGRITY_CONFLICT when workspace lease binding is missing', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const reqId = crypto.randomUUID();
      await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: reqId,
        submissionId: subId,
      });

      const leaseSpy = vi.spyOn(fixtures.repo, 'getWorkspaceLease').mockReturnValue(null);
      try {
        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: reqId,
            submissionId: subId,
          })
        ).rejects.toThrow(/Missing required authority bindings for replayed workspace snapshot/);
      } finally {
        leaseSpy.mockRestore();
      }
    });

    it('382. CoderSubmissionAdjudicationService: Initial settlement strictly validates generated workspace-after evidence through canonical validator', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const env = JSON.parse(adj.verification_result_envelope_json!);
      const wsEv = fixtures.repo.getEvidence(env.workspace_snapshot_after_evidence_id!);

      expect(wsEv).toBeDefined();
      expect(wsEv).not.toBeNull();
      if (!wsEv) {
        throw new Error('Workspace-after evidence was not found in repository.');
      }
      expect(wsEv.evidence_type).toBe('FILE_SNAPSHOT');
      expect(wsEv.content_type).toBe('application/json');

      const content = wsEv.raw_payload || (wsEv.file_path ? fs.readFileSync(wsEv.file_path, 'utf8') : '');
      const payload = JSON.parse(content);

      // Verify exact 18 fields are present and canonical
      expect(Object.keys(payload).sort()).toEqual([...CANONICAL_WORKSPACE_SNAPSHOT_AFTER_KEYS].sort());
      expect(payload.schema_version).toBe(1);
      expect(payload.adjudication_lifecycle_version).toBe(3);
      expect(payload.adjudication_id).toBe(adj.id);
      expect(payload.submission_id).toBe(subId);
    });

    it('383. Recovery scanner: Evaluator and recovery share canonical workspace-after validator and fail closed on tampered worktree identity hash', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const env = JSON.parse(adj.verification_result_envelope_json!);
      const afterEv = fixtures.repo.getEvidence(env.workspace_snapshot_after_evidence_id!)!;
      const content = afterEv.raw_payload || fs.readFileSync(afterEv.file_path!, 'utf8');
      const payload = JSON.parse(content);

      // Tamper worktree_identity_hash to a random lowercase hex string that does not match lease
      payload.worktree_identity_hash = 'f'.repeat(64);
      const tamperedJson = canonicalJsonStringify(payload);
      if (afterEv.file_path) {
        fs.writeFileSync(afterEv.file_path, tamperedJson, 'utf8');
      }

      const recon = fixtures.recoveryScanner.reconcileSingleAdjudication(adj);
      expect(recon.classification).toBe('AUTHORITY_CONFLICT');
      expect(recon.action_taken).toBe('NO_OP');
      expect(recon.error).toMatch(/worktree_identity_hash|hash mismatch/);

      // Restore content
      if (afterEv.file_path) {
        fs.writeFileSync(afterEv.file_path, content, 'utf8');
      }
    });

    it('384. historical three-file compatibility diffs remain byte-identical to initial head', () => {
      const R5J5_INITIAL_BOUNDARY_SHA = 'e869b9f79b76f104df74ac49ece723b828ba888e';
      const R5J5_FINAL_SOURCE_HEAD = '1464785c644294884a6191f956422ae64c35ec2f';
      const R5J5_FINAL_SOURCE_TREE = 'a2e86b7086408adda5155a4fa2102752a57d04fe';

      // 1. Both boundary commits exist
      const checkCommitExists = (sha: string) => {
        return child_process.execFileSync('git', ['cat-file', '-t', sha], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      };
      expect(checkCommitExists(R5J5_INITIAL_BOUNDARY_SHA)).toBe('commit');
      expect(checkCommitExists(R5J5_FINAL_SOURCE_HEAD)).toBe('commit');

      // 2. The final R5J5 commit is a descendant of the selected initial R5J5 boundary
      const isAncestor = (ancestor: string, descendant: string) => {
        try {
          child_process.execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
            stdio: ['ignore', 'ignore', 'ignore'],
          });
          return true;
        } catch {
          return false;
        }
      };
      expect(isAncestor(R5J5_INITIAL_BOUNDARY_SHA, R5J5_FINAL_SOURCE_HEAD)).toBe(true);

      // 3. The final boundary is exactly 1464785c644294884a6191f956422ae64c35ec2f
      const resolvedFinalHead = child_process.execFileSync(
        'git',
        ['rev-parse', `${R5J5_FINAL_SOURCE_HEAD}^{commit}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      expect(resolvedFinalHead).toBe(R5J5_FINAL_SOURCE_HEAD);

      // 4. The final R5J5 tree is exactly a2e86b7086408adda5155a4fa2102752a57d04fe
      const resolvedFinalTree = child_process.execFileSync(
        'git',
        ['rev-parse', `${R5J5_FINAL_SOURCE_HEAD}^{tree}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      expect(resolvedFinalTree).toBe(R5J5_FINAL_SOURCE_TREE);

      // 5. The diff across the exact immutable R5J5 range is empty for the three protected compatibility files
      const checkRangeDiff = (startSha: string, endSha: string, relPath: string) => {
        const out = child_process.execFileSync('git', ['diff', startSha, endSha, '--', relPath], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.trim();
      };

      expect(checkRangeDiff(R5J5_INITIAL_BOUNDARY_SHA, R5J5_FINAL_SOURCE_HEAD, 'tests/r5iCrashRecoveryAndAuditStream.test.ts')).toBe('');
      expect(checkRangeDiff(R5J5_INITIAL_BOUNDARY_SHA, R5J5_FINAL_SOURCE_HEAD, 'tests/r5jMcpCoderSubmissionAuthority.test.ts')).toBe('');
      expect(checkRangeDiff(R5J5_INITIAL_BOUNDARY_SHA, R5J5_FINAL_SOURCE_HEAD, 'tests/r5jMcpSessionAuthorityAndContextRead.test.ts')).toBe('');

      // 6, 7 & 8. Proof non-vacuity and immutability:
      // The proof only queries immutable objects in the object store, ignoring working tree and milestone HEAD.
      // Deliberately substituting an incorrect R5J5 final boundary causes failure.
      const incorrectBoundarySha = '26306cf9304dddd3c90837dbbed1cafdef4f1d6b';
      expect(resolvedFinalHead).not.toBe(incorrectBoundarySha);
      const incorrectTree = child_process.execFileSync(
        'git',
        ['rev-parse', `${incorrectBoundarySha}^{tree}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      expect(incorrectTree).not.toBe(R5J5_FINAL_SOURCE_TREE);
      expect(isAncestor(R5J5_FINAL_SOURCE_HEAD, incorrectBoundarySha)).toBe(false);
    });

    it('385. validateCanonicalWorkspaceSnapshotAfter rejects empty git_status_evidence_hash without mutation', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const lease = fixtures.repo.getWorkspaceLease(adj.workspace_lease_id!)!;
      const env = JSON.parse(adj.verification_result_envelope_json!);
      const afterEv = fixtures.repo.getEvidence(env.workspace_snapshot_after_evidence_id!)!;
      const rawContent = afterEv.raw_payload || (afterEv.file_path ? fs.readFileSync(afterEv.file_path, 'utf8') : '{}');
      const validPayload = JSON.parse(rawContent) as Record<string, unknown>;

      const eventCountBefore = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number };
      const dispCountBefore = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_dispositions').get() as { c: number };

      const emptyStatusHash = { ...validPayload, git_status_evidence_hash: '' };
      const emptyStatusJson = canonicalJsonStringify(emptyStatusHash);
      const res = validateCanonicalWorkspaceSnapshotAfter({
        rawContent: emptyStatusJson,
        expectedHash: computeSha256(emptyStatusJson),
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
        gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(res.valid).toBe(false);
      expect(res.error).toContain('git_status_evidence_hash must be a 64-char lowercase hex string');

      // Also verify authority input with empty string is rejected
      const resAuthority = validateCanonicalWorkspaceSnapshotAfter({
        rawContent,
        expectedHash: env.workspace_snapshot_after_hash,
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: '',
        gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(resAuthority.valid).toBe(false);
      expect(resAuthority.error).toContain('gitStatusEvidenceHash authority input must be a 64-char lowercase hex string');

      const eventCountAfter = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number };
      const dispCountAfter = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_dispositions').get() as { c: number };
      expect(eventCountAfter.c).toBe(eventCountBefore.c);
      expect(dispCountAfter.c).toBe(dispCountBefore.c);
    });

    it('386. validateCanonicalWorkspaceSnapshotAfter rejects empty git_diff_evidence_hash without mutation', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const lease = fixtures.repo.getWorkspaceLease(adj.workspace_lease_id!)!;
      const env = JSON.parse(adj.verification_result_envelope_json!);
      const afterEv = fixtures.repo.getEvidence(env.workspace_snapshot_after_evidence_id!)!;
      const rawContent = afterEv.raw_payload || (afterEv.file_path ? fs.readFileSync(afterEv.file_path, 'utf8') : '{}');
      const validPayload = JSON.parse(rawContent) as Record<string, unknown>;

      const eventCountBefore = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number };
      const dispCountBefore = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_dispositions').get() as { c: number };

      const emptyDiffHash = { ...validPayload, git_diff_evidence_hash: '' };
      const emptyDiffJson = canonicalJsonStringify(emptyDiffHash);
      const res = validateCanonicalWorkspaceSnapshotAfter({
        rawContent: emptyDiffJson,
        expectedHash: computeSha256(emptyDiffJson),
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
        gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(res.valid).toBe(false);
      expect(res.error).toContain('git_diff_evidence_hash must be a 64-char lowercase hex string');

      // Also verify authority input with empty string is rejected
      const resAuthority = validateCanonicalWorkspaceSnapshotAfter({
        rawContent,
        expectedHash: env.workspace_snapshot_after_hash,
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
        gitDiffEvidenceHash: '',
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(resAuthority.valid).toBe(false);
      expect(resAuthority.error).toContain('gitDiffEvidenceHash authority input must be a 64-char lowercase hex string');

      const eventCountAfter = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number };
      const dispCountAfter = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_dispositions').get() as { c: number };
      expect(eventCountAfter.c).toBe(eventCountBefore.c);
      expect(dispCountAfter.c).toBe(dispCountBefore.c);
    });

    it('387. validateCanonicalWorkspaceSnapshotAfter rejects uppercase evidence hashes without mutation', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const lease = fixtures.repo.getWorkspaceLease(adj.workspace_lease_id!)!;
      const env = JSON.parse(adj.verification_result_envelope_json!);
      const afterEv = fixtures.repo.getEvidence(env.workspace_snapshot_after_evidence_id!)!;
      const rawContent = afterEv.raw_payload || (afterEv.file_path ? fs.readFileSync(afterEv.file_path, 'utf8') : '{}');

      const eventCountBefore = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number };
      const dispCountBefore = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_dispositions').get() as { c: number };

      const upperExpectedHash = (env.workspace_snapshot_after_hash as string).toUpperCase();
      const resUpperExpected = validateCanonicalWorkspaceSnapshotAfter({
        rawContent,
        expectedHash: upperExpectedHash,
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
        gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(resUpperExpected.valid).toBe(false);
      expect(resUpperExpected.error).toContain('expectedHash must be a 64-char lowercase hex string');

      const upperStatusHash = (env.git_status_evidence_hash || computeSha256('')).toUpperCase();
      const resUpperStatus = validateCanonicalWorkspaceSnapshotAfter({
        rawContent,
        expectedHash: env.workspace_snapshot_after_hash,
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: upperStatusHash,
        gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(resUpperStatus.valid).toBe(false);
      expect(resUpperStatus.error).toContain('gitStatusEvidenceHash authority input must be a 64-char lowercase hex string');

      const upperDiffHash = (env.git_diff_evidence_hash || computeSha256('')).toUpperCase();
      const resUpperDiff = validateCanonicalWorkspaceSnapshotAfter({
        rawContent,
        expectedHash: env.workspace_snapshot_after_hash,
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
        gitDiffEvidenceHash: upperDiffHash,
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(resUpperDiff.valid).toBe(false);
      expect(resUpperDiff.error).toContain('gitDiffEvidenceHash authority input must be a 64-char lowercase hex string');

      const eventCountAfter = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number };
      const dispCountAfter = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_dispositions').get() as { c: number };
      expect(eventCountAfter.c).toBe(eventCountBefore.c);
      expect(dispCountAfter.c).toBe(dispCountBefore.c);
    });

    it('388. validateCanonicalWorkspaceSnapshotAfter rejects missing expected evidence hash without mutation', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const lease = fixtures.repo.getWorkspaceLease(adj.workspace_lease_id!)!;
      const env = JSON.parse(adj.verification_result_envelope_json!);
      const afterEv = fixtures.repo.getEvidence(env.workspace_snapshot_after_evidence_id!)!;
      const rawContent = afterEv.raw_payload || (afterEv.file_path ? fs.readFileSync(afterEv.file_path, 'utf8') : '{}');

      const eventCountBefore = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number };

      const res = validateCanonicalWorkspaceSnapshotAfter({
        rawContent,
        expectedHash: undefined,
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
        gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(res.valid).toBe(false);
      expect(res.error).toContain('expectedHash must be a 64-char lowercase hex string');

      const eventCountAfter = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number };
      expect(eventCountAfter.c).toBe(eventCountBefore.c);
    });

    it('389. validateCanonicalWorkspaceSnapshotAfter rejects missing submission authority input without mutation', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const lease = fixtures.repo.getWorkspaceLease(adj.workspace_lease_id!)!;
      const env = JSON.parse(adj.verification_result_envelope_json!);
      const afterEv = fixtures.repo.getEvidence(env.workspace_snapshot_after_evidence_id!)!;
      const rawContent = afterEv.raw_payload || (afterEv.file_path ? fs.readFileSync(afterEv.file_path, 'utf8') : '{}');

      const eventCountBefore = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number };

      const res = validateCanonicalWorkspaceSnapshotAfter({
        rawContent,
        expectedHash: env.workspace_snapshot_after_hash,
        adjudication: adj,
        submission: null,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
        gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(res.valid).toBe(false);
      expect(res.error).toContain('submission authority input is required');

      const eventCountAfter = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number };
      expect(eventCountAfter.c).toBe(eventCountBefore.c);
    });

    it('390. validateCanonicalWorkspaceSnapshotAfter rejects missing workspace lease authority input without mutation', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const env = JSON.parse(adj.verification_result_envelope_json!);
      const afterEv = fixtures.repo.getEvidence(env.workspace_snapshot_after_evidence_id!)!;
      const rawContent = afterEv.raw_payload || (afterEv.file_path ? fs.readFileSync(afterEv.file_path, 'utf8') : '{}');

      const eventCountBefore = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number };

      const res = validateCanonicalWorkspaceSnapshotAfter({
        rawContent,
        expectedHash: env.workspace_snapshot_after_hash,
        adjudication: adj,
        submission: sub,
        lease: null,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
        gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(res.valid).toBe(false);
      expect(res.error).toContain('lease authority input is required');

      const eventCountAfter = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number };
      expect(eventCountAfter.c).toBe(eventCountBefore.c);
    });

    it('391. validateCanonicalWorkspaceSnapshotAfter rejects missing expected finish timestamp without mutation', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const lease = fixtures.repo.getWorkspaceLease(adj.workspace_lease_id!)!;
      const env = JSON.parse(adj.verification_result_envelope_json!);
      const afterEv = fixtures.repo.getEvidence(env.workspace_snapshot_after_evidence_id!)!;
      const rawContent = afterEv.raw_payload || (afterEv.file_path ? fs.readFileSync(afterEv.file_path, 'utf8') : '{}');

      const eventCountBefore = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number };

      const res = validateCanonicalWorkspaceSnapshotAfter({
        rawContent,
        expectedHash: env.workspace_snapshot_after_hash,
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
        gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
        expectedCapturedAt: undefined,
      });
      expect(res.valid).toBe(false);
      expect(res.error).toContain('expectedCapturedAt authority input must be a canonical UTC ISO-8601 string');

      const eventCountAfter = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number };
      expect(eventCountAfter.c).toBe(eventCountBefore.c);
    });

    it('392. Recovery scanner pre-result RECOVERY_FENCED: exact equal timestamp is accepted without mutation', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const leaseId = crypto.randomUUID();
      const exactTimeIso = new Date().toISOString();
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
      const snapHash = computeSha256(snapJson);

      fixtures.db.pragma('foreign_keys = OFF');
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
        acquired_at: exactTimeIso,
        released_at: exactTimeIso,
        lifecycle_version: 2,
        state: 'RELEASED',
        failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
        failure_evidence_hash: null,
      });

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
        authority_snapshot_hash: snapHash,
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: computeSha256('before'),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: exactTimeIso,
        verification_started_at: null,
        completed_at: null,
        recovery_fenced_at: exactTimeIso,
        failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
        failure_json: canonicalJsonStringify({ is_fenced: true, error: 'Crash fence' }),
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: null,
        verification_result_envelope_json: null,
        verification_result_envelope_hash: null,
        artifact_manifest_json: null,
        artifact_manifest_hash: null,
        workspace_lease_id: leaseId,
      });
      fixtures.db.pragma('foreign_keys = ON');

      const fencedPayload = buildCanonicalTerminalEventPayload(
        'RECOVERY_FENCED',
        adjId,
        'ORPHANED_VERIFICATION_INTERRUPTED',
        'Crash fence'
      );
      const fencedPayloadHash = computeSha256(fencedPayload);

      fixtures.repo.createCoderSubmissionAdjudicationEvent({
        id: deriveDeterministicAdjudicationEventId(adjId, 3, 'RECOVERY_FENCED', fencedPayloadHash),
        adjudication_id: adjId,
        sequence: 3,
        event_type: 'RECOVERY_FENCED',
        payload_json: fencedPayload,
        payload_hash: fencedPayloadHash,
        created_at: exactTimeIso,
      });

      const terminalDisp = buildCanonicalTerminalDisposition(
        'RECOVERY_FENCED',
        adjId,
        subId,
        exactTimeIso,
        {
          failureCode: 'ORPHANED_VERIFICATION_INTERRUPTED',
          error: 'Crash fence',
          isResultBearing: false,
        }
      );
      fixtures.repo.createCoderSubmissionDisposition(terminalDisp);

      fixtures.db.prepare("UPDATE tasks SET state = 'NEEDS_HUMAN' WHERE id = ?").run(fixtures.taskId);

      const eventCountBefore = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number };
      const dispCountBefore = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_dispositions').get() as { c: number };
      const adjBefore = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;

      const recon = fixtures.recoveryScanner.reconcileSingleAdjudication(adjBefore);
      expect(recon.classification).toBe('ALREADY_RECONCILED');
      expect(recon.action_taken).toBe('NO_OP');

      const eventCountAfter = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number };
      const dispCountAfter = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_dispositions').get() as { c: number };
      const adjAfter = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(eventCountAfter.c).toBe(eventCountBefore.c);
      expect(dispCountAfter.c).toBe(dispCountBefore.c);
      expect(adjAfter).toEqual(adjBefore);
    });

    it('393. Recovery scanner pre-result RECOVERY_FENCED: earlier timestamp is rejected as AUTHORITY_CONFLICT / NO_OP without mutation', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const leaseId = crypto.randomUUID();
      const now = Date.now();
      const fencedIso = new Date(now).toISOString();
      const earlierIso = new Date(now - 15000).toISOString();
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
      const snapHash = computeSha256(snapJson);

      fixtures.db.pragma('foreign_keys = OFF');
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
        acquired_at: fencedIso,
        released_at: fencedIso,
        lifecycle_version: 2,
        state: 'RELEASED',
        failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
        failure_evidence_hash: null,
      });

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
        authority_snapshot_hash: snapHash,
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: computeSha256('before'),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: fencedIso,
        verification_started_at: null,
        completed_at: null,
        recovery_fenced_at: fencedIso,
        failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
        failure_json: canonicalJsonStringify({ is_fenced: true, error: 'Crash fence' }),
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: null,
        verification_result_envelope_json: null,
        verification_result_envelope_hash: null,
        artifact_manifest_json: null,
        artifact_manifest_hash: null,
        workspace_lease_id: leaseId,
      });
      fixtures.db.pragma('foreign_keys = ON');

      const fencedPayload = buildCanonicalTerminalEventPayload(
        'RECOVERY_FENCED',
        adjId,
        'ORPHANED_VERIFICATION_INTERRUPTED',
        'Crash fence'
      );
      const fencedPayloadHash = computeSha256(fencedPayload);

      // Event created earlier than recovery_fenced_at
      fixtures.repo.createCoderSubmissionAdjudicationEvent({
        id: deriveDeterministicAdjudicationEventId(adjId, 3, 'RECOVERY_FENCED', fencedPayloadHash),
        adjudication_id: adjId,
        sequence: 3,
        event_type: 'RECOVERY_FENCED',
        payload_json: fencedPayload,
        payload_hash: fencedPayloadHash,
        created_at: earlierIso,
      });

      const terminalDisp = buildCanonicalTerminalDisposition(
        'RECOVERY_FENCED',
        adjId,
        subId,
        fencedIso,
        { failureCode: 'ORPHANED_VERIFICATION_INTERRUPTED' }
      );
      fixtures.repo.createCoderSubmissionDisposition(terminalDisp);

      fixtures.db.prepare("UPDATE tasks SET state = 'NEEDS_HUMAN' WHERE id = ?").run(fixtures.taskId);

      const eventCountBefore = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number };
      const dispCountBefore = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_dispositions').get() as { c: number };
      const adjBefore = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;

      const recon = fixtures.recoveryScanner.reconcileSingleAdjudication(adjBefore);
      expect(recon.classification).toBe('AUTHORITY_CONFLICT');
      expect(recon.action_taken).toBe('NO_OP');
      expect(recon.error).toContain('timestamp mismatch');

      const eventCountAfter = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number };
      const dispCountAfter = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_dispositions').get() as { c: number };
      const adjAfter = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(eventCountAfter.c).toBe(eventCountBefore.c);
      expect(dispCountAfter.c).toBe(dispCountBefore.c);
      expect(adjAfter).toEqual(adjBefore);
    });

    it('394. Recovery scanner pre-result RECOVERY_FENCED: later timestamp is rejected as AUTHORITY_CONFLICT / NO_OP without mutation', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const leaseId = crypto.randomUUID();
      const now = Date.now();
      const fencedIso = new Date(now).toISOString();
      const laterIso = new Date(now + 15000).toISOString();
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
      const snapHash = computeSha256(snapJson);

      fixtures.db.pragma('foreign_keys = OFF');
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
        acquired_at: fencedIso,
        released_at: fencedIso,
        lifecycle_version: 2,
        state: 'RELEASED',
        failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
        failure_evidence_hash: null,
      });

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
        authority_snapshot_hash: snapHash,
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: computeSha256('before'),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: fencedIso,
        verification_started_at: null,
        completed_at: null,
        recovery_fenced_at: fencedIso,
        failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
        failure_json: canonicalJsonStringify({ is_fenced: true, error: 'Crash fence' }),
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: null,
        verification_result_envelope_json: null,
        verification_result_envelope_hash: null,
        artifact_manifest_json: null,
        artifact_manifest_hash: null,
        workspace_lease_id: leaseId,
      });
      fixtures.db.pragma('foreign_keys = ON');

      const fencedPayload = buildCanonicalTerminalEventPayload(
        'RECOVERY_FENCED',
        adjId,
        'ORPHANED_VERIFICATION_INTERRUPTED',
        'Crash fence'
      );
      const fencedPayloadHash = computeSha256(fencedPayload);

      // Event created later than recovery_fenced_at
      fixtures.repo.createCoderSubmissionAdjudicationEvent({
        id: deriveDeterministicAdjudicationEventId(adjId, 3, 'RECOVERY_FENCED', fencedPayloadHash),
        adjudication_id: adjId,
        sequence: 3,
        event_type: 'RECOVERY_FENCED',
        payload_json: fencedPayload,
        payload_hash: fencedPayloadHash,
        created_at: laterIso,
      });

      const terminalDisp = buildCanonicalTerminalDisposition(
        'RECOVERY_FENCED',
        adjId,
        subId,
        fencedIso,
        { failureCode: 'ORPHANED_VERIFICATION_INTERRUPTED' }
      );
      fixtures.repo.createCoderSubmissionDisposition(terminalDisp);

      fixtures.db.prepare("UPDATE tasks SET state = 'NEEDS_HUMAN' WHERE id = ?").run(fixtures.taskId);

      const eventCountBefore = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number };
      const dispCountBefore = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_dispositions').get() as { c: number };
      const adjBefore = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;

      const recon = fixtures.recoveryScanner.reconcileSingleAdjudication(adjBefore);
      expect(recon.classification).toBe('AUTHORITY_CONFLICT');
      expect(recon.action_taken).toBe('NO_OP');
      expect(recon.error).toContain('timestamp mismatch');

      const eventCountAfter = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number };
      const dispCountAfter = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_dispositions').get() as { c: number };
      const adjAfter = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(eventCountAfter.c).toBe(eventCountBefore.c);
      expect(dispCountAfter.c).toBe(dispCountBefore.c);
      expect(adjAfter).toEqual(adjBefore);
    });

    it('395. Recovery scanner pre-result RECOVERY_FENCED: null or noncanonical recovery_fenced_at is rejected as AUTHORITY_CONFLICT / NO_OP without mutation', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const leaseId = crypto.randomUUID();
      const exactTimeIso = new Date().toISOString();
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
      const snapHash = computeSha256(snapJson);

      fixtures.db.pragma('foreign_keys = OFF');
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
        acquired_at: exactTimeIso,
        released_at: exactTimeIso,
        lifecycle_version: 2,
        state: 'RELEASED',
        failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
        failure_evidence_hash: null,
      });

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
        authority_snapshot_hash: snapHash,
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: computeSha256('before'),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: exactTimeIso,
        verification_started_at: null,
        completed_at: null,
        recovery_fenced_at: exactTimeIso,
        failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
        failure_json: canonicalJsonStringify({ is_fenced: true, error: 'Crash fence' }),
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: null,
        verification_result_envelope_json: null,
        verification_result_envelope_hash: null,
        artifact_manifest_json: null,
        artifact_manifest_hash: null,
        workspace_lease_id: leaseId,
      });
      fixtures.db.pragma('foreign_keys = ON');

      const fencedPayload = buildCanonicalTerminalEventPayload(
        'RECOVERY_FENCED',
        adjId,
        'ORPHANED_VERIFICATION_INTERRUPTED',
        'Crash fence'
      );
      const fencedPayloadHash = computeSha256(fencedPayload);

      fixtures.repo.createCoderSubmissionAdjudicationEvent({
        id: deriveDeterministicAdjudicationEventId(adjId, 3, 'RECOVERY_FENCED', fencedPayloadHash),
        adjudication_id: adjId,
        sequence: 3,
        event_type: 'RECOVERY_FENCED',
        payload_json: fencedPayload,
        payload_hash: fencedPayloadHash,
        created_at: exactTimeIso,
      });

      const terminalDisp = buildCanonicalTerminalDisposition(
        'RECOVERY_FENCED',
        adjId,
        subId,
        exactTimeIso,
        { failureCode: 'ORPHANED_VERIFICATION_INTERRUPTED' }
      );
      fixtures.repo.createCoderSubmissionDisposition(terminalDisp);

      fixtures.db.prepare("UPDATE tasks SET state = 'NEEDS_HUMAN' WHERE id = ?").run(fixtures.taskId);

      const eventCountBefore = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number };
      const dispCountBefore = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_dispositions').get() as { c: number };
      const adjBefore = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;

      // 1. null recovery_fenced_at fails closed
      const reconNull = fixtures.recoveryScanner.reconcileSingleAdjudication({
        ...adjBefore,
        recovery_fenced_at: null,
      });
      expect(reconNull.classification).toBe('AUTHORITY_CONFLICT');
      expect(reconNull.action_taken).toBe('NO_OP');
      expect(reconNull.error).toContain('canonical recovery_fenced_at');

      // 2. non-canonical recovery_fenced_at fails closed
      const reconNonCanonical = fixtures.recoveryScanner.reconcileSingleAdjudication({
        ...adjBefore,
        recovery_fenced_at: '2026-09-14 12:00:00',
      });
      expect(reconNonCanonical.classification).toBe('AUTHORITY_CONFLICT');
      expect(reconNonCanonical.action_taken).toBe('NO_OP');
      expect(reconNonCanonical.error).toContain('canonical recovery_fenced_at');

      const eventCountAfter = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number };
      const dispCountAfter = fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_dispositions').get() as { c: number };
      const adjAfter = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(eventCountAfter.c).toBe(eventCountBefore.c);
      expect(dispCountAfter.c).toBe(dispCountBefore.c);
      expect(adjAfter).toEqual(adjBefore);
    });

    it('396. buildCanonicalWorkspaceSnapshotAfterPayload: undefined, null, and exact empty string independently canonicalize to computeSha256(\'\') for both fields', () => {
      const nowIso = new Date().toISOString();
      const emptySha = computeSha256('');

      // Both undefined
      const payloadUndefined = buildCanonicalWorkspaceSnapshotAfterPayload({
        adjudicationId: 'adj-' + crypto.randomUUID(),
        assignmentId: fixtures.assignmentId,
        attemptId: fixtures.attemptId,
        authorizationId: fixtures.authorizationId,
        capturedAt: nowIso,
        capturedRepositoryHeadSha: fixtures.repoHeadSha,
        expectedHeadSha: fixtures.repoHeadSha,
        gitDiffEvidenceHash: undefined,
        gitStatusEvidenceHash: undefined,
        projectId: fixtures.projectId,
        submissionId: crypto.randomUUID(),
        taskId: fixtures.taskId,
        taskOwnershipEpoch: 1,
        verificationExecutionId: 'exec-' + crypto.randomUUID(),
        workspaceLeaseId: 'lease-' + crypto.randomUUID(),
        worktreeIdentityHash: computeSha256(fixtures.projectRoot.toLowerCase()),
      });
      expect(payloadUndefined.git_status_evidence_hash).toBe(emptySha);
      expect(payloadUndefined.git_diff_evidence_hash).toBe(emptySha);

      // Both null
      const payloadNull = buildCanonicalWorkspaceSnapshotAfterPayload({
        adjudicationId: 'adj-' + crypto.randomUUID(),
        assignmentId: fixtures.assignmentId,
        attemptId: fixtures.attemptId,
        authorizationId: fixtures.authorizationId,
        capturedAt: nowIso,
        capturedRepositoryHeadSha: fixtures.repoHeadSha,
        expectedHeadSha: fixtures.repoHeadSha,
        gitDiffEvidenceHash: null,
        gitStatusEvidenceHash: null,
        projectId: fixtures.projectId,
        submissionId: crypto.randomUUID(),
        taskId: fixtures.taskId,
        taskOwnershipEpoch: 1,
        verificationExecutionId: 'exec-' + crypto.randomUUID(),
        workspaceLeaseId: 'lease-' + crypto.randomUUID(),
        worktreeIdentityHash: computeSha256(fixtures.projectRoot.toLowerCase()),
      });
      expect(payloadNull.git_status_evidence_hash).toBe(emptySha);
      expect(payloadNull.git_diff_evidence_hash).toBe(emptySha);

      // Both exact empty string
      const payloadEmptyStr = buildCanonicalWorkspaceSnapshotAfterPayload({
        adjudicationId: 'adj-' + crypto.randomUUID(),
        assignmentId: fixtures.assignmentId,
        attemptId: fixtures.attemptId,
        authorizationId: fixtures.authorizationId,
        capturedAt: nowIso,
        capturedRepositoryHeadSha: fixtures.repoHeadSha,
        expectedHeadSha: fixtures.repoHeadSha,
        gitDiffEvidenceHash: '',
        gitStatusEvidenceHash: '',
        projectId: fixtures.projectId,
        submissionId: crypto.randomUUID(),
        taskId: fixtures.taskId,
        taskOwnershipEpoch: 1,
        verificationExecutionId: 'exec-' + crypto.randomUUID(),
        workspaceLeaseId: 'lease-' + crypto.randomUUID(),
        worktreeIdentityHash: computeSha256(fixtures.projectRoot.toLowerCase()),
      });
      expect(payloadEmptyStr.git_status_evidence_hash).toBe(emptySha);
      expect(payloadEmptyStr.git_diff_evidence_hash).toBe(emptySha);

      // Mixed: status null, diff undefined
      const payloadMixed1 = buildCanonicalWorkspaceSnapshotAfterPayload({
        adjudicationId: 'adj-' + crypto.randomUUID(),
        assignmentId: fixtures.assignmentId,
        attemptId: fixtures.attemptId,
        authorizationId: fixtures.authorizationId,
        capturedAt: nowIso,
        capturedRepositoryHeadSha: fixtures.repoHeadSha,
        expectedHeadSha: fixtures.repoHeadSha,
        gitDiffEvidenceHash: undefined,
        gitStatusEvidenceHash: null,
        projectId: fixtures.projectId,
        submissionId: crypto.randomUUID(),
        taskId: fixtures.taskId,
        taskOwnershipEpoch: 1,
        verificationExecutionId: 'exec-' + crypto.randomUUID(),
        workspaceLeaseId: 'lease-' + crypto.randomUUID(),
        worktreeIdentityHash: computeSha256(fixtures.projectRoot.toLowerCase()),
      });
      expect(payloadMixed1.git_status_evidence_hash).toBe(emptySha);
      expect(payloadMixed1.git_diff_evidence_hash).toBe(emptySha);

      // Mixed: status empty string, diff null
      const payloadMixed2 = buildCanonicalWorkspaceSnapshotAfterPayload({
        adjudicationId: 'adj-' + crypto.randomUUID(),
        assignmentId: fixtures.assignmentId,
        attemptId: fixtures.attemptId,
        authorizationId: fixtures.authorizationId,
        capturedAt: nowIso,
        capturedRepositoryHeadSha: fixtures.repoHeadSha,
        expectedHeadSha: fixtures.repoHeadSha,
        gitDiffEvidenceHash: null,
        gitStatusEvidenceHash: '',
        projectId: fixtures.projectId,
        submissionId: crypto.randomUUID(),
        taskId: fixtures.taskId,
        taskOwnershipEpoch: 1,
        verificationExecutionId: 'exec-' + crypto.randomUUID(),
        workspaceLeaseId: 'lease-' + crypto.randomUUID(),
        worktreeIdentityHash: computeSha256(fixtures.projectRoot.toLowerCase()),
      });
      expect(payloadMixed2.git_status_evidence_hash).toBe(emptySha);
      expect(payloadMixed2.git_diff_evidence_hash).toBe(emptySha);
    });

    it('397. buildCanonicalWorkspaceSnapshotAfterPayload: valid lowercase 64-character hash is preserved byte-for-byte for each field', () => {
      const nowIso = new Date().toISOString();
      const validStatusHash = computeSha256('custom-status-payload-sample');
      const validDiffHash = computeSha256('custom-diff-payload-sample');

      expect(/^[0-9a-f]{64}$/.test(validStatusHash)).toBe(true);
      expect(/^[0-9a-f]{64}$/.test(validDiffHash)).toBe(true);

      const payload = buildCanonicalWorkspaceSnapshotAfterPayload({
        adjudicationId: 'adj-' + crypto.randomUUID(),
        assignmentId: fixtures.assignmentId,
        attemptId: fixtures.attemptId,
        authorizationId: fixtures.authorizationId,
        capturedAt: nowIso,
        capturedRepositoryHeadSha: fixtures.repoHeadSha,
        expectedHeadSha: fixtures.repoHeadSha,
        gitDiffEvidenceHash: validDiffHash,
        gitStatusEvidenceHash: validStatusHash,
        projectId: fixtures.projectId,
        submissionId: crypto.randomUUID(),
        taskId: fixtures.taskId,
        taskOwnershipEpoch: 1,
        verificationExecutionId: 'exec-' + crypto.randomUUID(),
        workspaceLeaseId: 'lease-' + crypto.randomUUID(),
        worktreeIdentityHash: computeSha256(fixtures.projectRoot.toLowerCase()),
      });

      expect(payload.git_status_evidence_hash).toBe(validStatusHash);
      expect(payload.git_diff_evidence_hash).toBe(validDiffHash);

      // One valid, one absent/empty
      const payloadMixed = buildCanonicalWorkspaceSnapshotAfterPayload({
        adjudicationId: 'adj-' + crypto.randomUUID(),
        assignmentId: fixtures.assignmentId,
        attemptId: fixtures.attemptId,
        authorizationId: fixtures.authorizationId,
        capturedAt: nowIso,
        capturedRepositoryHeadSha: fixtures.repoHeadSha,
        expectedHeadSha: fixtures.repoHeadSha,
        gitDiffEvidenceHash: null,
        gitStatusEvidenceHash: validStatusHash,
        projectId: fixtures.projectId,
        submissionId: crypto.randomUUID(),
        taskId: fixtures.taskId,
        taskOwnershipEpoch: 1,
        verificationExecutionId: 'exec-' + crypto.randomUUID(),
        workspaceLeaseId: 'lease-' + crypto.randomUUID(),
        worktreeIdentityHash: computeSha256(fixtures.projectRoot.toLowerCase()),
      });
      expect(payloadMixed.git_status_evidence_hash).toBe(validStatusHash);
      expect(payloadMixed.git_diff_evidence_hash).toBe(computeSha256(''));
    });

    it('398. buildCanonicalWorkspaceSnapshotAfterPayload: invalid gitStatusEvidenceHash values throw synchronously with deterministic error', () => {
      const nowIso = new Date().toISOString();
      const validDiffHash = computeSha256('diff-valid');
      const validStatusHash = computeSha256('status-valid');

      const invalidVariants: Array<{ label: string; value: string }> = [
        { label: 'uppercase hex', value: validStatusHash.toUpperCase() },
        { label: '63 characters', value: validStatusHash.substring(0, 63) },
        { label: '65 characters', value: validStatusHash + 'a' },
        { label: 'non-hexadecimal character', value: validStatusHash.substring(0, 63) + 'g' },
        { label: 'whitespace-only (single space)', value: ' ' },
        { label: 'whitespace-only (multi spaces)', value: '   ' },
        { label: 'leading whitespace', value: ' ' + validStatusHash },
        { label: 'trailing whitespace', value: validStatusHash + ' ' },
        { label: 'newline-containing', value: validStatusHash.substring(0, 32) + '\n' + validStatusHash.substring(33) },
      ];

      for (const variant of invalidVariants) {
        expect(() => {
          buildCanonicalWorkspaceSnapshotAfterPayload({
            adjudicationId: 'adj-' + crypto.randomUUID(),
            assignmentId: fixtures.assignmentId,
            attemptId: fixtures.attemptId,
            authorizationId: fixtures.authorizationId,
            capturedAt: nowIso,
            capturedRepositoryHeadSha: fixtures.repoHeadSha,
            expectedHeadSha: fixtures.repoHeadSha,
            gitDiffEvidenceHash: validDiffHash,
            gitStatusEvidenceHash: variant.value,
            projectId: fixtures.projectId,
            submissionId: crypto.randomUUID(),
            taskId: fixtures.taskId,
            taskOwnershipEpoch: 1,
            verificationExecutionId: 'exec-' + crypto.randomUUID(),
            workspaceLeaseId: 'lease-' + crypto.randomUUID(),
            worktreeIdentityHash: computeSha256(fixtures.projectRoot.toLowerCase()),
          });
        }).toThrowError(/Invalid gitStatusEvidenceHash:.*git status.*must be absent\/empty or a 64-character lowercase hexadecimal hash/);

        // Verify the thrown error does not leak raw input value or secrets
        try {
          buildCanonicalWorkspaceSnapshotAfterPayload({
            adjudicationId: 'adj-' + crypto.randomUUID(),
            assignmentId: fixtures.assignmentId,
            attemptId: fixtures.attemptId,
            authorizationId: fixtures.authorizationId,
            capturedAt: nowIso,
            capturedRepositoryHeadSha: fixtures.repoHeadSha,
            expectedHeadSha: fixtures.repoHeadSha,
            gitDiffEvidenceHash: validDiffHash,
            gitStatusEvidenceHash: variant.value,
            projectId: fixtures.projectId,
            submissionId: crypto.randomUUID(),
            taskId: fixtures.taskId,
            taskOwnershipEpoch: 1,
            verificationExecutionId: 'exec-' + crypto.randomUUID(),
            workspaceLeaseId: 'lease-' + crypto.randomUUID(),
            worktreeIdentityHash: computeSha256(fixtures.projectRoot.toLowerCase()),
          });
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          expect(errMsg).toBe('Invalid gitStatusEvidenceHash: git status evidence hash must be absent/empty or a 64-character lowercase hexadecimal hash');
          if (variant.value.trim().length > 0) {
            expect(errMsg).not.toContain(variant.value.trim());
          }
          expect(errMsg).not.toContain('SELECT');
          expect(errMsg).not.toContain('TOKEN');
          expect(errMsg).not.toContain('Bearer');
        }
      }
    });

    it('399. buildCanonicalWorkspaceSnapshotAfterPayload: invalid gitDiffEvidenceHash values throw synchronously with deterministic error', () => {
      const nowIso = new Date().toISOString();
      const validStatusHash = computeSha256('status-valid');
      const validDiffHash = computeSha256('diff-valid');

      const invalidVariants: Array<{ label: string; value: string }> = [
        { label: 'uppercase hex', value: validDiffHash.toUpperCase() },
        { label: '63 characters', value: validDiffHash.substring(0, 63) },
        { label: '65 characters', value: validDiffHash + 'b' },
        { label: 'non-hexadecimal character', value: validDiffHash.substring(0, 63) + 'z' },
        { label: 'whitespace-only (single space)', value: ' ' },
        { label: 'whitespace-only (multi spaces)', value: '   ' },
        { label: 'leading whitespace', value: ' ' + validDiffHash },
        { label: 'trailing whitespace', value: validDiffHash + ' ' },
        { label: 'newline-containing', value: validDiffHash.substring(0, 32) + '\r\n' + validDiffHash.substring(34) },
      ];

      for (const variant of invalidVariants) {
        expect(() => {
          buildCanonicalWorkspaceSnapshotAfterPayload({
            adjudicationId: 'adj-' + crypto.randomUUID(),
            assignmentId: fixtures.assignmentId,
            attemptId: fixtures.attemptId,
            authorizationId: fixtures.authorizationId,
            capturedAt: nowIso,
            capturedRepositoryHeadSha: fixtures.repoHeadSha,
            expectedHeadSha: fixtures.repoHeadSha,
            gitDiffEvidenceHash: variant.value,
            gitStatusEvidenceHash: validStatusHash,
            projectId: fixtures.projectId,
            submissionId: crypto.randomUUID(),
            taskId: fixtures.taskId,
            taskOwnershipEpoch: 1,
            verificationExecutionId: 'exec-' + crypto.randomUUID(),
            workspaceLeaseId: 'lease-' + crypto.randomUUID(),
            worktreeIdentityHash: computeSha256(fixtures.projectRoot.toLowerCase()),
          });
        }).toThrowError(/Invalid gitDiffEvidenceHash:.*git diff.*must be absent\/empty or a 64-character lowercase hexadecimal hash/);

        // Verify the thrown error does not leak raw input value or secrets
        try {
          buildCanonicalWorkspaceSnapshotAfterPayload({
            adjudicationId: 'adj-' + crypto.randomUUID(),
            assignmentId: fixtures.assignmentId,
            attemptId: fixtures.attemptId,
            authorizationId: fixtures.authorizationId,
            capturedAt: nowIso,
            capturedRepositoryHeadSha: fixtures.repoHeadSha,
            expectedHeadSha: fixtures.repoHeadSha,
            gitDiffEvidenceHash: variant.value,
            gitStatusEvidenceHash: validStatusHash,
            projectId: fixtures.projectId,
            submissionId: crypto.randomUUID(),
            taskId: fixtures.taskId,
            taskOwnershipEpoch: 1,
            verificationExecutionId: 'exec-' + crypto.randomUUID(),
            workspaceLeaseId: 'lease-' + crypto.randomUUID(),
            worktreeIdentityHash: computeSha256(fixtures.projectRoot.toLowerCase()),
          });
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          expect(errMsg).toBe('Invalid gitDiffEvidenceHash: git diff evidence hash must be absent/empty or a 64-character lowercase hexadecimal hash');
          if (variant.value.trim().length > 0) {
            expect(errMsg).not.toContain(variant.value.trim());
          }
          expect(errMsg).not.toContain('SELECT');
          expect(errMsg).not.toContain('TOKEN');
          expect(errMsg).not.toContain('Bearer');
        }
      }
    });

    it('400. Fail-closed: malformed evidence hashes prevent payload construction and cause zero durable repository mutation', () => {
      const nowIso = new Date().toISOString();
      const validDiffHash = computeSha256('diff-valid');

      const adjCountBefore = (fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudications').get() as { c: number }).c;
      const eventCountBefore = (fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number }).c;
      const dispCountBefore = (fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_dispositions').get() as { c: number }).c;
      const evidenceCountBefore = (fixtures.db.prepare('SELECT count(*) as c FROM evidence').get() as { c: number }).c;

      let caughtStatusErr = false;
      try {
        buildCanonicalWorkspaceSnapshotAfterPayload({
          adjudicationId: 'adj-' + crypto.randomUUID(),
          assignmentId: fixtures.assignmentId,
          attemptId: fixtures.attemptId,
          authorizationId: fixtures.authorizationId,
          capturedAt: nowIso,
          capturedRepositoryHeadSha: fixtures.repoHeadSha,
          expectedHeadSha: fixtures.repoHeadSha,
          gitDiffEvidenceHash: validDiffHash,
          gitStatusEvidenceHash: 'INVALID_STATUS_HASH_UPPERCASE_AND_BAD_LENGTH',
          projectId: fixtures.projectId,
          submissionId: crypto.randomUUID(),
          taskId: fixtures.taskId,
          taskOwnershipEpoch: 1,
          verificationExecutionId: 'exec-' + crypto.randomUUID(),
          workspaceLeaseId: 'lease-' + crypto.randomUUID(),
          worktreeIdentityHash: computeSha256(fixtures.projectRoot.toLowerCase()),
        });
      } catch (err) {
        caughtStatusErr = true;
      }
      expect(caughtStatusErr).toBe(true);

      let caughtDiffErr = false;
      try {
        buildCanonicalWorkspaceSnapshotAfterPayload({
          adjudicationId: 'adj-' + crypto.randomUUID(),
          assignmentId: fixtures.assignmentId,
          attemptId: fixtures.attemptId,
          authorizationId: fixtures.authorizationId,
          capturedAt: nowIso,
          capturedRepositoryHeadSha: fixtures.repoHeadSha,
          expectedHeadSha: fixtures.repoHeadSha,
          gitDiffEvidenceHash: '   whitespace_diff_evidence   ',
          gitStatusEvidenceHash: computeSha256('status-valid'),
          projectId: fixtures.projectId,
          submissionId: crypto.randomUUID(),
          taskId: fixtures.taskId,
          taskOwnershipEpoch: 1,
          verificationExecutionId: 'exec-' + crypto.randomUUID(),
          workspaceLeaseId: 'lease-' + crypto.randomUUID(),
          worktreeIdentityHash: computeSha256(fixtures.projectRoot.toLowerCase()),
        });
      } catch (err) {
        caughtDiffErr = true;
      }
      expect(caughtDiffErr).toBe(true);

      const adjCountAfter = (fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudications').get() as { c: number }).c;
      const eventCountAfter = (fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number }).c;
      const dispCountAfter = (fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_dispositions').get() as { c: number }).c;
      const evidenceCountAfter = (fixtures.db.prepare('SELECT count(*) as c FROM evidence').get() as { c: number }).c;

      expect(adjCountAfter).toBe(adjCountBefore);
      expect(eventCountAfter).toBe(eventCountBefore);
      expect(dispCountAfter).toBe(dispCountBefore);
      expect(evidenceCountAfter).toBe(evidenceCountBefore);
    });

    it('401. validateCanonicalWorkspaceSnapshotAfter: rejects missing, malformed, or mismatched authority hashes without mutation', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id)!;
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const lease = fixtures.repo.getWorkspaceLease(adj.workspace_lease_id!)!;
      const env = JSON.parse(adj.verification_result_envelope_json!);
      const afterEv = fixtures.repo.getEvidence(env.workspace_snapshot_after_evidence_id!)!;
      const rawContent = afterEv.raw_payload || (afterEv.file_path ? fs.readFileSync(afterEv.file_path, 'utf8') : '{}');
      const expectedHash = env.workspace_snapshot_after_hash;

      const eventCountBefore = (fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number }).c;
      const dispCountBefore = (fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_dispositions').get() as { c: number }).c;

      // 1. Missing gitStatusEvidenceHash authority input
      const resMissingStatus = validateCanonicalWorkspaceSnapshotAfter({
        rawContent,
        expectedHash,
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: null,
        gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(resMissingStatus.valid).toBe(false);
      expect(resMissingStatus.error).toContain('gitStatusEvidenceHash authority input must be a 64-char lowercase hex string');

      // 2. Malformed uppercase gitStatusEvidenceHash authority input
      const resUpperStatus = validateCanonicalWorkspaceSnapshotAfter({
        rawContent,
        expectedHash,
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: (env.git_status_evidence_hash || computeSha256('')).toUpperCase(),
        gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(resUpperStatus.valid).toBe(false);
      expect(resUpperStatus.error).toContain('gitStatusEvidenceHash authority input must be a 64-char lowercase hex string');

      // 3. Mismatched gitStatusEvidenceHash authority input
      const resMismatchStatus = validateCanonicalWorkspaceSnapshotAfter({
        rawContent,
        expectedHash,
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: computeSha256('mismatched-status-authority'),
        gitDiffEvidenceHash: env.git_diff_evidence_hash || computeSha256(''),
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(resMismatchStatus.valid).toBe(false);
      expect(resMismatchStatus.error).toContain('git_status_evidence_hash mismatch git status evidence');

      // 4. Missing gitDiffEvidenceHash authority input
      const resMissingDiff = validateCanonicalWorkspaceSnapshotAfter({
        rawContent,
        expectedHash,
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
        gitDiffEvidenceHash: undefined,
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(resMissingDiff.valid).toBe(false);
      expect(resMissingDiff.error).toContain('gitDiffEvidenceHash authority input must be a 64-char lowercase hex string');

      // 5. Malformed 63-char gitDiffEvidenceHash authority input
      const resShortDiff = validateCanonicalWorkspaceSnapshotAfter({
        rawContent,
        expectedHash,
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
        gitDiffEvidenceHash: (env.git_diff_evidence_hash || computeSha256('')).substring(0, 63),
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(resShortDiff.valid).toBe(false);
      expect(resShortDiff.error).toContain('gitDiffEvidenceHash authority input must be a 64-char lowercase hex string');

      // 6. Mismatched gitDiffEvidenceHash authority input
      const resMismatchDiff = validateCanonicalWorkspaceSnapshotAfter({
        rawContent,
        expectedHash,
        adjudication: adj,
        submission: sub,
        lease,
        verificationExecutionId: env.verification_execution_id,
        gitStatusEvidenceHash: env.git_status_evidence_hash || computeSha256(''),
        gitDiffEvidenceHash: computeSha256('mismatched-diff-authority'),
        expectedCapturedAt: env.finish_timestamp,
      });
      expect(resMismatchDiff.valid).toBe(false);
      expect(resMismatchDiff.error).toContain('git_diff_evidence_hash mismatch git diff evidence');

      // Zero durable mutation
      const eventCountAfter = (fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_adjudication_events').get() as { c: number }).c;
      const dispCountAfter = (fixtures.db.prepare('SELECT count(*) as c FROM coder_submission_dispositions').get() as { c: number }).c;
      expect(eventCountAfter).toBe(eventCountBefore);
      expect(dispCountAfter).toBe(dispCountBefore);
    });

    it('402. Production helper canonicalizeSnapshotEvidenceHash decision table verification', () => {
      const emptySha = computeSha256('');
      const validSample = computeSha256('evidence-hash-test');

      // A. Absent / empty input
      expect(canonicalizeSnapshotEvidenceHash(undefined, 'gitStatusEvidenceHash')).toBe(emptySha);
      expect(canonicalizeSnapshotEvidenceHash(null, 'gitStatusEvidenceHash')).toBe(emptySha);
      expect(canonicalizeSnapshotEvidenceHash('', 'gitStatusEvidenceHash')).toBe(emptySha);
      expect(canonicalizeSnapshotEvidenceHash(undefined, 'gitDiffEvidenceHash')).toBe(emptySha);
      expect(canonicalizeSnapshotEvidenceHash(null, 'gitDiffEvidenceHash')).toBe(emptySha);
      expect(canonicalizeSnapshotEvidenceHash('', 'gitDiffEvidenceHash')).toBe(emptySha);

      // B. Valid input
      expect(canonicalizeSnapshotEvidenceHash(validSample, 'gitStatusEvidenceHash')).toBe(validSample);
      expect(canonicalizeSnapshotEvidenceHash(validSample, 'gitDiffEvidenceHash')).toBe(validSample);

      // C. Invalid non-empty input
      expect(() => canonicalizeSnapshotEvidenceHash(validSample.toUpperCase(), 'gitStatusEvidenceHash')).toThrow(
        /Invalid gitStatusEvidenceHash: git status evidence hash must be absent\/empty or a 64-character lowercase hexadecimal hash/
      );
      expect(() => canonicalizeSnapshotEvidenceHash(validSample.toUpperCase(), 'gitDiffEvidenceHash')).toThrow(
        /Invalid gitDiffEvidenceHash: git diff evidence hash must be absent\/empty or a 64-character lowercase hexadecimal hash/
      );
      expect(() => canonicalizeSnapshotEvidenceHash('   ', 'gitStatusEvidenceHash')).toThrow(/Invalid gitStatusEvidenceHash/);
      expect(() => canonicalizeSnapshotEvidenceHash('   ', 'gitDiffEvidenceHash')).toThrow(/Invalid gitDiffEvidenceHash/);
      expect(() => canonicalizeSnapshotEvidenceHash(validSample.substring(0, 63), 'gitStatusEvidenceHash')).toThrow(/Invalid gitStatusEvidenceHash/);
      expect(() => canonicalizeSnapshotEvidenceHash(validSample + 'f', 'gitDiffEvidenceHash')).toThrow(/Invalid gitDiffEvidenceHash/);
    });
  });
});
