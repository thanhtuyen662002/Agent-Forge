import crypto from 'crypto';
import { Repository } from '../database/repositories';
import {
  HandoffTransfer,
  HandoffTransferStatus,
  AdapterOutcome,
  ProviderTerminationStatus,
  TaskAttempt,
  AgentAssignment,
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
import {
  RoleAwareRoutingService,
  CandidateAccountResourceRef,
  RoleAwareRoutingDecision,
  RoleAwareRoutingOutcome,
} from './RoleAwareRoutingService';

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

export interface HandoffRouteSpecV1 {
  version: 1;
  transfer_id: string;
  task_id: string;
  successor_attempt_id: string;
  successor_role_profile_id: string;
  successor_agent_profile_id: string;
  successor_context_snapshot_id: string;
  successor_context_spec_hash: string;
  source_assignment_id: string;
  source_provider_id: string;
  cross_provider_required: true;
  route_policy_id: string | null;
  separation_policy_id: string | null;
  caller_candidate_refs_constraint: Array<{ account_id: string; resource_id: string }> | null;
  required_provider_id: string | null;
  required_account_id: string | null;
  required_resource_id: string | null;
  preferred_provider_id: string | null;
  preferred_account_id: string | null;
  preferred_resource_id: string | null;
  effective_excluded_candidate_ids: string[];
  effective_excluded_account_ids: string[];
  effective_excluded_provider_ids: string[];
}

export function validateAndSortStringList(list: unknown, fieldName: string): string[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    throw new Error(`INVALID_ROUTING_REQUEST: ${fieldName} must be an array of strings if provided.`);
  }
  const unique = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'string' || item.trim() === '' || item !== item.trim()) {
      throw new Error(
        `INVALID_ROUTING_REQUEST: ${fieldName} elements must be non-empty canonical strings without surrounding whitespace.`
      );
    }
    unique.add(item);
  }
  return Array.from(unique).sort(codeUnitCompare);
}

export function validateAndCanonicalizeCandidateRefs(
  candidateRefs?: CandidateAccountResourceRef[] | null
): Array<{ account_id: string; resource_id: string }> | null {
  if (!candidateRefs || candidateRefs.length === 0) {
    return null;
  }
  if (!Array.isArray(candidateRefs)) {
    throw new Error('INVALID_ROUTING_REQUEST: candidateRefs must be an array if provided.');
  }
  const seen = new Set<string>();
  const canonicalList: Array<{ account_id: string; resource_id: string }> = [];
  for (const pair of candidateRefs) {
    if (!pair || typeof pair !== 'object') {
      throw new Error('INVALID_ROUTING_REQUEST: Each candidateRef must be an object with accountId and resourceId.');
    }
    const { accountId, resourceId } = pair;
    if (
      typeof accountId !== 'string' ||
      accountId.trim() === '' ||
      accountId !== accountId.trim() ||
      typeof resourceId !== 'string' ||
      resourceId.trim() === '' ||
      resourceId !== resourceId.trim()
    ) {
      throw new Error(
        'INVALID_ROUTING_REQUEST: CandidateRef accountId and resourceId must be non-empty canonical strings without surrounding whitespace.'
      );
    }
    const key = `${accountId}:${resourceId}`;
    if (seen.has(key)) {
      throw new Error(`INVALID_ROUTING_REQUEST: Duplicate candidate reference in request: "${key}".`);
    }
    seen.add(key);
    canonicalList.push({ account_id: accountId, resource_id: resourceId });
  }

  return canonicalList.sort((a, b) => {
    const accCmp = codeUnitCompare(a.account_id, b.account_id);
    if (accCmp !== 0) return accCmp;
    return codeUnitCompare(a.resource_id, b.resource_id);
  });
}

export function validateCanonicalOptionalString(val: unknown, fieldName: string): string | null {
  if (val === undefined || val === null) return null;
  if (typeof val !== 'string') {
    throw new Error(`INVALID_ROUTING_REQUEST: ${fieldName} must be a string if provided.`);
  }
  if (val.trim() === '' || val !== val.trim()) {
    throw new Error(
      `INVALID_ROUTING_REQUEST: ${fieldName} must be a non-empty canonical string without surrounding whitespace.`
    );
  }
  return val;
}

export function buildCanonicalHandoffRouteSpecV1(input: {
  transferId: string;
  taskId: string;
  successorAttemptId: string;
  successorRoleProfileId: string;
  successorAgentProfileId: string;
  successorContextSnapshotId: string;
  successorContextSpecHash: string;
  sourceAssignmentId: string;
  sourceProviderId: string;
  routePolicyId?: string | null;
  separationPolicyId?: string | null;
  candidateRefs?: CandidateAccountResourceRef[] | null;
  requiredProviderId?: string | null;
  requiredAccountId?: string | null;
  requiredResourceId?: string | null;
  preferredProviderId?: string | null;
  preferredAccountId?: string | null;
  preferredResourceId?: string | null;
  excludedCandidateIds?: string[];
  excludedAccountIds?: string[];
  excludedProviderIds?: string[];
}): HandoffRouteSpecV1 {
  const routePolicyId = validateCanonicalOptionalString(input.routePolicyId, 'routePolicyId');
  const separationPolicyId = validateCanonicalOptionalString(input.separationPolicyId, 'separationPolicyId');
  const requiredProviderId = validateCanonicalOptionalString(input.requiredProviderId, 'requiredProviderId');
  const requiredAccountId = validateCanonicalOptionalString(input.requiredAccountId, 'requiredAccountId');
  const requiredResourceId = validateCanonicalOptionalString(input.requiredResourceId, 'requiredResourceId');
  const preferredProviderId = validateCanonicalOptionalString(input.preferredProviderId, 'preferredProviderId');
  const preferredAccountId = validateCanonicalOptionalString(input.preferredAccountId, 'preferredAccountId');
  const preferredResourceId = validateCanonicalOptionalString(input.preferredResourceId, 'preferredResourceId');

  const callerCandidateRefs = validateAndCanonicalizeCandidateRefs(input.candidateRefs);
  const effectiveExcludedCandidates = validateAndSortStringList(input.excludedCandidateIds, 'excludedCandidateIds');
  const effectiveExcludedAccounts = validateAndSortStringList(input.excludedAccountIds, 'excludedAccountIds');

  const callerExcludedProviders = validateAndSortStringList(input.excludedProviderIds, 'excludedProviderIds');
  const effectiveExcludedProvidersSet = new Set(callerExcludedProviders);
  effectiveExcludedProvidersSet.add(input.sourceProviderId);
  const effectiveExcludedProviders = Array.from(effectiveExcludedProvidersSet).sort(codeUnitCompare);

  return {
    version: 1,
    transfer_id: input.transferId,
    task_id: input.taskId,
    successor_attempt_id: input.successorAttemptId,
    successor_role_profile_id: input.successorRoleProfileId,
    successor_agent_profile_id: input.successorAgentProfileId,
    successor_context_snapshot_id: input.successorContextSnapshotId,
    successor_context_spec_hash: input.successorContextSpecHash,
    source_assignment_id: input.sourceAssignmentId,
    source_provider_id: input.sourceProviderId,
    cross_provider_required: true,
    route_policy_id: routePolicyId,
    separation_policy_id: separationPolicyId,
    caller_candidate_refs_constraint: callerCandidateRefs,
    required_provider_id: requiredProviderId,
    required_account_id: requiredAccountId,
    required_resource_id: requiredResourceId,
    preferred_provider_id: preferredProviderId,
    preferred_account_id: preferredAccountId,
    preferred_resource_id: preferredResourceId,
    effective_excluded_candidate_ids: effectiveExcludedCandidates,
    effective_excluded_account_ids: effectiveExcludedAccounts,
    effective_excluded_provider_ids: effectiveExcludedProviders,
  };
}

export interface HandoffRouteSuccessorParams {
  transferId: string;
  expectedVersion: number;
  expectedSuccessorEpoch: number;
  routePolicyId?: string | null;
  separationPolicyId?: string | null;
  candidateRefs?: CandidateAccountResourceRef[];
  requiredProviderId?: string | null;
  requiredAccountId?: string | null;
  requiredResourceId?: string | null;
  preferredProviderId?: string | null;
  preferredAccountId?: string | null;
  preferredResourceId?: string | null;
  excludedCandidateIds?: string[];
  excludedAccountIds?: string[];
  excludedProviderIds?: string[];
  routedAt?: string;
}

export interface HandoffRouteSuccessorResult {
  success: boolean;
  transfer?: HandoffTransfer;
  assignment?: AgentAssignment;
  decision?: RoleAwareRoutingDecision;
  outcome?: RoleAwareRoutingOutcome;
  alreadyRouted?: boolean;
  errorCode?:
    | 'ROUTING_SERVICE_REQUIRED'
    | 'TRANSFER_NOT_FOUND'
    | 'TASK_NOT_FOUND'
    | 'STALE_OWNERSHIP_EPOCH'
    | 'STATUS_CONFLICT'
    | 'VERSION_CONFLICT'
    | 'SUCCESSOR_ROUTE_CONFLICT'
    | 'SOURCE_ASSIGNMENT_NOT_FOUND'
    | 'SOURCE_ASSIGNMENT_STATUS_MISMATCH'
    | 'SOURCE_PROVIDER_MISMATCH'
    | 'CROSS_PROVIDER_VIOLATION'
    | 'SUCCESSOR_NOT_PREPARED'
    | 'SUCCESSOR_ATTEMPT_NOT_FOUND'
    | 'SUCCESSOR_ATTEMPT_STATUS_MISMATCH'
    | 'ROLE_PROFILE_NOT_FOUND'
    | 'ROLE_PROFILE_DISABLED'
    | 'AGENT_PROFILE_NOT_FOUND'
    | 'AGENT_PROFILE_DISABLED'
    | 'AGENT_PROFILE_ROLE_MISMATCH'
    | 'CONTEXT_SNAPSHOT_NOT_FOUND'
    | 'CONTEXT_SNAPSHOT_INTEGRITY_MISMATCH'
    | 'CONTEXT_MANIFEST_NOT_FOUND'
    | 'SUCCESSOR_CONTEXT_SPEC_CONFLICT'
    | 'NO_ELIGIBLE_CANDIDATES'
    | 'NO_ELIGIBLE_PROVIDER'
    | 'MANUAL_HANDOFF_REQUIRED'
    | 'NEEDS_OWNER'
    | 'PROVIDER_NOT_FOUND'
    | 'PROVIDER_DISABLED'
    | 'PROVIDER_ACCOUNT_NOT_FOUND'
    | 'PROVIDER_ACCOUNT_MISMATCH'
    | 'PROVIDER_ACCOUNT_DISABLED'
    | 'PROVIDER_ACCOUNT_UNSAFE_HEALTH'
    | 'PROVIDER_RESOURCE_NOT_FOUND'
    | 'PROVIDER_RESOURCE_MISMATCH'
    | 'PROVIDER_RESOURCE_DISABLED'
    | 'PROVIDER_RESOURCE_UNSAFE_HEALTH'
    | 'PROVIDER_RESOURCE_QUOTA_EXHAUSTED'
    | 'PROVIDER_HEALTH_UNRESOLVED_AUTHORITY'
    | 'ROUTE_METADATA_CORRUPTION'
    | 'INTERNAL_ERROR';
  error?: string;
}

export class HandoffTransferService {
  private contextBuilder: ContextBuilderService;
  private roleAwareRoutingService?: RoleAwareRoutingService;

  constructor(
    private repo: Repository,
    contextBuilderOrRouter?: ContextBuilderService | RoleAwareRoutingService,
    roleAwareRouter?: RoleAwareRoutingService
  ) {
    if (contextBuilderOrRouter instanceof ContextBuilderService) {
      this.contextBuilder = contextBuilderOrRouter;
      this.roleAwareRoutingService = roleAwareRouter;
    } else if (contextBuilderOrRouter && 'routeRole' in contextBuilderOrRouter) {
      this.contextBuilder = new ContextBuilderService(this.repo);
      this.roleAwareRoutingService = contextBuilderOrRouter as RoleAwareRoutingService;
    } else {
      this.contextBuilder = new ContextBuilderService(this.repo);
      this.roleAwareRoutingService = roleAwareRouter;
    }
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

  public async routeHandoffSuccessor(
    params: HandoffRouteSuccessorParams
  ): Promise<HandoffRouteSuccessorResult> {
    if (!this.roleAwareRoutingService) {
      return {
        success: false,
        errorCode: 'ROUTING_SERVICE_REQUIRED',
        error: 'ROUTING_SERVICE_REQUIRED: RoleAwareRoutingService dependency is required to route handoff successor.',
      };
    }

    // 1. Initial read & validation of HandoffTransfer
    const transfer = this.repo.getHandoffTransfer(params.transferId);
    if (!transfer) {
      return {
        success: false,
        errorCode: 'TRANSFER_NOT_FOUND',
        error: `Handoff transfer "${params.transferId}" not found.`,
      };
    }

    // 2. Validate source assignment & derive source provider
    const sourceAsgn = this.repo.getAgentAssignment(transfer.source_assignment_id);
    if (
      !sourceAsgn ||
      sourceAsgn.task_id !== transfer.task_id ||
      sourceAsgn.attempt_id !== transfer.source_attempt_id
    ) {
      return {
        success: false,
        transfer,
        errorCode: 'SOURCE_ASSIGNMENT_NOT_FOUND',
        error: `SOURCE_ASSIGNMENT_NOT_FOUND: Source assignment "${transfer.source_assignment_id}" not found or does not match task/attempt.`,
      };
    }

    if (sourceAsgn.status !== 'HANDED_OFF') {
      return {
        success: false,
        transfer,
        errorCode: 'SOURCE_ASSIGNMENT_STATUS_MISMATCH',
        error: `SOURCE_ASSIGNMENT_STATUS_MISMATCH: Source assignment "${sourceAsgn.id}" status is "${sourceAsgn.status}", expected "HANDED_OFF".`,
      };
    }

    const sourceProviderId = sourceAsgn.selected_provider_id;

    // 3. Ensure successor attributes are prepared
    if (
      !transfer.successor_attempt_id ||
      !transfer.successor_role_profile_id ||
      !transfer.successor_agent_profile_id ||
      !transfer.successor_context_snapshot_id ||
      !transfer.successor_context_spec_hash
    ) {
      return {
        success: false,
        transfer,
        errorCode: 'SUCCESSOR_NOT_PREPARED',
        error: `SUCCESSOR_NOT_PREPARED: Transfer "${params.transferId}" has incomplete successor preparation fields.`,
      };
    }

    // 4. Construct canonical route spec & hash
    let canonicalSpec: HandoffRouteSpecV1;
    try {
      canonicalSpec = buildCanonicalHandoffRouteSpecV1({
        transferId: transfer.id,
        taskId: transfer.task_id,
        successorAttemptId: transfer.successor_attempt_id,
        successorRoleProfileId: transfer.successor_role_profile_id,
        successorAgentProfileId: transfer.successor_agent_profile_id,
        successorContextSnapshotId: transfer.successor_context_snapshot_id,
        successorContextSpecHash: transfer.successor_context_spec_hash,
        sourceAssignmentId: transfer.source_assignment_id,
        sourceProviderId,
        routePolicyId: params.routePolicyId,
        separationPolicyId: params.separationPolicyId,
        candidateRefs: params.candidateRefs,
        requiredProviderId: params.requiredProviderId,
        requiredAccountId: params.requiredAccountId,
        requiredResourceId: params.requiredResourceId,
        preferredProviderId: params.preferredProviderId,
        preferredAccountId: params.preferredAccountId,
        preferredResourceId: params.preferredResourceId,
        excludedCandidateIds: params.excludedCandidateIds,
        excludedAccountIds: params.excludedAccountIds,
        excludedProviderIds: params.excludedProviderIds,
      });
    } catch (err: any) {
      return {
        success: false,
        transfer,
        errorCode: 'NO_ELIGIBLE_CANDIDATES',
        error: err.message,
      };
    }

    const routeSpecHash = computeSha256(canonicalJsonStringify(canonicalSpec));

    // 5. ALREADY-ROUTED Replay Check (DO NOT call routeRole if already ROUTED)
    if (transfer.status === 'ROUTED') {
      const replayRes = this.repo.bindHandoffSuccessorRoute({
        transferId: transfer.id,
        expectedVersion: params.expectedVersion,
        expectedSuccessorEpoch: params.expectedSuccessorEpoch,
        sourceAssignmentId: transfer.source_assignment_id,
        sourceProviderId,
        successorAttemptId: transfer.successor_attempt_id,
        successorRoleProfileId: transfer.successor_role_profile_id,
        successorAgentProfileId: transfer.successor_agent_profile_id,
        successorContextSnapshotId: transfer.successor_context_snapshot_id,
        successorContextSpecHash: transfer.successor_context_spec_hash,
        selectedProviderId: '',
        selectedAccountId: '',
        selectedResourceId: '',
        routingDecisionId: '',
        routeSpecHash,
        canonicalRouteSpec: canonicalSpec as unknown as Record<string, unknown>,
        nowIso: params.routedAt,
      });

      if (!replayRes.success) {
        return {
          success: false,
          transfer: replayRes.transfer ?? transfer,
          errorCode: replayRes.errorCode as any,
          error: replayRes.error,
        };
      }

      return {
        success: true,
        transfer: replayRes.transfer!,
        assignment: replayRes.assignment!,
        alreadyRouted: true,
      };
    }

    // 6. Pre-Phase-A Status and Version CAS check
    if (transfer.status !== 'SUCCESSOR_PREPARED') {
      return {
        success: false,
        transfer,
        errorCode: 'STATUS_CONFLICT',
        error: `STATUS_CONFLICT: Expected transfer status SUCCESSOR_PREPARED, found "${transfer.status}".`,
      };
    }

    if (transfer.version !== params.expectedVersion) {
      return {
        success: false,
        transfer,
        errorCode: 'VERSION_CONFLICT',
        error: `VERSION_CONFLICT: Expected transfer version ${params.expectedVersion}, found ${transfer.version}.`,
      };
    }

    if (transfer.successor_ownership_epoch !== params.expectedSuccessorEpoch) {
      return {
        success: false,
        transfer,
        errorCode: 'STALE_OWNERSHIP_EPOCH',
        error: `STALE_OWNERSHIP_EPOCH: Expected successor epoch ${params.expectedSuccessorEpoch}, found ${transfer.successor_ownership_epoch}.`,
      };
    }

    const task = this.repo.getTask(transfer.task_id);
    if (!task) {
      return {
        success: false,
        transfer,
        errorCode: 'TASK_NOT_FOUND',
        error: `Task "${transfer.task_id}" not found.`,
      };
    }

    if (task.ownership_epoch !== params.expectedSuccessorEpoch) {
      return {
        success: false,
        transfer,
        errorCode: 'STALE_OWNERSHIP_EPOCH',
        error: `STALE_OWNERSHIP_EPOCH: Task current epoch is ${task.ownership_epoch}, expected ${params.expectedSuccessorEpoch}.`,
      };
    }

    // Successor TaskAttempt check
    const succAttempt = this.repo.getTaskAttempt(transfer.successor_attempt_id);
    if (!succAttempt || succAttempt.task_id !== transfer.task_id) {
      return {
        success: false,
        transfer,
        errorCode: 'SUCCESSOR_ATTEMPT_NOT_FOUND',
        error: `SUCCESSOR_ATTEMPT_NOT_FOUND: Successor attempt "${transfer.successor_attempt_id}" not found.`,
      };
    }

    if (succAttempt.status !== 'PENDING' || succAttempt.agent_id !== null) {
      return {
        success: false,
        transfer,
        errorCode: 'SUCCESSOR_ATTEMPT_STATUS_MISMATCH',
        error: `SUCCESSOR_ATTEMPT_STATUS_MISMATCH: Successor attempt status is "${succAttempt.status}", agent_id is "${succAttempt.agent_id}", expected "PENDING" and NULL agent_id.`,
      };
    }

    // Role and Agent profile checks
    const roleProfile = this.repo.getRoleProfile(transfer.successor_role_profile_id);
    if (!roleProfile) {
      return {
        success: false,
        transfer,
        errorCode: 'ROLE_PROFILE_NOT_FOUND',
        error: `ROLE_PROFILE_NOT_FOUND: Successor role profile "${transfer.successor_role_profile_id}" not found.`,
      };
    }
    if (!roleProfile.enabled) {
      return {
        success: false,
        transfer,
        errorCode: 'ROLE_PROFILE_DISABLED',
        error: `ROLE_PROFILE_DISABLED: Successor role profile "${transfer.successor_role_profile_id}" is disabled.`,
      };
    }

    const agentProfile = this.repo.getAgentProfile(transfer.successor_agent_profile_id);
    if (!agentProfile) {
      return {
        success: false,
        transfer,
        errorCode: 'AGENT_PROFILE_NOT_FOUND',
        error: `AGENT_PROFILE_NOT_FOUND: Successor agent profile "${transfer.successor_agent_profile_id}" not found.`,
      };
    }
    if (!agentProfile.enabled) {
      return {
        success: false,
        transfer,
        errorCode: 'AGENT_PROFILE_DISABLED',
        error: `AGENT_PROFILE_DISABLED: Successor agent profile "${transfer.successor_agent_profile_id}" is disabled.`,
      };
    }
    if (agentProfile.role_profile_id !== transfer.successor_role_profile_id) {
      return {
        success: false,
        transfer,
        errorCode: 'AGENT_PROFILE_ROLE_MISMATCH',
        error: `AGENT_PROFILE_ROLE_MISMATCH: Agent profile role_profile_id "${agentProfile.role_profile_id}" does not match "${transfer.successor_role_profile_id}".`,
      };
    }

    // Successor context integrity check
    const snapshot = this.repo.getContextSnapshot(transfer.successor_context_snapshot_id);
    if (!snapshot) {
      return {
        success: false,
        transfer,
        errorCode: 'CONTEXT_SNAPSHOT_NOT_FOUND',
        error: `CONTEXT_SNAPSHOT_NOT_FOUND: Bound ContextSnapshot "${transfer.successor_context_snapshot_id}" not found.`,
      };
    }
    if (
      snapshot.task_id !== transfer.task_id ||
      snapshot.attempt_id !== transfer.successor_attempt_id ||
      snapshot.purpose !== 'HANDOFF'
    ) {
      return {
        success: false,
        transfer,
        errorCode: 'CONTEXT_SNAPSHOT_INTEGRITY_MISMATCH',
        error: `CONTEXT_SNAPSHOT_INTEGRITY_MISMATCH: ContextSnapshot "${snapshot.id}" does not match transfer task/attempt/purpose.`,
      };
    }
    const manifest = this.repo.getContextManifestBySnapshotId(snapshot.id);
    if (!manifest) {
      return {
        success: false,
        transfer,
        errorCode: 'CONTEXT_MANIFEST_NOT_FOUND',
        error: `CONTEXT_MANIFEST_NOT_FOUND: ContextManifest for snapshot "${snapshot.id}" not found.`,
      };
    }

    // 7. Construct Structurally Assignable Candidate Pool
    const allAccounts = this.repo.getAllProviderAccounts().filter((a) => a.enabled);
    const allResources = this.repo.getAllProviderResources().filter((r) => r.enabled);
    const structuralPairs: CandidateAccountResourceRef[] = [];
    for (const acc of allAccounts) {
      const matching = allResources.filter(
        (r) => r.provider_id === acc.provider_id && r.provider_account_id === acc.id
      );
      for (const res of matching) {
        structuralPairs.push({
          accountId: acc.id,
          resourceId: res.id,
        });
      }
    }

    let candidateRefsForRouting: CandidateAccountResourceRef[];
    if (params.candidateRefs && params.candidateRefs.length > 0) {
      const filtered = params.candidateRefs.filter((pair) =>
        structuralPairs.some((sp) => sp.accountId === pair.accountId && sp.resourceId === pair.resourceId)
      );
      if (filtered.length === 0) {
        return {
          success: false,
          transfer,
          outcome: 'NO_ELIGIBLE_PROVIDER',
          errorCode: 'NO_ELIGIBLE_CANDIDATES',
          error: 'No structurally assignable candidate pairs match the requested candidate constraints.',
        };
      }
      candidateRefsForRouting = filtered;
    } else {
      if (structuralPairs.length === 0) {
        return {
          success: false,
          transfer,
          outcome: 'NO_ELIGIBLE_PROVIDER',
          errorCode: 'NO_ELIGIBLE_CANDIDATES',
          error: 'No structurally assignable provider account/resource pairs exist in the database.',
        };
      }
      candidateRefsForRouting = structuralPairs;
    }

    // 8. Phase A: Role-Aware Routing (persistAssignment: false)
    const decision = await this.roleAwareRoutingService.routeRole({
      projectId: task.project_id,
      taskId: transfer.task_id,
      attemptId: transfer.successor_attempt_id,
      roleProfileId: transfer.successor_role_profile_id,
      agentProfileId: transfer.successor_agent_profile_id,
      routePolicyId: params.routePolicyId ?? null,
      separationPolicyId: params.separationPolicyId ?? null,
      reviewedAssignmentId: params.separationPolicyId ? transfer.source_assignment_id : null,
      candidateRefs: candidateRefsForRouting,
      allowManualBridge: false,
      requiredProviderId: params.requiredProviderId ?? null,
      requiredAccountId: params.requiredAccountId ?? null,
      requiredResourceId: params.requiredResourceId ?? null,
      preferredProviderId: params.preferredProviderId ?? null,
      preferredAccountId: params.preferredAccountId ?? null,
      preferredResourceId: params.preferredResourceId ?? null,
      persistAssignment: false,
      excludedCandidateIds: canonicalSpec.effective_excluded_candidate_ids,
      excludedAccountIds: canonicalSpec.effective_excluded_account_ids,
      excludedProviderIds: canonicalSpec.effective_excluded_provider_ids, // includes sourceProviderId
    });

    if (decision.outcome !== 'SELECTED') {
      return {
        success: false,
        transfer,
        decision,
        outcome: decision.outcome,
        errorCode: decision.outcome as any,
        error: decision.reason,
      };
    }

    if (!decision.selectedProviderId || !decision.selectedAccountId || !decision.selectedResourceId) {
      return {
        success: false,
        transfer,
        decision,
        outcome: decision.outcome,
        errorCode: 'NO_ELIGIBLE_PROVIDER',
        error: 'Routing decision SELECTED but missing provider/account/resource selections.',
      };
    }

    // 9. Phase B: Atomic Linearization in Repository
    const bindRes = this.repo.bindHandoffSuccessorRoute({
      transferId: transfer.id,
      expectedVersion: params.expectedVersion,
      expectedSuccessorEpoch: params.expectedSuccessorEpoch,
      sourceAssignmentId: transfer.source_assignment_id,
      sourceProviderId,
      successorAttemptId: transfer.successor_attempt_id,
      successorRoleProfileId: transfer.successor_role_profile_id,
      successorAgentProfileId: transfer.successor_agent_profile_id,
      successorContextSnapshotId: transfer.successor_context_snapshot_id,
      successorContextSpecHash: transfer.successor_context_spec_hash,
      selectedProviderId: decision.selectedProviderId,
      selectedAccountId: decision.selectedAccountId,
      selectedResourceId: decision.selectedResourceId,
      routingDecisionId: decision.decisionId,
      routeSpecHash,
      canonicalRouteSpec: canonicalSpec as unknown as Record<string, unknown>,
      nowIso: params.routedAt,
    });

    if (!bindRes.success) {
      return {
        success: false,
        transfer: bindRes.transfer ?? transfer,
        decision,
        outcome: decision.outcome,
        errorCode: bindRes.errorCode as any,
        error: bindRes.error,
      };
    }

    return {
      success: true,
      transfer: bindRes.transfer!,
      assignment: bindRes.assignment!,
      decision,
      outcome: decision.outcome,
      alreadyRouted: bindRes.alreadyRouted ?? false,
    };
  }
}
