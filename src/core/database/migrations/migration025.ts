import type { Migration } from './types';

export const migration025: Migration = {
  version: 25,
  name: 'durable_owner_verification_capabilities',
  up(db) {
    db.exec(`
      CREATE TABLE verification_capabilities (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        owner_principal TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version >= 1),
        state TEXT NOT NULL CHECK(state IN ('ACTIVE','REVOKED')),
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        approval_id TEXT NOT NULL UNIQUE,
        approval_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX verification_capabilities_project ON verification_capabilities(project_id, state);
      ALTER TABLE verification_commands ADD COLUMN capability_id TEXT REFERENCES verification_capabilities(id);
      ALTER TABLE verification_commands ADD COLUMN capability_version INTEGER;
    `);
  },
};
