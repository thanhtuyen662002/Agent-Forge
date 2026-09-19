import { vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import child_process from 'child_process';
import { Client } from '@modelcontextprotocol/client';

import { MigrationRunner } from '../../src/core/database/migrations';
import { Repository } from '../../src/core/database/repositories';
import {
  CoderSubmissionAdjudicationService,
} from '../../src/core/services/CoderSubmissionAdjudicationService';
import { VerificationService } from '../../src/core/services/VerificationService';
import { ArtifactStore } from '../../src/core/services/ArtifactStore';
import { McpSubmissionAuthorityService } from '../../src/core/services/McpSubmissionAuthorityService';
import { EventService } from '../../src/core/services/EventService';
import { TaskService } from '../../src/core/services/TaskService';
import { ProjectService } from '../../src/core/services/ProjectService';
import { ReviewerAuthorityService } from '../../src/mcp/reviewerAuthority';
import {
  generateSubmissionToken,
  computeAuthorityFingerprint,
} from '../../src/mcp/submissionProtocol';
import { computePayloadHash } from '../../src/core/services/ExecutionAuthorizationService';
import { ExecutionAuthorization } from '../../src/core/types/domain';
import { ContextBuilderService } from '../../src/core/services/ContextBuilderService';
import { ProviderRegistry } from '../../src/core/adapters/ProviderRegistry';
import { RoleAwareRoutingService } from '../../src/core/services/RoleAwareRoutingService';
import { WorkerSlotLeaseService } from '../../src/core/services/WorkerSlotLeaseService';
import { ExecutionAuthorizationService } from '../../src/core/services/ExecutionAuthorizationService';
import { GitWorktreeService, WorktreeOwnershipTuple } from '../../src/core/services/GitWorktreeService';
import { ProviderDispatchService } from '../../src/core/services/ProviderDispatchService';
import { ProcessRunner } from '../../src/core/services/ProcessRunner';
import {
  ProviderAdapter,
  AgentExecutionRequest,
  AgentExecutionResult,
  QuotaSnapshotInfo,
} from '../../src/core/adapters/ProviderAdapter';
import {
  Capability,
  ProviderHealthStatus,
  ProviderAdapterType,
} from '../../src/core/types/domain';

export function resolveGitExecutable(): string {
  if (process.platform === 'win32') {
    try {
      const out = child_process
        .execFileSync('where.exe', ['git'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .trim()
        .split(/\r?\n/)[0];
      if (out && fs.existsSync(out)) return path.resolve(out);
    } catch {}
    const defaultWinGit = 'C:\\Program Files\\Git\\cmd\\git.exe';
    if (fs.existsSync(defaultWinGit)) return defaultWinGit;
  } else {
    try {
      const out = child_process
        .execFileSync('which', ['git'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .trim();
      if (out && fs.existsSync(out)) return path.resolve(out);
    } catch {}
  }
  return path.resolve('git');
}

export class SyntheticLocalCliAdapter implements ProviderAdapter {
  readonly id: string;
  readonly name = 'Synthetic Local CLI Adapter';
  readonly adapterType: ProviderAdapterType = 'LOCAL_CLI';

  constructor(
    providerId: string,
    private gitExecutable: string,
    private repo: Repository,
    private artifactStore: ArtifactStore
  ) {
    this.id = providerId;
  }

  async getCapabilities(): Promise<Capability[]> {
    return ['CODING'];
  }

  async getHealth(): Promise<ProviderHealthStatus> {
    return 'AVAILABLE';
  }

  async getQuota(): Promise<QuotaSnapshotInfo> {
    return {
      remaining: 1000,
      total: 1000,
      unit: 'REQUESTS',
      source: 'PROVIDER_REPORTED',
      confidence: 1.0,
      resetAt: null,
    };
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const worktreePath = request.runtimeBinding?.workspace?.workingDirectory;
    if (!worktreePath || !fs.existsSync(worktreePath)) {
      throw new Error(`Worktree working directory does not exist: ${worktreePath}`);
    }

    // Execute real local Node child process inside worktree via ProcessRunner
    const scriptFile = path.join(worktreePath, 'synthetic_coder.js');
    fs.writeFileSync(
      scriptFile,
      "const fs = require('fs'); fs.appendFileSync('README.md', '\\n## Changes from synthetic coder subprocess\\n'); process.stdout.write('Subprocess successfully modified README.md\\n'); process.exit(0);",
      'utf8'
    );
    const procRes = await ProcessRunner.execute({
      executable: process.execPath,
      args: ['synthetic_coder.js'],
      cwd: worktreePath,
      timeoutMs: 30000,
      allowShell: false,
      repo: this.repo,
      artifactStore: this.artifactStore,
      projectId: request.projectId,
      taskId: request.taskId,
      attemptId: request.attemptId ?? null,
    });

    if (procRes.exitCode !== 0) {
      throw new Error(`Synthetic coder subprocess exited with code ${procRes.exitCode}: ${procRes.stderr}`);
    }

    // Commit changes inside worktree via Git CLI
    child_process.execFileSync(this.gitExecutable, ['config', 'user.name', 'Synthetic Coder Subprocess'], { cwd: worktreePath, stdio: 'ignore' });
    child_process.execFileSync(this.gitExecutable, ['config', 'user.email', 'coder-subprocess@agentforge.local'], { cwd: worktreePath, stdio: 'ignore' });
    child_process.execFileSync(this.gitExecutable, ['add', '.'], { cwd: worktreePath, stdio: 'ignore' });
    child_process.execFileSync(this.gitExecutable, ['commit', '-m', 'Commit from synthetic coder subprocess'], { cwd: worktreePath, stdio: 'ignore' });

    return {
      executionId: request.runtimeBinding?.executionId || crypto.randomUUID(),
      status: 'COMPLETED',
      stdoutEvidenceId: procRes.stdoutEvidenceId,
      stderrEvidenceId: procRes.stderrEvidenceId,
    };
  }

  async cancel(executionId: string): Promise<void> {}
}

export interface SyntheticRehearsalBootstrapEnv {
  tempDir: string;
  repoDir: string;
  managedWorktreesDir: string;
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
  contextBuilderService: ContextBuilderService;
  providerRegistry: ProviderRegistry;
  roleAwareRoutingService: RoleAwareRoutingService;
  workerSlotLeaseService: WorkerSlotLeaseService;
  authorizationService: ExecutionAuthorizationService;
  gitWorktreeService: GitWorktreeService;
  providerDispatchService: ProviderDispatchService;
  gitExecutable: string;
  projectId: string;
  providerId: string;
  coderAccountId: string;
  reviewerAccountId: string;
  coderResourceId: string;
  reviewerResourceId: string;
  roleIdCoder: string;
  roleIdReviewer: string;
  coderAgentProfileId: string;
  reviewerAgentProfileId: string;
  agentIdCoder: string;
  agentIdReviewer: string;
  workerSlotId: string;
  baseSha: string;
  testPassCommandId: string;
}

export function setupSyntheticRehearsalBootstrap(options?: {
  afterDatabaseOpened?: (resources: { tempDir: string; db: Database.Database }) => void;
}): SyntheticRehearsalBootstrapEnv {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-r5l1-rehearsal-bootstrap-'));
  const repoDir = path.join(tempDir, 'repo');
  const managedWorktreesDir = path.join(tempDir, 'managed-worktrees');
  let setupDb: Database.Database | undefined;
  try {
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(managedWorktreesDir, { recursive: true });

    const gitExecutable = resolveGitExecutable();

    // 1. Initialize a synthetic git repository
    child_process.execFileSync(gitExecutable, ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
    child_process.execFileSync(gitExecutable, ['config', 'user.name', 'Synthetic Bootstrap Agent'], { cwd: repoDir, stdio: 'ignore' });
    child_process.execFileSync(gitExecutable, ['config', 'user.email', 'synthetic-bootstrap@agentforge.local'], { cwd: repoDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Synthetic Rehearsal Project\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, 'solution.txt'), 'Initial codebase state\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, 'test_pass.js'), 'console.log("Synthetic test passed"); process.exit(0);\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, 'test_fail.js'), 'console.error("Synthetic test failed"); process.exit(1);\n', 'utf8');
    child_process.execFileSync(gitExecutable, ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
    child_process.execFileSync(gitExecutable, ['commit', '-m', 'Initial synthetic commit'], { cwd: repoDir, stdio: 'ignore' });

    const baseSha = child_process
      .execFileSync(gitExecutable, ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .toLowerCase();

    // 2. Initialize dedicated SQLite database and run all migrations
    const dbPath = path.join(tempDir, 'rehearsal.db');
    const db = new Database(dbPath);
    setupDb = db;
    options?.afterDatabaseOpened?.({ tempDir, db });
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);

    // 3. ArtifactStore & Services
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
    const contextBuilderService = new ContextBuilderService(repo);
    const providerRegistry = new ProviderRegistry();
    const roleAwareRoutingService = new RoleAwareRoutingService(repo, providerRegistry, eventService);
    const workerSlotLeaseService = new WorkerSlotLeaseService(repo);
    const authorizationService = new ExecutionAuthorizationService(repo, eventService);
    const gitWorktreeService = new GitWorktreeService({
      gitExecutable,
      repositoryRoot: repoDir,
      managedRoot: managedWorktreesDir,
    });
    const providerDispatchService = new ProviderDispatchService(
      providerRegistry,
      repo,
      eventService,
      gitWorktreeService
    );
    providerDispatchService.setGitWorktreeService(gitWorktreeService);

    const now = new Date().toISOString();
    const projectId = 'proj-synth-' + crypto.randomUUID();
    const providerId = 'prov-synth-' + crypto.randomUUID();
    const coderAccountId = 'acc-coder-' + crypto.randomUUID();
    const reviewerAccountId = 'acc-rev-' + crypto.randomUUID();
    const coderResourceId = 'res-coder-' + crypto.randomUUID();
    const reviewerResourceId = 'res-rev-' + crypto.randomUUID();
    const roleIdCoder = 'role-coder-' + crypto.randomUUID();
    const roleIdReviewer = 'role-rev-' + crypto.randomUUID();
    const coderAgentProfileId = 'prof-coder-' + crypto.randomUUID();
    const reviewerAgentProfileId = 'prof-rev-' + crypto.randomUUID();
    const agentIdCoder = 'agent-coder-' + crypto.randomUUID();
    const agentIdReviewer = 'agent-rev-' + crypto.randomUUID();
    const workerSlotId = 'slot-synth-' + crypto.randomUUID();
    const testPassCommandId = 'cmd-pass-' + crypto.randomUUID();

    // 4. Seed Minimal Synthetic Input Configuration (Topology only)
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

    repo.createVerificationCommand({
      id: testPassCommandId,
      project_id: projectId,
      name: 'Synthetic Pass Test',
      command_type: 'TEST',
      executable: process.execPath,
      args: ['test_pass.js'],
      timeout_ms: 60000,
      enabled: true,
    });

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

    db.prepare(`
      INSERT INTO role_profiles (id, role, display_name, required_capabilities_json, preferred_capabilities_json, permissions_json, enabled, created_at, updated_at)
      VALUES (?, 'CODER', 'Synthetic Coder Role', '["CODING"]', '[]', '[]', 1, ?, ?)
    `).run(roleIdCoder, now, now);

    db.prepare(`
      INSERT INTO role_profiles (id, role, display_name, required_capabilities_json, preferred_capabilities_json, permissions_json, enabled, created_at, updated_at)
      VALUES (?, 'REVIEWER', 'Synthetic Reviewer Role', '["REVIEWING"]', '[]', '[]', 1, ?, ?)
    `).run(roleIdReviewer, now, now);

    db.prepare(`
      INSERT INTO agent_profiles (id, role_profile_id, name, enabled, created_at, updated_at)
      VALUES (?, ?, 'Synthetic Coder Profile', 1, ?, ?)
    `).run(coderAgentProfileId, roleIdCoder, now, now);

    db.prepare(`
      INSERT INTO agent_profiles (id, role_profile_id, name, enabled, created_at, updated_at)
      VALUES (?, ?, 'Synthetic Reviewer Profile', 1, ?, ?)
    `).run(reviewerAgentProfileId, roleIdReviewer, now, now);

    db.prepare(`
      INSERT INTO agents (id, display_name, role, provider_resource_id, status, current_task_id, last_seen_at)
      VALUES (?, 'Synthetic Coder Agent', 'CODER', ?, 'IDLE', NULL, ?)
    `).run(agentIdCoder, coderResourceId, now);

    db.prepare(`
      INSERT INTO agents (id, display_name, role, provider_resource_id, status, current_task_id, last_seen_at)
      VALUES (?, 'Synthetic Reviewer Agent', 'REVIEWER', ?, 'IDLE', NULL, ?)
    `).run(agentIdReviewer, reviewerResourceId, now);

    // Initial worker slot is IDLE, with NO assignment and NO lease
    db.prepare(`
      INSERT INTO worker_slots (id, provider_account_id, provider_resource_id, slot_index, status, current_assignment_id, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'IDLE', NULL, ?, ?)
    `).run(workerSlotId, coderAccountId, coderResourceId, now, now);

    return {
      tempDir,
      repoDir,
      managedWorktreesDir,
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
      contextBuilderService,
      providerRegistry,
      roleAwareRoutingService,
      workerSlotLeaseService,
      authorizationService,
      gitWorktreeService,
      providerDispatchService,
      gitExecutable,
      projectId,
      providerId,
      coderAccountId,
      reviewerAccountId,
      coderResourceId,
      reviewerResourceId,
      roleIdCoder,
      roleIdReviewer,
      coderAgentProfileId,
      reviewerAgentProfileId,
      agentIdCoder,
      agentIdReviewer,
      workerSlotId,
      baseSha,
      testPassCommandId,
    };
  } catch (cause) {
    const errors: unknown[] = [cause];
    try { if (setupDb?.open) setupDb.close(); } catch (error) { errors.push(error); }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length > 1) throw new AggregateError(errors, 'Bootstrap fixture setup and cleanup failed');
    throw cause;
  }
}

export interface SyntheticRehearsalEnv {
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

export function setupSyntheticRehearsalEnv(options?: {
  failVerification?: boolean;
  taskTitleMarker?: string;
  afterDatabaseOpened?: (resources: { tempDir: string; db: Database.Database }) => void;
}): SyntheticRehearsalEnv {
  const taskTitle = options?.taskTitleMarker
    ? `Synthetic Task with marker ${options.taskTitleMarker}`
    : 'Synthetic Task 1';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-r5l1-rehearsal-'));
  const repoDir = path.join(tempDir, 'repo');
  let setupDb: Database.Database | undefined;
  try {
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
    setupDb = db;
    options?.afterDatabaseOpened?.({ tempDir, db });
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
  } catch (cause) {
    const errors: unknown[] = [cause];
    try { if (setupDb?.open) setupDb.close(); } catch (error) { errors.push(error); }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length > 1) throw new AggregateError(errors, 'Fixture setup and cleanup failed');
    throw cause;
  }
}

export function issueSubmissionSession(
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

export function getDbTotalChanges(db: Database.Database): number {
  return (db.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
}

export interface SafeCleanupOptions {
  clients?: Array<Client | null | undefined>;
  servers?: Array<{ close: () => Promise<void> } | null | undefined>;
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
