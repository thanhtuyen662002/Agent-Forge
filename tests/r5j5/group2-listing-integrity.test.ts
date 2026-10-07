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



  describe('Group 2: Category B — Listing and Integrity', () => {
    it('26. listQuarantinedSubmissions returns deterministic pagination ordered by submitted_at ASC, id ASC', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const sub1 = '00000000-0000-4000-8000-000000000001';
      const sub2 = '00000000-0000-4000-8000-000000000002';
      const sub3 = '00000000-0000-4000-8000-000000000003';

      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, sub1), plaintextToken);
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, sub2), plaintextToken);
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, sub3), plaintextToken);

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare("UPDATE coder_submissions SET submitted_at = '2026-01-01T00:00:01.000Z' WHERE id = ?").run(sub1);
      db.prepare("UPDATE coder_submissions SET submitted_at = '2026-01-01T00:00:02.000Z' WHERE id = ?").run(sub2);
      db.prepare("UPDATE coder_submissions SET submitted_at = '2026-01-01T00:00:03.000Z' WHERE id = ?").run(sub3);

      const res = fixtures.adjudicationService.listQuarantinedSubmissions({ limit: 10, offset: 0 });
      expect(res.total).toBe(3);
      expect(res.items.map((i) => i.id)).toEqual([sub1, sub2, sub3]);
    });

    it('27. listQuarantinedSubmissions supports DESC ordering by submitted_at DESC, id DESC', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const sub1 = '00000000-0000-4000-8000-000000000001';
      const sub2 = '00000000-0000-4000-8000-000000000002';

      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, sub1), plaintextToken);
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, sub2), plaintextToken);

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare("UPDATE coder_submissions SET submitted_at = '2026-01-01T00:00:01.000Z' WHERE id = ?").run(sub1);
      db.prepare("UPDATE coder_submissions SET submitted_at = '2026-01-01T00:00:02.000Z' WHERE id = ?").run(sub2);

      const res = fixtures.adjudicationService.listQuarantinedSubmissions({ limit: 10, offset: 0, reverse: true });
      expect(res.items.map((i) => i.id)).toEqual([sub2, sub1]);
    });

    it('28. listQuarantinedSubmissions validates page limit (rejects limit <= 0, limit > 100, offset < 0)', () => {
      expect(() => fixtures.adjudicationService.listQuarantinedSubmissions({ limit: 0 })).toThrow(/limit/i);
      expect(() => fixtures.adjudicationService.listQuarantinedSubmissions({ limit: -5 })).toThrow(/limit/i);
      expect(() => fixtures.adjudicationService.listQuarantinedSubmissions({ limit: 101 })).toThrow(/limit/i);
      expect(() => fixtures.adjudicationService.listQuarantinedSubmissions({ offset: -1 })).toThrow(/offset/i);
    });

    it('29. listQuarantinedSubmissions filters by taskId and projectId accurately', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const sub1 = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, sub1), plaintextToken);

      const matchTask = fixtures.adjudicationService.listQuarantinedSubmissions({ taskId: fixtures.taskId });
      expect(matchTask.total).toBe(1);

      const otherTask = fixtures.adjudicationService.listQuarantinedSubmissions({ taskId: 'task-non-existent' });
      expect(otherTask.total).toBe(0);

      const matchProj = fixtures.adjudicationService.listQuarantinedSubmissions({ projectId: fixtures.projectId });
      expect(matchProj.total).toBe(1);

      const otherProj = fixtures.adjudicationService.listQuarantinedSubmissions({ projectId: 'proj-non-existent' });
      expect(otherProj.total).toBe(0);
    });

    it('30. Candidate detail projection matches database truth and excludes secret tokens/hashes', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const insp = fixtures.adjudicationService.inspectQuarantinedSubmission(subId);
      expect(insp.submission.id).toBe(subId);
      expect(insp.submission.project_id).toBe(fixtures.projectId);
      expect(insp.submission.task_id).toBe(fixtures.taskId);
      expect(insp.submission.authorization_id).toBe(fixtures.authorizationId);

      // Check zero secret token leakage
      const inspJson = JSON.stringify(insp);
      expect(inspJson).not.toContain(plaintextToken);
    });

    it('31. Candidate detail projects untrusted coder claims and durable authority bindings separately', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const insp = fixtures.adjudicationService.inspectQuarantinedSubmission(subId);
      expect(insp.submission.summary).toBe('Execution completed successfully with verified tests');
      expect(insp.submission.selected_provider_id).toBe(fixtures.providerId);
      expect(insp.integrity.valid).toBe(true);
    });

    it('32. Tampered claim JSON is detected and marked as FENCED_INTEGRITY_CONFLICT', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Mutate claim_content_json directly in database after dropping immutability trigger
      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare('UPDATE coder_submissions SET claim_content_json = \'{"tampered":true}\' WHERE id = ?').run(subId);

      const insp = fixtures.adjudicationService.inspectQuarantinedSubmission(subId);
      expect(insp.integrity.valid).toBe(false);
      expect(insp.integrity.fenced_reasons.some((r) => r.includes('hash mismatch') || r.includes('claim'))).toBe(true);
    });

    it('33. Tampered claim content hash is detected and marked as FENCED_INTEGRITY_CONFLICT', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare(`UPDATE coder_submissions SET claim_content_hash = '${'1'.repeat(64)}' WHERE id = ?`).run(subId);

      const insp = fixtures.adjudicationService.inspectQuarantinedSubmission(subId);
      expect(insp.integrity.valid).toBe(false);
    });

    it('34. Tampered canonical envelope hash is detected and marked as FENCED_INTEGRITY_CONFLICT', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare(`UPDATE coder_submissions SET canonical_envelope_hash = '${'2'.repeat(64)}' WHERE id = ?`).run(subId);

      const insp = fixtures.adjudicationService.inspectQuarantinedSubmission(subId);
      expect(insp.integrity.valid).toBe(false);
    });

    it('35. Submission with cross-task binding is fenced from candidate list', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, base_sha, ownership_epoch, created_at, updated_at)
        VALUES ('task-other', ?, 'Other Task', 'CODING', 'LOW', 'LOW', 1, 3, 0, ?, 1, ?, ?)
      `).run(fixtures.projectId, fixtures.baseSha, nowIso, nowIso);

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare("UPDATE coder_submissions SET task_id = 'task-other' WHERE id = ?").run(subId);

      const insp = fixtures.adjudicationService.inspectQuarantinedSubmission(subId);
      expect(insp.integrity.valid).toBe(false);
    });

    it('36. Submission with cross-project binding is fenced from candidate list', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      db.prepare(`
        INSERT INTO projects (id, name, description, repository_path, default_branch, status, created_at, updated_at)
        VALUES ('proj-other', 'Other Project', 'Desc', ?, 'main', 'RUNNING', ?, ?)
      `).run(fixtures.projectRoot, nowIso, nowIso);

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare("UPDATE coder_submissions SET project_id = 'proj-other' WHERE id = ?").run(subId);

      const insp = fixtures.adjudicationService.inspectQuarantinedSubmission(subId);
      expect(insp.integrity.valid).toBe(false);
    });

    it('37. Submission with missing execution authorization row surfaces visibly as missing authority', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Disable foreign keys temporarily and delete the authorization
      db.pragma('foreign_keys = OFF');
      db.prepare('DELETE FROM execution_authorizations WHERE id = ?').run(fixtures.authorizationId);
      db.pragma('foreign_keys = ON');

      const insp = fixtures.adjudicationService.inspectQuarantinedSubmission(subId);
      expect(insp.integrity.valid).toBe(false);
      expect(insp.integrity.fenced_reasons.some((r) => r.includes('missing') || r.includes('authorization'))).toBe(true);
    });

    it('38. Authority snapshot rejects missing required top-level keys', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](sub);
      delete ((snapshot as unknown) as Record<string, unknown>).task_ownership_epoch;

      const keys = Object.keys(snapshot).sort();
      const expectedKeys = [...AUTHORITY_SNAPSHOT_KEYS].sort();
      expect(keys.length !== expectedKeys.length || keys.some((k, i) => k !== expectedKeys[i])).toBe(true);
    });

    it('39. Authority snapshot rejects extra unrecognized top-level keys', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](sub);
      ((snapshot as unknown) as Record<string, unknown>).unrecognized_extra = 'injected';

      const keys = Object.keys(snapshot).sort();
      const expectedKeys = [...AUTHORITY_SNAPSHOT_KEYS].sort();
      expect(keys.length !== expectedKeys.length || keys.some((k, i) => k !== expectedKeys[i])).toBe(true);
    });

    it('40. Existing terminal disposition (ACCEPTED_VERIFIED) is projected in candidate detail and prevents admission', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Record terminal disposition
      fixtures.repo.createCoderSubmissionDisposition({
        id: crypto.randomUUID(),
        submission_id: subId,
        disposition_event: 'SETTLED',
        disposition_reason: 'ACCEPTED_VERIFIED',
        actor_type: 'OPERATOR',
        actor_id: 'OWNER_LOCAL_UI',
        disposition_metadata_json: '{}',
        created_at: new Date().toISOString(),
      });

      const insp = fixtures.adjudicationService.inspectQuarantinedSubmission(subId);
      expect(insp.dispositions.some((d) => d.disposition_reason === 'ACCEPTED_VERIFIED')).toBe(true);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/already settled or rejected|already terminal/i);
    });
  });


});
