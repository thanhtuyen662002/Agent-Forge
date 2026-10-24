import { Repository } from '../database/repositories';
import { canonicalJsonStringify, computeSha256 } from '../context/ContextIntegrity';
import type {
  ExecutionAuthorization,
  ExecutionRecoveryClassification,
  ExecutionRecoveryDisposition,
  ExecutionRecoveryScanItemResult,
} from '../types/domain';

export const PRODUCT_RECOVERY_EVENT = 'PRODUCT_EXECUTION_RECOVERY';

/** True for a lifecycle-v1 PRODUCT_BOUND authorization bound to an ordinary (non-handoff) assignment. */
export function isProductAssignmentAuthorization(repo: Repository, auth: ExecutionAuthorization): boolean {
  return auth.lifecycle_version === 1 && Boolean(auth.assignment_id) && !repo.getHandoffTransferBySuccessorAuthId(auth.id);
}

/**
 * Restart recovery for product executions. It only acts on exact durable
 * receipts and never fabricates a result:
 *
 * - AUTHORIZED: left untouched. An owner may still dispatch it; desktop
 *   automation expires only the authorizations it created itself.
 * - DISPATCHED whose adapter start was never claimed: nothing can be running
 *   after a restart, so it is expired and its attempt, assignment, lease and
 *   slot are released.
 * - Settled with verified product settlement evidence: the lease and slot
 *   that the interrupted scheduler did not release are released.
 * - Adapter start claimed but not settled: stays fenced. A terminal
 *   process_runs row without a settlement is RESULT_MISSING, never success.
 *
 * Must be called at startup, before this process can dispatch anything.
 */
export class DirectProductExecutionLifecycle {
  constructor(private readonly repo: Repository, private readonly now: () => string = () => new Date().toISOString()) {}

  public reconcile(input: ExecutionAuthorization): ExecutionRecoveryScanItemResult {
    return this.repo.runInImmediateTransaction(() => {
      const auth = this.repo.getExecutionAuthorization(input.id)!;
      const nowIso = this.now();
      let classification: ExecutionRecoveryClassification;
      let disposition: ExecutionRecoveryDisposition;
      let mutatedTerminalState = false;
      let mutatedResources = false;

      const task = this.repo.getTask(auth.task_id);
      const assignment = auth.assignment_id ? this.repo.getAgentAssignment(auth.assignment_id) : null;
      if (!task || task.project_id !== auth.project_id || !assignment || assignment.task_id !== auth.task_id ||
          (auth.task_ownership_epoch != null && this.repo.getTaskOwnershipEpoch(task.id) !== auth.task_ownership_epoch)) {
        classification = 'AUTHORITY_CONFLICT';
        disposition = 'REJECTED_INTEGRITY_CONFLICT';
      } else if (auth.status === 'INVALIDATED') {
        // Pre-claim cleanup (or an earlier recovery) already expired it; finish releasing what remains.
        mutatedResources = this.releaseResources(auth, nowIso, 'FAILED');
        classification = mutatedResources ? 'RESULT_PERSISTED_STATE_INCOMPLETE' : 'ALREADY_RECONCILED';
        disposition = mutatedResources ? 'TERMINAL_STATE_RECONCILED' : 'NO_OP_ALREADY_RECONCILED';
      } else if (auth.status === 'AUTHORIZED') {
        classification = 'ALREADY_RECONCILED';
        disposition = 'NO_OP_ALREADY_RECONCILED';
      } else if (auth.status === 'DISPATCHED' && !auth.adapter_started_at && !auth.settled_at) {
        classification = 'PRE_ADAPTER_NOT_STARTED';
        disposition = 'TERMINALIZED_SAFE_EXPIRED';
        mutatedTerminalState = this.repo.expireUnstartedProductAuthorization(auth.id);
        mutatedResources = this.releaseResources(auth, nowIso, 'FAILED');
      } else if (auth.settled_at) {
        if (!this.hasValidProductSettlement(auth)) {
          classification = 'AUTHORITY_CONFLICT';
          disposition = 'REJECTED_INTEGRITY_CONFLICT';
        } else {
          mutatedResources = this.releaseResources(auth, nowIso, null);
          classification = mutatedResources ? 'RESULT_PERSISTED_STATE_INCOMPLETE' : 'ALREADY_RECONCILED';
          disposition = mutatedResources ? 'TERMINAL_STATE_RECONCILED' : 'NO_OP_ALREADY_RECONCILED';
        }
      } else {
        const run = auth.execution_id ? this.repo.getProcessRun(auth.execution_id) : null;
        const terminalRun = run && run.status && run.status !== 'RUNNING';
        classification = terminalRun ? 'ADAPTER_FINISHED_RESULT_MISSING' : 'ADAPTER_IN_FLIGHT_UNRESOLVED';
        disposition = terminalRun ? 'RESULT_MISSING_FENCED' : 'UNRESOLVED_FENCED';
      }

      const current = this.repo.getExecutionAuthorization(auth.id)!;
      const evidence = {
        authorizationId: current.id, executionId: current.execution_id ?? null, status: current.status,
        startedAt: current.adapter_started_at ?? null, settledAt: current.settled_at ?? null,
        settlementHash: current.settlement_evidence_hash ?? null, assignmentId: current.assignment_id ?? null,
        classification, disposition, mutatedTerminalState, mutatedResources,
      };
      const evidenceHash = computeSha256(canonicalJsonStringify(evidence));
      this.repo.createDeterministicGenericEvent({
        id: `evt-prod-rec-${computeSha256(`${current.id}:${evidenceHash}`).slice(0, 32)}`,
        project_id: current.project_id, task_id: current.task_id, agent_id: null, type: PRODUCT_RECOVERY_EVENT,
        summary: `${PRODUCT_RECOVERY_EVENT}: ${current.id} ${classification}`,
        structured_payload: { authorizationId: current.id, evidence }, timestamp: nowIso,
      });
      return {
        authorizationId: current.id, transferId: null, executionId: current.execution_id ?? null,
        lifecycleVersion: current.lifecycle_version ?? null, classification, disposition,
        mutatedTerminalState, mutatedResources, evidenceHash,
      };
    });
  }

  /** Re-proves stored product settlement evidence: exact hash, this authorization, no handoff transfer. */
  private hasValidProductSettlement(auth: ExecutionAuthorization): boolean {
    if (!auth.settlement_evidence_json || !auth.settlement_evidence_hash || !auth.settlement_status) return false;
    try {
      const evidence = JSON.parse(auth.settlement_evidence_json) as Record<string, unknown>;
      return computeSha256(canonicalJsonStringify(evidence)) === auth.settlement_evidence_hash &&
        evidence.authorization_id === auth.id && evidence.execution_id === auth.execution_id &&
        evidence.transfer_id === null && evidence.assignment_id === auth.assignment_id &&
        evidence.lifecycle_version === 1 && evidence.settlement_status === auth.settlement_status;
    } catch {
      return false;
    }
  }

  /**
   * Releases the assignment's unreleased lease and slot through the guarded
   * primitive, then ends a still-active attempt/assignment when requested.
   */
  private releaseResources(auth: ExecutionAuthorization, nowIso: string, terminal: 'FAILED' | null): boolean {
    let changed = false;
    const assignment = this.repo.getAgentAssignment(auth.assignment_id!);
    if (!assignment) return false;
    const lease = this.repo.getActiveLeaseForAssignment(assignment.id);
    if (lease) {
      const slot = this.repo.getWorkerSlot(lease.worker_slot_id);
      const released = this.repo.releaseGuardedAccountLeaseAndIdleSlot({
        leaseId: lease.id,
        expectedAssignmentId: assignment.id,
        expectedAccountId: lease.provider_account_id,
        expectedSlotId: lease.worker_slot_id,
        expectedExecutionId: slot?.current_execution_id ?? null,
        releasedAt: nowIso,
      });
      changed = released.success || changed;
    }
    if (terminal) {
      changed = this.repo.endUnleasedAgentAssignment(assignment.id, terminal, nowIso) || changed;
      if (auth.attempt_id) changed = this.repo.endRunningTaskAttempt(auth.attempt_id, terminal, nowIso) || changed;
    }
    return changed;
  }
}
