import crypto from 'crypto';
import { Repository } from '../database/repositories';
import { EventService } from './EventService';
import { isValidNativeProfileRef, parseNativeProfileRef } from '../credentials/NativeProfileRef';
import type { AgentRole, Capability, FabricRole, Provider, RoleProfile } from '../types/domain';
import {
  AGENT_ROLE_FABRIC_ROLE,
  AgentIdIpcSchema,
  CreateAgentIpcSchema,
  ProjectTrashIpcSchema,
  TaskTrashIpcSchema,
  UpdateAgentIpcSchema,
} from '../types/workspace';
import type {
  AgentConnectionKind,
  AgentManagementErrorCode,
  AgentManagementResult,
  AgentRosterEntry,
  AgentWorkBlocker,
  ManagedAgent,
  TrashBlocker,
  TrashErrorCode,
  TrashListing,
  TrashMutationResult,
} from '../types/workspace';

const MANUAL_BRIDGE_PROVIDER_ID = 'prov-manual-bridge';

/** Local CLI providers whose adapters the desktop registry actually registers. */
const CLI_PROVIDERS: Record<Exclude<AgentConnectionKind, 'MANUAL_BRIDGE'>, { id: string; name: string; profileProvider: string }> = {
  CODEX_CLI: { id: 'prov-codex-cli', name: 'Codex CLI', profileProvider: 'codex' },
  GEMINI_CLI: { id: 'prov-gemini-cli', name: 'Gemini CLI', profileProvider: 'gemini' },
  CLAUDE_CODE_CLI: { id: 'prov-claude-code-cli', name: 'Claude Code CLI', profileProvider: 'claude' },
  ANTIGRAVITY_CLI: { id: 'prov-antigravity-cli', name: 'Antigravity CLI', profileProvider: 'antigravity' },
};

const ROLE_CAPABILITIES: Record<FabricRole, Capability[]> = {
  MANAGER: ['PLANNING', 'REVIEW', 'LARGE_CONTEXT'],
  PLANNER: ['PLANNING', 'LARGE_CONTEXT'],
  CODER: ['CODING', 'FILESYSTEM_EDIT', 'TEST_EXECUTION'],
  REVIEWER: ['REVIEW', 'SECURITY_REVIEW'],
  SECURITY_REVIEWER: ['SECURITY_REVIEW', 'REVIEW'],
  RESEARCHER: ['LARGE_CONTEXT', 'WEB_ACCESS'],
  RELEASE_MANAGER: ['PLANNING', 'REVIEW'],
  MONITOR: ['TERMINAL'],
  TOOL: ['TERMINAL'],
};

const ROLE_OUTPUT_PROTOCOL: Partial<Record<FabricRole, string>> = {
  MANAGER: 'manager.v1',
  CODER: 'coder.v1',
  REVIEWER: 'coder-report.v1',
};

const PROJECT_ACTIVE_STATUSES = new Set(['RUNNING', 'FINAL_REVIEW', 'WAITING_FOR_CAPACITY']);

class TrashError extends Error {
  constructor(
    readonly errorCode: TrashErrorCode,
    message: string,
    readonly blockers?: TrashBlocker[],
  ) {
    super(message);
  }
}

class AgentManagementError extends Error {
  constructor(
    readonly errorCode: AgentManagementErrorCode,
    message: string,
    readonly blockers?: AgentWorkBlocker[],
  ) {
    super(message);
  }
}

/**
 * Owner-facing agent roster management. Creating an agent provisions the
 * separated role/profile/provider/account/resource/slot identities in one
 * immediate transaction. Removal only parks an idle agent off the active
 * roster; durable history that references it is never deleted.
 */
export class WorkspaceManagementService {
  constructor(
    private readonly repo: Repository,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public listAgents(options: { includeRemoved?: boolean } = {}): AgentRosterEntry[] {
    return this.repo.runInReadTransaction(() => {
      const nowIso = this.now();
      const providers = new Map(this.repo.getAllProviders().map((p) => [p.id, p]));
      const resources = new Map(this.repo.getAllProviderResources().map((r) => [r.id, r]));
      const accounts = new Map(this.repo.getAllProviderAccounts().map((a) => [a.id, a]));
      const slots = this.repo.getAllWorkerSlots();
      return this.repo
        .getAllAgents()
        .filter((agent) => options.includeRemoved || !agent.removed_at)
        .map((agent): AgentRosterEntry => {
          const resource = agent.provider_resource_id ? resources.get(agent.provider_resource_id) ?? null : null;
          const provider = resource ? providers.get(resource.provider_id) ?? null : null;
          const account = resource?.provider_account_id ? accounts.get(resource.provider_account_id) ?? null : null;
          const agentProfile = agent.agent_profile_id ? this.repo.getAgentProfile(agent.agent_profile_id) : null;
          const roleProfile = agentProfile ? this.repo.getRoleProfile(agentProfile.role_profile_id) : null;
          return {
            agent,
            roleProfile: roleProfile ? { id: roleProfile.id, role: roleProfile.role, displayName: roleProfile.display_name } : null,
            agentProfile: agentProfile ? { id: agentProfile.id, name: agentProfile.name, instructions: agentProfile.prompt_template } : null,
            provider: provider ? { id: provider.id, name: provider.name, adapterType: provider.adapter_type } : null,
            account: account
              ? {
                  id: account.id,
                  label: account.label,
                  authMode: account.auth_mode,
                  profileRef: account.profile_ref,
                  healthStatus: account.health_status,
                  enabled: account.enabled,
                }
              : null,
            resource: resource
              ? {
                  id: resource.id,
                  modelName: resource.model_name,
                  enabled: resource.enabled,
                  capabilities: resource.capabilities,
                  healthStatus: resource.health_status,
                }
              : null,
            workerSlots: resource
              ? slots
                  .filter((slot) => slot.provider_resource_id === resource.id)
                  .sort((a, b) => a.slot_index - b.slot_index)
                  .map((slot) => ({ id: slot.id, slotIndex: slot.slot_index, status: slot.status }))
              : [],
            connection: this.connectionOf(provider),
            blockers: this.repo.getAgentActiveWorkBlockers(agent.id, nowIso) as AgentWorkBlocker[],
          };
        });
    });
  }

  public createAgent(payload: unknown): AgentManagementResult {
    const parsed = CreateAgentIpcSchema.safeParse(payload);
    if (!parsed.success) return this.invalid(parsed.error.issues.map((i) => i.message).join(', '));
    const input = parsed.data;

    return this.mutate(() => {
      const nowIso = this.now();
      const suffix = crypto.randomUUID();
      const fabricRole = AGENT_ROLE_FABRIC_ROLE[input.role];
      const roleProfile = this.ensureRoleProfile(fabricRole, nowIso);

      const agentProfileId = `agent-profile-${suffix}`;
      this.repo.createAgentProfile({
        id: agentProfileId,
        role_profile_id: roleProfile.id,
        name: input.displayName,
        prompt_template: input.instructions || null,
        config: { connection: input.connection },
        enabled: true,
        created_at: nowIso,
        updated_at: nowIso,
      });

      const resourceId = `res-${suffix}`;
      let accountId: string | null = null;
      let providerId = MANUAL_BRIDGE_PROVIDER_ID;

      if (input.connection === 'MANUAL_BRIDGE') {
        if (!this.repo.getProvider(MANUAL_BRIDGE_PROVIDER_ID)) {
          this.repo.createProvider({
            id: MANUAL_BRIDGE_PROVIDER_ID,
            name: 'Owner Manual Bridge',
            adapter_type: 'MANUAL_BRIDGE',
            enabled: true,
            created_at: nowIso,
          });
        }
      } else {
        const cli = CLI_PROVIDERS[input.connection];
        providerId = cli.id;
        if (!this.repo.getProvider(cli.id)) {
          this.repo.createProvider({ id: cli.id, name: cli.name, adapter_type: 'LOCAL_CLI', enabled: true, created_at: nowIso });
        }
        const profileId = input.profileId || this.defaultProfileId(input.displayName, suffix);
        const rawRef = `native-profile://${cli.profileProvider}/${profileId}`;
        if (!isValidNativeProfileRef(rawRef)) {
          throw new AgentManagementError('INVALID_INPUT', `Profile name "${profileId}" is not a valid native profile identifier.`);
        }
        const profileRef = parseNativeProfileRef(rawRef).toUriString();
        if (this.repo.getAllProviderAccounts().some((account) => account.profile_ref === profileRef)) {
          throw new AgentManagementError('PROFILE_ALREADY_IN_USE', `Native profile "${profileRef}" is already bound to another account.`);
        }
        accountId = `acct-${suffix}`;
        this.repo.createProviderAccount({
          id: accountId,
          provider_id: cli.id,
          label: input.displayName,
          auth_mode: 'NATIVE_PROFILE',
          credential_ref: null,
          profile_ref: profileRef,
          enabled: true,
          priority: 0,
          // Unknown until a supported health/quota observation proves otherwise.
          health_status: 'UNKNOWN',
          cooldown_until: null,
          concurrency_limit: input.workerSlots,
          last_success_at: null,
          last_failure_at: null,
          last_failure_code: null,
          created_at: nowIso,
          updated_at: nowIso,
        });
      }

      this.repo.createProviderResource({
        id: resourceId,
        provider_id: providerId,
        provider_account_id: accountId,
        model_name: input.modelName,
        health_status: 'UNKNOWN',
        capabilities: ROLE_CAPABILITIES[fabricRole],
        enabled: true,
        total_quota: null,
        remaining_quota: null,
        quota_unit: 'REQUESTS',
        quota_reset_at: null,
        quota_source: 'UNKNOWN',
        quota_confidence: 0,
        last_health_check: null,
      });

      if (accountId) {
        for (let index = 1; index <= input.workerSlots; index += 1) {
          this.repo.createWorkerSlot({
            id: `slot-${suffix}-${index}`,
            provider_account_id: accountId,
            provider_resource_id: resourceId,
            slot_index: index,
            status: 'IDLE',
            current_assignment_id: null,
            current_execution_id: null,
            heartbeat_at: null,
            created_at: nowIso,
            updated_at: nowIso,
          });
        }
      }

      const agent: ManagedAgent = {
        id: `agent-${suffix}`,
        display_name: input.displayName,
        role: input.role,
        provider_resource_id: resourceId,
        status: 'IDLE',
        current_task_id: null,
        last_seen_at: nowIso,
        agent_profile_id: agentProfileId,
        removed_at: null,
      };
      this.repo.createAgent(agent);
      return agent.id;
    });
  }

  public updateAgent(payload: unknown): AgentManagementResult {
    const parsed = UpdateAgentIpcSchema.safeParse(payload);
    if (!parsed.success) return this.invalid(parsed.error.issues.map((i) => i.message).join(', '));
    const input = parsed.data;

    return this.mutate(() => {
      const nowIso = this.now();
      const agent = this.requireAgent(input.agentId);
      if (agent.removed_at) {
        throw new AgentManagementError('AGENT_ALREADY_REMOVED', 'Restore the agent before editing it.');
      }

      if (input.modelName !== undefined && agent.provider_resource_id) {
        const resource = this.repo.getProviderResource(agent.provider_resource_id);
        if (resource && resource.model_name !== input.modelName) {
          // A pending authorization or running execution reads this resource; changing the model under it would
          // let approved work run against a different model than the one the owner saw.
          const blockers = this.repo.getAgentActiveWorkBlockers(agent.id, nowIso) as AgentWorkBlocker[];
          if (blockers.length > 0) {
            throw new AgentManagementError('AGENT_HAS_ACTIVE_WORK', 'The model cannot change while the agent has active work.', blockers);
          }
          this.repo.updateProviderResourceModelName(resource.id, input.modelName);
        }
      }

      if (input.displayName !== undefined && input.displayName !== agent.display_name) {
        this.repo.updateAgentDisplayName(agent.id, input.displayName);
      }

      const profileId = agent.agent_profile_id;
      if (profileId && (input.displayName !== undefined || input.instructions !== undefined)) {
        this.repo.updateAgentProfile(profileId, {
          ...(input.displayName !== undefined ? { name: input.displayName } : {}),
          ...(input.instructions !== undefined ? { prompt_template: input.instructions || null } : {}),
        });
      } else if (!profileId && input.instructions) {
        const roleProfile = this.ensureRoleProfile(AGENT_ROLE_FABRIC_ROLE[agent.role as AgentRole], nowIso);
        const newProfileId = `agent-profile-${crypto.randomUUID()}`;
        this.repo.createAgentProfile({
          id: newProfileId,
          role_profile_id: roleProfile.id,
          name: input.displayName ?? agent.display_name,
          prompt_template: input.instructions,
          config: null,
          enabled: true,
          created_at: nowIso,
          updated_at: nowIso,
        });
        this.repo.setAgentProfileId(agent.id, newProfileId);
      }
      return agent.id;
    });
  }

  public removeAgent(payload: unknown): AgentManagementResult {
    const parsed = AgentIdIpcSchema.safeParse(payload);
    if (!parsed.success) return this.invalid(parsed.error.issues.map((i) => i.message).join(', '));

    return this.mutate(() => {
      const nowIso = this.now();
      const agent = this.requireAgent(parsed.data.agentId);
      if (agent.removed_at) throw new AgentManagementError('AGENT_ALREADY_REMOVED', 'The agent is already removed.');
      const blockers = this.repo.getAgentActiveWorkBlockers(agent.id, nowIso) as AgentWorkBlocker[];
      if (blockers.length > 0) {
        throw new AgentManagementError('AGENT_HAS_ACTIVE_WORK', 'The agent still has active work and cannot be removed.', blockers);
      }

      this.repo.setAgentRemoved(agent.id, nowIso);
      if (agent.agent_profile_id) this.repo.updateAgentProfile(agent.agent_profile_id, { enabled: false });
      if (agent.provider_resource_id && !this.resourceSharedWithActiveAgent(agent.provider_resource_id, agent.id)) {
        this.repo.setProviderResourceEnabled(agent.provider_resource_id, false);
        for (const slot of this.repo.getAllWorkerSlots()) {
          if (slot.provider_resource_id === agent.provider_resource_id && slot.status !== 'DISABLED') {
            this.repo.updateWorkerSlotStatus(slot.id, 'DISABLED');
          }
        }
      }
      return agent.id;
    });
  }

  public restoreAgent(payload: unknown): AgentManagementResult {
    const parsed = AgentIdIpcSchema.safeParse(payload);
    if (!parsed.success) return this.invalid(parsed.error.issues.map((i) => i.message).join(', '));

    return this.mutate(() => {
      const agent = this.requireAgent(parsed.data.agentId);
      if (!agent.removed_at) throw new AgentManagementError('AGENT_NOT_REMOVED', 'The agent is already on the active roster.');

      this.repo.setAgentRemoved(agent.id, null);
      if (agent.agent_profile_id) this.repo.updateAgentProfile(agent.agent_profile_id, { enabled: true });
      if (agent.provider_resource_id) {
        this.repo.setProviderResourceEnabled(agent.provider_resource_id, true);
        for (const slot of this.repo.getAllWorkerSlots()) {
          if (slot.provider_resource_id === agent.provider_resource_id && slot.status === 'DISABLED') {
            this.repo.updateWorkerSlotStatus(slot.id, 'IDLE');
          }
        }
      }
      return agent.id;
    });
  }

  // ==========================================
  // Project / task trash
  // ==========================================

  public listTrash(): TrashListing {
    return this.repo.runInReadTransaction(() => {
      const listing: TrashListing = { projects: [], tasks: [] };
      for (const entry of this.repo.getTrashEntries()) {
        const project = this.repo.getProjectMetadata(entry.project_id);
        if (!project) continue;
        if (entry.entity_type === 'PROJECT') {
          listing.projects.push({ id: project.id, name: project.name, status: project.status, trashedAt: entry.trashed_at });
        } else {
          const task = this.repo.getTask(entry.entity_id);
          if (!task) continue;
          listing.tasks.push({
            id: task.id, title: task.title, state: task.state,
            projectId: project.id, projectName: project.name, trashedAt: entry.trashed_at,
          });
        }
      }
      return listing;
    });
  }

  /**
   * Moves an idle project to the trash. Every still-AUTHORIZED execution of its
   * tasks is invalidated in the same transaction, so restoring the project can
   * never revive approved work; the dispatch claim CAS rejects it afterwards.
   */
  public trashProject(payload: unknown): TrashMutationResult {
    const parsed = ProjectTrashIpcSchema.safeParse(payload);
    if (!parsed.success) return this.trashInvalid(parsed.error.issues.map((i) => i.message).join(', '));
    return this.trashMutate(() => {
      const nowIso = this.now();
      const project = this.repo.getProjectMetadata(parsed.data.projectId);
      if (!project) throw new TrashError('PROJECT_NOT_FOUND', `Project "${parsed.data.projectId}" was not found.`);
      if (this.repo.isProjectTrashed(project.id)) throw new TrashError('ALREADY_IN_TRASH', 'The project is already in the trash.');

      const blockers: TrashBlocker[] = [];
      if (PROJECT_ACTIVE_STATUSES.has(project.status)) blockers.push({ code: 'PROJECT_RUNNING', reference: project.status });
      const tasks = this.repo.getTasksByProject(project.id);
      for (const task of tasks) {
        // A task already in the trash (such as the APPROVED planning record, #245)
        // is not active work by its state; live leases or executions still block.
        const trashed = this.repo.isTaskTrashed(task.id);
        for (const blocker of this.repo.getTaskTrashBlockers(task.id) as TrashBlocker[]) {
          if (trashed && blocker.code === 'TASK_ACTIVE_STATE') continue;
          blockers.push({ ...blocker, taskId: task.id });
        }
      }
      if (blockers.length > 0) throw new TrashError('HAS_ACTIVE_WORK', 'The project still has active work.', blockers);

      let invalidated = 0;
      for (const task of tasks) invalidated += this.repo.invalidateAuthorizedExecutionAuthorizationsForTask(task.id);
      this.repo.insertTrashEntry('PROJECT', project.id, project.id, nowIso);
      this.events().record(project.id, 'PROJECT_TRASHED', `Owner moved project "${project.name}" to the trash.`, {
        invalidatedAuthorizations: invalidated,
      });
      return { success: true, entityType: 'PROJECT', entityId: project.id, invalidatedAuthorizations: invalidated };
    });
  }

  public restoreProject(payload: unknown): TrashMutationResult {
    const parsed = ProjectTrashIpcSchema.safeParse(payload);
    if (!parsed.success) return this.trashInvalid(parsed.error.issues.map((i) => i.message).join(', '));
    return this.trashMutate(() => {
      const project = this.repo.getProjectMetadata(parsed.data.projectId);
      if (!project) throw new TrashError('PROJECT_NOT_FOUND', `Project "${parsed.data.projectId}" was not found.`);
      if (!this.repo.deleteTrashEntry('PROJECT', project.id)) throw new TrashError('NOT_IN_TRASH', 'The project is not in the trash.');
      this.events().record(project.id, 'PROJECT_RESTORED', `Owner restored project "${project.name}" from the trash.`);
      return { success: true, entityType: 'PROJECT', entityId: project.id, invalidatedAuthorizations: 0 };
    });
  }

  public trashTask(payload: unknown): TrashMutationResult {
    const parsed = TaskTrashIpcSchema.safeParse(payload);
    if (!parsed.success) return this.trashInvalid(parsed.error.issues.map((i) => i.message).join(', '));
    return this.trashMutate(() => {
      const nowIso = this.now();
      const task = this.repo.getTask(parsed.data.taskId);
      if (!task) throw new TrashError('TASK_NOT_FOUND', `Task "${parsed.data.taskId}" was not found.`);
      if (this.repo.isTaskTrashed(task.id)) throw new TrashError('ALREADY_IN_TRASH', 'The task or its project is already in the trash.');
      const blockers = this.repo.getTaskTrashBlockers(task.id) as TrashBlocker[];
      if (blockers.length > 0) throw new TrashError('HAS_ACTIVE_WORK', 'The task still has active work.', blockers);

      const invalidated = this.repo.invalidateAuthorizedExecutionAuthorizationsForTask(task.id);
      this.repo.insertTrashEntry('TASK', task.id, task.project_id, nowIso);
      this.events().record(task.project_id, 'TASK_TRASHED', `Owner moved task "${task.title}" to the trash.`, {
        invalidatedAuthorizations: invalidated,
      }, task.id);
      return { success: true, entityType: 'TASK', entityId: task.id, invalidatedAuthorizations: invalidated };
    });
  }

  public restoreTask(payload: unknown): TrashMutationResult {
    const parsed = TaskTrashIpcSchema.safeParse(payload);
    if (!parsed.success) return this.trashInvalid(parsed.error.issues.map((i) => i.message).join(', '));
    return this.trashMutate(() => {
      const task = this.repo.getTask(parsed.data.taskId);
      if (!task) throw new TrashError('TASK_NOT_FOUND', `Task "${parsed.data.taskId}" was not found.`);
      if (this.repo.isProjectTrashed(task.project_id)) {
        throw new TrashError('PROJECT_IN_TRASH', 'Restore the project before restoring its tasks.');
      }
      if (!this.repo.deleteTrashEntry('TASK', task.id)) throw new TrashError('NOT_IN_TRASH', 'The task is not in the trash.');
      this.events().record(task.project_id, 'TASK_RESTORED', `Owner restored task "${task.title}" from the trash.`, {}, task.id);
      return { success: true, entityType: 'TASK', entityId: task.id, invalidatedAuthorizations: 0 };
    });
  }

  private events(): EventService {
    return new EventService(this.repo);
  }

  private trashMutate(fn: () => TrashMutationResult): TrashMutationResult {
    try {
      return this.repo.runInImmediateTransaction(fn);
    } catch (err) {
      if (err instanceof TrashError) {
        return { success: false, errorCode: err.errorCode, error: err.message, ...(err.blockers ? { blockers: err.blockers } : {}) };
      }
      return { success: false, errorCode: 'INTERNAL_ERROR', error: 'The change could not be saved.' };
    }
  }

  private trashInvalid(message: string): TrashMutationResult {
    return { success: false, errorCode: 'INVALID_INPUT', error: message || 'Invalid input.' };
  }

  private mutate(fn: () => string): AgentManagementResult {
    try {
      const agentId = this.repo.runInImmediateTransaction(fn);
      const agent = this.repo.getAgent(agentId);
      if (!agent) return { success: false, errorCode: 'INTERNAL_ERROR', error: 'Agent was not persisted.' };
      return { success: true, agent };
    } catch (err) {
      if (err instanceof AgentManagementError) {
        return {
          success: false,
          errorCode: err.errorCode,
          error: err.message,
          ...(err.blockers ? { blockers: err.blockers } : {}),
        };
      }
      return { success: false, errorCode: 'INTERNAL_ERROR', error: 'Agent change could not be saved.' };
    }
  }

  private invalid(message: string): AgentManagementResult {
    return { success: false, errorCode: 'INVALID_INPUT', error: message || 'Invalid agent input.' };
  }

  private requireAgent(agentId: string): ManagedAgent {
    const agent = this.repo.getAgent(agentId);
    if (!agent) throw new AgentManagementError('AGENT_NOT_FOUND', `Agent "${agentId}" was not found.`);
    return agent;
  }

  private resourceSharedWithActiveAgent(resourceId: string, exceptAgentId: string): boolean {
    return this.repo
      .getAllAgents()
      .some((other) => other.id !== exceptAgentId && !other.removed_at && other.provider_resource_id === resourceId);
  }

  private ensureRoleProfile(role: FabricRole, nowIso: string): RoleProfile {
    const existing = this.repo.getRoleProfilesByRole(role).find((profile) => profile.enabled);
    if (existing) return existing;
    const profile: RoleProfile = {
      id: `role-profile-${role.toLowerCase()}-${crypto.randomUUID()}`,
      role,
      display_name: role,
      required_capabilities: ROLE_CAPABILITIES[role].slice(0, 1),
      preferred_capabilities: ROLE_CAPABILITIES[role].slice(1),
      authority_scope: null,
      permissions: [],
      output_protocol: ROLE_OUTPUT_PROTOCOL[role] ?? null,
      enabled: true,
      created_at: nowIso,
      updated_at: nowIso,
    };
    this.repo.createRoleProfile(profile);
    return profile;
  }

  private defaultProfileId(displayName: string, suffix: string): string {
    const slug = displayName
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[đĐ]/g, 'd')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return `${slug || 'agent'}-${suffix.slice(0, 8)}`;
  }

  private connectionOf(provider: Provider | null): AgentConnectionKind | 'OTHER' {
    if (!provider) return 'OTHER';
    if (provider.adapter_type === 'MANUAL_BRIDGE') return 'MANUAL_BRIDGE';
    if (provider.id === CLI_PROVIDERS.CODEX_CLI.id) return 'CODEX_CLI';
    if (provider.id === CLI_PROVIDERS.GEMINI_CLI.id) return 'GEMINI_CLI';
    if (provider.id === CLI_PROVIDERS.CLAUDE_CODE_CLI.id) return 'CLAUDE_CODE_CLI';
    if (provider.id === CLI_PROVIDERS.ANTIGRAVITY_CLI.id) return 'ANTIGRAVITY_CLI';
    return 'OTHER';
  }
}
