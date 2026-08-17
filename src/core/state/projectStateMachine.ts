import { ProjectStatus } from '../types/domain';

export type ProjectTrigger =
  | 'IMPORT_CONTRACT'
  | 'PLAN_APPROVED'
  | 'START_PROJECT'
  | 'PAUSE'
  | 'RESUME'
  | 'BLOCKER_DETECTED'
  | 'BLOCKER_RESOLVED'
  | 'QUOTA_EXHAUSTED'
  | 'CAPACITY_RESTORED'
  | 'ESCALATE_TO_OWNER'
  | 'OWNER_APPROVED'
  | 'ALL_TASKS_DONE'
  | 'FINAL_PASS'
  | 'FINAL_FIX_REQUIRED'
  | 'FATAL_ERROR'
  | 'CANCEL_PROJECT';

const VALID_PROJECT_TRANSITIONS: Record<ProjectStatus, Partial<Record<ProjectTrigger, ProjectStatus>>> = {
  DRAFT: {
    IMPORT_CONTRACT: 'PLANNING',
    PLAN_APPROVED: 'READY',
    CANCEL_PROJECT: 'CANCELLED',
  },
  PLANNING: {
    PLAN_APPROVED: 'READY',
    CANCEL_PROJECT: 'CANCELLED',
  },
  READY: {
    START_PROJECT: 'RUNNING',
    CANCEL_PROJECT: 'CANCELLED',
  },
  RUNNING: {
    PAUSE: 'PAUSED',
    BLOCKER_DETECTED: 'BLOCKED',
    QUOTA_EXHAUSTED: 'WAITING_FOR_CAPACITY',
    ESCALATE_TO_OWNER: 'WAITING_FOR_OWNER',
    ALL_TASKS_DONE: 'FINAL_REVIEW',
    FATAL_ERROR: 'FAILED',
    CANCEL_PROJECT: 'CANCELLED',
  },
  PAUSED: {
    RESUME: 'RUNNING',
    CANCEL_PROJECT: 'CANCELLED',
  },
  BLOCKED: {
    BLOCKER_RESOLVED: 'RUNNING',
    CANCEL_PROJECT: 'CANCELLED',
  },
  WAITING_FOR_CAPACITY: {
    CAPACITY_RESTORED: 'RUNNING',
    CANCEL_PROJECT: 'CANCELLED',
  },
  WAITING_FOR_OWNER: {
    OWNER_APPROVED: 'RUNNING',
    CANCEL_PROJECT: 'CANCELLED',
  },
  FINAL_REVIEW: {
    FINAL_PASS: 'COMPLETED',
    FINAL_FIX_REQUIRED: 'RUNNING',
    CANCEL_PROJECT: 'CANCELLED',
  },
  COMPLETED: {},
  FAILED: {},
  CANCELLED: {},
};

export class ProjectStateMachine {
  public static canTransition(currentStatus: ProjectStatus, trigger: ProjectTrigger): boolean {
    const transitions = VALID_PROJECT_TRANSITIONS[currentStatus];
    return transitions !== undefined && transitions[trigger] !== undefined;
  }

  public static transition(currentStatus: ProjectStatus, trigger: ProjectTrigger): ProjectStatus {
    const transitions = VALID_PROJECT_TRANSITIONS[currentStatus];
    const nextStatus = transitions ? transitions[trigger] : undefined;

    if (!nextStatus) {
      throw new Error(
        `[ProjectStateMachine] Invalid transition: Cannot apply trigger "${trigger}" from state "${currentStatus}".`
      );
    }

    return nextStatus;
  }
}
