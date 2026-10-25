// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, listener: (event: unknown, payload: unknown) => Promise<unknown>) => { handlers.set(channel, listener); } },
  dialog: { showOpenDialog: vi.fn() },
  app: { getPath: vi.fn() },
}));

import { registerIpcHandlers } from '../src/electron/ipcHandlers';
import { BUILT_IN_MODELS, ModelCatalogService } from '../src/core/services/ModelCatalogService';
import type { CodexQuotaSpawnOptions, CodexQuotaSpawner } from '../src/core/services/CodexQuotaClient';
import { I18nProvider } from '../src/ui/context/I18nContext';
import { ModelPicker, normalizeModelCatalog } from '../src/ui/components/ModelPicker';
import { getTranslation } from '../src/shared/i18n';
import { FakeCodexProcess, type FakeRpcMessage } from './quotaFakes';

const LIVE_PAGE = {
  data: [
    { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', description: 'Latest workhorse model.', hidden: false, isDefault: true },
    { id: 'gpt-6-astra', displayName: 'GPT-6-Astra', description: 'Frontier intelligence.', hidden: false, isDefault: false },
    { id: 'internal-preview', displayName: 'Hidden', hidden: true },
    { id: 'bad id; rm -rf', displayName: 'Bad' },
  ],
  nextCursor: null,
};

/** Fake `codex app-server` answering initialize and model/list. */
class FakeModelSpawner implements CodexQuotaSpawner {
  readonly homes: string[] = [];
  pages: unknown[] = [LIVE_PAGE];
  onList: ((message: FakeRpcMessage, child: FakeCodexProcess) => void) | null = null;
  readonly spawn = vi.fn((_executable: string, _args: string[], options: CodexQuotaSpawnOptions) => {
    this.homes.push(options.env.CODEX_HOME!);
    let page = 0;
    return new FakeCodexProcess((message, child) => {
      if (message.method === 'initialize') child.reply({ id: 1, result: { userAgent: 'fake', codexHome: options.env.CODEX_HOME, platformFamily: 'windows', platformOs: 'windows' } });
      else if (message.method === 'model/list') {
        if (this.onList) this.onList(message, child);
        else child.reply({ id: message.id, result: this.pages[page++] });
      }
    });
  });
}

describe('model catalog (#263)', () => {
  let spawner: FakeModelSpawner;
  let root: string;
  let clock: number;
  const service = (timeoutMs = 200) => new ModelCatalogService({
    spawner, resolveCodexExecutable: () => path.join(os.tmpdir(), 'fake-codex.exe'), timeoutMs, temporaryRoot: root, now: () => clock,
  });
  beforeEach(() => {
    spawner = new FakeModelSpawner();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-model-catalog-'));
    clock = 1_000;
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reads the Codex list live from a disposable home, skipping hidden and unsafe ids', async () => {
    const catalog = await service().list('CODEX_CLI');
    expect(catalog.source).toBe('LIVE');
    expect(catalog.models).toEqual([
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', description: 'Latest workhorse model.', descriptionKey: null, isDefault: true, kind: 'MODEL' },
      { id: 'gpt-6-astra', label: 'GPT-6-Astra', description: 'Frontier intelligence.', descriptionKey: null, isDefault: false, kind: 'MODEL' },
    ]);
    expect(spawner.homes).toHaveLength(1);
    expect(path.dirname(spawner.homes[0])).toBe(root); // Never the owner's or an agent's profile.
  });

  it('follows pages and caches a live list for a while', async () => {
    spawner.pages = [{ data: [LIVE_PAGE.data[0]], nextCursor: 'next' }, { data: [LIVE_PAGE.data[1]], nextCursor: null }];
    const catalogs = service();
    expect((await catalogs.list('CODEX_CLI')).models.map((entry) => entry.id)).toEqual(['gpt-6.1-sol', 'gpt-6-astra']);
    await catalogs.list('CODEX_CLI');
    expect(spawner.spawn).toHaveBeenCalledTimes(1);
    clock += 11 * 60_000;
    spawner.pages = [LIVE_PAGE];
    await catalogs.list('CODEX_CLI');
    expect(spawner.spawn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an RPC error', (message: FakeRpcMessage, child: FakeCodexProcess) => child.reply({ id: message.id, error: { code: -1, message: 'nope' } })],
    ['a malformed reply', (message: FakeRpcMessage, child: FakeCodexProcess) => child.reply({ id: message.id, result: { data: 'x' } })],
    ['no reply', () => undefined],
  ])('falls back to the built-in list on %s, without caching the failure', async (_name, onList) => {
    spawner.onList = onList;
    const catalogs = service(50);
    const catalog = await catalogs.list('CODEX_CLI');
    expect(catalog).toMatchObject({ source: 'BUILT_IN' });
    expect(catalog.models.map((entry) => entry.id)).toEqual(BUILT_IN_MODELS.CODEX_CLI.map((entry) => entry.id));
    spawner.onList = null;
    expect((await catalogs.list('CODEX_CLI')).source).toBe('LIVE');
  });

  it('falls back when no trusted Codex executable exists', async () => {
    const catalog = await new ModelCatalogService({ spawner, resolveCodexExecutable: () => null, temporaryRoot: root }).list('CODEX_CLI');
    expect(catalog.source).toBe('BUILT_IN');
    expect(spawner.spawn).not.toHaveBeenCalled();
  });

  it('offers latest-tracking aliases first for Claude Code and Gemini, and nothing for the manual bridge', async () => {
    const claude = await service().list('CLAUDE_CODE_CLI');
    expect(claude.models.filter((entry) => entry.kind === 'ALIAS').map((entry) => entry.id)).toEqual(['sonnet', 'opus', 'haiku']);
    expect(claude.models.find((entry) => entry.isDefault)!.id).toBe('sonnet');
    const gemini = await service().list('GEMINI_CLI');
    expect(gemini.models.find((entry) => entry.isDefault)!.id).toBe('auto');
    expect((await service().list('MANUAL_BRIDGE')).models).toEqual([]);
    expect(spawner.spawn).not.toHaveBeenCalled();
  });

  it('lists models over IPC for a valid connection only', async () => {
    handlers.clear();
    registerIpcHandlers({} as any, {} as any, {} as any, {} as any, {} as any, undefined, undefined, undefined, undefined, {} as any,
      undefined, { models: service() });
    const trusted = { senderFrame: { url: 'http://localhost:5173/' } };
    await expect(handlers.get('agents:listModels')!(trusted, { connection: 'GEMINI_CLI' })).resolves.toMatchObject({ success: true, catalog: { source: 'BUILT_IN' } });
    await expect(handlers.get('agents:listModels')!(trusted, { connection: 'SOMETHING' })).resolves.toEqual({ success: false, errorCode: 'INVALID_INPUT' });
  });
});

describe('model picker', () => {
  let root: Root;
  let container: HTMLDivElement;
  let api: any;
  let value: string;
  const vi_ = (key: string) => getTranslation('vi-VN', key);
  const live = { success: true, catalog: { connection: 'CODEX_CLI', source: 'LIVE', models: [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', description: 'Latest workhorse model.', descriptionKey: null, isDefault: true, kind: 'MODEL' },
    { id: 'gpt-6-astra', label: 'GPT-6-Astra', description: 'Frontier intelligence.', descriptionKey: null, isDefault: false, kind: 'MODEL' },
  ] } };

  const render = async (connection: 'CODEX_CLI' | 'MANUAL_BRIDGE' = 'CODEX_CLI') => {
    const Harness = () => {
      const [model, setModel] = React.useState(value);
      value = model;
      return <ModelPicker id="agent-model" connection={connection} value={model} onChange={setModel} inputClass="" />;
    };
    await act(async () => { root.render(<I18nProvider><Harness /></I18nProvider>); });
  };

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    api = { listAgentModels: vi.fn().mockResolvedValue(live) };
    (window as any).orchestrator = api;
    window.localStorage.setItem('agentforge_locale', 'vi-VN');
    value = '';
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

  it('starts a new agent on the CLI default and shows what the model is for', async () => {
    await render();
    expect(api.listAgentModels).toHaveBeenCalledWith('CODEX_CLI');
    const select = container.querySelector('select')!;
    expect(value).toBe('gpt-6.1-sol');
    expect(select.value).toBe('gpt-6.1-sol');
    expect(container.textContent).toContain('Latest workhorse model.');
    expect(container.textContent).toContain(vi_('agentCenter.models.sourceLive'));

    await act(async () => { select.value = 'gpt-6-astra'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(value).toBe('gpt-6-astra');
  });

  it('lets the owner type a model that is not listed', async () => {
    await render();
    const select = container.querySelector('select')!;
    await act(async () => { select.value = '__custom__'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    const input = container.querySelector('input')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, 'my-private-model'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(value).toBe('my-private-model');
    expect(container.querySelector('select')!.value).toBe('__custom__');
  });

  it('keeps an existing unlisted model as typed text, and uses a plain field for the manual bridge', async () => {
    value = 'legacy-model';
    await render();
    expect(container.querySelector('select')!.value).toBe('__custom__');
    expect(container.querySelector('input')!.value).toBe('legacy-model');

    await act(async () => { root.unmount(); });
    root = createRoot(container);
    value = '';
    await render('MANUAL_BRIDGE');
    expect(container.querySelector('select')).toBeNull();
    expect(api.listAgentModels).toHaveBeenCalledTimes(1);
  });

  it('treats a malformed catalog as unknown', () => {
    expect(normalizeModelCatalog({ success: true, catalog: { source: 'LIVE', models: [{ id: 1 }] } })).toBeNull();
    expect(normalizeModelCatalog({ success: false })).toBeNull();
  });
});
