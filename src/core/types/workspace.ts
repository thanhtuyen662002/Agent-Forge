import { z } from 'zod';
import { AgentRoleEnum } from './domain';
import type { Agent, AgentRole, Capability, FabricRole, ProviderHealthStatus, WorkerSlotStatus } from './domain';

/** Agent row including the roster lifecycle columns added by migration 027. */
export interface ManagedAgent extends Agent {
  /** Durable AgentProfile configured through owner agent management, if any. */
  agent_profile_id?: string | null;
  /** Set when the owner removed the agent from the active roster; history is retained. */
  removed_at?: string | null;
}

/**
 * How an owner-created agent reaches its model. Each option maps onto an
 * adapter that is actually registered in the desktop ProviderRegistry; there
 * is no option for providers Agent Forge cannot run.
 */
export const AgentConnectionKindEnum = z.enum(['MANUAL_BRIDGE', 'CODEX_CLI', 'GEMINI_CLI']);
export type AgentConnectionKind = z.infer<typeof AgentConnectionKindEnum>;

/** Bounded like the self-host runtime (`MAX_AGY_WORKERS` accepts 1 or 2). */
export const MAX_AGENT_WORKER_SLOTS = 2;

const ownerText = (max: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1).max(max).regex(/^[^\x00-\x1f\x7f]*$/, 'Control characters are not allowed.'));

const optionalInstructions = z
  .string()
  .max(8000)
  .transform((value) => value.trim())
  .nullable()
  .optional();

export const CreateAgentIpcSchema = z
  .object({
    displayName: ownerText(80),
    role: AgentRoleEnum,
    connection: AgentConnectionKindEnum,
    modelName: ownerText(120),
    profileId: z
      .string()
      .transform((value) => value.trim().toLowerCase())
      .pipe(z.string().max(64).regex(/^[a-z0-9_.-]*$/, 'Profile name may use letters, digits, ".", "_" and "-".'))
      .optional(),
    workerSlots: z.number().int().min(1).max(MAX_AGENT_WORKER_SLOTS).default(1),
    instructions: optionalInstructions,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.profileId && value.profileId.includes('..')) {
      ctx.addIssue({ code: 'custom', path: ['profileId'], message: 'Profile name cannot contain "..".' });
    }
    if (value.connection === 'MANUAL_BRIDGE' && value.workerSlots !== 1) {
      ctx.addIssue({ code: 'custom', path: ['workerSlots'], message: 'Manual Bridge agents are relayed by the owner and use no worker slots.' });
    }
  });
export type CreateAgentIpc = z.infer<typeof CreateAgentIpcSchema>;

export const UpdateAgentIpcSchema = z
  .object({
    agentId: ownerText(200),
    displayName: ownerText(80).optional(),
    modelName: ownerText(120).optional(),
    instructions: optionalInstructions,
  })
  .strict();
export type UpdateAgentIpc = z.infer<typeof UpdateAgentIpcSchema>;

export const AgentIdIpcSchema = z.object({ agentId: ownerText(200) }).strict();

export type AgentWorkBlockerCode =
  | 'CURRENT_TASK'
  | 'AGENT_BUSY'
  | 'REVIEWER_SESSION'
  | 'ACTIVE_ASSIGNMENT'
  | 'PENDING_AUTHORIZATION'
  | 'IN_FLIGHT_EXECUTION'
  | 'BUSY_WORKER_SLOT'
  | 'ACTIVE_ACCOUNT_LEASE';

export interface AgentWorkBlocker {
  code: AgentWorkBlockerCode;
  reference: string;
}

export type AgentManagementErrorCode =
  | 'INVALID_INPUT'
  | 'AGENT_NOT_FOUND'
  | 'AGENT_ALREADY_REMOVED'
  | 'AGENT_NOT_REMOVED'
  | 'AGENT_HAS_ACTIVE_WORK'
  | 'PROFILE_ALREADY_IN_USE'
  | 'INTERNAL_ERROR';

export type AgentManagementResult =
  | { success: true; agent: ManagedAgent }
  | { success: false; errorCode: AgentManagementErrorCode; error: string; blockers?: AgentWorkBlocker[] };

/** Read model joining every separated identity an agent is bound to. */
export interface AgentRosterEntry {
  agent: ManagedAgent;
  roleProfile: { id: string; role: FabricRole; displayName: string } | null;
  agentProfile: { id: string; name: string; instructions: string | null } | null;
  provider: { id: string; name: string; adapterType: string } | null;
  account: { id: string; label: string; authMode: string; profileRef: string | null; healthStatus: ProviderHealthStatus; enabled: boolean } | null;
  resource: { id: string; modelName: string; enabled: boolean; capabilities: Capability[]; healthStatus: ProviderHealthStatus } | null;
  workerSlots: Array<{ id: string; slotIndex: number; status: WorkerSlotStatus }>;
  connection: AgentConnectionKind | 'OTHER';
  blockers: AgentWorkBlocker[];
}

export const AGENT_ROLE_FABRIC_ROLE: Record<AgentRole, FabricRole> = {
  PRIMARY_MANAGER: 'MANAGER',
  BACKUP_MANAGER: 'MANAGER',
  CODER: 'CODER',
  REVIEWER: 'REVIEWER',
  TOOL: 'TOOL',
};
