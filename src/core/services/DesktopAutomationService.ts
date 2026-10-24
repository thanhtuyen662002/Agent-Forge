import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Repository } from '../database/repositories';
import { EventService } from './EventService';
import { ProviderRegistry } from '../adapters/ProviderRegistry';
import { ProtocolParser } from '../protocol/parser';
import { RoleAwareRoutingService } from './RoleAwareRoutingService';
import { ContextBuilderService } from './ContextBuilderService';
import { ExecutionAuthorizationService } from './ExecutionAuthorizationService';
import { GitWorktreeService } from './GitWorktreeService';
import { ProviderDispatchService } from './ProviderDispatchService';
import { ConcurrentExecutionScheduler } from './ConcurrentExecutionScheduler';
import { WorkerSlotLeaseService } from './WorkerSlotLeaseService';
import { resolveTrustedExecutable } from './ExecutableResolver';
import type { Project, Task } from '../types/domain';
import type { ManagedAgent } from '../types/workspace';
import type { AutomationPhase, DesktopAutomationStatus, ProjectAutomationStatus } from '../types/desktopAutomation';

/** Top-level repository entries never offered to a coder as context. */
const EXCLUDED_CONTEXT_ENTRIES = new Set(['.git', 'node_modules', 'dist', 'dist-electron', 'release', 'build', 'out', 'coverage']);
/** Mirrors WorkerSlotLeaseService: only proven-available accounts can be leased. */
const SCHEDULABLE_ACCOUNT_HEALTH = new Set(['AVAILABLE', 'LOW_QUOTA']);

export interface DesktopAutomationOptions {
  /** Root under which each project's managed execution worktrees live. */
  worktreeRoot: string;
  intervalMs?: number;
  maxConcurrentExecutions?: number;
  now?: () => string;
  timer?: { setInterval(fn: () => void, ms: number): unknown; clearInterval(handle: unknown): void };
  resolveGitExecutable?: () => string | null;
}

interface CoderCandidate {
  agent: ManagedAgent;
  agentProfileId: string;
  roleProfileId: string;
  accountId: string;
  resourceId: string;
}

/**
 * Bounded desktop runtime for RUNNING projects. For a task that the Manager
 * approved (CODING with EXECUTE/FIX_REQUIRED authority for its revision) it
 * runs the real product chain: attempt -> role-aware routing (persisted
 * assignment) -> durable context manifest -> PRODUCT_BOUND authorization ->
 * ConcurrentExecutionScheduler (lease, managed worktree, scheduled dispatch,
 * settlement). It never retries a settled revision, never invents success and
 * never bypasses authorization, lease, epoch, stop or trash fences.
 */
export class DesktopAutomationService {
  private readonly intervalMs: number;
  private readonly maxConcurrent: number;
  private readonly now: () => string;
  private readonly timer: NonNullable<DesktopAutomationOptions['timer']>;
  private readonly resolveGit: () => string | null;
  private handle: unknown = null;
  private ticking = false;
  private readonly inFlight = new Map<string, { taskId: string; agentId: string; promise: Promise<void> }>();
  private readonly lastFailure = new Map<string, { taskId: string; revision: number; reasonCode: string }>();

  constructor(
    private readonly repo: Repository,
    private readonly eventService: EventService,
    private readonly providerRegistry: ProviderRegistry,
    private readonly options: DesktopAutomationOptions,
  ) {
    this.intervalMs = Math.max(1_000, options.intervalMs ?? 15_000);
    this.maxConcurrent = Math.min(2, Math.max(1, options.maxConcurrentExecutions ?? 1));
    this.now = options.now ?? (() => new Date().toISOString());
    this.timer = options.timer ?? {
      setInterval: (fn, ms) => { const h = setInterval(fn, ms); h.unref?.(); return h; },
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    };
    this.resolveGit = options.resolveGitExecutable ?? (() => resolveTrustedExecutable('git', 'git'));
  }

  public start(): void {
    if (this.handle) return;
    this.handle = this.timer.setInterval(() => { void this.tick(); }, this.intervalMs);
  }

  /** Stops new dispatch. In-flight executions keep their fences and settle or are recovered. */
  public stop(): void {
    if (this.handle) this.timer.clearInterval(this.handle);
    this.handle = null;
  }

  public isActive(): boolean {
    return this.handle !== null;
  }

  /** Resolves when every in-flight execution has returned (used on shutdown and in tests). */
  public async drain(): Promise<void> {
    await Promise.all([...this.inFlight.values()].map((item) => item.promise));
  }

  /** One scheduling pass. Never overlaps itself. */
  public async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const project of this.runnableProjects()) {
        if (this.inFlight.size >= this.maxConcurrent) break;
        if (this.inFlight.has(project.id)) continue;
        const task = this.nextEligibleTask(project);
        if (!task) continue;
        const coder = this.findCoder(project.id);
        if (!coder) continue;
        // execute() reports its own failures; this catch only keeps an unexpected
        // throw from becoming an unhandled rejection in the main process.
        const promise = this.execute(project, task, coder)
          .catch(() => { this.lastFailure.set(task.id, { taskId: task.id, revision: task.revision_count, reasonCode: 'INTERNAL_ERROR' }); })
          .finally(() => this.inFlight.delete(project.id));
        this.inFlight.set(project.id, { taskId: task.id, agentId: coder.agent.id, promise });
      }
    } finally {
      this.ticking = false;
    }
  }

  public getStatus(): DesktopAutomationStatus {
    const projects = this.repo.getAllProjects().filter((project) => !this.repo.isProjectTrashed(project.id));
    return {
      active: this.isActive(),
      maxConcurrentExecutions: this.maxConcurrent,
      inFlight: this.inFlight.size,
      projects: projects.map((project) => this.projectStatus(project)),
    };
  }

  private projectStatus(project: Project): ProjectAutomationStatus {
    const status = (phase: AutomationPhase, taskId: string | null = null, reasonCode: string | null = null): ProjectAutomationStatus =>
      ({ projectId: project.id, phase, taskId, reasonCode, updatedAt: this.now() });
    const running = this.inFlight.get(project.id);
    if (running) return status('EXECUTING', running.taskId);
    if (project.status !== 'RUNNING') return status('PROJECT_NOT_RUNNING');

    const authorized = this.authorizedTasks(project);
    for (const task of authorized) {
      const settled = this.settledForRevision(task);
      if (settled === 'COMPLETED') return status('AWAITING_REVIEW', task.id);
    }
    for (const task of authorized) {
      const failure = this.lastFailure.get(task.id);
      if (failure && failure.revision === task.revision_count) return status('FAILED', task.id, failure.reasonCode);
      if (this.settledForRevision(task) === 'FAILED') return status('FAILED', task.id, 'PROVIDER_EXECUTION_FAILED');
    }
    const eligible = authorized.find((task) => this.isDispatchable(task));
    if (!eligible) return status('WAITING_FOR_MANAGER');
    if (this.findCoder(project.id)) return status('QUEUED', eligible.id, this.isActive() ? null : 'AUTOMATION_STOPPED');
    if (this.hasUnverifiedCliCoder()) return status('WAITING_FOR_CAPACITY', eligible.id, 'ACCOUNT_NOT_VERIFIED');
    return this.hasManualCoder() ? status('MANUAL_RELAY_REQUIRED', eligible.id) : status('WAITING_FOR_CAPACITY', eligible.id, 'NO_CLI_CODER');
  }

  private runnableProjects(): Project[] {
    return this.repo
      .getAllProjects()
      .filter((project) => project.status === 'RUNNING' && !this.repo.isProjectTrashed(project.id))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /** CODING tasks whose latest applied Manager decision authorizes their current revision. */
  private authorizedTasks(project: Project): Task[] {
    return this.repo.getTasksByProject(project.id).filter((task) => {
      if (task.state !== 'CODING' || this.repo.isTaskTrashed(task.id)) return false;
      const record = this.repo.getLatestAppliedManagerProtocolMessage(task.id, project.id);
      if (!record?.raw_payload) return false;
      const parsed = ProtocolParser.parse(String(record.raw_payload));
      if (!parsed.success || parsed.data?.type !== 'manager.v1') return false;
      const decision = parsed.data.data;
      const expected = typeof decision.expected_revision === 'number' ? decision.expected_revision : null;
      if (decision.decision === 'EXECUTE') return expected === task.revision_count;
      if (decision.decision === 'FIX_REQUIRED') return expected !== null && expected + 1 === task.revision_count;
      return false;
    });
  }

  private nextEligibleTask(project: Project): Task | null {
    return this.authorizedTasks(project).find((task) => this.isDispatchable(task)) ?? null;
  }

  /** Not already authorized, in flight, settled or failed for this exact revision. */
  private isDispatchable(task: Task): boolean {
    const failure = this.lastFailure.get(task.id);
    if (failure && failure.revision === task.revision_count) return false;
    for (const auth of this.repo.getExecutionAuthorizationsByTask(task.id)) {
      if (auth.status === 'AUTHORIZED') return false;
      if (auth.status === 'DISPATCHED' && !auth.settled_at) return false;
      if (auth.task_revision === task.revision_count && auth.lifecycle_version === 1 && auth.settled_at) return false;
    }
    return !this.repo.getAgentAssignmentsByTask(task.id).some((a) => a.status === 'ASSIGNED' || a.status === 'RUNNING');
  }

  private settledForRevision(task: Task): 'COMPLETED' | 'FAILED' | null {
    const settled = this.repo
      .getExecutionAuthorizationsByTask(task.id)
      .filter((auth) => auth.task_revision === task.revision_count && auth.lifecycle_version === 1 && auth.settled_at)
      .sort((a, b) => String(b.settled_at).localeCompare(String(a.settled_at)))[0];
    if (!settled) return null;
    return settled.settlement_status === 'COMPLETED' ? 'COMPLETED' : 'FAILED';
  }

  /** A CLI coder exists but its account health has not been proven (e.g. never signed in). */
  private hasUnverifiedCliCoder(): boolean {
    return this.repo.getAllAgents().some((agent) => {
      if (agent.removed_at || agent.role !== 'CODER' || !agent.provider_resource_id) return false;
      const resource = this.repo.getProviderResource(agent.provider_resource_id);
      if (!resource?.enabled || !resource.provider_account_id) return false;
      if (this.repo.getProvider(resource.provider_id)?.adapter_type !== 'LOCAL_CLI') return false;
      const account = this.repo.getProviderAccount(resource.provider_account_id);
      return Boolean(account?.enabled && !SCHEDULABLE_ACCOUNT_HEALTH.has(account.health_status));
    });
  }

  private hasManualCoder(): boolean {
    return this.repo.getAllAgents().some((agent) => {
      if (agent.removed_at || agent.role !== 'CODER' || !agent.provider_resource_id) return false;
      const resource = this.repo.getProviderResource(agent.provider_resource_id);
      return resource?.enabled && this.repo.getProvider(resource.provider_id)?.adapter_type === 'MANUAL_BRIDGE';
    });
  }

  /** An active CLI coder whose provider adapter is registered and that has a usable account and idle slot. */
  private findCoder(_projectId: string): CoderCandidate | null {
    const reserved = new Set([...this.inFlight.values()].map((item) => item.agentId));
    for (const agent of this.repo.getAllAgents()) {
      if (reserved.has(agent.id)) continue;
      if (agent.removed_at || agent.role !== 'CODER' || agent.status === 'BUSY' || !agent.provider_resource_id || !agent.agent_profile_id) continue;
      const resource = this.repo.getProviderResource(agent.provider_resource_id);
      if (!resource?.enabled || !resource.provider_account_id) continue;
      const provider = this.repo.getProvider(resource.provider_id);
      if (!provider?.enabled || provider.adapter_type !== 'LOCAL_CLI' || !this.providerRegistry.get(provider.id)) continue;
      const account = this.repo.getProviderAccount(resource.provider_account_id);
      if (!account?.enabled || !SCHEDULABLE_ACCOUNT_HEALTH.has(account.health_status)) continue;
      if (account.cooldown_until && Date.parse(account.cooldown_until) > Date.parse(this.now())) continue;
      const idleSlot = this.repo.getWorkerSlotsByAccount(account.id).some((slot) =>
        slot.provider_resource_id === resource.id && slot.status === 'IDLE' && !slot.current_assignment_id && !slot.current_execution_id);
      if (!idleSlot) continue;
      const agentProfile = this.repo.getAgentProfile(agent.agent_profile_id);
      if (!agentProfile?.enabled) continue;
      return { agent, agentProfileId: agentProfile.id, roleProfileId: agentProfile.role_profile_id, accountId: account.id, resourceId: resource.id };
    }
    return null;
  }

  private async execute(project: Project, task: Task, coder: CoderCandidate): Promise<void> {
    const fail = (reasonCode: string, detail?: string) => {
      this.lastFailure.set(task.id, { taskId: task.id, revision: task.revision_count, reasonCode });
      this.eventService.record(project.id, 'AUTOMATION_EXECUTION_FAILED',
        `Automated coder execution for task ${task.id} stopped: ${reasonCode}.`, { reasonCode, detail: detail ?? null }, task.id);
    };

    const gitExecutable = this.resolveGit();
    if (!gitExecutable) { fail('GIT_UNAVAILABLE'); return; }

    const attemptId = `attempt-${crypto.randomUUID()}`;
    let assignmentId: string | null = null;
    let authorizationId: string | null = null;
    const endAttempt = (status: 'FAILED' | 'CANCELLED') => { this.repo.endRunningTaskAttempt(attemptId, status, this.now()); };
    /**
     * Releases durable authority that never reached the dispatch claim. Once an
     * authorization is DISPATCHED, settlement and recovery own its terminal state.
     */
    const releaseUnclaimed = () => {
      if (authorizationId && this.repo.getExecutionAuthorization(authorizationId)?.status !== 'AUTHORIZED') return;
      if (authorizationId) this.repo.invalidateExecutionAuthorization(authorizationId);
      if (assignmentId) this.repo.endUnleasedAgentAssignment(assignmentId, 'FAILED', this.now());
      endAttempt('FAILED');
    };

    try {
      // 1. A RUNNING attempt bound to the coder's durable profile.
      const nextAttemptNumber = Math.max(0, ...this.repo.getTaskAttemptsByTask(task.id).map((a) => a.attempt_number)) + 1;
      this.repo.createTaskAttempt({
        id: attemptId, task_id: task.id, attempt_number: nextAttemptNumber, agent_id: coder.agent.id,
        agent_profile_id: coder.agentProfileId, status: 'RUNNING', started_at: this.now(), ended_at: null, summary: null,
      });

      // 2. Role-aware routing persists the assignment and routing decision.
      const routing = await new RoleAwareRoutingService(this.repo, this.providerRegistry, this.eventService).routeRole({
        projectId: project.id,
        taskId: task.id,
        attemptId,
        roleProfileId: coder.roleProfileId,
        agentProfileId: coder.agentProfileId,
        candidateRefs: [{ accountId: coder.accountId, resourceId: coder.resourceId }],
        persistAssignment: true,
        allowManualBridge: false,
      });
      if (routing.outcome !== 'SELECTED' || !routing.selectedAssignmentId) {
        releaseUnclaimed();
        fail('ROUTING_NOT_SELECTED', routing.reason);
        return;
      }
      assignmentId = routing.selectedAssignmentId;

      // 3. Durable, assignment-bound context manifest of the repository's top-level entries.
      const contextFiles = this.contextEntries(project.repository_path);
      if (contextFiles.length === 0) { releaseUnclaimed(); fail('NO_CONTEXT_FILES'); return; }
      const context = new ContextBuilderService(this.repo).buildContextSnapshot({
        projectId: project.id,
        taskId: task.id,
        attemptId,
        assignmentId: routing.selectedAssignmentId,
        contextFiles,
        purpose: 'EXECUTION',
        includeProjectMemory: false,
        includeTaskMemory: false,
        includeLatestCheckpoint: false,
        includeLatestHandoff: false,
      });

      // 4. Immutable PRODUCT_BOUND authorization bound to all of the above.
      const managedRoot = path.join(this.options.worktreeRoot, project.id);
      fs.mkdirSync(managedRoot, { recursive: true });
      const current = this.repo.getTask(task.id)!;
      const auth = await new ExecutionAuthorizationService(this.repo, this.eventService).createAuthorization({
        projectId: project.id,
        taskId: task.id,
        attemptId,
        routingDecisionId: routing.decisionId,
        assignmentId: routing.selectedAssignmentId,
        taskOwnershipEpoch: current.ownership_epoch ?? 1,
        contextManifestId: context.manifest.id,
        contextFiles,
        executionMode: 'PRODUCT_BOUND',
        executionScope: {
          branch: `agent/${task.id.toLowerCase()}`,
          worktree: path.join(managedRoot, task.id),
          allowedPaths: contextFiles,
          forbiddenPaths: ['.git'],
        },
      });

      authorizationId = auth.id;

      // 5. Lease, managed worktree, scheduled dispatch and settlement.
      const worktrees = new GitWorktreeService({ gitExecutable, repositoryRoot: project.repository_path, managedRoot });
      const dispatch = new ProviderDispatchService(this.providerRegistry, this.repo, this.eventService, worktrees);
      const scheduler = new ConcurrentExecutionScheduler(this.repo, new WorkerSlotLeaseService(this.repo), worktrees, dispatch);
      const result = await scheduler.execute(auth.id);
      if (result.status !== 'COMPLETED') {
        // Pre-claim failures (lease, worktree, preparation) leave the authorization
        // AUTHORIZED; release it so the task is not blocked. Claimed work is owned
        // by settlement and recovery.
        releaseUnclaimed();
        fail(result.status, result.errorCode ? String(result.errorCode) : undefined);
        return;
      }
      this.lastFailure.delete(task.id);
      this.eventService.record(project.id, 'AUTOMATION_EXECUTION_COMPLETED',
        `Automated coder execution for task ${task.id} settled COMPLETED; changes await verification and review.`,
        { authorizationId: auth.id, assignmentId: routing.selectedAssignmentId }, task.id);
    } catch (error) {
      // Pre-dispatch failures (attempt, routing, context, authorization) leave nothing running.
      releaseUnclaimed();
      const message = error instanceof Error ? error.message : '';
      const code = /^([A-Z_]+):/.exec(message.replace(/^EXECUTION_AUTHORIZATION_FAILED:\s*/, ''))?.[1] ?? 'PREPARATION_FAILED';
      fail(code);
    }
  }

  private contextEntries(repositoryPath: string): string[] {
    try {
      return fs.readdirSync(repositoryPath, { withFileTypes: true })
        .filter((entry) => (entry.isFile() || entry.isDirectory()) && !EXCLUDED_CONTEXT_ENTRIES.has(entry.name) && !entry.name.startsWith('.env'))
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }
}
