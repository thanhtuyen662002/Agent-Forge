import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Repository } from '../core/database/repositories';
import { ArtifactStore, defaultArtifactStore, assertPathContained } from '../core/services/ArtifactStore';
import { scrubAdjudicationDiagnostics } from '../core/services/CoderSubmissionAdjudicationService';
import { computeSha256 } from './submissionProtocol';
import {
  McpReviewerSession,
  ReviewerSessionIssuanceInput,
  ReviewerSessionIssuanceResult,
  ReviewerAuthorityFenceState,
  SafeReviewerSessionMetadata,
  REVIEWER_TOKEN_PREFIX,
  REVIEWER_TOKEN_SCOPE,
  DIFF_CONTENT_MAX_UTF8_BYTES,
  PROJECTION_PAYLOAD_MAX_UTF8_BYTES,
  SESSION_DURATION_MIN_SECONDS,
  SESSION_DURATION_MAX_SECONDS,
  SESSION_DURATION_DEFAULT_SECONDS,
} from '../types/reviewer';

export class ReviewerAuthorityError extends Error {
  constructor(public code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'ReviewerAuthorityError';
  }
}

export function scrubReviewerDiagnostics(text: string): string {
  if (!text || typeof text !== 'string') return '';
  return scrubAdjudicationDiagnostics(text);
}

export function truncateDiffContent(diff: string, maxBytes: number = DIFF_CONTENT_MAX_UTF8_BYTES): { content: string; is_truncated: boolean } {
  const buf = Buffer.from(diff, 'utf8');
  if (buf.byteLength <= maxBytes) {
    return { content: diff, is_truncated: false };
  }

  // Truncate at byte boundary preserving multibyte UTF-8 codepoints
  let end = maxBytes;
  // If end is in the middle of a multibyte sequence (continuation byte starts with 10xxxxxx)
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--;
  }
  // If end points to a leading byte whose sequence would exceed maxBytes, back up
  if (end > 0) {
    const lead = buf[end];
    let seqLen = 1;
    if ((lead & 0xe0) === 0xc0) seqLen = 2;
    else if ((lead & 0xf0) === 0xe0) seqLen = 3;
    else if ((lead & 0xf8) === 0xf0) seqLen = 4;

    if (end + seqLen > maxBytes) {
      // Do not include incomplete multibyte character
      // end remains where it was backed up
    }
  }

  const truncatedSlice = buf.subarray(0, end);
  const content = truncatedSlice.toString('utf8');
  return { content, is_truncated: true };
}

export function truncateDiffBytes(buf: Buffer | string, maxBytes: number = DIFF_CONTENT_MAX_UTF8_BYTES): { content: string; truncated: boolean } {
  const str = typeof buf === 'string' ? buf : buf.toString('utf8');
  const res = truncateDiffContent(str, maxBytes);
  return { content: res.content, truncated: res.is_truncated };
}

export function fatalUtf8Decode(bytes: Buffer | Uint8Array): string {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return decoder.decode(bytes);
}

export class ReviewerAuthorityService {
  private repo: Repository;
  private artifactStore: ArtifactStore;

  constructor(repo: Repository, artifactStore?: ArtifactStore) {
    this.repo = repo;
    this.artifactStore = artifactStore ?? defaultArtifactStore;
  }

  public verifyProjectionSize(bytes: number): void {
    if (bytes > PROJECTION_PAYLOAD_MAX_UTF8_BYTES) {
      throw new ReviewerAuthorityError(
        'PROJECTION_PAYLOAD_TOO_LARGE',
        `[PROJECTION_PAYLOAD_TOO_LARGE] Projection payload exceeds max limit of ${PROJECTION_PAYLOAD_MAX_UTF8_BYTES} bytes`
      );
    }
  }

  public issueReviewerSession(input: ReviewerSessionIssuanceInput): ReviewerSessionIssuanceResult {
    // 1. Duration bounds
    const duration = input.duration_seconds ?? SESSION_DURATION_DEFAULT_SECONDS;
    if (typeof duration !== 'number' || duration < SESSION_DURATION_MIN_SECONDS || duration > SESSION_DURATION_MAX_SECONDS) {
      throw new ReviewerAuthorityError(
        'SESSION_DURATION_INVALID',
        `Session duration must be between ${SESSION_DURATION_MIN_SECONDS} and ${SESSION_DURATION_MAX_SECONDS} seconds`
      );
    }

    // 2. Fetch and validate adjudication
    const adj = this.repo.getCoderSubmissionAdjudicationById(input.adjudication_id);
    if (!adj) {
      throw new ReviewerAuthorityError('NOT_FOUND', `Adjudication ${input.adjudication_id} not found`);
    }

    if (adj.action !== 'ADMIT_VERIFICATION') {
      throw new ReviewerAuthorityError('ADJUDICATION_ACTION_INVALID', `Adjudication action must be ADMIT_VERIFICATION (got ${adj.action})`);
    }

    if (adj.status !== 'VERIFIED') {
      throw new ReviewerAuthorityError('ADJUDICATION_NOT_VERIFIED', `Adjudication status must be VERIFIED (got ${adj.status})`);
    }

    if (adj.recovery_fenced_at !== null) {
      throw new ReviewerAuthorityError('ADJUDICATION_RECOVERY_FENCED', `Adjudication has been recovery fenced at ${adj.recovery_fenced_at}`);
    }

    if (!adj.test_run_id || !adj.git_status_evidence_id || !adj.git_diff_evidence_id || !adj.verification_result_envelope_json) {
      throw new ReviewerAuthorityError('INTEGRITY_CONFLICT', 'Adjudication is missing required verification artifacts');
    }

    // 3. Validate authority snapshot
    if (!adj.authority_snapshot_json || adj.authority_snapshot_json.trim() === '{}') {
      throw new ReviewerAuthorityError('INTEGRITY_CONFLICT', 'Adjudication authority snapshot is empty');
    }
    try {
      const snap = JSON.parse(adj.authority_snapshot_json);
      if (typeof snap !== 'object' || snap === null || Array.isArray(snap) || Object.keys(snap).length === 0) {
        throw new Error('empty or invalid');
      }
    } catch {
      throw new ReviewerAuthorityError('INTEGRITY_CONFLICT', 'Adjudication authority snapshot is malformed JSON');
    }

    // 4. Validate submission & dispositions
    const sub = this.repo.getCoderSubmissionById(adj.submission_id);
    if (!sub) {
      throw new ReviewerAuthorityError('NOT_FOUND', `Submission ${adj.submission_id} not found`);
    }

    const disps = this.repo.getCoderSubmissionDispositions(adj.submission_id);
    const terminalDisps = disps.filter((d) => d.disposition_event === 'REJECTED' || d.disposition_event === 'SETTLED');
    if (terminalDisps.length === 0) {
      throw new ReviewerAuthorityError('DISPOSITION_INVALID', `Submission ${sub.id} has no terminal disposition`);
    }
    if (terminalDisps.length > 1) {
      throw new ReviewerAuthorityError('DISPOSITION_INVALID', `Submission ${sub.id} has multiple terminal dispositions`);
    }
    const terminalDisp = terminalDisps[0];
    if (terminalDisp.disposition_event !== 'SETTLED' || terminalDisp.disposition_reason !== 'ACCEPTED_VERIFIED') {
      throw new ReviewerAuthorityError(
        'DISPOSITION_INVALID',
        `Submission terminal disposition must be SETTLED with reason ACCEPTED_VERIFIED (got ${terminalDisp.disposition_event}:${terminalDisp.disposition_reason})`
      );
    }

    // 5. Validate task
    const task = this.repo.getTask(adj.task_id);
    if (!task) {
      throw new ReviewerAuthorityError('NOT_FOUND', `Task ${adj.task_id} not found`);
    }
    if (task.state !== 'REVIEW_READY') {
      throw new ReviewerAuthorityError('TASK_STATE_INVALID', `Task must be in REVIEW_READY state (got ${task.state})`);
    }
    if (task.ownership_epoch !== adj.task_ownership_epoch) {
      throw new ReviewerAuthorityError(
        'TASK_EPOCH_MISMATCH',
        `Task ownership epoch ${task.ownership_epoch} does not match adjudication epoch ${adj.task_ownership_epoch}`
      );
    }

    // 6. Validate project
    const project = this.repo.getProject(adj.project_id);
    if (!project) {
      throw new ReviewerAuthorityError('NOT_FOUND', `Project ${adj.project_id} not found`);
    }

    // 7. Self-Review Rejection
    const coderAttempt = adj.attempt_id ? this.repo.getTaskAttempt(adj.attempt_id) : null;
    if (coderAttempt && coderAttempt.agent_id === input.reviewer_agent_id) {
      throw new ReviewerAuthorityError('SELF_REVIEW_FORBIDDEN', 'Reviewer agent cannot be the coder agent who submitted work');
    }
    if (sub.selected_account_id && sub.selected_account_id === input.reviewer_account_id) {
      throw new ReviewerAuthorityError('SELF_REVIEW_FORBIDDEN', 'Reviewer account cannot match the coder submission selected account');
    }

    // 8. Validate Reviewer 4-Tuple Binding
    const agent = this.repo.getAgent(input.reviewer_agent_id);
    if (!agent) {
      throw new ReviewerAuthorityError('REVIEWER_AGENT_INVALID', `Reviewer agent ${input.reviewer_agent_id} not found`);
    }
    if (agent.role !== 'REVIEWER') {
      throw new ReviewerAuthorityError('REVIEWER_AGENT_INVALID', `Reviewer agent role must be REVIEWER (got ${agent.role})`);
    }
    if (agent.status === 'OFFLINE') {
      throw new ReviewerAuthorityError('REVIEWER_AGENT_INVALID', 'Reviewer agent status cannot be OFFLINE');
    }

    const provider = this.repo.getProvider(input.reviewer_provider_id);
    if (!provider) {
      throw new ReviewerAuthorityError('REVIEWER_PROVIDER_INVALID', `Provider ${input.reviewer_provider_id} not found`);
    }
    if (!provider.enabled) {
      throw new ReviewerAuthorityError('REVIEWER_PROVIDER_INVALID', `Provider ${input.reviewer_provider_id} is disabled`);
    }

    const account = this.repo.getProviderAccount(input.reviewer_account_id);
    if (!account) {
      throw new ReviewerAuthorityError('REVIEWER_ACCOUNT_INVALID', `Provider account ${input.reviewer_account_id} not found`);
    }
    if (account.provider_id !== input.reviewer_provider_id) {
      throw new ReviewerAuthorityError('REVIEWER_ACCOUNT_INVALID', 'Provider account does not belong to reviewer provider');
    }
    if (!account.enabled) {
      throw new ReviewerAuthorityError('REVIEWER_ACCOUNT_INVALID', 'Provider account is disabled');
    }
    if (!['AVAILABLE', 'BUSY', 'LOW_QUOTA'].includes(account.health_status)) {
      throw new ReviewerAuthorityError('REVIEWER_ACCOUNT_INVALID', `Account health status is not operational (${account.health_status})`);
    }

    const resource = this.repo.getProviderResource(input.reviewer_resource_id);
    if (!resource) {
      throw new ReviewerAuthorityError('REVIEWER_RESOURCE_INVALID', `Provider resource ${input.reviewer_resource_id} not found`);
    }
    if (resource.provider_id !== input.reviewer_provider_id) {
      throw new ReviewerAuthorityError('REVIEWER_RESOURCE_INVALID', 'Provider resource does not belong to reviewer provider');
    }
    if (!resource.enabled) {
      throw new ReviewerAuthorityError('REVIEWER_RESOURCE_INVALID', 'Provider resource is disabled');
    }
    if (!['AVAILABLE', 'BUSY', 'LOW_QUOTA'].includes(resource.health_status)) {
      throw new ReviewerAuthorityError('REVIEWER_RESOURCE_INVALID', `Resource health status is not operational (${resource.health_status})`);
    }
    if (resource.provider_account_id !== null && resource.provider_account_id !== input.reviewer_account_id) {
      throw new ReviewerAuthorityError('REVIEWER_RESOURCE_INVALID', 'Provider resource is bound to a different provider account');
    }

    // 9. Build Review Package Projection from Verified Evidence
    // 9.1 Test run verification
    const testRun = this.repo.getTestRun(adj.test_run_id);
    if (!testRun) {
      throw new ReviewerAuthorityError('INTEGRITY_CONFLICT', `Test run ${adj.test_run_id} not found`);
    }
    if (testRun.exit_code !== 0) {
      throw new ReviewerAuthorityError('INTEGRITY_CONFLICT', `Admitted verified test run has non-zero exit code ${testRun.exit_code}`);
    }

    // 9.2 Git Status Evidence
    const statusEv = this.repo.getEvidence(adj.git_status_evidence_id);
    if (!statusEv) {
      throw new ReviewerAuthorityError('NOT_FOUND', `Git status evidence ${adj.git_status_evidence_id} not found`);
    }
    let rawStatusPayload: string;
    if (statusEv.storage_type === 'FILE') {
      if (!statusEv.file_path) {
        throw new ReviewerAuthorityError('INTEGRITY_CONFLICT', 'Git status evidence file path missing');
      }
      try {
        assertPathContained(statusEv.file_path, this.artifactStore.getBaseDir());
      } catch (err: unknown) {
        throw new ReviewerAuthorityError('INTEGRITY_CONFLICT', `Git status evidence path escape: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!fs.existsSync(statusEv.file_path)) {
        throw new ReviewerAuthorityError('NOT_FOUND', 'Git status evidence file missing on disk');
      }
      const rawBytes = fs.readFileSync(statusEv.file_path);
      // Hash & byte size check
      const computedHash = crypto.createHash('sha256').update(rawBytes).digest('hex');
      if (computedHash !== statusEv.hash || rawBytes.length !== statusEv.byte_size) {
        throw new ReviewerAuthorityError('PROJECTION_HASH_MISMATCH', 'Git status evidence content hash or size mismatch');
      }
      // Strict fatal UTF-8 decode
      try {
        rawStatusPayload = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
      } catch {
        throw new ReviewerAuthorityError('INVALID_UTF8_ENCODING', 'Git status evidence contains invalid UTF-8 byte sequences');
      }
    } else {
      if (typeof statusEv.raw_payload !== 'string') {
        throw new ReviewerAuthorityError('INTEGRITY_CONFLICT', 'INLINE git status evidence has null payload');
      }
      const rawStatusBytes = Buffer.from(statusEv.raw_payload, 'utf8');
      if (rawStatusBytes.byteLength !== statusEv.byte_size) {
        throw new ReviewerAuthorityError('PROJECTION_HASH_MISMATCH', 'INLINE git status evidence byte size mismatch');
      }
      const computedHash = crypto.createHash('sha256').update(rawStatusBytes).digest('hex');
      if (computedHash !== statusEv.hash) {
        throw new ReviewerAuthorityError('PROJECTION_HASH_MISMATCH', 'INLINE git status evidence content hash mismatch');
      }
      rawStatusPayload = statusEv.raw_payload;
    }

    let parsedStatus: Record<string, unknown>;
    try {
      parsedStatus = JSON.parse(rawStatusPayload);
      if (typeof parsedStatus !== 'object' || parsedStatus === null || Array.isArray(parsedStatus)) {
        throw new Error('not an object');
      }
    } catch {
      throw new ReviewerAuthorityError('INTEGRITY_CONFLICT', 'Git status evidence payload is malformed JSON');
    }

    if (typeof parsedStatus.isClean !== 'boolean') {
      throw new ReviewerAuthorityError('INTEGRITY_CONFLICT', 'Git status evidence missing required boolean isClean');
    }

    if (Array.isArray(parsedStatus.files)) {
      for (const f of parsedStatus.files) {
        if (typeof f === 'string') {
          if (path.isAbsolute(f) || f.includes('..') || f.startsWith('/') || f.startsWith('\\') || /^[a-zA-Z]:/.test(f)) {
            throw new ReviewerAuthorityError('INTEGRITY_CONFLICT', `Git status evidence contains invalid path traversal or absolute path: ${f}`);
          }
        }
      }
    }

    // 9.3 Git Diff Evidence
    const diffEv = this.repo.getEvidence(adj.git_diff_evidence_id);
    if (!diffEv) {
      throw new ReviewerAuthorityError('NOT_FOUND', `Git diff evidence ${adj.git_diff_evidence_id} not found`);
    }
    if (diffEv.content_type === 'application/octet-stream') {
      throw new ReviewerAuthorityError('EVIDENCE_ENCODING_INVALID', 'Binary evidence with MIME application/octet-stream cannot be used as textual diff');
    }

    let rawDiffPayload: string;
    if (diffEv.storage_type === 'FILE') {
      if (!diffEv.file_path) {
        throw new ReviewerAuthorityError('INTEGRITY_CONFLICT', 'Git diff evidence file path missing');
      }
      try {
        assertPathContained(diffEv.file_path, this.artifactStore.getBaseDir());
      } catch (err: unknown) {
        throw new ReviewerAuthorityError('INTEGRITY_CONFLICT', `Git diff evidence path escape: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!fs.existsSync(diffEv.file_path)) {
        throw new ReviewerAuthorityError('NOT_FOUND', 'Git diff evidence file missing on disk');
      }
      const rawBytes = fs.readFileSync(diffEv.file_path);
      // Hash & byte size check
      const computedHash = crypto.createHash('sha256').update(rawBytes).digest('hex');
      if (computedHash !== diffEv.hash || rawBytes.length !== diffEv.byte_size) {
        throw new ReviewerAuthorityError('PROJECTION_HASH_MISMATCH', 'Git diff evidence content hash or size mismatch');
      }
      // Strict fatal UTF-8 decode
      try {
        rawDiffPayload = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
      } catch {
        throw new ReviewerAuthorityError('INVALID_UTF8_ENCODING', 'Git diff evidence contains invalid UTF-8 byte sequences');
      }
    } else {
      if (typeof diffEv.raw_payload !== 'string') {
        throw new ReviewerAuthorityError('INTEGRITY_CONFLICT', 'INLINE git diff evidence has null payload');
      }
      const rawDiffBytes = Buffer.from(diffEv.raw_payload, 'utf8');
      if (rawDiffBytes.byteLength !== diffEv.byte_size) {
        throw new ReviewerAuthorityError('PROJECTION_HASH_MISMATCH', 'INLINE git diff evidence byte size mismatch');
      }
      const computedHash = crypto.createHash('sha256').update(rawDiffBytes).digest('hex');
      if (computedHash !== diffEv.hash) {
        throw new ReviewerAuthorityError('PROJECTION_HASH_MISMATCH', 'INLINE git diff evidence content hash mismatch');
      }
      rawDiffPayload = diffEv.raw_payload;
    }

    // Truncate diff if oversized
    const { content: truncatedDiff, is_truncated: diffTruncated } = truncateDiffContent(rawDiffPayload, DIFF_CONTENT_MAX_UTF8_BYTES);

    // 9.4 Verification Envelope
    let parsedEnvelope: Record<string, unknown>;
    try {
      parsedEnvelope = JSON.parse(adj.verification_result_envelope_json);
      if (typeof parsedEnvelope !== 'object' || parsedEnvelope === null || Array.isArray(parsedEnvelope)) {
        throw new Error('not an object');
      }
    } catch {
      throw new ReviewerAuthorityError('INTEGRITY_CONFLICT', 'Verification result envelope is malformed JSON');
    }
    const computedEnvHash = crypto.createHash('sha256').update(adj.verification_result_envelope_json, 'utf8').digest('hex');
    if (computedEnvHash !== adj.verification_result_envelope_hash) {
      throw new ReviewerAuthorityError('INTEGRITY_CONFLICT', 'Verification result envelope hash mismatch');
    }

    // 9.5 Construct Canonical Projection JSON
    const projectionObj = {
      projection_schema_version: 1,
      adjudication: {
        id: adj.id,
        request_id: adj.request_id,
        submission_id: adj.submission_id,
        project_id: adj.project_id,
        project_name: project.name,
        task_id: adj.task_id,
        task_title: task.title,
        task_ownership_epoch: adj.task_ownership_epoch,
        action: adj.action,
        status: adj.status,
      },
      verification_results: {
        test_run_id: testRun.id,
        exit_code: testRun.exit_code,
        passed_count: testRun.passed_count,
        failed_count: testRun.failed_count,
        skipped_count: testRun.skipped_count,
        duration_ms: testRun.duration_ms,
        envelope: parsedEnvelope,
      },
      evidence: {
        git_status: {
          is_clean: parsedStatus.isClean,
          branch: parsedStatus.branch ?? null,
          files: parsedStatus.files ?? [],
        },
        git_diff: {
          diff_content: truncatedDiff,
          byte_size: Buffer.byteLength(truncatedDiff, 'utf8'),
          is_truncated: diffTruncated,
        },
      },
      disposition: {
        disposition_event: terminalDisp.disposition_event,
        disposition_reason: terminalDisp.disposition_reason,
        created_at: terminalDisp.created_at,
      },
    };

    const projectionJson = JSON.stringify(projectionObj);
    if (Buffer.byteLength(projectionJson, 'utf8') > PROJECTION_PAYLOAD_MAX_UTF8_BYTES) {
      throw new ReviewerAuthorityError('PROJECTION_SIZE_LIMIT_EXCEEDED', `Projection payload exceeds ${PROJECTION_PAYLOAD_MAX_UTF8_BYTES} bytes`);
    }
    const projectionHash = computeSha256(projectionJson);

    // 10. Check for existing active session for (adjudication_id, reviewer_agent_id)
    const existingActive = this.repo.getActiveMcpReviewerSession(adj.id, input.reviewer_agent_id);
    const now = new Date();
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + duration * 1000).toISOString();

    const rawToken = `${REVIEWER_TOKEN_PREFIX}${crypto.randomUUID()}`;
    const tokenHash = computeSha256(rawToken);

    const sessionRecord: McpReviewerSession = {
      id: crypto.randomUUID(),
      adjudication_id: adj.id,
      submission_id: adj.submission_id,
      reviewer_agent_id: input.reviewer_agent_id,
      reviewer_provider_id: input.reviewer_provider_id,
      reviewer_account_id: input.reviewer_account_id,
      reviewer_resource_id: input.reviewer_resource_id,
      scope: REVIEWER_TOKEN_SCOPE,
      token_hash: tokenHash,
      task_ownership_epoch: adj.task_ownership_epoch,
      authority_snapshot_hash: adj.authority_snapshot_hash,
      verification_result_envelope_hash: adj.verification_result_envelope_hash,
      projection_schema: 1,
      projection_hash: projectionHash,
      projection_json: projectionJson,
      issued_at: issuedAt,
      expires_at: expiresAt,
      revoked_at: null,
      revocation_reason: null,
    };

    if (existingActive) {
      const isExpired = new Date(existingActive.expires_at).getTime() <= now.getTime();
      if (isExpired) {
        // Atomic rotation on re-issuance
        this.repo.rotateExpiredReviewerSession(existingActive.id, sessionRecord);
        return { session: sessionRecord, raw_token: rawToken };
      } else {
        // Active, non-expired session exists -> Fail closed
        throw new ReviewerAuthorityError(
          'DUPLICATE_ACTIVE_SESSION',
          `An active unexpired reviewer session already exists for agent ${input.reviewer_agent_id} on adjudication ${adj.id}`
        );
      }
    }

    // Insert new session
    this.repo.createMcpReviewerSession(sessionRecord);
    return { session: sessionRecord, raw_token: rawToken };
  }

  public authenticateToken(token: string): McpReviewerSession {
    if (typeof token !== 'string') {
      throw new ReviewerAuthorityError('INVALID_REVIEWER_TOKEN', 'Token must be a non-empty string');
    }

    // Precedence 1: Lexical prefix & format check
    const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
    const regex = new RegExp(`^${REVIEWER_TOKEN_PREFIX}([0-9a-f-]{36})$`, 'i');
    const match = token.match(regex);
    if (!match || !new RegExp(uuidPattern, 'i').test(match[1])) {
      throw new ReviewerAuthorityError('INVALID_REVIEWER_TOKEN', 'Token does not match expected af-rev- UUIDv4 format');
    }

    // Precedence 2: Hash lookup
    const tokenHash = computeSha256(token);
    const session = this.repo.getMcpReviewerSessionByTokenHash(tokenHash);
    if (!session) {
      throw new ReviewerAuthorityError('AUTH_FAILED', 'Reviewer session not found for token hash');
    }

    // Precedence 3: Scope verification
    if (session.scope !== 'AUTHORIZED_REVIEW_READ' && session.scope !== 'REVIEWER_CONTEXT_READ') {
      throw new ReviewerAuthorityError('INSUFFICIENT_SCOPE', `Session scope ${session.scope} does not permit review read`);
    }

    // Precedence 4: Revocation verification
    if (session.revoked_at !== null) {
      throw new ReviewerAuthorityError('TOKEN_REVOKED', `Session was revoked at ${session.revoked_at}`);
    }

    // Precedence 5: Expiration verification
    if (new Date().getTime() >= new Date(session.expires_at).getTime()) {
      throw new ReviewerAuthorityError('TOKEN_EXPIRED', `Session expired at ${session.expires_at}`);
    }

    return session;
  }

  public validateAuthorityFence(session: McpReviewerSession): void {
    // 1. Session revocation check
    if (session.revoked_at !== null) {
      throw new ReviewerAuthorityError('TOKEN_REVOKED', `Session was revoked at ${session.revoked_at}`);
    }
    // 2. Session expiration check
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      throw new ReviewerAuthorityError('TOKEN_EXPIRED', `Session expired at ${session.expires_at}`);
    }

    // 3. Adjudication authority fence state check (supports existing tests mocking getAdjudicationAuthorityFenceState)
    const fence = this.repo.getAdjudicationAuthorityFenceState(session.adjudication_id);
    if (!fence) {
      throw new ReviewerAuthorityError('STALE_REVIEWER_AUTHORITY', `Adjudication ${session.adjudication_id} no longer exists`);
    }

    if (fence.adjudication_status === 'RECOVERY_FENCED' || fence.adjudication_recovery_fenced_at !== null) {
      throw new ReviewerAuthorityError('REVIEW_AUTHORITY_FENCED', `Adjudication ${session.adjudication_id} is recovery fenced`);
    }

    if (fence.current_task_ownership_epoch !== session.task_ownership_epoch) {
      throw new ReviewerAuthorityError(
        'STALE_REVIEWER_AUTHORITY',
        `Task ownership epoch changed from ${session.task_ownership_epoch} to ${fence.current_task_ownership_epoch}`
      );
    }

    if (fence.current_authority_snapshot_hash !== session.authority_snapshot_hash) {
      throw new ReviewerAuthorityError(
        'STALE_REVIEWER_AUTHORITY',
        'Adjudication authority snapshot hash changed since session issuance'
      );
    }

    // 4. Complete live authority revalidation across the 4-tuple and adjudication/task state
    const liveState = this.repo.getReviewerAuthorityLiveValidationState({
      sessionId: session.id,
      adjudicationId: session.adjudication_id,
      reviewerAgentId: session.reviewer_agent_id,
      reviewerProviderId: session.reviewer_provider_id,
      reviewerAccountId: session.reviewer_account_id,
      reviewerResourceId: session.reviewer_resource_id,
    });

    if (!liveState.adjudication_exists) {
      throw new ReviewerAuthorityError('STALE_REVIEWER_AUTHORITY', `Adjudication ${session.adjudication_id} no longer exists`);
    }
    if (liveState.adjudication_recovery_fenced_at !== null || liveState.adjudication_status === 'RECOVERY_FENCED') {
      throw new ReviewerAuthorityError('REVIEW_AUTHORITY_FENCED', `Adjudication ${session.adjudication_id} is recovery fenced`);
    }
    if (liveState.adjudication_status !== 'VERIFIED') {
      throw new ReviewerAuthorityError('STALE_REVIEWER_AUTHORITY', `Adjudication status is no longer VERIFIED (got ${liveState.adjudication_status})`);
    }
    if (liveState.adjudication_action !== 'ADMIT_VERIFICATION') {
      throw new ReviewerAuthorityError('STALE_REVIEWER_AUTHORITY', `Adjudication action is no longer ADMIT_VERIFICATION (got ${liveState.adjudication_action})`);
    }
    if (liveState.current_authority_snapshot_hash !== session.authority_snapshot_hash) {
      throw new ReviewerAuthorityError('STALE_REVIEWER_AUTHORITY', 'Adjudication authority snapshot hash changed since session issuance');
    }

    if (!liveState.task_exists) {
      throw new ReviewerAuthorityError('STALE_REVIEWER_AUTHORITY', 'Task no longer exists');
    }
    if (liveState.task_state !== 'REVIEW_READY') {
      throw new ReviewerAuthorityError('TASK_STATE_INVALID', `Task is no longer in REVIEW_READY state (got ${liveState.task_state})`);
    }
    if (liveState.current_task_ownership_epoch !== session.task_ownership_epoch) {
      throw new ReviewerAuthorityError(
        'STALE_REVIEWER_AUTHORITY',
        `Task ownership epoch changed from ${session.task_ownership_epoch} to ${liveState.current_task_ownership_epoch}`
      );
    }

    if (!liveState.agent_exists) {
      throw new ReviewerAuthorityError('REVIEWER_AGENT_INVALID', `Reviewer agent ${session.reviewer_agent_id} not found`);
    }
    if (liveState.agent_role !== 'REVIEWER') {
      throw new ReviewerAuthorityError('REVIEWER_AGENT_INVALID', `Reviewer agent role must be REVIEWER (got ${liveState.agent_role})`);
    }
    if (liveState.agent_status === 'OFFLINE') {
      throw new ReviewerAuthorityError('REVIEWER_AGENT_INVALID', 'Reviewer agent status cannot be OFFLINE');
    }
    if (liveState.agent_resource_id !== null && liveState.agent_resource_id !== session.reviewer_resource_id) {
      throw new ReviewerAuthorityError('REVIEWER_AGENT_INVALID', 'Reviewer agent resource binding is incompatible with session resource');
    }

    if (!liveState.provider_exists || !liveState.provider_enabled) {
      throw new ReviewerAuthorityError('REVIEWER_PROVIDER_INVALID', `Reviewer provider ${session.reviewer_provider_id} is missing or disabled`);
    }

    if (!liveState.account_exists) {
      throw new ReviewerAuthorityError('REVIEWER_ACCOUNT_INVALID', `Reviewer account ${session.reviewer_account_id} not found`);
    }
    if (liveState.account_provider_id !== session.reviewer_provider_id) {
      throw new ReviewerAuthorityError('REVIEWER_ACCOUNT_INVALID', 'Reviewer account does not belong to reviewer provider');
    }
    if (!liveState.account_enabled) {
      throw new ReviewerAuthorityError('REVIEWER_ACCOUNT_INVALID', 'Reviewer account is disabled');
    }
    if (!['AVAILABLE', 'BUSY', 'LOW_QUOTA'].includes(liveState.account_health_status ?? '')) {
      throw new ReviewerAuthorityError('REVIEWER_ACCOUNT_INVALID', `Reviewer account health status is not operational (${liveState.account_health_status})`);
    }

    if (!liveState.resource_exists) {
      throw new ReviewerAuthorityError('REVIEWER_RESOURCE_INVALID', `Reviewer resource ${session.reviewer_resource_id} not found`);
    }
    if (liveState.resource_provider_id !== session.reviewer_provider_id) {
      throw new ReviewerAuthorityError('REVIEWER_RESOURCE_INVALID', 'Reviewer resource does not belong to reviewer provider');
    }
    if (!liveState.resource_enabled) {
      throw new ReviewerAuthorityError('REVIEWER_RESOURCE_INVALID', 'Reviewer resource is disabled');
    }
    if (!['AVAILABLE', 'BUSY', 'LOW_QUOTA'].includes(liveState.resource_health_status ?? '')) {
      throw new ReviewerAuthorityError('REVIEWER_RESOURCE_INVALID', `Reviewer resource health status is not operational (${liveState.resource_health_status})`);
    }
    if (liveState.resource_account_id !== null && liveState.resource_account_id !== session.reviewer_account_id) {
      throw new ReviewerAuthorityError('REVIEWER_RESOURCE_INVALID', 'Reviewer resource is bound to a different provider account');
    }

    if (liveState.coder_agent_id !== null && liveState.coder_agent_id === session.reviewer_agent_id) {
      throw new ReviewerAuthorityError('SELF_REVIEW_FORBIDDEN', 'Reviewer agent cannot be the coder agent who submitted work');
    }
    if (liveState.coder_selected_account_id !== null && liveState.coder_selected_account_id === session.reviewer_account_id) {
      throw new ReviewerAuthorityError('SELF_REVIEW_FORBIDDEN', 'Reviewer account cannot match the coder submission selected account');
    }
  }

  public getReviewPackage(
    session: McpReviewerSession,
    requestedAdjudicationId: string
  ): { projection_json: string; projection_hash: string } {
    if (requestedAdjudicationId !== session.adjudication_id) {
      throw new ReviewerAuthorityError(
        'PERMISSION_DENIED',
        `Authenticated session is bound to adjudication ${session.adjudication_id}, cannot access ${requestedAdjudicationId}`
      );
    }

    // 1. Stale authority read fence check (SELECT-only)
    this.validateAuthorityFence(session);

    // 2. Projection schema validation
    if (session.projection_schema !== 1) {
      throw new ReviewerAuthorityError(
        'PROJECTION_SCHEMA_INVALID',
        `Unsupported projection schema version: ${session.projection_schema} (expected 1)`
      );
    }

    // 3. Projection size limit check
    if (typeof session.projection_json !== 'string') {
      throw new ReviewerAuthorityError('PROJECTION_CORRUPTED', 'Projection payload must be a non-empty string');
    }
    const payloadBytes = Buffer.byteLength(session.projection_json, 'utf8');
    if (payloadBytes > PROJECTION_PAYLOAD_MAX_UTF8_BYTES) {
      throw new ReviewerAuthorityError(
        'PROJECTION_PAYLOAD_TOO_LARGE',
        `Projection payload exceeds ${PROJECTION_PAYLOAD_MAX_UTF8_BYTES} bytes`
      );
    }

    // 4. Recompute SHA-256 over exact stored projection bytes
    const computedHash = computeSha256(session.projection_json);
    if (computedHash !== session.projection_hash) {
      throw new ReviewerAuthorityError(
        'PROJECTION_HASH_MISMATCH',
        'Projection content hash does not match stored projection_hash'
      );
    }

    // 5. Parse and validate stored JSON as bounded object structure
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(session.projection_json);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Not an object');
      }
    } catch {
      throw new ReviewerAuthorityError('PROJECTION_CORRUPTED', 'Projection payload is not a valid JSON object');
    }

    if (parsed.projection_schema_version !== 1) {
      throw new ReviewerAuthorityError('PROJECTION_SCHEMA_INVALID', 'Projection JSON projection_schema_version must equal 1');
    }

    const adj = parsed.adjudication as Record<string, unknown> | undefined;
    if (!adj || typeof adj !== 'object' || Array.isArray(adj) || adj.id !== session.adjudication_id) {
      throw new ReviewerAuthorityError('PROJECTION_CORRUPTED', 'Projection adjudication object is missing or mismatched');
    }

    const ev = parsed.evidence as Record<string, unknown> | undefined;
    if (!ev || typeof ev !== 'object' || Array.isArray(ev) || !ev.git_status || !ev.git_diff) {
      throw new ReviewerAuthorityError('PROJECTION_CORRUPTED', 'Projection evidence structure is invalid');
    }

    const disp = parsed.disposition as Record<string, unknown> | undefined;
    if (!disp || typeof disp !== 'object' || Array.isArray(disp) || disp.disposition_event !== 'SETTLED' || disp.disposition_reason !== 'ACCEPTED_VERIFIED') {
      throw new ReviewerAuthorityError('PROJECTION_CORRUPTED', 'Projection disposition structure is invalid');
    }

    // Return strictly the stored frozen projection JSON
    return {
      projection_json: session.projection_json,
      projection_hash: session.projection_hash,
    };
  }

  public revokeReviewerSession(sessionId: string, reason: string): boolean {
    if (!reason || typeof reason !== 'string' || reason.trim().length < 3) {
      throw new ReviewerAuthorityError('INVALID_REASON', 'Revocation reason must be at least 3 characters');
    }
    const session = this.repo.getMcpReviewerSessionById(sessionId);
    if (!session) {
      throw new ReviewerAuthorityError('NOT_FOUND', `Session ${sessionId} not found`);
    }
    if (session.revoked_at !== null) {
      return false;
    }
    return this.repo.revokeMcpReviewerSession(sessionId, reason.trim());
  }

  public revokeSession(sessionId: string, reason: string): boolean {
    return this.revokeReviewerSession(sessionId, reason);
  }

  public listSessions(filter?: { session_id?: string; adjudication_id?: string }): SafeReviewerSessionMetadata[] {
    const rawSessions = this.repo.listMcpReviewerSessions({
      sessionId: filter?.session_id,
      adjudicationId: filter?.adjudication_id,
    });
    const now = new Date().getTime();
    return rawSessions.map((s) => ({
      id: s.id,
      adjudication_id: s.adjudication_id,
      submission_id: s.submission_id,
      reviewer_agent_id: s.reviewer_agent_id,
      reviewer_provider_id: s.reviewer_provider_id,
      reviewer_account_id: s.reviewer_account_id,
      reviewer_resource_id: s.reviewer_resource_id,
      scope: s.scope,
      task_ownership_epoch: s.task_ownership_epoch,
      projection_schema: s.projection_schema,
      projection_hash: s.projection_hash,
      issued_at: s.issued_at,
      expires_at: s.expires_at,
      revoked_at: s.revoked_at,
      revocation_reason: s.revocation_reason,
      is_active: s.revoked_at === null && new Date(s.expires_at).getTime() > now,
    }));
  }
}
