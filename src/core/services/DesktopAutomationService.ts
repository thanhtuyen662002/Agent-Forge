import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Repository } from '../database/repositories';
import { EventService } from './EventService';
import { ProviderRegistry } from '../adapters/ProviderRegistry';
import { RoleAwareRoutingService } from './RoleAwareRoutingService';
import { ContextBuilderService } from './ContextBuilderService';
import { ExecutionAuthorizationService } from './ExecutionAuthorizationService';
import { GitWorktreeService } from './GitWorktreeService';
import { ProviderDispatchService } from './ProviderDispatchService';
import { ConcurrentExecutionScheduler } from './ConcurrentExecutionScheduler';
import { WorkerSlotLeaseService } from './WorkerSlotLeaseService';
import { resolveTrustedExecutable } from './ExecutableResolver';
import { GitService } from './GitService';
import { OWNER_TASK_RETRIED_EVENT, TaskService } from './TaskService';
import { widenTaskContext } from './TaskContextWidening';
import { VerificationService } from './VerificationService';
import { AutomatedVerificationService, VERIFICATION_FAILED_EVENT, VERIFICATION_PASSED_EVENT, VERIFICATION_SKIPPED_EVENT } from './AutomatedVerificationService';
import { ProductReviewService, type ReviewerCandidate } from './ProductReviewService';
import { ProductManagerService, managerAuthorizesRevision, type PendingManagerDecision } from './ProductManagerService';
import { WorktreeIntegrationService } from './WorktreeIntegrationService';
import { ProjectService } from './ProjectService';
import { validateContextPaths } from '../protocol/planProtocol';
import type { Project, Task } from '../types/domain';
import type { ManagedAgent } from '../types/workspace';
import type { AutomationPhase, DesktopAutomationStatus, ProjectAutomationStatus } from '../types/desktopAutomation';

/** Top-level repository entries never offered to a coder as context. */
const EXCLUDED_CONTEXT_ENTRIES = new Set(['.git', 'node_modules', 'dist', 'dist-electron', 'release', 'build', 'out', 'coverage']);
/** Mirrors WorkerSlotLeaseService: only proven-available accounts can be leased. */
const SCHEDULABLE_ACCOUNT_HEALTH = new Set(['AVAILABLE', 'LOW_QUOTA']);

/** Marks attempts created by this service so restart cleanup only touches its own work. */
export const AUTOMATION_ATTEMPT_MARKER = 'desktop-automation';
/**
 * A failed coder run is retried for the same task revision (found in the
 * real trials: one transient failure stopped a task for good), after a
 * pause and a bounded number of times; settled runs bound it durably.
 */
export const MAX_EXECUTIONS_PER_REVISION = 3;
export const EXECUTION_RETRY_AFTER_MS = 60_000;

export interface DesktopAutomationOptions {
  /** Root under which each project's managed execution worktrees live. */
  worktreeRoot: string;
  intervalMs?: number;
  maxConcurrentExecutions?: number;
  now?: () => string;
  timer?: { setInterval(fn: () => void, ms: number): unknown; clearInterval(handle: unknown): void };
  resolveGitExecutable?: () => string | null;
  /**
   * When both are given, a settled COMPLETED coder run is verified in its
   * worktree (#230), and verified work is reviewed by an account-bound
   * REVIEWER agent when one is configured (#233).
   */
  taskService?: TaskService;
  verificationService?: VerificationService;
  /** Lease heartbeat for automated reviews (tests shorten it). */
  reviewHeartbeatMs?: number;
}

/** Recorded when automation completes a project whose work is all done and reviewed (#283). */
export const PROJECT_COMPLETED_EVENT = 'AUTOMATION_PROJECT_COMPLETED';

type InFlightKind = 'EXECUTION' | 'VERIFICATION' | 'REVIEW' | 'MANAGER' | 'INTEGRATION';
type AutomationRole = 'CODER' | 'REVIEWER' | 'MANAGER';
/** Capability an agent's adapter must report for each automated role. */
const ROLE_CAPABILITY: Partial<Record<AutomationRole, string>> = { REVIEWER: 'REVIEW', MANAGER: 'PLANNING' };

type ReviewWork = NonNullable<ReturnType<ProductReviewService['pendingReview']>>['work'];

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
  /** Keyed by project for its main lane, and by project#task for extra coder runs (#306). */
  private readonly inFlight = new Map<string, { projectId: string; kind: InFlightKind; taskId: string; agentId: string; promise: Promise<void> }>();
  private readonly lastFailure = new Map<string, { taskId: string; revision: number; reasonCode: string; at?: number; count?: number }>();
  private readonly progressSignatures = new Map<string, string>();
  /** Slots bound to runs that have not leased them yet, so parallel runs pick different slots (#306). */
  private readonly boundSlots = new Map<string, string>();
  private readonly verifier: AutomatedVerificationService | null;
  private readonly reviewer: ProductReviewService | null;
  private readonly manager: ProductManagerService | null;
  private readonly integration: WorktreeIntegrationService;
  private readonly projects: ProjectService;
  /** Provider capabilities read on each pass; a reviewer needs an adapter that can REVIEW. */
  private readonly capabilities = new Map<string, readonly string[]>();

  constructor(
    private readonly repo: Repository,
    private readonly eventService: EventService,
    private readonly providerRegistry: ProviderRegistry,
    private readonly options: DesktopAutomationOptions,
  ) {
    this.intervalMs = Math.max(1_000, options.intervalMs ?? 15_000);
    this.maxConcurrent = Math.min(10, Math.max(1, options.maxConcurrentExecutions ?? 1));
    this.now = options.now ?? (() => new Date().toISOString());
    this.timer = options.timer ?? {
      setInterval: (fn, ms) => { const h = setInterval(fn, ms); h.unref?.(); return h; },
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    };
    this.resolveGit = options.resolveGitExecutable ?? (() => resolveTrustedExecutable('git', 'git'));
    this.verifier = options.taskService && options.verificationService
      ? new AutomatedVerificationService(repo, eventService, options.taskService, options.verificationService)
      : null;
    this.reviewer = this.verifier && options.taskService
      ? new ProductReviewService(repo, eventService, providerRegistry, options.taskService,
        { now: () => new Date(this.now()), heartbeatMs: options.reviewHeartbeatMs })
      : null;
    this.integration = new WorktreeIntegrationService(repo, eventService, (projectId) => {
      const project = this.repo.getProjectMetadata(projectId);
      const gitExecutable = this.resolveGit();
      return project && gitExecutable
        ? new GitWorktreeService({ gitExecutable, repositoryRoot: project.repository_path, managedRoot: path.join(this.options.worktreeRoot, project.id) })
        : null;
    }, () => this.resolveGit());
    this.manager = options.taskService
      ? new ProductManagerService(repo, eventService, providerRegistry, options.taskService,
        { now: () => new Date(this.now()), heartbeatMs: options.reviewHeartbeatMs })
      : null;
    this.projects = new ProjectService(repo, eventService);
  }

  /** Owner-controlled integration of reviewed work (#238). */
  public getIntegration(): WorktreeIntegrationService {
    return this.integration;
  }

  /** The automated Manager, for the owner's approve/reject IPC (#239). */
  public getManager(): ProductManagerService | null {
    return this.manager;
  }

  public start(): void {
    if (this.handle) return;
    this.releaseAbandonedAuthorizations();
    this.handle = this.timer.setInterval(() => { void this.tick(); }, this.intervalMs);
  }

  /** Stops new dispatch. In-flight executions keep their fences and settle or are recovered. */
  public stop(): void {
    if (this.handle) this.timer.clearInterval(this.handle);
    this.handle = null;
  }

  /**
   * Runs once before the loop starts: nothing of ours can be in flight yet, so
   * an AUTHORIZED product authorization whose attempt this service created was
   * abandoned by a previous process. Expire it and release its attempt and
   * assignment. Owner-created authorizations are never touched.
   */
  public releaseAbandonedAuthorizations(): number {
    if (this.inFlight.size > 0) return 0;
    let released = 0;
    for (const project of this.repo.getAllProjects()) {
      for (const task of this.repo.getTasksByProject(project.id)) {
        for (const auth of this.repo.getExecutionAuthorizationsByTask(task.id)) {
          if (auth.status !== 'AUTHORIZED' || auth.lifecycle_version !== 1 || !auth.assignment_id || !auth.attempt_id) continue;
          if (this.repo.getTaskAttempt(auth.attempt_id)?.summary !== AUTOMATION_ATTEMPT_MARKER) continue;
          if (this.repo.getActiveLeaseForAssignment(auth.assignment_id)) continue;
          if (!this.repo.expireUnstartedProductAuthorization(auth.id)) continue;
          this.repo.endUnleasedAgentAssignment(auth.assignment_id, 'FAILED', this.now());
          this.repo.endRunningTaskAttempt(auth.attempt_id, 'FAILED', this.now());
          released += 1;
        }
      }
    }
    return released;
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
      // Reviews interrupted by a previous process are fenced or released first.
      // A failure here is retried on the next pass and never stops dispatch.
      try { this.reviewer?.recoverAbandonedReviews(); } catch { /* next pass */ }
      try { this.reviewer?.releaseStaleBlockedReviews(); } catch { /* next pass */ }
      try { this.manager?.recoverAbandoned(); } catch { /* next pass */ }
      if (this.reviewer || this.manager) await this.refreshCapabilities();
      for (const project of this.runnableProjects()) {
        if (this.inFlight.size >= this.maxConcurrent) break;
        this.refreshRunProgress(project);
        if (!this.inFlight.has(project.id)) this.startMainLane(project);
        this.startExtraRuns(project);
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * The project's single lane: unverified work, then review, integration,
   * completion, planning and Manager decisions, then one coder run.
   */
  private startMainLane(project: Project): void {
    // Settled work that was never verified (e.g. interrupted by a restart) comes first.
    const pending = this.pendingVerification(project);
    if (pending) {
      const verify = this.runVerification(project, pending.id)
        .catch(() => undefined)
        .finally(() => this.inFlight.delete(project.id));
      this.inFlight.set(project.id, { projectId: project.id, kind: 'VERIFICATION', taskId: pending.task_id, agentId: '', promise: verify });
      return;
    }
    // Verified work goes to an account-bound reviewer on a different account.
    const toReview = this.reviewer?.pendingReview(project.id) ?? null;
    if (toReview && !toReview.deferred) {
      const reviewer = this.findAgent('REVIEWER', this.reviewer!.coderAccountOf(toReview.work));
      if (reviewer) {
        const review = this.runReview(project, toReview.task.id, toReview.work, reviewer)
          .catch(() => undefined)
          .finally(() => this.inFlight.delete(project.id));
        this.inFlight.set(project.id, { projectId: project.id, kind: 'REVIEW', taskId: toReview.task.id, agentId: reviewer.agent.id, promise: review });
        return;
      }
    }
    // Reviewed work lands on the default branch first when the owner opted in, so
    // the next task starts from it (automatic integration).
    if (this.repo.getProjectAutoIntegrate(project.id)) {
      const ready = this.integration.hasReadyWork(project.id) ?? this.integration.hasUnmergedBranch(project.id);
      if (ready) {
        const integrate = this.integrate(project.id, ready)
          .catch(() => undefined)
          .finally(() => this.inFlight.delete(project.id));
        this.inFlight.set(project.id, { projectId: project.id, kind: 'INTEGRATION', taskId: ready, agentId: '', promise: integrate });
        return;
      }
    }
    // Finished work completes the project instead of waiting for an owner action (#283).
    if (this.completeIfFinished(project)) return;
    // An approved contract with no tasks yet gets its planning record first (#245).
    if (this.manager) { try { this.manager.ensurePlanningAnchor(project.id); } catch { /* next pass */ } }
    // A task without Manager authority for its revision (or the plan) asks the Manager agent first.
    const toDecide = this.manager?.pendingDecision(project.id) ?? null;
    if (toDecide && !toDecide.deferred) {
      const manager = this.findAgent('MANAGER');
      if (manager) {
        const decide = this.runManager(toDecide, manager)
          .catch(() => undefined)
          .finally(() => this.inFlight.delete(project.id));
        this.inFlight.set(project.id, { projectId: project.id, kind: 'MANAGER', taskId: toDecide.task.id, agentId: manager.agent.id, promise: decide });
        return;
      }
    }
    const task = this.nextEligibleTask(project);
    if (!task) return;
    const coder = this.findCoderFor(task);
    if (!coder) return;
    this.startExecution(project, task, coder, project.id);
  }

  /** Up to N - 1 more coder runs of other tasks next to the main lane, when the owner allows N > 1 (#306). */
  private startExtraRuns(project: Project): void {
    const parallel = this.repo.getProjectParallelTasks(project.id);
    if (parallel <= 1) return;
    while (this.inFlight.size < this.maxConcurrent && this.executionsOf(project.id) < parallel) {
      const task = this.nextEligibleTask(project);
      if (!task) return;
      const coder = this.findCoderFor(task);
      if (!coder) return;
      this.startExecution(project, task, coder, `${project.id}#${task.id}`);
    }
  }

  private startExecution(project: Project, task: Task, coder: CoderCandidate, key: string): void {
    // execute() reports its own failures; this catch only keeps an unexpected
    // throw from becoming an unhandled rejection in the main process.
    const promise = this.execute(project, task, coder)
      .catch(() => { this.lastFailure.set(task.id, { taskId: task.id, revision: task.revision_count, reasonCode: 'INTERNAL_ERROR' }); })
      .finally(() => { this.inFlight.delete(key); this.boundSlots.delete(task.id); });
    this.inFlight.set(key, { projectId: project.id, kind: 'EXECUTION', taskId: task.id, agentId: coder.agent.id, promise });
  }

  private executionsOf(projectId: string): number {
    return [...this.inFlight.values()].filter((item) => item.projectId === projectId && item.kind === 'EXECUTION').length;
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
    // The main lane first; otherwise an extra coder run of the project (#306).
    const running = this.inFlight.get(project.id) ??
      [...this.inFlight.values()].find((item) => item.projectId === project.id && item.kind === 'EXECUTION');
    if (running) {
      if (running.kind === 'REVIEW') return status('REVIEWING', running.taskId);
      if (running.kind === 'MANAGER') return status('DECIDING', running.taskId);
      return running.kind === 'VERIFICATION' || this.repo.getTask(running.taskId)?.state === 'VALIDATING'
        ? status('VERIFYING', running.taskId) : status('EXECUTING', running.taskId);
    }
    if (project.status === 'COMPLETED') return status('PROJECT_COMPLETED');
    if (project.status !== 'RUNNING') return status('PROJECT_NOT_RUNNING');

    const tasks = this.repo.getTasksByProject(project.id).filter((task) => !this.repo.isTaskTrashed(task.id));
    const validating = tasks.find((task) => task.state === 'VALIDATING');
    if (validating) return status('VERIFYING', validating.id);
    const reviewReady = tasks.find((task) => task.state === 'REVIEW_READY' || task.state === 'REVIEWING');
    if (reviewReady) return status('AWAITING_REVIEW', reviewReady.id, this.awaitingReviewReason(reviewReady));

    const authorized = this.authorizedTasks(project);
    for (const task of authorized) {
      const settled = this.settledForRevision(task);
      if (settled === 'COMPLETED') return status('AWAITING_REVIEW', task.id, this.verificationReason(task.id) ?? 'NOT_VERIFIED');
    }
    for (const task of authorized) {
      const failure = this.lastFailure.get(task.id);
      const retriedAt = this.ownerRetriedAt(task);
      if (failure && failure.revision === task.revision_count && !(retriedAt !== null && (failure.at ?? 0) <= retriedAt)) {
        return status('FAILED', task.id, failure.reasonCode);
      }
      if (this.settledForRevision(task) === 'FAILED') return status('FAILED', task.id, 'PROVIDER_EXECUTION_FAILED');
    }
    const eligible = authorized.find((task) => this.isDispatchable(task));
    if (!eligible) {
      // A concrete Manager state first, then what sent the task back, then a missing Manager agent.
      const waiting = this.managerWaitingReason(project);
      if (waiting && waiting.reasonCode !== 'NO_MANAGER') return status('WAITING_FOR_MANAGER', waiting.taskId, waiting.reasonCode);
      // Shown only when nothing is running, failed or queued, so it never hides those.
      const readyForIntegration = this.integration.hasReadyWork(project.id);
      if (readyForIntegration) return status('READY_FOR_INTEGRATION', readyForIntegration, 'REVIEWED_WORK_READY');
      const failedVerification = tasks.find((task) => this.verificationReason(task.id) === 'VERIFICATION_FAILED' && task.state === 'CODING');
      if (failedVerification) return status('WAITING_FOR_MANAGER', failedVerification.id, 'VERIFICATION_FAILED');
      const sentBack = tasks.find((task) => task.state === 'CODING' && this.reviewer?.reviewReason(task) === 'REVIEW_FIX_REQUIRED');
      if (sentBack) return status('WAITING_FOR_MANAGER', sentBack.id, 'REVIEW_FIX_REQUIRED');
      return status('WAITING_FOR_MANAGER', waiting?.taskId ?? null, waiting?.reasonCode ?? null);
    }
    if (this.findCoderFor(eligible)) return status('QUEUED', eligible.id, this.isActive() ? null : 'AUTOMATION_STOPPED');
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
    const planningAnchor = this.repo.getProjectPlanningTaskId(project.id);
    // The planning record is never dispatched to a coder, whatever authority it was given.
    return this.repo.getTasksByProject(project.id).filter((task) =>
      task.id !== planningAnchor && task.state === 'CODING' && !this.repo.isTaskTrashed(task.id) && managerAuthorizesRevision(this.repo, task));
  }

  /** Why work waits on the Manager: an open proposal, a failed Manager call, or no usable Manager agent. */
  private managerWaitingReason(project: Project): { taskId: string; reasonCode: string } | null {
    if (!this.manager) return null;
    const known = this.manager.waitingReason(project.id);
    if (known) return known;
    const pending = this.manager.pendingDecision(project.id);
    if (!pending) return null;
    if (pending.deferred) return { taskId: pending.task.id, reasonCode: 'MANAGER_RETRY_PENDING' };
    if (this.findAgent('MANAGER')) return null;
    const hasManager = this.repo.getAllAgents().some((agent) => !agent.removed_at && (agent.role === 'PRIMARY_MANAGER' || agent.role === 'BACKUP_MANAGER'));
    return { taskId: pending.task.id, reasonCode: hasManager ? 'MANAGER_NOT_AVAILABLE' : 'NO_MANAGER' };
  }

  /** The mode (auto or approve) is read by the Manager service when the answer arrives, not at dispatch. */
  /** Branch from the exact reviewed snapshot, then the default branch; a skip leaves the branch for the owner. */
  /**
   * Completes a RUNNING project whose tasks are all settled (DONE or CANCELLED,
   * at least one DONE): each DONE task already passed exact-head review of its
   * verified work. Reviewed work still waiting for the owner, or, with automatic
   * integration, work not yet on the default branch (including a skipped merge),
   * keeps the project RUNNING so the reason stays visible.
   */
  private completeIfFinished(project: Project): boolean {
    const tasks = this.repo.getTasksByProject(project.id).filter((task) => !this.repo.isTaskTrashed(task.id));
    if (!tasks.some((task) => task.state === 'DONE') || !tasks.every((task) => task.state === 'DONE' || task.state === 'CANCELLED')) return false;
    const entries = this.integration.list(project.id);
    if (entries.some((entry) => entry.state === 'READY')) return false;
    if (this.repo.getProjectAutoIntegrate(project.id) && entries.some((entry) => entry.state === 'BRANCH_CREATED' && !entry.mergedInto)) return false;
    try {
      this.repo.runInImmediateTransaction(() => {
        this.projects.transitionStatus(project.id, 'ALL_TASKS_DONE');
        this.projects.transitionStatus(project.id, 'FINAL_PASS');
        this.eventService.record(project.id, PROJECT_COMPLETED_EVENT,
          `All tasks of project ${project.name} are done and reviewed; automation completed the project.`,
          { taskIds: tasks.filter((task) => task.state === 'DONE').map((task) => task.id), autoIntegrate: this.repo.getProjectAutoIntegrate(project.id) });
      });
      return true;
    } catch {
      // The project moved on (paused, stopped) since it was read; the next pass re-checks.
      return false;
    }
  }

  private async integrate(projectId: string, taskId: string): Promise<void> {
    const entry = this.integration.list(projectId).find((item) => item.taskId === taskId);
    if (entry?.state === 'READY') {
      const created = await this.integration.createBranch(projectId, taskId);
      if (!created.success) return;
    }
    await this.integration.mergeIntoDefault(projectId, taskId);
  }

  private async runManager(pending: PendingManagerDecision, manager: CoderCandidate): Promise<void> {
    if (!this.manager) return;
    await this.manager.decide(pending, {
      agentId: manager.agent.id, agentProfileId: manager.agentProfileId, roleProfileId: manager.roleProfileId,
      accountId: manager.accountId, resourceId: manager.resourceId,
    });
  }

  private nextEligibleTask(project: Project): Task | null {
    // A task is never in two runs, even before its authorization exists (#306).
    const running = new Set([...this.inFlight.values()].filter((item) => item.kind === 'EXECUTION').map((item) => item.taskId));
    return this.authorizedTasks(project).find((task) => !running.has(task.id) && this.isDispatchable(task)) ?? null;
  }

  /** Not already authorized, in flight, settled or failed for this exact revision. */
  private isDispatchable(task: Task): boolean {
    const now = Date.parse(this.now());
    const failure = this.lastFailure.get(task.id);
    const retriedAt = this.ownerRetriedAt(task);
    if (failure && failure.revision === task.revision_count && !(retriedAt !== null && (failure.at ?? 0) <= retriedAt) &&
        ((failure.count ?? MAX_EXECUTIONS_PER_REVISION) >= MAX_EXECUTIONS_PER_REVISION || now - (failure.at ?? now) < EXECUTION_RETRY_AFTER_MS)) return false;
    const settled: string[] = [];
    for (const auth of this.repo.getExecutionAuthorizationsByTask(task.id)) {
      if (auth.status === 'AUTHORIZED') return false;
      if (auth.status === 'DISPATCHED' && !auth.settled_at) return false;
      if (auth.task_revision === task.revision_count && auth.lifecycle_version === 1 && auth.settled_at && this.countsAfterRetry(auth, retriedAt)) {
        // A completed run goes on to verification and review; failed runs may be retried.
        if (auth.settlement_status === 'COMPLETED') return false;
        settled.push(String(auth.settled_at));
      }
    }
    // Each coder account has its own bound (findCoderFor); this caps the revision overall.
    if (settled.length >= MAX_EXECUTIONS_PER_REVISION * 3) return false;
    const latest = settled.sort().at(-1);
    if (latest && now - Date.parse(latest) < EXECUTION_RETRY_AFTER_MS) return false;
    return !this.repo.getAgentAssignmentsByTask(task.id).some((a) => a.status === 'ASSIGNED' || a.status === 'RUNNING');
  }

  /** Failed settled runs of the task's current revision, per coder account (#302). */
  private failedRunsByAccount(task: Task): Map<string, number> {
    const failures = new Map<string, number>();
    const retriedAt = this.ownerRetriedAt(task);
    for (const auth of this.repo.getExecutionAuthorizationsByTask(task.id)) {
      if (auth.task_revision !== task.revision_count || auth.lifecycle_version !== 1 || !auth.settled_at ||
          auth.settlement_status === 'COMPLETED' || !auth.selected_account_id || !this.countsAfterRetry(auth, retriedAt)) continue;
      failures.set(auth.selected_account_id, (failures.get(auth.selected_account_id) ?? 0) + 1);
    }
    return failures;
  }

  /**
   * The coder for a revision (#302): first one whose account has not failed it,
   * then one under the per-account bound. One broken account (found with an
   * Antigravity account Google asked to verify) never uses up the attempts of
   * the other coders, and agents are no longer tried in display-name order only.
   */
  private findCoderFor(task: Task): CoderCandidate | null {
    const failures = this.failedRunsByAccount(task);
    const exhausted = new Set([...failures].filter(([, count]) => count >= MAX_EXECUTIONS_PER_REVISION).map(([accountId]) => accountId));
    return this.findAgent('CODER', new Set(failures.keys())) ?? this.findAgent('CODER', exhausted);
  }

  /** Progress follows coder runs as they start, settle or fail, not only task transitions (#302). */
  private refreshRunProgress(project: Project): void {
    const tasks = this.options.taskService;
    if (!tasks) return;
    for (const task of this.repo.getTasksByProject(project.id)) {
      if (task.state !== 'CODING' || this.repo.isTaskTrashed(task.id)) continue;
      const signature = `${task.revision_count}:${this.repo.getExecutionAuthorizationsByTask(task.id)
        .map((auth) => `${auth.id}/${auth.status}/${auth.settlement_status ?? ''}`).join(',')}`;
      if (this.progressSignatures.get(task.id) === signature) continue;
      this.progressSignatures.set(task.id, signature);
      try { tasks.refreshProgress(task.id); } catch { /* next pass */ }
    }
  }

  /**
   * When the owner last retried the task at its current revision (#318), or null.
   * Failed runs settled before it no longer count against the retry bounds.
   */
  private ownerRetriedAt(task: Task): number | null {
    const retry = this.repo.getProjectEventsOfTypes(task.project_id, [OWNER_TASK_RETRIED_EVENT], task.id)
      .find((event) => (event.structured_payload as { revision?: unknown } | null)?.revision === task.revision_count);
    return retry ? Date.parse(retry.timestamp) : null;
  }

  private countsAfterRetry(auth: { settled_at?: string | null; settlement_status?: string | null }, retriedAt: number | null): boolean {
    // A completed run always counts: its work goes on to verification and review.
    return retriedAt === null || auth.settlement_status === 'COMPLETED' || Date.parse(String(auth.settled_at)) > retriedAt;
  }

  private settledForRevision(task: Task): 'COMPLETED' | 'FAILED' | null {
    const retriedAt = this.ownerRetriedAt(task);
    const settled = this.repo
      .getExecutionAuthorizationsByTask(task.id)
      .filter((auth) => auth.task_revision === task.revision_count && auth.lifecycle_version === 1 && auth.settled_at && this.countsAfterRetry(auth, retriedAt))
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

  /** Why verified work is waiting for review: the latest review result, a missing reviewer, or the verification result. */
  private awaitingReviewReason(task: Task): string | null {
    const reviewed = this.reviewer?.reviewReason(task) ?? null;
    if (reviewed && task.state === 'REVIEWING') return reviewed;
    const pending = this.reviewer?.pendingReview(task.project_id) ?? null;
    if (pending?.task.id === task.id) {
      if (!pending.deferred && this.findAgent('REVIEWER', this.reviewer!.coderAccountOf(pending.work))) return 'VERIFIED';
      return this.repo.getAllAgents().some((agent) => !agent.removed_at && agent.role === 'REVIEWER') ? 'REVIEWER_NOT_AVAILABLE' : 'NO_REVIEWER';
    }
    return reviewed ?? this.verificationReason(task.id) ?? null;
  }

  private async runReview(project: Project, taskId: string, work: ReviewWork, reviewer: CoderCandidate): Promise<void> {
    const gitExecutable = this.resolveGit();
    if (!gitExecutable || !this.reviewer) return;
    const worktrees = new GitWorktreeService({
      gitExecutable, repositoryRoot: project.repository_path, managedRoot: path.join(this.options.worktreeRoot, project.id),
    });
    const candidate: ReviewerCandidate = {
      agentId: reviewer.agent.id, agentProfileId: reviewer.agentProfileId, roleProfileId: reviewer.roleProfileId,
      accountId: reviewer.accountId, resourceId: reviewer.resourceId,
    };
    await this.reviewer.review(work, taskId, candidate, worktrees);
  }

  /**
   * An active CLI agent of the role whose provider adapter is registered and
   * that has a usable account and idle slot. A reviewer never uses the
   * account of the work it reviews.
   */
  private findAgent(role: AutomationRole, excludedAccounts: string | ReadonlySet<string> | null = null): CoderCandidate | null {
    const isExcluded = (accountId: string) => typeof excludedAccounts === 'string' ? accountId === excludedAccounts : excludedAccounts?.has(accountId) ?? false;
    // An agent serves as many operations at once as it has enabled worker slots (#306).
    const inFlightByAgent = new Map<string, number>();
    for (const item of this.inFlight.values()) if (item.agentId) inFlightByAgent.set(item.agentId, (inFlightByAgent.get(item.agentId) ?? 0) + 1);
    for (const agent of this.repo.getAllAgents()) {
      const roleMatches = role === 'MANAGER' ? agent.role === 'PRIMARY_MANAGER' || agent.role === 'BACKUP_MANAGER' : agent.role === role;
      if (agent.removed_at || !roleMatches || agent.status === 'BUSY' || !agent.provider_resource_id || !agent.agent_profile_id) continue;
      const resource = this.repo.getProviderResource(agent.provider_resource_id);
      if (!resource?.enabled || !resource.provider_account_id) continue;
      if (isExcluded(resource.provider_account_id)) continue;
      const provider = this.repo.getProvider(resource.provider_id);
      if (!provider?.enabled || provider.adapter_type !== 'LOCAL_CLI' || !this.providerRegistry.get(provider.id)) continue;
      const capability = ROLE_CAPABILITY[role];
      if (capability && !this.capabilities.get(provider.id)?.includes(capability)) continue;
      const account = this.repo.getProviderAccount(resource.provider_account_id);
      if (!account?.enabled || !SCHEDULABLE_ACCOUNT_HEALTH.has(account.health_status)) continue;
      if (account.cooldown_until && Date.parse(account.cooldown_until) > Date.parse(this.now())) continue;
      const slots = this.repo.getWorkerSlotsByAccount(account.id).filter((slot) => slot.provider_resource_id === resource.id);
      const idleSlot = slots.some((slot) => slot.status === 'IDLE' && !slot.current_assignment_id && !slot.current_execution_id);
      if (!idleSlot) continue;
      if ((inFlightByAgent.get(agent.id) ?? 0) >= slots.filter((slot) => slot.status !== 'DISABLED').length) continue;
      const agentProfile = this.repo.getAgentProfile(agent.agent_profile_id);
      if (!agentProfile?.enabled) continue;
      return { agent, agentProfileId: agentProfile.id, roleProfileId: agentProfile.role_profile_id, accountId: account.id, resourceId: resource.id };
    }
    return null;
  }

  private async execute(project: Project, task: Task, coder: CoderCandidate): Promise<void> {
    // A settled run is bounded durably per account (findCoderFor); only failures before
    // any run settled count toward this in-memory bound (#302).
    const fail = (reasonCode: string, detail?: string, settled = false) => {
      const previous = this.lastFailure.get(task.id);
      const prior = previous?.revision === task.revision_count ? (previous.count ?? 1) : 0;
      const count = settled ? prior : prior + 1;
      this.lastFailure.set(task.id, { taskId: task.id, revision: task.revision_count, reasonCode, at: Date.parse(this.now()), count });
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
      if (authorizationId) {
        const current = this.repo.getExecutionAuthorization(authorizationId);
        // A started or settled execution belongs to settlement and recovery.
        if (!current || current.adapter_started_at || current.settled_at) return;
        // AUTHORIZED, or DISPATCHED but rejected before the adapter start claim: nothing
        // ran, so expire it. Dispatch may already have INVALIDATED it; either way the
        // attempt and assignment below must be released too.
        if (current.status === 'AUTHORIZED' || current.status === 'DISPATCHED') this.repo.expireUnstartedProductAuthorization(authorizationId);
      }
      if (assignmentId) this.repo.endUnleasedAgentAssignment(assignmentId, 'FAILED', this.now());
      endAttempt('FAILED');
    };

    try {
      // 1. A RUNNING attempt bound to the coder's durable profile.
      const nextAttemptNumber = Math.max(0, ...this.repo.getTaskAttemptsByTask(task.id).map((a) => a.attempt_number)) + 1;
      this.repo.createTaskAttempt({
        id: attemptId, task_id: task.id, attempt_number: nextAttemptNumber, agent_id: coder.agent.id,
        agent_profile_id: coder.agentProfileId, status: 'RUNNING', started_at: this.now(), ended_at: null, summary: AUTOMATION_ATTEMPT_MARKER,
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
      // Task-scoped context when the plan named it (#254), re-checked now; otherwise the top-level entries.
      const scoped = this.repo.getTaskContextPaths(project.id, task.id);
      let contextFiles: string[];
      if (scoped.length > 0) {
        const check = validateContextPaths(project.repository_path, scoped, { allowMissing: true });
        if (!check.ok) { releaseUnclaimed(); fail('TASK_CONTEXT_INVALID', `${check.reasonCode}: ${check.path}`); return; }
        // New paths stay authorized for creation; with no existing path left, the coder also gets the top-level entries.
        const newPaths = new Set(check.newPaths ?? []);
        contextFiles = check.paths.some((entry) => !newPaths.has(entry))
          ? check.paths
          : [...new Set([...this.contextEntries(project.repository_path), ...check.paths])];
      } else {
        contextFiles = this.contextEntries(project.repository_path);
      }
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

      // 4. Bind the worker slot now, so the authorized execution scope names the
      // exact managed worktree the scheduler will create (GitWorktreeService
      // derives it from the slot, base HEAD and epoch). Verification later may
      // only run in that authorized worktree.
      const managedRoot = path.join(this.options.worktreeRoot, project.id);
      fs.mkdirSync(managedRoot, { recursive: true });
      const current = this.repo.getTask(task.id)!;
      const slotId = this.chooseIdleSlot(coder);
      if (!slotId || !this.repo.bindAgentAssignmentWorkerSlotIfUnbound(routing.selectedAssignmentId, slotId)) {
        releaseUnclaimed();
        fail('NO_IDLE_SLOT');
        return;
      }
      this.boundSlots.set(task.id, slotId);
      const head = await GitService.getHeadSha(project.repository_path);
      if (head.status !== 'SUCCESS' || !head.sha) {
        releaseUnclaimed();
        fail('REPOSITORY_HEAD_UNAVAILABLE');
        return;
      }
      const worktrees = new GitWorktreeService({ gitExecutable, repositoryRoot: project.repository_path, managedRoot });
      const epoch = current.ownership_epoch ?? 1;
      const plannedWorktree = worktrees.deriveWorktreePath({
        projectId: project.id, taskId: task.id, attemptId, assignmentId: routing.selectedAssignmentId,
        workerSlotId: slotId, baseSha: head.sha, ownershipEpoch: epoch,
      }).worktreePath;

      // 5. Immutable PRODUCT_BOUND authorization bound to all of the above.
      const auth = await new ExecutionAuthorizationService(this.repo, this.eventService).createAuthorization({
        projectId: project.id,
        taskId: task.id,
        attemptId,
        routingDecisionId: routing.decisionId,
        assignmentId: routing.selectedAssignmentId,
        taskOwnershipEpoch: epoch,
        contextManifestId: context.manifest.id,
        contextFiles,
        executionMode: 'PRODUCT_BOUND',
        executionScope: {
          branch: `agent/${task.id.toLowerCase()}`,
          worktree: plannedWorktree,
          allowedPaths: contextFiles,
          forbiddenPaths: ['.git'],
        },
      });

      authorizationId = auth.id;
      if (auth.repository_head_sha.toLowerCase() !== head.sha.toLowerCase()) {
        // HEAD moved between planning and authorization: the planned path is wrong.
        releaseUnclaimed();
        fail('REPOSITORY_HEAD_CHANGED');
        return;
      }

      // 6. Lease, managed worktree, scheduled dispatch and settlement.
      const dispatch = new ProviderDispatchService(this.providerRegistry, this.repo, this.eventService, worktrees);
      const scheduler = new ConcurrentExecutionScheduler(this.repo, new WorkerSlotLeaseService(this.repo), worktrees, dispatch);
      const result = await scheduler.execute(auth.id);
      if (result.status !== 'COMPLETED') {
        // Pre-claim failures (lease, worktree, preparation) leave the authorization
        // AUTHORIZED; release it so the task is not blocked. Claimed work is owned
        // by settlement and recovery.
        releaseUnclaimed();
        fail(result.status, result.errorCode ? String(result.errorCode) : undefined, Boolean(this.repo.getExecutionAuthorization(auth.id)?.settled_at));
        this.widenAfterOutOfScope(project.id, task.id, auth.id);
        return;
      }
      this.lastFailure.delete(task.id);
      this.eventService.record(project.id, 'AUTOMATION_EXECUTION_COMPLETED',
        `Automated coder execution for task ${task.id} settled COMPLETED; changes await verification and review.`,
        { authorizationId: auth.id, assignmentId: routing.selectedAssignmentId }, task.id);
      if (this.verifier) await this.verifier.verify(auth.id, worktrees);
    } catch (error) {
      // Pre-dispatch failures (attempt, routing, context, authorization) leave nothing running.
      releaseUnclaimed();
      const message = error instanceof Error ? error.message : '';
      const code = /^([A-Z_]+):/.exec(message.replace(/^EXECUTION_AUTHORIZATION_FAILED:\s*/, ''))?.[1] ?? 'PREPARATION_FAILED';
      fail(code);
    }
  }

  /**
   * A run refused because the coder wrote an existing repository file outside its context
   * (VidFlow M1: src/migrations.ts) gets that file into the task's context for the next run (#328).
   */
  private widenAfterOutOfScope(projectId: string, taskId: string, authorizationId: string): void {
    const failed = this.repo.getProjectEventsOfTypes(projectId, ['PRODUCT_EXECUTION_FAILED'], taskId)
      .find((event) => (event.structured_payload as { authorization_id?: unknown } | null)?.authorization_id === authorizationId);
    const error = (failed?.structured_payload as { result_payload?: { error?: unknown } } | undefined)?.result_payload?.error;
    if (typeof error !== 'string' || !error.startsWith('WORKSPACE_SYNC_OUT_OF_SCOPE')) return;
    const added = widenTaskContext(this.repo, projectId, taskId, [error]);
    if (added.length > 0) {
      this.eventService.record(projectId, 'AUTOMATION_CONTEXT_WIDENED',
        `Task ${taskId} context now includes ${added.join(', ')}, which its coder needed to change.`, { authorizationId, added }, taskId);
    }
  }

  /** A settled COMPLETED product execution at the task's current revision with no verification result yet. */
  private pendingVerification(project: Project) {
    if (!this.verifier) return null;
    for (const task of this.repo.getTasksByProject(project.id)) {
      if (task.state !== 'CODING' || this.repo.isTaskTrashed(task.id)) continue;
      const auth = this.repo.getExecutionAuthorizationsByTask(task.id).find((candidate) =>
        candidate.lifecycle_version === 1 && candidate.assignment_id && candidate.settlement_status === 'COMPLETED' &&
        candidate.task_revision === task.revision_count);
      if (auth && !this.verifier.hasOutcome(auth)) return auth;
    }
    return null;
  }

  private async runVerification(project: Project, authorizationId: string): Promise<void> {
    const gitExecutable = this.resolveGit();
    if (!gitExecutable || !this.verifier) return;
    const worktrees = new GitWorktreeService({
      gitExecutable, repositoryRoot: project.repository_path, managedRoot: path.join(this.options.worktreeRoot, project.id),
    });
    await this.verifier.verify(authorizationId, worktrees);
  }

  /** Latest durable automated-verification result for the task, as a status reason code. */
  private verificationReason(taskId: string): string | null {
    const task = this.repo.getTask(taskId);
    if (!task) return null;
    const latest = this.repo.getProjectEventsOfTypes(task.project_id, [VERIFICATION_PASSED_EVENT, VERIFICATION_FAILED_EVENT, VERIFICATION_SKIPPED_EVENT], taskId)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
    if (!latest) return null;
    if (latest.type === VERIFICATION_PASSED_EVENT) return 'VERIFIED';
    if (latest.type === VERIFICATION_FAILED_EVENT) return 'VERIFICATION_FAILED';
    const code = (latest.structured_payload as { reasonCode?: unknown } | null)?.reasonCode;
    return typeof code === 'string' ? code : 'NOT_VERIFIED';
  }

  /** Reads the capabilities of every provider a Reviewer or Manager agent uses; unknown means not capable. */
  private async refreshCapabilities(): Promise<void> {
    const providerIds = new Set<string>();
    for (const agent of this.repo.getAllAgents()) {
      if (agent.removed_at || !['REVIEWER', 'PRIMARY_MANAGER', 'BACKUP_MANAGER'].includes(agent.role) || !agent.provider_resource_id) continue;
      const resource = this.repo.getProviderResource(agent.provider_resource_id);
      if (resource) providerIds.add(resource.provider_id);
    }
    for (const providerId of providerIds) {
      try {
        this.capabilities.set(providerId, (await this.providerRegistry.get(providerId)?.getCapabilities()) ?? []);
      } catch {
        this.capabilities.set(providerId, []);
      }
    }
  }

  /** Same eligibility and ordering as WorkerSlotLeaseService fresh allocation. */
  private chooseIdleSlot(coder: CoderCandidate): string | null {
    const unreleased = new Set(this.repo.getUnreleasedAccountLeasesByAccount(coder.accountId).map((lease) => lease.worker_slot_id));
    for (const slotId of this.boundSlots.values()) unreleased.add(slotId);
    const eligible = this.repo.getWorkerSlotsByAccount(coder.accountId)
      .filter((slot) => slot.status === 'IDLE' && !slot.current_assignment_id && !slot.current_execution_id &&
        !unreleased.has(slot.id) && (slot.provider_resource_id === null || slot.provider_resource_id === coder.resourceId))
      .sort((a, b) => (a.slot_index - b.slot_index) || a.id.localeCompare(b.id));
    return eligible[0]?.id ?? null;
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
