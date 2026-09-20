import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MigrationRunner } from '../src/core/database/migrations';
import {
  ManagerReviewSchema,
  WorkerResultSchema,
  createWorkOrder,
  parseManagerReview,
} from '../src/core/autonomy/contracts';
import { AntigravityAdapter, CodexManagerAdapter } from '../src/core/autonomy/providers';
import { AutonomyStore } from '../src/core/autonomy/store';
import { AutonomySupervisor } from '../src/core/autonomy/supervisor';
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
      expect(options.stdin).toBe('');
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
});
