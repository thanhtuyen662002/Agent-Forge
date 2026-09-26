import { EvidenceCollector } from './evidence';
import { ManagerContextPackageSchema, ManagerProviderPool } from './managerPool';
import { AutonomyReviewCapacityWait, AutonomyStore } from './store';
import { ManagerReview } from './contracts';

export type ReviewCapacityStatus = 'WAITING_CAPACITY' | 'PASS' | 'REPAIR' | 'BLOCKED';

export interface ReviewCapacityObservation {
  wait: AutonomyReviewCapacityWait;
  status: ReviewCapacityStatus;
  review?: ManagerReview;
  selectedResource?: string;
  error?: string;
}

export interface ReviewCapacityWatcherOptions {
  store: AutonomyStore;
  managerPool: ManagerProviderPool;
  evidence?: Pick<EvidenceCollector, 'collect'>;
  now?: () => Date;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

function sameStrings(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export class ReviewCapacityWatcher {
  private readonly store: AutonomyStore;
  private readonly managerPool: ManagerProviderPool;
  private readonly evidence: Pick<EvidenceCollector, 'collect'>;
  private readonly now: () => Date;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(options: ReviewCapacityWatcherOptions) {
    this.store = options.store;
    this.managerPool = options.managerPool;
    this.evidence = options.evidence ?? new EvidenceCollector();
    this.now = options.now ?? (() => new Date());
    this.baseBackoffMs = options.baseBackoffMs ?? 60_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 15 * 60_000;
  }

  register(contextSha: string, expectedHeadSha: string, nextAttemptAt?: string): AutonomyReviewCapacityWait {
    const contextJson = this.store.getManagerContext(contextSha);
    if (!contextJson) throw new Error('MANAGER_CONTEXT_NOT_FOUND');
    const context = ManagerContextPackageSchema.parse(JSON.parse(contextJson));
    if (context.current_head.toLowerCase() !== expectedHeadSha.toLowerCase()) {
      throw new Error('STALE_MANAGER_CONTEXT_HEAD');
    }
    return this.store.registerReviewCapacityWait({
      taskId: context.work_order.task_id,
      contextSha,
      expectedHeadSha,
      nextAttemptAt,
    });
  }

  async observeDue(): Promise<ReviewCapacityObservation[]> {
    const now = this.now();
    const waits = this.store.listDueReviewCapacityWaits(now.toISOString());
    const observations: ReviewCapacityObservation[] = [];
    for (const wait of waits) {
      observations.push(await this.observe(wait, now));
    }
    return observations;
  }

  private async observe(wait: AutonomyReviewCapacityWait, now: Date): Promise<ReviewCapacityObservation> {
    const contextJson = this.store.getManagerContext(wait.context_sha);
    if (!contextJson) {
      return this.block(wait, now, 'MANAGER_CONTEXT_NOT_FOUND');
    }

    let context;
    try {
      context = ManagerContextPackageSchema.parse(JSON.parse(contextJson));
    } catch (error) {
      return this.block(wait, now, `MANAGER_CONTEXT_INVALID: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (context.current_head.toLowerCase() !== wait.expected_head_sha.toLowerCase()) {
      return this.block(wait, now, 'STALE_MANAGER_CONTEXT_HEAD');
    }

    try {
      const fresh = await this.evidence.collect(context.work_order, []);
      if (fresh.headSha.toLowerCase() !== wait.expected_head_sha.toLowerCase()) {
        return this.block(wait, now, `REVIEW_WAIT_HEAD_MISMATCH: expected ${wait.expected_head_sha}, observed ${fresh.headSha}`);
      }
      if (fresh.diff !== context.actual_diff || !sameStrings(fresh.changedFiles, context.changed_files)) {
        return this.block(wait, now, 'REVIEW_WAIT_SNAPSHOT_MISMATCH');
      }
    } catch (error) {
      return this.block(wait, now, `REVIEW_WAIT_EVIDENCE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }

    const result = await this.managerPool.reviewStored(
      wait.context_sha,
      wait.expected_head_sha,
      { probeUnavailable: true },
    );
    const attemptCount = wait.attempt_count + 1;

    if (!result.review) {
      const delay = Math.min(this.maxBackoffMs, this.baseBackoffMs * (2 ** Math.min(wait.attempt_count, 4)));
      const nextAttemptAt = new Date(now.getTime() + delay).toISOString();
      const error = result.run.stderr || result.run.error || result.run.status;
      this.store.updateReviewCapacityWait(wait.id, {
        state: 'WAITING',
        attempt_count: attemptCount,
        next_attempt_at: nextAttemptAt,
        last_attempt_at: now.toISOString(),
        last_error: error,
        selected_resource: result.resource_id === 'none' ? null : result.resource_id,
        verdict: null,
      });
      this.store.event(wait.task_id, 'REVIEW_CAPACITY_DEFERRED', {
        context_sha: wait.context_sha,
        expected_head_sha: wait.expected_head_sha,
        attempts: result.attempts,
        attempt_count: attemptCount,
        next_attempt_at: nextAttemptAt,
        error,
      });
      const updated = this.store.listReviewCapacityWaits().find((row) => row.id === wait.id) ?? wait;
      return {
        wait: updated,
        status: 'WAITING_CAPACITY',
        selectedResource: result.resource_id === 'none' ? undefined : result.resource_id,
        error,
      };
    }

    this.store.updateReviewCapacityWait(wait.id, {
      state: result.review.verdict,
      attempt_count: attemptCount,
      next_attempt_at: now.toISOString(),
      last_attempt_at: now.toISOString(),
      last_error: null,
      selected_resource: result.resource_id,
      verdict: result.review.verdict,
    });

    const legacyOrder = this.store.findLatestWorkOrderByTask(wait.task_id);
    if (legacyOrder) {
      this.store.recordReview(legacyOrder.id, result.review);
    } else {
      this.store.event(wait.task_id, 'MANAGER_REVIEWED', result.review);
    }
    this.store.event(wait.task_id, 'REVIEW_CAPACITY_RESUMED', {
      context_sha: wait.context_sha,
      expected_head_sha: wait.expected_head_sha,
      selected_resource: result.resource_id,
      attempts: result.attempts,
      verdict: result.review.verdict,
    });

    const updated = this.store.listReviewCapacityWaits().find((row) => row.id === wait.id) ?? wait;
    return {
      wait: updated,
      status: result.review.verdict,
      review: result.review,
      selectedResource: result.resource_id,
    };
  }

  private block(wait: AutonomyReviewCapacityWait, now: Date, error: string): ReviewCapacityObservation {
    this.store.updateReviewCapacityWait(wait.id, {
      state: 'BLOCKED',
      attempt_count: wait.attempt_count + 1,
      next_attempt_at: now.toISOString(),
      last_attempt_at: now.toISOString(),
      last_error: error,
      verdict: 'BLOCKED',
    });
    this.store.event(wait.task_id, 'REVIEW_CAPACITY_BLOCKED', {
      context_sha: wait.context_sha,
      expected_head_sha: wait.expected_head_sha,
      error,
    });
    const updated = this.store.listReviewCapacityWaits().find((row) => row.id === wait.id) ?? wait;
    return { wait: updated, status: 'BLOCKED', error };
  }
}
