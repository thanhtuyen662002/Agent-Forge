import { Task, TaskState, TaskStateEnum } from '../core/types/domain';

export type TaskLaneId =
  | 'planned'
  | 'coding'
  | 'validating'
  | 'handoff'
  | 'waiting'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface TaskLaneDefinition {
  id: Exclude<TaskLaneId, 'unknown'>;
  states: readonly TaskState[];
}

/**
 * The authoritative presentation partition for the task state machine.
 * Keep every real state in exactly one group; unknown runtime values are
 * routed to the explicit integrity-warning lane by getTaskLaneId().
 */
export const TASK_LANE_STATE_GROUPS: readonly TaskLaneDefinition[] = [
  { id: 'planned', states: ['CREATED', 'PLANNED', 'APPROVED', 'QUEUED'] },
  { id: 'coding', states: ['DISPATCHED', 'CODING', 'PAUSED'] },
  { id: 'validating', states: ['VALIDATING', 'REVIEW_READY', 'REVIEWING', 'FIX_REQUIRED'] },
  { id: 'handoff', states: ['HANDOFF_REQUIRED'] },
  { id: 'waiting', states: ['WAITING_FOR_CAPACITY', 'WAITING_FOR_AUTHORITY'] },
  { id: 'blocked', states: ['BLOCKED', 'NEEDS_HUMAN'] },
  { id: 'completed', states: ['DONE'] },
  { id: 'failed', states: ['FAILED'] },
  { id: 'cancelled', states: ['CANCELLED'] },
];

const laneByState = new Map<string, TaskLaneId>(
  TASK_LANE_STATE_GROUPS.flatMap((group) => group.states.map((state) => [state, group.id] as const)),
);

/** Return a visible lane for both typed states and unexpected runtime values. */
export function getTaskLaneId(state: string): TaskLaneId {
  return laneByState.get(state) ?? 'unknown';
}

/**
 * Count every state deterministically. The UNKNOWN bucket is deliberately
 * retained even when zero so callers cannot accidentally drop an integrity
 * warning when a future state is introduced.
 */
export function getTaskStateCounts(tasks: ReadonlyArray<Pick<Task, 'state'>>): Record<string, number> {
  const counts: Record<string, number> = { UNKNOWN: 0 };
  for (const state of TaskStateEnum.options) counts[state] = 0;
  for (const task of tasks) {
    const key = TaskStateEnum.options.includes(task.state) ? task.state : 'UNKNOWN';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Fail-fast invariant used by regression tests and future UI extensions. */
export function getMissingTaskStates(): TaskState[] {
  const covered = new Set(TASK_LANE_STATE_GROUPS.flatMap((group) => group.states));
  return TaskStateEnum.options.filter((state) => !covered.has(state));
}
