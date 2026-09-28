import Database from 'better-sqlite3';
import type { Migration } from './types';

export const migration019: Migration = {
    version: 19,
    name: '019_r5i_execution_authorization_assignment_and_unique_successor_auth',
    up: (db: Database.Database) => {
      db.exec(`
        ALTER TABLE execution_authorizations
        ADD COLUMN assignment_id TEXT NULL REFERENCES agent_assignments(id) ON DELETE RESTRICT;

        CREATE INDEX IF NOT EXISTS idx_exec_auth_assignment
        ON execution_authorizations(assignment_id);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_transfers_successor_auth
        ON handoff_transfers(successor_authorization_id)
        WHERE successor_authorization_id IS NOT NULL;
      `);
    },
  };
