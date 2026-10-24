import React from 'react';
import { ProviderResource, Task } from '../../core/types/domain';
import type { AgentRosterEntry, ManagedAgent } from '../../core/types/workspace';
import { useI18n } from '../context/I18nContext';
import { QuotaBadge } from './QuotaBadge';
import { Bot, Terminal, Shield, ArrowUpRight, Pencil, Trash2, RotateCcw, Wrench, LogIn } from 'lucide-react';

interface AgentCardProps {
  agent: ManagedAgent;
  resource?: ProviderResource;
  assignedTask?: Task;
  onViewTask?: (taskId: string) => void;
  /** Durable roster read model; when present the card shows bindings and owner actions. */
  entry?: AgentRosterEntry;
  actionsDisabled?: boolean;
  onEdit?: () => void;
  onRemove?: () => void;
  onRestore?: () => void;
  /** Offered for Codex CLI agents whose account is not yet proven signed in. */
  onSignIn?: () => void;
}

export const AgentCard: React.FC<AgentCardProps> = ({
  agent,
  resource,
  assignedTask,
  onViewTask,
  entry,
  actionsDisabled = false,
  onEdit,
  onRemove,
  onRestore,
  onSignIn,
}) => {
  const { t } = useI18n();
  const removed = Boolean(agent.removed_at);
  const blockers = entry?.blockers ?? [];
  const blockerListId = `agent-blockers-${agent.id}`;

  const getRoleIcon = () => {
    switch (agent.role) {
      case 'PRIMARY_MANAGER':
      case 'BACKUP_MANAGER':
        return <Shield className="w-4 h-4 text-forge-purple" />;
      case 'CODER':
        return <Terminal className="w-4 h-4 text-forge-cyan" />;
      case 'REVIEWER':
        return <Shield className="w-4 h-4 text-forge-emerald" />;
      case 'TOOL':
        return <Wrench className="w-4 h-4 text-amber-400" />;
      default:
        return <Bot className="w-4 h-4 text-slate-400" />;
    }
  };

  const getStatusColor = () => {
    switch (agent.status) {
      case 'ACTIVE':
      case 'BUSY':
        return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30';
      case 'PAUSED':
        return 'bg-amber-500/20 text-amber-400 border-amber-500/30';
      case 'OFFLINE':
        return 'bg-rose-500/20 text-rose-400 border-rose-500/30';
      default:
        return 'bg-slate-800 text-slate-400 border-slate-700';
    }
  };

  const observableAction = assignedTask
    ? assignedTask.state === 'CODING'
      ? t('agentCard.actions.implementingCode')
      : assignedTask.state === 'VALIDATING'
      ? t('agentCard.actions.runningVerification')
      : assignedTask.state === 'REVIEWING'
      ? t('agentCard.actions.evaluatingReview')
      : t('agentCard.actions.activeOnTask', { taskId: assignedTask.id })
    : t('agentCard.actions.awaitingDispatch');

  const modelName = entry?.resource?.modelName ?? resource?.model_name;

  return (
    <div className={`bg-surface-card border border-surface-border rounded-xl p-5 shadow-lg space-y-4 hover:border-surface-hover transition group ${removed ? 'opacity-70' : ''}`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center space-x-3 min-w-0">
          <div className="p-2 rounded-lg bg-surface border border-surface-border shrink-0">
            {getRoleIcon()}
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-white group-hover:text-forge-cyan transition truncate" title={agent.display_name}>
              {agent.display_name}
            </h3>
            <div className="text-xs text-slate-400 font-mono mt-0.5 truncate" title={modelName || t('agentCard.noAssignedModel')}>
              {modelName || t('agentCard.noAssignedModel')}
            </div>
          </div>
        </div>

        {/* Unified Aligned Badge Group */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] font-mono uppercase px-2 py-1 rounded-md bg-surface border border-surface-border text-slate-300 font-medium">
            {agent.role.replace('_', ' ')}
          </span>
          {removed ? (
            <span className="px-2.5 py-1 rounded-full text-xs font-mono font-medium border bg-slate-800 text-slate-300 border-slate-600">
              {t('agentCenter.removedBadge')}
            </span>
          ) : (
            <div className={`px-2.5 py-1 rounded-full text-xs font-mono font-medium border flex items-center space-x-1.5 ${getStatusColor()}`}>
              <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse"></span>
              <span>{agent.status}</span>
            </div>
          )}
        </div>
      </div>

      {entry && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
          <dt className="text-slate-400">{t('agentCenter.details.connection')}</dt>
          <dd className="text-slate-200 truncate">{t(`agentCenter.connections.${entry.connection}`)}</dd>
          <dt className="text-slate-400">{t('agentCenter.details.account')}</dt>
          <dd className="text-slate-200 font-mono truncate">{entry.account?.healthStatus ?? entry.resource?.healthStatus ?? 'UNKNOWN'}</dd>
          <dt className="text-slate-400">{t('agentCenter.details.slots')}</dt>
          <dd className="text-slate-200 font-mono">
            {entry.workerSlots.length > 0
              ? entry.workerSlots.map((slot) => slot.status).join(', ')
              : t('agentCenter.details.noSlots')}
          </dd>
          {entry.account?.profileRef && (
            <>
              <dt className="text-slate-400">{t('agentCenter.details.profile')}</dt>
              <dd className="text-slate-200 font-mono truncate" title={entry.account.profileRef}>{entry.account.profileRef}</dd>
            </>
          )}
        </dl>
      )}

      {/* Task & Action Info */}
      {!removed && (
        <div className="p-3 bg-surface/70 rounded-lg border border-surface-border space-y-2 text-xs">
          <div className="text-slate-400 font-mono flex items-center justify-between">
            <span>{t('agentCard.observableAction')}:</span>
            {assignedTask && (
              <span className="text-forge-cyan font-semibold">
                {t('agentCard.attemptLabel', { attempt: (assignedTask.revision_count + 1).toString() })}
              </span>
            )}
          </div>
          <div className="text-slate-200 font-medium">{observableAction}</div>

          {assignedTask && (
            <div className="pt-2 border-t border-surface-border/50 flex items-center justify-between">
              <span className="font-mono text-slate-400 text-[11px]">{t('agentCard.taskLabel')}: <strong className="text-white">{assignedTask.id}</strong></span>
              {onViewTask && (
                <button
                  onClick={() => onViewTask(assignedTask.id)}
                  className="text-[11px] text-forge-cyan hover:underline flex items-center space-x-0.5 font-medium"
                >
                  <span>{t('agentCard.viewTask')}</span>
                  <ArrowUpRight className="w-3 h-3" />
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Quota & Footer */}
      {resource && !removed && (
        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-slate-400 font-mono">{t('agentCard.resourceQuota')}:</span>
          <QuotaBadge
            remaining={resource.remaining_quota}
            total={resource.total_quota}
            unit={resource.quota_unit}
            source={resource.quota_source}
            confidence={resource.quota_confidence}
          />
        </div>
      )}

      {!removed && blockers.length > 0 && (onRemove || onEdit) && (
        <div id={blockerListId} className="p-2.5 rounded-lg border border-amber-700/50 bg-amber-950/30 text-amber-200 text-xs space-y-1">
          <div className="font-semibold">{t('agentCenter.blockers.title')}</div>
          <ul className="list-disc pl-4 space-y-0.5">
            {blockers.map((blocker) => (
              <li key={`${blocker.code}-${blocker.reference}`}>{t(`agentCenter.blockers.${blocker.code}`, { reference: blocker.reference })}</li>
            ))}
          </ul>
          <div className="text-amber-300/80">{t('agentCenter.remove.blockedHint')}</div>
        </div>
      )}

      {/* Sign-in can only initialize a never-used UNKNOWN account; other states keep their recorded health. */}
      {!removed && onSignIn && entry?.connection === 'CODEX_CLI' && entry.account?.healthStatus === 'UNKNOWN' && (
        <div className="p-2.5 rounded-lg border border-forge-cyan/40 bg-forge-cyan/5 text-xs text-slate-200 flex items-center justify-between gap-3">
          <span>{t('accountSignIn.needed')}</span>
          <button type="button" onClick={onSignIn} disabled={actionsDisabled}
            className="shrink-0 px-3 py-1.5 rounded-lg font-medium bg-forge-cyan text-slate-950 hover:bg-cyan-600 disabled:opacity-40 flex items-center gap-1.5">
            <LogIn className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{t('accountSignIn.button')}</span>
          </button>
        </div>
      )}

      {(onEdit || onRemove || onRestore) && (
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-surface-border/60">
          {removed ? (
            onRestore && (
              <button
                type="button"
                onClick={onRestore}
                disabled={actionsDisabled}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-forge-cyan/15 text-forge-cyan border border-forge-cyan/40 hover:bg-forge-cyan/25 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{t('agentCenter.actions.restore')}</span>
              </button>
            )
          ) : (
            <>
              {onEdit && (
                <button
                  type="button"
                  onClick={onEdit}
                  disabled={actionsDisabled}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-surface border border-surface-border text-slate-200 hover:bg-surface-border disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                  <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{t('agentCenter.actions.edit')}</span>
                </button>
              )}
              {onRemove && (
                <button
                  type="button"
                  onClick={onRemove}
                  disabled={actionsDisabled || blockers.length > 0}
                  aria-describedby={blockers.length > 0 ? blockerListId : undefined}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-rose-950/40 border border-rose-800/60 text-rose-300 hover:bg-rose-900/40 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{t('agentCenter.actions.remove')}</span>
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};
