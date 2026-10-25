import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import type { AgentConnectionKind } from '../types/workspace';
import { NodeCodexQuotaSpawner, type CodexQuotaProcess, type CodexQuotaSpawner } from './CodexQuotaClient';
import { buildTrustedEnvironment, resolveTrustedExecutable } from './ExecutableResolver';

/** One choice in the Agent Center model picker (#263). */
export interface CatalogModel {
  id: string;
  label: string;
  /** Text reported by the CLI itself (live Codex list). */
  description: string | null;
  /** i18n key for built-in entries, under `agentCenter.models.descriptions`. */
  descriptionKey: string | null;
  isDefault: boolean;
  /** ALIAS: a CLI name that always resolves to the latest model of its family. */
  kind: 'ALIAS' | 'MODEL';
}

export interface ModelCatalog {
  connection: AgentConnectionKind;
  /** LIVE: read from the CLI just now; BUILT_IN: the list shipped with Agent Forge. */
  source: 'LIVE' | 'BUILT_IN';
  models: CatalogModel[];
}

export interface ModelCatalogServiceOptions {
  spawner?: CodexQuotaSpawner;
  resolveCodexExecutable?: () => string | null;
  /** Whole live read deadline; at most 15 seconds. */
  timeoutMs?: number;
  cacheMs?: number;
  now?: () => number;
  temporaryRoot?: string;
}

const alias = (id: string, isDefault = false): CatalogModel =>
  ({ id, label: id, description: null, descriptionKey: id, isDefault, kind: 'ALIAS' });
const model = (id: string, descriptionKey: string | null = null, isDefault = false): CatalogModel =>
  ({ id, label: id, description: null, descriptionKey, isDefault, kind: 'MODEL' });

/**
 * Shipped lists, used directly for Claude Code and Gemini (whose aliases track
 * the latest models) and as the fallback when the live Codex read fails.
 */
export const BUILT_IN_MODELS: Record<Exclude<AgentConnectionKind, 'MANUAL_BRIDGE'>, CatalogModel[]> = {
  CODEX_CLI: [
    model('gpt-6.1-sol', 'codexWorkhorse', true),
    model('gpt-6-astra', 'codexFrontier'),
    model('gpt-6-sol', 'codexPrevious'),
    model('gpt-6-luna', 'codexFast'),
  ],
  CLAUDE_CODE_CLI: [
    alias('sonnet', true), alias('opus'), alias('haiku'),
    model('claude-opus-5-5'), model('claude-sonnet-5-5'), model('claude-haiku-5-5'), model('claude-fable-5-1'),
  ],
  GEMINI_CLI: [
    alias('auto', true), alias('pro'), alias('flash'), alias('flash-lite'),
    model('gemini-3.1-pro-preview'), model('gemini-3-flash-preview'), model('gemini-2.5-pro'), model('gemini-2.5-flash'), model('gemini-2.5-flash-lite'),
  ],
};

const MODEL_ID = /^[A-Za-z0-9._:\[\]-]{1,120}$/;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_PAGES = 5;
const liveModelSchema = z.object({
  id: z.string(),
  displayName: z.string().nullish(),
  description: z.string().nullish(),
  hidden: z.boolean().nullish(),
  isDefault: z.boolean().nullish(),
});
const pageSchema = z.object({ data: z.array(z.unknown()).max(200), nextCursor: z.string().max(512).nullish() });

const clip = (value: string | null | undefined, max: number): string | null => {
  if (!value) return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text ? text.slice(0, max) : null;
};

/**
 * Model choices per CLI connection. The Codex list comes from the CLI's own
 * `model/list` in a disposable CODEX_HOME: no sign-in, token or profile is
 * read, and the directory is removed afterwards.
 */
export class ModelCatalogService {
  private readonly spawner: CodexQuotaSpawner;
  private readonly resolveCodexExecutable: () => string | null;
  private readonly timeoutMs: number;
  private readonly cacheMs: number;
  private readonly now: () => number;
  private readonly temporaryRoot: string;
  private cached: { at: number; catalog: ModelCatalog } | null = null;
  private inFlight: Promise<ModelCatalog> | null = null;

  constructor(options: ModelCatalogServiceOptions = {}) {
    this.spawner = options.spawner ?? new NodeCodexQuotaSpawner();
    this.resolveCodexExecutable = options.resolveCodexExecutable ?? (() => resolveTrustedExecutable('codex', 'codex'));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.cacheMs = options.cacheMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
    this.temporaryRoot = options.temporaryRoot ?? os.tmpdir();
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 15_000) {
      throw new RangeError('Model list timeout must be between 1 and 15000 milliseconds.');
    }
  }

  public async list(connection: AgentConnectionKind): Promise<ModelCatalog> {
    if (connection === 'MANUAL_BRIDGE') return { connection, source: 'BUILT_IN', models: [] };
    if (connection !== 'CODEX_CLI') return { connection, source: 'BUILT_IN', models: BUILT_IN_MODELS[connection].map((entry) => ({ ...entry })) };
    if (this.cached && this.now() - this.cached.at < this.cacheMs) return this.copy(this.cached.catalog);
    if (!this.inFlight) {
      this.inFlight = this.readCodex().finally(() => { this.inFlight = null; });
    }
    return this.copy(await this.inFlight);
  }

  private copy(catalog: ModelCatalog): ModelCatalog {
    return { ...catalog, models: catalog.models.map((entry) => ({ ...entry })) };
  }

  private async readCodex(): Promise<ModelCatalog> {
    const fallback: ModelCatalog = { connection: 'CODEX_CLI', source: 'BUILT_IN', models: BUILT_IN_MODELS.CODEX_CLI.map((entry) => ({ ...entry })) };
    const live = await this.readCodexLive().catch(() => null);
    if (!live || live.length === 0) return fallback; // A failure is not cached: the next open tries again.
    const catalog: ModelCatalog = { connection: 'CODEX_CLI', source: 'LIVE', models: live };
    this.cached = { at: this.now(), catalog };
    return catalog;
  }

  private async readCodexLive(): Promise<CatalogModel[] | null> {
    const executable = this.resolveCodexExecutable();
    // Windows command shims would need a shell; only a direct executable is launched.
    if (!executable || (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable))) return null;
    const home = fs.mkdtempSync(path.join(this.temporaryRoot, 'agent-forge-models-'));
    let child: CodexQuotaProcess;
    try {
      child = this.spawner.spawn(executable, ['app-server'], {
        env: buildTrustedEnvironment({ allowedEnvKeys: ['CODEX_HOME'], customEnv: { CODEX_HOME: home } }),
        cwd: home,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      this.removeLater(home, null);
      return null;
    }
    try {
      return await this.converse(child, home);
    } finally {
      this.removeLater(home, child);
    }
  }

  /** Removes the disposable home once the CLI has released its files. */
  private removeLater(home: string, child: CodexQuotaProcess | null): void {
    const remove = () => { try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp cleanup is best effort */ } };
    if (!child) { remove(); return; }
    let done = false;
    const once = () => { if (!done) { done = true; remove(); } };
    child.once('close', once);
    setTimeout(once, 5_000).unref?.();
  }

  private converse(child: CodexQuotaProcess, home: string): Promise<CatalogModel[] | null> {
    return new Promise((resolve) => {
      let settled = false;
      let buffer = '';
      let outputBytes = 0;
      let pendingId = 1;
      const collected: CatalogModel[] = [];
      const finish = (result: CatalogModel[] | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        child.stdout.removeListener('data', onData);
        try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
        child.stdin.destroy();
        child.stdout.destroy();
        resolve(result);
      };
      const send = (message: object) => {
        if (settled) return;
        try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { finish(null); }
      };
      const request = (cursor: string | null) => {
        pendingId += 1;
        send({ id: pendingId, method: 'model/list', params: cursor ? { cursor } : {} });
      };
      const onLine = (line: string) => {
        let value: unknown;
        try { value = JSON.parse(line); } catch { finish(null); return; }
        if (!value || typeof value !== 'object' || Array.isArray(value)) { finish(null); return; }
        const message = value as Record<string, unknown>;
        if (message.id !== pendingId) return; // Notifications and unrelated replies are ignored.
        if ('error' in message) { finish(null); return; }
        if (pendingId === 1) {
          const result = message.result as { codexHome?: unknown } | undefined;
          const normalize = (directory: string) => (process.platform === 'win32' ? path.resolve(directory).toLowerCase() : path.resolve(directory));
          if (typeof result?.codexHome !== 'string' || normalize(result.codexHome) !== normalize(home)) { finish(null); return; }
          send({ method: 'initialized' });
          request(null);
          return;
        }
        const page = pageSchema.safeParse(message.result);
        if (!page.success) { finish(null); return; }
        for (const item of page.data.data) {
          const parsed = liveModelSchema.safeParse(item);
          if (!parsed.success || parsed.data.hidden || !MODEL_ID.test(parsed.data.id)) continue;
          if (collected.some((entry) => entry.id === parsed.data.id)) continue;
          collected.push({
            id: parsed.data.id,
            label: clip(parsed.data.displayName, 80) ?? parsed.data.id,
            description: clip(parsed.data.description, 240),
            descriptionKey: null,
            isDefault: parsed.data.isDefault === true,
            kind: 'MODEL',
          });
        }
        if (page.data.nextCursor && pendingId <= MAX_PAGES) { request(page.data.nextCursor); return; }
        finish(collected);
      };
      const onData = (chunk: string | Buffer) => {
        if (settled) return;
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_OUTPUT_BYTES) { finish(null); return; }
        buffer += chunk.toString();
        let newline: number;
        while (!settled && (newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) onLine(line);
        }
      };
      const deadline = setTimeout(() => finish(null), this.timeoutMs);
      deadline.unref?.();
      child.on('error', () => finish(null));
      child.once('close', () => finish(null));
      child.stdin.on('error', () => finish(null));
      child.stdout.on('error', () => finish(null));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', onData);
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent_forge_models', version: '1.0.0' } } });
    });
  }
}
