import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { EventService } from '../src/core/services/EventService';
import { TaskService } from '../src/core/services/TaskService';
import { VerificationService } from '../src/core/services/VerificationService';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import { WorkspaceManagementService } from '../src/core/services/WorkspaceManagementService';
import { DesktopAutomationService } from '../src/core/services/DesktopAutomationService';
import { ProviderRegistry } from '../src/core/adapters/ProviderRegistry';
import { captureRepositoryRoot } from '../src/core/services/RepositoryRootIdentity';
import type { ProviderAdapter } from '../src/core/adapters/ProviderAdapter';
import { performSafeCleanup } from './helpers/r5l1SyntheticFixture';

/**
 * The real product chain driven by the desktop runtime. Only the provider
 * adapter is synthetic; task authority, attempt, routing, context manifest,
 * PRODUCT_BOUND authorization, lease, managed worktree, scheduled dispatch and
 * settlement are all real services. Managed worktrees need the native Windows
 * boundary, so the end-to-end case runs on win32 (the CI shards are Windows).
 */
describe('desktop automation runtime', () => {
  let tempDir: string;
  let repoDir: string;
  let db: Database.Database;
  let repo: Repository;
  let events: EventService;
  let tasks: TaskService;
  let registry: ProviderRegistry;
  let adapterCalls: number;
  let projectId: string;
  let service: DesktopAutomationService;

  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
  const fakeTimer = { setInterval: () => 'handle', clearInterval: () => undefined };

  const synthetic = (id: string): ProviderAdapter => ({
    id,
    name: 'Synthetic CLI coder',
    adapterType: 'LOCAL_CLI',
    async getCapabilities() { return ['CODING']; },
    async getHealth() { return 'AVAILABLE'; },
    async getQuota() { return { remaining: null, total: null, unit: 'REQUESTS', source: 'UNKNOWN', confidence: 0, resetAt: null }; },
    async execute(request) {
      adapterCalls += 1;
      return { executionId: request.runtimeBinding?.executionId ?? 'x', status: 'COMPLETED', outputProtocol: 'coder.v1', rawResponse: 'Synthetic coder result' };
    },
    async cancel() {},
  });

  const approvedTask = async () => {
    const task = tasks.createTask({ projectId, title: 'Add a greeting', description: 'Automation test', priority: 'LOW', risk: 'LOW',
      acceptanceCriteria: ['Greeting exists'], constraints: [] });
    const manager = {
      protocol: 'manager.v1' as const, message_id: `manager-${crypto.randomUUID()}`, project_id: projectId, task_id: task.id,
      decision: 'EXECUTE' as const, priority: 'LOW' as const, risk: 'LOW' as const, instructions: ['Add a greeting to README.md'],
      acceptance_criteria: task.acceptance_criteria, constraints: task.constraints, review_issues: [],
      expected_task_state: 'PLANNED' as const, expected_revision: 0,
    };
    expect((await tasks.applyManagerDecision(manager, JSON.stringify(manager))).success).toBe(true);
    expect(repo.getTask(task.id)?.state).toBe('CODING');
    return task;
  };

  const statusOf = () => service.getStatus().projects.find((p) => p.projectId === projectId)!;

  beforeEach(() => {
    tempDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-automation-')));
    repoDir = path.join(tempDir, 'repo');
    fs.mkdirSync(repoDir);
    git('init', '-b', 'main');
    git('config', 'user.name', 'Automation Fixture');
    git('config', 'user.email', 'fixture@agentforge.local');
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Fixture\n', 'utf8');
    git('add', '.');
    git('commit', '-m', 'baseline');

    db = new Database(path.join(tempDir, 'automation.db'));
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    events = new EventService(repo);
    const artifacts = new ArtifactStore(path.join(tempDir, 'artifacts'));
    tasks = new TaskService(repo, events, new VerificationService(repo, artifacts), artifacts);
    registry = new ProviderRegistry();
    registry.register(synthetic('prov-codex-cli'));
    adapterCalls = 0;

    const now = new Date().toISOString();
    projectId = `project-${crypto.randomUUID()}`;
    repo.createProject({
      id: projectId, name: 'Automation project', description: null, repository_path: repoDir, default_branch: 'main',
      status: 'RUNNING', contract: null, created_at: now, updated_at: now, started_at: now, completed_at: null,
    }, captureRepositoryRoot(repoDir));
    service = new DesktopAutomationService(repo, events, registry, { worktreeRoot: path.join(tempDir, 'worktrees'), timer: fakeTimer });
  });

  afterEach(async () => {
    await service.drain();
    await performSafeCleanup({ dbs: [db], tempDirs: [tempDir] });
  });

  const addCodexCoder = () => {
    const created = new WorkspaceManagementService(repo).createAgent({
      displayName: 'Codex coder', role: 'CODER', connection: 'CODEX_CLI', modelName: 'gpt-5-codex', workerSlots: 1,
    });
    expect(created.success).toBe(true);
    return created;
  };

  it('waits for Manager authority and reports a truthful phase for non-running projects', async () => {
    addCodexCoder();
    expect(statusOf().phase).toBe('WAITING_FOR_MANAGER');
    db.prepare("UPDATE projects SET status = 'PAUSED' WHERE id = ?").run(projectId);
    await approvedTask();
    await service.tick();
    expect(statusOf().phase).toBe('PROJECT_NOT_RUNNING');
    expect(adapterCalls).toBe(0);
    expect(repo.getTaskAttemptsByTask(repo.getTasksByProject(projectId)[0].id)).toEqual([]);
  });

  it('distinguishes Manual Bridge-only coders from missing capacity and never dispatches either', async () => {
    const task = await approvedTask();
    expect(statusOf()).toMatchObject({ phase: 'WAITING_FOR_CAPACITY', taskId: task.id });
    new WorkspaceManagementService(repo).createAgent({ displayName: 'Manual coder', role: 'CODER', connection: 'MANUAL_BRIDGE', modelName: 'Gemini' });
    expect(statusOf()).toMatchObject({ phase: 'MANUAL_RELAY_REQUIRED', taskId: task.id });
    await service.tick();
    expect(adapterCalls).toBe(0);
    expect(repo.getExecutionAuthorizationsByTask(task.id)).toEqual([]);
  });

  /** New accounts stay UNKNOWN until health is proven; the e2e cases model a verified account. */
  const verify = (created: ReturnType<typeof addCodexCoder>) => {
    const resource = repo.getProviderResource(created.success ? created.agent.provider_resource_id! : '')!;
    db.prepare("UPDATE provider_accounts SET health_status = 'AVAILABLE' WHERE id = ?").run(resource.provider_account_id);
  };

  it('does not dispatch to an unverified (UNKNOWN) account and says why', async () => {
    addCodexCoder();
    const task = await approvedTask();
    await service.tick();
    expect(statusOf()).toMatchObject({ phase: 'WAITING_FOR_CAPACITY', taskId: task.id, reasonCode: 'ACCOUNT_NOT_VERIFIED' });
    expect(adapterCalls).toBe(0);
    expect(repo.getTaskAttemptsByTask(task.id)).toEqual([]);
  });

  it('does not use a coder whose account is in AUTH_ERROR', async () => {
    const created = addCodexCoder();
    const task = await approvedTask();
    const resource = repo.getProviderResource(created.success ? created.agent.provider_resource_id! : '')!;
    db.prepare("UPDATE provider_accounts SET health_status = 'AUTH_ERROR' WHERE id = ?").run(resource.provider_account_id);
    await service.tick();
    expect(statusOf()).toMatchObject({ phase: 'WAITING_FOR_CAPACITY', taskId: task.id });
    expect(adapterCalls).toBe(0);
  });

  it.runIf(process.platform === 'win32')('runs the real product chain once and then waits for review', async () => {
    verify(addCodexCoder());
    const task = await approvedTask();
    await service.tick();
    expect(statusOf()).toMatchObject({ phase: 'EXECUTING', taskId: task.id });
    await service.drain();

    expect(adapterCalls).toBe(1);
    const [auth] = repo.getExecutionAuthorizationsByTask(task.id);
    expect(auth).toMatchObject({ status: 'DISPATCHED', lifecycle_version: 1, settlement_status: 'COMPLETED' });
    expect(repo.getTaskAttemptsByTask(task.id).map((a) => a.status)).toEqual(['COMPLETED']);
    expect(repo.getAgentAssignmentsByTask(task.id).map((a) => a.status)).toEqual(['COMPLETED']);
    expect(statusOf()).toMatchObject({ phase: 'AWAITING_REVIEW', taskId: task.id });
    expect(repo.getEventsByProject(projectId).some((e) => e.type === 'PRODUCT_EXECUTION_COMPLETED')).toBe(true);

    // A settled revision is never re-run.
    await service.tick();
    await service.drain();
    expect(adapterCalls).toBe(1);
    expect(repo.getExecutionAuthorizationsByTask(task.id)).toHaveLength(1);
  }, 60_000);
});
