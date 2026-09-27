import Database from 'better-sqlite3';
import type { Migration } from './types';

export const migration011: Migration = {
    version: 11,
    name: '011_r5h4_durable_provider_health_observations',
    up: (db: Database.Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS provider_health_observations (
          authorization_id TEXT PRIMARY KEY REFERENCES execution_authorizations(id) ON DELETE CASCADE,
          execution_id TEXT NOT NULL,
          account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
          provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
          resource_id TEXT NOT NULL REFERENCES provider_resources(id) ON DELETE CASCADE,
          assignment_id TEXT NOT NULL REFERENCES agent_assignments(id) ON DELETE CASCADE,
          attempt_id TEXT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
          routing_decision_id TEXT NOT NULL,
          provenance_version INTEGER NOT NULL CHECK(provenance_version = 1),
          provenance_source TEXT NOT NULL CHECK(provenance_source = 'PROVIDER_DISPATCH_SERVICE'),
          mode TEXT NOT NULL CHECK(mode IN ('LEGACY', 'SCHEDULED')),
          adapter_invocation TEXT NOT NULL CHECK(adapter_invocation IN ('RETURNED', 'THREW')),
          result_status TEXT NOT NULL,
          classified_category TEXT NOT NULL,
          observed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_provider_health_observations_account ON provider_health_observations(account_id);
        CREATE INDEX IF NOT EXISTS idx_provider_health_observations_provider ON provider_health_observations(provider_id);
        CREATE INDEX IF NOT EXISTS idx_provider_health_observations_assignment ON provider_health_observations(assignment_id);
      `);
    },
  };
