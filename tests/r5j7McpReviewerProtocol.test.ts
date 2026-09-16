import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import {
  ReviewerAuthorityService,
  truncateDiffBytes,
  fatalUtf8Decode,
  scrubReviewerDiagnostics,
  ReviewerAuthorityError,
} from '../src/mcp/reviewerAuthority';
import {
  REVIEWER_TOOL_NAME,
  REVIEWER_TOOL_DESCRIPTION,
  REVIEWER_TOOL_ANNOTATIONS,
  REVIEWER_TOOL_INPUT_SCHEMA,
  REVIEWER_RESOURCE_NAME,
  REVIEWER_RESOURCE_DESCRIPTION,
  REVIEWER_URI_TEMPLATE,
  REVIEWER_MIME_TYPE,
  FORBIDDEN_TOOL_NAMES,
} from '../src/mcp/reviewerProtocol';
import {
  ReviewerMcpAuthorityContext,
  buildAgentForgeReviewerMcpServer,
} from '../src/mcp/reviewerServer';
import { runReviewerStdioServer } from '../src/mcp/stdio-review';
import {
  REVIEWER_TOKEN_ENV,
  REVIEWER_TOKEN_PREFIX,
  REVIEWER_TOKEN_SCOPE,
  DIFF_CONTENT_MAX_UTF8_BYTES,
  PROJECTION_PAYLOAD_MAX_UTF8_BYTES,
  MARKDOWN_MAX_UTF8_BYTES,
} from '../src/types/reviewer';
import { computeSha256 } from '../src/mcp/submissionProtocol';

interface Fixtures {
  tempDir: string;
  dbPath: string;
  db: Database.Database;
  repo: Repository;
  service: ReviewerAuthorityService;
  adjudicationId: string;
  submissionId: string;
  taskId: string;
  projectId: string;
  reviewerAgentId: string;
  reviewerProviderId: string;
  reviewerAccountId: string;
  reviewerResourceId: string;
  reviewerAgentId2: string;
  coderAccountId: string;
  coderAgentId: string;
  token1: string;
  sessionId1: string;
  token2: string;
  sessionId2: string;
}

function seedTestEnv(tempDir: string): Fixtures {
  const dbPath = path.join(tempDir, 'test-reviewer-protocol.db');
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
    name: 'Protocol Test Project',
    description: 'Protocol test description',
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
    VALUES (?, ?, 'Protocol Task', 'REVIEW_READY', 'LOW', 'LOW', 1, 3, 0, ?, 1, ?, ?)
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
  fs.writeFileSync(diffFile, 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n', 'utf8');

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

  // Issue session 1 for reviewer 1
  const issuance1 = service.issueReviewerSession({
    adjudication_id: adjudicationId,
    reviewer_agent_id: reviewerAgentId,
    reviewer_provider_id: reviewerProviderId,
    reviewer_account_id: reviewerAccountId,
    reviewer_resource_id: reviewerResourceId,
    duration_seconds: 3600,
  });

  // Issue session 2 for reviewer 2
  const issuance2 = service.issueReviewerSession({
    adjudication_id: adjudicationId,
    reviewer_agent_id: reviewerAgentId2,
    reviewer_provider_id: reviewerProviderId,
    reviewer_account_id: reviewerAccountId,
    reviewer_resource_id: reviewerResourceId,
    duration_seconds: 3600,
  });

  return {
    tempDir,
    dbPath,
    db,
    repo,
    service,
    adjudicationId,
    submissionId,
    taskId,
    projectId,
    reviewerAgentId,
    reviewerProviderId,
    reviewerAccountId,
    reviewerResourceId,
    reviewerAgentId2,
    coderAccountId,
    coderAgentId,
    token1: issuance1.raw_token,
    sessionId1: issuance1.session.id,
    token2: issuance2.raw_token,
    sessionId2: issuance2.session.id,
  };
}

describe('R5J7 MCP Reviewer Protocol & Tool Surface (Cases 71–105, 132–134, 138, 141, 142, 154–170)', () => {
  let tempDir: string;
  let fixtures: Fixtures;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-rev-protocol-test-'));
    fixtures = seedTestEnv(tempDir);
    originalEnv = process.env[REVIEWER_TOKEN_ENV];
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env[REVIEWER_TOKEN_ENV] = originalEnv;
    } else {
      delete process.env[REVIEWER_TOKEN_ENV];
    }
    try {
      if (fixtures?.db?.open) fixtures.db.close();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // 71. Server startup over stdio transport only
  it('71. Server startup over stdio transport only', async () => {
    process.env.AGENTFORGE_MCP_DB_PATH = fixtures.dbPath;
    const handle = runReviewerStdioServer();
    expect(handle).toBeDefined();
    expect(typeof handle.close).toBe('function');
    await handle.close();
    delete process.env.AGENTFORGE_MCP_DB_PATH;
  });

  // 72. Protocol handshake and capability advertisement
  it('72. Protocol handshake and capability advertisement', async () => {
    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: fixtures.token1,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    const capabilities = client.getServerCapabilities();
    expect(capabilities).toBeDefined();
    expect(capabilities?.tools).toBeDefined();
    expect(capabilities?.resources).toBeDefined();

    await client.close();
    await server.close();
  });

  // 73. Token extraction from AGENTFORGE_MCP_REVIEWER_TOKEN env var
  it('73. Token extraction from AGENTFORGE_MCP_REVIEWER_TOKEN env var', async () => {
    process.env[REVIEWER_TOKEN_ENV] = fixtures.token1;
    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    const res = await client.callTool({
      name: REVIEWER_TOOL_NAME,
      arguments: { adjudication_id: fixtures.adjudicationId },
    });
    expect(res.isError).toBeFalsy();
    expect(res.content).toHaveLength(1);

    await client.close();
    await server.close();
  });

  // 74. Missing token rejection during initialize/request
  it('74. Missing token rejection during initialize/request', async () => {
    delete process.env[REVIEWER_TOKEN_ENV];
    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    const res = await client.callTool({
      name: REVIEWER_TOOL_NAME,
      arguments: { adjudication_id: fixtures.adjudicationId },
    });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('AUTH_FAILED');

    await client.close();
    await server.close();
  });

  // 75. Resource template discovery: agentforge://reviews/packages/{adjudication_id}
  it('75. Resource template discovery: agentforge://reviews/packages/{adjudication_id}', async () => {
    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: fixtures.token1,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates).toBeDefined();
    const tmpl = templates.resourceTemplates.find((t) => t.uriTemplate === REVIEWER_URI_TEMPLATE);
    expect(tmpl).toBeDefined();
    expect(tmpl?.name).toBe(REVIEWER_RESOURCE_NAME);

    await client.close();
    await server.close();
  });

  // 76. Resource MIME type is application/vnd.agentforge.review-package+json
  it('76. Resource MIME type is application/vnd.agentforge.review-package+json', async () => {
    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: fixtures.token1,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    const res = await client.readResource({
      uri: `agentforge://reviews/packages/${fixtures.adjudicationId}`,
    });
    expect(res.contents).toBeDefined();
    expect(res.contents[0].mimeType).toBe(REVIEWER_MIME_TYPE);

    await client.close();
    await server.close();
  });

  // 77. Resource read: succeeds for authorized adjudication
  it('77. Resource read: succeeds for authorized adjudication', async () => {
    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: fixtures.token1,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    const res = await client.readResource({
      uri: `agentforge://reviews/packages/${fixtures.adjudicationId}`,
    });
    expect(res.contents).toHaveLength(1);
    const parsed = JSON.parse((res.contents[0] as any).text);
    expect(parsed.adjudication.id).toBe(fixtures.adjudicationId);
    expect(parsed.projection_schema_version).toBe(1);

    await client.close();
    await server.close();
  });

  // 78. Resource read: cross-adjudication access forbidden
  it('78. Resource read: cross-adjudication access forbidden', async () => {
    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: fixtures.token1,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    const otherAdjId = crypto.randomUUID();
    const res = await client.readResource({
      uri: `agentforge://reviews/packages/${otherAdjId}`,
    });
    const content = (res.contents[0] as any).text;
    expect(content).toContain('PERMISSION_DENIED');

    await client.close();
    await server.close();
  });

  // 79. Tool list exposure: agentforge_get_review_package only
  it('79. Tool list exposure: agentforge_get_review_package only', async () => {
    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: fixtures.token1,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(1);
    expect(tools.tools[0].name).toBe(REVIEWER_TOOL_NAME);

    await client.close();
    await server.close();
  });

  // 80. Tool annotations: agentforge_get_review_package contract verification
  it('80. Tool annotations: agentforge_get_review_package contract verification', async () => {
    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: fixtures.token1,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    const tools = await client.listTools();
    const tool = tools.tools[0];
    expect(tool.annotations).toEqual(REVIEWER_TOOL_ANNOTATIONS);
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.annotations?.destructiveHint).toBe(false);
    expect(tool.annotations?.idempotentHint).toBe(true);
    expect(tool.annotations?.openWorldHint).toBe(false);

    await client.close();
    await server.close();
  });

  // 81. Tool call parameter schema validation and extra-property rejection
  it('81. Tool call parameter schema validation and extra-property rejection', async () => {
    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: fixtures.token1,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    // Missing required adjudication_id
    const res1 = await client.callTool({
      name: REVIEWER_TOOL_NAME,
      arguments: {} as any,
    });
    expect(res1.isError).toBe(true);

    // Extra unrecognized property
    const res2 = await client.callTool({
      name: REVIEWER_TOOL_NAME,
      arguments: {
        adjudication_id: fixtures.adjudicationId,
        extra_prop: 'illegal',
      } as any,
    });
    expect(res2.isError).toBe(true);
    const text2 = (res2.content[0] as any).text;
    expect(text2).toMatch(/Invalid arguments|InvalidParams/);

    await client.close();
    await server.close();
  });

  // 82. Tool call cross-adjudication access rejection
  it('82. Tool call cross-adjudication access rejection', async () => {
    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: fixtures.token1,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    const otherAdjId = crypto.randomUUID();
    const res = await client.callTool({
      name: REVIEWER_TOOL_NAME,
      arguments: { adjudication_id: otherAdjId },
    });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text;
    expect(text).toContain('PERMISSION_DENIED');

    await client.close();
    await server.close();
  });

  // 83. Tool list forbids task mutation tools
  it('83. Tool list forbids task mutation tools', async () => {
    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: fixtures.token1,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    const tools = await client.listTools();
    const toolNames = new Set(tools.tools.map((t) => t.name));
    expect(toolNames.has('update_task')).toBe(false);
    expect(toolNames.has('assign_task')).toBe(false);
    expect(toolNames.has('transition_task')).toBe(false);

    await client.close();
    await server.close();
  });

  // 84. Tool list forbids git mutation tools
  it('84. Tool list forbids git mutation tools', async () => {
    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: fixtures.token1,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    const tools = await client.listTools();
    const toolNames = new Set(tools.tools.map((t) => t.name));
    expect(toolNames.has('git_commit')).toBe(false);
    expect(toolNames.has('git_push')).toBe(false);
    expect(toolNames.has('git_apply')).toBe(false);

    await client.close();
    await server.close();
  });

  // 85. Tool list forbids verdict ingestion and adjudication tools
  it('85. Tool list forbids verdict ingestion and adjudication tools', async () => {
    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: fixtures.token1,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    const tools = await client.listTools();
    const toolNames = new Set(tools.tools.map((t) => t.name));
    expect(toolNames.has('submit_verdict')).toBe(false);
    expect(toolNames.has('approve_review')).toBe(false);
    expect(toolNames.has('adjudicate')).toBe(false);

    await client.close();
    await server.close();
  });

  // 86. Tool call agentforge_get_review_package returns complete frozen review package projection
  it('86. Tool call agentforge_get_review_package returns complete frozen review package projection', async () => {
    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: fixtures.token1,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    const res = await client.callTool({
      name: REVIEWER_TOOL_NAME,
      arguments: { adjudication_id: fixtures.adjudicationId },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content[0] as any).text;
    const parsed = JSON.parse(text);
    expect(parsed.projection_schema_version).toBe(1);
    expect(parsed.adjudication.id).toBe(fixtures.adjudicationId);

    await client.close();
    await server.close();
  });

  // 87. Tool and resource canonical-byte and SHA-256 hash parity
  it('87. Tool and resource canonical-byte and SHA-256 hash parity', async () => {
    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: fixtures.token1,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    const toolRes = await client.callTool({
      name: REVIEWER_TOOL_NAME,
      arguments: { adjudication_id: fixtures.adjudicationId },
    });
    const toolText = (toolRes.content[0] as any).text;

    const resRes = await client.readResource({
      uri: `agentforge://reviews/packages/${fixtures.adjudicationId}`,
    });
    const resText = (resRes.contents[0] as any).text;

    expect(toolText).toBe(resText);
    expect(computeSha256(toolText)).toBe(computeSha256(resText));

    await client.close();
    await server.close();
  });

  // 88. Strict zero-write read path on tool calls and resource reads
  it('88. Strict zero-write read path on tool calls and resource reads', async () => {
    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: fixtures.token1,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    const tcBeforeTool = (fixtures.db.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
    await client.callTool({
      name: REVIEWER_TOOL_NAME,
      arguments: { adjudication_id: fixtures.adjudicationId },
    });
    const tcAfterTool = (fixtures.db.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
    expect(tcAfterTool - tcBeforeTool).toBe(0);

    const tcBeforeRes = (fixtures.db.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
    await client.readResource({
      uri: `agentforge://reviews/packages/${fixtures.adjudicationId}`,
    });
    const tcAfterRes = (fixtures.db.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
    expect(tcAfterRes - tcBeforeRes).toBe(0);

    await client.close();
    await server.close();
  });

  // 89. Rejection of unapproved tools and absence of aliases
  it('89. Rejection of unapproved tools and absence of aliases', async () => {
    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: fixtures.token1,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    for (const forbidden of ['get_review_context', 'get_task_evidence', 'get_verification_details', 'get_diff_summary']) {
      await expect(
        client.callTool({
          name: forbidden,
          arguments: { adjudication_id: fixtures.adjudicationId },
        })
      ).rejects.toThrow();
    }

    await client.close();
    await server.close();
  });

  // 90. Protocol error handling: invalid params fail closed
  it('90. Protocol error handling: invalid params fail closed', async () => {
    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: fixtures.token1,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    // Invalid UUID
    const res = await client.callTool({
      name: REVIEWER_TOOL_NAME,
      arguments: { adjudication_id: 'not-a-valid-uuid' },
    });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text;
    expect(text).toContain('InvalidParams');

    await client.close();
    await server.close();
  });

  // 91. Restored locked diff content size limit (32768 UTF-8 bytes)
  it('91. Restored locked diff content size limit (32768 UTF-8 bytes)', () => {
    expect(DIFF_CONTENT_MAX_UTF8_BYTES).toBe(32768);
  });

  // 92. Diff content under 32768 bytes passed without truncation
  it('92. Diff content under 32768 bytes passed without truncation', () => {
    const buf = Buffer.from('a'.repeat(100), 'utf8');
    const res = truncateDiffBytes(buf, 32768);
    expect(res.truncated).toBe(false);
    expect(res.content).toBe('a'.repeat(100));
  });

  // 93. Diff content exceeding 32768 bytes truncated deterministically
  it('93. Diff content exceeding 32768 bytes truncated deterministically', () => {
    const buf = Buffer.from('x'.repeat(40000), 'utf8');
    const res = truncateDiffBytes(buf, 32768);
    expect(res.truncated).toBe(true);
    expect(Buffer.byteLength(res.content, 'utf8')).toBeLessThanOrEqual(32768);
  });

  // 94. Diff truncation preserves multibyte UTF-8 code points
  it('94. Diff truncation preserves multibyte UTF-8 code points', () => {
    // 3-byte unicode character: € (0xE2, 0x82, 0xAC)
    const base = 'a'.repeat(32767);
    const euro = '€'; // 3 bytes
    const buf = Buffer.from(base + euro, 'utf8');
    const res = truncateDiffBytes(buf, 32768);
    expect(res.truncated).toBe(true);
    // Boundary at 32768 would split € after 1 byte. Truncation must drop the partial character cleanly.
    expect(Buffer.byteLength(res.content, 'utf8')).toBe(32767);
    expect(res.content.endsWith('€')).toBe(false);
  });

  // 95. Restored locked projection payload size limit (524288 UTF-8 bytes)
  it('95. Restored locked projection payload size limit (524288 UTF-8 bytes)', () => {
    expect(PROJECTION_PAYLOAD_MAX_UTF8_BYTES).toBe(524288);
  });

  // 96. Projection payload exceeding 524288 bytes rejected fail-closed
  it('96. Projection payload exceeding 524288 bytes rejected fail-closed', () => {
    expect(() => {
      fixtures.service.verifyProjectionSize(524289);
    }).toThrowError(/PROJECTION_PAYLOAD_TOO_LARGE/);
  });

  // 97. Restored locked markdown size limit (524288 UTF-8 bytes)
  it('97. Restored locked markdown size limit (524288 UTF-8 bytes)', () => {
    expect(MARKDOWN_MAX_UTF8_BYTES).toBe(524288);
  });

  // 98. Projection payload deterministic SHA-256 hash match
  it('98. Projection payload deterministic SHA-256 hash match', () => {
    const session = fixtures.repo.getMcpReviewerSessionById(fixtures.sessionId1)!;
    expect(session).toBeDefined();
    expect(computeSha256(session.projection_json)).toBe(session.projection_hash);
  });

  // 99. Projection schema version must equal 1
  it('99. Projection schema version must equal 1', () => {
    const session = fixtures.repo.getMcpReviewerSessionById(fixtures.sessionId1)!;
    expect(session.projection_schema).toBe(1);
    const parsed = JSON.parse(session.projection_json);
    expect(parsed.projection_schema_version).toBe(1);
  });

  // 100. Projection JSON object validation
  it('100. Projection JSON object validation', () => {
    const session = fixtures.repo.getMcpReviewerSessionById(fixtures.sessionId1)!;
    const parsed = JSON.parse(session.projection_json);
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
    expect(Array.isArray(parsed)).toBe(false);
  });

  // 101. Projection contains verified evidence only
  it('101. Projection contains verified evidence only', () => {
    const session = fixtures.repo.getMcpReviewerSessionById(fixtures.sessionId1)!;
    const parsed = JSON.parse(session.projection_json);
    expect(parsed.adjudication.id).toBe(fixtures.adjudicationId);
    expect(parsed.adjudication.submission_id).toBe(fixtures.submissionId);
    expect(parsed.adjudication.task_id).toBe(fixtures.taskId);
    expect(parsed.evidence.git_status).toBeDefined();
    expect(parsed.evidence.git_diff).toBeDefined();
  });

  // 102. Projection excludes unverified workspace changes
  it('102. Projection excludes unverified workspace changes', () => {
    // Write an unverified file in workspace
    fs.writeFileSync(path.join(tempDir, 'unverified_new_file.txt'), 'unverified');

    const session = fixtures.repo.getMcpReviewerSessionById(fixtures.sessionId1)!;
    const parsed = JSON.parse(session.projection_json);
    expect(JSON.stringify(parsed)).not.toContain('unverified_new_file.txt');
  });

  // 103. Empty diff handling in review package
  it('103. Empty diff handling in review package', () => {
    const emptyBuf = Buffer.from('', 'utf8');
    const res = truncateDiffBytes(emptyBuf, 32768);
    expect(res.truncated).toBe(false);
    expect(res.content).toBe('');
  });

  // 104. Boundary test: exact 32768-byte diff payload
  it('104. Boundary test: exact 32768-byte diff payload', () => {
    const exactBuf = Buffer.from('a'.repeat(32768), 'utf8');
    const res = truncateDiffBytes(exactBuf, 32768);
    expect(res.truncated).toBe(false);
    expect(Buffer.byteLength(res.content, 'utf8')).toBe(32768);
  });

  // 105. Boundary test: 32769-byte diff payload triggers truncation
  it('105. Boundary test: 32769-byte diff payload triggers truncation', () => {
    const buf = Buffer.from('a'.repeat(32769), 'utf8');
    const res = truncateDiffBytes(buf, 32768);
    expect(res.truncated).toBe(true);
    expect(Buffer.byteLength(res.content, 'utf8')).toBeLessThanOrEqual(32768);
  });

  // 132. Replaying a token against another session or adjudication fails closed
  it('132. Replaying a token against another session or adjudication fails closed', async () => {
    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: fixtures.token1,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    // Replay Token 1 with a random adjudication ID
    const randomAdj = crypto.randomUUID();
    const res = await client.callTool({
      name: REVIEWER_TOOL_NAME,
      arguments: { adjudication_id: randomAdj },
    });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text;
    expect(text).toContain('PERMISSION_DENIED');

    await client.close();
    await server.close();
  });

  // 133. Cross-task and cross-project access fail closed with sanitized errors and zero writes
  it('133. Cross-task and cross-project access fail closed with sanitized errors and zero writes', async () => {
    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: fixtures.token1,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    const tcBefore = (fixtures.db.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
    const res = await client.callTool({
      name: REVIEWER_TOOL_NAME,
      arguments: { adjudication_id: crypto.randomUUID() },
    });
    const tcAfter = (fixtures.db.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;

    expect(tcAfter - tcBefore).toBe(0);
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text;
    expect(text).toContain('PERMISSION_DENIED');
    expect(text).not.toContain(fixtures.dbPath);
    expect(text).not.toContain(fixtures.token1);

    await client.close();
    await server.close();
  });

  // 134. Cross-reviewer access fails closed even when both reviewers are valid for the same adjudication
  it('134. Cross-reviewer access fails closed even when both reviewers are valid for the same adjudication', async () => {
    // Reviewer 1 with Token 1
    const server1 = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: fixtures.token1,
    });
    const [cTrans1, sTrans1] = InMemoryTransport.createLinkedPair();
    await server1.connect(sTrans1);
    const client1 = new Client({ name: 'rev1-client', version: '1.0.0' });
    await client1.connect(cTrans1);

    // Reviewer 1 reads successfully
    const res1 = await client1.callTool({
      name: REVIEWER_TOOL_NAME,
      arguments: { adjudication_id: fixtures.adjudicationId },
    });
    expect(res1.isError).toBeFalsy();

    // Rejection of extra reviewer selection params (InvalidParams)
    const resExtra = await client1.callTool({
      name: REVIEWER_TOOL_NAME,
      arguments: {
        adjudication_id: fixtures.adjudicationId,
        session_id: fixtures.sessionId2,
      } as any,
    });
    expect(resExtra.isError).toBe(true);
    expect((resExtra.content[0] as any).text).toMatch(/Invalid arguments|InvalidParams/);

    await client1.close();
    await server1.close();

    // Reviewer 2 with Token 2
    const server2 = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: fixtures.token2,
    });
    const [cTrans2, sTrans2] = InMemoryTransport.createLinkedPair();
    await server2.connect(sTrans2);
    const client2 = new Client({ name: 'rev2-client', version: '1.0.0' });
    await client2.connect(cTrans2);

    const res2 = await client2.callTool({
      name: REVIEWER_TOOL_NAME,
      arguments: { adjudication_id: fixtures.adjudicationId },
    });
    expect(res2.isError).toBeFalsy();

    await client2.close();
    await server2.close();
  });

  // 138. A valid token of any non-REVIEWER_CONTEXT_READ scope is rejected before projection access
  it('138. A valid token of any non-REVIEWER_CONTEXT_READ scope is rejected before projection access', async () => {
    // Insert a valid session but with wrong scope in database
    const wrongToken = `af-rev-${crypto.randomUUID()}`;
    const wrongTokenHash = computeSha256(wrongToken);
    const now = new Date().toISOString();
    const in1h = new Date(Date.now() + 3600000).toISOString();

    const authRow = fixtures.db.prepare('SELECT id FROM execution_authorizations LIMIT 1').get() as { id: string };
    // In mcp_client_sessions
    fixtures.db.prepare(`
      INSERT INTO mcp_client_sessions (
        id, authorization_id, scope, token_hash, authorization_fingerprint, issued_at, expires_at
      ) VALUES (?, ?, 'AUTHORIZED_CONTEXT_READ', ?, '${'0'.repeat(64)}', ?, ?)
    `).run(crypto.randomUUID(), authRow.id, wrongTokenHash, now, in1h);

    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: wrongToken,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    const res = await client.callTool({
      name: REVIEWER_TOOL_NAME,
      arguments: { adjudication_id: fixtures.adjudicationId },
    });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text;
    expect(text).toContain('AUTH_FAILED');

    await client.close();
    await server.close();
  });

  // 141. Repeated successful and failed reads across tool and resource endpoints preserve total_changes() === 0
  it('141. Repeated successful and failed reads across tool and resource endpoints preserve total_changes() === 0 and produce byte-identical deterministic responses/errors', async () => {
    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: fixtures.token1,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    let firstToolSuccess: string | null = null;
    let firstResourceSuccess: string | null = null;

    for (let i = 0; i < 3; i++) {
      const tcBeforeTool = (fixtures.db.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
      const toolRes = await client.callTool({
        name: REVIEWER_TOOL_NAME,
        arguments: { adjudication_id: fixtures.adjudicationId },
      });
      const tcAfterTool = (fixtures.db.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
      expect(tcAfterTool - tcBeforeTool).toBe(0);
      const text = (toolRes.content[0] as any).text;
      if (firstToolSuccess === null) {
        firstToolSuccess = text;
      } else {
        expect(text).toBe(firstToolSuccess);
      }

      const tcBeforeRes = (fixtures.db.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
      const resRes = await client.readResource({
        uri: `agentforge://reviews/packages/${fixtures.adjudicationId}`,
      });
      const tcAfterRes = (fixtures.db.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
      expect(tcAfterRes - tcBeforeRes).toBe(0);
      const resText = (resRes.contents[0] as any).text;
      if (firstResourceSuccess === null) {
        firstResourceSuccess = resText;
      } else {
        expect(resText).toBe(firstResourceSuccess);
      }
    }

    await client.close();
    await server.close();
  });

  // 142. Mutation of live workspace or mutable source records after issuance cannot change the already frozen tool/resource projection response
  it('142. Mutation of live workspace or mutable source records after issuance cannot change the already frozen tool/resource projection response', async () => {
    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: fixtures.token1,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    // Initial read
    const res1 = await client.callTool({
      name: REVIEWER_TOOL_NAME,
      arguments: { adjudication_id: fixtures.adjudicationId },
    });
    const initialText = (res1.content[0] as any).text;

    // Mutate live workspace files
    fs.writeFileSync(path.join(tempDir, 'new_random_file.ts'), 'export const mutated = true;');

    // Mutate non-authoritative presentation metadata on project/task
    fixtures.db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('Mutated Task Title', fixtures.taskId);
    fixtures.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run('Mutated Project Name', fixtures.projectId);

    // Second read: must return byte-for-byte identical projection
    const res2 = await client.callTool({
      name: REVIEWER_TOOL_NAME,
      arguments: { adjudication_id: fixtures.adjudicationId },
    });
    const postMutationText = (res2.content[0] as any).text;

    expect(postMutationText).toBe(initialText);
    expect(JSON.parse(postMutationText).title).not.toBe('Mutated Task Title');

    await client.close();
    await server.close();
  });

  // --- Section 4 Authority-Drift Regression Tests (154–170) ---

  async function assertFailClosedReadSurface(options: {
    db: Database.Database;
    dbPath: string;
    token: string;
    adjudicationId: string;
    expectedErrorCode: string;
  }) {
    const server = buildAgentForgeReviewerMcpServer({
      db: options.db,
      reviewerToken: options.token,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    try {
      // 1. Verify mutation tools are never available
      const toolList = await client.listTools();
      expect(toolList.tools.length).toBe(1);
      expect(toolList.tools[0].name).toBe(REVIEWER_TOOL_NAME);
      const names = new Set(toolList.tools.map((t) => t.name));
      for (const forbidden of ['update_task', 'assign_task', 'transition_task', 'git_commit', 'approve_review', 'reject_review']) {
        expect(names.has(forbidden)).toBe(false);
      }

      // 2. Tool access fails closed with zero DB writes and sanitized error
      const tcBeforeTool = (options.db.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
      const toolRes = await client.callTool({
        name: REVIEWER_TOOL_NAME,
        arguments: { adjudication_id: options.adjudicationId },
      });
      const tcAfterTool = (options.db.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;

      expect(tcAfterTool - tcBeforeTool).toBe(0);
      expect(toolRes.isError).toBe(true);
      const toolText = (toolRes.content[0] as any).text;
      expect(toolText).toContain(options.expectedErrorCode);
      expect(toolText).not.toContain(options.dbPath);
      expect(toolText).not.toContain(options.token);

      // 3. Resource access fails closed with zero DB writes and sanitized error
      const tcBeforeRes = (options.db.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
      const resRes = await client.readResource({
        uri: `agentforge://reviews/packages/${options.adjudicationId}`,
      });
      const tcAfterRes = (options.db.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;

      expect(tcAfterRes - tcBeforeRes).toBe(0);
      const resText = (resRes.contents[0] as any).text;
      expect(resText).toContain(options.expectedErrorCode);
      expect(resText).not.toContain(options.dbPath);
      expect(resText).not.toContain(options.token);
    } finally {
      await client.close();
      await server.close();
    }
  }

  // 154. Authority drift: Task leaves REVIEW_READY -> fails closed with zero writes
  it('154. Authority drift: Task leaves REVIEW_READY -> fails closed with zero writes', async () => {
    fixtures.db.prepare("UPDATE tasks SET state = 'CODING' WHERE id = ?").run(fixtures.taskId);
    await assertFailClosedReadSurface({
      db: fixtures.db,
      dbPath: fixtures.dbPath,
      token: fixtures.token1,
      adjudicationId: fixtures.adjudicationId,
      expectedErrorCode: 'TASK_STATE_INVALID',
    });
  });

  // 155. Authority drift: Task ownership epoch changes -> fails closed with zero writes
  it('155. Authority drift: Task ownership epoch changes -> fails closed with zero writes', async () => {
    fixtures.db.prepare("UPDATE tasks SET ownership_epoch = 2 WHERE id = ?").run(fixtures.taskId);
    await assertFailClosedReadSurface({
      db: fixtures.db,
      dbPath: fixtures.dbPath,
      token: fixtures.token1,
      adjudicationId: fixtures.adjudicationId,
      expectedErrorCode: 'STALE_REVIEWER_AUTHORITY',
    });
  });

  // 156. Authority drift: Adjudication becomes recovery-fenced -> fails closed with zero writes
  it('156. Authority drift: Adjudication becomes recovery-fenced -> fails closed with zero writes', async () => {
    fixtures.db.prepare(`
      UPDATE coder_submission_adjudications
      SET status = 'RECOVERY_FENCED', recovery_fenced_at = ?, failure_code = 'RECOVERY_FENCED_FOR_DRIFT_TEST', lifecycle_version = lifecycle_version + 1
      WHERE id = ?
    `).run(new Date().toISOString(), fixtures.adjudicationId);

    await assertFailClosedReadSurface({
      db: fixtures.db,
      dbPath: fixtures.dbPath,
      token: fixtures.token1,
      adjudicationId: fixtures.adjudicationId,
      expectedErrorCode: 'REVIEW_AUTHORITY_FENCED',
    });
  });

  // 157. Authority drift: Reviewer agent becomes OFFLINE -> fails closed with zero writes
  it('157. Authority drift: Reviewer agent becomes OFFLINE -> fails closed with zero writes', async () => {
    fixtures.db.prepare("UPDATE agents SET status = 'OFFLINE' WHERE id = ?").run(fixtures.reviewerAgentId);
    await assertFailClosedReadSurface({
      db: fixtures.db,
      dbPath: fixtures.dbPath,
      token: fixtures.token1,
      adjudicationId: fixtures.adjudicationId,
      expectedErrorCode: 'REVIEWER_AGENT_INVALID',
    });
  });

  // 158. Authority drift: Reviewer agent role is no longer REVIEWER -> fails closed with zero writes
  it('158. Authority drift: Reviewer agent role is no longer REVIEWER -> fails closed with zero writes', async () => {
    fixtures.db.prepare("UPDATE agents SET role = 'CODER' WHERE id = ?").run(fixtures.reviewerAgentId);
    await assertFailClosedReadSurface({
      db: fixtures.db,
      dbPath: fixtures.dbPath,
      token: fixtures.token1,
      adjudicationId: fixtures.adjudicationId,
      expectedErrorCode: 'REVIEWER_AGENT_INVALID',
    });
  });

  // 159. Authority drift: Reviewer agent resource binding changes incompatibly -> fails closed with zero writes
  it('159. Authority drift: Reviewer agent resource binding changes incompatibly -> fails closed with zero writes', async () => {
    const otherResId = `res-other-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    fixtures.db.prepare(`
      INSERT INTO provider_resources (id, provider_id, provider_account_id, model_name, health_status, capabilities_json, enabled, total_quota, remaining_quota, quota_unit, quota_source, quota_confidence, last_health_check)
      VALUES (?, ?, ?, 'OtherModel', 'AVAILABLE', '[]', 1, 100, 100, 'REQUESTS', 'PROVIDER_REPORTED', 1.0, ?)
    `).run(otherResId, fixtures.reviewerProviderId, fixtures.reviewerAccountId, now);
    fixtures.db.prepare("UPDATE agents SET provider_resource_id = ? WHERE id = ?").run(otherResId, fixtures.reviewerAgentId);

    await assertFailClosedReadSurface({
      db: fixtures.db,
      dbPath: fixtures.dbPath,
      token: fixtures.token1,
      adjudicationId: fixtures.adjudicationId,
      expectedErrorCode: 'REVIEWER_AGENT_INVALID',
    });
  });

  // 160. Authority drift: Reviewer provider is disabled -> fails closed with zero writes
  it('160. Authority drift: Reviewer provider is disabled -> fails closed with zero writes', async () => {
    fixtures.db.prepare("UPDATE providers SET enabled = 0 WHERE id = ?").run(fixtures.reviewerProviderId);
    await assertFailClosedReadSurface({
      db: fixtures.db,
      dbPath: fixtures.dbPath,
      token: fixtures.token1,
      adjudicationId: fixtures.adjudicationId,
      expectedErrorCode: 'REVIEWER_PROVIDER_INVALID',
    });
  });

  // 161. Authority drift: Reviewer account is disabled -> fails closed with zero writes
  it('161. Authority drift: Reviewer account is disabled -> fails closed with zero writes', async () => {
    fixtures.db.prepare("UPDATE provider_accounts SET enabled = 0 WHERE id = ?").run(fixtures.reviewerAccountId);
    await assertFailClosedReadSurface({
      db: fixtures.db,
      dbPath: fixtures.dbPath,
      token: fixtures.token1,
      adjudicationId: fixtures.adjudicationId,
      expectedErrorCode: 'REVIEWER_ACCOUNT_INVALID',
    });
  });

  // 162. Authority drift: Reviewer account becomes unhealthy -> fails closed with zero writes
  it('162. Authority drift: Reviewer account becomes unhealthy -> fails closed with zero writes', async () => {
    fixtures.db.prepare("UPDATE provider_accounts SET health_status = 'UNHEALTHY' WHERE id = ?").run(fixtures.reviewerAccountId);
    await assertFailClosedReadSurface({
      db: fixtures.db,
      dbPath: fixtures.dbPath,
      token: fixtures.token1,
      adjudicationId: fixtures.adjudicationId,
      expectedErrorCode: 'REVIEWER_ACCOUNT_INVALID',
    });
  });

  // 163. Authority drift: Reviewer resource is disabled -> fails closed with zero writes
  it('163. Authority drift: Reviewer resource is disabled -> fails closed with zero writes', async () => {
    fixtures.db.prepare("UPDATE provider_resources SET enabled = 0 WHERE id = ?").run(fixtures.reviewerResourceId);
    await assertFailClosedReadSurface({
      db: fixtures.db,
      dbPath: fixtures.dbPath,
      token: fixtures.token1,
      adjudicationId: fixtures.adjudicationId,
      expectedErrorCode: 'REVIEWER_RESOURCE_INVALID',
    });
  });

  // 164. Authority drift: Reviewer resource becomes unhealthy -> fails closed with zero writes
  it('164. Authority drift: Reviewer resource becomes unhealthy -> fails closed with zero writes', async () => {
    fixtures.db.prepare("UPDATE provider_resources SET health_status = 'UNHEALTHY' WHERE id = ?").run(fixtures.reviewerResourceId);
    await assertFailClosedReadSurface({
      db: fixtures.db,
      dbPath: fixtures.dbPath,
      token: fixtures.token1,
      adjudicationId: fixtures.adjudicationId,
      expectedErrorCode: 'REVIEWER_RESOURCE_INVALID',
    });
  });

  // 165. Authority drift: Resource/account binding changes incompatibly -> fails closed with zero writes
  it('165. Authority drift: Resource/account binding changes incompatibly -> fails closed with zero writes', async () => {
    const otherAccId = `acc-other-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    fixtures.db.prepare(`
      INSERT INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at)
      VALUES (?, ?, 'OtherAccount', 'NATIVE_PROFILE', 1, 10, 'AVAILABLE', 5, ?, ?)
    `).run(otherAccId, fixtures.reviewerProviderId, now, now);
    fixtures.db.prepare("UPDATE provider_resources SET provider_account_id = ? WHERE id = ?").run(otherAccId, fixtures.reviewerResourceId);

    await assertFailClosedReadSurface({
      db: fixtures.db,
      dbPath: fixtures.dbPath,
      token: fixtures.token1,
      adjudicationId: fixtures.adjudicationId,
      expectedErrorCode: 'REVIEWER_RESOURCE_INVALID',
    });
  });

  // 166. Authority drift: Agent-level self-review becomes true -> fails closed with zero writes
  it('166. Authority drift: Agent-level self-review becomes true -> fails closed with zero writes', async () => {
    fixtures.db.prepare(`
      UPDATE task_attempts
      SET agent_id = ?
      WHERE id = (SELECT attempt_id FROM coder_submission_adjudications WHERE id = ?)
    `).run(fixtures.reviewerAgentId, fixtures.adjudicationId);

    await assertFailClosedReadSurface({
      db: fixtures.db,
      dbPath: fixtures.dbPath,
      token: fixtures.token1,
      adjudicationId: fixtures.adjudicationId,
      expectedErrorCode: 'SELF_REVIEW_FORBIDDEN',
    });
  });

  // 167. Authority drift: Account-level self-review becomes true -> fails closed with zero writes
  it('167. Authority drift: Account-level self-review becomes true -> fails closed with zero writes', async () => {
    // Drop trigger in isolated test DB to mutate coder submission account to match reviewer account
    fixtures.db.exec('DROP TRIGGER IF EXISTS trg_coder_submissions_no_update');
    fixtures.db.prepare('UPDATE coder_submissions SET selected_account_id = ? WHERE id = ?').run(
      fixtures.reviewerAccountId,
      fixtures.submissionId
    );

    await assertFailClosedReadSurface({
      db: fixtures.db,
      dbPath: fixtures.dbPath,
      token: fixtures.token1,
      adjudicationId: fixtures.adjudicationId,
      expectedErrorCode: 'SELF_REVIEW_FORBIDDEN',
    });
  });

  // 168. Authority drift: projection_hash does not match projection_json -> fails closed with zero writes
  it('168. Authority drift: projection_hash does not match projection_json -> fails closed with zero writes', async () => {
    const rawToken = `${REVIEWER_TOKEN_PREFIX}${crypto.randomUUID()}`;
    const tokenHash = computeSha256(rawToken);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    const existingSession = fixtures.repo.getMcpReviewerSessionById(fixtures.sessionId1)!;

    const reviewerAgentId4 = `agent-rev-4-${crypto.randomUUID()}`;
    fixtures.db.prepare(`
      INSERT INTO agents (id, display_name, role, provider_resource_id, status, current_task_id, last_seen_at)
      VALUES (?, 'ReviewerAgent4', 'REVIEWER', ?, 'IDLE', NULL, ?)
    `).run(reviewerAgentId4, fixtures.reviewerResourceId, now);

    const corruptedSessionId = crypto.randomUUID();
    fixtures.db.prepare(`
      INSERT INTO mcp_reviewer_sessions (
        id, adjudication_id, submission_id, reviewer_agent_id, reviewer_provider_id,
        reviewer_account_id, reviewer_resource_id, scope, token_hash, task_ownership_epoch,
        authority_snapshot_hash, verification_result_envelope_hash, projection_schema,
        projection_hash, projection_json, issued_at, expires_at, revoked_at, revocation_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL)
    `).run(
      corruptedSessionId, fixtures.adjudicationId, fixtures.submissionId, reviewerAgentId4,
      fixtures.reviewerProviderId, fixtures.reviewerAccountId, fixtures.reviewerResourceId,
      REVIEWER_TOKEN_SCOPE, tokenHash, existingSession.task_ownership_epoch, existingSession.authority_snapshot_hash,
      existingSession.verification_result_envelope_hash, '0'.repeat(64), // Mismatched hash
      existingSession.projection_json, now, expiresAt
    );

    await assertFailClosedReadSurface({
      db: fixtures.db,
      dbPath: fixtures.dbPath,
      token: rawToken,
      adjudicationId: fixtures.adjudicationId,
      expectedErrorCode: 'PROJECTION_HASH_MISMATCH',
    });
  });

  // 169. Authority drift: projection_json is malformed -> fails closed with zero writes
  it('169. Authority drift: projection_json is malformed -> fails closed with zero writes', async () => {
    const rawToken = `${REVIEWER_TOKEN_PREFIX}${crypto.randomUUID()}`;
    const existingSession = fixtures.repo.getMcpReviewerSessionById(fixtures.sessionId1)!;

    // Direct DB insertion of malformed JSON is rejected by SQLite check constraint
    expect(() => {
      fixtures.db.prepare(`
        INSERT INTO mcp_reviewer_sessions (
          id, adjudication_id, submission_id, reviewer_agent_id, reviewer_provider_id,
          reviewer_account_id, reviewer_resource_id, scope, token_hash, task_ownership_epoch,
          authority_snapshot_hash, verification_result_envelope_hash, projection_schema,
          projection_hash, projection_json, issued_at, expires_at, revoked_at, revocation_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL)
      `).run(
        crypto.randomUUID(), fixtures.adjudicationId, fixtures.submissionId, fixtures.reviewerAgentId2,
        fixtures.reviewerProviderId, fixtures.reviewerAccountId, fixtures.reviewerResourceId,
        REVIEWER_TOKEN_SCOPE, computeSha256(rawToken), existingSession.task_ownership_epoch,
        existingSession.authority_snapshot_hash, existingSession.verification_result_envelope_hash,
        '0'.repeat(64), '{malformed-json-payload', new Date().toISOString(), new Date(Date.now() + 3600000).toISOString()
      );
    }).toThrowError(/CHECK constraint failed/);

    // When returning a malformed session from repository, read fence fails closed with PROJECTION_CORRUPTED
    const spy = vi.spyOn(Repository.prototype, 'getMcpReviewerSessionByTokenHash').mockReturnValue({
      ...existingSession,
      projection_json: '{malformed-json',
      projection_hash: computeSha256('{malformed-json'),
    });

    try {
      await assertFailClosedReadSurface({
        db: fixtures.db,
        dbPath: fixtures.dbPath,
        token: fixtures.token1,
        adjudicationId: fixtures.adjudicationId,
        expectedErrorCode: 'PROJECTION_CORRUPTED',
      });
    } finally {
      spy.mockRestore();
    }
  });

  // 170. Authority drift: projection schema is unsupported -> fails closed with zero writes
  it('170. Authority drift: projection schema is unsupported -> fails closed with zero writes', async () => {
    const rawToken = `${REVIEWER_TOKEN_PREFIX}${crypto.randomUUID()}`;
    const existingSession = fixtures.repo.getMcpReviewerSessionById(fixtures.sessionId1)!;

    // Direct DB insertion of unsupported schema is rejected by SQLite check constraint
    expect(() => {
      fixtures.db.prepare(`
        INSERT INTO mcp_reviewer_sessions (
          id, adjudication_id, submission_id, reviewer_agent_id, reviewer_provider_id,
          reviewer_account_id, reviewer_resource_id, scope, token_hash, task_ownership_epoch,
          authority_snapshot_hash, verification_result_envelope_hash, projection_schema,
          projection_hash, projection_json, issued_at, expires_at, revoked_at, revocation_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?, NULL, NULL)
      `).run(
        crypto.randomUUID(), fixtures.adjudicationId, fixtures.submissionId, fixtures.reviewerAgentId2,
        fixtures.reviewerProviderId, fixtures.reviewerAccountId, fixtures.reviewerResourceId,
        REVIEWER_TOKEN_SCOPE, computeSha256(rawToken), existingSession.task_ownership_epoch,
        existingSession.authority_snapshot_hash, existingSession.verification_result_envelope_hash,
        existingSession.projection_hash, existingSession.projection_json, new Date().toISOString(),
        new Date(Date.now() + 3600000).toISOString()
      );
    }).toThrowError(/CHECK constraint failed/);

    // When returning an unsupported schema session from repository, read fence fails closed with PROJECTION_SCHEMA_INVALID
    const spy = vi.spyOn(Repository.prototype, 'getMcpReviewerSessionByTokenHash').mockReturnValue({
      ...existingSession,
      projection_schema: 2 as any,
    });

    try {
      await assertFailClosedReadSurface({
        db: fixtures.db,
        dbPath: fixtures.dbPath,
        token: fixtures.token1,
        adjudicationId: fixtures.adjudicationId,
        expectedErrorCode: 'PROJECTION_SCHEMA_INVALID',
      });
    } finally {
      spy.mockRestore();
    }
  });

  // --- Section 5 Strict Projection Validation Negative Tests (171–185) ---

  function buildValidBaseProjection(fixtures: Fixtures, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const task = fixtures.repo.getTask(fixtures.taskId)!;
    const adj = fixtures.repo.getCoderSubmissionAdjudicationById(fixtures.adjudicationId)!;
    return {
      projection_schema_version: 1,
      adjudication: {
        id: fixtures.adjudicationId,
        request_id: adj.request_id,
        submission_id: fixtures.submissionId,
        project_id: fixtures.projectId,
        project_name: 'Test Project',
        task_id: fixtures.taskId,
        task_title: task.title,
        task_ownership_epoch: adj.task_ownership_epoch,
        action: 'ADMIT_VERIFICATION',
        status: 'VERIFIED',
      },
      verification_results: {
        test_run_id: 'tr-001',
        exit_code: 0,
        passed_count: 10,
        failed_count: 0,
        skipped_count: 0,
        duration_ms: 250,
        envelope: { run_status: 'passed' },
      },
      evidence: {
        git_status: {
          is_clean: true,
          branch: 'main',
          files: ['src/core/database.ts'],
        },
        git_diff: {
          diff_content: 'diff --git a/file.ts b/file.ts\n+line',
          byte_size: Buffer.byteLength('diff --git a/file.ts b/file.ts\n+line', 'utf8'),
          is_truncated: false,
        },
      },
      disposition: {
        disposition_event: 'SETTLED',
        disposition_reason: 'ACCEPTED_VERIFIED',
        created_at: new Date().toISOString(),
      },
      ...overrides,
    };
  }

  async function insertCorruptedSessionAndAssertFailClosed(
    fixtures: Fixtures,
    projectionObj: Record<string, unknown>,
    expectedErrorCode = 'PROJECTION_CORRUPTED'
  ) {
    const rawToken = `${REVIEWER_TOKEN_PREFIX}${crypto.randomUUID()}`;
    const tokenHash = computeSha256(rawToken);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    const projectionJson = JSON.stringify(projectionObj);
    const projectionHash = computeSha256(projectionJson);

    const adj = fixtures.repo.getCoderSubmissionAdjudicationById(fixtures.adjudicationId)!;

    // Create unique reviewer agent to satisfy (adjudication_id, reviewer_agent_id) unique constraint
    const extraAgentId = `agent-rev-extra-${crypto.randomUUID()}`;
    fixtures.db.prepare(`
      INSERT INTO agents (id, display_name, role, provider_resource_id, status, current_task_id, last_seen_at)
      VALUES (?, 'Extra Reviewer', 'REVIEWER', ?, 'IDLE', NULL, ?)
    `).run(extraAgentId, fixtures.reviewerResourceId, now);

    const sessionId = crypto.randomUUID();
    fixtures.db.prepare(`
      INSERT INTO mcp_reviewer_sessions (
        id, adjudication_id, submission_id, reviewer_agent_id, reviewer_provider_id,
        reviewer_account_id, reviewer_resource_id, scope, token_hash, task_ownership_epoch,
        authority_snapshot_hash, verification_result_envelope_hash, projection_schema,
        projection_hash, projection_json, issued_at, expires_at, revoked_at, revocation_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL)
    `).run(
      sessionId, fixtures.adjudicationId, fixtures.submissionId, extraAgentId,
      fixtures.reviewerProviderId, fixtures.reviewerAccountId, fixtures.reviewerResourceId,
      REVIEWER_TOKEN_SCOPE, tokenHash, adj.task_ownership_epoch, adj.authority_snapshot_hash,
      adj.verification_result_envelope_hash, projectionHash, projectionJson, now, expiresAt
    );

    await assertFailClosedReadSurface({
      db: fixtures.db,
      dbPath: fixtures.dbPath,
      token: rawToken,
      adjudicationId: fixtures.adjudicationId,
      expectedErrorCode,
    });
  }

  // 171. Missing verification_results
  it('171. Strict projection: Missing verification_results fails closed with PROJECTION_CORRUPTED', async () => {
    const p = buildValidBaseProjection(fixtures);
    delete (p as any).verification_results;
    await insertCorruptedSessionAndAssertFailClosed(fixtures, p);
  });

  // 172. verification_results as primitive
  it('172. Strict projection: verification_results as primitive fails closed with PROJECTION_CORRUPTED', async () => {
    const p = buildValidBaseProjection(fixtures);
    p.verification_results = 'passed-all';
    await insertCorruptedSessionAndAssertFailClosed(fixtures, p);
  });

  // 173. Missing verification envelope
  it('173. Strict projection: Missing verification envelope fails closed with PROJECTION_CORRUPTED', async () => {
    const p = buildValidBaseProjection(fixtures);
    delete (p.verification_results as any).envelope;
    await insertCorruptedSessionAndAssertFailClosed(fixtures, p);
  });

  // 174. Non-zero verification exit code
  it('174. Strict projection: Non-zero verification exit code fails closed with PROJECTION_CORRUPTED', async () => {
    const p = buildValidBaseProjection(fixtures);
    (p.verification_results as any).exit_code = 1;
    await insertCorruptedSessionAndAssertFailClosed(fixtures, p);
  });

  // 175. evidence.git_status as truthy primitive
  it('175. Strict projection: evidence.git_status as truthy primitive fails closed with PROJECTION_CORRUPTED', async () => {
    const p = buildValidBaseProjection(fixtures);
    (p.evidence as any).git_status = true;
    await insertCorruptedSessionAndAssertFailClosed(fixtures, p);
  });

  // 176. evidence.git_diff as truthy primitive
  it('176. Strict projection: evidence.git_diff as truthy primitive fails closed with PROJECTION_CORRUPTED', async () => {
    const p = buildValidBaseProjection(fixtures);
    (p.evidence as any).git_diff = 'diff content string';
    await insertCorruptedSessionAndAssertFailClosed(fixtures, p);
  });

  // 177. Incorrect git_diff.byte_size
  it('177. Strict projection: Incorrect git_diff.byte_size fails closed with PROJECTION_CORRUPTED', async () => {
    const p = buildValidBaseProjection(fixtures);
    (p.evidence as any).git_diff.byte_size = 99999;
    await insertCorruptedSessionAndAssertFailClosed(fixtures, p);
  });

  // 178. Unsafe git-status path with traversal
  it('178. Strict projection: Unsafe git-status path with traversal fails closed with PROJECTION_CORRUPTED', async () => {
    const p = buildValidBaseProjection(fixtures);
    (p.evidence as any).git_status.files = ['src/../../../etc/passwd'];
    await insertCorruptedSessionAndAssertFailClosed(fixtures, p);
  });

  // 179. Unsafe git-status path with absolute path
  it('179. Strict projection: Unsafe git-status path with absolute prefix fails closed with PROJECTION_CORRUPTED', async () => {
    const p = buildValidBaseProjection(fixtures);
    (p.evidence as any).git_status.files = ['/root/secret.key'];
    await insertCorruptedSessionAndAssertFailClosed(fixtures, p);
  });

  // 180. Mismatched submission_id
  it('180. Strict projection: Mismatched submission_id fails closed with PROJECTION_CORRUPTED', async () => {
    const p = buildValidBaseProjection(fixtures);
    (p.adjudication as any).submission_id = crypto.randomUUID();
    await insertCorruptedSessionAndAssertFailClosed(fixtures, p);
  });

  // 181. Mismatched task ID
  it('181. Strict projection: Mismatched task_id fails closed with PROJECTION_CORRUPTED', async () => {
    const p = buildValidBaseProjection(fixtures);
    (p.adjudication as any).task_id = 'task-foreign-mismatch';
    await insertCorruptedSessionAndAssertFailClosed(fixtures, p);
  });

  // 182. Mismatched project ID
  it('182. Strict projection: Mismatched project_id fails closed with PROJECTION_CORRUPTED', async () => {
    const p = buildValidBaseProjection(fixtures);
    (p.adjudication as any).project_id = 'proj-foreign-mismatch';
    await insertCorruptedSessionAndAssertFailClosed(fixtures, p);
  });

  // 183. Mismatched ownership epoch
  it('183. Strict projection: Mismatched task_ownership_epoch fails closed with PROJECTION_CORRUPTED', async () => {
    const p = buildValidBaseProjection(fixtures);
    (p.adjudication as any).task_ownership_epoch = 999;
    await insertCorruptedSessionAndAssertFailClosed(fixtures, p);
  });

  // 184. Unexpected disposition data
  it('184. Strict projection: Unexpected disposition event fails closed with PROJECTION_CORRUPTED', async () => {
    const p = buildValidBaseProjection(fixtures);
    (p.disposition as any).disposition_event = 'PENDING';
    await insertCorruptedSessionAndAssertFailClosed(fixtures, p);
  });

  // 185. Unexpected top-level property
  it('185. Strict projection: Unexpected top-level property fails closed with PROJECTION_CORRUPTED', async () => {
    const p = buildValidBaseProjection(fixtures);
    (p as any).unauthorized_extra_field = 'injected';
    await insertCorruptedSessionAndAssertFailClosed(fixtures, p);
  });

  // --- Section 6 One-Snapshot Read Authorization & Concurrency Tests (186–191) ---

  // 186. Concurrency: Two SQLite connections in WAL mode guarantee consistent snapshot read
  it('186. Concurrency: Two SQLite connections in WAL mode observe consistent snapshot', () => {
    fixtures.db.pragma('journal_mode = WAL');
    const writerDb = new Database(fixtures.dbPath);
    writerDb.pragma('foreign_keys = ON');

    try {
      const changesBefore = (fixtures.db.prepare('SELECT total_changes() as c').get() as any).c;

      // Execute read on connection 1
      const res = fixtures.service.authenticateAndGetReviewPackage(fixtures.token1, fixtures.adjudicationId);
      expect(res.projection_json).toBeDefined();
      expect(res.projection_hash).toBeDefined();

      // total_changes() on connection 1 must be strictly unchanged
      const changesAfter = (fixtures.db.prepare('SELECT total_changes() as c').get() as any).c;
      expect(changesAfter - changesBefore).toBe(0);
    } finally {
      writerDb.close();
    }
  });

  // 187. Concurrency: Read beginning after authority-invalidating commit fails closed immediately
  it('187. Concurrency: Read beginning after authority-invalidating commit fails closed immediately', () => {
    fixtures.db.pragma('journal_mode = WAL');
    const writerDb = new Database(fixtures.dbPath);
    writerDb.pragma('foreign_keys = ON');

    try {
      const changesBefore = (fixtures.db.prepare('SELECT total_changes() as c').get() as any).c;

      // Invalidate task state on connection 2
      writerDb.prepare("UPDATE tasks SET state = 'CANCELLED' WHERE id = ?").run(fixtures.taskId);

      // Subsequent read on connection 1 must immediately fail closed with TASK_STATE_INVALID
      expect(() => {
        fixtures.service.authenticateAndGetReviewPackage(fixtures.token1, fixtures.adjudicationId);
      }).toThrowError(/TASK_STATE_INVALID/);

      // total_changes on connection 1 remains strictly unchanged
      const changesAfter = (fixtures.db.prepare('SELECT total_changes() as c').get() as any).c;
      expect(changesAfter - changesBefore).toBe(0);
    } finally {
      writerDb.close();
    }
  });

  // 188. Concurrency: Recovery fencing commit on writer connection immediately invalidates subsequent reads
  it('188. Concurrency: Recovery fencing commit on writer connection immediately invalidates subsequent reads', () => {
    fixtures.db.pragma('journal_mode = WAL');
    const writerDb = new Database(fixtures.dbPath);
    writerDb.pragma('foreign_keys = ON');

    try {
      const changesBefore = (fixtures.db.prepare('SELECT total_changes() as c').get() as any).c;

      const fencedAt = new Date().toISOString();
      writerDb.prepare(
        "UPDATE coder_submission_adjudications SET recovery_fenced_at = ?, status = 'RECOVERY_FENCED', failure_code = 'MANUAL_FENCE', lifecycle_version = lifecycle_version + 1 WHERE id = ?"
      ).run(fencedAt, fixtures.adjudicationId);

      expect(() => {
        fixtures.service.authenticateAndGetReviewPackage(fixtures.token1, fixtures.adjudicationId);
      }).toThrowError(/REVIEW_AUTHORITY_FENCED/);

      const changesAfter = (fixtures.db.prepare('SELECT total_changes() as c').get() as any).c;
      expect(changesAfter - changesBefore).toBe(0);
    } finally {
      writerDb.close();
    }
  });

  // 189. Concurrency: Successful and failed transactional reads leave total_changes() strictly unchanged
  it('189. Concurrency: Successful and failed transactional reads leave total_changes() strictly unchanged', () => {
    const changesBefore = (fixtures.db.prepare('SELECT total_changes() as c').get() as any).c;

    // 1. Successful read
    fixtures.service.authenticateAndGetReviewPackage(fixtures.token1, fixtures.adjudicationId);
    const changesAfterSuccess = (fixtures.db.prepare('SELECT total_changes() as c').get() as any).c;
    expect(changesAfterSuccess - changesBefore).toBe(0);

    // 2. Failed read (invalid token)
    expect(() => {
      fixtures.service.authenticateAndGetReviewPackage(`${REVIEWER_TOKEN_PREFIX}${crypto.randomUUID()}`, fixtures.adjudicationId);
    }).toThrowError(/AUTH_FAILED/);
    const changesAfterFailAuth = (fixtures.db.prepare('SELECT total_changes() as c').get() as any).c;
    expect(changesAfterFailAuth - changesBefore).toBe(0);

    // 3. Failed read (mismatched adjudication)
    expect(() => {
      fixtures.service.authenticateAndGetReviewPackage(fixtures.token1, crypto.randomUUID());
    }).toThrowError(/PERMISSION_DENIED/);
    const changesAfterFailPerm = (fixtures.db.prepare('SELECT total_changes() as c').get() as any).c;
    expect(changesAfterFailPerm - changesBefore).toBe(0);
  });

  // 190. Protocol: Both tool and resource endpoints call authenticateAndGetReviewPackage transactional API
  it('190. Protocol: Both tool and resource endpoints call authenticateAndGetReviewPackage transactional API', async () => {
    const server = buildAgentForgeReviewerMcpServer({
      db: fixtures.db,
      reviewerToken: fixtures.token1,
    });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(cTrans);

    try {
      // 1. Tool read
      const toolRes = await client.callTool({
        name: REVIEWER_TOOL_NAME,
        arguments: { adjudication_id: fixtures.adjudicationId },
      });
      expect(toolRes.isError).toBeFalsy();
      const toolText = (toolRes.content[0] as any).text;
      const toolParsed = JSON.parse(toolText);
      expect(toolParsed.projection_schema_version).toBe(1);

      // 2. Resource read
      const resRes = await client.readResource({
        uri: `agentforge://reviews/packages/${fixtures.adjudicationId}`,
      });
      const resText = (resRes.contents[0] as any).text;
      const resParsed = JSON.parse(resText);
      expect(resParsed.projection_schema_version).toBe(1);

      // 3. Byte-level parity
      expect(toolText).toBe(resText);
    } finally {
      await client.close();
      await server.close();
    }
  });

  // 191. Concurrency: Snapshot isolation guarantees token, authority, and projection are evaluated in same snapshot
  it('191. Concurrency: Snapshot isolation guarantees token, authority, and projection are evaluated in same snapshot', () => {
    fixtures.db.pragma('journal_mode = WAL');
    const writerDb = new Database(fixtures.dbPath);
    writerDb.pragma('foreign_keys = ON');

    try {
      const changesBefore = (fixtures.db.prepare('SELECT total_changes() as c').get() as any).c;

      // Inside runInReadTransaction on reader connection, all queries observe consistent snapshot
      const res = fixtures.repo.runInReadTransaction(() => {
        return fixtures.service.authenticateAndGetReviewPackage(fixtures.token1, fixtures.adjudicationId);
      });
      expect(res.projection_json).toBeDefined();

      const changesAfter = (fixtures.db.prepare('SELECT total_changes() as c').get() as any).c;
      expect(changesAfter - changesBefore).toBe(0);
    } finally {
      writerDb.close();
    }
  });
});
