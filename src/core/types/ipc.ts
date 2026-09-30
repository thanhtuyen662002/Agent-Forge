import { z } from 'zod';
import { CanonicalExecutionScopeSchema } from '../services/ExecutionAuthorizationService';
import { TaskStateEnum } from './domain';
import {
  boundedArray,
  boundedRefinedString,
  boundedString,
  MAX_CONTEXT_FILES,
  MAX_PROTOCOL_ARRAY_ITEMS,
  MAX_PROTOCOL_INPUT_BYTES,
  MAX_PROTOCOL_STRING_BYTES,
  MAX_PROVIDER_CANDIDATES,
} from '../protocol/limits';

const ipcString = () => boundedString(z.string(), MAX_PROTOCOL_STRING_BYTES);
const requiredIpcString = () => boundedString(z.string().min(1), MAX_PROTOCOL_STRING_BYTES);
const ipcStringArray = () => boundedArray(z.array(ipcString()), MAX_PROTOCOL_ARRAY_ITEMS);

// Preserve the canonical path/shape refinements while applying the same byte
// and collection ceilings at the renderer boundary.  The canonical schema is
// also used for durable payload validation, so keep these limits local to IPC
// rather than changing the persisted wire format here.
const boundedExecutionScopeSchema = z
  .object({
    branch: boundedString(z.string().min(1)),
    worktree: boundedRefinedString(
      CanonicalExecutionScopeSchema.shape.worktree,
      MAX_PROTOCOL_STRING_BYTES,
      'Worktree'
    ),
    allowedPaths: ipcStringArray(),
    forbiddenPaths: ipcStringArray(),
  })
  .strict();

// Strict Zod schemas for all IPC channels across the main process security boundary

export const CreateProjectIpcSchema = z.object({
  name: boundedString(z.string().min(1, 'Project name is required').max(100)),
  description: boundedString(z.string().max(500)).optional().default(''),
  repositorySelectionId: boundedString(z.string().uuid('A valid native repository selection token is required')),
  defaultBranch: ipcString().optional().default('main'),
});
export type CreateProjectIpc = z.infer<typeof CreateProjectIpcSchema>;

export const ImportContractIpcSchema = z.object({
  projectId: requiredIpcString(),
  contract: z.object({
    goal: requiredIpcString(),
    business_context: ipcString().optional(),
    architecture_constraints: ipcStringArray().default([]),
    technical_constraints: ipcStringArray().default([]),
    security_requirements: ipcStringArray().default([]),
    acceptance_criteria: ipcStringArray().default([]),
    non_goals: ipcStringArray().default([]),
    definition_of_done: ipcStringArray().default([]),
    testing_requirements: ipcStringArray().default([]),
    owner_policies: ipcStringArray().default([]),
  }),
});
export type ImportContractIpc = z.infer<typeof ImportContractIpcSchema>;

export const ProjectTriggerSchema = z.enum([
  'IMPORT_CONTRACT',
  'PLAN_APPROVED',
  'START_PROJECT',
  'PAUSE',
  'RESUME',
  'BLOCKER_DETECTED',
  'BLOCKER_RESOLVED',
  'QUOTA_EXHAUSTED',
  'CAPACITY_RESTORED',
  'ESCALATE_TO_OWNER',
  'OWNER_APPROVED',
  'ALL_TASKS_DONE',
  'FINAL_PASS',
  'FINAL_FIX_REQUIRED',
  'FATAL_ERROR',
  'CANCEL_PROJECT',
]);
export type ProjectTriggerType = z.infer<typeof ProjectTriggerSchema>;

export const TransitionProjectIpcSchema = z.object({
  projectId: requiredIpcString(),
  trigger: ProjectTriggerSchema,
});
export type TransitionProjectIpc = z.infer<typeof TransitionProjectIpcSchema>;

export const CreateTaskIpcSchema = z.object({
  projectId: requiredIpcString(),
  id: ipcString().optional(),
  milestoneId: ipcString().nullable().optional(),
  title: boundedString(z.string().min(1, 'Task title is required').max(200)),
  description: ipcString().nullable().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  acceptanceCriteria: ipcStringArray().default([]),
  constraints: ipcStringArray().default([]),
});
export type CreateTaskIpc = z.infer<typeof CreateTaskIpcSchema>;

export const ParseProtocolIpcSchema = z.object({
  rawInput: boundedString(z.string().min(1, 'Protocol input text is required'), MAX_PROTOCOL_INPUT_BYTES),
});
export type ParseProtocolIpc = z.infer<typeof ParseProtocolIpcSchema>;

export const ApplyProtocolIpcSchema = z.object({
  rawInput: boundedString(z.string().min(1, 'Raw protocol input is required'), MAX_PROTOCOL_INPUT_BYTES),
});
export type ApplyProtocolIpc = z.infer<typeof ApplyProtocolIpcSchema>;

export const GenerateWorkOrderIpcSchema = z.object({
  projectId: requiredIpcString(),
  taskId: requiredIpcString(),
});

export const GenerateReviewPackageIpcSchema = z.object({
  projectId: requiredIpcString(),
  taskId: requiredIpcString(),
});

export const ProjectScopedIpcSchema = z.object({
  projectId: requiredIpcString(),
});

export const TaskScopedIpcSchema = z.object({
  taskId: requiredIpcString(),
});

const TaskMutationBindingIpcFields = {
  expectedRevision: z.number().int().min(0).max(1_000_000).optional(),
  expectedOwnershipEpoch: z.number().int().min(1).max(1_000_000_000).optional(),
  expectedState: TaskStateEnum.optional(),
  executionId: boundedString(z.string().uuid('A valid validation execution ID is required')).optional(),
};

export const StartReviewIpcSchema = z
  .object({
    taskId: requiredIpcString(),
    expectedProjectId: boundedString(z.string().min(1).max(200)).optional(),
    ...TaskMutationBindingIpcFields,
  })
  .strict();
export type StartReviewIpc = z.infer<typeof StartReviewIpcSchema>;

export const RunVerificationIpcSchema = z
  .object({
    taskId: requiredIpcString(),
    commandConfigId: ipcString().optional(),
    expectedProjectId: boundedString(z.string().min(1).max(200)).optional(),
    ...TaskMutationBindingIpcFields,
  })
  .strict();
export type RunVerificationIpc = z.infer<typeof RunVerificationIpcSchema>;

export const UpdateResourceQuotaIpcSchema = z
  .object({
    id: requiredIpcString(),
    remaining: z.number().finite().nonnegative().nullable(),
    total: z.number().finite().nonnegative().nullable(),
    source: z.enum(['MEASURED', 'PROVIDER_REPORTED', 'MANUAL', 'ESTIMATED', 'UNKNOWN']),
    confidence: z.number().finite().min(0).max(1),
  })
  .superRefine((value, ctx) => {
    if (value.remaining !== null && value.total !== null && value.remaining > value.total) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remaining'],
        message: 'Remaining quota cannot exceed total quota',
      });
    }
  });
export type UpdateResourceQuotaIpc = z.infer<typeof UpdateResourceQuotaIpcSchema>;

/**
 * Emergency Stop Schema.
 * Uses deliberate fail-safe semantics: if no reason or an empty object is supplied,
 * it safely defaults to 'Manual Owner Emergency Stop' rather than rejecting the safety action.
 */
export const EmergencyStopIpcSchema = z.object({
  reason: ipcString().optional().default('Manual Owner Emergency Stop'),
});
export type EmergencyStopIpc = z.infer<typeof EmergencyStopIpcSchema>;

export const ResumeProjectIpcSchema = z.object({
  projectId: requiredIpcString(),
});
export type ResumeProjectIpc = z.infer<typeof ResumeProjectIpcSchema>;

// ==========================================
// PR #8: Owner Routing & Manual Bridge Handoff Schemas
// ==========================================

export const RouteTaskIpcSchema = z
  .object({
    projectId: requiredIpcString(),
    taskId: requiredIpcString(),
    attemptId: ipcString().nullable().optional(),
    candidateResourceIds: boundedArray(
      z.array(boundedString(z.string().min(1, 'Candidate resource ID cannot be empty'))),
      MAX_PROVIDER_CANDIDATES
    ).min(1, 'At least one candidate resource is required'),
    allowManualBridge: z.boolean().default(false),
  })
  .strict();
export type RouteTaskIpc = z.infer<typeof RouteTaskIpcSchema>;

export const AuthorizeRoutedTaskIpcSchema = z
  .object({
    projectId: requiredIpcString(),
    taskId: requiredIpcString(),
    attemptId: ipcString().nullable().optional(),
    routingDecisionId: requiredIpcString(),
    contextFiles: boundedArray(ipcStringArray(), MAX_CONTEXT_FILES).optional().default([]),
    executionScope: boundedExecutionScopeSchema.optional(),
  })
  .strict();
export type AuthorizeRoutedTaskIpc = z.infer<typeof AuthorizeRoutedTaskIpcSchema>;

export const DispatchAuthorizationIpcSchema = z
  .object({
    authorizationId: requiredIpcString(),
  })
  .strict();
export type DispatchAuthorizationIpc = z.infer<typeof DispatchAuthorizationIpcSchema>;

export const GetOwnerHandoffSnapshotIpcSchema = z
  .object({
    taskId: requiredIpcString(),
  })
  .strict();
export type GetOwnerHandoffSnapshotIpc = z.infer<typeof GetOwnerHandoffSnapshotIpcSchema>;

export const GenerateAuthorizedWorkOrderIpcSchema = z
  .object({
    authorizationId: requiredIpcString(),
  })
  .strict();
export type GenerateAuthorizedWorkOrderIpc = z.infer<typeof GenerateAuthorizedWorkOrderIpcSchema>;

// ==========================================
// PR #9: Installed-App Update & Info Schemas
// ==========================================

export const UpdateGetStateIpcSchema = z.object({}).strict();
export type UpdateGetStateIpc = z.infer<typeof UpdateGetStateIpcSchema>;

export const UpdateCheckIpcSchema = z.object({}).strict();
export type UpdateCheckIpc = z.infer<typeof UpdateCheckIpcSchema>;

export const UpdateDownloadIpcSchema = z.object({}).strict();
export type UpdateDownloadIpc = z.infer<typeof UpdateDownloadIpcSchema>;

export const UpdateInstallAndRestartIpcSchema = z.object({}).strict();
export type UpdateInstallAndRestartIpc = z.infer<typeof UpdateInstallAndRestartIpcSchema>;

export const GetAppInfoIpcSchema = z.object({}).strict();
export type GetAppInfoIpc = z.infer<typeof GetAppInfoIpcSchema>;

// ==========================================
// PR #14: Verification Commands Configuration Schemas
// ==========================================

export const GetVerificationCommandsIpcSchema = z
  .object({
    projectId: requiredIpcString(),
  })
  .strict();
export type GetVerificationCommandsIpc = z.infer<typeof GetVerificationCommandsIpcSchema>;

export const SaveVerificationCommandsIpcSchema = z
  .object({
    projectId: requiredIpcString(),
    commands: z
      .object({
        TEST: boundedString(z.string().max(1000)).optional().nullable(),
        LINT: boundedString(z.string().max(1000)).optional().nullable(),
        BUILD: boundedString(z.string().max(1000)).optional().nullable(),
      })
      .strict(),
  })
  .strict();
export type SaveVerificationCommandsIpc = z.infer<typeof SaveVerificationCommandsIpcSchema>;

// ==========================================
// R5J5: Quarantined Submission Adjudication Schemas
// ==========================================

export const ListQuarantinedSubmissionsIpcSchema = z
  .object({
    projectId: boundedString(z.string().min(1)).optional(),
    taskId: boundedString(z.string().min(1)).optional(),
    limit: z.number().int().min(1).max(100).optional().default(50),
    offset: z.number().int().min(0).optional().default(0),
    reverse: z.boolean().optional().default(false),
  })
  .strict();
export type ListQuarantinedSubmissionsIpc = z.infer<typeof ListQuarantinedSubmissionsIpcSchema>;

export const InspectQuarantinedSubmissionIpcSchema = z
  .object({
    submissionId: boundedString(z.string().uuid('A valid UUID submission ID is required')),
  })
  .strict();
export type InspectQuarantinedSubmissionIpc = z.infer<typeof InspectQuarantinedSubmissionIpcSchema>;

export const AdmitQuarantinedSubmissionIpcSchema = z
  .object({
    requestId: boundedString(z.string().uuid('A valid UUID request ID is required')),
    submissionId: boundedString(z.string().uuid('A valid UUID submission ID is required')),
    expectedLifecycleVersion: z.number().int().nonnegative('Expected lifecycle version must be non-negative').optional(),
  })
  .strict();
export type AdmitQuarantinedSubmissionIpc = z.infer<typeof AdmitQuarantinedSubmissionIpcSchema>;

export const RejectQuarantinedSubmissionIpcSchema = z
  .object({
    requestId: boundedString(z.string().uuid('A valid UUID request ID is required')),
    submissionId: boundedString(z.string().uuid('A valid UUID submission ID is required')),
    expectedLifecycleVersion: z.number().int().nonnegative('Expected lifecycle version must be non-negative'),
    reason: boundedString(z.string().min(1, 'Reason is required').max(1000)),
  })
  .strict();
export type RejectQuarantinedSubmissionIpc = z.infer<typeof RejectQuarantinedSubmissionIpcSchema>;

export const SupersedeQuarantinedSubmissionIpcSchema = z
  .object({
    requestId: boundedString(z.string().uuid('A valid UUID request ID is required')),
    submissionId: boundedString(z.string().uuid('A valid UUID submission ID is required')),
    expectedLifecycleVersion: z.number().int().nonnegative('Expected lifecycle version must be non-negative'),
    replacementSubmissionId: boundedString(z.string().uuid('A valid UUID replacement submission ID is required')),
    reason: boundedString(z.string().min(1, 'Reason is required').max(1000)),
  })
  .strict();
export type SupersedeQuarantinedSubmissionIpc = z.infer<typeof SupersedeQuarantinedSubmissionIpcSchema>;

export const ResumeAdmittedSubmissionIpcSchema = z
  .object({
    requestId: boundedString(z.string().uuid('A valid UUID request ID is required')),
    submissionId: boundedString(z.string().uuid('A valid UUID submission ID is required')),
    adjudicationId: requiredIpcString(),
    expectedLifecycleVersion: z.number().int().positive('Expected lifecycle version must be a positive integer'),
  })
  .strict();
export type ResumeAdmittedSubmissionIpc = z.infer<typeof ResumeAdmittedSubmissionIpcSchema>;

export const AcknowledgeRecoveryFencedIpcSchema = z
  .object({
    requestId: boundedString(z.string().uuid('A valid UUID request ID is required')),
    submissionId: boundedString(z.string().uuid('A valid UUID submission ID is required')),
    adjudicationId: requiredIpcString(),
    expectedLifecycleVersion: z.number().int().positive('Expected lifecycle version must be a positive integer'),
    decision: z.enum(['ACKNOWLEDGE', 'CANCEL']),
  })
  .strict();
export type AcknowledgeRecoveryFencedIpc = z.infer<typeof AcknowledgeRecoveryFencedIpcSchema>;
