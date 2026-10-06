import { describe, expect, it } from 'vitest';
import { TaskStateEnum } from '../src/core/types/domain';
import {
  getMissingTaskStates,
  getTaskLaneId,
  getTaskStateCounts,
  TASK_LANE_STATE_GROUPS,
} from '../src/ui/taskStatePresentation';

describe('task state presentation partition', () => {
  it('assigns every current TaskState to exactly one visible lane', () => {
    expect(getMissingTaskStates()).toEqual([]);
    const assignments = new Map<string, string>();
    for (const group of TASK_LANE_STATE_GROUPS) {
      for (const state of group.states) {
        expect(assignments.has(state)).toBe(false);
        assignments.set(state, group.id);
      }
    }
    expect(assignments.size).toBe(TaskStateEnum.options.length);
    expect(getTaskLaneId('HANDOFF_REQUIRED')).toBe('handoff');
    expect(getTaskLaneId('WAITING_FOR_AUTHORITY')).toBe('waiting');
    expect(getTaskLaneId('FAILED')).toBe('failed');
    expect(getTaskLaneId('CANCELLED')).toBe('cancelled');
    expect(getTaskLaneId('future-state')).toBe('unknown');
  });

  it('counts omitted, terminal, and unknown runtime states without dropping them', () => {
    const counts = getTaskStateCounts([
      { state: 'HANDOFF_REQUIRED' },
      { state: 'WAITING_FOR_CAPACITY' },
      { state: 'FAILED' },
      { state: 'CANCELLED' },
      { state: 'future-state' as never },
    ]);
    expect(counts.HANDOFF_REQUIRED).toBe(1);
    expect(counts.WAITING_FOR_CAPACITY).toBe(1);
    expect(counts.FAILED).toBe(1);
    expect(counts.CANCELLED).toBe(1);
    expect(counts.UNKNOWN).toBe(1);
  });
});
