import crypto from 'crypto';
import { Repository } from '../database/repositories';
import { EventService } from './EventService';
import { ProgressService } from './ProgressService';
import { GitService } from './GitService';
import { VerificationService } from './VerificationService';
import { ArtifactStore } from './ArtifactStore';
import { TaskStateMachine, TaskTrigger } from '../state/taskStateMachine';
import { ManagerProtocol, CoderProtocol } from '../types/protocols';
import { Task, TestRun } from '../types/domain';
import { DatabaseEngine } from '../database/db';

export interface ApplyProtocolResult {
  success: boolean;
  message?: string;
  task?: Task;
  error?: string;
  isDuplicate?: boolean;
}

export interface ValidationFlowResult {
  success: boolean;
  taskId: string;
  testRun: TestRun;
  gitStatus: any;
  gitDiff: any;
  finalTaskState: string;
  error?: string;
}

export class TaskService {
  constructor(
    private repo: Repository,
    private eventService: EventService,
    private verificationService?: VerificationService,
    private artifactStore?: ArtifactStore,
    private dbEngine?: DatabaseEngine
  ) {}

  public applyManagerDecision(
    managerMsg: ManagerProtocol,
    rawPayload: string
  ): ApplyProtocolResult {
    const computedHash = crypto.createHash('sha256').update(rawPayload, 'utf8').digest('hex');

    // 1. Idempotency Check
    const existingMsg = this.repo.getProtocolMessageById(managerMsg.message_id);
    if (existingMsg) {
      return {
        success: true,
        isDuplicate: true,
        message: `Message "${managerMsg.message_id}" was already processed.`,
      };
    }

    // 2. Locate task
    if (!managerMsg.task_id) {
      this.repo.recordProtocolMessage(
        crypto.randomUUID(),
        managerMsg.message_id,
        'manager.v1',
        managerMsg.project_id,
        null,
        null,
        null,
        computedHash,
        rawPayload,
        'APPLIED'
      );
      return { success: true, message: 'Manager general decision recorded.' };
    }

    const task = this.repo.getTask(managerMsg.task_id);
    if (!task) {
      this.repo.recordProtocolMessage(
        crypto.randomUUID(),
        managerMsg.message_id,
        'manager.v1',
        managerMsg.project_id,
        managerMsg.task_id,
        managerMsg.expected_task_state ?? null,
        managerMsg.expected_revision ?? null,
        computedHash,
        rawPayload,
        'REJECTED',
        `Task "${managerMsg.task_id}" not found.`
      );
      return { success: false, error: `Task "${managerMsg.task_id}" does not exist.` };
    }

    // 3. Cross-Project Guard
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

    // 4. Stale-State and Revision Guard
    if (managerMsg.expected_task_state && managerMsg.expected_task_state !== task.state) {
      const reason = `Stale state conflict: Manager expected state "${managerMsg.expected_task_state}", but task is in "${task.state}".`;
      this.repo.recordProtocolMessage(
        crypto.randomUUID(),
        managerMsg.message_id,
        'manager.v1',
        managerMsg.project_id,
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
      const reason = `Stale revision conflict: Manager expected revision ${managerMsg.expected_revision}, but current task revision is ${task.revision_count}.`;
      this.repo.recordProtocolMessage(
        crypto.randomUUID(),
        managerMsg.message_id,
        'manager.v1',
        managerMsg.project_id,
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

    // 5. Map Decision to State Machine Trigger
    let trigger: TaskTrigger;
    switch (managerMsg.decision) {
      case 'EXECUTE':
        trigger = task.state === 'APPROVED' ? 'ENQUEUE' : 'START_CODING';
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
      case 'PAUSE':
        trigger = 'PAUSE';
        break;
      case 'CANCEL':
        trigger = 'CANCEL';
        break;
      default:
        trigger = 'START_CODING';
    }

    // 6. Atomic Transaction Mutation
    const mutate = () => {
      const transitionRes = TaskStateMachine.transition(task.state, trigger, {
        revisionCount: task.revision_count,
        maxRevisions: task.max_revisions,
        pausedFromState: task.paused_from_state,
      });

      this.repo.updateTaskState(
        task.id,
        transitionRes.nextState,
        transitionRes.pausedFromState,
        transitionRes.incrementRevision
      );

      // Record Review issues if FIX_REQUIRED or PASS
      if (['PASS', 'FIX_REQUIRED'].includes(managerMsg.decision)) {
        this.repo.createReview({
          id: crypto.randomUUID(),
          task_id: task.id,
          attempt_id: null,
          reviewer_agent_id: null,
          verdict: managerMsg.decision === 'PASS' ? 'PASS' : 'FIX_REQUIRED',
          summary: `Manager review verdict: ${managerMsg.decision}`,
          issues: managerMsg.review_issues.map((iss: any) => ({
            id: crypto.randomUUID(),
            review_id: '',
            severity: iss.severity,
            title: iss.title,
            file_path: iss.file_path ?? null,
            line_number: iss.line_number ?? null,
            description: iss.description,
            resolved: false,
          })),
          created_at: new Date().toISOString(),
        });
      }

      // Update derived progress
      const updatedTask = this.repo.getTask(task.id)!;
      const progress = ProgressService.calculateTaskProgress(updatedTask);
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
        { decision: managerMsg.decision, fromState: task.state, toState: transitionRes.nextState },
        task.id
      );

      return {
        success: true,
        message: `Task ${task.id} transitioned to ${transitionRes.nextState}.`,
        task: this.repo.getTask(task.id)!,
      };
    };

    try {
      if (this.dbEngine) {
        return this.dbEngine.runInTransaction(mutate);
      }
      return mutate();
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

    // 4. Atomic Transition to VALIDATING
    const mutate = () => {
      const transitionRes = TaskStateMachine.transition(task.state, 'SUBMIT_REPORT', {
        revisionCount: task.revision_count,
        maxRevisions: task.max_revisions,
      });

      this.repo.updateTaskState(task.id, transitionRes.nextState);

      // Record protocol message
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
        `Coder report received for task ${task.id}. Status: ${coderMsg.status}. Transitioned to VALIDATING.`,
        { status: coderMsg.status, claimedFiles: coderMsg.files_claimed_changed },
        task.id
      );

      const updatedTask = this.repo.getTask(task.id)!;
      const progress = ProgressService.calculateTaskProgress(updatedTask);
      this.repo.updateTaskProgressCache(task.id, progress.percent);

      return {
        success: true,
        message: `Coder report processed. Task ${task.id} entered VALIDATING state.`,
        task: this.repo.getTask(task.id)!,
      };
    };

    try {
      if (this.dbEngine) {
        return this.dbEngine.runInTransaction(mutate);
      }
      return mutate();
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public async executeValidationFlow(
    taskId: string,
    commandConfigId?: string
  ): Promise<ValidationFlowResult> {
    const task = this.repo.getTask(taskId);
    if (!task) {
      throw new Error(`Task "${taskId}" not found.`);
    }

    const project = this.repo.getProject(task.project_id);
    if (!project) {
      throw new Error(`Project "${task.project_id}" not found.`);
    }

    const repoPath = project.repository_path;

    // Ensure task is in VALIDATING state
    if (task.state === 'CODING') {
      const trans = TaskStateMachine.transition(task.state, 'SUBMIT_REPORT', {
        revisionCount: task.revision_count,
        maxRevisions: task.max_revisions,
      });
      this.repo.updateTaskState(task.id, trans.nextState);
    }

    // 1. Gather Authoritative Git Evidence
    const gitStatus = await GitService.getStatus(repoPath);
    const gitDiff = await GitService.getDiff(repoPath, task.base_sha);
    const headShaRes = await GitService.getHeadSha(repoPath);
    const currentSha = headShaRes.status === 'SUCCESS' && headShaRes.sha ? headShaRes.sha : null;

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

    // 3. Evaluate verification pass/fail gate
    const currentTask = this.repo.getTask(task.id)!;
    let nextState = currentTask.state;

    if (testRun.exit_code === 0) {
      // Verification Passed -> Advance to REVIEW_READY
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
        { passed: testRun.passed_count, exitCode: testRun.exit_code },
        task.id
      );
    } else {
      // Verification Failed -> Do NOT advance to REVIEW_READY
      const trans = TaskStateMachine.transition(currentTask.state, 'TESTS_FAILED', {
        revisionCount: currentTask.revision_count,
        maxRevisions: currentTask.max_revisions,
      });
      this.repo.updateTaskState(task.id, trans.nextState, null, trans.incrementRevision);
      nextState = trans.nextState;

      this.eventService.record(
        project.id,
        'VERIFICATION_FAILED',
        `Task ${task.id} verification tests failed (exit code ${testRun.exit_code}, ${testRun.failed_count} failures). Returned to ${trans.nextState}.`,
        { failed: testRun.failed_count, exitCode: testRun.exit_code },
        task.id
      );
    }

    // Update derived progress
    const finalTask = this.repo.getTask(task.id)!;
    const progress = ProgressService.calculateTaskProgress(finalTask, {
      hasGitDiff: gitDiff.status === 'SUCCESS' && gitDiff.filesChanged.length > 0,
      hasEvidence: true,
      testsPassed: testRun.exit_code === 0,
    });
    this.repo.updateTaskProgressCache(task.id, progress.percent);

    return {
      success: testRun.exit_code === 0,
      taskId: task.id,
      testRun,
      gitStatus,
      gitDiff,
      finalTaskState: nextState,
    };
  }
}
