import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';
import { NativeProfileResolver } from '../src/core/credentials/NativeProfileResolver';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { AccountQuotaService } from '../src/core/services/AccountQuotaService';
import { CodexQuotaClient } from '../src/core/services/CodexQuotaClient';
import { WorkspaceManagementService } from '../src/core/services/WorkspaceManagementService';
import { buildQuotaGroups, countdown, toneFor, windowKind } from '../src/ui/quotaDashboard';
import type { QuotaObservation } from '../src/core/types/quota';
import { FakeCodexSpawner } from './quotaFakes';

const NOW = '2026-10-25T08:00:00.000Z';

describe('router-style quota dashboard view model (#243)', () => {
  it('colours remaining capacity like a router and never guesses unknown values', () => {
    expect([toneFor(80), toneFor(50), toneFor(20), toneFor(5), toneFor(null)]).toEqual(['GOOD', 'WARN', 'WARN', 'LOW', 'UNKNOWN']);
    expect([windowKind(300), windowKind(1440), windowKind(10080), windowKind(90), windowKind(null)]).toEqual(['FIVE_HOUR', 'DAY', 'WEEK', 'MINUTES', 'LIMIT']);
  });

  it('counts down to a reset and stops at the reset', () => {
    const now = Date.parse(NOW);
    expect(countdown('2026-10-25T10:15:00.000Z', now)).toEqual({ days: 0, hours: 2, minutes: 15 });
    expect(countdown('2026-10-27T09:00:00.000Z', now)).toEqual({ days: 2, hours: 1, minutes: 0 });
    expect(countdown('2026-10-25T07:00:00.000Z', now)).toBeNull();
    expect(countdown(null, now)).toBeNull();
  });

  it('groups cards by CLI and counts only accounts that can be scheduled now', () => {
    const base = { resourceIds: [] as string[], usedPercent: null, remainingPercent: null, resetsAt: null, windowMinutes: null, secondary: null,
      planType: null, observedAt: NOW, message: null };
    const observations: QuotaObservation[] = [
      { ...base, accountId: 'codex-1', providerId: 'prov-codex-cli', status: 'OK', source: 'PROVIDER_REPORTED', healthStatus: 'AVAILABLE',
        usedPercent: 40, remainingPercent: 60, windowMinutes: 300, resetsAt: '2026-10-25T10:00:00.000Z', planType: 'plus',
        secondary: { usedPercent: 90, remainingPercent: 10, windowMinutes: 10080, resetsAt: '2026-10-30T00:00:00.000Z' } },
      { ...base, accountId: 'claude-1', providerId: 'prov-claude-code-cli', status: 'OK', source: 'OBSERVED', healthStatus: 'QUOTA_EXHAUSTED',
        usedPercent: 100, remainingPercent: 0, resetsAt: '2026-10-25T12:00:00.000Z' },
      { ...base, accountId: 'claude-2', providerId: 'prov-claude-code-cli', status: 'UNSUPPORTED', source: 'UNKNOWN', healthStatus: 'AVAILABLE' },
      { ...base, accountId: 'gemini-1', providerId: 'prov-gemini-cli', status: 'UNAUTHENTICATED', source: 'UNKNOWN', healthStatus: 'AUTH_ERROR' },
    ];
    const groups = buildQuotaGroups(observations, [], [], Date.parse(NOW));

    expect(groups.map((group) => [group.cli, group.usable, group.total])).toEqual([['CODEX', 1, 1], ['CLAUDE', 1, 2], ['GEMINI', 0, 1]]);
    const codex = groups[0].cards[0];
    expect(codex.windows.map((window) => [window.kind, window.remainingPercent, window.tone])).toEqual([['FIVE_HOUR', 60, 'GOOD'], ['WEEK', 10, 'LOW']]);
    expect(codex.plan).toBe('plus');
    const [limited, unknown] = groups[1].cards;
    expect(limited).toMatchObject({ usable: false, source: 'OBSERVED', windows: [{ kind: 'LIMIT', remainingPercent: 0 }] });
    expect(unknown).toMatchObject({ usable: true, windows: [] }); // No numbers invented.
  });
});

describe('quota observations for CLIs without an official reader (#243)', () => {
  let db: Database.Database;
  let repo: Repository;
  let service: AccountQuotaService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    service = new AccountQuotaService(repo, {
      codexReader: new CodexQuotaClient({ spawner: new FakeCodexSpawner(), resolveExecutable: () => path.join(os.tmpdir(), 'fake-codex.exe'), timeoutMs: 100 }),
      profileResolver: new NativeProfileResolver({ baseProfilesDir: path.join(os.tmpdir(), 'af-quota-dashboard-profiles') }),
      now: () => NOW, initializeVerifiedAccounts: true,
    });
  });
  afterEach(() => { service.stop(); db.close(); });

  const claudeAccount = () => {
    const created = new WorkspaceManagementService(repo, () => NOW).createAgent({
      displayName: 'Claude coder', role: 'CODER', connection: 'CLAUDE_CODE_CLI', modelName: 'claude-sonnet-4-5', workerSlots: 1,
    });
    if (!created.success) throw new Error('agent not created');
    const resource = repo.getProviderResource(created.agent.provider_resource_id!)!;
    return { accountId: resource.provider_account_id!, resourceId: resource.id };
  };

  it('shows a limit a run reached as exhausted until its reset, without storing it as provider-reported quota', async () => {
    const { accountId, resourceId } = claudeAccount();
    db.prepare("UPDATE provider_accounts SET health_status = 'QUOTA_EXHAUSTED', cooldown_until = ? WHERE id = ?").run('2026-10-25T12:00:00.000Z', accountId);

    const observation = await service.refreshAccount(accountId);
    expect(observation).toMatchObject({ status: 'OK', source: 'OBSERVED', remainingPercent: 0, resetsAt: '2026-10-25T12:00:00.000Z', healthStatus: 'QUOTA_EXHAUSTED' });
    expect(repo.getProviderResource(resourceId)!.quota_source).not.toBe('PROVIDER_REPORTED');
    expect(repo.getProviderAccount(accountId)!.health_status).toBe('QUOTA_EXHAUSTED');
  });

  it('never initializes an unverified account from an observation and keeps unknown as unknown', async () => {
    const { accountId } = claudeAccount();
    const observation = await service.refreshAccount(accountId);
    expect(observation).toMatchObject({ status: 'UNSUPPORTED', source: 'UNKNOWN', remainingPercent: null, healthStatus: 'UNKNOWN' });
    expect(repo.getProviderAccount(accountId)!.health_status).toBe('UNKNOWN');

    db.prepare("UPDATE provider_accounts SET health_status = 'AUTH_ERROR' WHERE id = ?").run(accountId);
    expect(await service.refreshAccount(accountId)).toMatchObject({ status: 'UNAUTHENTICATED', source: 'UNKNOWN' });
  });
});
