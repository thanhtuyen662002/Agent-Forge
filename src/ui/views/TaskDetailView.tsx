import React, { useState, useRef, useEffect } from 'react';
import { useOrchestrator } from '../context/OrchestratorContext';
import { useI18n } from '../context/I18nContext';
import { ProgressIndicator } from '../components/ProgressIndicator';
import { UiActionResult, UiVerificationObservation, normalizeObservationResult, isVerificationObservation, uiActionFailure, uiActionFailureKey } from '../actionState';
import {
  ArrowLeft,
  Shield,
  Terminal,
  GitBranch,
  Play,
  FileText,
  AlertTriangle,
  CheckCircle2,
  Send,
  Layers,
} from 'lucide-react';

export const TaskDetailView: React.FC = () => {
  const {
    tasks,
    selectedTaskId,
    setActiveView,
    runVerificationTests,
    generateWorkOrder,
    generateReviewPackage,
    activeProject,
    isElectron,
    pendingActions,
  } = useOrchestrator();

  const { t } = useI18n();

  const [isRunningTests, setIsRunningTests] = useState<boolean>(false);
  const [testResult, setTestResult] = useState<{ generation: number; result: UiActionResult<UiVerificationObservation> } | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const task = selectedTaskId ? tasks.find(item => item.id === selectedTaskId) : tasks[0];
  const scope = JSON.stringify([activeProject?.id ?? null, task?.id ?? null]);
  const currentScope = useRef({ scope, generation: 0 });
  if (currentScope.current.scope !== scope) currentScope.current = { scope, generation: currentScope.current.generation + 1 };
  const generation = currentScope.current.generation;
  const result = testResult?.generation === generation ? testResult.result : null;
  const running = isRunningTests || (pendingActions ?? []).includes('runVerification');
  const validTask = !!task && activeProject?.id === task.project_id;
  const testResultMsg = result ? result.success
    ? t(result.data.verificationPassed ? 'taskDetail.testsComplete' : 'taskDetail.testsFailed', {
      passed: result.data.testRun.passed_count, failed: result.data.testRun.failed_count, exitCode: result.data.testRun.exit_code,
    }) : t(uiActionFailureKey(result.code)) : null;

  if (!task) {
    return (
      <div className="p-8 text-center text-slate-500 font-mono text-xs">
        {t('taskDetail.noTaskSelected')}{' '}
        <button onClick={() => setActiveView('task-board')} className="text-forge-cyan underline">
          {t('nav.taskBoard')}
        </button>
      </div>
    );
  }

  const handleRunTests = async () => {
    if (inFlight.current || running) return;
    if (!isElectron || !validTask) {
      setTestResult({ generation, result: uiActionFailure(!isElectron ? 'DESKTOP_REQUIRED' : 'TASK_UNAVAILABLE') });
      return;
    }
    inFlight.current = true;
    setIsRunningTests(true);
    setTestResult(null);
    try {
      const observed = normalizeObservationResult(await runVerificationTests(task.id),
        (value): value is UiVerificationObservation => isVerificationObservation(value, task.project_id, task.id));
      if (mounted.current && currentScope.current.generation === generation) {
        setTestResult({ generation, result: observed });
      }
    } catch {
      if (mounted.current && currentScope.current.generation === generation) setTestResult({ generation, result: uiActionFailure('IPC_REJECTED') });
    } finally {
      inFlight.current = false;
      if (mounted.current) setIsRunningTests(false);
    }
  };

  return (
    <div className="p-8 space-y-6 max-w-6xl mx-auto overflow-y-auto">
      {/* Back button & Title */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setActiveView('task-board')}
          className="text-xs font-mono text-slate-400 hover:text-slate-200 flex items-center space-x-1.5 transition"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>{t('taskDetail.backToBoard')}</span>
        </button>

        <div className="flex items-center space-x-3">
          <button
            onClick={() => setActiveView('manual-bridge')}
            className="px-3.5 py-1.5 bg-forge-emerald/20 border border-forge-emerald/40 hover:bg-forge-emerald/30 text-forge-emerald font-mono font-bold text-xs rounded-lg flex items-center space-x-1.5 transition shadow"
          >
            <Send className="w-3.5 h-3.5" />
            <span>{t('taskDetail.openInBridge')}</span>
          </button>
        </div>
      </div>

      {/* Main Task Card */}
      <div className="bg-surface-card border border-surface-border rounded-2xl p-6 shadow-xl space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-6 border-b border-surface-border">
          <div className="space-y-2">
            <div className="flex items-center space-x-3 text-xs font-mono">
              <span className="px-2.5 py-1 rounded bg-forge-cyan/20 text-forge-cyan font-bold border border-forge-cyan/30">
                {task.id}
              </span>
              <span className="px-2 py-0.5 rounded bg-surface border border-surface-border text-slate-300">
                {t('taskDetail.stateLabel')}: <strong>{task.state}</strong>
              </span>
              <span className="px-2 py-0.5 rounded bg-surface border border-surface-border text-slate-300">
                {t('taskDetail.priorityLabel')}: <strong>{task.priority}</strong>
              </span>
              <span className="px-2 py-0.5 rounded bg-surface border border-surface-border text-slate-300">
                {t('taskDetail.riskLabel')}: <strong>{task.risk}</strong>
              </span>
            </div>
            <h2 className="text-2xl font-bold text-white tracking-tight">{task.title}</h2>
          </div>

          <div className="w-full lg:w-72 bg-surface p-4 rounded-xl border border-surface-border space-y-2">
            <ProgressIndicator percent={task.progress_cache_percent} showDetails size="md" />
            <div className="text-[11px] font-mono text-slate-400 flex justify-between pt-1">
              <span>{t('taskDetail.revisionLabel')}: <strong className="text-white">{task.revision_count}/{task.max_revisions}</strong></span>
              <span>{t('taskDetail.assignedLabel')}: <strong className="text-forge-cyan">{task.assigned_agent_id || t('taskDetail.unassigned')}</strong></span>
            </div>
          </div>
        </div>

        {/* Task Details Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: Description & Acceptance Criteria */}
          <div className="space-y-5">
            <div>
              <h3 className="text-xs font-mono font-semibold text-slate-400 uppercase tracking-wider mb-2">
                {t('taskDetail.taskDescTitle')}
              </h3>
              <div className="p-4 bg-surface rounded-xl border border-surface-border text-xs text-slate-200 leading-relaxed font-sans">
                {task.description || t('taskDetail.noDesc')}
              </div>
            </div>

            <div>
              <h3 className="text-xs font-mono font-semibold text-slate-400 uppercase tracking-wider mb-2">
                {t('taskDetail.criteriaTitle')}
              </h3>
              <div className="p-4 bg-surface rounded-xl border border-surface-border space-y-2">
                {task.acceptance_criteria.length === 0 ? (
                  <div className="text-xs text-slate-500 font-mono">{t('taskDetail.noCriteria')}</div>
                ) : (
                  task.acceptance_criteria.map((c, i) => (
                    <div key={i} className="flex items-start space-x-2 text-xs text-slate-300">
                      <CheckCircle2 className="w-4 h-4 text-forge-emerald shrink-0 mt-0.5" />
                      <span>{c}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Right: Git State & Verification Runner */}
          <div className="space-y-5">
            <div>
              <h3 className="text-xs font-mono font-semibold text-slate-400 uppercase tracking-wider mb-2">
                {t('taskDetail.gitTruthTitle')}
              </h3>
              <div className="p-4 bg-surface rounded-xl border border-surface-border space-y-3 text-xs font-mono">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">{t('taskDetail.baseShaLabel')}:</span>
                  <span className="text-slate-200 font-semibold">{task.base_sha || 'HEAD'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">{t('taskDetail.currentShaLabel')}:</span>
                  <span className="text-forge-cyan font-semibold">{task.current_sha || 'UNCOMMITTED'}</span>
                </div>
              </div>
            </div>

            {/* Test Runner Box */}
            <div className="p-4 bg-surface rounded-xl border border-surface-border space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase">
                  {t('taskDetail.runnerTitle')}
                </h3>
                <span className="text-[10px] font-mono text-slate-500">{t('taskDetail.runnerSubtitle')}</span>
              </div>

              {testResultMsg && (
                <div role={result?.success && result.data.verificationPassed ? 'status' : 'alert'} className="p-3 bg-surface-card border border-surface-border rounded-lg text-xs font-mono text-slate-200">
                  {testResultMsg}
                </div>
              )}
              {!isElectron && <p id="verification-availability" className="text-xs text-slate-400">{t('actions.desktopRequired')}</p>}
              {isElectron && !validTask && <p id="verification-availability" role="alert" className="text-xs text-slate-400">{t('actions.taskUnavailable')}</p>}

              <button
                onClick={handleRunTests}
                type="button"
                disabled={running || !isElectron || !validTask}
                aria-busy={running}
                aria-describedby={!isElectron || !validTask ? 'verification-availability' : undefined}
                className="w-full py-2.5 bg-forge-cyan hover:bg-cyan-500 text-slate-950 font-mono font-bold text-xs rounded-lg shadow-lg flex items-center justify-center space-x-2 transition"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>{running ? t('taskDetail.runningTestsButton') : t('taskDetail.runTestsButton')}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
