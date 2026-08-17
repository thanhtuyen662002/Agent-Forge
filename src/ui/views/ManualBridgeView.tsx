import React, { useState } from 'react';
import { useOrchestrator } from '../context/OrchestratorContext';
import {
  ArrowLeftRight,
  Clipboard,
  Check,
  Play,
  FileCheck,
  Shield,
  Terminal,
  AlertCircle,
  Sparkles,
  Send,
  Eye,
  RefreshCw,
} from 'lucide-react';

export const ManualBridgeView: React.FC = () => {
  const {
    tasks,
    activeProject,
    parseProtocol,
    applyProtocol,
    generateWorkOrder,
    generateReviewPackage,
    runVerificationTests,
  } = useOrchestrator();

  const [activeTab, setActiveTab] = useState<'manager-inbox' | 'coder-inbox' | 'outbox'>('manager-inbox');

  // Manager Inbox State
  const [managerInput, setManagerInput] = useState<string>('');
  const [managerParseResult, setManagerParseResult] = useState<any>(null);
  const [managerApplyStatus, setManagerApplyStatus] = useState<string | null>(null);

  // Coder Inbox State
  const [coderInput, setCoderInput] = useState<string>('');
  const [coderParseResult, setCoderParseResult] = useState<any>(null);
  const [coderApplyStatus, setCoderApplyStatus] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState<boolean>(false);

  // Outbox State
  const [selectedOutboxTaskId, setSelectedOutboxTaskId] = useState<string>(tasks[0]?.id || '');
  const [outboxPackageType, setOutboxPackageType] = useState<'work-order' | 'review-package'>('work-order');
  const [outboxContent, setOutboxContent] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  // Parse Manager Input
  const handleParseManager = async () => {
    if (!managerInput.trim()) return;
    const res = await parseProtocol(managerInput);
    setManagerParseResult(res);
    setManagerApplyStatus(null);
  };

  // Apply Manager Decision
  const handleApplyManager = async () => {
    if (!managerInput.trim()) return;
    const res = await applyProtocol(managerInput);
    if (res.success) {
      setManagerApplyStatus(`Success: ${res.message || 'Manager decision applied.'}`);
    } else {
      setManagerApplyStatus(`Error: ${res.error || 'Failed to apply manager decision.'}`);
    }
  };

  // Parse Coder Input
  const handleParseCoder = async () => {
    if (!coderInput.trim()) return;
    const res = await parseProtocol(coderInput);
    setCoderParseResult(res);
    setCoderApplyStatus(null);
  };

  // Apply Coder Report & Trigger Automated Verification
  const handleApplyCoder = async () => {
    if (!coderInput.trim()) return;
    setIsVerifying(true);
    try {
      const res = await applyProtocol(coderInput);
      if (res.success) {
        setCoderApplyStatus(`Success: ${res.message || 'Coder report applied.'}. Running verification tests...`);
        // Trigger automated verification tests
        if (res.task?.id) {
          const verifRes = await runVerificationTests(res.task.id);
          setCoderApplyStatus(`Success: Coder report applied. Tests ${verifRes.success ? 'PASSED' : 'FAILED'} (Exit code: ${verifRes.testRun?.exit_code}). Task state: ${verifRes.finalTaskState}.`);
        }
      } else {
        setCoderApplyStatus(`Error: ${res.error}`);
      }
    } catch (err: any) {
      setCoderApplyStatus(`Verification Error: ${err.message}`);
    } finally {
      setIsVerifying(false);
    }
  };

  // Generate Outbox Package
  const handleGenerateOutbox = async () => {
    if (!selectedOutboxTaskId) return;
    setIsGenerating(true);
    try {
      if (outboxPackageType === 'work-order') {
        const text = await generateWorkOrder(selectedOutboxTaskId);
        setOutboxContent(text);
      } else {
        const text = await generateReviewPackage(selectedOutboxTaskId);
        setOutboxContent(text);
      }
    } catch (err: any) {
      setOutboxContent(`Error generating package: ${err.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  // Copy to Clipboard
  const handleCopyClipboard = () => {
    if (!outboxContent) return;
    navigator.clipboard.writeText(outboxContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="p-8 space-y-6 max-w-7xl mx-auto overflow-y-auto">
      {/* Top Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-surface-card border border-surface-border rounded-xl p-6 shadow-lg">
        <div className="space-y-1">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-lg bg-forge-amber/20 text-forge-amber border border-forge-amber/30">
              <ArrowLeftRight className="w-5 h-5" />
            </div>
            <h2 className="text-xl font-bold text-white tracking-tight">Manual Bridge Controller</h2>
          </div>
          <p className="text-xs text-slate-400">
            Owner relay station for transferring structured protocols between <strong>ChatGPT Manager</strong> and <strong>Gemini Coder</strong>.
          </p>
        </div>

        {/* Tab Navigation */}
        <div className="bg-surface p-1 rounded-lg border border-surface-border flex items-center text-xs font-mono">
          <button
            onClick={() => setActiveTab('manager-inbox')}
            className={`px-3.5 py-1.5 rounded-md transition flex items-center space-x-2 ${
              activeTab === 'manager-inbox'
                ? 'bg-forge-purple/20 text-forge-purple font-bold border border-forge-purple/40 shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Shield className="w-3.5 h-3.5" />
            <span>Manager Inbox</span>
          </button>
          <button
            onClick={() => setActiveTab('coder-inbox')}
            className={`px-3.5 py-1.5 rounded-md transition flex items-center space-x-2 ${
              activeTab === 'coder-inbox'
                ? 'bg-forge-cyan/20 text-forge-cyan font-bold border border-forge-cyan/40 shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>Coder Inbox</span>
          </button>
          <button
            onClick={() => setActiveTab('outbox')}
            className={`px-3.5 py-1.5 rounded-md transition flex items-center space-x-2 ${
              activeTab === 'outbox'
                ? 'bg-forge-emerald/20 text-forge-emerald font-bold border border-forge-emerald/40 shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Send className="w-3.5 h-3.5" />
            <span>Outbox Generator</span>
          </button>
        </div>
      </div>

      {/* TAB 1: MANAGER INBOX */}
      {activeTab === 'manager-inbox' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: Input Textarea */}
          <div className="bg-surface-card border border-surface-border rounded-xl p-5 shadow space-y-4 flex flex-col justify-between">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-mono font-semibold text-slate-300 flex items-center space-x-2">
                  <Shield className="w-4 h-4 text-forge-purple" />
                  <span>Paste ChatGPT Manager Response</span>
                </label>
                <span className="text-[11px] text-slate-500 font-mono">Accepts JSON, Markdown fences, or prose</span>
              </div>
              <textarea
                value={managerInput}
                onChange={(e) => setManagerInput(e.target.value)}
                placeholder='Paste Manager response here (e.g. { "protocol": "manager.v1", "decision": "EXECUTE", ... })'
                className="w-full h-80 bg-surface border border-surface-border rounded-lg p-3.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-forge-purple resize-none"
              />
            </div>

            <div className="flex items-center justify-between pt-2">
              <button
                onClick={() => setManagerInput('')}
                className="text-xs text-slate-400 hover:text-slate-200 font-mono"
              >
                Clear
              </button>
              <button
                onClick={handleParseManager}
                className="px-4 py-2 bg-forge-purple hover:bg-purple-600 text-white font-mono font-bold text-xs rounded-lg shadow flex items-center space-x-2 transition"
              >
                <Sparkles className="w-4 h-4" />
                <span>PARSE PROTOCOL</span>
              </button>
            </div>
          </div>

          {/* Right: Validation & State Preview */}
          <div className="bg-surface-card border border-surface-border rounded-xl p-5 shadow space-y-4">
            <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider">
              Protocol Validation & State Preview
            </h3>

            {!managerParseResult ? (
              <div className="h-80 flex flex-col items-center justify-center text-slate-500 space-y-2 border border-dashed border-surface-border rounded-lg p-6 text-center">
                <FileCheck className="w-8 h-8 text-slate-600" />
                <span className="text-xs font-mono">Paste Manager message and click Parse Protocol to inspect payload.</span>
              </div>
            ) : managerParseResult.success ? (
              <div className="space-y-4 text-xs font-mono">
                <div className="p-3 bg-emerald-950/20 border border-emerald-800/30 rounded-lg text-emerald-300 flex items-center space-x-2">
                  <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>Valid <strong>{managerParseResult.protocolType}</strong> protocol payload detected.</span>
                </div>

                <div className="bg-surface p-4 rounded-lg border border-surface-border space-y-2">
                  <div>Message ID: <strong className="text-white">{managerParseResult.data?.data?.message_id}</strong></div>
                  <div>Target Task: <strong className="text-forge-cyan">{managerParseResult.data?.data?.task_id || 'General Milestone'}</strong></div>
                  <div>Decision: <span className="px-2 py-0.5 rounded bg-forge-purple/20 text-forge-purple font-bold border border-forge-purple/40">{managerParseResult.data?.data?.decision}</span></div>
                  <div>Priority / Risk: <span className="text-slate-300">{managerParseResult.data?.data?.priority} / {managerParseResult.data?.data?.risk}</span></div>
                  <div>Criteria Defined: <span className="text-white">{managerParseResult.data?.data?.acceptance_criteria?.length || 0}</span></div>
                  <div>Issues Logged: <span className="text-white">{managerParseResult.data?.data?.review_issues?.length || 0}</span></div>
                </div>

                {managerApplyStatus && (
                  <div className={`p-3 rounded-lg border ${managerApplyStatus.startsWith('Success') ? 'bg-emerald-950/30 border-emerald-800/40 text-emerald-300' : 'bg-rose-950/30 border-rose-800/40 text-rose-300'}`}>
                    {managerApplyStatus}
                  </div>
                )}

                <button
                  onClick={handleApplyManager}
                  className="w-full py-2.5 bg-forge-emerald hover:bg-emerald-600 text-slate-950 font-mono font-bold text-xs rounded-lg shadow-lg flex items-center justify-center space-x-2 transition"
                >
                  <Play className="w-4 h-4 fill-current" />
                  <span>APPLY STATE TRANSITION</span>
                </button>
              </div>
            ) : (
              <div className="p-4 bg-rose-950/20 border border-rose-800/30 rounded-lg text-xs font-mono text-rose-300 space-y-2">
                <div className="flex items-center space-x-2 font-bold">
                  <AlertCircle className="w-4 h-4 text-rose-400" />
                  <span>Protocol Error</span>
                </div>
                <p className="text-slate-300">{managerParseResult.error}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: CODER INBOX */}
      {activeTab === 'coder-inbox' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: Coder Input Textarea */}
          <div className="bg-surface-card border border-surface-border rounded-xl p-5 shadow space-y-4 flex flex-col justify-between">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-mono font-semibold text-slate-300 flex items-center space-x-2">
                  <Terminal className="w-4 h-4 text-forge-cyan" />
                  <span>Paste Gemini Coder Report</span>
                </label>
                <span className="text-[11px] text-slate-500 font-mono">Requires coder.v1 protocol</span>
              </div>
              <textarea
                value={coderInput}
                onChange={(e) => setCoderInput(e.target.value)}
                placeholder='Paste Coder response here (e.g. { "protocol": "coder.v1", "status": "COMPLETED", ... })'
                className="w-full h-80 bg-surface border border-surface-border rounded-lg p-3.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-forge-cyan resize-none"
              />
            </div>

            <div className="flex items-center justify-between pt-2">
              <button
                onClick={() => setCoderInput('')}
                className="text-xs text-slate-400 hover:text-slate-200 font-mono"
              >
                Clear
              </button>
              <button
                onClick={handleParseCoder}
                className="px-4 py-2 bg-forge-cyan hover:bg-cyan-600 text-slate-950 font-mono font-bold text-xs rounded-lg shadow flex items-center space-x-2 transition"
              >
                <Sparkles className="w-4 h-4" />
                <span>PARSE REPORT</span>
              </button>
            </div>
          </div>

          {/* Right: Validation & Verification Trigger */}
          <div className="bg-surface-card border border-surface-border rounded-xl p-5 shadow space-y-4">
            <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider">
              Coder Claims vs Authoritative Evidence
            </h3>

            {!coderParseResult ? (
              <div className="h-80 flex flex-col items-center justify-center text-slate-500 space-y-2 border border-dashed border-surface-border rounded-lg p-6 text-center">
                <FileCheck className="w-8 h-8 text-slate-600" />
                <span className="text-xs font-mono">Paste Coder report and click Parse Report to inspect.</span>
              </div>
            ) : coderParseResult.success ? (
              <div className="space-y-4 text-xs font-mono">
                <div className="p-3 bg-emerald-950/20 border border-emerald-800/30 rounded-lg text-emerald-300 flex items-center space-x-2">
                  <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>Valid <strong>{coderParseResult.protocolType}</strong> report detected.</span>
                </div>

                <div className="bg-surface p-4 rounded-lg border border-surface-border space-y-2">
                  <div>Task ID: <strong className="text-forge-cyan">{coderParseResult.data?.data?.task_id}</strong></div>
                  <div>Claimed Status: <span className="text-white font-bold">{coderParseResult.data?.data?.status}</span></div>
                  <div>Files Claimed Changed: <span className="text-slate-300">{coderParseResult.data?.data?.files_claimed_changed?.join(', ') || 'None'}</span></div>
                  <div>Tests Claimed: <span className="text-slate-300">{coderParseResult.data?.data?.tests_claimed?.join(', ') || 'None'}</span></div>
                </div>

                {coderApplyStatus && (
                  <div className={`p-3 rounded-lg border ${coderApplyStatus.startsWith('Success') ? 'bg-emerald-950/30 border-emerald-800/40 text-emerald-300' : 'bg-rose-950/30 border-rose-800/40 text-rose-300'}`}>
                    {coderApplyStatus}
                  </div>
                )}

                <button
                  onClick={handleApplyCoder}
                  disabled={isVerifying}
                  className="w-full py-2.5 bg-forge-cyan hover:bg-cyan-500 text-slate-950 font-mono font-bold text-xs rounded-lg shadow-lg flex items-center justify-center space-x-2 transition"
                >
                  <Play className="w-4 h-4 fill-current" />
                  <span>{isVerifying ? 'RUNNING AUTOMATED TESTS...' : 'APPLY & RUN VERIFICATION TESTS'}</span>
                </button>
              </div>
            ) : (
              <div className="p-4 bg-rose-950/20 border border-rose-800/30 rounded-lg text-xs font-mono text-rose-300 space-y-2">
                <div className="flex items-center space-x-2 font-bold">
                  <AlertCircle className="w-4 h-4 text-rose-400" />
                  <span>Report Validation Error</span>
                </div>
                <p className="text-slate-300">{coderParseResult.error}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: OUTBOX GENERATOR */}
      {activeTab === 'outbox' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Configuration Form (1 col) */}
          <div className="bg-surface-card border border-surface-border rounded-xl p-5 shadow space-y-4">
            <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider">
              Package Configuration
            </h3>

            <div>
              <label className="block text-xs font-mono text-slate-400 mb-1.5">Select Target Task:</label>
              <select
                value={selectedOutboxTaskId}
                onChange={(e) => setSelectedOutboxTaskId(e.target.value)}
                className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-forge-emerald font-mono"
              >
                {tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id}: {t.title} ({t.state})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-mono text-slate-400 mb-1.5">Package Type:</label>
              <div className="space-y-2">
                <label className="flex items-center space-x-2.5 p-3 rounded-lg border border-surface-border bg-surface cursor-pointer">
                  <input
                    type="radio"
                    name="packageType"
                    checked={outboxPackageType === 'work-order'}
                    onChange={() => setOutboxPackageType('work-order')}
                    className="text-forge-emerald focus:ring-0"
                  />
                  <div>
                    <div className="text-xs font-semibold text-white">Work Order</div>
                    <div className="text-[11px] text-slate-400">For Gemini Coder (Task + Criteria + Commands)</div>
                  </div>
                </label>

                <label className="flex items-center space-x-2.5 p-3 rounded-lg border border-surface-border bg-surface cursor-pointer">
                  <input
                    type="radio"
                    name="packageType"
                    checked={outboxPackageType === 'review-package'}
                    onChange={() => setOutboxPackageType('review-package')}
                    className="text-forge-emerald focus:ring-0"
                  />
                  <div>
                    <div className="text-xs font-semibold text-white">Review Package</div>
                    <div className="text-[11px] text-slate-400">For ChatGPT Manager (Git Evidence + Test Results)</div>
                  </div>
                </label>
              </div>
            </div>

            <button
              onClick={handleGenerateOutbox}
              disabled={isGenerating}
              className="w-full py-2.5 bg-forge-emerald hover:bg-emerald-600 text-slate-950 font-mono font-bold text-xs rounded-lg shadow-lg flex items-center justify-center space-x-2 transition"
            >
              <Sparkles className="w-4 h-4" />
              <span>{isGenerating ? 'GENERATING...' : 'GENERATE PACKAGE'}</span>
            </button>
          </div>

          {/* Right: Output Preview (2 cols) */}
          <div className="lg:col-span-2 bg-surface-card border border-surface-border rounded-xl p-5 shadow space-y-4 flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider">
                Generated Markdown Package
              </h3>
              {outboxContent && (
                <button
                  onClick={handleCopyClipboard}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-mono font-bold flex items-center space-x-1.5 transition ${
                    copied
                      ? 'bg-emerald-500/30 text-emerald-400 border border-emerald-500/50'
                      : 'bg-surface hover:bg-surface-hover text-forge-cyan border border-surface-border'
                  }`}
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Clipboard className="w-3.5 h-3.5" />}
                  <span>{copied ? 'COPIED TO CLIPBOARD!' : '1-CLICK COPY'}</span>
                </button>
              )}
            </div>

            <textarea
              readOnly
              value={outboxContent}
              placeholder="Click 'Generate Package' to construct a formatted Markdown package ready for 1-click clipboard copy."
              className="w-full h-96 bg-surface border border-surface-border rounded-lg p-4 text-xs text-slate-100 font-mono focus:outline-none resize-none"
            />
          </div>
        </div>
      )}
    </div>
  );
};
