import crypto from 'crypto';
import { Repository } from '../database/repositories';
import { EventService } from './EventService';
import { ProviderRegistry } from '../adapters/ProviderRegistry';
import { RoleAwareRoutingService } from './RoleAwareRoutingService';
import { TaskService, captureAuthorizedTaskTransitionBinding } from './TaskService';
import { GitWorktreeService } from './GitWorktreeService';
import { ProjectStopFenceService } from './ProjectStopFenceService';
import { WorkerSlotLeaseService } from './WorkerSlotLeaseService';
import { EvidenceCollector } from '../autonomy/evidence';
import { parseReviewProtocol } from '../protocol/reviewProtocol';
import { createProductLeaseRecoveryMarkerEvent, createProductLeaseRecoveryResolvedEvent } from './ProductLeaseRecoveryScanner';
import type { WorkOrder } from '../autonomy/contracts';
import type { AgentExecutionResult, RuntimeExecutionBinding } from '../adapters/ProviderAdapter';
import type { AccountLease, ExecutionAuthorization, Task } from '../types/domain';
import type { ReviewProtocol } from '../types/protocols';
import type { TaskTrigger } from '../state/taskStateMachine';

/** Marks review attempts so restart recovery only touches automated reviews. */
export const REVIEW_ATTEMPT_MARKER = 'desktop-review';
export const REVIEW_STARTED_EVENT = 'AUTOMATION_REVIEW_STARTED';
export const REVIEW_PASSED_EVENT = 'AUTOMATION_REVIEW_PASSED';
export const REVIEW_FIX_REQUIRED_EVENT = 'AUTOMATION_REVIEW_FIX_REQUIRED';
export const REVIEW_BLOCKED_EVENT = 'AUTOMATION_REVIEW_BLOCKED';
export const REVIEW_FAILED_EVENT = 'AUTOMATION_REVIEW_FAILED';
export const REVIEW_STALE_EVENT = 'AUTOMATION_REVIEW_STALE';
export const REVIEW_INTERRUPTED_EVENT = 'AUTOMATION_REVIEW_INTERRUPTED';
/** Not started yet (no reviewer could be routed or leased); retried later and never consumes the work. */
export const REVIEW_NOT_RUN_EVENT = 'AUTOMATION_REVIEW_NOT_RUN';
export const REVIEW_VERDICT_EVENTS = [REVIEW_PASSED_EVENT, REVIEW_FIX_REQUIRED_EVENT, REVIEW_BLOCKED_EVENT];
export const REVIEW_TERMINAL_EVENTS = [...REVIEW_VERDICT_EVENTS, REVIEW_FAILED_EVENT, REVIEW_STALE_EVENT, REVIEW_INTERRUPTED_EVENT];
/** Separation policy every automated review is routed under: never the coder's account. */
export const AUTOMATED_REVIEW_SEPARATION_POLICY_ID = 'sep-automated-review';

const VERIFICATION_PASSED_EVENT = 'AUTOMATION_VERIFICATION_PASSED';
/** Diffs above this are not sent to a reviewer; the review fails closed instead. */
const MAX_REVIEW_DIFF_BYTES = 256 * 1024;
/** A review that could not start is offered again after this delay. */
const REVIEW_RETRY_AFTER_MS = 5 * 60_000;

export interface ReviewerCandidate {
  agentId: string;
  agentProfileId: string;
  roleProfileId: string;
  accountId: string;
  resourceId: string;
}

export type ProductReviewOutcome =
  | { outcome: 'PASSED' | 'FIX_REQUIRED' | 'BLOCKED'; reviewId: string }
  | { outcome: 'FAILED' | 'STALE'; reasonCode: string }
  | { outcome: 'NOT_RUN'; reasonCode: string };

export interface ProductReviewOptions {
  now?: () => Date;
  leaseTtlMs?: number;
  heartbeatMs?: number;
  evidence?: Pick<EvidenceCollector, 'collect'>;
}

interface VerifiedWork {
  verificationEventId: string;
  coderAuth: ExecutionAuthorization;
  worktree: string;
  headSha: string;
  snapshotSha: string;
}

/**
 * Account-bound automated review of verified coder work (#233). A REVIEWER
 * agent is routed through role-aware routing to its own account (never the
 * coder's), holds a WorkerSlotLeaseService lease and runs its CLI on a
 * read-only isolated copy of the verified worktree. Only a well-formed
 * review.v1 verdict for the exact verified (headSha, snapshotSha) and task
 * revision is applied, through TaskService.transitionAuthorizedTask. Provider
 * failures, malformed or stale verdicts are recorded and never become PASS.
 * Nothing is merged; there is no automatic retry.
 */
export class ProductReviewService {
  private readonly now: () => Date;
  private readonly leaseTtlMs: number;
  private readonly heartbeatMs: number;
  private readonly evidence: Pick<EvidenceCollector, 'collect'>;
  /** Review attempts running in this process; recovery never touches them. */
  private readonly ownedAttempts = new Set<string>();
  /** Verification events whose review could not start, and when to offer them again. */
  private readonly retryAfter = new Map<string, number>();

  constructor(
    private readonly repo: Repository,
    private readonly events: EventService,
    private readonly registry: ProviderRegistry,
    private readonly tasks: TaskService,
    options: ProductReviewOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.leaseTtlMs = options.leaseTtlMs ?? 300_000;
    this.heartbeatMs = Math.max(1_000, options.heartbeatMs ?? 60_000);
    this.evidence = options.evidence ?? new EvidenceCollector();
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private reviewEvents(projectId: string) {
    return this.repo.getEventsByProject(projectId).filter((event) =>
      event.type === REVIEW_STARTED_EVENT || REVIEW_TERMINAL_EVENTS.includes(event.type));
  }

  /** The verified work a review of this task would be bound to, or null. */
  public verifiedWork(task: Task): VerifiedWork | null {
    if (task.state !== 'REVIEW_READY' || this.repo.isTaskTrashed(task.id)) return null;
    const passed = this.repo.getEventsByProject(task.project_id)
      .filter((event) => event.type === VERIFICATION_PASSED_EVENT && event.task_id === task.id)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    for (const event of passed) {
      const payload = (event.structured_payload ?? {}) as Record<string, unknown>;
      const coderAuth = typeof payload.authorizationId === 'string' ? this.repo.getExecutionAuthorization(payload.authorizationId) : null;
      if (!coderAuth || coderAuth.task_revision !== task.revision_count || !coderAuth.assignment_id) continue;
      if (typeof payload.worktree !== 'string' || typeof payload.headSha !== 'string' || typeof payload.snapshotSha !== 'string') continue;
      return { verificationEventId: event.id, coderAuth, worktree: payload.worktree, headSha: payload.headSha, snapshotSha: payload.snapshotSha };
    }
    return null;
  }

  /**
   * Verified, REVIEW_READY work at the current revision that no review has
   * started (or conclusively ended) for. `deferred` is true while a review
   * that could not start waits for its retry delay.
   */
  public pendingReview(projectId: string): { task: Task; work: VerifiedWork; deferred: boolean } | null {
    const started = new Set(this.reviewEvents(projectId)
      .filter((event) => event.type === REVIEW_STARTED_EVENT || event.type === REVIEW_STALE_EVENT || event.type === REVIEW_FAILED_EVENT)
      .map((event) => (event.structured_payload as { verificationEventId?: unknown } | null)?.verificationEventId));
    for (const task of this.repo.getTasksByProject(projectId)) {
      const work = this.verifiedWork(task);
      if (work && !started.has(work.verificationEventId)) {
        return { task, work, deferred: (this.retryAfter.get(work.verificationEventId) ?? 0) > this.now().getTime() };
      }
    }
    return null;
  }

  /** The coder account of verified work; a reviewer must use a different one. */
  public coderAccountOf(work: VerifiedWork): string | null {
    return this.repo.getAgentAssignment(work.coderAuth.assignment_id!)?.selected_account_id ?? null;
  }

  /** Latest automated-review result for a task, as a status reason code. */
  public reviewReason(task: Task): string | null {
    const latest = this.reviewEvents(task.project_id)
      .filter((event) => event.task_id === task.id && REVIEW_TERMINAL_EVENTS.includes(event.type))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
    if (!latest) return null;
    return latest.type.replace('AUTOMATION_', '');
  }

  public async review(work: VerifiedWork, taskId: string, reviewer: ReviewerCandidate, worktrees: GitWorktreeService): Promise<ProductReviewOutcome> {
    const auth = work.coderAuth;
    const record = (type: string, summary: string, payload: Record<string, unknown>) =>
      this.events.record(auth.project_id, type, summary, { verificationEventId: work.verificationEventId, coderAuthorizationId: auth.id, ...payload }, taskId);
    const terminal = (type: typeof REVIEW_FAILED_EVENT | typeof REVIEW_STALE_EVENT, reasonCode: string, extra: Record<string, unknown> = {}): ProductReviewOutcome => {
      record(type, `Automated review for task ${taskId} ended without a verdict: ${reasonCode}.`, { reasonCode, ...extra });
      return { outcome: type === REVIEW_STALE_EVENT ? 'STALE' : 'FAILED', reasonCode };
    };
    /** Could not start (transient): nothing ran, the work is not consumed, retry later. */
    const notStarted = (reasonCode: string): ProductReviewOutcome => {
      this.retryAfter.set(work.verificationEventId, this.now().getTime() + REVIEW_RETRY_AFTER_MS);
      const already = this.reviewEventsFor(auth.project_id, work.verificationEventId)
        .some((event) => event.type === REVIEW_NOT_RUN_EVENT && (event.structured_payload as { reasonCode?: unknown } | null)?.reasonCode === reasonCode);
      if (!already) record(REVIEW_NOT_RUN_EVENT, `Automated review for task ${taskId} could not start yet: ${reasonCode}.`, { reasonCode });
      return { outcome: 'NOT_RUN', reasonCode };
    };

    // 1. The task, project and verified work must still be exactly what was verified.
    const precheck = this.fenceReason(taskId, 'REVIEW_READY', auth);
    if (precheck) return { outcome: 'NOT_RUN', reasonCode: precheck };
    const coderAssignment = this.repo.getAgentAssignment(auth.assignment_id!);
    if (!coderAssignment?.selected_worker_slot_id) return terminal(REVIEW_STALE_EVENT, 'EXECUTION_SCOPE_INVALID');
    if (coderAssignment.selected_account_id === reviewer.accountId) return notStarted('REVIEWER_SAME_ACCOUNT');
    const inspected = await worktrees.inspectWorktree({
      projectId: auth.project_id, taskId: auth.task_id, attemptId: auth.attempt_id ?? null, assignmentId: coderAssignment.id,
      workerSlotId: coderAssignment.selected_worker_slot_id, baseSha: auth.repository_head_sha, ownershipEpoch: auth.task_ownership_epoch,
    });
    if (inspected.status !== 'INSPECTED') return notStarted('WORKTREE_INSPECTION_FAILED');
    if (!inspected.inspection.registered || !inspected.inspection.exists ||
        !inspected.inspection.sourceMatch || inspected.inspection.managedPath !== work.worktree) {
      return terminal(REVIEW_STALE_EVENT, 'WORKTREE_NOT_VERIFIABLE');
    }
    const before = await this.collect(work.worktree, auth.repository_head_sha);
    if (!before) return notStarted('EVIDENCE_UNAVAILABLE');
    if (before.headSha !== work.headSha.toLowerCase() || before.snapshotSha !== work.snapshotSha) {
      return terminal(REVIEW_STALE_EVENT, 'SNAPSHOT_CHANGED_SINCE_VERIFICATION');
    }
    const diff = before.diff.split('\nWorking file snapshots (includes untracked):\n')[0];
    if (Buffer.byteLength(diff, 'utf8') > MAX_REVIEW_DIFF_BYTES) return terminal(REVIEW_FAILED_EVENT, 'REVIEW_DIFF_TOO_LARGE');
    let contextFiles: string[];
    try {
      contextFiles = JSON.parse(auth.canonical_payload_json ?? '{}').contextFiles;
      if (!Array.isArray(contextFiles) || contextFiles.length === 0) throw new Error('missing');
    } catch { return terminal(REVIEW_STALE_EVENT, 'EXECUTION_SCOPE_INVALID'); }

    // 2. A RUNNING review attempt, routed to the reviewer's own account.
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const nextAttemptNumber = Math.max(0, ...this.repo.getTaskAttemptsByTask(taskId).map((a) => a.attempt_number)) + 1;
    this.repo.createTaskAttempt({
      id: attemptId, task_id: taskId, attempt_number: nextAttemptNumber, agent_id: reviewer.agentId,
      agent_profile_id: reviewer.agentProfileId, status: 'RUNNING', started_at: this.iso(), ended_at: null, summary: REVIEW_ATTEMPT_MARKER,
    });
    this.ownedAttempts.add(attemptId);
    let assignmentId: string | null = null;
    let lease: AccountLease | null = null;
    const leases = new WorkerSlotLeaseService(this.repo, { clock: this.now });
    const finish = (status: 'COMPLETED' | 'FAILED') => {
      if (lease) {
        const released = leases.release(lease.id, lease.lease_token);
        // A lease we could not release stays for recovery; so do the attempt and assignment.
        if (released.status !== 'RELEASED') { this.ownedAttempts.delete(attemptId); return; }
      }
      if (assignmentId) this.repo.endUnleasedAgentAssignment(assignmentId, status, this.iso());
      this.repo.endRunningTaskAttempt(attemptId, status, this.iso());
      this.ownedAttempts.delete(attemptId);
    };

    try {
      this.ensureSeparationPolicy();
      const routing = await new RoleAwareRoutingService(this.repo, this.registry, this.events).routeRole({
        projectId: auth.project_id, taskId, attemptId,
        roleProfileId: reviewer.roleProfileId, agentProfileId: reviewer.agentProfileId,
        separationPolicyId: AUTOMATED_REVIEW_SEPARATION_POLICY_ID, reviewedAssignmentId: coderAssignment.id,
        candidateRefs: [{ accountId: reviewer.accountId, resourceId: reviewer.resourceId }],
        excludedAccountIds: [coderAssignment.selected_account_id],
        persistAssignment: true, allowManualBridge: false,
      });
      assignmentId = routing.selectedAssignmentId ?? null;
      if (routing.outcome !== 'SELECTED' || !routing.selectedAssignmentId || !routing.decisionId) {
        finish('FAILED');
        return notStarted('ROUTING_NOT_SELECTED');
      }
      const acquired = leases.acquireForAssignment(routing.selectedAssignmentId, this.leaseTtlMs);
      if (acquired.status !== 'ACQUIRED') {
        finish('FAILED');
        return notStarted(acquired.code);
      }
      lease = acquired.lease;
      const assignment = acquired.assignment;
      const account = this.repo.getProviderAccount(assignment.selected_account_id);
      const resource = this.repo.getProviderResource(assignment.selected_resource_id);
      const adapter = this.registry.get(assignment.selected_provider_id);
      if (!account || !resource || !adapter || account.id === coderAssignment.selected_account_id) {
        finish('FAILED');
        return notStarted('REVIEWER_BINDING_INVALID');
      }

      // 3. Re-check every fence, then mark the task REVIEWING before the reviewer runs.
      const fenced = this.fenceReason(taskId, 'REVIEW_READY', auth);
      if (fenced || !this.transition(taskId, 'START_REVIEW')) {
        finish('FAILED');
        return notStarted(fenced ?? 'TASK_TRANSITION_REJECTED');
      }
      this.retryAfter.delete(work.verificationEventId);
      const executionId = crypto.randomUUID();
      record(REVIEW_STARTED_EVENT, `Automated review started for task ${taskId}.`, {
        attemptId, assignmentId, executionId, reviewerAgentId: reviewer.agentId, accountId: account.id,
        headSha: work.headSha, snapshotSha: work.snapshotSha, taskRevision: auth.task_revision,
      });

      // 4. The reviewer CLI on a read-only isolated copy of the verified worktree.
      const binding: RuntimeExecutionBinding = {
        authorizationId: `review:${attemptId}`, routingDecisionId: routing.decisionId, assignmentId: assignment.id,
        providerId: assignment.selected_provider_id, accountId: account.id, resourceId: resource.id,
        adapterType: adapter.adapterType, modelName: resource.model_name, accountAuthMode: account.auth_mode,
        profileRef: account.profile_ref ?? null, executionId,
        workspace: { workerSlotId: acquired.slot.id, ownershipDigest: inspected.inspection.ownershipDigest,
          sourceSha: auth.repository_head_sha, workingDirectory: work.worktree },
      };
      let leaseLost = false;
      const heartbeat = setInterval(() => {
        let keep = false;
        try {
          const beat = leases.heartbeat(lease!.id, lease!.lease_token, this.leaseTtlMs);
          keep = beat.status === 'HEARTBEAT_ACKNOWLEDGED' && !this.fenceReason(taskId, 'REVIEWING', auth);
        } catch {
          keep = false; // An unprovable lease is a lost lease.
        }
        if (!keep && !leaseLost) {
          leaseLost = true;
          void adapter.cancel(executionId).catch(() => undefined);
        }
      }, this.heartbeatMs);
      heartbeat.unref?.();
      let result: AgentExecutionResult;
      try {
        result = await adapter.execute({
          projectId: auth.project_id, taskId, attemptId, contextFiles, runtimeBinding: binding, expectedProtocol: 'review.v1',
          instructions: this.instructions(taskId, auth, work, before.changedFiles, diff),
        });
      } catch {
        result = { executionId, status: 'FAILED', errorCode: 'EXECUTION_FAILED' };
      } finally {
        clearInterval(heartbeat);
      }

      // 5. Only a fresh, well-formed verdict for exactly this work is applied.
      const after = await this.collect(work.worktree, auth.repository_head_sha);
      const unchanged = !!after && after.headSha === before.headSha && after.snapshotSha === before.snapshotSha;
      let failure: { type: typeof REVIEW_FAILED_EVENT | typeof REVIEW_STALE_EVENT; reason: string } | null = null;
      let verdict: ReviewProtocol | null = null;
      if (leaseLost) failure = { type: REVIEW_FAILED_EVENT, reason: 'REVIEW_LEASE_OR_FENCE_LOST' };
      else if (result.status !== 'COMPLETED') failure = { type: REVIEW_FAILED_EVENT, reason: result.errorCode ? String(result.errorCode) : 'PROVIDER_EXECUTION_FAILED' };
      else if (!unchanged) failure = { type: REVIEW_STALE_EVENT, reason: 'WORKTREE_CHANGED_DURING_REVIEW' };
      else {
        const parsed = parseReviewProtocol(result.outputProtocol);
        if (!parsed.success) failure = { type: REVIEW_FAILED_EVENT, reason: parsed.reasonCode };
        else if (parsed.data.task_id !== taskId || parsed.data.project_id !== auth.project_id || parsed.data.task_revision !== auth.task_revision) {
          failure = { type: REVIEW_STALE_EVENT, reason: 'VERDICT_FOR_OTHER_TASK_OR_REVISION' };
        } else if (parsed.data.reviewed_head_sha.toLowerCase() !== work.headSha.toLowerCase() || parsed.data.reviewed_snapshot_sha.toLowerCase() !== work.snapshotSha) {
          failure = { type: REVIEW_STALE_EVENT, reason: 'VERDICT_FOR_STALE_SNAPSHOT' };
        } else verdict = parsed.data;
      }
      if (!verdict) {
        finish('FAILED');
        return terminal(failure!.type, failure!.reason, { attemptId, executionId });
      }

      const type = verdict.verdict === 'PASS' ? REVIEW_PASSED_EVENT : verdict.verdict === 'FIX_REQUIRED' ? REVIEW_FIX_REQUIRED_EVENT : REVIEW_BLOCKED_EVENT;
      const applied = this.applyVerdict(taskId, auth, attemptId, reviewer.agentId, verdict, lease, (reviewId) =>
        record(type, `Automated review of task ${taskId}: ${verdict.verdict}.`, {
          attemptId, executionId, reviewId, verdict: verdict.verdict, issueCount: verdict.issues.length,
          headSha: work.headSha, snapshotSha: work.snapshotSha,
        }));
      if (!applied.success) {
        finish('FAILED');
        return terminal(REVIEW_FAILED_EVENT, applied.reasonCode, { attemptId, executionId });
      }
      finish('COMPLETED');
      return { outcome: verdict.verdict === 'PASS' ? 'PASSED' : verdict.verdict, reviewId: applied.reviewId };
    } catch {
      finish('FAILED');
      return terminal(REVIEW_FAILED_EVENT, 'REVIEW_INTERNAL_ERROR', { attemptId });
    }
  }

  /**
   * Restart recovery for review attempts this process does not own. A review
   * whose process may still run stays fenced; otherwise its expired lease is
   * released through the guarded recovery primitive and the attempt ends
   * INTERRUPTED. No verdict is ever inferred and nothing is retried.
   */
  /**
   * A BLOCKED verdict recorded before #308 left its task in REVIEWING, with nothing
   * to pick it up (found in VidFlow M1). Such a task now goes back to the coder,
   * like a new BLOCKED verdict; the revision bound still ends in NEEDS_HUMAN (#310).
   */
  public releaseStaleBlockedReviews(): number {
    let released = 0;
    for (const project of this.repo.getAllProjects()) {
      if (project.status !== 'RUNNING' || this.repo.isProjectTrashed(project.id)) continue;
      for (const task of this.repo.getTasksByProject(project.id)) {
        if (task.state !== 'REVIEWING' || this.repo.isTaskTrashed(task.id) || this.reviewReason(task) !== 'REVIEW_BLOCKED') continue;
        if (this.transition(task.id, task.revision_count >= task.max_revisions ? 'MAX_REVISIONS_EXCEEDED' : 'FIX_VERDICT')) released += 1;
      }
    }
    return released;
  }

  public recoverAbandonedReviews(): number {
    let recovered = 0;
    for (const project of this.repo.getAllProjects()) {
      const reviewEvents = this.reviewEvents(project.id);
      for (const task of this.repo.getTasksByProject(project.id)) {
        for (const attempt of this.repo.getTaskAttemptsByTask(task.id)) {
          if (attempt.status !== 'RUNNING' || attempt.summary !== REVIEW_ATTEMPT_MARKER || this.ownedAttempts.has(attempt.id)) continue;
          const forAttempt = reviewEvents.filter((event) => (event.structured_payload as { attemptId?: unknown } | null)?.attemptId === attempt.id);
          const started = forAttempt.find((event) => event.type === REVIEW_STARTED_EVENT);
          // Only an applied verdict completes a review; failures and interruptions do not.
          const completed = forAttempt.some((event) => REVIEW_VERDICT_EVENTS.includes(event.type)) ||
            this.repo.getReviewsByTask(task.id).some((review) => review.attempt_id === attempt.id);
          const finished = completed || forAttempt.some((event) => event.type === REVIEW_FAILED_EVENT || event.type === REVIEW_STALE_EVENT);
          const executionId = (started?.structured_payload as { executionId?: unknown } | null)?.executionId;
          if (typeof executionId === 'string' && this.repo.getProcessRun(executionId)?.status === 'RUNNING') {
            if (!forAttempt.some((event) => event.type === REVIEW_INTERRUPTED_EVENT)) {
              this.events.record(project.id, REVIEW_INTERRUPTED_EVENT, `Automated review for task ${task.id} was interrupted; its process is not proven stopped.`,
                { ...(started?.structured_payload as object), attemptId: attempt.id, reasonCode: 'PROCESS_NOT_PROVEN_STOPPED' }, task.id);
            }
            continue;
          }
          const assignment = this.repo.getAgentAssignmentsByTask(task.id).find((candidate) => candidate.attempt_id === attempt.id) ?? null;
          const lease = assignment ? this.repo.getActiveLeaseForAssignment(assignment.id) : null;
          if (lease && assignment && !this.releaseExpiredLease(lease, assignment.id, task)) continue; // Not expired yet, or fenced.
          if (assignment) this.repo.endUnleasedAgentAssignment(assignment.id, completed ? 'COMPLETED' : 'FAILED', this.iso());
          this.repo.endRunningTaskAttempt(attempt.id, completed ? 'COMPLETED' : 'FAILED', this.iso());
          if (!finished) {
            this.events.record(project.id, REVIEW_INTERRUPTED_EVENT, `Automated review for task ${task.id} was interrupted by a restart; no verdict was applied.`,
              { ...(started?.structured_payload as object), attemptId: attempt.id, reasonCode: 'REVIEW_INTERRUPTED' }, task.id);
          }
          recovered += 1;
        }
      }
    }
    return recovered;
  }

  /**
   * Releases an expired review lease through the guarded recovery primitive
   * and, in the same transaction, closes the startup quarantine marker that
   * ProductLeaseRecoveryScanner may have written for it.
   */
  private releaseExpiredLease(lease: AccountLease, assignmentId: string, task: Task): boolean {
    try {
      return this.repo.runInImmediateTransaction(() => {
        const released = new WorkerSlotLeaseService(this.repo, { clock: this.now })
          .recoverExpiredLease(lease.id, lease.lease_token, this.now(), { expectedTaskStates: [task.state] });
        if (released.status !== 'RELEASED') return false;
        const binding = {
          leaseId: lease.id, assignmentId, taskId: task.id, projectId: task.project_id,
          accountId: lease.provider_account_id, workerSlotId: lease.worker_slot_id, leaseToken: lease.lease_token,
        };
        const markerId = createProductLeaseRecoveryMarkerEvent({ ...binding, reasonCode: 'RECOVERY_REQUIRED', reason: 'Product lease cleanup recovery marker.', observedAt: lease.expires_at }).id;
        if (this.repo.getEvent(markerId)) {
          this.repo.createDeterministicGenericEvent(createProductLeaseRecoveryResolvedEvent({ ...binding, markerEventId: markerId, observedAt: this.iso() }));
        }
        return true;
      });
    } catch {
      return false; // A later pass retries.
    }
  }

  private reviewEventsFor(projectId: string, verificationEventId: string) {
    return this.repo.getEventsByProject(projectId).filter((event) =>
      (event.structured_payload as { verificationEventId?: unknown } | null)?.verificationEventId === verificationEventId);
  }

  /** Why the review must not proceed for this task state, or null. */
  private fenceReason(taskId: string, expectedState: 'REVIEW_READY' | 'REVIEWING', auth: ExecutionAuthorization): string | null {
    const project = this.repo.getProjectMetadata(auth.project_id);
    const task = this.repo.getTask(taskId);
    if (!project || !task) return 'PROJECT_OR_TASK_MISSING';
    if (project.status !== 'RUNNING' || this.repo.isProjectTrashed(project.id) || this.repo.isTaskTrashed(task.id)) return 'PROJECT_NOT_RUNNING';
    try { new ProjectStopFenceService(this.repo).assertProjectRunningAllowed(project.id); } catch { return 'PROJECT_STOPPED'; }
    if (task.state !== expectedState || task.revision_count !== auth.task_revision || (task.ownership_epoch ?? 1) !== auth.task_ownership_epoch) {
      return 'TASK_MOVED_ON';
    }
    return null;
  }

  /** Records the review and moves the task in one transaction; a rejected transition writes nothing. */
  private applyVerdict(taskId: string, auth: ExecutionAuthorization, attemptId: string, reviewerAgentId: string, verdict: ReviewProtocol,
    lease: AccountLease, recordOutcome: (reviewId: string) => void): { success: true; reviewId: string } | { success: false; reasonCode: string } {
    const fenced = this.fenceReason(taskId, 'REVIEWING', auth);
    if (fenced) return { success: false, reasonCode: fenced };
    const reviewId = `review-${crypto.randomUUID()}`;
    try {
      this.repo.runInImmediateTransaction(() => {
        // Only the review that still owns its lease and attempt may decide: a late
        // result after restart recovery released them is discarded.
        const current = this.repo.getAccountLease(lease.id);
        if (!current || current.released_at || current.lease_token !== lease.lease_token ||
            Date.parse(current.expires_at) <= this.now().getTime() || this.repo.getTaskAttempt(attemptId)?.status !== 'RUNNING') {
          throw new Error('REVIEW_LEASE_LOST');
        }
        this.repo.createReview({
          id: reviewId, task_id: taskId, attempt_id: attemptId, reviewer_agent_id: reviewerAgentId,
          verdict: verdict.verdict, summary: verdict.summary, created_at: this.iso(),
          issues: verdict.issues.map((issue) => ({
            id: `review-issue-${crypto.randomUUID()}`, review_id: reviewId, severity: issue.severity, title: issue.title,
            file_path: issue.file_path ?? null, line_number: issue.line_number ?? null, description: issue.description, resolved: false,
          })),
        });
        const task = this.repo.getTask(taskId)!;
        // BLOCKED (the reviewer could not judge, e.g. nothing was changed) goes back to
        // the coder with the reviewer's notes, like FIX_REQUIRED: left in REVIEWING it
        // stalled the project (#308). The revision bound still ends in NEEDS_HUMAN.
        const trigger: TaskTrigger = verdict.verdict === 'PASS' ? 'PASS_VERDICT'
          : task.revision_count >= task.max_revisions ? 'MAX_REVISIONS_EXCEEDED' : 'FIX_VERDICT';
        if (!this.transition(taskId, trigger)) throw new Error('TASK_TRANSITION_REJECTED');
        // Review row, task transition and outcome event commit together or not at all.
        recordOutcome(reviewId);
      });
      return { success: true, reviewId };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      return { success: false, reasonCode: code === 'TASK_TRANSITION_REJECTED' || code === 'REVIEW_LEASE_LOST' ? code : 'REVIEW_PERSIST_FAILED' };
    }
  }

  private transition(taskId: string, trigger: TaskTrigger): boolean {
    const current = this.repo.getTask(taskId);
    if (!current || this.repo.isTaskTrashed(taskId)) return false;
    return this.tasks.transitionAuthorizedTask(taskId, trigger, captureAuthorizedTaskTransitionBinding(current)).success;
  }

  private ensureSeparationPolicy(): void {
    if (this.repo.getSeparationPolicy(AUTOMATED_REVIEW_SEPARATION_POLICY_ID)) return;
    const now = this.iso();
    try {
      this.repo.createSeparationPolicy({
        id: AUTOMATED_REVIEW_SEPARATION_POLICY_ID, name: 'Automated review: different account', same_execution_forbidden: true,
        same_session_forbidden: true, same_account_policy: 'REQUIRE_DIFFERENT', same_provider_policy: 'ALLOW', same_model_policy: 'ALLOW',
        risk_threshold: 'LOW', applicability: null, enabled: true, created_at: now, updated_at: now,
      });
    } catch {
      // A concurrent creator won; routing reads the stored policy.
    }
  }

  private async collect(worktree: string, baseSha: string) {
    try {
      const collected = await this.evidence.collect({ worktree, base_sha: baseSha } as WorkOrder);
      return collected.snapshotSha ? collected : null;
    } catch {
      return null;
    }
  }

  private instructions(taskId: string, auth: ExecutionAuthorization, work: VerifiedWork, changedFiles: string[], diff: string): string[] {
    const task = this.repo.getTask(taskId)!;
    return [
      `Review the coder's changes for task "${task.title}" against its acceptance criteria. The approved tests already passed.`,
      ...task.acceptance_criteria.map((criterion) => `Acceptance criterion: ${criterion}`),
      'You are a read-only reviewer: do not modify, create or delete any file.',
      `Use exactly: project_id "${auth.project_id}", task_id "${taskId}", task_revision ${auth.task_revision}, reviewed_head_sha "${work.headSha}", reviewed_snapshot_sha "${work.snapshotSha}".`,
      'Verdict PASS only if every criterion is met; FIX_REQUIRED with concrete issues otherwise; BLOCKED if the task cannot be judged.',
      `Changed files: ${changedFiles.join(', ') || '(none)'}`,
      `Diff against the base:\n${diff}`,
    ];
  }
}
