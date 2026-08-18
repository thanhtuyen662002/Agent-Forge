import React from 'react';
import { useOrchestrator } from '../context/OrchestratorContext';
import { useI18n } from '../context/I18nContext';
import {
  LayoutDashboard,
  ArrowLeftRight,
  Kanban,
  Bot,
  Cpu,
  History,
  Scale,
  ShieldCheck,
  FolderGit2,
  Sliders,
  Bug,
} from 'lucide-react';

export const Sidebar: React.FC = () => {
  const { activeView, setActiveView, tasks, densityMode } = useOrchestrator();
  const { t } = useI18n();

  const pendingBridgeTasks = tasks.filter(
    (t) => t.state === 'CODING' || t.state === 'REVIEW_READY' || t.state === 'PLANNED'
  ).length;

  const navItems = [
    { id: 'dashboard', label: t('nav.dashboard'), icon: LayoutDashboard },
    { id: 'manual-bridge', label: t('nav.manualBridge'), icon: ArrowLeftRight, badge: pendingBridgeTasks },
    { id: 'task-board', label: 'Task Board', icon: Kanban, badge: tasks.length },
    { id: 'agent-center', label: 'Agent Center', icon: Bot },
    { id: 'capacity', label: 'Capacity & Quota', icon: Cpu },
    { id: 'timeline', label: t('nav.timeline'), icon: History },
    { id: 'decisions', label: 'Decisions & Authority', icon: Scale },
    { id: 'evidence', label: t('nav.evidence'), icon: ShieldCheck },
    { id: 'projects', label: 'Projects & Contract', icon: FolderGit2 },
    { id: 'settings', label: t('nav.settings'), icon: Sliders },
  ];

  if (densityMode === 'DEBUG') {
    navItems.push({ id: 'debug', label: 'Debug & Simulator', icon: Bug, badge: undefined });
  }

  return (
    <aside className="w-64 bg-surface border-r border-surface-border flex flex-col justify-between shrink-0 select-none">
      <div className="py-4 px-3 space-y-1">
        <div className="px-3 py-1.5 text-xs font-mono font-semibold text-slate-500 uppercase tracking-wider">
          Orchestration
        </div>
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setActiveView(item.id)}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-medium transition-all ${
                isActive
                  ? 'bg-forge-cyan/15 text-forge-cyan border border-forge-cyan/30 shadow-sm font-semibold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-surface-card'
              }`}
            >
              <div className="flex items-center space-x-3">
                <Icon className={`w-4 h-4 ${isActive ? 'text-forge-cyan' : 'text-slate-400'}`} />
                <span>{item.label}</span>
              </div>
              {item.badge !== undefined && item.badge > 0 && (
                <span
                  className={`px-1.5 py-0.5 rounded-full text-[10px] font-mono ${
                    item.id === 'manual-bridge'
                      ? 'bg-forge-amber/20 text-forge-amber font-bold border border-forge-amber/30'
                      : 'bg-surface-border text-slate-300'
                  }`}
                >
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Footer Info */}
      <div className="p-4 border-t border-surface-border bg-surface-card/40">
        <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
          <span>Mode: <strong className="text-slate-200">{densityMode}</strong></span>
          <span className="text-emerald-400 flex items-center space-x-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
            <span>ONLINE</span>
          </span>
        </div>
        <div className="text-[10px] text-slate-500 mt-1 truncate">
          Offline SQLite • Local-First
        </div>
      </div>
    </aside>
  );
};
