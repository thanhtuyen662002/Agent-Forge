import crypto from 'crypto';
import { Repository } from '../database/repositories';
import {
  HandoffTransfer,
  HandoffTransferStatus,
  AdapterOutcome,
  ProviderTerminationStatus,
} from '../types/domain';

export type PredecessorQuiescenceState =
  | 'NOT_STARTED'
  | 'CONFIRMED_TERMINATED'
  | 'UNRESOLVED_ACTIVE_EXECUTION';

export interface PredecessorExecutionQuiescenceEvaluation {
  authorizationId: string;
  executionId: string | null;
  state: PredecessorQuiescenceState;
  adapterStartedAt: string | null;
  adapterFinishedAt: string | null;
  adapterOutcome: AdapterOutcome | null;
  cancellationRequestedAt: string | null;
  terminationConfirmedAt: string | null;
  terminationStatus: ProviderTerminationStatus | null;
  terminationSource: string | null;
}

export interface PredecessorQuiescenceResult {
  safeToRelinquish: boolean;
  transferId: string;
  sourceAttemptId: string;
  authorizations: PredecessorExecutionQuiescenceEvaluation[];
  unresolvedAuthorizationIds: string[];
  reason?: string;
}

export interface HandoffRequestParams {
  requestId: string;
  taskId: string;
  sourceAttemptId: string;
  sourceAssignmentId?: string | null;
  reason: string;
  expectedSourceEpoch: number;
  transferId?: string;
}

export interface HandoffRequestResult {
  success: boolean;
  transfer?: HandoffTransfer;
  duplicate?: boolean;
  error?: string;
  errorCode?:
    | 'TASK_NOT_FOUND'
    | 'SOURCE_ATTEMPT_NOT_FOUND'
    | 'TASK_ATTEMPT_MISMATCH'
    | 'ASSIGNMENT_NOT_FOUND'
    | 'ASSIGNMENT_MISMATCH'
    | 'ASSIGNMENT_TERMINAL'
    | 'STALE_OWNERSHIP_EPOCH'
    | 'REQUEST_ID_CONFLICT'
    | 'ACTIVE_TRANSFER_EXISTS'
    | 'INTERNAL_ERROR';
}

export interface HandoffFreezeParams {
  transferId: string;
  expectedVersion: number;
  checkpointId?: string | null;
  sourceAuthorizationId?: string | null;
  sourceAssignmentId?: string | null;
  frozenAt?: string;
}

export interface HandoffFreezeResult {
  success: boolean;
  transfer?: HandoffTransfer;
  error?: string;
  errorCode?:
    | 'TRANSFER_NOT_FOUND'
    | 'STATUS_CONFLICT'
    | 'VERSION_CONFLICT'
    | 'CHECKPOINT_NOT_FOUND'
    | 'CHECKPOINT_MISMATCH'
    | 'AUTHORIZATION_NOT_FOUND'
    | 'AUTHORIZATION_MISMATCH'
    | 'ASSIGNMENT_NOT_FOUND'
    | 'ASSIGNMENT_MISMATCH'
    | 'INTERNAL_ERROR';
}

export interface HandoffBeginQuiescenceParams {
  transferId: string;
  expectedVersion: number;
  quiescingAt?: string;
}

export interface HandoffBeginQuiescenceResult {
  success: boolean;
  transfer?: HandoffTransfer;
  error?: string;
  errorCode?:
    | 'TRANSFER_NOT_FOUND'
    | 'STATUS_CONFLICT'
    | 'VERSION_CONFLICT'
    | 'INTERNAL_ERROR';
}

export interface HandoffRelinquishParams {
  transferId: string;
  expectedVersion: number;
  expectedSourceEpoch: number;
  expectedTaskLeaseToken?: string;
  relinquishedAt?: string;
}

export interface HandoffRelinquishResult {
  success: boolean;
  transfer?: HandoffTransfer;
  newEpoch?: number;
  alreadyRelinquished?: boolean;
  error?: string;
  errorCode?:
    | 'TRANSFER_NOT_FOUND'
    | 'STATUS_CONFLICT'
    | 'VERSION_CONFLICT'
    | 'STALE_OWNERSHIP_EPOCH'
    | 'TASK_NOT_FOUND'
    | 'SOURCE_ATTEMPT_NOT_FOUND'
    | 'SOURCE_ATTEMPT_BINDING_MISMATCH'
    | 'SOURCE_ASSIGNMENT_NOT_FOUND'
    | 'SOURCE_ASSIGNMENT_BINDING_MISMATCH'
    | 'SOURCE_ASSIGNMENT_STATE_CONFLICT'
    | 'PREDECESSOR_EXECUTION_UNRESOLVED'
    | 'TASK_LEASE_AUTHORITY_UNVERIFIED'
    | 'TASK_LEASE_TOKEN_MISMATCH'
    | 'INTERNAL_ERROR';
  unresolvedAuthorizations?: string[];
}

export interface HandoffCancelParams {
  transferId: string;
  expectedVersion: number;
  reason?: string;
  cancelledAt?: string;
}

export interface HandoffCancelResult {
  success: boolean;
  transfer?: HandoffTransfer;
  error?: string;
  errorCode?:
    | 'TRANSFER_NOT_FOUND'
    | 'STATUS_CONFLICT'
    | 'VERSION_CONFLICT'
    | 'ALREADY_RELINQUISHED'
    | 'INTERNAL_ERROR';
}

export class HandoffTransferService {
  constructor(private repo: Repository) {}

  public requestHandoff(params: HandoffRequestParams): HandoffRequestResult {
    // 1. Task validation
    const task = this.repo.getTask(params.taskId);
    if (!task) {
      return {
        success: false,
        errorCode: 'TASK_NOT_FOUND',
        error: `Task "${params.taskId}" not found.`,
      };
    }

    // 2. Source attempt validation
    const sourceAttempt = this.repo.getTaskAttempt(params.sourceAttemptId);
    if (!sourceAttempt) {
      return {
        success: false,
        errorCode: 'SOURCE_ATTEMPT_NOT_FOUND',
        error: `Source TaskAttempt "${params.sourceAttemptId}" not found.`,
      };
    }

    if (sourceAttempt.task_id !== params.taskId) {
      return {
        success: false,
        errorCode: 'TASK_ATTEMPT_MISMATCH',
        error: `Source TaskAttempt "${params.sourceAttemptId}" belongs to task "${sourceAttempt.task_id}", expected "${params.taskId}".`,
      };
    }

    // 3. Source assignment validation
    let resolvedAssignmentId = params.sourceAssignmentId ?? null;
    if (resolvedAssignmentId) {
      const assignment = this.repo.getAgentAssignment(resolvedAssignmentId);
      if (!assignment) {
        return {
          success: false,
          errorCode: 'ASSIGNMENT_NOT_FOUND',
          error: `Source AgentAssignment "${resolvedAssignmentId}" not found.`,
        };
      }
      if (assignment.task_id !== params.taskId) {
        return {
          success: false,
          errorCode: 'ASSIGNMENT_MISMATCH',
          error: `Source AgentAssignment "${resolvedAssignmentId}" belongs to task "${assignment.task_id}", expected "${params.taskId}".`,
        };
      }
      if (assignment.attempt_id && assignment.attempt_id !== params.sourceAttemptId) {
        return {
          success: false,
          errorCode: 'ASSIGNMENT_MISMATCH',
          error: `Source AgentAssignment "${resolvedAssignmentId}" belongs to attempt "${assignment.attempt_id}", expected "${params.sourceAttemptId}".`,
        };
      }
      if (
        assignment.status === 'HANDED_OFF' ||
        assignment.status === 'COMPLETED' ||
        assignment.status === 'FAILED' ||
        assignment.status === 'CANCELLED'
      ) {
        return {
          success: false,
          errorCode: 'ASSIGNMENT_TERMINAL',
          error: `Source AgentAssignment "${resolvedAssignmentId}" has terminal/inactive status "${assignment.status}".`,
        };
      }
    } else {
      // Look up active assignment for task
      const assignments = this.repo.getAgentAssignmentsByTask(params.taskId);
      const matchingAssignment = assignments.find(
        (a) =>
          (!a.attempt_id || a.attempt_id === params.sourceAttemptId) &&
          (a.status === 'ASSIGNED' || a.status === 'RUNNING')
      );
      if (matchingAssignment) {
        resolvedAssignmentId = matchingAssignment.id;
      } else {
        return {
          success: false,
          errorCode: 'ASSIGNMENT_NOT_FOUND',
          error: `No active AgentAssignment found for task "${params.taskId}" and source attempt "${params.sourceAttemptId}".`,
        };
      }
    }

    // 4. Ownership epoch validation
    const currentEpoch = this.repo.getTaskOwnershipEpoch(params.taskId);
    if (currentEpoch !== params.expectedSourceEpoch) {
      return {
        success: false,
        errorCode: 'STALE_OWNERSHIP_EPOCH',
        error: `STALE_OWNERSHIP_EPOCH: Expected epoch ${params.expectedSourceEpoch}, current task epoch is ${currentEpoch}.`,
      };
    }

    // 5. Construct and create HandoffTransfer
    const nowIso = new Date().toISOString();
    const transfer: HandoffTransfer = {
      id: params.transferId ?? `ht-${crypto.randomUUID()}`,
      request_id: params.requestId,
      task_id: params.taskId,
      source_attempt_id: params.sourceAttemptId,
      successor_attempt_id: null,
      source_assignment_id: resolvedAssignmentId,
      successor_assignment_id: null,
      successor_role_profile_id: null,
      successor_agent_profile_id: null,
      handoff_context_id: null,
      checkpoint_id: null,
      source_authorization_id: null,
      successor_authorization_id: null,
      reason: params.reason,
      status: 'REQUESTED',
      source_ownership_epoch: params.expectedSourceEpoch,
      successor_ownership_epoch: null,
      version: 1,
      frozen_at: null,
      quiescing_at: null,
      relinquished_at: null,
      accepted_at: null,
      completed_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    };

    try {
      const res = this.repo.createHandoffTransfer(transfer);
      if (!res.success) {
        return {
          success: false,
          duplicate: res.duplicate,
          transfer: res.transfer,
          errorCode: 'REQUEST_ID_CONFLICT',
          error: res.error ?? 'Failed to create handoff transfer.',
        };
      }
      return {
        success: true,
        duplicate: res.duplicate,
        transfer: res.transfer,
      };
    } catch (err: any) {
      if (err.message && err.message.includes('UNIQUE constraint failed')) {
        return {
          success: false,
          errorCode: 'ACTIVE_TRANSFER_EXISTS',
          error: `ACTIVE_TRANSFER_EXISTS: An active or post-relinquished transfer already exists for source attempt "${params.sourceAttemptId}".`,
        };
      }
      return {
        success: false,
        errorCode: 'INTERNAL_ERROR',
        error: err.message ?? String(err),
      };
    }
  }

  public freezeHandoff(params: HandoffFreezeParams): HandoffFreezeResult {
    const existing = this.repo.getHandoffTransfer(params.transferId);
    if (!existing) {
      return {
        success: false,
        errorCode: 'TRANSFER_NOT_FOUND',
        error: `Handoff transfer "${params.transferId}" not found.`,
      };
    }

    if (existing.status !== 'REQUESTED') {
      return {
        success: false,
        errorCode: 'STATUS_CONFLICT',
        error: `STATUS_CONFLICT: Expected transfer status REQUESTED, found ${existing.status}.`,
      };
    }

    if (existing.version !== params.expectedVersion) {
      return {
        success: false,
        errorCode: 'VERSION_CONFLICT',
        error: `VERSION_CONFLICT: Expected version ${params.expectedVersion}, found ${existing.version}.`,
      };
    }

    // Validate optional Checkpoint
    if (params.checkpointId) {
      const checkpoint = this.repo.getCheckpoint(params.checkpointId);
      if (!checkpoint) {
        return {
          success: false,
          errorCode: 'CHECKPOINT_NOT_FOUND',
          error: `Checkpoint "${params.checkpointId}" not found.`,
        };
      }
      if (checkpoint.task_id !== existing.task_id) {
        return {
          success: false,
          errorCode: 'CHECKPOINT_MISMATCH',
          error: `Checkpoint "${params.checkpointId}" belongs to task "${checkpoint.task_id}", expected "${existing.task_id}".`,
        };
      }
      if (checkpoint.attempt_id && checkpoint.attempt_id !== existing.source_attempt_id) {
        return {
          success: false,
          errorCode: 'CHECKPOINT_MISMATCH',
          error: `Checkpoint "${params.checkpointId}" belongs to attempt "${checkpoint.attempt_id}", expected "${existing.source_attempt_id}".`,
        };
      }
    }

    // Validate optional Source Authorization
    if (params.sourceAuthorizationId) {
      const auth = this.repo.getExecutionAuthorization(params.sourceAuthorizationId);
      if (!auth) {
        return {
          success: false,
          errorCode: 'AUTHORIZATION_NOT_FOUND',
          error: `Execution authorization "${params.sourceAuthorizationId}" not found.`,
        };
      }
      if (auth.task_id !== existing.task_id) {
        return {
          success: false,
          errorCode: 'AUTHORIZATION_MISMATCH',
          error: `Authorization "${params.sourceAuthorizationId}" belongs to task "${auth.task_id}", expected "${existing.task_id}".`,
        };
      }
      if (auth.attempt_id && auth.attempt_id !== existing.source_attempt_id) {
        return {
          success: false,
          errorCode: 'AUTHORIZATION_MISMATCH',
          error: `Authorization "${params.sourceAuthorizationId}" belongs to attempt "${auth.attempt_id}", expected "${existing.source_attempt_id}".`,
        };
      }
      if (auth.task_ownership_epoch !== existing.source_ownership_epoch) {
        return {
          success: false,
          errorCode: 'AUTHORIZATION_MISMATCH',
          error: `Authorization "${params.sourceAuthorizationId}" has epoch ${auth.task_ownership_epoch}, expected "${existing.source_ownership_epoch}".`,
        };
      }
    }

    // Validate optional Source Assignment
    if (params.sourceAssignmentId) {
      const asgn = this.repo.getAgentAssignment(params.sourceAssignmentId);
      if (!asgn) {
        return {
          success: false,
          errorCode: 'ASSIGNMENT_NOT_FOUND',
          error: `AgentAssignment "${params.sourceAssignmentId}" not found.`,
        };
      }
      if (asgn.task_id !== existing.task_id) {
        return {
          success: false,
          errorCode: 'ASSIGNMENT_MISMATCH',
          error: `AgentAssignment "${params.sourceAssignmentId}" belongs to task "${asgn.task_id}", expected "${existing.task_id}".`,
        };
      }
      if (asgn.attempt_id && asgn.attempt_id !== existing.source_attempt_id) {
        return {
          success: false,
          errorCode: 'ASSIGNMENT_MISMATCH',
          error: `AgentAssignment "${params.sourceAssignmentId}" belongs to attempt "${asgn.attempt_id}", expected "${existing.source_attempt_id}".`,
        };
      }
    }

    const res = this.repo.updateHandoffTransferStatus({
      id: params.transferId,
      fromStatus: 'REQUESTED',
      toStatus: 'FROZEN',
      expectedVersion: params.expectedVersion,
      additionalFields: {
        checkpoint_id: params.checkpointId ?? existing.checkpoint_id,
        source_authorization_id: params.sourceAuthorizationId ?? existing.source_authorization_id,
        source_assignment_id: params.sourceAssignmentId ?? existing.source_assignment_id,
        frozen_at: params.frozenAt ?? new Date().toISOString(),
      },
    });

    if (!res.success) {
      return {
        success: false,
        errorCode: 'VERSION_CONFLICT',
        error: res.error ?? 'Failed to freeze handoff transfer.',
      };
    }

    return {
      success: true,
      transfer: res.transfer,
    };
  }

  public beginQuiescence(params: HandoffBeginQuiescenceParams): HandoffBeginQuiescenceResult {
    const existing = this.repo.getHandoffTransfer(params.transferId);
    if (!existing) {
      return {
        success: false,
        errorCode: 'TRANSFER_NOT_FOUND',
        error: `Handoff transfer "${params.transferId}" not found.`,
      };
    }

    if (existing.status !== 'FROZEN') {
      return {
        success: false,
        errorCode: 'STATUS_CONFLICT',
        error: `STATUS_CONFLICT: Expected transfer status FROZEN, found ${existing.status}.`,
      };
    }

    if (existing.version !== params.expectedVersion) {
      return {
        success: false,
        errorCode: 'VERSION_CONFLICT',
        error: `VERSION_CONFLICT: Expected version ${params.expectedVersion}, found ${existing.version}.`,
      };
    }

    const res = this.repo.updateHandoffTransferStatus({
      id: params.transferId,
      fromStatus: 'FROZEN',
      toStatus: 'QUIESCING',
      expectedVersion: params.expectedVersion,
      additionalFields: {
        quiescing_at: params.quiescingAt ?? new Date().toISOString(),
      },
    });

    if (!res.success) {
      return {
        success: false,
        errorCode: 'VERSION_CONFLICT',
        error: res.error ?? 'Failed to begin quiescence for handoff transfer.',
      };
    }

    return {
      success: true,
      transfer: res.transfer,
    };
  }

  public evaluatePredecessorQuiescence(transferId: string): PredecessorQuiescenceResult {
    const transfer = this.repo.getHandoffTransfer(transferId);
    if (!transfer) {
      return {
        safeToRelinquish: false,
        transferId,
        sourceAttemptId: '',
        authorizations: [],
        unresolvedAuthorizationIds: [],
        reason: 'TRANSFER_NOT_FOUND',
      };
    }

    const auths = this.repo.getExecutionAuthorizationsByAttempt(transfer.source_attempt_id);
    const evaluations: PredecessorExecutionQuiescenceEvaluation[] = [];
    const unresolvedIds: string[] = [];

    for (const auth of auths) {
      let state: PredecessorQuiescenceState;

      if (!auth.adapter_started_at) {
        state = 'NOT_STARTED';
      } else if (
        auth.termination_status === 'CONFIRMED_TERMINATED' &&
        auth.termination_confirmed_at !== null &&
        auth.termination_confirmed_at !== undefined
      ) {
        state = 'CONFIRMED_TERMINATED';
      } else {
        state = 'UNRESOLVED_ACTIVE_EXECUTION';
        unresolvedIds.push(auth.id);
      }

      evaluations.push({
        authorizationId: auth.id,
        executionId: auth.execution_id ?? null,
        state,
        adapterStartedAt: auth.adapter_started_at ?? null,
        adapterFinishedAt: auth.adapter_finished_at ?? null,
        adapterOutcome: auth.adapter_outcome ?? null,
        cancellationRequestedAt: auth.cancellation_requested_at ?? null,
        terminationConfirmedAt: auth.termination_confirmed_at ?? null,
        terminationStatus: auth.termination_status ?? null,
        terminationSource: auth.termination_source ?? null,
      });
    }

    return {
      safeToRelinquish: unresolvedIds.length === 0,
      transferId: transfer.id,
      sourceAttemptId: transfer.source_attempt_id,
      authorizations: evaluations,
      unresolvedAuthorizationIds: unresolvedIds,
      reason:
        unresolvedIds.length > 0
          ? `PREDECESSOR_EXECUTION_UNRESOLVED: ${unresolvedIds.length} execution(s) unresolved`
          : undefined,
    };
  }

  public relinquishPredecessorOwnership(params: HandoffRelinquishParams): HandoffRelinquishResult {
    return this.repo.relinquishPredecessorOwnership(params);
  }

  public cancelHandoff(params: HandoffCancelParams): HandoffCancelResult {
    const existing = this.repo.getHandoffTransfer(params.transferId);
    if (!existing) {
      return {
        success: false,
        errorCode: 'TRANSFER_NOT_FOUND',
        error: `Handoff transfer "${params.transferId}" not found.`,
      };
    }

    if (existing.relinquished_at !== null || existing.status === 'RELINQUISHED') {
      return {
        success: false,
        errorCode: 'ALREADY_RELINQUISHED',
        error: 'ALREADY_RELINQUISHED: Cannot cancel a handoff transfer after ownership has been relinquished.',
      };
    }

    const allowedPreRelinquishStatuses: HandoffTransferStatus[] = ['REQUESTED', 'FROZEN', 'QUIESCING'];
    if (!allowedPreRelinquishStatuses.includes(existing.status)) {
      return {
        success: false,
        errorCode: 'STATUS_CONFLICT',
        error: `STATUS_CONFLICT: Cannot cancel transfer with status ${existing.status}. Expected one of [${allowedPreRelinquishStatuses.join(', ')}].`,
      };
    }

    if (existing.version !== params.expectedVersion) {
      return {
        success: false,
        errorCode: 'VERSION_CONFLICT',
        error: `VERSION_CONFLICT: Expected version ${params.expectedVersion}, found ${existing.version}.`,
      };
    }

    const res = this.repo.updateHandoffTransferStatus({
      id: params.transferId,
      fromStatus: allowedPreRelinquishStatuses,
      toStatus: 'CANCELLED',
      expectedVersion: params.expectedVersion,
    });

    if (!res.success) {
      return {
        success: false,
        errorCode: 'VERSION_CONFLICT',
        error: res.error ?? 'Failed to cancel handoff transfer.',
      };
    }

    return {
      success: true,
      transfer: res.transfer,
    };
  }
}
