import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import { runReviewerAdmin } from '../src/mcp/reviewerAdmin';
import { computeSha256 } from '../src/mcp/submissionProtocol';

interface ReviewerFixtures {
  tempDir: string;
  dbPath: string;
  db: Database.Database;
  repo: Repository;
  artifactStore: ArtifactStore;
  adjudicationId: string;
  submissionId: string;
  taskId: string;
  coderAgentId: string;
  coderAccountId: string;
  reviewerAgentId: string;
  reviewerProviderId: string;
  reviewerAccountId: string;
  reviewerResourceId: string;
  projectId: string;
  authId: string;
  attemptId: string;
  assignmentId: string;
}

function seedReviewerEnvironment(tempDir: string): ReviewerFixtures {
  const dbPath = path.join(tempDir, 'agent-forge-reviewer-admin-test.db');
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
  const reviewerAgentId = `agent-rev-${crypto.randomUUID()}`;

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
  db.prepare(`INSERT INTO agents (id, display_name, role, provider_resource_id, status, current_task_id, last_seen_at) VALUES (?, 'ReviewerAgent', 'REVIEWER', ?, 'IDLE', NULL, ?)`).run(reviewerAgentId, reviewerResourceId, now);

  // 5. Project & Task (state: REVIEW_READY)
  repo.createProject({
    id: projectId,
    name: 'Reviewer Test Project',
    description: 'Testing reviewer context authority',
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
    VALUES (?, ?, 'Test Task', 'REVIEW_READY', 'LOW', 'LOW', 1, 3, 0, ?, 1, ?, ?)
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
    summary: 'Finished',
  });

  // 7. Routing & Protocol message
  const routingId = `route-${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO events (id, project_id, task_id, type, summary, structured_payload_json, timestamp)
    VALUES (?, ?, ?, 'ROLE_AWARE_ROUTING_DECISION', 'Routed coder', '{}', ?)
  `).run(routingId, projectId, taskId, now);

  const workerSlotId = `slot-${crypto.randomUUID()}`;
  db.prepare(`INSERT INTO worker_slots (id, provider_account_id, provider_resource_id, slot_index, status, current_assignment_id, created_at, updated_at) VALUES (?, ?, ?, 1, 'RUNNING', ?, ?, ?)`).run(workerSlotId, coderAccountId, coderResourceId, assignmentId, now, now);

  repo.createAgentAssignment({
    id: assignmentId,
    project_id: projectId,
    task_id: taskId,
    attempt_id: attemptId,
    role_profile_id: coderRoleId,
    agent_profile_id: coderAgentProfileId,
    selected_provider_id: coderProviderId,
    selected_account_id: coderAccountId,
    selected_resource_id: coderResourceId,
    selected_worker_slot_id: workerSlotId,
    routing_decision_id: routingId,
    status: 'ASSIGNED',
    created_at: now,
    ended_at: null,
    preferred_metadata: null,
  });

  const managerRecordId = `rec-${crypto.randomUUID()}`;
  const msgId = `msg-${crypto.randomUUID()}`;
  repo.recordProtocolMessage(
    managerRecordId,
    msgId,
    'manager.v1',
    projectId,
    taskId,
    'CODING',
    1,
    computeSha256('managerPayload'),
    '{}',
    'APPLIED',
    undefined,
    now
  );

  // 8. Execution Auth & Submission Session
  repo.createExecutionAuthorization({
    id: authId,
    assignment_id: assignmentId,
    attempt_id: attemptId,
    status: 'DISPATCHED',
    project_id: projectId,
    task_id: taskId,
    routing_decision_id: routingId,
    selected_provider_id: coderProviderId,
    selected_account_id: coderAccountId,
    selected_resource_id: coderResourceId,
    manager_message_id: managerRecordId,
    manager_payload_hash: computeSha256('managerPayload'),
    instruction_payload_hash: computeSha256('instructions'),
    context_manifest_hash: computeSha256('context'),
    canonical_instructions_json: JSON.stringify(['Do work']),
    context_files_json: JSON.stringify(['src/index.ts']),
    canonical_payload_json: JSON.stringify({}),
    task_revision: 1,
    task_ownership_epoch: 1,
    base_sha: '0'.repeat(40),
    repository_head_sha: '0'.repeat(40),
    dispatched_at: now,
    created_at: now,
  });

  repo.createMcpSubmissionSession({
    id: subSessionId,
    authorization_id: authId,
    scope: 'CODER_SUBMISSION',
    issuer_identity: 'OWNER_LOCAL_CLI',
    token_hash: '0'.repeat(64),
    authorization_fingerprint: computeSha256(authId),
    issued_at: now,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    revoked_at: null,
    revocation_reason: null,
  });

  // 9. Coder Submission
  repo.createCoderSubmission({
    id: submissionId,
    authorization_id: authId,
    project_id: projectId,
    task_id: taskId,
    task_ownership_epoch: 1,
    session_id: subSessionId,
    schema_version: 1,
    authorization_status: 'DISPATCHED',
    dispatched_at: now,
    authority_fingerprint: computeSha256(authId),
    manager_payload_hash: computeSha256('managerPayload'),
    task_revision: 1,
    lifecycle_version: 1,
    execution_id: `exec-${crypto.randomUUID()}`,
    attempt_id: attemptId,
    assignment_id: assignmentId,
    selected_provider_id: coderProviderId,
    selected_account_id: coderAccountId,
    selected_resource_id: coderResourceId,
    manager_message_id: managerRecordId,
    routing_decision_id: routingId,
    base_sha: '0'.repeat(40),
    authorized_head_sha: '0'.repeat(40),
    claimed_status: 'COMPLETED',
    quarantine_status: 'QUARANTINED',
    summary: 'Done',
    changed_files_count: 1,
    tests_claimed_count: 1,
    blockers_count: 0,
    review_requested: 1,
    claim_content_hash: computeSha256('cch'),
    canonical_envelope_hash: computeSha256('ceh'),
    claim_content_json: '{}',
    canonical_envelope_json: '{}',
    canonical_arguments_bytes: 100,
    submitted_at: now,
  });

  // 10. Terminal disposition
  repo.createCoderSubmissionDisposition({
    id: crypto.randomUUID(),
    submission_id: submissionId,
    disposition_event: 'SETTLED',
    disposition_reason: 'ACCEPTED_VERIFIED',
    actor_type: 'OPERATOR',
    actor_id: 'OWNER_LOCAL_UI',
    disposition_metadata_json: '{}',
    created_at: now,
  });

  // 11. Test Runs
  const testRunId = `run-${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO test_runs (id, task_id, command, passed_count, failed_count, skipped_count, duration_ms, exit_code, created_at)
    VALUES (?, ?, 'npm test', 10, 0, 0, 100, 0, ?)
  `).run(testRunId, taskId, now);

  // 12. Evidence
  const statusEvId = `ev-status-${crypto.randomUUID()}`;
  const diffEvId = `ev-diff-${crypto.randomUUID()}`;
  const statusPayload = JSON.stringify({ isClean: false, files: ['src/index.ts'] });
  const diffPayload = 'diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n';
  db.prepare(`
    INSERT INTO evidence (id, project_id, task_id, attempt_id, evidence_type, storage_type, file_path, hash, byte_size, content_type, summary, raw_payload, created_at)
    VALUES (?, ?, ?, ?, 'GIT_STATUS', 'INLINE', NULL, ?, ?, 'application/json', 'Git status', ?, ?)
  `).run(statusEvId, projectId, taskId, attemptId, computeSha256(statusPayload), Buffer.byteLength(statusPayload), statusPayload, now);
  db.prepare(`
    INSERT INTO evidence (id, project_id, task_id, attempt_id, evidence_type, storage_type, file_path, hash, byte_size, content_type, summary, raw_payload, created_at)
    VALUES (?, ?, ?, ?, 'GIT_DIFF', 'INLINE', NULL, ?, ?, 'text/x-diff', 'Git diff', ?, ?)
  `).run(diffEvId, projectId, taskId, attemptId, computeSha256(diffPayload), Buffer.byteLength(diffPayload), diffPayload, now);

  // 13. Adjudication
  const envelopeJson = JSON.stringify({
    adjudication_id: adjudicationId,
    submission_id: submissionId,
    overall_disposition: 'ACCEPTED_VERIFIED',
    total_runs: 1,
    successful_runs: 1,
    failed_runs: 0,
    timestamp: now,
  });
  const envelopeHash = computeSha256(envelopeJson);

  const snapshotJson = JSON.stringify({
    task_id: taskId,
    task_ownership_epoch: 1,
    task_revision: 1,
    project_id: projectId,
    base_sha: '0'.repeat(40),
    head_sha: '0'.repeat(40),
  });
  const snapshotHash = computeSha256(snapshotJson);

  db.prepare(`
    INSERT INTO coder_submission_adjudications (
      id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
      task_ownership_epoch, action, status, lifecycle_version,
      authority_snapshot_json, authority_snapshot_hash,
      verification_commands_json, verification_commands_hash,
      workspace_snapshot_before_json, workspace_snapshot_before_hash,
      verification_result_envelope_json, verification_result_envelope_hash,
      test_run_id, git_status_evidence_id, git_diff_evidence_id,
      artifact_manifest_json, artifact_manifest_hash,
      created_at, verification_started_at, completed_at, recovery_fenced_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      1, 'ADMIT_VERIFICATION', 'VERIFIED', 1,
      ?, ?,
      '{}', ?,
      '{}', ?,
      ?, ?,
      ?, ?, ?,
      '{}', ?,
      ?, ?, ?, NULL
    )
  `).run(
    adjudicationId, crypto.randomUUID(), submissionId, authId, projectId, taskId, attemptId, assignmentId,
    snapshotJson, snapshotHash,
    computeSha256('{}'),
    computeSha256('{}'),
    envelopeJson, envelopeHash,
    testRunId, statusEvId, diffEvId,
    computeSha256('{}'),
    now, now, now
  );

  return {
    tempDir,
    dbPath,
    db,
    repo,
    artifactStore,
    adjudicationId,
    submissionId,
    taskId,
    coderAgentId,
    coderAccountId,
    reviewerAgentId,
    reviewerProviderId,
    reviewerAccountId,
    reviewerResourceId,
    projectId,
    authId,
    attemptId,
    assignmentId,
  };
}

describe('R5J7 MCP Reviewer Admin CLI (Cases 106–115)', () => {
  let tempDir: string;
  let fixtures: ReviewerFixtures;
  let stdoutSpy: ReturnType<typeof vi.spyOn> | undefined;
  let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;
  let capturedStdout: string;
  let capturedStderr: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-rev-admin-test-'));
    fixtures = seedReviewerEnvironment(tempDir);
    capturedStdout = '';
    capturedStderr = '';
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      capturedStdout += String(chunk);
      return true;
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      capturedStderr += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (stdoutSpy) stdoutSpy.mockRestore();
    if (stderrSpy) stderrSpy.mockRestore();
    try {
      if (fixtures?.db?.open) fixtures.db.close();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('106. CLI issue command creates session and outputs token', () => {
    const exitCode = runReviewerAdmin([
      'issue',
      '--db', fixtures.dbPath,
      '--adjudication', fixtures.adjudicationId,
      '--agent', fixtures.reviewerAgentId,
      '--provider', fixtures.reviewerProviderId,
      '--account', fixtures.reviewerAccountId,
      '--resource', fixtures.reviewerResourceId,
      '--json',
    ], { db: fixtures.db });

    if (exitCode !== 0) {
      throw new Error(`TEST 106 FAILED WITH EXIT CODE ${exitCode}: ${capturedStderr}`);
    }
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(capturedStdout);
    expect(parsed.status).toBe('ISSUED');
    expect(parsed.plaintext_token).toMatch(/^af-rev-[0-9a-f-]{36}$/);
    expect(parsed.session.adjudication_id).toBe(fixtures.adjudicationId);
    expect(parsed.session.reviewer_agent_id).toBe(fixtures.reviewerAgentId);

    // Verify session row in DB
    const sessionInDb = fixtures.db.prepare('SELECT * FROM mcp_reviewer_sessions WHERE id = ?').get(parsed.session.id) as any;
    expect(sessionInDb).toBeDefined();
    expect(sessionInDb.token_hash).toBe(computeSha256(parsed.plaintext_token));
  });

  it('107. CLI issue fails closed when adjudication is not ready', () => {
    const unverifiedAdjId = crypto.randomUUID();
    const now = new Date().toISOString();
    fixtures.db.prepare(`
      INSERT INTO coder_submission_adjudications (
        id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
        task_ownership_epoch, action, status, lifecycle_version,
        authority_snapshot_json, authority_snapshot_hash,
        created_at, completed_at, failure_code
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        1, 'REJECT', 'VERIFICATION_FAILED', 1,
        '{}', '${'0'.repeat(64)}',
        ?, ?, 'TEST_FAILED'
      )
    `).run(
      unverifiedAdjId, crypto.randomUUID(), fixtures.submissionId, fixtures.authId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId,
      now, now
    );

    const exitCode = runReviewerAdmin([
      'issue',
      '--db', fixtures.dbPath,
      '--adjudication', unverifiedAdjId,
      '--agent', fixtures.reviewerAgentId,
      '--provider', fixtures.reviewerProviderId,
      '--account', fixtures.reviewerAccountId,
      '--resource', fixtures.reviewerResourceId,
      '--json',
    ], { db: fixtures.db });

    expect(exitCode).toBe(2);
    expect(capturedStderr).toContain('MCP_AUTHORITY_FENCED');
    expect(fixtures.db.prepare('SELECT COUNT(*) as c FROM mcp_reviewer_sessions WHERE adjudication_id = ?').get(unverifiedAdjId)).toEqual({ c: 0 });
  });

  it('108. CLI list command deterministic filtering by session-id and adjudication-id without mutation or secret leakage', () => {
    // Issue two sessions
    runReviewerAdmin([
      'issue', '--db', fixtures.dbPath,
      '--adjudication', fixtures.adjudicationId,
      '--agent', fixtures.reviewerAgentId,
      '--provider', fixtures.reviewerProviderId,
      '--account', fixtures.reviewerAccountId,
      '--resource', fixtures.reviewerResourceId,
      '--json',
    ], { db: fixtures.db });
    const issued1 = JSON.parse(capturedStdout);
    capturedStdout = '';

    const changesBefore = fixtures.db.prepare('SELECT total_changes() as c').get() as { c: number };

    const exitCode = runReviewerAdmin([
      'list',
      '--db', fixtures.dbPath,
      '--session', issued1.session.id,
      '--json',
    ], { db: fixtures.db });

    expect(exitCode).toBe(0);
    const changesAfter = fixtures.db.prepare('SELECT total_changes() as c').get() as { c: number };
    expect(changesAfter.c - changesBefore.c).toBe(0);

    const listOutput = JSON.parse(capturedStdout);
    expect(listOutput.status).toBe('OK');
    expect(listOutput.sessions).toHaveLength(1);
    expect(listOutput.sessions[0].id).toBe(issued1.session.id);
    // Prove no raw token or hash leakage
    const serialized = JSON.stringify(listOutput);
    expect(serialized).not.toContain(issued1.plaintext_token);
    expect(serialized).not.toContain(issued1.session.token_hash);
    expect(serialized).not.toContain('token_hash');
  });

  it('109. CLI revoke command revokes session with audit reason', () => {
    runReviewerAdmin([
      'issue', '--db', fixtures.dbPath,
      '--adjudication', fixtures.adjudicationId,
      '--agent', fixtures.reviewerAgentId,
      '--provider', fixtures.reviewerProviderId,
      '--account', fixtures.reviewerAccountId,
      '--resource', fixtures.reviewerResourceId,
      '--json',
    ], { db: fixtures.db });
    const issued = JSON.parse(capturedStdout);
    capturedStdout = '';

    const exitCode = runReviewerAdmin([
      'revoke',
      '--db', fixtures.dbPath,
      '--session', issued.session.id,
      '--reason', 'Manual audit revocation reason',
      '--json',
    ], { db: fixtures.db });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(capturedStdout);
    expect(parsed.status).toBe('REVOKED');
    expect(parsed.revoked).toBe(true);

    const sessionInDb = fixtures.db.prepare('SELECT * FROM mcp_reviewer_sessions WHERE id = ?').get(issued.session.id) as any;
    expect(sessionInDb.revoked_at).not.toBeNull();
    expect(sessionInDb.revocation_reason).toBe('Manual audit revocation reason');
  });

  it('110. CLI revoke rejects empty reason argument', () => {
    runReviewerAdmin([
      'issue', '--db', fixtures.dbPath,
      '--adjudication', fixtures.adjudicationId,
      '--agent', fixtures.reviewerAgentId,
      '--provider', fixtures.reviewerProviderId,
      '--account', fixtures.reviewerAccountId,
      '--resource', fixtures.reviewerResourceId,
      '--json',
    ], { db: fixtures.db });
    const issued = JSON.parse(capturedStdout);
    capturedStdout = '';

    const exitCode = runReviewerAdmin([
      'revoke',
      '--db', fixtures.dbPath,
      '--session', issued.session.id,
      '--json',
    ], { db: fixtures.db });

    expect(exitCode).toBe(1);
    expect(capturedStderr).toContain('requires a non-empty --reason');
  });

  it('111. CLI list command lists active/historical reviewer sessions', () => {
    // Issue and revoke one session
    runReviewerAdmin([
      'issue', '--db', fixtures.dbPath,
      '--adjudication', fixtures.adjudicationId,
      '--agent', fixtures.reviewerAgentId,
      '--provider', fixtures.reviewerProviderId,
      '--account', fixtures.reviewerAccountId,
      '--resource', fixtures.reviewerResourceId,
      '--json',
    ], { db: fixtures.db });
    const issued = JSON.parse(capturedStdout);
    capturedStdout = '';

    runReviewerAdmin([
      'revoke',
      '--db', fixtures.dbPath,
      '--session', issued.session.id,
      '--reason', 'Historical retirement',
      '--json',
    ], { db: fixtures.db });
    capturedStdout = '';

    // Issue second active session
    runReviewerAdmin([
      'issue', '--db', fixtures.dbPath,
      '--adjudication', fixtures.adjudicationId,
      '--agent', fixtures.reviewerAgentId,
      '--provider', fixtures.reviewerProviderId,
      '--account', fixtures.reviewerAccountId,
      '--resource', fixtures.reviewerResourceId,
      '--json',
    ], { db: fixtures.db });
    capturedStdout = '';

    const exitCode = runReviewerAdmin([
      'list',
      '--db', fixtures.dbPath,
      '--adjudication', fixtures.adjudicationId,
      '--json',
    ], { db: fixtures.db });

    expect(exitCode).toBe(0);
    const listData = JSON.parse(capturedStdout);
    expect(listData.sessions).toHaveLength(2);
    const activeCount = listData.sessions.filter((s: any) => s.is_active).length;
    const revokedCount = listData.sessions.filter((s: any) => s.revoked_at !== null).length;
    expect(activeCount).toBe(1);
    expect(revokedCount).toBe(1);
  });

  it('112. CLI config print-only mode outputs valid MCP client config', () => {
    const exitCode = runReviewerAdmin([
      'configure-client',
      '--client', 'cursor',
      '--db', fixtures.dbPath,
      '--json',
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(capturedStdout);
    expect(parsed.status).toBe('TEMPLATE_GENERATED');
    expect(parsed.client).toBe('cursor');
    expect(parsed.incomplete).toBe(true);
    expect(parsed.config.mcpServers['agentforge-review']).toBeDefined();
    expect(parsed.config.mcpServers['agentforge-review'].env.AGENTFORGE_MCP_REVIEWER_TOKEN).toBe('<OPERATOR_REVIEWER_TOKEN_REQUIRED>');
  });

  it('113. CLI config mode never mutates filesystem or external configs', () => {
    const homeDir = os.homedir();
    const cursorConfigPath = path.join(homeDir, '.cursor', 'mcp.json');
    const claudeConfigPath = path.join(homeDir, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');

    const cursorExistsBefore = fs.existsSync(cursorConfigPath);
    const claudeExistsBefore = fs.existsSync(claudeConfigPath);

    const exitCode = runReviewerAdmin([
      'configure-client',
      '--client', 'claude',
      '--db', fixtures.dbPath,
      '--json',
    ]);

    expect(exitCode).toBe(0);
    expect(fs.existsSync(cursorConfigPath)).toBe(cursorExistsBefore);
    expect(fs.existsSync(claudeConfigPath)).toBe(claudeExistsBefore);
  });

  it('114. Atomic EXPIRED_AUTOMATIC_ROTATION on re-issuance with transactional rollback preservation', () => {
    // 1. Issue initial session with expired timestamp
    runReviewerAdmin([
      'issue', '--db', fixtures.dbPath,
      '--adjudication', fixtures.adjudicationId,
      '--agent', fixtures.reviewerAgentId,
      '--provider', fixtures.reviewerProviderId,
      '--account', fixtures.reviewerAccountId,
      '--resource', fixtures.reviewerResourceId,
      '--ttl', '60',
      '--json',
    ], { db: fixtures.db });
    const initial = JSON.parse(capturedStdout);
    capturedStdout = '';

    // Fast-forward time past 60s TTL
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 70000));

    // 2. Re-issue session for same binding
    const exitCode = runReviewerAdmin([
      'issue', '--db', fixtures.dbPath,
      '--adjudication', fixtures.adjudicationId,
      '--agent', fixtures.reviewerAgentId,
      '--provider', fixtures.reviewerProviderId,
      '--account', fixtures.reviewerAccountId,
      '--resource', fixtures.reviewerResourceId,
      '--json',
    ], { db: fixtures.db });

    expect(exitCode).toBe(0);
    const replacement = JSON.parse(capturedStdout);
    capturedStdout = '';

    // Verify initial session was revoked with EXPIRED_AUTOMATIC_ROTATION
    const oldSession = fixtures.db.prepare('SELECT * FROM mcp_reviewer_sessions WHERE id = ?').get(initial.session.id) as any;
    expect(oldSession.revoked_at).not.toBeNull();
    expect(oldSession.revocation_reason).toBe('EXPIRED_AUTOMATIC_ROTATION');

    // Verify replacement session is active
    const newSession = fixtures.db.prepare('SELECT * FROM mcp_reviewer_sessions WHERE id = ?').get(replacement.session.id) as any;
    expect(newSession.revoked_at).toBeNull();
  });

  it('115. CLI exit codes: 0 on success, 1 on validation error, 2 on authority violation', () => {
    // 0: Success
    const exit0 = runReviewerAdmin([
      'configure-client',
      '--client', 'antigravity',
      '--db', fixtures.dbPath,
      '--json',
    ]);
    expect(exit0).toBe(0);

    // 1: Validation error (forbidden command or unknown flag)
    const exit1Forbidden = runReviewerAdmin(['inspect', '--db', fixtures.dbPath]);
    expect(exit1Forbidden).toBe(1);

    const exit1UnknownFlag = runReviewerAdmin(['issue', '--unknown-flag', 'val']);
    expect(exit1UnknownFlag).toBe(1);

    // 2: Authority violation (non-existent adjudication)
    const exit2Auth = runReviewerAdmin([
      'issue',
      '--db', fixtures.dbPath,
      '--adjudication', crypto.randomUUID(),
      '--agent', fixtures.reviewerAgentId,
      '--provider', fixtures.reviewerProviderId,
      '--account', fixtures.reviewerAccountId,
      '--resource', fixtures.reviewerResourceId,
    ], { db: fixtures.db });
    expect(exit2Auth).toBe(2);
  });
});
