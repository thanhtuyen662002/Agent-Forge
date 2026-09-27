import Database from 'better-sqlite3';
import type { Migration } from './types';

export const migration012: Migration = {
    version: 12,
    name: '012_r5h4_provider_health_observation_ordering_authority',
    up: (db: Database.Database) => {
      db.exec(`
        ALTER TABLE provider_health_observations
        ADD COLUMN account_order INTEGER NULL;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_health_observations_account_order
        ON provider_health_observations(account_id, account_order)
        WHERE account_order IS NOT NULL;
      `);
    },
  };
