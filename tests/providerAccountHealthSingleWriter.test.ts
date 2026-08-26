import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DatabaseEngine } from '../src/core/database/db';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ProviderAccount, ProviderHealthStatus } from '../src/core/types/domain';

describe('R5H4 Provider Account Health Single-Writer Contract Tests', () => {
  let db: Database.Database;
  let dbEngine: DatabaseEngine;
  let repo: Repository;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(__dirname, `test_health_single_writer_${Date.now()}_${Math.random().toString(36).substring(7)}.db`);
    dbEngine = new DatabaseEngine(dbPath);
    db = dbEngine.init();
    MigrationRunner.run(db);
    repo = new Repository(db);

    // Seed dummy provider
    repo.createProvider({
      id: 'prov-test',
      name: 'Test Provider',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      const wal = `${dbPath}-wal`;
      const shm = `${dbPath}-shm`;
      if (fs.existsSync(wal)) fs.unlinkSync(wal);
      if (fs.existsSync(shm)) fs.unlinkSync(shm);
    } catch {
      // ignore
    }
  });

  function createTestAccount(id: string, initialHealth: ProviderHealthStatus = 'AVAILABLE'): ProviderAccount {
    const now = new Date().toISOString();
    const account: ProviderAccount = {
      id,
      provider_id: 'prov-test',
      label: 'Test Account Initial',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: 'wincred://agentforge/test/initial',
      profile_ref: null,
      enabled: true,
      priority: 10,
      health_status: initialHealth,
      cooldown_until: null,
      concurrency_limit: 2,
      last_success_at: initialHealth === 'AVAILABLE' ? now : null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: now,
      updated_at: now,
    };
    repo.createProviderAccount(account);
    return account;
  }

  // =========================================================================
  // 1-5. Type & contract boundaries: generic updater excludes health fields
  // =========================================================================

  it('1. generic updater type/source excludes health_status', () => {
    const reposSource = fs.readFileSync(path.join(__dirname, '../src/core/database/repositories.ts'), 'utf-8');
    const updateMethodMatch = reposSource.match(/public updateProviderAccount\([\s\S]*?\): void \{/);
    expect(updateMethodMatch).not.toBeNull();
    const methodSignature = updateMethodMatch![0];
    expect(methodSignature).not.toContain("'health_status'");
  });

  it('2. generic updater type/source excludes cooldown_until', () => {
    const reposSource = fs.readFileSync(path.join(__dirname, '../src/core/database/repositories.ts'), 'utf-8');
    const updateMethodMatch = reposSource.match(/public updateProviderAccount\([\s\S]*?\): void \{/);
    expect(updateMethodMatch).not.toBeNull();
    const methodSignature = updateMethodMatch![0];
    expect(methodSignature).not.toContain("'cooldown_until'");
  });

  it('3. generic updater type/source excludes last_success_at', () => {
    const reposSource = fs.readFileSync(path.join(__dirname, '../src/core/database/repositories.ts'), 'utf-8');
    const updateMethodMatch = reposSource.match(/public updateProviderAccount\([\s\S]*?\): void \{/);
    expect(updateMethodMatch).not.toBeNull();
    const methodSignature = updateMethodMatch![0];
    expect(methodSignature).not.toContain("'last_success_at'");
  });

  it('4. generic updater type/source excludes last_failure_at', () => {
    const reposSource = fs.readFileSync(path.join(__dirname, '../src/core/database/repositories.ts'), 'utf-8');
    const updateMethodMatch = reposSource.match(/public updateProviderAccount\([\s\S]*?\): void \{/);
    expect(updateMethodMatch).not.toBeNull();
    const methodSignature = updateMethodMatch![0];
    expect(methodSignature).not.toContain("'last_failure_at'");
  });

  it('5. generic updater type/source excludes last_failure_code', () => {
    const reposSource = fs.readFileSync(path.join(__dirname, '../src/core/database/repositories.ts'), 'utf-8');
    const updateMethodMatch = reposSource.match(/public updateProviderAccount\([\s\S]*?\): void \{/);
    expect(updateMethodMatch).not.toBeNull();
    const methodSignature = updateMethodMatch![0];
    expect(methodSignature).not.toContain("'last_failure_code'");
  });

  // =========================================================================
  // 6-10. Config updates preserve existing health fields
  // =========================================================================

  it('6. label update preserves health_status', () => {
    createTestAccount('acct-6', 'RATE_LIMITED');
    repo.updateProviderAccount('acct-6', { label: 'New Label 6' });
    const acct = repo.getProviderAccount('acct-6');
    expect(acct?.label).toBe('New Label 6');
    expect(acct?.health_status).toBe('RATE_LIMITED');
  });

  it('7. priority update preserves health', () => {
    createTestAccount('acct-7', 'AUTH_ERROR');
    repo.updateProviderAccount('acct-7', { priority: 99 });
    const acct = repo.getProviderAccount('acct-7');
    expect(acct?.priority).toBe(99);
    expect(acct?.health_status).toBe('AUTH_ERROR');
  });

  it('8. concurrency update preserves health', () => {
    createTestAccount('acct-8', 'QUOTA_EXHAUSTED');
    repo.updateProviderAccount('acct-8', { concurrency_limit: 8 });
    const acct = repo.getProviderAccount('acct-8');
    expect(acct?.concurrency_limit).toBe(8);
    expect(acct?.health_status).toBe('QUOTA_EXHAUSTED');
  });

  it('9. enabled update preserves health', () => {
    createTestAccount('acct-9', 'COOLDOWN');
    repo.updateProviderAccount('acct-9', { enabled: false });
    const acct = repo.getProviderAccount('acct-9');
    expect(acct?.enabled).toBe(false);
    expect(acct?.health_status).toBe('COOLDOWN');
  });

  it('10. auth/profile config update preserves health', () => {
    createTestAccount('acct-10', 'UNHEALTHY');
    repo.updateProviderAccount('acct-10', { credential_ref: 'wincred://agentforge/test/updated-key' });
    const acct = repo.getProviderAccount('acct-10');
    expect(acct?.credential_ref).toBe('wincred://agentforge/test/updated-key');
    expect(acct?.health_status).toBe('UNHEALTHY');
  });

  // =========================================================================
  // 11-15. Runtime forged extra fields are completely ignored
  // =========================================================================

  it('11. forged runtime health_status ignored', () => {
    createTestAccount('acct-11', 'AUTH_ERROR');
    repo.updateProviderAccount('acct-11', { label: 'Updated Label', health_status: 'AVAILABLE' } as any);
    const acct = repo.getProviderAccount('acct-11');
    expect(acct?.label).toBe('Updated Label');
    expect(acct?.health_status).toBe('AUTH_ERROR');
  });

  it('12. forged runtime cooldown ignored', () => {
    createTestAccount('acct-12', 'AVAILABLE');
    const forgedCooldown = '2099-01-01T00:00:00.000Z';
    repo.updateProviderAccount('acct-12', { label: 'Updated Label', cooldown_until: forgedCooldown } as any);
    const acct = repo.getProviderAccount('acct-12');
    expect(acct?.cooldown_until).toBeNull();
  });

  it('13. forged runtime last_success ignored', () => {
    createTestAccount('acct-13', 'AUTH_ERROR');
    const forgedSuccess = '2099-01-01T00:00:00.000Z';
    repo.updateProviderAccount('acct-13', { priority: 5, last_success_at: forgedSuccess } as any);
    const acct = repo.getProviderAccount('acct-13');
    expect(acct?.last_success_at).toBeNull();
  });

  it('14. forged runtime last_failure ignored', () => {
    createTestAccount('acct-14', 'AVAILABLE');
    const forgedFailure = '2099-01-01T00:00:00.000Z';
    repo.updateProviderAccount('acct-14', { priority: 5, last_failure_at: forgedFailure } as any);
    const acct = repo.getProviderAccount('acct-14');
    expect(acct?.last_failure_at).toBeNull();
  });

  it('15. forged runtime failure_code ignored', () => {
    createTestAccount('acct-15', 'AVAILABLE');
    repo.updateProviderAccount('acct-15', { priority: 5, last_failure_code: 'RATE_LIMITED' } as any);
    const acct = repo.getProviderAccount('acct-15');
    expect(acct?.last_failure_code).toBeNull();
  });

  // =========================================================================
  // 16-20. Stale-read clobber proofs
  // =========================================================================

  it('16. stale-read AUTH_ERROR interleaving survives config update', () => {
    createTestAccount('acct-16', 'AVAILABLE');
    const originalGet = repo.getProviderAccount.bind(repo);

    // Monkey-patch to inject health mutation between snapshot read and SQL UPDATE
    repo.getProviderAccount = (id: string) => {
      const snapshot = originalGet(id);
      // Another connection/writer updates health to AUTH_ERROR
      const secondDb = new Database(dbPath);
      const secondRepo = new Repository(secondDb);
      secondRepo.updateProviderAccountHealth('acct-16', 'AUTH_ERROR', null, 'AUTHENTICATION_FAILURE');
      secondDb.close();
      return snapshot;
    };

    repo.updateProviderAccount('acct-16', { label: 'Updated Config Only' });
    repo.getProviderAccount = originalGet;

    const acct = repo.getProviderAccount('acct-16');
    expect(acct?.label).toBe('Updated Config Only');
    expect(acct?.health_status).toBe('AUTH_ERROR');
    expect(acct?.last_failure_code).toBe('AUTHENTICATION_FAILURE');
  });

  it('17. stale-read last_failure_code survives', () => {
    createTestAccount('acct-17', 'AVAILABLE');
    const originalGet = repo.getProviderAccount.bind(repo);

    repo.getProviderAccount = (id: string) => {
      const snapshot = originalGet(id);
      const secondDb = new Database(dbPath);
      const secondRepo = new Repository(secondDb);
      secondRepo.updateProviderAccountHealth('acct-17', 'RATE_LIMITED', '2099-01-01T00:00:00.000Z', 'RATE_LIMITED');
      secondDb.close();
      return snapshot;
    };

    repo.updateProviderAccount('acct-17', { priority: 42 });
    repo.getProviderAccount = originalGet;

    const acct = repo.getProviderAccount('acct-17');
    expect(acct?.priority).toBe(42);
    expect(acct?.health_status).toBe('RATE_LIMITED');
    expect(acct?.last_failure_code).toBe('RATE_LIMITED');
    expect(acct?.cooldown_until).toBe('2099-01-01T00:00:00.000Z');
  });

  it('18. RATE_LIMITED cooldown survives config update', () => {
    createTestAccount('acct-18', 'AVAILABLE');
    const cooldownDate = new Date(Date.now() + 60000).toISOString();
    repo.updateProviderAccountHealth('acct-18', 'RATE_LIMITED', cooldownDate, 'RATE_LIMITED');

    repo.updateProviderAccount('acct-18', { label: 'Changed Label' });
    const acct = repo.getProviderAccount('acct-18');
    expect(acct?.label).toBe('Changed Label');
    expect(acct?.health_status).toBe('RATE_LIMITED');
    expect(acct?.cooldown_until).toBe(cooldownDate);
    expect(acct?.last_failure_code).toBe('RATE_LIMITED');
  });

  it('19. last_failure_at survives config update', () => {
    createTestAccount('acct-19', 'AVAILABLE');
    repo.updateProviderAccountHealth('acct-19', 'AUTH_ERROR', null, 'AUTHENTICATION_FAILURE');
    const beforeConfig = repo.getProviderAccount('acct-19');
    const failureTimestamp = beforeConfig?.last_failure_at;
    expect(failureTimestamp).not.toBeNull();

    repo.updateProviderAccount('acct-19', { concurrency_limit: 10 });
    const afterConfig = repo.getProviderAccount('acct-19');
    expect(afterConfig?.concurrency_limit).toBe(10);
    expect(afterConfig?.last_failure_at).toBe(failureTimestamp);
  });

  it('20. last_success_at survives config update', () => {
    createTestAccount('acct-20', 'AVAILABLE');
    const beforeConfig = repo.getProviderAccount('acct-20');
    const successTimestamp = beforeConfig?.last_success_at;
    expect(successTimestamp).not.toBeNull();

    repo.updateProviderAccount('acct-20', { priority: 77 });
    const afterConfig = repo.getProviderAccount('acct-20');
    expect(afterConfig?.priority).toBe(77);
    expect(afterConfig?.last_success_at).toBe(successTimestamp);
  });

  // =========================================================================
  // 21-24. Control plane & architectural containment scans
  // =========================================================================

  it('21. raw health primitive does not modify enabled', () => {
    createTestAccount('acct-21', 'AVAILABLE');
    repo.updateProviderAccount('acct-21', { enabled: false });
    expect(repo.getProviderAccount('acct-21')?.enabled).toBe(false);

    // Call updateProviderAccountHealth to AVAILABLE
    repo.updateProviderAccountHealth('acct-21', 'AVAILABLE');
    expect(repo.getProviderAccount('acct-21')?.enabled).toBe(false);

    // Call updateProviderAccountHealth to AUTH_ERROR
    repo.updateProviderAccountHealth('acct-21', 'AUTH_ERROR', null, 'AUTHENTICATION_FAILURE');
    expect(repo.getProviderAccount('acct-21')?.enabled).toBe(false);
  });

  it('22. AccountHealthService is sole production raw-health caller', () => {
    const srcDir = path.join(__dirname, '../src');
    function getFiles(dir: string): string[] {
      let results: string[] = [];
      const list = fs.readdirSync(dir);
      list.forEach((file) => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat && stat.isDirectory()) {
          results = results.concat(getFiles(filePath));
        } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
          results.push(filePath);
        }
      });
      return results;
    }

    const allSrcFiles = getFiles(srcDir);
    const callers: string[] = [];
    allSrcFiles.forEach((file) => {
      const content = fs.readFileSync(file, 'utf-8');
      if (content.includes('.updateProviderAccountHealth(')) {
        callers.push(path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/'));
      }
    });

    // Allowed caller is ONLY AccountHealthService.ts
    expect(callers).toEqual(['src/core/services/AccountHealthService.ts']);
  });

  it('23. no direct account-health SQL outside repositories', () => {
    const srcDir = path.join(__dirname, '../src');
    function getFiles(dir: string): string[] {
      let results: string[] = [];
      const list = fs.readdirSync(dir);
      list.forEach((file) => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat && stat.isDirectory()) {
          results = results.concat(getFiles(filePath));
        } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
          results.push(filePath);
        }
      });
      return results;
    }

    const allSrcFiles = getFiles(srcDir);
    const sqlWriters: string[] = [];
    allSrcFiles.forEach((file) => {
      const content = fs.readFileSync(file, 'utf-8');
      if (content.includes('UPDATE provider_accounts') && file.indexOf('repositories.ts') === -1) {
        sqlWriters.push(path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/'));
      }
    });

    expect(sqlWriters).toEqual([]);
  });

  it('24. AccountHealthService not production-instantiated', () => {
    const srcDir = path.join(__dirname, '../src');
    function getFiles(dir: string): string[] {
      let results: string[] = [];
      const list = fs.readdirSync(dir);
      list.forEach((file) => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat && stat.isDirectory()) {
          results = results.concat(getFiles(filePath));
        } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
          results.push(filePath);
        }
      });
      return results;
    }

    const allSrcFiles = getFiles(srcDir);
    const instantiations: string[] = [];
    allSrcFiles.forEach((file) => {
      const content = fs.readFileSync(file, 'utf-8');
      if (content.includes('new AccountHealthService(')) {
        instantiations.push(path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/'));
      }
    });

    expect(instantiations).toEqual([]);
  });

  // =========================================================================
  // 25-28. Additional contract verifications
  // =========================================================================

  it('25. creation can initialize health', () => {
    const now = new Date().toISOString();
    const created: ProviderAccount = {
      id: 'acct-25',
      provider_id: 'prov-test',
      label: 'Initial Cooldown Account',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: 'wincred://agentforge/test/init25',
      profile_ref: null,
      enabled: true,
      priority: 5,
      health_status: 'COOLDOWN',
      cooldown_until: '2099-01-01T00:00:00.000Z',
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: now,
      last_failure_code: 'RATE_LIMITED',
      created_at: now,
      updated_at: now,
    };
    repo.createProviderAccount(created);

    const fetched = repo.getProviderAccount('acct-25');
    expect(fetched?.health_status).toBe('COOLDOWN');
    expect(fetched?.cooldown_until).toBe('2099-01-01T00:00:00.000Z');
    expect(fetched?.last_failure_code).toBe('RATE_LIMITED');
  });

  it('26. observation service still does not mutate account health', () => {
    const observationServiceSource = fs.readFileSync(
      path.join(__dirname, '../src/core/services/ProviderHealthObservationService.ts'),
      'utf-8'
    );
    expect(observationServiceSource).not.toContain('updateProviderAccountHealth');
    expect(observationServiceSource).not.toContain('updateProviderAccount');
    expect(observationServiceSource).not.toContain('AccountHealthService');
  });

  it('27. preload exposes no account-health mutation API', () => {
    const preloadSource = fs.readFileSync(path.join(__dirname, '../src/electron/preload.ts'), 'utf-8');
    expect(preloadSource).not.toContain('updateProviderAccountHealth');
    expect(preloadSource).not.toContain('updateProviderAccount');
  });

  it('28. architecture records single-writer semantics', () => {
    const archSource = fs.readFileSync(
      path.join(__dirname, '../docs/R5_AGENT_FABRIC_ARCHITECTURE.md'),
      'utf-8'
    );
    expect(archSource).toContain('R5H Provider Account Health Single-Writer Authority');
    expect(archSource).toContain('AccountHealthService');
    expect(archSource).toContain('Repository.updateProviderAccountHealth');
    expect(archSource).toContain('updateProviderAccount');
  });
});
