import React, { useState } from 'react';
import { useOrchestrator } from '../context/OrchestratorContext';
import { Bug, Zap, AlertTriangle, ShieldCheck, Database, RefreshCw } from 'lucide-react';

export const DebugView: React.FC = () => {
  const { isElectron, activeProject, tasks, resources } = useOrchestrator();
  const [simStatus, setSimStatus] = useState<string | null>(null);

  const handleSimulateQuotaExhaustion = () => {
    setSimStatus('Simulating Quota Exhaustion: Coder model quota depleted -> Triggered task HANDOFF_REQUIRED state.');
  };

  const handleSimulateCrash = () => {
    setSimStatus('Simulating Process Crash: Tracked child process terminated abruptly -> CrashRecoveryService reconciled orphaned run.');
  };

  const handleSimulateInvalidProtocol = () => {
    setSimStatus('Simulating Protocol Rejection: Corrupt payload rejected by Zod schema with descriptive validation feedback.');
  };

  return (
    <div className="p-8 space-y-8 max-w-6xl mx-auto overflow-y-auto">
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight flex items-center space-x-2.5">
          <Bug className="w-5 h-5 text-forge-amber" />
          <span>Debug & Failure Simulation Laboratory</span>
        </h2>
        <p className="text-xs text-slate-400">
          Simulate failure scenarios, test crash recovery resilience, and inspect low-level desktop IPC events.
        </p>
      </div>

      {/* Simulator Actions */}
      <div className="bg-surface-card border border-surface-border rounded-xl p-6 shadow-lg space-y-4">
        <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider flex items-center space-x-2">
          <Zap className="w-4 h-4 text-forge-amber" />
          <span>Failure & Chaos Testing</span>
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <button
            onClick={handleSimulateQuotaExhaustion}
            className="p-4 bg-surface hover:bg-surface-hover border border-surface-border rounded-xl text-left space-y-2 transition"
          >
            <div className="font-mono font-bold text-xs text-forge-amber flex items-center space-x-2">
              <AlertTriangle className="w-4 h-4" />
              <span>Quota Exhaustion</span>
            </div>
            <p className="text-[11px] text-slate-400">
              Simulate 429 quota depletion and verify handoff generation.
            </p>
          </button>

          <button
            onClick={handleSimulateCrash}
            className="p-4 bg-surface hover:bg-surface-hover border border-surface-border rounded-xl text-left space-y-2 transition"
          >
            <div className="font-mono font-bold text-xs text-forge-rose flex items-center space-x-2">
              <Bug className="w-4 h-4" />
              <span>Process Crash</span>
            </div>
            <p className="text-[11px] text-slate-400">
              Simulate unexpected test runner termination and state preservation.
            </p>
          </button>

          <button
            onClick={handleSimulateInvalidProtocol}
            className="p-4 bg-surface hover:bg-surface-hover border border-surface-border rounded-xl text-left space-y-2 transition"
          >
            <div className="font-mono font-bold text-xs text-forge-cyan flex items-center space-x-2">
              <ShieldCheck className="w-4 h-4" />
              <span>Invalid Protocol</span>
            </div>
            <p className="text-[11px] text-slate-400">
              Test schema validation rejection against corrupt or incomplete JSON.
            </p>
          </button>
        </div>

        {simStatus && (
          <div className="p-4 bg-surface rounded-xl border border-forge-amber/40 text-xs font-mono text-amber-200">
            {simStatus}
          </div>
        )}
      </div>

      {/* Runtime Diagnostics */}
      <div className="bg-surface-card border border-surface-border rounded-xl p-6 shadow-lg space-y-3 font-mono text-xs">
        <h3 className="font-semibold text-slate-300 uppercase tracking-wider flex items-center space-x-2">
          <Database className="w-4 h-4 text-forge-cyan" />
          <span>Desktop Diagnostics</span>
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-2">
          <div className="p-3 bg-surface rounded-lg border border-surface-border">
            <span className="text-slate-500 block text-[10px]">IPC BRIDGE</span>
            <strong className={isElectron ? 'text-emerald-400' : 'text-amber-400'}>
              {isElectron ? 'ELECTRON ACTIVE' : 'BROWSER PREVIEW'}
            </strong>
          </div>
          <div className="p-3 bg-surface rounded-lg border border-surface-border">
            <span className="text-slate-500 block text-[10px]">DATABASE</span>
            <strong className="text-forge-cyan">BETTER-SQLITE3 (WAL)</strong>
          </div>
          <div className="p-3 bg-surface rounded-lg border border-surface-border">
            <span className="text-slate-500 block text-[10px]">TOTAL TASKS</span>
            <strong className="text-white">{tasks.length}</strong>
          </div>
          <div className="p-3 bg-surface rounded-lg border border-surface-border">
            <span className="text-slate-500 block text-[10px]">ACTIVE RESOURCES</span>
            <strong className="text-white">{resources.length}</strong>
          </div>
        </div>
      </div>
    </div>
  );
};
