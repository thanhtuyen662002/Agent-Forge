import crypto from 'crypto';
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
} from '../types/adjudication';
import { VerificationService } from './VerificationService';
import { EventService } from './EventService';
import { GitService } from './GitService';
import { TaskStateMachine } from '../state/taskStateMachine';
import { canonicalJsonStringify, computeSha256 } from '../../mcp/submissionProtocol';
import { computePayloadHash } from './ExecutionAuthorizationService';

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
  public inspectQuarantinedSubmission(submissionId: string): QuarantinedSubmissionInspection {
    const sub = this.repo.getCoderSubmissionById(submissionId);
    if (!sub) {
      throw new CoderSubmissionAdjudicationError(
        'NOT_FOUND',
        `Quarantined submission "${submissionId}" not found`
      );
    }

    let claimContent: any = {};
    let canonicalEnvelope: any = {};
    try {
      claimContent = JSON.parse(sub.claim_content_json);
      canonicalEnvelope = JSON.parse(sub.canonical_envelope_json);
    } catch {
      // Malformed stored JSON
    }

    const integrity = this.validateSubmissionIntegrity(sub);
    const dispositions = this.repo.getCoderSubmissionDispositions(sub.id).map((d) => ({
      id: d.id,
      disposition_event: d.disposition_event,
      disposition_reason: d.disposition_reason,
      actor_type: d.actor_type,
      actor_id: d.actor_id,
      created_at: d.created_at,
      disposition_metadata: d.disposition_metadata_json ? JSON.parse(d.disposition_metadata_json) : null,
    }));

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

    return {
      submission: sub,
      candidate: sub,
      authority_snapshot: authoritySnapshot,
      claim_content: {
        summary: sub.summary,
        status: sub.claimed_status,
        changed_files: Array.isArray(claimContent.changed_files) ? claimContent.changed_files : [],
        tests_claimed: Array.isArray(claimContent.tests_claimed) ? claimContent.tests_claimed : [],
        blockers: Array.isArray(claimContent.blockers) ? claimContent.blockers : [],
        review_requested: Boolean(sub.review_requested),
        client_metadata: (typeof claimContent.client_metadata === 'object' && claimContent.client_metadata !== null)
          ? claimContent.client_metadata
          : {},
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
    const adjudicationId = crypto.randomUUID();
    const dispositionId = crypto.randomUUID();
    const eventId = crypto.randomUUID();

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
        operator_notes: params.reason,
        adjudication_id: adjudicationId,
      }),
      created_at: nowIso,
    };

    const eventPayloadJson = canonicalJsonStringify({
      adjudication_id: adjudicationId,
      submission_id: sub.id,
      action: 'REJECT',
      disposition_reason: dispositionReason,
      reason: params.reason,
    });

    const adjEvent: CoderSubmissionAdjudicationEvent = {
      id: eventId,
      adjudication_id: adjudicationId,
      sequence: 1,
      event_type: 'REJECTED',
      payload_json: eventPayloadJson,
      payload_hash: computeSha256(eventPayloadJson),
      created_at: nowIso,
    };

    // Execute atomic transaction
    this.repo.runInTransaction(() => {
      this.repo.createCoderSubmissionAdjudication(adjudication);
      this.repo.createCoderSubmissionDisposition(disposition);
      this.repo.createCoderSubmissionAdjudicationEvent(adjEvent);
      if (this.eventService) {
        this.eventService.record(
          sub.project_id,
          'CODER_SUBMISSION_REJECTED',
          `Quarantined coder submission ${sub.id} rejected by operator: ${params.reason}`,
          { submissionId: sub.id, adjudicationId, dispositionReason },
          sub.task_id
        );
      }
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
    const adjudicationId = crypto.randomUUID();
    const dispositionId = crypto.randomUUID();
    const eventId = crypto.randomUUID();

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
        replacement_submission_id: params.replacementSubmissionId,
        operator_reason: params.reason,
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
        replacement_submission_id: params.replacementSubmissionId,
        operator_notes: params.reason,
        adjudication_id: adjudicationId,
      }),
      created_at: nowIso,
    };

    const eventPayloadJson = canonicalJsonStringify({
      adjudication_id: adjudicationId,
      submission_id: sub.id,
      replacement_submission_id: params.replacementSubmissionId,
      action: 'SUPERSEDE',
      reason: params.reason,
    });

    const adjEvent: CoderSubmissionAdjudicationEvent = {
      id: eventId,
      adjudication_id: adjudicationId,
      sequence: 1,
      event_type: 'SUPERSEDED',
      payload_json: eventPayloadJson,
      payload_hash: computeSha256(eventPayloadJson),
      created_at: nowIso,
    };

    this.repo.runInTransaction(() => {
      this.repo.createCoderSubmissionAdjudication(adjudication);
      this.repo.createCoderSubmissionDisposition(disposition);
      this.repo.createCoderSubmissionAdjudicationEvent(adjEvent);
      if (this.eventService) {
        this.eventService.record(
          sub.project_id,
          'CODER_SUBMISSION_SUPERSEDED',
          `Submission ${sub.id} superseded by ${params.replacementSubmissionId}: ${params.reason}`,
          { submissionId: sub.id, replacementSubmissionId: params.replacementSubmissionId, adjudicationId },
          sub.task_id
        );
      }
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
    if (task.state !== 'CODING') {
      throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', `Task must be in CODING state (got ${task.state})`);
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

    let authPayload: any;
    try {
      authPayload = JSON.parse(auth.canonical_payload_json);
    } catch {
      throw new CoderSubmissionAdjudicationError(
        'COMMAND_SNAPSHOT_INVALID',
        'Authorization canonical payload is malformed JSON'
      );
    }

    const frozenCommands = authPayload.verificationCommands;
    if (!frozenCommands || typeof frozenCommands !== 'object') {
      throw new CoderSubmissionAdjudicationError(
        'COMMAND_SNAPSHOT_INVALID',
        'Frozen verificationCommands snapshot missing from authorization'
      );
    }

    const frozenTestCmd = frozenCommands.TEST;
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

    const liveHeadRes = await GitService.getHeadSha(project.repository_path);
    if (liveHeadRes.status !== 'SUCCESS' || !liveHeadRes.sha) {
      throw new CoderSubmissionAdjudicationError('WORKTREE_DRIFT', 'Failed to read live Git HEAD SHA');
    }

    if (liveHeadRes.sha.toLowerCase() !== sub.authorized_head_sha.toLowerCase()) {
      throw new CoderSubmissionAdjudicationError(
        'WORKTREE_DRIFT',
        `Live repository HEAD drift: live HEAD (${liveHeadRes.sha}) has drifted from authorized HEAD (${sub.authorized_head_sha})`
      );
    }

    const preGitStatus = await GitService.getStatus(project.repository_path);
    if (!preGitStatus.isClean) {
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
      adjudicationId = crypto.randomUUID();
      const syntheticMsgId = `msg-sub-${sub.id}`;
      const syntheticProtocolId = crypto.randomUUID();

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
        adjudication_id: adjudicationId,
        submission_id: sub.id,
        action: 'ADMIT_VERIFICATION',
        head_sha: liveHeadRes.sha,
      });

      const admitEvent: CoderSubmissionAdjudicationEvent = {
        id: crypto.randomUUID(),
        adjudication_id: adjudicationId,
        sequence: 1,
        event_type: 'ADMITTED',
        payload_json: admitEventPayload,
        payload_hash: computeSha256(admitEventPayload),
        created_at: phaseANowIso,
      };

      this.repo.runInTransaction(() => {
        // Re-verify live task state in transaction
        const liveTask = this.repo.getTask(sub.task_id);
        if (!liveTask || liveTask.state !== 'CODING') {
          throw new CoderSubmissionAdjudicationError(
            'PRECONDITION_FENCED',
            `Task "${sub.task_id}" state is "${liveTask?.state}", must be exactly "CODING"`
          );
        }
        if (liveTask.ownership_epoch !== sub.task_ownership_epoch) {
          throw new CoderSubmissionAdjudicationError(
            'PRECONDITION_FENCED',
            `Task ownership epoch (${liveTask.ownership_epoch}) does not match submission (${sub.task_ownership_epoch})`
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

        // Transition task CODING -> VALIDATING
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

        // Create adjudication record & events
        this.repo.createCoderSubmissionAdjudication(admissionAdjudication);
        this.repo.createCoderSubmissionAdjudicationEvent(admitEvent);

        if (this.eventService) {
          this.eventService.record(
            sub.project_id,
            'CODER_SUBMISSION_ADMITTED',
            `Quarantined coder submission ${sub.id} admitted for verification on task ${sub.task_id}`,
            { submissionId: sub.id, adjudicationId, headSha: liveHeadRes.sha },
            sub.task_id
          );
        }
      });
    }

    // =========================================================================
    // PHASE B: EXECUTION CLAIM TRANSACTION (Atomic CAS)
    // =========================================================================
    const executionId = crypto.randomUUID();
    const phaseBNowIso = new Date().toISOString();

    const workspaceSnapshotBefore = {
      head_sha: liveHeadRes.sha,
      isClean: preGitStatus.isClean,
      branch: preGitStatus.branch,
      modified_files: preGitStatus.modifiedFiles ?? [],
      untracked_files: preGitStatus.untrackedFiles ?? [],
    };
    const workspaceSnapshotJson = canonicalJsonStringify(workspaceSnapshotBefore);
    const workspaceSnapshotHash = computeSha256(workspaceSnapshotJson);

    const claimEventPayload = canonicalJsonStringify({
      adjudication_id: adjudicationId,
      verification_execution_id: executionId,
      started_at: phaseBNowIso,
    });

    const claimEvent: CoderSubmissionAdjudicationEvent = {
      id: crypto.randomUUID(),
      adjudication_id: adjudicationId,
      sequence: 2,
      event_type: 'VERIFICATION_CLAIMED',
      payload_json: claimEventPayload,
      payload_hash: computeSha256(claimEventPayload),
      created_at: phaseBNowIso,
    };

    let claimed = false;
    this.repo.runInTransaction(() => {
      claimed = this.repo.updateCoderSubmissionAdjudication(adjudicationId, 1, {
        status: 'VERIFYING',
        verification_execution_id: executionId,
        verification_started_at: phaseBNowIso,
        workspace_snapshot_before_json: workspaceSnapshotJson,
        workspace_snapshot_before_hash: workspaceSnapshotHash,
      });

      if (claimed) {
        this.repo.createCoderSubmissionAdjudicationEvent(claimEvent);
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
    let testRunResult: any = null;
    let gitStatusResult: any = null;
    let gitDiffResult: any = null;
    let executionFailureCode: AdjudicationFailureCode | null = null;
    let failureDetail: string | null = null;

    try {
      // Execute test suite strictly using frozen command snapshot
      testRunResult = await this.verificationService.runTestsWithFrozenCommand(
        sub.project_id,
        sub.task_id,
        snapshot.attempt_id,
        project.repository_path,
        frozenTestCmd
      );

      // Collect post-run Git evidence
      gitStatusResult = await GitService.getStatus(project.repository_path);
      gitDiffResult = await GitService.getDiff(project.repository_path, sub.base_sha);
      const postHeadRes = await GitService.getHeadSha(project.repository_path);

      // Validate worktree drift during verification
      if (postHeadRes.status === 'SUCCESS' && postHeadRes.sha && postHeadRes.sha.toLowerCase() !== liveHeadRes.sha.toLowerCase()) {
        executionFailureCode = 'WORKTREE_DRIFT';
        failureDetail = `Repository HEAD moved during verification from ${liveHeadRes.sha} to ${postHeadRes.sha}`;
      } else if (testRunResult.exit_code < 0) {
        executionFailureCode = 'PROCESS_START_FAILED';
        failureDetail = `Process execution failed to start with exit code ${testRunResult.exit_code}`;
      } else if (testRunResult.exit_code !== 0) {
        executionFailureCode = 'TESTS_FAILED';
        failureDetail = `Test run failed with exit code ${testRunResult.exit_code}`;
      } else if (gitStatusResult.status !== 'SUCCESS' || gitDiffResult.status !== 'SUCCESS') {
        executionFailureCode = 'EVIDENCE_CAPTURE_FAILED';
        failureDetail = 'Git evidence capture failed';
      }
    } catch (err: any) {
      executionFailureCode = 'PROCESS_START_FAILED';
      failureDetail = err.message || 'Process execution error';
    }

    // =========================================================================
    // PHASE C: SETTLEMENT TRANSACTION (Short BEGIN IMMEDIATE)
    // =========================================================================
    const phaseCNowIso = new Date().toISOString();
    const isSuccess = executionFailureCode === null && testRunResult && testRunResult.exit_code === 0;

    let finalAdjudication: CoderSubmissionAdjudication | null = null;

    this.repo.runInTransaction(() => {
      const currentTask = this.repo.getTask(sub.task_id);
      if (!currentTask) {
        throw new Error(`Task ${sub.task_id} missing during settlement`);
      }

      if (isSuccess) {
        // Authoritative Success Path:
        // Transition task: VALIDATING -> REVIEW_READY
        const trans = TaskStateMachine.transition(currentTask.state, 'EVIDENCE_GATHERED', {
          revisionCount: currentTask.revision_count,
          maxRevisions: currentTask.max_revisions,
        });

        this.repo.updateTaskState(currentTask.id, trans.nextState);
        this.repo.updateTaskShas(currentTask.id, sub.base_sha, liveHeadRes.sha);

        // Append terminal disposition: SETTLED / ACCEPTED_VERIFIED
        const dispId = crypto.randomUUID();
        const disposition: CoderSubmissionDisposition = {
          id: dispId,
          submission_id: sub.id,
          disposition_event: 'SETTLED',
          disposition_reason: 'ACCEPTED_VERIFIED',
          actor_type: 'OPERATOR',
          actor_id: 'OWNER_LOCAL_UI',
          disposition_metadata_json: canonicalJsonStringify({
            adjudication_id: adjudicationId,
            test_run_id: testRunResult.id,
            exit_code: testRunResult.exit_code,
          }),
          created_at: phaseCNowIso,
        };
        this.repo.createCoderSubmissionDisposition(disposition);

        let gitStatusEvidenceId: string | null = null;
        let gitDiffEvidenceId: string | null = null;

        const artifactStore = this.verificationService?.getArtifactStore?.();
        if (artifactStore) {
          if (gitStatusResult) {
            gitStatusEvidenceId = crypto.randomUUID();
            const statusEv = artifactStore.store(
              gitStatusEvidenceId,
              sub.project_id,
              sub.task_id,
              snapshot.attempt_id,
              'GIT_STATUS',
              `Git Status: ${gitStatusResult.isClean ? 'Clean' : 'Modified'} on ${gitStatusResult.branch ?? 'main'}`,
              JSON.stringify(gitStatusResult, null, 2),
              'application/json'
            );
            this.repo.createEvidence(statusEv);
          }

          if (gitDiffResult) {
            gitDiffEvidenceId = crypto.randomUUID();
            const diffEv = artifactStore.store(
              gitDiffEvidenceId,
              sub.project_id,
              sub.task_id,
              snapshot.attempt_id,
              'GIT_DIFF',
              `Git Diff: ${gitDiffResult.filesChanged?.length ?? 0} files changed`,
              gitDiffResult.diffContent ?? '',
              'text/x-diff'
            );
            this.repo.createEvidence(diffEv);
          }
        }

        // Update adjudication: VERIFIED (CAS version 2 -> 3)
        this.repo.updateCoderSubmissionAdjudication(adjudicationId, 2, {
          status: 'VERIFIED',
          test_run_id: testRunResult.id,
          git_status_evidence_id: gitStatusEvidenceId,
          git_diff_evidence_id: gitDiffEvidenceId,
          completed_at: phaseCNowIso,
        });

        // Append events
        const successPayload = canonicalJsonStringify({
          adjudication_id: adjudicationId,
          test_run_id: testRunResult.id,
          exit_code: 0,
        });
        this.repo.createCoderSubmissionAdjudicationEvent({
          id: crypto.randomUUID(),
          adjudication_id: adjudicationId,
          sequence: 3,
          event_type: 'VERIFICATION_SUCCEEDED',
          payload_json: successPayload,
          payload_hash: computeSha256(successPayload),
          created_at: phaseCNowIso,
        });

        if (this.eventService) {
          this.eventService.record(
            sub.project_id,
            'CODER_SUBMISSION_VERIFIED',
            `Quarantined submission ${sub.id} successfully verified. Task advanced to REVIEW_READY.`,
            { submissionId: sub.id, adjudicationId, testRunId: testRunResult.id },
            sub.task_id
          );
        }
      } else {
        // Authoritative Failure Path:
        // Transition task: VALIDATING -> CODING (or NEEDS_HUMAN) via TESTS_FAILED trigger
        const trans = TaskStateMachine.transition(currentTask.state, 'TESTS_FAILED', {
          revisionCount: currentTask.revision_count,
          maxRevisions: currentTask.max_revisions,
        });

        this.repo.updateTaskState(currentTask.id, trans.nextState, null, trans.incrementRevision);

        // Update adjudication: VERIFICATION_FAILED (CAS version 2 -> 3)
        // CRITICAL: DO NOT write SETTLED / ACCEPTED_VERIFIED or SETTLED / MANUAL_OVERRIDE!
        this.repo.updateCoderSubmissionAdjudication(adjudicationId, 2, {
          status: 'VERIFICATION_FAILED',
          test_run_id: testRunResult?.id ?? null,
          failure_code: executionFailureCode || 'TESTS_FAILED',
          failure_json: canonicalJsonStringify({ error: failureDetail }),
          completed_at: phaseCNowIso,
        });

        const failurePayload = canonicalJsonStringify({
          adjudication_id: adjudicationId,
          failure_code: executionFailureCode || 'TESTS_FAILED',
          error: failureDetail,
        });
        this.repo.createCoderSubmissionAdjudicationEvent({
          id: crypto.randomUUID(),
          adjudication_id: adjudicationId,
          sequence: 3,
          event_type: 'VERIFICATION_FAILED',
          payload_json: failurePayload,
          payload_hash: computeSha256(failurePayload),
          created_at: phaseCNowIso,
        });

        if (this.eventService) {
          this.eventService.record(
            sub.project_id,
            'CODER_SUBMISSION_VERIFICATION_FAILED',
            `Quarantined submission ${sub.id} verification failed (${executionFailureCode}): ${failureDetail}. Task state: ${trans.nextState}.`,
            { submissionId: sub.id, adjudicationId, failureCode: executionFailureCode, error: failureDetail },
            sub.task_id
          );
        }
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
    lifecycleVersion?: number;
  }): Promise<{ adjudication: CoderSubmissionAdjudication; status: AdjudicationStatus }> {
    const adj = this.repo.getActiveCoderSubmissionAdjudication(params.submissionId);
    if (!adj) {
      throw new CoderSubmissionAdjudicationError(
        'NOT_FOUND',
        `No active adjudication found for submission "${params.submissionId}"`
      );
    }
    if (adj.status !== 'ADMITTED') {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        `Adjudication is in status "${adj.status}", only "ADMITTED" can be resumed`
      );
    }
    if (params.lifecycleVersion !== undefined && adj.lifecycle_version !== params.lifecycleVersion) {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        `Adjudication lifecycle version mismatch: expected ${params.lifecycleVersion}, actual ${adj.lifecycle_version}`
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
    lifecycleVersion?: number;
    decision: 'RETRY' | 'CANCEL';
  }): { adjudication: CoderSubmissionAdjudication } {
    const adj = this.repo.getActiveCoderSubmissionAdjudication(params.submissionId);
    if (!adj) {
      throw new CoderSubmissionAdjudicationError(
        'NOT_FOUND',
        `No active adjudication found for submission "${params.submissionId}"`
      );
    }
    if (adj.status !== 'RECOVERY_FENCED') {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        `Adjudication is in status "${adj.status}", expected "RECOVERY_FENCED"`
      );
    }
    if (params.lifecycleVersion !== undefined && adj.lifecycle_version !== params.lifecycleVersion) {
      throw new CoderSubmissionAdjudicationError(
        'STATUS_CONFLICT',
        `Adjudication lifecycle version mismatch: expected ${params.lifecycleVersion}, actual ${adj.lifecycle_version}`
      );
    }

    const nextStatus = params.decision === 'CANCEL' ? 'VERIFICATION_FAILED' : 'ADMITTED';
    const nowIso = new Date().toISOString();

    this.repo.runInTransaction(() => {
      const updated = this.repo.updateCoderSubmissionAdjudication(adj.id, adj.lifecycle_version, {
        status: nextStatus,
        failure_code: params.decision === 'CANCEL' ? 'ORPHANED_VERIFICATION_CANCELLED' : null,
        completed_at: params.decision === 'CANCEL' ? nowIso : null,
        recovery_fenced_at: null,
        verification_started_at: params.decision === 'RETRY' ? null : undefined,
        verification_execution_id: params.decision === 'RETRY' ? null : undefined,
      });
      if (!updated) {
        throw new CoderSubmissionAdjudicationError('STATUS_CONFLICT', 'Failed to update recovery fenced status');
      }

      const seq = this.repo.getNextAdjudicationEventSequence(adj.id);
      const payloadJson = canonicalJsonStringify({
        decision: params.decision,
        acknowledged_at: nowIso,
      });
      this.repo.createCoderSubmissionAdjudicationEvent({
        id: crypto.randomUUID(),
        adjudication_id: adj.id,
        sequence: seq,
        event_type: params.decision === 'CANCEL' ? 'VERIFICATION_FAILED' : 'ADMITTED',
        payload_json: payloadJson,
        payload_hash: computeSha256(payloadJson),
        created_at: nowIso,
      });
    });

    const updatedAdj = this.repo.getCoderSubmissionAdjudicationById(adj.id)!;
    return { adjudication: updatedAdj };
  }

  /**
   * Helper to validate stored hashes of a CoderSubmission.
   */
  public validateSubmissionIntegrity(sub: CoderSubmission): {
    valid: boolean;
    claim_content_hash_matches: boolean;
    canonical_envelope_hash_matches: boolean;
    fenced_reasons: string[];
  } {
    const fenced_reasons: string[] = [];
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

    // Graph and cross-binding integrity
    const project = this.repo.getProject(sub.project_id);
    if (!project) {
      fenced_reasons.push(`Project "${sub.project_id}" not found`);
    }

    const task = this.repo.getTask(sub.task_id);
    if (!task) {
      fenced_reasons.push(`Task "${sub.task_id}" not found`);
    } else if (task.project_id !== sub.project_id) {
      fenced_reasons.push(`Task belongs to project "${task.project_id}", expected "${sub.project_id}"`);
    }

    const auth = this.repo.getExecutionAuthorization(sub.authorization_id);
    if (!auth) {
      fenced_reasons.push(`Missing authorization "${sub.authorization_id}"`);
    } else {
      if (auth.project_id !== sub.project_id) {
        fenced_reasons.push(`Authorization belongs to project "${auth.project_id}", expected "${sub.project_id}"`);
      }
      if (auth.task_id !== sub.task_id) {
        fenced_reasons.push(`Authorization belongs to task "${auth.task_id}", expected "${sub.task_id}"`);
      }
    }

    return {
      valid: contentMatches && envelopeMatches && fenced_reasons.length === 0,
      claim_content_hash_matches: contentMatches,
      canonical_envelope_hash_matches: envelopeMatches,
      fenced_reasons,
    };
  }

  /**
   * Builds the complete, exact canonical authority snapshot.
   */
  private buildCanonicalAuthoritySnapshot(sub: CoderSubmission): CanonicalAuthoritySnapshot {
    const project = this.repo.getProject(sub.project_id);
    if (!project) throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Project not found');

    const task = this.repo.getTask(sub.task_id);
    if (!task) throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Task not found');

    const auth = this.repo.getExecutionAuthorization(sub.authorization_id);
    if (!auth) throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Authorization not found');

    if (!auth.attempt_id) throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Authorization missing attempt_id');
    const attempt = this.repo.getTaskAttempt(auth.attempt_id);
    if (!attempt) throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Attempt not found');

    if (!auth.assignment_id) throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Authorization missing assignment_id');
    const assignment = this.repo.getAgentAssignment(auth.assignment_id);
    if (!assignment) throw new CoderSubmissionAdjudicationError('PRECONDITION_FENCED', 'Assignment not found');

    const disps = this.repo.getCoderSubmissionDispositions(sub.id);
    const terminalDisp = disps.find((d) => d.disposition_event === 'REJECTED' || d.disposition_event === 'SETTLED');

    const snapshot: CanonicalAuthoritySnapshot = {
      assignment_id: assignment.id,
      assignment_status: assignment.status,
      attempt_id: attempt.id,
      attempt_number: attempt.attempt_number,
      attempt_status: attempt.status,
      authorization_canonical_payload_hash: auth.canonical_payload_json ? computeSha256(auth.canonical_payload_json) : computeSha256(''),
      authorization_id: auth.id,
      authorization_lifecycle_version: auth.lifecycle_version ?? 1,
      authorization_status: auth.status,
      authorized_repository_head_sha: auth.repository_head_sha,
      canonical_envelope_hash: sub.canonical_envelope_hash,
      claim_content_hash: sub.claim_content_hash,
      current_terminal_disposition: terminalDisp ? `${terminalDisp.disposition_event}/${terminalDisp.disposition_reason}` : null,
      execution_id: auth.execution_id ?? '',
      manager_protocol_message_id: auth.manager_message_id ?? '',
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
      worker_slot_id: null,
    };

    // Assert exact top-level property keys
    const keys = Object.keys(snapshot).sort();
    const expectedKeys = [...AUTHORITY_SNAPSHOT_KEYS].sort();
    if (keys.length !== expectedKeys.length || keys.some((k, i) => k !== expectedKeys[i])) {
      throw new CoderSubmissionAdjudicationError('INTEGRITY_CONFLICT', 'Authority snapshot key set mismatch');
    }

    return snapshot;
  }
}
