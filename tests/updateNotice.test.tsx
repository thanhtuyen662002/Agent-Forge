// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/ui/context/I18nContext';
import { UpdateNotice, normalizeUpdateReply } from '../src/ui/components/UpdateNotice';
import { shouldCheckForUpdates } from '../src/core/services/UpdateService';

const reply = (state: string, extra: Record<string, unknown> = {}) => ({
  success: true,
  summary: { state, currentVersion: '0.1.4', updateInfo: { version: '0.1.5' }, progress: null, error: null, isPackaged: true,
    isCodeSigned: false, canInstall: false, lastCheckedAt: null, ...extra },
});

/** #298: dev-channel updates from the header with one owner click. */
describe('in-app updates', () => {
  it('checks on schedule only when no found or downloaded update could be discarded', () => {
    expect(['IDLE', 'NO_UPDATE_AVAILABLE', 'ERROR'].every(shouldCheckForUpdates)).toBe(true);
    expect(['UPDATE_AVAILABLE', 'DOWNLOADING', 'DOWNLOADED', 'INSTALLING', 'CHECKING', 'DISABLED'].some(shouldCheckForUpdates)).toBe(false);
  });

  it('accepts only a well-formed update reply', () => {
    expect(normalizeUpdateReply(reply('UPDATE_AVAILABLE'))).toMatchObject({ state: 'UPDATE_AVAILABLE', version: '0.1.5' });
    expect(normalizeUpdateReply(reply('WHATEVER'))).toBeNull();
    expect(normalizeUpdateReply(reply('UPDATE_AVAILABLE', { updateInfo: { version: '<img>' } }))!.version).toBeNull();
    expect(normalizeUpdateReply({ success: false })).toBeNull();
  });

  describe('header notice', () => {
    let container: HTMLDivElement;
    let root: Root;
    let state: ReturnType<typeof reply>;
    const api = { getUpdateState: vi.fn(), downloadUpdate: vi.fn(), installAndRestartUpdate: vi.fn() };
    beforeEach(() => {
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      (window as any).orchestrator = api;
      state = reply('NO_UPDATE_AVAILABLE');
      api.getUpdateState.mockImplementation(async () => state);
      api.downloadUpdate.mockImplementation(async () => { state = reply('DOWNLOADED', { canInstall: true }); return state; });
      api.installAndRestartUpdate.mockResolvedValue({ success: true });
    });
    afterEach(() => {
      act(() => root.unmount());
      container.remove();
      delete (window as any).orchestrator;
      vi.clearAllMocks();
    });
    const render = async () => { await act(async () => { root.render(<I18nProvider><UpdateNotice /></I18nProvider>); }); };

    it('shows nothing when the app is up to date', async () => {
      await render();
      expect(container.textContent).toBe('');
    });

    it('downloads and restarts into the update after one click', async () => {
      state = reply('UPDATE_AVAILABLE');
      await render();
      const button = container.querySelector('button')!;
      expect(button.textContent).toContain('0.1.5');
      expect(api.installAndRestartUpdate).not.toHaveBeenCalled(); // Nothing happens without the click.
      await act(async () => { button.click(); });
      await act(async () => { await Promise.resolve(); });
      expect(api.downloadUpdate).toHaveBeenCalledTimes(1);
      expect(api.installAndRestartUpdate).toHaveBeenCalledTimes(1);
    });

    it('waits, and says why, while work is running', async () => {
      state = reply('UPDATE_AVAILABLE');
      api.downloadUpdate.mockImplementation(async () => { state = reply('DOWNLOADED', { canInstall: false }); return state; });
      await render();
      await act(async () => { container.querySelector('button')!.click(); });
      expect(api.installAndRestartUpdate).not.toHaveBeenCalled();
      expect(container.querySelector('[role="status"]')!.className).toContain('text-amber-300');
    });

    it('shows download progress', async () => {
      state = reply('DOWNLOADING', { progress: { percent: 42.4 } });
      await render();
      expect(container.textContent).toContain('42%');
    });
  });
});
