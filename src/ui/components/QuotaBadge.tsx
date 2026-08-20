import React from 'react';
import { QuotaSource } from '../../core/types/domain';
import { useI18n } from '../context/I18nContext';

interface QuotaBadgeProps {
  remaining: number | null;
  total: number | null;
  unit: string;
  source: QuotaSource;
  confidence?: number;
}

export const QuotaBadge: React.FC<QuotaBadgeProps> = ({
  remaining,
  total,
  unit,
  source,
  confidence = 1.0,
}) => {
  const { t } = useI18n();

  if (remaining === null || source === 'UNKNOWN') {
    return (
      <div className="inline-flex items-center space-x-1.5 px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-[11px] font-mono text-slate-400">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-500"></span>
        <span>{t('quota.unknown')}</span>
      </div>
    );
  }

  const percent = total && total > 0 ? Math.round((remaining / total) * 100) : null;

  let colorClass = 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
  let dotClass = 'bg-emerald-400';

  if (percent !== null) {
    if (percent <= 10) {
      colorClass = 'bg-rose-500/20 text-rose-400 border-rose-500/30';
      dotClass = 'bg-rose-400 animate-pulse';
    } else if (percent <= 25) {
      colorClass = 'bg-amber-500/20 text-amber-400 border-amber-500/30';
      dotClass = 'bg-amber-400';
    }
  }

  const sourceLabel =
    source === 'MANUAL'
      ? t('quota.manual')
      : source === 'MEASURED'
      ? t('quota.measured')
      : t('quota.estimated');

  return (
    <div className={`inline-flex items-center space-x-2 px-2.5 py-1 rounded-md border text-xs font-mono font-medium ${colorClass}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`}></span>
      <span>
        {remaining}
        {total ? `/${total}` : ''} {unit}
        {percent !== null ? ` (${percent}%)` : ''}
      </span>
      <span className="text-[9px] uppercase px-1 py-0.2 rounded bg-surface/50 border border-surface-border text-slate-400">
        {sourceLabel}
      </span>
    </div>
  );
};
