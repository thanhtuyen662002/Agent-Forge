import { Repository } from '../database/repositories';
import { canonicalJsonStringify, computeSha256 } from '../context/ContextIntegrity';
import type { AgentExecutionResult } from '../adapters/ProviderAdapter';
import type { AdapterOutcome, ExecutionAuthorization, ExecutionRecoveryClassification,
  ExecutionRecoveryDisposition, ExecutionRecoveryScanItemResult, Task } from '../types/domain';
import { VerificationCapabilityService } from './VerificationCapabilityService';
import { ProjectStopFenceService } from './ProjectStopFenceService';
import { OutputSanitizationError, sanitizeOutputValue } from '../../shared/security/secretRedaction';

const PROTOCOL = 'nonhandoffexecution.v1';
export const NON_HANDOFF_CLAIM_EVENT = 'NON_HANDOFF_EXECUTION_CLAIMED';
const RESULT_EVENT = 'NON_HANDOFF_EXECUTION_RESULT';
const RECOVERY_EVENT = 'NON_HANDOFF_EXECUTION_RECOVERY';

export interface NonHandoffClaim {
  authorizationId: string;
  bindingHash: string;
  taskHash: string;
  epoch: number;
  executionId: string;
  timeoutMs: number;
}

function bindingHash(auth: ExecutionAuthorization): string {
  return computeSha256(canonicalJsonStringify({ id: auth.id, project: auth.project_id, task: auth.task_id,
    attempt: auth.attempt_id, revision: auth.task_revision, epoch: auth.task_ownership_epoch ?? null,
    base: auth.base_sha, head: auth.repository_head_sha, manager: auth.manager_message_id,
    managerHash: auth.manager_payload_hash, route: auth.routing_decision_id, provider: auth.selected_provider_id,
    resource: auth.selected_resource_id, account: auth.selected_account_id ?? null,
    assignment: auth.assignment_id ?? null, lifecycle: auth.lifecycle_version ?? null,
    payloadHash: auth.instruction_payload_hash, contextHash: auth.context_manifest_hash,
    canonicalPayloadHash: computeSha256(auth.canonical_payload_json ?? ''),
    instructionsHash: computeSha256(auth.canonical_instructions_json), contextFilesHash: computeSha256(auth.context_files_json) }));
}

function taskHash(task: Task): string {
  return computeSha256(canonicalJsonStringify({ id: task.id, project: task.project_id, revision: task.revision_count,
    state: task.state, base: task.base_sha, title: task.title, description: task.description,
    criteria: task.acceptance_criteria, constraints: task.constraints }));
}

/** Immutable receipts supplement the authorization; they never own task state or leases. */
export class NonHandoffExecutionLifecycle {
  private readonly stopFence: ProjectStopFenceService;
  constructor(private readonly repo: Repository) { this.stopFence = new ProjectStopFenceService(repo); }

  capture(auth: ExecutionAuthorization, executionId: string, timeoutMs: number): NonHandoffClaim {
    const task = this.repo.getTask(auth.task_id);
    if (!task) throw new Error('NON_HANDOFF_TASK_MISSING');
    return Object.freeze({ authorizationId: auth.id, bindingHash: bindingHash(auth), taskHash: taskHash(task),
      epoch: this.repo.getTaskOwnershipEpoch(task.id), executionId, timeoutMs });
  }

  claim(auth: ExecutionAuthorization, captured: NonHandoffClaim, dispatchedAt: string): boolean {
    return this.repo.runInImmediateTransaction(() => {
      if (!this.isCurrent(auth.id, captured) || this.repo.getHandoffTransferBySuccessorAuthId(auth.id)) return false;
      if (!this.repo.claimExecutionAuthorization(auth.id, dispatchedAt)) return false;
      const changed = this.repo.getDatabase().prepare(`UPDATE execution_authorizations SET execution_id = ?
        WHERE id = ? AND status = 'DISPATCHED' AND lifecycle_version IS NULL
          AND execution_id IS NULL AND adapter_started_at IS NULL AND task_ownership_epoch = ?`)
        .run(captured.executionId, auth.id, captured.epoch);
      if (changed.changes !== 1) throw new Error('NON_HANDOFF_CLAIM_IDENTITY_CONFLICT');
      this.write(NON_HANDOFF_CLAIM_EVENT, auth, captured as unknown as Record<string, unknown>, 'claim');
      return true;
    });
  }

  start(auth: ExecutionAuthorization, captured: NonHandoffClaim): boolean {
    return this.repo.runInImmediateTransaction(() => {
      if (!this.isCurrent(auth.id, captured) || !this.matchesClaim(auth.id, captured) || !this.hasCapabilities(auth)) return false;
      const current = this.repo.getExecutionAuthorization(auth.id)!;
      if (current.status !== 'DISPATCHED' || current.execution_id !== captured.executionId || current.adapter_started_at) return false;
      const changed = this.repo.getDatabase().prepare(`UPDATE execution_authorizations SET adapter_started_at = ?
        WHERE id = ? AND status = 'DISPATCHED' AND lifecycle_version IS NULL
          AND execution_id = ? AND adapter_started_at IS NULL AND task_ownership_epoch = ?`)
        .run(new Date().toISOString(), auth.id, captured.executionId, captured.epoch);
      return changed.changes === 1;
    });
  }

  finish(auth: ExecutionAuthorization, captured: NonHandoffClaim, result: AgentExecutionResult,
    outcome: AdapterOutcome): boolean {
    const safe = sanitizeOutputValue(result) as AgentExecutionResult;
    if (!safe || typeof safe !== 'object' || !['COMPLETED', 'FAILED', 'CANCELLED', 'AWAITING_OWNER'].includes(safe.status) ||
      ['outputProtocol', 'rawResponse', 'error'].some(key => {
        const value = (safe as unknown as Record<string, unknown>)[key];
        return value !== undefined && typeof value !== 'string';
      }) || ['errorCode', 'stdoutEvidenceId', 'stderrEvidenceId'].some(key => {
        const value = (safe as unknown as Record<string, unknown>)[key];
        return value != null && typeof value !== 'string';
      })) throw new OutputSanitizationError('OUTPUT_TYPE_INVALID');
    result = safe;
    return this.repo.runInImmediateTransaction(() => {
      if (!this.matchesClaim(auth.id, captured)) return false;
      const current = this.repo.getExecutionAuthorization(auth.id);
      if (!current || current.execution_id !== captured.executionId || !current.adapter_started_at) return false;
      const observed = { executionId: captured.executionId, bindingHash: captured.bindingHash, status: result.status, outcome,
        errorCode: result.errorCode ?? null, stdoutEvidenceId: result.stdoutEvidenceId ?? null,
        stderrEvidenceId: result.stderrEvidenceId ?? null,
        outputHash: result.outputProtocol === undefined ? null : computeSha256(result.outputProtocol),
        responseHash: result.rawResponse === undefined ? null : computeSha256(result.rawResponse) };
      // Keep the actual observation even when a newer owner has fenced settlement.
      this.write(RESULT_EVENT, auth, observed, 'result');
      if (!this.isCurrent(auth.id, captured) || !this.hasCapabilities(auth) || current.status !== 'DISPATCHED' || current.adapter_finished_at ||
        current.termination_status === 'UNRESOLVED') return false;
      const finishedAt = new Date().toISOString();
      if (result.status === 'AWAITING_OWNER') {
        // Preserve an actual pending return without granting manual routing or
        // task authority. No terminal settlement is invented; only an explicit
        // MANUAL_HANDOFF_REQUIRED decision may expose the owner relay UI.
        return this.repo.getDatabase().prepare(`UPDATE execution_authorizations
          SET adapter_finished_at = ?, adapter_outcome = ?
          WHERE id = ? AND execution_id = ? AND status = 'DISPATCHED' AND adapter_finished_at IS NULL`)
          .run(finishedAt, outcome, auth.id, captured.executionId).changes === 1;
      }
      const evidence = this.settlementEvidence(current, observed, finishedAt);
      const json = canonicalJsonStringify(evidence);
      return this.repo.getDatabase().prepare(`UPDATE execution_authorizations
        SET adapter_finished_at = ?, adapter_outcome = ?, settlement_status = ?, settled_at = ?,
          settlement_evidence_json = ?, settlement_evidence_hash = ?
        WHERE id = ? AND execution_id = ? AND status = 'DISPATCHED' AND adapter_finished_at IS NULL
          AND settled_at IS NULL AND task_ownership_epoch = ?`)
        .run(finishedAt, outcome, result.status, finishedAt, json, computeSha256(json), auth.id, captured.executionId, captured.epoch).changes === 1;
    });
  }

  recordUnresolvedTimeout(auth: ExecutionAuthorization, captured: NonHandoffClaim): void {
    this.repo.runInImmediateTransaction(() => {
      const current = this.repo.getExecutionAuthorization(auth.id);
      if (!current || current.execution_id !== captured.executionId || !current.adapter_started_at || current.adapter_finished_at) return;
      this.repo.getDatabase().prepare(`UPDATE execution_authorizations
        SET adapter_outcome = 'TIMED_OUT', termination_status = 'UNRESOLVED',
          termination_source = 'NON_HANDOFF_DEADLINE', termination_reason = 'EXECUTION_TIMEOUT',
          termination_proof_source = 'TIMEOUT_UNACKNOWLEDGED'
        WHERE id = ? AND execution_id = ? AND adapter_finished_at IS NULL AND settled_at IS NULL`)
        .run(auth.id, captured.executionId);
      this.write('NON_HANDOFF_EXECUTION_TIMEOUT', auth, { executionId: captured.executionId,
        bindingHash: captured.bindingHash, timeoutMs: captured.timeoutMs, terminationProven: false }, 'timeout');
    });
  }

  publishIfCurrent(executionId: string, publish: () => void): boolean {
    const candidates = () => this.repo.getDatabase().prepare(`SELECT id FROM execution_authorizations
      WHERE execution_id = ? AND lifecycle_version IS NULL`).all(executionId) as Array<{ id: string }>;
    if (candidates().length === 0) {
      // Product publication and standalone adapter calls retain their existing authority.
      publish();
      return true;
    }
    return this.repo.runInImmediateTransaction(() => {
      const rows = candidates();
      if (rows.length !== 1) return false;
      const auth = this.repo.getExecutionAuthorization(rows[0].id);
      const claim = auth && this.read(auth.id, 'claim');
      if (!auth || !claim || auth.status !== 'DISPATCHED' || !auth.adapter_started_at || auth.adapter_finished_at ||
        auth.settled_at || auth.termination_status === 'UNRESOLVED' || !this.hasCapabilities(auth) ||
        !this.isCurrent(auth.id, claim as unknown as NonHandoffClaim)) return false;
      // Keep the SQLite writer lock through synchronous copy-back, so a newer
      // task owner or stop admission cannot win between validation and publication.
      publish();
      return true;
    });
  }

  reconcile(auth: ExecutionAuthorization): ExecutionRecoveryScanItemResult {
    return this.repo.runInImmediateTransaction(() => {
      let current = this.repo.getExecutionAuthorization(auth.id)!;
      auth = current;
      const task = this.repo.getTask(auth.task_id);
      const claim = this.read(auth.id, 'claim');
      const observation = this.read(auth.id, 'result');
      let classification: ExecutionRecoveryClassification;
      let disposition: ExecutionRecoveryDisposition;
      let mutatedTerminalState = false;
      let repositoryBound = false;
      try { repositoryBound = !!this.repo.getProjectForRepositoryUse(auth.project_id); } catch { /* Missing root authority fences this item. */ }
      if (!repositoryBound || !task || task.project_id !== auth.project_id || this.repo.getTaskOwnershipEpoch(task.id) !== auth.task_ownership_epoch) {
        classification = 'AUTHORITY_CONFLICT'; disposition = 'REJECTED_INTEGRITY_CONFLICT';
      } else if (auth.lifecycle_version === 1) {
        // Direct product authority is handled by product/adjudication recovery. Never abort it for lack of a handoff.
        classification = auth.status === 'AUTHORIZED' ? 'ALREADY_RECONCILED' : 'ADAPTER_IN_FLIGHT_UNRESOLVED';
        disposition = auth.status === 'AUTHORIZED' ? 'NO_OP_ALREADY_RECONCILED' : 'UNRESOLVED_FENCED';
      } else if (!claim) {
        // Old code invoked providers without start receipts. Absence of a timestamp proves nothing.
        classification = 'LEGACY_UNCLASSIFIABLE'; disposition = 'LEGACY_UNRESOLVED_FENCED';
      } else if (claim.bindingHash !== bindingHash(auth) || claim.executionId !== auth.execution_id || claim.epoch !== auth.task_ownership_epoch) {
        classification = 'AUTHORITY_CONFLICT'; disposition = 'REJECTED_INTEGRITY_CONFLICT';
      } else if (!auth.adapter_started_at) {
        classification = 'PRE_ADAPTER_NOT_STARTED'; disposition = 'TERMINALIZED_SAFE_EXPIRED';
        if (auth.status === 'DISPATCHED') {
          mutatedTerminalState = this.repo.getDatabase().prepare(`UPDATE execution_authorizations SET status = 'INVALIDATED'
            WHERE id = ? AND status = 'DISPATCHED' AND execution_id = ? AND adapter_started_at IS NULL AND task_ownership_epoch = ?`)
            .run(auth.id, auth.execution_id, auth.task_ownership_epoch).changes === 1;
          current = this.repo.getExecutionAuthorization(auth.id)!;
        }
      } else if (auth.adapter_finished_at && observation && observation.executionId === auth.execution_id && observation.bindingHash === bindingHash(auth) &&
        (observation.status === 'AWAITING_OWNER' || this.hasValidSettlement(auth, observation))) {
        classification = 'ALREADY_RECONCILED'; disposition = 'NO_OP_ALREADY_RECONCILED';
      } else if (auth.adapter_finished_at) {
        classification = 'ADAPTER_FINISHED_RESULT_MISSING'; disposition = 'RESULT_MISSING_FENCED';
      } else {
        classification = 'ADAPTER_IN_FLIGHT_UNRESOLVED'; disposition = 'UNRESOLVED_FENCED';
      }
      const evidence = { bindingHash: bindingHash(current), executionId: current.execution_id ?? null,
        status: current.status, currentEpoch: task ? this.repo.getTaskOwnershipEpoch(task.id) : null,
        startedAt: current.adapter_started_at ?? null, finishedAt: current.adapter_finished_at ?? null,
        settlementHash: current.settlement_evidence_hash ?? null, terminationStatus: current.termination_status ?? null,
        classification, disposition, claimHash: claim ? computeSha256(canonicalJsonStringify(claim)) : null,
        resultHash: observation ? computeSha256(canonicalJsonStringify(observation)) : null };
      const evidenceHash = computeSha256(canonicalJsonStringify(evidence));
      this.write(RECOVERY_EVENT, current, evidence, `recovery:${evidenceHash}`);
      return { authorizationId: auth.id, transferId: null, executionId: current.execution_id ?? null,
        lifecycleVersion: auth.lifecycle_version ?? null, classification, disposition,
        mutatedTerminalState, mutatedResources: false, evidenceHash };
    });
  }

  private isCurrent(id: string, captured: NonHandoffClaim): boolean {
    const auth = this.repo.getExecutionAuthorization(id);
    const task = auth && this.repo.getTask(auth.task_id);
    return !!auth && !!task && auth.lifecycle_version == null && !auth.assignment_id &&
      bindingHash(auth) === captured.bindingHash && taskHash(task) === captured.taskHash &&
      auth.task_ownership_epoch === captured.epoch && this.repo.getTaskOwnershipEpoch(task.id) === captured.epoch;
  }

  private hasCapabilities(auth: ExecutionAuthorization): boolean {
    try {
      if (!this.stopFence.assertDispatchAdmission(auth.id).admitted) return false;
      const project = this.repo.getProjectForRepositoryUse(auth.project_id);
      if (!project) return false;
      const payload = JSON.parse(auth.canonical_payload_json ?? '');
      new VerificationCapabilityService(this.repo).validateSnapshot(auth.project_id, payload.verificationCommands, project.repository_path);
      return true;
    } catch { return false; }
  }

  private matchesClaim(id: string, captured: NonHandoffClaim): boolean {
    return canonicalJsonStringify(this.read(id, 'claim') ?? {}) === canonicalJsonStringify(captured);
  }

  private hasValidSettlement(auth: ExecutionAuthorization, observation: Record<string, unknown>): boolean {
    if (!auth.settled_at || !auth.settlement_evidence_json || !auth.settlement_evidence_hash ||
      auth.settled_at !== auth.adapter_finished_at || auth.settlement_status !== observation.status ||
      auth.adapter_outcome !== observation.outcome || !['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(observation.status))) return false;
    try {
      const evidence = JSON.parse(auth.settlement_evidence_json);
      return computeSha256(canonicalJsonStringify(evidence)) === auth.settlement_evidence_hash &&
        canonicalJsonStringify(evidence) === canonicalJsonStringify(this.settlementEvidence(auth, observation, auth.settled_at));
    } catch { return false; }
  }

  private settlementEvidence(auth: ExecutionAuthorization, observation: Record<string, unknown>, finishedAt: string): Record<string, unknown> {
    return { authorization_id: auth.id, execution_id: auth.execution_id, transfer_id: null,
      project_id: auth.project_id, task_id: auth.task_id, attempt_id: auth.attempt_id,
      assignment_id: auth.assignment_id ?? null, provider_id: auth.selected_provider_id,
      resource_id: auth.selected_resource_id, account_id: auth.selected_account_id ?? null,
      routing_decision_id: auth.routing_decision_id, ownership_epoch: auth.task_ownership_epoch, lifecycle_version: null,
      settlement_status: observation.status, outcome: observation.outcome, started_at: auth.adapter_started_at,
      finished_at: finishedAt, result_payload: observation, error_json: null };
  }

  private eventId(id: string, suffix: string): string { return computeSha256(`${PROTOCOL}:${id}:${suffix}`); }
  private read(id: string, suffix: string): Record<string, unknown> | null {
    const row = this.repo.getDatabase().prepare('SELECT type, structured_payload_json FROM events WHERE id = ?')
      .get(this.eventId(id, suffix)) as { type: string; structured_payload_json: string } | undefined;
    if (!row) return null;
    const expectedType = suffix === 'claim' ? NON_HANDOFF_CLAIM_EVENT : RESULT_EVENT;
    try {
      const value = JSON.parse(row.structured_payload_json);
      return row.type === expectedType && value.protocol === PROTOCOL && value.authorizationId === id &&
        value.evidence && typeof value.evidence === 'object' && !Array.isArray(value.evidence) ? value.evidence : null;
    }
    catch { return null; }
  }
  private write(type: string, auth: ExecutionAuthorization, evidence: Record<string, unknown>, suffix: string): void {
    this.repo.createDeterministicGenericEvent({ id: this.eventId(auth.id, suffix), project_id: auth.project_id,
      task_id: auth.task_id, agent_id: null, type, summary: `${type}: ${auth.id}`,
      structured_payload: { protocol: PROTOCOL, authorizationId: auth.id, evidence }, timestamp: new Date().toISOString() });
  }
}
