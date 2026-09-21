import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MigrationRunner } from '../src/core/database/migrations';
import { AutonomyStore } from '../src/core/autonomy/store';
import { ManagerProviderPool, ManagerContextPackage } from '../src/core/autonomy/managerPool';
import { createWorkOrder, ManagerReview } from '../src/core/autonomy/contracts';

const sha = 'a'.repeat(40);
function context(head = sha): ManagerContextPackage {
  const order = createWorkOrder({ taskId: 'pool-task', workerId: 'agy-01', objective: 'review', baseSha: sha, branch: 'agent/pool', worktree: 'D:/Projects/AI/Agent-Forge-Worktrees/pool', acceptanceCriteria: ['passes'], allowedPaths: ['src'], requiredTests: ['npm test'] });
  return { protocol_version: 'managercontext.v1', task_identity: { task_id: order.task_id, attempt: 1, worker_id: order.worker_id }, work_order: order, acceptance_criteria: order.acceptance_criteria, base_sha: sha, current_head: head, actual_diff: 'diff', changed_files: ['src/a.ts'], deterministic_tests: [{ command: 'npm test', exitCode: 0 }], previous_manager_decisions: [], repair_history: [], pr_state: {}, ci_state: {}, architecture_policy_context: ['lease and HEAD fencing'] };
}
function run(stderr = '', exitCode = 1): any { return { status: exitCode === 0 ? 'SUCCESSFUL_PROCESS_EXIT' : 'FAILED_PROCESS_EXIT', exitCode, executionId: 'x', stdout: '', stderr, durationMs: 1 }; }
function pass(head = sha): ManagerReview { return { protocol_version: 'managerreview.v1', verdict: 'PASS', reviewed_head_sha: head, findings: [], required_actions: [], risk: 'LOW', notes: '' }; }
function setup() { const db = new Database(':memory:'); MigrationRunner.run(db); return { db, store: new AutonomyStore(db) }; }

describe('manager provider pool', () => {
  it('fails over from credit exhaustion and preserves the same durable context', async () => {
    const { db, store } = setup(); let seen = '';
    const pool = new ManagerProviderPool(store, [
      { id: 'codex-chatgpt-primary', priority: 100, enabled: true, review: async ({ evidence }) => { seen = evidence; return { run: run('Your workspace is out of credits') }; } },
      { id: 'codex-api-fallback', priority: 50, enabled: true, review: async ({ evidence }) => { expect(evidence).toBe(seen); return { run: run('', 0), review: pass() }; } },
    ]);
    const result = await pool.review(context());
    expect(result.resource_id).toBe('codex-api-fallback'); expect(result.review?.verdict).toBe('PASS');
    expect(store.getManagerResourceHealth('codex-chatgpt-primary')?.state).toBe('CREDITS_EXHAUSTED');
    db.close();
  });

  it('records cooldown, avoids tight retries, and recovers after expiry', async () => {
    const { db, store } = setup(); let calls = 0;
    const pool = new ManagerProviderPool(store, [{ id: 'primary', priority: 1, enabled: true, review: async () => { calls++; return { run: run('rate limit') }; } }]);
    await pool.review(context()); await pool.review(context()); expect(calls).toBe(1);
    store.recordManagerResource('primary', 'COOLDOWN', null, new Date(Date.now() - 1).toISOString());
    const recovered = new ManagerProviderPool(store, [{ id: 'primary', priority: 1, enabled: true, review: async () => { calls++; return { run: run('', 0), review: pass() }; } }]);
    expect((await recovered.review(context())).review?.verdict).toBe('PASS'); expect(calls).toBe(2); db.close();
  });

  it('returns a durable unavailable result when every manager is unavailable', async () => {
    const { db, store } = setup(); store.recordManagerResource('primary', 'CREDITS_EXHAUSTED', 'credits');
    const result = await new ManagerProviderPool(store, [{ id: 'primary', priority: 1, enabled: true, review: async () => ({ run: run('', 0), review: pass() }) }]).review(context());
    expect(result.review).toBeUndefined(); expect(result.run.stderr).toContain('ALL_MANAGER_RESOURCES_UNAVAILABLE'); db.close();
  });

  it('rejects a stale review across a provider switch', async () => {
    const { db, store } = setup();
    const result = await new ManagerProviderPool(store, [{ id: 'fallback', priority: 1, enabled: true, review: async () => ({ run: run('', 0), review: pass('b'.repeat(40)) }) }]).review(context());
    expect(result.review?.verdict).toBe('REPAIR'); db.close();
  });
});

