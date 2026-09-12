import { z } from 'zod';
import { CoderSubmission } from '../database/repositories';
import { ExecutionAuthorization, Task, Project, TaskAttempt, AgentAssignment, TestRun } from './domain';

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
  'TEST_FAILED',
  'TESTS_FAILED',
  'TEST_TIMEOUT',
  'VERIFICATION_TIMEOUT',
  'COMMAND_POLICY_REJECTED',
  'POLICY_VIOLATION',
  'WORKTREE_DRIFT',
  'EVIDENCE_CAPTURE_FAILED',
  'ORPHANED_VERIFICATION_INTERRUPTED',
  'ORPHANED_VERIFICATION_CANCELLED',
  'PRECONDITION_FAILED',
  'INTEGRITY_MISMATCH',
  'COMMAND_CONFIG_MISSING',
  'RECOVERY_FENCED',
  'RECOVERY_ACKNOWLEDGED',
  'POST_COMMIT_FINALIZATION_UNCERTAINTY',
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
  verification_result_envelope_json?: string | null;
  verification_result_envelope_hash?: string | null;
  artifact_manifest_json?: string | null;
  artifact_manifest_hash?: string | null;
  workspace_lease_id?: string | null;
  resolution_action?: 'ACKNOWLEDGE' | 'CANCEL' | null;
  resolution_timestamp?: string | null;
  resolution_evidence_json?: string | null;
  resolution_evidence_hash?: string | null;
  resolver_id?: string | null;
}

export const CANONICAL_VERIFICATION_RESULT_ENVELOPE_KEYS = [
  'adjudication_id',
  'artifact_manifest_hash',
  'assignment_id',
  'attempt_id',
  'authorization_id',
  'command_snapshot_hash',
  'exit_classification',
  'failure_code',
  'failure_payload',
  'finish_timestamp',
  'git_diff_evidence_hash',
  'git_diff_evidence_id',
  'git_status_evidence_hash',
  'git_status_evidence_id',
  'lifecycle_version',
  'process_start_classification',
  'project_id',
  'start_timestamp',
  'task_id',
  'task_ownership_epoch',
  'termination_classification',
  'test_result_evidence_hash',
  'test_result_evidence_id',
  'test_run_id',
  'verification_execution_id',
  'workspace_snapshot_after_evidence_id',
  'workspace_snapshot_after_hash',
  'workspace_snapshot_before_hash',
] as const;

export type CanonicalVerificationResultEnvelopeKey = (typeof CANONICAL_VERIFICATION_RESULT_ENVELOPE_KEYS)[number];

export interface CanonicalVerificationResultEnvelope {
  adjudication_id: string;
  artifact_manifest_hash: string;
  assignment_id: string;
  attempt_id: string;
  authorization_id: string;
  command_snapshot_hash: string;
  exit_classification: 'EXIT_ZERO' | 'EXIT_NONZERO' | 'TIMEOUT' | 'CANCELLED' | 'UNKNOWN';
  failure_code: string | null;
  failure_payload: Record<string, unknown> | null;
  finish_timestamp: string;
  git_diff_evidence_hash: string;
  git_diff_evidence_id: string;
  git_status_evidence_hash: string;
  git_status_evidence_id: string;
  lifecycle_version: number;
  process_start_classification: 'SPAWNED_PROVEN' | 'LAUNCH_FAILED_PROVEN' | 'NOT_STARTED_PROVEN' | 'LAUNCH_AMBIGUOUS';
  project_id: string;
  start_timestamp: string;
  task_id: string;
  task_ownership_epoch: number;
  termination_classification: 'TERMINATION_PROVEN' | 'TERMINATION_AMBIGUOUS' | 'NOT_APPLICABLE';
  test_result_evidence_hash: string;
  test_result_evidence_id: string;
  test_run_id: string;
  verification_execution_id: string;
  workspace_snapshot_after_evidence_id: string;
  workspace_snapshot_after_hash: string;
  workspace_snapshot_before_hash: string;
}

export interface StagedEvidenceFile {
  id: string;
  project_id: string;
  task_id: string;
  attempt_id: string | null;
  evidence_type: 'TEST_RESULT' | 'GIT_STATUS' | 'GIT_DIFF' | 'FILE_SNAPSHOT';
  summary: string;
  content_type: string;
  hash: string;
  byte_size: number;
  storage_type: 'INLINE' | 'FILE';
  staged_file_path: string | null;
  final_file_path: string | null;
  raw_payload: string | null;
}

export const CANONICAL_WORKSPACE_SNAPSHOT_AFTER_KEYS = [
  'adjudication_id',
  'assignment_id',
  'attempt_id',
  'authorization_id',
  'captured_at',
  'captured_repository_head_sha',
  'git_diff_evidence_hash',
  'git_status_evidence_hash',
  'project_id',
  'schema_version',
  'task_id',
  'task_ownership_epoch',
  'verification_execution_id',
] as const;

export type CanonicalWorkspaceSnapshotAfterKey = (typeof CANONICAL_WORKSPACE_SNAPSHOT_AFTER_KEYS)[number];

export interface CanonicalWorkspaceSnapshotAfterPayload {
  adjudication_id: string;
  assignment_id: string;
  attempt_id: string | null;
  authorization_id: string;
  captured_at: string;
  captured_repository_head_sha: string;
  git_diff_evidence_hash: string;
  git_status_evidence_hash: string;
  project_id: string;
  schema_version: 1;
  task_id: string;
  task_ownership_epoch: number;
  verification_execution_id: string;
}

export interface StagingManifest {
  manifest_id: string;
  adjudication_id: string;
  execution_id: string;
  created_at: string;
  entries: StagedEvidenceFile[];
  manifest_hash: string;
}

export type WorkspaceLeaseState = 'ACQUIRED' | 'VERIFYING' | 'RELEASED' | 'FENCED';

export interface CoderSubmissionWorkspaceLease {
  id: string;
  adjudication_id: string;
  worktree_identity_hash: string;
  admitted_workspace_fingerprint_hash: string;
  pre_execution_fingerprint_hash: string | null;
  claim_nonce: string;
  execution_id: string;
  lease_owner_identity: string;
  assignment_id: string;
  authorization_id: string;
  acquired_at: string;
  released_at: string | null;
  lifecycle_version: number;
  state: WorkspaceLeaseState;
  failure_code: string | null;
  failure_evidence_hash: string | null;
}

export interface ArtifactManifestEntry {
  evidence_id: string;
  evidence_type: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  storage_class: 'INLINE' | 'FILE';
  relative_path: string;
}

export const ARTIFACT_MANIFEST_ENTRY_KEYS = [
  'byte_size',
  'content_type',
  'evidence_id',
  'evidence_type',
  'relative_path',
  'sha256',
  'storage_class',
] as const;

export interface ArtifactManifest {
  manifest_schema_version: 1;
  adjudication_id: string;
  lifecycle_version: number;
  verification_execution_id: string;
  entries: ArtifactManifestEntry[];
}

export const ARTIFACT_MANIFEST_KEYS = [
  'adjudication_id',
  'entries',
  'lifecycle_version',
  'manifest_schema_version',
  'verification_execution_id',
] as const;

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
  integrity_status?: string;
  integrity_fenced_reasons?: string[];
  untrusted_claim?: {
    summary?: string;
    files_claimed_changed?: string[];
    tests_claimed?: string[];
    blockers?: string[];
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

// ==========================================
// 7. Workspace Fingerprint & Sealed Verification
// ==========================================

export interface CanonicalWorkspaceFingerprint {
  head_sha: string;
  status_lines: string[];
  status_hash: string;
  diff_hash: string;
  untracked_files_hash: string;
  fingerprint_hash: string;
  isClean?: boolean;
  branch?: string | null;
}

export interface SealedVerificationExecutionInput {
  adjudication_id: string;
  lifecycle_version: number;
  verification_execution_id: string;
  authorization_id: string;
  project_id: string;
  task_id: string;
  attempt_id: string;
  assignment_id: string;
  repo_path: string;
  verification_commands_json: string;
  verification_commands_hash: string;
  workspace_snapshot_before_json: string;
  workspace_snapshot_before_hash: string;
  policy: {
    timeout_ms: number;
    max_stdout_bytes: number;
    max_stderr_bytes: number;
    allowed_env_keys: string[];
  };
}

export interface ParsedTestMetrics {
  passedCount: number;
  failedCount: number;
  skippedCount: number;
}

export type SealedVerificationResult =
  | {
      outcome: 'SUCCESS';
      test_run: TestRun;
      metrics: ParsedTestMetrics;
      stdout: string;
      stderr: string;
      duration_ms: number;
    }
  | {
      outcome: 'TEST_FAILED';
      test_run: TestRun;
      metrics: ParsedTestMetrics;
      stdout: string;
      stderr: string;
      duration_ms: number;
      exit_code: number;
    }
  | {
      outcome: 'TEST_TIMEOUT';
      test_run: TestRun;
      duration_ms: number;
    }
  | {
      outcome: 'COMMAND_POLICY_REJECTED';
      reason: string;
    }
  | {
      outcome: 'PROCESS_START_FAILED';
      error: string;
    }
  | {
      outcome: 'RECOVERY_FENCED';
      failure_code: 'ORPHANED_VERIFICATION_INTERRUPTED' | 'EVIDENCE_CAPTURE_FAILED' | 'INTEGRITY_MISMATCH';
      error: string;
    };

export interface VerificationExecutionObservation {
  outcome: 'SUCCESS' | 'TEST_FAILED' | 'TEST_TIMEOUT' | 'COMMAND_POLICY_REJECTED' | 'PROCESS_START_FAILED' | 'RECOVERY_FENCED';
  failure_code?: string | null;
  reason?: string;
  error?: string;
  command: string;
  repo_path: string;
  started_at: string;
  finished_at: string;
  exit_code: number;
  duration_ms: number;
  stdout: string;
  stderr: string;
  stdout_bytes: number;
  stderr_bytes: number;
  combined_output: string;
  metrics: ParsedTestMetrics;
  process_start: 'NOT_STARTED_PROVEN' | 'STARTED_PROVEN' | 'START_AMBIGUOUS';
  process_termination: 'NOT_APPLICABLE' | 'PROCESS_TREE_TERMINATED_PROVEN' | 'TERMINATION_UNRESOLVED';
  timed_out: boolean;
  cancelled: boolean;
  scrubbed_diagnostic_code?: string;
}

export interface VerifiedAdjudicationReviewProjection {
  adjudication_id: string;
  submission_id: string;
  project_id: string;
  project_name: string;
  task_id: string;
  task_title: string;
  task_priority: string;
  task_risk: string;
  task_revision_count: number;
  task_max_revisions: number;
  task_base_sha: string;
  task_working_sha: string;
  acceptance_criteria: string[];
  previous_issues: Array<{ severity: string; title: string; file_path?: string; description: string }>;
  untrusted_claim: {
    summary: string;
    completed: string[];
    files_claimed_changed: string[];
    tests_claimed: string[];
    blockers: string[];
    claim_content_hash: string;
  };
  authoritative_verification: {
    test_run_id: string | null;
    command: string | null;
    command_snapshot_hash: string | null;
    exit_code: number | null;
    passed_count: number;
    failed_count: number;
    skipped_count: number;
    duration_ms: number;
    test_result_evidence_id: string | null;
    test_result_evidence_hash: string | null;
    verdict: 'PASSED' | 'FAILED' | 'TIMEOUT' | 'FENCED' | 'NOT_RUN';
  };
  authoritative_git_status: {
    evidence_id: string | null;
    evidence_hash: string | null;
    storage_type: 'INLINE' | 'FILE';
    is_clean: boolean;
    branch?: string | null;
    summary: string;
  } | null;
  authoritative_git_diff: {
    evidence_id: string | null;
    evidence_hash: string | null;
    storage_type: 'INLINE' | 'FILE';
    byte_size: number;
    diff_content: string;
    is_truncated: boolean;
    files_changed_count?: number;
  } | null;
  recovery_fencing_state: {
    is_fenced: boolean;
    status: AdjudicationStatus;
    failure_code: string | null;
    recovery_fenced_at: string | null;
    resolution_action: string | null;
  } | null;
  operator_disposition: {
    disposition_event: string | null;
    disposition_reason: string | null;
    decided_at: string | null;
  } | null;
  projection_hash: string;
}

export const VERIFIED_ADJUDICATION_REVIEW_PROJECTION_KEYS = [
  'acceptance_criteria',
  'adjudication_id',
  'authoritative_git_diff',
  'authoritative_git_status',
  'authoritative_verification',
  'operator_disposition',
  'previous_issues',
  'project_id',
  'project_name',
  'projection_hash',
  'recovery_fencing_state',
  'submission_id',
  'task_base_sha',
  'task_id',
  'task_max_revisions',
  'task_priority',
  'task_revision_count',
  'task_risk',
  'task_title',
  'task_working_sha',
  'untrusted_claim',
] as const;

export type SubmissionAuthorityIntegrityResult =
  | {
      valid: true;
      claim_content_hash_matches: true;
      canonical_envelope_hash_matches: true;
      parsed_claim: Record<string, unknown>;
      parsed_envelope: Record<string, unknown>;
      fenced_reasons: [];
    }
  | {
      valid: false;
      claim_content_hash_matches: boolean;
      canonical_envelope_hash_matches: boolean;
      parsed_claim: Record<string, unknown> | null;
      parsed_envelope: Record<string, unknown> | null;
      fenced_reasons: string[];
    };
