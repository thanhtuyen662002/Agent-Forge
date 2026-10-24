// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, listener: (event: unknown, payload: unknown) => Promise<unknown>) => { handlers.set(channel, listener); } },
  dialog: { showOpenDialog: vi.fn() },
  app: { getPath: vi.fn() },
}));

import { registerIpcHandlers } from '../src/electron/ipcHandlers';
import { OrchestratorProvider, useOrchestrator } from '../src/ui/context/OrchestratorContext';
import { I18nProvider } from '../src/ui/context/I18nContext';
import { ProjectsView } from '../src/ui/views/ProjectsView';
import { canApprovePlan, contractFromForm, emptyContractForm, formFromContract, linesToItems } from '../src/ui/projectContractForm';
import { getTranslation } from '../src/shared/i18n';

const en = (key: string, params?: Record<string, string | number>) => getTranslation('en-US', key, params);
const now = '2026-10-24T00:00:00Z';

describe('plain-text plan conversion', () => {
  it('turns one item per line into lists and strips common markers', () => {
    expect(linesToItems('- first\n* second\n\n• third\n1. fourth\n 2) fifth \n   ')).toEqual(['first', 'second', 'third', 'fourth', 'fifth']);
    const form = { ...emptyContractForm(), goal: '  Ship offline orders ', acceptance_criteria: 'Works offline\nSyncs later', non_goals: '- Mobile' };
    expect(contractFromForm(form)).toEqual({
      goal: 'Ship offline orders', acceptance_criteria: ['Works offline', 'Syncs later'], definition_of_done: [],
      testing_requirements: [], technical_constraints: [], architecture_constraints: [], security_requirements: [],
      non_goals: ['Mobile'], owner_policies: [],
    });
  });

  it('round-trips a stored contract back into the form', () => {
    const contract = contractFromForm({ ...emptyContractForm(), goal: 'G', business_context: 'Why', owner_policies: 'Ask first\nSmall PRs' });
    expect(contract.business_context).toBe('Why');
    expect(formFromContract(contract)).toMatchObject({ goal: 'G', business_context: 'Why', owner_policies: 'Ask first\nSmall PRs' });
    expect(formFromContract(null)).toEqual(emptyContractForm());
  });

  it('only allows approval from DRAFT/PLANNING with a goal', () => {
    expect(canApprovePlan('PLANNING', { goal: 'G' } as any)).toBe(true);
    expect(canApprovePlan('DRAFT', { goal: '  ' } as any)).toBe(false);
    expect(canApprovePlan('READY', { goal: 'G' } as any)).toBe(false);
    expect(canApprovePlan('PLANNING', null)).toBe(false);
  });
});

describe('project import and transition IPC acknowledgements', () => {
  const trusted = { senderFrame: { url: 'http://localhost:5173/projects' } };
  const projectService = { importContract: vi.fn(), transitionStatus: vi.fn() };
  const repo = {
    isProjectTrashed: vi.fn(() => false),
    isTaskTrashed: vi.fn(() => false),
    getProjectMetadata: vi.fn((id: string) => ({ id, name: 'P', status: 'READY' })),
  };

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    registerIpcHandlers(repo as any, projectService as any, {} as any, {} as any, {} as any, undefined, undefined, undefined, undefined, {} as any);
  });

  it('wraps a successful import and reports a missing project with a typed code', async () => {
    projectService.importContract.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const payload = { projectId: 'P1', contract: { goal: 'Ship it' } };
    await expect(handlers.get('project:importContract')!(trusted, payload)).resolves.toEqual({ success: true, project: { id: 'P1', name: 'P', status: 'READY' } });
    await expect(handlers.get('project:importContract')!(trusted, payload)).resolves.toMatchObject({ success: false, errorCode: 'PROJECT_NOT_FOUND' });
  });

  it('wraps transitions and turns state-machine and latch rejections into typed failures', async () => {
    projectService.transitionStatus
      .mockReturnValueOnce('READY')
      .mockImplementationOnce(() => { throw new Error('[ProjectStateMachine] Invalid transition: Cannot apply trigger "PLAN_APPROVED" from state "RUNNING".'); })
      .mockImplementationOnce(() => { throw new Error('PROJECT_EMERGENCY_STOP_LATCHED: Project "P1" is emergency-stopped.'); });
    const payload = { projectId: 'P1', trigger: 'PLAN_APPROVED' };
    await expect(handlers.get('project:transition')!(trusted, payload)).resolves.toMatchObject({ success: true, status: 'READY' });
    await expect(handlers.get('project:transition')!(trusted, payload)).resolves.toMatchObject({ success: false, errorCode: 'INVALID_TRANSITION' });
    await expect(handlers.get('project:transition')!(trusted, payload)).resolves.toMatchObject({ success: false, errorCode: 'EMERGENCY_STOP_LATCHED' });
  });
});

describe('guided plan form and approval through the real view', () => {
  let root: Root;
  let container: HTMLDivElement;
  let api: any;
  let context: ReturnType<typeof useOrchestrator>;
  let stored: any;
  function Probe() { context = useOrchestrator(); return null; }

  const setText = (element: HTMLTextAreaElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const button = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) as HTMLButtonElement;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    stored = {
      id: 'P1', name: 'Orders', description: null, status: 'DRAFT', repository_path: '/repo', default_branch: 'main',
      contract: null, created_at: now, updated_at: now, started_at: null, completed_at: null,
    };
    api = {
      getProjects: vi.fn(async () => [structuredClone(stored)]),
      getTasks: vi.fn().mockResolvedValue([]), getEvents: vi.fn().mockResolvedValue([]), getEvidence: vi.fn().mockResolvedValue([]),
      getProviderResources: vi.fn().mockResolvedValue([]), getAgents: vi.fn().mockResolvedValue([]),
      getTrash: vi.fn().mockResolvedValue({ projects: [], tasks: [] }),
      importContract: vi.fn(async ({ contract }: any) => {
        stored = { ...stored, contract, status: 'PLANNING', updated_at: '2026-10-24T00:01:00Z' };
        return { success: true, project: stored };
      }),
      transitionProject: vi.fn(async ({ trigger }: any) => {
        stored = { ...stored, status: 'READY', updated_at: '2026-10-24T00:02:00Z' };
        return { success: true, status: 'READY', project: stored, trigger };
      }),
    };
    (window as any).orchestrator = api;
    window.localStorage.setItem('agentforge_locale', 'en-US');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    document.body.replaceChildren();
    delete (window as any).orchestrator;
    window.localStorage.clear();
  });

  it('saves a plan written as plain lines, then approves it to READY', async () => {
    await act(async () => { root.render(<I18nProvider><OrchestratorProvider><Probe /><ProjectsView /></OrchestratorProvider></I18nProvider>); });
    expect(container.textContent).toContain(en('projectPlan.approval.needsPlan'));
    expect(button(en('projectPlan.save')).disabled).toBe(true);

    await act(async () => {
      setText(container.querySelector('#plan-goal')!, 'Track orders offline');
      setText(container.querySelector('#plan-acceptance_criteria')!, '- Create orders offline\n- Sync later');
    });
    await act(async () => { button(en('projectPlan.save')).click(); });
    expect(api.importContract).toHaveBeenCalledWith({
      projectId: 'P1',
      contract: expect.objectContaining({ goal: 'Track orders offline', acceptance_criteria: ['Create orders offline', 'Sync later'], non_goals: [] }),
    });
    expect(container.querySelector('[role="status"]')?.textContent).toContain(en('projectPlan.saved'));
    expect(context.activeProject?.status).toBe('PLANNING');
    expect((container.querySelector('#plan-acceptance_criteria') as HTMLTextAreaElement).value).toBe('Create orders offline\nSync later');

    await act(async () => { button(en('projectPlan.approval.approve')).click(); });
    expect(api.transitionProject).toHaveBeenCalledWith({ projectId: 'P1', trigger: 'PLAN_APPROVED' });
    expect(context.activeProject?.status).toBe('READY');
    expect(container.textContent).toContain(en('projectPlan.approval.approved'));
    expect(button(en('projectPlan.approval.approve'))).toBeUndefined();
  });

  it('keeps JSON as an advanced option and rejects malformed JSON without calling the backend', async () => {
    await act(async () => { root.render(<I18nProvider><OrchestratorProvider><ProjectsView /></OrchestratorProvider></I18nProvider>); });
    expect(container.querySelector('details')?.open).toBe(false);
    await act(async () => { setText(container.querySelector('#plan-json')!, '{ "goal": '); });
    await act(async () => { button(en('projectPlan.saveJson')).click(); });
    expect(api.importContract).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(en('projectPlan.jsonInvalid'));

    await act(async () => { setText(container.querySelector('#plan-json')!, '{ "goal": "From JSON", "non_goals": ["x"] }'); });
    await act(async () => { button(en('projectPlan.saveJson')).click(); });
    expect(api.importContract).toHaveBeenCalledWith({ projectId: 'P1', contract: { goal: 'From JSON', non_goals: ['x'] } });
  });

  it('reports a rejected approval instead of claiming success', async () => {
    stored = { ...stored, status: 'PLANNING', contract: { goal: 'G' } };
    api.transitionProject.mockResolvedValueOnce({ success: false, errorCode: 'INVALID_TRANSITION', error: 'x' });
    await act(async () => { root.render(<I18nProvider><OrchestratorProvider><ProjectsView /></OrchestratorProvider></I18nProvider>); });
    expect((container.querySelector('#plan-goal') as HTMLTextAreaElement).value).toBe('G');
    await act(async () => { button(en('projectPlan.approval.approve')).click(); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(en('actions.failed'));
    expect(container.textContent).not.toContain(en('projectPlan.approval.approved'));
  });
});
