import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../src/core/database/migrations';
import { AutonomyStore } from '../src/core/autonomy/store';
import { CodexManagerAdapter } from '../src/core/autonomy/providers';
import { createWorkOrder } from '../src/core/autonomy/contracts';
import { ManagerProviderPool, directOpenAiFallbackConfig } from '../src/core/autonomy/managerPool';
import { PROVIDER_RESPONSE_MAX_BYTES } from '../src/core/autonomy/providerEndpoint';

const sha = 'a'.repeat(40);
const secret = 'fallback-secret-must-not-leak';

function order() {
  return createWorkOrder({
    taskId: 'fallback-task',
    workerId: 'agy-01',
    objective: 'review fallback transport',
    baseSha: sha,
    branch: 'agent/fallback',
    worktree: 'D:/Projects/AI/Agent-Forge-Worktrees/fallback',
    acceptanceCriteria: ['fallback review passes'],
    allowedPaths: ['src'],
    requiredTests: ['npm test'],
  });
}

function review() {
  return {
    protocol_version: 'managerreview.v1' as const,
    verdict: 'PASS' as const,
    reviewed_head_sha: sha,
    findings: [],
    required_actions: [],
    risk: 'LOW' as const,
    notes: 'fallback review',
  };
}

function responsePayload(text: string): string {
  return JSON.stringify({ id: 'fallback-response', output: [{ content: [{ type: 'output_text', text }] }] });
}

function setupPool() {
  const db = new Database(':memory:');
  MigrationRunner.run(db);
  const store = new AutonomyStore(db);
  const pool = ManagerProviderPool.fromEnvironment(store, new CodexManagerAdapter({ executable: 'fake-codex' }));
  const fallback = pool.getResource('codex-api-fallback');
  if (!fallback?.review || !fallback.plan) throw new Error('direct fallback resource was not registered');
  return { db, fallback };
}

describe('direct OpenAI fallback transport', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('uses the shared non-persistent transport for review and plan requests', async () => {
    vi.stubEnv('AGENT_FORGE_ENABLE_OPENAI_API_FALLBACK', '1');
    vi.stubEnv('OPENAI_API_KEY', secret);
    vi.stubEnv('OPENAI_API_BASE_URL', 'https://api.openai.com/v1/responses');

    const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(url), init: init ?? {}, body });
      const text = typeof body.input === 'string' && body.input.includes('workorder.v1')
        ? JSON.stringify(order())
        : JSON.stringify(review());
      return new Response(responsePayload(text), { status: 200 });
    });

    const { db, fallback } = setupPool();
    const evidence = { workOrder: order(), evidence: JSON.stringify({ current_head: sha }) };
    const reviewResult = await fallback.review(evidence);
    const planResult = await fallback.plan!(order());

    expect(reviewResult.review?.verdict).toBe('PASS');
    expect(planResult.workOrder?.task_id).toBe('fallback-task');
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe('https://api.openai.com/v1/responses');
      expect(request.body.store).toBe(false);
      expect(request.init.redirect).toBe('error');
      expect(request.init.credentials).toBe('omit');
      expect((request.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${secret}`);
      expect(JSON.stringify(request.body)).not.toContain(secret);
    }
    expect(reviewResult.run.stdout).not.toContain(secret);
    expect(reviewResult.run.stderr).not.toContain(secret);
    db.close();
  });

  it('rejects unsafe fallback URLs before making a network call', async () => {
    vi.stubEnv('AGENT_FORGE_ENABLE_OPENAI_API_FALLBACK', '1');
    vi.stubEnv('OPENAI_API_KEY', secret);
    vi.stubEnv('OPENAI_API_BASE_URL', 'https://api.openai.com/v1/responses?store=true');
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return new Response(responsePayload(JSON.stringify(review())), { status: 200 });
    });

    const { db, fallback } = setupPool();
    const result = await fallback.review({ workOrder: order(), evidence: '{}' });

    expect(result.run.status).toBe('CONTRACT_INVALID');
    expect(calls).toBe(0);
    db.close();
  });

  it('shares redirect and response-size fail-closed behavior with routed endpoints', async () => {
    vi.stubEnv('AGENT_FORGE_ENABLE_OPENAI_API_FALLBACK', '1');
    vi.stubEnv('OPENAI_API_KEY', secret);

    vi.stubGlobal('fetch', async () => new Response('', { status: 302, headers: { location: 'https://evil.example' } }));
    const redirectSetup = setupPool();
    const redirectResult = await redirectSetup.fallback.review({ workOrder: order(), evidence: '{}' });
    expect(redirectResult.run.status).toBe('CONTRACT_INVALID');
    redirectSetup.db.close();

    vi.stubGlobal('fetch', async () => new Response('{}', {
      status: 200,
      headers: { 'content-length': String(PROVIDER_RESPONSE_MAX_BYTES + 1) },
    }));
    const oversizedSetup = setupPool();
    const oversizedResult = await oversizedSetup.fallback.review({ workOrder: order(), evidence: '{}' });
    expect(oversizedResult.run.status).toBe('CONTRACT_INVALID');
    oversizedSetup.db.close();
  });

  it('builds a direct manager config with HTTPS and an external API-key reference', () => {
    const config = directOpenAiFallbackConfig({
      OPENAI_API_BASE_URL: 'https://api.openai.com/v1/responses',
      CODEX_MANAGER_API_MODEL: 'gpt-test',
    });
    expect(config.adapter_type).toBe('DIRECT_PROVIDER');
    expect(config.allow_insecure_http).toBe(false);
    expect(config.auth_source).toBe('env://OPENAI_API_KEY');
    expect(config.model_or_route).toBe('gpt-test');
  });
});
