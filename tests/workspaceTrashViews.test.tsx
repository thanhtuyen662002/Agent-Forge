// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrchestratorProvider, useOrchestrator } from '../src/ui/context/OrchestratorContext';
import { I18nProvider } from '../src/ui/context/I18nContext';
import { ProjectsView } from '../src/ui/views/ProjectsView';
import { TaskBoardView } from '../src/ui/views/TaskBoardView';
import { matchesSearch, normalizeTrashListing, normalizeTrashReply } from '../src/ui/workspaceTrash';
import { getTranslation } from '../src/shared/i18n';

const now = '2026-10-24T00:00:00Z';
const project = (id: string, name: string) => ({
  id, name, description: `About ${name}`, status: 'PLANNING', repository_path: `/repo/${id}`, default_branch: 'main',
  contract: null, created_at: now, updated_at: now, started_at: null, completed_at: null,
});
const task = (id: string, title: string, state: string) => ({
  id, project_id: 'P1', title, description: null, state, priority: 'LOW', risk: 'LOW', revision_count: 0, max_revisions: 3,
  progress_cache_percent: 0, acceptance_criteria: [], constraints: [], assigned_agent_id: null,
});

let root: Root;
let container: HTMLDivElement;
let api: any;
let context: ReturnType<typeof useOrchestrator>;
let activeProjects: any[];
let activeTasks: any[];
let trash: { projects: any[]; tasks: any[] };

function Probe() { context = useOrchestrator(); return null; }
const en = (key: string, params?: Record<string, string | number>) => getTranslation('en-US', key, params);

async function render(view: React.ReactNode) {
  window.localStorage.setItem('agentforge_locale', 'en-US');
  await act(async () => {
    root.render(<I18nProvider><OrchestratorProvider><Probe />{view}</OrchestratorProvider></I18nProvider>);
  });
}

function buttons(label: string): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button')).filter((node) => node.textContent?.trim() === label) as HTMLButtonElement[];
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  activeProjects = [project('P1', 'Lập trình Desktop'), project('P2', 'Website')];
  activeTasks = [task('T1', 'Write docs', 'DONE'), task('T2', 'Build parser', 'CODING')];
  trash = { projects: [], tasks: [] };
  api = {
    getProjects: vi.fn(async () => activeProjects),
    getTasks: vi.fn(async () => activeTasks),
    getEvents: vi.fn().mockResolvedValue([]),
    getEvidence: vi.fn().mockResolvedValue([]),
    getProviderResources: vi.fn().mockResolvedValue([]),
    getAgents: vi.fn().mockResolvedValue([]),
    getTrash: vi.fn(async () => structuredClone(trash)),
    trashProject: vi.fn(async (projectId: string) => {
      const item = activeProjects.find((p) => p.id === projectId);
      activeProjects = activeProjects.filter((p) => p.id !== projectId);
      trash.projects.push({ id: item.id, name: item.name, status: item.status, trashedAt: now });
      return { success: true, entityType: 'PROJECT', entityId: projectId, invalidatedAuthorizations: 2 };
    }),
    restoreProject: vi.fn(async (projectId: string) => {
      const item = trash.projects.find((p) => p.id === projectId);
      trash.projects = trash.projects.filter((p) => p.id !== projectId);
      activeProjects.push(project(item.id, item.name));
      return { success: true, entityType: 'PROJECT', entityId: projectId, invalidatedAuthorizations: 0 };
    }),
    trashTask: vi.fn(async (taskId: string) => {
      const item = activeTasks.find((t) => t.id === taskId);
      activeTasks = activeTasks.filter((t) => t.id !== taskId);
      trash.tasks.push({ id: item.id, title: item.title, state: item.state, projectId: 'P1', projectName: 'Lập trình Desktop', trashedAt: now });
      return { success: true, entityType: 'TASK', entityId: taskId, invalidatedAuthorizations: 0 };
    }),
    restoreTask: vi.fn(),
  };
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

describe('project list search and trash', () => {
  it('filters projects accent-insensitively', async () => {
    await render(<ProjectsView />);
    const list = () => Array.from(container.querySelectorAll('ul[aria-label] li'), (li) => li.querySelector('[title]')?.textContent);
    expect(list()).toEqual(['Lập trình Desktop', 'Website']);
    await act(async () => { type(container.querySelector<HTMLInputElement>('input[type="search"]')!, 'lap trinh'); });
    expect(list()).toEqual(['Lập trình Desktop']);
    await act(async () => { type(container.querySelector<HTMLInputElement>('input[type="search"]')!, 'zzz'); });
    expect(container.textContent).toContain(en('trash.noMatches'));
  });

  it('moves the selected project to the trash after confirmation, reconciles selection, and restores it', async () => {
    await render(<ProjectsView />);
    expect(context.activeProject?.id).toBe('P1');
    await act(async () => { buttons(en('trash.moveToTrash'))[0].click(); });
    expect(container.querySelector('#trash-confirm-title')?.textContent).toBe(en('trash.confirm.projectTitle', { name: 'Lập trình Desktop' }));
    await act(async () => {
      container.querySelector('[role="dialog"]')!.querySelectorAll('button')[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(api.trashProject).toHaveBeenCalledWith('P1');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain(en('trash.results.invalidated', { count: 2 }));
    expect(context.projects.map((p) => p.id)).toEqual(['P2']);
    expect(context.activeProject?.id).toBe('P2');

    await act(async () => { buttons(`${en('trash.showTrash')} (1)`)[0].click(); });
    await act(async () => { buttons(en('trash.restore'))[0].click(); });
    expect(api.restoreProject).toHaveBeenCalledWith('P1');
    expect(context.projects.map((p) => p.id).sort()).toEqual(['P1', 'P2']);
  });

  it('keeps the dialog open and lists blockers when the backend refuses', async () => {
    api.trashProject.mockResolvedValueOnce({
      success: false, errorCode: 'HAS_ACTIVE_WORK', error: 'x',
      blockers: [{ code: 'TASK_ACTIVE_STATE', reference: 'CODING', taskId: 'T2' }],
    });
    await render(<ProjectsView />);
    await act(async () => { buttons(en('trash.moveToTrash'))[0].click(); });
    await act(async () => {
      container.querySelector('[role="dialog"]')!.querySelectorAll('button')[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const alert = container.querySelector('[role="dialog"] [role="alert"]')!;
    expect(alert.textContent).toContain(en('trash.blockers.TASK_ACTIVE_STATE', { task: 'T2', reference: 'CODING' }));
    expect(context.projects.map((p) => p.id)).toEqual(['P1', 'P2']);
  });
});

describe('task board search and trash', () => {
  it('offers trash only for trashable states and filters by search', async () => {
    await render(<TaskBoardView />);
    const trashButtons = Array.from(container.querySelectorAll('button[aria-label]')).map((b) => b.getAttribute('aria-label'));
    expect(trashButtons).toEqual([`${en('trash.moveToTrash')}: Write docs`]);
    await act(async () => { type(container.querySelector<HTMLInputElement>('input[type="search"]')!, 'parser'); });
    expect(container.textContent).toContain('Build parser');
    expect(container.textContent).not.toContain('Write docs');
  });

  it('trashes a finished task and shows it in the project trash', async () => {
    await render(<TaskBoardView />);
    await act(async () => { (container.querySelector('button[aria-label]') as HTMLButtonElement).click(); });
    await act(async () => {
      container.querySelector('[role="dialog"]')!.querySelectorAll('button')[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(api.trashTask).toHaveBeenCalledWith('T1');
    expect(context.tasks.map((t) => t.id)).toEqual(['T2']);
    await act(async () => { buttons(`${en('trash.showTrash')} (1)`)[0].click(); });
    expect(container.textContent).toContain(en('trash.inProject', { name: 'Lập trình Desktop' }));
  });
});

describe('trash reply normalization', () => {
  it('fails closed on malformed or mismatched replies', () => {
    expect(normalizeTrashReply({ success: true, entityType: 'TASK', entityId: 'other', invalidatedAuthorizations: 0 }, 'TASK', 'T1'))
      .toMatchObject({ success: false, code: 'INVALID_RESPONSE' });
    expect(normalizeTrashReply({ success: true, entityType: 'TASK', entityId: 'T1', invalidatedAuthorizations: -1 }, 'TASK', 'T1'))
      .toMatchObject({ success: false, code: 'INVALID_RESPONSE' });
    expect(normalizeTrashReply({ success: false, errorCode: 'ENTITY_GONE' }, 'TASK', 'T1')).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(normalizeTrashReply({ success: false, errorCode: 'HAS_ACTIVE_WORK', blockers: [{ code: 'X', reference: 'y' }] }, 'TASK', 'T1'))
      .toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(normalizeTrashReply({ success: true, entityType: 'TASK', entityId: 'T1', invalidatedAuthorizations: 3 }, 'TASK', 'T1'))
      .toEqual({ success: true, entityType: 'TASK', entityId: 'T1', invalidatedAuthorizations: 3 });
    expect(normalizeTrashListing({ projects: [{}], tasks: [] })).toBeNull();
    expect(normalizeTrashListing(null)).toBeNull();
    expect(matchesSearch('ĐỒ ÁN', 'do an tot nghiep')).toBe(true);
    expect(matchesSearch('  ', 'anything')).toBe(true);
  });
});
