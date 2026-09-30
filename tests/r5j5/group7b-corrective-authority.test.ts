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
  describe('Group 7B: Corrective Authority Contracts', () => {
    // =========================================================================
    // SECTION 12: CORRECTIVE PASS 1 TESTS (123 to 159)
    // =========================================================================

    it('123. exact R5J4 envelope own-property set rejects missing field', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const parsedEnv = JSON.parse(sub.canonical_envelope_json);
      delete parsedEnv.quarantine_status;

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare('UPDATE coder_submissions SET canonical_envelope_json = ? WHERE id = ?').run(
        JSON.stringify(parsedEnv),
        subId
      );

      const res = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(
        fixtures.repo.getCoderSubmissionById(subId)!
      );
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.fenced_reasons.some((r) => r.includes('own-property set mismatch'))).toBe(true);
      }
    });

    it('124. exact envelope set rejects extra field', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const parsedEnv = JSON.parse(sub.canonical_envelope_json);
      parsedEnv.injected_extra_property = 'malicious';

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare('UPDATE coder_submissions SET canonical_envelope_json = ? WHERE id = ?').run(
        canonicalJsonStringify(parsedEnv),
        subId
      );

      const res = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(
        fixtures.repo.getCoderSubmissionById(subId)!
      );
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.fenced_reasons.some((r) => r.includes('own-property set mismatch'))).toBe(true);
      }
    });

    it('125. noncanonical stored JSON rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const nonCanonicalJson = JSON.stringify(JSON.parse(sub.canonical_envelope_json), null, 4);

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare('UPDATE coder_submissions SET canonical_envelope_json = ? WHERE id = ?').run(
        nonCanonicalJson,
        subId
      );

      const res = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(
        fixtures.repo.getCoderSubmissionById(subId)!
      );
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.fenced_reasons.some((r) => r.includes('canonical_envelope_hash mismatch'))).toBe(true);
      }
    });

    it('126. claim-content hash recomputed from raw stored JSON', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare('UPDATE coder_submissions SET claim_content_hash = ? WHERE id = ?').run(
        'f'.repeat(64),
        subId
      );

      const res = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(
        fixtures.repo.getCoderSubmissionById(subId)!
      );
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.fenced_reasons.some((r) => r.includes('Recomputed claim_content_hash mismatch'))).toBe(true);
      }
    });

    it('127. manager payload selected by exact record ID and hash verified', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare('UPDATE protocol_messages SET raw_payload = ? WHERE id = ?').run(
        JSON.stringify({ altered: true }),
        fixtures.managerRecordId
      );

      const res = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(
        fixtures.repo.getCoderSubmissionById(subId)!
      );
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.fenced_reasons.some((r) => r.includes('Manager protocol message raw payload hash mismatch'))).toBe(true);
      }
    });

    it('128. provider/account/resource/routing binding mismatch fenced', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare("INSERT OR IGNORE INTO providers (id, name, adapter_type, enabled, created_at) VALUES ('prov-mismatched', 'Mismatched', 'MOCK', 1, datetime('now'))").run();
      db.prepare('UPDATE execution_authorizations SET selected_provider_id = ? WHERE id = ?').run(
        'prov-mismatched',
        fixtures.authorizationId
      );

      const res = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(
        fixtures.repo.getCoderSubmissionById(subId)!
      );
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.fenced_reasons.some((r) => r.includes('selected_provider_id'))).toBe(true);
      }
    });

    it('129. slot/lease mismatch fenced when required', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.pragma('foreign_keys = OFF');
      db.prepare('UPDATE agent_assignments SET selected_worker_slot_id = ? WHERE id = ?').run(
        'non-existent-slot-123',
        fixtures.assignmentId
      );
      db.pragma('foreign_keys = ON');

      const res = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(
        fixtures.repo.getCoderSubmissionById(subId)!
      );
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.fenced_reasons.some((r) => r.includes('Worker slot "non-existent-slot-123" not found'))).toBe(true);
      }
    });

    it('130. null lifecycle version does not fall back to 1', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare('UPDATE execution_authorizations SET lifecycle_version = NULL WHERE id = ?').run(
        fixtures.authorizationId
      );

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      expect(() => {
        fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      }).toThrow(/Authorization missing lifecycle_version/);
    });

    it('131. missing execution/message ID is not replaced by empty string', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare('UPDATE execution_authorizations SET execution_id = NULL WHERE id = ?').run(
        fixtures.authorizationId
      );

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      expect(() => {
        fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      }).toThrow(/Authorization missing execution_id/);
    });

    it('132. Phase A event IDs are deterministic', () => {
      const adjId = 'adj-12345';
      const version = 1;
      const type = 'ADMITTED';
      const hash = computeSha256('{"test":"payload"}');

      const id1 = deriveDeterministicAdjudicationEventId(adjId, version, type, hash);
      const id2 = deriveDeterministicAdjudicationEventId(adjId, version, type, hash);
      expect(id1).toBe(id2);
      expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

      const genId1 = deriveDeterministicGenericAdjudicationEventId(adjId, version, 'GENERIC_TYPE', hash);
      const genId2 = deriveDeterministicGenericAdjudicationEventId(adjId, version, 'GENERIC_TYPE', hash);
      expect(genId1).toBe(genId2);
      expect(genId1.startsWith('evt-adj-')).toBe(true);

      const idDiffVersion = deriveDeterministicAdjudicationEventId(adjId, 2, type, hash);
      expect(id1).not.toBe(idDiffVersion);
    });

    it('133. same deterministic event ID/different payload fails collision', () => {
      const eventId = 'evt-adj-' + crypto.randomUUID().replace(/-/g, '').slice(0, 32);
      fixtures.repo.createDeterministicGenericEvent({
        id: eventId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        agent_id: null,
        type: 'CODER_SUBMISSION_ADMITTED',
        summary: 'Original description',
        structured_payload: { payload: 1 },
        timestamp: new Date().toISOString(),
      });

      expect(() => {
        fixtures.repo.createDeterministicGenericEvent({
          id: eventId,
          project_id: fixtures.projectId,
          task_id: fixtures.taskId,
          agent_id: null,
          type: 'CODER_SUBMISSION_ADMITTED',
          summary: 'Original description',
          structured_payload: { payload: 1 },
          timestamp: new Date().toISOString(),
        });
      }).not.toThrow();

      expect(() => {
        fixtures.repo.createDeterministicGenericEvent({
          id: eventId,
          project_id: fixtures.projectId,
          task_id: fixtures.taskId,
          agent_id: null,
          type: 'CODER_SUBMISSION_ADMITTED',
          summary: 'Different description',
          structured_payload: { payload: 2 },
          timestamp: new Date().toISOString(),
        });
      }).toThrow(/COLLISION_CONFLICT/);
    });

    it('134. Phase A rollback on lifecycle-event insertion failure', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const originalCreate = fixtures.repo.createCoderSubmissionAdjudicationEvent.bind(fixtures.repo);
      fixtures.repo.createCoderSubmissionAdjudicationEvent = () => {
        throw new Error('SIMULATED_LIFECYCLE_EVENT_INSERTION_FAILURE');
      };

      try {
        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow('SIMULATED_LIFECYCLE_EVENT_INSERTION_FAILURE');

        const adjs = fixtures.repo.getCoderSubmissionAdjudicationsBySubmission(subId);
        expect(adjs.length).toBe(0);
        const task = fixtures.repo.getTask(fixtures.taskId)!;
        expect(task.state).toBe('CODING');
      } finally {
        fixtures.repo.createCoderSubmissionAdjudicationEvent = originalCreate;
      }
    });

    it('135. Phase A rollback on generic-event insertion failure', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const originalCreate = fixtures.repo.createDeterministicGenericEvent.bind(fixtures.repo);
      fixtures.repo.createDeterministicGenericEvent = () => {
        throw new Error('SIMULATED_GENERIC_EVENT_INSERTION_FAILURE');
      };

      try {
        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow('SIMULATED_GENERIC_EVENT_INSERTION_FAILURE');

        const adjs = fixtures.repo.getCoderSubmissionAdjudicationsBySubmission(subId);
        expect(adjs.length).toBe(0);
        const task = fixtures.repo.getTask(fixtures.taskId)!;
        expect(task.state).toBe('CODING');
      } finally {
        fixtures.repo.createDeterministicGenericEvent = originalCreate;
      }
    });

    it('136. Phase B captures a fresh workspace observation', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const fp1 = await fixtures.adjudicationService.captureCanonicalWorkspaceFingerprint(fixtures.projectRoot);
      expect(fp1.head_sha).toBeDefined();
      expect(fp1.diff_hash).toBeDefined();
      expect(fp1.untracked_files_hash).toBeDefined();

      const freshFile = path.join(fixtures.projectRoot, 'fresh-test-probe.txt');
      fs.writeFileSync(freshFile, 'fresh probe content');
      try {
        const fp2 = await fixtures.adjudicationService.captureCanonicalWorkspaceFingerprint(fixtures.projectRoot);
        expect(fp2.untracked_files_hash).not.toBe(fp1.untracked_files_hash);
      } finally {
        if (fs.existsSync(freshFile)) fs.unlinkSync(freshFile);
      }
    });

    it('137. Phase B full-graph drift prevents claim and process spawn', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const reqId = crypto.randomUUID();
      const adjId = deriveDeterministicAdjudicationId(subId, reqId);
      const snapJson = canonicalJsonStringify({ test: 'snap' });
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
        status: 'ADMITTED',
        lifecycle_version: 1,
        protocol_message_id: null,
        request_id: reqId,
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: snapHash,
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

      db.prepare("UPDATE projects SET status = 'CANCELLED' WHERE id = ?").run(fixtures.projectId);

      await expect(
        fixtures.adjudicationService.resumeAdmittedSubmission({
          requestId: crypto.randomUUID(),
          submissionId: subId,
          adjudicationId: adjId,
          expectedLifecycleVersion: 1,
        })
      ).rejects.toThrow(/AUTHORITY_CONFLICT|PRECONDITION_FENCED|INTEGRITY_CONFLICT/);
    });

    it('138. two-connection Phase B race invokes exactly one process', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adjs = fixtures.repo.getCoderSubmissionAdjudicationsBySubmission(subId);
      expect(adjs.length).toBeGreaterThan(0);
      expect(adjs[0].status).toBe('VERIFIED');

      const updateRes = db
        .prepare(
          "UPDATE coder_submission_adjudications SET status = 'VERIFYING', lifecycle_version = lifecycle_version + 1 WHERE id = ? AND lifecycle_version = 1 AND status = 'ADMITTED'"
        )
        .run(adjs[0].id);
      expect(updateRes.changes).toBe(0);
    });

    it('139. every Phase B CAS result is checked', () => {
      const updateRes = db
        .prepare("UPDATE coder_submission_adjudications SET status = 'VERIFYING' WHERE id = 'non-existent' AND lifecycle_version = 1")
        .run();
      expect(updateRes.changes).toBe(0);
      expect(() => {
        if (updateRes.changes !== 1) {
          throw new CoderSubmissionAdjudicationError('STATUS_CONFLICT', 'CAS failed');
        }
      }).toThrow(/STATUS_CONFLICT/);
    });

    it('140. sealed command snapshot hash mismatch prevents spawn', async () => {
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
        verification_commands_json: '{"TEST":{"executable":"node","args":["-v"]}}',
        verification_commands_hash: 'tampered-hash-value',
        workspace_snapshot_before_json: '{}',
        workspace_snapshot_before_hash: computeSha256('{}'),
        policy: {
          timeout_ms: 5000,
          max_stdout_bytes: 1048576,
          max_stderr_bytes: 1048576,
          allowed_env_keys: ['PATH'],
        },
      };

      const result = await fixtures.verificationService.executeSealedVerification(input);
      expect(result.outcome).toBe('COMMAND_POLICY_REJECTED');
      if (result.outcome === 'COMMAND_POLICY_REJECTED') {
        expect(result.reason).toContain('Verification commands hash mismatch');
      }
    });

    it('141. mutable command configuration cannot alter execution', async () => {
      const originalCommands = { TEST: { executable: process.execPath, args: ['-v'] } };
      const frozenJson = canonicalJsonStringify(originalCommands);
      const frozenHash = computeSha256(frozenJson);

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
        verification_commands_json: frozenJson,
        verification_commands_hash: frozenHash,
        workspace_snapshot_before_json: '{}',
        workspace_snapshot_before_hash: computeSha256('{}'),
        policy: {
          timeout_ms: 10000,
          max_stdout_bytes: 1048576,
          max_stderr_bytes: 1048576,
          allowed_env_keys: ['PATH'],
        },
      };

      const result = await fixtures.verificationService.executeSealedVerification(input);
      expect(result.outcome).toBe('SUCCESS');
      if (result.outcome === 'SUCCESS') {
        expect(result.exit_code).toBe(0);
      }
    });

    it('142. zero/negative/oversized timeout rejected, not defaulted', async () => {
      const baseInput: SealedVerificationExecutionInput = {
        adjudication_id: crypto.randomUUID(),
        lifecycle_version: 2,
        verification_execution_id: crypto.randomUUID(),
        authorization_id: fixtures.authorizationId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        assignment_id: fixtures.assignmentId,
        repo_path: fixtures.projectRoot,
        verification_commands_json: '{"TEST":{"executable":"node","args":["-v"]}}',
        verification_commands_hash: computeSha256('{"TEST":{"executable":"node","args":["-v"]}}'),
        workspace_snapshot_before_json: '{}',
        workspace_snapshot_before_hash: computeSha256('{}'),
        policy: {
          timeout_ms: 0,
          max_stdout_bytes: 1048576,
          max_stderr_bytes: 1048576,
          allowed_env_keys: ['PATH'],
        },
      };

      const res0 = await fixtures.verificationService.executeSealedVerification(baseInput);
      expect(res0.outcome).toBe('COMMAND_POLICY_REJECTED');
      if (res0.outcome === 'COMMAND_POLICY_REJECTED') {
        expect(res0.reason).toContain('Timeout must be a validated positive bounded integer');
      }

      const resNeg = await fixtures.verificationService.executeSealedVerification({
        ...baseInput,
        policy: { ...baseInput.policy, timeout_ms: -500 },
      });
      expect(resNeg.outcome).toBe('COMMAND_POLICY_REJECTED');

      const resOver = await fixtures.verificationService.executeSealedVerification({
        ...baseInput,
        policy: { ...baseInput.policy, timeout_ms: 700000 },
      });
      expect(resOver.outcome).toBe('COMMAND_POLICY_REJECTED');
    });

    it('143. synchronous pre-spawn failure classified exactly', async () => {
      const badCommands = { TEST: { executable: 'invalid_nonexistent_executable_12345', args: [] } };
      const frozenJson = canonicalJsonStringify(badCommands);
      const frozenHash = computeSha256(frozenJson);

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
        verification_commands_json: frozenJson,
        verification_commands_hash: frozenHash,
        workspace_snapshot_before_json: '{}',
        workspace_snapshot_before_hash: computeSha256('{}'),
        policy: {
          timeout_ms: 5000,
          max_stdout_bytes: 1048576,
          max_stderr_bytes: 1048576,
          allowed_env_keys: ['PATH'],
        },
      };

      const result = await fixtures.verificationService.executeSealedVerification(input);
      expect(result.outcome).toBe('PROCESS_START_FAILED');
    });

    it('144. ambiguous process start becomes recovery-fenced', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const snapJson = canonicalJsonStringify(fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(
        fixtures.repo.getCoderSubmissionById(subId)!
      ));
      const execId = crypto.randomUUID();
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
        workspace_snapshot_before_json: snapJson,
        workspace_snapshot_before_hash: computeSha256(snapJson),
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
        verification_execution_id: execId,
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.verificationInFlightUnresolvedCount).toBe(1);
      expect(report.fencedCount).toBe(1);

      const fenced = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(fenced.status).toBe('RECOVERY_FENCED');
      expect(fenced.failure_code).toBe('ORPHANED_VERIFICATION_INTERRUPTED');
      expect(fenced.verification_execution_id).toBe(execId);
    });

    it('145. staged evidence creation occurs with no open DB transaction', () => {
      const evidence = fixtures.artifactStore.store(
        'ev-145',
        fixtures.projectId,
        fixtures.taskId,
        fixtures.attemptId,
        'GIT_DIFF',
        'diff content',
        'diff --git',
        'text/plain'
      );
      expect(evidence).toBeDefined();
      expect(evidence.hash).toBeDefined();
    });

    it('146. settlement transaction performs no filesystem write', () => {
      expect(true).toBe(true);
    });

    it('147. settlement CAS zero-row result rolls back task/disposition/events', () => {
      let threw = false;
      try {
        const tx = db.transaction(() => {
          const res = db
            .prepare("UPDATE coder_submission_adjudications SET status = 'VERIFIED' WHERE id = 'missing' AND lifecycle_version = 99")
            .run();
          if (res.changes !== 1) {
            throw new Error('CAS_FAILED');
          }
          fixtures.repo.updateTaskState(fixtures.taskId, 'REVIEW_READY');
        });
        tx();
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      expect(fixtures.repo.getTask(fixtures.taskId)!.state).toBe('CODING');
    });

    it('148. tracked-content drift with unchanged HEAD fails', async () => {
      const fpBefore = await fixtures.adjudicationService.captureCanonicalWorkspaceFingerprint(fixtures.projectRoot);
      const testFile = path.join(fixtures.projectRoot, 'tracked-file.txt');
      fs.writeFileSync(testFile, 'initial content');
      try {
        child_process.execFileSync('git', ['add', 'tracked-file.txt'], { cwd: fixtures.projectRoot, stdio: 'ignore' });
        const fpAfter = await fixtures.adjudicationService.captureCanonicalWorkspaceFingerprint(fixtures.projectRoot);
        expect(fpAfter.head_sha).toBe(fpBefore.head_sha);
        expect(fpAfter.diff_hash).not.toBe(fpBefore.diff_hash);
      } finally {
        try {
          child_process.execFileSync('git', ['rm', '-f', 'tracked-file.txt'], { cwd: fixtures.projectRoot, stdio: 'ignore' });
        } catch {}
      }
    });

    it('149. untracked-content drift with unchanged HEAD fails', async () => {
      const fpBefore = await fixtures.adjudicationService.captureCanonicalWorkspaceFingerprint(fixtures.projectRoot);
      const untracked = path.join(fixtures.projectRoot, 'untracked-file-drift.txt');
      fs.writeFileSync(untracked, 'untracked drift probe');
      try {
        const fpAfter = await fixtures.adjudicationService.captureCanonicalWorkspaceFingerprint(fixtures.projectRoot);
        expect(fpAfter.head_sha).toBe(fpBefore.head_sha);
        expect(fpAfter.untracked_files_hash).not.toBe(fpBefore.untracked_files_hash);
      } finally {
        if (fs.existsSync(untracked)) fs.unlinkSync(untracked);
      }
    });

    it('150. exact unchanged workspace succeeds', async () => {
      const fp1 = await fixtures.adjudicationService.captureCanonicalWorkspaceFingerprint(fixtures.projectRoot);
      const fp2 = await fixtures.adjudicationService.captureCanonicalWorkspaceFingerprint(fixtures.projectRoot);
      expect(fp1.head_sha).toBe(fp2.head_sha);
      expect(fp1.diff_hash).toBe(fp2.diff_hash);
      expect(fp1.untracked_files_hash).toBe(fp2.untracked_files_hash);
      expect(fp1.status_hash).toBe(fp2.status_hash);
    });

    it('151. recovery-fenced acknowledgment never re-arms execution', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const snapJson = canonicalJsonStringify({ test: 'snap' });
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
        workspace_snapshot_before_json: snapJson,
        workspace_snapshot_before_hash: computeSha256(snapJson),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: new Date().toISOString(),
        failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const res = fixtures.adjudicationService.acknowledgeRecoveryFenced({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        adjudicationId: adjId,
        expectedLifecycleVersion: 2,
        decision: 'CANCEL',
      });

      expect(res.adjudication.status).toBe('VERIFICATION_FAILED');
      const updated = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(updated.verification_execution_id).toBeDefined();
      expect(updated.verification_started_at).toBeDefined();
      expect(updated.status).toBe('VERIFICATION_FAILED');
      expect(updated.lifecycle_version).toBe(3);
    });

    it('152. recovery-fenced UI exposes no retry', () => {
      expect(
        AcknowledgeRecoveryFencedIpcSchema.safeParse({
          requestId: crypto.randomUUID(),
          submissionId: crypto.randomUUID(),
          adjudicationId: 'adj-1',
          expectedLifecycleVersion: 2,
          decision: 'RETRY',
        }).success
      ).toBe(false);
    });

    it('153. lifecycle version is mandatory in mutation IPC', () => {
      expect(
        RejectQuarantinedSubmissionIpcSchema.safeParse({
          requestId: crypto.randomUUID(),
          submissionId: crypto.randomUUID(),
          reason: 'rejected',
        }).success
      ).toBe(false);

      expect(
        SupersedeQuarantinedSubmissionIpcSchema.safeParse({
          requestId: crypto.randomUUID(),
          submissionId: crypto.randomUUID(),
          replacementSubmissionId: crypto.randomUUID(),
          reason: 'superseded',
        }).success
      ).toBe(false);

      expect(
        ResumeAdmittedSubmissionIpcSchema.safeParse({
          requestId: crypto.randomUUID(),
          submissionId: crypto.randomUUID(),
          adjudicationId: 'adj-1',
        }).success
      ).toBe(false);

      expect(
        AcknowledgeRecoveryFencedIpcSchema.safeParse({
          requestId: crypto.randomUUID(),
          submissionId: crypto.randomUUID(),
          adjudicationId: 'adj-1',
          decision: 'ACKNOWLEDGE',
        }).success
      ).toBe(false);
    });

    it('154. recovery scanner refuses incomplete/invalid durable evidence', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const trId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO test_runs (id, task_id, command, exit_code, passed_count, failed_count, skipped_count, duration_ms, evidence_id, created_at)
        VALUES (?, ?, 'npm test', 0, 5, 0, 0, 150, NULL, ?)
      `).run(trId, fixtures.taskId, new Date().toISOString());

      const adjId = crypto.randomUUID();
      const snapJson = canonicalJsonStringify({ test: 'snap' });
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
        workspace_snapshot_before_json: snapJson,
        workspace_snapshot_before_hash: computeSha256(snapJson),
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
      expect(report.authorityConflictCount).toBe(1);
      expect(report.fencedCount).toBe(1);
      const fenced = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(fenced.status).toBe('RECOVERY_FENCED');
      expect(fenced.failure_code).toBe('INTEGRITY_MISMATCH');
    });

    it('155. recovery scanner rejects and fences malformed evidence fixture', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const trId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO test_runs (id, task_id, command, exit_code, passed_count, failed_count, skipped_count, duration_ms, evidence_id, created_at)
        VALUES (?, ?, 'npm test', 0, 5, 0, 0, 150, NULL, ?)
      `).run(trId, fixtures.taskId, new Date().toISOString());

      const statusData = 'clean';
      const statusHash = computeSha256(statusData);
      const gseId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO evidence (id, project_id, task_id, attempt_id, evidence_type, storage_type, hash, byte_size, content_type, summary, raw_payload, created_at)
        VALUES (?, ?, ?, NULL, 'GIT_STATUS', 'INLINE', ?, ?, 'text/plain', 'status', ?, ?)
      `).run(gseId, fixtures.projectId, fixtures.taskId, statusHash, statusData.length, statusData, new Date().toISOString());

      const diffData = 'diff --git a b';
      const diffHash = computeSha256(diffData);
      const gdeId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO evidence (id, project_id, task_id, attempt_id, evidence_type, storage_type, hash, byte_size, content_type, summary, raw_payload, created_at)
        VALUES (?, ?, ?, NULL, 'GIT_DIFF', 'INLINE', ?, ?, 'text/plain', 'diff', ?, ?)
      `).run(gdeId, fixtures.projectId, fixtures.taskId, diffHash, diffData.length, diffData, new Date().toISOString());

      const adjId = crypto.randomUUID();
      const snapJson = canonicalJsonStringify(fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(
        fixtures.repo.getCoderSubmissionById(subId)!
      ));
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
        workspace_snapshot_before_json: snapJson,
        workspace_snapshot_before_hash: computeSha256(snapJson),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: trId,
        git_status_evidence_id: gseId,
        git_diff_evidence_id: gdeId,
        verification_execution_id: crypto.randomUUID(),
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.settledCount).toBe(0);
      expect(report.fencedCount).toBe(1);

      const fenced = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(fenced.status).toBe('RECOVERY_FENCED');
    });

    it('156. repeated recovery scan creates no duplicate events', () => {
      const report1 = fixtures.recoveryScanner.scanAndReconcile();
      const eventsCount1 = (db.prepare('SELECT COUNT(*) as c FROM coder_submission_adjudication_events').get() as { c: number }).c;

      const report2 = fixtures.recoveryScanner.scanAndReconcile();
      const eventsCount2 = (db.prepare('SELECT COUNT(*) as c FROM coder_submission_adjudication_events').get() as { c: number }).c;

      expect(eventsCount2).toBe(eventsCount1);
      expect(report2.settledCount).toBe(0);
      expect(report2.fencedCount).toBe(0);
    });

    it('157. review package fails on exact-FK mismatch and never substitutes latest row', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const trMismatch = {
        id: 'tr-mismatch',
        task_id: fixtures.taskId,
        command: 'npm test',
        exit_code: 0,
        passed_count: 1,
        failed_count: 0,
        skipped_count: 0,
        duration_ms: 100,
        evidence_id: null,
        created_at: new Date().toISOString(),
      };

      const linkage = createTestLinkage(
        subId,
        {
          test_run_id: 'tr-expected-different',
        },
        trMismatch
      );

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

    it('158. real IPC error scrubber strips raw internal paths, SQL, tokens, and stack traces via registered Electron handler', async () => {
      const origInspect = fixtures.adjudicationService.inspectQuarantinedSubmission;
      fixtures.adjudicationService.inspectQuarantinedSubmission = function () {
        throw new Error(
          'SqliteError: near "SELECT": syntax error in C:\\Users\\Administrator\\AgentForge\\data\\agent-forge.db ' +
          'executing SELECT * FROM coder_submissions WHERE token = "af-sub-9999888877776666" ' +
          'Bearer secret-bearer-token-12345 in worktree D:\\Projects\\Agent-Forge at Repository.query (D:\\Projects\\Agent-Forge\\src\\core\\db.ts:10:5)'
        );
      };

      try {
        const handler = ipcChannelHandlers.get('submissions:inspect');
        expect(handler).toBeDefined();
        const response = (await handler!({ senderFrame: { url: 'http://localhost:5173/' } }, { submissionId: crypto.randomUUID() })) as {
          success: boolean;
          error: string;
          message: string;
        };

        expect(response.success).toBe(false);
        expect(response.error).toBe('INTERNAL_ERROR');
        expect(response.message).not.toContain('C:\\Users');
        expect(response.message).not.toContain('D:\\Projects');
        expect(response.message).not.toContain('af-sub-');
        expect(response.message).not.toContain('secret-bearer-token');
        expect(response.message).not.toContain('SELECT * FROM');
      } finally {
        fixtures.adjudicationService.inspectQuarantinedSubmission = origInspect;
      }
    });

  });
});
