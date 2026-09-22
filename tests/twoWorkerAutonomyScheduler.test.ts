import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { AutonomyStore } from '../src/core/autonomy/store';
import {
  AutonomySupervisor,
  SupervisorContinuousQueue,
  SupervisorQueueTaskResult,
} from '../src/core/autonomy/supervisor';
import {
  MAX_AGY_WORKERS,
  ProductTaskAutonomyAdapter,
} from '../src/core/autonomy/productTaskAdapter';
import { WorkerSlotLeaseService } from '../src/core/services/WorkerSlotLeaseService';
import { ArtifactStore } from '../src/core/services/ArtifactStore';
import { SelfHostTask, WorkOrder, createWorkOrder } from '../src/core/autonomy/contracts';
import { ContextBuilderService } from '../src/core/services/ContextBuilderService';
import {
  CanonicalExecutionPayload,
  computePayloadHash,
} from '../src/core/services/ExecutionAuthorizationService';
import {
  ExecutionAuthorization,
  ExecutionAuthorizationStatus,
  Task,
  TaskState,
} from '../src/core/types/domain';

describe('Two-Worker Autonomy Scheduler (TSK-TWO-WORKER-ENABLEMENT)', () => {
  let root: string;
  let db: Database.Database;
  let store: AutonomyStore;
  let repo: Repository;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'two-worker-autonomy-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    MigrationRunner.run(db);
    store = new AutonomyStore(db);
    repo = new Repository(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeSelfHostTask(taskId: string): SelfHostTask {
    return {
      task_id: taskId,
      objective: `Objective for ${taskId}`,
      base_sha: 'a'.repeat(40),
      allowed_paths: ['src'],
      required_tests: ['node --version'],
      acceptance_criteria: ['it works'],
      context_files: [],
      constraints: [],
    };
  }

  describe('1. Configured MAX_AGY_WORKERS Bounds', () => {
    it('accepts maxWorkers 1 and 2 for AutonomySupervisor', () => {
      const supervisor1 = new AutonomySupervisor({ store, maxWorkers: 1 });
      expect(supervisor1.maxWorkers).toBe(1);
      const supervisor2 = new AutonomySupervisor({ store, maxWorkers: 2 });
      expect(supervisor2.maxWorkers).toBe(2);
    });

    it('fails closed when maxWorkers is below 1, above 2, or non-integer for AutonomySupervisor', () => {
      expect(() => new AutonomySupervisor({ store, maxWorkers: 0 }))
        .toThrow(/CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS/);
      expect(() => new AutonomySupervisor({ store, maxWorkers: -1 }))
        .toThrow(/CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS/);
      expect(() => new AutonomySupervisor({ store, maxWorkers: 3 }))
        .toThrow(/CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS/);
      expect(() => new AutonomySupervisor({ store, maxWorkers: 1.5 }))
        .toThrow(/CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS/);
      expect(() => new AutonomySupervisor({ store, maxWorkers: NaN }))
        .toThrow(/CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS/);
    });

    it('fails closed when process.env.MAX_AGY_WORKERS is out of bounds or non-integer', () => {
      const prev = process.env.MAX_AGY_WORKERS;
      try {
        process.env.MAX_AGY_WORKERS = '0';
        expect(() => new AutonomySupervisor({ store }))
          .toThrow(/CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS/);

        process.env.MAX_AGY_WORKERS = '3';
        expect(() => new AutonomySupervisor({ store }))
          .toThrow(/CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS/);

        process.env.MAX_AGY_WORKERS = '1.5';
        expect(() => new AutonomySupervisor({ store }))
          .toThrow(/CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS/);

        process.env.MAX_AGY_WORKERS = 'invalid';
        expect(() => new AutonomySupervisor({ store }))
          .toThrow(/CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS/);

        process.env.MAX_AGY_WORKERS = '1';
        const sup1 = new AutonomySupervisor({ store });
        expect(sup1.maxWorkers).toBe(1);

        process.env.MAX_AGY_WORKERS = '2';
        const sup2 = new AutonomySupervisor({ store });
        expect(sup2.maxWorkers).toBe(2);
      } finally {
        if (prev !== undefined) {
          process.env.MAX_AGY_WORKERS = prev;
        } else {
          delete process.env.MAX_AGY_WORKERS;
        }
      }
    });

    it('accepts maxWorkers 1 and 2 for ProductTaskAutonomyAdapter and rejects values below 1 or above 2', () => {
      const adapter1 = new ProductTaskAutonomyAdapter({
        repo,
        artifactStore: new ArtifactStore(path.join(root, 'artifacts')),
        maxWorkers: 1,
      });
      expect(adapter1.maxWorkers).toBe(1);

      const adapter2 = new ProductTaskAutonomyAdapter({
        repo,
        artifactStore: new ArtifactStore(path.join(root, 'artifacts')),
        maxWorkers: 2,
      });
      expect(adapter2.maxWorkers).toBe(2);

      expect(() => new ProductTaskAutonomyAdapter({
        repo,
        artifactStore: new ArtifactStore(path.join(root, 'artifacts')),
        maxWorkers: 0,
      })).toThrow(/PRODUCT_TASK_CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS/);

      expect(() => new ProductTaskAutonomyAdapter({
        repo,
        artifactStore: new ArtifactStore(path.join(root, 'artifacts')),
        maxWorkers: 3,
      })).toThrow(/PRODUCT_TASK_CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS/);

      expect(() => new ProductTaskAutonomyAdapter({
        repo,
        artifactStore: new ArtifactStore(path.join(root, 'artifacts')),
        maxWorkers: 1.5,
      })).toThrow(/PRODUCT_TASK_CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS/);

      expect(() => new ProductTaskAutonomyAdapter({
        repo,
        artifactStore: new ArtifactStore(path.join(root, 'artifacts')),
        maxWorkers: MAX_AGY_WORKERS + 1,
      })).toThrow(/PRODUCT_TASK_CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS/);
    });
  });

  describe('2. ProductTaskAutonomyAdapter Two-Worker Capacity and Denied Third Assignment', () => {
    function seedProductEnvironment() {
      const now = new Date().toISOString();
      const projectId = 'proj-sched';
      repo.createProject({
        id: projectId,
        name: 'Scheduler project',
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
      repo.createProvider({ id: 'prov-agy', name: 'Antigravity', adapter_type: 'LOCAL_CLI', enabled: true, created_at: now });
      repo.createProviderAccount({
        id: 'acc-agy',
        provider_id: 'prov-agy',
        label: 'AGY account',
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
        id: 'res-agy',
        provider_id: 'prov-agy',
        provider_account_id: 'acc-agy',
        model_name: 'agy-model',
        health_status: 'AVAILABLE',
        capabilities: ['CODING'],
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
        id: 'role-c',
        role: 'CODER',
        display_name: 'Coder',
        required_capabilities: ['CODING'],
        preferred_capabilities: [],
        authority_scope: null,
        permissions: [],
        output_protocol: 'coder.v1',
        enabled: true,
        created_at: now,
        updated_at: now,
      });

      for (let i = 1; i <= 3; i++) {
        const taskId = `task-p${i}`;
        repo.createTask({
          id: taskId,
          project_id: projectId,
          milestone_id: null,
          title: `Task ${i}`,
          description: `Task ${i} desc`,
          state: 'APPROVED',
          paused_from_state: null,
          priority: 'HIGH',
          risk: 'MEDIUM',
          assigned_agent_id: null,
          revision_count: 0,
          max_revisions: 3,
          base_sha: 'b'.repeat(40),
          current_sha: 'b'.repeat(40),
          progress_cache_percent: 0,
          progress_computed_at: null,
          acceptance_criteria: ['done'],
          constraints: [],
          ownership_epoch: 1,
          created_at: now,
          updated_at: now,
        });

        repo.createAgentAssignment({
          id: `asg-${i}`,
          project_id: projectId,
          task_id: taskId,
          attempt_id: null,
          role_profile_id: 'role-c',
          agent_profile_id: null,
          selected_provider_id: 'prov-agy',
          selected_account_id: 'acc-agy',
          selected_resource_id: 'res-agy',
          selected_worker_slot_id: null,
          routing_decision_id: null,
          preferred_metadata: null,
          status: 'ASSIGNED',
          created_at: now,
          ended_at: null,
        });

        repo.createWorkerSlot({
          id: `slot-p${i}`,
          provider_account_id: 'acc-agy',
          provider_resource_id: 'res-agy',
          slot_index: i,
          status: 'IDLE',
          current_assignment_id: null,
          current_execution_id: null,
          heartbeat_at: null,
          created_at: now,
          updated_at: now,
        });
      }
    }

    it('accepts maxWorkers=2, leases two active assignments, and denies a third active assignment without weakening durable leases', () => {
      seedProductEnvironment();
      const leaseService = new WorkerSlotLeaseService(repo);
      const adapter = new ProductTaskAutonomyAdapter({
        repo,
        leaseService,
        artifactStore: new ArtifactStore(path.join(root, 'artifacts')),
        maxWorkers: 2,
      });

      // 1. First assignment acquires slot lease successfully
      const first = adapter.acquireWorkerSlotLease('asg-1');
      expect(first.status).toBe('ACQUIRED');

      // 2. Second assignment acquires slot lease successfully
      const second = adapter.acquireWorkerSlotLease('asg-2');
      expect(second.status).toBe('ACQUIRED');

      // 3. Third assignment is denied because maxWorkers=2 is reached
      const third = adapter.acquireWorkerSlotLease('asg-3');
      if (third.status !== 'FAILED') {
        throw new Error(`Expected third assignment to fail, received status "${third.status}"`);
      }
      expect(third.status).toBe('FAILED');
      expect(third.code).toBe('ACCOUNT_CAPACITY_EXHAUSTED');
      expect(third.error).toContain('MAX_WORKERS_EXCEEDED');

      // 4. Verify durable product leases are intact and not weakened
      const activeSlots = repo.getAllWorkerSlots().filter((s) => s.status === 'LEASED' || s.status === 'RUNNING');
      expect(activeSlots).toHaveLength(2);
      expect(activeSlots.map((s) => s.current_assignment_id).sort()).toEqual(['asg-1', 'asg-2']);

      // 5. Releasing one lease allows the third assignment to acquire capacity
      if (first.status === 'ACQUIRED') {
        const released = adapter.releaseWorkerSlotLease(first.lease.id, first.lease.lease_token);
        expect(released.status).toBe('RELEASED');
      }

      const thirdRetry = adapter.acquireWorkerSlotLease('asg-3');
      expect(thirdRetry.status).toBe('ACQUIRED');

      // Clean up remaining
      if (second.status === 'ACQUIRED') {
        adapter.releaseWorkerSlotLease(second.lease.id, second.lease.lease_token);
      }
      if (thirdRetry.status === 'ACQUIRED') {
        adapter.releaseWorkerSlotLease(thirdRetry.lease.id, thirdRetry.lease.lease_token);
      }
    });
  });

  describe('3. Continuous Supervisor Queue: Concurrent Tasks and Distinct Worker Identities', () => {
    it('dispatches up to maxWorkers simultaneous tasks with distinct worker identities and no concurrent identity reuse', async () => {
      const supervisor = new AutonomySupervisor({ store, maxWorkers: 2 });
      store.enqueue(makeSelfHostTask('task-conc-1'));
      store.enqueue(makeSelfHostTask('task-conc-2'));

      let resolveTask1!: (res: SupervisorQueueTaskResult) => void;
      const task1Promise = new Promise<SupervisorQueueTaskResult>((r) => { resolveTask1 = r; });

      let resolveTask2!: (res: SupervisorQueueTaskResult) => void;
      const task2Promise = new Promise<SupervisorQueueTaskResult>((r) => { resolveTask2 = r; });

      const dispatchedWorkers: Record<string, string> = {};

      const queue = supervisor.createContinuousQueue({
        dispatchTask: async (task, workerId) => {
          dispatchedWorkers[task.task_id] = workerId;
          if (task.task_id === 'task-conc-1') return task1Deferred();
          if (task.task_id === 'task-conc-2') return task2Deferred();
          return { accepted: true, state: 'LOCAL_VERIFY' };
        },
      });

      function task1Deferred() { return task1Promise; }
      function task2Deferred() { return task2Promise; }

      // Step 1: Dispatches task-conc-1
      const step1 = await queue.step();
      expect(step1.dispatched).toBe('task-conc-1');
      expect(step1.workerId).toBe('agy-01');
      expect(queue.getActiveTaskCount()).toBe(1);

      // Step 2: Dispatches task-conc-2 simultaneously
      const step2 = await queue.step();
      expect(step2.dispatched).toBe('task-conc-2');
      expect(step2.workerId).toBe('agy-02');
      expect(queue.getActiveTaskCount()).toBe(2);

      // Verify distinct worker identities
      expect(dispatchedWorkers['task-conc-1']).toBe('agy-01');
      expect(dispatchedWorkers['task-conc-2']).toBe('agy-02');
      expect(dispatchedWorkers['task-conc-1']).not.toBe(dispatchedWorkers['task-conc-2']);
      expect(queue.getActiveWorkerIds().sort()).toEqual(['agy-01', 'agy-02']);

      // Settle both tasks
      resolveTask1({ accepted: true, state: 'LOCAL_VERIFY' });
      resolveTask2({ accepted: true, state: 'LOCAL_VERIFY' });
      await queue.waitForAllActive();

      expect(queue.getActiveTaskCount()).toBe(0);
      expect(queue.getActiveWorkerIds()).toHaveLength(0);
    });
  });

  describe('4. Continuous Supervisor Queue: Denied Third Task', () => {
    it('denies a third concurrent dispatch while two workers are active', async () => {
      const supervisor = new AutonomySupervisor({ store, maxWorkers: 2 });
      store.enqueue(makeSelfHostTask('task-deny-1'));
      store.enqueue(makeSelfHostTask('task-deny-2'));
      store.enqueue(makeSelfHostTask('task-deny-3'));

      let resolve1!: (res: SupervisorQueueTaskResult) => void;
      const p1 = new Promise<SupervisorQueueTaskResult>((r) => { resolve1 = r; });
      let resolve2!: (res: SupervisorQueueTaskResult) => void;
      const p2 = new Promise<SupervisorQueueTaskResult>((r) => { resolve2 = r; });

      const queue = supervisor.createContinuousQueue({
        dispatchTask: async (task) => {
          if (task.task_id === 'task-deny-1') return p1;
          if (task.task_id === 'task-deny-2') return p2;
          return { accepted: true, state: 'LOCAL_VERIFY' };
        },
      });

      // Dispatch 1 and 2
      await queue.step();
      await queue.step();
      expect(queue.getActiveTaskCount()).toBe(2);

      // Step 3: third task must be denied / held because maxWorkers=2 is reached
      const step3 = await queue.step();
      expect(step3.dispatched).toBeNull();
      expect(step3.workerId).toBeNull();
      expect(queue.getActiveTaskCount()).toBe(2);
      expect(queue.getActiveTaskIds().sort()).toEqual(['task-deny-1', 'task-deny-2']);

      // Clean up
      resolve1({ accepted: true, state: 'LOCAL_VERIFY' });
      resolve2({ accepted: true, state: 'LOCAL_VERIFY' });
      await queue.waitForAllActive();
    });
  });

  describe('5. Continuous Supervisor Queue: Independent Settlement and Capacity Release', () => {
    it('frees only its own implementation capacity on settlement without awaiting unrelated work or CI', async () => {
      const supervisor = new AutonomySupervisor({ store, maxWorkers: 2 });
      store.enqueue(makeSelfHostTask('task-settle-1'));
      store.enqueue(makeSelfHostTask('task-settle-2'));
      store.enqueue(makeSelfHostTask('task-settle-3'));

      let resolve1!: (res: SupervisorQueueTaskResult) => void;
      const p1 = new Promise<SupervisorQueueTaskResult>((r) => { resolve1 = r; });
      let resolve2!: (res: SupervisorQueueTaskResult) => void;
      const p2 = new Promise<SupervisorQueueTaskResult>((r) => { resolve2 = r; });
      let resolve3!: (res: SupervisorQueueTaskResult) => void;
      const p3 = new Promise<SupervisorQueueTaskResult>((r) => { resolve3 = r; });

      const dispatchedWorkers: Record<string, string> = {};

      const queue = supervisor.createContinuousQueue({
        dispatchTask: async (task, workerId) => {
          dispatchedWorkers[task.task_id] = workerId;
          if (task.task_id === 'task-settle-1') return p1;
          if (task.task_id === 'task-settle-2') return p2;
          if (task.task_id === 'task-settle-3') return p3;
          return { accepted: true, state: 'LOCAL_VERIFY' };
        },
      });

      // Dispatch 1 (agy-01) and 2 (agy-02)
      await queue.step();
      await queue.step();
      expect(queue.getActiveTaskCount()).toBe(2);
      expect(dispatchedWorkers['task-settle-1']).toBe('agy-01');
      expect(dispatchedWorkers['task-settle-2']).toBe('agy-02');

      // Settle task 1 only; task 2 is still running
      resolve1({ accepted: true, state: 'LOCAL_VERIFY' });
      await new Promise((resolve) => setImmediate(resolve));

      // Task 1 settlement frees only agy-01; task 2 remains active on agy-02
      expect(queue.getActiveTaskCount()).toBe(1);
      expect(queue.getActiveTaskIds()).toEqual(['task-settle-2']);
      expect(queue.getActiveWorkerIds()).toEqual(['agy-02']);

      // Now dispatch task 3: it receives the newly freed agy-01 while task 2 is still in flight
      const step3 = await queue.step();
      expect(step3.dispatched).toBe('task-settle-3');
      expect(step3.workerId).toBe('agy-01');
      expect(queue.getActiveTaskCount()).toBe(2);
      expect(queue.getActiveTaskIds().sort()).toEqual(['task-settle-2', 'task-settle-3']);
      expect(queue.getActiveWorkerIds().sort()).toEqual(['agy-01', 'agy-02']);

      // Settle remaining tasks
      resolve2({ accepted: true, state: 'LOCAL_VERIFY' });
      resolve3({ accepted: true, state: 'LOCAL_VERIFY' });
      await queue.waitForAllActive();
      expect(queue.getActiveTaskCount()).toBe(0);
    });

    it('frees implementation capacity when a task enters CI_WAIT via markCiWait', () => {
      const supervisor = new AutonomySupervisor({ store, maxWorkers: 2 });
      const wo1 = store.createWorkOrder(createWorkOrder({
        taskId: 'ci-wait-task',
        workerId: 'agy-01',
        objective: 'ci wait test',
        baseSha: 'c'.repeat(40),
        branch: 'agent/agy-01/ci-wait',
        worktree: path.join(root, 'worktree-ci'),
        allowedPaths: ['src'],
        acceptanceCriteria: ['done'],
        requiredTests: ['npm test'],
      }));

      const slot = store.acquireSlot(wo1.id, 'agy-01', 1);
      expect(store.listActiveSlots()).toHaveLength(1);
      expect(slot.slotId).toBe('agy-01');

      // markCiWait releases slot immediately
      supervisor.markCiWait(wo1.id, 1);
      expect(store.getWorkOrder(wo1.id)?.state).toBe('CI_WAIT');
      expect(store.listActiveSlots()).toHaveLength(0);
    });
  });

  describe('6. Continuous Supervisor Queue: CI Observation During Active Work', () => {
    it('continues CI observation while either worker is active without blocking on worker completion', async () => {
      const supervisor = new AutonomySupervisor({ store, maxWorkers: 2 });
      store.enqueue(makeSelfHostTask('task-ci-obs-1'));
      store.enqueue(makeSelfHostTask('task-ci-obs-2'));

      let resolve1!: (res: SupervisorQueueTaskResult) => void;
      const p1 = new Promise<SupervisorQueueTaskResult>((r) => { resolve1 = r; });
      let resolve2!: (res: SupervisorQueueTaskResult) => void;
      const p2 = new Promise<SupervisorQueueTaskResult>((r) => { resolve2 = r; });

      let ciPollCount = 0;
      const ciObserver = {
        observeDue: async () => {
          ciPollCount++;
          return [{ watch: { pr_number: 99 }, conclusion: 'SUCCESS', headSha: 'c'.repeat(40), repairTaskId: null }];
        },
      };

      const queue = supervisor.createContinuousQueue({
        ci: ciObserver,
        dispatchTask: async (task) => {
          if (task.task_id === 'task-ci-obs-1') return p1;
          if (task.task_id === 'task-ci-obs-2') return p2;
          return { accepted: true, state: 'LOCAL_VERIFY' };
        },
      });

      // Step 1: Dispatches worker 1, triggers CI observation
      const step1 = await queue.step();
      expect(step1.dispatched).toBe('task-ci-obs-1');
      expect(step1.observations).toHaveLength(1);
      expect(ciPollCount).toBe(1);

      // Step 2: Dispatches worker 2 while worker 1 is active, triggers CI observation
      const step2 = await queue.step();
      expect(step2.dispatched).toBe('task-ci-obs-2');
      expect(step2.observations).toHaveLength(1);
      expect(ciPollCount).toBe(2);

      // Step 3: Both workers active, capacity full, CI observation still executes
      const step3 = await queue.step();
      expect(step3.dispatched).toBeNull();
      expect(step3.observations).toHaveLength(1);
      expect(ciPollCount).toBe(3);

      // Settle
      resolve1({ accepted: true, state: 'LOCAL_VERIFY' });
      resolve2({ accepted: true, state: 'LOCAL_VERIFY' });
      await queue.waitForAllActive();
    });
  });

  describe('7. Single-Worker Backward Compatibility (MAX_AGY_WORKERS=1)', () => {
    it('preserves single-worker behavior when maxWorkers=1', async () => {
      const supervisor = new AutonomySupervisor({ store, maxWorkers: 1 });
      store.enqueue(makeSelfHostTask('task-single-1'));
      store.enqueue(makeSelfHostTask('task-single-2'));

      let resolve1!: (res: SupervisorQueueTaskResult) => void;
      const p1 = new Promise<SupervisorQueueTaskResult>((r) => { resolve1 = r; });
      let resolve2!: (res: SupervisorQueueTaskResult) => void;
      const p2 = new Promise<SupervisorQueueTaskResult>((r) => { resolve2 = r; });

      const dispatchedWorkers: Record<string, string> = {};

      const queue = supervisor.createContinuousQueue({
        dispatchTask: async (task, workerId) => {
          dispatchedWorkers[task.task_id] = workerId;
          if (task.task_id === 'task-single-1') return p1;
          if (task.task_id === 'task-single-2') return p2;
          return { accepted: true, state: 'LOCAL_VERIFY' };
        },
      });

      // Step 1: Dispatches task 1 with agy-01
      const step1 = await queue.step();
      expect(step1.dispatched).toBe('task-single-1');
      expect(step1.workerId).toBe('agy-01');
      expect(queue.getActiveTaskCount()).toBe(1);

      // Step 2: Capacity is 1, second task is held
      const step2 = await queue.step();
      expect(step2.dispatched).toBeNull();
      expect(queue.getActiveTaskCount()).toBe(1);

      // Settle task 1
      resolve1({ accepted: true, state: 'LOCAL_VERIFY' });
      await new Promise((resolve) => setImmediate(resolve));
      expect(queue.getActiveTaskCount()).toBe(0);

      // Step 3: Now task 2 is dispatched with agy-01
      const step3 = await queue.step();
      expect(step3.dispatched).toBe('task-single-2');
      expect(step3.workerId).toBe('agy-01');
      expect(queue.getActiveTaskCount()).toBe(1);

      resolve2({ accepted: true, state: 'LOCAL_VERIFY' });
      await queue.waitForAllActive();
      expect(queue.getActiveTaskCount()).toBe(0);
    });
  });

  describe('8. Recovery and Duplicate Dispatch Fencing Durability', () => {
    it('recovers and fences two active slots on interrupted supervisor restart', () => {
      const supervisor = new AutonomySupervisor({ store, maxWorkers: 2 });
      const wo1 = store.createWorkOrder(createWorkOrder({
        taskId: 'rec-task-1',
        workerId: 'agy-01',
        objective: 'rec 1',
        baseSha: 'd'.repeat(40),
        branch: 'agent/agy-01/rec-1',
        worktree: path.join(root, 'worktree-rec-1'),
        allowedPaths: ['src'],
        acceptanceCriteria: ['done'],
        requiredTests: ['npm test'],
      }));
      const wo2 = store.createWorkOrder(createWorkOrder({
        taskId: 'rec-task-2',
        workerId: 'agy-02',
        objective: 'rec 2',
        baseSha: 'd'.repeat(40),
        branch: 'agent/agy-02/rec-2',
        worktree: path.join(root, 'worktree-rec-2'),
        allowedPaths: ['src'],
        acceptanceCriteria: ['done'],
        requiredTests: ['npm test'],
      }));

      store.acquireSlot(wo1.id, 'agy-01', 1);
      store.acquireSlot(wo2.id, 'agy-02', 1);
      expect(store.listActiveSlots()).toHaveLength(2);

      const recovery = supervisor.recover();
      expect(recovery.releasedSlots).toBe(2);
      expect(recovery.fencedOrders).toBe(2);
      expect(store.listActiveSlots()).toHaveLength(0);
      expect(store.getWorkOrder(wo1.id)?.state).toBe('BLOCKED');
      expect(store.getWorkOrder(wo2.id)?.state).toBe('BLOCKED');
    });

    it('fences duplicate dispatch for the same worker identity concurrently', () => {
      new AutonomySupervisor({ store, maxWorkers: 2 });
      const wo1 = store.createWorkOrder(createWorkOrder({
        taskId: 'dup-task-1',
        workerId: 'agy-01',
        objective: 'dup 1',
        baseSha: 'e'.repeat(40),
        branch: 'agent/agy-01/dup-1',
        worktree: path.join(root, 'worktree-dup-1'),
        allowedPaths: ['src'],
        acceptanceCriteria: ['done'],
        requiredTests: ['npm test'],
      }));
      const wo2 = store.createWorkOrder(createWorkOrder({
        taskId: 'dup-task-2',
        workerId: 'agy-01',
        objective: 'dup 2',
        baseSha: 'e'.repeat(40),
        branch: 'agent/agy-01/dup-2',
        worktree: path.join(root, 'worktree-dup-2'),
        allowedPaths: ['src'],
        acceptanceCriteria: ['done'],
        requiredTests: ['npm test'],
      }));

      store.acquireSlot(wo1.id, 'agy-01', 1);
      expect(() => store.acquireSlot(wo2.id, 'agy-01', 1)).toThrow(/DUPLICATE_DISPATCH/);
    });
  });

  describe('9. Product Task Queue Dispatch with Authorized Scope (TSK-TWO-WORKER-AUTH-SCOPE-V2)', () => {
    const BASE_SHA = '0123456789abcdef0123456789abcdef01234567';

    interface SeedAuthOptions {
      taskId?: string;
      branch?: string;
      worktree?: string;
      allowedPaths?: string[];
      forbiddenPaths?: string[];
      authStatus?: ExecutionAuthorizationStatus;
      assignmentId?: string | null;
      taskRevision?: number;
      taskOwnershipEpoch?: number;
      baseSha?: string;
      repoHeadSha?: string;
      state?: TaskState;
    }

    function ensureProductFixture(projectId = 'proj-auth-scope') {
      const now = new Date().toISOString();
      if (!repo.getProject(projectId)) {
        repo.createProject({
          id: projectId,
          name: 'Auth scope project',
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
        repo.createProvider({ id: 'prov-agy-scope', name: 'Antigravity', adapter_type: 'LOCAL_CLI', enabled: true, created_at: now });
        repo.createProviderAccount({
          id: 'acc-agy-scope',
          provider_id: 'prov-agy-scope',
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
          id: 'res-agy-scope',
          provider_id: 'prov-agy-scope',
          provider_account_id: 'acc-agy-scope',
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
          id: 'role-coder-scope',
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
        repo.createWorkerSlot({
          id: 'slot-scope-1',
          provider_account_id: 'acc-agy-scope',
          provider_resource_id: 'res-agy-scope',
          slot_index: 1,
          status: 'IDLE',
          current_assignment_id: null,
          current_execution_id: null,
          heartbeat_at: null,
          created_at: now,
          updated_at: now,
        });
      }
    }

    function seedAuthorizedProductTask(options: SeedAuthOptions = {}) {
      const now = new Date().toISOString();
      const projectId = 'proj-auth-scope';
      const taskId = options.taskId ?? 'task-auth-scope-nonconv';
      const baseSha = options.baseSha ?? BASE_SHA;
      const repoHeadSha = options.repoHeadSha ?? BASE_SHA;
      const branch = options.branch ?? 'feature/deliberately-nonconventional-branch';
      const worktree = options.worktree ?? path.join(root, 'deliberately-nonconventional-wt');
      const allowedPaths = options.allowedPaths ?? ['src'];
      const forbiddenPaths = options.forbiddenPaths ?? ['.git', 'main'];

      fs.mkdirSync(worktree, { recursive: true });
      fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });

      ensureProductFixture(projectId);

      repo.createTask({
        id: taskId,
        project_id: projectId,
        milestone_id: null,
        title: `Authorized product task ${taskId}`,
        description: 'Test nonconventional branch and worktree dispatch',
        state: options.state ?? 'CODING',
        paused_from_state: null,
        priority: 'HIGH',
        risk: 'MEDIUM',
        assigned_agent_id: null,
        revision_count: 0,
        max_revisions: 3,
        base_sha: baseSha,
        current_sha: baseSha,
        progress_cache_percent: 0,
        progress_computed_at: null,
        acceptance_criteria: ['it passes verification and review'],
        constraints: ['do not modify forbidden paths'],
        ownership_epoch: 1,
        created_at: now,
        updated_at: now,
      });

      const assignmentId = options.assignmentId !== undefined ? options.assignmentId : `asg-${taskId}`;
      if (assignmentId) {
        repo.createAgentAssignment({
          id: assignmentId,
          project_id: projectId,
          task_id: taskId,
          attempt_id: null,
          role_profile_id: 'role-coder-scope',
          agent_profile_id: null,
          selected_provider_id: 'prov-agy-scope',
          selected_account_id: 'acc-agy-scope',
          selected_resource_id: 'res-agy-scope',
          selected_worker_slot_id: null,
          routing_decision_id: null,
          preferred_metadata: null,
          status: 'ASSIGNED',
          created_at: now,
          ended_at: null,
        });
      }

      const context = new ContextBuilderService(repo).buildContextSnapshot({
        projectId,
        taskId,
        assignmentId: assignmentId ?? 'asg-fallback',
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
        taskTitle: `Authorized product task ${taskId}`,
        taskDescription: 'Test nonconventional branch and worktree dispatch',
        acceptanceCriteria: ['it passes verification and review'],
        constraints: ['do not modify forbidden paths'],
        instructions: ['implement authorized scope'],
        contextFiles: [],
        verificationCommands: {
          TEST: { executable: process.execPath, args: ['--version'] },
          LINT: null,
          BUILD: null,
        },
        managerMessageId: `msg-${taskId}`,
        managerPayloadHash: crypto.createHash('sha256').update(taskId).digest('hex'),
        executionScope: {
          branch,
          worktree,
          allowedPaths,
          forbiddenPaths,
        },
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

      const authId = `auth-${taskId}`;
      const authorization: ExecutionAuthorization = {
        id: authId,
        project_id: projectId,
        task_id: taskId,
        attempt_id: null,
        task_revision: options.taskRevision ?? 0,
        base_sha: baseSha,
        repository_head_sha: repoHeadSha,
        manager_message_id: canonicalPayload.managerMessageId,
        manager_payload_hash: canonicalPayload.managerPayloadHash,
        routing_decision_id: `route-${taskId}`,
        selected_account_id: 'acc-agy-scope',
        selected_resource_id: 'res-agy-scope',
        selected_provider_id: 'prov-agy-scope',
        instruction_payload_hash: computePayloadHash(canonicalPayload),
        context_manifest_hash: context.manifest.manifest_hash,
        canonical_instructions_json: JSON.stringify(canonicalPayload.instructions),
        context_files_json: '[]',
        canonical_payload_json: JSON.stringify(canonicalPayload),
        expected_task_revision: options.taskRevision ?? 0,
        status: options.authStatus ?? 'AUTHORIZED',
        created_at: now,
        dispatched_at: null,
        task_ownership_epoch: options.taskOwnershipEpoch ?? 1,
        assignment_id: assignmentId,
        lifecycle_version: 1,
      };
      repo.createExecutionAuthorization(authorization);

      return { projectId, taskId, authId, assignmentId, branch, worktree, allowedPaths, forbiddenPaths, baseSha };
    }

    it('dispatches product task with deliberately nonconventional authorized branch and worktree using product lease and zero legacy rows', async () => {
      const nonconventionalBranch = 'feature/deliberately-nonconventional-branch-xyz';
      const nonconventionalWorktree = path.join(root, 'nonconventional-worktree-dir');
      const fixture = seedAuthorizedProductTask({
        branch: nonconventionalBranch,
        worktree: nonconventionalWorktree,
        allowedPaths: ['src'],
        forbiddenPaths: ['.git', 'main'],
      });

      let observedCoderWorkOrder: any = null;

      const controlRepo = path.join(root, 'control-repo');
      fs.mkdirSync(controlRepo, { recursive: true });

      const supervisor = new AutonomySupervisor({
        store,
        maxWorkers: 2,
        controlRepo,
        worktreeRoot: path.join(root, 'standard-worktrees'),
        evidence: {
          collect: async () => ({
            headSha: fixture.baseSha,
            snapshotSha: 'snapshot-clean-evidence',
            status: '',
            changedFiles: ['src'],
            diff: 'diff-clean',
            tests: [{ command: 'node --version', exitCode: 0, stdout: process.version, stderr: '', durationMs: 1 }],
          }),
        },
        agy: {
          execute: async (wo: WorkOrder) => {
            observedCoderWorkOrder = wo;
            return {
              status: 'SUCCESSFUL_PROCESS_EXIT' as const,
              exitCode: 0,
              executionId: 'exec-op-nonconv',
              stdout: 'coder output',
              stderr: '',
              durationMs: 1,
            };
          },
        } as any,
        managerPool: {
          review: async () => ({
            run: {
              status: 'SUCCESSFUL_PROCESS_EXIT' as const,
              exitCode: 0,
              executionId: '',
              stdout: '',
              stderr: '',
              durationMs: 0,
            },
            review: {
              protocol_version: 'managerreview.v1',
              verdict: 'PASS',
              reviewed_head_sha: fixture.baseSha,
              findings: [],
              required_actions: [],
              risk: 'LOW',
              notes: 'passed',
            },
            resource_id: 'res-agy-scope',
            context_sha: 'context-sha-nonconv',
            attempts: ['primary'],
          }),
        } as any,
      });

      const queue = supervisor.createContinuousQueue();
      store.enqueue(makeSelfHostTask(fixture.taskId));

      // Verify no legacy rows before dispatch
      expect(store.listAll()).toHaveLength(0);
      expect(db.prepare('SELECT COUNT(*) as cnt FROM autonomy_work_orders').get()).toEqual({ cnt: 0 });

      // Step queue
      const step = await queue.step();
      expect(step.dispatched).toBe(fixture.taskId);
      expect(step.workerId).toBe('agy-01');

      await queue.waitForAllActive();

      // 1. Coder executed with exact authorized nonconventional branch and worktree, not synthesized ones
      expect(observedCoderWorkOrder).not.toBeNull();
      expect(observedCoderWorkOrder.branch).toBe(nonconventionalBranch);
      expect(observedCoderWorkOrder.branch).not.toContain('agent/agy-01');
      expect(observedCoderWorkOrder.worktree).toBe(nonconventionalWorktree);
      expect(observedCoderWorkOrder.worktree).not.toContain('standard-worktrees');
      expect(observedCoderWorkOrder.allowed_paths).toEqual(['src']);
      expect(observedCoderWorkOrder.forbidden_paths).toEqual(['.git', 'main']);
      expect(observedCoderWorkOrder.base_sha).toBe(fixture.baseSha);
      expect(observedCoderWorkOrder.attempt).toBe(1);
      expect(observedCoderWorkOrder.lease_epoch).toBe(1);

      // 2. Authoritative task reached DONE in product task state machine
      const task = repo.getTask(fixture.taskId)!;
      expect(task.state).toBe('DONE');

      // 3. Product slot lease was acquired and released back to IDLE
      const slot = repo.getWorkerSlot('slot-scope-1')!;
      expect(slot.status).toBe('IDLE');

      // 4. No legacy authoritative lifecycle rows created
      expect(store.listAll()).toHaveLength(0);
      expect(db.prepare('SELECT COUNT(*) as cnt FROM autonomy_work_orders').get()).toEqual({ cnt: 0 });
      expect(store.isLegacyTableAuthoritative('autonomy_work_orders')).toBe(false);

      // 5. Settled event recorded nonconventional branch and worktree
      const settledEvents = db.prepare(
        "SELECT payload_json FROM autonomy_events WHERE work_order_id = ? AND event_type = 'TASK_SETTLED'"
      ).all(fixture.taskId) as Array<{ payload_json: string }>;
      expect(settledEvents).toHaveLength(1);
      const settled = JSON.parse(settledEvents[0].payload_json);
      expect(settled.worktree).toBe(nonconventionalWorktree);
      expect(settled.branch).toBe(nonconventionalBranch);
      expect(settled.accepted).toBe(true);
      expect(settled.state).toBe('DONE');
    });

    it('enforces authorization status, assignment binding, ownership epoch, task revision, and base SHA before coder dispatch', async () => {
      ensureProductFixture();
      let coderCalled = false;
      const controlRepo = path.join(root, 'control-repo');
      fs.mkdirSync(controlRepo, { recursive: true });

      const supervisor = new AutonomySupervisor({
        store,
        maxWorkers: 2,
        controlRepo,
        worktreeRoot: path.join(root, 'standard-worktrees'),
        agy: {
          execute: async () => {
            coderCalled = true;
            return { status: 'SUCCESSFUL_PROCESS_EXIT' as const, exitCode: 0, executionId: '', stdout: '', stderr: '', durationMs: 0 };
          },
        } as any,
      });
      const queue = supervisor.createContinuousQueue();

      // Case A: Unauthenticated product task (no ExecutionAuthorization in DB)
      repo.createTask({
        id: 'task-no-auth',
        project_id: 'proj-auth-scope',
        milestone_id: null,
        title: 'No auth task',
        description: 'desc',
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
        acceptance_criteria: ['none'],
        constraints: [],
        ownership_epoch: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      store.enqueue(makeSelfHostTask('task-no-auth'));
      const stepNoAuth = await queue.step();
      expect(stepNoAuth.dispatched).toBe('task-no-auth');
      await queue.waitForAllActive();
      expect(coderCalled).toBe(false);
      const blockedEventsNoAuth = db.prepare(
        "SELECT payload_json FROM autonomy_events WHERE work_order_id = 'task-no-auth' AND event_type = 'TASK_SETTLED'"
      ).all() as Array<{ payload_json: string }>;
      expect(blockedEventsNoAuth).toHaveLength(1);
      expect(JSON.parse(blockedEventsNoAuth[0].payload_json).state).toBe('BLOCKED');
      expect(JSON.parse(blockedEventsNoAuth[0].payload_json).error).toContain('PRODUCT_TASK_REQUIRES_EXECUTION_AUTHORIZATION');

      // Case B: Stale task revision
      coderCalled = false;
      const fixRev = seedAuthorizedProductTask({ taskId: 'task-stale-rev', taskRevision: 0 });
      db.prepare('UPDATE tasks SET revision_count = 1 WHERE id = ?').run(fixRev.taskId);
      store.enqueue(makeSelfHostTask(fixRev.taskId));
      await queue.step();
      await queue.waitForAllActive();
      expect(coderCalled).toBe(false);
      const blockedEventsRev = db.prepare(
        "SELECT payload_json FROM autonomy_events WHERE work_order_id = ? AND event_type = 'TASK_SETTLED'"
      ).all(fixRev.taskId) as Array<{ payload_json: string }>;
      expect(blockedEventsRev).toHaveLength(1);
      expect(JSON.parse(blockedEventsRev[0].payload_json).state).toBe('BLOCKED');
      expect(JSON.parse(blockedEventsRev[0].payload_json).error).toContain('TASK_REVISION_MISMATCH');

      // Case C: Stale ownership epoch
      coderCalled = false;
      const fixEpoch = seedAuthorizedProductTask({ taskId: 'task-stale-epoch', taskOwnershipEpoch: 1 });
      db.prepare('UPDATE tasks SET ownership_epoch = 2 WHERE id = ?').run(fixEpoch.taskId);
      store.enqueue(makeSelfHostTask(fixEpoch.taskId));
      await queue.step();
      await queue.waitForAllActive();
      expect(coderCalled).toBe(false);
      const blockedEventsEpoch = db.prepare(
        "SELECT payload_json FROM autonomy_events WHERE work_order_id = ? AND event_type = 'TASK_SETTLED'"
      ).all(fixEpoch.taskId) as Array<{ payload_json: string }>;
      expect(blockedEventsEpoch).toHaveLength(1);
      expect(JSON.parse(blockedEventsEpoch[0].payload_json).state).toBe('BLOCKED');
      expect(JSON.parse(blockedEventsEpoch[0].payload_json).error).toContain('OWNERSHIP_EPOCH_MISMATCH');

      // Case D: Base SHA mismatch
      coderCalled = false;
      const fixSha = seedAuthorizedProductTask({ taskId: 'task-mismatch-sha', baseSha: '1'.repeat(40) });
      db.prepare('UPDATE tasks SET base_sha = ? WHERE id = ?').run('2'.repeat(40), fixSha.taskId);
      store.enqueue(makeSelfHostTask(fixSha.taskId));
      await queue.step();
      await queue.waitForAllActive();
      expect(coderCalled).toBe(false);
      const blockedEventsSha = db.prepare(
        "SELECT payload_json FROM autonomy_events WHERE work_order_id = ? AND event_type = 'TASK_SETTLED'"
      ).all(fixSha.taskId) as Array<{ payload_json: string }>;
      expect(blockedEventsSha).toHaveLength(1);
      expect(JSON.parse(blockedEventsSha[0].payload_json).state).toBe('BLOCKED');
      expect(JSON.parse(blockedEventsSha[0].payload_json).error).toContain('EXACT_HEAD_MISMATCH');
    });
  });
});
