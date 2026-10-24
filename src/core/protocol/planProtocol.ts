import crypto from 'crypto';
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
