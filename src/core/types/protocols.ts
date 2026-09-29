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

// ==========================================
// 1. Manager Protocol Schema (manager.v1)
// ==========================================

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
  severity: ReviewIssueSeverityEnum,
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
  decision: ManagerDecisionEnum,
  priority: PriorityEnum.optional().default('MEDIUM'),
  risk: RiskLevelEnum.optional().default('MEDIUM'),
  instructions: protocolStringArray().optional().default([]),
  acceptance_criteria: protocolStringArray().optional().default([]),
  constraints: protocolStringArray().optional().default([]),
  review_issues: boundedArray(z.array(ReviewIssueSchema), MAX_PROTOCOL_ARRAY_ITEMS).optional().default([]),
  expected_task_state: TaskStateEnum.nullable().optional(),
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
  status: CoderStatusEnum,
  completed: protocolStringArray().optional().default([]),
  remaining: protocolStringArray().optional().default([]),
  files_claimed_changed: protocolStringArray().optional().default([]),
  tests_claimed: protocolStringArray().optional().default([]),
  blockers: protocolStringArray().optional().default([]),
  review_requested: z.boolean().optional().default(true),
  expected_task_state: TaskStateEnum.nullable().optional(),
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
// 5. Outbox Packages
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
