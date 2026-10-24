import type { Migration } from './types';

export const migration027: Migration = {
  version: 27,
  name: 'owner_workspace_lifecycle',
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

    // Owner trash for projects and tasks. A row hides the entity from active
    // lists; deleting the row restores it. Project, task, evidence and
    // repository data are never deleted by trashing.
    db.exec(`
      CREATE TABLE workspace_trash (
        entity_type TEXT NOT NULL CHECK (entity_type IN ('PROJECT', 'TASK')),
        entity_id TEXT NOT NULL CHECK (length(entity_id) > 0),
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        trashed_at TEXT NOT NULL CHECK (length(trashed_at) > 0),
        PRIMARY KEY (entity_type, entity_id),
        CHECK (entity_type <> 'PROJECT' OR entity_id = project_id)
      );
      CREATE INDEX idx_workspace_trash_project ON workspace_trash(project_id);
    `);
  },
};
