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
  SettlementStatus,
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
            if (itemResult.mutatedTerminalState || itemResult.disposition === 'TERMINALIZED_SAFE_EXPIRED') {
              reconciledCount++;
            } else {
              unresolvedCount++;
            }
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
        // Record fail-closed conflict disposition in separate transaction
        const failureEvidenceJson = canonicalJsonStringify({
          authorization_id: row.authorization_id,
          scanner_exception: err.message,
        });
        const failureEvidenceHash = computeSha256(failureEvidenceJson);
        const existingRecovery = this.repo.getExecutionRecoveryState(row.authorization_id);

        try {
          this.repo.runInImmediateTransaction(() => {
            const transfer = this.repo.getHandoffTransferBySuccessorAuthId(row.authorization_id);
            this.repo.upsertExecutionRecoveryState({
              authorization_id: row.authorization_id,
              transfer_id: transfer?.id ?? '',
              execution_id: null,
              lifecycle_version: null,
              recovery_classification: 'AUTHORITY_CONFLICT',
              disposition: 'REJECTED_INTEGRITY_CONFLICT',
              canonical_evidence_json: failureEvidenceJson,
              evidence_hash: failureEvidenceHash,
              mutated_terminal_state: false,
              mutated_resources: false,
              resolved_at: null,
            });
          });
        } catch {
          // Ignore secondary logging failure
        }

        items.push({
          authorizationId: row.authorization_id,
          transferId: '',
          executionId: null,
          lifecycleVersion: null,
          classification: 'AUTHORITY_CONFLICT',
          disposition: 'REJECTED_INTEGRITY_CONFLICT',
          mutatedTerminalState: false,
          mutatedResources: false,
          evidenceHash: failureEvidenceHash,
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

      const project = this.repo.getProject(auth.project_id);
      const task = this.repo.getTask(auth.task_id);
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

      // 1. Check Authority & Complete Binding Graph Integrity
      let bindingConflictReason: string | null = null;
      if (!project) {
        bindingConflictReason = `Project "${auth.project_id}" not found.`;
      } else if (!task) {
        bindingConflictReason = `Task "${auth.task_id}" not found.`;
      } else if (task.project_id !== auth.project_id) {
        bindingConflictReason = `Task project_id "${task.project_id}" !== auth project_id "${auth.project_id}".`;
      } else if (transfer.task_id !== auth.task_id) {
        bindingConflictReason = `Transfer task_id "${transfer.task_id}" !== auth task_id "${auth.task_id}".`;
      } else if (transfer.successor_attempt_id && auth.attempt_id && transfer.successor_attempt_id !== auth.attempt_id) {
        bindingConflictReason = `Transfer successor_attempt_id "${transfer.successor_attempt_id}" !== auth attempt_id "${auth.attempt_id}".`;
      } else if (transfer.successor_assignment_id && auth.assignment_id && transfer.successor_assignment_id !== auth.assignment_id) {
        bindingConflictReason = `Transfer successor_assignment_id "${transfer.successor_assignment_id}" !== auth assignment_id "${auth.assignment_id}".`;
      } else if (attempt && attempt.task_id !== auth.task_id) {
        bindingConflictReason = `Attempt task_id "${attempt.task_id}" !== auth task_id "${auth.task_id}".`;
      } else if (assignment) {
        if (assignment.task_id !== auth.task_id) {
          bindingConflictReason = `Assignment task_id "${assignment.task_id}" !== auth task_id "${auth.task_id}".`;
        } else if (assignment.project_id !== auth.project_id) {
          bindingConflictReason = `Assignment project_id "${assignment.project_id}" !== auth project_id "${auth.project_id}".`;
        } else if (assignment.selected_provider_id !== auth.selected_provider_id) {
          bindingConflictReason = `Assignment selected_provider_id "${assignment.selected_provider_id}" !== auth selected_provider_id "${auth.selected_provider_id}".`;
        } else if (assignment.selected_resource_id !== auth.selected_resource_id) {
          bindingConflictReason = `Assignment selected_resource_id "${assignment.selected_resource_id}" !== auth selected_resource_id "${auth.selected_resource_id}".`;
        } else if (auth.selected_account_id && assignment.selected_account_id !== auth.selected_account_id) {
          bindingConflictReason = `Assignment selected_account_id "${assignment.selected_account_id}" !== auth selected_account_id "${auth.selected_account_id}".`;
        }
      }

      // 1b. Check Ownership Epoch Integrity
      const currentTaskEpoch = this.repo.getTaskOwnershipEpoch(auth.task_id);
      if (!bindingConflictReason) {
        if (transfer.successor_ownership_epoch !== undefined && transfer.successor_ownership_epoch !== null && transfer.successor_ownership_epoch !== currentTaskEpoch) {
          bindingConflictReason = `Transfer successor_ownership_epoch "${transfer.successor_ownership_epoch}" !== task epoch "${currentTaskEpoch}".`;
        } else if (auth.task_ownership_epoch !== undefined && auth.task_ownership_epoch !== null && auth.task_ownership_epoch !== currentTaskEpoch) {
          bindingConflictReason = `Auth task_ownership_epoch "${auth.task_ownership_epoch}" !== task epoch "${currentTaskEpoch}".`;
        }
      }

      // 1c. Recompute and verify Settlement Evidence Integrity if settled
      let parsedSettlementEvidence: any = null;
      if (!bindingConflictReason && (auth.settled_at || auth.settlement_evidence_json || auth.settlement_evidence_hash || auth.settlement_status)) {
        if (!auth.settled_at || !auth.settlement_evidence_json || !auth.settlement_evidence_hash) {
          bindingConflictReason = `Incomplete settlement evidence metadata for settled auth "${auth.id}".`;
        } else {
          try {
            parsedSettlementEvidence = JSON.parse(auth.settlement_evidence_json);
            const recomputedHash = computeSha256(canonicalJsonStringify(parsedSettlementEvidence));
            if (recomputedHash !== auth.settlement_evidence_hash) {
              bindingConflictReason = `Settlement evidence hash mismatch: stored "${auth.settlement_evidence_hash}" !== recomputed "${recomputedHash}".`;
            } else if (parsedSettlementEvidence.authorization_id !== auth.id) {
              bindingConflictReason = `Settlement evidence authorization_id "${parsedSettlementEvidence.authorization_id}" !== auth id "${auth.id}".`;
            } else if (parsedSettlementEvidence.execution_id && auth.execution_id && parsedSettlementEvidence.execution_id !== auth.execution_id) {
              bindingConflictReason = `Settlement evidence execution_id "${parsedSettlementEvidence.execution_id}" !== auth execution_id "${auth.execution_id}".`;
            } else {
              const evidenceStatus = parsedSettlementEvidence.settlement_status || parsedSettlementEvidence.status;
              if (!evidenceStatus && !auth.settlement_status) {
                bindingConflictReason = `Missing settlement status in both auth and evidence.`;
              } else if (auth.settlement_status && evidenceStatus && evidenceStatus !== auth.settlement_status) {
                bindingConflictReason = `Settlement status mismatch: auth "${auth.settlement_status}" !== evidence "${evidenceStatus}".`;
              }
            }
          } catch (e: any) {
            bindingConflictReason = `Malformed settlement evidence JSON: ${e.message}`;
          }
        }
      }

      // 1d. Validate structured termination proof if confirmed with evidence
      if (!bindingConflictReason && auth.termination_status === 'CONFIRMED_TERMINATED') {
        if (auth.termination_evidence_json) {
          try {
            const parsedTerm = JSON.parse(auth.termination_evidence_json);
            const computedTermHash = computeSha256(canonicalJsonStringify(parsedTerm));
            if (auth.termination_evidence_hash && computedTermHash !== auth.termination_evidence_hash) {
              bindingConflictReason = `Termination evidence hash mismatch: stored "${auth.termination_evidence_hash}" !== computed "${computedTermHash}".`;
            }
          } catch (e: any) {
            bindingConflictReason = `Malformed termination evidence JSON: ${e.message}`;
          }
        }
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
        settlement_status: auth.settlement_status ?? null,
        termination_status: auth.termination_status ?? null,
        termination_source: auth.termination_source ?? null,
        termination_reason: auth.termination_reason ?? null,
        termination_proof_source: auth.termination_proof_source ?? null,
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
      // Requires exact agreement among settlement status, transfer, attempt, assignment, and cleared leases
      if (auth.settled_at) {
        const expectedStatus = auth.settlement_status || parsedSettlementEvidence?.settlement_status || parsedSettlementEvidence?.status;
        if (expectedStatus) {
          const transferAgrees = transfer.status === expectedStatus;
          const attemptAgrees = !attempt || attempt.status === expectedStatus;
          const asgnAgrees = !assignment || assignment.status === expectedStatus;
          const leaseCleared = !activeLease;
          const slotClean = !workerSlot || workerSlot.status === 'IDLE';

          if (transferAgrees && attemptAgrees && asgnAgrees && leaseCleared && slotClean) {
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
        }
      } else if (auth.status === 'INVALIDATED') {
        const transferAgrees = transfer.status === 'FAILED' || transfer.status === 'EXPIRED';
        const attemptAgrees = !attempt || attempt.status === 'FAILED';
        const asgnAgrees = !assignment || assignment.status === 'FAILED';
        const leaseCleared = !activeLease;

        if (transferAgrees && attemptAgrees && asgnAgrees && leaseCleared) {
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
        const isLeaseActiveAndUnexpired = activeLease && new Date(activeLease.expires_at).getTime() > new Date(nowIso).getTime();

        // Fresh AUTHORIZED records and unexpired active leases must not be terminalized
        if (auth.status !== 'DISPATCHED' || isLeaseActiveAndUnexpired) {
          const classification: ExecutionRecoveryClassification = 'PRE_ADAPTER_NOT_STARTED';
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
            lifecycleVersion: auth.lifecycle_version,
            classification,
            disposition,
            mutatedTerminalState: false,
            mutatedResources: false,
            evidenceHash,
          };
        }

        // Safe expired / dispatched pre-adapter execution: terminalize atomically
        const classification: ExecutionRecoveryClassification = 'PRE_ADAPTER_NOT_STARTED';
        const disposition: ExecutionRecoveryDisposition = 'TERMINALIZED_SAFE_EXPIRED';

        // 1. Invalidate authorization
        const authRes = this.db
          .prepare(`UPDATE execution_authorizations SET status = 'INVALIDATED' WHERE id = ? AND status = 'DISPATCHED'`)
          .run(auth.id);
        if (authRes.changes !== 1) {
          throw new Error(`PRE_ADAPTER_AUTH_INVALIDATION_FAILED: Expected 1 row changed, got ${authRes.changes}`);
        }

        // 2. Terminalize transfer, attempt, assignment
        if (transfer.status === 'ACCEPTED' || transfer.status === 'AUTHORIZED' || transfer.status === 'ROUTED') {
          const newVersion = transfer.version + 1;
          const trRes = this.db
            .prepare(`
              UPDATE handoff_transfers
              SET status = 'FAILED', completed_at = ?, version = ?, updated_at = ?
              WHERE id = ? AND status = ? AND version = ?
            `)
            .run(nowIso, newVersion, nowIso, transfer.id, transfer.status, transfer.version);
          if (trRes.changes !== 1) {
            throw new Error(`PRE_ADAPTER_TRANSFER_UPDATE_FAILED: Expected 1 row changed, got ${trRes.changes}`);
          }
        }

        if (attempt && attempt.status !== 'FAILED') {
          const attRes = this.db
            .prepare(`UPDATE task_attempts SET status = 'FAILED', ended_at = ? WHERE id = ? AND status IN ('PENDING', 'RUNNING')`)
            .run(nowIso, attempt.id);
          if (attRes.changes !== 1) {
            throw new Error(`PRE_ADAPTER_ATTEMPT_UPDATE_FAILED: Expected 1 row changed, got ${attRes.changes}`);
          }
        }

        if (assignment && assignment.status !== 'FAILED') {
          const asgnRes = this.db
            .prepare(`UPDATE agent_assignments SET status = 'FAILED', ended_at = ? WHERE id = ? AND status IN ('ASSIGNED', 'RUNNING')`)
            .run(nowIso, assignment.id);
          if (asgnRes.changes !== 1) {
            throw new Error(`PRE_ADAPTER_ASSIGNMENT_UPDATE_FAILED: Expected 1 row changed, got ${asgnRes.changes}`);
          }
        }

        // 3. Release matching lease and slot via guarded check
        let mutatedResources = false;
        if (activeLease && assignment) {
          const slotId = assignment.selected_worker_slot_id || activeLease.worker_slot_id;
          const accountId = assignment.selected_account_id || activeLease.provider_account_id;
          const releaseRes = this.repo.releaseGuardedAccountLeaseAndIdleSlot({
            leaseId: activeLease.id,
            expectedAssignmentId: assignment.id,
            expectedAccountId: accountId,
            expectedSlotId: slotId,
            expectedExecutionId: auth.execution_id,
            releasedAt: nowIso,
          });
          if (!releaseRes.success) {
            throw new Error(`PRE_ADAPTER_GUARDED_RELEASE_FAILED: ${releaseRes.error}`);
          }
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
      // Only proven local process exit (LOCAL_PROCESS_EXIT) or provider-final acknowledgement (PROVIDER_FINAL_ACK) may terminalize
      if (auth.adapter_started_at && !auth.adapter_finished_at && auth.termination_status === 'CONFIRMED_TERMINATED') {
        const isProvenTermination =
          (auth.termination_proof_source === 'LOCAL_PROCESS_EXIT' || auth.termination_proof_source === 'PROVIDER_FINAL_ACK') &&
          auth.termination_confirmed_at !== null &&
          auth.terminated_at !== null;

        if (isProvenTermination) {
          const isExplicitCancel =
            auth.termination_reason === 'EXECUTION_CANCELLED' ||
            auth.termination_source === 'USER_CANCELLED' ||
            auth.termination_source === 'OWNER_CANCELLED' ||
            auth.termination_source === 'DISPATCH_CANCELLED' ||
            auth.termination_source === 'OPERATOR_CANCELLED' ||
            auth.termination_source === 'CANCELLED_CONFIRMED';

          const classification: ExecutionRecoveryClassification = 'ADAPTER_TERMINATED_AFTER_TIMEOUT';
          const disposition: ExecutionRecoveryDisposition = isExplicitCancel
            ? 'TERMINALIZED_CONFIRMED_CANCELLED'
            : 'TERMINALIZED_CONFIRMED_TIMEOUT';
          const terminalStatus: HandoffTransferStatus = isExplicitCancel ? 'CANCELLED' : 'FAILED';

          // Terminalize transfer, attempt, assignment
          if (transfer.status === 'ACCEPTED' || transfer.status === 'AUTHORIZED' || transfer.status === 'ROUTED') {
            const newVersion = transfer.version + 1;
            const trRes = this.db
              .prepare(`
                UPDATE handoff_transfers
                SET status = ?, completed_at = ?, version = ?, updated_at = ?
                WHERE id = ? AND status = ? AND version = ?
              `)
              .run(terminalStatus, nowIso, newVersion, nowIso, transfer.id, transfer.status, transfer.version);
            if (trRes.changes !== 1) {
              throw new Error(`TIMEOUT_TRANSFER_UPDATE_FAILED: Expected 1 row changed, got ${trRes.changes}`);
            }
          }

          if (attempt && attempt.status !== terminalStatus) {
            const attRes = this.db
              .prepare(`UPDATE task_attempts SET status = ?, ended_at = ? WHERE id = ? AND status IN ('PENDING', 'RUNNING')`)
              .run(terminalStatus, nowIso, attempt.id);
            if (attRes.changes !== 1) {
              throw new Error(`TIMEOUT_ATTEMPT_UPDATE_FAILED: Expected 1 row changed, got ${attRes.changes}`);
            }
          }

          if (assignment && assignment.status !== terminalStatus) {
            const asgnRes = this.db
              .prepare(`UPDATE agent_assignments SET status = ?, ended_at = ? WHERE id = ? AND status IN ('ASSIGNED', 'RUNNING')`)
              .run(terminalStatus, nowIso, assignment.id);
            if (asgnRes.changes !== 1) {
              throw new Error(`TIMEOUT_ASSIGNMENT_UPDATE_FAILED: Expected 1 row changed, got ${asgnRes.changes}`);
            }
          }

          // Release matching lease and slot via guarded check
          let mutatedResources = false;
          if (activeLease && assignment) {
            const slotId = assignment.selected_worker_slot_id || activeLease.worker_slot_id;
            const accountId = assignment.selected_account_id || activeLease.provider_account_id;
            const releaseRes = this.repo.releaseGuardedAccountLeaseAndIdleSlot({
              leaseId: activeLease.id,
              expectedAssignmentId: assignment.id,
              expectedAccountId: accountId,
              expectedSlotId: slotId,
              expectedExecutionId: auth.execution_id,
              releasedAt: nowIso,
            });
            if (!releaseRes.success) {
              throw new Error(`TIMEOUT_GUARDED_RELEASE_FAILED: ${releaseRes.error}`);
            }
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
      }

      // Check Classification C: ADAPTER_IN_FLIGHT_UNRESOLVED
      // In-flight execution, unconfirmed termination, remote timeout, unacknowledged cancel or unknown process state
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
        const parsedEvidence = JSON.parse(auth.settlement_evidence_json || '{}');
        const terminalStatus: SettlementStatus =
          auth.settlement_status || parsedEvidence.settlement_status || parsedEvidence.status || 'FAILED';

        // Check for conflicting terminal states (must never overwrite a terminal conflict)
        const isTransferConflict =
          (transfer.status === 'COMPLETED' || transfer.status === 'FAILED' || transfer.status === 'CANCELLED' || transfer.status === 'EXPIRED') &&
          transfer.status !== terminalStatus;
        const isAttemptConflict =
          attempt &&
          (attempt.status === 'COMPLETED' || attempt.status === 'FAILED' || attempt.status === 'CANCELLED') &&
          attempt.status !== terminalStatus;
        const isAsgnConflict =
          assignment &&
          (assignment.status === 'COMPLETED' || assignment.status === 'FAILED' || assignment.status === 'CANCELLED') &&
          assignment.status !== terminalStatus;

        if (isTransferConflict || isAttemptConflict || isAsgnConflict) {
          const classification: ExecutionRecoveryClassification = 'AUTHORITY_CONFLICT';
          const disposition: ExecutionRecoveryDisposition = 'REJECTED_INTEGRITY_CONFLICT';
          const conflictError = `TERMINAL_STATE_CONFLICT: Entity has conflicting terminal state against settlement_status "${terminalStatus}"`;

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
            error: conflictError,
          };
        }

        const classification: ExecutionRecoveryClassification = 'RESULT_PERSISTED_STATE_INCOMPLETE';
        const disposition: ExecutionRecoveryDisposition = 'TERMINAL_STATE_RECONCILED';

        let mutatedTerminalState = false;
        if (transfer.status !== terminalStatus) {
          const newVersion = transfer.version + 1;
          const trRes = this.db
            .prepare(`
              UPDATE handoff_transfers
              SET status = ?, completed_at = ?, version = ?, updated_at = ?
              WHERE id = ? AND status = ? AND version = ?
            `)
            .run(terminalStatus, nowIso, newVersion, nowIso, transfer.id, transfer.status, transfer.version);
          if (trRes.changes !== 1) {
            throw new Error(`RESULT_RECOVERY_TRANSFER_UPDATE_FAILED: Expected 1 row changed, got ${trRes.changes}`);
          }
          mutatedTerminalState = true;
        }

        if (attempt && attempt.status !== terminalStatus) {
          const attRes = this.db
            .prepare(`UPDATE task_attempts SET status = ?, ended_at = ? WHERE id = ? AND status IN ('PENDING', 'RUNNING')`)
            .run(terminalStatus, nowIso, attempt.id);
          if (attRes.changes !== 1) {
            throw new Error(`RESULT_RECOVERY_ATTEMPT_UPDATE_FAILED: Expected 1 row changed, got ${attRes.changes}`);
          }
          mutatedTerminalState = true;
        }

        if (assignment && assignment.status !== terminalStatus) {
          const asgnRes = this.db
            .prepare(`UPDATE agent_assignments SET status = ?, ended_at = ? WHERE id = ? AND status IN ('ASSIGNED', 'RUNNING')`)
            .run(terminalStatus, nowIso, assignment.id);
          if (asgnRes.changes !== 1) {
            throw new Error(`RESULT_RECOVERY_ASSIGNMENT_UPDATE_FAILED: Expected 1 row changed, got ${asgnRes.changes}`);
          }
          mutatedTerminalState = true;
        }

        let mutatedResources = false;
        if (activeLease && assignment) {
          const slotId = assignment.selected_worker_slot_id || activeLease.worker_slot_id;
          const accountId = assignment.selected_account_id || activeLease.provider_account_id;
          const releaseRes = this.repo.releaseGuardedAccountLeaseAndIdleSlot({
            leaseId: activeLease.id,
            expectedAssignmentId: assignment.id,
            expectedAccountId: accountId,
            expectedSlotId: slotId,
            expectedExecutionId: auth.execution_id,
            releasedAt: nowIso,
          });
          if (!releaseRes.success) {
            throw new Error(`RESULT_RECOVERY_GUARDED_RELEASE_FAILED: ${releaseRes.error}`);
          }
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
      settlement_status: params.auth.settlement_status ?? null,
      cancellation_requested_at: params.auth.cancellation_requested_at ?? null,
      termination_status: params.auth.termination_status ?? null,
      termination_source: params.auth.termination_source ?? null,
      termination_reason: params.auth.termination_reason ?? null,
      termination_proof_source: params.auth.termination_proof_source ?? null,
      terminated_at: params.auth.terminated_at ?? null,
      recovery_classification: params.classification,
      disposition: params.disposition,
      canonical_evidence_hash: params.evidenceHash,
      mutated_terminal_state: params.mutatedTerminalState,
      mutated_resources: params.mutatedResources,
    };

    const deterministicEventId =
      'evt-rec-' +
      computeSha256(
        `${params.auth.id}:${recoveryState.recovery_version}:${params.classification}:${params.disposition}:${params.evidenceHash}`
      ).slice(0, 32);

    this.repo.insertDeterministicEvent({
      id: deterministicEventId,
      project_id: params.auth.project_id,
      task_id: params.auth.task_id,
      agent_id: params.assignment?.agent_id ?? null,
      type: eventType,
      summary: `Execution recovery ${eventType}: authorization ${params.auth.id}, classification ${params.classification}, disposition ${params.disposition}`,
      structured_payload_json: canonicalJsonStringify(eventPayload),
      timestamp: params.auth.terminated_at || params.auth.settled_at || new Date().toISOString(),
    });
  }
}
