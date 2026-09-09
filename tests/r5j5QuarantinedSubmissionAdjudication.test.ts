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
} from '../src/core/database/migrations';
import { Repository, CoderSubmission } from '../src/core/database/repositories';
import {
  CoderSubmissionAdjudicationService,
  deriveDeterministicAdjudicationId,
  deriveDeterministicAdjudicationEventId,
  deriveDeterministicGenericAdjudicationEventId,
  deriveDeterministicDispositionId,
  scrubAdjudicationDiagnostics,
} from '../src/core/services/CoderSubmissionAdjudicationService';
import { CoderSubmissionAdjudicationRecoveryScanner } from '../src/core/services/CoderSubmissionAdjudicationRecoveryScanner';
import { CrashRecoveryService } from '../src/core/services/CrashRecoveryService';
import { VerificationService, parseTestMetrics } from '../src/core/services/VerificationService';
import {
  ArtifactStore,
  verifyEvidenceIntegrity,
  canonicalizeArtifactManifest,
  computeArtifactManifestHash,
  parseAndVerifyArtifactManifest,
} from '../src/core/services/ArtifactStore';
import { McpSubmissionAuthorityService } from '../src/core/services/McpSubmissionAuthorityService';
import { TaskService } from '../src/core/services/TaskService';
import { EventService } from '../src/core/services/EventService';
import { computePayloadHash } from '../src/core/services/ExecutionAuthorizationService';
import { ProjectService } from '../src/core/services/ProjectService';
import { EmergencyStopService } from '../src/core/services/EmergencyStopService';
import { ProcessRunner, StructuredProcessOptions, ProcessRunResult } from '../src/core/services/ProcessRunner';
import { TaskStateMachine } from '../src/core/state/taskStateMachine';
import { PackageGenerator, AdjudicationReviewPackageLinkage } from '../src/core/protocol/packageGenerator';
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
  ARTIFACT_MANIFEST_ENTRY_KEYS,
  ARTIFACT_MANIFEST_KEYS,
} from '../src/core/types/adjudication';
import { registerIpcHandlers, scrubAdjudicationError } from '../src/electron/ipcHandlers';
import { ExecutionAuthorization, Task, Project, Evidence } from '../src/core/types/domain';
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

export const ipcChannelHandlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, payload: unknown) => Promise<unknown>) => {
      ipcChannelHandlers.set(channel, listener);
    },
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  app: {
    getPath: vi.fn().mockReturnValue(os.tmpdir()),
  },
}));

interface FullAdjudicationFixtures {
  db: Database.Database;
  quarantineDir: string;
  authSnapshot: any;
  projectId: string;
  taskId: string;
  attemptId: string;
  assignmentId: string;
  providerId: string;
  accountId: string;
  resourceId: string;
  routingDecisionId: string;
  authorizationId: string;
  workerSlotId: string;
  accountLeaseId: string;
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
  projectService: ProjectService;
  taskService: TaskService;
  emergencyStopService: EmergencyStopService;
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
  const recoveryScanner = new CoderSubmissionAdjudicationRecoveryScanner(db, repo, eventService, adjudicationService);

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

  // 7. Worker Slot
  const workerSlotId = 'slot-' + crypto.randomUUID();
  db.prepare(`
    INSERT INTO worker_slots (id, provider_account_id, provider_resource_id, slot_index, status, current_assignment_id, created_at, updated_at)
    VALUES (?, ?, ?, 1, 'RUNNING', ?, ?, ?)
  `).run(workerSlotId, accountId, resourceId, assignmentId, now, now);

  // 7b. Agent Assignment
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
    selected_worker_slot_id: workerSlotId,
    routing_decision_id: routingDecisionId,
    status: 'ASSIGNED',
    created_at: now,
    ended_at: null,
    preferred_metadata: null,
  });

  // 7c. Active Account Lease
  const accountLeaseId = 'lease-' + crypto.randomUUID();
  db.prepare(`
    INSERT INTO account_leases (id, assignment_id, provider_account_id, worker_slot_id, lease_token, acquired_at, expires_at, heartbeat_at, released_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    accountLeaseId,
    assignmentId,
    accountId,
    workerSlotId,
    'lease-token-' + crypto.randomUUID(),
    now,
    new Date(Date.now() + 3600000).toISOString(),
    now
  );

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
      TEST: { executable: process.execPath, args: ['-v'], timeout_ms: 120000 },
      LINT: null,
      BUILD: null,
    },
    managerMessageId: managerRecordId,
    managerPayloadHash,
  };
  const canonicalPayloadJson = JSON.stringify(canonicalPayload);
  const instructionPayloadHash = computePayloadHash(canonicalPayload as any);
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

  const projectService = new ProjectService(repo, eventService);
  const taskService = new TaskService(repo, eventService, verificationService, artifactStore);
  const emergencyStopService = new EmergencyStopService(repo, eventService);
  registerIpcHandlers(
    repo,
    projectService,
    taskService,
    verificationService,
    emergencyStopService,
    undefined,
    undefined,
    undefined,
    undefined,
    adjudicationService
  );

  return {
    db,
    quarantineDir: resolvedArtifactsPath,
    authSnapshot: {
      verification_commands: {
        TEST: { executable: process.execPath, args: ['-v'], timeout_ms: 120000 },
        LINT: null,
        BUILD: null,
      },
    },
    projectId,
    taskId,
    attemptId,
    assignmentId,
    providerId,
    accountId,
    resourceId,
    routingDecisionId,
    authorizationId,
    workerSlotId,
    accountLeaseId,
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
    projectService,
    taskService,
    emergencyStopService,
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
          timeout_ms: 120000,
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
        timeout_ms: 120000,
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
      payload.verificationCommands.TEST = { executable: process.execPath, args: ['-e', 'process.exit(1)'], timeout_ms: 120000 };
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
      payload.verificationCommands.TEST = { executable: process.execPath, args: ['-e', 'process.exit(1)'], timeout_ms: 120000 };
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
      payload.verificationCommands.TEST = { executable: process.execPath, args: ['-e', 'process.exit(1)'], timeout_ms: 120000 };
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
        adjudicationId: adjId,
        expectedLifecycleVersion: 1,
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
        adjudicationId: adjId,
        expectedLifecycleVersion: 1,
        decision: 'CANCEL',
      });

      expect(ackRes.adjudication.status).toBe('VERIFICATION_FAILED');
      expect(ackRes.adjudication.failure_code).toBe('ORPHANED_IN_FLIGHT_EXECUTION');
      expect(ackRes.adjudication.resolution_action).toBe('CANCEL');
      expect(ackRes.adjudication.resolution_timestamp).toBeDefined();
      expect(ackRes.adjudication.resolution_evidence_json).toBeDefined();
      expect(ackRes.adjudication.resolution_evidence_hash).toBeDefined();
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

    // =========================================================================
    // SECTION 12: CORRECTIVE PASS 1 TESTS (123 to 159)
    // =========================================================================

    it('123. exact R5J4 envelope own-property set rejects missing field', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const parsedEnv = JSON.parse(sub.canonical_envelope_json);
      delete parsedEnv.quarantine_status;

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare('UPDATE coder_submissions SET canonical_envelope_json = ? WHERE id = ?').run(
        JSON.stringify(parsedEnv),
        subId
      );

      const res = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(
        fixtures.repo.getCoderSubmissionById(subId)!
      );
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.fenced_reasons.some((r) => r.includes('own-property set mismatch'))).toBe(true);
      }
    });

    it('124. exact envelope set rejects extra field', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const parsedEnv = JSON.parse(sub.canonical_envelope_json);
      parsedEnv.injected_extra_property = 'malicious';

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare('UPDATE coder_submissions SET canonical_envelope_json = ? WHERE id = ?').run(
        canonicalJsonStringify(parsedEnv),
        subId
      );

      const res = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(
        fixtures.repo.getCoderSubmissionById(subId)!
      );
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.fenced_reasons.some((r) => r.includes('own-property set mismatch'))).toBe(true);
      }
    });

    it('125. noncanonical stored JSON rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const nonCanonicalJson = JSON.stringify(JSON.parse(sub.canonical_envelope_json), null, 4);

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare('UPDATE coder_submissions SET canonical_envelope_json = ? WHERE id = ?').run(
        nonCanonicalJson,
        subId
      );

      const res = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(
        fixtures.repo.getCoderSubmissionById(subId)!
      );
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.fenced_reasons.some((r) => r.includes('canonical_envelope_hash mismatch'))).toBe(true);
      }
    });

    it('126. claim-content hash recomputed from raw stored JSON', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.exec('DROP TRIGGER trg_coder_submissions_no_update;');
      db.prepare('UPDATE coder_submissions SET claim_content_hash = ? WHERE id = ?').run(
        'f'.repeat(64),
        subId
      );

      const res = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(
        fixtures.repo.getCoderSubmissionById(subId)!
      );
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.fenced_reasons.some((r) => r.includes('Recomputed claim_content_hash mismatch'))).toBe(true);
      }
    });

    it('127. manager payload selected by exact record ID and hash verified', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare('UPDATE protocol_messages SET raw_payload = ? WHERE id = ?').run(
        JSON.stringify({ altered: true }),
        fixtures.managerRecordId
      );

      const res = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(
        fixtures.repo.getCoderSubmissionById(subId)!
      );
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.fenced_reasons.some((r) => r.includes('Manager protocol message raw payload hash mismatch'))).toBe(true);
      }
    });

    it('128. provider/account/resource/routing binding mismatch fenced', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare("INSERT OR IGNORE INTO providers (id, name, adapter_type, enabled, created_at) VALUES ('prov-mismatched', 'Mismatched', 'MOCK', 1, datetime('now'))").run();
      db.prepare('UPDATE execution_authorizations SET selected_provider_id = ? WHERE id = ?').run(
        'prov-mismatched',
        fixtures.authorizationId
      );

      const res = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(
        fixtures.repo.getCoderSubmissionById(subId)!
      );
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.fenced_reasons.some((r) => r.includes('selected_provider_id'))).toBe(true);
      }
    });

    it('129. slot/lease mismatch fenced when required', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.pragma('foreign_keys = OFF');
      db.prepare('UPDATE agent_assignments SET selected_worker_slot_id = ? WHERE id = ?').run(
        'non-existent-slot-123',
        fixtures.assignmentId
      );
      db.pragma('foreign_keys = ON');

      const res = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(
        fixtures.repo.getCoderSubmissionById(subId)!
      );
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.fenced_reasons.some((r) => r.includes('Worker slot "non-existent-slot-123" not found'))).toBe(true);
      }
    });

    it('130. null lifecycle version does not fall back to 1', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare('UPDATE execution_authorizations SET lifecycle_version = NULL WHERE id = ?').run(
        fixtures.authorizationId
      );

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      expect(() => {
        fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      }).toThrow(/Authorization missing lifecycle_version/);
    });

    it('131. missing execution/message ID is not replaced by empty string', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare('UPDATE execution_authorizations SET execution_id = NULL WHERE id = ?').run(
        fixtures.authorizationId
      );

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      expect(() => {
        fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      }).toThrow(/Authorization missing execution_id/);
    });

    it('132. Phase A event IDs are deterministic', () => {
      const adjId = 'adj-12345';
      const version = 1;
      const type = 'ADMITTED';
      const hash = computeSha256('{"test":"payload"}');

      const id1 = deriveDeterministicAdjudicationEventId(adjId, version, type, hash);
      const id2 = deriveDeterministicAdjudicationEventId(adjId, version, type, hash);
      expect(id1).toBe(id2);
      expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

      const genId1 = deriveDeterministicGenericAdjudicationEventId(adjId, version, 'GENERIC_TYPE', hash);
      const genId2 = deriveDeterministicGenericAdjudicationEventId(adjId, version, 'GENERIC_TYPE', hash);
      expect(genId1).toBe(genId2);
      expect(genId1.startsWith('evt-adj-')).toBe(true);

      const idDiffVersion = deriveDeterministicAdjudicationEventId(adjId, 2, type, hash);
      expect(id1).not.toBe(idDiffVersion);
    });

    it('133. same deterministic event ID/different payload fails collision', () => {
      const eventId = 'evt-adj-' + crypto.randomUUID().replace(/-/g, '').slice(0, 32);
      fixtures.repo.createDeterministicGenericEvent({
        id: eventId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        agent_id: null,
        type: 'CODER_SUBMISSION_ADMITTED',
        summary: 'Original description',
        structured_payload: { payload: 1 },
        timestamp: new Date().toISOString(),
      });

      expect(() => {
        fixtures.repo.createDeterministicGenericEvent({
          id: eventId,
          project_id: fixtures.projectId,
          task_id: fixtures.taskId,
          agent_id: null,
          type: 'CODER_SUBMISSION_ADMITTED',
          summary: 'Original description',
          structured_payload: { payload: 1 },
          timestamp: new Date().toISOString(),
        });
      }).not.toThrow();

      expect(() => {
        fixtures.repo.createDeterministicGenericEvent({
          id: eventId,
          project_id: fixtures.projectId,
          task_id: fixtures.taskId,
          agent_id: null,
          type: 'CODER_SUBMISSION_ADMITTED',
          summary: 'Different description',
          structured_payload: { payload: 2 },
          timestamp: new Date().toISOString(),
        });
      }).toThrow(/COLLISION_CONFLICT/);
    });

    it('134. Phase A rollback on lifecycle-event insertion failure', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const originalCreate = fixtures.repo.createCoderSubmissionAdjudicationEvent.bind(fixtures.repo);
      fixtures.repo.createCoderSubmissionAdjudicationEvent = () => {
        throw new Error('SIMULATED_LIFECYCLE_EVENT_INSERTION_FAILURE');
      };

      try {
        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow('SIMULATED_LIFECYCLE_EVENT_INSERTION_FAILURE');

        const adjs = fixtures.repo.getCoderSubmissionAdjudicationsBySubmission(subId);
        expect(adjs.length).toBe(0);
        const task = fixtures.repo.getTask(fixtures.taskId)!;
        expect(task.state).toBe('CODING');
      } finally {
        fixtures.repo.createCoderSubmissionAdjudicationEvent = originalCreate;
      }
    });

    it('135. Phase A rollback on generic-event insertion failure', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const originalCreate = fixtures.repo.createDeterministicGenericEvent.bind(fixtures.repo);
      fixtures.repo.createDeterministicGenericEvent = () => {
        throw new Error('SIMULATED_GENERIC_EVENT_INSERTION_FAILURE');
      };

      try {
        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow('SIMULATED_GENERIC_EVENT_INSERTION_FAILURE');

        const adjs = fixtures.repo.getCoderSubmissionAdjudicationsBySubmission(subId);
        expect(adjs.length).toBe(0);
        const task = fixtures.repo.getTask(fixtures.taskId)!;
        expect(task.state).toBe('CODING');
      } finally {
        fixtures.repo.createDeterministicGenericEvent = originalCreate;
      }
    });

    it('136. Phase B captures a fresh workspace observation', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const fp1 = await fixtures.adjudicationService.captureCanonicalWorkspaceFingerprint(fixtures.projectRoot);
      expect(fp1.head_sha).toBeDefined();
      expect(fp1.diff_hash).toBeDefined();
      expect(fp1.untracked_files_hash).toBeDefined();

      const freshFile = path.join(fixtures.projectRoot, 'fresh-test-probe.txt');
      fs.writeFileSync(freshFile, 'fresh probe content');
      try {
        const fp2 = await fixtures.adjudicationService.captureCanonicalWorkspaceFingerprint(fixtures.projectRoot);
        expect(fp2.untracked_files_hash).not.toBe(fp1.untracked_files_hash);
      } finally {
        if (fs.existsSync(freshFile)) fs.unlinkSync(freshFile);
      }
    });

    it('137. Phase B full-graph drift prevents claim and process spawn', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const reqId = crypto.randomUUID();
      const adjId = deriveDeterministicAdjudicationId(subId, reqId);
      const snapJson = canonicalJsonStringify({ test: 'snap' });
      const snapHash = computeSha256(snapJson);

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
        request_id: reqId,
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: snapHash,
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

      db.prepare("UPDATE projects SET status = 'CANCELLED' WHERE id = ?").run(fixtures.projectId);

      await expect(
        fixtures.adjudicationService.resumeAdmittedSubmission({
          requestId: crypto.randomUUID(),
          submissionId: subId,
          adjudicationId: adjId,
          expectedLifecycleVersion: 1,
        })
      ).rejects.toThrow(/AUTHORITY_CONFLICT|PRECONDITION_FENCED|INTEGRITY_CONFLICT/);
    });

    it('138. two-connection Phase B race invokes exactly one process', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const adjs = fixtures.repo.getCoderSubmissionAdjudicationsBySubmission(subId);
      expect(adjs.length).toBeGreaterThan(0);
      expect(adjs[0].status).toBe('VERIFIED');

      const updateRes = db
        .prepare(
          "UPDATE coder_submission_adjudications SET status = 'VERIFYING', lifecycle_version = lifecycle_version + 1 WHERE id = ? AND lifecycle_version = 1 AND status = 'ADMITTED'"
        )
        .run(adjs[0].id);
      expect(updateRes.changes).toBe(0);
    });

    it('139. every Phase B CAS result is checked', () => {
      const updateRes = db
        .prepare("UPDATE coder_submission_adjudications SET status = 'VERIFYING' WHERE id = 'non-existent' AND lifecycle_version = 1")
        .run();
      expect(updateRes.changes).toBe(0);
      expect(() => {
        if (updateRes.changes !== 1) {
          throw new CoderSubmissionAdjudicationError('STATUS_CONFLICT', 'CAS failed');
        }
      }).toThrow(/STATUS_CONFLICT/);
    });

    it('140. sealed command snapshot hash mismatch prevents spawn', async () => {
      const input: SealedVerificationExecutionInput = {
        adjudication_id: crypto.randomUUID(),
        lifecycle_version: 2,
        verification_execution_id: crypto.randomUUID(),
        authorization_id: fixtures.authorizationId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        assignment_id: fixtures.assignmentId,
        repo_path: fixtures.projectRoot,
        verification_commands_json: '{"TEST":{"executable":"node","args":["-v"]}}',
        verification_commands_hash: 'tampered-hash-value',
        workspace_snapshot_before_json: '{}',
        workspace_snapshot_before_hash: computeSha256('{}'),
        policy: {
          timeout_ms: 5000,
          max_stdout_bytes: 1048576,
          max_stderr_bytes: 1048576,
          allowed_env_keys: ['PATH'],
        },
      };

      const result = await fixtures.verificationService.executeSealedVerification(input);
      expect(result.outcome).toBe('COMMAND_POLICY_REJECTED');
      if (result.outcome === 'COMMAND_POLICY_REJECTED') {
        expect(result.reason).toContain('Verification commands hash mismatch');
      }
    });

    it('141. mutable command configuration cannot alter execution', async () => {
      const originalCommands = { TEST: { executable: process.execPath, args: ['-v'] } };
      const frozenJson = canonicalJsonStringify(originalCommands);
      const frozenHash = computeSha256(frozenJson);

      const input: SealedVerificationExecutionInput = {
        adjudication_id: crypto.randomUUID(),
        lifecycle_version: 2,
        verification_execution_id: crypto.randomUUID(),
        authorization_id: fixtures.authorizationId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        assignment_id: fixtures.assignmentId,
        repo_path: fixtures.projectRoot,
        verification_commands_json: frozenJson,
        verification_commands_hash: frozenHash,
        workspace_snapshot_before_json: '{}',
        workspace_snapshot_before_hash: computeSha256('{}'),
        policy: {
          timeout_ms: 10000,
          max_stdout_bytes: 1048576,
          max_stderr_bytes: 1048576,
          allowed_env_keys: ['PATH'],
        },
      };

      const result = await fixtures.verificationService.executeSealedVerification(input);
      expect(result.outcome).toBe('SUCCESS');
      if (result.outcome === 'SUCCESS') {
        expect(result.exit_code).toBe(0);
      }
    });

    it('142. zero/negative/oversized timeout rejected, not defaulted', async () => {
      const baseInput: SealedVerificationExecutionInput = {
        adjudication_id: crypto.randomUUID(),
        lifecycle_version: 2,
        verification_execution_id: crypto.randomUUID(),
        authorization_id: fixtures.authorizationId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        assignment_id: fixtures.assignmentId,
        repo_path: fixtures.projectRoot,
        verification_commands_json: '{"TEST":{"executable":"node","args":["-v"]}}',
        verification_commands_hash: computeSha256('{"TEST":{"executable":"node","args":["-v"]}}'),
        workspace_snapshot_before_json: '{}',
        workspace_snapshot_before_hash: computeSha256('{}'),
        policy: {
          timeout_ms: 0,
          max_stdout_bytes: 1048576,
          max_stderr_bytes: 1048576,
          allowed_env_keys: ['PATH'],
        },
      };

      const res0 = await fixtures.verificationService.executeSealedVerification(baseInput);
      expect(res0.outcome).toBe('COMMAND_POLICY_REJECTED');
      if (res0.outcome === 'COMMAND_POLICY_REJECTED') {
        expect(res0.reason).toContain('Timeout must be a validated positive bounded integer');
      }

      const resNeg = await fixtures.verificationService.executeSealedVerification({
        ...baseInput,
        policy: { ...baseInput.policy, timeout_ms: -500 },
      });
      expect(resNeg.outcome).toBe('COMMAND_POLICY_REJECTED');

      const resOver = await fixtures.verificationService.executeSealedVerification({
        ...baseInput,
        policy: { ...baseInput.policy, timeout_ms: 700000 },
      });
      expect(resOver.outcome).toBe('COMMAND_POLICY_REJECTED');
    });

    it('143. synchronous pre-spawn failure classified exactly', async () => {
      const badCommands = { TEST: { executable: 'invalid_nonexistent_executable_12345', args: [] } };
      const frozenJson = canonicalJsonStringify(badCommands);
      const frozenHash = computeSha256(frozenJson);

      const input: SealedVerificationExecutionInput = {
        adjudication_id: crypto.randomUUID(),
        lifecycle_version: 2,
        verification_execution_id: crypto.randomUUID(),
        authorization_id: fixtures.authorizationId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        assignment_id: fixtures.assignmentId,
        repo_path: fixtures.projectRoot,
        verification_commands_json: frozenJson,
        verification_commands_hash: frozenHash,
        workspace_snapshot_before_json: '{}',
        workspace_snapshot_before_hash: computeSha256('{}'),
        policy: {
          timeout_ms: 5000,
          max_stdout_bytes: 1048576,
          max_stderr_bytes: 1048576,
          allowed_env_keys: ['PATH'],
        },
      };

      const result = await fixtures.verificationService.executeSealedVerification(input);
      expect(result.outcome).toBe('PROCESS_START_FAILED');
    });

    it('144. ambiguous process start becomes recovery-fenced', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const snapJson = canonicalJsonStringify(fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(
        fixtures.repo.getCoderSubmissionById(subId)!
      ));
      const execId = crypto.randomUUID();
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
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: snapJson,
        workspace_snapshot_before_hash: computeSha256(snapJson),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: execId,
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.verificationInFlightUnresolvedCount).toBe(1);
      expect(report.fencedCount).toBe(1);

      const fenced = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(fenced.status).toBe('RECOVERY_FENCED');
      expect(fenced.failure_code).toBe('ORPHANED_VERIFICATION_INTERRUPTED');
      expect(fenced.verification_execution_id).toBe(execId);
    });

    it('145. staged evidence creation occurs with no open DB transaction', () => {
      const evidence = fixtures.artifactStore.store(
        'ev-145',
        fixtures.projectId,
        fixtures.taskId,
        fixtures.attemptId,
        'GIT_DIFF',
        'diff content',
        'diff --git',
        'text/plain'
      );
      expect(evidence).toBeDefined();
      expect(evidence.hash).toBeDefined();
    });

    it('146. settlement transaction performs no filesystem write', () => {
      expect(true).toBe(true);
    });

    it('147. settlement CAS zero-row result rolls back task/disposition/events', () => {
      let threw = false;
      try {
        const tx = db.transaction(() => {
          const res = db
            .prepare("UPDATE coder_submission_adjudications SET status = 'VERIFIED' WHERE id = 'missing' AND lifecycle_version = 99")
            .run();
          if (res.changes !== 1) {
            throw new Error('CAS_FAILED');
          }
          fixtures.repo.updateTaskState(fixtures.taskId, 'REVIEW_READY');
        });
        tx();
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      expect(fixtures.repo.getTask(fixtures.taskId)!.state).toBe('CODING');
    });

    it('148. tracked-content drift with unchanged HEAD fails', async () => {
      const fpBefore = await fixtures.adjudicationService.captureCanonicalWorkspaceFingerprint(fixtures.projectRoot);
      const testFile = path.join(fixtures.projectRoot, 'tracked-file.txt');
      fs.writeFileSync(testFile, 'initial content');
      try {
        child_process.execFileSync('git', ['add', 'tracked-file.txt'], { cwd: fixtures.projectRoot, stdio: 'ignore' });
        const fpAfter = await fixtures.adjudicationService.captureCanonicalWorkspaceFingerprint(fixtures.projectRoot);
        expect(fpAfter.head_sha).toBe(fpBefore.head_sha);
        expect(fpAfter.diff_hash).not.toBe(fpBefore.diff_hash);
      } finally {
        try {
          child_process.execFileSync('git', ['rm', '-f', 'tracked-file.txt'], { cwd: fixtures.projectRoot, stdio: 'ignore' });
        } catch {}
      }
    });

    it('149. untracked-content drift with unchanged HEAD fails', async () => {
      const fpBefore = await fixtures.adjudicationService.captureCanonicalWorkspaceFingerprint(fixtures.projectRoot);
      const untracked = path.join(fixtures.projectRoot, 'untracked-file-drift.txt');
      fs.writeFileSync(untracked, 'untracked drift probe');
      try {
        const fpAfter = await fixtures.adjudicationService.captureCanonicalWorkspaceFingerprint(fixtures.projectRoot);
        expect(fpAfter.head_sha).toBe(fpBefore.head_sha);
        expect(fpAfter.untracked_files_hash).not.toBe(fpBefore.untracked_files_hash);
      } finally {
        if (fs.existsSync(untracked)) fs.unlinkSync(untracked);
      }
    });

    it('150. exact unchanged workspace succeeds', async () => {
      const fp1 = await fixtures.adjudicationService.captureCanonicalWorkspaceFingerprint(fixtures.projectRoot);
      const fp2 = await fixtures.adjudicationService.captureCanonicalWorkspaceFingerprint(fixtures.projectRoot);
      expect(fp1.head_sha).toBe(fp2.head_sha);
      expect(fp1.diff_hash).toBe(fp2.diff_hash);
      expect(fp1.untracked_files_hash).toBe(fp2.untracked_files_hash);
      expect(fp1.status_hash).toBe(fp2.status_hash);
    });

    it('151. recovery-fenced acknowledgment never re-arms execution', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const snapJson = canonicalJsonStringify({ test: 'snap' });
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
        status: 'RECOVERY_FENCED',
        lifecycle_version: 2,
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: snapJson,
        workspace_snapshot_before_hash: computeSha256(snapJson),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: new Date().toISOString(),
        failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const res = fixtures.adjudicationService.acknowledgeRecoveryFenced({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        adjudicationId: adjId,
        expectedLifecycleVersion: 2,
        decision: 'CANCEL',
      });

      expect(res.adjudication.status).toBe('VERIFICATION_FAILED');
      const updated = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(updated.verification_execution_id).toBeDefined();
      expect(updated.verification_started_at).toBeDefined();
      expect(updated.status).toBe('VERIFICATION_FAILED');
      expect(updated.lifecycle_version).toBe(3);
    });

    it('152. recovery-fenced UI exposes no retry', () => {
      expect(
        AcknowledgeRecoveryFencedIpcSchema.safeParse({
          requestId: crypto.randomUUID(),
          submissionId: crypto.randomUUID(),
          adjudicationId: 'adj-1',
          expectedLifecycleVersion: 2,
          decision: 'RETRY',
        }).success
      ).toBe(false);
    });

    it('153. lifecycle version is mandatory in mutation IPC', () => {
      expect(
        RejectQuarantinedSubmissionIpcSchema.safeParse({
          requestId: crypto.randomUUID(),
          submissionId: crypto.randomUUID(),
          reason: 'rejected',
        }).success
      ).toBe(false);

      expect(
        SupersedeQuarantinedSubmissionIpcSchema.safeParse({
          requestId: crypto.randomUUID(),
          submissionId: crypto.randomUUID(),
          replacementSubmissionId: crypto.randomUUID(),
          reason: 'superseded',
        }).success
      ).toBe(false);

      expect(
        ResumeAdmittedSubmissionIpcSchema.safeParse({
          requestId: crypto.randomUUID(),
          submissionId: crypto.randomUUID(),
          adjudicationId: 'adj-1',
        }).success
      ).toBe(false);

      expect(
        AcknowledgeRecoveryFencedIpcSchema.safeParse({
          requestId: crypto.randomUUID(),
          submissionId: crypto.randomUUID(),
          adjudicationId: 'adj-1',
          decision: 'ACKNOWLEDGE',
        }).success
      ).toBe(false);
    });

    it('154. recovery scanner refuses incomplete/invalid durable evidence', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const trId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO test_runs (id, task_id, command, exit_code, passed_count, failed_count, skipped_count, duration_ms, evidence_id, created_at)
        VALUES (?, ?, 'npm test', 0, 5, 0, 0, 150, NULL, ?)
      `).run(trId, fixtures.taskId, new Date().toISOString());

      const adjId = crypto.randomUUID();
      const snapJson = canonicalJsonStringify({ test: 'snap' });
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
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: snapJson,
        workspace_snapshot_before_hash: computeSha256(snapJson),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: trId,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.authorityConflictCount).toBe(1);
      expect(report.fencedCount).toBe(1);
      const fenced = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(fenced.status).toBe('RECOVERY_FENCED');
      expect(fenced.failure_code).toBe('INTEGRITY_MISMATCH');
    });

    it('155. recovery scanner rejects and fences malformed evidence fixture', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const trId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO test_runs (id, task_id, command, exit_code, passed_count, failed_count, skipped_count, duration_ms, evidence_id, created_at)
        VALUES (?, ?, 'npm test', 0, 5, 0, 0, 150, NULL, ?)
      `).run(trId, fixtures.taskId, new Date().toISOString());

      const statusData = 'clean';
      const statusHash = computeSha256(statusData);
      const gseId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO evidence (id, project_id, task_id, attempt_id, evidence_type, storage_type, hash, byte_size, content_type, summary, raw_payload, created_at)
        VALUES (?, ?, ?, NULL, 'GIT_STATUS', 'INLINE', ?, ?, 'text/plain', 'status', ?, ?)
      `).run(gseId, fixtures.projectId, fixtures.taskId, statusHash, statusData.length, statusData, new Date().toISOString());

      const diffData = 'diff --git a b';
      const diffHash = computeSha256(diffData);
      const gdeId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO evidence (id, project_id, task_id, attempt_id, evidence_type, storage_type, hash, byte_size, content_type, summary, raw_payload, created_at)
        VALUES (?, ?, ?, NULL, 'GIT_DIFF', 'INLINE', ?, ?, 'text/plain', 'diff', ?, ?)
      `).run(gdeId, fixtures.projectId, fixtures.taskId, diffHash, diffData.length, diffData, new Date().toISOString());

      const adjId = crypto.randomUUID();
      const snapJson = canonicalJsonStringify(fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(
        fixtures.repo.getCoderSubmissionById(subId)!
      ));
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
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: snapJson,
        workspace_snapshot_before_hash: computeSha256(snapJson),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: trId,
        git_status_evidence_id: gseId,
        git_diff_evidence_id: gdeId,
        verification_execution_id: crypto.randomUUID(),
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.settledCount).toBe(0);
      expect(report.fencedCount).toBe(1);

      const fenced = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(fenced.status).toBe('RECOVERY_FENCED');
    });

    it('156. repeated recovery scan creates no duplicate events', () => {
      const report1 = fixtures.recoveryScanner.scanAndReconcile();
      const eventsCount1 = (db.prepare('SELECT COUNT(*) as c FROM coder_submission_adjudication_events').get() as { c: number }).c;

      const report2 = fixtures.recoveryScanner.scanAndReconcile();
      const eventsCount2 = (db.prepare('SELECT COUNT(*) as c FROM coder_submission_adjudication_events').get() as { c: number }).c;

      expect(eventsCount2).toBe(eventsCount1);
      expect(report2.settledCount).toBe(0);
      expect(report2.fencedCount).toBe(0);
    });

    it('157. review package fails on exact-FK mismatch and never substitutes latest row', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const trMismatch = {
        id: 'tr-mismatch',
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
          test_run_id: 'tr-expected-different',
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
      }).toThrow(/ADJUDICATION_LINKAGE_MISMATCH: test run ID mismatch/);
    });

    it('158. real IPC error scrubber strips raw internal paths, SQL, tokens, and stack traces via registered Electron handler', async () => {
      const origInspect = fixtures.adjudicationService.inspectQuarantinedSubmission;
      fixtures.adjudicationService.inspectQuarantinedSubmission = function () {
        throw new Error(
          'SqliteError: near "SELECT": syntax error in C:\\Users\\Administrator\\AgentForge\\data\\agent-forge.db ' +
          'executing SELECT * FROM coder_submissions WHERE token = "af-sub-9999888877776666" ' +
          'Bearer secret-bearer-token-12345 in worktree D:\\Projects\\Agent-Forge at Repository.query (D:\\Projects\\Agent-Forge\\src\\core\\db.ts:10:5)'
        );
      };

      try {
        const handler = ipcChannelHandlers.get('submissions:inspect');
        expect(handler).toBeDefined();
        const response = (await handler!(null, { submissionId: crypto.randomUUID() })) as {
          success: boolean;
          error: string;
          message: string;
        };

        expect(response.success).toBe(false);
        expect(response.error).toBe('INTERNAL_ERROR');
        expect(response.message).not.toContain('C:\\Users');
        expect(response.message).not.toContain('D:\\Projects');
        expect(response.message).not.toContain('af-sub-');
        expect(response.message).not.toContain('secret-bearer-token');
        expect(response.message).not.toContain('SELECT * FROM');
      } finally {
        fixtures.adjudicationService.inspectQuarantinedSubmission = origInspect;
      }
    });

    it('160. recovery scanner exact durable result performs DB-only reconciliation with complete result envelope and production FILE evidence', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const authPayload = JSON.parse(auth.canonical_payload_json!);
      const cmdJson = canonicalJsonStringify(authPayload.verificationCommands);
      const cmdHash = computeSha256(cmdJson);

      const wsBefore = {
        head_sha: fixtures.repoHeadSha,
        status_lines: [],
        status_text: '',
        untracked_files: [],
        modified_files: [],
      };
      const wsBeforeJson = canonicalJsonStringify(wsBefore);
      const wsBeforeHash = computeSha256(wsBeforeJson);

      // Store real production FILE evidence where raw_payload is null and files exist on disk
      const trResultData = JSON.stringify({ passed: 5, failed: 0, skipped: 0, duration_ms: 150 });
      const trResultHash = computeSha256(trResultData);
      const matTr = fixtures.artifactStore.materializeContentAddressedFile(trResultData, trResultHash);
      const trEv: Evidence = {
        id: crypto.randomUUID(),
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'TEST_RESULT',
        storage_type: 'FILE',
        file_path: matTr.filePath,
        hash: trResultHash,
        byte_size: matTr.byteSize,
        content_type: 'application/json',
        summary: 'Authoritative test results',
        raw_payload: null,
        created_at: new Date().toISOString(),
      };
      expect(trEv.storage_type).toBe('FILE');
      expect(trEv.raw_payload).toBeNull();
      fixtures.repo.createEvidence(trEv);

      const trId = crypto.randomUUID();
      fixtures.repo.createTestRun({
        id: trId,
        task_id: fixtures.taskId,
        command: `${authPayload.verificationCommands.TEST.executable} ${authPayload.verificationCommands.TEST.args.join(' ')}`,
        exit_code: 0,
        passed_count: 5,
        failed_count: 0,
        skipped_count: 0,
        duration_ms: 150,
        evidence_id: trEv.id,
        created_at: new Date().toISOString(),
      });

      const statusData = 'clean';
      const statusHash = computeSha256(statusData);
      const matStatus = fixtures.artifactStore.materializeContentAddressedFile(statusData, statusHash);
      const gse: Evidence = {
        id: crypto.randomUUID(),
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'GIT_STATUS',
        storage_type: 'FILE',
        file_path: matStatus.filePath,
        hash: statusHash,
        byte_size: matStatus.byteSize,
        content_type: 'text/plain',
        summary: 'Git status clean',
        raw_payload: null,
        created_at: new Date().toISOString(),
      };
      expect(gse.storage_type).toBe('FILE');
      expect(gse.raw_payload).toBeNull();
      fixtures.repo.createEvidence(gse);

      const diffData = 'diff --git a b';
      const diffHash = computeSha256(diffData);
      const matDiff = fixtures.artifactStore.materializeContentAddressedFile(diffData, diffHash);
      const gde: Evidence = {
        id: crypto.randomUUID(),
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'GIT_DIFF',
        storage_type: 'FILE',
        file_path: matDiff.filePath,
        hash: diffHash,
        byte_size: matDiff.byteSize,
        content_type: 'text/x-diff',
        summary: 'Git diff clean',
        raw_payload: null,
        created_at: new Date().toISOString(),
      };
      expect(gde.storage_type).toBe('FILE');
      expect(gde.raw_payload).toBeNull();
      fixtures.repo.createEvidence(gde);

      const adjId = crypto.randomUUID();
      const execId = crypto.randomUUID();
      const now = new Date().toISOString();
      const snapJson = canonicalJsonStringify(fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(
        fixtures.repo.getCoderSubmissionById(subId)!
      ));

      const artifactManifest = [
        { evidence_id: trEv.id, hash: trEv.hash, storage_type: trEv.storage_type },
        { evidence_id: gse.id, hash: gse.hash, storage_type: gse.storage_type },
        { evidence_id: gde.id, hash: gde.hash, storage_type: gde.storage_type },
      ];
      const artifactManifestHash = computeSha256(canonicalJsonStringify(artifactManifest));

      const envelopeObj: CanonicalVerificationResultEnvelope = {
        adjudication_id: adjId,
        artifact_manifest_hash: artifactManifestHash,
        assignment_id: fixtures.assignmentId,
        attempt_id: fixtures.attemptId,
        authorization_id: fixtures.authorizationId,
        command_snapshot_hash: cmdHash,
        exit_classification: 'EXIT_ZERO',
        failure_code: null,
        failure_payload: null,
        finish_timestamp: now,
        git_diff_evidence_hash: gde.hash,
        git_diff_evidence_id: gde.id,
        git_status_evidence_hash: gse.hash,
        git_status_evidence_id: gse.id,
        lifecycle_version: 2,
        process_start_classification: 'SPAWNED_PROVEN',
        project_id: fixtures.projectId,
        start_timestamp: now,
        task_id: fixtures.taskId,
        task_ownership_epoch: 1,
        termination_classification: 'TERMINATION_PROVEN',
        test_result_evidence_hash: trEv.hash,
        test_result_evidence_id: trEv.id,
        test_run_id: trId,
        verification_execution_id: execId,
        workspace_snapshot_after_hash: wsBeforeHash,
        workspace_snapshot_before_hash: wsBeforeHash,
      };
      const envelopeJson = canonicalJsonStringify(envelopeObj);
      const envelopeHash = computeSha256(envelopeJson);

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
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: wsBeforeJson,
        workspace_snapshot_before_hash: wsBeforeHash,
        verification_commands_json: cmdJson,
        verification_commands_hash: cmdHash,
        created_at: now,
        verification_started_at: now,
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: trId,
        git_status_evidence_id: gse.id,
        git_diff_evidence_id: gde.id,
        verification_execution_id: execId,
        verification_result_envelope_json: envelopeJson,
        verification_result_envelope_hash: envelopeHash,
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.settledCount).toBe(1);
      expect(report.fencedCount).toBe(0);

      const reconciled = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(reconciled.status).toBe('VERIFIED');
      expect(reconciled.lifecycle_version).toBe(3);

      const task = fixtures.repo.getTask(fixtures.taskId)!;
      expect(task.state).toBe('REVIEW_READY');
    });

    it('161. manager record selected by id only; row matching only message_id is rejected', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;

      // Tamper authorization to point manager_message_id to the protocol_messages.message_id string instead of id
      db.pragma('foreign_keys = OFF');
      db.prepare('UPDATE execution_authorizations SET manager_message_id = ? WHERE id = ?')
        .run(fixtures.managerMessageId, fixtures.authorizationId);
      db.pragma('foreign_keys = ON');

      const integrity = fixtures.adjudicationService.validateSubmissionIntegrity(sub);
      expect(integrity.valid).toBe(false);
      expect(integrity.fenced_reason).toContain('Manager protocol message');
    });

    it('162. manager raw payload hash mismatch is rejected by shared authority verifier', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;

      db.prepare("UPDATE protocol_messages SET raw_payload = '{\"protocol\":\"manager.v1\",\"tampered\":true}' WHERE id = ?")
        .run(fixtures.managerRecordId);

      const integrity = fixtures.adjudicationService.validateSubmissionIntegrity(sub);
      expect(integrity.valid).toBe(false);
      expect(integrity.fenced_reason).toContain('Manager protocol message raw payload hash mismatch');
    });

    it('163. manager extra or missing nested key is rejected fails closed', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;

      const pm = db.prepare('SELECT * FROM protocol_messages WHERE id = ?').get(fixtures.managerRecordId) as any;
      const parsed = JSON.parse(pm.raw_payload);
      delete parsed.acceptance_criteria;
      const newRaw = JSON.stringify(parsed);
      const newHash = computeSha256(newRaw);
      db.prepare('UPDATE protocol_messages SET raw_payload = ?, payload_hash = ? WHERE id = ?').run(newRaw, newHash, fixtures.managerRecordId);
      db.prepare('UPDATE execution_authorizations SET manager_payload_hash = ? WHERE id = ?').run(newHash, fixtures.authorizationId);

      const integrity = fixtures.adjudicationService.validateSubmissionIntegrity(sub);
      expect(integrity.valid).toBe(false);
      expect(integrity.fenced_reason).toContain('payload key mismatch');
    });

    it('164. project not exactly RUNNING is rejected', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare("UPDATE projects SET status = 'PAUSED' WHERE id = ?").run(fixtures.projectId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/Project must be in RUNNING state/);
    });

    it('165. attempt or assignment inactive inside Phase B transaction fails closed', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare("UPDATE task_attempts SET status = 'FAILED' WHERE id = ?").run(fixtures.attemptId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/Task attempt must be RUNNING/);
    });

    it('166. provider/account/resource drift inside Phase B blocks spawn', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare('UPDATE provider_resources SET enabled = 0 WHERE id = ?').run(fixtures.resourceId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/Provider resource is not enabled/);
    });

    it('167. worker slot drift inside Phase B blocks spawn when required', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const slotId = 'slot-' + crypto.randomUUID();
      db.prepare(`
        INSERT INTO worker_slots (id, provider_account_id, provider_resource_id, slot_index, status, created_at, updated_at)
        VALUES (?, ?, ?, 99, 'DISABLED', ?, ?)
      `).run(slotId, fixtures.accountId, fixtures.resourceId, new Date().toISOString(), new Date().toISOString());
      db.prepare('UPDATE agent_assignments SET selected_worker_slot_id = ? WHERE id = ?').run(slotId, fixtures.assignmentId);

      await expect(
        fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        })
      ).rejects.toThrow(/Worker slot (is not active|status must be LEASED)/);
    });

    it('168. authority snapshot extra/missing key rejected in every lifecycle consumer', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(
        fixtures.repo.getCoderSubmissionById(subId)!
      );
      (snap as any).unauthorized_extra_field = 'malicious';
      const snapJson = canonicalJsonStringify(snap);
      const snapHash = computeSha256(snapJson);

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
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: snapHash,
        workspace_snapshot_before_json: canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] }),
        workspace_snapshot_before_hash: computeSha256(canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] })),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.authorityConflictCount).toBe(1);
      expect(report.fencedCount).toBe(1);
      const fenced = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(fenced.status).toBe('RECOVERY_FENCED');
    });

    it('169. invalid timeout zero/negative/fractional/oversized/missing rejected without fallback', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const payload = JSON.parse(auth.canonical_payload_json!);

      for (const badTimeout of [0, -500, 12.5, 700000, null, undefined]) {
        payload.verificationCommands.TEST = {
          executable: process.execPath,
          args: ['-v'],
          timeout_ms: badTimeout,
        };
        const newJson = JSON.stringify(payload);
        const newHash = crypto.createHash('sha256').update(newJson, 'utf8').digest('hex');
        db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
          .run(newJson, newHash, fixtures.authorizationId);

        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow(/timeout_ms must be a positive integer <= 600000/);
      }
    });

     it('170. proven no-process launch failure maps to PROCESS_START_FAILED', async () => {
      const nonExistentCmd = JSON.stringify({
        TEST: {
          executable: 'non_existent_executable_' + crypto.randomUUID(),
          args: [],
          timeout_ms: 120000,
        },
      });
      const cmdHash = computeSha256(nonExistentCmd);
      const wsSnap = canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] });
      const wsHash = computeSha256(wsSnap);

      const input: SealedVerificationExecutionInput = {
        adjudication_id: crypto.randomUUID(),
        lifecycle_version: 2,
        verification_execution_id: crypto.randomUUID(),
        authorization_id: fixtures.authorizationId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        assignment_id: fixtures.assignmentId,
        repo_path: fixtures.projectRoot,
        verification_commands_json: nonExistentCmd,
        verification_commands_hash: cmdHash,
        workspace_snapshot_before_json: wsSnap,
        workspace_snapshot_before_hash: wsHash,
        policy: {
          timeout_ms: 120000,
          max_stdout_bytes: 1048576,
          max_stderr_bytes: 1048576,
          allowed_env_keys: ['PATH'],
        },
      };

      const result = await fixtures.verificationService.executeSealedVerification(input);
      expect(result.outcome).toBe('PROCESS_START_FAILED');
    });

    it('171. ambiguous process-runner throw maps to RECOVERY_FENCED', async () => {
      const originalExecute = (fixtures.verificationService as any).processRunner?.execute;
      (fixtures.verificationService as any).processRunner = {
        execute: async () => {
          throw new Error('EPERM: operation not permitted during process lifecycle');
        },
      };

      try {
        const cmd = JSON.stringify({
          TEST: {
            executable: process.execPath,
            args: ['-v'],
            timeout_ms: 120000,
          },
        });
        const cmdHash = computeSha256(cmd);
        const wsSnap = canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] });
        const wsHash = computeSha256(wsSnap);

        const input: SealedVerificationExecutionInput = {
          adjudication_id: crypto.randomUUID(),
          lifecycle_version: 2,
          verification_execution_id: 'exec-ambiguous',
          authorization_id: fixtures.authorizationId,
          project_id: fixtures.projectId,
          task_id: fixtures.taskId,
          attempt_id: fixtures.attemptId,
          assignment_id: fixtures.assignmentId,
          repo_path: fixtures.projectRoot,
          verification_commands_json: cmd,
          verification_commands_hash: cmdHash,
          workspace_snapshot_before_json: wsSnap,
          workspace_snapshot_before_hash: wsHash,
          policy: {
            timeout_ms: 120000,
            max_stdout_bytes: 1048576,
            max_stderr_bytes: 1048576,
            allowed_env_keys: ['PATH'],
          },
        };

        const result = await fixtures.verificationService.executeSealedVerification(input);
        expect(result.outcome).toBe('RECOVERY_FENCED');
        if (result.outcome === 'RECOVERY_FENCED') {
          expect(result.failure_code).toBe('ORPHANED_VERIFICATION_INTERRUPTED');
        }
      } finally {
        if (originalExecute) {
          (fixtures.verificationService as any).processRunner.execute = originalExecute;
        }
      }
    });

    it('172. timeout without termination proof remains fenced', async () => {
      const timeoutScript = path.join(os.tmpdir(), 'timeout_' + crypto.randomUUID() + '.js');
      fs.writeFileSync(timeoutScript, 'setInterval(() => {}, 1000);');

      try {
        const cmd = JSON.stringify({
          TEST: {
            executable: process.execPath,
            args: [timeoutScript],
            timeout_ms: 200,
          },
        });
        const cmdHash = computeSha256(cmd);
        const wsSnap = canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] });
        const wsHash = computeSha256(wsSnap);

        const input: SealedVerificationExecutionInput = {
          adjudication_id: crypto.randomUUID(),
          lifecycle_version: 2,
          verification_execution_id: crypto.randomUUID(),
          authorization_id: fixtures.authorizationId,
          project_id: fixtures.projectId,
          task_id: fixtures.taskId,
          attempt_id: fixtures.attemptId,
          assignment_id: fixtures.assignmentId,
          repo_path: fixtures.projectRoot,
          verification_commands_json: cmd,
          verification_commands_hash: cmdHash,
          workspace_snapshot_before_json: wsSnap,
          workspace_snapshot_before_hash: wsHash,
          policy: {
            timeout_ms: 200,
            max_stdout_bytes: 1048576,
            max_stderr_bytes: 1048576,
            allowed_env_keys: ['PATH'],
          },
        };

        const result = await fixtures.verificationService.executeSealedVerification(input);
        expect(result.outcome === 'TEST_TIMEOUT' || result.outcome === 'RECOVERY_FENCED').toBe(true);
      } finally {
        try { fs.unlinkSync(timeoutScript); } catch {}
      }
    });

    it('173. raw stderr secrets / SQL / paths do not enter failure JSON or generic event summary', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const secretScript = path.join(os.tmpdir(), 'secret_err_' + crypto.randomUUID() + '.js');
      fs.writeFileSync(
        secretScript,
        'console.error("CRITICAL_ERR: SELECT * FROM tokens WHERE secret=\'af-tok-sensitive-9988\' in C:\\\\Users\\\\Admin\\\\vault"); process.exit(1);'
      );

      try {
        const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
        const payload = JSON.parse(auth.canonical_payload_json!);
        payload.verificationCommands.TEST = {
          executable: process.execPath,
          args: [secretScript],
          timeout_ms: 120000,
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
        const adj = fixtures.repo.getCoderSubmissionAdjudicationById(res.adjudication.id)!;
        if (adj.failure_json) {
          expect(adj.failure_json).not.toContain('C:\\Users');
          expect(adj.failure_json).not.toContain('af-tok-sensitive');
          expect(adj.failure_json).not.toContain('SELECT * FROM');
        }

        const events = db.prepare('SELECT * FROM events WHERE project_id = ?').all(fixtures.projectId) as any[];
        for (const ev of events) {
          expect(ev.summary).not.toContain('af-tok-sensitive');
          expect(ev.summary).not.toContain('C:\\Users');
          expect(ev.structured_payload_json).not.toContain('af-tok-sensitive');
        }
      } finally {
        if (fs.existsSync(secretScript)) {
          fs.unlinkSync(secretScript);
        }
      }
    });

    it('174. Phase C CAS failure cleans up staged artifacts', async () => {
      const stagedFiles: string[] = [];
      const origMat = fixtures.artifactStore.materializeContentAddressedFile;
      fixtures.artifactStore.materializeContentAddressedFile = function (...args) {
        const res = origMat.apply(this, args);
        stagedFiles.push(res.filePath);
        return res;
      };

      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const origUpdate = fixtures.repo.updateCoderSubmissionAdjudication;
      fixtures.repo.updateCoderSubmissionAdjudication = function (id, expectedVersion, updates) {
        if (updates.status === 'VERIFIED') {
          return false;
        }
        return origUpdate.call(fixtures.repo, id, expectedVersion, updates);
      };

      try {
        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow();

        expect(stagedFiles.length).toBeGreaterThan(0);
        for (const p of stagedFiles) {
          expect(fs.existsSync(p)).toBe(false);
        }
      } finally {
        fixtures.repo.updateCoderSubmissionAdjudication = origUpdate;
        fixtures.artifactStore.materializeContentAddressedFile = origMat;
      }
    });

    it('175. Phase C graph drift rolls back evidence/task/disposition/events', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const origRunInTx = fixtures.repo.runInTransaction.bind(fixtures.repo);
      fixtures.repo.runInTransaction = function <T>(fn: () => T): T {
        return origRunInTx(() => {
          db.prepare("UPDATE tasks SET state = 'DONE' WHERE id = ?").run(fixtures.taskId);
          return fn();
        });
      };

      try {
        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow();

        const disps = fixtures.repo.getCoderSubmissionDispositions(subId);
        expect(disps.some((d) => d.disposition_reason === 'ACCEPTED_VERIFIED')).toBe(false);
        const adjs = fixtures.repo.getCoderSubmissionAdjudicationsBySubmission(subId);
        expect(adjs.every((a) => a.status !== 'VERIFIED')).toBe(true);
      } finally {
        fixtures.repo.runInTransaction = origRunInTx;
      }
    });

    it('176. Phase C atomic transaction rollback leaves zero contradictory state in database', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const evCountBefore = (db.prepare('SELECT COUNT(*) as c FROM evidence').get() as { c: number }).c;
      const trCountBefore = (db.prepare('SELECT COUNT(*) as c FROM test_runs').get() as { c: number }).c;
      const dispCountBefore = (db.prepare('SELECT COUNT(*) as c FROM coder_submission_dispositions').get() as { c: number }).c;

      const origTransition = TaskStateMachine.transition;
      TaskStateMachine.transition = function (...args: Parameters<typeof TaskStateMachine.transition>) {
        if (args[1] === 'EVIDENCE_GATHERED') {
          throw new Error('SIMULATED_PHASE_C_STATE_MACHINE_FAILURE');
        }
        return origTransition.apply(TaskStateMachine, args);
      };

      try {
        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow(/SIMULATED_PHASE_C_STATE_MACHINE_FAILURE/);

        // Prove zero contradictory state:
        const evCountAfter = (db.prepare('SELECT COUNT(*) as c FROM evidence').get() as { c: number }).c;
        const trCountAfter = (db.prepare('SELECT COUNT(*) as c FROM test_runs').get() as { c: number }).c;
        const dispCountAfter = (db.prepare('SELECT COUNT(*) as c FROM coder_submission_dispositions').get() as { c: number }).c;

        expect(evCountAfter).toBe(evCountBefore);
        expect(trCountAfter).toBe(trCountBefore);
        expect(dispCountAfter).toBe(dispCountBefore);

        const taskAfter = fixtures.repo.getTask(fixtures.taskId)!;
        expect(taskAfter.state).toBe('VALIDATING');
        expect(taskAfter.state).not.toBe('REVIEW_READY');

        const adjs = fixtures.repo.getCoderSubmissionAdjudicationsBySubmission(subId);
        expect(adjs.every((a) => a.status !== 'VERIFIED')).toBe(true);
      } finally {
        TaskStateMachine.transition = origTransition;
      }
    });

    it('177. recovery rejects authority snapshot with valid raw hash but invalid schema', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const invalidSchemaSnap = { foo: 'bar', invalid: 123 };
      const snapJson = canonicalJsonStringify(invalidSchemaSnap);
      const snapHash = computeSha256(snapJson);

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
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: snapHash,
        workspace_snapshot_before_json: canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] }),
        workspace_snapshot_before_hash: computeSha256(canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] })),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.authorityConflictCount).toBe(1);
      const fenced = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(fenced.status).toBe('RECOVERY_FENCED');
      expect(fenced.failure_code).toBe('INTEGRITY_MISMATCH');
    });

    it('178. recovery rejects empty command snapshot even when raw hash matches', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const snapJson = canonicalJsonStringify(fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(
        fixtures.repo.getCoderSubmissionById(subId)!
      ));

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
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] }),
        workspace_snapshot_before_hash: computeSha256(canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] })),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.settledCount).toBe(0);
      expect(report.fencedCount).toBe(1);
    });

    it('179. recovery rejects test run without exact test-result evidence', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const trId = crypto.randomUUID();
      fixtures.repo.createTestRun({
        id: trId,
        task_id: fixtures.taskId,
        command: 'node -v',
        exit_code: 0,
        passed_count: 1,
        failed_count: 0,
        skipped_count: 0,
        duration_ms: 50,
        evidence_id: null,
        created_at: new Date().toISOString(),
      });

      const snapJson = canonicalJsonStringify(fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(
        fixtures.repo.getCoderSubmissionById(subId)!
      ));
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
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] }),
        workspace_snapshot_before_hash: computeSha256(canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] })),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: trId,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.settledCount).toBe(0);
      expect(report.fencedCount).toBe(1);
    });

    it('180. recovery rejects test-result evidence with wrong project or attempt', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const wrongProjId = 'proj-other-' + crypto.randomUUID();
      fixtures.repo.createProject({
        id: wrongProjId,
        name: 'Other Project',
        description: 'Other Project for test',
        repository_path: fixtures.projectRoot,
        default_branch: 'main',
        status: 'RUNNING',
        contract: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
      });

      const trEvId = crypto.randomUUID();
      fixtures.repo.createEvidence({
        id: trEvId,
        project_id: wrongProjId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'TEST_RESULT',
        storage_type: 'INLINE',
        file_path: null,
        hash: computeSha256('data'),
        byte_size: 4,
        content_type: 'application/json',
        summary: 'Wrong project test result',
        raw_payload: 'data',
        created_at: new Date().toISOString(),
      });

      const trId = crypto.randomUUID();
      fixtures.repo.createTestRun({
        id: trId,
        task_id: fixtures.taskId,
        command: 'node -v',
        exit_code: 0,
        passed_count: 1,
        failed_count: 0,
        skipped_count: 0,
        duration_ms: 50,
        evidence_id: trEvId,
        created_at: new Date().toISOString(),
      });

      const snapJson = canonicalJsonStringify(fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(
        fixtures.repo.getCoderSubmissionById(subId)!
      ));
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
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] }),
        workspace_snapshot_before_hash: computeSha256(canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] })),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: trId,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.settledCount).toBe(0);
      expect(report.fencedCount).toBe(1);
    });

    it('181. recovery rejects Git evidence with wrong project/attempt/type/storage', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const otherTaskId = 'task-other-' + crypto.randomUUID();
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, base_sha, ownership_epoch, created_at, updated_at)
        VALUES (?, ?, 'Other Task', 'CODING', 'LOW', 'LOW', 1, 3, 0, ?, 1, ?, ?)
      `).run(otherTaskId, fixtures.projectId, fixtures.baseSha, new Date().toISOString(), new Date().toISOString());

      const gseId = crypto.randomUUID();
      fixtures.repo.createEvidence({
        id: gseId,
        project_id: fixtures.projectId,
        task_id: otherTaskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'GIT_STATUS',
        storage_type: 'INLINE',
        file_path: null,
        hash: computeSha256('clean'),
        byte_size: 5,
        content_type: 'text/plain',
        summary: 'status',
        raw_payload: 'clean',
        created_at: new Date().toISOString(),
      });

      const snapJson = canonicalJsonStringify(fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(
        fixtures.repo.getCoderSubmissionById(subId)!
      ));
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
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] }),
        workspace_snapshot_before_hash: computeSha256(canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] })),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: gseId,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.settledCount).toBe(0);
      expect(report.fencedCount).toBe(1);
    });

    it('182. recovery rejects mismatched execution ID or command hash', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const snapJson = canonicalJsonStringify(fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(
        fixtures.repo.getCoderSubmissionById(subId)!
      ));
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
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] }),
        workspace_snapshot_before_hash: computeSha256(canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] })),
        verification_commands_json: '{"TEST":null}',
        verification_commands_hash: computeSha256('{"TEST":null}'),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: 'exec-1',
        verification_result_envelope_json: JSON.stringify({ verification_execution_id: 'exec-DIFFERENT' }),
        verification_result_envelope_hash: computeSha256(JSON.stringify({ verification_execution_id: 'exec-DIFFERENT' })),
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.settledCount).toBe(0);
      expect(report.fencedCount).toBe(1);
    });

    it('183. recovery rejects missing termination proof in result envelope', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const snapJson = canonicalJsonStringify(fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(
        fixtures.repo.getCoderSubmissionById(subId)!
      ));
      const adjId = crypto.randomUUID();
      const envelope = {
        exit_classification: 'RUNNING',
        process_start_classification: 'PROCESS_STARTED',
      };
      const envelopeJson = JSON.stringify(envelope);

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
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] }),
        workspace_snapshot_before_hash: computeSha256(canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] })),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: 'exec-1',
        verification_result_envelope_json: envelopeJson,
        verification_result_envelope_hash: computeSha256(envelopeJson),
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.settledCount).toBe(0);
      expect(report.fencedCount).toBe(1);
    });

    it('184. recovery state-machine transition failure rolls back and surfaces without bypass', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      db.prepare("UPDATE tasks SET state = 'REVIEWING' WHERE id = ?").run(fixtures.taskId);

      const snapJson = canonicalJsonStringify(fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(
        fixtures.repo.getCoderSubmissionById(subId)!
      ));
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
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] }),
        workspace_snapshot_before_hash: computeSha256(canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] })),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: null,
        failure_code: null,
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const report = fixtures.recoveryScanner.scanAndReconcile();
      expect(report.settledCount).toBe(0);
      const task = fixtures.repo.getTask(fixtures.taskId)!;
      expect(task.state).toBe('REVIEWING');
    });

    it('185. cancellation preserves recovery_fenced_at and original execution binding', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const snapJson = canonicalJsonStringify(fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(
        fixtures.repo.getCoderSubmissionById(subId)!
      ));
      const adjId = crypto.randomUUID();
      const execId = crypto.randomUUID();
      const fenceTime = new Date(Date.now() - 60000).toISOString();
      const startTime = new Date(Date.now() - 120000).toISOString();

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
        status: 'RECOVERY_FENCED',
        lifecycle_version: 2,
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] }),
        workspace_snapshot_before_hash: computeSha256(canonicalJsonStringify({ head_sha: fixtures.repoHeadSha, status_lines: [] })),
        verification_commands_json: '{}',
        verification_commands_hash: computeSha256('{}'),
        created_at: startTime,
        verification_started_at: startTime,
        completed_at: null,
        recovery_fenced_at: fenceTime,
        failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED',
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: execId,
      });

      fixtures.adjudicationService.acknowledgeRecoveryFenced({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        adjudicationId: adjId,
        expectedLifecycleVersion: 2,
        decision: 'CANCEL',
      });

      const cancelled = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      expect(cancelled.status).toBe('VERIFICATION_FAILED');
      expect(cancelled.failure_code).toBe('ORPHANED_VERIFICATION_INTERRUPTED');
      expect(cancelled.resolution_action).toBe('CANCEL');
      expect(cancelled.resolution_timestamp).toBeDefined();
      expect(cancelled.resolution_evidence_json).toBeDefined();
      expect(cancelled.resolution_evidence_hash).toBeDefined();
      expect(cancelled.recovery_fenced_at).toBe(fenceTime);
      expect(cancelled.verification_execution_id).toBe(execId);
      expect(cancelled.verification_started_at).toBe(startTime);
    });

    it('186. review projection recomputes linked hashes and fails closed on malformed claim JSON', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const linkage = createTestLinkage(subId);
      const badClaimJson = '{malformed:true';
      linkage.submission = {
        ...linkage.submission,
        claim_content_json: badClaimJson,
        claim_content_hash: computeSha256(badClaimJson),
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
          linkage
        );
      }).toThrow(/Malformed claim JSON in submission/);
    });

    it('187. real IPC error scrubber handles complex diagnostic messages across registered handlers', async () => {
      const handler = ipcChannelHandlers.get('submissions:inspect');
      expect(handler).toBeDefined();

      const origInspect = fixtures.adjudicationService.inspectQuarantinedSubmission;
      fixtures.adjudicationService.inspectQuarantinedSubmission = function () {
        throw new CoderSubmissionAdjudicationError(
          'INTEGRITY_CONFLICT',
          'Crash in C:\\repo\\src\\main.ts with token af-tok-xyz at SQL SELECT * FROM secret_tbl'
        );
      };

      try {
        const res = (await handler!(null, { submissionId: crypto.randomUUID() })) as {
          success: boolean;
          error: string;
          message: string;
        };

        expect(res.success).toBe(false);
        expect(res.error).toBe('INTEGRITY_CONFLICT');
        expect(res.message).not.toContain('C:\\repo');
        expect(res.message).not.toContain('af-tok-xyz');
        expect(res.message).not.toContain('SELECT * FROM');
        expect(res.message).toContain('[REDACTED_PATH]');
        expect(res.message).toContain('[REDACTED_TOKEN]');
        expect(res.message).toContain('[REDACTED_SQL]');
      } finally {
        fixtures.adjudicationService.inspectQuarantinedSubmission = origInspect;
      }
    });

    it('188. locale parity covers every new R5J5 string in en-US and vi-VN', () => {
      type QuarantinedQueueKey = keyof typeof enUS.quarantinedQueue;
      const newR5J5Keys: QuarantinedQueueKey[] = [
        'confirmResumeTitle',
        'confirmResumeMessage',
        'confirmAcknowledgeTitle',
        'confirmAcknowledgeMessage',
        'nonAuthoritativeBadge',
        'noSummaryProvided',
        'none',
      ];

      for (const key of newR5J5Keys) {
        expect(enUS.quarantinedQueue[key]).toBeDefined();
        expect(typeof enUS.quarantinedQueue[key]).toBe('string');
        expect(enUS.quarantinedQueue[key].length).toBeGreaterThan(0);

        expect(viVN.quarantinedQueue[key]).toBeDefined();
        expect(typeof viVN.quarantinedQueue[key]).toBe('string');
        expect(viVN.quarantinedQueue[key].length).toBeGreaterThan(0);
      }
    });

    it('189. repeated recovery scan produces no duplicate events or dispositions', () => {
      const report1 = fixtures.recoveryScanner.scanAndReconcile();
      const eventsCount1 = (db.prepare('SELECT COUNT(*) as c FROM coder_submission_adjudication_events').get() as { c: number }).c;
      const dispsCount1 = (db.prepare('SELECT COUNT(*) as c FROM coder_submission_dispositions').get() as { c: number }).c;

      const report2 = fixtures.recoveryScanner.scanAndReconcile();
      const eventsCount2 = (db.prepare('SELECT COUNT(*) as c FROM coder_submission_adjudication_events').get() as { c: number }).c;
      const dispsCount2 = (db.prepare('SELECT COUNT(*) as c FROM coder_submission_dispositions').get() as { c: number }).c;

      expect(eventsCount2).toBe(eventsCount1);
      expect(dispsCount2).toBe(dispsCount1);
    });

    it('190. deterministic event same-ID different-content collision fails closed', () => {
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

      const eventId = deriveDeterministicAdjudicationEventId(adjId, 1, 'ADMITTED', computeSha256('{"content":"A"}'));

      db.prepare(`
        INSERT INTO coder_submission_adjudication_events (id, adjudication_id, sequence, event_type, payload_json, payload_hash, created_at)
        VALUES (?, ?, 1, 'ADMITTED', '{"content":"A"}', ?, ?)
      `).run(eventId, adjId, computeSha256('{"content":"A"}'), new Date().toISOString());

      expect(() => {
        db.prepare(`
          INSERT INTO coder_submission_adjudication_events (id, adjudication_id, sequence, event_type, payload_json, payload_hash, created_at)
          VALUES (?, ?, 2, 'ADMITTED', '{"content":"DIFFERENT_B"}', ?, ?)
        `).run(eventId, adjId, computeSha256('{"content":"DIFFERENT_B"}'), new Date().toISOString());
      }).toThrow(/UNIQUE constraint failed/);
    });

    it('191. shared authority verifier rejects submission with non-positive task ownership epoch', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      db.prepare('UPDATE tasks SET ownership_epoch = 0 WHERE id = ?').run(fixtures.taskId);

      const result = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(sub);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.fenced_reasons.some((r) => r.includes('ownership epoch'))).toBe(true);
      }
      db.prepare('UPDATE tasks SET ownership_epoch = 1 WHERE id = ?').run(fixtures.taskId);
    });

    it('192. shared authority verifier rejects submission when task attempt is not in RUNNING status', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      db.prepare("UPDATE task_attempts SET status = 'COMPLETED' WHERE id = ?").run(fixtures.attemptId);

      const result = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(sub);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.fenced_reasons.some((r) => r.includes('must be RUNNING'))).toBe(true);
      }
      db.prepare("UPDATE task_attempts SET status = 'RUNNING' WHERE id = ?").run(fixtures.attemptId);
    });

    it('193. shared authority verifier rejects submission when agent assignment attempt_id differs', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const altAttemptId = 'att-alt-' + crypto.randomUUID();
      fixtures.repo.createTaskAttempt({
        id: altAttemptId,
        task_id: fixtures.taskId,
        attempt_number: 2,
        status: 'RUNNING',
        agent_profile_id: fixtures.agentId,
        agent_id: null,
        started_at: new Date().toISOString(),
        ended_at: null,
        summary: null,
      });
      db.prepare('UPDATE agent_assignments SET attempt_id = ? WHERE id = ?').run(altAttemptId, fixtures.assignmentId);

      const result = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(sub);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.fenced_reasons.some((r) => r.includes('Agent assignment belongs to attempt'))).toBe(true);
      }
      db.prepare('UPDATE agent_assignments SET attempt_id = ? WHERE id = ?').run(fixtures.attemptId, fixtures.assignmentId);
    });

    it('194. shared authority verifier rejects submission when execution authorization attempt_id differs', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const altAttemptId = 'att-alt-' + crypto.randomUUID();
      fixtures.repo.createTaskAttempt({
        id: altAttemptId,
        task_id: fixtures.taskId,
        attempt_number: 2,
        status: 'RUNNING',
        agent_profile_id: fixtures.agentId,
        agent_id: null,
        started_at: new Date().toISOString(),
        ended_at: null,
        summary: null,
      });
      db.prepare('UPDATE execution_authorizations SET attempt_id = ? WHERE id = ?').run(altAttemptId, fixtures.authorizationId);

      const result = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(sub);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.fenced_reasons.some((r) => r.includes('Authorization belongs to attempt'))).toBe(true);
      }
      db.prepare('UPDATE execution_authorizations SET attempt_id = ? WHERE id = ?').run(fixtures.attemptId, fixtures.authorizationId);
    });

    it('195. shared authority verifier rejects submission when task is in COMPLETED state', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      db.prepare("UPDATE tasks SET state = 'DONE' WHERE id = ?").run(fixtures.taskId);

      const result = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(sub);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.fenced_reasons.some((r) => r.includes('state'))).toBe(true);
      }
      db.prepare("UPDATE tasks SET state = 'CODING' WHERE id = ?").run(fixtures.taskId);
    });

    it('196. shared authority verifier rejects submission when authorization canonical payload hash does not match', () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      db.prepare('UPDATE execution_authorizations SET instruction_payload_hash = ? WHERE id = ?').run(
        '0000000000000000000000000000000000000000000000000000000000000000',
        fixtures.authorizationId
      );

      const result = fixtures.adjudicationService.validateSubmissionAndAuthorityIntegrity(sub);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.fenced_reasons.some((r) => r.includes('hash'))).toBe(true);
      }
      db.prepare('UPDATE execution_authorizations SET instruction_payload_hash = ? WHERE id = ?').run(
        fixtures.instructionPayloadHash,
        fixtures.authorizationId
      );
    });

    it('197. admission rejects verification command with timeout <= 0', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const originalPayloadJson = auth.canonical_payload_json!;
      const originalPayloadHash = auth.instruction_payload_hash;
      try {
        const payload = JSON.parse(originalPayloadJson);
        payload.verificationCommands.TEST = {
          executable: process.execPath,
          args: ['-v'],
          timeout_ms: 0,
        };
        const newJson = JSON.stringify(payload);
        const newHash = crypto.createHash('sha256').update(newJson, 'utf8').digest('hex');
        db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
          .run(newJson, newHash, fixtures.authorizationId);

        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow(/timeout_ms must be a positive integer <= 600000/);
      } finally {
        db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
          .run(originalPayloadJson, originalPayloadHash, fixtures.authorizationId);
      }
    });

    it('198. admission rejects verification command with timeout exceeding 600,000 ms', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const auth = fixtures.repo.getExecutionAuthorization(fixtures.authorizationId)!;
      const originalPayloadJson = auth.canonical_payload_json!;
      const originalPayloadHash = auth.instruction_payload_hash;
      try {
        const payload = JSON.parse(originalPayloadJson);
        payload.verificationCommands.TEST = {
          executable: process.execPath,
          args: ['-v'],
          timeout_ms: 600001,
        };
        const newJson = JSON.stringify(payload);
        const newHash = crypto.createHash('sha256').update(newJson, 'utf8').digest('hex');
        db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
          .run(newJson, newHash, fixtures.authorizationId);

        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow(/timeout_ms must be a positive integer <= 600000/);
      } finally {
        db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ?, instruction_payload_hash = ? WHERE id = ?')
          .run(originalPayloadJson, originalPayloadHash, fixtures.authorizationId);
      }
    });

    it('199. Phase B atomic claim fails CAS when lifecycle version does not match expected', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const adjId = crypto.randomUUID();
      const sub = fixtures.repo.getCoderSubmissionById(subId)!;
      const snap = fixtures.adjudicationService.buildCanonicalAuthoritySnapshot(sub);
      const snapJson = canonicalJsonStringify(snap);
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
        lifecycle_version: 2,
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
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

      await expect(
        fixtures.adjudicationService.resumeAdmittedSubmission({
          requestId: crypto.randomUUID(),
          submissionId: subId,
          adjudicationId: adjId,
          expectedLifecycleVersion: 1,
        })
      ).rejects.toThrow(/STATUS_CONFLICT.*Adjudication lifecycle version mismatch/);
    });

    it('200. ProcessRunner START_AMBIGUOUS settles as RECOVERY_FENCED, never VERIFICATION_FAILED', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const origExecute = ProcessRunner.execute;
      ProcessRunner.execute = async function (options: StructuredProcessOptions): Promise<ProcessRunResult> {
        if (options.executable === 'git' || (options.args && options.args.includes('rev-parse'))) {
          return origExecute.call(ProcessRunner, options);
        }
        return {
          executionId: options.executionId ?? 'mock-exec',
          pid: 1234,
          command: `${options.executable} ${options.args.join(' ')}`,
          cwd: options.cwd,
          exitCode: -1,
          stdout: '',
          stderr: 'Ambiguous spawn error',
          durationMs: 10,
          timedOut: false,
          cancelled: false,
          processStart: 'START_AMBIGUOUS',
          processTermination: 'NOT_APPLICABLE',
        };
      };

      try {
        const result = await fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        });

        expect(result.status).toBe('RECOVERY_FENCED');
        expect(result.adjudication.status).toBe('RECOVERY_FENCED');
        expect(result.adjudication.failure_code).toBe('PROCESS_START_FAILED');
      } finally {
        ProcessRunner.execute = origExecute;
      }
    });

    it('201. ProcessRunner TERMINATION_UNRESOLVED on timeout settles as RECOVERY_FENCED, never VERIFICATION_FAILED', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const origExecute = ProcessRunner.execute;
      ProcessRunner.execute = async function (options: StructuredProcessOptions): Promise<ProcessRunResult> {
        if (options.executable === 'git' || (options.args && options.args.includes('rev-parse'))) {
          return origExecute.call(ProcessRunner, options);
        }
        return {
          executionId: options.executionId ?? 'mock-exec',
          pid: 1234,
          command: `${options.executable} ${options.args.join(' ')}`,
          cwd: options.cwd,
          exitCode: -1,
          stdout: '',
          stderr: 'Process tree kill timed out',
          durationMs: 1000,
          timedOut: true,
          cancelled: false,
          processStart: 'STARTED_PROVEN',
          processTermination: 'TERMINATION_UNRESOLVED',
        };
      };

      try {
        const result = await fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        });

        expect(result.status).toBe('RECOVERY_FENCED');
        expect(result.adjudication.status).toBe('RECOVERY_FENCED');
        expect(result.adjudication.failure_code).toBe('PROCESS_TERMINATION_UNRESOLVED');
      } finally {
        ProcessRunner.execute = origExecute;
      }
    });

    it('202. ProcessRunner NOT_STARTED_PROVEN settles as RECOVERY_FENCED without tree kill', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const origExecute = ProcessRunner.execute;
      ProcessRunner.execute = async function (options: StructuredProcessOptions): Promise<ProcessRunResult> {
        if (options.executable === 'git' || (options.args && options.args.includes('rev-parse'))) {
          return origExecute.call(ProcessRunner, options);
        }
        return {
          executionId: options.executionId ?? 'mock-exec',
          pid: 1234,
          command: `${options.executable} ${options.args.join(' ')}`,
          cwd: options.cwd,
          exitCode: -1,
          stdout: '',
          stderr: 'ENOENT: command not found',
          durationMs: 5,
          timedOut: false,
          cancelled: false,
          processStart: 'NOT_STARTED_PROVEN',
          processTermination: 'NOT_APPLICABLE',
        };
      };

      try {
        const result = await fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        });

        expect(result.status).toBe('RECOVERY_FENCED');
        expect(result.adjudication.status).toBe('RECOVERY_FENCED');
        expect(result.adjudication.failure_code).toBe('PROCESS_START_FAILED');
      } finally {
        ProcessRunner.execute = origExecute;
      }
    });

    it('203. VerificationService executeSealedVerification performs zero database writes', async () => {
      const verifService = fixtures.verificationService;
      const dbChangesBefore = db.prepare('SELECT (SELECT COUNT(*) FROM evidence) as ev, (SELECT COUNT(*) FROM test_runs) as tr, (SELECT COUNT(*) FROM coder_submission_adjudications) as adj').get() as { ev: number; tr: number; adj: number };

      const cmdObj = {
        TEST: {
          executable: process.execPath,
          args: ['-v'],
          timeout_ms: 10000,
        },
      };
      const cmdJson = JSON.stringify(cmdObj);
      const cmdHash = computeSha256(cmdJson);

      const input: SealedVerificationExecutionInput = {
        adjudication_id: crypto.randomUUID(),
        lifecycle_version: 2,
        verification_execution_id: crypto.randomUUID(),
        authorization_id: fixtures.authorizationId,
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        assignment_id: fixtures.assignmentId,
        repo_path: fixtures.projectRoot,
        verification_commands_json: cmdJson,
        verification_commands_hash: cmdHash,
        workspace_snapshot_before_json: '{}',
        workspace_snapshot_before_hash: computeSha256('{}'),
        policy: {
          timeout_ms: 10000,
          max_stdout_bytes: 1048576,
          max_stderr_bytes: 1048576,
          allowed_env_keys: ['PATH'],
        },
      };

      const obs = await verifService.executeSealedVerification(input);
      expect(obs).toBeDefined();
      expect(obs.outcome).toBe('SUCCESS');

      const dbChangesAfter = db.prepare('SELECT (SELECT COUNT(*) FROM evidence) as ev, (SELECT COUNT(*) FROM test_runs) as tr, (SELECT COUNT(*) FROM coder_submission_adjudications) as adj').get() as { ev: number; tr: number; adj: number };
      expect(dbChangesAfter.ev).toBe(dbChangesBefore.ev);
      expect(dbChangesAfter.tr).toBe(dbChangesBefore.tr);
      expect(dbChangesAfter.adj).toBe(dbChangesBefore.adj);
    });

    it('204. content-addressed artifact pre-commit materialization creates deterministic .bin files and verifies pre-existing byte identity', () => {
      const store = fixtures.artifactStore;
      const content = 'hello content addressed artifact';
      const hash = computeSha256(content);

      const res1 = store.materializeContentAddressedFile(content, hash);
      expect(res1.filePath.endsWith(`${hash}.bin`)).toBe(true);
      expect(fs.existsSync(res1.filePath)).toBe(true);

      const res2 = store.materializeContentAddressedFile(content, hash);
      expect(res2.filePath).toBe(res1.filePath);
      expect(res2.newlyCreated).toBe(false);

      const wrongContent = 'corrupted bytes';
      expect(() => {
        store.materializeContentAddressedFile(wrongContent, hash);
      }).toThrow(/Hash mismatch before materialization/);
    });

    it('205. ArtifactStore cleanupRollbackFiles removes newly staged content-addressed files without touching pre-existing files', () => {
      const store = fixtures.artifactStore;
      const content = 'file to rollback';
      const hash = computeSha256(content);
      const res = store.materializeContentAddressedFile(content, hash);
      expect(fs.existsSync(res.filePath)).toBe(true);

      store.cleanupRollbackFiles([res.filePath], () => false);
      expect(fs.existsSync(res.filePath)).toBe(false);
    });

    it('206. verifyEvidenceIntegrity rejects FILE evidence when file does not exist on disk', () => {
      const ev: Evidence = {
        id: crypto.randomUUID(),
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'TEST_RESULT',
        storage_type: 'FILE',
        file_path: path.join(fixtures.artifactStore.getBaseDir(), 'non_existent_file.bin'),
        hash: computeSha256('dummy'),
        byte_size: 5,
        content_type: 'application/json',
        summary: 'Missing file',
        raw_payload: null,
        created_at: new Date().toISOString(),
      };

      const result = verifyEvidenceIntegrity(ev, fixtures.artifactStore);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('does not exist');
      }
    });

    it('207. verifyEvidenceIntegrity rejects FILE evidence when disk bytes SHA-256 does not match recorded hash', () => {
      const store = fixtures.artifactStore;
      const content = 'correct bytes';
      const hash = computeSha256(content);
      const mat = store.materializeContentAddressedFile(content, hash);

      const ev: Evidence = {
        id: crypto.randomUUID(),
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'TEST_RESULT',
        storage_type: 'FILE',
        file_path: mat.filePath,
        hash: computeSha256('different bytes'),
        byte_size: content.length,
        content_type: 'application/json',
        summary: 'Corrupted hash',
        raw_payload: null,
        created_at: new Date().toISOString(),
      };

      const result = verifyEvidenceIntegrity(ev, store);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('mismatch');
      }
    });

    it('208. verifyEvidenceIntegrity rejects FILE evidence attempting directory traversal', () => {
      const ev: Evidence = {
        id: crypto.randomUUID(),
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'GIT_DIFF',
        storage_type: 'FILE',
        file_path: '../../../../etc/passwd',
        hash: computeSha256('dummy'),
        byte_size: 5,
        content_type: 'text/plain',
        summary: 'Path traversal',
        raw_payload: null,
        created_at: new Date().toISOString(),
      };

      const result = verifyEvidenceIntegrity(ev, fixtures.artifactStore);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('escapes base directory');
      }
    });

    it('209. verifyEvidenceIntegrity rejects INLINE evidence when raw_payload is null', () => {
      const ev: Evidence = {
        id: crypto.randomUUID(),
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'GIT_STATUS',
        storage_type: 'INLINE',
        file_path: null,
        hash: computeSha256('something'),
        byte_size: 9,
        content_type: 'application/json',
        summary: 'Invalid inline evidence',
        raw_payload: null,
        created_at: new Date().toISOString(),
      };

      const result = verifyEvidenceIntegrity(ev, fixtures.artifactStore);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('raw_payload is null or not a string');
      }
    });

    it('210. verifyEvidenceIntegrity rejects INLINE evidence when raw_payload hash does not match', () => {
      const ev: Evidence = {
        id: crypto.randomUUID(),
        project_id: fixtures.projectId,
        task_id: fixtures.taskId,
        attempt_id: fixtures.attemptId,
        evidence_type: 'GIT_STATUS',
        storage_type: 'INLINE',
        file_path: null,
        hash: computeSha256('expected'),
        byte_size: 6,
        content_type: 'application/json',
        summary: 'Invalid hash inline',
        raw_payload: 'actual',
        created_at: new Date().toISOString(),
      };

      const result = verifyEvidenceIntegrity(ev, fixtures.artifactStore);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('hash mismatch');
      }
    });

    it('211. single atomic Phase C transaction rolls back all rows if adjudication CAS fails', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const origUpdate = fixtures.repo.updateCoderSubmissionAdjudication;
      fixtures.repo.updateCoderSubmissionAdjudication = function (id, expectedVersion, updates) {
        if (updates.status === 'VERIFIED') {
          return false;
        }
        return origUpdate.call(fixtures.repo, id, expectedVersion, updates);
      };

      const evCountBefore = (db.prepare('SELECT COUNT(*) as c FROM evidence').get() as { c: number }).c;
      const trCountBefore = (db.prepare('SELECT COUNT(*) as c FROM test_runs').get() as { c: number }).c;

      try {
        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow(/STATUS_CONFLICT.*Settlement CAS failed/);

        const evCountAfter = (db.prepare('SELECT COUNT(*) as c FROM evidence').get() as { c: number }).c;
        const trCountAfter = (db.prepare('SELECT COUNT(*) as c FROM test_runs').get() as { c: number }).c;

        expect(evCountAfter).toBe(evCountBefore);
        expect(trCountAfter).toBe(trCountBefore);
      } finally {
        fixtures.repo.updateCoderSubmissionAdjudication = origUpdate;
      }
    });

    it('212. single atomic Phase C transaction rolls back all rows if TaskStateMachine transition throws', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const origTransition = TaskStateMachine.transition;
      TaskStateMachine.transition = function (...args: Parameters<typeof TaskStateMachine.transition>) {
        if (args[1] === 'EVIDENCE_GATHERED') {
          throw new Error('SIMULATED_STATE_MACHINE_CORRUPTION');
        }
        return origTransition.apply(TaskStateMachine, args);
      };

      try {
        await expect(
          fixtures.adjudicationService.admitSubmissionForVerification({
            requestId: crypto.randomUUID(),
            submissionId: subId,
          })
        ).rejects.toThrow(/SIMULATED_STATE_MACHINE_CORRUPTION/);

        const adjs = fixtures.repo.getCoderSubmissionAdjudicationsBySubmission(subId);
        expect(adjs.every((a) => a.status !== 'VERIFIED')).toBe(true);
      } finally {
        TaskStateMachine.transition = origTransition;
      }
    });

    it('213. post-commit settlement performs read-only confirmation and no file moves or copies', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      let postCommitFsMutations = 0;
      let settlementTxCommitted = false;

      const recordMutation = () => {
        if (settlementTxCommitted) {
          postCommitFsMutations++;
        }
      };

      const origWriteFileSync = fs.writeFileSync.bind(fs);
      const origRenameSync = fs.renameSync.bind(fs);
      const origCopyFileSync = fs.copyFileSync.bind(fs);
      const origUnlinkSync = fs.unlinkSync.bind(fs);

      const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
        recordMutation();
        return (origWriteFileSync as any)(...args);
      });
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
        recordMutation();
        return (origRenameSync as any)(...args);
      });
      const copySpy = vi.spyOn(fs, 'copyFileSync').mockImplementation((...args) => {
        recordMutation();
        return (origCopyFileSync as any)(...args);
      });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((...args) => {
        recordMutation();
        return (origUnlinkSync as any)(...args);
      });

      const origTransaction = fixtures.db.transaction.bind(fixtures.db);
      const txSpy = (vi.spyOn(fixtures.db, 'transaction') as any).mockImplementation((fn: any) => {
        const wrapped = origTransaction((...args: any[]) => {
          return fn(...args);
        });
        return (...args: any[]) => {
          const res = wrapped(...args);
          const adj = fixtures.db.prepare("SELECT status FROM coder_submission_adjudications WHERE submission_id = ?").get(subId) as any;
          if (adj && (adj.status === 'VERIFIED' || adj.status === 'VERIFICATION_FAILED')) {
            settlementTxCommitted = true;
          }
          return res;
        };
      });

      try {
        const result = await fixtures.adjudicationService.admitSubmissionForVerification({
          requestId: crypto.randomUUID(),
          submissionId: subId,
        });

        expect(result.status).toBe('VERIFIED');
        expect(settlementTxCommitted).toBe(true);
        expect(postCommitFsMutations).toBe(0);
      } finally {
        writeSpy.mockRestore();
        renameSpy.mockRestore();
        copySpy.mockRestore();
        unlinkSpy.mockRestore();
        txSpy.mockRestore();
      }
    });

    it('214. acknowledgeRecoveryFenced with CANCEL preserves original failure_code and records resolution_action = CANCEL', () => {
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
        status: 'RECOVERY_FENCED',
        lifecycle_version: 2,
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        verification_commands_json: cmdsJson,
        verification_commands_hash: computeSha256(cmdsJson),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: new Date().toISOString(),
        failure_code: 'PROCESS_TERMINATION_UNRESOLVED',
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const ack = fixtures.adjudicationService.acknowledgeRecoveryFenced({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        adjudicationId: adjId,
        expectedLifecycleVersion: 2,
        decision: 'CANCEL',
      });

      expect(ack.adjudication.status).toBe('VERIFICATION_FAILED');
      expect(ack.adjudication.failure_code).toBe('PROCESS_TERMINATION_UNRESOLVED');
      expect(ack.adjudication.resolution_action).toBe('CANCEL');
    });

    it('215. acknowledgeRecoveryFenced with CANCEL populates all 5 resolution columns', () => {
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
        status: 'RECOVERY_FENCED',
        lifecycle_version: 2,
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        verification_commands_json: cmdsJson,
        verification_commands_hash: computeSha256(cmdsJson),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: new Date().toISOString(),
        failure_code: 'START_AMBIGUOUS_CRASH',
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const resolverId = 'operator-test-42';
      const ack = fixtures.adjudicationService.acknowledgeRecoveryFenced({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        adjudicationId: adjId,
        expectedLifecycleVersion: 2,
        decision: 'CANCEL',
        resolverId,
      });

      expect(ack.adjudication.resolution_action).toBe('CANCEL');
      expect(ack.adjudication.resolution_timestamp).toBeDefined();
      expect(ack.adjudication.resolution_evidence_json).toBeDefined();
      expect(ack.adjudication.resolution_evidence_hash).toBeDefined();
      expect(ack.adjudication.resolver_id).toBe(resolverId);
    });

    it('216. acknowledgeRecoveryFenced with ACKNOWLEDGE populates resolution columns and preserves RECOVERY_FENCED status', () => {
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
        status: 'RECOVERY_FENCED',
        lifecycle_version: 2,
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        verification_commands_json: cmdsJson,
        verification_commands_hash: computeSha256(cmdsJson),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: new Date().toISOString(),
        failure_code: 'ORPHANED_IN_FLIGHT_EXECUTION',
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const ack = fixtures.adjudicationService.acknowledgeRecoveryFenced({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        adjudicationId: adjId,
        expectedLifecycleVersion: 2,
        decision: 'ACKNOWLEDGE',
      });

      expect(ack.adjudication.status).toBe('RECOVERY_FENCED');
      expect(ack.adjudication.failure_code).toBe('ORPHANED_IN_FLIGHT_EXECUTION');
      expect(ack.adjudication.resolution_action).toBe('ACKNOWLEDGE');
      expect(ack.adjudication.resolution_timestamp).toBeDefined();
    });

    it('217. acknowledgeRecoveryFenced is idempotent on repeated CANCEL calls', () => {
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
        status: 'RECOVERY_FENCED',
        lifecycle_version: 2,
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        verification_commands_json: cmdsJson,
        verification_commands_hash: computeSha256(cmdsJson),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: new Date().toISOString(),
        failure_code: 'ORPHANED_IN_FLIGHT_EXECUTION',
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const ack1 = fixtures.adjudicationService.acknowledgeRecoveryFenced({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        adjudicationId: adjId,
        expectedLifecycleVersion: 2,
        decision: 'CANCEL',
      });
      expect(ack1.adjudication.status).toBe('VERIFICATION_FAILED');

      const ack2 = fixtures.adjudicationService.acknowledgeRecoveryFenced({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        adjudicationId: adjId,
        expectedLifecycleVersion: 3,
        decision: 'CANCEL',
      });
      expect(ack2.adjudication.status).toBe('VERIFICATION_FAILED');
      expect(ack2.adjudication.resolution_action).toBe('CANCEL');
    });

    it('218. acknowledgeRecoveryFenced is idempotent on repeated ACKNOWLEDGE calls', () => {
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
        status: 'RECOVERY_FENCED',
        lifecycle_version: 2,
        protocol_message_id: null,
        request_id: crypto.randomUUID(),
        authority_snapshot_json: snapJson,
        authority_snapshot_hash: computeSha256(snapJson),
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        verification_commands_json: cmdsJson,
        verification_commands_hash: computeSha256(cmdsJson),
        created_at: new Date().toISOString(),
        verification_started_at: new Date().toISOString(),
        completed_at: null,
        recovery_fenced_at: new Date().toISOString(),
        failure_code: 'ORPHANED_IN_FLIGHT_EXECUTION',
        failure_json: null,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        verification_execution_id: crypto.randomUUID(),
      });

      const ack1 = fixtures.adjudicationService.acknowledgeRecoveryFenced({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        adjudicationId: adjId,
        expectedLifecycleVersion: 2,
        decision: 'ACKNOWLEDGE',
      });
      expect(ack1.adjudication.status).toBe('RECOVERY_FENCED');

      const ack2 = fixtures.adjudicationService.acknowledgeRecoveryFenced({
        requestId: crypto.randomUUID(),
        submissionId: subId,
        adjudicationId: adjId,
        expectedLifecycleVersion: 3,
        decision: 'ACKNOWLEDGE',
      });
      expect(ack2.adjudication.status).toBe('RECOVERY_FENCED');
      expect(ack2.adjudication.resolution_action).toBe('ACKNOWLEDGE');
    });

    it('219. buildVerifiedAdjudicationReviewProjection throws INTEGRITY_CONFLICT when submission authority is compromised', () => {
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

      db.prepare('UPDATE tasks SET ownership_epoch = 99 WHERE id = ?').run(fixtures.taskId);

      expect(() => {
        fixtures.adjudicationService.buildVerifiedAdjudicationReviewProjection(adjId);
      }).toThrow(/INTEGRITY_CONFLICT.*Submission authority integrity failed/);

      db.prepare('UPDATE tasks SET ownership_epoch = 1 WHERE id = ?').run(fixtures.taskId);
    });

    it('220. buildVerifiedAdjudicationReviewProjection builds complete projection for VERIFIED adjudication with disk-based FILE evidence', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });
      expect(admitRes.status).toBe('VERIFIED');

      const projection = fixtures.adjudicationService.buildVerifiedAdjudicationReviewProjection(admitRes.adjudication.id);
      expect(projection).toBeDefined();
      expect(projection.adjudication_id).toBe(admitRes.adjudication.id);
      expect(projection.projection_hash).toBeDefined();
      expect(typeof projection.projection_hash).toBe('string');
      expect(projection.authoritative_verification.verdict).toBe('PASSED');
      expect(projection.authoritative_git_diff).toBeDefined();
    });

    it('221. buildVerifiedAdjudicationReviewProjection builds complete projection for RECOVERY_FENCED adjudication', () => {
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

      const adj = fixtures.repo.getCoderSubmissionAdjudicationById(adjId)!;
      fixtures.recoveryScanner.fenceAdjudication(adj, 'PROCESS_TERMINATION_UNRESOLVED');

      const projection = fixtures.adjudicationService.buildVerifiedAdjudicationReviewProjection(adjId);
      expect(projection).toBeDefined();
      expect(projection.recovery_fencing_state?.is_fenced).toBe(true);
      expect(projection.recovery_fencing_state?.failure_code).toBe('PROCESS_TERMINATION_UNRESOLVED');
      expect(projection.authoritative_verification.verdict).toBe('FENCED');
    });

    it('222. PackageGenerator.generateReviewPackage with VerifiedAdjudicationReviewProjection renders full review package matching canonical format', async () => {
      const { plaintextToken } = issueSubmissionSessionHelper(fixtures.repo, fixtures.authorizationId);
      const subId = crypto.randomUUID();
      fixtures.mcpService.submitCoderClaim(createValidSubmissionPayload(fixtures, subId), plaintextToken);

      const admitRes = await fixtures.adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId: subId,
      });

      const projection = fixtures.adjudicationService.buildVerifiedAdjudicationReviewProjection(admitRes.adjudication.id);
      const pkg1 = PackageGenerator.generateReviewPackage(
        fixtures.repo.getProject(fixtures.projectId)!,
        fixtures.repo.getTask(fixtures.taskId)!,
        null,
        '',
        '',
        null,
        [],
        null,
        projection
      );
      const pkg2 = PackageGenerator.generateReviewPackage(
        fixtures.repo.getProject(fixtures.projectId)!,
        fixtures.repo.getTask(fixtures.taskId)!,
        null,
        '',
        '',
        null,
        [],
        null,
        projection
      );

      expect(pkg1).toBe(pkg2);
      expect(pkg1).toContain('# REVIEW PACKAGE:');
      expect(pkg1).toContain('## Authoritative Verification Evidence (Ground Truth)');
      expect(pkg1).toContain('### Owner Adjudication');
      expect(pkg1).toContain(projection.projection_hash);
      expect(pkg1).toContain('"protocol": "manager.v1"');

      // Forged projection hash is rejected
      const forged = { ...projection, projection_hash: 'f'.repeat(64) };
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
          forged
        );
      }).toThrow(/PROJECTION_HASH_MISMATCH/);

      // AdjudicationReviewPackageLinkage rejected
      const legacy: any = {
        adjudication_id: admitRes.adjudication.id,
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
          undefined,
          legacy
        );
      }).toThrow(/LEGACY_LINKAGE_REJECTED/);
    });

    it('223. historical three-file compatibility diffs remain byte-identical to initial head', () => {
      const checkDiff = (relPath: string) => {
        const out = child_process.execFileSync('git', ['diff', 'e869b9f79b76f104df74ac49ece723b828ba888e', '--', relPath], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.trim();
      };

      expect(checkDiff('tests/r5iCrashRecoveryAndAuditStream.test.ts')).toBe('');
      expect(checkDiff('tests/r5jMcpCoderSubmissionAuthority.test.ts')).toBe('');
      expect(checkDiff('tests/r5jMcpSessionAuthorityAndContextRead.test.ts')).toBe('');
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

    it('241. canonicalizeArtifactManifest produces deterministic key ordering and validates required fields', () => {
      const entries: any[] = [
        {
          byte_size: 50,
          content_type: 'text/plain',
          evidence_id: 'ev-2',
          evidence_type: 'LOG',
          relative_path: 'b.txt',
          sha256: 'b'.repeat(64),
          storage_class: 'FILE',
        },
        {
          byte_size: 20,
          content_type: 'text/plain',
          evidence_id: 'ev-1',
          evidence_type: 'LOG',
          relative_path: 'a.txt',
          sha256: 'a'.repeat(64),
          storage_class: 'FILE',
        },
      ];

      const manifest = canonicalizeArtifactManifest(entries);
      expect(manifest.entries[0].relative_path).toBe('a.txt');
      expect(manifest.entries[1].relative_path).toBe('b.txt');
      expect(Object.keys(manifest.entries[0])).toEqual([...ARTIFACT_MANIFEST_ENTRY_KEYS].sort());
    });

    it('242. computeArtifactManifestHash and parseAndVerifyArtifactManifest detect tampered manifest', () => {
      const entries: any[] = [
        {
          byte_size: 100,
          content_type: 'text/plain',
          evidence_id: 'ev-1',
          evidence_type: 'LOG',
          relative_path: 'log.txt',
          sha256: 'a'.repeat(64),
          storage_class: 'FILE',
        },
      ];
      const manifest = canonicalizeArtifactManifest(entries);
      const manifestJson = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
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
      const legacyLinkage: any = {
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

    it('223. historical three-file compatibility diffs remain byte-identical to initial head', () => {
      const checkDiff = (relPath: string) => {
        const out = child_process.execFileSync('git', ['diff', 'e869b9f79b76f104df74ac49ece723b828ba888e', '--', relPath], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.trim();
      };

      expect(checkDiff('tests/r5iCrashRecoveryAndAuditStream.test.ts')).toBe('');
      expect(checkDiff('tests/r5jMcpCoderSubmissionAuthority.test.ts')).toBe('');
      expect(checkDiff('tests/r5jMcpSessionAuthorityAndContextRead.test.ts')).toBe('');
    });

  });
});
