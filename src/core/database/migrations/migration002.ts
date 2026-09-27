import Database from 'better-sqlite3';
import type { Migration } from './types';

export const migration002: Migration = {
    version: 2,
    name: '002_verification_commands',
    up: (db: Database.Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS verification_commands (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          command_type TEXT NOT NULL CHECK(command_type IN ('TEST', 'LINT', 'TYPECHECK', 'BUILD')),
          executable TEXT NOT NULL,
          args_json TEXT NOT NULL,
          timeout_ms INTEGER NOT NULL DEFAULT 60000,
          enabled INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_verif_cmds_project ON verification_commands(project_id);
      `);
    },
  };
