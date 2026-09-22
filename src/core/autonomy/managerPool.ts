import crypto from 'crypto';
import { z } from 'zod';
import {
  ManagerReview,
  ManagerReviewSchema,
  WorkOrder,
  WorkOrderSchema,
  parseManagerReview,
  parseWorkOrder,
  sanitizeAutonomyText,
} from './contracts';
import { AutonomyStore, ManagerResourceState } from './store';
import { CodexManagerAdapter, ManagerEvidence, ProviderRun } from './providers';
import { Repository } from '../database/repositories';
import { managerResourceFromEndpoint, ProviderEndpointConfig } from './providerEndpoint';
import { loadOmniRouteEndpointFromEnvironment, ResponsesManagerEndpointTransport } from './responsesEndpoint';

export const ManagerContextPackageSchema = z.object({
  protocol_version: z.literal('managercontext.v1'),
  task_identity: z.object({
    task_id: z.string().min(1),
    attempt: z.number().int().positive(),
    worker_id: z.string().min(1),
  }),
  work_order: WorkOrderSchema,
  acceptance_criteria: z.array(z.string()),
  base_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  current_head: z.string().regex(/^[0-9a-f]{40}$/i),
  actual_diff: z.string(),
  changed_files: z.array(z.string()),
  deterministic_tests: z.array(z.unknown()),
  previous_manager_decisions: z.array(z.unknown()),
  repair_history: z.array(z.unknown()),
  pr_state: z.unknown(),
  ci_state: z.unknown(),
  architecture_policy_context: z.array(z.string()),
});

export type ManagerContextPackage = z.infer<typeof ManagerContextPackageSchema>;

export interface BuildManagerContextParams {
  workOrder: WorkOrder;
  currentHead: string;
  actualDiff?: string;
  changedFiles?: string[];
  deterministicTests?: unknown[];
  previousManagerDecisions?: unknown[];
  repairHistory?: unknown[];
  prState?: unknown;
  ciState?: unknown;
  architecturePolicyContext?: string[];
}

export function buildManagerContextPackage(params: BuildManagerContextParams): ManagerContextPackage {
  const { workOrder } = params;
  return ManagerContextPackageSchema.parse({
    protocol_version: 'managercontext.v1',
    task_identity: {
      task_id: workOrder.task_id,
      attempt: workOrder.attempt,
      worker_id: workOrder.worker_id,
    },
    work_order: workOrder,
    acceptance_criteria: workOrder.acceptance_criteria,
    base_sha: workOrder.base_sha,
    current_head: params.currentHead,
    actual_diff: params.actualDiff ?? '',
    changed_files: params.changedFiles ?? workOrder.allowed_paths,
    deterministic_tests: params.deterministicTests ?? [],
    previous_manager_decisions: params.previousManagerDecisions ?? [],
    repair_history: params.repairHistory ?? [],
    pr_state: params.prState ?? {},
    ci_state: params.ciState ?? {},
    architecture_policy_context: params.architecturePolicyContext ?? [
      'Supervisor owns leases, worktrees, GitHub, and verification.',
      'PASS requires a fresh exact HEAD match.',
    ],
  });
}

export type ManagerPlanSeed = Pick<WorkOrder, 'task_id' | 'worker_id' | 'base_sha' | 'branch' | 'worktree' | 'objective' | 'acceptance_criteria'> &
  Partial<Pick<WorkOrder, 'required_tests' | 'constraints' | 'allowed_paths' | 'forbidden_paths'>>;

export const ManagerPlanContextSchema = z.object({
  protocol_version: z.literal('workorder.v1'),
  task_id: z.string().min(1),
  worker_id: z.string().min(1),
  base_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  branch: z.string().min(1),
  worktree: z.string().min(1),
  objective: z.string().min(1),
  acceptance_criteria: z.array(z.string()),
  issue_number: z.number().nullable().optional(),
  dependencies: z.array(z.string()).default([]),
  allowed_paths: z.array(z.string()).default([]),
  forbidden_paths: z.array(z.string()).default([]),
  required_tests: z.array(z.string()).default([]),
  context_files: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  attempt: z.number().int().positive().default(1),
  lease_epoch: z.number().int().positive().default(1),
});

export type ManagerPlanContext = z.infer<typeof ManagerPlanContextSchema>;

export interface ManagerPlanResult {
  run: ProviderRun;
  workOrder?: WorkOrder;
  resource_id: string;
  context_sha: string;
  attempts: string[];
}

export interface ManagerResource {
  id: string;
  priority: number;
  enabled: boolean;
  endpoint?: {
    resource_id: string;
    role: 'MANAGER' | 'REVIEWER' | 'CODER';
    adapter_type: 'DIRECT_PROVIDER' | 'API_PROVIDER' | 'EXTERNAL_ROUTER';
  };
  review(input: ManagerEvidence): Promise<{ run: ProviderRun; review?: ManagerReview }>;
  plan?(seed: ManagerPlanSeed): Promise<{ run: ProviderRun; workOrder?: WorkOrder }>;
}

export interface ManagerPoolResult {
  run: ProviderRun;
  review?: ManagerReview;
  resource_id: string;
  context_sha: string;
  attempts: string[];
}

function ensureProductEndpointResource(store: AutonomyStore, endpoint: ProviderEndpointConfig): void {
  const repo = new Repository(store.getDatabase());
  const providerId = 'provider-external-router';
  const existingProvider = repo.getProvider(providerId);
  if (!existingProvider) {
    repo.createProvider({
      id: providerId,
      name: 'Configured external router',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    });
  } else if (existingProvider.adapter_type !== 'API') {
    throw new Error('EXTERNAL_ROUTER_PROVIDER_CONTRACT_INVALID');
  }
  if (repo.getProviderResource(endpoint.resource_id)) return;
  repo.createProviderResource({
    id: endpoint.resource_id,
    provider_id: providerId,
    provider_account_id: null,
    model_name: endpoint.model_or_route,
    health_status: 'AVAILABLE',
    capabilities: [...endpoint.capabilities],
    enabled: endpoint.enabled,
    total_quota: null,
    remaining_quota: null,
    quota_unit: 'ROUTE_REQUESTS',
    quota_reset_at: null,
    quota_source: 'UNKNOWN',
    quota_confidence: 0,
    last_health_check: null,
  });
}

export function classify(run: ProviderRun): { state: ManagerResourceState; cooldownUntil: string | null } {
  const text = `${run.stdout}\n${run.stderr}\n${run.error ?? ''}`;
  if (run.status === 'SUCCESSFUL_PROCESS_EXIT') return { state: 'AVAILABLE', cooldownUntil: null };
  // Explicit transport/contract status is authoritative. Contract diagnostics
  // frequently contain words such as "authorized"; text heuristics must not
  // misclassify those validation failures as credential failures.
  if (run.status === 'AUTH_ERROR') return { state: 'AUTH_ERROR', cooldownUntil: null };
  if (run.status === 'CONTRACT_INVALID') return { state: 'CONTRACT_INVALID', cooldownUntil: null };
  if (/ROUTE_CAPACITY_EXHAUSTED|capacity.*exhaust/i.test(text)) {
    return { state: 'CAPACITY_EXHAUSTED', cooldownUntil: null };
  }
  if (
    /out of credits|workspace.*credit|credits.*exhausted|credit.*exhaust|exhaust.*credit|insufficient[_ -]?quota|quota.*exhaust|spend.?limit|billing.?limit/i.test(
      text,
    )
  ) {
    return { state: 'CREDITS_EXHAUSTED', cooldownUntil: null };
  }
  if (/rate.?limit|too many requests|\b429\b/i.test(text)) {
    return { state: 'RATE_LIMITED', cooldownUntil: new Date(Date.now() + 60_000).toISOString() };
  }
  if (/cooldown/i.test(text)) {
    return { state: 'COOLDOWN', cooldownUntil: new Date(Date.now() + 60_000).toISOString() };
  }
  if (/auth|not logged|unauthorized|invalid token/i.test(text)) {
    return { state: 'AUTH_ERROR', cooldownUntil: null };
  }
  if (/CONTRACT_INVALID/i.test(text)) {
    return { state: 'CONTRACT_INVALID', cooldownUntil: null };
  }
  if (run.status === 'TIMEOUT') {
    return { state: 'TIMEOUT', cooldownUntil: new Date(Date.now() + 60_000).toISOString() };
  }
  if (run.status === 'PROCESS_NOT_FOUND') {
    return { state: 'OFFLINE', cooldownUntil: new Date(Date.now() + 60_000).toISOString() };
  }
  return { state: 'OFFLINE', cooldownUntil: new Date(Date.now() + 60_000).toISOString() };
}

export function isEligible(state: ManagerResourceState | undefined, until: string | null | undefined): boolean {
  if (!state || state === 'AVAILABLE' || state === 'DEGRADED') return true;
  if (state === 'RATE_LIMITED' || state === 'COOLDOWN' || state === 'TIMEOUT' || state === 'OFFLINE') {
    return !!until && Date.parse(until) <= Date.now();
  }
  return false;
}

export class ManagerProviderPool {
  constructor(private readonly store: AutonomyStore, private readonly resources: ManagerResource[]) {
    // Recover known capacity failures from earlier singleton manager attempts.
    // This prevents a restart from immediately retrying an exhausted resource.
    for (const resource of resources) {
      // Legacy singleton evidence belongs only to the ChatGPT workspace
      // resource. API fallback billing/quota is independent and must remain
      // eligible until its own provider reports a capacity failure.
      if (resource.id !== 'codex-chatgpt-primary') continue;
      const productHealth = this.checkProductResourceHealth(resource.id);
      if (productHealth.configured && !productHealth.eligible) continue;
      if (!productHealth.configured && this.store.getManagerResourceHealth(resource.id)) continue;
      const prior = this.store
        .getDatabase()
        .prepare(
          "SELECT stderr,stdout FROM autonomy_runs WHERE provider IN ('codex-review','codex-ci-review') ORDER BY started_at DESC LIMIT 20",
        )
        .all() as Array<{ stderr: string; stdout: string }>;
      if (
        prior.some((run) =>
          /out of credits|workspace.*credit|credits.*exhausted|credit.*exhaust|exhaust.*credit|insufficient[_ -]?quota|quota.*exhaust|spend.?limit|billing.?limit/i.test(
            `${run.stdout}\n${run.stderr}`,
          ),
        )
      ) {
        this.recordResourceHealth(resource.id, 'CREDITS_EXHAUSTED', 'Recovered from durable manager run evidence', null);
      }
    }
  }

  static fromPrimary(store: AutonomyStore, primary: CodexManagerAdapter): ManagerProviderPool {
    return new ManagerProviderPool(store, [
      {
        id: 'codex-chatgpt-primary',
        priority: 100,
        enabled: true,
        review: (input) => primary.review(input),
        plan: (seed) => primary.plan(seed),
      },
    ]);
  }

  static fromEnvironment(
    store: AutonomyStore,
    primary: CodexManagerAdapter,
    additionalResources: ManagerResource[] = [],
  ): ManagerProviderPool {
    const resources: ManagerResource[] = [];
    const routeTransport = new ResponsesManagerEndpointTransport();
    const reviewerRoute = loadOmniRouteEndpointFromEnvironment('REVIEWER');
    const managerRoute = loadOmniRouteEndpointFromEnvironment('MANAGER');
    if (reviewerRoute) {
      ensureProductEndpointResource(store, reviewerRoute);
      resources.push(managerResourceFromEndpoint(reviewerRoute, routeTransport));
    }
    if (managerRoute) {
      ensureProductEndpointResource(store, managerRoute);
      resources.push(managerResourceFromEndpoint(managerRoute, routeTransport));
    }
    resources.push(
      {
        id: 'codex-chatgpt-primary',
        priority: 100,
        enabled: true,
        review: (input) => primary.review(input),
        plan: (seed) => primary.plan(seed),
      },
    );
    if (process.env.AGENT_FORGE_ENABLE_OPENAI_API_FALLBACK === '1') {
      resources.push({
        id: 'codex-api-fallback',
        priority: 50,
        enabled: true,
        review: (input) => openAiApiReview(input),
        plan: (seed) => openAiApiPlan(seed),
      });
    }
    for (const res of additionalResources) {
      resources.push(res);
    }
    return new ManagerProviderPool(store, resources);
  }

  registerResource(resource: ManagerResource): void {
    const idx = this.resources.findIndex((r) => r.id === resource.id);
    if (idx >= 0) {
      this.resources[idx] = resource;
    } else {
      this.resources.push(resource);
    }
  }

  getResources(): ManagerResource[] {
    return [...this.resources];
  }

  getResource(id: string): ManagerResource | undefined {
    return this.resources.find((r) => r.id === id);
  }

  checkProductResourceHealth(resourceId: string): { configured: boolean; eligible: boolean; reason?: string } {
    const db = this.store.getDatabase();
    const resource = db.prepare(
      'SELECT enabled,health_status,provider_account_id,remaining_quota,quota_source,last_health_check FROM provider_resources WHERE id=?',
    ).get(resourceId) as {
      enabled: number;
      health_status: string;
      provider_account_id: string | null;
      remaining_quota: number | null;
      quota_source: string;
      last_health_check: string | null;
    } | undefined;
    if (!resource) return { configured: false, eligible: true };
    if (!resource.enabled) return { configured: true, eligible: false, reason: 'PROVIDER_RESOURCE_DISABLED' };
    if (['DISABLED', 'UNHEALTHY', 'QUOTA_EXHAUSTED', 'AUTH_ERROR', 'BUSY'].includes(resource.health_status)) {
      return { configured: true, eligible: false, reason: `PROVIDER_RESOURCE_${resource.health_status}` };
    }
    if (
      ['MEASURED', 'PROVIDER_REPORTED', 'MANUAL'].includes(resource.quota_source) &&
      resource.remaining_quota !== null && resource.remaining_quota <= 0
    ) {
      return { configured: true, eligible: false, reason: 'PROVIDER_RESOURCE_QUOTA_EXHAUSTED' };
    }
    if (['RATE_LIMITED', 'COOLDOWN', 'OFFLINE'].includes(resource.health_status)) {
      const retryAt = resource.last_health_check
        ? Date.parse(resource.last_health_check) + 60_000
        : Number.POSITIVE_INFINITY;
      if (retryAt > Date.now()) {
        return { configured: true, eligible: false, reason: `PROVIDER_RESOURCE_${resource.health_status}_COOLDOWN` };
      }
    }
    // A resource may intentionally be account-unbound when it represents one
    // externally routed endpoint. In that case Agent Forge owns route health,
    // while the upstream router owns its hidden account pool.
    if (!resource.provider_account_id) return { configured: true, eligible: true };
    const account = db.prepare(
      'SELECT enabled,health_status,cooldown_until FROM provider_accounts WHERE id=?',
    ).get(resource.provider_account_id) as { enabled: number; health_status: string; cooldown_until: string | null } | undefined;
    if (!account) return { configured: true, eligible: false, reason: 'PROVIDER_ACCOUNT_NOT_FOUND' };
    if (!account.enabled) return { configured: true, eligible: false, reason: 'PROVIDER_ACCOUNT_DISABLED' };
    if (['AUTH_ERROR', 'OFFLINE', 'UNHEALTHY', 'QUOTA_EXHAUSTED', 'DISABLED', 'BUSY'].includes(account.health_status)) {
      return { configured: true, eligible: false, reason: `PROVIDER_ACCOUNT_${account.health_status}` };
    }
    if (resource.health_status === 'RATE_LIMITED' || resource.health_status === 'COOLDOWN' || account.health_status === 'RATE_LIMITED' || account.health_status === 'COOLDOWN') {
      if (!account.cooldown_until || Date.parse(account.cooldown_until) > Date.now()) {
        return { configured: true, eligible: false, reason: 'PROVIDER_ACCOUNT_COOLDOWN' };
      }
    }
    return { configured: true, eligible: true };
  }

  private recordResourceHealth(
    resourceId: string,
    classifiedState: ManagerResourceState,
    errorText: string,
    cooldownUntil: string | null,
  ): void {
    if (!this.syncProductResourceHealth(resourceId, classifiedState, cooldownUntil)) {
      this.store.recordManagerResource(resourceId, classifiedState, errorText, cooldownUntil);
    }
  }

  syncProductResourceHealth(resourceId: string, classifiedState: ManagerResourceState, cooldownUntil: string | null): boolean {
    const repo = new Repository(this.store.getDatabase());
    const resource = repo.getProviderResource(resourceId);
    if (!resource) return false;
    const health = classifiedState === 'CREDITS_EXHAUSTED' || classifiedState === 'CAPACITY_EXHAUSTED'
      ? 'QUOTA_EXHAUSTED'
      : classifiedState === 'CONTRACT_INVALID'
        ? 'UNHEALTHY'
        : classifiedState === 'TIMEOUT'
          ? 'OFFLINE'
          : classifiedState === 'DEGRADED'
            ? 'LOW_QUOTA'
            : classifiedState;
    repo.recordProviderResourceHealth(
      resourceId,
      health,
      cooldownUntil,
      classifiedState,
      health === 'QUOTA_EXHAUSTED',
    );
    return true;
  }

  async review(context: ManagerContextPackage): Promise<ManagerPoolResult> {
    const validatedContext = ManagerContextPackageSchema.parse(context);
    const evidence = JSON.stringify(validatedContext);
    const contextSha = crypto.createHash('sha256').update(evidence).digest('hex');
    this.store.recordManagerContext(contextSha, evidence);
    const attempts: string[] = [];
    const candidates = [...this.resources].filter((r) => r.enabled).sort((a, b) => b.priority - a.priority);

    for (const resource of candidates) {
      const health = this.store.getManagerResourceHealth(resource.id);
      const productHealth = this.checkProductResourceHealth(resource.id);
      if (!productHealth.configured && !isEligible(health?.state, health?.cooldown_until)) continue;
      if (!productHealth.eligible) continue;

      attempts.push(resource.id);
      this.store.recordManagerAttempt(validatedContext.work_order.task_id, resource.id, contextSha, 'STARTED');

      let result: { run: ProviderRun; review?: ManagerReview };
      try {
        result = await resource.review({ workOrder: validatedContext.work_order, evidence });
      } catch (error) {
        result = {
          run: {
            status: 'CONTRACT_INVALID',
            exitCode: 1,
            executionId: '',
            stdout: '',
            stderr: sanitizeAutonomyText(error instanceof Error ? error.message : String(error)),
            durationMs: 0,
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }

      if (result.run.status === 'SUCCESSFUL_PROCESS_EXIT' && !result.review) {
        result = {
          run: {
            ...result.run,
            status: 'CONTRACT_INVALID',
            error: 'CONTRACT_INVALID: successful manager process returned no review',
          },
        };
      }
      const classified = classify(result.run);
      this.recordResourceHealth(
        resource.id,
        classified.state,
        sanitizeAutonomyText(result.run.stderr || result.run.error || ''),
        classified.cooldownUntil,
      );
      this.store.recordManagerAttempt(
        validatedContext.work_order.task_id,
        resource.id,
        contextSha,
        result.review ? 'REVIEWED' : classified.state,
      );

      if (result.review) {
        try {
          const review = ManagerReviewSchema.parse(result.review);
          if (review.reviewed_head_sha !== validatedContext.current_head) {
            return {
              ...result,
              review: {
                ...review,
                verdict: 'REPAIR',
                findings: [
                  ...review.findings,
                  {
                    severity: 'CRITICAL',
                    title: 'STALE_REVIEW_HEAD',
                    description: `Reviewed head ${review.reviewed_head_sha} did not match expected current head ${validatedContext.current_head}`,
                  },
                ],
                required_actions: [...review.required_actions, 'Re-evaluate on current HEAD'],
              },
              resource_id: resource.id,
              context_sha: contextSha,
              attempts,
            };
          }
          return { ...result, review, resource_id: resource.id, context_sha: contextSha, attempts };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.recordResourceHealth(resource.id, 'CONTRACT_INVALID', sanitizeAutonomyText(errMsg), null);
          this.store.recordManagerAttempt(validatedContext.work_order.task_id, resource.id, contextSha, 'CONTRACT_INVALID');
          continue;
        }
      }
    }

    return {
      resource_id: attempts.at(-1) ?? 'none',
      context_sha: contextSha,
      attempts,
      run: {
        status: 'QUOTA_OR_RATE_LIMIT',
        exitCode: 1,
        executionId: '',
        stdout: '',
        stderr: 'ALL_MANAGER_RESOURCES_UNAVAILABLE',
        durationMs: 0,
      },
    };
  }

  async reviewStored(contextSha: string, currentHead: string): Promise<ManagerPoolResult> {
    const evidence = this.store.getManagerContext(contextSha);
    if (!evidence) throw new Error('MANAGER_CONTEXT_NOT_FOUND');
    const context = ManagerContextPackageSchema.parse(JSON.parse(evidence));
    if (context.current_head !== currentHead) throw new Error('STALE_MANAGER_CONTEXT_HEAD');
    return this.review(context);
  }

  async plan(seed: ManagerPlanSeed): Promise<ManagerPlanResult> {
    const planInput = {
      protocol_version: 'workorder.v1' as const,
      task_id: seed.task_id,
      worker_id: seed.worker_id,
      base_sha: seed.base_sha,
      branch: seed.branch,
      worktree: seed.worktree,
      objective: seed.objective,
      acceptance_criteria: seed.acceptance_criteria,
      issue_number: null,
      dependencies: [],
      allowed_paths: seed.allowed_paths ?? [],
      forbidden_paths: seed.forbidden_paths ?? ['.git', 'main', 'D:/Projects/Agent-Forge'],
      required_tests: seed.required_tests ?? [],
      context_files: [],
      constraints: seed.constraints ?? [],
      attempt: 1,
      lease_epoch: 1,
    };
    const validatedPlan = ManagerPlanContextSchema.parse(planInput);
    const planJson = JSON.stringify(validatedPlan);
    const planSha = crypto.createHash('sha256').update(planJson).digest('hex');
    this.store.recordManagerContext(planSha, planJson);
    const attempts: string[] = [];
    const candidates = [...this.resources].filter((r) => r.enabled).sort((a, b) => b.priority - a.priority);

    for (const resource of candidates) {
      const health = this.store.getManagerResourceHealth(resource.id);
      const productHealth = this.checkProductResourceHealth(resource.id);
      if (!productHealth.configured && !isEligible(health?.state, health?.cooldown_until)) continue;
      if (!productHealth.eligible) continue;
      if (!resource.plan) continue;

      attempts.push(resource.id);
      this.store.recordManagerAttempt(seed.task_id, resource.id, planSha, 'STARTED');

      let result: { run: ProviderRun; workOrder?: WorkOrder };
      try {
        result = await resource.plan(seed);
      } catch (error) {
        result = {
          run: {
            status: 'CONTRACT_INVALID',
            exitCode: 1,
            executionId: '',
            stdout: '',
            stderr: sanitizeAutonomyText(error instanceof Error ? error.message : String(error)),
            durationMs: 0,
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }

      if (result.run.status === 'SUCCESSFUL_PROCESS_EXIT' && !result.workOrder) {
        result = {
          run: {
            ...result.run,
            status: 'CONTRACT_INVALID',
            error: 'CONTRACT_INVALID: successful manager process returned no WorkOrder',
          },
        };
      }
      const classified = classify(result.run);
      this.recordResourceHealth(
        resource.id,
        classified.state,
        sanitizeAutonomyText(result.run.stderr || result.run.error || ''),
        classified.cooldownUntil,
      );

      if (result.workOrder) {
        try {
          const workOrder = WorkOrderSchema.parse(result.workOrder);
          for (const [key, value] of Object.entries(validatedPlan)) {
            if (JSON.stringify(workOrder[key as keyof WorkOrder]) !== JSON.stringify(value)) {
              throw new Error(`CONTRACT_INVALID: manager changed immutable planning field ${key}`);
            }
          }
          this.store.recordManagerAttempt(seed.task_id, resource.id, planSha, 'PLANNED');
          return { ...result, workOrder, resource_id: resource.id, context_sha: planSha, attempts };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.recordResourceHealth(resource.id, 'CONTRACT_INVALID', sanitizeAutonomyText(errMsg), null);
          this.store.recordManagerAttempt(seed.task_id, resource.id, planSha, 'CONTRACT_INVALID');
          continue;
        }
      }

      this.store.recordManagerAttempt(seed.task_id, resource.id, planSha, classified.state);
    }

    return {
      resource_id: attempts.at(-1) ?? 'none',
      context_sha: planSha,
      attempts,
      run: {
        status: 'QUOTA_OR_RATE_LIMIT',
        exitCode: 1,
        executionId: '',
        stdout: '',
        stderr: 'ALL_MANAGER_RESOURCES_UNAVAILABLE',
        durationMs: 0,
      },
    };
  }

  async planStored(planSha: string, expectedBaseSha?: string): Promise<ManagerPlanResult> {
    const payload = this.store.getManagerContext(planSha);
    if (!payload) throw new Error('MANAGER_PLAN_CONTEXT_NOT_FOUND');
    const parsed = ManagerPlanContextSchema.parse(JSON.parse(payload));
    if (expectedBaseSha && parsed.base_sha !== expectedBaseSha) {
      throw new Error('STALE_MANAGER_PLAN_BASE_SHA');
    }
    return this.plan(parsed);
  }
}

async function openAiApiReview(input: ManagerEvidence): Promise<{ run: ProviderRun; review?: ManagerReview }> {
  const started = Date.now();
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { run: { status: 'PROCESS_NOT_FOUND', exitCode: 1, executionId: '', stdout: '', stderr: 'OPENAI_API_KEY_NOT_CONFIGURED', durationMs: 0 } };
  try {
    const response = await fetch(process.env.OPENAI_API_BASE_URL ?? 'https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: process.env.CODEX_MANAGER_API_MODEL ?? 'gpt-4.1-mini',
        input: `Return exactly one managerreview.v1 JSON object. A PASS requires reviewed_head_sha equal to current evidence HEAD.\n${JSON.stringify(input)}`,
        max_output_tokens: 4000,
      }),
    });
    const body = await response.text();
    const run: ProviderRun = {
      status: response.ok ? 'SUCCESSFUL_PROCESS_EXIT' : 'FAILED_PROCESS_EXIT',
      exitCode: response.ok ? 0 : response.status,
      executionId: '',
      stdout: sanitizeAutonomyText(body),
      stderr: response.ok ? '' : sanitizeAutonomyText(body),
      durationMs: Date.now() - started,
    };
    if (!response.ok) return { run };
    const parsed = JSON.parse(body) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    const text = parsed.output_text ?? parsed.output?.flatMap((item) => item.content ?? []).map((part) => part.text ?? '').join('') ?? '';
    return { run, review: ManagerReviewSchema.parse(parseManagerReview(text)) };
  } catch (error) {
    return {
      run: {
        status: 'CONTRACT_INVALID',
        exitCode: 1,
        executionId: '',
        stdout: '',
        stderr: sanitizeAutonomyText(String(error)),
        durationMs: Date.now() - started,
      },
    };
  }
}

async function openAiApiPlan(seed: ManagerPlanSeed): Promise<{ run: ProviderRun; workOrder?: WorkOrder }> {
  const started = Date.now();
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { run: { status: 'PROCESS_NOT_FOUND', exitCode: 1, executionId: '', stdout: '', stderr: 'OPENAI_API_KEY_NOT_CONFIGURED', durationMs: 0 } };
  try {
    const response = await fetch(process.env.OPENAI_API_BASE_URL ?? 'https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: process.env.CODEX_MANAGER_API_MODEL ?? 'gpt-4.1-mini',
        input: `You are a deterministic Agent Forge manager. Return exactly one workorder.v1 JSON object preserving every seeded identity and path.\n${JSON.stringify({
          protocol_version: 'workorder.v1',
          ...seed,
          issue_number: null,
          dependencies: [],
          allowed_paths: seed.allowed_paths ?? [],
          forbidden_paths: seed.forbidden_paths ?? ['.git', 'main', 'D:/Projects/Agent-Forge'],
          required_tests: seed.required_tests ?? [],
          context_files: [],
          constraints: seed.constraints ?? [],
          attempt: 1,
          lease_epoch: 1,
        })}`,
        max_output_tokens: 4000,
      }),
    });
    const body = await response.text();
    const run: ProviderRun = {
      status: response.ok ? 'SUCCESSFUL_PROCESS_EXIT' : 'FAILED_PROCESS_EXIT',
      exitCode: response.ok ? 0 : response.status,
      executionId: '',
      stdout: sanitizeAutonomyText(body),
      stderr: response.ok ? '' : sanitizeAutonomyText(body),
      durationMs: Date.now() - started,
    };
    if (!response.ok) return { run };
    const parsed = JSON.parse(body) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    const text = parsed.output_text ?? parsed.output?.flatMap((item) => item.content ?? []).map((part) => part.text ?? '').join('') ?? '';
    const workOrder = parseWorkOrder(text);
    for (const [key, value] of Object.entries(seed)) {
      if (JSON.stringify(workOrder[key as keyof WorkOrder]) !== JSON.stringify(value)) {
        throw new Error(`CONTRACT_INVALID: manager changed authorized ${key}`);
      }
    }
    return { run, workOrder };
  } catch (error) {
    return {
      run: {
        status: 'CONTRACT_INVALID',
        exitCode: 1,
        executionId: '',
        stdout: '',
        stderr: sanitizeAutonomyText(String(error)),
        durationMs: Date.now() - started,
      },
    };
  }
}
