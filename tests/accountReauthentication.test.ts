import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { AccountHealthService } from '../src/core/services/AccountHealthService';
import { AccountQuotaService } from '../src/core/services/AccountQuotaService';
import { CodexQuotaClient } from '../src/core/services/CodexQuotaClient';
import { WorkspaceManagementService } from '../src/core/services/WorkspaceManagementService';
import { NativeProfileResolver } from '../src/core/credentials/NativeProfileResolver';
import { FakeCodexSpawner } from './quotaFakes';

/** #247: an expired CLI login is recovered only through the single health writer, after a real check. */
describe('expired-login recovery through the single health writer (#247)', () => {
  let db: Database.Database;
  let repo: Repository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
  });
  afterEach(() => db.close());

  const account = (connection: 'CODEX_CLI' | 'CLAUDE_CODE_CLI' = 'CLAUDE_CODE_CLI') => {
    const created = new WorkspaceManagementService(repo).createAgent({ displayName: `${connection} agent`, role: 'CODER', connection, modelName: 'model', workerSlots: 1 });
    if (!created.success) throw new Error('agent not created');
    const resource = repo.getProviderResource(created.agent.provider_resource_id!)!;
    return repo.getProviderAccount(resource.provider_account_id!)!;
  };
  const expectedOf = (acct: ReturnType<typeof account>) => ({ providerId: acct.provider_id, profileRef: acct.profile_ref! });
  const setHealth = (id: string, status: string, extra = '') => db.prepare(`UPDATE provider_accounts SET health_status = ?${extra} WHERE id = ?`).run(status, id);

  it('turns AUTH_ERROR into AVAILABLE for exactly the same account identity', () => {
    const acct = account();
    setHealth(acct.id, 'AUTH_ERROR', ", last_failure_code = 'AUTH_ERROR'");
    const health = AccountHealthService.create(repo);
    expect(health.recordReauthenticated(acct.id, { ...expectedOf(acct), profileRef: 'native-profile://claude/someone-else' })).toBe(false);
    expect(repo.getProviderAccount(acct.id)!.health_status).toBe('AUTH_ERROR');
    expect(health.recordReauthenticated(acct.id, expectedOf(acct))).toBe(true);
    expect(repo.getProviderAccount(acct.id)).toMatchObject({ health_status: 'AVAILABLE', last_failure_code: null });
  });

  it.each(['QUOTA_EXHAUSTED', 'RATE_LIMITED', 'COOLDOWN', 'UNKNOWN', 'AVAILABLE'])('never changes %s', (status) => {
    const acct = account();
    setHealth(acct.id, status);
    expect(AccountHealthService.create(repo).recordReauthenticated(acct.id, expectedOf(acct))).toBe(false);
    expect(repo.getProviderAccount(acct.id)!.health_status).toBe(status);
  });

  it('refuses while a cooldown is recorded', () => {
    const acct = account();
    setHealth(acct.id, 'AUTH_ERROR', ", cooldown_until = '2999-01-01T00:00:00.000Z'");
    expect(AccountHealthService.create(repo).recordReauthenticated(acct.id, expectedOf(acct))).toBe(false);
  });

  it('recovers a Codex login when an authenticated official quota read succeeds', async () => {
    const acct = account('CODEX_CLI');
    setHealth(acct.id, 'AUTH_ERROR', ", last_failure_code = 'AUTH_ERROR'");
    const spawner = new FakeCodexSpawner();
    const service = new AccountQuotaService(repo, {
      codexReader: new CodexQuotaClient({ spawner, resolveExecutable: () => path.join(os.tmpdir(), 'fake-codex.exe'), timeoutMs: 100 }),
      profileResolver: new NativeProfileResolver({ baseProfilesDir: path.join(os.tmpdir(), 'af-reauth-profiles') }),
      initializeVerifiedAccounts: true,
    });
    expect(await service.refreshAccount(acct.id)).toMatchObject({ status: 'OK', source: 'PROVIDER_REPORTED' });
    expect(repo.getProviderAccount(acct.id)!.health_status).toBe('AVAILABLE');
    service.stop();
  });
});
