import React, { useState } from 'react';
import { useOrchestrator } from '../context/OrchestratorContext';
import { useI18n } from '../context/I18nContext';
import { Bug, Zap, AlertTriangle, ShieldCheck, Database, RefreshCw } from 'lucide-react';

export const DebugView: React.FC = () => {
  const { isElectron, activeProject, tasks, resources } = useOrchestrator();
  const { t } = useI18n();
  const [simStatus, setSimStatus] = useState<string | null>(null);

  const handleSimulateQuotaExhaustion = () => {
    setSimStatus(t('debug.simQuotaExhaustionStatus'));
  };

  const handleSimulateCrash = () => {
    setSimStatus(t('debug.simCrashStatus'));
  };

  const handleSimulateInvalidProtocol = () => {
    setSimStatus(t('debug.simInvalidProtocolStatus'));
  };

  return (
    <div className="p-8 space-y-8 max-w-6xl mx-auto overflow-y-auto">
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight flex items-center space-x-2.5">
          <Bug className="w-5 h-5 text-forge-amber" />
          <span>{t('debug.title')}</span>
        </h2>
        <p className="text-xs text-slate-400">
          {t('debug.subtitle')}
        </p>
      </div>

      {/* Simulator Actions */}
      <div className="bg-surface-card border border-surface-border rounded-xl p-6 shadow-lg space-y-4">
        <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider flex items-center space-x-2">
          <Zap className="w-4 h-4 text-forge-amber" />
          <span>{t('debug.chaosTitle')}</span>
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <button
            onClick={handleSimulateQuotaExhaustion}
            className="p-4 bg-surface hover:bg-surface-hover border border-surface-border rounded-xl text-left space-y-2 transition"
          >
            <div className="font-mono font-bold text-xs text-forge-amber flex items-center space-x-2">
              <AlertTriangle className="w-4 h-4" />
              <span>{t('debug.quotaExhaustionTitle')}</span>
            </div>
            <p className="text-[11px] text-slate-400">
              {t('debug.quotaExhaustionDesc')}
            </p>
          </button>

          <button
            onClick={handleSimulateCrash}
            className="p-4 bg-surface hover:bg-surface-hover border border-surface-border rounded-xl text-left space-y-2 transition"
          >
            <div className="font-mono font-bold text-xs text-forge-rose flex items-center space-x-2">
              <Bug className="w-4 h-4" />
              <span>{t('debug.processCrashTitle')}</span>
            </div>
            <p className="text-[11px] text-slate-400">
              {t('debug.processCrashDesc')}
            </p>
          </button>

          <button
            onClick={handleSimulateInvalidProtocol}
            className="p-4 bg-surface hover:bg-surface-hover border border-surface-border rounded-xl text-left space-y-2 transition"
          >
            <div className="font-mono font-bold text-xs text-forge-cyan flex items-center space-x-2">
              <ShieldCheck className="w-4 h-4" />
              <span>{t('debug.invalidProtocolTitle')}</span>
            </div>
            <p className="text-[11px] text-slate-400">
              {t('debug.invalidProtocolDesc')}
            </p>
          </button>
        </div>

        {simStatus && (
          <div className="p-4 bg-surface rounded-xl border border-forge-amber/40 text-xs font-mono text-amber-200">
            {simStatus}
          </div>
        )}
      </div>

      {/* Runtime Diagnostics */}
      <div className="bg-surface-card border border-surface-border rounded-xl p-6 shadow-lg space-y-3 font-mono text-xs">
        <h3 className="font-semibold text-slate-300 uppercase tracking-wider flex items-center space-x-2">
          <Database className="w-4 h-4 text-forge-cyan" />
          <span>{t('debug.diagnosticsTitle')}</span>
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-2">
          <div className="p-3 bg-surface rounded-lg border border-surface-border">
            <span className="text-slate-500 block text-[10px]">{t('debug.ipcBridgeLabel')}</span>
            <strong className={isElectron ? 'text-emerald-400' : 'text-amber-400'}>
              {isElectron ? t('debug.ipcElectronActive') : t('debug.ipcBrowserPreview')}
            </strong>
          </div>
          <div className="p-3 bg-surface rounded-lg border border-surface-border">
            <span className="text-slate-500 block text-[10px]">{t('debug.databaseLabel')}</span>
            <strong className="text-forge-cyan">BETTER-SQLITE3 (WAL)</strong>
          </div>
          <div className="p-3 bg-surface rounded-lg border border-surface-border">
            <span className="text-slate-500 block text-[10px]">{t('debug.totalTasksLabel')}</span>
            <strong className="text-white">{tasks.length}</strong>
          </div>
          <div className="p-3 bg-surface rounded-lg border border-surface-border">
            <span className="text-slate-500 block text-[10px]">{t('debug.activeResourcesLabel')}</span>
            <strong className="text-white">{resources.length}</strong>
          </div>
        </div>
      </div>
    </div>
  );
};
