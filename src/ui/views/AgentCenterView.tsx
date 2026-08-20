import React from 'react';
import { useOrchestrator } from '../context/OrchestratorContext';
import { useI18n } from '../context/I18nContext';
import { AgentCard } from '../components/AgentCard';
import { Bot, Shield, Terminal, Wrench } from 'lucide-react';

export const AgentCenterView: React.FC = () => {
  const { agents, resources, tasks, setSelectedTaskId, setActiveView } = useOrchestrator();
  const { t } = useI18n();

  const managers = agents.filter((a) => a.role === 'PRIMARY_MANAGER' || a.role === 'BACKUP_MANAGER');
  const coders = agents.filter((a) => a.role === 'CODER');
  const reviewers = agents.filter((a) => a.role === 'REVIEWER');

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto overflow-y-auto">
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight flex items-center space-x-2.5">
          <Bot className="w-5 h-5 text-forge-cyan" />
          <span>{t('agentCenter.title')}</span>
        </h2>
        <p className="text-xs text-slate-400">
          {t('agentCenter.subtitle')}
        </p>
      </div>

      {/* Managers Section */}
      <div className="space-y-3">
        <h3 className="text-xs font-mono font-semibold text-slate-400 uppercase tracking-wider flex items-center space-x-2">
          <Shield className="w-4 h-4 text-forge-purple" />
          <span>{t('agentCenter.managerPool')}</span>
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {managers.map((m) => (
            <AgentCard
              key={m.id}
              agent={m}
              resource={resources.find((r) => r.id === m.provider_resource_id)}
              assignedTask={tasks.find((t) => t.id === m.current_task_id)}
              onViewTask={(taskId) => {
                setSelectedTaskId(taskId);
                setActiveView('task-detail');
              }}
            />
          ))}
        </div>
      </div>

      {/* Coders Section */}
      <div className="space-y-3">
        <h3 className="text-xs font-mono font-semibold text-slate-400 uppercase tracking-wider flex items-center space-x-2">
          <Terminal className="w-4 h-4 text-forge-cyan" />
          <span>{t('agentCenter.coderPool')}</span>
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {coders.map((c) => (
            <AgentCard
              key={c.id}
              agent={c}
              resource={resources.find((r) => r.id === c.provider_resource_id)}
              assignedTask={tasks.find((t) => t.id === c.current_task_id)}
              onViewTask={(taskId) => {
                setSelectedTaskId(taskId);
                setActiveView('task-detail');
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
};
