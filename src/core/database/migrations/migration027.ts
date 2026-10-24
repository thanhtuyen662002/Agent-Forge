import type { Migration } from './types';

export const migration027: Migration = {
  version: 27,
  name: 'agent_roster_lifecycle',
  up(db) {
    // Agents referenced by sessions, decisions and assignments are never
    // deleted. Removal from the active roster is a reversible marker, and the
    // optional profile link records which durable AgentProfile an owner-created
    // agent was configured with. Existing rows keep NULL for both columns.
    db.exec(`
      ALTER TABLE agents ADD COLUMN agent_profile_id TEXT NULL REFERENCES agent_profiles(id) ON DELETE SET NULL;
      ALTER TABLE agents ADD COLUMN removed_at TEXT NULL CHECK (removed_at IS NULL OR length(removed_at) > 0);
      CREATE INDEX idx_agents_active_roster ON agents(removed_at, role);
    `);
  },
};
