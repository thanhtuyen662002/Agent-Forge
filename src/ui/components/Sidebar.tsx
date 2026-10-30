import React from 'react';
import { useOrchestrator } from '../context/OrchestratorContext';
import { useI18n } from '../context/I18nContext';
import { deriveConnectivityState } from '../capacityTruth';
import type { UIDensityMode } from '../../core/types/domain';
import {
  LayoutDashboard,
  ArrowLeftRight,
  Kanban,
  Bot,
  Cpu,
  History,
  ShieldCheck,
  FolderGit2,
  Sliders,
  Bug,
  Languages,
} from 'lucide-react';

export const Sidebar: React.FC = () => {
  const { activeView, setActiveView, tasks, densityMode, setDensityMode, isElectron, loading, refreshError, hasRefreshed } = useOrchestrator();
  const { t, locale, setLocale } = useI18n();
  const connectivity = deriveConnectivityState({ isElectron, loading, refreshError, hasRefreshed });
  const connectivityLabel = t(`sidebar.${connectivity === 'ONLINE' ? 'online' : connectivity === 'CONNECTING' ? 'connecting' : connectivity === 'ERROR' ? 'error' : 'browserPreview'}`);
  // Counts refreshes; a new key restarts the one-shot ripple animation.
  const [refreshPulse, setRefreshPulse] = React.useState(0);
  React.useEffect(() => {
    if (loading) setRefreshPulse((value) => value + 1);
  }, [loading]);

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

      {/* View preferences and connection state */}
      <div className="p-3 border-t border-surface-border bg-surface-card/40 space-y-2.5">
        <div role="group" aria-label={t('sidebar.mode')} className="grid grid-cols-3 gap-1 bg-surface rounded-lg p-1 border border-surface-border">
          {(['OWNER', 'ENGINEER', 'DEBUG'] as UIDensityMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={densityMode === mode}
              onClick={() => setDensityMode(mode)}
              className={`px-1 py-1 rounded text-[11px] truncate transition ${
                densityMode === mode ? 'bg-forge-cyan/20 text-forge-cyan font-semibold' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {getModeLabel(mode)}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <button
            type="button"
            onClick={() => setLocale(locale === 'vi-VN' ? 'en-US' : 'vi-VN')}
            aria-label={t('language.selectorLabel')}
            title={t('language.selectorLabel')}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-surface-border hover:text-white hover:border-slate-500 transition"
          >
            <Languages className="w-3.5 h-3.5 text-forge-cyan" aria-hidden="true" />
            <span className="font-medium">{locale === 'vi-VN' ? 'Tiếng Việt' : 'English'}</span>
          </button>
          {/* A dot instead of words (#358); each data refresh sends one ripple out of it. */}
          <span role="status" aria-live="polite" title={connectivityLabel} className="relative mr-1 flex items-center justify-center w-4 h-4">
            {refreshPulse > 0 && connectivity === 'ONLINE' && (
              <span key={refreshPulse} aria-hidden="true" className="af-ripple absolute inset-0.5 rounded-full bg-emerald-400" />
            )}
            <span
              aria-hidden="true"
              className={`relative w-2.5 h-2.5 rounded-full ${
                connectivity === 'ONLINE'
                  ? 'bg-emerald-400'
                  : connectivity === 'CONNECTING'
                  ? 'bg-amber-400 animate-pulse'
                  : connectivity === 'ERROR'
                  ? 'bg-rose-400'
                  : 'bg-slate-400'
              }`}
            ></span>
            <span className="sr-only">{connectivityLabel}</span>
          </span>
        </div>
      </div>
    </aside>
  );
};
