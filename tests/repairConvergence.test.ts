import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ManagerReview, createWorkOrder } from '../src/core/autonomy/contracts';
import { AutonomyStore } from '../src/core/autonomy/store';
import {
  evaluateRepairConvergence,
  hasSemanticProgress,
  recoverRepairConvergence,
  stableFindingSignature,
} from '../src/core/autonomy/repairConvergence';

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

  it('enforces the semantic repair limit without counting no-progress or provider retries', () => {
    const signature = stableFindingSignature(review, false, true);
    const previous = { signature, snapshotSha: 'snapshot-a' };

    expect(evaluateRepairConvergence(previous, previous, 2, 3)).toEqual({
      outcome: 'SEMANTIC_NO_PROGRESS',
      nextRepairLoops: 2,
    });
    expect(evaluateRepairConvergence(previous, { signature, snapshotSha: 'snapshot-b' }, 2, 3)).toEqual({
      outcome: 'CONTINUE',
      nextRepairLoops: 3,
    });
    expect(evaluateRepairConvergence(previous, { signature, snapshotSha: 'snapshot-c' }, 3, 3)).toEqual({
      outcome: 'MAX_REPAIR_LOOPS_EXCEEDED',
      nextRepairLoops: 4,
    });
  });

  it('recovers durable semantic repair history after SQLite restart and preserves no-progress fencing', () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'af-repair-restart-'));
    const worktree = path.join(runtimeRoot, 'worktree');
    fs.mkdirSync(worktree, { recursive: true });
    const taskId = 'repair-restart-task';
    const branch = 'agent/repair-restart';
    const baseSha = 'a'.repeat(40);
    const signature = stableFindingSignature(review, false, true);

    try {
      const first = AutonomyStore.open(runtimeRoot);
      const order = createWorkOrder({
        taskId,
        workerId: 'agy-01',
        objective: 'prove durable repair recovery',
        baseSha,
        branch,
        worktree,
        allowedPaths: ['src'],
        requiredTests: ['test'],
        acceptanceCriteria: ['repair converges'],
      });
      const row = first.store.createWorkOrder(order);
      first.store.event(row.id, 'REPAIR_REQUIRED', {
        review,
        verified: false,
        fresh: true,
        signature,
        snapshotSha: 'snapshot-a',
      });
      first.store.updateState(row.id, 'FAILED', order.lease_epoch);
      first.engine.close();

      const reopened = AutonomyStore.open(runtimeRoot);
      const history = reopened.store.getDatabase().prepare(`
        SELECT e.payload_json FROM autonomy_events e
        JOIN autonomy_work_orders w ON w.id=e.work_order_id
        WHERE w.task_id=? AND w.branch=? AND w.base_sha=? AND e.event_type='REPAIR_REQUIRED'
        ORDER BY w.attempt, e.created_at
      `).all(taskId, branch, baseSha) as Array<{ payload_json: string }>;

      const recovered = recoverRepairConvergence(history.map((entry) => entry.payload_json));
      expect(recovered).toEqual({
        repairLoops: 1,
        previousRepair: { signature, snapshotSha: 'snapshot-a' },
      });
      expect(evaluateRepairConvergence(
        recovered.previousRepair,
        { signature, snapshotSha: 'snapshot-a' },
        recovered.repairLoops,
        3,
      )).toEqual({
        outcome: 'SEMANTIC_NO_PROGRESS',
        nextRepairLoops: 1,
      });
      reopened.engine.close();
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('fails closed instead of resetting a malformed durable repair history', () => {
    expect(() => recoverRepairConvergence(['{not-json'])).toThrow();
  });

});
