import { z } from 'zod';
import { CoderSubmission } from '../database/repositories';
import { ExecutionAuthorization, Task, Project, TaskAttempt, AgentAssignment } from './domain';

// ==========================================
// 1. Core Adjudication Actions & Statuses
// ==========================================

export const AdjudicationActionEnum = z.enum([
  'ADMIT_VERIFICATION',
  'REJECT',
  'SUPERSEDE',
]);
export type AdjudicationAction = z.infer<typeof AdjudicationActionEnum>;

export const AdjudicationStatusEnum = z.enum([
  'ADMITTED',
  'VERIFYING',
  'VERIFIED',
  'VERIFICATION_FAILED',
  'RECOVERY_FENCED',
  'REJECTED',
  'SUPERSEDED',
]);
export type AdjudicationStatus = z.infer<typeof AdjudicationStatusEnum>;

export const AdjudicationEventTypeEnum = z.enum([
  'ADMITTED',
  'VERIFICATION_CLAIMED',
  'VERIFICATION_SUCCEEDED',
  'VERIFICATION_FAILED',
  'RECOVERY_FENCED',
  'REJECTED',
  'SUPERSEDED',
]);
export type AdjudicationEventType = z.infer<typeof AdjudicationEventTypeEnum>;

export const AdjudicationActorTypeEnum = z.enum(['OPERATOR', 'SYSTEM']);
export type AdjudicationActorType = z.infer<typeof AdjudicationActorTypeEnum>;

export const AdjudicationFailureCodeEnum = z.enum([
  'PROCESS_START_FAILED',
  'VERIFICATION_TIMEOUT',
  'TESTS_FAILED',
  'POLICY_VIOLATION',
  'WORKTREE_DRIFT',
  'EVIDENCE_CAPTURE_FAILED',
  'ORPHANED_VERIFICATION_INTERRUPTED',
  'PRECONDITION_FAILED',
  'INTEGRITY_MISMATCH',
  'COMMAND_CONFIG_MISSING',
]);
export type AdjudicationFailureCode = z.infer<typeof AdjudicationFailureCodeEnum>;

export const RecoveryClassificationEnum = z.enum([
  'PRE_VERIFICATION_NOT_STARTED',
  'VERIFICATION_IN_FLIGHT_UNRESOLVED',
  'VERIFICATION_RESULT_STATE_INCOMPLETE',
  'ALREADY_RECONCILED',
  'AUTHORITY_CONFLICT',
]);
export type RecoveryClassification = z.infer<typeof RecoveryClassificationEnum>;

// ==========================================
// 2. Database Models
// ==========================================

export interface CoderSubmissionAdjudication {
  id: string;
  request_id: string;
  submission_id: string;
  authorization_id: string;
  project_id: string;
  task_id: string;
  attempt_id: string;
  assignment_id: string;
  task_ownership_epoch: number;
  action: AdjudicationAction;
  status: AdjudicationStatus;
  lifecycle_version: number;
  authority_snapshot_json: string;
  authority_snapshot_hash: string;
  verification_commands_json: string | null;
  verification_commands_hash: string | null;
  workspace_snapshot_before_json: string | null;
  workspace_snapshot_before_hash: string | null;
  verification_execution_id: string | null;
  protocol_message_id: string | null;
  test_run_id: string | null;
  git_status_evidence_id: string | null;
  git_diff_evidence_id: string | null;
  failure_code: string | null;
  failure_json: string | null;
  created_at: string;
  verification_started_at: string | null;
  completed_at: string | null;
  recovery_fenced_at: string | null;
}

export interface CoderSubmissionAdjudicationEvent {
  id: string;
  adjudication_id: string;
  sequence: number;
  event_type: AdjudicationEventType;
  payload_json: string;
  payload_hash: string;
  created_at: string;
}

// ==========================================
// 3. Authority Snapshot Keys & Contract
// ==========================================

export const AUTHORITY_SNAPSHOT_KEYS = [
  'assignment_id',
  'assignment_status',
  'attempt_id',
  'attempt_number',
  'attempt_status',
  'authorization_canonical_payload_hash',
  'authorization_id',
  'authorization_lifecycle_version',
  'authorization_status',
  'authorized_repository_head_sha',
  'canonical_envelope_hash',
  'claim_content_hash',
  'current_terminal_disposition',
  'execution_id',
  'manager_protocol_message_id',
  'manager_raw_payload_hash',
  'project_id',
  'project_repository_path',
  'project_status',
  'quarantine_status',
  'routing_decision_id',
  'selected_account_id',
  'selected_provider_id',
  'selected_resource_id',
  'submission_base_sha',
  'submission_id',
  'submission_repository_head_sha',
  'submitted_at',
  'task_base_sha',
  'task_id',
  'task_ownership_epoch',
  'task_state',
  'worker_slot_id',
] as const;

export type AuthoritySnapshotKey = (typeof AUTHORITY_SNAPSHOT_KEYS)[number];

export interface CanonicalAuthoritySnapshot {
  assignment_id: string;
  assignment_status: string;
  attempt_id: string;
  attempt_number: number;
  attempt_status: string;
  authorization_canonical_payload_hash: string;
  authorization_id: string;
  authorization_lifecycle_version: number;
  authorization_status: string;
  authorized_repository_head_sha: string;
  canonical_envelope_hash: string;
  claim_content_hash: string;
  current_terminal_disposition: string | null;
  execution_id: string;
  manager_protocol_message_id: string;
  manager_raw_payload_hash: string;
  project_id: string;
  project_repository_path: string;
  project_status: string;
  quarantine_status: 'QUARANTINED';
  routing_decision_id: string;
  selected_account_id: string | null;
  selected_provider_id: string;
  selected_resource_id: string;
  submission_base_sha: string;
  submission_id: string;
  submission_repository_head_sha: string;
  submitted_at: string;
  task_base_sha: string;
  task_id: string;
  task_ownership_epoch: number;
  task_state: string;
  worker_slot_id: string | null;
}

// ==========================================
// 4. Summaries & Detailed Inspection
// ==========================================

export interface QuarantinedSubmissionSummary {
  id: string;
  authorization_id: string;
  project_id: string;
  task_id: string;
  task_ownership_epoch: number;
  task_revision: number;
  claimed_status: string;
  quarantine_status: 'QUARANTINED';
  summary: string;
  changed_files_count: number;
  tests_claimed_count: number;
  blockers_count: number;
  review_requested: boolean;
  claim_content_hash: string;
  canonical_envelope_hash: string;
  submitted_at: string;
  integrity_status: 'VALID' | 'FENCED_INTEGRITY_CONFLICT';
  integrity_fenced_reasons: string[];
  latest_disposition_event: string | null;
  latest_disposition_reason: string | null;
  active_adjudication: {
    id: string;
    action: AdjudicationAction;
    status: AdjudicationStatus;
    lifecycle_version: number;
    created_at: string;
    verification_execution_id: string | null;
  } | null;
}

export interface QuarantinedSubmissionInspection {
  submission: CoderSubmission;
  candidate?: CoderSubmission;
  authority_snapshot?: CanonicalAuthoritySnapshot | null;
  claim_content: {
    summary: string;
    status: string;
    changed_files: string[];
    tests_claimed: string[];
    blockers: string[];
    review_requested: boolean;
    client_metadata: Record<string, unknown>;
  };
  canonical_envelope: Record<string, unknown>;
  integrity: {
    valid: boolean;
    claim_content_hash_matches: boolean;
    canonical_envelope_hash_matches: boolean;
    fenced_reasons: string[];
  };
  dispositions: Array<{
    id: string;
    disposition_event: string;
    disposition_reason: string;
    actor_type: string;
    actor_id: string;
    created_at: string;
    disposition_metadata: Record<string, unknown> | null;
  }>;
  adjudications: Array<{
    id: string;
    request_id: string;
    action: AdjudicationAction;
    status: AdjudicationStatus;
    lifecycle_version: number;
    created_at: string;
    verification_started_at: string | null;
    completed_at: string | null;
    recovery_fenced_at: string | null;
    failure_code: string | null;
    test_run_id: string | null;
    git_status_evidence_id: string | null;
    git_diff_evidence_id: string | null;
  }>;
}

// ==========================================
// 5. Error Codes and Classes
// ==========================================

export const AdjudicationErrorCodeEnum = z.enum([
  'NOT_FOUND',
  'INTEGRITY_CONFLICT',
  'PRECONDITION_FENCED',
  'STATUS_CONFLICT',
  'REQUEST_ID_CONFLICT',
  'WORKTREE_DRIFT',
  'COMMAND_SNAPSHOT_INVALID',
  'VERIFICATION_IN_FLIGHT',
  'RECOVERY_FENCED',
  'INTERNAL_ERROR',
]);
export type AdjudicationErrorCode = z.infer<typeof AdjudicationErrorCodeEnum>;

export class CoderSubmissionAdjudicationError extends Error {
  constructor(
    public readonly code: AdjudicationErrorCode,
    message: string,
    public readonly retryable: boolean = false,
    public readonly details?: Record<string, unknown>
  ) {
    super(`[${code}] ${message}`);
    this.name = 'CoderSubmissionAdjudicationError';
  }
}

// ==========================================
// 6. Recovery Scanner Types
// ==========================================

export interface AdjudicationRecoveryScanItemResult {
  adjudication_id: string;
  submission_id: string;
  classification: RecoveryClassification;
  action_taken: 'KEPT_ADMITTED' | 'FENCED' | 'SETTLED' | 'NO_OP' | 'FENCED_CONFLICT';
  task_transition?: string | null;
  error?: string | null;
}

export interface AdjudicationRecoveryScanReport {
  scannedCount: number;
  preVerificationNotStartedCount: number;
  verificationInFlightUnresolvedCount: number;
  verificationResultStateIncompleteCount: number;
  alreadyReconciledCount: number;
  authorityConflictCount: number;
  fencedCount: number;
  settledCount: number;
  items: AdjudicationRecoveryScanItemResult[];
  scannedAt: string;
}
