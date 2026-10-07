// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enUS } from '../src/shared/i18n/locales/en-US';
import { viVN } from '../src/shared/i18n/locales/vi-VN';

const fixture = vi.hoisted(() => ({ context: {} as Record<string, any>, locale: 'en-US', translate: (key: string) => key }));
vi.mock('../src/ui/context/OrchestratorContext', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/ui/context/OrchestratorContext')>(),
  useOrchestrator: () => fixture.context,
}));
vi.mock('../src/ui/context/I18nContext', () => ({
  useI18n: () => ({ locale: fixture.locale, setLocale: vi.fn(), t: fixture.translate }),
}));
import { TaskBoardView } from '../src/ui/views/TaskBoardView';
import { EvidenceView } from '../src/ui/views/EvidenceView';
import { TimelineView } from '../src/ui/views/TimelineView';
import { ProjectsView } from '../src/ui/views/ProjectsView';
import { SettingsView } from '../src/ui/views/SettingsView';
import { ManualBridgeView } from '../src/ui/views/ManualBridgeView';
import { Header } from '../src/ui/components/Header';

let root: Root;
let container: HTMLDivElement;
const task = { id: 'T-1', title: 'Inspect the real task', state: 'PLANNED', priority: 'MEDIUM', risk: 'LOW', revision_count: 0, max_revisions: 3, progress_cache_percent: 10 };
const resource = { id: 'R-1', model_name: 'Example model', provider_id: 'P-1', enabled: true, capabilities: ['CODE'], health_status: 'HEALTHY', remaining_quota: null, total_quota: null, quota_source: 'UNKNOWN', quota_confidence: 0 };

async function render(element: React.ReactNode) { await act(async () => { root.render(element); }); }
async function click(element: HTMLElement) { await act(async () => { element.focus(); element.click(); }); }
function button(text: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes(text));
  expect(result, `Button ${text}`).toBeDefined();
  return result!;
}
function assertLabels(scope: HTMLElement) {
  for (const label of scope.querySelectorAll('label')) {
    expect(label.control, `Label ${label.textContent} must name its input`).not.toBeNull();
  }
  for (const input of scope.querySelectorAll<HTMLInputElement>('input, textarea, select')) {
    const labelledBy = input.getAttribute('aria-labelledby');
    const accessibleName = input.labels?.length || input.getAttribute('aria-label')?.trim()
      || (labelledBy && labelledBy.split(/\s+/).every((id) => document.getElementById(id)?.textContent?.trim()));
    expect(Boolean(accessibleName), `Unnamed ${input.tagName} ${input.id}`).toBe(true);
  }
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  fixture.locale = 'en-US';
  fixture.translate = (key: string) => {
    const dictionary: any = fixture.locale === 'vi-VN' ? viVN : enUS;
    const value = key.split('.').reduce((object: any, part) => object?.[part], dictionary);
    if (typeof value !== 'string') throw new Error(`Missing localized key: ${key}`);
    return value;
  };
  fixture.context = {
    tasks: [task], evidence: [], events: [], resources: [resource], projects: [{ id: 'P', name: 'Project', status: 'READY' }],
    activeProject: { id: 'P', name: 'Project', status: 'READY' }, agents: [], densityMode: 'OWNER', isElectron: true,
    pendingActions: [], actionResults: {}, setSelectedTaskId: vi.fn(), setActiveView: vi.fn(),
    setActiveProject: vi.fn(), setDensityMode: vi.fn(), setIsEmergencyStopOpen: vi.fn(),
    transitionProject: vi.fn(), resumeProject: vi.fn(), createTask: vi.fn(), createProject: vi.fn(), importContract: vi.fn(),
    getOwnerHandoffSnapshot: vi.fn().mockResolvedValue({ success: true, snapshot: { providerResources: [resource] } }),
    listQuarantinedSubmissions: vi.fn().mockResolvedValue({ items: [] }),
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  document.body.replaceChildren();
  delete (window as any).orchestrator;
});

describe('native interactive rows and associated names', () => {
  it('exposes the whole task card as a focusable native button and opens the correct task', async () => {
    await render(<TaskBoardView />);
    const card = button(task.title);
    expect(card.type).toBe('button');
    expect(card.tabIndex).toBe(0);
    card.focus();
    expect(document.activeElement).toBe(card);
    await click(card);
    expect(fixture.context.setSelectedTaskId).toHaveBeenCalledWith(task.id);
    expect(fixture.context.setActiveView).toHaveBeenCalledWith('task-detail');
    expect(card.querySelector('button, input, a, select')).toBeNull();
  });

  it('selects evidence through a focusable button and exposes its selected state', async () => {
    fixture.context.evidence = [{ id: 'E-1', evidence_type: 'TEST_OUTPUT', storage_type: 'INLINE', summary: 'Approved test result', hash: 'a'.repeat(64), byte_size: 12, raw_payload: 'Actual output' }];
    await render(<EvidenceView />);
    const row = button('Approved test result');
    expect(row.tabIndex).toBe(0);
    expect(row.getAttribute('aria-pressed')).toBe('false');
    await click(row);
    expect(row.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('pre')?.textContent).toBe('Actual output');
  });

  it('names timeline filters and toggles the matching event payload through a native button', async () => {
    fixture.context.events = [{ id: 'EV-1', type: 'TEST_COMPLETED', summary: 'Finished verification', timestamp: '2026-10-07T00:00:00Z', task_id: task.id, structured_payload: { exitCode: 0 } }];
    await render(<TimelineView />);
    assertLabels(container);
    const row = button('Finished verification');
    expect(row.tabIndex).toBe(0);
    expect(row.getAttribute('aria-expanded')).toBe('false');
    await click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    const payload = document.getElementById(row.getAttribute('aria-controls')!);
    expect(payload?.textContent).toContain('"exitCode": 0');
    await click(row);
    expect(row.getAttribute('aria-expanded')).toBe('false');
  });

  it.each(['en-US', 'vi-VN'])('names the project selector and keeps emergency stop reachable in %s', async (locale) => {
    fixture.locale = locale;
    await render(<Header />);
    assertLabels(container);
    const emergency = button(fixture.translate('emergencyStop.button').toUpperCase());
    expect(emergency.disabled).toBe(false);
    emergency.focus();
    expect(document.activeElement).toBe(emergency);
    await click(emergency);
    expect(fixture.context.setIsEmergencyStopOpen).toHaveBeenCalledWith(true);
  });

  it('associates all task creation fields and project creation/import fields', async () => {
    await render(<TaskBoardView />);
    await click(button(fixture.translate('taskBoard.newTask')));
    assertLabels(container.querySelector<HTMLElement>('[role="dialog"]')!);
    await render(<ProjectsView />);
    assertLabels(container);
    await click(button(fixture.translate('projects.newProject')));
    assertLabels(container.querySelector<HTMLElement>('[role="dialog"]')!);
  });

  it('associates verification command and revision settings with their visible labels', async () => {
    await render(<SettingsView />);
    assertLabels(container);
    expect(container.querySelectorAll('label[for]')).toHaveLength(4);
  });

  it.each(['en-US', 'vi-VN'])('names candidate checkboxes, reorder icons and Manual Bridge fields in %s', async (locale) => {
    fixture.locale = locale;
    await render(<ManualBridgeView />);
    assertLabels(container);
    await click(container.querySelector<HTMLInputElement>('#candidate-R-1')!);
    const reorder = container.querySelectorAll<HTMLButtonElement>('button[aria-label]');
    expect(reorder).toHaveLength(2);
    expect(reorder[0].getAttribute('aria-label')).toContain(fixture.translate('manualBridge.moveUpTitle'));
    expect(reorder[1].getAttribute('aria-label')).toContain(resource.model_name);
    await click(button(fixture.translate('managerInbox.title')));
    assertLabels(container);
    await click(button(fixture.translate('manualBridge.outboxTabButton')));
    assertLabels(container);
    expect(container.querySelector('fieldset legend')?.textContent).toContain(fixture.translate('manualBridge.packageTypeLabel'));
  });

  it('makes a quarantined queue entry focusable and opens its owner inspection', async () => {
    fixture.context.listQuarantinedSubmissions.mockResolvedValue({ items: [{ id: 'S-123456789', task_id: task.id, integrity_status: 'VALID', submitted_at: '2026-10-07T00:00:00Z' }] });
    fixture.context.inspectQuarantinedSubmission = vi.fn().mockResolvedValue({ detail: { submission: { id: 'S-123456789', task_id: task.id }, integrity_status: 'VALID', adjudications: [] } });
    await render(<ManualBridgeView />);
    await click(button(fixture.translate('quarantinedQueue.title')));
    const row = button('S-123456');
    expect(row.tabIndex).toBe(0);
    await click(row);
    expect(row.getAttribute('aria-pressed')).toBe('true');
    expect(fixture.context.inspectQuarantinedSubmission).toHaveBeenCalledWith('S-123456789');
    expect(container.textContent).toContain('Submission ID: S-123456789');
  });
});
