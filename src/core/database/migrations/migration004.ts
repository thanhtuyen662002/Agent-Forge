import Database from 'better-sqlite3';
import type { Migration } from './types';

export const migration004: Migration = {
    version: 4,
    name: '004_process_run_ownership',
    up: (db: Database.Database) => {
      db.exec(`
        ALTER TABLE process_runs ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
        ALTER TABLE process_runs ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE;
        ALTER TABLE process_runs ADD COLUMN attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_process_runs_task ON process_runs(task_id);
        CREATE INDEX IF NOT EXISTS idx_process_runs_project ON process_runs(project_id);
      `);
    },
  };
