import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';
import { NativeProfileResolver } from '../src/core/credentials/NativeProfileResolver';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { AccountQuotaService, type QuotaPollTimer } from '../src/core/services/AccountQuotaService';
import { CodexQuotaClient } from '../src/core/services/CodexQuotaClient';
import { WorkspaceManagementService } from '../src/core/services/WorkspaceManagementService';
import { FakeCodexSpawner, type FakeCodexProcess, QUOTA_RESULT } from './quotaFakes';

const NOW = '2026-10-24T08:00:00.000Z';
const RESET = new Date(QUOTA_RESULT.rateLimits.primary.resetsAt * 1000).toISOString();

describe('account quota observations', () => {
  let db: Database.Database;
  let repo: Repository;
  let management: WorkspaceManagementService;
  let spawner: FakeCodexSpawner;
  let service: AccountQuotaService;
  let profileResolver: NativeProfileResolver;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    management = new WorkspaceManagementService(repo, () => NOW);
    spawner = new FakeCodexSpawner();
    profileResolver = new NativeProfileResolver({ baseProfilesDir: path.join(os.tmpdir(), 'af-quota-fake-profiles') });
    service = makeService();
  });

  afterEach(() => { service.stop(); db.close(); vi.useRealTimers(); vi.unstubAllEnvs(); });

  function makeService(timer?: QuotaPollTimer): AccountQuotaService {
    return new AccountQuotaService(repo, {
      codexReader: new CodexQuotaClient({ spawner, resolveExecutable: () => path.join(os.tmpdir(), 'fake-codex.exe'), timeoutMs: 100 }),
      profileResolver, now: () => NOW, timer,
    });
  }

  function createAccount(connection: 'CODEX_CLI' | 'GEMINI_CLI' = 'CODEX_CLI') {
    const created = management.createAgent({
      displayName: 'Quota test account', role: 'CODER', connection, modelName: 'test-model', workerSlots: 1,
    });
    if (!created.success) throw new Error(created.error);
    const resource = repo.getProviderResource(created.agent.provider_resource_id!)!;
    return { account: repo.getProviderAccount(resource.provider_account_id!)!, resource };
  }

  function healthSnapshot() {
    return {
      accounts: db.prepare('SELECT * FROM provider_accounts ORDER BY id').all(),
      resources: db.prepare('SELECT id, health_status, last_health_check FROM provider_resources ORDER BY id').all(),
    };
  }

  function expectUnknown(resourceId: string) {
    expect(repo.getProviderResource(resourceId)).toMatchObject({
      remaining_quota: null, total_quota: null, quota_source: 'UNKNOWN', quota_confidence: 0, quota_reset_at: null,
    });
  }

  it('maps one official primary window to every bound resource with percent unit/reset, preserving all health authority', async () => {
    const { account, resource } = createAccount();
    repo.createProviderResource({ ...resource, id: 'another-model', model_name: 'other-model', enabled: false });
    db.prepare('UPDATE provider_accounts SET health_status = ?, cooldown_until = ? WHERE id = ?').run('AUTH_ERROR', RESET, account.id);
    db.prepare('UPDATE provider_resources SET health_status = ?, last_health_check = ?').run('AUTH_ERROR', NOW);
    const before = healthSnapshot();
    const [observation] = await service.refreshAll();
    expect(observation).toEqual({
      accountId: account.id, resourceIds: expect.arrayContaining([resource.id, 'another-model']), providerId: 'prov-codex-cli',
      status: 'OK', source: 'PROVIDER_REPORTED', usedPercent: 37, remainingPercent: 63,
      resetsAt: RESET, windowMinutes: 300,
      secondary: { usedPercent: 12, remainingPercent: 88, resetsAt: new Date(1_800_600_000_000).toISOString(), windowMinutes: 10_080 },
      planType: 'plus', observedAt: NOW, message: null,
    });
    for (const id of [resource.id, 'another-model']) {
      expect(repo.getProviderResource(id)).toMatchObject({
        remaining_quota: 63, total_quota: 100, quota_unit: 'PERCENT', quota_reset_at: RESET,
        quota_source: 'PROVIDER_REPORTED', quota_confidence: 1,
      });
    }
    const options = spawner.spawn.mock.calls[0][2];
    expect(options.env.CODEX_HOME).toBe(profileResolver.resolve(account.profile_ref!).profileDirectory);
    expect(healthSnapshot()).toEqual(before);
    expect(spawner.spawn).toHaveBeenCalledOnce();
    expect(service.getLatestObservations()).toEqual([observation]);
    observation.resourceIds.length = 0;
    observation.secondary!.usedPercent = 99;
    const cached = service.getLatestObservations();
    expect(cached[0].resourceIds).toHaveLength(2);
    expect(cached[0].secondary!.usedPercent).toBe(12);
    cached[0].remainingPercent = -99;
    expect(service.getLatestObservations()[0].remainingPercent).toBe(63);
  });

  it.each(['auth', 'timeout', 'json', 'unavailable'] as const)('keeps %s unknown, clears only its own previous quota, and never changes health', async (failure) => {
    const { account, resource } = createAccount();
    db.prepare('UPDATE provider_accounts SET health_status = ?, cooldown_until = ? WHERE id = ?').run('AUTH_ERROR', RESET, account.id);
    const before = healthSnapshot();
    await service.refreshAccount(account.id);
    expect(repo.getProviderResource(resource.id)!.remaining_quota).toBe(63);
    spawner.onRateRead = (child) => {
      if (failure === 'auth') child.reply({ id: 2, error: { code: -32000, message: 'Not logged in' } });
      else if (failure === 'json') child.stdout.write('{malformed\n');
      else if (failure === 'unavailable') child.emit('close', 1);
    };
    if (failure === 'timeout') vi.useFakeTimers();
    const pending = service.refreshAccount(account.id);
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(100);
    const observation = await pending;
    expect(observation).toMatchObject({
      status: failure === 'auth' ? 'UNAUTHENTICATED' : failure === 'json' ? 'ERROR' : 'UNAVAILABLE',
      source: 'UNKNOWN', usedPercent: null, remainingPercent: null, resetsAt: null, planType: null, observedAt: NOW,
    });
    expectUnknown(resource.id);
    expect(healthSnapshot()).toEqual(before);
    expect(service.getLatestObservations()).toEqual([observation]);
  });

  it('keeps first-read failures unknown without writing zero or claiming a reset', async () => {
    const { account, resource } = createAccount();
    spawner.onRateRead = (child) => child.reply({ id: 2, error: { code: 401, message: 'Unauthorized' } });
    await service.refreshAccount(account.id);
    expectUnknown(resource.id);
    expect(repo.getProviderResource(resource.id)!.quota_unit).toBe('REQUESTS');
  });

  it('preserves manual owner snapshots through both successful and failed refreshes', async () => {
    const { account, resource } = createAccount();
    repo.updateProviderResourceQuotaObservation(resource.id, {
      remaining: 420, total: 500, unit: 'TOKENS', resetAt: RESET, source: 'MANUAL', confidence: 0.75,
    });
    const manual = repo.getProviderResource(resource.id);
    expect((await service.refreshAccount(account.id)).status).toBe('OK');
    expect(repo.getProviderResource(resource.id)).toEqual(manual);
    spawner.onRateRead = (child) => child.reply({ id: 2, error: { code: 401, message: 'Unauthorized' } });
    expect((await service.refreshAccount(account.id)).status).toBe('UNAUTHENTICATED');
    expect(repo.getProviderResource(resource.id)).toEqual(manual);
  });

  it('preserves a manual snapshot installed while a read is in flight', async () => {
    const { account, resource } = createAccount();
    spawner.onRateRead = (child) => {
      repo.updateProviderResourceQuotaObservation(resource.id, {
        remaining: 7, total: 9, unit: 'REQUESTS', resetAt: null, source: 'MANUAL', confidence: 1,
      });
      child.reply({ id: 2, result: QUOTA_RESULT });
    };
    await service.refreshAccount(account.id);
    expect(repo.getProviderResource(resource.id)).toMatchObject({ quota_source: 'MANUAL', remaining_quota: 7, total_quota: 9 });
  });

  it('the repository atomically guards manual snapshots against telemetry writes', () => {
    const { resource } = createAccount();
    repo.updateProviderResourceQuotaObservation(resource.id, {
      remaining: 7, total: 9, unit: 'REQUESTS', resetAt: null, source: 'MANUAL', confidence: 1,
    });
    const manual = repo.getProviderResource(resource.id);
    for (const source of ['PROVIDER_REPORTED', 'UNKNOWN'] as const) {
      repo.updateProviderResourceQuotaObservation(resource.id, {
        remaining: null, total: null, unit: 'PERCENT', resetAt: null, source, confidence: 0,
      });
      expect(repo.getProviderResource(resource.id)).toEqual(manual);
    }
  });

  it('does not invalidate quota written by another observer or a prior service instance', async () => {
    const { account, resource } = createAccount();
    await service.refreshAccount(account.id);
    const restarted = makeService();
    spawner.onRateRead = (child) => child.emit('close', 1);
    await restarted.refreshAccount(account.id);
    expect(repo.getProviderResource(resource.id)!.remaining_quota).toBe(63);
    repo.updateProviderResourceQuotaObservation(resource.id, {
      remaining: 700, total: 900, unit: 'TOKENS', resetAt: RESET, source: 'PROVIDER_REPORTED', confidence: 0.5,
    });
    const external = repo.getProviderResource(resource.id);
    await service.refreshAccount(account.id);
    expect(repo.getProviderResource(resource.id)).toEqual(external);
  });

  it('reports Gemini as unsupported with unknown quota and no spawned process', async () => {
    const { account, resource } = createAccount('GEMINI_CLI');
    const before = healthSnapshot();
    expect(await service.refreshAll()).toMatchObject([{
      accountId: account.id, resourceIds: [resource.id], providerId: 'prov-gemini-cli',
      status: 'UNSUPPORTED', source: 'UNKNOWN', remainingPercent: null, usedPercent: null,
    }]);
    expect(spawner.spawn).not.toHaveBeenCalled();
    expectUnknown(resource.id);
    expect(healthSnapshot()).toEqual(before);
  });

  it('skips disabled/missing accounts and removes disabled accounts from the cache', async () => {
    const { account } = createAccount();
    await service.refreshAll();
    repo.updateProviderAccount(account.id, { enabled: false });
    expect(await service.refreshAll()).toEqual([]);
    expect(service.getLatestObservations()).toEqual([]);
    expect((await service.refreshAccount(account.id)).status).toBe('UNAVAILABLE');
    expect((await service.refreshAccount('missing')).status).toBe('UNAVAILABLE');
    expect(spawner.spawn).toHaveBeenCalledOnce();
  });

  it('does not spawn for an invalid or mismatched native profile', async () => {
    const { account, resource } = createAccount();
    for (const profile of ['native-profile://codex/../bad', 'native-profile://gemini/other']) {
      db.prepare('UPDATE provider_accounts SET profile_ref = ? WHERE id = ?').run(profile, account.id);
      expect((await service.refreshAccount(account.id)).status).toBe('UNAVAILABLE');
      expectUnknown(resource.id);
    }
    expect(spawner.spawn).not.toHaveBeenCalled();
  });

  it('treats a missing profile root as unavailable without failing service construction', async () => {
    if (process.platform !== 'win32') return;
    const { account, resource } = createAccount();
    vi.stubEnv('LOCALAPPDATA', '');
    service = new AccountQuotaService(repo, {
      codexReader: new CodexQuotaClient({ spawner, resolveExecutable: () => 'unused' }), now: () => NOW,
    });
    expect((await service.refreshAccount(account.id)).status).toBe('UNAVAILABLE');
    expectUnknown(resource.id);
    expect(spawner.spawn).not.toHaveBeenCalled();
  });

  it('drops a result if the account profile changes while it is being read', async () => {
    const { account, resource } = createAccount();
    spawner.onRateRead = (child) => {
      repo.updateProviderAccount(account.id, { profile_ref: 'native-profile://codex/rebound' });
      child.reply({ id: 2, result: QUOTA_RESULT });
    };
    expect((await service.refreshAccount(account.id)).status).toBe('UNAVAILABLE');
    expectUnknown(resource.id);
    expect(service.getLatestObservations()).toEqual([]);
  });

  it('allows a provider-reported exhausted zero without turning it into an account health decision', async () => {
    const { account, resource } = createAccount();
    const before = healthSnapshot();
    spawner.result = { rateLimits: { primary: { usedPercent: 100, resetsAt: null, windowDurationMins: null } } };
    expect(await service.refreshAccount(account.id)).toMatchObject({ status: 'OK', remainingPercent: 0, resetsAt: null });
    expect(repo.getProviderResource(resource.id)).toMatchObject({ remaining_quota: 0, quota_source: 'PROVIDER_REPORTED' });
    expect(healthSnapshot()).toEqual(before);
  });

  it('polls immediately, unrefs the timer, skips overlapping ticks/explicit reads, and stops cleanly', async () => {
    const { account } = createAccount();
    let tick = () => undefined as void;
    const handle = { unref: vi.fn() };
    const timer: QuotaPollTimer = {
      setInterval: vi.fn((callback) => { tick = callback; return handle; }),
      clearInterval: vi.fn(),
    };
    service = makeService(timer);
    let pendingChild: FakeCodexProcess | null = null;
    spawner.onRateRead = (child) => { pendingChild = child; };
    service.start();
    service.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(spawner.spawn).toHaveBeenCalledOnce();
    const explicitAll = service.refreshAll();
    const explicitAccount = service.refreshAccount(account.id);
    tick(); tick(); tick();
    expect(spawner.spawn).toHaveBeenCalledOnce();
    expect(pendingChild).not.toBeNull();
    (pendingChild as unknown as FakeCodexProcess).reply({ id: 2, result: QUOTA_RESULT });
    expect((await explicitAccount).status).toBe('OK');
    expect(await explicitAll).toHaveLength(1);
    spawner.onRateRead = null;
    tick();
    await service.refreshAll();
    expect(spawner.spawn).toHaveBeenCalledTimes(2);
    service.stop(); service.stop(); tick();
    expect(spawner.spawn).toHaveBeenCalledTimes(2);
    expect(timer.setInterval).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 5 * 60_000);
    expect(handle.unref).toHaveBeenCalledOnce();
    expect(timer.clearInterval).toHaveBeenCalledExactlyOnceWith(handle);
  });

  it('bounds automatic intervals and clears the real Node timer on stop', async () => {
    vi.useFakeTimers();
    for (const interval of [0, -1, 29_999, 3_600_001, NaN, Infinity, 30_000.5]) {
      expect(() => service.start(interval)).toThrow(RangeError);
    }
    service.start(30_000);
    await service.refreshAll();
    expect(vi.getTimerCount()).toBe(1);
    service.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds automatic process fan-out across multiple accounts', async () => {
    createAccount(); createAccount();
    let active = 0;
    let peak = 0;
    spawner.onRateRead = (child) => {
      active += 1;
      peak = Math.max(peak, active);
      queueMicrotask(() => { active -= 1; child.reply({ id: 2, result: QUOTA_RESULT }); });
    };
    expect(await service.refreshAll()).toHaveLength(2);
    expect(spawner.spawn).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
  });
});
