import { TaskState, TaskPausedFromState } from '../types/domain';

export type TaskTrigger =
  | 'DECOMPOSE'
  | 'APPROVE'
  | 'ENQUEUE'
  | 'DISPATCH'
  | 'START_CODING'
  | 'SUBMIT_REPORT'
  | 'EVIDENCE_GATHERED'
  | 'START_REVIEW'
  | 'PASS_VERDICT'
  | 'FIX_VERDICT'
  | 'MAX_REVISIONS_EXCEEDED'
  | 'QUOTA_EXHAUSTED'
  | 'HANDOFF_SUBMITTED'
  | 'PAUSE'
  | 'RESUME'
  | 'SET_BLOCKED'
  | 'CLEAR_BLOCKED'
  | 'OWNER_RESOLVE'
  | 'FATAL_FAILURE'
  | 'CANCEL';

export interface TaskTransitionResult {
  nextState: TaskState;
  pausedFromState: TaskPausedFromState | null;
  incrementRevision: boolean;
}

export class TaskStateMachine {
  public static transition(
    currentState: TaskState,
    trigger: TaskTrigger,
    options: {
      pausedFromState?: TaskPausedFromState | null;
      revisionCount?: number;
      maxRevisions?: number;
    } = {}
  ): TaskTransitionResult {
    const revisionCount = options.revisionCount ?? 0;
    const maxRevisions = options.maxRevisions ?? 3;

    // Handle Pause
    if (trigger === 'PAUSE') {
      if (['DISPATCHED', 'CODING', 'VALIDATING', 'REVIEWING'].includes(currentState)) {
        return {
          nextState: 'PAUSED',
          pausedFromState: currentState as TaskPausedFromState,
          incrementRevision: false,
        };
      }
      throw new Error(`[TaskStateMachine] Cannot pause task from state "${currentState}".`);
    }

    // Handle Resume
    if (trigger === 'RESUME') {
      if (currentState !== 'PAUSED') {
        throw new Error(`[TaskStateMachine] Cannot resume task that is not in PAUSED state (currently "${currentState}").`);
      }
      const restoreState = options.pausedFromState ?? 'CODING';
      return {
        nextState: restoreState,
        pausedFromState: null,
        incrementRevision: false,
      };
    }

    // Handle Standard Transitions
    switch (currentState) {
      case 'CREATED':
        if (trigger === 'DECOMPOSE') return { nextState: 'PLANNED', pausedFromState: null, incrementRevision: false };
        if (trigger === 'CANCEL') return { nextState: 'CANCELLED', pausedFromState: null, incrementRevision: false };
        break;

      case 'PLANNED':
        if (trigger === 'APPROVE') return { nextState: 'APPROVED', pausedFromState: null, incrementRevision: false };
        if (trigger === 'START_CODING') return { nextState: 'CODING', pausedFromState: null, incrementRevision: false };
        if (trigger === 'CANCEL') return { nextState: 'CANCELLED', pausedFromState: null, incrementRevision: false };
        break;

      case 'APPROVED':
        if (trigger === 'ENQUEUE') return { nextState: 'QUEUED', pausedFromState: null, incrementRevision: false };
        if (trigger === 'DISPATCH') return { nextState: 'DISPATCHED', pausedFromState: null, incrementRevision: false };
        if (trigger === 'START_CODING') return { nextState: 'CODING', pausedFromState: null, incrementRevision: false };
        if (trigger === 'CANCEL') return { nextState: 'CANCELLED', pausedFromState: null, incrementRevision: false };
        break;

      case 'QUEUED':
        if (trigger === 'DISPATCH') return { nextState: 'DISPATCHED', pausedFromState: null, incrementRevision: false };
        if (trigger === 'CANCEL') return { nextState: 'CANCELLED', pausedFromState: null, incrementRevision: false };
        break;

      case 'DISPATCHED':
        if (trigger === 'START_CODING') return { nextState: 'CODING', pausedFromState: null, incrementRevision: false };
        if (trigger === 'CANCEL') return { nextState: 'CANCELLED', pausedFromState: null, incrementRevision: false };
        break;

      case 'CODING':
        if (trigger === 'SUBMIT_REPORT') return { nextState: 'VALIDATING', pausedFromState: null, incrementRevision: false };
        if (trigger === 'QUOTA_EXHAUSTED') return { nextState: 'HANDOFF_REQUIRED', pausedFromState: null, incrementRevision: false };
        if (trigger === 'SET_BLOCKED') return { nextState: 'BLOCKED', pausedFromState: null, incrementRevision: false };
        if (trigger === 'FATAL_FAILURE') return { nextState: 'FAILED', pausedFromState: null, incrementRevision: false };
        if (trigger === 'CANCEL') return { nextState: 'CANCELLED', pausedFromState: null, incrementRevision: false };
        break;

      case 'VALIDATING':
        if (trigger === 'EVIDENCE_GATHERED') return { nextState: 'REVIEW_READY', pausedFromState: null, incrementRevision: false };
        if (trigger === 'FATAL_FAILURE') return { nextState: 'FAILED', pausedFromState: null, incrementRevision: false };
        break;

      case 'REVIEW_READY':
        if (trigger === 'START_REVIEW') return { nextState: 'REVIEWING', pausedFromState: null, incrementRevision: false };
        break;

      case 'REVIEWING':
        if (trigger === 'PASS_VERDICT') return { nextState: 'DONE', pausedFromState: null, incrementRevision: false };
        if (trigger === 'FIX_VERDICT') {
          if (revisionCount + 1 >= maxRevisions) {
            return { nextState: 'NEEDS_HUMAN', pausedFromState: null, incrementRevision: true };
          }
          return { nextState: 'CODING', pausedFromState: null, incrementRevision: true };
        }
        if (trigger === 'MAX_REVISIONS_EXCEEDED') return { nextState: 'NEEDS_HUMAN', pausedFromState: null, incrementRevision: false };
        break;

      case 'FIX_REQUIRED':
        if (trigger === 'START_CODING') return { nextState: 'CODING', pausedFromState: null, incrementRevision: false };
        break;

      case 'HANDOFF_REQUIRED':
        if (trigger === 'HANDOFF_SUBMITTED') return { nextState: 'QUEUED', pausedFromState: null, incrementRevision: false };
        break;

      case 'BLOCKED':
        if (trigger === 'CLEAR_BLOCKED') return { nextState: 'CODING', pausedFromState: null, incrementRevision: false };
        if (trigger === 'CANCEL') return { nextState: 'CANCELLED', pausedFromState: null, incrementRevision: false };
        break;

      case 'NEEDS_HUMAN':
        if (trigger === 'OWNER_RESOLVE') return { nextState: 'APPROVED', pausedFromState: null, incrementRevision: false };
        if (trigger === 'CANCEL') return { nextState: 'CANCELLED', pausedFromState: null, incrementRevision: false };
        break;

      case 'DONE':
      case 'FAILED':
      case 'CANCELLED':
        break;
    }

    throw new Error(
      `[TaskStateMachine] Invalid transition: Cannot apply trigger "${trigger}" from state "${currentState}".`
    );
  }
}
