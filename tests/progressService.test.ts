import { describe, it, expect } from 'vitest';
import { ProgressService } from '../src/core/services/ProgressService';
import { Task } from '../src/core/types/domain';

describe('ProgressService', () => {
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
  });

  it('should compute progress deterministically for coding phase with git diff', () => {
    const codingTask: Task = { ...baseTask, state: 'CODING', current_sha: 'a1b2c3d' };
    const res = ProgressService.calculateTaskProgress(codingTask, { hasGitDiff: true });
    // Planning (10) + Implementation (40) = 50%
    expect(res.percent).toBe(50);
  });

  it('should return 100% when task reaches DONE', () => {
    const doneTask: Task = { ...baseTask, state: 'DONE', current_sha: 'a1b2c3d' };
    const res = ProgressService.calculateTaskProgress(doneTask);
    expect(res.percent).toBe(100);
  });

  it('should aggregate project progress accurately across tasks', () => {
    const t1 = { ...baseTask, progress_cache_percent: 50 };
    const t2 = { ...baseTask, progress_cache_percent: 100 };
    const avg = ProgressService.calculateProjectProgress([t1, t2]);
    expect(avg).toBe(75);
  });
});
