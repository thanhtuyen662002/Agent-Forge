import { z } from 'zod';

// ==========================================
// 1. Core Enumerations & Status Unions
// ==========================================

export const ProjectStatusEnum = z.enum([
  'DRAFT',
  'PLANNING',
  'READY',
  'RUNNING',
  'PAUSED',
  'BLOCKED',
  'WAITING_FOR_CAPACITY',
  'WAITING_FOR_OWNER',
  'FINAL_REVIEW',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
]);
export type ProjectStatus = z.infer<typeof ProjectStatusEnum>;

export const TaskStateEnum = z.enum([
  'CREATED',
  'PLANNED',
  'APPROVED',
  'QUEUED',
  'DISPATCHED',
  'CODING',
  'VALIDATING',
  'REVIEW_READY',
  'REVIEWING',
  'PAUSED',
  'FIX_REQUIRED',
  'HANDOFF_REQUIRED',
  'WAITING_FOR_CAPACITY',
  'WAITING_FOR_AUTHORITY',
  'BLOCKED',
  'NEEDS_HUMAN',
  'DONE',
  'FAILED',
  'CANCELLED'
]);
export type TaskState = z.infer<typeof TaskStateEnum>;

export const TaskPausedFromStateEnum = z.enum([
  'DISPATCHED',
  'CODING',
  'VALIDATING',
  'REVIEWING'
]);
export type TaskPausedFromState = z.infer<typeof TaskPausedFromStateEnum>;

export const PriorityEnum = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type Priority = z.infer<typeof PriorityEnum>;

export const RiskLevelEnum = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type RiskLevel = z.infer<typeof RiskLevelEnum>;

export const AgentRoleEnum = z.enum([
  'PRIMARY_MANAGER',
  'BACKUP_MANAGER',
  'CODER',
  'REVIEWER',
  'TOOL'
]);
export type AgentRole = z.infer<typeof AgentRoleEnum>;

export const AgentStatusEnum = z.enum([
  'IDLE',
  'ACTIVE',
  'BUSY',
  'PAUSED',
  'OFFLINE'
]);
export type AgentStatus = z.infer<typeof AgentStatusEnum>;

export const ProviderAdapterTypeEnum = z.enum([
  'MANUAL_BRIDGE',
  'LOCAL_CLI',
  'API',
  'MOCK'
]);
export type ProviderAdapterType = z.infer<typeof ProviderAdapterTypeEnum>;

export const ProviderHealthStatusEnum = z.enum([
  'AVAILABLE',
  'BUSY',
  'LOW_QUOTA',
  'RATE_LIMITED',
  'QUOTA_EXHAUSTED',
  'AUTH_ERROR',
  'OFFLINE',
  'UNHEALTHY',
  'COOLDOWN',
  'DISABLED',
  'UNKNOWN'
]);
export type ProviderHealthStatus = z.infer<typeof ProviderHealthStatusEnum>;

export const CapabilityEnum = z.enum([
  'CODING',
  'PLANNING',
  'REVIEW',
  'SECURITY_REVIEW',
  'LARGE_CONTEXT',
  'TERMINAL',
  'FILESYSTEM_EDIT',
  'TEST_EXECUTION',
  'WEB_ACCESS'
]);
export type Capability = z.infer<typeof CapabilityEnum>;

export const QuotaSourceEnum = z.enum([
  'MEASURED',
  'PROVIDER_REPORTED',
  'MANUAL',
  'ESTIMATED',
  'UNKNOWN'
]);
export type QuotaSource = z.infer<typeof QuotaSourceEnum>;

export const DecisionAuthorityEnum = z.enum([
  'CODER',
  'REVIEWER',
  'PRIMARY_MANAGER',
  'OWNER'
]);
export type DecisionAuthority = z.infer<typeof DecisionAuthorityEnum>;

export const DecisionStatusEnum = z.enum([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'SUPERSEDED'
]);
export type DecisionStatus = z.infer<typeof DecisionStatusEnum>;

export const ReviewVerdictEnum = z.enum([
  'PASS',
  'FIX_REQUIRED',
  'BLOCKED',
  'NEEDS_OWNER'
]);
export type ReviewVerdict = z.infer<typeof ReviewVerdictEnum>;

export const ReviewIssueSeverityEnum = z.enum([
  'BLOCKER',
  'REQUIRED',
  'OPTIONAL',
  'NIT'
]);
export type ReviewIssueSeverity = z.infer<typeof ReviewIssueSeverityEnum>;

export const EvidenceTypeEnum = z.enum([
  'GIT_DIFF',
  'GIT_STATUS',
  'GIT_SHA',
  'TEST_RESULT',
  'LINT_RESULT',
  'TYPECHECK_RESULT',
  'BUILD_RESULT',
  'SECURITY_SCAN',
  'PROCESS_LOG',
  'FILE_SNAPSHOT',
  'CUSTOM'
]);
export type EvidenceType = z.infer<typeof EvidenceTypeEnum>;

export const EvidenceStorageTypeEnum = z.enum(['INLINE', 'FILE']);
export type EvidenceStorageType = z.infer<typeof EvidenceStorageTypeEnum>;

export const HandoffReasonEnum = z.enum([
  'QUOTA_EXHAUSTED',
  'CONTEXT_EXHAUSTED',
  'AUTH_ERROR',
  'TIMEOUT',
  'MANUAL',
  'PROCESS_CRASH'
]);
export type HandoffReason = z.infer<typeof HandoffReasonEnum>;

export const PolicyDecisionEnum = z.enum([
  'ALLOW',
  'DENY',
  'REQUIRES_OWNER_APPROVAL'
]);
export type PolicyDecision = z.infer<typeof PolicyDecisionEnum>;

export const UIDensityModeEnum = z.enum(['OWNER', 'ENGINEER', 'DEBUG']);
export type UIDensityMode = z.infer<typeof UIDensityModeEnum>;

// ==========================================
// 2. Domain Entity Interfaces
// ==========================================

export interface ProjectContract {
  goal: string;
  business_context?: string;
  architecture_constraints: string[];
  technical_constraints: string[];
  security_requirements: string[];
  acceptance_criteria: string[];
  non_goals: string[];
  definition_of_done: string[];
  testing_requirements: string[];
  owner_policies: string[];
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  repository_path: string;
  default_branch: string;
  status: ProjectStatus;
  contract: ProjectContract | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface Milestone {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  target_date: string | null;
  status: string;
  weight: number;
  created_at: string;
}

export interface Task {
  id: string;
  project_id: string;
  milestone_id: string | null;
  title: string;
  description: string | null;
  state: TaskState;
  paused_from_state: TaskPausedFromState | null;
  priority: Priority;
  risk: RiskLevel;
  assigned_agent_id: string | null;
  revision_count: number;
  max_revisions: number;
  base_sha: string | null;
  current_sha: string | null;
  progress_cache_percent: number;
  progress_computed_at: string | null;
  acceptance_criteria: string[];
  constraints: string[];
  ownership_epoch?: number;
  created_at: string;
  updated_at: string;
}

export interface TaskLease {
  task_id: string;
  agent_id: string;
  lease_token: string;
  acquired_at: string;
  expires_at: string;
  heartbeat_at: string;
  released_at: string | null;
}

export interface TaskAttempt {
  id: string;
  task_id: string;
  attempt_number: number;
  agent_id: string | null;
  agent_profile_id?: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
}

export interface Provider {
  id: string;
  name: string;
  adapter_type: ProviderAdapterType;
  enabled: boolean;
  created_at: string;
}

export interface ProviderResource {
  id: string;
  provider_id: string;
  provider_account_id?: string | null;
  model_name: string;
  health_status: ProviderHealthStatus;
  capabilities: Capability[];
  enabled: boolean;
  total_quota: number | null;
  remaining_quota: number | null;
  quota_unit: string;
  quota_reset_at: string | null;
  quota_source: QuotaSource;
  quota_confidence: number;
  last_health_check: string | null;
}

export interface Agent {
  id: string;
  display_name: string;
  role: AgentRole;
  provider_resource_id: string | null;
  status: AgentStatus;
  current_task_id: string | null;
  last_seen_at: string;
}

export interface Decision {
  id: string;
  project_id: string;
  task_id: string | null;
  author_agent_id: string | null;
  authority_level: DecisionAuthority;
  decision_type: string;
  title: string;
  rationale: string;
  status: DecisionStatus;
  reconciliation_needed: boolean;
  created_at: string;
}

export interface ReviewIssue {
  id: string;
  review_id: string;
  severity: ReviewIssueSeverity;
  title: string;
  file_path: string | null;
  line_number: number | null;
  description: string;
  resolved: boolean;
}

export interface Review {
  id: string;
  task_id: string;
  attempt_id: string | null;
  reviewer_agent_id: string | null;
  verdict: ReviewVerdict;
  summary: string;
  issues?: ReviewIssue[];
  created_at: string;
}

export interface Evidence {
  id: string;
  project_id: string;
  task_id: string | null;
  attempt_id: string | null;
  evidence_type: EvidenceType;
  storage_type: EvidenceStorageType;
  file_path: string | null;
  hash: string;
  byte_size: number;
  content_type: string;
  summary: string;
  raw_payload: string | null;
  created_at: string;
}

export interface TestRun {
  id: string;
  task_id: string;
  command: string;
  passed_count: number;
  failed_count: number;
  skipped_count: number;
  duration_ms: number;
  exit_code: number;
  evidence_id: string | null;
  created_at: string;
}

export interface ProcessRun {
  id: string;
  pid: number | null;
  command: string;
  working_directory: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
  start_time: string;
  end_time: string | null;
  exit_code: number | null;
  stdout_evidence_id: string | null;
  stderr_evidence_id: string | null;
  created_at: string;
}

export interface Checkpoint {
  id: string;
  task_id: string;
  attempt_id: string | null;
  sha: string;
  tree_metadata: Record<string, unknown>;
  completed_steps: string[];
  remaining_steps: string[];
  tests_passing: number;
  tests_failing: number;
  known_issues: string[];
  recommended_next_action: string | null;
  created_at: string;
}

export interface Handoff {
  id: string;
  task_id: string;
  attempt_id: string | null;
  previous_agent_id: string | null;
  reason: HandoffReason;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface EventRecord {
  id: string;
  project_id: string;
  task_id: string | null;
  agent_id: string | null;
  type: string;
  summary: string;
  structured_payload: Record<string, unknown>;
  timestamp: string;
}

export interface VerificationCommandConfig {
  id: string;
  project_id: string;
  name: string;
  command_type: 'TEST' | 'LINT' | 'TYPECHECK' | 'BUILD';
  executable: string;
  args: string[];
  timeout_ms: number;
  enabled: boolean;
}

export interface GitStatusSummary {
  status: 'SUCCESS' | 'ERROR' | 'UNKNOWN';
  branch: string;
  isClean: boolean;
  modifiedFiles: string[];
  untrackedFiles: string[];
  aheadCount: number;
  behindCount: number;
  errorMessage?: string;
}

export interface GitDiffSummary {
  status: 'SUCCESS' | 'ERROR' | 'UNKNOWN';
  diffStat: string;
  diffContent: string;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  errorMessage?: string;
}

export interface PolicyRule {
  id: string;
  name: string;
  policy_type: string;
  action: string;
  rule_expression: string;
  default_decision: PolicyDecision;
  created_at: string;
}

export type ExecutionAuthorizationStatus = 'AUTHORIZED' | 'DISPATCHED' | 'INVALIDATED';
export type AdapterOutcome = 'RETURNED' | 'THREW' | 'CANCELLED' | 'TIMED_OUT' | 'UNKNOWN';
export type ProviderTerminationStatus = 'CONFIRMED_TERMINATED' | 'UNRESOLVED';
export type SettlementStatus = 'COMPLETED' | 'FAILED' | 'CANCELLED';

export type TerminationReason =
  | 'EXECUTION_TIMEOUT'
  | 'EXECUTION_CANCELLED'
  | 'HEARTBEAT_TIMEOUT'
  | 'MANUAL_INTERVENTION';

export type TerminationProofSource =
  | 'LOCAL_PROCESS_EXIT'
  | 'PROVIDER_FINAL_ACK'
  | 'TIMEOUT_UNACKNOWLEDGED'
  | 'CANCEL_UNACKNOWLEDGED'
  | 'DISCONNECT_UNKNOWN';

export interface ExecutionAuthorization {
  id: string;
  project_id: string;
  task_id: string;
  attempt_id: string | null;
  task_revision: number;
  base_sha: string;
  repository_head_sha: string;
  manager_message_id: string;
  manager_payload_hash: string;
  routing_decision_id: string;
  selected_account_id?: string;
  selected_resource_id: string;
  selected_provider_id: string;
  authorized_roles?: string[];
  instruction_payload_hash: string;
  context_manifest_hash: string;
  canonical_instructions_json: string;
  context_files_json: string;
  context_items_json?: string | null;
  canonical_payload_json: string | null;
  expected_task_revision?: number;
  expected_task_title?: string;
  expected_task_description?: string;
  expected_task_acceptance_criteria?: string;
  expected_task_constraints?: string;
  expected_task_base_sha?: string;
  expected_task_allow_commands?: string[];
  status: ExecutionAuthorizationStatus;
  created_at: string;
  dispatched_at: string | null;
  task_ownership_epoch?: number;
  assignment_id?: string | null;
  lifecycle_version?: number | null;
  execution_id?: string | null;
  adapter_started_at?: string | null;
  adapter_finished_at?: string | null;
  adapter_outcome?: AdapterOutcome | null;
  adapter_error_json?: string | null;
  settlement_status?: SettlementStatus | null;
  cancellation_requested_at?: string | null;
  termination_confirmed_at?: string | null;
  termination_status?: ProviderTerminationStatus | null;
  termination_source?: string | null;
  termination_reason?: TerminationReason | null;
  termination_proof_source?: TerminationProofSource | null;
  termination_evidence_json?: string | null;
  termination_evidence_hash?: string | null;
  terminated_at?: string | null;
  settled_at?: string | null;
  settlement_evidence_json?: string | null;
  settlement_evidence_hash?: string | null;
}

export type ExecutionRecoveryClassification =
  | 'PRE_ADAPTER_NOT_STARTED'
  | 'ADAPTER_IN_FLIGHT_UNRESOLVED'
  | 'ADAPTER_TERMINATED_AFTER_TIMEOUT'
  | 'ADAPTER_FINISHED_RESULT_MISSING'
  | 'RESULT_PERSISTED_STATE_INCOMPLETE'
  | 'ALREADY_RECONCILED'
  | 'LEGACY_UNCLASSIFIABLE'
  | 'AUTHORITY_CONFLICT';

export type ExecutionRecoveryDisposition =
  | 'TERMINALIZED_SAFE_EXPIRED'
  | 'UNRESOLVED_FENCED'
  | 'TERMINALIZED_CONFIRMED_TIMEOUT'
  | 'TERMINALIZED_CONFIRMED_CANCELLED'
  | 'RESULT_MISSING_FENCED'
  | 'TERMINAL_STATE_RECONCILED'
  | 'NO_OP_ALREADY_RECONCILED'
  | 'LEGACY_UNRESOLVED_FENCED'
  | 'REJECTED_INTEGRITY_CONFLICT';

export interface ExecutionRecoveryState {
  id: string;
  authorization_id: string;
  transfer_id: string;
  execution_id: string | null;
  lifecycle_version: number | null;
  recovery_classification: ExecutionRecoveryClassification;
  disposition: ExecutionRecoveryDisposition;
  canonical_evidence_json: string;
  evidence_hash: string;
  recovery_version: number;
  mutated_terminal_state: boolean;
  mutated_resources: boolean;
  first_detected_at: string;
  last_scanned_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExecutionRecoveryScanItemResult {
  authorizationId: string;
  transferId: string;
  executionId: string | null;
  lifecycleVersion: number | null;
  classification: ExecutionRecoveryClassification;
  disposition: ExecutionRecoveryDisposition;
  mutatedTerminalState: boolean;
  mutatedResources: boolean;
  evidenceHash: string;
  error?: string;
}

export interface ExecutionRecoveryScanReport {
  scannedCount: number;
  reconciledCount: number;
  unresolvedCount: number;
  rejectedCount: number;
  noOpCount: number;
  preAdapterNotStartedCount: number;
  adapterInFlightUnresolvedCount: number;
  adapterTerminatedTimeoutCount: number;
  adapterFinishedResultMissingCount: number;
  resultPersistedStateIncompleteCount: number;
  alreadyReconciledCount: number;
  legacyUnclassifiableCount: number;
  authorityConflictCount: number;
  items: ExecutionRecoveryScanItemResult[];
  scannedAt: string;
}

export type UpdateState =
  | 'IDLE'
  | 'CHECKING'
  | 'UPDATE_AVAILABLE'
  | 'NO_UPDATE_AVAILABLE'
  | 'DOWNLOADING'
  | 'DOWNLOADED'
  | 'INSTALLING'
  | 'ERROR'
  | 'DISABLED';

export interface UpdateProgress {
  percent: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
}

export interface UpdateInfo {
  version: string;
  releaseDate?: string;
  releaseNotes?: string;
  releaseName?: string;
}

export interface UpdateStateSummary {
  state: UpdateState;
  currentVersion: string;
  updateInfo: UpdateInfo | null;
  progress: UpdateProgress | null;
  error: string | null;
  isPackaged: boolean;
  isCodeSigned: boolean;
  canInstall: boolean;
  lastCheckedAt: string | null;
}

// ==========================================
// 3. R5A Role-Agnostic Agent Fabric Entities
// ==========================================

export const FabricRoleEnum = z.enum([
  'MANAGER',
  'PLANNER',
  'CODER',
  'REVIEWER',
  'SECURITY_REVIEWER',
  'RESEARCHER',
  'RELEASE_MANAGER',
  'MONITOR',
  'TOOL',
]);
export type FabricRole = z.infer<typeof FabricRoleEnum>;

export const AccountAuthModeEnum = z.enum([
  'NATIVE_PROFILE',
  'API_CREDENTIAL',
]);
export type AccountAuthMode = z.infer<typeof AccountAuthModeEnum>;

export const WorkerSlotStatusEnum = z.enum([
  'IDLE',
  'LEASED',
  'RUNNING',
  'COOLDOWN',
  'OFFLINE',
  'DISABLED',
]);
export type WorkerSlotStatus = z.infer<typeof WorkerSlotStatusEnum>;

export const AgentAssignmentStatusEnum = z.enum([
  'ASSIGNED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'HANDED_OFF',
]);
export type AgentAssignmentStatus = z.infer<typeof AgentAssignmentStatusEnum>;

export const SeparationAffinityEnum = z.enum([
  'ALLOW',
  'PREFER_DIFFERENT',
  'REQUIRE_DIFFERENT',
]);
export type SeparationAffinity = z.infer<typeof SeparationAffinityEnum>;

export interface RoleProfile {
  id: string;
  role: FabricRole;
  display_name: string;
  required_capabilities: Capability[];
  preferred_capabilities: Capability[];
  authority_scope: Record<string, unknown> | null;
  permissions: string[];
  output_protocol: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface AgentProfile {
  id: string;
  role_profile_id: string;
  name: string;
  prompt_template: string | null;
  config: Record<string, unknown> | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProviderAccount {
  id: string;
  provider_id: string;
  label: string;
  auth_mode: AccountAuthMode;
  credential_ref: string | null;
  profile_ref: string | null;
  enabled: boolean;
  priority: number;
  health_status: ProviderHealthStatus;
  cooldown_until: string | null;
  concurrency_limit: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_failure_code: string | null;
  last_applied_action_account_order?: number | null;
  last_applied_action_authorization_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkerSlot {
  id: string;
  provider_account_id: string;
  provider_resource_id: string | null;
  slot_index: number;
  status: WorkerSlotStatus;
  current_assignment_id: string | null;
  current_execution_id: string | null;
  heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentAssignment {
  id: string;
  project_id: string;
  task_id: string;
  attempt_id: string | null;
  role_profile_id: string;
  agent_profile_id: string | null;
  selected_provider_id: string;
  selected_account_id: string;
  selected_resource_id: string;
  selected_worker_slot_id: string | null;
  routing_decision_id: string | null;
  preferred_metadata: Record<string, unknown> | null;
  status: AgentAssignmentStatus;
  created_at: string;
  ended_at: string | null;
}

export interface AccountLease {
  id: string;
  assignment_id: string;
  provider_account_id: string;
  worker_slot_id: string;
  lease_token: string;
  acquired_at: string;
  expires_at: string;
  heartbeat_at: string;
  released_at: string | null;
}

export type PolicyDependentFailureCategory =
  | 'TIMEOUT'
  | 'NONZERO_EXIT'
  | 'OUTPUT_LIMIT_EXCEEDED';

export type FailoverPolicyAction = 'FAILOVER' | 'STOP';

export interface DisabledFailoverPolicyV1 {
  version: 1;
  enabled: false;
}

export interface EnabledFailoverPolicyV1 {
  version: 1;
  enabled: true;
  max_failover_attempts: number;
  same_account_retries: number;
  allow_cross_account: boolean;
  allow_cross_provider: boolean;
  cooldown_duration_ms?: number;
  failure_actions?: Partial<Record<PolicyDependentFailureCategory, FailoverPolicyAction>>;
}

export type FailoverPolicyV1 = DisabledFailoverPolicyV1 | EnabledFailoverPolicyV1;

export type FailoverPolicyParseStatus = 'VALID' | 'ABSENT' | 'INVALID';

export type FailoverPolicyParseResult =
  | { status: 'VALID'; policy: FailoverPolicyV1 }
  | { status: 'ABSENT' }
  | { status: 'INVALID'; error: string };

export type FailoverDecisionOutcome =
  | 'FAILOVER_ALLOWED'
  | 'AUTOMATED_FAILOVER_DISABLED'
  | 'FAILOVER_ATTEMPTS_EXHAUSTED'
  | 'NON_FAILOVERABLE'
  | 'POLICY_DECISION_REQUIRED'
  | 'INVALID_POLICY';

export interface FailoverDecision {
  outcome: FailoverDecisionOutcome;
  category: string;
  reason: string;
  cooldownDurationMs?: number;
}

export interface FailoverTransition {
  id: string;
  task_id: string;
  root_attempt_id: string;
  source_attempt_id: string;
  successor_attempt_id: string;
  failover_ordinal: number;
  created_at: string;
}

export interface FailoverLineageContext {
  currentAttemptId: string;
  rootAttemptId: string;
  failoverAttemptsUsed: number;
  transitions: FailoverTransition[];
}

export type FailoverSuccessorClaimStatus =
  | 'CREATED'
  | 'ALREADY_CLAIMED'
  | 'SOURCE_NOT_FOUND'
  | 'SUCCESSOR_ID_CONFLICT'
  | 'TRANSITION_ID_CONFLICT'
  | 'INVALID_INPUT';

export interface FailoverSuccessorClaimResult {
  status: FailoverSuccessorClaimStatus;
  transition?: FailoverTransition;
  successorAttempt?: TaskAttempt;
  error?: string;
}

export interface ClaimSuccessorParams {
  transitionId: string;
  sourceAttemptId: string;
  successorAttemptId: string;
  status?: string;
  startedAt?: string;
  endedAt?: string | null;
  summary?: string | null;
  createdAt?: string;
}

export type FailoverRouteStageKind =
  | 'SAME_ACCOUNT_RETRY'
  | 'CROSS_ACCOUNT_SAME_PROVIDER'
  | 'CROSS_PROVIDER';

export type FailoverNextRoutePlanOutcome =
  | 'ROUTE_STAGES_READY'
  | 'NO_ROUTE_SCOPE_ALLOWED'
  | 'FAILOVER_NOT_AUTHORIZED'
  | 'INVALID_INPUT';

export interface FailoverRouteStage {
  kind: FailoverRouteStageKind;
  requiredProviderId: string | null;
  requiredAccountId: string | null;
  requiredResourceId: string | null;
  excludedCandidateIds: string[];
  excludedAccountIds: string[];
  excludedProviderIds: string[];
  reason: string;
}

export interface FailoverNextRoutePlan {
  outcome: FailoverNextRoutePlanOutcome;
  currentAttemptId: string;
  currentAssignmentId: string | null;
  currentProviderId: string | null;
  currentAccountId: string | null;
  currentResourceId: string | null;
  consecutiveSameAccountRetriesUsed: number;
  sameAccountRetriesAllowed: number;
  stages: FailoverRouteStage[];
  reason: string;
}

export interface EvaluateFailoverNextRouteParams {
  policyResult: FailoverPolicyParseResult;
  decision: FailoverDecision;
  lineage: FailoverLineageContext;
  assignments: AgentAssignment[];
}

export interface RoutePolicy {
  id: string;
  name: string;
  required_capabilities: Capability[];
  preferred_capabilities: Capability[];
  provider_account_policy: Record<string, unknown> | null;
  allow_manual_bridge: boolean;
  failover_policy: Record<string, unknown> | null;
  risk_policy: Record<string, unknown> | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface SeparationPolicy {
  id: string;
  name: string;
  same_execution_forbidden: boolean;
  same_session_forbidden: boolean;
  same_account_policy: SeparationAffinity;
  same_provider_policy: SeparationAffinity;
  same_model_policy: SeparationAffinity;
  risk_threshold: RiskLevel;
  applicability: Record<string, unknown> | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

// ==========================================
// 4. R5B Durable Memory & Context Fabric Entities
// ==========================================

export const AgentSessionStatusEnum = z.enum([
  'ACTIVE',
  'ENDED',
  'FAILED',
  'SUSPENDED',
]);
export type AgentSessionStatus = z.infer<typeof AgentSessionStatusEnum>;

export interface AgentSession {
  id: string;
  project_id: string;
  task_id: string;
  attempt_id: string | null;
  assignment_id: string | null;
  provider_id: string | null;
  provider_account_id: string | null;
  provider_resource_id: string | null;
  external_session_ref: string | null;
  status: AgentSessionStatus;
  started_at: string;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export const ProjectMemoryTypeEnum = z.enum([
  'ARCHITECTURE',
  'OWNER_POLICY',
  'CONSTRAINT',
  'DECISION',
  'CONVENTION',
  'REPOSITORY_FACT',
  'CUSTOM',
]);
export type ProjectMemoryType = z.infer<typeof ProjectMemoryTypeEnum>;

export interface ProjectMemory {
  id: string;
  project_id: string;
  memory_type: ProjectMemoryType;
  key: string;
  value_json: string;
  source_type: string;
  source_ref: string | null;
  revision: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export const TaskMemoryTypeEnum = z.enum([
  'GOAL',
  'ACCEPTANCE_CRITERION',
  'CONSTRAINT',
  'COMPLETED_STEP',
  'REMAINING_STEP',
  'KNOWN_ISSUE',
  'DECISION',
  'VERIFICATION_FACT',
  'RECOMMENDED_NEXT_ACTION',
  'CUSTOM',
]);
export type TaskMemoryType = z.infer<typeof TaskMemoryTypeEnum>;

export interface TaskMemory {
  id: string;
  project_id: string;
  task_id: string;
  attempt_id: string | null;
  assignment_id: string | null;
  memory_type: TaskMemoryType;
  key: string;
  value_json: string;
  source_type: string;
  source_ref: string | null;
  revision: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export const ContextSnapshotPurposeEnum = z.enum([
  'EXECUTION',
  'REVIEW',
  'HANDOFF',
  'MANAGER',
  'RESEARCH',
  'CUSTOM',
]);
export type ContextSnapshotPurpose = z.infer<typeof ContextSnapshotPurposeEnum>;

export interface ContextSnapshot {
  id: string;
  project_id: string;
  task_id: string;
  attempt_id: string | null;
  assignment_id: string | null;
  session_id: string | null;
  purpose: ContextSnapshotPurpose;
  snapshot_version: number;
  builder_version: string;
  content_hash: string;
  created_at: string;
}

export const ContextItemTypeEnum = z.enum([
  'PROJECT_CONTRACT',
  'PROJECT_MEMORY',
  'TASK_CORE',
  'TASK_MEMORY',
  'CHECKPOINT',
  'HANDOFF',
  'CONTEXT_FILE_REFERENCE',
  'CUSTOM',
]);
export type ContextItemType = z.infer<typeof ContextItemTypeEnum>;

export interface ContextItem {
  id: string;
  snapshot_id: string;
  ordinal: number;
  item_type: ContextItemType;
  source_type: string;
  source_ref: string | null;
  content_json: string;
  content_hash: string;
  token_estimate: number | null;
  created_at: string;
}

export interface ContextManifest {
  id: string;
  snapshot_id: string;
  manifest_version: string;
  item_count: number;
  manifest_json: string;
  manifest_hash: string;
  created_at: string;
}

export const HandoffContextStatusEnum = z.enum([
  'PENDING',
  'READY',
  'CONSUMED',
  'FAILED',
  'CANCELLED',
]);
export type HandoffContextStatus = z.infer<typeof HandoffContextStatusEnum>;

export interface HandoffContext {
  id: string;
  project_id: string;
  task_id: string;
  attempt_id: string | null;
  from_assignment_id: string | null;
  to_assignment_id: string | null;
  source_snapshot_id: string;
  handoff_snapshot_id: string | null;
  reason: string;
  status: HandoffContextStatus;
  created_at: string;
  consumed_at: string | null;
}

export type ProviderHealthObservationCategory =
  | 'SUCCESS'
  | 'AWAITING_OWNER'
  | 'ADAPTER_THROW'
  | 'RATE_LIMITED'
  | 'QUOTA_EXHAUSTED'
  | 'AUTHENTICATION_FAILURE'
  | 'RESOURCE_UNAVAILABLE'
  | 'CANCELLED'
  | 'POLICY_DENIAL'
  | 'PROTOCOL_INVALID'
  | 'LOCAL_PROCESS_FAILURE'
  | 'TIMEOUT'
  | 'NONZERO_EXIT'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'UNKNOWN';

export type FailoverPolicyAuthoritySnapshotV1 =
  | {
      version: 1;
      status: 'VALID';
      policy: FailoverPolicyV1;
    }
  | {
      version: 1;
      status: 'ABSENT';
    }
  | {
      version: 1;
      status: 'INVALID';
    };

export type ProviderAccountHealthAction =
  | 'NO_MUTATION'
  | 'RECORD_SUCCESS'
  | 'RECORD_RATE_LIMITED'
  | 'RECORD_QUOTA_EXHAUSTED'
  | 'RECORD_AUTH_ERROR';

export interface ProviderHealthObservation {
  authorization_id: string;
  execution_id: string;
  account_id: string;
  provider_id: string;
  resource_id: string;
  assignment_id: string;
  attempt_id: string | null;
  routing_decision_id: string;
  provenance_version: 1;
  provenance_source: 'PROVIDER_DISPATCH_SERVICE';
  mode: 'LEGACY' | 'SCHEDULED';
  adapter_invocation: 'RETURNED' | 'THREW';
  result_status: string;
  classified_category: ProviderHealthObservationCategory;
  observed_at: string;
  account_order?: number | null;
  health_action_plan_version?: 1 | null;
  health_action?: ProviderAccountHealthAction | null;
  health_action_cooldown_duration_ms?: number | null;
  health_action_cooldown_anchor_at?: string | null;
}

export interface ProviderHealthObservationRecord extends ProviderHealthObservation {
  account_order: number | null;
  health_action_plan_version: 1 | null;
  health_action: ProviderAccountHealthAction | null;
  health_action_cooldown_duration_ms: number | null;
  health_action_cooldown_anchor_at: string | null;
}

export type ProviderHealthObservationIngestStatus =
  | 'RECORDED'
  | 'ALREADY_RECORDED'
  | 'NOT_APPLICABLE'
  | 'REJECTED';

export interface ProviderHealthObservationIngestResult {
  status: ProviderHealthObservationIngestStatus;
  observation: ProviderHealthObservationRecord | ProviderHealthObservation | null;
  reason?: string;
}

export type ProviderHealthObservationApplicationStatus =
  | 'APPLIED'
  | 'ALREADY_APPLIED'
  | 'STALE'
  | 'NO_MUTATION'
  | 'LEGACY_UNORDERED'
  | 'ACTION_AUTHORITY_UNKNOWN'
  | 'TEMPORAL_AUTHORITY_UNKNOWN'
  | 'DEFERRED_BY_NEWER_UNKNOWN_AUTHORITY'
  | 'REJECTED';

export interface ProviderHealthObservationApplicationResult {
  status: ProviderHealthObservationApplicationStatus;
  accountId: string;
  authorizationId: string;
  accountOrder: number | null;
  healthAction: ProviderAccountHealthAction | null;
  appliedHealthStatus?: ProviderHealthStatus;
  appliedCooldownUntil?: string | null;
  watermarkAccountOrder?: number | null;
  watermarkAuthorizationId?: string | null;
  reason?: string;
}

export type ProviderHealthRoutingSafetyStatus =
  | 'SAFE'
  | 'PENDING_APPLICATION'
  | 'ACTION_AUTHORITY_UNKNOWN'
  | 'TEMPORAL_AUTHORITY_UNKNOWN'
  | 'WATERMARK_INTEGRITY_MISMATCH';

export interface ProviderHealthRoutingSafetyEvaluation {
  status: ProviderHealthRoutingSafetyStatus;
  accountId: string;
  watermarkAccountOrder: number | null;
  watermarkAuthorizationId: string | null;
  effectiveHeadAccountOrder: number | null;
  effectiveHeadAuthorizationId: string | null;
  effectiveHeadHealthAction: string | null;
  reason?: string;
}

// ==========================================
// 6. R5I Durable Handoff Transfer Entities
// ==========================================

export const HandoffTransferStatusEnum = z.enum([
  'REQUESTED',
  'FROZEN',
  'QUIESCING',
  'RELINQUISHED',
  'SUCCESSOR_PREPARED',
  'ROUTED',
  'AUTHORIZED',
  'ACCEPTED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
]);
export type HandoffTransferStatus = z.infer<typeof HandoffTransferStatusEnum>;

export interface HandoffTransfer {
  id: string;
  request_id: string;
  task_id: string;
  source_attempt_id: string;
  successor_attempt_id: string | null;
  source_assignment_id: string;
  successor_assignment_id: string | null;
  successor_role_profile_id: string | null;
  successor_agent_profile_id: string | null;
  successor_context_snapshot_id: string | null;
  successor_context_spec_hash: string | null;
  handoff_context_id: string | null;
  checkpoint_id: string | null;
  source_authorization_id: string | null;
  successor_authorization_id: string | null;
  reason: string;
  status: HandoffTransferStatus;
  source_ownership_epoch: number;
  successor_ownership_epoch: number | null;
  version: number;
  frozen_at: string | null;
  quiescing_at: string | null;
  relinquished_at: string | null;
  accepted_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type McpSessionScope = 'AUTHORIZED_CONTEXT_READ';

export interface McpClientSession {
  id: string;
  authorization_id: string;
  scope: McpSessionScope;
  token_hash: string;
  authorization_fingerprint: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export type McpSessionErrorCode =
  | 'MCP_SESSION_REQUIRED'
  | 'MCP_SESSION_UNAUTHORIZED'
  | 'MCP_CONFIGURATION_INVALID'
  | 'MCP_AUTHORITY_FENCED'
  | 'MCP_CONTEXT_INTEGRITY_FAILED';

export interface AuthorizedContextSessionMetadata {
  id: string;
  scope: McpSessionScope;
  issued_at: string;
  expires_at: string;
}

export interface AuthorizedContextAuthorizationBindings {
  id: string;
  project_id: string;
  task_id: string;
  attempt_id: string | null;
  assignment_id: string;
  task_ownership_epoch: number;
  lifecycle_version: 1;
  routing_decision_id: string;
  selected_provider_id: string;
  selected_account_id: string;
  selected_resource_id: string;
  task_revision: number;
  base_sha: string;
  repository_head_sha: string;
  manager_message_id: string;
  manager_payload_hash: string;
  status: ExecutionAuthorizationStatus;
  created_at: string;
  dispatched_at: string | null;
}

export interface AuthorizedContextResponse {
  schema_version: 2;
  session: AuthorizedContextSessionMetadata;
  authorization: AuthorizedContextAuthorizationBindings;
  execution_payload: Record<string, unknown>;
  instruction_payload_hash: string;
  context_manifest_hash: string;
}
