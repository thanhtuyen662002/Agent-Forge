// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrchestratorProvider } from '../src/ui/context/OrchestratorContext';
import { I18nProvider } from '../src/ui/context/I18nContext';
import { AgentCenterView } from '../src/ui/views/AgentCenterView';
import { normalizeAgentMutationReply, normalizeAgentPurgeReply, normalizeAgentRosterReply } from '../src/ui/agentRoster';
import { getTranslation } from '../src/shared/i18n';
import type { SupportedLocale } from '../src/shared/i18n/types';

const now = '2026-10-24T00:00:00Z';
const agent = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, display_name: `Agent ${id}`, role: 'CODER', status: 'IDLE', provider_resource_id: `res-${id}`,
  current_task_id: null, last_seen_at: now, agent_profile_id: null, removed_at: null, ...overrides,
});
const entry = (id: string, overrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  agent: agent(id, overrides),
  roleProfile: null, agentProfile: null, provider: { id: 'prov-manual-bridge', name: 'Owner Manual Bridge', adapterType: 'MANUAL_BRIDGE' },
  account: null, resource: { id: `res-${id}`, modelName: 'model-x', enabled: true, capabilities: ['CODING'], healthStatus: 'UNKNOWN' },
  workerSlots: [], connection: 'MANUAL_BRIDGE', blockers: [], ...extra,
});

let root: Root;
let container: HTMLDivElement;
let api: any;
let roster: any[];

const text = (locale: SupportedLocale, key: string, params?: Record<string, string | number>) => getTranslation(locale, key, params);

async function render(locale: SupportedLocale = 'en-US') {
  window.localStorage.setItem('agentforge_locale', locale);
  await act(async () => {
    root.render(<I18nProvider><OrchestratorProvider><AgentCenterView /></OrchestratorProvider></I18nProvider>);
  });
}

function buttonByText(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.trim() === label);
  if (!button) throw new Error(`button not found: ${label}`);
  return button as HTMLButtonElement;
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  roster = [entry('a'), entry('busy', { status: 'BUSY' }, { blockers: [{ code: 'AGENT_BUSY', reference: 'busy' }] })];
  api = {
    getProjects: vi.fn().mockResolvedValue([]),
    getProviderResources: vi.fn().mockResolvedValue([]),
    getAgents: vi.fn(async () => roster.map((item) => item.agent)),
    getAgentRoster: vi.fn(async ({ includeRemoved }: { includeRemoved: boolean }) =>
      roster.filter((item) => includeRemoved || !item.agent.removed_at)),
    createAgent: vi.fn(async (input: any) => {
      const created = entry('new', { display_name: input.displayName, role: input.role });
      roster.push(created);
      return { success: true, agent: created.agent };
    }),
    updateAgent: vi.fn(),
    removeAgent: vi.fn(async (agentId: string) => {
      const item = roster.find((candidate) => candidate.agent.id === agentId);
      item.agent = { ...item.agent, removed_at: now, status: 'OFFLINE' };
      return { success: true, agent: item.agent };
    }),
    restoreAgent: vi.fn(async (agentId: string) => {
      const item = roster.find((candidate) => candidate.agent.id === agentId);
      item.agent = { ...item.agent, removed_at: null, status: 'IDLE' };
      return { success: true, agent: item.agent };
    }),
    purgeAgent: vi.fn(async (agentId: string) => {
      roster = roster.filter((candidate) => candidate.agent.id !== agentId);
      return { success: true, agentId };
    }),
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

describe('Agent Center owner management through the real view', () => {
  it.each(['en-US', 'vi-VN'] as SupportedLocale[])('shows every role group and explains remove blockers in %s', async (locale) => {
    await render(locale);
    const headings = Array.from(container.querySelectorAll('h3'), (node) => node.textContent ?? '');
    for (const key of ['agentCenter.managerPool', 'agentCenter.coderPool', 'agentCenter.reviewerPool', 'agentCenter.toolPool']) {
      expect(headings.some((heading) => heading.includes(text(locale, key)))).toBe(true);
    }
    expect(container.textContent).toContain(text(locale, 'agentCenter.blockers.AGENT_BUSY'));
    const removeButtons = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent?.trim() === text(locale, 'agentCenter.actions.remove'));
    expect(removeButtons.map((b) => (b as HTMLButtonElement).disabled)).toEqual([false, true]);
  });

  it('creates an agent through the guided form and shows it after a durable readback', async () => {
    await render();
    await act(async () => { buttonByText('Add agent').click(); });
    setValue(container.querySelector<HTMLInputElement>('#agent-name')!, '  Reviewer One ');
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[name="agent-role"][value="REVIEWER"]')!.click();
    });
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[name="agent-connection"][value="CODEX_CLI"]')!.click();
    });
    setValue(container.querySelector<HTMLInputElement>('#agent-model')!, 'gpt-5');
    await act(async () => {});
    expect(container.querySelector('#agent-profile')).not.toBeNull();
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(api.createAgent).toHaveBeenCalledWith({
      displayName: '  Reviewer One ', role: 'REVIEWER', connection: 'CODEX_CLI', modelName: 'gpt-5', workerSlots: 1, instructions: null,
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain('Agent "  Reviewer One " was added.');
    expect(api.getAgentRoster.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the form open and reports a typed rejection without assuming success', async () => {
    api.createAgent.mockResolvedValueOnce({ success: false, errorCode: 'PROFILE_ALREADY_IN_USE', error: 'x' });
    await render('vi-VN');
    await act(async () => { buttonByText(text('vi-VN', 'agentCenter.addAgent')).click(); });
    setValue(container.querySelector<HTMLInputElement>('#agent-name')!, 'A');
    setValue(container.querySelector<HTMLInputElement>('#agent-model')!, 'm');
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(text('vi-VN', 'agentCenter.errors.PROFILE_ALREADY_IN_USE'));
  });

  it('removes after confirmation and restores from the removed list', async () => {
    await render();
    await act(async () => { buttonByText('Remove').click(); });
    expect(container.querySelector('#agent-remove-title')?.textContent).toBe('Remove Agent a?');
    await act(async () => { buttonByText('Remove agent').click(); });
    expect(api.removeAgent).toHaveBeenCalledWith('a');
    expect(container.textContent).toContain('Agent "Agent a" was removed.');
    expect(Array.from(container.querySelectorAll('h3[title]'), (node) => node.textContent)).toEqual(['Agent busy']);

    await act(async () => {
      container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    });
    expect(container.textContent).toContain('Removed');
    await act(async () => { buttonByText('Restore').click(); });
    expect(api.restoreAgent).toHaveBeenCalledWith('a');
    expect(container.textContent).toContain('Agent "Agent a" is back on the active list.');
  });

  describe('permanent delete of a removed agent (#344)', () => {
    const showRemoved = async (locale: SupportedLocale = 'en-US') => {
      roster[0].agent = { ...roster[0].agent, removed_at: now, status: 'OFFLINE' };
      await render(locale);
      await act(async () => { container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    };
    const dialogButton = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
      .find((node) => node.textContent?.trim() === label)!;
    const purgeButton = (locale: SupportedLocale = 'en-US') =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="${text(locale, 'agentCenter.actions.purge')}: Agent a"]`);

    it('is offered only for removed agents', async () => {
      await render();
      expect(purgeButton()).toBeNull();
      await act(async () => { container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
      expect(purgeButton()).toBeNull();
    });

    it.each(['en-US', 'vi-VN'] as SupportedLocale[])('deletes only after a confirmation that it cannot be undone (%s)', async (locale) => {
      await showRemoved(locale);
      await act(async () => { purgeButton(locale)!.click(); });
      expect(api.purgeAgent).not.toHaveBeenCalled();
      expect(container.querySelector('#purge-confirm-title')?.textContent).toBe(text(locale, 'agentCenter.purge.confirmTitle', { name: 'Agent a' }));
      expect(container.querySelector('#purge-confirm-body')?.textContent).toBe(text(locale, 'agentCenter.purge.confirmBody'));
      await act(async () => { dialogButton(text(locale, 'agentCenter.purge.confirm')).click(); });
      expect(api.purgeAgent).toHaveBeenCalledWith('a');
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(container.textContent).toContain(text(locale, 'agentCenter.purge.purged', { name: 'Agent a' }));
      expect(Array.from(container.querySelectorAll('h3[title]'), (node) => node.textContent)).toEqual(['Agent busy']);
    });

    it('keeps the dialog open and explains an audit-record refusal', async () => {
      api.purgeAgent.mockResolvedValueOnce({ success: false, errorCode: 'AGENT_HAS_AUDIT_LEDGER', error: 'x' });
      await showRemoved();
      await act(async () => { purgeButton()!.click(); });
      await act(async () => { dialogButton('Keep agent').click(); });
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(api.purgeAgent).not.toHaveBeenCalled();
      await act(async () => { purgeButton()!.click(); });
      await act(async () => { dialogButton(text('en-US', 'agentCenter.purge.confirm')).click(); });
      expect(container.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(text('en-US', 'agentCenter.errors.AGENT_HAS_AUDIT_LEDGER'));
      expect(roster.map((item) => item.agent.id)).toContain('a');
    });
  });
});

describe('agent reply normalization', () => {
  it('fails closed on malformed mutation and roster replies', () => {
    expect(normalizeAgentMutationReply(null)).toMatchObject({ success: false, code: 'INVALID_RESPONSE' });
    expect(normalizeAgentMutationReply({ success: true })).toMatchObject({ success: false, code: 'INVALID_RESPONSE' });
    expect(normalizeAgentMutationReply({ success: 'yes', agent: agent('a') })).toMatchObject({ success: false, code: 'INVALID_RESPONSE' });
    expect(normalizeAgentMutationReply({ success: false, errorCode: 'SOMETHING_ELSE' })).toMatchObject({ success: false, code: 'INVALID_RESPONSE' });
    expect(normalizeAgentMutationReply({ success: false, errorCode: 'AGENT_HAS_ACTIVE_WORK', blockers: [{ code: 'NOPE', reference: 'x' }] }))
      .toMatchObject({ success: false, code: 'INVALID_RESPONSE' });
    expect(normalizeAgentMutationReply({ success: false, errorCode: 'AGENT_HAS_ACTIVE_WORK', blockers: [{ code: 'AGENT_BUSY', reference: 'x' }] }))
      .toEqual({ success: false, code: 'AGENT_HAS_ACTIVE_WORK', blockers: [{ code: 'AGENT_BUSY', reference: 'x' }] });
    expect(normalizeAgentPurgeReply({ success: true, agentId: 'other' }, 'a')).toMatchObject({ success: false, code: 'INVALID_RESPONSE' });
    expect(normalizeAgentPurgeReply({ success: true, agent: agent('a') }, 'a')).toMatchObject({ success: false, code: 'INVALID_RESPONSE' });
    expect(normalizeAgentPurgeReply({ success: true, agentId: 'a' }, 'a')).toEqual({ success: true, agentId: 'a' });
    expect(normalizeAgentPurgeReply({ success: false, errorCode: 'AGENT_HAS_AUDIT_LEDGER' }, 'a'))
      .toEqual({ success: false, code: 'AGENT_HAS_AUDIT_LEDGER', blockers: [] });
    expect(normalizeAgentRosterReply({})).toBeNull();
    expect(normalizeAgentRosterReply([{ agent: agent('a'), connection: 'WEB', workerSlots: [], blockers: [] }])).toBeNull();
    expect(normalizeAgentRosterReply([entry('a')])).toHaveLength(1);
  });

  it('shows a load failure instead of an empty roster when the reply is malformed', async () => {
    api.getAgentRoster.mockResolvedValue({ not: 'a list' });
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not load the agent list.');
    expect(container.textContent).not.toContain('No agents yet.');
  });
});
