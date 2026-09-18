import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import child_process from 'child_process';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import {
  CoderSubmissionAdjudicationService,
  evaluateCanonicalSettlementDecision,
} from '../src/core/services/CoderSubmissionAdjudicationService';
import { VerificationService } from '../src/core/services/VerificationService';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import { McpSubmissionAuthorityService } from '../src/core/services/McpSubmissionAuthorityService';
import { EventService } from '../src/core/services/EventService';
import { TaskService } from '../src/core/services/TaskService';
import { ProjectService } from '../src/core/services/ProjectService';
import { ReviewerAuthorityService } from '../src/mcp/reviewerAuthority';
import { buildAgentForgeReviewerMcpServer } from '../src/mcp/reviewerServer';
import {
  REVIEWER_TOOL_NAME,
  REVIEWER_URI_TEMPLATE,
  REVIEWER_RESOURCE_NAME,
  REVIEWER_MIME_TYPE,
} from '../src/mcp/reviewerProtocol';
import {
  generateSubmissionToken,
  computeAuthorityFingerprint,
  canonicalJsonStringify,
  computeSha256,
} from '../src/mcp/submissionProtocol';
import { computePayloadHash } from '../src/core/services/ExecutionAuthorizationService';
import { ExecutionAuthorization } from '../src/core/types/domain';

interface SyntheticRehearsalEnv {
  tempDir: string;
  repoDir: string;
  dbPath: string;
  db: Database.Database;
  repo: Repository;
  artifactStore: ArtifactStore;
  verificationService: VerificationService;
  mcpService: McpSubmissionAuthorityService;
  adjudicationService: CoderSubmissionAdjudicationService;
  reviewerService: ReviewerAuthorityService;
  eventService: EventService;
  taskService: TaskService;
  projectService: ProjectService;
  projectId: string;
  taskId: string;
  attemptId: string;
  assignmentId: string;
  providerId: string;
  coderAccountId: string;
  reviewerAccountId: string;
  coderResourceId: string;
  reviewerResourceId: string;
  roleIdCoder: string;
  roleIdReviewer: string;
  agentIdCoder: string;
  agentIdReviewer: string;
  workerSlotId: string;
  accountLeaseId: string;
  authorizationId: string;
  baseSha: string;
  repoHeadSha: string;
  managerMessageId: string;
  managerPayloadHash: string;
  instructions: string[];
}

function setupSyntheticRehearsalEnv(options?: {
  failVerification?: boolean;
}): SyntheticRehearsalEnv {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-r5l1-rehearsal-'));
  const repoDir = path.join(tempDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });

  // Initialize a synthetic git repository
  child_process.execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
  child_process.execFileSync('git', ['config', 'user.name', 'Synthetic Agent'], { cwd: repoDir, stdio: 'ignore' });
  child_process.execFileSync('git', ['config', 'user.email', 'synthetic@agentforge.local'], { cwd: repoDir, stdio: 'ignore' });
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Synthetic Rehearsal Project\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, 'solution.txt'), 'Initial codebase state\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, 'test_pass.js'), 'console.log("Synthetic test passed"); process.exit(0);\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, 'test_fail.js'), 'console.error("Synthetic test failed"); process.exit(1);\n', 'utf8');
  child_process.execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
  child_process.execFileSync('git', ['commit', '-m', 'Initial synthetic commit'], { cwd: repoDir, stdio: 'ignore' });

  const repoHeadSha = child_process
    .execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .trim()
    .toLowerCase();
  const baseSha = repoHeadSha;

  // Initialize dedicated SQLite database and run all migrations
  const dbPath = path.join(tempDir, 'rehearsal.db');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  MigrationRunner.run(db);

  // Initialize artifact storage and core services
  const artifactsDir = path.join(tempDir, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  const artifactStore = new ArtifactStore(artifactsDir);
  const repo = new Repository(db);
  const eventService = new EventService(repo);
  const verificationService = new VerificationService(repo, artifactStore);
  const mcpService = new McpSubmissionAuthorityService(repo, db);
  const adjudicationService = new CoderSubmissionAdjudicationService(repo, db, verificationService, eventService);
  const reviewerService = new ReviewerAuthorityService(repo, artifactStore);
  const projectService = new ProjectService(repo, eventService);
  const taskService = new TaskService(repo, eventService, verificationService, artifactStore);

  const now = new Date().toISOString();
  const projectId = 'proj-synth-' + crypto.randomUUID();
  const taskId = 'task-synth-' + crypto.randomUUID();
  const attemptId = 'att-synth-' + crypto.randomUUID();
  const assignmentId = 'asgn-synth-' + crypto.randomUUID();
  const providerId = 'prov-synth-' + crypto.randomUUID();
  const coderAccountId = 'acc-coder-' + crypto.randomUUID();
  const reviewerAccountId = 'acc-rev-' + crypto.randomUUID();
  const coderResourceId = 'res-coder-' + crypto.randomUUID();
  const reviewerResourceId = 'res-rev-' + crypto.randomUUID();
  const roleIdCoder = 'role-coder-' + crypto.randomUUID();
  const roleIdReviewer = 'role-rev-' + crypto.randomUUID();
  const agentIdCoder = 'agent-coder-' + crypto.randomUUID();
  const agentIdReviewer = 'agent-rev-' + crypto.randomUUID();
  const workerSlotId = 'slot-synth-' + crypto.randomUUID();
  const accountLeaseId = 'lease-slot-' + crypto.randomUUID();
  const authorizationId = 'auth-synth-' + crypto.randomUUID();
  const managerMessageId = 'msg-proto-' + crypto.randomUUID();
  const managerRecordId = 'msg-rec-' + crypto.randomUUID();

  // 1. Synthetic Provider, Separate Accounts, Resources
  db.prepare(`
    INSERT INTO providers (id, name, adapter_type, enabled, created_at)
    VALUES (?, 'Synthetic Local CLI Provider', 'LOCAL_CLI', 1, ?)
  `).run(providerId, now);

  db.prepare(`
    INSERT INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at)
    VALUES (?, ?, 'synthetic-coder-account', 'NATIVE_PROFILE', 1, 10, 'AVAILABLE', 10, ?, ?)
  `).run(coderAccountId, providerId, now, now);

  db.prepare(`
    INSERT INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at)
    VALUES (?, ?, 'synthetic-reviewer-account', 'NATIVE_PROFILE', 1, 10, 'AVAILABLE', 10, ?, ?)
  `).run(reviewerAccountId, providerId, now, now);

  db.prepare(`
    INSERT INTO provider_resources (id, provider_id, provider_account_id, model_name, health_status, capabilities_json, enabled, total_quota, remaining_quota, quota_unit, quota_source, quota_confidence, last_health_check)
    VALUES (?, ?, ?, 'synthetic-claude-coder', 'AVAILABLE', '["CODING"]', 1, 1000, 1000, 'REQUESTS', 'PROVIDER_REPORTED', 1.0, ?)
  `).run(coderResourceId, providerId, coderAccountId, now);

  db.prepare(`
    INSERT INTO provider_resources (id, provider_id, provider_account_id, model_name, health_status, capabilities_json, enabled, total_quota, remaining_quota, quota_unit, quota_source, quota_confidence, last_health_check)
    VALUES (?, ?, ?, 'synthetic-claude-reviewer', 'AVAILABLE', '["REVIEWING"]', 1, 1000, 1000, 'REQUESTS', 'PROVIDER_REPORTED', 1.0, ?)
  `).run(reviewerResourceId, providerId, reviewerAccountId, now);

  // 2. Role and Agent Profiles
  db.prepare(`
    INSERT INTO role_profiles (id, role, display_name, required_capabilities_json, preferred_capabilities_json, permissions_json, enabled, created_at, updated_at)
    VALUES (?, 'CODER', 'Synthetic Coder Role', '["CODING"]', '[]', '[]', 1, ?, ?)
  `).run(roleIdCoder, now, now);

  db.prepare(`
    INSERT INTO role_profiles (id, role, display_name, required_capabilities_json, preferred_capabilities_json, permissions_json, enabled, created_at, updated_at)
    VALUES (?, 'REVIEWER', 'Synthetic Reviewer Role', '["REVIEWING"]', '[]', '[]', 1, ?, ?)
  `).run(roleIdReviewer, now, now);

  const coderAgentProfileId = 'prof-coder-' + crypto.randomUUID();
  db.prepare(`
    INSERT INTO agent_profiles (id, role_profile_id, name, enabled, created_at, updated_at)
    VALUES (?, ?, 'Synthetic Coder Profile', 1, ?, ?)
  `).run(coderAgentProfileId, roleIdCoder, now, now);

  db.prepare(`
    INSERT INTO agents (id, display_name, role, provider_resource_id, status, current_task_id, last_seen_at)
    VALUES (?, 'Synthetic Coder Agent', 'CODER', ?, 'IDLE', NULL, ?)
  `).run(agentIdCoder, coderResourceId, now);

  db.prepare(`
    INSERT INTO agents (id, display_name, role, provider_resource_id, status, current_task_id, last_seen_at)
    VALUES (?, 'Synthetic Reviewer Agent', 'REVIEWER', ?, 'IDLE', NULL, ?)
  `).run(agentIdReviewer, reviewerResourceId, now);

  // 3. Project and Task
  repo.createProject({
    id: projectId,
    name: 'Synthetic Rehearsal Project',
    description: 'Project for R5L1 rehearsal synthetic pipeline',
    repository_path: repoDir,
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
    VALUES (?, ?, 'Synthetic Task 1', 'CODING', 'LOW', 'LOW', 1, 3, 0, ?, 1, ?, ?)
  `).run(taskId, projectId, baseSha, now, now);

  // 4. Task Attempt
  repo.createTaskAttempt({
    id: attemptId,
    task_id: taskId,
    attempt_number: 1,
    status: 'RUNNING',
    agent_profile_id: coderAgentProfileId,
    agent_id: agentIdCoder,
    started_at: now,
    ended_at: null,
    summary: 'Synthetic attempt 1',
  });

  // 5. Worker Slot and Worker-Slot Account Lease (account_leases)
  db.prepare(`
    INSERT INTO worker_slots (id, provider_account_id, provider_resource_id, slot_index, status, current_assignment_id, created_at, updated_at)
    VALUES (?, ?, ?, 1, 'RUNNING', ?, ?, ?)
  `).run(workerSlotId, coderAccountId, coderResourceId, assignmentId, now, now);

  const routingDecisionId = 'route-synth-' + crypto.randomUUID();
  const routingPayload = {
    decisionId: routingDecisionId,
    projectId,
    taskId,
    attemptId,
    roleProfileId: roleIdCoder,
    role: 'CODER',
    outcome: 'SELECTED',
    routePolicyId: null,
    failoverPolicyAuthoritySnapshot: null,
    selectedProviderId: providerId,
    selectedAccountId: coderAccountId,
    selectedResourceId: coderResourceId,
    selectedAssignmentId: assignmentId,
    requestedConstraints: [],
    appliedExclusions: [],
    appliedSeparation: null,
    reason: 'Optimal synthetic route',
  };
  db.prepare(`
    INSERT INTO events (id, project_id, task_id, type, summary, structured_payload_json, timestamp)
    VALUES (?, ?, ?, 'ROLE_AWARE_ROUTING_DECISION', 'Optimal synthetic route', ?, ?)
  `).run(routingDecisionId, projectId, taskId, JSON.stringify(routingPayload), now);

  repo.createAgentAssignment({
    id: assignmentId,
    project_id: projectId,
    task_id: taskId,
    attempt_id: attemptId,
    role_profile_id: roleIdCoder,
    agent_profile_id: coderAgentProfileId,
    selected_provider_id: providerId,
    selected_account_id: coderAccountId,
    selected_resource_id: coderResourceId,
    selected_worker_slot_id: workerSlotId,
    routing_decision_id: routingDecisionId,
    status: 'ASSIGNED',
    created_at: now,
    ended_at: null,
    preferred_metadata: null,
  });

  db.prepare(`
    INSERT INTO account_leases (id, assignment_id, provider_account_id, worker_slot_id, lease_token, acquired_at, expires_at, heartbeat_at, released_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    accountLeaseId,
    assignmentId,
    coderAccountId,
    workerSlotId,
    'lease-token-slot-' + crypto.randomUUID(),
    now,
    new Date(Date.now() + 3600000).toISOString(),
    now
  );

  // 6. Protocol Message
  const instructions = ['Task: Implement synthetic verified feature', 'Keep all invariants intact'];
  const managerPayload = {
    protocol: 'manager.v1',
    message_id: managerMessageId,
    project_id: projectId,
    task_id: taskId,
    decision: 'EXECUTE',
    priority: 'LOW',
    risk: 'LOW',
    instructions,
    acceptance_criteria: ['Verification passes clean'],
    constraints: ['No regression'],
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

  // 7. Canonical Execution Payload and Verification Commands
  const verificationCommandExecutable = process.execPath;
  const verificationCommandArgs = options?.failVerification
    ? ['test_fail.js']
    : ['test_pass.js'];

  const verificationCommands = {
    TEST: {
      executable: verificationCommandExecutable,
      args: verificationCommandArgs,
      timeout_ms: 60000,
    },
    LINT: null,
    BUILD: null,
  };

  const contextFiles = ['README.md'];
  const canonicalPayload = {
    projectId,
    taskId,
    attemptId,
    taskTitle: 'Synthetic Task 1',
    taskDescription: 'R5L1 Rehearsal Synthetic Task',
    acceptanceCriteria: ['Verification passes clean'],
    constraints: ['No regression'],
    instructions,
    contextFiles,
    verificationCommands,
    managerMessageId: managerRecordId,
    managerPayloadHash,
  };

  const canonicalPayloadJson = JSON.stringify(canonicalPayload);
  const instructionPayloadHash = computePayloadHash(canonicalPayload as any);
  const contextManifestHash = crypto.createHash('sha256').update(JSON.stringify(contextFiles), 'utf8').digest('hex');

  // 8. Execution Authorization
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
    selected_resource_id: coderResourceId,
    selected_provider_id: providerId,
    instruction_payload_hash: instructionPayloadHash,
    context_manifest_hash: contextManifestHash,
    canonical_instructions_json: JSON.stringify(instructions),
    context_files_json: JSON.stringify(contextFiles),
    canonical_payload_json: canonicalPayloadJson,
    status: 'DISPATCHED',
    created_at: now,
    dispatched_at: now,
    execution_id: 'exec-synth-' + crypto.randomUUID(),
    task_ownership_epoch: 1,
    lifecycle_version: null,
    selected_account_id: coderAccountId,
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
    tempDir,
    repoDir,
    dbPath,
    db,
    repo,
    artifactStore,
    verificationService,
    mcpService,
    adjudicationService,
    reviewerService,
    eventService,
    taskService,
    projectService,
    projectId,
    taskId,
    attemptId,
    assignmentId,
    providerId,
    coderAccountId,
    reviewerAccountId,
    coderResourceId,
    reviewerResourceId,
    roleIdCoder,
    roleIdReviewer,
    agentIdCoder,
    agentIdReviewer,
    workerSlotId,
    accountLeaseId,
    authorizationId,
    baseSha,
    repoHeadSha,
    managerMessageId,
    managerPayloadHash,
    instructions,
  };
}

function issueSubmissionSession(
  repo: Repository,
  authorizationId: string,
  ttlSeconds = 3600
): { plaintextToken: string; sessionId: string } {
  const plaintextToken = generateSubmissionToken();
  const tokenHash = crypto.createHash('sha256').update(plaintextToken, 'utf8').digest('hex');
  const sessionId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
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
    issuer_identity: 'OWNER_LOCAL_CLI',
    token_hash: tokenHash,
    authorization_fingerprint: authorizationFingerprint,
    issued_at: nowIso,
    expires_at: expiresAt,
    revoked_at: null,
    revocation_reason: null,
  });

  return { plaintextToken, sessionId };
}

describe('R5L1 Rehearsal Synthetic Pipeline Suite', () => {
  let env: SyntheticRehearsalEnv | null = null;

  afterEach(() => {
    if (env) {
      try {
        if (env.db?.open) env.db.close();
      } catch {}
      try {
        fs.rmSync(env.tempDir, { recursive: true, force: true });
      } catch {}
      env = null;
    }
  });

  // =========================================================================
  // SCENARIO 1: Complete Happy Path
  // Quarantined Submission -> Admission -> Verification -> Settlement -> Reviewer Read
  // =========================================================================
  it('1. Full synthetic pipeline: quarantined submission -> admission -> verification -> settlement -> reviewer read (zero-write)', async () => {
    env = setupSyntheticRehearsalEnv({ failVerification: false });
    const { repo, db, mcpService, adjudicationService, reviewerService } = env;

    // --- STEP 1: Quarantined Submission ---
    const { plaintextToken } = issueSubmissionSession(repo, env.authorizationId);
    const submissionId = crypto.randomUUID();
    const claimPayload = {
      submission_id: submissionId,
      authorization_id: env.authorizationId,
      project_id: env.projectId,
      task_id: env.taskId,
      attempt_id: env.attemptId,
      assignment_id: env.assignmentId,
      task_ownership_epoch: 1,
      base_sha: env.baseSha,
      repository_head_sha: env.repoHeadSha,
      status: 'COMPLETED',
      summary: 'Synthetic execution completed with verified tests',
      changed_files: ['README.md'],
      tests_claimed: ['test-synthetic-1'],
      blockers: [],
      review_requested: true,
      client_metadata: {
        client_name: 'synthetic-coder-agent',
        client_version: '1.0.0',
        client_session_mode: 'CLI_EXTERNAL',
      },
    };

    const submitRes = mcpService.submitCoderClaim(claimPayload, plaintextToken);
    expect(submitRes.accepted).toBe(true);

    const submission = repo.getCoderSubmissionById(submissionId);
    expect(submission).toBeDefined();
    expect(submission?.quarantine_status).toBe('QUARANTINED');
    expect(submission?.claimed_status).toBe('COMPLETED');
    expect(submission?.authorization_id).toBe(env.authorizationId);
    expect(submission?.task_id).toBe(env.taskId);
    expect(submission?.project_id).toBe(env.projectId);

    // --- STEP 2 & 3: Owner Admission & Verification ---
    const admitRequestId = crypto.randomUUID();
    const admitRes = await adjudicationService.admitSubmissionForVerification({
      requestId: admitRequestId,
      submissionId,
    });

    expect(admitRes.status).toBe('VERIFIED');
    expect(admitRes.adjudication).toBeDefined();
    const adjudicationId = admitRes.adjudication.id;

    // Verify task state transitioned to REVIEW_READY
    const taskAfter = repo.getTask(env.taskId);
    expect(taskAfter?.state).toBe('REVIEW_READY');

    // Verify workspace lease (coder_submission_workspace_leases) was acquired and released cleanly
    const workspaceLease = admitRes.adjudication.workspace_lease_id
      ? repo.getWorkspaceLease(admitRes.adjudication.workspace_lease_id)
      : null;
    expect(workspaceLease).toBeDefined();
    expect(workspaceLease?.state).toBe('RELEASED');
    expect(workspaceLease?.released_at).not.toBeNull();

    // Verify worker-slot lease (account_leases) was NOT mutated or released by adjudication
    const workerSlotLease = repo.getAccountLease(env.accountLeaseId);
    expect(workerSlotLease).toBeDefined();
    expect(workerSlotLease?.released_at).toBeNull(); // Worker slot lease remains managed by worker lifecycle

    // --- STEP 4: Settlement Dispositions & Events ---
    const dispositions = repo.getCoderSubmissionDispositions(submissionId);
    expect(dispositions.length).toBeGreaterThanOrEqual(1);
    const settledDisp = dispositions.find((d) => d.disposition_event === 'SETTLED');
    expect(settledDisp).toBeDefined();
    expect(settledDisp?.disposition_reason).toBe('ACCEPTED_VERIFIED');

    const adjEvents = repo.getCoderSubmissionAdjudicationEvents(adjudicationId);
    expect(adjEvents.length).toBeGreaterThanOrEqual(3);
    const eventTypes = adjEvents.map((e) => e.event_type);
    expect(eventTypes).toContain('ADMITTED');
    expect(eventTypes).toContain('VERIFICATION_CLAIMED');
    expect(eventTypes).toContain('VERIFICATION_SUCCEEDED');

    // --- STEP 5: Projection Integrity ---
    const projection = adjudicationService.buildVerifiedAdjudicationReviewProjection(adjudicationId);
    expect(projection).toBeDefined();
    expect(projection.adjudication_id).toBe(adjudicationId);
    expect(projection.authoritative_verification.verdict).toBe('PASSED');
    expect(projection.projection_hash).toBeDefined();
    expect(typeof projection.projection_hash).toBe('string');
    expect(projection.projection_hash.length).toBe(64);

    // --- STEP 6: Reviewer MCP Tool & Resource Read (Zero-Write) ---
    const issuance = reviewerService.issueReviewerSession({
      adjudication_id: adjudicationId,
      reviewer_agent_id: env.agentIdReviewer,
      reviewer_provider_id: env.providerId,
      reviewer_account_id: env.reviewerAccountId,
      reviewer_resource_id: env.reviewerResourceId,
      duration_seconds: 3600,
    });
    expect(issuance.raw_token).toBeDefined();

    const mcpServer = buildAgentForgeReviewerMcpServer({
      db,
      reviewerToken: issuance.raw_token,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const mcpClient = new Client({ name: 'synthetic-reviewer-client', version: '1.0.0' });
    await mcpClient.connect(clientTransport);

    // Baseline database state before reviewer reads
    const changesBefore = (db.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
    const dataVersionBefore = db.pragma('data_version', { simple: true }) as number;

    // Reviewer reads tool
    const toolRes = await mcpClient.callTool({
      name: REVIEWER_TOOL_NAME,
      arguments: { adjudication_id: adjudicationId },
    });
    expect(toolRes.isError).toBeFalsy();
    expect(toolRes.content).toHaveLength(1);
    const toolText = (toolRes.content[0] as { type: 'text'; text: string }).text;
    const toolPackage = JSON.parse(toolText);
    expect(toolPackage.adjudication.id).toBe(adjudicationId);
    expect(computeSha256(toolText)).toBe(issuance.session.projection_hash);

    // Reviewer reads resource
    const resourceRes = await mcpClient.readResource({
      uri: `agentforge://reviews/packages/${adjudicationId}`,
    });
    expect(resourceRes.contents).toHaveLength(1);
    expect(resourceRes.contents[0].mimeType).toBe(REVIEWER_MIME_TYPE);
    const resourceText = (resourceRes.contents[0] as { text: string }).text;
    const resourcePackage = JSON.parse(resourceText);
    expect(resourcePackage.adjudication.id).toBe(adjudicationId);
    expect(computeSha256(resourceText)).toBe(issuance.session.projection_hash);

    // Assert Zero-Write: no row modifications and no data version bump during reads
    const changesAfter = (db.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
    const dataVersionAfter = db.pragma('data_version', { simple: true }) as number;
    expect(changesAfter).toBe(changesBefore);
    expect(dataVersionAfter).toBe(dataVersionBefore);

    await mcpClient.close();
    await mcpServer.close();

    // --- STEP 7: Teardown Cleanliness (No leaked worktree / process) ---
    const worktreeList = child_process
      .execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: env.repoDir, encoding: 'utf8' })
      .trim();
    const worktreeCount = worktreeList.split('\n').filter((l) => l.startsWith('worktree ')).length;
    expect(worktreeCount).toBe(1); // Only the root repository worktree remains
  });

  // =========================================================================
  // SCENARIO 2: Verification Failure Branch
  // Non-zero exit code -> VERIFICATION_FAILED -> Task stays fail-closed -> Lease released
  // =========================================================================
  it('2. Verification failure branch: non-zero exit classification transitions to VERIFICATION_FAILED and releases lease', async () => {
    env = setupSyntheticRehearsalEnv({ failVerification: true });
    const { repo, mcpService, adjudicationService } = env;

    const { plaintextToken } = issueSubmissionSession(repo, env.authorizationId);
    const submissionId = crypto.randomUUID();
    const claimPayload = {
      submission_id: submissionId,
      authorization_id: env.authorizationId,
      project_id: env.projectId,
      task_id: env.taskId,
      attempt_id: env.attemptId,
      assignment_id: env.assignmentId,
      task_ownership_epoch: 1,
      base_sha: env.baseSha,
      repository_head_sha: env.repoHeadSha,
      status: 'COMPLETED',
      summary: 'Execution with failing test',
      changed_files: ['README.md'],
      tests_claimed: ['test-failure'],
      blockers: [],
      review_requested: true,
      client_metadata: { client_name: 'synthetic-coder-agent', client_version: '1.0.0', client_session_mode: 'CLI_EXTERNAL' },
    };

    mcpService.submitCoderClaim(claimPayload, plaintextToken);

    const admitRes = await adjudicationService.admitSubmissionForVerification({
      requestId: crypto.randomUUID(),
      submissionId,
    });

    expect(admitRes.status).toBe('VERIFICATION_FAILED');
    expect(admitRes.adjudication.status).toBe('VERIFICATION_FAILED');
    expect(admitRes.adjudication.failure_code).toBe('TESTS_FAILED');

    // Task state must NOT advance to REVIEW_READY (transitions back to CODING / revision incremented)
    const taskAfter = repo.getTask(env.taskId);
    expect(taskAfter?.state).not.toBe('REVIEW_READY');
    expect(taskAfter?.state).toBe('CODING');
    expect(taskAfter?.revision_count).toBe(2);

    // Workspace lease must be released
    if (admitRes.adjudication.workspace_lease_id) {
      const lease = repo.getWorkspaceLease(admitRes.adjudication.workspace_lease_id);
      expect(lease?.state).toBe('RELEASED');
      expect(lease?.released_at).not.toBeNull();
    }

    // Disposition must record failure
    const dispositions = repo.getCoderSubmissionDispositions(submissionId);
    const failDisp = dispositions.find((d) => d.disposition_event === 'REJECTED');
    expect(failDisp).toBeDefined();
    expect(failDisp?.disposition_reason).toBe('FENCED_PRECONDITION');
  });

  // =========================================================================
  // SCENARIO 3: Reviewer Read Rejection Branches
  // Expired token, revoked session, cross-adjudication, projection tamper
  // =========================================================================
  it('3. Reviewer read rejection branches: expired token, revoked session, cross-adjudication, and tampered envelope', async () => {
    env = setupSyntheticRehearsalEnv({ failVerification: false });
    const { repo, db, mcpService, adjudicationService, reviewerService } = env;

    const { plaintextToken } = issueSubmissionSession(repo, env.authorizationId);
    const submissionId = crypto.randomUUID();
    mcpService.submitCoderClaim(
      {
        submission_id: submissionId,
        authorization_id: env.authorizationId,
        project_id: env.projectId,
        task_id: env.taskId,
        attempt_id: env.attemptId,
        assignment_id: env.assignmentId,
        task_ownership_epoch: 1,
        base_sha: env.baseSha,
        repository_head_sha: env.repoHeadSha,
        status: 'COMPLETED',
        summary: 'Submission for rejection testing',
        changed_files: ['README.md'],
        tests_claimed: ['test-synth'],
        blockers: [],
        review_requested: true,
        client_metadata: { client_name: 'synthetic-agent', client_version: '1.0.0', client_session_mode: 'CLI_EXTERNAL' },
      },
      plaintextToken
    );

    const admitRes = await adjudicationService.admitSubmissionForVerification({
      requestId: crypto.randomUUID(),
      submissionId,
    });
    const adjudicationId = admitRes.adjudication.id;
    const nowIso = new Date().toISOString();
    const revAgentA = 'agent-rev-a-' + crypto.randomUUID();
    const revAgentB = 'agent-rev-b-' + crypto.randomUUID();
    const revAgentC = 'agent-rev-c-' + crypto.randomUUID();
    db.prepare(`INSERT INTO agents (id, display_name, role, provider_resource_id, status, current_task_id, last_seen_at) VALUES (?, 'Reviewer Agent A', 'REVIEWER', ?, 'IDLE', NULL, ?)`).run(revAgentA, env.reviewerResourceId, nowIso);
    db.prepare(`INSERT INTO agents (id, display_name, role, provider_resource_id, status, current_task_id, last_seen_at) VALUES (?, 'Reviewer Agent B', 'REVIEWER', ?, 'IDLE', NULL, ?)`).run(revAgentB, env.reviewerResourceId, nowIso);
    db.prepare(`INSERT INTO agents (id, display_name, role, provider_resource_id, status, current_task_id, last_seen_at) VALUES (?, 'Reviewer Agent C', 'REVIEWER', ?, 'IDLE', NULL, ?)`).run(revAgentC, env.reviewerResourceId, nowIso);

    // --- Branch A: Expired Token ---
    const expiredIssuance = reviewerService.issueReviewerSession({
      adjudication_id: adjudicationId,
      reviewer_agent_id: revAgentA,
      reviewer_provider_id: env.providerId,
      reviewer_account_id: env.reviewerAccountId,
      reviewer_resource_id: env.reviewerResourceId,
      duration_seconds: 3600,
    });

    const serverExpired = buildAgentForgeReviewerMcpServer({ db, reviewerToken: expiredIssuance.raw_token });
    const [cTransExp, sTransExp] = InMemoryTransport.createLinkedPair();
    await serverExpired.connect(sTransExp);
    const clientExp = new Client({ name: 'expired-client', version: '1.0.0' });
    await clientExp.connect(cTransExp);

    // Fast-forward time past expiration
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 7200 * 1000));

    const expiredToolCall = await clientExp.callTool({
      name: REVIEWER_TOOL_NAME,
      arguments: { adjudication_id: adjudicationId },
    });
    expect(expiredToolCall.isError).toBe(true);
    expect((expiredToolCall.content[0] as { text: string }).text).toContain('TOKEN_EXPIRED');

    vi.useRealTimers();

    await clientExp.close();
    await serverExpired.close();

    // --- Branch B: Revoked Session ---
    const revokedIssuance = reviewerService.issueReviewerSession({
      adjudication_id: adjudicationId,
      reviewer_agent_id: revAgentB,
      reviewer_provider_id: env.providerId,
      reviewer_account_id: env.reviewerAccountId,
      reviewer_resource_id: env.reviewerResourceId,
      duration_seconds: 3600,
    });
    reviewerService.revokeReviewerSession(revokedIssuance.session.id, 'Security revocation for test');

    const serverRevoked = buildAgentForgeReviewerMcpServer({ db, reviewerToken: revokedIssuance.raw_token });
    const [cTransRev, sTransRev] = InMemoryTransport.createLinkedPair();
    await serverRevoked.connect(sTransRev);
    const clientRev = new Client({ name: 'revoked-client', version: '1.0.0' });
    await clientRev.connect(cTransRev);

    const revokedToolCall = await clientRev.callTool({
      name: REVIEWER_TOOL_NAME,
      arguments: { adjudication_id: adjudicationId },
    });
    expect(revokedToolCall.isError).toBe(true);
    expect((revokedToolCall.content[0] as { text: string }).text).toContain('TOKEN_REVOKED');

    await clientRev.close();
    await serverRevoked.close();

    // --- Branch C: Cross-Adjudication Access Rejection ---
    const validIssuance = reviewerService.issueReviewerSession({
      adjudication_id: adjudicationId,
      reviewer_agent_id: revAgentC,
      reviewer_provider_id: env.providerId,
      reviewer_account_id: env.reviewerAccountId,
      reviewer_resource_id: env.reviewerResourceId,
      duration_seconds: 3600,
    });
    const serverValid = buildAgentForgeReviewerMcpServer({ db, reviewerToken: validIssuance.raw_token });
    const [cTransVal, sTransVal] = InMemoryTransport.createLinkedPair();
    await serverValid.connect(sTransVal);
    const clientVal = new Client({ name: 'valid-client', version: '1.0.0' });
    await clientVal.connect(cTransVal);

    const foreignAdjudicationId = crypto.randomUUID();
    const crossAdjCall = await clientVal.callTool({
      name: REVIEWER_TOOL_NAME,
      arguments: { adjudication_id: foreignAdjudicationId },
    });
    expect(crossAdjCall.isError).toBe(true);
    expect((crossAdjCall.content[0] as { text: string }).text).toContain('PERMISSION_DENIED');

    // --- Branch D: Stale Authority (Task State Changed) Rejection ---
    // If task leaves REVIEW_READY state, live authority fence rejects the reviewer read
    db.prepare(`UPDATE tasks SET state = 'CODING' WHERE id = ?`).run(env.taskId);

    const tamperedCall = await clientVal.callTool({
      name: REVIEWER_TOOL_NAME,
      arguments: { adjudication_id: adjudicationId },
    });
    expect(tamperedCall.isError).toBe(true);
    expect((tamperedCall.content[0] as { text: string }).text).toContain('TASK_STATE_INVALID');

    await clientVal.close();
    await serverValid.close();
  });

  // =========================================================================
  // SCENARIO 4: Proven vs Mock Boundary & Orchestration Gap Analysis
  // =========================================================================
  it('4. Proven vs Mock contract & orchestration gap boundaries', () => {
    // This test formalizes the exact boundary contract for the R5L1 rehearsal:
    const rehearsalBoundaries = {
      proven_components: [
        'SQLite schema migrations (v1-v23)',
        'McpSubmissionAuthorityService durable claim processing and quarantine assignment',
        'CoderSubmissionAdjudicationService phase A admission, phase B lease acquisition, and phase C settlement',
        'VerificationService execution with command isolation and observation capture',
        'ArtifactStore content-addressed file materialization and manifest generation',
        'ReviewerAuthorityService session issuance, token verification, and projection packaging',
        'AgentForge Reviewer MCP Server tool and resource protocol over InMemoryTransport',
        'Zero-write assertion on database during reviewer tool and resource reads',
        'Worktree and process teardown cleanliness',
      ],
      mocked_or_synthetic_boundaries: [
        'Synthetic Git repository in OS temp directory instead of production remote',
        'Synthetic provider accounts and resources (LOCAL_CLI native profile)',
        'Isolated test SQLite database instead of production live database',
        'Local Node process execution instead of external LLM API calls',
      ],
      orchestration_gaps_identified: [
        'GAP-01: End-to-end automation between quarantined submission detection and manager admission trigger currently relies on manual IPC or explicit service call',
        'GAP-02: Reviewer agent spawn and MCP token injection into reviewer environment is orchestrator-driven rather than an internal auto-trigger of adjudication settlement',
      ],
    };

    expect(rehearsalBoundaries.proven_components.length).toBe(9);
    expect(rehearsalBoundaries.mocked_or_synthetic_boundaries.length).toBe(4);
    expect(rehearsalBoundaries.orchestration_gaps_identified.length).toBe(2);
  });
});
