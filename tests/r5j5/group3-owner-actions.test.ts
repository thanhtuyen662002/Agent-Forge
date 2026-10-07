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



  describe('Group 3: Category C — Owner Action Fencing', () => {
    it('41. rejectSubmission creates exact terminal records (status REJECTED, action REJECT) with zero task mutation', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const taskBefore = fixtures.repo.getTask(fixtures.taskId)!;

      const res = fixtures.adjudicationService.rejectSubmission({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        reason: 'Operator rejected claim',
      });

      expect(res.adjudication.status).toBe('REJECTED');
      expect(res.adjudication.action).toBe('REJECT');
      expect(res.disposition.disposition_event).toBe('REJECTED');

      const taskAfter = fixtures.repo.getTask(fixtures.taskId)!;
      expect(taskAfter.state).toBe(taskBefore.state);
      expect(taskAfter.revision_count).toBe(taskBefore.revision_count);
    });

    it('42. rejectSubmission with INTEGRITY_MISMATCH reason code records correct failure code', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Tamper submission after dropping immutability trigger
      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare('UPDATE coder_submissions SET claim_content_json = \'{"tampered":true}\' WHERE id = ?').run(subId);

      const res = fixtures.adjudicationService.rejectSubmission({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        reason: 'Integrity compromised',
      });

      expect(res.disposition.disposition_reason).toBe('INTEGRITY_MISMATCH');
      expect(res.adjudication.failure_code).toBe('INTEGRITY_MISMATCH');
    });

    it('43. rejectSubmission with FENCED_PRECONDITION reason code records correct failure code', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const res = fixtures.adjudicationService.rejectSubmission({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        reason: 'Precondition fenced',
      });

      expect(res.disposition.disposition_reason).toBe('FENCED_PRECONDITION');
      expect(res.adjudication.failure_code).toBe('FENCED_PRECONDITION');
    });

    it('44. rejectSubmission appends exactly one event to coder_submission_adjudication_events and generic events', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const res = fixtures.adjudicationService.rejectSubmission({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        reason: 'Clean rejection',
      });

      const adjEvents = fixtures.repo.getCoderSubmissionAdjudicationEvents(res.adjudication.id);
      expect(adjEvents).toHaveLength(1);
      expect(adjEvents[0].event_type).toBe('REJECTED');

      const genericEvents = db.prepare('SELECT * FROM events WHERE task_id = ?').all(fixtures.taskId) as Array<{ type: string }>;
      const rejectGeneric = genericEvents.filter((e) => e.type === 'CODER_SUBMISSION_REJECTED');
      expect(rejectGeneric).toHaveLength(1);
    });

    it('45. supersedeSubmission requires exact replacement submission ID', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      expect(() => {
        fixtures.adjudicationService.supersedeSubmission({
          requestId: crypto.randomUUID(),
          submissionId: subId,
          replacementSubmissionId: '',
          reason: 'Missing replacement',
        });
      }).toThrow();
    });

    it('46. supersedeSubmission fails closed when replacement submission does not exist', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      expect(() => {
        fixtures.adjudicationService.supersedeSubmission({
          requestId: crypto.randomUUID(),
          submissionId: subId,
          replacementSubmissionId: crypto.randomUUID(),
          reason: 'Non-existent replacement',
        });
      }).toThrow(/not found/i);
    });

    it('47. supersedeSubmission fails closed when replacement belongs to different task or authorization', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const sub1 = crypto.randomUUID();
      const sub2 = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, sub1), plaintextToken);

      // Create a second task and submission
      const nowIso = new Date().toISOString();
      const task2 = 'task-diff-' + crypto.randomUUID();
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, base_sha, ownership_epoch, created_at, updated_at)
        VALUES (?, ?, 'Task 2', 'CODING', 'LOW', 'LOW', 1, 3, 0, ?, 1, ?, ?)
      `).run(task2, fixtures.projectId, fixtures.baseSha, nowIso, nowIso);

      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, sub2), plaintextToken);
      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare('UPDATE coder_submissions SET task_id = ? WHERE id = ?').run(task2, sub2);

      expect(() => {
        fixtures.adjudicationService.supersedeSubmission({
          requestId: crypto.randomUUID(),
          submissionId: sub1,
          replacementSubmissionId: sub2,
          reason: 'Cross-task supersede',
        });
      }).toThrow(/same authority tuple/i);
    });

    it('48. Timestamp-only supersession is impossible (fails without exact replacement ID)', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      expect(() => {
        fixtures.adjudicationService.supersedeSubmission({
          requestId: crypto.randomUUID(),
          submissionId: subId,
          replacementSubmissionId: subId, // Self replacement
          reason: 'Self supersede',
        });
      }).toThrow(/cannot supersede itself/i);
    });

    it('49. supersedeSubmission updates status to SUPERSEDED, links replacement_submission_id, and records events', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const sub1 = crypto.randomUUID();
      const sub2 = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, sub1), plaintextToken);
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, sub2), plaintextToken);

      const res = fixtures.adjudicationService.supersedeSubmission({
        requestId: crypto.randomUUID(),
        submissionId: sub1,
        replacementSubmissionId: sub2,
        reason: 'Superseded by newer claim',
      });

      expect(res.adjudication.status).toBe('SUPERSEDED');
      expect(res.adjudication.action).toBe('SUPERSEDE');
      expect(res.disposition.disposition_event).toBe('SETTLED');
      expect(res.disposition.disposition_reason).toBe('SUPERSEDED_SUBMISSION');

      const failureJson = JSON.parse(res.adjudication.failure_json!);
      expect(failureJson.replacement_submission_id).toBe(sub2);

      const adjEvents = fixtures.repo.getCoderSubmissionAdjudicationEvents(res.adjudication.id);
      expect(adjEvents).toHaveLength(1);
      expect(adjEvents[0].event_type).toBe('SUPERSEDED');
    });

    it('50. Replay with identical request_id and payload returns cached result without secondary mutation (idempotent)', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const reqId = crypto.randomUUID();
      const res1 = fixtures.adjudicationService.rejectSubmission({
        requestId: reqId,
        submissionId: subId,
        reason: 'Replay test',
      });

      const res2 = fixtures.adjudicationService.rejectSubmission({
        requestId: reqId,
        submissionId: subId,
        reason: 'Replay test',
      });

      expect(res1.adjudication.id).toBe(res2.adjudication.id);
      const count = db.prepare('SELECT COUNT(*) as c FROM coder_submission_adjudications WHERE request_id = ?').get(reqId) as { c: number };
      expect(count.c).toBe(1);
    });

    it('51. Replay with identical request_id but different arguments fails closed with REQUEST_ID_CONFLICT', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const sub1 = crypto.randomUUID();
      const sub2 = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, sub1), plaintextToken);
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, sub2), plaintextToken);

      const reqId = crypto.randomUUID();
      fixtures.adjudicationService.rejectSubmission({
        requestId: reqId,
        submissionId: sub1,
        reason: 'Initial reject',
      });

      expect(() => {
        fixtures.adjudicationService.rejectSubmission({
          requestId: reqId,
          submissionId: sub2, // Different submission
          reason: 'Conflicting reject',
        });
      }).toThrow(/REQUEST_ID_CONFLICT/);
    });

    it('52. Concurrent Owner actions yield exactly one winner under partial unique active index', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const reqId1 = crypto.randomUUID();
      const reqId2 = crypto.randomUUID();

      const p1 = fixtures.adjudicationService.admitSubmissionForVerification({ requestId: reqId1, submissionId: subId });
      const p2 = fixtures.adjudicationService.admitSubmissionForVerification({ requestId: reqId2, submissionId: subId });

      const results = await Promise.allSettled([p1, p2]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
    });

    it('53. Reject on already terminal adjudication fails closed', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      fixtures.adjudicationService.rejectSubmission({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        reason: 'First reject',
      });

      expect(() => {
        fixtures.adjudicationService.rejectSubmission({
          requestId: crypto.randomUUID(),
          submissionId: subId,
          reason: 'Second reject',
        });
      }).toThrow(/already terminal|already settled or rejected/i);
    });

    it('54. Supersede on already terminal adjudication fails closed', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const sub1 = crypto.randomUUID();
      const sub2 = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, sub1), plaintextToken);
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, sub2), plaintextToken);

      fixtures.adjudicationService.rejectSubmission({
        requestId: crypto.randomUUID(),
        submissionId: sub1,
        reason: 'First reject',
      });

      expect(() => {
        fixtures.adjudicationService.supersedeSubmission({
          requestId: crypto.randomUUID(),
          submissionId: sub1,
          replacementSubmissionId: sub2,
          reason: 'Supersede rejected',
        });
      }).toThrow(/already terminal|already settled or rejected/i);
    });

    it('55. Owner actions fail closed if database transaction fails', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Force a failure by dropping events table
      db.exec('DROP TABLE coder_submission_adjudication_events;');

      expect(() => {
        fixtures.adjudicationService.rejectSubmission({
          requestId: crypto.randomUUID(),
          submissionId: subId,
          reason: 'Fail transaction',
        });
      }).toThrow();

      // Ensure no orphaned adjudication row was committed
      const adj = fixtures.repo.getCoderSubmissionAdjudicationsBySubmission(subId);
      expect(adj).toHaveLength(0);
    });

    it('56. Rejection of an integrity-fenced submission succeeds and permanently closes the candidate', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Tamper content after dropping immutability trigger
      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare(`UPDATE coder_submissions SET claim_content_hash = '${'f'.repeat(64)}' WHERE id = ?`).run(subId);

      const res = fixtures.adjudicationService.rejectSubmission({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        reason: 'Rejection of tampered submission',
      });

      expect(res.adjudication.status).toBe('REJECTED');
      expect(res.disposition.disposition_reason).toBe('INTEGRITY_MISMATCH');
    });
  });


});
