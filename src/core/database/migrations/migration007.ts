import Database from 'better-sqlite3';
import type { Migration } from './types';

export const migration007: Migration = {
    version: 7,
    name: '007_execution_authorization_canonical_payload',
    up: (db: Database.Database) => {
      db.exec(`
        ALTER TABLE execution_authorizations
        ADD COLUMN canonical_payload_json TEXT NULL;
      `);
    },
  };
