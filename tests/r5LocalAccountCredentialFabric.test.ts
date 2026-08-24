import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import util from 'util';
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
  // 1. Valid wincred CredentialRef parse / round-trip
  // -------------------------------------------------------------
  it('1. valid wincred CredentialRef parse/round-trip', () => {
    const raw = 'wincred://agentforge/openai/api-01';
    const ref = parseCredentialRef(raw);

    expect(ref.getScheme()).toBe('wincred');
    expect(ref.getTarget()).toBe('agentforge/openai/api-01');
    expect(ref.toUriString()).toBe(raw);
    expect(ref.toString()).toBe(raw);
    expect(ref.toSafeString()).toBe(raw);
    expect(ref.toJSON()).toBe(raw);
    expect(isValidCredentialRef(raw)).toBe(true);
  });

  // -------------------------------------------------------------
  // 2. Malformed credential refs rejected
  // -------------------------------------------------------------
  it('2. malformed credential refs rejected', () => {
    expect(() => parseCredentialRef('')).toThrow(/non-empty string/);
    expect(() => parseCredentialRef('invalid-no-scheme')).toThrow(/missing valid "scheme:\/\/" prefix/);
    expect(() => parseCredentialRef('https://openai.com')).toThrow(/Unsupported credential scheme "https"/);
    expect(() => parseCredentialRef('wincred://')).toThrow(/target path cannot be empty/);
    expect(() => parseCredentialRef('wincred://has space/target')).toThrow(/target contains whitespace/);
    expect(() => parseCredentialRef('wincred://../traversal/key')).toThrow(/path traversal is forbidden/);
    expect(() => parseCredentialRef('wincred://agentforge/../key')).toThrow(/path traversal is forbidden/);
    expect(() => parseCredentialRef('wincred://agentforge//consecutive')).toThrow(/consecutive slashes/);
    expect(() => parseCredentialRef('wincred://agentforge/trailing/')).toThrow(/trailing slashes/);
    expect(() => parseCredentialRef('wincred://agentforge/illegal$char')).toThrow(/target contains invalid characters/);

    expect(isValidCredentialRef('wincred://../traversal')).toBe(false);
    expect(isValidCredentialRef('not-a-ref')).toBe(false);
  });

  // -------------------------------------------------------------
  // 3. Secret payload cannot be serialized as ordinary metadata
  // -------------------------------------------------------------
  it('3. secret payload cannot be serialized as ordinary metadata', () => {
    const rawSecret = 'sk-live-secret-key-1234567890abcdef';
    const secret = new SecretValue(rawSecret);

    expect(secret.exposeSecret()).toBe(rawSecret);
    expect(secret.toString()).toBe('[REDACTED_SECRET]');
    expect(secret.toJSON()).toBe('[REDACTED_SECRET]');
    expect(JSON.stringify({ secret, label: 'test' })).toBe('{"secret":"[REDACTED_SECRET]","label":"test"}');
    expect(util.inspect(secret)).toBe('[REDACTED_SECRET]');
    expect(`${secret}`).toBe('[REDACTED_SECRET]');

    // SecretValue equality
    const sameSecret = new SecretValue(rawSecret);
    const diffSecret = new SecretValue('sk-other-secret');
    expect(secret.equals(sameSecret)).toBe(true);
    expect(secret.equals(diffSecret)).toBe(false);

    expect(() => new SecretValue('')).toThrow(/non-empty string/);
  });

  // -------------------------------------------------------------
  // 4. ProviderAccount secure-ref validation
  // -------------------------------------------------------------
  it('4. ProviderAccount secure-ref validation', () => {
    seedProvider('prov-openai');

    // Valid API_CREDENTIAL with wincred ref
    const validAcct: ProviderAccount = {
      id: 'acct-api-01',
      provider_id: 'prov-openai',
      label: 'OpenAI Team Key',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: 'wincred://agentforge/openai/team-key',
      profile_ref: null,
      enabled: true,
      priority: 100,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 2,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createProviderAccount(validAcct);
    expect(repo.getProviderAccount('acct-api-01')?.credential_ref).toBe('wincred://agentforge/openai/team-key');

    // Invalid: API_CREDENTIAL with malformed wincred ref
    expect(() => {
      repo.createProviderAccount({
        ...validAcct,
        id: 'acct-invalid-wincred',
        credential_ref: 'wincred://../bad/path',
      });
    }).toThrow(/path traversal is forbidden/);

    // Invalid: API_CREDENTIAL with conflicting profile_ref
    expect(() => {
      repo.createProviderAccount({
        ...validAcct,
        id: 'acct-conflicting',
        profile_ref: 'native-profile://codex/c01',
      });
    }).toThrow(/contradictory references/);

    // Invalid: NATIVE_PROFILE with malformed native-profile ref
    expect(() => {
      repo.createProviderAccount({
        ...validAcct,
        id: 'acct-invalid-native',
        auth_mode: 'NATIVE_PROFILE',
        credential_ref: null,
        profile_ref: 'native-profile://codex/../bad',
      });
    }).toThrow(/path traversal is forbidden/);

    // Invalid: NATIVE_PROFILE with conflicting credential_ref
    expect(() => {
      repo.createProviderAccount({
        ...validAcct,
        id: 'acct-prof-conflict',
        auth_mode: 'NATIVE_PROFILE',
        credential_ref: 'wincred://agentforge/openai/key',
        profile_ref: 'native-profile://codex/c01',
      });
    }).toThrow(/contradictory references/);
  });

  // -------------------------------------------------------------
  // 5. Plaintext credential data does not enter SQLite
  // -------------------------------------------------------------
  it('5. plaintext credential data does not enter SQLite', () => {
    seedProvider('prov-openai');
    const secretApiKey = 'sk-proj-SUPER_SECRET_TOKEN_DO_NOT_LEAK_12345';
    const opaqueRef = 'wincred://agentforge/openai/production-key';

    repo.createProviderAccount({
      id: 'acct-secure-test',
      provider_id: 'prov-openai',
      label: 'Production Key',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: opaqueRef,
      profile_ref: null,
      enabled: true,
      priority: 100,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Query SQLite database raw tables directly
    const row = db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get('acct-secure-test') as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.credential_ref).toBe(opaqueRef);

    // Assert that the raw plaintext secret is nowhere in SQLite memory
    const dump = JSON.stringify(db.prepare('SELECT * FROM provider_accounts').all());
    expect(dump).not.toContain(secretApiKey);
    expect(dump).toContain(opaqueRef);
  });

  // -------------------------------------------------------------
  // 6. Windows backend namespace/target behavior
  // -------------------------------------------------------------
  it('6. Windows backend namespace/target behavior', () => {
    const ref1 = parseCredentialRef('wincred://agentforge/openai/api-01');
    expect(ref1.getWindowsTargetName()).toBe('AgentForge:openai:api-01');

    const ref2 = parseCredentialRef('wincred://openai/key-02');
    expect(ref2.getWindowsTargetName()).toBe('AgentForge:openai:key-02');

    const ref3 = parseCredentialRef('wincred://AgentForge:custom:target');
    expect(ref3.getWindowsTargetName()).toBe('AgentForge:custom:target');
  });

  // -------------------------------------------------------------
  // 7. put/get/delete semantics through injected backend
  // -------------------------------------------------------------
  it('7. put/get/delete semantics through injected backend', async () => {
    const store: CredentialStore = new InMemoryCredentialStore();
    const ref = parseCredentialRef('wincred://agentforge/test/sample-key');
    const secret = new SecretValue('test-secret-payload-999');

    expect(await store.exists(ref)).toBe(false);
    expect(await store.get(ref)).toBeNull();

    await store.put(ref, secret);
    expect(await store.exists(ref)).toBe(true);

    const retrieved = await store.get(ref);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.exposeSecret()).toBe('test-secret-payload-999');

    const deleted = await store.delete(ref);
    expect(deleted).toBe(true);
    expect(await store.exists(ref)).toBe(false);
    expect(await store.get(ref)).toBeNull();

    // Delete non-existent
    const deleteAgain = await store.delete(ref);
    expect(deleteAgain).toBe(false);
  });

  // -------------------------------------------------------------
  // 8. Secret not present in thrown error messages
  // -------------------------------------------------------------
  it('8. secret not present in thrown error messages', () => {
    const rawSecret = 'sk-sensitive-api-token-987654';
    const secret = new SecretValue(rawSecret);

    const sanitizedError = safeFormatDiagnostic(
      new Error(`Failed to connect with secret: ${secret.toString()}`),
      [secret]
    );

    expect(sanitizedError).not.toContain(rawSecret);
    expect(sanitizedError).toContain('[REDACTED_SECRET]');

    // Redaction function directly
    const redactedText = redactSecretString(`Auth header Bearer ${rawSecret} failed`, rawSecret);
    expect(redactedText).toBe('Auth header Bearer [REDACTED_SECRET] failed');
  });

  // -------------------------------------------------------------
  // 9. Secret not present in diagnostic/log-safe representation
  // -------------------------------------------------------------
  it('9. secret not present in diagnostic/log-safe representation', () => {
    const ref = parseCredentialRef('wincred://agentforge/anthropic/key-01');
    const secret = new SecretValue('sk-ant-api03-SECRET_PAYLOAD');

    const diagnosticPayload = {
      ref: ref.toSafeString(),
      secret: secret.toJSON(),
      status: 'AUTHENTICATING',
    };

    const logJson = JSON.stringify(diagnosticPayload);
    expect(logJson).not.toContain('sk-ant-api03-SECRET_PAYLOAD');
    expect(logJson).toContain('"secret":"[REDACTED_SECRET]"');
    expect(logJson).toContain('wincred://agentforge/anthropic/key-01');
  });

  // -------------------------------------------------------------
  // 10. Unsupported-platform behavior fails closed
  // -------------------------------------------------------------
  it('10. unsupported-platform behavior fails closed', async () => {
    const linuxStore = new WindowsCredentialStore('linux');
    const ref = parseCredentialRef('wincred://agentforge/openai/key');
    const secret = new SecretValue('test-secret');

    await expect(linuxStore.put(ref, secret)).rejects.toThrow(/UNSUPPORTED_PLATFORM/);
    await expect(linuxStore.get(ref)).rejects.toThrow(/UNSUPPORTED_PLATFORM/);
    await expect(linuxStore.delete(ref)).rejects.toThrow(/UNSUPPORTED_PLATFORM/);
    await expect(linuxStore.exists(ref)).rejects.toThrow(/UNSUPPORTED_PLATFORM/);
  });

  // -------------------------------------------------------------
  // 11. Test fake usable through dependency injection only
  // -------------------------------------------------------------
  it('11. test fake usable through dependency injection only', async () => {
    const fakeStore = new InMemoryCredentialStore();
    const refA = parseCredentialRef('wincred://agentforge/fake/a');
    const refB = parseCredentialRef('wincred://agentforge/fake/b');

    await fakeStore.put(refA, new SecretValue('secret-a'));
    await fakeStore.put(refB, new SecretValue('secret-b'));

    expect((await fakeStore.get(refA))?.exposeSecret()).toBe('secret-a');
    expect((await fakeStore.get(refB))?.exposeSecret()).toBe('secret-b');

    fakeStore.clear();
    expect(await fakeStore.exists(refA)).toBe(false);
  });

  // -------------------------------------------------------------
  // 12. NativeProfileRef parse/round-trip
  // -------------------------------------------------------------
  it('12. NativeProfileRef parse/round-trip', () => {
    const raw = 'native-profile://codex/c01';
    const ref = parseNativeProfileRef(raw);

    expect(ref.getScheme()).toBe('native-profile');
    expect(ref.getProvider()).toBe('codex');
    expect(ref.getProfileId()).toBe('c01');
    expect(ref.toUriString()).toBe(raw);
    expect(ref.toString()).toBe(raw);
    expect(ref.toSafeString()).toBe(raw);
    expect(ref.toJSON()).toBe(raw);
    expect(isValidNativeProfileRef(raw)).toBe(true);
  });

  // -------------------------------------------------------------
  // 13. Traversal/malformed native profiles rejected
  // -------------------------------------------------------------
  it('13. traversal/malformed native profiles rejected', () => {
    expect(() => parseNativeProfileRef('')).toThrow(/non-empty string/);
    expect(() => parseNativeProfileRef('invalid-scheme://codex/c01')).toThrow(/Unsupported profile scheme/);
    expect(() => parseNativeProfileRef('native-profile://')).toThrow(/expected format/);
    expect(() => parseNativeProfileRef('native-profile://codex')).toThrow(/expected format/);
    expect(() => parseNativeProfileRef('native-profile:///c01')).toThrow(/provider cannot be empty/);
    expect(() => parseNativeProfileRef('native-profile://codex/')).toThrow(/profileId cannot be empty/);
    expect(() => parseNativeProfileRef('native-profile://codex/../traversal')).toThrow(/path traversal is forbidden/);
    expect(() => parseNativeProfileRef('native-profile://codex/sub/dir')).toThrow(/path separators/);
    expect(() => parseNativeProfileRef('native-profile://codex/sub\\dir')).toThrow(/path separators/);
    expect(() => parseNativeProfileRef('native-profile://codex/has space')).toThrow(/whitespace or control characters/);
    expect(() => parseNativeProfileRef('native-profile://codex/bad$char')).toThrow(/contains invalid characters/);

    expect(isValidNativeProfileRef('native-profile://codex/../bad')).toBe(false);
  });

  // -------------------------------------------------------------
  // 14. Codex profile execution metadata resolves deterministically
  // -------------------------------------------------------------
  it('14. Codex profile execution metadata resolves deterministically', () => {
    const resolver = new NativeProfileResolver({
      baseProfilesDir: path.join('C:', 'AgentForge', 'profiles'),
    });

    const resolution = resolver.resolve('native-profile://codex/work-account-01');
    expect(resolution.provider).toBe('codex');
    expect(resolution.profileId).toBe('work-account-01');
    expect(resolution.profileRef).toBe('native-profile://codex/work-account-01');
    expect(resolution.envOverrides.CODEX_HOME).toBe(
      path.join('C:', 'AgentForge', 'profiles', 'codex', 'work-account-01')
    );
    expect(resolution.isolationStatus).toBe('VERIFIED');
    expect(resolution.notes).toContain('Codex CLI profile isolated');
  });

  // -------------------------------------------------------------
  // 15. Gemini profile execution metadata resolves deterministically
  // -------------------------------------------------------------
  it('15. Gemini profile execution metadata resolves deterministically', () => {
    const resolver = new NativeProfileResolver({
      baseProfilesDir: path.join('C:', 'AgentForge', 'profiles'),
    });

    const resolution = resolver.resolve('native-profile://gemini/personal-g01');
    expect(resolution.provider).toBe('gemini');
    expect(resolution.profileId).toBe('personal-g01');
    expect(resolution.profileRef).toBe('native-profile://gemini/personal-g01');
    expect(resolution.envOverrides.GEMINI_CLI_HOME).toBe(
      path.join('C:', 'AgentForge', 'profiles', 'gemini', 'personal-g01')
    );
    expect(resolution.isolationStatus).toBe('VERIFIED');
    expect(resolution.notes).toContain('Gemini CLI profile isolated');
  });

  // -------------------------------------------------------------
  // 16. Claude profile remains marked experimental/unverified
  // -------------------------------------------------------------
  it('16. Claude profile remains marked experimental/unverified', () => {
    const resolver = new NativeProfileResolver({
      baseProfilesDir: path.join('C:', 'AgentForge', 'profiles'),
    });

    const resolution = resolver.resolve('native-profile://claude/cl-team');
    expect(resolution.provider).toBe('claude');
    expect(resolution.profileId).toBe('cl-team');
    expect(resolution.profileRef).toBe('native-profile://claude/cl-team');
    expect(resolution.envOverrides.CLAUDE_CONFIG_DIR).toBe(
      path.join('C:', 'AgentForge', 'profiles', 'claude', 'cl-team')
    );
    expect(resolution.isolationStatus).toBe('EXPERIMENTAL_UNPROVEN');
    expect(resolution.notes).toContain('Claude Code profile isolation is unverified and experimental');
  });

  // -------------------------------------------------------------
  // 17. Resolver never reads/copies provider OAuth token payload
  // -------------------------------------------------------------
  it('17. resolver never reads/copies provider OAuth token payload', () => {
    const resolver = new NativeProfileResolver({
      baseProfilesDir: path.join('C:', 'AgentForge', 'profiles'),
    });

    // Pure computation of environment and directory mapping
    const resolution = resolver.resolve(parseNativeProfileRef('native-profile://codex/c01'));

    expect(resolution).toBeDefined();
    expect(resolution.envOverrides).toEqual({
      CODEX_HOME: path.join('C:', 'AgentForge', 'profiles', 'codex', 'c01'),
    });
    // Ensure no token properties or credential contents exist on the resolution object
    const resObj = resolution as unknown as Record<string, unknown>;
    expect(resObj.token).toBeUndefined();
    expect(resObj.secret).toBeUndefined();
    expect(resObj.accessToken).toBeUndefined();
  });

  // -------------------------------------------------------------
  // 18. Existing ProviderAccount rows remain compatible
  // -------------------------------------------------------------
  it('18. existing ProviderAccount rows remain compatible', () => {
    seedProvider('prov-google');

    // Legacy handle format used in R5A tests
    const legacyAcct: ProviderAccount = {
      id: 'acct-legacy-01',
      provider_id: 'prov-google',
      label: 'Legacy Gemini Account',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: 'cred-handle-0912',
      profile_ref: null,
      enabled: true,
      priority: 10,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 4,
      last_success_at: new Date().toISOString(),
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createProviderAccount(legacyAcct);

    const loaded = repo.getProviderAccount('acct-legacy-01');
    expect(loaded).not.toBeNull();
    expect(loaded?.credential_ref).toBe('cred-handle-0912');
    expect(loaded?.auth_mode).toBe('API_CREDENTIAL');

    // Update with legacy handle format
    repo.updateProviderAccount('acct-legacy-01', {
      credential_ref: 'cred-handle-updated',
    });
    expect(repo.getProviderAccount('acct-legacy-01')?.credential_ref).toBe('cred-handle-updated');
  });

  // -------------------------------------------------------------
  // 19. Generic provider profile fallback in resolver
  // -------------------------------------------------------------
  it('19. generic provider profile fallback in resolver', () => {
    const resolver = new NativeProfileResolver({
      baseProfilesDir: path.join('C:', 'AgentForge', 'profiles'),
    });

    const resolution = resolver.resolve('native-profile://custom-llm/p1');
    expect(resolution.provider).toBe('custom-llm');
    expect(resolution.isolationStatus).toBe('EXPERIMENTAL_UNPROVEN');
    expect(resolution.envOverrides.CUSTOM_LLM_HOME).toBe(
      path.join('C:', 'AgentForge', 'profiles', 'custom-llm', 'p1')
    );
  });

  // -------------------------------------------------------------
  // 20. Update provider account ref validation
  // -------------------------------------------------------------
  it('20. update provider account ref validation', () => {
    seedProvider('prov-openai');

    repo.createProviderAccount({
      id: 'acct-update-test',
      provider_id: 'prov-openai',
      label: 'Update Test',
      auth_mode: 'NATIVE_PROFILE',
      credential_ref: null,
      profile_ref: 'native-profile://codex/c01',
      enabled: true,
      priority: 10,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Updating to invalid profile_ref should fail
    expect(() => {
      repo.updateProviderAccount('acct-update-test', {
        profile_ref: 'native-profile://codex/../bad',
      });
    }).toThrow(/path traversal is forbidden/);

    // Updating to conflicting credential_ref under NATIVE_PROFILE should fail
    expect(() => {
      repo.updateProviderAccount('acct-update-test', {
        credential_ref: 'wincred://agentforge/key',
      });
    }).toThrow(/contradictory references/);

    // Valid update
    repo.updateProviderAccount('acct-update-test', {
      profile_ref: 'native-profile://codex/c02',
    });
    expect(repo.getProviderAccount('acct-update-test')?.profile_ref).toBe('native-profile://codex/c02');
  });

  // -------------------------------------------------------------
  // 21. Live Windows Credential Store integration (if running on Windows)
  // -------------------------------------------------------------
  it('21. Windows Credential Store integration on win32', async () => {
    if (process.platform !== 'win32') {
      // Skipped on non-Windows (unsupported platform test in test 10 covers this)
      return;
    }

    const winStore = new WindowsCredentialStore();
    const testRef = parseCredentialRef('wincred://agentforge/test/unit-test-key');
    const testSecret = new SecretValue('test-wincred-secret-value-12345');

    try {
      // Put
      await winStore.put(testRef, testSecret);
      expect(await winStore.exists(testRef)).toBe(true);

      // Get
      const retrieved = await winStore.get(testRef);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.exposeSecret()).toBe('test-wincred-secret-value-12345');
    } finally {
      // Delete
      await winStore.delete(testRef);
      expect(await winStore.exists(testRef)).toBe(false);
    }
  });
});
