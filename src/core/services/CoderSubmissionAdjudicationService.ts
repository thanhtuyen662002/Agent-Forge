import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import {
  Repository,
  CoderSubmission,
  CoderSubmissionDisposition,
} from '../database/repositories';
import {
  CoderSubmissionAdjudication,
  CoderSubmissionAdjudicationEvent,
  CanonicalAuthoritySnapshot,
  QuarantinedSubmissionSummary,
  QuarantinedSubmissionInspection,
  AdjudicationAction,
  AdjudicationStatus,
  AdjudicationEventType,
  AdjudicationFailureCode,
  CoderSubmissionAdjudicationError,
  AUTHORITY_SNAPSHOT_KEYS,
  CanonicalWorkspaceFingerprint,
  SealedVerificationExecutionInput,
  SubmissionAuthorityIntegrityResult,
} from '../types/adjudication';
import { Evidence, GitStatusSummary, GitDiffSummary } from '../types/domain';
import { VerificationService } from './VerificationService';
import { EventService } from './EventService';
import { GitService } from './GitService';
import { ProcessRunner } from './ProcessRunner';
import { TaskStateMachine } from '../state/taskStateMachine';
import {
  canonicalJsonStringify,
  computeSha256,
  CLAIM_CONTENT_KEYS,
  CANONICAL_ENVELOPE_KEYS,
} from '../../mcp/submissionProtocol';
import { computePayloadHash } from './ExecutionAuthorizationService';

export function deriveDeterministicAdjudicationId(submissionId: string, requestId: string): string {
  const hash = crypto.createHash('sha256').update(`agentforge:adjudication:v1:${submissionId}:${requestId}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x40;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}`;
}

export function deriveDeterministicAdjudicationEventId(
  adjudicationId: string,
  lifecycleVersion: number,
  eventType: string,
  payloadHash: string
): string {
  const hash = crypto
    .createHash('sha256')
    .update(`agentforge:adjudication-lifecycle-event:v1:${adjudicationId}:${lifecycleVersion}:${eventType}:${payloadHash}`)
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x40;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}`;
}

export function deriveDeterministicGenericAdjudicationEventId(
  adjudicationId: string,
  lifecycleVersion: number,
  eventType: string,
  payloadHash: string
): string {
  const digest = computeSha256(
    `agentforge:adjudication-generic-event:v1:${adjudicationId}:${lifecycleVersion}:${eventType}:${payloadHash}`
  );
  return `evt-adj-${digest.slice(0, 32)}`;
}

export function deriveDeterministicDispositionId(
  submissionId: string,
  adjudicationId: string,
  lifecycleVersion: number
): string {
  const hash = crypto
    .createHash('sha256')
    .update(`agentforge:coder-submission-disposition:v1:${submissionId}:${adjudicationId}:${lifecycleVersion}`)
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x40;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}`;
}

export class CoderSubmissionAdjudicationService {
  constructor(
    private readonly repo: Repository,
    private readonly db: Database.Database,
    private readonly verificationService: VerificationService,
    private readonly eventService?: EventService
  ) {}

  /**
   * Lists quarantined submissions with integrity status and latest disposition/adjudication.
   */
  public listQuarantinedSubmissions(options: {
    projectId?: string;
    taskId?: string;
    limit?: number;
    offset?: number;
    reverse?: boolean;
  }): { items: QuarantinedSubmissionSummary[]; total: number } {
    if (options.limit !== undefined && (options.limit <= 0 || options.limit > 100)) {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Pagination limit must be between 1 and 100');
    }
    if (options.offset !== undefined && options.offset < 0) {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Pagination offset must be non-negative');
    }

    const rawSubmissions = this.repo.listRawQuarantinedSubmissions(options);
    const total = this.repo.getQuarantinedSubmissionsCount(options);

    const items: QuarantinedSubmissionSummary[] = rawSubmissions.map((sub) => {
      const integrity = this.validateSubmissionIntegrity(sub);
      const disps = this.repo.getCoderSubmissionDispositions(sub.id);
      const latestDisp = disps.length > 0 ? disps[disps.length - 1] : null;
      const activeAdj = this.repo.getActiveCoderSubmissionAdjudication(sub.id);

      return {
        id: sub.id,
        authorization_id: sub.authorization_id,
        project_id: sub.project_id,
        task_id: sub.task_id,
        task_ownership_epoch: sub.task_ownership_epoch,
        task_revision: sub.task_revision,
        claimed_status: sub.claimed_status,
        quarantine_status: 'QUARANTINED',
        summary: sub.summary,
        changed_files_count: sub.changed_files_count,
        tests_claimed_count: sub.tests_claimed_count,
        blockers_count: sub.blockers_count,
        review_requested: Boolean(sub.review_requested),
        claim_content_hash: sub.claim_content_hash,
        canonical_envelope_hash: sub.canonical_envelope_hash,
        submitted_at: sub.submitted_at,
        integrity_status: integrity.valid ? 'VALID' : 'FENCED_INTEGRITY_CONFLICT',
        integrity_fenced_reasons: integrity.fenced_reasons,
        latest_disposition_event: latestDisp?.disposition_event ?? null,
        latest_disposition_reason: latestDisp?.disposition_reason ?? null,
        active_adjudication: activeAdj
          ? {
              id: activeAdj.id,
              action: activeAdj.action,
              status: activeAdj.status,
              lifecycle_version: activeAdj.lifecycle_version,
              created_at: activeAdj.created_at,
              verification_execution_id: activeAdj.verification_execution_id,
            }
          : null,
      };
    });

    return { items, total };
  }

  /**
   * Detailed inspection of a quarantined submission and its audit trail.
   */
  /**
   * Detailed inspection of a quarantined submission and its audit trail.
   */
  public inspectQuarantinedSubmission(submissionId: string): QuarantinedSubmissionInspection {
    const sub = this.repo.getCoderSubmissionById(submissionId);
    if (!sub) {
      throw new CoderSubmissionAdjudicationError(
        'NOT_FOUND',
        `Quarantined submission "${submissionId}" not found`
      );
    }

    let claimContent: Record<string, unknown> = {};
    let canonicalEnvelope: Record<string, unknown> = {};
    try {
      const parsedClaim = JSON.parse(sub.claim_content_json);
      if (typeof parsedClaim === 'object' && parsedClaim !== null && !Array.isArray(parsedClaim)) {
        claimContent = parsedClaim as Record<string, unknown>;
      }
      const parsedEnv = JSON.parse(sub.canonical_envelope_json);
      if (typeof parsedEnv === 'object' && parsedEnv !== null && !Array.isArray(parsedEnv)) {
        canonicalEnvelope = parsedEnv as Record<string, unknown>;
      }
    } catch {
      // Malformed stored JSON
    }

    const integrity = this.validateSubmissionIntegrity(sub);
    const dispositions = this.repo.getCoderSubmissionDispositions(sub.id).map((d) => {
      let metadata: Record<string, unknown> | null = null;
      if (d.disposition_metadata_json) {
        try {
          const parsed = JSON.parse(d.disposition_metadata_json);
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            metadata = parsed as Record<string, unknown>;
          }
        } catch {}
      }
      return {
        id: d.id,
        disposition_event: d.disposition_event,
        disposition_reason: d.disposition_reason,
        actor_type: d.actor_type,
        actor_id: d.actor_id,
        created_at: d.created_at,
        disposition_metadata: metadata,
      };
    });

    const adjudications = this.repo.getCoderSubmissionAdjudicationsBySubmission(sub.id).map((a) => ({
      id: a.id,
      request_id: a.request_id,
      action: a.action,
      status: a.status,
      lifecycle_version: a.lifecycle_version,
      created_at: a.created_at,
      verification_started_at: a.verification_started_at,
      completed_at: a.completed_at,
      recovery_fenced_at: a.recovery_fenced_at,
      failure_code: a.failure_code,
      test_run_id: a.test_run_id,
      git_status_evidence_id: a.git_status_evidence_id,
      git_diff_evidence_id: a.git_diff_evidence_id,
    }));

    let authoritySnapshot: CanonicalAuthoritySnapshot | null = null;
    try {
      authoritySnapshot = this.buildCanonicalAuthoritySnapshot(sub);
    } catch {
      // Incomplete or malformed authority graph
    }

    const changedFiles = Array.isArray(claimContent.changed_files)
      ? (claimContent.changed_files.filter((f) => typeof f === 'string') as string[])
      : [];
    const testsClaimed = Array.isArray(claimContent.tests_claimed)
      ? (claimContent.tests_claimed.filter((t) => typeof t === 'string') as string[])
      : [];
    const blockers = Array.isArray(claimContent.blockers)
      ? (claimContent.blockers.filter((b) => typeof b === 'string') as string[])
      : [];
    const clientMetadata =
      typeof claimContent.client_metadata === 'object' &&
      claimContent.client_metadata !== null &&
      !Array.isArray(claimContent.client_metadata)
        ? (claimContent.client_metadata as Record<string, unknown>)
        : {};

    return {
      submission: sub,
      candidate: sub,
      authority_snapshot: authoritySnapshot,
      claim_content: {
        summary: sub.summary,
        status: sub.claimed_status,
        changed_files: changedFiles,
        tests_claimed: testsClaimed,
        blockers: blockers,
        review_requested: Boolean(sub.review_requested),
        client_metadata: clientMetadata,
      },
      canonical_envelope: canonicalEnvelope,
      integrity: {
        valid: integrity.valid,
        claim_content_hash_matches: integrity.claim_content_hash_matches,
        canonical_envelope_hash_matches: integrity.canonical_envelope_hash_matches,
        fenced_reasons: integrity.fenced_reasons,
      },
      dispositions,
      adjudications,
    };
  }

  /**
   * Explicit Owner rejection of a quarantined submission.
   * Creates a terminal REJECTED adjudication and Migration 22 REJECTED disposition.
   * Never mutates task state or executes commands.
   */
  public rejectSubmission(params: {
    requestId: string;
    submissionId: string;
    reason: string;
  }): { adjudication: CoderSubmissionAdjudication; disposition: CoderSubmissionDisposition } {
    // 1. Idempotency by request_id
    const existingAdj = this.repo.getCoderSubmissionAdjudicationByRequestId(params.requestId);
    if (existingAdj) {
      if (existingAdj.submission_id !== params.submissionId || existingAdj.action !== 'REJECT') {
        throw new CoderSubmissionAdjudicationError(
          'REQUEST_ID_CONFLICT',
          `Request ID "${params.requestId}" already exists with different parameters`
        );
      }
      const disps = this.repo.getCoderSubmissionDispositions(params.submissionId);
      const lastDisp = disps.find((d) => d.disposition_event === 'REJECTED') || disps[disps.length - 1];
      return { adjudication: existingAdj, disposition: lastDisp };
    }

    const sub = this.repo.getCoderSubmissionById(params.submissionId);
    if (!sub) {
      throw new CoderSubmissionAdjudicationError('NOT_FOUND', `Submission "${params.submissionId}" not found`);
    }

    // Check active adjudication
    const activeAdj = this.repo.getActiveCoderSubmissionAdjudication(sub.id);
    if (activeAdj) {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        `Submission "${sub.id}" already has an active adjudication in state "${activeAdj.status}"`
      );
    }

    // Check terminal disposition
    const disps = this.repo.getCoderSubmissionDispositions(sub.id);
    const terminalDisp = disps.find((d) => d.disposition_event === 'REJECTED' || d.disposition_event === 'SETTLED');
    if (terminalDisp) {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        `Submission "${sub.id}" is already terminal (${terminalDisp.disposition_event} / ${terminalDisp.disposition_reason})`
      );
    }

    // Build canonical authority snapshot
    const snapshot = this.buildCanonicalAuthoritySnapshot(sub);
    const snapshotJson = canonicalJsonStringify(snapshot);
    const snapshotHash = computeSha256(snapshotJson);

    // Determine allowed Migration 22 disposition reason
    const integrity = this.validateSubmissionIntegrity(sub);
    let dispositionReason: 'INTEGRITY_MISMATCH' | 'FENCED_PRECONDITION' | 'COLLISION_CONFLICT';
    if (!integrity.valid) {
      dispositionReason = 'INTEGRITY_MISMATCH';
    } else {
      dispositionReason = 'FENCED_PRECONDITION';
    }

    const nowIso = new Date().toISOString();
    const adjudicationId = deriveDeterministicAdjudicationId(sub.id, params.requestId);
    const dispositionId = deriveDeterministicDispositionId(sub.id, adjudicationId, 1);

    const adjudication: CoderSubmissionAdjudication = {
      id: adjudicationId,
      request_id: params.requestId,
      submission_id: sub.id,
      authorization_id: sub.authorization_id,
      project_id: sub.project_id,
      task_id: sub.task_id,
      attempt_id: snapshot.attempt_id,
      assignment_id: snapshot.assignment_id,
      task_ownership_epoch: sub.task_ownership_epoch,
      action: 'REJECT',
      status: 'REJECTED',
      lifecycle_version: 1,
      authority_snapshot_json: snapshotJson,
      authority_snapshot_hash: snapshotHash,
      verification_commands_json: null,
      verification_commands_hash: null,
      workspace_snapshot_before_json: null,
      workspace_snapshot_before_hash: null,
      verification_execution_id: null,
      protocol_message_id: null,
      test_run_id: null,
      git_status_evidence_id: null,
      git_diff_evidence_id: null,
      failure_code: dispositionReason,
      failure_json: canonicalJsonStringify({ operator_reason: params.reason }),
      created_at: nowIso,
      verification_started_at: null,
      completed_at: nowIso,
      recovery_fenced_at: null,
    };

    const disposition: CoderSubmissionDisposition = {
      id: dispositionId,
      submission_id: sub.id,
      disposition_event: 'REJECTED',
      disposition_reason: dispositionReason,
      actor_type: 'OPERATOR',
      actor_id: 'OWNER_LOCAL_UI',
      disposition_metadata_json: canonicalJsonStringify({
        adjudication_id: adjudicationId,
        operator_notes: params.reason,
      }),
      created_at: nowIso,
    };

    const eventPayloadJson = canonicalJsonStringify({
      action: 'REJECT',
      adjudication_id: adjudicationId,
      disposition_reason: dispositionReason,
      reason: params.reason,
      submission_id: sub.id,
    });
    const eventPayloadHash = computeSha256(eventPayloadJson);

    const eventId = deriveDeterministicAdjudicationEventId(
      adjudicationId,
      1,
      'REJECTED',
      eventPayloadHash
    );
    const genericEventId = deriveDeterministicGenericAdjudicationEventId(
      adjudicationId,
      1,
      'REJECTED',
      eventPayloadHash
    );

    const adjEvent: CoderSubmissionAdjudicationEvent = {
      id: eventId,
      adjudication_id: adjudicationId,
      sequence: 1,
      event_type: 'REJECTED',
      payload_json: eventPayloadJson,
      payload_hash: eventPayloadHash,
      created_at: nowIso,
    };

    // Execute atomic transaction
    this.repo.runInTransaction(() => {
      this.repo.createCoderSubmissionAdjudication(adjudication);
      this.repo.createCoderSubmissionDisposition(disposition);
      this.repo.createCoderSubmissionAdjudicationEvent(adjEvent);
      this.repo.createDeterministicGenericEvent({
        id: genericEventId,
        project_id: sub.project_id,
        task_id: sub.task_id,
        agent_id: null,
        type: 'CODER_SUBMISSION_REJECTED',
        summary: `Quarantined coder submission ${sub.id} rejected by operator: ${params.reason}`,
        structured_payload: { adjudicationId, dispositionReason, submissionId: sub.id },
        timestamp: nowIso,
      });
    });

    return { adjudication, disposition };
  }

  /**
   * Explicit Owner supersession of an older submission by a replacement submission.
   * Appends SETTLED / SUPERSEDED_SUBMISSION.
   * Never mutates task state or runs commands.
   */
  public supersedeSubmission(params: {
    requestId: string;
    submissionId: string;
    replacementSubmissionId: string;
    reason: string;
  }): { adjudication: CoderSubmissionAdjudication; disposition: CoderSubmissionDisposition } {
    // 1. Idempotency check
    const existingAdj = this.repo.getCoderSubmissionAdjudicationByRequestId(params.requestId);
    if (existingAdj) {
      if (existingAdj.submission_id !== params.submissionId || existingAdj.action !== 'SUPERSEDE') {
        throw new CoderSubmissionAdjudicationError(
          'REQUEST_ID_CONFLICT',
          `Request ID "${params.requestId}" already exists with different parameters`
        );
      }
      const disps = this.repo.getCoderSubmissionDispositions(params.submissionId);
      const lastDisp = disps.find((d) => d.disposition_reason === 'SUPERSEDED_SUBMISSION') || disps[disps.length - 1];
      return { adjudication: existingAdj, disposition: lastDisp };
    }

    if (params.submissionId === params.replacementSubmissionId) {
      throw new CoderSubmissionAdjudicationError(
        'PRECONDITION_FENCED',
        'Submission cannot supersede itself'
      );
    }

    const sub = this.repo.getCoderSubmissionById(params.submissionId);
    if (!sub) {
      throw new CoderSubmissionAdjudicationError('NOT_FOUND', `Submission "${params.submissionId}" not found`);
    }

    const replacementSub = this.repo.getCoderSubmissionById(params.replacementSubmissionId);
    if (!replacementSub) {
      throw new CoderSubmissionAdjudicationError(
        'NOT_FOUND',
        `Replacement submission "${params.replacementSubmissionId}" not found`
      );
    }

    // Must bind to exact same authority tuple
    if (
      sub.project_id !== replacementSub.project_id ||
      sub.task_id !== replacementSub.task_id ||
      sub.authorization_id !== replacementSub.authorization_id
    ) {
      throw new CoderSubmissionAdjudicationError(
        'PRECONDITION_FENCED',
        'Replacement submission does not bind to the same authority tuple (project, task, authorization)'
      );
    }

    // Check terminal disposition on target
    const disps = this.repo.getCoderSubmissionDispositions(sub.id);
    const terminalDisp = disps.find((d) => d.disposition_event === 'REJECTED' || d.disposition_event === 'SETTLED');
    if (terminalDisp) {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        `Submission "${sub.id}" is already terminal (${terminalDisp.disposition_event} / ${terminalDisp.disposition_reason})`
      );
    }

    const snapshot = this.buildCanonicalAuthoritySnapshot(sub);
    const snapshotJson = canonicalJsonStringify(snapshot);
    const snapshotHash = computeSha256(snapshotJson);

    const nowIso = new Date().toISOString();
    const adjudicationId = deriveDeterministicAdjudicationId(sub.id, params.requestId);
    const dispositionId = deriveDeterministicDispositionId(sub.id, adjudicationId, 1);

    const adjudication: CoderSubmissionAdjudication = {
      id: adjudicationId,
      request_id: params.requestId,
      submission_id: sub.id,
      authorization_id: sub.authorization_id,
      project_id: sub.project_id,
      task_id: sub.task_id,
      attempt_id: snapshot.attempt_id,
      assignment_id: snapshot.assignment_id,
      task_ownership_epoch: sub.task_ownership_epoch,
      action: 'SUPERSEDE',
      status: 'SUPERSEDED',
      lifecycle_version: 1,
      authority_snapshot_json: snapshotJson,
      authority_snapshot_hash: snapshotHash,
      verification_commands_json: null,
      verification_commands_hash: null,
      workspace_snapshot_before_json: null,
      workspace_snapshot_before_hash: null,
      verification_execution_id: null,
      protocol_message_id: null,
      test_run_id: null,
      git_status_evidence_id: null,
      git_diff_evidence_id: null,
      failure_code: null,
      failure_json: canonicalJsonStringify({
        operator_reason: params.reason,
        replacement_submission_id: params.replacementSubmissionId,
      }),
      created_at: nowIso,
      verification_started_at: null,
      completed_at: nowIso,
      recovery_fenced_at: null,
    };

    const disposition: CoderSubmissionDisposition = {
      id: dispositionId,
      submission_id: sub.id,
      disposition_event: 'SETTLED',
      disposition_reason: 'SUPERSEDED_SUBMISSION',
      actor_type: 'OPERATOR',
      actor_id: 'OWNER_LOCAL_UI',
      disposition_metadata_json: canonicalJsonStringify({
        adjudication_id: adjudicationId,
        operator_notes: params.reason,
        replacement_submission_id: params.replacementSubmissionId,
      }),
      created_at: nowIso,
    };

    const eventPayloadJson = canonicalJsonStringify({
      action: 'SUPERSEDE',
      adjudication_id: adjudicationId,
      reason: params.reason,
      replacement_submission_id: params.replacementSubmissionId,
      submission_id: sub.id,
    });
    const eventPayloadHash = computeSha256(eventPayloadJson);

    const eventId = deriveDeterministicAdjudicationEventId(
      adjudicationId,
      1,
      'SUPERSEDED',
      eventPayloadHash
    );
    const genericEventId = deriveDeterministicGenericAdjudicationEventId(
      adjudicationId,
      1,
      'SUPERSEDED',
      eventPayloadHash
    );

    const adjEvent: CoderSubmissionAdjudicationEvent = {
      id: eventId,
      adjudication_id: adjudicationId,
      sequence: 1,
      event_type: 'SUPERSEDED',
      payload_json: eventPayloadJson,
      payload_hash: eventPayloadHash,
      created_at: nowIso,
    };

    this.repo.runInTransaction(() => {
      this.repo.createCoderSubmissionAdjudication(adjudication);
      this.repo.createCoderSubmissionDisposition(disposition);
      this.repo.createCoderSubmissionAdjudicationEvent(adjEvent);
      this.repo.createDeterministicGenericEvent({
        id: genericEventId,
        project_id: sub.project_id,
        task_id: sub.task_id,
        agent_id: null,
        type: 'CODER_SUBMISSION_SUPERSEDED',
        summary: `Submission ${sub.id} superseded by ${params.replacementSubmissionId}: ${params.reason}`,
        structured_payload: { adjudicationId, replacementSubmissionId: params.replacementSubmissionId, submissionId: sub.id },
        timestamp: nowIso,
      });
    });

    return { adjudication, disposition };
  }

  /**
   * Three-Phase Verification Protocol for Quarantined Submission Admission.
   */
  public async admitSubmissionForVerification(params: {
    requestId: string;
    submissionId: string;
    resumeAdjudicationId?: string;
  }): Promise<{ adjudication: CoderSubmissionAdjudication; status: AdjudicationStatus }> {
    // 1. Check idempotency by request_id
    const existingAdj = this.repo.getCoderSubmissionAdjudicationByRequestId(params.requestId);
    if (existingAdj) {
      if (existingAdj.submission_id !== params.submissionId || existingAdj.action !== 'ADMIT_VERIFICATION') {
        throw new CoderSubmissionAdjudicationError(
          'REQUEST_ID_CONFLICT',
          `Request ID "${params.requestId}" already exists with different parameters`
        );
      }
      return { adjudication: existingAdj, status: existingAdj.status };
    }

    // 2. Load submission and validate integrity
    const sub = this.repo.getCoderSubmissionById(params.submissionId);
    if (!sub) {
      throw new CoderSubmissionAdjudicationError('NOT_FOUND', `Submission "${params.submissionId}" not found`);
    }

    const integrity = this.validateSubmissionIntegrity(sub);
    if (!integrity.valid) {
      throw new CoderSubmissionAdjudicationError(
        'INTEGRITY_CONFLICT',
        `Submission integrity validation failed: ${integrity.fenced_reasons.join('; ')}`
      );
    }

    // Check active adjudication on submission
    const existingActive = this.repo.getActiveCoderSubmissionAdjudication(sub.id);
    if (existingActive) {
      if (!params.resumeAdjudicationId || existingActive.id !== params.resumeAdjudicationId) {
        throw new CoderSubmissionAdjudicationError(
          'VERIFICATION_IN_FLIGHT',
          `Submission "${sub.id}" already has an active adjudication (${existingActive.status})`
        );
      }
    }

    // Check terminal disposition
    const disps = this.repo.getCoderSubmissionDispositions(sub.id);
    const terminalDisp = disps.find((d) => d.disposition_event === 'REJECTED' || d.disposition_event === 'SETTLED');
    if (terminalDisp) {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        `Submission "${sub.id}" is already settled or rejected (${terminalDisp.disposition_event} / ${terminalDisp.disposition_reason})`
      );
    }

    // 3. Authority Snapshot & Frozen Command Validation
    const project = this.repo.getProject(sub.project_id);
    if (!project) {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Project not found');
    }
    if (project.status !== 'RUNNING') {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', `Project must be in RUNNING status (got ${project.status})`);
    }

    const task = this.repo.getTask(sub.task_id);
    if (!task) {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Task not found');
    }
    if (!params.resumeAdjudicationId && task.state !== 'CODING') {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', `Task must be in CODING state (got ${task.state})`);
    }
    if (params.resumeAdjudicationId && task.state !== 'VALIDATING' && task.state !== 'CODING') {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', `Task must be in VALIDATING or CODING state to resume (got ${task.state})`);
    }
    if (task.ownership_epoch !== sub.task_ownership_epoch) {
      throw new CoderSubmissionAdjudicationError(
        'PRECONDITION_FENCED',
        `Task ownership epoch mismatch: task (${task.ownership_epoch}) does not match submission (${sub.task_ownership_epoch})`
      );
    }

    const auth = this.repo.getExecutionAuthorization(sub.authorization_id);
    if (!auth || !auth.canonical_payload_json) {
      throw new CoderSubmissionAdjudicationError(
        'COMMAND_SNAPSHOT_INVALID',
        'Execution authorization missing or lacks canonical_payload_json'
      );
    }
    if (auth.instruction_payload_hash) {
      let matches = false;
      try {
        const parsed = JSON.parse(auth.canonical_payload_json);
        if (computePayloadHash(parsed) === auth.instruction_payload_hash) {
          matches = true;
        }
      } catch {
        // ignore parse error
      }
      if (!matches && computeSha256(auth.canonical_payload_json) === auth.instruction_payload_hash) {
        matches = true;
      }
      if (!matches) {
        throw new CoderSubmissionAdjudicationError(
          'INTEGRITY_CONFLICT',
          'Execution authorization canonical payload hash mismatch (INSTRUCTION_PAYLOAD_HASH_MISMATCH)'
        );
      }
    }
    if (auth.status !== 'DISPATCHED') {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', `Execution authorization must be in DISPATCHED status (got ${auth.status})`);
    }
    if (auth.repository_head_sha.toLowerCase() !== sub.authorized_head_sha.toLowerCase()) {
      throw new CoderSubmissionAdjudicationError(
        'WORKTREE_DRIFT',
        `HEAD drift: authorized repository head SHA (${auth.repository_head_sha}) does not match submission (${sub.authorized_head_sha})`
      );
    }

    if (!auth.attempt_id) {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Authorization missing attempt_id');
    }
    const attempt = this.repo.getTaskAttempt(auth.attempt_id);
    if (!attempt) {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Attempt not found');
    }
    if (attempt.status !== 'RUNNING') {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', `Task attempt must be in RUNNING status (got ${attempt.status})`);
    }

    if (!auth.assignment_id) {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Authorization missing assignment_id');
    }
    const assignment = this.repo.getAgentAssignment(auth.assignment_id);
    if (!assignment) {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Assignment not found');
    }
    if (assignment.status !== 'ASSIGNED') {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', `Agent assignment must be in ASSIGNED status (got ${assignment.status})`);
    }

    // Provider / account / resource binding check between auth and assignment
    if (
      (auth.selected_provider_id && assignment.selected_provider_id && auth.selected_provider_id !== assignment.selected_provider_id) ||
      (auth.selected_account_id && assignment.selected_account_id && auth.selected_account_id !== assignment.selected_account_id) ||
      (auth.selected_resource_id && assignment.selected_resource_id && auth.selected_resource_id !== assignment.selected_resource_id)
    ) {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Provider mismatch: provider, account, or resource mismatch between authorization and assignment');
    }

    const snapshot = this.buildCanonicalAuthoritySnapshot(sub);
    const snapshotJson = canonicalJsonStringify(snapshot);
    const snapshotHash = computeSha256(snapshotJson);

    let authPayload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(auth.canonical_payload_json);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Not an object');
      }
      authPayload = parsed as Record<string, unknown>;
    } catch {
      throw new CoderSubmissionAdjudicationError(
        'COMMAND_SNAPSHOT_INVALID',
        'Authorization canonical payload is malformed JSON'
      );
    }

    const frozenCommands = authPayload.verificationCommands as Record<string, unknown> | undefined;
    if (!frozenCommands || typeof frozenCommands !== 'object') {
      throw new CoderSubmissionAdjudicationError(
        'COMMAND_SNAPSHOT_INVALID',
        'Frozen verificationCommands snapshot missing from authorization'
      );
    }

    const frozenTestCmd = frozenCommands.TEST as Record<string, unknown> | undefined;
    if (!frozenTestCmd || typeof frozenTestCmd.executable !== 'string' || !Array.isArray(frozenTestCmd.args)) {
      throw new CoderSubmissionAdjudicationError(
        'COMMAND_SNAPSHOT_INVALID',
        'No valid frozen TEST command snapshot configured in authorization'
      );
    }

    const verificationCommandsJson = canonicalJsonStringify(frozenCommands);
    const verificationCommandsHash = computeSha256(verificationCommandsJson);

    // 4. Pre-transaction external Git reads
    if (!project.repository_path) {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Project repository path missing');
    }

    const prePhaseAFingerprint = await this.captureCanonicalWorkspaceFingerprint(project.repository_path, sub.base_sha);
    if (prePhaseAFingerprint.head_sha.toLowerCase() !== sub.authorized_head_sha.toLowerCase()) {
      throw new CoderSubmissionAdjudicationError(
        'WORKTREE_DRIFT',
        `Live repository HEAD drift: live HEAD (${prePhaseAFingerprint.head_sha}) has drifted from authorized HEAD (${sub.authorized_head_sha})`
      );
    }
    if (prePhaseAFingerprint.status_lines.length > 0) {
      throw new CoderSubmissionAdjudicationError(
        'WORKTREE_DRIFT',
        `Working directory has uncommitted changes in ${project.repository_path}`
      );
    }

    // =========================================================================
    // PHASE A: ADMISSION TRANSACTION (Short BEGIN IMMEDIATE)
    // =========================================================================
    let adjudicationId: string;
    const phaseANowIso = new Date().toISOString();

    if (params.resumeAdjudicationId) {
      adjudicationId = params.resumeAdjudicationId;
      const liveTask = this.repo.getTask(sub.task_id);
      if (liveTask && liveTask.state === 'CODING') {
        const transitionRes = TaskStateMachine.transition(liveTask.state, 'SUBMIT_REPORT', {
          revisionCount: liveTask.revision_count,
          maxRevisions: liveTask.max_revisions,
          pausedFromState: liveTask.paused_from_state,
        });
        this.repo.updateTaskState(liveTask.id, transitionRes.nextState);
      }
    } else {
      adjudicationId = deriveDeterministicAdjudicationId(sub.id, params.requestId);
      const syntheticMsgId = `msg-sub-${sub.id}`;
      const syntheticProtocolId = deriveDeterministicAdjudicationId('protocol', sub.id);

      const admissionAdjudication: CoderSubmissionAdjudication = {
        id: adjudicationId,
        request_id: params.requestId,
        submission_id: sub.id,
        authorization_id: sub.authorization_id,
        project_id: sub.project_id,
        task_id: sub.task_id,
        attempt_id: snapshot.attempt_id,
        assignment_id: snapshot.assignment_id,
        task_ownership_epoch: sub.task_ownership_epoch,
        action: 'ADMIT_VERIFICATION',
        status: 'ADMITTED',
        lifecycle_version: 1,
        authority_snapshot_json: snapshotJson,
        authority_snapshot_hash: snapshotHash,
        verification_commands_json: verificationCommandsJson,
        verification_commands_hash: verificationCommandsHash,
        workspace_snapshot_before_json: null,
        workspace_snapshot_before_hash: null,
        verification_execution_id: null,
        protocol_message_id: syntheticProtocolId,
        test_run_id: null,
        git_status_evidence_id: null,
        git_diff_evidence_id: null,
        failure_code: null,
        failure_json: null,
        created_at: phaseANowIso,
        verification_started_at: null,
        completed_at: null,
        recovery_fenced_at: null,
      };

      const admitEventPayload = canonicalJsonStringify({
        action: 'ADMIT_VERIFICATION',
        adjudication_id: adjudicationId,
        head_sha: prePhaseAFingerprint.head_sha,
        submission_id: sub.id,
      });
      const admitEventHash = computeSha256(admitEventPayload);
      const admitEventId = deriveDeterministicAdjudicationEventId(
        adjudicationId,
        1,
        'ADMITTED',
        admitEventHash
      );
      const genericEventId = deriveDeterministicGenericAdjudicationEventId(
        adjudicationId,
        1,
        'ADMITTED',
        admitEventHash
      );

      const admitEvent: CoderSubmissionAdjudicationEvent = {
        id: admitEventId,
        adjudication_id: adjudicationId,
        sequence: 1,
        event_type: 'ADMITTED',
        payload_json: admitEventPayload,
        payload_hash: admitEventHash,
        created_at: phaseANowIso,
      };

      this.repo.runInTransaction(() => {
        // Re-verify live task state in transaction
        const liveTask = this.repo.getTask(sub.task_id);
        if (!liveTask || (liveTask.state !== 'CODING' && liveTask.state !== 'VALIDATING')) {
          throw new CoderSubmissionAdjudicationError(
            'PRECONDITION_FENCED',
            `Task "${sub.task_id}" state is "${liveTask?.state}", must be "CODING" or "VALIDATING"`
          );
        }
        if (liveTask.ownership_epoch !== sub.task_ownership_epoch) {
          throw new CoderSubmissionAdjudicationError(
            'INTEGRITY_CONFLICT',
            `Task ownership epoch mismatch: task (${liveTask.ownership_epoch}) does not match submission (${sub.task_ownership_epoch})`
          );
        }

        // Record synthetic protocol message
        this.repo.recordProtocolMessage(
          syntheticProtocolId,
          syntheticMsgId,
          'coder.v1',
          sub.project_id,
          sub.task_id,
          'CODING',
          sub.task_revision,
          sub.claim_content_hash,
          sub.claim_content_json,
          'APPLIED'
        );

        // Transition task CODING -> VALIDATING if in CODING
        if (liveTask.state === 'CODING') {
          const transitionRes = TaskStateMachine.transition(liveTask.state, 'SUBMIT_REPORT', {
            revisionCount: liveTask.revision_count,
            maxRevisions: liveTask.max_revisions,
            pausedFromState: liveTask.paused_from_state,
          });

          this.repo.updateTaskState(
            liveTask.id,
            transitionRes.nextState,
            transitionRes.pausedFromState,
            transitionRes.incrementRevision
          );
        }

        // Create adjudication record & events
        this.repo.createCoderSubmissionAdjudication(admissionAdjudication);
        this.repo.createCoderSubmissionAdjudicationEvent(admitEvent);
        this.repo.createDeterministicGenericEvent({
          id: genericEventId,
          project_id: sub.project_id,
          task_id: sub.task_id,
          agent_id: null,
          type: 'CODER_SUBMISSION_ADMITTED',
          summary: `Quarantined coder submission ${sub.id} admitted for verification on task ${sub.task_id}`,
          structured_payload: { adjudicationId, headSha: prePhaseAFingerprint.head_sha, submissionId: sub.id },
          timestamp: phaseANowIso,
        });
      });
    }

    // =========================================================================
    // PHASE B: EXECUTION CLAIM TRANSACTION (Atomic CAS)
    // =========================================================================
    // Capture a fresh canonical workspace observation immediately before claim transaction!
    // It must NOT reuse the Phase A observation!
    const freshPhaseBObservation = await this.captureCanonicalWorkspaceFingerprint(
      project.repository_path,
      sub.base_sha
    );

    if (freshPhaseBObservation.head_sha.toLowerCase() !== sub.authorized_head_sha.toLowerCase()) {
      throw new CoderSubmissionAdjudicationError(
        'WORKTREE_DRIFT',
        `Live repository HEAD drift before claim: live HEAD (${freshPhaseBObservation.head_sha}) has drifted from authorized HEAD (${sub.authorized_head_sha})`
      );
    }
    if (freshPhaseBObservation.status_lines.length > 0) {
      throw new CoderSubmissionAdjudicationError(
        'WORKTREE_DRIFT',
        `Working directory has uncommitted changes before execution claim in ${project.repository_path}`
      );
    }

    const executionId = crypto.randomUUID();
    const phaseBNowIso = new Date().toISOString();

    const workspaceSnapshotJson = canonicalJsonStringify(freshPhaseBObservation);
    const workspaceSnapshotHash = computeSha256(workspaceSnapshotJson);

    const claimEventPayload = canonicalJsonStringify({
      adjudication_id: adjudicationId,
      started_at: phaseBNowIso,
      verification_execution_id: executionId,
    });
    const claimEventHash = computeSha256(claimEventPayload);
    const claimEventId = deriveDeterministicAdjudicationEventId(
      adjudicationId,
      2,
      'VERIFICATION_CLAIMED',
      claimEventHash
    );
    const genericClaimEventId = deriveDeterministicGenericAdjudicationEventId(
      adjudicationId,
      2,
      'VERIFICATION_CLAIMED',
      claimEventHash
    );

    const claimEvent: CoderSubmissionAdjudicationEvent = {
      id: claimEventId,
      adjudication_id: adjudicationId,
      sequence: 2,
      event_type: 'VERIFICATION_CLAIMED',
      payload_json: claimEventPayload,
      payload_hash: claimEventHash,
      created_at: phaseBNowIso,
    };

    let claimed = false;
    this.repo.runInTransaction(() => {
      // Reload and verify live adjudication state in claim transaction
      const currentAdj = this.repo.getCoderSubmissionAdjudicationById(adjudicationId);
      if (!currentAdj) {
        throw new CoderSubmissionAdjudicationError('NOT_FOUND', `Adjudication ${adjudicationId} not found`);
      }
      if (currentAdj.status !== 'ADMITTED') {
        throw new CoderSubmissionAdjudicationError(
          'VERIFICATION_IN_FLIGHT',
          `Adjudication "${adjudicationId}" is in status "${currentAdj.status}", expected "ADMITTED"`
        );
      }

      claimed = this.repo.updateCoderSubmissionAdjudication(adjudicationId, currentAdj.lifecycle_version, {
        status: 'VERIFYING',
        verification_execution_id: executionId,
        verification_started_at: phaseBNowIso,
        workspace_snapshot_before_json: workspaceSnapshotJson,
        workspace_snapshot_before_hash: workspaceSnapshotHash,
      });

      if (claimed) {
        this.repo.createCoderSubmissionAdjudicationEvent(claimEvent);
        this.repo.createDeterministicGenericEvent({
          id: genericClaimEventId,
          project_id: sub.project_id,
          task_id: sub.task_id,
          agent_id: null,
          type: 'CODER_SUBMISSION_CLAIMED',
          summary: `Verification execution claimed on adjudication ${adjudicationId}`,
          structured_payload: { adjudicationId, executionId, startedAt: phaseBNowIso },
          timestamp: phaseBNowIso,
        });
      }
    });

    if (!claimed) {
      throw new CoderSubmissionAdjudicationError(
        'VERIFICATION_IN_FLIGHT',
        `Failed to claim execution on adjudication "${adjudicationId}" (already claimed or version mismatch)`
      );
    }

    // =========================================================================
    // EXTERNAL VERIFICATION EXECUTION (Outside All Database Transactions)
    // =========================================================================
    const rawTimeout = frozenTestCmd.timeout_ms;
    const timeoutMs =
      typeof rawTimeout === 'number' && Number.isInteger(rawTimeout) && rawTimeout > 0 && rawTimeout <= 600000
        ? rawTimeout
        : 120000;

    const sealedInput: SealedVerificationExecutionInput = {
      adjudication_id: adjudicationId,
      lifecycle_version: 2,
      verification_execution_id: executionId,
      authorization_id: sub.authorization_id,
      project_id: sub.project_id,
      task_id: sub.task_id,
      attempt_id: snapshot.attempt_id,
      assignment_id: snapshot.assignment_id,
      repo_path: project.repository_path,
      verification_commands_json: verificationCommandsJson,
      verification_commands_hash: verificationCommandsHash,
      workspace_snapshot_before_json: workspaceSnapshotJson,
      workspace_snapshot_before_hash: workspaceSnapshotHash,
      policy: {
        timeout_ms: timeoutMs,
        max_stdout_bytes: ProcessRunner.DEFAULT_MAX_OUTPUT_BYTES,
        max_stderr_bytes: ProcessRunner.DEFAULT_MAX_OUTPUT_BYTES,
        allowed_env_keys: ['NODE_ENV', 'PATH', 'Path', 'SYSTEMROOT', 'TEMP', 'TMP'],
      },
    };

    const verificationResult = await this.verificationService.executeSealedVerification(sealedInput);

    // Collect post-run Git evidence & post-run observation outside all transactions
    let postGitStatus: GitStatusSummary | null = null;
    let postGitDiff: GitDiffSummary | null = null;
    let postObservation: CanonicalWorkspaceFingerprint | null = null;
    let driftDetected = false;
    let driftReason = '';

    try {
      postObservation = await this.captureCanonicalWorkspaceFingerprint(project.repository_path, sub.base_sha);
      postGitStatus = await GitService.getStatus(project.repository_path);
      postGitDiff = await GitService.getDiff(project.repository_path, sub.base_sha);

      if (postObservation.head_sha.toLowerCase() !== freshPhaseBObservation.head_sha.toLowerCase()) {
        driftDetected = true;
        driftReason = `Repository HEAD moved during verification from ${freshPhaseBObservation.head_sha} to ${postObservation.head_sha}`;
      } else if (postObservation.diff_hash !== freshPhaseBObservation.diff_hash) {
        driftDetected = true;
        driftReason = `Tracked git diff content changed during verification`;
      } else if (postObservation.untracked_files_hash !== freshPhaseBObservation.untracked_files_hash) {
        driftDetected = true;
        driftReason = `Untracked files modified or added during verification`;
      }
    } catch (obsErr: unknown) {
      const msg = obsErr instanceof Error ? obsErr.message : String(obsErr);
      driftDetected = true;
      driftReason = `Failed to capture post-verification workspace observation: ${msg}`;
    }

    // =========================================================================
    // PHASE C: SETTLEMENT TRANSACTION (Short BEGIN IMMEDIATE)
    // =========================================================================
    // CRITICAL: NO filesystem, Git, or artifact-store writes may occur while SQLite transaction is open!
    // We create and hash the staging package OUTSIDE the transaction first.
    const artifactStore = this.verificationService.getArtifactStore();
    let stagedGitStatusEvidence: Evidence | null = null;
    let stagedGitDiffEvidence: Evidence | null = null;

    if (postGitStatus) {
      const statusEvId = crypto.randomUUID();
      stagedGitStatusEvidence = artifactStore.store(
        statusEvId,
        sub.project_id,
        sub.task_id,
        snapshot.attempt_id,
        'GIT_STATUS',
        `Git Status: ${postGitStatus.isClean ? 'Clean' : 'Modified'} on ${postGitStatus.branch ?? 'main'}`,
        JSON.stringify(postGitStatus, null, 2),
        'application/json'
      );
    }

    if (postGitDiff) {
      const diffEvId = crypto.randomUUID();
      stagedGitDiffEvidence = artifactStore.store(
        diffEvId,
        sub.project_id,
        sub.task_id,
        snapshot.attempt_id,
        'GIT_DIFF',
        `Git Diff: ${postGitDiff.filesChanged?.length ?? 0} files changed`,
        postGitDiff.diffContent ?? '',
        'text/x-diff'
      );
    }

    const phaseCNowIso = new Date().toISOString();
    let finalAdjudication: CoderSubmissionAdjudication | null = null;

    const isSuccess = !driftDetected && verificationResult.outcome === 'SUCCESS';
    const targetStatus = isSuccess ? 'VERIFIED' : 'VERIFICATION_FAILED';
    const testRunId = 'test_run' in verificationResult && verificationResult.test_run
      ? verificationResult.test_run.id
      : null;

    let failureCode: string | null = null;
    let failureDetail: string | null = null;

    if (driftDetected) {
      failureCode = 'WORKTREE_DRIFT';
      failureDetail = driftReason;
    } else if (verificationResult.outcome === 'TEST_FAILED') {
      failureCode = 'TESTS_FAILED';
      failureDetail = `Test run failed with exit code ${verificationResult.exit_code}`;
    } else if (verificationResult.outcome === 'TEST_TIMEOUT') {
      failureCode = 'VERIFICATION_TIMEOUT';
      failureDetail = `Test execution timed out after ${verificationResult.duration_ms}ms`;
    } else if (verificationResult.outcome === 'COMMAND_POLICY_REJECTED') {
      failureCode = 'POLICY_VIOLATION';
      failureDetail = verificationResult.reason;
    } else if (verificationResult.outcome === 'PROCESS_START_FAILED') {
      failureCode = 'PROCESS_START_FAILED';
      failureDetail = verificationResult.error;
    } else if (verificationResult.outcome === 'RECOVERY_FENCED') {
      failureCode = verificationResult.failure_code;
      failureDetail = verificationResult.error;
    }

    const eventPayload = isSuccess
      ? canonicalJsonStringify({
          adjudication_id: adjudicationId,
          exit_code: 0,
          test_run_id: testRunId,
        })
      : canonicalJsonStringify({
          adjudication_id: adjudicationId,
          error: failureDetail,
          failure_code: failureCode || 'TESTS_FAILED',
        });

    const eventPayloadHash = computeSha256(eventPayload);
    const eventType = isSuccess ? 'VERIFICATION_SUCCEEDED' : 'VERIFICATION_FAILED';
    const finalEventId = deriveDeterministicAdjudicationEventId(
      adjudicationId,
      3,
      eventType,
      eventPayloadHash
    );
    const genericFinalEventId = deriveDeterministicGenericAdjudicationEventId(
      adjudicationId,
      3,
      eventType,
      eventPayloadHash
    );

    const dispositionId = deriveDeterministicDispositionId(sub.id, adjudicationId, 3);

    // OPEN SHORT SETTLEMENT TRANSACTION
    this.repo.runInTransaction(() => {
      const currentTask = this.repo.getTask(sub.task_id);
      if (!currentTask) {
        throw new Error(`Task ${sub.task_id} missing during settlement`);
      }

      // Persist staged evidence rows inside transaction
      if (stagedGitStatusEvidence) {
        this.repo.createEvidence(stagedGitStatusEvidence);
      }
      if (stagedGitDiffEvidence) {
        this.repo.createEvidence(stagedGitDiffEvidence);
      }

      if (isSuccess) {
        // Authoritative Success Path:
        // Transition task: VALIDATING -> REVIEW_READY
        const trans = TaskStateMachine.transition(currentTask.state, 'EVIDENCE_GATHERED', {
          revisionCount: currentTask.revision_count,
          maxRevisions: currentTask.max_revisions,
        });

        this.repo.updateTaskState(currentTask.id, trans.nextState);
        this.repo.updateTaskShas(currentTask.id, sub.base_sha, freshPhaseBObservation.head_sha);

        // Append terminal disposition: SETTLED / ACCEPTED_VERIFIED
        const disposition: CoderSubmissionDisposition = {
          id: dispositionId,
          submission_id: sub.id,
          disposition_event: 'SETTLED',
          disposition_reason: 'ACCEPTED_VERIFIED',
          actor_type: 'OPERATOR',
          actor_id: 'OWNER_LOCAL_UI',
          disposition_metadata_json: canonicalJsonStringify({
            adjudication_id: adjudicationId,
            exit_code: 0,
            test_run_id: testRunId,
          }),
          created_at: phaseCNowIso,
        };
        this.repo.createCoderSubmissionDisposition(disposition);

        // Update adjudication: VERIFIED (CAS version 2 -> 3)
        const updated = this.repo.updateCoderSubmissionAdjudication(adjudicationId, 2, {
          status: 'VERIFIED',
          test_run_id: testRunId,
          git_status_evidence_id: stagedGitStatusEvidence?.id ?? null,
          git_diff_evidence_id: stagedGitDiffEvidence?.id ?? null,
          completed_at: phaseCNowIso,
        });

        if (!updated) {
          throw new CoderSubmissionAdjudicationError('STATUS_CONFLICT', 'Settlement CAS failed (expected version 2)');
        }

        // Create deterministic events atomically
        this.repo.createCoderSubmissionAdjudicationEvent({
          id: finalEventId,
          adjudication_id: adjudicationId,
          sequence: 3,
          event_type: 'VERIFICATION_SUCCEEDED',
          payload_json: eventPayload,
          payload_hash: eventPayloadHash,
          created_at: phaseCNowIso,
        });

        this.repo.createDeterministicGenericEvent({
          id: genericFinalEventId,
          project_id: sub.project_id,
          task_id: sub.task_id,
          agent_id: null,
          type: 'CODER_SUBMISSION_VERIFIED',
          summary: `Quarantined submission ${sub.id} successfully verified. Task advanced to REVIEW_READY.`,
          structured_payload: { adjudicationId, submissionId: sub.id, testRunId },
          timestamp: phaseCNowIso,
        });
      } else {
        // Authoritative Failure Path:
        const trans = TaskStateMachine.transition(currentTask.state, 'TESTS_FAILED', {
          revisionCount: currentTask.revision_count,
          maxRevisions: currentTask.max_revisions,
        });

        this.repo.updateTaskState(currentTask.id, trans.nextState, null, trans.incrementRevision);

        // Update adjudication: VERIFICATION_FAILED (CAS version 2 -> 3)
        const updated = this.repo.updateCoderSubmissionAdjudication(adjudicationId, 2, {
          status: 'VERIFICATION_FAILED',
          test_run_id: testRunId,
          git_status_evidence_id: stagedGitStatusEvidence?.id ?? null,
          git_diff_evidence_id: stagedGitDiffEvidence?.id ?? null,
          failure_code: failureCode || 'TESTS_FAILED',
          failure_json: canonicalJsonStringify({ error: failureDetail }),
          completed_at: phaseCNowIso,
        });

        if (!updated) {
          throw new CoderSubmissionAdjudicationError('STATUS_CONFLICT', 'Settlement CAS failed (expected version 2)');
        }

        this.repo.createCoderSubmissionAdjudicationEvent({
          id: finalEventId,
          adjudication_id: adjudicationId,
          sequence: 3,
          event_type: 'VERIFICATION_FAILED',
          payload_json: eventPayload,
          payload_hash: eventPayloadHash,
          created_at: phaseCNowIso,
        });

        this.repo.createDeterministicGenericEvent({
          id: genericFinalEventId,
          project_id: sub.project_id,
          task_id: sub.task_id,
          agent_id: null,
          type: 'CODER_SUBMISSION_VERIFICATION_FAILED',
          summary: `Quarantined submission ${sub.id} verification failed (${failureCode}): ${failureDetail}. Task state: ${trans.nextState}.`,
          structured_payload: { adjudicationId, error: failureDetail, failureCode, submissionId: sub.id },
          timestamp: phaseCNowIso,
        });
      }

      finalAdjudication = this.repo.getCoderSubmissionAdjudicationById(adjudicationId)!;
    });

    return {
      adjudication: finalAdjudication!,
      status: finalAdjudication!.status,
    };
  }

  /**
   * Resumes an ADMITTED submission that was safe pre-start.
   */
  public async resumeAdmittedSubmission(params: {
    requestId: string;
    submissionId: string;
    adjudicationId: string;
    expectedLifecycleVersion: number;
  }): Promise<{ adjudication: CoderSubmissionAdjudication; status: AdjudicationStatus }> {
    const adj = this.repo.getCoderSubmissionAdjudicationById(params.adjudicationId);
    if (!adj) {
      throw new CoderSubmissionAdjudicationError(
        'NOT_FOUND',
        `No adjudication found with ID "${params.adjudicationId}"`
      );
    }
    if (adj.submission_id !== params.submissionId) {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        `Adjudication "${params.adjudicationId}" does not belong to submission "${params.submissionId}"`
      );
    }
    if (adj.status !== 'ADMITTED') {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        `Adjudication is in status "${adj.status}", only "ADMITTED" can be resumed`
      );
    }
    if (adj.verification_execution_id !== null || adj.verification_started_at !== null) {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        'Cannot resume adjudication that already has an execution claim'
      );
    }
    if (adj.lifecycle_version !== params.expectedLifecycleVersion) {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        `Adjudication lifecycle version mismatch: expected ${params.expectedLifecycleVersion}, actual ${adj.lifecycle_version}`
      );
    }

    return this.admitSubmissionForVerification({
      requestId: params.requestId,
      submissionId: params.submissionId,
      resumeAdjudicationId: adj.id,
    });
  }

  /**
   * Acknowledges a RECOVERY_FENCED submission without rerunning it.
   */
  public acknowledgeRecoveryFenced(params: {
    requestId: string;
    submissionId: string;
    adjudicationId: string;
    expectedLifecycleVersion: number;
    decision: 'ACKNOWLEDGE' | 'CANCEL';
  }): { adjudication: CoderSubmissionAdjudication } {
    const adj = this.repo.getCoderSubmissionAdjudicationById(params.adjudicationId);
    if (!adj) {
      throw new CoderSubmissionAdjudicationError(
        'NOT_FOUND',
        `No adjudication found with ID "${params.adjudicationId}"`
      );
    }
    if (adj.submission_id !== params.submissionId) {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        `Adjudication "${params.adjudicationId}" does not belong to submission "${params.submissionId}"`
      );
    }
    if (adj.status !== 'RECOVERY_FENCED') {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        `Adjudication is in status "${adj.status}", expected "RECOVERY_FENCED"`
      );
    }
    if (adj.lifecycle_version !== params.expectedLifecycleVersion) {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        `Adjudication lifecycle version mismatch: expected ${params.expectedLifecycleVersion}, actual ${adj.lifecycle_version}`
      );
    }

    const nextStatus = params.decision === 'CANCEL' ? 'VERIFICATION_FAILED' : 'RECOVERY_FENCED';
    const nowIso = new Date().toISOString();

    const payloadJson = canonicalJsonStringify({
      acknowledged_at: nowIso,
      decision: params.decision,
    });
    const payloadHash = computeSha256(payloadJson);
    const eventType = params.decision === 'CANCEL' ? 'VERIFICATION_FAILED' : 'RECOVERY_FENCED';

    const eventId = deriveDeterministicAdjudicationEventId(
      adj.id,
      adj.lifecycle_version + 1,
      eventType,
      payloadHash
    );
    const genericEventId = deriveDeterministicGenericAdjudicationEventId(
      adj.id,
      adj.lifecycle_version + 1,
      eventType,
      payloadHash
    );

    this.repo.runInTransaction(() => {
      // NEVER clear verification_execution_id or verification_started_at!
      const updated = this.repo.updateCoderSubmissionAdjudication(adj.id, adj.lifecycle_version, {
        status: nextStatus,
        failure_code: params.decision === 'CANCEL' ? 'ORPHANED_VERIFICATION_CANCELLED' : adj.failure_code,
        completed_at: params.decision === 'CANCEL' ? nowIso : null,
        recovery_fenced_at: params.decision === 'CANCEL' ? null : adj.recovery_fenced_at,
      });

      if (!updated) {
        throw new CoderSubmissionAdjudicationError('STATUS_CONFLICT', 'Failed to update recovery fenced status (CAS mismatch)');
      }

      const seq = this.repo.getNextAdjudicationEventSequence(adj.id);
      this.repo.createCoderSubmissionAdjudicationEvent({
        id: eventId,
        adjudication_id: adj.id,
        sequence: seq,
        event_type: eventType,
        payload_json: payloadJson,
        payload_hash: payloadHash,
        created_at: nowIso,
      });

      this.repo.createDeterministicGenericEvent({
        id: genericEventId,
        project_id: adj.project_id,
        task_id: adj.task_id,
        agent_id: null,
        type: params.decision === 'CANCEL' ? 'CODER_SUBMISSION_RECOVERY_CANCELLED' : 'CODER_SUBMISSION_RECOVERY_ACKNOWLEDGED',
        summary: `Recovery fenced adjudication ${adj.id} acknowledged by Owner: ${params.decision}`,
        structured_payload: { adjudicationId: adj.id, decision: params.decision, acknowledgedAt: nowIso },
        timestamp: nowIso,
      });

      if (params.decision === 'CANCEL') {
        const liveTask = this.repo.getTask(adj.task_id);
        if (liveTask && (liveTask.state === 'VALIDATING' || liveTask.state === 'CODING')) {
          this.repo.updateTaskState(liveTask.id, 'NEEDS_HUMAN');
        }
      }
    });

    const updatedAdj = this.repo.getCoderSubmissionAdjudicationById(adj.id)!;
    return { adjudication: updatedAdj };
  }

  /**
   * One shared, typed, fail-closed integrity verifier used by list/inspect, admission,
   * claim, settlement, recovery, and review-package generation.
   */
  public validateSubmissionAndAuthorityIntegrity(
    sub: CoderSubmission
  ): SubmissionAuthorityIntegrityResult {
    const fenced_reasons: string[] = [];

    // 1. Parse stored JSON strictly as a non-null plain object (never array)
    let parsedClaim: Record<string, unknown> | null = null;
    let parsedEnvelope: Record<string, unknown> | null = null;

    try {
      const p = JSON.parse(sub.claim_content_json);
      if (typeof p === 'object' && p !== null && !Array.isArray(p)) {
        parsedClaim = p as Record<string, unknown>;
      } else {
        fenced_reasons.push('claim_content_json must be a non-null plain object');
      }
    } catch {
      fenced_reasons.push('claim_content_json is malformed JSON');
    }

    try {
      const p = JSON.parse(sub.canonical_envelope_json);
      if (typeof p === 'object' && p !== null && !Array.isArray(p)) {
        parsedEnvelope = p as Record<string, unknown>;
      } else {
        fenced_reasons.push('canonical_envelope_json must be a non-null plain object');
      }
    } catch {
      fenced_reasons.push('canonical_envelope_json is malformed JSON');
    }

    // 2. Exact own-property sets
    if (parsedClaim) {
      const claimKeys = Object.keys(parsedClaim).sort();
      const expectedClaimKeys = [...CLAIM_CONTENT_KEYS].sort();
      if (
        claimKeys.length !== expectedClaimKeys.length ||
        claimKeys.some((k, i) => k !== expectedClaimKeys[i])
      ) {
        fenced_reasons.push(
          `claim_content_json own-property set mismatch (keys: ${claimKeys.join(',')})`
        );
      }
    }

    if (parsedEnvelope) {
      const envelopeKeys = Object.keys(parsedEnvelope).sort();
      const expectedEnvelopeKeys = [...CANONICAL_ENVELOPE_KEYS].sort();
      if (
        envelopeKeys.length !== expectedEnvelopeKeys.length ||
        envelopeKeys.some((k, i) => k !== expectedEnvelopeKeys[i])
      ) {
        fenced_reasons.push(
          `canonical_envelope_json own-property set mismatch (keys: ${envelopeKeys.join(',')})`
        );
      }
    }

    // 3. Recompute canonical JSON & SHA-256 directly from stored raw strings
    const recomputedContentHash = computeSha256(sub.claim_content_json);
    const contentMatches = recomputedContentHash === sub.claim_content_hash;
    if (!contentMatches) {
      fenced_reasons.push('Recomputed claim_content_hash mismatch');
    }

    const recomputedEnvelopeHash = computeSha256(sub.canonical_envelope_json);
    const envelopeMatches = recomputedEnvelopeHash === sub.canonical_envelope_hash;
    if (!envelopeMatches) {
      fenced_reasons.push('Recomputed canonical_envelope_hash mismatch');
    }

    // 4. Validate durable authority graph with exact FK/ID equality
    const project = this.repo.getProject(sub.project_id);
    if (!project) {
      fenced_reasons.push(`Project "${sub.project_id}" not found`);
    } else if ((project.status as string) === 'ARCHIVED' || project.status === 'CANCELLED') {
      fenced_reasons.push(`Project "${sub.project_id}" is ${project.status}`);
    }

    const task = this.repo.getTask(sub.task_id);
    if (!task) {
      fenced_reasons.push(`Task "${sub.task_id}" not found`);
    } else {
      if (task.project_id !== sub.project_id) {
        fenced_reasons.push(`Task belongs to project "${task.project_id}", expected "${sub.project_id}"`);
      }
      if (typeof task.ownership_epoch !== 'number' || task.ownership_epoch <= 0) {
        fenced_reasons.push(`Task ownership epoch must be positive (got ${task.ownership_epoch})`);
      } else if (task.ownership_epoch !== sub.task_ownership_epoch) {
        fenced_reasons.push(
          `Task ownership epoch mismatch: task (${task.ownership_epoch}) does not match submission (${sub.task_ownership_epoch})`
        );
      }
    }

    const attempt = sub.attempt_id ? this.repo.getTaskAttempt(sub.attempt_id) : null;
    if (!attempt) {
      fenced_reasons.push(`Task attempt "${sub.attempt_id}" not found`);
    } else {
      if (attempt.task_id !== sub.task_id) {
        fenced_reasons.push(`Task attempt belongs to task "${attempt.task_id}", expected "${sub.task_id}"`);
      }
    }

    const assignment = sub.assignment_id ? this.repo.getAgentAssignment(sub.assignment_id) : null;
    if (!assignment) {
      fenced_reasons.push(`Agent assignment "${sub.assignment_id}" not found`);
    } else {
      if (assignment.attempt_id !== sub.attempt_id) {
        fenced_reasons.push(
          `Agent assignment belongs to attempt "${assignment.attempt_id}", expected "${sub.attempt_id}"`
        );
      }
    }

    const auth = this.repo.getExecutionAuthorization(sub.authorization_id);
    if (!auth) {
      fenced_reasons.push(`Execution authorization "${sub.authorization_id}" not found`);
    } else {
      if (auth.project_id !== sub.project_id) {
        fenced_reasons.push(`Authorization belongs to project "${auth.project_id}", expected "${sub.project_id}"`);
      }
      if (auth.task_id !== sub.task_id) {
        fenced_reasons.push(`Authorization belongs to task "${auth.task_id}", expected "${sub.task_id}"`);
      }
      if (auth.attempt_id !== sub.attempt_id) {
        fenced_reasons.push(`Authorization belongs to attempt "${auth.attempt_id}", expected "${sub.attempt_id}"`);
      }
      if (auth.assignment_id !== sub.assignment_id) {
        fenced_reasons.push(
          `Authorization belongs to assignment "${auth.assignment_id}", expected "${sub.assignment_id}"`
        );
      }
      if (parsedEnvelope) {
        if (auth.lifecycle_version !== parsedEnvelope.lifecycle_version) {
          fenced_reasons.push(
            `Authorization lifecycle_version (${auth.lifecycle_version}) does not match envelope (${parsedEnvelope.lifecycle_version})`
          );
        }
        if (auth.execution_id !== parsedEnvelope.execution_id) {
          fenced_reasons.push(
            `Authorization execution_id (${auth.execution_id}) does not match envelope (${parsedEnvelope.execution_id})`
          );
        }
        if (auth.routing_decision_id !== parsedEnvelope.routing_decision_id) {
          fenced_reasons.push('Authorization routing_decision_id does not match envelope');
        }
        if (auth.selected_provider_id !== parsedEnvelope.selected_provider_id) {
          fenced_reasons.push('Authorization selected_provider_id does not match envelope');
        }
        if ((auth.selected_account_id ?? null) !== (parsedEnvelope.selected_account_id ?? null)) {
          fenced_reasons.push('Authorization selected_account_id does not match envelope');
        }
        if (auth.selected_resource_id !== parsedEnvelope.selected_resource_id) {
          fenced_reasons.push('Authorization selected_resource_id does not match envelope');
        }
      }

      if (!auth.canonical_payload_json) {
        fenced_reasons.push('Execution authorization missing canonical_payload_json');
      } else if (auth.instruction_payload_hash) {
        let matches = false;
        try {
          const parsed = JSON.parse(auth.canonical_payload_json);
          if (computePayloadHash(parsed) === auth.instruction_payload_hash) {
            matches = true;
          }
        } catch {
          // ignore parse error
        }
        if (!matches && computeSha256(auth.canonical_payload_json) === auth.instruction_payload_hash) {
          matches = true;
        }
        if (!matches) {
          fenced_reasons.push(
            'Execution authorization canonical payload hash mismatch (INSTRUCTION_PAYLOAD_HASH_MISMATCH)'
          );
        }
      }

      // Slot & Lease check when authorization or assignment requires them
      const slotId = assignment?.selected_worker_slot_id || ((auth as unknown as Record<string, unknown>).worker_slot_id as string | null | undefined);
      if (slotId) {
        const slot = this.repo.getWorkerSlot(slotId);
        if (!slot) {
          fenced_reasons.push(`Worker slot "${slotId}" not found`);
        }
        const lease = this.repo.getActiveLeaseForSlot(slotId);
        if (!lease) {
          fenced_reasons.push(`Active lease missing for worker slot "${slotId}"`);
        }
      }

      // Manager protocol row selected by exact durable record ID, never latest-row fallback
      const managerMsgId = auth.manager_message_id;
      if (!managerMsgId) {
        fenced_reasons.push('Authorization missing manager_message_id');
      } else {
        const msgRow = this.db
          .prepare('SELECT * FROM protocol_messages WHERE id = ? OR message_id = ?')
          .get(managerMsgId, managerMsgId) as Record<string, unknown> | undefined;
        if (!msgRow) {
          fenced_reasons.push(`Manager protocol message "${managerMsgId}" not found by exact record ID`);
        } else {
          const rawMsgPayload =
            typeof msgRow.raw_payload === 'string'
              ? msgRow.raw_payload
              : typeof msgRow.payload_json === 'string'
              ? msgRow.payload_json
              : '';
          const recomputedMsgHash = computeSha256(rawMsgPayload);
          if (recomputedMsgHash !== auth.manager_payload_hash) {
            fenced_reasons.push('Manager protocol message raw payload hash mismatch');
          }
        }
      }
    }

    if (contentMatches && envelopeMatches && fenced_reasons.length === 0 && parsedClaim && parsedEnvelope) {
      return {
        valid: true,
        claim_content_hash_matches: true,
        canonical_envelope_hash_matches: true,
        parsed_claim: parsedClaim,
        parsed_envelope: parsedEnvelope,
        fenced_reasons: [],
      };
    }

    return {
      valid: false,
      claim_content_hash_matches: contentMatches,
      canonical_envelope_hash_matches: envelopeMatches,
      parsed_claim: parsedClaim,
      parsed_envelope: parsedEnvelope,
      fenced_reasons,
    };
  }

  /**
   * Helper to validate stored hashes and graph of a CoderSubmission.
   */
  public validateSubmissionIntegrity(sub: CoderSubmission): {
    valid: boolean;
    claim_content_hash_matches: boolean;
    canonical_envelope_hash_matches: boolean;
    fenced_reasons: string[];
  } {
    const result = this.validateSubmissionAndAuthorityIntegrity(sub);
    return {
      valid: result.valid,
      claim_content_hash_matches: result.claim_content_hash_matches,
      canonical_envelope_hash_matches: result.canonical_envelope_hash_matches,
      fenced_reasons: result.fenced_reasons,
    };
  }

  /**
   * Builds the complete, exact canonical authority snapshot.
   */
  public buildCanonicalAuthoritySnapshot(sub: CoderSubmission): CanonicalAuthoritySnapshot {
    const project = this.repo.getProject(sub.project_id)!;
    const task = this.repo.getTask(sub.task_id)!;
    const auth = this.repo.getExecutionAuthorization(sub.authorization_id)!;
    const attempt = sub.attempt_id ? this.repo.getTaskAttempt(sub.attempt_id) : null;
    const assignment = sub.assignment_id ? this.repo.getAgentAssignment(sub.assignment_id) : null;
    if (!attempt || !assignment) {
      throw new CoderSubmissionAdjudicationError(
        'INTEGRITY_CONFLICT',
        'Attempt or assignment missing from submission'
      );
    }

    const disps = this.repo.getCoderSubmissionDispositions(sub.id);
    const terminalDisp = disps.find((d) => d.disposition_event === 'REJECTED' || d.disposition_event === 'SETTLED');

    // Reject null/undefined/empty where lifecycle phase requires binding:
    if (!auth.lifecycle_version || typeof auth.lifecycle_version !== 'number') {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Authorization missing lifecycle_version');
    }
    if (!auth.execution_id || typeof auth.execution_id !== 'string') {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Authorization missing execution_id');
    }
    if (!auth.manager_message_id || typeof auth.manager_message_id !== 'string') {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Authorization missing manager_message_id');
    }
    if (!auth.canonical_payload_json) {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Authorization missing canonical_payload_json');
    }

    const snapshot: CanonicalAuthoritySnapshot = {
      assignment_id: assignment.id,
      assignment_status: assignment.status,
      attempt_id: attempt.id,
      attempt_number: attempt.attempt_number,
      attempt_status: attempt.status,
      authorization_canonical_payload_hash: computeSha256(auth.canonical_payload_json),
      authorization_id: auth.id,
      authorization_lifecycle_version: auth.lifecycle_version,
      authorization_status: auth.status,
      authorized_repository_head_sha: auth.repository_head_sha,
      canonical_envelope_hash: sub.canonical_envelope_hash,
      claim_content_hash: sub.claim_content_hash,
      current_terminal_disposition: terminalDisp ? `${terminalDisp.disposition_event}/${terminalDisp.disposition_reason}` : null,
      execution_id: auth.execution_id,
      manager_protocol_message_id: auth.manager_message_id,
      manager_raw_payload_hash: auth.manager_payload_hash,
      project_id: project.id,
      project_repository_path: project.repository_path,
      project_status: project.status,
      quarantine_status: 'QUARANTINED',
      routing_decision_id: auth.routing_decision_id,
      selected_account_id: auth.selected_account_id ?? null,
      selected_provider_id: auth.selected_provider_id,
      selected_resource_id: auth.selected_resource_id,
      submission_base_sha: sub.base_sha,
      submission_id: sub.id,
      submission_repository_head_sha: sub.authorized_head_sha,
      submitted_at: sub.submitted_at,
      task_base_sha: task.base_sha || '',
      task_id: task.id,
      task_ownership_epoch: sub.task_ownership_epoch,
      task_state: task.state,
      worker_slot_id: assignment.selected_worker_slot_id ?? ((auth as unknown as Record<string, unknown>).worker_slot_id as string | null | undefined) ?? null,
    };

    // Assert exact top-level property keys
    const keys = Object.keys(snapshot).sort();
    const expectedKeys = [...AUTHORITY_SNAPSHOT_KEYS].sort();
    if (keys.length !== expectedKeys.length || keys.some((k, i) => k !== expectedKeys[i])) {
      throw new CoderSubmissionAdjudicationError('INTEGRITY_CONFLICT', 'Authority snapshot key set mismatch');
    }

    return snapshot;
  }

  /**
   * Captures a canonical workspace fingerprint that binds HEAD, porcelain status,
   * tracked diff, and untracked file contents deterministically.
   */
  public async captureCanonicalWorkspaceFingerprint(
    repoPath: string,
    baseSha?: string
  ): Promise<CanonicalWorkspaceFingerprint> {
    const headRes = await GitService.getHeadSha(repoPath);
    if (headRes.status !== 'SUCCESS' || !headRes.sha) {
      throw new CoderSubmissionAdjudicationError('WORKTREE_DRIFT', 'Failed to read repository HEAD SHA');
    }

    const statusProc = await ProcessRunner.execute({
      executable: 'git',
      args: ['status', '--porcelain=v1', '-uall'],
      cwd: repoPath,
      timeoutMs: 15000,
    });

    if (statusProc.exitCode !== 0) {
      throw new CoderSubmissionAdjudicationError(
        'WORKTREE_DRIFT',
        `Git status failed with exit code ${statusProc.exitCode}: ${statusProc.stderr}`
      );
    }

    const statusLines = statusProc.stdout
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0)
      .sort();
    const statusHash = computeSha256(statusLines.join('\n'));

    // Tracked diff identity
    const diffProc = await ProcessRunner.execute({
      executable: 'git',
      args: ['diff', 'HEAD'],
      cwd: repoPath,
      timeoutMs: 20000,
    });
    const diffHash = computeSha256(diffProc.exitCode === 0 ? diffProc.stdout : '');

    // Deterministic content identity for untracked files
    const untrackedFileLines: string[] = [];
    for (const line of statusLines) {
      if (line.startsWith('?? ')) {
        const relPath = line.substring(3).trim();
        const absPath = path.join(repoPath, relPath);
        let contentHash = 'MISSING';
        try {
          if (fs.existsSync(absPath)) {
            const buf = fs.readFileSync(absPath);
            contentHash = crypto.createHash('sha256').update(buf).digest('hex');
          }
        } catch {
          // Unreadable file
        }
        untrackedFileLines.push(`${relPath}:${contentHash}`);
      }
    }
    untrackedFileLines.sort();
    const untrackedFilesHash = computeSha256(untrackedFileLines.join('\n'));

    const fingerprintPayload = canonicalJsonStringify({
      diff_hash: diffHash,
      head_sha: headRes.sha,
      status_hash: statusHash,
      status_lines: statusLines,
      untracked_files_hash: untrackedFilesHash,
    });

    const branchRes = await GitService.getCurrentBranch(repoPath);
    const branch = branchRes.status === 'SUCCESS' ? branchRes.branch ?? null : null;

    return {
      head_sha: headRes.sha,
      status_lines: statusLines,
      status_hash: statusHash,
      diff_hash: diffHash,
      untracked_files_hash: untrackedFilesHash,
      fingerprint_hash: computeSha256(fingerprintPayload),
      isClean: statusLines.length === 0,
      branch,
    };
  }
}
