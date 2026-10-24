import type { Agent, Project, Task, TaskState } from '../core/types/domain';

export interface DashboardGuideState {
  projects: readonly Project[];
  activeProject: Project | null;
  agents: readonly Agent[];
  tasks: readonly Task[];
}

export interface SetupStep {
  id: 'createProject' | 'addAgents' | 'writePlan' | 'approvePlan' | 'addTasks' | 'startProject';
  done: boolean;
  view: 'projects' | 'agent-center' | 'task-board';
}

export function getSetupSteps({ projects, activeProject, agents, tasks }: DashboardGuideState): SetupStep[] {
  const hasManager = agents.some(agent => agent.role === 'PRIMARY_MANAGER' || agent.role === 'BACKUP_MANAGER');
  const hasCoder = agents.some(agent => agent.role === 'CODER');
  const status = activeProject?.status;
  const hasStarted = status !== undefined && [
    'RUNNING', 'PAUSED', 'BLOCKED', 'WAITING_FOR_CAPACITY', 'WAITING_FOR_OWNER',
    'FINAL_REVIEW', 'COMPLETED', 'FAILED',
  ].includes(status);
  // Cancellation is also allowed before starting, so it needs a recorded start.
  const cancelledAfterStart = status === 'CANCELLED' && Boolean(activeProject?.started_at);

  return [
    { id: 'createProject', done: projects.length > 0, view: 'projects' },
    { id: 'addAgents', done: hasManager && hasCoder, view: 'agent-center' },
    { id: 'writePlan', done: Boolean(activeProject?.contract?.goal?.trim()), view: 'projects' },
    { id: 'approvePlan', done: Boolean(status && status !== 'DRAFT' && status !== 'PLANNING'), view: 'projects' },
    { id: 'addTasks', done: tasks.length > 0, view: 'task-board' },
    {
      id: 'startProject',
      done: hasStarted || cancelledAfterStart,
      view: 'projects',
    },
  ];
}

const ATTENTION_STATES = [
  'BLOCKED', 'NEEDS_HUMAN', 'HANDOFF_REQUIRED', 'WAITING_FOR_CAPACITY',
  'WAITING_FOR_AUTHORITY', 'FAILED', 'FIX_REQUIRED',
] as const satisfies readonly TaskState[];

export function getAttentionTasks(tasks: readonly Task[]) {
  return tasks.filter((task): task is Task & { state: typeof ATTENTION_STATES[number] } =>
    ATTENTION_STATES.some(state => state === task.state));
}
