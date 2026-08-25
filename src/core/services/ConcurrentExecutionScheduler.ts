import { Repository } from '../database/repositories';
import {
  WorkerSlotLeaseService,
  DEFAULT_LEASE_TTL_MS,
  MIN_LEASE_TTL_MS,
  MAX_LEASE_TTL_MS,
} from './WorkerSlotLeaseService';
import {
  GitWorktreeService,
  WorktreeOwnershipTuple,
} from './GitWorktreeService';
import {
  ProviderDispatchService,
  ScheduledCancellationResult,
} from './ProviderDispatchService';
import {
  AgentExecutionResult,
  RuntimeErrorCode,
} from '../adapters/ProviderAdapter';

export type SchedulerExecutionStatus =
  | 'COMPLETED'
  | 'PROVIDER_FAILED'
  | 'CANCELLED'
  | 'NOT_SCHEDULABLE'
  | 'PREPARATION_FAILED'
  | 'LEASE_ACQUIRE_FAILED'
  | 'WORKTREE_CREATE_FAILED'
  | 'WORKTREE_INSPECTION_FAILED'
  | 'WORKTREE_CLEANUP_FAILED'
  | 'LEASE_RELEASE_FAILED'
  | 'LEASE_OWNERSHIP_LOST'
  | 'SCHEDULED_DISPATCH_FAILED';

export interface SchedulerExecutionResult {
  status: SchedulerExecutionStatus;
  authorizationId: string;
  assignmentId?: string;
  workerSlotId?: string;
  leaseId?: string;
  workspaceOwnershipDigest?: string;
  providerResult?: AgentExecutionResult;
  error?: string;
  errorCode?: string | RuntimeErrorCode | null;
}

export interface SchedulerTimer {
  setTimeout(fn: () => void, ms: number): any;
  clearTimeout(id: any): void;
}

export interface ConcurrentExecutionSchedulerConfig {
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  timer?: SchedulerTimer;
  onHeartbeatLoss?: (reason: string) => void;
}

interface HeartbeatSupervisor {
  start(): void;
  stop(): Promise<void>;
  isLeaseLost(): boolean;
  getLeaseLossReason(): string | undefined;
  triggerHeartbeatNow(): Promise<void>;
  setDispatchPending(pending: boolean, authorizationId?: string): void;
}

export class ConcurrentExecutionScheduler {
  public readonly leaseTtlMs: number;
  public readonly heartbeatIntervalMs: number;
  private timer: SchedulerTimer;
  private onHeartbeatLossHook?: (reason: string) => void;

  constructor(
    private repo: Repository,
    private leaseService: WorkerSlotLeaseService,
    private worktreeService: GitWorktreeService,
    private dispatchService: ProviderDispatchService,
    config?: ConcurrentExecutionSchedulerConfig
  ) {
    const ttl = config?.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    if (
      typeof ttl !== 'number' ||
      !Number.isFinite(ttl) ||
      Number.isNaN(ttl) ||
      ttl < MIN_LEASE_TTL_MS ||
      ttl > MAX_LEASE_TTL_MS
    ) {
      throw new Error(
        `INVALID_SCHEDULER_CONFIG: leaseTtlMs (${ttl} ms) must be a finite number between ${MIN_LEASE_TTL_MS} and ${MAX_LEASE_TTL_MS} ms.`
      );
    }
    this.leaseTtlMs = ttl;

    const defaultInterval = Math.floor(this.leaseTtlMs / 3);
    const interval = config?.heartbeatIntervalMs ?? defaultInterval;
    if (
      typeof interval !== 'number' ||
      !Number.isFinite(interval) ||
      Number.isNaN(interval) ||
      interval <= 0 ||
      interval > Math.floor(this.leaseTtlMs / 3)
    ) {
      throw new Error(
        `INVALID_SCHEDULER_CONFIG: heartbeatIntervalMs (${interval} ms) must be positive and <= floor(leaseTtlMs / 3) (${Math.floor(
          this.leaseTtlMs / 3
        )} ms).`
      );
    }
    this.heartbeatIntervalMs = interval;

    this.timer = config?.timer ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
    };

    this.onHeartbeatLossHook = config?.onHeartbeatLoss;
  }

  /**
   * Supervised concurrent execution scheduler entry point.
   * Authority is authorizationId ONLY.
   */
  public async execute(authorizationId: string): Promise<SchedulerExecutionResult> {
    if (typeof authorizationId !== 'string' || authorizationId.trim() === '') {
      return {
        status: 'PREPARATION_FAILED',
        authorizationId: authorizationId ?? '',
        error: 'INVALID_AUTHORIZATION_ID: authorizationId must be a non-empty string.',
      };
    }

    // 1. Authorization Preflight & Validation
    const auth = this.repo.getExecutionAuthorization(authorizationId);
    if (!auth) {
      return {
        status: 'PREPARATION_FAILED',
        authorizationId,
        error: `EXECUTION_AUTHORIZATION_NOT_FOUND: Execution authorization "${authorizationId}" was not found.`,
      };
    }

    if (auth.status !== 'AUTHORIZED') {
      return {
        status: 'PREPARATION_FAILED',
        authorizationId,
        error: `EXECUTION_AUTHORIZATION_INVALID_STATUS: Execution authorization "${authorizationId}" has status "${auth.status}" (expected AUTHORIZED).`,
      };
    }

    // 2. Durable Routing Authority & Assignment Reconstruction
    const routingEvent = this.repo.getRoutingDecisionEvent(auth.routing_decision_id);
    if (!routingEvent) {
      return {
        status: 'PREPARATION_FAILED',
        authorizationId,
        error: `ROUTING_DECISION_NOT_FOUND: Routing decision "${auth.routing_decision_id}" was not found.`,
      };
    }

    const routingPayload = routingEvent.structured_payload as Record<string, unknown>;
    const routingOutcome = routingPayload.outcome as string;

    if (routingOutcome === 'MANUAL_HANDOFF_REQUIRED') {
      return {
        status: 'NOT_SCHEDULABLE',
        authorizationId,
        error: 'NOT_SCHEDULABLE: Manual handoff routing outcome is not schedulable.',
      };
    }

    if (routingOutcome !== 'SELECTED') {
      return {
        status: 'NOT_SCHEDULABLE',
        authorizationId,
        error: `NOT_SCHEDULABLE: Routing outcome "${routingOutcome}" is not eligible for automated scheduled execution.`,
      };
    }

    const selectedAssignmentId = routingPayload.selectedAssignmentId as string;
    if (typeof selectedAssignmentId !== 'string' || selectedAssignmentId.trim().length === 0) {
      return {
        status: 'PREPARATION_FAILED',
        authorizationId,
        error: 'ROUTING_ASSIGNMENT_ID_MISSING: Selected routing decision is missing selectedAssignmentId.',
      };
    }

    const assignment = this.repo.getAgentAssignment(selectedAssignmentId);
    if (!assignment) {
      return {
        status: 'PREPARATION_FAILED',
        authorizationId,
        error: `ROUTING_ASSIGNMENT_NOT_FOUND: Selected assignment "${selectedAssignmentId}" was not found in database.`,
      };
    }

    if (
      assignment.status === 'COMPLETED' ||
      assignment.status === 'FAILED' ||
      assignment.status === 'CANCELLED' ||
      assignment.status === 'HANDED_OFF'
    ) {
      return {
        status: 'PREPARATION_FAILED',
        authorizationId,
        assignmentId: assignment.id,
        error: `ROUTING_ASSIGNMENT_TERMINAL: AgentAssignment "${assignment.id}" is already in terminal state "${assignment.status}".`,
      };
    }

    // 3. Worker Slot Lease Acquisition
    const leaseAcquireResult = this.leaseService.acquireForAssignment(assignment.id, this.leaseTtlMs);
    if (leaseAcquireResult.status !== 'ACQUIRED') {
      return {
        status: 'LEASE_ACQUIRE_FAILED',
        authorizationId,
        assignmentId: assignment.id,
        errorCode: leaseAcquireResult.code,
        error: leaseAcquireResult.error,
      };
    }

    const leaseId = leaseAcquireResult.lease.id;
    const leaseToken = leaseAcquireResult.lease.lease_token;
    const workerSlotId = leaseAcquireResult.slot.id;

    // 4. Heartbeat Supervisor Setup
    const supervisor = this.createHeartbeatSupervisor(leaseId, leaseToken, authorizationId);
    supervisor.start();

    // 5. Worktree Preparation & Creation
    const worktreeTuple: WorktreeOwnershipTuple = {
      projectId: auth.project_id,
      taskId: auth.task_id,
      attemptId: auth.attempt_id ?? null,
      assignmentId: assignment.id,
      workerSlotId: workerSlotId,
      baseSha: auth.repository_head_sha,
    };

    if (supervisor.isLeaseLost()) {
      await supervisor.stop();
      return {
        status: 'LEASE_OWNERSHIP_LOST',
        authorizationId,
        assignmentId: assignment.id,
        workerSlotId,
        leaseId,
        error: supervisor.getLeaseLossReason() || 'Lease ownership lost before worktree creation.',
      };
    }

    const worktreeCreateResult = await this.worktreeService.createWorktree(worktreeTuple);
    if (worktreeCreateResult.status !== 'CREATED') {
      await supervisor.stop();
      if (!supervisor.isLeaseLost()) {
        try {
          this.leaseService.release(leaseId, leaseToken);
        } catch {
          // Ignore release error on failure exit
        }
        return {
          status: 'WORKTREE_CREATE_FAILED',
          authorizationId,
          assignmentId: assignment.id,
          workerSlotId,
          leaseId,
          errorCode: worktreeCreateResult.code,
          error: worktreeCreateResult.error,
        };
      }
      return {
        status: 'LEASE_OWNERSHIP_LOST',
        authorizationId,
        assignmentId: assignment.id,
        workerSlotId,
        leaseId,
        error: supervisor.getLeaseLossReason() || 'Lease ownership lost during worktree creation.',
      };
    }

    const workspaceOwnershipDigest = worktreeCreateResult.ownershipDigest;

    // 6. Pre-Dispatch Lease Check
    if (supervisor.isLeaseLost()) {
      await supervisor.stop();
      // Retain worktree after lease loss, do NOT release lease
      return {
        status: 'LEASE_OWNERSHIP_LOST',
        authorizationId,
        assignmentId: assignment.id,
        workerSlotId,
        leaseId,
        workspaceOwnershipDigest,
        error: supervisor.getLeaseLossReason() || 'Lease ownership lost before provider dispatch.',
      };
    }

    // 7. Supervised Provider Dispatch
    supervisor.setDispatchPending(true, authorizationId);
    const dispatchPromise = this.dispatchService.dispatchScheduled(authorizationId);

    let providerResult: AgentExecutionResult;
    try {
      providerResult = await dispatchPromise;
    } catch (err: any) {
      providerResult = {
        executionId: '',
        status: 'FAILED',
        errorCode: 'EXECUTION_FAILED',
        error: `PROVIDER_DISPATCH_THREW: ${err.message}`,
      };
    } finally {
      supervisor.setDispatchPending(false);
    }

    // 8. Post-Dispatch Lease Loss Dominance Check
    if (supervisor.isLeaseLost()) {
      await supervisor.stop();
      // Retain worktree after lease loss, do NOT release lease
      return {
        status: 'LEASE_OWNERSHIP_LOST',
        authorizationId,
        assignmentId: assignment.id,
        workerSlotId,
        leaseId,
        workspaceOwnershipDigest,
        providerResult,
        error: supervisor.getLeaseLossReason() || 'Lease ownership lost during provider execution.',
      };
    }

    // 9. Post-Dispatch Worktree Inspection (Heartbeat continues through lifecycle)
    const inspectResult = await this.worktreeService.inspectWorktree(worktreeTuple);
    if (inspectResult.status !== 'INSPECTED') {
      await supervisor.stop();
      if (!supervisor.isLeaseLost()) {
        const releaseRes = this.leaseService.release(leaseId, leaseToken);
        if (releaseRes.status !== 'RELEASED') {
          return {
            status: 'LEASE_RELEASE_FAILED',
            authorizationId,
            assignmentId: assignment.id,
            workerSlotId,
            leaseId,
            workspaceOwnershipDigest,
            providerResult,
            errorCode: releaseRes.code,
            error: releaseRes.error,
          };
        }
      }
      return {
        status: 'WORKTREE_INSPECTION_FAILED',
        authorizationId,
        assignmentId: assignment.id,
        workerSlotId,
        leaseId,
        workspaceOwnershipDigest,
        providerResult,
        errorCode: inspectResult.code,
        error: inspectResult.error,
      };
    }

    const inspection = inspectResult.inspection;

    // 10. Worktree Retention / Removal Policy
    // COMPLETED -> RETAIN
    // FAILED + clean -> REMOVE
    // FAILED + dirty -> RETAIN
    // CANCELLED + clean -> REMOVE
    // CANCELLED + dirty -> RETAIN
    let shouldRemove = false;
    if (
      (providerResult.status === 'FAILED' || providerResult.status === 'CANCELLED') &&
      inspection.clean
    ) {
      shouldRemove = true;
    }

    if (shouldRemove) {
      const removeResult = await this.worktreeService.removeWorktree(worktreeTuple);
      if (removeResult.status !== 'REMOVED') {
        await supervisor.stop();
        if (!supervisor.isLeaseLost()) {
          const releaseRes = this.leaseService.release(leaseId, leaseToken);
          if (releaseRes.status !== 'RELEASED') {
            return {
              status: 'LEASE_RELEASE_FAILED',
              authorizationId,
              assignmentId: assignment.id,
              workerSlotId,
              leaseId,
              workspaceOwnershipDigest,
              providerResult,
              errorCode: releaseRes.code,
              error: releaseRes.error,
            };
          }
        }
        return {
          status: 'WORKTREE_CLEANUP_FAILED',
          authorizationId,
          assignmentId: assignment.id,
          workerSlotId,
          leaseId,
          workspaceOwnershipDigest,
          providerResult,
          errorCode: removeResult.code,
          error: removeResult.error,
        };
      }
    }

    // 11. Stop Heartbeat Supervisor Before Release
    await supervisor.stop();
    if (supervisor.isLeaseLost()) {
      return {
        status: 'LEASE_OWNERSHIP_LOST',
        authorizationId,
        assignmentId: assignment.id,
        workerSlotId,
        leaseId,
        workspaceOwnershipDigest,
        providerResult,
        error: supervisor.getLeaseLossReason() || 'Lease ownership lost before final lease release.',
      };
    }

    // 12. Release Lease on Healthy Path
    const releaseResult = this.leaseService.release(leaseId, leaseToken);
    if (releaseResult.status !== 'RELEASED') {
      return {
        status: 'LEASE_RELEASE_FAILED',
        authorizationId,
        assignmentId: assignment.id,
        workerSlotId,
        leaseId,
        workspaceOwnershipDigest,
        providerResult,
        errorCode: releaseResult.code,
        error: releaseResult.error,
      };
    }

    // 13. Map Terminal Scheduler Status
    let finalStatus: SchedulerExecutionStatus;
    if (providerResult.status === 'COMPLETED') {
      finalStatus = 'COMPLETED';
    } else if (providerResult.status === 'CANCELLED') {
      finalStatus = 'CANCELLED';
    } else {
      finalStatus = 'PROVIDER_FAILED';
    }

    return {
      status: finalStatus,
      authorizationId,
      assignmentId: assignment.id,
      workerSlotId,
      leaseId,
      workspaceOwnershipDigest,
      providerResult,
      error: providerResult.error,
      errorCode: providerResult.errorCode,
    };
  }

  private createHeartbeatSupervisor(
    leaseId: string,
    leaseToken: string,
    authorizationId: string
  ): HeartbeatSupervisor {
    let isStopped = false;
    let leaseLost = false;
    let leaseLossReason: string | undefined;
    let timerHandle: any = null;
    let inFlightHeartbeatPromise: Promise<void> | null = null;
    let dispatchPending = false;
    let cancelRequested = false;

    const recordLoss = (reason: string) => {
      if (leaseLost) return;
      leaseLost = true;
      leaseLossReason = reason;

      if (this.onHeartbeatLossHook) {
        try {
          this.onHeartbeatLossHook(reason);
        } catch {}
      }

      if (dispatchPending && !cancelRequested) {
        cancelRequested = true;
        this.dispatchService.cancelScheduled(authorizationId).catch(() => {});
      }
    };

    const runHeartbeat = async (): Promise<void> => {
      if (isStopped || leaseLost) return;
      try {
        const res = this.leaseService.heartbeat(leaseId, leaseToken, this.leaseTtlMs);
        if (res.status !== 'HEARTBEAT_ACKNOWLEDGED') {
          recordLoss(res.error || `Heartbeat rejected with code ${res.code}`);
        }
      } catch (err: any) {
        recordLoss(err.message || 'Heartbeat execution threw');
      }
    };

    const scheduleNext = () => {
      if (isStopped || leaseLost) return;
      timerHandle = this.timer.setTimeout(async () => {
        timerHandle = null;
        if (isStopped || leaseLost) return;
        inFlightHeartbeatPromise = runHeartbeat();
        await inFlightHeartbeatPromise;
        inFlightHeartbeatPromise = null;
        if (!isStopped && !leaseLost) {
          scheduleNext();
        }
      }, this.heartbeatIntervalMs);
    };

    return {
      start: () => {
        scheduleNext();
      },
      stop: async () => {
        isStopped = true;
        if (timerHandle !== null) {
          this.timer.clearTimeout(timerHandle);
          timerHandle = null;
        }
        if (inFlightHeartbeatPromise !== null) {
          await inFlightHeartbeatPromise;
          inFlightHeartbeatPromise = null;
        }
      },
      isLeaseLost: () => leaseLost,
      getLeaseLossReason: () => leaseLossReason,
      triggerHeartbeatNow: async () => {
        if (isStopped || leaseLost) return;
        inFlightHeartbeatPromise = runHeartbeat();
        await inFlightHeartbeatPromise;
        inFlightHeartbeatPromise = null;
      },
      setDispatchPending: (pending: boolean) => {
        dispatchPending = pending;
      },
    };
  }
}
