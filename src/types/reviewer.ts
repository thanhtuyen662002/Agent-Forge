import { z } from 'zod';

export const REVIEWER_TOKEN_PREFIX = 'af-rev-';
export const REVIEWER_TOKEN_SCOPE = 'AUTHORIZED_REVIEW_READ';
export const REVIEWER_TOKEN_SCOPE_ALIAS = 'REVIEWER_CONTEXT_READ';

export type ReviewerTokenScope = 'AUTHORIZED_REVIEW_READ' | 'REVIEWER_CONTEXT_READ';

export const REVIEWER_TOKEN_ENV = 'AGENTFORGE_MCP_REVIEWER_TOKEN';
export const SINGLE_MCP_TOOL = 'agentforge_get_review_package';
export const RESOURCE_TEMPLATE = 'agentforge://reviews/packages/{adjudication_id}';
export const RESOURCE_MIME_TYPE = 'application/vnd.agentforge.review-package+json';

export const DIFF_CONTENT_MAX_UTF8_BYTES = 32768;
export const PROJECTION_PAYLOAD_MAX_UTF8_BYTES = 524288;
export const MARKDOWN_MAX_UTF8_BYTES = 524288;

export const SESSION_DURATION_MIN_SECONDS = 60;
export const SESSION_DURATION_MAX_SECONDS = 86400;
export const SESSION_DURATION_DEFAULT_SECONDS = 3600;

export interface McpReviewerSession {
  id: string;
  adjudication_id: string;
  submission_id: string;
  reviewer_agent_id: string;
  reviewer_provider_id: string;
  reviewer_account_id: string;
  reviewer_resource_id: string;
  scope: string;
  token_hash: string;
  task_ownership_epoch: number;
  authority_snapshot_hash: string;
  verification_result_envelope_hash: string;
  projection_schema: number;
  projection_hash: string;
  projection_json: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
}

export interface ReviewerSessionIssuanceInput {
  adjudication_id: string;
  reviewer_agent_id: string;
  reviewer_provider_id: string;
  reviewer_account_id: string;
  reviewer_resource_id: string;
  duration_seconds?: number;
}

export interface ReviewerSessionIssuanceResult {
  session: McpReviewerSession;
  raw_token: string;
}

export interface ReviewerAuthorityFenceState {
  adjudication_status: string;
  adjudication_recovery_fenced_at: string | null;
  current_authority_snapshot_hash: string;
  current_task_ownership_epoch: number;
}

export interface SafeReviewerSessionMetadata {
  id: string;
  adjudication_id: string;
  submission_id: string;
  reviewer_agent_id: string;
  reviewer_provider_id: string;
  reviewer_account_id: string;
  reviewer_resource_id: string;
  scope: string;
  task_ownership_epoch: number;
  projection_schema: number;
  projection_hash: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
  is_active: boolean;
}

export const ReviewerSessionToolInputSchema = z.object({
  adjudication_id: z.string().uuid(),
}).strict();

export type ReviewerSessionToolInput = z.infer<typeof ReviewerSessionToolInputSchema>;
