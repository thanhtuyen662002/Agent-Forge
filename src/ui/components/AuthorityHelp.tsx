import React, { useId, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { useI18n } from '../context/I18nContext';

/**
 * Who may decide what (coder, reviewer, Manager, owner). It is guidance, not a
 * workspace, so it opens from a "?" on hover or focus instead of its own view.
 */
export const AuthorityHelp: React.FC = () => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const tooltipId = useId();
  const tiers = [
    { level: 'CODER', scope: t('decisions.tiers.coderScope'), gate: t('decisions.tiers.coderThreshold') },
    { level: 'REVIEWER', scope: t('decisions.tiers.reviewerScope'), gate: t('decisions.tiers.reviewerThreshold') },
    { level: 'MANAGER', scope: t('decisions.tiers.managerScope'), gate: t('decisions.tiers.managerThreshold') },
    { level: 'OWNER', scope: t('decisions.tiers.ownerScope'), gate: t('decisions.tiers.ownerThreshold') },
  ];

  return (
    <div className="relative shrink-0" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-label={t('decisions.title')}
        aria-describedby={open ? tooltipId : undefined}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}
        className="w-7 h-7 rounded-full flex items-center justify-center text-slate-400 hover:text-forge-cyan hover:bg-surface-card transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-forge-cyan"
      >
        <HelpCircle className="w-4 h-4" aria-hidden="true" />
      </button>
      {open && (
        <div
          id={tooltipId}
          role="tooltip"
          className="absolute left-0 top-full mt-2 w-[26rem] max-w-[calc(100vw-2rem)] bg-surface-card border border-surface-border rounded-xl shadow-2xl p-4 space-y-3 z-50"
        >
          <div>
            <p className="text-sm font-semibold text-white">{t('decisions.title')}</p>
            <p className="text-xs text-slate-400">{t('decisions.subtitle')}</p>
          </div>
          <dl className="space-y-2">
            {tiers.map((tier) => (
              <div key={tier.level} className="grid grid-cols-[5.5rem_1fr] gap-2 text-xs">
                <dt className="font-mono font-bold text-forge-cyan">{tier.level}</dt>
                <dd className="text-slate-300">
                  {tier.scope}
                  <span className="block text-[11px] text-slate-500">{tier.gate}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
};
