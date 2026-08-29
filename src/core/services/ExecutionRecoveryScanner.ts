import Database from 'better-sqlite3';
import { Repository } from '../database/repositories';
import { EventService } from './EventService';
import {
  ExecutionAuthorization,
  HandoffTransfer,
  ExecutionRecoveryClassification,
  ExecutionRecoveryDisposition,
  ExecutionRecoveryState,
  ExecutionRecoveryScanItemResult,
  ExecutionRecoveryScanReport,
  HandoffTransferStatus,
} from '../types/domain';
import { canonicalJsonStringify, computeSha256 } from '../context/ContextIntegrity';

export class ExecutionRecoveryScanner {
  constructor(
    private db: Database.Database,
    private repo: Repository,
    private eventService?: EventService
  ) {}

  public scanAndReconcile(): ExecutionRecoveryScanReport {
    const nowIso = new Date().toISOString();

    // Query candidate execution authorizations bound to handoff transfers in deterministic order
    const rows = this.db
      .prepare(`
        SELECT ea.id as authorization_id
        FROM execution_authorizations ea
        JOIN handoff_transfers ht ON ht.successor_authorization_id = ea.id
        ORDER BY ea.created_at ASC, ea.id ASC
      `)
      .all() as Array<{ authorization_id: string }>;

    const items: ExecutionRecoveryScanItemResult[] = [];
    let reconciledCount = 0;
    let unresolvedCount = 0;
    let rejectedCount = 0;
    let noOpCount = 0;

    let preAdapterNotStartedCount = 0;
    let adapterInFlightUnresolvedCount = 0;
    let adapterTerminatedTimeoutCount = 0;
    let adapterFinishedResultMissingCount = 0;
    let resultPersistedStateIncompleteCount = 0;
    let alreadyReconciledCount = 0;
    let legacyUnclassifiableCount = 0;
    let authorityConflictCount = 0;

    for (const row of rows) {
      try {
        const itemResult = this.reconcileAuthorization(row.authorization_id);
        items.push(itemResult);

        switch (itemResult.classification) {
          case 'PRE_ADAPTER_NOT_STARTED':
            preAdapterNotStartedCount++;
            reconciledCount++;
            break;
          case 'ADAPTER_IN_FLIGHT_UNRESOLVED':
            adapterInFlightUnresolvedCount++;
            unresolvedCount++;
            break;
          case 'ADAPTER_TERMINATED_AFTER_TIMEOUT':
            adapterTerminatedTimeoutCount++;
            reconciledCount++;
            break;
          case 'ADAPTER_FINISHED_RESULT_MISSING':
            adapterFinishedResultMissingCount++;
            unresolvedCount++;
            break;
          case 'RESULT_PERSISTED_STATE_INCOMPLETE':
            resultPersistedStateIncompleteCount++;
            reconciledCount++;
            break;
          case 'ALREADY_RECONCILED':
            alreadyReconciledCount++;
            noOpCount++;
            break;
          case 'LEGACY_UNCLASSIFIABLE':
            legacyUnclassifiableCount++;
            unresolvedCount++;
            break;
          case 'AUTHORITY_CONFLICT':
            authorityConflictCount++;
            rejectedCount++;
            break;
        }
      } catch (err: any) {
        items.push({
          authorizationId: row.authorization_id,
          transferId: '',
          executionId: null,
          lifecycleVersion: null,
          classification: 'AUTHORITY_CONFLICT',
          disposition: 'REJECTED_INTEGRITY_CONFLICT',
          mutatedTerminalState: false,
          mutatedResources: false,
          evidenceHash: '',
          error: `SCANNER_ITEM_ERROR: ${err.message}`,
        });
        authorityConflictCount++;
        rejectedCount++;
      }
    }

    return {
      scannedCount: items.length,
      reconciledCount,
      unresolvedCount,
      rejectedCount,
      noOpCount,
      preAdapterNotStartedCount,
      adapterInFlightUnresolvedCount,
      adapterTerminatedTimeoutCount,
      adapterFinishedResultMissingCount,
      resultPersistedStateIncompleteCount,
      alreadyReconciledCount,
      legacyUnclassifiableCount,
      authorityConflictCount,
      items,
      scannedAt: nowIso,
    };
  }

  public reconcileAuthorization(authorizationId: string): ExecutionRecoveryScanItemResult {
    return this.repo.runInImmediateTransaction(() => {
      const nowIso = new Date().toISOString();
      const auth = this.repo.getExecutionAuthorization(authorizationId);
      if (!auth) {
        throw new Error(`ExecutionAuthorization "${authorizationId}" not found.`);
      }

      const transfer = this.repo.getHandoffTransferBySuccessorAuthId(auth.id);
      if (!transfer) {
        throw new Error(`HandoffTransfer for successor authorization "${auth.id}" not found.`);
      }

      const assignment = transfer.successor_assignment_id
        ? this.repo.getAgentAssignment(transfer.successor_assignment_id)
        : null;
      const attempt = transfer.successor_attempt_id
        ? this.repo.getTaskAttempt(transfer.successor_attempt_id)
        : null;
      const activeLease = assignment ? this.repo.getActiveLeaseForAssignment(assignment.id) : null;
      const workerSlot = assignment?.selected_worker_slot_id
        ? this.repo.getWorkerSlot(assignment.selected_worker_slot_id)
        : null;

      // 1. Check Authority & Binding Integrity
      let bindingConflictReason: string | null = null;
      if (transfer.task_id !== auth.task_id) {
        bindingConflictReason = `Transfer task_id "${transfer.task_id}" !== auth task_id "${auth.task_id}".`;
      } else if (transfer.successor_attempt_id && auth.attempt_id && transfer.successor_attempt_id !== auth.attempt_id) {
        bindingConflictReason = `Transfer successor_attempt_id "${transfer.successor_attempt_id}" !== auth attempt_id "${auth.attempt_id}".`;
      } else if (transfer.successor_assignment_id && auth.assignment_id && transfer.successor_assignment_id !== auth.assignment_id) {
        bindingConflictReason = `Transfer successor_assignment_id "${transfer.successor_assignment_id}" !== auth assignment_id "${auth.assignment_id}".`;
      } else if (auth.termination_status === 'CONFIRMED_TERMINATED' && (!auth.termination_source || auth.termination_source.trim() === '')) {
        bindingConflictReason = `Termination status is CONFIRMED_TERMINATED but termination_source is empty.`;
      }

      const canonicalEvidence = {
        authorization_id: auth.id,
        transfer_id: transfer.id,
        task_id: auth.task_id,
        project_id: auth.project_id,
        attempt_id: auth.attempt_id,
        assignment_id: auth.assignment_id ?? null,
        execution_id: auth.execution_id ?? null,
        lifecycle_version: auth.lifecycle_version ?? null,
        auth_status: auth.status,
        transfer_status: transfer.status,
        adapter_started_at: auth.adapter_started_at ?? null,
        adapter_finished_at: auth.adapter_finished_at ?? null,
        adapter_outcome: auth.adapter_outcome ?? null,
        termination_status: auth.termination_status ?? null,
        termination_source: auth.termination_source ?? null,
        terminated_at: auth.terminated_at ?? null,
        settled_at: auth.settled_at ?? null,
        settlement_evidence_hash: auth.settlement_evidence_hash ?? null,
        active_lease_id: activeLease?.id ?? null,
        worker_slot_id: workerSlot?.id ?? null,
        worker_slot_status: workerSlot?.status ?? null,
        binding_conflict: bindingConflictReason,
      };
      const canonicalEvidenceJson = canonicalJsonStringify(canonicalEvidence);
      const evidenceHash = computeSha256(canonicalEvidenceJson);

      const existingRecovery = this.repo.getExecutionRecoveryState(auth.id);

      // Handle Integrity Conflict (Classification H)
      if (bindingConflictReason) {
        const classification: ExecutionRecoveryClassification = 'AUTHORITY_CONFLICT';
        const disposition: ExecutionRecoveryDisposition = 'REJECTED_INTEGRITY_CONFLICT';

        this.persistRecoveryAndEmit({
          auth,
          transfer,
          assignment,
          activeLease,
          workerSlot,
          classification,
          disposition,
          canonicalEvidenceJson,
          evidenceHash,
          mutatedTerminalState: false,
          mutatedResources: false,
          resolvedAt: null,
          existingRecovery,
        });

        return {
          authorizationId: auth.id,
          transferId: transfer.id,
          executionId: auth.execution_id ?? null,
          lifecycleVersion: auth.lifecycle_version ?? null,
          classification,
          disposition,
          mutatedTerminalState: false,
          mutatedResources: false,
          evidenceHash,
          error: bindingConflictReason,
        };
      }

      // Check Classification G: ALREADY_RECONCILED
      const isTransferTerminal =
        transfer.status === 'COMPLETED' ||
        transfer.status === 'FAILED' ||
        transfer.status === 'CANCELLED' ||
        transfer.status === 'EXPIRED';
      const isAttemptTerminal = !attempt || attempt.status === 'COMPLETED' || attempt.status === 'FAILED' || attempt.status === 'CANCELLED';
      const isAssignmentTerminal = !assignment || assignment.status === 'COMPLETED' || assignment.status === 'FAILED' || assignment.status === 'CANCELLED';
      const isLeaseCleared = !activeLease;

      if (isTransferTerminal && isAttemptTerminal && isAssignmentTerminal && isLeaseCleared) {
        const classification: ExecutionRecoveryClassification = 'ALREADY_RECONCILED';
        const disposition: ExecutionRecoveryDisposition = 'NO_OP_ALREADY_RECONCILED';

        this.persistRecoveryAndEmit({
          auth,
          transfer,
          assignment,
          activeLease,
          workerSlot,
          classification,
          disposition,
          canonicalEvidenceJson,
          evidenceHash,
          mutatedTerminalState: false,
          mutatedResources: false,
          resolvedAt: existingRecovery?.resolved_at || nowIso,
          existingRecovery,
        });

        return {
          authorizationId: auth.id,
          transferId: transfer.id,
          executionId: auth.execution_id ?? null,
          lifecycleVersion: auth.lifecycle_version ?? null,
          classification,
          disposition,
          mutatedTerminalState: false,
          mutatedResources: false,
          evidenceHash,
        };
      }

      // Check Classification B: LEGACY_UNCLASSIFIABLE (historical rows with lifecycle_version null)
      if (auth.lifecycle_version === null || auth.lifecycle_version === undefined || auth.lifecycle_version === 0) {
        const classification: ExecutionRecoveryClassification = 'LEGACY_UNCLASSIFIABLE';
        const disposition: ExecutionRecoveryDisposition = 'LEGACY_UNRESOLVED_FENCED';

        this.persistRecoveryAndEmit({
          auth,
          transfer,
          assignment,
          activeLease,
          workerSlot,
          classification,
          disposition,
          canonicalEvidenceJson,
          evidenceHash,
          mutatedTerminalState: false,
          mutatedResources: false,
          resolvedAt: null,
          existingRecovery,
        });

        return {
          authorizationId: auth.id,
          transferId: transfer.id,
          executionId: auth.execution_id ?? null,
          lifecycleVersion: null,
          classification,
          disposition,
          mutatedTerminalState: false,
          mutatedResources: false,
          evidenceHash,
        };
      }

      // Check Classification A: PRE_ADAPTER_NOT_STARTED
      // Version-1 execution, adapter start was not claimed
      if (auth.lifecycle_version === 1 && !auth.adapter_started_at) {
        const classification: ExecutionRecoveryClassification = 'PRE_ADAPTER_NOT_STARTED';
        const disposition: ExecutionRecoveryDisposition = 'TERMINALIZED_SAFE_EXPIRED';

        // 1. Invalidate authorization
        this.db
          .prepare(`UPDATE execution_authorizations SET status = 'INVALIDATED' WHERE id = ?`)
          .run(auth.id);

        // 2. Terminalize transfer, attempt, assignment
        if (transfer.status === 'ACCEPTED' || transfer.status === 'AUTHORIZED' || transfer.status === 'ROUTED') {
          const newVersion = transfer.version + 1;
          this.db
            .prepare(`
              UPDATE handoff_transfers
              SET status = 'FAILED', completed_at = ?, version = ?, updated_at = ?
              WHERE id = ?
            `)
            .run(nowIso, newVersion, nowIso, transfer.id);
        }

        if (attempt && attempt.status === 'RUNNING') {
          this.db
            .prepare(`UPDATE task_attempts SET status = 'FAILED', ended_at = ? WHERE id = ?`)
            .run(nowIso, attempt.id);
        }

        if (assignment && assignment.status === 'RUNNING') {
          this.db
            .prepare(`UPDATE agent_assignments SET status = 'FAILED', ended_at = ? WHERE id = ?`)
            .run(nowIso, assignment.id);
        }

        // 3. Release matching lease and slot
        let mutatedResources = false;
        if (activeLease && assignment) {
          this.repo.releaseAccountLeaseAndIdleSlot(activeLease.id, assignment.selected_worker_slot_id, nowIso);
          mutatedResources = true;
        }

        this.persistRecoveryAndEmit({
          auth,
          transfer,
          assignment,
          activeLease,
          workerSlot,
          classification,
          disposition,
          canonicalEvidenceJson,
          evidenceHash,
          mutatedTerminalState: true,
          mutatedResources,
          resolvedAt: nowIso,
          existingRecovery,
        });

        return {
          authorizationId: auth.id,
          transferId: transfer.id,
          executionId: auth.execution_id ?? null,
          lifecycleVersion: auth.lifecycle_version,
          classification,
          disposition,
          mutatedTerminalState: true,
          mutatedResources,
          evidenceHash,
        };
      }

      // Check Classification D: ADAPTER_TERMINATED_AFTER_TIMEOUT
      if (auth.adapter_started_at && !auth.adapter_finished_at && auth.termination_status === 'CONFIRMED_TERMINATED') {
        const classification: ExecutionRecoveryClassification = 'ADAPTER_TERMINATED_AFTER_TIMEOUT';
        const isCancelled = auth.termination_source?.toUpperCase().includes('CANCEL');
        const disposition: ExecutionRecoveryDisposition = isCancelled
          ? 'TERMINALIZED_CONFIRMED_CANCELLED'
          : 'TERMINALIZED_CONFIRMED_TIMEOUT';
        const terminalStatus: HandoffTransferStatus = isCancelled ? 'CANCELLED' : 'FAILED';

        // Terminalize transfer, attempt, assignment
        if (transfer.status === 'ACCEPTED' || transfer.status === 'AUTHORIZED' || transfer.status === 'ROUTED') {
          const newVersion = transfer.version + 1;
          this.db
            .prepare(`
              UPDATE handoff_transfers
              SET status = ?, completed_at = ?, version = ?, updated_at = ?
              WHERE id = ?
            `)
            .run(terminalStatus, nowIso, newVersion, nowIso, transfer.id);
        }

        if (attempt && attempt.status === 'RUNNING') {
          this.db
            .prepare(`UPDATE task_attempts SET status = ?, ended_at = ? WHERE id = ?`)
            .run(terminalStatus, nowIso, attempt.id);
        }

        if (assignment && assignment.status === 'RUNNING') {
          this.db
            .prepare(`UPDATE agent_assignments SET status = ?, ended_at = ? WHERE id = ?`)
            .run(terminalStatus, nowIso, assignment.id);
        }

        // Release matching lease and slot
        let mutatedResources = false;
        if (activeLease && assignment) {
          this.repo.releaseAccountLeaseAndIdleSlot(activeLease.id, assignment.selected_worker_slot_id, nowIso);
          mutatedResources = true;
        }

        this.persistRecoveryAndEmit({
          auth,
          transfer,
          assignment,
          activeLease,
          workerSlot,
          classification,
          disposition,
          canonicalEvidenceJson,
          evidenceHash,
          mutatedTerminalState: true,
          mutatedResources,
          resolvedAt: nowIso,
          existingRecovery,
        });

        return {
          authorizationId: auth.id,
          transferId: transfer.id,
          executionId: auth.execution_id ?? null,
          lifecycleVersion: auth.lifecycle_version ?? null,
          classification,
          disposition,
          mutatedTerminalState: true,
          mutatedResources,
          evidenceHash,
        };
      }

      // Check Classification C: ADAPTER_IN_FLIGHT_UNRESOLVED
      if (auth.adapter_started_at && !auth.adapter_finished_at) {
        const classification: ExecutionRecoveryClassification = 'ADAPTER_IN_FLIGHT_UNRESOLVED';
        const disposition: ExecutionRecoveryDisposition = 'UNRESOLVED_FENCED';

        this.persistRecoveryAndEmit({
          auth,
          transfer,
          assignment,
          activeLease,
          workerSlot,
          classification,
          disposition,
          canonicalEvidenceJson,
          evidenceHash,
          mutatedTerminalState: false,
          mutatedResources: false,
          resolvedAt: null,
          existingRecovery,
        });

        return {
          authorizationId: auth.id,
          transferId: transfer.id,
          executionId: auth.execution_id ?? null,
          lifecycleVersion: auth.lifecycle_version ?? null,
          classification,
          disposition,
          mutatedTerminalState: false,
          mutatedResources: false,
          evidenceHash,
        };
      }

      // Check Classification E: ADAPTER_FINISHED_RESULT_MISSING
      if (auth.adapter_finished_at && !auth.settled_at) {
        const classification: ExecutionRecoveryClassification = 'ADAPTER_FINISHED_RESULT_MISSING';
        const disposition: ExecutionRecoveryDisposition = 'RESULT_MISSING_FENCED';

        this.persistRecoveryAndEmit({
          auth,
          transfer,
          assignment,
          activeLease,
          workerSlot,
          classification,
          disposition,
          canonicalEvidenceJson,
          evidenceHash,
          mutatedTerminalState: false,
          mutatedResources: false,
          resolvedAt: null,
          existingRecovery,
        });

        return {
          authorizationId: auth.id,
          transferId: transfer.id,
          executionId: auth.execution_id ?? null,
          lifecycleVersion: auth.lifecycle_version ?? null,
          classification,
          disposition,
          mutatedTerminalState: false,
          mutatedResources: false,
          evidenceHash,
        };
      }

      // Check Classification F: RESULT_PERSISTED_STATE_INCOMPLETE
      if (auth.settled_at && auth.settlement_evidence_hash) {
        const classification: ExecutionRecoveryClassification = 'RESULT_PERSISTED_STATE_INCOMPLETE';
        const disposition: ExecutionRecoveryDisposition = 'TERMINAL_STATE_RECONCILED';

        const terminalStatus: HandoffTransferStatus =
          auth.adapter_outcome === 'RETURNED'
            ? 'COMPLETED'
            : auth.adapter_outcome === 'CANCELLED'
            ? 'CANCELLED'
            : 'FAILED';

        let mutatedTerminalState = false;
        if (transfer.status !== terminalStatus) {
          const newVersion = transfer.version + 1;
          this.db
            .prepare(`
              UPDATE handoff_transfers
              SET status = ?, completed_at = ?, version = ?, updated_at = ?
              WHERE id = ?
            `)
            .run(terminalStatus, nowIso, newVersion, nowIso, transfer.id);
          mutatedTerminalState = true;
        }

        if (attempt && attempt.status !== terminalStatus) {
          this.db
            .prepare(`UPDATE task_attempts SET status = ?, ended_at = ? WHERE id = ?`)
            .run(terminalStatus, nowIso, attempt.id);
          mutatedTerminalState = true;
        }

        if (assignment && assignment.status !== terminalStatus) {
          this.db
            .prepare(`UPDATE agent_assignments SET status = ?, ended_at = ? WHERE id = ?`)
            .run(terminalStatus, nowIso, assignment.id);
          mutatedTerminalState = true;
        }

        let mutatedResources = false;
        if (activeLease && assignment) {
          this.repo.releaseAccountLeaseAndIdleSlot(activeLease.id, assignment.selected_worker_slot_id, nowIso);
          mutatedResources = true;
        }

        this.persistRecoveryAndEmit({
          auth,
          transfer,
          assignment,
          activeLease,
          workerSlot,
          classification,
          disposition,
          canonicalEvidenceJson,
          evidenceHash,
          mutatedTerminalState,
          mutatedResources,
          resolvedAt: nowIso,
          existingRecovery,
        });

        return {
          authorizationId: auth.id,
          transferId: transfer.id,
          executionId: auth.execution_id ?? null,
          lifecycleVersion: auth.lifecycle_version ?? null,
          classification,
          disposition,
          mutatedTerminalState,
          mutatedResources,
          evidenceHash,
        };
      }

      // Default fallback if unhandled
      const classification: ExecutionRecoveryClassification = 'LEGACY_UNCLASSIFIABLE';
      const disposition: ExecutionRecoveryDisposition = 'LEGACY_UNRESOLVED_FENCED';

      this.persistRecoveryAndEmit({
        auth,
        transfer,
        assignment,
        activeLease,
        workerSlot,
        classification,
        disposition,
        canonicalEvidenceJson,
        evidenceHash,
        mutatedTerminalState: false,
        mutatedResources: false,
        resolvedAt: null,
        existingRecovery,
      });

      return {
        authorizationId: auth.id,
        transferId: transfer.id,
        executionId: auth.execution_id ?? null,
        lifecycleVersion: auth.lifecycle_version ?? null,
        classification,
        disposition,
        mutatedTerminalState: false,
        mutatedResources: false,
        evidenceHash,
      };
    });
  }

  private persistRecoveryAndEmit(params: {
    auth: ExecutionAuthorization;
    transfer: HandoffTransfer;
    assignment: any | null;
    activeLease: any | null;
    workerSlot: any | null;
    classification: ExecutionRecoveryClassification;
    disposition: ExecutionRecoveryDisposition;
    canonicalEvidenceJson: string;
    evidenceHash: string;
    mutatedTerminalState: boolean;
    mutatedResources: boolean;
    resolvedAt: string | null;
    existingRecovery: ExecutionRecoveryState | null;
  }): void {
    const recoveryState = this.repo.upsertExecutionRecoveryState({
      authorization_id: params.auth.id,
      transfer_id: params.transfer.id,
      execution_id: params.auth.execution_id ?? null,
      lifecycle_version: params.auth.lifecycle_version ?? null,
      recovery_classification: params.classification,
      disposition: params.disposition,
      canonical_evidence_json: params.canonicalEvidenceJson,
      evidence_hash: params.evidenceHash,
      mutated_terminal_state: params.mutatedTerminalState,
      mutated_resources: params.mutatedResources,
      resolved_at: params.resolvedAt,
    });

    // Check if event should be emitted (deduplicate if identical evidence hash and disposition or already reconciled)
    if (params.classification === 'ALREADY_RECONCILED' && params.existingRecovery) {
      return;
    }

    const isUnchangedReplay =
      params.existingRecovery &&
      params.existingRecovery.evidence_hash === params.evidenceHash &&
      params.existingRecovery.disposition === params.disposition &&
      !params.mutatedTerminalState &&
      !params.mutatedResources;

    if (isUnchangedReplay) {
      return;
    }

    if (this.eventService) {
      let eventType: string;
      if (params.disposition === 'REJECTED_INTEGRITY_CONFLICT') {
        eventType = 'EXECUTION_RECOVERY_REJECTED';
      } else if (
        params.disposition === 'TERMINALIZED_SAFE_EXPIRED' ||
        params.disposition === 'TERMINALIZED_CONFIRMED_TIMEOUT' ||
        params.disposition === 'TERMINALIZED_CONFIRMED_CANCELLED' ||
        params.disposition === 'TERMINAL_STATE_RECONCILED'
      ) {
        eventType = 'EXECUTION_RECOVERY_RECONCILED';
      } else if (params.disposition === 'NO_OP_ALREADY_RECONCILED') {
        eventType = 'EXECUTION_RECOVERY_NOOP';
      } else {
        eventType = 'EXECUTION_RECOVERY_UNRESOLVED';
      }

      const eventPayload = {
        lifecycle_version: params.auth.lifecycle_version ?? null,
        recovery_version: recoveryState.recovery_version,
        project_id: params.auth.project_id,
        task_id: params.auth.task_id,
        attempt_id: params.auth.attempt_id,
        assignment_id: params.assignment?.id ?? null,
        transfer_id: params.transfer.id,
        authorization_id: params.auth.id,
        execution_id: params.auth.execution_id ?? null,
        provider_id: params.auth.selected_provider_id,
        account_id: params.assignment?.selected_account_id ?? null,
        resource_id: params.auth.selected_resource_id,
        worker_slot_id: params.assignment?.selected_worker_slot_id ?? null,
        lease_id: params.activeLease?.id ?? null,
        adapter_started_at: params.auth.adapter_started_at ?? null,
        adapter_finished_at: params.auth.adapter_finished_at ?? null,
        adapter_outcome: params.auth.adapter_outcome ?? null,
        cancellation_requested_at: params.auth.cancellation_requested_at ?? null,
        termination_status: params.auth.termination_status ?? null,
        termination_source: params.auth.termination_source ?? null,
        terminated_at: params.auth.terminated_at ?? null,
        recovery_classification: params.classification,
        disposition: params.disposition,
        canonical_evidence_hash: params.evidenceHash,
        mutated_terminal_state: params.mutatedTerminalState,
        mutated_resources: params.mutatedResources,
      };

      this.eventService.record(
        params.auth.project_id,
        eventType,
        `Execution recovery ${eventType}: authorization ${params.auth.id}, classification ${params.classification}, disposition ${params.disposition}`,
        eventPayload,
        params.auth.task_id
      );
    }
  }
}
