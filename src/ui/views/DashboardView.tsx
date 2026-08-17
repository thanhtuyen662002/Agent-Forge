import React from 'react';
import { useOrchestrator } from '../context/OrchestratorContext';
import { AgentCard } from '../components/AgentCard';
import { ProgressIndicator } from '../components/ProgressIndicator';
import {
  Activity,
  CheckCircle2,
  AlertTriangle,
  GitBranch,
  ShieldCheck,
  Zap,
  ArrowRight,
  Clock,
  Sparkles,
} from 'lucide-react';

export const DashboardView: React.FC = () => {
  const {
    activeProject,
    tasks,
    agents,
    resources,
    events,
    setActiveView,
    setSelectedTaskId,
  } = useOrchestrator();

  const completedTasks = tasks.filter((t) => t.state === 'DONE').length;
  const activeTasks = tasks.filter((t) => ['CODING', 'VALIDATING', 'REVIEWING', 'DISPATCHED'].includes(t.state)).length;
  const blockedTasks = tasks.filter((t) => t.state === 'BLOCKED' || t.state === 'NEEDS_HUMAN').length;

  const totalProgress = tasks.length > 0
    ? Math.round(tasks.reduce((sum, t) => sum + t.progress_cache_percent, 0) / tasks.length)
    : 0;

  const activeAgentsList = agents.filter((a) => a.status === 'ACTIVE' || a.status === 'BUSY');

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto overflow-y-auto">
      {/* Top Banner / Project Overview */}
      <div className="bg-surface-card border border-surface-border rounded-2xl p-6 shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-forge-cyan/5 rounded-full blur-3xl -mr-20 -mt-20 pointer-events-none"></div>

        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 relative z-10">
          <div className="space-y-2">
            <div className="flex items-center space-x-3">
              <span className="px-2.5 py-1 rounded-md text-xs font-mono font-bold bg-forge-cyan/20 text-forge-cyan border border-forge-cyan/30">
                {activeProject?.id || 'PROJ-CORE'}
              </span>
              <h2 className="text-2xl font-bold text-white tracking-tight">
                {activeProject?.name || 'Local AI Engineering Control Plane'}
              </h2>
            </div>
            <p className="text-sm text-slate-400 max-w-2xl">
              {activeProject?.description || 'Durable local orchestration plane for AI Managers, Coders, and automated test runners.'}
            </p>
            <div className="flex items-center space-x-6 text-xs font-mono text-slate-400 pt-2">
              <div className="flex items-center space-x-2">
                <GitBranch className="w-4 h-4 text-forge-cyan" />
                <span>Repo: <strong className="text-slate-200">{activeProject?.repository_path || 'Current Workspace'}</strong></span>
              </div>
              <div className="flex items-center space-x-2">
                <ShieldCheck className="w-4 h-4 text-forge-emerald" />
                <span>Branch: <strong className="text-slate-200">{activeProject?.default_branch || 'main'}</strong></span>
              </div>
            </div>
          </div>

          {/* Overall Progress Widget */}
          <div className="w-full lg:w-80 bg-surface/80 p-5 rounded-xl border border-surface-border space-y-3 shrink-0">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono uppercase tracking-wider text-slate-400">Project Progress</span>
              <span className="text-lg font-mono font-bold text-forge-cyan">{totalProgress}%</span>
            </div>
            <ProgressIndicator percent={totalProgress} size="lg" />
            <div className="flex justify-between text-[11px] font-mono text-slate-400">
              <span>{completedTasks}/{tasks.length} Tasks Finished</span>
              <span className="text-emerald-400 font-semibold">HEALTHY</span>
            </div>
          </div>
        </div>
      </div>

      {/* KPI Cards Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <div className="bg-surface-card border border-surface-border rounded-xl p-5 shadow space-y-2">
          <div className="flex items-center justify-between text-slate-400 text-xs font-mono">
            <span>ACTIVE WORK</span>
            <Activity className="w-4 h-4 text-forge-cyan" />
          </div>
          <div className="text-2xl font-bold text-white font-mono">{activeTasks}</div>
          <div className="text-xs text-slate-400">Tasks currently coding / reviewing</div>
        </div>

        <div className="bg-surface-card border border-surface-border rounded-xl p-5 shadow space-y-2">
          <div className="flex items-center justify-between text-slate-400 text-xs font-mono">
            <span>COMPLETED</span>
            <CheckCircle2 className="w-4 h-4 text-forge-emerald" />
          </div>
          <div className="text-2xl font-bold text-white font-mono">{completedTasks}</div>
          <div className="text-xs text-slate-400">Passed Manager verification</div>
        </div>

        <div className="bg-surface-card border border-surface-border rounded-xl p-5 shadow space-y-2">
          <div className="flex items-center justify-between text-slate-400 text-xs font-mono">
            <span>BLOCKERS / ESCALATED</span>
            <AlertTriangle className="w-4 h-4 text-forge-rose" />
          </div>
          <div className="text-2xl font-bold text-white font-mono">{blockedTasks}</div>
          <div className="text-xs text-slate-400">Requires owner or policy review</div>
        </div>

        <div className="bg-surface-card border border-surface-border rounded-xl p-5 shadow space-y-2">
          <div className="flex items-center justify-between text-slate-400 text-xs font-mono">
            <span>CAPACITY RISK</span>
            <Zap className="w-4 h-4 text-forge-amber" />
          </div>
          <div className="text-2xl font-bold text-emerald-400 font-mono">LOW</div>
          <div className="text-xs text-slate-400">Active quotas sufficient for tasks</div>
        </div>
      </div>

      {/* Active Agents Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <Sparkles className="w-5 h-5 text-forge-cyan" />
            <h3 className="text-base font-semibold text-white">Active AI Agents & Observable Actions</h3>
          </div>
          <button
            onClick={() => setActiveView('agent-center')}
            className="text-xs font-mono text-forge-cyan hover:underline flex items-center space-x-1"
          >
            <span>View All Agents</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {agents.map((agent) => {
            const res = resources.find((r) => r.id === agent.provider_resource_id);
            const task = tasks.find((t) => t.id === agent.current_task_id);
            return (
              <AgentCard
                key={agent.id}
                agent={agent}
                resource={res}
                assignedTask={task}
                onViewTask={(taskId) => {
                  setSelectedTaskId(taskId);
                  setActiveView('task-board');
                }}
              />
            );
          })}
        </div>
      </div>

      {/* Bottom Section: Owner Attention & Live Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Owner Attention Panel (Left 1 col) */}
        <div className="bg-surface-card border border-surface-border rounded-xl p-6 shadow-lg space-y-4">
          <h3 className="text-sm font-semibold text-white font-mono uppercase tracking-wider flex items-center space-x-2">
            <span className="w-2 h-2 rounded-full bg-forge-emerald"></span>
            <span>Owner Attention Panel</span>
          </h3>

          {blockedTasks === 0 ? (
            <div className="p-4 bg-emerald-950/20 border border-emerald-800/30 rounded-lg text-xs text-emerald-300 space-y-1">
              <div className="font-semibold">All Systems Operating Normally</div>
              <p className="text-slate-400">
                0 high-authority escalations or unresolved blockers. Models are progressing through work orders cleanly.
              </p>
            </div>
          ) : (
            <div className="p-4 bg-rose-950/20 border border-rose-800/30 rounded-lg text-xs text-rose-300 space-y-2">
              <div className="font-semibold">{blockedTasks} Task(s) Require Human Attention</div>
              <button
                onClick={() => setActiveView('task-board')}
                className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded text-[11px] font-semibold transition"
              >
                Inspect Blocked Tasks
              </button>
            </div>
          )}

          <div className="p-4 bg-surface rounded-lg border border-surface-border space-y-2 text-xs">
            <div className="text-slate-400 font-mono">Manual Bridge Relay:</div>
            <p className="text-slate-300">
              Use the <strong>Manual Bridge</strong> to relay Work Orders to Gemini Coder and Review Packages to ChatGPT Manager.
            </p>
            <button
              onClick={() => setActiveView('manual-bridge')}
              className="w-full mt-2 py-2 bg-forge-cyan/20 hover:bg-forge-cyan/30 text-forge-cyan font-mono font-semibold rounded-md border border-forge-cyan/30 transition text-xs flex items-center justify-center space-x-2"
            >
              <span>OPEN MANUAL BRIDGE</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Live Activity Stream (Right 2 cols) */}
        <div className="lg:col-span-2 bg-surface-card border border-surface-border rounded-xl p-6 shadow-lg space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white font-mono uppercase tracking-wider flex items-center space-x-2">
              <Clock className="w-4 h-4 text-forge-cyan" />
              <span>Live Orchestration Stream</span>
            </h3>
            <button
              onClick={() => setActiveView('timeline')}
              className="text-xs font-mono text-forge-cyan hover:underline"
            >
              Full Audit Timeline
            </button>
          </div>

          <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
            {events.length === 0 ? (
              <div className="text-xs text-slate-500 font-mono py-6 text-center">
                No events recorded yet.
              </div>
            ) : (
              events.slice(0, 6).map((ev) => (
                <div
                  key={ev.id}
                  className="p-3 bg-surface/60 rounded-lg border border-surface-border flex items-start space-x-3 text-xs"
                >
                  <div className="w-2 h-2 rounded-full bg-forge-cyan mt-1.5 shrink-0"></div>
                  <div className="flex-1 space-y-0.5">
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-semibold text-slate-200">{ev.type}</span>
                      <span className="font-mono text-[10px] text-slate-500">
                        {new Date(ev.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <p className="text-slate-400">{ev.summary}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
