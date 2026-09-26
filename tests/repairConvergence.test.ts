import { describe, expect, it } from 'vitest';
import { ManagerReview } from '../src/core/autonomy/contracts';
import { hasSemanticProgress, stableFindingSignature } from '../src/core/autonomy/repairConvergence';

const review: ManagerReview = {
  protocol_version: 'managerreview.v1', verdict: 'REPAIR', reviewed_head_sha: 'a'.repeat(40),
  findings: [{ severity: 'HIGH', title: 'Missing verification', description: 'issue 1', file_path: 'src/example.ts', line_number: 10 }],
  required_actions: ['Run tests'], risk: 'HIGH', notes: '',
};

describe('repair convergence', () => {
  it('keeps finding identity stable across generated descriptions, line movement, and ordering', () => {
    const changed = { ...review, findings: [
      { ...review.findings[0], description: 'issue 2', line_number: 99, title: ' Missing  verification ' },
    ] };
    expect(stableFindingSignature(changed, false, true)).toBe(stableFindingSignature(review, false, true));
    expect(stableFindingSignature(changed, true, true)).not.toBe(stableFindingSignature(review, false, true));
  });

  it('stops repeated findings on an identical snapshot, but permits an actual change', () => {
    const signature = stableFindingSignature(review, false, true);
    const previous = { signature, snapshotSha: 'snapshot-a' };
    expect(hasSemanticProgress(previous, { signature, snapshotSha: 'snapshot-a' })).toBe(false);
    expect(hasSemanticProgress(previous, { signature, snapshotSha: 'snapshot-b' })).toBe(true);
    expect(hasSemanticProgress(null, previous)).toBe(true);
  });
});
