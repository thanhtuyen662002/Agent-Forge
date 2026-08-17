import { describe, it, expect } from 'vitest';
import { ProgressService } from '../src/core/services/ProgressService';
import { Task } from '../src/core/types/domain';

describe('ProgressService Measurable Evidence Gates', () => {
  const baseTask: Task = {
    id: 'TSK-1',
    project_id: 'PROJ-1',
    milestone_id: null,
    title: 'Test Task',
    description: null,
    state: 'CREATED',
    paused_from_state: null,
    priority: 'MEDIUM',
    risk: 'MEDIUM',
    assigned_agent_id: null,
    revision_count: 0,
    max_revisions: 3,
    base_sha: null,
    current_sha: null,
    progress_cache_percent: 0,
    progress_computed_at: null,
    acceptance_criteria: ['Crit 1'],
    constraints: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  it('should return 0% for newly created task', () => {
    const res = ProgressService.calculateTaskProgress(baseTask);
    expect(res.percent).toBe(0);
    expect(res.breakdown.analysisAndPlanning).toBe(0);
  });

  it('should compute progress accurately for coding phase with verified git diff', () => {
    const codingTask: Task = { ...baseTask, state: 'CODING', current_sha: 'a1b2c3d' };
    const res = ProgressService.calculateTaskProgress(codingTask, { hasGitDiff: true });
    // Planning (10) + Implementation (40) = 50%
    expect(res.percent).toBe(50);
    expect(res.breakdown.implementation).toBe(40);
  });

  it('should NOT award full implementation or evidence when tests pass but git diff is missing', () => {
    const validatingTask: Task = { ...baseTask, state: 'VALIDATING', current_sha: null };
    const res = ProgressService.calculateTaskProgress(validatingTask, {
      hasGitDiff: false,
      testsPassed: true,
      hasEvidence: false,
    });
    // Planning (10) + In-flight (10) + Tests (20) = 40% (NO fake 40% implementation or evidence awarded)
    expect(res.breakdown.implementation).toBe(10);
    expect(res.breakdown.evidenceGathered).toBe(0);
    expect(res.breakdown.targetedTesting).toBe(20);
    expect(res.percent).toBe(40);
  });

  it('should NOT award lint pass when task is DONE if lint was never executed', () => {
    const doneTask: Task = { ...baseTask, state: 'DONE', current_sha: 'a1b2c3d' };
    const res = ProgressService.calculateTaskProgress(doneTask, {
      hasGitDiff: true,
      testsPassed: true,
      lintPassed: false, // Lint was not configured or not run
      hasEvidence: true,
    });
    // Planning (10) + Implementation (40) + Tests (20) + Evidence (5) + ManagerReview (10) = 85%
    expect(res.breakdown.regressionAndLint).toBe(0);
    expect(res.percent).toBe(85);
  });

  it('should award 100% only when ALL measurable gates including lint are verified', () => {
    const doneTask: Task = { ...baseTask, state: 'DONE', current_sha: 'a1b2c3d' };
    const res = ProgressService.calculateTaskProgress(doneTask, {
      hasGitDiff: true,
      testsPassed: true,
      lintPassed: true,
      hasEvidence: true,
    });
    // Planning (10) + Implementation (40) + Tests (20) + Lint (15) + Evidence (5) + ManagerReview (10) = 100%
    expect(res.percent).toBe(100);
    expect(res.breakdown.regressionAndLint).toBe(15);
  });

  it('should aggregate project progress accurately across tasks', () => {
    const t1 = { ...baseTask, progress_cache_percent: 50 };
    const t2 = { ...baseTask, progress_cache_percent: 100 };
    const avg = ProgressService.calculateProjectProgress([t1, t2]);
    expect(avg).toBe(75);
  });
});
