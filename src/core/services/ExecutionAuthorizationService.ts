import crypto from 'crypto';
import path from 'path';
import { z } from 'zod';
import { Repository } from '../database/repositories';
import { EventService } from './EventService';
import { PolicyService } from './PolicyService';
import { GitService } from './GitService';
import { ProtocolParser } from '../protocol/parser';
import {
  ExecutionAuthorization,
  TaskState,
} from '../types/domain';
import { ManagerProtocol } from '../types/protocols';
import { sanitizeContextFiles, verifyContextManifestIntegrity } from '../context/ContextIntegrity';
import { canonicalJsonStringify } from './ContextBuilderService';

export interface CreateAuthorizationParams {
  projectId: string;
  taskId: string;
  attemptId?: string | null;
  routingDecisionId: string;
  contextFiles?: string[];
  contextManifestId?: string | null;
  assignmentId?: string | null;
  taskOwnershipEpoch?: number;
}

export interface HandoffSuccessorExecutionAuthorityV1 {
  version: 1;
  transfer_id: string;
  successor_attempt_id: string;
  successor_assignment_id: string;
  successor_ownership_epoch: number;
  routing_decision_id: string;
  handoff_route_spec_hash: string;
  successor_context_spec_hash: string;
  manager_message_id: string;
  manager_payload_hash: string;
}

export function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function computeHandoffAuthorizationId(authority: HandoffSuccessorExecutionAuthorityV1): string {
  const canonicalSpec: Record<string, unknown> = {
    version: 1,
    transfer_id: authority.transfer_id,
    successor_attempt_id: authority.successor_attempt_id,
    successor_assignment_id: authority.successor_assignment_id,
    successor_ownership_epoch: authority.successor_ownership_epoch,
    routing_decision_id: authority.routing_decision_id,
    handoff_route_spec_hash: authority.handoff_route_spec_hash,
    successor_context_spec_hash: authority.successor_context_spec_hash,
    manager_message_id: authority.manager_message_id,
    manager_payload_hash: authority.manager_payload_hash,
  };
  const serialized = canonicalJsonStringify(canonicalSpec);
  return 'auth-handoff-' + crypto.createHash('sha256').update(serialized, 'utf8').digest('hex').slice(0, 32);
}

export interface HandoffContextExecutionItemV1 {
  ordinal: number;
  item_type: string;
  source_type: string;
  source_ref: string | null;
  content_json: string;
  content_hash: string;
  token_estimate: number | null;
}

export interface HandoffContextExecutionDescriptorV1 {
  version: 1;
  snapshot_id: string;
  snapshot_content_hash: string;
  manifest_id: string;
  manifest_hash: string;
  items: HandoffContextExecutionItemV1[];
}

export function buildHandoffContextExecutionDescriptorV1(params: {
  snapshotId: string;
  snapshotContentHash: string;
  manifestId: string;
  manifestHash: string;
  items: HandoffContextExecutionItemV1[];
}): HandoffContextExecutionDescriptorV1 {
  return {
    version: 1,
    snapshot_id: params.snapshotId,
    snapshot_content_hash: params.snapshotContentHash,
    manifest_id: params.manifestId,
    manifest_hash: params.manifestHash,
    items: [...params.items].sort((a, b) => a.ordinal - b.ordinal),
  };
}

export type PrepareHandoffSuccessorAuthorizationErrorCode =
  | 'TRANSFER_NOT_FOUND'
  | 'TRANSFER_STATUS_NOT_ROUTED'
  | 'TASK_NOT_FOUND'
  | 'PROJECT_NOT_FOUND'
  | 'ASSIGNMENT_NOT_FOUND'
  | 'ATTEMPT_NOT_FOUND'
  | 'STALE_OWNERSHIP_EPOCH'
  | 'MANAGER_AUTHORITY_MISSING'
  | 'MANAGER_AUTHORITY_INVALID'
  | 'MANAGER_DECISION_NON_AUTHORIZING'
  | 'STALE_TASK_REVISION'
  | 'BASE_SHA_MISSING'
  | 'GIT_HEAD_FAILED'
  | 'ROUTING_DECISION_NOT_FOUND'
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_DISABLED'
  | 'PROVIDER_ACCOUNT_NOT_FOUND'
  | 'PROVIDER_ACCOUNT_DISABLED'
  | 'PROVIDER_ACCOUNT_UNSAFE_HEALTH'
  | 'PROVIDER_RESOURCE_NOT_FOUND'
  | 'PROVIDER_RESOURCE_DISABLED'
  | 'PROVIDER_RESOURCE_UNSAFE_HEALTH'
  | 'PROVIDER_RESOURCE_QUOTA_EXHAUSTED'
  | 'CONTEXT_SNAPSHOT_NOT_FOUND'
  | 'CONTEXT_MANIFEST_NOT_FOUND'
  | 'CONTEXT_MANIFEST_INTEGRITY_FAILED'
  | 'CONTEXT_FILES_INVALID'
  | 'POLICY_DENIED'
  | 'NEEDS_OWNER'
  | 'PROVIDER_HEALTH_UNSAFE'
  | 'ROUTE_METADATA_CORRUPT'
  | 'STATUS_CONFLICT'
  | 'INTERNAL_ERROR';

export interface PrepareHandoffSuccessorAuthorizationParams {
  transferId: string;
}

export interface PrepareHandoffSuccessorAuthorizationResult {
  success: boolean;
  candidate?: ExecutionAuthorization;
  authority?: HandoffSuccessorExecutionAuthorityV1;
  errorCode?: PrepareHandoffSuccessorAuthorizationErrorCode;
  error?: string;
}

// =========================================================================
// CREATION MAY CANONICALIZE, VALIDATION MUST NOT NORMALIZE
// During authorization creation, durable project inputs may be canonicalized once.
// Once persisted, frozen canonical payload validation schemas must perform
// strictly non-transforming verification (no .trim(), .toLowerCase(), or .transform()).
// =========================================================================

export const CanonicalExecutableSchema = z
  .string()
  .min(1)
  .refine((val) => val === val.trim(), {
    message: 'Executable must already be canonical without surrounding whitespace.',
  });

export const VerificationCommandSnapshotSchema = z
  .object({
    executable: CanonicalExecutableSchema,
    args: z.array(z.string()),
  })
  .strict();

export type VerificationCommandSnapshot = z.infer<typeof VerificationCommandSnapshotSchema>;

export const VerificationCommandsSnapshotSchema = z
  .object({
    TEST: VerificationCommandSnapshotSchema.nullable(),
    LINT: VerificationCommandSnapshotSchema.nullable(),
    BUILD: VerificationCommandSnapshotSchema.nullable(),
  })
  .strict();

export type VerificationCommandsSnapshot = z.infer<typeof VerificationCommandsSnapshotSchema>;

export const CanonicalExecutionPayloadSchema = z
  .object({
    projectId: z.string().min(1),
    taskId: z.string().min(1),
    attemptId: z.string().nullable(),
    taskTitle: z.string().min(1),
    taskDescription: z.string().nullable(),
    acceptanceCriteria: z.array(z.string()),
    constraints: z.array(z.string()),
    instructions: z.array(z.string()),
    contextFiles: z.array(z.string()),
    verificationCommands: VerificationCommandsSnapshotSchema,
    managerMessageId: z.string().min(1),
    managerPayloadHash: z.string().min(1),
  })
  .strict();

export type CanonicalExecutionPayload = z.infer<typeof CanonicalExecutionPayloadSchema>;

export function buildVerificationCommandsSnapshot(
  commands: Array<{ command_type: string; executable: string; args: string[]; enabled?: boolean }>
): VerificationCommandsSnapshot {
  const getCmd = (type: 'TEST' | 'LINT' | 'BUILD'): VerificationCommandSnapshot | null => {
    const cmd = commands.find((c) => c.command_type === type && (c.enabled === undefined || c.enabled));
    if (!cmd || !cmd.executable || cmd.executable.trim().length === 0) {
      return null;
    }
    return {
      // Creation-time canonicalization: trim executable once before storing in payload
      executable: cmd.executable.trim(),
      args: [...cmd.args],
    };
  };

  return {
    TEST: getCmd('TEST'),
    LINT: getCmd('LINT'),
    BUILD: getCmd('BUILD'),
  };
}

export function buildCanonicalInstructions(
  task: {
    title: string;
    description: string | null;
    acceptance_criteria?: string[];
    constraints?: string[];
  },
  managerData: ManagerProtocol
): string[] {
  const lines: string[] = [];
  lines.push(`Task: ${task.title}`);
  if (task.description) {
    lines.push(`Description: ${task.description}`);
  }
  if (task.acceptance_criteria && task.acceptance_criteria.length > 0) {
    lines.push('Acceptance Criteria:');
    for (const ac of task.acceptance_criteria) {
      lines.push(`- ${ac}`);
    }
  }
  if (managerData.instructions && managerData.instructions.length > 0) {
    lines.push(`Manager Instructions (${managerData.decision}):`);
    for (const inst of managerData.instructions) {
      lines.push(`- ${inst}`);
    }
  }
  return lines;
}

export function computeCanonicalPayload(params: {
  projectId: string;
  taskId: string;
  attemptId: string | null;
  taskTitle: string;
  taskDescription: string | null;
  acceptanceCriteria: string[];
  constraints: string[];
  instructions: string[];
  contextFiles: string[];
  verificationCommands: VerificationCommandsSnapshot;
  managerMessageId: string;
  managerPayloadHash: string;
}): CanonicalExecutionPayload {
  return {
    projectId: params.projectId,
    taskId: params.taskId,
    attemptId: params.attemptId,
    taskTitle: params.taskTitle,
    taskDescription: params.taskDescription,
    acceptanceCriteria: [...params.acceptanceCriteria],
    constraints: [...params.constraints],
    instructions: [...params.instructions],
    contextFiles: [...params.contextFiles],
    verificationCommands: {
      TEST: params.verificationCommands.TEST
        ? { executable: params.verificationCommands.TEST.executable, args: [...params.verificationCommands.TEST.args] }
        : null,
      LINT: params.verificationCommands.LINT
        ? { executable: params.verificationCommands.LINT.executable, args: [...params.verificationCommands.LINT.args] }
        : null,
      BUILD: params.verificationCommands.BUILD
        ? { executable: params.verificationCommands.BUILD.executable, args: [...params.verificationCommands.BUILD.args] }
        : null,
    },
    managerMessageId: params.managerMessageId,
    managerPayloadHash: params.managerPayloadHash,
  };
}

export function computePayloadHash(payload: CanonicalExecutionPayload): string {
  const serialized = JSON.stringify({
    acceptanceCriteria: payload.acceptanceCriteria,
    attemptId: payload.attemptId,
    constraints: payload.constraints,
    contextFiles: payload.contextFiles,
    instructions: payload.instructions,
    managerMessageId: payload.managerMessageId,
    managerPayloadHash: payload.managerPayloadHash,
    projectId: payload.projectId,
    taskDescription: payload.taskDescription,
    taskId: payload.taskId,
    taskTitle: payload.taskTitle,
    verificationCommands: payload.verificationCommands,
  });
  return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
}

export function computeContextManifestHash(contextFiles: string[]): string {
  const serialized = JSON.stringify([...contextFiles].sort());
  return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
}

export { sanitizeContextFiles } from '../context/ContextIntegrity';

export class ExecutionAuthorizationService {
  constructor(
    private repo: Repository,
    private eventService?: EventService
  ) {}

  /**
   * Creates an immutable, durable ExecutionAuthorization bound to Manager protocol authority,
   * actual Git repository HEAD, and a valid RoutingDecision.
   */
  public async createAuthorization(params: CreateAuthorizationParams): Promise<ExecutionAuthorization> {
    const authorizationId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const normalizedAttemptId = params.attemptId ?? null;

    // 1. Validate Scope: Project, Task, Attempt
    const project = this.repo.getProject(params.projectId);
    if (!project) {
      this.recordRejectionEvent(params, `Project "${params.projectId}" not found in database.`);
      throw new Error(`EXECUTION_AUTHORIZATION_FAILED: Project "${params.projectId}" not found.`);
    }

    const task = this.repo.getTask(params.taskId);
    if (!task) {
      this.recordRejectionEvent(params, `Task "${params.taskId}" not found in database.`);
      throw new Error(`EXECUTION_AUTHORIZATION_FAILED: Task "${params.taskId}" not found.`);
    }

    if (task.project_id !== params.projectId) {
      this.recordRejectionEvent(
        params,
        `Task "${params.taskId}" does not belong to project "${params.projectId}".`
      );
      throw new Error(
        `EXECUTION_AUTHORIZATION_FAILED: Task "${params.taskId}" does not belong to project "${params.projectId}".`
      );
    }

    if (params.attemptId) {
      const attempt = this.repo.getTaskAttempt(params.attemptId);
      if (!attempt || attempt.task_id !== params.taskId) {
        this.recordRejectionEvent(
          params,
          `TaskAttempt "${params.attemptId}" not found or does not belong to task "${params.taskId}".`
        );
        throw new Error(
          `EXECUTION_AUTHORIZATION_FAILED: TaskAttempt "${params.attemptId}" does not belong to task "${params.taskId}".`
        );
      }
    }

    // 2. Validate Manager Protocol Authority from SQLite ledger
    const latestManagerMsg = this.repo.getLatestAppliedManagerProtocolMessage(params.taskId, params.projectId);
    if (!latestManagerMsg) {
      const reason = `EXECUTION_AUTHORIZATION_MANAGER_AUTHORITY_MISSING: No applied manager.v1 protocol message found for task "${params.taskId}".`;
      this.recordRejectionEvent(params, reason);
      throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${reason}`);
    }

    const parseResult = ProtocolParser.parse(String(latestManagerMsg.raw_payload));
    if (!parseResult.success || !parseResult.data || parseResult.data.type !== 'manager.v1') {
      const reason = `EXECUTION_AUTHORIZATION_MANAGER_AUTHORITY_INVALID: Could not parse applied manager protocol message (${parseResult.error || 'schema invalid'}).`;
      this.recordRejectionEvent(params, reason);
      throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${reason}`);
    }

    const managerData = parseResult.data.data;
    if (managerData.decision !== 'EXECUTE' && managerData.decision !== 'FIX_REQUIRED') {
      const reason = `EXECUTION_AUTHORIZATION_MANAGER_DECISION_NON_AUTHORIZING: Manager decision "${managerData.decision}" does not authorize execution.`;
      this.recordRejectionEvent(params, reason);
      throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${reason}`);
    }

    // Manager revision binding validation
    if (managerData.decision === 'EXECUTE') {
      if (
        managerData.expected_revision !== null &&
        managerData.expected_revision !== undefined &&
        managerData.expected_revision !== task.revision_count
      ) {
        const reason = `EXECUTION_AUTHORIZATION_STALE_TASK_REVISION: Manager EXECUTE expected revision ${managerData.expected_revision}, but task revision is ${task.revision_count}.`;
        this.recordRejectionEvent(params, reason);
        throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${reason}`);
      }
    } else if (managerData.decision === 'FIX_REQUIRED') {
      // For FIX_REQUIRED, Manager decision was applied against the pre-fix revision and enters fix coding cycle, incrementing task revision.
      // Therefore, manager.expected_revision + 1 must strictly equal task.revision_count.
      if (
        managerData.expected_revision !== null &&
        managerData.expected_revision !== undefined &&
        managerData.expected_revision + 1 !== task.revision_count
      ) {
        const reason = `EXECUTION_AUTHORIZATION_STALE_TASK_REVISION: Manager FIX_REQUIRED expected revision ${managerData.expected_revision}, which does not match task coding revision ${task.revision_count} (expected manager.expected_revision + 1 == task.revision_count).`;
        this.recordRejectionEvent(params, reason);
        throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${reason}`);
      }
    }

    const managerMessageId = String(latestManagerMsg.id);
    const managerPayloadHash = String(latestManagerMsg.payload_hash);

    // 3. Validate Durable Routing Decision Binding
    const routingEvent = this.repo.getRoutingDecisionEvent(params.routingDecisionId);
    if (!routingEvent) {
      const reason = `Routing decision "${params.routingDecisionId}" not found in database.`;
      this.recordRejectionEvent(params, reason);
      throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${reason}`);
    }

    const routingPayload = routingEvent.structured_payload as Record<string, unknown>;
    if (routingPayload.projectId !== params.projectId) {
      const reason = `Routing decision project mismatch (decision: "${routingPayload.projectId}", authorization: "${params.projectId}").`;
      this.recordRejectionEvent(params, reason);
      throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${reason}`);
    }

    if (routingPayload.taskId !== params.taskId) {
      const reason = `Routing decision task mismatch (decision: "${routingPayload.taskId}", authorization: "${params.taskId}").`;
      this.recordRejectionEvent(params, reason);
      throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${reason}`);
    }

    const routingAttempt = (routingPayload.attemptId as string | null | undefined) ?? null;
    if (routingAttempt !== normalizedAttemptId) {
      const reason = `Routing decision attempt mismatch (decision: "${routingAttempt}", authorization: "${normalizedAttemptId}").`;
      this.recordRejectionEvent(params, reason);
      throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${reason}`);
    }

    const routingOutcome = routingPayload.outcome as string;
    if (routingOutcome !== 'SELECTED' && routingOutcome !== 'MANUAL_HANDOFF_REQUIRED') {
      const reason = `Routing outcome "${routingOutcome}" cannot produce execution authorization (${routingPayload.reason ?? 'ineligible'}).`;
      this.recordRejectionEvent(params, reason);
      throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${reason}`);
    }

    const selectedResourceId = routingPayload.selectedResourceId as string | undefined;
    const selectedProviderId = routingPayload.selectedProviderId as string | undefined;
    if (!selectedResourceId || !selectedProviderId) {
      const reason = 'Routing decision missing selectedResourceId or selectedProviderId.';
      this.recordRejectionEvent(params, reason);
      throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${reason}`);
    }

    // 4. Validate Task State Gate
    if (routingOutcome === 'SELECTED') {
      if (task.state !== 'CODING') {
        const reason = `EXECUTION_AUTHORIZATION_TASK_STATE_INCOMPATIBLE: Task "${params.taskId}" in state "${task.state}" cannot authorize automated provider execution (must be in CODING).`;
        this.recordRejectionEvent(params, reason);
        throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${reason}`);
      }
    } else if (routingOutcome === 'MANUAL_HANDOFF_REQUIRED') {
      if (task.state !== 'CODING' && task.state !== 'HANDOFF_REQUIRED') {
        const reason = `EXECUTION_AUTHORIZATION_TASK_STATE_INCOMPATIBLE: Task "${params.taskId}" in state "${task.state}" cannot authorize manual bridge execution (must be in CODING or HANDOFF_REQUIRED).`;
        this.recordRejectionEvent(params, reason);
        throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${reason}`);
      }
    }

    // 5. Validate Provider and Resource Enablement
    const resource = this.repo.getProviderResource(selectedResourceId);
    if (!resource || !resource.enabled) {
      const reason = `Selected ProviderResource "${selectedResourceId}" is missing or disabled.`;
      this.recordRejectionEvent(params, reason);
      throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${reason}`);
    }

    const provider = this.repo.getProvider(resource.provider_id);
    if (!provider || !provider.enabled) {
      const reason = `Selected Provider "${resource.provider_id}" is missing or disabled.`;
      this.recordRejectionEvent(params, reason);
      throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${reason}`);
    }

    if (resource.provider_id !== selectedProviderId) {
      const reason = `ProviderResource provider_id "${resource.provider_id}" does not match selectedProviderId "${selectedProviderId}".`;
      this.recordRejectionEvent(params, reason);
      throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${reason}`);
    }

    // 6. Base SHA and Real Git Repository HEAD Authority
    if (!task.base_sha || task.base_sha.trim() === '') {
      const reason = `EXECUTION_AUTHORIZATION_BASE_SHA_MISSING: Task "${params.taskId}" is missing durable base_sha.`;
      this.recordRejectionEvent(params, reason);
      throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${reason}`);
    }
    const baseSha = task.base_sha.trim();

    const gitHeadResult = await GitService.getHeadSha(project.repository_path);
    if (gitHeadResult.status !== 'SUCCESS' || !gitHeadResult.sha) {
      const reason = `EXECUTION_AUTHORIZATION_GIT_HEAD_FAILED: Could not resolve current Git HEAD for repository "${project.repository_path}" (${gitHeadResult.errorMessage || 'git error'}).`;
      this.recordRejectionEvent(params, reason);
      throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${reason}`);
    }
    const repositoryHeadSha = gitHeadResult.sha;

    // 7. Context File Manifest Validation & Canonicalization (with R5B Durable ContextManifest support)
    const sanitizeResult = sanitizeContextFiles(params.contextFiles, project.repository_path);
    if (sanitizeResult.error) {
      this.recordRejectionEvent(params, sanitizeResult.error);
      throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${sanitizeResult.error}`);
    }
    const canonicalContextFiles = sanitizeResult.validFiles;

    let contextManifestHash = computeContextManifestHash(canonicalContextFiles);

    if (params.contextManifestId) {
      const integrityResult = verifyContextManifestIntegrity(this.repo, params.contextManifestId);
      if (!integrityResult.valid) {
        const reason = `EXECUTION_AUTHORIZATION_MANIFEST_INTEGRITY_FAILED: ${integrityResult.error}`;
        this.recordRejectionEvent(params, reason);
        throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${reason}`);
      }

      const durableManifest = integrityResult.manifest!;
      const snapshot = integrityResult.snapshot!;

      if (snapshot.project_id !== params.projectId || snapshot.task_id !== params.taskId) {
        const reason = `EXECUTION_AUTHORIZATION_MANIFEST_MISMATCH: ContextManifest "${params.contextManifestId}" belongs to project "${snapshot.project_id}" / task "${snapshot.task_id}", expected project "${params.projectId}" / task "${params.taskId}".`;
        this.recordRejectionEvent(params, reason);
        throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${reason}`);
      }

      const snapshotAttempt = snapshot.attempt_id ?? null;
      const authAttempt = normalizedAttemptId ?? null;
      if (snapshotAttempt !== authAttempt) {
        const reason = `EXECUTION_AUTHORIZATION_MANIFEST_MISMATCH: ContextManifest "${params.contextManifestId}" attempt binding "${snapshotAttempt}" does not match authorization attempt "${authAttempt}".`;
        this.recordRejectionEvent(params, reason);
        throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${reason}`);
      }

      contextManifestHash = durableManifest.manifest_hash;
    }

    // 8. Canonical Execution Instructions & Verification Snapshot Derived from Manager, Task, & Project Truth
    const canonicalInstructions = buildCanonicalInstructions(task, managerData);
    const durableVerifCommands = this.repo.getVerificationCommandsByProject(params.projectId);
    const verificationSnapshot = buildVerificationCommandsSnapshot(durableVerifCommands);

    const effectiveConstraints: string[] = [
      ...(task.constraints ?? []),
      ...(managerData.constraints ?? []),
    ];

    const canonicalPayload = computeCanonicalPayload({
      projectId: params.projectId,
      taskId: params.taskId,
      attemptId: normalizedAttemptId,
      taskTitle: task.title,
      taskDescription: task.description,
      acceptanceCriteria: task.acceptance_criteria ?? [],
      constraints: effectiveConstraints,
      instructions: canonicalInstructions,
      contextFiles: canonicalContextFiles,
      verificationCommands: verificationSnapshot,
      managerMessageId,
      managerPayloadHash,
    });
    const canonicalPayloadJson = JSON.stringify(canonicalPayload);
    const instructionPayloadHash = computePayloadHash(canonicalPayload);

    // 9. Create ExecutionAuthorization Record
    const authorization: ExecutionAuthorization = {
      id: authorizationId,
      project_id: params.projectId,
      task_id: params.taskId,
      attempt_id: normalizedAttemptId,
      task_revision: task.revision_count,
      base_sha: baseSha,
      repository_head_sha: repositoryHeadSha,
      manager_message_id: managerMessageId,
      manager_payload_hash: managerPayloadHash,
      routing_decision_id: params.routingDecisionId,
      selected_resource_id: selectedResourceId,
      selected_provider_id: selectedProviderId,
      instruction_payload_hash: instructionPayloadHash,
      context_manifest_hash: contextManifestHash,
      canonical_instructions_json: JSON.stringify(canonicalInstructions),
      context_files_json: JSON.stringify(canonicalContextFiles),
      canonical_payload_json: canonicalPayloadJson,
      status: 'AUTHORIZED',
      created_at: createdAt,
      dispatched_at: null,
    };

    this.repo.createExecutionAuthorization(authorization);

    // 10. Persist Audit Event
    if (this.eventService) {
      this.eventService.record(
        params.projectId,
        'EXECUTION_AUTHORIZATION_CREATED',
        `Execution authorization ${authorizationId} created for task ${params.taskId}`,
        {
          authorizationId,
          projectId: params.projectId,
          taskId: params.taskId,
          attemptId: normalizedAttemptId,
          taskRevision: task.revision_count,
          baseSha,
          repositoryHeadSha,
          managerMessageId,
          managerPayloadHash,
          routingDecisionId: params.routingDecisionId,
          selectedResourceId,
          selectedProviderId,
          instructionPayloadHash,
          contextManifestHash,
          contextFileCount: canonicalContextFiles.length,
          status: 'AUTHORIZED',
        },
        params.taskId
      );
    }

    return authorization;
  }

  /**
   * Phase EA: Pure non-persisting authorization candidate preparation for R5I handoff successor.
   * Performs all async and pure validations without DB inserts or HandoffTransfer mutations.
   */
  public async prepareHandoffSuccessorAuthorization(
    params: PrepareHandoffSuccessorAuthorizationParams
  ): Promise<PrepareHandoffSuccessorAuthorizationResult> {
    // 1. Load and validate HandoffTransfer
    const transfer = this.repo.getHandoffTransfer(params.transferId);
    if (!transfer) {
      return {
        success: false,
        errorCode: 'TRANSFER_NOT_FOUND',
        error: `HandoffTransfer "${params.transferId}" not found in database.`,
      };
    }

    if (transfer.status !== 'ROUTED') {
      if (transfer.status === 'AUTHORIZED' || transfer.status === 'ACCEPTED') {
        if (transfer.successor_authorization_id) {
          const existingAuth = this.repo.getExecutionAuthorization(transfer.successor_authorization_id);
          if (existingAuth) {
            if (existingAuth.status === 'INVALIDATED') {
              return {
                success: false,
                errorCode: 'STATUS_CONFLICT',
                error: `HandoffTransfer "${params.transferId}" is already bound to INVALIDATED authorization "${existingAuth.id}".`,
              };
            }
          }
        }
      } else {
        return {
          success: false,
          errorCode: 'TRANSFER_STATUS_NOT_ROUTED',
          error: `HandoffTransfer "${params.transferId}" is in status "${transfer.status}", expected "ROUTED".`,
        };
      }
    }

    if (
      !transfer.successor_assignment_id ||
      !transfer.successor_attempt_id ||
      !transfer.successor_context_snapshot_id ||
      !transfer.successor_context_spec_hash ||
      transfer.successor_ownership_epoch == null
    ) {
      return {
        success: false,
        errorCode: 'TRANSFER_STATUS_NOT_ROUTED',
        error: `HandoffTransfer "${params.transferId}" is missing required successor bindings.`,
      };
    }

    // 2. Load Task and Project
    const task = this.repo.getTask(transfer.task_id);
    if (!task) {
      return {
        success: false,
        errorCode: 'TASK_NOT_FOUND',
        error: `Task "${transfer.task_id}" not found in database.`,
      };
    }

    const project = this.repo.getProject(task.project_id);
    if (!project) {
      return {
        success: false,
        errorCode: 'PROJECT_NOT_FOUND',
        error: `Project "${task.project_id}" not found in database.`,
      };
    }

    // 3. Task base SHA check
    if (!task.base_sha || task.base_sha.trim() === '') {
      return {
        success: false,
        errorCode: 'BASE_SHA_MISSING',
        error: `Task "${task.id}" is missing durable base_sha.`,
      };
    }

    // 4. Ownership epoch checks
    if (
      transfer.successor_ownership_epoch !== transfer.source_ownership_epoch + 1 ||
      task.ownership_epoch !== transfer.successor_ownership_epoch
    ) {
      return {
        success: false,
        errorCode: 'STALE_OWNERSHIP_EPOCH',
        error: `Ownership epoch mismatch: task epoch ${task.ownership_epoch}, transfer successor epoch ${transfer.successor_ownership_epoch}, source epoch ${transfer.source_ownership_epoch}.`,
      };
    }

    // 5. Manager protocol authority
    const latestManagerMsg = this.repo.getLatestAppliedManagerProtocolMessage(task.id, task.project_id);
    if (!latestManagerMsg) {
      return {
        success: false,
        errorCode: 'MANAGER_AUTHORITY_MISSING',
        error: `No applied manager.v1 protocol message found for task "${task.id}".`,
      };
    }

    const parseResult = ProtocolParser.parse(String(latestManagerMsg.raw_payload));
    if (!parseResult.success || !parseResult.data || parseResult.data.type !== 'manager.v1') {
      return {
        success: false,
        errorCode: 'MANAGER_AUTHORITY_INVALID',
        error: `Could not parse applied manager protocol message (${parseResult.error || 'schema invalid'}).`,
      };
    }

    const managerData = parseResult.data.data;
    if (managerData.decision !== 'EXECUTE' && managerData.decision !== 'FIX_REQUIRED') {
      return {
        success: false,
        errorCode: 'MANAGER_DECISION_NON_AUTHORIZING',
        error: `Manager decision "${managerData.decision}" does not authorize execution.`,
      };
    }

    if (managerData.decision === 'EXECUTE') {
      if (
        managerData.expected_revision !== null &&
        managerData.expected_revision !== undefined &&
        managerData.expected_revision !== task.revision_count
      ) {
        return {
          success: false,
          errorCode: 'STALE_TASK_REVISION',
          error: `Manager EXECUTE expected revision ${managerData.expected_revision}, but task revision is ${task.revision_count}.`,
        };
      }
    } else if (managerData.decision === 'FIX_REQUIRED') {
      if (
        managerData.expected_revision !== null &&
        managerData.expected_revision !== undefined &&
        managerData.expected_revision + 1 !== task.revision_count
      ) {
        return {
          success: false,
          errorCode: 'STALE_TASK_REVISION',
          error: `Manager FIX_REQUIRED expected revision ${managerData.expected_revision}, but task revision is ${task.revision_count} (expected +1).`,
        };
      }
    }

    // 6. Successor Assignment
    const assignment = this.repo.getAgentAssignment(transfer.successor_assignment_id);
    if (!assignment) {
      return {
        success: false,
        errorCode: 'ASSIGNMENT_NOT_FOUND',
        error: `Successor AgentAssignment "${transfer.successor_assignment_id}" not found in database.`,
      };
    }

    if (
      assignment.project_id !== task.project_id ||
      assignment.task_id !== task.id ||
      assignment.attempt_id !== transfer.successor_attempt_id ||
      assignment.role_profile_id !== transfer.successor_role_profile_id ||
      assignment.agent_profile_id !== transfer.successor_agent_profile_id ||
      !assignment.routing_decision_id
    ) {
      return {
        success: false,
        errorCode: 'ASSIGNMENT_NOT_FOUND',
        error: `Successor AgentAssignment "${assignment.id}" structural binding mismatch with transfer authority.`,
      };
    }

    // 7. Routing Decision Event
    const routingEvent = this.repo.getRoutingDecisionEvent(assignment.routing_decision_id);
    if (!routingEvent) {
      return {
        success: false,
        errorCode: 'ROUTING_DECISION_NOT_FOUND',
        error: `Routing decision event "${assignment.routing_decision_id}" not found in database.`,
      };
    }

    const routingPayload = routingEvent.structured_payload as Record<string, unknown>;
    if (
      routingPayload.projectId !== task.project_id ||
      routingPayload.taskId !== task.id ||
      routingPayload.outcome !== 'SELECTED' ||
      routingPayload.selectedProviderId !== assignment.selected_provider_id ||
      routingPayload.selectedAccountId !== assignment.selected_account_id ||
      routingPayload.selectedResourceId !== assignment.selected_resource_id
    ) {
      return {
        success: false,
        errorCode: 'ROUTING_DECISION_NOT_FOUND',
        error: `Routing decision event "${assignment.routing_decision_id}" scope mismatch.`,
      };
    }

    // 8. Provider / Account / Resource Chain & Enablement & Health
    const provider = this.repo.getProvider(assignment.selected_provider_id);
    if (!provider) {
      return {
        success: false,
        errorCode: 'PROVIDER_NOT_FOUND',
        error: `Provider "${assignment.selected_provider_id}" not found in database.`,
      };
    }
    if (!provider.enabled) {
      return {
        success: false,
        errorCode: 'PROVIDER_DISABLED',
        error: `Provider "${provider.id}" is disabled.`,
      };
    }

    const account = this.repo.getProviderAccount(assignment.selected_account_id);
    if (!account) {
      return {
        success: false,
        errorCode: 'PROVIDER_ACCOUNT_NOT_FOUND',
        error: `ProviderAccount "${assignment.selected_account_id}" not found in database.`,
      };
    }
    if (!account.enabled) {
      return {
        success: false,
        errorCode: 'PROVIDER_ACCOUNT_DISABLED',
        error: `ProviderAccount "${account.id}" is disabled.`,
      };
    }
    if (account.health_status === 'AUTH_ERROR') {
      return {
        success: false,
        errorCode: 'PROVIDER_ACCOUNT_UNSAFE_HEALTH',
        error: `ProviderAccount "${account.id}" is in AUTH_ERROR state.`,
      };
    }
    if (account.health_status !== 'AVAILABLE' && account.health_status !== 'LOW_QUOTA') {
      return {
        success: false,
        errorCode: 'PROVIDER_ACCOUNT_UNSAFE_HEALTH',
        error: `ProviderAccount "${account.id}" health status "${account.health_status}" is not eligible for execution.`,
      };
    }
    if (account.cooldown_until && new Date(account.cooldown_until).getTime() > Date.now()) {
      return {
        success: false,
        errorCode: 'PROVIDER_ACCOUNT_UNSAFE_HEALTH',
        error: `ProviderAccount "${account.id}" cooldown active until "${account.cooldown_until}".`,
      };
    }

    const resource = this.repo.getProviderResource(assignment.selected_resource_id);
    if (!resource) {
      return {
        success: false,
        errorCode: 'PROVIDER_RESOURCE_NOT_FOUND',
        error: `ProviderResource "${assignment.selected_resource_id}" not found in database.`,
      };
    }
    if (!resource.enabled) {
      return {
        success: false,
        errorCode: 'PROVIDER_RESOURCE_DISABLED',
        error: `ProviderResource "${resource.id}" is disabled.`,
      };
    }
    if (
      resource.health_status === 'DISABLED' ||
      resource.health_status === 'OFFLINE' ||
      resource.health_status === 'UNHEALTHY' ||
      resource.health_status === 'QUOTA_EXHAUSTED' ||
      resource.health_status === 'AUTH_ERROR' ||
      resource.health_status === 'RATE_LIMITED' ||
      resource.health_status === 'COOLDOWN'
    ) {
      return {
        success: false,
        errorCode: 'PROVIDER_RESOURCE_UNSAFE_HEALTH',
        error: `ProviderResource "${resource.id}" health status "${resource.health_status}" is not eligible for execution.`,
      };
    }

    // Quota exhaustion check
    if (
      (resource.quota_source === 'MEASURED' || resource.quota_source === 'PROVIDER_REPORTED' || resource.quota_source === 'MANUAL') &&
      resource.remaining_quota !== null &&
      resource.remaining_quota <= 0
    ) {
      return {
        success: false,
        errorCode: 'PROVIDER_RESOURCE_QUOTA_EXHAUSTED',
        error: `ProviderResource "${resource.id}" quota exhausted (remaining: ${resource.remaining_quota}).`,
      };
    }

    // Provider health watermark safety
    const safety = this.repo.evaluateProviderHealthRoutingSafety(account.id);
    if (safety.status !== 'SAFE') {
      return {
        success: false,
        errorCode: 'PROVIDER_HEALTH_UNSAFE',
        error: `Provider health safety watermark check failed with status "${safety.status}". ${safety.reason ?? ''}`.trim(),
      };
    }

    // 9. Owner Policy evaluation on verification commands
    const durableVerifCommands = this.repo.getVerificationCommandsByProject(project.id);
    for (const cmd of durableVerifCommands) {
      if (cmd.enabled === undefined || cmd.enabled) {
        if (cmd.executable && cmd.executable.trim().length > 0) {
          const policyRes = PolicyService.evaluateProcessExecution(cmd.executable.trim(), cmd.args, false);
          if (policyRes.decision === 'DENY') {
            return {
              success: false,
              errorCode: 'POLICY_DENIED',
              error: `POLICY_DENIED: Verification command "${cmd.name}" (${cmd.executable}) denied by policy: ${policyRes.reason}`,
            };
          }
          if (policyRes.decision === 'REQUIRES_OWNER_APPROVAL') {
            return {
              success: false,
              errorCode: 'NEEDS_OWNER',
              error: `NEEDS_OWNER: Verification command "${cmd.name}" (${cmd.executable}) requires owner approval: ${policyRes.reason}`,
            };
          }
        }
      }
    }

    // 10. Git HEAD resolution
    const gitHeadResult = await GitService.getHeadSha(project.repository_path);
    if (gitHeadResult.status !== 'SUCCESS' || !gitHeadResult.sha) {
      return {
        success: false,
        errorCode: 'GIT_HEAD_FAILED',
        error: `Could not resolve current Git HEAD for repository "${project.repository_path}": ${gitHeadResult.errorMessage || 'git error'}`,
      };
    }

    // 11. Context Manifest & Context Consumption Bridge
    const manifest = this.repo.getContextManifestBySnapshotId(transfer.successor_context_snapshot_id);
    if (!manifest) {
      return {
        success: false,
        errorCode: 'CONTEXT_MANIFEST_NOT_FOUND',
        error: `ContextManifest for snapshot "${transfer.successor_context_snapshot_id}" not found.`,
      };
    }

    const integrityResult = verifyContextManifestIntegrity(this.repo, manifest.id);
    if (!integrityResult.valid) {
      return {
        success: false,
        errorCode: 'CONTEXT_MANIFEST_INTEGRITY_FAILED',
        error: `ContextManifest integrity failed: ${integrityResult.error}`,
      };
    }

    const contextItems = this.repo.getContextItemsBySnapshot(transfer.successor_context_snapshot_id);
    const fileRefItems = contextItems.filter((i) => i.item_type === 'CONTEXT_FILE_REFERENCE');
    const nonFileItems = contextItems.filter((i) => i.item_type !== 'CONTEXT_FILE_REFERENCE');

    const rawFilePaths: string[] = [];
    for (const item of fileRefItems) {
      let content: any;
      try {
        content = JSON.parse(item.content_json);
      } catch {
        return {
          success: false,
          errorCode: 'CONTEXT_FILES_INVALID',
          error: 'Malformed JSON in CONTEXT_FILE_REFERENCE item content.',
        };
      }
      if (!content || typeof content.filePath !== 'string' || content.filePath.trim().length === 0) {
        return {
          success: false,
          errorCode: 'CONTEXT_FILES_INVALID',
          error: 'Missing or empty filePath in CONTEXT_FILE_REFERENCE item.',
        };
      }
      if (item.source_type !== 'REPOSITORY_FILE' || item.source_ref !== content.filePath) {
        return {
          success: false,
          errorCode: 'CONTEXT_FILES_INVALID',
          error: `Mismatched source_type or source_ref in CONTEXT_FILE_REFERENCE item (expected REPOSITORY_FILE and "${content.filePath}").`,
        };
      }
      rawFilePaths.push(content.filePath);
    }

    const sanitizeResult = sanitizeContextFiles(rawFilePaths, project.repository_path);
    if (sanitizeResult.error) {
      return {
        success: false,
        errorCode: 'CONTEXT_FILES_INVALID',
        error: sanitizeResult.error,
      };
    }
    const canonicalContextFiles = sanitizeResult.validFiles;
    const contextManifestHash = computeContextManifestHash(canonicalContextFiles);

    // Build structured context descriptor for non-file items
    nonFileItems.sort((a, b) => a.ordinal - b.ordinal);
    const structuredItems: HandoffContextExecutionItemV1[] = nonFileItems.map((i) => ({
      ordinal: i.ordinal,
      item_type: i.item_type,
      source_type: i.source_type,
      source_ref: i.source_ref,
      content_json: i.content_json,
      content_hash: i.content_hash,
      token_estimate: i.token_estimate,
    }));

    const snapshotContentHash = integrityResult.snapshot!.content_hash;

    const contextDescriptor = buildHandoffContextExecutionDescriptorV1({
      snapshotId: transfer.successor_context_snapshot_id,
      snapshotContentHash,
      manifestId: manifest.id,
      manifestHash: manifest.manifest_hash,
      items: structuredItems,
    });
    const serializedDescriptor = canonicalJsonStringify(contextDescriptor as unknown as Record<string, unknown>);

    // 12. Build Canonical Instructions
    const canonicalInstructions = buildCanonicalInstructions(task, managerData);
    canonicalInstructions.push('Handoff Successor Context (HANDOFF_CONTEXT_EXECUTION_V1):');
    canonicalInstructions.push(serializedDescriptor);

    // 13. Build Canonical Payload
    const effectiveConstraints = [...(task.constraints ?? []), ...(managerData.constraints ?? [])];
    const verificationSnapshot = buildVerificationCommandsSnapshot(durableVerifCommands);

    const canonicalPayload = computeCanonicalPayload({
      projectId: task.project_id,
      taskId: task.id,
      attemptId: transfer.successor_attempt_id,
      taskTitle: task.title,
      taskDescription: task.description,
      acceptanceCriteria: task.acceptance_criteria ?? [],
      constraints: effectiveConstraints,
      instructions: canonicalInstructions,
      contextFiles: canonicalContextFiles,
      verificationCommands: verificationSnapshot,
      managerMessageId: String(latestManagerMsg.id),
      managerPayloadHash: String(latestManagerMsg.payload_hash),
    });
    const canonicalPayloadJson = JSON.stringify(canonicalPayload);
    const instructionPayloadHash = computePayloadHash(canonicalPayload);

    // 14. Compute Deterministic Authorization ID
    const routeMetadata = assignment.preferred_metadata as Record<string, unknown> | null;
    if (
      !routeMetadata ||
      typeof routeMetadata !== 'object' ||
      routeMetadata.handoff_route_spec_version !== 1 ||
      !routeMetadata.handoff_route_spec ||
      typeof routeMetadata.handoff_route_spec !== 'object' ||
      typeof routeMetadata.handoff_route_spec_hash !== 'string' ||
      routeMetadata.handoff_route_spec_hash.trim().length === 0
    ) {
      return {
        success: false,
        errorCode: 'ROUTE_METADATA_CORRUPT',
        error: `Successor assignment "${assignment.id}" is missing valid R5I4 route specification metadata in preferred_metadata.`,
      };
    }

    const recomputedRouteHash = computeSha256(canonicalJsonStringify(routeMetadata.handoff_route_spec as Record<string, unknown>));
    if (recomputedRouteHash !== routeMetadata.handoff_route_spec_hash) {
      return {
        success: false,
        errorCode: 'ROUTE_METADATA_CORRUPT',
        error: `Successor assignment "${assignment.id}" handoff_route_spec_hash does not match recomputed hash of handoff_route_spec.`,
      };
    }

    const routeSpecHash = routeMetadata.handoff_route_spec_hash as string;

    const authority: HandoffSuccessorExecutionAuthorityV1 = {
      version: 1,
      transfer_id: transfer.id,
      successor_attempt_id: transfer.successor_attempt_id,
      successor_assignment_id: transfer.successor_assignment_id,
      successor_ownership_epoch: transfer.successor_ownership_epoch,
      routing_decision_id: assignment.routing_decision_id,
      handoff_route_spec_hash: routeSpecHash,
      successor_context_spec_hash: transfer.successor_context_spec_hash,
      manager_message_id: String(latestManagerMsg.id),
      manager_payload_hash: String(latestManagerMsg.payload_hash),
    };

    const authorizationId = computeHandoffAuthorizationId(authority);

    // 15. Return Candidate
    const candidate: ExecutionAuthorization = {
      id: authorizationId,
      project_id: task.project_id,
      task_id: task.id,
      attempt_id: transfer.successor_attempt_id,
      task_revision: task.revision_count,
      base_sha: task.base_sha.trim(),
      repository_head_sha: gitHeadResult.sha,
      manager_message_id: String(latestManagerMsg.id),
      manager_payload_hash: String(latestManagerMsg.payload_hash),
      routing_decision_id: assignment.routing_decision_id,
      selected_resource_id: assignment.selected_resource_id,
      selected_provider_id: assignment.selected_provider_id,
      instruction_payload_hash: instructionPayloadHash,
      context_manifest_hash: contextManifestHash,
      canonical_instructions_json: JSON.stringify(canonicalInstructions),
      context_files_json: JSON.stringify(canonicalContextFiles),
      canonical_payload_json: canonicalPayloadJson,
      status: 'AUTHORIZED',
      created_at: new Date().toISOString(),
      dispatched_at: null,
      task_ownership_epoch: transfer.successor_ownership_epoch,
      assignment_id: transfer.successor_assignment_id,
    };

    return {
      success: true,
      candidate,
      authority,
    };
  }

  private recordRejectionEvent(params: CreateAuthorizationParams, reason: string): void {
    if (!this.eventService) return;
    const project = this.repo.getProject(params.projectId);
    if (!project) return;
    const task = this.repo.getTask(params.taskId);
    const validTaskId = task && task.project_id === params.projectId ? params.taskId : undefined;

    this.eventService.record(
      params.projectId,
      'EXECUTION_AUTHORIZATION_REJECTED',
      `Execution authorization rejected for task ${params.taskId}: ${reason}`,
      {
        projectId: params.projectId,
        taskId: params.taskId,
        attemptId: params.attemptId ?? null,
        routingDecisionId: params.routingDecisionId,
        reason,
      },
      validTaskId
    );
  }
}
