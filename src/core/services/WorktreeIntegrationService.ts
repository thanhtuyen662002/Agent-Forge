import { Repository } from '../database/repositories';
import { EventService } from './EventService';
import { GitWorktreeService, type WorktreeOwnershipTuple } from './GitWorktreeService';
import { EvidenceCollector } from '../autonomy/evidence';
import { ProcessRunner } from './ProcessRunner';
import type { WorkOrder } from '../autonomy/contracts';
import type { EventRecord, ExecutionAuthorization, Task } from '../types/domain';

export const INTEGRATION_INTENT_EVENT = 'AUTOMATION_INTEGRATION_INTENT';
export const INTEGRATION_BRANCH_CREATED_EVENT = 'AUTOMATION_INTEGRATION_BRANCH_CREATED';
export const INTEGRATION_DISCARDED_EVENT = 'AUTOMATION_INTEGRATION_DISCARDED';
export const INTEGRATION_CLEANED_EVENT = 'AUTOMATION_INTEGRATION_CLEANED';
const REVIEW_PASSED_EVENT = 'AUTOMATION_REVIEW_PASSED';
const INTEGRATION_EVENTS = [INTEGRATION_INTENT_EVENT, INTEGRATION_BRANCH_CREATED_EVENT, INTEGRATION_DISCARDED_EVENT, INTEGRATION_CLEANED_EVENT];
const TERMINAL_STATES = new Set(['DONE', 'CANCELLED', 'FAILED']);

export interface IntegrationEntry {
  taskId: string;
  taskTitle: string;
  taskRevision: number;
  state: 'READY' | 'BRANCH_CREATED' | 'DISCARDED';
  branch: string | null;
  commitSha: string | null;
  changedFiles: string[];
  /** The hidden working copy could not be removed yet; Discard cleans it up without touching the branch. */
  leftoverCopy: boolean;
}

export type IntegrationResult =
  | { success: true; branch?: string; commitSha?: string; worktreeRemoved?: boolean }
  | { success: false; errorCode: string };

interface ReviewedWork {
  reviewEventId: string;
  coderAuth: ExecutionAuthorization;
  tuple: WorktreeOwnershipTuple;
  worktree: string;
  headSha: string;
  snapshotSha: string;
}

const payloadOf = (event: EventRecord) => (event.structured_payload ?? {}) as Record<string, unknown>;

/**
 * Owner-controlled integration of reviewed coder work (#238). Only an explicit
 * owner action turns the exact reviewed snapshot of a DONE task into a NEW
 * branch in the project repository (Git plumbing: the default branch, the
 * owner's checkout and every existing branch are never modified; nothing is
 * merged or pushed). The retained worktree is then discarded and removed
 * through GitWorktreeService's owned primitives. Discard is offered for
 * terminal tasks only and never hides a branch that holds the work.
 */
export class WorktreeIntegrationService {
  private readonly busy = new Set<string>();

  constructor(
    private readonly repo: Repository,
    private readonly events: EventService,
    private readonly worktreesFor: (projectId: string) => GitWorktreeService | null,
    private readonly gitExecutable: () => string | null,
    private readonly evidence: Pick<EvidenceCollector, 'collect'> = new EvidenceCollector(),
  ) {}

  /** The latest PASS review of the task's current revision, bound to its verified worktree. */
  private reviewedWork(task: Task, projectEvents: EventRecord[]): ReviewedWork | null {
    const passed = projectEvents
      .filter((event) => event.type === REVIEW_PASSED_EVENT && event.task_id === task.id)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
    if (!passed) return null;
    const payload = payloadOf(passed);
    const coderAuth = typeof payload.coderAuthorizationId === 'string' ? this.repo.getExecutionAuthorization(payload.coderAuthorizationId) : null;
    const verification = typeof payload.verificationEventId === 'string' ? this.repo.getEvent(payload.verificationEventId) : null;
    const worktree = verification ? payloadOf(verification).worktree : undefined;
    if (!coderAuth?.assignment_id || typeof worktree !== 'string' || typeof payload.headSha !== 'string' || typeof payload.snapshotSha !== 'string') return null;
    if (coderAuth.task_revision !== task.revision_count) return null;
    const assignment = this.repo.getAgentAssignment(coderAuth.assignment_id);
    if (!assignment?.selected_worker_slot_id) return null;
    return {
      reviewEventId: passed.id, coderAuth, worktree, headSha: payload.headSha, snapshotSha: payload.snapshotSha,
      tuple: { projectId: coderAuth.project_id, taskId: coderAuth.task_id, attemptId: coderAuth.attempt_id ?? null, assignmentId: assignment.id,
        workerSlotId: assignment.selected_worker_slot_id, baseSha: coderAuth.repository_head_sha, ownershipEpoch: coderAuth.task_ownership_epoch },
    };
  }

  private integrationEvents(projectEvents: EventRecord[], taskId: string, reviewEventId: string) {
    return projectEvents
      .filter((event) => event.task_id === taskId && INTEGRATION_EVENTS.includes(event.type) && payloadOf(event).reviewEventId === reviewEventId)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /** The owner's decision for this reviewed work: a branch, a discard, or nothing yet. Cleanup never replaces it. */
  private outcomeFor(projectEvents: EventRecord[], taskId: string, reviewEventId: string) {
    return this.integrationEvents(projectEvents, taskId, reviewEventId)
      .find((event) => event.type === INTEGRATION_BRANCH_CREATED_EVENT || event.type === INTEGRATION_DISCARDED_EVENT) ?? null;
  }

  /** Reviewed work of the project and what the owner did with it. */
  public list(projectId: string): IntegrationEntry[] {
    const projectEvents = this.repo.getEventsByProject(projectId);
    const entries: IntegrationEntry[] = [];
    for (const task of this.repo.getTasksByProject(projectId)) {
      if (task.state !== 'DONE' || this.repo.isTaskTrashed(task.id)) continue;
      const work = this.reviewedWork(task, projectEvents);
      if (!work) continue;
      const outcome = this.outcomeFor(projectEvents, task.id, work.reviewEventId);
      const payload = outcome ? payloadOf(outcome) : {};
      const cleaned = this.integrationEvents(projectEvents, task.id, work.reviewEventId).some((event) => event.type === INTEGRATION_CLEANED_EVENT);
      entries.push({
        taskId: task.id, taskTitle: task.title, taskRevision: task.revision_count,
        state: !outcome ? 'READY' : outcome.type === INTEGRATION_BRANCH_CREATED_EVENT ? 'BRANCH_CREATED' : 'DISCARDED',
        branch: typeof payload.branch === 'string' ? payload.branch : null,
        commitSha: typeof payload.commitSha === 'string' ? payload.commitSha : null,
        changedFiles: Array.isArray(payload.changedFiles) ? payload.changedFiles.filter((file): file is string => typeof file === 'string') : [],
        leftoverCopy: outcome?.type === INTEGRATION_BRANCH_CREATED_EVENT && payload.worktreeRemoved === false && !cleaned,
      });
    }
    return entries;
  }

  /** A DONE task whose reviewed work waits for the owner, if any. */
  public hasReadyWork(projectId: string): string | null {
    return this.list(projectId).find((entry) => entry.state === 'READY')?.taskId ?? null;
  }

  public static branchName(task: Task): string {
    const slug = task.title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '') || 'task';
    const id = task.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-8) || 'task';
    return `agent/${slug}-${id}-r${task.revision_count}`;
  }

  private async exclusive<T>(taskId: string, fn: () => Promise<T>, busy: T): Promise<T> {
    if (this.busy.has(taskId)) return busy;
    this.busy.add(taskId);
    try { return await fn(); } finally { this.busy.delete(taskId); }
  }

  /** Commits the exact reviewed snapshot on a new branch, then removes the retained worktree. */
  public createBranch(projectId: string, taskId: string): Promise<IntegrationResult> {
    return this.exclusive(taskId, async () => {
      const task = this.repo.getTask(taskId);
      if (!task || task.project_id !== projectId || this.repo.isTaskTrashed(taskId) || this.repo.isProjectTrashed(projectId)) return { success: false, errorCode: 'TASK_NOT_FOUND' };
      if (task.state !== 'DONE') return { success: false, errorCode: 'TASK_NOT_DONE' };
      const projectEvents = this.repo.getEventsByProject(projectId);
      const work = this.reviewedWork(task, projectEvents);
      if (!work) return { success: false, errorCode: 'NO_REVIEWED_WORK' };
      const outcome = this.outcomeFor(projectEvents, task.id, work.reviewEventId);
      if (outcome) return { success: false, errorCode: outcome.type === INTEGRATION_BRANCH_CREATED_EVENT ? 'ALREADY_INTEGRATED' : 'ALREADY_DISCARDED' };
      const worktrees = this.worktreesFor(projectId);
      if (!worktrees) return { success: false, errorCode: 'GIT_UNAVAILABLE' };
      const branch = WorktreeIntegrationService.branchName(task);

      // An interrupted earlier attempt may already have written exactly the intended commit: adopt it.
      const adopted = await this.adoptIntended(task, work, branch, projectEvents, worktrees);
      if (adopted) return adopted;

      const inspected = await worktrees.inspectWorktree(work.tuple);
      if (inspected.status !== 'INSPECTED' || !inspected.inspection.registered || !inspected.inspection.exists ||
          inspected.inspection.managedPath !== work.worktree) {
        return { success: false, errorCode: 'WORKTREE_NOT_AVAILABLE' };
      }
      let snapshot;
      try {
        snapshot = await this.evidence.collect({ worktree: work.worktree, base_sha: work.coderAuth.repository_head_sha } as WorkOrder);
      } catch {
        return { success: false, errorCode: 'EVIDENCE_UNAVAILABLE' };
      }
      if (snapshot.headSha !== work.headSha.toLowerCase() || snapshot.snapshotSha !== work.snapshotSha) {
        return { success: false, errorCode: 'SNAPSHOT_CHANGED_SINCE_REVIEW' };
      }
      if (snapshot.changedFiles.length === 0) return { success: false, errorCode: 'NOTHING_TO_INTEGRATE' };

      const message = `${task.title}\n\nReviewed work of Agent Forge task ${task.id}, revision ${task.revision_count}.`;
      const committed = await worktrees.commitChangesToNewBranch(work.tuple, branch, message, snapshot.changedFiles, (commitSha) => {
        // Durable intent before the ref exists: only this exact commit may ever be adopted.
        this.events.record(projectId, INTEGRATION_INTENT_EVENT, `Creating branch ${branch} for task ${task.id}.`,
          { reviewEventId: work.reviewEventId, branch, commitSha, taskRevision: task.revision_count }, task.id);
      });
      if (committed.status !== 'COMMITTED') {
        const code = committed.error?.split(':')[0] ?? '';
        return { success: false, errorCode: code === 'BRANCH_EXISTS' || code === 'COMMIT_DOES_NOT_MATCH_REVIEW' ? code : 'BRANCH_CREATION_FAILED' };
      }
      return this.recordCreated(task, work, branch, committed.commitSha, committed.changedFiles, worktrees, false);
    }, { success: false, errorCode: 'OPERATION_IN_PROGRESS' });
  }

  private async recordCreated(task: Task, work: ReviewedWork, branch: string, commitSha: string, changedFiles: string[],
    worktrees: GitWorktreeService, adopted: boolean): Promise<IntegrationResult> {
    // The branch holds the work either way; whether the hidden copy is gone is reported honestly.
    const worktreeRemoved = await this.removeRetained(worktrees, work.tuple);
    this.events.record(task.project_id, INTEGRATION_BRANCH_CREATED_EVENT, `Reviewed work of task ${task.id} is on branch ${branch}.`, {
      reviewEventId: work.reviewEventId, branch, commitSha, baseSha: work.coderAuth.repository_head_sha, changedFiles,
      taskRevision: task.revision_count, worktreeRemoved, adopted,
    }, task.id);
    return { success: true, branch, commitSha, worktreeRemoved };
  }

  /**
   * After an interrupted createBranch (intent recorded and ref written, result
   * not): adopts the branch only if its tip is exactly the intended commit,
   * one commit on the reviewed base.
   */
  private async adoptIntended(task: Task, work: ReviewedWork, branch: string, projectEvents: EventRecord[],
    worktrees: GitWorktreeService): Promise<IntegrationResult | null> {
    const intent = this.integrationEvents(projectEvents, task.id, work.reviewEventId)
      .find((event) => event.type === INTEGRATION_INTENT_EVENT && payloadOf(event).branch === branch);
    const intended = intent ? payloadOf(intent).commitSha : null;
    if (typeof intended !== 'string') return null;
    const git = this.gitExecutable();
    const project = this.repo.getProjectMetadata(task.project_id);
    if (!git || !project) return null;
    const run = (args: string[]) => ProcessRunner.execute({
      executable: git, args, cwd: project.repository_path, timeoutMs: 30_000, allowShell: false, deferPersistence: true,
      env: { GIT_OPTIONAL_LOCKS: '0' }, allowedEnvKeys: ['GIT_OPTIONAL_LOCKS'],
    });
    const base = work.coderAuth.repository_head_sha.toLowerCase();
    const tip = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    if (tip.exitCode !== 0 || tip.stdout.trim().toLowerCase() !== intended) return null;
    const parents = (await run(['rev-list', '--parents', '-n', '1', intended])).stdout.trim().toLowerCase().split(/\s+/);
    if (parents.length !== 2 || parents[1] !== base) return null;
    const files = (await run(['diff', '--no-renames', '--name-only', '-z', base, intended])).stdout.split('\0').filter(Boolean).sort();
    return this.recordCreated(task, work, branch, intended, files, worktrees, true);
  }

  private async removeRetained(worktrees: GitWorktreeService, tuple: WorktreeOwnershipTuple): Promise<boolean> {
    const inspected = await worktrees.inspectWorktree(tuple);
    if (inspected.status === 'INSPECTED' && !inspected.inspection.registered && !inspected.inspection.exists) return true; // Already gone.
    const discarded = await worktrees.discardOwnedChanges(tuple);
    if (discarded.status !== 'DISCARDED') return false;
    return (await worktrees.removeWorktree(tuple)).status === 'REMOVED';
  }

  /**
   * Discards the retained worktrees of a terminal task. When the reviewed work
   * is already on a branch, only the leftover hidden copy is cleaned up and
   * the branch outcome is kept.
   */
  public discard(projectId: string, taskId: string): Promise<IntegrationResult> {
    return this.exclusive(taskId, async () => {
      const task = this.repo.getTask(taskId);
      if (!task || task.project_id !== projectId || this.repo.isTaskTrashed(taskId) || this.repo.isProjectTrashed(projectId)) return { success: false, errorCode: 'TASK_NOT_FOUND' };
      if (!TERMINAL_STATES.has(task.state)) return { success: false, errorCode: 'TASK_NOT_TERMINAL' };
      const worktrees = this.worktreesFor(projectId);
      if (!worktrees) return { success: false, errorCode: 'GIT_UNAVAILABLE' };
      const projectEvents = this.repo.getEventsByProject(projectId);
      const work = this.reviewedWork(task, projectEvents);
      const outcome = work ? this.outcomeFor(projectEvents, task.id, work.reviewEventId) : null;
      if (outcome?.type === INTEGRATION_DISCARDED_EVENT) return { success: false, errorCode: 'ALREADY_DISCARDED' };
      let failed = 0;
      for (const auth of this.repo.getExecutionAuthorizationsByTask(task.id)) {
        if (auth.lifecycle_version !== 1 || !auth.assignment_id) continue;
        const assignment = this.repo.getAgentAssignment(auth.assignment_id);
        if (!assignment?.selected_worker_slot_id) continue;
        const tuple: WorktreeOwnershipTuple = { projectId: auth.project_id, taskId: auth.task_id, attemptId: auth.attempt_id ?? null, assignmentId: assignment.id,
          workerSlotId: assignment.selected_worker_slot_id, baseSha: auth.repository_head_sha, ownershipEpoch: auth.task_ownership_epoch };
        if (!(await this.removeRetained(worktrees, tuple))) failed += 1;
      }
      if (failed > 0) return { success: false, errorCode: 'DISCARD_INCOMPLETE' };
      if (outcome?.type === INTEGRATION_BRANCH_CREATED_EVENT) {
        this.events.record(projectId, INTEGRATION_CLEANED_EVENT, `The leftover copy of task ${task.id} was removed; its branch is kept.`,
          { reviewEventId: work!.reviewEventId, taskRevision: task.revision_count }, task.id);
        return { success: true };
      }
      this.events.record(projectId, INTEGRATION_DISCARDED_EVENT, `The owner discarded the retained work of task ${task.id}.`,
        { reviewEventId: work?.reviewEventId ?? null, taskRevision: task.revision_count }, task.id);
      return { success: true };
    }, { success: false, errorCode: 'OPERATION_IN_PROGRESS' });
  }
}
