import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Gavel } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { normalizeManagerPanelReply, type ManagerPanelState } from '../managerDecisions';

/**
 * The owner's view of the automated Manager for one project (#239): the
 * auto/approve mode and the proposals waiting for approval. Approval goes
 * back through the main process, which re-checks freshness and applies the
 * decision only through TaskService.
 */
export const ManagerDecisionsPanel: React.FC<{ projectId: string }> = ({ projectId }) => {
  const { t } = useI18n();
  const api = typeof window !== 'undefined' ? (window as any).orchestrator ?? null : null;
  const [state, setState] = useState<{ projectId: string; panel: ManagerPanelState } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [parallel, setParallel] = useState<{ projectId: string; count: number } | null>(null);
  const currentProject = useRef(projectId);
  currentProject.current = projectId;

  const load = useCallback(async () => {
    if (!api?.getManagerDecisions) return;
    const requested = projectId;
    try {
      const next = normalizeManagerPanelReply(await api.getManagerDecisions(requested));
      if (currentProject.current !== requested) return; // A reply for a project no longer shown.
      setState(next ? { projectId: requested, panel: next } : null);
      setLoadFailed(next === null);
      const reply = api.getParallelTasks ? await api.getParallelTasks(requested) : null;
      const count = reply?.success === true && Number.isInteger(reply.parallelTasks) ? reply.parallelTasks : null;
      if (currentProject.current === requested && count !== null && count >= 1 && count <= 10) setParallel({ projectId: requested, count });
    } catch {
      if (currentProject.current === requested) setLoadFailed(true);
    }
  }, [api, projectId]);

  useEffect(() => {
    setState(null);
    setActionFailed(false);
    void load();
    const handle = setInterval(() => { void load(); }, 10_000);
    return () => clearInterval(handle);
  }, [load]);

  if (!api?.getManagerDecisions) return null;
  const panel = state?.projectId === projectId ? state.panel : null;

  const run = async (action: () => Promise<{ success?: boolean } | undefined>) => {
    setBusy(true);
    try {
      const reply = await action();
      setActionFailed(!reply?.success);
    } catch {
      setActionFailed(true);
    } finally {
      setBusy(false);
      await load();
    }
  };

  return (
    <section aria-labelledby="manager-decisions-title" className="bg-surface-card border border-surface-border rounded-2xl p-6 shadow-xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id="manager-decisions-title" className="text-base font-semibold text-white flex items-center gap-2.5">
            <Gavel aria-hidden="true" className="w-5 h-5 text-forge-cyan" />
            {t('runtime.managerPanel.title')}
          </h3>
          <p className="text-xs text-slate-400">{t('runtime.managerPanel.subtitle')}</p>
        </div>
        {panel && (
          <label className="text-xs text-slate-300 flex items-center gap-2">
            <span>{t('runtime.managerPanel.modeLabel')}</span>
            <select
              value={panel.mode}
              disabled={busy}
              onChange={(event) => void run(() => api.setManagerMode(projectId, event.target.value))}
              className="bg-surface border border-surface-border rounded-md px-2 py-1 text-slate-100"
            >
              <option value="APPROVE">{t('runtime.managerPanel.modeApprove')}</option>
              <option value="AUTO">{t('runtime.managerPanel.modeAuto')}</option>
            </select>
          </label>
        )}
        {parallel?.projectId === projectId && (
          <label className="text-xs text-slate-300 flex items-center gap-2" title={t('runtime.managerPanel.parallelHint')}>
            <span>{t('runtime.managerPanel.parallelLabel')}</span>
            <select
              value={parallel.count}
              disabled={busy}
              onChange={(event) => {
                const count = Number(event.target.value);
                void run(async () => {
                  const reply = await api.setParallelTasks(projectId, count);
                  if (reply?.success) setParallel({ projectId, count });
                  return reply;
                });
              }}
              className="bg-surface border border-surface-border rounded-md px-2 py-1 text-slate-100"
            >
              {Array.from({ length: 10 }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count}</option>)}
            </select>
          </label>
        )}
      </div>
      {(loadFailed || actionFailed) && <p role="alert" className="text-xs text-rose-300">{t('runtime.managerPanel.failed')}</p>}
      {panel && panel.proposals.length === 0 && <p className="text-xs text-slate-500">{t('runtime.managerPanel.empty')}</p>}
      {panel && panel.proposals.length > 0 && (
        <ul className="divide-y divide-surface-border">
          {panel.proposals.map((proposal) => (
            <li key={proposal.eventId} className="py-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-slate-100 font-medium">
                  {proposal.taskTitle}{' '}
                  <span className="text-xs text-slate-400">({t('runtime.managerPanel.revision', { revision: proposal.taskRevision })})</span>
                </span>
                <span className="text-xs text-forge-cyan">
                  {proposal.decision === 'EXECUTE' || proposal.decision === 'BLOCK' || proposal.decision === 'PLAN'
                    ? t(`runtime.managerPanel.decision${proposal.decision}`)
                    : proposal.decision}
                </span>
              </div>
              {proposal.plannedTasks.length > 0 ? (
                <ol className="list-decimal pl-5 text-xs text-slate-300 space-y-1.5">
                  {proposal.plannedTasks.map((planned, index) => (
                    <li key={index}>
                      <span className="text-slate-100 font-medium">{planned.title}</span>
                      <span className="text-slate-500"> · {planned.priority} · {planned.risk}</span>
                      {planned.description && <p className="text-slate-400">{planned.description}</p>}
                      <ul className="list-disc pl-4 text-slate-400">
                        {planned.acceptanceCriteria.map((criterion, i) => <li key={i}>{criterion}</li>)}
                      </ul>
                    </li>
                  ))}
                </ol>
              ) : proposal.instructions.length > 0 && (
                <ul className="list-disc pl-5 text-xs text-slate-300 space-y-0.5">
                  {proposal.instructions.map((line, index) => <li key={index}>{line}</li>)}
                </ul>
              )}
              <div className="flex gap-2">
                <button type="button" disabled={busy}
                  onClick={() => void run(() => api.decideManagerProposal(projectId, proposal.eventId, true))}
                  className="px-3 py-1.5 rounded-lg text-xs border border-emerald-600/50 text-emerald-300 bg-emerald-900/20 hover:bg-emerald-900/40 disabled:opacity-40">
                  {t('runtime.managerPanel.approve')}
                </button>
                <button type="button" disabled={busy}
                  onClick={() => void run(() => api.decideManagerProposal(projectId, proposal.eventId, false))}
                  className="px-3 py-1.5 rounded-lg text-xs border border-rose-700/50 text-rose-300 bg-rose-900/20 hover:bg-rose-900/40 disabled:opacity-40">
                  {t('runtime.managerPanel.reject')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
