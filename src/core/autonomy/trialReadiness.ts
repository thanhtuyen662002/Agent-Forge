import {
  FAILURE_INJECTION_IDS,
  type FailureInjectionId,
} from './failureInjection';
import {
  canonicalizeTrialEvidenceManifest,
  type ProductionTrialEvidenceManifest,
  type ProductionTrialOutcome,
  type ProductionTrialPhase,
} from './trialEvidence';

/**
 * Inputs observed by an operator or a fixture runner before a trial phase is
 * started.  This is deliberately separate from the evidence manifest: a
 * manifest records what happened, while this input records the independent
 * facts that must be checked before an operator is allowed to proceed.
 *
 * All fields are optional at the type boundary because this interface is also
 * used for untrusted JSON loaded by the CLI.  Missing fields are reported as
 * HOLD checks; callers must never treat an omitted value as permission.
 */
export interface TrialReadinessInput {
  approvedSource?: { commitSha?: unknown; treeSha?: unknown };
  observedSource?: { commitSha?: unknown; treeSha?: unknown; cleanWorktree?: unknown };
  ciPassed?: unknown;
  buildPassed?: unknown;
  reviewerBuilt?: unknown;
  databaseBackupSha256?: unknown;
  syntheticProviderAccountIds?: unknown;
  liveProviderAccountIds?: unknown;
  credentialResolutionVerified?: unknown;
  networkStable?: unknown;
  quotaSufficient?: unknown;
  diskFreeGb?: unknown;
  redactionActive?: unknown;
  fixtureRepository?: unknown;
  separationPolicy?: unknown;
  designatedOperatorIds?: unknown;
  designatedApproverIds?: unknown;
  managerAuthorized?: unknown;
  executiveAuthorized?: unknown;
  injectionAuthorized?: unknown;
  releaseApproved?: unknown;
  baselineDatabaseSha256?: unknown;
  failureInjectionEvidenceIds?: unknown;
  failureInjectionWaivers?: unknown;
  previousPhaseOutcomes?: unknown;
  retentionLocationDesignated?: unknown;
}

export type TrialReadinessCheckStatus = 'PASS' | 'HOLD';
export type TrialReadinessStatus = 'READY' | 'HOLD';

export interface TrialReadinessCheck {
  id: string;
  status: TrialReadinessCheckStatus;
  detail: string;
}

export interface TrialReadinessResult {
  schemaVersion: 1;
  trialId: string;
  phase: ProductionTrialPhase;
  status: TrialReadinessStatus;
  checks: TrialReadinessCheck[];
  blockingReasons: string[];
}

const SHA256 = /^[0-9a-f]{64}$/i;
const GIT_SHA = /^[0-9a-f]{40}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PHASE_ORDER: readonly ProductionTrialPhase[] = ['R5L0', 'R5L1', 'R5L2', 'R5L3', 'R5L4'];
const REQUIRED_FAILURE_IDS: readonly FailureInjectionId[] = FAILURE_INJECTION_IDS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function gitSha(value: unknown): value is string {
  return typeof value === 'string' && GIT_SHA.test(value);
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000\r\n]/.test(value);
}

function booleanTrue(value: unknown): boolean {
  return value === true;
}

function uniqueSafeIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return null;
  const items = value.filter((item): item is string => safeId(item));
  if (items.length !== value.length) return null;
  return [...new Set(items)].sort();
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function phaseIndex(phase: ProductionTrialPhase): number {
  return PHASE_ORDER.indexOf(phase);
}

function check(
  checks: TrialReadinessCheck[],
  id: string,
  ok: boolean,
  detail: string,
): void {
  checks.push({ id, status: ok ? 'PASS' : 'HOLD', detail });
}

function addSourceChecks(
  manifest: ProductionTrialEvidenceManifest,
  input: TrialReadinessInput,
  checks: TrialReadinessCheck[],
): void {
  const approvedCommit = isRecord(input.approvedSource) ? input.approvedSource.commitSha : undefined;
  const approvedTree = isRecord(input.approvedSource) ? input.approvedSource.treeSha : undefined;
  const approved = gitSha(approvedCommit) && gitSha(approvedTree);
  check(
    checks,
    'source.approved_exact',
    approved
      && approvedCommit.toLowerCase() === manifest.source.commitSha
      && approvedTree.toLowerCase() === manifest.source.treeSha,
    approved ? 'approved commit and tree match the manifest' : 'approved source commit and tree SHA are missing or invalid',
  );

  const observedCommit = isRecord(input.observedSource) ? input.observedSource.commitSha : undefined;
  const observedTree = isRecord(input.observedSource) ? input.observedSource.treeSha : undefined;
  const observed = gitSha(observedCommit) && gitSha(observedTree);
  check(
    checks,
    'source.observed_exact',
    observed
      && observedCommit.toLowerCase() === manifest.source.commitSha
      && observedTree.toLowerCase() === manifest.source.treeSha,
    observed ? 'observed commit and tree match the manifest' : 'observed source commit and tree SHA are missing or invalid',
  );
  check(
    checks,
    'source.clean_worktree',
    observed && booleanTrue(input.observedSource!.cleanWorktree),
    booleanTrue(input.observedSource?.cleanWorktree) ? 'observed worktree is clean' : 'current worktree cleanliness was not independently confirmed',
  );
  check(
    checks,
    'ci.required_pass',
    booleanTrue(input.ciPassed),
    booleanTrue(input.ciPassed) ? 'mandatory CI result is marked passed' : 'mandatory CI result is absent or not passed',
  );
}

function addApprovalChecks(
  manifest: ProductionTrialEvidenceManifest,
  input: TrialReadinessInput,
  checks: TrialReadinessCheck[],
): void {
  const operators = uniqueSafeIds(input.designatedOperatorIds);
  const approvers = uniqueSafeIds(input.designatedApproverIds);
  check(
    checks,
    'approvals.identity_binding',
    operators !== null
      && approvers !== null
      && operators.length > 0
      && approvers.length > 0
      && sameIds(operators, manifest.approvals.operatorIds)
      && sameIds(approvers, manifest.approvals.approverIds),
    operators !== null && approvers !== null
      ? 'manifest operator and approver IDs match the designated identities'
      : 'designated operator and approver identity lists are missing or invalid',
  );
}

function addPreviousPhaseChecks(
  phase: ProductionTrialPhase,
  input: TrialReadinessInput,
  checks: TrialReadinessCheck[],
): void {
  const previous = isRecord(input.previousPhaseOutcomes) ? input.previousPhaseOutcomes : {};
  for (const required of PHASE_ORDER.slice(0, phaseIndex(phase))) {
    check(
      checks,
      `phases.${required}.pass`,
      previous[required] === 'PASS',
      previous[required] === 'PASS'
        ? `${required} has an independently recorded PASS outcome`
        : `${required} must have an independently recorded PASS outcome before ${phase}`,
    );
  }
}

function addArtifactCheck(
  manifest: ProductionTrialEvidenceManifest,
  checks: TrialReadinessCheck[],
  field: 'installerSha256' | 'appSha256' | 'databaseProjectionSha256',
  id: string,
): void {
  const value = manifest.artifacts[field];
  check(checks, id, value !== null && sha(value), value !== null ? `${field} is a valid SHA-256 digest` : `${field} artifact hash is required`);
}

function addProviderCheck(
  input: TrialReadinessInput,
  checks: TrialReadinessCheck[],
  field: 'syntheticProviderAccountIds' | 'liveProviderAccountIds',
  id: string,
  label: string,
): void {
  const ids = uniqueSafeIds(input[field]);
  check(
    checks,
    id,
    ids !== null && ids.length >= 2,
    ids !== null && ids.length >= 2 ? `${label} has at least two distinct account identities` : `${label} requires at least two distinct account identities`,
  );
}

function addDatabaseBackupCheck(input: TrialReadinessInput, checks: TrialReadinessCheck[], id: string): void {
  check(
    checks,
    id,
    sha(input.databaseBackupSha256),
    sha(input.databaseBackupSha256) ? 'database backup digest is recorded' : 'an immutable database backup SHA-256 is required',
  );
}

function addFailureInjectionCoverageCheck(input: TrialReadinessInput, checks: TrialReadinessCheck[]): void {
  const evidence = uniqueSafeIds(input.failureInjectionEvidenceIds) ?? [];
  const waivers = uniqueSafeIds(input.failureInjectionWaivers) ?? [];
  const covered = new Set([...evidence, ...waivers]);
  const allCovered = REQUIRED_FAILURE_IDS.every((id) => covered.has(id));
  const unknown = [...covered].some((id) => !(REQUIRED_FAILURE_IDS as readonly string[]).includes(id));
  check(
    checks,
    'failure_injection.coverage',
    allCovered && !unknown,
    allCovered && !unknown
      ? 'all FI-01 through FI-15 scenarios have evidence or an explicit waiver'
      : 'every mandatory FI-01 through FI-15 scenario needs evidence or an explicit waiver',
  );
}

/**
 * Evaluate a phase without performing any external operation.  The result is
 * READY only when every check passes.  Missing, malformed, or contradictory
 * operator input always produces HOLD, which keeps this helper safe for CLI
 * JSON and fixture data.
 */
export function evaluateTrialReadiness(
  manifest: ProductionTrialEvidenceManifest,
  input: TrialReadinessInput,
): TrialReadinessResult {
  // Re-run the strict manifest normalizer so a caller cannot bypass the
  // evidence contract by constructing a structurally similar object.
  const normalized = JSON.parse(canonicalizeTrialEvidenceManifest(manifest)) as ProductionTrialEvidenceManifest;
  const checks: TrialReadinessCheck[] = [];
  addSourceChecks(normalized, input ?? {}, checks);
  addApprovalChecks(normalized, input ?? {}, checks);
  check(
    checks,
    'manifest.outcome_pass',
    normalized.outcome === 'PASS',
    normalized.outcome === 'PASS' ? 'manifest outcome is PASS' : 'a HOLD or FAIL manifest cannot authorize a phase',
  );
  addPreviousPhaseChecks(normalized.phase, input ?? {}, checks);

  switch (normalized.phase) {
    case 'R5L0':
      check(checks, 'authorization.manager', booleanTrue(input?.managerAuthorized), booleanTrue(input?.managerAuthorized) ? 'manager audit authorization recorded' : 'manager audit authorization is required for R5L0');
      break;
    case 'R5L1':
      check(checks, 'authorization.manager', booleanTrue(input?.managerAuthorized), booleanTrue(input?.managerAuthorized) ? 'manager authorization recorded' : 'manager authorization is required for R5L1');
      addDatabaseBackupCheck(input ?? {}, checks, 'database.synthetic_backup');
      addArtifactCheck(normalized, checks, 'databaseProjectionSha256', 'artifacts.database_projection');
      addProviderCheck(input ?? {}, checks, 'syntheticProviderAccountIds', 'providers.synthetic_separation', 'synthetic provider fixture');
      check(checks, 'providers.separation_policy', input?.separationPolicy === 'REQUIRE_DIFFERENT', input?.separationPolicy === 'REQUIRE_DIFFERENT' ? 'REQUIRE_DIFFERENT separation policy is active' : 'REQUIRE_DIFFERENT separation policy is required');
      check(checks, 'fixtures.repository', boundedText(input?.fixtureRepository), boundedText(input?.fixtureRepository) ? 'isolated synthetic fixture repository is designated' : 'an isolated synthetic fixture repository is required');
      check(checks, 'build.completed', booleanTrue(input?.buildPassed), booleanTrue(input?.buildPassed) ? 'build evidence is marked passed' : 'successful build evidence is required');
      check(checks, 'reviewer.built', booleanTrue(input?.reviewerBuilt), booleanTrue(input?.reviewerBuilt) ? 'read-only reviewer build is verified' : 'read-only reviewer build evidence is required');
      break;
    case 'R5L2':
      check(checks, 'authorization.executive', booleanTrue(input?.executiveAuthorized), booleanTrue(input?.executiveAuthorized) ? 'executive live-trial authorization recorded' : 'executive live-trial authorization is required for R5L2');
      addDatabaseBackupCheck(input ?? {}, checks, 'database.live_backup');
      addArtifactCheck(normalized, checks, 'installerSha256', 'artifacts.installer');
      addArtifactCheck(normalized, checks, 'appSha256', 'artifacts.application');
      addArtifactCheck(normalized, checks, 'databaseProjectionSha256', 'artifacts.database_projection');
      addProviderCheck(input ?? {}, checks, 'liveProviderAccountIds', 'providers.live_separation', 'live provider');
      check(checks, 'credentials.resolution', booleanTrue(input?.credentialResolutionVerified), booleanTrue(input?.credentialResolutionVerified) ? 'credential handles resolved without plaintext output' : 'credential handle resolution must be verified');
      check(checks, 'host.disk_space', typeof input?.diskFreeGb === 'number' && Number.isFinite(input.diskFreeGb) && input.diskFreeGb >= 5, typeof input?.diskFreeGb === 'number' && input.diskFreeGb >= 5 ? 'at least 5 GB free disk space is verified' : 'at least 5 GB free disk space is required');
      check(checks, 'logging.redaction', booleanTrue(input?.redactionActive), booleanTrue(input?.redactionActive) ? 'redaction is active' : 'redaction must be verified before live execution');
      check(checks, 'network.stable', booleanTrue(input?.networkStable), booleanTrue(input?.networkStable) ? 'network stability is verified' : 'network stability must be verified');
      check(checks, 'provider.quota', booleanTrue(input?.quotaSufficient), booleanTrue(input?.quotaSufficient) ? 'provider quota is sufficient' : 'provider quota must be verified');
      check(checks, 'retention.designated', booleanTrue(input?.retentionLocationDesignated), booleanTrue(input?.retentionLocationDesignated) ? 'secure evidence retention location is designated' : 'secure evidence retention location must be designated');
      break;
    case 'R5L3':
      check(checks, 'authorization.injection', booleanTrue(input?.injectionAuthorized), booleanTrue(input?.injectionAuthorized) ? 'failure-injection authorization recorded' : 'failure-injection authorization is required for R5L3');
      check(checks, 'database.baseline', sha(input?.baselineDatabaseSha256), sha(input?.baselineDatabaseSha256) ? 'baseline database digest is recorded' : 'an immutable baseline database SHA-256 is required');
      addFailureInjectionCoverageCheck(input ?? {}, checks);
      break;
    case 'R5L4':
      check(checks, 'authorization.release', booleanTrue(input?.releaseApproved), booleanTrue(input?.releaseApproved) ? 'release decision approval recorded' : 'release decision approval is required for R5L4');
      addArtifactCheck(normalized, checks, 'installerSha256', 'artifacts.installer');
      addArtifactCheck(normalized, checks, 'appSha256', 'artifacts.application');
      addArtifactCheck(normalized, checks, 'databaseProjectionSha256', 'artifacts.database_projection');
      check(checks, 'evidence.bundle', normalized.evidence.length > 0, normalized.evidence.length > 0 ? 'evidence entries are present' : 'at least one verified evidence entry is required');
      check(checks, 'retention.designated', booleanTrue(input?.retentionLocationDesignated), booleanTrue(input?.retentionLocationDesignated) ? 'secure evidence retention location is designated' : 'secure evidence retention location must be designated');
      break;
    default:
      // The manifest normalizer already rejects unsupported phases.  Keep a
      // defensive branch for future enum expansion so new phases default HOLD.
      check(checks, 'phase.supported', false, 'unsupported trial phase');
  }

  const blockingReasons = checks.filter((item) => item.status === 'HOLD').map((item) => `${item.id}: ${item.detail}`);
  return {
    schemaVersion: 1,
    trialId: normalized.trialId,
    phase: normalized.phase,
    status: blockingReasons.length === 0 ? 'READY' : 'HOLD',
    checks,
    blockingReasons,
  };
}
