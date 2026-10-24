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
  let managerReply: (request: AgentExecutionRequest) => AgentExecutionResult | Promise<AgentExecutionResult>;
  let reviewReply: (request: AgentExecutionRequest) => AgentExecutionResult | Promise<AgentExecutionResult>;
  let projectId: string;
  let service: DesktopAutomationService;

  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
  const fakeTimer = { setInterval: () => 'handle', clearInterval: () => undefined };

  let healthy: boolean;
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
      if (request.expectedProtocol === 'manager.v1') {
        managerRequests.push(request);
        return managerReply(request);
      }
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
    healthy = true;
    reviewRequests = [];
    reviewReply = () => { throw new Error('no review expected'); };
    managerRequests = [];
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
      expect(statusOf()).toMatchObject({ phase: 'AWAITING_REVIEW', taskId: task.id, reasonCode: 'NO_REVIEWER' });
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
  describe.runIf(process.platform === 'win32')('account-bound automated review of verified work (#233)', () => {
    const configureTest = async () => {
      fs.writeFileSync(path.join(repoDir, 'verify.js'), 'process.exit(0);\n', 'utf8');
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

    it('records a BLOCKED verdict and leaves the task REVIEWING for the Manager or owner', async () => {
      reviewReply = verdict('BLOCKED');
      const { task } = await runToReview();

      expect(repo.getTask(task.id)!.state).toBe('REVIEWING');
      expect(repo.getReviewsByTask(task.id)[0].verdict).toBe('BLOCKED');
      expect(statusOf()).toMatchObject({ phase: 'AWAITING_REVIEW', taskId: task.id, reasonCode: 'REVIEW_BLOCKED' });
    }, 120_000);

    it('escalates FIX_REQUIRED at the revision limit to NEEDS_HUMAN', async () => {
      reviewReply = verdict('FIX_REQUIRED');
      const { task } = await runToReview((taskId) => { db.prepare('UPDATE tasks SET max_revisions = 1 WHERE id = ?').run(taskId); });

      expect(repo.getTask(task.id)!.state).toBe('NEEDS_HUMAN');
      expect(repo.getReviewsByTask(task.id)[0].verdict).toBe('FIX_REQUIRED');
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
});
