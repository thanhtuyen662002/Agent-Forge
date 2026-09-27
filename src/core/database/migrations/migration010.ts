import Database from 'better-sqlite3';
import type { Migration } from './types';

export const migration010: Migration = {
    version: 10,
    name: '010_r5h4_failover_lineage_budget_idempotency',
    up: (db: Database.Database) => {
      // 1. Check for legacy duplicate attempt numbers on task_attempts before creating unique index
      const duplicate = db
        .prepare(`
          SELECT task_id, attempt_number, COUNT(*) AS count
          FROM task_attempts
          GROUP BY task_id, attempt_number
          HAVING COUNT(*) > 1
          LIMIT 1
        `)
        .get() as { task_id: string; attempt_number: number; count: number } | undefined;

      if (duplicate) {
        throw new Error(
          `[Migration 10] Cannot apply unique index on task_attempts(task_id, attempt_number): duplicate attempt_number ${duplicate.attempt_number} found for task_id "${duplicate.task_id}" (${duplicate.count} occurrences).`
        );
      }

      // 2. Create unique indexes on task_attempts
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_task_attempts_task_number_unique ON task_attempts(task_id, attempt_number);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_task_attempts_task_id_id_unique ON task_attempts(task_id, id);
      `);

      // 3. Create failover_transitions table with composite foreign keys to guarantee same-task integrity
      db.exec(`
        CREATE TABLE IF NOT EXISTS failover_transitions (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          root_attempt_id TEXT NOT NULL,
          source_attempt_id TEXT NOT NULL,
          successor_attempt_id TEXT NOT NULL,
          failover_ordinal INTEGER NOT NULL CHECK(failover_ordinal >= 1),
          created_at TEXT NOT NULL,
          FOREIGN KEY (task_id, root_attempt_id) REFERENCES task_attempts(task_id, id) ON DELETE CASCADE,
          FOREIGN KEY (task_id, source_attempt_id) REFERENCES task_attempts(task_id, id) ON DELETE CASCADE,
          FOREIGN KEY (task_id, successor_attempt_id) REFERENCES task_attempts(task_id, id) ON DELETE CASCADE,
          UNIQUE(source_attempt_id),
          UNIQUE(successor_attempt_id),
          UNIQUE(root_attempt_id, failover_ordinal)
        );
        CREATE INDEX IF NOT EXISTS idx_failover_transitions_task ON failover_transitions(task_id);
      `);
    },
  };
