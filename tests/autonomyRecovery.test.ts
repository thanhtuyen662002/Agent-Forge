import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MigrationRunner } from '../src/core/database/migrations';
import { AutonomyStore } from '../src/core/autonomy/store';
import { AutonomySupervisor } from '../src/core/autonomy/supervisor';
import { createWorkOrder } from '../src/core/autonomy/contracts';

interface Fixture {
  root: string;
  repo: string;
  managed: string;
  worktree: string;
  branch: string;
  baseSha: string;
  store: AutonomyStore;
  db: Database.Database;
  supervisor: AutonomySupervisor;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function fixture(taskId = 'recovery-task', branch = 'agent/recovery-task'): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-recovery-'));
  const repo = path.join(root, 'control');
  const managed = path.join(root, 'managed');
  const worktree = path.join(managed, taskId);
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(managed, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Agent Forge Recovery Test');
  git(repo, 'config', 'user.email', 'recovery@example.invalid');
  fs.writeFileSync(path.join(repo, 'README.md'), 'recovery fixture\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'base');
  const baseSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'worktree', 'add', '-q', '-b', branch, worktree, baseSha);

  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  MigrationRunner.run(db);
  const store = new AutonomyStore(db);
  const supervisor = new AutonomySupervisor({
    store,
    controlRepo: repo,
    worktreeRoot: managed,
    maxWorkers: 1,
  });
  const order = createWorkOrder({
    taskId,
    issueNumber: null,
    workerId: 'agy-01',
    objective: 'reconcile recovery fixture',
    baseSha,
    branch,
    worktree,
    acceptanceCriteria: ['recovery is deterministic'],
    requiredTests: [],
  });
  store.createWorkOrder(order);
  store.acquireSlot(order.task_id === taskId ? store.findLatestWorkOrderByTask(taskId)!.id : '', 'agy-01', 1);
  return { root, repo, managed, worktree, branch, baseSha, store, db, supervisor };
}

function orderId(fx: Fixture): string {
  return fx.store.findLatestWorkOrderByTask('recovery-task')?.id
    ?? fx.store.listAll()[0]?.id
    ?? (() => { throw new Error('fixture work order missing'); })();
}

function closeFixture(fx: Fixture): void {
  try { fx.db.close(); } catch { /* already closed */ }
  fs.rmSync(fx.root, { recursive: true, force: true });
}

describe('bounded autonomy recovery reconciliation', () => {
  it('reports a missing managed worktree, fences the order, and retains its slot', () => {
    const fx = fixture();
    try {
      fs.rmSync(fx.worktree, { recursive: true, force: true });
      const report = fx.supervisor.inspectRecovery();
      const inspection = report.inspections.find((item) => item.workOrderId === orderId(fx));
      expect(inspection?.classification).toBe('MISSING');
      expect(inspection?.fenced).toBe(true);
      expect(fx.store.getWorkOrder(orderId(fx))?.state).toBe('LEASED');
      expect(fx.store.getDatabase().prepare("SELECT COUNT(*) AS count FROM autonomy_events WHERE work_order_id = ? AND event_type = 'RECOVERY_FENCED'").get(orderId(fx)) as { count: number }).toEqual({ count: 0 });

      const recovered = fx.supervisor.recover();
      expect(recovered.fencedOrders).toBe(1);
      expect(recovered.releasedSlots).toBe(0);
      expect(fx.store.getWorkOrder(orderId(fx))?.state).toBe('BLOCKED');
      expect(fx.store.listActiveSlots()).toHaveLength(1);
      expect(fx.store.getDatabase().prepare("SELECT COUNT(*) AS count FROM autonomy_events WHERE work_order_id = ? AND event_type = 'RECOVERY_FENCED'").get(orderId(fx)) as { count: number }).toEqual({ count: 1 });
    } finally {
      closeFixture(fx);
    }
  });

  it('fences branch and HEAD drift without changing Git state', () => {
    const branchFixture = fixture('branch-drift', 'agent/expected-branch');
    try {
      git(branchFixture.worktree, 'switch', '-q', '-c', 'agent/observed-branch');
      const report = branchFixture.supervisor.inspectRecovery();
      expect(report.inspections.find((item) => item.workOrderId === orderId(branchFixture))?.classification).toBe('BRANCH_MISMATCH');
      expect(branchFixture.supervisor.recover().releasedSlots).toBe(0);
      expect(branchFixture.store.getWorkOrder(orderId(branchFixture))?.state).toBe('BLOCKED');
      expect(git(branchFixture.worktree, 'branch', '--show-current')).toBe('agent/observed-branch');
    } finally {
      closeFixture(branchFixture);
    }

    const headFixture = fixture('head-drift', 'agent/head-drift');
    try {
      fs.writeFileSync(path.join(headFixture.worktree, 'drift.txt'), 'drift\n');
      git(headFixture.worktree, 'add', 'drift.txt');
      git(headFixture.worktree, 'commit', '-q', '-m', 'unexpected head');
      const report = headFixture.supervisor.inspectRecovery();
      expect(report.inspections.find((item) => item.workOrderId === orderId(headFixture))?.classification).toBe('HEAD_MISMATCH');
      expect(headFixture.supervisor.recover().releasedSlots).toBe(0);
      expect(headFixture.store.getWorkOrder(orderId(headFixture))?.state).toBe('BLOCKED');
      expect(git(headFixture.worktree, 'rev-parse', 'HEAD')).not.toBe(headFixture.baseSha);
    } finally {
      closeFixture(headFixture);
    }
  });

  it.each(['CI_WAIT', 'PR_OPEN'] as const)('retains clean %s worktrees and releases capacity', (state) => {
    const fx = fixture(`retained-${state.toLowerCase()}`, `agent/retained-${state.toLowerCase()}`);
    try {
      const id = orderId(fx);
      fx.store.updateState(id, state, 1);
      const report = fx.supervisor.inspectRecovery();
      const inspection = report.inspections.find((item) => item.workOrderId === id);
      expect(inspection?.classification).toBe('MATCHED');
      expect(inspection?.retain).toBe(true);
      const recovered = fx.supervisor.recover();
      expect(recovered.fencedOrders).toBe(0);
      expect(recovered.releasedSlots).toBe(1);
      expect(fx.store.getWorkOrder(id)?.state).toBe(state);
      expect(fx.store.listActiveSlots()).toHaveLength(0);
    } finally {
      closeFixture(fx);
    }
  });

  it('does not duplicate recovery fence events across repeated recovery', () => {
    const fx = fixture('idempotent-missing', 'agent/idempotent-missing');
    try {
      fs.rmSync(fx.worktree, { recursive: true, force: true });
      const first = fx.supervisor.recover();
      const second = fx.supervisor.recover();
      expect(first.fencedOrders).toBe(1);
      expect(first.releasedSlots).toBe(0);
      expect(second.fencedOrders).toBe(0);
      expect(second.releasedSlots).toBe(0);
      expect(fx.store.listActiveSlots()).toHaveLength(1);
      expect(fx.store.getDatabase().prepare("SELECT COUNT(*) AS count FROM autonomy_events WHERE work_order_id = ? AND event_type = 'RECOVERY_FENCED'").get(orderId(fx)) as { count: number }).toEqual({ count: 1 });
    } finally {
      closeFixture(fx);
    }
  });
});
