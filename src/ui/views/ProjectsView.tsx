import React, { useState } from 'react';
import { useOrchestrator } from '../context/OrchestratorContext';
import { useI18n } from '../context/I18nContext';
import { FolderGit2, Plus, FileCode, FolderOpen } from 'lucide-react';
import { uiActionFailureKey } from '../actionState';
import { AccessibleDialog } from '../components/AccessibleDialog';

export const ProjectsView: React.FC = () => {
  const { projects, activeProject, createProject, importContract, isElectron, pendingActions, refreshData } = useOrchestrator();
  const { t } = useI18n();
  const [isCreateOpen, setIsCreateOpen] = useState<boolean>(false);
  const [name, setName] = useState<string>('');
  const [desc, setDesc] = useState<string>('');
  const [selectionId, setSelectionId] = useState<string>('');
  const [displayPath, setDisplayPath] = useState<string>('');
  const [contractJson, setContractJson] = useState<string>('');
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<string | null>(null);
  const [importSucceeded, setImportSucceeded] = useState(false);
  const [binding, setBinding] = useState(false);
  const [bindingResult, setBindingResult] = useState<{ projectId: string; success: boolean; message: string } | null>(null);
  const creating = pendingActions.includes('createProject');
  const importing = pendingActions.includes('importContract');

  const handleBindRepository = async () => {
    if (!activeProject || binding) return;
    const projectId = activeProject.id;
    setBinding(true); setBindingResult(null);
    try {
      const api = (window as any).orchestrator;
      const selection = await api.selectRepositoryDirectory();
      if (selection.cancelled) return;
      if (!selection.success || !selection.selectionId) {
        setBindingResult({ projectId, success: false, message: t(selection.errorCode === 'REPOSITORY_ROOT_ALIAS' ?
          'projects.createModal.repositoryErrors.alias' : 'projects.createModal.repositoryErrors.changed') });
        return;
      }
      const result = await api.bindProjectRepository({ projectId, repositorySelectionId: selection.selectionId });
      if (!result.success) {
        setBindingResult({ projectId, success: false, message: t(result.errorCode === 'REPOSITORY_ROOT_BINDING_BLOCKED' ?
          'projects.repositoryBinding.blocked' : 'projects.createModal.repositoryErrors.changed') });
        return;
      }
      await refreshData();
      setBindingResult({ projectId, success: true, message: t('projects.repositoryBinding.success') });
    } catch {
      setBindingResult({ projectId, success: false, message: t('actions.requestRejected') });
    } finally { setBinding(false); }
  };

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
          const rootFailure = [
            'REPOSITORY_ROOT_INVALID_PATH', 'REPOSITORY_ROOT_MISSING', 'REPOSITORY_ROOT_NOT_DIRECTORY',
            'REPOSITORY_ROOT_ALIAS', 'REPOSITORY_ROOT_IDENTITY_UNAVAILABLE', 'REPOSITORY_ROOT_IDENTITY_CHANGED',
            'REPOSITORY_ROOT_UNBOUND',
          ].includes(res.errorCode);
          if (res.errorCode === 'NOT_GIT_REPOSITORY') {
            primaryMsg = t('projects.createModal.repositoryErrors.notGitRepository');
          } else if (res.errorCode === 'INVALID_REPOSITORY_LOCATION') {
            primaryMsg = t('projects.createModal.repositoryErrors.invalidLocation');
          } else if (res.errorCode === 'REPOSITORY_ROOT_ALIAS') {
            primaryMsg = t('projects.createModal.repositoryErrors.alias');
          } else if (res.errorCode === 'REPOSITORY_ROOT_IDENTITY_CHANGED' || res.errorCode === 'REPOSITORY_ROOT_UNBOUND') {
            primaryMsg = t('projects.createModal.repositoryErrors.changed');
          } else if (rootFailure) {
            primaryMsg = t('projects.createModal.repositoryErrors.invalidLocation');
          }

          if (res.errorDetail && !rootFailure) {
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
      const result = await createProject({
        name: name.trim(),
        description: desc.trim(),
        repositorySelectionId: selectionId,
      });
      if (!result.success) {
        setErrorStatus(t(uiActionFailureKey(result.code)));
        return;
      }
      setName('');
      setDesc('');
      setSelectionId('');
      setDisplayPath('');
      setIsCreateOpen(false);
    } catch (err: any) {
      setErrorStatus(t('actions.requestRejected'));
    }
  };

  const handleImportContract = async () => {
    if (!contractJson.trim()) return;
    setImportStatus(null);
    setImportSucceeded(false);
    try {
      const parsed = JSON.parse(contractJson);
      const result = await importContract(parsed);
      if (!result.success) {
        setImportStatus(t(uiActionFailureKey(result.code)));
        return;
      }
      setImportSucceeded(true);
      setImportStatus(t('projects.importSuccess'));
    } catch (err: any) {
      setImportStatus(t('actions.invalidResponse'));
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
          disabled={!isElectron || creating}
          title={!isElectron ? t('actions.desktopRequired') : undefined}
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

      {activeProject && (
        <section aria-labelledby="repository-binding-title" className="bg-surface-card border border-surface-border rounded-xl p-6 space-y-3">
          <h3 id="repository-binding-title" className="text-sm font-semibold text-white">{t('projects.repositoryBinding.title')}</h3>
          <p className="text-xs text-slate-400">{t('projects.repositoryBinding.description')}</p>
          <p className="text-xs text-slate-200 break-all">{activeProject.repository_path}</p>
          <button type="button" onClick={handleBindRepository} disabled={!isElectron || binding || activeProject.status === 'RUNNING'}
            aria-busy={binding} title={!isElectron ? t('actions.desktopRequired') : undefined}
            className="px-3 py-2 bg-surface-border text-slate-200 rounded-lg text-xs font-semibold disabled:opacity-50">
            {binding ? t('actions.pending') : t('projects.repositoryBinding.button')}
          </button>
          {bindingResult?.projectId === activeProject.id && <p role={bindingResult.success ? 'status' : 'alert'} className={bindingResult.success ? 'text-emerald-300 text-xs' : 'text-rose-300 text-xs'}>{bindingResult.message}</p>}
        </section>
      )}

      {/* Contract Editor / Importer */}
      <div className="bg-surface-card border border-surface-border rounded-xl p-6 shadow-lg space-y-4">
        <h3 id="project-contract-label" className="text-sm font-semibold text-white font-mono uppercase tracking-wider flex items-center space-x-2">
          <FileCode className="w-4 h-4 text-forge-purple" />
          <span>{t('projects.importerTitle')}</span>
        </h3>
        <p className="text-xs text-slate-400">
          {t('projects.importerSubtitle')}
        </p>

        <textarea
          aria-labelledby="project-contract-label"
          disabled={importing}
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
          <div role={importSucceeded ? 'status' : 'alert'} className={`p-3 border rounded-lg text-xs font-mono ${importSucceeded ? 'bg-emerald-950/30 border-emerald-800/40 text-emerald-300' : 'bg-rose-950/30 border-rose-800/40 text-rose-300'}`}>
            {importStatus}
          </div>
        )}

        <div className="flex justify-end">
          <button
            onClick={handleImportContract}
            disabled={!isElectron || !activeProject || importing || !contractJson.trim()}
            aria-busy={importing}
            title={!isElectron ? t('actions.desktopRequired') : undefined}
            className="px-5 py-2 bg-forge-purple hover:bg-purple-600 text-white font-mono font-bold text-xs rounded-lg shadow transition"
          >
            {importing ? t('actions.pending') : t('projects.importButton')}
          </button>
        </div>
      </div>

      {/* New Project Modal */}
      {isCreateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <AccessibleDialog onDismiss={() => setIsCreateOpen(false)} dismissible={!creating} aria-labelledby="create-project-title" className="bg-surface border border-surface-border rounded-xl shadow-2xl max-w-md w-full p-6 space-y-4">
            <h3 id="create-project-title" className="text-sm font-mono font-bold text-white uppercase tracking-wider">{t('projects.createModal.title')}</h3>
            <form onSubmit={handleCreate} className="space-y-4 text-xs font-mono">
              <div>
                <label htmlFor="create-project-name" className="block text-slate-400 mb-1">{t('projects.createModal.nameLabel')}:</label>
                <input
                  id="create-project-name"
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('projects.createModal.namePlaceholder')}
                  className="w-full bg-surface-card border border-surface-border rounded-lg px-3 py-2 text-white font-sans focus:outline-none focus:border-forge-cyan"
                />
              </div>

              <div>
                <label htmlFor="create-project-description" className="block text-slate-400 mb-1">{t('projects.createModal.descLabel')}:</label>
                <textarea
                  id="create-project-description"
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                  placeholder={t('projects.createModal.descPlaceholder')}
                  className="w-full h-20 bg-surface-card border border-surface-border rounded-lg p-3 text-white font-sans focus:outline-none focus:border-forge-cyan resize-none"
                />
              </div>

              <div>
                <label htmlFor="create-project-repository" className="block text-slate-400 mb-1">{t('projects.createModal.gitRepoLabel')}:</label>
                <div className="space-y-2">
                  <div className="flex items-center space-x-2">
                    <button
                      type="button"
                      onClick={handleSelectDirectory}
                      disabled={!isElectron || creating}
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
                    id="create-project-repository"
                    type="text"
                    readOnly
                    value={displayPath}
                    placeholder={t('projects.createModal.noRepoSelected')}
                    className="w-full bg-surface-card/60 border border-surface-border text-slate-300 rounded-lg px-3 py-2 text-xs font-mono cursor-not-allowed focus:outline-none"
                  />
                </div>
              </div>

              {errorStatus && (
                <div role="alert" className="p-2.5 bg-rose-950/40 border border-rose-800/50 text-rose-300 rounded-lg text-xs font-mono">
                  {errorStatus}
                </div>
              )}

              <div className="flex justify-end space-x-3 pt-3 border-t border-surface-border">
                <button
                  data-dialog-initial-focus
                  type="button"
                  onClick={() => setIsCreateOpen(false)}
                  disabled={creating}
                  className="px-4 py-2 bg-surface-card hover:bg-surface-border text-slate-300 rounded-lg text-xs"
                >
                  {t('projects.createModal.cancelButton')}
                </button>
                <button
                  type="submit"
                  disabled={!isElectron || creating || !selectionId || !name.trim()}
                  aria-busy={creating}
                  className="px-5 py-2 bg-forge-cyan hover:bg-cyan-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 font-bold rounded-lg text-xs shadow"
                >
                  {creating ? t('actions.pending') : t('projects.createModal.initButton')}
                </button>
              </div>
            </form>
          </AccessibleDialog>
        </div>
      )}
    </div>
  );
};
