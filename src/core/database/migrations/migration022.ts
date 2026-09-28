import Database from 'better-sqlite3';
import type { Migration } from './types';

export const migration022: Migration = {
    version: 22,
    name: '022_r5j_coder_submission_authority',
    up: (db: Database.Database) => {
      db.exec(`
        -- 1. MCP Submission Sessions Table
        CREATE TABLE mcp_submission_sessions (
          id TEXT PRIMARY KEY CHECK (
            length(id) = 36 AND
            id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          authorization_id TEXT NOT NULL REFERENCES execution_authorizations(id) ON DELETE RESTRICT,
          scope TEXT NOT NULL CHECK (scope = 'CODER_SUBMISSION'),
          issuer_identity TEXT NOT NULL CHECK (issuer_identity = 'OWNER_LOCAL_CLI'),
          token_hash TEXT NOT NULL CHECK (
            length(token_hash) = 64 AND
            token_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          authorization_fingerprint TEXT NOT NULL CHECK (
            length(authorization_fingerprint) = 64 AND
            authorization_fingerprint GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          issued_at TEXT NOT NULL CHECK (
            length(issued_at) = 24 AND
            issued_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
            unixepoch(issued_at) IS NOT NULL AND
            strftime('%Y-%m-%dT%H:%M:%fZ', issued_at) = issued_at
          ),
          expires_at TEXT NOT NULL CHECK (
            length(expires_at) = 24 AND
            expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
            unixepoch(expires_at) IS NOT NULL AND
            strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at AND
            (unixepoch(expires_at) - unixepoch(issued_at)) >= 300 AND
            (unixepoch(expires_at) - unixepoch(issued_at)) <= 86400
          ),
          revoked_at TEXT NULL,
          revocation_reason TEXT NULL,
          CHECK (
            (revoked_at IS NULL AND revocation_reason IS NULL) OR (
              revoked_at IS NOT NULL AND
              revocation_reason IS NOT NULL AND
              length(revoked_at) = 24 AND
              revoked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
              unixepoch(revoked_at) IS NOT NULL AND
              strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) = revoked_at AND
              unixepoch(revoked_at) >= unixepoch(issued_at) AND
              length(revocation_reason) >= 1 AND
              length(revocation_reason) <= 128
            )
          )
        );

        CREATE UNIQUE INDEX uq_mcp_submission_sessions_active_auth
        ON mcp_submission_sessions(authorization_id)
        WHERE revoked_at IS NULL;

        CREATE UNIQUE INDEX idx_mcp_submission_sessions_token_hash
        ON mcp_submission_sessions(token_hash);

        CREATE INDEX idx_mcp_submission_sessions_expires_at
        ON mcp_submission_sessions(expires_at);

        CREATE INDEX idx_mcp_submission_sessions_auth_id
        ON mcp_submission_sessions(authorization_id);

        CREATE TRIGGER trg_mcp_submission_sessions_no_delete
        BEFORE DELETE ON mcp_submission_sessions
        BEGIN
          SELECT RAISE(ABORT, 'MCP_SUBMISSION_SESSION_DELETE_FORBIDDEN');
        END;

        CREATE TRIGGER trg_mcp_submission_sessions_immutable_update
        BEFORE UPDATE ON mcp_submission_sessions
        BEGIN
          SELECT CASE
            WHEN OLD.revoked_at IS NOT NULL THEN
              RAISE(ABORT, 'MCP_SUBMISSION_SESSION_ALREADY_REVOKED')
            WHEN NEW.id != OLD.id
              OR NEW.authorization_id != OLD.authorization_id
              OR NEW.scope != OLD.scope
              OR NEW.issuer_identity != OLD.issuer_identity
              OR NEW.token_hash != OLD.token_hash
              OR NEW.authorization_fingerprint != OLD.authorization_fingerprint
              OR NEW.issued_at != OLD.issued_at
              OR NEW.expires_at != OLD.expires_at
              OR NEW.revoked_at IS NULL
              OR NEW.revocation_reason IS NULL THEN
              RAISE(ABORT, 'MCP_SUBMISSION_SESSION_MUTATION_FORBIDDEN')
          END;
        END;

        -- 2. Coder Submissions Quarantined Ledger Table
        CREATE TABLE coder_submissions (
          id TEXT PRIMARY KEY CHECK (
            length(id) = 36 AND
            id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          authorization_id TEXT NOT NULL REFERENCES execution_authorizations(id) ON DELETE RESTRICT,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
          task_ownership_epoch INTEGER NOT NULL CHECK (task_ownership_epoch >= 1),
          session_id TEXT NOT NULL REFERENCES mcp_submission_sessions(id) ON DELETE RESTRICT,
          lifecycle_version INTEGER NULL CHECK (lifecycle_version IS NULL OR lifecycle_version = 1),
          execution_id TEXT NULL,
          attempt_id TEXT NULL REFERENCES task_attempts(id) ON DELETE RESTRICT,
          assignment_id TEXT NULL REFERENCES agent_assignments(id) ON DELETE RESTRICT,
          selected_provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
          selected_account_id TEXT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
          selected_resource_id TEXT NOT NULL REFERENCES provider_resources(id) ON DELETE RESTRICT,
          manager_message_id TEXT NOT NULL,
          routing_decision_id TEXT NOT NULL,
          base_sha TEXT NOT NULL CHECK (
            length(base_sha) = 40 AND
            base_sha GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          authorized_head_sha TEXT NOT NULL CHECK (
            length(authorized_head_sha) = 40 AND
            authorized_head_sha GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          schema_version INTEGER NOT NULL CHECK (schema_version = 1),
          authorization_status TEXT NOT NULL CHECK (authorization_status = 'DISPATCHED'),
          dispatched_at TEXT NOT NULL CHECK (
            length(dispatched_at) = 24 AND
            dispatched_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
            unixepoch(dispatched_at) IS NOT NULL AND
            strftime('%Y-%m-%dT%H:%M:%fZ', dispatched_at) = dispatched_at
          ),
          authority_fingerprint TEXT NOT NULL CHECK (
            length(authority_fingerprint) = 64 AND
            authority_fingerprint GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          manager_payload_hash TEXT NOT NULL CHECK (
            length(manager_payload_hash) = 64 AND
            manager_payload_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          task_revision INTEGER NOT NULL CHECK (task_revision >= 0),
          claimed_status TEXT NOT NULL CHECK (claimed_status IN ('COMPLETED', 'IN_PROGRESS', 'BLOCKED', 'FAILED')),
          quarantine_status TEXT NOT NULL CHECK (quarantine_status = 'QUARANTINED'),
          summary TEXT NOT NULL CHECK (
            length(summary) >= 1 AND
            length(summary) <= 4096 AND
            length(trim(summary)) > 0
          ),
          changed_files_count INTEGER NOT NULL CHECK (changed_files_count >= 0 AND changed_files_count <= 1000),
          tests_claimed_count INTEGER NOT NULL CHECK (tests_claimed_count >= 0 AND tests_claimed_count <= 1000),
          blockers_count INTEGER NOT NULL CHECK (blockers_count >= 0 AND blockers_count <= 1000),
          review_requested INTEGER NOT NULL CHECK (review_requested IN (0, 1)),
          claim_content_hash TEXT NOT NULL CHECK (
            length(claim_content_hash) = 64 AND
            claim_content_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          canonical_envelope_hash TEXT NOT NULL CHECK (
            length(canonical_envelope_hash) = 64 AND
            canonical_envelope_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          claim_content_json TEXT NOT NULL CHECK (
            json_valid(claim_content_json) = 1 AND
            json_type(claim_content_json) = 'object'
          ),
          canonical_envelope_json TEXT NOT NULL CHECK (
            json_valid(canonical_envelope_json) = 1 AND
            json_type(canonical_envelope_json) = 'object'
          ),
          canonical_arguments_bytes INTEGER NOT NULL CHECK (
            canonical_arguments_bytes >= 1 AND
            canonical_arguments_bytes <= 65536
          ),
          submitted_at TEXT NOT NULL CHECK (
            length(submitted_at) = 24 AND
            submitted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
            unixepoch(submitted_at) IS NOT NULL AND
            strftime('%Y-%m-%dT%H:%M:%fZ', submitted_at) = submitted_at
          ),
          CHECK (
            (lifecycle_version IS NULL AND execution_id IS NULL AND attempt_id IS NULL AND assignment_id IS NULL AND selected_account_id IS NULL) OR (
              lifecycle_version = 1 AND
              execution_id IS NOT NULL AND
              attempt_id IS NOT NULL AND
              assignment_id IS NOT NULL AND
              selected_account_id IS NOT NULL
            )
          )
        );

        CREATE INDEX idx_coder_submissions_auth_id
        ON coder_submissions(authorization_id);

        CREATE INDEX idx_coder_submissions_task_id
        ON coder_submissions(task_id);

        CREATE INDEX idx_coder_submissions_session_id
        ON coder_submissions(session_id);

        CREATE INDEX idx_coder_submissions_content_hash
        ON coder_submissions(claim_content_hash);

        CREATE INDEX idx_coder_submissions_envelope_hash
        ON coder_submissions(canonical_envelope_hash);

        CREATE INDEX idx_coder_submissions_submitted_at
        ON coder_submissions(submitted_at);

        CREATE TRIGGER trg_coder_submissions_no_update
        BEFORE UPDATE ON coder_submissions
        BEGIN
          SELECT RAISE(ABORT, 'coder_submissions is strictly append-only: UPDATE is prohibited');
        END;

        CREATE TRIGGER trg_coder_submissions_no_delete
        BEFORE DELETE ON coder_submissions
        BEGIN
          SELECT RAISE(ABORT, 'coder_submissions is strictly append-only: DELETE is prohibited');
        END;

        -- 3. Coder Submission Dispositions Ledger Table
        CREATE TABLE coder_submission_dispositions (
          id TEXT PRIMARY KEY CHECK (
            length(id) = 36 AND
            id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          submission_id TEXT NOT NULL REFERENCES coder_submissions(id) ON DELETE RESTRICT,
          disposition_event TEXT NOT NULL,
          disposition_reason TEXT NOT NULL,
          actor_type TEXT NOT NULL CHECK (actor_type IN ('SYSTEM', 'MCP_CLIENT', 'OPERATOR')),
          actor_id TEXT NOT NULL CHECK (length(actor_id) >= 1 AND length(actor_id) <= 128),
          disposition_metadata_json TEXT NULL CHECK (
            disposition_metadata_json IS NULL OR (
              json_valid(disposition_metadata_json) = 1 AND
              json_type(disposition_metadata_json) = 'object'
            )
          ),
          created_at TEXT NOT NULL CHECK (
            length(created_at) = 24 AND
            created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
            unixepoch(created_at) IS NOT NULL AND
            strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
          ),
          CHECK (
            (disposition_event = 'SUBMITTED' AND disposition_reason = 'INITIAL_SUBMISSION') OR
            (disposition_event = 'REJECTED' AND disposition_reason IN ('INTEGRITY_MISMATCH', 'FENCED_PRECONDITION', 'COLLISION_CONFLICT')) OR
            (disposition_event = 'SETTLED' AND disposition_reason IN ('ACCEPTED_VERIFIED', 'SUPERSEDED_SUBMISSION', 'MANUAL_OVERRIDE'))
          )
        );

        CREATE INDEX idx_coder_submission_dispositions_submission
        ON coder_submission_dispositions(submission_id);

        CREATE INDEX idx_coder_submission_dispositions_event
        ON coder_submission_dispositions(disposition_event);

        CREATE INDEX idx_coder_submission_dispositions_created_at
        ON coder_submission_dispositions(created_at);

        CREATE TRIGGER trg_coder_submission_dispositions_no_update
        BEFORE UPDATE ON coder_submission_dispositions
        BEGIN
          SELECT RAISE(ABORT, 'coder_submission_dispositions is strictly append-only: UPDATE is prohibited');
        END;

        CREATE TRIGGER trg_coder_submission_dispositions_no_delete
        BEFORE DELETE ON coder_submission_dispositions
        BEGIN
          SELECT RAISE(ABORT, 'coder_submission_dispositions is strictly append-only: DELETE is prohibited');
        END;
      `);
    },
  };
