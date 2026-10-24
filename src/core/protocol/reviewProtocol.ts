import { ReviewProtocolSchema, type ReviewProtocol } from '../types/protocols';
import { MAX_PROTOCOL_INPUT_BYTES, isWithinByteLimit } from './limits';
import { ProtocolParser } from './parser';

export type ReviewParseResult =
  | { success: true; data: ReviewProtocol }
  | { success: false; reasonCode: 'REVIEW_OUTPUT_MISSING' | 'REVIEW_OUTPUT_TOO_LARGE' | 'REVIEW_PROTOCOL_INVALID' };

/**
 * Extracts and validates a review.v1 verdict from reviewer output. Kept apart
 * from ProtocolParser so the manual protocol inbox never accepts a review
 * verdict. Anything malformed is a failure, never a PASS.
 */
export function parseReviewProtocol(raw: string | null | undefined): ReviewParseResult {
  if (typeof raw !== 'string' || raw.trim().length === 0) return { success: false, reasonCode: 'REVIEW_OUTPUT_MISSING' };
  if (!isWithinByteLimit(raw, MAX_PROTOCOL_INPUT_BYTES)) return { success: false, reasonCode: 'REVIEW_OUTPUT_TOO_LARGE' };
  const json = ProtocolParser.extractJsonString(raw);
  if (!json) return { success: false, reasonCode: 'REVIEW_OUTPUT_MISSING' };
  try {
    const parsed = ReviewProtocolSchema.safeParse(JSON.parse(json));
    return parsed.success ? { success: true, data: parsed.data } : { success: false, reasonCode: 'REVIEW_PROTOCOL_INVALID' };
  } catch {
    return { success: false, reasonCode: 'REVIEW_PROTOCOL_INVALID' };
  }
}
