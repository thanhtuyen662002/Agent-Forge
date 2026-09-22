import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { AutonomyStore } from '../src/core/autonomy/store';
import { createWorkOrder, ManagerReview } from '../src/core/autonomy/contracts';
import { buildManagerContextPackage, ManagerProviderPool } from '../src/core/autonomy/managerPool';
import { managerResourceFromEndpoint, ProviderEndpointConfig } from '../src/core/autonomy/providerEndpoint';
import { ResponsesManagerEndpointTransport } from '../src/core/autonomy/responsesEndpoint';
import { CodexManagerAdapter } from '../src/core/autonomy/providers';

const sha = 'a'.repeat(40);
const secret = 'never-persist-this-router-secret';

function endpoint(role: 'MANAGER' | 'REVIEWER' = 'MANAGER', timeoutMs = 1_000): ProviderEndpointConfig {
  return {
    resource_id: `${role.toLowerCase()}-omniroute`,
    role,
    adapter_type: 'EXTERNAL_ROUTER',
    base_url: 'https://router.example.test/v1',
    allow_insecure_http: false,
    model_or_route: role === 'MANAGER' ? 'manager-configured-model' : 'reviewer-configured-model',
    auth_source: 'env://TEST_ROUTER_AUTH',
    auth_header_name: 'X-Company-Auth',
    priority: role === 'REVIEWER' ? 300 : 290,
    timeout_ms: timeoutMs,
    enabled: true,
    health_state: 'AVAILABLE',
    cooldown_state: { active: false, until: null, reason: null },
    capabilities: role === 'MANAGER' ? ['PLANNING', 'REVIEW'] : ['REVIEW'],
  };
}

function order() {
  return createWorkOrder({
    taskId: 'router-task',
    workerId: 'agy-01',
    objective: 'router review',
    baseSha: sha,
    branch: 'agent/router',
    worktree: 'D:/Projects/AI/Agent-Forge-Worktrees/router',
    acceptanceCriteria: ['review passes'],
    allowedPaths: ['src'],
    requiredTests: ['npm test'],
  });
}

function responsePayload(text: string) {
  return JSON.stringify({ id: 'response-fake', output: [{ content: [{ type: 'output_text', text }] }] });
}

function review(head = sha): ManagerReview {
  return {
    protocol_version: 'managerreview.v1',
    verdict: 'PASS',
    reviewed_head_sha: head,
    findings: [],
    required_actions: [],
    risk: 'LOW',
    notes: 'routed review',
  };
}

describe('Responses-compatible routed manager transport', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('registers configured manager/reviewer routes as unbound product resources ahead of CLI fallback', () => {
    vi.stubEnv('AGENT_FORGE_OMNIROUTE_ENABLED', '1');
    vi.stubEnv('AGENT_FORGE_OMNIROUTE_BASE_URL', 'https://router.example.test/v1');
    vi.stubEnv('AGENT_FORGE_MANAGER_MODEL', 'manager-configured-model');
    vi.stubEnv('AGENT_FORGE_REVIEWER_MODEL', 'reviewer-configured-model');
    vi.stubEnv('AGENT_FORGE_OMNIROUTE_AUTH_ENV', 'TEST_ROUTER_AUTH');
    const db = new Database(':memory:');
    MigrationRunner.run(db);
    const store = new AutonomyStore(db);
    const pool = ManagerProviderPool.fromEnvironment(store, new CodexManagerAdapter({ executable: 'fake-codex' }));
    expect(pool.getResources().map((resource) => resource.id).slice(0, 3)).toEqual([
      'reviewer-omniroute',
      'manager-omniroute',
      'codex-chatgpt-primary',
    ]);
    const repo = new Repository(db);
    expect(repo.getProviderResource('manager-omniroute')).toMatchObject({
      provider_account_id: null,
      model_name: 'manager-configured-model',
      capabilities: ['PLANNING', 'REVIEW'],
    });
    expect(repo.getProviderResource('reviewer-omniroute')).toMatchObject({
      provider_account_id: null,
      model_name: 'reviewer-configured-model',
      capabilities: ['REVIEW'],
    });
    db.close();
  });

  it('durably cools down an unbound route resource without retrying its hidden account pool', async () => {
    const db = new Database(':memory:');
    MigrationRunner.run(db);
    const store = new AutonomyStore(db);
    const repo = new Repository(db);
    const now = new Date().toISOString();
    repo.createProvider({ id: 'router-provider', name: 'Router', adapter_type: 'API', enabled: true, created_at: now });
    repo.createProviderResource({
      id: 'route-resource', provider_id: 'router-provider', provider_account_id: null,
      model_name: 'configured-route', health_status: 'AVAILABLE', capabilities: ['REVIEW'], enabled: true,
      total_quota: null, remaining_quota: null, quota_unit: 'ROUTE_REQUESTS', quota_reset_at: null,
      quota_source: 'UNKNOWN', quota_confidence: 0, last_health_check: null,
    });
    let calls = 0;
    const pool = new ManagerProviderPool(store, [{
      id: 'route-resource', priority: 100, enabled: true,
      review: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            run: { status: 'QUOTA_OR_RATE_LIMIT', exitCode: 1, executionId: 'rate', stdout: '', stderr: 'ROUTE_RATE_LIMITED HTTP 429', durationMs: 1 },
          };
        }
        return {
          run: { status: 'SUCCESSFUL_PROCESS_EXIT', exitCode: 0, executionId: 'recovered', stdout: '', stderr: '', durationMs: 1 },
          review: review(),
        };
      },
    }]);
    const context = buildManagerContextPackage({ workOrder: order(), currentHead: sha });
    await pool.review(context);
    await pool.review(context);
    expect(calls).toBe(1);
    expect(repo.getProviderResource('route-resource')?.health_status).toBe('RATE_LIMITED');

    db.prepare('UPDATE provider_resources SET last_health_check = ? WHERE id = ?')
      .run(new Date(Date.now() - 61_000).toISOString(), 'route-resource');
    expect((await pool.review(context)).review?.verdict).toBe('PASS');
    expect(calls).toBe(2);
    expect(repo.getProviderResource('route-resource')?.health_status).toBe('AVAILABLE');
    db.close();
  });

  it('selects configured models independently for manager and reviewer roles', async () => {
    const seen: string[] = [];
    const transport = new ResponsesManagerEndpointTransport({
      environment: { TEST_ROUTER_AUTH: secret },
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { model: string; store: boolean };
        seen.push(request.model);
        expect(request.store).toBe(false);
        const body = String(init?.body);
        return new Response(responsePayload(body.includes('workorder.v1') ? JSON.stringify(order()) : JSON.stringify(review())), { status: 200 });
      },
    });
    const manager = managerResourceFromEndpoint(endpoint('MANAGER'), transport);
    const reviewer = managerResourceFromEndpoint(endpoint('REVIEWER'), transport);
    expect(reviewer.plan).toBeUndefined();
    await manager.plan!(order());
    await reviewer.review({ workOrder: order(), evidence: JSON.stringify({ current_head: sha }) });
    expect(seen).toEqual(['manager-configured-model', 'reviewer-configured-model']);
  });

  it('validates structured manager planning and reviewer output', async () => {
    let calls = 0;
    const transport = new ResponsesManagerEndpointTransport({
      environment: { TEST_ROUTER_AUTH: secret },
      fetch: async () => new Response(responsePayload(JSON.stringify(++calls === 1 ? order() : review())), { status: 200 }),
    });
    const manager = managerResourceFromEndpoint(endpoint('MANAGER'), transport);
    expect((await manager.plan!(order())).workOrder?.task_id).toBe('router-task');
    expect((await manager.review({ workOrder: order(), evidence: '{}' })).review?.verdict).toBe('PASS');
  });

  it('classifies malformed, auth, server, and timeout responses without leaking secrets', async () => {
    const malformed = new ResponsesManagerEndpointTransport({
      environment: { TEST_ROUTER_AUTH: secret },
      fetch: async () => new Response('{not-json', { status: 200 }),
    });
    expect((await malformed.review(endpoint(), { workOrder: order(), evidence: '{}' })).run.status).toBe('CONTRACT_INVALID');

    const auth = new ResponsesManagerEndpointTransport({
      environment: { TEST_ROUTER_AUTH: secret },
      fetch: async () => new Response(`denied ${secret}`, { status: 401 }),
    });
    const authRun = (await auth.review(endpoint(), { workOrder: order(), evidence: '{}' })).run;
    expect(authRun.status).toBe('AUTH_ERROR');
    expect(authRun.stderr).not.toContain(secret);
    expect(authRun.stderr).toContain('[REDACTED_SECRET]');

    const server = new ResponsesManagerEndpointTransport({
      environment: { TEST_ROUTER_AUTH: secret },
      fetch: async () => new Response('unavailable', { status: 503 }),
    });
    expect((await server.review(endpoint(), { workOrder: order(), evidence: '{}' })).run.status).toBe('FAILED_PROCESS_EXIT');

    const timeout = new ResponsesManagerEndpointTransport({
      environment: { TEST_ROUTER_AUTH: secret },
      fetch: async (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    });
    expect((await timeout.review(endpoint('MANAGER', 5), { workOrder: order(), evidence: '{}' })).run.status).toBe('TIMEOUT');
  });

  it('classifies an explicit 429 quota failure as exhausted capacity rather than transient rate limiting', async () => {
    const transport = new ResponsesManagerEndpointTransport({
      environment: { TEST_ROUTER_AUTH: secret },
      fetch: async () => new Response(JSON.stringify({
        error: { code: 'insufficient_quota', message: 'API quota exhausted' },
      }), { status: 429 }),
    });
    const result = await transport.review(endpoint(), { workOrder: order(), evidence: '{}' });
    expect(result.run.status).toBe('QUOTA_OR_RATE_LIMIT');
    expect(result.run.stderr).toContain('ROUTE_CAPACITY_EXHAUSTED');
    expect(result.run.stderr).not.toContain('ROUTE_RATE_LIMITED');
  });

  it('fails over from a routed server failure while preserving context and exact-head fencing', async () => {
    const db = new Database(':memory:');
    MigrationRunner.run(db);
    const store = new AutonomyStore(db);
    const context = buildManagerContextPackage({
      workOrder: order(),
      currentHead: sha,
      actualDiff: 'diff --git a/src/a.ts b/src/a.ts',
      deterministicTests: [{ command: 'npm test', exitCode: 0 }],
      previousManagerDecisions: [{ verdict: 'REPAIR' }],
      repairHistory: [{ attempt: 1 }],
      prState: { number: 62 },
      ciState: { Windows: 'SUCCESS' },
    });
    const routeTransport = new ResponsesManagerEndpointTransport({
      environment: { TEST_ROUTER_AUTH: secret },
      fetch: async () => new Response('upstream error', { status: 503 }),
    });
    let receivedContext: unknown;
    const pool = new ManagerProviderPool(store, [
      managerResourceFromEndpoint(endpoint('REVIEWER'), routeTransport),
      {
        id: 'direct-fallback', priority: 10, enabled: true,
        review: async ({ evidence }) => {
          receivedContext = JSON.parse(evidence);
          return {
            run: { status: 'SUCCESSFUL_PROCESS_EXIT', exitCode: 0, executionId: 'fallback', stdout: '', stderr: '', durationMs: 1 },
            review: review('b'.repeat(40)),
          };
        },
      },
    ]);
    const result = await pool.review(context);
    expect(result.attempts).toEqual(['reviewer-omniroute', 'direct-fallback']);
    expect(receivedContext).toEqual(context);
    expect(result.review?.verdict).toBe('REPAIR');
    expect(result.review?.findings.some((finding) => finding.title === 'STALE_REVIEW_HEAD')).toBe(true);
    db.close();
  });
});
