import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../src/core/database/migrations';
import { main } from '../src/electron/autonomyCli';
import {
  ManagerReviewSchema,
  WorkerResultSchema,
  createWorkOrder,
  parseManagerReview,
} from '../src/core/autonomy/contracts';
import { AntigravityAdapter, CodexManagerAdapter } from '../src/core/autonomy/providers';
import { AutonomyStore } from '../src/core/autonomy/store';
import { AutonomySupervisor } from '../src/core/autonomy/supervisor';
import { ManagerContextPackageSchema } from '../src/core/autonomy/managerPool';
import { EvidenceCollector } from '../src/core/autonomy/evidence';
import { execFileSync } from 'child_process';

function processResult(overrides: Record<string, unknown> = {}): any {
  return {
    executionId: 'exec-1', pid: 1, command: 'fake', cwd: process.cwd(), exitCode: 0,
    stdout: '', stderr: '', durationMs: 2, timedOut: false, cancelled: false,
    processStart: 'STARTED_PROVEN', processTermination: 'PROCESS_TREE_TERMINATED_PROVEN',
    errorCode: null, ...overrides,
  };
}

function order(worktree: string, taskId = 'task-1') {
  return createWorkOrder({
    taskId, issueNumber: null, workerId: 'agy-01', objective: 'make the change',
    baseSha: 'a'.repeat(40), branch: `agent/agy-01/${taskId}`, worktree,
    acceptanceCriteria: ['it works'], requiredTests: [],
  });
}

function worktree(name = 'agentforge-worktree'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

describe('autonomy durable contracts', () => {
  it('validates WorkOrder and WorkerResult schemas', () => {
    expect(order(path.join(os.tmpdir(), 'agentforge-worktree'))).toMatchObject({ protocol_version: 'workorder.v1', lease_epoch: 1 });
    expect(WorkerResultSchema.parse({ protocol_version: 'workerresult.v1', task_id: 't', worker_id: 'w', attempt: 1, status: 'COMPLETED', summary: 'done', changed_files: [], commands_run: [], tests: [], known_risks: [], blockers: [] })).toBeTruthy();
    expect(() => WorkerResultSchema.parse({ protocol_version: 'workerresult.v1' })).toThrow();
    expect(ManagerContextPackageSchema.safeParse({ protocol_version: 'managercontext.v1' }).success).toBe(false);
  });

  it('parses only structured manager review and rejects prose', () => {
    const raw = `noise\n${JSON.stringify({ protocol_version: 'managerreview.v1', verdict: 'PASS', reviewed_head_sha: 'b'.repeat(40), findings: [], required_actions: [], risk: 'LOW', notes: '' })}`;
    expect(parseManagerReview(raw).verdict).toBe('PASS');
    expect(() => parseManagerReview('PASS: looks good')).toThrow(/CONTRACT_INVALID/);
    expect(ManagerReviewSchema.safeParse({ verdict: 'PASS' }).success).toBe(false);
  });

  it('classifies fake Antigravity process outcomes and sanitizes logs', async () => {
    const success = new AntigravityAdapter({ executable: 'fake', runner: async () => processResult({ stdout: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890' }) as any });
    const result = await success.execute(order(worktree()));
    expect(result.status).toBe('SUCCESSFUL_PROCESS_EXIT');
    expect(result.stdout).toContain('[REDACTED_SECRET]');
    const timeout = new AntigravityAdapter({ executable: 'fake', runner: async () => processResult({ timedOut: true, errorCode: 'TIMEOUT', exitCode: -2 }) as any });
    expect((await timeout.execute(order(worktree()))).status).toBe('TIMEOUT');
    const missing = new AntigravityAdapter({ executable: 'fake', runner: async () => { throw new Error('spawn ENOENT'); } });
    expect((await missing.execute(order(worktree()))).status).toBe('PROCESS_NOT_FOUND');
    const successfulAuthDiscussion = new AntigravityAdapter({
      executable: 'fake',
      runner: async () => processResult({ stdout: 'Completed the unauthorized-execution guard and authorization tests.' }) as any,
    });
    expect((await successfulAuthDiscussion.execute(order(worktree()))).status).toBe('SUCCESSFUL_PROCESS_EXIT');
    const authFailure = new AntigravityAdapter({
      executable: 'fake',
      runner: async () => processResult({ exitCode: 1, stderr: 'Authentication required: invalid token' }) as any,
    });
    expect((await authFailure.execute(order(worktree()))).status).toBe('AUTH_ERROR');
  });

  it('fences leases, slots, duplicate dispatch, and releases CI_WAIT capacity', () => {
    const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.pragma('journal_mode = WAL'); MigrationRunner.run(db);
    const store = new AutonomyStore(db); store.ensureSlots(1);
    const first = store.createWorkOrder(order(path.join(os.tmpdir(), 'agentforge-worktree'), 'task-1'));
    const slot = store.acquireSlot(first.id, 'agy-01', 1);
    expect(() => store.createWorkOrder(order(path.join(os.tmpdir(), 'agentforge-worktree-2'), 'task-1'))).toThrow(/DUPLICATE_DISPATCH/);
    expect(() => store.updateState(first.id, 'LOCAL_VERIFY', 2)).toThrow(/LEASE_EPOCH_MISMATCH/);
    store.updateState(first.id, 'CI_WAIT', 1); store.releaseSlot(slot.slotId, first.id, 1);
    const second = store.createWorkOrder(order(path.join(os.tmpdir(), 'agentforge-worktree-2'), 'task-2'));
    expect(store.acquireSlot(second.id, 'agy-01', 1).workerId).toBe('agy-01');
    db.close();
  });

  it('keeps SHADOW side-effect free and rejects the control repository worktree', () => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-runtime-'));
    const store = AutonomyStore.open(runtime).store;
    const supervisor = new AutonomySupervisor({ mode: 'SHADOW', store, maxWorkers: 1 });
    const result = supervisor.run({ taskId: 'shadow-1', workerId: 'agy-01', objective: 'probe', baseSha: 'a'.repeat(40), branch: 'agent/shadow', worktree: path.join(runtime, 'worktree'), acceptanceCriteria: ['probe'] });
    return result.then((value) => {
      expect(value.state).toBe('READY');
      expect(store.listReady()).toHaveLength(0);
      expect(() => supervisor.createWorkOrder({ taskId: 'bad', workerId: 'agy-01', objective: 'bad', baseSha: 'a'.repeat(40), branch: 'bad', worktree: process.cwd(), acceptanceCriteria: ['bad'] })).toThrow(/WORKTREE_IS_CONTROL_REPO/);
    });
  });

  it('validates Codex structured review output through the adapter boundary', async () => {
    const manager = new CodexManagerAdapter({ executable: 'fake', runner: async () => processResult({ stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ protocol_version: 'managerreview.v1', verdict: 'PASS', reviewed_head_sha: 'c'.repeat(40), findings: [], required_actions: [], risk: 'LOW', notes: '' }) } }) }) as any });
    const result = await manager.review({ workOrder: order(path.join(os.tmpdir(), 'agentforge-worktree')), evidence: '{}' });
    expect(result.review?.reviewed_head_sha).toBe('c'.repeat(40));
  });

  it('closes provider stdin and rejects manager changes to authorized paths', async () => {
    const root = worktree();
    const seeded = order(root);
    const manager = new CodexManagerAdapter({ executable: 'fake', runner: async (options) => {
      expect(options.stdin).toContain(seeded.task_id);
      expect(options.args.at(-1)).toBe('-');
      return processResult({ stdout: JSON.stringify({ ...seeded, worktree: process.cwd() }) });
    } });
    const result = await manager.plan(seeded);
    expect(result.workOrder).toBeUndefined();
    expect(result.run.status).toBe('CONTRACT_INVALID');
  });

  it('captures untracked content and detects edits that do not change HEAD', async () => {
    const root = worktree();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    git('init'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'base');
    const wo = { ...order(root), base_sha: git('rev-parse', 'HEAD').trim() };
    fs.writeFileSync(path.join(root, 'new.txt'), 'first');
    const collector = new EvidenceCollector();
    const first = await collector.collect(wo);
    expect(first.changedFiles).toContain('new.txt');
    expect(first.diff).toContain('first');
    fs.writeFileSync(path.join(root, 'new.txt'), 'second');
    const second = await collector.collect(wo);
    expect(second.headSha).toBe(first.headSha);
    expect(second.snapshotSha).not.toBe(first.snapshotSha);
  });

  it('vetoes a manager PASS when tests fail or the working tree changes', async () => {
    for (const stale of [false, true]) {
      const root = worktree(); const child = path.join(root, 'child'); fs.mkdirSync(child);
      const db = new Database(':memory:'); MigrationRunner.run(db);
      const store = new AutonomyStore(db);
      let collects = 0;
      const supervisor = new AutonomySupervisor({ store, worktreeRoot: root, maxRepairLoops: 0,
        agy: new AntigravityAdapter({ executable: 'fake', runner: async () => processResult() }),
        manager: new CodexManagerAdapter({ executable: 'fake', runner: async () => processResult({ stdout: JSON.stringify({ protocol_version: 'managerreview.v1', verdict: 'PASS', reviewed_head_sha: 'a'.repeat(40), findings: [], required_actions: [], risk: 'LOW', notes: '' }) }) }),
        evidence: { collect: async () => { collects++; return { headSha: 'a'.repeat(40), snapshotSha: stale && collects === 3 ? 'changed' : 'original', status: collects === 1 ? '' : '?? proof.txt', changedFiles: collects === 1 ? [] : ['proof.txt'], diff: 'proof', tests: [{ command: 'test', exitCode: stale ? 0 : 1, stdout: '', stderr: '', durationMs: 1 }] }; } },
      });
      const result = await supervisor.run({ taskId: 'veto', workerId: 'agy-01', objective: 'proof', baseSha: 'a'.repeat(40), branch: 'agent/veto', worktree: child, acceptanceCriteria: ['proof'], allowedPaths: ['proof.txt'], requiredTests: ['test'] });
      expect(result.accepted).not.toBe(true);
      expect(result.state).toBe('BLOCKED');
      expect(store.listActiveSlots()).toHaveLength(0);
      db.close();
    }
  });

  it('fails closed deterministically when ExecutionAuthorization is missing and releases capacity', async () => {
    const root = worktree(); const child = path.join(root, 'child'); fs.mkdirSync(child);
    const db = new Database(':memory:'); MigrationRunner.run(db);
    const store = new AutonomyStore(db);
    const supervisor = new AutonomySupervisor({
      store,
      worktreeRoot: root,
      evidence: { collect: async () => ({ headSha: 'a'.repeat(40), snapshotSha: 'clean', status: '', changedFiles: [], diff: '', tests: [{ command: 'test', exitCode: 0, stdout: '', stderr: '', durationMs: 1 }] }) },
    });
    const result = await supervisor.run({ taskId: 'manager-capacity', workerId: 'agy-01', objective: 'wait for manager', baseSha: 'a'.repeat(40), branch: 'agent/manager-capacity', worktree: child, acceptanceCriteria: ['wait'], allowedPaths: ['src'], requiredTests: ['test'] });
    expect(result.state).toBe('BLOCKED');
    expect(result.error).toContain('AUTHORIZATION_MISSING');
    expect(store.listActiveSlots()).toHaveLength(0);
    expect(store.getDatabase().prepare("SELECT state FROM autonomy_work_orders WHERE task_id='manager-capacity'").pluck().get()).toBe('BLOCKED');
    db.close();
  });

  it('prevents shared worktrees and fences interrupted attempts on recovery', () => {
    const db = new Database(':memory:'); MigrationRunner.run(db);
    const store = new AutonomyStore(db); store.ensureSlots(2);
    const root = worktree();
    const first = store.createWorkOrder(order(root));
    store.acquireSlot(first.id, 'agy-01', 1);
    expect(() => store.createWorkOrder({ ...order(root, 'other'), worker_id: 'agy-02' })).toThrow(/SHARED_WORKTREE/);
    const supervisor = new AutonomySupervisor({ store });
    expect(supervisor.recover().fencedOrders).toBe(1);
    expect(store.getWorkOrder(first.id)?.state).toBe('BLOCKED');
    expect(store.listActiveSlots()).toHaveLength(0);
    db.close();
  });

  it('keeps containment case-sensitive on POSIX while preserving Windows folding', () => {
    const control = fs.mkdtempSync(path.join(os.tmpdir(), 'Control-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'MixedCase-'));
    const candidate = path.join(root, 'WorkerCase'); fs.mkdirSync(candidate);
    expect(AutonomySupervisor.isSafeWorktree(control, candidate)).toBe(true);
    expect(AutonomySupervisor.isSafeWorktree(control, control)).toBe(false);
    expect(AutonomySupervisor.isSafeWorktree(control, path.join(control, 'child'))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(control, { recursive: true, force: true });
  });

  it('enforces consolidation cap MAX_AGY_WORKERS accepting 1 through 2 and rejecting other values', () => {
    const db = new Database(':memory:'); MigrationRunner.run(db);
    const store = new AutonomyStore(db);
    expect(() => new AutonomySupervisor({ store, maxWorkers: 3 })).toThrow(/CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS/);
    expect(() => new AutonomySupervisor({ store, maxWorkers: 0 })).toThrow(/CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS/);
    expect(() => new AutonomySupervisor({ store, maxWorkers: -1 })).toThrow(/CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS/);
    expect(() => new AutonomySupervisor({ store, maxWorkers: 1.5 })).toThrow(/CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS/);
    const prevEnv = process.env.MAX_AGY_WORKERS;
    try {
      process.env.MAX_AGY_WORKERS = '3';
      expect(() => new AutonomySupervisor({ store })).toThrow(/CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS/);
      process.env.MAX_AGY_WORKERS = '0';
      expect(() => new AutonomySupervisor({ store })).toThrow(/CONSOLIDATION_REQUIRES_MAX_AGY_WORKERS/);
    } finally {
      if (prevEnv !== undefined) {
        process.env.MAX_AGY_WORKERS = prevEnv;
      } else {
        delete process.env.MAX_AGY_WORKERS;
      }
    }
    const supervisor1 = new AutonomySupervisor({ store, maxWorkers: 1 });
    expect(supervisor1).toBeDefined();
    expect(supervisor1.maxWorkers).toBe(1);
    const supervisor2 = new AutonomySupervisor({ store, maxWorkers: 2 });
    expect(supervisor2).toBeDefined();
    expect(supervisor2.maxWorkers).toBe(2);
    db.close();
  });

  it('awaits ContinuousQueue.run before finally cleanup so database stays open for the queue lifetime (TSK-TWO-WORKER-QUEUE-LIFETIME)', async () => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-cli-start-'));
    const control = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-cli-control-'));
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-cli-worktree-'));
    const prevEnv = {
      AGENT_FORGE_RUNTIME_ROOT: process.env.AGENT_FORGE_RUNTIME_ROOT,
      AGENT_FORGE_CONTROL_REPO: process.env.AGENT_FORGE_CONTROL_REPO,
      AGENT_FORGE_WORKTREE_ROOT: process.env.AGENT_FORGE_WORKTREE_ROOT,
      MAX_AGY_WORKERS: process.env.MAX_AGY_WORKERS,
      AGENT_FORGE_POLL_INTERVAL_MS: process.env.AGENT_FORGE_POLL_INTERVAL_MS,
    };
    try {
      process.env.AGENT_FORGE_RUNTIME_ROOT = runtime;
      process.env.AGENT_FORGE_CONTROL_REPO = control;
      process.env.AGENT_FORGE_WORKTREE_ROOT = worktree;
      process.env.MAX_AGY_WORKERS = '2';
      process.env.AGENT_FORGE_POLL_INTERVAL_MS = '10';

      const seed = AutonomyStore.open(runtime);
      seed.store.event('pilot-proof', 'LOCAL_ACCEPTED', { headSha: 'a'.repeat(40) });
      seed.engine.close();

      let dbOpenDuringRun = false;
      let dbStillOpenAfterTick = false;
      let ownerHeldDuringRun = false;
      let observedWorkers = 0;

      const originalCreate = AutonomySupervisor.prototype.createContinuousQueue;
      const spy = vi.spyOn(AutonomySupervisor.prototype, 'createContinuousQueue').mockImplementation(function (this: AutonomySupervisor, options: any) {
        observedWorkers = this.maxWorkers;
        const queue = originalCreate.call(this, options);
        const originalRun = queue.run.bind(queue);
        queue.run = async () => {
          const db = queue.store.getDatabase();
          dbOpenDuringRun = db.open;
          // Yield execution to the event loop. If main() did not await queue.run(),
          // main's finally block would run immediately, closing the DB and releasing the owner.
          await new Promise((resolve) => setTimeout(resolve, 25));
          dbStillOpenAfterTick = db.open;
          ownerHeldDuringRun = !queue.store.shouldStop();
          queue.store.requestStop();
          return originalRun();
        };
        return queue;
      });

      try {
        const exitCode = await main(['node', 'autonomyCli.ts', 'start']);
        expect(exitCode).toBe(0);
        expect(observedWorkers).toBe(2);
        expect(dbOpenDuringRun).toBe(true);
        expect(dbStillOpenAfterTick).toBe(true);
        expect(ownerHeldDuringRun).toBe(true);
      } finally {
        spy.mockRestore();
      }
    } finally {
      for (const [key, val] of Object.entries(prevEnv)) {
        if (val !== undefined) process.env[key] = val;
        else delete process.env[key];
      }
      fs.rmSync(runtime, { recursive: true, force: true });
      fs.rmSync(control, { recursive: true, force: true });
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('fails deterministically with database closed error if queue promise escapes try/finally early', async () => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-cli-regression-'));
    try {
      const opened = AutonomyStore.open(runtime);
      const db = opened.engine.getDb();
      let cleanupExecuted = false;

      // Demonstrates the unawaited try/finally escape bug:
      // JavaScript executes finally immediately upon return, closing SQLite while the queue is pending
      const queuePromise = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        // Queue attempt to access database after tick throws because database was closed in finally
        return opened.store.shouldStop();
      })();
      const rejectionExpectation = expect(queuePromise).rejects.toThrow(/database connection is not open/i);

      const unawaitedEscapePath = () => {
        try {
          return queuePromise;
        } finally {
          cleanupExecuted = true;
          opened.engine.close();
        }
      };

      const escapePromise = unawaitedEscapePath();
      expect(cleanupExecuted).toBe(true);
      expect(db.open).toBe(false);
      await rejectionExpectation;

      // Contrast with the repaired start path (awaiting before finally cleanup):
      const opened2 = AutonomyStore.open(runtime);
      const db2 = opened2.engine.getDb();
      let cleanupExecuted2 = false;
      const awaitedStartPath = async () => {
        try {
          return await (async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return opened2.store.shouldStop();
          })();
        } finally {
          cleanupExecuted2 = true;
          opened2.engine.close();
        }
      };

      const awaitedPromise = awaitedStartPath();
      expect(cleanupExecuted2).toBe(false);
      expect(db2.open).toBe(true);
      await expect(awaitedPromise).resolves.toBe(false);
      expect(cleanupExecuted2).toBe(true);
      expect(db2.open).toBe(false);
    } finally {
      fs.rmSync(runtime, { recursive: true, force: true });
    }
  });
});
