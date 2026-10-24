// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRoleEnum, TaskStateEnum } from '../src/core/types/domain';
import type { Agent, Project, ProjectContract, Task } from '../src/core/types/domain';
import { getTranslation } from '../src/shared/i18n';
import type { SupportedLocale } from '../src/shared/i18n/types';
import { getAttentionTasks, getSetupSteps, type DashboardGuideState } from '../src/ui/dashboardGuide';
import { I18nProvider } from '../src/ui/context/I18nContext';
import { OrchestratorProvider, useOrchestrator } from '../src/ui/context/OrchestratorContext';
import { DashboardView } from '../src/ui/views/DashboardView';

const now = '2026-10-24T00:00:00Z';
function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'P1', name: 'Owner project', description: 'A real saved project', status: 'PLANNING',
    repository_path: '/repository', default_branch: 'main', contract: null,
    created_at: now, updated_at: now, started_at: null, completed_at: null, ...overrides,
  };
}
function contract(goal: string): ProjectContract {
  return {
    goal, architecture_constraints: [], technical_constraints: [], security_requirements: [],
    acceptance_criteria: [], non_goals: [], definition_of_done: [], testing_requirements: [], owner_policies: [],
  };
}
function agent(role: Agent['role']): Agent {
  return {
    id: role, display_name: `Configured ${role}`, role, status: 'IDLE',
    provider_resource_id: `resource-${role}`, current_task_id: null, last_seen_at: now,
  };
}
function task(state: Task['state']): Task {
  return {
    id: `task-${state}`, project_id: 'P1', milestone_id: null, title: `Saved task ${state}`,
    description: null, state, paused_from_state: null, priority: 'MEDIUM', risk: 'LOW',
    assigned_agent_id: null, revision_count: 0, max_revisions: 3, base_sha: null, current_sha: null,
    progress_cache_percent: 0, progress_computed_at: null, acceptance_criteria: [], constraints: [],
    created_at: now, updated_at: now,
  };
}
const emptyState: DashboardGuideState = { projects: [], activeProject: null, agents: [], tasks: [] };
const attentionStates: Task['state'][] = [
  'BLOCKED', 'NEEDS_HUMAN', 'HANDOFF_REQUIRED', 'WAITING_FOR_CAPACITY',
  'WAITING_FOR_AUTHORITY', 'FAILED', 'FIX_REQUIRED',
];

describe('pure dashboard guide helpers', () => {
  it('leaves all six steps incomplete without saved setup state', () => {
    const steps = getSetupSteps(emptyState);
    expect(steps).toHaveLength(6);
    expect(steps.every(step => !step.done)).toBe(true);
  });

  it('uses saved inventory without inventing a selected project or plan', () => {
    const steps = getSetupSteps({ ...emptyState, projects: [project()], tasks: [task('CREATED')] });
    expect(steps.filter(step => step.done).map(step => step.id)).toEqual(['createProject', 'addTasks']);
  });

  it.each([
    { roles: ['PRIMARY_MANAGER', 'CODER'], done: true },
    { roles: ['BACKUP_MANAGER', 'CODER'], done: true },
    { roles: ['PRIMARY_MANAGER', 'BACKUP_MANAGER'], done: false },
    { roles: ['CODER', 'REVIEWER', 'TOOL'], done: false },
    { roles: ['PRIMARY_MANAGER', 'REVIEWER', 'TOOL'], done: false },
  ] satisfies { roles: Agent['role'][]; done: boolean }[])('requires a manager and coder for $roles', ({ roles, done }) => {
    const steps = getSetupSteps({ ...emptyState, agents: roles.map(agent) });
    expect(steps.find(step => step.id === 'addAgents')?.done).toBe(done);
  });

  it.each([
    { goal: '', done: false },
    { goal: '  \n ', done: false },
    { goal: 'Build the owner portal', done: true },
  ])('checks actual plan content: "$goal"', ({ goal, done }) => {
    const steps = getSetupSteps({ ...emptyState, activeProject: project({ contract: contract(goal) }) });
    expect(steps.find(step => step.id === 'writePlan')?.done).toBe(done);
  });

  it.each([
    { status: 'DRAFT', approved: false, started: false },
    { status: 'PLANNING', approved: false, started: false },
    { status: 'READY', approved: true, started: false },
    { status: 'RUNNING', approved: true, started: true },
    { status: 'PAUSED', approved: true, started: true },
    { status: 'BLOCKED', approved: true, started: true },
    { status: 'WAITING_FOR_CAPACITY', approved: true, started: true },
    { status: 'WAITING_FOR_OWNER', approved: true, started: true },
    { status: 'FINAL_REVIEW', approved: true, started: true },
    { status: 'COMPLETED', approved: true, started: true },
    { status: 'FAILED', approved: true, started: true },
    { status: 'CANCELLED', approved: true, started: false },
  ] satisfies { status: Project['status']; approved: boolean; started: boolean }[])(
    'distinguishes approval and starting in $status', ({ status, approved, started }) => {
    const steps = getSetupSteps({ ...emptyState, activeProject: project({ status }) });
    expect(steps.find(step => step.id === 'approvePlan')?.done).toBe(approved);
    expect(steps.find(step => step.id === 'startProject')?.done).toBe(started);
  });

  it('recognizes a cancelled project that really started without inventing a start for one cancelled earlier', () => {
    const steps = getSetupSteps({
      ...emptyState, activeProject: project({ status: 'CANCELLED', started_at: now }),
    });
    expect(steps.find(step => step.id === 'startProject')?.done).toBe(true);
  });

  it('selects exactly the seven attention states and preserves task identity and order', () => {
    const tasks = TaskStateEnum.options.map(task);
    const original = structuredClone(tasks);
    const selected = getAttentionTasks(tasks);
    expect(selected.map(item => item.state).sort()).toEqual([...attentionStates].sort());
    expect(selected).toEqual(tasks.filter(item => attentionStates.includes(item.state)));
    expect(selected.every(item => tasks.includes(item))).toBe(true);
    expect(tasks).toEqual(original);
    expect(getAttentionTasks([])).toEqual([]);
  });
});

let root: Root;
let container: HTMLDivElement;
let context: ReturnType<typeof useOrchestrator>;
let api: ReturnType<typeof mockApi>;
function mockApi() {
  return {
    getProjects: vi.fn().mockResolvedValue([]),
    getTasks: vi.fn().mockResolvedValue([]),
    getEvents: vi.fn().mockResolvedValue([]),
    getEvidence: vi.fn().mockResolvedValue([]),
    getProviderResources: vi.fn().mockResolvedValue([]),
    getAgents: vi.fn().mockResolvedValue([]),
    getTrash: vi.fn().mockResolvedValue({ projects: [], tasks: [] }),
    transitionProject: vi.fn(),
  };
}
function Probe() { context = useOrchestrator(); return null; }
async function render(locale: SupportedLocale) {
  window.localStorage.setItem('agentforge_locale', locale);
  await act(async () => {
    root.render(<I18nProvider><OrchestratorProvider><Probe /><DashboardView /></OrchestratorProvider></I18nProvider>);
  });
  expect(context.hasRefreshed).toBe(true);
}
function section(id: string): HTMLElement {
  const result = container.querySelector<HTMLElement>(`section[aria-labelledby="${id}"]`);
  expect(result).not.toBeNull();
  return result!;
}
async function click(button: HTMLButtonElement) {
  expect(button.type).toBe('button');
  expect(button.tabIndex).toBe(0);
  await act(async () => { button.focus(); button.click(); });
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  api = mockApi();
  (window as any).orchestrator = api;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  document.body.replaceChildren();
  delete (window as any).orchestrator;
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe.each(['en-US', 'vi-VN'] as SupportedLocale[])('dashboard guide through the real providers in %s', locale => {
  const t = (key: string, params?: Record<string, string | number>) => getTranslation(locale, key, params);

  it('shows unchecked setup steps and an honest attention empty state for a fresh profile', async () => {
    await render(locale);
    const setup = section('dashboard-setup-title');
    expect(setup.querySelector('h3')?.textContent).toBe(t('dashboardGuide.title'));
    expect(setup.querySelectorAll('ul > li')).toHaveLength(6);
    for (const row of setup.querySelectorAll('li')) {
      expect(row.textContent).toContain(t('dashboardGuide.notDone'));
      expect(row.querySelector('button')?.type).toBe('button');
    }
    expect(setup.textContent).not.toContain(t('dashboardGuide.setupComplete'));
    expect(section('dashboard-attention-title').textContent).toContain(t('dashboardGuide.noAttention'));
    expect(context.activeProject).toBeNull();
    expect(context.tasks).toEqual([]);
    expect(api.getTasks).not.toHaveBeenCalled();
    expect(container.textContent).not.toMatch(/PROJ-DEMO|AUTH-014/);
    expect(Array.from(container.querySelectorAll('section')).slice(0, 2)).toEqual([
      setup, section('dashboard-attention-title'),
    ]);
  });

  it('navigates every setup action to its view and leaves project execution to the header', async () => {
    await render(locale);
    const actions = [
      ['createProject', 'projects'], ['addAgents', 'agent-center'], ['writePlan', 'projects'],
      ['approvePlan', 'projects'], ['addTasks', 'task-board'], ['startProject', 'projects'],
    ];
    for (const [stepId, view] of actions) {
      await act(async () => { context.setActiveView('dashboard'); });
      const button = Array.from(section('dashboard-setup-title').querySelectorAll('button'))
        .find(item => item.textContent === t(`dashboardGuide.steps.${stepId}.action`));
      expect(button).toBeDefined();
      await click(button!);
      expect(context.activeView).toBe(view);
      expect(context.selectedTaskId).toBeNull();
    }
    expect(api.transitionProject).not.toHaveBeenCalled();
    expect(context.activeProject).toBeNull();
  });

  it('explains a blocked task and opens that exact task in task details', async () => {
    const blocked = task('BLOCKED');
    api.getProjects.mockResolvedValue([project()]);
    api.getTasks.mockResolvedValue([task('PLANNED'), blocked]);
    await render(locale);
    const attention = section('dashboard-attention-title');
    expect(attention.querySelector('h3')?.textContent).toBe(t('dashboardGuide.attentionTitle'));
    expect(attention.querySelectorAll('li')).toHaveLength(1);
    expect(attention.textContent).toContain(blocked.title);
    expect(attention.textContent).toContain(t('dashboardGuide.reasons.BLOCKED'));
    expect(attention.textContent).not.toContain(task('PLANNED').title);
    const open = attention.querySelector<HTMLButtonElement>('button')!;
    expect(open.getAttribute('aria-label')).toBe(t('dashboardGuide.openTaskLabel', { title: blocked.title }));
    await click(open);
    expect(context.selectedTaskId).toBe(blocked.id);
    expect(context.activeView).toBe('task-detail');
  });

  it('renders localized reasons and navigation for every attention state, including failures and fixes', async () => {
    api.getProjects.mockResolvedValue([project()]);
    api.getTasks.mockResolvedValue(attentionStates.map(task));
    await render(locale);
    const attention = section('dashboard-attention-title');
    const rows = Array.from(attention.querySelectorAll('li'));
    expect(rows).toHaveLength(attentionStates.length);
    for (const [index, state] of attentionStates.entries()) {
      expect(rows[index].textContent).toContain(task(state).title);
      expect(rows[index].textContent).toContain(t(`dashboardGuide.reasons.${state}`));
      expect(rows[index].textContent).not.toContain('dashboardGuide.');
      await click(rows[index].querySelector<HTMLButtonElement>('button')!);
      expect(context.selectedTaskId).toBe(task(state).id);
      expect(context.activeView).toBe('task-detail');
    }
    expect(attention.textContent).not.toContain(t('dashboardGuide.noAttention'));
  });

  it('keeps the start step incomplete for READY and collapses setup only after the project starts', async () => {
    const ready = project({ status: 'READY', contract: contract('Build the owner portal') });
    api.getProjects.mockResolvedValue([ready]);
    api.getTasks.mockResolvedValue([task('PLANNED')]);
    api.getAgents.mockResolvedValue([agent('BACKUP_MANAGER'), agent('CODER')]);
    await render(locale);
    const rows = Array.from(section('dashboard-setup-title').querySelectorAll('li'));
    expect(rows).toHaveLength(6);
    expect(rows.slice(0, 5).every(row => row.textContent?.includes(t('dashboardGuide.done')))).toBe(true);
    expect(rows[5].textContent).toContain(t('dashboardGuide.notDone'));
    expect(rows[5].textContent).toContain(t('dashboardGuide.steps.startProject.action'));
    expect(container.textContent).not.toContain(t('header.statusRunning'));
    await click(rows[5].querySelector<HTMLButtonElement>('button')!);
    expect(context.activeProject?.status).toBe('READY');
    expect(api.transitionProject).not.toHaveBeenCalled();

    api.getProjects.mockResolvedValue([{ ...ready, status: 'RUNNING', started_at: now }]);
    await act(async () => { await context.refreshData(); });
    expect(section('dashboard-setup-title').textContent).toBe(t('dashboardGuide.setupComplete'));
    expect(section('dashboard-setup-title').querySelector('ul')).toBeNull();
    expect(container.textContent).toContain(t('header.statusRunning'));
  });

  it('keeps every configured role visible through AgentCard, including reviewers and tools', async () => {
    api.getAgents.mockResolvedValue([
      ...AgentRoleEnum.options.map(agent),
      { ...agent('CODER'), id: 'removed-coder', display_name: 'Removed coder', removed_at: now },
    ]);
    await render(locale);
    for (const role of AgentRoleEnum.options) {
      const heading = Array.from(container.querySelectorAll('h3')).find(item => item.textContent === agent(role).display_name);
      expect(heading, `AgentCard for ${role}`).toBeDefined();
    }
    expect(context.agents).toHaveLength(5);
    expect(container.textContent).not.toContain('Removed coder');
  });
});
