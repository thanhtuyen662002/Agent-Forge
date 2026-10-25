import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NativeProfileResolver } from '../src/core/credentials/NativeProfileResolver';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { AccountQuotaService } from '../src/core/services/AccountQuotaService';
import {
  CLAUDE_USAGE_URL, ClaudeUsageReader, GEMINI_LOAD_URL, GEMINI_QUOTA_URL, GeminiQuotaReader,
  type QuotaHttpFetch, type UnofficialQuotaReader, type UnofficialQuotaResult,
} from '../src/core/services/UnofficialQuotaReaders';
import { WorkspaceManagementService } from '../src/core/services/WorkspaceManagementService';
import type { QuotaObservation } from '../src/core/types/quota';
import { buildQuotaGroups } from '../src/ui/quotaDashboard';

const NOW = Date.parse('2026-10-25T08:00:00.000Z');
const TOKEN = 'sentinel-oauth-token-must-not-leak';

type Call = { url: string; method: string; headers: Record<string, string>; body?: string; redirect: string };

/** Answers by URL; records every request without performing network I/O. */
function fakeFetch(answers: Record<string, { status: number; body: unknown } | 'HANG'>): { fetch: QuotaHttpFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: QuotaHttpFetch = (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body, redirect: init.redirect });
    const answer = answers[url];
    if (answer === 'HANG') {
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    if (!answer) return Promise.reject(new Error('unexpected URL'));
    return Promise.resolve({ status: answer.status, text: async () => (typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)) });
  };
  return { fetch, calls };
}

describe('unofficial Claude Code and Gemini quota readers (#250)', () => {
  let profile: string;
  beforeEach(() => { profile = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-unofficial-quota-'))); });
  afterEach(() => fs.rmSync(profile, { recursive: true, force: true }));

  const writeClaude = (oauth: Record<string, unknown>) =>
    fs.writeFileSync(path.join(profile, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }), 'utf8');
  const writeGemini = (creds: Record<string, unknown>) => {
    fs.mkdirSync(path.join(profile, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(profile, '.gemini', 'oauth_creds.json'), JSON.stringify(creds), 'utf8');
  };
  const claudeUsage = { five_hour: { utilization: 37.4, resets_at: '2026-10-25T10:00:00+00:00' }, seven_day: { utilization: 80, resets_at: '2026-10-30T00:00:00Z' } };

  it('reads Claude 5-hour and 7-day usage with the saved token, read-only, without leaking it', async () => {
    writeClaude({ accessToken: TOKEN, expiresAt: NOW + 3_600_000, subscriptionType: 'max' });
    const file = path.join(profile, '.credentials.json');
    const before = fs.readFileSync(file, 'utf8');
    const { fetch, calls } = fakeFetch({ [CLAUDE_USAGE_URL]: { status: 200, body: claudeUsage } });

    const result = await new ClaudeUsageReader({ fetch, now: () => NOW }).read(profile);

    expect(result).toEqual({
      status: 'OK', planType: 'max',
      primary: { usedPercent: 37, resetsAt: '2026-10-25T10:00:00.000Z', windowMinutes: 300 },
      secondary: { usedPercent: 80, resetsAt: '2026-10-30T00:00:00.000Z', windowMinutes: 10080 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: CLAUDE_USAGE_URL, method: 'GET', redirect: 'error' });
    expect(calls[0].headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, 'anthropic-beta': 'oauth-2025-04-20' });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(fs.readFileSync(file, 'utf8')).toBe(before); // Never refreshed or rewritten.
  });

  it('never refreshes an expired Claude token or calls the provider without a sign-in', async () => {
    const { fetch, calls } = fakeFetch({});
    const reader = new ClaudeUsageReader({ fetch, now: () => NOW });
    expect(await reader.read(profile)).toMatchObject({ status: 'UNAVAILABLE' }); // No file: not proof of a lost sign-in.
    writeClaude({ accessToken: TOKEN, expiresAt: NOW - 1 });
    expect(await reader.read(profile)).toMatchObject({ status: 'UNAUTHENTICATED' });
    fs.writeFileSync(path.join(profile, '.credentials.json'), JSON.stringify({ apiKey: 'x' }), 'utf8');
    expect(await reader.read(profile)).toMatchObject({ status: 'UNAUTHENTICATED' });
    expect(await reader.read('relative/profile')).toMatchObject({ status: 'UNAVAILABLE' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [401, { error: 'x' }, 'UNAUTHENTICATED'],
    [403, { error: 'x' }, 'UNAUTHENTICATED'],
    [500, { error: 'x' }, 'UNAVAILABLE'],
    [200, 'not json', 'MALFORMED'],
    [200, { five_hour: { utilization: 140 } }, 'MALFORMED'],
    [200, { five_hour: null, seven_day: null }, 'UNAVAILABLE'],
  ])('maps a Claude %s response to %s with a static message', async (status, body, expected) => {
    writeClaude({ accessToken: TOKEN });
    const { fetch } = fakeFetch({ [CLAUDE_USAGE_URL]: { status, body: typeof body === 'string' ? body : { ...body, echo: TOKEN } } });
    const result = await new ClaudeUsageReader({ fetch, now: () => NOW }).read(profile);
    expect(result.status).toBe(expected);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('times out a hanging provider', async () => {
    writeClaude({ accessToken: TOKEN });
    const { fetch } = fakeFetch({ [CLAUDE_USAGE_URL]: 'HANG' });
    expect(await new ClaudeUsageReader({ fetch, now: () => NOW, timeoutMs: 20 }).read(profile)).toMatchObject({ status: 'TIMEOUT' });
  });

  it('reads the tightest Gemini quota bucket through the Code Assist project', async () => {
    writeGemini({ access_token: TOKEN, refresh_token: 'refresh-sentinel', expiry_date: NOW + 60_000 });
    const { fetch, calls } = fakeFetch({
      [GEMINI_LOAD_URL]: { status: 200, body: { cloudaicompanionProject: 'proj-123', currentTier: { id: 'free-tier' } } },
      [GEMINI_QUOTA_URL]: { status: 200, body: { buckets: [
        { modelId: 'gemini-2.5-flash', remainingFraction: 0.9, resetTime: '2026-10-26T00:00:00Z' },
        { modelId: 'gemini-2.5-pro', remainingFraction: 0.5, resetTime: '2026-10-26T07:00:00Z', tokenType: 'REQUESTS' },
        { modelId: 'gemini-2.5-pro', remainingFraction: 0.25, resetTime: '2026-10-26T07:00:00Z', tokenType: 'TOKENS' },
        { modelId: 'other' },
        { modelId: `bad model ${TOKEN}`, remainingFraction: 1 },
      ] } },
    });

    const result = await new GeminiQuotaReader({ fetch, now: () => NOW }).read(profile);

    expect(result).toEqual({
      status: 'OK', planType: 'free-tier', secondary: null,
      primary: { usedPercent: 75, resetsAt: '2026-10-26T07:00:00.000Z', windowMinutes: null },
      buckets: [
        { label: 'gemini-2.5-pro', usedPercent: 75, resetsAt: '2026-10-26T07:00:00.000Z', windowMinutes: null },
        { label: 'gemini-2.5-flash', usedPercent: 10, resetsAt: '2026-10-26T00:00:00.000Z', windowMinutes: null },
        { label: 'model', usedPercent: 0, resetsAt: null, windowMinutes: null },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(calls.map((call) => [call.url, call.method, call.redirect])).toEqual([[GEMINI_LOAD_URL, 'POST', 'error'], [GEMINI_QUOTA_URL, 'POST', 'error']]);
    expect(JSON.parse(calls[1].body!)).toEqual({ project: 'proj-123' });
    expect(calls.every((call) => !String(call.body).includes('refresh-sentinel'))).toBe(true);
  });

  it('stops safely for an expired Gemini token or an account without a project', async () => {
    writeGemini({ access_token: TOKEN, expiry_date: NOW - 1 });
    const expired = fakeFetch({});
    expect(await new GeminiQuotaReader({ fetch: expired.fetch, now: () => NOW }).read(profile)).toMatchObject({ status: 'UNAUTHENTICATED' });
    expect(expired.calls).toHaveLength(0);

    writeGemini({ access_token: TOKEN });
    const noProject = fakeFetch({ [GEMINI_LOAD_URL]: { status: 200, body: { currentTier: { id: 'free-tier' } } } });
    expect(await new GeminiQuotaReader({ fetch: noProject.fetch, now: () => NOW }).read(profile)).toMatchObject({ status: 'UNAVAILABLE' });
    expect(noProject.calls).toHaveLength(1);
  });

  it('rejects a link in place of the sign-in file', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'af-unofficial-outside-'));
    try {
      fs.mkdirSync(path.join(outside, 'target'));
      try { fs.symlinkSync(path.join(outside, 'target'), path.join(profile, '.gemini'), 'junction'); } catch { return; }
      const { fetch, calls } = fakeFetch({});
      expect(await new GeminiQuotaReader({ fetch, now: () => NOW }).read(profile)).toMatchObject({ status: 'UNAVAILABLE' });
      expect(calls).toHaveLength(0);
    } finally {
      fs.rmSync(path.join(profile, '.gemini'), { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('unofficial readings in quota observations (#250)', () => {
  let db: Database.Database;
  let repo: Repository;
  const baseProfilesDir = path.join(os.tmpdir(), 'af-unofficial-observation-profiles');
  let claudeResult: UnofficialQuotaResult;
  const reads: string[] = [];
  const claudeReader: UnofficialQuotaReader = { read: async (directory) => { reads.push(directory); return claudeResult; } };

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    reads.length = 0;
    claudeResult = { status: 'OK', primary: { usedPercent: 30, resetsAt: '2026-10-25T10:00:00.000Z', windowMinutes: 300 },
      secondary: { usedPercent: 100, resetsAt: '2026-10-30T00:00:00.000Z', windowMinutes: 10080 }, planType: 'pro' };
  });
  afterEach(() => db.close());

  const service = () => new AccountQuotaService(repo, {
    claudeReader, profileResolver: new NativeProfileResolver({ baseProfilesDir }),
    now: () => '2026-10-25T08:00:00.000Z', initializeVerifiedAccounts: true,
  });
  const claudeAccount = () => {
    const created = new WorkspaceManagementService(repo, () => '2026-10-25T08:00:00.000Z').createAgent({
      displayName: 'Claude coder', role: 'CODER', connection: 'CLAUDE_CODE_CLI', modelName: 'claude-sonnet-4-5', workerSlots: 1, profileId: 'claude-one',
    });
    if (!created.success) throw new Error('agent not created');
    const resource = repo.getProviderResource(created.agent.provider_resource_id!)!;
    return { accountId: resource.provider_account_id!, resourceId: resource.id };
  };

  it('shows an unofficial reading for display only: no health change, no stored quota', async () => {
    const { accountId, resourceId } = claudeAccount();
    const observation = await service().refreshAccount(accountId);

    expect(reads).toEqual([path.join(baseProfilesDir, 'claude', 'claude-one')]);
    expect(observation).toMatchObject({ status: 'OK', source: 'UNOFFICIAL', remainingPercent: 70, windowMinutes: 300, planType: 'pro',
      secondary: { remainingPercent: 0, windowMinutes: 10080 }, healthStatus: 'UNKNOWN' });
    expect(repo.getProviderAccount(accountId)!.health_status).toBe('UNKNOWN');
    expect(repo.getProviderResource(resourceId)!.quota_source).not.toBe('PROVIDER_REPORTED');
  });

  it('keeps a recorded limit and a lost sign-in ahead of an unofficial reading', async () => {
    const { accountId } = claudeAccount();
    db.prepare("UPDATE provider_accounts SET health_status = 'QUOTA_EXHAUSTED', cooldown_until = ? WHERE id = ?").run('2026-10-25T12:00:00.000Z', accountId);
    expect(await service().refreshAccount(accountId)).toMatchObject({ source: 'OBSERVED', remainingPercent: 0 });
    db.prepare("UPDATE provider_accounts SET health_status = 'AUTH_ERROR', cooldown_until = NULL WHERE id = ?").run(accountId);
    expect(await service().refreshAccount(accountId)).toMatchObject({ status: 'UNAUTHENTICATED', source: 'UNKNOWN' });
    expect(reads).toEqual([]);
  });

  it('falls back to what runs recorded when the unofficial read fails', async () => {
    const { accountId } = claudeAccount();
    claudeResult = { status: 'UNAVAILABLE', message: 'Usage telemetry is unavailable.' };
    expect(await service().refreshAccount(accountId)).toMatchObject({ status: 'UNSUPPORTED', source: 'UNKNOWN' });
    claudeResult = { status: 'UNAUTHENTICATED', message: 'The provider rejected the saved sign-in; sign in again.' };
    expect(await service().refreshAccount(accountId)).toMatchObject({ status: 'UNAUTHENTICATED', source: 'UNKNOWN' });
    expect(repo.getProviderAccount(accountId)!.health_status).toBe('UNKNOWN');
  });

  it('reads nothing while the owner has switched unofficial readers off, and remembers the choice', async () => {
    const { accountId } = claudeAccount();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'af-quota-preferences-'));
    try {
      const preferencesFile = path.join(directory, 'quota-preferences.json');
      const first = new AccountQuotaService(repo, { claudeReader, profileResolver: new NativeProfileResolver({ baseProfilesDir }), preferencesFile });
      expect(first.getUnofficialReadersEnabled()).toBe(true); // The owner opted in (#250).
      expect(await first.refreshAccount(accountId)).toMatchObject({ source: 'UNOFFICIAL' });

      first.setUnofficialReadersEnabled(false);
      expect(first.getLatestObservations()).toEqual([]); // Unofficial readings are dropped at once.
      reads.length = 0;
      expect(await first.refreshAccount(accountId)).toMatchObject({ status: 'UNSUPPORTED', source: 'UNKNOWN' });
      expect(reads).toEqual([]);

      const restarted = new AccountQuotaService(repo, { claudeReader, profileResolver: new NativeProfileResolver({ baseProfilesDir }), preferencesFile });
      expect(restarted.getUnofficialReadersEnabled()).toBe(false);
      fs.writeFileSync(preferencesFile, 'not json', 'utf8');
      expect(new AccountQuotaService(repo, { claudeReader, preferencesFile }).getUnofficialReadersEnabled()).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('marks an account with an exhausted unofficial window as not usable on the dashboard', () => {
    const base: QuotaObservation = { accountId: 'claude-1', providerId: 'prov-claude-code-cli', resourceIds: [], status: 'OK', source: 'UNOFFICIAL',
      usedPercent: 30, remainingPercent: 70, resetsAt: null, windowMinutes: 300, secondary: null, planType: 'pro',
      observedAt: '2026-10-25T08:00:00.000Z', message: null, healthStatus: 'AVAILABLE' };
    const groups = buildQuotaGroups([base, { ...base, accountId: 'claude-2', secondary: { usedPercent: 100, remainingPercent: 0, resetsAt: null, windowMinutes: 10080 } }], [], [], NOW);
    expect(groups[0].cards.map((card) => [card.accountId, card.usable, card.source])).toEqual([['claude-1', true, 'UNOFFICIAL'], ['claude-2', false, 'UNOFFICIAL']]);
  });

  it('shows one bar per Gemini model and blocks use only when every model is out', () => {
    const bucket = (label: string, remaining: number) => ({ label, usedPercent: 100 - remaining, remainingPercent: remaining, resetsAt: null, windowMinutes: null });
    const base: QuotaObservation = { accountId: 'gemini-1', providerId: 'prov-gemini-cli', resourceIds: [], status: 'OK', source: 'UNOFFICIAL',
      usedPercent: 100, remainingPercent: 0, resetsAt: null, windowMinutes: null, secondary: null, planType: 'free-tier',
      observedAt: '2026-10-25T08:00:00.000Z', message: null, healthStatus: 'AVAILABLE', buckets: [bucket('gemini-2.5-pro', 0), bucket('gemini-2.5-flash', 60)] };
    const [group] = buildQuotaGroups([base, { ...base, accountId: 'gemini-2', buckets: [bucket('gemini-2.5-pro', 0)] }], [], [], NOW);
    expect(group.cards[0].windows.map((window) => [window.label, window.remainingPercent, window.tone])).toEqual([['gemini-2.5-pro', 0, 'LOW'], ['gemini-2.5-flash', 60, 'GOOD']]);
    expect(group.cards.map((card) => card.usable)).toEqual([true, false]);
  });
});
