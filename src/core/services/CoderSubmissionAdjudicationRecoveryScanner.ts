import Database from 'better-sqlite3';
import { Repository, CoderSubmission } from '../database/repositories';
import { EventService } from './EventService';
import {
  CoderSubmissionAdjudication,
  CoderSubmissionAdjudicationEvent,
  RecoveryClassification,
  AdjudicationRecoveryScanItemResult,
  AdjudicationRecoveryScanReport,
} from '../types/adjudication';
import { canonicalJsonStringify, computeSha256 } from '../context/ContextIntegrity';
import { TaskStateMachine } from '../state/taskStateMachine';

export class CoderSubmissionAdjudicationRecoveryScanner {
  constructor(
    private db: Database.Database,
    private repo: Repository,
    private eventService?: EventService
  ) {}

  public scanAndReconcile(): AdjudicationRecoveryScanReport {
    const nowIso = new Date().toISOString();

    const rows = this.db
      .prepare(`
        SELECT *
        FROM coder_submission_adjudications
        ORDER BY created_at ASC, id ASC
      `)
      .all() as CoderSubmissionAdjudication[];

    const items: AdjudicationRecoveryScanItemResult[] = [];
    let preVerificationNotStartedCount = 0;
    let verificationInFlightUnresolvedCount = 0;
    let verificationResultStateIncompleteCount = 0;
    let alreadyReconciledCount = 0;
    let authorityConflictCount = 0;
    let fencedCount = 0;
    let settledCount = 0;

    for (const adj of rows) {
      const itemResult = this.reconcileSingleAdjudication(adj, nowIso);
      items.push(itemResult);

      switch (itemResult.classification) {
        case 'PRE_VERIFICATION_NOT_STARTED':
          preVerificationNotStartedCount++;
          break;
        case 'VERIFICATION_IN_FLIGHT_UNRESOLVED':
          verificationInFlightUnresolvedCount++;
          if (itemResult.action_taken === 'FENCED') fencedCount++;
          break;
        case 'VERIFICATION_RESULT_STATE_INCOMPLETE':
          verificationResultStateIncompleteCount++;
          if (itemResult.action_taken === 'SETTLED') settledCount++;
          break;
        case 'ALREADY_RECONCILED':
          alreadyReconciledCount++;
          break;
        case 'AUTHORITY_CONFLICT':
          authorityConflictCount++;
          if (itemResult.action_taken === 'FENCED_CONFLICT') fencedCount++;
          break;
      }
    }

    return {
      scannedCount: rows.length,
      preVerificationNotStartedCount,
      verificationInFlightUnresolvedCount,
      verificationResultStateIncompleteCount,
      alreadyReconciledCount,
      authorityConflictCount,
      fencedCount,
      settledCount,
      items,
      scannedAt: nowIso,
    };
  }

  private reconcileSingleAdjudication(
    adj: CoderSubmissionAdjudication,
    nowIso: string
  ): AdjudicationRecoveryScanItemResult {
    // 1. Verify Durable Authority Graph
    const sub = this.repo.getCoderSubmissionById(adj.submission_id);
    const auth = this.repo.getExecutionAuthorization(adj.authorization_id);
    const task = this.repo.getTask(adj.task_id);
    const project = this.repo.getProject(adj.project_id);
    const attempt = this.repo.getTaskAttempt(adj.attempt_id);
    const assignment = this.repo.getAgentAssignment(adj.assignment_id);

    const isAuthorityIntact =
      !!sub &&
      !!auth &&
      !!task &&
      !!project &&
      !!attempt &&
      !!assignment &&
      adj.authority_snapshot_hash === computeSha256(adj.authority_snapshot_json) &&
      (!adj.verification_commands_json ||
        adj.verification_commands_hash === computeSha256(adj.verification_commands_json));

    if (!isAuthorityIntact) {
      if (adj.status !== 'RECOVERY_FENCED' && adj.status !== 'REJECTED' && adj.status !== 'SUPERSEDED') {
        this.fenceAdjudication(
          adj,
          'INTEGRITY_MISMATCH',
          'Durable authority graph missing or authority snapshot hash corrupted',
          nowIso
        );
        return {
          adjudication_id: adj.id,
          submission_id: adj.submission_id,
          classification: 'AUTHORITY_CONFLICT',
          action_taken: 'FENCED_CONFLICT',
          error: 'Authority graph missing or corrupted',
        };
      }
      return {
        adjudication_id: adj.id,
        submission_id: adj.submission_id,
        classification: 'AUTHORITY_CONFLICT',
        action_taken: 'NO_OP',
        error: 'Terminal authority conflict',
      };
    }

    // 2. Terminal Adjudications: ALREADY_RECONCILED
    if (
      adj.status === 'VERIFIED' ||
      adj.status === 'VERIFICATION_FAILED' ||
      adj.status === 'REJECTED' ||
      adj.status === 'SUPERSEDED' ||
      adj.status === 'RECOVERY_FENCED'
    ) {
      return {
        adjudication_id: adj.id,
        submission_id: adj.submission_id,
        classification: 'ALREADY_RECONCILED',
        action_taken: 'NO_OP',
      };
    }

    // 3. ADMITTED: PRE_VERIFICATION_NOT_STARTED
    if (adj.status === 'ADMITTED') {
      if (!adj.verification_execution_id && !adj.verification_started_at) {
        // Keep admitted, do NOT run command, expose Owner resume/cancel action
        return {
          adjudication_id: adj.id,
          submission_id: adj.submission_id,
          classification: 'PRE_VERIFICATION_NOT_STARTED',
          action_taken: 'KEPT_ADMITTED',
        };
      }
      // Partial claim without status transition to VERIFYING is an authority conflict
      this.fenceAdjudication(
        adj,
        'INTEGRITY_MISMATCH',
        'ADMITTED adjudication has partial execution claim markers without VERIFYING status',
        nowIso
      );
      return {
        adjudication_id: adj.id,
        submission_id: adj.submission_id,
        classification: 'AUTHORITY_CONFLICT',
        action_taken: 'FENCED_CONFLICT',
        error: 'Partial execution claim on ADMITTED row',
      };
    }

    // 4. VERIFYING: Check if terminal test and Git evidence are already durable and exact
    if (adj.status === 'VERIFYING') {
      const testRun = adj.test_run_id ? this.repo.getTestRun(adj.test_run_id) : null;
      const gitStatusEv = adj.git_status_evidence_id ? this.repo.getEvidence(adj.git_status_evidence_id) : null;
      const gitDiffEv = adj.git_diff_evidence_id ? this.repo.getEvidence(adj.git_diff_evidence_id) : null;

      const hasCompleteDurableEvidence = !!testRun && !!gitStatusEv && !!gitDiffEv;

      if (hasCompleteDurableEvidence) {
        // Complete only the missing atomic DB settlement after full hash/FK verification
        const settlementSuccess = this.reconcileMissingSettlement(
          adj,
          testRun,
          gitStatusEv.id,
          gitDiffEv.id,
          nowIso
        );
        return {
          adjudication_id: adj.id,
          submission_id: adj.submission_id,
          classification: 'VERIFICATION_RESULT_STATE_INCOMPLETE',
          action_taken: settlementSuccess ? 'SETTLED' : 'FENCED',
          task_transition: settlementSuccess ? (testRun.exit_code === 0 ? 'REVIEW_READY' : 'NEEDS_HUMAN') : undefined,
        };
      }

      // Process start/termination not durably proven: VERIFICATION_IN_FLIGHT_UNRESOLVED
      // CAS to RECOVERY_FENCED; task to fail-closed Owner state; never rerun
      this.fenceAdjudication(
        adj,
        'ORPHANED_VERIFICATION_INTERRUPTED',
        'Verification was in-flight when server crashed or restarted',
        nowIso,
        true // transition task to fail-closed state
      );

      return {
        adjudication_id: adj.id,
        submission_id: adj.submission_id,
        classification: 'VERIFICATION_IN_FLIGHT_UNRESOLVED',
        action_taken: 'FENCED',
        task_transition: 'NEEDS_HUMAN',
      };
    }

    return {
      adjudication_id: adj.id,
      submission_id: adj.submission_id,
      classification: 'AUTHORITY_CONFLICT',
      action_taken: 'NO_OP',
    };
  }

  private fenceAdjudication(
    adj: CoderSubmissionAdjudication,
    failureCode: string,
    reason: string,
    nowIso: string,
    transitionTask: boolean = false
  ): void {
    const failureJson = canonicalJsonStringify({ reason, recovered_at: nowIso });

    const tx = this.db.transaction(() => {
      const updateRes = this.db
        .prepare(`
          UPDATE coder_submission_adjudications
          SET status = 'RECOVERY_FENCED',
              recovery_fenced_at = ?,
              failure_code = ?,
              failure_json = ?,
              lifecycle_version = lifecycle_version + 1
          WHERE id = ? AND lifecycle_version = ?
        `)
        .run(nowIso, failureCode, failureJson, adj.id, adj.lifecycle_version);

      if (updateRes.changes !== 1) {
        throw new Error(`RECOVERY_CAS_FAILED: Adjudication ${adj.id} could not be fenced due to concurrent update.`);
      }

      const seq = this.repo.getNextAdjudicationEventSequence(adj.id);
      const eventPayload = canonicalJsonStringify({
        adjudication_id: adj.id,
        failure_code: failureCode,
        reason,
        recovered_at: nowIso,
      });

      const fenceEvent: CoderSubmissionAdjudicationEvent = {
        id: crypto.randomUUID(),
        adjudication_id: adj.id,
        sequence: seq,
        event_type: 'RECOVERY_FENCED',
        payload_json: eventPayload,
        payload_hash: computeSha256(eventPayload),
        created_at: nowIso,
      };
      this.repo.createCoderSubmissionAdjudicationEvent(fenceEvent);

      if (this.eventService) {
        this.eventService.record(
          adj.project_id,
          'CODER_SUBMISSION_RECOVERY_FENCED',
          `Adjudication ${adj.id} was fenced during crash recovery: ${reason}`,
          { adjudication_id: adj.id, failure_code: failureCode, reason }
        );
      }

      if (transitionTask) {
        const liveTask = this.repo.getTask(adj.task_id);
        if (liveTask && liveTask.state === 'VALIDATING') {
          // Transition to fail-closed Owner state NEEDS_HUMAN
          try {
            const trans = TaskStateMachine.transition(liveTask.state, 'TESTS_FAILED', {
              revisionCount: 999,
              maxRevisions: 1,
            });
            this.repo.updateTaskState(liveTask.id, trans.nextState);
          } catch {
            this.repo.updateTaskState(liveTask.id, 'NEEDS_HUMAN');
          }
        }
      }
    });

    tx();
  }

  private reconcileMissingSettlement(
    adj: CoderSubmissionAdjudication,
    testRun: { exit_code: number; id: string },
    gitStatusEvidenceId: string,
    gitDiffEvidenceId: string,
    nowIso: string
  ): boolean {
    try {
      const isSuccess = testRun.exit_code === 0;
      const targetStatus = isSuccess ? 'VERIFIED' : 'VERIFICATION_FAILED';
      const eventType = isSuccess ? 'VERIFICATION_SUCCEEDED' : 'VERIFICATION_FAILED';

      const tx = this.db.transaction(() => {
        const updateRes = this.db
          .prepare(`
            UPDATE coder_submission_adjudications
            SET status = ?,
                completed_at = ?,
                test_run_id = ?,
                git_status_evidence_id = ?,
                git_diff_evidence_id = ?,
                lifecycle_version = lifecycle_version + 1
            WHERE id = ? AND lifecycle_version = ?
          `)
          .run(
            targetStatus,
            nowIso,
            testRun.id,
            gitStatusEvidenceId,
            gitDiffEvidenceId,
            adj.id,
            adj.lifecycle_version
          );

        if (updateRes.changes !== 1) {
          throw new Error(`RECOVERY_CAS_FAILED: Adjudication ${adj.id} settlement CAS failed.`);
        }

        const seq = this.repo.getNextAdjudicationEventSequence(adj.id);
        const eventPayload = canonicalJsonStringify({
          adjudication_id: adj.id,
          test_run_id: testRun.id,
          exit_code: testRun.exit_code,
          settled_at: nowIso,
          recovered: true,
        });

        const settlementEvent: CoderSubmissionAdjudicationEvent = {
          id: crypto.randomUUID(),
          adjudication_id: adj.id,
          sequence: seq,
          event_type: eventType,
          payload_json: eventPayload,
          payload_hash: computeSha256(eventPayload),
          created_at: nowIso,
        };
        this.repo.createCoderSubmissionAdjudicationEvent(settlementEvent);

        if (isSuccess) {
          this.repo.createCoderSubmissionDisposition({
            id: crypto.randomUUID(),
            submission_id: adj.submission_id,
            disposition_event: 'SETTLED',
            disposition_reason: 'ACCEPTED_VERIFIED',
            actor_type: 'SYSTEM',
            actor_id: 'SYSTEM',
            disposition_metadata_json: null,
            created_at: nowIso,
          });
        }

        const liveTask = this.repo.getTask(adj.task_id);
        if (liveTask && liveTask.state === 'VALIDATING') {
          if (isSuccess) {
            const trans = TaskStateMachine.transition(liveTask.state, 'EVIDENCE_GATHERED');
            this.repo.updateTaskState(liveTask.id, trans.nextState);
          } else {
            const trans = TaskStateMachine.transition(liveTask.state, 'TESTS_FAILED', {
              revisionCount: liveTask.revision_count,
              maxRevisions: liveTask.max_revisions ?? 3,
            });
            this.repo.updateTaskState(liveTask.id, trans.nextState, null, trans.incrementRevision);
          }
        }
      });

      tx();
      return true;
    } catch {
      return false;
    }
  }
}
