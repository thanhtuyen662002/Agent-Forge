import {
  ManagerReviewSchema,
  WorkOrderSchema,
  parseManagerReview,
  parseWorkOrder,
  sanitizeAutonomyText,
} from './contracts';
import type { ManagerPlanSeed } from './managerPool';
import {
  ManagerEndpointTransport,
  ProviderEndpointConfig,
  ProviderEndpointRole,
  parseProviderEndpointConfig,
} from './providerEndpoint';
import type { ManagerEvidence, ProviderRun } from './providers';

type FetchLike = typeof fetch;

export interface ResponsesEndpointTransportOptions {
  fetch?: FetchLike;
  environment?: NodeJS.ProcessEnv;
}

export interface EndpointContractResult {
  run: ProviderRun;
  compatible: boolean;
}

export function endpointUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  return normalized.endsWith('/responses') ? normalized : `${normalized}/responses`;
}

export function referencedEnvironmentName(authSource: string | null): string | null {
  if (!authSource?.startsWith('env://')) return null;
  return authSource.slice('env://'.length);
}

export function redactEndpointDiagnostics(
  text: string,
  authValue?: string,
  baseUrl?: string | null,
): string {
  let safe = text;
  if (authValue) {
    safe = safe.split(authValue).join('[REDACTED_SECRET]');
  }
  if (baseUrl) {
    safe = safe.split(endpointUrl(baseUrl)).join('[REDACTED_URL]');
    safe = safe.split(baseUrl).join('[REDACTED_URL]');
    try {
      const u = new URL(baseUrl);
      if (u.host) {
        safe = safe.split(u.host).join('[REDACTED_URL]');
      }
      if (u.origin) {
        safe = safe.split(u.origin).join('[REDACTED_URL]');
      }
    } catch {
      // not a valid URL or relative
    }
  }
  return sanitizeAutonomyText(safe);
}

export function redactValue(text: string, value: string | undefined, baseUrl?: string | null): string {
  return redactEndpointDiagnostics(text, value, baseUrl);
}

export function outputText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === 'string') return record.output_text;
  if (!Array.isArray(record.output)) return null;
  const pieces: string[] = [];
  for (const item of record.output) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text === 'string') pieces.push(text);
    }
  }
  return pieces.length ? pieces.join('\n') : null;
}

export function responseId(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const id = (payload as Record<string, unknown>).id;
  return typeof id === 'string' ? id : '';
}

export function failedRun(status: ProviderRun['status'], stderr: string, started: number): ProviderRun {
  return {
    status,
    exitCode: 1,
    executionId: '',
    stdout: '',
    stderr: sanitizeAutonomyText(stderr),
    durationMs: Date.now() - started,
  };
}

/** Direct OpenAI Responses-compatible transport for configured API/router endpoints. */
export class ResponsesManagerEndpointTransport implements ManagerEndpointTransport {
  private readonly fetchImpl: FetchLike;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: ResponsesEndpointTransportOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.environment = options.environment ?? process.env;
  }

  async review(config: ProviderEndpointConfig, input: ManagerEvidence) {
    const prompt = [
      'You are the Agent Forge reviewer. Use only the durable context package below.',
      'Return exactly this JSON shape and no markdown:',
      '{"protocol_version":"managerreview.v1","verdict":"PASS|REPAIR|BLOCKED","reviewed_head_sha":"40 character lowercase git SHA","findings":[{"severity":"LOW|MEDIUM|HIGH|CRITICAL","title":"nonempty string","description":"nonempty string","file_path":null,"line_number":null}],"required_actions":["nonempty string"],"risk":"LOW|MEDIUM|HIGH|CRITICAL","notes":"string"}',
      'Use empty findings and required_actions arrays when there are no findings or actions.',
      'PASS is valid only for the supplied current HEAD and deterministic evidence.',
      input.evidence,
    ].join('\n');
    const result = await this.request(config, prompt);
    if (result.run.status !== 'SUCCESSFUL_PROCESS_EXIT' || !result.text) return { run: result.run };
    try {
      const review = ManagerReviewSchema.parse(parseManagerReview(result.text));
      return { run: result.run, review };
    } catch (error) {
      return {
        run: {
          ...result.run,
          status: 'CONTRACT_INVALID' as const,
          error: sanitizeAutonomyText(error instanceof Error ? error.message : String(error)),
        },
      };
    }
  }

  async plan(config: ProviderEndpointConfig, seed: ManagerPlanSeed) {
    const prompt = [
      'You are the Agent Forge manager. Return exactly one JSON object matching workorder.v1 and no markdown.',
      'Preserve every seeded identity, SHA, branch, worktree, and constraint exactly.',
      JSON.stringify({
        protocol_version: 'workorder.v1',
        ...seed,
        issue_number: null,
        dependencies: [],
        allowed_paths: seed.allowed_paths ?? [],
        forbidden_paths: seed.forbidden_paths ?? ['.git'],
        required_tests: seed.required_tests ?? [],
        context_files: [],
        constraints: seed.constraints ?? [],
        attempt: 1,
        lease_epoch: 1,
      }),
    ].join('\n');
    const result = await this.request(config, prompt);
    if (result.run.status !== 'SUCCESSFUL_PROCESS_EXIT' || !result.text) return { run: result.run };
    try {
      const workOrder = WorkOrderSchema.parse(parseWorkOrder(result.text));
      for (const [key, value] of Object.entries(seed)) {
        if (JSON.stringify(workOrder[key as keyof typeof workOrder]) !== JSON.stringify(value)) {
          throw new Error(`CONTRACT_INVALID: routed manager changed authorized ${key}`);
        }
      }
      return { run: result.run, workOrder };
    } catch (error) {
      return {
        run: {
          ...result.run,
          status: 'CONTRACT_INVALID' as const,
          error: sanitizeAutonomyText(error instanceof Error ? error.message : String(error)),
        },
      };
    }
  }

  async contract(config: ProviderEndpointConfig): Promise<EndpointContractResult> {
    const result = await this.request(config, 'Reply exactly with the plain text OMNIROUTE_OK.');
    return {
      run: result.run,
      compatible: result.run.status === 'SUCCESSFUL_PROCESS_EXIT' && result.text?.trim() === 'OMNIROUTE_OK',
    };
  }

  private async request(configInput: ProviderEndpointConfig, prompt: string): Promise<{ run: ProviderRun; text?: string }> {
    const started = Date.now();
    const config = parseProviderEndpointConfig(configInput);
    if (!config.base_url) return { run: failedRun('CONTRACT_INVALID', 'PROVIDER_ENDPOINT_BASE_URL_MISSING', started) };
    const envName = referencedEnvironmentName(config.auth_source);
    if (!envName) return { run: failedRun('AUTH_ERROR', 'PROVIDER_ENDPOINT_AUTH_SOURCE_UNSUPPORTED', started) };
    const authValue = this.environment[envName];
    if (!authValue) return { run: failedRun('AUTH_ERROR', `PROVIDER_ENDPOINT_AUTH_ENV_MISSING: ${envName}`, started) };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeout_ms);
    try {
      const response = await this.fetchImpl(endpointUrl(config.base_url), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [config.auth_header_name]: authValue,
        },
        // The durable context remains in Agent Forge. Avoid creating an
        // upstream conversation or stored response as an implicit authority.
        body: JSON.stringify({ model: config.model_or_route, input: prompt, store: false }),
        signal: controller.signal,
      });
      const raw = await response.text();
      const safeRaw = redactValue(raw, authValue, config.base_url);
      if (response.status === 401 || response.status === 403) {
        return { run: failedRun('AUTH_ERROR', `ROUTE_AUTH_ERROR HTTP ${response.status}: ${safeRaw}`, started) };
      }
      // Capacity/quota exhaustion can arrive as HTTP 429 from Responses-compatible
      // providers. Classify its explicit error body before the generic 429 path so
      // a spend/quota failure fails closed instead of being retried after cooldown.
      if (response.status === 402 || (!response.ok && /insufficient[_ -]?quota|capacity.*exhaust|spend.?limit/i.test(safeRaw))) {
        return { run: failedRun('QUOTA_OR_RATE_LIMIT', `ROUTE_CAPACITY_EXHAUSTED HTTP ${response.status}: ${safeRaw}`, started) };
      }
      if (response.status === 429) {
        return { run: failedRun('QUOTA_OR_RATE_LIMIT', `ROUTE_RATE_LIMITED HTTP 429: ${safeRaw}`, started) };
      }
      if (!response.ok) {
        return { run: failedRun('FAILED_PROCESS_EXIT', `ROUTE_SERVER_FAILURE HTTP ${response.status}: ${safeRaw}`, started) };
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return { run: failedRun('CONTRACT_INVALID', 'ROUTE_CONTRACT_INVALID: response was not JSON', started) };
      }
      const text = outputText(payload);
      if (!text) return { run: failedRun('CONTRACT_INVALID', 'ROUTE_CONTRACT_INVALID: no Responses output text', started) };
      const safeText = redactValue(text, authValue, config.base_url);
      return {
        text: safeText,
        run: {
          status: 'SUCCESSFUL_PROCESS_EXIT',
          exitCode: 0,
          executionId: responseId(payload),
          stdout: safeText,
          stderr: '',
          durationMs: Date.now() - started,
        },
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { run: failedRun('TIMEOUT', 'ROUTE_TIMEOUT', started) };
      }
      return {
        run: failedRun(
          'PROCESS_NOT_FOUND',
          `ROUTE_OFFLINE: ${redactValue(error instanceof Error ? error.message : String(error), authValue, config.base_url)}`,
          started,
        ),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function loadOmniRouteEndpointFromEnvironment(
  role: ProviderEndpointRole,
  environment: NodeJS.ProcessEnv = process.env,
): ProviderEndpointConfig | null {
  const baseUrl = environment.AGENT_FORGE_OMNIROUTE_BASE_URL;
  const managerModel = environment.AGENT_FORGE_MANAGER_MODEL;
  const reviewerModel = environment.AGENT_FORGE_REVIEWER_MODEL ?? managerModel;
  const coderModel = environment.AGENT_FORGE_CODER_MODEL;
  const model = role === 'MANAGER' ? managerModel : role === 'REVIEWER' ? reviewerModel : coderModel;
  if (!baseUrl || !model || environment.AGENT_FORGE_OMNIROUTE_ENABLED !== '1') return null;
  const authEnv = environment.AGENT_FORGE_OMNIROUTE_AUTH_ENV ?? 'OMNIROUTE_AUTH_HEADER';
  const priority = role === 'REVIEWER' ? 300 : role === 'MANAGER' ? 290 : 280;
  return parseProviderEndpointConfig({
    resource_id: `${role.toLowerCase()}-omniroute`,
    role,
    adapter_type: 'EXTERNAL_ROUTER',
    base_url: baseUrl,
    allow_insecure_http: environment.AGENT_FORGE_OMNIROUTE_ALLOW_HTTP === '1',
    model_or_route: model,
    auth_source: `env://${authEnv}`,
    auth_header_name: environment.AGENT_FORGE_OMNIROUTE_AUTH_HEADER_NAME ?? 'Authorization',
    priority,
    timeout_ms: Number(environment.AGENT_FORGE_OMNIROUTE_TIMEOUT_MS ?? 120_000),
    enabled: true,
    health_state: 'AVAILABLE',
    cooldown_state: { active: false, until: null, reason: null },
    capabilities: role === 'CODER'
      ? ['CODING']
      : role === 'MANAGER'
        ? ['PLANNING', 'REVIEW']
        : ['REVIEW'],
  });
}
