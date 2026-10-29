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
import { I18nProvider } from '../src/ui/context/I18nContext';
import { TaskContextEditor } from '../src/ui/components/TaskContextEditor';
import { getTranslation } from '../src/shared/i18n';

const trusted = { senderFrame: { url: 'http://localhost:5173/task' } };

/** #261: the owner can view, change and clear a task's coder context. */
describe('task context path IPC', () => {
  let root: string;
  const stored = new Map<string, string[]>();
  const trashed = new Set<string>();
  const repo = {
    getProject: (id: string) => (id === 'P1' || id === 'P2' ? { id, repository_path: root } : null),
    getTask: (id: string) => (id === 'T1' ? { id, project_id: 'P1' } : null),
    isProjectTrashed: () => false,
    isTaskTrashed: (id: string) => trashed.has(id),
    getTaskContextPaths: (projectId: string, taskId: string) => stored.get(`${projectId}/${taskId}`) ?? [],
    setTaskContextPaths: vi.fn((projectId: string, taskId: string, paths: string[]) => { stored.set(`${projectId}/${taskId}`, paths); }),
  };
  const call = (channel: string, payload: unknown) => handlers.get(channel)!(trusted, payload);

  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-context-ipc-')));
    fs.mkdirSync(path.join(root, 'src', 'feature'), { recursive: true });
    fs.writeFileSync(path.join(root, 'README.md'), '# x\n');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
    stored.clear();
    trashed.clear();
    repo.setTaskContextPaths.mockClear();
    handlers.clear();
    registerIpcHandlers(repo as any, {} as any, {} as any, {} as any, {} as any, undefined, undefined, undefined, undefined, {} as any);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('stores validated paths, folds duplicates and blank lines, and clears to the default', async () => {
    await expect(call('task:setContextPaths', { projectId: 'P1', taskId: 'T1', paths: [' src/feature ', '', 'README.md', 'src/feature'] }))
      .resolves.toEqual({ success: true, paths: ['src/feature', 'README.md'] });
    await expect(call('task:getContextPaths', { projectId: 'P1', taskId: 'T1' })).resolves.toEqual({ success: true, paths: ['src/feature', 'README.md'] });
    await expect(call('task:setContextPaths', { projectId: 'P1', taskId: 'T1', paths: [] })).resolves.toEqual({ success: true, paths: [] });
    await expect(call('task:getContextPaths', { projectId: 'P1', taskId: 'T1' })).resolves.toEqual({ success: true, paths: [] });
  });

  it.each([
    ['../outside', 'CONTEXT_PATH_INVALID'],
    ['src/missing.ts', 'CONTEXT_PATH_MISSING'],
    ['.env', 'CONTEXT_PATH_DENIED'],
  ])('rejects %s with %s and stores nothing', async (candidate, errorCode) => {
    await expect(call('task:setContextPaths', { projectId: 'P1', taskId: 'T1', paths: ['README.md', candidate] }))
      .resolves.toMatchObject({ success: false, errorCode });
    expect(repo.setTaskContextPaths).not.toHaveBeenCalled();
  });

  it('keeps a stored path the coder will create, but still refuses a newly typed missing one (#330)', async () => {
    stored.set('P1/T1', ['README.md', 'src/feature/new.ts']); // Planned: the coder creates it.
    await expect(call('task:setContextPaths', { projectId: 'P1', taskId: 'T1', paths: ['README.md', 'src/feature/new.ts', 'src/feature'] }))
      .resolves.toEqual({ success: true, paths: ['README.md', 'src/feature/new.ts', 'src/feature'] });
    await expect(call('task:setContextPaths', { projectId: 'P1', taskId: 'T1', paths: ['src/feature/new.ts', 'src/typo.ts'] }))
      .resolves.toMatchObject({ success: false, errorCode: 'CONTEXT_PATH_MISSING', path: 'src/typo.ts' });
  });

  it('refuses a task from another project, a trashed task and malformed input', async () => {
    await expect(call('task:setContextPaths', { projectId: 'P2', taskId: 'T1', paths: ['README.md'] })).resolves.toMatchObject({ success: false, errorCode: 'TASK_NOT_FOUND' });
    await expect(call('task:getContextPaths', { projectId: 'P2', taskId: 'T1' })).resolves.toMatchObject({ success: false, errorCode: 'TASK_NOT_FOUND' });
    await expect(call('task:setContextPaths', { projectId: 'P1', taskId: 'T1', paths: 'README.md' })).resolves.toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
    trashed.add('T1');
    await expect(call('task:setContextPaths', { projectId: 'P1', taskId: 'T1', paths: ['README.md'] })).resolves.toMatchObject({ success: false, errorCode: 'ENTITY_IN_TRASH' });
    expect(repo.setTaskContextPaths).not.toHaveBeenCalled();
  });
});

describe('task context editor', () => {
  let root: Root;
  let container: HTMLDivElement;
  let api: any;
  const vi_ = (key: string, params?: Record<string, string | number>) => getTranslation('vi-VN', key, params);

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    api = {
      getTaskContextPaths: vi.fn().mockResolvedValue({ success: true, paths: [] }),
      setTaskContextPaths: vi.fn(),
    };
    (window as any).orchestrator = api;
    window.localStorage.setItem('agentforge_locale', 'vi-VN');
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

  const type = async (value: string) => {
    const textarea = container.querySelector('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(textarea, value); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
  };
  const saveButton = () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === vi_('taskDetail.contextSave'))!;

  it('shows the default, saves one path per line and reports success', async () => {
    api.setTaskContextPaths.mockResolvedValue({ success: true, paths: ['src/feature', 'README.md'] });
    await act(async () => { root.render(<I18nProvider><TaskContextEditor projectId="P1" taskId="T1" /></I18nProvider>); });
    expect(api.getTaskContextPaths).toHaveBeenCalledWith('P1', 'T1');
    expect(container.textContent).toContain(vi_('taskDetail.contextDefault'));
    expect(saveButton().disabled).toBe(true); // Nothing changed yet.

    await type('src/feature\n\n  README.md  \n');
    await act(async () => { saveButton().click(); });
    expect(api.setTaskContextPaths).toHaveBeenCalledWith('P1', 'T1', ['src/feature', 'README.md']);
    expect(container.querySelector('[role="status"]')!.textContent).toBe(vi_('taskDetail.contextSaved'));
    expect(container.textContent).toContain(vi_('taskDetail.contextCount', { count: 2 }));
  });

  it('shows the rejection reason with the offending path', async () => {
    api.setTaskContextPaths.mockResolvedValue({ success: false, errorCode: 'CONTEXT_PATH_DENIED', path: '.env' });
    await act(async () => { root.render(<I18nProvider><TaskContextEditor projectId="P1" taskId="T1" /></I18nProvider>); });
    await type('.env');
    await act(async () => { saveButton().click(); });
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(`${vi_('taskDetail.contextError.CONTEXT_PATH_DENIED')} (.env)`);
  });
});
