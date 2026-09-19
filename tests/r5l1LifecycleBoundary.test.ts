import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { EventService } from '../src/core/services/EventService';
import { TaskService } from '../src/core/services/TaskService';
import { ContextBuilderService } from '../src/core/services/ContextBuilderService';
import { ExecutionAuthorizationService, computeContextManifestHash } from '../src/core/services/ExecutionAuthorizationService';
import { RoleAwareRoutingService } from '../src/core/services/RoleAwareRoutingService';
import { WorkerSlotLeaseService } from '../src/core/services/WorkerSlotLeaseService';
import { GitWorktreeService } from '../src/core/services/GitWorktreeService';
import { ProviderDispatchService } from '../src/core/services/ProviderDispatchService';
import { ConcurrentExecutionScheduler } from '../src/core/services/ConcurrentExecutionScheduler';
import { ProviderRegistry } from '../src/core/adapters/ProviderRegistry';
import { NativeProfileResolver } from '../src/core/credentials/NativeProfileResolver';
import { performSafeCleanup } from './helpers/r5l1SyntheticFixture';
import type { ProviderAdapter } from '../src/core/adapters/ProviderAdapter';

// Characterizes a BLOCKED integration boundary, not a successful R5L1 rehearsal.
// Only input configuration is seeded. Task, manager authority, context, routing,
// assignment, authorization, lease and worktree all come from production services.
it('documents durable-context dispatch rejection and missing initial assignment binding', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-r5l1-boundary-'));
  let db: Database.Database | undefined;
  try {
    const repoDir = path.join(tempDir, 'repo');
    fs.mkdirSync(repoDir);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
    git('init', '-b', 'main');
    git('config', 'user.name', 'Synthetic Rehearsal');
    git('config', 'user.email', 'synthetic@agentforge.local');
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'Synthetic context\n');
    git('add', '.');
    git('commit', '-m', 'Synthetic baseline');
    const baseSha = git('rev-parse', 'HEAD');
    db = new Database(path.join(tempDir, 'rehearsal.db'));
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    const repo = new Repository(db);
    const events = new EventService(repo);
    const now = new Date().toISOString();
    repo.createProject({ id: 'project', name: 'Synthetic', description: null,
      repository_path: repoDir, default_branch: 'main', status: 'RUNNING', contract: null,
      created_at: now, updated_at: now, started_at: null, completed_at: null });
    repo.createProvider({ id: 'synthetic', name: 'Local synthetic', adapter_type: 'LOCAL_CLI', enabled: true, created_at: now });
    repo.createProviderAccount({ id: 'account', provider_id: 'synthetic', label: 'Synthetic',
      auth_mode: 'NATIVE_PROFILE', credential_ref: null, profile_ref: 'native-profile://gemini/rehearsal',
      enabled: true, priority: 1, health_status: 'AVAILABLE', cooldown_until: null,
      concurrency_limit: 1, last_success_at: null, last_failure_at: null, last_failure_code: null,
      created_at: now, updated_at: now });
    repo.createProviderResource({ id: 'resource', provider_id: 'synthetic', provider_account_id: 'account',
      model_name: 'synthetic', capabilities: ['CODING'], health_status: 'AVAILABLE', enabled: true,
      total_quota: 100, remaining_quota: 100, quota_unit: 'REQUESTS', quota_source: 'MANUAL',
      quota_confidence: 1, quota_reset_at: null, last_health_check: now });
    repo.createRoleProfile({ id: 'coder', role: 'CODER', display_name: 'Synthetic coder',
      required_capabilities: ['CODING'], preferred_capabilities: [], authority_scope: null,
      permissions: [], output_protocol: 'coder.v1', enabled: true, created_at: now, updated_at: now });
    // An idle configured slot is input configuration; no acquired lease is seeded.
    db.prepare(`INSERT INTO worker_slots (id, provider_account_id, provider_resource_id,
      slot_index, status, created_at, updated_at) VALUES ('slot', 'account', 'resource', 0, 'IDLE', ?, ?)`)
      .run(now, now);
    const registry = new ProviderRegistry();
    let adapterCalls = 0;
    const adapter: ProviderAdapter = {
      id: 'synthetic', name: 'Synthetic boundary sentinel', adapterType: 'LOCAL_CLI',
      async getCapabilities() { return ['CODING']; },
      async getHealth() { return 'AVAILABLE'; },
      async getQuota() { return { remaining: 100, total: 100, unit: 'REQUESTS', source: 'MANUAL', confidence: 1, resetAt: null }; },
      async execute() { adapterCalls++; throw new Error('Unexpected dispatch past known context boundary'); },
      async cancel() { throw new Error('No synthetic coder was started'); },
    };
    registry.register(adapter);
    const tasks = new TaskService(repo, events);
    const task = tasks.createTask({ projectId: 'project', title: 'Integrated synthetic task', acceptanceCriteria: ['Local change verified'] });
    expect(task.state).toBe('PLANNED');
    const manager = { protocol: 'manager.v1' as const, message_id: 'manager', project_id: 'project',
      task_id: task.id, decision: 'EXECUTE' as const, priority: 'LOW' as const, risk: 'LOW' as const,
      instructions: ['Make a local synthetic change'], acceptance_criteria: ['Local change verified'],
      constraints: [], review_issues: [], expected_task_state: 'PLANNED' as const, expected_revision: 0 };
    expect((await tasks.applyManagerDecision(manager, JSON.stringify(manager))).success).toBe(true);
    expect(repo.getTask(task.id)?.state).toBe('CODING');
    expect(repo.getTask(task.id)?.base_sha).toBe(baseSha);
    const context = new ContextBuilderService(repo).buildContextSnapshot({
      projectId: 'project', taskId: task.id, contextFiles: ['README.md'],
    });
    const route = await new RoleAwareRoutingService(repo, registry, events).routeRole({
      projectId: 'project', taskId: task.id, roleProfileId: 'coder', persistAssignment: true,
      allowManualBridge: false, candidateRefs: [{ accountId: 'account', resourceId: 'resource' }],
    });
    expect(route.outcome).toBe('SELECTED');
    expect(route.selectedAssignmentId).toBeTruthy();
    const assignmentId = route.selectedAssignmentId!;
    const profile = new NativeProfileResolver({ baseProfilesDir: path.join(tempDir, 'profiles') })
      .resolve(repo.getProviderAccount('account')!.profile_ref!);
    expect(profile.profileDirectory.startsWith(tempDir + path.sep)).toBe(true);
    const auth = await new ExecutionAuthorizationService(repo, events).createAuthorization({
      projectId: 'project', taskId: task.id, routingDecisionId: route.decisionId,
      contextFiles: ['README.md'], contextManifestId: context.manifest.id,
      assignmentId, taskOwnershipEpoch: repo.getTask(task.id)!.ownership_epoch!,
    });
    const durable = repo.getExecutionAuthorization(auth.id)!;
    // Current initial-authorization service silently omits these input bindings.
    expect(durable.assignment_id).toBeNull();
    expect((db.prepare('SELECT selected_account_id FROM execution_authorizations WHERE id = ?').get(auth.id) as { selected_account_id: string | null }).selected_account_id).toBeNull();
    expect(durable.context_manifest_hash).toBe(context.manifest.manifest_hash);
    expect(durable.context_manifest_hash).not.toBe(computeContextManifestHash(['README.md']));
    const gitExecutable = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    const worktrees = new GitWorktreeService({ gitExecutable, repositoryRoot: repoDir, managedRoot: path.join(tempDir, 'worktrees') });
    const dispatch = new ProviderDispatchService(registry, repo, events, worktrees);
    const scheduler = new ConcurrentExecutionScheduler(repo, new WorkerSlotLeaseService(repo), worktrees, dispatch);
    const result = await scheduler.execute(auth.id);
    expect(result.providerResult?.error).toBe('EXECUTION_AUTHORIZATION_HASH_MISMATCH: Context manifest hash recomputation failed.');
    expect(result.providerResult?.errorCode).toBe('PROTOCOL_INVALID');
    expect(result.status).toBe('PROVIDER_FAILED');
    expect(adapterCalls).toBe(0);
    expect(repo.getExecutionAuthorization(auth.id)?.status).toBe('INVALIDATED');
    expect(result.leaseId).toBeTruthy();
    expect(repo.getAccountLease(result.leaseId!)?.released_at).toBeTruthy();
    expect(await worktrees.listPorcelain()).toHaveLength(1);
    console.log('R5L1_BOUNDARY', JSON.stringify({ source: 'SERVICE_EXECUTED',
      taskState: repo.getTask(task.id)?.state, contextSnapshotId: context.snapshot.id,
      routingDecisionId: route.decisionId, assignmentId, authorizationId: auth.id,
      missingAssignmentBinding: durable.assignment_id === null, missingAccountBinding: durable.selected_account_id == null,
      schedulerStatus: result.status, error: result.providerResult?.error, adapterCalls,
      conditionalHandoff: 'NOT_EXERCISED', downstream: 'NOT_EXERCISED: dispatch rejected before coder execution' }));
  } finally {
    await performSafeCleanup({ dbs: [db], tempDirs: [tempDir] });
  }
  expect(db?.open).toBe(false);
  expect(fs.existsSync(tempDir)).toBe(false);
}, 60000);
