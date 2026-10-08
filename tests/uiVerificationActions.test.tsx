// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrchestratorProvider, useOrchestrator } from '../src/ui/context/OrchestratorContext';
import { I18nProvider, useI18n } from '../src/ui/context/I18nContext';
import { TaskDetailView } from '../src/ui/views/TaskDetailView';
import { EmergencyStopModal } from '../src/ui/components/EmergencyStopModal';
import { Header } from '../src/ui/components/Header';
import { getTranslation } from '../src/shared/i18n';
import type { SupportedLocale } from '../src/shared/i18n/types';

const project = (id: string) => ({ id, name: `Project ${id}`, status: 'RUNNING', repository_path: '/synthetic', default_branch: 'main' });
const task = (id: string, projectId: string) => ({ id, project_id: projectId, title: `Task ${id}`, state: 'VALIDATING',
  priority: 'HIGH', risk: 'MEDIUM', acceptance_criteria: [], constraints: [], progress_cache_percent: 50,
  revision_count: 2, max_revisions: 3, ownership_epoch: 4, base_sha: 'a'.repeat(40), current_sha: 'a'.repeat(40) });
const testRun = (taskId: string) => ({ id: 'RUN', task_id: taskId, command: 'synthetic-approved-command', passed_count: 12,
  failed_count: 0, skipped_count: 1, duration_ms: 27, exit_code: 0, created_at: '2026-10-08T00:00:00Z', evidence_id: 'EVIDENCE' });
const verification = (taskId: string, binding: any) => ({ success: true, taskId, executionId: binding.executionId,
  testRun: testRun(taskId), finalTaskState: 'VALIDATED' });
const stopped = { processesTerminated: 2, tasksPaused: ['A'], projectsPaused: ['P'], timestamp: '2026-10-08T00:00:00Z',
  unprovenProcesses: 0, allTerminatedProven: true, stopEpochs: { P: 2 } };

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let context: ReturnType<typeof useOrchestrator>;
let i18n: ReturnType<typeof useI18n>;
let api: any;
let root: Root;
let container: HTMLDivElement;
function Probe() { context = useOrchestrator(); i18n = useI18n(); return null; }
function Application() {
  return <I18nProvider><OrchestratorProvider><Probe /><Header /><TaskDetailView /><EmergencyStopModal /></OrchestratorProvider></I18nProvider>;
}
async function render() { await act(async () => { root.render(<Application />); }); }
async function click(element: HTMLElement) { await act(async () => { element.focus(); element.click(); }); }
function button(key: string) {
  const label = i18n.t(key).toUpperCase();
  const element = Array.from(container.querySelectorAll('button')).find(item => item.textContent?.toUpperCase().includes(label));
  expect(element, key).toBeDefined();
  return element!;
}
async function openEmergency() { await click(button('emergencyStop.button')); }
async function escape() {
  await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.setItem('agentforge_locale', 'en-US');
  api = {
    getProjects: vi.fn().mockResolvedValue([project('P'), project('Q')]),
    getTasks: vi.fn(async (id: string) => id === 'P' ? [task('A', 'P'), task('B', 'P')] : [task('C', 'Q')]),
    getEvents: vi.fn().mockResolvedValue([]), getEvidence: vi.fn().mockResolvedValue([]),
    getProviderResources: vi.fn().mockResolvedValue([]), getAgents: vi.fn().mockResolvedValue([]),
    runVerificationTests: vi.fn(async (id: string, _config: string, binding: any) => verification(id, binding)),
    triggerEmergencyStop: vi.fn().mockResolvedValue(stopped), transitionProject: vi.fn().mockResolvedValue({ success: true }),
  };
  (window as any).orchestrator = api;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  document.body.replaceChildren(); delete (window as any).orchestrator; window.localStorage.clear(); vi.restoreAllMocks();
});

describe('verification through real provider/context and DOM', () => {
  it.each(['en-US', 'vi-VN'] as SupportedLocale[])('disables browser preview and returns typed desktop-required feedback in %s', async locale => {
    delete (window as any).orchestrator; window.localStorage.setItem('agentforge_locale', locale);
    await render();
    expect(button('taskDetail.runTestsButton').disabled).toBe(true);
    expect(container.querySelector('#verification-availability')?.textContent).toBe(getTranslation(locale, 'actions.desktopRequired'));
    const before = JSON.stringify(context.tasks);
    let verificationResult: unknown, stopResult: unknown;
    await act(async () => { verificationResult = await context.runVerificationTests(context.tasks[0].id); stopResult = await context.triggerEmergencyStop(); });
    expect(verificationResult).toEqual({ success: false, code: 'DESKTOP_REQUIRED' });
    expect(stopResult).toEqual({ success: false, code: 'DESKTOP_REQUIRED' });
    expect(JSON.stringify(context.tasks)).toBe(before);
    expect(api.runVerificationTests).not.toHaveBeenCalled(); expect(api.triggerEmergencyStop).not.toHaveBeenCalled();
  });

  it('renders only actual observed counts and sends complete captured task/project/revision/epoch binding', async () => {
    await render(); await click(button('taskDetail.runTestsButton'));
    expect(container.querySelector('[role="status"]')?.textContent).toContain('12 Passed, 0 Failed (Exit Code 0)');
    expect(api.runVerificationTests).toHaveBeenCalledOnce();
    expect(api.runVerificationTests.mock.calls[0]).toEqual(['A', undefined, { expectedProjectId: 'P', expectedRevision: 2,
      expectedOwnershipEpoch: 4, expectedState: 'VALIDATING', executionId: expect.any(String) }]);
    expect(JSON.stringify(context.actionResults.runVerification)).not.toContain('synthetic-approved-command');
  });

  it('reports failed verification with its observed nonzero exit and counts', async () => {
    api.runVerificationTests.mockImplementation(async (id: string, _config: string, binding: any) => ({ ...verification(id, binding),
      success: false, error: 'Verification tests failed.', testRun: { ...testRun(id), passed_count: 3, failed_count: 9, exit_code: 1 } }));
    await render(); await click(button('taskDetail.runTestsButton'));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Verification failed: 3 Passed, 9 Failed (Exit Code 1)');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it.each([null, undefined, {}, { success: true }, { success: false, error: 'private diagnostic' },
    { success: false, error: 'COMMAND_POLICY_REJECTED', privateDetail: 'private diagnostic' },
    { success: true, taskId: 'OTHER', testRun: testRun('OTHER') }])('shows localized failure for null/malformed/rejected replies %#', async reply => {
    api.runVerificationTests.mockResolvedValue(reply);
    await render(); await click(button('taskDetail.runTestsButton'));
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert).not.toBeNull(); expect(alert.textContent).not.toContain('12 Passed');
    expect(container.textContent).not.toContain('private diagnostic');
    expect(container.querySelector('[role="status"]')).toBeNull();
    if ((reply as any)?.error === 'COMMAND_POLICY_REJECTED') expect(alert.textContent).toBe(i18n.t('actions.verificationRejected'));
  });

  it('shows an IPC rejection without echoing an exception and permits a retry', async () => {
    const logging = vi.spyOn(console, 'error');
    api.runVerificationTests.mockRejectedValueOnce(new Error('private diagnostic')).mockImplementationOnce(async (id: string, _config: string, binding: any) => verification(id, binding));
    await render(); await click(button('taskDetail.runTestsButton'));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(i18n.t('actions.requestRejected'));
    expect(logging).not.toHaveBeenCalled();
    expect(button('taskDetail.runTestsButton').disabled).toBe(false);
    await click(button('taskDetail.runTestsButton')); expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it('bounds duplicate DOM and direct-context requests synchronously, while emergency remains available', async () => {
    const pending = deferred<unknown>(); api.runVerificationTests.mockReturnValue(pending.promise);
    await render(); const control = button('taskDetail.runTestsButton');
    await act(async () => { control.click(); control.click(); });
    expect(api.runVerificationTests).toHaveBeenCalledOnce(); expect(control.disabled).toBe(true); expect(control.getAttribute('aria-busy')).toBe('true');
    let duplicate: unknown; await act(async () => { duplicate = await context.runVerificationTests('A'); });
    expect(duplicate).toEqual({ success: false, code: 'ACTION_PENDING' });
    expect(button('emergencyStop.button').disabled).toBe(false);
    await openEmergency(); await click(button('emergencyStop.confirm'));
    expect(api.triggerEmergencyStop).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve(verification('A', api.runVerificationTests.mock.calls[0][2])); });
  });

  it('does not paint a delayed task A observation in task B, even after switching back to A', async () => {
    const pending = deferred<unknown>(); api.runVerificationTests.mockReturnValue(pending.promise);
    await render(); await click(button('taskDetail.runTestsButton'));
    await act(async () => { context.setSelectedTaskId('B'); });
    expect(container.textContent).toContain('Task B');
    await act(async () => { context.setSelectedTaskId('A'); pending.resolve(verification('A', api.runVerificationTests.mock.calls[0][2])); });
    expect(container.querySelector('[role="status"]')).toBeNull(); expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button('taskDetail.runTestsButton').disabled).toBe(false);
  });

  it('returns a typed stale result for a delayed project response and never displays its counts', async () => {
    const pending = deferred<unknown>(); api.runVerificationTests.mockReturnValue(pending.promise);
    await render(); let request!: Promise<unknown>;
    await act(async () => { request = context.runVerificationTests('A'); });
    await act(async () => { context.setActiveProject(context.projects[1]); context.setSelectedTaskId('C'); await context.refreshData(); });
    expect(container.textContent).toContain('Task C');
    let result: unknown;
    await act(async () => { pending.resolve(verification('A', api.runVerificationTests.mock.calls[0][2])); result = await request; });
    expect(result).toEqual({ success: false, code: 'STALE_CONTEXT' });
    expect(context.actionResults.runVerification).toBeUndefined(); expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('rejects an absent or cross-project task before IPC', async () => {
    await render(); let result: unknown;
    await act(async () => { result = await context.runVerificationTests('C'); });
    expect(result).toEqual({ success: false, code: 'TASK_UNAVAILABLE' }); expect(api.runVerificationTests).not.toHaveBeenCalled();
    await act(async () => { context.setSelectedTaskId('deleted'); });
    expect(container.textContent).toContain(i18n.t('taskDetail.noTaskSelected')); expect(api.runVerificationTests).not.toHaveBeenCalled();
  });
});

describe('emergency request feedback and focus', () => {
  it.each(['en-US', 'vi-VN'] as SupportedLocale[])('shows request failure, permits retry and restores focus on cancel in %s', async locale => {
    window.localStorage.setItem('agentforge_locale', locale);
    api.triggerEmergencyStop.mockRejectedValueOnce(new Error('private diagnostic')).mockResolvedValueOnce(stopped);
    const logging = vi.spyOn(console, 'error');
    await render(); const trigger = button('emergencyStop.button'); await openEmergency(); await click(button('emergencyStop.confirm'));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(i18n.t('actions.requestRejected'));
    expect(container.textContent).not.toContain('private diagnostic'); expect(logging).not.toHaveBeenCalled();
    expect(button('emergencyStop.confirm').disabled).toBe(false); expect(button('common.cancel').disabled).toBe(false);
    await click(button('emergencyStop.confirm')); expect(container.textContent).toContain(i18n.t('emergencyStop.successNotice'));
    expect(container.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
    await escape(); expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(trigger);
  });

  it.each([null, {}, { success: false, error: 'private diagnostic' }, { ...stopped, unprovenProcesses: undefined },
    { ...stopped, processesTerminated: -1 }])('retains safe failure/retry/cancel controls for malformed or denied emergency replies %#', async reply => {
    api.triggerEmergencyStop.mockResolvedValue(reply);
    await render(); await openEmergency(); await click(button('emergencyStop.confirm'));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain(i18n.t('emergencyStop.successNotice'));
    expect(button('common.cancel').disabled).toBe(false); await click(button('common.cancel'));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps a real pending modal fenced, rejects duplicates, and resets its result on reopen', async () => {
    const pending = deferred<unknown>(); api.triggerEmergencyStop.mockReturnValue(pending.promise);
    await render(); const trigger = button('emergencyStop.button'); await openEmergency();
    const modal = container.querySelector<HTMLDivElement>('[role="dialog"]')!;
    const confirm = button('emergencyStop.confirm');
    await act(async () => { confirm.click(); confirm.click(); });
    expect(api.triggerEmergencyStop).toHaveBeenCalledOnce(); expect(modal.getAttribute('aria-busy')).toBe('true');
    expect(document.activeElement).toBe(modal); await escape(); expect(container.querySelector('[role="dialog"]')).toBe(modal);
    let duplicate: unknown; await act(async () => { duplicate = await context.triggerEmergencyStop(); });
    expect(duplicate).toEqual({ success: false, code: 'ACTION_PENDING' });
    await act(async () => { pending.resolve(stopped); });
    expect(container.textContent).toContain(i18n.t('emergencyStop.successNotice'));
    await escape(); expect(document.activeElement).toBe(trigger);
    await openEmergency(); expect(button('emergencyStop.confirm').disabled).toBe(false);
    expect(container.textContent).not.toContain(i18n.t('emergencyStop.successNotice'));
  });

  it('remains independent of an ordinary pending project mutation', async () => {
    const pending = deferred<unknown>(); api.transitionProject.mockReturnValue(pending.promise);
    await render(); let request!: Promise<unknown>;
    await act(async () => { request = context.transitionProject('PAUSE'); });
    expect(context.pendingActions).toContain('projectTransition'); expect(button('emergencyStop.button').disabled).toBe(false);
    await openEmergency(); await click(button('emergencyStop.confirm')); expect(api.triggerEmergencyStop).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(i18n.t('emergencyStop.successNotice'));
    await act(async () => { pending.resolve({ success: true }); await request; });
  });

  it('shows actual termination uncertainty and counts without a false success banner', async () => {
    api.triggerEmergencyStop.mockResolvedValue({ ...stopped, processesTerminated: 1, unprovenProcesses: 2, allTerminatedProven: false });
    await render(); await openEmergency(); await click(button('emergencyStop.confirm'));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(i18n.t('emergencyStop.unconfirmedNotice', { count: 2 }));
    expect(container.textContent).not.toContain(i18n.t('emergencyStop.successNotice'));
    expect(container.textContent).toContain(`${i18n.t('emergencyStop.unprovenProcesses')}: 2`);
    expect(container.textContent).toContain(`${i18n.t('emergencyStop.tasksPaused')}: 1`);
  });
});
