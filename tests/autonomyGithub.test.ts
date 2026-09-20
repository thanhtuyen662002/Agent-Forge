import os from 'os';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MigrationRunner } from '../src/core/database/migrations';
import { AutonomyStore } from '../src/core/autonomy/store';
import { GithubCiObserver } from '../src/core/autonomy/github';
import { CodexManagerAdapter } from '../src/core/autonomy/providers';
import { createWorkOrder } from '../src/core/autonomy/contracts';

const sha = 'a'.repeat(40);

function setup() {
  const db = new Database(':memory:'); MigrationRunner.run(db);
  const store = new AutonomyStore(db); store.ensureSlots(1);
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'github-ci-'));
  const order = createWorkOrder({ taskId: 'ci-task', workerId: 'agy-01', objective: 'repair', baseSha: sha, branch: 'agent/agy-01/ci-task', worktree, allowedPaths: ['src'], requiredTests: ['npm test'], acceptanceCriteria: ['passes'] });
  const row = store.createWorkOrder(order); store.updateState(row.id, 'CI_WAIT', order.lease_epoch);
  return { db, store, row, worktree };
}

describe('durable GitHub CI observation', () => {
  it('binds a Draft PR to an exact head and transitions CI_WAIT to MERGE_READY', async () => {
    const { db, store, row } = setup();
    const observer = new GithubCiObserver(store, process.cwd(), undefined, async (_exe, args) => ({
      status: 0, stderr: '', stdout: args[0] === 'pr' ? JSON.stringify({ number: 62, isDraft: true, headRefName: row.branch, headRefOid: sha, statusCheckRollup: [{ name: 'Fast', status: 'COMPLETED', conclusion: 'SUCCESS' }] }) : '',
    }));
    const watch = observer.register({ taskId: row.task_id, workOrderId: row.id, repository: 'owner/repo', prNumber: 62, branch: row.branch, expectedHeadSha: sha });
    const result = await observer.observe(watch);
    expect(result.conclusion).toBe('SUCCESS');
    expect(store.getWorkOrder(row.id)?.state).toBe('MERGE_READY');
    expect(store.listActiveSlots()).toHaveLength(0);
    db.close();
  });

  it('persists failed job evidence, asks the manager, and queues a durable repair', async () => {
    const { db, store, row } = setup();
    const manager = new CodexManagerAdapter({ executable: 'fake', runner: async () => ({ executionId: 'review', pid: null, command: 'fake', cwd: process.cwd(), exitCode: 0, stdout: JSON.stringify({ protocol_version: 'managerreview.v1', verdict: 'REPAIR', reviewed_head_sha: sha, findings: [{ severity: 'HIGH', title: 'CI failure', description: 'Fix it' }], required_actions: ['fix it'], risk: 'HIGH', notes: '' }), stderr: '', durationMs: 1, timedOut: false, cancelled: false, processStart: 'STARTED_PROVEN', processTermination: 'PROCESS_TREE_TERMINATED_PROVEN', errorCode: null }) as any });
    const observer = new GithubCiObserver(store, process.cwd(), manager, async (_exe, args) => ({
      status: 0, stderr: '', stdout: args[0] === 'pr' ? JSON.stringify({ number: 63, isDraft: true, headRefName: row.branch, headRefOid: sha, statusCheckRollup: [{ name: 'Fast', status: 'COMPLETED', conclusion: 'FAILURE', databaseId: 123 }] }) : 'job failed: assertion',
    }));
    const watch = observer.register({ taskId: row.task_id, workOrderId: row.id, repository: 'owner/repo', prNumber: 63, branch: row.branch, expectedHeadSha: sha });
    const result = await observer.observe(watch);
    expect(result.conclusion).toBe('FAILURE');
    expect(result.repairTaskId).toMatch(/^ci-task-CI-/);
    expect(store.getWorkOrder(row.id)?.state).toBe('REPAIR');
    expect(store.listDueCiWatches()).toHaveLength(0);
    expect(store.getCiWatchForRepairTask(result.repairTaskId!)?.state).toBe('REPAIR_QUEUED');
    expect(store.getDatabase().prepare("SELECT COUNT(*) AS count FROM autonomy_events WHERE event_type='CI_FAILURE_EVIDENCE'").get()).toMatchObject({ count: 1 });
    db.close();
  });

  it('fails closed when the remote PR head changes', async () => {
    const { db, store, row } = setup();
    const observer = new GithubCiObserver(store, process.cwd(), undefined, async () => ({ status: 0, stderr: '', stdout: JSON.stringify({ number: 64, isDraft: true, headRefName: row.branch, headRefOid: 'b'.repeat(40), statusCheckRollup: [] }) }));
    const watch = observer.register({ taskId: row.task_id, workOrderId: row.id, repository: 'owner/repo', prNumber: 64, branch: row.branch, expectedHeadSha: sha });
    const result = await observer.observe(watch);
    expect(result.conclusion).toBe('FAILURE');
    expect(store.getDatabase().prepare('SELECT state FROM autonomy_ci_watches WHERE id=?').get(watch.id)).toMatchObject({ state: 'BLOCKED' });
    db.close();
  });
});

