import { z } from 'zod';
import {
  AgentExecutionRequest,
  AgentExecutionResult,
  ProviderAdapter,
  QuotaSnapshotInfo,
} from '../adapters/ProviderAdapter';
import {
  CapabilityEnum,
  ProviderAdapterType,
  ProviderHealthStatus,
} from '../types/domain';
import type { ManagerPlanSeed, ManagerResource } from './managerPool';
import type { ManagerEvidence, ProviderRun } from './providers';
import type { ManagerReview, WorkOrder } from './contracts';

export const ProviderEndpointRoleSchema = z.enum(['MANAGER', 'REVIEWER', 'CODER']);
export type ProviderEndpointRole = z.infer<typeof ProviderEndpointRoleSchema>;

export const ProviderEndpointAdapterTypeSchema = z.enum([
  'DIRECT_PROVIDER',
  'API_PROVIDER',
  'EXTERNAL_ROUTER',
]);
export type ProviderEndpointAdapterType = z.infer<typeof ProviderEndpointAdapterTypeSchema>;

export const ProviderEndpointHealthStateSchema = z.enum([
  'AVAILABLE',
  'DEGRADED',
  'RATE_LIMITED',
  'AUTH_ERROR',
  'CAPACITY_EXHAUSTED',
  'OFFLINE',
  'CONTRACT_INVALID',
]);
export type ProviderEndpointHealthState = z.infer<typeof ProviderEndpointHealthStateSchema>;

export const ProviderEndpointConfigSchema = z.object({
  resource_id: z.string().min(1),
  role: ProviderEndpointRoleSchema,
  adapter_type: ProviderEndpointAdapterTypeSchema,
  base_url: z.string().url().nullable(),
  allow_insecure_http: z.boolean().default(false),
  model_or_route: z.string().min(1),
  // This is a reference only. Inline bearer/API credentials are rejected so
  // route configuration remains safe to persist and audit.
  auth_source: z.string().regex(/^(env|secret|wincred|profile):\/\/[A-Za-z0-9._\-/]+$/).nullable(),
  auth_header_name: z.string().regex(/^[A-Za-z0-9-]+$/).default('Authorization'),
  priority: z.number().int(),
  timeout_ms: z.number().int().positive().max(30 * 60 * 1000),
  enabled: z.boolean(),
  health_state: ProviderEndpointHealthStateSchema,
  cooldown_state: z.object({
    active: z.boolean(),
    until: z.string().datetime().nullable(),
    reason: z.string().nullable(),
  }),
  capabilities: z.array(CapabilityEnum),
}).superRefine((value, context) => {
  if (value.adapter_type !== 'DIRECT_PROVIDER' && !value.base_url) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['base_url'],
      message: `${value.adapter_type} requires an HTTPS endpoint URL`,
    });
  }
  if (value.base_url && !value.base_url.startsWith('https://') && !value.allow_insecure_http) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['base_url'],
      message: 'Provider endpoint URLs must use HTTPS unless insecure HTTP is explicitly authorized',
    });
  }
  if (value.adapter_type !== 'DIRECT_PROVIDER' && !value.auth_source) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['auth_source'],
      message: `${value.adapter_type} requires an external auth source reference`,
    });
  }
  if (value.cooldown_state.active && !value.cooldown_state.until) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cooldown_state', 'until'],
      message: 'An active route cooldown requires an expiry',
    });
  }
});

export type ProviderEndpointConfig = z.infer<typeof ProviderEndpointConfigSchema>;

export interface ManagerEndpointTransport {
  review(config: ProviderEndpointConfig, input: ManagerEvidence): Promise<{ run: ProviderRun; review?: ManagerReview }>;
  plan?(config: ProviderEndpointConfig, seed: ManagerPlanSeed): Promise<{ run: ProviderRun; workOrder?: WorkOrder }>;
}

export interface CoderEndpointTransport {
  getHealth(config: ProviderEndpointConfig): Promise<ProviderEndpointHealthState>;
  getQuota?(config: ProviderEndpointConfig): Promise<QuotaSnapshotInfo>;
  execute(config: ProviderEndpointConfig, request: AgentExecutionRequest): Promise<AgentExecutionResult>;
  cancel(config: ProviderEndpointConfig, executionId: string): Promise<void>;
}

export function parseProviderEndpointConfig(input: unknown): ProviderEndpointConfig {
  return ProviderEndpointConfigSchema.parse(input);
}

export function isRouteEndpoint(config: ProviderEndpointConfig): boolean {
  return config.adapter_type === 'EXTERNAL_ROUTER';
}

export function isEndpointEligible(config: ProviderEndpointConfig, now = Date.now()): boolean {
  if (!config.enabled) return false;
  if (config.cooldown_state.active) {
    return !!config.cooldown_state.until && Date.parse(config.cooldown_state.until) <= now;
  }
  return config.health_state === 'AVAILABLE' || config.health_state === 'DEGRADED';
}

/**
 * Adapts one configured endpoint into the existing ManagerProviderPool. The
 * pool continues to own failover and durable context; an EXTERNAL_ROUTER
 * remains one opaque route-level capacity resource.
 */
export function managerResourceFromEndpoint(
  input: ProviderEndpointConfig,
  transport: ManagerEndpointTransport,
): ManagerResource {
  const config = ProviderEndpointConfigSchema.parse(input);
  if (config.role !== 'MANAGER' && config.role !== 'REVIEWER') {
    throw new Error('PROVIDER_ENDPOINT_ROLE_MISMATCH: expected MANAGER or REVIEWER');
  }
  if (!config.capabilities.includes('REVIEW')) throw new Error('MANAGER_ENDPOINT_REQUIRES_REVIEW_CAPABILITY');
  return {
    id: config.resource_id,
    priority: config.priority,
    enabled: config.enabled,
    endpoint: config,
    review: (evidence) => transport.review(config, evidence),
    plan: config.role === 'MANAGER' && transport.plan
      ? (seed) => transport.plan!(config, seed)
      : undefined,
  };
}

function mapHealth(state: ProviderEndpointHealthState): ProviderHealthStatus {
  switch (state) {
    case 'AVAILABLE': return 'AVAILABLE';
    case 'DEGRADED': return 'LOW_QUOTA';
    case 'RATE_LIMITED': return 'RATE_LIMITED';
    case 'AUTH_ERROR': return 'AUTH_ERROR';
    case 'CAPACITY_EXHAUSTED': return 'QUOTA_EXHAUSTED';
    case 'OFFLINE': return 'OFFLINE';
    case 'CONTRACT_INVALID': return 'UNHEALTHY';
  }
}

/**
 * Plugs a configured coder endpoint into the existing role-aware routing and
 * ProviderAdapter execution path. The transport receives no underlying
 * account inventory: account rotation behind an external router stays outside
 * Agent Forge.
 */
export class ConfiguredCoderEndpointAdapter implements ProviderAdapter {
  public readonly id: string;
  public readonly name: string;
  public readonly adapterType: ProviderAdapterType;

  constructor(
    public readonly endpoint: ProviderEndpointConfig,
    private readonly transport: CoderEndpointTransport,
  ) {
    this.endpoint = ProviderEndpointConfigSchema.parse(endpoint);
    if (this.endpoint.role !== 'CODER') throw new Error('PROVIDER_ENDPOINT_ROLE_MISMATCH: expected CODER');
    if (!this.endpoint.capabilities.includes('CODING')) throw new Error('CODER_ENDPOINT_REQUIRES_CODING_CAPABILITY');
    this.id = this.endpoint.resource_id;
    this.name = this.endpoint.resource_id;
    this.adapterType = this.endpoint.adapter_type === 'DIRECT_PROVIDER' ? 'LOCAL_CLI' : 'API';
  }

  async getCapabilities() {
    return [...this.endpoint.capabilities];
  }

  async getHealth(): Promise<ProviderHealthStatus> {
    return mapHealth(await this.transport.getHealth(this.endpoint));
  }

  async getQuota(): Promise<QuotaSnapshotInfo> {
    if (this.transport.getQuota) return this.transport.getQuota(this.endpoint);
    return {
      remaining: null,
      total: null,
      unit: 'UNKNOWN',
      source: 'UNKNOWN',
      confidence: 0,
      resetAt: null,
    };
  }

  execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    return this.transport.execute(this.endpoint, request);
  }

  cancel(executionId: string): Promise<void> {
    return this.transport.cancel(this.endpoint, executionId);
  }
}
