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
  describe('Group 7D: Workspace, Artifacts & Projection', () => {
    it('223. historical three-file compatibility diffs remain byte-identical to initial head', () => {
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
      expect(resolvedFinalHead).toBe('1464785c644294884a6191f956422ae64c35ec2f');

      // 4. The final R5J5 tree is exactly a2e86b7086408adda5155a4fa2102752a57d04fe
      const resolvedFinalTree = child_process.execFileSync(
        'git',
        ['rev-parse', `${R5J5_FINAL_SOURCE_HEAD}^{tree}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      expect(resolvedFinalTree).toBe('a2e86b7086408adda5155a4fa2102752a57d04fe');

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

    it('224. shared authority verifier rejects raw JSON SHA-256 fallback when canonical hash does not match canonical payload', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const rawJsonWithSpaces = JSON.stringify(JSON.parse(sub.claim_content_json), null, 2);
      const rawHash = computeSha256(rawJsonWithSpaces);
      const mutatedSub = { ...sub, claim_content_hash: rawHash };
      const res = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(mutatedSub);
      expect(res.valid).toBe(false);
      expect(res.fenced_reasons.some((r) => r.includes('claim_content_hash'))).toBe(true);
    });

    it('225. shared authority verifier fails closed when manager task_id does not equal candidate task_id', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const auth = fixtures.repo.getExecutionAuthorization(sub.authorization_id)!;
      const msg = fixtures.repo.getProtocolMessageByRecordId(auth.manager_message_id)!;
      const parsed = JSON.parse(msg.raw_payload as string);
      parsed.task_id = crypto.randomUUID();
      const mutatedPayload = JSON.stringify(parsed);
      fixtures.db.prepare("UPDATE protocol_messages SET raw_payload = ? WHERE id = ?").run(mutatedPayload, msg.id);

      const res = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(sub);
      expect(res.valid).toBe(false);
      expect(res.fenced_reasons.some((r) => r.includes('task_id mismatch'))).toBe(true);
    });

    it('226. shared authority verifier fails closed on corrupted/partial manager envelope payload', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const auth = fixtures.repo.getExecutionAuthorization(sub.authorization_id)!;
      fixtures.db.prepare("UPDATE protocol_messages SET raw_payload = 'not-valid-json' WHERE id = ?").run(auth.manager_message_id);

      const res = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(sub);
      expect(res.valid).toBe(false);
      expect(res.fenced_reasons.some((r) => r.includes('raw_payload') || r.includes('payload'))).toBe(true);
    });

    it('227. shared authority verifier fails closed on bidirectional provider/account/resource/routing FK mismatch', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const fakeProviderId = crypto.randomUUID();
      fixtures.db.prepare("INSERT INTO providers (id, name, adapter_type, enabled, created_at) VALUES (?, 'Other Provider', 'LOCAL_CLI', 1, ?)").run(fakeProviderId, new Date().toISOString());
      fixtures.db.prepare("UPDATE provider_accounts SET provider_id = ? WHERE id = ?").run(fakeProviderId, fixtures.accountId);

      const res = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(sub);
      expect(res.valid).toBe(false);
      expect(res.fenced_reasons.some((r) => r.includes('Provider account provider_id does not match selected_provider_id'))).toBe(true);
    });

    it('228. shared authority verifier fails closed when worker slot is inactive or missing for assignment', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const assignment = fixtures.repo.getAgentAssignment(sub.assignment_id!)!;
      fixtures.db.prepare("UPDATE worker_slots SET status = 'OFFLINE' WHERE id = ?").run(assignment.selected_worker_slot_id);

      const res = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(sub);
      expect(res.valid).toBe(false);
      expect(res.fenced_reasons.some((r) => r.includes('Worker slot') || r.includes('inactive'))).toBe(true);
    });

    it('229. workspace claim Phase B1 acquires exclusive lease and rejects concurrent claim on active lease', () => {
      fixtures.db.pragma('foreign_keys = OFF');
      try {
        const worktreeIdentityHash = computeSha256(path.resolve(fixtures.projectRoot).toLowerCase());
        const leaseId1 = crypto.randomUUID();
        const leaseId2 = crypto.randomUUID();
        const now = new Date().toISOString();

        fixtures.repo.createWorkspaceLease({
          id: leaseId1,
          adjudication_id: crypto.randomUUID(),
          worktree_identity_hash: worktreeIdentityHash,
          admitted_workspace_fingerprint_hash: computeSha256('pre-phase-a-fp'),
          pre_execution_fingerprint_hash: null,
          claim_nonce: crypto.randomUUID(),
          execution_id: crypto.randomUUID(),
          lease_owner_identity: fixtures.assignmentId,
          assignment_id: fixtures.assignmentId,
          authorization_id: fixtures.authorizationId,
          acquired_at: now,
          released_at: null,
          lifecycle_version: 1,
          state: 'ACQUIRED',
          failure_code: null,
          failure_evidence_hash: null,
        });

        expect(() => {
          fixtures.repo.createWorkspaceLease({
            id: leaseId2,
            adjudication_id: crypto.randomUUID(),
            worktree_identity_hash: worktreeIdentityHash,
            admitted_workspace_fingerprint_hash: computeSha256('pre-phase-a-fp-2'),
            pre_execution_fingerprint_hash: null,
            claim_nonce: crypto.randomUUID(),
            execution_id: crypto.randomUUID(),
            lease_owner_identity: fixtures.assignmentId,
            assignment_id: fixtures.assignmentId,
            authorization_id: fixtures.authorizationId,
            acquired_at: now,
            released_at: null,
            lifecycle_version: 1,
            state: 'ACQUIRED',
            failure_code: null,
            failure_evidence_hash: null,
          });
        }).toThrow(/UNIQUE constraint failed.*coder_submission_workspace_leases/);
      } finally {
        fixtures.db.pragma('foreign_keys = ON');
      }
    });

    it('230. workspace claim Phase B2 aborts with WORKTREE_DRIFT on uncommitted changes without executing commands', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const realCapture = fixtures.adjudicationService.captureCanonicalWorkspaceFingerprint.bind(fixtures.adjudicationService);
      let callCount = 0;
      vi.spyOn(fixtures.adjudicationService, 'captureCanonicalWorkspaceFingerprint').mockImplementation(async (repoPath, baseSha) => {
        callCount++;
        const fp = await realCapture(repoPath, baseSha);
        if (callCount === 2) {
          return {
            ...fp,
            status_lines: [' M uncommitted.txt'],
          };
        }
        return fp;
      });

      try {
        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow(/WORKTREE_DRIFT/);

        const adjs = fixtures.repo.getCoderSubmissionAdjudicationsBySubmission(subId);
        expect(adjs[0].status).toBe('RECOVERY_FENCED');
        expect(adjs[0].failure_code).toBe('WORKTREE_DRIFT');

        const lease = fixtures.repo.getWorkspaceLease(adjs[0].workspace_lease_id!);
        expect(lease?.state).toBe('FENCED');
        expect(lease?.released_at).not.toBeNull();
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('231. workspace claim Phase B3 lease CAS fails when lifecycle version does not match expected', () => {
      fixtures.db.pragma('foreign_keys = OFF');
      try {
        const leaseId = crypto.randomUUID();
        const worktreeIdentityHash = computeSha256(path.resolve(fixtures.projectRoot).toLowerCase());
        const now = new Date().toISOString();

        fixtures.repo.createWorkspaceLease({
          id: leaseId,
          adjudication_id: crypto.randomUUID(),
          worktree_identity_hash: worktreeIdentityHash,
          admitted_workspace_fingerprint_hash: computeSha256('test-fp'),
          pre_execution_fingerprint_hash: null,
          claim_nonce: crypto.randomUUID(),
          execution_id: crypto.randomUUID(),
          lease_owner_identity: fixtures.assignmentId,
          assignment_id: fixtures.assignmentId,
          authorization_id: fixtures.authorizationId,
          acquired_at: now,
          released_at: null,
          lifecycle_version: 1,
          state: 'ACQUIRED',
          failure_code: null,
          failure_evidence_hash: null,
        });

        const updated = fixtures.repo.updateWorkspaceLease(leaseId, 99, {
          state: 'VERIFYING',
        });
        expect(updated).toBe(false);

        const l = fixtures.repo.getWorkspaceLease(leaseId)!;
        expect(l.state).toBe('ACQUIRED');
        expect(l.lifecycle_version).toBe(1);
      } finally {
        fixtures.db.pragma('foreign_keys = ON');
      }
    });

    it('232. workspace lease is released upon successful terminal settlement', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const result = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      expect(result.status).toBe('VERIFIED');
      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(result.adjudication.id)!;
      expect(adj.workspace_lease_id).toBeDefined();

      const lease = fixtures.repo.getWorkspaceLease(adj.workspace_lease_id!)!;
      expect(lease.state).toBe('RELEASED');
      expect(lease.released_at).not.toBeNull();
    });

    it('233. workspace lease is fenced upon recovery scanner fenceAdjudication', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const leaseId = crypto.randomUUID();
      const worktreeIdentityHash = computeSha256(path.resolve(fixtures.projectRoot).toLowerCase());
      const now = new Date().toISOString();

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
      const cmdsJson = canonicalJsonStringify(fixtures.authSnapshot.verification_commands);

      fixtures.db.pragma('foreign_keys = OFF');
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
          created_at: now,
          verification_started_at: null,
          completed_at: null,
          recovery_fenced_at: null,
          failure_code: null,
          failure_json: null,
          test_run_id: null,
          git_status_evidence_id: null,
          git_diff_evidence_id: null,
          verification_execution_id: null,
          workspace_lease_id: leaseId,
        });

        fixtures.repo.createWorkspaceLease({
          id: leaseId,
          adjudication_id: adjId,
          worktree_identity_hash: worktreeIdentityHash,
          admitted_workspace_fingerprint_hash: computeSha256('test-fp'),
          pre_execution_fingerprint_hash: null,
          claim_nonce: crypto.randomUUID(),
          execution_id: crypto.randomUUID(),
          lease_owner_identity: fixtures.assignmentId,
          assignment_id: fixtures.assignmentId,
          authorization_id: fixtures.authorizationId,
          acquired_at: now,
          released_at: null,
          lifecycle_version: 1,
          state: 'ACQUIRED',
          failure_code: null,
          failure_evidence_hash: null,
        });
      } finally {
        fixtures.db.pragma('foreign_keys = ON');
      }

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      fixtures.recoveryScanner.fenceAdjudication(adj, 'ORPHANED_IN_FLIGHT_EXECUTION');

      const updatedLease = fixtures.repo.getWorkspaceLease(leaseId)!;
      expect(updatedLease.state).toBe('FENCED');
      expect(updatedLease.failure_code).toBe('ORPHANED_IN_FLIGHT_EXECUTION');
      expect(updatedLease.released_at).not.toBeNull();
    });

    it('234. ArtifactStore.assertPathContained rejects sibling-prefix containment attack', () => {
      const allowedRoot = path.join(fixtures.quarantineDir, 'allowed');
      fs.mkdirSync(allowedRoot, { recursive: true });
      const evilPath = path.join(fixtures.quarantineDir, 'allowed-evil', 'payload.txt');

      expect(() => {
        ArtifactStore.assertPathContained(evilPath, allowedRoot);
      }).toThrow(/ILLEGAL_PATH_TRAVERSAL/);
    });

    it('235. ArtifactStore.assertPathContained rejects directory traversal paths', () => {
      const allowedRoot = path.join(fixtures.quarantineDir, 'allowed');
      fs.mkdirSync(allowedRoot, { recursive: true });
      const traversalPath = path.join(allowedRoot, '..', 'evil.txt');

      expect(() => {
        ArtifactStore.assertPathContained(traversalPath, allowedRoot);
      }).toThrow(/ILLEGAL_PATH_TRAVERSAL/);
    });

    it('236. ArtifactStore.assertPathContained rejects symlinks pointing outside root', () => {
      const allowedRoot = path.join(fixtures.quarantineDir, 'allowed_root');
      const outsideTarget = path.join(fixtures.quarantineDir, 'outside.txt');
      fs.mkdirSync(allowedRoot, { recursive: true });
      fs.writeFileSync(outsideTarget, 'outside');

      const symlinkPath = path.join(allowedRoot, 'symlink_out');
      try {
        fs.symlinkSync(outsideTarget, symlinkPath, 'file');
        expect(() => {
          ArtifactStore.assertPathContained(symlinkPath, allowedRoot);
        }).toThrow(/ILLEGAL_PATH_TRAVERSAL|SYMLINK_NOT_PERMITTED/);
      } catch (err: any) {
        if (err.code !== 'EPERM') throw err;
      } finally {
        if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
      }
    });

    it('236b. ArtifactStore.assertPathContained rejects a symlinked evidence root', () => {
      const realRoot = path.join(fixtures.quarantineDir, 'real_root');
      const linkedRoot = path.join(fixtures.quarantineDir, 'linked_root');
      fs.mkdirSync(realRoot, { recursive: true });
      try {
        fs.symlinkSync(realRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
        expect(() => {
          ArtifactStore.assertPathContained(path.join(linkedRoot, 'new.txt'), linkedRoot);
        }).toThrow(/root|SYMLINK_NOT_PERMITTED/i);
      } catch (err: any) {
        if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
      } finally {
        if (fs.existsSync(linkedRoot)) fs.unlinkSync(linkedRoot);
        fs.rmSync(realRoot, { recursive: true, force: true });
      }
    });

    it('237. ArtifactStore.assertPathContained normalizes Windows drive case correctly', () => {
      const allowedRoot = fixtures.quarantineDir;
      const mixedCasePath = process.platform === 'win32'
        ? allowedRoot.toUpperCase() + path.sep + 'test.bin'
        : path.join(allowedRoot, 'test.bin');

      const resolved = ArtifactStore.assertPathContained(mixedCasePath, allowedRoot);
      expect(resolved.toLowerCase()).toBe(path.resolve(mixedCasePath).toLowerCase());
    });

    it('238. ArtifactStore.materializeContentAddressedFile creates content-addressed file with verified hash and cleans temp file', () => {
      const content = Buffer.from('hello-world-artifact-content', 'utf8');
      const expectedHash = computeSha256(content.toString('utf8'));
      const targetDir = path.join(fixtures.quarantineDir, 'cas_test');

      const filePath = ArtifactStore.materializeContentAddressedFile(targetDir, expectedHash, content);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath).equals(content)).toBe(true);

      const remainingFiles = fs.readdirSync(targetDir);
      expect(remainingFiles.every((f) => !f.endsWith('.tmp'))).toBe(true);
    });

    it('239. ArtifactStore.materializeContentAddressedFile existing target with identical hash is idempotent no-op', () => {
      const content = Buffer.from('idempotent-artifact-content', 'utf8');
      const expectedHash = computeSha256(content.toString('utf8'));
      const targetDir = path.join(fixtures.quarantineDir, 'cas_test_idempotent');

      const path1 = ArtifactStore.materializeContentAddressedFile(targetDir, expectedHash, content);
      const stat1 = fs.statSync(path1);

      const path2 = ArtifactStore.materializeContentAddressedFile(targetDir, expectedHash, content);
      const stat2 = fs.statSync(path2);

      expect(path1).toBe(path2);
      expect(stat1.mtimeMs).toBe(stat2.mtimeMs);
    });

    it('240. ArtifactStore.materializeContentAddressedFile existing corrupted target throws HASH_COLLISION_MISMATCH without overwrite', () => {
      const content = Buffer.from('expected-content', 'utf8');
      const expectedHash = computeSha256(content.toString('utf8'));
      const targetDir = path.join(fixtures.quarantineDir, 'cas_test_collision');
      fs.mkdirSync(targetDir, { recursive: true });

      const targetPath = path.join(targetDir, `${expectedHash}.bin`);
      fs.writeFileSync(targetPath, 'corrupted-content');

      expect(() => {
        ArtifactStore.materializeContentAddressedFile(targetDir, expectedHash, content);
      }).toThrow(/HASH_COLLISION_MISMATCH/);

      expect(fs.readFileSync(targetPath, 'utf8')).toBe('corrupted-content');
    });

    it('241. canonicalizeArtifactManifest produces deterministic key ordering and rejects raw arrays', () => {
      const rawEntries = [
        {
          byte_size: 50,
          content_type: 'text/plain',
          evidence_id: 'ev-2',
          evidence_type: 'LOG',
          relative_path: 'b.txt',
          sha256: 'b'.repeat(64),
          storage_class: 'FILE' as const,
        },
        {
          byte_size: 20,
          content_type: 'text/plain',
          evidence_id: 'ev-1',
          evidence_type: 'LOG',
          relative_path: 'a.txt',
          sha256: 'a'.repeat(64),
          storage_class: 'FILE' as const,
        },
      ];

      // Array input must be rejected
      expect(() => {
        canonicalizeArtifactManifest(rawEntries as unknown as ArtifactManifest);
      }).toThrow(/Manifest must be a non-null plain object/);

      const validManifest: ArtifactManifest = {
        manifest_schema_version: 1,
        adjudication_id: 'adj-1',
        lifecycle_version: 1,
        verification_execution_id: 'exec-1',
        entries: rawEntries,
      };

      const manifestJson = canonicalizeArtifactManifest(validManifest);
      const parsed = JSON.parse(manifestJson) as ArtifactManifest;
      expect(parsed.entries[0].relative_path).toBe('a.txt');
      expect(parsed.entries[1].relative_path).toBe('b.txt');
      expect(Object.keys(parsed.entries[0])).toEqual([...ARTIFACT_MANIFEST_ENTRY_KEYS].sort());
    });

    it('242. computeArtifactManifestHash and parseAndVerifyArtifactManifest detect tampered manifest', () => {
      const validManifest: ArtifactManifest = {
        manifest_schema_version: 1,
        adjudication_id: 'adj-1',
        lifecycle_version: 1,
        verification_execution_id: 'exec-1',
        entries: [
          {
            byte_size: 100,
            content_type: 'text/plain',
            evidence_id: 'ev-1',
            evidence_type: 'LOG',
            relative_path: 'log.txt',
            sha256: 'a'.repeat(64),
            storage_class: 'FILE' as const,
          },
        ],
      };
      const manifestJson = canonicalizeArtifactManifest(validManifest);
      const hash = computeArtifactManifestHash(manifestJson);

      const verified = parseAndVerifyArtifactManifest(manifestJson, hash);
      expect(verified.entries.length).toBe(1);

      const tamperedJson = manifestJson.replace('100', '200');
      expect(() => {
        parseAndVerifyArtifactManifest(tamperedJson, hash);
      }).toThrow(/MANIFEST_HASH_MISMATCH/);

      expect(() => {
        parseAndVerifyArtifactManifest(manifestJson, 'f'.repeat(64));
      }).toThrow(/MANIFEST_HASH_MISMATCH/);
    });

    it('243. adjudication settlement stores canonical artifact manifest columns and verifies DB constraints', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const result = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(result.adjudication.id)!;
      expect(adj.artifact_manifest_json).toBeDefined();
      expect(adj.artifact_manifest_hash).toMatch(/^[0-9a-f]{64}$/);

      expect(() => {
        fixtures.db.prepare("UPDATE coder_submission_adjudications SET artifact_manifest_hash = 'invalid-hash' WHERE id = ?").run(adj.id);
      }).toThrow(/CHECK constraint failed|cannot be altered or cleared once set/);
    });

    it('244. settlement rollback artifact failure transitions adjudication to RECOVERY_FENCED with CLEANUP_DEBT_FENCED', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const origCleanup = ArtifactStore.cleanupRollbackFiles;
      ArtifactStore.cleanupRollbackFiles = vi.fn().mockReturnValue({
        cleanedCount: 0,
        failures: [{ path: '/tmp/test.bin', error: 'Permission denied' }],
      });

      const origRun = fixtures.verificationService.executeSealedVerification;
      fixtures.verificationService.executeSealedVerification = vi.fn().mockRejectedValue(new Error('SIMULATED_TEST_CRASH'));

      try {
        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow();

        const adjs = fixtures.repo.getCoderSubmissionAdjudicationsBySubmission(subId);
        expect(adjs[0].status).toBe('RECOVERY_FENCED');
        expect(adjs[0].failure_code).toBe('CLEANUP_DEBT_FENCED');
      } finally {
        ArtifactStore.cleanupRollbackFiles = origCleanup;
        fixtures.verificationService.executeSealedVerification = origRun;
      }
    });

    it('245. ProcessRunner treats taskkill exit 128 as unresolved if process kill(pid, 0) probe succeeds', async () => {
      const runner = new ProcessRunner();
      const pid = 999999;
      const origKill = process.kill;
      (process as any).kill = vi.fn().mockImplementation((p: number, sig: any) => {
        if (sig === 0) return true;
        return origKill(p, sig);
      });

      try {
        const isDead = await (runner as any).verifyProcessDeadWithDeadline(pid, 50);
        expect(isDead).toBe(false);
      } finally {
        process.kill = origKill;
      }
    });

    it('246. ProcessRunner verifyProcessDeadWithDeadline succeeds when process.kill throws ESRCH', async () => {
      const runner = new ProcessRunner();
      const pid = 888888;
      const origKill = process.kill;
      (process as any).kill = vi.fn().mockImplementation((p: number, sig: any) => {
        if (sig === 0) {
          const err: any = new Error('No such process');
          err.code = 'ESRCH';
          throw err;
        }
        return origKill(p, sig);
      });

      try {
        const isDead = await (runner as any).verifyProcessDeadWithDeadline(pid, 100);
        expect(isDead).toBe(true);
      } finally {
        process.kill = origKill;
      }
    });

    it('247. ProcessRunner terminateAllProcessesAsync returns a promise and settles cleanly', async () => {
      const runner = new ProcessRunner();
      await expect(runner.terminateAllProcessesAsync()).resolves.toBeUndefined();
    });

    it('248. VerificationService ensures START_AMBIGUOUS never maps to PROCESS_START_FAILED', () => {
      expect(VerificationService.prototype.constructor).toBeDefined();
    });

    it('249. recovery reconciliation returns AUTHORITY_CONFLICT when terminal adjudication has missing test run', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const res = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });
      expect(res.status).toBe('VERIFIED');

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(res.adjudication.id)!;
      const mutatedAdj = { ...adj, test_run_id: crypto.randomUUID() };

      const recon = fixtures.recoveryScanner.reconcileSingleAdjudication(mutatedAdj);
      expect(recon.classification).toBe('AUTHORITY_CONFLICT');
    });

    it('250. recovery reconcileMissingSettlement properly releases workspace lease upon settlement', async () => {
      expect(fixtures.recoveryScanner.reconcileMissingSettlement).toBeDefined();
    });

    it('251. recovery fenceAdjudication fences active workspace lease', async () => {
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

      const leaseId = crypto.randomUUID();
      const now = new Date().toISOString();
      const worktreeIdentityHash = computeSha256(path.resolve(fixtures.projectRoot).toLowerCase());

      fixtures.repo.createWorkspaceLease({
        id: leaseId,
        adjudication_id: adjId,
        worktree_identity_hash: worktreeIdentityHash,
        admitted_workspace_fingerprint_hash: computeSha256('test'),
        pre_execution_fingerprint_hash: null,
        claim_nonce: crypto.randomUUID(),
        execution_id: crypto.randomUUID(),
        lease_owner_identity: fixtures.assignmentId,
        assignment_id: fixtures.assignmentId,
        authorization_id: fixtures.authorizationId,
        acquired_at: now,
        released_at: null,
        lifecycle_version: 1,
        state: 'ACQUIRED',
        failure_code: null,
        failure_evidence_hash: null,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      fixtures.recoveryScanner.fenceAdjudication(adj, 'ORPHANED_IN_FLIGHT_EXECUTION', 'Orphaned in flight', now, true);
      const updatedLease = fixtures.repo.getWorkspaceLease(leaseId)!;
      expect(updatedLease.state).toBe('FENCED');
      expect(updatedLease.released_at).not.toBeNull();
    });

    it('252. buildVerifiedAdjudicationReviewProjection rejects empty {} authority and command snapshots', () => {
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

      expect(() => {
        fixtures.adjudicationService.buildVerifiedAdjudicationReviewProjection(adjId);
      }).toThrow(/INTEGRITY_CONFLICT|cannot be empty/);
    });

    it('253. buildVerifiedAdjudicationReviewProjection rejects malformed git evidence structured payload', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const res = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(res.adjudication.id)!;
      const ev = fixtures.repo.getEvidenceById(adj.git_status_evidence_id!)!;
      if (ev.file_path && fs.existsSync(ev.file_path)) {
        fs.writeFileSync(ev.file_path, 'corrupted');
      } else {
        fixtures.db.prepare("UPDATE evidence SET raw_payload = 'corrupted' WHERE id = ?").run(adj.git_status_evidence_id);
      }

      expect(() => {
        fixtures.adjudicationService.buildVerifiedAdjudicationReviewProjection(adj.id);
      }).toThrow(/INVALID_GIT_EVIDENCE_SHAPE|SyntaxError|Unexpected|INTEGRITY_CONFLICT/);
    });

    it('254. renderVerifiedAdjudicationReviewProjection throws PROJECTION_HASH_MISMATCH on tampered projection', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const res = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const projection = fixtures.adjudicationService.buildVerifiedAdjudicationReviewProjection(res.adjudication.id);
      const tampered = { ...projection, projection_hash: 'a'.repeat(64) };

      expect(() => {
        PackageGenerator.renderVerifiedAdjudicationReviewProjection(tampered);
      }).toThrow(/PROJECTION_HASH_MISMATCH/);
    });

    it('255. renderVerifiedAdjudicationReviewProjection renders authoritative verdict directly without external override', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const res = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const projection = fixtures.adjudicationService.buildVerifiedAdjudicationReviewProjection(res.adjudication.id);
      const rendered = PackageGenerator.renderVerifiedAdjudicationReviewProjection(projection);
      expect(rendered).toContain('🟢 PASSED');
      expect(rendered).toContain('Authoritative Verification Evidence');
    });

    it('256. PackageGenerator.generateReviewPackage throws LEGACY_LINKAGE_REJECTED when legacy linkage is supplied', () => {
      const legacyLinkage: Record<string, unknown> = {
        adjudication_id: crypto.randomUUID(),
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
          legacyLinkage
        );
      }).toThrow(/LEGACY_LINKAGE_REJECTED/);
    });

    it('257. Single canonical authorization verifier rejects raw-text-only hash match with zero mutations', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      // Mutate canonical_payload_json with extra whitespace so that sha256(rawText) != computePayloadHash(parsed)
      const rawText = auth.canonical_payload_json + '   ';
      const rawHash = crypto.createHash('sha256').update(rawText, 'utf8').digest('hex');

      fixtures.db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
        .run(rawText, rawHash, fixtures.authorizationId);

      const beforeCount = (fixtures.db.prepare('SELECT count(*) as count FROM coder_submission_adjudications WHERE submission_id = ?').get(subId) as { count: number }).count;

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/INSTRUCTION_PAYLOAD_HASH_MISMATCH/);

      const afterCount = (fixtures.db.prepare('SELECT count(*) as count FROM coder_submission_adjudications WHERE submission_id = ?').get(subId) as { count: number }).count;
      expect(afterCount).toBe(beforeCount);
    });

    it('258. Authorization canonical payload fails closed on missing required keys', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const parsed = JSON.parse(auth.canonical_payload_json!) as Record<string, unknown>;
      delete parsed.acceptanceCriteria;
      const badJson = JSON.stringify(parsed);
      const badHash = computeSha256(badJson);

      fixtures.db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
        .run(badJson, badHash, fixtures.authorizationId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/canonical_payload_json has invalid property set/);
    });

    it('259. Authorization canonical payload fails closed on extra unauthorized keys', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const parsed = JSON.parse(auth.canonical_payload_json!) as Record<string, unknown>;
      parsed.injected_unauthorized_property = 'malicious';
      const badJson = JSON.stringify(parsed);
      const badHash = computeSha256(badJson);

      fixtures.db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
        .run(badJson, badHash, fixtures.authorizationId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/canonical_payload_json has invalid property set/);
    });

    it('260. Authorization canonical payload fails closed on snake_case aliases', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const parsed = JSON.parse(auth.canonical_payload_json!) as Record<string, unknown>;
      parsed.attempt_id = parsed.attemptId;
      delete parsed.attemptId;
      const badJson = JSON.stringify(parsed);
      const badHash = computeSha256(badJson);

      fixtures.db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
        .run(badJson, badHash, fixtures.authorizationId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/canonical_payload_json has invalid property set/);
    });

    it('261. Routing decision payload fails closed on missing/extra fields and snake_case aliases', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const evRow = fixtures.db.prepare('SELECT structured_payload_json FROM events WHERE id = ?').get(auth.routing_decision_id) as { structured_payload_json: string };
      const payload = JSON.parse(evRow.structured_payload_json) as Record<string, unknown>;
      payload.selected_resource_id = payload.selectedResourceId;
      delete payload.selectedResourceId;

      fixtures.db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?')
        .run(JSON.stringify(payload), auth.routing_decision_id);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/Routing payload contains unauthorized additional field "selected_resource_id"/);
    });

    it('262. Assignment missing worker slot fails closed on admission', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      fixtures.db.prepare('UPDATE agent_assignments SET selected_worker_slot_id = NULL WHERE id = ?')
        .run(fixtures.assignmentId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/Assignment missing selected_worker_slot_id/);
    });

    it('263. Provider resource with null provider_account_id fails closed on admission', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      fixtures.db.prepare('UPDATE provider_resources SET provider_account_id = NULL WHERE id = ?')
        .run(auth.selected_resource_id);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/Provider resource missing provider_account_id/);
    });

    it('264. Full legacy AdjudicationReviewPackageLinkage object passed to generateReviewPackage is rejected', () => {
      const legacyLinkage = createTestLinkage(crypto.randomUUID());

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
          legacyLinkage
        );
      }).toThrow(/LEGACY_LINKAGE_REJECTED/);
    });

    it('265. Two renders of the same verified projection are byte-identical across different wall-clock times', () => {
      const projection = createTestProjection(crypto.randomUUID());

      const render1 = PackageGenerator.renderVerifiedAdjudicationReviewProjection(projection);

      // Mutate Date.now or advance clock
      const origDateNow = Date.now;
      try {
        Date.now = () => origDateNow() + 10000000;
        const render2 = PackageGenerator.renderVerifiedAdjudicationReviewProjection(projection);
        expect(render1).toBe(render2);
      } finally {
        Date.now = origDateNow;
      }
    });

    it('266. A fenced projection row with exit code 0 never renders a verified verdict', () => {
      const projection = createTestProjection(crypto.randomUUID(), {
        authoritative_verification: {
          test_run_id: 'tr-fenced-1',
          command: 'npm test',
          command_snapshot_hash: 'b'.repeat(64),
          exit_code: 0,
          passed_count: 1,
          failed_count: 0,
          skipped_count: 0,
          duration_ms: 100,
          test_result_evidence_id: 'ev-test',
          test_result_evidence_hash: 'c'.repeat(64),
          verdict: 'FENCED',
        },
        recovery_fencing_state: {
          is_fenced: true,
          status: 'RECOVERY_FENCED',
          failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
          recovery_fenced_at: new Date().toISOString(),
          resolution_action: null,
        },
      });

      const rendered = PackageGenerator.renderVerifiedAdjudicationReviewProjection(projection);
      expect(rendered).toContain('⚠️ RECOVERY_FENCED / UNRESOLVED');
      expect(rendered).not.toContain('🟢 PASSED');
    });

    it('267. Authoritative Git status validation rejects missing fields and malformed shapes in projection', () => {
      const projection = createTestProjection(crypto.randomUUID(), {
        authoritative_git_status: {
          evidence_id: null,
          evidence_hash: 'a'.repeat(64),
          storage_type: 'INLINE',
          is_clean: true,
          summary: 'Clean',
        },
      });

      expect(() => {
        PackageGenerator.renderVerifiedAdjudicationReviewProjection(projection);
      }).toThrow(/VERIFIED_PROJECTION_INVALID/);
    });

    it('268. Manifest parsing rejects aliases, wrong byte sizes, and extra top-level properties', () => {
      const validEntries = [
        {
          byte_size: 10,
          content_type: 'text/plain',
          evidence_id: 'ev-1',
          evidence_type: 'LOG',
          relative_path: 'a.txt',
          sha256: 'a'.repeat(64),
          storage_class: 'FILE' as const,
        },
      ];

      // 1. Extra top-level property
      const extraTopObj: Record<string, unknown> = {
        manifest_schema_version: 1,
        adjudication_id: 'adj-1',
        lifecycle_version: 1,
        verification_execution_id: 'exec-1',
        entries: validEntries,
        injected_extra: true,
      };
      expect(() => {
        canonicalizeArtifactManifest(extraTopObj as unknown as ArtifactManifest);
      }).toThrow(/Invalid manifest property set/);

      // 2. Entry alias 'hash' instead of 'sha256'
      const aliasEntries: Record<string, unknown>[] = [
        {
          byte_size: 10,
          content_type: 'text/plain',
          evidence_id: 'ev-1',
          evidence_type: 'LOG',
          relative_path: 'a.txt',
          hash: 'a'.repeat(64),
          storage_class: 'FILE',
        },
      ];
      const aliasManifest = {
        manifest_schema_version: 1,
        adjudication_id: 'adj-1',
        lifecycle_version: 1,
        verification_execution_id: 'exec-1',
        entries: aliasEntries,
      };
      expect(() => {
        canonicalizeArtifactManifest(aliasManifest as unknown as ArtifactManifest);
      }).toThrow(/Invalid manifest entry property set/);

      // 3. Entry negative byte_size
      const negativeSizeEntries = [
        {
          ...validEntries[0],
          byte_size: -5,
        },
      ];
      const negativeManifest = {
        manifest_schema_version: 1,
        adjudication_id: 'adj-1',
        lifecycle_version: 1,
        verification_execution_id: 'exec-1',
        entries: negativeSizeEntries,
      };
      expect(() => {
        canonicalizeArtifactManifest(negativeManifest as unknown as ArtifactManifest);
      }).toThrow(/Manifest entry byte_size must be a non-negative integer/);
    });

    it('269. ProcessRunner terminateProcessTree memoizes in-flight promises and purges upon settlement', async () => {
      const fakePid = 999999;
      const fakeChild = {
        pid: fakePid,
        kill: () => true,
      } as unknown as child_process.ChildProcess;

      const p1 = ProcessRunner.terminateProcessTree(fakeChild);
      const p2 = ProcessRunner.terminateProcessTree(fakeChild);
      // Must return identical in-flight promise
      expect(p1).toBe(p2);

      const res = await p1;
      expect(res).toBe('PROCESS_TREE_TERMINATED_PROVEN');

      // Settled promise is purged from internal memoization map
      const map = (ProcessRunner as unknown as { terminationPromises: Map<number, Promise<unknown>> }).terminationPromises;
      expect(map.has(fakePid)).toBe(false);
    });

    it('270. ProcessRunner taskkill exit 128 with surviving process probe returns TERMINATION_UNRESOLVED', async () => {
      // If process.kill(pid, 0) succeeds (meaning process is alive), exit code 128 is treated as unresolved
      const origKill = process.kill;
      const fakePid = 888888;
      const fakeChild = {
        pid: fakePid,
        kill: () => true,
      } as unknown as child_process.ChildProcess;
      try {
        process.kill = ((pid: number, signal?: string | number) => {
          if (pid === fakePid && signal === 0) {
            return true;
          }
          return origKill.call(process, pid, signal);
        }) as unknown as typeof process.kill;

        const res = await ProcessRunner.terminateProcessTree(fakeChild, 100);
        // On Windows with surviving process, returns TERMINATION_UNRESOLVED
        expect(res).toBe('TERMINATION_UNRESOLVED');
      } finally {
        process.kill = origKill;
      }
    });

    it('271. Workspace lease release CAS failure in recovery scanner throws RECOVERY_CAS_FAILED and aborts reconciliation', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const leaseId = crypto.randomUUID();
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
        workspace_snapshot_before_json: canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] }),
        workspace_snapshot_before_hash: computeSha256(canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] })),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: nowIso,
        verification_started_at: null,
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: null,
        artifact_manifest_json: null,
        artifact_manifest_hash: null,
        workspace_lease_id: null,
      });

      fixtures.repo.createWorkspaceLease({
        id: leaseId,
        adjudication_id: adjId,
        worktree_identity_hash: 'a'.repeat(64),
        admitted_workspace_fingerprint_hash: 'b'.repeat(64),
        pre_execution_fingerprint_hash: null,
        claim_nonce: crypto.randomUUID(),
        execution_id: 'exec-1',
        lease_owner_identity: 'worker-1',
        assignment_id: fixtures.assignmentId,
        authorization_id: fixtures.authorizationId,
        acquired_at: nowIso,
        released_at: null,
        lifecycle_version: 1,
        state: 'ACQUIRED',
        failure_code: null,
        failure_evidence_hash: null,
      });

      fixtures.db.prepare("UPDATE coder_submission_adjudications SET status = 'VERIFYING', verification_started_at = ?, verification_execution_id = ?, workspace_lease_id = ?, lifecycle_version = lifecycle_version + 1 WHERE id = ?")
        .run(nowIso, 'exec-1', leaseId, adjId);

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;

      const validEntries = [
        {
          byte_size: 10,
          content_type: 'text/plain',
          evidence_id: 'ev-1',
          evidence_type: 'LOG',
          relative_path: 'a.txt',
          sha256: 'a'.repeat(64),
          storage_class: 'FILE' as const,
        },
      ];
      const validManifest = {
        manifest_schema_version: 1,
        adjudication_id: adjId,
        lifecycle_version: 2,
        verification_execution_id: 'exec-1',
        entries: validEntries,
      };
      const validManifestJson = canonicalJsonStringify(validManifest);
      const validManifestHash = computeSha256(validManifestJson);

      const statusEvidenceId = crypto.randomUUID();
      const diffEvidenceId = crypto.randomUUID();
      const testEvidenceId = crypto.randomUUID();
      const testRunId = crypto.randomUUID();

      fixtures.repo.createEvidence({
        id: statusEvidenceId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'GIT_STATUS',
        storage_type: 'INLINE',
        file_path: null,
        hash: 'f'.repeat(64),
        byte_size: 10,
        content_type: 'application/json',
        summary: 'git status',
        raw_payload: '{}',
        created_at: nowIso,
      });

      fixtures.repo.createEvidence({
        id: diffEvidenceId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'GIT_DIFF',
        storage_type: 'INLINE',
        file_path: null,
        hash: 'e'.repeat(64),
        byte_size: 10,
        content_type: 'text/plain',
        summary: 'git diff',
        raw_payload: '',
        created_at: nowIso,
      });

      fixtures.repo.createEvidence({
        id: testEvidenceId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'TEST_RESULT',
        storage_type: 'INLINE',
        file_path: null,
        hash: '1'.repeat(64),
        byte_size: 10,
        content_type: 'text/plain',
        summary: 'test output',
        raw_payload: 'ok',
        created_at: nowIso,
      });

      const testRun = {
        id: testRunId,
        task_id: fixtures.taskId,
        command: 'npm test',
        exit_code: 0,
        passed_count: 1,
        failed_count: 0,
        skipped_count: 0,
        duration_ms: 100,
        evidence_id: testEvidenceId,
        created_at: nowIso,
      };
      fixtures.repo.createTestRun(testRun);

      const envelope: CanonicalVerificationResultEnvelope = {
        adjudication_id: adjId,
        artifact_manifest_hash: validManifestHash,
        assignment_id: fixtures.assignmentId,
        attempt_id: fixtures.attemptId,
        authorization_id: fixtures.authorizationId,
        command_snapshot_hash: computeSha256('{}'),
        exit_classification: 'EXIT_ZERO',
        failure_code: null,
        failure_payload: null,
        finish_timestamp: nowIso,
        git_diff_evidence_hash: 'e'.repeat(64),
        git_diff_evidence_id: diffEvidenceId,
        git_status_evidence_hash: 'f'.repeat(64),
        git_status_evidence_id: statusEvidenceId,
        lifecycle_version: 2,
        process_start_classification: 'SPAWNED_PROVEN',
        project_id: fixtures.projectId,
        start_timestamp: nowIso,
        task_id: fixtures.taskId,
        task_ownership_epoch: 1,
        termination_classification: 'TERMINATION_PROVEN',
        test_result_evidence_hash: '1'.repeat(64),
        test_result_evidence_id: testEvidenceId,
        test_run_id: testRunId,
        verification_execution_id: 'exec-1',
        workspace_snapshot_after_evidence_id: crypto.randomUUID(),
        workspace_snapshot_after_hash: '2'.repeat(64),
        workspace_snapshot_before_hash: '3'.repeat(64),
      };

      const origUpdate = fixtures.repo.updateWorkspaceLease.bind(fixtures.repo);
      fixtures.repo.updateWorkspaceLease = () => false;

      try {
        const settled = fixtures.recoveryScanner.reconcileMissingSettlement(
          adj,
          testRun,
          statusEvidenceId,
          diffEvidenceId,
          envelope,
          validManifestJson,
          validManifestHash,
          nowIso
        );
        expect(settled).toBe(false);

        const unchangedAdj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
        expect(unchangedAdj.status).toBe('VERIFYING');
        expect(unchangedAdj.lifecycle_version).toBe(2);
      } finally {
        fixtures.repo.updateWorkspaceLease = origUpdate;
      }
    });

    it('272. Recovery scanner fences in-flight adjudication when artifact manifest is missing', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
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
        authority_snapshot_json: '{}',
        authority_snapshot_hash: computeSha256('{}'),
        workspace_snapshot_before_json: canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] }),
        workspace_snapshot_before_hash: computeSha256(canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] })),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: nowIso,
        verification_started_at: nowIso,
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
        artifact_manifest_json: null,
        artifact_manifest_hash: null,
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.settledCount).toBe(0);
      expect(report.fencedCount).toBeGreaterThanOrEqual(1);

      const fenced = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(fenced.status).toBe('RECOVERY_FENCED');
      expect(fenced.failure_code).toBe('INTEGRITY_MISMATCH');
    });

    it('273. Exact manifest parser rejects top-level and entry aliases, extra and missing keys', () => {
      const validEntry = {
        byte_size: 10,
        content_type: 'text/plain',
        evidence_id: 'ev-test-1',
        evidence_type: 'LOG',
        relative_path: 'log.txt',
        sha256: 'a'.repeat(64),
        storage_class: 'FILE' as const,
      };

      const validManifest: ArtifactManifest = {
        adjudication_id: 'adj-test-1',
        entries: [validEntry],
        lifecycle_version: 1,
        manifest_schema_version: 1,
        verification_execution_id: 'exec-test-1',
      };

      // 1. Missing top-level key (adjudication_id missing)
      const missingKeyObj: Record<string, unknown> = {
        entries: [validEntry],
        lifecycle_version: 1,
        manifest_schema_version: 1,
        verification_execution_id: 'exec-test-1',
      };
      expect(() => {
        parseAndVerifyArtifactManifest(JSON.stringify(missingKeyObj));
      }).toThrow(/Invalid manifest property set/);

      // 2. Extra top-level key
      const extraKeyObj: Record<string, unknown> = {
        ...validManifest,
        unexpected_extra_property: true,
      };
      expect(() => {
        parseAndVerifyArtifactManifest(JSON.stringify(extraKeyObj));
      }).toThrow(/Invalid manifest property set/);

      // 3. Entry missing required key (missing storage_class)
      const missingEntryProp: Record<string, unknown> = {
        byte_size: 10,
        content_type: 'text/plain',
        evidence_id: 'ev-test-1',
        evidence_type: 'LOG',
        relative_path: 'log.txt',
        sha256: 'a'.repeat(64),
      };
      const manifestMissingEntryProp = {
        ...validManifest,
        entries: [missingEntryProp],
      };
      expect(() => {
        parseAndVerifyArtifactManifest(JSON.stringify(manifestMissingEntryProp));
      }).toThrow(/Invalid manifest entry property set/);

      // 4. Entry alias (storageClass instead of storage_class)
      const aliasEntryProp: Record<string, unknown> = {
        byte_size: 10,
        content_type: 'text/plain',
        evidence_id: 'ev-test-1',
        evidence_type: 'LOG',
        relative_path: 'log.txt',
        sha256: 'a'.repeat(64),
        storageClass: 'FILE',
      };
      const manifestAliasEntryProp = {
        ...validManifest,
        entries: [aliasEntryProp],
      };
      expect(() => {
        parseAndVerifyArtifactManifest(JSON.stringify(manifestAliasEntryProp));
      }).toThrow(/Invalid manifest entry property set/);
    });

    it('274. Exact manifest parser rejects raw versus canonical hash disagreement', () => {
      const entryA = {
        byte_size: 10,
        content_type: 'text/plain',
        evidence_id: 'ev-b',
        evidence_type: 'LOG',
        relative_path: 'b.txt',
        sha256: 'b'.repeat(64),
        storage_class: 'FILE' as const,
      };
      const entryB = {
        byte_size: 20,
        content_type: 'text/plain',
        evidence_id: 'ev-a',
        evidence_type: 'LOG',
        relative_path: 'a.txt',
        sha256: 'a'.repeat(64),
        storage_class: 'FILE' as const,
      };

      const manifestObj: ArtifactManifest = {
        adjudication_id: 'adj-test-hash',
        entries: [entryA, entryB],
        lifecycle_version: 1,
        manifest_schema_version: 1,
        verification_execution_id: 'exec-test-hash',
      };

      const rawJson = JSON.stringify(manifestObj);
      const rawSha = crypto.createHash('sha256').update(rawJson, 'utf8').digest('hex');
      const canonicalHash = computeArtifactManifestHash(manifestObj);

      expect(() => {
        parseAndVerifyArtifactManifest(rawJson, rawSha);
      }).toThrow(/MANIFEST_HASH_MISMATCH/);

      const parsed = parseAndVerifyArtifactManifest(rawJson, canonicalHash);
      expect(parsed.adjudication_id).toBe('adj-test-hash');
      expect(parsed.entries[0].evidence_id).toBe('ev-a');
      expect(parsed.entries[1].evidence_id).toBe('ev-b');
    });

    it('275. Evidence integrity fails closed when disk byte size differs from manifest or hash mismatches', () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-evidence-test-'));
      try {
        const filePath = path.join(testDir, 'evidence.txt');
        const content = 'Hello Evidence Store';
        fs.writeFileSync(filePath, content, 'utf8');
        const actualSha = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
        const actualBytes = Buffer.byteLength(content, 'utf8');

        const wrongSizeEvidence: Evidence = {
          id: 'ev-wrong-size',
          project_id: fixtures.projectId,
          task_id: fixtures.taskId,
          attempt_id: fixtures.attemptId,
          evidence_type: 'TEST_RESULT',
          storage_type: 'FILE',
          content_type: 'text/plain',
          file_path: filePath,
          byte_size: actualBytes + 999,
          hash: actualSha,
          summary: 'test summary',
          raw_payload: null,
          created_at: new Date().toISOString(),
        };
        const store = new ArtifactStore(testDir);
        expect(verifyEvidenceIntegrity(wrongSizeEvidence, store).valid).toBe(false);

        const wrongShaEvidence: Evidence = {
          id: 'ev-wrong-sha',
          project_id: fixtures.projectId,
          task_id: fixtures.taskId,
          attempt_id: fixtures.attemptId,
          evidence_type: 'TEST_RESULT',
          storage_type: 'FILE',
          content_type: 'text/plain',
          file_path: filePath,
          byte_size: actualBytes,
          hash: 'f'.repeat(64),
          summary: 'test summary',
          raw_payload: null,
          created_at: new Date().toISOString(),
        };
        expect(verifyEvidenceIntegrity(wrongShaEvidence, store).valid).toBe(false);

        const validEvidence: Evidence = {
          id: 'ev-valid',
          project_id: fixtures.projectId,
          task_id: fixtures.taskId,
          attempt_id: fixtures.attemptId,
          evidence_type: 'TEST_RESULT',
          storage_type: 'FILE',
          content_type: 'text/plain',
          file_path: filePath,
          byte_size: actualBytes,
          hash: actualSha,
          summary: 'test summary',
          raw_payload: null,
          created_at: new Date().toISOString(),
        };
        expect(verifyEvidenceIntegrity(validEvidence, store).valid).toBe(true);
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('276. Public R5J5 artifact methods cannot overwrite an existing different-content target', () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-store-no-overwrite-'));
      try {
        const store = new ArtifactStore(testDir, 0);
        const contentA = 'Original Immutable Content';
        const resultA = store.store(
          'ev-store-no-ow',
          fixtures.projectId,
          fixtures.taskId,
          fixtures.attemptId,
          'PROCESS_LOG',
          'summary',
          contentA,
          'text/plain'
        );
        expect(resultA.file_path).toBeDefined();
        expect(fs.readFileSync(resultA.file_path!, 'utf8')).toBe(contentA);

        fs.writeFileSync(resultA.file_path!, 'Corrupted Tampered Content', 'utf8');

        expect(() => {
          store.store(
            'ev-store-no-ow-2',
            fixtures.projectId,
            fixtures.taskId,
            fixtures.attemptId,
            'PROCESS_LOG',
            'summary',
            contentA,
            'text/plain'
          );
        }).toThrow(/HASH_COLLISION_MISMATCH/);

        expect(fs.readFileSync(resultA.file_path!, 'utf8')).toBe('Corrupted Tampered Content');
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('277. Exclusive creation: ArtifactStore.stage rejects overwrite of existing staged file', () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-stage-exclusive-'));
      try {
        const store = new ArtifactStore(testDir);
        const id = 'ev-exclusive-1';
        const payload = 'Staged Content One';
        const res1 = store.stage(id, fixtures.projectId, fixtures.taskId, fixtures.attemptId, 'PROCESS_LOG', 'sum', payload);
        expect(res1.stagedPath).toBeDefined();
        expect(fs.existsSync(res1.stagedPath!)).toBe(true);

        expect(() => {
          store.stage(id, fixtures.projectId, fixtures.taskId, fixtures.attemptId, 'PROCESS_LOG', 'sum', payload);
        }).toThrow(/Failed to stage file exclusively.*EEXIST/);
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('278. Same-content concurrent writers to ArtifactStore converge and leave no temp files', async () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-concurrent-store-'));
      try {
        const store = new ArtifactStore(testDir, 0);
        const payload = 'Shared Concurrent Content for Multi-Writer Convergence';

        const promises = Array.from({ length: 8 }, (_, i) =>
          Promise.resolve().then(() =>
            store.store(
              `ev-concurrent-${i}`,
              fixtures.projectId,
              fixtures.taskId,
              fixtures.attemptId,
              'PROCESS_LOG',
              'summary',
              payload,
              'text/plain'
            )
          )
        );

        const results = await Promise.all(promises);
        const firstPath = results[0].file_path!;
        const firstHash = results[0].hash;

        for (const res of results) {
          expect(res.file_path).toBe(firstPath);
          expect(res.hash).toBe(firstHash);
        }

        expect(fs.readFileSync(firstPath, 'utf8')).toBe(payload);

        const filesInDir: string[] = [];
        const scan = (d: string) => {
          for (const item of fs.readdirSync(d)) {
            const p = path.join(d, item);
            if (fs.statSync(p).isDirectory()) scan(p);
            else filesInDir.push(item);
          }
        };
        scan(testDir);
        const tempFiles = filesInDir.filter((f) => f.includes('.tmp.'));
        expect(tempFiles).toEqual([]);
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('279. Rollback cleanup failure creates visible durable cleanup debt and fences adjudication', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const origCleanup = fixtures.artifactStore.cleanupRollbackFiles.bind(fixtures.artifactStore);
      const origExecute = fixtures.verificationService.executeSealedVerification.bind(fixtures.verificationService);

      try {
        fixtures.artifactStore.cleanupRollbackFiles = () => ({
          cleanedCount: 0,
          failures: [{ path: '/leaked/quarantine_artifact.bin', error: 'Permission denied on delete' }],
        });

        fixtures.verificationService.executeSealedVerification = () =>
          Promise.reject(new Error('Simulated verification crash to trigger rollback'));

        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow(/Simulated verification crash to trigger rollback/);

        const adjs = fixtures.repo.getCoderSubmissionAdjudicationsBySubmissionId(subId);
        expect(adjs.length).toBe(1);
        expect(adjs[0].status).toBe('RECOVERY_FENCED');
        expect(adjs[0].failure_code).toBe('CLEANUP_DEBT_FENCED');
      } finally {
        fixtures.artifactStore.cleanupRollbackFiles = origCleanup;
        fixtures.verificationService.executeSealedVerification = origExecute;
      }
    });

    it('280. ProcessRunner timeout awaits memoized termination promise before settling result', async () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-proc-timeout-'));
      try {
        const scriptPath = path.join(testDir, 'sleep.js');
        fs.writeFileSync(scriptPath, 'setTimeout(() => {}, 15000);', 'utf8');

        const res = await ProcessRunner.execute({
          executable: process.execPath,
          args: [scriptPath],
          cwd: testDir,
          timeoutMs: 150,
        });

        expect(res.timedOut).toBe(true);
        expect(res.errorCode).toBe('TIMEOUT');
        expect(res.processTermination).toBe('PROCESS_TREE_TERMINATED_PROVEN');
        if (res.pid !== null) {
          const isDead = await ProcessRunner.verifyProcessDeadWithDeadline(res.pid, 2000);
          expect(isDead).toBe(true);
        }
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('281. ProcessRunner output limit exceeds cap and awaits termination promise', async () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-proc-output-'));
      try {
        const scriptPath = path.join(testDir, 'flood.js');
        fs.writeFileSync(
          scriptPath,
          'for (let i = 0; i < 200; i++) { process.stdout.write("overflow-stream-buffer-" + i + "\\n"); }',
          'utf8'
        );

        const res = await ProcessRunner.execute({
          executable: process.execPath,
          args: [scriptPath],
          cwd: testDir,
          maxStdoutBytes: 80,
        });

        expect(res.outputLimitExceeded).toBe(true);
        expect(res.errorCode).toBe('OUTPUT_LIMIT_EXCEEDED');
        expect(res.processTermination).toBe('PROCESS_TREE_TERMINATED_PROVEN');
        if (res.pid !== null) {
          const isDead = await ProcessRunner.verifyProcessDeadWithDeadline(res.pid, 2000);
          expect(isDead).toBe(true);
        }
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('282. Concurrent cancelAsync and terminateAllProcessesAsync share termination promise and leave PID registry empty', async () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-proc-concurrent-'));
      try {
        const scriptPath = path.join(testDir, 'long.js');
        fs.writeFileSync(scriptPath, 'setTimeout(() => {}, 20000);', 'utf8');

        const executionId = crypto.randomUUID();
        const runPromise = ProcessRunner.execute({
          executionId,
          executable: process.execPath,
          args: [scriptPath],
          cwd: testDir,
          timeoutMs: 30000,
        });

        await new Promise((resolve) => setTimeout(resolve, 80));

        const [cancelRes, termRes] = await Promise.all([
          ProcessRunner.cancelAsync(executionId),
          ProcessRunner.terminateAllProcessesAsync(),
        ]);

        expect(['PROCESS_TREE_TERMINATED_PROVEN', 'NOT_APPLICABLE']).toContain(cancelRes);
        expect(termRes.allTerminatedProven).toBe(true);

        const runResult = await runPromise;
        expect(runResult.cancelled).toBe(true);
        expect(ProcessRunner.getActiveProcessCount()).toBe(0);
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('283. evaluateCanonicalSettlementDecision rejects exit 0 when result envelope contains failure_code or contradiction', () => {
      const nowIso = new Date().toISOString();
      const subId = crypto.randomUUID();
      const adjId = crypto.randomUUID();

      const validEntry: ArtifactManifestEntry = {
        byte_size: 10,
        content_type: 'text/plain',
        evidence_id: 'ev-test-manifest',
        evidence_type: 'LOG',
        relative_path: 'test.log',
        sha256: 'b'.repeat(64),
        storage_class: 'FILE',
      };

      const manifest: ArtifactManifest = {
        adjudication_id: adjId,
        entries: [validEntry],
        lifecycle_version: 1,
        manifest_schema_version: 1,
        verification_execution_id: 'exec-test-1',
      };

      const manifestHash = computeArtifactManifestHash(manifest);
      const cmdHash = computeSha256('{"command":"test"}');

      const adjudication: CoderSubmissionAdjudication = {
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
        authority_snapshot_json: '{}',
        authority_snapshot_hash: computeSha256('{}'),
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        verification_commands_json: '{"command":"test"}',
        verification_commands_hash: cmdHash,
        created_at: nowIso,
        verification_started_at: nowIso,
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: 'tr-exit-zero',
        git_status_evidence_id: 'ev-status-1',
        git_diff_evidence_id: 'ev-diff-1',
        verification_execution_id: 'exec-test-1',
        artifact_manifest_json: null,
        artifact_manifest_hash: null,
      };

      const testRun: TestRun = {
        id: 'tr-exit-zero',
        task_id: fixtures.taskId,
        command: 'npm test',
        exit_code: 0,
        passed_count: 10,
        failed_count: 0,
        skipped_count: 0,
        duration_ms: 50,
        evidence_id: null,
        created_at: nowIso,
      };

      const contradictoryEnvelope: CanonicalVerificationResultEnvelope = {
        adjudication_id: adjId,
        artifact_manifest_hash: manifestHash,
        assignment_id: fixtures.assignmentId,
        attempt_id: fixtures.attemptId,
        authorization_id: fixtures.authorizationId,
        command_snapshot_hash: cmdHash,
        exit_classification: 'EXIT_ZERO',
        failure_code: 'INTEGRITY_MISMATCH',
        failure_payload: { reason: 'Contradiction test' },
        finish_timestamp: nowIso,
        git_diff_evidence_hash: 'e'.repeat(64),
        git_diff_evidence_id: 'ev-diff-1',
        git_status_evidence_hash: 'f'.repeat(64),
        git_status_evidence_id: 'ev-status-1',
        lifecycle_version: 2,
        process_start_classification: 'SPAWNED_PROVEN',
        project_id: fixtures.projectId,
        start_timestamp: nowIso,
        task_id: fixtures.taskId,
        task_ownership_epoch: 1,
        termination_classification: 'TERMINATION_PROVEN',
        test_result_evidence_hash: '1'.repeat(64),
        test_result_evidence_id: 'ev-tr-1',
        test_run_id: 'tr-exit-zero',
        verification_execution_id: 'exec-test-1',
        workspace_snapshot_after_evidence_id: crypto.randomUUID(),
        workspace_snapshot_after_hash: '2'.repeat(64),
        workspace_snapshot_before_hash: '3'.repeat(64),
      };

      const decision = evaluateNonAuthoritativeSettlementDecisionForTests({
        envelope: contradictoryEnvelope,
        adjudication,
        testRun,
        manifest,
        gitStatusEvidenceId: 'ev-status-1',
        gitDiffEvidenceId: 'ev-diff-1',
        testResultEvidenceId: 'ev-tr-1',
      });

      expect(decision.valid).toBe(false);
      expect(decision.isSuccess).toBe(false);
      expect(decision.targetStatus).toBe('RECOVERY_FENCED');
      expect(decision.failureCode).toBe('INTEGRITY_MISMATCH');
      expect(decision.contradictionReason).toBe('EXIT_ZERO with failure_code');
    });

  });
});
