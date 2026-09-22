import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MigrationRunner } from '../src/core/database/migrations';
import { AutonomyStore } from '../src/core/autonomy/store';
import {
  ManagerProviderPool,
  ManagerContextPackage,
  ManagerContextPackageSchema,
  buildManagerContextPackage,
  classify,
} from '../src/core/autonomy/managerPool';
import { createWorkOrder, ManagerReview, WorkOrder } from '../src/core/autonomy/contracts';

const sha = 'a'.repeat(40);
function makeOrder(taskId = 'pool-task'): WorkOrder {
  return createWorkOrder({
    taskId,
    workerId: 'agy-01',
    objective: 'review and fix',
    baseSha: sha,
    branch: 'agent/pool',
    worktree: 'D:/Projects/AI/Agent-Forge-Worktrees/pool',
    acceptanceCriteria: ['passes deterministic tests'],
    allowedPaths: ['src'],
    requiredTests: ['npm test'],
    constraints: ['no commands'],
  });
}

function context(head = sha): ManagerContextPackage {
  const order = makeOrder();
  return buildManagerContextPackage({
    workOrder: order,
    currentHead: head,
    actualDiff: 'diff content',
    changedFiles: ['src/a.ts'],
    deterministicTests: [{ command: 'npm test', exitCode: 0 }],
    previousManagerDecisions: [{ verdict: 'REPAIR', reason: 'prior attempt' }],
    repairHistory: [{ attempt: 1, action: 'repaired syntax' }],
    prState: { number: 42, branch: 'agent/pool' },
    ciState: { status: 'failure', check: 'Fast' },
    architecturePolicyContext: ['Supervisor owns leases and verification', 'PASS requires exact HEAD match'],
  });
}

function run(stderr = '', exitCode = 1): any {
  return {
    status: exitCode === 0 ? 'SUCCESSFUL_PROCESS_EXIT' : 'FAILED_PROCESS_EXIT',
    exitCode,
    executionId: 'x',
    stdout: '',
    stderr,
    durationMs: 1,
  };
}

function pass(head = sha): ManagerReview {
  return {
    protocol_version: 'managerreview.v1',
    verdict: 'PASS',
    reviewed_head_sha: head,
    findings: [],
    required_actions: [],
    risk: 'LOW',
    notes: '',
  };
}

function setup() {
  const db = new Database(':memory:');
  MigrationRunner.run(db);
  return { db, store: new AutonomyStore(db) };
}

describe('manager provider pool', () => {
  it('primary credits exhaustion records state and skips primary on subsequent calls', async () => {
    const { db, store } = setup();
    let primaryCalls = 0;
    const pool = new ManagerProviderPool(store, [
      {
        id: 'codex-chatgpt-primary',
        priority: 100,
        enabled: true,
        review: async () => {
          primaryCalls++;
          return { run: run('Your workspace is out of credits') };
        },
      },
      {
        id: 'codex-api-fallback',
        priority: 50,
        enabled: true,
        review: async () => ({ run: run('', 0), review: pass() }),
      },
    ]);

    const res1 = await pool.review(context());
    expect(res1.resource_id).toBe('codex-api-fallback');
    expect(res1.review?.verdict).toBe('PASS');
    expect(primaryCalls).toBe(1);
    expect(store.getManagerResourceHealth('codex-chatgpt-primary')?.state).toBe('CREDITS_EXHAUSTED');
    expect(store.getManagerResourceHealth('codex-chatgpt-primary')?.cooldown_until).toBeNull();

    // Subsequent call should skip primary without invoking it
    const res2 = await pool.review(context());
    expect(res2.resource_id).toBe('codex-api-fallback');
    expect(primaryCalls).toBe(1);
    db.close();
  });

  it('cooldown activation records RATE_LIMITED with cooldown_until timestamp', async () => {
    const { db, store } = setup();
    const pool = new ManagerProviderPool(store, [
      {
        id: 'primary',
        priority: 100,
        enabled: true,
        review: async () => ({ run: run('HTTP 429 Too Many Requests: rate limit exceeded') }),
      },
    ]);

    await pool.review(context());
    const health = store.getManagerResourceHealth('primary');
    expect(health?.state).toBe('RATE_LIMITED');
    expect(health?.cooldown_until).toBeDefined();
    expect(Date.parse(health!.cooldown_until!)).toBeGreaterThan(Date.now());
    db.close();
  });

  it('fallback selection picks eligible fallback when primary is in cooldown or exhausted', async () => {
    const { db, store } = setup();
    store.recordManagerResource('primary', 'RATE_LIMITED', 'rate limit', new Date(Date.now() + 60_000).toISOString());
    let primaryCalled = false;
    let fallbackCalled = false;
    const pool = new ManagerProviderPool(store, [
      {
        id: 'primary',
        priority: 100,
        enabled: true,
        review: async () => {
          primaryCalled = true;
          return { run: run('', 0), review: pass() };
        },
      },
      {
        id: 'fallback',
        priority: 50,
        enabled: true,
        review: async () => {
          fallbackCalled = true;
          return { run: run('', 0), review: pass() };
        },
      },
    ]);

    const result = await pool.review(context());
    expect(primaryCalled).toBe(false);
    expect(fallbackCalled).toBe(true);
    expect(result.resource_id).toBe('fallback');
    expect(result.review?.verdict).toBe('PASS');
    db.close();
  });

  it('no tight retry loop avoids invoking cooled-down resources across repeated calls', async () => {
    const { db, store } = setup();
    let calls = 0;
    const pool = new ManagerProviderPool(store, [
      {
        id: 'primary',
        priority: 100,
        enabled: true,
        review: async () => {
          calls++;
          return { run: run('rate limit') };
        },
      },
    ]);

    await pool.review(context());
    await pool.review(context());
    await pool.review(context());
    expect(calls).toBe(1);
    db.close();
  });

  it('recovery after cooldown allows manager to be reinvoked and restored to AVAILABLE', async () => {
    const { db, store } = setup();
    let calls = 0;
    store.recordManagerResource('primary', 'COOLDOWN', 'earlier cooldown', new Date(Date.now() - 1000).toISOString());

    const pool = new ManagerProviderPool(store, [
      {
        id: 'primary',
        priority: 100,
        enabled: true,
        review: async () => {
          calls++;
          return { run: run('', 0), review: pass() };
        },
      },
    ]);

    const result = await pool.review(context());
    expect(calls).toBe(1);
    expect(result.resource_id).toBe('primary');
    expect(result.review?.verdict).toBe('PASS');
    expect(store.getManagerResourceHealth('primary')?.state).toBe('AVAILABLE');
    expect(store.getManagerResourceHealth('primary')?.cooldown_until).toBeNull();
    db.close();
  });

  it('all managers unavailable returns durable unavailable result for review and planning', async () => {
    const { db, store } = setup();
    store.recordManagerResource('primary', 'CREDITS_EXHAUSTED', 'no credits');
    store.recordManagerResource('fallback', 'RATE_LIMITED', 'rate limited', new Date(Date.now() + 60_000).toISOString());

    let reviewCalls = 0;
    let planCalls = 0;
    const pool = new ManagerProviderPool(store, [
      {
        id: 'primary',
        priority: 100,
        enabled: true,
        review: async () => { reviewCalls++; return { run: run('', 0) }; },
        plan: async () => { planCalls++; return { run: run('', 0) }; },
      },
      {
        id: 'fallback',
        priority: 50,
        enabled: true,
        review: async () => { reviewCalls++; return { run: run('', 0) }; },
        plan: async () => { planCalls++; return { run: run('', 0) }; },
      },
    ]);

    const reviewResult = await pool.review(context());
    expect(reviewResult.review).toBeUndefined();
    expect(reviewResult.run.stderr).toBe('ALL_MANAGER_RESOURCES_UNAVAILABLE');
    expect(reviewCalls).toBe(0);

    const planResult = await pool.plan(makeOrder());
    expect(planResult.workOrder).toBeUndefined();
    expect(planResult.run.stderr).toBe('ALL_MANAGER_RESOURCES_UNAVAILABLE');
    expect(planCalls).toBe(0);
    db.close();
  });

  it('durable context handoff preserves exact context package across failover', async () => {
    const { db, store } = setup();
    let handedContext: any = null;
    const ctx = context();

    const pool = new ManagerProviderPool(store, [
      {
        id: 'codex-chatgpt-primary',
        priority: 100,
        enabled: true,
        review: async () => ({ run: run('credits exhausted') }),
      },
      {
        id: 'codex-api-fallback',
        priority: 50,
        enabled: true,
        review: async ({ evidence }) => {
          handedContext = JSON.parse(evidence);
          return { run: run('', 0), review: pass() };
        },
      },
    ]);

    await pool.review(ctx);
    expect(handedContext).toBeTruthy();
    expect(ManagerContextPackageSchema.parse(handedContext)).toBeTruthy();
    expect(handedContext.protocol_version).toBe('managercontext.v1');
    expect(handedContext.task_identity.task_id).toBe('pool-task');
    expect(handedContext.work_order.task_id).toBe('pool-task');
    expect(handedContext.acceptance_criteria).toEqual(['passes deterministic tests']);
    expect(handedContext.base_sha).toBe(sha);
    expect(handedContext.current_head).toBe(sha);
    expect(handedContext.actual_diff).toBe('diff content');
    expect(handedContext.changed_files).toEqual(['src/a.ts']);
    expect(handedContext.deterministic_tests).toEqual([{ command: 'npm test', exitCode: 0 }]);
    expect(handedContext.previous_manager_decisions).toEqual([{ verdict: 'REPAIR', reason: 'prior attempt' }]);
    expect(handedContext.repair_history).toEqual([{ attempt: 1, action: 'repaired syntax' }]);
    expect(handedContext.pr_state).toEqual({ number: 42, branch: 'agent/pool' });
    expect(handedContext.ci_state).toEqual({ status: 'failure', check: 'Fast' });
    expect(handedContext.architecture_policy_context).toEqual([
      'Supervisor owns leases and verification',
      'PASS requires exact HEAD match',
    ]);
    db.close();
  });

  it('stale review rejection after provider switch fences verdict to REPAIR', async () => {
    const { db, store } = setup();
    const pool = new ManagerProviderPool(store, [
      {
        id: 'primary',
        priority: 100,
        enabled: true,
        review: async () => ({ run: run('workspace credit limit reached') }),
      },
      {
        id: 'fallback',
        priority: 50,
        enabled: true,
        review: async () => ({ run: run('', 0), review: pass('b'.repeat(40)) }),
      },
    ]);

    const result = await pool.review(context());
    expect(result.resource_id).toBe('fallback');
    expect(result.review?.verdict).toBe('REPAIR');
    expect(result.review?.findings.some((f) => f.title === 'STALE_REVIEW_HEAD')).toBe(true);
    db.close();
  });

  it('planning failover routes plan from exhausted primary to fallback', async () => {
    const { db, store } = setup();
    const seed = makeOrder();
    let primaryPlanned = false;
    let fallbackPlanned = false;

    const pool = new ManagerProviderPool(store, [
      {
        id: 'codex-chatgpt-primary',
        priority: 100,
        enabled: true,
        review: async () => ({ run: run('', 0) }),
        plan: async () => {
          primaryPlanned = true;
          return { run: run('Your workspace is out of credits') };
        },
      },
      {
        id: 'codex-api-fallback',
        priority: 50,
        enabled: true,
        review: async () => ({ run: run('', 0) }),
        plan: async (s) => {
          fallbackPlanned = true;
          return {
            run: run('', 0),
            workOrder: createWorkOrder({
              taskId: s.task_id,
              workerId: s.worker_id,
              objective: s.objective,
              baseSha: s.base_sha,
              branch: s.branch,
              worktree: s.worktree,
              acceptanceCriteria: s.acceptance_criteria,
              allowedPaths: s.allowed_paths,
              requiredTests: s.required_tests,
              constraints: s.constraints,
            }),
          };
        },
      },
    ]);

    const result = await pool.plan(seed);
    expect(primaryPlanned).toBe(true);
    expect(fallbackPlanned).toBe(true);
    expect(result.resource_id).toBe('codex-api-fallback');
    expect(result.workOrder?.task_id).toBe(seed.task_id);
    expect(store.getManagerResourceHealth('codex-chatgpt-primary')?.state).toBe('CREDITS_EXHAUSTED');
    db.close();
  });

  it('fails closed on malformed provider contracts and fails over to next provider', async () => {
    const { db, store } = setup();
    const pool = new ManagerProviderPool(store, [
      {
        id: 'malformed-primary',
        priority: 100,
        enabled: true,
        review: async () => ({ run: run('', 0), review: { invalid: 'schema' } as any }),
      },
      {
        id: 'valid-fallback',
        priority: 50,
        enabled: true,
        review: async () => ({ run: run('', 0), review: pass() }),
      },
    ]);

    const result = await pool.review(context());
    expect(result.resource_id).toBe('valid-fallback');
    expect(result.review?.verdict).toBe('PASS');
    expect(store.getManagerResourceHealth('malformed-primary')?.state).toBe('CONTRACT_INVALID');
    db.close();
  });

  it('does not recover ChatGPT capacity evidence onto an independent API fallback', () => {
    const { db, store } = setup();
    const legacy = createWorkOrder({
      taskId: 'legacy-task',
      workerId: 'agy-01',
      objective: 'legacy',
      baseSha: sha,
      branch: 'agent/legacy',
      worktree: 'D:/Projects/AI/Agent-Forge-Worktrees/legacy',
      acceptanceCriteria: ['passes'],
      allowedPaths: ['src'],
      requiredTests: ['npm test'],
    });
    const legacyRow = store.createWorkOrder(legacy);
    store.recordRun(legacyRow.id, 'codex-review', run('workspace out of credits'));
    new ManagerProviderPool(store, [
      { id: 'codex-chatgpt-primary', priority: 100, enabled: true, review: async () => ({ run: run('', 0), review: pass() }) },
      { id: 'codex-api-fallback', priority: 50, enabled: true, review: async () => ({ run: run('', 0), review: pass() }) },
    ]);
    expect(store.getManagerResourceHealth('codex-chatgpt-primary')?.state).toBe('CREDITS_EXHAUSTED');
    expect(store.getManagerResourceHealth('codex-api-fallback')).toBeNull();
    db.close();
  });

  it('classifies every durable provider health state', () => {
    expect(classify(run('', 0)).state).toBe('AVAILABLE');
    expect(classify({ ...run('unauthorized'), status: 'AUTH_ERROR' }).state).toBe('AUTH_ERROR');
    expect(classify(run('HTTP 429 rate limit')).state).toBe('RATE_LIMITED');
    expect(classify(run('workspace credits exhausted')).state).toBe('CREDITS_EXHAUSTED');
    expect(classify(run('provider cooldown active')).state).toBe('COOLDOWN');
    expect(classify({ ...run('missing'), status: 'PROCESS_NOT_FOUND' }).state).toBe('OFFLINE');
    expect(classify({ ...run('bad output'), status: 'CONTRACT_INVALID' }).state).toBe('CONTRACT_INVALID');
  });

  it('does not misclassify contract diagnostics mentioning authorization as auth failures', () => {
    expect(classify({
      ...run('CONTRACT_INVALID: routed manager changed authorized constraints'),
      status: 'CONTRACT_INVALID',
      error: 'CONTRACT_INVALID: routed manager changed authorized constraints',
    }).state)
      .toBe('CONTRACT_INVALID');
  });

  it('resumes a review from the durable context package after a provider switch', async () => {
    const { db, store } = setup();
    const first = new ManagerProviderPool(store, [{
      id: 'codex-chatgpt-primary', priority: 100, enabled: true,
      review: async () => ({ run: run('workspace credits exhausted') }),
    }]);
    const unavailable = await first.review(context());
    expect(unavailable.run.stderr).toBe('ALL_MANAGER_RESOURCES_UNAVAILABLE');

    const resumed = new ManagerProviderPool(store, [{
      id: 'codex-api-fallback', priority: 50, enabled: true,
      review: async ({ evidence }) => {
        expect(JSON.parse(evidence).previous_manager_decisions).toEqual([{ verdict: 'REPAIR', reason: 'prior attempt' }]);
        return { run: run('', 0), review: pass() };
      },
    }]);
    const result = await resumed.reviewStored(unavailable.context_sha, sha);
    expect(result.resource_id).toBe('codex-api-fallback');
    expect(result.review?.verdict).toBe('PASS');
    await expect(resumed.reviewStored(unavailable.context_sha, 'b'.repeat(40))).rejects.toThrow('STALE_MANAGER_CONTEXT_HEAD');
    db.close();
  });

  it('quarantines a successful process that returns no manager contract', async () => {
    const { db, store } = setup();
    let calls = 0;
    const pool = new ManagerProviderPool(store, [{
      id: 'empty', priority: 100, enabled: true,
      review: async () => { calls++; return { run: run('', 0) }; },
    }]);
    await pool.review(context());
    await pool.review(context());
    expect(calls).toBe(1);
    expect(store.getManagerResourceHealth('empty')?.state).toBe('CONTRACT_INVALID');
    db.close();
  });
});
