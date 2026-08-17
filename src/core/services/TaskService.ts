import crypto from 'crypto';
import { Repository } from '../database/repositories';
import { EventService } from './EventService';
import { VerificationService } from './VerificationService';
import { ArtifactStore } from './ArtifactStore';
import { GitService } from './GitService';
import { ProgressService } from './ProgressService';
import { TaskStateMachine, TaskTrigger } from '../state/taskStateMachine';
import { ManagerProtocol, CoderProtocol } from '../types/protocols';
import { Task, TestRun, GitStatusSummary, GitDiffSummary } from '../types/domain';

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
  error?: string;
}

export interface ValidationFlowResult {
  success: boolean;
  taskId: string;
  testRun: TestRun;
  gitStatus: GitStatusSummary;
  gitDiff: GitDiffSummary;
  finalTaskState: string;
  error?: string;
}

export class TaskService {
  constructor(
    private repo: Repository,
    private eventService: EventService,
    private verificationService?: VerificationService,
    private artifactStore?: ArtifactStore
  ) {}

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
      max_revisions: 3,
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
    const computedHash = crypto.createHash('sha256').update(rawPayload, 'utf8').digest('hex');

    // 1. Idempotency Check
    const existingMsg = this.repo.getProtocolMessageById(managerMsg.message_id);
    if (existingMsg) {
      return {
        success: true,
        isDuplicate: true,
        message: `Manager decision "${managerMsg.message_id}" was already processed.`,
      };
    }

    if (!managerMsg.task_id) {
      return { success: false, error: 'Protocol message is missing required task_id.' };
    }

    const task = this.repo.getTask(managerMsg.task_id);
    if (!task) {
      return { success: false, error: `Task "${managerMsg.task_id}" does not exist.` };
    }

    // 2. Cross-Project Guard
    if (managerMsg.project_id !== task.project_id) {
      const reason = `Cross-project conflict: Protocol targets project "${managerMsg.project_id}", but task belongs to "${task.project_id}".`;
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
    }

    // 3. Stale State & Revision Guard
    if (managerMsg.expected_task_state && managerMsg.expected_task_state !== task.state) {
      const reason = `Stale state conflict: Manager expected state "${managerMsg.expected_task_state}", but task is in "${task.state}".`;
      this.repo.recordProtocolMessage(
        crypto.randomUUID(),
        managerMsg.message_id,
        'manager.v1',
        task.project_id,
        task.id,
        managerMsg.expected_task_state,
        managerMsg.expected_revision ?? null,
        computedHash,
        rawPayload,
        'REJECTED',
        reason
      );
      return { success: false, error: reason };
    }

    if (
      managerMsg.expected_revision !== null &&
      managerMsg.expected_revision !== undefined &&
      managerMsg.expected_revision !== task.revision_count
    ) {
      const reason = `Stale revision conflict: Manager expected revision ${managerMsg.expected_revision}, but task revision is ${task.revision_count}.`;
      this.repo.recordProtocolMessage(
        crypto.randomUUID(),
        managerMsg.message_id,
        'manager.v1',
        task.project_id,
        task.id,
        managerMsg.expected_task_state ?? null,
        managerMsg.expected_revision,
        computedHash,
        rawPayload,
        'REJECTED',
        reason
      );
      return { success: false, error: reason };
    }

    // 4. Map decision to trigger
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
      default:
        return { success: false, error: `Unsupported decision: ${(managerMsg as any).decision}` };
    }

    // 5. Authoritative Git Base SHA Resolution on EXECUTE
    let boundBaseSha: string | null = task.base_sha;
    if (managerMsg.decision === 'EXECUTE') {
      if (!boundBaseSha) {
        const project = this.repo.getProject(task.project_id);
        if (!project) {
          return { success: false, error: `Project "${task.project_id}" not found.` };
        }

        const headShaRes = await GitService.getHeadSha(project.repository_path);
        if (headShaRes.status !== 'SUCCESS' || !headShaRes.sha) {
          const reason = `Cannot begin coding: Git repository HEAD SHA could not be authoritatively resolved (${headShaRes.errorMessage || 'git rev-parse HEAD failed'}).`;
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
        }
        boundBaseSha = headShaRes.sha;
      }
    }

    // 6. Evaluate state machine transition
    let transitionRes;
    try {
      transitionRes = TaskStateMachine.transition(task.state, trigger, {
        revisionCount: task.revision_count,
        maxRevisions: task.max_revisions,
        pausedFromState: task.paused_from_state,
      });
    } catch (err: any) {
      const reason = `State Machine Error: ${err.message}`;
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
    }

    // 7. Execute atomic database transaction
    const mutate = () => {
      this.repo.updateTaskState(
        task.id,
        transitionRes.nextState,
        transitionRes.pausedFromState,
        transitionRes.incrementRevision
      );

      // Immutably bind base commit SHA if determined
      if (boundBaseSha && boundBaseSha !== task.base_sha) {
        this.repo.updateTaskShas(task.id, boundBaseSha, task.current_sha);
      }

      // Record review entity if this was a review decision
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

      // Update derived progress
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

      // Record in protocol messages ledger
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
    };

    try {
      return this.repo.runInTransaction(mutate);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public applyCoderReport(
    coderMsg: CoderProtocol,
    rawPayload: string
  ): ApplyProtocolResult {
    const computedHash = crypto.createHash('sha256').update(rawPayload, 'utf8').digest('hex');

    // 1. Idempotency Check
    const existingMsg = this.repo.getProtocolMessageById(coderMsg.message_id);
    if (existingMsg) {
      return {
        success: true,
        isDuplicate: true,
        message: `Coder report "${coderMsg.message_id}" was already processed.`,
      };
    }

    const task = this.repo.getTask(coderMsg.task_id);
    if (!task) {
      return { success: false, error: `Task "${coderMsg.task_id}" does not exist.` };
    }

    // 2. Cross-Project Guard
    if (coderMsg.project_id !== task.project_id) {
      const reason = `Cross-project conflict: Protocol targets project "${coderMsg.project_id}", but task belongs to "${task.project_id}".`;
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
    }

    // 3. Stale State & Revision Guard
    if (coderMsg.expected_task_state && coderMsg.expected_task_state !== task.state) {
      const reason = `Stale state conflict: Coder expected state "${coderMsg.expected_task_state}", but task is in "${task.state}".`;
      this.repo.recordProtocolMessage(
        crypto.randomUUID(),
        coderMsg.message_id,
        'coder.v1',
        task.project_id,
        task.id,
        coderMsg.expected_task_state,
        coderMsg.expected_revision ?? null,
        computedHash,
        rawPayload,
        'REJECTED',
        reason
      );
      return { success: false, error: reason };
    }

    if (
      coderMsg.expected_revision !== null &&
      coderMsg.expected_revision !== undefined &&
      coderMsg.expected_revision !== task.revision_count
    ) {
      const reason = `Stale revision conflict: Coder expected revision ${coderMsg.expected_revision}, but task revision is ${task.revision_count}.`;
      this.repo.recordProtocolMessage(
        crypto.randomUUID(),
        coderMsg.message_id,
        'coder.v1',
        task.project_id,
        task.id,
        coderMsg.expected_task_state ?? null,
        coderMsg.expected_revision,
        computedHash,
        rawPayload,
        'REJECTED',
        reason
      );
      return { success: false, error: reason };
    }

    // 4. Determine state machine trigger based on discrete coder status
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

    let transitionRes;
    try {
      transitionRes = TaskStateMachine.transition(task.state, trigger, {
        revisionCount: task.revision_count,
        maxRevisions: task.max_revisions,
        pausedFromState: task.paused_from_state,
      });
    } catch (err: any) {
      const reason = `State Machine Error: ${err.message}`;
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
    }

    const mutate = () => {
      this.repo.updateTaskState(
        task.id,
        transitionRes.nextState,
        transitionRes.pausedFromState,
        transitionRes.incrementRevision
      );

      // Record in protocol ledger
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
    };

    try {
      return this.repo.runInTransaction(mutate);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public startReview(taskId: string, expectedProjectId?: string): { success: boolean; task?: Task; error?: string } {
    const task = this.repo.getTask(taskId);
    if (!task) {
      return { success: false, error: `Task ${taskId} not found.` };
    }

    // Cross-project guard
    if (expectedProjectId && task.project_id !== expectedProjectId) {
      return {
        success: false,
        error: `Cross-project guard: Task ${taskId} belongs to "${task.project_id}", not "${expectedProjectId}".`,
      };
    }

    if (task.state === 'REVIEWING') {
      return { success: true, task };
    }

    if (task.state !== 'REVIEW_READY') {
      return {
        success: false,
        error: `Cannot start review: Task is in state "${task.state}", expected "REVIEW_READY".`,
      };
    }

    const trans = TaskStateMachine.transition(task.state, 'START_REVIEW', {
      revisionCount: task.revision_count,
      maxRevisions: task.max_revisions,
    });

    const mutate = () => {
      this.repo.updateTaskState(task.id, trans.nextState);
      this.eventService.record(
        task.project_id,
        'REVIEW_STARTED',
        `Review started for task ${task.id}. State: REVIEWING.`,
        { fromState: task.state, toState: trans.nextState },
        task.id
      );
      return { success: true, task: this.repo.getTask(task.id)! };
    };

    try {
      return this.repo.runInTransaction(mutate);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public async executeValidationFlow(
    taskId: string,
    commandConfigId?: string,
    expectedProjectId?: string
  ): Promise<ValidationFlowResult> {
    const task = this.repo.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found.`);
    }

    // Cross-project guard
    if (expectedProjectId && task.project_id !== expectedProjectId) {
      throw new Error(
        `Cross-project guard: Task ${taskId} belongs to "${task.project_id}", not "${expectedProjectId}".`
      );
    }

    const project = this.repo.getProject(task.project_id);
    if (!project) {
      throw new Error(`Project ${task.project_id} not found.`);
    }

    const repoPath = project.repository_path;

    // 1. Gather authoritative Git status & diff
    const gitStatus = await GitService.getStatus(repoPath);
    const gitDiff = await GitService.getDiff(repoPath, task.base_sha);
    const headShaRes = await GitService.getHeadSha(repoPath);
    const currentSha = headShaRes.status === 'SUCCESS' ? headShaRes.sha : null;

    if (this.artifactStore) {
      if (gitStatus.status === 'SUCCESS') {
        const ev = this.artifactStore.store(
          crypto.randomUUID(),
          project.id,
          task.id,
          null,
          'GIT_STATUS',
          `Git Status: ${gitStatus.isClean ? 'Clean' : 'Modified'} on ${gitStatus.branch}`,
          JSON.stringify(gitStatus, null, 2),
          'application/json'
        );
        this.repo.createEvidence(ev);
      }

      if (gitDiff.status === 'SUCCESS' && gitDiff.diffContent) {
        const ev = this.artifactStore.store(
          crypto.randomUUID(),
          project.id,
          task.id,
          null,
          'GIT_DIFF',
          `Git Diff: ${gitDiff.filesChanged.length} files changed`,
          gitDiff.diffContent,
          'text/x-diff'
        );
        this.repo.createEvidence(ev);
      }
    }

    // 2. Execute configured test verification suite
    if (!this.verificationService) {
      throw new Error('VerificationService not wired into TaskService.');
    }

    const testRun = await this.verificationService.runTests(
      project.id,
      task.id,
      null,
      repoPath,
      commandConfigId
    );

    // 3. Authoritative Evidence Gate: Require Git Success AND Test Exit Code 0
    const gitEvidenceSuccess =
      gitStatus.status === 'SUCCESS' &&
      gitDiff.status === 'SUCCESS' &&
      headShaRes.status === 'SUCCESS';

    const verificationPassed = gitEvidenceSuccess && testRun.exit_code === 0;

    const currentTask = this.repo.getTask(task.id)!;
    let nextState = currentTask.state;

    if (verificationPassed) {
      // Verification & Git Evidence Passed -> Advance to REVIEW_READY
      const trans = TaskStateMachine.transition(currentTask.state, 'EVIDENCE_GATHERED', {
        revisionCount: currentTask.revision_count,
        maxRevisions: currentTask.max_revisions,
      });
      this.repo.updateTaskState(task.id, trans.nextState);
      if (currentSha) {
        this.repo.updateTaskShas(task.id, task.base_sha, currentSha);
      }
      nextState = trans.nextState;

      this.eventService.record(
        project.id,
        'VERIFICATION_PASSED',
        `Task ${task.id} verification tests passed (${testRun.passed_count} passed). Transitioned to REVIEW_READY.`,
        { passed: testRun.passed_count, exitCode: testRun.exit_code, sha: currentSha },
        task.id
      );
    } else {
      // Verification or Git Evidence Failed -> Do NOT advance to REVIEW_READY
      const trans = TaskStateMachine.transition(currentTask.state, 'TESTS_FAILED', {
        revisionCount: currentTask.revision_count,
        maxRevisions: currentTask.max_revisions,
      });
      this.repo.updateTaskState(task.id, trans.nextState, null, trans.incrementRevision);
      nextState = trans.nextState;

      const failureReason = !gitEvidenceSuccess
        ? `Authoritative Git evidence failed (Status: ${gitStatus.status}, Diff: ${gitDiff.status}, SHA: ${headShaRes.status}).`
        : `Verification tests failed (exit code ${testRun.exit_code}, ${testRun.failed_count} failures).`;

      this.eventService.record(
        project.id,
        'VERIFICATION_FAILED',
        `Task ${task.id} verification failed: ${failureReason}. Returned to ${trans.nextState}.`,
        {
          gitStatus: gitStatus.status,
          gitDiff: gitDiff.status,
          testExitCode: testRun.exit_code,
          failedCount: testRun.failed_count,
        },
        task.id
      );
    }

    // Update derived progress strictly from verified evidence
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

    return {
      success: verificationPassed,
      taskId: task.id,
      testRun,
      gitStatus,
      gitDiff,
      finalTaskState: nextState,
      error: !verificationPassed
        ? !gitEvidenceSuccess
          ? 'Git evidence collection failed.'
          : 'Verification tests failed.'
        : undefined,
    };
  }
}
