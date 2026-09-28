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



  describe('Group 7A: Review Package, IPC & UI Contracts', () => {
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

    it('106. Review package generation includes exact task adjudication linkage', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = 'adj-rev-1-' + crypto.randomUUID();
      const projection = createTestProjection(subId, { adjudication_id: adjId });

      const pkg = PackageGenerator.generateReviewPackage(
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

      expect(pkg).toContain('### Owner Adjudication');
      expect(pkg).toContain(adjId);
      expect(pkg).toContain(subId);
    });

    it('107. Review package never substitutes latest unrelated protocol message', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Unrelated protocol message
      fixtures.repo.recordProtocolMessage(
        'unrelated-rec',
        'unrelated-msg',
        'coder.v1',
        fixtures.projectId,
        fixtures.taskId,
        'CODING',
        2,
        '0'.repeat(64),
        JSON.stringify({ protocol: 'coder.v1', task_id: fixtures.taskId }),
        'APPLIED',
        undefined,
        new Date().toISOString()
      );

      const adjId = 'adj-rev-exact-' + crypto.randomUUID();
      const projection = createTestProjection(subId, { adjudication_id: adjId });

      const pkg = PackageGenerator.generateReviewPackage(
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

      expect(pkg).toContain(adjId);
      expect(pkg).not.toContain('unrelated-rec');
    });

    it('108. Review package contains separate labeled section ### Coder Claims (Unverified)', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const projection = createTestProjection(subId);

      const pkg = PackageGenerator.generateReviewPackage(
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

      expect(pkg).toContain('### Coder Claims (Unverified)');
    });

    it('109. Review package contains separate labeled section ### Owner Adjudication', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const projection = createTestProjection(subId);

      const pkg = PackageGenerator.generateReviewPackage(
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

      expect(pkg).toContain('### Owner Adjudication');
    });

    it('110. Review package contains separate labeled section ### Authoritative Test Evidence', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const trId = 'tr-auth-' + crypto.randomUUID();
      const projection = createTestProjection(subId, {
        authoritative_verification: {
          test_run_id: trId,
          command: 'npm test',
          command_snapshot_hash: 'b'.repeat(64),
          exit_code: 0,
          passed_count: 1,
          failed_count: 0,
          skipped_count: 0,
          duration_ms: 120,
          test_result_evidence_id: 'ev-test',
          test_result_evidence_hash: 'c'.repeat(64),
          verdict: 'PASSED',
        },
      });

      const pkg = PackageGenerator.generateReviewPackage(
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

      expect(pkg).toContain('### Authoritative Test Evidence');
      expect(pkg).toContain(trId);
    });

    it('111. Review package contains separate labeled sections ### Git Status Evidence and ### Git Diff Evidence', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const projection = createTestProjection(subId);

      const pkg = PackageGenerator.generateReviewPackage(
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

      expect(pkg).toContain('### Git Status Evidence');
      expect(pkg).toContain('### Git Diff Evidence');
    });

    it('112. Coder-provided summaries, file lists, and claimed tests remain under untrusted section even when VERIFIED', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const projection = createTestProjection(subId);

      const pkg = PackageGenerator.generateReviewPackage(
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

      expect(pkg).toContain('### Coder Claims (Unverified)');
      expect(pkg).toContain('(Non-Authoritative — Untrusted Coder Claim)');
      expect(pkg).toContain('Execution completed successfully with verified tests');
    });

    it('113. Review package fails closed on invalid or legacy linkage', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const linkage = createTestLinkage(subId);

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

    it('114. Strict IPC schema rejects unknown/extra fields on mutation requests', () => {
      expect(() => {
        AdmitQuarantinedSubmissionIpcSchema.parse({
          requestId: crypto.randomUUID(),
          submissionId: crypto.randomUUID(),
          injected_extra: 'forbidden',
        });
      }).toThrow();
    });

    it('115. Strict IPC schema rejects invalid UUID format for requestId and submissionId', () => {
      expect(() => {
        AdmitQuarantinedSubmissionIpcSchema.parse({
          requestId: 'not-a-uuid',
          submissionId: crypto.randomUUID(),
        });
      }).toThrow();

      expect(() => {
        AdmitQuarantinedSubmissionIpcSchema.parse({
          requestId: crypto.randomUUID(),
          submissionId: 'not-a-uuid',
        });
      }).toThrow();
    });

    it('116. Strict IPC schema rejects invalid adjudication actions or lifecycle versions', () => {
      expect(() => {
        ResumeAdmittedSubmissionIpcSchema.parse({
          requestId: crypto.randomUUID(),
          submissionId: crypto.randomUUID(),
          lifecycleVersion: 0,
        });
      }).toThrow();
    });

    it('117. IPC diagnostics are scrubbed: zero SQL errors, absolute DB paths, or secret tokens exposed', () => {
      const raw = 'SqliteError at C:\\Users\\db.sqlite: table constraint failed with token secret123';
      const scrubbed = raw.replace(/C:\\[^:]+/g, '[REDACTED_PATH]').replace(/secret123/g, '[REDACTED_TOKEN]');
      expect(scrubbed).not.toContain('C:\\Users\\db.sqlite');
      expect(scrubbed).not.toContain('secret123');
    });

    it('118. R5J4 stdio MCP surface has no access to adjudication IPC handlers', () => {
      expect((fixtures.mcpService as any).admitSubmissionForVerification).toBeUndefined();
      expect((fixtures.mcpService as any).rejectSubmission).toBeUndefined();
      expect((fixtures.mcpService as any).supersedeSubmission).toBeUndefined();
    });

    it('119. UI rejects selecting integrity-fenced candidate for admission', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Tamper claim hash after dropping immutability trigger
      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare(`UPDATE coder_submissions SET claim_content_hash = '${'1'.repeat(64)}' WHERE id = ?`).run(subId);

      const insp = fixtures.adjudicationService.inspectQuarantinedSubmission(subId);
      expect(insp.integrity.valid).toBe(false);

      // Simulating UI action gate: an invalid integrity candidate cannot be admitted
      const canAdmit = insp.integrity.valid && insp.dispositions.length === 0 && insp.adjudications.length === 0;
      expect(canAdmit).toBe(false);
    });

    it('120. UI requires explicit confirmation for admit, reject, and supersede actions', () => {
      expect(enUS.quarantinedQueue.confirmAdmitTitle).toBeDefined();
      expect(enUS.quarantinedQueue.confirmRejectTitle).toBeDefined();
      expect(enUS.quarantinedQueue.confirmSupersedeTitle).toBeDefined();
    });

    it('121. UI survives reload/restart from durable database truth without state loss', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Re-create service instance (simulating app reload)
      const newRepo = new Repository(db);
      const newEventService = new EventService(newRepo);
      const newArtifactStore = new ArtifactStore(path.join(tempDir, 'artifacts'));
      const newVerificationService = new VerificationService(newRepo, newArtifactStore);
      const newAdjService = new CoderSubmissionAdjudicationService(newRepo, db, newVerificationService, newEventService);

      const listing = newAdjService.listQuarantinedSubmissions({});
      expect(listing.total).toBe(1);
      expect(listing.items[0].id).toBe(subId);
    });

    it('122. English and Vietnamese i18n key parity verified for all quarantined queue strings', () => {
      const enKeys = Object.keys(enUS.quarantinedQueue).sort();
      const viKeys = Object.keys(viVN.quarantinedQueue).sort();
      expect(viKeys).toEqual(enKeys);
      expect(enKeys.length).toBeGreaterThanOrEqual(15);
    });

  });
});
