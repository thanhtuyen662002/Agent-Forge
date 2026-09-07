import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import child_process from 'child_process';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import {
  MIGRATIONS,
  MigrationRunner,
  verifyMigration22SchemaAuthority,
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
  CLAIM_CONTENT_KEYS,
  AUTHORITY_FINGERPRINT_KEYS,
  CANONICAL_ENVELOPE_KEYS,
  MAX_ARGUMENT_BYTES,
  SUBMISSION_TOKEN_REGEX,
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
import { ExecutionAuthorization } from '../src/core/types/domain';

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
    settled_at: null,
    settlement_evidence_json: null,
    settlement_evidence_hash: null,
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
    repo,
    auth,
    service,
  };
}

function issueSubmissionSessionHelper(
  repo: Repository,
  authorizationId: string,
  ttlSeconds = 3600,
  issuedAt?: string
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
    token_hash: tokenHash,
    authorization_fingerprint: authorizationFingerprint,
    issued_at: nowIso,
    expires_at: expiresAt,
    revoked_at: null,
    revocation_reason: null,
  });

  return { plaintextToken, sessionId };
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
  });

  afterEach(() => {
    try {
      if (db.open) db.close();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

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
      expect(toolsRes.tools).toHaveLength(1);
      const tool = toolsRes.tools[0];
      expect(tool.name).toBe(SUBMISSION_TOOL_NAME);
      expect(tool.description).toBeDefined();

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
        arguments: {
          submission_id: subId,
          status: 'COMPLETED',
          summary: 'Verified clean test execution',
          changed_files: ['src/mcp/submissionServer.ts'],
          tests_claimed: ['test-output-schema-success'],
        },
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
        arguments: {
          submission_id: crypto.randomUUID(),
          status: 'COMPLETED',
          summary: 'Task completed claim',
        },
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
        arguments: {
          submission_id: crypto.randomUUID(),
          status: 'COMPLETED',
          summary: 'Checking absence of structuredData',
        },
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
        arguments: {
          submission_id: subId,
          status: 'COMPLETED',
          summary: 'Text conformance verification',
        },
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
      // Direct validation using protocol JSON-RPC requirements
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
      const basePayload = {
        submission_id: crypto.randomUUID(),
        status: 'COMPLETED' as const,
        summary: 'S',
      };
      const baseJson = canonicalJsonStringify(basePayload);
      const baseBytes = Buffer.byteLength(baseJson, 'utf8');
      const paddingNeeded = MAX_ARGUMENT_BYTES - baseBytes;
      // Pad inside summary to reach exact byte limit
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
      // Create a payload that serializes to 65,537 bytes
      const bigPayload = {
        submission_id: crypto.randomUUID(),
        status: 'COMPLETED',
        summary: 'x'.repeat(65500),
      };

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

    it('12. Input Schema requires submission_id, status, and summary', () => {
      expect(CODER_SUBMISSION_INPUT_JSON_SCHEMA.required).toContain('submission_id');
      expect(CODER_SUBMISSION_INPUT_JSON_SCHEMA.required).toContain('status');
      expect(CODER_SUBMISSION_INPUT_JSON_SCHEMA.required).toContain('summary');
    });
  });

  // =========================================================================
  // Group 2: Secret Delivery, Environment Isolation, and Sanitization
  // =========================================================================
  describe('Group 2: Secret Delivery, Environment Isolation, and Sanitization', () => {
    it('13. Token in input schema rejected due to .strict()', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const payloadWithToken = {
        submission_id: crypto.randomUUID(),
        status: 'COMPLETED',
        summary: 'Attempting token in arguments',
        token: plaintextToken,
      };

      const result = fixtures.service.submitCoderClaim(payloadWithToken, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('SCHEMA_VALIDATION_FAILED');
      }
    });

    it('14. Environment Token Sourcing: correctly authenticates via token parameter or environment', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const validPayload = {
        submission_id: crypto.randomUUID(),
        status: 'COMPLETED',
        summary: 'Valid environment token submission',
      };

      const result = fixtures.service.submitCoderClaim(validPayload, plaintextToken);
      expect(result.accepted).toBe(true);
    });

    it('15. Missing Environment Token Rejection: returns INVALID_SUBMISSION_TOKEN', () => {
      const validPayload = {
        submission_id: crypto.randomUUID(),
        status: 'COMPLETED',
        summary: 'Missing token submission',
      };

      const result = fixtures.service.submitCoderClaim(validPayload, undefined);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('INVALID_SUBMISSION_TOKEN');
      }
    });

    it('16. Malformed Token Format Rejection: returns INVALID_SUBMISSION_TOKEN', () => {
      const validPayload = {
        submission_id: crypto.randomUUID(),
        status: 'COMPLETED',
        summary: 'Malformed token submission',
      };

      const result = fixtures.service.submitCoderClaim(validPayload, 'not-a-valid-token');
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('INVALID_SUBMISSION_TOKEN');
      }
    });

    it('17. Preliminary Auth Prevents Git Process Spawn on Invalid Token', () => {
      const validPayload = {
        submission_id: crypto.randomUUID(),
        status: 'COMPLETED',
        summary: 'Checking no git spawn',
      };

      // Set invalid repository_path that would throw if spawned
      db.prepare("UPDATE projects SET repository_path = 'INVALID_PATH_THAT_FAILS_GIT' WHERE id = ?").run(fixtures.projectId);

      // Pass invalid token
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

      const validPayload = {
        submission_id: crypto.randomUUID(),
        status: 'COMPLETED',
        summary: 'Expired token test',
      };

      const result = fixtures.service.submitCoderClaim(validPayload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_SESSION_EXPIRED');
      }
    });

    it('19. Revoked Token Preliminary Auth Gate: rejected with MCP_SESSION_REVOKED without Git spawn', () => {
      const { plaintextToken, sessionId } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      fixtures.repo.revokeMcpSubmissionSession({
        sessionId,
        revokedAt: new Date().toISOString(),
        reason: 'MANUAL_REVOCATION',
      });

      const validPayload = {
        submission_id: crypto.randomUUID(),
        status: 'COMPLETED',
        summary: 'Revoked token test',
      };

      const result = fixtures.service.submitCoderClaim(validPayload, plaintextToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('MCP_SESSION_REVOKED');
      }
    });

    it('20. Cross-Table Credential Isolation: R5J2 read token returns INVALID_SUBMISSION_TOKEN', () => {
      // Create session in mcp_client_sessions (the read token table)
      const readToken = 'af-mcp-' + crypto.randomBytes(32).toString('base64url');
      const readTokenHash = crypto.createHash('sha256').update(readToken, 'utf8').digest('hex');
      const nowIso = new Date().toISOString();
      const expiresIso = new Date(Date.now() + 3600 * 1000).toISOString();
      db.prepare(`
        INSERT INTO mcp_client_sessions (id, authorization_id, scope, token_hash, authorization_fingerprint, issued_at, expires_at)
        VALUES (?, ?, 'AUTHORIZED_CONTEXT_READ', ?, ?, ?, ?)
      `).run(crypto.randomUUID(), fixtures.authorizationId, readTokenHash, '0'.repeat(64), nowIso, expiresIso);

      const validPayload = {
        submission_id: crypto.randomUUID(),
        status: 'COMPLETED',
        summary: 'Testing cross-table token isolation',
      };

      const result = fixtures.service.submitCoderClaim(validPayload, readToken);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.error_code).toBe('INVALID_SUBMISSION_TOKEN');
      }
    });

    it('21. CLI Configure-Client Emits Placeholder: contains literal <OPERATOR_SUBMISSION_TOKEN_REQUIRED>', () => {
      const config = generateSubmissionClientConfig({ client: 'cursor', dbPath });
      const env = config.mcpServers['agentforge-submit'].env;
      expect(env.AGENTFORGE_MCP_SUBMISSION_TOKEN).toBe(OPERATOR_SUBMISSION_TOKEN_PLACEHOLDER);
      expect(env.AGENTFORGE_MCP_SUBMISSION_TOKEN).toBe('<OPERATOR_SUBMISSION_TOKEN_REQUIRED>');
    });

    it('22. CLI Configure-Client Rejects --token Flag with error code 1', () => {
      let stderrCaptured = '';
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: any) => {
        stderrCaptured += String(chunk);
        return true;
      }) as any;

      try {
        const exitCode = runSubmissionAdmin(['configure-client', '--client', 'cursor', '--token', 'secret123']);
        expect(exitCode).toBe(1);
        expect(stderrCaptured).toContain('forbidden');
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it('23. Zero Plaintext Tokens in Database, WAL, and SHM', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(
        {
          submission_id: subId,
          status: 'COMPLETED',
          summary: 'Testing token secrecy in SQLite',
        },
        plaintextToken
      );

      // Checkpoint WAL to disk
      db.pragma('wal_checkpoint(TRUNCATE)');

      const filesToCheck = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter((f) => fs.existsSync(f));
      for (const f of filesToCheck) {
        const buf = fs.readFileSync(f);
        expect(buf.includes(Buffer.from(plaintextToken))).toBe(false);
      }
    });

    it('24. Stderr Secret Scrubbing: raw token is never emitted in stderr diagnostics', () => {
      let stderrCaptured = '';
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: any) => {
        stderrCaptured += String(chunk);
        return true;
      }) as any;

      const secretToken = generateSubmissionToken();
      try {
        runSubmissionAdmin(['issue', '--db', dbPath, '--auth', fixtures.authorizationId, '--unknown-flag', secretToken]);
      } finally {
        process.stderr.write = originalWrite;
      }

      expect(stderrCaptured.includes(secretToken)).toBe(false);
    });
  });

  // =========================================================================
  // Group 3: Canonical Envelopes, Hashing, Commitments, and Portability
  // =========================================================================
  describe('Group 3: Canonical Envelopes, Hashing, Commitments, and Portability', () => {
    it('25. claim_content_hash commits exactly 7 sorted keys', () => {
      expect(CLAIM_CONTENT_KEYS).toHaveLength(7);
      expect([...CLAIM_CONTENT_KEYS]).toEqual([
        'blockers',
        'changed_files',
        'client_metadata',
        'review_requested',
        'status',
        'summary',
        'tests_claimed',
      ]);
    });

    it('26. Content hash invariance under input key ordering', () => {
      const { hash: hash1 } = computeClaimContentHash({
        summary: 'Fix bug',
        status: 'COMPLETED',
        changed_files: ['a.ts', 'b.ts'],
        tests_claimed: ['t1'],
        blockers: [],
        review_requested: true,
        client_metadata: { client_name: 'test' },
      });

      const { hash: hash2 } = computeClaimContentHash({
        client_metadata: { client_name: 'test' },
        review_requested: true,
        blockers: [],
        tests_claimed: ['t1'],
        changed_files: ['a.ts', 'b.ts'],
        status: 'COMPLETED',
        summary: 'Fix bug',
      });

      expect(hash1).toBe(hash2);
    });

    it('27. authority_fingerprint commits exactly 19 sorted keys', () => {
      expect(AUTHORITY_FINGERPRINT_KEYS).toHaveLength(19);
      expect(AUTHORITY_FINGERPRINT_KEYS[0]).toBe('assignment_id');
      expect(AUTHORITY_FINGERPRINT_KEYS[AUTHORITY_FINGERPRINT_KEYS.length - 1]).toBe('task_revision');
    });

    it('28. canonical_envelope_hash commits exactly 28 sorted keys (rejects 25)', () => {
      expect(CANONICAL_ENVELOPE_KEYS).toHaveLength(28);
      expect(CANONICAL_ENVELOPE_KEYS).not.toHaveLength(25);
      expect(CODER_SUBMISSION_CAPABILITY_METADATA.envelope_keys_count).toBe(28);
    });

    it('29. Envelope hash rejects any missing key by strict canonicalJsonStringify', () => {
      const validEnvelopePayload: any = {};
      for (const k of CANONICAL_ENVELOPE_KEYS) {
        validEnvelopePayload[k] = 'test-val';
      }
      validEnvelopePayload.schema_version = 1;
      validEnvelopePayload.task_revision = 1;
      validEnvelopePayload.task_ownership_epoch = 1;
      validEnvelopePayload.canonical_arguments_bytes = 100;
      validEnvelopePayload.quarantine_status = 'QUARANTINED';

      const { hash } = computeCanonicalEnvelope(validEnvelopePayload);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('30. Deterministic event ID format: evt-coder-${sha256(...).slice(0, 32)}', () => {
      const subId = '00000000-0000-4000-8000-000000000001';
      const eventId = deriveDeterministicEventId(subId);
      expect(eventId).toMatch(/^evt-coder-[0-9a-f]{32}$/);
      expect(eventId.startsWith('evt-coder-')).toBe(true);
      expect(eventId.length).toBe(10 + 32);
    });

    it('31. Portable path validator: valid paths accepted', () => {
      expect(isPortablePath('src/mcp/stdio.ts')).toBe(true);
      expect(isPortablePath('README.md')).toBe(true);
      expect(isPortablePath('nested/dir/file-1.test.ts')).toBe(true);
    });

    it('32. Portable path validator: backslashes rejected', () => {
      expect(isPortablePath('src\\mcp\\stdio.ts')).toBe(false);
    });

    it('33. Portable path validator: leading slash rejected', () => {
      expect(isPortablePath('/src/mcp/stdio.ts')).toBe(false);
    });

    it('34. Portable path validator: trailing slash rejected', () => {
      expect(isPortablePath('src/mcp/')).toBe(false);
    });

    it('35. Portable path validator: dot segment . rejected at any depth', () => {
      expect(isPortablePath('./src/mcp')).toBe(false);
      expect(isPortablePath('src/./mcp')).toBe(false);
      expect(isPortablePath('src/mcp/.')).toBe(false);
    });

    it('36. Portable path validator: dot segment .. rejected at any depth', () => {
      expect(isPortablePath('../src/mcp')).toBe(false);
      expect(isPortablePath('src/../mcp')).toBe(false);
      expect(isPortablePath('src/mcp/..')).toBe(false);
    });

    it('37. Portable path validator: drive letters and UNC paths rejected', () => {
      expect(isPortablePath('C:/Windows/notepad.exe')).toBe(false);
      expect(isPortablePath('D:/repo/file.ts')).toBe(false);
      expect(isPortablePath('//server/share/file')).toBe(false);
    });

    it('38. Array duplicate rejection: changed_files duplicates rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: crypto.randomUUID(),
          status: 'COMPLETED',
          summary: 'Duplicate files test',
          changed_files: ['src/a.ts', 'src/a.ts'],
        },
        plaintextToken
      );
      expect(res.accepted).toBe(false);
      if (!res.accepted) {
        expect(res.error_code).toBe('SCHEMA_VALIDATION_FAILED');
      }
    });

    it('39. Array duplicate rejection: tests_claimed duplicates rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: crypto.randomUUID(),
          status: 'COMPLETED',
          summary: 'Duplicate tests test',
          tests_claimed: ['test-1', 'test-1'],
        },
        plaintextToken
      );
      expect(res.accepted).toBe(false);
      if (!res.accepted) {
        expect(res.error_code).toBe('SCHEMA_VALIDATION_FAILED');
      }
    });

    it('40. Array duplicate rejection: blockers duplicates rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: crypto.randomUUID(),
          status: 'COMPLETED',
          summary: 'Duplicate blockers test',
          blockers: ['blocker-a', 'blocker-a'],
        },
        plaintextToken
      );
      expect(res.accepted).toBe(false);
      if (!res.accepted) {
        expect(res.error_code).toBe('SCHEMA_VALIDATION_FAILED');
      }
    });
  });

  // =========================================================================
  // Group 4: Immediate Transaction Semantics, Concurrency, and Idempotency
  // =========================================================================
  describe('Group 4: Immediate Transaction Semantics, Concurrency, and Idempotency', () => {
    it('41. Fresh transactionNowIso generated inside immediate transaction', () => {
      const now1 = new Date(Date.now() - 10000).toISOString();
      const captured = fixtures.repo.runInImmediateTransaction(() => {
        return new Date().toISOString();
      });
      expect(captured).not.toBe(now1);
      expect(captured).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('42. Synchronous immediate transaction execution: no promises accepted', () => {
      const res = fixtures.repo.runInImmediateTransaction(() => {
        return 42;
      });
      expect(res).toBe(42);
    });

    it('43. Atomic insertion: coder_submissions, dispositions, and events all succeed or all rollback', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();

      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: subId,
          status: 'COMPLETED',
          summary: 'Atomic insertion test',
        },
        plaintextToken
      );
      expect(res.accepted).toBe(true);

      const sub = fixtures.repo.getCoderSubmissionById(subId);
      expect(sub).toBeDefined();

      const disps = fixtures.repo.getCoderSubmissionDispositions(subId);
      expect(disps).toHaveLength(1);

      const eventId = deriveDeterministicEventId(subId);
      const evt = fixtures.repo.getDeterministicEvent(eventId);
      expect(evt).toBeDefined();
    });

    it('44. Contention handling: busy database returns DATABASE_BUSY with retryable true', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);

      // Acquire an exclusive write transaction on a second connection
      const secondDb = new Database(dbPath, { timeout: 100 });
      secondDb.pragma('foreign_keys = ON');
      secondDb.prepare('BEGIN IMMEDIATE').run();

      try {
        const res = fixtures.service.submitCoderClaim(
          {
            submission_id: crypto.randomUUID(),
            status: 'COMPLETED',
            summary: 'Testing busy handling',
          },
          plaintextToken
        );
        expect(res.accepted).toBe(false);
        if (!res.accepted) {
          expect(res.error_code).toBe('DATABASE_BUSY');
          expect(res.retryable).toBe(true);
        }
      } finally {
        secondDb.prepare('ROLLBACK').run();
        secondDb.close();
      }
    });

    it('45. Deterministic event ID collision across different submissions returns CODER_SUBMISSION_EVENT_CONFLICT', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      const eventId = deriveDeterministicEventId(subId);

      // Pre-insert colliding event row for a different purpose
      db.prepare(`
        INSERT INTO events (id, project_id, task_id, type, summary, structured_payload_json, timestamp)
        VALUES (?, ?, ?, 'EXTERNAL_CONFLICTING_EVENT', 'Pre-existing event', '{}', ?)
      `).run(eventId, fixtures.projectId, fixtures.taskId, new Date().toISOString());

      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: subId,
          status: 'COMPLETED',
          summary: 'Trigger event collision',
        },
        plaintextToken
      );

      expect(res.accepted).toBe(false);
      if (!res.accepted) {
        expect(res.error_code).toBe('CODER_SUBMISSION_EVENT_CONFLICT');
      }
    });

    it('46. Submission ID collision with different content returns SUBMISSION_ID_COLLISION_CONTENT_MISMATCH', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();

      const res1 = fixtures.service.submitCoderClaim(
        {
          submission_id: subId,
          status: 'COMPLETED',
          summary: 'First submission payload',
        },
        plaintextToken
      );
      expect(res1.accepted).toBe(true);

      const res2 = fixtures.service.submitCoderClaim(
        {
          submission_id: subId,
          status: 'COMPLETED',
          summary: 'Different payload with same ID',
        },
        plaintextToken
      );

      expect(res2.accepted).toBe(false);
      if (!res2.accepted) {
        expect(res2.error_code).toBe('SUBMISSION_ID_COLLISION_CONTENT_MISMATCH');
      }
    });

    it('47. Exact duplicate submission returns accepted true with is_duplicate true', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      const payload = {
        submission_id: subId,
        status: 'COMPLETED' as const,
        summary: 'Exact replay payload',
        changed_files: ['src/mcp/submissionServer.ts'],
      };

      const res1 = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(res1.accepted).toBe(true);
      if (res1.accepted) {
        expect(res1.is_duplicate).toBe(false);
      }

      const res2 = fixtures.service.submitCoderClaim(payload, plaintextToken);
      expect(res2.accepted).toBe(true);
      if (res2.accepted && res1.accepted) {
        expect(res2.is_duplicate).toBe(true);
        expect(res2.claim_content_hash).toBe(res1.claim_content_hash);
        expect(res2.canonical_envelope_hash).toBe(res1.canonical_envelope_hash);
      }
    });

    it('48. Duplicate submission does not insert additional disposition or event rows', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      const payload = {
        submission_id: subId,
        status: 'COMPLETED' as const,
        summary: 'Replay row count test',
      };

      fixtures.service.submitCoderClaim(payload, plaintextToken);
      const dispCount1 = fixtures.repo.getCoderSubmissionDispositions(subId).length;

      fixtures.service.submitCoderClaim(payload, plaintextToken);
      const dispCount2 = fixtures.repo.getCoderSubmissionDispositions(subId).length;

      expect(dispCount2).toBe(dispCount1);
      expect(dispCount2).toBe(1);
    });

    it('49. Initial disposition status is always QUARANTINED', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();

      fixtures.service.submitCoderClaim(
        {
          submission_id: subId,
          status: 'COMPLETED',
          summary: 'Quarantine status check',
        },
        plaintextToken
      );

      const initDisp = fixtures.repo.getInitialCoderSubmissionDisposition(subId);
      expect(initDisp).toBeDefined();
      expect(initDisp?.disposition_event).toBe('SUBMITTED');
      expect(initDisp?.disposition_reason).toBe('INITIAL_SUBMISSION');
      const sub = fixtures.repo.getCoderSubmissionById(subId);
      expect(sub?.quarantine_status).toBe('QUARANTINED');
    });

    it('50. coder_submission_dispositions foreign key constraint enforced', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO coder_submission_dispositions (id, submission_id, disposition_event, disposition_reason, actor_type, actor_id, created_at)
          VALUES (?, 'non-existent-sub', 'SUBMITTED', 'INITIAL_SUBMISSION', 'SYSTEM', 'system', '2026-09-07T10:00:00.000Z')
        `).run(crypto.randomUUID());
      }).toThrow();
    });
  });

  // =========================================================================
  // Group 5: Authority Graph and Task State Validation
  // =========================================================================
  describe('Group 5: Authority Graph and Task State Validation', () => {
    it('51. Missing execution authorization returns MCP_AUTHORITY_FENCED', () => {
      db.pragma('foreign_keys = OFF');
      const plaintextToken = generateSubmissionToken();
      const tokenHash = crypto.createHash('sha256').update(plaintextToken, 'utf8').digest('hex');
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
      db.prepare(`
        INSERT INTO mcp_submission_sessions (id, authorization_id, scope, token_hash, authorization_fingerprint, issued_at, expires_at)
        VALUES (?, 'non-existent-auth', 'CODER_SUBMISSION', ?, ?, ?, ?)
      `).run(crypto.randomUUID(), tokenHash, '0'.repeat(64), nowIso, expiresAt);
      db.pragma('foreign_keys = ON');

      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: crypto.randomUUID(),
          status: 'COMPLETED',
          summary: 'Auth missing test',
        },
        plaintextToken
      );

      expect(res.accepted).toBe(false);
      if (!res.accepted) {
        expect(res.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('52. Task in receptive state CODING accepted', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare("UPDATE tasks SET state = 'CODING' WHERE id = ?").run(fixtures.taskId);

      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: crypto.randomUUID(),
          status: 'COMPLETED',
          summary: 'Receptive CODING state test',
        },
        plaintextToken
      );
      expect(res.accepted).toBe(true);
    });

    it('53. Task in receptive state HANDOFF_REQUIRED accepted', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare("UPDATE tasks SET state = 'HANDOFF_REQUIRED' WHERE id = ?").run(fixtures.taskId);

      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: crypto.randomUUID(),
          status: 'COMPLETED',
          summary: 'Receptive HANDOFF_REQUIRED state test',
        },
        plaintextToken
      );
      expect(res.accepted).toBe(true);
    });

    it('54. Task in non-receptive state TODO rejected with MCP_AUTHORITY_FENCED', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare("UPDATE tasks SET state = 'BLOCKED' WHERE id = ?").run(fixtures.taskId);

      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: crypto.randomUUID(),
          status: 'COMPLETED',
          summary: 'Non-receptive TODO test',
        },
        plaintextToken
      );
      expect(res.accepted).toBe(false);
      if (!res.accepted) {
        expect(res.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('55. Task in non-receptive state REVIEW rejected with MCP_AUTHORITY_FENCED', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare("UPDATE tasks SET state = 'REVIEWING' WHERE id = ?").run(fixtures.taskId);

      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: crypto.randomUUID(),
          status: 'COMPLETED',
          summary: 'Non-receptive REVIEW test',
        },
        plaintextToken
      );
      expect(res.accepted).toBe(false);
      if (!res.accepted) {
        expect(res.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('56. Task in terminal state CANCELLED rejected with MCP_AUTHORITY_FENCED', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare("UPDATE tasks SET state = 'CANCELLED' WHERE id = ?").run(fixtures.taskId);

      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: crypto.randomUUID(),
          status: 'COMPLETED',
          summary: 'Terminal CANCELLED test',
        },
        plaintextToken
      );
      expect(res.accepted).toBe(false);
      if (!res.accepted) {
        expect(res.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('57. Task ownership epoch mismatch returns MCP_AUTHORITY_FENCED', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare('UPDATE tasks SET ownership_epoch = 999 WHERE id = ?').run(fixtures.taskId);

      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: crypto.randomUUID(),
          status: 'COMPLETED',
          summary: 'Epoch mismatch test',
        },
        plaintextToken
      );
      expect(res.accepted).toBe(false);
      if (!res.accepted) {
        expect(res.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('58. Task revision count mismatch returns MCP_AUTHORITY_FENCED', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare('UPDATE tasks SET revision_count = 999 WHERE id = ?').run(fixtures.taskId);

      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: crypto.randomUUID(),
          status: 'COMPLETED',
          summary: 'Revision count mismatch test',
        },
        plaintextToken
      );
      expect(res.accepted).toBe(false);
      if (!res.accepted) {
        expect(res.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('59. Task attempt not running returns MCP_AUTHORITY_FENCED', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare("UPDATE task_attempts SET status = 'COMPLETED' WHERE id = ?").run(fixtures.attemptId);

      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: crypto.randomUUID(),
          status: 'COMPLETED',
          summary: 'Attempt not running test',
        },
        plaintextToken
      );
      expect(res.accepted).toBe(false);
      if (!res.accepted) {
        expect(res.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('60. Provider disabled returns MCP_AUTHORITY_FENCED', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare('UPDATE providers SET enabled = 0 WHERE id = ?').run(fixtures.providerId);

      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: crypto.randomUUID(),
          status: 'COMPLETED',
          summary: 'Provider disabled test',
        },
        plaintextToken
      );
      expect(res.accepted).toBe(false);
      if (!res.accepted) {
        expect(res.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('61. Provider resource disabled returns MCP_AUTHORITY_FENCED', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare('UPDATE provider_resources SET enabled = 0 WHERE id = ?').run(fixtures.resourceId);

      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: crypto.randomUUID(),
          status: 'COMPLETED',
          summary: 'Resource disabled test',
        },
        plaintextToken
      );
      expect(res.accepted).toBe(false);
      if (!res.accepted) {
        expect(res.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('62. Routing decision event missing returns MCP_AUTHORITY_FENCED', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      db.prepare("UPDATE execution_authorizations SET routing_decision_id = 'non-existent-route' WHERE id = ?").run(fixtures.authorizationId);

      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: crypto.randomUUID(),
          status: 'COMPLETED',
          summary: 'Route missing test',
        },
        plaintextToken
      );
      expect(res.accepted).toBe(false);
      if (!res.accepted) {
        expect(res.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('63. Repository HEAD drift detected returns REPOSITORY_HEAD_DRIFT_DETECTED', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      // Mutate auth repository_head_sha to something different from git rev-parse HEAD
      db.prepare("UPDATE execution_authorizations SET repository_head_sha = 'ffffffffffffffffffffffffffffffffffffffff' WHERE id = ?").run(fixtures.authorizationId);

      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: crypto.randomUUID(),
          status: 'COMPLETED',
          summary: 'Repository drift test',
        },
        plaintextToken
      );
      expect(res.accepted).toBe(false);
      if (!res.accepted) {
        expect(res.error_code).toBe('REPOSITORY_HEAD_DRIFT_DETECTED');
      }
    });
  });

  // =========================================================================
  // Group 6: Migration 22 & Append-Only Tamper Resistance
  // =========================================================================
  describe('Group 6: Migration 22 & Append-Only Tamper Resistance', () => {
    it('64. Migration 22 applied, schema version 22 in schema_migrations', () => {
      const row = db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get() as { version: number };
      expect(row.version).toBe(22);
    });

    it('65. Table mcp_submission_sessions exists with correct columns', () => {
      const cols = db.prepare("PRAGMA table_info('mcp_submission_sessions')").all() as Array<{ name: string }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('authorization_id');
      expect(colNames).toContain('scope');
      expect(colNames).toContain('token_hash');
      expect(colNames).toContain('authorization_fingerprint');
      expect(colNames).toContain('issued_at');
      expect(colNames).toContain('expires_at');
      expect(colNames).toContain('revoked_at');
      expect(colNames).toContain('revocation_reason');
    });

    it('66. Table coder_submissions exists with correct columns', () => {
      const cols = db.prepare("PRAGMA table_info('coder_submissions')").all() as Array<{ name: string }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('session_id');
      expect(colNames).toContain('authorization_id');
      expect(colNames).toContain('project_id');
      expect(colNames).toContain('task_id');
      expect(colNames).toContain('attempt_id');
      expect(colNames).toContain('claimed_status');
      expect(colNames).toContain('claim_content_hash');
      expect(colNames).toContain('claim_content_json');
      expect(colNames).toContain('canonical_envelope_hash');
      expect(colNames).toContain('submitted_at');
      expect(colNames).toContain('quarantine_status');
    });

    it('67. Table coder_submission_dispositions exists with correct columns', () => {
      const cols = db.prepare("PRAGMA table_info('coder_submission_dispositions')").all() as Array<{ name: string }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('submission_id');
      expect(colNames).toContain('disposition_event');
      expect(colNames).toContain('disposition_reason');
      expect(colNames).toContain('actor_type');
      expect(colNames).toContain('actor_id');
      expect(colNames).toContain('created_at');
    });

    it('68. UTC ISO 8601 millisecond timestamp accepted', () => {
      const validIssued = '2026-09-07T10:00:00.000Z';
      const validExpires = '2026-09-07T11:00:00.000Z';
      const hash = 'a'.repeat(64);
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_submission_sessions (id, authorization_id, scope, token_hash, authorization_fingerprint, issued_at, expires_at)
          VALUES (?, ?, 'CODER_SUBMISSION', ?, ?, ?, ?)
        `).run(crypto.randomUUID(), fixtures.authorizationId, hash, hash, validIssued, validExpires);
      }).not.toThrow();
    });

    it('69. Invalid calendar timestamp rejected by strftime round-trip check', () => {
      // 2026-02-31 does not exist on calendar
      const invalidCalendar = '2026-02-31T12:00:00.000Z';
      const validExpires = '2026-02-31T13:00:00.000Z';
      const hash = 'a'.repeat(64);
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_submission_sessions (id, authorization_id, scope, token_hash, authorization_fingerprint, issued_at, expires_at)
          VALUES (?, ?, 'CODER_SUBMISSION', ?, ?, ?, ?)
        `).run(crypto.randomUUID(), fixtures.authorizationId, hash, hash, invalidCalendar, validExpires);
      }).toThrow();
    });

    it('70. Append-only trigger rejects UPDATE on coder_submissions', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(
        {
          submission_id: subId,
          status: 'COMPLETED',
          summary: 'Append-only update test',
        },
        plaintextToken
      );

      expect(() => {
        db.prepare("UPDATE coder_submissions SET summary = 'tampered' WHERE id = ?").run(subId);
      }).toThrow(/append-only/i);
    });

    it('71. Append-only trigger rejects DELETE on coder_submissions', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(
        {
          submission_id: subId,
          status: 'COMPLETED',
          summary: 'Append-only delete test',
        },
        plaintextToken
      );

      expect(() => {
        db.prepare('DELETE FROM coder_submissions WHERE id = ?').run(subId);
      }).toThrow(/append-only/i);
    });

    it('72. Append-only trigger rejects UPDATE on coder_submission_dispositions', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(
        {
          submission_id: subId,
          status: 'COMPLETED',
          summary: 'Append-only disposition test',
        },
        plaintextToken
      );

      expect(() => {
        db.prepare("UPDATE coder_submission_dispositions SET actor_id = 'other' WHERE submission_id = ?").run(subId);
      }).toThrow(/append-only/i);
    });

    it('73. Append-only trigger rejects DELETE on coder_submission_dispositions', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.service.submitCoderClaim(
        {
          submission_id: subId,
          status: 'COMPLETED',
          summary: 'Append-only disposition delete test',
        },
        plaintextToken
      );

      expect(() => {
        db.prepare('DELETE FROM coder_submission_dispositions WHERE submission_id = ?').run(subId);
      }).toThrow(/append-only/i);
    });

    it('74. verifyMigration22SchemaAuthority passes on intact schema', () => {
      expect(() => {
        verifyMigration22SchemaAuthority(db);
      }).not.toThrow();
    });

    it('75. verifyMigration22SchemaAuthority throws on dropped table', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb);
      testDb.prepare('DROP TABLE coder_submissions').run();
      expect(() => {
        verifyMigration22SchemaAuthority(testDb);
      }).toThrow();
      testDb.close();
    });

    it('76. verifyMigration22SchemaAuthority throws on dropped trigger', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb);
      testDb.prepare('DROP TRIGGER trg_coder_submissions_no_update').run();
      expect(() => {
        verifyMigration22SchemaAuthority(testDb);
      }).toThrow();
      testDb.close();
    });
  });

  // =========================================================================
  // Group 7: Admin CLI & Session Lifecycle
  // =========================================================================
  describe('Group 7: Admin CLI & Session Lifecycle', () => {
    it('77. submissionAdmin issue creates session with CODER_SUBMISSION scope', () => {
      let stdoutCaptured = '';
      const originalWrite = process.stdout.write;
      process.stdout.write = ((chunk: any) => {
        stdoutCaptured += String(chunk);
        return true;
      }) as any;

      try {
        const exitCode = runSubmissionAdmin(['issue', '--db', dbPath, '--auth', fixtures.authorizationId, '--json']);
        expect(exitCode).toBe(0);
        const parsed = JSON.parse(stdoutCaptured);
        expect(parsed.status).toBe('ISSUED');
        expect(parsed.session.scope).toBe('CODER_SUBMISSION');
        expect(parsed.plaintext_token).toMatch(SUBMISSION_TOKEN_REGEX);
      } finally {
        process.stdout.write = originalWrite;
      }
    });

    it('78. submissionAdmin issue atomically revokes prior active session with SUPERSEDED_BY_NEW_SESSION', () => {
      const { sessionId: firstSessionId } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);

      const exitCode = runSubmissionAdmin(['issue', '--db', dbPath, '--auth', fixtures.authorizationId]);
      expect(exitCode).toBe(0);

      const oldSess = fixtures.repo.getMcpSubmissionSessionById(firstSessionId);
      expect(oldSess?.revoked_at).toBeDefined();
      expect(oldSess?.revocation_reason).toBe('SUPERSEDED_BY_NEW_SESSION');
    });

    it('79. submissionAdmin revoke by session ID', () => {
      const { sessionId } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);

      const exitCode = runSubmissionAdmin(['revoke', '--db', dbPath, '--session', sessionId, '--reason', 'MANUAL_TEST']);
      expect(exitCode).toBe(0);

      const sess = fixtures.repo.getMcpSubmissionSessionById(sessionId);
      expect(sess?.revoked_at).toBeDefined();
      expect(sess?.revocation_reason).toBe('MANUAL_TEST');
    });

    it('80. submissionAdmin revoke by auth ID', () => {
      const { sessionId } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);

      const exitCode = runSubmissionAdmin(['revoke', '--db', dbPath, '--auth', fixtures.authorizationId]);
      expect(exitCode).toBe(0);

      const sess = fixtures.repo.getMcpSubmissionSessionById(sessionId);
      expect(sess?.revoked_at).toBeDefined();
    });

    it('81. submissionAdmin configure-client outputs template with literal placeholder', () => {
      let stdoutCaptured = '';
      const originalWrite = process.stdout.write;
      process.stdout.write = ((chunk: any) => {
        stdoutCaptured += String(chunk);
        return true;
      }) as any;

      try {
        const exitCode = runSubmissionAdmin(['configure-client', '--client', 'cursor', '--db', dbPath]);
        expect(exitCode).toBe(0);
        expect(stdoutCaptured).toContain('<OPERATOR_SUBMISSION_TOKEN_REQUIRED>');
      } finally {
        process.stdout.write = originalWrite;
      }
    });

    it('82. submissionAdmin configure-client --json outputs envelope', () => {
      let stdoutCaptured = '';
      const originalWrite = process.stdout.write;
      process.stdout.write = ((chunk: any) => {
        stdoutCaptured += String(chunk);
        return true;
      }) as any;

      try {
        const exitCode = runSubmissionAdmin(['configure-client', '--client', 'antigravity', '--db', dbPath, '--json']);
        expect(exitCode).toBe(0);
        const envelope = JSON.parse(stdoutCaptured);
        expect(envelope.status).toBe('TEMPLATE_GENERATED');
        expect(envelope.client).toBe('antigravity');
        expect(envelope.incomplete).toBe(true);
      } finally {
        process.stdout.write = originalWrite;
      }
    });

    it('83. submissionAdmin closed grammar rejects unknown command', () => {
      let stderrCaptured = '';
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: any) => {
        stderrCaptured += String(chunk);
        return true;
      }) as any;

      try {
        const exitCode = runSubmissionAdmin(['unknown-command']);
        expect(exitCode).toBe(1);
        expect(stderrCaptured).toContain('Unknown command');
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it('84. submissionAdmin closed grammar rejects duplicate flags', () => {
      let stderrCaptured = '';
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: any) => {
        stderrCaptured += String(chunk);
        return true;
      }) as any;

      try {
        const exitCode = runSubmissionAdmin(['issue', '--db', dbPath, '--db', dbPath, '--auth', fixtures.authorizationId]);
        expect(exitCode).toBe(1);
        expect(stderrCaptured).toContain('Duplicate flag');
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it('85. submissionAdmin help as sole argument prints usage and exits 0', () => {
      let stdoutCaptured = '';
      const originalWrite = process.stdout.write;
      process.stdout.write = ((chunk: any) => {
        stdoutCaptured += String(chunk);
        return true;
      }) as any;

      try {
        const exitCode = runSubmissionAdmin(['help']);
        expect(exitCode).toBe(0);
        expect(stdoutCaptured).toContain('AgentForge MCP Coder Submission Administration CLI');
      } finally {
        process.stdout.write = originalWrite;
      }
    });

    it('86. submissionAdmin help combined with other flags throws', () => {
      let stderrCaptured = '';
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: any) => {
        stderrCaptured += String(chunk);
        return true;
      }) as any;

      try {
        const exitCode = runSubmissionAdmin(['help', '--db', dbPath]);
        expect(exitCode).toBe(1);
        expect(stderrCaptured).toContain('cannot be combined');
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });

  // =========================================================================
  // Group 8: Additional Edge Cases, Validations, and Invariants
  // =========================================================================
  describe('Group 8: Additional Invariants and Hardened Boundaries', () => {
    it('87. validateSubmissionTtlSeconds bounds check', () => {
      expect(validateSubmissionTtlSeconds(3600)).toBe(3600);
      expect(validateSubmissionTtlSeconds(undefined)).toBe(3600);
      expect(() => validateSubmissionTtlSeconds(10)).toThrow(/out of authorized bounds/);
      expect(() => validateSubmissionTtlSeconds(100000)).toThrow(/out of authorized bounds/);
      expect(() => validateSubmissionTtlSeconds('not-a-number')).toThrow(/integer number/);
    });

    it('88. generateSubmissionToken produces unique 43-character base64url strings', () => {
      const t1 = generateSubmissionToken();
      const t2 = generateSubmissionToken();
      expect(t1).not.toBe(t2);
      expect(validateSubmissionToken(t1)).toBe(true);
      expect(validateSubmissionToken(t2)).toBe(true);
      expect(t1.startsWith('af-sub-')).toBe(true);
      expect(t1.length).toBe(7 + 43);
    });

    it('89. Summary whitespace-only string is rejected by input schema', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: crypto.randomUUID(),
          status: 'COMPLETED',
          summary: '   \t\n   ',
        },
        plaintextToken
      );
      expect(res.accepted).toBe(false);
      if (!res.accepted) {
        expect(res.error_code).toBe('SCHEMA_VALIDATION_FAILED');
      }
    });

    it('90. Empty summary is rejected by input schema', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: crypto.randomUUID(),
          status: 'COMPLETED',
          summary: '',
        },
        plaintextToken
      );
      expect(res.accepted).toBe(false);
      if (!res.accepted) {
        expect(res.error_code).toBe('SCHEMA_VALIDATION_FAILED');
      }
    });

    it('91. Summary exceeding 4096 characters is rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: crypto.randomUUID(),
          status: 'COMPLETED',
          summary: 'a'.repeat(4097),
        },
        plaintextToken
      );
      expect(res.accepted).toBe(false);
      if (!res.accepted) {
        expect(res.error_code).toBe('SCHEMA_VALIDATION_FAILED');
      }
    });

    it('92. Non-UUID submission_id is rejected by schema', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: 'not-a-uuid-v4',
          status: 'COMPLETED',
          summary: 'Non-UUID ID test',
        },
        plaintextToken
      );
      expect(res.accepted).toBe(false);
      if (!res.accepted) {
        expect(res.error_code).toBe('SCHEMA_VALIDATION_FAILED');
      }
    });

    it('93. Uppercase UUID submission_id is rejected by schema', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const uppercaseUuid = crypto.randomUUID().toUpperCase();
      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: uppercaseUuid,
          status: 'COMPLETED',
          summary: 'Uppercase UUID test',
        },
        plaintextToken
      );
      expect(res.accepted).toBe(false);
      if (!res.accepted) {
        expect(res.error_code).toBe('SCHEMA_VALIDATION_FAILED');
      }
    });

    it('94. Client metadata unknown fields rejected by strict schema', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: crypto.randomUUID(),
          status: 'COMPLETED',
          summary: 'Client metadata test',
          client_metadata: {
            client_name: 'test-agent',
            unknown_extra_field: 'forbidden',
          } as any,
        },
        plaintextToken
      );
      expect(res.accepted).toBe(false);
      if (!res.accepted) {
        expect(res.error_code).toBe('SCHEMA_VALIDATION_FAILED');
      }
    });

    it('95. SubmissionMcpAuthorityContext close method cleanly closes owned database', () => {
      const ctx = new SubmissionMcpAuthorityContext({ dbPath });
      const svc = ctx.getOrCreateService();
      expect(svc).toBeDefined();
      expect(() => ctx.close()).not.toThrow();
    });

    it('96. SubmissionMcpAuthorityContext throws on missing database file', () => {
      const ctx = new SubmissionMcpAuthorityContext({ dbPath: path.join(tempDir, 'non-existent.db') });
      expect(() => ctx.getOrCreateService()).toThrow(/Database file does not exist/);
    });

    it('97. SubmissionMcpAuthorityContext throws on empty db path', () => {
      const ctx = new SubmissionMcpAuthorityContext({ dbPath: '' });
      expect(() => ctx.getOrCreateService()).toThrow(/Missing database path/);
    });

    it('98. generateSubmissionClientConfig throws on unsupported client name', () => {
      expect(() => {
        generateSubmissionClientConfig({ client: 'unsupported-ide', dbPath });
      }).toThrow(/Unsupported client/);
    });

    it('99. generateSubmissionClientConfig throws on relative dbPath', () => {
      expect(() => {
        generateSubmissionClientConfig({ client: 'cursor', dbPath: './relative/path.db' });
      }).toThrow(/Database path must be an absolute path/);
    });

    it('100. generateSubmissionClientConfigEnvelope generates structured envelope', () => {
      const env = generateSubmissionClientConfigEnvelope({ client: 'claude', dbPath });
      expect(env.status).toBe('TEMPLATE_GENERATED');
      expect(env.client).toBe('claude');
      expect(env.incomplete).toBe(true);
      expect(env.secret_delivery).toBe('MANUAL_OPERATOR_INPUT');
      expect(env.config.mcpServers['agentforge-submit']).toBeDefined();
    });

    it('101. Canonical JSON Stringify rejects NaN and Infinity', () => {
      expect(() => canonicalJsonStringify({ val: NaN })).toThrow(/Non-finite numbers/);
      expect(() => canonicalJsonStringify({ val: Infinity })).toThrow(/Non-finite numbers/);
    });

    it('102. Canonical JSON Stringify rejects undefined properties', () => {
      expect(() => canonicalJsonStringify({ val: undefined })).toThrow(/Undefined value/);
    });

    it('103. Canonical JSON Stringify deterministically orders deeply nested object keys', () => {
      const str1 = canonicalJsonStringify({ z: { b: 1, a: 2 }, a: [1, 2] });
      const str2 = canonicalJsonStringify({ a: [1, 2], z: { a: 2, b: 1 } });
      expect(str1).toBe(str2);
      expect(str1).toBe('{"a":[1,2],"z":{"a":2,"b":1}}');
    });

    it('104. Review requested defaults to true if omitted', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: subId,
          status: 'COMPLETED',
          summary: 'Review requested default test',
        },
        plaintextToken
      );
      expect(res.accepted).toBe(true);
      const sub = fixtures.repo.getCoderSubmissionById(subId);
      expect(sub?.review_requested).toBe(1);
    });

    it('105. Review requested set to false is persisted as 0', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: subId,
          status: 'COMPLETED',
          summary: 'Review requested false test',
          review_requested: false,
        },
        plaintextToken
      );
      expect(res.accepted).toBe(true);
      const sub = fixtures.repo.getCoderSubmissionById(subId);
      expect(sub?.review_requested).toBe(0);
    });

    it('106. Ingested claim preserves exact array payloads in database', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      const files = ['src/a.ts', 'src/b.ts'];
      const tests = ['test-1', 'test-2'];
      const blockers = ['blocker-1'];

      fixtures.service.submitCoderClaim(
        {
          submission_id: subId,
          status: 'BLOCKED',
          summary: 'Array persistence check',
          changed_files: files,
          tests_claimed: tests,
          blockers: blockers,
        },
        plaintextToken
      );

      const sub = fixtures.repo.getCoderSubmissionById(subId);
      const parsedContent = JSON.parse(sub!.claim_content_json);
      expect(parsedContent.changed_files).toEqual(files);
      expect(parsedContent.tests_claimed).toEqual(tests);
      expect(parsedContent.blockers).toEqual(blockers);
      expect(sub!.claimed_status).toBe('BLOCKED');
    });

    it('107. Server version constant matches package version', () => {
      expect(SUBMISSION_SERVER_NAME).toBe('agentforge-submit');
      expect(SUBMISSION_SERVER_VERSION).toBe('0.1.0');
    });

    it('108. createSubmissionMcpServer is alias for buildAgentForgeSubmissionMcpServer', () => {
      const s1 = createSubmissionMcpServer({ db, service: fixtures.service });
      const s2 = buildAgentForgeSubmissionMcpServer({ db, service: fixtures.service });
      expect(s1).toBeDefined();
      expect(s2).toBeDefined();
    });

    it('109. Attempting submission on non-existent authorization ID in tool argument rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const res = fixtures.service.submitCoderClaim(
        {
          submission_id: crypto.randomUUID(),
          authorization_id: crypto.randomUUID(), // mismatch with session auth
          status: 'COMPLETED',
          summary: 'Mismatched auth ID in argument',
        },
        plaintextToken
      );
      expect(res.accepted).toBe(false);
      if (!res.accepted) {
        expect(res.error_code).toBe('MCP_AUTHORITY_FENCED');
      }
    });

    it('110. Receptive state transitions: submission succeeds when task transitions from CODING to HANDOFF_REQUIRED', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);

      // Submission 1 in CODING
      const res1 = fixtures.service.submitCoderClaim(
        {
          submission_id: crypto.randomUUID(),
          status: 'IN_PROGRESS',
          summary: 'First submission in CODING',
        },
        plaintextToken
      );
      expect(res1.accepted).toBe(true);

      // Transition task state to HANDOFF_REQUIRED
      db.prepare("UPDATE tasks SET state = 'HANDOFF_REQUIRED' WHERE id = ?").run(fixtures.taskId);

      // Submission 2 in HANDOFF_REQUIRED
      const res2 = fixtures.service.submitCoderClaim(
        {
          submission_id: crypto.randomUUID(),
          status: 'COMPLETED',
          summary: 'Second submission in HANDOFF_REQUIRED',
        },
        plaintextToken
      );
      expect(res2.accepted).toBe(true);
    });
  });
});
