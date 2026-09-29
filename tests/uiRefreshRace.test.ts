import { describe, expect, it } from 'vitest';
import { isAsyncResponseCurrent, reconcileSelectedId } from '../src/ui/context/OrchestratorContext';

describe('UI refresh identity fences', () => {
  it('rejects an older response after a newer request starts', () => {
    expect(isAsyncResponseCurrent(1, 2, 'TASK-A', 'TASK-A')).toBe(false);
    expect(isAsyncResponseCurrent(2, 2, 'TASK-A', 'TASK-A')).toBe(true);
  });

  it('rejects a response when the selected project or task changed', () => {
    expect(isAsyncResponseCurrent(4, 4, 'PROJECT-A', 'PROJECT-B')).toBe(false);
    expect(isAsyncResponseCurrent(4, 4, 'TASK-A', 'TASK-B')).toBe(false);
  });

  it('keeps an existing selection and falls back deterministically after deletion', () => {
    const rows = [{ id: 'SUB-A' }, { id: 'SUB-B' }];
    expect(reconcileSelectedId('SUB-B', rows)).toBe('SUB-B');
    expect(reconcileSelectedId('SUB-DELETED', rows)).toBe('SUB-A');
    expect(reconcileSelectedId(null, rows)).toBe('SUB-A');
    expect(reconcileSelectedId('SUB-DELETED', [])).toBeNull();
  });

  it('prevents a delayed task snapshot from replacing the latest snapshot', () => {
    let currentRequestId = 1;
    let selectedTaskId = 'TASK-A';
    let appliedSnapshot = 'TASK-A';

    const delayedA = { requestId: 1, taskId: 'TASK-A', snapshot: 'old' };
    currentRequestId = 2;
    selectedTaskId = 'TASK-B';
    const newestB = { requestId: 2, taskId: 'TASK-B', snapshot: 'new' };

    if (isAsyncResponseCurrent(newestB.requestId, currentRequestId, newestB.taskId, selectedTaskId)) {
      appliedSnapshot = newestB.snapshot;
    }
    if (isAsyncResponseCurrent(delayedA.requestId, currentRequestId, delayedA.taskId, selectedTaskId)) {
      appliedSnapshot = delayedA.snapshot;
    }

    expect(appliedSnapshot).toBe('new');
  });
});
