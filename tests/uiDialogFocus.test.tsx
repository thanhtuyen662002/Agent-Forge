// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ context: {} as Record<string, any>, translate: (key: string) => key }));
vi.mock('../src/ui/context/OrchestratorContext', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/ui/context/OrchestratorContext')>(),
  useOrchestrator: () => fixture.context,
}));
vi.mock('../src/ui/context/I18nContext', () => ({ useI18n: () => ({ t: fixture.translate }) }));
import { AccessibleDialog } from '../src/ui/components/AccessibleDialog';
import { EmergencyStopModal } from '../src/ui/components/EmergencyStopModal';
import { CapacityView } from '../src/ui/views/CapacityView';
import { TaskBoardView } from '../src/ui/views/TaskBoardView';
import { ProjectsView } from '../src/ui/views/ProjectsView';
import { ManualBridgeView } from '../src/ui/views/ManualBridgeView';

let root: Root;
let container: HTMLDivElement;
async function render(element: React.ReactNode) { await act(async () => { root.render(element); }); }
async function click(element: HTMLElement) { await act(async () => { element.focus(); element.click(); }); }
async function key(key: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  await act(async () => { document.activeElement!.dispatchEvent(event); });
  return event;
}
function button(text: string, scope: HTMLElement = container) {
  const result = Array.from(scope.querySelectorAll('button')).find((element) => element.textContent?.includes(text));
  expect(result, `Button ${text}`).toBeDefined();
  return result!;
}
function dialog() { return container.querySelector<HTMLDivElement>('[role="dialog"]')!; }

function Harness({ pending = false, revision = 0 }: { pending?: boolean; revision?: number }) {
  const [open, setOpen] = useState(false);
  const [nested, setNested] = useState(false);
  const [value, setValue] = useState('Draft');
  return <>
    <section id="background"><button id="trigger" onClick={() => setOpen(true)}>Open</button><button id="outside">Background action</button></section>
    {open && <div><AccessibleDialog aria-label="Example" onDismiss={() => setOpen(false)} dismissible={!pending}>
      <label htmlFor="draft">Draft</label><input id="draft" value={value} disabled={pending} onChange={(event) => setValue(event.target.value)} />
      <button hidden>Hidden action</button><button disabled>Disabled action</button><button style={{ display: 'none' }}>Invisible action</button>
      <span aria-hidden="true"><button>Hidden from accessibility</button></span>
      <button id="cancel" data-dialog-initial-focus disabled={pending} onClick={() => setOpen(false)}>Cancel</button>
      <button id="nested-trigger" disabled={pending} onClick={() => setNested(true)}>Nested</button>
      <button id="last" disabled={pending}>Save {revision}</button>
    </AccessibleDialog></div>}
    {nested && <AccessibleDialog aria-label="Nested" onDismiss={() => setNested(false)}>
      <button data-dialog-initial-focus onClick={() => setNested(false)}>Close nested</button>
    </AccessibleDialog>}
  </>;
}

function EmergencyHarness() {
  const [open, setOpen] = useState(false);
  fixture.context.isEmergencyStopOpen = open;
  fixture.context.setIsEmergencyStopOpen = setOpen;
  return <><button id="emergency-trigger" onClick={() => setOpen(true)}>Emergency stop</button><EmergencyStopModal /></>;
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  fixture.context = {
    isElectron: true, pendingActions: [], activeProject: { id: 'P' }, projects: [], tasks: [], resources: [],
    createTask: vi.fn(), createProject: vi.fn(), importContract: vi.fn(), updateResourceQuota: vi.fn(),
    triggerEmergencyStop: vi.fn().mockResolvedValue({ success: true, data: { processesTerminated: 1, tasksPaused: 0, projectsPaused: 0, timestamp: '2026-10-07T00:00:00Z', unprovenProcesses: 0, allTerminatedProven: true } }),
    getOwnerHandoffSnapshot: vi.fn().mockResolvedValue({ success: true, snapshot: {} }),
    listQuarantinedSubmissions: vi.fn().mockResolvedValue({ items: [] }),
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  document.body.replaceChildren();
});

describe('modal focus boundary', () => {
  it('initially focuses Cancel, cycles Tab in both directions and excludes unavailable controls', async () => {
    await render(<Harness />);
    await click(button('Open'));
    expect(dialog().getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement?.id).toBe('cancel');
    container.querySelector<HTMLElement>('#last')!.focus();
    await key('Tab');
    expect(document.activeElement?.id).toBe('draft');
    await key('Tab', true);
    expect(document.activeElement?.id).toBe('last');
    await key('Tab', true);
    expect(document.activeElement?.id).toBe('nested-trigger');
    await key('Tab', true);
    expect(document.activeElement?.id).toBe('cancel');
    await key('Tab', true);
    expect(document.activeElement?.id).toBe('draft');
  });

  it('isolates the background, redirects external focus, and restores the trigger and original attributes on Escape', async () => {
    const existing = document.createElement('aside');
    existing.setAttribute('aria-hidden', 'false');
    const alreadyInert = document.createElement('aside');
    alreadyInert.setAttribute('inert', 'existing');
    alreadyInert.setAttribute('aria-hidden', 'true');
    document.body.append(existing, alreadyInert);
    await render(<Harness />);
    const trigger = button('Open');
    await click(trigger);
    expect(container.querySelector('#background')!.hasAttribute('inert')).toBe(true);
    expect(existing.getAttribute('aria-hidden')).toBe('true');
    container.querySelector<HTMLElement>('#outside')!.focus();
    expect(dialog().contains(document.activeElement)).toBe(true);
    await key('Escape');
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(container.querySelector('#background')!.hasAttribute('inert')).toBe(false);
    expect(existing.getAttribute('aria-hidden')).toBe('false');
    expect(existing.hasAttribute('inert')).toBe(false);
    expect(alreadyInert.getAttribute('inert')).toBe('existing');
    expect(alreadyInert.getAttribute('aria-hidden')).toBe('true');
  });

  it('preserves the focused input and draft across ordinary renders', async () => {
    await render(<Harness />);
    await click(button('Open'));
    const input = container.querySelector<HTMLInputElement>('#draft')!;
    input.focus();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Kept draft');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await render(<Harness revision={1} />);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('Kept draft');
  });

  it('blocks Escape and keeps the dialog focused when every control is disabled during a pending operation', async () => {
    await render(<Harness />);
    await click(button('Open'));
    await render(<Harness pending />);
    const modal = dialog();
    expect(document.activeElement).toBe(modal);
    expect((await key('Escape')).defaultPrevented).toBe(true);
    expect(dialog()).toBe(modal);
    await key('Tab');
    await key('Tab', true);
    expect(document.activeElement).toBe(modal);
    await render(<Harness />);
    await key('Escape');
    expect(document.activeElement?.id).toBe('trigger');
  });

  it('handles only the top modal and restores nested focus without releasing the underlying boundary', async () => {
    await render(<Harness />);
    await click(button('Open'));
    const trigger = button('Nested');
    await click(trigger);
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    await key('Escape');
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.activeElement).toBe(trigger);
    expect(container.querySelector('#background')!.hasAttribute('inert')).toBe(true);
    await key('Escape');
    expect(document.activeElement?.id).toBe('trigger');
  });

  it('restores background state when the entire modal view unmounts', async () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    await render(<Harness />);
    await click(button('Open'));
    expect(outside.hasAttribute('inert')).toBe(true);
    await render(<p>Another view</p>);
    expect(outside.hasAttribute('inert')).toBe(false);
    expect(outside.hasAttribute('aria-hidden')).toBe(false);
    outside.focus();
    expect(document.activeElement).toBe(outside);
  });
});

describe('production modal callers', () => {
  it.each([
    ['task', TaskBoardView, 'taskBoard.newTask', 'createTask'],
    ['project', ProjectsView, 'projects.newProject', 'createProject'],
  ] as const)('gives the %s form a named modal, guards pending Escape, and returns focus', async (_name, View, triggerName, action) => {
    await render(<View />);
    const trigger = button(triggerName);
    await click(trigger);
    const modal = dialog();
    expect(document.getElementById(modal.getAttribute('aria-labelledby')!)?.textContent).toBeTruthy();
    fixture.context.pendingActions = [action];
    await render(<View />);
    await key('Escape');
    expect(dialog()).toBe(modal);
    fixture.context.pendingActions = [];
    await render(<View />);
    await key('Escape');
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('retains the quota editor and focus through an actual rejected asynchronous save', async () => {
    fixture.context.resources = [{ id: 'R', model_name: 'Model', capabilities: [], health_status: 'HEALTHY', remaining_quota: null, total_quota: null, quota_source: 'UNKNOWN', quota_confidence: 0 }];
    let resolve!: (value: unknown) => void;
    fixture.context.updateResourceQuota.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await render(<CapacityView />);
    const trigger = button('capacity.adjustSnapshot');
    await click(trigger);
    const modal = dialog();
    await click(button('capacity.saveSnapshot'));
    await key('Escape');
    expect(dialog()).toBe(modal);
    expect(document.activeElement).toBe(modal);
    await act(async () => { resolve({ success: false, code: 'IPC_FAILED' }); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('capacity.saveError');
    expect(dialog()).toBe(modal);
    await key('Escape');
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps emergency stop open during the real request, then closes the result and restores its trigger', async () => {
    let resolve!: (value: unknown) => void;
    fixture.context.triggerEmergencyStop.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await render(<EmergencyHarness />);
    const trigger = button('Emergency stop');
    await click(trigger);
    expect(document.activeElement?.textContent).toBe('common.cancel');
    const reason = container.querySelector<HTMLInputElement>('#emergency-stop-reason')!;
    expect(reason.labels?.[0].htmlFor).toBe(reason.id);
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="common.close"]')!;
    await click(button('EMERGENCYSTOP.CONFIRM'));
    expect(close.disabled).toBe(true);
    expect(document.activeElement).toBe(dialog());
    await key('Escape');
    expect(dialog()).not.toBeNull();
    await act(async () => { close.click(); });
    expect(dialog()).not.toBeNull();
    expect(fixture.context.triggerEmergencyStop).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ success: true, data: { processesTerminated: 2, tasksPaused: 0, projectsPaused: 0, timestamp: '2026-10-07T00:00:00Z', unprovenProcesses: 0, allTerminatedProven: true } }); });
    expect(container.textContent).toContain('emergencyStop.successNotice');
    expect(dialog().contains(document.activeElement)).toBe(true);
    await key('Escape');
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('treats inline owner adjudication as a named modal and blocks dismissal while the actual request is pending', async () => {
    fixture.context.listQuarantinedSubmissions.mockResolvedValue({ items: [{ id: 'S-123456789', task_id: 'T', integrity_status: 'VALID', submitted_at: '2026-10-07T00:00:00Z' }] });
    fixture.context.inspectQuarantinedSubmission = vi.fn().mockResolvedValue({ detail: { submission: { id: 'S-123456789', task_id: 'T' }, integrity_status: 'VALID', adjudications: [] } });
    let resolve!: (value: unknown) => void;
    fixture.context.rejectQuarantinedSubmission = vi.fn().mockImplementation(() => new Promise((done) => { resolve = done; }));
    await render(<ManualBridgeView />);
    await click(button('quarantinedQueue.title'));
    await click(button('S-123456'));
    const trigger = button('quarantinedQueue.rejectButton');
    await click(trigger);
    expect(document.activeElement?.textContent).toBe('common.cancel');
    expect(document.getElementById(dialog().getAttribute('aria-labelledby')!)?.textContent).toBe('quarantinedQueue.confirmRejectTitle');
    expect(container.querySelector<HTMLInputElement>('#adjudication-reason')!.labels).toHaveLength(1);
    await click(button('common.confirm', dialog()));
    await key('Escape');
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(dialog());
    await act(async () => { resolve({ success: false, error: 'Rejected by backend' }); });
    expect(container.textContent).toContain('Rejected by backend');
    await key('Escape');
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
