import React from 'react';
import { useOrchestrator } from '../context/OrchestratorContext';
import { UIDensityMode } from '../../core/types/domain';
import { ShieldAlert, Play, Pause, FolderGit2, Activity, Cpu } from 'lucide-react';

export const Header: React.FC = () => {
  const {
    activeProject,
    projects,
    setActiveProject,
    densityMode,
    setDensityMode,
    setIsEmergencyStopOpen,
    transitionProject,
    resumeProject,
    tasks,
    agents,
  } = useOrchestrator();

  const doneTasks = tasks.filter((t) => t.state === 'DONE').length;
  const activeAgents = agents.filter((a) => a.status === 'ACTIVE' || a.status === 'BUSY').length;

  const getStatusColor = (status?: string) => {
    switch (status) {
      case 'RUNNING':
        return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30';
      case 'PAUSED':
        return 'bg-amber-500/20 text-amber-400 border-amber-500/30';
      case 'BLOCKED':
        return 'bg-rose-500/20 text-rose-400 border-rose-500/30';
      case 'COMPLETED':
        return 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30';
      default:
        return 'bg-slate-700/50 text-slate-300 border-slate-600';
    }
  };

  return (
    <header className="h-16 bg-surface border-b border-surface-border px-6 flex items-center justify-between shrink-0 z-30">
      {/* Left: Brand & Project Selector */}
      <div className="flex items-center space-x-6">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-forge-cyan to-forge-blue flex items-center justify-center shadow-lg shadow-cyan-900/30">
            <span className="font-mono font-bold text-white text-sm">AF</span>
          </div>
          <div>
            <h1 className="text-sm font-semibold text-white tracking-wide uppercase font-mono">Agent-Forge</h1>
            <span className="text-xs text-slate-400 block -mt-0.5">Control Plane</span>
          </div>
        </div>

        {/* Project Selector */}
        <div className="flex items-center space-x-2 pl-4 border-l border-surface-border">
          <FolderGit2 className="w-4 h-4 text-slate-400" />
          <select
            value={activeProject?.id || ''}
            onChange={(e) => {
              const selected = projects.find((p) => p.id === e.target.value);
              setActiveProject(selected || null);
            }}
            className="bg-surface-card border border-surface-border text-sm text-slate-200 rounded-md px-2.5 py-1.5 focus:outline-none focus:border-forge-cyan"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.id})
              </option>
            ))}
          </select>

          {activeProject && (
            <div className={`px-2.5 py-1 rounded-full text-xs font-mono font-medium border flex items-center space-x-1.5 ${getStatusColor(activeProject.status)}`}>
              <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse"></span>
              <span>{activeProject.status}</span>
            </div>
          )}
        </div>
      </div>

      {/* Middle: Quick Metrics */}
      <div className="hidden lg:flex items-center space-x-8 text-xs font-mono text-slate-400">
        <div className="flex items-center space-x-2">
          <Activity className="w-4 h-4 text-forge-cyan" />
          <span>Tasks: <strong className="text-slate-100">{doneTasks}/{tasks.length}</strong> Done</span>
        </div>
        <div className="flex items-center space-x-2">
          <Cpu className="w-4 h-4 text-forge-emerald" />
          <span>Agents: <strong className="text-slate-100">{activeAgents}</strong> Active</span>
        </div>
      </div>

      {/* Right: UI Density Mode & Controls */}
      <div className="flex items-center space-x-4">
        {/* Density Mode Switch */}
        <div className="bg-surface-card p-1 rounded-lg border border-surface-border flex items-center text-xs font-mono">
          {(['OWNER', 'ENGINEER', 'DEBUG'] as UIDensityMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => setDensityMode(mode)}
              className={`px-2.5 py-1 rounded transition-all ${
                densityMode === mode
                  ? 'bg-forge-cyan/20 text-forge-cyan font-semibold shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {mode}
            </button>
          ))}
        </div>

        {/* Project Run/Pause Button */}
        {activeProject?.status === 'READY' && (
          <button
            onClick={() => transitionProject('START_PROJECT')}
            className="px-3 py-1.5 bg-forge-emerald hover:bg-emerald-600 text-slate-950 font-semibold text-xs rounded-md flex items-center space-x-1.5 shadow-md shadow-emerald-950/40 transition"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>START PROJECT</span>
          </button>
        )}

        {activeProject?.status === 'RUNNING' && (
          <button
            onClick={() => transitionProject('PAUSE')}
            className="px-3 py-1.5 bg-amber-500/20 border border-amber-500/40 hover:bg-amber-500/30 text-amber-300 font-semibold text-xs rounded-md flex items-center space-x-1.5 transition"
          >
            <Pause className="w-3.5 h-3.5" />
            <span>PAUSE</span>
          </button>
        )}

        {activeProject?.status === 'PAUSED' && (
          <button
            onClick={resumeProject}
            className="px-3 py-1.5 bg-emerald-500/20 border border-emerald-500/40 hover:bg-emerald-500/30 text-emerald-300 font-semibold text-xs rounded-md flex items-center space-x-1.5 transition"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>RESUME</span>
          </button>
        )}

        {/* Emergency Stop Button */}
        <button
          onClick={() => setIsEmergencyStopOpen(true)}
          className="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-700 text-white font-mono font-bold text-xs rounded-md flex items-center space-x-2 shadow-lg shadow-rose-950/60 glow-rose transition"
        >
          <ShieldAlert className="w-4 h-4" />
          <span>EMERGENCY STOP</span>
        </button>
      </div>
    </header>
  );
};
