import crypto from 'crypto';
import { z } from 'zod';
import type { GitEvidence, ManagerReview } from './contracts';
import type { CoderEditBundle } from './responsesCoderEndpoint';

const ShaSchema = z.string().trim().regex(/^[0-9a-f]{40}$/i, 'must be a 40-character Git SHA');
const NonEmptyString = z.string().trim().min(1);

export const ReviewerRepairFindingSchema = z.object({
  finding_id: NonEmptyString,
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  title: NonEmptyString,
  description: NonEmptyString,
  file_path: NonEmptyString.nullable().optional(),
  line_number: z.number().int().positive().nullable().optional(),
  evidence: z.string().default(''),
  required_action: NonEmptyString,
  acceptance_evidence: z.string().default(''),
}).strict();
export type ReviewerRepairFinding = z.infer<typeof ReviewerRepairFindingSchema>;
export type RepairFinding = ReviewerRepairFinding;

export const TestResultItemSchema = z.object({
  command: NonEmptyString,
  exitCode: z.number().int(),
  passed: z.boolean(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  durationMs: z.number().optional(),
}).strict();
export type TestResultItem = z.infer<typeof TestResultItemSchema>;

export const PreviousCoderActionSchema = z.object({
  attempt: z.number().int().positive(),
  changed_files: z.array(NonEmptyString),
  diff_summary: z.string(),
  test_results: z.array(TestResultItemSchema),
  addressed_finding_ids: z.array(NonEmptyString).default([]),
  unresolved_finding_ids: z.array(NonEmptyString).default([]),
  implementation_summary: z.string().optional(),
  known_risks: z.array(NonEmptyString).default([]),
  patch_hash: z.string().optional(),
  snapshot_sha: z.string().optional(),
  head_sha: z.string().optional(),
}).strict();
export type PreviousCoderAction = z.infer<typeof PreviousCoderActionSchema>;

export const FailedApproachSchema = z.object({
  attempt: z.number().int().positive(),
  description: NonEmptyString,
  test_failure_signatures: z.array(NonEmptyString).default([]),
  category: z.string().optional(),
}).strict();
export type FailedApproach = z.infer<typeof FailedApproachSchema>;

export const RepairEscalationStageSchema = z.enum([
  'NORMAL_CODER',
  'EXPLICIT_EVIDENCE',
  'SPECIALIST_OR_FALLBACK',
]);
export type RepairEscalationStage = z.infer<typeof RepairEscalationStageSchema>;

export const MAX_REPAIR_LOOPS = 3;

export const RepairContextPackageSchema = z.object({
  protocol_version: z.literal('repaircontext.v1'),
  task_id: NonEmptyString,
  authorization_id: NonEmptyString,
  ownership_epoch: z.number().int().positive(),
  attempt: z.number().int().positive(),
  base_sha: ShaSchema,
  current_head_sha: ShaSchema,
  current_snapshot_sha: NonEmptyString,
  original_objective: NonEmptyString,
  acceptance_criteria: z.array(NonEmptyString).min(1),
  allowed_paths: z.array(NonEmptyString).min(1),
  forbidden_paths: z.array(NonEmptyString),
  required_tests: z.array(NonEmptyString),
  previous_reviewer_findings: z.array(ReviewerRepairFindingSchema),
  required_actions: z.array(NonEmptyString),
  resolved_finding_ids: z.array(NonEmptyString),
  unresolved_finding_ids: z.array(NonEmptyString),
  previous_coder_actions: z.array(PreviousCoderActionSchema),
  known_failed_approaches: z.array(FailedApproachSchema),
  non_regression_constraints: z.array(NonEmptyString),
  selected_resource_id: z.string().nullable().optional(),
  selected_provider_id: z.string().nullable().optional(),
  escalation_stage: RepairEscalationStageSchema.optional(),
}).strict();
export type RepairContextPackage = z.infer<typeof RepairContextPackageSchema>;

export const NoProgressCategorySchema = z.enum([
  'NO_OP_WITH_UNRESOLVED_ACTIONS',
  'UNCHANGED_SNAPSHOT_OR_DIFF',
  'REPEATED_FAILING_TEST_SIGNATURES',
  'UNCHANGED_UNRESOLVED_FINDINGS',
  'SEMANTICALLY_EQUIVALENT_REPEATED_PATCH',
  'REGRESSION_OR_REVERSION_OF_EARLIER_VALID_FIX',
]);
export type NoProgressCategory = z.infer<typeof NoProgressCategorySchema>;

export interface NoProgressEvaluation {
  hasNoProgress: boolean;
  category?: NoProgressCategory;
  reason?: string;
  details?: Record<string, unknown>;
}

export const RepairOutcomeStatusSchema = z.enum([
  'CONVERGED',
  'NO_PROGRESS',
  'FAILED',
  'ESCALATED',
  'BLOCKED',
]);
export type RepairOutcomeStatus = z.infer<typeof RepairOutcomeStatusSchema>;

export const RepairOutcomeSchema = z.object({
  protocol_version: z.literal('repairoutcome.v1'),
  task_id: NonEmptyString,
  attempt: z.number().int().positive(),
  status: RepairOutcomeStatusSchema,
  resolved_finding_ids: z.array(NonEmptyString),
  unresolved_finding_ids: z.array(NonEmptyString),
  no_progress_category: NoProgressCategorySchema.nullable().optional(),
  escalation_stage: RepairEscalationStageSchema,
  summary: NonEmptyString,
  head_sha: ShaSchema,
  snapshot_sha: NonEmptyString,
  created_at: z.string(),
}).strict();
export type RepairOutcome = z.infer<typeof RepairOutcomeSchema>;

export interface FindingClosureResult {
  resolvedFindingIds: string[];
  unresolvedFindingIds: string[];
  closureReconciled: boolean;
  unverifiedClaims: string[];
}

export interface RepairLineage {
  taskId: string;
  authorizationId: string;
  ownershipEpoch: number;
  latestAttempt: number;
  baseSha: string;
  currentHeadSha: string;
  currentSnapshotSha: string;
  findings: ReviewerRepairFinding[];
  resolvedFindingIds: string[];
  unresolvedFindingIds: string[];
  previousCoderActions: PreviousCoderAction[];
  knownFailedApproaches: FailedApproach[];
  nonRegressionConstraints: string[];
  selectedResourceId: string | null;
  selectedProviderId: string | null;
  packages: RepairContextPackage[];
  outcomes: RepairOutcome[];
}

/**
 * Deterministically derives a stable finding ID when an explicit finding_id is omitted.
 * Semantically unchanged findings (same normalized title, description, file_path, line, and action)
 * derive the exact same ID across revisions.
 */
export function deriveFindingId(finding: {
  finding_id?: string | null;
  title: string;
  description: string;
  file_path?: string | null;
  line_number?: number | null;
  required_action?: string | null;
}): string {
  if (finding.finding_id && finding.finding_id.trim().length > 0) {
    return finding.finding_id.trim();
  }

  const normalized = [
    finding.title.trim().toLowerCase(),
    finding.description.trim().toLowerCase(),
    (finding.file_path ?? '').replace(/\\/g, '/').trim().toLowerCase(),
    String(finding.line_number ?? ''),
    (finding.required_action ?? '').trim().toLowerCase(),
  ].join('::');

  const digest = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
  return `finding-${digest}`;
}

/**
 * Normalizes an array of reviewer findings, ensuring stable deterministic IDs,
 * evidence, required_action, and acceptance_evidence are populated.
 */
export function normalizeReviewerFindings(
  findings: Array<{
    finding_id?: string | null;
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    title: string;
    description: string;
    file_path?: string | null;
    line_number?: number | null;
    evidence?: string | null;
    required_action?: string | null;
    acceptance_evidence?: string | null;
  }>,
  fallbackRequiredActions: string[] = [],
): ReviewerRepairFinding[] {
  return findings.map((f, index) => {
    const title = f.title.trim();
    const description = f.description.trim();
    const explicitAction = f.required_action?.trim();
    const fallbackAction = fallbackRequiredActions[index]?.trim();
    const required_action = explicitAction || fallbackAction || `Address finding: ${title}`;
    const finding_id = deriveFindingId({ ...f, required_action });
    const evidence = f.evidence?.trim() || description;
    const acceptance_evidence = f.acceptance_evidence?.trim() || `Verified resolution for ${title}`;

    return {
      finding_id,
      severity: f.severity,
      title,
      description,
      file_path: f.file_path ? f.file_path.replace(/\\/g, '/').trim() : null,
      line_number: f.line_number ?? null,
      evidence,
      required_action,
      acceptance_evidence,
    };
  });
}

function sortJsonKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(sortJsonKeys);
  }
  if (obj !== null && typeof obj === 'object') {
    const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = sortJsonKeys((obj as Record<string, unknown>)[key]);
    }
    return result;
  }
  return obj;
}

/**
 * Canonical deterministic JSON serialization of RepairContextPackage.
 * Object keys are sorted deterministically at every level.
 */
export function canonicalSerializeRepairContext(pkg: RepairContextPackage): string {
  const parsed = RepairContextPackageSchema.parse(pkg);
  const sorted = sortJsonKeys(parsed);
  return JSON.stringify(sorted);
}

/**
 * Computes deterministic SHA-256 hash of canonical RepairContextPackage serialization.
 */
export function computeRepairContextHash(pkg: RepairContextPackage): string {
  const canonicalJson = canonicalSerializeRepairContext(pkg);
  return crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

/**
 * Parses and strictly validates a raw JSON string into a RepairContextPackage.
 */
export function parseRepairContextPackage(raw: string): RepairContextPackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`CONTRACT_INVALID: repaircontext.v1 must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = RepairContextPackageSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`CONTRACT_INVALID: invalid repaircontext.v1 package: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Computes a normalized patch hash ignoring minor whitespace and CRLF vs LF differences.
 */
export function computeNormalizedPatchHash(diff: string): string {
  const normalized = diff
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !line.startsWith('index ') && !line.startsWith('@@') && !line.startsWith('\\ No newline'))
    .join('\n')
    .trim();
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Extracts normalized failing test signatures from test execution results.
 */
export function extractFailingTestSignatures(tests: Array<{ command: string; exitCode: number; stdout?: string; stderr?: string }>): string[] {
  return tests
    .filter((t) => t.exitCode !== 0)
    .map((t) => {
      const errBrief = (t.stderr || t.stdout || '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.includes('duration') && !l.includes('Timestamp'))
        .slice(0, 5)
        .join(' ');
      const digest = crypto.createHash('sha256').update(errBrief, 'utf8').digest('hex').slice(0, 8);
      return `${t.command.trim()}::code=${t.exitCode}::sig=${digest}`;
    })
    .sort();
}

/**
 * Independently reconciles finding closure claims. Never treats coder claims as proof.
 * Supervisor checks paths, diff, tests, snapshots, and reviewer findings before closing.
 */
export function reconcileFindingClosure(params: {
  repairContext: RepairContextPackage;
  coderBundle?: CoderEditBundle | null;
  observedEvidence: GitEvidence;
  latestReview?: ManagerReview | null;
}): FindingClosureResult {
  const { repairContext, coderBundle, observedEvidence, latestReview } = params;
  const claimedAddressed = new Set(coderBundle?.addressed_finding_ids ?? []);
  const claimedUnresolved = new Set(coderBundle?.unresolved_finding_ids ?? []);
  const unverifiedClaims: string[] = [];

  const allTestsPassed = observedEvidence.tests.length > 0 && observedEvidence.tests.every((t) => t.exitCode === 0);
  const diffModifiedFiles = new Set(observedEvidence.changedFiles.map((f) => f.replace(/\\/g, '/').toLowerCase()));

  // If latest review exists, extract remaining finding IDs
  const reviewRemainingFindingIds = new Set<string>();
  if (latestReview) {
    for (const f of latestReview.findings) {
      reviewRemainingFindingIds.add(deriveFindingId(f));
      if (f.finding_id) reviewRemainingFindingIds.add(f.finding_id);
    }
  }

  const resolvedFindingIds: string[] = [...repairContext.resolved_finding_ids];
  const unresolvedFindingIds: string[] = [];

  for (const finding of repairContext.previous_reviewer_findings) {
    const fid = finding.finding_id;

    // If it was already resolved earlier, check if it regressed
    if (repairContext.resolved_finding_ids.includes(fid)) {
      if (latestReview && reviewRemainingFindingIds.has(fid)) {
        // Regressed!
        unresolvedFindingIds.push(fid);
        const idx = resolvedFindingIds.indexOf(fid);
        if (idx >= 0) resolvedFindingIds.splice(idx, 1);
      }
      continue;
    }

    // Check coder claims vs independent verification
    const coderClaimedResolved = claimedAddressed.has(fid);
    const coderClaimedUnresolved = claimedUnresolved.has(fid);

    // Rule 1: Tests must pass
    if (!allTestsPassed) {
      unresolvedFindingIds.push(fid);
      if (coderClaimedResolved) unverifiedClaims.push(fid);
      continue;
    }

    // Rule 2: Review must not report this finding as active
    if (latestReview) {
      if (latestReview.verdict === 'PASS' && !reviewRemainingFindingIds.has(fid)) {
        resolvedFindingIds.push(fid);
        continue;
      }
      if (reviewRemainingFindingIds.has(fid)) {
        unresolvedFindingIds.push(fid);
        if (coderClaimedResolved) unverifiedClaims.push(fid);
        continue;
      }
    }

    // Rule 3: Associated file must have actually been modified in diff
    if (finding.file_path) {
      const normFile = finding.file_path.replace(/\\/g, '/').toLowerCase();
      if (!diffModifiedFiles.has(normFile) && ![...diffModifiedFiles].some((d) => d.endsWith(normFile) || normFile.endsWith(d))) {
        unresolvedFindingIds.push(fid);
        if (coderClaimedResolved) unverifiedClaims.push(fid);
        continue;
      }
    }

    // If coder claimed unresolved, keep it unresolved
    if (coderClaimedUnresolved) {
      unresolvedFindingIds.push(fid);
      continue;
    }

    // If review verdict was PASS, or tests passed and diff addressed finding
    if (latestReview?.verdict === 'PASS' || (allTestsPassed && diffModifiedFiles.size > 0)) {
      resolvedFindingIds.push(fid);
    } else {
      unresolvedFindingIds.push(fid);
      if (coderClaimedResolved) unverifiedClaims.push(fid);
    }
  }

  // Deduplicate and sort
  const finalResolved = [...new Set(resolvedFindingIds)].sort();
  const finalUnresolved = [...new Set(unresolvedFindingIds)].sort();

  return {
    resolvedFindingIds: finalResolved,
    unresolvedFindingIds: finalUnresolved,
    closureReconciled: finalUnresolved.length === 0 && finalResolved.length > 0,
    unverifiedClaims,
  };
}

/**
 * Evaluates semantic no-progress across the 6 authorized categories:
 * 1. NO_OP_WITH_UNRESOLVED_ACTIONS
 * 2. UNCHANGED_SNAPSHOT_OR_DIFF
 * 3. REPEATED_FAILING_TEST_SIGNATURES
 * 4. UNCHANGED_UNRESOLVED_FINDINGS
 * 5. SEMANTICALLY_EQUIVALENT_REPEATED_PATCH
 * 6. REGRESSION_OR_REVERSION_OF_EARLIER_VALID_FIX
 */
export function detectNoProgress(params: {
  repairContext: RepairContextPackage;
  currentEvidence: GitEvidence;
  coderBundle?: CoderEditBundle | null;
  reconciledClosure?: FindingClosureResult | null;
  latestReview?: ManagerReview | null;
}): NoProgressEvaluation {
  const { repairContext, currentEvidence, coderBundle, reconciledClosure, latestReview } = params;

  // Category 1: NO_OP_WITH_UNRESOLVED_ACTIONS
  const hasEdits = (coderBundle?.proposed_edits && coderBundle.proposed_edits.length > 0) ||
    currentEvidence.diff.trim().length > 0 ||
    currentEvidence.changedFiles.length > 0;
  const hasUnresolved = repairContext.unresolved_finding_ids.length > 0 || repairContext.required_actions.length > 0;
  if (!hasEdits && hasUnresolved) {
    return {
      hasNoProgress: true,
      category: 'NO_OP_WITH_UNRESOLVED_ACTIONS',
      reason: 'Coder produced no file changes while unresolved repair actions remain pending.',
      details: {
        unresolvedFindings: repairContext.unresolved_finding_ids,
        requiredActions: repairContext.required_actions,
      },
    };
  }

  // Category 2: UNCHANGED_SNAPSHOT_OR_DIFF
  const currentSnapshot = currentEvidence.snapshotSha;
  if (
    currentSnapshot &&
    repairContext.current_snapshot_sha &&
    currentSnapshot === repairContext.current_snapshot_sha &&
    hasUnresolved
  ) {
    return {
      hasNoProgress: true,
      category: 'UNCHANGED_SNAPSHOT_OR_DIFF',
      reason: 'Working tree snapshot SHA is unchanged from the prior attempt while findings remain unresolved.',
      details: {
        snapshotSha: currentSnapshot,
        unresolvedFindings: repairContext.unresolved_finding_ids,
      },
    };
  }

  // Check diff match with prior attempt
  const currentDiff = currentEvidence.diff.trim();
  const lastAction = repairContext.previous_coder_actions.at(-1);
  if (lastAction && currentDiff.length > 0 && lastAction.diff_summary === currentDiff && hasUnresolved) {
    return {
      hasNoProgress: true,
      category: 'UNCHANGED_SNAPSHOT_OR_DIFF',
      reason: 'Current diff is identical to the prior attempt while findings remain unresolved.',
      details: {
        diffLength: currentDiff.length,
      },
    };
  }

  // Category 6: REGRESSION_OR_REVERSION_OF_EARLIER_VALID_FIX
  // Evaluated before repeated tests and patches so regression/reversion precedence is never masked.
  if (reconciledClosure) {
    for (const resolvedId of repairContext.resolved_finding_ids) {
      if (reconciledClosure.unresolvedFindingIds.includes(resolvedId)) {
        return {
          hasNoProgress: true,
          category: 'REGRESSION_OR_REVERSION_OF_EARLIER_VALID_FIX',
          reason: `Previously resolved finding "${resolvedId}" regressed or was reverted in this attempt.`,
          details: {
            regressedFindingId: resolvedId,
          },
        };
      }
    }
  }

  // Category 3: REPEATED_FAILING_TEST_SIGNATURES
  const currentFailingSignatures = extractFailingTestSignatures(currentEvidence.tests);
  if (currentFailingSignatures.length > 0) {
    // Check against prior test failure signatures recorded in failed approaches
    for (const failedApproach of repairContext.known_failed_approaches) {
      if (
        failedApproach.test_failure_signatures.length > 0 &&
        failedApproach.test_failure_signatures.length === currentFailingSignatures.length &&
        failedApproach.test_failure_signatures.every((sig, idx) => sig === currentFailingSignatures[idx])
      ) {
        return {
          hasNoProgress: true,
          category: 'REPEATED_FAILING_TEST_SIGNATURES',
          reason: `Exact failing test signatures repeated from prior attempt ${failedApproach.attempt} without improvement.`,
          details: {
            matchingAttempt: failedApproach.attempt,
            signatures: currentFailingSignatures,
          },
        };
      }
    }
  }

  // Category 5: SEMANTICALLY_EQUIVALENT_REPEATED_PATCH
  if (currentDiff.length > 0) {
    const currentPatchHash = computeNormalizedPatchHash(currentDiff);
    for (const prev of repairContext.previous_coder_actions) {
      const prevHash = prev.patch_hash;
      const prevSummaryHash = prev.diff_summary ? computeNormalizedPatchHash(prev.diff_summary) : undefined;
      const patchMatches = (prevHash && currentPatchHash === prevHash) || (prevSummaryHash && currentPatchHash === prevSummaryHash);
      if (patchMatches && hasUnresolved) {
        return {
          hasNoProgress: true,
          category: 'SEMANTICALLY_EQUIVALENT_REPEATED_PATCH',
          reason: `Current patch is semantically equivalent to prior attempt ${prev.attempt}.`,
          details: {
            matchingAttempt: prev.attempt,
            patchHash: currentPatchHash,
          },
        };
      }
    }
  }

  // Category 4: UNCHANGED_UNRESOLVED_FINDINGS
  if (reconciledClosure) {
    const priorUnresolved = [...repairContext.unresolved_finding_ids].sort();
    const currentUnresolved = [...reconciledClosure.unresolvedFindingIds].sort();
    if (
      priorUnresolved.length > 0 &&
      priorUnresolved.length === currentUnresolved.length &&
      priorUnresolved.every((id, idx) => id === currentUnresolved[idx]) &&
      latestReview?.verdict !== 'PASS'
    ) {
      return {
        hasNoProgress: true,
        category: 'UNCHANGED_UNRESOLVED_FINDINGS',
        reason: 'Set of unresolved findings is completely unchanged after review; zero findings were closed.',
        details: {
          unresolvedFindingIds: currentUnresolved,
        },
      };
    }
  }

  return { hasNoProgress: false };
}

/**
 * Determines escalation stage based on attempt count (1-indexed).
 */
export function getEscalationStage(attempt: number): RepairEscalationStage {
  if (attempt <= 1) return 'NORMAL_CODER';
  if (attempt === 2) return 'EXPLICIT_EVIDENCE';
  return 'SPECIALIST_OR_FALLBACK';
}

/**
 * Constructs an actionable structured prompt for a repair attempt respecting the escalation policy.
 */
export function buildRepairPrompt(pkg: RepairContextPackage, stage: RepairEscalationStage): string {
  const lines: string[] = [];
  lines.push('You are the Agent Forge repair coder. You return proposed edits to resolve reviewer findings.');
  lines.push('Return exactly one JSON object matching coderbundle.v1 and no markdown.');

  if (stage === 'NORMAL_CODER') {
    lines.push('Stage 1: Resolve all reviewer findings using the provided repair context package.');
  } else if (stage === 'EXPLICIT_EVIDENCE') {
    lines.push('Stage 2 ESCALATION: Previous attempt failed. You must address the unresolved findings below and avoid repeating prior failures.');
    lines.push(`UNRESOLVED FINDING IDs: ${pkg.unresolved_finding_ids.join(', ')}`);
    if (pkg.previous_coder_actions.length > 0) {
      lines.push('PRIOR ATTEMPT HISTORY:');
      for (const act of pkg.previous_coder_actions) {
        lines.push(`- Attempt ${act.attempt}: changed files [${act.changed_files.join(', ')}], summary: ${act.implementation_summary || act.diff_summary.slice(0, 100) || 'none'}`);
      }
    }
    lines.push('KNOWN FAILED APPROACHES:');
    if (pkg.known_failed_approaches.length > 0) {
      for (const fa of pkg.known_failed_approaches) {
        lines.push(`- Attempt ${fa.attempt}: ${fa.description}`);
      }
    } else {
      lines.push('- Prior attempt failed to resolve required findings without introducing regressions.');
    }
  } else {
    lines.push('Stage 3 FINAL ESCALATION: Specialized repair attempt. Resolve remaining findings with strict non-regression guarantees.');
    lines.push(`UNRESOLVED FINDING IDs: ${pkg.unresolved_finding_ids.join(', ')}`);
    if (pkg.previous_coder_actions.length > 0) {
      lines.push('PRIOR ATTEMPT HISTORY:');
      for (const act of pkg.previous_coder_actions) {
        lines.push(`- Attempt ${act.attempt}: changed files [${act.changed_files.join(', ')}], summary: ${act.implementation_summary || act.diff_summary.slice(0, 100) || 'none'}`);
      }
    }
    lines.push('KNOWN FAILED APPROACHES:');
    if (pkg.known_failed_approaches.length > 0) {
      for (const fa of pkg.known_failed_approaches) {
        lines.push(`- Attempt ${fa.attempt}: ${fa.description}`);
      }
    } else {
      lines.push('- Prior attempts failed to converge. Strict verification required.');
    }
  }

  lines.push('Report addressed_finding_ids, unresolved_finding_ids, implementation_summary, changed_files, and known_risks in your coderbundle.v1.');
  return lines.join('\n');
}

/**
 * Pure factory for creating a durable RepairContextPackage.
 */
export function buildRepairContextPackage(params: {
  taskId: string;
  authorizationId: string;
  ownershipEpoch: number;
  attempt: number;
  baseSha: string;
  currentHeadSha: string;
  currentSnapshotSha: string;
  originalObjective: string;
  acceptanceCriteria: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  requiredTests: string[];
  reviewerFindings: Array<{
    finding_id?: string | null;
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    title: string;
    description: string;
    file_path?: string | null;
    line_number?: number | null;
    evidence?: string | null;
    required_action?: string | null;
    acceptance_evidence?: string | null;
  }>;
  requiredActions: string[];
  previousResolvedFindingIds?: string[];
  unresolvedFindingIds?: string[];
  previousCoderActions?: PreviousCoderAction[];
  knownFailedApproaches?: FailedApproach[];
  nonRegressionConstraints?: string[];
  selectedResourceId?: string | null;
  selectedProviderId?: string | null;
}): RepairContextPackage {
  const normalizedFindings = normalizeReviewerFindings(params.reviewerFindings, params.requiredActions);
  const resolvedIds = params.previousResolvedFindingIds ?? [];
  const unresolvedIds = params.unresolvedFindingIds ?? normalizedFindings
    .map((f) => f.finding_id)
    .filter((id) => !resolvedIds.includes(id));

  const stage = getEscalationStage(params.attempt);

  return RepairContextPackageSchema.parse({
    protocol_version: 'repaircontext.v1',
    task_id: params.taskId,
    authorization_id: params.authorizationId,
    ownership_epoch: params.ownershipEpoch,
    attempt: params.attempt,
    base_sha: params.baseSha,
    current_head_sha: params.currentHeadSha,
    current_snapshot_sha: params.currentSnapshotSha,
    original_objective: params.originalObjective,
    acceptance_criteria: [...params.acceptanceCriteria],
    allowed_paths: [...params.allowedPaths],
    forbidden_paths: [...params.forbiddenPaths],
    required_tests: [...params.requiredTests],
    previous_reviewer_findings: normalizedFindings,
    required_actions: [...params.requiredActions],
    resolved_finding_ids: resolvedIds,
    unresolved_finding_ids: unresolvedIds,
    previous_coder_actions: params.previousCoderActions ?? [],
    known_failed_approaches: params.knownFailedApproaches ?? [],
    non_regression_constraints: params.nonRegressionConstraints ?? [
      'Do not regress previously passing deterministic tests.',
      'Do not edit paths outside allowed_paths.',
    ],
    selected_resource_id: params.selectedResourceId ?? null,
    selected_provider_id: params.selectedProviderId ?? null,
    escalation_stage: stage,
  });
}
