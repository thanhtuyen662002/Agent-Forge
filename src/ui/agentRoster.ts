import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent } from '../core/types/domain';
import type {
  ManagedAgent,
  AgentConnectionKind,
  AgentManagementErrorCode,
  AgentRosterEntry,
  AgentWorkBlocker,
  AgentWorkBlockerCode,
} from '../core/types/workspace';

export type AgentMutationFailureCode = AgentManagementErrorCode | 'DESKTOP_REQUIRED' | 'INVALID_RESPONSE';
export type AgentMutationResult =
  | { success: true; agent: ManagedAgent }
  | { success: false; code: AgentMutationFailureCode; blockers: AgentWorkBlocker[] };
type AgentMutationFailure = Extract<AgentMutationResult, { success: false }>;
/** Outcome of permanently deleting a removed agent (#344); no agent row survives it. */
export type AgentPurgeOutcome =
  | { success: true; agentId: string }
  | { success: false; code: AgentMutationFailureCode; blockers: AgentWorkBlocker[] };

export interface CreateAgentInput {
  displayName: string;
  role: Agent['role'];
  connection: AgentConnectionKind;
  modelName: string;
  profileId?: string;
  workerSlots: number;
  instructions?: string | null;
}

export interface UpdateAgentInput {
  agentId: string;
  displayName?: string;
  modelName?: string;
  instructions?: string | null;
}

const ROLES = new Set(['PRIMARY_MANAGER', 'BACKUP_MANAGER', 'CODER', 'REVIEWER', 'TOOL']);
const CONNECTIONS = new Set(['MANUAL_BRIDGE', 'CODEX_CLI', 'GEMINI_CLI', 'CLAUDE_CODE_CLI', 'ANTIGRAVITY_CLI', 'OTHER']);
const ERROR_CODES = new Set<AgentManagementErrorCode>([
  'INVALID_INPUT', 'AGENT_NOT_FOUND', 'AGENT_ALREADY_REMOVED', 'AGENT_NOT_REMOVED',
  'AGENT_HAS_ACTIVE_WORK', 'AGENT_HAS_AUDIT_LEDGER', 'PROFILE_ALREADY_IN_USE', 'INTERNAL_ERROR',
]);
const BLOCKER_CODES = new Set<AgentWorkBlockerCode>([
  'CURRENT_TASK', 'AGENT_BUSY', 'REVIEWER_SESSION', 'ACTIVE_ASSIGNMENT',
  'PENDING_AUTHORIZATION', 'IN_FLIGHT_EXECUTION', 'BUSY_WORKER_SLOT', 'ACTIVE_ACCOUNT_LEASE',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

function isAgent(value: unknown): value is Agent {
  return isRecord(value) && isText(value.id) && isText(value.display_name) && typeof value.role === 'string' && ROLES.has(value.role);
}

function parseBlockers(value: unknown): AgentWorkBlocker[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) return null;
  const blockers: AgentWorkBlocker[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.code !== 'string' || !BLOCKER_CODES.has(item.code as AgentWorkBlockerCode) || !isText(item.reference)) return null;
    blockers.push({ code: item.code as AgentWorkBlockerCode, reference: item.reference });
  }
  return blockers;
}

/** A mutation is only confirmed by an explicit success envelope carrying the persisted agent. */
export function normalizeAgentMutationReply(reply: unknown): AgentMutationResult {
  const invalid: AgentMutationResult = { success: false, code: 'INVALID_RESPONSE', blockers: [] };
  try {
    if (!isRecord(reply)) return invalid;
    if (reply.success === true) return isAgent(reply.agent) ? { success: true, agent: reply.agent } : invalid;
    if (reply.success === false && typeof reply.errorCode === 'string' && ERROR_CODES.has(reply.errorCode as AgentManagementErrorCode)) {
      const blockers = parseBlockers(reply.blockers);
      return blockers ? { success: false, code: reply.errorCode as AgentManagementErrorCode, blockers } : invalid;
    }
    return invalid;
  } catch {
    return invalid;
  }
}

/** A permanent delete is only confirmed by a success envelope naming the exact agent. */
export function normalizeAgentPurgeReply(reply: unknown, agentId: string): AgentPurgeOutcome {
  const invalid: AgentPurgeOutcome = { success: false, code: 'INVALID_RESPONSE', blockers: [] };
  try {
    if (!isRecord(reply)) return invalid;
    if (reply.success === true) return reply.agentId === agentId ? { success: true, agentId } : invalid;
    const failure = normalizeAgentMutationReply(reply);
    return failure.success ? invalid : failure;
  } catch {
    return invalid;
  }
}

export function normalizeAgentRosterReply(reply: unknown): AgentRosterEntry[] | null {
  try {
    if (!Array.isArray(reply)) return null;
    for (const entry of reply) {
      if (!isRecord(entry) || !isAgent(entry.agent) || typeof entry.connection !== 'string' || !CONNECTIONS.has(entry.connection)) return null;
      if (!Array.isArray(entry.workerSlots) || parseBlockers(entry.blockers) === null) return null;
    }
    return reply as AgentRosterEntry[];
  } catch {
    return null;
  }
}

/**
 * Agent Center read model and mutations. Pending state is locked synchronously
 * so a double click cannot submit twice before React re-renders.
 */
export function useAgentRoster(includeRemoved: boolean, afterMutation: () => Promise<void>) {
  const api = typeof window !== 'undefined' ? (window as any).orchestrator ?? null : null;
  const [entries, setEntries] = useState<AgentRosterEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const requestRef = useRef(0);

  const reload = useCallback(async () => {
    if (!api?.getAgentRoster) return;
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const roster = normalizeAgentRosterReply(await api.getAgentRoster({ includeRemoved }));
      if (requestId !== requestRef.current) return;
      if (roster) {
        setEntries(roster);
        setLoadFailed(false);
      } else {
        setLoadFailed(true);
      }
    } catch {
      if (requestId === requestRef.current) setLoadFailed(true);
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [api, includeRemoved]);

  useEffect(() => { void reload(); }, [reload]);

  const mutateWith = useCallback(async <S extends { success: true }>(
    invoke: () => Promise<unknown>,
    normalize: (reply: unknown) => S | AgentMutationFailure,
  ): Promise<S | AgentMutationFailure> => {
    if (!api) return { success: false, code: 'DESKTOP_REQUIRED', blockers: [] };
    if (pendingRef.current) return { success: false, code: 'INTERNAL_ERROR', blockers: [] };
    pendingRef.current = true;
    setPending(true);
    try {
      let result: S | AgentMutationFailure;
      try {
        result = normalize(await invoke());
      } catch {
        result = { success: false, code: 'INVALID_RESPONSE', blockers: [] };
      }
      // Refresh after both outcomes: a rejection may mean the roster changed elsewhere.
      await reload();
      if (result.success) {
        try { await afterMutation(); } catch { /* refresh errors have their own UI channel */ }
      }
      return result;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, [api, reload, afterMutation]);
  const mutate = useCallback(
    (invoke: () => Promise<unknown>) => mutateWith(invoke, normalizeAgentMutationReply),
    [mutateWith],
  );

  return {
    available: Boolean(api?.getAgentRoster),
    entries,
    loading,
    loadFailed,
    pending,
    reload,
    createAgent: (input: CreateAgentInput) => mutate(() => api.createAgent(input)),
    updateAgent: (input: UpdateAgentInput) => mutate(() => api.updateAgent(input)),
    removeAgent: (agentId: string) => mutate(() => api.removeAgent(agentId)),
    restoreAgent: (agentId: string) => mutate(() => api.restoreAgent(agentId)),
    purgeAgent: (agentId: string) => mutateWith(() => api.purgeAgent(agentId), (reply) => normalizeAgentPurgeReply(reply, agentId)),
  };
}
