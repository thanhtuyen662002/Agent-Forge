import React from 'react';
import { RefreshCw } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { useOrchestrator } from '../context/OrchestratorContext';
import { useQuotaObservations } from '../runtimeStatus';

const STATUS_KEYS = new Set(['OK', 'UNAUTHENTICATED', 'UNSUPPORTED', 'UNAVAILABLE', 'ERROR']);

/** Read-only provider quota telemetry with an explicit refresh; unknown stays unknown. */
export const ProviderQuotaPanel: React.FC = () => {
  const { t } = useI18n();
  const { resources, refreshData } = useOrchestrator();
  const quota = useQuotaObservations();
  if (!quota.available) return null;
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');

  return (
    <section aria-labelledby="provider-quota-title" className="bg-surface-card border border-surface-border rounded-xl p-5 space-y-3">
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
      {quota.failed && <p role="alert" className="text-xs text-rose-300">{t('runtime.quota.failed')}</p>}
      {quota.observations.length === 0 ? (
        <p className="text-xs text-slate-500">{t('runtime.quota.empty')}</p>
      ) : (
        <ul className="divide-y divide-surface-border">
          {quota.observations.map((observation) => {
            const models = observation.resourceIds
              .map((id) => resources.find((resource) => resource.id === id)?.model_name)
              .filter(Boolean)
              .join(', ');
            const statusKey = STATUS_KEYS.has(observation.status) ? observation.status : 'UNAVAILABLE';
            return (
              <li key={observation.accountId} className="py-2 text-xs flex flex-wrap items-center justify-between gap-2">
                <span className="text-slate-200 truncate" title={observation.accountId}>{models || observation.accountId}</span>
                <span className="text-slate-400">
                  {t(`runtime.quota.status.${statusKey}`)}
                  {observation.status === 'OK' && observation.remainingPercent !== null && (
                    <> · <strong className="text-slate-100">{t('runtime.quota.remaining', { percent: observation.remainingPercent })}</strong></>
                  )}
                  {observation.resetsAt && <> · {t('runtime.quota.resetsAt', { time: when(observation.resetsAt) })}</>}
                  {' · '}{t('runtime.quota.observedAt', { time: when(observation.observedAt) })}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
