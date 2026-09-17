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

export interface ReviewerAuthorityLiveValidationParams {
  sessionId?: string;
  adjudicationId: string;
  reviewerAgentId: string;
  reviewerProviderId: string;
  reviewerAccountId: string;
  reviewerResourceId: string;
}

export interface ReviewerAuthorityLiveValidationResult {
  adjudication_exists: boolean;
  adjudication_id: string | null;
  adjudication_action: string | null;
  adjudication_status: string | null;
  adjudication_recovery_fenced_at: string | null;
  current_authority_snapshot_hash: string | null;
  task_exists: boolean;
  task_id: string | null;
  task_state: string | null;
  current_task_ownership_epoch: number | null;
  agent_exists: boolean;
  agent_role: string | null;
  agent_status: string | null;
  agent_resource_id: string | null;
  provider_exists: boolean;
  provider_enabled: boolean | null;
  account_exists: boolean;
  account_provider_id: string | null;
  account_enabled: boolean | null;
  account_health_status: string | null;
  resource_exists: boolean;
  resource_provider_id: string | null;
  resource_account_id: string | null;
  resource_enabled: boolean | null;
  resource_health_status: string | null;
  coder_agent_id: string | null;
  coder_selected_account_id: string | null;
  submission_id: string | null;
  project_id: string | null;
  test_run_id: string | null;
  verification_result_envelope_hash: string | null;
  verification_result_envelope_json: string | null;
}

export interface ReviewerAuthorityReadOptions {
  /**
   * Deterministic test-only hook executed immediately after the first SELECT
   * (which establishes the SQLite WAL read snapshot) and prior to live-state evaluation.
   */
  _testAfterFirstSelectHook?: () => void;
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

export const StrictFrozenProjectionSchema = z.object({
  projection_schema_version: z.literal(1),
  adjudication: z.object({
    id: z.string().uuid(),
    request_id: z.string().min(1).max(256),
    submission_id: z.string().uuid(),
    project_id: z.string().min(1).max(256),
    project_name: z.string().min(1).max(256),
    task_id: z.string().min(1).max(256),
    task_title: z.string().min(1).max(1024),
    task_ownership_epoch: z.number().int().nonnegative(),
    action: z.literal('ADMIT_VERIFICATION'),
    status: z.literal('VERIFIED'),
  }).strict(),
  verification_results: z.object({
    test_run_id: z.string().min(1).max(256),
    exit_code: z.literal(0),
    passed_count: z.number().int().nonnegative().optional(),
    failed_count: z.number().int().nonnegative().optional().refine((c) => c === undefined || c === 0, {
      message: 'failed_count must be 0 for verified-admission contract',
    }),
    skipped_count: z.number().int().nonnegative().optional(),
    duration_ms: z.number().int().nonnegative().optional(),
    envelope: z.record(z.unknown()).refine((obj) => obj !== null && typeof obj === 'object' && !Array.isArray(obj), {
      message: 'envelope must be a non-null plain object',
    }),
  }).strict(),
  evidence: z.object({
    git_status: z.object({
      is_clean: z.boolean(),
      branch: z.string().max(256).nullable(),
      files: z.array(
        z.string().min(1).max(4096).refine((filePath) => {
          const normalized = filePath.replace(/\\/g, '/');
          if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(filePath)) return false;
          const segments = normalized.split('/');
          if (segments.some((s) => s === '..' || s === '.' || s === '')) return false;
          return true;
        }, { message: 'file path must be safe repository-relative path without directory traversal or absolute prefixes' })
      ).max(10000),
    }).strict(),
    git_diff: z.object({
      diff_content: z.string().max(DIFF_CONTENT_MAX_UTF8_BYTES),
      byte_size: z.number().int().nonnegative().max(DIFF_CONTENT_MAX_UTF8_BYTES),
      is_truncated: z.boolean(),
    }).strict().refine((gd) => Buffer.byteLength(gd.diff_content, 'utf8') === gd.byte_size, {
      message: 'git_diff.byte_size must equal UTF-8 byte length of diff_content',
    }).refine((gd) => {
      if (gd.is_truncated && gd.byte_size < DIFF_CONTENT_MAX_UTF8_BYTES - 16) {
        return false;
      }
      return true;
    }, { message: 'git_diff.is_truncated is inconsistent with byte_size' }),
  }).strict(),
  disposition: z.object({
    disposition_event: z.literal('SETTLED'),
    disposition_reason: z.literal('ACCEPTED_VERIFIED'),
    created_at: z.string().datetime(),
  }).strict(),
}).strict();

export type StrictFrozenProjection = z.infer<typeof StrictFrozenProjectionSchema>;
