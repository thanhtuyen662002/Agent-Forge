import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  AutonomyStore,
  AutonomyCiReconciliation,
  CiReconciliationClassification,
  MergeIdentityType,
} from '../src/core/autonomy/store';
import {
  GithubCiObserver,
  evaluateCiReconciliation,
  buildPrHeadCiIdentity,
  buildMainPostMergeCiIdentity,
  isValidPrHeadCiEvent,
  isValidMainPostMergeCiEvent,
  determineMergeIdentityType,
  isPrHeadCiMissing,
  classifyChecks,
  GithubCheck,
  GithubPullRequest,
} from '../src/core/autonomy/github';

describe('CI Identity Reconciliation Semantics (TSK-CI-IDENTITY-RECONCILIATION)', () => {
  const repo = 'owner/repo';
  const prNum = 42;
  const shaA = '1111111111111111111111111111111111111111';
  const shaB = '2222222222222222222222222222222222222222';
  const shaC = '3333333333333333333333333333333333333333';

  describe('1. Distinct durable identities and event semantics', () => {
    it('constructs distinct deterministic identities for PR_HEAD_CI and MAIN_POST_MERGE_CI', () => {
      const prHeadId = buildPrHeadCiIdentity(repo, prNum, shaA);
      const mainPostMergeId = buildMainPostMergeCiIdentity(repo, shaB);

      expect(prHeadId).toBe(`PR_HEAD_CI:${repo}#${prNum}@${shaA}`);
      expect(mainPostMergeId).toBe(`MAIN_POST_MERGE_CI:${repo}@${shaB}`);
      expect(prHeadId).not.toBe(mainPostMergeId);
    });

    it('preserves distinct identities even in linear-history merges where SHAs are identical', () => {
      const prHeadId = buildPrHeadCiIdentity(repo, prNum, shaA);
      const mainPostMergeId = buildMainPostMergeCiIdentity(repo, shaA);

      expect(prHeadId).toBe(`PR_HEAD_CI:${repo}#${prNum}@${shaA}`);
      expect(mainPostMergeId).toBe(`MAIN_POST_MERGE_CI:${repo}@${shaA}`);
      expect(prHeadId).not.toBe(mainPostMergeId);
    });

    it('enforces exact Git SHA format (40 hex characters) for identity builders', () => {
      expect(() => buildPrHeadCiIdentity(repo, prNum, 'invalid-sha')).toThrow('Git SHA');
      expect(() => buildMainPostMergeCiIdentity(repo, 'short')).toThrow('Git SHA');
    });

    it('validates event contracts: PR_HEAD_CI is pull_request only, MAIN_POST_MERGE_CI is push only', () => {
      expect(isValidPrHeadCiEvent('pull_request')).toBe(true);
      expect(isValidPrHeadCiEvent('push')).toBe(false);
      expect(isValidPrHeadCiEvent('workflow_dispatch')).toBe(false);

      expect(isValidMainPostMergeCiEvent('push')).toBe(true);
      expect(isValidMainPostMergeCiEvent('pull_request')).toBe(false);
      expect(isValidMainPostMergeCiEvent('merge_group')).toBe(false);
    });

    it('deterministically classifies merge identity as SQUASH or LINEAR_HISTORY', () => {
      expect(determineMergeIdentityType(shaA, shaB)).toBe('SQUASH');
      expect(determineMergeIdentityType(shaA, shaA)).toBe('LINEAR_HISTORY');
      expect(determineMergeIdentityType(shaA.toUpperCase(), shaA.toLowerCase())).toBe('LINEAR_HISTORY');
    });
  });

  describe('2. Durable persistence and queryability in AutonomyStore', () => {
    function createTestStore(): AutonomyStore {
      const db = new Database(':memory:');
      return new AutonomyStore(db);
    }

    it('persists and retrieves CI reconciliation records with all required fields', () => {
      const store = createTestStore();
      const prHeadId = buildPrHeadCiIdentity(repo, prNum, shaA);
      const mainId = buildMainPostMergeCiIdentity(repo, shaB);

      const record = store.recordCiReconciliation({
        repository: repo,
        prNumber: prNum,
        prHeadSha: shaA,
        mergedMainSha: shaB,
        prHeadCiIdentity: prHeadId,
        prHeadEvent: 'pull_request',
        prHeadConclusion: 'SUCCESS',
        mainPostMergeCiIdentity: mainId,
        mainPostMergeEvent: 'push',
        mainPostMergeConclusion: 'SUCCESS',
        reconciliationClassification: 'DIFFERENT_MERGE_SHA_PUSH_SUCCESS',
        mergeIdentityType: 'SQUASH',
        details: { verifiedBy: 'supervisor' },
      });

      expect(record.id).toBeDefined();
      expect(record.repository).toBe(repo);
      expect(record.pr_number).toBe(prNum);
      expect(record.pr_head_sha).toBe(shaA);
      expect(record.merged_main_sha).toBe(shaB);
      expect(record.pr_head_ci_identity).toBe(prHeadId);
      expect(record.pr_head_event).toBe('pull_request');
      expect(record.pr_head_conclusion).toBe('SUCCESS');
      expect(record.main_post_merge_ci_identity).toBe(mainId);
      expect(record.main_post_merge_event).toBe('push');
      expect(record.main_post_merge_conclusion).toBe('SUCCESS');
      expect(record.reconciliation_classification).toBe('DIFFERENT_MERGE_SHA_PUSH_SUCCESS');
      expect(record.merge_identity_type).toBe('SQUASH');

      // Query by ID
      const byId = store.getCiReconciliation(record.id);
      expect(byId).not.toBeNull();
      expect(byId?.id).toBe(record.id);

      // Query by PR
      const byPr = store.getCiReconciliationByPr(repo, prNum);
      expect(byPr).not.toBeNull();
      expect(byPr?.pr_head_sha).toBe(shaA);

      // Query by PR and head SHA
      const byPrAndHead = store.getCiReconciliationByPrAndHead(repo, prNum, shaA);
      expect(byPrAndHead).not.toBeNull();
      expect(byPrAndHead?.merged_main_sha).toBe(shaB);

      // Query by head SHA
      const byHead = store.findCiReconciliationsByHeadSha(shaA);
      expect(byHead.length).toBe(1);
      expect(byHead[0].pr_head_sha).toBe(shaA);

      // Query by main SHA
      const byMain = store.findCiReconciliationsByMainSha(shaB);
      expect(byMain.length).toBe(1);
      expect(byMain[0].merged_main_sha).toBe(shaB);

      // List with filter
      const list = store.listCiReconciliations({ repository: repo, classification: 'DIFFERENT_MERGE_SHA_PUSH_SUCCESS' });
      expect(list.length).toBe(1);
    });

    it('updates existing record on conflict for same PR and head SHA', () => {
      const store = createTestStore();
      const initial = store.recordCiReconciliation({
        repository: repo,
        prNumber: prNum,
        prHeadSha: shaA,
        mergedMainSha: null,
        reconciliationClassification: 'PR_HEAD_SUCCESS',
        prHeadConclusion: 'SUCCESS',
      });
      expect(initial.reconciliation_classification).toBe('PR_HEAD_SUCCESS');

      // Now merged with different main SHA
      const updated = store.recordCiReconciliation({
        repository: repo,
        prNumber: prNum,
        prHeadSha: shaA,
        mergedMainSha: shaB,
        reconciliationClassification: 'DIFFERENT_MERGE_SHA_PUSH_SUCCESS',
        prHeadConclusion: 'SUCCESS',
        mainPostMergeConclusion: 'SUCCESS',
      });

      expect(updated.merged_main_sha).toBe(shaB);
      expect(updated.reconciliation_classification).toBe('DIFFERENT_MERGE_SHA_PUSH_SUCCESS');

      const all = store.findCiReconciliationsByHeadSha(shaA);
      expect(all.length).toBe(1);
    });
  });

  describe('3. Evaluation: PR-head success (pre-merge)', () => {
    it('evaluates successful PR-head CI as PR_HEAD_SUCCESS and valid', () => {
      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        prHeadEvent: 'pull_request',
        prHeadChecks: [
          { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA },
          { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA },
        ],
      });

      expect(result.classification).toBe('PR_HEAD_SUCCESS');
      expect(result.isValid).toBe(true);
      expect(result.failsClosed).toBe(false);
      expect(result.prHeadConclusion).toBe('SUCCESS');
      expect(result.mergedMainSha).toBeNull();
      expect(result.mainPostMergeConclusion).toBeNull();
      expect(result.mergeIdentityType).toBe('NONE');
      expect(isPrHeadCiMissing(result)).toBe(false);
    });
  });

  describe('4. Evaluation: A different merged SHA with successful push CI (Squash merge)', () => {
    it('reconciles squash merge without classifying PR-head CI as missing', () => {
      const prChecks: GithubCheck[] = [
        { name: 'pr-test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA },
      ];
      const mainChecks: GithubCheck[] = [
        { name: 'main-build', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'push', headSha: shaB },
      ];

      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        prHeadEvent: 'pull_request',
        prHeadChecks: prChecks,
        mergedMainSha: shaB,
        mainPushEvent: 'push',
        mainPushChecks: mainChecks,
      });

      expect(result.classification).toBe('DIFFERENT_MERGE_SHA_PUSH_SUCCESS');
      expect(result.mergeIdentityType).toBe('SQUASH');
      expect(result.isValid).toBe(true);
      expect(result.failsClosed).toBe(false);
      expect(result.prHeadSha).toBe(shaA);
      expect(result.mergedMainSha).toBe(shaB);
      expect(result.prHeadConclusion).toBe('SUCCESS');
      expect(result.mainPostMergeConclusion).toBe('SUCCESS');

      // CRITICAL ACCEPTANCE CRITERIA: A different merge SHA must not classify PR-head CI as missing!
      expect(isPrHeadCiMissing(result)).toBe(false);
    });
  });

  describe('5. Evaluation: Linear-history merge with successful push CI', () => {
    it('reconciles linear history merge preserving distinct identities for PR and main', () => {
      const prChecks: GithubCheck[] = [
        { name: 'ci/unit', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA },
      ];
      const mainChecks: GithubCheck[] = [
        { name: 'ci/deploy-check', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'push', headSha: shaA },
      ];

      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        prHeadEvent: 'pull_request',
        prHeadChecks: prChecks,
        mergedMainSha: shaA, // Linear history: main SHA equals PR head SHA
        mainPushEvent: 'push',
        mainPushChecks: mainChecks,
      });

      expect(result.classification).toBe('LINEAR_HISTORY_MERGE_PUSH_SUCCESS');
      expect(result.mergeIdentityType).toBe('LINEAR_HISTORY');
      expect(result.isValid).toBe(true);
      expect(result.failsClosed).toBe(false);
      expect(result.prHeadSha).toBe(shaA);
      expect(result.mergedMainSha).toBe(shaA);
      expect(result.prHeadCiIdentity).toBe(`PR_HEAD_CI:${repo}#${prNum}@${shaA}`);
      expect(result.mainPostMergeCiIdentity).toBe(`MAIN_POST_MERGE_CI:${repo}@${shaA}`);
      expect(result.prHeadCiIdentity).not.toBe(result.mainPostMergeCiIdentity);
      expect(isPrHeadCiMissing(result)).toBe(false);
    });
  });

  describe('6. Fail-closed: Actual missing post-merge CI', () => {
    it('fails closed when PR is merged but main push CI checks are completely missing', () => {
      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        prHeadEvent: 'pull_request',
        prHeadChecks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA }],
        mergedMainSha: shaB,
        mainPushEvent: 'push',
        mainPushChecks: null, // No post-merge push checks found
      });

      expect(result.classification).toBe('MISSING_POST_MERGE_CI');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
      expect(result.mainPostMergeConclusion).toBeNull();

      // Note: PR-head CI was successful; it is not missing! The missing CI is specifically post-merge CI.
      expect(result.prHeadConclusion).toBe('SUCCESS');
      expect(isPrHeadCiMissing(result)).toBe(false);
    });

    it('fails closed when mainPushEvent is not "push"', () => {
      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        prHeadEvent: 'pull_request',
        prHeadChecks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA }],
        mergedMainSha: shaB,
        mainPushEvent: 'pull_request', // Invalid for post-merge main CI
        mainPushChecks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'push', headSha: shaB }],
      });

      expect(result.classification).toBe('MISSING_POST_MERGE_CI');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
    });

    it('fails closed when main push checks only contain pull_request check-runs (not push)', () => {
      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        prHeadEvent: 'pull_request',
        prHeadChecks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA }],
        mergedMainSha: shaB,
        mainPushEvent: 'push',
        mainPushChecks: [
          { name: 'pr-check', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaB },
        ],
      });

      expect(result.classification).toBe('MISSING_POST_MERGE_CI');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
    });

    it('fails closed when main push checks contain checks with mismatched SHA', () => {
      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        prHeadEvent: 'pull_request',
        prHeadChecks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA }],
        mergedMainSha: shaB,
        mainPushEvent: 'push',
        mainPushChecks: [
          { name: 'wrong-sha-run', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'push', headSha: shaC },
        ],
      });

      expect(result.classification).toBe('MISSING_POST_MERGE_CI');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
    });
  });

  describe('7. Fail-closed: Stale PR-head evidence', () => {
    it('fails closed when observed PR head SHA does not match expected SHA', () => {
      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        observedPrHeadSha: shaB, // Stale/mismatched observed head
        prHeadEvent: 'pull_request',
        prHeadChecks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA }],
      });

      expect(result.classification).toBe('STALE_PR_HEAD_CI');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
    });

    it('fails closed when PR head checks contain STALE conclusion', () => {
      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        prHeadEvent: 'pull_request',
        prHeadChecks: [
          { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA },
          { name: 'lint', status: 'COMPLETED', conclusion: 'STALE', event: 'pull_request', headSha: shaA },
        ],
      });

      expect(result.classification).toBe('STALE_PR_HEAD_CI');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
    });

    it('fails closed when PR head event is not "pull_request"', () => {
      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        prHeadEvent: 'push', // Invalid event for PR_HEAD_CI
        prHeadChecks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA }],
      });

      expect(result.classification).toBe('STALE_PR_HEAD_CI');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
    });

    it('fails closed when PR head checks contain non-pull_request event', () => {
      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        prHeadEvent: 'pull_request',
        prHeadChecks: [
          { name: 'push-check-on-pr', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'push', headSha: shaA },
        ],
      });

      expect(result.classification).toBe('STALE_PR_HEAD_CI');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
    });

    it('fails closed when PR head checks contain mismatched head SHA', () => {
      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        prHeadEvent: 'pull_request',
        prHeadChecks: [
          { name: 'wrong-sha-check', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaB },
        ],
      });

      expect(result.classification).toBe('STALE_PR_HEAD_CI');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
    });
  });

  describe('8. Fail-closed: Superseded head', () => {
    it('fails closed when current PR branch head on GitHub has moved beyond expected head SHA', () => {
      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        currentPrHeadOid: shaC, // PR branch has newer commit shaC
        prHeadEvent: 'pull_request',
        prHeadChecks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA }],
      });

      expect(result.classification).toBe('SUPERSEDED_HEAD');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
    });
  });

  describe('9. Existing GithubCiObserver exact-head fencing and repair behavior unchanged', () => {
    function createTestStore(): AutonomyStore {
      const db = new Database(':memory:');
      return new AutonomyStore(db);
    }

    it('preserves exact-head fencing: observe() blocks watch on head mismatch', async () => {
      const store = createTestStore();
      const observer = new GithubCiObserver(store, 'C:\\dummy-repo', undefined, async (exec, args) => {
        if (exec === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          const pr: GithubPullRequest = {
            number: prNum,
            isDraft: true,
            headRefName: 'feature-branch',
            headRefOid: shaB, // Does NOT match expected shaA
            statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
          };
          return { status: 0, stdout: JSON.stringify(pr), stderr: '' };
        }
        return { status: 1, stdout: '', stderr: 'command not found' };
      });

      const watch = store.registerCiWatch({
        taskId: 'TSK-1',
        repository: repo,
        prNumber: prNum,
        branch: 'feature-branch',
        expectedHeadSha: shaA,
      });

      const result = await observer.observe(watch);
      expect(result.conclusion).toBe('FAILURE');
      expect(result.headSha).toBe(shaB);

      // Verify watch state was set to BLOCKED due to CI_HEAD_MISMATCH
      const updatedWatch = store.getDatabase().prepare('SELECT * FROM autonomy_ci_watches WHERE id=?').get(watch.id) as { state: string };
      expect(updatedWatch.state).toBe('BLOCKED');
    });

    it('preserves draft and branch fencing: observe() blocks on non-draft or wrong branch', async () => {
      const store = createTestStore();
      const observer = new GithubCiObserver(store, 'C:\\dummy-repo', undefined, async () => {
        const pr: GithubPullRequest = {
          number: prNum,
          isDraft: false, // Not draft
          headRefName: 'feature-branch',
          headRefOid: shaA,
        };
        return { status: 0, stdout: JSON.stringify(pr), stderr: '' };
      });

      const watch = store.registerCiWatch({
        taskId: 'TSK-2',
        repository: repo,
        prNumber: prNum,
        branch: 'feature-branch',
        expectedHeadSha: shaA,
      });

      const result = await observer.observe(watch);
      expect(result.conclusion).toBe('FAILURE');

      const updatedWatch = store.getDatabase().prepare('SELECT * FROM autonomy_ci_watches WHERE id=?').get(watch.id) as { state: string };
      expect(updatedWatch.state).toBe('BLOCKED');
    });

    it('reconciles merged PR via observer and stores durable record', async () => {
      const store = createTestStore();
      const observer = new GithubCiObserver(store, 'C:\\dummy-repo', undefined, async (exec, args) => {
        if (exec === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return {
            status: 0,
            stdout: JSON.stringify({
              number: prNum,
              isDraft: false,
              headRefName: 'feature-branch',
              headRefOid: shaA,
              mergedAt: '2026-09-23T10:00:00Z',
              mergeCommit: { oid: shaB },
              statusCheckRollup: [{ name: 'pr-test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA }],
            }),
            stderr: '',
          };
        }
        if (exec === 'gh' && args[0] === 'api' && args[1].includes(shaB)) {
          return {
            status: 0,
            stdout: JSON.stringify([
              { name: 'main-push-test', status: 'completed', conclusion: 'success', html_url: 'https://ci.example/1', event: 'push', head_sha: shaB },
            ]),
            stderr: '',
          };
        }
        return { status: 1, stdout: '', stderr: 'unknown command' };
      });

      const result = await observer.observeAndReconcileMergedPr({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        mergedMainSha: shaB,
      });

      expect(result.classification).toBe('DIFFERENT_MERGE_SHA_PUSH_SUCCESS');
      expect(result.isValid).toBe(true);
      expect(result.mergeIdentityType).toBe('SQUASH');
      expect(result.prHeadSha).toBe(shaA);
      expect(result.mergedMainSha).toBe(shaB);

      // Verify stored in AutonomyStore
      const stored = store.getCiReconciliationByPr(repo, prNum);
      expect(stored).not.toBeNull();
      expect(stored?.pr_head_sha).toBe(shaA);
      expect(stored?.merged_main_sha).toBe(shaB);
      expect(stored?.reconciliation_classification).toBe('DIFFERENT_MERGE_SHA_PUSH_SUCCESS');
      expect(stored?.merge_identity_type).toBe('SQUASH');
    });

    it('fails closed in observer when post-merge commit has NO push workflow run (provenance gap repaired)', async () => {
      const store = createTestStore();
      const observer = new GithubCiObserver(store, 'C:\\dummy-repo', undefined, async (exec, args) => {
        if (exec === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return {
            status: 0,
            stdout: JSON.stringify({
              number: prNum,
              isDraft: false,
              headRefName: 'feature-branch',
              headRefOid: shaA,
              mergedAt: '2026-09-23T10:00:00Z',
              mergeCommit: { oid: shaB },
              statusCheckRollup: [{ name: 'pr-test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA }],
            }),
            stderr: '',
          };
        }
        if (exec === 'gh' && args[0] === 'api' && args[1].includes('actions/runs')) {
          // GitHub Actions API query for event=push returns empty array (no push workflow ran)
          return {
            status: 0,
            stdout: JSON.stringify([]),
            stderr: '',
          };
        }
        return { status: 1, stdout: '', stderr: 'unknown command' };
      });

      const result = await observer.observeAndReconcileMergedPr({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        mergedMainSha: shaB,
      });

      expect(result.classification).toBe('MISSING_POST_MERGE_CI');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
      expect(result.mainPostMergeConclusion).toBeNull();
      // PR head CI is NOT classified as missing because PR head CI succeeded
      expect(isPrHeadCiMissing(result)).toBe(false);
    });

    it('fails closed in observer when Actions runs API returns runs for non-push event', async () => {
      const store = createTestStore();
      const observer = new GithubCiObserver(store, 'C:\\dummy-repo', undefined, async (exec, args) => {
        if (exec === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return {
            status: 0,
            stdout: JSON.stringify({
              number: prNum,
              isDraft: false,
              headRefName: 'feature-branch',
              headRefOid: shaA,
              mergedAt: '2026-09-23T10:00:00Z',
              mergeCommit: { oid: shaB },
              statusCheckRollup: [{ name: 'pr-test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA }],
            }),
            stderr: '',
          };
        }
        if (exec === 'gh' && args[0] === 'api' && args[1].includes('actions/runs')) {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                id: 102,
                name: 'pr-check-on-commit',
                head_sha: shaB,
                event: 'pull_request', // Non-push run must be rejected
                status: 'completed',
                conclusion: 'success',
              },
            ]),
            stderr: '',
          };
        }
        return { status: 1, stdout: '', stderr: 'unknown command' };
      });

      const result = await observer.observeAndReconcileMergedPr({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        mergedMainSha: shaB,
      });

      expect(result.classification).toBe('MISSING_POST_MERGE_CI');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
    });

    it('handles full GitHub Actions API payload with workflow_runs wrapper and event=push', async () => {
      const store = createTestStore();
      const observer = new GithubCiObserver(store, 'C:\\dummy-repo', undefined, async (exec, args) => {
        if (exec === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return {
            status: 0,
            stdout: JSON.stringify({
              number: prNum,
              isDraft: false,
              headRefName: 'feature-branch',
              headRefOid: shaA,
              mergedAt: '2026-09-23T10:00:00Z',
              mergeCommit: { oid: shaB },
              statusCheckRollup: [{ name: 'pr-test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA }],
            }),
            stderr: '',
          };
        }
        if (exec === 'gh' && args[0] === 'api' && args[1].includes('actions/runs')) {
          return {
            status: 0,
            stdout: JSON.stringify({
              total_count: 1,
              workflow_runs: [
                {
                  id: 999,
                  name: 'ci-pipeline',
                  head_sha: shaB,
                  event: 'push',
                  status: 'completed',
                  conclusion: 'success',
                  html_url: 'https://github.com/owner/repo/actions/runs/999',
                },
              ],
            }),
            stderr: '',
          };
        }
        return { status: 1, stdout: '', stderr: 'unknown command' };
      });

      const result = await observer.observeAndReconcileMergedPr({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        mergedMainSha: shaB,
      });

      expect(result.classification).toBe('DIFFERENT_MERGE_SHA_PUSH_SUCCESS');
      expect(result.isValid).toBe(true);
      expect(result.failsClosed).toBe(false);
      expect(result.mainPostMergeConclusion).toBe('SUCCESS');
    });
  });

  describe('10. Fail-closed provenance enforcement: missing event, missing SHA, both missing, conclusion-only', () => {
    // A. PR-head checks
    it('fails closed on PR-head when event is missing from check', () => {
      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        prHeadEvent: 'pull_request',
        prHeadChecks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', headSha: shaA }], // missing event
      });

      expect(result.classification).toBe('STALE_PR_HEAD_CI');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
      expect(result.prHeadConclusion).toBeNull();
    });

    it('fails closed on PR-head when head SHA is missing from check', () => {
      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        prHeadEvent: 'pull_request',
        prHeadChecks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request' }], // missing headSha
      });

      expect(result.classification).toBe('STALE_PR_HEAD_CI');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
      expect(result.prHeadConclusion).toBeNull();
    });

    it('fails closed on PR-head when both event and head SHA are missing from check', () => {
      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        prHeadEvent: 'pull_request',
        prHeadChecks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], // both missing
      });

      expect(result.classification).toBe('STALE_PR_HEAD_CI');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
      expect(result.prHeadConclusion).toBeNull();
    });

    it('fails closed when PR-head has conclusion-only success without qualifying observed runs', () => {
      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        prHeadEvent: 'pull_request',
        prHeadConclusion: 'SUCCESS', // Conclusion-only success
        prHeadChecks: [], // No qualifying runs
      });

      expect(result.classification).toBe('STALE_PR_HEAD_CI');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
      expect(result.prHeadConclusion).toBeNull();
    });

    // B. Post-merge main push checks
    it('fails closed on post-merge when event is missing from push check', () => {
      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        prHeadEvent: 'pull_request',
        prHeadChecks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA }],
        mergedMainSha: shaB,
        mainPushEvent: 'push',
        mainPushChecks: [{ name: 'push-test', status: 'COMPLETED', conclusion: 'SUCCESS', headSha: shaB }], // missing event
      });

      expect(result.classification).toBe('MISSING_POST_MERGE_CI');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
      expect(result.mainPostMergeConclusion).toBeNull();
      expect(isPrHeadCiMissing(result)).toBe(false);
    });

    it('fails closed on post-merge when head SHA is missing from push check', () => {
      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        prHeadEvent: 'pull_request',
        prHeadChecks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA }],
        mergedMainSha: shaB,
        mainPushEvent: 'push',
        mainPushChecks: [{ name: 'push-test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'push' }], // missing headSha
      });

      expect(result.classification).toBe('MISSING_POST_MERGE_CI');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
      expect(result.mainPostMergeConclusion).toBeNull();
      expect(isPrHeadCiMissing(result)).toBe(false);
    });

    it('fails closed on post-merge when both event and head SHA are missing from push check', () => {
      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        prHeadEvent: 'pull_request',
        prHeadChecks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA }],
        mergedMainSha: shaB,
        mainPushEvent: 'push',
        mainPushChecks: [{ name: 'push-test', status: 'COMPLETED', conclusion: 'SUCCESS' }], // both missing
      });

      expect(result.classification).toBe('MISSING_POST_MERGE_CI');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
      expect(result.mainPostMergeConclusion).toBeNull();
      expect(isPrHeadCiMissing(result)).toBe(false);
    });

    it('fails closed when post-merge has conclusion-only success without qualifying observed runs', () => {
      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        prHeadEvent: 'pull_request',
        prHeadChecks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA }],
        mergedMainSha: shaB,
        mainPushEvent: 'push',
        mainPushConclusion: 'SUCCESS', // Conclusion-only success
        mainPushChecks: [], // No qualifying runs
      });

      expect(result.classification).toBe('MISSING_POST_MERGE_CI');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
      expect(result.mainPostMergeConclusion).toBeNull();
      expect(isPrHeadCiMissing(result)).toBe(false);
    });
  });

  describe('11. Fail-closed in GithubCiObserver: Provenance enforcement in Actions API queries', () => {
    function createTestStore(): AutonomyStore {
      const db = new Database(':memory:');
      return new AutonomyStore(db);
    }

    it('fails closed in observer when post-merge Actions run is missing event (no synthesis)', async () => {
      const store = createTestStore();
      const observer = new GithubCiObserver(store, 'C:\\dummy-repo', undefined, async (exec, args) => {
        if (exec === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return {
            status: 0,
            stdout: JSON.stringify({
              number: prNum,
              isDraft: false,
              headRefName: 'feature-branch',
              headRefOid: shaA,
              mergedAt: '2026-09-23T10:00:00Z',
              mergeCommit: { oid: shaB },
              statusCheckRollup: [{ name: 'pr-test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA }],
            }),
            stderr: '',
          };
        }
        if (exec === 'gh' && args[0] === 'api' && args[1].includes('actions/runs')) {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                id: 101,
                name: 'push-run-missing-event',
                head_sha: shaB,
                status: 'completed',
                conclusion: 'success',
                // event is intentionally absent!
              },
            ]),
            stderr: '',
          };
        }
        return { status: 1, stdout: '', stderr: 'unknown command' };
      });

      const result = await observer.observeAndReconcileMergedPr({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        mergedMainSha: shaB,
      });

      expect(result.classification).toBe('MISSING_POST_MERGE_CI');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
    });

    it('fails closed in observer when post-merge Actions run is missing head SHA (no synthesis)', async () => {
      const store = createTestStore();
      const observer = new GithubCiObserver(store, 'C:\\dummy-repo', undefined, async (exec, args) => {
        if (exec === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return {
            status: 0,
            stdout: JSON.stringify({
              number: prNum,
              isDraft: false,
              headRefName: 'feature-branch',
              headRefOid: shaA,
              mergedAt: '2026-09-23T10:00:00Z',
              mergeCommit: { oid: shaB },
              statusCheckRollup: [{ name: 'pr-test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA }],
            }),
            stderr: '',
          };
        }
        if (exec === 'gh' && args[0] === 'api' && args[1].includes('actions/runs')) {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                id: 102,
                name: 'push-run-missing-sha',
                event: 'push',
                status: 'completed',
                conclusion: 'success',
                // head_sha is intentionally absent!
              },
            ]),
            stderr: '',
          };
        }
        return { status: 1, stdout: '', stderr: 'unknown command' };
      });

      const result = await observer.observeAndReconcileMergedPr({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        mergedMainSha: shaB,
      });

      expect(result.classification).toBe('MISSING_POST_MERGE_CI');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
    });

    it('fails closed in observer when post-merge Actions run has both event and head SHA missing', async () => {
      const store = createTestStore();
      const observer = new GithubCiObserver(store, 'C:\\dummy-repo', undefined, async (exec, args) => {
        if (exec === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return {
            status: 0,
            stdout: JSON.stringify({
              number: prNum,
              isDraft: false,
              headRefName: 'feature-branch',
              headRefOid: shaA,
              mergedAt: '2026-09-23T10:00:00Z',
              mergeCommit: { oid: shaB },
              statusCheckRollup: [{ name: 'pr-test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA }],
            }),
            stderr: '',
          };
        }
        if (exec === 'gh' && args[0] === 'api' && args[1].includes('actions/runs')) {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                id: 103,
                name: 'push-run-both-missing',
                status: 'completed',
                conclusion: 'success',
              },
            ]),
            stderr: '',
          };
        }
        return { status: 1, stdout: '', stderr: 'unknown command' };
      });

      const result = await observer.observeAndReconcileMergedPr({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        mergedMainSha: shaB,
      });

      expect(result.classification).toBe('MISSING_POST_MERGE_CI');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
    });

    it('queries exact-SHA PR-head Actions runs when statusCheckRollup lacks provenance and reconciles successfully', async () => {
      const store = createTestStore();
      const observer = new GithubCiObserver(store, 'C:\\dummy-repo', undefined, async (exec, args) => {
        if (exec === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return {
            status: 0,
            stdout: JSON.stringify({
              number: prNum,
              isDraft: false,
              headRefName: 'feature-branch',
              headRefOid: shaA,
              mergedAt: '2026-09-23T10:00:00Z',
              mergeCommit: { oid: shaB },
              statusCheckRollup: [], // statusCheckRollup is empty or lacks provenance
            }),
            stderr: '',
          };
        }
        if (exec === 'gh' && args[0] === 'api' && args[1].includes(shaA)) {
          // PR-head exact-SHA query
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                id: 201,
                name: 'pr-exact-sha-run',
                event: 'pull_request',
                head_sha: shaA,
                status: 'completed',
                conclusion: 'success',
              },
            ]),
            stderr: '',
          };
        }
        if (exec === 'gh' && args[0] === 'api' && args[1].includes(shaB)) {
          // Post-merge exact-SHA query
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                id: 202,
                name: 'main-exact-sha-push',
                event: 'push',
                head_sha: shaB,
                status: 'completed',
                conclusion: 'success',
              },
            ]),
            stderr: '',
          };
        }
        return { status: 1, stdout: '', stderr: 'unknown command' };
      });

      const result = await observer.observeAndReconcileMergedPr({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        mergedMainSha: shaB,
      });

      expect(result.classification).toBe('DIFFERENT_MERGE_SHA_PUSH_SUCCESS');
      expect(result.isValid).toBe(true);
      expect(result.failsClosed).toBe(false);
      expect(result.prHeadConclusion).toBe('SUCCESS');
      expect(result.mainPostMergeConclusion).toBe('SUCCESS');
    });
  });

  describe('12. Contradiction tests: supplied SUCCESS must never override observed FAILURE or PENDING evidence', () => {
    // Identity 1: PR_HEAD_CI
    it('PR_HEAD_CI: supplied SUCCESS does not override observed FAILURE evidence', () => {
      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        prHeadEvent: 'pull_request',
        prHeadConclusion: 'SUCCESS', // Contradictory supplied conclusion
        prHeadChecks: [
          { name: 'unit-test', status: 'COMPLETED', conclusion: 'FAILURE', event: 'pull_request', headSha: shaA },
        ],
      });

      expect(result.prHeadConclusion).toBe('FAILURE');
      expect(result.classification).toBe('PR_HEAD_FAILURE');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
    });

    it('PR_HEAD_CI: supplied SUCCESS does not override observed PENDING evidence', () => {
      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        prHeadEvent: 'pull_request',
        prHeadConclusion: 'SUCCESS', // Contradictory supplied conclusion
        prHeadChecks: [
          { name: 'build-job', status: 'IN_PROGRESS', conclusion: null, event: 'pull_request', headSha: shaA },
        ],
      });

      expect(result.prHeadConclusion).toBe('PENDING');
      expect(result.classification).toBe('PR_HEAD_FAILURE');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
    });

    // Identity 2: MAIN_POST_MERGE_CI
    it('MAIN_POST_MERGE_CI: supplied SUCCESS does not override observed FAILURE evidence', () => {
      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        prHeadEvent: 'pull_request',
        prHeadChecks: [
          { name: 'pr-test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA },
        ],
        mergedMainSha: shaB,
        mainPushEvent: 'push',
        mainPushConclusion: 'SUCCESS', // Contradictory supplied conclusion
        mainPushChecks: [
          { name: 'main-integration', status: 'COMPLETED', conclusion: 'FAILURE', event: 'push', headSha: shaB },
        ],
      });

      expect(result.prHeadConclusion).toBe('SUCCESS');
      expect(result.mainPostMergeConclusion).toBe('FAILURE');
      expect(result.classification).toBe('POST_MERGE_PUSH_FAILURE');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
    });

    it('MAIN_POST_MERGE_CI: supplied SUCCESS does not override observed PENDING evidence', () => {
      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        prHeadEvent: 'pull_request',
        prHeadChecks: [
          { name: 'pr-test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA },
        ],
        mergedMainSha: shaB,
        mainPushEvent: 'push',
        mainPushConclusion: 'SUCCESS', // Contradictory supplied conclusion
        mainPushChecks: [
          { name: 'main-integration', status: 'IN_PROGRESS', conclusion: null, event: 'push', headSha: shaB },
        ],
      });

      expect(result.prHeadConclusion).toBe('SUCCESS');
      expect(result.mainPostMergeConclusion).toBe('PENDING');
      expect(result.classification).toBe('POST_MERGE_PUSH_PENDING');
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
    });
  });

  describe('13. Fencing: supplied-versus-observed merge SHA mismatch fails closed before querying or persisting', () => {
    function createTestStore(): AutonomyStore {
      const db = new Database(':memory:');
      return new AutonomyStore(db);
    }

    it('fails closed in observer before querying Actions runs or persisting to store when supplied mergedMainSha differs from GitHub mergeCommit.oid', async () => {
      const store = createTestStore();
      const commandCalls: Array<{ exec: string; args: string[] }> = [];

      const observer = new GithubCiObserver(store, 'C:\\dummy-repo', undefined, async (exec, args) => {
        commandCalls.push({ exec, args });
        if (exec === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return {
            status: 0,
            stdout: JSON.stringify({
              number: prNum,
              isDraft: false,
              headRefName: 'feature-branch',
              headRefOid: shaA,
              mergedAt: '2026-09-23T10:00:00Z',
              mergeCommit: { oid: shaB }, // GitHub observed merge commit is shaB
              statusCheckRollup: [
                { name: 'pr-test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA },
              ],
            }),
            stderr: '',
          };
        }
        if (exec === 'gh' && args[0] === 'api' && args[1].includes('actions/runs')) {
          // Should NOT be reached if fenced before querying!
          return {
            status: 0,
            stdout: JSON.stringify([
              { id: 301, name: 'run', event: 'push', head_sha: shaC, status: 'completed', conclusion: 'success' },
            ]),
            stderr: '',
          };
        }
        return { status: 1, stdout: '', stderr: 'unknown command' };
      });

      // Pass shaC as supplied mergedMainSha, which does NOT match GitHub mergeCommit.oid (shaB)
      const result = await observer.observeAndReconcileMergedPr({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        mergedMainSha: shaC,
      });

      // 1. Result fails closed
      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
      expect(result.classification).toBe('MISSING_POST_MERGE_CI');
      expect(result.reason).toContain('does not match GitHub mergeCommit.oid');
      expect(result.reason).toContain(shaC);
      expect(result.reason).toContain(shaB);

      // 2. Fails closed BEFORE querying: no actions/runs API calls were executed
      const actionsRunQueries = commandCalls.filter((c) => c.args.some((a) => a.includes('actions/runs')));
      expect(actionsRunQueries.length).toBe(0);

      // 3. Fails closed BEFORE persisting: nothing was persisted to AutonomyStore
      const persistedByPr = store.getCiReconciliationByPr(repo, prNum);
      expect(persistedByPr).toBeNull();

      const persistedByHead = store.findCiReconciliationsByHeadSha(shaA);
      expect(persistedByHead.length).toBe(0);

      const persistedByMain = store.findCiReconciliationsByMainSha(shaC);
      expect(persistedByMain.length).toBe(0);
    });

    it('fails closed in evaluateCiReconciliation when observedMergedMainSha differs from mergedMainSha', () => {
      const result = evaluateCiReconciliation({
        repository: repo,
        prNumber: prNum,
        expectedPrHeadSha: shaA,
        prHeadEvent: 'pull_request',
        prHeadChecks: [
          { name: 'pr-test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'pull_request', headSha: shaA },
        ],
        mergedMainSha: shaB,
        observedMergedMainSha: shaC, // Mismatch with mergedMainSha
        mainPushEvent: 'push',
        mainPushChecks: [
          { name: 'push-test', status: 'COMPLETED', conclusion: 'SUCCESS', event: 'push', headSha: shaB },
        ],
      });

      expect(result.isValid).toBe(false);
      expect(result.failsClosed).toBe(true);
      expect(result.classification).toBe('MISSING_POST_MERGE_CI');
      expect(result.reason).toContain('does not match observed mergeCommit.oid');
    });
  });
});

