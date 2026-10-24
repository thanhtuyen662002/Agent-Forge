import { useCallback, useEffect, useRef, useState } from 'react';
import type { AutomationPhase, DesktopAutomationStatus, ProjectAutomationStatus } from '../core/types/desktopAutomation';
import type { QuotaObservation } from '../core/types/quota';

const PHASES = new Set<AutomationPhase>([
  'PROJECT_NOT_RUNNING', 'WAITING_FOR_MANAGER', 'MANUAL_RELAY_REQUIRED', 'WAITING_FOR_CAPACITY',
  'QUEUED', 'EXECUTING', 'VERIFYING', 'AWAITING_REVIEW', 'FAILED',
]);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Accepts only a well-formed status envelope; anything else is "unknown", never "idle". */
export function normalizeAutomationStatus(reply: unknown): DesktopAutomationStatus | null {
  if (!isRecord(reply) || reply.success !== true || !isRecord(reply.status)) return null;
  const status = reply.status;
  if (typeof status.active !== 'boolean' || !Array.isArray(status.projects)) return null;
  const projects: ProjectAutomationStatus[] = [];
  for (const item of status.projects) {
    if (!isRecord(item) || typeof item.projectId !== 'string' || !PHASES.has(item.phase as AutomationPhase)) return null;
    projects.push({
      projectId: item.projectId,
      phase: item.phase as AutomationPhase,
      taskId: typeof item.taskId === 'string' ? item.taskId : null,
      reasonCode: typeof item.reasonCode === 'string' ? item.reasonCode : null,
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    });
  }
  return {
    active: status.active,
    maxConcurrentExecutions: Number(status.maxConcurrentExecutions) || 0,
    inFlight: Number(status.inFlight) || 0,
    projects,
  };
}

export function normalizeQuotaReply(reply: unknown): QuotaObservation[] | null {
  if (!isRecord(reply) || reply.success !== true || !Array.isArray(reply.observations)) return null;
  for (const item of reply.observations) {
    if (!isRecord(item) || typeof item.accountId !== 'string' || typeof item.status !== 'string') return null;
  }
  return reply.observations as QuotaObservation[];
}

/** Polls the desktop runtime status while mounted. */
export function useAutomationStatus(intervalMs = 10_000) {
  const api = typeof window !== 'undefined' ? (window as any).orchestrator ?? null : null;
  const [status, setStatus] = useState<DesktopAutomationStatus | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!api?.getAutomationStatus) return;
    try {
      const next = normalizeAutomationStatus(await api.getAutomationStatus());
      setStatus(next);
      setFailed(next === null);
    } catch {
      setStatus(null);
      setFailed(true);
    }
  }, [api]);

  useEffect(() => {
    if (!api?.getAutomationStatus) return undefined;
    void load();
    const handle = setInterval(() => { void load(); }, intervalMs);
    return () => clearInterval(handle);
  }, [api, load, intervalMs]);

  return { available: Boolean(api?.getAutomationStatus), status, failed, reload: load };
}

export function useQuotaObservations() {
  const api = typeof window !== 'undefined' ? (window as any).orchestrator ?? null : null;
  const [observations, setObservations] = useState<QuotaObservation[]>([]);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);

  const apply = (reply: unknown) => {
    const next = normalizeQuotaReply(reply);
    if (next) { setObservations(next); setFailed(false); } else setFailed(true);
  };

  useEffect(() => {
    if (!api?.getQuotaObservations) return;
    api.getQuotaObservations().then(apply).catch(() => setFailed(true));
  }, [api]);

  const refresh = useCallback(async (afterRefresh?: () => Promise<void>) => {
    if (!api?.refreshQuota || refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      apply(await api.refreshQuota());
      try { await afterRefresh?.(); } catch { /* refresh errors have their own UI channel */ }
    } catch {
      setFailed(true);
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [api]);

  return { available: Boolean(api?.refreshQuota), observations, failed, refreshing, refresh };
}
