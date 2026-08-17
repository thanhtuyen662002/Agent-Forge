import React from 'react';
import { useOrchestrator } from '../context/OrchestratorContext';
import { Scale, ShieldCheck, UserCheck, AlertCircle } from 'lucide-react';

export const DecisionsView: React.FC = () => {
  const authorityMatrix = [
    { level: 'CODER', scope: 'Local file edits, unit test creation, lint fixes', threshold: 'Automated dispatch' },
    { level: 'REVIEWER', scope: 'Test validation, issue classification (Blocker/Required/Nit)', threshold: 'Pass/Fix decision' },
    { level: 'PRIMARY_MANAGER', scope: 'Task decomposition, milestone sign-off, architecture changes', threshold: 'Full project planning' },
    { level: 'OWNER', scope: 'Production deploy, dependency install, credential access, emergency stop', threshold: 'Final Human Authority' },
  ];

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto overflow-y-auto">
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight flex items-center space-x-2.5">
          <Scale className="w-5 h-5 text-forge-purple" />
          <span>Decision Authority & Governance</span>
        </h2>
        <p className="text-xs text-slate-400">
          Enforces explicit authority boundaries so lower-capability models cannot silently make high-risk decisions.
        </p>
      </div>

      {/* Authority Matrix Table */}
      <div className="bg-surface-card border border-surface-border rounded-xl p-6 shadow-lg space-y-4">
        <h3 className="text-sm font-semibold text-white font-mono uppercase tracking-wider">
          Authority Tier Specification
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="font-mono text-slate-400 border-b border-surface-border uppercase bg-surface/50">
              <tr>
                <th className="p-3">Authority Tier</th>
                <th className="p-3">Permitted Scope</th>
                <th className="p-3">Approval Gate</th>
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
