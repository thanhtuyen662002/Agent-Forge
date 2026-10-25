import React, { useEffect, useState } from 'react';
import { FolderTree } from 'lucide-react';
import { useI18n } from '../context/I18nContext';

const REASONS = new Set([
  'CONTEXT_PATH_INVALID', 'CONTEXT_PATH_MISSING', 'CONTEXT_PATH_DENIED', 'CONTEXT_PATH_LINK', 'CONTEXT_LIMIT_EXCEEDED', 'TASK_NOT_FOUND', 'ENTITY_IN_TRASH',
]);

type Notice = { kind: 'saved' } | { kind: 'error'; reason: string; path: string | null };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const pathList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value as string[] : null;

/**
 * The coder's context for one task (#261): repository files or folders, one
 * per line. Empty means the repository's top-level entries. The desktop app
 * validates every path against the repository before storing it.
 */
export const TaskContextEditor: React.FC<{ projectId: string; taskId: string }> = ({ projectId, taskId }) => {
  const { t } = useI18n();
  const api = typeof window !== 'undefined' ? (window as any).orchestrator ?? null : null;
  const [saved, setSaved] = useState<string[] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    let active = true;
    setSaved(null);
    setNotice(null);
    if (!api?.getTaskContextPaths) return undefined;
    api.getTaskContextPaths(projectId, taskId).then((reply: unknown) => {
      const paths = isRecord(reply) && reply.success === true ? pathList(reply.paths) : null;
      if (!active) return;
      if (paths) { setSaved(paths); setDraft(paths.join('\n')); }
      else setNotice({ kind: 'error', reason: 'LOAD_FAILED', path: null });
    }).catch(() => { if (active) setNotice({ kind: 'error', reason: 'LOAD_FAILED', path: null }); });
    return () => { active = false; };
  }, [api, projectId, taskId]);

  if (!api?.getTaskContextPaths) return null;

  const requested = draft.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const unchanged = saved !== null && requested.join('\n') === saved.join('\n');

  const save = async () => {
    if (busy || saved === null) return;
    setBusy(true);
    setNotice(null);
    try {
      const reply: unknown = await api.setTaskContextPaths(projectId, taskId, requested);
      const paths = isRecord(reply) && reply.success === true ? pathList(reply.paths) : null;
      if (paths) {
        setSaved(paths);
        setDraft(paths.join('\n'));
        setNotice({ kind: 'saved' });
      } else {
        const reason = isRecord(reply) && typeof reply.errorCode === 'string' && REASONS.has(reply.errorCode) ? reply.errorCode : 'SAVE_FAILED';
        const path = isRecord(reply) && typeof reply.path === 'string' ? reply.path : null;
        setNotice({ kind: 'error', reason, path });
      }
    } catch {
      setNotice({ kind: 'error', reason: 'SAVE_FAILED', path: null });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h3 className="text-xs font-mono font-semibold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
        <FolderTree className="w-3.5 h-3.5" aria-hidden="true" />
        <label htmlFor={`task-context-${taskId}`}>{t('taskDetail.contextTitle')}</label>
      </h3>
      <div className="p-4 bg-surface rounded-xl border border-surface-border space-y-2">
        <p id={`task-context-help-${taskId}`} className="text-[11px] text-slate-400">{t('taskDetail.contextHelp')}</p>
        <textarea
          id={`task-context-${taskId}`}
          aria-describedby={`task-context-help-${taskId}`}
          value={draft}
          onChange={(event) => { setDraft(event.target.value); setNotice(null); }}
          disabled={saved === null || busy}
          rows={Math.min(8, Math.max(3, requested.length + 1))}
          spellCheck={false}
          placeholder={t('taskDetail.contextPlaceholder')}
          className="w-full bg-surface-card border border-surface-border rounded-lg p-2 text-xs font-mono text-slate-200"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-slate-500">
            {saved !== null && saved.length === 0 ? t('taskDetail.contextDefault') : t('taskDetail.contextCount', { count: saved?.length ?? 0 })}
          </span>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saved === null || busy || unchanged}
            aria-busy={busy}
            className="px-3 py-1.5 rounded-lg text-xs border border-forge-cyan/40 text-forge-cyan bg-forge-cyan/10 hover:bg-forge-cyan/20 disabled:opacity-40"
          >
            {busy ? t('taskDetail.contextSaving') : t('taskDetail.contextSave')}
          </button>
        </div>
        {notice?.kind === 'saved' && <p role="status" className="text-xs text-emerald-300">{t('taskDetail.contextSaved')}</p>}
        {notice?.kind === 'error' && (
          <p role="alert" className="text-xs text-rose-300">
            {t(`taskDetail.contextError.${notice.reason}`)}{notice.path ? ` (${notice.path})` : ''}
          </p>
        )}
      </div>
    </div>
  );
};
