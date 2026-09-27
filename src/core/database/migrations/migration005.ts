import Database from 'better-sqlite3';
import type { Migration } from './types';

export const migration005: Migration = {
    version: 5,
    name: '005_repair_default_agent_resource_links',
    up: (db: Database.Database) => {
      // Repair supported default Agent -> ProviderResource relationships for databases
      // that previously executed original migration v3 and had provider_resource_id set to NULL.
      // Operates ONLY when both expected records exist, and does NOT overwrite existing valid IDs.
      db.exec(`
        UPDATE agents
        SET provider_resource_id = 'res-chatgpt-manager'
        WHERE id = 'agent-primary-manager'
          AND provider_resource_id IS NULL
          AND EXISTS (SELECT 1 FROM provider_resources WHERE id = 'res-chatgpt-manager');

        UPDATE agents
        SET provider_resource_id = 'res-gemini-coder'
        WHERE id = 'agent-gemini-coder'
          AND provider_resource_id IS NULL
          AND EXISTS (SELECT 1 FROM provider_resources WHERE id = 'res-gemini-coder');

        UPDATE agents
        SET provider_resource_id = 'res-claude-reviewer'
        WHERE id = 'agent-claude-reviewer'
          AND provider_resource_id IS NULL
          AND EXISTS (SELECT 1 FROM provider_resources WHERE id = 'res-claude-reviewer');
      `);
    },
  };
