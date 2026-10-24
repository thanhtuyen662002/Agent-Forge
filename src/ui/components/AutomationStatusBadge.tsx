import React from 'react';
import { Bot } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { useAutomationStatus } from '../runtimeStatus';

const KNOWN_REASONS = new Set([
  'ACCOUNT_NOT_VERIFIED', 'NO_CLI_CODER', 'AUTOMATION_STOPPED', 'PROVIDER_EXECUTION_FAILED',
  'VERIFIED', 'VERIFICATION_FAILED', 'VERIFICATION_NOT_CONFIGURED', 'NOT_VERIFIED', 'WORKTREE_NOT_VERIFIABLE',
  'NO_MANAGER', 'MANAGER_NOT_AVAILABLE', 'MANAGER_PROPOSAL_PENDING', 'MANAGER_PROPOSAL_REJECTED', 'MANAGER_FAILED', 'MANAGER_RETRY_PENDING', 'REVIEWED_WORK_READY', 'NO_REVIEWER', 'REVIEWER_NOT_AVAILABLE', 'REVIEW_FIX_REQUIRED', 'REVIEW_BLOCKED', 'REVIEW_FAILED', 'REVIEW_STALE', 'REVIEW_INTERRUPTED',
]);

/**
 * The automation phase is shown next to, and separately from, the project
 * status: a RUNNING project is not proof that any worker is executing.
 */
export const AutomationStatusBadge: React.FC<{ projectId: string }> = ({ projectId }) => {
  const { t } = useI18n();
  const { available, status, failed } = useAutomationStatus();
  if (!available) return null;
  const project = status?.projects.find((item) => item.projectId === projectId) ?? null;
  const phaseText = project ? t(`runtime.phases.${project.phase}`) : failed ? t('runtime.statusUnavailable') : null;
  if (!phaseText) return null;
  const reason = project?.reasonCode
    ? KNOWN_REASONS.has(project.reasonCode)
      ? t(`runtime.reasons.${project.reasonCode}`)
      : t('runtime.reasons.GENERIC', { code: project.reasonCode })
    : null;
  const tone = project?.phase === 'EXECUTING'
    ? 'text-emerald-300 border-emerald-700/50'
    : project?.phase === 'FAILED' ? 'text-rose-300 border-rose-700/50'
    : project?.phase === 'AWAITING_REVIEW' || project?.phase === 'VERIFYING' || project?.phase === 'REVIEWING' || project?.phase === 'DECIDING' ? 'text-forge-cyan border-forge-cyan/40'
    : project?.phase === 'READY_FOR_INTEGRATION' ? 'text-emerald-300 border-emerald-700/50'
    : 'text-amber-300 border-amber-700/40';

  return (
    <div role="status" title={reason ?? undefined}
      className={`px-2.5 py-1 rounded-md text-[11px] border bg-surface-card flex items-center gap-1.5 max-w-80 ${tone}`}>
      <Bot className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{t('runtime.automationLabel')}: {phaseText}</span>
      {reason && <span className="sr-only">{reason}</span>}
    </div>
  );
};
