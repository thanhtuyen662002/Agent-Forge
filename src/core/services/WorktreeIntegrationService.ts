import { Repository } from '../database/repositories';
import { EventService } from './EventService';
import { GitWorktreeService, type WorktreeOwnershipTuple } from './GitWorktreeService';
import { EvidenceCollector } from '../autonomy/evidence';
import { ProcessRunner } from './ProcessRunner';
import type { WorkOrder } from '../autonomy/contracts';
import type { ExecutionAuthorization, Task } from '../types/domain';

export const INTEGRATION_BRANCH_CREATED_EVENT = 'AUTOMATION_INTEGRATION_BRANCH_CREATED';
export const INTEGRATION_DISCARDED_EVENT = 'AUTOMATION_INTEGRATION_DISCARDED';
const REVIEW_PASSED_EVENT = 'AUTOMATION_REVIEW_PASSED';
const TERMINAL_STATES = new Set(['DONE', 'CANCELLED', 'FAILED']);

export interface IntegrationEntry {
  taskId: string;
  taskTitle: string;
  taskRevision: number;
  state: 'READY' | 'BRANCH_CREATED' | 'DISCARDED';
  branch: string | null;
  commitSha: string | null;
  changedFiles: string[];
}

export type IntegrationResult =
  | { success: true; branch?: string; commitSha?: string }
  | { success: false; errorCode: string };

interface ReviewedWork {
  reviewEventId: string;
  coderAuth: ExecutionAuthorization;
  tuple: WorktreeOwnershipTuple;
  worktree: string;
  headSha: string;
  snapshotSha: string;
  /** The verified changed files, kept for adopting a branch after the worktree is gone. */
  changedFiles: string[];
}

/**
 * Owner-controlled integration of reviewed coder work (#238). Only an explicit
 * owner action turns the exact reviewed snapshot of a DONE task into a NEW
 * branch in the project repository (Git plumbing: the default branch, the
 * owner's checkout and every existing branch are never modified; nothing is
 * merged or pushed). The retained worktree is then discarded and removed
 * through GitWorktreeService's owned primitives. Discard is offered for
 * terminal tasks only.
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
  private reviewedWork(task: Task): ReviewedWork | null {
    const passed = this.repo.getEventsByProject(task.project_id)
      .filter((event) => event.type === REVIEW_PASSED_EVENT && event.task_id === task.id)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
    if (!passed) return null;
    const payload = passed.structured_payload as { coderAuthorizationId?: unknown; verificationEventId?: unknown; headSha?: unknown; snapshotSha?: unknown };
    const coderAuth = typeof payload.coderAuthorizationId === 'string' ? this.repo.getExecutionAuthorization(payload.coderAuthorizationId) : null;
    const verification = typeof payload.verificationEventId === 'string' ? this.repo.getEvent(payload.verificationEventId) : null;
    const worktree = (verification?.structured_payload as { worktree?: unknown } | undefined)?.worktree;
    if (!coderAuth?.assignment_id || typeof worktree !== 'string' || typeof payload.headSha !== 'string' || typeof payload.snapshotSha !== 'string') return null;
    if (coderAuth.task_revision !== task.revision_count) return null;
    const assignment = this.repo.getAgentAssignment(coderAuth.assignment_id);
    if (!assignment?.selected_worker_slot_id) return null;
    const verifiedFiles = (verification?.structured_payload as { changedFiles?: unknown } | undefined)?.changedFiles;
    return {
      reviewEventId: passed.id, coderAuth, worktree, headSha: payload.headSha, snapshotSha: payload.snapshotSha,
      changedFiles: Array.isArray(verifiedFiles) ? verifiedFiles.filter((file): file is string => typeof file === 'string') : [],
      tuple: { projectId: coderAuth.project_id, taskId: coderAuth.task_id, attemptId: coderAuth.attempt_id ?? null, assignmentId: assignment.id,
        workerSlotId: assignment.selected_worker_slot_id, baseSha: coderAuth.repository_head_sha, ownershipEpoch: coderAuth.task_ownership_epoch },
    };
  }

  private outcomeFor(task: Task, reviewEventId: string) {
    return this.repo.getEventsByProject(task.project_id)
      .filter((event) => event.task_id === task.id && (event.type === INTEGRATION_BRANCH_CREATED_EVENT || event.type === INTEGRATION_DISCARDED_EVENT) &&
        (event.structured_payload as { reviewEventId?: unknown }).reviewEventId === reviewEventId)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0] ?? null;
  }

  /** Reviewed work of the project and what the owner did with it. */
  public list(projectId: string): IntegrationEntry[] {
    const entries: IntegrationEntry[] = [];
    for (const task of this.repo.getTasksByProject(projectId)) {
      if (task.state !== 'DONE' || this.repo.isTaskTrashed(task.id)) continue;
      const work = this.reviewedWork(task);
      if (!work) continue;
      const outcome = this.outcomeFor(task, work.reviewEventId);
      const payload = (outcome?.structured_payload ?? {}) as { branch?: unknown; commitSha?: unknown; changedFiles?: unknown };
      entries.push({
        taskId: task.id, taskTitle: task.title, taskRevision: task.revision_count,
        state: !outcome ? 'READY' : outcome.type === INTEGRATION_BRANCH_CREATED_EVENT ? 'BRANCH_CREATED' : 'DISCARDED',
        branch: typeof payload.branch === 'string' ? payload.branch : null,
        commitSha: typeof payload.commitSha === 'string' ? payload.commitSha : null,
        changedFiles: Array.isArray(payload.changedFiles) ? payload.changedFiles.filter((file): file is string => typeof file === 'string') : [],
      });
    }
    return entries;
  }

  /** True when a DONE task's reviewed work waits for the owner. */
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
      const work = this.reviewedWork(task);
      if (!work) return { success: false, errorCode: 'NO_REVIEWED_WORK' };
      const outcome = this.outcomeFor(task, work.reviewEventId);
      if (outcome) return { success: false, errorCode: outcome.type === INTEGRATION_BRANCH_CREATED_EVENT ? 'ALREADY_INTEGRATED' : 'ALREADY_DISCARDED' };
      const worktrees = this.worktreesFor(projectId);
      if (!worktrees) return { success: false, errorCode: 'GIT_UNAVAILABLE' };
      const branch = WorktreeIntegrationService.branchName(task);

      const inspected = await worktrees.inspectWorktree(work.tuple);
      if (inspected.status !== 'INSPECTED' || !inspected.inspection.registered || !inspected.inspection.exists ||
          inspected.inspection.managedPath !== work.worktree) {
        // A branch already made from this exact work by an interrupted earlier attempt is adopted, never re-created.
        return (await this.adoptExisting(task, work, branch)) ?? { success: false, errorCode: 'WORKTREE_NOT_AVAILABLE' };
      }
      // An interrupted earlier attempt may already have written the branch: adopt it if it is exactly this work.
      const adopted = await this.adoptExisting(task, work, branch);
      if (adopted) return adopted;
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
      const committed = await worktrees.commitChangesToNewBranch(work.tuple, branch, message);
      if (committed.status !== 'COMMITTED') {
        const adopted = committed.error?.startsWith('BRANCH_EXISTS') ? await this.adoptExisting(task, work, branch, snapshot.changedFiles) : null;
        return adopted ?? { success: false, errorCode: committed.error?.startsWith('BRANCH_EXISTS') ? 'BRANCH_EXISTS' : 'BRANCH_CREATION_FAILED' };
      }
      const expected = [...snapshot.changedFiles].sort();
      if (JSON.stringify(committed.changedFiles) !== JSON.stringify(expected)) {
        // The commit is not exactly the reviewed work: never report it as integrated.
        return { success: false, errorCode: 'COMMIT_DOES_NOT_MATCH_REVIEW' };
      }
      this.events.record(projectId, INTEGRATION_BRANCH_CREATED_EVENT, `Reviewed work of task ${task.id} is on branch ${branch}.`, {
        reviewEventId: work.reviewEventId, branch, commitSha: committed.commitSha, baseSha: work.coderAuth.repository_head_sha,
        changedFiles: committed.changedFiles, taskRevision: task.revision_count,
      }, task.id);
      await this.removeRetained(worktrees, work.tuple);
      return { success: true, branch, commitSha: committed.commitSha };
    }, { success: false, errorCode: 'OPERATION_IN_PROGRESS' });
  }

  /**
   * After an interrupted createBranch (commit and ref written, event not):
   * adopts the branch only if it is exactly one commit on the reviewed base
   * whose changed files are the reviewed ones.
   */
  private async adoptExisting(task: Task, work: ReviewedWork, branch: string, changedFiles?: string[]): Promise<IntegrationResult | null> {
    const git = this.gitExecutable();
    const project = this.repo.getProjectMetadata(task.project_id);
    if (!git || !project) return null;
    const run = (args: string[]) => ProcessRunner.execute({
      executable: git, args, cwd: project.repository_path, timeoutMs: 30_000, allowShell: false, deferPersistence: true,
      env: { GIT_OPTIONAL_LOCKS: '0' }, allowedEnvKeys: ['GIT_OPTIONAL_LOCKS'],
    });
    const base = work.coderAuth.repository_head_sha.toLowerCase();
    const tip = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    const commitSha = tip.stdout.trim().toLowerCase();
    if (tip.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(commitSha)) return null;
    const parents = (await run(['rev-list', '--parents', '-n', '1', commitSha])).stdout.trim().toLowerCase().split(/\s+/);
    if (parents.length !== 2 || parents[1] !== base) return null;
    const files = (await run(['diff', '--name-only', '-z', base, commitSha])).stdout.split('\0').filter(Boolean).sort();
    const expected = [...(changedFiles ?? work.changedFiles)].sort();
    if (expected.length === 0 || JSON.stringify(files) !== JSON.stringify(expected)) return null;
    this.events.record(task.project_id, INTEGRATION_BRANCH_CREATED_EVENT, `Reviewed work of task ${task.id} is on branch ${branch}.`, {
      reviewEventId: work.reviewEventId, branch, commitSha, baseSha: base, changedFiles: files, taskRevision: task.revision_count, adopted: true,
    }, task.id);
    const worktrees = this.worktreesFor(task.project_id);
    if (worktrees) await this.removeRetained(worktrees, work.tuple);
    return { success: true, branch, commitSha };
  }

  private async removeRetained(worktrees: GitWorktreeService, tuple: WorktreeOwnershipTuple): Promise<boolean> {
    const discarded = await worktrees.discardOwnedChanges(tuple);
    if (discarded.status !== 'DISCARDED') return false;
    return (await worktrees.removeWorktree(tuple)).status === 'REMOVED';
  }

  /** Discards the retained worktrees of a terminal task; the reviewed work is not kept. */
  public discard(projectId: string, taskId: string): Promise<IntegrationResult> {
    return this.exclusive(taskId, async () => {
      const task = this.repo.getTask(taskId);
      if (!task || task.project_id !== projectId) return { success: false, errorCode: 'TASK_NOT_FOUND' };
      if (!TERMINAL_STATES.has(task.state)) return { success: false, errorCode: 'TASK_NOT_TERMINAL' };
      const worktrees = this.worktreesFor(projectId);
      if (!worktrees) return { success: false, errorCode: 'GIT_UNAVAILABLE' };
      let failed = 0;
      for (const auth of this.repo.getExecutionAuthorizationsByTask(task.id)) {
        if (auth.lifecycle_version !== 1 || !auth.assignment_id) continue;
        const assignment = this.repo.getAgentAssignment(auth.assignment_id);
        if (!assignment?.selected_worker_slot_id) continue;
        const tuple: WorktreeOwnershipTuple = { projectId: auth.project_id, taskId: auth.task_id, attemptId: auth.attempt_id ?? null, assignmentId: assignment.id,
          workerSlotId: assignment.selected_worker_slot_id, baseSha: auth.repository_head_sha, ownershipEpoch: auth.task_ownership_epoch };
        const inspected = await worktrees.inspectWorktree(tuple);
        if (inspected.status === 'INSPECTED' && !inspected.inspection.registered && !inspected.inspection.exists) continue; // Already gone.
        if (!(await this.removeRetained(worktrees, tuple))) failed += 1;
      }
      if (failed > 0) return { success: false, errorCode: 'DISCARD_INCOMPLETE' };
      const work = this.reviewedWork(task);
      this.events.record(projectId, INTEGRATION_DISCARDED_EVENT, `The owner discarded the retained work of task ${task.id}.`,
        { reviewEventId: work?.reviewEventId ?? null, taskRevision: task.revision_count }, task.id);
      return { success: true };
    }, { success: false, errorCode: 'OPERATION_IN_PROGRESS' });
  }
}
