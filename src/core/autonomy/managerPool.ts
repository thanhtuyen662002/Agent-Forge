import crypto from 'crypto';
import { ManagerReview, ManagerReviewSchema, WorkOrder, parseManagerReview, sanitizeAutonomyText } from './contracts';
import { AutonomyStore, ManagerResourceState } from './store';
import { CodexManagerAdapter, ManagerEvidence, ProviderRun } from './providers';

export interface ManagerContextPackage {
  protocol_version: 'managercontext.v1'; task_identity: { task_id: string; attempt: number; worker_id: string };
  work_order: WorkOrder; acceptance_criteria: string[]; base_sha: string; current_head: string;
  actual_diff: string; changed_files: string[]; deterministic_tests: unknown[]; previous_manager_decisions: unknown[];
  repair_history: unknown[]; pr_state: unknown; ci_state: unknown; architecture_policy_context: string[];
}

export interface ManagerResource {
  id: string; priority: number; enabled: boolean;
  review(input: ManagerEvidence): Promise<{ run: ProviderRun; review?: ManagerReview }>;
}

export interface ManagerPoolResult { run: ProviderRun; review?: ManagerReview; resource_id: string; context_sha: string; attempts: string[]; }

function classify(run: ProviderRun): { state: ManagerResourceState; cooldownUntil: string | null } {
  const text = `${run.stdout}\n${run.stderr}\n${run.error ?? ''}`;
  if (run.status === 'SUCCESSFUL_PROCESS_EXIT') return { state: 'AVAILABLE', cooldownUntil: null };
  if (/out of credits|workspace.*credit|credits.*exhausted/i.test(text)) return { state: 'CREDITS_EXHAUSTED', cooldownUntil: null };
  if (/rate.?limit|too many requests|\b429\b/i.test(text)) return { state: 'RATE_LIMITED', cooldownUntil: new Date(Date.now() + 60_000).toISOString() };
  if (/auth|not logged|unauthorized|invalid token/i.test(text)) return { state: 'AUTH_ERROR', cooldownUntil: null };
  if (run.status === 'CONTRACT_INVALID') return { state: 'CONTRACT_INVALID', cooldownUntil: null };
  if (run.status === 'PROCESS_NOT_FOUND' || run.status === 'TIMEOUT') return { state: 'OFFLINE', cooldownUntil: new Date(Date.now() + 60_000).toISOString() };
  return { state: 'OFFLINE', cooldownUntil: new Date(Date.now() + 60_000).toISOString() };
}

function isEligible(state: ManagerResourceState | undefined, until: string | null | undefined): boolean {
  if (!state || state === 'AVAILABLE') return true;
  if (state === 'RATE_LIMITED' || state === 'COOLDOWN') return !!until && Date.parse(until) <= Date.now();
  return false;
}

export class ManagerProviderPool {
  constructor(private readonly store: AutonomyStore, private readonly resources: ManagerResource[]) {
    // Recover known capacity failures from earlier singleton manager attempts.
    // This prevents a restart from immediately retrying an exhausted resource.
    for (const resource of resources) {
      if (this.store.getManagerResourceHealth(resource.id)) continue;
      const prior = this.store.getDatabase().prepare("SELECT stderr,stdout FROM autonomy_runs WHERE provider IN ('codex-review','codex-ci-review') ORDER BY started_at DESC LIMIT 20").all() as Array<{ stderr: string; stdout: string }>;
      if (prior.some((run) => /out of credits|workspace.*credit|credits.*exhausted/i.test(`${run.stdout}\n${run.stderr}`))) {
        this.store.recordManagerResource(resource.id, 'CREDITS_EXHAUSTED', 'Recovered from durable manager run evidence');
      }
    }
  }

  static fromPrimary(store: AutonomyStore, primary: CodexManagerAdapter): ManagerProviderPool {
    return new ManagerProviderPool(store, [{ id: 'codex-chatgpt-primary', priority: 100, enabled: true, review: (input) => primary.review(input) }]);
  }

  static fromEnvironment(store: AutonomyStore, primary: CodexManagerAdapter): ManagerProviderPool {
    const resources: ManagerResource[] = [{ id: 'codex-chatgpt-primary', priority: 100, enabled: true, review: (input) => primary.review(input) }];
    if (process.env.AGENT_FORGE_ENABLE_OPENAI_API_FALLBACK === '1') {
      resources.push({ id: 'codex-api-fallback', priority: 50, enabled: true, review: (input) => openAiApiReview(input) });
    }
    return new ManagerProviderPool(store, resources);
  }

  async review(context: ManagerContextPackage): Promise<ManagerPoolResult> {
    const evidence = JSON.stringify(context);
    const contextSha = crypto.createHash('sha256').update(evidence).digest('hex');
    const attempts: string[] = [];
    const candidates = [...this.resources].filter((r) => r.enabled).sort((a, b) => b.priority - a.priority);
    for (const resource of candidates) {
      const health = this.store.getManagerResourceHealth(resource.id);
      if (!isEligible(health?.state, health?.cooldown_until)) continue;
      attempts.push(resource.id);
      this.store.recordManagerAttempt(context.work_order.task_id, resource.id, contextSha, 'STARTED');
      const result = await resource.review({ workOrder: context.work_order, evidence });
      const classified = classify(result.run);
      this.store.recordManagerResource(resource.id, classified.state, sanitizeAutonomyText(result.run.stderr || result.run.error || ''), classified.cooldownUntil);
      this.store.recordManagerAttempt(context.work_order.task_id, resource.id, contextSha, result.review ? 'REVIEWED' : classified.state);
      if (result.review) {
        const review = ManagerReviewSchema.parse(result.review);
        if (review.reviewed_head_sha !== context.current_head) return { ...result, review: { ...review, verdict: 'REPAIR' }, resource_id: resource.id, context_sha: contextSha, attempts };
        return { ...result, review, resource_id: resource.id, context_sha: contextSha, attempts };
      }
    }
    return { resource_id: attempts.at(-1) ?? 'none', context_sha: contextSha, attempts, run: { status: 'QUOTA_OR_RATE_LIMIT', exitCode: 1, executionId: '', stdout: '', stderr: 'ALL_MANAGER_RESOURCES_UNAVAILABLE', durationMs: 0 } };
  }
}

async function openAiApiReview(input: ManagerEvidence): Promise<{ run: ProviderRun; review?: ManagerReview }> {
  const started = Date.now();
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { run: { status: 'PROCESS_NOT_FOUND', exitCode: 1, executionId: '', stdout: '', stderr: 'OPENAI_API_KEY_NOT_CONFIGURED', durationMs: 0 } };
  try {
    const response = await fetch(process.env.OPENAI_API_BASE_URL ?? 'https://api.openai.com/v1/responses', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.CODEX_MANAGER_API_MODEL ?? 'gpt-4.1-mini', input: `Return exactly one managerreview.v1 JSON object. A PASS requires reviewed_head_sha equal to current evidence HEAD.\n${JSON.stringify(input)}`, max_output_tokens: 4000 }),
    });
    const body = await response.text();
    const run: ProviderRun = { status: response.ok ? 'SUCCESSFUL_PROCESS_EXIT' : 'FAILED_PROCESS_EXIT', exitCode: response.ok ? 0 : response.status, executionId: '', stdout: sanitizeAutonomyText(body), stderr: response.ok ? '' : sanitizeAutonomyText(body), durationMs: Date.now() - started };
    if (!response.ok) return { run };
    const parsed = JSON.parse(body) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    const text = parsed.output_text ?? parsed.output?.flatMap((item) => item.content ?? []).map((part) => part.text ?? '').join('') ?? '';
    return { run, review: ManagerReviewSchema.parse(parseManagerReview(text)) };
  } catch (error) {
    return { run: { status: 'CONTRACT_INVALID', exitCode: 1, executionId: '', stdout: '', stderr: sanitizeAutonomyText(String(error)), durationMs: Date.now() - started } };
  }
}
