import os from 'os';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MigrationRunner } from '../src/core/database/migrations';
import { AutonomyStore } from '../src/core/autonomy/store';
import { GithubCiObserver } from '../src/core/autonomy/github';
import { CodexManagerAdapter } from '../src/core/autonomy/providers';
import { ManagerProviderPool } from '../src/core/autonomy/managerPool';
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
      status: 0, stderr: '', stdout: args[0] === 'pr' ? JSON.stringify({ number: 63, isDraft: true, headRefName: row.branch, headRefOid: sha, statusCheckRollup: [{ name: 'Fast', status: 'COMPLETED', conclusion: 'FAILURE', databaseId: 123, detailsUrl: 'https://github.com/owner/repo/actions/runs/1001/job/123' }] }) : 'job failed: assertion',
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

  it('fails over CI failure review from credit-exhausted primary to fallback and queues repair', async () => {
    const { db, store, row } = setup();
    let primaryCalled = false;
    let fallbackCalled = false;
    let handedContext: any = null;
    const pool = new ManagerProviderPool(store, [
      {
        id: 'codex-chatgpt-primary',
        priority: 100,
        enabled: true,
        review: async () => {
          primaryCalled = true;
          return { run: { status: 'QUOTA_OR_RATE_LIMIT', exitCode: 1, executionId: '', stdout: '', stderr: 'workspace credit limit reached', durationMs: 1 } };
        },
      },
      {
        id: 'codex-api-fallback',
        priority: 50,
        enabled: true,
        review: async ({ evidence }) => {
          fallbackCalled = true;
          handedContext = JSON.parse(evidence);
          return {
            run: { status: 'SUCCESSFUL_PROCESS_EXIT', exitCode: 0, executionId: '', stdout: '', stderr: '', durationMs: 1 },
            review: {
              protocol_version: 'managerreview.v1',
              verdict: 'REPAIR',
              reviewed_head_sha: sha,
              findings: [{ severity: 'HIGH', title: 'CI failover repair', description: 'Fixed in fallback' }],
              required_actions: ['fix it'],
              risk: 'MEDIUM',
              notes: '',
            },
          };
        },
      },
    ]);
    const observer = new GithubCiObserver(store, process.cwd(), pool, async (_exe, args) => ({
      status: 0, stderr: '', stdout: args[0] === 'pr' ? JSON.stringify({ number: 65, isDraft: true, headRefName: row.branch, headRefOid: sha, statusCheckRollup: [{ name: 'Fast', status: 'COMPLETED', conclusion: 'FAILURE', databaseId: 456, detailsUrl: 'https://github.com/owner/repo/actions/runs/1002/job/456' }] }) : 'job failed: test fail',
    }));
    const watch = observer.register({ taskId: row.task_id, workOrderId: row.id, repository: 'owner/repo', prNumber: 65, branch: row.branch, expectedHeadSha: sha });
    const result = await observer.observe(watch);
    expect(primaryCalled).toBe(true);
    expect(fallbackCalled).toBe(true);
    expect(result.conclusion).toBe('FAILURE');
    expect(result.repairTaskId).toMatch(/^ci-task-CI-/);
    expect(store.getManagerResourceHealth('codex-chatgpt-primary')?.state).toBe('CREDITS_EXHAUSTED');
    expect(store.getWorkOrder(row.id)?.state).toBe('REPAIR');
    expect(handedContext.current_head).toBe(sha);
    expect(handedContext.actual_diff).toContain('job failed');
    expect(handedContext.ci_state).toBeDefined();
    db.close();
  });

  it('leaves task resumable and does not crash CI observation when all managers are unavailable', async () => {
    const { db, store, row } = setup();
    store.recordManagerResource('primary', 'CREDITS_EXHAUSTED', 'exhausted');
    const pool = new ManagerProviderPool(store, [
      { id: 'primary', priority: 100, enabled: true, review: async () => ({ run: { status: 'SUCCESSFUL_PROCESS_EXIT', exitCode: 0, executionId: '', stdout: '', stderr: '', durationMs: 1 } }) },
    ]);
    const observer = new GithubCiObserver(store, process.cwd(), pool, async (_exe, args) => ({
      status: 0, stderr: '', stdout: args[0] === 'pr' ? JSON.stringify({ number: 66, isDraft: true, headRefName: row.branch, headRefOid: sha, statusCheckRollup: [{ name: 'Fast', status: 'COMPLETED', conclusion: 'FAILURE', databaseId: 789, detailsUrl: 'https://github.com/owner/repo/actions/runs/1003/job/789' }] }) : 'job failed: timeout',
    }));
    const watch = observer.register({ taskId: row.task_id, workOrderId: row.id, repository: 'owner/repo', prNumber: 66, branch: row.branch, expectedHeadSha: sha });
    const result = await observer.observe(watch);
    expect(result.conclusion).toBe('FAILURE');
    expect(result.review).toBeUndefined();
    expect(result.managerRun?.stderr).toBe('ALL_MANAGER_RESOURCES_UNAVAILABLE');
    expect(store.getWorkOrder(row.id)?.state).toBe('CI_WAIT');
    expect(store.listDueCiWatches()).toHaveLength(0);
    db.close();
  });

  it('resolves workflow run ID from detailsUrl instead of databaseId when collecting failure evidence', async () => {
    const { db, store } = setup();
    const invokedRunIds: string[] = [];
    const observer = new GithubCiObserver(store, process.cwd(), undefined, async (_exe, args) => {
      if (args[0] === 'run' && args[1] === 'view') {
        invokedRunIds.push(args[2]);
        return { status: 0, stdout: 'job log: failed at step 4', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const checks = [
      {
        name: 'Unit Tests',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        databaseId: 999111,
        detailsUrl: 'https://github.com/owner/repo/actions/runs/555444333/job/999111',
      },
    ];

    const evidence = await observer.failureEvidence('owner/repo', checks);
    expect(invokedRunIds).toEqual(['555444333']);
    expect(invokedRunIds).not.toContain('999111');
    expect(evidence).toContain('job log: failed at step 4');
    db.close();
  });

  it('gracefully handles checks without detailsUrl or with non-actions URL without invoking gh run view with databaseId', async () => {
    const { db, store } = setup();
    let runViewInvoked = false;
    const observer = new GithubCiObserver(store, process.cwd(), undefined, async (_exe, args) => {
      if (args[0] === 'run' && args[1] === 'view') {
        runViewInvoked = true;
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const checks = [
      {
        name: 'External CI',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        databaseId: 12345,
        detailsUrl: 'https://external-ci.example.com/build/12345',
      },
      {
        name: 'Missing URL',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        databaseId: 67890,
      },
    ];

    const evidence = await observer.failureEvidence('owner/repo', checks);
    expect(runViewInvoked).toBe(false);
    expect(evidence).toContain('External CI: https://external-ci.example.com/build/12345');
    expect(evidence).toContain('Missing URL: no details URL');
    db.close();
  });
});
