// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, listener: (event: unknown, payload: unknown) => Promise<unknown>) => { handlers.set(channel, listener); } },
  dialog: { showOpenDialog: vi.fn() },
  app: { getPath: vi.fn() },
}));

import { registerIpcHandlers } from '../src/electron/ipcHandlers';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { NativeProfileResolver } from '../src/core/credentials/NativeProfileResolver';
import { AccountQuotaService } from '../src/core/services/AccountQuotaService';
import { CodexQuotaClient } from '../src/core/services/CodexQuotaClient';
import { WorkspaceManagementService } from '../src/core/services/WorkspaceManagementService';
import { I18nProvider } from '../src/ui/context/I18nContext';
import { OrchestratorProvider } from '../src/ui/context/OrchestratorContext';
import { AutomationStatusBadge } from '../src/ui/components/AutomationStatusBadge';
import { ProviderQuotaPanel } from '../src/ui/components/ProviderQuotaPanel';
import { normalizeAutomationStatus, normalizeQuotaReply } from '../src/ui/runtimeStatus';
import { getTranslation } from '../src/shared/i18n';
import { FakeCodexSpawner } from './quotaFakes';

const NOW = '2026-10-24T08:00:00.000Z';

describe('verified-account initialization through the single health writer', () => {
  let db: Database.Database;
  let repo: Repository;
  let spawner: FakeCodexSpawner;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    spawner = new FakeCodexSpawner();
  });
  afterEach(() => db.close());

  const service = (initializeVerifiedAccounts: boolean) => new AccountQuotaService(repo, {
    codexReader: new CodexQuotaClient({ spawner, resolveExecutable: () => path.join(os.tmpdir(), 'fake-codex.exe'), timeoutMs: 100 }),
    profileResolver: new NativeProfileResolver({ baseProfilesDir: path.join(os.tmpdir(), 'af-runtime-fake-profiles') }),
    now: () => NOW,
    initializeVerifiedAccounts,
  });
  const account = () => {
    const created = new WorkspaceManagementService(repo, () => NOW).createAgent({
      displayName: 'Coder', role: 'CODER', connection: 'CODEX_CLI', modelName: 'm', workerSlots: 1,
    });
    if (!created.success) throw new Error(created.error);
    return repo.getProviderAccount(repo.getProviderResource(created.agent.provider_resource_id!)!.provider_account_id!)!;
  };

  it('promotes an unused UNKNOWN account to AVAILABLE only when enabled, without a success timestamp', async () => {
    const off = account();
    await service(false).refreshAll();
    expect(repo.getProviderAccount(off.id)!.health_status).toBe('UNKNOWN');

    await service(true).refreshAll();
    const promoted = repo.getProviderAccount(off.id)!;
    expect(promoted.health_status).toBe('AVAILABLE');
    expect(promoted.last_success_at).toBeNull();
  });

  it('never overrides a recorded failure, cooldown or an account that already has work', async () => {
    const failed = account();
    db.prepare("UPDATE provider_accounts SET health_status = 'UNKNOWN', last_failure_at = ?, last_failure_code = 'AUTH' WHERE id = ?").run(NOW, failed.id);
    await service(true).refreshAll();
    expect(repo.getProviderAccount(failed.id)!.health_status).toBe('UNKNOWN');
  });

  it('keeps an unauthenticated account UNKNOWN', async () => {
    const pending = account();
    spawner.onRateRead = (child) => child.reply({ id: 2, error: { code: 401, message: 'not logged in' } });
    await service(true).refreshAll();
    expect(repo.getProviderAccount(pending.id)!.health_status).toBe('UNKNOWN');
  });
});

describe('runtime IPC channels', () => {
  const trusted = { senderFrame: { url: 'http://localhost:5173/' } };
  beforeEach(() => handlers.clear());

  it('reports typed unavailability when no runtime is wired', async () => {
    registerIpcHandlers({} as any, {} as any, {} as any, {} as any, {} as any, undefined, undefined, undefined, undefined, {} as any);
    await expect(handlers.get('automation:status')!(trusted, undefined)).resolves.toEqual({ success: false, errorCode: 'AUTOMATION_UNAVAILABLE' });
    await expect(handlers.get('quota:refresh')!(trusted, undefined)).resolves.toEqual({ success: false, errorCode: 'QUOTA_UNAVAILABLE' });
  });

  it('refreshes quota and nudges automation', async () => {
    const automation = { getStatus: vi.fn(() => ({ active: true, maxConcurrentExecutions: 1, inFlight: 0, projects: [] })), tick: vi.fn(async () => {}) };
    const quota = { refreshAll: vi.fn(async () => [{ accountId: 'a', status: 'OK' }]), getLatestObservations: vi.fn(() => []) };
    registerIpcHandlers({} as any, {} as any, {} as any, {} as any, {} as any, undefined, undefined, undefined, undefined, {} as any,
      undefined, { automation: automation as any, quota: quota as any });
    await expect(handlers.get('quota:refresh')!(trusted, undefined)).resolves.toEqual({ success: true, observations: [{ accountId: 'a', status: 'OK' }] });
    expect(automation.tick).toHaveBeenCalledTimes(1);
    await expect(handlers.get('automation:status')!(trusted, undefined)).resolves.toMatchObject({ success: true, status: { active: true } });
  });
});

describe('runtime status in the renderer', () => {
  let root: Root;
  let container: HTMLDivElement;
  let api: any;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    api = {
      getProjects: vi.fn().mockResolvedValue([]), getProviderResources: vi.fn().mockResolvedValue([{ id: 'res-1', model_name: 'gpt-5-codex' }]),
      getAgents: vi.fn().mockResolvedValue([]),
      getAutomationStatus: vi.fn().mockResolvedValue({ success: true, status: { active: true, maxConcurrentExecutions: 1, inFlight: 0,
        projects: [{ projectId: 'P1', phase: 'WAITING_FOR_CAPACITY', taskId: 'T1', reasonCode: 'ACCOUNT_NOT_VERIFIED', updatedAt: NOW }] } }),
      getQuotaObservations: vi.fn().mockResolvedValue({ success: true, observations: [] }),
      refreshQuota: vi.fn().mockResolvedValue({ success: true, observations: [{
        accountId: 'acct-1', resourceIds: ['res-1'], providerId: 'prov-codex-cli', status: 'OK', source: 'PROVIDER_REPORTED',
        usedPercent: 25, remainingPercent: 75, resetsAt: '2026-10-24T12:00:00.000Z', windowMinutes: 300, secondary: null,
        planType: 'plus', observedAt: NOW, message: null }] }),
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

  it('shows the automation phase and its reason separately from project status', async () => {
    await act(async () => { root.render(<I18nProvider><AutomationStatusBadge projectId="P1" /></I18nProvider>); });
    const badge = container.querySelector('[role="status"]')!;
    expect(badge.textContent).toContain(getTranslation('vi-VN', 'runtime.phases.WAITING_FOR_CAPACITY'));
    expect(badge.textContent).toContain(getTranslation('vi-VN', 'runtime.reasons.ACCOUNT_NOT_VERIFIED'));
  });

  it('refreshes provider quota on request and shows percent left', async () => {
    await act(async () => { root.render(<I18nProvider><OrchestratorProvider><ProviderQuotaPanel /></OrchestratorProvider></I18nProvider>); });
    expect(container.textContent).toContain(getTranslation('vi-VN', 'runtime.quota.empty'));
    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(getTranslation('vi-VN', 'runtime.quota.refresh')))!;
    await act(async () => { button.click(); });
    expect(api.refreshQuota).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(getTranslation('vi-VN', 'runtime.quota.remaining', { percent: 75 }));
    expect(container.textContent).toContain('gpt-5-codex');
  });

  it('treats malformed status and quota replies as unknown', () => {
    expect(normalizeAutomationStatus({ success: true, status: { active: true, projects: [{ projectId: 'P', phase: 'DONE' }] } })).toBeNull();
    expect(normalizeAutomationStatus({ success: false })).toBeNull();
    expect(normalizeQuotaReply({ success: true, observations: [{}] })).toBeNull();
  });
});
