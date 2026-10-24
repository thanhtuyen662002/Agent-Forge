import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GitBranch, Trash2 } from 'lucide-react';
import { useI18n } from '../context/I18nContext';

interface IntegrationEntryView {
  taskId: string;
  taskTitle: string;
  taskRevision: number;
  state: 'READY' | 'BRANCH_CREATED' | 'DISCARDED';
  branch: string | null;
  changedFiles: string[];
  leftoverCopy: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const STATES = new Set(['READY', 'BRANCH_CREATED', 'DISCARDED']);

/** Accepts only a well-formed `integration:list` reply; anything else is "unknown". */
export function normalizeIntegrationReply(reply: unknown): IntegrationEntryView[] | null {
  if (!isRecord(reply) || reply.success !== true || !Array.isArray(reply.entries)) return null;
  const entries: IntegrationEntryView[] = [];
  for (const item of reply.entries) {
    if (!isRecord(item) || typeof item.taskId !== 'string' || typeof item.taskTitle !== 'string' || typeof item.taskRevision !== 'number' ||
        typeof item.state !== 'string' || !STATES.has(item.state)) return null;
    entries.push({
      taskId: item.taskId, taskTitle: item.taskTitle, taskRevision: item.taskRevision, state: item.state as IntegrationEntryView['state'],
      branch: typeof item.branch === 'string' ? item.branch : null,
      changedFiles: Array.isArray(item.changedFiles) ? item.changedFiles.filter((file): file is string => typeof file === 'string') : [],
      leftoverCopy: item.leftoverCopy === true,
    });
  }
  return entries;
}

/**
 * Reviewed work of the active project (#238). Creating a branch or discarding
 * is always the owner's explicit action; nothing is merged or pushed.
 */
export const ReviewedWorkPanel: React.FC<{ projectId: string }> = ({ projectId }) => {
  const { t } = useI18n();
  const api = typeof window !== 'undefined' ? (window as any).orchestrator ?? null : null;
  const [entries, setEntries] = useState<{ projectId: string; list: IntegrationEntryView[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const current = useRef(projectId);
  current.current = projectId;

  const load = useCallback(async () => {
    if (!api?.getIntegrations) return;
    const requested = projectId;
    try {
      const list = normalizeIntegrationReply(await api.getIntegrations(requested));
      if (current.current === requested && list) setEntries({ projectId: requested, list });
    } catch { /* keep the last known list */ }
  }, [api, projectId]);

  useEffect(() => {
    setEntries(null);
    setError(null);
    void load();
    const handle = setInterval(() => { void load(); }, 15_000);
    return () => clearInterval(handle);
  }, [load]);

  if (!api?.getIntegrations) return null;
  const list = entries?.projectId === projectId ? entries.list : [];
  if (list.length === 0) return null;

  const act = async (taskId: string, action: () => Promise<unknown>) => {
    setBusy(taskId);
    setError(null);
    try {
      const reply = await action();
      if (!isRecord(reply) || reply.success !== true) {
        const code = isRecord(reply) && typeof reply.errorCode === 'string' && /^[A-Z_]{1,64}$/.test(reply.errorCode) ? reply.errorCode : 'UNKNOWN';
        setError(t('runtime.integrationPanel.failed', { code }));
      }
    } catch {
      setError(t('runtime.integrationPanel.failed', { code: 'UNKNOWN' }));
    } finally {
      setBusy(null);
      await load();
    }
  };

  return (
    <section aria-labelledby="reviewed-work-title" className="bg-surface-card border border-surface-border rounded-2xl p-6 shadow-xl space-y-4">
      <div>
        <h3 id="reviewed-work-title" className="text-base font-semibold text-white flex items-center gap-2.5">
          <GitBranch aria-hidden="true" className="w-5 h-5 text-forge-emerald" />
          {t('runtime.integrationPanel.title')}
        </h3>
        <p className="text-xs text-slate-400">{t('runtime.integrationPanel.subtitle')}</p>
      </div>
      {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}
      <ul className="divide-y divide-surface-border">
        {list.map((entry) => (
          <li key={entry.taskId} className="py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-slate-100 font-medium truncate">{entry.taskTitle}</p>
              {entry.state === 'BRANCH_CREATED' && entry.branch && (
                <p className="text-xs text-emerald-300">{t('runtime.integrationPanel.branchCreated', { branch: entry.branch })}</p>
              )}
              {entry.state === 'BRANCH_CREATED' && entry.changedFiles.length > 0 && (
                <p className="text-xs text-slate-400">{t('runtime.integrationPanel.filesChanged', { count: entry.changedFiles.length })}</p>
              )}
              {entry.state === 'DISCARDED' && <p className="text-xs text-slate-400">{t('runtime.integrationPanel.discarded')}</p>}
            </div>
            {entry.state === 'BRANCH_CREATED' && entry.leftoverCopy && (
              <button type="button" disabled={busy !== null}
                onClick={() => void act(entry.taskId, () => api.discardIntegration(projectId, entry.taskId))}
                className="px-3 py-1.5 rounded-lg text-xs border border-surface-border text-slate-300 hover:bg-surface-hover disabled:opacity-40">
                {t('runtime.integrationPanel.removeLeftover')}
              </button>
            )}
            {entry.state === 'READY' && (
              <div className="flex gap-2">
                <button type="button" disabled={busy !== null}
                  onClick={() => void act(entry.taskId, () => api.createIntegrationBranch(projectId, entry.taskId))}
                  className="px-3 py-1.5 rounded-lg text-xs border border-emerald-600/50 text-emerald-300 bg-emerald-900/20 hover:bg-emerald-900/40 disabled:opacity-40 flex items-center gap-1.5">
                  <GitBranch className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{t('runtime.integrationPanel.create')}</span>
                </button>
                <button type="button" disabled={busy !== null}
                  onClick={() => {
                    // Two steps: the first click asks, the second discards.
                    if (confirming !== entry.taskId) { setConfirming(entry.taskId); return; }
                    setConfirming(null);
                    void act(entry.taskId, () => api.discardIntegration(projectId, entry.taskId));
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs border border-rose-700/50 text-rose-300 bg-rose-900/20 hover:bg-rose-900/40 disabled:opacity-40 flex items-center gap-1.5">
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{confirming === entry.taskId ? t('runtime.integrationPanel.confirmDiscard') : t('runtime.integrationPanel.discard')}</span>
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
};
