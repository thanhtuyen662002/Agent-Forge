import React, { useMemo, useState } from 'react';
import type { Task } from '../../core/types/domain';
import { useI18n } from '../context/I18nContext';
import { getTaskLaneId, type TaskLaneId } from '../taskStatePresentation';
import { layoutDependencyGraph } from '../dependencyGraph';

const NODE_WIDTH = 224;
const NODE_HEIGHT = 72;
const COLUMN_GAP = 72;
const ROW_GAP = 14;
const PADDING = 16;

/** Border and dot colour of a task node by its board lane. */
const LANE_STYLE: Record<TaskLaneId, { border: string; dot: string }> = {
  planned: { border: 'border-slate-600', dot: 'bg-slate-400' },
  coding: { border: 'border-forge-cyan/60', dot: 'bg-forge-cyan' },
  validating: { border: 'border-forge-purple/60', dot: 'bg-forge-purple' },
  handoff: { border: 'border-amber-500/60', dot: 'bg-amber-400' },
  waiting: { border: 'border-amber-500/50', dot: 'bg-amber-300' },
  blocked: { border: 'border-forge-rose/60', dot: 'bg-forge-rose' },
  completed: { border: 'border-forge-emerald/60', dot: 'bg-forge-emerald' },
  failed: { border: 'border-red-500/70', dot: 'bg-red-500' },
  cancelled: { border: 'border-slate-600/60', dot: 'bg-slate-600' },
  unknown: { border: 'border-yellow-300/70', dot: 'bg-yellow-300' },
};

/**
 * The project's tasks as a left-to-right dependency graph (#366): a column holds tasks
 * that can run at the same time, and a curve joins each task to the tasks that need it.
 * Hovering or focusing a task highlights what it waits for and what waits for it.
 */
export const DependencyGraph: React.FC<{
  tasks: readonly Task[];
  dependencies: Readonly<Record<string, readonly string[]>>;
  onOpenTask: (taskId: string) => void;
}> = ({ tasks, dependencies, onOpenTask }) => {
  const { t } = useI18n();
  const [focused, setFocused] = useState<string | null>(null);
  const layout = useMemo(() => layoutDependencyGraph(tasks, dependencies), [tasks, dependencies]);
  const titles = useMemo(() => new Map(tasks.map((task) => [task.id, task.title])), [tasks]);

  const position = new Map<string, { x: number; y: number }>();
  layout.columns.forEach((column, columnIndex) => column.forEach((task, rowIndex) => {
    position.set(task.id, { x: PADDING + columnIndex * (NODE_WIDTH + COLUMN_GAP), y: PADDING + rowIndex * (NODE_HEIGHT + ROW_GAP) });
  }));
  const width = PADDING * 2 + layout.columns.length * NODE_WIDTH + Math.max(0, layout.columns.length - 1) * COLUMN_GAP;
  const height = PADDING * 2 + Math.max(0, ...layout.columns.map((column) => column.length * NODE_HEIGHT + (column.length - 1) * ROW_GAP));
  const related = new Set<string>();
  if (focused) {
    related.add(focused);
    for (const edge of layout.edges) if (edge.from === focused || edge.to === focused) { related.add(edge.from); related.add(edge.to); }
  }

  if (tasks.length === 0) return <p className="text-xs text-slate-500">{t('taskBoard.graph.empty')}</p>;
  return (
    <div className="space-y-3 min-h-0 flex flex-col">
      <p className="text-xs text-slate-400 shrink-0">{layout.hasDependencies ? t('taskBoard.graph.hint') : t('taskBoard.graph.noDependencies')}</p>
      <div className="flex-1 min-h-0 overflow-auto rounded-xl border border-surface-border bg-surface/40">
        <div className="relative" style={{ width, height }}>
          <svg aria-hidden="true" width={width} height={height} className="absolute inset-0 pointer-events-none">
            {layout.edges.map((edge) => {
              const from = position.get(edge.from)!;
              const to = position.get(edge.to)!;
              const x1 = from.x + NODE_WIDTH;
              const y1 = from.y + NODE_HEIGHT / 2;
              const x2 = to.x;
              const y2 = to.y + NODE_HEIGHT / 2;
              const bend = Math.max(24, (x2 - x1) / 2);
              const active = focused !== null && (edge.from === focused || edge.to === focused);
              return (
                <path
                  key={`${edge.from}->${edge.to}`}
                  data-edge={`${edge.from}->${edge.to}`}
                  d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  strokeWidth={active ? 2.5 : 1.5}
                  className={active ? 'stroke-forge-cyan' : focused ? 'stroke-slate-700' : 'stroke-slate-500'}
                />
              );
            })}
          </svg>
          {layout.columns.flatMap((column) => column.map((task) => {
            const at = position.get(task.id)!;
            const style = LANE_STYLE[getTaskLaneId(task.state)];
            const needs = (dependencies[task.id] ?? []).map((id) => titles.get(id)).filter((title): title is string => Boolean(title));
            const dimmed = focused !== null && !related.has(task.id);
            return (
              <button
                key={task.id}
                type="button"
                data-task={task.id}
                onClick={() => onOpenTask(task.id)}
                onMouseEnter={() => setFocused(task.id)}
                onMouseLeave={() => setFocused(null)}
                onFocus={() => setFocused(task.id)}
                onBlur={() => setFocused(null)}
                aria-label={needs.length > 0 ? t('taskBoard.graph.nodeLabelWithDeps', { title: task.title, deps: needs.join(', ') }) : task.title}
                style={{ left: at.x, top: at.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
                className={`absolute text-left bg-surface-card border ${style.border} rounded-lg px-3 py-2 flex flex-col justify-between transition ${dimmed ? 'opacity-35' : 'opacity-100'} hover:border-forge-cyan focus-visible:outline focus-visible:outline-2 focus-visible:outline-forge-cyan`}
              >
                <span className="text-xs font-medium text-slate-100 leading-snug line-clamp-2">{task.title}</span>
                <span className="flex items-center justify-between gap-2 text-[10px] text-slate-500">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full shrink-0 ${style.dot}`} />
                    <span className="font-mono truncate">{task.state}</span>
                  </span>
                  <span className="font-mono shrink-0">{task.id}</span>
                </span>
              </button>
            );
          }))}
        </div>
      </div>
    </div>
  );
};
