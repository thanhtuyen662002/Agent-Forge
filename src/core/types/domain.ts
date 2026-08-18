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
  agent_id: string;
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
  selected_resource_id: string;
  selected_provider_id: string;
  instruction_payload_hash: string;
  context_manifest_hash: string;
  canonical_instructions_json: string;
  context_files_json: string;
  status: ExecutionAuthorizationStatus;
  created_at: string;
  dispatched_at: string | null;
}
