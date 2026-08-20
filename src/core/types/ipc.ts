import { z } from 'zod';

// Strict Zod schemas for all IPC channels across the main process security boundary

export const CreateProjectIpcSchema = z.object({
  name: z.string().min(1, 'Project name is required').max(100),
  description: z.string().max(500).optional().default(''),
  repositorySelectionId: z.string().uuid('A valid native repository selection token is required'),
  defaultBranch: z.string().optional().default('main'),
});
export type CreateProjectIpc = z.infer<typeof CreateProjectIpcSchema>;

export const ImportContractIpcSchema = z.object({
  projectId: z.string().min(1),
  contract: z.object({
    goal: z.string().min(1),
    business_context: z.string().optional(),
    architecture_constraints: z.array(z.string()).default([]),
    technical_constraints: z.array(z.string()).default([]),
    security_requirements: z.array(z.string()).default([]),
    acceptance_criteria: z.array(z.string()).default([]),
    non_goals: z.array(z.string()).default([]),
    definition_of_done: z.array(z.string()).default([]),
    testing_requirements: z.array(z.string()).default([]),
    owner_policies: z.array(z.string()).default([]),
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
  projectId: z.string().min(1, 'Project ID is required'),
  trigger: ProjectTriggerSchema,
});
export type TransitionProjectIpc = z.infer<typeof TransitionProjectIpcSchema>;

export const CreateTaskIpcSchema = z.object({
  projectId: z.string().min(1, 'Project ID is required'),
  id: z.string().optional(),
  milestoneId: z.string().nullable().optional(),
  title: z.string().min(1, 'Task title is required').max(200),
  description: z.string().nullable().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  acceptanceCriteria: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
});
export type CreateTaskIpc = z.infer<typeof CreateTaskIpcSchema>;

export const ParseProtocolIpcSchema = z.object({
  rawInput: z.string().min(1, 'Protocol input text is required'),
});
export type ParseProtocolIpc = z.infer<typeof ParseProtocolIpcSchema>;

export const ApplyProtocolIpcSchema = z.object({
  rawInput: z.string().min(1, 'Raw protocol input is required'),
});
export type ApplyProtocolIpc = z.infer<typeof ApplyProtocolIpcSchema>;

export const GenerateWorkOrderIpcSchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().min(1),
});

export const GenerateReviewPackageIpcSchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().min(1),
});

export const ProjectScopedIpcSchema = z.object({
  projectId: z.string().min(1),
});

export const TaskScopedIpcSchema = z.object({
  taskId: z.string().min(1),
});

export const RunVerificationIpcSchema = z.object({
  taskId: z.string().min(1),
  commandConfigId: z.string().optional(),
});
export type RunVerificationIpc = z.infer<typeof RunVerificationIpcSchema>;

export const UpdateResourceQuotaIpcSchema = z.object({
  id: z.string().min(1),
  remaining: z.number().nullable(),
  total: z.number().nullable(),
  source: z.enum(['MEASURED', 'PROVIDER_REPORTED', 'MANUAL', 'ESTIMATED', 'UNKNOWN']),
  confidence: z.number().min(0).max(1),
});
export type UpdateResourceQuotaIpc = z.infer<typeof UpdateResourceQuotaIpcSchema>;

/**
 * Emergency Stop Schema.
 * Uses deliberate fail-safe semantics: if no reason or an empty object is supplied,
 * it safely defaults to 'Manual Owner Emergency Stop' rather than rejecting the safety action.
 */
export const EmergencyStopIpcSchema = z.object({
  reason: z.string().optional().default('Manual Owner Emergency Stop'),
});
export type EmergencyStopIpc = z.infer<typeof EmergencyStopIpcSchema>;

export const ResumeProjectIpcSchema = z.object({
  projectId: z.string().min(1),
});
export type ResumeProjectIpc = z.infer<typeof ResumeProjectIpcSchema>;

// ==========================================
// PR #8: Owner Routing & Manual Bridge Handoff Schemas
// ==========================================

export const RouteTaskIpcSchema = z
  .object({
    projectId: z.string().min(1, 'Project ID is required'),
    taskId: z.string().min(1, 'Task ID is required'),
    attemptId: z.string().nullable().optional(),
    candidateResourceIds: z
      .array(z.string().min(1, 'Candidate resource ID cannot be empty'))
      .min(1, 'At least one candidate resource is required'),
    allowManualBridge: z.boolean().default(false),
  })
  .strict();
export type RouteTaskIpc = z.infer<typeof RouteTaskIpcSchema>;

export const AuthorizeRoutedTaskIpcSchema = z
  .object({
    projectId: z.string().min(1, 'Project ID is required'),
    taskId: z.string().min(1, 'Task ID is required'),
    attemptId: z.string().nullable().optional(),
    routingDecisionId: z.string().min(1, 'Routing decision ID is required'),
    contextFiles: z.array(z.string()).optional().default([]),
  })
  .strict();
export type AuthorizeRoutedTaskIpc = z.infer<typeof AuthorizeRoutedTaskIpcSchema>;

export const DispatchAuthorizationIpcSchema = z
  .object({
    authorizationId: z.string().min(1, 'Authorization ID is required'),
  })
  .strict();
export type DispatchAuthorizationIpc = z.infer<typeof DispatchAuthorizationIpcSchema>;

export const GetOwnerHandoffSnapshotIpcSchema = z
  .object({
    taskId: z.string().min(1, 'Task ID is required'),
  })
  .strict();
export type GetOwnerHandoffSnapshotIpc = z.infer<typeof GetOwnerHandoffSnapshotIpcSchema>;

export const GenerateAuthorizedWorkOrderIpcSchema = z
  .object({
    authorizationId: z.string().min(1, 'Authorization ID is required'),
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
    projectId: z.string().min(1, 'Project ID is required'),
  })
  .strict();
export type GetVerificationCommandsIpc = z.infer<typeof GetVerificationCommandsIpcSchema>;

export const SaveVerificationCommandsIpcSchema = z
  .object({
    projectId: z.string().min(1, 'Project ID is required'),
    commands: z
      .object({
        TEST: z.string().max(1000).optional().nullable(),
        LINT: z.string().max(1000).optional().nullable(),
        BUILD: z.string().max(1000).optional().nullable(),
      })
      .strict(),
  })
  .strict();
export type SaveVerificationCommandsIpc = z.infer<typeof SaveVerificationCommandsIpcSchema>;
