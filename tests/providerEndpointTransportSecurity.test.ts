import { describe, expect, it } from 'vitest';
import {
  isApprovedProviderAuthHeaderName,
  parseProviderEndpointConfig,
  PROVIDER_RESPONSE_MAX_BYTES,
  ProviderEndpointConfig,
} from '../src/core/autonomy/providerEndpoint';
import {
  readResponseTextBounded,
  ResponsesManagerEndpointTransport,
} from '../src/core/autonomy/responsesEndpoint';
import { ResponsesCoderEndpointTransport } from '../src/core/autonomy/responsesCoderEndpoint';

const secret = 'provider-test-secret';
const baseEndpoint: ProviderEndpointConfig = {
  resource_id: 'manager-router',
  role: 'MANAGER',
  adapter_type: 'EXTERNAL_ROUTER',
  base_url: 'https://router.example.test/v1',
  allow_insecure_http: false,
  model_or_route: 'manager-model',
  auth_source: 'env://TEST_PROVIDER_AUTH',
  auth_header_name: 'X-Company-Auth',
  priority: 100,
  timeout_ms: 1_000,
  enabled: true,
  health_state: 'AVAILABLE',
  cooldown_state: { active: false, until: null, reason: null },
  capabilities: ['PLANNING', 'REVIEW'],
};

const coderEndpoint: ProviderEndpointConfig = {
  ...baseEndpoint,
  resource_id: 'coder-router',
  role: 'CODER',
  model_or_route: 'coder-model',
  capabilities: ['CODING'],
};

const managerEvidence = { workOrder: {} as never, evidence: '{}' };

function validResponse() {
  return new Response(JSON.stringify({
    id: 'provider-response',
    output: [{ content: [{ type: 'output_text', text: 'provider output' }] }],
  }), { status: 200 });
}

describe('provider endpoint transport security boundary', () => {
  it.each([
    ['file:///tmp/provider', false],
    ['data:text/plain,provider', false],
    ['ftp://router.example.test/v1', true],
    ['https://user:password@router.example.test/v1', false],
    ['https://router.example.test/v1?token=secret', false],
    ['https://router.example.test/v1#fragment', false],
    ['http://router.example.test/v1', false],
    ['https://router.example.test\\v1', false],
  ])('rejects unsafe base URL %s (allowHttp=%s)', (baseUrl, allowInsecureHttp) => {
    expect(() => parseProviderEndpointConfig({
      ...baseEndpoint,
      base_url: baseUrl,
      allow_insecure_http: allowInsecureHttp,
    })).toThrow();
  });

  it('preserves explicitly authorized HTTP while rejecting sensitive auth headers', () => {
    const parsed = parseProviderEndpointConfig({
      ...baseEndpoint,
      base_url: 'http://router.example.test/v1',
      allow_insecure_http: true,
    });
    expect(parsed.base_url).toBe('http://router.example.test/v1');

    for (const header of ['Cookie', 'Host', 'Proxy-Authorization', 'Set-Cookie', 'X-Unknown-Credential']) {
      expect(isApprovedProviderAuthHeaderName(header)).toBe(false);
      expect(() => parseProviderEndpointConfig({ ...baseEndpoint, auth_header_name: header })).toThrow();
    }
    for (const header of ['Authorization', 'X-API-Key', 'X-Company-Auth']) {
      expect(isApprovedProviderAuthHeaderName(header)).toBe(true);
    }
  });

  it('rejects invalid endpoint configuration before contacting the provider', async () => {
    let calls = 0;
    const transport = new ResponsesManagerEndpointTransport({
      environment: { TEST_PROVIDER_AUTH: secret },
      fetch: async () => {
        calls += 1;
        return validResponse();
      },
    });
    const result = await transport.review({
      ...baseEndpoint,
      base_url: 'file:///tmp/provider',
    } as ProviderEndpointConfig, managerEvidence);
    expect(calls).toBe(0);
    expect(result.run.status).toBe('CONTRACT_INVALID');
    expect(result.run.stderr).toBe('PROVIDER_ENDPOINT_CONFIG_INVALID');
    expect(result.run.stderr).not.toContain(secret);
  });

  it('sets redirect:error and omits ambient credentials for manager requests', async () => {
    let seenInit: RequestInit | undefined;
    const transport = new ResponsesManagerEndpointTransport({
      environment: { TEST_PROVIDER_AUTH: secret },
      fetch: async (_url, init) => {
        seenInit = init;
        return new Response('redirect', {
          status: 302,
          headers: { location: 'https://evil.example.test/responses' },
        });
      },
    });
    const result = await transport.review(baseEndpoint, managerEvidence);
    expect(seenInit?.redirect).toBe('error');
    expect(seenInit?.credentials).toBe('omit');
    expect(result.run.status).toBe('CONTRACT_INVALID');
    expect(result.run.stderr).toContain('ROUTE_REDIRECT_BLOCKED');
    expect(result.run.stderr).not.toContain(secret);
  });

  it('rejects a custom transport response whose final origin changed', async () => {
    const transport = new ResponsesManagerEndpointTransport({
      environment: { TEST_PROVIDER_AUTH: secret },
      fetch: async () => {
        const response = validResponse();
        Object.defineProperty(response, 'url', { value: 'https://evil.example.test/responses' });
        return response;
      },
    });
    const result = await transport.review(baseEndpoint, managerEvidence);
    expect(result.run.status).toBe('CONTRACT_INVALID');
    expect(result.run.stderr).toBe('ROUTE_REDIRECT_BLOCKED');
  });

  it('fails before body consumption when content-length exceeds the transport limit', async () => {
    const transport = new ResponsesManagerEndpointTransport({
      environment: { TEST_PROVIDER_AUTH: secret },
      fetch: async () => new Response('', {
        status: 200,
        headers: { 'content-length': String(PROVIDER_RESPONSE_MAX_BYTES + 1) },
      }),
    });
    const result = await transport.review(baseEndpoint, managerEvidence);
    expect(result.run.status).toBe('CONTRACT_INVALID');
    expect(result.run.stderr).toBe('ROUTE_RESPONSE_TOO_LARGE');
  });

  it('bounds streamed response reads at a byte boundary', async () => {
    await expect(readResponseTextBounded(new Response('12345'), 4)).rejects.toMatchObject({
      code: 'ROUTE_RESPONSE_TOO_LARGE',
    });
    await expect(readResponseTextBounded(new Response('1234'), 4)).resolves.toBe('1234');
  });

  it('applies the same redirect and response policy to coder requests', async () => {
    let seenInit: RequestInit | undefined;
    const transport = new ResponsesCoderEndpointTransport({
      environment: { TEST_PROVIDER_AUTH: secret },
      fetch: async (_url, init) => {
        seenInit = init;
        return new Response('redirect', { status: 307 });
      },
    });
    const result = await transport.contract(coderEndpoint);
    expect(seenInit?.redirect).toBe('error');
    expect(seenInit?.credentials).toBe('omit');
    expect(result.run.status).toBe('CONTRACT_INVALID');
    expect(result.healthState).toBe('CONTRACT_INVALID');
    expect(result.run.stderr).toBe('ROUTE_REDIRECT_BLOCKED');
  });
});
