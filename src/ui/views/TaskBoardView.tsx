import React, { useMemo, useState } from 'react';
import { useOrchestrator } from '../context/OrchestratorContext';
import { useI18n } from '../context/I18nContext';
import { UiActionFailure, uiActionFailureKey } from '../actionState';
import { ProgressIndicator } from '../components/ProgressIndicator';
import { AccessibleDialog } from '../components/AccessibleDialog';
import { ConfirmTrashDialog, TrashFailureMessage, TrashList } from '../components/TrashPanel';
import { matchesSearch, useWorkspaceTrash } from '../workspaceTrash';
import type { TrashActionResult } from '../workspaceTrash';
import type { Task } from '../../core/types/domain';
import {
  getTaskLaneId,
  TASK_LANE_STATE_GROUPS,
  TaskLaneId,
} from '../taskStatePresentation';
import {
  Plus,
  ArrowRight,
  AlertTriangle,
  GitBranch,
  Shield,
  Layers,
  Sparkles,
  CheckCircle2,
  Clock,
  Search,
  Trash2,
} from 'lucide-react';

/** Matches the backend fence: only new, planned or finished tasks can be trashed. */
const TRASHABLE_STATES = new Set(['CREATED', 'PLANNED', 'DONE', 'FAILED', 'CANCELLED']);

export const TaskBoardView: React.FC = () => {
  const { tasks, createTask, setSelectedTaskId, setActiveView, isElectron, activeProject, pendingActions, refreshData } = useOrchestrator();
  const { t } = useI18n();
  const [isCreateModalOpen, setIsCreateModalOpen] = useState<boolean>(false);
  const [newTitle, setNewTitle] = useState<string>('');
  const [newDesc, setNewDesc] = useState<string>('');
  const [newPriority, setNewPriority] = useState<'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'>('MEDIUM');
  const [newRisk, setNewRisk] = useState<'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'>('MEDIUM');
  const [newCriteria, setNewCriteria] = useState<string>('');
  const [createError, setCreateError] = useState<UiActionFailure | null>(null);
  const creating = pendingActions.includes('createTask');
  const trash = useWorkspaceTrash(refreshData);
  const [taskQuery, setTaskQuery] = useState('');
  const [showTrash, setShowTrash] = useState(false);
  const [trashTarget, setTrashTarget] = useState<Task | null>(null);
  const [trashFailure, setTrashFailure] = useState<TrashActionResult | null>(null);
  const [trashNotice, setTrashNotice] = useState<{ ok: boolean; message: string; failure?: TrashActionResult } | null>(null);
  const visibleTasks = useMemo(
    () => tasks.filter((task) => matchesSearch(taskQuery, task.title, task.id, task.description)),
    [tasks, taskQuery],
  );
  const projectTrash = useMemo(
    () => ({ projects: [], tasks: trash.listing.tasks.filter((task) => task.projectId === activeProject?.id) }),
    [trash.listing, activeProject?.id],
  );

  const confirmTrashTask = async () => {
    if (!trashTarget) return;
    const result = await trash.trashTask(trashTarget.id);
    if (result.success) {
      const extra = result.invalidatedAuthorizations > 0 ? ` ${t('trash.results.invalidated', { count: result.invalidatedAuthorizations })}` : '';
      setTrashNotice({ ok: true, message: t('trash.results.taskTrashed', { name: trashTarget.title }) + extra });
      setTrashTarget(null);
      setTrashFailure(null);
    } else {
      setTrashFailure(result);
    }
  };

  const restoreTask = async (taskId: string, title: string) => {
    const result = await trash.restoreTask(taskId);
    setTrashNotice(result.success
      ? { ok: true, message: t('trash.results.taskRestored', { name: title }) }
      : { ok: false, message: '', failure: result });
  };

  const laneLabels: Record<TaskLaneId, string> = {
    planned: t('taskBoard.lanes.planned'),
    coding: t('taskBoard.lanes.coding'),
    validating: t('taskBoard.lanes.validating'),
    handoff: t('taskBoard.lanes.handoff'),
    waiting: t('taskBoard.lanes.waiting'),
    blocked: t('taskBoard.lanes.blocked'),
    completed: t('taskBoard.lanes.completed'),
    failed: t('taskBoard.lanes.failed'),
    cancelled: t('taskBoard.lanes.cancelled'),
    unknown: t('taskBoard.lanes.unknown'),
  };
  const laneColors: Record<TaskLaneId, string> = {
    planned: 'border-slate-600',
    coding: 'border-forge-cyan/40',
    validating: 'border-forge-purple/40',
    handoff: 'border-amber-500/50',
    waiting: 'border-amber-500/40',
    blocked: 'border-forge-rose/40',
    completed: 'border-forge-emerald/40',
    failed: 'border-red-500/60',
    cancelled: 'border-slate-500/60',
    unknown: 'border-yellow-300/70',
  };
  const laneActions: Record<TaskLaneId, string> = {
    planned: t('taskBoard.laneActions.automated'),
    coding: t('taskBoard.laneActions.automated'),
    validating: t('taskBoard.laneActions.automated'),
    handoff: t('taskBoard.laneActions.owner'),
    waiting: t('taskBoard.laneActions.wait'),
    blocked: t('taskBoard.laneActions.inspect'),
    completed: t('taskBoard.laneActions.none'),
    failed: t('taskBoard.laneActions.retry'),
    cancelled: t('taskBoard.laneActions.none'),
    unknown: t('taskBoard.laneActions.integrity'),
  };
  // The main flow is always shown; exception lanes (handoff, waiting, blocked, failed, cancelled, unknown) only when they hold tasks.
  const CORE_LANES = new Set<TaskLaneId>(['planned', 'coding', 'validating', 'completed']);
  const columns = [
    ...TASK_LANE_STATE_GROUPS.map((group) => ({ id: group.id, label: laneLabels[group.id], color: laneColors[group.id] })),
    { id: 'unknown' as const, label: laneLabels.unknown, color: laneColors.unknown },
  ].filter((col) => CORE_LANES.has(col.id) || visibleTasks.some((task) => getTaskLaneId(task.state) === col.id));

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;

    const criteriaList = newCriteria
      .split('\n')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    setCreateError(null);
    const result = await createTask({
      title: newTitle,
      description: newDesc,
      priority: newPriority,
      risk: newRisk,
      acceptanceCriteria: criteriaList,
      constraints: [],
    });
    if (!result.success) {
      setCreateError(result.code);
      return;
    }

    setNewTitle('');
    setNewDesc('');
    setNewCriteria('');
    setIsCreateModalOpen(false);
  };

  return (
    <div className="px-6 py-6 space-y-5 h-full flex flex-col overflow-hidden">
      {/* Top Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight flex items-center space-x-2.5">
            <Layers className="w-5 h-5 text-forge-cyan" />
            <span>{t('taskBoard.title')}</span>
          </h2>
          <p className="text-xs text-slate-400">
            {t('taskBoard.subtitle')}
          </p>
        </div>

        <button
          onClick={() => { setCreateError(null); setIsCreateModalOpen(true); }}
          disabled={!isElectron || !activeProject || creating}
          title={!isElectron ? t('actions.desktopRequired') : undefined}
          className="h-9 px-4 bg-forge-cyan hover:bg-cyan-500 text-slate-950 font-semibold text-sm rounded-lg flex items-center gap-2 transition disabled:opacity-50"
        >
          <Plus className="w-4 h-4" />
          <span>{t('taskBoard.newTask')}</span>
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3 shrink-0">
        <label className="relative block flex-1 min-w-[220px] max-w-md">
          <span className="sr-only">{t('trash.taskSearch')}</span>
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
          <input
            type="search"
            value={taskQuery}
            onChange={(event) => setTaskQuery(event.target.value)}
            placeholder={t('trash.taskSearchPlaceholder')}
            className="w-full bg-surface border border-surface-border rounded-lg pl-9 pr-3 py-2 text-sm text-white focus:outline-none focus:border-forge-cyan"
          />
        </label>
        <button
          type="button"
          onClick={() => setShowTrash((value) => !value)}
          disabled={!trash.available || !activeProject}
          aria-expanded={showTrash}
          className="px-3 py-2 rounded-lg text-xs border border-surface-border text-slate-300 hover:bg-surface-border disabled:opacity-40 flex items-center gap-1.5"
        >
          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{showTrash ? t('trash.hideTrash') : t('trash.showTrash')} ({projectTrash.tasks.length})</span>
        </button>
        {taskQuery.trim() && visibleTasks.length === 0 && <span className="text-xs text-slate-500">{t('trash.noMatches')}</span>}
      </div>

      {trashNotice && (trashNotice.ok
        ? <p role="status" className="text-xs text-emerald-300 shrink-0">{trashNotice.message}</p>
        : trashNotice.failure && <div className="shrink-0"><TrashFailureMessage result={trashNotice.failure} /></div>)}

      {showTrash && (
        <div className="shrink-0 max-h-64 overflow-y-auto">
          {trash.loadFailed
            ? <p role="alert" className="text-xs text-rose-300">{t('trash.loadFailed')}</p>
            : <TrashList listing={projectTrash} show="tasks" pending={trash.pending} onRestoreTask={(id, title) => void restoreTask(id, title)} />}
        </div>
      )}

      {trashTarget && (
        <ConfirmTrashDialog
          kind="task"
          name={trashTarget.title}
          pending={trash.pending}
          failure={trashFailure}
          onCancel={() => setTrashTarget(null)}
          onConfirm={() => void confirmTrashTask()}
        />
      )}

      {/* Kanban Board Columns Grid */}
      <div className="flex gap-4 flex-1 min-h-0 overflow-x-auto pb-3">
        {columns.map((col) => {
          const colTasks = visibleTasks.filter((task) => getTaskLaneId(task.state) === col.id);
          return (
            <div
              key={col.id}
              className={`bg-surface-card border-t-2 ${col.color} border-x border-b border-surface-border rounded-xl p-3 flex flex-col gap-3 w-72 shrink-0 min-h-0`}
            >
              <div className="flex items-center justify-between px-1">
                <div className="min-w-0">
                  <span className="block text-sm font-semibold text-slate-200">{col.label}</span>
                  <span className="block text-[11px] text-slate-500 truncate">{laneActions[col.id]}</span>
                </div>
                <span className="min-w-[1.5rem] text-center px-2 py-0.5 rounded-full bg-surface text-slate-300 text-xs tabular-nums shrink-0">
                  {colTasks.length}
                </span>
              </div>

              {/* Task Cards Container */}
              <div className="space-y-2.5 flex-1 overflow-y-auto pr-0.5">
                {colTasks.length === 0 ? (
                  <div className="text-xs text-slate-600 text-center py-10 border border-dashed border-surface-border rounded-lg">
                    {t('taskBoard.emptyLane')}
                  </div>
                ) : (
                  colTasks.map((task) => (
                    <div key={task.id} className="space-y-1">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedTaskId(task.id);
                        setActiveView('task-detail');
                      }}
                      className="block w-full text-left bg-surface hover:bg-surface/60 border border-surface-border hover:border-forge-cyan/50 rounded-lg p-3 space-y-2.5 transition cursor-pointer group"
                    >
                      <span className="block text-sm font-medium text-slate-100 group-hover:text-white leading-snug line-clamp-2">
                        {task.title}
                      </span>

                      <span className="flex items-center justify-between text-[11px]">
                        <span className="font-mono text-slate-500">{task.id}</span>
                        <span
                          className={`px-1.5 py-0.5 rounded ${
                            task.priority === 'CRITICAL'
                              ? 'bg-rose-500/20 text-rose-400'
                              : task.priority === 'HIGH'
                              ? 'bg-amber-500/20 text-amber-400'
                              : 'bg-slate-800 text-slate-400'
                          } text-[10px] font-medium`}
                        >
                          {task.priority}
                        </span>
                      </span>

                      <ProgressIndicator percent={task.progress_cache_percent} size="sm" compact />

                      <span className="flex items-center justify-between text-[11px] text-slate-500">
                        <span>{t('taskBoard.revLabel')}: {task.revision_count}/{task.max_revisions}</span>
                        <span className="font-mono text-slate-400">{task.state}</span>
                      </span>
                    </button>
                    {TRASHABLE_STATES.has(task.state) && (
                      <button
                        type="button"
                        onClick={() => { setTrashFailure(null); setTrashTarget(task); }}
                        disabled={!trash.available || trash.pending}
                        aria-label={`${t('trash.moveToTrash')}: ${task.title}`}
                        className="w-full px-2 py-1 rounded-md text-[11px] text-slate-400 hover:text-rose-300 hover:bg-rose-950/30 disabled:opacity-40 flex items-center justify-end gap-1"
                      >
                        <Trash2 className="w-3 h-3" aria-hidden="true" />
                        <span>{t('trash.moveToTrash')}</span>
                      </button>
                    )}
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* New Task Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <AccessibleDialog onDismiss={() => setIsCreateModalOpen(false)} dismissible={!creating} aria-labelledby="create-task-title" className="bg-surface border border-surface-border rounded-xl shadow-2xl max-w-lg w-full p-6 space-y-4">
            <h3 id="create-task-title" className="text-base font-bold text-white font-mono uppercase tracking-wide">{t('taskBoard.createModal.title')}</h3>
            <form onSubmit={handleCreateTask} className="space-y-4 text-xs font-mono">
              <div>
                <label htmlFor="create-task-name" className="block text-slate-400 mb-1">{t('taskBoard.createModal.taskTitleLabel')}:</label>
                <input
                  id="create-task-name"
                  type="text"
                  required
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder={t('taskBoard.createModal.taskTitlePlaceholder')}
                  className="w-full bg-surface-card border border-surface-border rounded-lg px-3 py-2 text-white focus:outline-none focus:border-forge-cyan font-sans"
                />
              </div>

              <div>
                <label htmlFor="create-task-description" className="block text-slate-400 mb-1">{t('taskBoard.createModal.descLabel')}:</label>
                <textarea
                  id="create-task-description"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder={t('taskBoard.createModal.descPlaceholder')}
                  className="w-full h-24 bg-surface-card border border-surface-border rounded-lg p-3 text-white focus:outline-none focus:border-forge-cyan font-sans resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="create-task-priority" className="block text-slate-400 mb-1">{t('taskBoard.createModal.priorityLabel')}:</label>
                  <select
                    id="create-task-priority"
                    value={newPriority}
                    onChange={(e) => setNewPriority(e.target.value as any)}
                    className="w-full bg-surface-card border border-surface-border rounded-lg px-3 py-2 text-white focus:outline-none focus:border-forge-cyan"
                  >
                    <option value="LOW">LOW</option>
                    <option value="MEDIUM">MEDIUM</option>
                    <option value="HIGH">HIGH</option>
                    <option value="CRITICAL">CRITICAL</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="create-task-risk" className="block text-slate-400 mb-1">{t('taskBoard.createModal.riskLabel')}:</label>
                  <select
                    id="create-task-risk"
                    value={newRisk}
                    onChange={(e) => setNewRisk(e.target.value as any)}
                    className="w-full bg-surface-card border border-surface-border rounded-lg px-3 py-2 text-white focus:outline-none focus:border-forge-cyan"
                  >
                    <option value="LOW">LOW</option>
                    <option value="MEDIUM">MEDIUM</option>
                    <option value="HIGH">HIGH</option>
                    <option value="CRITICAL">CRITICAL</option>
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="create-task-criteria" className="block text-slate-400 mb-1">{t('taskBoard.createModal.criteriaLabel')}:</label>
                <textarea
                  id="create-task-criteria"
                  value={newCriteria}
                  onChange={(e) => setNewCriteria(e.target.value)}
                  placeholder={t('taskBoard.createModal.criteriaPlaceholder')}
                  className="w-full h-20 bg-surface-card border border-surface-border rounded-lg p-3 text-white focus:outline-none focus:border-forge-cyan font-sans resize-none"
                />
              </div>

              {createError && <div role="alert" className="text-rose-300">{t(uiActionFailureKey(createError))}</div>}
              <div className="flex justify-end space-x-3 pt-3 border-t border-surface-border">
                <button
                  data-dialog-initial-focus
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  disabled={creating}
                  className="px-4 py-2 bg-surface-card hover:bg-surface-border text-slate-300 rounded-lg text-xs"
                >
                  {t('taskBoard.createModal.cancelButton')}
                </button>
                <button
                  type="submit"
                  disabled={!isElectron || !activeProject || creating || !newTitle.trim()}
                  aria-busy={creating}
                  className="px-5 py-2 bg-forge-cyan hover:bg-cyan-600 text-slate-950 font-bold rounded-lg text-xs shadow"
                >
                  {creating ? t('actions.pending') : t('taskBoard.createModal.createButton')}
                </button>
              </div>
            </form>
          </AccessibleDialog>
        </div>
      )}
    </div>
  );
};
