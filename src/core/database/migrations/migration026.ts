import type { Migration } from './types';

export const migration026: Migration = {
  version: 26,
  name: 'selected_project_repository_identities',
  up(db) {
    // Historical paths have no proven directory identity. Do not backfill or
    // adopt whichever object happens to be at those paths during an upgrade.
    db.exec(`
      CREATE TABLE project_repository_identities (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        canonical_path TEXT NOT NULL,
        identity_json TEXT NOT NULL CHECK(length(identity_json) <= 262144),
        created_at TEXT NOT NULL
      );
    `);
  },
};
