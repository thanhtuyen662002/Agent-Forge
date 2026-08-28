import crypto from 'crypto';
import { Repository } from '../database/repositories';
import {
  HandoffTransfer,
  HandoffTransferStatus,
  AdapterOutcome,
  ProviderTerminationStatus,
  TaskAttempt,
  ContextSnapshot,
  ContextManifest,
  ContextItem,
  ContextItemType,
} from '../types/domain';
import {
  ContextBuilderService,
  codeUnitCompare,
  canonicalJsonStringify,
  computeSha256,
} from './ContextBuilderService';

export function isRecoverableDeterministicSnapshotCollision(
  err: unknown,
  _expectedSnapshotId?: string
): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }

  const error = err as { code?: string; message?: string; name?: string };
  const code = error.code ? String(error.code) : '';
  const message = error.message ? String(error.message) : '';

  // Must be an SQLite unique / primary-key constraint error
  const isUniqueOrPrimaryKey =
    code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    (code === 'SQLITE_CONSTRAINT' &&
      (message.includes('UNIQUE constraint failed') ||
       message.includes('PRIMARY KEY constraint failed')));

  if (!isUniqueOrPrimaryKey) {
    return false;
  }

  // Must specifically and strictly identify the context_snapshots.id collision
  const targetsSnapshotId = message.includes('context_snapshots.id');

  return targetsSnapshotId;
}

export function sortSuccessorCustomItems<T extends {
  itemType?: ContextItemType;
  sourceType: string;
  sourceRef?: string | null;
  content: Record<string, unknown> | unknown[];
  tokenEstimate?: number | null;
}>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aType = a.itemType || 'CUSTOM';
    const bType = b.itemType || 'CUSTOM';
    const typeCmp = codeUnitCompare(aType, bType);
    if (typeCmp !== 0) return typeCmp;

    const srcTypeCmp = codeUnitCompare(a.sourceType, b.sourceType);
    if (srcTypeCmp !== 0) return srcTypeCmp;

    // Distinguish NULL/undefined from string (including empty string "")
    const aRefTag = a.sourceRef === null || a.sourceRef === undefined ? '0' : `1${a.sourceRef}`;
    const bRefTag = b.sourceRef === null || b.sourceRef === undefined ? '0' : `1${b.sourceRef}`;
    const refCmp = codeUnitCompare(aRefTag, bRefTag);
    if (refCmp !== 0) return refCmp;

    const aHash = computeSha256(canonicalJsonStringify(a.content));
    const bHash = computeSha256(canonicalJsonStringify(b.content));
    const contentCmp = codeUnitCompare(aHash, bHash);
    if (contentCmp !== 0) return contentCmp;

    const aTok = a.tokenEstimate !== null && a.tokenEstimate !== undefined ? `1${a.tokenEstimate}` : '0';
    const bTok = b.tokenEstimate !== null && b.tokenEstimate !== undefined ? `1${b.tokenEstimate}` : '0';
    return codeUnitCompare(aTok, bTok);
  });
}

export function computeSuccessorContextSpecHash(spec: {
  transferId: string;
  successorAttemptId: string;
  purpose: string;
  handoffContextId: string | null;
  checkpointId: string | null;
  contextFiles: string[];
  customItems: Array<{
    itemType?: ContextItemType;
    sourceType: string;
    sourceRef?: string | null;
    content: Record<string, unknown> | unknown[];
    tokenEstimate?: number | null;
  }>;
}): string {
  const sortedFiles = [...spec.contextFiles].sort(codeUnitCompare);
  const sortedCustom = sortSuccessorCustomItems(spec.customItems);

  const canonicalDescriptor = {
    transfer_id: spec.transferId,
    successor_attempt_id: spec.successorAttemptId,
    purpose: spec.purpose,
    handoff_context_id: spec.handoffContextId,
    checkpoint_id: spec.checkpointId,
    context_files: sortedFiles,
    custom_items: sortedCustom.map((c) => ({
      item_type: c.itemType || 'CUSTOM',
      source_type: c.sourceType,
      source_ref: c.sourceRef ?? null,
      content: c.content,
      token_estimate: c.tokenEstimate ?? null,
    })),
  };

  return computeSha256(canonicalJsonStringify(canonicalDescriptor));
}

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

export interface HandoffPrepareSuccessorParams {
  transferId: string;
  expectedVersion: number;
  expectedSuccessorEpoch: number;
  successorRoleProfileId: string;
  successorAgentProfileId: string;
  successorAttemptId?: string;
  preparedAt?: string;
  // Context snapshot options
  buildContext?: boolean;
  handoffContextId?: string | null;
  checkpointId?: string | null;
  contextFiles?: string[];
  customItems?: Array<{
    itemType?: ContextItemType;
    sourceType: string;
    sourceRef?: string | null;
    content: Record<string, unknown> | unknown[];
    tokenEstimate?: number | null;
  }>;
}

export interface HandoffPrepareSuccessorResult {
  success: boolean;
  transfer?: HandoffTransfer;
  successorAttempt?: TaskAttempt;
  contextSnapshot?: ContextSnapshot;
  contextManifest?: ContextManifest;
  contextItems?: ContextItem[];
  alreadyPrepared?: boolean;
  alreadyBound?: boolean;
  error?: string;
  errorCode?:
    | 'TRANSFER_NOT_FOUND'
    | 'STATUS_CONFLICT'
    | 'VERSION_CONFLICT'
    | 'STALE_OWNERSHIP_EPOCH'
    | 'TASK_NOT_FOUND'
    | 'ROLE_PROFILE_NOT_FOUND'
    | 'ROLE_PROFILE_DISABLED'
    | 'AGENT_PROFILE_NOT_FOUND'
    | 'AGENT_PROFILE_DISABLED'
    | 'AGENT_PROFILE_ROLE_MISMATCH'
    | 'ATTEMPT_ID_ALREADY_EXISTS'
    | 'CONFLICTING_SUCCESSOR_PROFILE'
    | 'CONFLICTING_SUCCESSOR_ROLE'
    | 'HANDOFF_CONTEXT_NOT_FOUND'
    | 'CROSS_TASK_HANDOFF_CONTEXT_FORBIDDEN'
    | 'HANDOFF_CONTEXT_SOURCE_MISMATCH'
    | 'BOUND_HANDOFF_CONTEXT_OVERRIDE_FORBIDDEN'
    | 'UNBOUND_HANDOFF_CONTEXT_OVERRIDE'
    | 'BOUND_CHECKPOINT_OVERRIDE_FORBIDDEN'
    | 'UNBOUND_CHECKPOINT_OVERRIDE'
    | 'SUCCESSOR_CONTEXT_SPEC_CONFLICT'
    | 'SUCCESSOR_CONTEXT_AUTHORITY_INTEGRITY_MISMATCH'
    | 'CONTEXT_SNAPSHOT_NOT_FOUND'
    | 'CONTEXT_SNAPSHOT_INTEGRITY_MISMATCH'
    | 'CONTEXT_MANIFEST_NOT_FOUND'
    | 'SUCCESSOR_NOT_PREPARED'
    | 'CONTEXT_BUILD_FAILED'
    | 'INTERNAL_ERROR';
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
  private contextBuilder: ContextBuilderService;

  constructor(private repo: Repository, contextBuilder?: ContextBuilderService) {
    this.contextBuilder = contextBuilder ?? new ContextBuilderService(this.repo);
  }

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
      successor_context_snapshot_id: null,
      successor_context_spec_hash: null,
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

  public prepareHandoffSuccessor(params: HandoffPrepareSuccessorParams): HandoffPrepareSuccessorResult {
    // 1. Invoke atomic repository primitive (creates Attempt N+1 and sets status to SUCCESSOR_PREPARED)
    const prepRes = this.repo.prepareHandoffSuccessor({
      transferId: params.transferId,
      expectedVersion: params.expectedVersion,
      expectedSuccessorEpoch: params.expectedSuccessorEpoch,
      successorRoleProfileId: params.successorRoleProfileId,
      successorAgentProfileId: params.successorAgentProfileId,
      successorAttemptId: params.successorAttemptId,
      preparedAt: params.preparedAt,
    });

    if (!prepRes.success) {
      return {
        success: false,
        errorCode: prepRes.errorCode,
        error: prepRes.error,
      };
    }

    const transfer = prepRes.transfer!;
    const successorAttempt = prepRes.successorAttempt!;

    // If context construction is not requested, return prepared result
    if (params.buildContext === false) {
      return {
        success: true,
        transfer,
        successorAttempt,
        alreadyPrepared: prepRes.alreadyPrepared,
      };
    }

    // 2. Caller override fencing (Section 13 & Defect C)
    if (transfer.handoff_context_id !== null) {
      if (params.handoffContextId !== undefined && params.handoffContextId !== transfer.handoff_context_id) {
        return {
          success: false,
          transfer,
          successorAttempt,
          alreadyPrepared: prepRes.alreadyPrepared,
          errorCode: 'BOUND_HANDOFF_CONTEXT_OVERRIDE_FORBIDDEN',
          error: `BOUND_HANDOFF_CONTEXT_OVERRIDE_FORBIDDEN: Cannot override bound handoff_context_id "${transfer.handoff_context_id}" with "${params.handoffContextId}".`,
        };
      }
    } else if (params.handoffContextId !== undefined && params.handoffContextId !== null) {
      return {
        success: false,
        transfer,
        successorAttempt,
        alreadyPrepared: prepRes.alreadyPrepared,
        errorCode: 'UNBOUND_HANDOFF_CONTEXT_OVERRIDE',
        error: `UNBOUND_HANDOFF_CONTEXT_OVERRIDE: Cannot inject unbound handoffContextId "${params.handoffContextId}" when transfer has no bound handoff_context_id.`,
      };
    }

    if (transfer.checkpoint_id !== null) {
      if (params.checkpointId !== undefined && params.checkpointId !== transfer.checkpoint_id) {
        return {
          success: false,
          transfer,
          successorAttempt,
          alreadyPrepared: prepRes.alreadyPrepared,
          errorCode: 'BOUND_CHECKPOINT_OVERRIDE_FORBIDDEN',
          error: `BOUND_CHECKPOINT_OVERRIDE_FORBIDDEN: Cannot override bound checkpoint_id "${transfer.checkpoint_id}" with "${params.checkpointId}".`,
        };
      }
    } else if (params.checkpointId !== undefined && params.checkpointId !== null) {
      return {
        success: false,
        transfer,
        successorAttempt,
        alreadyPrepared: prepRes.alreadyPrepared,
        errorCode: 'UNBOUND_CHECKPOINT_OVERRIDE',
        error: `UNBOUND_CHECKPOINT_OVERRIDE: Cannot inject unbound checkpointId "${params.checkpointId}" when transfer has no bound checkpoint_id.`,
      };
    }

    // 3. Bound HandoffContext validation (Defect A: exact source attempt match required)
    if (transfer.handoff_context_id) {
      const ho = this.repo.getHandoffContext(transfer.handoff_context_id);
      if (!ho) {
        return {
          success: false,
          transfer,
          successorAttempt,
          alreadyPrepared: prepRes.alreadyPrepared,
          errorCode: 'HANDOFF_CONTEXT_NOT_FOUND',
          error: `HandoffContext "${transfer.handoff_context_id}" not found.`,
        };
      }
      if (ho.task_id !== transfer.task_id) {
        return {
          success: false,
          transfer,
          successorAttempt,
          alreadyPrepared: prepRes.alreadyPrepared,
          errorCode: 'CROSS_TASK_HANDOFF_CONTEXT_FORBIDDEN',
          error: `CROSS_TASK_HANDOFF_CONTEXT_FORBIDDEN: HandoffContext "${transfer.handoff_context_id}" belongs to task "${ho.task_id}", expected "${transfer.task_id}".`,
        };
      }
      if (!ho.attempt_id || ho.attempt_id !== transfer.source_attempt_id) {
        return {
          success: false,
          transfer,
          successorAttempt,
          alreadyPrepared: prepRes.alreadyPrepared,
          errorCode: 'HANDOFF_CONTEXT_SOURCE_MISMATCH',
          error: `HANDOFF_CONTEXT_SOURCE_MISMATCH: HandoffContext "${transfer.handoff_context_id}" source attempt "${ho.attempt_id ?? 'NULL'}" does not match transfer source attempt "${transfer.source_attempt_id}".`,
        };
      }
    }

    // 4. Compute canonical spec hash with total deterministic ordering
    const sortedFiles = [...(params.contextFiles ?? [])].sort(codeUnitCompare);
    const sortedCustomItems = sortSuccessorCustomItems(params.customItems ?? []);

    const specHash = computeSuccessorContextSpecHash({
      transferId: transfer.id,
      successorAttemptId: successorAttempt.id,
      purpose: 'HANDOFF',
      handoffContextId: transfer.handoff_context_id,
      checkpointId: transfer.checkpoint_id,
      contextFiles: sortedFiles,
      customItems: sortedCustomItems,
    });

    // 5. Exact Context Replay Check (Section 10 & 11)
    if (transfer.successor_context_snapshot_id !== null) {
      const existingSnap = this.repo.getContextSnapshot(transfer.successor_context_snapshot_id);
      if (!existingSnap) {
        return {
          success: false,
          transfer,
          successorAttempt,
          alreadyPrepared: prepRes.alreadyPrepared,
          errorCode: 'SUCCESSOR_CONTEXT_AUTHORITY_INTEGRITY_MISMATCH',
          error: `SUCCESSOR_CONTEXT_AUTHORITY_INTEGRITY_MISMATCH: Bound snapshot "${transfer.successor_context_snapshot_id}" not found in database.`,
        };
      }

      if (
        existingSnap.task_id !== transfer.task_id ||
        existingSnap.attempt_id !== successorAttempt.id ||
        existingSnap.purpose !== 'HANDOFF'
      ) {
        return {
          success: false,
          transfer,
          successorAttempt,
          alreadyPrepared: prepRes.alreadyPrepared,
          errorCode: 'SUCCESSOR_CONTEXT_AUTHORITY_INTEGRITY_MISMATCH',
          error: `SUCCESSOR_CONTEXT_AUTHORITY_INTEGRITY_MISMATCH: Bound snapshot "${existingSnap.id}" integrity mismatch.`,
        };
      }

      const existingMan = this.repo.getContextManifestBySnapshotId(existingSnap.id);
      if (!existingMan) {
        return {
          success: false,
          transfer,
          successorAttempt,
          alreadyPrepared: prepRes.alreadyPrepared,
          errorCode: 'SUCCESSOR_CONTEXT_AUTHORITY_INTEGRITY_MISMATCH',
          error: `SUCCESSOR_CONTEXT_AUTHORITY_INTEGRITY_MISMATCH: Manifest for snapshot "${existingSnap.id}" not found.`,
        };
      }

      if (transfer.successor_context_spec_hash !== specHash) {
        return {
          success: false,
          transfer,
          successorAttempt,
          alreadyPrepared: prepRes.alreadyPrepared,
          errorCode: 'SUCCESSOR_CONTEXT_SPEC_CONFLICT',
          error: `SUCCESSOR_CONTEXT_SPEC_CONFLICT: Persisted spec hash "${transfer.successor_context_spec_hash}" does not match requested spec hash "${specHash}".`,
        };
      }

      const deterministicManifestId = `ctx-man-ho-${computeSha256(`r5i-successor-manifest:${transfer.id}:${specHash}`).slice(0, 32)}`;
      if (existingMan.id !== deterministicManifestId) {
        return {
          success: false,
          transfer,
          successorAttempt,
          alreadyPrepared: prepRes.alreadyPrepared,
          errorCode: 'SUCCESSOR_CONTEXT_AUTHORITY_INTEGRITY_MISMATCH',
          error: `SUCCESSOR_CONTEXT_AUTHORITY_INTEGRITY_MISMATCH: Bound manifest "${existingMan.id}" does not match deterministic manifest ID "${deterministicManifestId}".`,
        };
      }

      return {
        success: true,
        transfer,
        successorAttempt,
        contextSnapshot: existingSnap,
        contextManifest: existingMan,
        contextItems: this.repo.getContextItemsBySnapshot(existingSnap.id),
        alreadyPrepared: true,
        alreadyBound: true,
      };
    }

    // 6. Derive deterministic artifact IDs & recover if snapshot already persisted
    const deterministicSnapshotId = `ctx-snap-ho-${computeSha256(`r5i-successor-context:${transfer.id}:${specHash}`).slice(0, 32)}`;
    const deterministicManifestId = `ctx-man-ho-${computeSha256(`r5i-successor-manifest:${transfer.id}:${specHash}`).slice(0, 32)}`;

    let candidateSnapshot = this.repo.getContextSnapshot(deterministicSnapshotId);
    let candidateManifest = candidateSnapshot ? this.repo.getContextManifestBySnapshotId(candidateSnapshot.id) : null;
    let candidateItems = candidateSnapshot ? this.repo.getContextItemsBySnapshot(candidateSnapshot.id) : [];

    if (candidateSnapshot) {
      if (
        candidateSnapshot.task_id !== transfer.task_id ||
        candidateSnapshot.attempt_id !== successorAttempt.id ||
        candidateSnapshot.purpose !== 'HANDOFF'
      ) {
        return {
          success: false,
          transfer,
          successorAttempt,
          alreadyPrepared: prepRes.alreadyPrepared,
          errorCode: 'SUCCESSOR_CONTEXT_AUTHORITY_INTEGRITY_MISMATCH',
          error: `SUCCESSOR_CONTEXT_AUTHORITY_INTEGRITY_MISMATCH: Pre-existing candidate snapshot "${candidateSnapshot.id}" integrity mismatch.`,
        };
      }
      if (!candidateManifest) {
        return {
          success: false,
          transfer,
          successorAttempt,
          alreadyPrepared: prepRes.alreadyPrepared,
          errorCode: 'SUCCESSOR_CONTEXT_AUTHORITY_INTEGRITY_MISMATCH',
          error: `SUCCESSOR_CONTEXT_AUTHORITY_INTEGRITY_MISMATCH: Pre-existing candidate snapshot "${candidateSnapshot.id}" missing manifest.`,
        };
      }
      if (candidateManifest.id !== deterministicManifestId) {
        return {
          success: false,
          transfer,
          successorAttempt,
          alreadyPrepared: prepRes.alreadyPrepared,
          errorCode: 'SUCCESSOR_CONTEXT_AUTHORITY_INTEGRITY_MISMATCH',
          error: `SUCCESSOR_CONTEXT_AUTHORITY_INTEGRITY_MISMATCH: Pre-existing candidate manifest "${candidateManifest.id}" does not match deterministic manifest ID "${deterministicManifestId}".`,
        };
      }
    } else {
      const task = this.repo.getTask(transfer.task_id);
      if (!task) {
        return {
          success: false,
          transfer,
          successorAttempt,
          alreadyPrepared: prepRes.alreadyPrepared,
          errorCode: 'TASK_NOT_FOUND',
          error: `Task "${transfer.task_id}" not found.`,
        };
      }

      try {
        const ctxResult = this.contextBuilder.buildContextSnapshot({
          projectId: task.project_id,
          taskId: transfer.task_id,
          attemptId: successorAttempt.id,
          purpose: 'HANDOFF',
          includeLatestHandoff: false,
          includeLatestCheckpoint: false,
          handoffId: transfer.handoff_context_id,
          checkpointId: transfer.checkpoint_id,
          contextFiles: sortedFiles,
          customItems: sortedCustomItems,
          snapshotId: deterministicSnapshotId,
          manifestId: deterministicManifestId,
        });

        candidateSnapshot = ctxResult.snapshot;
        candidateManifest = ctxResult.manifest;
        candidateItems = ctxResult.items;
      } catch (err) {
        // Enforce exact collision classification before attempting race recovery
        if (!isRecoverableDeterministicSnapshotCollision(err, deterministicSnapshotId)) {
          return {
            success: false,
            transfer,
            successorAttempt,
            alreadyPrepared: prepRes.alreadyPrepared,
            errorCode: 'CONTEXT_BUILD_FAILED',
            error: `[ContextBuildFailed] ${err instanceof Error ? err.message : String(err)}`,
          };
        }

        // Race recovery: a concurrent contender already persisted the deterministic candidate
        const recoveredSnap = this.repo.getContextSnapshot(deterministicSnapshotId);
        const recoveredMan = recoveredSnap ? this.repo.getContextManifestBySnapshotId(recoveredSnap.id) : null;
        if (
          recoveredSnap &&
          recoveredMan &&
          recoveredSnap.task_id === transfer.task_id &&
          recoveredSnap.attempt_id === successorAttempt.id &&
          recoveredSnap.purpose === 'HANDOFF' &&
          recoveredMan.id === deterministicManifestId
        ) {
          candidateSnapshot = recoveredSnap;
          candidateManifest = recoveredMan;
          candidateItems = this.repo.getContextItemsBySnapshot(recoveredSnap.id);
        } else {
          return {
            success: false,
            transfer,
            successorAttempt,
            alreadyPrepared: prepRes.alreadyPrepared,
            errorCode: 'CONTEXT_BUILD_FAILED',
            error: `[ContextBuildFailed] Recovered candidate failed integrity validation after collision: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
    }

    // 7. Atomic CAS Pointer Bind
    const bindRes = this.repo.bindHandoffSuccessorContext({
      transferId: transfer.id,
      expectedVersion: transfer.version,
      successorContextSnapshotId: candidateSnapshot.id,
      successorContextSpecHash: specHash,
      boundAt: params.preparedAt,
    });

    if (!bindRes.success) {
      return {
        success: false,
        transfer,
        successorAttempt,
        alreadyPrepared: prepRes.alreadyPrepared,
        errorCode: bindRes.errorCode as any,
        error: bindRes.error,
      };
    }

    return {
      success: true,
      transfer: bindRes.transfer!,
      successorAttempt,
      contextSnapshot: candidateSnapshot,
      contextManifest: candidateManifest!,
      contextItems: candidateItems,
      alreadyPrepared: prepRes.alreadyPrepared,
      alreadyBound: bindRes.alreadyBound,
    };
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
