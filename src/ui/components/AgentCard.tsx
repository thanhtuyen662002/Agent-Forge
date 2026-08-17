import React from 'react';
import { Agent, ProviderResource, Task } from '../../core/types/domain';
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
      ? 'Implementing code & running tests'
      : assignedTask.state === 'VALIDATING'
      ? 'Running automated verification commands'
      : assignedTask.state === 'REVIEWING'
      ? 'Manager evaluating review package'
      : `Active on ${assignedTask.id}`
    : 'Awaiting task dispatch (IDLE)';

  return (
    <div className="bg-surface-card border border-surface-border rounded-xl p-5 shadow-lg space-y-4 hover:border-surface-hover transition group">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center space-x-3">
          <div className="p-2 rounded-lg bg-surface border border-surface-border">
            {getRoleIcon()}
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h3 className="text-sm font-semibold text-white group-hover:text-forge-cyan transition">
                {agent.display_name}
              </h3>
              <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-surface border border-surface-border text-slate-400">
                {agent.role.replace('_', ' ')}
              </span>
            </div>
            <div className="text-xs text-slate-400 font-mono mt-0.5">
              {resource?.model_name || 'No assigned model'}
            </div>
          </div>
        </div>

        {/* Status Badge */}
        <div className={`px-2.5 py-1 rounded-full text-xs font-mono font-medium border flex items-center space-x-1.5 ${getStatusColor()}`}>
          <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse"></span>
          <span>{agent.status}</span>
        </div>
      </div>

      {/* Task & Action Info */}
      <div className="p-3 bg-surface/70 rounded-lg border border-surface-border space-y-2 text-xs">
        <div className="text-slate-400 font-mono flex items-center justify-between">
          <span>Observable Action:</span>
          {assignedTask && (
            <span className="text-forge-cyan font-semibold">
              Attempt #{assignedTask.revision_count + 1}
            </span>
          )}
        </div>
        <div className="text-slate-200 font-medium">{observableAction}</div>

        {assignedTask && (
          <div className="pt-2 border-t border-surface-border/50 flex items-center justify-between">
            <span className="font-mono text-slate-400 text-[11px]">Task: <strong className="text-white">{assignedTask.id}</strong></span>
            {onViewTask && (
              <button
                onClick={() => onViewTask(assignedTask.id)}
                className="text-[11px] text-forge-cyan hover:underline flex items-center space-x-0.5 font-medium"
              >
                <span>View Task</span>
                <ArrowUpRight className="w-3 h-3" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Quota & Footer */}
      {resource && (
        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-slate-400 font-mono">Resource Quota:</span>
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
