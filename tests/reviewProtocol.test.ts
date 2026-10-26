import { describe, expect, it } from 'vitest';
import { parseReviewProtocol } from '../src/core/protocol/reviewProtocol';
import { ProtocolParser } from '../src/core/protocol/parser';
import { LocalCliAdapterBase } from '../src/core/adapters/LocalCliAdapterBase';

class CodingOnlyAdapter extends LocalCliAdapterBase {
  public readonly id = 'coding-only';
  public readonly name = 'Coding only';
  protected getDefaultExecutable(): string { return 'not-installed'; }
  public async getCapabilities() { return ['CODING' as const]; }
}

const verdict = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  protocol: 'review.v1', message_id: 'review-1', project_id: 'project-1', task_id: 'task-1', task_revision: 2,
  verdict: 'FIX_REQUIRED', summary: 'One issue', issues: [{ severity: 'REQUIRED', title: 'Missing test', description: 'Add a test.' }],
  reviewed_head_sha: 'a'.repeat(40), reviewed_snapshot_sha: 'b'.repeat(64), ...overrides,
});

describe('review.v1 verdict protocol (#233)', () => {
  it('accepts a complete verdict, also inside prose or a code fence', () => {
    expect(parseReviewProtocol(verdict())).toMatchObject({ success: true, data: { verdict: 'FIX_REQUIRED', task_revision: 2 } });
    expect(parseReviewProtocol(`Here you go:\n\`\`\`json\n${verdict({ verdict: 'PASS', issues: [] })}\n\`\`\``))
      .toMatchObject({ success: true, data: { verdict: 'PASS' } });
  });

  it.each([
    ['missing output', '', 'REVIEW_OUTPUT_MISSING'],
    ['prose without JSON', 'Looks good to me!', 'REVIEW_OUTPUT_MISSING'],
    ['a coder.v1 payload', JSON.stringify({ protocol: 'coder.v1', status: 'COMPLETED' }), 'REVIEW_PROTOCOL_INVALID'],
    ['an unknown verdict', verdict({ verdict: 'APPROVE' }), 'REVIEW_PROTOCOL_INVALID'],
    ['a short head SHA', verdict({ reviewed_head_sha: 'abc' }), 'REVIEW_PROTOCOL_INVALID'],
    ['a missing snapshot', verdict({ reviewed_snapshot_sha: undefined }), 'REVIEW_PROTOCOL_INVALID'],
    ['a missing revision', verdict({ task_revision: undefined }), 'REVIEW_PROTOCOL_INVALID'],
    ['PASS with a BLOCKER issue', verdict({ verdict: 'PASS', issues: [{ severity: 'BLOCKER', title: 'Broken', description: 'It fails.' }] }), 'REVIEW_PROTOCOL_INVALID'],
    ['FIX_REQUIRED without issues', verdict({ issues: [] }), 'REVIEW_PROTOCOL_INVALID'],
  ])('rejects %s', (_name, raw, reasonCode) => {
    expect(parseReviewProtocol(raw)).toEqual({ success: false, reasonCode });
  });

  it('ignores an extra field instead of rejecting the verdict, and never exposes it', () => {
    const parsed = parseReviewProtocol(verdict({ merge: true, verification: 'npm test passed', task_revision: '2' }));
    expect(parsed).toMatchObject({ success: true, data: { verdict: 'FIX_REQUIRED', task_revision: 2 } });
    expect(parsed.success && 'merge' in parsed.data).toBe(false);
  });

  it('is never accepted by the manual protocol inbox parser', () => {
    expect(ProtocolParser.parse(verdict()).success).toBe(false);
  });

  it('is refused by a CLI adapter without REVIEW capability before anything runs', async () => {
    const adapter = new CodingOnlyAdapter({ executable: 'not-installed' });
    const result = await adapter.execute({
      taskId: 'task-1', projectId: 'project-1', instructions: [], contextFiles: [], expectedProtocol: 'review.v1',
    });
    expect(result).toMatchObject({ status: 'FAILED', errorCode: 'UNSUPPORTED_CLIENT' });
  });

  it('keeps plan.v1 out of the manual protocol inbox too (#245)', () => {
    const plan = JSON.stringify({ protocol: 'plan.v1', message_id: 'p', project_id: 'project-1', contract_sha256: 'a'.repeat(64),
      tasks: [{ title: 'One', acceptance_criteria: ['done'] }] });
    expect(ProtocolParser.parse(plan).success).toBe(false);
  });
});
