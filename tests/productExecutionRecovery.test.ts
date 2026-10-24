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
import { RoleAwareRoutingService } from '../src/core/services/RoleAwareRoutingService';
import { ContextBuilderService } from '../src/core/services/ContextBuilderService';
import { ExecutionAuthorizationService } from '../src/core/services/ExecutionAuthorizationService';
import { WorkerSlotLeaseService } from '../src/core/services/WorkerSlotLeaseService';
import { ExecutionRecoveryScanner } from '../src/core/services/ExecutionRecoveryScanner';
import { ProviderRegistry } from '../src/core/adapters/ProviderRegistry';
import { captureRepositoryRoot } from '../src/core/services/RepositoryRootIdentity';
import type { ProviderAdapter } from '../src/core/adapters/ProviderAdapter';
import { performSafeCleanup } from './helpers/r5l1SyntheticFixture';

/**
 * Restart recovery for lifecycle-v1 product (non-handoff) executions (#231).
 * Durable states are produced by the real services; a crash is simulated by
 * leaving the state where an interrupted process would have left it and then
 * running the startup scanner.
 */
describe('product execution recovery', () => {
  let tempDir: string;
  let repoDir: string;
  let db: Database.Database;
  let repo: Repository;
  let events: EventService;
  let tasks: TaskService;
  let registry: ProviderRegistry;
  let projectId: string;
  let processMode: 'NONE' | 'COMPLETED' | 'RUNNING';
  let adapterCalls: number;

  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
  const fakeTimer = { setInterval: () => 'h', clearInterval: () => undefined };

  beforeEach(() => {
    tempDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-product-recovery-')));
    repoDir = path.join(tempDir, 'repo');
    fs.mkdirSync(repoDir);
    git('init', '-b', 'main');
    git('config', 'user.name', 'Recovery Fixture');
    git('config', 'user.email', 'fixture@agentforge.local');
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Fixture\n', 'utf8');
    git('add', '.');
    git('commit', '-m', 'baseline');

    db = new Database(path.join(tempDir, 'recovery.db'));
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    events = new EventService(repo);
    const artifacts = new ArtifactStore(path.join(tempDir, 'artifacts'));
    tasks = new TaskService(repo, events, new VerificationService(repo, artifacts), artifacts);
    processMode = 'NONE';
    adapterCalls = 0;
    registry = new ProviderRegistry();
    const adapter: ProviderAdapter = {
      id: 'prov-codex-cli', name: 'Synthetic', adapterType: 'LOCAL_CLI',
      async getCapabilities() { return ['CODING']; },
      async getHealth() { return 'AVAILABLE'; },
      async getQuota() { return { remaining: null, total: null, unit: 'REQUESTS', source: 'UNKNOWN', confidence: 0, resetAt: null }; },
      async execute(request) {
        adapterCalls += 1;
        const executionId = request.runtimeBinding!.executionId!;
        if (processMode !== 'NONE') {
          repo.createProcessRun({ id: executionId, pid: null, command: 'codex exec', working_directory: tempDir,
            status: 'RUNNING', start_time: new Date().toISOString() });
          if (processMode === 'COMPLETED') repo.updateProcessRun(executionId, 'COMPLETED', 0, new Date().toISOString());
        }
        return { executionId, status: 'COMPLETED', outputProtocol: 'coder.v1', rawResponse: 'ok' };
      },
      async cancel() {},
    };
    registry.register(adapter);

    const now = new Date().toISOString();
    projectId = `project-${crypto.randomUUID()}`;
    repo.createProject({
      id: projectId, name: 'Recovery project', description: null, repository_path: repoDir, default_branch: 'main',
      status: 'RUNNING', contract: null, created_at: now, updated_at: now, started_at: now, completed_at: null,
    }, captureRepositoryRoot(repoDir));
    const created = new WorkspaceManagementService(repo).createAgent({
      displayName: 'Codex coder', role: 'CODER', connection: 'CODEX_CLI', modelName: 'gpt-5-codex', workerSlots: 1,
    });
    if (!created.success) throw new Error(created.error);
    const resource = repo.getProviderResource(created.agent.provider_resource_id!)!;
    db.prepare("UPDATE provider_accounts SET health_status = 'AVAILABLE' WHERE id = ?").run(resource.provider_account_id);
  });

  afterEach(async () => {
    await performSafeCleanup({ dbs: [db], tempDirs: [tempDir] });
  });

  const approvedTask = async () => {
    const task = tasks.createTask({ projectId, title: 'Recover me', description: null, priority: 'LOW', risk: 'LOW', acceptanceCriteria: [], constraints: [] });
    const manager = {
      protocol: 'manager.v1' as const, message_id: `m-${crypto.randomUUID()}`, project_id: projectId, task_id: task.id,
      decision: 'EXECUTE' as const, priority: 'LOW' as const, risk: 'LOW' as const, instructions: ['Edit README.md'],
      acceptance_criteria: [], constraints: [], review_issues: [], expected_task_state: 'PLANNED' as const, expected_revision: 0,
    };
    expect((await tasks.applyManagerDecision(manager, JSON.stringify(manager))).success).toBe(true);
    return repo.getTask(task.id)!;
  };

  /** The automation chain up to an AUTHORIZED product authorization (what a crash before dispatch leaves). */
  const authorize = async () => {
    const task = await approvedTask();
    const agent = repo.getAllAgents().find((a) => a.role === 'CODER')!;
    const profile = repo.getAgentProfile(agent.agent_profile_id!)!;
    const resource = repo.getProviderResource(agent.provider_resource_id!)!;
    const attemptId = `attempt-${crypto.randomUUID()}`;
    repo.createTaskAttempt({ id: attemptId, task_id: task.id, attempt_number: 1, agent_id: agent.id, agent_profile_id: profile.id,
      status: 'RUNNING', started_at: new Date().toISOString(), ended_at: null, summary: null });
    const routing = await new RoleAwareRoutingService(repo, registry, events).routeRole({
      projectId, taskId: task.id, attemptId, roleProfileId: profile.role_profile_id, agentProfileId: profile.id,
      candidateRefs: [{ accountId: resource.provider_account_id!, resourceId: resource.id }], persistAssignment: true, allowManualBridge: false,
    });
    const context = new ContextBuilderService(repo).buildContextSnapshot({
      projectId, taskId: task.id, attemptId, assignmentId: routing.selectedAssignmentId!, contextFiles: ['README.md'], purpose: 'EXECUTION',
      includeProjectMemory: false, includeTaskMemory: false, includeLatestCheckpoint: false, includeLatestHandoff: false,
    });
    const auth = await new ExecutionAuthorizationService(repo, events).createAuthorization({
      projectId, taskId: task.id, attemptId, routingDecisionId: routing.decisionId, assignmentId: routing.selectedAssignmentId!,
      taskOwnershipEpoch: task.ownership_epoch ?? 1, contextManifestId: context.manifest.id, contextFiles: ['README.md'],
      executionMode: 'PRODUCT_BOUND',
      executionScope: { branch: 'agent/x', worktree: path.join(tempDir, 'wt'), allowedPaths: ['README.md'], forbiddenPaths: ['.git'] },
    });
    return { task, auth, attemptId, assignmentId: routing.selectedAssignmentId! };
  };

  const scan = (authId: string) => new ExecutionRecoveryScanner(db, repo).reconcileAuthorization(authId);

  it('leaves an owner-created AUTHORIZED authorization untouched at startup', async () => {
    const { auth, attemptId } = await authorize();
    expect(scan(auth.id)).toMatchObject({ classification: 'ALREADY_RECONCILED', disposition: 'NO_OP_ALREADY_RECONCILED', mutatedResources: false });
    expect(repo.getExecutionAuthorization(auth.id)!.status).toBe('AUTHORIZED');
    // Not created by automation, so automation's restart cleanup ignores it too.
    expect(new DesktopAutomationService(repo, events, registry, { worktreeRoot: tempDir, timer: fakeTimer }).releaseAbandonedAuthorizations()).toBe(0);
    expect(repo.getTaskAttempt(attemptId)!.status).toBe('RUNNING');
  });

  it('lets desktop automation release its own abandoned AUTHORIZED work on start', async () => {
    const { auth, attemptId, assignmentId } = await authorize();
    db.prepare("UPDATE task_attempts SET summary = 'desktop-automation' WHERE id = ?").run(attemptId);
    const service = new DesktopAutomationService(repo, events, registry, { worktreeRoot: tempDir, timer: fakeTimer });
    service.start();
    service.stop();
    expect(repo.getExecutionAuthorization(auth.id)!.status).toBe('INVALIDATED');
    expect(repo.getTaskAttempt(attemptId)!.status).toBe('FAILED');
    expect(repo.getAgentAssignment(assignmentId)!.status).toBe('FAILED');
    expect(service.releaseAbandonedAuthorizations()).toBe(0);
  });

  it('expires a DISPATCHED execution whose adapter never started and releases its lease and slot', async () => {
    const { auth, assignmentId } = await authorize();
    const acquired = new WorkerSlotLeaseService(repo).acquireForAssignment(assignmentId, 60_000);
    expect(acquired.status).toBe('ACQUIRED');
    expect(repo.claimExecutionAuthorization(auth.id, new Date().toISOString())).toBe(true);

    expect(scan(auth.id)).toMatchObject({ classification: 'PRE_ADAPTER_NOT_STARTED', mutatedResources: true });
    expect(repo.getExecutionAuthorization(auth.id)!.status).toBe('INVALIDATED');
    expect(repo.getActiveLeaseForAssignment(assignmentId)).toBeNull();
    const slotId = acquired.status === 'ACQUIRED' ? acquired.slot.id : '';
    expect(repo.getWorkerSlot(slotId)!.status).toBe('IDLE');
    expect(repo.getAgentAssignment(assignmentId)!.status).toBe('FAILED');
  });

  it('keeps a started, unsettled execution fenced and never treats a finished process as success', async () => {
    const { auth, assignmentId } = await authorize();
    new WorkerSlotLeaseService(repo).acquireForAssignment(assignmentId, 60_000);
    repo.claimExecutionAuthorization(auth.id, new Date().toISOString());
    const executionId = crypto.randomUUID();
    expect(repo.claimAdapterExecutionStart({ authorizationId: auth.id, executionId, expectedEpoch: auth.task_ownership_epoch!, expectedLifecycleVersion: 1 }).success).toBe(true);

    expect(scan(auth.id)).toMatchObject({ classification: 'ADAPTER_IN_FLIGHT_UNRESOLVED', disposition: 'UNRESOLVED_FENCED', mutatedResources: false });
    repo.createProcessRun({ id: executionId, pid: null, command: 'codex exec', working_directory: tempDir, status: 'RUNNING', start_time: new Date().toISOString() });
    repo.updateProcessRun(executionId, 'COMPLETED', 0, new Date().toISOString());
    expect(scan(auth.id)).toMatchObject({ classification: 'ADAPTER_FINISHED_RESULT_MISSING', disposition: 'RESULT_MISSING_FENCED', mutatedResources: false });
    expect(repo.getExecutionAuthorization(auth.id)!.settled_at).toBeNull();
    expect(repo.getActiveLeaseForAssignment(assignmentId)).not.toBeNull();
  });

  describe.runIf(process.platform === 'win32')('with the real scheduler', () => {
    const run = async () => {
      const task = await approvedTask();
      const service = new DesktopAutomationService(repo, events, registry, { worktreeRoot: path.join(tempDir, 'worktrees'), timer: fakeTimer });
      await service.tick();
      await service.drain();
      return { task, auth: repo.getExecutionAuthorizationsByTask(task.id)[0] };
    };

    it('records the terminal process run in settlement evidence', async () => {
      processMode = 'COMPLETED';
      const { auth } = await run();
      expect(auth.settlement_status).toBe('COMPLETED');
      expect(JSON.parse(auth.settlement_evidence_json!).process_run).toEqual({ status: 'COMPLETED', exit_code: 0 });
    }, 60_000);

    it('refuses to settle while the native process is still RUNNING', async () => {
      processMode = 'RUNNING';
      const { auth } = await run();
      expect(adapterCalls).toBe(1);
      expect(auth.settled_at).toBeNull();
      expect(auth.status).toBe('DISPATCHED');
    }, 60_000);

    it('rejects tampered settlement evidence and releases nothing', async () => {
      const { auth } = await run();
      const lease = repo.getAccountLeasesByAssignment(auth.assignment_id!)[0];
      db.prepare('UPDATE account_leases SET released_at = NULL WHERE id = ?').run(lease.id);
      const forged = auth.settlement_evidence_json!.replace('"settlement_status":"COMPLETED"', '"settlement_status":"COMPLETED","forged":true');
      db.prepare('UPDATE execution_authorizations SET settlement_evidence_json = ? WHERE id = ?').run(forged, auth.id);
      expect(scan(auth.id)).toMatchObject({ classification: 'AUTHORITY_CONFLICT', disposition: 'REJECTED_INTEGRITY_CONFLICT', mutatedResources: false });
      expect(repo.getActiveLeaseForAssignment(auth.assignment_id!)).not.toBeNull();
    }, 60_000);

    it('releases the lease and slot of a settled execution interrupted before release', async () => {
      const { auth } = await run();
      expect(auth.settlement_status).toBe('COMPLETED');
      const lease = repo.getAccountLeasesByAssignment(auth.assignment_id!)[0];
      // Simulate a crash between settlement and the scheduler's lease release.
      db.prepare('UPDATE account_leases SET released_at = NULL WHERE id = ?').run(lease.id);
      db.prepare("UPDATE worker_slots SET status = 'LEASED', current_assignment_id = ?, current_execution_id = ? WHERE id = ?")
        .run(auth.assignment_id, auth.execution_id, lease.worker_slot_id);

      expect(scan(auth.id)).toMatchObject({ classification: 'RESULT_PERSISTED_STATE_INCOMPLETE', disposition: 'TERMINAL_STATE_RECONCILED', mutatedResources: true });
      expect(repo.getActiveLeaseForAssignment(auth.assignment_id!)).toBeNull();
      expect(repo.getWorkerSlot(lease.worker_slot_id)!.status).toBe('IDLE');
      expect(repo.getExecutionAuthorization(auth.id)!.settlement_status).toBe('COMPLETED');
      expect(scan(auth.id)).toMatchObject({ classification: 'ALREADY_RECONCILED', mutatedResources: false });
    }, 60_000);
  });
});
