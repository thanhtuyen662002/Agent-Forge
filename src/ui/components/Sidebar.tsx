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
    { id: 'task-board', label: t('nav.taskBoard'), icon: Kanban, badge: tasks.length },
    { id: 'agent-center', label: t('nav.agentCenter'), icon: Bot },
    { id: 'capacity', label: t('nav.capacity'), icon: Cpu },
    { id: 'timeline', label: t('nav.timeline'), icon: History },
    { id: 'decisions', label: t('nav.decisions'), icon: Scale },
    { id: 'evidence', label: t('nav.evidence'), icon: ShieldCheck },
    { id: 'projects', label: t('nav.projects'), icon: FolderGit2 },
    { id: 'settings', label: t('nav.settings'), icon: Sliders },
  ];

  if (densityMode === 'DEBUG') {
    navItems.push({ id: 'debug', label: t('nav.debug'), icon: Bug, badge: undefined });
  }

  const getModeLabel = (mode: string) => {
    switch (mode) {
      case 'OWNER':
        return t('header.modeOwner');
      case 'ENGINEER':
        return t('header.modeEngineer');
      case 'DEBUG':
        return t('header.modeDebug');
      default:
        return mode;
    }
  };

  return (
    <aside className="w-64 bg-surface border-r border-surface-border flex flex-col justify-between shrink-0 select-none">
      <div className="py-4 px-3 space-y-1">
        <div className="px-3 py-1.5 text-xs font-mono font-semibold text-slate-500 uppercase tracking-wider">
          {t('sidebar.orchestration')}
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
          <span>{t('sidebar.mode')}: <strong className="text-slate-200">{getModeLabel(densityMode)}</strong></span>
          <span className="text-emerald-400 flex items-center space-x-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
            <span>{t('sidebar.online')}</span>
          </span>
        </div>
        <div className="text-[10px] text-slate-500 mt-1 truncate">
          {t('sidebar.offlineTag')}
        </div>
      </div>
    </aside>
  );
};
