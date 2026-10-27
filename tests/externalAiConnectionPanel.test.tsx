// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/ui/context/I18nContext';
import {
  ExternalAiConnectionPanel, claudeCommand, codexConfig, codexTokenCommand, normalizeMcpReply,
} from '../src/ui/components/ExternalAiConnectionPanel';

const TOKEN = 'abcdEFGHijklMNOPqrstUVWXyz0123456789-_abcdEFG';
const settings = (overrides: Record<string, unknown> = {}) => ({
  success: true, settings: { enabled: false, running: false, url: 'http://127.0.0.1:47615/mcp', token: TOKEN, port: 47615, errorCode: null, ...overrides },
});

describe('external AI connection settings (#289)', () => {
  it('accepts only a well-formed loopback reply', () => {
    expect(normalizeMcpReply(settings())).toMatchObject({ enabled: false, url: 'http://127.0.0.1:47615/mcp' });
    expect(normalizeMcpReply(settings({ url: 'http://evil.example/mcp' }))).toBeNull();
    expect(normalizeMcpReply({ success: false })).toBeNull();
    expect(normalizeMcpReply(settings({ errorCode: '<script>' }))!.errorCode).toBeNull();
  });

  it('builds ready-made Claude Code and Codex connections', () => {
    const view = { url: 'http://127.0.0.1:47615/mcp', token: TOKEN };
    expect(claudeCommand(view)).toBe(`claude mcp add --transport http --scope user agent-forge http://127.0.0.1:47615/mcp --header "Authorization: Bearer ${TOKEN}"`);
    expect(codexConfig(view)).toContain('bearer_token_env_var = "AGENT_FORGE_MCP_TOKEN"');
    expect(codexConfig(view)).not.toContain(TOKEN);
    expect(codexTokenCommand(view)).toBe(`setx AGENT_FORGE_MCP_TOKEN "${TOKEN}"`);
  });

  describe('panel', () => {
    let container: HTMLDivElement;
    let root: Root;
    const api = {
      getMcpSettings: vi.fn(),
      setMcpEnabled: vi.fn(),
      regenerateMcpToken: vi.fn(),
    };
    beforeEach(() => {
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      (window as any).orchestrator = api;
      api.getMcpSettings.mockResolvedValue(settings());
      api.setMcpEnabled.mockResolvedValue(settings({ enabled: true, running: true }));
    });
    afterEach(() => {
      act(() => root.unmount());
      container.remove();
      delete (window as any).orchestrator;
      vi.clearAllMocks();
    });
    const render = async () => {
      await act(async () => { root.render(<I18nProvider><ExternalAiConnectionPanel /></I18nProvider>); });
    };

    it('is off until the owner enables it, then shows the connection with the token hidden', async () => {
      await render();
      const toggle = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(toggle.checked).toBe(false);
      expect(container.textContent).not.toContain('claude mcp add');

      await act(async () => { toggle.click(); });
      expect(api.setMcpEnabled).toHaveBeenCalledWith(true);
      expect(container.textContent).toContain('claude mcp add');
      expect(container.textContent).toContain('http://127.0.0.1:47615/mcp');
      expect(container.textContent).not.toContain(TOKEN); // Hidden until the owner chooses to show it.
    });

    it('reports a port conflict instead of claiming the server runs', async () => {
      api.getMcpSettings.mockResolvedValue(settings({ enabled: true, running: false, errorCode: 'PORT_IN_USE' }));
      await render();
      expect(container.querySelector('[role="status"]')!.className).toContain('text-rose-300');
    });
  });
});
