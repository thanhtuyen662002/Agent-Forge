import Database from 'better-sqlite3';
import type { Migration } from './types';

export const migration020: Migration = {
    version: 20,
    name: '020_r5i_crash_recovery_and_execution_lifecycle_authority',
    up: (db: Database.Database) => {
      db.exec(`
        -- 1. Extend execution_authorizations with selected_account_id and lifecycle protocol fields
        ALTER TABLE execution_authorizations
        ADD COLUMN selected_account_id TEXT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT;

        ALTER TABLE execution_authorizations
        ADD COLUMN lifecycle_version INTEGER NULL CHECK (
          lifecycle_version IS NULL OR (
            lifecycle_version = 1 AND
            assignment_id IS NOT NULL AND
            selected_account_id IS NOT NULL AND
            task_ownership_epoch IS NOT NULL AND
            task_ownership_epoch > 0
          )
        );

        CREATE TRIGGER IF NOT EXISTS trg_exec_auth_lifecycle_default
        AFTER INSERT ON execution_authorizations
        FOR EACH ROW
        WHEN NEW.lifecycle_version IS NULL
          AND NEW.assignment_id IS NOT NULL
          AND NEW.selected_account_id IS NOT NULL
          AND NEW.task_ownership_epoch IS NOT NULL
          AND NEW.task_ownership_epoch > 0
        BEGIN
          UPDATE execution_authorizations
          SET lifecycle_version = 1
          WHERE id = NEW.id;
        END;

        ALTER TABLE execution_authorizations
        ADD COLUMN adapter_error_json TEXT NULL;

        ALTER TABLE execution_authorizations
        ADD COLUMN settlement_status TEXT NULL CHECK (settlement_status IS NULL OR settlement_status IN ('COMPLETED', 'FAILED', 'CANCELLED'));

        ALTER TABLE execution_authorizations
        ADD COLUMN termination_reason TEXT NULL CHECK (termination_reason IS NULL OR termination_reason IN (
          'EXECUTION_TIMEOUT',
          'EXECUTION_CANCELLED',
          'HEARTBEAT_TIMEOUT',
          'MANUAL_INTERVENTION'
        ));

        ALTER TABLE execution_authorizations
        ADD COLUMN termination_proof_source TEXT NULL CHECK (termination_proof_source IS NULL OR termination_proof_source IN (
          'LOCAL_PROCESS_EXIT',
          'PROVIDER_FINAL_ACK',
          'TIMEOUT_UNACKNOWLEDGED',
          'CANCEL_UNACKNOWLEDGED',
          'DISCONNECT_UNKNOWN'
        ));

        ALTER TABLE execution_authorizations
        ADD COLUMN termination_evidence_json TEXT NULL;

        ALTER TABLE execution_authorizations
        ADD COLUMN terminated_at TEXT NULL;

        -- Convert unprovable legacy migration-19 termination rows to clean unresolved state
        UPDATE execution_authorizations
        SET termination_status = 'UNRESOLVED',
            termination_confirmed_at = NULL,
            terminated_at = NULL,
            termination_proof_source = 'DISCONNECT_UNKNOWN'
        WHERE termination_status = 'CONFIRMED_TERMINATED'
          AND (
            termination_proof_source IS NULL OR
            termination_proof_source NOT IN ('LOCAL_PROCESS_EXIT', 'PROVIDER_FINAL_ACK')
          );

        UPDATE execution_authorizations
        SET termination_confirmed_at = NULL,
            terminated_at = NULL
        WHERE termination_status = 'UNRESOLVED'
          AND (termination_confirmed_at IS NOT NULL OR terminated_at IS NOT NULL);

        ALTER TABLE execution_authorizations
        ADD COLUMN termination_evidence_hash TEXT NULL CHECK (
          (
            termination_status IS NULL AND
            termination_source IS NULL AND
            termination_reason IS NULL AND
            termination_proof_source IS NULL AND
            termination_confirmed_at IS NULL AND
            terminated_at IS NULL AND
            termination_evidence_json IS NULL AND
            termination_evidence_hash IS NULL
          ) OR (
            termination_status = 'UNRESOLVED' AND
            termination_confirmed_at IS NULL AND
            terminated_at IS NULL AND
            (termination_proof_source IS NULL OR termination_proof_source IN ('TIMEOUT_UNACKNOWLEDGED', 'CANCEL_UNACKNOWLEDGED', 'DISCONNECT_UNKNOWN')) AND
            (
              (termination_evidence_json IS NULL AND termination_evidence_hash IS NULL) OR
              (termination_evidence_json IS NOT NULL AND termination_evidence_hash IS NOT NULL AND length(termination_evidence_hash) = 64 AND termination_evidence_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')
            )
          ) OR (
            termination_status = 'CONFIRMED_TERMINATED' AND
            termination_source IS NOT NULL AND
            termination_reason IS NOT NULL AND
            termination_proof_source IN ('LOCAL_PROCESS_EXIT', 'PROVIDER_FINAL_ACK') AND
            termination_confirmed_at IS NOT NULL AND
            terminated_at IS NOT NULL AND
            termination_evidence_json IS NOT NULL AND
            termination_evidence_hash IS NOT NULL AND
            length(termination_evidence_hash) = 64 AND
            termination_evidence_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          )
        );

        ALTER TABLE execution_authorizations
        ADD COLUMN settled_at TEXT NULL;

        ALTER TABLE execution_authorizations
        ADD COLUMN settlement_evidence_json TEXT NULL;

        ALTER TABLE execution_authorizations
        ADD COLUMN settlement_evidence_hash TEXT NULL CHECK (
          (settlement_status IS NULL AND settled_at IS NULL AND settlement_evidence_json IS NULL AND settlement_evidence_hash IS NULL) OR (
            settlement_status IS NOT NULL AND
            settled_at IS NOT NULL AND
            settlement_evidence_json IS NOT NULL AND
            settlement_evidence_hash IS NOT NULL AND
            length(settlement_evidence_hash) = 64 AND
            settlement_evidence_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          )
        );

        CREATE INDEX IF NOT EXISTS idx_exec_auth_lifecycle
        ON execution_authorizations(lifecycle_version);

        CREATE INDEX IF NOT EXISTS idx_exec_auth_settlement_status
        ON execution_authorizations(settlement_status);

        -- 2. Durable per-authorization recovery state ledger
        CREATE TABLE IF NOT EXISTS execution_recovery_states (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL UNIQUE REFERENCES execution_authorizations(id) ON DELETE RESTRICT,
          transfer_id TEXT NOT NULL REFERENCES handoff_transfers(id) ON DELETE RESTRICT,
          execution_id TEXT NULL,
          lifecycle_version INTEGER NULL CHECK (lifecycle_version IS NULL OR lifecycle_version = 1),
          recovery_classification TEXT NOT NULL CHECK (recovery_classification IN (
            'PRE_ADAPTER_NOT_STARTED',
            'ADAPTER_IN_FLIGHT_UNRESOLVED',
            'ADAPTER_TERMINATED_AFTER_TIMEOUT',
            'ADAPTER_FINISHED_RESULT_MISSING',
            'RESULT_PERSISTED_STATE_INCOMPLETE',
            'ALREADY_RECONCILED',
            'LEGACY_UNCLASSIFIABLE',
            'AUTHORITY_CONFLICT'
          )),
          disposition TEXT NOT NULL CHECK (disposition IN (
            'TERMINALIZED_SAFE_EXPIRED',
            'UNRESOLVED_FENCED',
            'TERMINALIZED_CONFIRMED_TIMEOUT',
            'TERMINALIZED_CONFIRMED_CANCELLED',
            'RESULT_MISSING_FENCED',
            'TERMINAL_STATE_RECONCILED',
            'NO_OP_ALREADY_RECONCILED',
            'LEGACY_UNRESOLVED_FENCED',
            'REJECTED_INTEGRITY_CONFLICT'
          )),
          canonical_evidence_json TEXT NOT NULL,
          evidence_hash TEXT NOT NULL CHECK (
            length(evidence_hash) = 64 AND
            evidence_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          recovery_version INTEGER NOT NULL DEFAULT 1 CHECK (recovery_version >= 1),
          mutated_terminal_state INTEGER NOT NULL DEFAULT 0 CHECK (mutated_terminal_state IN (0, 1)),
          mutated_resources INTEGER NOT NULL DEFAULT 0 CHECK (mutated_resources IN (0, 1)),
          first_detected_at TEXT NOT NULL,
          last_scanned_at TEXT NOT NULL,
          resolved_at TEXT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_exec_recovery_transfer
        ON execution_recovery_states(transfer_id);

        CREATE INDEX IF NOT EXISTS idx_exec_recovery_classification
        ON execution_recovery_states(recovery_classification);

        CREATE INDEX IF NOT EXISTS idx_exec_recovery_disposition
        ON execution_recovery_states(disposition);

        CREATE INDEX IF NOT EXISTS idx_exec_recovery_evidence_hash
        ON execution_recovery_states(evidence_hash);
      `);
    },
  };
