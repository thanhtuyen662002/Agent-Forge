// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrchestratorProvider, useOrchestrator } from '../src/ui/context/OrchestratorContext';
import { I18nProvider } from '../src/ui/context/I18nContext';
import { Header } from '../src/ui/components/Header';
import { DashboardView } from '../src/ui/views/DashboardView';
import { getTranslation } from '../src/shared/i18n';
import type { SupportedLocale } from '../src/shared/i18n/types';

const now = '2026-10-10T00:00:00Z';
const storedProject = (id: string) => ({
  id, name: `Stored project ${id}`, description: 'Previously created project',
  status: 'PLANNING', repository_path: '/stored/repository', default_branch: 'main',
  contract: null, created_at: now, updated_at: now, started_at: null, completed_at: null,
});
const storedTask = (projectId: string) => ({
  id: `stored-task-${projectId}`, project_id: projectId, title: 'Previously completed task',
  state: 'DONE', priority: 'LOW', risk: 'LOW', revision_count: 0, max_revisions: 3,
  progress_cache_percent: 100, acceptance_criteria: [], constraints: [], assigned_agent_id: null,
});
const defaultAgents = [
  { id: 'manager', display_name: 'Configured Manager', role: 'PRIMARY_MANAGER', status: 'ACTIVE',
    provider_resource_id: 'manager-resource', current_task_id: null, last_seen_at: now },
  { id: 'coder', display_name: 'Configured Coder', role: 'CODER', status: 'IDLE',
    provider_resource_id: 'coder-resource', current_task_id: null, last_seen_at: now },
];

let root: Root;
let container: HTMLDivElement;
let api: any;
let context: ReturnType<typeof useOrchestrator>;
function Probe() { context = useOrchestrator(); return null; }
async function render(locale: SupportedLocale) {
  window.localStorage.setItem('agentforge_locale', locale);
  await act(async () => {
    root.render(<I18nProvider><OrchestratorProvider><Probe /><Header /><DashboardView /></OrchestratorProvider></I18nProvider>);
  });
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  api = {
    getProjects: vi.fn().mockResolvedValue([]),
    getTasks: vi.fn(async (id: string) => [storedTask(id)]),
    getEvents: vi.fn().mockResolvedValue([]),
    getEvidence: vi.fn().mockResolvedValue([]),
    getProviderResources: vi.fn().mockResolvedValue([]),
    getAgents: vi.fn().mockResolvedValue(defaultAgents),
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

describe('desktop profile inventory through the real provider and DOM', () => {
  it.each(['en-US', 'vi-VN'] as SupportedLocale[])('shows an empty project profile and configured agents without fabricated work in %s', async locale => {
    await render(locale);
    expect(context.isElectron).toBe(true);
    expect(context.hasRefreshed).toBe(true);
    expect(context.projects).toEqual([]);
    expect(context.activeProject).toBeNull();
    expect(context.tasks).toEqual([]);
    expect(container.querySelector('header select')).toBeNull();
    expect(container.querySelector('header')?.textContent).toContain(getTranslation(locale, 'header.noProject'));
    expect(container.querySelector('header')?.textContent).toContain(`2 ${getTranslation(locale, 'header.agentsConfigured')}`);
    expect(container.textContent).not.toMatch(/PROJ-CORE|PROJ-DEMO|AUTH-014/);
    expect(container.querySelector('h2')?.textContent).toBe(getTranslation(locale, 'header.noProject'));
    expect(api.getTasks).not.toHaveBeenCalled();
    expect(api.getEvents).not.toHaveBeenCalled();
    expect(api.getEvidence).not.toHaveBeenCalled();
  });

  it.each(['en-US', 'vi-VN'] as SupportedLocale[])('preserves restored project and task identities without claiming execution in %s', async locale => {
    const projects = [storedProject('P1'), storedProject('P2')];
    const originalProjects = structuredClone(projects);
    api.getProjects.mockResolvedValue(projects);
    await render(locale);
    expect(context.projects).toEqual(projects);
    expect(context.activeProject?.id).toBe('P1');
    expect(context.tasks[0]).toMatchObject({ id: 'stored-task-P1', state: 'DONE' });
    const selector = container.querySelector<HTMLSelectElement>('header select')!;
    expect(Array.from(selector.options, option => option.value)).toEqual(['P1', 'P2']);
    expect(container.querySelector('header')?.textContent).toContain(`2 ${getTranslation(locale, 'header.agentsConfigured')}`);
    expect(container.querySelector('header')?.textContent).toContain('PLANNING');
    expect(container.textContent).toContain(getTranslation(locale, 'agentCard.actions.awaitingDispatch'));
    expect(Array.from(container.querySelectorAll('h3'), node => node.textContent)).toContain(getTranslation(locale, 'dashboard.agentsTitle'));
    await act(async () => {
      selector.value = 'P2';
      selector.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => { await context.refreshData(); });
    expect(context.activeProject?.id).toBe('P2');
    expect(context.tasks[0]).toMatchObject({ id: 'stored-task-P2', state: 'DONE' });
    expect(context.projects).toEqual(originalProjects);
  });

  it('counts the configured inventory independently of agent availability statuses', async () => {
    api.getAgents.mockResolvedValue(['ACTIVE', 'BUSY', 'IDLE', 'PAUSED', 'OFFLINE'].map((status, index) => ({
      ...defaultAgents[0], id: `agent-${index}`, status,
    })));
    await render('en-US');
    expect(container.querySelector('header')?.textContent).toContain('5 Configured');
    expect(context.tasks).toEqual([]);
  });
});
