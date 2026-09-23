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
          { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
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
        { name: 'pr-test', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ];
      const mainChecks: GithubCheck[] = [
        { name: 'main-build', status: 'COMPLETED', conclusion: 'SUCCESS' },
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
        { name: 'ci/unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ];
      const mainChecks: GithubCheck[] = [
        { name: 'ci/deploy-check', status: 'COMPLETED', conclusion: 'SUCCESS' },
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
        prHeadChecks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
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
        prHeadChecks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        mergedMainSha: shaB,
        mainPushEvent: 'pull_request', // Invalid for post-merge main CI
        mainPushChecks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
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
        prHeadChecks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
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
          { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'lint', status: 'COMPLETED', conclusion: 'STALE' },
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
        prHeadChecks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
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
        prHeadChecks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
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
              statusCheckRollup: [{ name: 'pr-test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
            }),
            stderr: '',
          };
        }
        if (exec === 'gh' && args[0] === 'api' && args[1].includes(shaB)) {
          return {
            status: 0,
            stdout: JSON.stringify([
              { name: 'main-push-test', status: 'completed', conclusion: 'success', html_url: 'https://ci.example/1' },
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
  });
});
