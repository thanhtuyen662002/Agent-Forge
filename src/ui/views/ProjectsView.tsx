import React, { useEffect, useMemo, useState } from 'react';
import { useOrchestrator } from '../context/OrchestratorContext';
import { useI18n } from '../context/I18nContext';
import { FolderGit2, Plus, FileCode, FolderOpen, Search, Trash2, CheckCircle2 } from 'lucide-react';
import { uiActionFailureKey } from '../actionState';
import { AccessibleDialog } from '../components/AccessibleDialog';
import { ConfirmPermanentDeleteDialog, ConfirmTrashDialog, TrashFailureMessage, TrashList } from '../components/TrashPanel';
import { matchesSearch, useWorkspaceTrash } from '../workspaceTrash';
import type { TrashActionResult } from '../workspaceTrash';
import type { Project, ProjectContract } from '../../core/types/domain';
import { CONTRACT_LIST_FIELDS, canApprovePlan, contractFromForm, emptyContractForm, formFromContract } from '../projectContractForm';
import type { ContractFormState } from '../projectContractForm';

export const ProjectsView: React.FC = () => {
  const { projects, activeProject, setActiveProject, createProject, importContract, transitionProject, isElectron, pendingActions, refreshData } = useOrchestrator();
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
  const trash = useWorkspaceTrash(refreshData);
  const [projectQuery, setProjectQuery] = useState('');
  const [showTrash, setShowTrash] = useState(false);
  const [trashTarget, setTrashTarget] = useState<Project | null>(null);
  const [trashFailure, setTrashFailure] = useState<TrashActionResult | null>(null);
  const [trashNotice, setTrashNotice] = useState<{ ok: boolean; message: string; failure?: TrashActionResult } | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<{ id: string; name: string } | null>(null);
  const [purgeFailure, setPurgeFailure] = useState<TrashActionResult | null>(null);
  const visibleProjects = useMemo(
    () => projects.filter((project) => matchesSearch(projectQuery, project.name, project.description, project.id)),
    [projects, projectQuery],
  );

  const confirmTrashProject = async () => {
    if (!trashTarget) return;
    const result = await trash.trashProject(trashTarget.id);
    if (result.success) {
      const extra = result.invalidatedAuthorizations > 0 ? ` ${t('trash.results.invalidated', { count: result.invalidatedAuthorizations })}` : '';
      setTrashNotice({ ok: true, message: t('trash.results.projectTrashed', { name: trashTarget.name }) + extra });
      setTrashTarget(null);
      setTrashFailure(null);
    } else {
      setTrashFailure(result);
    }
  };

  const restoreProject = async (projectId: string, name: string) => {
    const result = await trash.restoreProject(projectId);
    setTrashNotice(result.success
      ? { ok: true, message: t('trash.results.projectRestored', { name }) }
      : { ok: false, message: '', failure: result });
  };

  const confirmPurgeProject = async () => {
    if (!purgeTarget) return;
    const result = await trash.purgeProject(purgeTarget.id);
    if (result.success) {
      setTrashNotice({ ok: true, message: t('trash.results.projectPurged', { name: purgeTarget.name }) });
      setPurgeTarget(null);
      setPurgeFailure(null);
    } else {
      setPurgeFailure(result);
    }
  };
  const importing = pendingActions.includes('importContract');
  const approving = pendingActions.includes('projectTransition');
  const [contractForm, setContractForm] = useState<ContractFormState>(emptyContractForm);
  const [approvalStatus, setApprovalStatus] = useState<{ ok: boolean; message: string } | null>(null);

  // Prefill the guided form from the stored plan whenever the selected project or its plan changes.
  useEffect(() => {
    setContractForm(formFromContract(activeProject?.contract));
    setApprovalStatus(null);
  }, [activeProject?.id, activeProject?.updated_at]);

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

  const handleImportContract = async (source: 'form' | 'json' = 'form') => {
    setImportStatus(null);
    setImportSucceeded(false);
    let contract: ProjectContract;
    if (source === 'json') {
      if (!contractJson.trim()) return;
      try {
        contract = JSON.parse(contractJson);
      } catch {
        setImportStatus(t('projectPlan.jsonInvalid'));
        return;
      }
    } else {
      contract = contractFromForm(contractForm);
      if (!contract.goal) {
        setImportStatus(t('projectPlan.goalRequired'));
        return;
      }
    }
    try {
      const result = await importContract(contract);
      if (!result.success) {
        setImportStatus(t(uiActionFailureKey(result.code)));
        return;
      }
      setImportSucceeded(true);
      setImportStatus(t('projectPlan.saved'));
    } catch (err: any) {
      setImportStatus(t('actions.invalidResponse'));
    }
  };

  const handleApprovePlan = async () => {
    setApprovalStatus(null);
    const result = await transitionProject('PLAN_APPROVED');
    if (!result.success) {
      setApprovalStatus({ ok: false, message: t(uiActionFailureKey(result.code)) });
      return;
    }
    setApprovalStatus({ ok: true, message: t('projectPlan.approval.approved') });
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

      <section aria-labelledby="project-list-title" className="bg-surface-card border border-surface-border rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id="project-list-title" className="text-sm font-semibold text-white">{t('trash.projectListTitle')}</h3>
          <button
            type="button"
            onClick={() => setShowTrash((value) => !value)}
            disabled={!trash.available}
            aria-expanded={showTrash}
            className="px-3 py-1.5 rounded-lg text-xs border border-surface-border text-slate-300 hover:bg-surface-border disabled:opacity-40 flex items-center gap-1.5"
          >
            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{showTrash ? t('trash.hideTrash') : t('trash.showTrash')} ({trash.listing.projects.length})</span>
          </button>
        </div>
        <label className="relative block">
          <span className="sr-only">{t('trash.projectSearch')}</span>
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
          <input
            type="search"
            value={projectQuery}
            onChange={(event) => setProjectQuery(event.target.value)}
            placeholder={t('trash.projectSearchPlaceholder')}
            className="w-full bg-surface border border-surface-border rounded-lg pl-9 pr-3 py-2 text-sm text-white focus:outline-none focus:border-forge-cyan"
          />
        </label>
        {trashNotice && (trashNotice.ok
          ? <p role="status" className="text-xs text-emerald-300">{trashNotice.message}</p>
          : trashNotice.failure && <TrashFailureMessage result={trashNotice.failure} />)}
        {projects.length === 0 ? (
          <p className="text-xs text-slate-500">{t('trash.noProjects')}</p>
        ) : visibleProjects.length === 0 ? (
          <p className="text-xs text-slate-500">{t('trash.noMatches')}</p>
        ) : (
          <ul className="divide-y divide-surface-border" aria-label={t('trash.projectListTitle')}>
            {visibleProjects.map((project) => {
              const selected = activeProject?.id === project.id;
              return (
                <li key={project.id} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-slate-100 truncate" title={project.name}>{project.name}</div>
                    <div className="text-[11px] text-slate-500 truncate">{project.status}{project.description ? ` · ${project.description}` : ''}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {selected ? (
                      <span className="px-2 py-1 rounded-md text-[11px] bg-forge-cyan/15 text-forge-cyan">{t('trash.selected')}</span>
                    ) : (
                      <button type="button" onClick={() => setActiveProject(project)}
                        className="px-3 py-1.5 rounded-lg text-xs border border-surface-border text-slate-200 hover:bg-surface-border">
                        {t('trash.open')}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => { setTrashFailure(null); setTrashTarget(project); }}
                      disabled={!trash.available || trash.pending}
                      className="px-3 py-1.5 rounded-lg text-xs bg-rose-950/40 border border-rose-800/60 text-rose-300 hover:bg-rose-900/40 disabled:opacity-40 flex items-center gap-1.5"
                    >
                      <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{t('trash.moveToTrash')}</span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {showTrash && (
        trash.loadFailed
          ? <p role="alert" className="text-xs text-rose-300">{t('trash.loadFailed')}</p>
          : <TrashList
            listing={trash.listing}
            show="projects"
            pending={trash.pending}
            onRestoreProject={(id, name) => void restoreProject(id, name)}
            onPurgeProject={(id, name) => { setPurgeFailure(null); setPurgeTarget({ id, name }); }}
          />
      )}

      {purgeTarget && (
        <ConfirmPermanentDeleteDialog
          title={t('trash.purge.title', { name: purgeTarget.name })}
          body={t('trash.purge.body')}
          confirmLabel={t('trash.purge.confirm')}
          cancelLabel={t('trash.purge.cancel')}
          pending={trash.pending}
          failure={purgeFailure ? <TrashFailureMessage result={purgeFailure} /> : null}
          onCancel={() => setPurgeTarget(null)}
          onConfirm={() => void confirmPurgeProject()}
        />
      )}

      {trashTarget && (
        <ConfirmTrashDialog
          kind="project"
          name={trashTarget.name}
          pending={trash.pending}
          failure={trashFailure}
          onCancel={() => setTrashTarget(null)}
          onConfirm={() => void confirmTrashProject()}
        />
      )}

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

      {/* Project plan: guided natural-text form, JSON only as an advanced option */}
      <section aria-labelledby="project-plan-title" className="bg-surface-card border border-surface-border rounded-xl p-6 shadow-lg space-y-5">
        <div>
          <h3 id="project-plan-title" className="text-sm font-semibold text-white flex items-center space-x-2">
            <FileCode className="w-4 h-4 text-forge-purple" aria-hidden="true" />
            <span>{t('projectPlan.title')}</span>
          </h3>
          <p className="text-xs text-slate-400 mt-1">{t('projectPlan.subtitle')}</p>
        </div>

        {!activeProject ? (
          <p className="text-xs text-slate-500">{t('projectPlan.noProject')}</p>
        ) : (
          <>
            <div className="space-y-4">
              <div>
                <label htmlFor="plan-goal" className="block text-sm text-slate-200 mb-1">{t('projectPlan.fields.goal.label')}</label>
                <textarea
                  id="plan-goal"
                  required
                  disabled={importing}
                  value={contractForm.goal}
                  onChange={(event) => setContractForm({ ...contractForm, goal: event.target.value })}
                  placeholder={t('projectPlan.fields.goal.placeholder')}
                  className="w-full h-20 bg-surface border border-surface-border rounded-lg p-3 text-sm text-slate-100 focus:outline-none focus:border-forge-purple resize-y"
                />
              </div>
              <div>
                <label htmlFor="plan-business_context" className="block text-sm text-slate-200 mb-1">{t('projectPlan.fields.business_context.label')}</label>
                <textarea
                  id="plan-business_context"
                  disabled={importing}
                  value={contractForm.business_context}
                  onChange={(event) => setContractForm({ ...contractForm, business_context: event.target.value })}
                  placeholder={t('projectPlan.fields.business_context.placeholder')}
                  className="w-full h-16 bg-surface border border-surface-border rounded-lg p-3 text-sm text-slate-100 focus:outline-none focus:border-forge-purple resize-y"
                />
              </div>
              <p id="plan-lines-help" className="text-xs text-slate-500">{t('projectPlan.linesHelp')}</p>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {CONTRACT_LIST_FIELDS.map((field) => (
                  <div key={field}>
                    <label htmlFor={`plan-${field}`} className="block text-sm text-slate-200 mb-1">{t(`projectPlan.fields.${field}.label`)}</label>
                    <textarea
                      id={`plan-${field}`}
                      disabled={importing}
                      aria-describedby="plan-lines-help"
                      value={contractForm[field]}
                      onChange={(event) => setContractForm({ ...contractForm, [field]: event.target.value })}
                      placeholder={t(`projectPlan.fields.${field}.placeholder`)}
                      className="w-full h-24 bg-surface border border-surface-border rounded-lg p-3 text-sm text-slate-100 focus:outline-none focus:border-forge-purple resize-y"
                    />
                  </div>
                ))}
              </div>
            </div>

            {importStatus && (
              <div role={importSucceeded ? 'status' : 'alert'} className={`p-3 border rounded-lg text-xs ${importSucceeded ? 'bg-emerald-950/30 border-emerald-800/40 text-emerald-300' : 'bg-rose-950/30 border-rose-800/40 text-rose-300'}`}>
                {importStatus}
              </div>
            )}

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void handleImportContract('form')}
                disabled={!isElectron || importing || !contractForm.goal.trim()}
                aria-busy={importing}
                title={!isElectron ? t('actions.desktopRequired') : undefined}
                className="px-5 py-2 bg-forge-purple hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-xs rounded-lg shadow transition"
              >
                {importing ? t('actions.pending') : t('projectPlan.save')}
              </button>
            </div>

            <details className="rounded-lg border border-surface-border p-4">
              <summary className="cursor-pointer text-xs text-slate-300">{t('projectPlan.advancedSummary')}</summary>
              <div className="space-y-3 pt-3">
                <p className="text-xs text-slate-400">{t('projectPlan.advancedHelp')}</p>
                <label htmlFor="plan-json" className="block text-xs text-slate-300">{t('projectPlan.jsonLabel')}</label>
                <textarea
                  id="plan-json"
                  disabled={importing}
                  value={contractJson}
                  onChange={(e) => setContractJson(e.target.value)}
                  placeholder={'{ "goal": "..." }'}
                  className="w-full h-40 bg-surface border border-surface-border rounded-lg p-3 text-xs font-mono text-slate-100 focus:outline-none focus:border-forge-purple resize-y"
                />
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => void handleImportContract('json')}
                    disabled={!isElectron || importing || !contractJson.trim()}
                    className="px-4 py-2 bg-surface-border hover:bg-surface-hover disabled:opacity-40 text-slate-200 text-xs rounded-lg"
                  >
                    {t('projectPlan.saveJson')}
                  </button>
                </div>
              </div>
            </details>

            <div className="border-t border-surface-border pt-4 space-y-2" aria-labelledby="plan-approval-title" role="group">
              <h4 id="plan-approval-title" className="text-sm font-semibold text-white flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-forge-emerald" aria-hidden="true" />
                <span>{t('projectPlan.approval.title')}</span>
              </h4>
              <p className="text-xs text-slate-400">{t('projectPlan.approval.status', { status: activeProject.status })}</p>
              <p className="text-xs text-slate-400">{t('projectPlan.approval.help')}</p>
              {canApprovePlan(activeProject.status, activeProject.contract) ? (
                <button
                  type="button"
                  onClick={() => void handleApprovePlan()}
                  disabled={!isElectron || approving}
                  aria-busy={approving}
                  className="px-5 py-2 bg-forge-emerald/90 hover:bg-emerald-500 disabled:opacity-40 text-slate-950 font-bold text-xs rounded-lg shadow"
                >
                  {approving ? t('actions.pending') : t('projectPlan.approval.approve')}
                </button>
              ) : activeProject.status === 'DRAFT' || activeProject.status === 'PLANNING' ? (
                <p className="text-xs text-amber-300">{t('projectPlan.approval.needsPlan')}</p>
              ) : ['READY', 'RUNNING', 'PAUSED', 'BLOCKED', 'WAITING_FOR_CAPACITY', 'WAITING_FOR_OWNER', 'FINAL_REVIEW', 'COMPLETED'].includes(activeProject.status) ? (
                <p className="text-xs text-emerald-300">{t('projectPlan.approval.alreadyApproved', { status: activeProject.status })}</p>
              ) : (
                <p className="text-xs text-slate-400">{t('projectPlan.approval.notApprovable', { status: activeProject.status })}</p>
              )}
              {approvalStatus && (
                <p role={approvalStatus.ok ? 'status' : 'alert'} className={`text-xs ${approvalStatus.ok ? 'text-emerald-300' : 'text-rose-300'}`}>
                  {approvalStatus.message}
                </p>
              )}
            </div>
          </>
        )}
      </section>

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
