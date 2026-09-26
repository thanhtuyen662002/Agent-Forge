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
