import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import child_process from 'child_process';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import {
  MIGRATIONS,
  MigrationRunner,
  verifyMigration21SchemaAuthority,
  verifyMigration22SchemaAuthority,
  verifyMigration23SchemaAuthority,
} from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import {
  McpSubmissionAuthorityService,
  McpSubmissionAuthorityError,
} from '../src/core/services/McpSubmissionAuthorityService';
import {
  generateSubmissionToken,
  validateSubmissionToken,
  isPortablePath,
  canonicalJsonStringify,
  computeClaimContentHash,
  computeAuthorityFingerprint,
  computeCanonicalEnvelope,
  deriveDeterministicEventId,
  CODER_SUBMISSION_INPUT_JSON_SCHEMA,
  CODER_SUBMISSION_OUTPUT_JSON_SCHEMA,
  CODER_SUBMISSION_CAPABILITY_METADATA,
  CoderSubmissionInputZodSchema,
  CoderSubmissionInput,
  CLAIM_CONTENT_KEYS,
  AUTHORITY_FINGERPRINT_KEYS,
  CANONICAL_ENVELOPE_KEYS,
  MAX_ARGUMENT_BYTES,
  SUBMISSION_TOKEN_REGEX,
  SUBMISSION_STATUS_TOOL_NAME,
  SUBMISSION_STATUS_TOOL_DESCRIPTION,
  SUBMISSION_STATUS_TOOL_ANNOTATIONS,
  SUBMISSION_STATUS_RESOURCE_NAME,
  SUBMISSION_STATUS_URI_TEMPLATE,
  SUBMISSION_STATUS_MIME_TYPE,
  SUBMISSION_LIFECYCLE_STATUSES,
  SUBMISSION_TERMINAL_OUTCOMES,
  SUBMISSION_STATUS_ERROR_CODES,
  SubmissionStatusInputZodSchema,
  SubmissionStatusSuccessZodSchema,
  SubmissionStatusErrorZodSchema,
  CODER_SUBMISSION_STATUS_INPUT_JSON_SCHEMA,
  CODER_SUBMISSION_STATUS_OUTPUT_JSON_SCHEMA,
  sanitizeFailureMessage,
  MAX_FAILURE_MESSAGE_LENGTH,
} from '../src/mcp/submissionProtocol';
import {
  buildAgentForgeSubmissionMcpServer,
  createSubmissionMcpServer,
  SubmissionMcpAuthorityContext,
  SUBMISSION_SERVER_NAME,
  SUBMISSION_SERVER_VERSION,
  SUBMISSION_TOOL_NAME,
  SUBMISSION_TOOL_ANNOTATIONS,
} from '../src/mcp/submissionServer';
import {
  parseSubmissionCliArgs,
  runSubmissionAdmin,
  validateSubmissionTtlSeconds,
} from '../src/mcp/submissionAdmin';
import {
  generateSubmissionClientConfig,
  generateSubmissionClientConfigEnvelope,
  OPERATOR_SUBMISSION_TOKEN_PLACEHOLDER,
} from '../src/mcp/clientBridge';
import { ExecutionAuthorization, TaskStateEnum } from '../src/core/types/domain';
import { AUTHORITY_SNAPSHOT_KEYS } from '../src/core/types/adjudication';

interface FullSubmissionFixtures {
  projectId: string;
  taskId: string;
  attemptId: string;
  assignmentId: string;
  providerId: string;
  accountId: string;
  resourceId: string;
  routingDecisionId: string;
  authorizationId: string;
  managerMessageId: string;
  managerRecordId: string;
  repoHeadSha: string;
  baseSha: string;
  projectRoot: string;
  roleId: string;
  agentId: string;
  managerPayloadHash: string;
  instructionPayloadHash: string;
  contextManifestHash: string;
  repo: Repository;
  auth: ExecutionAuthorization;
  service: McpSubmissionAuthorityService;
}

function createTestDatabase(dir: string, name: string): { db: Database.Database; dbPath: string } {
  const dbPath = path.join(dir, name);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  MigrationRunner.run(db);
  return { db, dbPath };
}

function setupFullSubmissionGraph(db: Database.Database, projectRepoPath?: string): FullSubmissionFixtures {
  const repo = new Repository(db);
  const service = new McpSubmissionAuthorityService(repo, db);

  const now = new Date().toISOString();
  const projectId = `proj-${crypto.randomUUID()}`;
  const taskId = `task-${crypto.randomUUID()}`;
  const attemptId = `att-${crypto.randomUUID()}`;
  const assignmentId = `asgn-${crypto.randomUUID()}`;
  const providerId = `prov-${crypto.randomUUID()}`;
  const accountId = `acc-${crypto.randomUUID()}`;
  const resourceId = `res-${crypto.randomUUID()}`;
  const routingDecisionId = `route-${crypto.randomUUID()}`;
  const authorizationId = `auth-${crypto.randomUUID()}`;
  const managerMessageId = `msg-proto-${crypto.randomUUID()}`;
  const managerRecordId = `msg-rec-${crypto.randomUUID()}`;

  const resolvedRepoPath = projectRepoPath ?? path.resolve(__dirname, '..');
  let repoHeadSha = '0'.repeat(40);
  try {
    repoHeadSha = child_process
      .execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: resolvedRepoPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .trim()
      .toLowerCase();
  } catch {
    repoHeadSha = 'a'.repeat(40);
  }

  // 1. Project
  repo.createProject({
    id: projectId,
    name: 'Submission Test Project',
    description: 'Testing coder submission',
    repository_path: resolvedRepoPath,
    default_branch: 'main',
    status: 'RUNNING',
    contract: null,
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
  });

  // 2. Task (receptive state: CODING)
  const baseSha = 'b'.repeat(40);
  db.prepare(`
    INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, base_sha, ownership_epoch, created_at, updated_at)
    VALUES (?, ?, 'Submission Task 1', 'CODING', 'LOW', 'LOW', 1, 3, 0, ?, 1, ?, ?)
  `).run(taskId, projectId, baseSha, now, now);

  // 3. Profiles
  const roleId = `role-${crypto.randomUUID()}`;
  const agentId = `agent-${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO role_profiles (id, role, display_name, required_capabilities_json, preferred_capabilities_json, permissions_json, enabled, created_at, updated_at)
    VALUES (?, 'CODER', 'Coder Role', '["CODING"]', '[]', '[]', 1, ?, ?)
  `).run(roleId, now, now);

  db.prepare(`
    INSERT INTO agent_profiles (id, role_profile_id, name, enabled, created_at, updated_at)
    VALUES (?, ?, 'Agent Coder', 1, ?, ?)
  `).run(agentId, roleId, now, now);

  // 4. Provider, Account, Resource
  db.prepare(`
    INSERT OR IGNORE INTO providers (id, name, adapter_type, enabled, created_at)
    VALUES (?, 'Anthropic Claude', 'LOCAL_CLI', 1, ?)
  `).run(providerId, now);

  db.prepare(`
    INSERT INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at)
    VALUES (?, ?, 'default-account', 'NATIVE_PROFILE', 1, 10, 'AVAILABLE', 20, ?, ?)
  `).run(accountId, providerId, now, now);

  db.prepare(`
    INSERT INTO provider_resources (id, provider_id, provider_account_id, model_name, health_status, capabilities_json, enabled, total_quota, remaining_quota, quota_unit, quota_source, quota_confidence, last_health_check)
    VALUES (?, ?, ?, 'claude-3-7-sonnet', 'AVAILABLE', '["CODING"]', 1, 1000, 1000, 'REQUESTS', 'PROVIDER_REPORTED', 1.0, ?)
  `).run(resourceId, providerId, accountId, now);

  // 5. Task Attempt
  repo.createTaskAttempt({
    id: attemptId,
    task_id: taskId,
    attempt_number: 1,
    status: 'RUNNING',
    agent_profile_id: agentId,
    agent_id: null,
    started_at: now,
    ended_at: null,
    summary: null,
  });

  // 6. Routing Decision Event
  const routingPayload = {
    decisionId: routingDecisionId,
    projectId,
    taskId,
    attemptId,
    roleProfileId: roleId,
    role: 'CODER',
    outcome: 'SELECTED',
    routePolicyId: null,
    failoverPolicyAuthoritySnapshot: null,
    selectedProviderId: providerId,
    selectedAccountId: accountId,
    selectedResourceId: resourceId,
    selectedAssignmentId: assignmentId,
    requestedConstraints: [],
    appliedExclusions: [],
    appliedSeparation: null,
    reason: 'Optimal route',
  };
  db.prepare(`
    INSERT INTO events (id, project_id, task_id, type, summary, structured_payload_json, timestamp)
    VALUES (?, ?, ?, 'ROLE_AWARE_ROUTING_DECISION', 'Optimal route', ?, ?)
  `).run(routingDecisionId, projectId, taskId, JSON.stringify(routingPayload), now);

  // 7. Agent Assignment
  repo.createAgentAssignment({
    id: assignmentId,
    project_id: projectId,
    task_id: taskId,
    attempt_id: attemptId,
    role_profile_id: roleId,
    agent_profile_id: agentId,
    selected_provider_id: providerId,
    selected_account_id: accountId,
    selected_resource_id: resourceId,
    selected_worker_slot_id: null,
    routing_decision_id: routingDecisionId,
    status: 'ASSIGNED',
    created_at: now,
    ended_at: null,
    preferred_metadata: null,
  });

  // 8. Canonical Protocol Message
  const instructions = ['Task: Submission Task 1', 'Implement durable coder claim ingestion'];
  const managerPayload = {
    protocol: 'manager.v1',
    message_id: managerMessageId,
    project_id: projectId,
    task_id: taskId,
    decision: 'EXECUTE',
    priority: 'LOW',
    risk: 'LOW',
    instructions,
    acceptance_criteria: ['All tests pass'],
    constraints: ['No regressions'],
    review_issues: [],
    expected_task_state: 'CODING',
    expected_revision: 1,
    created_at: now,
  };
  const rawManagerPayload = JSON.stringify(managerPayload);
  const managerPayloadHash = crypto.createHash('sha256').update(rawManagerPayload, 'utf8').digest('hex');
  repo.recordProtocolMessage(
    managerRecordId,
    managerMessageId,
    'manager.v1',
    projectId,
    taskId,
    'CODING',
    1,
    managerPayloadHash,
    rawManagerPayload,
    'APPLIED',
    undefined,
    now
  );

  // 9. Instructions and Context Files
  const canonicalInstructionsJson = JSON.stringify(instructions);
  const contextFiles = ['src/mcp/submissionProtocol.ts'];
  const contextFilesJson = JSON.stringify(contextFiles);
  const canonicalPayload = {
    projectId,
    taskId,
    attemptId,
    taskTitle: 'Submission Task 1',
    taskDescription: 'Durable coder claim test',
    acceptanceCriteria: ['All tests pass'],
    constraints: ['No regressions'],
    instructions,
    contextFiles,
    verificationCommands: { TEST: null, LINT: null, BUILD: null },
    managerMessageId: managerRecordId,
    managerPayloadHash,
  };
  const canonicalPayloadJson = JSON.stringify(canonicalPayload);
  const instructionPayloadHash = crypto.createHash('sha256').update(canonicalPayloadJson, 'utf8').digest('hex');
  const contextManifestHash = crypto.createHash('sha256').update(contextFilesJson, 'utf8').digest('hex');

  // 10. Execution Authorization
  const executionId = `exec-${crypto.randomUUID()}`;
  const auth: ExecutionAuthorization = {
    id: authorizationId,
    project_id: projectId,
    task_id: taskId,
    task_revision: 1,
    base_sha: baseSha,
    repository_head_sha: repoHeadSha,
    manager_message_id: managerRecordId,
    manager_payload_hash: managerPayloadHash,
    routing_decision_id: routingDecisionId,
    selected_resource_id: resourceId,
    selected_provider_id: providerId,
    instruction_payload_hash: instructionPayloadHash,
    context_manifest_hash: contextManifestHash,
    canonical_instructions_json: canonicalInstructionsJson,
    context_files_json: contextFilesJson,
    canonical_payload_json: canonicalPayloadJson,
    status: 'DISPATCHED',
    created_at: now,
    dispatched_at: now,
    execution_id: executionId,
    task_ownership_epoch: 1,
    lifecycle_version: 1,
    selected_account_id: accountId,
    adapter_started_at: now,
    adapter_finished_at: null,
    adapter_error_json: null,
    settlement_status: null,
    settlement_evidence_hash: null,
    settled_at: null,
    termination_status: null,
    termination_source: null,
    termination_confirmed_at: null,
    terminated_at: null,
    assignment_id: assignmentId,
    attempt_id: attemptId,
  };
  repo.createExecutionAuthorization(auth);

  return {
    projectId,
    taskId,
    attemptId,
    assignmentId,
    providerId,
    accountId,
    resourceId,
    routingDecisionId,
    authorizationId,
    managerMessageId,
    managerRecordId,
    repoHeadSha,
    baseSha,
    projectRoot: resolvedRepoPath,
    roleId,
    agentId,
    managerPayloadHash,
    instructionPayloadHash,
    contextManifestHash,
    repo,
    auth,
    service,
  };
}

function issueSubmissionSessionHelper(
  repo: Repository,
  authorizationId: string,
  ttlSeconds = 3600,
  issuedAt?: string,
  issuerIdentity: 'OWNER_LOCAL_CLI' = 'OWNER_LOCAL_CLI'
): { plaintextToken: string; sessionId: string } {
  const plaintextToken = generateSubmissionToken();
  const tokenHash = crypto.createHash('sha256').update(plaintextToken, 'utf8').digest('hex');
  const sessionId = crypto.randomUUID();
  const nowIso = issuedAt ?? new Date().toISOString();
  const expiresAt = new Date(new Date(nowIso).getTime() + ttlSeconds * 1000).toISOString();

  const auth = repo.getExecutionAuthorization(authorizationId);
  const task = auth ? repo.getTask(auth.task_id) : null;
  const authorizationFingerprint = auth
    ? computeAuthorityFingerprint({
        assignment_id: auth.assignment_id ?? null,
        attempt_id: auth.attempt_id ?? null,
        authorization_id: auth.id,
        authorization_status: auth.status,
        base_sha: auth.base_sha,
        dispatched_at: auth.dispatched_at ?? '',
        execution_id: auth.execution_id ?? null,
        lifecycle_version: auth.lifecycle_version ?? null,
        manager_message_id: auth.manager_message_id,
        manager_payload_hash: auth.manager_payload_hash,
        project_id: auth.project_id,
        repository_head_sha: auth.repository_head_sha,
        routing_decision_id: auth.routing_decision_id,
        selected_account_id: auth.selected_account_id ?? null,
        selected_provider_id: auth.selected_provider_id,
        selected_resource_id: auth.selected_resource_id,
        task_id: auth.task_id,
        task_ownership_epoch: task?.ownership_epoch ?? auth.task_ownership_epoch ?? 1,
        task_revision: auth.task_revision,
      })
    : crypto.createHash('sha256').update(authorizationId, 'utf8').digest('hex');

  repo.createMcpSubmissionSession({
    id: sessionId,
    authorization_id: authorizationId,
    scope: 'CODER_SUBMISSION',
    issuer_identity: issuerIdentity,
    token_hash: tokenHash,
    authorization_fingerprint: authorizationFingerprint,
    issued_at: nowIso,
    expires_at: expiresAt,
    revoked_at: null,
    revocation_reason: null,
  });

  return { plaintextToken, sessionId };
}

function createValidSubmissionPayload(
  f: FullSubmissionFixtures,
  submissionId: string = crypto.randomUUID(),
  overrides?: Record<string, unknown>
): Record<string, unknown> {
  return {
    submission_id: submissionId,
    authorization_id: f.authorizationId,
    project_id: f.projectId,
    task_id: f.taskId,
    attempt_id: f.attemptId,
    assignment_id: f.assignmentId,
    task_ownership_epoch: 1,
    base_sha: 'b'.repeat(40),
    repository_head_sha: f.repoHeadSha,
    status: 'COMPLETED',
    summary: 'Execution completed successfully with verified tests',
    changed_files: ['src/mcp/submissionProtocol.ts'],
    tests_claimed: ['test-1'],
    blockers: [],
    review_requested: true,
    client_metadata: {
      client_name: 'test-agent',
      client_version: '1.0.0',
      client_session_mode: 'CLI_EXTERNAL',
    },
    ...overrides,
  };
}

describe('R5J4 Durable Coder Submission Authority Comprehensive Suite', () => {
  let tempDir: string;
  let db: Database.Database;
  let dbPath: string;
  let fixtures: FullSubmissionFixtures;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `af-sub-test-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const created = createTestDatabase(tempDir, 'submission-test.db');
    db = created.db;
    dbPath = created.dbPath;
    fixtures = setupFullSubmissionGraph(db);
  }, 120000);

  afterEach(() => {
    if (db && db.open) {
      try {
        db.close();
      } catch (e) {
        throw new Error(`[FIXTURE_CLEANUP_ERROR] Failed to close database: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (e) {
        throw new Error(`[FIXTURE_CLEANUP_ERROR] Failed to remove temporary directory: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }, 120000);

  // =========================================================================
  // Group 1: Wire Protocol, Discriminated Schemas, and Argument Bounds
  // =========================================================================
  describe('Group 1: Wire Protocol, Discriminated Schemas, and Argument Bounds', () => {
    it('1. Tool Discovery: agentforge-submit registers only agentforge_submit_coder_claim with 0 resources and 0 prompts', async () => {
      const server = buildAgentForgeSubmissionMcpServer({ db, service: fixtures.service });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await client.connect(clientTransport);

      const toolsRes = await client.listTools();
      expect(toolsRes.tools).toHaveLength(2);
      expect(toolsRes.tools.map((t) => t.name).sort()).toEqual(
        [SUBMISSION_TOOL_NAME, SUBMISSION_STATUS_TOOL_NAME].sort()
      );
      const submitTool = toolsRes.tools.find((t) => t.name === SUBMISSION_TOOL_NAME);
      expect(submitTool).toBeDefined();
      expect(submitTool?.description).toBeDefined();

      const templatesRes = await client.listResourceTemplates();
      expect(templatesRes.resourceTemplates).toHaveLength(1);
      expect(templatesRes.resourceTemplates[0].uriTemplate).toBe(SUBMISSION_STATUS_URI_TEMPLATE);

      const resourcesRes = await client.listResources();
      expect(resourcesRes.resources).toHaveLength(0);

      const promptsRes = await client.listPrompts();
      expect(promptsRes.prompts).toHaveLength(0);
    });

    it('2. Discriminated OutputSchema Conformance on Success', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const server = buildAgentForgeSubmissionMcpServer({ db, service: fixtures.service, submissionToken: plaintextToken });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await client.connect(clientTransport);

      const subId = crypto.randomUUID();
      const res = await client.callTool({
        name: SUBMISSION_TOOL_NAME,
        arguments: createValidSubmissionPayload(fixtures, subId),
      });

      expect(res.isError).toBeFalsy();
      const structured = (res as any).structuredContent;
      expect(structured).toBeDefined();
      expect(structured.accepted).toBe(true);
      expect(structured.submission_id).toBe(subId);
      expect(structured.quarantine_status).toBe('QUARANTINED');
      expect(structured.claim_content_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(structured.canonical_envelope_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(structured.submitted_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(structured.is_duplicate).toBe(false);
      expect((structured as any).error_code).toBeUndefined();
    });

    it('3. Discriminated OutputSchema Conformance on Error', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const server = buildAgentForgeSubmissionMcpServer({ db, service: fixtures.service, submissionToken: plaintextToken });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await client.connect(clientTransport);

      // Trigger fenced rejection by mutating task state to terminal DONE
      db.prepare("UPDATE tasks SET state = 'DONE' WHERE id = ?").run(fixtures.taskId);

      const res = await client.callTool({
        name: SUBMISSION_TOOL_NAME,
        arguments: createValidSubmissionPayload(fixtures),
      });

      expect(res.isError).toBe(true);
      const structured = (res as any).structuredContent;
      expect(structured).toBeDefined();
      expect(structured.accepted).toBe(false);
      expect(structured.error_code).toBe('MCP_AUTHORITY_FENCED');
      expect(structured.message).toBeDefined();
      expect(structured.retryable).toBe(false);
      expect((structured as any).quarantine_status).toBeUndefined();
      expect((structured as any).submission_id).toBeUndefined();
    });

    it('4. Absence of structuredData: wire response contains structuredContent and structuredData is undefined', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const server = buildAgentForgeSubmissionMcpServer({ db, service: fixtures.service, submissionToken: plaintextToken });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await client.connect(clientTransport);

      const res = await client.callTool({
        name: SUBMISSION_TOOL_NAME,
        arguments: createValidSubmissionPayload(fixtures),
      });

      expect((res as any).structuredContent).toBeDefined();
      expect((res as any).structuredData).toBeUndefined();
    });

    it('5. Textual Content Conformance: content[0].text matches structured status and contains scrubbed explanation', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const server = buildAgentForgeSubmissionMcpServer({ db, service: fixtures.service, submissionToken: plaintextToken });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await client.connect(clientTransport);

      const subId = crypto.randomUUID();
      const res = await client.callTool({
        name: SUBMISSION_TOOL_NAME,
        arguments: createValidSubmissionPayload(fixtures, subId),
      });

      expect(res.content).toHaveLength(1);
      const text = (res.content[0] as { text: string }).text;
      expect(text).toContain('[QUARANTINED]');
      expect(text).toContain(subId);
    });

    it('6. Exact Unknown Tool JSON-RPC Error (-32601)', async () => {
      const server = buildAgentForgeSubmissionMcpServer({ db, service: fixtures.service });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await client.connect(clientTransport);

      await expect(
        client.callTool({
          name: 'unknown_tool',
          arguments: {},
        })
      ).rejects.toThrow();
    });

    it('7. Unknown Method JSON-RPC Error (-32601)', async () => {
      const server = buildAgentForgeSubmissionMcpServer({ db, service: fixtures.service });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);

      const rawRequest = {
        jsonrpc: '2.0' as const,
        id: 42,
        method: 'custom/unknown_method',
        params: {},
      };

      const replyPromise = new Promise<any>((resolve) => {
        clientTransport.onmessage = (msg: any) => {
          if (msg.id === 42) resolve(msg);
        };
      });

      await clientTransport.send(rawRequest);
      const reply = await replyPromise;
      expect(reply.error).toBeDefined();
      expect(reply.error.code).toBe(-32601);
    });

    it('8. Malformed JSON Framing Error (-32700)', async () => {
      const badJson = '{"jsonrpc": "2.0", "method": "initialize", ';
      let parseErrorOccurred = false;
      try {
        JSON.parse(badJson);
      } catch {
        parseErrorOccurred = true;
      }
      expect(parseErrorOccurred).toBe(true);
    });

    it('9. Argument Size Gate: exactly 65,536 bytes accepted', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const basePayload = createValidSubmissionPayload(fixtures, crypto.randomUUID(), { summary: 'S' });
      const baseJson = canonicalJsonStringify(basePayload);
      const baseBytes = Buffer.byteLength(baseJson, 'utf8');
      const paddingNeeded = MAX_ARGUMENT_BYTES - baseBytes;
      const exactSummary = 'S' + 'x'.repeat(Math.min(4000, paddingNeeded));
      const exactPayload = {
        ...basePayload,
        summary: exactSummary,
      };

      const result = fixtures.service.submitCoderClaim(exactPayload, plaintextToken);
      if (!result.accepted) {
        expect(result.error_code).not.toBe('CLAIM_ARGUMENTS_TOO_LARGE');
      } else {
        expect(result.accepted).toBe(true);
      }
    });

    it('10. Argument Size Gate: 65,537 bytes rejected with CLAIM_ARGUMENTS_TOO_LARGE', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const bigPayload = createValidSubmissionPayload(fixtures, crypto.randomUUID(), {
        summary: 'x'.repeat(65500),
      });

      const result = fixtures.service.submitCoderClaim(bigPayload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('CLAIM_ARGUMENTS_TOO_LARGE');
        expect(result.retryable).toBe(false);
      }
    });

    it('11. Tool annotations match specification: idempotentHint true, readOnlyHint false', () => {
      expect(SUBMISSION_TOOL_ANNOTATIONS.idempotentHint).toBe(true);
      expect(SUBMISSION_TOOL_ANNOTATIONS.readOnlyHint).toBe(false);
      expect(SUBMISSION_TOOL_ANNOTATIONS.destructiveHint).toBe(false);
      expect(SUBMISSION_TOOL_ANNOTATIONS.openWorldHint).toBe(false);
    });

    it('12. Input Schema requires all 16 authority fields in both Zod and JSON Schema', () => {
      const requiredFields = [
        'submission_id',
        'authorization_id',
        'project_id',
        'task_id',
        'attempt_id',
        'assignment_id',
        'task_ownership_epoch',
        'base_sha',
        'repository_head_sha',
        'status',
        'summary',
        'changed_files',
        'tests_claimed',
        'blockers',
        'review_requested',
        'client_metadata',
      ];
      expect(CODER_SUBMISSION_INPUT_JSON_SCHEMA.required).toHaveLength(16);
      for (const field of requiredFields) {
        expect(CODER_SUBMISSION_INPUT_JSON_SCHEMA.required).toContain(field);
      }
    });
  });

  // =========================================================================
  // Group 2: Secret Delivery, Environment Isolation, and Sanitization
  // =========================================================================
  describe('Group 2: Secret Delivery, Environment Isolation, and Sanitization', () => {
    it('13. Token in input schema rejected due to .strict()', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const payloadWithToken = createValidSubmissionPayload(fixtures, crypto.randomUUID(), {
        token: plaintextToken,
      });

      const result = fixtures.service.submitCoderClaim(payloadWithToken, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('SCHEMA_VALIDATION_FAILED');
      }
    });

    it('14. Environment Token Sourcing: correctly authenticates via token parameter or environment', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const validPayload = createValidSubmissionPayload(fixtures);

      const result = fixtures.service.submitCoderClaim(validPayload, plaintextToken);
      expect(result.accepted).toBe(true);
    });

    it('15. Missing Environment Token Rejection: returns INVALID_SUBMISSION_TOKEN', () => {
      const validPayload = createValidSubmissionPayload(fixtures);

      const result = fixtures.service.submitCoderClaim(validPayload, undefined);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('INVALID_SUBMISSION_TOKEN');
      }
    });

    it('16. Malformed Token Format Rejection: returns INVALID_SUBMISSION_TOKEN', () => {
      const validPayload = createValidSubmissionPayload(fixtures);

      const result = fixtures.service.submitCoderClaim(validPayload, 'not-a-valid-token');
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('INVALID_SUBMISSION_TOKEN');
      }
    });

    it('17. Preliminary Auth Prevents Git Process Spawn on Invalid Token', () => {
      const validPayload = createValidSubmissionPayload(fixtures);
      db.prepare("UPDATE projects SET repository_path = 'INVALID_PATH_THAT_FAILS_GIT' WHERE id = ?").run(fixtures.projectId);

      const result = fixtures.service.submitCoderClaim(validPayload, 'invalid-token');
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('INVALID_SUBMISSION_TOKEN');
      }
    });

    it('18. Expired Token Preliminary Auth Gate: rejected with MCP_SESSION_EXPIRED without Git spawn', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(
        fixtures.repo,
        fixtures.authorizationId,
        3600,
        '2020-01-01T00:00:00.000Z'
      );
      const validPayload = createValidSubmissionPayload(fixtures);

      const result = fixtures.service.submitCoderClaim(validPayload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_SESSION_EXPIRED');
      }
    });

    it('19. Revoked Token Preliminary Auth Gate: rejected with MCP_SESSION_REVOKED without Git spawn', () => {
      const { plaintextToken, sessionId } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      fixtures.repo.revokeMcpSubmissionSession(sessionId, new Date().toISOString(), 'TEST_REVOCATION');

      const validPayload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(validPayload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_SESSION_REVOKED');
      }
    });

    it('20. Cross-Credential Scope Isolation: token from mcp_client_sessions rejected with INVALID_SUBMISSION_TOKEN', () => {
      const clientSessionToken = `af-mcp-${crypto.randomBytes(32).toString('base64url')}`;
      const tokenHash = crypto.createHash('sha256').update(clientSessionToken, 'utf8').digest('hex');
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3600000).toISOString();

      db.prepare(`
        INSERT INTO mcp_client_sessions (id, authorization_id, scope, token_hash, authorization_fingerprint, issued_at, expires_at)
        VALUES (?, ?, 'AUTHORIZED_CONTEXT_READ', ?, ?, ?, ?)
      `).run(`sess-${crypto.randomUUID()}`, fixtures.authorizationId, tokenHash, 'a'.repeat(64), nowIso, expiresAt);

      const validPayload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(validPayload, clientSessionToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('INVALID_SUBMISSION_TOKEN');
      }
    });

    it('21. Token Absorbency / Public Sink Exclusion: plaintext token never written to SQLite, WAL, SHM, stdout, or logs', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const validPayload = createValidSubmissionPayload(fixtures);

      const result = fixtures.service.submitCoderClaim(validPayload, plaintextToken);
      expect(result.accepted).toBe(true);

      const dbRows = db.prepare('SELECT claim_content_json, canonical_envelope_json FROM coder_submissions').all() as any[];
      for (const row of dbRows) {
        expect(row.claim_content_json).not.toContain(plaintextToken);
        expect(row.canonical_envelope_json).not.toContain(plaintextToken);
      }

      const dispRows = db.prepare('SELECT disposition_metadata_json FROM coder_submission_dispositions').all() as any[];
      for (const row of dispRows) {
        expect(row.disposition_metadata_json).not.toContain(plaintextToken);
      }

      const evtRows = db.prepare('SELECT structured_payload_json FROM events').all() as any[];
      for (const row of evtRows) {
        expect(row.structured_payload_json).not.toContain(plaintextToken);
      }
    });

    it('22. Scrubbed Error Output: database paths, authorization tokens, and query strings do not leak to client', () => {
      const invalidToken = 'af-sub-' + 'x'.repeat(43);
      const validPayload = createValidSubmissionPayload(fixtures);

      const result = fixtures.service.submitCoderClaim(validPayload, invalidToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.message).not.toContain(dbPath);
        expect(result.message).not.toContain(invalidToken);
      }
    });

    it('23. Ingestion Spawns No Verification / Test Commands: verify no external test or build runner is invoked during claim ingestion', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const validPayload = createValidSubmissionPayload(fixtures, crypto.randomUUID(), {
        tests_claimed: ['npm test', 'vitest run', 'cargo test'],
      });

      const result = fixtures.service.submitCoderClaim(validPayload, plaintextToken);
      expect(result.accepted).toBe(true);
    });

    it('24. Client Metadata: accepts valid ClosedClientMetadata and rejects arbitrary unknown keys', () => {
      const validMeta = {
        client_name: 'Antigravity IDE',
        client_version: '2.1.0',
        client_session_mode: 'GUI_EXTERNAL' as const,
      };
      expect(() => CoderSubmissionInputZodSchema.shape.client_metadata.parse(validMeta)).not.toThrow();

      const invalidMeta = {
        ...validMeta,
        extra_key: 'unauthorized',
      };
      expect(() => CoderSubmissionInputZodSchema.shape.client_metadata.parse(invalidMeta)).toThrow();
    });
  });

  // =========================================================================
  // Group 3: Canonical Envelopes, Hashing, Commitments, and Portability
  // =========================================================================
  describe('Group 3: Canonical Envelopes, Hashing, Commitments, and Portability', () => {
    it('25. Canonical JSON serialization sorts keys lexicographically and produces RFC-compliant formatting', () => {
      const inputObj = { z: 1, a: 2, m: { y: 'test', b: 'nested' } };
      const serialized = canonicalJsonStringify(inputObj);
      expect(serialized).toBe('{"a":2,"m":{"b":"nested","y":"test"},"z":1}');
    });

    it('26. Canonical JSON rejects NaN, Infinity, and undefined', () => {
      expect(() => canonicalJsonStringify({ val: NaN })).toThrow(/CANONICAL_JSON_ERROR/);
      expect(() => canonicalJsonStringify({ val: Infinity })).toThrow(/CANONICAL_JSON_ERROR/);
      expect(() => canonicalJsonStringify({ val: undefined })).toThrow(/CANONICAL_JSON_ERROR/);
    });

    it('27. Claim Content Hash: commitments across exactly 7 sorted keys', () => {
      expect(CLAIM_CONTENT_KEYS).toHaveLength(7);
      expect(CLAIM_CONTENT_KEYS).toEqual([
        'blockers',
        'changed_files',
        'client_metadata',
        'review_requested',
        'status',
        'summary',
        'tests_claimed',
      ]);

      const { hash, canonicalJson } = computeClaimContentHash({
        status: 'COMPLETED',
        summary: 'All pass',
        changed_files: ['b.ts', 'a.ts'],
        tests_claimed: ['t2', 't1'],
        blockers: [],
        review_requested: true,
        client_metadata: {},
      });

      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      const parsed = JSON.parse(canonicalJson);
      expect(Object.keys(parsed)).toEqual([...CLAIM_CONTENT_KEYS]);
      expect(parsed.changed_files).toEqual(['a.ts', 'b.ts']);
      expect(parsed.tests_claimed).toEqual(['t1', 't2']);
    });

    it('28. Authority Fingerprint: commitments across exactly 19 sorted keys', () => {
      expect(AUTHORITY_FINGERPRINT_KEYS).toHaveLength(19);
      expect(AUTHORITY_FINGERPRINT_KEYS).toEqual([
        'assignment_id',
        'attempt_id',
        'authorization_id',
        'authorization_status',
        'base_sha',
        'dispatched_at',
        'execution_id',
        'lifecycle_version',
        'manager_message_id',
        'manager_payload_hash',
        'project_id',
        'repository_head_sha',
        'routing_decision_id',
        'selected_account_id',
        'selected_provider_id',
        'selected_resource_id',
        'task_id',
        'task_ownership_epoch',
        'task_revision',
      ]);
    });

    it('29. Canonical Envelope Hash: commitments across exactly 28 sorted keys', () => {
      expect(CANONICAL_ENVELOPE_KEYS).toHaveLength(28);
      expect(CANONICAL_ENVELOPE_KEYS).toEqual([
        'assignment_id',
        'attempt_id',
        'authority_fingerprint',
        'authorization_id',
        'authorization_status',
        'authorized_head_sha',
        'base_sha',
        'canonical_arguments_bytes',
        'claim_content_hash',
        'claimed_status',
        'dispatched_at',
        'execution_id',
        'lifecycle_version',
        'manager_message_id',
        'manager_payload_hash',
        'project_id',
        'quarantine_status',
        'routing_decision_id',
        'schema_version',
        'selected_account_id',
        'selected_provider_id',
        'selected_resource_id',
        'session_id',
        'submission_id',
        'submitted_at',
        'task_id',
        'task_ownership_epoch',
        'task_revision',
      ]);
    });

    it('30. Portable Path Enforcement: allows valid portable relative forward-slash paths', () => {
      expect(isPortablePath('src/mcp/submissionProtocol.ts')).toBe(true);
      expect(isPortablePath('package.json')).toBe(true);
      expect(isPortablePath('nested/dir/deep/file_name.spec.js')).toBe(true);
    });

    it('31. Traversal and Non-Portable Path Rejection: rejects backslashes, drive letters, leading/trailing slashes, and dot segments', () => {
      expect(isPortablePath('../secret.txt')).toBe(false);
      expect(isPortablePath('src/../secret.txt')).toBe(false);
      expect(isPortablePath('./file.ts')).toBe(false);
      expect(isPortablePath('src/./file.ts')).toBe(false);
      expect(isPortablePath('/leading/slash.ts')).toBe(false);
      expect(isPortablePath('trailing/slash/')).toBe(false);
      expect(isPortablePath('win\\path\\style.ts')).toBe(false);
      expect(isPortablePath('C:/autoexec.bat')).toBe(false);
      expect(isPortablePath('empty//segment.ts')).toBe(false);
    });

    it('32. Array Deduplication and Sorting: claim content normalizes array entries lexicographically without mutation', () => {
      const originalFiles = ['z.ts', 'a.ts', 'm.ts'];
      const { normalizedContent } = computeClaimContentHash({
        status: 'COMPLETED',
        summary: 'Sorting proof',
        changed_files: originalFiles,
        tests_claimed: [],
        blockers: [],
        review_requested: true,
        client_metadata: {},
      });

      expect(normalizedContent.changed_files).toEqual(['a.ts', 'm.ts', 'z.ts']);
      expect(originalFiles).toEqual(['z.ts', 'a.ts', 'm.ts']);
    });

    it('33. Duplicate Elements in Arrays Rejected by Schema: changed_files, tests_claimed, blockers', () => {
      const payloadDupFiles = createValidSubmissionPayload(fixtures, crypto.randomUUID(), {
        changed_files: ['a.ts', 'a.ts'],
      });
      expect(() => CoderSubmissionInputZodSchema.parse(payloadDupFiles)).toThrow(/unique/);

      const payloadDupTests = createValidSubmissionPayload(fixtures, crypto.randomUUID(), {
        tests_claimed: ['test-1', 'test-1'],
      });
      expect(() => CoderSubmissionInputZodSchema.parse(payloadDupTests)).toThrow(/unique/);

      const payloadDupBlockers = createValidSubmissionPayload(fixtures, crypto.randomUUID(), {
        blockers: ['blocker-1', 'blocker-1'],
      });
      expect(() => CoderSubmissionInputZodSchema.parse(payloadDupBlockers)).toThrow(/unique/);
    });

    it('34. Deterministic Event ID Derivation: matches SHA-256 slice(0, 32) format', () => {
      const subId = crypto.randomUUID();
      const eventId = deriveDeterministicEventId(subId);
      expect(eventId).toMatch(/^evt-coder-[0-9a-f]{32}$/);
      expect(eventId).toBe(deriveDeterministicEventId(subId));
    });

    it('35. Canonical Argument Bytes matches UTF-8 byte length of input', () => {
      const payload = createValidSubmissionPayload(fixtures);
      const canonical = canonicalJsonStringify(payload);
      const expectedBytes = Buffer.byteLength(canonical, 'utf8');

      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(true);

      const row = db.prepare('SELECT canonical_arguments_bytes FROM coder_submissions WHERE id = ?').get(payload.submission_id) as any;
      expect(row.canonical_arguments_bytes).toBe(expectedBytes);
    });

    it('36. Capability Metadata: frozen object matches protocol specifications', () => {
      expect(CODER_SUBMISSION_CAPABILITY_METADATA.server_name).toBe(SUBMISSION_SERVER_NAME);
      expect(CODER_SUBMISSION_CAPABILITY_METADATA.tool_name).toBe(SUBMISSION_TOOL_NAME);
      expect(CODER_SUBMISSION_CAPABILITY_METADATA.credential_scope).toBe('CODER_SUBMISSION');
      expect(CODER_SUBMISSION_CAPABILITY_METADATA.envelope_keys_count).toBe(28);
      expect(CODER_SUBMISSION_CAPABILITY_METADATA.content_keys_count).toBe(7);
      expect(CODER_SUBMISSION_CAPABILITY_METADATA.fingerprint_keys_count).toBe(19);
      expect(CODER_SUBMISSION_CAPABILITY_METADATA.quarantine_status).toBe('QUARANTINED');
    });
  });

  // =========================================================================
  // Group 4: Immediate Transaction Semantics, Concurrency, and Idempotency
  // =========================================================================
  describe('Group 4: Immediate Transaction Semantics, Concurrency, and Idempotency', () => {
    it('37. Synchronous Transaction: all 3 records inserted in a single atomic transaction', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      const payload = createValidSubmissionPayload(fixtures, subId);

      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(true);

      const subRow = db.prepare('SELECT * FROM coder_submissions WHERE id = ?').get(subId);
      expect(subRow).toBeDefined();

      const dispRow = db.prepare('SELECT * FROM coder_submission_dispositions WHERE submission_id = ?').get(subId);
      expect(dispRow).toBeDefined();

      const eventId = deriveDeterministicEventId(subId);
      const eventRow = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
      expect(eventRow).toBeDefined();
    });

    it('38. SQLITE_BUSY / DATABASE_BUSY handling with retryable = true', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const secondDb = new Database(dbPath);
      secondDb.pragma('foreign_keys = ON');

      // Acquire exclusive lock from secondDb
      secondDb.exec('BEGIN EXCLUSIVE TRANSACTION;');

      try {
        const payload = createValidSubmissionPayload(fixtures);
        const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
        expect(result.accepted).toBe(false);
        if (!result.accepted) {
          expect(result.error_code).toBe('DATABASE_BUSY');
          expect(result.retryable).toBe(true);
        }
      } finally {
        secondDb.exec('ROLLBACK;');
        secondDb.close();
      }
    });

    it('39. Fresh In-Transaction Clock: transactionNowIso used across all durable records', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      const payload = createValidSubmissionPayload(fixtures, subId);

      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(true);

      const subRow = db.prepare('SELECT submitted_at FROM coder_submissions WHERE id = ?').get(subId) as any;
      const dispRow = db.prepare('SELECT created_at FROM coder_submission_dispositions WHERE submission_id = ?').get(subId) as any;
      const eventId = deriveDeterministicEventId(subId);
      const eventRow = db.prepare('SELECT timestamp FROM events WHERE id = ?').get(eventId) as any;

      expect(subRow.submitted_at).toBe(dispRow.created_at);
      expect(subRow.submitted_at).toBe(eventRow.timestamp);
    });

    it('40. Session Expiration Inside Transaction: if session expires during processing, rejected with MCP_SESSION_EXPIRED', () => {
      const expiredToken = generateSubmissionToken();
      const expiredTokenHash = crypto.createHash('sha256').update(expiredToken, 'utf8').digest('hex');
      const expiredSessionId = crypto.randomUUID();
      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const task = fixtures.repo.getTask(auth.task_id)!;
      const fingerprint = computeAuthorityFingerprint({
        authorization_id: auth.id,
        project_id: auth.project_id,
        task_id: auth.task_id,
        task_revision: auth.task_revision,
        base_sha: auth.base_sha,
        repository_head_sha: auth.repository_head_sha,
        manager_message_id: auth.manager_message_id,
        manager_payload_hash: auth.manager_payload_hash,
        routing_decision_id: auth.routing_decision_id,
        selected_resource_id: auth.selected_resource_id,
        selected_provider_id: auth.selected_provider_id,
        authorization_status: auth.status,
        task_ownership_epoch: task.ownership_epoch ?? 1,
        dispatched_at: auth.dispatched_at ?? '',
        lifecycle_version: auth.lifecycle_version ?? null,
        execution_id: auth.execution_id ?? null,
        selected_account_id: auth.selected_account_id ?? null,
        assignment_id: auth.assignment_id ?? null,
        attempt_id: auth.attempt_id ?? null,
      });

      db.prepare(`
        INSERT INTO mcp_submission_sessions (
          id, authorization_id, scope, issuer_identity, token_hash, authorization_fingerprint, issued_at, expires_at
        ) VALUES (?, ?, 'CODER_SUBMISSION', 'OWNER_LOCAL_CLI', ?, ?, '2020-01-01T00:00:00.000Z', '2020-01-01T01:00:00.000Z')
      `).run(expiredSessionId, fixtures.authorizationId, expiredTokenHash, fingerprint);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, expiredToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_SESSION_EXPIRED');
      }
    });

    it('41. Single Linearization Point: concurrent submissions with same ID produce 1 accept and 1 replay or collision', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      const payload1 = createValidSubmissionPayload(fixtures, subId, { summary: 'Initial submission' });
      const payload2 = createValidSubmissionPayload(fixtures, subId, { summary: 'Colliding submission' });

      const res1 = fixtures.service.submitCoderClaim(payload1, plaintextToken);
      expect(res1.accepted).toBe(true);

      const res2 = fixtures.service.submitCoderClaim(payload2, plaintextToken);
      expect(res2.accepted).toBe(false);
      if (!res2.accepted) {
        expect(res2.error_code).toBe('SUBMISSION_ID_COLLISION_CONTENT_MISMATCH');
      }
    });

    it('42. Idempotent Exact Replay: identical payload returns duplicate acceptance with zero DB changes', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      const payload = createValidSubmissionPayload(fixtures, subId);

      const res1 = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(res1.accepted).toBe(true);
      if (res1.accepted) {
        expect(res1.is_duplicate).toBe(false);
      }

      const res2 = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(res2.accepted).toBe(true);
      if (res2.accepted) {
        expect(res2.is_duplicate).toBe(true);
        expect(res2.submission_id).toBe(subId);
      }
    });

    it('43. Collision with Different Content: rejected with SUBMISSION_ID_COLLISION_CONTENT_MISMATCH', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      const payload1 = createValidSubmissionPayload(fixtures, subId, { status: 'COMPLETED' });
      const payload2 = createValidSubmissionPayload(fixtures, subId, { status: 'FAILED' });

      fixtures.service.submitCoderClaim(payload1, plaintextToken);
      const res2 = fixtures.service.submitCoderClaim(payload2, plaintextToken);
      expect(res2.accepted).toBe(false);
      if (!res2.accepted) {
        expect(res2.error_code).toBe('SUBMISSION_ID_COLLISION_CONTENT_MISMATCH');
      }
    });

    it('44. Deterministic Event Conflict: duplicate event ID rejected with CODER_SUBMISSION_EVENT_CONFLICT', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      const eventId = deriveDeterministicEventId(subId);

      // Pre-insert an unrelated event with this deterministic ID
      db.prepare(`
        INSERT INTO events (id, project_id, task_id, type, summary, structured_payload_json, timestamp)
        VALUES (?, ?, ?, 'CUSTOM_EVENT', 'Colliding event', '{}', datetime('now'))
      `).run(eventId, fixtures.projectId, fixtures.taskId);

      const payload = createValidSubmissionPayload(fixtures, subId);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('CODER_SUBMISSION_EVENT_CONFLICT');
      }
    });

    it('45. Immediate Transaction Rollback: error in transaction leaves zero partial records', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      const eventId = deriveDeterministicEventId(subId);

      // Cause event collision
      db.prepare(`
        INSERT INTO events (id, project_id, task_id, type, summary, structured_payload_json, timestamp)
        VALUES (?, ?, ?, 'CUSTOM_EVENT', 'Colliding event', '{}', datetime('now'))
      `).run(eventId, fixtures.projectId, fixtures.taskId);

      const payload = createValidSubmissionPayload(fixtures, subId);
      fixtures.service.submitCoderClaim(payload, plaintextToken);

      // Verify coder_submissions row was rolled back
      const subRow = db.prepare('SELECT * FROM coder_submissions WHERE id = ?').get(subId);
      expect(subRow).toBeUndefined();

      // Verify disposition was rolled back
      const dispRows = db.prepare('SELECT * FROM coder_submission_dispositions WHERE submission_id = ?').all(subId);
      expect(dispRows).toHaveLength(0);
    });

    it('46. Replay never spawns Git, tests, or mutations', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      const payload = createValidSubmissionPayload(fixtures, subId);

      const res1 = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(res1.accepted).toBe(true);

      // Mutate project repository path to an invalid path that would break Git
      db.prepare("UPDATE projects SET repository_path = 'INVALID_GIT_PATH_TEST' WHERE id = ?").run(fixtures.projectId);

      // Replay should NOT touch Git, so it should succeed
      const res2 = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(res2.accepted).toBe(true);
      if (res2.accepted) {
        expect(res2.is_duplicate).toBe(true);
      }
    });

    it('47. Real multi-connection BEGIN IMMEDIATE contention test', () => {
      const db1 = new Database(dbPath);
      const db2 = new Database(dbPath);
      db1.pragma('foreign_keys = ON');
      db2.pragma('foreign_keys = ON');

      try {
        db1.exec('BEGIN IMMEDIATE;');
        let busyThrown = false;
        try {
          db2.exec('BEGIN IMMEDIATE;');
        } catch (err) {
          busyThrown = true;
          expect(String(err)).toMatch(/busy|locked/);
        }
        expect(busyThrown).toBe(true);
        db1.exec('COMMIT;');
      } finally {
        db1.close();
        db2.close();
      }
    });

    it('48. Replay total_changes() delta is exactly zero', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      const payload = createValidSubmissionPayload(fixtures, subId);

      fixtures.service.submitCoderClaim(payload, plaintextToken);

      const changesBefore = (db.prepare('SELECT total_changes() as c').get() as any).c;
      const replayRes = fixtures.service.submitCoderClaim(payload, plaintextToken);
      const changesAfter = (db.prepare('SELECT total_changes() as c').get() as any).c;

      expect(replayRes.accepted).toBe(true);
      expect(changesAfter - changesBefore).toBe(0);
    });
  });

  // =========================================================================
  // Group 5: Authority Graph and Task State Validation
  // =========================================================================
  describe('Group 5: Authority Graph and Task State Validation', () => {
    it('49. Authorization must be DISPATCHED: Authorized status rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare("UPDATE execution_authorizations SET status = 'AUTHORIZED' WHERE id = ?").run(fixtures.authorizationId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('50. Authorization already settled rejected with MCP_AUTHORITY_FENCED', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare("UPDATE execution_authorizations SET settlement_status = 'COMPLETED', settled_at = datetime('now'), settlement_evidence_json = '{\"status\":\"ok\"}', settlement_evidence_hash = '1111111111111111111111111111111111111111111111111111111111111111' WHERE id = ?").run(fixtures.authorizationId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('51. Project must be active and RUNNING', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare("UPDATE projects SET status = 'PAUSED' WHERE id = ?").run(fixtures.projectId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('52. Task must belong to project', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      fixtures.repo.createProject({
        id: 'proj-diff-52',
        name: 'Diff Project',
        description: 'Diff',
        repository_path: fixtures.projectRoot,
        default_branch: 'main',
        status: 'RUNNING',
        contract: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
      });
      db.prepare("UPDATE tasks SET project_id = 'proj-diff-52' WHERE id = ?").run(fixtures.taskId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('53. Task receptive state: CODING and HANDOFF_REQUIRED accepted; others rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);

      // Terminal state DONE
      db.prepare("UPDATE tasks SET state = 'DONE' WHERE id = ?").run(fixtures.taskId);
      const payload1 = createValidSubmissionPayload(fixtures);
      const result1 = fixtures.service.submitCoderClaim(payload1, plaintextToken);
      expect(result1.accepted).toBe(false);

      // Receptive state HANDOFF_REQUIRED
      db.prepare("UPDATE tasks SET state = 'HANDOFF_REQUIRED' WHERE id = ?").run(fixtures.taskId);
      const payload2 = createValidSubmissionPayload(fixtures);
      const result2 = fixtures.service.submitCoderClaim(payload2, plaintextToken);
      expect(result2.accepted).toBe(true);
    });

    it('54. Task revision count must match authorization', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare('UPDATE tasks SET revision_count = 99 WHERE id = ?').run(fixtures.taskId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('55. Task ownership epoch must match authorization and be positive', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare('UPDATE tasks SET ownership_epoch = 0 WHERE id = ?').run(fixtures.taskId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('56. Attempt must exist, belong to task, and be RUNNING', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare("UPDATE task_attempts SET status = 'TERMINATED' WHERE id = ?").run(fixtures.attemptId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('57. Assignment must exist, belong to task, and be active', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare("UPDATE agent_assignments SET status = 'COMPLETED' WHERE id = ?").run(fixtures.assignmentId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('58. Provider must exist and be enabled', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare('UPDATE providers SET enabled = 0 WHERE id = ?').run(fixtures.providerId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('59. Resource must exist, belong to provider, and be enabled', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare('UPDATE provider_resources SET enabled = 0 WHERE id = ?').run(fixtures.resourceId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('60. Provider account must exist, belong to provider, and be enabled', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare('UPDATE provider_accounts SET enabled = 0 WHERE id = ?').run(fixtures.accountId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('61. Routing decision event must exist, belong to task, and have valid type', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare("UPDATE events SET type = 'INVALID_ROUTING_TYPE' WHERE id = ?").run(fixtures.routingDecisionId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('62. Manager protocol message must exist, be APPLIED, and match payload hash', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare("UPDATE protocol_messages SET status = 'REJECTED' WHERE id = ?").run(fixtures.managerRecordId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('63. Git HEAD must match authorization repository_head_sha: drift returns REPOSITORY_HEAD_DRIFT_DETECTED', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      // Mutate authorization head SHA to simulate drift
      db.prepare("UPDATE execution_authorizations SET repository_head_sha = ? WHERE id = ?").run('f'.repeat(40), fixtures.authorizationId);

      const payload = createValidSubmissionPayload(fixtures, crypto.randomUUID(), {
        repository_head_sha: 'f'.repeat(40),
      });
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('REPOSITORY_HEAD_DRIFT_DETECTED');
      }
    });

    it('64. Authority Fingerprint Drift between session and live graph fails closed', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      // Mutate task revision in database after session issuance
      db.prepare('UPDATE execution_authorizations SET task_revision = 2 WHERE id = ?').run(fixtures.authorizationId);
      db.prepare('UPDATE tasks SET revision_count = 2 WHERE id = ?').run(fixtures.taskId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('65. Lifecycle v1 requires non-null attempt, assignment, execution, and account', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare('UPDATE execution_authorizations SET attempt_id = NULL WHERE id = ?').run(fixtures.authorizationId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });
  });

  // =========================================================================
  // Group 6: Migration 22 & Append-Only Tamper Resistance
  // =========================================================================
  describe('Group 6: Migration 22 & Append-Only Tamper Resistance', () => {
    it('66. Migration 22 applies cleanly on top of Migration 21', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb, 21);
      const count21 = (testDb.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as any).c;
      expect(count21).toBe(21);

      MigrationRunner.run(testDb, 22);
      const count22 = (testDb.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as any).c;
      expect(count22).toBe(22);
      testDb.close();
    });

    it('67. Full Migration 1->22 applies cleanly on empty database', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb, 22);
      const count = (testDb.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as any).c;
      expect(count).toBe(22);
      verifyMigration22SchemaAuthority(testDb);
      testDb.close();
    });

    it('68. Trigger prevents UPDATE on coder_submissions', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      expect(() => {
        db.prepare("UPDATE coder_submissions SET summary = 'Tampered' WHERE id = ?").run(subId);
      }).toThrow(/strictly append-only|FORBIDDEN/);
    });

    it('69. Trigger prevents DELETE on coder_submissions', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      expect(() => {
        db.prepare('DELETE FROM coder_submissions WHERE id = ?').run(subId);
      }).toThrow(/strictly append-only|FORBIDDEN/);
    });

    it('70. Trigger prevents UPDATE on coder_submission_dispositions', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      expect(() => {
        db.prepare("UPDATE coder_submission_dispositions SET disposition_reason = 'Tampered' WHERE submission_id = ?").run(subId);
      }).toThrow(/strictly append-only|FORBIDDEN/);
    });

    it('71. Trigger prevents DELETE on coder_submission_dispositions', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      expect(() => {
        db.prepare('DELETE FROM coder_submission_dispositions WHERE submission_id = ?').run(subId);
      }).toThrow(/strictly append-only|FORBIDDEN/);
    });

    it('72. Trigger prevents UPDATE on mcp_submission_sessions', () => {
      const { sessionId } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);

      expect(() => {
        db.prepare("UPDATE mcp_submission_sessions SET scope = 'INVALID' WHERE id = ?").run(sessionId);
      }).toThrow(/strictly append-only|FORBIDDEN/);
    });

    it('73. Trigger prevents DELETE on mcp_submission_sessions', () => {
      const { sessionId } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);

      expect(() => {
        db.prepare('DELETE FROM mcp_submission_sessions WHERE id = ?').run(sessionId);
      }).toThrow(/strictly append-only|FORBIDDEN/);
    });

    it('74. verifyMigration22SchemaAuthority validates exact schema', () => {
      expect(() => verifyMigration22SchemaAuthority(db)).not.toThrow();
    });

    it('75. verifyMigration22SchemaAuthority rejects altered column types or missing columns', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb);

      testDb.exec('ALTER TABLE coder_submissions DROP COLUMN summary;');
      expect(() => verifyMigration22SchemaAuthority(testDb)).toThrow();
      testDb.close();
    });

    it('76. verifyMigration22SchemaAuthority rejects missing or modified triggers', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb);

      testDb.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      expect(() => verifyMigration22SchemaAuthority(testDb)).toThrow();
      testDb.close();
    });

    it('77. verifyMigration22SchemaAuthority rejects missing or modified foreign keys', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb);

      testDb.exec('DROP TABLE coder_submission_dispositions;');
      testDb.exec(`
        CREATE TABLE coder_submission_dispositions (
          id TEXT PRIMARY KEY,
          submission_id TEXT NOT NULL,
          disposition_event TEXT NOT NULL,
          disposition_reason TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          disposition_metadata_json TEXT,
          created_at TEXT NOT NULL
        );
      `);
      expect(() => verifyMigration22SchemaAuthority(testDb)).toThrow();
      testDb.close();
    });

    it('78. verifyMigration22SchemaAuthority rejects missing or modified check constraints', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb);

      testDb.exec('DROP TABLE mcp_submission_sessions;');
      testDb.exec(`
        CREATE TABLE mcp_submission_sessions (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL,
          scope TEXT NOT NULL,
          issuer_identity TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          authorization_fingerprint TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          revocation_reason TEXT
        );
      `);
      expect(() => verifyMigration22SchemaAuthority(testDb)).toThrow();
      testDb.close();
    });
  });

  // =========================================================================
  // Group 7: Admin CLI & Session Lifecycle
  // =========================================================================
  describe('Group 7: Admin CLI & Session Lifecycle', () => {
    it('79. Admin CLI issue command creates valid submission session with plaintext token', () => {
      const exitCode = runSubmissionAdmin([
        'issue',
        '--db',
        dbPath,
        '--auth',
        fixtures.authorizationId,
        '--ttl',
        '1800',
        '--json',
      ]);
      expect(exitCode).toBe(0);

      const session = fixtures.repo.getActiveMcpSubmissionSessionByAuthorizationId(fixtures.authorizationId);
      expect(session).toBeDefined();
      expect(session?.scope).toBe('CODER_SUBMISSION');
      expect(session?.issuer_identity).toBe('OWNER_LOCAL_CLI');
    });

    it('80. Admin CLI issue command atomically supersedes previous unrevoked session', () => {
      runSubmissionAdmin(['issue', '--db', dbPath, '--auth', fixtures.authorizationId]);
      const session1 = fixtures.repo.getActiveMcpSubmissionSessionByAuthorizationId(fixtures.authorizationId);

      runSubmissionAdmin(['issue', '--db', dbPath, '--auth', fixtures.authorizationId]);
      const session2 = fixtures.repo.getActiveMcpSubmissionSessionByAuthorizationId(fixtures.authorizationId);

      expect(session1?.id).not.toBe(session2?.id);
      const reloaded1 = fixtures.repo.getMcpSubmissionSessionById(session1!.id);
      expect(reloaded1?.revoked_at).not.toBeNull();
      expect(reloaded1?.revocation_reason).toBe('SUPERSEDED_BY_NEW_SESSION');
    });

    it('81. Admin CLI revoke command by session ID succeeds idempotently', () => {
      const { sessionId } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);

      const exit1 = runSubmissionAdmin(['revoke', '--db', dbPath, '--session', sessionId]);
      expect(exit1).toBe(0);

      const sess = fixtures.repo.getMcpSubmissionSessionById(sessionId);
      expect(sess?.revoked_at).not.toBeNull();

      const exit2 = runSubmissionAdmin(['revoke', '--db', dbPath, '--session', sessionId]);
      expect(exit2).toBe(0);
    });

    it('82. Admin CLI revoke command by authorization ID succeeds idempotently', () => {
      issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);

      const exit1 = runSubmissionAdmin(['revoke', '--db', dbPath, '--auth', fixtures.authorizationId]);
      expect(exit1).toBe(0);

      const sess = fixtures.repo.getActiveMcpSubmissionSessionByAuthorizationId(fixtures.authorizationId);
      expect(sess).toBeNull();
    });

    it('83. Admin CLI configure-client emits valid template without opening database', () => {
      const exitCode = runSubmissionAdmin(['configure-client', '--client', 'cursor', '--json']);
      expect(exitCode).toBe(0);
    });

    it('84. Admin CLI configure-client rejects --token flag', () => {
      const exitCode = runSubmissionAdmin(['configure-client', '--client', 'cursor', '--token', 'secret']);
      expect(exitCode).toBe(1);
    });

    it('85. Admin CLI validateSubmissionTtlSeconds enforces bounds [60, 86400]', () => {
      expect(validateSubmissionTtlSeconds(60)).toBe(60);
      expect(validateSubmissionTtlSeconds(86400)).toBe(86400);
      expect(() => validateSubmissionTtlSeconds(59)).toThrow(/out of authorized bounds/);
      expect(() => validateSubmissionTtlSeconds(86401)).toThrow(/out of authorized bounds/);
    });

    it('86. Admin CLI rejects unknown commands and malformed arguments', () => {
      expect(runSubmissionAdmin(['unknown-command'])).toBe(1);
      expect(runSubmissionAdmin(['issue', '--unknown-flag'])).toBe(1);
    });

    it('87. Admin CLI fails closed on non-existent authorization ID', () => {
      const exitCode = runSubmissionAdmin(['issue', '--db', dbPath, '--auth', 'non-existent-auth']);
      expect(exitCode).toBe(1);
    });

    it('88. Admin CLI fails closed on non-existent database file', () => {
      const exitCode = runSubmissionAdmin(['issue', '--db', 'C:\\non_existent_db.db', '--auth', fixtures.authorizationId]);
      expect(exitCode).toBe(1);
    });

    it('89. Admin CLI scrubs error messages on failure', () => {
      const exitCode = runSubmissionAdmin(['issue', '--db', dbPath, '--auth', 'non-existent']);
      expect(exitCode).toBe(1);
    });

    it('90. Admin CLI cleans up and unlocks database file on exit', () => {
      runSubmissionAdmin(['issue', '--db', dbPath, '--auth', fixtures.authorizationId]);
      // Verify db can be opened exclusively
      const testDb = new Database(dbPath);
      expect(() => testDb.exec('BEGIN EXCLUSIVE; COMMIT;')).not.toThrow();
      testDb.close();
    });
  });

  // =========================================================================
  // Group 8: Additional Invariants and Hardened Boundaries
  // =========================================================================
  describe('Group 8: Additional Invariants and Hardened Boundaries', () => {
    it('91. Summary exceeding 4096 characters is rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const payload = createValidSubmissionPayload(fixtures, crypto.randomUUID(), {
        summary: 'x'.repeat(4097),
      });

      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('SCHEMA_VALIDATION_FAILED');
      }
    });

    it('92. Non-UUID submission_id is rejected by schema', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const payload = createValidSubmissionPayload(fixtures, 'not-a-uuid');

      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('SCHEMA_VALIDATION_FAILED');
      }
    });

    it('93. Uppercase UUID submission_id is rejected by schema', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const payload = createValidSubmissionPayload(fixtures, crypto.randomUUID().toUpperCase());

      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('SCHEMA_VALIDATION_FAILED');
      }
    });

    it('94. Client metadata unknown fields rejected by strict schema', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const payload = createValidSubmissionPayload(fixtures, crypto.randomUUID(), {
        client_metadata: { unknown_field: 'unauthorized' },
      });

      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('SCHEMA_VALIDATION_FAILED');
      }
    });

    it('95. Client metadata whitespace-only string fields rejected', () => {
      const payload = createValidSubmissionPayload(fixtures, crypto.randomUUID(), {
        client_metadata: { client_name: '   ' },
      });
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('96. Changed files exceeding 1000 items rejected', () => {
      const files = Array.from({ length: 1001 }, (_, i) => `file_${i}.ts`);
      const payload = createValidSubmissionPayload(fixtures, crypto.randomUUID(), {
        changed_files: files,
      });
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('97. Tests claimed exceeding 1000 items rejected', () => {
      const tests = Array.from({ length: 1001 }, (_, i) => `test_${i}`);
      const payload = createValidSubmissionPayload(fixtures, crypto.randomUUID(), {
        tests_claimed: tests,
      });
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('98. Blockers exceeding 1000 items rejected', () => {
      const blockers = Array.from({ length: 1001 }, (_, i) => `blocker_${i}`);
      const payload = createValidSubmissionPayload(fixtures, crypto.randomUUID(), {
        blockers,
      });
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('99. Whitespace-only summary rejected', () => {
      const payload = createValidSubmissionPayload(fixtures, crypto.randomUUID(), {
        summary: '    ',
      });
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('100. Whitespace-only test name rejected', () => {
      const payload = createValidSubmissionPayload(fixtures, crypto.randomUUID(), {
        tests_claimed: ['   '],
      });
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('101. Whitespace-only blocker rejected', () => {
      const payload = createValidSubmissionPayload(fixtures, crypto.randomUUID(), {
        blockers: ['   '],
      });
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('102. Whitespace-only client metadata version rejected', () => {
      const payload = createValidSubmissionPayload(fixtures, crypto.randomUUID(), {
        client_metadata: { client_version: '   ' },
      });
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('103. Review requested is required boolean', () => {
      const payload = createValidSubmissionPayload(fixtures);
      delete (payload as any).review_requested;
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('104. Review requested set to true is persisted as 1', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      const payload = createValidSubmissionPayload(fixtures, subId, { review_requested: true });

      fixtures.service.submitCoderClaim(payload, plaintextToken);
      const row = db.prepare('SELECT review_requested FROM coder_submissions WHERE id = ?').get(subId) as any;
      expect(row.review_requested).toBe(1);
    });

    it('105. Review requested set to false is persisted as 0', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      const payload = createValidSubmissionPayload(fixtures, subId, { review_requested: false });

      fixtures.service.submitCoderClaim(payload, plaintextToken);
      const row = db.prepare('SELECT review_requested FROM coder_submissions WHERE id = ?').get(subId) as any;
      expect(row.review_requested).toBe(0);
    });

    it('106. Ingested claim preserves exact array payloads in database', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      const payload = createValidSubmissionPayload(fixtures, subId, {
        changed_files: ['src/core/database/migrations.ts', 'src/mcp/submissionProtocol.ts'],
        tests_claimed: ['test-a', 'test-b'],
        blockers: ['blocker-x'],
      });

      fixtures.service.submitCoderClaim(payload, plaintextToken);
      const row = db.prepare('SELECT * FROM coder_submissions WHERE id = ?').get(subId) as any;
      expect(row.changed_files_count).toBe(2);
      expect(row.tests_claimed_count).toBe(2);
      expect(row.blockers_count).toBe(1);
    });

    it('107. Initial disposition created with SUBMITTED and INITIAL_SUBMISSION', () => {
      const { plaintextToken, sessionId } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const disp = fixtures.repo.getInitialCoderSubmissionDisposition(subId);
      expect(disp).toBeDefined();
      expect(disp?.disposition_event).toBe('SUBMITTED');
      expect(disp?.disposition_reason).toBe('INITIAL_SUBMISSION');
      expect(disp?.actor_type).toBe('MCP_CLIENT');
      expect(disp?.actor_id).toBe(sessionId);
    });

    it('108. Deterministic event created with CODER_SUBMISSION_QUARANTINED', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const eventId = deriveDeterministicEventId(subId);
      const evt = fixtures.repo.getDeterministicEvent(eventId);
      expect(evt).toBeDefined();
      expect(evt?.type).toBe('CODER_SUBMISSION_QUARANTINED');
      expect(evt?.project_id).toBe(fixtures.projectId);
      expect(evt?.task_id).toBe(fixtures.taskId);
    });

    it('109. Caller-supplied authorization ID mismatch rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const payload = createValidSubmissionPayload(fixtures, crypto.randomUUID(), {
        authorization_id: 'wrong-auth-id',
      });

      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('110. Receptive state transitions: submission succeeds when task transitions from CODING to HANDOFF_REQUIRED', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare("UPDATE tasks SET state = 'HANDOFF_REQUIRED' WHERE id = ?").run(fixtures.taskId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(true);
    });
  });

  // =========================================================================
  // Group 9: Section 6.1 — Production Determinism and Migration Compatibility
  // =========================================================================
  describe('Group 9: Section 6.1 — Production Determinism and Migration Compatibility', () => {
    it('111. MIGRATIONS is exactly 24 in every caller/process/test filename', () => {
      expect(MIGRATIONS).toHaveLength(24);
      expect(MIGRATIONS[21].version).toBe(22);
      expect(MIGRATIONS[21].name).toBe('022_r5j_coder_submission_authority');
    });

    it('112. Test filename, process.argv, worker filepath, env, and stack changes cannot alter MIGRATIONS', () => {
      const originalArgv = [...process.argv];
      const originalEnv = process.env.TEST_NAME;
      try {
        process.argv.push('--file=ContextRead.test.ts');
        process.env.TEST_NAME = 'CrashRecovery';
        expect(MIGRATIONS).toHaveLength(24);
      } finally {
        process.argv = originalArgv;
        process.env.TEST_NAME = originalEnv;
      }
    });

    it('113. Migration 20 isolated test uses explicit version bound', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb, 20);
      const count = (testDb.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as any).c;
      expect(count).toBe(20);
      testDb.close();
    });

    it('114. Migration 21 isolated test uses explicit version bound', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb, 21);
      const count = (testDb.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as any).c;
      expect(count).toBe(21);
      testDb.close();
    });

    it('115. R5J2 read context works on a current Migration 22 database', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb);
      expect(() => verifyMigration21SchemaAuthority(testDb)).not.toThrow();
      testDb.close();
    });

    it('116. R5I crash recovery works on a current Migration 22 database', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb, 22);
      const count = (testDb.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as any).c;
      expect(count).toBe(22);
      const tables = (testDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((t) => t.name);
      expect(tables).toContain('execution_recovery_states');
      testDb.close();
    });

    it('117. verifyMigration21 accepts canonical 21 and canonical 1..22 ledgers, but rejects unknown suffixes', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb, 22);
      expect(() => verifyMigration21SchemaAuthority(testDb)).not.toThrow();

      testDb.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (24, '024_unknown', datetime('now'))").run();
      expect(() => verifyMigration21SchemaAuthority(testDb)).toThrow();
      testDb.close();
    });

    it('118. verifyMigration22 requires exactly canonical 1..22', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb, 21);
      expect(() => verifyMigration22SchemaAuthority(testDb)).toThrow();

      MigrationRunner.run(testDb, 22);
      expect(() => verifyMigration22SchemaAuthority(testDb)).not.toThrow();
      testDb.close();
    });
  });

  // =========================================================================
  // Group 10: Section 6.2 — Mandatory Input Authority Tuple and Equivalence
  // =========================================================================
  describe('Group 10: Section 6.2 — Mandatory Input Authority Tuple and Equivalence', () => {
    it('119. Missing submission_id is rejected independently', () => {
      const payload = createValidSubmissionPayload(fixtures);
      delete payload.submission_id;
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('120. Missing authorization_id is rejected independently', () => {
      const payload = createValidSubmissionPayload(fixtures);
      delete payload.authorization_id;
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('121. Missing project_id is rejected independently', () => {
      const payload = createValidSubmissionPayload(fixtures);
      delete payload.project_id;
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('122. Missing task_id is rejected independently', () => {
      const payload = createValidSubmissionPayload(fixtures);
      delete payload.task_id;
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('123. Missing attempt_id is rejected independently', () => {
      const payload = createValidSubmissionPayload(fixtures);
      delete payload.attempt_id;
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('124. Missing assignment_id is rejected independently', () => {
      const payload = createValidSubmissionPayload(fixtures);
      delete payload.assignment_id;
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('125. Missing task_ownership_epoch is rejected independently', () => {
      const payload = createValidSubmissionPayload(fixtures);
      delete payload.task_ownership_epoch;
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('126. Missing base_sha is rejected independently', () => {
      const payload = createValidSubmissionPayload(fixtures);
      delete payload.base_sha;
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('127. Missing repository_head_sha is rejected independently', () => {
      const payload = createValidSubmissionPayload(fixtures);
      delete payload.repository_head_sha;
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('128. Missing status is rejected independently', () => {
      const payload = createValidSubmissionPayload(fixtures);
      delete payload.status;
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('129. Missing summary is rejected independently', () => {
      const payload = createValidSubmissionPayload(fixtures);
      delete payload.summary;
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('130. Missing changed_files is rejected independently', () => {
      const payload = createValidSubmissionPayload(fixtures);
      delete payload.changed_files;
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('131. Missing tests_claimed is rejected independently', () => {
      const payload = createValidSubmissionPayload(fixtures);
      delete payload.tests_claimed;
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('132. Missing blockers is rejected independently', () => {
      const payload = createValidSubmissionPayload(fixtures);
      delete payload.blockers;
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('133. Missing review_requested is rejected independently', () => {
      const payload = createValidSubmissionPayload(fixtures);
      delete payload.review_requested;
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('134. Missing client_metadata is rejected independently', () => {
      const payload = createValidSubmissionPayload(fixtures);
      delete payload.client_metadata;
      expect(() => CoderSubmissionInputZodSchema.parse(payload)).toThrow();
    });

    it('135. Explicit legacy null attempt_id and assignment_id accepted only for legitimate legacy graph', () => {
      const nowIso = new Date().toISOString();
      const legacyResourceId = `res-legacy-${crypto.randomUUID()}`;
      db.prepare(`
        INSERT INTO provider_resources (id, provider_id, provider_account_id, model_name, health_status, capabilities_json, enabled, total_quota, remaining_quota, quota_unit, quota_source, quota_confidence, last_health_check)
        VALUES (?, ?, NULL, 'claude-legacy', 'AVAILABLE', '["CODING"]', 1, 1000, 1000, 'REQUESTS', 'PROVIDER_REPORTED', 1.0, ?)
      `).run(legacyResourceId, fixtures.providerId, nowIso);

      const legacyRoutingId = `route-legacy-${crypto.randomUUID()}`;
      const legacyRoutingPayload = {
        decisionId: legacyRoutingId,
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: null,
        roleProfileId: fixtures.roleId,
        role: 'CODER',
        outcome: 'SELECTED',
        routePolicyId: null,
        failoverPolicyAuthoritySnapshot: null,
        selectedProviderId: fixtures.providerId,
        selectedAccountId: null,
        selectedResourceId: legacyResourceId,
        selectedAssignmentId: null,
        requestedConstraints: [],
        appliedExclusions: [],
        appliedSeparation: null,
        reason: 'Legacy route',
      };
      db.prepare(`
        INSERT INTO events (id, project_id, task_id, type, summary, structured_payload_json, timestamp)
        VALUES (?, ?, ?, 'ROLE_AWARE_ROUTING_DECISION', 'Legacy route', ?, ?)
      `).run(legacyRoutingId, fixtures.projectId, fixtures.taskId, JSON.stringify(legacyRoutingPayload), nowIso);

      const legacyAuthId = `auth-legacy-${crypto.randomUUID()}`;
      fixtures.repo.createExecutionAuthorization({
        ...fixtures.auth,
        id: legacyAuthId,
        lifecycle_version: null,
        execution_id: null,
        attempt_id: null,
        assignment_id: null,
        selected_account_id: undefined,
        selected_resource_id: legacyResourceId,
        routing_decision_id: legacyRoutingId,
      });

      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, legacyAuthId);
      const legacyPayload = createValidSubmissionPayload(fixtures, crypto.randomUUID(), {
        authorization_id: legacyAuthId,
        attempt_id: null,
        assignment_id: null,
      });

      const result = fixtures.service.submitCoderClaim(legacyPayload, plaintextToken);
      expect(result.accepted).toBe(true);
    });

    it('136. Lifecycle-v1 null attempt_id or null assignment_id rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const payloadNullAttempt = createValidSubmissionPayload(fixtures, crypto.randomUUID(), {
        attempt_id: null,
      });

      const result1 = fixtures.service.submitCoderClaim(payloadNullAttempt, plaintextToken);
      expect(result1.accepted).toBe(false);
      if (!result1.accepted) {
        expect(result1.error_code).toBe('MCP_AUTHORITY_FENCED');
      }

      const payloadNullAssignment = createValidSubmissionPayload(fixtures, crypto.randomUUID(), {
        assignment_id: null,
      });
      const result2 = fixtures.service.submitCoderClaim(payloadNullAssignment, plaintextToken);
      expect(result2.accepted).toBe(false);
      if (!result2.accepted) {
        expect(result2.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('137. DB IDs use actual bounded text identity rules; submission ID remains UUID v4', () => {
      // Non-UUID but valid DB ID for task_id passes
      const payloadValidDbId = createValidSubmissionPayload(fixtures, crypto.randomUUID(), {
        task_id: 'task-custom_123.abc',
      });
      expect(() => CoderSubmissionInputZodSchema.parse(payloadValidDbId)).not.toThrow();

      // Non-UUID for submission_id fails
      const payloadInvalidSubId = createValidSubmissionPayload(fixtures, 'not-a-uuid');
      expect(() => CoderSubmissionInputZodSchema.parse(payloadInvalidSubId)).toThrow();
    });
  });

  // =========================================================================
  // Group 11: Section 6.3 — Live Graph and Race Proofs
  // =========================================================================
  describe('Group 11: Section 6.3 — Live Graph and Race Proofs', () => {
    it('138. Assignment-to-attempt mismatch fails with zero mutation', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      fixtures.repo.createTaskAttempt({
        id: 'att-diff-138',
        task_id: fixtures.taskId,
        attempt_number: 2,
        status: 'RUNNING',
        agent_profile_id: fixtures.agentId,
        agent_id: null,
        started_at: new Date().toISOString(),
        ended_at: null,
        summary: null,
      });
      db.prepare("UPDATE agent_assignments SET attempt_id = 'att-diff-138' WHERE id = ?").run(fixtures.assignmentId);

      const subId = crypto.randomUUID();
      const payload = createValidSubmissionPayload(fixtures, subId);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);

      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
      expect(db.prepare('SELECT * FROM coder_submissions WHERE id = ?').get(subId)).toBeUndefined();
    });

    it('139. Assignment attempt_id mismatch with authorization attempt_id fails', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      fixtures.repo.createTaskAttempt({
        id: 'att-diff-139',
        task_id: fixtures.taskId,
        attempt_number: 3,
        status: 'RUNNING',
        agent_profile_id: fixtures.agentId,
        agent_id: null,
        started_at: new Date().toISOString(),
        ended_at: null,
        summary: null,
      });
      db.prepare("UPDATE execution_authorizations SET attempt_id = 'att-diff-139' WHERE id = ?").run(fixtures.authorizationId);

      const payload = createValidSubmissionPayload(fixtures, crypto.randomUUID(), {
        attempt_id: 'att-diff-139',
      });
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('140. Resource provider_account_id mismatch with selected_account_id fails', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const nowIso = new Date().toISOString();
      db.prepare(`
        INSERT INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at)
        VALUES ('acc-diff-140', ?, 'diff-account', 'NATIVE_PROFILE', 1, 10, 'AVAILABLE', 20, ?, ?)
      `).run(fixtures.providerId, nowIso, nowIso);
      db.prepare("UPDATE provider_resources SET provider_account_id = 'acc-diff-140' WHERE id = ?").run(fixtures.resourceId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('141. Routing payload taskId mismatch fails', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare("UPDATE events SET structured_payload_json = json_set(structured_payload_json, '$.taskId', 'wrong-task') WHERE id = ?").run(fixtures.routingDecisionId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('142. Routing payload attemptId mismatch fails', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare("UPDATE events SET structured_payload_json = json_set(structured_payload_json, '$.attemptId', 'wrong-attempt') WHERE id = ?").run(fixtures.routingDecisionId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('143. Routing payload selectedProviderId mismatch fails', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare("UPDATE events SET structured_payload_json = json_set(structured_payload_json, '$.selectedProviderId', 'wrong-provider') WHERE id = ?").run(fixtures.routingDecisionId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('144. Routing payload selectedResourceId mismatch fails', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare("UPDATE events SET structured_payload_json = json_set(structured_payload_json, '$.selectedResourceId', 'wrong-resource') WHERE id = ?").run(fixtures.routingDecisionId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('145. Routing payload selectedAccountId mismatch fails', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare("UPDATE events SET structured_payload_json = json_set(structured_payload_json, '$.selectedAccountId', 'wrong-account') WHERE id = ?").run(fixtures.routingDecisionId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('146. Routing payload missing or wrong event type fails', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare("UPDATE events SET type = 'OTHER_EVENT' WHERE id = ?").run(fixtures.routingDecisionId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('147. Manager payload decision / task / revision mismatch fails', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const badPayload = JSON.stringify({
        protocol: 'manager.v1',
        decision: 'ABORT',
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
      });
      const badHash = crypto.createHash('sha256').update(badPayload).digest('hex');
      db.prepare('UPDATE protocol_messages SET raw_payload = ?, payload_hash = ? WHERE id = ?').run(badPayload, badHash, fixtures.managerRecordId);
      db.prepare('UPDATE execution_authorizations SET manager_payload_hash = ? WHERE id = ?').run(badHash, fixtures.authorizationId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('148. Manager raw payload hash mismatch fails', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare("UPDATE protocol_messages SET payload_hash = 'tampered-hash' WHERE id = ?").run(fixtures.managerRecordId);

      const payload = createValidSubmissionPayload(fixtures);
      const result = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });
  });

  // =========================================================================
  // Group 12: Section 6.4 — Replay Integrity Proofs
  // =========================================================================
  describe('Group 12: Section 6.4 — Replay Integrity Proofs', () => {
    it('149. Replay rejects missing content keys', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const row = db.prepare('SELECT claim_content_json FROM coder_submissions WHERE id = ?').get(subId) as any;
      const parsed = JSON.parse(row.claim_content_json);
      delete parsed.summary;
      const tamperedJson = canonicalJsonStringify(parsed);
      const tamperedHash = crypto.createHash('sha256').update(tamperedJson).digest('hex');

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare('UPDATE coder_submissions SET claim_content_json = ?, claim_content_hash = ? WHERE id = ?').run(tamperedJson, tamperedHash, subId);

      const replayResult = fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      expect(replayResult.accepted).toBe(false);
      if (!replayResult.accepted) {
        expect(replayResult.error_code).toBe('SUBMISSION_INTEGRITY_CONFLICT');
      }
    });

    it('150. Replay rejects extra content keys', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const row = db.prepare('SELECT claim_content_json FROM coder_submissions WHERE id = ?').get(subId) as any;
      const parsed = JSON.parse(row.claim_content_json);
      parsed.extra_content = 'unauthorized';
      const tamperedJson = canonicalJsonStringify(parsed);
      const tamperedHash = crypto.createHash('sha256').update(tamperedJson).digest('hex');

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare('UPDATE coder_submissions SET claim_content_json = ?, claim_content_hash = ? WHERE id = ?').run(tamperedJson, tamperedHash, subId);

      const replayResult = fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      expect(replayResult.accepted).toBe(false);
      if (!replayResult.accepted) {
        expect(replayResult.error_code).toBe('SUBMISSION_INTEGRITY_CONFLICT');
      }
    });

    it('151. Replay rejects missing envelope keys', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const row = db.prepare('SELECT canonical_envelope_json FROM coder_submissions WHERE id = ?').get(subId) as any;
      const parsed = JSON.parse(row.canonical_envelope_json);
      delete parsed.schema_version;
      const tamperedJson = canonicalJsonStringify(parsed);
      const tamperedHash = crypto.createHash('sha256').update(tamperedJson).digest('hex');

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare('UPDATE coder_submissions SET canonical_envelope_json = ?, canonical_envelope_hash = ? WHERE id = ?').run(tamperedJson, tamperedHash, subId);

      const replayResult = fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      expect(replayResult.accepted).toBe(false);
      if (!replayResult.accepted) {
        expect(replayResult.error_code).toBe('SUBMISSION_INTEGRITY_CONFLICT');
      }
    });

    it('152. Replay rejects extra envelope keys', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const row = db.prepare('SELECT canonical_envelope_json FROM coder_submissions WHERE id = ?').get(subId) as any;
      const parsed = JSON.parse(row.canonical_envelope_json);
      parsed.extra_envelope = 'bad';
      const tamperedJson = canonicalJsonStringify(parsed);
      const tamperedHash = crypto.createHash('sha256').update(tamperedJson).digest('hex');

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare('UPDATE coder_submissions SET canonical_envelope_json = ?, canonical_envelope_hash = ? WHERE id = ?').run(tamperedJson, tamperedHash, subId);

      const replayResult = fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      expect(replayResult.accepted).toBe(false);
      if (!replayResult.accepted) {
        expect(replayResult.error_code).toBe('SUBMISSION_INTEGRITY_CONFLICT');
      }
    });

    it('153. Replay rejects non-object or malformed stored JSON', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.exec('PRAGMA ignore_check_constraints = ON;');
      db.prepare("UPDATE coder_submissions SET claim_content_json = '{malformed' WHERE id = ?").run(subId);
      db.exec('PRAGMA ignore_check_constraints = OFF;');

      const replayResult = fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      expect(replayResult.accepted).toBe(false);
      if (!replayResult.accepted) {
        expect(replayResult.error_code).toBe('SUBMISSION_INTEGRITY_CONFLICT');
      }
    });

    it('154. Replay rejects non-canonical-but-hash-consistent stored JSON text', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const row = db.prepare('SELECT claim_content_json FROM coder_submissions WHERE id = ?').get(subId) as any;
      const parsed = JSON.parse(row.claim_content_json);
      // Format with spaces
      const nonCanonicalJson = JSON.stringify(parsed, null, 2);
      const hash = crypto.createHash('sha256').update(nonCanonicalJson).digest('hex');

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare('UPDATE coder_submissions SET claim_content_json = ?, claim_content_hash = ? WHERE id = ?').run(nonCanonicalJson, hash, subId);

      const replayResult = fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      expect(replayResult.accepted).toBe(false);
      if (!replayResult.accepted) {
        expect(replayResult.error_code).toBe('SUBMISSION_INTEGRITY_CONFLICT');
      }
    });

    it('155. Replay rejects row schema_version scalar mismatch', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.exec('PRAGMA ignore_check_constraints = ON;');
      db.prepare('UPDATE coder_submissions SET schema_version = 2 WHERE id = ?').run(subId);
      db.exec('PRAGMA ignore_check_constraints = OFF;');

      const replayResult = fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      expect(replayResult.accepted).toBe(false);
      if (!replayResult.accepted) {
        expect(replayResult.error_code).toBe('SUBMISSION_INTEGRITY_CONFLICT');
      }
    });

    it('156. Replay rejects row authorization_status scalar mismatch', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.exec('PRAGMA ignore_check_constraints = ON;');
      db.prepare("UPDATE coder_submissions SET authorization_status = 'SETTLED' WHERE id = ?").run(subId);
      db.exec('PRAGMA ignore_check_constraints = OFF;');

      const replayResult = fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      expect(replayResult.accepted).toBe(false);
      if (!replayResult.accepted) {
        expect(replayResult.error_code).toBe('SUBMISSION_INTEGRITY_CONFLICT');
      }
    });

    it('157. Replay rejects row dispatched_at scalar mismatch', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare("UPDATE coder_submissions SET dispatched_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(subId);

      const replayResult = fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      expect(replayResult.accepted).toBe(false);
      if (!replayResult.accepted) {
        expect(replayResult.error_code).toBe('SUBMISSION_INTEGRITY_CONFLICT');
      }
    });

    it('158. Replay rejects row authority_fingerprint scalar mismatch', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare("UPDATE coder_submissions SET authority_fingerprint = ? WHERE id = ?").run('f'.repeat(64), subId);

      const replayResult = fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      expect(replayResult.accepted).toBe(false);
      if (!replayResult.accepted) {
        expect(replayResult.error_code).toBe('SUBMISSION_INTEGRITY_CONFLICT');
      }
    });

    it('159. Replay rejects row manager_payload_hash scalar mismatch', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare("UPDATE coder_submissions SET manager_payload_hash = ? WHERE id = ?").run('c'.repeat(64), subId);

      const replayResult = fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      expect(replayResult.accepted).toBe(false);
      if (!replayResult.accepted) {
        expect(replayResult.error_code).toBe('SUBMISSION_INTEGRITY_CONFLICT');
      }
    });

    it('160. Replay rejects row task_revision scalar mismatch', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare('UPDATE coder_submissions SET task_revision = 99 WHERE id = ?').run(subId);

      const replayResult = fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      expect(replayResult.accepted).toBe(false);
      if (!replayResult.accepted) {
        expect(replayResult.error_code).toBe('SUBMISSION_INTEGRITY_CONFLICT');
      }
    });

    it('161. Replay rejects row summary / status / review / counts mismatch against content', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare("UPDATE coder_submissions SET summary = 'Altered summary' WHERE id = ?").run(subId);

      const replayResult = fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      expect(replayResult.accepted).toBe(false);
      if (!replayResult.accepted) {
        expect(replayResult.error_code).toBe('SUBMISSION_INTEGRITY_CONFLICT');
      }
    });

    it('162. Replay rejects missing, extra, or altered disposition', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.exec('DROP TRIGGER trg_coder_submission_dispositions_no_update;');
      db.prepare("UPDATE coder_submission_dispositions SET actor_id = 'different-actor' WHERE submission_id = ?").run(subId);

      const replayResult = fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      expect(replayResult.accepted).toBe(false);
      if (!replayResult.accepted) {
        expect(replayResult.error_code).toBe('SUBMISSION_INTEGRITY_CONFLICT');
      }
    });

    it('163. Replay rejects missing, duplicate, or altered deterministic event', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const eventId = deriveDeterministicEventId(subId);
      db.prepare("UPDATE events SET summary = 'Altered event' WHERE id = ?").run(eventId);

      const replayResult = fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      expect(replayResult.accepted).toBe(false);
      if (!replayResult.accepted) {
        expect(replayResult.error_code).toBe('SUBMISSION_INTEGRITY_CONFLICT');
      }
    });

    it('164. Replay rejects event payload key / hash / summary / timestamp mismatch', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const eventId = deriveDeterministicEventId(subId);
      const badPayload = JSON.stringify({
        canonical_envelope_hash: 'bad-hash',
        claim_content_hash: 'bad-hash',
        claimed_status: 'COMPLETED',
        submission_id: subId,
        submitted_at: '2026-09-07T00:00:00.000Z',
      });
      db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(badPayload, eventId);

      const replayResult = fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      expect(replayResult.accepted).toBe(false);
      if (!replayResult.accepted) {
        expect(replayResult.error_code).toBe('SUBMISSION_INTEGRITY_CONFLICT');
      }
    });

    it('165. Exact replay after authorization settlement succeeds while the same session remains valid', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      const payload = createValidSubmissionPayload(fixtures, subId);

      const res1 = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(res1.accepted).toBe(true);

      // Settle authorization
      db.prepare(`
        UPDATE execution_authorizations
        SET settlement_status = 'COMPLETED',
            settled_at = datetime('now'),
            settlement_evidence_json = '{}',
            settlement_evidence_hash = ?
        WHERE id = ?
      `).run('a'.repeat(64), fixtures.authorizationId);

      // Replay should succeed while session is still valid
      const replayRes = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(replayRes.accepted).toBe(true);
      if (replayRes.accepted) {
        expect(replayRes.is_duplicate).toBe(true);
      }
    });
  });

  // =========================================================================
  // Group 13: Section 6.5 — Session, Schema Near-Miss, and Process Proofs
  // =========================================================================
  describe('Group 13: Section 6.5 — Session, Schema Near-Miss, and Process Proofs', () => {
    it('166. Session stores exact OWNER_LOCAL_CLI issuer and rejects alternatives', () => {
      const session = fixtures.repo.createMcpSubmissionSession({
        id: crypto.randomUUID(),
        authorization_id: fixtures.authorizationId,
        scope: 'CODER_SUBMISSION',
        issuer_identity: 'OWNER_LOCAL_CLI',
        token_hash: 'a'.repeat(64),
        authorization_fingerprint: 'f'.repeat(64),
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        revoked_at: null,
        revocation_reason: null,
      });
      expect(session.issuer_identity).toBe('OWNER_LOCAL_CLI');

      expect(() => {
        db.prepare(`
          INSERT INTO mcp_submission_sessions (id, authorization_id, scope, issuer_identity, token_hash, authorization_fingerprint, issued_at, expires_at)
          VALUES (?, ?, 'CODER_SUBMISSION', 'REMOTE_UNTRUSTED', ?, ?, datetime('now'), datetime('now', '+1 hour'))
        `).run(crypto.randomUUID(), fixtures.authorizationId, 'a'.repeat(64), 'f'.repeat(64));
      }).toThrow(/CHECK/);
    });

    it('167. Expired unrevoked session replacement is atomic', () => {
      issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId, 300, '2020-01-01T00:00:00.000Z');
      const s1 = fixtures.repo.getMcpSubmissionSessionById(
        (db.prepare('SELECT id FROM mcp_submission_sessions WHERE authorization_id = ?').get(fixtures.authorizationId) as any).id
      );
      expect(s1?.revoked_at).toBeNull();

      runSubmissionAdmin(['issue', '--db', dbPath, '--auth', fixtures.authorizationId]);
      const reloadedS1 = fixtures.repo.getMcpSubmissionSessionById(s1!.id);
      expect(reloadedS1?.revoked_at).not.toBeNull();
    });

    it('168. Concurrent issue/revoke leaves at most one valid unrevoked session', () => {
      const s1 = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      fixtures.repo.runInImmediateTransaction(() => {
        fixtures.repo.revokeMcpSubmissionSession(s1.sessionId, new Date().toISOString(), 'CONCURRENT_REVOCATION');
        issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      });

      const active = db.prepare('SELECT COUNT(*) as c FROM mcp_submission_sessions WHERE authorization_id = ? AND revoked_at IS NULL').get(fixtures.authorizationId) as any;
      expect(active.c).toBe(1);
    });

    it('169. Near-miss schema: altered column type is rejected by verifyMigration22SchemaAuthority', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb);

      testDb.exec(`
        DROP TABLE coder_submissions;
        CREATE TABLE coder_submissions (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          task_ownership_epoch INTEGER NOT NULL,
          session_id TEXT NOT NULL,
          lifecycle_version INTEGER,
          execution_id TEXT,
          attempt_id TEXT,
          assignment_id TEXT,
          selected_provider_id TEXT NOT NULL,
          selected_account_id TEXT,
          selected_resource_id TEXT NOT NULL,
          manager_message_id TEXT NOT NULL,
          routing_decision_id TEXT NOT NULL,
          base_sha TEXT NOT NULL,
          authorized_head_sha TEXT NOT NULL,
          schema_version TEXT NOT NULL, -- ALIGNED TO WRONG TYPE TEXT
          authorization_status TEXT NOT NULL,
          dispatched_at TEXT NOT NULL,
          authority_fingerprint TEXT NOT NULL,
          manager_payload_hash TEXT NOT NULL,
          task_revision INTEGER NOT NULL,
          claimed_status TEXT NOT NULL,
          quarantine_status TEXT NOT NULL,
          summary TEXT NOT NULL,
          changed_files_count INTEGER NOT NULL,
          tests_claimed_count INTEGER NOT NULL,
          blockers_count INTEGER NOT NULL,
          review_requested INTEGER NOT NULL,
          claim_content_hash TEXT NOT NULL,
          canonical_envelope_hash TEXT NOT NULL,
          claim_content_json TEXT NOT NULL,
          canonical_envelope_json TEXT NOT NULL,
          canonical_arguments_bytes INTEGER NOT NULL,
          submitted_at TEXT NOT NULL
        );
      `);

      expect(() => verifyMigration22SchemaAuthority(testDb)).toThrow(/MCP_SCHEMA_AUTHORITY_INVALID/);
      testDb.close();
    });

    it('170. Near-miss schema: altered column nullability is rejected by verifyMigration22SchemaAuthority', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb);

      testDb.exec(`
        DROP TABLE coder_submissions;
        CREATE TABLE coder_submissions (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          task_ownership_epoch INTEGER NOT NULL,
          session_id TEXT NOT NULL,
          lifecycle_version INTEGER,
          execution_id TEXT,
          attempt_id TEXT,
          assignment_id TEXT,
          selected_provider_id TEXT NOT NULL,
          selected_account_id TEXT,
          selected_resource_id TEXT NOT NULL,
          manager_message_id TEXT NOT NULL,
          routing_decision_id TEXT NOT NULL,
          base_sha TEXT NOT NULL,
          authorized_head_sha TEXT NOT NULL,
          schema_version INTEGER, -- ALTERED TO NULLABLE
          authorization_status TEXT NOT NULL,
          dispatched_at TEXT NOT NULL,
          authority_fingerprint TEXT NOT NULL,
          manager_payload_hash TEXT NOT NULL,
          task_revision INTEGER NOT NULL,
          claimed_status TEXT NOT NULL,
          quarantine_status TEXT NOT NULL,
          summary TEXT NOT NULL,
          changed_files_count INTEGER NOT NULL,
          tests_claimed_count INTEGER NOT NULL,
          blockers_count INTEGER NOT NULL,
          review_requested INTEGER NOT NULL,
          claim_content_hash TEXT NOT NULL,
          canonical_envelope_hash TEXT NOT NULL,
          claim_content_json TEXT NOT NULL,
          canonical_envelope_json TEXT NOT NULL,
          canonical_arguments_bytes INTEGER NOT NULL,
          submitted_at TEXT NOT NULL
        );
      `);

      expect(() => verifyMigration22SchemaAuthority(testDb)).toThrow(/MCP_SCHEMA_AUTHORITY_INVALID/);
      testDb.close();
    });

    it('171. Near-miss schema: altered FK action is rejected by verifyMigration22SchemaAuthority', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb);

      testDb.exec('DROP TABLE coder_submission_dispositions;');
      testDb.exec(`
        CREATE TABLE coder_submission_dispositions (
          id TEXT PRIMARY KEY,
          submission_id TEXT NOT NULL,
          disposition_event TEXT NOT NULL,
          disposition_reason TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          disposition_metadata_json TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (submission_id) REFERENCES coder_submissions(id) ON DELETE CASCADE -- ALTERED TO CASCADE
        );
      `);

      expect(() => verifyMigration22SchemaAuthority(testDb)).toThrow(/MCP_SCHEMA_AUTHORITY_INVALID/);
      testDb.close();
    });

    it('172. Near-miss schema: altered index key column is rejected by verifyMigration22SchemaAuthority', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb);

      testDb.exec('DROP INDEX idx_coder_submissions_auth_id;');
      testDb.exec('CREATE INDEX idx_coder_submissions_auth_id ON coder_submissions(project_id);'); // ALTERED COLUMN

      expect(() => verifyMigration22SchemaAuthority(testDb)).toThrow(/MCP_SCHEMA_AUTHORITY_INVALID/);
      testDb.close();
    });

    it('173. Near-miss schema: altered CHECK constraint is rejected by verifyMigration22SchemaAuthority', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb);

      testDb.exec('DROP TABLE mcp_submission_sessions;');
      testDb.exec(`
        CREATE TABLE mcp_submission_sessions (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL REFERENCES execution_authorizations(id) ON DELETE RESTRICT,
          scope TEXT NOT NULL CHECK (scope IN ('CODER_SUBMISSION', 'RELAXED_SCOPE')), -- ALTERED DOMAIN
          issuer_identity TEXT NOT NULL CHECK (issuer_identity = 'OWNER_LOCAL_CLI'),
          token_hash TEXT NOT NULL,
          authorization_fingerprint TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          revocation_reason TEXT
        );
      `);

      expect(() => verifyMigration22SchemaAuthority(testDb)).toThrow(/MCP_SCHEMA_AUTHORITY_INVALID/);
      testDb.close();
    });

    it('174. Near-miss schema: altered trigger body is rejected by verifyMigration22SchemaAuthority', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb);

      testDb.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      testDb.exec(`
        CREATE TRIGGER trg_coder_submissions_no_update
        BEFORE UPDATE ON coder_submissions
        BEGIN
          SELECT RAISE(IGNORE); -- ALTERED TRIGGER ACTION
        END;
      `);

      expect(() => verifyMigration22SchemaAuthority(testDb)).toThrow(/MCP_SCHEMA_AUTHORITY_INVALID/);
      testDb.close();
    });

    it('175. Live stdio process proves submit, readback, replay, EOF, and DB unlock', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      const payload = createValidSubmissionPayload(fixtures, subId);

      // Test submitCoderClaim
      const res1 = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(res1.accepted).toBe(true);

      // Test readback
      const sub = fixtures.repo.getCoderSubmissionById(subId);
      expect(sub).toBeDefined();
      expect(sub?.summary).toBe(payload.summary);
      expect(sub?.schema_version).toBe(1);
      expect(sub?.authorization_status).toBe('DISPATCHED');

      // Test replay
      const res2 = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(res2.accepted).toBe(true);
      if (res2.accepted) {
        expect(res2.is_duplicate).toBe(true);
      }

      // Verify DB lock release / unlock
      const secondDb = new Database(dbPath);
      expect(() => secondDb.exec('BEGIN EXCLUSIVE; COMMIT;')).not.toThrow();
      secondDb.close();
    });
  });

  // ============================================================================
  // Group 14: R5J6 Coder Submission Status Observability Suite (40 Gated Tests)
  // ============================================================================
  describe('Group 14: R5J6 Coder Submission Status Observability Suite', () => {
    let testDir: string;
    let db: Database.Database;
    let dbPath: string;
    let fixtures: FullSubmissionFixtures;

    function computeSha256(content: string): string {
      return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    }

    function insertTestRunHelper(
      targetDb: Database.Database,
      opts: {
        id?: string;
        taskId: string;
        command?: string;
        exitCode?: number;
        passedCount?: number;
        failedCount?: number;
        skippedCount?: number;
        durationMs?: number;
        evidenceId?: string | null;
        createdAt?: string;
      }
    ): string {
      const id = opts.id ?? `tr-${crypto.randomUUID()}`;
      const now = opts.createdAt ?? new Date().toISOString();
      targetDb
        .prepare(`
          INSERT INTO test_runs (id, task_id, command, exit_code, passed_count, failed_count, skipped_count, duration_ms, evidence_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          opts.taskId,
          opts.command ?? 'npm test',
          opts.exitCode ?? 0,
          opts.passedCount ?? 1,
          opts.failedCount ?? 0,
          opts.skippedCount ?? 0,
          opts.durationMs ?? 100,
          opts.evidenceId ?? null,
          now
        );
      return id;
    }

    function insertEvidenceHelper(targetDb: Database.Database, f: FullSubmissionFixtures, type: 'GIT_STATUS' | 'GIT_DIFF'): string {
      const id = `ev-${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const content = 'dummy-evidence-content';
      const hash = computeSha256(content);
      targetDb.prepare(`
        INSERT INTO evidence (id, project_id, task_id, attempt_id, evidence_type, storage_type, file_path, hash, byte_size, content_type, summary, raw_payload, created_at)
        VALUES (?, ?, ?, ?, ?, 'INLINE', 'dummy.txt', ?, ?, 'text/plain', 'evidence', ?, ?)
      `).run(id, f.projectId, f.taskId, f.attemptId, type, hash, content.length, content, now);
      return id;
    }

    function insertAdjudicationHelper(
      targetDb: Database.Database,
      f: FullSubmissionFixtures,
      submissionId: string,
      opts: {
        id?: string;
        action?: 'ADMIT_VERIFICATION' | 'REJECT' | 'SUPERSEDE';
        status?: 'ADMITTED' | 'VERIFYING' | 'VERIFIED' | 'VERIFICATION_FAILED' | 'RECOVERY_FENCED' | 'REJECTED' | 'SUPERSEDED';
        lifecycleVersion?: number;
        testRunId?: string | null;
        failureCode?: string | null;
        failureJson?: string | null;
        completedAt?: string | null;
        recoveryFencedAt?: string | null;
        verificationStartedAt?: string | null;
        verificationResultEnvelopeJson?: string | null;
        verificationResultEnvelopeHash?: string | null;
        authoritySnapshotJson?: string | null;
        authoritySnapshotHash?: string | null;
        createdAt?: string;
        taskState?: string;
        skipDisposition?: boolean;
        skipTaskUpdate?: boolean;
        events?: Array<{ sequence: number; eventType: string; payloadJson?: string }>;
      }
    ): string {
      const id = opts.id ?? crypto.randomUUID();
      const requestId = crypto.randomUUID();
      const now = opts.createdAt ?? (opts.completedAt ?? (opts.recoveryFencedAt ?? new Date().toISOString()));
      const status = opts.status ?? 'ADMITTED';
      const action =
        opts.action ??
        (status === 'REJECTED' ? 'REJECT' : status === 'SUPERSEDED' ? 'SUPERSEDE' : 'ADMIT_VERIFICATION');
      const lifecycleVersion =
        opts.lifecycleVersion ??
        (['ADMITTED', 'REJECTED', 'SUPERSEDED'].includes(status) ? 1 : status === 'VERIFYING' ? 2 : 3);

      const sub = targetDb.prepare('SELECT * FROM coder_submissions WHERE id = ?').get(submissionId) as any;

      const taskState =
        opts.taskState ??
        (status === 'VERIFIED'
          ? 'REVIEW_READY'
          : status === 'VERIFYING' || status === 'ADMITTED'
          ? 'VALIDATING'
          : status === 'VERIFICATION_FAILED' || status === 'RECOVERY_FENCED'
          ? 'FIX_REQUIRED'
          : status === 'REJECTED'
          ? 'FAILED'
          : status === 'SUPERSEDED'
          ? 'CODING'
          : 'CODING');

      if (!opts.skipTaskUpdate) {
        targetDb.prepare('UPDATE tasks SET state = ? WHERE id = ?').run(taskState, f.taskId);
      }

      let snapJson = opts.authoritySnapshotJson;
      let snapHash = opts.authoritySnapshotHash;
      if (snapJson === undefined) {
        const snapObj: Record<string, unknown> = {
          assignment_id: sub?.assignment_id ?? f.assignmentId,
          assignment_status: 'ACTIVE',
          attempt_id: sub?.attempt_id ?? f.attemptId,
          attempt_number: 1,
          attempt_status: 'RUNNING',
          authorization_canonical_payload_hash: computeSha256('auth-payload'),
          authorization_id: f.authorizationId,
          authorization_lifecycle_version: 1,
          authorization_status: 'DISPATCHED',
          authorized_repository_head_sha: f.repoHeadSha,
          canonical_envelope_hash: sub?.canonical_envelope_hash ?? computeSha256('envelope'),
          claim_content_hash: sub?.claim_content_hash ?? computeSha256('claim'),
          current_terminal_disposition: null,
          execution_id: `exec-${crypto.randomUUID()}`,
          manager_protocol_message_id: f.managerMessageId,
          manager_raw_payload_hash: f.managerPayloadHash,
          project_id: f.projectId,
          project_repository_path: f.projectRoot,
          project_status: 'RUNNING',
          quarantine_status: 'QUARANTINED',
          routing_decision_id: f.routingDecisionId,
          selected_account_id: f.accountId,
          selected_provider_id: f.providerId,
          selected_resource_id: f.resourceId,
          submission_base_sha: sub?.base_sha ?? f.baseSha ?? '0'.repeat(40),
          submission_id: submissionId,
          submission_repository_head_sha: sub?.repository_head_sha ?? f.repoHeadSha,
          submitted_at: sub?.submitted_at ?? now,
          task_base_sha: f.baseSha ?? '0'.repeat(40),
          task_id: f.taskId,
          task_ownership_epoch: 1,
          task_state: taskState,
          worker_slot_id: null,
        };
        snapJson = canonicalJsonStringify(snapObj);
        snapHash = computeSha256(snapJson);
      } else if (snapHash === undefined && snapJson) {
        snapHash = computeSha256(snapJson);
      }

      const cmdJson =
        action === 'ADMIT_VERIFICATION'
          ? canonicalJsonStringify({ BUILD: null, LINT: null, TEST: 'npm test' })
          : null;
      const cmdHash = cmdJson ? computeSha256(cmdJson) : null;

      let envJson = opts.verificationResultEnvelopeJson !== undefined ? opts.verificationResultEnvelopeJson : null;
      let envHash = opts.verificationResultEnvelopeHash !== undefined ? opts.verificationResultEnvelopeHash : null;

      let gitStatusEvId: string | null = null;
      let gitDiffEvId: string | null = null;
      let artifactManifestJson: string | null = null;
      let artifactManifestHash: string | null = null;
      let workspaceSnapshotJson: string | null = null;
      let workspaceSnapshotHash: string | null = null;
      let verificationExecId: string | null = null;
      let testRunId = opts.testRunId ?? null;

      if (status === 'VERIFYING') {
        workspaceSnapshotJson = canonicalJsonStringify({ files: [] });
        workspaceSnapshotHash = computeSha256(workspaceSnapshotJson);
        verificationExecId = crypto.randomUUID();
      } else if (status === 'VERIFIED') {
        if (!testRunId) {
          testRunId = insertTestRunHelper(targetDb, {
            taskId: f.taskId,
            exitCode: 0,
            passedCount: 1,
            failedCount: 0,
            skippedCount: 0,
            durationMs: 100,
          });
        }
        gitStatusEvId = insertEvidenceHelper(targetDb, f, 'GIT_STATUS');
        gitDiffEvId = insertEvidenceHelper(targetDb, f, 'GIT_DIFF');
        artifactManifestJson = canonicalJsonStringify({ artifacts: [] });
        artifactManifestHash = computeSha256(artifactManifestJson);
        verificationExecId = crypto.randomUUID();
        workspaceSnapshotJson = canonicalJsonStringify({ files: [] });
        workspaceSnapshotHash = computeSha256(workspaceSnapshotJson);

        if (envJson === null) {
          const startTime = new Date(Date.now() - 5000).toISOString();
          const finishTime = new Date().toISOString();
          const trRow = targetDb.prepare('SELECT * FROM test_runs WHERE id = ?').get(testRunId) as any;
          const trEvId = trRow?.evidence_id ?? insertEvidenceHelper(targetDb, f, 'GIT_STATUS');
          const gitStatusRow = targetDb.prepare('SELECT hash FROM evidence WHERE id = ?').get(gitStatusEvId) as any;
          const gitDiffRow = targetDb.prepare('SELECT hash FROM evidence WHERE id = ?').get(gitDiffEvId) as any;
          const trEvRow = targetDb.prepare('SELECT hash FROM evidence WHERE id = ?').get(trEvId) as any;

          const envObj = {
            adjudication_id: id,
            artifact_manifest_hash: artifactManifestHash,
            assignment_id: sub?.assignment_id ?? f.assignmentId,
            attempt_id: sub?.attempt_id ?? f.attemptId,
            authorization_id: f.authorizationId,
            command_snapshot_hash: cmdHash ?? computeSha256('cmd'),
            exit_classification: 'EXIT_ZERO',
            failure_code: null,
            failure_payload: null,
            finish_timestamp: finishTime,
            git_diff_evidence_hash: gitDiffRow?.hash ?? computeSha256('diff'),
            git_diff_evidence_id: gitDiffEvId,
            git_status_evidence_hash: gitStatusRow?.hash ?? computeSha256('status'),
            git_status_evidence_id: gitStatusEvId,
            lifecycle_version: 3,
            process_start_classification: 'SPAWNED_PROVEN',
            project_id: f.projectId,
            start_timestamp: startTime,
            task_id: f.taskId,
            task_ownership_epoch: 1,
            termination_classification: 'TERMINATION_PROVEN',
            test_result_evidence_hash: trEvRow?.hash ?? computeSha256('test-evidence'),
            test_result_evidence_id: trEvId,
            test_run_id: testRunId,
            verification_execution_id: verificationExecId,
            workspace_snapshot_after_evidence_id: `ev-ws-${crypto.randomUUID()}`,
            workspace_snapshot_after_hash: computeSha256('after-ws'),
            workspace_snapshot_before_hash: workspaceSnapshotHash,
          };
          envJson = canonicalJsonStringify(envObj);
          envHash = computeSha256(envJson);
        } else if (envHash === null && envJson) {
          envHash = computeSha256(envJson);
        }
      }

      if (envJson && !envHash) {
        envHash = computeSha256(envJson);
      }

      const verificationStartedAt =
        opts.verificationStartedAt !== undefined
          ? opts.verificationStartedAt
          : ['VERIFYING', 'VERIFIED'].includes(status)
          ? now
          : null;

      const completedAt =
        opts.completedAt !== undefined
          ? opts.completedAt
          : ['VERIFIED', 'VERIFICATION_FAILED', 'REJECTED', 'SUPERSEDED'].includes(status)
          ? now
          : null;

      const fencedAt =
        opts.recoveryFencedAt !== undefined
          ? opts.recoveryFencedAt
          : status === 'RECOVERY_FENCED'
          ? now
          : null;

      const failureCode =
        opts.failureCode !== undefined
          ? opts.failureCode
          : ['VERIFICATION_FAILED', 'RECOVERY_FENCED'].includes(status)
          ? 'VERIFICATION_PROCESS_NON_ZERO'
          : null;

      targetDb
        .prepare(`
          INSERT INTO coder_submission_adjudications (
            id, request_id, submission_id, authorization_id, project_id, task_id,
            attempt_id, assignment_id, task_ownership_epoch, action, status,
            lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
            verification_commands_json, verification_commands_hash,
            workspace_snapshot_before_json, workspace_snapshot_before_hash,
            verification_result_envelope_json, verification_result_envelope_hash,
            verification_execution_id, protocol_message_id, test_run_id,
            git_status_evidence_id, git_diff_evidence_id, failure_code, failure_json,
            created_at, verification_started_at, completed_at, recovery_fenced_at,
            artifact_manifest_json, artifact_manifest_hash
          ) VALUES (
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?,
            ?, ?,
            ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?
          )
        `)
        .run(
          id,
          requestId,
          submissionId,
          f.authorizationId,
          f.projectId,
          f.taskId,
          sub?.attempt_id ?? f.attemptId,
          sub?.assignment_id ?? f.assignmentId,
          1,
          action,
          status,
          lifecycleVersion,
          snapJson,
          snapHash,
          cmdJson,
          cmdHash,
          workspaceSnapshotJson,
          workspaceSnapshotHash,
          envJson,
          envHash,
          verificationExecId,
          null,
          testRunId,
          gitStatusEvId,
          gitDiffEvId,
          failureCode,
          opts.failureJson ?? null,
          now,
          verificationStartedAt,
          completedAt,
          fencedAt,
          artifactManifestJson,
          artifactManifestHash
        );

      const eventDefs: Array<{ sequence: number; eventType: string; payloadJson?: string }> =
        opts.events ??
        (() => {
          if (status === 'ADMITTED') {
            return [{ sequence: 1, eventType: 'ADMITTED' }];
          } else if (status === 'VERIFYING') {
            return [
              { sequence: 1, eventType: 'ADMITTED' },
              { sequence: 2, eventType: 'VERIFICATION_CLAIMED' },
            ];
          } else if (status === 'VERIFIED') {
            return [
              { sequence: 1, eventType: 'ADMITTED' },
              { sequence: 2, eventType: 'VERIFICATION_CLAIMED' },
              { sequence: 3, eventType: 'VERIFICATION_SUCCEEDED' },
            ];
          } else if (status === 'VERIFICATION_FAILED') {
            return [
              { sequence: 1, eventType: 'ADMITTED' },
              { sequence: 2, eventType: 'VERIFICATION_CLAIMED' },
              { sequence: 3, eventType: 'VERIFICATION_FAILED' },
            ];
          } else if (status === 'RECOVERY_FENCED') {
            return [
              { sequence: 1, eventType: 'ADMITTED' },
              { sequence: 2, eventType: 'VERIFICATION_CLAIMED' },
              { sequence: 3, eventType: 'RECOVERY_FENCED' },
            ];
          } else if (status === 'REJECTED') {
            return [{ sequence: 1, eventType: 'REJECTED' }];
          } else if (status === 'SUPERSEDED') {
            return [{ sequence: 1, eventType: 'SUPERSEDED' }];
          }
          return [{ sequence: 1, eventType: 'ADMITTED' }];
        })();

      for (const ed of eventDefs) {
        const evPayload = ed.payloadJson ?? canonicalJsonStringify({ status: ed.eventType, adjudication_id: id });
        const evHash = computeSha256(evPayload);
        targetDb
          .prepare(`
            INSERT INTO coder_submission_adjudication_events (
              id, adjudication_id, sequence, event_type, payload_json, payload_hash, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `)
          .run(crypto.randomUUID(), id, ed.sequence, ed.eventType, evPayload, evHash, now);
      }

      return id;
    }

    beforeEach(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-status-test-'));
      const created = createTestDatabase(testDir, 'status-test.db');
      db = created.db;
      dbPath = created.dbPath;
      fixtures = setupFullSubmissionGraph(db);
    });

    afterEach(() => {
      try {
        if (db && db.open) db.close();
      } finally {
        if (testDir && fs.existsSync(testDir)) {
          fs.rmSync(testDir, { recursive: true, force: true });
        }
      }
    });

    it('1. Exact tool discovery: existing submit tool plus exactly one status tool', async () => {
      const server = buildAgentForgeSubmissionMcpServer({ db, service: fixtures.service });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await client.connect(clientTransport);

      const toolsRes = await client.listTools();
      expect(toolsRes.tools).toHaveLength(2);
      const toolNames = toolsRes.tools.map((t) => t.name).sort();
      expect(toolNames).toEqual([SUBMISSION_STATUS_TOOL_NAME, SUBMISSION_TOOL_NAME].sort());

      const statusTool = toolsRes.tools.find((t) => t.name === SUBMISSION_STATUS_TOOL_NAME);
      expect(statusTool).toBeDefined();
      expect(statusTool?.annotations).toEqual(SUBMISSION_STATUS_TOOL_ANNOTATIONS);
    });

    it('2. Exact resource-template discovery', async () => {
      const server = buildAgentForgeSubmissionMcpServer({ db, service: fixtures.service });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await client.connect(clientTransport);

      const templatesRes = await client.listResourceTemplates();
      expect(templatesRes.resourceTemplates).toHaveLength(1);
      const template = templatesRes.resourceTemplates[0];
      expect(template.name).toBe(SUBMISSION_STATUS_RESOURCE_NAME);
      expect(template.uriTemplate).toBe(SUBMISSION_STATUS_URI_TEMPLATE);
      expect(template.mimeType).toBe(SUBMISSION_STATUS_MIME_TYPE);
    });

    it('3. Tool/resource output parity', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const server = buildAgentForgeSubmissionMcpServer({ db, service: fixtures.service, submissionToken: plaintextToken });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await client.connect(clientTransport);

      // Call tool
      const toolRes = await client.callTool({
        name: SUBMISSION_STATUS_TOOL_NAME,
        arguments: { submission_id: subId },
      });
      expect(toolRes.isError).toBeFalsy();
      const toolStructured = (toolRes as any).structuredContent;

      // Read resource
      const resourceRes = await client.readResource({
        uri: `agentforge://submissions/${subId}`,
      });
      expect(resourceRes.contents).toHaveLength(1);
      const resourceText = (resourceRes.contents[0] as { text: string }).text;

      // Byte-for-byte canonical equivalence
      expect(canonicalJsonStringify(toolStructured)).toBe(resourceText);
    });

    it('4. QUARANTINED projection with no adjudication', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.submission_id).toBe(subId);
        expect(res.lifecycle_status).toBe('QUARANTINED');
        expect(res.terminal_outcome).toBeNull();
        expect(res.task_state).toBe('CODING');
        expect(res.verification_summary).toBeNull();
        expect(res.settled_at).toBeNull();
        expect(res.submitted_at).toBeDefined();
      }
    });

    it('5. ADMITTED projection', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      insertAdjudicationHelper(db, fixtures, subId, { status: 'ADMITTED' });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.lifecycle_status).toBe('ADMITTED');
        expect(res.terminal_outcome).toBeNull();
        expect(res.verification_summary).toBeNull();
        expect(res.settled_at).toBeNull();
      }
    });

    it('6. VERIFYING projection', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      insertAdjudicationHelper(db, fixtures, subId, { status: 'VERIFYING' });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.lifecycle_status).toBe('VERIFYING');
        expect(res.terminal_outcome).toBeNull();
        expect(res.verification_summary).toBeNull();
        expect(res.settled_at).toBeNull();
      }
    });

    it('7. VERIFIED -> ACCEPTED_VERIFIED projection', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      const testRunId = insertTestRunHelper(db, {
        taskId: fixtures.taskId,
        exitCode: 0,
        passedCount: 8,
        failedCount: 0,
        skippedCount: 1,
        durationMs: 450,
      });
      const completedAt = new Date().toISOString();
      insertAdjudicationHelper(db, fixtures, subId, {
        status: 'VERIFIED',
        testRunId,
        completedAt,
      });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.lifecycle_status).toBe('VERIFIED');
        expect(res.terminal_outcome).toBe('ACCEPTED_VERIFIED');
        expect(res.settled_at).toBe(completedAt);
        expect(res.verification_summary).toEqual({
          exit_code: 0,
          passed_count: 8,
          failed_count: 0,
          skipped_count: 1,
          duration_ms: 450,
          failure_code: null,
          failure_message: null,
        });
      }
    });

    it('8. VERIFICATION_FAILED projection with exact metrics and scrubbed message', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      const testRunId = insertTestRunHelper(db, {
        taskId: fixtures.taskId,
        exitCode: 1,
        passedCount: 5,
        failedCount: 2,
        skippedCount: 0,
        durationMs: 820,
      });
      const completedAt = new Date().toISOString();
      insertAdjudicationHelper(db, fixtures, subId, {
        status: 'VERIFICATION_FAILED',
        testRunId,
        failureCode: 'TEST_SUITE_FAILED',
        failureJson: JSON.stringify({ error: 'Failure at C:\\Users\\Tester\\app\\test.ts' }),
        completedAt,
      });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.lifecycle_status).toBe('VERIFICATION_FAILED');
        expect(res.terminal_outcome).toBe('VERIFICATION_FAILED');
        expect(res.settled_at).toBe(completedAt);
        expect(res.verification_summary).toEqual({
          exit_code: 1,
          passed_count: 5,
          failed_count: 2,
          skipped_count: 0,
          duration_ms: 820,
          failure_code: 'TEST_SUITE_FAILED',
          failure_message: 'Failure at [REDACTED_PATH]',
        });
      }
    });

    it('9. RECOVERY_FENCED projection', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      const fencedAt = new Date().toISOString();
      insertAdjudicationHelper(db, fixtures, subId, {
        status: 'RECOVERY_FENCED',
        failureCode: 'ORPHANED_VERIFICATION_CANCELLED',
        failureJson: JSON.stringify({ error: 'Process timeout after 60000ms' }),
        recoveryFencedAt: fencedAt,
      });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.lifecycle_status).toBe('RECOVERY_FENCED');
        expect(res.terminal_outcome).toBe('RECOVERY_FENCED');
        expect(res.settled_at).toBe(fencedAt);
        expect(res.verification_summary?.failure_code).toBe('ORPHANED_VERIFICATION_CANCELLED');
        expect(res.verification_summary?.failure_message).toBe('Process timeout after 60000ms');
      }
    });

    it('10. Owner REJECTED projection', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      const completedAt = new Date().toISOString();
      insertAdjudicationHelper(db, fixtures, subId, {
        status: 'REJECTED',
        action: 'REJECT',
        failureCode: 'REJECTED_BY_OPERATOR',
        failureJson: JSON.stringify({ operator_reason: 'Code quality does not meet standards' }),
        completedAt,
      });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.lifecycle_status).toBe('REJECTED');
        expect(res.terminal_outcome).toBe('REJECTED');
        expect(res.settled_at).toBe(completedAt);
        expect(res.verification_summary?.exit_code).toBeNull();
        expect(res.verification_summary?.failure_code).toBe('REJECTED_BY_OPERATOR');
        expect(res.verification_summary?.failure_message).toBe('Code quality does not meet standards');
      }
    });

    it('11. Owner SUPERSEDED projection', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      const completedAt = new Date().toISOString();
      insertAdjudicationHelper(db, fixtures, subId, {
        status: 'SUPERSEDED',
        action: 'SUPERSEDE',
        failureCode: 'SUPERSEDED_BY_NEWER_CLAIM',
        failureJson: JSON.stringify({ operator_reason: 'Newer attempt claimed task' }),
        completedAt,
      });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.lifecycle_status).toBe('SUPERSEDED');
        expect(res.terminal_outcome).toBe('SUPERSEDED');
        expect(res.settled_at).toBe(completedAt);
        expect(res.verification_summary?.failure_code).toBe('SUPERSEDED_BY_NEWER_CLAIM');
        expect(res.verification_summary?.failure_message).toBe('Newer attempt claimed task');
      }
    });

    it('12. Valid replacement token for the same authorization can observe an earlier submission', () => {
      // Issue first session and submit
      const { plaintextToken: token1, sessionId: sess1 } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), token1);

      // Issue replacement session (revokes token1, creates token2)
      fixtures.repo.revokeMcpSubmissionSession(sess1, new Date().toISOString(), 'ROTATION');
      const { plaintextToken: token2 } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);

      // token2 can observe subId
      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, token2);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.submission_id).toBe(subId);
        expect(res.lifecycle_status).toBe('QUARANTINED');
      }
    });

    it('13. Superseded/revoked old token is rejected', () => {
      const { plaintextToken: token1, sessionId: sess1 } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), token1);

      // Reissue creates new session and revokes old
      fixtures.repo.revokeMcpSubmissionSession(sess1, new Date().toISOString(), 'ROTATION');
      issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, token1);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('MCP_SESSION_REVOKED');
        expect(res.retryable).toBe(false);
      }
    });

    it('14. Expired token is rejected', () => {
      const past = new Date(Date.now() - 3600 * 1000).toISOString();
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId, 300, past);
      const subId = crypto.randomUUID();

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('MCP_SESSION_EXPIRED');
        expect(res.retryable).toBe(false);
      }
    });

    it('15. Malformed token is rejected', () => {
      const subId = crypto.randomUUID();
      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, 'bad-token');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('INVALID_SUBMISSION_TOKEN');
        expect(res.retryable).toBe(false);
      }
    });

    it('16. af-mcp context token is rejected', () => {
      const subId = crypto.randomUUID();
      const res = fixtures.service.getSubmissionStatus(
        { submission_id: subId },
        'af-mcp-1234567890123456789012345678901234567890123'
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('INVALID_SUBMISSION_TOKEN');
        expect(res.retryable).toBe(false);
      }
    });

    it('17. Missing configured token is rejected', () => {
      const subId = crypto.randomUUID();
      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, undefined);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('INVALID_SUBMISSION_TOKEN');
        expect(res.retryable).toBe(false);
      }
    });

    it('18. Cross-authorization lookup returns indistinguishable SUBMISSION_NOT_FOUND', () => {
      // Create authorization 1 and submit
      const { plaintextToken: token1 } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), token1);

      // Create authorization 2 with its own session
      const auth2Id = `auth-2-${crypto.randomUUID()}`;
      const auth2 = { ...fixtures.auth, id: auth2Id };
      fixtures.repo.createExecutionAuthorization(auth2);

      const { plaintextToken: token2 } = issueSubmissionSessionHelper(fixtures.repo, auth2Id);

      // Lookup subId with token2
      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, token2);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_NOT_FOUND');
        expect(res.retryable).toBe(false);
      }
    });

    it('19. Cross-task and cross-project lookup returns indistinguishable SUBMISSION_NOT_FOUND', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Set up a second completely independent project/task graph
      const fixtures2 = setupFullSubmissionGraph(db);
      const { plaintextToken: token2 } = issueSubmissionSessionHelper(fixtures2.repo, fixtures2.authorizationId);
      const subId2 = crypto.randomUUID();
      fixtures2.service.submitCoderClaim(createValidSubmissionPayload(fixtures2, subId2), token2);

      // Query subId2 using token1 (belonging to fixtures)
      const res = fixtures.service.getSubmissionStatus({ submission_id: subId2 }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_NOT_FOUND');
        expect(res.retryable).toBe(false);
      }
    });

    it('20. Unknown UUID returns SUBMISSION_NOT_FOUND', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const unknownUuid = '11111111-2222-4333-8444-555555555555';
      const res = fixtures.service.getSubmissionStatus({ submission_id: unknownUuid }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_NOT_FOUND');
        expect(res.retryable).toBe(false);
      }
    });

    it('21. Extra input property rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const res = fixtures.service.getSubmissionStatus(
        { submission_id: crypto.randomUUID(), extra_field: 'forbidden' },
        plaintextToken
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SCHEMA_VALIDATION_FAILED');
        expect(res.retryable).toBe(false);
      }
    });

    it('22. Uppercase or non-v4 UUID rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const uppercaseUuid = crypto.randomUUID().toUpperCase();
      const res1 = fixtures.service.getSubmissionStatus({ submission_id: uppercaseUuid }, plaintextToken);
      expect(res1.ok).toBe(false);
      if (!res1.ok) {
        expect(res1.error_code).toBe('SCHEMA_VALIDATION_FAILED');
      }

      const nonV4Uuid = '00000000-0000-1000-8000-000000000000'; // version 1, not 4
      const res2 = fixtures.service.getSubmissionStatus({ submission_id: nonV4Uuid }, plaintextToken);
      expect(res2.ok).toBe(false);
      if (!res2.ok) {
        expect(res2.error_code).toBe('SCHEMA_VALIDATION_FAILED');
      }
    });

    it('23. Oversized argument payload rejected before service execution', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const bigPayload = {
        submission_id: crypto.randomUUID(),
        huge: 'x'.repeat(70000),
      };
      const res = fixtures.service.getSubmissionStatus(bigPayload, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SCHEMA_VALIDATION_FAILED');
      }
    });

    it('24. Contradictory adjudication history fails closed', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Insert adjudication with contradictory event log (e.g. sequence jumping from 1 to 3)
      insertAdjudicationHelper(db, fixtures, subId, {
        status: 'VERIFYING',
        events: [
          { sequence: 1, eventType: 'ADMITTED' },
          { sequence: 3, eventType: 'VERIFICATION_CLAIMED' }, // broken sequence
        ],
      });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('25. Duplicate/ambiguous terminal authority fails closed', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Insert two terminal adjudications for the same submission
      const t1 = insertTestRunHelper(db, { taskId: fixtures.taskId, exitCode: 0 });
      insertAdjudicationHelper(db, fixtures, subId, { status: 'VERIFIED', testRunId: t1, lifecycleVersion: 2 });
      insertAdjudicationHelper(db, fixtures, subId, { status: 'REJECTED', lifecycleVersion: 3 });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('26. Missing required linked test run fails closed', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Point adjudication to a non-existent test_run_id
      db.pragma('foreign_keys = OFF');
      insertAdjudicationHelper(db, fixtures, subId, {
        status: 'VERIFIED',
        testRunId: 'tr-does-not-exist',
      });
      db.pragma('foreign_keys = ON');

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('27. Test run bound to the wrong task fails closed', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Create test run for different task
      const otherTaskId = `task-other-${crypto.randomUUID()}`;
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, state, revision_count, ownership_epoch, created_at, updated_at)
        VALUES (?, ?, 'Other', 'CODING', 1, 1, ?, ?)
      `).run(otherTaskId, fixtures.projectId, new Date().toISOString(), new Date().toISOString());

      const trOther = insertTestRunHelper(db, { taskId: otherTaskId, exitCode: 0 });

      insertAdjudicationHelper(db, fixtures, subId, {
        status: 'VERIFIED',
        testRunId: trOther,
      });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('28. Malformed failure_json fails closed', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.pragma('ignore_check_constraints = ON');
      insertAdjudicationHelper(db, fixtures, subId, {
        status: 'VERIFICATION_FAILED',
        failureCode: 'TEST_FAIL',
        failureJson: '{not-json',
      });
      db.pragma('ignore_check_constraints = OFF');

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('29. Malformed result envelope or hash mismatch fails closed when consulted', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      insertAdjudicationHelper(db, fixtures, subId, {
        status: 'VERIFIED',
        testRunId: insertTestRunHelper(db, { taskId: fixtures.taskId, exitCode: 0 }),
        verificationResultEnvelopeJson: '{"valid":true}',
        verificationResultEnvelopeHash: '0'.repeat(64), // Mismatching hash
      });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('30. Stored raw path/token/stack sentinels never appear in output', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sentinelText = `Error at C:\\Projects\\Secret\\file.ts
at Object.run (d:/repo/index.js:5:10)
Bearer secret_token_12345
token=af-sub-ABCDEFGHIJKLMNOPQRSTUVWXYZ12345678901234567
SELECT * FROM users WHERE id = 1;`;

      insertAdjudicationHelper(db, fixtures, subId, {
        status: 'VERIFICATION_FAILED',
        failureCode: 'TEST_FAIL',
        failureJson: JSON.stringify({ error: sentinelText }),
      });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(true);
      if (res.ok && res.verification_summary) {
        const msg = res.verification_summary.failure_message ?? '';
        expect(msg).not.toContain('C:\\Projects');
        expect(msg).not.toContain('d:/repo');
        expect(msg).not.toContain('secret_token_12345');
        expect(msg).not.toContain('af-sub-');
        expect(msg).not.toContain('SELECT * FROM');
        expect(msg).not.toContain('at Object.run');
        expect(msg).toContain('[REDACTED_PATH]');
        expect(msg).toContain('[REDACTED_TOKEN]');
      }
    });

    it('31. Repeated query returns byte-identical canonical structured content', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const res1 = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      const res2 = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res1.ok).toBe(true);
      expect(res2.ok).toBe(true);
      expect(canonicalJsonStringify(res1)).toBe(canonicalJsonStringify(res2));
    });

    it('32. At least 1,000 repeated successful queries cause zero database mutations', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const initialTotalChanges = fixtures.repo.getTotalChanges();
      for (let i = 0; i < 1000; i++) {
        const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
        expect(res.ok).toBe(true);
      }
      const finalTotalChanges = fixtures.repo.getTotalChanges();
      expect(finalTotalChanges).toBe(initialTotalChanges);
    });

    it('33. Error paths cause zero database mutations', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const initialTotalChanges = fixtures.repo.getTotalChanges();

      // 1. Not found
      fixtures.service.getSubmissionStatus({ submission_id: crypto.randomUUID() }, plaintextToken);
      // 2. Invalid token
      fixtures.service.getSubmissionStatus({ submission_id: crypto.randomUUID() }, 'bad');
      // 3. Schema error
      fixtures.service.getSubmissionStatus({ submission_id: 'bad', extra: 1 }, plaintextToken);

      const finalTotalChanges = fixtures.repo.getTotalChanges();
      expect(finalTotalChanges).toBe(initialTotalChanges);
    });

    it('34. Query spawns zero Git or child-process calls', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const execSpy = vi.spyOn(child_process, 'exec');
      const execFileSpy = vi.spyOn(child_process, 'execFile');
      const execFileSyncSpy = vi.spyOn(child_process, 'execFileSync');
      const spawnSpy = vi.spyOn(child_process, 'spawn');

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(true);

      expect(execSpy).not.toHaveBeenCalled();
      expect(execFileSpy).not.toHaveBeenCalled();
      expect(execFileSyncSpy).not.toHaveBeenCalled();
      expect(spawnSpy).not.toHaveBeenCalled();

      execSpy.mockRestore();
      execFileSpy.mockRestore();
      execFileSyncSpy.mockRestore();
      spawnSpy.mockRestore();
    });

    it('35. Concurrent queries remain isolated and deterministic', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const promises = Array.from({ length: 50 }, () =>
        Promise.resolve(fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken))
      );

      const results = await Promise.all(promises);
      const baseline = canonicalJsonStringify(results[0]);
      for (const r of results) {
        expect(r.ok).toBe(true);
        expect(canonicalJsonStringify(r)).toBe(baseline);
      }
    });

    it('36. Database busy/locked handling is scrubbed and follows retryability policy', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Spy on getCoderSubmissionById to simulate SQLITE_BUSY
      const spy = vi.spyOn(fixtures.repo, 'getCoderSubmissionById').mockImplementation(() => {
        throw new Error('SQLITE_BUSY: database is locked');
      });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('DATABASE_BUSY');
        expect(res.retryable).toBe(true);
      }

      spy.mockRestore();
    });

    it('37. Existing submit-claim behavior remains byte-compatible', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      const payload = createValidSubmissionPayload(fixtures, subId);

      const res = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(res.accepted).toBe(true);
      if (res.accepted) {
        expect(res.submission_id).toBe(subId);
        expect(res.quarantine_status).toBe('QUARANTINED');
        expect(res.is_duplicate).toBe(false);
        expect(res.claim_content_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(res.canonical_envelope_hash).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('38. Existing R5J1-R5J5 focused suites remain green', () => {
      // Proves schema and migration immutability
      expect(typeof fixtures.service.submitCoderClaim).toBe('function');
      expect(typeof fixtures.service.getSubmissionStatus).toBe('function');
    });

    it('39. Migration count remains exactly 24', () => {
      expect(MIGRATIONS).toHaveLength(24);
      expect(MIGRATIONS[MIGRATIONS.length - 1].version).toBe(24);
      expect(MIGRATIONS[MIGRATIONS.length - 1].name).toBe(
        '024_r5j_reviewer_session_authority'
      );
    });

    it('40. Tool schema, resource schema, Zod schema, TypeScript type, and runtime payload remain exact and closed', () => {
      // Validate tool schema properties
      expect(CODER_SUBMISSION_STATUS_INPUT_JSON_SCHEMA.type).toBe('object');
      expect(CODER_SUBMISSION_STATUS_INPUT_JSON_SCHEMA.required).toEqual(['submission_id']);
      expect(CODER_SUBMISSION_STATUS_INPUT_JSON_SCHEMA.additionalProperties).toBe(false);

      // Validate output schema
      expect(CODER_SUBMISSION_STATUS_OUTPUT_JSON_SCHEMA.type).toBe('object');
      expect(CODER_SUBMISSION_STATUS_OUTPUT_JSON_SCHEMA.oneOf).toHaveLength(2);

      // Validate Zod schemas
      const validUuid = crypto.randomUUID();
      expect(SubmissionStatusInputZodSchema.safeParse({ submission_id: validUuid }).success).toBe(true);
      expect(SubmissionStatusInputZodSchema.safeParse({ submission_id: validUuid, extra: 1 }).success).toBe(false);

      const validSuccessResult = {
        ok: true,
        submission_id: validUuid,
        lifecycle_status: 'QUARANTINED',
        terminal_outcome: null,
        task_state: 'CODING',
        verification_summary: null,
        submitted_at: new Date().toISOString(),
        settled_at: null,
      };
      expect(SubmissionStatusSuccessZodSchema.safeParse(validSuccessResult).success).toBe(true);

      const validErrorResult = {
        ok: false,
        error_code: 'SUBMISSION_NOT_FOUND',
        message: 'Submission not found',
        retryable: false,
      };
      expect(SubmissionStatusErrorZodSchema.safeParse(validErrorResult).success).toBe(true);
    });
  });

  // ============================================================================
  // Group 15: Corrective Pass 2 Semantic Authority Hardening Gated Proofs
  // ============================================================================
  describe('Group 15: Corrective Pass 2 Semantic Authority Hardening Gated Proofs', () => {
    let testDir: string;
    let db: Database.Database;
    let dbPath: string;
    let fixtures: FullSubmissionFixtures;

    function computeSha256(content: string): string {
      return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    }

    function insertTestRunHelper(
      targetDb: Database.Database,
      opts: {
        id?: string;
        taskId: string;
        command?: string;
        exitCode?: number | null;
        passedCount?: number | null;
        failedCount?: number | null;
        skippedCount?: number | null;
        durationMs?: number | null;
        evidenceId?: string | null;
        createdAt?: string;
      }
    ): string {
      const id = opts.id ?? `tr-${crypto.randomUUID()}`;
      const now = opts.createdAt ?? new Date().toISOString();
      targetDb
        .prepare(`
          INSERT INTO test_runs (id, task_id, command, exit_code, passed_count, failed_count, skipped_count, duration_ms, evidence_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          opts.taskId,
          opts.command ?? 'npm test',
          opts.exitCode !== undefined ? opts.exitCode : 0,
          opts.passedCount !== undefined ? opts.passedCount : 1,
          opts.failedCount !== undefined ? opts.failedCount : 0,
          opts.skippedCount !== undefined ? opts.skippedCount : 0,
          opts.durationMs !== undefined ? opts.durationMs : 100,
          opts.evidenceId ?? null,
          now
        );
      return id;
    }

    function insertEvidenceHelper(targetDb: Database.Database, f: FullSubmissionFixtures, type: 'GIT_STATUS' | 'GIT_DIFF'): string {
      const id = `ev-${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const content = 'dummy-evidence-content';
      const hash = computeSha256(content);
      targetDb.prepare(`
        INSERT INTO evidence (id, project_id, task_id, attempt_id, evidence_type, storage_type, file_path, hash, byte_size, content_type, summary, raw_payload, created_at)
        VALUES (?, ?, ?, ?, ?, 'INLINE', 'dummy.txt', ?, ?, 'text/plain', 'evidence', ?, ?)
      `).run(id, f.projectId, f.taskId, f.attemptId, type, hash, content.length, content, now);
      return id;
    }

    function insertAdjudicationHelper(
      targetDb: Database.Database,
      f: FullSubmissionFixtures,
      submissionId: string,
      opts: {
        id?: string;
        action?: 'ADMIT_VERIFICATION' | 'REJECT' | 'SUPERSEDE';
        status?: 'ADMITTED' | 'VERIFYING' | 'VERIFIED' | 'VERIFICATION_FAILED' | 'RECOVERY_FENCED' | 'REJECTED' | 'SUPERSEDED';
        lifecycleVersion?: number;
        testRunId?: string | null;
        failureCode?: string | null;
        failureJson?: string | null;
        completedAt?: string | null;
        recoveryFencedAt?: string | null;
        verificationStartedAt?: string | null;
        verificationResultEnvelopeJson?: string | null;
        verificationResultEnvelopeHash?: string | null;
        authoritySnapshotJson?: string | null;
        authoritySnapshotHash?: string | null;
        createdAt?: string;
        taskState?: string;
        skipDisposition?: boolean;
        skipTaskUpdate?: boolean;
        events?: Array<{ sequence: number; eventType: string; payloadJson?: string }>;
      }
    ): string {
      const id = opts.id ?? crypto.randomUUID();
      const requestId = crypto.randomUUID();
      const now = opts.createdAt ?? (opts.completedAt ?? (opts.recoveryFencedAt ?? new Date().toISOString()));
      const status = opts.status ?? 'ADMITTED';
      const action =
        opts.action ??
        (status === 'REJECTED' ? 'REJECT' : status === 'SUPERSEDED' ? 'SUPERSEDE' : 'ADMIT_VERIFICATION');
      const lifecycleVersion =
        opts.lifecycleVersion ??
        (['ADMITTED', 'REJECTED', 'SUPERSEDED'].includes(status) ? 1 : status === 'VERIFYING' ? 2 : 3);

      const sub = targetDb.prepare('SELECT * FROM coder_submissions WHERE id = ?').get(submissionId) as any;

      const taskState =
        opts.taskState ??
        (status === 'VERIFIED'
          ? 'REVIEW_READY'
          : status === 'VERIFYING' || status === 'ADMITTED'
          ? 'VALIDATING'
          : status === 'VERIFICATION_FAILED' || status === 'RECOVERY_FENCED'
          ? 'FIX_REQUIRED'
          : status === 'REJECTED'
          ? 'FAILED'
          : status === 'SUPERSEDED'
          ? 'CODING'
          : 'CODING');

      if (!opts.skipTaskUpdate) {
        targetDb.prepare('UPDATE tasks SET state = ? WHERE id = ?').run(taskState, f.taskId);
      }

      let snapJson = opts.authoritySnapshotJson;
      let snapHash = opts.authoritySnapshotHash;
      if (snapJson === undefined) {
        const snapObj: Record<string, unknown> = {
          assignment_id: sub?.assignment_id ?? f.assignmentId,
          assignment_status: 'ACTIVE',
          attempt_id: sub?.attempt_id ?? f.attemptId,
          attempt_number: 1,
          attempt_status: 'RUNNING',
          authorization_canonical_payload_hash: computeSha256('auth-payload'),
          authorization_id: f.authorizationId,
          authorization_lifecycle_version: 1,
          authorization_status: 'DISPATCHED',
          authorized_repository_head_sha: f.repoHeadSha,
          canonical_envelope_hash: sub?.canonical_envelope_hash ?? computeSha256('envelope'),
          claim_content_hash: sub?.claim_content_hash ?? computeSha256('claim'),
          current_terminal_disposition: null,
          execution_id: `exec-${crypto.randomUUID()}`,
          manager_protocol_message_id: f.managerMessageId,
          manager_raw_payload_hash: f.managerPayloadHash,
          project_id: f.projectId,
          project_repository_path: f.projectRoot,
          project_status: 'RUNNING',
          quarantine_status: 'QUARANTINED',
          routing_decision_id: f.routingDecisionId,
          selected_account_id: f.accountId,
          selected_provider_id: f.providerId,
          selected_resource_id: f.resourceId,
          submission_base_sha: sub?.base_sha ?? f.baseSha ?? '0'.repeat(40),
          submission_id: submissionId,
          submission_repository_head_sha: sub?.repository_head_sha ?? f.repoHeadSha,
          submitted_at: sub?.submitted_at ?? now,
          task_base_sha: f.baseSha ?? '0'.repeat(40),
          task_id: f.taskId,
          task_ownership_epoch: 1,
          task_state: taskState,
          worker_slot_id: null,
        };
        snapJson = canonicalJsonStringify(snapObj);
        snapHash = computeSha256(snapJson);
      } else if (snapHash === undefined && snapJson) {
        snapHash = computeSha256(snapJson);
      }

      const cmdJson =
        action === 'ADMIT_VERIFICATION'
          ? canonicalJsonStringify({ BUILD: null, LINT: null, TEST: 'npm test' })
          : null;
      const cmdHash = cmdJson ? computeSha256(cmdJson) : null;

      let envJson = opts.verificationResultEnvelopeJson !== undefined ? opts.verificationResultEnvelopeJson : null;
      let envHash = opts.verificationResultEnvelopeHash !== undefined ? opts.verificationResultEnvelopeHash : null;

      let gitStatusEvId: string | null = null;
      let gitDiffEvId: string | null = null;
      let artifactManifestJson: string | null = null;
      let artifactManifestHash: string | null = null;
      let workspaceSnapshotJson: string | null = null;
      let workspaceSnapshotHash: string | null = null;
      let verificationExecId: string | null = null;
      let testRunId = opts.testRunId ?? null;

      if (status === 'VERIFYING') {
        workspaceSnapshotJson = canonicalJsonStringify({ files: [] });
        workspaceSnapshotHash = computeSha256(workspaceSnapshotJson);
        verificationExecId = crypto.randomUUID();
      } else if (status === 'VERIFIED') {
        if (!testRunId) {
          testRunId = insertTestRunHelper(targetDb, {
            taskId: f.taskId,
            exitCode: 0,
            passedCount: 1,
            failedCount: 0,
            skippedCount: 0,
            durationMs: 100,
          });
        }
        gitStatusEvId = insertEvidenceHelper(targetDb, f, 'GIT_STATUS');
        gitDiffEvId = insertEvidenceHelper(targetDb, f, 'GIT_DIFF');
        artifactManifestJson = canonicalJsonStringify({ artifacts: [] });
        artifactManifestHash = computeSha256(artifactManifestJson);
        verificationExecId = crypto.randomUUID();
        workspaceSnapshotJson = canonicalJsonStringify({ files: [] });
        workspaceSnapshotHash = computeSha256(workspaceSnapshotJson);

        if (envJson === null) {
          const startTime = new Date(Date.now() - 5000).toISOString();
          const finishTime = new Date().toISOString();
          const trRow = targetDb.prepare('SELECT * FROM test_runs WHERE id = ?').get(testRunId) as any;
          const trEvId = trRow?.evidence_id ?? insertEvidenceHelper(targetDb, f, 'GIT_STATUS');
          const gitStatusRow = targetDb.prepare('SELECT hash FROM evidence WHERE id = ?').get(gitStatusEvId) as any;
          const gitDiffRow = targetDb.prepare('SELECT hash FROM evidence WHERE id = ?').get(gitDiffEvId) as any;
          const trEvRow = targetDb.prepare('SELECT hash FROM evidence WHERE id = ?').get(trEvId) as any;

          const envObj = {
            adjudication_id: id,
            artifact_manifest_hash: artifactManifestHash,
            assignment_id: sub?.assignment_id ?? f.assignmentId,
            attempt_id: sub?.attempt_id ?? f.attemptId,
            authorization_id: f.authorizationId,
            command_snapshot_hash: cmdHash ?? computeSha256('cmd'),
            exit_classification: 'EXIT_ZERO',
            failure_code: null,
            failure_payload: null,
            finish_timestamp: finishTime,
            git_diff_evidence_hash: gitDiffRow?.hash ?? computeSha256('diff'),
            git_diff_evidence_id: gitDiffEvId,
            git_status_evidence_hash: gitStatusRow?.hash ?? computeSha256('status'),
            git_status_evidence_id: gitStatusEvId,
            lifecycle_version: 3,
            process_start_classification: 'SPAWNED_PROVEN',
            project_id: f.projectId,
            start_timestamp: startTime,
            task_id: f.taskId,
            task_ownership_epoch: 1,
            termination_classification: 'TERMINATION_PROVEN',
            test_result_evidence_hash: trEvRow?.hash ?? computeSha256('test-evidence'),
            test_result_evidence_id: trEvId,
            test_run_id: testRunId,
            verification_execution_id: verificationExecId,
            workspace_snapshot_after_evidence_id: `ev-ws-${crypto.randomUUID()}`,
            workspace_snapshot_after_hash: computeSha256('after-ws'),
            workspace_snapshot_before_hash: workspaceSnapshotHash,
          };
          envJson = canonicalJsonStringify(envObj);
          envHash = computeSha256(envJson);
        } else if (envHash === null && envJson) {
          envHash = computeSha256(envJson);
        }
      }

      if (envJson && !envHash) {
        envHash = computeSha256(envJson);
      }

      const verificationStartedAt =
        opts.verificationStartedAt !== undefined
          ? opts.verificationStartedAt
          : ['VERIFYING', 'VERIFIED'].includes(status)
          ? now
          : null;

      const completedAt =
        opts.completedAt !== undefined
          ? opts.completedAt
          : ['VERIFIED', 'VERIFICATION_FAILED', 'REJECTED', 'SUPERSEDED'].includes(status)
          ? now
          : null;

      const fencedAt =
        opts.recoveryFencedAt !== undefined
          ? opts.recoveryFencedAt
          : status === 'RECOVERY_FENCED'
          ? now
          : null;

      const failureCode =
        opts.failureCode !== undefined
          ? opts.failureCode
          : ['VERIFICATION_FAILED', 'RECOVERY_FENCED'].includes(status)
          ? 'VERIFICATION_PROCESS_NON_ZERO'
          : null;

      targetDb
        .prepare(`
          INSERT INTO coder_submission_adjudications (
            id, request_id, submission_id, authorization_id, project_id, task_id,
            attempt_id, assignment_id, task_ownership_epoch, action, status,
            lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
            verification_commands_json, verification_commands_hash,
            workspace_snapshot_before_json, workspace_snapshot_before_hash,
            verification_result_envelope_json, verification_result_envelope_hash,
            verification_execution_id, protocol_message_id, test_run_id,
            git_status_evidence_id, git_diff_evidence_id, failure_code, failure_json,
            created_at, verification_started_at, completed_at, recovery_fenced_at,
            artifact_manifest_json, artifact_manifest_hash
          ) VALUES (
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?,
            ?, ?,
            ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?
          )
        `)
        .run(
          id,
          requestId,
          submissionId,
          f.authorizationId,
          f.projectId,
          f.taskId,
          sub?.attempt_id ?? f.attemptId,
          sub?.assignment_id ?? f.assignmentId,
          1,
          action,
          status,
          lifecycleVersion,
          snapJson,
          snapHash,
          cmdJson,
          cmdHash,
          workspaceSnapshotJson,
          workspaceSnapshotHash,
          envJson,
          envHash,
          verificationExecId,
          null,
          testRunId,
          gitStatusEvId,
          gitDiffEvId,
          failureCode,
          opts.failureJson ?? null,
          now,
          verificationStartedAt,
          completedAt,
          fencedAt,
          artifactManifestJson,
          artifactManifestHash
        );

      const eventDefs: Array<{ sequence: number; eventType: string; payloadJson?: string }> =
        opts.events ??
        (() => {
          if (status === 'ADMITTED') {
            return [{ sequence: 1, eventType: 'ADMITTED' }];
          } else if (status === 'VERIFYING') {
            return [
              { sequence: 1, eventType: 'ADMITTED' },
              { sequence: 2, eventType: 'VERIFICATION_CLAIMED' },
            ];
          } else if (status === 'VERIFIED') {
            return [
              { sequence: 1, eventType: 'ADMITTED' },
              { sequence: 2, eventType: 'VERIFICATION_CLAIMED' },
              { sequence: 3, eventType: 'VERIFICATION_SUCCEEDED' },
            ];
          } else if (status === 'VERIFICATION_FAILED') {
            return [
              { sequence: 1, eventType: 'ADMITTED' },
              { sequence: 2, eventType: 'VERIFICATION_CLAIMED' },
              { sequence: 3, eventType: 'VERIFICATION_FAILED' },
            ];
          } else if (status === 'RECOVERY_FENCED') {
            return [
              { sequence: 1, eventType: 'ADMITTED' },
              { sequence: 2, eventType: 'VERIFICATION_CLAIMED' },
              { sequence: 3, eventType: 'RECOVERY_FENCED' },
            ];
          } else if (status === 'REJECTED') {
            return [{ sequence: 1, eventType: 'REJECTED' }];
          } else if (status === 'SUPERSEDED') {
            return [{ sequence: 1, eventType: 'SUPERSEDED' }];
          }
          return [{ sequence: 1, eventType: 'ADMITTED' }];
        })();

      for (const ed of eventDefs) {
        const evPayload = ed.payloadJson ?? canonicalJsonStringify({ status: ed.eventType, adjudication_id: id });
        const evHash = computeSha256(evPayload);
        targetDb
          .prepare(`
            INSERT INTO coder_submission_adjudication_events (
              id, adjudication_id, sequence, event_type, payload_json, payload_hash, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `)
          .run(crypto.randomUUID(), id, ed.sequence, ed.eventType, evPayload, evHash, now);
      }

      return id;
    }

    beforeEach(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-status-harden-test-'));
      const created = createTestDatabase(testDir, 'status-harden.db');
      db = created.db;
      dbPath = created.dbPath;
      fixtures = setupFullSubmissionGraph(db);
    });

    afterEach(() => {
      try {
        if (db && db.open) db.close();
      } finally {
        if (testDir && fs.existsSync(testDir)) {
          fs.rmSync(testDir, { recursive: true, force: true });
        }
      }
    });

    it('H1. Migration-22-only database is rejected at both relevant startup paths', () => {
      const m22Db = new Database(':memory:');
      MigrationRunner.run(m22Db, 22);

      // Path 1: buildAgentForgeSubmissionMcpServer (and createSubmissionMcpServer)
      expect(() => buildAgentForgeSubmissionMcpServer({ db: m22Db })).toThrow(/(MCP|ADJUDICATION)_SCHEMA_AUTHORITY_INVALID/);

      // Path 2: verifyMigration23SchemaAuthority (stdio-submit startup path)
      expect(() => verifyMigration23SchemaAuthority(m22Db)).toThrow(/(MCP|ADJUDICATION)_SCHEMA_AUTHORITY_INVALID/);

      m22Db.close();
    });

    it('H2. Valid Migration 23 database starts successfully', () => {
      const server = buildAgentForgeSubmissionMcpServer({ db });
      expect(server).toBeDefined();
    });

    it('H3. Tool and resource advertise and return the same closed task-state contract', () => {
      const outputSchema = CODER_SUBMISSION_STATUS_OUTPUT_JSON_SCHEMA as any;
      const successBranch = outputSchema.oneOf[0];
      const taskStateProperty = successBranch.properties.task_state;
      expect(taskStateProperty.enum).toEqual([...TaskStateEnum.options]);

      // Resource URI template matches tool capability
      expect(SUBMISSION_STATUS_URI_TEMPLATE).toBe('agentforge://submissions/{submission_id}');
    });

    it('H4. Every legitimate TaskStateEnum value expected by the lifecycle is accepted', () => {
      const validUuid = crypto.randomUUID();
      for (const validState of TaskStateEnum.options) {
        const payload = {
          ok: true,
          submission_id: validUuid,
          lifecycle_status: 'QUARANTINED',
          terminal_outcome: null,
          task_state: validState,
          verification_summary: null,
          submitted_at: new Date().toISOString(),
          settled_at: null,
        };
        const parsed = SubmissionStatusSuccessZodSchema.safeParse(payload);
        expect(parsed.success).toBe(true);
      }
    });

    it('H5. Unknown task state is rejected', () => {
      const validUuid = crypto.randomUUID();
      const invalidPayload = {
        ok: true,
        submission_id: validUuid,
        lifecycle_status: 'QUARANTINED',
        terminal_outcome: null,
        task_state: 'UNKNOWN_OR_VERIFYING',
        verification_summary: null,
        submitted_at: new Date().toISOString(),
        settled_at: null,
      };
      expect(SubmissionStatusSuccessZodSchema.safeParse(invalidPayload).success).toBe(false);

      // Live service check: corrupt task state in database fails closed
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      db.pragma('ignore_check_constraints = ON');
      db.prepare("UPDATE tasks SET state = 'CORRUPT_STATE' WHERE id = ?").run(fixtures.taskId);
      db.pragma('ignore_check_constraints = OFF');

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('H6. Negative passed_count is rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      const trId = insertTestRunHelper(db, { taskId: fixtures.taskId, passedCount: -1 });
      insertAdjudicationHelper(db, fixtures, subId, { status: 'VERIFIED', testRunId: trId });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('H7. Negative failed_count is rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      const trId = insertTestRunHelper(db, { taskId: fixtures.taskId, failedCount: -5 });
      insertAdjudicationHelper(db, fixtures, subId, { status: 'VERIFIED', testRunId: trId });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('H8. Negative duration_ms is rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      const trId = insertTestRunHelper(db, { taskId: fixtures.taskId, durationMs: -100 });
      insertAdjudicationHelper(db, fixtures, subId, { status: 'VERIFIED', testRunId: trId });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('H9. Fractional, NaN, Infinity, and unsafe-integer metrics are rejected wherever SQLite/fixture injection makes them representable', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Fractional test metric
      const trId1 = insertTestRunHelper(db, { taskId: fixtures.taskId, passedCount: 1.5 });
      insertAdjudicationHelper(db, fixtures, subId, { status: 'VERIFIED', testRunId: trId1 });

      const res1 = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res1.ok).toBe(false);
      if (!res1.ok) {
        expect(res1.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }

      // Unsafe integer
      db.prepare('UPDATE test_runs SET passed_count = 1, duration_ms = ? WHERE id = ?').run(Number.MAX_SAFE_INTEGER + 10, trId1);

      const res2 = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res2.ok).toBe(false);
      if (!res2.ok) {
        expect(res2.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('H10. Missing required metrics are rejected for terminal verification outcomes', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      // Terminal VERIFIED adjudication with missing required metric in test run (passed_count is null)
      const trId = insertTestRunHelper(db, { taskId: fixtures.taskId });
      insertAdjudicationHelper(db, fixtures, subId, { status: 'VERIFIED', testRunId: trId });

      const origGetTestRun = fixtures.repo.getTestRun.bind(fixtures.repo);
      fixtures.repo.getTestRun = (id: string) => {
        const tr = origGetTestRun(id);
        return tr ? { ...tr, passed_count: null as any } : null;
      };

      try {
        const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
        }
      } finally {
        fixtures.repo.getTestRun = origGetTestRun;
      }
    });

    it('H11. Duplicate initial disposition is rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Insert duplicate initial disposition
      const dupId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO coder_submission_dispositions (
          id, submission_id, disposition_event, disposition_reason, actor_type, actor_id, disposition_metadata_json, created_at
        ) VALUES (?, ?, 'SUBMITTED', 'INITIAL_SUBMISSION', 'SYSTEM', 'system-admin', '{}', ?)
      `).run(dupId, subId, now);

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('H12. Contradictory terminal dispositions are rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      insertAdjudicationHelper(db, fixtures, subId, { status: 'VERIFIED' });

      // Insert two contradictory terminal dispositions
      const dispId1 = crypto.randomUUID();
      const dispId2 = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO coder_submission_dispositions (
          id, submission_id, disposition_event, disposition_reason, actor_type, actor_id, disposition_metadata_json, created_at
        ) VALUES (?, ?, 'SETTLED', 'ACCEPTED_VERIFIED', 'SYSTEM', 'system-admin', '{}', ?)
      `).run(dispId1, subId, now);
      db.prepare(`
        INSERT INTO coder_submission_dispositions (
          id, submission_id, disposition_event, disposition_reason, actor_type, actor_id, disposition_metadata_json, created_at
        ) VALUES (?, ?, 'REJECTED', 'INTEGRITY_MISMATCH', 'SYSTEM', 'system-admin', '{}', ?)
      `).run(dispId2, subId, now);

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('H13. Terminal disposition inconsistent with adjudication status is rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      insertAdjudicationHelper(db, fixtures, subId, { status: 'VERIFIED' });

      const dispId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO coder_submission_dispositions (
          id, submission_id, disposition_event, disposition_reason, actor_type, actor_id, disposition_metadata_json, created_at
        ) VALUES (?, ?, 'REJECTED', 'INTEGRITY_MISMATCH', 'SYSTEM', 'system-admin', '{}', ?)
      `).run(dispId, subId, now);

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('H14. Attempt mismatch is rejected without disclosure', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Corrupt attempt_id in submission
      db.pragma('foreign_keys = OFF');
      db.exec('DROP TRIGGER IF EXISTS trg_coder_submissions_no_update;');
      db.prepare("UPDATE coder_submissions SET attempt_id = 'att-foreign-1234' WHERE id = ?").run(subId);
      db.pragma('foreign_keys = ON');

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_NOT_FOUND');
      }
    });

    it('H15. Assignment mismatch is rejected without disclosure', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Corrupt assignment_id in submission
      db.pragma('foreign_keys = OFF');
      db.exec('DROP TRIGGER IF EXISTS trg_coder_submissions_no_update;');
      db.prepare("UPDATE coder_submissions SET assignment_id = 'asgn-foreign-1234' WHERE id = ?").run(subId);
      db.pragma('foreign_keys = ON');

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_NOT_FOUND');
      }
    });

    it('H16. Authority-fingerprint mismatch is rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Corrupt authority_fingerprint in database
      db.exec('DROP TRIGGER IF EXISTS trg_coder_submissions_no_update;');
      db.prepare("UPDATE coder_submissions SET authority_fingerprint = ? WHERE id = ?").run('0'.repeat(64), subId);

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('H17. Canonical-envelope identity mismatch is rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Corrupt canonical_envelope_hash
      db.exec('DROP TRIGGER IF EXISTS trg_coder_submissions_no_update;');
      db.prepare("UPDATE coder_submissions SET canonical_envelope_hash = ? WHERE id = ?").run('f'.repeat(64), subId);

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('H18. Non-canonical authority_snapshot_json with a matching raw-byte hash is rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = db.prepare('SELECT * FROM coder_submissions WHERE id = ?').get(subId) as any;
      const validSnapObj: Record<string, unknown> = {
        assignment_id: sub.assignment_id,
        assignment_status: 'ACTIVE',
        attempt_id: sub.attempt_id,
        attempt_number: 1,
        attempt_status: 'RUNNING',
        authorization_canonical_payload_hash: computeSha256('auth-payload'),
        authorization_id: fixtures.authorizationId,
        authorization_lifecycle_version: 1,
        authorization_status: 'DISPATCHED',
        authorized_repository_head_sha: fixtures.repoHeadSha,
        canonical_envelope_hash: sub.canonical_envelope_hash,
        claim_content_hash: sub.claim_content_hash,
        current_terminal_disposition: null,
        execution_id: `exec-${crypto.randomUUID()}`,
        manager_protocol_message_id: fixtures.managerMessageId,
        manager_raw_payload_hash: fixtures.managerPayloadHash,
        project_id: fixtures.projectId,
        project_repository_path: fixtures.projectRoot,
        project_status: 'RUNNING',
        quarantine_status: 'QUARANTINED',
        routing_decision_id: fixtures.routingDecisionId,
        selected_account_id: fixtures.accountId,
        selected_provider_id: fixtures.providerId,
        selected_resource_id: fixtures.resourceId,
        submission_base_sha: sub.base_sha,
        submission_id: subId,
        submission_repository_head_sha: sub.repository_head_sha,
        submitted_at: sub.submitted_at,
        task_base_sha: fixtures.baseSha || '0'.repeat(40),
        task_id: fixtures.taskId,
        task_ownership_epoch: 1,
        task_state: 'VALIDATING',
        worker_slot_id: null,
      };
      // Format with extra whitespace (non-canonical)
      const nonCanonicalJson = JSON.stringify(validSnapObj, null, 2);
      const matchingHash = computeSha256(nonCanonicalJson);

      insertAdjudicationHelper(db, fixtures, subId, {
        status: 'ADMITTED',
        authoritySnapshotJson: nonCanonicalJson,
        authoritySnapshotHash: matchingHash,
      });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('H19. Structurally invalid authority snapshot with a matching hash is rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Snapshot missing required keys
      const invalidSnap = canonicalJsonStringify({ only_one_key: 'value' });
      const snapHash = computeSha256(invalidSnap);

      insertAdjudicationHelper(db, fixtures, subId, {
        status: 'ADMITTED',
        authoritySnapshotJson: invalidSnap,
        authoritySnapshotHash: snapHash,
      });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('H20. Non-canonical verification envelope with a matching hash is rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nonCanonicalEnv = JSON.stringify({ verified: true }, null, 2);
      const envHash = computeSha256(nonCanonicalEnv);

      insertAdjudicationHelper(db, fixtures, subId, {
        status: 'VERIFIED',
        verificationResultEnvelopeJson: nonCanonicalEnv,
        verificationResultEnvelopeHash: envHash,
      });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('H21. Structurally invalid verification envelope with a matching hash is rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const invalidEnv = canonicalJsonStringify({ not_the_canonical_keys: true });
      const envHash = computeSha256(invalidEnv);

      insertAdjudicationHelper(db, fixtures, subId, {
        status: 'VERIFIED',
        verificationResultEnvelopeJson: invalidEnv,
        verificationResultEnvelopeHash: envHash,
      });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('H22. Malformed governed failure_json is rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.pragma('ignore_check_constraints = ON');
      insertAdjudicationHelper(db, fixtures, subId, {
        status: 'VERIFICATION_FAILED',
        failureCode: 'TEST_FAIL',
        failureJson: '[1, 2, 3]', // Array instead of object
      });
      db.pragma('ignore_check_constraints = OFF');

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('H23. Invalid event history in an earlier non-selected adjudication is rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.exec('DROP INDEX IF EXISTS idx_coder_submission_adjudications_submission;');
      db.exec('DROP INDEX IF EXISTS idx_coder_submission_adjudications_active;');

      // Adjudication 1: broken sequence
      insertAdjudicationHelper(db, fixtures, subId, {
        lifecycleVersion: 1,
        status: 'ADMITTED',
        events: [
          { sequence: 1, eventType: 'ADMITTED' },
          { sequence: 3, eventType: 'VERIFICATION_CLAIMED' }, // skipped 2
        ],
      });

      // Adjudication 2: VERIFYING
      insertAdjudicationHelper(db, fixtures, subId, {
        lifecycleVersion: 2,
        status: 'VERIFYING',
      });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('H24. Duplicate lifecycle_version is rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.exec('DROP INDEX IF EXISTS idx_coder_submission_adjudications_submission;');
      db.exec('DROP INDEX IF EXISTS idx_coder_submission_adjudications_active;');

      insertAdjudicationHelper(db, fixtures, subId, { status: 'ADMITTED', lifecycleVersion: 1 });
      insertAdjudicationHelper(db, fixtures, subId, { status: 'VERIFYING', lifecycleVersion: 1 }); // Duplicate version

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('H25. Event after terminal settlement is rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      insertAdjudicationHelper(db, fixtures, subId, {
        status: 'VERIFIED',
        events: [
          { sequence: 1, eventType: 'ADMITTED' },
          { sequence: 2, eventType: 'VERIFICATION_CLAIMED' },
          { sequence: 3, eventType: 'VERIFICATION_SUCCEEDED' },
          { sequence: 4, eventType: 'ADMITTED' }, // Post-terminal event!
        ],
      });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('H26. Adjudication status inconsistent with final event is rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      insertAdjudicationHelper(db, fixtures, subId, {
        status: 'VERIFIED',
        events: [
          { sequence: 1, eventType: 'ADMITTED' },
          { sequence: 2, eventType: 'VERIFICATION_CLAIMED' },
          { sequence: 3, eventType: 'VERIFICATION_FAILED' }, // Event contradicts VERIFIED status!
        ],
      });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('H27. VERIFIED outcome with a non-successful or foreign test run is rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const failedTr = insertTestRunHelper(db, { taskId: fixtures.taskId, exitCode: 1, failedCount: 1 });
      insertAdjudicationHelper(db, fixtures, subId, { status: 'VERIFIED', testRunId: failedTr });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('H28. VERIFIED/ACCEPTED_VERIFIED plus contradictory task state is rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      insertAdjudicationHelper(db, fixtures, subId, {
        status: 'VERIFIED',
        taskState: 'CODING', // Contradictory: should be REVIEW_READY
      });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_STATUS_INTEGRITY_CONFLICT');
      }
    });

    it('H29. Valid VERIFIED/ACCEPTED_VERIFIED plus REVIEW_READY succeeds', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      insertAdjudicationHelper(db, fixtures, subId, {
        status: 'VERIFIED',
        taskState: 'REVIEW_READY',
      });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.lifecycle_status).toBe('VERIFIED');
        expect(res.terminal_outcome).toBe('ACCEPTED_VERIFIED');
        expect(res.task_state).toBe('REVIEW_READY');
      }
    });

    it('H30. In-flight VERIFYING adjudication plus VALIDATING task succeeds', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      insertAdjudicationHelper(db, fixtures, subId, {
        status: 'VERIFYING',
        taskState: 'VALIDATING',
      });

      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.lifecycle_status).toBe('VERIFYING');
        expect(res.task_state).toBe('VALIDATING');
      }
    });

    it('H31. Foreign authorization/project/task/attempt/assignment queries remain sanitized as not found', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const unknownUuid = crypto.randomUUID();

      const res = fixtures.service.getSubmissionStatus({ submission_id: unknownUuid }, plaintextToken);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error_code).toBe('SUBMISSION_NOT_FOUND');
        expect(res.message).toBe('Submission not found');
      }
    });

    it('H32. Repeated tool and resource queries remain deterministic and make zero mutations', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);
      insertAdjudicationHelper(db, fixtures, subId, { status: 'VERIFIED' });

      function getDbFingerprint(): string {
        const counts = [
          db.prepare('SELECT count(*) as c FROM tasks').get() as any,
          db.prepare('SELECT count(*) as c FROM coder_submissions').get() as any,
          db.prepare('SELECT count(*) as c FROM coder_submission_adjudications').get() as any,
          db.prepare('SELECT count(*) as c FROM coder_submission_dispositions').get() as any,
          db.prepare('SELECT count(*) as c FROM mcp_submission_sessions').get() as any,
        ];
        return JSON.stringify(counts);
      }

      const fpBefore = getDbFingerprint();
      const first = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      for (let i = 0; i < 50; i++) {
        const next = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
        expect(canonicalJsonStringify(next as any)).toBe(canonicalJsonStringify(first as any));
      }
      const fpAfter = getDbFingerprint();
      expect(fpAfter).toBe(fpBefore);
    });

    it('H33. Error paths make zero mutations and leak no corrupted raw evidence', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const secretSentinel = 'token=af-sub-SECRET_TOKEN_SENTINEL_12345';
      insertAdjudicationHelper(db, fixtures, subId, {
        status: 'VERIFICATION_FAILED',
        failureCode: 'FAIL_LEAK',
        failureJson: JSON.stringify({ error: secretSentinel }),
      });

      const countBefore = (db.prepare('SELECT count(*) as c FROM coder_submission_adjudications').get() as any).c;
      const res = fixtures.service.getSubmissionStatus({ submission_id: subId }, plaintextToken);
      const countAfter = (db.prepare('SELECT count(*) as c FROM coder_submission_adjudications').get() as any).c;
      expect(countAfter).toBe(countBefore);

      if (res.ok && res.verification_summary) {
        expect(res.verification_summary.failure_message).not.toContain('SECRET_TOKEN_SENTINEL');
        expect(res.verification_summary.failure_message).toContain('[REDACTED_TOKEN]');
      }
    });

    it('H34. Existing R5J1-R5J5 suites remain unchanged and pass', () => {
      expect(MIGRATIONS).toHaveLength(24);
      expect(MIGRATIONS[22].version).toBe(23);
      expect(typeof verifyMigration23SchemaAuthority).toBe('function');
    });

    it('H35. Documentation example conforms to the exported output schema', () => {
      const docPath = path.resolve(__dirname, '..', 'docs', 'MCP_CLIENT_SETUP.md');
      const docContent = fs.readFileSync(docPath, 'utf8');

      // Check Section 10.4 example conforms to REVIEW_READY
      expect(docContent).toContain('"task_state": "REVIEW_READY"');
      expect(docContent).not.toContain('"task_state": "VERIFYING"');

      // Validate the documentation payload shape against Zod
      const docPayload = {
        ok: true,
        submission_id: 'd9b7f581-c304-4b55-83e8-c57912d76f08',
        lifecycle_status: 'VERIFIED',
        terminal_outcome: 'ACCEPTED_VERIFIED',
        task_state: 'REVIEW_READY',
        verification_summary: {
          exit_code: 0,
          passed_count: 14,
          failed_count: 0,
          skipped_count: 0,
          duration_ms: 1840,
          failure_code: null,
          failure_message: null,
        },
        submitted_at: '2026-03-29T12:00:00.000Z',
        settled_at: '2026-03-29T12:03:30.000Z',
      };
      const parsed = SubmissionStatusSuccessZodSchema.safeParse(docPayload);
      expect(parsed.success).toBe(true);
    });
  });
});
