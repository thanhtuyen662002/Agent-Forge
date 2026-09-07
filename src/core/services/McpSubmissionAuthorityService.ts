import crypto from 'crypto';
import child_process from 'child_process';
import Database from 'better-sqlite3';
import {
  Repository,
  McpSubmissionSession,
  CoderSubmission,
  CoderSubmissionDisposition,
} from '../database/repositories';
import {
  SubmissionErrorCode,
  SubmissionResult,
  CoderSubmissionInput,
  CoderSubmissionInputZodSchema,
  validateSubmissionToken,
  computeSha256,
  canonicalJsonStringify,
  computeClaimContentHash,
  computeAuthorityFingerprint,
  computeCanonicalEnvelope,
  deriveDeterministicEventId,
  CLAIM_CONTENT_KEYS,
  CANONICAL_ENVELOPE_KEYS,
  MAX_ARGUMENT_BYTES,
} from '../../mcp/submissionProtocol';

export class McpSubmissionAuthorityError extends Error {
  constructor(
    public readonly code: SubmissionErrorCode,
    message: string,
    public readonly retryable: boolean = false
  ) {
    super(message);
    this.name = 'McpSubmissionAuthorityError';
  }
}

export class McpSubmissionAuthorityService {
  constructor(
    private readonly repo: Repository,
    private readonly db: Database.Database
  ) {}

  /**
   * Authoritative entrypoint for coder claim submission.
   * Executes the 11-step linearized algorithm from Section 7.
   */
  public submitCoderClaim(rawArgs: unknown, token?: string): SubmissionResult {
    // 1. Compute canonical argument bytes and enforce 64 KiB cap
    let canonicalArgsJson = '';
    try {
      canonicalArgsJson = canonicalJsonStringify(rawArgs);
    } catch {
      // If rawArgs is malformed or cannot be canonicalized, let strict parse handle it
      canonicalArgsJson = JSON.stringify(rawArgs ?? {});
    }

    const canonicalBytes = Buffer.byteLength(canonicalArgsJson, 'utf8');
    if (canonicalBytes > MAX_ARGUMENT_BYTES) {
      return {
        accepted: false,
        error_code: 'CLAIM_ARGUMENTS_TOO_LARGE',
        message: `Canonical UTF-8 argument size (${canonicalBytes} bytes) exceeds maximum limit of ${MAX_ARGUMENT_BYTES} bytes`,
        retryable: false,
      };
    }

    // 2. Strict-parse input and normalize arrays
    const parseResult = CoderSubmissionInputZodSchema.safeParse(rawArgs);
    if (!parseResult.success) {
      return {
        accepted: false,
        error_code: 'SCHEMA_VALIDATION_FAILED',
        message: `Schema validation failed: ${parseResult.error.errors.map((e) => e.message).join('; ')}`,
        retryable: false,
      };
    }
    const input: CoderSubmissionInput = parseResult.data;

    // 3. Validate exact environment token format and hash it
    if (!token || typeof token !== 'string' || !validateSubmissionToken(token)) {
      return {
        accepted: false,
        error_code: 'INVALID_SUBMISSION_TOKEN',
        message: 'Invalid or missing submission token',
        retryable: false,
      };
    }
    const tokenHash = computeSha256(token);

    // 4. Preliminary authentication and binding checks outside transaction (using preflightNowIso)
    // Ensures invalid callers cannot spawn Git
    try {
      const preflightNowIso = new Date().toISOString();
      const session = this.repo.getMcpSubmissionSessionByTokenHash(tokenHash);
      if (!session) {
        // Cross-table credentials from mcp_client_sessions return INVALID_SUBMISSION_TOKEN per Section 2.4
        return {
          accepted: false,
          error_code: 'INVALID_SUBMISSION_TOKEN',
          message: 'Session token not found or invalid for coder submission',
          retryable: false,
        };
      }

      if (session.revoked_at !== null) {
        return {
          accepted: false,
          error_code: 'MCP_SESSION_REVOKED',
          message: 'Submission session has been revoked',
          retryable: false,
        };
      }

      if (session.expires_at <= preflightNowIso) {
        return {
          accepted: false,
          error_code: 'MCP_SESSION_EXPIRED',
          message: 'Submission session has expired',
          retryable: false,
        };
      }

      // Check if this is an idempotent replay candidate outside transaction
      // If so, NEVER spawn Git per Section 5.6
      const preliminaryExisting = this.repo.getCoderSubmissionById(input.submission_id);

      let observedHeadSha = '';
      if (!preliminaryExisting) {
        // Preliminary authorization binding check before spawning Git
        const preflightAuth = this.repo.getExecutionAuthorization(session.authorization_id);
        if (!preflightAuth) {
          return {
            accepted: false,
            error_code: 'MCP_AUTHORITY_FENCED',
            message: 'Execution authorization for session does not exist',
            retryable: false,
          };
        }

        const preflightProject = this.repo.getProject(preflightAuth.project_id);
        if (!preflightProject || !preflightProject.repository_path) {
          return {
            accepted: false,
            error_code: 'MCP_AUTHORITY_FENCED',
            message: 'Project repository path missing or invalid',
            retryable: false,
          };
        }

        // 5. Synchronously inspect git rev-parse HEAD with bounded timeout and closed stdio
        try {
          const gitOutput = child_process.execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: preflightProject.repository_path,
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf8',
          });
          observedHeadSha = gitOutput.trim().toLowerCase();
          if (!/^[0-9a-f]{40}$/.test(observedHeadSha)) {
            throw new Error('Malformed git rev-parse HEAD output');
          }
        } catch (err: unknown) {
          return {
            accepted: false,
            error_code: 'MCP_AUTHORITY_FENCED',
            message: 'Synchronous git rev-parse HEAD inspection failed',
            retryable: false,
          };
        }
      }

      // 6. Enter Repository.runInImmediateTransaction (strictly synchronous callback)
      return this.repo.runInImmediateTransaction<SubmissionResult>(() => {
        // Record total changes at start of transaction to prove replay makes zero mutations
        const totalChangesBefore = (
          this.db.prepare('SELECT total_changes() AS c').get() as { c: number }
        ).c;

        // 7. Fresh in-transaction clock inside callback (Authoritative Section 2.3)
        const transactionNowIso = new Date().toISOString();

        // Reload and revalidate session against fresh transaction clock
        const currentSession = this.repo.getMcpSubmissionSessionById(session.id);
        if (!currentSession || currentSession.revoked_at !== null) {
          throw new McpSubmissionAuthorityError('MCP_SESSION_REVOKED', 'Session has been revoked');
        }
        if (currentSession.expires_at <= transactionNowIso) {
          throw new McpSubmissionAuthorityError('MCP_SESSION_EXPIRED', 'Session expired during preliminary inspection');
        }

        // Check if submission_id already exists in coder_submissions
        const existing = this.repo.getCoderSubmissionById(input.submission_id);
        if (existing) {
          // ===================================================================
          // 7.2 EXACT REPLAY PATH
          // ===================================================================
          const replayResult = this.executeReplayPath(input, existing, currentSession);
          const totalChangesAfter = (
            this.db.prepare('SELECT total_changes() AS c').get() as { c: number }
          ).c;
          if (totalChangesAfter !== totalChangesBefore) {
            throw new McpSubmissionAuthorityError(
              'SUBMISSION_INTEGRITY_CONFLICT',
              'Replay path caused non-zero database mutations'
            );
          }
          return replayResult;
        } else {
          // If we had no preliminaryExisting, observedHeadSha was computed.
          // If we somehow missed it, fail closed.
          if (!observedHeadSha) {
            throw new McpSubmissionAuthorityError(
              'INTERNAL_SUBMISSION_ERROR',
              'Observed Git HEAD missing for new submission'
            );
          }
          // ===================================================================
          // 7.1 NEW SUBMISSION PATH
          // ===================================================================
          return this.executeNewSubmissionPath(
            input,
            currentSession,
            observedHeadSha,
            transactionNowIso,
            canonicalBytes
          );
        }
      });
    } catch (err: unknown) {
      if (err instanceof McpSubmissionAuthorityError) {
        return {
          accepted: false,
          error_code: err.code,
          message: err.message,
          retryable: err.retryable,
        };
      }
      const errString = String(err);
      if (errString.includes('SQLITE_BUSY') || errString.includes('database is locked')) {
        return {
          accepted: false,
          error_code: 'DATABASE_BUSY',
          message: 'Database is locked or busy under concurrent write transaction',
          retryable: true,
        };
      }
      return {
        accepted: false,
        error_code: 'INTERNAL_SUBMISSION_ERROR',
        message: 'Internal error processing coder submission',
        retryable: false,
      };
    }
  }

  /**
   * Executes the exact replay path (Section 7.2).
   * Verifies stored integrity, checks identical caller content, and performs zero mutations.
   */
  private executeReplayPath(
    input: CoderSubmissionInput,
    existing: CoderSubmission,
    session: McpSubmissionSession
  ): SubmissionResult {
    // Replay is evaluated only for the same authenticated session
    if (existing.session_id !== session.id || existing.authorization_id !== session.authorization_id) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_INTEGRITY_CONFLICT',
        'Submission ID was issued to a different session or authorization'
      );
    }

    // Session issuer must be OWNER_LOCAL_CLI
    if (session.issuer_identity !== 'OWNER_LOCAL_CLI') {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_INTEGRITY_CONFLICT',
        'Session issuer identity is not OWNER_LOCAL_CLI'
      );
    }

    // Parse stored JSON documents as plain objects
    let storedContent: Record<string, unknown>;
    let storedEnvelope: Record<string, unknown>;
    try {
      storedContent = JSON.parse(existing.claim_content_json);
      storedEnvelope = JSON.parse(existing.canonical_envelope_json);
    } catch {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_INTEGRITY_CONFLICT',
        'Stored JSON document syntax error'
      );
    }

    if (
      typeof storedContent !== 'object' ||
      storedContent === null ||
      Array.isArray(storedContent) ||
      typeof storedEnvelope !== 'object' ||
      storedEnvelope === null ||
      Array.isArray(storedEnvelope)
    ) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_INTEGRITY_CONFLICT',
        'Stored JSON document is not a plain JSON object'
      );
    }

    // Verify exact 7 content keys and exact 28 envelope keys
    const contentKeys = Object.keys(storedContent).sort();
    if (contentKeys.length !== 7 || contentKeys.some((k, i) => k !== CLAIM_CONTENT_KEYS[i])) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_INTEGRITY_CONFLICT',
        `Stored content keys mismatch: expected 7 keys, found ${contentKeys.length}`
      );
    }

    const envelopeKeys = Object.keys(storedEnvelope).sort();
    if (envelopeKeys.length !== 28 || envelopeKeys.some((k, i) => k !== CANONICAL_ENVELOPE_KEYS[i])) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_INTEGRITY_CONFLICT',
        `Stored envelope keys mismatch: expected 28 keys, found ${envelopeKeys.length}`
      );
    }

    // Recanonicalize both objects and verify stored canonical text is byte-for-byte identical
    const recomputedContentJson = canonicalJsonStringify(storedContent);
    if (recomputedContentJson !== existing.claim_content_json) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_INTEGRITY_CONFLICT',
        'Stored claim content JSON text is not byte-identical to recanonicalized representation'
      );
    }
    const recomputedContentHash = computeSha256(recomputedContentJson);
    if (recomputedContentHash !== existing.claim_content_hash) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_INTEGRITY_CONFLICT',
        'Stored claim content hash recomputation mismatch'
      );
    }

    const recomputedEnvelopeJson = canonicalJsonStringify(storedEnvelope);
    if (recomputedEnvelopeJson !== existing.canonical_envelope_json) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_INTEGRITY_CONFLICT',
        'Stored canonical envelope JSON text is not byte-identical to recanonicalized representation'
      );
    }
    const recomputedEnvelopeHash = computeSha256(recomputedEnvelopeJson);
    if (recomputedEnvelopeHash !== existing.canonical_envelope_hash) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_INTEGRITY_CONFLICT',
        'Stored canonical envelope hash recomputation mismatch'
      );
    }

    // Compare all 28 canonical envelope keys against durable row columns
    const envelopeFieldChecks: Array<[string, unknown, unknown]> = [
      ['assignment_id', existing.assignment_id, storedEnvelope.assignment_id],
      ['attempt_id', existing.attempt_id, storedEnvelope.attempt_id],
      ['authority_fingerprint', existing.authority_fingerprint, storedEnvelope.authority_fingerprint],
      ['authorization_id', existing.authorization_id, storedEnvelope.authorization_id],
      ['authorization_status', existing.authorization_status, storedEnvelope.authorization_status],
      ['authorized_head_sha', existing.authorized_head_sha, storedEnvelope.authorized_head_sha],
      ['base_sha', existing.base_sha, storedEnvelope.base_sha],
      ['canonical_arguments_bytes', existing.canonical_arguments_bytes, storedEnvelope.canonical_arguments_bytes],
      ['claim_content_hash', existing.claim_content_hash, storedEnvelope.claim_content_hash],
      ['claimed_status', existing.claimed_status, storedEnvelope.claimed_status],
      ['dispatched_at', existing.dispatched_at, storedEnvelope.dispatched_at],
      ['execution_id', existing.execution_id, storedEnvelope.execution_id],
      ['lifecycle_version', existing.lifecycle_version, storedEnvelope.lifecycle_version],
      ['manager_message_id', existing.manager_message_id, storedEnvelope.manager_message_id],
      ['manager_payload_hash', existing.manager_payload_hash, storedEnvelope.manager_payload_hash],
      ['project_id', existing.project_id, storedEnvelope.project_id],
      ['quarantine_status', existing.quarantine_status, storedEnvelope.quarantine_status],
      ['routing_decision_id', existing.routing_decision_id, storedEnvelope.routing_decision_id],
      ['schema_version', existing.schema_version, storedEnvelope.schema_version],
      ['selected_account_id', existing.selected_account_id, storedEnvelope.selected_account_id],
      ['selected_provider_id', existing.selected_provider_id, storedEnvelope.selected_provider_id],
      ['selected_resource_id', existing.selected_resource_id, storedEnvelope.selected_resource_id],
      ['session_id', existing.session_id, storedEnvelope.session_id],
      ['submission_id', existing.id, storedEnvelope.submission_id],
      ['submitted_at', existing.submitted_at, storedEnvelope.submitted_at],
      ['task_id', existing.task_id, storedEnvelope.task_id],
      ['task_ownership_epoch', existing.task_ownership_epoch, storedEnvelope.task_ownership_epoch],
      ['task_revision', existing.task_revision, storedEnvelope.task_revision],
    ];

    for (const [colName, rowVal, envVal] of envelopeFieldChecks) {
      if (rowVal !== envVal) {
        throw new McpSubmissionAuthorityError(
          'SUBMISSION_INTEGRITY_CONFLICT',
          `Scalar mismatch between row column "${colName}" and envelope: ${rowVal} vs ${envVal}`
        );
      }
    }

    // Verify row scalars against content object
    if (existing.summary !== storedContent.summary) {
      throw new McpSubmissionAuthorityError('SUBMISSION_INTEGRITY_CONFLICT', 'Row summary does not match content summary');
    }
    if (existing.claimed_status !== storedContent.status) {
      throw new McpSubmissionAuthorityError('SUBMISSION_INTEGRITY_CONFLICT', 'Row claimed_status does not match content status');
    }
    if (existing.review_requested !== (storedContent.review_requested ? 1 : 0)) {
      throw new McpSubmissionAuthorityError('SUBMISSION_INTEGRITY_CONFLICT', 'Row review_requested does not match content review_requested');
    }
    const changedFilesArr = Array.isArray(storedContent.changed_files) ? storedContent.changed_files : [];
    if (existing.changed_files_count !== changedFilesArr.length) {
      throw new McpSubmissionAuthorityError('SUBMISSION_INTEGRITY_CONFLICT', 'Row changed_files_count does not match content array length');
    }
    const testsClaimedArr = Array.isArray(storedContent.tests_claimed) ? storedContent.tests_claimed : [];
    if (existing.tests_claimed_count !== testsClaimedArr.length) {
      throw new McpSubmissionAuthorityError('SUBMISSION_INTEGRITY_CONFLICT', 'Row tests_claimed_count does not match content array length');
    }
    const blockersArr = Array.isArray(storedContent.blockers) ? storedContent.blockers : [];
    if (existing.blockers_count !== blockersArr.length) {
      throw new McpSubmissionAuthorityError('SUBMISSION_INTEGRITY_CONFLICT', 'Row blockers_count does not match content array length');
    }

    // Envelope and row fingerprint must equal authenticated session's stored commitment
    if (existing.authority_fingerprint !== session.authorization_fingerprint) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_INTEGRITY_CONFLICT',
        'Row authority fingerprint does not match session commitment'
      );
    }
    if (storedEnvelope.authority_fingerprint !== session.authorization_fingerprint) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_INTEGRITY_CONFLICT',
        'Envelope authority fingerprint does not match session commitment'
      );
    }

    // Compare normalized incoming content to durable row/envelope
    const { hash: incomingContentHash, canonicalJson: incomingContentJson } = computeClaimContentHash({
      summary: input.summary,
      status: input.status,
      changed_files: input.changed_files,
      tests_claimed: input.tests_claimed,
      blockers: input.blockers,
      review_requested: input.review_requested,
      client_metadata: input.client_metadata,
    });

    if (incomingContentHash !== existing.claim_content_hash || incomingContentJson !== existing.claim_content_json) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_ID_COLLISION_CONTENT_MISMATCH',
        'Submission ID already exists with different claim content'
      );
    }

    // Compare all caller-supplied authority bindings
    if (input.authorization_id !== existing.authorization_id) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_ID_COLLISION_CONTENT_MISMATCH',
        'Caller authorization_id mismatch on replay'
      );
    }
    if (input.project_id !== existing.project_id) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_ID_COLLISION_CONTENT_MISMATCH',
        'Caller project_id mismatch on replay'
      );
    }
    if (input.task_id !== existing.task_id) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_ID_COLLISION_CONTENT_MISMATCH',
        'Caller task_id mismatch on replay'
      );
    }
    if (input.task_ownership_epoch !== existing.task_ownership_epoch) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_ID_COLLISION_CONTENT_MISMATCH',
        'Caller task_ownership_epoch mismatch on replay'
      );
    }
    if (input.attempt_id !== existing.attempt_id) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_ID_COLLISION_CONTENT_MISMATCH',
        'Caller attempt_id mismatch on replay'
      );
    }
    if (input.assignment_id !== existing.assignment_id) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_ID_COLLISION_CONTENT_MISMATCH',
        'Caller assignment_id mismatch on replay'
      );
    }
    if (input.base_sha.toLowerCase() !== existing.base_sha.toLowerCase()) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_ID_COLLISION_CONTENT_MISMATCH',
        'Caller base_sha mismatch on replay'
      );
    }
    if (input.repository_head_sha.toLowerCase() !== existing.authorized_head_sha.toLowerCase()) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_ID_COLLISION_CONTENT_MISMATCH',
        'Caller repository_head_sha mismatch on replay'
      );
    }
    if (input.status !== existing.claimed_status) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_ID_COLLISION_CONTENT_MISMATCH',
        'Caller status mismatch on replay'
      );
    }
    if (input.summary !== existing.summary) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_ID_COLLISION_CONTENT_MISMATCH',
        'Caller summary mismatch on replay'
      );
    }
    if ((input.review_requested ? 1 : 0) !== existing.review_requested) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_ID_COLLISION_CONTENT_MISMATCH',
        'Caller review_requested mismatch on replay'
      );
    }

    // Require exactly one SUBMITTED / INITIAL_SUBMISSION disposition with the same timestamp
    const disps = this.repo.getCoderSubmissionDispositions(existing.id);
    const initialDisp = this.repo.getInitialCoderSubmissionDisposition(existing.id);
    if (!initialDisp || initialDisp.created_at !== existing.submitted_at || disps.length !== 1) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_INTEGRITY_CONFLICT',
        'Initial submission disposition missing, corrupted, or duplicated'
      );
    }
    if (
      initialDisp.submission_id !== existing.id ||
      initialDisp.disposition_event !== 'SUBMITTED' ||
      initialDisp.disposition_reason !== 'INITIAL_SUBMISSION' ||
      initialDisp.actor_type !== 'MCP_CLIENT' ||
      initialDisp.actor_id !== session.id
    ) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_INTEGRITY_CONFLICT',
        'Initial submission disposition attributes mismatch'
      );
    }

    // Verify disposition metadata canonical JSON and keys
    if (!initialDisp.disposition_metadata_json) {
      throw new McpSubmissionAuthorityError('SUBMISSION_INTEGRITY_CONFLICT', 'Disposition metadata JSON is missing');
    }
    let dispMeta: Record<string, unknown>;
    try {
      dispMeta = JSON.parse(initialDisp.disposition_metadata_json);
    } catch {
      throw new McpSubmissionAuthorityError('SUBMISSION_INTEGRITY_CONFLICT', 'Disposition metadata JSON syntax error');
    }
    if (typeof dispMeta !== 'object' || dispMeta === null || Array.isArray(dispMeta)) {
      throw new McpSubmissionAuthorityError('SUBMISSION_INTEGRITY_CONFLICT', 'Disposition metadata is not an object');
    }
    const dispMetaKeys = Object.keys(dispMeta).sort();
    const expectedDispMetaKeys = ['client_name', 'client_session_mode', 'client_version'];
    if (
      dispMetaKeys.length !== expectedDispMetaKeys.length ||
      dispMetaKeys.some((k, i) => k !== expectedDispMetaKeys[i])
    ) {
      throw new McpSubmissionAuthorityError('SUBMISSION_INTEGRITY_CONFLICT', 'Disposition metadata keys mismatch');
    }
    if (canonicalJsonStringify(dispMeta) !== initialDisp.disposition_metadata_json) {
      throw new McpSubmissionAuthorityError('SUBMISSION_INTEGRITY_CONFLICT', 'Disposition metadata JSON is not canonical');
    }
    if (
      dispMeta.client_name !== (input.client_metadata.client_name ?? null) ||
      dispMeta.client_version !== (input.client_metadata.client_version ?? null) ||
      dispMeta.client_session_mode !== (input.client_metadata.client_session_mode ?? null)
    ) {
      throw new McpSubmissionAuthorityError('SUBMISSION_ID_COLLISION_CONTENT_MISMATCH', 'Client metadata mismatch on replay');
    }

    // Load deterministic event and verify its exact identity and payload
    const eventId = deriveDeterministicEventId(existing.id);
    const event = this.repo.getDeterministicEvent(eventId);
    if (!event) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_INTEGRITY_CONFLICT',
        `Deterministic event "${eventId}" missing for submission`
      );
    }
    if (
      event.type !== 'CODER_SUBMISSION_QUARANTINED' ||
      event.project_id !== existing.project_id ||
      event.task_id !== existing.task_id ||
      event.timestamp !== existing.submitted_at ||
      event.summary !== 'Quarantined untrusted coder claim and report'
    ) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_INTEGRITY_CONFLICT',
        'Deterministic event fields mismatch durable submission'
      );
    }

    let parsedEventPayload: Record<string, unknown>;
    try {
      parsedEventPayload = JSON.parse(event.structured_payload_json ?? '{}');
    } catch {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_INTEGRITY_CONFLICT',
        'Deterministic event structured payload is malformed JSON'
      );
    }
    if (typeof parsedEventPayload !== 'object' || parsedEventPayload === null || Array.isArray(parsedEventPayload)) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_INTEGRITY_CONFLICT',
        'Deterministic event payload is not a plain object'
      );
    }
    const eventPayloadKeys = Object.keys(parsedEventPayload).sort();
    const expectedEventKeys = [
      'canonical_envelope_hash',
      'claim_content_hash',
      'claimed_status',
      'submission_id',
      'submitted_at',
    ];
    if (
      eventPayloadKeys.length !== 5 ||
      eventPayloadKeys.some((k, i) => k !== expectedEventKeys[i])
    ) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_INTEGRITY_CONFLICT',
        'Deterministic event payload keys mismatch expected domain'
      );
    }
    if (canonicalJsonStringify(parsedEventPayload) !== event.structured_payload_json) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_INTEGRITY_CONFLICT',
        'Deterministic event structured payload is not canonical JSON'
      );
    }
    if (
      parsedEventPayload.submission_id !== existing.id ||
      parsedEventPayload.claim_content_hash !== existing.claim_content_hash ||
      parsedEventPayload.canonical_envelope_hash !== existing.canonical_envelope_hash ||
      parsedEventPayload.claimed_status !== existing.claimed_status ||
      parsedEventPayload.submitted_at !== existing.submitted_at
    ) {
      throw new McpSubmissionAuthorityError(
        'SUBMISSION_INTEGRITY_CONFLICT',
        'Deterministic event payload contents mismatch durable submission'
      );
    }

    // Replay performs zero mutations
    return {
      accepted: true,
      submission_id: existing.id,
      quarantine_status: 'QUARANTINED',
      claim_content_hash: existing.claim_content_hash,
      canonical_envelope_hash: existing.canonical_envelope_hash,
      submitted_at: existing.submitted_at,
      is_duplicate: true,
    };
  }

  /**
   * Executes the new submission path (Section 7.1).
   * Verifies complete durable live graph, inserts 3 records in single transaction.
   */
  private executeNewSubmissionPath(
    input: CoderSubmissionInput,
    session: McpSubmissionSession,
    observedHeadSha: string,
    transactionNowIso: string,
    canonicalBytes: number
  ): SubmissionResult {
    // Session issuer must be OWNER_LOCAL_CLI
    if (session.issuer_identity !== 'OWNER_LOCAL_CLI') {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Session issuer identity must be OWNER_LOCAL_CLI');
    }

    // 1. Load authorization
    const auth = this.repo.getExecutionAuthorization(session.authorization_id);
    if (!auth) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Authorization does not exist');
    }

    // Authorization must be DISPATCHED, unsettled, with dispatch timestamp
    if (auth.status !== 'DISPATCHED') {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', `Authorization status is not DISPATCHED (got ${auth.status})`);
    }
    if (auth.settlement_status !== null || auth.settled_at !== null) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Authorization is already settled');
    }
    if (!auth.dispatched_at) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Authorization is missing dispatched_at timestamp');
    }

    // Caller authorization_id check
    if (input.authorization_id !== auth.id) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Caller-supplied authorization_id mismatch');
    }

    // 2. Project must exist and be active (RUNNING)
    const project = this.repo.getProject(auth.project_id);
    if (!project || project.status !== 'RUNNING') {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Project is missing or not active');
    }
    if (!project.repository_path) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Project repository path is missing');
    }
    if (input.project_id !== project.id || project.id !== auth.project_id) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Caller-supplied project_id mismatch');
    }

    // 3. Task must exist, belong to project, and be in CODING or HANDOFF_REQUIRED
    const task = this.repo.getTask(auth.task_id);
    if (!task || task.project_id !== project.id) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Task is missing or does not belong to project');
    }
    if (task.state !== 'CODING' && task.state !== 'HANDOFF_REQUIRED') {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', `Task state "${task.state}" is not receptive (CODING or HANDOFF_REQUIRED)`);
    }
    if (input.task_id !== task.id || task.id !== auth.task_id) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Caller-supplied task_id mismatch');
    }

    // Task revision count must match authorization
    if (task.revision_count !== auth.task_revision) {
      throw new McpSubmissionAuthorityError(
        'MCP_AUTHORITY_FENCED',
        `Task revision count (${task.revision_count}) mismatches authorization (${auth.task_revision})`
      );
    }

    // Positive ownership epoch must match both input and authorization
    const taskEpoch = task.ownership_epoch ?? 0;
    if (taskEpoch <= 0 || taskEpoch !== auth.task_ownership_epoch) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Task ownership epoch is non-positive or mismatches authorization');
    }
    if (input.task_ownership_epoch !== taskEpoch) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Caller-supplied task ownership epoch mismatch');
    }

    // 4. Lifecycle relationships
    if (auth.lifecycle_version === 1) {
      if (!auth.execution_id || !auth.attempt_id || !auth.assignment_id || !auth.selected_account_id) {
        throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Lifecycle v1 requires non-null execution, attempt, assignment, and account');
      }
      if (input.attempt_id === null || input.assignment_id === null) {
        throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Lifecycle v1 requires non-null attempt_id and assignment_id in caller input');
      }
      if (input.attempt_id !== auth.attempt_id) {
        throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Caller attempt_id does not match authorization');
      }
      if (input.assignment_id !== auth.assignment_id) {
        throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Caller assignment_id does not match authorization');
      }
    } else {
      // Legacy lifecycle: attempt_id and assignment_id may be null, but if present in auth, must match
      if (input.attempt_id !== (auth.attempt_id ?? null)) {
        throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Caller attempt_id does not match legacy authorization');
      }
      if (input.assignment_id !== (auth.assignment_id ?? null)) {
        throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Caller assignment_id does not match legacy authorization');
      }
    }

    // Attempt validation
    if (auth.attempt_id) {
      const attempt = this.repo.getTaskAttempt(auth.attempt_id);
      if (!attempt || attempt.task_id !== task.id || attempt.status !== 'RUNNING') {
        throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Attempt is missing, wrong task, or not RUNNING');
      }
    }

    // Assignment validation
    if (auth.assignment_id) {
      const assignment = this.repo.getAgentAssignment(auth.assignment_id);
      if (!assignment || assignment.task_id !== task.id) {
        throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Assignment missing or does not belong to task');
      }
      if (assignment.status !== 'RUNNING' && assignment.status !== 'ASSIGNED') {
        throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', `Assignment status "${assignment.status}" not active`);
      }
      if (auth.attempt_id && assignment.attempt_id !== auth.attempt_id) {
        throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Assignment attempt_id does not match authorization attempt_id');
      }
      if (assignment.selected_provider_id !== auth.selected_provider_id) {
        throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Assignment provider does not match authorization provider');
      }
      if (assignment.selected_resource_id !== auth.selected_resource_id) {
        throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Assignment resource does not match authorization resource');
      }
      if ((assignment.selected_account_id ?? null) !== (auth.selected_account_id ?? null)) {
        throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Assignment account does not match authorization account');
      }
      if (auth.routing_decision_id && assignment.routing_decision_id !== auth.routing_decision_id) {
        throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Assignment routing decision does not match authorization routing decision');
      }
    }

    // 5. Selected Provider, Resource, and Account
    const provider = this.repo.getProvider(auth.selected_provider_id);
    if (!provider || !provider.enabled) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Provider missing or disabled');
    }

    const resource = this.repo.getProviderResource(auth.selected_resource_id);
    if (!resource || resource.provider_id !== provider.id || !resource.enabled) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Resource missing, wrong provider, or disabled');
    }
    // Section 3.5 & 5.5: resource provider_account_id against selected_account_id
    if (resource.provider_account_id !== (auth.selected_account_id ?? null)) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Resource provider_account_id does not match selected_account_id');
    }

    if (auth.selected_account_id) {
      const account = this.repo.getProviderAccount(auth.selected_account_id);
      if (!account || account.provider_id !== provider.id || !account.enabled) {
        throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Account missing, wrong provider, or disabled');
      }
    }

    // 6. Routing Decision & Manager Message
    if (!auth.routing_decision_id) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Authorization missing routing_decision_id');
    }
    const routingDecision = this.repo.getRoutingDecisionEvent(auth.routing_decision_id);
    if (!routingDecision || routingDecision.task_id !== task.id) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Routing decision missing or wrong task');
    }
    if (
      routingDecision.type !== 'ROLE_AWARE_ROUTING_DECISION' &&
      routingDecision.type !== 'PROVIDER_ROUTING_DECISION'
    ) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', `Routing decision event type "${routingDecision.type}" invalid`);
    }

    // Validate routing payload selections against authorization
    const routingPayload = routingDecision.structured_payload as Record<string, unknown>;
    const routingTaskId = (routingPayload.taskId ?? routingPayload.task_id) as string | undefined;
    const routingAttemptId = (routingPayload.attemptId ?? routingPayload.attempt_id ?? null) as string | null;
    const routingProviderId = (routingPayload.selectedProviderId ?? routingPayload.selected_provider_id) as string | undefined;
    const routingResourceId = (routingPayload.selectedResourceId ?? routingPayload.selected_resource_id) as string | undefined;
    const routingAccountId = (routingPayload.selectedAccountId ?? routingPayload.selected_account_id ?? null) as string | null;

    if (routingTaskId !== task.id) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Routing decision payload task_id mismatch');
    }
    if (auth.attempt_id && routingAttemptId !== auth.attempt_id) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Routing decision payload attempt_id mismatch');
    }
    if (routingProviderId !== auth.selected_provider_id) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Routing decision payload provider mismatch');
    }
    if (routingResourceId !== auth.selected_resource_id) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Routing decision payload resource mismatch');
    }
    if (routingAccountId !== (auth.selected_account_id ?? null)) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Routing decision payload account mismatch');
    }

    if (!auth.manager_message_id) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Authorization missing manager_message_id');
    }
    const managerMsg = this.repo.getProtocolMessageByRecordId(auth.manager_message_id);
    if (!managerMsg || managerMsg.task_id !== task.id || managerMsg.protocol !== 'manager.v1' || managerMsg.status !== 'APPLIED') {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Manager protocol message missing or invalid');
    }
    const rawManagerPayload = String(managerMsg.raw_payload ?? '');
    const recomputedManagerHash = computeSha256(rawManagerPayload);
    if (recomputedManagerHash !== managerMsg.payload_hash || recomputedManagerHash !== auth.manager_payload_hash) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Manager payload hash recomputation mismatch');
    }

    // Validate manager payload schema and bindings
    let parsedManagerPayload: Record<string, unknown>;
    try {
      parsedManagerPayload = JSON.parse(rawManagerPayload);
    } catch {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Manager message raw payload is invalid JSON');
    }
    if (
      parsedManagerPayload.protocol !== 'manager.v1' ||
      parsedManagerPayload.decision !== 'EXECUTE' ||
      parsedManagerPayload.project_id !== project.id ||
      parsedManagerPayload.task_id !== task.id
    ) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Manager message payload content mismatch');
    }
    if (
      parsedManagerPayload.expected_revision !== undefined &&
      parsedManagerPayload.expected_revision !== auth.task_revision
    ) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Manager payload expected_revision mismatch');
    }

    // 7. Base and Head Git SHAs
    if (observedHeadSha !== auth.repository_head_sha.toLowerCase()) {
      throw new McpSubmissionAuthorityError('REPOSITORY_HEAD_DRIFT_DETECTED', 'Synchronously observed Git HEAD does not match authorization repository_head_sha');
    }
    if (input.repository_head_sha.toLowerCase() !== auth.repository_head_sha.toLowerCase()) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Caller repository_head_sha does not match authorization');
    }
    if (input.base_sha.toLowerCase() !== auth.base_sha.toLowerCase()) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Caller base_sha does not match authorization');
    }

    // 8. Recompute 19-field authority fingerprint and match session commitment
    const liveFingerprint = computeAuthorityFingerprint({
      assignment_id: auth.assignment_id ?? null,
      attempt_id: auth.attempt_id ?? null,
      authorization_id: auth.id,
      authorization_status: auth.status,
      base_sha: auth.base_sha,
      dispatched_at: auth.dispatched_at,
      execution_id: auth.execution_id ?? null,
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
      task_ownership_epoch: taskEpoch,
      task_revision: auth.task_revision,
    });

    if (liveFingerprint !== session.authorization_fingerprint) {
      throw new McpSubmissionAuthorityError('MCP_AUTHORITY_FENCED', 'Authority fingerprint drift detected after preliminary authentication');
    }

    // 9. Commitments calculation
    const { hash: claimContentHash, canonicalJson: claimContentJson } = computeClaimContentHash({
      summary: input.summary,
      status: input.status,
      changed_files: input.changed_files,
      tests_claimed: input.tests_claimed,
      blockers: input.blockers,
      review_requested: input.review_requested,
      client_metadata: input.client_metadata,
    });

    const { hash: canonicalEnvelopeHash, canonicalJson: canonicalEnvelopeJson } = computeCanonicalEnvelope({
      assignment_id: auth.assignment_id ?? null,
      attempt_id: auth.attempt_id ?? null,
      authority_fingerprint: liveFingerprint,
      authorization_id: auth.id,
      authorization_status: auth.status,
      authorized_head_sha: auth.repository_head_sha,
      base_sha: auth.base_sha,
      canonical_arguments_bytes: canonicalBytes,
      claim_content_hash: claimContentHash,
      claimed_status: input.status,
      dispatched_at: auth.dispatched_at,
      execution_id: auth.execution_id ?? null,
      lifecycle_version: auth.lifecycle_version ?? null,
      manager_message_id: auth.manager_message_id,
      manager_payload_hash: auth.manager_payload_hash,
      project_id: auth.project_id,
      quarantine_status: 'QUARANTINED',
      routing_decision_id: auth.routing_decision_id,
      schema_version: 1,
      selected_account_id: auth.selected_account_id ?? null,
      selected_provider_id: auth.selected_provider_id,
      selected_resource_id: auth.selected_resource_id,
      session_id: session.id,
      submission_id: input.submission_id,
      submitted_at: transactionNowIso,
      task_id: auth.task_id,
      task_ownership_epoch: taskEpoch,
      task_revision: auth.task_revision,
    });

    // 10. Single linearization point: insert all three durable records
    // 10.1 Insert coder_submissions (36 columns)
    const submissionRecord: CoderSubmission = {
      id: input.submission_id,
      authorization_id: auth.id,
      project_id: auth.project_id,
      task_id: auth.task_id,
      task_ownership_epoch: taskEpoch,
      session_id: session.id,
      schema_version: 1,
      authorization_status: auth.status,
      dispatched_at: auth.dispatched_at,
      authority_fingerprint: liveFingerprint,
      manager_payload_hash: auth.manager_payload_hash,
      task_revision: auth.task_revision,
      lifecycle_version: auth.lifecycle_version ?? null,
      execution_id: auth.execution_id ?? null,
      attempt_id: auth.attempt_id ?? null,
      assignment_id: auth.assignment_id ?? null,
      selected_provider_id: auth.selected_provider_id,
      selected_account_id: auth.selected_account_id ?? null,
      selected_resource_id: auth.selected_resource_id,
      manager_message_id: auth.manager_message_id,
      routing_decision_id: auth.routing_decision_id,
      base_sha: auth.base_sha,
      authorized_head_sha: auth.repository_head_sha,
      claimed_status: input.status,
      quarantine_status: 'QUARANTINED',
      summary: input.summary,
      changed_files_count: input.changed_files.length,
      tests_claimed_count: input.tests_claimed.length,
      blockers_count: input.blockers.length,
      review_requested: input.review_requested ? 1 : 0,
      claim_content_hash: claimContentHash,
      canonical_envelope_hash: canonicalEnvelopeHash,
      claim_content_json: claimContentJson,
      canonical_envelope_json: canonicalEnvelopeJson,
      canonical_arguments_bytes: canonicalBytes,
      submitted_at: transactionNowIso,
    };
    this.repo.createCoderSubmission(submissionRecord);

    // 10.2 Insert initial disposition
    const dispositionRecord: CoderSubmissionDisposition = {
      id: crypto.randomUUID(),
      submission_id: input.submission_id,
      disposition_event: 'SUBMITTED',
      disposition_reason: 'INITIAL_SUBMISSION',
      actor_type: 'MCP_CLIENT',
      actor_id: session.id,
      disposition_metadata_json: canonicalJsonStringify({
        client_name: input.client_metadata.client_name ?? null,
        client_session_mode: input.client_metadata.client_session_mode ?? null,
        client_version: input.client_metadata.client_version ?? null,
      }),
      created_at: transactionNowIso,
    };
    this.repo.createCoderSubmissionDisposition(dispositionRecord);

    // 10.3 Insert deterministic event
    const eventId = deriveDeterministicEventId(input.submission_id);
    const eventPayloadJson = canonicalJsonStringify({
      canonical_envelope_hash: canonicalEnvelopeHash,
      claim_content_hash: claimContentHash,
      claimed_status: input.status,
      submission_id: input.submission_id,
      submitted_at: transactionNowIso,
    });

    const eventInserted = this.repo.insertDeterministicEvent({
      id: eventId,
      project_id: auth.project_id,
      task_id: auth.task_id,
      type: 'CODER_SUBMISSION_QUARANTINED',
      summary: 'Quarantined untrusted coder claim and report',
      structured_payload_json: eventPayloadJson,
      timestamp: transactionNowIso,
    });

    if (!eventInserted) {
      throw new McpSubmissionAuthorityError(
        'CODER_SUBMISSION_EVENT_CONFLICT',
        `Deterministic event collision for event ID "${eventId}"`
      );
    }

    return {
      accepted: true,
      submission_id: input.submission_id,
      quarantine_status: 'QUARANTINED',
      claim_content_hash: claimContentHash,
      canonical_envelope_hash: canonicalEnvelopeHash,
      submitted_at: transactionNowIso,
      is_duplicate: false,
    };
  }
}
