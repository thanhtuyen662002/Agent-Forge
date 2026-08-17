import React, { useState } from 'react';
import { Sliders, Shield, Terminal, Save, Check } from 'lucide-react';

export const SettingsView: React.FC = () => {
  const [testCmd, setTestCmd] = useState<string>('npm test');
  const [lintCmd, setLintCmd] = useState<string>('npm run lint');
  const [buildCmd, setBuildCmd] = useState<string>('npm run build');
  const [maxRevisions, setMaxRevisions] = useState<number>(3);
  const [saved, setSaved] = useState<boolean>(false);

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="p-8 space-y-8 max-w-5xl mx-auto overflow-y-auto">
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight flex items-center space-x-2.5">
          <Sliders className="w-5 h-5 text-forge-cyan" />
          <span>Project Settings & Verification Policy</span>
        </h2>
        <p className="text-xs text-slate-400">
          Configure project verification commands, maximum revision limits, and process safety policies.
        </p>
      </div>

      <div className="bg-surface-card border border-surface-border rounded-xl p-6 shadow-lg space-y-6">
        <div className="space-y-4">
          <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider flex items-center space-x-2">
            <Terminal className="w-4 h-4 text-forge-cyan" />
            <span>Verification Commands</span>
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs font-mono">
            <div>
              <label className="block text-slate-400 mb-1">Test Command:</label>
              <input
                type="text"
                value={testCmd}
                onChange={(e) => setTestCmd(e.target.value)}
                className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2 text-white focus:outline-none focus:border-forge-cyan"
              />
            </div>

            <div>
              <label className="block text-slate-400 mb-1">Linter Command:</label>
              <input
                type="text"
                value={lintCmd}
                onChange={(e) => setLintCmd(e.target.value)}
                className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2 text-white focus:outline-none focus:border-forge-cyan"
              />
            </div>

            <div>
              <label className="block text-slate-400 mb-1">Build Command:</label>
              <input
                type="text"
                value={buildCmd}
                onChange={(e) => setBuildCmd(e.target.value)}
                className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2 text-white focus:outline-none focus:border-forge-cyan"
              />
            </div>
          </div>
        </div>

        <div className="space-y-4 pt-4 border-t border-surface-border">
          <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider flex items-center space-x-2">
            <Shield className="w-4 h-4 text-forge-emerald" />
            <span>Loop Protection & Revision Limits</span>
          </h3>

          <div className="max-w-xs text-xs font-mono">
            <label className="block text-slate-400 mb-1">Max Revisions Before Escalation:</label>
            <input
              type="number"
              min={1}
              max={10}
              value={maxRevisions}
              onChange={(e) => setMaxRevisions(Number(e.target.value))}
              className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2 text-white focus:outline-none focus:border-forge-cyan"
            />
            <p className="text-[10px] text-slate-500 mt-1">
              Tasks exceeding this limit transition to <strong>NEEDS_HUMAN</strong> to halt AI ping-pong.
            </p>
          </div>
        </div>

        <div className="flex justify-end pt-4 border-t border-surface-border">
          <button
            onClick={handleSave}
            className="px-5 py-2 bg-forge-cyan hover:bg-cyan-600 text-slate-950 font-mono font-bold text-xs rounded-lg shadow flex items-center space-x-2 transition"
          >
            {saved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
            <span>{saved ? 'SETTINGS SAVED' : 'SAVE CONFIGURATION'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
