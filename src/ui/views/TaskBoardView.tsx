import React, { useState } from 'react';
import { useOrchestrator } from '../context/OrchestratorContext';
import { Task, TaskState } from '../../core/types/domain';
import { ProgressIndicator } from '../components/ProgressIndicator';
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
} from 'lucide-react';

export const TaskBoardView: React.FC = () => {
  const { tasks, createTask, setSelectedTaskId, setActiveView } = useOrchestrator();
  const [isCreateModalOpen, setIsCreateModalOpen] = useState<boolean>(false);
  const [newTitle, setNewTitle] = useState<string>('');
  const [newDesc, setNewDesc] = useState<string>('');
  const [newPriority, setNewPriority] = useState<'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'>('MEDIUM');
  const [newRisk, setNewRisk] = useState<'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'>('MEDIUM');
  const [newCriteria, setNewCriteria] = useState<string>('');

  const columns: { id: string; label: string; states: TaskState[]; color: string }[] = [
    { id: 'planned', label: 'PLANNED', states: ['CREATED', 'PLANNED', 'APPROVED', 'QUEUED'], color: 'border-slate-600' },
    { id: 'coding', label: 'CODING', states: ['DISPATCHED', 'CODING', 'PAUSED'], color: 'border-forge-cyan/40' },
    { id: 'validating', label: 'VALIDATING & REVIEW', states: ['VALIDATING', 'REVIEW_READY', 'REVIEWING', 'FIX_REQUIRED'], color: 'border-forge-purple/40' },
    { id: 'blocked', label: 'BLOCKED / ESCALATED', states: ['BLOCKED', 'NEEDS_HUMAN', 'WAITING_FOR_CAPACITY', 'WAITING_FOR_AUTHORITY'], color: 'border-forge-rose/40' },
    { id: 'done', label: 'COMPLETED', states: ['DONE'], color: 'border-forge-emerald/40' },
  ];

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;

    const criteriaList = newCriteria
      .split('\n')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    await createTask({
      title: newTitle,
      description: newDesc,
      priority: newPriority,
      risk: newRisk,
      acceptanceCriteria: criteriaList,
      constraints: [],
    });

    setNewTitle('');
    setNewDesc('');
    setNewCriteria('');
    setIsCreateModalOpen(false);
  };

  return (
    <div className="p-8 space-y-6 max-w-7xl mx-auto h-full flex flex-col overflow-hidden">
      {/* Top Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight flex items-center space-x-2.5">
            <Layers className="w-5 h-5 text-forge-cyan" />
            <span>Task Kanban Board</span>
          </h2>
          <p className="text-xs text-slate-400">
            Lifecycle state machine tracks tasks from creation through decomposition, coding, validation, and completion.
          </p>
        </div>

        <button
          onClick={() => setIsCreateModalOpen(true)}
          className="px-4 py-2 bg-forge-cyan hover:bg-cyan-600 text-slate-950 font-mono font-bold text-xs rounded-lg shadow-lg flex items-center space-x-2 transition"
        >
          <Plus className="w-4 h-4" />
          <span>NEW TASK</span>
        </button>
      </div>

      {/* Kanban Board Columns Grid */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4 flex-1 overflow-x-auto pb-4">
        {columns.map((col) => {
          const colTasks = tasks.filter((t) => col.states.includes(t.state));
          return (
            <div
              key={col.id}
              className={`bg-surface-card border-t-2 ${col.color} border-x border-b border-surface-border rounded-xl p-3.5 flex flex-col space-y-3 min-w-[240px]`}
            >
              <div className="flex items-center justify-between text-xs font-mono font-semibold text-slate-300 pb-1 border-b border-surface-border/50">
                <span>{col.label}</span>
                <span className="px-2 py-0.5 rounded-full bg-surface text-slate-400 text-[10px]">
                  {colTasks.length}
                </span>
              </div>

              {/* Task Cards Container */}
              <div className="space-y-3 flex-1 overflow-y-auto pr-1">
                {colTasks.length === 0 ? (
                  <div className="text-[11px] font-mono text-slate-600 text-center py-8">
                    No tasks in this lane
                  </div>
                ) : (
                  colTasks.map((task) => (
                    <div
                      key={task.id}
                      onClick={() => {
                        setSelectedTaskId(task.id);
                        setActiveView('task-detail');
                      }}
                      className="bg-surface/80 hover:bg-surface border border-surface-border hover:border-forge-cyan/40 rounded-lg p-3.5 space-y-3 shadow transition cursor-pointer group"
                    >
                      <div className="flex items-center justify-between text-[10px] font-mono">
                        <span className="text-forge-cyan font-bold">{task.id}</span>
                        <span
                          className={`px-1.5 py-0.5 rounded ${
                            task.priority === 'CRITICAL'
                              ? 'bg-rose-500/20 text-rose-400'
                              : task.priority === 'HIGH'
                              ? 'bg-amber-500/20 text-amber-400'
                              : 'bg-slate-800 text-slate-400'
                          }`}
                        >
                          {task.priority}
                        </span>
                      </div>

                      <h4 className="text-xs font-semibold text-white group-hover:text-forge-cyan transition line-clamp-2">
                        {task.title}
                      </h4>

                      <ProgressIndicator percent={task.progress_cache_percent} size="sm" />

                      <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 pt-1 border-t border-surface-border/50">
                        <span>Rev: {task.revision_count}/{task.max_revisions}</span>
                        <span className="text-slate-300 font-medium">{task.state}</span>
                      </div>
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
          <div className="bg-surface border border-surface-border rounded-xl shadow-2xl max-w-lg w-full p-6 space-y-4">
            <h3 className="text-base font-bold text-white font-mono uppercase tracking-wide">Create New Task</h3>
            <form onSubmit={handleCreateTask} className="space-y-4 text-xs font-mono">
              <div>
                <label className="block text-slate-400 mb-1">Task Title:</label>
                <input
                  type="text"
                  required
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="e.g. Implement API rate limiter middleware"
                  className="w-full bg-surface-card border border-surface-border rounded-lg px-3 py-2 text-white focus:outline-none focus:border-forge-cyan font-sans"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Description:</label>
                <textarea
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="Detailed task description and requirements..."
                  className="w-full h-24 bg-surface-card border border-surface-border rounded-lg p-3 text-white focus:outline-none focus:border-forge-cyan font-sans resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-400 mb-1">Priority:</label>
                  <select
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
                  <label className="block text-slate-400 mb-1">Risk Level:</label>
                  <select
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
                <label className="block text-slate-400 mb-1">Acceptance Criteria (1 per line):</label>
                <textarea
                  value={newCriteria}
                  onChange={(e) => setNewCriteria(e.target.value)}
                  placeholder="All unit tests pass&#10;Returns 429 when quota exceeded"
                  className="w-full h-20 bg-surface-card border border-surface-border rounded-lg p-3 text-white focus:outline-none focus:border-forge-cyan font-sans resize-none"
                />
              </div>

              <div className="flex justify-end space-x-3 pt-3 border-t border-surface-border">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2 bg-surface-card hover:bg-surface-border text-slate-300 rounded-lg text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-forge-cyan hover:bg-cyan-600 text-slate-950 font-bold rounded-lg text-xs shadow"
                >
                  Create Task
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
