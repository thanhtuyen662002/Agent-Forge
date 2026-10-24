import { useCallback, useEffect, useRef, useState } from 'react';
import type { TrashBlocker, TrashBlockerCode, TrashErrorCode, TrashListing } from '../core/types/workspace';

export type TrashFailureCode = TrashErrorCode | 'DESKTOP_REQUIRED' | 'INVALID_RESPONSE';
export type TrashActionResult =
  | { success: true; entityType: 'PROJECT' | 'TASK'; entityId: string; invalidatedAuthorizations: number }
  | { success: false; code: TrashFailureCode; blockers: TrashBlocker[] };

const ERROR_CODES = new Set<TrashErrorCode>([
  'INVALID_INPUT', 'PROJECT_NOT_FOUND', 'TASK_NOT_FOUND', 'ALREADY_IN_TRASH',
  'NOT_IN_TRASH', 'PROJECT_IN_TRASH', 'HAS_ACTIVE_WORK', 'INTERNAL_ERROR',
]);
const BLOCKER_CODES = new Set<TrashBlockerCode>([
  'PROJECT_RUNNING', 'TASK_ACTIVE_STATE', 'ACTIVE_TASK_LEASE', 'ACTIVE_ASSIGNMENT', 'IN_FLIGHT_EXECUTION', 'AGENT_ASSIGNED',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

function parseBlockers(value: unknown): TrashBlocker[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1024) return null;
  const blockers: TrashBlocker[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.code !== 'string' || !BLOCKER_CODES.has(item.code as TrashBlockerCode) || !isText(item.reference)) return null;
    if (item.taskId !== undefined && !isText(item.taskId)) return null;
    blockers.push({ code: item.code as TrashBlockerCode, reference: item.reference, ...(item.taskId ? { taskId: item.taskId as string } : {}) });
  }
  return blockers;
}

/** A trash change is confirmed only by an explicit success envelope naming the exact entity. */
export function normalizeTrashReply(reply: unknown, entityType: 'PROJECT' | 'TASK', entityId: string): TrashActionResult {
  const invalid: TrashActionResult = { success: false, code: 'INVALID_RESPONSE', blockers: [] };
  try {
    if (!isRecord(reply)) return invalid;
    if (reply.success === true) {
      if (reply.entityType !== entityType || reply.entityId !== entityId) return invalid;
      const count = reply.invalidatedAuthorizations;
      if (!Number.isSafeInteger(count) || (count as number) < 0) return invalid;
      return { success: true, entityType, entityId, invalidatedAuthorizations: count as number };
    }
    if (reply.success === false && typeof reply.errorCode === 'string' && ERROR_CODES.has(reply.errorCode as TrashErrorCode)) {
      const blockers = parseBlockers(reply.blockers);
      return blockers ? { success: false, code: reply.errorCode as TrashErrorCode, blockers } : invalid;
    }
    return invalid;
  } catch {
    return invalid;
  }
}

export function normalizeTrashListing(reply: unknown): TrashListing | null {
  try {
    if (!isRecord(reply) || !Array.isArray(reply.projects) || !Array.isArray(reply.tasks)) return null;
    for (const project of reply.projects) {
      if (!isRecord(project) || !isText(project.id) || typeof project.name !== 'string' || !isText(project.trashedAt)) return null;
    }
    for (const task of reply.tasks) {
      if (!isRecord(task) || !isText(task.id) || typeof task.title !== 'string' || !isText(task.projectId) || !isText(task.trashedAt)) return null;
    }
    return reply as unknown as TrashListing;
  } catch {
    return null;
  }
}

/** Case- and accent-insensitive match, so "lap trinh" finds "Lập trình". */
export function matchesSearch(query: string, ...fields: Array<string | null | undefined>): boolean {
  const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
  const needle = fold(query.trim());
  if (!needle) return true;
  return fields.some((field) => typeof field === 'string' && fold(field).includes(needle));
}

export function useWorkspaceTrash(afterMutation: () => Promise<void>) {
  const api = typeof window !== 'undefined' ? (window as any).orchestrator ?? null : null;
  const [listing, setListing] = useState<TrashListing>({ projects: [], tasks: [] });
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const requestRef = useRef(0);

  const reload = useCallback(async () => {
    if (!api?.getTrash) return;
    const requestId = ++requestRef.current;
    try {
      const next = normalizeTrashListing(await api.getTrash());
      if (requestId !== requestRef.current) return;
      if (next) { setListing(next); setLoadFailed(false); } else setLoadFailed(true);
    } catch {
      if (requestId === requestRef.current) setLoadFailed(true);
    }
  }, [api]);

  useEffect(() => { void reload(); }, [reload]);

  const mutate = useCallback(async (entityType: 'PROJECT' | 'TASK', entityId: string, invoke: () => Promise<unknown>): Promise<TrashActionResult> => {
    if (!api) return { success: false, code: 'DESKTOP_REQUIRED', blockers: [] };
    if (pendingRef.current) return { success: false, code: 'INTERNAL_ERROR', blockers: [] };
    pendingRef.current = true;
    setPending(true);
    try {
      let result: TrashActionResult;
      try {
        result = normalizeTrashReply(await invoke(), entityType, entityId);
      } catch {
        result = { success: false, code: 'INVALID_RESPONSE', blockers: [] };
      }
      await reload();
      // Refresh active lists after any outcome so a stale selection is reconciled.
      try { await afterMutation(); } catch { /* refresh errors have their own UI channel */ }
      return result;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, [api, reload, afterMutation]);

  return {
    available: Boolean(api?.getTrash),
    listing,
    loadFailed,
    pending,
    reload,
    trashProject: (projectId: string) => mutate('PROJECT', projectId, () => api.trashProject(projectId)),
    restoreProject: (projectId: string) => mutate('PROJECT', projectId, () => api.restoreProject(projectId)),
    trashTask: (taskId: string) => mutate('TASK', taskId, () => api.trashTask(taskId)),
    restoreTask: (taskId: string) => mutate('TASK', taskId, () => api.restoreTask(taskId)),
  };
}
