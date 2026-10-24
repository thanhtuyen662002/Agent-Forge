import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { CodexQuotaClient } from '../src/core/services/CodexQuotaClient';
import { FakeCodexSpawner, QUOTA_RESULT } from './quotaFakes';

const PROFILE = path.join(os.tmpdir(), 'af-quota-fake-profile');
const EXECUTABLE = path.join(os.tmpdir(), 'fake-codex.exe');

function fixture(timeoutMs = 100) {
  const spawner = new FakeCodexSpawner();
  return { spawner, client: new CodexQuotaClient({ spawner, resolveExecutable: () => EXECUTABLE, timeoutMs }) };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('Codex quota app-server client', () => {
  it('performs only initialize, initialized, and the quota read with isolated safe spawn options', async () => {
    const { spawner, client } = fixture();
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-inherited-value');
    vi.stubEnv('CODEX_HOME', path.join(os.tmpdir(), 'wrong-profile'));
    const result = await client.readRateLimits(PROFILE);
    expect(result).toEqual({
      status: 'OK', primary: QUOTA_RESULT.rateLimits.primary,
      secondary: QUOTA_RESULT.rateLimits.secondary, planType: 'plus',
    });
    expect(spawner.children[0].messages).toEqual([
      { id: 1, method: 'initialize', params: { clientInfo: { name: 'agent_forge_quota', version: '1.0.0' } } },
      { method: 'initialized' },
      { id: 2, method: 'account/rateLimits/read', params: {} },
    ]);
    const [executable, args, options] = spawner.spawn.mock.calls[0];
    expect(executable).toBe(EXECUTABLE);
    expect(args).toEqual(['app-server']);
    expect(options).toMatchObject({ shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    expect(options.env.CODEX_HOME).toBe(PROFILE);
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
    expect(spawner.children[0].kill).toHaveBeenCalledWith('SIGKILL');
    expect(JSON.stringify(result)).not.toContain('provider-only-metadata');
  });

  it('keeps absent nullable metadata unknown without inventing resets or secondary windows', async () => {
    const { spawner, client } = fixture();
    spawner.result = { rateLimits: { primary: { usedPercent: 0 } } };
    expect(await client.readRateLimits(PROFILE)).toEqual({
      status: 'OK', primary: { usedPercent: 0, resetsAt: null, windowDurationMins: null }, secondary: null, planType: null,
    });
  });

  it.each([
    { rateLimits: null }, {},
    { rateLimits: { primary: { usedPercent: '37' } } },
    ...[-1, 101, 0.5].map((usedPercent) => ({ rateLimits: { primary: { usedPercent } } })),
    { rateLimits: { primary: { usedPercent: 37, resetsAt: 8_640_000_000_001 } } },
    { rateLimits: { primary: { usedPercent: 37, windowDurationMins: -1 } } },
    { rateLimits: { primary: { usedPercent: 37 }, secondary: { usedPercent: '12' } } },
    { rateLimits: { primary: { usedPercent: 37 }, planType: { unexpected: true } } },
    { rateLimits: { primary: { usedPercent: 37 }, credits: { hasCredits: 'yes' } } },
  ])('rejects malformed quota fields without coercion: %j', async (result) => {
    const { spawner, client } = fixture();
    spawner.result = result;
    expect(await client.readRateLimits(PROFILE)).toMatchObject({ status: 'MALFORMED' });
    expect(spawner.children[0].kill).toHaveBeenCalledOnce();
  });

  it.each([{}, { primary: null }, { primary: null, secondary: QUOTA_RESULT.rateLimits.secondary }])(
    'reports an absent primary window as unavailable: %j', async (rateLimits) => {
      const { spawner, client } = fixture();
      spawner.result = { rateLimits };
      expect(await client.readRateLimits(PROFILE)).toMatchObject({ status: 'UNAVAILABLE' });
    },
  );

  it('sanitizes unauthenticated errors instead of retaining provider error text', async () => {
    const { spawner, client } = fixture();
    spawner.onRateRead = (child) => child.reply({ id: 2, error: { code: -32000, message: 'Not logged in: synthetic-private-detail' } });
    const result = await client.readRateLimits(PROFILE);
    expect(result).toMatchObject({ status: 'UNAUTHENTICATED' });
    expect(JSON.stringify(result)).not.toContain('synthetic-private-detail');
    expect(spawner.children[0].kill).toHaveBeenCalledOnce();
  });

  it('reports ordinary provider failures as unavailable', async () => {
    const { spawner, client } = fixture();
    spawner.onRateRead = (child) => child.reply({ id: 2, error: { code: -32000, message: 'Upstream unavailable' } });
    expect(await client.readRateLimits(PROFILE)).toMatchObject({ status: 'UNAVAILABLE' });
  });

  it('kills the child at the total deadline even if initialization never finishes', async () => {
    vi.useFakeTimers();
    const { spawner, client } = fixture(123);
    spawner.onInitialize = () => undefined;
    const pending = client.readRateLimits(PROFILE);
    await vi.advanceTimersByTimeAsync(123);
    expect(await pending).toMatchObject({ status: 'TIMEOUT' });
    expect(spawner.children[0].kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(spawner.children[0].stdin.destroyed).toBe(true);
    expect(spawner.children[0].stdout.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects malformed JSON, invalid initialization, and excessive output with cleanup', async () => {
    for (const failure of ['json', 'initialize', 'oversize']) {
      const { spawner, client } = fixture();
      if (failure === 'initialize') spawner.onInitialize = (child) => child.reply({ id: 1, result: {} });
      else spawner.onRateRead = (child) => { child.stdout.write(failure === 'json' ? '{broken\n' : 'x'.repeat(1024 * 1024 + 1)); };
      expect(await client.readRateLimits(PROFILE)).toMatchObject({ status: 'MALFORMED' });
      expect(spawner.children[0].kill).toHaveBeenCalledOnce();
    }
  });

  it('handles partial UTF-8 lines and ignores notifications and unrelated response IDs', async () => {
    const { spawner, client } = fixture();
    spawner.onRateRead = (child) => {
      const notification = Buffer.from(`${JSON.stringify({ method: 'notice', params: 'quota \u00e9' })}\n`);
      const split = notification.indexOf(Buffer.from('\u00e9')) + 1;
      child.stdout.write(notification.subarray(0, split));
      child.stdout.write(notification.subarray(split));
      child.reply({ id: 999, result: { rateLimits: { primary: { usedPercent: 99 } } } });
      const reply = JSON.stringify({ id: 2, result: QUOTA_RESULT });
      child.stdout.write(reply.slice(0, 17));
      child.stdout.write(`${reply.slice(17)}\n`);
    };
    expect(await client.readRateLimits(PROFILE)).toMatchObject({ status: 'OK', primary: { usedPercent: 37 } });
  });

  it.each(['close', 'error', 'stdin', 'stdout'] as const)('cleans up on early %s failure', async (failure) => {
    const { spawner, client } = fixture();
    spawner.onRateRead = (child) => {
      if (failure === 'close') child.emit('close', 1);
      else if (failure === 'error') child.emit('error', new Error('synthetic provider error'));
      else child[failure].emit('error', new Error('synthetic pipe error'));
    };
    expect(await client.readRateLimits(PROFILE)).toMatchObject({ status: 'UNAVAILABLE' });
    expect(spawner.children[0].kill).toHaveBeenCalledOnce();
  });

  it('does not spawn for a missing executable or invalid profile path', async () => {
    const spawner = new FakeCodexSpawner();
    const client = new CodexQuotaClient({ spawner, resolveExecutable: () => null });
    expect(await client.readRateLimits(PROFILE)).toMatchObject({ status: 'UNAVAILABLE' });
    expect(await client.readRateLimits('relative-profile')).toMatchObject({ status: 'UNAVAILABLE' });
    expect(spawner.spawn).not.toHaveBeenCalled();
  });

  it('rejects initialization of a different profile without requesting quota', async () => {
    const { spawner, client } = fixture();
    spawner.onInitialize = (child) => child.reply({ id: 1, result: {
      userAgent: 'fake-codex', codexHome: path.join(os.tmpdir(), 'different-profile'),
      platformFamily: 'windows', platformOs: 'windows',
    } });
    expect(await client.readRateLimits(PROFILE)).toMatchObject({ status: 'UNAVAILABLE' });
    expect(spawner.children[0].messages.map((message) => message.method)).toEqual(['initialize']);
    expect(spawner.children[0].kill).toHaveBeenCalledOnce();
  });

  it('sanitizes spawn failures and bounds configurable timeouts', async () => {
    const { spawner, client } = fixture();
    spawner.spawn.mockImplementation(() => { throw new Error('synthetic-private-detail'); });
    expect(await client.readRateLimits(PROFILE)).toEqual({ status: 'UNAVAILABLE', message: 'Codex quota telemetry could not be started.' });
    for (const timeoutMs of [0, -1, 15_001, NaN, Infinity, 1.5]) {
      expect(() => new CodexQuotaClient({ timeoutMs })).toThrow(RangeError);
    }
  });
});
