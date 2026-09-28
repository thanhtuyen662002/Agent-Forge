import Database from 'better-sqlite3';
import type { Migration } from './types';

export const migration003: Migration = {
    version: 3,
    name: '003_nullable_health_check',
    up: (db: Database.Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS provider_resources_new (
          id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
          model_name TEXT NOT NULL,
          health_status TEXT NOT NULL CHECK(health_status IN (
            'AVAILABLE', 'BUSY', 'LOW_QUOTA', 'RATE_LIMITED', 'QUOTA_EXHAUSTED',
            'AUTH_ERROR', 'OFFLINE', 'UNHEALTHY', 'COOLDOWN', 'DISABLED', 'UNKNOWN'
          )),
          capabilities_json TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          total_quota REAL,
          remaining_quota REAL,
          quota_unit TEXT DEFAULT 'REQUESTS',
          quota_reset_at TEXT,
          quota_source TEXT NOT NULL CHECK(quota_source IN (
            'MEASURED', 'PROVIDER_REPORTED', 'MANUAL', 'ESTIMATED', 'UNKNOWN'
          )) DEFAULT 'UNKNOWN',
          quota_confidence REAL NOT NULL DEFAULT 0.0,
          last_health_check TEXT
        );

        INSERT INTO provider_resources_new SELECT * FROM provider_resources;
        DROP TABLE provider_resources;
        ALTER TABLE provider_resources_new RENAME TO provider_resources;
        CREATE INDEX IF NOT EXISTS idx_resources_provider ON provider_resources(provider_id);
      `);
    },
  };
