import { describe, expect, it } from 'vitest';
import type { Repository } from '../src/core/database/repositories';
import type { Task } from '../src/core/types/domain';
import { dependencyError, invalidPlanDependency, unmetDependencies } from '../src/core/services/TaskDependencies';

/** #362: tasks name the tasks whose code they need, so independent ones can run in parallel. */
describe('task dependencies', () => {
  const tasks = new Map<string, Partial<Task>>();
  const deps = new Map<string, string[]>();
  const repo = {
    getTask: (id: string) => (tasks.has(id) ? { id, project_id: 'P', ...tasks.get(id) } : null),
    isTaskTrashed: (id: string) => id === 'trashed',
    getTaskDependencies: (_project: string, id: string) => deps.get(id) ?? [],
  } as unknown as Repository;
  const set = (states: Record<string, string>) => {
    tasks.clear();
    for (const [id, state] of Object.entries(states)) tasks.set(id, { state: state as Task['state'] });
  };

  it('accepts plan dependencies on earlier tasks only', () => {
    expect(invalidPlanDependency([{ depends_on: [] }, { depends_on: [1] }, { depends_on: [1, 2] }])).toBeNull();
    expect(invalidPlanDependency([{ depends_on: [] }, { depends_on: [2] }])).toBe(2); // Itself.
    expect(invalidPlanDependency([{ depends_on: [2] }, { depends_on: [] }])).toBe(1); // A later task.
  });

  it('holds a task until its dependencies are done, cancelled or trashed, and integrated when asked', () => {
    set({ a: 'DONE', b: 'CODING', c: 'CANCELLED', trashed: 'CODING', t: 'PLANNED' });
    deps.set('t', ['a', 'b', 'c', 'trashed']);
    const task = { id: 't', project_id: 'P' } as Task;
    expect(unmetDependencies(repo, task)).toEqual(['b']);
    tasks.set('b', { state: 'DONE' });
    expect(unmetDependencies(repo, task)).toEqual([]);
    expect(unmetDependencies(repo, task, (id) => id !== 'a')).toEqual(['a']);
  });

  it('refuses unknown tasks, the task itself and cycles for an owner edit', () => {
    set({ a: 'CODING', b: 'CODING', c: 'CODING' });
    deps.clear();
    deps.set('b', ['a']);
    deps.set('c', ['b']);
    expect(dependencyError(repo, 'P', 'c', ['a', 'b'])).toBeNull();
    expect(dependencyError(repo, 'P', 'a', ['c'])).toBe('DEPENDENCY_CYCLE'); // a -> c -> b -> a.
    expect(dependencyError(repo, 'P', 'a', ['a'])).toBe('DEPENDENCY_CYCLE');
    expect(dependencyError(repo, 'P', 'a', ['missing'])).toBe('DEPENDENCY_NOT_FOUND');
    expect(dependencyError(repo, 'P', 'missing', [])).toBe('TASK_NOT_FOUND');
  });
});
