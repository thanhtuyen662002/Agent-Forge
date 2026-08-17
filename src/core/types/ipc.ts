import { z } from 'zod';

// Zod schemas for all IPC requests to enforce main process security boundary

export const CreateProjectIpcSchema = z.object({
  name: z.string().min(1, 'Project name is required'),
  description: z.string().optional().default(''),
  repositoryPath: z.string().min(1, 'Repository path is required'),
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

export const TransitionProjectIpcSchema = z.object({
  projectId: z.string().min(1),
  trigger: z.string().min(1),
});
export type TransitionProjectIpc = z.infer<typeof TransitionProjectIpcSchema>;

export const GetTasksIpcSchema = z.object({
  projectId: z.string().min(1),
});

export const GetTaskIpcSchema = z.object({
  taskId: z.string().min(1),
});

export const CreateTaskIpcSchema = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  milestone_id: z.string().nullable().optional(),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  acceptance_criteria: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
});
export type CreateTaskIpc = z.infer<typeof CreateTaskIpcSchema>;

export const ParseProtocolIpcSchema = z.object({
  input: z.string().min(1, 'Protocol input text is required'),
});

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

export const EmergencyStopIpcSchema = z.object({
  reason: z.string().optional().default('Manual Owner Emergency Stop'),
});

export const ResumeProjectIpcSchema = z.object({
  projectId: z.string().min(1),
});
