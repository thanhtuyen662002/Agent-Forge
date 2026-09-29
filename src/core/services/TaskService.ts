import crypto from 'crypto';
import {
  Repository,
  ProtocolMessageReplayBinding,
} from '../database/repositories';
import { EventService } from './EventService';
import { VerificationService } from './VerificationService';
import { ArtifactStore } from './ArtifactStore';
import { GitService } from './GitService';
import { ProgressService } from './ProgressService';
import { TaskStateMachine, TaskTrigger } from '../state/taskStateMachine';
import { ManagerProtocol, CoderProtocol } from '../types/protocols';
import { Evidence, Task, TaskMutationBinding, TestRun, GitStatusSummary, GitDiffSummary } from '../types/domain';
import { canonicalJsonStringify, computeSha256 } from '../context/ContextIntegrity';
import { DEFAULT_MAX_REVISIONS } from '../../shared/revisionPolicy';

export interface TaskCreationSpec {
  projectId: string;
  id?: string;
  milestoneId?: string | null;
  title: string;
  description?: string | null;
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  risk?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  acceptanceCriteria?: string[];
  constraints?: string[];
}

export interface ApplyProtocolResult {
  success: boolean;
  isDuplicate?: boolean;
  message?: string;
  task?: Task;
  errorCode?: 'PROTOCOL_REPLAY_CONFLICT';
  error?: string;
}

export class ProtocolReplayConflictError extends Error {
  public readonly code = 'PROTOCOL_REPLAY_CONFLICT' as const;

  constructor(public readonly conflictingFields: readonly string[]) {
    super(`PROTOCOL_REPLAY_CONFLICT: Immutable protocol binding differs for ${conflictingFields.join(', ')}.`);
    this.name = 'ProtocolReplayConflictError';
  }
}

function canonicalManagerPayload(managerMsg: ManagerProtocol): Record<string, unknown> {
  return {
    protocol: managerMsg.protocol,
    message_id: managerMsg.message_id,
    project_id: managerMsg.project_id,
    task_id: managerMsg.task_id ?? null,
    decision: managerMsg.decision,
    priority: managerMsg.priority ?? 'MEDIUM',
    risk: managerMsg.risk ?? 'MEDIUM',
    instructions: managerMsg.instructions ?? [],
    acceptance_criteria: managerMsg.acceptance_criteria ?? [],
    constraints: managerMsg.constraints ?? [],
    review_issues: (managerMsg.review_issues ?? []).map((issue) => ({
      severity: issue.severity,
      title: issue.title,
      file_path: issue.file_path ?? null,
      line_number: issue.line_number ?? null,
      description: issue.description,
    })),
    expected_task_state: managerMsg.expected_task_state ?? null,
    expected_revision: managerMsg.expected_revision ?? null,
    // `created_at` is optional but the protocol schema intentionally does
    // not allow a JSON null.  Omit it when absent so the replay hash matches
    // the canonical persisted payload accepted by the protocol parser.
    ...(managerMsg.created_at === undefined ? {} : { created_at: managerMsg.created_at }),
  };
}

function canonicalCoderPayload(coderMsg: CoderProtocol): Record<string, unknown> {
  return {
    protocol: coderMsg.protocol,
    message_id: coderMsg.message_id,
    project_id: coderMsg.project_id,
    task_id: coderMsg.task_id,
    attempt: coderMsg.attempt ?? 1,
    status: coderMsg.status,
    completed: coderMsg.completed ?? [],
    remaining: coderMsg.remaining ?? [],
    files_claimed_changed: coderMsg.files_claimed_changed ?? [],
    tests_claimed: coderMsg.tests_claimed ?? [],
    blockers: coderMsg.blockers ?? [],
    review_requested: coderMsg.review_requested ?? true,
    expected_task_state: coderMsg.expected_task_state ?? null,
    expected_revision: coderMsg.expected_revision ?? null,
    // See the manager payload above: absent optional timestamps remain
    // absent in the canonical representation rather than becoming null.
    ...(coderMsg.created_at === undefined ? {} : { created_at: coderMsg.created_at }),
  };
}

function canonicalProtocolHash(payload: Record<string, unknown>): string {
  return computeSha256(canonicalJsonStringify(payload));
}

export interface ValidationFlowResult {
  success: boolean;
  taskId: string;
  executionId: string;
  testRun: TestRun;
  gitStatus: GitStatusSummary;
  gitDiff: GitDiffSummary;
  finalTaskState: string;
  stale?: boolean;
  error?: string;
}

export interface ReviewStartResult {
  success: boolean;
  task?: Task;
  executionId?: string;
  error?: string;
}

export interface AuthorizedTaskTransitionResult {
  success: boolean;
  task?: Task;
  error?: string;
}

export class TaskService {
  constructor(
    private repo: Repository,
    private eventService: EventService,
    private verificationService?: VerificationService,
    private artifactStore?: ArtifactStore
  ) {}

  /**
   * Resolves the message-id replay before any task lookup or mutation.  A
   * matching row keeps the existing idempotent success behavior; a row whose
   * immutable binding differs is a typed conflict and must not be recorded as
   * another ledger entry.
   */
  private protocolReplayResult(
    messageId: string,
    binding: ProtocolMessageReplayBinding,
    duplicateMessage: string,
  ): ApplyProtocolResult | null {
    const comparison = this.repo.compareProtocolMessageReplay(messageId, binding);
    if (comparison.status === 'ABSENT') return null;
    if (comparison.status === 'MATCH') {
      return {
        success: true,
        isDuplicate: true,
        message: duplicateMessage,
      };
    }

    const conflict = new ProtocolReplayConflictError(comparison.conflictingFields);
    return {
      success: false,
      errorCode: conflict.code,
      error: conflict.message,
    };
  }

  /**
   * Product-authoritative transition used by the consolidated self-host path.
   * The ownership epoch is checked in the same immediate transaction as the
   * TaskStateMachine transition so an old worker cannot advance a reassigned task.
   */
  public transitionAuthorizedTask(
    taskId: string,
    trigger: TaskTrigger,
    expectedOwnershipEpoch: number,
  ): AuthorizedTaskTransitionResult {
    try {
      return this.repo.runInImmediateTransaction(() => {
        const task = this.repo.getTask(taskId);
        if (!task) return { success: false, error: `Task "${taskId}" not found.` };
        if (task.ownership_epoch !== expectedOwnershipEpoch) {
          return {
            success: false,
            error: `OWNERSHIP_EPOCH_MISMATCH: expected ${expectedOwnershipEpoch}, current ${String(task.ownership_epoch)}.`,
          };
        }
        const transition = TaskStateMachine.transition(task.state, trigger, {
          pausedFromState: task.paused_from_state,
          revisionCount: task.revision_count,
          maxRevisions: task.max_revisions,
        });
        this.repo.updateTaskState(
          task.id,
          transition.nextState,
          transition.pausedFromState,
          transition.incrementRevision,
        );
        this.eventService.record(
          task.project_id,
          'AUTHORIZED_AUTONOMY_TASK_TRANSITION',
          `Authorized autonomy transition ${trigger} moved task ${task.id} from ${task.state} to ${transition.nextState}.`,
          {
            trigger,
            fromState: task.state,
            toState: transition.nextState,
            ownershipEpoch: expectedOwnershipEpoch,
          },
          task.id,
        );
        return { success: true, task: this.repo.getTask(task.id)! };
      });
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  public createTask(spec: TaskCreationSpec): Task {
    const project = this.repo.getProject(spec.projectId);
    if (!project) {
      throw new Error(`Project "${spec.projectId}" not found.`);
    }

    const now = new Date().toISOString();
    const taskId = spec.id || `TSK-${crypto.randomUUID().substring(0, 8).toUpperCase()}`;

    // Base SHA is initialized as NULL. It will be immutably bound to the exact Git HEAD commit SHA upon Manager EXECUTE.
    const task: Task = {
      id: taskId,
      project_id: spec.projectId,
      milestone_id: spec.milestoneId ?? null,
      title: spec.title,
      description: spec.description ?? null,
      state: 'PLANNED',
      paused_from_state: null,
      priority: spec.priority ?? 'MEDIUM',
      risk: spec.risk ?? 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: this.repo.getProjectMaxRevisions(spec.projectId) || DEFAULT_MAX_REVISIONS,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: now,
      acceptance_criteria: spec.acceptanceCriteria ?? [],
      constraints: spec.constraints ?? [],
      created_at: now,
      updated_at: now,
    };

    this.repo.createTask(task);
    this.eventService.record(
      project.id,
      'TASK_CREATED',
      `Task "${task.title}" (${task.id}) created in PLANNED state.`,
      { taskId: task.id, priority: task.priority, risk: task.risk },
      task.id
    );

    return task;
  }

  public async applyManagerDecision(
    managerMsg: ManagerProtocol,
    rawPayload: string
  ): Promise<ApplyProtocolResult> {
    const computedHash = canonicalProtocolHash(canonicalManagerPayload(managerMsg));
    const replayBinding: ProtocolMessageReplayBinding = {
      protocol: managerMsg.protocol,
      projectId: managerMsg.project_id,
      taskId: managerMsg.task_id ?? null,
      expectedTaskState: managerMsg.expected_task_state ?? null,
      expectedRevision: managerMsg.expected_revision ?? null,
      payloadHash: computedHash,
    };

    // Preserve the inexpensive replay fast path while repeating the same
    // comparison in the transaction below to close the preflight race.
    const replay = this.protocolReplayResult(
      managerMsg.message_id,
      replayBinding,
      `Manager decision "${managerMsg.message_id}" was already processed.`,
    );
    if (replay) {
      return replay;
    }

    if (managerMsg.protocol !== 'manager.v1') {
      return { success: false, error: 'Unsupported manager protocol.' };
    }

    if (!managerMsg.task_id) {
      return { success: false, error: 'Protocol message is missing required task_id.' };
    }
    const taskId = managerMsg.task_id;

    // Keep this lookup outside the transaction only for fast validation and to
    // resolve the repository path before the asynchronous Git check.  The
    // authoritative task snapshot is always re-read after the transaction
    // acquires its write lock below.
    const taskForGit = this.repo.getTask(managerMsg.task_id);
    if (!taskForGit) {
      return { success: false, error: `Task "${managerMsg.task_id}" does not exist.` };
    }

    // Preserve fail-closed preflight behavior for guards that do not require
    // Git.  The same checks are repeated inside the immediate transaction so
    // a matching preflight can never authorize a stale post-Git mutation.
    const rejectBeforeGit = (reason: string): ApplyProtocolResult => this.repo.runInImmediateTransaction(() => {
      const replay = this.protocolReplayResult(
        managerMsg.message_id,
        replayBinding,
        `Manager decision "${managerMsg.message_id}" was already processed.`,
      );
      if (replay) {
        return replay;
      }
      const current = this.repo.getTask(taskId);
      if (!current) return { success: false, error: `Task "${taskId}" does not exist.` };
      this.repo.recordProtocolMessage(
        crypto.randomUUID(),
        managerMsg.message_id,
        'manager.v1',
        current.project_id,
        current.id,
        managerMsg.expected_task_state ?? null,
        managerMsg.expected_revision ?? null,
        computedHash,
        rawPayload,
        'REJECTED',
        reason
      );
      return { success: false, error: reason };
    });
    if (managerMsg.project_id !== taskForGit.project_id) {
      return rejectBeforeGit(`Cross-project conflict: Protocol targets project "${managerMsg.project_id}", but task belongs to "${taskForGit.project_id}".`);
    }
    if (managerMsg.expected_task_state && managerMsg.expected_task_state !== taskForGit.state) {
      return rejectBeforeGit(`Stale state conflict: Manager expected state "${managerMsg.expected_task_state}", but task is in "${taskForGit.state}".`);
    }
    if (
      managerMsg.expected_revision !== null &&
      managerMsg.expected_revision !== undefined &&
      managerMsg.expected_revision !== taskForGit.revision_count
    ) {
      return rejectBeforeGit(`Stale revision conflict: Manager expected revision ${managerMsg.expected_revision}, but task revision is ${taskForGit.revision_count}.`);
    }

    // Map the protocol decision before entering the transaction.  This is a
    // pure operation and keeps unsupported messages from creating ledger rows.
    let trigger: TaskTrigger;
    switch (managerMsg.decision) {
      case 'EXECUTE':
        trigger = 'START_CODING';
        break;
      case 'PASS':
        trigger = 'PASS_VERDICT';
        break;
      case 'FIX_REQUIRED':
        trigger = 'FIX_VERDICT';
        break;
      case 'BLOCK':
        trigger = 'SET_BLOCKED';
        break;
      case 'CANCEL':
        trigger = 'CANCEL';
        break;
      case 'PAUSE':
        trigger = 'PAUSE';
        break;
      default:
        return { success: false, error: `Unsupported decision: ${(managerMsg as any).decision}` };
    }

    // Resolve the authoritative Git base SHA before acquiring SQLite's write
    // lock.  The resulting value is only a candidate: the transaction below
    // re-reads the task and keeps a base SHA that another winner may already
    // have bound.
    let resolvedBaseSha: string | null = taskForGit.base_sha;
    if (managerMsg.decision === 'EXECUTE') {
      if (!resolvedBaseSha) {
        const project = this.repo.getProject(taskForGit.project_id);
        if (!project) {
          return { success: false, error: `Project "${taskForGit.project_id}" not found.` };
        }

        const headShaRes = await GitService.getHeadSha(project.repository_path);
        if (headShaRes.status !== 'SUCCESS' || !headShaRes.sha) {
          const reason = `Cannot begin coding: Git repository HEAD SHA could not be authoritatively resolved (${headShaRes.errorMessage || 'git rev-parse HEAD failed'}).`;
          return rejectBeforeGit(reason);
        }
        resolvedBaseSha = headShaRes.sha;
      }
    }

    try {
      return this.repo.runInImmediateTransaction(() => {
        // Repeat the full immutable-binding comparison after acquiring the
        // write lock. A concurrent caller may have inserted this ID while the
        // Git lookup above was in flight.
        const replay = this.protocolReplayResult(
          managerMsg.message_id,
          replayBinding,
          `Manager decision "${managerMsg.message_id}" was already processed.`,
        );
        if (replay) {
          return replay;
        }

        const task = this.repo.getTask(taskId);
        if (!task) return { success: false, error: `Task "${taskId}" does not exist.` };

        const reject = (reason: string): ApplyProtocolResult => {
          this.repo.recordProtocolMessage(
            crypto.randomUUID(),
            managerMsg.message_id,
            'manager.v1',
            task.project_id,
            task.id,
            managerMsg.expected_task_state ?? null,
            managerMsg.expected_revision ?? null,
            computedHash,
            rawPayload,
            'REJECTED',
            reason
          );
          return { success: false, error: reason };
        };

        if (managerMsg.project_id !== task.project_id) {
          return reject(`Cross-project conflict: Protocol targets project "${managerMsg.project_id}", but task belongs to "${task.project_id}".`);
        }
        if (managerMsg.expected_task_state && managerMsg.expected_task_state !== task.state) {
          return reject(`Stale state conflict: Manager expected state "${managerMsg.expected_task_state}", but task is in "${task.state}".`);
        }
        if (
          managerMsg.expected_revision !== null &&
          managerMsg.expected_revision !== undefined &&
          managerMsg.expected_revision !== task.revision_count
        ) {
          return reject(`Stale revision conflict: Manager expected revision ${managerMsg.expected_revision}, but task revision is ${task.revision_count}.`);
        }

        let transitionRes;
        try {
          transitionRes = TaskStateMachine.transition(task.state, trigger, {
            revisionCount: task.revision_count,
            maxRevisions: task.max_revisions,
            pausedFromState: task.paused_from_state,
          });
        } catch (err: any) {
          return reject(`State Machine Error: ${err.message}`);
        }

        // This CAS is deliberately keyed by the snapshot read inside the
        // immediate transaction.  It protects against any writer that changed
        // the task between a caller's preflight and this mutation, while the
        // transaction keeps the state change and APPLIED ledger row atomic.
        if (!this.repo.compareAndSwapTaskState(
          task.id,
          task.state,
          task.revision_count,
          transitionRes.nextState,
          transitionRes.pausedFromState,
          transitionRes.incrementRevision
        )) {
          return reject(`Stale task conflict: Manager decision could not commit because task "${task.id}" changed concurrently.`);
        }

        const boundBaseSha = task.base_sha ?? resolvedBaseSha;
        if (boundBaseSha && boundBaseSha !== task.base_sha) {
          this.repo.updateTaskShas(task.id, boundBaseSha, task.current_sha);
        }

        if (managerMsg.decision === 'PASS' || managerMsg.decision === 'FIX_REQUIRED') {
          const reviewId = crypto.randomUUID();
          this.repo.createReview({
            id: reviewId,
            task_id: task.id,
            attempt_id: null,
            reviewer_agent_id: null,
            verdict: managerMsg.decision === 'PASS' ? 'PASS' : 'FIX_REQUIRED',
            summary: managerMsg.instructions.join('\n') || `Manager decision: ${managerMsg.decision}`,
            issues: (managerMsg.review_issues || []).map((iss) => ({
              id: crypto.randomUUID(),
              review_id: reviewId,
              severity: iss.severity,
              file_path: iss.file_path || null,
              line_number: iss.line_number || null,
              title: iss.title,
              description: iss.description,
              resolved: false,
            })),
            created_at: new Date().toISOString(),
          });
        }

        const updatedTask = this.repo.getTask(task.id)!;
        const latestTest = this.repo.getLatestTestRun(task.id);
        const latestDiffEv = this.repo.getLatestEvidence(task.id, 'GIT_DIFF');
        const verifCmds = this.repo.getVerificationCommandsByProject(task.project_id);
        const hasLintConfig = verifCmds.some((c) => c.command_type === 'LINT' && c.enabled);
        const progress = ProgressService.calculateTaskProgress(updatedTask, {
          hasGitDiff: Boolean(latestDiffEv) || updatedTask.current_sha !== null,
          testsPassed: latestTest?.exit_code === 0,
          hasEvidence: Boolean(latestDiffEv),
          excludeUnconfiguredLint: !hasLintConfig,
          lintPassed: false,
        });
        this.repo.updateTaskProgressCache(task.id, progress.percent);
        this.repo.invalidateAuthorizedExecutionAuthorizationsForTask(task.id);
        this.repo.recordProtocolMessage(
          crypto.randomUUID(),
          managerMsg.message_id,
          'manager.v1',
          managerMsg.project_id,
          task.id,
          managerMsg.expected_task_state ?? null,
          managerMsg.expected_revision ?? null,
          computedHash,
          rawPayload,
          'APPLIED'
        );
        this.eventService.record(
          managerMsg.project_id,
          'MANAGER_DECISION_APPLIED',
          `Manager decision "${managerMsg.decision}" applied to task ${task.id} (${task.state} -> ${transitionRes.nextState}).`,
          { decision: managerMsg.decision, fromState: task.state, toState: transitionRes.nextState, baseSha: boundBaseSha },
          task.id
        );
        return {
          success: true,
          message: `Task ${task.id} transitioned to ${transitionRes.nextState}.`,
          task: this.repo.getTask(task.id)!,
        };
      });
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public applyCoderReport(
    coderMsg: CoderProtocol,
    rawPayload: string
  ): ApplyProtocolResult {
    const computedHash = canonicalProtocolHash(canonicalCoderPayload(coderMsg));
    const replayBinding: ProtocolMessageReplayBinding = {
      protocol: coderMsg.protocol,
      projectId: coderMsg.project_id,
      taskId: coderMsg.task_id,
      expectedTaskState: coderMsg.expected_task_state ?? null,
      expectedRevision: coderMsg.expected_revision ?? null,
      payloadHash: computedHash,
    };

    // Preserve the inexpensive replay fast path while repeating the same
    // comparison in the transaction below to close the preflight race.
    const replay = this.protocolReplayResult(
      coderMsg.message_id,
      replayBinding,
      `Coder report "${coderMsg.message_id}" was already processed.`,
    );
    if (replay) {
      return replay;
    }

    if (coderMsg.protocol !== 'coder.v1') {
      return { success: false, error: 'Unsupported coder protocol.' };
    }

    // Determine the state-machine trigger before opening the transaction.
    let trigger: TaskTrigger;
    if (coderMsg.status === 'COMPLETED') {
      if (coderMsg.review_requested) {
        trigger = 'SUBMIT_REPORT'; // Moves to VALIDATING
      } else {
        trigger = 'START_CODING'; // Remains in CODING
      }
    } else if (coderMsg.status === 'IN_PROGRESS') {
      trigger = 'START_CODING'; // Remains in CODING
    } else if (coderMsg.status === 'BLOCKED') {
      trigger = 'SET_BLOCKED'; // Moves to BLOCKED
    } else if (coderMsg.status === 'FAILED') {
      trigger = 'FIX_VERDICT'; // Increments revision or escalates to NEEDS_HUMAN
    } else {
      trigger = 'SUBMIT_REPORT';
    }

    try {
      return this.repo.runInImmediateTransaction(() => {
        const replay = this.protocolReplayResult(
          coderMsg.message_id,
          replayBinding,
          `Coder report "${coderMsg.message_id}" was already processed.`,
        );
        if (replay) {
          return replay;
        }

        const task = this.repo.getTask(coderMsg.task_id);
        if (!task) return { success: false, error: `Task "${coderMsg.task_id}" does not exist.` };

        const reject = (reason: string): ApplyProtocolResult => {
          this.repo.recordProtocolMessage(
            crypto.randomUUID(),
            coderMsg.message_id,
            'coder.v1',
            task.project_id,
            task.id,
            coderMsg.expected_task_state ?? null,
            coderMsg.expected_revision ?? null,
            computedHash,
            rawPayload,
            'REJECTED',
            reason
          );
          return { success: false, error: reason };
        };

        if (coderMsg.project_id !== task.project_id) {
          return reject(`Cross-project conflict: Protocol targets project "${coderMsg.project_id}", but task belongs to "${task.project_id}".`);
        }
        if (coderMsg.expected_task_state && coderMsg.expected_task_state !== task.state) {
          return reject(`Stale state conflict: Coder expected state "${coderMsg.expected_task_state}", but task is in "${task.state}".`);
        }
        if (
          coderMsg.expected_revision !== null &&
          coderMsg.expected_revision !== undefined &&
          coderMsg.expected_revision !== task.revision_count
        ) {
          return reject(`Stale revision conflict: Coder expected revision ${coderMsg.expected_revision}, but task revision is ${task.revision_count}.`);
        }

        let transitionRes;
        try {
          transitionRes = TaskStateMachine.transition(task.state, trigger, {
            revisionCount: task.revision_count,
            maxRevisions: task.max_revisions,
            pausedFromState: task.paused_from_state,
          });
        } catch (err: any) {
          return reject(`State Machine Error: ${err.message}`);
        }

        if (!this.repo.compareAndSwapTaskState(
          task.id,
          task.state,
          task.revision_count,
          transitionRes.nextState,
          transitionRes.pausedFromState,
          transitionRes.incrementRevision
        )) {
          return reject(`Stale task conflict: Coder report could not commit because task "${task.id}" changed concurrently.`);
        }

        this.repo.recordProtocolMessage(
          crypto.randomUUID(),
          coderMsg.message_id,
          'coder.v1',
          coderMsg.project_id,
          task.id,
          coderMsg.expected_task_state ?? null,
          coderMsg.expected_revision ?? null,
          computedHash,
          rawPayload,
          'APPLIED'
        );
        this.eventService.record(
          coderMsg.project_id,
          'CODER_REPORT_APPLIED',
          `Coder report applied to task ${task.id} (${task.state} -> ${transitionRes.nextState}). Status: ${coderMsg.status}.`,
          { status: coderMsg.status, fromState: task.state, toState: transitionRes.nextState },
          task.id
        );
        return {
          success: true,
          message: `Task ${task.id} transitioned to ${transitionRes.nextState}.`,
          task: this.repo.getTask(task.id)!,
        };
      });
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public startReview(
    taskId: string,
    expectedProjectId?: string,
    binding: TaskMutationBinding = {},
  ): ReviewStartResult {
    const executionId = binding.executionId ?? crypto.randomUUID();

    try {
      return this.repo.runInImmediateTransaction(() => {
        const task = this.repo.getTask(taskId);
        if (!task) {
          return { success: false, executionId, error: `Task ${taskId} not found.` };
        }

        if (expectedProjectId && task.project_id !== expectedProjectId) {
          return {
            success: false,
            executionId,
            error: `Cross-project guard: Task ${taskId} belongs to "${task.project_id}", not "${expectedProjectId}".`,
          };
        }

        const currentEpoch = task.ownership_epoch ?? 1;
        if (
          (binding.expectedRevision !== undefined && binding.expectedRevision !== task.revision_count) ||
          (binding.expectedOwnershipEpoch !== undefined && binding.expectedOwnershipEpoch !== currentEpoch)
        ) {
          return {
            success: false,
            executionId,
            error: `TASK_BINDING_STALE: review start binding does not match task ${task.id} (revision=${task.revision_count}, ownership_epoch=${currentEpoch}, state=${task.state}).`,
          };
        }

        // A concurrent caller that observed the same revision receives the
        // already-authoritative result without emitting a duplicate event.
        if (
          task.state === 'REVIEWING' &&
          (binding.expectedState === undefined ||
            binding.expectedState === 'REVIEW_READY' ||
            binding.expectedState === 'REVIEWING')
        ) {
          return { success: true, task, executionId };
        }

        if (binding.expectedState !== undefined && binding.expectedState !== task.state) {
          return {
            success: false,
            executionId,
            error: `TASK_BINDING_STALE: review start binding does not match task ${task.id} (revision=${task.revision_count}, ownership_epoch=${currentEpoch}, state=${task.state}).`,
          };
        }

        if (task.state !== 'REVIEW_READY') {
          return {
            success: false,
            executionId,
            error: `Cannot start review: Task is in state "${task.state}", expected "REVIEW_READY".`,
          };
        }

        const trans = TaskStateMachine.transition(task.state, 'START_REVIEW', {
          revisionCount: task.revision_count,
          maxRevisions: task.max_revisions,
        });
        if (!this.repo.compareAndSwapTaskState(
          task.id,
          task.state,
          task.revision_count,
          trans.nextState,
          trans.pausedFromState,
          trans.incrementRevision,
        )) {
          return {
            success: false,
            executionId,
            error: `TASK_BINDING_STALE: review start lost the task revision race for ${task.id}.`,
          };
        }

        this.eventService.record(
          task.project_id,
          'REVIEW_STARTED',
          `Review started for task ${task.id}. State: REVIEWING.`,
          {
            fromState: task.state,
            toState: trans.nextState,
            executionId,
            taskRevision: task.revision_count,
            ownershipEpoch: currentEpoch,
          },
          task.id,
        );
        return { success: true, task: this.repo.getTask(task.id)!, executionId };
      });
    } catch (err: any) {
      return { success: false, executionId, error: err.message };
    }
  }

  public async executeValidationFlow(
    taskId: string,
    commandConfigId?: string,
    expectedProjectId?: string,
    binding: TaskMutationBinding = {},
  ): Promise<ValidationFlowResult> {
    const task = this.repo.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found.`);
    }

    const executionId = binding.executionId ?? crypto.randomUUID();
    const expectedRevision = binding.expectedRevision ?? task.revision_count;
    const expectedOwnershipEpoch = binding.expectedOwnershipEpoch ?? (task.ownership_epoch ?? 1);
    const expectedState = binding.expectedState ?? task.state;

    // Cross-project guard
    if (expectedProjectId && task.project_id !== expectedProjectId) {
      throw new Error(
        `Cross-project guard: Task ${taskId} belongs to "${task.project_id}", not "${expectedProjectId}".`
      );
    }

    if (
      (binding.expectedRevision !== undefined && binding.expectedRevision !== task.revision_count) ||
      (binding.expectedOwnershipEpoch !== undefined && binding.expectedOwnershipEpoch !== (task.ownership_epoch ?? 1)) ||
      (binding.expectedState !== undefined && binding.expectedState !== task.state)
    ) {
      throw new Error(`TASK_BINDING_STALE: validation start binding does not match task ${task.id}.`);
    }

    const project = this.repo.getProject(task.project_id);
    if (!project) {
      throw new Error(`Project ${task.project_id} not found.`);
    }

    const repoPath = project.repository_path;

    // Record the execution identity before long-running Git/tests work.  The
    // same binding is required again at the final write fence.
    this.repo.runInImmediateTransaction(() => {
      const current = this.repo.getTask(task.id);
      if (!current) throw new Error(`Task ${task.id} not found.`);
      const currentEpoch = current.ownership_epoch ?? 1;
      if (
        current.project_id !== task.project_id ||
        current.revision_count !== expectedRevision ||
        currentEpoch !== expectedOwnershipEpoch ||
        current.state !== expectedState ||
        current.base_sha !== task.base_sha
      ) {
        throw new Error(`TASK_BINDING_STALE: validation ${executionId} could not start for the captured task revision.`);
      }
      this.eventService.record(
        task.project_id,
        'VALIDATION_STARTED',
        `Validation ${executionId} started for task ${task.id}.`,
        { executionId, taskRevision: expectedRevision, ownershipEpoch: expectedOwnershipEpoch, expectedState },
        task.id,
      );
    });

    // 1. Gather authoritative Git status & diff
    const gitStatus = await GitService.getStatus(repoPath);
    const gitDiff = await GitService.getDiff(repoPath, task.base_sha);
    const headShaRes = await GitService.getHeadSha(repoPath);
    const currentSha = headShaRes.status === 'SUCCESS' ? headShaRes.sha : null;

    // 2. Execute configured test verification suite
    if (!this.verificationService) {
      throw new Error('VerificationService not wired into TaskService.');
    }

    const testRun = await this.verificationService.runTests(
      project.id,
      task.id,
      null,
      repoPath,
      commandConfigId,
      { deferPersistence: true, executionId },
    );

    // Re-read HEAD after the potentially long-running test process.  A
    // commit created by another actor during verification invalidates the
    // captured SHA and must lose the write fence instead of being recorded as
    // evidence for the newer workspace.
    const finalHeadShaRes = await GitService.getHeadSha(repoPath);
    const finalCurrentSha = finalHeadShaRes.status === 'SUCCESS' ? finalHeadShaRes.sha : null;
    const workspaceHeadDrifted =
      headShaRes.status === 'SUCCESS' &&
      finalHeadShaRes.status === 'SUCCESS' &&
      currentSha !== finalCurrentSha;

    const pendingEvidence: Evidence[] = [];
    if (testRun.pending_evidence) pendingEvidence.push(testRun.pending_evidence);
    if (testRun.pending_process_evidence) pendingEvidence.push(...testRun.pending_process_evidence);
    if (this.artifactStore) {
      if (gitStatus.status === 'SUCCESS') {
        pendingEvidence.push(this.artifactStore.store(
          crypto.randomUUID(),
          project.id,
          task.id,
          null,
          'GIT_STATUS',
          `Git Status: ${gitStatus.isClean ? 'Clean' : 'Modified'} on ${gitStatus.branch}`,
          JSON.stringify(gitStatus, null, 2),
          'application/json',
        ));
      }

      if (gitDiff.status === 'SUCCESS' && gitDiff.diffContent) {
        pendingEvidence.push(this.artifactStore.store(
          crypto.randomUUID(),
          project.id,
          task.id,
          null,
          'GIT_DIFF',
          `Git Diff: ${gitDiff.filesChanged.length} files changed`,
          gitDiff.diffContent,
          'text/x-diff',
        ));
      }
    }

    // 3. Authoritative Evidence Gate: Require Git Success AND Test Exit Code 0
    const gitEvidenceSuccess =
      gitStatus.status === 'SUCCESS' &&
      gitDiff.status === 'SUCCESS' &&
      headShaRes.status === 'SUCCESS' &&
      finalHeadShaRes.status === 'SUCCESS' &&
      !workspaceHeadDrifted;

    const verificationPassed = gitEvidenceSuccess && testRun.exit_code === 0;

    const cleanupPendingEvidence = () => {
      const filePaths = pendingEvidence
        .map((evidence) => evidence.file_path)
        .filter((filePath): filePath is string => Boolean(filePath));
      const store = this.artifactStore ?? this.verificationService?.getArtifactStore();
      return store && filePaths.length > 0
        ? store.cleanupRollbackFiles(filePaths, (filePath) => this.repo.isEvidenceFilePathReferenced(filePath))
        : { cleanedCount: 0, failures: [] as Array<{ path: string; error: string }> };
    };

    const commitResult = (() => {
      try {
        return this.repo.runInImmediateTransaction(() => {
          const currentTask = this.repo.getTask(task.id);
          if (!currentTask) throw new Error(`Task ${task.id} not found.`);
          const currentEpoch = currentTask.ownership_epoch ?? 1;
          const bindingMismatch =
            currentTask.project_id !== task.project_id ||
            currentTask.revision_count !== expectedRevision ||
            currentEpoch !== expectedOwnershipEpoch ||
            currentTask.state !== expectedState ||
            currentTask.base_sha !== task.base_sha;

          if (bindingMismatch) {
            this.eventService.record(
              project.id,
              'VALIDATION_STALE_RESULT',
              `Validation ${executionId} completed against a stale task binding and was discarded.`,
              {
                executionId,
                expectedRevision,
                expectedOwnershipEpoch,
                expectedState,
                currentRevision: currentTask.revision_count,
                currentOwnershipEpoch: currentEpoch,
                currentState: currentTask.state,
              },
              task.id,
            );
            return { stale: true, success: false, task: currentTask, nextState: currentTask.state };
          }

          if (workspaceHeadDrifted) {
            this.eventService.record(
              project.id,
              'VALIDATION_STALE_RESULT',
              `Validation ${executionId} observed a different repository HEAD after tests and was discarded.`,
              {
                executionId,
                expectedHeadSha: currentSha,
                observedHeadSha: finalCurrentSha,
              },
              task.id,
            );
            return { stale: true, success: false, task: currentTask, nextState: currentTask.state };
          }

          const trigger = verificationPassed ? 'EVIDENCE_GATHERED' : 'TESTS_FAILED';
          const trans = TaskStateMachine.transition(currentTask.state, trigger, {
            revisionCount: currentTask.revision_count,
            maxRevisions: currentTask.max_revisions,
          });
          if (!this.repo.compareAndSwapTaskState(
            currentTask.id,
            currentTask.state,
            currentTask.revision_count,
            trans.nextState,
            trans.pausedFromState,
            trans.incrementRevision,
          )) {
            this.eventService.record(
              project.id,
              'VALIDATION_STALE_RESULT',
              `Validation ${executionId} lost the task revision race and was discarded.`,
              { executionId, expectedRevision, expectedOwnershipEpoch },
              task.id,
            );
            return { stale: true, success: false, task: this.repo.getTask(task.id)!, nextState: currentTask.state };
          }

          for (const evidence of pendingEvidence) this.repo.createEvidence(evidence);
          if (testRun.pending_process_run) {
            const processRun = testRun.pending_process_run;
            const terminalStatus =
              processRun.status === 'RUNNING'
                ? processRun.exit_code === 0
                  ? 'COMPLETED'
                  : 'FAILED'
                : processRun.status;
            this.repo.createProcessRun({
              id: processRun.id,
              pid: processRun.pid,
              project_id: project.id,
              task_id: task.id,
              attempt_id: null,
              command: processRun.command,
              working_directory: processRun.working_directory,
              status: 'RUNNING',
              start_time: processRun.start_time,
            });
            this.repo.updateProcessRun(
              processRun.id,
              terminalStatus,
              processRun.exit_code,
              processRun.end_time,
              processRun.stdout_evidence_id,
              processRun.stderr_evidence_id,
            );
          }
          this.repo.createTestRun(testRun);
          if (verificationPassed && finalCurrentSha) this.repo.updateTaskShas(task.id, task.base_sha, finalCurrentSha);

          const finalTask = this.repo.getTask(task.id)!;
          const verifCmds = this.repo.getVerificationCommandsByProject(project.id);
          const hasLintConfig = verifCmds.some((c) => c.command_type === 'LINT' && c.enabled);
          const progress = ProgressService.calculateTaskProgress(finalTask, {
            hasGitDiff: gitDiff.status === 'SUCCESS' && gitDiff.filesChanged.length > 0,
            hasEvidence: gitEvidenceSuccess && (gitDiff.filesChanged.length > 0 || gitStatus.isClean),
            testsPassed: testRun.exit_code === 0,
            excludeUnconfiguredLint: !hasLintConfig,
            lintPassed: false,
          });
          this.repo.updateTaskProgressCache(task.id, progress.percent);

          if (verificationPassed) {
            this.eventService.record(
              project.id,
              'VERIFICATION_PASSED',
              `Task ${task.id} verification tests passed (${testRun.passed_count} passed). Transitioned to REVIEW_READY.`,
              { executionId, passed: testRun.passed_count, exitCode: testRun.exit_code, sha: finalCurrentSha },
              task.id,
            );
          } else {
            const failureReason = !gitEvidenceSuccess
              ? `Authoritative Git evidence failed (Status: ${gitStatus.status}, Diff: ${gitDiff.status}, initial SHA: ${headShaRes.status}, final SHA: ${finalHeadShaRes.status}).`
              : `Verification tests failed (exit code ${testRun.exit_code}, ${testRun.failed_count} failures).`;
            this.eventService.record(
              project.id,
              'VERIFICATION_FAILED',
              `Task ${task.id} verification failed: ${failureReason}. Returned to ${trans.nextState}.`,
              {
                executionId,
                gitStatus: gitStatus.status,
                gitDiff: gitDiff.status,
                testExitCode: testRun.exit_code,
                failedCount: testRun.failed_count,
              },
              task.id,
            );
          }
          return { stale: false, success: verificationPassed, task: this.repo.getTask(task.id)!, nextState: trans.nextState };
        });
      } catch (error) {
        cleanupPendingEvidence();
        throw error;
      }
    })();

    delete testRun.pending_evidence;
    delete testRun.pending_process_evidence;
    delete testRun.pending_process_run;
    if (commitResult.stale) {
      cleanupPendingEvidence();
      return {
        success: false,
        stale: true,
        executionId,
        taskId,
        testRun,
        gitStatus,
        gitDiff,
        finalTaskState: commitResult.nextState,
        error: 'STALE_VALIDATION_RESULT',
      };
    }

    return {
      success: commitResult.success,
      executionId,
      taskId,
      testRun,
      gitStatus,
      gitDiff,
      finalTaskState: commitResult.nextState,
      error: !commitResult.success
        ? !gitEvidenceSuccess
          ? 'Git evidence collection failed.'
          : 'Verification tests failed.'
        : undefined,
    };
  }
}
