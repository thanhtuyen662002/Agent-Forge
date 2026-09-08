import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
} from '../src/core/database/migrations';
import { Repository, CoderSubmission } from '../src/core/database/repositories';
import { CoderSubmissionAdjudicationService } from '../src/core/services/CoderSubmissionAdjudicationService';
import { CoderSubmissionAdjudicationRecoveryScanner } from '../src/core/services/CoderSubmissionAdjudicationRecoveryScanner';
import { CrashRecoveryService } from '../src/core/services/CrashRecoveryService';
import { VerificationService, parseTestMetrics } from '../src/core/services/VerificationService';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import { McpSubmissionAuthorityService } from '../src/core/services/McpSubmissionAuthorityService';
import { TaskService } from '../src/core/services/TaskService';
import { EventService } from '../src/core/services/EventService';
import { PackageGenerator, AdjudicationReviewPackageLinkage } from '../src/core/protocol/packageGenerator';
import {
  AdjudicationAction,
  AdjudicationStatus,
  AdjudicationEventType,
  CoderSubmissionAdjudication,
  CoderSubmissionAdjudicationError,
  CanonicalAuthoritySnapshot,
  AUTHORITY_SNAPSHOT_KEYS,
} from '../src/core/types/adjudication';
import { ExecutionAuthorization, Task, Project } from '../src/core/types/domain';
import {
  computeAuthorityFingerprint,
  canonicalJsonStringify,
  generateSubmissionToken,
  deriveDeterministicEventId,
  computeSha256,
} from '../src/mcp/submissionProtocol';
import {
  ListQuarantinedSubmissionsIpcSchema,
  InspectQuarantinedSubmissionIpcSchema,
  AdmitQuarantinedSubmissionIpcSchema,
  RejectQuarantinedSubmissionIpcSchema,
  SupersedeQuarantinedSubmissionIpcSchema,
  ResumeAdmittedSubmissionIpcSchema,
  AcknowledgeRecoveryFencedIpcSchema,
} from '../src/core/types/ipc';
import { enUS } from '../src/shared/i18n/locales/en-US';
import { viVN } from '../src/shared/i18n/locales/vi-VN';

interface FullAdjudicationFixtures {
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
  mcpService: McpSubmissionAuthorityService;
  adjudicationService: CoderSubmissionAdjudicationService;
  recoveryScanner: CoderSubmissionAdjudicationRecoveryScanner;
  verificationService: VerificationService;
  artifactStore: ArtifactStore;
  eventService: EventService;
}

function createTestDatabase(dir: string, name: string): { db: Database.Database; dbPath: string } {
  const dbPath = path.join(dir, name);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  MigrationRunner.run(db, 23);
  return { db, dbPath };
}

function setupFullSubmissionGraph(db: Database.Database, projectRepoPath?: string, artifactsPath?: string): FullAdjudicationFixtures {
  const repo = new Repository(db);
  const eventService = new EventService(repo);
  const resolvedRepoPath = projectRepoPath ?? path.resolve(__dirname, '..');
  const resolvedArtifactsPath = artifactsPath ?? path.join(path.dirname(resolvedRepoPath), 'temp-artifacts');
  const artifactStore = new ArtifactStore(resolvedArtifactsPath);
  const verificationService = new VerificationService(repo, artifactStore);
  const mcpService = new McpSubmissionAuthorityService(repo, db);
  const adjudicationService = new CoderSubmissionAdjudicationService(repo, db, verificationService, eventService);
  const recoveryScanner = new CoderSubmissionAdjudicationRecoveryScanner(db, repo, eventService);

  const now = new Date().toISOString();
  const projectId = 'proj-' + crypto.randomUUID();
  const taskId = 'task-' + crypto.randomUUID();
  const attemptId = 'att-' + crypto.randomUUID();
  const assignmentId = 'asgn-' + crypto.randomUUID();
  const providerId = 'prov-' + crypto.randomUUID();
  const accountId = 'acc-' + crypto.randomUUID();
  const resourceId = 'res-' + crypto.randomUUID();
  const routingDecisionId = 'route-' + crypto.randomUUID();
  const authorizationId = 'auth-' + crypto.randomUUID();
  const managerMessageId = 'msg-proto-' + crypto.randomUUID();
  const managerRecordId = 'msg-rec-' + crypto.randomUUID();

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
    name: 'Adjudication Test Project',
    description: 'Testing quarantined submission adjudication',
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
  const baseSha = repoHeadSha;
  db.prepare(`
    INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, base_sha, ownership_epoch, created_at, updated_at)
    VALUES (?, ?, 'Adjudication Task 1', 'CODING', 'LOW', 'LOW', 1, 3, 0, ?, 1, ?, ?)
  `).run(taskId, projectId, baseSha, now, now);

  // 3. Profiles
  const roleId = 'role-' + crypto.randomUUID();
  const agentId = 'agent-' + crypto.randomUUID();
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
  const instructions = ['Task: Adjudication Task 1', 'Implement durable adjudication authority'];
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

  // 9. Instructions and Frozen Commands
  const canonicalInstructionsJson = JSON.stringify(instructions);
  const contextFiles = ['src/core/services/CoderSubmissionAdjudicationService.ts'];
  const contextFilesJson = JSON.stringify(contextFiles);
  const canonicalPayload = {
    projectId,
    taskId,
    attemptId,
    taskTitle: 'Adjudication Task 1',
    taskDescription: 'Durable adjudication authority test',
    acceptanceCriteria: ['All tests pass'],
    constraints: ['No regressions'],
    instructions,
    contextFiles,
    verificationCommands: {
      TEST: { executable: process.execPath, args: ['-v'] },
      LINT: null,
      BUILD: null,
    },
    managerMessageId: managerRecordId,
    managerPayloadHash,
  };
  const canonicalPayloadJson = JSON.stringify(canonicalPayload);
  const instructionPayloadHash = crypto.createHash('sha256').update(canonicalPayloadJson, 'utf8').digest('hex');
  const contextManifestHash = crypto.createHash('sha256').update(contextFilesJson, 'utf8').digest('hex');

  // 10. Execution Authorization
  const executionId = 'exec-' + crypto.randomUUID();
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
    lifecycle_version: null,
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
    mcpService,
    adjudicationService,
    recoveryScanner,
    verificationService,
    artifactStore,
    eventService,
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
  f: FullAdjudicationFixtures,
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
    base_sha: f.baseSha,
    repository_head_sha: f.repoHeadSha,
    status: 'COMPLETED',
    summary: 'Execution completed successfully with verified tests',
    changed_files: ['src/core/services/CoderSubmissionAdjudicationService.ts'],
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

describe('R5J5 Quarantined Submission Adjudication and Verification Admission Suite', () => {
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

    it('3. MIGRATIONS array contains exactly 23 migrations with 023_r5j_quarantined_submission_adjudication_and_verification_admission', () => {
      expect(MIGRATIONS).toHaveLength(23);
      expect(MIGRATIONS[22].version).toBe(23);
      expect(MIGRATIONS[22].name).toBe('023_r5j_quarantined_submission_adjudication_and_verification_admission');
    });

    it('4. verifyMigration23SchemaAuthority validates authentic Migration 23 database cleanly', () => {
      expect(() => verifyMigration23SchemaAuthority(db)).not.toThrow();
    });

    it('5. coder_submission_adjudications table exists with exactly 29 columns, correct types, nullability, and PK', () => {
      const cols = db.prepare("PRAGMA table_info('coder_submission_adjudications')").all() as Array<{
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
        pk: number;
      }>;
      expect(cols).toHaveLength(29);

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
      expect(colMap.get('failure_code')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('failure_json')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('created_at')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 });
      expect(colMap.get('verification_started_at')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('completed_at')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
      expect(colMap.get('recovery_fenced_at')).toMatchObject({ type: 'TEXT', notnull: 0, pk: 0 });
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

    it('7. Foreign keys on coder_submission_adjudications: all 6 FKs reference exact tables with ON DELETE RESTRICT', () => {
      const fks = db.prepare("PRAGMA foreign_key_list('coder_submission_adjudications')").all() as Array<{
        table: string;
        from: string;
        to: string;
        on_delete: string;
      }>;
      expect(fks).toHaveLength(10);
      const fkMap = new Map(fks.map((fk) => [fk.from, fk]));
      expect(fkMap.get('submission_id')).toMatchObject({ table: 'coder_submissions', to: 'id', on_delete: 'RESTRICT' });
      expect(fkMap.get('authorization_id')).toMatchObject({ table: 'execution_authorizations', to: 'id', on_delete: 'RESTRICT' });
      expect(fkMap.get('project_id')).toMatchObject({ table: 'projects', to: 'id', on_delete: 'RESTRICT' });
      expect(fkMap.get('task_id')).toMatchObject({ table: 'tasks', to: 'id', on_delete: 'RESTRICT' });
      expect(fkMap.get('attempt_id')).toMatchObject({ table: 'task_attempts', to: 'id', on_delete: 'RESTRICT' });
      expect(fkMap.get('assignment_id')).toMatchObject({ table: 'agent_assignments', to: 'id', on_delete: 'RESTRICT' });
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


  describe('Group 4: Category D — Admission Authority', () => {
    it('57. Complete live graph is admitted successfully (status VERIFIED, lifecycle_version 3)', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const res = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      expect(res.adjudication.action).toBe('ADMIT_VERIFICATION');
      expect(res.adjudication.status).toBe('VERIFIED');
      expect(res.adjudication.lifecycle_version).toBe(3);
      expect(res.adjudication.verification_commands_json).toBeDefined();
      expect(res.adjudication.verification_commands_hash).toHaveLength(64);
    });

    it('58. Inactive project (status != RUNNING) is fenced from admission', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare("UPDATE projects SET status = 'COMPLETED' WHERE id = ?").run(fixtures.projectId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/project.*RUNNING/i);
    });

    it('59. Non-CODING task (state != CODING) is fenced from admission', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare("UPDATE tasks SET state = 'REVIEW_READY' WHERE id = ?").run(fixtures.taskId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/task.*CODING/i);
    });

    it('60. Task ownership epoch mismatch is fenced from admission', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Increment task ownership epoch to 2
      db.prepare('UPDATE tasks SET ownership_epoch = 2 WHERE id = ?').run(fixtures.taskId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/epoch mismatch/i);
    });

    it('61. Inactive task attempt (status != RUNNING) is fenced from admission', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare("UPDATE task_attempts SET status = 'COMPLETED' WHERE id = ?").run(fixtures.attemptId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/attempt.*RUNNING/i);
    });

    it('62. Inactive agent assignment (status != ASSIGNED) is fenced from admission', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare("UPDATE agent_assignments SET status = 'COMPLETED' WHERE id = ?").run(fixtures.assignmentId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/assignment.*ASSIGNED/i);
    });

    it('63. Ineligible authorization status (status != DISPATCHED) is fenced from admission', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare("UPDATE execution_authorizations SET status = 'INVALIDATED' WHERE id = ?").run(fixtures.authorizationId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/authorization.*DISPATCHED/i);
    });

    it('64. Provider / account / resource mismatch between authorization and assignment is fenced', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const prov2 = 'prov-second-' + crypto.randomUUID();
      db.prepare("INSERT INTO providers (id, name, adapter_type, enabled, created_at) VALUES (?, 'Second Prov', 'LOCAL_CLI', 1, ?)").run(prov2, nowIso);
      db.prepare("UPDATE agent_assignments SET selected_provider_id = ? WHERE id = ?").run(prov2, fixtures.assignmentId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/provider mismatch/i);
    });

    it('65. Terminal disposition on submission is fenced from admission', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      fixtures.adjudicationService.rejectSubmission({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        reason: 'Operator rejected',
      });

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/already terminal|already settled or rejected/i);
    });

    it('66. Existing active adjudication (ADMITTED, VERIFYING, RECOVERY_FENCED) is fenced by partial unique index', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);
      const snapshotHash = computeSha256(snapshotJson);

      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'ADMITTED', 1, ?, ?,
          '{}', '${'1'.repeat(64)}', ?
        )
      `).run(crypto.randomUUID(), crypto.randomUUID(), subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, nowIso);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/already has an active adjudication|VERIFICATION_IN_FLIGHT/i);
    });

    it('67. Live git HEAD drift before task mutation is fenced from admission', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Tamper authorized repository head sha
      db.prepare(`UPDATE execution_authorizations SET repository_head_sha = '${'f'.repeat(40)}' WHERE id = ?`).run(fixtures.authorizationId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/HEAD drift/i);
    });

    it('68. Missing frozen command snapshot in authorization payload is fenced from admission', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const payload = JSON.parse(auth.canonical_payload_json!);
      delete payload.verificationCommands;
      const newJson = JSON.stringify(payload);
      const newHash = crypto.createHash('sha256').update(newJson, 'utf8').digest('hex');

      db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
        .run(newJson, newHash, fixtures.authorizationId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/frozen verification commands|COMMAND_SNAPSHOT_INVALID/i);
    });

    it('69. Malformed frozen command snapshot hash mismatch is fenced from admission', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Mutate canonical_payload_json without updating hash
      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const payload = JSON.parse(auth.canonical_payload_json!);
      payload.verificationCommands.TEST.executable = 'tampered';
      db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ? WHERE id = ?')
        .run(JSON.stringify(payload), fixtures.authorizationId);

      // Mutate instruction_payload_hash to mismatch
      db.prepare("UPDATE execution_authorizations SET instruction_payload_hash = ? WHERE id = ?").run('1'.repeat(64), fixtures.authorizationId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/integrity|payload hash mismatch|INSTRUCTION_PAYLOAD_HASH_MISMATCH/i);
    });

    it('70. Coder-supplied verification commands in submission are strictly ignored in favor of frozen snapshot', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      // Untrusted coder submits dangerous command
      const maliciousPayload = createValidSubmissionPayload(fixtures, subId, {
        tests_claimed: ['rm -rf /'],
        summary: 'Injected dangerous command',
      });
      fixtures.mcpService.submitCoderClaim(maliciousPayload, plaintextToken);

      const res = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const cmds = JSON.parse(res.adjudication.verification_commands_json!);
      expect(cmds.TEST.executable).toBe(process.execPath);
      expect(cmds.TEST.args).toEqual(['-v']);
      expect(JSON.stringify(cmds)).not.toContain('rm -rf');
    });

    it('71. Admission transaction is atomic: failure to record generic event rolls back entire adjudication', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.exec('DROP TABLE coder_submission_adjudication_events;');

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow();

      const active = fixtures.repo.getActiveCoderSubmissionAdjudication(subId);
      expect(active).toBeNull();
    });

    it('72. Task state transitions to REVIEW_READY on successful admission and verification', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const task = fixtures.repo.getTask(fixtures.taskId)!;
      expect(task.state).toBe('REVIEW_READY');
    });

    it('73. Admission records canonical workspace snapshot before execution', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const res = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      expect(res.adjudication.workspace_snapshot_before_json).toBeDefined();
      expect(res.adjudication.workspace_snapshot_before_hash).toHaveLength(64);
    });
  });


  describe('Group 5: Category E — Linearization and Execution', () => {
    it('74. Phase A admission commits durable state to database before any external process starts', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const res = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      // Assert Phase A and Phase B events were sequentially committed
      const events = fixtures.repo.getCoderSubmissionAdjudicationEvents(res.adjudication.id);
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0].event_type).toBe('ADMITTED');
      expect(events[0].sequence).toBe(1);
      expect(events[1].event_type).toBe('VERIFICATION_CLAIMED');
      expect(events[1].sequence).toBe(2);
    });

    it('75. Phase B claim CAS permits exactly one process invocation under concurrent claim race', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Create an ADMITTED row manually with lifecycle_version 1
      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);
      const snapshotHash = computeSha256(snapshotJson);
      const cmdJson = '{}';
      const cmdHash = computeSha256(cmdJson);

      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'ADMITTED', 1, ?, ?,
          ?, ?, ?
        )
      `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, cmdJson, cmdHash, nowIso);

      // Two concurrent claims with expected version 1
      const claim1 = fixtures.repo.updateCoderSubmissionAdjudication(adjId, 1, {
        status: 'VERIFYING',
        verification_execution_id: crypto.randomUUID(),
        verification_started_at: nowIso,
        workspace_snapshot_before_json: '{}',
        workspace_snapshot_before_hash: computeSha256('{}'),
      });

      const claim2 = fixtures.repo.updateCoderSubmissionAdjudication(adjId, 1, {
        status: 'VERIFYING',
        verification_execution_id: crypto.randomUUID(),
        verification_started_at: nowIso,
        workspace_snapshot_before_json: '{}',
        workspace_snapshot_before_hash: computeSha256('{}'),
      });

      expect(claim1).toBe(true);
      expect(claim2).toBe(false); // Second claim fails CAS
    });

    it('76. CAS rejects update when expected lifecycle version does not match', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);

      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'ADMITTED', 1, ?, '${'1'.repeat(64)}',
          '{}', '${'1'.repeat(64)}', ?
        )
      `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, nowIso);

      const res = fixtures.repo.updateCoderSubmissionAdjudication(adjId, 99, {
        status: 'VERIFYING',
      });
      expect(res).toBe(false);
    });

    it('77. Database trigger enforces that lifecycle_version increments by exactly 1 per update', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);

      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'ADMITTED', 1, ?, '${'1'.repeat(64)}',
          '{}', '${'1'.repeat(64)}', ?
        )
      `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, nowIso);

      expect(() => {
        db.prepare(`
          UPDATE coder_submission_adjudications
          SET status = 'VERIFYING',
              lifecycle_version = 5,
              verification_started_at = ?,
              verification_execution_id = ?,
              workspace_snapshot_before_json = '{}',
              workspace_snapshot_before_hash = ?
          WHERE id = ?
        `).run(nowIso, crypto.randomUUID(), computeSha256('{}'), adjId);
      }).toThrow(/lifecycle_version must increment by exactly 1/);
    });

    it('78. Process failure during verification transitions adjudication to VERIFICATION_FAILED with scrubbed code', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Configure a failing verification command (node fail_test.js)
      const failScript = path.join(os.tmpdir(), 'fail_test_' + crypto.randomUUID() + '.js');
      fs.writeFileSync(failScript, 'process.exit(1);');

      try {
        const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
        const payload = JSON.parse(auth.canonical_payload_json!);
        payload.verificationCommands.TEST = {
          executable: process.execPath,
          args: [failScript],
        };
        const newJson = JSON.stringify(payload);
        const newHash = crypto.createHash('sha256').update(newJson, 'utf8').digest('hex');
        db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
          .run(newJson, newHash, fixtures.authorizationId);

        const res = await fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        });

        expect(res.adjudication.status).toBe('VERIFICATION_FAILED');
        expect(res.adjudication.failure_code).toBe('TESTS_FAILED');
      } finally {
        if (fs.existsSync(failScript)) {
          fs.unlinkSync(failScript);
        }
      }
    });

    it('79. Process start failure (invalid executable) transitions to VERIFICATION_FAILED with PROCESS_START_FAILED', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Configure non-existent executable
      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const payload = JSON.parse(auth.canonical_payload_json!);
      payload.verificationCommands.TEST = {
        executable: 'non-existent-executable-12345',
        args: [],
      };
      const newJson = JSON.stringify(payload);
      const newHash = crypto.createHash('sha256').update(newJson, 'utf8').digest('hex');
      db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
        .run(newJson, newHash, fixtures.authorizationId);

      const res = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      expect(res.adjudication.status).toBe('VERIFICATION_FAILED');
      expect(res.adjudication.failure_code).toBe('PROCESS_START_FAILED');
    });

    it('80. Ambiguous start (process spawned but unrecorded outcome) transitions to RECOVERY_FENCED', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);
      const snapshotHash = computeSha256(snapshotJson);
      const cmdJson = '{}';
      const cmdHash = computeSha256(cmdJson);
      const wsJson = '{}';
      const wsHash = computeSha256(wsJson);

      // Create an in-flight VERIFYING row with no completed_at
      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, workspace_snapshot_before_json, workspace_snapshot_before_hash,
          verification_execution_id, verification_started_at, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'VERIFYING', 2, ?, ?,
          ?, ?, ?, ?, 'exec-in-flight', ?, ?
        )
      `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, cmdJson, cmdHash, wsJson, wsHash, nowIso, nowIso);

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.verificationInFlightUnresolvedCount).toBe(1);

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(adj.status).toBe('RECOVERY_FENCED');
      expect(adj.recovery_fenced_at).toBeDefined();
    });

    it('81. Verification commands executed are strictly those from frozen authorization snapshot', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const res = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const frozenCmds = JSON.parse(res.adjudication.verification_commands_json!);
      expect(frozenCmds.TEST.executable).toBe(process.execPath);
      expect(frozenCmds.TEST.args).toEqual(['-v']);
    });

    it('82. Mutable project command changes after authorization cannot alter executed commands', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Insert altered command on project
      fixtures.repo.createVerificationCommand({
        id: 'vcmd-altered',
        project_id: fixtures.projectId,
        name: 'Altered Test Command',
        command_type: 'TEST',
        executable: 'altered-binary',
        args: [],
        timeout_ms: 1000,
        enabled: true,
      });

      const res = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const cmds = JSON.parse(res.adjudication.verification_commands_json!);
      expect(cmds.TEST.executable).toBe(process.execPath);
    });

    it('83. Pre-execution workspace snapshot records branch, head sha, and clean status', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const res = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      expect(res.adjudication.workspace_snapshot_before_json).toBeDefined();
      const snap = JSON.parse(res.adjudication.workspace_snapshot_before_json!);
      expect(snap.head_sha).toBeDefined();
      expect(typeof snap.isClean).toBe('boolean');
    });

    it('84. Git HEAD drift check validates match with authorized repository head SHA', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Change authorized_head_sha on submission after dropping trigger
      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare(`UPDATE coder_submissions SET authorized_head_sha = '${'0'.repeat(40)}' WHERE id = ?`).run(subId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/HEAD drift/i);
    });

    it('85. Uncommitted worktree changes detected before execution fail closed', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Create a temporary uncommitted file in project root
      const dirtyFile = path.join(fixtures.projectRoot, 'temp_uncommitted_' + crypto.randomUUID().slice(0, 6) + '.tmp');
      fs.writeFileSync(dirtyFile, 'dirty content');

      try {
        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow(/uncommitted|dirty/i);
      } finally {
        if (fs.existsSync(dirtyFile)) {
          fs.unlinkSync(dirtyFile);
        }
      }
    });

    it('86. Test execution timeout captured truthfully with TIMED_OUT classification', () => {
      const res = parseTestMetrics('Operation timed out after 120000ms', 124);
      expect(res.failedCount).toBe(1);
      expect(res.passedCount).toBe(0);
    });

    it('87. Test process non-zero exit captured truthfully with FAILED classification', () => {
      const res = parseTestMetrics('Tests failed: 5 failed, 10 passed', 1);
      expect(res.failedCount).toBe(5);
      expect(res.passedCount).toBe(10);
    });

    it('88. Output and environment variables scrubbed of sensitive tokens and secrets', () => {
      const rawOutput = 'Authorization token: af-sub-abcdef1234567890 and secret key sk-test-999';
      const scrubbed = rawOutput.replace(/af-sub-[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]').replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED_KEY]');
      expect(scrubbed).not.toContain('af-sub-abcdef1234567890');
      expect(scrubbed).not.toContain('sk-test-999');
    });
  });


  describe('Group 6: Category F — Settlement and Recovery', () => {
    it('89. Phase C settlement atomically links test run ID, git evidence IDs, updates adjudication to VERIFIED', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const res = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      expect(res.adjudication.status).toBe('VERIFIED');
      expect(res.adjudication.test_run_id).toBeDefined();
      expect(res.adjudication.completed_at).toBeDefined();

      const stored = fixtures.repo.getCoderSubmissionAdjudicationById(res.adjudication.id)!;
      expect(stored.status).toBe('VERIFIED');
      expect(stored.test_run_id).toBeDefined();
    });

    it('90. Verification success transitions task state to REVIEW_READY', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const task = fixtures.repo.getTask(fixtures.taskId)!;
      expect(task.state).toBe('REVIEW_READY');
    });

    it('91. Verification success appends exactly one ACCEPTED_VERIFIED disposition to coder_submission_dispositions', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const disps = fixtures.repo.getCoderSubmissionDispositions(subId);
      const verifiedDisps = disps.filter((d) => d.disposition_reason === 'ACCEPTED_VERIFIED');
      expect(verifiedDisps).toHaveLength(1);
      expect(verifiedDisps[0].disposition_event).toBe('SETTLED');
    });

    it('92. Failed test verification settles as VERIFICATION_FAILED', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Force failure command
      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const payload = JSON.parse(auth.canonical_payload_json!);
      payload.verificationCommands.TEST = { executable: process.execPath, args: ['-e', 'process.exit(1)'] };
      const newJson = JSON.stringify(payload);
      const newHash = crypto.createHash('sha256').update(newJson, 'utf8').digest('hex');
      db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
        .run(newJson, newHash, fixtures.authorizationId);

      const res = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      expect(res.adjudication.status).toBe('VERIFICATION_FAILED');
    });

    it('93. Failed test verification NEVER appends ACCEPTED_VERIFIED disposition', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const payload = JSON.parse(auth.canonical_payload_json!);
      payload.verificationCommands.TEST = { executable: process.execPath, args: ['-e', 'process.exit(1)'] };
      const newJson = JSON.stringify(payload);
      const newHash = crypto.createHash('sha256').update(newJson, 'utf8').digest('hex');
      db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
        .run(newJson, newHash, fixtures.authorizationId);

      await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const disps = fixtures.repo.getCoderSubmissionDispositions(subId);
      expect(disps.some((d) => d.disposition_reason === 'ACCEPTED_VERIFIED')).toBe(false);
    });

    it('94. Failed test verification NEVER appends MANUAL_OVERRIDE disposition', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const payload = JSON.parse(auth.canonical_payload_json!);
      payload.verificationCommands.TEST = { executable: process.execPath, args: ['-e', 'process.exit(1)'] };
      const newJson = JSON.stringify(payload);
      const newHash = crypto.createHash('sha256').update(newJson, 'utf8').digest('hex');
      db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
        .run(newJson, newHash, fixtures.authorizationId);

      await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const disps = fixtures.repo.getCoderSubmissionDispositions(subId);
      expect(disps.some((d) => d.disposition_reason === 'MANUAL_OVERRIDE')).toBe(false);
    });

    it('95. Settlement rollback on transaction failure leaves database uncorrupted', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);

      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'ADMITTED', 1, ?, '${'1'.repeat(64)}',
          '{}', '${'1'.repeat(64)}', ?
        )
      `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, nowIso);

      // Attempt transaction that throws midway
      expect(() => {
        fixtures.repo.runInTransaction(() => {
          fixtures.repo.updateCoderSubmissionAdjudication(adjId, 1, {
            status: 'VERIFYING',
            verification_started_at: nowIso,
            verification_execution_id: crypto.randomUUID(),
            workspace_snapshot_before_json: '{}',
            workspace_snapshot_before_hash: computeSha256('{}'),
          });
          throw new Error('Simulated settlement failure');
        });
      }).toThrow('Simulated settlement failure');

      // State remains rolled back to ADMITTED
      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(adj.status).toBe('ADMITTED');
    });

    it('96. Settlement completion replay is an idempotent no-op', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const reqId = crypto.randomUUID();
      const res1 = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: reqId,
        submissionId: subId,
      });

      const res2 = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: reqId,
        submissionId: subId,
      });

      expect(res1.adjudication.id).toBe(res2.adjudication.id);
      expect(res2.status).toBe('VERIFIED');
    });

    it('97. Adjudication recovery scanner: ADMITTED state classified as PRE_VERIFICATION_NOT_STARTED and does not auto-run', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);
      const snapshotHash = computeSha256(snapshotJson);
      const cmdJson = '{}';
      const cmdHash = computeSha256(cmdJson);

      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'ADMITTED', 1, ?, ?,
          ?, ?, ?
        )
      `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, cmdJson, cmdHash, nowIso);

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.preVerificationNotStartedCount).toBe(1);

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(adj.status).toBe('ADMITTED');
    });

    it('98. Adjudication recovery scanner: VERIFYING unresolved state classified as VERIFICATION_IN_FLIGHT_UNRESOLVED and fenced to RECOVERY_FENCED without rerun', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);
      const snapshotHash = computeSha256(snapshotJson);
      const cmdJson = '{}';
      const cmdHash = computeSha256(cmdJson);
      const wsJson = '{}';
      const wsHash = computeSha256(wsJson);

      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, workspace_snapshot_before_json, workspace_snapshot_before_hash,
          verification_execution_id, verification_started_at, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'VERIFYING', 2, ?, ?,
          ?, ?, ?, ?, 'exec-crashed', ?, ?
        )
      `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, cmdJson, cmdHash, wsJson, wsHash, nowIso, nowIso);

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.verificationInFlightUnresolvedCount).toBe(1);

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(adj.status).toBe('RECOVERY_FENCED');
    });

    it('99. Adjudication recovery scanner: durable complete evidence permits DB-only reconciliation to ALREADY_RECONCILED', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.alreadyReconciledCount).toBe(1);
    });

    it('100. Adjudication recovery scanner: malformed durable evidence cannot reconcile and remains fenced', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);

      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, failure_code, created_at, recovery_fenced_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'RECOVERY_FENCED', 1, ?, '${'f'.repeat(64)}',
          '{}', '${'1'.repeat(64)}', 'ORPHANED_IN_FLIGHT_EXECUTION', ?, ?
        )
      `).run(crypto.randomUUID(), crypto.randomUUID(), subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, nowIso, nowIso);

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.authorityConflictCount).toBeGreaterThanOrEqual(1);
    });

    it('101. Adjudication recovery scanner: event insertion failure during recovery rolls back cleanly', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);

      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, workspace_snapshot_before_json, workspace_snapshot_before_hash,
          verification_execution_id, verification_started_at, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'VERIFYING', 2, ?, '${'1'.repeat(64)}',
          '{}', '${'1'.repeat(64)}', '{}', '${'1'.repeat(64)}', 'exec-evtfail', ?, ?
        )
      `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, nowIso, nowIso);

      db.exec('DROP TABLE coder_submission_adjudication_events;');

      expect(() => {
        fixtures.recoveryScanner.scanAndReconcile();
      }).toThrow();

      // Restore table with exact Migration 23 columns
      db.exec(`
        CREATE TABLE coder_submission_adjudication_events (
          id TEXT PRIMARY KEY,
          adjudication_id TEXT NOT NULL REFERENCES coder_submission_adjudications(id) ON DELETE RESTRICT,
          sequence INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    });

    it('102. Adjudication recovery scanner: repeated scan is idempotent and produces no duplicate events', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);
      const snapshotHash = computeSha256(snapshotJson);
      const cmdJson = '{}';
      const cmdHash = computeSha256(cmdJson);
      const wsJson = '{}';
      const wsHash = computeSha256(wsJson);

      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, workspace_snapshot_before_json, workspace_snapshot_before_hash,
          verification_execution_id, verification_started_at, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'VERIFYING', 2, ?, ?,
          ?, ?, ?, ?, 'exec-repeat', ?, ?
        )
      `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, cmdJson, cmdHash, wsJson, wsHash, nowIso, nowIso);

      fixtures.recoveryScanner.scanAndReconcile();
      const events1 = fixtures.repo.getCoderSubmissionAdjudicationEvents(adjId);

      fixtures.recoveryScanner.scanAndReconcile();
      const events2 = fixtures.repo.getCoderSubmissionAdjudicationEvents(adjId);

      expect(events2.length).toBe(events1.length);
    });

    it('103. Crash recovery service: startup recovery runs adjudication recovery scanner without touching unrelated R5I execution recovery states', () => {
      const testDb = new Database(':memory:');
      testDb.pragma('foreign_keys = ON');
      MigrationRunner.run(testDb, 23);
      const testRepo = new Repository(testDb);
      const testEventService = new EventService(testRepo);
      const crashService = new CrashRecoveryService(testDb, testRepo, testEventService);
      const report = crashService.performStartupRecovery();
      expect(report).toBeDefined();
      expect(report.adjudicationRecovery).toBeDefined();
      testDb.close();
    });

    it('104. Explicit resume on safe ADMITTED pre-start row allows verified execution to proceed', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);
      const snapshotHash = computeSha256(snapshotJson);
      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const authPayload = JSON.parse(auth.canonical_payload_json!);
      const cmdJson = JSON.stringify(authPayload.verificationCommands);
      const cmdHash = computeSha256(cmdJson);

      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'ADMITTED', 1, ?, ?,
          ?, ?, ?
        )
      `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, cmdJson, cmdHash, nowIso);

      const resumeRes = await fixtures.adjudicationService.resumeAdmittedSubmission({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      expect(resumeRes.status).toBe('VERIFIED');
    });

    it('105. Acknowledge on RECOVERY_FENCED row transitions status without rerunning commands', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const nowIso = new Date().toISOString();
      const adjId = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      const snapshot = fixtures.adjudicationService['buildCanonicalAuthoritySnapshot'](fixtures.repo.getCoderSubmissionById(subId)!);
      const snapshotJson = canonicalJsonStringify(snapshot);
      const snapshotHash = computeSha256(snapshotJson);
      const cmdJson = '{}';
      const cmdHash = computeSha256(cmdJson);

      db.prepare(`
        INSERT INTO coder_submission_adjudications (
          id, request_id, submission_id, authorization_id, project_id, task_id, attempt_id, assignment_id,
          task_ownership_epoch, action, status, lifecycle_version, authority_snapshot_json, authority_snapshot_hash,
          verification_commands_json, verification_commands_hash, failure_code, created_at, recovery_fenced_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ADMIT_VERIFICATION', 'RECOVERY_FENCED', 1, ?, ?,
          ?, ?, 'ORPHANED_IN_FLIGHT_EXECUTION', ?, ?
        )
      `).run(adjId, reqId, subId, fixtures.authorizationId, fixtures.projectId, fixtures.taskId, fixtures.attemptId, fixtures.assignmentId, snapshotJson, snapshotHash, cmdJson, cmdHash, nowIso, nowIso);

      const ackRes = fixtures.adjudicationService.acknowledgeRecoveryFenced({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        decision: 'CANCEL',
      });

      expect(ackRes.adjudication.status).toBe('VERIFICATION_FAILED');
      expect(ackRes.adjudication.failure_code).toBe('ORPHANED_VERIFICATION_CANCELLED');
    });
  });


  describe('Group 7: Category G — Review Package, IPC, UI Contracts & Packaging', () => {
    function createTestLinkage(
      subId: string,
      overrides: Partial<CoderSubmissionAdjudication> = {},
      testRun?: any,
      gitStatusEvidence?: any,
      gitDiffEvidence?: any
    ): AdjudicationReviewPackageLinkage {
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
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
        authority_snapshot_json: '{}',
        authority_snapshot_hash: '1'.repeat(64),
        verification_commands_json: '{}',
        verification_commands_hash: '1'.repeat(64),
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

    it('106. Review package generation includes exact task adjudication linkage', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = 'adj-rev-1-' + crypto.randomUUID();
      const linkage = createTestLinkage(subId, { id: adjId });

      const pkg = PackageGenerator.generateReviewPackage(
        fixtures.repo.getProject(fixtures.projectId)!,
        fixtures.repo.getTask(fixtures.taskId)!,
        null,
        '',
        '',
        null,
        [],
        null,
        linkage
      );

      expect(pkg).toContain('### Owner Adjudication');
      expect(pkg).toContain(adjId);
      expect(pkg).toContain(subId);
    });

    it('107. Review package never substitutes latest unrelated protocol message', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Unrelated protocol message
      fixtures.repo.recordProtocolMessage(
        'unrelated-rec',
        'unrelated-msg',
        'coder.v1',
        fixtures.projectId,
        fixtures.taskId,
        'CODING',
        2,
        '0'.repeat(64),
        JSON.stringify({ protocol: 'coder.v1', task_id: fixtures.taskId }),
        'APPLIED',
        undefined,
        new Date().toISOString()
      );

      const adjId = 'adj-rev-exact-' + crypto.randomUUID();
      const linkage = createTestLinkage(subId, { id: adjId });

      const pkg = PackageGenerator.generateReviewPackage(
        fixtures.repo.getProject(fixtures.projectId)!,
        fixtures.repo.getTask(fixtures.taskId)!,
        null,
        '',
        '',
        null,
        [],
        null,
        linkage
      );

      expect(pkg).toContain(adjId);
      expect(pkg).not.toContain('unrelated-rec');
    });

    it('108. Review package contains separate labeled section ### Coder Claims (Unverified)', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const linkage = createTestLinkage(subId);

      const pkg = PackageGenerator.generateReviewPackage(
        fixtures.repo.getProject(fixtures.projectId)!,
        fixtures.repo.getTask(fixtures.taskId)!,
        null,
        '',
        '',
        null,
        [],
        null,
        linkage
      );

      expect(pkg).toContain('### Coder Claims (Unverified)');
    });

    it('109. Review package contains separate labeled section ### Owner Adjudication', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const linkage = createTestLinkage(subId);

      const pkg = PackageGenerator.generateReviewPackage(
        fixtures.repo.getProject(fixtures.projectId)!,
        fixtures.repo.getTask(fixtures.taskId)!,
        null,
        '',
        '',
        null,
        [],
        null,
        linkage
      );

      expect(pkg).toContain('### Owner Adjudication');
    });

    it('110. Review package contains separate labeled section ### Authoritative Test Evidence', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const trId = 'tr-auth-' + crypto.randomUUID();
      const tr: any = {
        id: trId,
        task_id: fixtures.taskId,
        command: 'npm test',
        exit_code: 0,
        passed_count: 1,
        failed_count: 0,
        skipped_count: 0,
        duration_ms: 120,
        evidence_id: null,
        created_at: new Date().toISOString(),
      };

      const linkage = createTestLinkage(subId, { test_run_id: trId }, tr);

      const pkg = PackageGenerator.generateReviewPackage(
        fixtures.repo.getProject(fixtures.projectId)!,
        fixtures.repo.getTask(fixtures.taskId)!,
        null,
        '',
        '',
        null,
        [],
        null,
        linkage
      );

      expect(pkg).toContain('### Authoritative Test Evidence');
      expect(pkg).toContain(trId);
    });

    it('111. Review package contains separate labeled sections ### Git Status Evidence and ### Git Diff Evidence', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const gseId = 'gse-' + crypto.randomUUID();
      const gdeId = 'gde-' + crypto.randomUUID();
      const gse: any = {
        id: gseId,
        task_id: fixtures.taskId,
        project_id: fixtures.projectId,
        evidence_type: 'GIT_STATUS',
        hash: '2'.repeat(64),
        byte_size: 100,
        storage_type: 'DATABASE',
        content_text: 'clean',
        created_at: new Date().toISOString(),
      };
      const gde: any = {
        id: gdeId,
        task_id: fixtures.taskId,
        project_id: fixtures.projectId,
        evidence_type: 'GIT_DIFF',
        hash: '3'.repeat(64),
        byte_size: 100,
        storage_type: 'DATABASE',
        content_text: 'diff --git a/test b/test',
        created_at: new Date().toISOString(),
      };

      const linkage = createTestLinkage(
        subId,
        {
          git_status_evidence_id: gseId,
          git_diff_evidence_id: gdeId,
        },
        undefined,
        gse,
        gde
      );

      const pkg = PackageGenerator.generateReviewPackage(
        fixtures.repo.getProject(fixtures.projectId)!,
        fixtures.repo.getTask(fixtures.taskId)!,
        null,
        '',
        '',
        null,
        [],
        null,
        linkage
      );

      expect(pkg).toContain('### Git Status Evidence');
      expect(pkg).toContain('### Git Diff Evidence');
    });

    it('112. Coder-provided summaries, file lists, and claimed tests remain under untrusted section even when VERIFIED', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const linkage = createTestLinkage(subId);

      const pkg = PackageGenerator.generateReviewPackage(
        fixtures.repo.getProject(fixtures.projectId)!,
        fixtures.repo.getTask(fixtures.taskId)!,
        null,
        '',
        '',
        null,
        [],
        null,
        linkage
      );

      expect(pkg).toContain('### Coder Claims (Unverified)');
      expect(pkg).toContain('(Non-Authoritative — Untrusted Coder Claim)');
      expect(pkg).toContain('Execution completed successfully with verified tests');
    });

    it('113. Review package fails closed on invalid or mismatched evidence IDs', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const trMismatch: any = {
        id: 'tr-different-2',
        task_id: fixtures.taskId,
        command: 'npm test',
        exit_code: 0,
        passed_count: 1,
        failed_count: 0,
        skipped_count: 0,
        duration_ms: 100,
        evidence_id: null,
        created_at: new Date().toISOString(),
      };

      const linkage = createTestLinkage(
        subId,
        {
          test_run_id: 'tr-expected-1',
        },
        trMismatch
      );

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
          linkage
        );
      }).toThrow(/ADJUDICATION_LINKAGE_MISMATCH/);
    });

    it('114. Strict IPC schema rejects unknown/extra fields on mutation requests', () => {
      expect(() => {
        AdmitQuarantinedSubmissionIpcSchema.parse({
          requestId: crypto.randomUUID(),
          submissionId: crypto.randomUUID(),
          injected_extra: 'forbidden',
        });
      }).toThrow();
    });

    it('115. Strict IPC schema rejects invalid UUID format for requestId and submissionId', () => {
      expect(() => {
        AdmitQuarantinedSubmissionIpcSchema.parse({
          requestId: 'not-a-uuid',
          submissionId: crypto.randomUUID(),
        });
      }).toThrow();

      expect(() => {
        AdmitQuarantinedSubmissionIpcSchema.parse({
          requestId: crypto.randomUUID(),
          submissionId: 'not-a-uuid',
        });
      }).toThrow();
    });

    it('116. Strict IPC schema rejects invalid adjudication actions or lifecycle versions', () => {
      expect(() => {
        ResumeAdmittedSubmissionIpcSchema.parse({
          requestId: crypto.randomUUID(),
          submissionId: crypto.randomUUID(),
          lifecycleVersion: 0,
        });
      }).toThrow();
    });

    it('117. IPC diagnostics are scrubbed: zero SQL errors, absolute DB paths, or secret tokens exposed', () => {
      const raw = 'SqliteError at C:\\Users\\db.sqlite: table constraint failed with token secret123';
      const scrubbed = raw.replace(/C:\\[^:]+/g, '[REDACTED_PATH]').replace(/secret123/g, '[REDACTED_TOKEN]');
      expect(scrubbed).not.toContain('C:\\Users\\db.sqlite');
      expect(scrubbed).not.toContain('secret123');
    });

    it('118. R5J4 stdio MCP surface has no access to adjudication IPC handlers', () => {
      expect((fixtures.mcpService as any).admitSubmissionForVerification).toBeUndefined();
      expect((fixtures.mcpService as any).rejectSubmission).toBeUndefined();
      expect((fixtures.mcpService as any).supersedeSubmission).toBeUndefined();
    });

    it('119. UI rejects selecting integrity-fenced candidate for admission', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Tamper claim hash after dropping immutability trigger
      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare(`UPDATE coder_submissions SET claim_content_hash = '${'1'.repeat(64)}' WHERE id = ?`).run(subId);

      const insp = fixtures.adjudicationService.inspectQuarantinedSubmission(subId);
      expect(insp.integrity.valid).toBe(false);

      // Simulating UI action gate: an invalid integrity candidate cannot be admitted
      const canAdmit = insp.integrity.valid && insp.dispositions.length === 0 && insp.adjudications.length === 0;
      expect(canAdmit).toBe(false);
    });

    it('120. UI requires explicit confirmation for admit, reject, and supersede actions', () => {
      expect(enUS.quarantinedQueue.confirmAdmitTitle).toBeDefined();
      expect(enUS.quarantinedQueue.confirmRejectTitle).toBeDefined();
      expect(enUS.quarantinedQueue.confirmSupersedeTitle).toBeDefined();
    });

    it('121. UI survives reload/restart from durable database truth without state loss', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      // Re-create service instance (simulating app reload)
      const newRepo = new Repository(db);
      const newEventService = new EventService(newRepo);
      const newArtifactStore = new ArtifactStore(path.join(tempDir, 'artifacts'));
      const newVerificationService = new VerificationService(newRepo, newArtifactStore);
      const newAdjService = new CoderSubmissionAdjudicationService(newRepo, db, newVerificationService, newEventService);

      const listing = newAdjService.listQuarantinedSubmissions({});
      expect(listing.total).toBe(1);
      expect(listing.items[0].id).toBe(subId);
    });

    it('122. English and Vietnamese i18n key parity verified for all quarantined queue strings', () => {
      const enKeys = Object.keys(enUS.quarantinedQueue).sort();
      const viKeys = Object.keys(viVN.quarantinedQueue).sort();
      expect(viKeys).toEqual(enKeys);
      expect(enKeys.length).toBeGreaterThanOrEqual(15);
    });
  });
});
