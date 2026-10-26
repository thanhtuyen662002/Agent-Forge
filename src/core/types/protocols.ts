import { z } from 'zod';
import {
  PriorityEnum,
  RiskLevelEnum,
  ReviewIssueSeverityEnum,
  TaskStateEnum,
  HandoffReasonEnum
} from './domain';
import { boundedArray, boundedString, MAX_PROTOCOL_ARRAY_ITEMS, MAX_PROTOCOL_STRING_BYTES } from '../protocol/limits';

const protocolString = () => boundedString(z.string(), MAX_PROTOCOL_STRING_BYTES);
const requiredProtocolString = () => boundedString(z.string().min(1), MAX_PROTOCOL_STRING_BYTES);
const protocolStringArray = () => boundedArray(z.array(protocolString()), MAX_PROTOCOL_ARRAY_ITEMS);
/**
 * A list the model may also write as one text block (found in the first real
 * trial: Claude sent manager.v1 `instructions` as a single string). Each
 * non-empty line becomes one item; anything else is validated unchanged.
 */
const linesOrStringArray = () => z.preprocess(
  (value) => (typeof value === 'string' ? value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : value),
  protocolStringArray(),
);

// ==========================================
// 1. Manager Protocol Schema (manager.v1)
// ==========================================

/** Models often write enum values in lower case (`high`); the meaning is unambiguous (found in the first real trial). */
const upperCaseEnum = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (typeof value === 'string' ? value.trim().toUpperCase() : value), schema);

export const ManagerDecisionEnum = z.enum([
  'CREATE_TASKS',
  'EXECUTE',
  'PASS',
  'FIX_REQUIRED',
  'BLOCK',
  'PAUSE',
  'CANCEL',
  'NEEDS_OWNER'
]);
export type ManagerDecision = z.infer<typeof ManagerDecisionEnum>;

export const ReviewIssueSchema = z.object({
  severity: upperCaseEnum(ReviewIssueSeverityEnum),
  title: requiredProtocolString(),
  file_path: protocolString().nullable().optional(),
  line_number: z.number().int().nullable().optional(),
  description: requiredProtocolString(),
});
export type ReviewIssuePayload = z.infer<typeof ReviewIssueSchema>;

export const ManagerProtocolSchema = z.object({
  protocol: z.literal('manager.v1'),
  message_id: requiredProtocolString(),
  project_id: requiredProtocolString(),
  task_id: protocolString().nullable().optional(),
  decision: upperCaseEnum(ManagerDecisionEnum),
  priority: upperCaseEnum(PriorityEnum).optional().default('MEDIUM'),
  risk: upperCaseEnum(RiskLevelEnum).optional().default('MEDIUM'),
  instructions: linesOrStringArray().optional().default([]),
  acceptance_criteria: linesOrStringArray().optional().default([]),
  constraints: linesOrStringArray().optional().default([]),
  review_issues: boundedArray(z.array(ReviewIssueSchema), MAX_PROTOCOL_ARRAY_ITEMS).optional().default([]),
  expected_task_state: upperCaseEnum(TaskStateEnum.nullable()).optional(),
  expected_revision: z.number().int().nonnegative().nullable().optional(),
  created_at: protocolString().optional(),
});
export type ManagerProtocol = z.infer<typeof ManagerProtocolSchema>;

// ==========================================
// 2. Coder Protocol Schema (coder.v1)
// ==========================================

export const CoderStatusEnum = z.enum([
  'COMPLETED',
  'IN_PROGRESS',
  'BLOCKED',
  'FAILED'
]);
export type CoderStatus = z.infer<typeof CoderStatusEnum>;

export const CoderProtocolSchema = z.object({
  protocol: z.literal('coder.v1'),
  message_id: requiredProtocolString(),
  project_id: requiredProtocolString(),
  task_id: requiredProtocolString(),
  attempt: z.number().int().positive().optional().default(1),
  status: upperCaseEnum(CoderStatusEnum),
  completed: linesOrStringArray().optional().default([]),
  remaining: linesOrStringArray().optional().default([]),
  files_claimed_changed: linesOrStringArray().optional().default([]),
  tests_claimed: linesOrStringArray().optional().default([]),
  blockers: linesOrStringArray().optional().default([]),
  review_requested: z.boolean().optional().default(true),
  expected_task_state: upperCaseEnum(TaskStateEnum.nullable()).optional(),
  expected_revision: z.number().int().nonnegative().nullable().optional(),
  created_at: protocolString().optional(),
});
export type CoderProtocol = z.infer<typeof CoderProtocolSchema>;

// ==========================================
// 3. Handoff Protocol Schema (handoff.v1)
// ==========================================

export const HandoffProtocolSchema = z.object({
  protocol: z.literal('handoff.v1'),
  message_id: requiredProtocolString(),
  task_id: requiredProtocolString(),
  attempt: z.number().int().positive(),
  previous_agent: requiredProtocolString(),
  reason: HandoffReasonEnum,
  completed: protocolStringArray().default([]),
  remaining: protocolStringArray().default([]),
  known_failures: protocolStringArray().default([]),
  base_sha: protocolString().default(''),
  current_sha: protocolString().default(''),
  relevant_files: protocolStringArray().default([]),
  next_action: requiredProtocolString(),
  created_at: protocolString().optional(),
});
export type HandoffProtocol = z.infer<typeof HandoffProtocolSchema>;

// ==========================================
// 4. Implementation Status Report (coder-report.v1)
// ==========================================

export const CoderReportProtocolSchema = z.object({
  protocol: z.literal('coder-report.v1'),
  message_id: requiredProtocolString(),
  phase: requiredProtocolString(),
  status: z.enum(['COMPLETED', 'IN_PROGRESS', 'BLOCKED', 'FAILED']),
  summary: requiredProtocolString(),
  files_changed: protocolStringArray().default([]),
  tests_run: protocolStringArray().default([]),
  tests_passed: protocolStringArray().default([]),
  tests_failed: protocolStringArray().default([]),
  known_issues: protocolStringArray().default([]),
  security_notes: protocolStringArray().default([]),
  next_phase: protocolString().default(''),
  requires_manager_review: z.boolean().default(true),
  created_at: protocolString().optional(),
});
export type CoderReportProtocol = z.infer<typeof CoderReportProtocolSchema>;

// ==========================================
// 5. Automated Review Verdict (review.v1)
// ==========================================

export const ReviewVerdictEnum = z.enum(['PASS', 'FIX_REQUIRED', 'BLOCKED']);
export type ReviewVerdict = z.infer<typeof ReviewVerdictEnum>;

const sha40 = () => z.string().regex(/^[0-9a-f]{40}$/i);
const sha256Hex = () => z.string().regex(/^[0-9a-f]{64}$/i);

/**
 * Verdict of an account-bound REVIEWER execution (#233). It names the exact
 * verified work it reviewed, so a verdict for any other (stale) snapshot is
 * rejected. Parsed only by the automated review path, never by the protocol
 * inbox.
 */
export const ReviewProtocolSchema = z.object({
  protocol: z.literal('review.v1'),
  message_id: requiredProtocolString(),
  project_id: requiredProtocolString(),
  task_id: requiredProtocolString(),
  task_revision: z.number().int().nonnegative(),
  verdict: upperCaseEnum(ReviewVerdictEnum),
  summary: requiredProtocolString(),
  issues: boundedArray(z.array(ReviewIssueSchema), MAX_PROTOCOL_ARRAY_ITEMS).optional().default([]),
  reviewed_head_sha: sha40(),
  reviewed_snapshot_sha: sha256Hex(),
  created_at: protocolString().optional(),
}).strict().superRefine((review, ctx) => {
  // A verdict must agree with its own issues.
  if (review.verdict === 'PASS' && review.issues.some((issue) => issue.severity === 'BLOCKER' || issue.severity === 'REQUIRED')) {
    ctx.addIssue({ code: 'custom', path: ['verdict'], message: 'PASS cannot carry BLOCKER or REQUIRED issues.' });
  }
  if (review.verdict === 'FIX_REQUIRED' && review.issues.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['issues'], message: 'FIX_REQUIRED needs at least one issue.' });
  }
});
export type ReviewProtocol = z.infer<typeof ReviewProtocolSchema>;

// ==========================================
// 6. Manager Plan (plan.v1)
// ==========================================

export const PlanTaskSchema = z.object({
  title: boundedString(z.string().min(1).max(200), MAX_PROTOCOL_STRING_BYTES),
  description: protocolString().optional().default(''),
  acceptance_criteria: boundedArray(z.array(requiredProtocolString()).min(1), 20),
  constraints: boundedArray(z.array(requiredProtocolString()), 20).optional().default([]),
  priority: upperCaseEnum(PriorityEnum).optional().default('MEDIUM'),
  risk: upperCaseEnum(RiskLevelEnum).optional().default('MEDIUM'),
  /** Repository paths the coder needs for this task (#254); validated before use. */
  context_paths: boundedArray(z.array(requiredProtocolString()), 32).optional().default([]),
}).strict();
export type PlanTask = z.infer<typeof PlanTaskSchema>;

/**
 * The Manager's task breakdown of an approved project contract (#245). It is
 * bound to the project and to the SHA-256 of the exact contract it planned;
 * parsed only by the automated planning path, never by the protocol inbox.
 */
export const PlanProtocolSchema = z.object({
  protocol: z.literal('plan.v1'),
  message_id: requiredProtocolString(),
  project_id: requiredProtocolString(),
  contract_sha256: z.string().regex(/^[0-9a-f]{64}$/i),
  tasks: boundedArray(z.array(PlanTaskSchema).min(1), 20),
  created_at: protocolString().optional(),
}).strict();
export type PlanProtocol = z.infer<typeof PlanProtocolSchema>;

// ==========================================
// 7. Outbox Packages
// ==========================================

export interface WorkOrderPackage {
  package_type: 'WORK_ORDER';
  project_id: string;
  project_name: string;
  task_id: string;
  title: string;
  description: string | null;
  priority: string;
  risk: string;
  revision_count: number;
  max_revisions: number;
  acceptance_criteria: string[];
  constraints: string[];
  base_sha: string | null;
  current_branch: string;
  verification_commands: {
    test?: string;
    lint?: string;
    typecheck?: string;
    build?: string;
  };
  required_output_protocol: 'coder.v1';
  formatted_markdown: string;
}

export interface ReviewPackage {
  package_type: 'REVIEW_PACKAGE';
  project_id: string;
  task_id: string;
  title: string;
  attempt: number;
  revision_count: number;
  acceptance_criteria: string[];
  base_sha: string | null;
  current_sha: string | null;
  git_evidence: {
    changed_files: string[];
    diff_stat: string;
    diff_summary: string;
  };
  validation_results: {
    test_passed_count: number;
    test_failed_count: number;
    test_exit_code: number;
    test_summary: string;
  };
  coder_claims: {
    status: string;
    completed: string[];
    remaining: string[];
    files_claimed: string[];
    tests_claimed: string[];
    blockers: string[];
  };
  previous_issues: ReviewIssuePayload[];
  required_output_protocol: 'manager.v1';
  formatted_markdown: string;
}
