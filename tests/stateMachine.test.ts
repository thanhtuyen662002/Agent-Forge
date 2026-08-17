import { describe, it, expect } from 'vitest';
import { ProjectStateMachine } from '../src/core/state/projectStateMachine';
import { TaskStateMachine } from '../src/core/state/taskStateMachine';

describe('ProjectStateMachine', () => {
  it('should transition through normal project lifecycle', () => {
    let state = ProjectStateMachine.transition('DRAFT', 'IMPORT_CONTRACT');
    expect(state).toBe('PLANNING');

    state = ProjectStateMachine.transition(state, 'PLAN_APPROVED');
    expect(state).toBe('READY');

    state = ProjectStateMachine.transition(state, 'START_PROJECT');
    expect(state).toBe('RUNNING');

    state = ProjectStateMachine.transition(state, 'ALL_TASKS_DONE');
    expect(state).toBe('FINAL_REVIEW');

    state = ProjectStateMachine.transition(state, 'FINAL_PASS');
    expect(state).toBe('COMPLETED');
  });

  it('should handle pause and resume correctly', () => {
    let state = ProjectStateMachine.transition('RUNNING', 'PAUSE');
    expect(state).toBe('PAUSED');

    state = ProjectStateMachine.transition(state, 'RESUME');
    expect(state).toBe('RUNNING');
  });

  it('should reject invalid transitions', () => {
    expect(() => ProjectStateMachine.transition('DRAFT', 'START_PROJECT')).toThrow();
    expect(() => ProjectStateMachine.transition('COMPLETED', 'START_PROJECT')).toThrow();
  });
});

describe('TaskStateMachine', () => {
  it('should transition through happy path to completion', () => {
    let res = TaskStateMachine.transition('CREATED', 'DECOMPOSE');
    expect(res.nextState).toBe('PLANNED');

    res = TaskStateMachine.transition(res.nextState, 'APPROVE');
    expect(res.nextState).toBe('APPROVED');

    res = TaskStateMachine.transition(res.nextState, 'ENQUEUE');
    expect(res.nextState).toBe('QUEUED');

    res = TaskStateMachine.transition(res.nextState, 'DISPATCH');
    expect(res.nextState).toBe('DISPATCHED');

    res = TaskStateMachine.transition(res.nextState, 'START_CODING');
    expect(res.nextState).toBe('CODING');

    res = TaskStateMachine.transition(res.nextState, 'SUBMIT_REPORT');
    expect(res.nextState).toBe('VALIDATING');

    res = TaskStateMachine.transition(res.nextState, 'EVIDENCE_GATHERED');
    expect(res.nextState).toBe('REVIEW_READY');

    res = TaskStateMachine.transition(res.nextState, 'START_REVIEW');
    expect(res.nextState).toBe('REVIEWING');

    res = TaskStateMachine.transition(res.nextState, 'PASS_VERDICT');
    expect(res.nextState).toBe('DONE');
  });

  it('should record paused_from_state and resume to exact prior state', () => {
    const pauseRes = TaskStateMachine.transition('CODING', 'PAUSE');
    expect(pauseRes.nextState).toBe('PAUSED');
    expect(pauseRes.pausedFromState).toBe('CODING');

    const resumeRes = TaskStateMachine.transition(pauseRes.nextState, 'RESUME', {
      pausedFromState: pauseRes.pausedFromState,
    });
    expect(resumeRes.nextState).toBe('CODING');
    expect(resumeRes.pausedFromState).toBeNull();
  });

  it('should escalate to NEEDS_HUMAN when max revisions exceeded', () => {
    // 1st revision (count: 0 -> 1)
    let res = TaskStateMachine.transition('REVIEWING', 'FIX_VERDICT', { revisionCount: 0, maxRevisions: 3 });
    expect(res.nextState).toBe('CODING');
    expect(res.incrementRevision).toBe(true);

    // 2nd revision (count: 1 -> 2)
    res = TaskStateMachine.transition('REVIEWING', 'FIX_VERDICT', { revisionCount: 1, maxRevisions: 3 });
    expect(res.nextState).toBe('CODING');
    expect(res.incrementRevision).toBe(true);

    // 3rd revision reaches maxRevisions (count: 2 + 1 >= 3 -> NEEDS_HUMAN)
    res = TaskStateMachine.transition('REVIEWING', 'FIX_VERDICT', { revisionCount: 2, maxRevisions: 3 });
    expect(res.nextState).toBe('NEEDS_HUMAN');
    expect(res.incrementRevision).toBe(true);
  });
});
