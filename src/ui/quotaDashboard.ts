import type { QuotaObservation, QuotaWindowObservation } from '../core/types/quota';
import type { Agent, ProviderResource } from '../core/types/domain';

export type QuotaTone = 'GOOD' | 'WARN' | 'LOW' | 'UNKNOWN';
export type QuotaWindowKind = 'FIVE_HOUR' | 'DAY' | 'WEEK' | 'MINUTES' | 'LIMIT';
export type CliKind = 'CODEX' | 'CLAUDE' | 'GEMINI' | 'ANTIGRAVITY' | 'OTHER';

export interface QuotaWindowView {
  kind: QuotaWindowKind;
  /** A model bucket's name (Gemini), shown instead of the window kind. */
  label: string | null;
  windowMinutes: number | null;
  remainingPercent: number | null;
  tone: QuotaTone;
  resetsAt: string | null;
}

export interface QuotaCardView {
  accountId: string;
  cli: CliKind;
  agentNames: string[];
  models: string[];
  plan: string | null;
  status: QuotaObservation['status'];
  source: QuotaObservation['source'];
  healthStatus: string | null;
  usable: boolean;
  windows: QuotaWindowView[];
  observedAt: string;
}

export interface QuotaGroupView {
  cli: CliKind;
  usable: number;
  total: number;
  cards: QuotaCardView[];
}

const CLI_BY_PROVIDER: Record<string, CliKind> = {
  'prov-codex-cli': 'CODEX',
  'prov-claude-code-cli': 'CLAUDE',
  'prov-gemini-cli': 'GEMINI',
  'prov-antigravity-cli': 'ANTIGRAVITY',
};
const CLI_ORDER: CliKind[] = ['CODEX', 'CLAUDE', 'GEMINI', 'ANTIGRAVITY', 'OTHER'];
const USABLE_HEALTH = new Set(['AVAILABLE', 'LOW_QUOTA']);

/** Router-style thresholds: more than half left is fine, under a fifth is low. */
export function toneFor(remainingPercent: number | null): QuotaTone {
  if (remainingPercent === null || !Number.isFinite(remainingPercent)) return 'UNKNOWN';
  if (remainingPercent > 50) return 'GOOD';
  if (remainingPercent >= 20) return 'WARN';
  return 'LOW';
}

export function windowKind(windowMinutes: number | null): QuotaWindowKind {
  if (windowMinutes === null) return 'LIMIT';
  if (windowMinutes === 300) return 'FIVE_HOUR';
  if (windowMinutes === 1440) return 'DAY';
  if (windowMinutes === 10080) return 'WEEK';
  return 'MINUTES';
}

/** Time until a reset, or null when unknown or already past. */
export function countdown(resetsAt: string | null, now: number): { days: number; hours: number; minutes: number } | null {
  if (!resetsAt) return null;
  const ms = Date.parse(resetsAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const totalMinutes = Math.ceil(ms / 60_000);
  return { days: Math.floor(totalMinutes / 1440), hours: Math.floor((totalMinutes % 1440) / 60), minutes: totalMinutes % 60 };
}

const toWindow = (window: QuotaWindowObservation & { label?: string }): QuotaWindowView => ({
  kind: windowKind(window.windowMinutes), label: window.label ?? null, windowMinutes: window.windowMinutes, remainingPercent: window.remainingPercent,
  tone: toneFor(window.remainingPercent), resetsAt: window.resetsAt,
});

/**
 * One card per account, grouped by CLI, with only what the observation says:
 * provider-reported windows, an observed limit, or nothing. An account counts
 * as usable only when its recorded health allows scheduling and no observed
 * limit is still running.
 */
export function buildQuotaGroups(observations: QuotaObservation[], resources: ProviderResource[], agents: Agent[], now: number): QuotaGroupView[] {
  const cards: QuotaCardView[] = observations.map((observation) => {
    const bound = new Set(observation.resourceIds);
    const accountResources = resources.filter((resource) => bound.has(resource.id) || resource.provider_account_id === observation.accountId);
    const resourceIds = new Set(accountResources.map((resource) => resource.id));
    const windows: QuotaWindowView[] = [];
    const bucketed = observation.status === 'OK' && !!observation.buckets?.length;
    if (bucketed) {
      windows.push(...observation.buckets!.map(toWindow));
    } else if (observation.status === 'OK') {
      windows.push(toWindow(observation));
      if (observation.secondary) windows.push(toWindow(observation.secondary));
    }
    // Windows exist only for OK readings, whatever their source. An exhausted
    // window blocks use; per-model buckets block only when every model is out.
    const exhausted = bucketed
      ? windows.every((window) => window.remainingPercent === 0)
      : windows.some((window) => window.remainingPercent === 0);
    return {
      accountId: observation.accountId,
      cli: CLI_BY_PROVIDER[observation.providerId] ?? 'OTHER',
      agentNames: agents.filter((agent) => agent.provider_resource_id && resourceIds.has(agent.provider_resource_id)).map((agent) => agent.display_name),
      models: [...new Set(accountResources.map((resource) => resource.model_name).filter(Boolean))],
      plan: observation.planType,
      status: observation.status,
      source: observation.source,
      healthStatus: observation.healthStatus,
      usable: !!observation.healthStatus && USABLE_HEALTH.has(observation.healthStatus) && !exhausted,
      windows,
      observedAt: observation.observedAt,
    };
  });
  return CLI_ORDER
    .map((cli) => {
      const group = cards.filter((card) => card.cli === cli);
      return { cli, usable: group.filter((card) => card.usable).length, total: group.length, cards: group };
    })
    .filter((group) => group.total > 0);
}
