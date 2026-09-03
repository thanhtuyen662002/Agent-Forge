import crypto from 'crypto';
import Database from 'better-sqlite3';
import { Repository } from '../database/repositories';
import {
  ExecutionAuthorization,
  McpClientSession,
  McpSessionErrorCode,
  AuthorizedContextResponse,
  Project,
  Task,
  TaskAttempt,
  AgentAssignment,
  Provider,
  ProviderAccount,
  ProviderResource,
  EventRecord,
} from '../types/domain';
import { canonicalJsonStringify, computeSha256 } from '../context/ContextIntegrity';
import {
  CanonicalExecutionPayloadSchema,
  computePayloadHash,
  computeContextManifestHash,
  CanonicalExecutionPayload,
} from './ExecutionAuthorizationService';

export class McpAuthorityError extends Error {
  public readonly category: McpSessionErrorCode;
  public readonly rawMessage: string;

  constructor(category: McpSessionErrorCode, message: string) {
    const cleanMessage = message.startsWith(`[${category}] `)
      ? message.slice(`[${category}] `.length)
      : message;
    super(`[${category}] ${cleanMessage}`);
    this.name = 'McpAuthorityError';
    this.category = category;
    this.rawMessage = cleanMessage;
    Object.setPrototypeOf(this, McpAuthorityError.prototype);
  }
}

export const MCP_SESSION_DEFAULT_TTL_SECONDS = 3600;
export const MCP_SESSION_MIN_TTL_SECONDS = 300;
export const MCP_SESSION_MAX_TTL_SECONDS = 86400;

export interface IssueSessionParams {
  authorizationId: string;
  ttlSeconds?: number;
}

export interface IssueSessionResult {
  session: McpClientSession;
  plaintextToken: string;
}

export interface RevokeSessionParams {
  sessionId?: string;
  authorizationId?: string;
}

export interface RevokeSessionResult {
  revoked: boolean;
}

export interface ProtocolMessageRecord {
  id: string;
  message_id: string;
  protocol: string;
  project_id: string;
  task_id: string | null;
  decision: string;
  sequence: number;
  payload_hash: string;
  payload_json: string;
  state: string;
  created_at: string;
}

export interface ValidatedAuthorityGraph {
  auth: ExecutionAuthorization;
  project: Project;
  task: Task;
  attempt: TaskAttempt;
  assignment: AgentAssignment;
  provider: Provider;
  account: ProviderAccount;
  resource: ProviderResource;
  routingEvent: EventRecord;
  routingPayload: Record<string, unknown>;
  protocolMessage: ProtocolMessageRecord | null;
  payload: CanonicalExecutionPayload;
}

/**
 * Validates a session token string against the canonical base64url domain (32 bytes = 43 chars).
 * Prohibits whitespace, trimming, normalization, or non-canonical encodings.
 */
export function validateCanonicalSessionToken(token: unknown): string {
  if (token === undefined || token === null || token === '') {
    throw new McpAuthorityError('MCP_SESSION_REQUIRED', 'Missing session token');
  }
  if (typeof token !== 'string') {
    throw new McpAuthorityError('MCP_SESSION_UNAUTHORIZED', 'Session authentication failed');
  }
  // Canonical 32-byte base64url token without padding is exactly 43 chars of [A-Za-z0-9_-]
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new McpAuthorityError('MCP_SESSION_UNAUTHORIZED', 'Session authentication failed');
  }
  return token;
}

/**
 * Validates TTL seconds strictly as an integer within authorized bounds.
 * Rejects fractions, NaN, infinities, signs, exponent notation, suffixes, and partial parseInt inputs.
 */
export function validateTtlSeconds(ttl: unknown): number {
  if (ttl === undefined) {
    return MCP_SESSION_DEFAULT_TTL_SECONDS;
  }
  if (typeof ttl === 'number') {
    if (!Number.isSafeInteger(ttl) || !/^\d+$/.test(String(ttl))) {
      throw new McpAuthorityError(
        'MCP_CONFIGURATION_INVALID',
        `Invalid session TTL: must be a canonical positive integer within bounds`
      );
    }
  } else if (typeof ttl === 'string') {
    if (!/^\d+$/.test(ttl)) {
      throw new McpAuthorityError(
        'MCP_CONFIGURATION_INVALID',
        `Invalid session TTL: must be a canonical positive integer within bounds`
      );
    }
    ttl = Number(ttl);
  } else {
    throw new McpAuthorityError(
      'MCP_CONFIGURATION_INVALID',
      `Invalid session TTL: must be a canonical positive integer within bounds`
    );
  }

  const numericTtl = ttl as number;
  if (numericTtl < MCP_SESSION_MIN_TTL_SECONDS || numericTtl > MCP_SESSION_MAX_TTL_SECONDS) {
    throw new McpAuthorityError(
      'MCP_CONFIGURATION_INVALID',
      `Session TTL ${numericTtl}s is out of authorized bounds [${MCP_SESSION_MIN_TTL_SECONDS}, ${MCP_SESSION_MAX_TTL_SECONDS}]`
    );
  }
  return numericTtl;
}

/**
 * Computes a deterministic canonical SHA-256 fingerprint over the COMPLETE authority graph.
 */
export function computeCompleteAuthorityFingerprint(graph: ValidatedAuthorityGraph): string {
  const {
    auth,
    project,
    task,
    attempt,
    assignment,
    provider,
    account,
    resource,
    routingEvent,
    routingPayload,
    protocolMessage,
  } = graph;

  const spec = {
    authorization: {
      id: auth.id,
      lifecycle_version: auth.lifecycle_version,
      status: auth.status,
      base_sha: auth.base_sha,
      repository_head_sha: auth.repository_head_sha,
      task_revision: auth.task_revision,
      task_ownership_epoch: auth.task_ownership_epoch,
      instruction_payload_hash: auth.instruction_payload_hash,
      context_manifest_hash: auth.context_manifest_hash,
      manager_message_id: auth.manager_message_id,
      manager_payload_hash: auth.manager_payload_hash,
    },
    project: {
      id: project.id,
      name: project.name,
      repository_path: project.repository_path,
    },
    task: {
      id: task.id,
      project_id: task.project_id,
      title: task.title,
      state: task.state,
      revision_count: task.revision_count,
    },
    attempt: {
      id: attempt.id,
      task_id: attempt.task_id,
      attempt_number: attempt.attempt_number,
      status: attempt.status,
    },
    assignment: {
      id: assignment.id,
      project_id: assignment.project_id,
      task_id: assignment.task_id,
      attempt_id: assignment.attempt_id,
      selected_provider_id: assignment.selected_provider_id,
      selected_account_id: assignment.selected_account_id,
      selected_resource_id: assignment.selected_resource_id,
      routing_decision_id: assignment.routing_decision_id,
      status: assignment.status,
    },
    provider: {
      id: provider.id,
      name: provider.name,
      adapter_type: provider.adapter_type,
      enabled: provider.enabled,
    },
    account: {
      id: account.id,
      provider_id: account.provider_id,
      label: account.label,
      enabled: account.enabled,
    },
    resource: {
      id: resource.id,
      provider_id: resource.provider_id,
      provider_account_id: resource.provider_account_id,
      model_name: resource.model_name,
      enabled: resource.enabled,
    },
    routing: {
      id: routingEvent.id,
      type: routingEvent.type,
      project_id: routingPayload.project_id ?? routingPayload.projectId,
      task_id: routingPayload.task_id ?? routingPayload.taskId,
      attempt_id: routingPayload.attempt_id ?? routingPayload.attemptId,
      routing_decision_id:
        routingPayload.routing_decision_id ??
        routingPayload.routingDecisionId ??
        routingPayload.decisionId,
      selected_provider_id:
        routingPayload.selected_provider_id ??
        routingPayload.selectedProviderId ??
        routingPayload.providerId,
      selected_account_id:
        routingPayload.selected_account_id ??
        routingPayload.selectedAccountId ??
        routingPayload.accountId,
      selected_resource_id:
        routingPayload.selected_resource_id ??
        routingPayload.selectedResourceId ??
        routingPayload.resourceId,
      selected_outcome:
        routingPayload.selected_outcome ??
        routingPayload.selectedOutcome ??
        routingPayload.outcome,
      raw_payload: routingPayload,
    },
    protocol_message: protocolMessage
      ? {
          id: protocolMessage.id,
          payload_hash: protocolMessage.payload_hash,
          project_id: protocolMessage.project_id,
          task_id: protocolMessage.task_id,
        }
      : null,
  };

  return computeSha256(canonicalJsonStringify(spec));
}

/**
 * Backward compatibility helper aliased to complete graph fingerprint when graph available.
 */
export function computeAuthorizationFingerprint(auth: ExecutionAuthorization): string {
  const spec = {
    assignment_id: auth.assignment_id ?? null,
    attempt_id: auth.attempt_id ?? null,
    authorization_id: auth.id,
    base_sha: auth.base_sha,
    canonical_payload_json: auth.canonical_payload_json,
    context_manifest_hash: auth.context_manifest_hash,
    instruction_payload_hash: auth.instruction_payload_hash,
    lifecycle_version: auth.lifecycle_version ?? null,
    manager_message_id: auth.manager_message_id,
    manager_payload_hash: auth.manager_payload_hash,
    project_id: auth.project_id,
    repository_head_sha: auth.repository_head_sha,
    routing_decision_id: auth.routing_decision_id,
    selected_account_id: auth.selected_account_id ?? null,
    selected_provider_id: auth.selected_provider_id,
    selected_resource_id: auth.selected_resource_id,
    task_id: auth.task_id,
    task_ownership_epoch: auth.task_ownership_epoch ?? null,
    task_revision: auth.task_revision,
  };
  return computeSha256(canonicalJsonStringify(spec));
}

export class McpSessionAuthorityService {
  constructor(
    private readonly repo: Repository,
    private readonly db: Database.Database
  ) {}

  public static generateSessionToken(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  public static hashSessionToken(token: string): string {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex').toLowerCase();
  }

  /**
   * Internal complete authority graph validator shared between issueSession and resolveAuthorizedContext.
   * Performs exhaustive, non-optional graph validation.
   */
  public validateCompleteAuthorityGraph(authId: string): ValidatedAuthorityGraph {
    // 1. Authorization row & lifecycle version
    const auth = this.repo.getExecutionAuthorization(authId);
    if (!auth) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Authorization "${authId}" not found`);
    }
    if (auth.lifecycle_version !== 1) {
      throw new McpAuthorityError(
        'MCP_AUTHORITY_FENCED',
        `Authorization "${authId}" is not lifecycle version 1 (found ${auth.lifecycle_version})`
      );
    }

    // 2. Authorization status
    if (auth.status !== 'AUTHORIZED' && auth.status !== 'DISPATCHED') {
      throw new McpAuthorityError(
        'MCP_AUTHORITY_FENCED',
        `Authorization status "${auth.status}" is not active`
      );
    }

    // 3. No terminal settlement
    if (
      auth.settlement_status != null ||
      auth.settled_at != null ||
      auth.settlement_evidence_hash != null
    ) {
      throw new McpAuthorityError(
        'MCP_AUTHORITY_FENCED',
        `Authorization already has terminal settlement`
      );
    }

    // 4. Project
    const project = this.repo.getProject(auth.project_id);
    if (!project || project.id !== auth.project_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Project "${auth.project_id}" not found or mismatched`);
    }

    // 5. Task
    const task = this.repo.getTask(auth.task_id);
    if (!task || task.id !== auth.task_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Task "${auth.task_id}" not found or mismatched`);
    }
    if (task.project_id !== auth.project_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Task project_id does not match authorization project_id');
    }
    if (task.revision_count !== auth.task_revision) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Task revision_count does not match authorization task_revision');
    }

    // 6. Ownership epoch
    const taskEpoch = (task as unknown as { ownership_epoch?: number }).ownership_epoch ?? auth.task_ownership_epoch;
    if (auth.task_ownership_epoch == null || auth.task_ownership_epoch <= 0) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Authorization missing valid task_ownership_epoch');
    }
    if (taskEpoch !== auth.task_ownership_epoch) {
      throw new McpAuthorityError(
        'MCP_AUTHORITY_FENCED',
        `Task ownership epoch ${taskEpoch} does not match authorization epoch ${auth.task_ownership_epoch}`
      );
    }

    // 7. Task Attempt
    if (!auth.attempt_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Authorization missing attempt_id');
    }
    const attempt = this.repo.getTaskAttempt(auth.attempt_id);
    if (!attempt || attempt.id !== auth.attempt_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Attempt "${auth.attempt_id}" not found`);
    }
    if (attempt.task_id !== auth.task_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Attempt task_id does not match authorization task_id');
    }

    // 8. Agent Assignment
    if (!auth.assignment_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Authorization missing assignment_id');
    }
    const assignment = this.repo.getAgentAssignment(auth.assignment_id);
    if (!assignment || assignment.id !== auth.assignment_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Assignment "${auth.assignment_id}" not found`);
    }
    if (assignment.project_id !== auth.project_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Assignment project_id does not match authorization project_id');
    }
    if (assignment.task_id !== auth.task_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Assignment task_id does not match authorization task_id');
    }
    if (assignment.attempt_id !== auth.attempt_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Assignment attempt_id does not match authorization attempt_id');
    }
    if (assignment.selected_provider_id !== auth.selected_provider_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Assignment selected_provider_id does not match authorization');
    }
    if (assignment.selected_account_id !== auth.selected_account_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Assignment selected_account_id does not match authorization');
    }
    if (assignment.selected_resource_id !== auth.selected_resource_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Assignment selected_resource_id does not match authorization');
    }
    if (assignment.routing_decision_id !== auth.routing_decision_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Assignment routing_decision_id does not match authorization');
    }
    if (assignment.status !== 'ASSIGNED' && assignment.status !== 'RUNNING') {
      throw new McpAuthorityError(
        'MCP_AUTHORITY_FENCED',
        `Assignment status "${assignment.status}" is not active (ASSIGNED or RUNNING)`
      );
    }

    // 9. Provider
    const provider = this.repo.getProvider(auth.selected_provider_id);
    if (!provider || provider.id !== auth.selected_provider_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Provider "${auth.selected_provider_id}" not found`);
    }
    if (!provider.enabled) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Provider "${auth.selected_provider_id}" is disabled`);
    }

    // 10. Provider Account
    if (!auth.selected_account_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Authorization missing selected_account_id');
    }
    const account = this.repo.getProviderAccount(auth.selected_account_id);
    if (!account || account.id !== auth.selected_account_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Provider account "${auth.selected_account_id}" not found`);
    }
    if (account.provider_id !== auth.selected_provider_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Account provider_id does not match selected_provider_id');
    }
    if (!account.enabled) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Provider account "${auth.selected_account_id}" is disabled`);
    }

    // 11. Provider Resource
    const resource = this.repo.getProviderResource(auth.selected_resource_id);
    if (!resource || resource.id !== auth.selected_resource_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Resource "${auth.selected_resource_id}" not found`);
    }
    if (resource.provider_id !== auth.selected_provider_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Resource provider_id does not match selected_provider_id');
    }
    if (resource.provider_account_id == null || resource.provider_account_id !== auth.selected_account_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Resource account binding does not match selected_account_id');
    }
    if (!resource.enabled) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Resource "${auth.selected_resource_id}" is disabled`);
    }

    // 12. Routing Decision Event
    const routingEvent = this.repo.getRoutingDecisionEvent(auth.routing_decision_id);
    if (!routingEvent) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Routing decision event "${auth.routing_decision_id}" not found`);
    }
    if (
      routingEvent.type !== 'PROVIDER_ROUTING_DECISION' &&
      routingEvent.type !== 'ROLE_AWARE_ROUTING_DECISION'
    ) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Routing event type "${routingEvent.type}" is not an authoritative routing decision`);
    }

    // Validate mandatory routing payload fields without optional truthiness
    const rPayload = (routingEvent.structured_payload ?? {}) as Record<string, unknown>;
    if (typeof rPayload !== 'object' || rPayload === null) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Routing decision structured payload is missing or malformed');
    }

    const rProjId = rPayload.project_id ?? rPayload.projectId;
    if (typeof rProjId !== 'string' || rProjId !== auth.project_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Routing payload project_id missing or mismatched');
    }

    const rTaskId = rPayload.task_id ?? rPayload.taskId;
    if (typeof rTaskId !== 'string' || rTaskId !== auth.task_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Routing payload task_id missing or mismatched');
    }

    const rAttemptId = rPayload.attempt_id ?? rPayload.attemptId;
    if (typeof rAttemptId !== 'string' || rAttemptId !== auth.attempt_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Routing payload attempt_id missing or mismatched');
    }

    const rDecisionId =
      rPayload.routing_decision_id ?? rPayload.routingDecisionId ?? rPayload.decisionId;
    if (typeof rDecisionId !== 'string' || rDecisionId !== auth.routing_decision_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Routing payload routing_decision_id missing or mismatched');
    }

    const rProvId =
      rPayload.selected_provider_id ?? rPayload.selectedProviderId ?? rPayload.providerId;
    if (typeof rProvId !== 'string' || rProvId !== auth.selected_provider_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Routing payload selected_provider_id missing or mismatched');
    }

    const rAccId =
      rPayload.selected_account_id ?? rPayload.selectedAccountId ?? rPayload.accountId;
    if (typeof rAccId !== 'string' || rAccId !== auth.selected_account_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Routing payload selected_account_id missing or mismatched');
    }

    const rResId =
      rPayload.selected_resource_id ?? rPayload.selectedResourceId ?? rPayload.resourceId;
    if (typeof rResId !== 'string' || rResId !== auth.selected_resource_id) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Routing payload selected_resource_id missing or mismatched');
    }

    const rOutcome =
      rPayload.selected_outcome ?? rPayload.selectedOutcome ?? rPayload.outcome;
    if (typeof rOutcome !== 'string' || rOutcome !== 'SELECTED') {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Routing payload outcome missing or not SELECTED');
    }

    // 13. Protocol Message
    let protocolMessage: ProtocolMessageRecord | null = null;
    if (auth.manager_message_id) {
      const msgRow =
        this.repo.getProtocolMessageByRecordId(auth.manager_message_id) ??
        this.repo.getProtocolMessageById(auth.manager_message_id);
      if (!msgRow) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Manager protocol message "${auth.manager_message_id}" not found`);
      }
      protocolMessage = {
        id: String(msgRow.id),
        message_id: String(msgRow.message_id),
        protocol: String(msgRow.protocol),
        project_id: String(msgRow.project_id),
        task_id: msgRow.task_id ? String(msgRow.task_id) : null,
        decision: String(msgRow.decision),
        sequence: Number(msgRow.sequence),
        payload_hash: String(msgRow.payload_hash),
        payload_json: String(msgRow.payload_json),
        state: String(msgRow.state),
        created_at: String(msgRow.created_at),
      };
      if (protocolMessage.payload_hash !== auth.manager_payload_hash) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Protocol message payload_hash mismatch');
      }
      if (protocolMessage.project_id !== auth.project_id) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Protocol message project_id mismatch');
      }
      if (protocolMessage.task_id !== auth.task_id) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Protocol message task_id mismatch');
      }
    }

    // 14. Canonical Execution Payload
    if (!auth.canonical_payload_json || auth.canonical_payload_json.trim() === '') {
      throw new McpAuthorityError('MCP_CONTEXT_INTEGRITY_FAILED', 'Canonical execution payload JSON is missing');
    }
    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(auth.canonical_payload_json);
    } catch {
      throw new McpAuthorityError('MCP_CONTEXT_INTEGRITY_FAILED', 'Malformed canonical execution payload JSON');
    }
    const schemaValidation = CanonicalExecutionPayloadSchema.safeParse(rawPayload);
    if (!schemaValidation.success) {
      throw new McpAuthorityError('MCP_CONTEXT_INTEGRITY_FAILED', 'Canonical execution payload schema validation failed');
    }
    const payload: CanonicalExecutionPayload = schemaValidation.data;

    // Verify identifiers
    if (
      payload.projectId !== auth.project_id ||
      payload.taskId !== auth.task_id ||
      payload.attemptId !== auth.attempt_id ||
      payload.managerMessageId !== auth.manager_message_id ||
      payload.managerPayloadHash !== auth.manager_payload_hash
    ) {
      throw new McpAuthorityError('MCP_CONTEXT_INTEGRITY_FAILED', 'Payload identifiers mismatch with authorization bindings');
    }

    // Recompute hashes
    const recomputedPayloadHash = computePayloadHash(payload);
    if (recomputedPayloadHash !== auth.instruction_payload_hash) {
      throw new McpAuthorityError('MCP_CONTEXT_INTEGRITY_FAILED', 'Instruction payload hash recomputation mismatch');
    }

    const recomputedManifestHash = computeContextManifestHash(payload.contextFiles);
    if (recomputedManifestHash !== auth.context_manifest_hash) {
      throw new McpAuthorityError('MCP_CONTEXT_INTEGRITY_FAILED', 'Context manifest hash recomputation mismatch');
    }

    return {
      auth,
      project,
      task,
      attempt,
      assignment,
      provider,
      account,
      resource,
      routingEvent,
      routingPayload: rPayload,
      protocolMessage,
      payload,
    };
  }

  /**
   * Issue a task-scoped MCP session for a lifecycle-v1 execution authorization.
   * Acquires write authority deterministically using an immediate transaction.
   * Plaintext token is returned exactly once.
   */
  public issueSession(params: IssueSessionParams): IssueSessionResult {
    const ttlSeconds = validateTtlSeconds(params.ttlSeconds);

    const runTx = this.db.transaction((): IssueSessionResult => {
      // 1. Validate complete authority graph
      const graph = this.validateCompleteAuthorityGraph(params.authorizationId);

      // 2. Reject if an active unrevoked session already exists
      const existingSession = this.repo.getActiveMcpClientSessionByAuthorizationId(graph.auth.id);
      if (existingSession) {
        throw new McpAuthorityError(
          'MCP_AUTHORITY_FENCED',
          `An active unrevoked session already exists for authorization "${graph.auth.id}"`
        );
      }

      // 3. Generate credentials & compute complete authority graph fingerprint
      const plaintextToken = McpSessionAuthorityService.generateSessionToken();
      const tokenHash = McpSessionAuthorityService.hashSessionToken(plaintextToken);
      const authorizationFingerprint = computeCompleteAuthorityFingerprint(graph);
      const issuedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
      const sessionId = crypto.randomUUID();

      const session: McpClientSession = {
        id: sessionId,
        authorization_id: graph.auth.id,
        scope: 'AUTHORIZED_CONTEXT_READ',
        token_hash: tokenHash,
        authorization_fingerprint: authorizationFingerprint,
        issued_at: issuedAt,
        expires_at: expiresAt,
        revoked_at: null,
      };

      this.repo.createMcpClientSession(session);

      return {
        session,
        plaintextToken,
      };
    });

    try {
      return runTx.immediate();
    } catch (err) {
      if (err instanceof McpAuthorityError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('UNIQUE constraint') ||
        msg.includes('SQLITE_BUSY') ||
        msg.includes('SQLITE_LOCKED')
      ) {
        throw new McpAuthorityError(
          'MCP_AUTHORITY_FENCED',
          'Concurrent active session or authority conflict'
        );
      }
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Authority acquisition failed: ${msg}`);
    }
  }

  /**
   * Idempotently revokes an active session by session ID or authorization ID using an immediate transaction.
   */
  public revokeSession(params: RevokeSessionParams): RevokeSessionResult {
    if (!params.sessionId && !params.authorizationId) {
      throw new McpAuthorityError('MCP_CONFIGURATION_INVALID', 'Must provide sessionId or authorizationId to revoke');
    }
    if (params.sessionId && params.authorizationId) {
      throw new McpAuthorityError('MCP_CONFIGURATION_INVALID', 'Cannot provide both sessionId and authorizationId to revoke');
    }

    const runTx = this.db.transaction((): RevokeSessionResult => {
      const revokedAt = new Date().toISOString();
      const revoked = this.repo.revokeMcpClientSession({
        sessionId: params.sessionId,
        authorizationId: params.authorizationId,
        revokedAt,
      });
      return { revoked };
    });

    try {
      return runTx.immediate();
    } catch (err) {
      if (err instanceof McpAuthorityError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Revocation failed: ${msg}`);
    }
  }

  /**
   * Authenticates a session token and resolves the authorized context within a single read transaction snapshot.
   * Public errors are non-oracular.
   */
  public resolveAuthorizedContext(rawToken: unknown): AuthorizedContextResponse {
    // 1. Strict canonical base64url token validation
    const token = validateCanonicalSessionToken(rawToken);
    const tokenHash = McpSessionAuthorityService.hashSessionToken(token);

    // 2. Execute within a single read transaction snapshot
    const readTx = this.db.transaction((): AuthorizedContextResponse => {
      // Look up session by token hash
      const session = this.repo.getMcpClientSessionByTokenHash(tokenHash);
      if (!session) {
        throw new McpAuthorityError('MCP_SESSION_UNAUTHORIZED', 'Session authentication failed');
      }

      // Non-oracular equivalence: revoked or expired tokens return MCP_SESSION_UNAUTHORIZED
      if (session.revoked_at != null) {
        throw new McpAuthorityError('MCP_SESSION_UNAUTHORIZED', 'Session authentication failed');
      }

      const now = Date.now();
      const expiresAtMs = new Date(session.expires_at).getTime();
      if (Number.isNaN(expiresAtMs) || expiresAtMs <= now) {
        throw new McpAuthorityError('MCP_SESSION_UNAUTHORIZED', 'Session authentication failed');
      }

      if (session.scope !== 'AUTHORIZED_CONTEXT_READ') {
        throw new McpAuthorityError('MCP_SESSION_UNAUTHORIZED', 'Session authentication failed');
      }

      // Validate complete authority graph
      const graph = this.validateCompleteAuthorityGraph(session.authorization_id);

      // Recompute complete authority graph fingerprint
      const recomputedFingerprint = computeCompleteAuthorityFingerprint(graph);
      if (recomputedFingerprint !== session.authorization_fingerprint) {
        throw new McpAuthorityError(
          'MCP_CONTEXT_INTEGRITY_FAILED',
          'Authority graph fingerprint integrity verification failed'
        );
      }

      // Return strictly sanitized, non-secret response
      const response: AuthorizedContextResponse = {
        schema_version: 2,
        session: {
          id: session.id,
          scope: session.scope,
          issued_at: session.issued_at,
          expires_at: session.expires_at,
        },
        authorization: {
          id: graph.auth.id,
          project_id: graph.auth.project_id,
          task_id: graph.auth.task_id,
          attempt_id: graph.attempt.id,
          assignment_id: graph.assignment.id,
          task_ownership_epoch: graph.auth.task_ownership_epoch ?? 1,
          lifecycle_version: 1,
          routing_decision_id: graph.auth.routing_decision_id,
          selected_provider_id: graph.provider.id,
          selected_account_id: graph.account.id,
          selected_resource_id: graph.resource.id,
          task_revision: graph.auth.task_revision,
          base_sha: graph.auth.base_sha,
          repository_head_sha: graph.auth.repository_head_sha,
          manager_message_id: graph.auth.manager_message_id,
          manager_payload_hash: graph.auth.manager_payload_hash,
          status: graph.auth.status,
          created_at: graph.auth.created_at,
          dispatched_at: graph.auth.dispatched_at,
        },
        execution_payload: graph.payload as unknown as Record<string, unknown>,
        instruction_payload_hash: graph.auth.instruction_payload_hash,
        context_manifest_hash: graph.auth.context_manifest_hash,
      };

      return response;
    });

    return readTx();
  }
}
