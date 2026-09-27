import Database from 'better-sqlite3';
import type { Migration } from './types';

export const migration013: Migration = {
    version: 13,
    name: '013_r5h4_durable_provider_health_action_plan_authority',
    up: (db: Database.Database) => {
      db.exec(`
        ALTER TABLE provider_health_observations
        ADD COLUMN health_action_plan_version INTEGER NULL CHECK(health_action_plan_version IS NULL OR health_action_plan_version = 1);

        ALTER TABLE provider_health_observations
        ADD COLUMN health_action TEXT NULL CHECK(health_action IS NULL OR health_action IN (
          'NO_MUTATION', 'RECORD_SUCCESS', 'RECORD_RATE_LIMITED', 'RECORD_QUOTA_EXHAUSTED', 'RECORD_AUTH_ERROR'
        ));

        ALTER TABLE provider_health_observations
        ADD COLUMN health_action_cooldown_duration_ms INTEGER NULL CHECK(
          health_action_cooldown_duration_ms IS NULL OR health_action_cooldown_duration_ms > 0
        );
      `);
    },
  };
