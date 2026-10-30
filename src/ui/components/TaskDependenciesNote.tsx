import React, { useEffect, useState } from 'react';
import { GitMerge } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { useOrchestrator } from '../context/OrchestratorContext';

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The tasks this task waits for (#362): it is decided and dispatched only after
 * they are done, and integrated when automatic integration is on.
 */
export const TaskDependenciesNote: React.FC<{ projectId: string; taskId: string }> = ({ projectId, taskId }) => {
  const { t } = useI18n();
  const { tasks } = useOrchestrator();
  const api = typeof window !== 'undefined' ? (window as any).orchestrator ?? null : null;
  const [dependsOn, setDependsOn] = useState<string[] | null>(null);

  useEffect(() => {
    let active = true;
    setDependsOn(null);
    if (!api?.getTaskDependencies) return undefined;
    api.getTaskDependencies(projectId, taskId).then((reply: unknown) => {
      if (active && isRecord(reply) && reply.success === true && Array.isArray(reply.dependsOn)) {
        setDependsOn(reply.dependsOn.filter((item): item is string => typeof item === 'string'));
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [api, projectId, taskId]);

  if (dependsOn === null) return null;
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-mono uppercase tracking-wider text-slate-400 flex items-center gap-2">
        <GitMerge className="w-3.5 h-3.5 text-forge-cyan" aria-hidden="true" />
        {t('taskDetail.dependenciesTitle')}
      </h4>
      {dependsOn.length === 0 ? (
        <p className="text-xs text-slate-500">{t('taskDetail.dependenciesNone')}</p>
      ) : (
        <ul className="space-y-1">
          {dependsOn.map((id) => {
            const task = tasks.find((candidate) => candidate.id === id);
            return (
              <li key={id} className="text-xs text-slate-300 flex items-center justify-between gap-3">
                <span className="min-w-0 truncate">{task?.title ?? id}</span>
                {task && <span className="shrink-0 font-mono text-[10px] text-slate-500">{task.state}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
