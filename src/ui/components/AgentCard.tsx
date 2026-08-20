import React from 'react';
import { Agent, ProviderResource, Task } from '../../core/types/domain';
import { useI18n } from '../context/I18nContext';
import { QuotaBadge } from './QuotaBadge';
import { Bot, Terminal, Shield, ArrowUpRight, Cpu } from 'lucide-react';

interface AgentCardProps {
  agent: Agent;
  resource?: ProviderResource;
  assignedTask?: Task;
  onViewTask?: (taskId: string) => void;
}

export const AgentCard: React.FC<AgentCardProps> = ({
  agent,
  resource,
  assignedTask,
  onViewTask,
}) => {
  const { t } = useI18n();

  const getRoleIcon = () => {
    switch (agent.role) {
      case 'PRIMARY_MANAGER':
      case 'BACKUP_MANAGER':
        return <Shield className="w-4 h-4 text-forge-purple" />;
      case 'CODER':
        return <Terminal className="w-4 h-4 text-forge-cyan" />;
      case 'REVIEWER':
        return <Shield className="w-4 h-4 text-forge-emerald" />;
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

  return (
    <div className="bg-surface-card border border-surface-border rounded-xl p-5 shadow-lg space-y-4 hover:border-surface-hover transition group">
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
            <div className="text-xs text-slate-400 font-mono mt-0.5 truncate" title={resource?.model_name || t('agentCard.noAssignedModel')}>
              {resource?.model_name || t('agentCard.noAssignedModel')}
            </div>
          </div>
        </div>

        {/* Unified Aligned Badge Group */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] font-mono uppercase px-2 py-1 rounded-md bg-surface border border-surface-border text-slate-300 font-medium">
            {agent.role.replace('_', ' ')}
          </span>
          <div className={`px-2.5 py-1 rounded-full text-xs font-mono font-medium border flex items-center space-x-1.5 ${getStatusColor()}`}>
            <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse"></span>
            <span>{agent.status}</span>
          </div>
        </div>
      </div>

      {/* Task & Action Info */}
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

      {/* Quota & Footer */}
      {resource && (
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
    </div>
  );
};
