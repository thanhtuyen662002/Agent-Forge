import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { enUS } from '../src/shared/i18n/locales/en-US';
import { viVN } from '../src/shared/i18n/locales/vi-VN';

const fixture = vi.hoisted(() => ({ context: {} as Record<string, unknown> }));
vi.mock('../src/ui/context/OrchestratorContext', () => ({ useOrchestrator: () => fixture.context }));
vi.mock('../src/ui/context/I18nContext', () => ({ useI18n: () => ({ locale: 'en-US', setLocale: () => {}, t: (key: string) => key }) }));
import { Header } from '../src/ui/components/Header';

function header(status: string, desktop: boolean, pending = false, failed = false): string {
  const project = { id: 'P', name: 'Project', status };
  fixture.context = {
    activeProject: project, projects: [project], tasks: [], agents: [], densityMode: 'OWNER',
    isElectron: desktop, pendingActions: pending ? ['projectTransition'] : [],
    actionResults: failed ? { projectTransition: { success: false, code: 'IPC_FAILED' } } : {},
    setActiveProject: () => {}, setActiveView: () => {}, setDensityMode: () => {},
    setIsEmergencyStopOpen: () => {}, transitionProject: () => {}, resumeProject: () => {},
  };
  return renderToStaticMarkup(React.createElement(Header));
}

describe('UI mutation component contracts', () => {
  it.each(['READY', 'RUNNING', 'PAUSED'])('disables project controls in read-only preview for %s', (status) => {
    const markup = header(status, false);
    expect(markup).toContain('actions.previewReadOnly');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-busy="false"/);
    expect(markup).toContain('actions.desktopRequired');
  });
  it('renders pending and failure feedback, while emergency stop remains enabled on desktop', () => {
    const markup = header('RUNNING', true, true);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('actions.pending');
    const stopButton = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((button) => /emergencyStop\.button/i.test(button));
    expect(stopButton).toBeDefined();
    expect(stopButton).not.toContain('disabled=""');
    expect(header('READY', true, false, true)).toContain('role="alert"');
    expect(header('READY', true, false, true)).toContain('actions.failed');
  });
  it('guards project/task form reset and import success behind a successful result', () => {
    const projects = fs.readFileSync('src/ui/views/ProjectsView.tsx', 'utf8');
    const tasks = fs.readFileSync('src/ui/views/TaskBoardView.tsx', 'utf8');
    const projectCreate = projects.slice(projects.indexOf('const handleCreate ='), projects.indexOf('const handleImportContract'));
    const taskCreate = tasks.slice(tasks.indexOf('const handleCreateTask'), tasks.indexOf('  return ('));
    for (const [handler, reset] of [[projectCreate, "setName('')"], [taskCreate, "setNewTitle('')"]]) {
      expect(handler).toMatch(/if \(!result\.success\) \{[\s\S]*?return;/);
      expect(handler.indexOf('if (!result.success)')).toBeLessThan(handler.indexOf(reset));
    }
    const importing = projects.slice(projects.indexOf('const handleImportContract'), projects.indexOf('  return ('));
    expect(importing.indexOf('if (!result.success)')).toBeLessThan(importing.indexOf('setImportSucceeded(true)'));
    expect(projects).toContain('aria-busy={importing}');
    expect(projects).toContain('aria-busy={creating}');
    expect(tasks).toContain('aria-busy={creating}');
  });
  it('has complete English/Vietnamese action feedback parity', () => {
    expect(Object.keys(enUS.actions).sort()).toEqual(Object.keys(viVN.actions).sort());
    expect(Object.values(enUS.actions).every((text) => text.trim().length > 0)).toBe(true);
    expect(Object.values(viVN.actions).every((text) => text.trim().length > 0)).toBe(true);
  });
});
