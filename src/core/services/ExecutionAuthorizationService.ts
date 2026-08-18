import crypto from 'crypto';
import path from 'path';
import { Repository } from '../database/repositories';
import { EventService } from './EventService';
import { PolicyService } from './PolicyService';
import {
  ExecutionAuthorization,
  TaskState,
} from '../types/domain';

export interface CreateAuthorizationParams {
  projectId: string;
  taskId: string;
  attemptId?: string | null;
  routingDecisionId: string;
  instructions?: string[];
  contextFiles?: string[];
}

export interface CanonicalExecutionPayload {
  projectId: string;
  taskId: string;
  attemptId: string | null;
  taskTitle: string;
  taskDescription: string | null;
  acceptanceCriteria: string[];
  constraints: string[];
  instructions: string[];
  contextFiles: string[];
}

export const ALLOWED_TASK_STATES_FOR_AUTHORIZATION = new Set<TaskState>([
  'APPROVED',
  'CODING',
  'FIX_REQUIRED',
  'REVIEWING',
  'VALIDATING',
  'DISPATCHED',
  'HANDOFF_REQUIRED',
  'REVIEW_READY',
]);

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
  };
}

export function computePayloadHash(payload: CanonicalExecutionPayload): string {
  const serialized = JSON.stringify({
    acceptanceCriteria: payload.acceptanceCriteria,
    attemptId: payload.attemptId,
    constraints: payload.constraints,
    contextFiles: payload.contextFiles,
    instructions: payload.instructions,
    projectId: payload.projectId,
    taskDescription: payload.taskDescription,
    taskId: payload.taskId,
    taskTitle: payload.taskTitle,
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
   * Creates an immutable, durable ExecutionAuthorization bound to approved task state and a valid RoutingDecision.
   */
  public createAuthorization(params: CreateAuthorizationParams): ExecutionAuthorization {
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

    // 2. Validate Task Approval / Executable State
    if (!ALLOWED_TASK_STATES_FOR_AUTHORIZATION.has(task.state)) {
      const reason = `Task "${params.taskId}" in state "${task.state}" does not have approved execution authority. Allowed states: [${Array.from(ALLOWED_TASK_STATES_FOR_AUTHORIZATION).join(', ')}].`;
      this.recordRejectionEvent(params, reason);
      throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${reason}`);
    }

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

    // 4. Validate Provider and Resource Enablement
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

    // 5. Context File Manifest Validation & Canonicalization
    const sanitizeResult = sanitizeContextFiles(params.contextFiles, project.repository_path);
    if (sanitizeResult.error) {
      this.recordRejectionEvent(params, sanitizeResult.error);
      throw new Error(`EXECUTION_AUTHORIZATION_FAILED: ${sanitizeResult.error}`);
    }
    const canonicalContextFiles = sanitizeResult.validFiles;
    const contextManifestHash = computeContextManifestHash(canonicalContextFiles);

    // 6. Canonical Execution Payload & Hash Computation
    const effectiveInstructions =
      params.instructions && params.instructions.length > 0
        ? params.instructions
        : [task.description ?? task.title];

    const canonicalPayload = computeCanonicalPayload({
      projectId: params.projectId,
      taskId: params.taskId,
      attemptId: normalizedAttemptId,
      taskTitle: task.title,
      taskDescription: task.description,
      acceptanceCriteria: task.acceptance_criteria ?? [],
      constraints: task.constraints ?? [],
      instructions: effectiveInstructions,
      contextFiles: canonicalContextFiles,
    });
    const instructionPayloadHash = computePayloadHash(canonicalPayload);

    // 7. Base SHA Binding
    const baseSha = task.base_sha || '0000000000000000000000000000000000000000';

    // 8. Create ExecutionAuthorization Record
    const authorization: ExecutionAuthorization = {
      id: authorizationId,
      project_id: params.projectId,
      task_id: params.taskId,
      attempt_id: normalizedAttemptId,
      task_revision: task.revision_count,
      base_sha: baseSha,
      routing_decision_id: params.routingDecisionId,
      selected_resource_id: selectedResourceId,
      selected_provider_id: selectedProviderId,
      instruction_payload_hash: instructionPayloadHash,
      context_manifest_hash: contextManifestHash,
      canonical_instructions_json: JSON.stringify(effectiveInstructions),
      context_files_json: JSON.stringify(canonicalContextFiles),
      status: 'AUTHORIZED',
      created_at: createdAt,
      dispatched_at: null,
    };

    this.repo.createExecutionAuthorization(authorization);

    // 9. Persist Audit Event
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
