import crypto from 'crypto';
import { Repository } from '../database/repositories';
import {
  AccountLease,
  AgentAssignment,
  WorkerSlot,
} from '../types/domain';

export const DEFAULT_LEASE_TTL_MS = 300_000; // 5 minutes
export const MIN_LEASE_TTL_MS = 1_000;       // 1 second
export const MAX_LEASE_TTL_MS = 3_600_000;   // 1 hour

export type SlotLeaseErrorCode =
  | 'ASSIGNMENT_NOT_FOUND'
  | 'ASSIGNMENT_NOT_ACQUIRABLE'
  | 'ASSIGNMENT_ALREADY_LEASED'
  | 'ASSIGNMENT_SLOT_CONFLICT'
  | 'ACCOUNT_AUTH_ERROR'
  | 'ACCOUNT_UNAVAILABLE'
  | 'ACCOUNT_COOLDOWN'
  | 'ACCOUNT_CAPACITY_EXHAUSTED'
  | 'NO_ELIGIBLE_SLOT'
  | 'STALE_LEASE_REQUIRES_RECOVERY'
  | 'LEASE_NOT_FOUND'
  | 'LEASE_TOKEN_MISMATCH'
  | 'LEASE_EXPIRED'
  | 'SLOT_STATE_MISMATCH'
  | 'DURABLE_BINDING_INVARIANT_FAILURE'
  | 'CLAIM_CONTENTION'
  | 'INVALID_TTL';

export interface SlotLeaseSuccess {
  status: 'ACQUIRED';
  lease: AccountLease;
  slot: WorkerSlot;
  assignment: AgentAssignment;
}

export interface SlotLeaseFailure {
  status: 'FAILED';
  code: SlotLeaseErrorCode;
  error: string;
}

export type AcquireSlotLeaseResult = SlotLeaseSuccess | SlotLeaseFailure;

export interface HeartbeatLeaseSuccess {
  status: 'HEARTBEAT_ACKNOWLEDGED';
  lease: AccountLease;
  slot: WorkerSlot;
}

export type HeartbeatLeaseResult = HeartbeatLeaseSuccess | SlotLeaseFailure;

export interface ReleaseLeaseSuccess {
  status: 'RELEASED';
  lease: AccountLease;
  slot: WorkerSlot;
}

export type ReleaseLeaseResult = ReleaseLeaseSuccess | SlotLeaseFailure;

export interface WorkerSlotLeaseServiceOptions {
  clock?: () => Date;
  tokenFactory?: () => string;
  idFactory?: () => string;
}

export class WorkerSlotLeaseService {
  private clock: () => Date;
  private tokenFactory: () => string;
  private idFactory: () => string;

  constructor(
    private repo: Repository,
    options?: WorkerSlotLeaseServiceOptions
  ) {
    this.clock = options?.clock ?? (() => new Date());
    this.tokenFactory = options?.tokenFactory ?? (() => crypto.randomBytes(32).toString('hex'));
    this.idFactory = options?.idFactory ?? (() => crypto.randomUUID());
  }

  /**
   * Atomically claims an eligible WorkerSlot and acquires a durable AccountLease for an AgentAssignment.
   * Input authority is assignmentId only.
   */
  public acquireForAssignment(assignmentId: string, ttlMs?: number): AcquireSlotLeaseResult {
    const effectiveTtl = ttlMs !== undefined ? ttlMs : DEFAULT_LEASE_TTL_MS;
    if (
      typeof effectiveTtl !== 'number' ||
      !Number.isFinite(effectiveTtl) ||
      Number.isNaN(effectiveTtl) ||
      effectiveTtl < MIN_LEASE_TTL_MS ||
      effectiveTtl > MAX_LEASE_TTL_MS
    ) {
      return {
        status: 'FAILED',
        code: 'INVALID_TTL',
        error: `INVALID_TTL: Requested lease TTL (${effectiveTtl} ms) must be a finite number between ${MIN_LEASE_TTL_MS} and ${MAX_LEASE_TTL_MS} ms.`,
      };
    }

    return this.repo.runInImmediateTransaction<AcquireSlotLeaseResult>(() => {
      const now = this.clock();
      const nowIso = now.toISOString();
      const nowMs = now.getTime();

      // 1. Load AgentAssignment
      const assignment = this.repo.getAgentAssignment(assignmentId);
      if (!assignment) {
        return {
          status: 'FAILED',
          code: 'ASSIGNMENT_NOT_FOUND',
          error: `ASSIGNMENT_NOT_FOUND: AgentAssignment "${assignmentId}" not found in database.`,
        };
      }

      if (assignment.status !== 'ASSIGNED') {
        return {
          status: 'FAILED',
          code: 'ASSIGNMENT_NOT_ACQUIRABLE',
          error: `ASSIGNMENT_NOT_ACQUIRABLE: AgentAssignment "${assignmentId}" status is "${assignment.status}", expected "ASSIGNED".`,
        };
      }

      // 2. Validate Durable Provider / Account / Resource Chain
      const provider = this.repo.getProvider(assignment.selected_provider_id);
      const account = this.repo.getProviderAccount(assignment.selected_account_id);
      const resource = this.repo.getProviderResource(assignment.selected_resource_id);

      if (!provider || !account || !resource) {
        return {
          status: 'FAILED',
          code: 'DURABLE_BINDING_INVARIANT_FAILURE',
          error: `DURABLE_BINDING_INVARIANT_FAILURE: Incomplete durable authority chain for assignment "${assignmentId}".`,
        };
      }

      if (account.provider_id !== assignment.selected_provider_id) {
        return {
          status: 'FAILED',
          code: 'DURABLE_BINDING_INVARIANT_FAILURE',
          error: `DURABLE_BINDING_INVARIANT_FAILURE: Account provider mismatch for assignment "${assignmentId}".`,
        };
      }

      if (resource.provider_id !== assignment.selected_provider_id) {
        return {
          status: 'FAILED',
          code: 'DURABLE_BINDING_INVARIANT_FAILURE',
          error: `DURABLE_BINDING_INVARIANT_FAILURE: Resource provider mismatch for assignment "${assignmentId}".`,
        };
      }

      if (!resource.provider_account_id || resource.provider_account_id !== assignment.selected_account_id) {
        return {
          status: 'FAILED',
          code: 'DURABLE_BINDING_INVARIANT_FAILURE',
          error: `DURABLE_BINDING_INVARIANT_FAILURE: Resource account mismatch for assignment "${assignmentId}".`,
        };
      }

      // 3. Current Account Schedulability
      if (!account.enabled) {
        return {
          status: 'FAILED',
          code: 'ACCOUNT_UNAVAILABLE',
          error: `ACCOUNT_UNAVAILABLE: ProviderAccount "${account.id}" is disabled.`,
        };
      }

      if (account.health_status === 'AUTH_ERROR') {
        return {
          status: 'FAILED',
          code: 'ACCOUNT_AUTH_ERROR',
          error: `ACCOUNT_AUTH_ERROR: ProviderAccount "${account.id}" is in AUTH_ERROR state.`,
        };
      }

      if (
        account.health_status === 'OFFLINE' ||
        account.health_status === 'UNHEALTHY' ||
        account.health_status === 'QUOTA_EXHAUSTED' ||
        account.health_status === 'RATE_LIMITED' ||
        account.health_status === 'DISABLED'
      ) {
        return {
          status: 'FAILED',
          code: 'ACCOUNT_UNAVAILABLE',
          error: `ACCOUNT_UNAVAILABLE: ProviderAccount "${account.id}" health status is "${account.health_status}".`,
        };
      }

      if (account.health_status === 'COOLDOWN') {
        return {
          status: 'FAILED',
          code: 'ACCOUNT_COOLDOWN',
          error: `ACCOUNT_COOLDOWN: ProviderAccount "${account.id}" is in COOLDOWN state.`,
        };
      }

      if (account.cooldown_until && new Date(account.cooldown_until).getTime() > nowMs) {
        return {
          status: 'FAILED',
          code: 'ACCOUNT_COOLDOWN',
          error: `ACCOUNT_COOLDOWN: ProviderAccount "${account.id}" cooldown active until "${account.cooldown_until}".`,
        };
      }

      if (account.health_status !== 'AVAILABLE' && account.health_status !== 'LOW_QUOTA') {
        return {
          status: 'FAILED',
          code: 'ACCOUNT_UNAVAILABLE',
          error: `ACCOUNT_UNAVAILABLE: ProviderAccount "${account.id}" health status "${account.health_status}" is not eligible for scheduling.`,
        };
      }

      // 4. Account Concurrency Limit & Stale Leases
      const unreleasedLeases = this.repo.getUnreleasedAccountLeasesByAccount(account.id);
      for (const lease of unreleasedLeases) {
        const expiresMs = new Date(lease.expires_at).getTime();
        if (expiresMs <= nowMs) {
          return {
            status: 'FAILED',
            code: 'STALE_LEASE_REQUIRES_RECOVERY',
            error: `STALE_LEASE_REQUIRES_RECOVERY: ProviderAccount "${account.id}" has an expired unreleased lease "${lease.id}" requiring recovery.`,
          };
        }
      }

      if (unreleasedLeases.length >= account.concurrency_limit) {
        return {
          status: 'FAILED',
          code: 'ACCOUNT_CAPACITY_EXHAUSTED',
          error: `ACCOUNT_CAPACITY_EXHAUSTED: ProviderAccount "${account.id}" active lease count (${unreleasedLeases.length}) has reached concurrency limit (${account.concurrency_limit}).`,
        };
      }

      // 5. Existing Active Lease Check for Assignment
      const activeLeaseForAssignment = this.repo.getActiveLeaseForAssignment(assignment.id);
      if (activeLeaseForAssignment) {
        return {
          status: 'FAILED',
          code: 'ASSIGNMENT_ALREADY_LEASED',
          error: `ASSIGNMENT_ALREADY_LEASED: AgentAssignment "${assignment.id}" already has an active lease "${activeLeaseForAssignment.id}".`,
        };
      }

      // 6. Target Slot Resolution
      let targetSlot: WorkerSlot;
      const unreleasedSlotIds = new Set(unreleasedLeases.map((l) => l.worker_slot_id));

      if (assignment.selected_worker_slot_id) {
        // Pre-bound assignment: must use and validate existing slot binding
        const boundSlot = this.repo.getWorkerSlot(assignment.selected_worker_slot_id);
        if (!boundSlot) {
          return {
            status: 'FAILED',
            code: 'DURABLE_BINDING_INVARIANT_FAILURE',
            error: `DURABLE_BINDING_INVARIANT_FAILURE: Pre-bound slot "${assignment.selected_worker_slot_id}" not found.`,
          };
        }
        if (boundSlot.provider_account_id !== assignment.selected_account_id) {
          return {
            status: 'FAILED',
            code: 'DURABLE_BINDING_INVARIANT_FAILURE',
            error: `DURABLE_BINDING_INVARIANT_FAILURE: Pre-bound slot account mismatch.`,
          };
        }
        if (boundSlot.provider_resource_id && boundSlot.provider_resource_id !== assignment.selected_resource_id) {
          return {
            status: 'FAILED',
            code: 'DURABLE_BINDING_INVARIANT_FAILURE',
            error: `DURABLE_BINDING_INVARIANT_FAILURE: Pre-bound slot resource mismatch.`,
          };
        }
        if (
          boundSlot.status !== 'IDLE' ||
          boundSlot.current_assignment_id !== null ||
          boundSlot.current_execution_id !== null ||
          unreleasedSlotIds.has(boundSlot.id)
        ) {
          return {
            status: 'FAILED',
            code: 'SLOT_STATE_MISMATCH',
            error: `SLOT_STATE_MISMATCH: Pre-bound slot "${boundSlot.id}" is not in available IDLE state (status=${boundSlot.status}).`,
          };
        }
        targetSlot = boundSlot;
      } else {
        // Fresh allocation: find deterministically eligible slot for account
        const accountSlots = this.repo.getWorkerSlotsByAccount(assignment.selected_account_id);
        const eligibleSlots = accountSlots.filter((slot) => {
          if (slot.provider_account_id !== assignment.selected_account_id) return false;
          if (slot.status !== 'IDLE') return false;
          if (slot.current_assignment_id !== null) return false;
          if (slot.current_execution_id !== null) return false;
          if (unreleasedSlotIds.has(slot.id)) return false;
          if (slot.provider_resource_id !== null && slot.provider_resource_id !== assignment.selected_resource_id) {
            return false;
          }
          return true;
        });

        // Deterministic ordering: slot_index ASC, then id ASC
        eligibleSlots.sort((a, b) => {
          if (a.slot_index !== b.slot_index) return a.slot_index - b.slot_index;
          return a.id.localeCompare(b.id);
        });

        if (eligibleSlots.length === 0) {
          return {
            status: 'FAILED',
            code: 'NO_ELIGIBLE_SLOT',
            error: `NO_ELIGIBLE_SLOT: No idle, compatible worker slots available for account "${account.id}".`,
          };
        }
        targetSlot = eligibleSlots[0];
      }

      // 7. Atomic Claim Execution
      if (!assignment.selected_worker_slot_id) {
        const bound = this.repo.bindAgentAssignmentWorkerSlotIfUnbound(assignment.id, targetSlot.id);
        if (!bound) {
          throw new Error(`CLAIM_CONTENTION: Failed to bind assignment "${assignment.id}" to slot "${targetSlot.id}".`);
        }
      }

      const leaseId = this.idFactory();
      const leaseToken = this.tokenFactory();
      const expiresIso = new Date(nowMs + effectiveTtl).toISOString();

      const newLease: AccountLease = {
        id: leaseId,
        assignment_id: assignment.id,
        provider_account_id: assignment.selected_account_id,
        worker_slot_id: targetSlot.id,
        lease_token: leaseToken,
        acquired_at: nowIso,
        expires_at: expiresIso,
        heartbeat_at: nowIso,
        released_at: null,
      };

      try {
        this.repo.createAccountLease(newLease);
      } catch (err: any) {
        throw new Error(`CLAIM_CONTENTION: Failed to create account lease: ${err.message}`);
      }

      this.repo.updateWorkerSlotStatus(targetSlot.id, 'LEASED', assignment.id, null, nowIso);

      const updatedAssignment = this.repo.getAgentAssignment(assignment.id)!;
      const updatedSlot = this.repo.getWorkerSlot(targetSlot.id)!;

      return {
        status: 'ACQUIRED',
        lease: newLease,
        slot: updatedSlot,
        assignment: updatedAssignment,
      };
    });
  }

  /**
   * Extends the lease TTL and updates heartbeat for a token-owned unreleased lease.
   */
  public heartbeat(leaseId: string, leaseToken: string, ttlMs?: number): HeartbeatLeaseResult {
    const effectiveTtl = ttlMs !== undefined ? ttlMs : DEFAULT_LEASE_TTL_MS;
    if (
      typeof effectiveTtl !== 'number' ||
      !Number.isFinite(effectiveTtl) ||
      Number.isNaN(effectiveTtl) ||
      effectiveTtl < MIN_LEASE_TTL_MS ||
      effectiveTtl > MAX_LEASE_TTL_MS
    ) {
      return {
        status: 'FAILED',
        code: 'INVALID_TTL',
        error: `INVALID_TTL: Requested lease TTL (${effectiveTtl} ms) must be a finite number between ${MIN_LEASE_TTL_MS} and ${MAX_LEASE_TTL_MS} ms.`,
      };
    }

    return this.repo.runInImmediateTransaction<HeartbeatLeaseResult>(() => {
      const now = this.clock();
      const nowIso = now.toISOString();
      const nowMs = now.getTime();

      const lease = this.repo.getAccountLease(leaseId);
      if (!lease || lease.released_at !== null) {
        return {
          status: 'FAILED',
          code: 'LEASE_NOT_FOUND',
          error: `LEASE_NOT_FOUND: Active lease "${leaseId}" not found or already released.`,
        };
      }

      if (lease.lease_token !== leaseToken) {
        return {
          status: 'FAILED',
          code: 'LEASE_TOKEN_MISMATCH',
          error: `LEASE_TOKEN_MISMATCH: Provided token does not match lease "${leaseId}".`,
        };
      }

      const expiresMs = new Date(lease.expires_at).getTime();
      if (expiresMs <= nowMs) {
        return {
          status: 'FAILED',
          code: 'LEASE_EXPIRED',
          error: `LEASE_EXPIRED: Lease "${leaseId}" expired at "${lease.expires_at}". Expired leases cannot be renewed.`,
        };
      }

      const slot = this.repo.getWorkerSlot(lease.worker_slot_id);
      if (!slot || slot.current_assignment_id !== lease.assignment_id || slot.status !== 'LEASED') {
        return {
          status: 'FAILED',
          code: 'SLOT_STATE_MISMATCH',
          error: `SLOT_STATE_MISMATCH: Slot "${lease.worker_slot_id}" is not in valid LEASED state for assignment "${lease.assignment_id}".`,
        };
      }

      const newExpiresIso = new Date(nowMs + effectiveTtl).toISOString();
      const updated = this.repo.updateAccountLeaseHeartbeat(lease.id, leaseToken, nowIso, newExpiresIso);
      if (!updated) {
        return {
          status: 'FAILED',
          code: 'LEASE_NOT_FOUND',
          error: `LEASE_NOT_FOUND: Failed to update heartbeat on lease "${lease.id}".`,
        };
      }

      this.repo.updateWorkerSlotHeartbeat(slot.id, nowIso);

      const updatedLease = this.repo.getAccountLease(lease.id)!;
      const updatedSlot = this.repo.getWorkerSlot(slot.id)!;

      return {
        status: 'HEARTBEAT_ACKNOWLEDGED',
        lease: updatedLease,
        slot: updatedSlot,
      };
    });
  }

  /**
   * Releases an unreleased AccountLease and resets the associated WorkerSlot back to IDLE.
   * Retains the historical assignment.selected_worker_slot_id binding.
   */
  public release(leaseId: string, leaseToken: string): ReleaseLeaseResult {
    return this.repo.runInImmediateTransaction<ReleaseLeaseResult>(() => {
      const now = this.clock();
      const nowIso = now.toISOString();

      const lease = this.repo.getAccountLease(leaseId);
      if (!lease || lease.released_at !== null) {
        return {
          status: 'FAILED',
          code: 'LEASE_NOT_FOUND',
          error: `LEASE_NOT_FOUND: Active lease "${leaseId}" not found or already released.`,
        };
      }

      if (lease.lease_token !== leaseToken) {
        return {
          status: 'FAILED',
          code: 'LEASE_TOKEN_MISMATCH',
          error: `LEASE_TOKEN_MISMATCH: Provided token does not match lease "${leaseId}".`,
        };
      }

      const slot = this.repo.getWorkerSlot(lease.worker_slot_id);
      if (!slot || slot.current_assignment_id !== lease.assignment_id || slot.status !== 'LEASED') {
        return {
          status: 'FAILED',
          code: 'SLOT_STATE_MISMATCH',
          error: `SLOT_STATE_MISMATCH: Slot "${lease.worker_slot_id}" is not in valid LEASED state for assignment "${lease.assignment_id}".`,
        };
      }

      const assignment = this.repo.getAgentAssignment(lease.assignment_id);
      if (!assignment || assignment.selected_worker_slot_id !== lease.worker_slot_id) {
        return {
          status: 'FAILED',
          code: 'DURABLE_BINDING_INVARIANT_FAILURE',
          error: `DURABLE_BINDING_INVARIANT_FAILURE: Assignment slot binding mismatch for lease "${leaseId}".`,
        };
      }

      const released = this.repo.releaseAccountLeaseWithToken(lease.id, leaseToken, nowIso);
      if (!released) {
        return {
          status: 'FAILED',
          code: 'LEASE_NOT_FOUND',
          error: `LEASE_NOT_FOUND: Failed to release lease "${lease.id}".`,
        };
      }

      this.repo.updateWorkerSlotStatus(slot.id, 'IDLE', null, null, nowIso);

      const updatedLease = this.repo.getAccountLease(lease.id)!;
      const updatedSlot = this.repo.getWorkerSlot(slot.id)!;

      return {
        status: 'RELEASED',
        lease: updatedLease,
        slot: updatedSlot,
      };
    });
  }
}
