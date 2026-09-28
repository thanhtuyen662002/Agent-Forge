import Database from 'better-sqlite3';
import type { Migration } from './types';

export const migration018: Migration = {
    version: 18,
    name: '018_r5i_successor_context_authority',
    up: (db: Database.Database) => {
      db.exec(`
        ALTER TABLE handoff_transfers
        ADD COLUMN successor_context_snapshot_id TEXT NULL REFERENCES context_snapshots(id) ON DELETE RESTRICT;

        ALTER TABLE handoff_transfers
        ADD COLUMN successor_context_spec_hash TEXT NULL;

        CREATE INDEX IF NOT EXISTS idx_handoff_transfers_context_snapshot
        ON handoff_transfers(successor_context_snapshot_id);
      `);
    },
  };
