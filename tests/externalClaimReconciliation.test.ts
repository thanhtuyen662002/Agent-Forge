import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MigrationRunner } from '../src/core/database/migrations';
import { AutonomyStore } from '../src/core/autonomy/store';
import { GithubCiObserver } from '../src/core/autonomy/github';
import {
  reconcileGithubPullRequestClaim,
  GithubPullRequestClaimSnapshot,
} from '../src/core/autonomy/externalClaimReconciliation';

const head = 'a'.repeat(40);
const otherHead = 'b'.repeat(40);

const watch = {
  repository: 'owner/repo',
  pr_number: 42,
  branch: 'agent/agy-01/task-42',
  expected_head_sha: head,
  work_order_id: 'work-order-42',
  task_id: 'task-42',
} as const;

function remote(overrides: Partial<GithubPullRequestClaimSnapshot> = {}): GithubPullRequestClaimSnapshot {
  return {
    number: watch.pr_number,
    isDraft: true,
    headRefName: watch.branch,
    headRefOid: head,
    ...overrides,
  };
}

function createStore(): { db: Database.Database; store: AutonomyStore } {
  const db = new Database(':memory:');
  MigrationRunner.run(db);
  return { db, store: new AutonomyStore(db) };
}

describe('external GitHub claim reconciliation contract', () => {
  it('accepts a valid first observation without requiring a prior claim', () => {
    const result = reconcileGithubPullRequestClaim(watch, remote(), null);
    expect(result.classification).toBe('CLAIM_MISSING');
    expect(result.valid).toBe(true);
    expect(result.canPersist).toBe(true);
    expect(result.failsClosed).toBe(false);
    expect(result.observedHeadSha).toBe(head);
  });

  it('accepts an existing claim only when it has the same owner', () => {
    const matched = reconcileGithubPullRequestClaim(watch, remote(), { work_order_id: watch.work_order_id, head_sha: head });
    expect(matched.classification).toBe('CLAIM_MATCHED');
    expect(matched.valid).toBe(true);

    const ownerMismatch = reconcileGithubPullRequestClaim(watch, remote(), { work_order_id: 'other-work-order', head_sha: head });
    expect(ownerMismatch.classification).toBe('LOCAL_CLAIM_OWNER_MISMATCH');
    expect(ownerMismatch.valid).toBe(false);
    expect(ownerMismatch.failsClosed).toBe(true);
  });

  it.each([
    ['PR_NUMBER_MISMATCH', remote({ number: 43 })],
    ['PR_NOT_DRAFT', remote({ isDraft: false })],
    ['PR_BRANCH_MISMATCH', remote({ headRefName: 'agent/other-branch' })],
    ['PR_HEAD_INVALID', remote({ headRefOid: 'not-a-sha' })],
    ['PR_HEAD_MISMATCH', remote({ headRefOid: otherHead })],
  ] as const)('fails closed for %s without allowing persistence', (classification, snapshot) => {
    const result = reconcileGithubPullRequestClaim(watch, snapshot, null);
    expect(result.classification).toBe(classification);
    expect(result.valid).toBe(false);
    expect(result.canPersist).toBe(false);
    expect(result.failsClosed).toBe(true);
  });

  it('rejects a malformed persisted claim instead of repairing it implicitly', () => {
    const result = reconcileGithubPullRequestClaim(watch, remote(), { work_order_id: watch.work_order_id, head_sha: 'bad' });
    expect(result.classification).toBe('LOCAL_CLAIM_INVALID');
    expect(result.valid).toBe(false);

    const missingHead = reconcileGithubPullRequestClaim(watch, remote(), { work_order_id: watch.work_order_id, head_sha: null });
    expect(missingHead.classification).toBe('LOCAL_CLAIM_INVALID');
    expect(missingHead.valid).toBe(false);
  });

  it('does not mutate a prior claim when observe receives a mismatched remote head', async () => {
    const { db, store } = createStore();
    const watchRow = store.registerCiWatch({
      taskId: watch.task_id,
      workOrderId: watch.work_order_id,
      repository: watch.repository,
      prNumber: watch.pr_number,
      branch: watch.branch,
      expectedHeadSha: head,
    });
    store.reconcileExternalClaim('github-pr', `${watch.repository}#${watch.pr_number}`, watch.work_order_id, head, 'OBSERVED');
    const observer = new GithubCiObserver(store, process.cwd(), undefined, async () => ({
      status: 0,
      stderr: '',
      stdout: JSON.stringify(remote({ headRefOid: otherHead })),
    }));

    const result = await observer.observe(watchRow);
    expect(result.conclusion).toBe('FAILURE');
    expect(result.headSha).toBe(otherHead);
    expect(store.getExternalClaim('github-pr', `${watch.repository}#${watch.pr_number}`)?.head_sha).toBe(head);
    expect((store.getDatabase().prepare('SELECT state FROM autonomy_ci_watches WHERE id=?').get(watchRow.id) as { state: string }).state).toBe('BLOCKED');
    db.close();
  });

  it('creates exactly one claim after a valid first observation', async () => {
    const { db, store } = createStore();
    const watchRow = store.registerCiWatch({
      taskId: watch.task_id,
      workOrderId: watch.work_order_id,
      repository: watch.repository,
      prNumber: watch.pr_number,
      branch: watch.branch,
      expectedHeadSha: head,
    });
    const observer = new GithubCiObserver(store, process.cwd(), undefined, async () => ({
      status: 0,
      stderr: '',
      stdout: JSON.stringify(remote()),
    }));

    const result = await observer.observe(watchRow);
    expect(result.conclusion).toBe('PENDING');
    expect(store.listExternalClaims('github-pr')).toHaveLength(1);
    expect(store.getExternalClaim('github-pr', `${watch.repository}#${watch.pr_number}`)).toMatchObject({
      work_order_id: watch.work_order_id,
      head_sha: head,
      state: 'OBSERVED',
    });
    db.close();
  });

  it('exposes deterministic claim reads for recovery and audit callers', () => {
    const { db, store } = createStore();
    store.reconcileExternalClaim('github-pr', 'z/repo#2', 'wo-z', otherHead, 'OBSERVED');
    store.reconcileExternalClaim('github-pr', 'a/repo#1', 'wo-a', head, 'OBSERVED');
    expect(store.listExternalClaims().map((claim) => claim.external_id)).toEqual(['a/repo#1', 'z/repo#2']);
    expect(store.listExternalClaims('github-pr')).toHaveLength(2);
    db.close();
  });

  it('uses an optional compare-and-set expectation to fence stale claim writers', () => {
    const { db, store } = createStore();
    const externalId = `${watch.repository}#${watch.pr_number}`;
    store.reconcileExternalClaim('github-pr', externalId, watch.work_order_id, head, 'OBSERVED');
    expect(() => store.reconcileExternalClaim(
      'github-pr',
      externalId,
      watch.work_order_id,
      otherHead,
      'OBSERVED',
      { work_order_id: watch.work_order_id, head_sha: 'c'.repeat(40) },
    )).toThrow('EXTERNAL_CLAIM_CHANGED');
    expect(store.getExternalClaim('github-pr', externalId)?.head_sha).toBe(head);
    db.close();
  });
});
