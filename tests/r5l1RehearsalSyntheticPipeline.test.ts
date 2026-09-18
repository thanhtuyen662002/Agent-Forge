import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import child_process from 'child_process';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

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
  taskTitleMarker?: string;
  _simulateSetupFailure?: boolean;
}): SyntheticRehearsalEnv {
  let createdTempDir: string | null = null;
  let openedDb: Database.Database | null = null;

  try {
    const taskTitle = options?.taskTitleMarker
      ? `Synthetic Task with marker ${options.taskTitleMarker}`
      : 'Synthetic Task 1';
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-r5l1-rehearsal-'));
    createdTempDir = tempDir;
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
    openedDb = db;
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);

    if (options?._simulateSetupFailure) {
      throw new Error('Simulated setup failure before returning env');
    }

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
    VALUES (?, ?, ?, 'CODING', 'LOW', 'LOW', 1, 3, 0, ?, 1, ?, ?)
  `).run(taskId, projectId, taskTitle, baseSha, now, now);

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
    taskTitle,
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
  } catch (setupError: any) {
    if (openedDb && openedDb.open) {
      try {
        openedDb.close();
      } catch {
        // preserve setupError
      }
    }
    if (createdTempDir && fs.existsSync(createdTempDir)) {
      try {
        fs.rmSync(createdTempDir, { recursive: true, force: true });
      } catch {
        // preserve setupError
      }
    }
    throw setupError;
  }
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

function getDbTotalChanges(db: Database.Database): number {
  return (db.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
}

export interface SafeCleanupOptions {
  clients?: Array<Client | null | undefined>;
  servers?: Array<{ close: () => Promise<void> } | null | undefined>;
  transports?: Array<{ close: () => Promise<void> } | null | undefined>;
  dbs?: Array<Database.Database | null | undefined>;
  tempDirs?: Array<string | null | undefined>;
  restoreTimers?: boolean;
  extraSteps?: Array<() => Promise<void> | void>;
}

export async function performSafeCleanup(options: SafeCleanupOptions): Promise<void> {
  const errors: Error[] = [];

  // 1. Timers
  if (options.restoreTimers) {
    try {
      vi.useRealTimers();
    } catch (err: any) {
      errors.push(err instanceof Error ? err : new Error(`Failed to restore timers: ${String(err)}`));
    }
  }

  // 2. MCP Clients
  if (options.clients) {
    for (const client of options.clients) {
      if (client) {
        try {
          await client.close();
        } catch (err: any) {
          errors.push(err instanceof Error ? err : new Error(`Failed to close MCP client: ${String(err)}`));
        }
      }
    }
  }

  // 3. MCP Servers
  if (options.servers) {
    for (const server of options.servers) {
      if (server) {
        try {
          await server.close();
        } catch (err: any) {
          errors.push(err instanceof Error ? err : new Error(`Failed to close MCP server: ${String(err)}`));
        }
      }
    }
  }

  // 3b. MCP Transports (e.g. StdioClientTransport subprocesses)
  if (options.transports) {
    for (const transport of options.transports) {
      if (transport) {
        try {
          await transport.close();
        } catch (err: any) {
          errors.push(err instanceof Error ? err : new Error(`Failed to close MCP transport: ${String(err)}`));
        }
      }
    }
  }

  // 4. Custom extra steps
  if (options.extraSteps) {
    for (const step of options.extraSteps) {
      try {
        await step();
      } catch (err: any) {
        errors.push(err instanceof Error ? err : new Error(`Cleanup extra step failed: ${String(err)}`));
      }
    }
  }

  // 5. Databases
  if (options.dbs) {
    for (const db of options.dbs) {
      if (db && db.open) {
        try {
          db.close();
        } catch (err: any) {
          errors.push(err instanceof Error ? err : new Error(`Failed to close database: ${String(err)}`));
        }
      }
    }
  }

  // 6. Temporary directories
  if (options.tempDirs) {
    for (const dir of options.tempDirs) {
      if (dir) {
        try {
          if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
          }
          if (fs.existsSync(dir)) {
            errors.push(new Error(`Failed to remove temporary directory: ${dir} still exists`));
          }
        } catch (err: any) {
          errors.push(err instanceof Error ? err : new Error(`Failed to delete temporary directory "${dir}": ${String(err)}`));
        }
      }
    }
  }

  if (errors.length === 1) {
    throw errors[0];
  } else if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `Teardown encountered ${errors.length} cleanup errors:\n` + errors.map((e) => ` - ${e.message}`).join('\n')
    );
  }
}

let sharedTestRuntimeDir: string | null = null;

function getOrMaterializeTestRuntime(): string {
  if (sharedTestRuntimeDir && fs.existsSync(sharedTestRuntimeDir)) {
    return sharedTestRuntimeDir;
  }
  const projectRoot = path.resolve(__dirname, '..');
  const distElectronReview = path.join(projectRoot, 'dist-electron', 'mcp', 'stdio-review.js');
  const distElectronPkg = path.join(projectRoot, 'dist-electron', 'package.json');
  if (fs.existsSync(distElectronReview) && fs.existsSync(distElectronPkg)) {
    sharedTestRuntimeDir = path.join(projectRoot, 'dist-electron');
    return sharedTestRuntimeDir;
  }

  const tempRuntimeDir = path.join(os.tmpdir(), `af-mcp-test-runtime-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  fs.mkdirSync(tempRuntimeDir, { recursive: true });

  const tscBin = require.resolve('typescript/bin/tsc');
  child_process.execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.node.json', '--outDir', tempRuntimeDir], {
    cwd: projectRoot,
    stdio: 'pipe',
    encoding: 'utf8',
  });

  const manifestPath = path.join(tempRuntimeDir, 'package.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ type: 'commonjs' }, null, 2), 'utf8');

  const targetNodeModules = path.join(projectRoot, 'node_modules');
  const linkNodeModules = path.join(tempRuntimeDir, 'node_modules');
  if (!fs.existsSync(linkNodeModules) && fs.existsSync(targetNodeModules)) {
    const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(targetNodeModules, linkNodeModules, symlinkType);
  }

  sharedTestRuntimeDir = tempRuntimeDir;
  return sharedTestRuntimeDir;
}

async function verifyProcessTerminated(pid: number, maxWaitMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch (e: any) {
      if (e.code === 'ESRCH') {
        return true;
      }
      throw e;
    }
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (e: any) {
    return e.code === 'ESRCH';
  }
}

describe('R5L1 Rehearsal Synthetic Pipeline Suite', () => {
  let env: SyntheticRehearsalEnv | null = null;

  afterAll(async () => {
    const projectRoot = path.resolve(__dirname, '..');
    const distElectronDir = path.join(projectRoot, 'dist-electron');
    if (sharedTestRuntimeDir && sharedTestRuntimeDir !== distElectronDir && fs.existsSync(sharedTestRuntimeDir)) {
      try {
        fs.rmSync(sharedTestRuntimeDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  afterEach(async () => {
    const currentEnv = env;
    env = null;
    if (currentEnv) {
      await performSafeCleanup({
        dbs: [currentEnv.db],
        tempDirs: [currentEnv.tempDir],
        restoreTimers: true,
      });
    } else {
      vi.useRealTimers();
    }
  });

  // =========================================================================
  // SCENARIO 1: Complete Happy Path
  // Quarantined Submission -> Admission -> Verification -> Settlement -> Reviewer Read
  // =========================================================================
  it('1. Full synthetic pipeline: quarantined submission -> admission -> verification -> settlement -> reviewer read (zero-write)', async () => {
    const PROJECTION_CONFIDENTIAL_MARKER = 'FROZEN_PROJECTION_SECRET_MARKER_' + crypto.randomUUID();
    env = setupSyntheticRehearsalEnv({ failVerification: false, taskTitleMarker: PROJECTION_CONFIDENTIAL_MARKER });
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
      summary: `Synthetic execution completed with marker ${PROJECTION_CONFIDENTIAL_MARKER}`,
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
    expect(admitRes.adjudication.workspace_lease_id).toBeDefined();
    expect(typeof admitRes.adjudication.workspace_lease_id).toBe('string');
    const workspaceLease = repo.getWorkspaceLease(admitRes.adjudication.workspace_lease_id!);
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

    // --- STEP 6: Reviewer MCP Tool & Resource Read (Zero-Write over InMemoryTransport) ---
    const issuance = reviewerService.issueReviewerSession({
      adjudication_id: adjudicationId,
      reviewer_agent_id: env.agentIdReviewer,
      reviewer_provider_id: env.providerId,
      reviewer_account_id: env.reviewerAccountId,
      reviewer_resource_id: env.reviewerResourceId,
      duration_seconds: 3600,
    });
    expect(issuance.raw_token).toBeDefined();

    let mcpServer: any | null = null;
    let mcpClient: Client | null = null;

    try {
      mcpServer = buildAgentForgeReviewerMcpServer({
        db,
        reviewerToken: issuance.raw_token,
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await mcpServer.connect(serverTransport);
      mcpClient = new Client({ name: 'synthetic-reviewer-client', version: '1.0.0' });
      await mcpClient.connect(clientTransport);

      // Baseline database state before reviewer reads
      const changesBefore = getDbTotalChanges(db);
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
      // Verify confidential marker is present in successful tool projection read
      expect(toolText).toContain(PROJECTION_CONFIDENTIAL_MARKER);

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
      // Verify confidential marker is present in successful resource projection read
      expect(resourceText).toContain(PROJECTION_CONFIDENTIAL_MARKER);

      // Assert Zero-Write: no row modifications and no data version bump during reads
      const changesAfter = getDbTotalChanges(db);
      const dataVersionAfter = db.pragma('data_version', { simple: true }) as number;
      expect(changesAfter).toBe(changesBefore);
      expect(dataVersionAfter).toBe(dataVersionBefore);
    } finally {
      await performSafeCleanup({
        clients: [mcpClient],
        servers: [mcpServer],
      });
    }

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

    // Workspace lease must be released - assertion is strictly enforced
    expect(admitRes.adjudication.workspace_lease_id).toBeDefined();
    expect(typeof admitRes.adjudication.workspace_lease_id).toBe('string');
    expect(admitRes.adjudication.workspace_lease_id!.length).toBeGreaterThan(0);
    const lease = repo.getWorkspaceLease(admitRes.adjudication.workspace_lease_id!);
    expect(lease).toBeDefined();
    expect(lease?.state).toBe('RELEASED');
    expect(lease?.released_at).not.toBeNull();

    // Disposition must record failure
    const dispositions = repo.getCoderSubmissionDispositions(submissionId);
    const failDisp = dispositions.find((d) => d.disposition_event === 'REJECTED');
    expect(failDisp).toBeDefined();
    expect(failDisp?.disposition_reason).toBe('FENCED_PRECONDITION');
  });

  // =========================================================================
  // SCENARIO 3: Reviewer Read Rejection Branches
  // Expired token, revoked session, cross-adjudication, task-state drift, projection tamper
  // =========================================================================
  it('3. Reviewer read rejection branches: expired token, revoked session, cross-adjudication, and task-state drift', async () => {
    const REJECTION_PROJECTION_MARKER = 'FROZEN_REJECTION_PROJECTION_MARKER_' + crypto.randomUUID();
    env = setupSyntheticRehearsalEnv({ failVerification: false, taskTitleMarker: REJECTION_PROJECTION_MARKER });
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
        summary: `Submission containing ${REJECTION_PROJECTION_MARKER}`,
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

    // --- Branch A: Expired Token (Tool & Resource, Zero-Write, Sanitized Error) ---
    const expiredIssuance = reviewerService.issueReviewerSession({
      adjudication_id: adjudicationId,
      reviewer_agent_id: revAgentA,
      reviewer_provider_id: env.providerId,
      reviewer_account_id: env.reviewerAccountId,
      reviewer_resource_id: env.reviewerResourceId,
      duration_seconds: 3600,
    });

    let clientExp: Client | null = null;
    let serverExpired: any | null = null;
    try {
      serverExpired = buildAgentForgeReviewerMcpServer({ db, reviewerToken: expiredIssuance.raw_token });
      const [cTransExp, sTransExp] = InMemoryTransport.createLinkedPair();
      await serverExpired.connect(sTransExp);
      clientExp = new Client({ name: 'expired-client', version: '1.0.0' });
      await clientExp.connect(cTransExp);

      // Fast-forward time past expiration
      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.now() + 7200 * 1000));

      // Tool Call Rejection
      const tcBeforeTool = getDbTotalChanges(db);
      const expiredToolCall = await clientExp.callTool({
        name: REVIEWER_TOOL_NAME,
        arguments: { adjudication_id: adjudicationId },
      });
      const tcAfterTool = getDbTotalChanges(db);
      expect(tcAfterTool).toBe(tcBeforeTool);
      expect(expiredToolCall.isError).toBe(true);
      const toolErrText = (expiredToolCall.content[0] as { text: string }).text;
      expect(toolErrText).toContain('TOKEN_EXPIRED');
      expect(toolErrText).not.toContain(REJECTION_PROJECTION_MARKER);
      expect(toolErrText).not.toContain(expiredIssuance.raw_token);
      expect(toolErrText).not.toContain('authoritative_verification');
      expect(toolErrText).not.toContain('untrusted_claim');

      // Resource Read Rejection
      const tcBeforeRes = getDbTotalChanges(db);
      const expiredResourceRes = await clientExp.readResource({
        uri: `agentforge://reviews/packages/${adjudicationId}`,
      });
      const tcAfterRes = getDbTotalChanges(db);
      expect(tcAfterRes).toBe(tcBeforeRes);
      const resErrText = (expiredResourceRes.contents[0] as { text: string }).text;
      expect(resErrText).toContain('TOKEN_EXPIRED');
      expect(resErrText).not.toContain(REJECTION_PROJECTION_MARKER);
      expect(resErrText).not.toContain(expiredIssuance.raw_token);
      expect(resErrText).not.toContain('authoritative_verification');
      expect(resErrText).not.toContain('untrusted_claim');
    } finally {
      await performSafeCleanup({
        clients: [clientExp],
        servers: [serverExpired],
        restoreTimers: true,
      });
    }

    // --- Branch B: Revoked Session (Tool & Resource, Zero-Write, Sanitized Error) ---
    const revokedIssuance = reviewerService.issueReviewerSession({
      adjudication_id: adjudicationId,
      reviewer_agent_id: revAgentB,
      reviewer_provider_id: env.providerId,
      reviewer_account_id: env.reviewerAccountId,
      reviewer_resource_id: env.reviewerResourceId,
      duration_seconds: 3600,
    });
    reviewerService.revokeReviewerSession(revokedIssuance.session.id, 'Security revocation for test');

    let clientRev: Client | null = null;
    let serverRevoked: any | null = null;
    try {
      serverRevoked = buildAgentForgeReviewerMcpServer({ db, reviewerToken: revokedIssuance.raw_token });
      const [cTransRev, sTransRev] = InMemoryTransport.createLinkedPair();
      await serverRevoked.connect(sTransRev);
      clientRev = new Client({ name: 'revoked-client', version: '1.0.0' });
      await clientRev.connect(cTransRev);

      // Tool Call Rejection
      const tcBeforeTool = getDbTotalChanges(db);
      const revokedToolCall = await clientRev.callTool({
        name: REVIEWER_TOOL_NAME,
        arguments: { adjudication_id: adjudicationId },
      });
      const tcAfterTool = getDbTotalChanges(db);
      expect(tcAfterTool).toBe(tcBeforeTool);
      expect(revokedToolCall.isError).toBe(true);
      const toolErrText = (revokedToolCall.content[0] as { text: string }).text;
      expect(toolErrText).toContain('TOKEN_REVOKED');
      expect(toolErrText).not.toContain(REJECTION_PROJECTION_MARKER);
      expect(toolErrText).not.toContain(revokedIssuance.raw_token);
      expect(toolErrText).not.toContain('authoritative_verification');
      expect(toolErrText).not.toContain('untrusted_claim');

      // Resource Read Rejection
      const tcBeforeRes = getDbTotalChanges(db);
      const revokedResourceRes = await clientRev.readResource({
        uri: `agentforge://reviews/packages/${adjudicationId}`,
      });
      const tcAfterRes = getDbTotalChanges(db);
      expect(tcAfterRes).toBe(tcBeforeRes);
      const resErrText = (revokedResourceRes.contents[0] as { text: string }).text;
      expect(resErrText).toContain('TOKEN_REVOKED');
      expect(resErrText).not.toContain(REJECTION_PROJECTION_MARKER);
      expect(resErrText).not.toContain(revokedIssuance.raw_token);
      expect(resErrText).not.toContain('authoritative_verification');
      expect(resErrText).not.toContain('untrusted_claim');
    } finally {
      await performSafeCleanup({
        clients: [clientRev],
        servers: [serverRevoked],
      });
    }

    // --- Branch C: Cross-Adjudication Access Rejection (Tool & Resource, Zero-Write, Sanitized Error) ---
    const validIssuance = reviewerService.issueReviewerSession({
      adjudication_id: adjudicationId,
      reviewer_agent_id: revAgentC,
      reviewer_provider_id: env.providerId,
      reviewer_account_id: env.reviewerAccountId,
      reviewer_resource_id: env.reviewerResourceId,
      duration_seconds: 3600,
    });

    let clientVal: Client | null = null;
    let serverValid: any | null = null;
    try {
      serverValid = buildAgentForgeReviewerMcpServer({ db, reviewerToken: validIssuance.raw_token });
      const [cTransVal, sTransVal] = InMemoryTransport.createLinkedPair();
      await serverValid.connect(sTransVal);
      clientVal = new Client({ name: 'valid-client', version: '1.0.0' });
      await clientVal.connect(cTransVal);

      const foreignAdjudicationId = crypto.randomUUID();

      // Tool Call Rejection
      const tcBeforeTool = getDbTotalChanges(db);
      const crossAdjToolCall = await clientVal.callTool({
        name: REVIEWER_TOOL_NAME,
        arguments: { adjudication_id: foreignAdjudicationId },
      });
      const tcAfterTool = getDbTotalChanges(db);
      expect(tcAfterTool).toBe(tcBeforeTool);
      expect(crossAdjToolCall.isError).toBe(true);
      const toolErrText = (crossAdjToolCall.content[0] as { text: string }).text;
      expect(toolErrText).toContain('PERMISSION_DENIED');
      expect(toolErrText).not.toContain(REJECTION_PROJECTION_MARKER);
      expect(toolErrText).not.toContain(validIssuance.raw_token);
      expect(toolErrText).not.toContain('authoritative_verification');
      expect(toolErrText).not.toContain('untrusted_claim');

      // Resource Read Rejection
      const tcBeforeRes = getDbTotalChanges(db);
      const crossAdjResourceRes = await clientVal.readResource({
        uri: `agentforge://reviews/packages/${foreignAdjudicationId}`,
      });
      const tcAfterRes = getDbTotalChanges(db);
      expect(tcAfterRes).toBe(tcBeforeRes);
      const resErrText = (crossAdjResourceRes.contents[0] as { text: string }).text;
      expect(resErrText).toContain('PERMISSION_DENIED');
      expect(resErrText).not.toContain(REJECTION_PROJECTION_MARKER);
      expect(resErrText).not.toContain(validIssuance.raw_token);
      expect(resErrText).not.toContain('authoritative_verification');
      expect(resErrText).not.toContain('untrusted_claim');
    } finally {
      await performSafeCleanup({
        clients: [clientVal],
        servers: [serverValid],
      });
    }

    // --- Branch D: Stale Authority (Task State Drift) Rejection ---
    // If task leaves REVIEW_READY state, live authority fence rejects the reviewer read
    db.prepare(`UPDATE tasks SET state = 'CODING' WHERE id = ?`).run(env.taskId);

    let clientDrift: Client | null = null;
    let serverDrift: any | null = null;
    try {
      serverDrift = buildAgentForgeReviewerMcpServer({ db, reviewerToken: validIssuance.raw_token });
      const [cTransDrift, sTransDrift] = InMemoryTransport.createLinkedPair();
      await serverDrift.connect(sTransDrift);
      clientDrift = new Client({ name: 'drift-client', version: '1.0.0' });
      await clientDrift.connect(cTransDrift);

      // Tool Call Rejection
      const tcBeforeTool = getDbTotalChanges(db);
      const driftToolCall = await clientDrift.callTool({
        name: REVIEWER_TOOL_NAME,
        arguments: { adjudication_id: adjudicationId },
      });
      const tcAfterTool = getDbTotalChanges(db);
      expect(tcAfterTool).toBe(tcBeforeTool);
      expect(driftToolCall.isError).toBe(true);
      const toolErrText = (driftToolCall.content[0] as { text: string }).text;
      expect(toolErrText).toContain('TASK_STATE_INVALID');
      expect(toolErrText).not.toContain(REJECTION_PROJECTION_MARKER);
      expect(toolErrText).not.toContain(validIssuance.raw_token);
      expect(toolErrText).not.toContain('authoritative_verification');
      expect(toolErrText).not.toContain('untrusted_claim');

      // Resource Read Rejection
      const tcBeforeRes = getDbTotalChanges(db);
      const driftResourceRes = await clientDrift.readResource({
        uri: `agentforge://reviews/packages/${adjudicationId}`,
      });
      const tcAfterRes = getDbTotalChanges(db);
      expect(tcAfterRes).toBe(tcBeforeRes);
      const resErrText = (driftResourceRes.contents[0] as { text: string }).text;
      expect(resErrText).toContain('TASK_STATE_INVALID');
      expect(resErrText).not.toContain(REJECTION_PROJECTION_MARKER);
      expect(resErrText).not.toContain(validIssuance.raw_token);
      expect(resErrText).not.toContain('authoritative_verification');
      expect(resErrText).not.toContain('untrusted_claim');
    } finally {
      await performSafeCleanup({
        clients: [clientDrift],
        servers: [serverDrift],
        extraSteps: [
          () => {
            // Restore task state to REVIEW_READY
            db.prepare(`UPDATE tasks SET state = 'REVIEW_READY' WHERE id = ?`).run(env!.taskId);
          },
        ],
      });
    }
  });

  // =========================================================================
  // SCENARIO 4: Teardown Audit & Process Termination Receipt
  // =========================================================================
  it('4. Teardown audit: process termination receipt, worktree pruning, connection closing, and clean directory deletion', async () => {
    // Dedicated isolated environment for teardown verification
    const testEnv = setupSyntheticRehearsalEnv({ failVerification: false });
    let client: Client | null = null;
    let server: any | null = null;
    let tempDirCleaned = false;

    try {
      const { repo, db, mcpService, adjudicationService, reviewerService } = testEnv;

      // 1. Execute an admission and verification cycle
      const { plaintextToken } = issueSubmissionSession(repo, testEnv.authorizationId);
      const submissionId = crypto.randomUUID();
      mcpService.submitCoderClaim(
        {
          submission_id: submissionId,
          authorization_id: testEnv.authorizationId,
          project_id: testEnv.projectId,
          task_id: testEnv.taskId,
          attempt_id: testEnv.attemptId,
          assignment_id: testEnv.assignmentId,
          task_ownership_epoch: 1,
          base_sha: testEnv.baseSha,
          repository_head_sha: testEnv.repoHeadSha,
          status: 'COMPLETED',
          summary: 'Submission for teardown audit',
          changed_files: ['README.md'],
          tests_claimed: ['test-teardown'],
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

      // 2. Authoritative Process Termination Receipt Verification
      // Inspect execution observation: proves process termination truth is proven and recorded
      expect(admitRes.status).toBe('VERIFIED');
      expect(admitRes.adjudication).toBeDefined();
      const adj = repo.getCoderSubmissionAdjudicationById(admitRes.adjudication.id);
      expect(adj).toBeDefined();
      expect(adj!.verification_result_envelope_json).toBeDefined();
      const envelope = JSON.parse(adj!.verification_result_envelope_json!);
      expect(envelope.process_start_classification).toBe('SPAWNED_PROVEN');
      expect(envelope.termination_classification).toBe('TERMINATION_PROVEN');
      expect(envelope.exit_classification).toBe('EXIT_ZERO');

      const testRun = repo.getTestRun(adj!.test_run_id!);
      expect(testRun).toBeDefined();
      expect(testRun?.exit_code).toBe(0);

      // Verify no dangling active process records in SQLite (process_runs table)
      const activeProcesses = (db.prepare("SELECT COUNT(*) as c FROM process_runs WHERE status = 'RUNNING'").get() as { c: number }).c;
      expect(activeProcesses).toBe(0);

      // 3. Worktree Pruning Verification
      // Verification worktree created during sealed execution must be pruned cleanly
      const worktreeList = child_process
        .execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: testEnv.repoDir, encoding: 'utf8' })
        .trim();
      const activeWorktrees = worktreeList.split('\n').filter((l) => l.startsWith('worktree '));
      expect(activeWorktrees).toHaveLength(1); // Only root repository worktree remains

      // 4. Setup MCP server & client to verify connection closing
      const issuance = reviewerService.issueReviewerSession({
        adjudication_id: admitRes.adjudication.id,
        reviewer_agent_id: testEnv.agentIdReviewer,
        reviewer_provider_id: testEnv.providerId,
        reviewer_account_id: testEnv.reviewerAccountId,
        reviewer_resource_id: testEnv.reviewerResourceId,
        duration_seconds: 3600,
      });

      server = buildAgentForgeReviewerMcpServer({ db, reviewerToken: issuance.raw_token });
      const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
      await server.connect(sTrans);
      client = new Client({ name: 'teardown-client', version: '1.0.0' });
      await client.connect(cTrans);

      // Verify connected
      const toolRes = await client.callTool({
        name: REVIEWER_TOOL_NAME,
        arguments: { adjudication_id: admitRes.adjudication.id },
      });
      expect(toolRes.isError).toBeFalsy();
    } finally {
      // Guaranteed cleanup even if assertions fail
      await performSafeCleanup({
        clients: [client],
        servers: [server],
        dbs: [testEnv.db],
        tempDirs: [testEnv.tempDir],
        restoreTimers: true,
      });
      tempDirCleaned = !fs.existsSync(testEnv.tempDir);
    }

    // Verify temp directory has actually vanished from filesystem
    expect(tempDirCleaned).toBe(true);
    expect(fs.existsSync(testEnv.tempDir)).toBe(false);
  });

  // =========================================================================
  // SCENARIO 5: Teardown Helper Resilience Under Partial Failure
  // =========================================================================
  it('5. Shared teardown helper resilience: error in earlier step does not block subsequent steps and propagates error', async () => {
    const dummyTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-test-cleanup-resilience-'));
    const dummyDbPath = path.join(dummyTempDir, 'dummy.db');
    const dummyDb = new Database(dummyDbPath);

    expect(fs.existsSync(dummyTempDir)).toBe(true);
    expect(dummyDb.open).toBe(true);

    // Simulated failing server whose close method throws an error
    const simulatedError = new Error('Simulated server close failure');
    const failingServer = {
      close: async () => {
        throw simulatedError;
      },
    };

    let caughtError: Error | null = null;
    try {
      await performSafeCleanup({
        servers: [failingServer],
        dbs: [dummyDb],
        tempDirs: [dummyTempDir],
        restoreTimers: true,
      });
    } catch (err: any) {
      caughtError = err;
    }

    // 1. Error was propagated and not swallowed
    expect(caughtError).not.toBeNull();
    expect(caughtError?.message).toContain('Simulated server close failure');

    // 2. Subsequent steps still executed despite the earlier failure:
    // - Database was closed
    expect(dummyDb.open).toBe(false);
    // - Temporary directory was deleted
    expect(fs.existsSync(dummyTempDir)).toBe(false);
  });

  // =========================================================================
  // SCENARIO 6: Real Stdio Subprocess MCP Reviewer Read (Happy Path)
  // Tool call & Resource read over real OS subprocess, zero DB mutation,
  // secret exclusion from logs, authoritative OS PID termination proof
  // =========================================================================
  it('6. Real stdio subprocess MCP reviewer read: tool call & resource read, zero-write, zero token leak in stderr/stdout, OS process termination receipt, and clean directory deletion', async () => {
    const PROJECTION_CONFIDENTIAL_MARKER = 'FROZEN_PROJECTION_STDIO_SECRET_' + crypto.randomUUID();
    const testEnv = setupSyntheticRehearsalEnv({ failVerification: false, taskTitleMarker: PROJECTION_CONFIDENTIAL_MARKER });
    let transport: StdioClientTransport | null = null;
    let client: Client | null = null;
    let subprocessPid: number | null = null;
    let stderrOutput = '';

    try {
      const { repo, db, mcpService, adjudicationService, reviewerService } = testEnv;

      // 1. Quarantined submission -> admission -> verification -> settlement
      const { plaintextToken } = issueSubmissionSession(repo, testEnv.authorizationId);
      const submissionId = crypto.randomUUID();
      mcpService.submitCoderClaim(
        {
          submission_id: submissionId,
          authorization_id: testEnv.authorizationId,
          project_id: testEnv.projectId,
          task_id: testEnv.taskId,
          attempt_id: testEnv.attemptId,
          assignment_id: testEnv.assignmentId,
          task_ownership_epoch: 1,
          base_sha: testEnv.baseSha,
          repository_head_sha: testEnv.repoHeadSha,
          status: 'COMPLETED',
          summary: `Stdio subprocess happy path with marker ${PROJECTION_CONFIDENTIAL_MARKER}`,
          changed_files: ['README.md'],
          tests_claimed: ['test-stdio'],
          blockers: [],
          review_requested: true,
          client_metadata: { client_name: 'synthetic-coder-agent', client_version: '1.0.0', client_session_mode: 'CLI_EXTERNAL' },
        },
        plaintextToken
      );

      const admitRes = await adjudicationService.admitSubmissionForVerification({
        requestId: crypto.randomUUID(),
        submissionId,
      });
      expect(admitRes.status).toBe('VERIFIED');
      expect(admitRes.adjudication).toBeDefined();
      const adjudicationId = admitRes.adjudication.id;

      // 2. Issue reviewer session
      const issuance = reviewerService.issueReviewerSession({
        adjudication_id: adjudicationId,
        reviewer_agent_id: testEnv.agentIdReviewer,
        reviewer_provider_id: testEnv.providerId,
        reviewer_account_id: testEnv.reviewerAccountId,
        reviewer_resource_id: testEnv.reviewerResourceId,
        duration_seconds: 3600,
      });
      const rawToken = issuance.raw_token;
      expect(rawToken).toBeDefined();

      // 3. Spawn real stdio subprocess using StdioClientTransport
      const runtimeDir = getOrMaterializeTestRuntime();
      const stdioScript = path.join(runtimeDir, 'mcp', 'stdio-review.js');
      expect(fs.existsSync(stdioScript)).toBe(true);

      transport = new StdioClientTransport({
        command: process.execPath,
        args: [stdioScript],
        env: {
          AGENTFORGE_MCP_DB_PATH: testEnv.dbPath,
          AGENTFORGE_MCP_REVIEWER_TOKEN: rawToken,
          NODE_PATH: path.resolve(__dirname, '..', 'node_modules'),
        },
        cwd: testEnv.tempDir,
        stderr: 'pipe',
      });

      if (transport.stderr) {
        transport.stderr.on('data', (chunk: Buffer | string) => {
          stderrOutput += chunk.toString();
        });
      }

      client = new Client({ name: 'synthetic-reviewer-stdio-client', version: '1.0.0' });
      await client.connect(transport);

      subprocessPid = transport.pid;
      expect(subprocessPid).toBeDefined();
      expect(typeof subprocessPid).toBe('number');
      expect(subprocessPid!).toBeGreaterThan(0);

      // Verify subprocess is alive at OS level
      let initialPidAlive = false;
      try {
        process.kill(subprocessPid!, 0);
        initialPidAlive = true;
      } catch {
        initialPidAlive = false;
      }
      expect(initialPidAlive).toBe(true);

      // 4. Baseline database state before stdio reviewer reads
      const tcBeforeReads = getDbTotalChanges(db);
      const dataVersionBefore = db.pragma('data_version', { simple: true }) as number;

      // 5. Reviewer reads review package via MCP Tool over stdio subprocess
      const toolRes = await client.callTool({
        name: REVIEWER_TOOL_NAME,
        arguments: { adjudication_id: adjudicationId },
      });
      expect(toolRes.isError).toBeFalsy();
      expect(toolRes.content).toHaveLength(1);
      const toolText = (toolRes.content[0] as { type: 'text'; text: string }).text;
      const toolPackage = JSON.parse(toolText);
      expect(toolPackage.adjudication.id).toBe(adjudicationId);
      expect(computeSha256(toolText)).toBe(issuance.session.projection_hash);
      expect(toolText).toContain(PROJECTION_CONFIDENTIAL_MARKER);

      // Prove zero writes across tool read
      expect(getDbTotalChanges(db)).toBe(tcBeforeReads);
      expect(db.pragma('data_version', { simple: true }) as number).toBe(dataVersionBefore);

      // 6. Reviewer reads review package via MCP Resource over stdio subprocess
      const resourceUri = `agentforge://reviews/packages/${adjudicationId}`;
      const resourceRes = await client.readResource({ uri: resourceUri });
      expect(resourceRes.contents).toHaveLength(1);
      const resourceItem = resourceRes.contents[0] as { uri: string; mimeType?: string; text?: string };
      expect(resourceItem.uri).toBe(resourceUri);
      expect(resourceItem.mimeType).toBe(REVIEWER_MIME_TYPE);
      expect(resourceItem.text).toBeDefined();
      expect(computeSha256(resourceItem.text!)).toBe(issuance.session.projection_hash);
      expect(resourceItem.text!).toContain(PROJECTION_CONFIDENTIAL_MARKER);

      // Prove zero writes across resource read
      expect(getDbTotalChanges(db)).toBe(tcBeforeReads);
      expect(db.pragma('data_version', { simple: true }) as number).toBe(dataVersionBefore);

      // 7. Token exclusion verification
      expect(stderrOutput).not.toContain(rawToken);
      expect(toolText).not.toContain(rawToken);
      expect(resourceItem.text!).not.toContain(rawToken);
    } finally {
      // 8. Controlled shutdown & teardown via performSafeCleanup
      await performSafeCleanup({
        clients: [client],
        transports: [transport],
        dbs: [testEnv.db],
        tempDirs: [testEnv.tempDir],
        restoreTimers: true,
      });
    }

    // 9. Authoritative OS process termination receipt verification
    expect(subprocessPid).not.toBeNull();
    const isTerminated = await verifyProcessTerminated(subprocessPid!);
    expect(isTerminated).toBe(true);

    // 10. Clean temp directory deletion verification
    expect(fs.existsSync(testEnv.tempDir)).toBe(false);
  });

  // =========================================================================
  // SCENARIO 7: Real Stdio Subprocess MCP Reviewer Rejections
  // Expired token and cross-adjudication over stdio subprocess,
  // zero-write, no token/projection leak, OS process termination proof
  // =========================================================================
  it('7. Real stdio subprocess MCP reviewer rejection: revoked token & cross-adjudication over stdio subprocess, zero-write, no token/projection leak, OS process termination', async () => {
    const REJECTION_PROJECTION_MARKER = 'FROZEN_REJECTION_STDIO_MARKER_' + crypto.randomUUID();
    const testEnv = setupSyntheticRehearsalEnv({ failVerification: false, taskTitleMarker: REJECTION_PROJECTION_MARKER });
    const runtimeDir = getOrMaterializeTestRuntime();
    const stdioScript = path.join(runtimeDir, 'mcp', 'stdio-review.js');

    try {
      const { repo, db, mcpService, adjudicationService, reviewerService } = testEnv;

      const { plaintextToken } = issueSubmissionSession(repo, testEnv.authorizationId);
      const submissionId = crypto.randomUUID();
      mcpService.submitCoderClaim(
        {
          submission_id: submissionId,
          authorization_id: testEnv.authorizationId,
          project_id: testEnv.projectId,
          task_id: testEnv.taskId,
          attempt_id: testEnv.attemptId,
          assignment_id: testEnv.assignmentId,
          task_ownership_epoch: 1,
          base_sha: testEnv.baseSha,
          repository_head_sha: testEnv.repoHeadSha,
          status: 'COMPLETED',
          summary: `Submission containing ${REJECTION_PROJECTION_MARKER}`,
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

      // --- Branch A: Revoked Token in DB over Stdio Subprocess ---
      const revokedIssuance = reviewerService.issueReviewerSession({
        adjudication_id: adjudicationId,
        reviewer_agent_id: testEnv.agentIdReviewer,
        reviewer_provider_id: testEnv.providerId,
        reviewer_account_id: testEnv.reviewerAccountId,
        reviewer_resource_id: testEnv.reviewerResourceId,
        duration_seconds: 3600,
      });

      // Revoke the session via reviewerService (strictly complying with immutable trigger)
      reviewerService.revokeReviewerSession(revokedIssuance.session.id, 'Security revocation for stdio rehearsal');

      let transportRev: StdioClientTransport | null = null;
      let clientRev: Client | null = null;
      let revStderr = '';
      let revPid: number | null = null;

      try {
        transportRev = new StdioClientTransport({
          command: process.execPath,
          args: [stdioScript],
          env: {
            AGENTFORGE_MCP_DB_PATH: testEnv.dbPath,
            AGENTFORGE_MCP_REVIEWER_TOKEN: revokedIssuance.raw_token,
            NODE_PATH: path.resolve(__dirname, '..', 'node_modules'),
          },
          cwd: testEnv.tempDir,
          stderr: 'pipe',
        });
        if (transportRev.stderr) {
          transportRev.stderr.on('data', (chunk) => { revStderr += chunk.toString(); });
        }
        clientRev = new Client({ name: 'revoked-stdio-client', version: '1.0.0' });
        await clientRev.connect(transportRev);
        revPid = transportRev.pid;

        // Tool Call Rejection
        const tcBeforeTool = getDbTotalChanges(db);
        const revokedToolCall = await clientRev.callTool({
          name: REVIEWER_TOOL_NAME,
          arguments: { adjudication_id: adjudicationId },
        });
        const tcAfterTool = getDbTotalChanges(db);
        expect(tcAfterTool).toBe(tcBeforeTool);
        expect(revokedToolCall.isError).toBe(true);
        const toolErrText = (revokedToolCall.content[0] as { text: string }).text;
        expect(toolErrText).toContain('TOKEN_REVOKED');
        expect(toolErrText).not.toContain(REJECTION_PROJECTION_MARKER);
        expect(toolErrText).not.toContain(revokedIssuance.raw_token);
        expect(toolErrText).not.toContain('authoritative_verification');
        expect(toolErrText).not.toContain('untrusted_claim');

        // Resource Read Rejection
        const tcBeforeRes = getDbTotalChanges(db);
        const revokedResourceRes = await clientRev.readResource({
          uri: `agentforge://reviews/packages/${adjudicationId}`,
        });
        const tcAfterRes = getDbTotalChanges(db);
        expect(tcAfterRes).toBe(tcBeforeRes);
        const resErrText = (revokedResourceRes.contents[0] as { text: string }).text;
        expect(resErrText).toContain('TOKEN_REVOKED');
        expect(resErrText).not.toContain(REJECTION_PROJECTION_MARKER);
        expect(resErrText).not.toContain(revokedIssuance.raw_token);
        expect(resErrText).not.toContain('authoritative_verification');
        expect(resErrText).not.toContain('untrusted_claim');

        // Stderr token exclusion
        expect(revStderr).not.toContain(revokedIssuance.raw_token);
      } finally {
        await performSafeCleanup({
          clients: [clientRev],
          transports: [transportRev],
        });
      }

      expect(revPid).not.toBeNull();
      expect(await verifyProcessTerminated(revPid!)).toBe(true);

      // --- Branch B: Cross-Adjudication Rejection over Stdio Subprocess ---
      const validAgentId = 'agent-rev-valid-' + crypto.randomUUID();
      db.prepare(`INSERT INTO agents (id, display_name, role, provider_resource_id, status, current_task_id, last_seen_at) VALUES (?, 'Valid Reviewer Agent', 'REVIEWER', ?, 'IDLE', NULL, ?)`).run(validAgentId, testEnv.reviewerResourceId, new Date().toISOString());

      const validIssuance = reviewerService.issueReviewerSession({
        adjudication_id: adjudicationId,
        reviewer_agent_id: validAgentId,
        reviewer_provider_id: testEnv.providerId,
        reviewer_account_id: testEnv.reviewerAccountId,
        reviewer_resource_id: testEnv.reviewerResourceId,
        duration_seconds: 3600,
      });

      const foreignAdjudicationId = crypto.randomUUID();
      let transportVal: StdioClientTransport | null = null;
      let clientVal: Client | null = null;
      let valStderr = '';
      let valPid: number | null = null;

      try {
        transportVal = new StdioClientTransport({
          command: process.execPath,
          args: [stdioScript],
          env: {
            AGENTFORGE_MCP_DB_PATH: testEnv.dbPath,
            AGENTFORGE_MCP_REVIEWER_TOKEN: validIssuance.raw_token,
            NODE_PATH: path.resolve(__dirname, '..', 'node_modules'),
          },
          cwd: testEnv.tempDir,
          stderr: 'pipe',
        });
        if (transportVal.stderr) {
          transportVal.stderr.on('data', (chunk) => { valStderr += chunk.toString(); });
        }
        clientVal = new Client({ name: 'valid-stdio-client', version: '1.0.0' });
        await clientVal.connect(transportVal);
        valPid = transportVal.pid;

        // Cross-adjudication tool call rejection
        const tcBeforeTool = getDbTotalChanges(db);
        const crossAdjToolCall = await clientVal.callTool({
          name: REVIEWER_TOOL_NAME,
          arguments: { adjudication_id: foreignAdjudicationId },
        });
        const tcAfterTool = getDbTotalChanges(db);
        expect(tcAfterTool).toBe(tcBeforeTool);
        expect(crossAdjToolCall.isError).toBe(true);
        const toolErrText = (crossAdjToolCall.content[0] as { text: string }).text;
        expect(toolErrText).toContain('PERMISSION_DENIED');
        expect(toolErrText).not.toContain(REJECTION_PROJECTION_MARKER);
        expect(toolErrText).not.toContain(validIssuance.raw_token);
        expect(toolErrText).not.toContain('authoritative_verification');
        expect(toolErrText).not.toContain('untrusted_claim');

        // Cross-adjudication resource read rejection
        const tcBeforeRes = getDbTotalChanges(db);
        const crossAdjResourceRes = await clientVal.readResource({
          uri: `agentforge://reviews/packages/${foreignAdjudicationId}`,
        });
        const tcAfterRes = getDbTotalChanges(db);
        expect(tcAfterRes).toBe(tcBeforeRes);
        const resErrText = (crossAdjResourceRes.contents[0] as { text: string }).text;
        expect(resErrText).toContain('PERMISSION_DENIED');
        expect(resErrText).not.toContain(REJECTION_PROJECTION_MARKER);
        expect(resErrText).not.toContain(validIssuance.raw_token);
        expect(resErrText).not.toContain('authoritative_verification');
        expect(resErrText).not.toContain('untrusted_claim');

        // Stderr token exclusion
        expect(valStderr).not.toContain(validIssuance.raw_token);
      } finally {
        await performSafeCleanup({
          clients: [clientVal],
          transports: [transportVal],
        });
      }

      expect(valPid).not.toBeNull();
      expect(await verifyProcessTerminated(valPid!)).toBe(true);
    } finally {
      await performSafeCleanup({
        dbs: [testEnv.db],
        tempDirs: [testEnv.tempDir],
        restoreTimers: true,
      });
    }

    expect(fs.existsSync(testEnv.tempDir)).toBe(false);
  });

  // =========================================================================
  // SCENARIO 8: Fixture Setup Cleanup Resilience
  // Abortive failure before returning env closes DB and deletes temp dir
  // =========================================================================
  it('8. Fixture setup cleanup: abortive failure before returning env closes DB and leaves no orphaned temp dir', () => {
    let capturedTempDir: string | null = null;
    const originalMkdtempSync = fs.mkdtempSync;
    const spyMkdtempSync = vi.spyOn(fs, 'mkdtempSync').mockImplementation(((prefix: string, options?: any) => {
      const result = originalMkdtempSync(prefix, options as any);
      capturedTempDir = result as string;
      return result;
    }) as any);

    try {
      expect(() => {
        setupSyntheticRehearsalEnv({ _simulateSetupFailure: true });
      }).toThrow('Simulated setup failure before returning env');

      expect(capturedTempDir).not.toBeNull();
      expect(fs.existsSync(capturedTempDir!)).toBe(false);
    } finally {
      spyMkdtempSync.mockRestore();
      if (capturedTempDir && fs.existsSync(capturedTempDir)) {
        fs.rmSync(capturedTempDir, { recursive: true, force: true });
      }
    }
  });
});
