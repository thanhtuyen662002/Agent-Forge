import path from 'path';
import { ManagerReview, SelfHostTask, WorkOrder, sanitizeAutonomyText } from './contracts';
import {
  AutonomyCiReconciliation,
  AutonomyCiWatch,
  AutonomyStore,
  CiIdentityType,
  CiReconciliationClassification,
  MergeIdentityType,
  RecordCiReconciliationInput,
} from './store';
import { CodexManagerAdapter, ProviderRun } from './providers';
import { ProcessRunner } from '../services/ProcessRunner';
import { Repository } from '../database/repositories';
import { ManagerProviderPool, buildManagerContextPackage } from './managerPool';

export type {
  CiIdentityType,
  MergeIdentityType,
  CiReconciliationClassification,
  AutonomyCiReconciliation,
  RecordCiReconciliationInput,
};

export type CiConclusion = 'PENDING' | 'SUCCESS' | 'FAILURE';

export interface GithubCheck {
  name?: string;
  status?: string | null;
  conclusion?: string | null;
  detailsUrl?: string | null;
  databaseId?: number | null;
  event?: string | null;
  headSha?: string | null;
}

export interface GithubPullRequest {
  number: number;
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  statusCheckRollup?: GithubCheck[];
}

export interface CiObservationResult {
  watch: AutonomyCiWatch;
  conclusion: CiConclusion;
  headSha?: string;
  evidence?: string;
  review?: ManagerReview;
  managerRun?: ProviderRun;
  repairTaskId?: string;
}

interface CommandResult { status: number | null; stdout: string; stderr: string; }
type Command = (executable: string, args: string[], cwd: string) => Promise<CommandResult>;

const successConclusions = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'PASS']);
const failureConclusions = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']);

async function defaultCommand(repository: Repository, executable: string, args: string[], cwd: string): Promise<CommandResult> {
  const result = await ProcessRunner.execute({ executable, args, cwd, timeoutMs: 60_000, allowShell: false, stdin: '', repo: repository });
  return { status: result.exitCode, stdout: result.stdout, stderr: result.stderr || result.error?.message || '' };
}

function parseJson<T>(output: string): T {
  try { return JSON.parse(output) as T; } catch { throw new Error('GITHUB_CONTRACT_INVALID: gh returned non-JSON output'); }
}

function nextPoll(attempt: number): string {
  const seconds = Math.min(300, 30 * (2 ** Math.min(attempt, 4)));
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export function classifyChecks(checks: GithubCheck[] | undefined): CiConclusion {
  if (!checks?.length) return 'PENDING';
  if (checks.some((check) => check.status !== 'COMPLETED' && check.conclusion !== 'SUCCESS')) return 'PENDING';
  if (checks.some((check) => failureConclusions.has(String(check.conclusion ?? '').toUpperCase()))) return 'FAILURE';
  return checks.every((check) => successConclusions.has(String(check.conclusion ?? '').toUpperCase())) ? 'SUCCESS' : 'PENDING';
}

export function extractWorkflowRunId(url: string | null | undefined): string | null {
  const match = url?.match(/\/actions\/runs\/(\d+)/);
  return match?.[1] ?? null;
}

export const runId = extractWorkflowRunId;

export function buildPrHeadCiIdentity(repository: string, prNumber: number, prHeadSha: string): string {
  if (!/^[0-9a-f]{40}$/i.test(prHeadSha)) {
    throw new Error('CONTRACT_INVALID: expected PR head must be a Git SHA');
  }
  return `PR_HEAD_CI:${repository}#${prNumber}@${prHeadSha.toLowerCase()}`;
}

export function buildMainPostMergeCiIdentity(repository: string, mergedMainSha: string): string {
  if (!/^[0-9a-f]{40}$/i.test(mergedMainSha)) {
    throw new Error('CONTRACT_INVALID: merged main SHA must be a Git SHA');
  }
  return `MAIN_POST_MERGE_CI:${repository}@${mergedMainSha.toLowerCase()}`;
}

export function isValidPrHeadCiEvent(event: string): boolean {
  return event === 'pull_request';
}

export function isValidMainPostMergeCiEvent(event: string): boolean {
  return event === 'push';
}

export function determineMergeIdentityType(prHeadSha: string, mergedMainSha: string): 'SQUASH' | 'LINEAR_HISTORY' {
  return prHeadSha.toLowerCase() === mergedMainSha.toLowerCase() ? 'LINEAR_HISTORY' : 'SQUASH';
}

export function isPrHeadCiMissing(reconciliation: {
  reconciliation_classification?: string;
  classification?: string;
  pr_head_conclusion?: string | null;
  prHeadConclusion?: string | null;
}): boolean {
  const classification = reconciliation.reconciliation_classification ?? reconciliation.classification;
  if (
    classification === 'DIFFERENT_MERGE_SHA_PUSH_SUCCESS' ||
    classification === 'LINEAR_HISTORY_MERGE_PUSH_SUCCESS' ||
    classification === 'PR_HEAD_SUCCESS'
  ) {
    return false;
  }
  const conclusion = reconciliation.pr_head_conclusion ?? reconciliation.prHeadConclusion;
  return conclusion === null || conclusion === undefined;
}

export interface CiReconciliationParams {
  repository: string;
  prNumber: number;
  expectedPrHeadSha: string;
  observedPrHeadSha?: string;
  currentPrHeadOid?: string;
  prHeadEvent?: string;
  prHeadChecks?: GithubCheck[];
  prHeadConclusion?: CiConclusion | null;
  mergedMainSha?: string | null;
  observedMergedMainSha?: string | null;
  mainPushEvent?: string;
  mainPushChecks?: GithubCheck[] | null;
  mainPushConclusion?: CiConclusion | null;
  isMerged?: boolean;
}

export interface CiReconciliationResult {
  repository: string;
  prNumber: number;
  prHeadSha: string;
  mergedMainSha: string | null;
  prHeadCiIdentity: string;
  prHeadEvent: 'pull_request';
  prHeadConclusion: CiConclusion | null;
  mainPostMergeCiIdentity: string | null;
  mainPostMergeEvent: 'push';
  mainPostMergeConclusion: CiConclusion | null;
  classification: CiReconciliationClassification;
  mergeIdentityType: MergeIdentityType;
  isValid: boolean;
  failsClosed: boolean;
  reason?: string;
}

export function isQualifyingPrHeadCheck(check: GithubCheck, expectedPrHeadSha: string): boolean {
  if (!check.event || check.event !== 'pull_request') return false;
  if (!check.headSha || check.headSha.toLowerCase() !== expectedPrHeadSha.toLowerCase()) return false;
  return true;
}

export function isQualifyingMainPushCheck(check: GithubCheck, mergedMainSha: string): boolean {
  if (!check.event || check.event !== 'push') return false;
  if (!check.headSha || check.headSha.toLowerCase() !== mergedMainSha.toLowerCase()) return false;
  return true;
}

export function evaluateCiReconciliation(params: CiReconciliationParams): CiReconciliationResult {
  const prHeadSha = params.expectedPrHeadSha.toLowerCase();
  const prHeadEvent = params.prHeadEvent ?? 'pull_request';
  const mainPushEvent = params.mainPushEvent ?? 'push';
  const prHeadIdentity = buildPrHeadCiIdentity(params.repository, params.prNumber, prHeadSha);

  const mergedMainSha = params.mergedMainSha ? params.mergedMainSha.toLowerCase() : null;
  const mainPostMergeIdentity = mergedMainSha
    ? buildMainPostMergeCiIdentity(params.repository, mergedMainSha)
    : null;

  const isMerged = Boolean(params.isMerged || mergedMainSha);
  const mergeIdentityType: MergeIdentityType = mergedMainSha
    ? determineMergeIdentityType(prHeadSha, mergedMainSha)
    : 'NONE';

  // Rule 1: PR_HEAD_CI is valid only for event pull_request at exact PR head SHA
  if (prHeadEvent !== 'pull_request') {
    return {
      repository: params.repository,
      prNumber: params.prNumber,
      prHeadSha,
      mergedMainSha,
      prHeadCiIdentity: prHeadIdentity,
      prHeadEvent: 'pull_request',
      prHeadConclusion: 'FAILURE',
      mainPostMergeCiIdentity: mainPostMergeIdentity,
      mainPostMergeEvent: 'push',
      mainPostMergeConclusion: null,
      classification: 'STALE_PR_HEAD_CI',
      mergeIdentityType,
      isValid: false,
      failsClosed: true,
      reason: `PR_HEAD_CI invalid event: expected "pull_request", observed "${prHeadEvent}"`,
    };
  }

  // Rule 1b: PR head checks must be for pull_request event
  if (params.prHeadChecks?.some((c) => c.event && c.event !== 'pull_request')) {
    return {
      repository: params.repository,
      prNumber: params.prNumber,
      prHeadSha,
      mergedMainSha,
      prHeadCiIdentity: prHeadIdentity,
      prHeadEvent: 'pull_request',
      prHeadConclusion: 'FAILURE',
      mainPostMergeCiIdentity: mainPostMergeIdentity,
      mainPostMergeEvent: 'push',
      mainPostMergeConclusion: null,
      classification: 'STALE_PR_HEAD_CI',
      mergeIdentityType,
      isValid: false,
      failsClosed: true,
      reason: 'PR head CI contains checks from non-pull_request event',
    };
  }

  // Rule 1c: PR head checks must match exact expected head SHA
  if (params.prHeadChecks?.some((c) => c.headSha && c.headSha.toLowerCase() !== prHeadSha)) {
    return {
      repository: params.repository,
      prNumber: params.prNumber,
      prHeadSha,
      mergedMainSha,
      prHeadCiIdentity: prHeadIdentity,
      prHeadEvent: 'pull_request',
      prHeadConclusion: 'FAILURE',
      mainPostMergeCiIdentity: mainPostMergeIdentity,
      mainPostMergeEvent: 'push',
      mainPostMergeConclusion: null,
      classification: 'STALE_PR_HEAD_CI',
      mergeIdentityType,
      isValid: false,
      failsClosed: true,
      reason: 'PR head CI contains checks for mismatched head SHA',
    };
  }

  // Rule 2: Superseded head: if PR current head OID has moved beyond expected head SHA
  if (params.currentPrHeadOid && params.currentPrHeadOid.toLowerCase() !== prHeadSha) {
    const prConclusion = params.prHeadConclusion ?? (params.prHeadChecks ? classifyChecks(params.prHeadChecks) : null);
    return {
      repository: params.repository,
      prNumber: params.prNumber,
      prHeadSha,
      mergedMainSha,
      prHeadCiIdentity: prHeadIdentity,
      prHeadEvent: 'pull_request',
      prHeadConclusion: prConclusion,
      mainPostMergeCiIdentity: mainPostMergeIdentity,
      mainPostMergeEvent: 'push',
      mainPostMergeConclusion: null,
      classification: 'SUPERSEDED_HEAD',
      mergeIdentityType,
      isValid: false,
      failsClosed: true,
      reason: `PR head superseded: expected ${prHeadSha}, current PR head is ${params.currentPrHeadOid.toLowerCase()}`,
    };
  }

  // Rule 3: Stale PR-head evidence: if observed PR head SHA differs from expected head SHA
  if (params.observedPrHeadSha && params.observedPrHeadSha.toLowerCase() !== prHeadSha) {
    return {
      repository: params.repository,
      prNumber: params.prNumber,
      prHeadSha,
      mergedMainSha,
      prHeadCiIdentity: prHeadIdentity,
      prHeadEvent: 'pull_request',
      prHeadConclusion: 'FAILURE',
      mainPostMergeCiIdentity: mainPostMergeIdentity,
      mainPostMergeEvent: 'push',
      mainPostMergeConclusion: null,
      classification: 'STALE_PR_HEAD_CI',
      mergeIdentityType,
      isValid: false,
      failsClosed: true,
      reason: `PR head SHA mismatch: expected ${prHeadSha}, observed ${params.observedPrHeadSha.toLowerCase()}`,
    };
  }

  // Rule 4: Stale check checks: check if any check conclusion is STALE
  if (params.prHeadChecks?.some((c) => String(c.conclusion ?? '').toUpperCase() === 'STALE')) {
    return {
      repository: params.repository,
      prNumber: params.prNumber,
      prHeadSha,
      mergedMainSha,
      prHeadCiIdentity: prHeadIdentity,
      prHeadEvent: 'pull_request',
      prHeadConclusion: 'FAILURE',
      mainPostMergeCiIdentity: mainPostMergeIdentity,
      mainPostMergeEvent: 'push',
      mainPostMergeConclusion: null,
      classification: 'STALE_PR_HEAD_CI',
      mergeIdentityType,
      isValid: false,
      failsClosed: true,
      reason: 'PR head CI contains stale checks',
    };
  }

  // Qualifying PR-head runs require explicit event and exact SHA fields.
  // Do not synthesize missing event or SHA provenance.
  const qualifyingPrHeadChecks = params.prHeadChecks?.filter((check) =>
    isQualifyingPrHeadCheck(check, prHeadSha)
  ) ?? [];

  // A successful conclusion without at least one qualifying observed run must fail closed.
  if (qualifyingPrHeadChecks.length === 0) {
    return {
      repository: params.repository,
      prNumber: params.prNumber,
      prHeadSha,
      mergedMainSha,
      prHeadCiIdentity: prHeadIdentity,
      prHeadEvent: 'pull_request',
      prHeadConclusion: null,
      mainPostMergeCiIdentity: mainPostMergeIdentity,
      mainPostMergeEvent: 'push',
      mainPostMergeConclusion: null,
      classification: 'STALE_PR_HEAD_CI',
      mergeIdentityType,
      isValid: false,
      failsClosed: true,
      reason: 'PR head CI lacks qualifying Actions run evidence: explicit event "pull_request" and exact head SHA required; successful conclusion without qualifying observed run fails closed',
    };
  }

  // Classify PR-head checks from qualifying observed runs; supplied conclusions must never override contradictory FAILURE or PENDING evidence
  const observedPrHeadConclusion = classifyChecks(qualifyingPrHeadChecks);
  let prHeadConclusion: CiConclusion = observedPrHeadConclusion;
  if (observedPrHeadConclusion === 'FAILURE') {
    prHeadConclusion = 'FAILURE';
  } else if (observedPrHeadConclusion === 'PENDING') {
    prHeadConclusion = params.prHeadConclusion === 'FAILURE' ? 'FAILURE' : 'PENDING';
  } else if (params.prHeadConclusion === 'FAILURE' || params.prHeadConclusion === 'PENDING') {
    prHeadConclusion = params.prHeadConclusion;
  } else {
    prHeadConclusion = observedPrHeadConclusion;
  }

  if (prHeadConclusion === 'FAILURE') {
    return {
      repository: params.repository,
      prNumber: params.prNumber,
      prHeadSha,
      mergedMainSha,
      prHeadCiIdentity: prHeadIdentity,
      prHeadEvent: 'pull_request',
      prHeadConclusion,
      mainPostMergeCiIdentity: mainPostMergeIdentity,
      mainPostMergeEvent: 'push',
      mainPostMergeConclusion: null,
      classification: 'PR_HEAD_FAILURE',
      mergeIdentityType,
      isValid: false,
      failsClosed: true,
      reason: 'PR head CI failed',
    };
  }

  if (prHeadConclusion === 'PENDING') {
    return {
      repository: params.repository,
      prNumber: params.prNumber,
      prHeadSha,
      mergedMainSha,
      prHeadCiIdentity: prHeadIdentity,
      prHeadEvent: 'pull_request',
      prHeadConclusion,
      mainPostMergeCiIdentity: mainPostMergeIdentity,
      mainPostMergeEvent: 'push',
      mainPostMergeConclusion: null,
      classification: 'PR_HEAD_FAILURE',
      mergeIdentityType,
      isValid: false,
      failsClosed: true,
      reason: 'PR head CI is pending',
    };
  }

  // At this point, PR-head CI succeeded!
  // Case A: Not merged yet
  if (!isMerged) {
    return {
      repository: params.repository,
      prNumber: params.prNumber,
      prHeadSha,
      mergedMainSha: null,
      prHeadCiIdentity: prHeadIdentity,
      prHeadEvent: 'pull_request',
      prHeadConclusion: 'SUCCESS',
      mainPostMergeCiIdentity: null,
      mainPostMergeEvent: 'push',
      mainPostMergeConclusion: null,
      classification: 'PR_HEAD_SUCCESS',
      mergeIdentityType: 'NONE',
      isValid: true,
      failsClosed: false,
      reason: 'PR head CI succeeded for pull_request event at exact head SHA',
    };
  }

  // Case B: Merged, but merged main SHA is missing
  if (!mergedMainSha) {
    return {
      repository: params.repository,
      prNumber: params.prNumber,
      prHeadSha,
      mergedMainSha: null,
      prHeadCiIdentity: prHeadIdentity,
      prHeadEvent: 'pull_request',
      prHeadConclusion: 'SUCCESS',
      mainPostMergeCiIdentity: null,
      mainPostMergeEvent: 'push',
      mainPostMergeConclusion: null,
      classification: 'MISSING_POST_MERGE_CI',
      mergeIdentityType: 'NONE',
      isValid: false,
      failsClosed: true,
      reason: 'PR marked as merged but no merged main SHA available',
    };
  }

  const observedMergedMainSha = params.observedMergedMainSha ? params.observedMergedMainSha.toLowerCase() : null;
  if (mergedMainSha && observedMergedMainSha && mergedMainSha !== observedMergedMainSha) {
    return {
      repository: params.repository,
      prNumber: params.prNumber,
      prHeadSha,
      mergedMainSha,
      prHeadCiIdentity: prHeadIdentity,
      prHeadEvent: 'pull_request',
      prHeadConclusion,
      mainPostMergeCiIdentity: mainPostMergeIdentity,
      mainPostMergeEvent: 'push',
      mainPostMergeConclusion: null,
      classification: 'MISSING_POST_MERGE_CI',
      mergeIdentityType,
      isValid: false,
      failsClosed: true,
      reason: `Supplied mergedMainSha (${mergedMainSha}) does not match observed mergeCommit.oid (${observedMergedMainSha})`,
    };
  }

  // Rule 5: MAIN_POST_MERGE_CI is valid only for event push at the exact resulting main SHA
  if (mainPushEvent !== 'push') {
    return {
      repository: params.repository,
      prNumber: params.prNumber,
      prHeadSha,
      mergedMainSha,
      prHeadCiIdentity: prHeadIdentity,
      prHeadEvent: 'pull_request',
      prHeadConclusion: 'SUCCESS',
      mainPostMergeCiIdentity: mainPostMergeIdentity,
      mainPostMergeEvent: 'push',
      mainPostMergeConclusion: null,
      classification: 'MISSING_POST_MERGE_CI',
      mergeIdentityType,
      isValid: false,
      failsClosed: true,
      reason: `MAIN_POST_MERGE_CI invalid event: expected "push", observed "${mainPushEvent}"`,
    };
  }

  // Do not accept non-push checks or mismatched-SHA checks as post-merge main push evidence
  if (params.mainPushChecks?.some((c) => c.event && c.event !== 'push')) {
    return {
      repository: params.repository,
      prNumber: params.prNumber,
      prHeadSha,
      mergedMainSha,
      prHeadCiIdentity: prHeadIdentity,
      prHeadEvent: 'pull_request',
      prHeadConclusion: 'SUCCESS',
      mainPostMergeCiIdentity: mainPostMergeIdentity,
      mainPostMergeEvent: 'push',
      mainPostMergeConclusion: null,
      classification: 'MISSING_POST_MERGE_CI',
      mergeIdentityType,
      isValid: false,
      failsClosed: true,
      reason: 'Post-merge main push CI contains checks from non-push event',
    };
  }

  if (params.mainPushChecks?.some((c) => c.headSha && c.headSha.toLowerCase() !== mergedMainSha)) {
    return {
      repository: params.repository,
      prNumber: params.prNumber,
      prHeadSha,
      mergedMainSha,
      prHeadCiIdentity: prHeadIdentity,
      prHeadEvent: 'pull_request',
      prHeadConclusion: 'SUCCESS',
      mainPostMergeCiIdentity: mainPostMergeIdentity,
      mainPostMergeEvent: 'push',
      mainPostMergeConclusion: null,
      classification: 'MISSING_POST_MERGE_CI',
      mergeIdentityType,
      isValid: false,
      failsClosed: true,
      reason: `Post-merge main push CI contains checks for mismatched SHA (expected ${mergedMainSha})`,
    };
  }

  // Qualifying main post-merge push runs require explicit event and exact SHA fields.
  // Do not synthesize missing event or SHA provenance.
  const qualifyingPushChecks = params.mainPushChecks?.filter((check) =>
    isQualifyingMainPushCheck(check, mergedMainSha)
  ) ?? [];

  // A successful conclusion without at least one qualifying observed run must fail closed.
  if (qualifyingPushChecks.length === 0) {
    return {
      repository: params.repository,
      prNumber: params.prNumber,
      prHeadSha,
      mergedMainSha,
      prHeadCiIdentity: prHeadIdentity,
      prHeadEvent: 'pull_request',
      prHeadConclusion: 'SUCCESS',
      mainPostMergeCiIdentity: mainPostMergeIdentity,
      mainPostMergeEvent: 'push',
      mainPostMergeConclusion: null,
      classification: 'MISSING_POST_MERGE_CI',
      mergeIdentityType,
      isValid: false,
      failsClosed: true,
      reason: `Missing qualifying post-merge CI for push event at main SHA ${mergedMainSha}: explicit event "push" and exact main SHA required; successful conclusion without qualifying observed run fails closed`,
    };
  }

  // Classify post-merge main push checks from qualifying observed runs; supplied conclusions must never override contradictory FAILURE or PENDING evidence
  const observedPushConclusion = classifyChecks(qualifyingPushChecks);
  let mainPushConclusion: CiConclusion = observedPushConclusion;
  if (observedPushConclusion === 'FAILURE') {
    mainPushConclusion = 'FAILURE';
  } else if (observedPushConclusion === 'PENDING') {
    mainPushConclusion = params.mainPushConclusion === 'FAILURE' ? 'FAILURE' : 'PENDING';
  } else if (params.mainPushConclusion === 'FAILURE' || params.mainPushConclusion === 'PENDING') {
    mainPushConclusion = params.mainPushConclusion;
  } else {
    mainPushConclusion = observedPushConclusion;
  }

  if (mainPushConclusion === 'FAILURE') {
    return {
      repository: params.repository,
      prNumber: params.prNumber,
      prHeadSha,
      mergedMainSha,
      prHeadCiIdentity: prHeadIdentity,
      prHeadEvent: 'pull_request',
      prHeadConclusion: 'SUCCESS',
      mainPostMergeCiIdentity: mainPostMergeIdentity,
      mainPostMergeEvent: 'push',
      mainPostMergeConclusion: 'FAILURE',
      classification: 'POST_MERGE_PUSH_FAILURE',
      mergeIdentityType,
      isValid: false,
      failsClosed: true,
      reason: `Post-merge main push CI failed at ${mergedMainSha}`,
    };
  }

  if (mainPushConclusion === 'PENDING') {
    return {
      repository: params.repository,
      prNumber: params.prNumber,
      prHeadSha,
      mergedMainSha,
      prHeadCiIdentity: prHeadIdentity,
      prHeadEvent: 'pull_request',
      prHeadConclusion: 'SUCCESS',
      mainPostMergeCiIdentity: mainPostMergeIdentity,
      mainPostMergeEvent: 'push',
      mainPostMergeConclusion: 'PENDING',
      classification: 'POST_MERGE_PUSH_PENDING',
      mergeIdentityType,
      isValid: false,
      failsClosed: true,
      reason: `Post-merge main push CI pending at ${mergedMainSha}`,
    };
  }

  // Post-merge push CI SUCCEEDED!
  // Case D: Squash or linear-history merge
  if (mergeIdentityType === 'SQUASH') {
    return {
      repository: params.repository,
      prNumber: params.prNumber,
      prHeadSha,
      mergedMainSha,
      prHeadCiIdentity: prHeadIdentity,
      prHeadEvent: 'pull_request',
      prHeadConclusion: 'SUCCESS',
      mainPostMergeCiIdentity: mainPostMergeIdentity,
      mainPostMergeEvent: 'push',
      mainPostMergeConclusion: 'SUCCESS',
      classification: 'DIFFERENT_MERGE_SHA_PUSH_SUCCESS',
      mergeIdentityType: 'SQUASH',
      isValid: true,
      failsClosed: false,
      reason: `Squash merge produced distinct main SHA ${mergedMainSha} with successful push CI; PR-head CI preserved at ${prHeadSha}`,
    };
  }

  // Linear history merge
  return {
    repository: params.repository,
    prNumber: params.prNumber,
    prHeadSha,
    mergedMainSha,
    prHeadCiIdentity: prHeadIdentity,
    prHeadEvent: 'pull_request',
    prHeadConclusion: 'SUCCESS',
    mainPostMergeCiIdentity: mainPostMergeIdentity,
    mainPostMergeEvent: 'push',
    mainPostMergeConclusion: 'SUCCESS',
    classification: 'LINEAR_HISTORY_MERGE_PUSH_SUCCESS',
    mergeIdentityType: 'LINEAR_HISTORY',
    isValid: true,
    failsClosed: false,
    reason: `Linear-history merge preserved head SHA ${prHeadSha} on main with successful push CI; PR_HEAD_CI and MAIN_POST_MERGE_CI are distinct durable identities`,
  };
}

export class GithubCiObserver {
  private readonly managerPool?: ManagerProviderPool;
  private readonly command: Command;

  constructor(
    private readonly store: AutonomyStore,
    private readonly controlRepo: string,
    manager?: CodexManagerAdapter | ManagerProviderPool,
    command?: Command,
  ) {
    if (manager instanceof ManagerProviderPool) {
      this.managerPool = manager;
    } else if (manager instanceof CodexManagerAdapter) {
      this.managerPool = ManagerProviderPool.fromPrimary(store, manager);
    } else if (manager && typeof (manager as any).review === 'function') {
      this.managerPool = manager as ManagerProviderPool;
    }
    this.command = command ?? ((executable, args, cwd) => defaultCommand(new Repository(store.getDatabase()), executable, args, cwd));
  }

  register(input: { taskId: string; workOrderId?: string | null; repository: string; prNumber: number; branch: string; expectedHeadSha: string }): AutonomyCiWatch {
    if (!/^[0-9a-f]{40}$/i.test(input.expectedHeadSha)) throw new Error('CONTRACT_INVALID: expected PR head must be a Git SHA');
    return this.store.registerCiWatch(input);
  }

  async observeDue(): Promise<CiObservationResult[]> {
    const results: CiObservationResult[] = [];
    for (const watch of this.store.listDueCiWatches()) results.push(await this.observe(watch));
    return results;
  }

  async observe(watch: AutonomyCiWatch): Promise<CiObservationResult> {
    const prResult = await this.command('gh', ['pr', 'view', String(watch.pr_number), '--repo', watch.repository, '--json', 'number,isDraft,headRefName,headRefOid,statusCheckRollup'], this.controlRepo);
    if (prResult.status !== 0) throw new Error(`GITHUB_PR_OBSERVE_FAILED: ${sanitizeAutonomyText(prResult.stderr || prResult.stdout)}`);
    const pr = parseJson<GithubPullRequest>(prResult.stdout);
    if (!pr.isDraft || pr.headRefName !== watch.branch) {
      this.store.updateCiWatch(watch.id, { state: 'BLOCKED', last_observed_at: new Date().toISOString() });
      this.store.event(watch.work_order_id ?? watch.task_id, 'CI_CLAIM_REJECTED', { reason: 'DRAFT_OR_BRANCH_MISMATCH', pr });
      return { watch, conclusion: 'FAILURE', headSha: pr.headRefOid };
    }
    const headSha = pr.headRefOid.toLowerCase();
    try { this.store.reconcileExternalClaim('github-pr', `${watch.repository}#${watch.pr_number}`, watch.work_order_id ?? watch.task_id, headSha, 'OBSERVED'); }
    catch (error) {
      this.store.updateCiWatch(watch.id, { state: 'BLOCKED', last_observed_at: new Date().toISOString() });
      this.store.event(watch.work_order_id ?? watch.task_id, 'CI_CLAIM_REJECTED', { reason: String(error), headSha });
      throw error;
    }
    if (headSha !== watch.expected_head_sha.toLowerCase()) {
      this.store.updateCiWatch(watch.id, { state: 'BLOCKED', last_observed_at: new Date().toISOString() });
      this.store.event(watch.work_order_id ?? watch.task_id, 'CI_HEAD_MISMATCH', { expected: watch.expected_head_sha, observed: headSha });
      return { watch, conclusion: 'FAILURE', headSha };
    }
    const conclusion = classifyChecks(pr.statusCheckRollup);
    const observedAt = new Date().toISOString();
    if (conclusion === 'PENDING') {
      this.store.updateCiWatch(watch.id, { state: 'CI_WAIT', poll_attempt: watch.poll_attempt + 1, next_poll_at: nextPoll(watch.poll_attempt), last_observed_at: observedAt });
      this.store.event(watch.work_order_id ?? watch.task_id, 'CI_OBSERVED', { conclusion, headSha, checks: pr.statusCheckRollup ?? [] });
      return { watch, conclusion, headSha };
    }
    if (conclusion === 'SUCCESS') {
      this.store.updateCiWatch(watch.id, { state: 'CI_SUCCESS', repair_task_id: null, last_observed_at: observedAt });
      const row = watch.work_order_id ? this.store.getWorkOrder(watch.work_order_id) : null;
      if (row && ['CI_WAIT', 'PR_OPEN'].includes(row.state)) this.store.updateState(row.id, 'MERGE_READY', row.lease_epoch);
      if (watch.repair_task_id) {
        const repair = this.store.findLatestWorkOrderByTask(watch.repair_task_id);
        if (repair && ['CI_WAIT', 'PR_OPEN'].includes(repair.state)) this.store.updateState(repair.id, 'MERGE_READY', repair.lease_epoch);
      }
      this.store.event(watch.work_order_id ?? watch.task_id, 'CI_SUCCESS', { headSha, checks: pr.statusCheckRollup ?? [] });
      return { watch, conclusion, headSha };
    }
    const evidence = await this.failureEvidence(watch.repository, pr.statusCheckRollup ?? []);
    this.store.updateCiWatch(watch.id, { state: 'CI_FAILURE', poll_attempt: watch.poll_attempt + 1, next_poll_at: nextPoll(watch.poll_attempt), last_observed_at: observedAt });
    this.store.event(watch.work_order_id ?? watch.task_id, 'CI_FAILURE_EVIDENCE', { headSha, evidence, checks: pr.statusCheckRollup ?? [] });
    const row = watch.work_order_id ? this.store.getWorkOrder(watch.work_order_id) : null;
    if (!row || !this.managerPool) return { watch, conclusion, headSha, evidence };
    const order = JSON.parse(row.payload_json) as WorkOrder;
    const context = buildManagerContextPackage({
      workOrder: order,
      currentHead: headSha,
      actualDiff: evidence,
      changedFiles: order.allowed_paths,
      deterministicTests: pr.statusCheckRollup ?? [],
      previousManagerDecisions: this.store.getDatabase().prepare('SELECT payload_json FROM autonomy_reviews WHERE work_order_id=? ORDER BY created_at').all(row.id),
      repairHistory: this.store.getDatabase().prepare("SELECT payload_json FROM autonomy_events WHERE work_order_id=? AND event_type IN ('REPAIR_REQUIRED','CI_REPAIR_QUEUED') ORDER BY created_at").all(row.id),
      prState: pr,
      ciState: {
        watch_id: watch.id,
        repository: watch.repository,
        pr_number: watch.pr_number,
        branch: watch.branch,
        expected_head_sha: watch.expected_head_sha,
        status_checks: pr.statusCheckRollup ?? [],
        failure_evidence: evidence,
      },
      architecturePolicyContext: [
        'Supervisor owns leases, worktrees, GitHub, and verification.',
        'Diagnose CI failure from check logs; verdict must be REPAIR if actionable or BLOCKED if fatal.',
        'PASS requires reviewed_head_sha equal to current evidence HEAD.',
      ],
    });
    const reviewResult = await this.managerPool.review(context);
    this.store.recordRun(row.id, 'codex-ci-review', reviewResult.run);
    if (!reviewResult.review) {
      if (reviewResult.run.stderr === 'ALL_MANAGER_RESOURCES_UNAVAILABLE') {
        this.store.event(row.id, 'MANAGER_CAPACITY_UNAVAILABLE', { attempts: reviewResult.attempts, contextSha: reviewResult.context_sha });
      }
      this.store.event(row.id, 'CI_DIAGNOSIS_BLOCKED', { status: reviewResult.run.status, error: reviewResult.run.error, stderr: reviewResult.run.stderr });
      return { watch, conclusion, headSha, evidence, managerRun: reviewResult.run };
    }
    this.store.recordReview(row.id, reviewResult.review);
    if (reviewResult.review.verdict !== 'REPAIR') {
      this.store.updateCiWatch(watch.id, { state: reviewResult.review.verdict === 'BLOCKED' ? 'BLOCKED' : 'CI_FAILURE' });
      this.store.event(row.id, 'CI_DIAGNOSIS_REJECTED', { verdict: reviewResult.review.verdict });
      return { watch, conclusion, headSha, evidence, review: reviewResult.review, managerRun: reviewResult.run };
    }
    if (['CI_WAIT', 'PR_OPEN'].includes(row.state)) this.store.updateState(row.id, 'REPAIR', row.lease_epoch);
    const repairTaskId = `${row.task_id}-CI-${headSha.slice(0, 8)}`.slice(0, 80);
    const repairTask: SelfHostTask = {
      task_id: repairTaskId, objective: `Repair CI failure for ${watch.repository}#${watch.pr_number}. Inspect the persisted CI evidence and implement the manager's required actions.`,
      base_sha: headSha, allowed_paths: JSON.parse(row.payload_json).allowed_paths, required_tests: JSON.parse(row.payload_json).required_tests,
      acceptance_criteria: JSON.parse(row.payload_json).acceptance_criteria, context_files: JSON.parse(row.payload_json).context_files,
      constraints: [...JSON.parse(row.payload_json).constraints, `CI evidence: ${evidence}`, `Manager findings: ${JSON.stringify(reviewResult.review.findings)}`, `Required actions: ${JSON.stringify(reviewResult.review.required_actions)}`],
    };
    this.store.enqueue(repairTask);
    this.store.updateCiWatch(watch.id, { state: 'REPAIR_QUEUED', repair_task_id: repairTaskId });
    this.store.event(row.id, 'CI_REPAIR_QUEUED', { repairTaskId, headSha });
    return { watch, conclusion, headSha, evidence, review: reviewResult.review, managerRun: reviewResult.run, repairTaskId };
  }

  async failureEvidence(repository: string, checks: GithubCheck[]): Promise<string> {
    const failed = checks.filter((check) => failureConclusions.has(String(check.conclusion ?? '').toUpperCase()));
    const chunks: string[] = [];
    for (const check of failed) {
      const workflowRunId = extractWorkflowRunId(check.detailsUrl);
      if (!workflowRunId) {
        chunks.push(`${check.name ?? 'unknown'}: ${check.detailsUrl ?? 'no details URL'}`);
        continue;
      }
      const result = await this.command('gh', ['run', 'view', workflowRunId, '--repo', repository, '--log-failed'], this.controlRepo);
      chunks.push(`${check.name ?? workflowRunId}\n${sanitizeAutonomyText(result.stdout || result.stderr)}`);
    }
    return sanitizeAutonomyText(chunks.join('\n\n'));
  }

  async publishAcceptedRepair(taskId: string, worktree: string, branch: string): Promise<string | null> {
    const watch = this.store.getCiWatchForRepairTask(taskId);
    if (!watch) return null;
    const row = this.store.findLatestWorkOrderByTask(taskId);
    if (!row || row.worktree !== path.resolve(worktree)) throw new Error('CI_REPAIR_WORKTREE_MISMATCH');
    if (branch !== row.branch) throw new Error('CI_REPAIR_BRANCH_MISMATCH');
    const status = await this.command('git', ['status', '--porcelain'], worktree);
    if (status.status !== 0) throw new Error('CI_REPAIR_GIT_STATUS_FAILED');
    const files = status.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim()).filter(Boolean);
    const order = JSON.parse(row.payload_json) as WorkOrder;
    if (files.some((file) => !order.allowed_paths.some((allowed) => file === allowed || file.startsWith(`${allowed.replace(/\/$/, '')}/`)))) throw new Error('CI_REPAIR_PATH_VIOLATION');
    if (!files.length) throw new Error('CI_REPAIR_NO_CHANGES');
    const add = await this.command('git', ['add', '--', ...files], worktree); if (add.status !== 0) throw new Error('CI_REPAIR_STAGE_FAILED');
    const commit = await this.command('git', ['-c', 'user.name=Agent Forge Supervisor', '-c', 'user.email=agent-forge@localhost', 'commit', '-m', `repair: ${taskId}`], worktree); if (commit.status !== 0) throw new Error('CI_REPAIR_COMMIT_FAILED');
    const head = await this.command('git', ['rev-parse', 'HEAD'], worktree); if (head.status !== 0 || !/^[0-9a-f]{40}$/i.test(head.stdout.trim())) throw new Error('CI_REPAIR_HEAD_FAILED');
    const push = await this.command('git', ['push', 'origin', `HEAD:refs/heads/${watch.branch}`, `--force-with-lease=refs/heads/${watch.branch}:${watch.expected_head_sha}`], worktree); if (push.status !== 0) throw new Error(`CI_REPAIR_PUSH_FAILED: ${sanitizeAutonomyText(push.stderr)}`);
    const newHead = head.stdout.trim().toLowerCase();
    this.store.updateCiWatch(watch.id, { expected_head_sha: newHead, state: 'CI_WAIT', poll_attempt: 0, next_poll_at: new Date().toISOString() });
    this.store.updateState(row.id, 'CI_WAIT', row.lease_epoch);
    this.store.event(row.id, 'CI_REPAIR_PUSHED', { headSha: newHead, branch: watch.branch });
    return newHead;
  }

  reconcileCiIdentities(params: CiReconciliationParams): CiReconciliationResult {
    const result = evaluateCiReconciliation(params);
    this.store.recordCiReconciliation({
      repository: result.repository,
      prNumber: result.prNumber,
      prHeadSha: result.prHeadSha,
      mergedMainSha: result.mergedMainSha,
      prHeadCiIdentity: result.prHeadCiIdentity,
      prHeadEvent: 'pull_request',
      prHeadConclusion: result.prHeadConclusion,
      mainPostMergeCiIdentity: result.mainPostMergeCiIdentity,
      mainPostMergeEvent: 'push',
      mainPostMergeConclusion: result.mainPostMergeConclusion,
      reconciliationClassification: result.classification,
      mergeIdentityType: result.mergeIdentityType,
      details: {
        isValid: result.isValid,
        failsClosed: result.failsClosed,
        reason: result.reason,
      },
    });
    return result;
  }

  async queryActionsRuns(
    repository: string,
    headSha: string,
    event: 'pull_request' | 'push'
  ): Promise<GithubCheck[]> {
    const runsResult = await this.command(
      'gh',
      ['api', `repos/${repository}/actions/runs?head_sha=${headSha}&event=${event}`, '--jq', '.workflow_runs'],
      this.controlRepo
    );
    if (runsResult.status !== 0 || !runsResult.stdout.trim()) {
      return [];
    }
    const parsed = parseJson<unknown>(runsResult.stdout);
    let rawRuns: Array<{
      id?: number | null;
      name?: string;
      head_sha?: string;
      headSha?: string;
      event?: string;
      status?: string | null;
      conclusion?: string | null;
      html_url?: string | null;
      url?: string | null;
    }> = [];
    if (Array.isArray(parsed)) {
      rawRuns = parsed;
    } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { workflow_runs?: unknown[] }).workflow_runs)) {
      rawRuns = (parsed as { workflow_runs: typeof rawRuns }).workflow_runs;
    }

    // Require explicit event and exact SHA fields for both PR-head and post-merge Actions run evidence.
    // Do not synthesize missing event or SHA provenance.
    const qualifying = rawRuns.filter((r) => {
      if (!r.event || r.event !== event) return false;
      const sha = (r.head_sha || r.headSha)?.toLowerCase();
      if (!sha || sha !== headSha.toLowerCase()) return false;
      return true;
    });

    return qualifying.map((r) => ({
      name: r.name,
      status: r.status ? r.status.toUpperCase() : null,
      conclusion: r.conclusion ? r.conclusion.toUpperCase() : null,
      detailsUrl: r.html_url ?? r.url ?? null,
      databaseId: r.id ?? null,
      event: r.event!,
      headSha: (r.head_sha || r.headSha)!.toLowerCase(),
    }));
  }

  async observeAndReconcileMergedPr(params: {
    repository: string;
    prNumber: number;
    expectedPrHeadSha: string;
    mergedMainSha?: string;
  }): Promise<CiReconciliationResult> {
    const prResult = await this.command('gh', ['pr', 'view', String(params.prNumber), '--repo', params.repository, '--json', 'number,isDraft,headRefName,headRefOid,mergedAt,mergeCommit,statusCheckRollup'], this.controlRepo);
    if (prResult.status !== 0) throw new Error(`GITHUB_PR_OBSERVE_FAILED: ${sanitizeAutonomyText(prResult.stderr || prResult.stdout)}`);
    const pr = parseJson<GithubPullRequest & { mergedAt?: string | null; mergeCommit?: { oid?: string } | null }>(prResult.stdout);

    const observedMergeCommitOid = pr.mergeCommit?.oid ? pr.mergeCommit.oid.toLowerCase() : null;
    const suppliedMergedMainSha = params.mergedMainSha ? params.mergedMainSha.toLowerCase() : null;

    // Fence a supplied mergedMainSha against GitHub mergeCommit.oid:
    // Fail closed before querying or persisting when both do not match.
    if (suppliedMergedMainSha && observedMergeCommitOid && suppliedMergedMainSha !== observedMergeCommitOid) {
      const prHeadSha = params.expectedPrHeadSha.toLowerCase();
      const prHeadIdentity = buildPrHeadCiIdentity(params.repository, params.prNumber, prHeadSha);
      const mainPostMergeIdentity = buildMainPostMergeCiIdentity(params.repository, suppliedMergedMainSha);
      const mergeIdentityType = determineMergeIdentityType(prHeadSha, suppliedMergedMainSha);

      const qualifyingPrRollup = (pr.statusCheckRollup ?? []).filter((c) =>
        isQualifyingPrHeadCheck(c, params.expectedPrHeadSha)
      );
      const prHeadConclusion = qualifyingPrRollup.length > 0 ? classifyChecks(qualifyingPrRollup) : null;

      return {
        repository: params.repository,
        prNumber: params.prNumber,
        prHeadSha,
        mergedMainSha: suppliedMergedMainSha,
        prHeadCiIdentity: prHeadIdentity,
        prHeadEvent: 'pull_request',
        prHeadConclusion,
        mainPostMergeCiIdentity: mainPostMergeIdentity,
        mainPostMergeEvent: 'push',
        mainPostMergeConclusion: null,
        classification: 'MISSING_POST_MERGE_CI',
        mergeIdentityType,
        isValid: false,
        failsClosed: true,
        reason: `Supplied mergedMainSha (${suppliedMergedMainSha}) does not match GitHub mergeCommit.oid (${observedMergeCommitOid})`,
      };
    }

    const isMerged = Boolean(pr.mergedAt || params.mergedMainSha || pr.mergeCommit?.oid);
    const mergedMainSha = params.mergedMainSha ?? pr.mergeCommit?.oid ?? null;

    // Obtain PR-head Actions run evidence:
    // Check if statusCheckRollup already contains qualifying PR-head runs
    let prHeadChecks: GithubCheck[] = [];
    const qualifyingPrRollup = (pr.statusCheckRollup ?? []).filter((c) =>
      isQualifyingPrHeadCheck(c, params.expectedPrHeadSha)
    );

    if (qualifyingPrRollup.length > 0) {
      prHeadChecks = qualifyingPrRollup;
    } else {
      // Query exact-SHA GitHub Actions evidence where needed; do not synthesize missing event or SHA provenance
      try {
        const prRuns = await this.queryActionsRuns(params.repository, params.expectedPrHeadSha, 'pull_request');
        if (prRuns.length > 0) {
          prHeadChecks = prRuns;
        } else {
          prHeadChecks = pr.statusCheckRollup ?? [];
        }
      } catch {
        prHeadChecks = pr.statusCheckRollup ?? [];
      }
    }

    let mainPushChecks: GithubCheck[] | null = null;
    let mainPushConclusion: CiConclusion | null = null;

    if (isMerged && mergedMainSha) {
      try {
        const pushRuns = await this.queryActionsRuns(params.repository, mergedMainSha, 'push');
        if (pushRuns.length > 0) {
          mainPushChecks = pushRuns;
        } else {
          // If query returned no qualifying runs (e.g. non-push, wrong SHA, or missing provenance),
          // do NOT synthesize missing event or SHA provenance. An empty list ensures fail-closed.
          mainPushChecks = [];
        }
      } catch {
        mainPushChecks = null;
      }
    }

    return this.reconcileCiIdentities({
      repository: params.repository,
      prNumber: params.prNumber,
      expectedPrHeadSha: params.expectedPrHeadSha,
      observedPrHeadSha: pr.headRefOid,
      currentPrHeadOid: pr.headRefOid,
      prHeadEvent: 'pull_request',
      prHeadChecks,
      mergedMainSha,
      observedMergedMainSha: pr.mergeCommit?.oid ?? null,
      mainPushEvent: 'push',
      mainPushChecks,
      mainPushConclusion,
      isMerged,
    });
  }
}
