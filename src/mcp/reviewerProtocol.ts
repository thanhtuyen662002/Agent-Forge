import {
  SINGLE_MCP_TOOL,
  RESOURCE_TEMPLATE,
  RESOURCE_MIME_TYPE,
  REVIEWER_TOKEN_ENV,
} from '../types/reviewer';
import { ReviewerAuthorityService, scrubReviewerDiagnostics, ReviewerAuthorityError } from './reviewerAuthority';

export const REVIEWER_SERVER_NAME = 'agentforge-review';
export const REVIEWER_SERVER_VERSION = '0.1.0';

export const REVIEWER_TOOL_NAME = SINGLE_MCP_TOOL;
export const REVIEWER_TOOL_DESCRIPTION =
  'Returns the complete, frozen review-package projection already immutably bound to the reviewer session.';

export const REVIEWER_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

export const REVIEWER_TOOL_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    adjudication_id: {
      type: 'string',
      description: 'The UUID of the verified adjudication review package to retrieve.',
    },
  },
  required: ['adjudication_id'],
  additionalProperties: false,
});

export const REVIEWER_RESOURCE_NAME = 'Review Package';
export const REVIEWER_RESOURCE_DESCRIPTION = 'Frozen verified adjudication review package projection.';
export const REVIEWER_URI_TEMPLATE = RESOURCE_TEMPLATE;
export const REVIEWER_MIME_TYPE = RESOURCE_MIME_TYPE;

export const FORBIDDEN_TOOL_NAMES = new Set([
  'get_review_context',
  'get_task_evidence',
  'get_verification_details',
  'get_diff_summary',
  'update_task',
  'assign_task',
  'transition_task',
  'git_commit',
  'git_push',
  'git_apply',
  'submit_verdict',
  'approve_review',
  'adjudicate',
]);

export interface ReviewerToolCallParams {
  adjudication_id: string;
  [key: string]: unknown;
}

export function validateReviewerToolArgs(args: unknown): { adjudication_id: string } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ReviewerAuthorityError('InvalidParams', 'Tool arguments must be a non-null plain object');
  }

  const obj = args as Record<string, unknown>;
  const keys = Object.keys(obj);

  // Reject additional properties fail-closed
  const extraKeys = keys.filter((k) => k !== 'adjudication_id');
  if (extraKeys.length > 0) {
    throw new ReviewerAuthorityError('InvalidParams', `Unexpected property: ${extraKeys.join(', ')}`);
  }

  if (typeof obj.adjudication_id !== 'string' || obj.adjudication_id.trim().length === 0) {
    throw new ReviewerAuthorityError('InvalidParams', 'adjudication_id is required and must be a non-empty string');
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(obj.adjudication_id.trim())) {
    throw new ReviewerAuthorityError('InvalidParams', 'adjudication_id must be a valid UUID');
  }

  return { adjudication_id: obj.adjudication_id.trim() };
}

export function validateReviewerResourceUri(uriString: string): string {
  if (typeof uriString !== 'string' || uriString.trim().length === 0) {
    throw new ReviewerAuthorityError('InvalidParams', 'Resource URI must be a non-empty string');
  }

  // Strictly match agentforge://reviews/packages/{uuid} without query params or extra path segments
  const match = uriString.trim().match(/^agentforge:\/\/reviews\/packages\/([0-9a-f-]{36})$/i);
  if (!match) {
    throw new ReviewerAuthorityError('InvalidParams', `Resource URI ${uriString} does not match template agentforge://reviews/packages/{adjudication_id}`);
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(match[1])) {
    throw new ReviewerAuthorityError('InvalidParams', `Resource URI contains invalid UUID: ${match[1]}`);
  }

  return match[1];
}
