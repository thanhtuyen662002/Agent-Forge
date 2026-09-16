import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import zlib from 'zlib';
import {
  MigrationRunner,
  MIGRATIONS,
  verifyMigration24SchemaAuthority,
  MIGRATION_24_EXPECTED_SQL_SHA256,
  MIGRATION_24_GZIP_CHUNKS,
  decompressMigration24Sql,
  decompressAndVerifyMigration24Sql,
} from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import {
  ReviewerAuthorityService,
  scrubReviewerDiagnostics,
  ReviewerAuthorityError,
  fatalUtf8Decode,
} from '../src/mcp/reviewerAuthority';
import {
  McpReviewerSession,
  REVIEWER_TOKEN_PREFIX,
  REVIEWER_TOKEN_SCOPE,
  DIFF_CONTENT_MAX_UTF8_BYTES,
  PROJECTION_PAYLOAD_MAX_UTF8_BYTES,
  MARKDOWN_MAX_UTF8_BYTES,
  SESSION_DURATION_MIN_SECONDS,
  SESSION_DURATION_MAX_SECONDS,
  SESSION_DURATION_DEFAULT_SECONDS,
} from '../src/types/reviewer';
import { computeSha256 } from '../src/mcp/submissionProtocol';

interface Fixtures {
  tempDir: string;
  dbPath: string;
  db: Database.Database;
  repo: Repository;
  artifactStore: ArtifactStore;
  service: ReviewerAuthorityService;
  adjudicationId: string;
  submissionId: string;
  taskId: string;
  projectId: string;
  attemptId: string;
  assignmentId: string;
  authId: string;
  coderProviderId: string;
  coderAgentId: string;
  coderAccountId: string;
  reviewerProviderId: string;
  reviewerAccountId: string;
  reviewerResourceId: string;
  reviewerAgentId: string;
  reviewerAgentId2: string;
}

function seedFullAuthorityEnv(tempDir: string): Fixtures {
  const dbPath = path.join(tempDir, 'test-reviewer-authority.db');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  MigrationRunner.run(db);

  const repo = new Repository(db);
  const artifactsDir = path.join(tempDir, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  const artifactStore = new ArtifactStore(artifactsDir);

  const now = new Date().toISOString();
  const projectId = `proj-${crypto.randomUUID()}`;
  const taskId = `task-${crypto.randomUUID()}`;
  const attemptId = `att-${crypto.randomUUID()}`;
  const assignmentId = `asgn-${crypto.randomUUID()}`;
  const authId = `auth-${crypto.randomUUID()}`;
  const subSessionId = crypto.randomUUID();
  const submissionId = crypto.randomUUID();
  const adjudicationId = crypto.randomUUID();

  const coderProviderId = `prov-coder-${crypto.randomUUID()}`;
  const coderAccountId = `acc-coder-${crypto.randomUUID()}`;
  const coderResourceId = `res-coder-${crypto.randomUUID()}`;
  const coderAgentId = `agent-coder-${crypto.randomUUID()}`;

  const reviewerProviderId = `prov-rev-${crypto.randomUUID()}`;
  const reviewerAccountId = `acc-rev-${crypto.randomUUID()}`;
  const reviewerResourceId = `res-rev-${crypto.randomUUID()}`;
  const reviewerAgentId = `agent-rev-1-${crypto.randomUUID()}`;
  const reviewerAgentId2 = `agent-rev-2-${crypto.randomUUID()}`;

  // 1. Providers
  db.prepare(`INSERT INTO providers (id, name, adapter_type, enabled, created_at) VALUES (?, ?, 'LOCAL_CLI', 1, ?)`).run(coderProviderId, 'CoderProvider', now);
  db.prepare(`INSERT INTO providers (id, name, adapter_type, enabled, created_at) VALUES (?, ?, 'LOCAL_CLI', 1, ?)`).run(reviewerProviderId, 'ReviewerProvider', now);

  // 2. Accounts
  db.prepare(`INSERT INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at) VALUES (?, ?, 'CoderAccount', 'NATIVE_PROFILE', 1, 10, 'AVAILABLE', 5, ?, ?)`).run(coderAccountId, coderProviderId, now, now);
  db.prepare(`INSERT INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at) VALUES (?, ?, 'ReviewerAccount', 'NATIVE_PROFILE', 1, 10, 'AVAILABLE', 5, ?, ?)`).run(reviewerAccountId, reviewerProviderId, now, now);

  // 3. Resources
  db.prepare(`INSERT INTO provider_resources (id, provider_id, provider_account_id, model_name, health_status, capabilities_json, enabled, total_quota, remaining_quota, quota_unit, quota_source, quota_confidence, last_health_check) VALUES (?, ?, ?, 'ResourceCoder', 'AVAILABLE', '[]', 1, 100, 100, 'REQUESTS', 'PROVIDER_REPORTED', 1.0, ?)`).run(coderResourceId, coderProviderId, coderAccountId, now);
  db.prepare(`INSERT INTO provider_resources (id, provider_id, provider_account_id, model_name, health_status, capabilities_json, enabled, total_quota, remaining_quota, quota_unit, quota_source, quota_confidence, last_health_check) VALUES (?, ?, ?, 'ResourceReviewer', 'AVAILABLE', '[]', 1, 100, 100, 'REQUESTS', 'PROVIDER_REPORTED', 1.0, ?)`).run(reviewerResourceId, reviewerProviderId, reviewerAccountId, now);

  // 4. Role & Agent Profiles & Agents
  const coderRoleId = `role-coder-${crypto.randomUUID()}`;
  const coderAgentProfileId = `prof-coder-${crypto.randomUUID()}`;
  db.prepare(`INSERT INTO role_profiles (id, role, display_name, required_capabilities_json, preferred_capabilities_json, permissions_json, enabled, created_at, updated_at) VALUES (?, 'CODER', 'Coder Role', '[]', '[]', '[]', 1, ?, ?)`).run(coderRoleId, now, now);
  db.prepare(`INSERT INTO agent_profiles (id, role_profile_id, name, enabled, created_at, updated_at) VALUES (?, ?, 'Agent Coder', 1, ?, ?)`).run(coderAgentProfileId, coderRoleId, now, now);

  db.prepare(`INSERT INTO agents (id, display_name, role, provider_resource_id, status, current_task_id, last_seen_at) VALUES (?, 'CoderAgent', 'CODER', ?, 'IDLE', NULL, ?)`).run(coderAgentId, coderResourceId, now);
  db.prepare(`INSERT INTO agents (id, display_name, role, provider_resource_id, status, current_task_id, last_seen_at) VALUES (?, 'ReviewerAgent1', 'REVIEWER', ?, 'IDLE', NULL, ?)`).run(reviewerAgentId, reviewerResourceId, now);
  db.prepare(`INSERT INTO agents (id, display_name, role, provider_resource_id, status, current_task_id, last_seen_at) VALUES (?, 'ReviewerAgent2', 'REVIEWER', ?, 'IDLE', NULL, ?)`).run(reviewerAgentId2, reviewerResourceId, now);

  // 5. Project & Task
  repo.createProject({
    id: projectId,
    name: 'Authority Test Project',
    description: 'Authority test description',
    repository_path: tempDir,
    default_branch: 'main',
    status: 'RUNNING',
    contract: null,
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
  });

  db.prepare(`
    INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, base_sha, ownership_epoch, created_at, updated_at)
    VALUES (?, ?, 'Authority Task', 'REVIEW_READY', 'LOW', 'LOW', 1, 3, 0, ?, 1, ?, ?)
  `).run(taskId, projectId, '0'.repeat(40), now, now);

  // 6. Attempt
  repo.createTaskAttempt({
    id: attemptId,
    task_id: taskId,
    attempt_number: 1,
    agent_id: coderAgentId,
    agent_profile_id: coderAgentProfileId,
    status: 'COMPLETED',
    started_at: now,
    ended_at: now,
    summary: 'Finished coding',
  });

  // 7. Routing & Protocol message
  const routingId = `route-${crypto.randomUUID()}`;
  const msgId = `msg-${crypto.randomUUID()}`;
  db.prepare(`INSERT INTO protocol_messages (id, message_id, protocol, project_id, payload_hash, raw_payload, status, created_at, processed_at) VALUES (?, ?, 'manager.v1', ?, ?, '{}', 'APPLIED', ?, ?)`).run(msgId, msgId, projectId, '0'.repeat(64), now, now);

  // 8. Agent assignment
  db.prepare(`
    INSERT INTO agent_assignments (id, project_id, task_id, attempt_id, role_profile_id, selected_provider_id, selected_account_id, selected_resource_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ASSIGNED', ?)
  `).run(assignmentId, projectId, taskId, attemptId, coderRoleId, coderProviderId, coderAccountId, coderResourceId, now);

  // 9. Execution auth
  db.prepare(`
    INSERT INTO execution_authorizations (
      id, project_id, task_id, task_ownership_epoch, attempt_id,
      selected_provider_id, selected_account_id, selected_resource_id,
      manager_message_id, manager_payload_hash, instruction_payload_hash, context_manifest_hash,
      canonical_instructions_json, context_files_json, routing_decision_id,
      base_sha, repository_head_sha, status, task_revision, canonical_payload_json,
      created_at, dispatched_at
    ) VALUES (
      ?, ?, ?, 1, ?,
      ?, ?, ?,
      ?, '${'0'.repeat(64)}', '${'0'.repeat(64)}', '${'0'.repeat(64)}',
      '[]', '[]', ?,
      ?, ?, 'DISPATCHED', 1, '{}',
      ?, ?
    )
  `).run(authId, projectId, taskId, attemptId, coderProviderId, coderAccountId, coderResourceId, msgId, routingId, '0'.repeat(40), '0'.repeat(40), now, now);

  // 10. Submission Session
  db.prepare(`
    INSERT INTO mcp_submission_sessions (id, authorization_id, scope, issuer_identity, token_hash, authorization_fingerprint, issued_at, expires_at)
    VALUES (?, ?, 'CODER_SUBMISSION', 'OWNER_LOCAL_CLI', ?, ?, ?, ?)
  `).run(subSessionId, authId, '0'.repeat(64), '0'.repeat(64), now, new Date(Date.now() + 3600000).toISOString());

  // 11. Coder Submission
  db.prepare(`
    INSERT INTO coder_submissions (
      id, authorization_id, project_id, task_id, task_ownership_epoch, session_id,
      selected_provider_id, selected_account_id, selected_resource_id,
      manager_message_id, routing_decision_id, base_sha, authorized_head_sha,
      schema_version, authorization_status, dispatched_at, authority_fingerprint,
      manager_payload_hash, task_revision, claimed_status, quarantine_status,
      summary, changed_files_count, tests_claimed_count, blockers_count,
      review_requested, claim_content_hash, canonical_envelope_hash,
      claim_content_json, canonical_envelope_json, canonical_arguments_bytes,
      lifecycle_version, execution_id, attempt_id, assignment_id, submitted_at
    ) VALUES (
      ?, ?, ?, ?, 1, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      1, 'DISPATCHED', ?, '${'0'.repeat(64)}',
      '${'0'.repeat(64)}', 1, 'COMPLETED', 'QUARANTINED',
      'Review ready submission', 1, 1, 0,
      1, '${'0'.repeat(64)}', '${'0'.repeat(64)}',
      '{}', '{}', 2,
      1, 'exec-1', ?, ?, ?
    )
  `).run(
    submissionId, authId, projectId, taskId, subSessionId,
    coderProviderId, coderAccountId, coderResourceId,
    msgId, routingId, '0'.repeat(40), '0'.repeat(40),
    now, attemptId, assignmentId, now
  );

  // 12. Dispositions
  db.prepare(`
    INSERT INTO coder_submission_dispositions (id, submission_id, disposition_event, disposition_reason, actor_type, actor_id, created_at)
    VALUES (?, ?, 'SETTLED', 'ACCEPTED_VERIFIED', 'OPERATOR', 'test-operator', ?)
  `).run(crypto.randomUUID(), submissionId, now);

  // 13. Test Run
  const testRunId = `tr-${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO test_runs (id, task_id, command, passed_count, failed_count, skipped_count, duration_ms, exit_code, created_at)
    VALUES (?, ?, 'npm test', 5, 0, 0, 100, 0, ?)
  `).run(testRunId, taskId, now);

  // 14. Evidence
  const statusEvId = `ev-status-${crypto.randomUUID()}`;
  const diffEvId = `ev-diff-${crypto.randomUUID()}`;
  const statusFile = path.join(artifactsDir, 'git-status.txt');
  const diffFile = path.join(artifactsDir, 'git-diff.patch');
  const statusPayload = JSON.stringify({ isClean: false, files: ['src/index.ts'] });
  fs.writeFileSync(statusFile, statusPayload, 'utf8');
  fs.writeFileSync(diffFile, 'diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new\n', 'utf8');

  const statusHash = computeSha256(fs.readFileSync(statusFile, 'utf8'));
  const diffHash = computeSha256(fs.readFileSync(diffFile, 'utf8'));

  db.prepare(`
    INSERT INTO evidence (id, project_id, task_id, attempt_id, evidence_type, storage_type, file_path, hash, byte_size, summary, created_at)
    VALUES (?, ?, ?, ?, 'GIT_STATUS', 'FILE', ?, ?, ?, 'Git status', ?)
  `).run(statusEvId, projectId, taskId, attemptId, statusFile, statusHash, Buffer.byteLength(statusPayload), now);

  db.prepare(`
    INSERT INTO evidence (id, project_id, task_id, attempt_id, evidence_type, storage_type, file_path, hash, byte_size, summary, created_at)
    VALUES (?, ?, ?, ?, 'GIT_DIFF', 'FILE', ?, ?, ?, 'Git diff', ?)
  `).run(diffEvId, projectId, taskId, attemptId, diffFile, diffHash, fs.statSync(diffFile).size, now);

  // 15. Adjudication (VERIFIED)
  const envJson = JSON.stringify({ verified: true, testsPassed: true });
  const envHash = computeSha256(envJson);
  const snapJson = JSON.stringify({ verified: true });
  const snapHash = computeSha256(snapJson);

  db.prepare(`
    INSERT INTO coder_submission_adjudications (
      id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
      task_ownership_epoch, action, status, lifecycle_version,
      authority_snapshot_json, authority_snapshot_hash,
      verification_commands_json, verification_commands_hash,
      verification_result_envelope_json, verification_result_envelope_hash,
      test_run_id, git_status_evidence_id, git_diff_evidence_id,
      artifact_manifest_json, artifact_manifest_hash,
      created_at, verification_started_at, completed_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      1, 'ADMIT_VERIFICATION', 'VERIFIED', 1,
      ?, ?,
      '{}', '${'0'.repeat(64)}',
      ?, ?,
      ?, ?, ?,
      '{}', '${'0'.repeat(64)}',
      ?, ?, ?
    )
  `).run(
    adjudicationId, crypto.randomUUID(), submissionId, authId, projectId, taskId, attemptId, assignmentId,
    snapJson, snapHash,
    envJson, envHash,
    testRunId, statusEvId, diffEvId,
    now, now, now
  );

  const service = new ReviewerAuthorityService(repo, artifactStore);

  return {
    tempDir,
    dbPath,
    db,
    repo,
    artifactStore,
    service,
    adjudicationId,
    submissionId,
    taskId,
    projectId,
    attemptId,
    assignmentId,
    authId,
    coderProviderId,
    coderAgentId,
    coderAccountId,
    reviewerProviderId,
    reviewerAccountId,
    reviewerResourceId,
    reviewerAgentId,
    reviewerAgentId2,
  };
}

describe('R5J7 MCP Reviewer Authority & Invariants (Cases 1–70, 124–131, 135–137, 139, 140)', () => {
  let tempDir: string;
  let fixtures: Fixtures;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-rev-auth-test-'));
    fixtures = seedFullAuthorityEnv(tempDir);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    try {
      if (fixtures?.db?.open) fixtures.db.close();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // Group 1: DDL Schema, Migration, and Trigger Immutability (Cases 1 - 20)
  it('1. Migration 24 clean forward migration to version 24', () => {
    const memDb = new Database(':memory:');
    memDb.pragma('foreign_keys = ON');
    MigrationRunner.run(memDb);
    const row = memDb.prepare('SELECT version, name FROM schema_migrations WHERE version = 24').get() as any;
    expect(row).toBeDefined();
    expect(row.name).toBe('024_r5j_reviewer_session_authority');
    memDb.close();
  });

  it('2. Table mcp_reviewer_sessions column schema and types', () => {
    const cols = fixtures.db.prepare('PRAGMA table_info(mcp_reviewer_sessions)').all() as any[];
    expect(cols).toHaveLength(19);
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('token_hash');
    expect(colNames).toContain('scope');
  });

  it('3. Table mcp_reviewer_sessions foreign key references', () => {
    const fks = fixtures.db.prepare('PRAGMA foreign_key_list(mcp_reviewer_sessions)').all() as any[];
    expect(fks).toHaveLength(6);
    const targetTables = new Set(fks.map((f) => f.table));
    expect(targetTables.has('coder_submission_adjudications')).toBe(true);
    expect(targetTables.has('coder_submissions')).toBe(true);
    expect(targetTables.has('agents')).toBe(true);
    expect(targetTables.has('providers')).toBe(true);
    expect(targetTables.has('provider_accounts')).toBe(true);
    expect(targetTables.has('provider_resources')).toBe(true);
  });

  it('4. Unique index on token_hash', () => {
    const idxs = fixtures.db.prepare('PRAGMA index_list(mcp_reviewer_sessions)').all() as any[];
    const tokenIdx = idxs.find((i) => i.name === 'idx_mcp_reviewer_sessions_token_hash');
    expect(tokenIdx).toBeDefined();
    expect(tokenIdx.unique).toBe(1);
  });

  it('5. Partial unique index on active adjudication and reviewer', () => {
    const idxs = fixtures.db.prepare('PRAGMA index_list(mcp_reviewer_sessions)').all() as any[];
    const activeIdx = idxs.find((i) => i.name === 'idx_mcp_reviewer_sessions_active_adjudication_reviewer');
    expect(activeIdx).toBeDefined();
    expect(activeIdx.unique).toBe(1);
  });

  it('6. Index on expires_at', () => {
    const idxs = fixtures.db.prepare('PRAGMA index_list(mcp_reviewer_sessions)').all() as any[];
    const expIdx = idxs.find((i) => i.name === 'idx_mcp_reviewer_sessions_expires_at');
    expect(expIdx).toBeDefined();
  });

  it('7. Index on reviewer_agent_id', () => {
    const idxs = fixtures.db.prepare('PRAGMA index_list(mcp_reviewer_sessions)').all() as any[];
    const agentIdx = idxs.find((i) => i.name === 'idx_mcp_reviewer_sessions_reviewer_agent');
    expect(agentIdx).toBeDefined();
  });

  it('8. Trigger trg_mcp_reviewer_sessions_no_delete prevents DELETE', () => {
    const issuance = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    expect(() => {
      fixtures.db.prepare('DELETE FROM mcp_reviewer_sessions WHERE id = ?').run(issuance.session.id);
    }).toThrowError(/MCP_IMMUTABLE_VIOLATION/);
  });

  it('9. Trigger trg_mcp_reviewer_sessions_immutable_update permits revocation', () => {
    const issuance = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    const now = new Date().toISOString();
    expect(() => {
      fixtures.db.prepare('UPDATE mcp_reviewer_sessions SET revoked_at = ?, revocation_reason = ? WHERE id = ?').run(now, 'MANUAL_AUDIT', issuance.session.id);
    }).not.toThrow();
  });

  it('10. Trigger rejects modification of already revoked session', () => {
    const issuance = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    fixtures.service.revokeSession(issuance.session.id, 'FIRST_REASON');
    expect(() => {
      fixtures.db.prepare('UPDATE mcp_reviewer_sessions SET revocation_reason = ? WHERE id = ?').run('SECOND_REASON', issuance.session.id);
    }).toThrowError(/MCP_IMMUTABLE_VIOLATION/);
  });

  it('11. Trigger rejects bare revocation without reason', () => {
    const issuance = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    const now = new Date().toISOString();
    expect(() => {
      fixtures.db.prepare('UPDATE mcp_reviewer_sessions SET revoked_at = ? WHERE id = ?').run(now, issuance.session.id);
    }).toThrowError(/MCP_IMMUTABLE_VIOLATION/);
  });

  it('12. Trigger rejects revocation reason without revoked_at', () => {
    const issuance = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    expect(() => {
      fixtures.db.prepare('UPDATE mcp_reviewer_sessions SET revocation_reason = ? WHERE id = ?').run('REASON_ONLY', issuance.session.id);
    }).toThrowError(/MCP_IMMUTABLE_VIOLATION/);
  });

  it('13. Trigger rejects revocation timestamp earlier than issued_at', () => {
    const issuance = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    const past = new Date(Date.now() - 36000000).toISOString();
    expect(() => {
      fixtures.db.prepare('UPDATE mcp_reviewer_sessions SET revoked_at = ?, revocation_reason = ? WHERE id = ?').run(past, 'EARLY_TIME', issuance.session.id);
    }).toThrowError(/MCP_IMMUTABLE_VIOLATION/);
  });

  it('14. Trigger rejects mutation of session primary key id', () => {
    const issuance = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    expect(() => {
      fixtures.db.prepare('UPDATE mcp_reviewer_sessions SET id = ? WHERE id = ?').run(crypto.randomUUID(), issuance.session.id);
    }).toThrowError(/MCP_IMMUTABLE_VIOLATION/);
  });

  it('15. Trigger rejects mutation of adjudication_id or submission_id', () => {
    const issuance = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    expect(() => {
      fixtures.db.prepare('UPDATE mcp_reviewer_sessions SET adjudication_id = ? WHERE id = ?').run(crypto.randomUUID(), issuance.session.id);
    }).toThrowError(/MCP_IMMUTABLE_VIOLATION/);
  });

  it('16. Trigger rejects mutation of reviewer binding tuple', () => {
    const issuance = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    expect(() => {
      fixtures.db.prepare('UPDATE mcp_reviewer_sessions SET reviewer_agent_id = ? WHERE id = ?').run(fixtures.reviewerAgentId2, issuance.session.id);
    }).toThrowError(/MCP_IMMUTABLE_VIOLATION/);
  });

  it('17. Trigger rejects mutation of token_hash or scope', () => {
    const issuance = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    expect(() => {
      fixtures.db.prepare('UPDATE mcp_reviewer_sessions SET token_hash = ? WHERE id = ?').run('0'.repeat(64), issuance.session.id);
    }).toThrowError(/MCP_IMMUTABLE_VIOLATION/);
  });

  it('18. Trigger rejects mutation of projection payload or hashes', () => {
    const issuance = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    expect(() => {
      fixtures.db.prepare('UPDATE mcp_reviewer_sessions SET projection_json = ? WHERE id = ?').run('{}', issuance.session.id);
    }).toThrowError(/MCP_IMMUTABLE_VIOLATION/);
  });

  it('19. Trigger rejects mutation of issued_at or expires_at', () => {
    const issuance = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    expect(() => {
      fixtures.db.prepare('UPDATE mcp_reviewer_sessions SET expires_at = ? WHERE id = ?').run(new Date().toISOString(), issuance.session.id);
    }).toThrowError(/MCP_IMMUTABLE_VIOLATION/);
  });

  it('20. Idempotent re-execution of Migration 24', () => {
    expect(() => {
      MigrationRunner.run(fixtures.db);
    }).not.toThrow();
  });

  // Group 2: Insert Fencing and Authority Invariants (Cases 21 - 40)
  it('21. Insert succeeds with fully verified, settled adjudication', () => {
    const res = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    expect(res.session).toBeDefined();
    expect(res.raw_token).toMatch(/^af-rev-[0-9a-f-]{36}$/);
  });

  it('22. Insert fails if adjudication does not exist', () => {
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: crypto.randomUUID(),
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/NOT_FOUND/);
  });

  it('23. Insert fails if adjudication action is not ADMIT_VERIFICATION', () => {
    const adj = fixtures.repo.getCoderSubmissionAdjudicationById(fixtures.adjudicationId)!;
    vi.spyOn(fixtures.repo, 'getCoderSubmissionAdjudicationById').mockReturnValue({ ...adj, action: 'REJECT' as any });
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/ADJUDICATION_ACTION_INVALID/);
  });

  it('24. Insert fails if adjudication status is not VERIFIED', () => {
    const adj = fixtures.repo.getCoderSubmissionAdjudicationById(fixtures.adjudicationId)!;
    vi.spyOn(fixtures.repo, 'getCoderSubmissionAdjudicationById').mockReturnValue({ ...adj, status: 'VERIFYING' as any });
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/ADJUDICATION_NOT_VERIFIED/);
  });

  it('25. Insert fails if adjudication recovery_fenced_at is NOT NULL', () => {
    const adj = fixtures.repo.getCoderSubmissionAdjudicationById(fixtures.adjudicationId)!;
    vi.spyOn(fixtures.repo, 'getCoderSubmissionAdjudicationById').mockReturnValue({ ...adj, recovery_fenced_at: new Date().toISOString() });
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/ADJUDICATION_RECOVERY_FENCED/);
  });

  it('26. Insert fails if adjudication test_run_id is missing', () => {
    const adj = fixtures.repo.getCoderSubmissionAdjudicationById(fixtures.adjudicationId)!;
    vi.spyOn(fixtures.repo, 'getCoderSubmissionAdjudicationById').mockReturnValue({ ...adj, test_run_id: null as any });
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/INTEGRITY_CONFLICT/);
  });

  it('27. Insert fails if adjudication git evidence IDs are missing', () => {
    const adj = fixtures.repo.getCoderSubmissionAdjudicationById(fixtures.adjudicationId)!;
    vi.spyOn(fixtures.repo, 'getCoderSubmissionAdjudicationById').mockReturnValue({ ...adj, git_diff_evidence_id: null as any });
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/INTEGRITY_CONFLICT/);
  });

  it('28. Insert fails if adjudication verification envelope is missing', () => {
    const adj = fixtures.repo.getCoderSubmissionAdjudicationById(fixtures.adjudicationId)!;
    vi.spyOn(fixtures.repo, 'getCoderSubmissionAdjudicationById').mockReturnValue({ ...adj, verification_result_envelope_json: null as any });
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/INTEGRITY_CONFLICT/);
  });

  it('29. Insert fails if submission ID does not match adjudication', () => {
    const adj = fixtures.repo.getCoderSubmissionAdjudicationById(fixtures.adjudicationId)!;
    vi.spyOn(fixtures.repo, 'getCoderSubmissionAdjudicationById').mockReturnValue({ ...adj, submission_id: crypto.randomUUID() });
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/NOT_FOUND/);
  });

  it('30. Insert fails if task ownership epoch does not match', () => {
    fixtures.db.prepare('UPDATE tasks SET ownership_epoch = 2 WHERE id = ?').run(fixtures.taskId);
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/TASK_EPOCH_MISMATCH/);
  });

  it('31. Insert fails if authority snapshot hash does not match', () => {
    const adj = fixtures.repo.getCoderSubmissionAdjudicationById(fixtures.adjudicationId)!;
    vi.spyOn(fixtures.repo, 'getCoderSubmissionAdjudicationById').mockReturnValue({ ...adj, authority_snapshot_hash: 'f'.repeat(64) });
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/INTEGRITY_CONFLICT|AUTHORITY_INTEGRITY_VIOLATION/);
  });

  it('32. Insert fails if verification envelope hash does not match', () => {
    const adj = fixtures.repo.getCoderSubmissionAdjudicationById(fixtures.adjudicationId)!;
    vi.spyOn(fixtures.repo, 'getCoderSubmissionAdjudicationById').mockReturnValue({ ...adj, verification_result_envelope_hash: 'f'.repeat(64) });
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/INTEGRITY_CONFLICT|AUTHORITY_INTEGRITY_VIOLATION/);
  });

  it('33. Insert fails if submission has no terminal disposition', () => {
    vi.spyOn(fixtures.repo, 'getCoderSubmissionDispositions').mockReturnValue([]);
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/DISPOSITION_INVALID/);
  });

  it('34. Insert fails if submission terminal disposition is REJECTED', () => {
    vi.spyOn(fixtures.repo, 'getCoderSubmissionDispositions').mockReturnValue([
      { id: 'disp-rej', submission_id: fixtures.submissionId, disposition_event: 'REJECTED', disposition_reason: 'INTEGRITY_MISMATCH', actor_type: 'OPERATOR', actor_id: 'test', created_at: new Date().toISOString() } as any,
    ]);
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/DISPOSITION_INVALID/);
  });

  it('35. Insert fails if terminal disposition reason is not ACCEPTED_VERIFIED', () => {
    vi.spyOn(fixtures.repo, 'getCoderSubmissionDispositions').mockReturnValue([
      { id: 'disp-man', submission_id: fixtures.submissionId, disposition_event: 'SETTLED', disposition_reason: 'MANUAL_OVERRIDE', actor_type: 'OPERATOR', actor_id: 'test', created_at: new Date().toISOString() } as any,
    ]);
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/DISPOSITION_INVALID/);
  });

  it('36. Insert fails if multiple terminal dispositions exist on submission', () => {
    fixtures.db.prepare(`
      INSERT INTO coder_submission_dispositions (id, submission_id, disposition_event, disposition_reason, actor_type, actor_id, created_at)
      VALUES (?, ?, 'SETTLED', 'ACCEPTED_VERIFIED', 'OPERATOR', 'extra', ?)
    `).run(crypto.randomUUID(), fixtures.submissionId, new Date().toISOString());
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/DISPOSITION_INVALID/);
  });

  it('37. Insert fails if task state is not REVIEW_READY', () => {
    fixtures.db.prepare('UPDATE tasks SET state = ? WHERE id = ?').run('VALIDATING', fixtures.taskId);
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/TASK_STATE_INVALID/);
  });

  it('38. Insert fails if task ownership epoch mismatches session epoch', () => {
    fixtures.db.prepare('UPDATE tasks SET ownership_epoch = 9 WHERE id = ?').run(fixtures.taskId);
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/TASK_EPOCH_MISMATCH/);
  });

  it('39. Insert fails if reviewer agent role is not REVIEWER', () => {
    fixtures.db.prepare('UPDATE agents SET role = ? WHERE id = ?').run('CODER', fixtures.reviewerAgentId);
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/REVIEWER_AGENT_INVALID/);
  });

  it('40. Insert fails if reviewer agent status is OFFLINE', () => {
    fixtures.db.prepare('UPDATE agents SET status = ? WHERE id = ?').run('OFFLINE', fixtures.reviewerAgentId);
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/REVIEWER_AGENT_INVALID/);
  });

  // Group 3: Identity, Resource Binding, and Self-Review Policy (Cases 41 - 55)
  it('41. Direct agent-provider-account-resource 4-tuple binding validation', () => {
    const res = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    expect(res.session.reviewer_agent_id).toBe(fixtures.reviewerAgentId);
    expect(res.session.reviewer_provider_id).toBe(fixtures.reviewerProviderId);
    expect(res.session.reviewer_account_id).toBe(fixtures.reviewerAccountId);
    expect(res.session.reviewer_resource_id).toBe(fixtures.reviewerResourceId);
  });

  it('42. Agent provider resource compatibility check', () => {
    fixtures.db.prepare('UPDATE agents SET provider_resource_id = NULL WHERE id = ?').run(fixtures.reviewerAgentId);
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).not.toThrow();
  });

  it('43. Agent provider resource incompatibility rejection', () => {
    const otherRes = `res-other-${crypto.randomUUID()}`;
    fixtures.db.prepare(`
      INSERT INTO provider_resources (id, provider_id, provider_account_id, model_name, health_status, capabilities_json, enabled)
      VALUES (?, ?, ?, 'model-other', 'AVAILABLE', '[]', 1)
    `).run(otherRes, fixtures.reviewerProviderId, fixtures.reviewerAccountId);
    fixtures.db.prepare('UPDATE agents SET provider_resource_id = ? WHERE id = ?').run(otherRes, fixtures.reviewerAgentId);

    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/REVIEWER_AGENT_INVALID/);
  });

  it('44. Reviewer provider must exist and be enabled', () => {
    fixtures.db.prepare('UPDATE providers SET enabled = 0 WHERE id = ?').run(fixtures.reviewerProviderId);
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/REVIEWER_PROVIDER_INVALID/);
  });

  it('45. Reviewer account must exist and belong to provider', () => {
    const otherAccId = `acc-other-${crypto.randomUUID()}`;
    fixtures.db.prepare(`INSERT INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at) VALUES (?, ?, 'OtherAccount', 'NATIVE_PROFILE', 1, 10, 'AVAILABLE', 5, ?, ?)`).run(
      otherAccId, fixtures.coderProviderId, new Date().toISOString(), new Date().toISOString()
    );
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: otherAccId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/REVIEWER_ACCOUNT_INVALID/);
  });

  it('46. Reviewer account must be enabled', () => {
    fixtures.db.prepare('UPDATE provider_accounts SET enabled = 0 WHERE id = ?').run(fixtures.reviewerAccountId);
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/REVIEWER_ACCOUNT_INVALID/);
  });

  it('47. Reviewer account health AVAILABLE permitted', () => {
    fixtures.db.prepare('UPDATE provider_accounts SET health_status = ? WHERE id = ?').run('AVAILABLE', fixtures.reviewerAccountId);
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).not.toThrow();
  });

  it('48. Reviewer account health BUSY permitted', () => {
    fixtures.db.prepare('UPDATE provider_accounts SET health_status = ? WHERE id = ?').run('BUSY', fixtures.reviewerAccountId);
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).not.toThrow();
  });

  it('49. Reviewer account health LOW_QUOTA permitted', () => {
    fixtures.db.prepare('UPDATE provider_accounts SET health_status = ? WHERE id = ?').run('LOW_QUOTA', fixtures.reviewerAccountId);
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).not.toThrow();
  });

  it('50. Reviewer account health UNHEALTHY/SUSPENDED rejected', () => {
    fixtures.db.prepare('UPDATE provider_accounts SET health_status = ? WHERE id = ?').run('UNHEALTHY', fixtures.reviewerAccountId);
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/REVIEWER_ACCOUNT_INVALID/);
  });

  it('51. Reviewer resource must exist and belong to provider', () => {
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: `res-fake-${crypto.randomUUID()}`,
      });
    }).toThrowError(/REVIEWER_RESOURCE_INVALID/);
  });

  it('52. Reviewer resource must be enabled and healthy', () => {
    fixtures.db.prepare('UPDATE provider_resources SET enabled = 0 WHERE id = ?').run(fixtures.reviewerResourceId);
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/REVIEWER_RESOURCE_INVALID/);
  });

  it('53. Reviewer resource account binding compatibility', () => {
    fixtures.db.prepare('UPDATE provider_resources SET provider_account_id = NULL WHERE id = ?').run(fixtures.reviewerResourceId);
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).not.toThrow();
  });

  it('54. Self-review forbidden: reviewer agent matches coder agent', () => {
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.coderAgentId, // Matches coder agent
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/SELF_REVIEW_FORBIDDEN/);
  });

  it('55. Self-review forbidden: reviewer account matches coder selected account', () => {
    // Attempting to review using coderAccountId
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.coderAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/SELF_REVIEW_FORBIDDEN|REVIEWER_ACCOUNT_INVALID/);
  });

  // Group 4: Token Generation, Authentication, and Multi-Reviewer Isolation (Cases 56 - 70)
  it('56. Reviewer token format validation: af-rev-lowercase-uuid4', () => {
    const res = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    expect(res.raw_token).toMatch(/^af-rev-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('57. Token entropy and uniqueness check', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const token = `af-rev-${crypto.randomUUID()}`;
      expect(tokens.has(token)).toBe(false);
      tokens.add(token);
    }
  });

  it('58. Token SHA-256 storage without plaintext leakage', () => {
    const res = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    const sessionInDb = fixtures.repo.getMcpReviewerSessionById(res.session.id)!;
    expect(sessionInDb.token_hash).toBe(computeSha256(res.raw_token));
    expect(JSON.stringify(sessionInDb)).not.toContain(res.raw_token);
  });

  it('59. Authentication succeeds with valid active token', () => {
    const res = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    const authenticated = fixtures.service.authenticateToken(res.raw_token);
    expect(authenticated.id).toBe(res.session.id);
  });

  it('60. Authentication fails closed with unknown token', () => {
    const unknown = `af-rev-${crypto.randomUUID()}`;
    expect(() => {
      fixtures.service.authenticateToken(unknown);
    }).toThrowError(/AUTH_FAILED/);
  });

  it('61. Authentication fails closed with expired token', () => {
    const res = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
      duration_seconds: 60,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 70000));
    expect(() => {
      fixtures.service.authenticateToken(res.raw_token);
    }).toThrowError(/TOKEN_EXPIRED/);
  });

  it('62. Authentication fails closed with revoked token', () => {
    const res = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    fixtures.service.revokeSession(res.session.id, 'TEST_REVOCATION');
    expect(() => {
      fixtures.service.authenticateToken(res.raw_token);
    }).toThrowError(/TOKEN_REVOKED/);
  });

  it('63. Authentication fails closed on malformed token string', () => {
    expect(() => {
      fixtures.service.authenticateToken('bad-prefix-token');
    }).toThrowError(/AUTH_FAILED|INVALID_REVIEWER_TOKEN/);
  });

  it('64. Multi-reviewer policy: multiple distinct reviewers per adjudication', () => {
    const res1 = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    const res2 = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId2,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    expect(res1.session.id).not.toBe(res2.session.id);
  });

  it('65. Multi-reviewer policy: duplicate active session for same reviewer rejected', () => {
    fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    // Active session exists and has not expired
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/UNIQUE constraint failed|DUPLICATE_ACTIVE_SESSION/);
  });

  it('66. Multi-reviewer policy: subsequent session allowed after revoking first', () => {
    const res1 = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    fixtures.service.revokeSession(res1.session.id, 'ROTATION');
    const res2 = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    expect(res2.session.id).not.toBe(res1.session.id);
  });

  it('67. Session duration minimum bound check (60s)', () => {
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
        duration_seconds: 59,
      });
    }).toThrowError(/SESSION_DURATION_INVALID/);
  });

  it('68. Session duration maximum bound check (86400s)', () => {
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
        duration_seconds: 86401,
      });
    }).toThrowError(/SESSION_DURATION_INVALID/);
  });

  it('69. Explicit session revocation API with mandatory reason', () => {
    const res = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    const ok = fixtures.service.revokeSession(res.session.id, 'SECURITY_INCIDENT');
    expect(ok).toBe(true);
    const updated = fixtures.repo.getMcpReviewerSessionById(res.session.id)!;
    expect(updated.revoked_at).not.toBeNull();
    expect(updated.revocation_reason).toBe('SECURITY_INCIDENT');
  });

  it('70. Session revocation idempotency / double revoke rejection', () => {
    const res = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    fixtures.service.revokeSession(res.session.id, 'FIRST_REVOCATION');
    const secondRevoke = fixtures.service.revokeSession(res.session.id, 'SECOND_REVOCATION');
    expect(secondRevoke).toBe(false);
  });

  // 124. Migration 24 embedded DDL inventory, foreign key graph, and canonical SQL integrity verification
  it('124. Migration 24 embedded DDL inventory, foreign key graph, and canonical SQL integrity verification', () => {
    verifyMigration24SchemaAuthority(fixtures.db);
    expect(MIGRATIONS).toHaveLength(24);
    const mig24 = MIGRATIONS[23];
    expect(mig24.version).toBe(24);
    expect(mig24.name).toBe('024_r5j_reviewer_session_authority');
  });

  // 125. Binary evidence is rejected with EVIDENCE_ENCODING_INVALID
  it('125. Binary evidence is rejected with EVIDENCE_ENCODING_INVALID', () => {
    const existingAdj = fixtures.repo.getCoderSubmissionAdjudicationById(fixtures.adjudicationId)!;
    const binAdjId = crypto.randomUUID();
    const binEvId = `ev-bin-${crypto.randomUUID()}`;
    const binFile = path.join(fixtures.tempDir, 'artifacts', 'binary.bin');
    fs.writeFileSync(binFile, Buffer.from([0x00, 0xff, 0xfe, 0x12]));

    const binBytes = fs.readFileSync(binFile);
    const binHash = crypto.createHash('sha256').update(binBytes).digest('hex');

    fixtures.db.prepare(`
      INSERT INTO evidence (id, project_id, task_id, attempt_id, evidence_type, storage_type, file_path, hash, byte_size, content_type, summary, created_at)
      VALUES (?, ?, ?, ?, 'GIT_DIFF', 'FILE', ?, ?, 4, 'application/octet-stream', 'Binary diff', ?)
    `).run(binEvId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, binFile, binHash, new Date().toISOString());

    fixtures.db.prepare(`
      INSERT INTO coder_submission_adjudications (
        id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
        task_ownership_epoch, action, status, lifecycle_version,
        authority_snapshot_json, authority_snapshot_hash,
        verification_commands_json, verification_commands_hash,
        verification_result_envelope_json, verification_result_envelope_hash,
        test_run_id, git_status_evidence_id, git_diff_evidence_id,
        artifact_manifest_json, artifact_manifest_hash,
        created_at, verification_started_at, completed_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        1, 'ADMIT_VERIFICATION', 'VERIFIED', 1,
        ?, ?,
        '{}', '${'0'.repeat(64)}',
        '{}', '${'0'.repeat(64)}',
        ?, ?, ?,
        '{}', '${'0'.repeat(64)}',
        ?, ?, ?
      )
    `).run(binAdjId, crypto.randomUUID(), fixtures.submissionId, fixtures.authId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, existingAdj.authority_snapshot_json, existingAdj.authority_snapshot_hash, existingAdj.test_run_id, existingAdj.git_status_evidence_id, binEvId, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());

    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: binAdjId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/EVIDENCE_ENCODING_INVALID/);
  });

  // 126. Invalid UTF-8 evidence fails closed before reviewer-session insertion with INVALID_UTF8_ENCODING
  it('126. Invalid UTF-8 evidence fails closed before reviewer-session insertion with INVALID_UTF8_ENCODING', () => {
    const invalidUtf8Sequences = [
      Buffer.from([0x80]),
      Buffer.from([0xc0, 0xaf]),
      Buffer.from([0xe2, 0x82]),
      Buffer.from([0xf5, 0x80, 0x80, 0x80]),
    ];

    for (const seq of invalidUtf8Sequences) {
      expect(() => fatalUtf8Decode(seq)).toThrow();
    }
  });

  // 127. Diagnostic scrubbing removes raw tokens, token hashes, environment secrets, database locations, Windows/Unix host paths, and stack traces
  it('127. Diagnostic scrubbing removes raw tokens, token hashes, environment secrets, database locations, Windows/Unix host paths, and stack traces', () => {
    const dirty = `Error at D:\\Projects\\Agent-Forge\\src\\index.ts: secret token af-rev-12345678-1234-4234-8234-1234567890ab and hash ${'a'.repeat(64)}`;
    const scrubbed = scrubReviewerDiagnostics(dirty);
    expect(scrubbed).not.toContain('af-rev-12345678-1234-4234-8234-1234567890ab');
    expect(scrubbed).not.toContain('D:\\Projects\\Agent-Forge');
  });

  // 128. Path escape or symlink-equivalent evidence reference is rejected at the actual repository trust boundary
  it('128. Path escape or symlink-equivalent evidence reference is rejected at the actual repository trust boundary', () => {
    const existingAdj = fixtures.repo.getCoderSubmissionAdjudicationById(fixtures.adjudicationId)!;
    const escapeEvId = `ev-escape-${crypto.randomUUID()}`;
    const escapePath = path.resolve(fixtures.tempDir, '..', 'escape.txt');
    fs.writeFileSync(escapePath, 'escaped');

    fixtures.db.prepare(`
      INSERT INTO evidence (id, project_id, task_id, attempt_id, evidence_type, storage_type, file_path, hash, byte_size, summary, created_at)
      VALUES (?, ?, ?, ?, 'GIT_DIFF', 'FILE', ?, ?, 7, 'Escape diff', ?)
    `).run(escapeEvId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, escapePath, computeSha256(fs.readFileSync(escapePath, 'utf8')), new Date().toISOString());

    const escapeAdjId = crypto.randomUUID();
    fixtures.db.prepare(`
      INSERT INTO coder_submission_adjudications (
        id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
        task_ownership_epoch, action, status, lifecycle_version,
        authority_snapshot_json, authority_snapshot_hash,
        verification_commands_json, verification_commands_hash,
        verification_result_envelope_json, verification_result_envelope_hash,
        test_run_id, git_status_evidence_id, git_diff_evidence_id,
        artifact_manifest_json, artifact_manifest_hash,
        created_at, verification_started_at, completed_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        1, 'ADMIT_VERIFICATION', 'VERIFIED', 1,
        ?, ?,
        '{}', '${'0'.repeat(64)}',
        '{}', '${'0'.repeat(64)}',
        ?, ?, ?,
        '{}', '${'0'.repeat(64)}',
        ?, ?, ?
      )
    `).run(escapeAdjId, crypto.randomUUID(), fixtures.submissionId, fixtures.authId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, existingAdj.authority_snapshot_json, existingAdj.authority_snapshot_hash, existingAdj.test_run_id, existingAdj.git_status_evidence_id, escapeEvId, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());

    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: escapeAdjId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/path escape/);
  });

  // 129. TOCTOU/substitution attempt between evidence validation and session insertion is detected by exact canonical hash binding and rolls back
  it('129. TOCTOU/substitution attempt between evidence validation and session insertion is detected by exact canonical hash binding and rolls back', () => {
    // Modify the evidence file hash without updating the database record
    const diffFile = path.join(fixtures.tempDir, 'artifacts', 'git-diff.patch');
    fs.writeFileSync(diffFile, 'MODIFIED_CONTENT_TOCTOU', 'utf8');

    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/PROJECTION_HASH_MISMATCH/);
  });

  // 130. Authority changes after issuance do not cause reconstruction from live state and stale authority fails closed
  it('130. Authority changes after issuance do not cause reconstruction from live state and stale authority fails closed', () => {
    const res = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });

    // 1. Task epoch bump -> STALE_REVIEWER_AUTHORITY
    fixtures.db.prepare('UPDATE tasks SET ownership_epoch = 2 WHERE id = ?').run(fixtures.taskId);
    expect(() => {
      fixtures.service.getReviewPackage(res.session, fixtures.adjudicationId);
    }).toThrowError(/STALE_REVIEWER_AUTHORITY/);
    fixtures.db.prepare('UPDATE tasks SET ownership_epoch = 1 WHERE id = ?').run(fixtures.taskId);

    // 2. Recovery fenced -> REVIEW_AUTHORITY_FENCED
    const fenceSpy = vi.spyOn(fixtures.repo, 'getAdjudicationAuthorityFenceState').mockReturnValueOnce({
      adjudication_status: 'VERIFIED',
      adjudication_recovery_fenced_at: new Date().toISOString(),
      current_authority_snapshot_hash: res.session.authority_snapshot_hash,
      current_task_ownership_epoch: res.session.task_ownership_epoch,
    });
    expect(() => {
      fixtures.service.getReviewPackage(res.session, fixtures.adjudicationId);
    }).toThrowError(/REVIEW_AUTHORITY_FENCED/);
    fenceSpy.mockRestore();

    // 3. Revoked session -> TOKEN_REVOKED
    fixtures.service.revokeSession(res.session.id, 'REVOKE_STALE');
    const revokedSession = fixtures.repo.getMcpReviewerSessionById(res.session.id)!;
    expect(() => {
      fixtures.service.getReviewPackage(revokedSession, fixtures.adjudicationId);
    }).toThrowError(/TOKEN_REVOKED/);
  });

  // 131. Two concurrent issue attempts for the same adjudication and reviewer binding result in exactly one active session
  it('131. Two concurrent issue attempts for the same adjudication and reviewer binding result in exactly one active session', () => {
    // Open a second SQLite connection
    const db2 = new Database(fixtures.dbPath);
    db2.pragma('foreign_keys = ON');
    const repo2 = new Repository(db2);
    const service2 = new ReviewerAuthorityService(repo2, fixtures.artifactStore);

    const res1 = fixtures.service.issueReviewerSession({
      adjudication_id: fixtures.adjudicationId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
    });
    expect(res1.session).toBeDefined();

    expect(() => {
      service2.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/UNIQUE constraint failed|DUPLICATE_ACTIVE_SESSION/);

    db2.close();
  });

  // 135. Cross-provider access fails closed
  it('135. Cross-provider access fails closed', () => {
    const otherProviderId = `prov-other-${crypto.randomUUID()}`;
    fixtures.db.prepare(`INSERT INTO providers (id, name, adapter_type, enabled, created_at) VALUES (?, 'OtherProvider', 'LOCAL_CLI', 1, ?)`).run(otherProviderId, new Date().toISOString());

    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: otherProviderId, // Mismatched provider
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/REVIEWER_ACCOUNT_INVALID|REVIEWER_RESOURCE_INVALID/);
  });

  // 136. Cross-account access fails closed
  it('136. Cross-account access fails closed', () => {
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: `acc-other-${crypto.randomUUID()}`,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/REVIEWER_ACCOUNT_INVALID/);
  });

  // 137. Cross-resource access fails closed
  it('137. Cross-resource access fails closed', () => {
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: `res-other-${crypto.randomUUID()}`,
      });
    }).toThrowError(/REVIEWER_RESOURCE_INVALID/);
  });

  // 139. Missing frozen artifact, malformed canonical artifact, or artifact/hash mismatch prevents issuance with full transactional rollback
  it('139. Missing frozen artifact, malformed canonical artifact, or artifact/hash mismatch prevents issuance with full transactional rollback', () => {
    const statusFile = path.join(fixtures.tempDir, 'artifacts', 'git-status.txt');
    fs.unlinkSync(statusFile);

    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/NOT_FOUND/);

    // Assert zero sessions were inserted into database
    const count = (fixtures.db.prepare('SELECT COUNT(*) as c FROM mcp_reviewer_sessions').get() as any).c;
    expect(count).toBe(0);
  });

  // 140. Contradictory authoritative evidence or multiple terminal dispositions prevents issuance fail-closed
  it('140. Contradictory authoritative evidence or multiple terminal dispositions prevents issuance fail-closed', () => {
    fixtures.db.prepare(`
      INSERT INTO coder_submission_dispositions (id, submission_id, disposition_event, disposition_reason, actor_type, actor_id, created_at)
      VALUES (?, ?, 'REJECTED', 'INTEGRITY_MISMATCH', 'OPERATOR', 'contradictory', ?)
    `).run(crypto.randomUUID(), fixtures.submissionId, new Date().toISOString());

    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: fixtures.adjudicationId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/DISPOSITION_INVALID/);

    const count = (fixtures.db.prepare('SELECT COUNT(*) as c FROM mcp_reviewer_sessions').get() as any).c;
    expect(count).toBe(0);
  });

  function createAdjudicationWithEvidence(statusEvId: string, diffEvId: string): string {
    const adjId = crypto.randomUUID();
    const now = new Date().toISOString();
    const baseAdj = fixtures.repo.getCoderSubmissionAdjudicationById(fixtures.adjudicationId)!;
    fixtures.db.prepare(`
      INSERT INTO coder_submission_adjudications (
        id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
        task_ownership_epoch, action, status, lifecycle_version,
        authority_snapshot_json, authority_snapshot_hash,
        verification_commands_json, verification_commands_hash,
        verification_result_envelope_json, verification_result_envelope_hash,
        test_run_id, git_status_evidence_id, git_diff_evidence_id,
        artifact_manifest_json, artifact_manifest_hash,
        created_at, verification_started_at, completed_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        1, 'ADMIT_VERIFICATION', 'VERIFIED', 1,
        ?, ?,
        '{}', '${'0'.repeat(64)}',
        ?, ?,
        ?, ?, ?,
        '{}', '${'0'.repeat(64)}',
        ?, ?, ?
      )
    `).run(
      adjId, crypto.randomUUID(), fixtures.submissionId, fixtures.authId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId,
      baseAdj.authority_snapshot_json, baseAdj.authority_snapshot_hash,
      baseAdj.verification_result_envelope_json, baseAdj.verification_result_envelope_hash,
      baseAdj.test_run_id, statusEvId, diffEvId,
      now, now, now
    );
    return adjId;
  }

  // 143. INLINE git-status hash mismatch fails closed before session insertion
  it('143. INLINE git-status hash mismatch fails closed before session insertion', () => {
    const inlineStatusId = `ev-inline-status-${crypto.randomUUID()}`;
    const payload = JSON.stringify({ isClean: true, files: [] });
    const realBytes = Buffer.byteLength(payload, 'utf8');
    const corruptedHash = 'e'.repeat(64);

    fixtures.db.prepare(`
      INSERT INTO evidence (id, project_id, task_id, attempt_id, evidence_type, storage_type, raw_payload, hash, byte_size, summary, created_at)
      VALUES (?, ?, ?, ?, 'GIT_STATUS', 'INLINE', ?, ?, ?, 'Inline status mismatch', ?)
    `).run(inlineStatusId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, payload, corruptedHash, realBytes, new Date().toISOString());

    const testAdjId = createAdjudicationWithEvidence(inlineStatusId, (fixtures.repo.getCoderSubmissionAdjudicationById(fixtures.adjudicationId) as any).git_diff_evidence_id);

    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: testAdjId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/PROJECTION_HASH_MISMATCH/);

    const count = (fixtures.db.prepare('SELECT COUNT(*) as c FROM mcp_reviewer_sessions WHERE adjudication_id = ?').get(testAdjId) as any).c;
    expect(count).toBe(0);
  });

  // 144. INLINE git-status byte-size mismatch fails closed before session insertion
  it('144. INLINE git-status byte-size mismatch fails closed before session insertion', () => {
    const inlineStatusId = `ev-inline-status-${crypto.randomUUID()}`;
    const payload = JSON.stringify({ isClean: true, files: [] });
    const realHash = computeSha256(payload);
    const wrongBytes = Buffer.byteLength(payload, 'utf8') + 42;

    fixtures.db.prepare(`
      INSERT INTO evidence (id, project_id, task_id, attempt_id, evidence_type, storage_type, raw_payload, hash, byte_size, summary, created_at)
      VALUES (?, ?, ?, ?, 'GIT_STATUS', 'INLINE', ?, ?, ?, 'Inline status size mismatch', ?)
    `).run(inlineStatusId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, payload, realHash, wrongBytes, new Date().toISOString());

    const testAdjId = createAdjudicationWithEvidence(inlineStatusId, (fixtures.repo.getCoderSubmissionAdjudicationById(fixtures.adjudicationId) as any).git_diff_evidence_id);

    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: testAdjId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/PROJECTION_HASH_MISMATCH/);

    const count = (fixtures.db.prepare('SELECT COUNT(*) as c FROM mcp_reviewer_sessions WHERE adjudication_id = ?').get(testAdjId) as any).c;
    expect(count).toBe(0);
  });

  // 145. INLINE git-diff hash mismatch fails closed before session insertion
  it('145. INLINE git-diff hash mismatch fails closed before session insertion', () => {
    const inlineDiffId = `ev-inline-diff-${crypto.randomUUID()}`;
    const payload = 'diff --git a/test.ts b/test.ts\n--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-1\n+2\n';
    const realBytes = Buffer.byteLength(payload, 'utf8');
    const corruptedHash = 'd'.repeat(64);

    fixtures.db.prepare(`
      INSERT INTO evidence (id, project_id, task_id, attempt_id, evidence_type, storage_type, raw_payload, hash, byte_size, summary, created_at)
      VALUES (?, ?, ?, ?, 'GIT_DIFF', 'INLINE', ?, ?, ?, 'Inline diff mismatch', ?)
    `).run(inlineDiffId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, payload, corruptedHash, realBytes, new Date().toISOString());

    const testAdjId = createAdjudicationWithEvidence((fixtures.repo.getCoderSubmissionAdjudicationById(fixtures.adjudicationId) as any).git_status_evidence_id, inlineDiffId);

    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: testAdjId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/PROJECTION_HASH_MISMATCH/);

    const count = (fixtures.db.prepare('SELECT COUNT(*) as c FROM mcp_reviewer_sessions WHERE adjudication_id = ?').get(testAdjId) as any).c;
    expect(count).toBe(0);
  });

  // 146. INLINE git-diff byte-size mismatch fails closed before session insertion
  it('146. INLINE git-diff byte-size mismatch fails closed before session insertion', () => {
    const inlineDiffId = `ev-inline-diff-${crypto.randomUUID()}`;
    const payload = 'diff --git a/test.ts b/test.ts\n--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-1\n+2\n';
    const realHash = computeSha256(payload);
    const wrongBytes = Buffer.byteLength(payload, 'utf8') + 99;

    fixtures.db.prepare(`
      INSERT INTO evidence (id, project_id, task_id, attempt_id, evidence_type, storage_type, raw_payload, hash, byte_size, summary, created_at)
      VALUES (?, ?, ?, ?, 'GIT_DIFF', 'INLINE', ?, ?, ?, 'Inline diff size mismatch', ?)
    `).run(inlineDiffId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, payload, realHash, wrongBytes, new Date().toISOString());

    const testAdjId = createAdjudicationWithEvidence((fixtures.repo.getCoderSubmissionAdjudicationById(fixtures.adjudicationId) as any).git_status_evidence_id, inlineDiffId);

    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: testAdjId,
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/PROJECTION_HASH_MISMATCH/);

    const count = (fixtures.db.prepare('SELECT COUNT(*) as c FROM mcp_reviewer_sessions WHERE adjudication_id = ?').get(testAdjId) as any).c;
    expect(count).toBe(0);
  });

  // 147. Zero reviewer-session rows written after every failed issuance
  it('147. Zero reviewer-session rows written after every failed issuance', () => {
    const beforeCount = (fixtures.db.prepare('SELECT COUNT(*) as c FROM mcp_reviewer_sessions').get() as any).c;

    // Trigger failure by unknown adjudication
    expect(() => {
      fixtures.service.issueReviewerSession({
        adjudication_id: crypto.randomUUID(),
        reviewer_agent_id: fixtures.reviewerAgentId,
        reviewer_provider_id: fixtures.reviewerProviderId,
        reviewer_account_id: fixtures.reviewerAccountId,
        reviewer_resource_id: fixtures.reviewerResourceId,
      });
    }).toThrowError(/NOT_FOUND/);

    const afterCount = (fixtures.db.prepare('SELECT COUNT(*) as c FROM mcp_reviewer_sessions').get() as any).c;
    expect(afterCount).toBe(beforeCount);
  });

  // 148. Migration 24 deterministic decompression, explicit expected SHA-256 hash match, and schema verification
  it('148. Migration 24 deterministic decompression, explicit expected SHA-256 hash match, and schema verification', () => {
    // 1. Decompress stored GZIP chunks through verified production path
    const verifiedSql = decompressAndVerifyMigration24Sql(MIGRATION_24_GZIP_CHUNKS, MIGRATION_24_EXPECTED_SQL_SHA256);
    expect(verifiedSql.length).toBeGreaterThan(0);

    // 2. Assert explicit deterministic SHA-256 hash
    const computedHash = computeSha256(verifiedSql);
    expect(computedHash).toBe(MIGRATION_24_EXPECTED_SQL_SHA256);
    expect(MIGRATION_24_EXPECTED_SQL_SHA256).toBe('2fc99142425342a96d76c187ad86f5ed433c214718f0a3790e482c2767a751fd');

    // 3. Assert rejection of invalid Base64 input
    expect(() => {
      decompressAndVerifyMigration24Sql(['@@@invalid-base64@@@'], MIGRATION_24_EXPECTED_SQL_SHA256);
    }).toThrowError(/MIGRATION_24_INTEGRITY_VIOLATION.*invalid Base64/);

    // 4. Assert rejection of invalid GZIP input
    const nonGzipBase64 = Buffer.from('this is plain text, definitely not gzip').toString('base64');
    expect(() => {
      decompressAndVerifyMigration24Sql([nonGzipBase64], MIGRATION_24_EXPECTED_SQL_SHA256);
    }).toThrowError(/MIGRATION_24_INTEGRITY_VIOLATION.*Failed to decompress Migration 24 GZIP stream/);

    // 5. Assert rejection of invalid UTF-8 after decompression
    const invalidUtf8Bytes = Buffer.from([0x80, 0x81, 0x82, 0xff]);
    const invalidUtf8GzipBase64 = zlib.gzipSync(invalidUtf8Bytes).toString('base64');
    expect(() => {
      decompressAndVerifyMigration24Sql([invalidUtf8GzipBase64], MIGRATION_24_EXPECTED_SQL_SHA256);
    }).toThrowError(/MIGRATION_24_INTEGRITY_VIOLATION.*invalid UTF-8 bytes/);

    // 6. Assert rejection of syntactically valid GZIP stream containing modified SQL
    const modifiedSql = 'CREATE TABLE modified_table (id TEXT PRIMARY KEY);';
    const modifiedSqlGzipBase64 = zlib.gzipSync(Buffer.from(modifiedSql, 'utf8')).toString('base64');
    expect(() => {
      decompressAndVerifyMigration24Sql([modifiedSqlGzipBase64], MIGRATION_24_EXPECTED_SQL_SHA256);
    }).toThrowError(/MIGRATION_24_INTEGRITY_VIOLATION.*SHA-256 mismatch/);

    // 7. Assert rejection of valid SQL supplied with incorrect expected hash
    expect(() => {
      decompressAndVerifyMigration24Sql(MIGRATION_24_GZIP_CHUNKS, '0'.repeat(64));
    }).toThrowError(/MIGRATION_24_INTEGRITY_VIOLATION.*SHA-256 mismatch/);

    // 8. Assert complete schema authority on live database (19 columns, 6 RESTRICT FKs, 4 indexes, 3 triggers)
    expect(() => verifyMigration24SchemaAuthority(fixtures.db)).not.toThrow();

    // 9. Legacy decompressMigration24Sql wrapper succeeds on canonical chunks and fails on corrupted chunks
    expect(decompressMigration24Sql(MIGRATION_24_GZIP_CHUNKS)).toBe(verifiedSql);
    expect(() => decompressMigration24Sql(['not-valid-base64-or-gzip'])).toThrowError(/MIGRATION_24_INTEGRITY_VIOLATION/);
  });

  // 149. Direct DB test: Malformed projection_json fails closed on read with PROJECTION_CORRUPTED
  it('149. Direct DB test: Malformed projection_json fails closed on read with PROJECTION_CORRUPTED', () => {
    const rawToken = `${REVIEWER_TOKEN_PREFIX}${crypto.randomUUID()}`;
    const tokenHash = computeSha256(rawToken);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    const malformedJson = '{invalid-json-content: true';
    const malformedHash = computeSha256(malformedJson);

    const adj = fixtures.repo.getCoderSubmissionAdjudicationById(fixtures.adjudicationId)!;

    // 1. Assert DB level CHECK constraint rejects non-JSON insertion
    expect(() => {
      fixtures.db.prepare(`
        INSERT INTO mcp_reviewer_sessions (
          id, adjudication_id, submission_id, reviewer_agent_id, reviewer_provider_id,
          reviewer_account_id, reviewer_resource_id, scope, token_hash, task_ownership_epoch,
          authority_snapshot_hash, verification_result_envelope_hash, projection_schema,
          projection_hash, projection_json, issued_at, expires_at, revoked_at, revocation_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL)
      `).run(
        crypto.randomUUID(), fixtures.adjudicationId, fixtures.submissionId, fixtures.reviewerAgentId,
        fixtures.reviewerProviderId, fixtures.reviewerAccountId, fixtures.reviewerResourceId,
        REVIEWER_TOKEN_SCOPE, tokenHash, adj.task_ownership_epoch, adj.authority_snapshot_hash,
        adj.verification_result_envelope_hash, malformedHash, malformedJson, now, expiresAt
      );
    }).toThrowError(/CHECK constraint failed.*projection_json/);

    // 2. Assert read-time service validation also fails closed on malformed projection_json
    const mockCorruptedSession: McpReviewerSession = {
      id: crypto.randomUUID(),
      adjudication_id: fixtures.adjudicationId,
      submission_id: fixtures.submissionId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
      scope: REVIEWER_TOKEN_SCOPE,
      token_hash: tokenHash,
      task_ownership_epoch: adj.task_ownership_epoch,
      authority_snapshot_hash: adj.authority_snapshot_hash,
      verification_result_envelope_hash: adj.verification_result_envelope_hash!,
      projection_schema: 1,
      projection_hash: malformedHash,
      projection_json: malformedJson,
      issued_at: now,
      expires_at: expiresAt,
      revoked_at: null,
      revocation_reason: null,
    };

    const initialChanges = (fixtures.db.prepare('SELECT total_changes() as c').get() as any).c;
    expect(() => {
      fixtures.service.getReviewPackage(mockCorruptedSession, fixtures.adjudicationId);
    }).toThrowError(/PROJECTION_CORRUPTED/);

    const finalChanges = (fixtures.db.prepare('SELECT total_changes() as c').get() as any).c;
    expect(finalChanges).toBe(initialChanges);
  });

  // 150. Direct DB test: Mismatched projection_hash fails closed on read with PROJECTION_HASH_MISMATCH
  it('150. Direct DB test: Mismatched projection_hash fails closed on read with PROJECTION_HASH_MISMATCH', () => {
    const rawToken = `${REVIEWER_TOKEN_PREFIX}${crypto.randomUUID()}`;
    const tokenHash = computeSha256(rawToken);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    const validJson = JSON.stringify({
      projection_schema_version: 1,
      adjudication: { id: fixtures.adjudicationId },
      evidence: { git_status: {}, git_diff: {} },
      disposition: { disposition_event: 'SETTLED', disposition_reason: 'ACCEPTED_VERIFIED' },
    });
    const mismatchedHash = 'a'.repeat(64);

    const adj = fixtures.repo.getCoderSubmissionAdjudicationById(fixtures.adjudicationId)!;

    const corruptedSessionId = crypto.randomUUID();
    fixtures.db.prepare(`
      INSERT INTO mcp_reviewer_sessions (
        id, adjudication_id, submission_id, reviewer_agent_id, reviewer_provider_id,
        reviewer_account_id, reviewer_resource_id, scope, token_hash, task_ownership_epoch,
        authority_snapshot_hash, verification_result_envelope_hash, projection_schema,
        projection_hash, projection_json, issued_at, expires_at, revoked_at, revocation_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL)
    `).run(
      corruptedSessionId, fixtures.adjudicationId, fixtures.submissionId, fixtures.reviewerAgentId,
      fixtures.reviewerProviderId, fixtures.reviewerAccountId, fixtures.reviewerResourceId,
      REVIEWER_TOKEN_SCOPE, tokenHash, adj.task_ownership_epoch, adj.authority_snapshot_hash,
      adj.verification_result_envelope_hash, mismatchedHash, validJson, now, expiresAt
    );

    const session = fixtures.repo.getMcpReviewerSessionById(corruptedSessionId)!;
    const initialChanges = (fixtures.db.prepare('SELECT total_changes() as c').get() as any).c;

    expect(() => {
      fixtures.service.getReviewPackage(session, fixtures.adjudicationId);
    }).toThrowError(/PROJECTION_HASH_MISMATCH/);

    const finalChanges = (fixtures.db.prepare('SELECT total_changes() as c').get() as any).c;
    expect(finalChanges).toBe(initialChanges);
  });

  // 151. Direct DB test: Unsupported projection_schema version fails closed on read with PROJECTION_SCHEMA_INVALID
  it('151. Direct DB test: Unsupported projection_schema version fails closed on read with PROJECTION_SCHEMA_INVALID', () => {
    const rawToken = `${REVIEWER_TOKEN_PREFIX}${crypto.randomUUID()}`;
    const tokenHash = computeSha256(rawToken);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    const validJson = JSON.stringify({
      projection_schema_version: 1,
      adjudication: { id: fixtures.adjudicationId },
      evidence: { git_status: {}, git_diff: {} },
      disposition: { disposition_event: 'SETTLED', disposition_reason: 'ACCEPTED_VERIFIED' },
    });
    const validHash = computeSha256(validJson);

    const adj = fixtures.repo.getCoderSubmissionAdjudicationById(fixtures.adjudicationId)!;

    // 1. Assert DB level CHECK constraint rejects projection_schema != 1
    expect(() => {
      fixtures.db.prepare(`
        INSERT INTO mcp_reviewer_sessions (
          id, adjudication_id, submission_id, reviewer_agent_id, reviewer_provider_id,
          reviewer_account_id, reviewer_resource_id, scope, token_hash, task_ownership_epoch,
          authority_snapshot_hash, verification_result_envelope_hash, projection_schema,
          projection_hash, projection_json, issued_at, expires_at, revoked_at, revocation_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?, NULL, NULL)
      `).run(
        crypto.randomUUID(), fixtures.adjudicationId, fixtures.submissionId, fixtures.reviewerAgentId,
        fixtures.reviewerProviderId, fixtures.reviewerAccountId, fixtures.reviewerResourceId,
        REVIEWER_TOKEN_SCOPE, tokenHash, adj.task_ownership_epoch, adj.authority_snapshot_hash,
        adj.verification_result_envelope_hash, validHash, validJson, now, expiresAt
      );
    }).toThrowError(/CHECK constraint failed.*projection_schema/);

    // 2. Assert read-time service validation also fails closed on unsupported schema
    const mockUnsupportedSchemaSession: McpReviewerSession = {
      id: crypto.randomUUID(),
      adjudication_id: fixtures.adjudicationId,
      submission_id: fixtures.submissionId,
      reviewer_agent_id: fixtures.reviewerAgentId,
      reviewer_provider_id: fixtures.reviewerProviderId,
      reviewer_account_id: fixtures.reviewerAccountId,
      reviewer_resource_id: fixtures.reviewerResourceId,
      scope: REVIEWER_TOKEN_SCOPE,
      token_hash: tokenHash,
      task_ownership_epoch: adj.task_ownership_epoch,
      authority_snapshot_hash: adj.authority_snapshot_hash,
      verification_result_envelope_hash: adj.verification_result_envelope_hash!,
      projection_schema: 2,
      projection_hash: validHash,
      projection_json: validJson,
      issued_at: now,
      expires_at: expiresAt,
      revoked_at: null,
      revocation_reason: null,
    };

    const initialChanges = (fixtures.db.prepare('SELECT total_changes() as c').get() as any).c;
    expect(() => {
      fixtures.service.getReviewPackage(mockUnsupportedSchemaSession, fixtures.adjudicationId);
    }).toThrowError(/PROJECTION_SCHEMA_INVALID/);

    const finalChanges = (fixtures.db.prepare('SELECT total_changes() as c').get() as any).c;
    expect(finalChanges).toBe(initialChanges);
  });

  // 152. Direct DB test: Oversized projection_json payload (>512 KiB) fails closed on read with PROJECTION_PAYLOAD_TOO_LARGE
  it('152. Direct DB test: Oversized projection_json payload (>512 KiB) fails closed on read with PROJECTION_PAYLOAD_TOO_LARGE', () => {
    const rawToken = `${REVIEWER_TOKEN_PREFIX}${crypto.randomUUID()}`;
    const tokenHash = computeSha256(rawToken);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    const oversizedJson = JSON.stringify({
      projection_schema_version: 1,
      adjudication: { id: fixtures.adjudicationId },
      evidence: { git_status: {}, git_diff: { diff_content: 'x'.repeat(PROJECTION_PAYLOAD_MAX_UTF8_BYTES + 1024) } },
      disposition: { disposition_event: 'SETTLED', disposition_reason: 'ACCEPTED_VERIFIED' },
    });
    const oversizedHash = computeSha256(oversizedJson);

    const adj = fixtures.repo.getCoderSubmissionAdjudicationById(fixtures.adjudicationId)!;

    const corruptedSessionId = crypto.randomUUID();
    fixtures.db.prepare(`
      INSERT INTO mcp_reviewer_sessions (
        id, adjudication_id, submission_id, reviewer_agent_id, reviewer_provider_id,
        reviewer_account_id, reviewer_resource_id, scope, token_hash, task_ownership_epoch,
        authority_snapshot_hash, verification_result_envelope_hash, projection_schema,
        projection_hash, projection_json, issued_at, expires_at, revoked_at, revocation_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL)
    `).run(
      corruptedSessionId, fixtures.adjudicationId, fixtures.submissionId, fixtures.reviewerAgentId,
      fixtures.reviewerProviderId, fixtures.reviewerAccountId, fixtures.reviewerResourceId,
      REVIEWER_TOKEN_SCOPE, tokenHash, adj.task_ownership_epoch, adj.authority_snapshot_hash,
      adj.verification_result_envelope_hash, oversizedHash, oversizedJson, now, expiresAt
    );

    const session = fixtures.repo.getMcpReviewerSessionById(corruptedSessionId)!;
    const initialChanges = (fixtures.db.prepare('SELECT total_changes() as c').get() as any).c;

    expect(() => {
      fixtures.service.getReviewPackage(session, fixtures.adjudicationId);
    }).toThrowError(/PROJECTION_PAYLOAD_TOO_LARGE/);

    const finalChanges = (fixtures.db.prepare('SELECT total_changes() as c').get() as any).c;
    expect(finalChanges).toBe(initialChanges);
  });

  // 153. Direct DB test: Corrupted bounded projection object structure fails closed on read
  it('153. Direct DB test: Corrupted bounded projection object structure fails closed on read', () => {
    const rawToken = `${REVIEWER_TOKEN_PREFIX}${crypto.randomUUID()}`;
    const tokenHash = computeSha256(rawToken);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    const missingEvidenceJson = JSON.stringify({
      projection_schema_version: 1,
      adjudication: { id: fixtures.adjudicationId },
      // evidence missing
      disposition: { disposition_event: 'SETTLED', disposition_reason: 'ACCEPTED_VERIFIED' },
    });
    const missingHash = computeSha256(missingEvidenceJson);

    const adj = fixtures.repo.getCoderSubmissionAdjudicationById(fixtures.adjudicationId)!;

    const corruptedSessionId = crypto.randomUUID();
    fixtures.db.prepare(`
      INSERT INTO mcp_reviewer_sessions (
        id, adjudication_id, submission_id, reviewer_agent_id, reviewer_provider_id,
        reviewer_account_id, reviewer_resource_id, scope, token_hash, task_ownership_epoch,
        authority_snapshot_hash, verification_result_envelope_hash, projection_schema,
        projection_hash, projection_json, issued_at, expires_at, revoked_at, revocation_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL)
    `).run(
      corruptedSessionId, fixtures.adjudicationId, fixtures.submissionId, fixtures.reviewerAgentId,
      fixtures.reviewerProviderId, fixtures.reviewerAccountId, fixtures.reviewerResourceId,
      REVIEWER_TOKEN_SCOPE, tokenHash, adj.task_ownership_epoch, adj.authority_snapshot_hash,
      adj.verification_result_envelope_hash, missingHash, missingEvidenceJson, now, expiresAt
    );

    const session = fixtures.repo.getMcpReviewerSessionById(corruptedSessionId)!;
    const initialChanges = (fixtures.db.prepare('SELECT total_changes() as c').get() as any).c;

    expect(() => {
      fixtures.service.getReviewPackage(session, fixtures.adjudicationId);
    }).toThrowError(/PROJECTION_CORRUPTED/);

    const finalChanges = (fixtures.db.prepare('SELECT total_changes() as c').get() as any).c;
    expect(finalChanges).toBe(initialChanges);
  });

});
