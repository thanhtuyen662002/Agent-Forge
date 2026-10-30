import React from 'react';
import { BrandMark } from './BrandMark';
import { useOrchestrator } from '../context/OrchestratorContext';
import { useI18n } from '../context/I18nContext';
import { ShieldAlert, Play, Pause, FolderGit2 } from 'lucide-react';
import { uiActionFailureKey } from '../actionState';
import { AutomationStatusBadge } from './AutomationStatusBadge';
import { UpdateNotice } from './UpdateNotice';
import { AuthorityHelp } from './AuthorityHelp';

/**
 * One calm row: brand, the active project with its status and automation
 * phase, then only the project's primary action and the emergency stop.
 * View preferences (language, density) live in the sidebar footer.
 */
export const Header: React.FC = () => {
  const {
    activeProject,
    projects,
    setActiveProject,
    setActiveView,
    setIsEmergencyStopOpen,
    transitionProject,
    resumeProject,
    isElectron,
    pendingActions,
    actionResults,
  } = useOrchestrator();

  const { t } = useI18n();
  const actionPending = pendingActions.includes('projectTransition');
  const actionResult = actionResults.projectTransition;
  const actionNotice = actionPending ? t('actions.pending') : actionResult
    ? actionResult.success ? t('actions.success') : t(uiActionFailureKey(actionResult.code))
    : null;

  const getStatusColor = (status?: string) => {
    switch (status) {
      case 'RUNNING':
        return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
      case 'PAUSED':
        return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
      case 'BLOCKED':
        return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
      case 'COMPLETED':
        return 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30';
      default:
        return 'bg-slate-700/40 text-slate-300 border-slate-600';
    }
  };

  const getStatusLabel = (status?: string) => {
    switch (status) {
      case 'READY':
        return t('header.statusReady');
      case 'RUNNING':
        return t('header.statusRunning');
      case 'PAUSED':
        return t('header.statusPaused');
      case 'BLOCKED':
        return t('header.statusBlocked');
      case 'COMPLETED':
        return t('header.statusCompleted');
      default:
        return status || '';
    }
  };

  const primaryButton = 'h-8 px-3 text-xs font-semibold rounded-md flex items-center gap-1.5 transition whitespace-nowrap disabled:opacity-50';

  return (
    <header className="h-14 bg-surface border-b border-surface-border px-4 flex items-center gap-4 shrink-0 z-30">
      {/* Brand: as wide as the sidebar, so its divider continues the sidebar's border. */}
      <div className="w-60 self-stretch flex items-center gap-2.5 shrink-0 border-r border-surface-border">
        <BrandMark className="w-7 h-7 shrink-0" />
        <span className="text-sm font-semibold text-white whitespace-nowrap">Agent Forge</span>
        {!isElectron && (
          <span title={t('actions.previewReadOnly')} className="min-w-0 truncate mr-3 text-[10px] px-1.5 py-0.5 rounded border border-surface-border text-slate-400 whitespace-nowrap">{t('actions.previewReadOnly')}</span>
        )}
      </div>

      {/* Active project */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <FolderGit2 className="w-4 h-4 text-slate-500 shrink-0" aria-hidden="true" />
        {projects.length > 0 ? (
          <>
            <select
              aria-label={t('header.projectSelectorLabel')}
              title={activeProject ? `${activeProject.name} (${activeProject.id})` : undefined}
              value={activeProject?.id || ''}
              disabled={pendingActions.length > 0}
              onChange={(e) => {
                const selected = projects.find((p) => p.id === e.target.value);
                setActiveProject(selected || null);
              }}
              className="h-8 max-w-[16rem] min-w-0 truncate bg-surface-card border border-surface-border text-sm text-slate-100 rounded-md px-2 focus:outline-none focus:border-forge-cyan"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>

            {activeProject && (
              <span className={`h-6 px-2 rounded-full text-[11px] font-medium border flex items-center gap-1.5 shrink-0 whitespace-nowrap ${getStatusColor(activeProject.status)}`}>
                <span className={`w-1.5 h-1.5 rounded-full bg-current ${activeProject.status === 'RUNNING' ? 'animate-pulse' : ''}`}></span>
                {getStatusLabel(activeProject.status)}
              </span>
            )}
            {activeProject && (
              <div className="min-w-0 hidden md:block">
                <AutomationStatusBadge projectId={activeProject.id} />
              </div>
            )}
            <AuthorityHelp />
          </>
        ) : (
          <button
            onClick={() => setActiveView('projects')}
            className="h-8 text-xs text-slate-300 hover:text-forge-cyan transition bg-surface-card border border-surface-border rounded-md px-2.5"
          >
            {t('header.noProject')}
          </button>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 shrink-0">
        <UpdateNotice />
        {actionNotice && (
          <span
            role={actionResult && !actionResult.success && !actionPending ? 'alert' : 'status'}
            title={actionNotice}
            className="max-w-[14rem] truncate text-xs text-slate-300 whitespace-nowrap"
          >
            {actionNotice}
          </span>
        )}

        {activeProject?.status === 'READY' && (
          <button
            onClick={() => transitionProject('START_PROJECT')}
            disabled={!isElectron || actionPending}
            aria-busy={actionPending}
            title={!isElectron ? t('actions.desktopRequired') : undefined}
            className={`${primaryButton} bg-forge-emerald hover:bg-emerald-500 text-slate-950`}
          >
            <Play className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
            <span>{actionPending ? t('actions.pending') : t('header.startProject')}</span>
          </button>
        )}

        {activeProject?.status === 'RUNNING' && (
          <button
            onClick={() => transitionProject('PAUSE')}
            disabled={!isElectron || actionPending}
            aria-busy={actionPending}
            title={!isElectron ? t('actions.desktopRequired') : undefined}
            className={`${primaryButton} border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-200`}
          >
            <Pause className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{actionPending ? t('actions.pending') : t('header.pause')}</span>
          </button>
        )}

        {activeProject?.status === 'PAUSED' && (
          <button
            onClick={resumeProject}
            disabled={!isElectron || actionPending}
            aria-busy={actionPending}
            title={!isElectron ? t('actions.desktopRequired') : undefined}
            className={`${primaryButton} border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-200`}
          >
            <Play className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
            <span>{actionPending ? t('actions.pending') : t('header.resume')}</span>
          </button>
        )}

        <button
          onClick={() => setIsEmergencyStopOpen(true)}
          disabled={!isElectron}
          title={!isElectron ? t('actions.desktopRequired') : undefined}
          className={`${primaryButton} bg-rose-600 hover:bg-rose-700 text-white`}
        >
          <ShieldAlert className="w-4 h-4" aria-hidden="true" />
          <span>{t('emergencyStop.button')}</span>
        </button>
      </div>
    </header>
  );
};
