import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { useOrchestrator } from '../context/OrchestratorContext';
import { useQuotaObservations } from '../runtimeStatus';
import { buildQuotaGroups, countdown, type QuotaTone, type QuotaWindowView } from '../quotaDashboard';

const STATUS_KEYS = new Set(['OK', 'UNAUTHENTICATED', 'UNSUPPORTED', 'UNAVAILABLE', 'ERROR']);
const BAR: Record<QuotaTone, string> = { GOOD: 'bg-emerald-400', WARN: 'bg-amber-400', LOW: 'bg-rose-500', UNKNOWN: 'bg-slate-600' };
const TEXT: Record<QuotaTone, string> = { GOOD: 'text-emerald-300', WARN: 'text-amber-300', LOW: 'text-rose-300', UNKNOWN: 'text-slate-400' };

/**
 * Router-style quota overview (#243): one card per account, grouped by CLI,
 * with remaining % per limit window, reset countdown, plan, health and the
 * source of every number. Unknown stays unknown; nothing is guessed.
 */
export const ProviderQuotaPanel: React.FC = () => {
  const { t } = useI18n();
  const { resources, agents, refreshData } = useOrchestrator();
  const quota = useQuotaObservations();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(handle);
  }, []);
  if (!quota.available) return null;
  const groups = buildQuotaGroups(quota.observations, resources, agents, now);
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');
  const duration = (resetsAt: string | null) => {
    const left = countdown(resetsAt, now);
    if (!left) return null;
    return left.days > 0 ? t('runtime.quota.durationDays', { days: left.days, hours: left.hours })
      : left.hours > 0 ? t('runtime.quota.durationHours', { hours: left.hours, minutes: left.minutes })
        : t('runtime.quota.durationMinutes', { minutes: left.minutes });
  };
  const windowLabel = (window: QuotaWindowView) => window.label ?? t(`runtime.quota.window.${window.kind}`, { minutes: window.windowMinutes ?? 0 });

  return (
    <section aria-labelledby="provider-quota-title" className="bg-surface-card border border-surface-border rounded-xl p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id="provider-quota-title" className="text-sm font-semibold text-white">{t('runtime.quota.title')}</h3>
          <p className="text-xs text-slate-400">{t('runtime.quota.subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={() => void quota.refresh(refreshData)}
          disabled={quota.refreshing}
          aria-busy={quota.refreshing}
          className="px-3 py-1.5 rounded-lg text-xs border border-forge-cyan/40 text-forge-cyan bg-forge-cyan/10 hover:bg-forge-cyan/20 disabled:opacity-40 flex items-center gap-1.5"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${quota.refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
          <span>{quota.refreshing ? t('runtime.quota.refreshing') : t('runtime.quota.refresh')}</span>
        </button>
      </div>
      {quota.unofficialReaders !== null && (
        <label className="flex items-start gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={quota.unofficialReaders}
            disabled={quota.refreshing}
            onChange={(event) => void quota.setUnofficial(event.target.checked, refreshData)}
          />
          <span>
            {t('runtime.quota.unofficialToggle')}
            <span className="block text-[11px] text-slate-500">{t('runtime.quota.unofficialHint')}</span>
          </span>
        </label>
      )}
      {quota.failed && <p role="alert" className="text-xs text-rose-300">{t('runtime.quota.failed')}</p>}
      {groups.length === 0 ? (
        <p className="text-xs text-slate-500">{t('runtime.quota.empty')}</p>
      ) : groups.map((group) => (
        <div key={group.cli} className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <h4 className="font-semibold text-slate-200">{t(`runtime.quota.cli.${group.cli}`)}</h4>
            <span className={group.usable > 0 ? 'text-emerald-300' : 'text-amber-300'}>
              {t('runtime.quota.usableSummary', { usable: group.usable, total: group.total })}
            </span>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2">
            {group.cards.map((card) => {
              const statusKey = STATUS_KEYS.has(card.status) ? card.status : 'UNAVAILABLE';
              return (
                <li key={card.accountId} className="border border-surface-border rounded-lg p-3 space-y-2 bg-surface">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm text-slate-100 font-medium truncate" title={card.accountId}>
                        {card.agentNames.join(', ') || card.models.join(', ') || card.accountId}
                      </p>
                      <p className="text-[11px] text-slate-400 truncate">
                        {[card.models.join(', '), card.plan ? t('runtime.quota.plan', { plan: card.plan }) : null].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border ${card.usable ? 'border-emerald-700/50 text-emerald-300' : 'border-amber-700/50 text-amber-300'}`}>
                      {card.usable ? t('runtime.quota.usable') : t('runtime.quota.notUsable')}
                    </span>
                  </div>
                  {card.windows.length === 0 ? (
                    <p className="text-xs text-slate-400">{t(`runtime.quota.status.${statusKey}`)}</p>
                  ) : card.windows.map((window, index) => {
                    const left = duration(window.resetsAt);
                    return (
                      <div key={index} className="space-y-1">
                        <div className="flex justify-between text-[11px]">
                          <span className="text-slate-300">{windowLabel(window)}</span>
                          <span className={TEXT[window.tone]}>
                            {window.remainingPercent !== null ? t('runtime.quota.remaining', { percent: window.remainingPercent }) : t('runtime.quota.unknownValue')}
                          </span>
                        </div>
                        <div className="h-1.5 rounded bg-surface-border overflow-hidden" role="presentation">
                          <div className={`h-full ${BAR[window.tone]}`} style={{ width: `${Math.max(0, Math.min(100, window.remainingPercent ?? 0))}%` }} />
                        </div>
                        {left && <p className="text-[10px] text-slate-500">{t('runtime.quota.resetsIn', { time: left })}</p>}
                      </div>
                    );
                  })}
                  <p className="text-[10px] text-slate-500">
                    {t(`runtime.quota.source.${card.source}`)} · {t('runtime.quota.observedAt', { time: when(card.observedAt) })}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
};
