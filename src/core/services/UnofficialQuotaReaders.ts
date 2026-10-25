import fs from 'fs';
import path from 'path';
import { z } from 'zod';

/**
 * Unofficial usage readers for Claude Code and Gemini CLI (#250).
 *
 * Neither CLI has an official usage API, so these read the account's own
 * sign-in token from its isolated native profile and ask the same private
 * endpoints the CLI (and quota routers) use. The owner opted in on 2026-10-25.
 *
 * Boundaries: the token is read only, never refreshed, written, logged,
 * persisted or returned; requests go only to fixed provider hosts with
 * redirects refused; every failure message is static. A reading is display
 * telemetry: it never proves health and never feeds scheduling.
 */

export interface UnofficialQuotaWindow {
  usedPercent: number;
  /** ISO timestamp. */
  resetsAt: string | null;
  windowMinutes: number | null;
}

export type UnofficialQuotaResult = {
  status: 'OK';
  primary: UnofficialQuotaWindow;
  secondary: UnofficialQuotaWindow | null;
  /** Per-model buckets, tightest first. */
  buckets?: Array<UnofficialQuotaWindow & { label: string }>;
  planType: string | null;
} | {
  status: 'UNAUTHENTICATED' | 'UNAVAILABLE' | 'MALFORMED' | 'TIMEOUT';
  /** Static, sanitized explanation; never a token, response body or error text. */
  message: string;
};

export interface UnofficialQuotaReader {
  read(profileDirectory: string): Promise<UnofficialQuotaResult>;
}

export interface QuotaHttpResponse {
  status: number;
  text(): Promise<string>;
}

export type QuotaHttpFetch = (url: string, init: {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  redirect: 'error';
  signal: AbortSignal;
}) => Promise<QuotaHttpResponse>;

export interface UnofficialQuotaReaderOptions {
  fetch?: QuotaHttpFetch;
  now?: () => number;
  /** Whole read deadline; at most 15 seconds. */
  timeoutMs?: number;
}

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const GEMINI_LOAD_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
export const GEMINI_QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';

const MAX_CREDENTIAL_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const PLAN_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;

class ReadFailure extends Error {
  constructor(readonly result: Exclude<UnofficialQuotaResult, { status: 'OK' }>) { super(result.message); }
}

const fail = (status: Exclude<UnofficialQuotaResult, { status: 'OK' }>['status'], message: string): never => {
  throw new ReadFailure({ status, message });
};

const defaultFetch: QuotaHttpFetch = (url, init) => fetch(url, init);

function plan(value: unknown): string | null {
  return typeof value === 'string' && PLAN_PATTERN.test(value) ? value : null;
}

/** Reads a small regular credential file inside the profile; links are refused. */
function readCredentialFile(profileDirectory: string, relative: string[], missingMessage: string): unknown {
  if (!path.isAbsolute(profileDirectory) || /[\u0000-\u001f\u007f]/.test(profileDirectory)) {
    fail('UNAVAILABLE', 'A valid isolated profile directory is required.');
  }
  let current = profileDirectory;
  for (const part of relative) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    // Missing is not proof of a lost sign-in (e.g. an API-key account); it is just unreadable.
    if (!stat) fail('UNAVAILABLE', missingMessage);
    if (stat!.isSymbolicLink()) fail('UNAVAILABLE', 'The sign-in file must not be a link.');
  }
  const stat = fs.statSync(current);
  if (!stat.isFile() || stat.size > MAX_CREDENTIAL_BYTES) fail('UNAVAILABLE', 'The sign-in file is not a small regular file.');
  try {
    return JSON.parse(fs.readFileSync(current, 'utf8'));
  } catch {
    return fail('MALFORMED', 'The sign-in file could not be read.');
  }
}

abstract class HttpQuotaReader implements UnofficialQuotaReader {
  protected readonly fetch: QuotaHttpFetch;
  protected readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: UnofficialQuotaReaderOptions = {}) {
    this.fetch = options.fetch ?? defaultFetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 15_000) {
      throw new RangeError('Quota read timeout must be between 1 and 15000 milliseconds.');
    }
  }

  public async read(profileDirectory: string): Promise<UnofficialQuotaResult> {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), this.timeoutMs);
    deadline.unref?.();
    try {
      return await this.readWith(profileDirectory, controller.signal);
    } catch (error) {
      if (error instanceof ReadFailure) return error.result;
      if (controller.signal.aborted) return { status: 'TIMEOUT', message: 'The usage read timed out.' };
      return { status: 'UNAVAILABLE', message: 'Usage telemetry is unavailable.' };
    } finally {
      clearTimeout(deadline);
    }
  }

  protected abstract readWith(profileDirectory: string, signal: AbortSignal): Promise<UnofficialQuotaResult>;

  /** One request to a fixed URL; the bearer token never appears in a result. */
  protected async requestJson(url: string, token: string, signal: AbortSignal, init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown }): Promise<unknown> {
    const response = await this.fetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      redirect: 'error',
      signal,
    });
    if (response.status === 401 || response.status === 403) fail('UNAUTHENTICATED', 'The provider rejected the saved sign-in; sign in again.');
    if (response.status < 200 || response.status >= 300) fail('UNAVAILABLE', 'The provider did not return usage.');
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) fail('MALFORMED', 'The provider returned malformed usage.');
    try {
      return JSON.parse(text);
    } catch {
      return fail('MALFORMED', 'The provider returned malformed usage.');
    }
  }
}

const claudeCredentialsSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1).max(8192),
    expiresAt: z.number().nullish(),
    subscriptionType: z.unknown().optional(),
  }),
});
const claudeWindowSchema = z.object({
  utilization: z.number().min(0).max(100),
  resets_at: z.string().max(64).nullish(),
}).nullish();
const claudeUsageSchema = z.object({ five_hour: claudeWindowSchema, seven_day: claudeWindowSchema });

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Claude Code: `<CLAUDE_CONFIG_DIR>/.credentials.json` → the OAuth usage endpoint (5-hour and 7-day windows). */
export class ClaudeUsageReader extends HttpQuotaReader {
  protected async readWith(profileDirectory: string, signal: AbortSignal): Promise<UnofficialQuotaResult> {
    const raw = readCredentialFile(profileDirectory, ['.credentials.json'], 'Claude Code is not signed in for this account.');
    const credentials = claudeCredentialsSchema.safeParse(raw);
    if (!credentials.success) fail('UNAUTHENTICATED', 'Claude Code has no subscription sign-in for this account.');
    const oauth = credentials.data!.claudeAiOauth;
    // Refreshing would rotate the CLI's own token; an expired one waits for the CLI.
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= this.now()) {
      fail('UNAUTHENTICATED', 'The saved Claude sign-in has expired; run Claude Code with this account once to renew it.');
    }
    const body = await this.requestJson(CLAUDE_USAGE_URL, oauth.accessToken, signal, {
      method: 'GET', headers: { 'anthropic-beta': 'oauth-2025-04-20' },
    });
    const usage = claudeUsageSchema.safeParse(body);
    if (!usage.success) fail('MALFORMED', 'Claude returned malformed usage.');
    const toWindow = (window: z.infer<typeof claudeWindowSchema>, windowMinutes: number): UnofficialQuotaWindow | null => window
      ? { usedPercent: Math.round(window.utilization), resetsAt: isoOrNull(window.resets_at), windowMinutes }
      : null;
    const fiveHour = toWindow(usage.data!.five_hour, 300);
    const week = toWindow(usage.data!.seven_day, 10080);
    const primary = fiveHour ?? week;
    if (!primary) fail('UNAVAILABLE', 'Claude did not report a usage window.');
    return { status: 'OK', primary: primary!, secondary: fiveHour ? week : null, planType: plan(oauth.subscriptionType) };
  }
}

const geminiCredentialsSchema = z.object({
  access_token: z.string().min(1).max(8192),
  expiry_date: z.number().nullish(),
});
const geminiLoadSchema = z.object({
  cloudaicompanionProject: z.string().min(1).max(200).nullish(),
  currentTier: z.object({ id: z.unknown().optional() }).nullish(),
});
const geminiQuotaSchema = z.object({
  buckets: z.array(z.object({
    remainingFraction: z.number().min(0).max(1).nullish(),
    resetTime: z.string().max(64).nullish(),
    modelId: z.unknown().optional(),
  })).max(256).nullish(),
});
const MODEL_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_BUCKETS = 8;

/** Gemini CLI: `<GEMINI_CLI_HOME>/.gemini/oauth_creds.json` → Code Assist quota buckets (the lowest one is shown). */
export class GeminiQuotaReader extends HttpQuotaReader {
  protected async readWith(profileDirectory: string, signal: AbortSignal): Promise<UnofficialQuotaResult> {
    const raw = readCredentialFile(profileDirectory, ['.gemini', 'oauth_creds.json'], 'Gemini CLI is not signed in with Google for this account.');
    const credentials = geminiCredentialsSchema.safeParse(raw);
    if (!credentials.success) fail('UNAUTHENTICATED', 'Gemini CLI has no Google sign-in for this account.');
    const { access_token: token, expiry_date: expiry } = credentials.data!;
    if (typeof expiry === 'number' && expiry <= this.now()) {
      fail('UNAUTHENTICATED', 'The saved Gemini sign-in has expired; run Gemini CLI with this account once to renew it.');
    }
    const load = geminiLoadSchema.safeParse(await this.requestJson(GEMINI_LOAD_URL, token, signal, {
      method: 'POST', body: { metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } },
    }));
    if (!load.success) fail('MALFORMED', 'Gemini returned malformed account data.');
    const project = load.data!.cloudaicompanionProject;
    if (!project) fail('UNAVAILABLE', 'This Google account has no Gemini Code Assist project yet.');
    const quota = geminiQuotaSchema.safeParse(await this.requestJson(GEMINI_QUOTA_URL, token, signal, { method: 'POST', body: { project } }));
    if (!quota.success) fail('MALFORMED', 'Gemini returned malformed quota.');
    // One bucket per model (the tightest when a model has several), tightest first.
    const byModel = new Map<string, UnofficialQuotaWindow & { label: string }>();
    for (const bucket of quota.data!.buckets ?? []) {
      if (typeof bucket.remainingFraction !== 'number') continue;
      const label = typeof bucket.modelId === 'string' && MODEL_PATTERN.test(bucket.modelId) ? bucket.modelId : 'model';
      const window = { label, usedPercent: Math.round((1 - bucket.remainingFraction) * 100), resetsAt: isoOrNull(bucket.resetTime), windowMinutes: null };
      const existing = byModel.get(label);
      if (!existing || window.usedPercent > existing.usedPercent) byModel.set(label, window);
    }
    const buckets = [...byModel.values()].sort((a, b) => b.usedPercent - a.usedPercent || a.label.localeCompare(b.label)).slice(0, MAX_BUCKETS);
    if (buckets.length === 0) fail('UNAVAILABLE', 'Gemini did not report a quota bucket.');
    const { label: _label, ...primary } = buckets[0];
    return { status: 'OK', primary, secondary: null, buckets, planType: plan(load.data!.currentTier?.id) };
  }
}
