import React, { useCallback, useMemo, useState } from 'react';
import { useOrchestrator } from '../context/OrchestratorContext';
import { useI18n } from '../context/I18nContext';
import { AgentCard } from '../components/AgentCard';
import { AccessibleDialog } from '../components/AccessibleDialog';
import { useAgentRoster } from '../agentRoster';
import { useAccountSignIn } from '../accountSignIn';
import { SignInDialog } from '../components/SignInDialog';
import { CliSignInDialog } from '../components/CliSignInDialog';
import { ModelPicker } from '../components/ModelPicker';
import type { AgentMutationResult } from '../agentRoster';
import type { AgentRole } from '../../core/types/domain';
import type { AgentConnectionKind, AgentRosterEntry } from '../../core/types/workspace';
import { MAX_AGENT_WORKER_SLOTS } from '../../core/types/workspace';
import { Bot, Shield, Terminal, Wrench, Plus, RefreshCw } from 'lucide-react';

const ROLE_OPTIONS: AgentRole[] = ['PRIMARY_MANAGER', 'BACKUP_MANAGER', 'CODER', 'REVIEWER', 'TOOL'];
const CONNECTION_OPTIONS: AgentConnectionKind[] = ['MANUAL_BRIDGE', 'CODEX_CLI', 'CLAUDE_CODE_CLI', 'GEMINI_CLI'];

const inputClass =
  'w-full bg-surface-card border border-surface-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-forge-cyan';

interface AgentFormState {
  displayName: string;
  role: AgentRole;
  connection: AgentConnectionKind;
  modelName: string;
  profileId: string;
  workerSlots: number;
  instructions: string;
}

const emptyForm: AgentFormState = {
  displayName: '',
  role: 'CODER',
  connection: 'MANUAL_BRIDGE',
  modelName: '',
  profileId: '',
  workerSlots: 1,
  instructions: '',
};

type Notice = { tone: 'success' | 'error'; message: string } | null;

export const AgentCenterView: React.FC = () => {
  const { resources, tasks, setSelectedTaskId, setActiveView, refreshData } = useOrchestrator();
  const { t } = useI18n();
  const [showRemoved, setShowRemoved] = useState(false);
  const roster = useAgentRoster(showRemoved, refreshData);
  const [formMode, setFormMode] = useState<{ kind: 'create' } | { kind: 'edit'; entry: AgentRosterEntry } | null>(null);
  const [form, setForm] = useState<AgentFormState>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<AgentRosterEntry | null>(null);
  const [removeError, setRemoveError] = useState<AgentMutationResult | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [signInEntry, setSignInEntry] = useState<AgentRosterEntry | null>(null);
  const [cliSignInEntry, setCliSignInEntry] = useState<AgentRosterEntry | null>(null);
  const reloadRoster = roster.reload;
  const afterSignIn = useCallback(async () => { await reloadRoster(); await refreshData(); }, [reloadRoster, refreshData]);
  const signIn = useAccountSignIn(afterSignIn);

  const groups = useMemo(() => {
    const byRole = (roles: AgentRole[]) => roster.entries.filter((entry) => roles.includes(entry.agent.role));
    return [
      { key: 'managers', title: t('agentCenter.managerPool'), icon: <Shield className="w-4 h-4 text-forge-purple" />, entries: byRole(['PRIMARY_MANAGER', 'BACKUP_MANAGER']) },
      { key: 'coders', title: t('agentCenter.coderPool'), icon: <Terminal className="w-4 h-4 text-forge-cyan" />, entries: byRole(['CODER']) },
      { key: 'reviewers', title: t('agentCenter.reviewerPool'), icon: <Shield className="w-4 h-4 text-forge-emerald" />, entries: byRole(['REVIEWER']) },
      { key: 'tools', title: t('agentCenter.toolPool'), icon: <Wrench className="w-4 h-4 text-amber-400" />, entries: byRole(['TOOL']) },
    ];
  }, [roster.entries, t]);

  const failureMessage = (result: AgentMutationResult) =>
    result.success ? '' : t(`agentCenter.errors.${result.code}`);

  const openCreate = () => {
    setForm(emptyForm);
    setFormError(null);
    setFormMode({ kind: 'create' });
  };

  const openEdit = (entry: AgentRosterEntry) => {
    setForm({
      ...emptyForm,
      displayName: entry.agent.display_name,
      role: entry.agent.role,
      connection: entry.connection === 'OTHER' ? 'MANUAL_BRIDGE' : entry.connection,
      modelName: entry.resource?.modelName ?? '',
      instructions: entry.agentProfile?.instructions ?? '',
    });
    setFormError(null);
    setFormMode({ kind: 'edit', entry });
  };

  const closeForm = () => {
    if (!roster.pending) setFormMode(null);
  };

  const submitForm = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!formMode || roster.pending) return;
    setFormError(null);
    let result: AgentMutationResult;
    if (formMode.kind === 'create') {
      const isCli = form.connection !== 'MANUAL_BRIDGE';
      result = await roster.createAgent({
        displayName: form.displayName,
        role: form.role,
        connection: form.connection,
        modelName: form.modelName,
        ...(isCli && form.profileId.trim() ? { profileId: form.profileId } : {}),
        workerSlots: isCli ? form.workerSlots : 1,
        instructions: form.instructions.trim() ? form.instructions : null,
      });
    } else {
      const original = formMode.entry;
      result = await roster.updateAgent({
        agentId: original.agent.id,
        displayName: form.displayName,
        ...(original.resource && form.modelName !== original.resource.modelName ? { modelName: form.modelName } : {}),
        instructions: form.instructions.trim() ? form.instructions : null,
      });
    }
    if (result.success) {
      setFormMode(null);
      setNotice({
        tone: 'success',
        message: t(formMode.kind === 'create' ? 'agentCenter.form.created' : 'agentCenter.form.saved', { name: result.agent.display_name }),
      });
    } else {
      setFormError(failureMessage(result));
    }
  };

  const submitRemove = async () => {
    if (!confirmRemove || roster.pending) return;
    const result = await roster.removeAgent(confirmRemove.agent.id);
    if (result.success) {
      setConfirmRemove(null);
      setRemoveError(null);
      setNotice({ tone: 'success', message: t('agentCenter.remove.removed', { name: result.agent.display_name }) });
    } else {
      setRemoveError(result);
    }
  };

  const restore = async (entry: AgentRosterEntry) => {
    const result = await roster.restoreAgent(entry.agent.id);
    setNotice(result.success
      ? { tone: 'success', message: t('agentCenter.remove.restored', { name: result.agent.display_name }) }
      : { tone: 'error', message: failureMessage(result) });
  };

  const editing = formMode?.kind === 'edit' ? formMode.entry : null;
  const modelLocked = Boolean(editing && editing.blockers.length > 0);
  const isCliConnection = form.connection !== 'MANUAL_BRIDGE';

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto overflow-y-auto">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight flex items-center space-x-2.5">
            <Bot className="w-5 h-5 text-forge-cyan" />
            <span>{t('agentCenter.title')}</span>
          </h2>
          <p className="text-xs text-slate-400">
            {t('agentCenter.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={showRemoved}
              onChange={(event) => setShowRemoved(event.target.checked)}
              className="accent-forge-cyan"
            />
            <span>{t('agentCenter.showRemoved')}</span>
          </label>
          <button
            type="button"
            onClick={openCreate}
            disabled={!roster.available || roster.pending}
            className="px-4 py-2 bg-forge-cyan hover:bg-cyan-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 font-bold rounded-lg text-xs shadow flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
            <span>{t('agentCenter.addAgent')}</span>
          </button>
        </div>
      </div>

      {!roster.available && (
        <div role="status" className="p-3 rounded-lg border border-surface-border bg-surface-card text-xs text-slate-300">
          {t('agentCenter.desktopOnly')}
        </div>
      )}

      {notice && (
        <div
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={`p-3 rounded-lg border text-xs ${notice.tone === 'error'
            ? 'bg-rose-950/40 border-rose-800/50 text-rose-300'
            : 'bg-emerald-950/30 border-emerald-800/50 text-emerald-300'}`}
        >
          {notice.message}
        </div>
      )}

      {roster.loadFailed && (
        <div role="alert" className="p-3 rounded-lg border border-rose-800/50 bg-rose-950/40 text-rose-300 text-xs flex items-center justify-between gap-3">
          <span>{t('agentCenter.loadFailed')}</span>
          <button type="button" onClick={() => void roster.reload()} className="px-3 py-1 rounded-md border border-rose-700 hover:bg-rose-900/40 flex items-center gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{t('agentCenter.retry')}</span>
          </button>
        </div>
      )}

      {roster.available && !roster.loading && !roster.loadFailed && roster.entries.length === 0 && (
        <div className="p-6 rounded-xl border border-dashed border-surface-border text-center text-sm text-slate-400">
          {t('agentCenter.emptyRoster')}
        </div>
      )}

      {roster.entries.length > 0 && groups.map((group) => (
        <section key={group.key} className="space-y-3" aria-label={group.title}>
          <h3 className="text-xs font-mono font-semibold text-slate-400 uppercase tracking-wider flex items-center space-x-2">
            {group.icon}
            <span>{group.title}</span>
            <span className="text-slate-500">({group.entries.length})</span>
          </h3>
          {group.entries.length === 0 ? (
            <p className="text-xs text-slate-500">{t('agentCenter.emptyRole')}</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {group.entries.map((entry) => (
                <AgentCard
                  key={entry.agent.id}
                  agent={entry.agent}
                  entry={entry}
                  resource={resources.find((r) => r.id === entry.agent.provider_resource_id)}
                  assignedTask={tasks.find((task) => task.id === entry.agent.current_task_id)}
                  actionsDisabled={roster.pending}
                  onViewTask={(taskId) => {
                    setSelectedTaskId(taskId);
                    setActiveView('task-detail');
                  }}
                  onEdit={() => openEdit(entry)}
                  onRemove={() => { setRemoveError(null); setConfirmRemove(entry); }}
                  onRestore={() => void restore(entry)}
                  onSignIn={!entry.account ? undefined
                    : entry.connection === 'CODEX_CLI'
                      ? (signIn.available ? () => { setSignInEntry(entry); void signIn.start(entry.account!.id); } : undefined)
                      : () => setCliSignInEntry(entry)}
                />
              ))}
            </div>
          )}
        </section>
      ))}

      {formMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <AccessibleDialog
            onDismiss={closeForm}
            dismissible={!roster.pending}
            aria-labelledby="agent-form-title"
            className="bg-surface border border-surface-border rounded-xl shadow-2xl max-w-xl w-full max-h-[90vh] overflow-y-auto p-6 space-y-5"
          >
            <h3 id="agent-form-title" className="text-base font-bold text-white">
              {editing ? t('agentCenter.form.editTitle', { name: editing.agent.display_name }) : t('agentCenter.form.createTitle')}
            </h3>
            <form onSubmit={submitForm} className="space-y-6 text-sm">
              <fieldset className="space-y-3">
                <legend className="text-xs font-semibold text-forge-cyan uppercase tracking-wider mb-2">{t('agentCenter.form.stepWho')}</legend>
                <div>
                  <label htmlFor="agent-name" className="block text-slate-300 mb-1">{t('agentCenter.form.nameLabel')}</label>
                  <input
                    id="agent-name"
                    data-dialog-initial-focus
                    type="text"
                    required
                    maxLength={80}
                    value={form.displayName}
                    onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                    placeholder={t('agentCenter.form.namePlaceholder')}
                    className={inputClass}
                  />
                </div>
                {!editing && (
                  <div role="radiogroup" aria-label={t('agentCenter.form.roleLabel')} className="space-y-2">
                    <div className="text-slate-300">{t('agentCenter.form.roleLabel')}</div>
                    {ROLE_OPTIONS.map((role) => (
                      <label key={role} className={`flex gap-3 p-2.5 rounded-lg border cursor-pointer ${form.role === role ? 'border-forge-cyan bg-forge-cyan/10' : 'border-surface-border hover:border-surface-hover'}`}>
                        <input type="radio" name="agent-role" value={role} checked={form.role === role} onChange={() => setForm({ ...form, role })} className="mt-1 accent-forge-cyan" />
                        <span>
                          <span className="block text-white font-medium">{t(`agentCenter.roles.${role}`)}</span>
                          <span className="block text-xs text-slate-400">{t(`agentCenter.roleHelp.${role}`)}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>

              <fieldset className="space-y-3">
                <legend className="text-xs font-semibold text-forge-cyan uppercase tracking-wider mb-2">{t('agentCenter.form.stepHow')}</legend>
                {!editing ? (
                  <div role="radiogroup" aria-label={t('agentCenter.form.connectionLabel')} className="space-y-2">
                    {CONNECTION_OPTIONS.map((connection) => (
                      <label key={connection} className={`flex gap-3 p-2.5 rounded-lg border cursor-pointer ${form.connection === connection ? 'border-forge-cyan bg-forge-cyan/10' : 'border-surface-border hover:border-surface-hover'}`}>
                        <input type="radio" name="agent-connection" value={connection} checked={form.connection === connection} onChange={() => setForm({ ...form, connection, modelName: '' })} className="mt-1 accent-forge-cyan" />
                        <span>
                          <span className="block text-white font-medium">{t(`agentCenter.connections.${connection}`)}</span>
                          <span className="block text-xs text-slate-400">{t(`agentCenter.connectionHelp.${connection}`)}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-400">
                    {t('agentCenter.details.connection')}: <span className="text-slate-200">{t(`agentCenter.connections.${editing.connection}`)}</span>
                  </p>
                )}

                <div>
                  <label htmlFor="agent-model" className="block text-slate-300 mb-1">{t('agentCenter.form.modelLabel')}</label>
                  <ModelPicker
                    id="agent-model"
                    connection={editing ? editing.connection : form.connection}
                    value={form.modelName}
                    disabled={modelLocked}
                    describedBy={modelLocked ? 'agent-model-locked' : undefined}
                    onChange={(modelName) => setForm((current) => ({ ...current, modelName }))}
                    inputClass={inputClass}
                  />
                  {modelLocked && <p id="agent-model-locked" className="mt-1 text-xs text-amber-300">{t('agentCenter.form.modelLockedHint')}</p>}
                </div>

                {!editing && isCliConnection && (
                  <>
                    <div>
                      <label htmlFor="agent-profile" className="block text-slate-300 mb-1">{t('agentCenter.form.profileLabel')}</label>
                      <input
                        id="agent-profile"
                        type="text"
                        maxLength={64}
                        pattern="[A-Za-z0-9_.\-]*"
                        value={form.profileId}
                        aria-describedby="agent-profile-help"
                        onChange={(event) => setForm({ ...form, profileId: event.target.value })}
                        className={`${inputClass} font-mono`}
                      />
                      <p id="agent-profile-help" className="mt-1 text-xs text-slate-400">{t('agentCenter.form.profileHelp')}</p>
                    </div>
                    <div>
                      <label htmlFor="agent-slots" className="block text-slate-300 mb-1">{t('agentCenter.form.slotsLabel')}</label>
                      <select
                        id="agent-slots"
                        value={form.workerSlots}
                        aria-describedby="agent-slots-help"
                        onChange={(event) => setForm({ ...form, workerSlots: Number(event.target.value) })}
                        className={inputClass}
                      >
                        {Array.from({ length: MAX_AGENT_WORKER_SLOTS }, (_, index) => index + 1).map((count) => (
                          <option key={count} value={count}>{count}</option>
                        ))}
                      </select>
                      <p id="agent-slots-help" className="mt-1 text-xs text-slate-400">{t('agentCenter.form.slotsHelp', { max: MAX_AGENT_WORKER_SLOTS })}</p>
                    </div>
                  </>
                )}
                {!editing && <p className="text-xs text-slate-500">{t('agentCenter.form.healthUnknownNote')}</p>}
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold text-forge-cyan uppercase tracking-wider mb-2">{t('agentCenter.form.stepExtra')}</legend>
                <label htmlFor="agent-instructions" className="block text-slate-300">{t('agentCenter.form.instructionsLabel')}</label>
                <textarea
                  id="agent-instructions"
                  maxLength={8000}
                  value={form.instructions}
                  onChange={(event) => setForm({ ...form, instructions: event.target.value })}
                  placeholder={t('agentCenter.form.instructionsPlaceholder')}
                  className={`${inputClass} h-24 resize-y`}
                />
              </fieldset>

              {formError && (
                <div role="alert" className="p-2.5 bg-rose-950/40 border border-rose-800/50 text-rose-300 rounded-lg text-xs">
                  {formError}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-3 border-t border-surface-border">
                <button
                  type="button"
                  onClick={closeForm}
                  disabled={roster.pending}
                  className="px-4 py-2 bg-surface-card hover:bg-surface-border text-slate-300 rounded-lg text-xs"
                >
                  {t('agentCenter.form.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={roster.pending || !form.displayName.trim() || !form.modelName.trim()}
                  aria-busy={roster.pending}
                  className="px-5 py-2 bg-forge-cyan hover:bg-cyan-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 font-bold rounded-lg text-xs shadow"
                >
                  {roster.pending ? t('actions.pending') : editing ? t('agentCenter.form.save') : t('agentCenter.form.create')}
                </button>
              </div>
            </form>
          </AccessibleDialog>
        </div>
      )}

      {cliSignInEntry?.account && (
        <CliSignInDialog
          agentName={cliSignInEntry.agent.display_name}
          accountId={cliSignInEntry.account.id}
          onVerified={afterSignIn}
          onClose={() => setCliSignInEntry(null)}
        />
      )}
      {signInEntry && signIn.view && (
        <SignInDialog
          agentName={signInEntry.agent.display_name}
          view={signIn.view}
          terminal={signIn.terminal}
          onOpenPage={() => void signIn.openPage()}
          onCancel={() => { void signIn.cancel(); setSignInEntry(null); }}
          onClose={() => { signIn.close(); setSignInEntry(null); }}
        />
      )}

      {confirmRemove && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <AccessibleDialog
            onDismiss={() => { if (!roster.pending) setConfirmRemove(null); }}
            dismissible={!roster.pending}
            aria-labelledby="agent-remove-title"
            aria-describedby="agent-remove-body"
            className="bg-surface border border-surface-border rounded-xl shadow-2xl max-w-md w-full p-6 space-y-4"
          >
            <h3 id="agent-remove-title" className="text-base font-bold text-white">
              {t('agentCenter.remove.confirmTitle', { name: confirmRemove.agent.display_name })}
            </h3>
            <p id="agent-remove-body" className="text-sm text-slate-300">{t('agentCenter.remove.confirmBody')}</p>
            {removeError && !removeError.success && (
              <div role="alert" className="p-2.5 bg-rose-950/40 border border-rose-800/50 text-rose-300 rounded-lg text-xs space-y-1">
                <div>{failureMessage(removeError)}</div>
                {removeError.blockers.length > 0 && (
                  <ul className="list-disc pl-4">
                    {removeError.blockers.map((blocker) => (
                      <li key={`${blocker.code}-${blocker.reference}`}>{t(`agentCenter.blockers.${blocker.code}`, { reference: blocker.reference })}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="flex justify-end gap-3 pt-3 border-t border-surface-border">
              <button
                type="button"
                data-dialog-initial-focus
                onClick={() => setConfirmRemove(null)}
                disabled={roster.pending}
                className="px-4 py-2 bg-surface-card hover:bg-surface-border text-slate-300 rounded-lg text-xs"
              >
                {t('agentCenter.remove.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void submitRemove()}
                disabled={roster.pending}
                aria-busy={roster.pending}
                className="px-5 py-2 bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold rounded-lg text-xs shadow"
              >
                {roster.pending ? t('actions.pending') : t('agentCenter.remove.confirm')}
              </button>
            </div>
          </AccessibleDialog>
        </div>
      )}
    </div>
  );
};
