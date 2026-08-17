import { z } from 'zod';
import {
  PriorityEnum,
  RiskLevelEnum,
  ReviewIssueSeverityEnum,
  TaskStateEnum,
  HandoffReasonEnum
} from './domain';

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
  title: z.string().min(1),
  file_path: z.string().nullable().optional(),
  line_number: z.number().int().nullable().optional(),
  description: z.string().min(1),
});
export type ReviewIssuePayload = z.infer<typeof ReviewIssueSchema>;

export const ManagerProtocolSchema = z.object({
  protocol: z.literal('manager.v1'),
  message_id: z.string().min(1),
  project_id: z.string().min(1),
  task_id: z.string().nullable().optional(),
  decision: ManagerDecisionEnum,
  priority: PriorityEnum.optional().default('MEDIUM'),
  risk: RiskLevelEnum.optional().default('MEDIUM'),
  instructions: z.array(z.string()).optional().default([]),
  acceptance_criteria: z.array(z.string()).optional().default([]),
  constraints: z.array(z.string()).optional().default([]),
  review_issues: z.array(ReviewIssueSchema).optional().default([]),
  expected_task_state: TaskStateEnum.nullable().optional(),
  expected_revision: z.number().int().nonnegative().nullable().optional(),
  created_at: z.string().optional(),
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
  message_id: z.string().min(1),
  project_id: z.string().min(1),
  task_id: z.string().min(1),
  attempt: z.number().int().positive().optional().default(1),
  status: CoderStatusEnum,
  completed: z.array(z.string()).optional().default([]),
  remaining: z.array(z.string()).optional().default([]),
  files_claimed_changed: z.array(z.string()).optional().default([]),
  tests_claimed: z.array(z.string()).optional().default([]),
  blockers: z.array(z.string()).optional().default([]),
  review_requested: z.boolean().optional().default(true),
  expected_task_state: TaskStateEnum.nullable().optional(),
  expected_revision: z.number().int().nonnegative().nullable().optional(),
  created_at: z.string().optional(),
});
export type CoderProtocol = z.infer<typeof CoderProtocolSchema>;

// ==========================================
// 3. Handoff Protocol Schema (handoff.v1)
// ==========================================

export const HandoffProtocolSchema = z.object({
  protocol: z.literal('handoff.v1'),
  message_id: z.string().min(1),
  task_id: z.string().min(1),
  attempt: z.number().int().positive(),
  previous_agent: z.string().min(1),
  reason: HandoffReasonEnum,
  completed: z.array(z.string()).default([]),
  remaining: z.array(z.string()).default([]),
  known_failures: z.array(z.string()).default([]),
  base_sha: z.string().default(''),
  current_sha: z.string().default(''),
  relevant_files: z.array(z.string()).default([]),
  next_action: z.string().min(1),
  created_at: z.string().optional(),
});
export type HandoffProtocol = z.infer<typeof HandoffProtocolSchema>;

// ==========================================
// 4. Implementation Status Report (coder-report.v1)
// ==========================================

export const CoderReportProtocolSchema = z.object({
  protocol: z.literal('coder-report.v1'),
  message_id: z.string().min(1),
  phase: z.string().min(1),
  status: z.enum(['COMPLETED', 'IN_PROGRESS', 'BLOCKED', 'FAILED']),
  summary: z.string().min(1),
  files_changed: z.array(z.string()).default([]),
  tests_run: z.array(z.string()).default([]),
  tests_passed: z.array(z.string()).default([]),
  tests_failed: z.array(z.string()).default([]),
  known_issues: z.array(z.string()).default([]),
  security_notes: z.array(z.string()).default([]),
  next_phase: z.string().default(''),
  requires_manager_review: z.boolean().default(true),
  created_at: z.string().optional(),
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
