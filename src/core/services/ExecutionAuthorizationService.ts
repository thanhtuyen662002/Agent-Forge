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

export interface CreateAuthorizationParams {
  projectId: string;
  taskId: string;
  attemptId?: string | null;
  routingDecisionId: string;
  contextFiles?: string[];
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

export function sanitizeContextFiles(
  contextFiles: string[] = [],
  repositoryRoot: string
): { validFiles: string[]; error?: string } {
  const seen = new Set<string>();
  const validFiles: string[] = [];

  for (const rawPath of contextFiles) {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
      continue;
    }
    const trimmed = rawPath.trim();

    // Reject absolute paths
    if (path.isAbsolute(trimmed)) {
      return {
        validFiles: [],
        error: `CONTEXT_PATH_INVALID: Context path "${trimmed}" must be relative to repository root.`,
      };
    }

    // Reject directory traversal
    if (
      trimmed.startsWith('..') ||
      trimmed.includes('../') ||
      trimmed.includes('..\\') ||
      trimmed.split(/[\\/]/).includes('..')
    ) {
      return {
        validFiles: [],
        error: `CONTEXT_PATH_TRAVERSAL: Context path "${trimmed}" violates path containment.`,
      };
    }

    // Check against PolicyService path access
    const resolvedPath = path.join(repositoryRoot, trimmed);
    const policyResult = PolicyService.evaluatePathAccess(resolvedPath, repositoryRoot, false);
    if (!policyResult.allowed) {
      return {
        validFiles: [],
        error: `CONTEXT_PATH_DENIED: Context path "${trimmed}" rejected: ${policyResult.reason}`,
      };
    }

    // Canonicalize separators to '/'
    const canonicalRel = trimmed.split(/[\\/]/).join('/');
    if (!seen.has(canonicalRel)) {
      seen.add(canonicalRel);
      validFiles.push(canonicalRel);
    }
  }

  // Sort deterministically
  validFiles.sort();
  return { validFiles };
}

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

    // 7. Context File Manifest Validation & Canonicalization
    const sanitizeResult = sanitizeContextFiles(params.contextFiles, project.repository_path);
    if (sanitizeResult.error) {
      this.recordRejectionEvent(params, sanitizeResult.error);
      throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${sanitizeResult.error}`);
    }
    const canonicalContextFiles = sanitizeResult.validFiles;
    const contextManifestHash = computeContextManifestHash(canonicalContextFiles);

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
