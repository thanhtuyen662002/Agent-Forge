import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
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
import { GitWorktreeService } from '../src/core/services/GitWorktreeService';
import { WorktreeIntegrationService } from '../src/core/services/WorktreeIntegrationService';
import { resolveTrustedExecutable } from '../src/core/services/ExecutableResolver';
import { contractSha256 } from '../src/core/protocol/planProtocol';
import { ProviderRegistry } from '../src/core/adapters/ProviderRegistry';
import { captureRepositoryRoot } from '../src/core/services/RepositoryRootIdentity';
import type { AgentExecutionRequest, AgentExecutionResult, ProviderAdapter } from '../src/core/adapters/ProviderAdapter';
import { performSafeCleanup } from './helpers/r5l1SyntheticFixture';
import { approveFixtureCommand } from './helpers/verificationCapabilityFixture';

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
  let verification: VerificationService;
  let registry: ProviderRegistry;
  let adapterCalls: number;
  let reviewRequests: AgentExecutionRequest[];
  let managerRequests: AgentExecutionRequest[];
  /** When set, the synthetic coder edits its managed worktree like a real coder would. */
  let coderEdits: ((worktree: string) => void) | null;
  let managerReply: (request: AgentExecutionRequest) => AgentExecutionResult | Promise<AgentExecutionResult>;
  let reviewReply: (request: AgentExecutionRequest) => AgentExecutionResult | Promise<AgentExecutionResult>;
  let projectId: string;
  let service: DesktopAutomationService;

  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
  const fakeTimer = { setInterval: () => 'handle', clearInterval: () => undefined };

  let healthy: boolean;
  /** The next coder runs that return FAILED (a provider failure). */
  let coderFailures = 0;
  /** Coder accounts whose runs return FAILED (an account Google asked to verify). */
  let failingAccounts = new Set<string>();
  /** When set, coder runs wait for it, so concurrent runs can be counted. */
  let coderGate: Promise<void> | null = null;
  /** The coder.v1 report the synthetic coder returns, when set. */
  let coderOutput: string | null = null;
  let activeCoders = 0;
  let maxActiveCoders = 0;
  const synthetic = (id: string, capabilities: Array<'CODING' | 'REVIEW' | 'PLANNING'> = ['CODING', 'REVIEW', 'PLANNING']): ProviderAdapter => ({
    id,
    name: 'Synthetic CLI coder',
    adapterType: 'LOCAL_CLI',
    async getCapabilities() { return capabilities; },
    async getHealth() { return healthy ? 'AVAILABLE' : 'OFFLINE'; },
    async getQuota() { return { remaining: null, total: null, unit: 'REQUESTS', source: 'UNKNOWN', confidence: 0, resetAt: null }; },
    async execute(request) {
      if (request.expectedProtocol === 'review.v1') {
        reviewRequests.push(request);
        return reviewReply(request);
      }
      if (request.expectedProtocol === 'manager.v1' || request.expectedProtocol === 'plan.v1') {
        managerRequests.push(request);
        return managerReply(request);
      }
      adapterCalls += 1;
      if (coderGate) {
        activeCoders += 1;
        maxActiveCoders = Math.max(maxActiveCoders, activeCoders);
        try { await coderGate; } finally { activeCoders -= 1; }
      }
      if (coderFailures > 0 || failingAccounts.has(request.runtimeBinding?.accountId ?? '')) {
        if (coderFailures > 0) coderFailures -= 1;
        return { executionId: request.runtimeBinding?.executionId ?? 'x', status: 'FAILED', error: 'synthetic provider failure', rawResponse: '' };
      }
      const workspace = request.runtimeBinding?.workspace?.workingDirectory;
      if (coderEdits && workspace) coderEdits(workspace);
      return { executionId: request.runtimeBinding?.executionId ?? 'x', status: 'COMPLETED', outputProtocol: coderOutput ?? 'coder.v1', rawResponse: 'Synthetic coder result' };
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
    verification = new VerificationService(repo, artifacts);
    tasks = new TaskService(repo, events, verification, artifacts);
    registry = new ProviderRegistry();
    registry.register(synthetic('prov-codex-cli'));
    adapterCalls = 0;
    coderFailures = 0;
    failingAccounts = new Set();
    coderGate = null;
    coderOutput = null;
    activeCoders = 0;
    maxActiveCoders = 0;
    healthy = true;
    reviewRequests = [];
    reviewReply = () => { throw new Error('no review expected'); };
    managerRequests = [];
    coderEdits = null;
    managerReply = () => { throw new Error('no Manager call expected'); };

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

  const addCodexCoder = (displayName = 'Codex coder', workerSlots = 1) => {
    const created = new WorkspaceManagementService(repo).createAgent({
      displayName, role: 'CODER', connection: 'CODEX_CLI', modelName: 'gpt-5-codex', workerSlots,
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

  it('reports QUEUED, not EXECUTING, before anything is dispatched', async () => {
    verify(addCodexCoder());
    const task = await approvedTask();
    expect(statusOf()).toMatchObject({ phase: 'QUEUED', taskId: task.id, reasonCode: 'AUTOMATION_STOPPED' });
    expect(adapterCalls).toBe(0);
  });

  it('releases authorization, assignment and attempt when execution fails before the claim', async () => {
    verify(addCodexCoder());
    const task = await approvedTask();
    // Non-contiguous history: the next attempt must not collide with attempt 3.
    const profile = repo.getAllAgents().find((a) => a.role === 'CODER')!.agent_profile_id!;
    for (const n of [1, 3]) {
      repo.createTaskAttempt({ id: `old-${n}`, task_id: task.id, attempt_number: n, agent_id: null, agent_profile_id: profile,
        status: 'FAILED', started_at: new Date().toISOString(), ended_at: new Date().toISOString(), summary: null });
    }
    service = new DesktopAutomationService(repo, events, registry, {
      worktreeRoot: path.join(tempDir, 'worktrees'), timer: fakeTimer,
      resolveGitExecutable: () => path.join(tempDir, 'missing-git.exe'),
    });
    await service.tick();
    await service.drain();

    expect(adapterCalls).toBe(0);
    // The worktree service fails before an authorization exists; nothing may stay blocked.
    expect(repo.getExecutionAuthorizationsByTask(task.id).every((a) => a.status === 'INVALIDATED')).toBe(true);
    expect(repo.getAgentAssignmentsByTask(task.id).map((a) => a.status)).toEqual(['FAILED']);
    const attempt = repo.getTaskAttemptsByTask(task.id).find((a) => !a.id.startsWith('old-'))!;
    expect(attempt).toMatchObject({ attempt_number: 4, status: 'FAILED' });
    expect(statusOf()).toMatchObject({ phase: 'FAILED', taskId: task.id });
    expect(repo.getEventsByProject(projectId).some((e) => e.type === 'AUTOMATION_EXECUTION_FAILED')).toBe(true);
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

  it.runIf(process.platform === 'win32')('releases attempt and assignment when dispatch itself invalidates the authorization', async () => {
    const created = addCodexCoder();
    verify(created);
    const task = await approvedTask();
    const accountId = repo.getProviderResource(created.success ? created.agent.provider_resource_id! : '')!.provider_account_id!;
    // The task moves on right after authorization (lease still succeeds): dispatch rejects the
    // stale authorization and INVALIDATES it before any claim.
    void accountId;
    const original = repo.createExecutionAuthorization.bind(repo);
    vi.spyOn(repo, 'createExecutionAuthorization').mockImplementation((auth) => {
      original(auth);
      db.prepare('UPDATE tasks SET revision_count = revision_count + 1 WHERE id = ?').run(auth.task_id);
    });
    await service.tick();
    await service.drain();

    expect(adapterCalls).toBe(0);
    expect(repo.getExecutionAuthorizationsByTask(task.id).map((a) => a.status)).toEqual(['INVALIDATED']);
    expect(repo.getAgentAssignmentsByTask(task.id).map((a) => a.status)).toEqual(['FAILED']);
    expect(repo.getTaskAttemptsByTask(task.id).map((a) => a.status)).toEqual(['FAILED']);
  }, 60_000);

  it.runIf(process.platform === 'win32')('retries a failed coder run after a pause, at most three runs per revision (#295)', async () => {
    verify(addCodexCoder());
    const task = await approvedTask();
    let clock = Date.now();
    service = new DesktopAutomationService(repo, events, registry, {
      worktreeRoot: path.join(tempDir, 'worktrees'), timer: fakeTimer, now: () => new Date(clock).toISOString() });
    coderFailures = 1;
    await service.tick(); await service.drain();
    expect(adapterCalls).toBe(1);
    expect(statusOf()).toMatchObject({ phase: 'FAILED', taskId: task.id });
    await service.tick(); await service.drain();
    expect(adapterCalls).toBe(1); // Inside the retry pause.
    clock += 120_000; // Settlement times come from the real clock; well past the pause.
    await service.tick(); await service.drain();
    expect(adapterCalls).toBe(2);
    expect(statusOf()).toMatchObject({ phase: 'AWAITING_REVIEW', taskId: task.id });
    clock += 61_000;
    await service.tick(); await service.drain();
    expect(adapterCalls).toBe(2); // A completed run is never repeated.
  }, 120_000);

  it.runIf(process.platform === 'win32')('retries a failed run on another coder account and shows truthful progress (#302)', async () => {
    const first = addCodexCoder('A coder');
    const second = addCodexCoder('B coder');
    verify(first);
    verify(second);
    const accountOf = (created: ReturnType<typeof addCodexCoder>) =>
      repo.getProviderResource(created.success ? created.agent.provider_resource_id! : '')!.provider_account_id!;
    failingAccounts.add(accountOf(first)); // Tried first: agents are listed by display name.
    const task = await approvedTask();
    let clock = Date.now();
    service = new DesktopAutomationService(repo, events, registry, {
      worktreeRoot: path.join(tempDir, 'worktrees'), timer: fakeTimer, taskService: tasks, now: () => new Date(clock).toISOString() });
    await service.tick(); await service.drain();
    expect(adapterCalls).toBe(1);
    clock += 120_000;
    await service.tick(); await service.drain();
    expect(adapterCalls).toBe(2);
    expect(repo.getExecutionAuthorizationsByTask(task.id).map((auth) => auth.selected_account_id).sort())
      .toEqual([accountOf(first), accountOf(second)].sort());
    expect(statusOf()).toMatchObject({ phase: 'AWAITING_REVIEW', taskId: task.id });
    // The refresh on the next pass sees the settled, not yet verified run.
    await service.tick();
    expect(repo.getTask(task.id)!.progress_cache_percent).toBe(41);
  }, 180_000);

  describe.runIf(process.platform === 'win32')('parallel tasks per project (#306)', () => {
    const runParallel = async (parallelTasks: number, maxConcurrentExecutions = 10) => {
      verify(addCodexCoder('Codex coder', 3)); // One agent, three worker slots.
      for (let i = 0; i < 3; i += 1) await approvedTask();
      repo.setProjectParallelTasks(projectId, parallelTasks);
      let release!: () => void;
      coderGate = new Promise<void>((resolve) => { release = resolve; });
      service = new DesktopAutomationService(repo, events, registry, { worktreeRoot: path.join(tempDir, 'worktrees'), timer: fakeTimer, maxConcurrentExecutions });
      await service.tick();
      // Give every started run time to reach the coder.
      for (let i = 0; i < 400 && activeCoders < Math.min(parallelTasks, maxConcurrentExecutions); i += 1) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 300));
      const concurrent = activeCoders;
      release();
      await service.drain();
      return concurrent;
    };

    it('runs three tasks at once on one agent with three slots', async () => {
      const c = await runParallel(3);
      expect(c).toBe(3);
      expect(maxActiveCoders).toBe(3);
      expect(adapterCalls).toBe(3);
    }, 180_000);

    it('keeps one task at a time with the default setting', async () => {
      expect(await runParallel(1)).toBe(1);
      expect(maxActiveCoders).toBe(1);
    }, 180_000);

    it('never exceeds the global cap', async () => {
      expect(await runParallel(3, 2)).toBe(2);
      expect(maxActiveCoders).toBe(2);
    }, 180_000);
  });

  it.runIf(process.platform === 'win32')('stops retrying a revision after three failed runs (#295)', async () => {
    verify(addCodexCoder());
    const task = await approvedTask();
    let clock = Date.now();
    service = new DesktopAutomationService(repo, events, registry, {
      worktreeRoot: path.join(tempDir, 'worktrees'), timer: fakeTimer, now: () => new Date(clock).toISOString() });
    coderFailures = 10;
    for (let i = 0; i < 5; i += 1) { await service.tick(); await service.drain(); clock += 61_000; }
    expect(adapterCalls).toBe(3);
    expect(statusOf()).toMatchObject({ phase: 'FAILED', taskId: task.id });
    // A fresh process (in-memory history gone) is still bounded by the settled runs.
    service = new DesktopAutomationService(repo, events, registry, {
      worktreeRoot: path.join(tempDir, 'worktrees'), timer: fakeTimer, now: () => new Date(clock).toISOString() });
    await service.tick(); await service.drain();
    expect(adapterCalls).toBe(3);
  }, 180_000);

  it.runIf(process.platform === 'win32')('lets the owner retry a coding task whose coder retries ran out (#318)', async () => {
    verify(addCodexCoder());
    const task = await approvedTask();
    let clock = Date.now();
    service = new DesktopAutomationService(repo, events, registry, {
      worktreeRoot: path.join(tempDir, 'worktrees'), timer: fakeTimer, now: () => new Date(clock).toISOString() });
    coderFailures = 3;
    for (let i = 0; i < 4; i += 1) { await service.tick(); await service.drain(); clock += 61_000; }
    expect(adapterCalls).toBe(3);
    expect(statusOf()).toMatchObject({ phase: 'FAILED', taskId: task.id });

    expect(tasks.retryTask(projectId, task.id)).toMatchObject({ success: true, task: { state: 'CODING', revision_count: task.revision_count } });
    // The service clock runs ahead of real time here; the retry happens on it.
    db.prepare("UPDATE events SET timestamp = ? WHERE type = 'OWNER_TASK_RETRIED'").run(new Date(clock).toISOString());
    clock += 1_000;
    await service.tick(); await service.drain();
    expect(adapterCalls).toBe(4); // The coder runs again; this time it succeeds.
    expect(statusOf()).toMatchObject({ phase: 'AWAITING_REVIEW', taskId: task.id });
    // A task with a completed run is not retried.
    expect(tasks.retryTask(projectId, task.id)).toMatchObject({ success: false, errorCode: 'TASK_NOT_RETRYABLE' });
  }, 180_000);

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
    // The authorized execution scope names the exact worktree the scheduler created and retained.
    const scope = JSON.parse(auth.canonical_payload_json!).executionScope;
    expect(fs.existsSync(scope.worktree)).toBe(true);
    expect(path.basename(scope.worktree)).toMatch(/^afw-[0-9a-f]{32}$/);
    expect(fs.existsSync(path.join(scope.worktree, 'README.md'))).toBe(true);
    expect(repo.getEventsByProject(projectId).some((e) => e.type === 'PRODUCT_EXECUTION_COMPLETED')).toBe(true);

    // A settled revision is never re-run.
    await service.tick();
    await service.drain();
    expect(adapterCalls).toBe(1);
    expect(repo.getExecutionAuthorizationsByTask(task.id)).toHaveLength(1);
  }, 60_000);
  describe.runIf(process.platform === 'win32')('automated verification after a completed coder run (#230)', () => {
    /** Commits an approved TEST script, so the managed worktree carries the exact approved file. */
    const configureTest = async (exitCode: number) => {
      fs.writeFileSync(path.join(repoDir, 'verify.js'), `process.exit(${exitCode});\n`, 'utf8');
      git('add', 'verify.js');
      git('commit', '-m', 'add verification script');
      repo.createVerificationCommand({
        id: `vc-${crypto.randomUUID()}`, project_id: projectId, name: 'Fixture test', command_type: 'TEST',
        ...await approveFixtureCommand(repo, projectId, ['verify.js']), timeout_ms: 60_000, enabled: true,
      });
    };
    const verifyingService = () => new DesktopAutomationService(repo, events, registry, {
      worktreeRoot: path.join(tempDir, 'worktrees'), timer: fakeTimer, taskService: tasks, verificationService: verification,
    });

    it('verifies in the authorized worktree and leaves the task REVIEW_READY', async () => {
      verify(addCodexCoder());
      await configureTest(0);
      const task = await approvedTask();
      service = verifyingService();
      await service.tick();
      await service.drain();

      expect(adapterCalls).toBe(1);
      expect(repo.getTask(task.id)!.state).toBe('REVIEW_READY');
      const passed = repo.getEventsByProject(projectId).find((e) => e.type === 'AUTOMATION_VERIFICATION_PASSED')!;
      const auth = repo.getExecutionAuthorizationsByTask(task.id)[0];
      expect(passed.structured_payload).toMatchObject({ authorizationId: auth.id, worktree: JSON.parse(auth.canonical_payload_json!).executionScope.worktree,
        headSha: auth.repository_head_sha, snapshotSha: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(statusOf()).toMatchObject({ phase: 'AWAITING_REVIEW', taskId: task.id, reasonCode: 'NO_REVIEWER' });
      // No second verification or dispatch for the same settled run.
      await service.tick();
      await service.drain();
      expect(adapterCalls).toBe(1);
      expect(repo.getEventsByProject(projectId).filter((e) => e.type === 'AUTOMATION_VERIFICATION_PASSED')).toHaveLength(1);
    }, 90_000);

    it('runs `node --test` over the tests the coder added and edited (#267)', async () => {
      verify(addCodexCoder());
      fs.mkdirSync(path.join(repoDir, 'test'));
      fs.writeFileSync(path.join(repoDir, 'test', 'base.test.js'), "require('node:test')('base', () => {});\n", 'utf8');
      git('add', 'test');
      git('commit', '-m', 'add base test');
      repo.createVerificationCommand({
        id: `vc-${crypto.randomUUID()}`, project_id: projectId, name: 'Node test runner', command_type: 'TEST',
        ...await approveFixtureCommand(repo, projectId, ['--test']), timeout_ms: 60_000, enabled: true,
      });
      // The coder edits the existing test and adds a new one, like a real coding task.
      coderEdits = (worktree) => {
        fs.appendFileSync(path.join(worktree, 'test', 'base.test.js'), "require('node:test')('edited', () => {});\n", 'utf8');
        fs.writeFileSync(path.join(worktree, 'test', 'added.test.js'), "require('node:test')('added', () => {});\n", 'utf8');
      };
      const task = await approvedTask();
      service = verifyingService();
      await service.tick();
      await service.drain();

      expect(repo.getEventsByProject(projectId).some((e) => e.type === 'AUTOMATION_VERIFICATION_PASSED')).toBe(true);
      expect(repo.getTask(task.id)!.state).toBe('REVIEW_READY');
    }, 90_000);

    it('does not verify or review a run whose coder reported BLOCKED (#308)', async () => {
      verify(addCodexCoder());
      await configureTest(0);
      const task = await approvedTask();
      coderOutput = JSON.stringify({ protocol: 'coder.v1', message_id: 'm', project_id: projectId, task_id: task.id, status: 'BLOCKED',
        completed: [], remaining: ['write the module'], files_claimed_changed: [], tests_claimed: [], blockers: ['src/db.ts from an earlier task is missing'] });
      service = verifyingService();
      await service.tick();
      await service.drain();

      const after = repo.getTask(task.id)!;
      expect(after.state).toBe('CODING');
      expect(after.revision_count).toBe(task.revision_count + 1);
      const failed = repo.getEventsByProject(projectId).find((e) => e.type === 'AUTOMATION_VERIFICATION_FAILED')!;
      expect(failed.structured_payload).toMatchObject({ reasonCode: 'CODER_BLOCKED', blockers: ['src/db.ts from an earlier task is missing'], testRunId: null });
      expect(repo.getLatestTestRun(task.id)).toBeFalsy(); // The test command never ran.
    }, 90_000);

    it('sends a failing verification back to the Manager at the next revision, never to review', async () => {
      verify(addCodexCoder());
      await configureTest(1);
      const task = await approvedTask();
      service = verifyingService();
      await service.tick();
      await service.drain();

      const after = repo.getTask(task.id)!;
      expect(after.state).toBe('CODING');
      expect(after.revision_count).toBe(task.revision_count + 1);
      expect(repo.getEventsByProject(projectId).some((e) => e.type === 'AUTOMATION_VERIFICATION_FAILED')).toBe(true);
      expect(statusOf()).toMatchObject({ phase: 'WAITING_FOR_MANAGER', taskId: task.id, reasonCode: 'VERIFICATION_FAILED' });
      // The new revision needs fresh Manager authority: nothing is dispatched again.
      await service.tick();
      await service.drain();
      expect(adapterCalls).toBe(1);
    }, 90_000);

    it('fails verification when the test changes the work it verifies', async () => {
      verify(addCodexCoder());
      fs.writeFileSync(path.join(repoDir, 'verify.js'),
        "require('fs').appendFileSync('README.md', 'mutated by test'); process.exit(0);", 'utf8');
      git('add', 'verify.js');
      git('commit', '-m', 'mutating verification script');
      repo.createVerificationCommand({
        id: `vc-${crypto.randomUUID()}`, project_id: projectId, name: 'Mutating test', command_type: 'TEST',
        ...await approveFixtureCommand(repo, projectId, ['verify.js']), timeout_ms: 60_000, enabled: true,
      });
      const task = await approvedTask();
      service = verifyingService();
      await service.tick();
      await service.drain();

      const failed = repo.getEventsByProject(projectId).find((e) => e.type === 'AUTOMATION_VERIFICATION_FAILED');
      expect(failed?.structured_payload).toMatchObject({ reasonCode: 'WORKTREE_CHANGED_DURING_VERIFICATION' });
      expect(repo.getTask(task.id)!.state).toBe('CODING');
      expect(repo.getTask(task.id)!.revision_count).toBe(task.revision_count + 1);
    }, 90_000);

    it('does not transition the task when no TEST command is configured, and says so', async () => {
      verify(addCodexCoder());
      const task = await approvedTask();
      service = verifyingService();
      await service.tick();
      await service.drain();

      expect(repo.getTask(task.id)!.state).toBe('CODING');
      expect(statusOf()).toMatchObject({ phase: 'AWAITING_REVIEW', taskId: task.id, reasonCode: 'VERIFICATION_NOT_CONFIGURED' });

      // A later pass without a TEST command records nothing new...
      await service.tick();
      await service.drain();
      expect(repo.getEventsByProject(projectId).filter((e) => e.type === 'AUTOMATION_VERIFICATION_NOT_RUN')).toHaveLength(1);
      // ...and once the owner approves one, the same settled work is verified again (as the UI tells
      // them). The retained worktree predates the new script, so the run itself fails closed.
      await configureTest(0);
      await service.tick();
      await service.drain();
      const outcomes = repo.getEventsByProject(projectId).filter((e) =>
        e.type === 'AUTOMATION_VERIFICATION_PASSED' || e.type === 'AUTOMATION_VERIFICATION_FAILED');
      expect(outcomes).toHaveLength(1);
      expect(repo.getTask(task.id)!.state).not.toBe('REVIEW_READY');
    }, 90_000);

    it('verifies settled work left unverified by a restart', async () => {
      verify(addCodexCoder());
      await configureTest(0);
      const task = await approvedTask();
      // First process: no verifier wired (as before #230), the run settles COMPLETED.
      await service.tick();
      await service.drain();
      expect(repo.getTask(task.id)!.state).toBe('CODING');
      // Restarted process with verification: picks up the pending settled run.
      service = verifyingService();
      await service.tick();
      await service.drain();
      expect(repo.getTask(task.id)!.state).toBe('REVIEW_READY');
      expect(adapterCalls).toBe(1);
    }, 90_000);
  });
  describe.runIf(process.platform === 'win32')('account-bound automated review of verified work (#233)', () => {
    const configureTest = async (script = 'process.exit(0);\n') => {
      fs.writeFileSync(path.join(repoDir, 'verify.js'), script, 'utf8');
      git('add', 'verify.js');
      git('commit', '-m', 'add verification script');
      repo.createVerificationCommand({
        id: `vc-${crypto.randomUUID()}`, project_id: projectId, name: 'Fixture test', command_type: 'TEST',
        ...await approveFixtureCommand(repo, projectId, ['verify.js']), timeout_ms: 60_000, enabled: true,
      });
    };
    let clock = 0;
    const reviewingService = (now: () => string = () => new Date(Date.now() + clock).toISOString()) => new DesktopAutomationService(repo, events, registry, {
      worktreeRoot: path.join(tempDir, 'worktrees'), timer: fakeTimer, taskService: tasks, verificationService: verification, now,
    });
    beforeEach(() => { clock = 0; });
    const addReviewer = () => {
      const created = new WorkspaceManagementService(repo).createAgent({
        displayName: 'Codex reviewer', role: 'REVIEWER', connection: 'CODEX_CLI', modelName: 'gpt-5-codex', workerSlots: 1,
      });
      expect(created.success).toBe(true);
      verify(created);
      return created;
    };
    const accountOf = (created: ReturnType<typeof addCodexCoder>) =>
      repo.getProviderResource(created.success ? created.agent.provider_resource_id! : '')!.provider_account_id;
    const verified = () => repo.getEventsByProject(projectId).filter((e) => e.type === 'AUTOMATION_VERIFICATION_PASSED').at(-1)!
      .structured_payload as { headSha: string; snapshotSha: string; worktree: string };
    const verdict = (value: 'PASS' | 'FIX_REQUIRED' | 'BLOCKED', overrides: Record<string, unknown> = {}) => (request: AgentExecutionRequest): AgentExecutionResult => ({
      executionId: request.runtimeBinding?.executionId ?? 'x', status: 'COMPLETED',
      outputProtocol: JSON.stringify({
        protocol: 'review.v1', message_id: `review-${crypto.randomUUID()}`, project_id: projectId, task_id: request.taskId,
        task_revision: repo.getTask(request.taskId)!.revision_count, verdict: value, summary: 'Synthetic review',
        issues: value === 'FIX_REQUIRED' ? [{ severity: 'REQUIRED', title: 'Missing greeting', description: 'README has no greeting.' }] : [],
        reviewed_head_sha: verified().headSha, reviewed_snapshot_sha: verified().snapshotSha, ...overrides,
      }),
    });
    const eventsOf = (type: string) => repo.getEventsByProject(projectId).filter((e) => e.type === type);

    /** Coder run plus verification on the first pass; the review on the second. */
    const runToReview = async (beforeReview: (taskId: string) => void = () => undefined) => {
      const coder = addCodexCoder();
      verify(coder);
      const reviewer = addReviewer();
      await configureTest();
      const task = await approvedTask();
      service = reviewingService();
      await service.tick();
      await service.drain();
      expect(repo.getTask(task.id)!.state).toBe('REVIEW_READY');
      beforeReview(task.id);
      await service.tick();
      await service.drain();
      return { task, coder, reviewer };
    };

    it('reviews on the reviewer’s own account and a PASS verdict completes the task', async () => {
      reviewReply = verdict('PASS');
      const { task, coder, reviewer } = await runToReview();

      expect(reviewRequests).toHaveLength(1);
      const request = reviewRequests[0];
      expect(request.runtimeBinding!.accountId).toBe(accountOf(reviewer));
      expect(request.runtimeBinding!.accountId).not.toBe(accountOf(coder));
      expect(request.runtimeBinding!.workspace!.workingDirectory).toBe(verified().worktree);
      expect(repo.getTask(task.id)!.state).toBe('DONE');
      const reviews = repo.getReviewsByTask(task.id);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({ verdict: 'PASS', reviewer_agent_id: reviewer.success ? reviewer.agent.id : '' });
      const attempt = repo.getTaskAttempt(reviews[0].attempt_id!)!;
      expect(attempt).toMatchObject({ status: 'COMPLETED', summary: 'desktop-review' });
      const assignment = repo.getAgentAssignmentsByTask(task.id).find((a) => a.attempt_id === attempt.id)!;
      expect(assignment.status).toBe('COMPLETED');
      expect(repo.getActiveLeaseForAssignment(assignment.id)).toBeNull();
      expect(eventsOf('AUTOMATION_REVIEW_PASSED')).toHaveLength(1);
      // The settled review is never repeated, and nothing was dispatched again.
      await service.tick();
      await service.drain();
      expect(reviewRequests).toHaveLength(1);
      expect(adapterCalls).toBe(1);
    }, 120_000);

    it('sends FIX_REQUIRED back to the Manager at the next revision without re-dispatching', async () => {
      reviewReply = verdict('FIX_REQUIRED');
      const { task } = await runToReview();

      const after = repo.getTask(task.id)!;
      expect(after.state).toBe('CODING');
      expect(after.revision_count).toBe(task.revision_count + 1);
      expect(repo.getReviewsByTask(task.id)[0].verdict).toBe('FIX_REQUIRED');
      expect(statusOf()).toMatchObject({ phase: 'WAITING_FOR_MANAGER', taskId: task.id, reasonCode: 'REVIEW_FIX_REQUIRED' });
      await service.tick();
      await service.drain();
      expect(adapterCalls).toBe(1);
    }, 120_000);

    it('never applies a malformed verdict and does not retry it', async () => {
      reviewReply = (request) => ({ executionId: request.runtimeBinding!.executionId!, status: 'COMPLETED', outputProtocol: '{"protocol":"coder.v1"}' });
      const { task } = await runToReview();

      expect(repo.getTask(task.id)!.state).toBe('REVIEWING');
      expect(repo.getReviewsByTask(task.id)).toEqual([]);
      expect(eventsOf('AUTOMATION_REVIEW_FAILED')[0].structured_payload).toMatchObject({ reasonCode: 'REVIEW_PROTOCOL_INVALID' });
      expect(statusOf()).toMatchObject({ phase: 'AWAITING_REVIEW', taskId: task.id, reasonCode: 'REVIEW_FAILED' });
      await service.tick();
      await service.drain();
      expect(reviewRequests).toHaveLength(1);
    }, 120_000);

    it('rejects a verdict for a stale snapshot', async () => {
      reviewReply = verdict('PASS', { reviewed_snapshot_sha: 'f'.repeat(64) });
      const { task } = await runToReview();

      expect(repo.getTask(task.id)!.state).toBe('REVIEWING');
      expect(repo.getReviewsByTask(task.id)).toEqual([]);
      expect(eventsOf('AUTOMATION_REVIEW_STALE')[0].structured_payload).toMatchObject({ reasonCode: 'VERDICT_FOR_STALE_SNAPSHOT' });
    }, 120_000);

    it('rejects a review when the verified worktree changed while it ran', async () => {
      const pass = verdict('PASS');
      reviewReply = (request) => {
        fs.writeFileSync(path.join(request.runtimeBinding!.workspace!.workingDirectory, 'README.md'), '# Tampered\n', 'utf8');
        return pass(request);
      };
      const { task } = await runToReview();

      expect(repo.getTask(task.id)!.state).toBe('REVIEWING');
      expect(eventsOf('AUTOMATION_REVIEW_STALE')[0].structured_payload).toMatchObject({ reasonCode: 'WORKTREE_CHANGED_DURING_REVIEW' });
    }, 120_000);

    it('never turns a provider failure into a verdict', async () => {
      reviewReply = (request) => ({ executionId: request.runtimeBinding!.executionId!, status: 'FAILED', errorCode: 'AUTH_ERROR', error: 'not logged in' });
      const { task } = await runToReview();

      expect(repo.getTask(task.id)!.state).toBe('REVIEWING');
      expect(repo.getReviewsByTask(task.id)).toEqual([]);
      expect(eventsOf('AUTOMATION_REVIEW_FAILED')[0].structured_payload).toMatchObject({ reasonCode: 'AUTH_ERROR' });
      const attempt = repo.getTaskAttemptsByTask(task.id).find((a) => a.summary === 'desktop-review')!;
      expect(attempt.status).toBe('FAILED');
      await service.tick();
      await service.drain();
      expect(reviewRequests).toHaveLength(1);
    }, 120_000);

    it('releases a task left in REVIEWING by a BLOCKED verdict from before #308 (#310)', async () => {
      const task = await approvedTask();
      db.prepare("UPDATE tasks SET state = 'REVIEWING' WHERE id = ?").run(task.id);
      events.record(projectId, 'AUTOMATION_REVIEW_BLOCKED', 'Automated review: BLOCKED.', { verdict: 'BLOCKED' }, task.id);
      service = reviewingService();
      await service.tick();
      await service.drain();
      const after = repo.getTask(task.id)!;
      expect(after.state).toBe('CODING');
      expect(after.revision_count).toBe(task.revision_count + 1);
    }, 60_000);

    it('still sees an old verdict after more than 100 newer project events (#320)', async () => {
      const task = await approvedTask();
      db.prepare("UPDATE tasks SET state = 'REVIEWING' WHERE id = ?").run(task.id);
      events.record(projectId, 'AUTOMATION_REVIEW_BLOCKED', 'Automated review: BLOCKED.', { verdict: 'BLOCKED' }, task.id);
      for (let index = 0; index < 150; index += 1) events.record(projectId, 'FIXTURE_NOISE', `Noise ${index}`, {}, null);
      expect(repo.getEventsByProject(projectId).some((e) => e.type === 'AUTOMATION_REVIEW_BLOCKED')).toBe(false); // Outside the display window.
      service = reviewingService();
      await service.tick();
      await service.drain();
      expect(repo.getTask(task.id)).toMatchObject({ state: 'CODING', revision_count: task.revision_count + 1 });
    }, 60_000);

    it('sends a BLOCKED verdict back to the coder at the next revision instead of stalling in REVIEWING (#308)', async () => {
      reviewReply = verdict('BLOCKED');
      const { task } = await runToReview();

      const after = repo.getTask(task.id)!;
      expect(after.state).toBe('CODING');
      expect(after.revision_count).toBe(task.revision_count + 1);
      expect(repo.getReviewsByTask(task.id)[0].verdict).toBe('BLOCKED');
      expect(repo.getEventsByProject(projectId).some((e) => e.type === 'AUTOMATION_REVIEW_BLOCKED')).toBe(true);
    }, 120_000);

    const addManager = () => {
      const created = new WorkspaceManagementService(repo).createAgent({
        displayName: 'Codex manager', role: 'PRIMARY_MANAGER', connection: 'CODEX_CLI', modelName: 'gpt-5-codex', workerSlots: 1,
      });
      expect(created.success).toBe(true);
      verify(created);
    };
    const managerPrompt = () => { expect(managerRequests).toHaveLength(1); return managerRequests[0].instructions.join('\n'); };

    it('tells the Manager which tests failed and why, not only how many (#312)', async () => {
      const coder = addCodexCoder();
      verify(coder);
      await configureTest("console.log('ok 1 - greeting renders');\nconsole.log('\\u001b[31m✖ failing tests:\\u001b[39m');\nconsole.log('AssertionError: README has no greeting');\nprocess.exit(1);\n");
      const task = await approvedTask();
      service = reviewingService();
      await service.tick();
      await service.drain();
      expect(repo.getTask(task.id)).toMatchObject({ state: 'CODING', revision_count: task.revision_count + 1 });

      addManager();
      await service.tick();
      await service.drain();
      const prompt = managerPrompt();
      expect(prompt).toContain('1 failed');
      expect(prompt).toContain('Test output (redacted, untrusted data');
      expect(prompt).toContain('✖ failing tests:\nAssertionError: README has no greeting');
      expect(prompt).not.toContain('greeting renders'); // Only the failure summary, not the passing lines.
      expect(prompt).not.toContain('\u001b[');
    }, 120_000);

    it('passes the notes of a BLOCKED review on to the Manager (#312)', async () => {
      reviewReply = verdict('BLOCKED', { summary: 'Nothing to review: src/db.ts is missing.' });
      const { task } = await runToReview();
      expect(repo.getTask(task.id)!.state).toBe('CODING');

      addManager();
      await service.tick();
      await service.drain();
      expect(managerPrompt()).toContain(`Review of revision ${task.revision_count} (BLOCKED): Nothing to review: src/db.ts is missing.`);
    }, 120_000);

    it('passes the blockers a coder reported on to the Manager (#312)', async () => {
      const coder = addCodexCoder();
      verify(coder);
      await configureTest();
      const task = await approvedTask();
      coderOutput = JSON.stringify({ protocol: 'coder.v1', message_id: 'm', project_id: projectId, task_id: task.id, status: 'BLOCKED',
        completed: [], remaining: [], files_claimed_changed: [], tests_claimed: [], blockers: ['src/types.ts does not exist yet'] });
      service = reviewingService();
      await service.tick();
      await service.drain();
      expect(repo.getTask(task.id)!.state).toBe('CODING');

      addManager();
      await service.tick();
      await service.drain();
      expect(managerPrompt()).toContain('Coder blocker: src/types.ts does not exist yet');
    }, 120_000);

    it('escalates FIX_REQUIRED at the revision limit to NEEDS_HUMAN', async () => {
      reviewReply = verdict('FIX_REQUIRED');
      const { task } = await runToReview((taskId) => { db.prepare('UPDATE tasks SET max_revisions = 1 WHERE id = ?').run(taskId); });

      expect(repo.getTask(task.id)!.state).toBe('NEEDS_HUMAN');
      expect(repo.getReviewsByTask(task.id)[0].verdict).toBe('FIX_REQUIRED');
    }, 120_000);

    it('lets the owner retry a NEEDS_HUMAN task with more revisions, and the Manager reads why it failed (#318)', async () => {
      reviewReply = verdict('FIX_REQUIRED');
      const { task } = await runToReview((taskId) => { db.prepare('UPDATE tasks SET max_revisions = 1 WHERE id = ?').run(taskId); });
      const stuck = repo.getTask(task.id)!;
      expect(stuck).toMatchObject({ state: 'NEEDS_HUMAN', revision_count: 1, max_revisions: 1 });
      expect(tasks.retryTask('PROJ-OTHER', task.id)).toMatchObject({ success: false, errorCode: 'TASK_NOT_FOUND' });

      const retried = tasks.retryTask(projectId, task.id);
      expect(retried).toMatchObject({ success: true, task: { state: 'CODING', revision_count: 1, max_revisions: 4 } });
      expect(repo.getEventsByProject(projectId).filter((e) => e.type === 'OWNER_TASK_RETRIED')).toHaveLength(1);
      expect(tasks.retryTask(projectId, task.id)).toMatchObject({ success: false, errorCode: 'TASK_NOT_RETRYABLE' });

      addManager();
      await service.tick();
      await service.drain();
      expect(managerPrompt()).toContain('Review of revision 0 (FIX_REQUIRED): Synthetic review');
      expect(managerPrompt()).toContain('This is revision 1 of 4.');
    }, 120_000);

    it('never retries a trashed NEEDS_HUMAN task or changes it when a step fails (#318)', async () => {
      reviewReply = verdict('FIX_REQUIRED');
      const { task } = await runToReview((taskId) => { db.prepare('UPDATE tasks SET max_revisions = 1 WHERE id = ?').run(taskId); });
      expect(tasks.retryTask(projectId, task.id, 0)).toMatchObject({ success: false, errorCode: 'RETRY_REVISIONS_INVALID' });
      db.prepare('UPDATE tasks SET ownership_epoch = 0 WHERE id = ?').run(task.id); // An invalid epoch makes the transition binding fail.
      expect(tasks.retryTask(projectId, task.id)).toMatchObject({ success: false });
      expect(repo.getTask(task.id)).toMatchObject({ state: 'NEEDS_HUMAN', max_revisions: 1 }); // Rolled back.
    }, 120_000);

    it('does not apply a verdict when the project is stopped while the reviewer runs', async () => {
      const pass = verdict('PASS');
      reviewReply = (request) => {
        db.prepare("UPDATE projects SET status = 'PAUSED' WHERE id = ?").run(projectId);
        return pass(request);
      };
      const { task } = await runToReview();

      expect(repo.getTask(task.id)!.state).toBe('REVIEWING');
      expect(repo.getReviewsByTask(task.id)).toEqual([]);
      expect(eventsOf('AUTOMATION_REVIEW_FAILED')[0].structured_payload).toMatchObject({ reasonCode: 'PROJECT_NOT_RUNNING' });
    }, 120_000);

    it('never reviews on the coder’s account', async () => {
      reviewReply = verdict('PASS');
      let coderAccount = '';
      const { task } = await runToReview((taskId) => {
        const coderAssignment = repo.getAgentAssignmentsByTask(taskId)[0];
        coderAccount = coderAssignment.selected_account_id;
        const reviewerAgent = repo.getAllAgents().find((agent) => agent.role === 'REVIEWER')!;
        db.prepare('UPDATE provider_resources SET provider_account_id = ? WHERE id = ?').run(coderAccount, reviewerAgent.provider_resource_id);
      });

      expect(coderAccount).not.toBe('');
      expect(reviewRequests).toHaveLength(0);
      expect(repo.getTask(task.id)!.state).toBe('REVIEW_READY');
      expect(statusOf()).toMatchObject({ phase: 'AWAITING_REVIEW', taskId: task.id, reasonCode: 'REVIEWER_NOT_AVAILABLE' });
    }, 120_000);

    it('skips a reviewer whose adapter cannot review and uses one that can', async () => {
      registry.register(synthetic('prov-gemini-cli', ['CODING']));
      const coder = addCodexCoder();
      verify(coder);
      const gemini = new WorkspaceManagementService(repo).createAgent({
        displayName: 'Gemini reviewer', role: 'REVIEWER', connection: 'GEMINI_CLI', modelName: 'gemini-2.5-pro', workerSlots: 1,
      });
      verify(gemini);
      await configureTest();
      const task = await approvedTask();
      service = reviewingService();
      await service.tick();
      await service.drain();
      await service.tick();
      await service.drain();
      expect(reviewRequests).toHaveLength(0);
      expect(repo.getTask(task.id)!.state).toBe('REVIEW_READY');
      expect(statusOf()).toMatchObject({ phase: 'AWAITING_REVIEW', taskId: task.id, reasonCode: 'REVIEWER_NOT_AVAILABLE' });

      reviewReply = verdict('PASS');
      const codex = addReviewer();
      await service.tick();
      await service.drain();
      expect(reviewRequests).toHaveLength(1);
      expect(reviewRequests[0].runtimeBinding!.accountId).toBe(accountOf(codex));
      expect(repo.getTask(task.id)!.state).toBe('DONE');
    }, 120_000);

    it('retries a review that could not start, after the retry delay, without consuming the work', async () => {
      reviewReply = verdict('PASS');
      const { task } = await runToReview(() => { healthy = false; });

      expect(reviewRequests).toHaveLength(0);
      expect(repo.getTask(task.id)!.state).toBe('REVIEW_READY');
      expect(eventsOf('AUTOMATION_REVIEW_NOT_RUN')[0].structured_payload).toMatchObject({ reasonCode: 'ROUTING_NOT_SELECTED' });
      expect(eventsOf('AUTOMATION_REVIEW_FAILED')).toEqual([]);
      const failedAttempt = repo.getTaskAttemptsByTask(task.id).find((a) => a.summary === 'desktop-review')!;
      expect(failedAttempt.status).toBe('FAILED');
      expect(statusOf()).toMatchObject({ phase: 'AWAITING_REVIEW', reasonCode: 'REVIEWER_NOT_AVAILABLE' });

      healthy = true;
      await service.tick();
      await service.drain();
      expect(reviewRequests).toHaveLength(0); // Still inside the retry delay.
      clock = 6 * 60_000;
      await service.tick();
      await service.drain();
      expect(reviewRequests).toHaveLength(1);
      expect(repo.getTask(task.id)!.state).toBe('DONE');
    }, 120_000);

    it('fences an interrupted review on restart and never infers a verdict', async () => {
      let finishHung: (result: AgentExecutionResult) => void = () => undefined;
      reviewReply = () => new Promise((resolve) => { finishHung = resolve; });
      const coder = addCodexCoder();
      verify(coder);
      addReviewer();
      await configureTest();
      const task = await approvedTask();
      const first = reviewingService();
      service = first;
      await first.tick();
      await first.drain();
      void first.tick();
      await vi.waitFor(() => expect(reviewRequests).toHaveLength(1), { timeout: 30_000 });
      expect(repo.getTask(task.id)!.state).toBe('REVIEWING');
      expect(first.getStatus().projects.find((p) => p.projectId === projectId)).toMatchObject({ phase: 'REVIEWING', taskId: task.id });
      const attempt = repo.getTaskAttemptsByTask(task.id).find((a) => a.summary === 'desktop-review')!;
      const assignment = repo.getAgentAssignmentsByTask(task.id).find((a) => a.attempt_id === attempt.id)!;
      const executionId = reviewRequests[0].runtimeBinding!.executionId!;

      // A restart before the lease expired defers: nothing is released yet.
      const early = reviewingService(() => new Date().toISOString());
      await early.tick();
      expect(repo.getTaskAttempt(attempt.id)!.status).toBe('RUNNING');
      expect(repo.getActiveLeaseForAssignment(assignment.id)).not.toBeNull();

      // (a) A process that may still run keeps everything fenced.
      repo.createProcessRun({ id: executionId, pid: null, project_id: projectId, task_id: task.id, attempt_id: attempt.id,
        command: 'codex exec', working_directory: tempDir, status: 'RUNNING', start_time: new Date().toISOString() });
      const later = () => new Date(Date.now() + 10 * 60_000).toISOString();
      const restarted = reviewingService(later);
      // Teardown drains the restarted service; the hung first one is released below.
      service = restarted;
      onTestFinished(() => finishHung({ executionId, status: 'CANCELLED', errorCode: 'CANCELLED' }));
      await restarted.tick();
      expect(repo.getTaskAttempt(attempt.id)!.status).toBe('RUNNING');
      expect(repo.getActiveLeaseForAssignment(assignment.id)).not.toBeNull();
      expect(eventsOf('AUTOMATION_REVIEW_INTERRUPTED')[0].structured_payload).toMatchObject({ reasonCode: 'PROCESS_NOT_PROVEN_STOPPED' });

      // (b) Once the process is terminal, the expired lease is released and the attempt ends; no verdict, no retry.
      db.prepare("UPDATE process_runs SET status = 'FAILED' WHERE id = ?").run(executionId);
      await restarted.tick();
      await restarted.drain();
      expect(repo.getTaskAttempt(attempt.id)!.status).toBe('FAILED');
      expect(repo.getAgentAssignment(assignment.id)!.status).toBe('FAILED');
      expect(repo.getActiveLeaseForAssignment(assignment.id)).toBeNull();
      expect(eventsOf('AUTOMATION_REVIEW_INTERRUPTED').some((e) => (e.structured_payload as any).reasonCode === 'REVIEW_INTERRUPTED')).toBe(true);
      expect(repo.getTask(task.id)!.state).toBe('REVIEWING');
      expect(repo.getReviewsByTask(task.id)).toEqual([]);
      expect(reviewRequests).toHaveLength(1);

      // The old process's late result is not applied either.
      finishHung(verdict('PASS')(reviewRequests[0]));
      await first.drain();
      expect(repo.getTask(task.id)!.state).toBe('REVIEWING');
      expect(repo.getReviewsByTask(task.id)).toEqual([]);
    }, 120_000);
  });
  describe('account-bound automated Manager (#239)', () => {
    let clock = 0;
    const managedService = () => new DesktopAutomationService(repo, events, registry, {
      worktreeRoot: path.join(tempDir, 'worktrees'), timer: fakeTimer, taskService: tasks, verificationService: verification,
      now: () => new Date(Date.now() + clock).toISOString(),
    });
    beforeEach(() => { clock = 0; });
    const plannedTask = () => tasks.createTask({ projectId, title: 'Add a greeting', description: 'Manager test', priority: 'LOW', risk: 'LOW',
      acceptanceCriteria: ['Greeting exists'], constraints: [] });
    const addAgent = (role: 'PRIMARY_MANAGER' | 'REVIEWER', connection: 'CODEX_CLI' | 'GEMINI_CLI' = 'CODEX_CLI') => {
      const created = new WorkspaceManagementService(repo).createAgent({
        displayName: `${role} ${connection}`, role, connection, modelName: connection === 'CODEX_CLI' ? 'gpt-5-codex' : 'gemini-2.5-pro', workerSlots: 1,
      });
      expect(created.success).toBe(true);
      verify(created);
      return created;
    };
    /** A manager.v1 answer bound to the task as it is when the Manager runs. */
    const decision = (value: string, overrides: Record<string, unknown> = {}) => (request: AgentExecutionRequest): AgentExecutionResult => {
      const task = repo.getTask(request.taskId)!;
      return {
        executionId: request.runtimeBinding?.executionId ?? 'x', status: 'COMPLETED',
        outputProtocol: JSON.stringify({
          protocol: 'manager.v1', message_id: 'reused-provider-id', project_id: projectId, task_id: task.id, decision: value,
          instructions: [`Do revision ${task.revision_count}`], expected_task_state: task.state, expected_revision: task.revision_count, ...overrides,
        }),
      };
    };
    const eventsOf = (type: string) => repo.getEventsByProject(projectId).filter((e) => e.type === type);
    const pass = async () => { await service.tick(); await service.drain(); };

    it('says a Manager agent is missing for a planned task and never dispatches it', async () => {
      const task = plannedTask();
      service = managedService();
      await pass();
      expect(repo.getTask(task.id)!.state).toBe('PLANNED');
      expect(statusOf()).toMatchObject({ phase: 'WAITING_FOR_MANAGER', taskId: task.id, reasonCode: 'NO_MANAGER' });
    });

    it('proposes in approve mode (the default) and applies only after the owner approves', async () => {
      addAgent('PRIMARY_MANAGER');
      managerReply = decision('EXECUTE');
      const task = plannedTask();
      service = managedService();
      await pass();

      expect(managerRequests).toHaveLength(1);
      expect(managerRequests[0].contextFiles).toEqual([]);
      expect(repo.getTask(task.id)!.state).toBe('PLANNED');
      expect(statusOf()).toMatchObject({ phase: 'WAITING_FOR_MANAGER', taskId: task.id, reasonCode: 'MANAGER_PROPOSAL_PENDING' });
      const [proposal] = service.getManager()!.listProposals(projectId);
      expect(proposal).toMatchObject({ taskId: task.id, decision: 'EXECUTE', instructions: ['Do revision 0'] });
      await pass();
      expect(managerRequests).toHaveLength(1); // An open proposal is never asked again.

      expect(await service.getManager()!.decideProposal(projectId, proposal.eventId, true)).toEqual({ success: true });
      expect(repo.getTask(task.id)!.state).toBe('CODING');
      expect(await service.getManager()!.decideProposal(projectId, proposal.eventId, true)).toMatchObject({ success: false, errorCode: 'PROPOSAL_ALREADY_DECIDED' });
    });

    it('records a rejected proposal and does not ask the Manager again for that revision', async () => {
      addAgent('PRIMARY_MANAGER');
      managerReply = decision('EXECUTE');
      const task = plannedTask();
      service = managedService();
      await pass();
      const [proposal] = service.getManager()!.listProposals(projectId);
      expect(await service.getManager()!.decideProposal(projectId, proposal.eventId, false)).toEqual({ success: true });
      await pass();

      expect(managerRequests).toHaveLength(1);
      expect(repo.getTask(task.id)!.state).toBe('PLANNED');
      expect(statusOf()).toMatchObject({ reasonCode: 'MANAGER_PROPOSAL_REJECTED' });
    });

    it('refuses to apply a proposal the task has moved past', async () => {
      addAgent('PRIMARY_MANAGER');
      managerReply = decision('EXECUTE');
      const task = plannedTask();
      service = managedService();
      await pass();
      const [proposal] = service.getManager()!.listProposals(projectId);
      const manual = { protocol: 'manager.v1' as const, message_id: `owner-${crypto.randomUUID()}`, project_id: projectId, task_id: task.id,
        decision: 'EXECUTE' as const, priority: 'LOW' as const, risk: 'LOW' as const, instructions: ['Owner start'], acceptance_criteria: [],
        constraints: [], review_issues: [], expected_task_state: 'PLANNED' as const, expected_revision: 0 };
      expect((await tasks.applyManagerDecision(manual, JSON.stringify(manual))).success).toBe(true);

      expect(await service.getManager()!.decideProposal(projectId, proposal.eventId, true)).toMatchObject({ success: false });
      expect(repo.getTask(task.id)!.state).toBe('CODING');
    });

    it.each([
      ['a disallowed verdict', decision('PASS'), 'MANAGER_DECISION_NOT_ALLOWED'],
      ['BLOCK for a task that has not started', decision('BLOCK'), 'MANAGER_DECISION_NOT_ALLOWED'],
      ['a stale revision', decision('EXECUTE', { expected_revision: 4 }), 'MANAGER_DECISION_STALE'],
      ['another task', decision('EXECUTE', { task_id: 'TSK-OTHER' }), 'MANAGER_DECISION_FOR_OTHER_TASK'],
      ['malformed output', (request: AgentExecutionRequest): AgentExecutionResult => ({ executionId: request.runtimeBinding!.executionId!, status: 'COMPLETED', outputProtocol: '{"protocol":"coder.v1"}' }), 'MANAGER_PROTOCOL_INVALID'],
    ])('never applies %s and does not retry it', async (_name, reply, reasonCode) => {
      addAgent('PRIMARY_MANAGER');
      repo.setProjectManagerMode(projectId, 'AUTO');
      managerReply = reply;
      const task = plannedTask();
      service = managedService();
      await pass();
      clock = 10 * 60_000;
      await pass();

      expect(managerRequests).toHaveLength(1);
      expect(repo.getTask(task.id)!.state).toBe('PLANNED');
      expect(eventsOf('AUTOMATION_MANAGER_FAILED')[0].structured_payload).toMatchObject({ reasonCode, retryable: false });
      expect(statusOf()).toMatchObject({ reasonCode: 'MANAGER_FAILED' });
    });

    it('retries a provider failure after a delay, at most three times', async () => {
      addAgent('PRIMARY_MANAGER');
      repo.setProjectManagerMode(projectId, 'AUTO');
      managerReply = (request) => ({ executionId: request.runtimeBinding!.executionId!, status: 'FAILED', errorCode: 'QUOTA_EXHAUSTED' });
      const task = plannedTask();
      service = managedService();
      await pass();
      await pass();
      expect(managerRequests).toHaveLength(1); // Inside the retry delay.
      for (let attempt = 1; attempt <= 4; attempt += 1) { clock = attempt * 6 * 60_000; await pass(); }

      expect(managerRequests).toHaveLength(3);
      expect(repo.getTask(task.id)!.state).toBe('PLANNED');
      expect(statusOf()).toMatchObject({ reasonCode: 'MANAGER_FAILED' });
    });

    it('honours a switch to approve mode made while the Manager was deciding', async () => {
      addAgent('PRIMARY_MANAGER');
      repo.setProjectManagerMode(projectId, 'AUTO');
      let finish: (result: AgentExecutionResult) => void = () => undefined;
      managerReply = () => new Promise((resolve) => { finish = resolve; });
      const task = plannedTask();
      service = managedService();
      void service.tick();
      await vi.waitFor(() => expect(managerRequests).toHaveLength(1), { timeout: 30_000 });
      repo.setProjectManagerMode(projectId, 'APPROVE');
      finish(decision('EXECUTE')(managerRequests[0]));
      await service.drain();

      expect(repo.getTask(task.id)!.state).toBe('PLANNED');
      expect(service.getManager()!.listProposals(projectId)).toHaveLength(1);
    });

    it('never applies an answer that arrives after the call lost its lease', async () => {
      addAgent('PRIMARY_MANAGER');
      repo.setProjectManagerMode(projectId, 'AUTO');
      let finish: (result: AgentExecutionResult) => void = () => undefined;
      managerReply = () => new Promise((resolve) => { finish = resolve; });
      const task = plannedTask();
      service = managedService();
      void service.tick();
      await vi.waitFor(() => expect(managerRequests).toHaveLength(1), { timeout: 30_000 });
      clock = 10 * 60_000; // e.g. the machine slept: the lease expired without a heartbeat.
      finish(decision('EXECUTE')(managerRequests[0]));
      await service.drain();

      expect(repo.getTask(task.id)!.state).toBe('PLANNED');
      expect(eventsOf('AUTOMATION_MANAGER_FAILED')[0].structured_payload).toMatchObject({ reasonCode: 'MANAGER_LEASE_OR_FENCE_LOST', retryable: true });
    });

    it('decides a proposal exactly once when Approve and Reject race', async () => {
      addAgent('PRIMARY_MANAGER');
      managerReply = decision('EXECUTE');
      const task = plannedTask();
      service = managedService();
      await pass();
      const [proposal] = service.getManager()!.listProposals(projectId);
      const results = await Promise.all([
        service.getManager()!.decideProposal(projectId, proposal.eventId, true),
        service.getManager()!.decideProposal(projectId, proposal.eventId, false),
      ]);

      expect(results.filter((result) => result.success)).toHaveLength(1);
      expect(eventsOf('AUTOMATION_MANAGER_PROPOSAL_CLAIMED')).toHaveLength(1);
      const applied = eventsOf('AUTOMATION_MANAGER_APPLIED').length;
      const rejected = eventsOf('AUTOMATION_MANAGER_REJECTED').length;
      expect(applied + rejected).toBe(1);
      expect(repo.getTask(task.id)!.state).toBe(applied === 1 ? 'CODING' : 'PLANNED');
    });

    it('does not let a task waiting to retry block the Manager for other tasks', async () => {
      addAgent('PRIMARY_MANAGER');
      repo.setProjectManagerMode(projectId, 'AUTO');
      const first = plannedTask();
      const second = tasks.createTask({ projectId, title: 'Second task', description: null, priority: 'LOW', risk: 'LOW', acceptanceCriteria: ['x'], constraints: [] });
      const execute = decision('EXECUTE');
      managerReply = (request) => request.taskId === first.id
        ? { executionId: request.runtimeBinding!.executionId!, status: 'FAILED', errorCode: 'QUOTA_EXHAUSTED' }
        : execute(request);
      service = managedService();
      await pass();
      await pass();

      expect(managerRequests.map((request) => request.taskId)).toEqual([first.id, second.id]);
      expect(repo.getTask(second.id)!.state).toBe('CODING');
      // The second task now waits for a coder; the first waits out its retry delay.
      expect(service.getManager()!.pendingDecision(projectId)).toMatchObject({ task: { id: first.id }, deferred: true });
    });

    it('does not use a Manager whose CLI cannot manage', async () => {
      registry.register(synthetic('prov-gemini-cli', ['CODING']));
      addAgent('PRIMARY_MANAGER', 'GEMINI_CLI');
      const task = plannedTask();
      service = managedService();
      await pass();
      expect(managerRequests).toHaveLength(0);
      expect(statusOf()).toMatchObject({ taskId: task.id, reasonCode: 'MANAGER_NOT_AVAILABLE' });
    });

    it('fences an interrupted Manager call on restart and asks again, never inferring a decision', async () => {
      addAgent('PRIMARY_MANAGER');
      repo.setProjectManagerMode(projectId, 'AUTO');
      let finishHung: (result: AgentExecutionResult) => void = () => undefined;
      managerReply = () => new Promise((resolve) => { finishHung = resolve; });
      const task = plannedTask();
      const first = managedService();
      service = first;
      void first.tick();
      await vi.waitFor(() => expect(managerRequests).toHaveLength(1), { timeout: 30_000 });
      expect(first.getStatus().projects.find((p) => p.projectId === projectId)).toMatchObject({ phase: 'DECIDING', taskId: task.id });
      const attempt = repo.getTaskAttemptsByTask(task.id).find((a) => a.summary === 'desktop-manager')!;

      clock = 10 * 60_000;
      managerReply = decision('EXECUTE');
      const restarted = managedService();
      service = restarted;
      onTestFinished(() => finishHung({ executionId: 'x', status: 'CANCELLED', errorCode: 'CANCELLED' }));
      await restarted.tick();
      await restarted.drain();

      expect(repo.getTaskAttempt(attempt.id)!.status).toBe('FAILED');
      expect(eventsOf('AUTOMATION_MANAGER_INTERRUPTED')).toHaveLength(1);
      expect(managerRequests).toHaveLength(2);
      expect(repo.getTask(task.id)!.state).toBe('CODING');
      finishHung(decision('BLOCK')(managerRequests[0]));
      await first.drain();
      expect(repo.getTask(task.id)!.state).toBe('CODING'); // The old call's late answer changed nothing.
    }, 60_000);

    it.runIf(process.platform === 'win32')('runs a planned task to DONE through Manager, coder, tests and a FIX review without pasted JSON', async () => {
      verify(addCodexCoder());
      addAgent('REVIEWER');
      addAgent('PRIMARY_MANAGER');
      repo.setProjectManagerMode(projectId, 'AUTO');
      fs.writeFileSync(path.join(repoDir, 'verify.js'), 'process.exit(0);\n', 'utf8');
      git('add', 'verify.js');
      git('commit', '-m', 'add verification script');
      repo.createVerificationCommand({
        id: `vc-${crypto.randomUUID()}`, project_id: projectId, name: 'Fixture test', command_type: 'TEST',
        ...await approveFixtureCommand(repo, projectId, ['verify.js']), timeout_ms: 60_000, enabled: true,
      });
      managerReply = decision('EXECUTE');
      let reviews = 0;
      reviewReply = (request) => {
        const verified = repo.getEventsByProject(projectId).filter((e) => e.type === 'AUTOMATION_VERIFICATION_PASSED').at(-1)!.structured_payload as any;
        const value = reviews++ === 0 ? 'FIX_REQUIRED' : 'PASS';
        return { executionId: request.runtimeBinding!.executionId!, status: 'COMPLETED', outputProtocol: JSON.stringify({
          protocol: 'review.v1', message_id: `review-${crypto.randomUUID()}`, project_id: projectId, task_id: request.taskId,
          task_revision: repo.getTask(request.taskId)!.revision_count, verdict: value, summary: 'Synthetic review',
          issues: value === 'FIX_REQUIRED' ? [{ severity: 'REQUIRED', title: 'Missing greeting', description: 'README has no greeting.' }] : [],
          reviewed_head_sha: verified.headSha, reviewed_snapshot_sha: verified.snapshotSha,
        }) };
      };
      const task = plannedTask();
      service = managedService();
      for (let i = 0; i < 8 && repo.getTask(task.id)!.state !== 'DONE'; i += 1) await pass();

      expect(repo.getTask(task.id)!.state).toBe('DONE');
      expect(managerRequests).toHaveLength(2);
      expect(managerRequests[1].instructions.join('\n')).toContain('Missing greeting');
      expect(adapterCalls).toBe(2);
      expect(eventsOf('AUTOMATION_MANAGER_APPLIED')).toHaveLength(2);
      expect(repo.getReviewsByTask(task.id).map((review) => review.verdict).sort()).toEqual(['FIX_REQUIRED', 'PASS']);
    }, 240_000);
  });
  describe.runIf(process.platform === 'win32')('owner-controlled integration of reviewed work (#238)', () => {
    const integratingService = () => new DesktopAutomationService(repo, events, registry, {
      worktreeRoot: path.join(tempDir, 'worktrees'), timer: fakeTimer, taskService: tasks, verificationService: verification,
    });
    const reviewerAgent = () => {
      const created = new WorkspaceManagementService(repo).createAgent({
        displayName: 'Codex reviewer', role: 'REVIEWER', connection: 'CODEX_CLI', modelName: 'gpt-5-codex', workerSlots: 1,
      });
      expect(created.success).toBe(true);
      verify(created);
    };
    /** Coder edits README.md and adds NOTES.md; tests pass; the reviewer passes the exact verified snapshot. */
    const runToDone = async () => {
      verify(addCodexCoder());
      reviewerAgent();
      fs.writeFileSync(path.join(repoDir, 'verify.js'), 'process.exit(0);\n', 'utf8');
      git('add', 'verify.js');
      git('commit', '-m', 'add verification script');
      repo.createVerificationCommand({
        id: `vc-${crypto.randomUUID()}`, project_id: projectId, name: 'Fixture test', command_type: 'TEST',
        ...await approveFixtureCommand(repo, projectId, ['verify.js']), timeout_ms: 60_000, enabled: true,
      });
      coderEdits = (worktree) => {
        fs.appendFileSync(path.join(worktree, 'README.md'), 'Hello from the coder\n', 'utf8');
        fs.writeFileSync(path.join(worktree, 'NOTES.md'), '# Notes\n', 'utf8');
      };
      reviewReply = (request) => {
        const verified = repo.getEventsByProject(projectId).filter((e) => e.type === 'AUTOMATION_VERIFICATION_PASSED').at(-1)!.structured_payload as any;
        return { executionId: request.runtimeBinding!.executionId!, status: 'COMPLETED', outputProtocol: JSON.stringify({
          protocol: 'review.v1', message_id: `review-${crypto.randomUUID()}`, project_id: projectId, task_id: request.taskId,
          task_revision: repo.getTask(request.taskId)!.revision_count, verdict: 'PASS', summary: 'Looks right', issues: [],
          reviewed_head_sha: verified.headSha, reviewed_snapshot_sha: verified.snapshotSha,
        }) };
      };
      const task = await approvedTask();
      service = integratingService();
      for (let i = 0; i < 4 && repo.getTask(task.id)!.state !== 'DONE'; i += 1) { await service.tick(); await service.drain(); }
      expect(repo.getTask(task.id)!.state).toBe('DONE');
      const worktree = (repo.getEventsByProject(projectId).find((e) => e.type === 'AUTOMATION_VERIFICATION_PASSED')!.structured_payload as any).worktree as string;
      return { task, worktree };
    };

    it('creates a branch from exactly the reviewed work only when the owner asks, never touching the default branch', async () => {
      const { task, worktree } = await runToDone();
      const mainBefore = git('rev-parse', 'main');
      expect(statusOf()).toMatchObject({ phase: 'READY_FOR_INTEGRATION', taskId: task.id });
      expect(service.getIntegration().list(projectId)).toEqual([expect.objectContaining({ taskId: task.id, state: 'READY' })]);
      expect(git('branch', '--list', 'agent/*')).toBe(''); // Nothing happens without the owner.

      const created = await service.getIntegration().createBranch(projectId, task.id);
      expect(created).toMatchObject({ success: true });
      const branch = (created as { branch: string }).branch;
      expect(branch).toMatch(/^agent\/add-a-greeting-[a-z0-9]+-r0$/);
      expect(git('rev-parse', `${branch}^`)).toBe(mainBefore);
      expect(git('diff', '--name-only', mainBefore, branch).split(/\r?\n/).sort()).toEqual(['NOTES.md', 'README.md']);
      expect(git('show', `${branch}:README.md`)).toContain('Hello from the coder');
      expect(git('rev-parse', 'main')).toBe(mainBefore);
      expect(git('branch', '--show-current')).toBe('main');
      expect(fs.readFileSync(path.join(repoDir, 'README.md'), 'utf8')).toBe('# Fixture\n'); // The owner's checkout is untouched.
      expect(fs.existsSync(worktree)).toBe(false); // The retained worktree is removed.
      expect(service.getIntegration().list(projectId)[0]).toMatchObject({ state: 'BRANCH_CREATED', branch, changedFiles: ['NOTES.md', 'README.md'] });
      expect(await service.getIntegration().createBranch(projectId, task.id)).toEqual({ success: false, errorCode: 'ALREADY_INTEGRATED' });
      // Discard after a branch keeps the branch outcome (it only cleans up a leftover copy).
      expect(await service.getIntegration().discard(projectId, task.id)).toEqual({ success: true });
      expect(service.getIntegration().list(projectId)[0]).toMatchObject({ state: 'BRANCH_CREATED', branch });
    }, 180_000);

    it('names branches readably for Vietnamese titles, cut at a word boundary (found in the trial)', () => {
      const name = (title: string) => WorktreeIntegrationService.branchName({ title, id: 'TSK-552ADE2A', revision_count: 0 } as any);
      expect(name('Thêm hàm slugify vào src/text.js kèm test')).toBe('agent/them-ham-slugify-vao-src-text-js-kem-552ade2a-r0');
      expect(name('Đường số 1')).toBe('agent/duong-so-1-552ade2a-r0');
    });

    it('integrates reviewed work into the checked-out default branch with a fast-forward and reports 100% progress', async () => {
      const { task } = await runToDone();
      expect(repo.getTask(task.id)!.progress_cache_percent).toBe(100); // Refreshed on every automated transition.
      const mainBefore = git('rev-parse', 'main');
      const created = await service.getIntegration().createBranch(projectId, task.id);
      expect(created).toMatchObject({ success: true });
      const merged = await service.getIntegration().mergeIntoDefault(projectId, task.id);
      expect(merged).toMatchObject({ success: true, commitSha: (created as any).commitSha });
      expect(git('rev-parse', 'main')).toBe((created as any).commitSha);
      expect(git('rev-parse', 'main^')).toBe(mainBefore);
      expect(fs.readFileSync(path.join(repoDir, 'README.md'), 'utf8')).toContain('Hello from the coder'); // The checkout follows.
      expect(git('status', '--porcelain')).toBe('');
      expect(git('branch', '--list', 'agent/*')).toBe(''); // The merged branch is removed safely.
      expect(service.getIntegration().list(projectId)[0]).toMatchObject({ state: 'BRANCH_CREATED', mergedInto: 'main', mergeSkipped: null });
      expect(await service.getIntegration().mergeIntoDefault(projectId, task.id)).toEqual({ success: false, errorCode: 'ALREADY_MERGED' });
    }, 180_000);

    it('leaves the branch for the owner when the checkout has uncommitted changes, then integrates on request', async () => {
      const { task } = await runToDone();
      await service.getIntegration().createBranch(projectId, task.id);
      const mainBefore = git('rev-parse', 'main');
      fs.appendFileSync(path.join(repoDir, 'verify.js'), '// owner edit\n', 'utf8');
      expect(await service.getIntegration().mergeIntoDefault(projectId, task.id)).toEqual({ success: false, errorCode: 'OWNER_CHECKOUT_HAS_CHANGES' });
      expect(git('rev-parse', 'main')).toBe(mainBefore);
      expect(fs.readFileSync(path.join(repoDir, 'verify.js'), 'utf8')).toContain('// owner edit'); // Never touched.
      expect(service.getIntegration().list(projectId)[0]).toMatchObject({ mergedInto: null, mergeSkipped: 'OWNER_CHECKOUT_HAS_CHANGES' });
      git('checkout', '--', 'verify.js');
      expect(await service.getIntegration().mergeIntoDefault(projectId, task.id)).toMatchObject({ success: true });
      expect(service.getIntegration().list(projectId)[0]).toMatchObject({ mergedInto: 'main', mergeSkipped: null });
    }, 180_000);

    it('creates a merge commit when the default branch moved without conflict, and keeps a conflicting branch', async () => {
      const { task } = await runToDone();
      await service.getIntegration().createBranch(projectId, task.id);
      fs.writeFileSync(path.join(repoDir, 'OTHER.md'), 'owner work\n', 'utf8');
      git('add', 'OTHER.md');
      git('commit', '-m', 'owner work on main');
      const moved = git('rev-parse', 'main');
      expect(await service.getIntegration().mergeIntoDefault(projectId, task.id)).toMatchObject({ success: true });
      expect(git('rev-list', '--parents', '-n', '1', 'main').split(' ')).toHaveLength(3); // A merge commit with two parents.
      expect(git('rev-parse', 'main^1')).toBe(moved);
      expect(fs.readFileSync(path.join(repoDir, 'README.md'), 'utf8')).toContain('Hello from the coder');
      expect(fs.readFileSync(path.join(repoDir, 'OTHER.md'), 'utf8')).toBe('owner work\n');
    }, 180_000);

    it('keeps the branch when it conflicts with newer work on the default branch', async () => {
      const { task } = await runToDone();
      await service.getIntegration().createBranch(projectId, task.id);
      fs.writeFileSync(path.join(repoDir, 'README.md'), '# Fixture\nOwner rewrote this line\n', 'utf8');
      git('commit', '-am', 'owner edits README');
      const before = git('rev-parse', 'main');
      expect(await service.getIntegration().mergeIntoDefault(projectId, task.id)).toEqual({ success: false, errorCode: 'MERGE_CONFLICT' });
      expect(git('rev-parse', 'main')).toBe(before);
      expect(git('status', '--porcelain')).toBe('');
      expect(git('branch', '--list', 'agent/*')).not.toBe('');
    }, 180_000);

    it('integrates automatically on the next pass when the owner opted in', async () => {
      repo.setProjectAutoIntegrate(projectId, true);
      const { task } = await runToDone();
      for (let i = 0; i < 3 && !service.getIntegration().list(projectId)[0]?.mergedInto; i += 1) { await service.tick(); await service.drain(); }
      expect(service.getIntegration().list(projectId)[0]).toMatchObject({ taskId: task.id, mergedInto: 'main' });
      expect(fs.readFileSync(path.join(repoDir, 'README.md'), 'utf8')).toContain('Hello from the coder');
      // Everything is done, reviewed and integrated: the next pass completes the project (#283).
      await service.tick(); await service.drain();
      const project = repo.getProjectMetadata(projectId)!;
      expect(project.status).toBe('COMPLETED');
      expect(project.completed_at).toBeTruthy();
      expect(repo.getEventsByProject(projectId).filter((e) => e.type === 'AUTOMATION_PROJECT_COMPLETED')).toHaveLength(1);
      expect(statusOf()).toMatchObject({ phase: 'PROJECT_COMPLETED' });
    }, 180_000);

    it('keeps the project running while a skipped merge waits for the owner', async () => {
      repo.setProjectAutoIntegrate(projectId, true);
      const { task } = await runToDone();
      fs.appendFileSync(path.join(repoDir, 'verify.js'), '// owner edit\n', 'utf8');
      for (let i = 0; i < 3 && !service.getIntegration().list(projectId)[0]?.mergeSkipped; i += 1) { await service.tick(); await service.drain(); }
      expect(service.getIntegration().list(projectId)[0]).toMatchObject({ taskId: task.id, mergeSkipped: 'OWNER_CHECKOUT_HAS_CHANGES' });
      await service.tick(); await service.drain();
      expect(repo.getProjectMetadata(projectId)!.status).toBe('RUNNING');
      git('checkout', '--', 'verify.js');
      expect(await service.getIntegration().mergeIntoDefault(projectId, task.id)).toMatchObject({ success: true });
      await service.tick(); await service.drain();
      expect(repo.getProjectMetadata(projectId)!.status).toBe('COMPLETED');
    }, 180_000);

    it('without automatic integration, completes only after the owner took the reviewed work', async () => {
      const { task } = await runToDone();
      await service.tick(); await service.drain();
      expect(repo.getProjectMetadata(projectId)!.status).toBe('RUNNING'); // The work waits for the owner.
      expect(await service.getIntegration().createBranch(projectId, task.id)).toMatchObject({ success: true });
      await service.tick(); await service.drain();
      expect(repo.getProjectMetadata(projectId)!.status).toBe('COMPLETED');
      expect(git('branch', '--list', 'agent/*')).not.toBe(''); // The branch stays for the owner; nothing is merged.
    }, 180_000);

    it('refuses work that changed after it was reviewed', async () => {
      const { task, worktree } = await runToDone();
      fs.appendFileSync(path.join(worktree, 'README.md'), 'tampered\n', 'utf8');
      expect(await service.getIntegration().createBranch(projectId, task.id)).toEqual({ success: false, errorCode: 'SNAPSHOT_CHANGED_SINCE_REVIEW' });
      expect(git('branch', '--list', 'agent/*')).toBe('');
    }, 180_000);

    const tupleOf = (taskId: string) => {
      const auth = repo.getExecutionAuthorizationsByTask(taskId)[0];
      const assignment = repo.getAgentAssignment(auth.assignment_id!)!;
      return { projectId, taskId, attemptId: auth.attempt_id, assignmentId: assignment.id, workerSlotId: assignment.selected_worker_slot_id!,
        baseSha: auth.repository_head_sha, ownershipEpoch: auth.task_ownership_epoch };
    };
    const worktreesFor = () => new GitWorktreeService({ gitExecutable: resolveTrustedExecutable('git', 'git')!, repositoryRoot: repoDir, managedRoot: path.join(tempDir, 'worktrees', projectId) });

    it('adopts exactly the intended commit of an interrupted attempt', async () => {
      const { task, worktree } = await runToDone();
      // Simulate a crash after the intent and the branch were written but before the result was recorded.
      const reviewEventId = repo.getEventsByProject(projectId).find((e) => e.type === 'AUTOMATION_REVIEW_PASSED')!.id;
      const branch = WorktreeIntegrationService.branchName(repo.getTask(task.id)!);
      const committed = await worktreesFor().commitChangesToNewBranch(tupleOf(task.id), branch, 'interrupted', ['NOTES.md', 'README.md'], (commitSha) => {
        events.record(projectId, 'AUTOMATION_INTEGRATION_INTENT', 'intent', { reviewEventId, branch, commitSha, taskRevision: 0 }, task.id);
      });
      expect(committed.status).toBe('COMMITTED');

      expect(await service.getIntegration().createBranch(projectId, task.id)).toMatchObject({ success: true, branch, worktreeRemoved: true });
      expect(fs.existsSync(worktree)).toBe(false);
      expect(repo.getEventsByProject(projectId).find((e) => e.type === 'AUTOMATION_INTEGRATION_BRANCH_CREATED')!.structured_payload).toMatchObject({ adopted: true });
    }, 180_000);

    it('never adopts a branch of the same name it did not create', async () => {
      const { task, worktree } = await runToDone();
      const branch = WorktreeIntegrationService.branchName(repo.getTask(task.id)!);
      git('branch', branch); // The owner's own branch, pointing at main.
      const before = git('rev-parse', branch);
      expect(await service.getIntegration().createBranch(projectId, task.id)).toEqual({ success: false, errorCode: 'BRANCH_EXISTS' });
      expect(git('rev-parse', branch)).toBe(before);
      expect(fs.existsSync(worktree)).toBe(true);
    }, 180_000);

    it('refuses a commit whose files differ from the reviewed ones before any branch exists', async () => {
      const { task, worktree } = await runToDone();
      const branch = WorktreeIntegrationService.branchName(repo.getTask(task.id)!);
      // Expected files that do not match what is in the worktree: refused before any ref exists.
      const mismatch = await worktreesFor().commitChangesToNewBranch(tupleOf(task.id), branch, 'x', ['README.md'], () => undefined);
      expect(mismatch).toMatchObject({ status: 'FAILED' });
      expect((mismatch as { error: string }).error).toContain('COMMIT_DOES_NOT_MATCH_REVIEW');
      expect(git('branch', '--list', 'agent/*')).toBe('');
      expect(fs.readFileSync(path.join(worktree, 'NOTES.md'), 'utf8')).toBe('# Notes\n'); // The worktree is untouched.
      expect(await service.getIntegration().createBranch(projectId, task.id)).toMatchObject({ success: true });
    }, 180_000);

    it('discards through a junction without touching its target', async () => {
      const { task, worktree } = await runToDone();
      const outside = path.join(tempDir, 'precious');
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'keep.txt'), 'owner data\n', 'utf8');
      fs.symlinkSync(outside, path.join(worktree, 'linked'), 'junction');
      fs.mkdirSync(path.join(worktree, 'empty-dir'));

      expect(await service.getIntegration().discard(projectId, task.id)).toEqual({ success: true });
      expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('owner data\n');
      expect(fs.existsSync(worktree)).toBe(false);
    }, 180_000);

    it('discards the retained work of a terminal task only', async () => {
      const { task, worktree } = await runToDone();
      expect(await service.getIntegration().discard(projectId, task.id)).toEqual({ success: true });
      expect(fs.existsSync(worktree)).toBe(false);
      expect(service.getIntegration().list(projectId)[0]).toMatchObject({ state: 'DISCARDED' });
      expect(git('branch', '--list', 'agent/*')).toBe('');
      expect(await service.getIntegration().createBranch(projectId, task.id)).toEqual({ success: false, errorCode: 'ALREADY_DISCARDED' });
      expect(await service.getIntegration().discard(projectId, task.id)).toEqual({ success: false, errorCode: 'ALREADY_DISCARDED' });

      const open = tasks.createTask({ projectId, title: 'Still open', description: null, priority: 'LOW', risk: 'LOW', acceptanceCriteria: ['x'], constraints: [] });
      expect(await service.getIntegration().discard(projectId, open.id)).toEqual({ success: false, errorCode: 'TASK_NOT_TERMINAL' });
    }, 180_000);
  });
  describe('Manager plans tasks from the approved contract (#245)', () => {
    const contract = {
      goal: 'Greet visitors', architecture_constraints: [], technical_constraints: [], security_requirements: [],
      acceptance_criteria: ['A greeting is shown'], non_goals: [], definition_of_done: ['Tests pass'], testing_requirements: [], owner_policies: [],
    };
    const planningService = () => new DesktopAutomationService(repo, events, registry, {
      worktreeRoot: path.join(tempDir, 'worktrees'), timer: fakeTimer, taskService: tasks, verificationService: verification,
    });
    const addManager = () => {
      const created = new WorkspaceManagementService(repo).createAgent({
        displayName: 'Codex manager', role: 'PRIMARY_MANAGER', connection: 'CODEX_CLI', modelName: 'gpt-5-codex', workerSlots: 1,
      });
      expect(created.success).toBe(true);
      verify(created);
    };
    const planReply = (overrides: Record<string, unknown> = {}) => (request: AgentExecutionRequest): AgentExecutionResult => {
      if (request.expectedProtocol === 'manager.v1') {
        const task = repo.getTask(request.taskId)!;
        return { executionId: request.runtimeBinding!.executionId!, status: 'COMPLETED', outputProtocol: JSON.stringify({
          protocol: 'manager.v1', message_id: 'm', project_id: projectId, task_id: task.id, decision: 'EXECUTE', instructions: ['Go'],
          expected_task_state: task.state, expected_revision: task.revision_count,
        }) };
      }
      return { executionId: request.runtimeBinding!.executionId!, status: 'COMPLETED', outputProtocol: JSON.stringify({
        protocol: 'plan.v1', message_id: 'p', project_id: projectId, contract_sha256: contractSha256(repo.getProjectMetadata(projectId)!.contract!),
        tasks: [
          { title: 'Add the greeting', description: 'Show a greeting', acceptance_criteria: ['Greeting shown'], priority: 'HIGH', risk: 'LOW' },
          { title: 'Test the greeting', acceptance_criteria: ['A test covers it'] },
        ],
        ...overrides,
      }) };
    };
    const realTasks = () => repo.getTasksByProject(projectId).filter((task) => task.id !== repo.getProjectPlanningTaskId(projectId));
    const pass = async () => { await service.tick(); await service.drain(); };
    beforeEach(() => { repo.updateProjectContract(projectId, contract); });

    it('turns the approved contract into tasks and then starts the first one, without pasted JSON', async () => {
      addManager();
      repo.setProjectManagerMode(projectId, 'AUTO');
      managerReply = planReply();
      service = planningService();
      await pass();

      expect(managerRequests[0].expectedProtocol).toBe('plan.v1');
      expect(managerRequests[0].instructions.join('\n')).toContain('Greet visitors');
      const anchor = repo.getTask(repo.getProjectPlanningTaskId(projectId)!)!;
      expect(anchor).toMatchObject({ title: 'Plan the project', state: 'APPROVED' });
      expect(repo.isTaskTrashed(anchor.id)).toBe(true); // The planning record leaves the active task list.
      expect(realTasks().map((task) => [task.title, task.state])).toEqual([['Add the greeting', 'PLANNED'], ['Test the greeting', 'PLANNED']]);

      await pass();
      expect(managerRequests[1].expectedProtocol).toBe('manager.v1');
      expect(realTasks().find((task) => task.title === 'Add the greeting')!.state).toBe('CODING');
      expect(repo.getTask(anchor.id)!.state).toBe('APPROVED'); // The planning record is never dispatched.
    });

    it('tells the Manager tasks run in order on integrated code when automatic integration is on (#295)', async () => {
      addManager();
      repo.setProjectAutoIntegrate(projectId, true);
      managerReply = planReply();
      service = planningService();
      await pass();
      const instructions = managerRequests[0].instructions.join(' ');
      expect(instructions).toContain('Tasks run one at a time in the listed order');
      expect(instructions).not.toContain('Tasks run in parallel');
    });

    it('tells the Manager to plan self-contained tasks when several run at once (#306)', async () => {
      addManager();
      repo.setProjectAutoIntegrate(projectId, true);
      repo.setProjectParallelTasks(projectId, 3);
      managerReply = planReply();
      service = planningService();
      await pass();
      expect(managerRequests[0].instructions.join(' ')).toContain('Tasks run in parallel');
    });

    it('proposes the plan in approve mode and creates nothing until the owner approves', async () => {
      addManager();
      managerReply = planReply();
      service = planningService();
      await pass();

      expect(realTasks()).toEqual([]);
      const [proposal] = service.getManager()!.listProposals(projectId);
      expect(proposal).toMatchObject({ decision: 'PLAN', instructions: ['Add the greeting', 'Test the greeting'] });
      expect(proposal.plannedTasks[0]).toEqual({ title: 'Add the greeting', description: 'Show a greeting', acceptanceCriteria: ['Greeting shown'], priority: 'HIGH', risk: 'LOW', contextPaths: [] });
      expect(statusOf()).toMatchObject({ phase: 'WAITING_FOR_MANAGER', reasonCode: 'MANAGER_PROPOSAL_PENDING' });
      expect(await service.getManager()!.decideProposal(projectId, proposal.eventId, true)).toEqual({ success: true });
      expect(realTasks()).toHaveLength(2);
    });

    it('refuses an approved plan whose contract changed after it was proposed', async () => {
      addManager();
      managerReply = planReply();
      service = planningService();
      await pass();
      const [proposal] = service.getManager()!.listProposals(projectId);
      repo.updateProjectContract(projectId, { ...contract, goal: 'Greet visitors in two languages' });

      // A plan for an older contract closes; approving it creates nothing, and the new contract is planned again.
      expect(await service.getManager()!.decideProposal(projectId, proposal.eventId, true)).toMatchObject({ success: false, errorCode: 'PROPOSAL_ALREADY_DECIDED' });
      expect(realTasks()).toEqual([]);
      await pass();
      expect(managerRequests).toHaveLength(2);
    });

    it.each([
      ['a malformed plan', { tasks: [] }, 'PLAN_PROTOCOL_INVALID'],
      ['a plan for another project', { project_id: 'project-other' }, 'PLAN_FOR_OTHER_PROJECT'],
    ])('creates nothing for %s and does not retry it', async (_name, overrides, reasonCode) => {
      addManager();
      repo.setProjectManagerMode(projectId, 'AUTO');
      managerReply = planReply(overrides);
      service = planningService();
      await pass();
      await pass();

      expect(managerRequests).toHaveLength(1);
      expect(realTasks()).toEqual([]);
      expect(repo.getEventsByProject(projectId).find((e) => e.type === 'AUTOMATION_MANAGER_FAILED')!.structured_payload).toMatchObject({ reasonCode });
    });

    it('retries a plan that names the wrong contract hash while the contract is unchanged', async () => {
      addManager();
      repo.setProjectManagerMode(projectId, 'AUTO');
      let calls = 0;
      managerReply = (request) => planReply(calls++ === 0 ? { contract_sha256: 'a'.repeat(64) } : {})(request);
      service = planningService();
      await pass();
      expect(repo.getEventsByProject(projectId).find((e) => e.type === 'AUTOMATION_MANAGER_FAILED')!.structured_payload)
        .toMatchObject({ reasonCode: 'PLAN_HASH_MISMATCH', retryable: true });
      expect(realTasks()).toEqual([]);
    });

    it('plans again once the owner edits the contract after a rejected plan', async () => {
      addManager();
      managerReply = planReply();
      service = planningService();
      await pass();
      const [first] = service.getManager()!.listProposals(projectId);
      await service.getManager()!.decideProposal(projectId, first.eventId, false);
      await pass();
      expect(managerRequests).toHaveLength(1); // The rejected plan is not asked again for the same contract.

      repo.updateProjectContract(projectId, { ...contract, goal: 'Greet visitors politely' });
      await pass();
      expect(managerRequests).toHaveLength(2);
      expect(managerRequests[1].instructions.join('\n')).toContain('Greet visitors politely');
      expect(service.getManager()!.listProposals(projectId)).toHaveLength(1);
    });

    it('closes a plan proposal once the owner creates a task, and never plans then', async () => {
      addManager();
      managerReply = planReply();
      service = planningService();
      await pass();
      expect(service.getManager()!.listProposals(projectId)).toHaveLength(1);
      tasks.createTask({ projectId, title: 'Owner task', description: null, priority: 'LOW', risk: 'LOW', acceptanceCriteria: ['x'], constraints: [] });
      expect(service.getManager()!.listProposals(projectId).filter((proposal) => proposal.decision === 'PLAN')).toEqual([]);
    });

    it('refuses any Manager decision for the planning record, so it is never dispatched', async () => {
      addManager();
      managerReply = planReply();
      service = planningService();
      await pass();
      const anchorId = repo.getProjectPlanningTaskId(projectId)!;
      const pasted = { protocol: 'manager.v1' as const, message_id: `owner-${crypto.randomUUID()}`, project_id: projectId, task_id: anchorId,
        decision: 'EXECUTE' as const, priority: 'LOW' as const, risk: 'LOW' as const, instructions: [], acceptance_criteria: [], constraints: [],
        review_issues: [], expected_task_state: 'PLANNED' as const, expected_revision: 0 };
      expect((await tasks.applyManagerDecision(pasted, JSON.stringify(pasted))).success).toBe(false);
      expect(repo.getTask(anchorId)!.state).toBe('PLANNED');
    });

    it('stores validated context paths per planned task, and retries a plan naming a bad path (#254)', async () => {
      addManager();
      repo.setProjectManagerMode(projectId, 'AUTO');
      let calls = 0;
      managerReply = (request) => planReply({ tasks: [{ title: 'Edit the readme', acceptance_criteria: ['done'],
        context_paths: [calls++ === 0 ? '../outside' : 'README.md'] }] })(request);
      service = planningService();
      await pass();
      expect(repo.getEventsByProject(projectId).find((e) => e.type === 'AUTOMATION_MANAGER_FAILED')!.structured_payload)
        .toMatchObject({ reasonCode: 'PLAN_CONTEXT_PATH_INVALID', retryable: true, path: '../outside' });
      expect(realTasks()).toEqual([]);
    });

    it('applies a plan that names a directory the coder will create, keeping it as a new path (#285, #287)', async () => {
      addManager();
      repo.setProjectManagerMode(projectId, 'AUTO');
      managerReply = planReply({ tasks: [{ title: 'Add the stats command', acceptance_criteria: ['done'], context_paths: ['bin', 'bin/stats.js', 'README.md'] }] });
      service = planningService();
      await pass();
      expect(repo.getEventsByProject(projectId).some((e) => e.type === 'AUTOMATION_MANAGER_FAILED')).toBe(false);
      const [task] = realTasks();
      expect(task).toBeDefined();
      expect(repo.getTaskContextPaths(projectId, task.id)).toEqual(['bin', 'bin/stats.js', 'README.md']);
    });

    it('does not plan a project that already has tasks', async () => {
      addManager();
      tasks.createTask({ projectId, title: 'Owner task', description: null, priority: 'LOW', risk: 'LOW', acceptanceCriteria: ['x'], constraints: [] });
      managerReply = planReply();
      service = planningService();
      await pass();
      expect(repo.getProjectPlanningTaskId(projectId)).toBeNull();
      expect(managerRequests.every((request) => request.expectedProtocol !== 'plan.v1')).toBe(true);
    });
  });
  describe.runIf(process.platform === 'win32')('task-scoped coder context (#254)', () => {
    it('authorizes exactly the task context paths instead of the top-level entries', async () => {
      verify(addCodexCoder());
      fs.mkdirSync(path.join(repoDir, 'src'));
      fs.writeFileSync(path.join(repoDir, 'src', 'app.ts'), 'export {};\n', 'utf8');
      git('add', '.');
      git('commit', '-m', 'add src');
      const task = await approvedTask();
      repo.setTaskContextPaths(projectId, task.id, ['src']);
      await service.tick();
      await service.drain();

      const auth = repo.getExecutionAuthorizationsByTask(task.id)[0];
      expect(JSON.parse(auth.canonical_payload_json!).contextFiles).toEqual(['src']);
      expect(adapterCalls).toBe(1);
    }, 90_000);

    it('keeps a stored path that does not exist as a new path, adding the top-level entries when nothing else exists (#287)', async () => {
      verify(addCodexCoder());
      const task = await approvedTask();
      repo.setTaskContextPaths(projectId, task.id, ['gone']);
      await service.tick();
      await service.drain();

      expect(adapterCalls).toBe(1);
      const contextFiles = JSON.parse(repo.getExecutionAuthorizationsByTask(task.id)[0].canonical_payload_json!).contextFiles as string[];
      expect(contextFiles).toContain('gone');
      expect(contextFiles).toContain('README.md');
      expect(repo.getEventsByProject(projectId).some((e) => e.type === 'AUTOMATION_EXECUTION_FAILED')).toBe(false);
    }, 90_000);

    it('still stops when a stored context path became a denied one', async () => {
      verify(addCodexCoder());
      const task = await approvedTask();
      fs.writeFileSync(path.join(repoDir, '.env'), 'SECRET=1', 'utf8');
      repo.setTaskContextPaths(projectId, task.id, ['.env']);
      await service.tick();
      await service.drain();

      expect(adapterCalls).toBe(0);
      expect(repo.getEventsByProject(projectId).find((e) => e.type === 'AUTOMATION_EXECUTION_FAILED')!.structured_payload)
        .toMatchObject({ reasonCode: 'TASK_CONTEXT_INVALID' });
    }, 90_000);
  });
});
