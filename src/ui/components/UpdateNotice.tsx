import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, RotateCw } from 'lucide-react';
import { useI18n } from '../context/I18nContext';

interface UpdateView {
  state: string;
  version: string | null;
  percent: number | null;
  canInstall: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const STATES = new Set(['IDLE', 'CHECKING', 'UPDATE_AVAILABLE', 'NO_UPDATE_AVAILABLE', 'DOWNLOADING', 'DOWNLOADED', 'INSTALLING', 'ERROR', 'DISABLED']);
const POLL_MS = 60_000;
const ACTIVE_POLL_MS = 1_500;

/** Accepts only a well-formed `update:*` reply; anything else is "unknown". */
export function normalizeUpdateReply(reply: unknown): UpdateView | null {
  if (!isRecord(reply) || reply.success !== true || !isRecord(reply.summary)) return null;
  const s = reply.summary;
  if (typeof s.state !== 'string' || !STATES.has(s.state)) return null;
  const info = isRecord(s.updateInfo) ? s.updateInfo : null;
  const progress = isRecord(s.progress) ? s.progress : null;
  return {
    state: s.state,
    version: info && typeof info.version === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(info.version) ? info.version : null,
    percent: progress && typeof progress.percent === 'number' ? Math.max(0, Math.min(100, Math.round(progress.percent))) : null,
    canInstall: s.canInstall === true,
  };
}

/**
 * Header notice for dev-channel updates (#298). One owner click downloads the
 * update and then restarts into it as soon as no work is running; until then
 * it says why it waits. Nothing is downloaded or installed without that click.
 */
export const UpdateNotice: React.FC = () => {
  const { t } = useI18n();
  const api = typeof window !== 'undefined' ? (window as any).orchestrator ?? null : null;
  const [view, setView] = useState<UpdateView | null>(null);
  const [requested, setRequested] = useState(false);
  const [failed, setFailed] = useState(false);
  const installing = useRef(false);

  const refresh = useCallback(async () => {
    if (!api?.getUpdateState) return;
    try {
      const next = normalizeUpdateReply(await api.getUpdateState());
      if (next) setView(next);
    } catch { /* The next poll retries. */ }
  }, [api]);

  useEffect(() => {
    void refresh();
    const active = requested || view?.state === 'DOWNLOADING';
    const handle = setInterval(() => { void refresh(); }, active ? ACTIVE_POLL_MS : POLL_MS);
    return () => clearInterval(handle);
  }, [refresh, requested, view?.state]);

  // The owner already chose to update: restart as soon as it is downloaded and safe.
  useEffect(() => {
    if (!requested || installing.current || view?.state !== 'DOWNLOADED' || !view.canInstall) return;
    installing.current = true;
    void (async () => {
      try {
        const reply = await api.installAndRestartUpdate();
        if (!isRecord(reply) || reply.success !== true) { installing.current = false; setFailed(true); }
      } catch { installing.current = false; setFailed(true); }
    })();
  }, [api, requested, view]);

  if (!api?.getUpdateState || !view) return null;
  const start = async () => {
    setFailed(false);
    setRequested(true);
    try {
      const reply = view.state === 'DOWNLOADED' ? null : await api.downloadUpdate();
      if (reply && (!isRecord(reply) || reply.success !== true)) setFailed(true);
    } catch { setFailed(true); }
    await refresh();
  };

  const base = 'h-7 px-2.5 rounded-md text-[11px] font-medium flex items-center gap-1.5 whitespace-nowrap border';
  if (view.state === 'UPDATE_AVAILABLE' || (view.state === 'DOWNLOADED' && !requested) || (view.state === 'ERROR' && requested)) {
    return (
      <button type="button" onClick={() => void start()}
        title={failed || view.state === 'ERROR' ? t('updateNotice.failed') : t('updateNotice.hint')}
        className={`${base} border-forge-cyan/40 bg-forge-cyan/10 hover:bg-forge-cyan/20 text-forge-cyan`}>
        <Download className="w-3.5 h-3.5" aria-hidden="true" />
        <span>{view.state === 'ERROR' ? t('updateNotice.retry') : t('updateNotice.update', { version: view.version ?? '' })}</span>
      </button>
    );
  }
  if (view.state === 'DOWNLOADING') {
    return (
      <span role="status" className={`${base} border-surface-border text-slate-300`}>
        <Download className="w-3.5 h-3.5 animate-pulse" aria-hidden="true" />
        {t('updateNotice.downloading', { percent: view.percent ?? 0 })}
      </span>
    );
  }
  if (view.state === 'DOWNLOADED' || view.state === 'INSTALLING') {
    return (
      <span role="status" title={view.canInstall ? undefined : t('updateNotice.waitingHint')}
        className={`${base} ${view.canInstall ? 'border-emerald-700/50 text-emerald-300' : 'border-amber-700/40 text-amber-300'}`}>
        <RotateCw className="w-3.5 h-3.5" aria-hidden="true" />
        {view.canInstall ? t('updateNotice.restarting') : t('updateNotice.waiting')}
      </span>
    );
  }
  return null;
};
