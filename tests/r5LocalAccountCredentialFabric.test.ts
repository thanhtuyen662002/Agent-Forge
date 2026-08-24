import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import util from 'util';
import crypto from 'crypto';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import {
  SecretValue,
  redactSecretString,
  safeFormatDiagnostic,
  CredentialRef,
  parseCredentialRef,
  isValidCredentialRef,
  CredentialStore,
  InMemoryCredentialStore,
  WindowsCredentialStore,
  CRED_MAX_CREDENTIAL_BLOB_SIZE,
  NativeProfileRef,
  parseNativeProfileRef,
  isValidNativeProfileRef,
  NativeProfileResolver,
} from '../src/core/credentials';
import { ProviderAccount, Provider } from '../src/core/types/domain';

describe('R5C Local Account & Credential Fabric Test Suite', () => {
  let db: Database.Database;
  let repo: Repository;

  beforeEach(() => {
    db = new Database(':memory:');
    MigrationRunner.run(db);
    repo = new Repository(db);
  });

  afterEach(() => {
    db.close();
  });

  // Helper to create a provider
  function seedProvider(id: string = 'prov-openai'): Provider {
    const prov: Provider = {
      id,
      name: 'OpenAI Provider',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    repo.createProvider(prov);
    return prov;
  }

  // -------------------------------------------------------------
  // 1. create API_CREDENTIAL with plaintext credential_ref is rejected
  // -------------------------------------------------------------
  it('1. create API_CREDENTIAL with plaintext credential_ref is rejected', () => {
    seedProvider('prov-1');
    expect(() => {
      repo.createProviderAccount({
        id: 'acct-plaintext',
        provider_id: 'prov-1',
        label: 'Plaintext Account',
        auth_mode: 'API_CREDENTIAL',
        credential_ref: 'sk-live-super-secret-key-12345',
        profile_ref: null,
        enabled: true,
        priority: 1,
        health_status: 'AVAILABLE',
        cooldown_until: null,
        concurrency_limit: 1,
        last_success_at: null,
        last_failure_at: null,
        last_failure_code: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }).toThrow(/missing valid "scheme:\/\/" prefix/);
  });

  // -------------------------------------------------------------
  // 2. create API_CREDENTIAL with arbitrary legacy handle is rejected
  // -------------------------------------------------------------
  it('2. create API_CREDENTIAL with arbitrary legacy handle is rejected', () => {
    seedProvider('prov-2');
    expect(() => {
      repo.createProviderAccount({
        id: 'acct-legacy-write',
        provider_id: 'prov-2',
        label: 'Legacy Write Account',
        auth_mode: 'API_CREDENTIAL',
        credential_ref: 'cred-handle-0912',
        profile_ref: null,
        enabled: true,
        priority: 1,
        health_status: 'AVAILABLE',
        cooldown_until: null,
        concurrency_limit: 1,
        last_success_at: null,
        last_failure_at: null,
        last_failure_code: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }).toThrow(/missing valid "scheme:\/\/" prefix/);
  });

  // -------------------------------------------------------------
  // 3. create NATIVE_PROFILE with arbitrary filesystem/profile string is rejected
  // -------------------------------------------------------------
  it('3. create NATIVE_PROFILE with arbitrary filesystem/profile string is rejected', () => {
    seedProvider('prov-3');
    expect(() => {
      repo.createProviderAccount({
        id: 'acct-path-profile',
        provider_id: 'prov-3',
        label: 'File Path Account',
        auth_mode: 'NATIVE_PROFILE',
        credential_ref: null,
        profile_ref: 'C:\\Users\\Admin\\.codex\\auth.json',
        enabled: true,
        priority: 1,
        health_status: 'AVAILABLE',
        cooldown_until: null,
        concurrency_limit: 1,
        last_success_at: null,
        last_failure_at: null,
        last_failure_code: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }).toThrow(/missing valid "scheme:\/\/" prefix/);
  });

  // -------------------------------------------------------------
  // 4. credential_ref containing native-profile URI is rejected
  // -------------------------------------------------------------
  it('4. credential_ref containing native-profile URI is rejected', () => {
    seedProvider('prov-4');
    expect(() => {
      repo.createProviderAccount({
        id: 'acct-cross-scheme-1',
        provider_id: 'prov-4',
        label: 'Cross Scheme Account 1',
        auth_mode: 'API_CREDENTIAL',
        credential_ref: 'native-profile://codex/c01',
        profile_ref: null,
        enabled: true,
        priority: 1,
        health_status: 'AVAILABLE',
        cooldown_until: null,
        concurrency_limit: 1,
        last_success_at: null,
        last_failure_at: null,
        last_failure_code: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }).toThrow(/Unsupported credential scheme "native-profile"/);
  });

  // -------------------------------------------------------------
  // 5. profile_ref containing wincred URI is rejected
  // -------------------------------------------------------------
  it('5. profile_ref containing wincred URI is rejected', () => {
    seedProvider('prov-5');
    expect(() => {
      repo.createProviderAccount({
        id: 'acct-cross-scheme-2',
        provider_id: 'prov-5',
        label: 'Cross Scheme Account 2',
        auth_mode: 'NATIVE_PROFILE',
        credential_ref: null,
        profile_ref: 'wincred://agentforge/openai/key',
        enabled: true,
        priority: 1,
        health_status: 'AVAILABLE',
        cooldown_until: null,
        concurrency_limit: 1,
        last_success_at: null,
        last_failure_at: null,
        last_failure_code: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }).toThrow(/Unsupported profile scheme "wincred"/);
  });

  // -------------------------------------------------------------
  // 6. case/alternate malformed credential scheme cannot bypass validation
  // -------------------------------------------------------------
  it('6. case/alternate malformed credential scheme cannot bypass validation', () => {
    // Upper case scheme canonicalizes properly but invalid target structure fails
    expect(() => parseCredentialRef('WINCRED://invalid-no-namespace')).toThrow(
      /target must start with canonical namespace "agentforge\/"/
    );
    expect(() => parseCredentialRef('wincred://agentforge:openai:key')).toThrow(
      /colons are forbidden in target path/
    );
    expect(() => parseCredentialRef('wincred://agentforge/openai\\key')).toThrow(
      /backslashes are forbidden/
    );
  });

  // -------------------------------------------------------------
  // 7. enabled API_CREDENTIAL without credential_ref is rejected
  // -------------------------------------------------------------
  it('7. enabled API_CREDENTIAL without credential_ref is rejected', () => {
    seedProvider('prov-7');
    expect(() => {
      repo.createProviderAccount({
        id: 'acct-enabled-no-cred',
        provider_id: 'prov-7',
        label: 'Enabled No Cred',
        auth_mode: 'API_CREDENTIAL',
        credential_ref: null,
        profile_ref: null,
        enabled: true,
        priority: 1,
        health_status: 'AVAILABLE',
        cooldown_until: null,
        concurrency_limit: 1,
        last_success_at: null,
        last_failure_at: null,
        last_failure_code: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }).toThrow(/enabled auth_mode "API_CREDENTIAL" requires a valid canonical credential_ref/);

    // Unconfigured account (enabled === false) is allowed to have null credential_ref
    expect(() => {
      repo.createProviderAccount({
        id: 'acct-disabled-unconfigured',
        provider_id: 'prov-7',
        label: 'Disabled Unconfigured',
        auth_mode: 'API_CREDENTIAL',
        credential_ref: null,
        profile_ref: null,
        enabled: false,
        priority: 1,
        health_status: 'AVAILABLE',
        cooldown_until: null,
        concurrency_limit: 1,
        last_success_at: null,
        last_failure_at: null,
        last_failure_code: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }).not.toThrow();
  });

  // -------------------------------------------------------------
  // 8. enabled NATIVE_PROFILE without profile_ref is rejected
  // -------------------------------------------------------------
  it('8. enabled NATIVE_PROFILE without profile_ref is rejected', () => {
    seedProvider('prov-8');
    expect(() => {
      repo.createProviderAccount({
        id: 'acct-enabled-no-prof',
        provider_id: 'prov-8',
        label: 'Enabled No Prof',
        auth_mode: 'NATIVE_PROFILE',
        credential_ref: null,
        profile_ref: null,
        enabled: true,
        priority: 1,
        health_status: 'AVAILABLE',
        cooldown_until: null,
        concurrency_limit: 1,
        last_success_at: null,
        last_failure_at: null,
        last_failure_code: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }).toThrow(/enabled auth_mode "NATIVE_PROFILE" requires a valid canonical profile_ref/);

    // Disabled unconfigured profile is allowed to have null profile_ref
    expect(() => {
      repo.createProviderAccount({
        id: 'acct-disabled-unconfigured-prof',
        provider_id: 'prov-8',
        label: 'Disabled Unconfigured Profile',
        auth_mode: 'NATIVE_PROFILE',
        credential_ref: null,
        profile_ref: null,
        enabled: false,
        priority: 1,
        health_status: 'AVAILABLE',
        cooldown_until: null,
        concurrency_limit: 1,
        last_success_at: null,
        last_failure_at: null,
        last_failure_code: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }).not.toThrow();
  });

  // -------------------------------------------------------------
  // 9. pre-R5C legacy row can still be read
  // -------------------------------------------------------------
  it('9. pre-R5C legacy row can still be read', () => {
    seedProvider('prov-9');
    // Direct SQL insert simulating historical pre-R5C data
    db.prepare(`
      INSERT INTO provider_accounts (
        id, provider_id, label, auth_mode, credential_ref, profile_ref,
        enabled, priority, health_status, cooldown_until, concurrency_limit,
        last_success_at, last_failure_at, last_failure_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'acct-pre-r5c-legacy',
      'prov-9',
      'Legacy Account',
      'API_CREDENTIAL',
      'legacy-opaque-handle-001',
      null,
      1,
      10,
      'AVAILABLE',
      null,
      1,
      null,
      null,
      null,
      new Date().toISOString(),
      new Date().toISOString()
    );

    const loaded = repo.getProviderAccount('acct-pre-r5c-legacy');
    expect(loaded).toBeDefined();
    expect(loaded?.id).toBe('acct-pre-r5c-legacy');
    expect(loaded?.credential_ref).toBe('legacy-opaque-handle-001');
  });

  // -------------------------------------------------------------
  // 10. unrelated update to pre-R5C legacy row preserves legacy ref
  // -------------------------------------------------------------
  it('10. unrelated update to pre-R5C legacy row preserves legacy ref', () => {
    seedProvider('prov-10');
    db.prepare(`
      INSERT INTO provider_accounts (
        id, provider_id, label, auth_mode, credential_ref, profile_ref,
        enabled, priority, health_status, cooldown_until, concurrency_limit,
        last_success_at, last_failure_at, last_failure_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'acct-legacy-update-unrelated',
      'prov-10',
      'Legacy Account Label',
      'API_CREDENTIAL',
      'legacy-opaque-handle-002',
      null,
      1,
      5,
      'AVAILABLE',
      null,
      2,
      null,
      null,
      null,
      new Date().toISOString(),
      new Date().toISOString()
    );

    // Update only label and priority
    repo.updateProviderAccount('acct-legacy-update-unrelated', {
      label: 'Updated Label Only',
      priority: 20,
    });

    const updated = repo.getProviderAccount('acct-legacy-update-unrelated');
    expect(updated?.label).toBe('Updated Label Only');
    expect(updated?.priority).toBe(20);
    expect(updated?.credential_ref).toBe('legacy-opaque-handle-002');
  });

  // -------------------------------------------------------------
  // 11. explicit ref/auth-mode update of legacy row requires canonical R5C ref
  // -------------------------------------------------------------
  it('11. explicit ref/auth-mode update of legacy row requires canonical R5C ref', () => {
    seedProvider('prov-11');
    db.prepare(`
      INSERT INTO provider_accounts (
        id, provider_id, label, auth_mode, credential_ref, profile_ref,
        enabled, priority, health_status, cooldown_until, concurrency_limit,
        last_success_at, last_failure_at, last_failure_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'acct-legacy-security-update',
      'prov-11',
      'Legacy Account',
      'API_CREDENTIAL',
      'legacy-opaque-handle-003',
      null,
      1,
      1,
      'AVAILABLE',
      null,
      1,
      null,
      null,
      null,
      new Date().toISOString(),
      new Date().toISOString()
    );

    // Updating credential_ref to another non-canonical handle fails
    expect(() => {
      repo.updateProviderAccount('acct-legacy-security-update', {
        credential_ref: 'another-legacy-handle',
      });
    }).toThrow(/missing valid "scheme:\/\/" prefix/);

    // Updating to a valid canonical R5C ref succeeds
    repo.updateProviderAccount('acct-legacy-security-update', {
      credential_ref: 'wincred://agentforge/openai/prod-key',
    });

    const updated = repo.getProviderAccount('acct-legacy-security-update');
    expect(updated?.credential_ref).toBe('wincred://agentforge/openai/prod-key');
  });

  // -------------------------------------------------------------
  // 12. rejected plaintext write leaves plaintext absent from raw SQLite dump
  // -------------------------------------------------------------
  it('12. rejected plaintext write leaves plaintext absent from raw SQLite dump', () => {
    seedProvider('prov-12');
    const sensitiveKey = 'sk-super-secret-forbidden-raw-token-99999';

    expect(() => {
      repo.createProviderAccount({
        id: 'acct-secret-dump-check',
        provider_id: 'prov-12',
        label: 'Secret Dump Check',
        auth_mode: 'API_CREDENTIAL',
        credential_ref: sensitiveKey,
        profile_ref: null,
        enabled: true,
        priority: 1,
        health_status: 'AVAILABLE',
        cooldown_until: null,
        concurrency_limit: 1,
        last_success_at: null,
        last_failure_at: null,
        last_failure_code: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }).toThrow();

    // Query entire raw sqlite db tables
    const rows = db.prepare('SELECT * FROM provider_accounts').all();
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(sensitiveKey);
  });

  // -------------------------------------------------------------
  // 13. SecretValue Object.keys does not expose raw field
  // -------------------------------------------------------------
  it('13. SecretValue Object.keys does not expose raw field', () => {
    const rawSecret = 'sk-live-token-131313';
    const secret = new SecretValue(rawSecret);

    const keys = Object.keys(secret);
    expect(keys).toEqual([]);
    expect(Object.getOwnPropertyNames(secret)).toEqual([]);
  });

  // -------------------------------------------------------------
  // 14. spreading SecretValue does not expose raw secret
  // -------------------------------------------------------------
  it('14. spreading SecretValue does not expose raw secret', () => {
    const rawSecret = 'sk-live-token-141414';
    const secret = new SecretValue(rawSecret);

    const spreadObj = { ...secret };
    expect(spreadObj).toEqual({});
    expect(JSON.stringify(spreadObj)).toBe('{}');
  });

  // -------------------------------------------------------------
  // 15. nested util.inspect does not expose raw secret
  // -------------------------------------------------------------
  it('15. nested util.inspect does not expose raw secret', () => {
    const rawSecret = 'sk-live-token-151515';
    const secret = new SecretValue(rawSecret);

    const container = { auth: { payload: secret, meta: 'test' } };
    const inspected = util.inspect(container, { depth: null });
    expect(inspected).not.toContain(rawSecret);
    expect(inspected).toContain('[REDACTED_SECRET]');
  });

  // -------------------------------------------------------------
  // 16. public API cannot construct invalid CredentialRef without parser validation
  // -------------------------------------------------------------
  it('16. public API cannot construct invalid CredentialRef without parser validation', () => {
    expect(() => parseCredentialRef('invalid-ref')).toThrow();
    expect(() => CredentialRef.parse('invalid-ref')).toThrow();
    expect(() => new CredentialRef('invalid-ref')).toThrow();
    expect(isValidCredentialRef('invalid-ref')).toBe(false);
  });

  // -------------------------------------------------------------
  // 17. public API cannot construct invalid NativeProfileRef without parser validation
  // -------------------------------------------------------------
  it('17. public API cannot construct invalid NativeProfileRef without parser validation', () => {
    expect(() => parseNativeProfileRef('invalid-profile')).toThrow();
    expect(() => NativeProfileRef.parse('invalid-profile')).toThrow();
    expect(() => new NativeProfileRef('invalid-profile')).toThrow();
    expect(isValidNativeProfileRef('invalid-profile')).toBe(false);
  });

  // -------------------------------------------------------------
  // 18. credential URI alias forms are rejected
  // -------------------------------------------------------------
  it('18. credential URI alias forms are rejected', () => {
    // Missing agentforge/ namespace
    expect(() => parseCredentialRef('wincred://openai/api-01')).toThrow(
      /target must start with canonical namespace "agentforge\/"/
    );
    // Colon separator alias
    expect(() => parseCredentialRef('wincred://agentforge:openai:api-01')).toThrow(
      /colons are forbidden in target path/
    );
    // Empty segment
    expect(() => parseCredentialRef('wincred://agentforge/openai//api-01')).toThrow(
      /consecutive slashes are forbidden/
    );
  });

  // -------------------------------------------------------------
  // 19. canonical CredentialRef round-trip remains deterministic
  // -------------------------------------------------------------
  it('19. canonical CredentialRef round-trip remains deterministic', () => {
    const canonical = 'wincred://agentforge/openai/team-01';
    const ref = parseCredentialRef(canonical);

    expect(ref.toUriString()).toBe(canonical);
    expect(ref.getWindowsTargetName()).toBe('AgentForge:openai:team-01');
    expect(ref.toString()).toBe(canonical);
    expect(ref.toSafeString()).toBe(canonical);
  });

  // -------------------------------------------------------------
  // 20. unknown native-profile provider resolution fails closed
  // -------------------------------------------------------------
  it('20. unknown native-profile provider resolution fails closed', () => {
    const resolver = new NativeProfileResolver();
    const unknownRef = parseNativeProfileRef('native-profile://unknown-custom-llm/prof-1');

    expect(() => resolver.resolve(unknownRef)).toThrow(
      /Unsupported native profile provider "unknown-custom-llm"/
    );
  });

  // -------------------------------------------------------------
  // 21. Codex config mapping is supported but runtime isolation is PENDING_R5D
  // -------------------------------------------------------------
  it('21. Codex config mapping is supported but runtime isolation is PENDING_R5D', () => {
    const resolver = new NativeProfileResolver({
      baseProfilesDir: path.join('C:', 'AgentForge', 'profiles'),
    });
    const ref = parseNativeProfileRef('native-profile://codex/c01');
    const res = resolver.resolve(ref);

    expect(res.provider).toBe('codex');
    expect(res.profileId).toBe('c01');
    expect(res.envOverrides).toEqual({
      CODEX_HOME: path.join('C:', 'AgentForge', 'profiles', 'codex', 'c01'),
    });
    expect(res.configurationStatus).toBe('DOCUMENTED_SUPPORTED');
    expect(res.runtimeIsolationStatus).toBe('PENDING_R5D');
    expect(res.notes).toContain('CODEX_HOME');
    expect(res.notes).toContain('pending R5D');
  });

  // -------------------------------------------------------------
  // 22. Gemini config mapping is supported but runtime isolation is PENDING_R5D
  // -------------------------------------------------------------
  it('22. Gemini config mapping is supported but runtime isolation is PENDING_R5D', () => {
    const resolver = new NativeProfileResolver({
      baseProfilesDir: path.join('C:', 'AgentForge', 'profiles'),
    });
    const ref = parseNativeProfileRef('native-profile://gemini/g01');
    const res = resolver.resolve(ref);

    expect(res.provider).toBe('gemini');
    expect(res.profileId).toBe('g01');
    expect(res.envOverrides).toEqual({
      GEMINI_CLI_HOME: path.join('C:', 'AgentForge', 'profiles', 'gemini', 'g01'),
    });
    expect(res.configurationStatus).toBe('DOCUMENTED_SUPPORTED');
    expect(res.runtimeIsolationStatus).toBe('PENDING_R5D');
    expect(res.notes).toContain('GEMINI_CLI_HOME');
    expect(res.notes).toContain('pending R5D');
  });

  // -------------------------------------------------------------
  // 23. Claude remains experimental and runtime isolation PENDING_R5D
  // -------------------------------------------------------------
  it('23. Claude remains experimental and runtime isolation PENDING_R5D', () => {
    const resolver = new NativeProfileResolver({
      baseProfilesDir: path.join('C:', 'AgentForge', 'profiles'),
    });
    const ref = parseNativeProfileRef('native-profile://claude/cl01');
    const res = resolver.resolve(ref);

    expect(res.provider).toBe('claude');
    expect(res.profileId).toBe('cl01');
    expect(res.envOverrides).toEqual({
      CLAUDE_CONFIG_DIR: path.join('C:', 'AgentForge', 'profiles', 'claude', 'cl01'),
    });
    expect(res.configurationStatus).toBe('EXPERIMENTAL_UNPROVEN');
    expect(res.runtimeIsolationStatus).toBe('PENDING_R5D');
    expect(res.notes).toContain('unverified and experimental');
    expect(res.notes).toContain('pending R5D');
  });

  // -------------------------------------------------------------
  // 24. normal Windows npm test does NOT touch real Credential Manager
  // -------------------------------------------------------------
  it('24. normal Windows npm test does NOT touch real Credential Manager', () => {
    // InMemoryCredentialStore is fully isolated
    const memStore = new InMemoryCredentialStore();
    const ref = parseCredentialRef('wincred://agentforge/test/mem-key');
    const secret = new SecretValue('test-secret');

    memStore.put(ref, secret);
    expect(memStore.exists(ref)).resolves.toBe(true);
  });

  // -------------------------------------------------------------
  // 25. injected Windows backend tests cover put/get/delete/exists command contract
  // -------------------------------------------------------------
  it('25. injected Windows backend tests cover put/get/delete/exists command contract', async () => {
    const executedScripts: string[] = [];
    const executedInputs: string[] = [];

    const mockExecutor = async (script: string, stdinInput: string): Promise<string> => {
      executedScripts.push(script);
      executedInputs.push(stdinInput);
      if (script.includes('CredWrite')) return 'OK\n';
      if (script.includes('CredReadW') && script.includes('EXISTS')) return 'EXISTS\n';
      if (script.includes('CredReadW')) return 'mock-retrieved-secret';
      if (script.includes('CredDeleteW')) return 'DELETED\n';
      return '';
    };

    const store = new WindowsCredentialStore('win32', mockExecutor);
    const ref = parseCredentialRef('wincred://agentforge/mock/test-target');
    const secret = new SecretValue('my-super-secret');

    // Test put
    await store.put(ref, secret);
    expect(executedInputs[0]).toBe('AgentForge:mock:test-target\nmy-super-secret');
    expect(executedScripts[0]).toContain('CredWrite');

    // Test exists
    const existsResult = await store.exists(ref);
    expect(existsResult).toBe(true);
    expect(executedInputs[1]).toBe('AgentForge:mock:test-target');
    expect(executedScripts[1]).toContain('WinCredProber');

    // Test get
    const retrieved = await store.get(ref);
    expect(retrieved?.exposeSecret()).toBe('mock-retrieved-secret');
    expect(executedInputs[2]).toBe('AgentForge:mock:test-target');

    // Test delete
    const deleted = await store.delete(ref);
    expect(deleted).toBe(true);
    expect(executedInputs[3]).toBe('AgentForge:mock:test-target');
  });

  // -------------------------------------------------------------
  // 26. exists() does not return/read secret payload
  // -------------------------------------------------------------
  it('26. exists() does not return/read secret payload', async () => {
    const probeExecutor = async (script: string): Promise<string> => {
      // WinCredProber must NOT marshal or write secret to stdout
      if (script.includes('WinCredProber')) {
        expect(script).not.toContain('Marshal]::Copy');
        expect(script).not.toContain('GetString');
        return 'EXISTS\n';
      }
      return '';
    };

    const store = new WindowsCredentialStore('win32', probeExecutor);
    const ref = parseCredentialRef('wincred://agentforge/mock/probe-target');
    const exists = await store.exists(ref);
    expect(exists).toBe(true);
  });

  // -------------------------------------------------------------
  // 27 & 28. optional real WinCred integration test is skipped unless explicit opt-in
  // -------------------------------------------------------------
  it('27 & 28. optional real WinCred integration test is skipped unless explicit opt-in', async () => {
    const isOptIn = process.env.AGENTFORGE_RUN_WINCRED_INTEGRATION === '1';
    if (!isOptIn || process.platform !== 'win32') {
      // Skipped in default hermetic test run
      expect(true).toBe(true);
      return;
    }

    // When explicitly opted in:
    const uniqueId = crypto.randomUUID();
    const targetUri = `wincred://agentforge/test-isolated/${uniqueId}`;
    const ref = parseCredentialRef(targetUri);
    const secret = new SecretValue(`secret-payload-${uniqueId}`);
    const liveStore = new WindowsCredentialStore('win32');

    try {
      // 1. Put
      await liveStore.put(ref, secret);

      // 2. Exists
      const exists = await liveStore.exists(ref);
      expect(exists).toBe(true);

      // 3. Get
      const retrieved = await liveStore.get(ref);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.exposeSecret()).toBe(`secret-payload-${uniqueId}`);
    } finally {
      // 4. Guaranteed cleanup
      await liveStore.delete(ref);
      const existsAfter = await liveStore.exists(ref);
      expect(existsAfter).toBe(false);
    }
  });

  // -------------------------------------------------------------
  // 29 & 30. Windows Credential size limit validation (>2560 bytes fails closed)
  // -------------------------------------------------------------
  it('29 & 30. Windows Credential size limit validation (>2560 bytes fails closed)', async () => {
    const mockExecutor = async () => 'OK\n';
    const store = new WindowsCredentialStore('win32', mockExecutor);
    const ref = parseCredentialRef('wincred://agentforge/test/size-limit');

    // 2560 bytes in UTF-16LE = 1280 characters
    const validSecret = new SecretValue('a'.repeat(1280));
    await expect(store.put(ref, validSecret)).resolves.not.toThrow();

    // 2562 bytes in UTF-16LE = 1281 characters -> exceeds limit
    const oversizedSecret = new SecretValue('a'.repeat(1281));
    await expect(store.put(ref, oversizedSecret)).rejects.toThrow(
      /exceeds maximum Windows Credential Manager limit/
    );
  });

  // =============================================================
  // CORRECTIVE 2: RUNTIME BYPASS & ATTACK TESTS (Section G)
  // =============================================================

  // 31. CredentialRef and NativeProfileRef have no public _createInternal
  it('31. CredentialRef and NativeProfileRef have no public _createInternal', () => {
    expect((CredentialRef as any)._createInternal).toBeUndefined();
    expect((NativeProfileRef as any)._createInternal).toBeUndefined();
  });

  // 32. Attempting to forge a CredentialRef-like object cannot bypass Windows target canonicalization
  it('32. Attempting to forge a CredentialRef-like object cannot bypass Windows target canonicalization', async () => {
    let capturedTarget = '';
    const mockExecutor = async (_script: string, stdinInput: string): Promise<string> => {
      capturedTarget = stdinInput.split('\n')[0];
      return 'OK\n';
    };

    const store = new WindowsCredentialStore('win32', mockExecutor);

    // Attack: pass a forged object claiming a safe URI but returning a malicious target in getWindowsTargetName()
    const forgedRef = {
      toUriString: () => 'wincred://agentforge/openai/team-key',
      getWindowsTargetName: () => 'OtherApp:SensitiveTarget',
    } as any;

    await store.put(forgedRef, new SecretValue('test-payload'));

    // WindowsCredentialStore must revalidate and use canonical target, NOT forged getWindowsTargetName
    expect(capturedTarget).toBe('AgentForge:openai:team-key');
    expect(capturedTarget).not.toBe('OtherApp:SensitiveTarget');
  });

  // 33. Forged object with invalid or traversing URI fails closed in consumer stores
  it('33. Forged object with invalid or traversing URI fails closed in consumer stores', async () => {
    const store = new WindowsCredentialStore('win32', async () => 'OK\n');

    const maliciousTraversal = {
      toUriString: () => 'wincred://agentforge/../../etc/shadow',
      getWindowsTargetName: () => 'AgentForge:traversal',
    } as any;

    await expect(store.put(maliciousTraversal, new SecretValue('foo'))).rejects.toThrow(/path traversal is forbidden/);
    await expect(store.get(maliciousTraversal)).rejects.toThrow(/path traversal is forbidden/);
    await expect(store.delete(maliciousTraversal)).rejects.toThrow(/path traversal is forbidden/);
    await expect(store.exists(maliciousTraversal)).rejects.toThrow(/path traversal is forbidden/);
  });

  // 34. Forged NativeProfileRef with path traversal fails closed in NativeProfileResolver
  it('34. Forged NativeProfileRef with path traversal fails closed in NativeProfileResolver', () => {
    const resolver = new NativeProfileResolver({
      baseProfilesDir: path.join('C:', 'AgentForge', 'profiles'),
    });

    const maliciousProfile = {
      provider: 'codex',
      profileId: '../../escape',
      toUriString: () => 'native-profile://codex/../../escape',
    } as any;

    expect(() => resolver.resolve(maliciousProfile)).toThrow(/path traversal is forbidden/);

    // If forged object claims a safe URI but has forged traversal property, safe URI is canonicalized
    const deceptiveProfile = {
      provider: 'codex',
      profileId: '../../escape',
      toUriString: () => 'native-profile://codex/c01',
    } as any;

    const res = resolver.resolve(deceptiveProfile);
    expect(res.profileDirectory).toBe(path.join('C:', 'AgentForge', 'profiles', 'codex', 'c01'));
    expect(res.profileDirectory).not.toContain('escape');
  });

  // =============================================================
  // CORRECTIVE 2: CASE IDENTITY & CANONICALIZATION TESTS (Section H)
  // =============================================================

  // 35. Credential refs differing only by case canonicalize to identical logical identity and Windows target
  it('35. Credential refs differing only by case canonicalize to identical logical identity and Windows target', () => {
    const lower = parseCredentialRef('wincred://agentforge/openai/team-key');
    const mixed = parseCredentialRef('wincred://AgentForge/OpenAI/Team-Key');
    const upper = parseCredentialRef('WINCRED://AGENTFORGE/OPENAI/TEAM-KEY');

    // All must produce identical canonical URI
    expect(lower.toUriString()).toBe('wincred://agentforge/openai/team-key');
    expect(mixed.toUriString()).toBe('wincred://agentforge/openai/team-key');
    expect(upper.toUriString()).toBe('wincred://agentforge/openai/team-key');

    // All must produce identical target
    expect(lower.getTarget()).toBe('agentforge/openai/team-key');
    expect(mixed.getTarget()).toBe('agentforge/openai/team-key');
    expect(upper.getTarget()).toBe('agentforge/openai/team-key');

    // All must produce identical Windows target
    expect(lower.getWindowsTargetName()).toBe('AgentForge:openai:team-key');
    expect(mixed.getWindowsTargetName()).toBe('AgentForge:openai:team-key');
    expect(upper.getWindowsTargetName()).toBe('AgentForge:openai:team-key');

    // Canonical round-trip stability
    const roundTrip = parseCredentialRef(mixed.toUriString());
    expect(roundTrip.toUriString()).toBe(mixed.toUriString());
    expect(roundTrip.getWindowsTargetName()).toBe(mixed.getWindowsTargetName());
  });

  // 36. Native profile refs differing only by case canonicalize to identical logical identity and directory
  it('36. Native profile refs differing only by case canonicalize to identical logical identity and directory', () => {
    const resolver = new NativeProfileResolver({
      baseProfilesDir: path.join('C:', 'AgentForge', 'profiles'),
    });

    const lower = parseNativeProfileRef('native-profile://codex/c01');
    const mixed = parseNativeProfileRef('native-profile://Codex/C01');
    const upper = parseNativeProfileRef('NATIVE-PROFILE://CODEX/C01');

    expect(lower.toUriString()).toBe('native-profile://codex/c01');
    expect(mixed.toUriString()).toBe('native-profile://codex/c01');
    expect(upper.toUriString()).toBe('native-profile://codex/c01');

    expect(lower.getProvider()).toBe('codex');
    expect(mixed.getProvider()).toBe('codex');
    expect(upper.getProvider()).toBe('codex');

    expect(lower.getProfileId()).toBe('c01');
    expect(mixed.getProfileId()).toBe('c01');
    expect(upper.getProfileId()).toBe('c01');

    const resLower = resolver.resolve(lower);
    const resMixed = resolver.resolve(mixed);
    const resUpper = resolver.resolve(upper);

    expect(resLower.profileDirectory).toBe(resMixed.profileDirectory);
    expect(resLower.profileDirectory).toBe(resUpper.profileDirectory);
    expect(resLower.envOverrides).toEqual(resMixed.envOverrides);

    // Canonical round-trip stability
    const roundTrip = parseNativeProfileRef(mixed.toUriString());
    expect(roundTrip.toUriString()).toBe(mixed.toUriString());
    expect(roundTrip.getProfileId()).toBe(mixed.getProfileId());
  });
});
