import React from 'react';
import { useI18n } from '../context/I18nContext';

interface ProgressIndicatorProps {
  percent: number;
  showDetails?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** Compact: the percentage beside the bar, without the project-progress label (task cards). */
  compact?: boolean;
}

export const ProgressIndicator: React.FC<ProgressIndicatorProps> = ({
  percent,
  showDetails = false,
  size = 'md',
  compact = false,
}) => {
  const { t } = useI18n();
  const heightClass = size === 'sm' ? 'h-1.5' : size === 'lg' ? 'h-3' : 'h-2';

  const getBarColor = (val: number) => {
    if (val >= 100) return 'from-emerald-500 to-cyan-500';
    if (val >= 60) return 'from-cyan-500 to-blue-500';
    if (val >= 30) return 'from-blue-500 to-indigo-500';
    return 'from-amber-500 to-cyan-500';
  };

  const bar = (
    <span className={`block w-full bg-surface-card rounded-full overflow-hidden border border-surface-border ${heightClass}`}>
      <span
        className={`block h-full bg-gradient-to-r ${getBarColor(percent)} transition-all duration-500 ease-out`}
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      ></span>
    </span>
  );
  if (compact) {
    return (
      <span className="flex items-center gap-2 w-full">
        {bar}
        <span className="text-[11px] text-slate-400 tabular-nums shrink-0">{percent}%</span>
      </span>
    );
  }

  return (
    <span className="block w-full space-y-1.5">
      <span className="flex items-center justify-between text-xs font-mono">
        <span className="text-slate-400">{t('dashboard.projectProgress')}</span>
        <span className="text-slate-200 font-semibold">{percent}%</span>
      </span>
      <span className={`block w-full bg-surface-card rounded-full overflow-hidden border border-surface-border ${heightClass}`}>
        <span
          className={`block h-full bg-gradient-to-r ${getBarColor(percent)} transition-all duration-500 ease-out`}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        ></span>
      </span>
      {showDetails && (
        <span className="text-[10px] font-mono text-slate-500 flex justify-between pt-0.5">
          <span>{t('task.status.planned')}: 10%</span>
          <span>{t('task.status.in_progress')}: 40%</span>
          <span>{t('task.status.validating')}: 20%</span>
          <span>{t('settings.verificationCommands.lintCmdLabel')}: 15%</span>
          <span>{t('task.status.reviewing')}: 15%</span>
        </span>
      )}
    </span>
  );
};
