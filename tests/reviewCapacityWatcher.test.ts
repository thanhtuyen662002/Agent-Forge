import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MigrationRunner } from '../src/core/database/migrations';
import { AutonomyStore } from '../src/core/autonomy/store';
import { createWorkOrder } from '../src/core/autonomy/contracts';
import {
  buildManagerContextPackage,
  ManagerProviderPool,
} from '../src/core/autonomy/managerPool';
import { ReviewCapacityWatcher } from '../src/core/autonomy/reviewCapacity';
import { AutonomySupervisor } from '../src/core/autonomy/supervisor';

const head = 'b'.repeat(40);

function setup() {
  const db = new Database(':memory:');
  MigrationRunner.run(db);
  const store = new AutonomyStore(db);
  store.ensureSlots(2);
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'review-capacity-'));
  const order = createWorkOrder({
    taskId: 'review-capacity-task',
    workerId: 'agy-01',
    objective: 'review the exact candidate',
    baseSha: 'a'.repeat(40),
    branch: 'agent/review-capacity',
    worktree,
    allowedPaths: ['src/a.ts'],
    requiredTests: ['test'],
    acceptanceCriteria: ['review passes'],
  });
  const context = buildManagerContextPackage({
    workOrder: order,
    currentHead: head,
    actualDiff: 'candidate-diff',
    changedFiles: ['src/a.ts'],
    deterministicTests: [{ command: 'test', exitCode: 0 }],
  });
  const contextJson = JSON.stringify(context);
  const contextSha = crypto.createHash('sha256').update(contextJson).digest('hex');
  store.recordManagerContext(contextSha, contextJson);
  return { db, store, worktree, contextSha };
}

function evidence(observedHead = head, diff = 'candidate-diff') {
  return {
    collect: async () => ({
      headSha: observedHead,
      snapshotSha: 'snapshot',
      status: '',
      changedFiles: ['src/a.ts'],
      diff,
      tests: [],
    }),
  };
}

describe('durable review-capacity resume', () => {
  it('backs off without consuming a worker slot and resumes the same exact context when capacity returns', async () => {
    const { db, store, contextSha } = setup();
    let calls = 0;
    let nowMs = Date.parse('2026-09-25T03:00:00.000Z');
    const pool = new ManagerProviderPool(store, [{
      id: 'reviewer',
      priority: 100,
      enabled: true,
      review: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            run: {
              status: 'QUOTA_OR_RATE_LIMIT',
              exitCode: 429,
              executionId: '',
              stdout: '',
              stderr: 'quota exhausted',
              durationMs: 1,
            },
          };
        }
        return {
          run: {
            status: 'SUCCESSFUL_PROCESS_EXIT',
            exitCode: 0,
            executionId: '',
            stdout: '',
            stderr: '',
            durationMs: 1,
          },
          review: {
            protocol_version: 'managerreview.v1' as const,
            verdict: 'PASS' as const,
            reviewed_head_sha: head,
            findings: [],
            required_actions: [],
            risk: 'LOW' as const,
            notes: '',
          },
        };
      },
    }]);

    const watcher = new ReviewCapacityWatcher({
      store,
      managerPool: pool,
      evidence: evidence() as any,
      now: () => new Date(nowMs),
      baseBackoffMs: 100,
      maxBackoffMs: 1000,
    });
    watcher.register(contextSha, head);

    const first = await watcher.observeDue();
    expect(first).toHaveLength(1);
    expect(first[0].status).toBe('WAITING_CAPACITY');
    expect(store.listActiveSlots()).toHaveLength(0);
    expect(store.listReviewCapacityWaits()[0]).toMatchObject({
      state: 'WAITING',
      attempt_count: 1,
      context_sha: contextSha,
      expected_head_sha: head,
    });

    nowMs += 101;
    const second = await watcher.observeDue();
    expect(second).toHaveLength(1);
    expect(second[0].status).toBe('PASS');
    expect(second[0].review?.reviewed_head_sha).toBe(head);
    expect(store.listReviewCapacityWaits()[0]).toMatchObject({
      state: 'PASS',
      attempt_count: 2,
      verdict: 'PASS',
    });
    expect(store.listActiveSlots()).toHaveLength(0);
    expect(calls).toBe(2);
    db.close();
  });

  it('persists the wait across reopening the same runtime database', () => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'review-capacity-runtime-'));
    try {
      const first = AutonomyStore.open(runtime);
      const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'review-capacity-persist-'));
      const order = createWorkOrder({
        taskId: 'persistent-review-task',
        workerId: 'agy-01',
        objective: 'persist review',
        baseSha: 'a'.repeat(40),
        branch: 'agent/persistent-review',
        worktree,
        allowedPaths: ['src/a.ts'],
        acceptanceCriteria: ['persist'],
      });
      const context = buildManagerContextPackage({
        workOrder: order,
        currentHead: head,
        actualDiff: '',
        changedFiles: [],
      });
      const json = JSON.stringify(context);
      const sha = crypto.createHash('sha256').update(json).digest('hex');
      first.store.recordManagerContext(sha, json);
      first.store.registerReviewCapacityWait({
        taskId: order.task_id,
        contextSha: sha,
        expectedHeadSha: head,
        nextAttemptAt: '2099-01-01T00:00:00.000Z',
      });
      first.engine.close();

      const reopened = AutonomyStore.open(runtime);
      expect(reopened.store.listReviewCapacityWaits()).toHaveLength(1);
      expect(reopened.store.listReviewCapacityWaits()[0]).toMatchObject({
        task_id: 'persistent-review-task',
        context_sha: sha,
        expected_head_sha: head,
        state: 'WAITING',
      });
      reopened.engine.close();
      fs.rmSync(worktree, { recursive: true, force: true });
    } finally {
      fs.rmSync(runtime, { recursive: true, force: true });
    }
  });

  it('blocks stale candidate evidence before invoking any reviewer resource', async () => {
    const { db, store, contextSha } = setup();
    let calls = 0;
    const pool = new ManagerProviderPool(store, [{
      id: 'reviewer',
      priority: 100,
      enabled: true,
      review: async () => {
        calls += 1;
        throw new Error('must not be called');
      },
    }]);
    const watcher = new ReviewCapacityWatcher({
      store,
      managerPool: pool,
      evidence: evidence('c'.repeat(40)) as any,
    });
    watcher.register(contextSha, head);
    const result = await watcher.observeDue();
    expect(result[0].status).toBe('BLOCKED');
    expect(result[0].error).toMatch(/HEAD_MISMATCH/);
    expect(calls).toBe(0);
    expect(store.listReviewCapacityWaits()[0].state).toBe('BLOCKED');
    db.close();
  });

  it('continuous queue polls review capacity while leaving worker identities free', async () => {
    const { db, store } = setup();
    const supervisor = new AutonomySupervisor({
      store,
      maxWorkers: 2,
      evidence: evidence() as any,
    });
    let reviewPolls = 0;
    const queue = supervisor.createContinuousQueue({
      reviewCapacity: {
        observeDue: async () => {
          reviewPolls += 1;
          return [];
        },
      },
    });
    const step = await queue.step();
    expect(step.dispatched).toBeNull();
    expect(step.reviewObservations).toEqual([]);
    expect(reviewPolls).toBe(1);
    expect(queue.getActiveWorkerIds()).toEqual([]);
    expect(store.listActiveSlots()).toHaveLength(0);
    db.close();
  });
});
