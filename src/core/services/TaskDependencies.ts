import type { Repository } from '../database/repositories';
import type { Task } from '../types/domain';
import type { PlanTask } from '../types/protocols';

/**
 * Task dependencies (#362). Without them, more than one task at a time dispatched tasks
 * before the code they build on existed (VidFlow M5.6 ran before M5.5), so projects ran
 * one task at a time and an owner's ten coder slots stayed idle. A task names the tasks
 * whose code it needs; it is decided and dispatched only once they are finished, so
 * independent tasks run in parallel up to the project's limit.
 */

/** A plan's dependency numbers must name earlier tasks (which also rules out cycles); returns the first bad task number, or null. */
export function invalidPlanDependency(tasks: readonly Pick<PlanTask, 'depends_on'>[]): number | null {
  for (const [index, task] of tasks.entries()) {
    if ((task.depends_on ?? []).some((number) => number < 1 || number >= index + 1)) return index + 1;
  }
  return null;
}

/** A dependency no longer holds back its dependents once it is done, or the owner cancelled or trashed it. */
function finished(repo: Repository, taskId: string): boolean {
  const task = repo.getTask(taskId);
  return !task || task.state === 'DONE' || task.state === 'CANCELLED' || repo.isTaskTrashed(taskId);
}

/**
 * Dependencies of a task that still hold it back. `integrated` additionally requires a finished
 * dependency's reviewed code to be on the default branch (automatic integration), because a
 * coder run starts from that branch.
 */
export function unmetDependencies(repo: Repository, task: Task, integrated?: (taskId: string) => boolean): string[] {
  return repo.getTaskDependencies(task.project_id, task.id)
    .filter((dependency) => !finished(repo, dependency) || (integrated !== undefined && !integrated(dependency)));
}

/**
 * Validates an owner's dependency list for a task: tasks of the same project, not itself,
 * and no cycle through the dependencies already stored. Returns an error code or null.
 */
export function dependencyError(repo: Repository, projectId: string, taskId: string, dependsOn: readonly string[]):
  'TASK_NOT_FOUND' | 'DEPENDENCY_NOT_FOUND' | 'DEPENDENCY_CYCLE' | null {
  const task = repo.getTask(taskId);
  if (!task || task.project_id !== projectId) return 'TASK_NOT_FOUND';
  for (const dependency of dependsOn) {
    const other = repo.getTask(dependency);
    if (!other || other.project_id !== projectId) return 'DEPENDENCY_NOT_FOUND';
    if (dependency === taskId) return 'DEPENDENCY_CYCLE';
  }
  // A cycle exists when the task is reachable from one of its new dependencies.
  const seen = new Set<string>();
  const stack = [...dependsOn];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === taskId) return 'DEPENDENCY_CYCLE';
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...repo.getTaskDependencies(projectId, current));
  }
  return null;
}
