export interface ManagerProposalView {
  eventId: string;
  taskId: string;
  taskTitle: string;
  taskRevision: number;
  decision: string;
  instructions: string[];
  plannedTasks: Array<{ title: string; description: string; acceptanceCriteria: string[]; priority: string; risk: string }>;
  createdAt: string;
}

export interface ManagerPanelState {
  mode: 'AUTO' | 'APPROVE';
  proposals: ManagerProposalView[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Accepts only a well-formed reply from `automation:managerDecisions`; anything else is "unknown". */
export function normalizeManagerPanelReply(reply: unknown): ManagerPanelState | null {
  if (!isRecord(reply) || reply.success !== true || (reply.mode !== 'AUTO' && reply.mode !== 'APPROVE') || !Array.isArray(reply.proposals)) return null;
  const proposals: ManagerProposalView[] = [];
  for (const item of reply.proposals) {
    if (!isRecord(item) || typeof item.eventId !== 'string' || typeof item.taskId !== 'string' || typeof item.taskTitle !== 'string' ||
        typeof item.taskRevision !== 'number' || typeof item.decision !== 'string' || !Array.isArray(item.instructions)) return null;
    proposals.push({
      eventId: item.eventId, taskId: item.taskId, taskTitle: item.taskTitle, taskRevision: item.taskRevision, decision: item.decision,
      instructions: item.instructions.filter((line): line is string => typeof line === 'string'),
      plannedTasks: Array.isArray(item.plannedTasks) ? item.plannedTasks.filter(isRecord).map((planned) => ({
        title: String(planned.title ?? ''), description: String(planned.description ?? ''),
        acceptanceCriteria: Array.isArray(planned.acceptanceCriteria) ? planned.acceptanceCriteria.filter((line): line is string => typeof line === 'string') : [],
        priority: String(planned.priority ?? ''), risk: String(planned.risk ?? ''),
      })) : [],
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
    });
  }
  return { mode: reply.mode, proposals };
}
