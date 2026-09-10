import crypto from 'crypto';
import fs from 'fs';
import Database from 'better-sqlite3';
import { Repository, CoderSubmission } from '../database/repositories';
import { TestRun } from '../types/domain';
import { EventService } from './EventService';
import {
  CoderSubmissionAdjudication,
  CoderSubmissionAdjudicationEvent,
  RecoveryClassification,
  AdjudicationRecoveryScanItemResult,
  AdjudicationRecoveryScanReport,
  CanonicalVerificationResultEnvelope,
  CANONICAL_VERIFICATION_RESULT_ENVELOPE_KEYS,
  AUTHORITY_SNAPSHOT_KEYS,
  ArtifactManifest,
} from '../types/adjudication';
import { canonicalJsonStringify, computeSha256 } from '../context/ContextIntegrity';
import { TaskStateMachine } from '../state/taskStateMachine';
import {
  CoderSubmissionAdjudicationService,
  deriveDeterministicAdjudicationEventId,
  deriveDeterministicGenericAdjudicationEventId,
  deriveDeterministicDispositionId,
  evaluateCanonicalSettlementDecision,
  validateAndParseCanonicalResultEnvelope,
  CanonicalSettlementDecision,
} from './CoderSubmissionAdjudicationService';
import { verifyEvidenceIntegrity, parseAndVerifyArtifactManifest } from './ArtifactStore';

export class CoderSubmissionAdjudicationRecoveryScanner {
  private adjudicationService: CoderSubmissionAdjudicationService;

  constructor(
    private db: Database.Database,
    private repo: Repository,
    private eventService?: EventService,
    adjudicationService?: CoderSubmissionAdjudicationService
  ) {
    this.adjudicationService = adjudicationService ?? new CoderSubmissionAdjudicationService(this.repo, this.db);
  }

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

  public reconcileSingleAdjudication(
    adj: CoderSubmissionAdjudication,
    nowIso: string = new Date().toISOString()
  ): AdjudicationRecoveryScanItemResult {
    // 1. Verify Durable Authority Graph & Snapshot
    const sub = this.repo.getCoderSubmissionById(adj.submission_id);
    const auth = this.repo.getExecutionAuthorization(adj.authorization_id);
    const task = this.repo.getTask(adj.task_id);
    const project = this.repo.getProject(adj.project_id);
    const attempt = this.repo.getTaskAttempt(adj.attempt_id);
    const assignment = this.repo.getAgentAssignment(adj.assignment_id);

    let authoritySnapshotValid = false;
    if (adj.authority_snapshot_json && adj.authority_snapshot_hash === computeSha256(adj.authority_snapshot_json)) {
      try {
        const parsedSnap = JSON.parse(adj.authority_snapshot_json);
        if (typeof parsedSnap === 'object' && parsedSnap !== null && !Array.isArray(parsedSnap)) {
          const actualKeys = Object.keys(parsedSnap).sort();
          const expectedKeys = [...AUTHORITY_SNAPSHOT_KEYS].sort();
          if (
            actualKeys.length === expectedKeys.length &&
            actualKeys.every((k, i) => k === expectedKeys[i])
          ) {
            authoritySnapshotValid = true;
          }
        }
      } catch (snapErr: unknown) {
        authoritySnapshotValid = false;
      }
    }

    const isAuthorityIntact =
      !!sub &&
      !!auth &&
      !!task &&
      !!project &&
      !!attempt &&
      !!assignment &&
      authoritySnapshotValid &&
      (!adj.verification_commands_json ||
        adj.verification_commands_hash === computeSha256(adj.verification_commands_json));

    if (!isAuthorityIntact) {
      if (adj.status !== 'RECOVERY_FENCED' && adj.status !== 'REJECTED' && adj.status !== 'SUPERSEDED') {
        this.fenceAdjudication(
          adj,
          'INTEGRITY_MISMATCH',
          'Durable authority graph missing or authority snapshot hash/schema corrupted',
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

    // 2. Terminal Adjudications: validate before ALREADY_RECONCILED
    if (
      adj.status === 'VERIFIED' ||
      adj.status === 'VERIFICATION_FAILED' ||
      adj.status === 'REJECTED' ||
      adj.status === 'SUPERSEDED' ||
      adj.status === 'RECOVERY_FENCED'
    ) {
      let contradiction: string | null = null;

      // Validate shared authority verifier
      const authIntegrity = this.adjudicationService.validateSubmissionAndAuthorityIntegrity(sub);
      if (!authIntegrity.valid) {
        contradiction = `Authority verifier failed on terminal row: ${authIntegrity.fenced_reasons.join('; ')}`;
      }

      // Check authority snapshot is not empty
      if (!contradiction) {
        if (!adj.authority_snapshot_json || adj.authority_snapshot_json.trim() === '{}') {
          contradiction = 'Terminal row authority snapshot is missing or empty';
        }
      }

      // Check result envelope if present or required
      let parsedEnvelope: CanonicalVerificationResultEnvelope | null = null;
      if (!contradiction && (adj.verification_result_envelope_json || adj.status === 'VERIFIED' || adj.status === 'VERIFICATION_FAILED')) {
        if (!adj.verification_result_envelope_json || !adj.verification_result_envelope_hash) {
          contradiction = `${adj.status} adjudication missing verification result envelope or hash`;
        } else {
          const parseRes = validateAndParseCanonicalResultEnvelope(
            adj.verification_result_envelope_json,
            adj.verification_result_envelope_hash
          );
          if (!parseRes.valid || !parseRes.envelope) {
            contradiction = parseRes.error || 'Verification result envelope validation failed';
          } else {
            parsedEnvelope = parseRes.envelope;
          }
        }
      }

      // Check manifest if present or required
      let parsedManifest: ArtifactManifest | null = null;
      if (!contradiction && (adj.artifact_manifest_json || adj.status === 'VERIFIED')) {
        if (!adj.artifact_manifest_json || !adj.artifact_manifest_hash) {
          contradiction = `${adj.status} adjudication missing artifact manifest or hash`;
        } else {
          try {
            parsedManifest = parseAndVerifyArtifactManifest(
              adj.artifact_manifest_json,
              adj.artifact_manifest_hash
            );
          } catch (mErr: unknown) {
            contradiction = `Artifact manifest validation failed: ${mErr instanceof Error ? mErr.message : String(mErr)}`;
          }
        }
      }

      // Evaluate canonical settlement decision if envelope is present or required
      if (!contradiction && parsedEnvelope) {
        const tr = adj.test_run_id ? this.repo.getTestRun(adj.test_run_id) : null;
        const dec = evaluateCanonicalSettlementDecision({
          envelope: parsedEnvelope,
          rawEnvelopeJson: adj.verification_result_envelope_json ?? undefined,
          expectedEnvelopeHash: adj.verification_result_envelope_hash ?? undefined,
          adjudication: adj,
          testRun: tr,
          manifest: parsedManifest,
          rawManifestJson: adj.artifact_manifest_json ?? undefined,
          expectedManifestHash: adj.artifact_manifest_hash ?? undefined,
          gitStatusEvidenceId: adj.git_status_evidence_id,
          gitDiffEvidenceId: adj.git_diff_evidence_id,
          testResultEvidenceId: tr?.evidence_id ?? null,
          repo: this.repo,
          artifactStore: this.adjudicationService.getArtifactStore(),
        });

        if (!dec.valid) {
          contradiction = dec.contradictionReason || dec.failureDetail || 'Canonical settlement evaluation failed';
        } else if (adj.status === 'VERIFIED') {
          if (dec.targetStatus !== 'VERIFIED' || !dec.isSuccess) {
            contradiction = dec.contradictionReason || 'Canonical settlement decision contradicts VERIFIED status';
          }
        } else if (adj.status === 'VERIFICATION_FAILED') {
          if (dec.targetStatus !== 'VERIFICATION_FAILED' || dec.isSuccess) {
            contradiction = dec.contradictionReason || 'Canonical settlement decision contradicts VERIFICATION_FAILED status';
          }
        } else if (adj.status === 'RECOVERY_FENCED') {
          if (dec.targetStatus !== 'RECOVERY_FENCED') {
            contradiction = dec.contradictionReason || 'Canonical settlement decision contradicts RECOVERY_FENCED status';
          }
        }
      }

      if (!contradiction && adj.status === 'VERIFIED') {
        if (!adj.test_run_id) {
          contradiction = 'VERIFIED adjudication missing test_run_id';
        } else {
          const tr = this.repo.getTestRun(adj.test_run_id);
          if (!tr || tr.exit_code !== 0) {
            contradiction = 'VERIFIED adjudication test run missing or non-zero exit code';
          } else if (tr.evidence_id) {
            const trEv = this.repo.getEvidence(tr.evidence_id);
            if (!trEv || trEv.project_id !== adj.project_id || trEv.task_id !== adj.task_id) {
              contradiction = 'VERIFIED test run evidence missing or project/task mismatch';
            }
          }
        }

        if (!contradiction && task && (task.state === 'VALIDATING' || task.state === 'CODING')) {
          contradiction = `VERIFIED adjudication has contradictory live task state: ${task.state}`;
        }

        if (!contradiction) {
          const disps = this.repo.getCoderSubmissionDispositions(adj.submission_id);
          const terminalDisps = disps.filter((d) => d.disposition_event === 'SETTLED' || d.disposition_event === 'REJECTED');
          if (terminalDisps.length !== 1 || terminalDisps[0].disposition_event !== 'SETTLED' || terminalDisps[0].disposition_reason !== 'ACCEPTED_VERIFIED') {
            contradiction = 'VERIFIED adjudication missing exact SETTLED terminal disposition or has ambiguous dispositions';
          }
        }

        if (!contradiction) {
          const events = this.repo.getCoderSubmissionAdjudicationEvents(adj.id);
          const hasSucceededEvent = events.some((e) => e.event_type === 'VERIFICATION_SUCCEEDED');
          if (!hasSucceededEvent) {
            contradiction = 'VERIFIED adjudication missing VERIFICATION_SUCCEEDED settlement event';
          }
        }

        if (!contradiction && adj.workspace_lease_id) {
          const l = this.repo.getWorkspaceLease(adj.workspace_lease_id);
          if (l && l.state !== 'RELEASED') {
            contradiction = `VERIFIED adjudication has unreleased workspace lease: ${l.state}`;
          }
        }
      }

      if (!contradiction && adj.status === 'VERIFICATION_FAILED') {
        const disps = this.repo.getCoderSubmissionDispositions(adj.submission_id);
        const settledDisp = disps.find((d) => d.disposition_event === 'SETTLED');
        if (settledDisp) {
          contradiction = 'VERIFICATION_FAILED adjudication has contradictory SETTLED disposition';
        }

        if (!contradiction) {
          const events = this.repo.getCoderSubmissionAdjudicationEvents(adj.id);
          const hasFailedEvent = events.some((e) => e.event_type === 'VERIFICATION_FAILED');
          if (!hasFailedEvent) {
            contradiction = 'VERIFICATION_FAILED adjudication missing VERIFICATION_FAILED settlement event';
          }
        }

        if (!contradiction && adj.workspace_lease_id) {
          const l = this.repo.getWorkspaceLease(adj.workspace_lease_id);
          if (l && l.state !== 'RELEASED') {
            contradiction = `VERIFICATION_FAILED adjudication has unreleased workspace lease: ${l.state}`;
          }
        }
      }

      if (!contradiction && adj.status === 'RECOVERY_FENCED') {
        if (!adj.failure_code || !adj.recovery_fenced_at) {
          contradiction = 'RECOVERY_FENCED adjudication missing failure_code or recovery_fenced_at';
        }
        if (!contradiction) {
          const disps = this.repo.getCoderSubmissionDispositions(adj.submission_id);
          const settledDisp = disps.find((d) => d.disposition_event === 'SETTLED');
          if (settledDisp) {
            contradiction = 'RECOVERY_FENCED adjudication has contradictory SETTLED disposition';
          }
        }
        if (!contradiction && adj.workspace_lease_id) {
          const l = this.repo.getWorkspaceLease(adj.workspace_lease_id);
          if (l && l.state !== 'FENCED' && l.state !== 'RELEASED') {
            contradiction = `RECOVERY_FENCED adjudication has un-fenced workspace lease: ${l.state}`;
          }
        }
      }

      if (!contradiction && (adj.status === 'REJECTED' || adj.status === 'SUPERSEDED')) {
        const disps = this.repo.getCoderSubmissionDispositions(adj.submission_id);
        const terminalDisps = disps.filter((d) => d.disposition_event === adj.status || d.disposition_event === 'SETTLED' || d.disposition_event === 'REJECTED');
        if (terminalDisps.length === 0) {
          contradiction = `${adj.status} adjudication missing terminal disposition`;
        }
      }

      if (contradiction) {
        return {
          adjudication_id: adj.id,
          submission_id: adj.submission_id,
          classification: 'AUTHORITY_CONFLICT',
          action_taken: 'NO_OP',
          error: contradiction,
        };
      }

      return {
        adjudication_id: adj.id,
        submission_id: adj.submission_id,
        classification: 'ALREADY_RECONCILED',
        action_taken: 'NO_OP',
      };
    }

    // 3. ADMITTED: PRE_VERIFICATION_NOT_STARTED
    if (adj.status === 'ADMITTED') {
      const authIntegrity = this.adjudicationService.validateSubmissionAndAuthorityIntegrity(sub);
      if (!authIntegrity.valid) {
        this.fenceAdjudication(
          adj,
          'INTEGRITY_MISMATCH',
          `Authority verifier failed on ADMITTED row: ${authIntegrity.fenced_reasons.join('; ')}`,
          nowIso
        );
        return {
          adjudication_id: adj.id,
          submission_id: adj.submission_id,
          classification: 'AUTHORITY_CONFLICT',
          action_taken: 'FENCED_CONFLICT',
          error: 'Authority integrity failed on ADMITTED row',
        };
      }

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

    // 4. VERIFYING: Section 10 exact conditions for DB-only settlement
    if (adj.status === 'VERIFYING') {
      let settlementError: string | null = null;

      // Condition 1: Shared authority verifier
      const authIntegrity = this.adjudicationService.validateSubmissionAndAuthorityIntegrity(sub);
      if (!authIntegrity.valid) {
        settlementError = `Authority verifier failed: ${authIntegrity.fenced_reasons.join('; ')}`;
      }

      // Condition 2: Status is VERIFYING, lifecycle version 2, execution ID present
      if (!settlementError) {
        if (adj.lifecycle_version !== 2 || !adj.verification_execution_id || !adj.verification_started_at) {
          settlementError = 'Adjudication lifecycle version or execution claim invalid';
        }
      }

      // Condition 3: Canonical verification-result envelope exists, is canonical, exact keys, hash recomputes
      let parsedEnvelope: CanonicalVerificationResultEnvelope | null = null;
      if (!settlementError) {
        if (!adj.verification_result_envelope_json || !adj.verification_result_envelope_hash) {
          settlementError = 'Canonical verification-result envelope missing';
        } else {
          const parseRes = validateAndParseCanonicalResultEnvelope(
            adj.verification_result_envelope_json,
            adj.verification_result_envelope_hash
          );
          if (!parseRes.valid || !parseRes.envelope) {
            settlementError = parseRes.error || 'Verification result envelope validation failed';
          } else if (
            parseRes.envelope.adjudication_id !== adj.id ||
            parseRes.envelope.verification_execution_id !== adj.verification_execution_id
          ) {
            settlementError = 'Envelope identity bindings mismatch';
          } else {
            parsedEnvelope = parseRes.envelope;
          }
        }
      }

      // Condition 4: Process termination is durably proven
      if (!settlementError && parsedEnvelope) {
        if (parsedEnvelope.termination_classification !== 'TERMINATION_PROVEN') {
          settlementError = `Termination classification not durably proven: ${parsedEnvelope.termination_classification}`;
        }
      }

      // Condition 5: Command snapshot hash matches adjudication and result envelope, commands non-empty
      if (!settlementError && parsedEnvelope) {
        if (
          !adj.verification_commands_json ||
          adj.verification_commands_json === '{}' ||
          parsedEnvelope.command_snapshot_hash !== adj.verification_commands_hash ||
          adj.verification_commands_hash !== computeSha256(adj.verification_commands_json)
        ) {
          settlementError = 'Verification command snapshot hash mismatch or empty command snapshot';
        }
      }

      // Condition 6: Test run exists, task ID, command identity, timestamps, exit classification, evidence ID match
      let testRun: TestRun | null = null;
      if (!settlementError && parsedEnvelope && parsedEnvelope.test_run_id) {
        const tr = this.repo.getTestRun(parsedEnvelope.test_run_id);
        if (!tr) {
          settlementError = `Test run ${parsedEnvelope.test_run_id} not found`;
        } else if (tr.task_id !== adj.task_id) {
          settlementError = `Test run belongs to task ${tr.task_id}, expected ${adj.task_id}`;
        } else if (typeof tr.exit_code !== 'number') {
          settlementError = 'Test run exit code is invalid';
        } else if (parsedEnvelope.exit_classification === 'EXIT_ZERO' && tr.exit_code !== 0) {
          settlementError = `Test run exit code ${tr.exit_code} contradicts EXIT_ZERO`;
        } else if (parsedEnvelope.test_result_evidence_id && tr.evidence_id !== parsedEnvelope.test_result_evidence_id) {
          settlementError = 'Test run evidence_id does not match envelope test_result_evidence_id';
        } else {
          testRun = tr;
        }
      }

      // Condition 7: Test-result evidence exists with exact bindings and integrity
      if (!settlementError && parsedEnvelope && parsedEnvelope.test_result_evidence_id) {
        const testEv = this.repo.getEvidence(parsedEnvelope.test_result_evidence_id);
        if (!testEv) {
          settlementError = `Test result evidence ${parsedEnvelope.test_result_evidence_id} not found`;
        } else if (
          testEv.project_id !== adj.project_id ||
          testEv.task_id !== adj.task_id ||
          testEv.attempt_id !== adj.attempt_id ||
          testEv.evidence_type !== 'TEST_RESULT' ||
          testEv.hash !== parsedEnvelope.test_result_evidence_hash
        ) {
          settlementError = 'Test result evidence authority bindings or hash mismatch';
        } else {
          const integ = verifyEvidenceIntegrity(testEv, this.adjudicationService.getArtifactStore());
          if (!integ.valid) {
            settlementError = `Test result evidence integrity failed: ${integ.reason}`;
          }
        }
      }

      // Condition 8: Git status and Git diff evidence exist with exact bindings and disk/inline integrity
      let gitStatusEvId: string | null = null;
      let gitDiffEvId: string | null = null;
      if (!settlementError && parsedEnvelope) {
        if (parsedEnvelope.git_status_evidence_id) {
          const gse = this.repo.getEvidence(parsedEnvelope.git_status_evidence_id);
          if (!gse) {
            settlementError = `Git status evidence ${parsedEnvelope.git_status_evidence_id} not found`;
          } else if (
            gse.project_id !== adj.project_id ||
            gse.task_id !== adj.task_id ||
            gse.attempt_id !== adj.attempt_id ||
            gse.evidence_type !== 'GIT_STATUS' ||
            gse.hash !== parsedEnvelope.git_status_evidence_hash
          ) {
            settlementError = 'Git status evidence authority bindings or hash mismatch';
          } else {
            const integ = verifyEvidenceIntegrity(gse, this.adjudicationService.getArtifactStore());
            if (!integ.valid) {
              settlementError = `Git status evidence integrity failed: ${integ.reason}`;
            } else {
              gitStatusEvId = gse.id;
            }
          }
        }
        if (!settlementError && parsedEnvelope.git_diff_evidence_id) {
          const gde = this.repo.getEvidence(parsedEnvelope.git_diff_evidence_id);
          if (!gde) {
            settlementError = `Git diff evidence ${parsedEnvelope.git_diff_evidence_id} not found`;
          } else if (
            gde.project_id !== adj.project_id ||
            gde.task_id !== adj.task_id ||
            gde.attempt_id !== adj.attempt_id ||
            gde.evidence_type !== 'GIT_DIFF' ||
            gde.hash !== parsedEnvelope.git_diff_evidence_hash
          ) {
            settlementError = 'Git diff evidence authority bindings or hash mismatch';
          } else {
            const integ = verifyEvidenceIntegrity(gde, this.adjudicationService.getArtifactStore());
            if (!integ.valid) {
              settlementError = `Git diff evidence integrity failed: ${integ.reason}`;
            } else {
              gitDiffEvId = gde.id;
            }
          }
        }
      }

      // Condition 9: Before/after workspace fingerprints exist and validate drift classification
      if (!settlementError && parsedEnvelope) {
        if (!adj.workspace_snapshot_before_json || !adj.workspace_snapshot_before_hash) {
          settlementError = 'Workspace snapshot before missing from adjudication';
        } else if (adj.workspace_snapshot_before_hash !== parsedEnvelope.workspace_snapshot_before_hash) {
          settlementError = 'Workspace snapshot before hash mismatch with envelope';
        } else {
          try {
            const beforeFp = JSON.parse(adj.workspace_snapshot_before_json);
            if (
              typeof beforeFp !== 'object' ||
              beforeFp === null ||
              !('head_sha' in beforeFp) ||
              !('status_lines' in beforeFp) ||
              'quarantine_status' in beforeFp // must not be an authority snapshot!
            ) {
              settlementError = 'Workspace snapshot before is not a valid workspace fingerprint';
            }
          } catch (fpErr: unknown) {
            settlementError = 'Workspace snapshot before is malformed JSON';
          }
        }
      }

      // Condition 10: No contradictory event, disposition, or task state exists
      if (!settlementError) {
        const liveTask = this.repo.getTask(adj.task_id);
        if (!liveTask || (liveTask.state !== 'VALIDATING' && liveTask.state !== 'CODING')) {
          settlementError = `Contradictory task state: ${liveTask?.state}`;
        }
      }

      // Condition 11: Artifact manifest exists, hash recomputes, matches envelope
      let artifactManifestJson: string | null = adj.artifact_manifest_json ?? null;
      let artifactManifestHash: string | null = adj.artifact_manifest_hash ?? null;
      if (!settlementError && parsedEnvelope) {
        if (artifactManifestJson && artifactManifestHash) {
          if (computeSha256(artifactManifestJson) !== artifactManifestHash) {
            settlementError = 'Artifact manifest hash mismatch';
          } else if (artifactManifestHash !== parsedEnvelope.artifact_manifest_hash) {
            settlementError = 'Artifact manifest hash mismatch with result envelope';
          }
        } else if (parsedEnvelope.artifact_manifest_hash) {
          artifactManifestHash = parsedEnvelope.artifact_manifest_hash;
        }
      }

      if (!settlementError && testRun && parsedEnvelope) {
        if (!artifactManifestJson || !artifactManifestHash) {
          this.fenceAdjudication(
            adj,
            'INTEGRITY_MISMATCH',
            'VERIFYING adjudication missing artifact manifest for settlement',
            nowIso,
            true
          );
          return {
            adjudication_id: adj.id,
            submission_id: adj.submission_id,
            classification: 'AUTHORITY_CONFLICT',
            action_taken: 'FENCED_CONFLICT',
            error: 'Missing artifact manifest',
          };
        }

        let parsedManifest: ArtifactManifest;
        try {
          parsedManifest = parseAndVerifyArtifactManifest(artifactManifestJson, artifactManifestHash);
        } catch (manErr: unknown) {
          this.fenceAdjudication(
            adj,
            'INTEGRITY_MISMATCH',
            `Manifest validation failed: ${manErr instanceof Error ? manErr.message : String(manErr)}`,
            nowIso,
            true
          );
          return {
            adjudication_id: adj.id,
            submission_id: adj.submission_id,
            classification: 'AUTHORITY_CONFLICT',
            action_taken: 'FENCED_CONFLICT',
            error: 'Manifest validation failed',
          };
        }

        const decision = evaluateCanonicalSettlementDecision({
          envelope: parsedEnvelope,
          rawEnvelopeJson: adj.verification_result_envelope_json ?? canonicalJsonStringify(parsedEnvelope),
          expectedEnvelopeHash: adj.verification_result_envelope_hash ?? computeSha256(canonicalJsonStringify(parsedEnvelope)),
          adjudication: adj,
          testRun,
          manifest: parsedManifest,
          rawManifestJson: artifactManifestJson,
          expectedManifestHash: artifactManifestHash,
          gitStatusEvidenceId: gitStatusEvId,
          gitDiffEvidenceId: gitDiffEvId,
          testResultEvidenceId: testRun.evidence_id,
          repo: this.repo,
          artifactStore: this.adjudicationService.getArtifactStore(),
        });

        if (!decision.valid) {
          this.fenceAdjudication(
            adj,
            decision.failureCode || 'INTEGRITY_MISMATCH',
            decision.failureDetail || decision.contradictionReason || 'Canonical settlement evaluation failed',
            nowIso,
            true
          );
          return {
            adjudication_id: adj.id,
            submission_id: adj.submission_id,
            classification: 'AUTHORITY_CONFLICT',
            action_taken: 'FENCED_CONFLICT',
            error: decision.contradictionReason || decision.failureDetail || 'Canonical settlement evaluation failed',
          };
        }

        const settlementSuccess = this.reconcileMissingSettlement(
          adj,
          testRun,
          gitStatusEvId,
          gitDiffEvId,
          parsedEnvelope,
          artifactManifestJson,
          artifactManifestHash,
          nowIso,
          decision
        );
        if (settlementSuccess) {
          return {
            adjudication_id: adj.id,
            submission_id: adj.submission_id,
            classification: 'VERIFICATION_RESULT_STATE_INCOMPLETE',
            action_taken: 'SETTLED',
            task_transition: decision.taskTransition,
          };
        } else {
          return {
            adjudication_id: adj.id,
            submission_id: adj.submission_id,
            classification: 'AUTHORITY_CONFLICT',
            action_taken: 'NO_OP',
            error: 'Settlement reconciliation CAS or transition failed',
          };
        }
      }

      if (
        settlementError &&
        (adj.test_run_id ||
          adj.git_status_evidence_id ||
          adj.git_diff_evidence_id ||
          adj.verification_result_envelope_json)
      ) {
        this.fenceAdjudication(
          adj,
          'INTEGRITY_MISMATCH',
          `VERIFYING adjudication has incomplete or invalid recovery evidence: ${settlementError}`,
          nowIso,
          true
        );
        return {
          adjudication_id: adj.id,
          submission_id: adj.submission_id,
          classification: 'AUTHORITY_CONFLICT',
          action_taken: 'FENCED_CONFLICT',
          error: settlementError,
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

  public fenceAdjudication(
    adj: CoderSubmissionAdjudication,
    failureCode: string,
    reason: string = 'Verification recovery fence engaged',
    nowIso: string = new Date().toISOString(),
    transitionTask: boolean = false
  ): void {
    const effectiveNow = nowIso || new Date().toISOString();
    const effectiveReason = reason || 'Verification recovery fence engaged';
    const failureJson = canonicalJsonStringify({ reason: effectiveReason, recovered_at: effectiveNow });
    const nextVersion = adj.lifecycle_version + 1;

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
        .run(effectiveNow, failureCode, failureJson, adj.id, adj.lifecycle_version);

      if (updateRes.changes !== 1) {
        throw new Error(`RECOVERY_CAS_FAILED: Adjudication ${adj.id} could not be fenced due to concurrent update.`);
      }

      const seq = this.repo.getNextAdjudicationEventSequence(adj.id);
      const eventPayload = canonicalJsonStringify({
        adjudication_id: adj.id,
        failure_code: failureCode,
        reason: effectiveReason,
        recovered_at: effectiveNow,
      });
      const payloadHash = computeSha256(eventPayload);

      const fenceEvent: CoderSubmissionAdjudicationEvent = {
        id: deriveDeterministicAdjudicationEventId(
          adj.id,
          nextVersion,
          'RECOVERY_FENCED',
          payloadHash
        ),
        adjudication_id: adj.id,
        sequence: seq,
        event_type: 'RECOVERY_FENCED',
        payload_json: eventPayload,
        payload_hash: payloadHash,
        created_at: effectiveNow,
      };
      this.repo.createCoderSubmissionAdjudicationEvent(fenceEvent);

      if (this.eventService) {
        const payloadObj = {
          adjudication_id: adj.id,
          failure_code: failureCode,
          reason: effectiveReason,
        };
        const genericEventPayload = canonicalJsonStringify(payloadObj);
        const genericPayloadHash = computeSha256(genericEventPayload);
        const genericEventId = deriveDeterministicGenericAdjudicationEventId(
          adj.id,
          nextVersion,
          'CODER_SUBMISSION_RECOVERY_FENCED',
          genericPayloadHash
        );
        this.repo.createDeterministicGenericEvent({
          id: genericEventId,
          project_id: adj.project_id,
          task_id: adj.task_id,
          agent_id: null,
          type: 'CODER_SUBMISSION_RECOVERY_FENCED',
          summary: `Adjudication ${adj.id} was fenced during crash recovery: ${effectiveReason}`,
          structured_payload: payloadObj,
          timestamp: effectiveNow,
        });
      }

      if (transitionTask) {
        const liveTask = this.repo.getTask(adj.task_id);
        if (liveTask && liveTask.state === 'VALIDATING') {
          const trans = TaskStateMachine.transition(liveTask.state, 'TESTS_FAILED', {
            revisionCount: liveTask.revision_count,
            maxRevisions: liveTask.max_revisions ?? 3,
          });
          this.repo.updateTaskState(liveTask.id, trans.nextState, null, trans.incrementRevision);
        }
      }

      const l = adj.workspace_lease_id
        ? this.repo.getWorkspaceLease(adj.workspace_lease_id)
        : this.repo.getWorkspaceLeaseByAdjudication(adj.id);
      if (l && l.released_at === null) {
        const leaseUpdated = this.repo.updateWorkspaceLease(l.id, l.lifecycle_version, {
          state: 'FENCED',
          failure_code: failureCode,
          failure_evidence_hash: adj.artifact_manifest_hash ?? null,
          released_at: effectiveNow,
        });
        if (!leaseUpdated) {
          throw new Error(`RECOVERY_CAS_FAILED: Workspace lease fence CAS failed for lease ${l.id}`);
        }
      }
    });

    tx();
  }

  public reconcileMissingSettlement(
    adj: CoderSubmissionAdjudication,
    testRun: TestRun,
    gitStatusEvidenceId: string | null,
    gitDiffEvidenceId: string | null,
    envelope: CanonicalVerificationResultEnvelope,
    artifactManifestJson: string | null,
    artifactManifestHash: string | null,
    nowIso: string,
    precomputedDecision?: CanonicalSettlementDecision
  ): boolean {
    if (!artifactManifestJson || !artifactManifestHash) {
      return false;
    }
    let parsedManifest: ArtifactManifest;
    try {
      parsedManifest = parseAndVerifyArtifactManifest(artifactManifestJson, artifactManifestHash);
    } catch (manErr: unknown) {
      return false;
    }

    const decision =
      precomputedDecision ??
      evaluateCanonicalSettlementDecision({
        envelope,
        rawEnvelopeJson: canonicalJsonStringify(envelope),
        expectedEnvelopeHash: computeSha256(canonicalJsonStringify(envelope)),
        adjudication: adj,
        testRun,
        manifest: parsedManifest,
        rawManifestJson: artifactManifestJson,
        expectedManifestHash: artifactManifestHash,
        gitStatusEvidenceId,
        gitDiffEvidenceId,
        testResultEvidenceId: testRun.evidence_id,
        repo: this.repo,
        artifactStore: this.adjudicationService.getArtifactStore(),
      });

    if (!decision.valid) {
      return false;
    }

    const targetStatus = decision.targetStatus;
    const eventType = decision.eventType;
    const isSuccess = decision.isSuccess;
    const nextVersion = adj.lifecycle_version + 1;

    const envelopeJson = canonicalJsonStringify(envelope);
    const envelopeHash = computeSha256(envelopeJson);

    try {
      const tx = this.db.transaction(() => {
        const updateRes = this.db
          .prepare(`
            UPDATE coder_submission_adjudications
            SET status = ?,
                completed_at = ?,
                test_run_id = ?,
                git_status_evidence_id = ?,
                git_diff_evidence_id = ?,
                verification_result_envelope_json = ?,
                verification_result_envelope_hash = ?,
                artifact_manifest_json = ?,
                artifact_manifest_hash = ?,
                lifecycle_version = lifecycle_version + 1
            WHERE id = ? AND lifecycle_version = ?
          `)
          .run(
            targetStatus,
            nowIso,
            testRun.id,
            gitStatusEvidenceId,
            gitDiffEvidenceId,
            envelopeJson,
            envelopeHash,
            artifactManifestJson,
            artifactManifestHash,
            adj.id,
            adj.lifecycle_version
          );

        if (updateRes.changes !== 1) {
          throw new Error(`RECOVERY_CAS_FAILED: Adjudication ${adj.id} settlement CAS failed.`);
        }

        if (adj.workspace_lease_id) {
          const l = this.repo.getWorkspaceLease(adj.workspace_lease_id);
          if (l && l.released_at === null) {
            const leaseUpdated = this.repo.updateWorkspaceLease(l.id, l.lifecycle_version, {
              state: 'RELEASED',
              released_at: nowIso,
            });
            if (!leaseUpdated) {
              throw new Error(`RECOVERY_CAS_FAILED: Workspace lease release CAS failed for lease ${l.id}`);
            }
          }
        }

        const seq = this.repo.getNextAdjudicationEventSequence(adj.id);
        const eventPayload = canonicalJsonStringify({
          adjudication_id: adj.id,
          test_run_id: testRun.id,
          exit_code: testRun.exit_code,
          settled_at: nowIso,
          recovered: true,
        });
        const payloadHash = computeSha256(eventPayload);

        const settlementEvent: CoderSubmissionAdjudicationEvent = {
          id: deriveDeterministicAdjudicationEventId(
            adj.id,
            nextVersion,
            eventType,
            payloadHash
          ),
          adjudication_id: adj.id,
          sequence: seq,
          event_type: eventType,
          payload_json: eventPayload,
          payload_hash: payloadHash,
          created_at: nowIso,
        };
        this.repo.createCoderSubmissionAdjudicationEvent(settlementEvent);

        const existingDisps = this.repo.getCoderSubmissionDispositions(adj.submission_id);
        const hasTerminalDisp = existingDisps.some((d) => d.disposition_event === 'SETTLED' || d.disposition_event === 'REJECTED');
        if (!hasTerminalDisp && isSuccess) {
          this.repo.createCoderSubmissionDisposition({
            id: deriveDeterministicDispositionId(adj.submission_id, adj.id, nextVersion),
            submission_id: adj.submission_id,
            disposition_event: decision.dispositionEvent,
            disposition_reason: decision.dispositionReason,
            actor_type: 'SYSTEM',
            actor_id: 'RECOVERY_SCANNER',
            disposition_metadata_json: null,
            created_at: nowIso,
          });
        }

        const liveTask = this.repo.getTask(adj.task_id);
        if (liveTask) {
          if (liveTask.state === 'CODING') {
            const trans1 = TaskStateMachine.transition(liveTask.state, 'SUBMIT_REPORT');
            this.repo.updateTaskState(liveTask.id, trans1.nextState);
            liveTask.state = trans1.nextState;
          }
          if (liveTask.state === 'VALIDATING') {
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
        }
      });

      tx();
      return true;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('RECOVERY_CAS_FAILED')) {
        return false;
      }
      throw err;
    }
  }
}
