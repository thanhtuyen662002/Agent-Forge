import crypto from 'crypto';
import { Repository } from '../database/repositories';
import { EventService } from './EventService';
import { ProviderRegistry } from '../adapters/ProviderRegistry';
import { RoleAwareRoutingService } from './RoleAwareRoutingService';
import { TaskService } from './TaskService';
import { ProjectStopFenceService } from './ProjectStopFenceService';
import { WorkerSlotLeaseService } from './WorkerSlotLeaseService';
import { ProtocolParser } from '../protocol/parser';
import { createProductLeaseRecoveryMarkerEvent, createProductLeaseRecoveryResolvedEvent } from './ProductLeaseRecoveryScanner';
import type { AgentExecutionResult, RuntimeExecutionBinding } from '../adapters/ProviderAdapter';
import type { AccountLease, Project, Task } from '../types/domain';
import type { ManagerProtocol } from '../types/protocols';

/** Marks Manager attempts so restart recovery only touches automated Manager calls. */
export const MANAGER_ATTEMPT_MARKER = 'desktop-manager';
export const MANAGER_STARTED_EVENT = 'AUTOMATION_MANAGER_STARTED';
export const MANAGER_APPLIED_EVENT = 'AUTOMATION_MANAGER_APPLIED';
export const MANAGER_PROPOSED_EVENT = 'AUTOMATION_MANAGER_PROPOSED';
export const MANAGER_REJECTED_EVENT = 'AUTOMATION_MANAGER_REJECTED';
export const MANAGER_FAILED_EVENT = 'AUTOMATION_MANAGER_FAILED';
export const MANAGER_NOT_RUN_EVENT = 'AUTOMATION_MANAGER_NOT_RUN';
export const MANAGER_INTERRUPTED_EVENT = 'AUTOMATION_MANAGER_INTERRUPTED';
const MANAGER_EVENTS = [MANAGER_STARTED_EVENT, MANAGER_APPLIED_EVENT, MANAGER_PROPOSED_EVENT, MANAGER_REJECTED_EVENT,
  MANAGER_FAILED_EVENT, MANAGER_NOT_RUN_EVENT, MANAGER_INTERRUPTED_EVENT];

/** Owner setting: the Manager's decision is applied directly, or proposed for approval (default). */
export type ManagerMode = 'AUTO' | 'APPROVE';
/** Only dispatch authority comes from the automated Manager; verdicts stay with the reviewer. */
const ALLOWED_DECISIONS = new Set(['EXECUTE', 'BLOCK']);
const RETRY_AFTER_MS = 5 * 60_000;
/** Provider failures for one task revision are retried this many times before the owner is asked. */
const MAX_PROVIDER_ATTEMPTS = 3;

export interface ManagerCandidate {
  agentId: string;
  agentProfileId: string;
  roleProfileId: string;
  accountId: string;
  resourceId: string;
}

export interface PendingManagerDecision {
  task: Task;
  kind: 'START' | 'NEXT_REVISION';
  deferred: boolean;
}

export type ManagerOutcome =
  | { outcome: 'APPLIED' | 'PROPOSED'; eventId: string }
  | { outcome: 'FAILED'; reasonCode: string }
  | { outcome: 'NOT_RUN'; reasonCode: string };

/**
 * True when the task's latest applied Manager decision authorizes its current
 * revision: EXECUTE at that revision, or FIX_REQUIRED for the previous one.
 */
export function managerAuthorizesRevision(repo: Repository, task: Task): boolean {
  const record = repo.getLatestAppliedManagerProtocolMessage(task.id, task.project_id);
  if (!record?.raw_payload) return false;
  const parsed = ProtocolParser.parse(String(record.raw_payload));
  if (!parsed.success || parsed.data?.type !== 'manager.v1') return false;
  const decision = parsed.data.data;
  const expected = typeof decision.expected_revision === 'number' ? decision.expected_revision : null;
  if (decision.decision === 'EXECUTE') return expected === task.revision_count;
  if (decision.decision === 'FIX_REQUIRED') return expected !== null && expected + 1 === task.revision_count;
  return false;
}

interface ProposalPayload {
  taskId: string;
  taskState: string;
  taskRevision: number;
  decision: ManagerProtocol;
}

/**
 * Account-bound automated Manager (#239). For a PLANNED task, or a CODING task
 * whose current revision has no Manager authority (after a failed
 * verification or a FIX_REQUIRED review), it asks a Manager agent on its own
 * account (role-aware routing, WorkerSlotLeaseService lease, read-only CLI
 * with no repository context) for a manager.v1 EXECUTE or BLOCK decision bound
 * to the task's exact state and revision. The decision is applied only through
 * TaskService.applyManagerDecision, directly in AUTO mode or after the owner
 * approves it in APPROVE mode (the default). Failed, malformed, stale or
 * disallowed output never moves a task.
 */
export class ProductManagerService {
  private readonly now: () => Date;
  private readonly leaseTtlMs: number;
  private readonly heartbeatMs: number;
  private readonly ownedAttempts = new Set<string>();
  private readonly retryAfter = new Map<string, number>();

  constructor(
    private readonly repo: Repository,
    private readonly events: EventService,
    private readonly registry: ProviderRegistry,
    private readonly tasks: TaskService,
    options: { now?: () => Date; leaseTtlMs?: number; heartbeatMs?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.leaseTtlMs = options.leaseTtlMs ?? 300_000;
    this.heartbeatMs = Math.max(1_000, options.heartbeatMs ?? 60_000);
  }

  private iso(): string {
    return this.now().toISOString();
  }

  public getMode(projectId: string): ManagerMode {
    return this.repo.getProjectManagerMode(projectId);
  }

  private key(task: Task): string {
    return `${task.id}:${task.revision_count}`;
  }

  private managerEvents(projectId: string, taskId?: string) {
    return this.repo.getEventsByProject(projectId).filter((event) => MANAGER_EVENTS.includes(event.type) && (!taskId || event.task_id === taskId));
  }

  private eventsForRevision(task: Task) {
    return this.managerEvents(task.project_id, task.id)
      .filter((event) => (event.structured_payload as { taskRevision?: unknown } | null)?.taskRevision === task.revision_count);
  }

  /** The first task (oldest first) that needs a Manager decision no automated call has settled yet. */
  public pendingDecision(projectId: string): PendingManagerDecision | null {
    const candidates = this.repo.getTasksByProject(projectId)
      .filter((task) => !this.repo.isTaskTrashed(task.id))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const task of candidates) {
      let kind: PendingManagerDecision['kind'];
      if (task.state === 'PLANNED' && !this.repo.getLatestAppliedManagerProtocolMessage(task.id, projectId)) kind = 'START';
      else if (task.state === 'CODING' && !managerAuthorizesRevision(this.repo, task)) kind = 'NEXT_REVISION';
      else continue;
      if (this.isSettled(task)) continue;
      return { task, kind, deferred: (this.retryAfter.get(this.key(task)) ?? 0) > this.now().getTime() };
    }
    return null;
  }

  /** A proposal, an applied or rejected decision, a terminal failure, or too many provider failures settle a revision. */
  private isSettled(task: Task): boolean {
    const events = this.eventsForRevision(task);
    if (events.some((event) => [MANAGER_APPLIED_EVENT, MANAGER_PROPOSED_EVENT, MANAGER_REJECTED_EVENT].includes(event.type))) return true;
    const failures = events.filter((event) => event.type === MANAGER_FAILED_EVENT);
    if (failures.some((event) => (event.structured_payload as { retryable?: unknown } | null)?.retryable !== true)) return true;
    return failures.length >= MAX_PROVIDER_ATTEMPTS;
  }

  /** Why a task is waiting on the Manager, for the status header; null when nothing is known. */
  public waitingReason(projectId: string): { taskId: string; reasonCode: string } | null {
    for (const task of this.repo.getTasksByProject(projectId)) {
      if (this.repo.isTaskTrashed(task.id) || (task.state !== 'PLANNED' && task.state !== 'CODING')) continue;
      const events = this.eventsForRevision(task).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      if (this.openProposal(task)) return { taskId: task.id, reasonCode: 'MANAGER_PROPOSAL_PENDING' };
      if (this.isSettled(task) && events.some((event) => event.type === MANAGER_FAILED_EVENT)) return { taskId: task.id, reasonCode: 'MANAGER_FAILED' };
      if (events[0]?.type === MANAGER_REJECTED_EVENT) return { taskId: task.id, reasonCode: 'MANAGER_PROPOSAL_REJECTED' };
    }
    return null;
  }

  /** Open (undecided) proposals of a project, newest first, for the owner. */
  public listProposals(projectId: string): Array<{ eventId: string; taskId: string; taskTitle: string; taskRevision: number; decision: string; instructions: string[]; createdAt: string }> {
    const result = [];
    for (const task of this.repo.getTasksByProject(projectId)) {
      const proposal = this.openProposal(task);
      if (!proposal) continue;
      const payload = proposal.structured_payload as unknown as ProposalPayload;
      result.push({ eventId: proposal.id, taskId: task.id, taskTitle: task.title, taskRevision: payload.taskRevision,
        decision: payload.decision.decision, instructions: payload.decision.instructions ?? [], createdAt: proposal.timestamp });
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private openProposal(task: Task) {
    const events = this.eventsForRevision(task);
    const proposal = events.find((event) => event.type === MANAGER_PROPOSED_EVENT);
    if (!proposal) return null;
    const decided = events.some((event) => (event.type === MANAGER_APPLIED_EVENT || event.type === MANAGER_REJECTED_EVENT) &&
      (event.structured_payload as { proposalEventId?: unknown } | null)?.proposalEventId === proposal.id);
    return decided ? null : proposal;
  }

  /** The owner approves or rejects a proposal. Approval re-checks freshness and applies through TaskService. */
  public async decideProposal(projectId: string, eventId: string, approve: boolean): Promise<{ success: boolean; errorCode?: string; error?: string }> {
    const proposal = this.managerEvents(projectId).find((event) => event.id === eventId && event.type === MANAGER_PROPOSED_EVENT);
    if (!proposal || !proposal.task_id) return { success: false, errorCode: 'PROPOSAL_NOT_FOUND' };
    const task = this.repo.getTask(proposal.task_id);
    if (!task || this.openProposal(task)?.id !== eventId) return { success: false, errorCode: 'PROPOSAL_ALREADY_DECIDED' };
    const payload = proposal.structured_payload as unknown as ProposalPayload;
    const base = { proposalEventId: eventId, taskRevision: payload.taskRevision };
    if (!approve) {
      this.events.record(projectId, MANAGER_REJECTED_EVENT, `The owner rejected the Manager's proposal for task ${task.id}.`, base, task.id);
      return { success: true };
    }
    if (task.state !== payload.taskState || task.revision_count !== payload.taskRevision) {
      this.events.record(projectId, MANAGER_REJECTED_EVENT, `The Manager's proposal for task ${task.id} is stale.`, { ...base, reasonCode: 'PROPOSAL_STALE' }, task.id);
      return { success: false, errorCode: 'PROPOSAL_STALE' };
    }
    const fenced = this.projectFence(task.project_id, task.id);
    if (fenced) return { success: false, errorCode: fenced };
    const applied = await this.tasks.applyManagerDecision(payload.decision, JSON.stringify(payload.decision));
    if (!applied.success) {
      this.events.record(projectId, MANAGER_REJECTED_EVENT, `The Manager's proposal for task ${task.id} was not accepted.`, { ...base, reasonCode: 'MANAGER_DECISION_REJECTED' }, task.id);
      return { success: false, errorCode: 'MANAGER_DECISION_REJECTED', error: applied.error };
    }
    this.events.record(projectId, MANAGER_APPLIED_EVENT, `The owner approved the Manager's ${payload.decision.decision} for task ${task.id}.`,
      { ...base, decision: payload.decision.decision, approvedByOwner: true }, task.id);
    return { success: true };
  }

  public async decide(pending: PendingManagerDecision, manager: ManagerCandidate, mode: ManagerMode): Promise<ManagerOutcome> {
    const task = pending.task;
    const base = { taskRevision: task.revision_count, kind: pending.kind };
    const record = (type: string, summary: string, payload: Record<string, unknown>) =>
      this.events.record(task.project_id, type, summary, { ...base, ...payload }, task.id);
    const failed = (reasonCode: string, retryable: boolean, extra: Record<string, unknown> = {}): ManagerOutcome => {
      if (retryable) this.retryAfter.set(this.key(task), this.now().getTime() + RETRY_AFTER_MS);
      record(MANAGER_FAILED_EVENT, `The automated Manager made no decision for task ${task.id}: ${reasonCode}.`, { reasonCode, retryable, ...extra });
      return { outcome: 'FAILED', reasonCode };
    };
    const notStarted = (reasonCode: string): ManagerOutcome => {
      this.retryAfter.set(this.key(task), this.now().getTime() + RETRY_AFTER_MS);
      const already = this.eventsForRevision(task).some((event) => event.type === MANAGER_NOT_RUN_EVENT &&
        (event.structured_payload as { reasonCode?: unknown } | null)?.reasonCode === reasonCode);
      if (!already) record(MANAGER_NOT_RUN_EVENT, `The automated Manager could not start for task ${task.id} yet: ${reasonCode}.`, { reasonCode });
      return { outcome: 'NOT_RUN', reasonCode };
    };
    const unchanged = () => {
      const current = this.repo.getTask(task.id);
      return !!current && current.state === task.state && current.revision_count === task.revision_count &&
        (current.ownership_epoch ?? 1) === (task.ownership_epoch ?? 1);
    };

    const fenced = this.projectFence(task.project_id, task.id);
    if (fenced) return { outcome: 'NOT_RUN', reasonCode: fenced };
    if (!unchanged()) return { outcome: 'NOT_RUN', reasonCode: 'TASK_MOVED_ON' };

    const attemptId = `attempt-${crypto.randomUUID()}`;
    const nextAttemptNumber = Math.max(0, ...this.repo.getTaskAttemptsByTask(task.id).map((a) => a.attempt_number)) + 1;
    this.repo.createTaskAttempt({
      id: attemptId, task_id: task.id, attempt_number: nextAttemptNumber, agent_id: manager.agentId, agent_profile_id: manager.agentProfileId,
      status: 'RUNNING', started_at: this.iso(), ended_at: null, summary: MANAGER_ATTEMPT_MARKER,
    });
    this.ownedAttempts.add(attemptId);
    let assignmentId: string | null = null;
    let lease: AccountLease | null = null;
    const leases = new WorkerSlotLeaseService(this.repo, { clock: this.now });
    const finish = (status: 'COMPLETED' | 'FAILED') => {
      if (lease) {
        const released = leases.release(lease.id, lease.lease_token);
        if (released.status !== 'RELEASED') { this.ownedAttempts.delete(attemptId); return; } // Left for recovery.
      }
      if (assignmentId) this.repo.endUnleasedAgentAssignment(assignmentId, status, this.iso());
      this.repo.endRunningTaskAttempt(attemptId, status, this.iso());
      this.ownedAttempts.delete(attemptId);
    };

    try {
      const routing = await new RoleAwareRoutingService(this.repo, this.registry, this.events).routeRole({
        projectId: task.project_id, taskId: task.id, attemptId, roleProfileId: manager.roleProfileId, agentProfileId: manager.agentProfileId,
        candidateRefs: [{ accountId: manager.accountId, resourceId: manager.resourceId }], persistAssignment: true, allowManualBridge: false,
      });
      assignmentId = routing.selectedAssignmentId ?? null;
      if (routing.outcome !== 'SELECTED' || !routing.selectedAssignmentId || !routing.decisionId) { finish('FAILED'); return notStarted('ROUTING_NOT_SELECTED'); }
      const acquired = leases.acquireForAssignment(routing.selectedAssignmentId, this.leaseTtlMs);
      if (acquired.status !== 'ACQUIRED') { finish('FAILED'); return notStarted(acquired.code); }
      lease = acquired.lease;
      const assignment = acquired.assignment;
      const account = this.repo.getProviderAccount(assignment.selected_account_id);
      const resource = this.repo.getProviderResource(assignment.selected_resource_id);
      const adapter = this.registry.get(assignment.selected_provider_id);
      if (!account || !resource || !adapter) { finish('FAILED'); return notStarted('MANAGER_BINDING_INVALID'); }
      if (this.projectFence(task.project_id, task.id) || !unchanged()) { finish('FAILED'); return notStarted('TASK_MOVED_ON'); }

      const executionId = crypto.randomUUID();
      record(MANAGER_STARTED_EVENT, `The automated Manager is deciding task ${task.id}.`,
        { attemptId, assignmentId, executionId, managerAgentId: manager.agentId, accountId: account.id });
      const binding: RuntimeExecutionBinding = {
        authorizationId: `manager:${attemptId}`, routingDecisionId: routing.decisionId, assignmentId: assignment.id,
        providerId: assignment.selected_provider_id, accountId: account.id, resourceId: resource.id, adapterType: adapter.adapterType,
        modelName: resource.model_name, accountAuthMode: account.auth_mode, profileRef: account.profile_ref ?? null, executionId,
      };
      let leaseLost = false;
      const heartbeat = setInterval(() => {
        let keep = false;
        try {
          keep = leases.heartbeat(lease!.id, lease!.lease_token, this.leaseTtlMs).status === 'HEARTBEAT_ACKNOWLEDGED' &&
            !this.projectFence(task.project_id, task.id) && unchanged();
        } catch { keep = false; }
        if (!keep && !leaseLost) { leaseLost = true; void adapter.cancel(executionId).catch(() => undefined); }
      }, this.heartbeatMs);
      heartbeat.unref?.();
      let result: AgentExecutionResult;
      try {
        // No repository context: the Manager decides from the task, contract and results in the prompt.
        result = await adapter.execute({ projectId: task.project_id, taskId: task.id, attemptId, contextFiles: [], runtimeBinding: binding,
          expectedProtocol: 'manager.v1', instructions: this.instructions(task, pending.kind) });
      } catch {
        result = { executionId, status: 'FAILED', errorCode: 'EXECUTION_FAILED' };
      } finally {
        clearInterval(heartbeat);
      }

      if (leaseLost) { finish('FAILED'); return failed('MANAGER_LEASE_OR_FENCE_LOST', true, { attemptId }); }
      if (result.status !== 'COMPLETED') { finish('FAILED'); return failed(result.errorCode ? String(result.errorCode) : 'PROVIDER_EXECUTION_FAILED', true, { attemptId }); }
      const parsed = ProtocolParser.parse(result.outputProtocol ?? '');
      if (!parsed.success || parsed.data?.type !== 'manager.v1') { finish('FAILED'); return failed('MANAGER_PROTOCOL_INVALID', false, { attemptId }); }
      const raw = parsed.data.data;
      if (raw.project_id !== task.project_id || raw.task_id !== task.id) { finish('FAILED'); return failed('MANAGER_DECISION_FOR_OTHER_TASK', false, { attemptId }); }
      if (!ALLOWED_DECISIONS.has(raw.decision)) { finish('FAILED'); return failed('MANAGER_DECISION_NOT_ALLOWED', false, { attemptId, decision: raw.decision }); }
      if (raw.expected_task_state !== task.state || raw.expected_revision !== task.revision_count) {
        finish('FAILED');
        return failed('MANAGER_DECISION_STALE', false, { attemptId });
      }
      // Our own message identity: a reused provider message_id must never replay an earlier decision.
      const decision: ManagerProtocol = { ...raw, message_id: `manager-auto-${crypto.randomUUID()}`, created_at: this.iso() };
      finish('COMPLETED');

      if (mode === 'APPROVE') {
        const proposal = this.events.record(task.project_id, MANAGER_PROPOSED_EVENT, `The Manager proposes ${decision.decision} for task ${task.id}; waiting for the owner.`,
          { ...base, taskId: task.id, taskState: task.state, decision }, task.id);
        return { outcome: 'PROPOSED', eventId: proposal.id };
      }
      if (this.projectFence(task.project_id, task.id) || !unchanged()) return failed('TASK_MOVED_ON', false, { attemptId });
      const applied = await this.tasks.applyManagerDecision(decision, JSON.stringify(decision));
      if (!applied.success) return failed('MANAGER_DECISION_REJECTED', false, { attemptId, error: applied.error ?? null });
      const event = this.events.record(task.project_id, MANAGER_APPLIED_EVENT, `The automated Manager applied ${decision.decision} for task ${task.id}.`,
        { ...base, attemptId, decision: decision.decision, approvedByOwner: false }, task.id);
      return { outcome: 'APPLIED', eventId: event.id };
    } catch {
      finish('FAILED');
      return failed('MANAGER_INTERNAL_ERROR', true, { attemptId });
    }
  }

  /**
   * Restart recovery for Manager attempts this process does not own: fenced
   * while their process may still run; otherwise the expired lease is released
   * (closing any startup quarantine marker) and the attempt ends FAILED. No
   * decision is inferred; the revision is asked again.
   */
  public recoverAbandoned(): number {
    let recovered = 0;
    for (const project of this.repo.getAllProjects()) {
      const events = this.managerEvents(project.id);
      for (const task of this.repo.getTasksByProject(project.id)) {
        for (const attempt of this.repo.getTaskAttemptsByTask(task.id)) {
          if (attempt.status !== 'RUNNING' || attempt.summary !== MANAGER_ATTEMPT_MARKER || this.ownedAttempts.has(attempt.id)) continue;
          const started = events.find((event) => event.type === MANAGER_STARTED_EVENT && (event.structured_payload as { attemptId?: unknown } | null)?.attemptId === attempt.id);
          const executionId = (started?.structured_payload as { executionId?: unknown } | null)?.executionId;
          if (typeof executionId === 'string' && this.repo.getProcessRun(executionId)?.status === 'RUNNING') continue;
          const assignment = this.repo.getAgentAssignmentsByTask(task.id).find((candidate) => candidate.attempt_id === attempt.id) ?? null;
          const lease = assignment ? this.repo.getActiveLeaseForAssignment(assignment.id) : null;
          if (lease && assignment && !this.releaseExpiredLease(lease, assignment.id, task)) continue;
          if (assignment) this.repo.endUnleasedAgentAssignment(assignment.id, 'FAILED', this.iso());
          this.repo.endRunningTaskAttempt(attempt.id, 'FAILED', this.iso());
          this.events.record(project.id, MANAGER_INTERRUPTED_EVENT, `The automated Manager call for task ${task.id} was interrupted; nothing was applied.`,
            { attemptId: attempt.id, taskRevision: (started?.structured_payload as { taskRevision?: unknown } | null)?.taskRevision ?? null }, task.id);
          recovered += 1;
        }
      }
    }
    return recovered;
  }

  private releaseExpiredLease(lease: AccountLease, assignmentId: string, task: Task): boolean {
    try {
      return this.repo.runInImmediateTransaction(() => {
        const released = new WorkerSlotLeaseService(this.repo, { clock: this.now })
          .recoverExpiredLease(lease.id, lease.lease_token, this.now(), { expectedTaskStates: [task.state] });
        if (released.status !== 'RELEASED') return false;
        const binding = { leaseId: lease.id, assignmentId, taskId: task.id, projectId: task.project_id,
          accountId: lease.provider_account_id, workerSlotId: lease.worker_slot_id, leaseToken: lease.lease_token };
        const markerId = createProductLeaseRecoveryMarkerEvent({ ...binding, reasonCode: 'RECOVERY_REQUIRED', reason: 'Product lease cleanup recovery marker.', observedAt: lease.expires_at }).id;
        if (this.repo.getEvent(markerId)) {
          this.repo.createDeterministicGenericEvent(createProductLeaseRecoveryResolvedEvent({ ...binding, markerEventId: markerId, observedAt: this.iso() }));
        }
        return true;
      });
    } catch {
      return false;
    }
  }

  private projectFence(projectId: string, taskId: string): string | null {
    const project = this.repo.getProjectMetadata(projectId);
    if (!project || project.status !== 'RUNNING' || this.repo.isProjectTrashed(projectId) || this.repo.isTaskTrashed(taskId)) return 'PROJECT_NOT_RUNNING';
    try { new ProjectStopFenceService(this.repo).assertProjectRunningAllowed(projectId); } catch { return 'PROJECT_STOPPED'; }
    return null;
  }

  /** What the Manager needs to decide: the task, the project goal and, for a new revision, what went wrong. */
  private instructions(task: Task, kind: PendingManagerDecision['kind']): string[] {
    const project: Project | null = this.repo.getProjectMetadata(task.project_id);
    const lines = [
      'You are the project Manager. Decide whether the coder should work on this task now, and give the coder concrete instructions.',
      `Project goal: ${project?.contract?.goal ?? project?.description ?? project?.name ?? ''}`,
      `Task: ${task.title}`,
      ...(task.description ? [`Description: ${task.description}`] : []),
      ...task.acceptance_criteria.map((criterion) => `Acceptance criterion: ${criterion}`),
      ...task.constraints.map((constraint) => `Constraint: ${constraint}`),
    ];
    if (kind === 'NEXT_REVISION') {
      lines.push(`This is revision ${task.revision_count} of ${task.max_revisions}. The previous revision was sent back.`);
      const review = this.repo.getReviewsByTask(task.id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      if (review) {
        lines.push(`Latest review (${review.verdict}): ${review.summary}`);
        for (const issue of review.issues ?? []) lines.push(`Review issue [${issue.severity}] ${issue.title}${issue.file_path ? ` (${issue.file_path})` : ''}: ${issue.description}`);
      }
      const verification = this.repo.getEventsByProject(task.project_id)
        .filter((event) => event.task_id === task.id && event.type === 'AUTOMATION_VERIFICATION_FAILED')
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
      if (verification) lines.push(`Latest automated tests failed: ${(verification.structured_payload as { reasonCode?: unknown } | null)?.reasonCode ?? 'TESTS_FAILED'}.`);
      lines.push('Tell the coder exactly what to fix in "instructions".');
    }
    lines.push(
      'Decision EXECUTE starts the coder with your instructions; BLOCK stops automation for this task and asks the owner.',
      `Use exactly: project_id "${task.project_id}", task_id "${task.id}", expected_task_state "${task.state}", expected_revision ${task.revision_count}.`,
    );
    return lines;
  }
}
