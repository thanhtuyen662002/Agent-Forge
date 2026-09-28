import Database from 'better-sqlite3';
import type { Migration } from './types';

export const migration017: Migration = {
    version: 17,
    name: '017_r5i_handoff_authority_corrective_hardening',
    foreignKeyMode: 'DISABLED_FOR_REBUILD',
    up: (db: Database.Database) => {
      // 1. Rebuild handoff_transfers:
      //    - Make handoff_context_id NULLABLE REFERENCES handoff_contexts(id) ON DELETE RESTRICT
      //    - Remove legacy successor_agent_id (successor logical authority is role/agent profiles)
      //    - Update active transfer uniqueness index: active status OR relinquished_at IS NOT NULL
      db.exec(`
        CREATE TABLE handoff_transfers_new (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          source_attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
          successor_attempt_id TEXT NULL REFERENCES task_attempts(id) ON DELETE SET NULL,
          source_assignment_id TEXT NOT NULL REFERENCES agent_assignments(id) ON DELETE CASCADE,
          successor_assignment_id TEXT NULL REFERENCES agent_assignments(id) ON DELETE SET NULL,
          successor_role_profile_id TEXT NULL REFERENCES role_profiles(id) ON DELETE SET NULL,
          successor_agent_profile_id TEXT NULL REFERENCES agent_profiles(id) ON DELETE SET NULL,
          handoff_context_id TEXT NULL REFERENCES handoff_contexts(id) ON DELETE RESTRICT,
          checkpoint_id TEXT NULL REFERENCES checkpoints(id) ON DELETE SET NULL,
          source_authorization_id TEXT NULL REFERENCES execution_authorizations(id) ON DELETE SET NULL,
          successor_authorization_id TEXT NULL REFERENCES execution_authorizations(id) ON DELETE SET NULL,
          reason TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN (
            'REQUESTED', 'FROZEN', 'QUIESCING', 'RELINQUISHED', 'SUCCESSOR_PREPARED',
            'ROUTED', 'AUTHORIZED', 'ACCEPTED', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'
          )) DEFAULT 'REQUESTED',
          source_ownership_epoch INTEGER NOT NULL DEFAULT 1,
          successor_ownership_epoch INTEGER NULL,
          version INTEGER NOT NULL DEFAULT 1,
          frozen_at TEXT NULL,
          quiescing_at TEXT NULL,
          relinquished_at TEXT NULL,
          accepted_at TEXT NULL,
          completed_at TEXT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO handoff_transfers_new (
          id, request_id, task_id, source_attempt_id, successor_attempt_id,
          source_assignment_id, successor_assignment_id, successor_role_profile_id,
          successor_agent_profile_id, handoff_context_id, checkpoint_id,
          source_authorization_id, successor_authorization_id, reason, status,
          source_ownership_epoch, successor_ownership_epoch, version,
          frozen_at, quiescing_at, relinquished_at, accepted_at, completed_at,
          created_at, updated_at
        )
        SELECT
          id, request_id, task_id, source_attempt_id, successor_attempt_id,
          source_assignment_id, successor_assignment_id, successor_role_profile_id,
          successor_agent_profile_id, handoff_context_id, checkpoint_id,
          source_authorization_id, successor_authorization_id, reason, status,
          source_ownership_epoch, successor_ownership_epoch, version,
          frozen_at, quiescing_at, relinquished_at, accepted_at, completed_at,
          created_at, updated_at
        FROM handoff_transfers;

        DROP TABLE handoff_transfers;

        ALTER TABLE handoff_transfers_new RENAME TO handoff_transfers;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_active_handoff_transfer_source
          ON handoff_transfers(source_attempt_id)
          WHERE status IN ('REQUESTED', 'FROZEN', 'QUIESCING', 'RELINQUISHED', 'SUCCESSOR_PREPARED', 'ROUTED', 'AUTHORIZED', 'ACCEPTED')
             OR relinquished_at IS NOT NULL;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_transfers_successor_attempt
          ON handoff_transfers(successor_attempt_id)
          WHERE successor_attempt_id IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_handoff_transfers_task ON handoff_transfers(task_id);
        CREATE INDEX IF NOT EXISTS idx_handoff_transfers_status ON handoff_transfers(status);
      `);
    },
  };
