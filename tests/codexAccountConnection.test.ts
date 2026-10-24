import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NativeProfileResolver } from '../src/core/credentials/NativeProfileResolver';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { CodexAccountConnectionService, type CodexAccountConnectionServiceOptions } from '../src/core/services/CodexAccountConnectionService';
import { buildTrustedEnvironment } from '../src/core/services/ExecutableResolver';
import { WorkspaceManagementService } from '../src/core/services/WorkspaceManagementService';
import { completeLogin, DEVICE_LOGIN, FakeCodexLoginSpawner } from './codexLoginFakes';
import type { FakeCodexProcess } from './quotaFakes';

const NOW = '2026-10-24T08:00:00.000Z';
const EXECUTABLE = path.join(os.tmpdir(), 'fake-codex.exe');

describe('managed Codex device-code connection', () => {
  let db: Database.Database;
  let repo: Repository;
  let management: WorkspaceManagementService;
  let profileResolver: NativeProfileResolver;
  let tempRoot: string;
  let spawner: FakeCodexLoginSpawner;
  let service: CodexAccountConnectionService;
  let services: CodexAccountConnectionService[];
  let expectedAccounts: unknown[];
  let onSignedIn: ReturnType<typeof vi.fn<(accountId: string) => void>>;

  const accountRows = () => db.prepare('SELECT * FROM provider_accounts ORDER BY id').all();
  const rememberAccounts = () => { expectedAccounts = accountRows(); };

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    management = new WorkspaceManagementService(repo, () => NOW);
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'af-login-test-'));
    profileResolver = new NativeProfileResolver({ baseProfilesDir: tempRoot });
    spawner = new FakeCodexLoginSpawner();
    onSignedIn = vi.fn<(accountId: string) => void>();
    services = [];
    service = makeService();
    rememberAccounts();
  });

  afterEach(() => {
    try {
      for (const instance of services) instance.dispose();
      // Every test, including rejected starts and quit, guards every column.
      expect(accountRows()).toEqual(expectedAccounts);
      for (const child of spawner.children) {
        expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
        expect(child.stdin.destroyed).toBe(true);
        expect(child.stdout.destroyed).toBe(true);
        expect(child.stdout.listenerCount('data')).toBe(0);
        expect(child.listenerCount('close')).toBe(0);
      }
      if (vi.isFakeTimers()) expect(vi.getTimerCount()).toBe(0);
    } finally {
      db.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
      vi.useRealTimers();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });

  function makeService(options: CodexAccountConnectionServiceOptions = {}) {
    const instance = new CodexAccountConnectionService(repo, {
      spawner, profileResolver, resolveExecutable: () => EXECUTABLE,
      now: () => NOW, onSignedIn, ...options,
    });
    services.push(instance);
    return instance;
  }

  function createAccount(connection: 'CODEX_CLI' | 'GEMINI_CLI' = 'CODEX_CLI') {
    const created = management.createAgent({
      displayName: 'Login test account', role: 'CODER', connection, modelName: 'test-model', workerSlots: 1,
    });
    if (!created.success) throw new Error(created.error);
    const resource = repo.getProviderResource(created.agent.provider_resource_id!)!;
    const account = repo.getProviderAccount(resource.provider_account_id!)!;
    rememberAccounts();
    return account;
  }

  async function start(accountId = createAccount().id, instance = service) {
    const result = await instance.startDeviceLogin(accountId);
    expect(accountRows()).toEqual(expectedAccounts);
    if (!result.success) throw new Error(`Unexpected test login failure: ${result.errorCode}`);
    return result;
  }

  it('handshakes before requesting a device code, creates the isolated directory, and leaves the child alive', async () => {
    const account = createAccount();
    const directory = profileResolver.resolve(account.profile_ref!).profileDirectory;
    expect(fs.existsSync(directory)).toBe(false);
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-inherited-value');
    vi.stubEnv('CODEX_HOME', path.join(tempRoot, 'wrong-profile'));
    const result = await start(account.id);
    expect(result).toEqual({ success: true, accountId: account.id, sessionId: expect.any(String),
      userCode: DEVICE_LOGIN.userCode, verificationUrl: DEVICE_LOGIN.verificationUrl,
      expiresAt: '2026-10-24T08:15:00.000Z',
    });
    expect(fs.existsSync(directory)).toBe(true);
    const child = spawner.children[0];
    expect(child.messages).toEqual([
      { id: 1, method: 'initialize', params: { clientInfo: { name: 'agent_forge_login', version: '1.0.0' } } },
      { method: 'initialized' },
      { id: 2, method: 'account/login/start', params: { type: 'chatgptDeviceCode' } },
    ]);
    expect(spawner.spawn).toHaveBeenCalledExactlyOnceWith(EXECUTABLE, ['app-server'], {
      env: buildTrustedEnvironment({ allowedEnvKeys: ['CODEX_HOME'], customEnv: { CODEX_HOME: directory } }),
      cwd: os.tmpdir(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    expect(spawner.spawn.mock.calls[0][2].env.OPENAI_API_KEY).toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
    expect(service.getLoginStatus(result.sessionId)).toEqual({
      state: 'WAITING_FOR_USER', accountId: account.id, userCode: result.userCode,
      verificationUrl: result.verificationUrl, expiresAt: result.expiresAt,
    });
    const detached = service.getLoginStatus(result.sessionId)!;
    detached.state = 'SIGNED_IN';
    expect(service.getLoginStatus(result.sessionId)!.state).toBe('WAITING_FOR_USER');
    expect(service.getLoginStatus('missing')).toBeNull();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('rejects a mismatched codexHome before sending login/start', async () => {
    spawner.onInitialize = (child) => child.reply({ id: 1, result: {
      userAgent: 'fake', codexHome: path.join(tempRoot, 'wrong-profile'), platformFamily: 'windows', platformOs: 'windows',
    } });
    expect(await service.startDeviceLogin(createAccount().id)).toEqual({ success: false, errorCode: 'PROFILE_UNAVAILABLE' });
    expect(spawner.children[0].messages.map((message) => message.method)).toEqual(['initialize']);
  });

  it.each(['missing', 'disabled', 'gemini', 'manual', 'api'] as const)('rejects %s accounts without spawning', async (kind) => {
    const account = createAccount(kind === 'gemini' ? 'GEMINI_CLI' : 'CODEX_CLI');
    if (kind === 'disabled') repo.updateProviderAccount(account.id, { enabled: false });
    if (kind === 'manual') {
      const manual = management.createAgent({ displayName: 'Manual', role: 'CODER', connection: 'MANUAL_BRIDGE', modelName: 'test-model', workerSlots: 1 });
      if (!manual.success) throw new Error(manual.error);
      const providerId = repo.getProviderResource(manual.agent.provider_resource_id!)!.provider_id;
      db.prepare('UPDATE provider_accounts SET provider_id = ? WHERE id = ?').run(providerId, account.id);
    }
    if (kind === 'api') db.prepare("UPDATE provider_accounts SET auth_mode = 'API_CREDENTIAL', profile_ref = NULL WHERE id = ?").run(account.id);
    rememberAccounts();
    expect(await service.startDeviceLogin(kind === 'missing' ? 'missing' : account.id)).toEqual({
      success: false, errorCode: kind === 'missing' || kind === 'disabled' ? 'ACCOUNT_NOT_FOUND' : 'NOT_A_CODEX_ACCOUNT',
    });
    expect(spawner.spawn).not.toHaveBeenCalled();
  });

  it.each([null, 'native-profile://codex/../bad', 'native-profile://gemini/other'])('rejects unavailable profiles: %s', async (ref) => {
    const account = createAccount();
    db.prepare('UPDATE provider_accounts SET profile_ref = ? WHERE id = ?').run(ref, account.id);
    rememberAccounts();
    expect(await service.startDeviceLogin(account.id)).toEqual({ success: false, errorCode: 'PROFILE_UNAVAILABLE' });
    expect(spawner.spawn).not.toHaveBeenCalled();
  });

  it('maps resolver and directory creation failures to PROFILE_UNAVAILABLE', async () => {
    const account = createAccount();
    service = makeService({ profileResolver: { resolve: () => { throw new Error('synthetic-private-detail'); } } });
    expect(await service.startDeviceLogin(account.id)).toEqual({ success: false, errorCode: 'PROFILE_UNAVAILABLE' });
    service = makeService();
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => { throw new Error('synthetic-private-detail'); });
    expect(await service.startDeviceLogin(account.id)).toEqual({ success: false, errorCode: 'PROFILE_UNAVAILABLE' });
    expect(spawner.spawn).not.toHaveBeenCalled();
  });

  it('reserves the account during initialization and waiting, and releases it on completion', async () => {
    const account = createAccount();
    const pending = service.startDeviceLogin(account.id);
    expect(await service.startDeviceLogin(account.id)).toEqual({ success: false, errorCode: 'LOGIN_ALREADY_IN_PROGRESS' });
    const result = await pending;
    if (!result.success) throw new Error(result.errorCode);
    expect(await service.startDeviceLogin(account.id)).toEqual({ success: false, errorCode: 'LOGIN_ALREADY_IN_PROGRESS' });
    expect(spawner.spawn).toHaveBeenCalledOnce();
    completeLogin(spawner.children[0]);
    const retry = await start(account.id);
    expect(retry.sessionId).not.toBe(result.sessionId);
    service.cancelLogin(result.sessionId);
    expect(service.getLoginStatus(retry.sessionId)!.state).toBe('WAITING_FOR_USER');
  });

  it('signs in only on matching completion, calls the hook once, and preserves existing failures/cooldown', async () => {
    const account = createAccount();
    db.prepare('UPDATE provider_accounts SET health_status = ?, cooldown_until = ?, last_failure_code = ?, last_failure_at = ? WHERE id = ?')
      .run('AUTH_ERROR', '2026-10-25T00:00:00.000Z', 'EXISTING_FAILURE', NOW, account.id);
    rememberAccounts();
    const result = await start(account.id);
    const child = spawner.children[0];
    completeLogin(child, false, 'other-id');
    child.reply({ method: 'account/login/completed', params: { loginId: 'other-id', success: 'malformed' } });
    child.reply({ method: 'account/updated', params: { account: null } });
    expect(service.getLoginStatus(result.sessionId)!.state).toBe('WAITING_FOR_USER');
    expect(onSignedIn).not.toHaveBeenCalled();
    completeLogin(child);
    expect(service.getLoginStatus(result.sessionId)).toMatchObject({ state: 'SIGNED_IN', accountId: account.id });
    expect(service.getLoginStatus(result.sessionId)!.userCode).toBeUndefined();
    // Simulate late delivery even after stream destruction.
    child.stdout.emit('data', `${JSON.stringify({ method: 'account/login/completed', params: { ...DEVICE_LOGIN, success: true, error: null } })}\n`);
    child.emit('close', 0);
    service.cancelLogin(result.sessionId);
    service.dispose();
    expect(onSignedIn).toHaveBeenCalledExactlyOnceWith(account.id);
    expect(service.getLoginStatus(result.sessionId)!.state).toBe('SIGNED_IN');
  });

  it('maps provider completion failure to FAILED without returning error text', async () => {
    const result = await start();
    completeLogin(spawner.children[0], false);
    expect(service.getLoginStatus(result.sessionId)).toMatchObject({ state: 'FAILED', errorCode: 'LOGIN_FAILED' });
    expect(JSON.stringify(service.getLoginStatus(result.sessionId))).not.toContain('synthetic-private-provider-detail');
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it.each(['throw', 'reject'] as const)('contains a %s from onSignedIn without changing native login state', async (kind) => {
    service = makeService({ onSignedIn: () => {
      if (kind === 'throw') throw new Error('synthetic-hook-detail');
      return Promise.reject(new Error('synthetic-hook-detail'));
    } });
    const result = await start();
    completeLogin(spawner.children[0]);
    await Promise.resolve();
    expect(service.getLoginStatus(result.sessionId)!.state).toBe('SIGNED_IN');
  });

  it('cancels by native loginId before killing, is idempotent, and permits retry', async () => {
    const account = createAccount();
    const result = await start(account.id);
    const child = spawner.children[0];
    child.kill.mockImplementation(() => {
      expect(child.messages.at(-1)).toEqual({ id: 3, method: 'account/login/cancel', params: { loginId: DEVICE_LOGIN.loginId } });
      return true;
    });
    service.cancelLogin(result.sessionId);
    service.cancelLogin(result.sessionId);
    service.cancelLogin('missing');
    expect(child.messages.filter((message) => message.method === 'account/login/cancel')).toHaveLength(1);
    expect(service.getLoginStatus(result.sessionId)!.state).toBe('CANCELLED');
    expect(onSignedIn).not.toHaveBeenCalled();
    await start(account.id);
  });

  it.each(['initialize', 'start', 'waiting'] as const)('times out during %s, kills the child, and releases ownership', async (phase) => {
    vi.useFakeTimers();
    service = makeService({ timeoutMs: 123 });
    const account = createAccount();
    if (phase === 'initialize') spawner.onInitialize = () => undefined;
    if (phase === 'start') spawner.onStart = () => undefined;
    const pending = service.startDeviceLogin(account.id);
    const result = phase === 'waiting' ? await pending : null;
    await vi.advanceTimersByTimeAsync(123);
    if (result?.success) expect(service.getLoginStatus(result.sessionId)).toMatchObject({ state: 'TIMED_OUT', errorCode: 'TIMEOUT' });
    else expect(await pending).toEqual({ success: false, errorCode: 'TIMEOUT' });
    expect(spawner.children[0].kill).toHaveBeenCalledOnce();
    expect(onSignedIn).not.toHaveBeenCalled();
    spawner.onInitialize = null;
    spawner.onStart = null;
    await start(account.id);
  });

  it.each([
    'http://auth.openai.com/device', 'https://openai.com.evil.test/device', 'https://evilopenai.com/device',
    'https://evil.test/?next=auth.openai.com', 'https://auth.openai.com@evil.test/device',
    'https://evil.chatgpt.com/device', 'javascript:alert(1)', 'not-a-url',
    'https://user:password@auth.openai.com/device',
  ])('rejects malicious verification URLs: %s', async (verificationUrl) => {
    spawner.result = { ...DEVICE_LOGIN, verificationUrl };
    expect(await service.startDeviceLogin(createAccount().id)).toEqual({ success: false, errorCode: 'PROTOCOL_ERROR' });
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it.each(['https://auth.openai.com/device', 'https://login.openai.com/device', 'https://chatgpt.com/device'])(
    'accepts an allowed verification URL: %s', async (verificationUrl) => {
      spawner.result = { ...DEVICE_LOGIN, verificationUrl };
      expect((await start()).verificationUrl).toBe(verificationUrl);
    },
  );

  it.each([
    {}, { ...DEVICE_LOGIN, type: 'apiKey' }, { ...DEVICE_LOGIN, loginId: '' },
    ...['', 'A'.repeat(33), 'A B', 'AB\nCD', 'ABCD\n', 'ABCD\r', 'AB\u001bCD', '<script>', 'é'].map((userCode) => ({ ...DEVICE_LOGIN, userCode })),
    { ...DEVICE_LOGIN, userCode: 123 }, { ...DEVICE_LOGIN, verificationUrl: 123 },
  ])('strictly rejects malformed start results without coercion: %j', async (result) => {
    spawner.result = result;
    expect(await service.startDeviceLogin(createAccount().id)).toEqual({ success: false, errorCode: 'PROTOCOL_ERROR' });
  });

  it.each(['true', 1, null])('does not interpret malformed completion success %j as success', async (success) => {
    const result = await start();
    spawner.children[0].reply({ method: 'account/login/completed', params: { loginId: DEVICE_LOGIN.loginId, success, error: null } });
    expect(service.getLoginStatus(result.sessionId)).toMatchObject({ state: 'FAILED', errorCode: 'PROTOCOL_ERROR' });
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('handles fragmented UTF-8/CRLF lines, unrelated responses, and coalesced start/completion', async () => {
    spawner.onStart = (child) => {
      const notice = Buffer.from(`${JSON.stringify({ method: 'account/updated', params: 'notice é' })}\r\n`);
      const split = notice.indexOf(Buffer.from('é')) + 1;
      child.stdout.write(notice.subarray(0, split));
      child.stdout.write(notice.subarray(split));
      child.reply({ id: 999, result: { unexpected: true } });
      const response = JSON.stringify({ id: 2, result: { ...DEVICE_LOGIN, extension: 'discard-me' } });
      child.stdout.write(response.slice(0, 13));
      child.stdout.write(`${response.slice(13)}\n${JSON.stringify({ method: 'account/login/completed', params: { loginId: DEVICE_LOGIN.loginId, success: true, error: null } })}\n`);
    };
    const result = await start();
    expect(service.getLoginStatus(result.sessionId)!.state).toBe('SIGNED_IN');
    expect(onSignedIn).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('discard-me');
  });

  it('accepts bounded lowercase codes and never lets account/updated stand in for completion', async () => {
    spawner.result = { ...DEVICE_LOGIN, userCode: 'abcd-1234' };
    const result = await start();
    expect(result.userCode).toBe('abcd-1234');
    spawner.children[0].reply({ method: 'account/updated', params: { account: { type: 'chatgpt' } } });
    expect(service.getLoginStatus(result.sessionId)!.state).toBe('WAITING_FOR_USER');
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('enforces the cumulative output bound while waiting, even for framed notifications', async () => {
    const result = await start();
    const child = spawner.children[0];
    const notice = { method: 'account/updated', params: { ignored: 'x'.repeat(64 * 1024) } };
    for (let index = 0; index < 16; index += 1) child.reply(notice);
    expect(service.getLoginStatus(result.sessionId)).toMatchObject({ state: 'FAILED', errorCode: 'PROTOCOL_ERROR' });
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('keeps cancellation authoritative when stdin errors synchronously during the cancel write', async () => {
    const result = await start();
    spawner.children[0].stdin.write = () => {
      completeLogin(spawner.children[0]);
      spawner.children[0].stdin.emit('error', new Error('synthetic-cancel-write-error'));
      throw new Error('synthetic-cancel-error');
    };
    service.cancelLogin(result.sessionId);
    expect(service.getLoginStatus(result.sessionId)!.state).toBe('CANCELLED');
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it.each(['json', 'initialize', 'oversize', 'envelope', 'rpc-error-shape', 'ambiguous-error'] as const)(
    'cleans up malformed %s protocol output', async (failure) => {
      if (failure === 'initialize') spawner.onInitialize = (child) => child.reply({ id: 1, result: {} });
      else spawner.onStart = (child) => {
        if (failure === 'json') child.stdout.write('{broken\n');
        else if (failure === 'oversize') child.stdout.write('x'.repeat(1024 * 1024 + 1));
        else if (failure === 'envelope') child.reply([]);
        else if (failure === 'rpc-error-shape') child.reply({ id: 2, error: { code: '401', message: 'synthetic' } });
        else child.reply({ id: 2, error: { code: 401, message: 'synthetic' }, result: DEVICE_LOGIN });
      };
      expect(await service.startDeviceLogin(createAccount().id)).toEqual({ success: false, errorCode: 'PROTOCOL_ERROR' });
    },
  );

  it.each(['close', 'error', 'stdin', 'stdout', 'rpc'] as const)('maps early %s failures to static CODEX_UNAVAILABLE', async (failure) => {
    spawner.onStart = (child) => failChild(child, failure);
    expect(await service.startDeviceLogin(createAccount().id)).toEqual({ success: false, errorCode: 'CODEX_UNAVAILABLE' });
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it.each(['close', 'error', 'stdin', 'stdout'] as const)('marks a waiting session FAILED after %s, absorbing late errors', async (failure) => {
    const result = await start();
    const child = spawner.children[0];
    failChild(child, failure);
    expect(service.getLoginStatus(result.sessionId)).toMatchObject({ state: 'FAILED', errorCode: 'CODEX_UNAVAILABLE' });
    expect(() => {
      child.emit('error', new Error('synthetic-late-error'));
      child.stdin.emit('error', new Error('synthetic-late-pipe-error'));
      child.stdout.emit('error', new Error('synthetic-late-pipe-error'));
    }).not.toThrow();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  function failChild(child: FakeCodexProcess, failure: 'close' | 'error' | 'stdin' | 'stdout' | 'rpc') {
    if (failure === 'close') child.emit('close', 0);
    else if (failure === 'error') child.emit('error', new Error('synthetic-private-detail'));
    else if (failure === 'rpc') child.reply({ id: 2, error: { code: 401, message: 'synthetic-private-detail' } });
    else child[failure].emit('error', new Error('synthetic-private-pipe-detail'));
  }

  it('handles a synchronous stdin write failure and a kill exception without leaking text', async () => {
    const spawn = spawner.spawn.getMockImplementation()!;
    spawner.spawn.mockImplementation((...args) => {
      const child = spawn(...args);
      child.stdin.write = () => { throw new Error('synthetic-private-write-detail'); };
      child.kill.mockImplementation(() => { throw new Error('synthetic-private-kill-detail'); });
      return child;
    });
    expect(await service.startDeviceLogin(createAccount().id)).toEqual({ success: false, errorCode: 'CODEX_UNAVAILABLE' });
  });

  it('sanitizes unavailable executable resolution/spawning and disallows Windows shell shims', async () => {
    const account = createAccount();
    for (const resolveExecutable of [() => null, () => { throw new Error('synthetic-private-detail'); }]) {
      service = makeService({ resolveExecutable });
      expect(await service.startDeviceLogin(account.id)).toEqual({ success: false, errorCode: 'CODEX_UNAVAILABLE' });
    }
    if (process.platform === 'win32') {
      for (const suffix of ['cmd', 'bat']) {
        service = makeService({ resolveExecutable: () => path.join(tempRoot, `codex.${suffix}`) });
        expect(await service.startDeviceLogin(account.id)).toEqual({ success: false, errorCode: 'CODEX_UNAVAILABLE' });
      }
    }
    expect(spawner.spawn).not.toHaveBeenCalled();
    spawner.spawn.mockImplementation(() => { throw new Error('synthetic-private-detail'); });
    service = makeService();
    expect(await service.startDeviceLogin(account.id)).toEqual({ success: false, errorCode: 'CODEX_UNAVAILABLE' });
  });

  it('disposes every account, settles pending initialization, and refuses starts after quit', async () => {
    const result = await start();
    const another = createAccount();
    spawner.onInitialize = () => undefined;
    const pending = service.startDeviceLogin(another.id);
    service.dispose();
    service.dispose();
    expect(await pending).toEqual({ success: false, errorCode: 'CODEX_UNAVAILABLE' });
    expect(service.getLoginStatus(result.sessionId)!.state).toBe('CANCELLED');
    expect(await service.startDeviceLogin(another.id)).toEqual({ success: false, errorCode: 'CODEX_UNAVAILABLE' });
    expect(spawner.children).toHaveLength(2);
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('bounds the total timeout to 30 minutes', () => {
    for (const timeoutMs of [0, -1, 1_800_001, NaN, Infinity, 1.5]) {
      expect(() => makeService({ timeoutMs })).toThrow(RangeError);
    }
    expect(() => makeService({ timeoutMs: 1_800_000 })).not.toThrow();
  });
});
