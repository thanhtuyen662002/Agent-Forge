import crypto from 'crypto';
import { Repository } from '../database/repositories';
import { EventService } from './EventService';
import { ProgressService } from './ProgressService';
import { TaskStateMachine, TaskTrigger } from '../state/taskStateMachine';
import { ManagerProtocol, CoderProtocol } from '../types/protocols';
import { Task, TaskState } from '../types/domain';

export interface ApplyProtocolResult {
  success: boolean;
  message?: string;
  task?: Task;
  error?: string;
  isDuplicate?: boolean;
}

export class TaskService {
  constructor(
    private repo: Repository,
    private eventService: EventService
  ) {}

  public applyManagerDecision(
    managerMsg: ManagerProtocol,
    rawPayload: string,
    payloadHash: string
  ): ApplyProtocolResult {
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
      // General manager decision / task creation
      this.repo.recordProtocolMessage(
        crypto.randomUUID(),
        managerMsg.message_id,
        'manager.v1',
        managerMsg.project_id,
        null,
        null,
        null,
        payloadHash,
        rawPayload,
        'APPLIED'
      );
      return { success: true, message: 'Manager decision recorded.' };
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
        payloadHash,
        rawPayload,
        'REJECTED',
        `Task "${managerMsg.task_id}" not found.`
      );
      return { success: false, error: `Task "${managerMsg.task_id}" does not exist.` };
    }

    // 3. Stale-State and Revision Guard
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
        payloadHash,
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
        payloadHash,
        rawPayload,
        'REJECTED',
        reason
      );
      return { success: false, error: reason };
    }

    // 4. Map Decision to State Machine Trigger
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

    // 5. Apply State Transition
    try {
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
        payloadHash,
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
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public applyCoderReport(
    coderMsg: CoderProtocol,
    rawPayload: string,
    payloadHash: string
  ): ApplyProtocolResult {
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

    // 2. Stale State & Revision Guard
    if (coderMsg.expected_task_state && coderMsg.expected_task_state !== task.state) {
      const reason = `Stale state conflict: Coder expected state "${coderMsg.expected_task_state}", but task is in "${task.state}".`;
      return { success: false, error: reason };
    }

    // 3. Transition to VALIDATING
    try {
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
        payloadHash,
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
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
