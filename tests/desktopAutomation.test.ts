import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    verification = new VerificationService(repo, artifacts);
    tasks = new TaskService(repo, events, verification, artifacts);
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
      expect(statusOf()).toMatchObject({ phase: 'AWAITING_REVIEW', taskId: task.id, reasonCode: 'VERIFIED' });
      // No second verification or dispatch for the same settled run.
      await service.tick();
      await service.drain();
      expect(adapterCalls).toBe(1);
      expect(repo.getEventsByProject(projectId).filter((e) => e.type === 'AUTOMATION_VERIFICATION_PASSED')).toHaveLength(1);
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
});
