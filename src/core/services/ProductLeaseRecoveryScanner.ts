import crypto from 'crypto';
import Database from 'better-sqlite3';
import { Repository } from '../database/repositories';
import { EventRecord, TaskState } from '../types/domain';
import { ReleaseLeaseResult, WorkerSlotLeaseService } from './WorkerSlotLeaseService';

/**
 * Product-task leases are acquired immediately before dispatch and are
 * therefore safe to recover only when the task is still before execution or
 * already terminal. Active lifecycle states are deliberately quarantined: an
 * expired timestamp alone is not proof that a provider process has stopped.
 */
export const PRODUCT_LEASE_RECOVERABLE_TASK_STATES: readonly TaskState[] = [
  'APPROVED',
  'QUEUED',
  'DONE',
  'FAILED',
  'CANCELLED',
];

const PRODUCT_LEASE_ACTIVE_TASK_STATES = new Set<TaskState>([
  'DISPATCHED',
  'CODING',
  'VALIDATING',
  'REVIEW_READY',
  'REVIEWING',
  'PAUSED',
  'FIX_REQUIRED',
  'HANDOFF_REQUIRED',
  'WAITING_FOR_CAPACITY',
  'WAITING_FOR_AUTHORITY',
  'BLOCKED',
  'NEEDS_HUMAN',
]);

export const PRODUCT_LEASE_RECOVERY_REQUIRED_EVENT = 'PRODUCT_LEASE_RECOVERY_REQUIRED';
export const PRODUCT_LEASE_RECOVERY_RESOLVED_EVENT = 'PRODUCT_LEASE_RECOVERY_RESOLVED';
const PRODUCT_LEASE_RECOVERY_PROTOCOL_VERSION = 'productleaserecovery.v1';
const MAX_MARKER_REASON_LENGTH = 512;

export type ProductLeaseRecoveryDisposition =
  | 'RELEASED'
  | 'ALREADY_RELEASED'
  | 'QUARANTINED'
  | 'DEFERRED'
  | 'FAILED';

export interface ProductLeaseRecoveryItem {
  leaseId: string;
  assignmentId: string;
  taskId: string | null;
  projectId: string | null;
  accountId: string;
  workerSlotId: string;
  disposition: ProductLeaseRecoveryDisposition;
  reason?: string;
  markerEventId?: string | null;
}

export interface ProductLeaseRecoveryScanReport {
  scannedCount: number;
  releasedCount: number;
  alreadyReleasedCount: number;
  quarantinedCount: number;
  deferredCount: number;
  failedCount: number;
  items: ProductLeaseRecoveryItem[];
  scannedAt: string;
}

export interface ProductLeaseRecoveryMarkerInput {
  leaseId: string;
  assignmentId: string;
  taskId: string | null;
  projectId: string;
  accountId: string;
  workerSlotId: string;
  leaseToken: string;
  reasonCode: string;
  reason: string;
  observedAt: string;
}

export interface ProductLeaseRecoveryResolvedInput {
  leaseId: string;
  assignmentId: string;
  taskId: string | null;
  projectId: string;
  accountId: string;
  workerSlotId: string;
  leaseToken: string;
  markerEventId: string;
  observedAt: string;
}

export function productLeaseOwnerFingerprint(leaseToken: string): string {
  return crypto.createHash('sha256').update(leaseToken, 'utf8').digest('hex');
}

function eventId(seed: string): string {
  // Event ids are text keys. A deterministic hash makes repeated retries a
  // no-op while keeping the raw owner token out of durable evidence.
  return crypto.createHash('sha256').update(seed, 'utf8').digest('hex');
}

function boundedReason(reason: string, leaseToken: string): string {
  const redacted = String(reason || 'unspecified')
    .replaceAll(leaseToken, '[REDACTED_OWNER_TOKEN]')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  return redacted.slice(0, MAX_MARKER_REASON_LENGTH);
}

/** Builds the deterministic durable marker written when cleanup needs recovery. */
export function createProductLeaseRecoveryMarkerEvent(input: ProductLeaseRecoveryMarkerInput): EventRecord {
  const ownerTokenHash = productLeaseOwnerFingerprint(input.leaseToken);
  return {
    id: eventId(`${PRODUCT_LEASE_RECOVERY_PROTOCOL_VERSION}:required:${input.leaseId}:${ownerTokenHash}`),
    project_id: input.projectId,
    task_id: input.taskId,
    agent_id: null,
    type: PRODUCT_LEASE_RECOVERY_REQUIRED_EVENT,
    summary: `Product lease "${input.leaseId}" requires fenced recovery (${input.reasonCode}).`,
    structured_payload: {
      protocol_version: PRODUCT_LEASE_RECOVERY_PROTOCOL_VERSION,
      lease_id: input.leaseId,
      assignment_id: input.assignmentId,
      task_id: input.taskId,
      provider_account_id: input.accountId,
      worker_slot_id: input.workerSlotId,
      owner_token_sha256: ownerTokenHash,
      reason_code: input.reasonCode,
      reason: boundedReason(input.reason, input.leaseToken),
      observed_at: input.observedAt,
    },
    timestamp: input.observedAt,
  };
}

/** Builds a deterministic evidence event proving that a previous marker was resolved. */
export function createProductLeaseRecoveryResolvedEvent(input: ProductLeaseRecoveryResolvedInput): EventRecord {
  const ownerTokenHash = productLeaseOwnerFingerprint(input.leaseToken);
  return {
    id: eventId(`${PRODUCT_LEASE_RECOVERY_PROTOCOL_VERSION}:resolved:${input.markerEventId}`),
    project_id: input.projectId,
    task_id: input.taskId,
    agent_id: null,
    type: PRODUCT_LEASE_RECOVERY_RESOLVED_EVENT,
    summary: `Product lease "${input.leaseId}" recovery marker resolved.`,
    structured_payload: {
      protocol_version: PRODUCT_LEASE_RECOVERY_PROTOCOL_VERSION,
      lease_id: input.leaseId,
      assignment_id: input.assignmentId,
      task_id: input.taskId,
      provider_account_id: input.accountId,
      worker_slot_id: input.workerSlotId,
      owner_token_sha256: ownerTokenHash,
      recovery_marker_event_id: input.markerEventId,
      observed_at: input.observedAt,
    },
    timestamp: input.observedAt,
  };
}

interface CandidateLeaseRow {
  lease_id: string;
  lease_token: string;
  assignment_id: string;
  provider_account_id: string;
  worker_slot_id: string;
  expires_at: string;
  task_id: string | null;
  assignment_project_id: string | null;
  assignment_account_id: string | null;
  project_id: string | null;
  task_state: TaskState | null;
  slot_status: string | null;
  slot_account_id: string | null;
  slot_assignment_id: string | null;
  slot_execution_id: string | null;
}

/**
 * Reconciles expired product account leases after migrations and before new
 * dispatches. It never clears a row by id alone: the owner token, expiry, slot
 * binding, and a recoverable task state are checked by the same immediate
 * transaction that settles the lease.
 */
export class ProductLeaseRecoveryScanner {
  private readonly leaseService: WorkerSlotLeaseService;
  private readonly clock: () => Date;

  constructor(
    private readonly db: Database.Database,
    private readonly repo: Repository,
    options?: {
      leaseService?: WorkerSlotLeaseService;
      clock?: () => Date;
    },
  ) {
    this.leaseService = options?.leaseService ?? new WorkerSlotLeaseService(repo, { clock: options?.clock });
    this.clock = options?.clock ?? (() => new Date());
  }

  public scanAndReconcile(): ProductLeaseRecoveryScanReport {
    const now = this.clock();
    const nowIso = now.toISOString();
    const rows = this.db
      .prepare(`
        SELECT
          l.id AS lease_id,
          l.lease_token,
          l.assignment_id,
          l.provider_account_id,
          l.worker_slot_id,
          l.expires_at,
          a.task_id,
          a.project_id AS assignment_project_id,
          a.selected_account_id AS assignment_account_id,
          t.project_id,
          t.state AS task_state,
          s.status AS slot_status,
          s.provider_account_id AS slot_account_id,
          s.current_assignment_id AS slot_assignment_id,
          s.current_execution_id AS slot_execution_id
        FROM account_leases l
        LEFT JOIN agent_assignments a ON a.id = l.assignment_id
        LEFT JOIN tasks t ON t.id = a.task_id
        LEFT JOIN worker_slots s ON s.id = l.worker_slot_id
        WHERE l.released_at IS NULL
        ORDER BY l.expires_at ASC, l.id ASC
      `)
      .all() as CandidateLeaseRow[];

    // Timestamps are persisted as ISO strings, but legacy fixtures and
    // operator repair tools may use SQLite's space-separated format or an
    // invalid value. Do the temporal comparison in JavaScript so lexical SQL
    // ordering cannot classify a future/non-UTC row as expired. Invalid
    // timestamps remain candidates and are quarantined explicitly below.
    const candidates = rows.filter((row) => {
      const expiresMs = new Date(row.expires_at).getTime();
      return !Number.isFinite(expiresMs) || expiresMs <= now.getTime();
    });
    const items = candidates.map((row) => this.reconcileCandidate(row, now));
    return {
      scannedCount: items.length,
      releasedCount: items.filter((item) => item.disposition === 'RELEASED').length,
      alreadyReleasedCount: items.filter((item) => item.disposition === 'ALREADY_RELEASED').length,
      quarantinedCount: items.filter((item) => item.disposition === 'QUARANTINED').length,
      deferredCount: items.filter((item) => item.disposition === 'DEFERRED').length,
      failedCount: items.filter((item) => item.disposition === 'FAILED').length,
      items,
      scannedAt: nowIso,
    };
  }

  private reconcileCandidate(row: CandidateLeaseRow, now: Date): ProductLeaseRecoveryItem {
    const base: ProductLeaseRecoveryItem = {
      leaseId: String(row.lease_id),
      assignmentId: String(row.assignment_id),
      taskId: row.task_id ? String(row.task_id) : null,
      projectId: row.project_id ? String(row.project_id) : null,
      accountId: String(row.provider_account_id),
      workerSlotId: String(row.worker_slot_id),
      disposition: 'FAILED',
    };

    const expiresMs = new Date(row.expires_at).getTime();
    if (!Number.isFinite(expiresMs)) {
      const reason = `Lease expiration "${row.expires_at}" is invalid; manual owner resolution is required.`;
      base.disposition = 'QUARANTINED';
      base.reason = reason;
      base.markerEventId = this.persistMarker(row, 'QUARANTINED', 'LEASE_EXPIRY_INVALID', reason, now);
      return base;
    }

    const activeProcess = row.task_id
      ? this.repo.getProcessRunsByTask(String(row.task_id)).some((process) => process.status === 'RUNNING')
      : false;
    const taskState = row.task_state ?? null;
    const bindingIncomplete = !row.task_id || !row.project_id || !row.assignment_project_id || !row.assignment_account_id || !taskState || !row.slot_status || !row.slot_account_id || !row.slot_assignment_id;
    const bindingMismatch = !bindingIncomplete && (
      row.assignment_project_id !== row.project_id ||
      row.assignment_account_id !== row.provider_account_id ||
      row.slot_account_id !== row.provider_account_id ||
      row.slot_assignment_id !== row.assignment_id
    );
    const activeTask = taskState !== null && PRODUCT_LEASE_ACTIVE_TASK_STATES.has(taskState);
    const slotBusy = row.slot_status === 'RUNNING' || row.slot_execution_id !== null;

    if (bindingIncomplete || bindingMismatch || activeProcess || activeTask || slotBusy) {
      const reasonCode = bindingIncomplete
        ? 'BINDING_INCOMPLETE'
        : bindingMismatch
          ? 'BINDING_MISMATCH'
          : activeProcess
          ? 'PROCESS_STILL_RUNNING'
          : activeTask
            ? 'TASK_STATE_ACTIVE'
            : 'SLOT_EXECUTION_ACTIVE';
      const reason = bindingIncomplete
        ? 'Lease binding graph is incomplete; manual owner resolution is required.'
        : bindingMismatch
          ? 'Lease, assignment, task, and worker-slot account/project bindings disagree; manual owner resolution is required.'
          : activeProcess
          ? `A RUNNING process remains for task "${row.task_id}"; capacity is fenced.`
          : activeTask
            ? `Task "${row.task_id}" remains in active state "${taskState}"; capacity is fenced.`
            : `Worker slot "${row.worker_slot_id}" still reports active execution ownership.`;
      base.disposition = 'QUARANTINED';
      base.reason = reason;
      base.markerEventId = this.persistMarker(row, 'QUARANTINED', reasonCode, reason, now);
      return base;
    }

    let recovered: ReleaseLeaseResult;
    let resolvedMarkerEventId: string | null = null;
    try {
      // The scanner only revisits unreleased leases. Commit release and its
      // existing recovery marker's closure together, so an evidence failure
      // cannot strand a marker on a lease that future scans will skip. The
      // lease service's nested transaction remains owner/task-state fenced.
      const recovery = this.repo.runInImmediateTransaction(() => {
        const result = this.leaseService.recoverExpiredLease(row.lease_id, row.lease_token, now, {
          expectedTaskStates: PRODUCT_LEASE_RECOVERABLE_TASK_STATES,
        });
        let markerEventId: string | null = null;
        if (result.status === 'RELEASED') {
          const existingMarkerId = this.markerIdFor(row);
          if (this.hasEvent(existingMarkerId)) {
            this.persistResolvedMarker(row, existingMarkerId, now);
            markerEventId = existingMarkerId;
          }
        }
        return { result, markerEventId };
      });
      recovered = recovery.result;
      resolvedMarkerEventId = recovery.markerEventId;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      base.disposition = 'DEFERRED';
      base.reason = `Recovery transaction failed and will be retried: ${reason}`;
      base.markerEventId = this.persistMarker(row, 'DEFERRED', 'RECOVERY_TRANSACTION_FAILED', base.reason, now);
      return base;
    }

    if (recovered.status === 'RELEASED') {
      base.disposition = 'RELEASED';
      base.reason = 'Expired product lease released with owner-token and task-state fencing.';
      if (resolvedMarkerEventId !== null) base.markerEventId = resolvedMarkerEventId;
      return base;
    }

    const current = this.repo.getAccountLease(row.lease_id);
    if (!current || current.released_at !== null) {
      base.disposition = 'ALREADY_RELEASED';
      base.reason = 'Another owner already released this lease; no mutation was performed.';
      return base;
    }

    const reasonCode = recovered.code === 'LEASE_NOT_EXPIRED'
      ? 'LEASE_RENEWED_DURING_SCAN'
      : recovered.code === 'RECOVERY_TASK_STATE_CHANGED'
        ? 'TASK_STATE_CHANGED_DURING_SCAN'
        : recovered.code;
    base.disposition = recovered.code === 'LEASE_NOT_EXPIRED' || recovered.code === 'RECOVERY_TASK_STATE_CHANGED'
      ? 'DEFERRED'
      : 'QUARANTINED';
    base.reason = recovered.error;
    base.markerEventId = this.persistMarker(row, base.disposition, reasonCode, recovered.error, now);
    return base;
  }

  private markerIdFor(row: CandidateLeaseRow): string {
    return createProductLeaseRecoveryMarkerEvent({
      leaseId: row.lease_id,
      assignmentId: row.assignment_id,
      taskId: row.task_id,
      projectId: row.project_id ?? '',
      accountId: row.provider_account_id,
      workerSlotId: row.worker_slot_id,
      leaseToken: row.lease_token,
      reasonCode: 'RECOVERY_REQUIRED',
      reason: 'Product lease cleanup recovery marker.',
      observedAt: row.expires_at,
    }).id;
  }

  private persistMarker(
    row: CandidateLeaseRow,
    disposition: ProductLeaseRecoveryDisposition,
    reasonCode: string,
    reason: string,
    now: Date,
  ): string | null {
    if (!row.project_id) return null;
    const marker = createProductLeaseRecoveryMarkerEvent({
      leaseId: row.lease_id,
      assignmentId: row.assignment_id,
      taskId: row.task_id,
      projectId: row.project_id,
      accountId: row.provider_account_id,
      workerSlotId: row.worker_slot_id,
      leaseToken: row.lease_token,
      reasonCode: `${disposition}_${reasonCode}`,
      reason,
      observedAt: now.toISOString(),
    });
    try {
      this.repo.createDeterministicGenericEvent(marker);
      return marker.id;
    } catch {
      // A busy/closed database must not turn recovery into an unhandled
      // rejection. The active lease remains fenced and the next scan retries.
      return null;
    }
  }

  private persistResolvedMarker(row: CandidateLeaseRow, markerEventId: string, now: Date): void {
    if (!row.project_id) throw new Error('PRODUCT_LEASE_RECOVERY_PROJECT_MISSING');
    const resolved = createProductLeaseRecoveryResolvedEvent({
      leaseId: row.lease_id,
      assignmentId: row.assignment_id,
      taskId: row.task_id,
      projectId: row.project_id,
      accountId: row.provider_account_id,
      workerSlotId: row.worker_slot_id,
      leaseToken: row.lease_token,
      markerEventId,
      observedAt: now.toISOString(),
    });
    // Let persistence errors reach the enclosing recovery transaction. Its
    // rollback keeps both the lease and slot discoverable for a later retry.
    this.repo.createDeterministicGenericEvent(resolved);
  }

  private hasEvent(id: string): boolean {
    const row = this.db.prepare('SELECT 1 AS present FROM events WHERE id = ? LIMIT 1').get(id) as { present?: number } | undefined;
    return row?.present === 1;
  }
}
