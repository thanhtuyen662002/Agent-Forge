import Database from 'better-sqlite3';
import type { Migration } from './types';

export const migration023: Migration = {
    version: 23,
    name: '023_r5j_quarantined_submission_adjudication_and_verification_admission',
    up: (db: Database.Database) => {
      db.exec(`
        -- 1. Coder Submission Adjudications Table
        CREATE TABLE coder_submission_adjudications (
          id TEXT PRIMARY KEY CHECK (
            length(id) = 36 AND
            id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          request_id TEXT NOT NULL UNIQUE CHECK (
            length(request_id) = 36 AND
            request_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          submission_id TEXT NOT NULL REFERENCES coder_submissions(id) ON DELETE RESTRICT,
          authorization_id TEXT NOT NULL REFERENCES execution_authorizations(id) ON DELETE RESTRICT,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
          attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE RESTRICT,
          assignment_id TEXT NOT NULL REFERENCES agent_assignments(id) ON DELETE RESTRICT,
          task_ownership_epoch INTEGER NOT NULL CHECK (task_ownership_epoch > 0),
          action TEXT NOT NULL CHECK (action IN ('ADMIT_VERIFICATION', 'REJECT', 'SUPERSEDE')),
          status TEXT NOT NULL CHECK (status IN ('ADMITTED', 'VERIFYING', 'VERIFIED', 'VERIFICATION_FAILED', 'RECOVERY_FENCED', 'REJECTED', 'SUPERSEDED')),
          lifecycle_version INTEGER NOT NULL CHECK (lifecycle_version >= 1),
          authority_snapshot_json TEXT NOT NULL CHECK (
            json_valid(authority_snapshot_json) = 1 AND
            json_type(authority_snapshot_json) = 'object'
          ),
          authority_snapshot_hash TEXT NOT NULL CHECK (
            length(authority_snapshot_hash) = 64 AND
            authority_snapshot_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          verification_commands_json TEXT NULL CHECK (
            verification_commands_json IS NULL OR (
              json_valid(verification_commands_json) = 1 AND
              json_type(verification_commands_json) = 'object'
            )
          ),
          verification_commands_hash TEXT NULL CHECK (
            verification_commands_hash IS NULL OR (
              length(verification_commands_hash) = 64 AND
              verification_commands_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
            )
          ),
          workspace_snapshot_before_json TEXT NULL CHECK (
            workspace_snapshot_before_json IS NULL OR (
              json_valid(workspace_snapshot_before_json) = 1 AND
              json_type(workspace_snapshot_before_json) = 'object'
            )
          ),
          workspace_snapshot_before_hash TEXT NULL CHECK (
            workspace_snapshot_before_hash IS NULL OR (
              length(workspace_snapshot_before_hash) = 64 AND
              workspace_snapshot_before_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
            )
          ),
          verification_result_envelope_json TEXT NULL CHECK (
            verification_result_envelope_json IS NULL OR (
              json_valid(verification_result_envelope_json) = 1 AND
              json_type(verification_result_envelope_json) = 'object'
            )
          ),
          verification_result_envelope_hash TEXT NULL CHECK (
            verification_result_envelope_hash IS NULL OR (
              length(verification_result_envelope_hash) = 64 AND
              verification_result_envelope_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
            )
          ),
          verification_execution_id TEXT NULL,
          protocol_message_id TEXT NULL REFERENCES protocol_messages(id) ON DELETE SET NULL,
          test_run_id TEXT NULL REFERENCES test_runs(id) ON DELETE SET NULL,
          git_status_evidence_id TEXT NULL REFERENCES evidence(id) ON DELETE SET NULL,
          git_diff_evidence_id TEXT NULL REFERENCES evidence(id) ON DELETE SET NULL,
          failure_code TEXT NULL,
          failure_json TEXT NULL CHECK (
            failure_json IS NULL OR (
              json_valid(failure_json) = 1 AND
              json_type(failure_json) = 'object'
            )
          ),
          created_at TEXT NOT NULL CHECK (
            length(created_at) = 24 AND
            created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
            unixepoch(created_at) IS NOT NULL AND
            strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
          ),
          verification_started_at TEXT NULL CHECK (
            verification_started_at IS NULL OR (
              length(verification_started_at) = 24 AND
              verification_started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
              unixepoch(verification_started_at) IS NOT NULL AND
              strftime('%Y-%m-%dT%H:%M:%fZ', verification_started_at) = verification_started_at AND
              verification_started_at >= created_at
            )
          ),
          completed_at TEXT NULL CHECK (
            completed_at IS NULL OR (
              length(completed_at) = 24 AND
              completed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
              unixepoch(completed_at) IS NOT NULL AND
              strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at AND
              completed_at >= created_at
            )
          ),
          recovery_fenced_at TEXT NULL CHECK (
            recovery_fenced_at IS NULL OR (
              length(recovery_fenced_at) = 24 AND
              recovery_fenced_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
              unixepoch(recovery_fenced_at) IS NOT NULL AND
              strftime('%Y-%m-%dT%H:%M:%fZ', recovery_fenced_at) = recovery_fenced_at AND
              recovery_fenced_at >= created_at
            )
          ),
          resolution_action TEXT NULL CHECK (resolution_action IS NULL OR resolution_action IN ('ACKNOWLEDGE', 'CANCEL')),
          resolution_timestamp TEXT NULL CHECK (
            resolution_timestamp IS NULL OR (
              length(resolution_timestamp) = 24 AND
              resolution_timestamp GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
              unixepoch(resolution_timestamp) IS NOT NULL AND
              strftime('%Y-%m-%dT%H:%M:%fZ', resolution_timestamp) = resolution_timestamp AND
              resolution_timestamp >= created_at
            )
          ),
          resolution_evidence_json TEXT NULL CHECK (
            resolution_evidence_json IS NULL OR (
              json_valid(resolution_evidence_json) = 1 AND
              json_type(resolution_evidence_json) = 'object'
            )
          ),
          resolution_evidence_hash TEXT NULL CHECK (
            resolution_evidence_hash IS NULL OR (
              length(resolution_evidence_hash) = 64 AND
              resolution_evidence_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
            )
          ),
          resolver_id TEXT NULL,
          artifact_manifest_json TEXT NULL CHECK (
            artifact_manifest_json IS NULL OR (
              json_valid(artifact_manifest_json) = 1 AND
              json_type(artifact_manifest_json) = 'object'
            )
          ),
          artifact_manifest_hash TEXT NULL CHECK (
            artifact_manifest_hash IS NULL OR (
              length(artifact_manifest_hash) = 64 AND
              artifact_manifest_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
            )
          ),
          workspace_lease_id TEXT NULL REFERENCES coder_submission_workspace_leases(id) ON DELETE SET NULL,
          CHECK (
            (action = 'ADMIT_VERIFICATION' AND verification_commands_json IS NOT NULL AND verification_commands_hash IS NOT NULL) OR
            (action IN ('REJECT', 'SUPERSEDE') AND verification_commands_json IS NULL AND verification_commands_hash IS NULL)
          ),
          CHECK (
            (status = 'ADMITTED' AND verification_started_at IS NULL AND completed_at IS NULL AND recovery_fenced_at IS NULL AND verification_execution_id IS NULL) OR
            (status = 'VERIFYING' AND verification_started_at IS NOT NULL AND completed_at IS NULL AND recovery_fenced_at IS NULL AND verification_execution_id IS NOT NULL AND workspace_snapshot_before_json IS NOT NULL AND workspace_snapshot_before_hash IS NOT NULL) OR
            (status = 'VERIFIED' AND verification_started_at IS NOT NULL AND completed_at IS NOT NULL AND recovery_fenced_at IS NULL AND test_run_id IS NOT NULL AND git_status_evidence_id IS NOT NULL AND git_diff_evidence_id IS NOT NULL AND verification_result_envelope_json IS NOT NULL AND verification_result_envelope_hash IS NOT NULL AND artifact_manifest_json IS NOT NULL AND artifact_manifest_hash IS NOT NULL) OR
            (status = 'VERIFICATION_FAILED' AND completed_at IS NOT NULL AND failure_code IS NOT NULL) OR
            (status = 'RECOVERY_FENCED' AND recovery_fenced_at IS NOT NULL AND failure_code IS NOT NULL) OR
            (status IN ('REJECTED', 'SUPERSEDED') AND completed_at IS NOT NULL AND recovery_fenced_at IS NULL)
          )
        );

        CREATE INDEX idx_coder_submission_adjudications_submission
        ON coder_submission_adjudications(submission_id);

        CREATE INDEX idx_coder_submission_adjudications_task
        ON coder_submission_adjudications(task_id);

        CREATE INDEX idx_coder_submission_adjudications_auth
        ON coder_submission_adjudications(authorization_id);

        CREATE INDEX idx_coder_submission_adjudications_status
        ON coder_submission_adjudications(status);

        CREATE UNIQUE INDEX idx_coder_submission_adjudications_active
        ON coder_submission_adjudications(submission_id)
        WHERE status IN ('ADMITTED', 'VERIFYING', 'RECOVERY_FENCED');

        CREATE TRIGGER trg_coder_submission_adjudications_no_delete
        BEFORE DELETE ON coder_submission_adjudications
        BEGIN
          SELECT RAISE(ABORT, 'coder_submission_adjudications is strictly append-only: DELETE is prohibited');
        END;

        CREATE TRIGGER trg_coder_submission_adjudications_lifecycle_cas
        BEFORE UPDATE ON coder_submission_adjudications
        BEGIN
          SELECT CASE
            WHEN NEW.lifecycle_version != OLD.lifecycle_version + 1
            THEN RAISE(ABORT, 'Adjudication lifecycle_version must increment by exactly 1')
            WHEN NOT (
              (OLD.status = 'ADMITTED' AND NEW.status IN ('VERIFYING', 'RECOVERY_FENCED')) OR
              (OLD.status = 'VERIFYING' AND NEW.status IN ('VERIFIED', 'VERIFICATION_FAILED', 'RECOVERY_FENCED')) OR
              (OLD.status = 'VERIFIED' AND NEW.status = 'RECOVERY_FENCED') OR
              (OLD.status = 'VERIFICATION_FAILED' AND NEW.status = 'RECOVERY_FENCED') OR
              (OLD.status = 'RECOVERY_FENCED' AND NEW.status IN ('VERIFICATION_FAILED', 'RECOVERY_FENCED'))
            )
            THEN RAISE(ABORT, 'Invalid adjudication lifecycle status transition')
          END;
        END;

        CREATE TRIGGER trg_coder_submission_adjudications_immutable_fields
        BEFORE UPDATE ON coder_submission_adjudications
        BEGIN
          SELECT CASE
            WHEN OLD.id != NEW.id OR
                 OLD.request_id != NEW.request_id OR
                 OLD.submission_id != NEW.submission_id OR
                 OLD.authorization_id != NEW.authorization_id OR
                 OLD.project_id != NEW.project_id OR
                 OLD.task_id != NEW.task_id OR
                 OLD.attempt_id != NEW.attempt_id OR
                 OLD.assignment_id != NEW.assignment_id OR
                 OLD.task_ownership_epoch != NEW.task_ownership_epoch OR
                 OLD.action != NEW.action OR
                 OLD.authority_snapshot_json != NEW.authority_snapshot_json OR
                 OLD.authority_snapshot_hash != NEW.authority_snapshot_hash OR
                 OLD.created_at != NEW.created_at
            THEN RAISE(ABORT, 'coder_submission_adjudications immutable decision and binding fields cannot be updated')
            WHEN (OLD.verification_execution_id IS NOT NULL AND (NEW.verification_execution_id IS NULL OR NEW.verification_execution_id != OLD.verification_execution_id)) OR
                 (OLD.verification_started_at IS NOT NULL AND (NEW.verification_started_at IS NULL OR NEW.verification_started_at != OLD.verification_started_at)) OR
                 (OLD.recovery_fenced_at IS NOT NULL AND (NEW.recovery_fenced_at IS NULL OR NEW.recovery_fenced_at != OLD.recovery_fenced_at))
            THEN RAISE(ABORT, 'coder_submission_adjudications execution and fence markers cannot be altered or cleared once set')
            WHEN (OLD.resolution_action IS NOT NULL AND (NEW.resolution_action IS NULL OR NEW.resolution_action != OLD.resolution_action)) OR
                 (OLD.resolution_timestamp IS NOT NULL AND (NEW.resolution_timestamp IS NULL OR NEW.resolution_timestamp != OLD.resolution_timestamp))
            THEN RAISE(ABORT, 'coder_submission_adjudications resolution records cannot be altered or cleared once set')
            WHEN (OLD.artifact_manifest_hash IS NOT NULL AND (NEW.artifact_manifest_hash IS NULL OR NEW.artifact_manifest_hash != OLD.artifact_manifest_hash)) OR
                 (OLD.artifact_manifest_json IS NOT NULL AND (NEW.artifact_manifest_json IS NULL OR NEW.artifact_manifest_json != OLD.artifact_manifest_json))
            THEN RAISE(ABORT, 'coder_submission_adjudications artifact manifest cannot be altered or cleared once set')
          END;
        END;

        -- 2. Coder Submission Workspace Leases Table
        CREATE TABLE coder_submission_workspace_leases (
          id TEXT PRIMARY KEY CHECK (
            length(id) = 36 AND
            id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          adjudication_id TEXT NOT NULL REFERENCES coder_submission_adjudications(id) ON DELETE RESTRICT,
          worktree_identity_hash TEXT NOT NULL CHECK (
            length(worktree_identity_hash) = 64 AND
            worktree_identity_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          admitted_workspace_fingerprint_hash TEXT NOT NULL CHECK (
            length(admitted_workspace_fingerprint_hash) = 64 AND
            admitted_workspace_fingerprint_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          pre_execution_fingerprint_hash TEXT NULL CHECK (
            pre_execution_fingerprint_hash IS NULL OR (
              length(pre_execution_fingerprint_hash) = 64 AND
              pre_execution_fingerprint_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
            )
          ),
          claim_nonce TEXT NOT NULL CHECK (length(claim_nonce) >= 16),
          execution_id TEXT NOT NULL CHECK (length(execution_id) >= 1),
          lease_owner_identity TEXT NOT NULL CHECK (length(lease_owner_identity) >= 1),
          assignment_id TEXT NOT NULL REFERENCES agent_assignments(id) ON DELETE RESTRICT,
          authorization_id TEXT NOT NULL REFERENCES execution_authorizations(id) ON DELETE RESTRICT,
          acquired_at TEXT NOT NULL CHECK (
            length(acquired_at) = 24 AND
            acquired_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
            unixepoch(acquired_at) IS NOT NULL AND
            strftime('%Y-%m-%dT%H:%M:%fZ', acquired_at) = acquired_at
          ),
          released_at TEXT NULL CHECK (
            released_at IS NULL OR (
              length(released_at) = 24 AND
              released_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
              unixepoch(released_at) IS NOT NULL AND
              strftime('%Y-%m-%dT%H:%M:%fZ', released_at) = released_at AND
              released_at >= acquired_at
            )
          ),
          lifecycle_version INTEGER NOT NULL CHECK (lifecycle_version >= 1),
          state TEXT NOT NULL CHECK (state IN ('ACQUIRED', 'VERIFYING', 'RELEASED', 'FENCED')),
          failure_code TEXT NULL,
          failure_evidence_hash TEXT NULL CHECK (
            failure_evidence_hash IS NULL OR (
              length(failure_evidence_hash) = 64 AND
              failure_evidence_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
            )
          ),
          CHECK (
            (state = 'ACQUIRED' AND pre_execution_fingerprint_hash IS NULL AND released_at IS NULL) OR
            (state = 'VERIFYING' AND pre_execution_fingerprint_hash IS NOT NULL AND released_at IS NULL) OR
            (state = 'RELEASED' AND released_at IS NOT NULL) OR
            (state = 'FENCED' AND failure_code IS NOT NULL)
          )
        );

        CREATE UNIQUE INDEX idx_coder_submission_workspace_leases_active
        ON coder_submission_workspace_leases(worktree_identity_hash)
        WHERE state IN ('ACQUIRED', 'VERIFYING');

        CREATE INDEX idx_coder_submission_workspace_leases_adj
        ON coder_submission_workspace_leases(adjudication_id);

        CREATE INDEX idx_coder_submission_workspace_leases_state
        ON coder_submission_workspace_leases(state);

        CREATE TRIGGER trg_coder_submission_workspace_leases_no_delete
        BEFORE DELETE ON coder_submission_workspace_leases
        BEGIN
          SELECT RAISE(ABORT, 'coder_submission_workspace_leases is strictly append-only: DELETE is prohibited');
        END;

        CREATE TRIGGER trg_coder_submission_workspace_leases_immutable
        BEFORE UPDATE ON coder_submission_workspace_leases
        BEGIN
          SELECT CASE
            WHEN OLD.id != NEW.id OR
                 OLD.adjudication_id != NEW.adjudication_id OR
                 OLD.worktree_identity_hash != NEW.worktree_identity_hash OR
                 OLD.admitted_workspace_fingerprint_hash != NEW.admitted_workspace_fingerprint_hash OR
                 OLD.claim_nonce != NEW.claim_nonce OR
                 OLD.execution_id != NEW.execution_id OR
                 OLD.lease_owner_identity != NEW.lease_owner_identity OR
                 OLD.assignment_id != NEW.assignment_id OR
                 OLD.authorization_id != NEW.authorization_id OR
                 OLD.acquired_at != NEW.acquired_at
            THEN RAISE(ABORT, 'coder_submission_workspace_leases immutable claim and binding fields cannot be updated')
            WHEN NEW.lifecycle_version != OLD.lifecycle_version + 1
            THEN RAISE(ABORT, 'coder_submission_workspace_leases lifecycle_version must increment by exactly 1')
          END;
        END;

        -- 3. Coder Submission Adjudication Events Table (Append-Only)
        CREATE TABLE coder_submission_adjudication_events (
          id TEXT PRIMARY KEY CHECK (
            length(id) = 36 AND
            id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          adjudication_id TEXT NOT NULL REFERENCES coder_submission_adjudications(id) ON DELETE RESTRICT,
          sequence INTEGER NOT NULL CHECK (sequence >= 1),
          event_type TEXT NOT NULL CHECK (event_type IN ('ADMITTED', 'VERIFICATION_CLAIMED', 'VERIFICATION_SUCCEEDED', 'VERIFICATION_FAILED', 'RECOVERY_FENCED', 'REJECTED', 'SUPERSEDED')),
          payload_json TEXT NOT NULL CHECK (
            json_valid(payload_json) = 1 AND
            json_type(payload_json) = 'object'
          ),
          payload_hash TEXT NOT NULL CHECK (
            length(payload_hash) = 64 AND
            payload_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          created_at TEXT NOT NULL CHECK (
            length(created_at) = 24 AND
            created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
            unixepoch(created_at) IS NOT NULL AND
            strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
          ),
          UNIQUE (adjudication_id, sequence)
        );

        CREATE INDEX idx_coder_submission_adjudication_events_adj
        ON coder_submission_adjudication_events(adjudication_id);

        CREATE INDEX idx_coder_submission_adjudication_events_type
        ON coder_submission_adjudication_events(event_type);

        CREATE TRIGGER trg_coder_submission_adjudication_events_no_update
        BEFORE UPDATE ON coder_submission_adjudication_events
        BEGIN
          SELECT RAISE(ABORT, 'coder_submission_adjudication_events is strictly append-only: UPDATE is prohibited');
        END;

        CREATE TRIGGER trg_coder_submission_adjudication_events_no_delete
        BEFORE DELETE ON coder_submission_adjudication_events
        BEGIN
          SELECT RAISE(ABORT, 'coder_submission_adjudication_events is strictly append-only: DELETE is prohibited');
        END;
      `);
    },
  };
