// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enUS } from '../src/shared/i18n/locales/en-US';
import { viVN } from '../src/shared/i18n/locales/vi-VN';

const fixture = vi.hoisted(() => ({ context: {} as Record<string, any>, locale: 'en-US', translate: (key: string) => key }));
vi.mock('../src/ui/context/OrchestratorContext', () => ({ useOrchestrator: () => fixture.context }));
vi.mock('../src/ui/context/I18nContext', () => ({ useI18n: () => ({ t: fixture.translate }) }));
import { ProjectsView } from '../src/ui/views/ProjectsView';
let root: Root;
let container: HTMLDivElement;
let api: { selectRepositoryDirectory: ReturnType<typeof vi.fn>; bindProjectRepository: ReturnType<typeof vi.fn> };

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  fixture.locale = 'en-US';
  fixture.translate = (key: string) => {
    const dictionary: any = fixture.locale === 'vi-VN' ? viVN : enUS;
    const value = key.split('.').reduce((item: any, part) => item?.[part], dictionary);
    if (typeof value !== 'string') throw new Error('Missing translation: ' + key);
    return value;
  };
  const project = { id: 'old-project', name: 'Historical project', status: 'READY', repository_path: 'Configured project folder' };
  fixture.context = { projects: [project], activeProject: project, isElectron: true, pendingActions: [], refreshData: vi.fn().mockResolvedValue(undefined) };
  api = { selectRepositoryDirectory: vi.fn().mockResolvedValue({ success: true, selectionId: 'native-single-use-token' }),
    bindProjectRepository: vi.fn().mockResolvedValue({ success: true }) };
  (window as any).orchestrator = api;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); delete (window as any).orchestrator; });
async function render() { await act(async () => { root.render(<ProjectsView />); }); }
function button(): HTMLButtonElement { return Array.from(container.querySelectorAll('button')).find(item => item.textContent === fixture.translate('projects.repositoryBinding.button'))!; }
async function click() { await act(async () => { button().focus(); button().click(); }); }

describe('explicit historical repository confirmation', () => {
  it('uses native selection and the captured project ID, then refreshes after confirmed persistence', async () => {
    await render(); expect(container.textContent).toContain('Configured project folder');
    await click();
    expect(api.selectRepositoryDirectory).toHaveBeenCalledTimes(1);
    expect(api.bindProjectRepository).toHaveBeenCalledWith({ projectId: 'old-project', repositorySelectionId: 'native-single-use-token' });
    expect(fixture.context.refreshData).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role=status]')?.textContent).toBe(enUS.projects.repositoryBinding.success);
  });

  it('shows a localized blocked result and preserves failure instead of showing success', async () => {
    fixture.locale = 'vi-VN'; api.bindProjectRepository.mockResolvedValueOnce({ success: false, errorCode: 'REPOSITORY_ROOT_BINDING_BLOCKED' });
    await render(); await click();
    expect(container.querySelector('[role=alert]')?.textContent).toBe(viVN.projects.repositoryBinding.blocked);
    expect(container.querySelector('[role=status]')).toBeNull();
    expect(fixture.context.refreshData).not.toHaveBeenCalled();
  });

  it('never binds after dialog cancellation, alias refusal or a rejected native call', async () => {
    await render();
    api.selectRepositoryDirectory.mockResolvedValueOnce({ success: false, cancelled: true }); await click();
    expect(container.querySelector('[role=alert]')).toBeNull();
    api.selectRepositoryDirectory.mockResolvedValueOnce({ success: false, errorCode: 'REPOSITORY_ROOT_ALIAS' }); await click();
    expect(container.querySelector('[role=alert]')?.textContent).toBe(enUS.projects.createModal.repositoryErrors.alias);
    api.selectRepositoryDirectory.mockRejectedValueOnce(new Error('native request rejected')); await click();
    expect(container.querySelector('[role=alert]')?.textContent).toBe(enUS.actions.requestRejected);
    expect(api.bindProjectRepository).not.toHaveBeenCalled();
  });

  it('disables confirmation outside the desktop runtime and for a RUNNING project', async () => {
    fixture.context.isElectron = false; await render(); expect(button().disabled).toBe(true);
    fixture.context.isElectron = true; fixture.context.activeProject.status = 'RUNNING'; await render();
    expect(button().disabled).toBe(true); button().click(); expect(api.selectRepositoryDirectory).not.toHaveBeenCalled();
  });

  it('holds the pending barrier and keeps the original project if selection changes while the dialog waits', async () => {
    let release!: (value: unknown) => void;
    api.selectRepositoryDirectory.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    await render(); await act(async () => { button().click(); });
    const pending = container.querySelector<HTMLButtonElement>('button[aria-busy=true]')!;
    expect(pending.disabled).toBe(true); pending.click(); expect(api.selectRepositoryDirectory).toHaveBeenCalledTimes(1);
    fixture.context.activeProject = { id: 'new-project', name: 'Another project', status: 'READY', repository_path: 'Another configured folder' };
    await render();
    await act(async () => { release({ success: true, selectionId: 'original-token' }); });
    expect(api.bindProjectRepository).toHaveBeenCalledWith({ projectId: 'old-project', repositorySelectionId: 'original-token' });
    expect(container.querySelector('[role=status]')).toBeNull();
  });
});
