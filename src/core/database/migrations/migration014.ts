import Database from 'better-sqlite3';
import type { Migration } from './types';

export const migration014: Migration = {
    version: 14,
    name: '014_r5h4_provider_health_cooldown_replay_authority',
    up: (db: Database.Database) => {
      db.exec(`
        ALTER TABLE provider_health_observations
        ADD COLUMN health_action_cooldown_anchor_at TEXT NULL;
      `);
    },
  };
