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



  describe('Group 1: Category A — Migration 23 & Schema Authority', () => {
    it('1. Fresh Migration 1->23 applies cleanly on empty database ending at version 23', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb, 23);
      const count = (testDb.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as { c: number }).c;
      expect(count).toBe(23);
      verifyMigration23SchemaAuthority(testDb);
      testDb.close();
    });

    it('2. Upgrade Migration 1->22->23 applies cleanly on existing database', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb, 22);
      const count22 = (testDb.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as { c: number }).c;
      expect(count22).toBe(22);
      verifyMigration22SchemaAuthority(testDb);

      MigrationRunner.run(testDb, 23);
      const count23 = (testDb.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as { c: number }).c;
      expect(count23).toBe(23);
      verifyMigration23SchemaAuthority(testDb);
      testDb.close();
    });

    it('3. MIGRATIONS array contains exactly 24 migrations with 023_r5j_quarantined_submission_adjudication_and_verification_admission', () => {
      expect(MIGRATIONS).toHaveLength(24);
      expect(MIGRATIONS[22].version).toBe(23);
      expect(MIGRATIONS[22].name).toBe('023_r5j_quarantined_submission_adjudication_and_verification_admission');
    });

    it('4. verifyMigration23SchemaAuthority validates authentic Migration 23 database cleanly', () => {
      expect(() => verifyMigration23SchemaAuthority(db)).not.toThrow();
    });

    it('5. coder_submission_adjudications table exists with exactly 39 columns, correct types, nullability, and PK', () => {
      const cols = db.prepare("PRAGMA table_info('coder_submission_adjudications')").all() as Array<{
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
        pk: number;
      }>;
      expect(cols).toHaveLength(39);

      const colMap = new Map(cols.map((c) => [c.name, c]));
      expect(colMap.get('id')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 1 });
      expect(colMap.get('request_id')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 });
      expect(colMap.get('submission_id')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 });
      expect(colMap.get('authorization_id')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 });
      expect(colMap.get('project_id')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 });
      expect(colMap.get('task_id')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 });
      expect(colMap.get('attempt_id')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 });
      expect(colMap.get('assignment_id')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 });
      expect(colMap.get('task_ownership_epoch')).toMatchObject({ type: 'INTEGER', notnull: 1, pk: 0 });
      expect(colMap.get('action')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 });
      expect(colMap.get('status')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 });
      expect(colMap.get('lifecycle_version')).toMatchObject({ type: 'INTEGER', notnull: 1, pk: 0 });
      expect(colMap.get('authority_snapshot_json')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 });
      expect(colMap.get('authority_snapshot_hash')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 });
      expect(colMap.get('verification_commands_json')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('verification_commands_hash')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('workspace_snapshot_before_json')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('workspace_snapshot_before_hash')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('verification_execution_id')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('protocol_message_id')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('test_run_id')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('git_status_evidence_id')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('git_diff_evidence_id')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('verification_result_envelope_json')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('verification_result_envelope_hash')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('failure_code')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('failure_json')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('created_at')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 });
      expect(colMap.get('verification_started_at')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('completed_at')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('recovery_fenced_at')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('resolution_action')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('resolution_timestamp')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('resolution_evidence_json')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('resolution_evidence_hash')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('resolver_id')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('artifact_manifest_json')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('artifact_manifest_hash')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('workspace_lease_id')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
    });

    it('6. coder_submission_adjudication_events table exists with exactly 7 columns, correct types, nullability, and PK', () => {
      const cols = db.prepare("PRAGMA table_info('coder_submission_adjudication_events')").all() as Array<{
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
        pk: number;
      }>;
      expect(cols).toHaveLength(7);
      const colMap = new Map(cols.map((c) => [c.name, c]));
      expect(colMap.get('id')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 1 });
      expect(colMap.get('adjudication_id')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 });
      expect(colMap.get('sequence')).toMatchObject({ type: 'INTEGER', notnull: 1, pk: 0 });
      expect(colMap.get('event_type')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 });
      expect(colMap.get('payload_json')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 });
      expect(colMap.get('payload_hash')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 });
      expect(colMap.get('created_at')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 });
    });

    it('7. Foreign keys on coder_submission_adjudications: all 11 FKs reference exact tables with ON DELETE RESTRICT', () => {
      const fks = db.prepare("PRAGMA foreign_key_list('coder_submission_adjudications')").all() as Array<{
        table: string;
        from: string;
        to: string;
        on_delete: string;
      }>;
      expect(fks).toHaveLength(11);
      const fkMap = new Map(fks.map((fk) => [fk.from, fk]));
      expect(fkMap.get('submission_id')).toMatchObject({ table: 'coder_submissions', to: 'id', on_delete: 'RESTRICT' });
      expect(fkMap.get('authorization_id')).toMatchObject({ table: 'execution_authorizations', to: 'id', on_delete: 'RESTRICT' });
      expect(fkMap.get('project_id')).toMatchObject({ table: 'projects', to: 'id', on_delete: 'RESTRICT' });
      expect(fkMap.get('task_id')).toMatchObject({ table: 'tasks', to: 'id', on_delete: 'RESTRICT' });
      expect(fkMap.get('attempt_id')).toMatchObject({ table: 'task_attempts', to: 'id', on_delete: 'RESTRICT' });
      expect(fkMap.get('assignment_id')).toMatchObject({ table: 'agent_assignments', to: 'id', on_delete: 'RESTRICT' });
      expect(fkMap.get('workspace_lease_id')).toMatchObject({ table: 'coder_submission_workspace_leases', to: 'id', on_delete: 'SET NULL' });
    });

    it('8. Foreign key on coder_submission_adjudication_events: adjudication_id -> coder_submission_adjudications(id) ON DELETE RESTRICT', () => {
      const fks = db.prepare("PRAGMA foreign_key_list('coder_submission_adjudication_events')").all() as Array<{
        table: string;
        from: string;
        to: string;
        on_delete: string;
      }>;
      expect(fks).toHaveLength(1);
      expect(fks[0]).toMatchObject({ table: 'coder_submission_adjudications', from: 'adjudication_id', to: 'id', on_delete: 'RESTRICT' });
    });

    it('9. Partial unique index idx_coder_submission_adjudications_active restricts at most one active adjudication per submission', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);
      const snapshotHash = computeSha256(snapshotJson);

      const adj1 = crypto.randomUUID();
      const req1 = crypto.randomUUID();
      // Insert first active adjudication (ADMITTED)
      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'ADMITTED', 1, ?, ?,
          '{}', '${'1'.repeat(64)}', ?
        )
      `).run(adj1, req1, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, nowIso);

      const adj2 = crypto.randomUUID();
      const req2 = crypto.randomUUID();
      // Second active adjudication (ADMITTED) must fail unique constraint on submission_id
      expect(() => {
        db.prepare(`
          INSERT INTO coder_submission_adjudications (
            id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
            task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
            verification_commands_json, verification_commands_hash, created_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'ADMITTED', 1, ?, ?,
            '{}', '${'1'.repeat(64)}', ?
          )
        `).run(adj2, req2, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, nowIso);
      }).toThrow(/UNIQUE constraint failed/);
    });

    it('10. Partial unique index allows multiple terminal adjudications (REJECTED, SUPERSEDED) for same submission', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);
      const snapshotHash = computeSha256(snapshotJson);

      const adjT1 = crypto.randomUUID();
      const reqT1 = crypto.randomUUID();
      // Insert first terminal adjudication (REJECTED)
      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          created_at, completed_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'REJECT', 'REJECTED', 1, ?, ?, ?, ?
        )
      `).run(adjT1, reqT1, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, nowIso, nowIso);

      const adjT2 = crypto.randomUUID();
      const reqT2 = crypto.randomUUID();
      // Second terminal adjudication (SUPERSEDED) succeeds
      expect(() => {
        db.prepare(`
          INSERT INTO coder_submission_adjudications (
            id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
            task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
            created_at, completed_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, 1, 'SUPERSEDE', 'SUPERSEDED', 1, ?, ?, ?, ?
          )
        `).run(adjT2, reqT2, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, nowIso, nowIso);
      }).not.toThrow();
    });

    it('11. Action CHECK constraint enforces exact domain (ADMIT_VERIFICATION, REJECT, SUPERSEDE)', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      expect(() => {
        db.prepare(`
          INSERT INTO coder_submission_adjudications (
            id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
            task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash, created_at, completed_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?,
            1, 'INVALID_ACTION', 'REJECTED', 1, '{}', '${'0'.repeat(64)}', ?, ?
          )
        `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, nowIso, nowIso);
      }).toThrow(/CHECK constraint failed/);
    });

    it('12. Status CHECK constraint enforces exact domain (ADMITTED, VERIFYING, VERIFIED, VERIFICATION_FAILED, RECOVERY_FENCED, REJECTED, SUPERSEDED)', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      expect(() => {
        db.prepare(`
          INSERT INTO coder_submission_adjudications (
            id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
            task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash, created_at, completed_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?,
            1, 'REJECT', 'INVALID_STATUS', 1, '{}', '${'0'.repeat(64)}', ?, ?
          )
        `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, nowIso, nowIso);
      }).toThrow(/CHECK constraint failed/);
    });

    it('13. Event type CHECK constraint enforces exact domain on coder_submission_adjudication_events', () => {
      const nowIso = new Date().toISOString();
      const evtId = crypto.randomUUID();
      const adjId = crypto.randomUUID();
      expect(() => {
        db.prepare(`
          INSERT INTO coder_submission_adjudication_events (
            id, adjudication_id, sequence, event_type, payload_json, payload_hash, created_at
          ) VALUES (
            ?, ?, 1, 'INVALID_EVENT_TYPE', '{}', '${'0'.repeat(64)}', ?
          )
        `).run(evtId, adjId, nowIso);
      }).toThrow(/CHECK constraint failed/);
    });

    it('14. Grouped nullability constraints: ADMIT_VERIFICATION requires non-null verification_commands_json and verification_commands_hash', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      const nowIso = new Date().toISOString();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);
      const snapshotHash = computeSha256(snapshotJson);

      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      expect(() => {
        db.prepare(`
          INSERT INTO coder_submission_adjudications (
            id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
            task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
            verification_commands_json, verification_commands_hash, created_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'ADMITTED', 1, ?, ?,
            NULL, NULL, ?
          )
        `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, nowIso);
      }).toThrow(/CHECK constraint failed/);
    });

    it('15. Grouped nullability constraints: REJECT requires null verification_commands_json', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      const nowIso = new Date().toISOString();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);
      const snapshotHash = computeSha256(snapshotJson);

      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      expect(() => {
        db.prepare(`
          INSERT INTO coder_submission_adjudications (
            id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
            task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
            verification_commands_json, verification_commands_hash, created_at, completed_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, 1, 'REJECT', 'REJECTED', 1, ?, ?,
            '{}', '${'1'.repeat(64)}', ?, ?
          )
        `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, nowIso, nowIso);
      }).toThrow(/CHECK constraint failed/);
    });

    it('16. Grouped nullability constraints: SUPERSEDE action enforces SUPERSEDED status', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      const nowIso = new Date().toISOString();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);
      const snapshotHash = computeSha256(snapshotJson);

      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      expect(() => {
        db.prepare(`
          INSERT INTO coder_submission_adjudications (
            id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
            task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
            created_at, completed_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, 1, 'SUPERSEDE', 'ADMITTED', 1, ?, ?, ?, ?
          )
        `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, nowIso, nowIso);
      }).toThrow(/CHECK constraint failed/);
    });

    it('17. SHA-256 hex constraint: rejects uppercase, non-hex, or non-64-char strings', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      expect(() => {
        db.prepare(`
          INSERT INTO coder_submission_adjudications (
            id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
            task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash, created_at, completed_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?,
            1, 'REJECT', 'REJECTED', 1, '{}', 'UPPERCASE_NOT_ALLOWED_0123456789abcdef0123456789abcdef0123456789ab', ?, ?
          )
        `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, nowIso, nowIso);
      }).toThrow(/CHECK constraint failed/);
    });

    it('18. Trigger trg_coder_submission_adjudications_immutable prevents UPDATE on immutable binding/decision columns', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const res = fixtures.adjudicationService.rejectSubmission({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        reason: 'Testing immutability',
      });

      expect(() => {
        db.prepare("UPDATE coder_submission_adjudications SET project_id = 'tampered' WHERE id = ?").run(res.adjudication.id);
      }).toThrow(/immutable/i);

      expect(() => {
        db.prepare("UPDATE coder_submission_adjudications SET task_id = 'tampered' WHERE id = ?").run(res.adjudication.id);
      }).toThrow(/immutable/i);

      expect(() => {
        db.prepare("UPDATE coder_submission_adjudications SET action = 'ADMIT_VERIFICATION' WHERE id = ?").run(res.adjudication.id);
      }).toThrow(/immutable/i);
    });

    it('19. Trigger trg_coder_submission_adjudications_lifecycle allows valid transition ADMITTED -> VERIFYING with lifecycle_version incremented by 1', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);
      const snapshotHash = computeSha256(snapshotJson);

      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'ADMITTED', 1, ?, ?,
          '{}', '${'1'.repeat(64)}', ?
        )
      `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, nowIso);

      // Valid update: status ADMITTED -> VERIFYING with lifecycle_version 1 -> 2 and required fields
      expect(() => {
        db.prepare(`
          UPDATE coder_submission_adjudications
          SET status = 'VERIFYING',
              lifecycle_version = 2,
              verification_started_at = ?,
              verification_execution_id = ?,
              workspace_snapshot_before_json = '{}',
              workspace_snapshot_before_hash = ?
          WHERE id = ?
        `).run(nowIso, crypto.randomUUID(), computeSha256('{}'), adjId);
      }).not.toThrow();

      const updated = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(updated.status).toBe('VERIFYING');
      expect(updated.lifecycle_version).toBe(2);
    });

    it('20. Trigger trg_coder_submission_adjudications_lifecycle rejects illegal transition ADMITTED -> VERIFIED directly', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);
      const snapshotHash = computeSha256(snapshotJson);

      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'ADMITTED', 1, ?, ?,
          '{}', '${'1'.repeat(64)}', ?
        )
      `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, nowIso);

      // Illegal update: status ADMITTED -> VERIFIED directly (skipping VERIFYING)
      expect(() => {
        db.prepare(`
          UPDATE coder_submission_adjudications
          SET status = 'VERIFIED',
              lifecycle_version = 2,
              completed_at = ?
          WHERE id = ?
        `).run(nowIso, adjId);
      }).toThrow();
    });

    it('21. Trigger trg_coder_submission_adjudications_lifecycle rejects non-unit lifecycle_version jump (e.g. 1 -> 3)', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);
      const snapshotHash = computeSha256(snapshotJson);

      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'ADMITTED', 1, ?, ?,
          '{}', '${'1'.repeat(64)}', ?
        )
      `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, nowIso);

      // Non-unit jump: 1 -> 3
      expect(() => {
        db.prepare(`
          UPDATE coder_submission_adjudications
          SET status = 'VERIFYING',
              lifecycle_version = 3,
              verification_started_at = ?,
              verification_execution_id = ?,
              workspace_snapshot_before_json = '{}',
              workspace_snapshot_before_hash = ?
          WHERE id = ?
        `).run(nowIso, crypto.randomUUID(), computeSha256('{}'), adjId);
      }).toThrow(/Adjudication lifecycle_version must increment by exactly 1/);
    });

    it('22. Trigger trg_coder_submission_adjudications_no_delete prohibits DELETE on coder_submission_adjudications', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      expect(() => {
        db.prepare('DELETE FROM coder_submission_adjudications WHERE id = ?').run(admitRes.adjudication.id);
      }).toThrow(/DELETE is prohibited/);
    });

    it('23. Trigger trg_coder_submission_adjudication_events_no_update prohibits UPDATE on coder_submission_adjudication_events', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const events = fixtures.repo.getCoderSubmissionAdjudicationEvents(admitRes.adjudication.id);
      expect(events.length).toBeGreaterThan(0);

      expect(() => {
        db.prepare("UPDATE coder_submission_adjudication_events SET event_type = 'TAMPERED' WHERE id = ?").run(events[0].id);
      }).toThrow(/UPDATE is prohibited/);
    });

    it('24. Trigger trg_coder_submission_adjudication_events_no_delete prohibits DELETE on coder_submission_adjudication_events', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const events = fixtures.repo.getCoderSubmissionAdjudicationEvents(admitRes.adjudication.id);
      expect(events.length).toBeGreaterThan(0);

      expect(() => {
        db.prepare('DELETE FROM coder_submission_adjudication_events WHERE id = ?').run(events[0].id);
      }).toThrow(/DELETE is prohibited/);
    });

    it('25. Near-miss schema: verifyMigration23SchemaAuthority rejects altered column or missing trigger', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb, 23);

      testDb.exec('DROP TRIGGER trg_coder_submission_adjudications_no_delete;');
      expect(() => verifyMigration23SchemaAuthority(testDb)).toThrow(/ADJUDICATION_SCHEMA_AUTHORITY_INVALID/);
      testDb.close();
    });
  });


});
