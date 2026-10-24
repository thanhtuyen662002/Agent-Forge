// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
const openExternal = vi.fn(async () => {});
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, listener: (event: unknown, payload: unknown) => Promise<unknown>) => { handlers.set(channel, listener); } },
  dialog: { showOpenDialog: vi.fn() },
  app: { getPath: vi.fn() },
  shell: { openExternal: (...args: unknown[]) => openExternal(...(args as [])) },
}));

import { registerIpcHandlers } from '../src/electron/ipcHandlers';
import { I18nProvider } from '../src/ui/context/I18nContext';
import { OrchestratorProvider } from '../src/ui/context/OrchestratorContext';
import { AgentCenterView } from '../src/ui/views/AgentCenterView';
import { normalizeStartReply } from '../src/ui/accountSignIn';
import { getTranslation } from '../src/shared/i18n';

const en = (key: string, params?: Record<string, string | number>) => getTranslation('en-US', key, params);
const now = '2026-10-24T00:00:00Z';

describe('Codex sign-in IPC', () => {
  const trusted = { senderFrame: { url: 'http://localhost:5173/' } };
  const signIn = {
    startDeviceLogin: vi.fn(async () => ({ success: true, sessionId: 's1', accountId: 'a1', userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device', expiresAt: now })),
    getLoginStatus: vi.fn((id: string) => id === 's1' ? { state: 'WAITING_FOR_USER', accountId: 'a1', verificationUrl: 'https://auth.openai.com/codex/device', expiresAt: now } : null),
    cancelLogin: vi.fn(),
  };
  beforeEach(() => {
    handlers.clear();
    openExternal.mockClear();
    registerIpcHandlers({} as any, {} as any, {} as any, {} as any, {} as any, undefined, undefined, undefined, undefined, {} as any,
      undefined, { signIn: signIn as any });
  });

  it('opens only the verification page held by the main process for a live session', async () => {
    await expect(handlers.get('accounts:openCodexSignInPage')!(trusted, { sessionId: 's1' })).resolves.toEqual({ success: true });
    expect(openExternal).toHaveBeenCalledWith('https://auth.openai.com/codex/device');
    await expect(handlers.get('accounts:openCodexSignInPage')!(trusted, { sessionId: 'nope', url: 'https://evil.example' }))
      .resolves.toEqual({ success: false, errorCode: 'SESSION_NOT_FOUND' });
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('validates inputs and reports unavailable sign-in with typed codes', async () => {
    await expect(handlers.get('accounts:startCodexSignIn')!(trusted, {})).resolves.toEqual({ success: false, errorCode: 'ACCOUNT_NOT_FOUND' });
    await expect(handlers.get('accounts:codexSignInStatus')!(trusted, { sessionId: 's1' })).resolves.toMatchObject({ success: true, status: { state: 'WAITING_FOR_USER' } });
    await expect(handlers.get('accounts:cancelCodexSignIn')!(trusted, { sessionId: 's1' })).resolves.toEqual({ success: true });
    expect(signIn.cancelLogin).toHaveBeenCalledWith('s1');
    handlers.clear();
    registerIpcHandlers({} as any, {} as any, {} as any, {} as any, {} as any, undefined, undefined, undefined, undefined, {} as any);
    await expect(handlers.get('accounts:startCodexSignIn')!(trusted, { accountId: 'a1' })).resolves.toEqual({ success: false, errorCode: 'SIGN_IN_UNAVAILABLE' });
  });
});

describe('Codex sign-in from Agent Center', () => {
  let root: Root;
  let container: HTMLDivElement;
  let api: any;
  const entry = {
    agent: { id: 'a', display_name: 'Codex coder', role: 'CODER', status: 'IDLE', provider_resource_id: 'r', current_task_id: null, last_seen_at: now, agent_profile_id: 'p', removed_at: null },
    roleProfile: null, agentProfile: null, provider: { id: 'prov-codex-cli', name: 'Codex CLI', adapterType: 'LOCAL_CLI' },
    account: { id: 'acct-1', label: 'Codex coder', authMode: 'NATIVE_PROFILE', profileRef: 'native-profile://codex/x', healthStatus: 'UNKNOWN', enabled: true },
    resource: { id: 'r', modelName: 'gpt-5-codex', enabled: true, capabilities: ['CODING'], healthStatus: 'UNKNOWN' },
    workerSlots: [{ id: 's', slotIndex: 1, status: 'IDLE' }], connection: 'CODEX_CLI', blockers: [],
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    let state = 'WAITING_FOR_USER';
    api = {
      getProjects: vi.fn().mockResolvedValue([]), getProviderResources: vi.fn().mockResolvedValue([]), getAgents: vi.fn().mockResolvedValue([]),
      getAgentRoster: vi.fn(async () => [entry]),
      startCodexSignIn: vi.fn(async () => ({ success: true, sessionId: 's1', accountId: 'acct-1', userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/x', expiresAt: now })),
      getCodexSignInStatus: vi.fn(async () => ({ success: true, status: { state, accountId: 'acct-1', expiresAt: now } })),
      openCodexSignInPage: vi.fn(async () => ({ success: true })),
      cancelCodexSignIn: vi.fn(async () => ({ success: true })),
      setState: (next: string) => { state = next; },
    };
    (window as any).orchestrator = api;
    window.localStorage.setItem('agentforge_locale', 'en-US');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    vi.useRealTimers();
    document.body.replaceChildren();
    delete (window as any).orchestrator;
    window.localStorage.clear();
  });

  const button = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) as HTMLButtonElement;

  it('shows the one-time code, opens the page through the main process, and reports success', async () => {
    await act(async () => { root.render(<I18nProvider><OrchestratorProvider><AgentCenterView /></OrchestratorProvider></I18nProvider>); });
    expect(container.textContent).toContain(en('accountSignIn.needed'));
    await act(async () => { button(en('accountSignIn.button')).click(); });
    expect(api.startCodexSignIn).toHaveBeenCalledWith('acct-1');
    expect(container.textContent).toContain('ABCD-1234');
    await act(async () => { button(en('accountSignIn.openPage')).click(); });
    expect(api.openCodexSignInPage).toHaveBeenCalledWith('s1');

    api.setState('SIGNED_IN');
    await act(async () => { vi.advanceTimersByTime(2_100); });
    await act(async () => {});
    expect(container.textContent).toContain(en('accountSignIn.signedIn'));
    expect(api.getAgentRoster.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('cancels an in-progress sign-in', async () => {
    await act(async () => { root.render(<I18nProvider><OrchestratorProvider><AgentCenterView /></OrchestratorProvider></I18nProvider>); });
    await act(async () => { button(en('accountSignIn.button')).click(); });
    await act(async () => { button(en('accountSignIn.cancel')).click(); });
    expect(api.cancelCodexSignIn).toHaveBeenCalledWith('s1');
    expect(container.querySelector('#sign-in-title')).toBeNull();
  });

  it('rejects malformed start replies and non-https URLs', () => {
    expect(normalizeStartReply({ success: true, sessionId: 's', userCode: 'A', verificationUrl: 'http://x' })).toMatchObject({ state: 'START_FAILED' });
    expect(normalizeStartReply({ success: false, errorCode: 'CODEX_UNAVAILABLE' })).toMatchObject({ state: 'START_FAILED', errorCode: 'CODEX_UNAVAILABLE' });
  });
});
