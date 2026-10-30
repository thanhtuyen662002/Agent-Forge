import type { Task } from '../core/types/domain';

export interface DependencyGraphLayout {
  /** Columns left to right: column 0 needs no other task, column n needs tasks of earlier columns only. */
  columns: Task[][];
  /** One edge per dependency between two shown tasks: `from` is needed by `to`. */
  edges: Array<{ from: string; to: string }>;
  /** False when no shown task has a dependency (a project planned before #362). */
  hasDependencies: boolean;
}

/**
 * Layered layout of a project's task dependencies (#366). A task's column is one more
 * than the deepest column of the tasks it needs, so tasks in one column can run at the
 * same time. Dependencies on tasks that are not shown (trashed, filtered out) are left
 * out; a cycle, which the owner edit refuses, cannot loop the layout.
 */
export function layoutDependencyGraph(tasks: readonly Task[], dependencies: Readonly<Record<string, readonly string[]>>): DependencyGraphLayout {
  const shown = new Set(tasks.map((task) => task.id));
  const needs = new Map(tasks.map((task) => [task.id, (dependencies[task.id] ?? []).filter((id) => shown.has(id) && id !== task.id)]));
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const levelOf = (id: string): number => {
    const known = level.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const value = Math.max(-1, ...(needs.get(id) ?? []).map(levelOf)) + 1;
    visiting.delete(id);
    level.set(id, value);
    return value;
  };
  const columns: Task[][] = [];
  // Plan order within a column.
  for (const task of tasks) (columns[levelOf(task.id)] ??= []).push(task);
  const edges = tasks.flatMap((task) => (needs.get(task.id) ?? []).map((from) => ({ from, to: task.id })));
  return { columns: columns.filter(Boolean), edges, hasDependencies: edges.length > 0 };
}
