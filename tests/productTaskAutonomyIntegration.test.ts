import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextBuilderService } from '../src/core/services/ContextBuilderService';
import {
  CanonicalExecutionPayload,
  ExecutionAuthorizationService,
  computePayloadHash,
} from '../src/core/services/ExecutionAuthorizationService';
import { GitService } from '../src/core/services/GitService';
import { EventService } from '../src/core/services/EventService';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import { WorkerSlotLeaseService } from '../src/core/services/WorkerSlotLeaseService';
import { Repository } from '../src/core/database/repositories';
import {
  MAX_AGY_WORKERS,
  ProductTaskAutonomyAdapter,
} from '../src/core/autonomy/productTaskAdapter';
import { AutonomyStore } from '../src/core/autonomy/store';
import {
  ManagerProviderPool,
  ManagerResource,
  buildManagerContextPackage,
} from '../src/core/autonomy/managerPool';
import { ExecutionAuthorization, Task } from '../src/core/types/domain';
import { ManagerReview, createWorkOrder } from '../src/core/autonomy/contracts';
import { AutonomySupervisor } from '../src/core/autonomy/supervisor';

const BASE_SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'abcdef0123456789abcdef0123456789abcdef01';

interface Fixture {
  task: Task;
  authorization: ExecutionAuthorization;
  assignmentId: string;
  slotId: string;
}

describe('product-task autonomy consolidation', () => {
  let root: string;
  let opened: ReturnType<typeof AutonomyStore.open>;
  let store: AutonomyStore;
  let repo: Repository;
  let adapter: ProductTaskAutonomyAdapter;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-product-autonomy-'));
    opened = AutonomyStore.open(root);
    store = opened.store;
    repo = new Repository(store.getDatabase());
    adapter = new ProductTaskAutonomyAdapter({
      repo,
      leaseService: new WorkerSlotLeaseService(repo),
      artifactStore: new ArtifactStore(path.join(root, 'artifacts')),
      autonomyStore: store,
      maxWorkers: 1,
    });
  });

  afterEach(() => {
    opened.engine.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function seed(
    taskId = 'task-product-1',
    includeExecutionScope = true,
    executionScopeOverrides: Partial<NonNullable<CanonicalExecutionPayload['executionScope']>> = {},
  ): Fixture {
    const now = new Date().toISOString();
    const projectId = 'project-product';
    if (!repo.getProject(projectId)) {
      repo.createProject({
        id: projectId,
        name: 'Product project',
        description: null,
        repository_path: root,
        default_branch: 'main',
        status: 'RUNNING',
        contract: null,
        created_at: now,
        updated_at: now,
        started_at: now,
        completed_at: null,
      });
      repo.createProvider({ id: 'provider-agy', name: 'Antigravity', adapter_type: 'LOCAL_CLI', enabled: true, created_at: now });
      repo.createProviderAccount({
        id: 'account-agy',
        provider_id: 'provider-agy',
        label: 'Authorized Antigravity account',
        auth_mode: 'NATIVE_PROFILE',
        credential_ref: null,
        profile_ref: 'native-profile://antigravity/default',
        enabled: true,
        priority: 100,
        health_status: 'AVAILABLE',
        cooldown_until: null,
        concurrency_limit: 2,
        last_success_at: null,
        last_failure_at: null,
        last_failure_code: null,
        created_at: now,
        updated_at: now,
      });
      repo.createProviderResource({
        id: 'resource-agy',
        provider_id: 'provider-agy',
        provider_account_id: 'account-agy',
        model_name: 'antigravity',
        health_status: 'AVAILABLE',
        capabilities: ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION'],
        enabled: true,
        total_quota: null,
        remaining_quota: null,
        quota_unit: 'REQUESTS',
        quota_reset_at: null,
        quota_source: 'UNKNOWN',
        quota_confidence: 0,
        last_health_check: now,
      });
      repo.createRoleProfile({
        id: 'role-coder',
        role: 'CODER',
        display_name: 'Coder',
        required_capabilities: ['CODING'],
        preferred_capabilities: [],
        authority_scope: null,
        permissions: ['FILESYSTEM_EDIT'],
        output_protocol: 'coder.v1',
        enabled: true,
        created_at: now,
        updated_at: now,
      });
    }

    const task: Task = {
      id: taskId,
      project_id: projectId,
      milestone_id: null,
      title: `Consolidated ${taskId}`,
      description: 'Exercise the real product task path',
      state: 'APPROVED',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: BASE_SHA,
      current_sha: BASE_SHA,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: ['Product lifecycle reaches review with deterministic evidence'],
      constraints: ['MAX_AGY_WORKERS=1'],
      ownership_epoch: 1,
      created_at: now,
      updated_at: now,
    };
    repo.createTask(task);

    const assignmentId = `assignment-${taskId}`;
    repo.createAgentAssignment({
      id: assignmentId,
      project_id: projectId,
      task_id: taskId,
      attempt_id: null,
      role_profile_id: 'role-coder',
      agent_profile_id: null,
      selected_provider_id: 'provider-agy',
      selected_account_id: 'account-agy',
      selected_resource_id: 'resource-agy',
      selected_worker_slot_id: null,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: now,
      ended_at: null,
    });
    const slotId = `slot-${taskId}`;
    repo.createWorkerSlot({
      id: slotId,
      provider_account_id: 'account-agy',
      provider_resource_id: 'resource-agy',
      slot_index: taskId === 'task-product-1' ? 1 : 2,
      status: 'IDLE',
      current_assignment_id: null,
      current_execution_id: null,
      heartbeat_at: null,
      created_at: now,
      updated_at: now,
    });

    const context = new ContextBuilderService(repo).buildContextSnapshot({
      projectId,
      taskId,
      assignmentId,
      purpose: 'EXECUTION',
      includeProjectMemory: false,
      includeTaskMemory: false,
      includeLatestCheckpoint: false,
      includeLatestHandoff: false,
    });
    const canonicalPayload: CanonicalExecutionPayload = {
      projectId,
      taskId,
      attemptId: null,
      taskTitle: task.title,
      taskDescription: task.description,
      acceptanceCriteria: task.acceptance_criteria,
      constraints: task.constraints,
      instructions: ['Implement only the authorized product task.'],
      contextFiles: [],
      verificationCommands: {
        TEST: { executable: process.execPath, args: ['--version'] },
        LINT: null,
        BUILD: null,
      },
      managerMessageId: `manager-${taskId}`,
      managerPayloadHash: crypto.createHash('sha256').update(taskId).digest('hex'),
      ...(includeExecutionScope ? {
        executionScope: {
          branch: `agent/agy-01/${taskId}`,
          worktree: path.join(root, 'worktrees', taskId),
          allowedPaths: ['src'],
          forbiddenPaths: ['.git'],
          ...executionScopeOverrides,
        },
      } : {}),
    };
    repo.recordProtocolMessage(
      canonicalPayload.managerMessageId,
      `external-${canonicalPayload.managerMessageId}`,
      'manager.v1',
      projectId,
      taskId,
      'APPROVED',
      0,
      canonicalPayload.managerPayloadHash,
      JSON.stringify({ decision: 'EXECUTE', taskId }),
      'APPLIED',
    );
    const authorization: ExecutionAuthorization = {
      id: `authorization-${taskId}`,
      project_id: projectId,
      task_id: taskId,
      attempt_id: null,
      task_revision: 0,
      base_sha: BASE_SHA,
      repository_head_sha: BASE_SHA,
      manager_message_id: canonicalPayload.managerMessageId,
      manager_payload_hash: canonicalPayload.managerPayloadHash,
      routing_decision_id: `route-${taskId}`,
      selected_account_id: 'account-agy',
      selected_resource_id: 'resource-agy',
      selected_provider_id: 'provider-agy',
      instruction_payload_hash: computePayloadHash(canonicalPayload),
      context_manifest_hash: context.manifest.manifest_hash,
      canonical_instructions_json: JSON.stringify(canonicalPayload.instructions),
      context_files_json: '[]',
      canonical_payload_json: JSON.stringify(canonicalPayload),
      expected_task_revision: 0,
      status: 'AUTHORIZED',
      created_at: now,
      dispatched_at: null,
      task_ownership_epoch: 1,
      assignment_id: assignmentId,
      lifecycle_version: 1,
    };
    repo.createExecutionAuthorization(authorization);
    return { task, authorization, assignmentId, slotId };
  }

  function workOrderInput(fixture: Fixture) {
    return {
      authorizationId: fixture.authorization.id,
      currentHeadSha: BASE_SHA,
      workerId: 'agy-01',
      branch: `agent/agy-01/${fixture.task.id}`,
      worktree: path.join(root, 'worktrees', fixture.task.id),
      allowedPaths: ['src'],
      forbiddenPaths: ['.git'],
    };
  }

  function createRetryAuthorization(fixture: Fixture, revision: number): string {
    const now = new Date().toISOString();
    const retryContext = new ContextBuilderService(repo).buildContextSnapshot({
      projectId: fixture.task.project_id,
      taskId: fixture.task.id,
      assignmentId: fixture.assignmentId,
      purpose: 'EXECUTION',
      includeProjectMemory: false,
      includeTaskMemory: false,
      includeLatestCheckpoint: false,
      includeLatestHandoff: false,
    });
    const retryPayload: CanonicalExecutionPayload = {
      projectId: fixture.task.project_id,
      taskId: fixture.task.id,
      attemptId: null,
      taskTitle: fixture.task.title,
      taskDescription: fixture.task.description,
      acceptanceCriteria: fixture.task.acceptance_criteria,
      constraints: fixture.task.constraints,
      instructions: [`Resumed execution revision ${revision}`],
      contextFiles: [],
      verificationCommands: {
        TEST: { executable: process.execPath, args: ['--version'] },
        LINT: null,
        BUILD: null,
      },
      managerMessageId: `manager-retry-${fixture.task.id}-rev${revision}`,
      managerPayloadHash: crypto.createHash('sha256').update(`retry-${fixture.task.id}-rev${revision}`).digest('hex'),
      executionScope: {
        branch: `agent/agy-01/${fixture.task.id}`,
        worktree: path.join(root, 'worktrees', fixture.task.id),
        allowedPaths: ['src'],
        forbiddenPaths: ['.git'],
      },
    };
    repo.recordProtocolMessage(
      retryPayload.managerMessageId,
      `external-${retryPayload.managerMessageId}`,
      'manager.v1',
      fixture.task.project_id,
      fixture.task.id,
      'CODING',
      revision,
      retryPayload.managerPayloadHash,
      JSON.stringify({ decision: 'EXECUTE', taskId: fixture.task.id }),
      'APPLIED',
    );
    const retryAuthId = `authorization-${fixture.task.id}-rev${revision}`;
    repo.createExecutionAuthorization({
      id: retryAuthId,
      project_id: fixture.task.project_id,
      task_id: fixture.task.id,
      attempt_id: null,
      task_revision: revision,
      base_sha: BASE_SHA,
      repository_head_sha: BASE_SHA,
      manager_message_id: retryPayload.managerMessageId,
      manager_payload_hash: retryPayload.managerPayloadHash,
      routing_decision_id: `route-retry-${fixture.task.id}-rev${revision}`,
      selected_account_id: 'account-agy',
      selected_resource_id: 'resource-agy',
      selected_provider_id: 'provider-agy',
      instruction_payload_hash: computePayloadHash(retryPayload),
      context_manifest_hash: retryContext.manifest.manifest_hash,
      canonical_instructions_json: JSON.stringify(retryPayload.instructions),
      context_files_json: '[]',
      canonical_payload_json: JSON.stringify(retryPayload),
      expected_task_revision: revision,
      status: 'AUTHORIZED',
      created_at: now,
      dispatched_at: null,
      task_ownership_epoch: 1,
      assignment_id: fixture.assignmentId,
      lifecycle_version: 1,
    });
    return retryAuthId;
  }

  it('validates task, authorization, routing, epoch, exact head, and ContextManifest as one authority', () => {
    const fixture = seed();
    const result = adapter.validateAuthority(workOrderInput(fixture));
    expect(result.valid).toBe(true);
    expect(result.authority?.task.id).toBe(fixture.task.id);
  });

  it('validates an authorization created by the real ExecutionAuthorizationService without tests manually fabricating the authorization record', async () => {
    seed(); // ensure project, provider, account, resource, role profile are seeded

    const gitSpy = vi.spyOn(GitService, 'getHeadSha').mockResolvedValue({ status: 'SUCCESS', sha: BASE_SHA });
    try {
      const taskId = 'task-real-auth-service';
      const projectId = 'project-product';
      const now = new Date().toISOString();

      const task: Task = {
        id: taskId,
        project_id: projectId,
        milestone_id: null,
        title: 'Real Service Authorization Task',
        description: 'Exercise createAuthorization with real service',
        state: 'CODING',
        paused_from_state: null,
        priority: 'HIGH',
        risk: 'MEDIUM',
        assigned_agent_id: null,
        revision_count: 0,
        max_revisions: 3,
        base_sha: BASE_SHA,
        current_sha: BASE_SHA,
        progress_cache_percent: 0,
        progress_computed_at: null,
        acceptance_criteria: ['Authorization created by service validates cleanly'],
        constraints: ['MAX_AGY_WORKERS=1'],
        ownership_epoch: 1,
        created_at: now,
        updated_at: now,
      };
      repo.createTask(task);

      // Record applied Manager EXECUTE message
      const msgId = 'mgr-msg-real-auth';
      const rawPayload = JSON.stringify({
        protocol: 'manager.v1',
        message_id: msgId,
        project_id: projectId,
        task_id: taskId,
        decision: 'EXECUTE',
        expected_revision: 0,
        instructions: ['Implement task using real service authorization'],
        acceptance_criteria: task.acceptance_criteria,
        constraints: task.constraints,
      });
      const pHash = crypto.createHash('sha256').update(rawPayload).digest('hex');
      repo.recordProtocolMessage(
        'rec-mgr-real-auth',
        msgId,
        'manager.v1',
        projectId,
        taskId,
        'APPROVED',
        0,
        pHash,
        rawPayload,
        'APPLIED',
        undefined,
        now
      );

      const routingDecisionId = 'route-decision-real-auth';
      const assignmentId = `assignment-${taskId}`;

      // Create assignment matching routing decision and provider/account/resource
      repo.createAgentAssignment({
        id: assignmentId,
        project_id: projectId,
        task_id: taskId,
        attempt_id: null,
        role_profile_id: 'role-coder',
        agent_profile_id: null,
        selected_provider_id: 'provider-agy',
        selected_account_id: 'account-agy',
        selected_resource_id: 'resource-agy',
        selected_worker_slot_id: null,
        routing_decision_id: routingDecisionId,
        preferred_metadata: null,
        status: 'ASSIGNED',
        created_at: now,
        ended_at: null,
      });

      // Record routing decision event
      const eventService = new EventService(repo);
      eventService.record(
        projectId,
        'PROVIDER_ROUTING_DECISION',
        `Routing decision: SELECTED for task ${taskId}`,
        {
          decisionId: routingDecisionId,
          projectId,
          taskId,
          attemptId: null,
          candidateResourceIds: ['resource-agy'],
          selectedResourceId: 'resource-agy',
          selectedProviderId: 'provider-agy',
          selectedAccountId: 'account-agy',
          selectedAssignmentId: assignmentId,
          outcome: 'SELECTED',
          reason: 'Selected Antigravity account',
          candidateEvaluations: [],
        },
        taskId
      );

      // Create context manifest bound to assignment
      const context = new ContextBuilderService(repo).buildContextSnapshot({
        projectId,
        taskId,
        assignmentId,
        purpose: 'EXECUTION',
        includeProjectMemory: false,
        includeTaskMemory: false,
        includeLatestCheckpoint: false,
        includeLatestHandoff: false,
      });

      const executionScope = {
        branch: `agent/agy-01/${taskId}`,
        worktree: path.join(root, 'worktrees', taskId),
        allowedPaths: ['src'],
        forbiddenPaths: ['.git'],
      };

      // Call the REAL service to create the authorization
      const authService = new ExecutionAuthorizationService(repo, eventService);
      const createdAuth = await authService.createAuthorization({
        projectId,
        taskId,
        routingDecisionId,
        assignmentId,
        taskOwnershipEpoch: 1,
        contextManifestId: context.manifest.id,
        executionScope,
      });

      expect(createdAuth.assignment_id).toBe(assignmentId);
      expect(createdAuth.selected_account_id).toBe('account-agy');
      expect(createdAuth.task_ownership_epoch).toBe(1);
      expect(createdAuth.lifecycle_version).toBe(1);
      expect(createdAuth.status).toBe('AUTHORIZED');

      // Now validate authority via ProductTaskAutonomyAdapter
      const validation = adapter.validateAuthority({
        authorizationId: createdAuth.id,
        currentHeadSha: BASE_SHA,
        branch: executionScope.branch,
        worktree: executionScope.worktree,
        allowedPaths: executionScope.allowedPaths,
        forbiddenPaths: executionScope.forbiddenPaths,
        requireScopeMatch: true,
      });

      expect(validation.valid).toBe(true);
      expect(validation.authority?.task.id).toBe(taskId);
      expect(validation.authority?.authorization.id).toBe(createdAuth.id);
      expect(validation.authority?.assignment.id).toBe(assignmentId);
      expect(validation.authority?.authorization.selected_account_id).toBe('account-agy');
      const repoAccount = repo.getProviderAccount(validation.authority?.authorization.selected_account_id!);
      expect(repoAccount).not.toBeNull();
      expect(repoAccount?.id).toBe('account-agy');
    } finally {
      gitSpy.mockRestore();
    }
  });

  it('fails closed when a product authorization omits durable execution scope', async () => {
    const fixture = seed('task-scope-missing', false);
    let coderCalled = false;
    const result = await adapter.executeProductTask({
      ...workOrderInput(fixture),
      runCoder: async () => {
        coderCalled = true;
        return { success: true, currentHeadSha: BASE_SHA };
      },
      runVerification: async () => { throw new Error('verification must not run'); },
      conductReview: async () => { throw new Error('review must not run'); },
    });

    expect(result.success).toBe(false);
    expect(result.leaseAcquired).toBe(false);
    expect(result.error).toContain('EXECUTION_SCOPE_MISSING');
    expect(coderCalled).toBe(false);
    expect(repo.getWorkerSlot(fixture.slotId)?.status).toBe('IDLE');
  });

  it('detects durable execution-scope tampering through instruction_payload_hash', () => {
    const fixture = seed('task-scope-hash-tamper');
    const payload = JSON.parse(fixture.authorization.canonical_payload_json!) as CanonicalExecutionPayload;
    payload.executionScope!.allowedPaths = ['src', 'docs'];
    store.getDatabase().prepare(
      'UPDATE execution_authorizations SET canonical_payload_json=? WHERE id=?',
    ).run(JSON.stringify(payload), fixture.authorization.id);

    const result = adapter.validateAuthority(workOrderInput(fixture));
    expect(result.valid).toBe(false);
    expect(result.code).toBe('CANONICAL_PAYLOAD_HASH_MISMATCH');
  });

  const executionScopeMismatchCases = [
    {
      name: 'expanded allowed paths',
      mutate: (input: ReturnType<typeof workOrderInput>) => ({ ...input, allowedPaths: ['src', 'docs'] }),
      code: 'ALLOWED_PATHS_MISMATCH',
    },
    {
      name: 'narrowed allowed paths',
      mutate: (input: ReturnType<typeof workOrderInput>) => ({ ...input, allowedPaths: ['src/core'] }),
      code: 'ALLOWED_PATHS_MISMATCH',
    },
    {
      name: 'weakened forbidden paths',
      mutate: (input: ReturnType<typeof workOrderInput>) => ({ ...input, forbiddenPaths: [] }),
      code: 'FORBIDDEN_PATHS_MISMATCH',
    },
    {
      name: 'different branch',
      mutate: (input: ReturnType<typeof workOrderInput>) => ({ ...input, branch: `${input.branch}-other` }),
      code: 'BRANCH_MISMATCH',
    },
    {
      name: 'different worktree',
      mutate: (input: ReturnType<typeof workOrderInput>) => ({ ...input, worktree: `${input.worktree}-other` }),
      code: 'WORKTREE_MISMATCH',
    },
  ];

  for (const scopeCase of executionScopeMismatchCases) {
    it(`rejects ${scopeCase.name} before lease acquisition or coder execution`, async () => {
      const fixture = seed(`task-scope-${scopeCase.name.replace(/\s+/g, '-')}`);
      let coderCalled = false;
      const result = await adapter.executeProductTask({
        ...scopeCase.mutate(workOrderInput(fixture)),
        runCoder: async () => {
          coderCalled = true;
          return { success: true, currentHeadSha: BASE_SHA };
        },
        runVerification: async () => { throw new Error('verification must not run'); },
        conductReview: async () => { throw new Error('review must not run'); },
      });

      expect(result.success).toBe(false);
      expect(result.leaseAcquired).toBe(false);
      expect(result.error).toContain(scopeCase.code);
      expect(coderCalled).toBe(false);
      expect(repo.getWorkerSlot(fixture.slotId)?.status).toBe('IDLE');
    });
  }

  it('fences a stale authorization after ownership epoch changes', () => {
    const fixture = seed();
    expect(repo.bumpTaskOwnershipEpoch(fixture.task.id, 1).success).toBe(true);
    expect(adapter.validateAuthority(workOrderInput(fixture))).toMatchObject({
      valid: false,
      code: 'OWNERSHIP_EPOCH_MISMATCH',
    });
  });

  it('derives WorkOrder only from durable product authority without creating an autonomy lifecycle row', () => {
    const fixture = seed();
    const order = adapter.buildAuthorizedWorkOrder(workOrderInput(fixture));
    expect(order.task_id).toBe(fixture.task.id);
    expect(order.lease_epoch).toBe(1);
    expect(order.required_tests[0]).toContain(JSON.stringify(process.execPath));
    expect(store.listAll()).toHaveLength(0);
  });

  it('uses WorkerSlotLeaseService and enforces the one-worker consolidation fence', () => {
    const first = seed();
    const second = seed('task-product-2');
    const acquired = adapter.acquireWorkerSlotLease(first.assignmentId);
    expect(acquired.status).toBe('ACQUIRED');
    expect(adapter.acquireWorkerSlotLease(second.assignmentId)).toMatchObject({
      status: 'FAILED',
      error: expect.stringContaining('MAX_WORKERS_EXCEEDED'),
    });
    if (acquired.status === 'ACQUIRED') {
      expect(adapter.releaseWorkerSlotLease(acquired.lease.id, acquired.lease.lease_token).status).toBe('RELEASED');
    }
  });

  it('retains and inventories provisional work orders, leases, evidence, reviews, and CI watches', () => {
    const now = new Date().toISOString();
    store.getDatabase().prepare(`INSERT INTO autonomy_work_orders
      (id,task_id,attempt,lease_epoch,worker_id,state,payload_json,base_sha,branch,worktree,created_at,updated_at)
      VALUES ('legacy-order','SELF-HOST-LEGACY',1,1,'agy-01','MANAGER_REVIEW','{}',?,'legacy','D:/legacy',?,?)`).run(BASE_SHA, now, now);
    store.getDatabase().prepare(`INSERT INTO autonomy_reviews
      (id,work_order_id,reviewed_head_sha,verdict,payload_json,created_at)
      VALUES ('legacy-review','legacy-order',?,'PASS','{}',?)`).run(BASE_SHA, now);
    const inventory = adapter.inventoryLegacyAutonomyState();
    expect(inventory.tables.find((table) => table.tableName === 'autonomy_work_orders')).toMatchObject({
      totalRows: 1,
      activeRows: 1,
      isAuthoritative: false,
    });
    expect(inventory.tables.find((table) => table.tableName === 'autonomy_reviews')?.totalRows).toBe(1);
    expect(store.getDatabase().prepare('SELECT COUNT(*) count FROM autonomy_work_orders').get()).toEqual({ count: 1 });
  });

  it('keeps timeout then passing rerun as two truthful verification attempts', () => {
    const fixture = seed();
    const common = {
      projectId: fixture.task.project_id,
      taskId: fixture.task.id,
      attemptId: null,
      command: 'vitest run',
      durationMs: 5000,
      workingDirectory: root,
    };
    adapter.recordVerificationObservation({ ...common, status: 'TIMED_OUT', exitCode: null, passedCount: 0, failedCount: 1, stderr: 'timeout' });
    adapter.recordVerificationObservation({ ...common, status: 'COMPLETED', exitCode: 0, passedCount: 31, failedCount: 0, stdout: '31 passed' });
    expect(adapter.getTruthfulVerificationReport(fixture.task.id)).toMatchObject({
      totalAttempts: 2,
      latestAttemptPassed: true,
      isFirstPassSuccess: false,
      hadPriorFailure: true,
    });
    expect(store.getDatabase().prepare('SELECT status FROM process_runs WHERE task_id=? ORDER BY created_at,rowid').all(fixture.task.id)).toEqual([
      { status: 'TIMED_OUT' },
      { status: 'COMPLETED' },
    ]);
  });

  it('rejects a stale PASS after a manager provider switch', () => {
    const stale: ManagerReview = {
      protocol_version: 'managerreview.v1',
      verdict: 'PASS',
      reviewed_head_sha: OTHER_SHA,
      findings: [],
      required_actions: [],
      risk: 'LOW',
      notes: 'reviewed by fallback',
    };
    expect(adapter.validateReviewFreshness(stale, BASE_SHA)).toMatchObject({
      fresh: false,
      error: expect.stringContaining('EXACT_HEAD_FENCING_VIOLATION'),
    });
  });

  it('routes manager selection through product ProviderResource and ProviderAccount health', async () => {
    const now = new Date().toISOString();
    repo.createProvider({ id: 'manager-provider', name: 'Managers', adapter_type: 'API', enabled: true, created_at: now });
    for (const [id, health, priority] of [['primary', 'QUOTA_EXHAUSTED', 100], ['fallback', 'AVAILABLE', 50]] as const) {
      repo.createProviderAccount({
        id: `account-${id}`, provider_id: 'manager-provider', label: id, auth_mode: 'API_CREDENTIAL',
        credential_ref: `wincred://agentforge/manager/${id}`, profile_ref: null, enabled: true, priority,
        health_status: health, cooldown_until: null, concurrency_limit: 1, last_success_at: null,
        last_failure_at: null, last_failure_code: null, created_at: now, updated_at: now,
      });
      repo.createProviderResource({
        id, provider_id: 'manager-provider', provider_account_id: `account-${id}`, model_name: id,
        health_status: health, capabilities: ['REVIEW'], enabled: true, total_quota: 100,
        remaining_quota: id === 'primary' ? 0 : 100, quota_unit: 'REQUESTS', quota_reset_at: null,
        quota_source: 'PROVIDER_REPORTED', quota_confidence: 1, last_health_check: now,
      });
    }
    let primaryCalled = false;
    let fallbackCalled = false;
    const resources: ManagerResource[] = [
      {
        id: 'primary', priority: 100, enabled: true,
        review: async () => { primaryCalled = true; throw new Error('must be skipped'); },
      },
      {
        id: 'fallback', priority: 50, enabled: true,
        review: async (input) => {
          fallbackCalled = true;
          return {
            run: { status: 'SUCCESSFUL_PROCESS_EXIT', exitCode: 0, executionId: 'fallback-run', stdout: '{}', stderr: '', durationMs: 1 },
            review: { protocol_version: 'managerreview.v1', verdict: 'PASS', reviewed_head_sha: input.workOrder.base_sha, findings: [], required_actions: [], risk: 'LOW', notes: '' },
          };
        },
      },
    ];
    const order = createWorkOrder({
      taskId: 'manager-routing', workerId: 'agy-01', objective: 'review', baseSha: BASE_SHA,
      branch: 'agent/review', worktree: path.join(root, 'review'), allowedPaths: ['src'],
      acceptanceCriteria: ['review passes'], requiredTests: ['node --version'],
    });
    const result = await new ManagerProviderPool(store, resources).review(buildManagerContextPackage({ workOrder: order, currentHead: BASE_SHA }));
    expect(primaryCalled).toBe(false);
    expect(fallbackCalled).toBe(true);
    expect(result.resource_id).toBe('fallback');
  });

  it('completes one real product task end-to-end and releases its product lease', async () => {
    const fixture = seed();
    const input = workOrderInput(fixture);
    const result = await adapter.executeProductTask({
      ...input,
      runCoder: async () => ({ success: true, currentHeadSha: BASE_SHA }),
      evidenceCollector: {
        collect: async () => ({
          headSha: BASE_SHA,
          snapshotSha: 'snapshot-initial',
          status: '',
          changedFiles: ['src'],
          diff: 'diff-initial',
          tests: [],
        }),
      },
      runVerification: async (authority, workOrder) => adapter.recordVerificationObservation({
        projectId: authority.task.project_id,
        taskId: authority.task.id,
        attemptId: authority.authorization.attempt_id,
        command: 'node --version',
        status: 'COMPLETED',
        exitCode: 0,
        passedCount: 1,
        failedCount: 0,
        durationMs: 1,
        stdout: process.version,
        workingDirectory: workOrder!.worktree,
      }),
      conductReview: async (context) => ({
        protocol_version: 'managerreview.v1',
        verdict: 'PASS',
        reviewed_head_sha: context.current_head,
        findings: [],
        required_actions: [],
        risk: 'LOW',
        notes: 'exact-head product task proof',
      }),
    });
    expect(result).toMatchObject({ success: true, finalTaskState: 'DONE', leaseAcquired: true, leaseReleased: true });
    expect(repo.getTask(fixture.task.id)?.state).toBe('DONE');
    expect(repo.getWorkerSlot(fixture.slotId)?.status).toBe('IDLE');
    expect(store.listAll()).toHaveLength(0);
  });

  it('fences PASS if post-review working-tree snapshot changes after manager review', async () => {
    const fixture = seed('task-snapshot-fencing');
    const input = workOrderInput(fixture);
    let collectCount = 0;
    const result = await adapter.executeProductTask({
      ...input,
      runCoder: async () => ({ success: true, currentHeadSha: BASE_SHA }),
      evidenceCollector: {
        collect: async () => {
          collectCount++;
          return {
            headSha: BASE_SHA,
            snapshotSha: collectCount === 1 ? 'snapshot-pre-review' : 'snapshot-post-review-MODIFIED',
            status: '',
            changedFiles: ['src'],
            diff: 'diff',
            tests: [],
          };
        },
      },
      runVerification: async (authority, workOrder) => adapter.recordVerificationObservation({
        projectId: authority.task.project_id,
        taskId: authority.task.id,
        attemptId: authority.authorization.attempt_id,
        command: 'node --version',
        status: 'COMPLETED',
        exitCode: 0,
        passedCount: 1,
        failedCount: 0,
        durationMs: 1,
        stdout: process.version,
        workingDirectory: workOrder!.worktree,
      }),
      conductReview: async (context) => ({
        protocol_version: 'managerreview.v1',
        verdict: 'PASS',
        reviewed_head_sha: context.current_head,
        findings: [],
        required_actions: [],
        risk: 'LOW',
        notes: 'review ok',
      }),
    });
    expect(result.success).toBe(false);
    expect(result.staleReview).toBe(true);
    expect(result.error).toContain('WORKING_TREE_SNAPSHOT_FENCING_VIOLATION');
    expect(result.finalTaskState).toBe('CODING');
    expect(repo.getTask(fixture.task.id)?.state).toBe('CODING');
    expect(repo.getTask(fixture.task.id)?.state).not.toBe('DONE');
  });

  it('fences PASS if post-review HEAD changes after manager review', async () => {
    const fixture = seed('task-head-fencing');
    const input = workOrderInput(fixture);
    let collectCount = 0;
    const result = await adapter.executeProductTask({
      ...input,
      runCoder: async () => ({ success: true, currentHeadSha: BASE_SHA }),
      evidenceCollector: {
        collect: async () => {
          collectCount++;
          return {
            headSha: collectCount === 1 ? BASE_SHA : OTHER_SHA,
            snapshotSha: 'snapshot-fixed',
            status: '',
            changedFiles: ['src'],
            diff: 'diff',
            tests: [],
          };
        },
      },
      runVerification: async (authority, workOrder) => adapter.recordVerificationObservation({
        projectId: authority.task.project_id,
        taskId: authority.task.id,
        attemptId: authority.authorization.attempt_id,
        command: 'node --version',
        status: 'COMPLETED',
        exitCode: 0,
        passedCount: 1,
        failedCount: 0,
        durationMs: 1,
        stdout: process.version,
        workingDirectory: workOrder!.worktree,
      }),
      conductReview: async (context) => ({
        protocol_version: 'managerreview.v1',
        verdict: 'PASS',
        reviewed_head_sha: context.current_head,
        findings: [],
        required_actions: [],
        risk: 'LOW',
        notes: 'review ok',
      }),
    });
    expect(result.success).toBe(false);
    expect(result.staleReview).toBe(true);
    expect(result.error).toContain('EXACT_HEAD_FENCING_VIOLATION');
    expect(result.finalTaskState).toBe('CODING');
    expect(repo.getTask(fixture.task.id)?.state).toBe('CODING');
    expect(repo.getTask(fixture.task.id)?.state).not.toBe('DONE');
  });

  it('rejects execution if runCoder claims a HEAD that mismatches independently observed HEAD', async () => {
    const fixture = seed('task-coder-mismatch');
    const input = workOrderInput(fixture);
    const result = await adapter.executeProductTask({
      ...input,
      runCoder: async () => ({ success: true, currentHeadSha: OTHER_SHA }),
      evidenceCollector: {
        collect: async () => ({
          headSha: BASE_SHA,
          snapshotSha: 'snapshot-fixed',
          status: '',
          changedFiles: ['src'],
          diff: 'diff',
          tests: [],
        }),
      },
      runVerification: async () => { throw new Error('should not reach verification'); },
      conductReview: async () => { throw new Error('should not reach review'); },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('CODER_HEAD_MISMATCH');
  });

  it('historical passing TestRun cannot satisfy when the current runVerification returns a failing TestRun', async () => {
    const fixture = seed('task-verif-fail');
    const input = workOrderInput(fixture);
    // Record an earlier historical passing test run
    adapter.recordVerificationObservation({
      projectId: fixture.task.project_id,
      taskId: fixture.task.id,
      attemptId: null,
      command: 'historical-pass',
      status: 'COMPLETED',
      exitCode: 0,
      passedCount: 42,
      failedCount: 0,
      durationMs: 100,
      stdout: 'all passed',
      workingDirectory: root,
    });
    expect(adapter.getTruthfulVerificationReport(fixture.task.id).latestAttemptPassed).toBe(true);

    // Current execution verification returns a failing run
    const result = await adapter.executeProductTask({
      ...input,
      runCoder: async () => ({ success: true, currentHeadSha: BASE_SHA }),
      evidenceCollector: {
        collect: async () => ({
          headSha: BASE_SHA,
          snapshotSha: 'snapshot-fixed',
          status: '',
          changedFiles: ['src'],
          diff: 'diff',
          tests: [],
        }),
      },
      runVerification: async (authority, workOrder) => adapter.recordVerificationObservation({
        projectId: authority.task.project_id,
        taskId: authority.task.id,
        attemptId: authority.authorization.attempt_id,
        command: 'current-fail',
        status: 'FAILED',
        exitCode: 1,
        passedCount: 0,
        failedCount: 1,
        durationMs: 50,
        stdout: '',
        stderr: 'assertion failed',
        workingDirectory: workOrder!.worktree,
      }),
      conductReview: async () => { throw new Error('should not reach review'); },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('VERIFICATION_FAILED');
    expect(result.finalTaskState).toBe('CODING');
    expect(repo.getTask(fixture.task.id)?.state).toBe('CODING');
  });

  it('historical passing TestRun cannot satisfy when the current runVerification returns null', async () => {
    const fixture = seed('task-verif-null');
    const input = workOrderInput(fixture);
    // Record historical pass
    adapter.recordVerificationObservation({
      projectId: fixture.task.project_id,
      taskId: fixture.task.id,
      attemptId: null,
      command: 'historical-pass',
      status: 'COMPLETED',
      exitCode: 0,
      passedCount: 10,
      failedCount: 0,
      durationMs: 10,
      stdout: 'pass',
      workingDirectory: root,
    });

    const result = await adapter.executeProductTask({
      ...input,
      runCoder: async () => ({ success: true, currentHeadSha: BASE_SHA }),
      evidenceCollector: {
        collect: async () => ({
          headSha: BASE_SHA,
          snapshotSha: 'snapshot-fixed',
          status: '',
          changedFiles: ['src'],
          diff: 'diff',
          tests: [],
        }),
      },
      runVerification: async () => null as any,
      conductReview: async () => { throw new Error('should not reach review'); },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('CURRENT_VERIFICATION_TEST_RUN_MISSING');
    expect(result.finalTaskState).toBe('CODING');
  });

  it('fails closed if attempting to execute a product task via legacy autonomy state', () => {
    const fixture = seed('task-legacy-fence');
    const order = createWorkOrder({
      taskId: fixture.task.id,
      workerId: 'agy-01',
      objective: 'legacy attempt on product task',
      baseSha: BASE_SHA,
      branch: 'agent/agy-01/test',
      worktree: path.join(root, 'worktrees', 'legacy'),
      allowedPaths: ['src'],
      acceptanceCriteria: ['legacy product task execution is rejected'],
      requiredTests: ['npm test'],
    });
    expect(() => store.createWorkOrder(order)).toThrow('PRODUCT_TASK_CANNOT_USE_LEGACY_AUTONOMY_LIFECYCLE');
  });

  it('operational supervisor dispatches product task via ProductTaskAutonomyAdapter when ExecutionAuthorization exists', async () => {
    const fixture = seed('task-op-dispatch');
    const supervisor = new AutonomySupervisor({
      store,
      agyProviderId: 'provider-agy',
      agyResourceId: 'resource-agy',
      productAdapter: adapter,
      worktreeRoot: path.join(root, 'worktrees'),
      evidence: {
        collect: async () => ({
          headSha: BASE_SHA,
          snapshotSha: 'snapshot-ok',
          status: '',
          changedFiles: ['src'],
          diff: 'diff-ok',
          tests: [{ command: 'node --version', exitCode: 0, stdout: 'v22.0.0', stderr: '', durationMs: 1 }],
        }),
      },
      agy: {
        execute: async () => ({
          status: 'SUCCESSFUL_PROCESS_EXIT' as const,
          exitCode: 0,
          executionId: 'exec-1',
          stdout: '',
          stderr: '',
          durationMs: 1,
        }),
      } as any,
      managerPool: {
        review: async () => ({
          run: { status: 'SUCCESSFUL_PROCESS_EXIT' as const, exitCode: 0, executionId: '', stdout: '', stderr: '', durationMs: 1 },
          review: {
            protocol_version: 'managerreview.v1' as const,
            verdict: 'PASS' as const,
            reviewed_head_sha: BASE_SHA,
            findings: [],
            required_actions: [],
            risk: 'LOW' as const,
            notes: 'product task passed review',
          },
          resource_id: 'manager-test',
          context_sha: 'sha-test',
          attempts: ['manager-test'],
        }),
      } as any,
    });

    const spec = {
      taskId: fixture.task.id,
      workerId: 'agy-01',
      objective: fixture.task.description ?? fixture.task.title,
      baseSha: BASE_SHA,
      branch: `agent/agy-01/${fixture.task.id}`,
      worktree: path.join(root, 'worktrees', fixture.task.id),
      allowedPaths: ['src'],
      forbiddenPaths: ['.git'],
      acceptanceCriteria: ['product task completes through product authority'],
      requiredTests: ['node --version'],
    };
    fs.mkdirSync(spec.worktree, { recursive: true });

    const result = await supervisor.run(spec);
    expect(result.accepted).toBe(true);
    expect(result.state).toBe('DONE');
    expect(repo.getTask(fixture.task.id)?.state).toBe('DONE');
    // Critical: zero legacy autonomy work order rows were created
    expect(store.listAll()).toHaveLength(0);
  });

  it('operational supervisor fails closed when product task has no ExecutionAuthorization', async () => {
    const fixture = seed('task-no-auth');
    // Delete execution authorization to simulate an unauthorized product task
    store.getDatabase().prepare('DELETE FROM execution_authorizations WHERE task_id=?').run(fixture.task.id);

    const supervisor = new AutonomySupervisor({
      store,
      agyProviderId: 'provider-agy',
      agyResourceId: 'resource-agy',
      productAdapter: adapter,
      worktreeRoot: path.join(root, 'worktrees'),
    });

    const spec = {
      taskId: fixture.task.id,
      workerId: 'agy-01',
      objective: 'unauthorized product task',
      baseSha: BASE_SHA,
      branch: `agent/agy-01/${fixture.task.id}`,
      worktree: path.join(root, 'worktrees', fixture.task.id),
      allowedPaths: ['src'],
      acceptanceCriteria: ['unauthorized product task fails closed'],
      requiredTests: ['node --version'],
    };
    fs.mkdirSync(spec.worktree, { recursive: true });

    const result = await supervisor.run(spec);
    expect(result.accepted).toBeFalsy();
    expect(result.state).toBe('BLOCKED');
    expect(result.error).toContain('PRODUCT_TASK_REQUIRES_EXECUTION_AUTHORIZATION');
    expect(store.listAll()).toHaveLength(0);
  });

  it('fails closed if concurrency is increased before the product proof gate is lifted', () => {
    expect(() => new ProductTaskAutonomyAdapter({
      repo,
      artifactStore: new ArtifactStore(path.join(root, 'other-artifacts')),
      maxWorkers: MAX_AGY_WORKERS + 1,
    })).toThrow(/PRODUCT_TASK_CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS/);
  });

  it('fails closed before verification or review if independently collected changedFiles include paths outside allowed_paths', async () => {
    const fixture = seed('task-out-of-scope-edit', true, { allowedPaths: ['src/core'] });
    const input = workOrderInput(fixture);
    let verificationCalled = false;
    let reviewCalled = false;

    const result = await adapter.executeProductTask({
      ...input,
      allowedPaths: ['src/core'],
      runCoder: async () => ({ success: true, currentHeadSha: BASE_SHA }),
      evidenceCollector: {
        collect: async () => ({
          headSha: BASE_SHA,
          snapshotSha: 'snapshot-out-of-scope',
          status: 'M package.json',
          changedFiles: ['src/core/valid.ts', 'package.json'],
          diff: 'diff-out-of-scope',
          tests: [],
        }),
      },
      runVerification: async () => {
        verificationCalled = true;
        throw new Error('runVerification must not be called on out-of-scope edit');
      },
      conductReview: async () => {
        reviewCalled = true;
        throw new Error('conductReview must not be called on out-of-scope edit');
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('WORKER_PATH_VIOLATION');
    expect(verificationCalled).toBe(false);
    expect(reviewCalled).toBe(false);
    expect(result.leaseReleased).toBe(true);
    expect(repo.getTask(fixture.task.id)?.state).not.toBe('DONE');
  });

  it('fails closed before verification or review if independently collected changedFiles include paths inside forbidden_paths', async () => {
    const fixture = seed('task-forbidden-edit', true, { forbiddenPaths: ['.git', 'src/forbidden'] });
    const input = workOrderInput(fixture);
    let verificationCalled = false;
    let reviewCalled = false;

    const result = await adapter.executeProductTask({
      ...input,
      allowedPaths: ['src'],
      forbiddenPaths: ['.git', 'src/forbidden'],
      runCoder: async () => ({ success: true, currentHeadSha: BASE_SHA }),
      evidenceCollector: {
        collect: async () => ({
          headSha: BASE_SHA,
          snapshotSha: 'snapshot-forbidden',
          status: 'M src/forbidden/secret.ts',
          changedFiles: ['src/forbidden/secret.ts'],
          diff: 'diff-forbidden',
          tests: [],
        }),
      },
      runVerification: async () => {
        verificationCalled = true;
        throw new Error('runVerification must not be called on forbidden edit');
      },
      conductReview: async () => {
        reviewCalled = true;
        throw new Error('conductReview must not be called on forbidden edit');
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('WORKER_PATH_VIOLATION');
    expect(verificationCalled).toBe(false);
    expect(reviewCalled).toBe(false);
    expect(result.leaseReleased).toBe(true);
    expect(repo.getTask(fixture.task.id)?.state).not.toBe('DONE');
  });

  it('transitions stale post-review HEAD or snapshot to durable CODING repair state and proves task is resumable and not wedged', async () => {
    const fixture = seed('task-stale-resumption');
    const input = workOrderInput(fixture);
    let collectCount = 0;

    // First attempt: stale review due to working-tree snapshot modification post-review
    const initialResult = await adapter.executeProductTask({
      ...input,
      runCoder: async () => ({ success: true, currentHeadSha: BASE_SHA }),
      evidenceCollector: {
        collect: async () => {
          collectCount++;
          return {
            headSha: BASE_SHA,
            snapshotSha: collectCount === 1 ? 'snapshot-pre-review' : 'snapshot-post-review-MODIFIED',
            status: '',
            changedFiles: ['src'],
            diff: 'diff-initial',
            tests: [],
          };
        },
      },
      runVerification: async (authority, workOrder) => adapter.recordVerificationObservation({
        projectId: authority.task.project_id,
        taskId: authority.task.id,
        attemptId: authority.authorization.attempt_id,
        command: 'node --version',
        status: 'COMPLETED',
        exitCode: 0,
        passedCount: 1,
        failedCount: 0,
        durationMs: 1,
        stdout: process.version,
        workingDirectory: workOrder!.worktree,
      }),
      conductReview: async (context) => ({
        protocol_version: 'managerreview.v1',
        verdict: 'PASS',
        reviewed_head_sha: context.current_head,
        findings: [],
        required_actions: [],
        risk: 'LOW',
        notes: 'initial review passes but snapshot becomes stale',
      }),
    });

    // Verify first attempt fails closed into durable resumable repair state
    expect(initialResult.success).toBe(false);
    expect(initialResult.staleReview).toBe(true);
    expect(initialResult.error).toContain('WORKING_TREE_SNAPSHOT_FENCING_VIOLATION');
    expect(initialResult.finalTaskState).toBe('CODING');
    expect(initialResult.leaseReleased).toBe(true);

    // Verify task state in database
    const taskAfterStale = repo.getTask(fixture.task.id)!;
    expect(taskAfterStale.state).toBe('CODING');
    expect(taskAfterStale.revision_count).toBe(1);

    // Prove authorization fencing: stale revision 0 authorization cannot be reused
    const staleAuthValidation = adapter.validateAuthority({
      authorizationId: fixture.authorization.id,
      currentHeadSha: BASE_SHA,
    });
    expect(staleAuthValidation.valid).toBe(false);
    expect(staleAuthValidation.code).toBe('TASK_REVISION_MISMATCH');

    // Create durable execution authorization for revision 1
    const now = new Date().toISOString();
    const retryContext = new ContextBuilderService(repo).buildContextSnapshot({
      projectId: fixture.task.project_id,
      taskId: fixture.task.id,
      assignmentId: fixture.assignmentId,
      purpose: 'EXECUTION',
      includeProjectMemory: false,
      includeTaskMemory: false,
      includeLatestCheckpoint: false,
      includeLatestHandoff: false,
    });
    const retryPayload: CanonicalExecutionPayload = {
      projectId: fixture.task.project_id,
      taskId: fixture.task.id,
      attemptId: null,
      taskTitle: fixture.task.title,
      taskDescription: fixture.task.description,
      acceptanceCriteria: fixture.task.acceptance_criteria,
      constraints: fixture.task.constraints,
      instructions: ['Resumed repair execution'],
      contextFiles: [],
      verificationCommands: {
        TEST: { executable: process.execPath, args: ['--version'] },
        LINT: null,
        BUILD: null,
      },
      managerMessageId: `manager-retry-${fixture.task.id}`,
      managerPayloadHash: crypto.createHash('sha256').update(`retry-${fixture.task.id}`).digest('hex'),
      executionScope: {
        branch: `agent/agy-01/${fixture.task.id}`,
        worktree: path.join(root, 'worktrees', fixture.task.id),
        allowedPaths: ['src'],
        forbiddenPaths: ['.git'],
      },
    };
    repo.recordProtocolMessage(
      retryPayload.managerMessageId,
      `external-${retryPayload.managerMessageId}`,
      'manager.v1',
      fixture.task.project_id,
      fixture.task.id,
      'CODING',
      1,
      retryPayload.managerPayloadHash,
      JSON.stringify({ decision: 'EXECUTE', taskId: fixture.task.id }),
      'APPLIED',
    );
    const retryAuthId = `authorization-${fixture.task.id}-rev1`;
    repo.createExecutionAuthorization({
      id: retryAuthId,
      project_id: fixture.task.project_id,
      task_id: fixture.task.id,
      attempt_id: null,
      task_revision: 1,
      base_sha: BASE_SHA,
      repository_head_sha: BASE_SHA,
      manager_message_id: retryPayload.managerMessageId,
      manager_payload_hash: retryPayload.managerPayloadHash,
      routing_decision_id: `route-retry-${fixture.task.id}`,
      selected_account_id: 'account-agy',
      selected_resource_id: 'resource-agy',
      selected_provider_id: 'provider-agy',
      instruction_payload_hash: computePayloadHash(retryPayload),
      context_manifest_hash: retryContext.manifest.manifest_hash,
      canonical_instructions_json: JSON.stringify(retryPayload.instructions),
      context_files_json: '[]',
      canonical_payload_json: JSON.stringify(retryPayload),
      expected_task_revision: 1,
      status: 'AUTHORIZED',
      created_at: now,
      dispatched_at: null,
      task_ownership_epoch: 1,
      assignment_id: fixture.assignmentId,
      lifecycle_version: 1,
    });

    // Second attempt: Resumption from CODING succeeds end-to-end and proves task is NOT wedged
    const retryResult = await adapter.executeProductTask({
      ...input,
      authorizationId: retryAuthId,
      runCoder: async () => ({ success: true, currentHeadSha: BASE_SHA }),
      evidenceCollector: {
        collect: async () => ({
          headSha: BASE_SHA,
          snapshotSha: 'snapshot-retry-clean',
          status: '',
          changedFiles: ['src'],
          diff: 'diff-retry',
          tests: [],
        }),
      },
      runVerification: async (authority, workOrder) => adapter.recordVerificationObservation({
        projectId: authority.task.project_id,
        taskId: authority.task.id,
        attemptId: authority.authorization.attempt_id,
        command: 'node --version',
        status: 'COMPLETED',
        exitCode: 0,
        passedCount: 1,
        failedCount: 0,
        durationMs: 1,
        stdout: process.version,
        workingDirectory: workOrder!.worktree,
      }),
      conductReview: async (context) => ({
        protocol_version: 'managerreview.v1',
        verdict: 'PASS',
        reviewed_head_sha: context.current_head,
        findings: [],
        required_actions: [],
        risk: 'LOW',
        notes: 'retry passes review and fresh snapshot check',
      }),
    });

    expect(retryResult.success).toBe(true);
    expect(retryResult.finalTaskState).toBe('DONE');
    expect(retryResult.leaseAcquired).toBe(true);
    expect(retryResult.leaseReleased).toBe(true);
    expect(repo.getTask(fixture.task.id)?.state).toBe('DONE');
    expect(repo.getWorkerSlot(fixture.slotId)?.status).toBe('IDLE');
  });

  it('preserves ownership epoch fencing when task ownership epoch changes during stale review handling', async () => {
    const fixture = seed('task-epoch-fence-stale');
    const input = workOrderInput(fixture);
    let collectCount = 0;

    const result = await adapter.executeProductTask({
      ...input,
      runCoder: async () => ({ success: true, currentHeadSha: BASE_SHA }),
      evidenceCollector: {
        collect: async () => {
          collectCount++;
          return {
            headSha: collectCount === 1 ? BASE_SHA : OTHER_SHA,
            snapshotSha: 'snapshot-fixed',
            status: '',
            changedFiles: ['src'],
            diff: 'diff',
            tests: [],
          };
        },
      },
      runVerification: async (authority, workOrder) => adapter.recordVerificationObservation({
        projectId: authority.task.project_id,
        taskId: authority.task.id,
        attemptId: authority.authorization.attempt_id,
        command: 'node --version',
        status: 'COMPLETED',
        exitCode: 0,
        passedCount: 1,
        failedCount: 0,
        durationMs: 1,
        stdout: process.version,
        workingDirectory: workOrder!.worktree,
      }),
      conductReview: async (context) => {
        // Reassign task / bump ownership epoch while review is taking place
        repo.bumpTaskOwnershipEpoch(fixture.task.id, 1);
        return {
          protocol_version: 'managerreview.v1',
          verdict: 'PASS',
          reviewed_head_sha: context.current_head,
          findings: [],
          required_actions: [],
          risk: 'LOW',
          notes: 'review ok',
        };
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('OWNERSHIP_EPOCH_MISMATCH');
    expect(result.leaseReleased).toBe(true);
  });

  const reviewFailureCases = [
    {
      category: 'capacity',
      error: new Error('ALL_MANAGER_RESOURCES_UNAVAILABLE'),
      expectedSubstring: 'ALL_MANAGER_RESOURCES_UNAVAILABLE',
    },
    {
      category: 'capacity',
      error: new Error('ROUTE_CAPACITY_EXHAUSTED: no manager capacity currently available'),
      expectedSubstring: 'ROUTE_CAPACITY_EXHAUSTED',
    },
    {
      category: 'auth',
      error: new Error('AUTH_ERROR: provider credential invalid or unauthorized'),
      expectedSubstring: 'AUTH_ERROR',
    },
    {
      category: 'rate-limit',
      error: new Error('RATE_LIMITED: 429 too many requests'),
      expectedSubstring: 'RATE_LIMITED',
    },
    {
      category: 'timeout',
      error: new Error('TIMEOUT: manager request timed out after 120000ms'),
      expectedSubstring: 'TIMEOUT',
    },
    {
      category: 'offline',
      error: new Error('OFFLINE: manager endpoint connection refused or process not found'),
      expectedSubstring: 'OFFLINE',
    },
    {
      category: 'contract-invalid',
      error: new Error('CONTRACT_INVALID: malformed review response payload'),
      expectedSubstring: 'CONTRACT_INVALID',
    },
  ];

  for (const { category, error, expectedSubstring } of reviewFailureCases) {
    it(`recovers ${category} review exception (${expectedSubstring}) to CODING, releases lease, and fences stale authority`, async () => {
      const taskId = `task-review-${category}-${crypto.randomBytes(4).toString('hex')}`;
      const fixture = seed(taskId);
      const input = workOrderInput(fixture);

      const result = await adapter.executeProductTask({
        ...input,
        runCoder: async () => ({ success: true, currentHeadSha: BASE_SHA }),
        evidenceCollector: {
          collect: async () => ({
            headSha: BASE_SHA,
            snapshotSha: 'snapshot-fixed',
            status: '',
            changedFiles: ['src'],
            diff: 'diff-clean',
            tests: [],
          }),
        },
        runVerification: async (authority, workOrder) => adapter.recordVerificationObservation({
          projectId: authority.task.project_id,
          taskId: authority.task.id,
          attemptId: authority.authorization.attempt_id,
          command: 'node --version',
          status: 'COMPLETED',
          exitCode: 0,
          passedCount: 1,
          failedCount: 0,
          durationMs: 1,
          stdout: process.version,
          workingDirectory: workOrder!.worktree,
        }),
        conductReview: async () => {
          throw error;
        },
      });

      // 1. Result assertions: never stranded in REVIEWING, never reached DONE
      expect(result.success).toBe(false);
      expect(result.finalTaskState).toBe('CODING');
      expect(result.finalTaskState).not.toBe('REVIEWING');
      expect(result.finalTaskState).not.toBe('DONE');
      expect(result.leaseAcquired).toBe(true);
      expect(result.leaseReleased).toBe(true);
      expect(result.error).toContain(expectedSubstring);

      // 2. Database state assertions
      const updatedTask = repo.getTask(fixture.task.id)!;
      expect(updatedTask.state).toBe('CODING');
      expect(updatedTask.state).not.toBe('REVIEWING');
      expect(updatedTask.state).not.toBe('DONE');
      expect(updatedTask.revision_count).toBe(1);

      const slot = repo.getWorkerSlot(fixture.slotId)!;
      expect(slot.status).toBe('IDLE');

      // 3. Stale authority is fenced by the revision bump
      const staleAuthCheck = adapter.validateAuthority({
        authorizationId: fixture.authorization.id,
        currentHeadSha: BASE_SHA,
      });
      expect(staleAuthCheck.valid).toBe(false);
      expect(staleAuthCheck.code).toBe('TASK_REVISION_MISMATCH');
    });
  }

  it('recovers contract-invalid review object returning malformed contract to CODING, releases lease, and fences stale authority', async () => {
    const fixture = seed('task-review-invalid-contract-obj');
    const input = workOrderInput(fixture);

    const result = await adapter.executeProductTask({
      ...input,
      runCoder: async () => ({ success: true, currentHeadSha: BASE_SHA }),
      evidenceCollector: {
        collect: async () => ({
          headSha: BASE_SHA,
          snapshotSha: 'snapshot-fixed',
          status: '',
          changedFiles: ['src'],
          diff: 'diff-clean',
          tests: [],
        }),
      },
      runVerification: async (authority, workOrder) => adapter.recordVerificationObservation({
        projectId: authority.task.project_id,
        taskId: authority.task.id,
        attemptId: authority.authorization.attempt_id,
        command: 'node --version',
        status: 'COMPLETED',
        exitCode: 0,
        passedCount: 1,
        failedCount: 0,
        durationMs: 1,
        stdout: process.version,
        workingDirectory: workOrder!.worktree,
      }),
      conductReview: async () => ({
        // Missing protocol_version, reviewed_head_sha, etc.
        invalid: true,
      } as any),
    });

    expect(result.success).toBe(false);
    expect(result.finalTaskState).toBe('CODING');
    expect(result.finalTaskState).not.toBe('REVIEWING');
    expect(result.finalTaskState).not.toBe('DONE');
    expect(result.leaseAcquired).toBe(true);
    expect(result.leaseReleased).toBe(true);
    expect(result.error).toContain('CONTRACT_INVALID');

    const updatedTask = repo.getTask(fixture.task.id)!;
    expect(updatedTask.state).toBe('CODING');
    expect(updatedTask.state).not.toBe('DONE');
    expect(updatedTask.revision_count).toBe(1);
    expect(repo.getWorkerSlot(fixture.slotId)?.status).toBe('IDLE');

    const staleAuthCheck = adapter.validateAuthority({
      authorizationId: fixture.authorization.id,
      currentHeadSha: BASE_SHA,
    });
    expect(staleAuthCheck.valid).toBe(false);
    expect(staleAuthCheck.code).toBe('TASK_REVISION_MISMATCH');
  });

  it('preserves ownership epoch fencing when task ownership epoch changes during manager review exception recovery', async () => {
    const fixture = seed('task-epoch-fence-review-ex');
    const input = workOrderInput(fixture);

    const result = await adapter.executeProductTask({
      ...input,
      runCoder: async () => ({ success: true, currentHeadSha: BASE_SHA }),
      evidenceCollector: {
        collect: async () => ({
          headSha: BASE_SHA,
          snapshotSha: 'snapshot-fixed',
          status: '',
          changedFiles: ['src'],
          diff: 'diff-clean',
          tests: [],
        }),
      },
      runVerification: async (authority, workOrder) => adapter.recordVerificationObservation({
        projectId: authority.task.project_id,
        taskId: authority.task.id,
        attemptId: authority.authorization.attempt_id,
        command: 'node --version',
        status: 'COMPLETED',
        exitCode: 0,
        passedCount: 1,
        failedCount: 0,
        durationMs: 1,
        stdout: process.version,
        workingDirectory: workOrder!.worktree,
      }),
      conductReview: async () => {
        // Task reassignment bumps epoch while manager review fails
        repo.bumpTaskOwnershipEpoch(fixture.task.id, 1);
        throw new Error('ALL_MANAGER_RESOURCES_UNAVAILABLE');
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('OWNERSHIP_EPOCH_MISMATCH');
    expect(result.leaseReleased).toBe(true);

    // Database task epoch is 2, and revision was NOT mutated by stale worker
    const taskInDb = repo.getTask(fixture.task.id)!;
    expect(taskInDb.ownership_epoch).toBe(2);
    expect(taskInDb.revision_count).toBe(0);
    expect(repo.getWorkerSlot(fixture.slotId)?.status).toBe('IDLE');
  });

  it('proves a subsequent reauthorized retry can complete end-to-end after a manager review outage while preserving exact-head and verification gates', async () => {
    const fixture = seed('task-review-outage-retry');
    const input = workOrderInput(fixture);

    // --- Attempt 1: Manager capacity outage occurs during review ---
    const initialResult = await adapter.executeProductTask({
      ...input,
      runCoder: async () => ({ success: true, currentHeadSha: BASE_SHA }),
      evidenceCollector: {
        collect: async () => ({
          headSha: BASE_SHA,
          snapshotSha: 'snapshot-initial',
          status: '',
          changedFiles: ['src'],
          diff: 'diff-clean',
          tests: [],
        }),
      },
      runVerification: async (authority, workOrder) => adapter.recordVerificationObservation({
        projectId: authority.task.project_id,
        taskId: authority.task.id,
        attemptId: authority.authorization.attempt_id,
        command: 'node --version',
        status: 'COMPLETED',
        exitCode: 0,
        passedCount: 1,
        failedCount: 0,
        durationMs: 1,
        stdout: process.version,
        workingDirectory: workOrder!.worktree,
      }),
      conductReview: async () => {
        throw new Error('ALL_MANAGER_RESOURCES_UNAVAILABLE');
      },
    });

    expect(initialResult.success).toBe(false);
    expect(initialResult.finalTaskState).toBe('CODING');
    expect(initialResult.finalTaskState).not.toBe('REVIEWING');
    expect(initialResult.finalTaskState).not.toBe('DONE');
    expect(initialResult.leaseReleased).toBe(true);
    expect(initialResult.error).toContain('ALL_MANAGER_RESOURCES_UNAVAILABLE');

    const taskAfterOutage = repo.getTask(fixture.task.id)!;
    expect(taskAfterOutage.state).toBe('CODING');
    expect(taskAfterOutage.revision_count).toBe(1);
    expect(repo.getWorkerSlot(fixture.slotId)?.status).toBe('IDLE');

    // Prove stale authority is fenced
    const staleValidation = adapter.validateAuthority({
      authorizationId: fixture.authorization.id,
      currentHeadSha: BASE_SHA,
    });
    expect(staleValidation.valid).toBe(false);
    expect(staleValidation.code).toBe('TASK_REVISION_MISMATCH');

    // Create durable reauthorized execution authorization for revision 1
    const retryAuthId = createRetryAuthorization(fixture, 1);

    // --- Gate verification 1: Exact-head gate still applies on retry ---
    const headMismatchResult = await adapter.executeProductTask({
      ...input,
      authorizationId: retryAuthId,
      runCoder: async () => ({ success: true, currentHeadSha: OTHER_SHA }),
      evidenceCollector: {
        collect: async () => ({
          headSha: BASE_SHA,
          snapshotSha: 'snapshot-retry',
          status: '',
          changedFiles: ['src'],
          diff: 'diff-retry',
          tests: [],
        }),
      },
      runVerification: async () => { throw new Error('should not reach verification'); },
      conductReview: async () => { throw new Error('should not reach review'); },
    });
    expect(headMismatchResult.success).toBe(false);
    expect(headMismatchResult.error).toContain('CODER_HEAD_MISMATCH');
    expect(headMismatchResult.leaseReleased).toBe(true);

    // --- Gate verification 2: Current-verification lineage gate still applies on retry ---
    const verifFailResult = await adapter.executeProductTask({
      ...input,
      authorizationId: retryAuthId,
      runCoder: async () => ({ success: true, currentHeadSha: BASE_SHA }),
      evidenceCollector: {
        collect: async () => ({
          headSha: BASE_SHA,
          snapshotSha: 'snapshot-retry',
          status: '',
          changedFiles: ['src'],
          diff: 'diff-retry',
          tests: [],
        }),
      },
      runVerification: async (authority, workOrder) => adapter.recordVerificationObservation({
        projectId: authority.task.project_id,
        taskId: authority.task.id,
        attemptId: authority.authorization.attempt_id,
        command: 'node --version',
        status: 'FAILED',
        exitCode: 1,
        passedCount: 0,
        failedCount: 1,
        durationMs: 1,
        stdout: '',
        stderr: 'test failed',
        workingDirectory: workOrder!.worktree,
      }),
      conductReview: async () => { throw new Error('should not reach review'); },
    });
    expect(verifFailResult.success).toBe(false);
    expect(verifFailResult.error).toBe('VERIFICATION_FAILED');
    expect(verifFailResult.leaseReleased).toBe(true);

    // The failed current verification incremented the authoritative task revision,
    // so the next attempt must use a fresh authorization for that exact revision.
    expect(repo.getTask(fixture.task.id)?.revision_count).toBe(2);
    const finalRetryAuthId = createRetryAuthorization(fixture, 2);

    // --- Attempt 2: Reauthorized retry with passing verification and restored manager completes to DONE ---
    const retrySuccessResult = await adapter.executeProductTask({
      ...input,
      authorizationId: finalRetryAuthId,
      runCoder: async () => ({ success: true, currentHeadSha: BASE_SHA }),
      evidenceCollector: {
        collect: async () => ({
          headSha: BASE_SHA,
          snapshotSha: 'snapshot-retry-success',
          status: '',
          changedFiles: ['src'],
          diff: 'diff-retry-success',
          tests: [],
        }),
      },
      runVerification: async (authority, workOrder) => adapter.recordVerificationObservation({
        projectId: authority.task.project_id,
        taskId: authority.task.id,
        attemptId: authority.authorization.attempt_id,
        command: 'node --version',
        status: 'COMPLETED',
        exitCode: 0,
        passedCount: 1,
        failedCount: 0,
        durationMs: 1,
        stdout: process.version,
        workingDirectory: workOrder!.worktree,
      }),
      conductReview: async (context) => ({
        protocol_version: 'managerreview.v1',
        verdict: 'PASS',
        reviewed_head_sha: context.current_head,
        findings: [],
        required_actions: [],
        risk: 'LOW',
        notes: 'reauthorized retry passed after manager outage recovered',
      }),
    });

    expect(retrySuccessResult.success).toBe(true);
    expect(retrySuccessResult.finalTaskState).toBe('DONE');
    expect(retrySuccessResult.leaseAcquired).toBe(true);
    expect(retrySuccessResult.leaseReleased).toBe(true);
    expect(repo.getTask(fixture.task.id)?.state).toBe('DONE');
    expect(repo.getWorkerSlot(fixture.slotId)?.status).toBe('IDLE');
  });

  it('operational supervisor handles manager review outage on product task, leaves task in CODING and releases slot', async () => {
    const fixture = seed('task-op-review-outage');
    const supervisor = new AutonomySupervisor({
      store,
      agyProviderId: 'provider-agy',
      agyResourceId: 'resource-agy',
      productAdapter: adapter,
      worktreeRoot: path.join(root, 'worktrees'),
      evidence: {
        collect: async () => ({
          headSha: BASE_SHA,
          snapshotSha: 'snapshot-op-outage',
          status: '',
          changedFiles: ['src'],
          diff: 'diff-op-outage',
          tests: [{ command: 'node --version', exitCode: 0, stdout: 'v22.0.0', stderr: '', durationMs: 1 }],
        }),
      },
      agy: {
        execute: async () => ({
          status: 'SUCCESSFUL_PROCESS_EXIT' as const,
          exitCode: 0,
          executionId: 'exec-op-outage',
          stdout: '',
          stderr: '',
          durationMs: 1,
        }),
      } as any,
      managerPool: {
        review: async () => ({
          run: {
            status: 'QUOTA_OR_RATE_LIMIT' as const,
            exitCode: 1,
            executionId: '',
            stdout: '',
            stderr: 'ALL_MANAGER_RESOURCES_UNAVAILABLE',
            durationMs: 0,
          },
          resource_id: 'none',
          context_sha: 'sha-outage',
          attempts: ['primary'],
        }),
      } as any,
    });

    const spec = {
      taskId: fixture.task.id,
      workerId: 'agy-01',
      objective: fixture.task.description ?? fixture.task.title,
      baseSha: BASE_SHA,
      branch: `agent/agy-01/${fixture.task.id}`,
      worktree: path.join(root, 'worktrees', fixture.task.id),
      allowedPaths: ['src'],
      forbiddenPaths: ['.git'],
      acceptanceCriteria: ['product task survives manager review outage'],
      requiredTests: ['node --version'],
    };
    fs.mkdirSync(spec.worktree, { recursive: true });

    const result = await supervisor.run(spec);
    expect(result.accepted).toBe(false);
    expect(result.state).toBe('CODING');
    expect(result.error).toContain('ALL_MANAGER_RESOURCES_UNAVAILABLE');
    expect(repo.getTask(fixture.task.id)?.state).toBe('CODING');
    expect(repo.getTask(fixture.task.id)?.state).not.toBe('REVIEWING');
    expect(repo.getWorkerSlot(fixture.slotId)?.status).toBe('IDLE');
    expect(store.listAll()).toHaveLength(0);
  });
});
