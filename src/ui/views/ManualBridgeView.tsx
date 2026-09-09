import React, { useState, useEffect, useCallback } from 'react';
import { useOrchestrator } from '../context/OrchestratorContext';
import { useI18n } from '../context/I18nContext';
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
  ArrowUp,
  ArrowDown,
  Layers,
  Cpu,
  Lock,
  Key,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import { ProviderResource } from '../../core/types/domain';
import { shouldRunCoderVerification } from '../../core/state/taskStateMachine';
import {
  QuarantinedSubmissionSummary,
  QuarantinedSubmissionInspection,
} from '../../core/types/adjudication';

export const ManualBridgeView: React.FC = () => {
  const {
    tasks,
    activeProject,
    resources,
    generateWorkOrder,
    generateReviewPackage,
    runVerificationTests,
    parseProtocol,
    applyProtocol,
    routeTask,
    authorizeRoutedTask,
    dispatchAuthorization,
    getOwnerHandoffSnapshot,
    generateAuthorizedWorkOrder,
    listQuarantinedSubmissions,
    inspectQuarantinedSubmission,
    admitQuarantinedSubmission,
    rejectQuarantinedSubmission,
    supersedeQuarantinedSubmission,
    resumeAdmittedSubmission,
    acknowledgeRecoveryFencedSubmission,
  } = useOrchestrator();

  const { t } = useI18n();

  const [activeTab, setActiveTab] = useState<'routing-handoff' | 'manager-inbox' | 'quarantined-queue' | 'outbox'>(
    'routing-handoff'
  );

  // ==========================================
  // PR #8 Owner Routing & Manual Bridge State
  // ==========================================
  const [selectedHandoffTaskId, setSelectedHandoffTaskId] = useState<string>(tasks[0]?.id || '');
  const [snapshot, setSnapshot] = useState<any>(null);
  const [loadingSnapshot, setLoadingSnapshot] = useState<boolean>(false);
  const [candidateIds, setCandidateIds] = useState<string[]>([]);
  const [allowManualBridge, setAllowManualBridge] = useState<boolean>(false);

  const [routingDecision, setRoutingDecision] = useState<any>(null);
  const [isRouting, setIsRouting] = useState<boolean>(false);
  const [routingError, setRoutingError] = useState<string | null>(null);

  const [authorization, setAuthorization] = useState<any>(null);
  const [isAuthorizing, setIsAuthorizing] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [dispatchResult, setDispatchResult] = useState<any>(null);
  const [isDispatching, setIsDispatching] = useState<boolean>(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);

  const [handoffWorkOrder, setHandoffWorkOrder] = useState<string>('');
  const [isGeneratingHandoffWorkOrder, setIsGeneratingHandoffWorkOrder] = useState<boolean>(false);
  const [handoffCopied, setHandoffCopied] = useState<boolean>(false);

  // ==========================================
  // Manager Inbox State
  // ==========================================
  const [managerInput, setManagerInput] = useState<string>('');
  const [managerParseResult, setManagerParseResult] = useState<any>(null);
  const [managerApplyStatus, setManagerApplyStatus] = useState<string | null>(null);

  // ==========================================
  // R5J5 Quarantined Submissions Queue State
  // ==========================================
  const [quarantinedSubmissions, setQuarantinedSubmissions] = useState<QuarantinedSubmissionSummary[]>([]);
  const [loadingSubmissions, setLoadingSubmissions] = useState<boolean>(false);
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<string | null>(null);
  const [submissionDetail, setSubmissionDetail] = useState<QuarantinedSubmissionInspection | null>(null);
  const [loadingDetail, setLoadingDetail] = useState<boolean>(false);

  const [confirmModalAction, setConfirmModalAction] = useState<
    'ADMIT' | 'REJECT' | 'SUPERSEDE' | 'RESUME' | 'ACKNOWLEDGE' | null
  >(null);
  const [adjudicationReason, setAdjudicationReason] = useState<string>('');
  const [replacementSubId, setReplacementSubId] = useState<string>('');
  const [isAdjudicating, setIsAdjudicating] = useState<boolean>(false);
  const [adjudicationFeedback, setAdjudicationFeedback] = useState<string | null>(null);
  const [adjudicationError, setAdjudicationError] = useState<string | null>(null);

  // ==========================================
  // Outbox State
  // ==========================================
  const [selectedOutboxTaskId, setSelectedOutboxTaskId] = useState<string>(tasks[0]?.id || '');
  const [outboxPackageType, setOutboxPackageType] = useState<'work-order' | 'review-package'>('work-order');
  const [outboxContent, setOutboxContent] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  // Sync selected task if tasks list updates and nothing selected
  useEffect(() => {
    if (!selectedHandoffTaskId && tasks.length > 0) {
      setSelectedHandoffTaskId(tasks[0].id);
    }
  }, [tasks, selectedHandoffTaskId]);

  // Load Handoff Snapshot from SQLite
  const loadSnapshot = useCallback(async () => {
    if (!selectedHandoffTaskId) return;
    setLoadingSnapshot(true);
    try {
      const res = await getOwnerHandoffSnapshot(selectedHandoffTaskId);
      if (res && res.success && res.snapshot) {
        setSnapshot(res.snapshot);
        if (res.snapshot.latestAuthorization) {
          setAuthorization(res.snapshot.latestAuthorization);
        }
        if (res.snapshot.latestRoutingDecision) {
          setRoutingDecision(res.snapshot.latestRoutingDecision);
        }
      }
    } catch (err: any) {
      console.error('[ManualBridgeView] Failed to load snapshot:', err);
    } finally {
      setLoadingSnapshot(false);
    }
  }, [selectedHandoffTaskId, getOwnerHandoffSnapshot]);

  useEffect(() => {
    loadSnapshot();
  }, [loadSnapshot]);

  // When resources/snapshot refresh: preserve only Owner selections that are still valid.
  // DO NOT auto-populate candidates if none were selected!
  useEffect(() => {
    if (candidateIds.length > 0) {
      const availableIds = (snapshot?.providerResources || resources).map((r: any) => r.id);
      setCandidateIds((prev) => prev.filter((id) => availableIds.includes(id)));
    }
  }, [resources, snapshot?.providerResources]);

  // Reset task-scoped state on task change
  const handleTaskChange = (newTaskId: string) => {
    if (newTaskId === selectedHandoffTaskId) return;
    setSelectedHandoffTaskId(newTaskId);
    setCandidateIds([]);
    setAllowManualBridge(false);
    setRoutingDecision(null);
    setAuthorization(null);
    setDispatchResult(null);
    setHandoffWorkOrder('');
    setRoutingError(null);
    setAuthError(null);
    setDispatchError(null);
  };

  // Candidate Reordering Controls
  const moveCandidateUp = (index: number) => {
    if (index <= 0) return;
    setCandidateIds((prev) => {
      const copy = [...prev];
      const temp = copy[index - 1];
      copy[index - 1] = copy[index];
      copy[index] = temp;
      return copy;
    });
  };

  const moveCandidateDown = (index: number) => {
    if (index >= candidateIds.length - 1) return;
    setCandidateIds((prev) => {
      const copy = [...prev];
      const temp = copy[index + 1];
      copy[index + 1] = copy[index];
      copy[index] = temp;
      return copy;
    });
  };

  const toggleCandidate = (resourceId: string) => {
    setCandidateIds((prev) => {
      if (prev.includes(resourceId)) {
        return prev.filter((id) => id !== resourceId);
      } else {
        return [...prev, resourceId];
      }
    });
  };

  // Route Action
  const handleRouteTask = async () => {
    if (!activeProject || !selectedHandoffTaskId || candidateIds.length === 0) return;
    setIsRouting(true);
    setRoutingError(null);
    try {
      const res = await routeTask({
        projectId: activeProject.id,
        taskId: selectedHandoffTaskId,
        candidateResourceIds: candidateIds,
        allowManualBridge,
      });

      if (res && res.success && res.decision) {
        setRoutingDecision(res.decision);
      } else {
        const errorDetail = res?.error;
        setRoutingError(
          errorDetail
            ? t('manualBridge.errorExecutingRouting', {
                error: errorDetail,
              })
            : t('manualBridge.routingFailedWithoutDecision')
        );
      }
    } catch (err: any) {
      const errorDetail = err.message;
      setRoutingError(
        errorDetail
          ? t('manualBridge.errorExecutingRouting', {
              error: errorDetail,
            })
          : t('manualBridge.errorExecutingRoutingDefault')
      );
    } finally {
      setIsRouting(false);
      await loadSnapshot();
    }
  };

  // Authorize Action
  const handleAuthorizeTask = async () => {
    if (!activeProject || !selectedHandoffTaskId || !routingDecision) return;
    setIsAuthorizing(true);
    setAuthError(null);
    try {
      const res = await authorizeRoutedTask({
        projectId: activeProject.id,
        taskId: selectedHandoffTaskId,
        routingDecisionId: routingDecision.decisionId,
        contextFiles: [],
      });

      if (res && res.success && res.authorization) {
        setAuthorization(res.authorization);
      } else {
        const errorDetail = res?.error;
        setAuthError(
          errorDetail
            ? t('manualBridge.errorExecutingAuth', {
                error: errorDetail,
              })
            : t('manualBridge.authCreationFailed')
        );
      }
    } catch (err: any) {
      const errorDetail = err.message;
      setAuthError(
        errorDetail
          ? t('manualBridge.errorExecutingAuth', {
              error: errorDetail,
            })
          : t('manualBridge.errorExecutingAuthDefault')
      );
    } finally {
      setIsAuthorizing(false);
      await loadSnapshot();
    }
  };

  // Dispatch Action
  const handleDispatchAuthorization = async () => {
    if (!authorization || authorization.status !== 'AUTHORIZED') return;
    setIsDispatching(true);
    setDispatchError(null);
    try {
      const res = await dispatchAuthorization(authorization.id);
      if (res && res.success && res.result) {
        setDispatchResult(res.result);
      } else {
        const errorDetail = res?.error || res?.result?.error;
        setDispatchError(
          errorDetail
            ? t('manualBridge.errorDispatchingAuth', {
                error: errorDetail,
              })
            : t('manualBridge.dispatchExecutionFailed')
        );
      }
    } catch (err: any) {
      const errorDetail = err.message;
      setDispatchError(
        errorDetail
          ? t('manualBridge.errorDispatchingAuth', {
              error: errorDetail,
            })
          : t('manualBridge.errorDispatchingAuthDefault')
      );
    } finally {
      setIsDispatching(false);
      await loadSnapshot();
    }
  };

  // Generate Authorized Handoff WorkOrder
  const handleGenerateHandoffWorkOrder = async () => {
    if (!authorization?.id) return;
    setIsGeneratingHandoffWorkOrder(true);
    try {
      const res = await generateAuthorizedWorkOrder(authorization.id);
      if (res && res.success && res.workOrder) {
        setHandoffWorkOrder(res.workOrder);
      } else {
        const errorDetail = res?.error || t('common.unknown');
        setHandoffWorkOrder(t('manualBridge.errorGeneratingWorkOrder', { error: errorDetail }));
      }
    } catch (err: any) {
      const errorDetail = err.message || t('common.unknown');
      setHandoffWorkOrder(t('manualBridge.errorGeneratingWorkOrder', { error: errorDetail }));
    } finally {
      setIsGeneratingHandoffWorkOrder(false);
    }
  };

  // Copy Handoff WorkOrder
  const handleCopyHandoffWorkOrder = () => {
    if (!handoffWorkOrder) return;
    navigator.clipboard.writeText(handoffWorkOrder);
    setHandoffCopied(true);
    setTimeout(() => setHandoffCopied(false), 2500);
  };

  // ==========================================
  // Manager Inbox Handlers
  // ==========================================
  const handleParseManager = async () => {
    if (!managerInput.trim()) return;
    const res = await parseProtocol(managerInput);
    setManagerParseResult(res);
    setManagerApplyStatus(null);
  };

  const handleApplyManager = async () => {
    if (!managerInput.trim()) return;
    const res = await applyProtocol(managerInput);
    if (res.success) {
      setManagerApplyStatus(t('manualBridge.managerDecisionAppliedSuccess', { message: res.message || t('manualBridge.managerDecisionAppliedDefault') }));
      await loadSnapshot();
    } else {
      const errorDetail = res.error || t('manualBridge.managerDecisionApplyFailedDefault');
      setManagerApplyStatus(t('manualBridge.managerDecisionApplyFailed', { error: errorDetail }));
    }
  };

  // ==========================================
  // R5J5 Quarantined Submissions Queue Handlers
  // ==========================================
  const loadSubmissions = useCallback(async () => {
    setLoadingSubmissions(true);
    try {
      const res = await listQuarantinedSubmissions({
        projectId: activeProject?.id,
      });
      if (res && res.items) {
        setQuarantinedSubmissions(res.items);
        if (res.items.length > 0 && !selectedSubmissionId) {
          setSelectedSubmissionId(res.items[0].id);
        }
      }
    } catch {
      // ignore
    } finally {
      setLoadingSubmissions(false);
    }
  }, [activeProject, listQuarantinedSubmissions, selectedSubmissionId]);

  useEffect(() => {
    if (activeTab === 'quarantined-queue') {
      loadSubmissions();
    }
  }, [activeTab, loadSubmissions]);

  useEffect(() => {
    if (!selectedSubmissionId) {
      setSubmissionDetail(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    inspectQuarantinedSubmission(selectedSubmissionId)
      .then((res) => {
        if (!cancelled && res && res.detail) {
          setSubmissionDetail(res.detail);
        }
      })
      .catch(() => {
        if (!cancelled) setSubmissionDetail(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSubmissionId, inspectQuarantinedSubmission]);

  const handleExecuteAdjudication = async () => {
    if (!selectedSubmissionId || !confirmModalAction) return;
    setIsAdjudicating(true);
    setAdjudicationError(null);
    setAdjudicationFeedback(null);
    try {
      const activeAdj = submissionDetail?.adjudications && submissionDetail.adjudications.length > 0
        ? submissionDetail.adjudications[submissionDetail.adjudications.length - 1]
        : null;
      const adjId = activeAdj?.id;
      const expectedLifecycleVersion = typeof activeAdj?.lifecycle_version === 'number'
        ? activeAdj.lifecycle_version
        : 0;

      let res: { success?: boolean; error?: string; message?: string } | undefined;
      if (confirmModalAction === 'ADMIT') {
        res = await admitQuarantinedSubmission(selectedSubmissionId, expectedLifecycleVersion);
      } else if (confirmModalAction === 'REJECT') {
        res = await rejectQuarantinedSubmission(
          selectedSubmissionId,
          expectedLifecycleVersion,
          adjudicationReason.trim() || 'Rejected by Owner'
        );
      } else if (confirmModalAction === 'SUPERSEDE') {
        res = await supersedeQuarantinedSubmission(
          selectedSubmissionId,
          expectedLifecycleVersion,
          replacementSubId.trim(),
          adjudicationReason.trim() || 'Superseded by Owner'
        );
      } else if (confirmModalAction === 'RESUME') {
        if (!adjId) {
          throw new Error('Active adjudication required to resume.');
        }
        res = await resumeAdmittedSubmission(selectedSubmissionId, adjId, expectedLifecycleVersion);
      } else if (confirmModalAction === 'ACKNOWLEDGE') {
        if (!adjId) {
          throw new Error('Active adjudication required to acknowledge.');
        }
        res = await acknowledgeRecoveryFencedSubmission(
          selectedSubmissionId,
          adjId,
          expectedLifecycleVersion,
          'ACKNOWLEDGE'
        );
      }

      if (res && res.success) {
        setAdjudicationFeedback(t('quarantinedQueue.actionSuccessNotice'));
        setConfirmModalAction(null);
        setAdjudicationReason('');
        setReplacementSubId('');
        await loadSubmissions();
        const detailRes = await inspectQuarantinedSubmission(selectedSubmissionId);
        if (detailRes && detailRes.detail) {
          setSubmissionDetail(detailRes.detail);
        }
      } else {
        setAdjudicationError(res?.error || res?.message || t('quarantinedQueue.actionFailedNotice'));
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      setAdjudicationError(errorMsg || t('quarantinedQueue.actionFailedNotice'));
    } finally {
      setIsAdjudicating(false);
    }
  };

  // ==========================================
  // Outbox Handlers
  // ==========================================
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
      const errorDetail = err.message || t('common.unknown');
      setOutboxContent(t('manualBridge.errorGeneratingPackage', { error: errorDetail }));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopyClipboard = () => {
    if (!outboxContent) return;
    navigator.clipboard.writeText(outboxContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Helper values for handoff view
  const currentTask = snapshot?.task || tasks.find((t) => t.id === selectedHandoffTaskId);
  const managerAuth = snapshot?.managerAuthority;
  const authBoundRoutingDecision = snapshot?.authorizationRoutingDecision;

  const isManualHandoffAwaitingOwner =
    authorization?.status === 'DISPATCHED' &&
    authBoundRoutingDecision?.outcome === 'MANUAL_HANDOFF_REQUIRED';

  const isSelectedDispatched =
    authorization?.status === 'DISPATCHED' &&
    authBoundRoutingDecision?.outcome === 'SELECTED';

  const canRoute =
    Boolean(currentTask) &&
    (currentTask.state === 'CODING' || currentTask.state === 'HANDOFF_REQUIRED') &&
    Boolean(managerAuth?.hasAuthority && managerAuth?.decisionValidForCurrentRevision);

  const canAuthorize =
    Boolean(routingDecision) &&
    (routingDecision.outcome === 'SELECTED' || routingDecision.outcome === 'MANUAL_HANDOFF_REQUIRED') &&
    canRoute;

  const canDispatch =
    Boolean(authorization) &&
    authorization.status === 'AUTHORIZED' &&
    (currentTask?.state === 'CODING' || currentTask?.state === 'HANDOFF_REQUIRED');

  return (
    <div className="p-8 space-y-6 max-w-7xl mx-auto overflow-y-auto">
      {/* Top Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-surface-card border border-surface-border rounded-xl p-6 shadow-lg">
        <div className="space-y-1">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-lg bg-forge-amber/20 text-forge-amber border border-forge-amber/30">
              <ArrowLeftRight className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white tracking-tight">{t('manualBridge.title')}</h2>
              <span className="text-[11px] font-mono text-forge-amber uppercase font-semibold">
                {t('manualBridge.subtitle')}
              </span>
            </div>
          </div>
          <p className="text-xs text-slate-400">
            {t('routing.subtitle')}
          </p>
        </div>

        {/* Tab Navigation */}
        <div className="bg-surface p-1 rounded-lg border border-surface-border flex items-center text-xs font-mono flex-wrap gap-1">
          <button
            onClick={() => setActiveTab('routing-handoff')}
            className={`px-3.5 py-1.5 rounded-md transition flex items-center space-x-2 ${
              activeTab === 'routing-handoff'
                ? 'bg-forge-amber/20 text-forge-amber font-bold border border-forge-amber/40 shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>{t('nav.manualBridge')}</span>
          </button>
          <button
            onClick={() => setActiveTab('manager-inbox')}
            className={`px-3.5 py-1.5 rounded-md transition flex items-center space-x-2 ${
              activeTab === 'manager-inbox'
                ? 'bg-forge-purple/20 text-forge-purple font-bold border border-forge-purple/40 shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Shield className="w-3.5 h-3.5" />
            <span>{t('managerInbox.title')}</span>
          </button>
          <button
            onClick={() => setActiveTab('quarantined-queue')}
            className={`px-3.5 py-1.5 rounded-md transition flex items-center space-x-2 ${
              activeTab === 'quarantined-queue'
                ? 'bg-forge-cyan/20 text-forge-cyan font-bold border border-forge-cyan/40 shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>{t('quarantinedQueue.title')}</span>
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
            <span>{t('manualBridge.outboxTabButton')}</span>
          </button>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* TAB 1: OWNER ROUTING & MANUAL HANDOFF (PR #8 CORE WORKFLOW) */}
      {/* ========================================================================= */}
      {activeTab === 'routing-handoff' && (
        <div className="space-y-6">
          {/* Top Relay Notice */}
          <div className="p-4 bg-surface-card border border-surface-border rounded-xl text-xs font-mono flex items-start space-x-3">
            <AlertTriangle className="w-4 h-4 text-forge-amber shrink-0 mt-0.5" />
            <div className="space-y-1 text-slate-300">
              <span className="font-bold text-white uppercase tracking-wider">{t('manualBridge.relayNoticeTitle')}:</span>
              <p>
                {t('manualBridge.relayNoticeText')}
              </p>
            </div>
          </div>

          {/* Grid Layout: 2 Columns for Steps */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* ---------------------------------------------------- */}
            {/* STEP 1: TASK SELECTION & MANAGER AUTHORITY */}
            {/* ---------------------------------------------------- */}
            <div className="bg-surface-card border border-surface-border rounded-xl p-5 shadow space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider flex items-center space-x-2">
                  <span className="w-5 h-5 rounded-full bg-forge-amber/20 text-forge-amber flex items-center justify-center text-[10px] font-bold">1</span>
                  <span>{t('manualBridge.step1TargetTaskTitle')}</span>
                </h3>
                {loadingSnapshot && (
                  <RefreshCw className="w-3.5 h-3.5 text-slate-400 animate-spin" />
                )}
              </div>

              <div>
                <label className="block text-xs font-mono text-slate-400 mb-1.5">{t('manualBridge.selectTargetTaskLabel')}:</label>
                <select
                  value={selectedHandoffTaskId}
                  onChange={(e) => handleTaskChange(e.target.value)}
                  className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-forge-amber font-mono"
                >
                  {tasks.map((taskItem) => (
                    <option key={taskItem.id} value={taskItem.id}>
                      {taskItem.id}: {taskItem.title} ({taskItem.state} &mdash; {t('manualBridge.revisionShortLabel')} {taskItem.revision_count})
                    </option>
                  ))}
                </select>
              </div>

              {currentTask && (
                <div className="bg-surface p-3.5 rounded-lg border border-surface-border space-y-2 text-xs font-mono">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">{t('manualBridge.stateRevisionLabel')}:</span>
                    <span className="font-bold text-white">
                      <span className="px-2 py-0.5 rounded bg-slate-800 text-forge-cyan border border-slate-700 mr-1.5">
                        {currentTask.state}
                      </span>
                      {t('manualBridge.revisionShortLabel')} {currentTask.revision_count} ({t('manualBridge.maxLabel')} {currentTask.max_revisions})
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">{t('manualBridge.riskPriorityLabel')}:</span>
                    <span className="text-slate-300">{currentTask.risk} / {currentTask.priority}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">{t('manualBridge.baseShaRepoHeadLabel')}:</span>
                    <span className="text-slate-300 truncate max-w-[200px]" title={snapshot?.gitHeadSha || t('manualBridge.unknownLabel')}>
                      {currentTask.base_sha?.slice(0, 7) || 'HEAD'} / {snapshot?.gitHeadSha?.slice(0, 7) || t('manualBridge.unknownLabel')}
                    </span>
                  </div>
                </div>
              )}

              {/* Manager Authority Status Box */}
              <div className="space-y-2">
                <label className="block text-[11px] font-mono font-semibold text-slate-400 uppercase">
                  {t('manualBridge.managerAuthorityStatusLabel')}
                </label>
                {managerAuth?.hasAuthority ? (
                  <div
                    className={`p-3.5 rounded-lg border text-xs font-mono space-y-2 ${
                      managerAuth.decisionValidForCurrentRevision
                        ? 'bg-emerald-950/20 border-emerald-800/40 text-emerald-300'
                        : 'bg-rose-950/20 border-rose-800/40 text-rose-300'
                    }`}
                  >
                    <div className="flex items-center justify-between font-bold">
                      <span className="flex items-center space-x-1.5">
                        {managerAuth.decisionValidForCurrentRevision ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        ) : (
                          <XCircle className="w-4 h-4 text-rose-400" />
                        )}
                        <span>{t('managerInbox.title')}: {managerAuth.decision}</span>
                      </span>
                      <span className="text-[10px] px-2 py-0.5 rounded bg-surface border border-surface-border text-slate-300">
                        {t('managerInbox.expectedRevision')} {managerAuth.expectedRevision}
                      </span>
                    </div>
                    <div className="text-[11px] space-y-1 text-slate-300">
                      <div>{t('routing.decisionId')}: <strong className="text-white">{managerAuth.messageId}</strong></div>
                      <div>{t('manualBridge.instructionHashLabel')}: <span className="text-slate-400 truncate block">{managerAuth.payloadHash}</span></div>
                      <div>{t('managerInbox.instructionsCount')}: <strong className="text-white">{managerAuth.instructionsCount}</strong></div>
                    </div>
                    {!managerAuth.decisionValidForCurrentRevision && (
                      <div className="p-2 rounded bg-rose-900/30 border border-rose-700/50 text-[11px] text-rose-200">
                        {managerAuth.reason || t('manualBridge.noManagerAuthDefaultReason')}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="p-3.5 bg-rose-950/20 border border-rose-800/40 rounded-lg text-xs font-mono text-rose-300 space-y-2">
                    <div className="flex items-center space-x-2 font-bold">
                      <XCircle className="w-4 h-4 text-rose-400 shrink-0" />
                      <span>{t('manualBridge.noManagerAuthTitle')}</span>
                    </div>
                    <p className="text-[11px] text-slate-300">
                      {managerAuth?.reason || t('manualBridge.noManagerAuthDefaultReason')}
                    </p>
                    <button
                      onClick={() => setActiveTab('manager-inbox')}
                      className="px-3 py-1.5 bg-forge-purple hover:bg-purple-600 text-white font-bold text-[11px] rounded transition flex items-center space-x-1.5"
                    >
                      <Shield className="w-3 h-3" />
                      <span>{t('manualBridge.goToManagerInbox')}</span>
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* ---------------------------------------------------- */}
            {/* STEP 2: CANDIDATE RESOURCES & EXPLICIT CANDIDATE ORDER */}
            {/* ---------------------------------------------------- */}
            <div className="bg-surface-card border border-surface-border rounded-xl p-5 shadow space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider flex items-center space-x-2">
                  <span className="w-5 h-5 rounded-full bg-forge-amber/20 text-forge-amber flex items-center justify-center text-[10px] font-bold">2</span>
                  <span>{t('manualBridge.step2CandidateTitle')}</span>
                </h3>
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={() => {
                      const enabledIds = (snapshot?.providerResources || resources)
                        .filter((r: ProviderResource) => r.enabled)
                        .map((r: ProviderResource) => r.id);
                      setCandidateIds(enabledIds);
                    }}
                    className="text-[11px] text-forge-amber hover:underline font-mono"
                  >
                    {t('manualBridge.selectAllEnabled')}
                  </button>
                  {candidateIds.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setCandidateIds([])}
                      className="text-[11px] text-slate-400 hover:text-white font-mono"
                    >
                      {t('manualBridge.clearCandidates')}
                    </button>
                  )}
                  <span className="text-[11px] text-slate-400 font-mono ml-1">
                    {t('manualBridge.selectedCount', { count: candidateIds.length.toString() })}
                  </span>
                </div>
              </div>

              {/* Resource List with Reordering Controls */}
              <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
                {(snapshot?.providerResources || resources).map((res: ProviderResource) => {
                  const isSelected = candidateIds.includes(res.id);
                  const candidateOrder = candidateIds.indexOf(res.id);

                  return (
                    <div
                      key={res.id}
                      className={`p-3 rounded-lg border text-xs font-mono transition ${
                        isSelected
                          ? 'bg-surface border-forge-amber/40 shadow-sm'
                          : 'bg-surface/50 border-surface-border opacity-60'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center space-x-2.5">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleCandidate(res.id)}
                            className="rounded border-surface-border text-forge-amber focus:ring-0 cursor-pointer"
                          />
                          <div>
                            <div className="font-bold text-white flex items-center space-x-1.5">
                              <span>{res.model_name}</span>
                              <span className="text-[10px] text-slate-400">({res.id})</span>
                            </div>
                            <div className="text-[10px] text-slate-400">
                              {t('manualBridge.providerLabel')}: <strong className="text-slate-300">{res.provider_id}</strong>
                            </div>
                          </div>
                        </div>

                        {/* Up / Down Controls */}
                        {isSelected && (
                          <div className="flex items-center space-x-1">
                            <span className="text-[10px] font-bold text-forge-amber mr-1">
                              #{candidateOrder + 1}
                            </span>
                            <button
                              onClick={() => moveCandidateUp(candidateOrder)}
                              disabled={candidateOrder <= 0}
                              className="p-1 rounded bg-surface-card hover:bg-slate-700 text-slate-300 disabled:opacity-30"
                              title={t('manualBridge.moveUpTitle')}
                            >
                              <ArrowUp className="w-3 h-3" />
                            </button>
                            <button
                              onClick={() => moveCandidateDown(candidateOrder)}
                              disabled={candidateOrder >= candidateIds.length - 1}
                              className="p-1 rounded bg-surface-card hover:bg-slate-700 text-slate-300 disabled:opacity-30"
                              title={t('manualBridge.moveDownTitle')}
                            >
                              <ArrowDown className="w-3 h-3" />
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Capabilities & Quota Semantics */}
                      <div className="mt-2 pt-2 border-t border-surface-border/50 flex flex-wrap items-center justify-between gap-1 text-[10px]">
                        <div className="flex items-center space-x-1.5">
                          <span
                            className={`px-1.5 py-0.2 rounded font-semibold ${
                              res.enabled ? 'bg-emerald-950/40 text-emerald-300' : 'bg-rose-950/40 text-rose-300'
                            }`}
                          >
                            {res.enabled ? t('manualBridge.enabledLabel') : t('manualBridge.disabledLabel')}
                          </span>
                          <span className="px-1.5 py-0.2 rounded bg-slate-800 text-slate-300">
                            {t('manualBridge.healthLabel')}: {res.health_status}
                          </span>
                        </div>

                        {/* UNKNOWN Quota Truthful Rendering */}
                        <div className="text-slate-400">
                          {res.remaining_quota === null || res.quota_source === 'UNKNOWN' ? (
                            <span className="px-1.5 py-0.2 rounded bg-slate-800/80 text-slate-300 border border-slate-700">
                              {t('manualBridge.quotaUnknownLabel')}
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.2 rounded bg-emerald-950/30 text-emerald-300 border border-emerald-800/30">
                              {t('capacity.quotaLabel')}: {res.remaining_quota} / {res.total_quota} {res.quota_unit} [{res.quota_source}, {t('manualBridge.confidenceShortLabel')}: {res.quota_confidence}]
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Manual Bridge Permission Toggle */}
              <div className="p-3 bg-surface rounded-lg border border-surface-border text-xs font-mono flex items-center justify-between">
                <div>
                  <div className="font-semibold text-white">{t('manualBridge.explicitManualBridgeTitle')}</div>
                  <div className="text-[11px] text-slate-400">
                    {t('manualBridge.explicitManualBridgeDesc')}
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={allowManualBridge}
                  onChange={(e) => setAllowManualBridge(e.target.checked)}
                  className="rounded border-surface-border text-forge-amber focus:ring-0 cursor-pointer w-4 h-4"
                />
              </div>

              {/* Route Action Button */}
              {routingError && (
                <div className="p-2.5 rounded bg-rose-950/30 border border-rose-800/40 text-xs font-mono text-rose-300">
                  {routingError}
                </div>
              )}

              <button
                onClick={handleRouteTask}
                disabled={!canRoute || candidateIds.length === 0 || isRouting}
                className="w-full py-2.5 bg-forge-amber hover:bg-amber-600 text-slate-950 font-mono font-bold text-xs rounded-lg shadow-lg flex items-center justify-center space-x-2 transition disabled:opacity-40"
              >
                <Sparkles className="w-4 h-4" />
                <span>{isRouting ? t('manualBridge.routingCandidatesButton') : t('manualBridge.routeCandidatesButton')}</span>
              </button>
            </div>
          </div>

          {/* ---------------------------------------------------- */}
          {/* STEP 3 & 4: ROUTING DECISION & EXECUTION AUTHORIZATION */}
          {/* ---------------------------------------------------- */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Step 3: Routing Decision Display */}
            <div className="bg-surface-card border border-surface-border rounded-xl p-5 shadow space-y-4">
              <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider flex items-center space-x-2">
                <span className="w-5 h-5 rounded-full bg-forge-amber/20 text-forge-amber flex items-center justify-center text-[10px] font-bold">3</span>
                <span>{t('manualBridge.step3RoutingDecisionTitle')}</span>
              </h3>

              {!routingDecision ? (
                <div className="h-64 flex flex-col items-center justify-center text-slate-500 space-y-2 border border-dashed border-surface-border rounded-lg p-6 text-center">
                  <Cpu className="w-8 h-8 text-slate-600" />
                  <span className="text-xs font-mono">{t('manualBridge.step3RoutingEmptyHint')}</span>
                </div>
              ) : (
                <div className="space-y-3.5 text-xs font-mono">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">{t('manualBridge.decisionOutcomeLabel')}:</span>
                    <span
                      className={`px-2.5 py-1 rounded font-bold border ${
                        routingDecision.outcome === 'SELECTED'
                          ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800/40'
                          : routingDecision.outcome === 'MANUAL_HANDOFF_REQUIRED'
                          ? 'bg-amber-950/40 text-forge-amber border-amber-800/40'
                          : 'bg-rose-950/40 text-rose-300 border-rose-800/40'
                      }`}
                    >
                      {routingDecision.outcome}
                    </span>
                  </div>

                  <div className="bg-surface p-3.5 rounded-lg border border-surface-border space-y-1.5">
                    <div>{t('routing.decisionId')}: <strong className="text-white">{routingDecision.decisionId}</strong></div>
                    <div>{t('routing.selectedResource')}: <strong className="text-forge-cyan">{routingDecision.selectedResourceId || t('common.none')}</strong></div>
                    <div>{t('manualBridge.selectedProviderLabel')}: <strong className="text-forge-purple">{routingDecision.selectedProviderId || t('common.none')}</strong></div>
                    <div>{t('manualBridge.reasonLabel')}: <span className="text-slate-300">{routingDecision.reason}</span></div>
                  </div>

                  {/* Candidate Evaluations Summary */}
                  {routingDecision.candidateEvaluations && routingDecision.candidateEvaluations.length > 0 && (
                    <div className="space-y-1.5">
                      <span className="text-[11px] font-semibold text-slate-400 uppercase">{t('manualBridge.evaluationsLabel')}:</span>
                      <div className="space-y-1 max-h-36 overflow-y-auto pr-1">
                        {routingDecision.candidateEvaluations.map((ev: any, i: number) => (
                          <div key={i} className="p-2 rounded bg-surface border border-surface-border text-[11px] flex items-center justify-between">
                            <div>
                              <strong className="text-white">{ev.modelName || ev.resourceId}</strong>
                              <span className="text-slate-400 ml-1.5">{t('manualBridge.tierLabel')} {ev.tier || 'N/A'}</span>
                            </div>
                            <span
                              className={`px-1.5 py-0.2 rounded font-semibold ${
                                ev.eligibility === 'ELIGIBLE' ? 'text-emerald-400' : 'text-rose-400'
                              }`}
                            >
                              {ev.eligibility}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Authorize Button */}
                  {authError && (
                    <div className="p-2.5 rounded bg-rose-950/30 border border-rose-800/40 text-rose-300">
                      {authError}
                    </div>
                  )}

                  {(routingDecision.outcome === 'SELECTED' || routingDecision.outcome === 'MANUAL_HANDOFF_REQUIRED') && (
                    <button
                      onClick={handleAuthorizeTask}
                      disabled={!canAuthorize || isAuthorizing}
                      className="w-full py-2 bg-forge-emerald hover:bg-emerald-600 text-slate-950 font-bold text-xs rounded-lg shadow transition flex items-center justify-center space-x-2 disabled:opacity-40"
                    >
                      <Lock className="w-3.5 h-3.5" />
                      <span>{isAuthorizing ? t('manualBridge.creatingAuthButton') : t('manualBridge.createAuthButton')}</span>
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Step 4: Execution Authorization Display */}
            <div className="bg-surface-card border border-surface-border rounded-xl p-5 shadow space-y-4">
              <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider flex items-center space-x-2">
                <span className="w-5 h-5 rounded-full bg-forge-amber/20 text-forge-amber flex items-center justify-center text-[10px] font-bold">4</span>
                <span>{t('manualBridge.step4ExecutionAuthTitle')}</span>
              </h3>

              {!authorization ? (
                <div className="h-64 flex flex-col items-center justify-center text-slate-500 space-y-2 border border-dashed border-surface-border rounded-lg p-6 text-center">
                  <Key className="w-8 h-8 text-slate-600" />
                  <span className="text-xs font-mono">{t('manualBridge.step4AuthEmptyHint')}</span>
                </div>
              ) : (
                <div className="space-y-3.5 text-xs font-mono">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">{t('manualBridge.authorityStatusLabel')}:</span>
                    <span
                      className={`px-2.5 py-1 rounded font-bold border ${
                        authorization.status === 'AUTHORIZED'
                          ? 'bg-amber-950/40 text-forge-amber border-amber-800/40'
                          : authorization.status === 'DISPATCHED'
                          ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800/40'
                          : 'bg-rose-950/40 text-rose-300 border-rose-800/40'
                      }`}
                    >
                      {authorization.status}
                    </span>
                  </div>

                  <div className="bg-surface p-3.5 rounded-lg border border-surface-border space-y-1.5 text-[11px]">
                    <div>{t('manualBridge.authIdLabel')}: <strong className="text-white">{authorization.id}</strong></div>
                    <div>{t('manualBridge.taskRevisionLabel')}: <strong className="text-forge-cyan">Rev {authorization.task_revision}</strong></div>
                    <div>
                      {t('manualBridge.boundRouteLabel')}: <strong className="text-forge-amber">{authorization.routing_decision_id}</strong>
                      {authBoundRoutingDecision && (
                        <span className="ml-1 text-slate-400">({authBoundRoutingDecision.outcome})</span>
                      )}
                    </div>
                    {snapshot?.latestRoutingDecision &&
                      snapshot.latestRoutingDecision.decisionId !== authorization.routing_decision_id && (
                        <div className="p-2 rounded bg-amber-950/30 border border-amber-800/40 text-[10px] text-forge-amber">
                          {t('manualBridge.latestRouteNewerNotice', {
                            latest: snapshot.latestRoutingDecision.decisionId,
                            authorized: authorization.routing_decision_id,
                          })}
                        </div>
                      )}
                    <div>{t('manualBridge.repoHeadLabel')}: <span className="text-slate-300 truncate block">{authorization.repository_head_sha}</span></div>
                    <div>{t('manualBridge.instructionHashLabel')}: <span className="text-slate-400 truncate block">{authorization.instruction_payload_hash}</span></div>
                    <div>{t('manualBridge.contextHashLabel')}: <span className="text-slate-400 truncate block">{authorization.context_manifest_hash}</span></div>
                    {authorization.dispatched_at && (
                      <div>{t('manualBridge.dispatchedAtLabel')}: <span className="text-slate-300">{authorization.dispatched_at}</span></div>
                    )}
                  </div>

                  {dispatchError && (
                    <div className="p-2.5 rounded bg-rose-950/30 border border-rose-800/40 text-rose-300">
                      {dispatchError}
                    </div>
                  )}

                  {/* Dispatch Button */}
                  {authorization.status === 'AUTHORIZED' ? (
                    <button
                      onClick={handleDispatchAuthorization}
                      disabled={!canDispatch || isDispatching}
                      className="w-full py-2.5 bg-forge-cyan hover:bg-cyan-500 text-slate-950 font-bold text-xs rounded-lg shadow-lg transition flex items-center justify-center space-x-2 disabled:opacity-40"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>
                        {isDispatching
                          ? t('manualBridge.dispatchingButton')
                          : routingDecision?.outcome === 'MANUAL_HANDOFF_REQUIRED'
                          ? t('manualBridge.dispatchManualHandoffButton')
                          : t('manualBridge.dispatchAuthorizedProviderButton')}
                      </span>
                    </button>
                  ) : isManualHandoffAwaitingOwner ? (
                    <div className="p-3 bg-emerald-950/20 border border-emerald-800/40 rounded-lg text-emerald-300 text-center space-y-1">
                      <div className="font-bold flex items-center justify-center space-x-1.5">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        <span>{t('manualBridge.awaitingOwnerConsumedTitle')}</span>
                      </div>
                      <p className="text-[11px] text-slate-300">
                        {t('manualBridge.awaitingOwnerConsumedDesc')}
                      </p>
                    </div>
                  ) : isSelectedDispatched ? (
                    <div className="p-3 bg-cyan-950/20 border border-cyan-800/40 rounded-lg text-cyan-300 text-center space-y-1">
                      <div className="font-bold flex items-center justify-center space-x-1.5">
                        <CheckCircle2 className="w-4 h-4 text-cyan-400" />
                        <span>{t('manualBridge.dispatchedToProviderTitle')}</span>
                      </div>
                      <p className="text-[11px] text-slate-300">
                        {t('manualBridge.dispatchedToProviderDesc')}
                      </p>
                    </div>
                  ) : (
                    <div className="p-3 bg-rose-950/20 border border-rose-800/40 rounded-lg text-rose-300 text-center">
                      {t('manualBridge.authInvalidatedNotice')}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ---------------------------------------------------- */}
          {/* STEP 5 & 6: MANUAL RELAY WORKORDER & CODER INBOX LINK */}
          {/* ---------------------------------------------------- */}
          {isManualHandoffAwaitingOwner && (
            <div className="bg-surface-card border border-surface-border rounded-xl p-6 shadow space-y-4">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 border-b border-surface-border pb-4">
                <div>
                  <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider flex items-center space-x-2">
                    <span className="w-5 h-5 rounded-full bg-forge-emerald/20 text-forge-emerald flex items-center justify-center text-[10px] font-bold">5</span>
                    <span>{t('manualBridge.step5WorkOrderRelayTitle')}</span>
                  </h3>
                  <p className="text-[11px] text-slate-400 font-mono mt-0.5">
                    {t('manualBridge.step5WorkOrderRelayDesc')}
                  </p>
                </div>

                <div className="flex items-center space-x-2">
                  <button
                    onClick={handleGenerateHandoffWorkOrder}
                    disabled={isGeneratingHandoffWorkOrder}
                    className="px-3.5 py-1.5 bg-surface hover:bg-surface-hover border border-surface-border text-white text-xs font-mono font-bold rounded-lg shadow transition flex items-center space-x-1.5"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-forge-emerald" />
                    <span>{isGeneratingHandoffWorkOrder ? t('manualBridge.generatingWorkOrderButton') : t('manualBridge.generateAuthorizedWorkOrderButton')}</span>
                  </button>

                  {handoffWorkOrder && (
                    <button
                      onClick={handleCopyHandoffWorkOrder}
                      className={`px-3.5 py-1.5 rounded-lg text-xs font-mono font-bold flex items-center space-x-1.5 transition ${
                        handoffCopied
                          ? 'bg-emerald-500/30 text-emerald-400 border border-emerald-500/50'
                          : 'bg-forge-emerald hover:bg-emerald-600 text-slate-950 shadow-lg'
                      }`}
                    >
                      {handoffCopied ? <Check className="w-3.5 h-3.5" /> : <Clipboard className="w-3.5 h-3.5" />}
                      <span>{handoffCopied ? t('manualBridge.workOrderCopiedButton') : t('manualBridge.oneClickCopyWorkOrderButton')}</span>
                    </button>
                  )}
                </div>
              </div>

              {handoffWorkOrder ? (
                <div className="space-y-4">
                  <textarea
                    readOnly
                    value={handoffWorkOrder}
                    className="w-full h-80 bg-surface border border-surface-border rounded-lg p-4 text-xs text-slate-100 font-mono focus:outline-none resize-none"
                  />

                  {/* Step by step owner prompt */}
                  <div className="p-4 bg-surface rounded-lg border border-surface-border flex flex-col md:flex-row md:items-center justify-between gap-4 text-xs font-mono">
                    <div className="space-y-1">
                      <div className="font-bold text-white">{t('manualBridge.nextStepCoderTitle')}</div>
                      <p className="text-[11px] text-slate-400">
                        {t('manualBridge.nextStepCoderDesc')}
                      </p>
                    </div>

                    <button
                      onClick={() => setActiveTab('quarantined-queue')}
                      className="px-4 py-2 bg-forge-cyan hover:bg-cyan-500 text-slate-950 font-bold rounded-lg shadow transition flex items-center space-x-2 shrink-0"
                    >
                      <Terminal className="w-4 h-4" />
                      <span>{t('manualBridge.openCoderInboxButton')}</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="p-6 bg-surface rounded-lg border border-surface-border text-center space-y-2 text-xs font-mono text-slate-400">
                  <FileCheck className="w-8 h-8 mx-auto text-slate-500" />
                  <p>{t('manualBridge.emptyWorkOrderRelayHint')}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 2: MANAGER INBOX */}
      {/* ========================================================================= */}
      {activeTab === 'manager-inbox' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: Input Textarea */}
          <div className="bg-surface-card border border-surface-border rounded-xl p-5 shadow space-y-4 flex flex-col justify-between">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-mono font-semibold text-slate-300 flex items-center space-x-2">
                  <Shield className="w-4 h-4 text-forge-purple" />
                  <span>{t('managerInbox.pasteLabel')}</span>
                </label>
                <span className="text-[11px] text-slate-500 font-mono">{t('managerInbox.formatHint')}</span>
              </div>
              <textarea
                value={managerInput}
                onChange={(e) => setManagerInput(e.target.value)}
                placeholder={t('managerInbox.placeholder')}
                className="w-full h-80 bg-surface border border-surface-border rounded-lg p-3.5 text-xs text-slate-100 font-mono focus:outline-none focus:border-forge-purple resize-none"
              />
            </div>

            <div className="flex items-center justify-between pt-2">
              <button
                onClick={() => setManagerInput('')}
                className="text-xs text-slate-400 hover:text-slate-200 font-mono"
              >
                {t('common.clear')}
              </button>
              <button
                onClick={handleParseManager}
                className="px-4 py-2 bg-forge-purple hover:bg-purple-600 text-white font-mono font-bold text-xs rounded-lg shadow flex items-center space-x-2 transition"
              >
                <Sparkles className="w-4 h-4" />
                <span>{t('managerInbox.parseProtocolButton')}</span>
              </button>
            </div>
          </div>

          {/* Right: Validation & State Preview */}
          <div className="bg-surface-card border border-surface-border rounded-xl p-5 shadow space-y-4">
            <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider">
              {t('managerInbox.validationPreviewTitle')}
            </h3>

            {!managerParseResult ? (
              <div className="h-80 flex flex-col items-center justify-center text-slate-500 space-y-2 border border-dashed border-surface-border rounded-lg p-6 text-center">
                <FileCheck className="w-8 h-8 text-slate-600" />
                <span className="text-xs font-mono">{t('managerInbox.emptyParseHint')}</span>
              </div>
            ) : managerParseResult.success ? (
              <div className="space-y-4 text-xs font-mono">
                <div className="p-3 bg-emerald-950/20 border border-emerald-800/30 rounded-lg text-emerald-300 flex items-center space-x-2">
                  <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>
                    {t('managerInbox.validPayloadDetected', {
                      protocolType: managerParseResult.protocolType || 'manager.v1',
                    })}
                  </span>
                </div>

                <div className="bg-surface p-4 rounded-lg border border-surface-border space-y-2">
                  <div>{t('routing.decisionId')}: <strong className="text-white">{managerParseResult.data?.data?.message_id}</strong></div>
                  <div>{t('managerInbox.targetTaskLabel')}: <strong className="text-forge-cyan">{managerParseResult.data?.data?.task_id || t('manualBridge.generalMilestone')}</strong></div>
                  <div>{t('managerInbox.title')}: <span className="px-2 py-0.5 rounded bg-forge-purple/20 text-forge-purple font-bold border border-forge-purple/40">{managerParseResult.data?.data?.decision}</span></div>
                  <div>{t('manualBridge.riskPriorityLabel')}: <span className="text-slate-300">{managerParseResult.data?.data?.priority} / {managerParseResult.data?.data?.risk}</span></div>
                  <div>{t('managerInbox.criteriaDefinedLabel')}: <span className="text-white">{managerParseResult.data?.data?.acceptance_criteria?.length || 0}</span></div>
                  <div>{t('managerInbox.issuesLoggedLabel')}: <span className="text-white">{managerParseResult.data?.data?.review_issues?.length || 0}</span></div>
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
                  <span>{t('managerInbox.applyStateTransitionButton')}</span>
                </button>
              </div>
            ) : (
              <div className="p-4 bg-rose-950/20 border border-rose-800/30 rounded-lg text-xs font-mono text-rose-300 space-y-2">
                <div className="flex items-center space-x-2 font-bold">
                  <AlertCircle className="w-4 h-4 text-rose-400" />
                  <span>{t('managerInbox.protocolErrorTitle')}</span>
                </div>
                <p className="text-slate-300">{managerParseResult.error}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 3: QUARANTINED SUBMISSIONS QUEUE (R5J5) */}
      {/* ========================================================================= */}
      {activeTab === 'quarantined-queue' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left: Quarantined Submissions List (5 cols) */}
          <div className="lg:col-span-5 bg-surface-card border border-surface-border rounded-xl p-5 shadow space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider">
                  {t('quarantinedQueue.candidateListTitle')}
                </h3>
                <p className="text-[11px] text-slate-500 font-mono">
                  {t('quarantinedQueue.subtitle')}
                </p>
              </div>
              <button
                onClick={loadSubmissions}
                disabled={loadingSubmissions}
                className="px-2.5 py-1.5 bg-surface hover:bg-surface-border text-slate-300 rounded border border-surface-border text-xs font-mono flex items-center space-x-1.5 transition"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingSubmissions ? 'animate-spin' : ''}`} />
                <span>{t('quarantinedQueue.refresh')}</span>
              </button>
            </div>

            {quarantinedSubmissions.length === 0 ? (
              <div className="h-72 flex flex-col items-center justify-center text-slate-500 space-y-2 border border-dashed border-surface-border rounded-lg p-6 text-center">
                <FileCheck className="w-8 h-8 text-slate-600" />
                <span className="text-xs font-mono">{t('quarantinedQueue.noSubmissions')}</span>
              </div>
            ) : (
              <div className="space-y-2 max-h-[580px] overflow-y-auto pr-1">
                {quarantinedSubmissions.map((sub) => {
                  const isSelected = sub.id === selectedSubmissionId;
                  const isFenced = sub.integrity_status === 'FENCED_INTEGRITY_CONFLICT';

                  let statusBadge = (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-800 text-slate-400 border border-slate-700">
                      {sub.active_adjudication?.status || 'QUEUED'}
                    </span>
                  );
                  if (sub.active_adjudication?.status === 'ADMITTED') {
                    statusBadge = (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-blue-950/40 text-blue-400 border border-blue-800/50">
                        {t('quarantinedQueue.statusAdmitted')}
                      </span>
                    );
                  } else if (sub.active_adjudication?.status === 'VERIFYING') {
                    statusBadge = (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-amber-950/40 text-amber-400 border border-amber-800/50 animate-pulse">
                        {t('quarantinedQueue.statusVerifying')}
                      </span>
                    );
                  } else if (sub.active_adjudication?.status === 'VERIFIED') {
                    statusBadge = (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-emerald-950/40 text-emerald-400 border border-emerald-800/50">
                        {t('quarantinedQueue.statusVerified')}
                      </span>
                    );
                  } else if (sub.active_adjudication?.status === 'VERIFICATION_FAILED') {
                    statusBadge = (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-rose-950/40 text-rose-400 border border-rose-800/50">
                        {t('quarantinedQueue.statusVerificationFailed')}
                      </span>
                    );
                  } else if (sub.active_adjudication?.status === 'RECOVERY_FENCED') {
                    statusBadge = (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-orange-950/40 text-orange-400 border border-orange-800/50">
                        {t('quarantinedQueue.statusRecoveryFenced')}
                      </span>
                    );
                  }

                  return (
                    <div
                      key={sub.id}
                      onClick={() => setSelectedSubmissionId(sub.id)}
                      className={`p-3 rounded-lg border text-xs font-mono cursor-pointer transition ${
                        isSelected
                          ? 'bg-surface border-forge-cyan shadow-sm'
                          : 'bg-surface/50 border-surface-border hover:border-slate-600'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-bold text-slate-200">
                          {sub.id.substring(0, 8)}...
                        </span>
                        {statusBadge}
                      </div>
                      <div className="text-[11px] text-slate-400 mb-1">
                        Task: <strong className="text-forge-cyan">{sub.task_id}</strong>
                      </div>
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-slate-500">{new Date(sub.submitted_at).toLocaleTimeString()}</span>
                        {isFenced ? (
                          <span className="text-rose-400 font-semibold flex items-center space-x-1">
                            <AlertTriangle className="w-3 h-3" />
                            <span>{t('quarantinedQueue.integrityFenced')}</span>
                          </span>
                        ) : (
                          <span className="text-emerald-400 font-semibold flex items-center space-x-1">
                            <CheckCircle2 className="w-3 h-3" />
                            <span>{t('quarantinedQueue.integrityValid')}</span>
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right: Inspection & Owner Adjudication Controls (7 cols) */}
          <div className="lg:col-span-7 bg-surface-card border border-surface-border rounded-xl p-5 shadow space-y-4">
            <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider">
              {t('quarantinedQueue.inspectTitle')}
            </h3>

            {!selectedSubmissionId || !submissionDetail ? (
              <div className="h-96 flex flex-col items-center justify-center text-slate-500 space-y-2 border border-dashed border-surface-border rounded-lg p-6 text-center">
                <Shield className="w-8 h-8 text-slate-600" />
                <span className="text-xs font-mono">Select a quarantined submission from the queue to inspect authority bindings and take action.</span>
              </div>
            ) : (
              <div className="space-y-4 text-xs font-mono">
                {/* Feedback notices */}
                {adjudicationFeedback && (
                  <div className="p-3 bg-emerald-950/30 border border-emerald-800/40 rounded-lg text-emerald-300 flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>{adjudicationFeedback}</span>
                  </div>
                )}
                {adjudicationError && (
                  <div className="p-3 bg-rose-950/30 border border-rose-800/40 rounded-lg text-rose-300 flex items-center space-x-2">
                    <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                    <span>{adjudicationError}</span>
                  </div>
                )}

                {/* Integrity Fenced Banner */}
                {submissionDetail.integrity_status === 'FENCED_INTEGRITY_CONFLICT' && (
                  <div className="p-3 bg-rose-950/40 border border-rose-800/60 rounded-lg text-rose-300 space-y-1">
                    <div className="font-bold flex items-center space-x-2">
                      <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                      <span>{t('quarantinedQueue.integrityFencedNotice')}</span>
                    </div>
                    {submissionDetail.integrity_fenced_reasons?.map((r: string, idx: number) => (
                      <div key={idx} className="text-[11px] text-rose-400 pl-6">• {r}</div>
                    ))}
                  </div>
                )}

                {/* Authority Bindings */}
                <div className="p-3.5 bg-surface rounded-lg border border-surface-border space-y-1.5 text-[11px]">
                  <div className="font-bold text-slate-300 text-xs mb-1 flex items-center space-x-2">
                    <Lock className="w-3.5 h-3.5 text-forge-amber" />
                    <span>{t('quarantinedQueue.authorityBindingsTitle')}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>Submission ID: <span className="text-slate-200">{submissionDetail.submission?.id}</span></div>
                    <div>Task ID: <span className="text-forge-cyan">{submissionDetail.submission?.task_id}</span></div>
                    <div>Authorization ID: <span className="text-slate-200">{submissionDetail.submission?.authorization_id}</span></div>
                    <div>Epoch: <span className="text-slate-200">{submissionDetail.submission?.task_ownership_epoch}</span></div>
                    <div>Base SHA: <span className="text-slate-300 font-mono">{submissionDetail.submission?.base_sha?.substring(0, 10)}...</span></div>
                    <div>Authorized HEAD: <span className="text-slate-300 font-mono">{submissionDetail.submission?.authorized_head_sha?.substring(0, 10)}...</span></div>
                  </div>
                </div>

                {/* Untrusted Coder Claim */}
                <div className="p-3.5 bg-surface rounded-lg border border-surface-border space-y-2 text-[11px]">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-300 text-xs flex items-center space-x-2">
                      <Terminal className="w-3.5 h-3.5 text-forge-cyan" />
                      <span>{t('quarantinedQueue.untrustedClaimTitle')}</span>
                    </span>
                    <span className="text-[10px] text-amber-400 bg-amber-950/30 px-2 py-0.5 rounded border border-amber-800/40">
                      {t('quarantinedQueue.nonAuthoritativeBadge')}
                    </span>
                  </div>
                  <div className="text-slate-400 italic">
                    "{submissionDetail.untrusted_claim?.summary || t('quarantinedQueue.noSummaryProvided')}"
                  </div>
                  <div className="space-y-1 text-slate-300">
                    <div>{t('quarantinedQueue.filesClaimed')}: <span className="text-slate-200">{submissionDetail.untrusted_claim?.files_claimed_changed?.join(', ') || t('quarantinedQueue.none')}</span></div>
                    <div>{t('quarantinedQueue.testsClaimed')}: <span className="text-slate-200">{submissionDetail.untrusted_claim?.tests_claimed?.join(', ') || t('quarantinedQueue.none')}</span></div>
                    <div>{t('quarantinedQueue.blockers')}: <span className="text-slate-200">{submissionDetail.untrusted_claim?.blockers?.join(', ') || t('quarantinedQueue.none')}</span></div>
                  </div>
                </div>

                {/* Adjudication Status / History */}
                {submissionDetail.adjudications && submissionDetail.adjudications.length > 0 && (
                  <div className="p-3 bg-surface rounded-lg border border-surface-border space-y-2 text-[11px]">
                    <div className="font-bold text-slate-300 text-xs">
                      {t('quarantinedQueue.adjudicationHistoryTitle')}
                    </div>
                    {submissionDetail.adjudications.map((adj) => (
                      <div key={adj.id} className="p-2 bg-surface-card rounded border border-surface-border/60 flex items-center justify-between">
                        <div>
                          <span className="font-bold text-slate-200">{adj.action}</span>
                          <span className="text-slate-500 ml-2">({adj.status}, v{adj.lifecycle_version})</span>
                        </div>
                        <span className="text-slate-400 text-[10px]">{new Date(adj.created_at).toLocaleTimeString()}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Owner Adjudication Action Controls */}
                <div className="pt-2 border-t border-surface-border space-y-3">
                  <div className="font-bold text-slate-300 text-xs">
                    {t('quarantinedQueue.adjudicationActionsTitle')}
                  </div>

                  <div className="flex flex-wrap gap-2.5">
                    {/* Admit button */}
                    <button
                      onClick={() => setConfirmModalAction('ADMIT')}
                      disabled={
                        isAdjudicating ||
                        submissionDetail.integrity_status === 'FENCED_INTEGRITY_CONFLICT' ||
                        submissionDetail.adjudications?.some((a) => a.status === 'ADMITTED' || a.status === 'VERIFYING')
                      }
                      className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-mono font-bold text-xs rounded-lg shadow flex items-center space-x-1.5 transition disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>{t('quarantinedQueue.admitButton')}</span>
                    </button>

                    {/* Reject button */}
                    <button
                      onClick={() => setConfirmModalAction('REJECT')}
                      disabled={isAdjudicating}
                      className="px-3.5 py-2 bg-rose-700 hover:bg-rose-600 text-white font-mono font-bold text-xs rounded-lg shadow flex items-center space-x-1.5 transition disabled:opacity-40"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      <span>{t('quarantinedQueue.rejectButton')}</span>
                    </button>

                    {/* Supersede button */}
                    <button
                      onClick={() => setConfirmModalAction('SUPERSEDE')}
                      disabled={isAdjudicating}
                      className="px-3.5 py-2 bg-purple-700 hover:bg-purple-600 text-white font-mono font-bold text-xs rounded-lg shadow flex items-center space-x-1.5 transition disabled:opacity-40"
                    >
                      <ArrowLeftRight className="w-3.5 h-3.5" />
                      <span>{t('quarantinedQueue.supersedeButton')}</span>
                    </button>

                    {/* Resume button for ADMITTED pre-start */}
                    {submissionDetail.adjudications?.some((a) => a.status === 'ADMITTED') && (
                      <button
                        onClick={() => setConfirmModalAction('RESUME')}
                        disabled={isAdjudicating}
                        className="px-3.5 py-2 bg-cyan-700 hover:bg-cyan-600 text-white font-mono font-bold text-xs rounded-lg shadow flex items-center space-x-1.5 transition disabled:opacity-40"
                      >
                        <Play className="w-3.5 h-3.5" />
                        <span>{t('quarantinedQueue.resumeButton')}</span>
                      </button>
                    )}

                    {/* Acknowledge button for RECOVERY_FENCED */}
                    {submissionDetail.adjudications?.some((a) => a.status === 'RECOVERY_FENCED') && (
                      <button
                        onClick={() => setConfirmModalAction('ACKNOWLEDGE')}
                        disabled={isAdjudicating}
                        className="px-3.5 py-2 bg-orange-700 hover:bg-orange-600 text-white font-mono font-bold text-xs rounded-lg shadow flex items-center space-x-1.5 transition disabled:opacity-40"
                      >
                        <Shield className="w-3.5 h-3.5" />
                        <span>{t('quarantinedQueue.acknowledgeButton')}</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Explicit Confirmation Modal */}
                {confirmModalAction && (
                  <div className="p-4 bg-surface rounded-lg border border-forge-amber/60 shadow-lg space-y-3">
                    <div className="flex items-center space-x-2 text-forge-amber font-bold text-xs">
                      <AlertTriangle className="w-4 h-4" />
                      <span>
                        {confirmModalAction === 'ADMIT' && t('quarantinedQueue.confirmAdmitTitle')}
                        {confirmModalAction === 'REJECT' && t('quarantinedQueue.confirmRejectTitle')}
                        {confirmModalAction === 'SUPERSEDE' && t('quarantinedQueue.confirmSupersedeTitle')}
                        {confirmModalAction === 'RESUME' && t('quarantinedQueue.confirmResumeTitle')}
                        {confirmModalAction === 'ACKNOWLEDGE' && t('quarantinedQueue.confirmAcknowledgeTitle')}
                      </span>
                    </div>

                    <p className="text-slate-300 text-[11px]">
                      {confirmModalAction === 'ADMIT' && t('quarantinedQueue.confirmAdmitMessage')}
                      {confirmModalAction === 'REJECT' && t('quarantinedQueue.confirmRejectMessage')}
                      {confirmModalAction === 'SUPERSEDE' && t('quarantinedQueue.confirmSupersedeMessage')}
                      {confirmModalAction === 'RESUME' && t('quarantinedQueue.confirmResumeMessage')}
                      {confirmModalAction === 'ACKNOWLEDGE' && t('quarantinedQueue.confirmAcknowledgeMessage')}
                    </p>

                    {(confirmModalAction === 'REJECT' || confirmModalAction === 'SUPERSEDE') && (
                      <div className="space-y-1">
                        <label className="text-[10px] text-slate-400">
                          {confirmModalAction === 'REJECT' ? t('quarantinedQueue.rejectReasonLabel') : t('quarantinedQueue.supersedeReasonLabel')}
                        </label>
                        <input
                          type="text"
                          value={adjudicationReason}
                          onChange={(e) => setAdjudicationReason(e.target.value)}
                          placeholder={confirmModalAction === 'REJECT' ? t('quarantinedQueue.rejectReasonPlaceholder') : t('quarantinedQueue.supersedeReasonPlaceholder')}
                          className="w-full bg-surface-card border border-surface-border rounded px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-forge-amber"
                        />
                      </div>
                    )}

                    {confirmModalAction === 'SUPERSEDE' && (
                      <div className="space-y-1">
                        <label className="text-[10px] text-slate-400">
                          {t('quarantinedQueue.replacementSubmissionIdLabel')}
                        </label>
                        <input
                          type="text"
                          value={replacementSubId}
                          onChange={(e) => setReplacementSubId(e.target.value)}
                          placeholder={t('quarantinedQueue.replacementSubmissionIdPlaceholder')}
                          className="w-full bg-surface-card border border-surface-border rounded px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-forge-amber font-mono"
                        />
                      </div>
                    )}

                    <div className="flex items-center justify-end space-x-2 pt-1">
                      <button
                        onClick={() => {
                          setConfirmModalAction(null);
                          setAdjudicationReason('');
                          setReplacementSubId('');
                        }}
                        disabled={isAdjudicating}
                        className="px-3 py-1.5 bg-surface hover:bg-surface-border text-slate-400 rounded text-xs transition"
                      >
                        {t('common.cancel')}
                      </button>
                      <button
                        onClick={handleExecuteAdjudication}
                        disabled={isAdjudicating || (confirmModalAction === 'SUPERSEDE' && !replacementSubId.trim())}
                        className="px-4 py-1.5 bg-forge-amber hover:bg-amber-500 text-slate-950 font-bold rounded text-xs transition disabled:opacity-40"
                      >
                        {isAdjudicating ? t('common.loading') : t('common.confirm')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 4: OUTBOX GENERATOR */}
      {/* ========================================================================= */}
      {activeTab === 'outbox' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Configuration Form (1 col) */}
          <div className="bg-surface-card border border-surface-border rounded-xl p-5 shadow space-y-4">
            <div className="p-3 bg-slate-900/50 border border-slate-700/50 rounded-lg text-[11px] font-mono text-slate-300">
              <span className="font-bold text-slate-200">{t('manualBridge.noticeLabel')}:</span> {t('manualBridge.outboxNoticeText')}
            </div>

            <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider">
              {t('manualBridge.packageConfigTitle')}
            </h3>

            <div>
              <label className="block text-xs font-mono text-slate-400 mb-1.5">{t('manualBridge.selectTargetTaskLabel')}:</label>
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
              <label className="block text-xs font-mono text-slate-400 mb-1.5">{t('manualBridge.packageTypeLabel')}:</label>
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
                    <div className="text-xs font-semibold text-white">{t('manualBridge.workOrderOptionTitle')}</div>
                    <div className="text-[11px] text-slate-400">{t('manualBridge.workOrderOptionDesc')}</div>
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
                    <div className="text-xs font-semibold text-white">{t('manualBridge.reviewPackageOptionTitle')}</div>
                    <div className="text-[11px] text-slate-400">{t('manualBridge.reviewPackageOptionDesc')}</div>
                  </div>
                </label>
              </div>
            </div>

            <button
              onClick={handleGenerateOutbox}
              disabled={isGenerating}
              className="w-full py-2.5 bg-forge-emerald hover:bg-emerald-600 text-slate-950 font-mono font-bold text-xs rounded-lg shadow-lg flex items-center justify-center space-x-2 transition disabled:opacity-50"
            >
              <Sparkles className="w-4 h-4" />
              <span>{isGenerating ? t('manualBridge.generatingPackageButton') : t('manualBridge.generatePackageButton')}</span>
            </button>
          </div>

          {/* Right: Output Preview (2 cols) */}
          <div className="lg:col-span-2 bg-surface-card border border-surface-border rounded-xl p-5 shadow space-y-4 flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider">
                {t('manualBridge.generatedMarkdownPackageTitle')}
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
                  <span>{copied ? t('manualBridge.copiedButton') : t('manualBridge.oneClickCopyButton')}</span>
                </button>
              )}
            </div>

            <textarea
              readOnly
              value={outboxContent}
              placeholder={t('manualBridge.outboxPlaceholder')}
              className="w-full h-96 bg-surface border border-surface-border rounded-lg p-4 text-xs text-slate-100 font-mono focus:outline-none resize-none"
            />
          </div>
        </div>
      )}
    </div>
  );
};
