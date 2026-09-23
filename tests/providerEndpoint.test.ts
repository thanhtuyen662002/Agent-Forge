import { describe, expect, it } from 'vitest';
import {
  ConfiguredCoderEndpointAdapter,
  ProviderEndpointConfig,
  isEndpointEligible,
  isRouteEndpoint,
  managerResourceFromEndpoint,
  parseProviderEndpointConfig,
} from '../src/core/autonomy/providerEndpoint';
import { ResponsesCoderEndpointTransport } from '../src/core/autonomy/responsesCoderEndpoint';

const managerEndpoint: ProviderEndpointConfig = {
  resource_id: 'manager-omniroute',
  role: 'MANAGER',
  adapter_type: 'EXTERNAL_ROUTER',
  base_url: 'https://router.example.test/manager',
  allow_insecure_http: false,
  model_or_route: 'manager-production',
  auth_source: 'env://AGENT_FORGE_OMNIROUTE_TOKEN',
  auth_header_name: 'Authorization',
  priority: 100,
  timeout_ms: 30_000,
  enabled: true,
  health_state: 'AVAILABLE',
  cooldown_state: { active: false, until: null, reason: null },
  capabilities: ['PLANNING', 'REVIEW'],
};

describe('configured provider endpoints', () => {
  it('models OmniRoute as one opaque manager resource in the existing pool contract', async () => {
    let seenResource = '';
    const resource = managerResourceFromEndpoint(managerEndpoint, {
      review: async (config) => {
        seenResource = config.resource_id;
        return {
          run: { status: 'FAILED_PROCESS_EXIT', exitCode: 1, executionId: 'fake', stdout: '', stderr: 'fake endpoint', durationMs: 1 },
        };
      },
    });
    await resource.review({ workOrder: {} as never, evidence: '{}' });
    expect(resource.id).toBe('manager-omniroute');
    expect(resource.endpoint?.adapter_type).toBe('EXTERNAL_ROUTER');
    expect(seenResource).toBe('manager-omniroute');
    expect(isRouteEndpoint(managerEndpoint)).toBe(true);
  });

  it('rejects inline credentials and insecure router endpoints', () => {
    expect(() => parseProviderEndpointConfig({ ...managerEndpoint, auth_source: 'sk-live-secret' })).toThrow();
    expect(() => parseProviderEndpointConfig({ ...managerEndpoint, base_url: 'http://router.example.test' })).toThrow();
    expect(parseProviderEndpointConfig({ ...managerEndpoint, base_url: 'http://router.example.test', allow_insecure_http: true }).base_url).toContain('http://');
  });

  it('applies only route-level cooldown eligibility', () => {
    expect(isEndpointEligible(managerEndpoint)).toBe(true);
    expect(isEndpointEligible({
      ...managerEndpoint,
      health_state: 'RATE_LIMITED',
      cooldown_state: { active: true, until: new Date(Date.now() + 60_000).toISOString(), reason: 'route 429' },
    })).toBe(false);
    expect(isEndpointEligible({
      ...managerEndpoint,
      health_state: 'RATE_LIMITED',
      cooldown_state: { active: true, until: new Date(Date.now() - 1_000).toISOString(), reason: 'route 429' },
    })).toBe(true);
  });

  it('plugs a coder router into the existing ProviderAdapter contract without account discovery', async () => {
    const endpoint: ProviderEndpointConfig = {
      ...managerEndpoint,
      resource_id: 'coder-omniroute',
      role: 'CODER',
      model_or_route: 'coder-production',
      capabilities: ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION'],
    };
    let invokedRoute = '';
    const adapter = new ConfiguredCoderEndpointAdapter(endpoint, {
      getHealth: async () => 'DEGRADED',
      execute: async (config, request) => {
        invokedRoute = `${config.model_or_route}:${request.taskId}`;
        return { executionId: 'fake-coder', status: 'COMPLETED', outputProtocol: 'workerresult.v1' };
      },
      cancel: async () => undefined,
    });
    expect(adapter.adapterType).toBe('API');
    expect(await adapter.getHealth()).toBe('LOW_QUOTA');
    expect(await adapter.getCapabilities()).toContain('CODING');
    const result = await adapter.execute({ taskId: 'task-1', projectId: 'project-1', instructions: [], contextFiles: [] });
    expect(result.status).toBe('COMPLETED');
    expect(invokedRoute).toBe('coder-production:task-1');
  });

  it('connects ConfiguredCoderEndpointAdapter with ResponsesCoderEndpointTransport', async () => {
    const endpoint: ProviderEndpointConfig = {
      ...managerEndpoint,
      resource_id: 'coder-omniroute',
      role: 'CODER',
      model_or_route: 'coder-production',
      capabilities: ['CODING'],
    };
    const transport = new ResponsesCoderEndpointTransport({
      environment: { AGENT_FORGE_OMNIROUTE_TOKEN: 'secret-token' },
      fetch: async () => new Response(JSON.stringify({
        id: 'resp-test',
        output_text: 'worker execution result',
      }), { status: 200 }),
    });
    const adapter = new ConfiguredCoderEndpointAdapter(endpoint, transport);
    const result = await adapter.execute({
      taskId: 'task-test',
      projectId: 'proj-test',
      instructions: ['write code'],
      contextFiles: [],
    });
    expect(result.status).toBe('COMPLETED');
    expect(result.rawResponse).toBe('worker execution result');
  });
});
