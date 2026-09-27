import type { AutonomyCiWatch, AutonomyExternalClaim } from './store';

/**
 * The subset of a GitHub PR observation which is authoritative for binding a
 * durable autonomy claim.  Status checks are intentionally excluded: those
 * have their own exact-head reconciliation contract.
 */
export interface GithubPullRequestClaimSnapshot {
  number: number;
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
}
export type GithubClaimReconciliationClassification =
  | 'CLAIM_MISSING'
  | 'CLAIM_MATCHED'
  | 'PR_NUMBER_MISMATCH'
  | 'PR_NOT_DRAFT'
  | 'PR_BRANCH_MISMATCH'
  | 'PR_HEAD_INVALID'
  | 'PR_HEAD_MISMATCH'
  | 'LOCAL_CLAIM_OWNER_MISMATCH'
  | 'LOCAL_CLAIM_INVALID';

export interface GithubClaimReconciliationResult {
  externalId: string;
  expectedWorkOrderId: string;
  expectedHeadSha: string;
  observedHeadSha: string | null;
  classification: GithubClaimReconciliationClassification;
  /** Whether it is safe to persist the observation in autonomy_claims. */
  valid: boolean;
  /** Alias which makes the mutation boundary explicit to callers. */
  canPersist: boolean;
  failsClosed: boolean;
  reason: string;
}

const GIT_SHA = /^[0-9a-f]{40}$/i;

function result(
  base: Omit<GithubClaimReconciliationResult, 'valid' | 'canPersist' | 'failsClosed'>,
  valid: boolean,
): GithubClaimReconciliationResult {
  return { ...base, valid, canPersist: valid, failsClosed: !valid };
}

/**
 * Reconcile a remote PR snapshot against a durable CI watch and (when one
 * exists) its last external claim.  This function is pure: it never writes to
 * SQLite, calls GitHub, or mutates either input.  Callers must only persist a
 * result with `canPersist === true`.
 *
 * A missing local claim is valid and deliberately classified separately.  It
 * is the normal first observation and permits an atomic claim insert.  A
 * previous claim's head may differ because a new, explicitly registered CI
 * watch can advance after a repair; the watch's expected head remains the
 * authority for this observation.  Ownership never advances implicitly.
 */
export function reconcileGithubPullRequestClaim(
  watch: Pick<AutonomyCiWatch, 'repository' | 'pr_number' | 'branch' | 'expected_head_sha' | 'work_order_id' | 'task_id'>,
  remote: GithubPullRequestClaimSnapshot,
  existingClaim: Pick<AutonomyExternalClaim, 'work_order_id' | 'head_sha'> | null,
): GithubClaimReconciliationResult {
  const externalId = `${watch.repository}#${watch.pr_number}`;
  const expectedWorkOrderId = watch.work_order_id ?? watch.task_id;
  const expectedHeadSha = String(watch.expected_head_sha ?? '').toLowerCase();
  const observedHeadSha = typeof remote?.headRefOid === 'string' ? remote.headRefOid.toLowerCase() : null;
  const base = { externalId, expectedWorkOrderId, expectedHeadSha, observedHeadSha };

  if (!Number.isSafeInteger(remote?.number) || remote.number !== watch.pr_number) {
    return result({ ...base, classification: 'PR_NUMBER_MISMATCH', reason: `Observed PR number does not match watch (${String(remote?.number)} !== ${watch.pr_number})` }, false);
  }
  if (remote.isDraft !== true) {
    return result({ ...base, classification: 'PR_NOT_DRAFT', reason: 'Remote PR is not Draft; automatic claim binding is fenced' }, false);
  }
  if (typeof remote.headRefName !== 'string' || remote.headRefName !== watch.branch) {
    return result({ ...base, classification: 'PR_BRANCH_MISMATCH', reason: `Observed branch does not match watch (${String(remote.headRefName)} !== ${watch.branch})` }, false);
  }
  if (!GIT_SHA.test(expectedHeadSha) || !observedHeadSha || !GIT_SHA.test(observedHeadSha)) {
    return result({ ...base, classification: 'PR_HEAD_INVALID', reason: 'Expected and observed PR heads must be 40-character Git SHAs' }, false);
  }
  if (observedHeadSha !== expectedHeadSha) {
    return result({ ...base, classification: 'PR_HEAD_MISMATCH', reason: `Observed PR head does not match watch (${observedHeadSha} !== ${expectedHeadSha})` }, false);
  }
  if (existingClaim && !existingClaim.work_order_id) {
    return result({ ...base, classification: 'LOCAL_CLAIM_INVALID', reason: 'Persisted external claim has no durable owner' }, false);
  }
  if (existingClaim && existingClaim.work_order_id !== expectedWorkOrderId) {
    return result({ ...base, classification: 'LOCAL_CLAIM_OWNER_MISMATCH', reason: `External claim is owned by a different WorkOrder (${String(existingClaim.work_order_id)} !== ${expectedWorkOrderId})` }, false);
  }
  if (existingClaim && (!existingClaim.head_sha || !GIT_SHA.test(existingClaim.head_sha))) {
    return result({ ...base, classification: 'LOCAL_CLAIM_INVALID', reason: 'Persisted external claim has an invalid head SHA' }, false);
  }
  if (!existingClaim) {
    return result({ ...base, classification: 'CLAIM_MISSING', reason: 'No durable external claim exists; first observation may create it' }, true);
  }
  return result({ ...base, classification: 'CLAIM_MATCHED', reason: 'Remote Draft PR, branch, owner, and exact head match the durable watch' }, true);
}
