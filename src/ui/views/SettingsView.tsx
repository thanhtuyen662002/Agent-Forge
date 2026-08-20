import React, { useState, useEffect } from 'react';
import { useI18n } from '../context/I18nContext';
import {
  Sliders,
  Shield,
  Terminal,
  Save,
  Check,
  RefreshCw,
  Download,
  AlertCircle,
  CheckCircle2,
  Info,
  Languages,
  ArrowUpCircle,
  RotateCw,
  Cpu,
  Layers,
  Database,
} from 'lucide-react';
import { UpdateStateSummary } from '../../core/types/domain';

export const SettingsView: React.FC = () => {
  const { locale, setLocale, t } = useI18n();

  // Verification commands & policy state
  const [testCmd, setTestCmd] = useState<string>('npm test');
  const [lintCmd, setLintCmd] = useState<string>('npm run lint');
  const [buildCmd, setBuildCmd] = useState<string>('npm run build');
  const [maxRevisions, setMaxRevisions] = useState<number>(3);
  const [saved, setSaved] = useState<boolean>(false);

  // App & Update State
  const [appInfo, setAppInfo] = useState<{ version: string; isPackaged: boolean; platform: string; arch: string }>({
    version: '0.1.0',
    isPackaged: false,
    platform: 'win32',
    arch: 'x64',
  });
  const [updateSummary, setUpdateSummary] = useState<UpdateStateSummary>({
    state: 'IDLE',
    currentVersion: '0.1.0',
    updateInfo: null,
    progress: null,
    error: null,
    isPackaged: false,
    isCodeSigned: false,
    canInstall: false,
    lastCheckedAt: null,
  });
  const [isActionLoading, setIsActionLoading] = useState<boolean>(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const fetchState = async () => {
    try {
      if ((window as any).orchestrator) {
        const infoRes = await (window as any).orchestrator.getAppInfo();
        if (infoRes?.success && infoRes.info) {
          setAppInfo(infoRes.info);
        }
        const updateRes = await (window as any).orchestrator.getUpdateState();
        if (updateRes?.success && updateRes.summary) {
          setUpdateSummary(updateRes.summary);
        }
      }
    } catch (err: any) {
      console.warn('Failed to fetch update/app state:', err);
    }
  };

  useEffect(() => {
    fetchState();
    const interval = setInterval(fetchState, 3000);
    return () => clearInterval(interval);
  }, []);

  const handleCheckForUpdates = async () => {
    setIsActionLoading(true);
    setUpdateError(null);
    try {
      if ((window as any).orchestrator) {
        const res = await (window as any).orchestrator.checkForUpdates();
        if (res?.success && res.summary) {
          setUpdateSummary(res.summary);
        } else if (res?.error) {
          setUpdateError(res.error);
        }
      }
    } catch (err: any) {
      setUpdateError(err.message || 'Failed to check for updates');
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleDownloadUpdate = async () => {
    setIsActionLoading(true);
    setUpdateError(null);
    try {
      if ((window as any).orchestrator) {
        const res = await (window as any).orchestrator.downloadUpdate();
        if (res?.success && res.summary) {
          setUpdateSummary(res.summary);
        } else if (res?.error) {
          setUpdateError(res.error);
        }
      }
    } catch (err: any) {
      setUpdateError(err.message || 'Failed to download update');
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleInstallAndRestart = async () => {
    setIsActionLoading(true);
    setUpdateError(null);
    try {
      if ((window as any).orchestrator) {
        const res = await (window as any).orchestrator.installAndRestartUpdate();
        if (!res?.success && res?.error) {
          setUpdateError(res.error);
        }
      }
    } catch (err: any) {
      setUpdateError(err.message || 'Failed to trigger install and restart');
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const getUpdateStateBadge = () => {
    switch (updateSummary.state) {
      case 'CHECKING':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-mono bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 flex items-center space-x-1.5">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            <span>{t('update.stateChecking')}</span>
          </span>
        );
      case 'UPDATE_AVAILABLE':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-mono bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center space-x-1.5">
            <ArrowUpCircle className="w-3.5 h-3.5" />
            <span>{t('update.stateAvailable')}: {updateSummary.updateInfo?.version}</span>
          </span>
        );
      case 'DOWNLOADING':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-mono bg-blue-500/20 text-blue-400 border border-blue-500/30 flex items-center space-x-1.5">
            <Download className="w-3.5 h-3.5 animate-bounce" />
            <span>{t('update.stateDownloading')} {updateSummary.progress?.percent || 0}%</span>
          </span>
        );
      case 'DOWNLOADED':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-mono bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center space-x-1.5">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>{t('update.stateDownloaded')}</span>
          </span>
        );
      case 'NO_UPDATE_AVAILABLE':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-mono bg-slate-700/50 text-slate-300 border border-slate-600 flex items-center space-x-1.5">
            <Check className="w-3.5 h-3.5 text-emerald-400" />
            <span>{t('update.stateNoUpdate')}</span>
          </span>
        );
      case 'DISABLED':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-mono bg-amber-500/20 text-amber-400 border border-amber-500/30 flex items-center space-x-1.5">
            <Info className="w-3.5 h-3.5" />
            <span>{t('update.stateDisabled')}</span>
          </span>
        );
      case 'ERROR':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-mono bg-rose-500/20 text-rose-400 border border-rose-500/30 flex items-center space-x-1.5">
            <AlertCircle className="w-3.5 h-3.5" />
            <span>{t('update.stateError')}</span>
          </span>
        );
      default:
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-mono bg-slate-800 text-slate-400 border border-surface-border">
            {t('update.stateIdle')}
          </span>
        );
    }
  };

  return (
    <div className="p-8 space-y-8 max-w-5xl mx-auto overflow-y-auto">
      {/* Header */}
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight flex items-center space-x-2.5">
          <Sliders className="w-5 h-5 text-forge-cyan" />
          <span>{t('nav.settings')}</span>
        </h2>
        <p className="text-xs text-slate-400">
          {t('about.subtitle')}
        </p>
      </div>

      {/* 1. Language & Internationalization */}
      <div className="bg-surface-card border border-surface-border rounded-xl p-6 shadow-lg space-y-4">
        <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider flex items-center space-x-2">
          <Languages className="w-4 h-4 text-forge-cyan" />
          <span>{t('language.selectorLabel')}</span>
        </h3>
        <div className="flex items-center space-x-4">
          <button
            onClick={() => setLocale('vi-VN')}
            className={`px-4 py-2 rounded-lg text-xs font-mono transition-all flex items-center space-x-2 ${
              locale === 'vi-VN'
                ? 'bg-forge-cyan/20 text-forge-cyan border border-forge-cyan/40 font-bold shadow'
                : 'bg-surface border border-surface-border text-slate-400 hover:text-slate-200'
            }`}
          >
            <span>🇻🇳</span>
            <span>{t('language.vi')}</span>
          </button>
          <button
            onClick={() => setLocale('en-US')}
            className={`px-4 py-2 rounded-lg text-xs font-mono transition-all flex items-center space-x-2 ${
              locale === 'en-US'
                ? 'bg-forge-cyan/20 text-forge-cyan border border-forge-cyan/40 font-bold shadow'
                : 'bg-surface border border-surface-border text-slate-400 hover:text-slate-200'
            }`}
          >
            <span>🇺🇸</span>
            <span>{t('language.en')}</span>
          </button>
        </div>
      </div>

      {/* 2. Software Updates (PR #9 Installed-App Update Foundation) */}
      <div className="bg-surface-card border border-surface-border rounded-xl p-6 shadow-lg space-y-6">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider flex items-center space-x-2">
            <ArrowUpCircle className="w-4 h-4 text-forge-cyan" />
            <span>{t('update.title')}</span>
          </h3>
          {getUpdateStateBadge()}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono bg-surface p-4 rounded-lg border border-surface-border">
          <div>
            <span className="text-slate-500 block">{t('update.currentVersion')}:</span>
            <span className="text-slate-100 font-bold text-sm">{updateSummary.currentVersion || appInfo.version}</span>
          </div>
          <div>
            <span className="text-slate-500 block">{t('update.newestVersion')}:</span>
            <span className="text-slate-100 font-bold text-sm">
              {updateSummary.updateInfo?.version || t('common.na')}
            </span>
          </div>
          {updateSummary.lastCheckedAt && (
            <div className="md:col-span-2 text-[11px] text-slate-500">
              {t('update.lastChecked')}: {new Date(updateSummary.lastCheckedAt).toLocaleString()}
            </div>
          )}
        </div>

        {/* Live Progress Indicator */}
        {updateSummary.state === 'DOWNLOADING' && updateSummary.progress && (
          <div className="space-y-2 bg-surface p-4 rounded-lg border border-surface-border">
            <div className="flex justify-between text-xs font-mono">
              <span className="text-slate-400">{t('update.downloadProgress')}</span>
              <span className="text-forge-cyan font-bold">{updateSummary.progress.percent}%</span>
            </div>
            <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-forge-cyan transition-all duration-300 rounded-full"
                style={{ width: `${updateSummary.progress.percent}%` }}
              />
            </div>
            {updateSummary.progress.transferred && updateSummary.progress.total && (
              <div className="text-[10px] font-mono text-slate-500 text-right">
                {(updateSummary.progress.transferred / (1024 * 1024)).toFixed(1)} MB / {(updateSummary.progress.total / (1024 * 1024)).toFixed(1)} MB
              </div>
            )}
          </div>
        )}

        {/* Update Action Controls */}
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleCheckForUpdates}
            disabled={isActionLoading || updateSummary.state === 'CHECKING' || updateSummary.state === 'DOWNLOADING'}
            className="px-4 py-2 bg-surface hover:bg-surface-card text-slate-200 border border-surface-border rounded-lg text-xs font-mono font-medium flex items-center space-x-2 transition disabled:opacity-50"
          >
            <RotateCw className={`w-3.5 h-3.5 ${updateSummary.state === 'CHECKING' ? 'animate-spin' : ''}`} />
            <span>{updateSummary.state === 'CHECKING' ? t('update.checking') : t('update.checkButton')}</span>
          </button>

          {updateSummary.state === 'UPDATE_AVAILABLE' && (
            <button
              onClick={handleDownloadUpdate}
              disabled={isActionLoading}
              className="px-4 py-2 bg-forge-cyan hover:bg-cyan-600 text-slate-950 rounded-lg text-xs font-mono font-bold flex items-center space-x-2 shadow transition"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{t('update.downloadButton')} ({updateSummary.updateInfo?.version})</span>
            </button>
          )}

          {updateSummary.state === 'DOWNLOADED' && (
            <button
              onClick={handleInstallAndRestart}
              disabled={!updateSummary.canInstall || isActionLoading}
              className={`px-4 py-2 rounded-lg text-xs font-mono font-bold flex items-center space-x-2 shadow transition ${
                updateSummary.canInstall
                  ? 'bg-forge-emerald hover:bg-emerald-600 text-slate-950'
                  : 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed'
              }`}
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>{t('update.installButton')}</span>
            </button>
          )}
        </div>

        {/* Active Work Warning */}
        {updateSummary.state === 'DOWNLOADED' && !updateSummary.canInstall && (
          <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs font-mono text-amber-300 flex items-start space-x-2.5">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              <strong className="block">{t('update.activeWorkWarning')}</strong>
              <span>{t('update.activeWorkWarningDesc')}</span>
            </div>
          </div>
        )}

        {/* Error Display */}
        {(updateError || updateSummary.error) && (
          <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-xs font-mono text-rose-300 flex items-start space-x-2.5">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              <strong className="block">{t('update.errorTitle')}</strong>
              <span>{updateError || updateSummary.error}</span>
            </div>
          </div>
        )}

        {/* Dev Mode Notice */}
        {!appInfo.isPackaged && (
          <div className="p-3 bg-slate-800/60 border border-surface-border rounded-lg text-[11px] font-mono text-slate-400 flex items-center space-x-2">
            <Info className="w-4 h-4 text-slate-500 shrink-0" />
            <span>{t('update.devModeNotice')}</span>
          </div>
        )}
      </div>

      {/* 3. About AgentForge & Architecture */}
      <div className="bg-surface-card border border-surface-border rounded-xl p-6 shadow-lg space-y-6">
        <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider flex items-center space-x-2">
          <Info className="w-4 h-4 text-forge-cyan" />
          <span>{t('about.title')}</span>
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs font-mono">
          <div className="bg-surface p-3 rounded-lg border border-surface-border">
            <span className="text-slate-500 block text-[10px] uppercase">{t('about.version')}</span>
            <span className="text-slate-100 font-bold">{appInfo.version}</span>
          </div>
          <div className="bg-surface p-3 rounded-lg border border-surface-border">
            <span className="text-slate-500 block text-[10px] uppercase">{t('about.buildEnvironment')}</span>
            <span className="text-slate-100 font-bold">{appInfo.isPackaged ? 'Packaged Release' : 'Development'}</span>
          </div>
          <div className="bg-surface p-3 rounded-lg border border-surface-border">
            <span className="text-slate-500 block text-[10px] uppercase">{t('about.platform')}</span>
            <span className="text-slate-100 font-bold">{appInfo.platform} ({appInfo.arch})</span>
          </div>
        </div>

        <div className="space-y-2 text-xs font-mono text-slate-300 bg-surface/60 p-4 rounded-lg border border-surface-border">
          <h4 className="font-bold text-slate-200 flex items-center space-x-2">
            <Database className="w-3.5 h-3.5 text-forge-cyan" />
            <span>{t('about.corePhilosophyTitle')}</span>
          </h4>
          <p className="text-slate-400 leading-relaxed text-[11px]">
            {t('about.corePhilosophyText')}
          </p>
        </div>

        <div className="text-[11px] font-mono text-slate-500 flex justify-between border-t border-surface-border pt-4">
          <span>{t('about.copyright')}</span>
          <span className="text-slate-400">{t('about.signingStatusUnsigned')}</span>
        </div>
      </div>

      {/* 4. Verification Commands & Policies */}
      <div className="bg-surface-card border border-surface-border rounded-xl p-6 shadow-lg space-y-6">
        <div className="space-y-4">
          <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider flex items-center space-x-2">
            <Terminal className="w-4 h-4 text-forge-cyan" />
            <span>{t('settings.verificationCommands.title')}</span>
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs font-mono">
            <div>
              <label className="block text-slate-400 mb-1">{t('settings.verificationCommands.testCmdLabel')}:</label>
              <input
                type="text"
                value={testCmd}
                onChange={(e) => setTestCmd(e.target.value)}
                className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2 text-white focus:outline-none focus:border-forge-cyan"
              />
            </div>

            <div>
              <label className="block text-slate-400 mb-1">{t('settings.verificationCommands.lintCmdLabel')}:</label>
              <input
                type="text"
                value={lintCmd}
                onChange={(e) => setLintCmd(e.target.value)}
                className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2 text-white focus:outline-none focus:border-forge-cyan"
              />
            </div>

            <div>
              <label className="block text-slate-400 mb-1">{t('settings.verificationCommands.buildCmdLabel')}:</label>
              <input
                type="text"
                value={buildCmd}
                onChange={(e) => setBuildCmd(e.target.value)}
                className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2 text-white focus:outline-none focus:border-forge-cyan"
              />
            </div>
          </div>
        </div>

        <div className="space-y-4 pt-4 border-t border-surface-border">
          <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider flex items-center space-x-2">
            <Shield className="w-4 h-4 text-forge-emerald" />
            <span>{t('settings.loopProtection.title')}</span>
          </h3>

          <div className="max-w-xs text-xs font-mono">
            <label className="block text-slate-400 mb-1">{t('settings.loopProtection.maxRevisionsLabel')}:</label>
            <input
              type="number"
              min={1}
              max={10}
              value={maxRevisions}
              onChange={(e) => setMaxRevisions(Number(e.target.value))}
              className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2 text-white focus:outline-none focus:border-forge-cyan"
            />
            <p className="text-[10px] text-slate-500 mt-1">
              {t('settings.loopProtection.helpText')}
            </p>
          </div>
        </div>

        <div className="flex justify-end pt-4 border-t border-surface-border">
          <button
            onClick={handleSave}
            className="px-5 py-2 bg-forge-cyan hover:bg-cyan-600 text-slate-950 font-mono font-bold text-xs rounded-lg shadow flex items-center space-x-2 transition"
          >
            {saved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
            <span>{saved ? t('settings.settingsSavedButton') : t('settings.saveConfigButton')}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
