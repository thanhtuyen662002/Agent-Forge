import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { canonicalizePortableRelativePath } from '../context/ContextIntegrity';
import { PolicyService } from '../services/PolicyService';
import { PlanProtocolSchema, type PlanProtocol } from '../types/protocols';
import type { ProjectContract } from '../types/domain';
import { MAX_PROTOCOL_INPUT_BYTES, isWithinByteLimit } from './limits';
import { ProtocolParser } from './parser';

export type PlanParseResult =
  | { success: true; data: PlanProtocol }
  | { success: false; reasonCode: 'PLAN_OUTPUT_MISSING' | 'PLAN_OUTPUT_TOO_LARGE' | 'PLAN_PROTOCOL_INVALID' };

/**
 * Extracts and validates a plan.v1 task breakdown (#245). Kept apart from
 * ProtocolParser so the manual protocol inbox never accepts a plan. Anything
 * malformed creates nothing.
 */
export function parsePlanProtocol(raw: string | null | undefined): PlanParseResult {
  if (typeof raw !== 'string' || raw.trim().length === 0) return { success: false, reasonCode: 'PLAN_OUTPUT_MISSING' };
  if (!isWithinByteLimit(raw, MAX_PROTOCOL_INPUT_BYTES)) return { success: false, reasonCode: 'PLAN_OUTPUT_TOO_LARGE' };
  const json = ProtocolParser.extractJsonString(raw);
  if (!json) return { success: false, reasonCode: 'PLAN_OUTPUT_MISSING' };
  try {
    const parsed = PlanProtocolSchema.safeParse(JSON.parse(json));
    return parsed.success ? { success: true, data: parsed.data } : { success: false, reasonCode: 'PLAN_PROTOCOL_INVALID' };
  } catch {
    return { success: false, reasonCode: 'PLAN_PROTOCOL_INVALID' };
  }
}

/** SHA-256 of a contract in a key-order independent form, so a plan is bound to exactly what it planned. */
export function contractSha256(contract: ProjectContract): string {
  const canonical = (value: unknown): unknown => Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
      : value;
  return crypto.createHash('sha256').update(JSON.stringify(canonical(contract))).digest('hex');
}

export const MAX_TASK_CONTEXT_PATHS = 32;

export type ContextPathCheck =
  | { ok: true; paths: string[] }
  | { ok: false; reasonCode: 'CONTEXT_PATH_INVALID' | 'CONTEXT_PATH_MISSING' | 'CONTEXT_PATH_DENIED' | 'CONTEXT_PATH_LINK' | 'CONTEXT_LIMIT_EXCEEDED'; path: string };

/**
 * Validates task-scoped coder context (#254): each path is a canonical
 * portable relative path inside the repository, exists, is not a link, and is
 * allowed by policy (sensitive names, .git and agent configuration are
 * denied). Duplicates are folded; at most 32 paths.
 * With `skipMissing`, a path that does not exist yet (a file or directory the
 * coder will create, found in trial 7) is dropped instead of failing the check;
 * every containment, link and policy rejection stays.
 */
export function validateContextPaths(repositoryRoot: string, paths: readonly string[], options: { skipMissing?: boolean } = {}): ContextPathCheck {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    let relative: string;
    try { relative = canonicalizePortableRelativePath(raw); } catch { return { ok: false, reasonCode: 'CONTEXT_PATH_INVALID', path: String(raw) }; }
    const key = relative.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > MAX_TASK_CONTEXT_PATHS) return { ok: false, reasonCode: 'CONTEXT_LIMIT_EXCEEDED', path: relative };
    const absolute = path.resolve(repositoryRoot, relative);
    const inside = path.relative(repositoryRoot, absolute);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return { ok: false, reasonCode: 'CONTEXT_PATH_INVALID', path: relative };
    // Every component must be a real file or directory; a link could leave the repository.
    let current = repositoryRoot;
    let missing = false;
    for (const part of inside.split(/[\\/]/)) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current, { throwIfNoEntry: false });
      if (!stat) {
        if (!options.skipMissing) return { ok: false, reasonCode: 'CONTEXT_PATH_MISSING', path: relative };
        missing = true;
        break;
      }
      if (stat.isSymbolicLink()) return { ok: false, reasonCode: 'CONTEXT_PATH_LINK', path: relative };
    }
    if (missing) {
      // Not created yet: only the name can be judged, and a sensitive one is still refused.
      if (!PolicyService.evaluatePathAccess(absolute, repositoryRoot, false).allowed) return { ok: false, reasonCode: 'CONTEXT_PATH_DENIED', path: relative };
      continue;
    }
    if (!PolicyService.evaluateRealPathAccess(absolute, repositoryRoot, false).allowed) return { ok: false, reasonCode: 'CONTEXT_PATH_DENIED', path: relative };
    result.push(relative);
  }
  return { ok: true, paths: result };
}
