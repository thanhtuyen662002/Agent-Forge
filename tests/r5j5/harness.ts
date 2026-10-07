import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { approveFixtureCommand } from '../helpers/verificationCapabilityFixture';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import child_process from 'child_process';
import { fileURLToPath } from 'url';
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

export interface FullAdjudicationFixtures {
  db: Database.Database;
  quarantineDir: string;
  authSnapshot: Record<string, unknown>;
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

export function createTestDatabase(dir: string, name: string): { db: Database.Database; dbPath: string } {
  const dbPath = path.join(dir, name);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  MigrationRunner.run(db, 23);
  return { db, dbPath };
}

export async function setupFullSubmissionGraph(db: Database.Database, projectRepoPath?: string, artifactsPath?: string): Promise<FullAdjudicationFixtures> {
  // Runnable fixtures use current owner authority; historical schema tests
  // still construct migration23 databases independently.
  MigrationRunner.run(db);
  const repo = new Repository(db);
  const eventService = new EventService(repo);
  const resolvedRepoPath = projectRepoPath ?? path.resolve(__dirname, '../..');
  fs.mkdirSync(path.join(resolvedRepoPath, 'temp-artifacts'), { recursive: true });
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
  const verificationCommand = { ...await approveFixtureCommand(repo, projectId, ['-v']), timeout_ms: 120000 };
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
      TEST: verificationCommand,
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
        TEST: verificationCommand,
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

export function issueSubmissionSessionHelper(
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

export function createValidSubmissionPayload(
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

/**
 * Static contract for the split:
 * - preserve every original declaration (402 total);
 * - preserve numeric labels 1..402 except the intentional missing 159;
 * - preserve the distinct corrective labels 236 and 236b;
 * - keep each behavioral cut's declarations in its declared file.
 *
 * This runs during module loading, so a malformed split fails before any
 * test can report a misleading green result.
 */
const R5J5_TEST_GROUPS: Readonly<Record<string, readonly string[]>> = {
  'group1-schema-authority.test.ts': Array.from({ length: 25 }, (_, i) => String(i + 1)),
  'group2-listing-integrity.test.ts': Array.from({ length: 15 }, (_, i) => String(i + 26)),
  'group3-owner-actions.test.ts': Array.from({ length: 16 }, (_, i) => String(i + 41)),
  'group4-admission-authority.test.ts': Array.from({ length: 17 }, (_, i) => String(i + 57)),
  'group5-linearization-execution.test.ts': Array.from({ length: 15 }, (_, i) => String(i + 74)),
  'group6-settlement-recovery.test.ts': Array.from({ length: 17 }, (_, i) => String(i + 89)),
  'group7a-review-package-ipc-ui.test.ts': Array.from({ length: 17 }, (_, i) => String(i + 106)),
  'group7b-corrective-authority.test.ts': Array.from({ length: 36 }, (_, i) => String(i + 123)),
  'group7c-durable-recovery.test.ts': Array.from({ length: 63 }, (_, i) => String(i + 160)),
  'group7d-workspace-artifacts.test.ts': [
    ...Array.from({ length: 14 }, (_, i) => String(i + 223)),
    '236b',
    ...Array.from({ length: 47 }, (_, i) => String(i + 237)),
  ],
  'group7e-canonical-recovery.test.ts': Array.from({ length: 44 }, (_, i) => String(i + 284)),
  'group7f-cancellation-snapshots.test.ts': Array.from({ length: 75 }, (_, i) => String(i + 328)),
};

export function assertR5J5TestInventory(): void {
  const splitRoot = path.dirname(fileURLToPath(import.meta.url));
  const actualByFile = new Map<string, string[]>();
  for (const [fileName, expected] of Object.entries(R5J5_TEST_GROUPS)) {
    const filePath = path.join(splitRoot, fileName);
    if (!fs.existsSync(filePath)) {
      throw new Error(`[R5J5_SPLIT_INVENTORY] Missing expected split file: ${fileName}`);
    }
    const source = fs.readFileSync(filePath, 'utf8');
    const labels = [...source.matchAll(/\bit\(\s*['"]([0-9]+[a-z]*)\./g)].map((match) => match[1]);
    actualByFile.set(fileName, labels);
    if (labels.length !== expected.length || labels.join('|') !== expected.join('|')) {
      throw new Error(
        `[R5J5_SPLIT_INVENTORY] ${fileName} expected ${expected.length} labels [${expected.join(',')}], got ${labels.length} [${labels.join(',')}]`
      );
    }
  }

  const allLabels = [...actualByFile.values()].flat();
  if (allLabels.length !== 402) {
    throw new Error(`[R5J5_SPLIT_INVENTORY] expected 402 test declarations, got ${allLabels.length}`);
  }
  const numericLabels = allLabels.filter((label) => /^\d+$/.test(label)).map(Number);
  const missing = Array.from({ length: 402 }, (_, i) => i + 1).filter((number) => !numericLabels.includes(number));
  if (missing.length !== 1 || missing[0] !== 159) {
    throw new Error(`[R5J5_SPLIT_INVENTORY] expected only numeric gap 159, got [${missing.join(',')}]`);
  }
  if (allLabels.filter((label) => label === '236').length !== 1 || allLabels.filter((label) => label === '236b').length !== 1) {
    throw new Error('[R5J5_SPLIT_INVENTORY] labels 236 and 236b must remain distinct and unique');
  }
  if (new Set(allLabels).size !== 402) {
    throw new Error('[R5J5_SPLIT_INVENTORY] duplicate test labels detected');
  }
}

assertR5J5TestInventory();
