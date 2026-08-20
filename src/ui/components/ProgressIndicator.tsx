import React from 'react';
import { useI18n } from '../context/I18nContext';

interface ProgressIndicatorProps {
  percent: number;
  showDetails?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

export const ProgressIndicator: React.FC<ProgressIndicatorProps> = ({
  percent,
  showDetails = false,
  size = 'md',
}) => {
  const { t } = useI18n();
  const heightClass = size === 'sm' ? 'h-1.5' : size === 'lg' ? 'h-3' : 'h-2';

  const getBarColor = (val: number) => {
    if (val >= 100) return 'from-emerald-500 to-cyan-500';
    if (val >= 60) return 'from-cyan-500 to-blue-500';
    if (val >= 30) return 'from-blue-500 to-indigo-500';
    return 'from-amber-500 to-cyan-500';
  };

  return (
    <div className="w-full space-y-1.5">
      <div className="flex items-center justify-between text-xs font-mono">
        <span className="text-slate-400">{t('dashboard.projectProgress')}</span>
        <span className="text-slate-200 font-semibold">{percent}%</span>
      </div>
      <div className={`w-full bg-surface-card rounded-full overflow-hidden border border-surface-border ${heightClass}`}>
        <div
          className={`h-full bg-gradient-to-r ${getBarColor(percent)} transition-all duration-500 ease-out`}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        ></div>
      </div>
      {showDetails && (
        <div className="text-[10px] font-mono text-slate-500 flex justify-between pt-0.5">
          <span>{t('task.status.planned')}: 10%</span>
          <span>{t('task.status.in_progress')}: 40%</span>
          <span>{t('task.status.validating')}: 20%</span>
          <span>{t('settings.verificationCommands.lintCmdLabel')}: 15%</span>
          <span>{t('task.status.reviewing')}: 15%</span>
        </div>
      )}
    </div>
  );
};
