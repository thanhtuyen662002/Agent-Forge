import crypto from 'crypto';
import { ManagerReview } from './contracts';

/** Review-generated IDs and line numbers are deliberately excluded from identity. */
export function stableFindingSignature(review: ManagerReview, verified: boolean, fresh: boolean): string {
  const findings = review.findings.map((finding) => [
    finding.severity,
    finding.file_path?.replace(/\\/g, '/').toLowerCase() ?? '',
    finding.title.trim().replace(/\s+/g, ' ').toLowerCase(),
  ].join('|')).sort();
  return crypto.createHash('sha256').update(JSON.stringify({ findings, verified, fresh })).digest('hex');
}

export interface RepairObservation {
  signature: string;
  snapshotSha: string;
}

/** An unchanged snapshot with the same semantic findings is not a repair. */
export function hasSemanticProgress(previous: RepairObservation | null, current: RepairObservation): boolean {
  return !previous || previous.signature !== current.signature || previous.snapshotSha !== current.snapshotSha;
}


export interface PersistedRepairEvent {
  review?: ManagerReview;
  verified?: boolean;
  fresh?: boolean;
  signature?: string;
  snapshotSha?: string;
}

export interface RepairConvergenceState {
  repairLoops: number;
  previousRepair: RepairObservation | null;
}

/**
 * Reconstruct semantic repair state from durable REPAIR_REQUIRED payloads.
 * Malformed JSON fails closed instead of silently resetting the repair budget.
 */
export function recoverRepairConvergence(payloadJson: string[]): RepairConvergenceState {
  let previousRepair: RepairObservation | null = null;
  for (const raw of payloadJson) {
    const payload = JSON.parse(raw) as PersistedRepairEvent;
    if (payload.review && typeof payload.snapshotSha === 'string') {
      previousRepair = {
        signature: payload.signature
          ?? stableFindingSignature(payload.review, !!payload.verified, !!payload.fresh),
        snapshotSha: payload.snapshotSha,
      };
    }
  }
  return { repairLoops: payloadJson.length, previousRepair };
}

export type RepairConvergenceDecision =
  | { outcome: 'CONTINUE'; nextRepairLoops: number }
  | { outcome: 'SEMANTIC_NO_PROGRESS'; nextRepairLoops: number }
  | { outcome: 'MAX_REPAIR_LOOPS_EXCEEDED'; nextRepairLoops: number };

/**
 * Evaluate exactly one semantic repair decision. Provider/transport failures
 * never call this function and therefore cannot consume the semantic budget.
 */
export function evaluateRepairConvergence(
  previous: RepairObservation | null,
  current: RepairObservation,
  repairLoops: number,
  maxRepairLoops: number,
): RepairConvergenceDecision {
  if (!hasSemanticProgress(previous, current)) {
    return { outcome: 'SEMANTIC_NO_PROGRESS', nextRepairLoops: repairLoops };
  }
  const nextRepairLoops = repairLoops + 1;
  if (nextRepairLoops > maxRepairLoops) {
    return { outcome: 'MAX_REPAIR_LOOPS_EXCEEDED', nextRepairLoops };
  }
  return { outcome: 'CONTINUE', nextRepairLoops };
}
