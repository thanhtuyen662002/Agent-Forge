import React from 'react';
import { useOrchestrator } from '../context/OrchestratorContext';
import { useI18n } from '../context/I18nContext';
import { Scale, ShieldCheck, UserCheck, AlertCircle } from 'lucide-react';

export const DecisionsView: React.FC = () => {
  const { t } = useI18n();

  const authorityMatrix = [
    {
      level: 'CODER',
      scope: t('decisions.tiers.coderScope'),
      threshold: t('decisions.tiers.coderThreshold'),
    },
    {
      level: 'REVIEWER',
      scope: t('decisions.tiers.reviewerScope'),
      threshold: t('decisions.tiers.reviewerThreshold'),
    },
    {
      level: 'PRIMARY_MANAGER',
      scope: t('decisions.tiers.managerScope'),
      threshold: t('decisions.tiers.managerThreshold'),
    },
    {
      level: 'OWNER',
      scope: t('decisions.tiers.ownerScope'),
      threshold: t('decisions.tiers.ownerThreshold'),
    },
  ];

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto overflow-y-auto">
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight flex items-center space-x-2.5">
          <Scale className="w-5 h-5 text-forge-purple" />
          <span>{t('decisions.title')}</span>
        </h2>
        <p className="text-xs text-slate-400">
          {t('decisions.subtitle')}
        </p>
      </div>

      {/* Authority Matrix Table */}
      <div className="bg-surface-card border border-surface-border rounded-xl p-6 shadow-lg space-y-4">
        <h3 className="text-sm font-semibold text-white font-mono uppercase tracking-wider">
          {t('decisions.tierSpecTitle')}
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="font-mono text-slate-400 border-b border-surface-border uppercase bg-surface/50">
              <tr>
                <th className="p-3">{t('decisions.tierHeader')}</th>
                <th className="p-3">{t('decisions.scopeHeader')}</th>
                <th className="p-3">{t('decisions.gateHeader')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border font-mono">
              {authorityMatrix.map((tier) => (
                <tr key={tier.level} className="hover:bg-surface/40 transition">
                  <td className="p-3 font-bold text-forge-cyan">{tier.level}</td>
                  <td className="p-3 text-slate-300 font-sans">{tier.scope}</td>
                  <td className="p-3 text-slate-400">{tier.threshold}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
