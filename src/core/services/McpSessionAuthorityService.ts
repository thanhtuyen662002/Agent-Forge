import crypto from 'crypto';
import Database from 'better-sqlite3';
import { Repository } from '../database/repositories';
import {
  ExecutionAuthorization,
  McpClientSession,
  McpSessionErrorCode,
  AuthorizedContextResponse,
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

  constructor(category: McpSessionErrorCode, message: string) {
    super(`[${category}] ${message}`);
    this.name = 'McpAuthorityError';
    this.category = category;
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

/**
 * Computes a deterministic canonical SHA-256 fingerprint over the frozen authorization fields.
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

  const canonicalJson = canonicalJsonStringify(spec);
  return computeSha256(canonicalJson);
}

export class McpSessionAuthorityService {
  constructor(
    private readonly repo: Repository,
    private readonly db: Database.Database
  ) {}

  /**
   * Generates a cryptographically secure token with at least 256 bits of entropy.
   * Returns canonical base64url without padding.
   */
  public static generateSessionToken(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  /**
   * Computes the lowercase SHA-256 digest of a session token.
   */
  public static hashSessionToken(token: string): string {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex').toLowerCase();
  }

  /**
   * Issue a task-scoped MCP session for a lifecycle-v1 execution authorization.
   * Must be executed within a transaction. Plaintext token is returned exactly once.
   */
  public issueSession(params: IssueSessionParams): IssueSessionResult {
    const ttlSeconds = params.ttlSeconds ?? MCP_SESSION_DEFAULT_TTL_SECONDS;
    if (ttlSeconds < MCP_SESSION_MIN_TTL_SECONDS || ttlSeconds > MCP_SESSION_MAX_TTL_SECONDS) {
      throw new McpAuthorityError(
        'MCP_CONFIGURATION_INVALID',
        `Session TTL ${ttlSeconds}s is out of authorized bounds [${MCP_SESSION_MIN_TTL_SECONDS}, ${MCP_SESSION_MAX_TTL_SECONDS}]`
      );
    }

    const runTx = this.db.transaction((): IssueSessionResult => {
      // 1. Authorization exists and has lifecycle_version === 1
      const auth = this.repo.getExecutionAuthorization(params.authorizationId);
      if (!auth) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Authorization "${params.authorizationId}" not found`);
      }
      if (auth.lifecycle_version !== 1) {
        throw new McpAuthorityError(
          'MCP_AUTHORITY_FENCED',
          `Authorization "${params.authorizationId}" is not lifecycle version 1 (found ${auth.lifecycle_version})`
        );
      }

      // 2. Status is AUTHORIZED or DISPATCHED
      if (auth.status !== 'AUTHORIZED' && auth.status !== 'DISPATCHED') {
        throw new McpAuthorityError(
          'MCP_AUTHORITY_FENCED',
          `Authorization status "${auth.status}" is not AUTHORIZED or DISPATCHED`
        );
      }

      // 3. No terminal settlement is present
      if (auth.settlement_status != null) {
        throw new McpAuthorityError(
          'MCP_AUTHORITY_FENCED',
          `Authorization already has terminal settlement "${auth.settlement_status}"`
        );
      }

      // 4. Assignment, attempt, task, provider, account, resource, routing exist
      const task = this.repo.getTask(auth.task_id);
      if (!task) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Task "${auth.task_id}" not found`);
      }

      const project = this.repo.getProject(auth.project_id);
      if (!project) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Project "${auth.project_id}" not found`);
      }

      if (!auth.assignment_id) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Authorization missing assignment_id');
      }
      const assignment = this.repo.getAgentAssignment(auth.assignment_id);
      if (!assignment) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Assignment "${auth.assignment_id}" not found`);
      }

      if (auth.attempt_id) {
        const attempt = this.repo.getTaskAttempt(auth.attempt_id);
        if (!attempt) {
          throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Attempt "${auth.attempt_id}" not found`);
        }
      }

      const routing = this.repo.getRoutingDecisionEvent(auth.routing_decision_id);
      if (!routing) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Routing decision "${auth.routing_decision_id}" not found`);
      }

      if (!auth.selected_account_id) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Authorization missing selected_account_id');
      }
      const account = this.repo.getProviderAccount(auth.selected_account_id);
      if (!account) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Provider account "${auth.selected_account_id}" not found`);
      }

      const provider = this.repo.getProvider(auth.selected_provider_id);
      if (!provider) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Provider "${auth.selected_provider_id}" not found`);
      }

      const resource = this.repo.getProviderResource(auth.selected_resource_id);
      if (!resource) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', `Resource "${auth.selected_resource_id}" not found`);
      }

      // 5. All graph bindings match exactly
      if (task.project_id !== auth.project_id) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Task project_id does not match authorization project_id');
      }
      if (assignment.task_id !== auth.task_id) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Assignment task_id does not match authorization task_id');
      }
      if (assignment.attempt_id !== auth.attempt_id) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Assignment attempt_id does not match authorization attempt_id');
      }
      if (routing.task_id && routing.task_id !== auth.task_id) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Routing task_id does not match authorization task_id');
      }
      const routingPayload = (routing.structured_payload ?? {}) as Record<string, unknown>;
      if (routingPayload.taskId && routingPayload.taskId !== auth.task_id) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Routing payload taskId does not match authorization task_id');
      }
      const routingProviderId = (routingPayload.selectedProviderId ?? routingPayload.selected_provider_id ?? routingPayload.providerId) as string | undefined;
      if (routingProviderId && routingProviderId !== auth.selected_provider_id) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Routing provider_id does not match authorization selected_provider_id');
      }
      if (account.provider_id !== auth.selected_provider_id) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Account provider_id does not match authorization selected_provider_id');
      }

      // 6. Assignment status is ASSIGNED or RUNNING
      if (assignment.status !== 'ASSIGNED' && assignment.status !== 'RUNNING') {
        throw new McpAuthorityError(
          'MCP_AUTHORITY_FENCED',
          `Assignment status "${assignment.status}" is not ASSIGNED or RUNNING`
        );
      }

      // 7. Current task ownership epoch equals authorization epoch
      const taskEpoch = (task as unknown as { ownership_epoch?: number }).ownership_epoch ?? 1;
      if (taskEpoch !== auth.task_ownership_epoch) {
        throw new McpAuthorityError(
          'MCP_AUTHORITY_FENCED',
          `Task ownership epoch ${taskEpoch} does not match authorization epoch ${auth.task_ownership_epoch}`
        );
      }

      // 8. Canonical payload is a strict object with no unknown fields
      if (!auth.canonical_payload_json || auth.canonical_payload_json.trim() === '') {
        throw new McpAuthorityError('MCP_CONTEXT_INTEGRITY_FAILED', 'Canonical execution payload JSON is missing');
      }
      let rawPayload: unknown;
      try {
        rawPayload = JSON.parse(auth.canonical_payload_json);
      } catch (err) {
        throw new McpAuthorityError('MCP_CONTEXT_INTEGRITY_FAILED', 'Malformed canonical execution payload JSON');
      }
      const schemaValidation = CanonicalExecutionPayloadSchema.safeParse(rawPayload);
      if (!schemaValidation.success) {
        throw new McpAuthorityError('MCP_CONTEXT_INTEGRITY_FAILED', 'Canonical execution payload schema validation failed');
      }
      const payload: CanonicalExecutionPayload = schemaValidation.data;

      // 9. Payload identifiers match authorization
      if (
        payload.projectId !== auth.project_id ||
        payload.taskId !== auth.task_id ||
        payload.attemptId !== auth.attempt_id ||
        payload.managerMessageId !== auth.manager_message_id ||
        payload.managerPayloadHash !== auth.manager_payload_hash
      ) {
        throw new McpAuthorityError('MCP_CONTEXT_INTEGRITY_FAILED', 'Payload identifiers mismatch with authorization bindings');
      }

      // 10. instruction_payload_hash recomputes exactly
      const recomputedPayloadHash = computePayloadHash(payload);
      if (recomputedPayloadHash !== auth.instruction_payload_hash) {
        throw new McpAuthorityError('MCP_CONTEXT_INTEGRITY_FAILED', 'Instruction payload hash recomputation mismatch');
      }

      // 11. context_manifest_hash recomputes exactly from frozen context file list
      const recomputedManifestHash = computeContextManifestHash(payload.contextFiles);
      if (recomputedManifestHash !== auth.context_manifest_hash) {
        throw new McpAuthorityError('MCP_CONTEXT_INTEGRITY_FAILED', 'Context manifest hash recomputation mismatch');
      }

      // 12. No unrevoked session already exists
      const existingSession = this.repo.getActiveMcpClientSessionByAuthorizationId(auth.id);
      if (existingSession) {
        throw new McpAuthorityError(
          'MCP_AUTHORITY_FENCED',
          `An active unrevoked session already exists for authorization "${auth.id}"`
        );
      }

      // Generate credentials & metadata inside transaction
      const plaintextToken = McpSessionAuthorityService.generateSessionToken();
      const tokenHash = McpSessionAuthorityService.hashSessionToken(plaintextToken);
      const authorizationFingerprint = computeAuthorizationFingerprint(auth);
      const issuedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
      const sessionId = crypto.randomUUID();

      const session: McpClientSession = {
        id: sessionId,
        authorization_id: auth.id,
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

    return runTx();
  }

  /**
   * Idempotently revokes an active session by session ID or authorization ID.
   */
  public revokeSession(params: RevokeSessionParams): RevokeSessionResult {
    if (!params.sessionId && !params.authorizationId) {
      throw new McpAuthorityError('MCP_CONFIGURATION_INVALID', 'Must provide sessionId or authorizationId to revoke');
    }

    const revokedAt = new Date().toISOString();
    const revoked = this.repo.revokeMcpClientSession({
      sessionId: params.sessionId,
      authorizationId: params.authorizationId,
      revokedAt,
    });

    return { revoked };
  }

  /**
   * Authenticates a session token and resolves the authorized context within a read transaction.
   * Public errors are non-oracular.
   */
  public resolveAuthorizedContext(token: string | undefined): AuthorizedContextResponse {
    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      throw new McpAuthorityError('MCP_SESSION_REQUIRED', 'Missing AGENTFORGE_MCP_SESSION_TOKEN environment variable');
    }

    const tokenHash = McpSessionAuthorityService.hashSessionToken(token.trim());

    // Execute within a single read transaction
    const readTx = this.db.transaction((): AuthorizedContextResponse => {
      // 1. Look up session by token hash
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

      // 2. Load execution authorization
      const auth = this.repo.getExecutionAuthorization(session.authorization_id);
      if (!auth || auth.lifecycle_version !== 1) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Authorization is not currently accessible');
      }

      if (auth.status !== 'AUTHORIZED' && auth.status !== 'DISPATCHED') {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Authorization is not in active state');
      }

      if (auth.settlement_status != null) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Authorization has terminal settlement');
      }

      // 3. Verify task ownership epoch and assignment status
      const task = this.repo.getTask(auth.task_id);
      if (!task) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Task is not accessible');
      }
      const taskEpoch = (task as unknown as { ownership_epoch?: number }).ownership_epoch ?? 1;
      if (taskEpoch !== auth.task_ownership_epoch) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Task ownership epoch has changed');
      }

      if (!auth.assignment_id) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Assignment reference missing');
      }
      const assignment = this.repo.getAgentAssignment(auth.assignment_id);
      if (!assignment || (assignment.status !== 'ASSIGNED' && assignment.status !== 'RUNNING')) {
        throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Assignment is no longer active');
      }

      // 4. Recompute and compare authorization fingerprint
      const computedFingerprint = computeAuthorizationFingerprint(auth);
      if (computedFingerprint !== session.authorization_fingerprint) {
        throw new McpAuthorityError('MCP_CONTEXT_INTEGRITY_FAILED', 'Authorization fingerprint integrity verification failed');
      }

      // 5. Parse and validate canonical execution payload
      if (!auth.canonical_payload_json || auth.canonical_payload_json.trim() === '') {
        throw new McpAuthorityError('MCP_CONTEXT_INTEGRITY_FAILED', 'Canonical execution payload is missing');
      }

      let rawPayload: unknown;
      try {
        rawPayload = JSON.parse(auth.canonical_payload_json);
      } catch {
        throw new McpAuthorityError('MCP_CONTEXT_INTEGRITY_FAILED', 'Malformed canonical execution payload JSON');
      }

      const schemaValidation = CanonicalExecutionPayloadSchema.safeParse(rawPayload);
      if (!schemaValidation.success) {
        throw new McpAuthorityError('MCP_CONTEXT_INTEGRITY_FAILED', 'Canonical execution payload schema invalid');
      }
      const payload = schemaValidation.data;

      if (
        payload.projectId !== auth.project_id ||
        payload.taskId !== auth.task_id ||
        payload.attemptId !== auth.attempt_id ||
        payload.managerMessageId !== auth.manager_message_id ||
        payload.managerPayloadHash !== auth.manager_payload_hash
      ) {
        throw new McpAuthorityError('MCP_CONTEXT_INTEGRITY_FAILED', 'Payload identifier mismatch');
      }

      if (computePayloadHash(payload) !== auth.instruction_payload_hash) {
        throw new McpAuthorityError('MCP_CONTEXT_INTEGRITY_FAILED', 'Instruction payload hash mismatch');
      }

      if (computeContextManifestHash(payload.contextFiles) !== auth.context_manifest_hash) {
        throw new McpAuthorityError('MCP_CONTEXT_INTEGRITY_FAILED', 'Context manifest hash mismatch');
      }

      // 6. Return strictly sanitized, non-secret response
      const response: AuthorizedContextResponse = {
        schema_version: 2,
        session: {
          id: session.id,
          scope: session.scope,
          issued_at: session.issued_at,
          expires_at: session.expires_at,
        },
        authorization: {
          id: auth.id,
          project_id: auth.project_id,
          task_id: auth.task_id,
          attempt_id: auth.attempt_id,
          assignment_id: auth.assignment_id,
          task_ownership_epoch: auth.task_ownership_epoch ?? 1,
          lifecycle_version: 1,
          routing_decision_id: auth.routing_decision_id,
          selected_provider_id: auth.selected_provider_id,
          selected_account_id: auth.selected_account_id ?? '',
          selected_resource_id: auth.selected_resource_id,
          task_revision: auth.task_revision,
          base_sha: auth.base_sha,
          repository_head_sha: auth.repository_head_sha,
          manager_message_id: auth.manager_message_id,
          manager_payload_hash: auth.manager_payload_hash,
          status: auth.status,
          created_at: auth.created_at,
          dispatched_at: auth.dispatched_at,
        },
        execution_payload: payload as unknown as Record<string, unknown>,
        instruction_payload_hash: auth.instruction_payload_hash,
        context_manifest_hash: auth.context_manifest_hash,
      };

      return response;
    });

    return readTx();
  }
}
