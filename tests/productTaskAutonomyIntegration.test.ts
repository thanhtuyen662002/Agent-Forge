import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextBuilderService } from '../src/core/services/ContextBuilderService';
import {
  CanonicalExecutionPayload,
  computePayloadHash,
} from '../src/core/services/ExecutionAuthorizationService';
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

  function seed(taskId = 'task-product-1'): Fixture {
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
    };
  }

  it('validates task, authorization, routing, epoch, exact head, and ContextManifest as one authority', () => {
    const fixture = seed();
    const result = adapter.validateAuthority(workOrderInput(fixture));
    expect(result.valid).toBe(true);
    expect(result.authority?.task.id).toBe(fixture.task.id);
  });

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
      runVerification: async (authority) => adapter.recordVerificationObservation({
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
        workingDirectory: root,
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

  it('fails closed if concurrency is increased before the product proof gate is lifted', () => {
    expect(() => new ProductTaskAutonomyAdapter({
      repo,
      artifactStore: new ArtifactStore(path.join(root, 'other-artifacts')),
      maxWorkers: MAX_AGY_WORKERS + 1,
    })).toThrow('PRODUCT_TASK_CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS_1');
  });
});
