import Database from 'better-sqlite3';
import type { Migration } from './types';

export const migration015: Migration = {
    version: 15,
    name: '015_r5h4_ordered_provider_health_application_idempotency',
    up: (db: Database.Database) => {
      db.exec(`
        ALTER TABLE provider_accounts
        ADD COLUMN last_applied_action_account_order INTEGER NULL CHECK(
          last_applied_action_account_order IS NULL OR last_applied_action_account_order > 0
        );

        ALTER TABLE provider_accounts
        ADD COLUMN last_applied_action_authorization_id TEXT NULL;
      `);
    },
  };
