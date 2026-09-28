import Database from 'better-sqlite3';
import type { Migration } from './types';

export const migration016: Migration = {
    version: 16,
    name: '016_r5i_durable_handoff_ownership_and_execution_authority',
    foreignKeyMode: 'DISABLED_FOR_REBUILD',
    up: (db: Database.Database) => {
      // 1. Rebuild task_attempts to support nullable agent_id + nullable agent_profile_id with identity check
      db.exec(`
        CREATE TABLE task_attempts_new (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          attempt_number INTEGER NOT NULL,
          agent_id TEXT NULL,
          agent_profile_id TEXT NULL REFERENCES agent_profiles(id) ON DELETE SET NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          summary TEXT,
          CHECK(agent_id IS NOT NULL OR agent_profile_id IS NOT NULL)
        );

        INSERT INTO task_attempts_new (
          id, task_id, attempt_number, agent_id, agent_profile_id, status, started_at, ended_at, summary
        )
        SELECT id, task_id, attempt_number, agent_id, NULL, status, started_at, ended_at, summary
        FROM task_attempts;

        DROP TABLE task_attempts;

        ALTER TABLE task_attempts_new RENAME TO task_attempts;

        CREATE INDEX IF NOT EXISTS idx_attempts_task ON task_attempts(task_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_task_attempts_task_number_unique ON task_attempts(task_id, attempt_number);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_task_attempts_task_id_id_unique ON task_attempts(task_id, id);
        CREATE INDEX IF NOT EXISTS idx_task_attempts_agent_profile ON task_attempts(agent_profile_id);
      `);

      // 2. Add durable task ownership epoch to tasks
      db.exec(`
        ALTER TABLE tasks ADD COLUMN ownership_epoch INTEGER NOT NULL DEFAULT 1;
      `);

      // 3. Extend execution_authorizations with execution lifecycle and termination fields
      db.exec(`
        ALTER TABLE execution_authorizations ADD COLUMN task_ownership_epoch INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE execution_authorizations ADD COLUMN execution_id TEXT NULL;
        ALTER TABLE execution_authorizations ADD COLUMN adapter_started_at TEXT NULL;
        ALTER TABLE execution_authorizations ADD COLUMN adapter_finished_at TEXT NULL;
        ALTER TABLE execution_authorizations ADD COLUMN adapter_outcome TEXT NULL CHECK(
          adapter_outcome IS NULL OR adapter_outcome IN ('RETURNED', 'THREW', 'CANCELLED', 'TIMED_OUT', 'UNKNOWN')
        );
        ALTER TABLE execution_authorizations ADD COLUMN cancellation_requested_at TEXT NULL;
        ALTER TABLE execution_authorizations ADD COLUMN termination_confirmed_at TEXT NULL;
        ALTER TABLE execution_authorizations ADD COLUMN termination_status TEXT NULL CHECK(
          termination_status IS NULL OR termination_status IN ('CONFIRMED_TERMINATED', 'UNRESOLVED')
        );
        ALTER TABLE execution_authorizations ADD COLUMN termination_source TEXT NULL;
      `);

      // 4. Create dedicated handoff_transfers table
      db.exec(`
        CREATE TABLE IF NOT EXISTS handoff_transfers (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          source_attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
          successor_attempt_id TEXT NULL REFERENCES task_attempts(id) ON DELETE SET NULL,
          source_assignment_id TEXT NOT NULL REFERENCES agent_assignments(id) ON DELETE CASCADE,
          successor_assignment_id TEXT NULL REFERENCES agent_assignments(id) ON DELETE SET NULL,
          successor_role_profile_id TEXT NULL REFERENCES role_profiles(id) ON DELETE SET NULL,
          successor_agent_profile_id TEXT NULL REFERENCES agent_profiles(id) ON DELETE SET NULL,
          successor_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
          handoff_context_id TEXT NOT NULL REFERENCES handoff_contexts(id) ON DELETE RESTRICT,
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

        CREATE UNIQUE INDEX IF NOT EXISTS idx_active_handoff_transfer_source
          ON handoff_transfers(source_attempt_id)
          WHERE status IN ('REQUESTED', 'FROZEN', 'QUIESCING', 'RELINQUISHED', 'SUCCESSOR_PREPARED', 'ROUTED', 'AUTHORIZED', 'ACCEPTED');

        CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_transfers_successor_attempt
          ON handoff_transfers(successor_attempt_id)
          WHERE successor_attempt_id IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_handoff_transfers_task ON handoff_transfers(task_id);
        CREATE INDEX IF NOT EXISTS idx_handoff_transfers_status ON handoff_transfers(status);
      `);
    },
  };
