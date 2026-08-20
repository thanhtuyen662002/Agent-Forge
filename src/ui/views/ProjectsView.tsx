import React, { useState } from 'react';
import { useOrchestrator } from '../context/OrchestratorContext';
import { useI18n } from '../context/I18nContext';
import { FolderGit2, Plus, FileCode, FolderOpen } from 'lucide-react';

export const ProjectsView: React.FC = () => {
  const { projects, activeProject, createProject, importContract } = useOrchestrator();
  const { t } = useI18n();
  const [isCreateOpen, setIsCreateOpen] = useState<boolean>(false);
  const [name, setName] = useState<string>('');
  const [desc, setDesc] = useState<string>('');
  const [selectionId, setSelectionId] = useState<string>('');
  const [displayPath, setDisplayPath] = useState<string>('');
  const [contractJson, setContractJson] = useState<string>('');
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<string | null>(null);

  const handleSelectDirectory = async () => {
    setErrorStatus(null);
    try {
      if ((window as any).orchestrator?.selectRepositoryDirectory) {
        const res = await (window as any).orchestrator.selectRepositoryDirectory();
        if (res.success && res.selectionId) {
          setSelectionId(res.selectionId);
          setDisplayPath(res.displayPath || '');
        } else if (!res.cancelled && (res.errorCode || res.error)) {
          let primaryMsg = t('projects.createModal.repositoryErrors.unknown');
          if (res.errorCode === 'NOT_GIT_REPOSITORY') {
            primaryMsg = t('projects.createModal.repositoryErrors.notGitRepository');
          } else if (res.errorCode === 'INVALID_REPOSITORY_LOCATION') {
            primaryMsg = t('projects.createModal.repositoryErrors.invalidLocation');
          }

          if (res.errorDetail) {
            setErrorStatus(`${primaryMsg} (${t('projects.createModal.repositoryErrors.technicalDetails', { error: res.errorDetail })})`);
          } else {
            setErrorStatus(primaryMsg);
          }
        }
      }
    } catch (err: any) {
      const errorMsg = err?.message || t('common.unknown');
      setErrorStatus(`${t('projects.createModal.repositoryErrors.unknown')} (${t('projects.createModal.repositoryErrors.technicalDetails', { error: errorMsg })})`);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !selectionId.trim()) return;
    setErrorStatus(null);
    try {
      await createProject({
        name: name.trim(),
        description: desc.trim(),
        repositorySelectionId: selectionId,
      });
      setName('');
      setDesc('');
      setSelectionId('');
      setDisplayPath('');
      setIsCreateOpen(false);
    } catch (err: any) {
      setErrorStatus(`${t('common.error')}: ${err.message}`);
    }
  };

  const handleImportContract = async () => {
    if (!contractJson.trim()) return;
    try {
      const parsed = JSON.parse(contractJson);
      await importContract(parsed);
      setImportStatus(t('projects.importSuccess'));
    } catch (err: any) {
      setImportStatus(t('projects.importError', { error: err.message }));
    }
  };

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto overflow-y-auto">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight flex items-center space-x-2.5">
            <FolderGit2 className="w-5 h-5 text-forge-cyan" />
            <span>{t('projects.title')}</span>
          </h2>
          <p className="text-xs text-slate-400">
            {t('projects.subtitle')}
          </p>
        </div>

        <button
          onClick={() => {
            setIsCreateOpen(true);
            setErrorStatus(null);
          }}
          className="px-4 py-2 bg-forge-cyan hover:bg-cyan-600 text-slate-950 font-mono font-bold text-xs rounded-lg shadow flex items-center space-x-2 transition"
        >
          <Plus className="w-4 h-4" />
          <span>{t('projects.newProject')}</span>
        </button>
      </div>

      {/* Contract Editor / Importer */}
      <div className="bg-surface-card border border-surface-border rounded-xl p-6 shadow-lg space-y-4">
        <h3 className="text-sm font-semibold text-white font-mono uppercase tracking-wider flex items-center space-x-2">
          <FileCode className="w-4 h-4 text-forge-purple" />
          <span>{t('projects.importerTitle')}</span>
        </h3>
        <p className="text-xs text-slate-400">
          {t('projects.importerSubtitle')}
        </p>

        <textarea
          value={contractJson}
          onChange={(e) => setContractJson(e.target.value)}
          placeholder={`{
  "goal": "Build a local AI engineering desktop orchestrator",
  "architecture_constraints": ["Must use better-sqlite3 with WAL mode", "Strict Electron security boundary"],
  "security_requirements": ["No arbitrary shell execution", "Zero ChatGPT web scraping"],
  "definition_of_done": ["All unit tests pass", "Manual bridge functions end-to-end"]
}`}
          className="w-full h-48 bg-surface border border-surface-border rounded-lg p-4 text-xs font-mono text-slate-100 focus:outline-none focus:border-forge-purple resize-none"
        />

        {importStatus && (
          <div className="p-3 bg-emerald-950/30 border border-emerald-800/40 text-emerald-300 rounded-lg text-xs font-mono">
            {importStatus}
          </div>
        )}

        <div className="flex justify-end">
          <button
            onClick={handleImportContract}
            className="px-5 py-2 bg-forge-purple hover:bg-purple-600 text-white font-mono font-bold text-xs rounded-lg shadow transition"
          >
            {t('projects.importButton')}
          </button>
        </div>
      </div>

      {/* New Project Modal */}
      {isCreateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-surface border border-surface-border rounded-xl shadow-2xl max-w-md w-full p-6 space-y-4">
            <h3 className="text-sm font-mono font-bold text-white uppercase tracking-wider">{t('projects.createModal.title')}</h3>
            <form onSubmit={handleCreate} className="space-y-4 text-xs font-mono">
              <div>
                <label className="block text-slate-400 mb-1">{t('projects.createModal.nameLabel')}:</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('projects.createModal.namePlaceholder')}
                  className="w-full bg-surface-card border border-surface-border rounded-lg px-3 py-2 text-white font-sans focus:outline-none focus:border-forge-cyan"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">{t('projects.createModal.descLabel')}:</label>
                <textarea
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                  placeholder={t('projects.createModal.descPlaceholder')}
                  className="w-full h-20 bg-surface-card border border-surface-border rounded-lg p-3 text-white font-sans focus:outline-none focus:border-forge-cyan resize-none"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">{t('projects.createModal.gitRepoLabel')}:</label>
                <div className="space-y-2">
                  <div className="flex items-center space-x-2">
                    <button
                      type="button"
                      onClick={handleSelectDirectory}
                      className="px-3 py-2 bg-surface-border hover:bg-slate-700 text-slate-200 rounded-lg flex items-center space-x-1.5 transition font-semibold"
                    >
                      <FolderOpen className="w-3.5 h-3.5 text-forge-cyan" />
                      <span>{t('projects.createModal.chooseRepoButton')}</span>
                    </button>
                    <span className="text-[10px] text-slate-400 font-mono">
                      {selectionId ? t('projects.createModal.tokenVerified') : t('projects.createModal.selectGitRoot')}
                    </span>
                  </div>

                  <input
                    type="text"
                    readOnly
                    value={displayPath}
                    placeholder={t('projects.createModal.noRepoSelected')}
                    className="w-full bg-surface-card/60 border border-surface-border text-slate-300 rounded-lg px-3 py-2 text-xs font-mono cursor-not-allowed focus:outline-none"
                  />
                </div>
              </div>

              {errorStatus && (
                <div className="p-2.5 bg-rose-950/40 border border-rose-800/50 text-rose-300 rounded-lg text-xs font-mono">
                  {errorStatus}
                </div>
              )}

              <div className="flex justify-end space-x-3 pt-3 border-t border-surface-border">
                <button
                  type="button"
                  onClick={() => setIsCreateOpen(false)}
                  className="px-4 py-2 bg-surface-card hover:bg-surface-border text-slate-300 rounded-lg text-xs"
                >
                  {t('projects.createModal.cancelButton')}
                </button>
                <button
                  type="submit"
                  disabled={!selectionId}
                  className="px-5 py-2 bg-forge-cyan hover:bg-cyan-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 font-bold rounded-lg text-xs shadow"
                >
                  {t('projects.createModal.initButton')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
