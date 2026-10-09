import { captureRepositoryRoot } from '../src/core/services/RepositoryRootIdentity';
import { execFileSync as initializeFixtureGit } from 'node:child_process';
import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { EventService } from '../src/core/services/EventService';
import { TaskService } from '../src/core/services/TaskService';
import { VerificationService } from '../src/core/services/VerificationService';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import { ContextBuilderService } from '../src/core/services/ContextBuilderService';
import { RoleAwareRoutingService } from '../src/core/services/RoleAwareRoutingService';
import { ExecutionAuthorizationService } from '../src/core/services/ExecutionAuthorizationService';
import { WorkerSlotLeaseService } from '../src/core/services/WorkerSlotLeaseService';
import { GitWorktreeService } from '../src/core/services/GitWorktreeService';
import { ProviderDispatchService } from '../src/core/services/ProviderDispatchService';
import { ConcurrentExecutionScheduler } from '../src/core/services/ConcurrentExecutionScheduler';
import { ProviderRegistry } from '../src/core/adapters/ProviderRegistry';
import type { ProviderAdapter } from '../src/core/adapters/ProviderAdapter';
import { performSafeCleanup } from './helpers/r5l1SyntheticFixture';

/**
 * This is an executable characterization of the current R5L1 boundary.
 *
 * The setup intentionally seeds only provider configuration. The task,
 * Manager authority, route, ContextManifest, authorization, lease and
 * worktree are all produced by their real services. The current dispatch
 * implementation still routes assignment-bound authorizations through the
 * handoff-authority fence before reaching its context-hash check. The
 * assignment-bound authorization therefore rejects at that first durable
 * boundary; the durable manifest hash divergence is asserted explicitly so
 * the later hash blocker cannot be mistaken for a successful dispatch.
 * Keeping both boundaries explicit prevents a passing report from claiming
 * coder, submission, adjudication or reviewer stages that were never
 * exercised.
 */
it('exercises real lifecycle setup and records the truthful context-hash dispatch boundary', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-r5l1-boundary-'));
  let db: Database.Database | undefined;
  try {
    const repoDir = path.join(tempDir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
    git('init', '-b', 'main');
    git('config', 'user.name', 'Synthetic Rehearsal');
    git('config', 'user.email', 'synthetic@agentforge.local');
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'Synthetic lifecycle context\n', 'utf8');
    git('add', '.');
    git('commit', '-m', 'Synthetic lifecycle baseline');
    const baseSha = git('rev-parse', 'HEAD').toLowerCase();

    db = new Database(path.join(tempDir, 'rehearsal.db'));
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    const repo = new Repository(db);
    const events = new EventService(repo);
    const artifactStore = new ArtifactStore(path.join(tempDir, 'artifacts'));
    const verificationService = new VerificationService(repo, artifactStore);
    const tasks = new TaskService(repo, events, verificationService, artifactStore);

    const now = new Date().toISOString();
    const projectId = `project-${crypto.randomUUID()}`;
    const providerId = `provider-${crypto.randomUUID()}`;
    const accountId = `account-${crypto.randomUUID()}`;
    const resourceId = `resource-${crypto.randomUUID()}`;
    const roleId = `role-${crypto.randomUUID()}`;
    const workerSlotId = `slot-${crypto.randomUUID()}`;

    if (!fs.existsSync(path.join(repoDir, '.git'))) initializeFixtureGit('git', ['init', '-q', '--template=', '--initial-branch=main'], { cwd: repoDir, stdio: 'ignore', windowsHide: true });
    repo.createProject({
      id: projectId,
      name: 'Synthetic lifecycle project',
      description: 'R5L1 boundary characterization',
      repository_path: repoDir,
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: now,
      updated_at: now,
      started_at: now,
      completed_at: null,
    }, captureRepositoryRoot(repoDir));
    repo.createProvider({
      id: providerId,
      name: 'Synthetic provider',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: now,
    });
    repo.createProviderAccount({
      id: accountId,
      provider_id: providerId,
      label: 'Synthetic account',
      auth_mode: 'NATIVE_PROFILE',
      credential_ref: null,
      profile_ref: 'native-profile://synthetic/rehearsal',
      enabled: true,
      priority: 100,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: now,
      updated_at: now,
    });
    repo.createProviderResource({
      id: resourceId,
      provider_id: providerId,
      provider_account_id: accountId,
      model_name: 'synthetic-model',
      health_status: 'AVAILABLE',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: 100,
      remaining_quota: 100,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1,
      last_health_check: now,
    });
    repo.createRoleProfile({
      id: roleId,
      role: 'CODER',
      display_name: 'Synthetic coder',
      required_capabilities: ['CODING'],
      preferred_capabilities: [],
      authority_scope: null,
      permissions: ['FILESYSTEM_EDIT'],
      output_protocol: 'coder.v1',
      enabled: true,
      created_at: now,
      updated_at: now,
    });
    repo.createWorkerSlot({
      id: workerSlotId,
      provider_account_id: accountId,
      provider_resource_id: resourceId,
      slot_index: 0,
      status: 'IDLE',
      current_assignment_id: null,
      current_execution_id: null,
      heartbeat_at: null,
      created_at: now,
      updated_at: now,
    });

    let adapterCalls = 0;
    let adapterRequest: Parameters<ProviderAdapter['execute']>[0] | undefined;
    const registry = new ProviderRegistry();
    const adapter: ProviderAdapter = {
      id: providerId,
      name: 'Synthetic lifecycle sentinel',
      adapterType: 'LOCAL_CLI',
      async getCapabilities() {
        return ['CODING'];
      },
      async getHealth() {
        return 'AVAILABLE';
      },
      async getQuota() {
        return {
          remaining: 100,
          total: 100,
          unit: 'REQUESTS',
          source: 'MANUAL',
          confidence: 1,
          resetAt: null,
        };
      },
      async execute(request) {
        adapterCalls += 1;
        adapterRequest = request;
        return {
          executionId: request.runtimeBinding?.executionId ?? 'synthetic-execution',
          status: 'COMPLETED',
          outputProtocol: 'coder.v1',
          rawResponse: 'Synthetic provider execution',
        };
      },
      async cancel() {},
    };
    registry.register(adapter);

    // 1. Real task creation: PLANNED -> Manager EXECUTE -> CODING.
    const task = tasks.createTask({
      projectId,
      title: 'Synthetic lifecycle task',
      description: 'Exercise the real R5L1 service boundary',
      priority: 'LOW',
      risk: 'LOW',
      acceptanceCriteria: ['Dispatch rejection is truthful and downstream stages are unexercised'],
      constraints: ['Synthetic-only; no external credentials'],
    });
    expect(task.state).toBe('PLANNED');
    const manager = {
      protocol: 'manager.v1' as const,
      message_id: `manager-${crypto.randomUUID()}`,
      project_id: projectId,
      task_id: task.id,
      decision: 'EXECUTE' as const,
      priority: 'LOW' as const,
      risk: 'LOW' as const,
      instructions: ['Execute only the synthetic lifecycle boundary test.'],
      acceptance_criteria: task.acceptance_criteria,
      constraints: task.constraints,
      review_issues: [],
      expected_task_state: 'PLANNED' as const,
      expected_revision: 0,
    };
    const rawManagerPayload = JSON.stringify(manager);
    const managerResult = await tasks.applyManagerDecision(manager, rawManagerPayload);
    expect(managerResult.success).toBe(true);
    expect(repo.getTask(task.id)?.state).toBe('CODING');
    expect(repo.getTask(task.id)?.base_sha).toBe(baseSha);

    // 2. Real routing creates the assignment and durable routing event.
    const routing = await new RoleAwareRoutingService(repo, registry, events).routeRole({
      projectId,
      taskId: task.id,
      roleProfileId: roleId,
      candidateRefs: [{ accountId, resourceId }],
      persistAssignment: true,
      allowManualBridge: false,
    });
    expect(routing.outcome).toBe('SELECTED');
    expect(routing.selectedAssignmentId).toBeTruthy();
    const assignmentId = routing.selectedAssignmentId!;
    const assignment = repo.getAgentAssignment(assignmentId);
    expect(assignment?.selected_account_id).toBe(accountId);
    expect(assignment?.selected_resource_id).toBe(resourceId);
    expect(assignment?.routing_decision_id).toBe(routing.decisionId);

    // 3. Real ContextBuilder creates an assignment-bound durable manifest.
    const context = new ContextBuilderService(repo).buildContextSnapshot({
      projectId,
      taskId: task.id,
      assignmentId,
      contextFiles: ['README.md'],
      purpose: 'EXECUTION',
      includeProjectMemory: false,
      includeTaskMemory: false,
      includeLatestCheckpoint: false,
      includeLatestHandoff: false,
    });
    expect(context.snapshot.assignment_id).toBe(assignmentId);
    expect(context.manifest.manifest_hash).toMatch(/^[0-9a-f]{64}$/);

    // 4. Real authorization persists assignment/account and the durable
    // manifest hash. This proves the old missing-binding blocker is closed.
    const auth = await new ExecutionAuthorizationService(repo, events).createAuthorization({
      projectId,
      taskId: task.id,
      routingDecisionId: routing.decisionId,
      assignmentId,
      taskOwnershipEpoch: repo.getTask(task.id)!.ownership_epoch!,
      contextManifestId: context.manifest.id,
      contextFiles: ['README.md'],
      executionScope: {
        branch: `agent/synthetic/${task.id}`,
        worktree: path.join(tempDir, 'worktrees', task.id),
        allowedPaths: ['src'],
        forbiddenPaths: ['.git'],
      },
    });
    expect(auth.status).toBe('AUTHORIZED');
    expect(auth.lifecycle_version).toBe(1);
    expect(auth.assignment_id).toBe(assignmentId);
    expect(auth.selected_account_id).toBe(accountId);
    expect(auth.context_manifest_hash).toBe(context.manifest.manifest_hash);
    const durableAuth = repo.getExecutionAuthorization(auth.id)!;
    expect(durableAuth.assignment_id).toBe(assignmentId);
    expect(durableAuth.selected_account_id).toBe(accountId);

    // 5. Real scheduler acquires a lease, creates/inspects a worktree, and
    // reaches ProviderDispatchService. The current assignment-bound
    // authorization is rejected by the handoff-authority fence before adapter
    // invocation; no coder, submission, adjudication, or reviewer result is
    // synthesized after that boundary.
    const gitExecutable = execFileSync(
      process.platform === 'win32' ? 'where.exe' : 'which',
      ['git'],
      { encoding: 'utf8' },
    )
      .trim()
      .split(/\r?\n/)[0];
    if (process.platform !== 'win32') {
      // The portable fixture supplies an existing root. Production rejects
      // missing-root initialization before mutation on unsupported platforms.
      fs.mkdirSync(path.join(tempDir, 'worktrees'));
    }
    const worktrees = new GitWorktreeService({
      gitExecutable,
      repositoryRoot: repoDir,
      managedRoot: path.join(tempDir, 'worktrees'),
    });
    const dispatch = new ProviderDispatchService(registry, repo, events, worktrees);
    const scheduler = new ConcurrentExecutionScheduler(
      repo,
      new WorkerSlotLeaseService(repo),
      worktrees,
      dispatch,
    );
    const result = await scheduler.execute(auth.id);

    if (process.platform === 'win32') {
      expect(result.status).toBe('PROVIDER_FAILED');
      expect(result.providerResult?.error).toContain('EXECUTION_AUTHORIZATION_INVALID:');
      expect(result.providerResult?.error).toContain('No HandoffTransfer found');
      expect(result.providerResult?.errorCode).toBe('RESOURCE_UNAVAILABLE');
      expect(repo.getExecutionAuthorization(auth.id)?.status).toBe('INVALIDATED');
      expect(result.workspaceOwnershipDigest).toMatch(/^[0-9a-f]{64}$/);
    } else {
      expect(result.status).toBe('WORKTREE_CREATE_FAILED');
      expect(result.errorCode).toBe('UNSUPPORTED_MUTATION_BOUNDARY');
      expect(result.providerResult).toBeUndefined();
      expect(result.workspaceOwnershipDigest).toBeUndefined();
      expect(repo.getExecutionAuthorization(auth.id)).toEqual(durableAuth);
      expect(fs.readdirSync(path.join(tempDir, 'worktrees'))).toEqual([]);
      expect(repo.getProcessRunsByTask(task.id)).toEqual([]);
    }
    expect(auth.context_manifest_hash).not.toBe(
      crypto.createHash('sha256').update(JSON.stringify(['README.md'])).digest('hex'),
    );
    expect(adapterCalls).toBe(0);
    expect(adapterRequest).toBeUndefined();
    expect(result.assignmentId).toBe(assignmentId);
    expect(result.workerSlotId).toBe(workerSlotId);
    expect(result.leaseId).toBeTruthy();
    expect(repo.getAccountLease(result.leaseId!)?.released_at).toBeTruthy();
    expect(repo.getWorkerSlot(workerSlotId)?.status).toBe('IDLE');
    expect(await worktrees.listPorcelain()).toHaveLength(1);

    console.log(
      'R5L1_BOUNDARY',
      JSON.stringify({
        source: 'SERVICE_EXECUTED',
        taskState: repo.getTask(task.id)?.state,
        baseSha,
        repositoryHeadSha: auth.repository_head_sha,
        routingDecisionId: routing.decisionId,
        assignmentId,
        authorizationId: auth.id,
        durableManifestHash: context.manifest.manifest_hash,
        persistedAssignmentBinding: durableAuth.assignment_id === assignmentId,
        persistedAccountBinding: durableAuth.selected_account_id === accountId,
        schedulerStatus: result.status,
        errorCode: result.errorCode ?? result.providerResult?.errorCode,
        adapterCalls,
        downstream: process.platform === 'win32'
          ? 'NOT_EXERCISED: dispatch rejected before coder execution'
          : 'NOT_EXERCISED: native worktree boundary unavailable',
        coderWorktreeHeadBinding: 'NOT_EXERCISED: no coder output was produced',
        conditionalHandoff: 'NOT_EXERCISED',
      }),
    );
  } finally {
    await performSafeCleanup({ dbs: [db], tempDirs: [tempDir] });
  }
  expect(db?.open).toBe(false);
  expect(fs.existsSync(tempDir)).toBe(false);
}, 60000);
