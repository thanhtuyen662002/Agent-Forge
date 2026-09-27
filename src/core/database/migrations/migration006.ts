import Database from 'better-sqlite3';
import type { Migration } from './types';

export const migration006: Migration = {
    version: 6,
    name: '006_execution_authorizations',
    up: (db: Database.Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS execution_authorizations (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
          attempt_id TEXT REFERENCES task_attempts(id) ON DELETE RESTRICT,
          task_revision INTEGER NOT NULL,
          base_sha TEXT NOT NULL,
          repository_head_sha TEXT NOT NULL,
          manager_message_id TEXT NOT NULL REFERENCES protocol_messages(id) ON DELETE RESTRICT,
          manager_payload_hash TEXT NOT NULL,
          routing_decision_id TEXT NOT NULL,
          selected_resource_id TEXT NOT NULL REFERENCES provider_resources(id) ON DELETE RESTRICT,
          selected_provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
          instruction_payload_hash TEXT NOT NULL,
          context_manifest_hash TEXT NOT NULL,
          canonical_instructions_json TEXT NOT NULL,
          context_files_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('AUTHORIZED', 'DISPATCHED', 'INVALIDATED')) DEFAULT 'AUTHORIZED',
          created_at TEXT NOT NULL,
          dispatched_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_exec_auth_task ON execution_authorizations(task_id);
        CREATE INDEX IF NOT EXISTS idx_exec_auth_project ON execution_authorizations(project_id);
        CREATE INDEX IF NOT EXISTS idx_exec_auth_routing ON execution_authorizations(routing_decision_id);
        CREATE INDEX IF NOT EXISTS idx_exec_auth_manager_msg ON execution_authorizations(manager_message_id);
      `);
    },
  };
