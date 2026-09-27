import Database from 'better-sqlite3';
import type { Migration } from './types';

export const migration009: Migration = {
    version: 9,
    name: '009_r5b_durable_memory_context_fabric',
    up: (db: Database.Database) => {
      db.exec(`
        -- 1. Agent Sessions (Logical execution sessions decoupled from external conversations)
        CREATE TABLE IF NOT EXISTS agent_sessions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
          assignment_id TEXT REFERENCES agent_assignments(id) ON DELETE SET NULL,
          provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
          provider_account_id TEXT REFERENCES provider_accounts(id) ON DELETE SET NULL,
          provider_resource_id TEXT REFERENCES provider_resources(id) ON DELETE SET NULL,
          external_session_ref TEXT,
          status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'ENDED', 'FAILED', 'SUSPENDED')) DEFAULT 'ACTIVE',
          started_at TEXT NOT NULL,
          ended_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_sessions_task ON agent_sessions(task_id);
        CREATE INDEX IF NOT EXISTS idx_agent_sessions_project ON agent_sessions(project_id);
        CREATE INDEX IF NOT EXISTS idx_agent_sessions_assignment ON agent_sessions(assignment_id);

        -- 2. Project Memory (Durable, versioned project-level knowledge)
        CREATE TABLE IF NOT EXISTS project_memories (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          memory_type TEXT NOT NULL CHECK(memory_type IN (
            'ARCHITECTURE', 'OWNER_POLICY', 'CONSTRAINT', 'DECISION',
            'CONVENTION', 'REPOSITORY_FACT', 'CUSTOM'
          )),
          key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_ref TEXT,
          revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
          is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_project_memories_project_key ON project_memories(project_id, memory_type, key);
        CREATE INDEX IF NOT EXISTS idx_project_memories_revision ON project_memories(project_id, memory_type, key, revision);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_active_project_memory ON project_memories(project_id, memory_type, key) WHERE is_active = 1;

        -- 3. Task Memory (Durable, versioned task-specific operational memory)
        CREATE TABLE IF NOT EXISTS task_memories (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
          assignment_id TEXT REFERENCES agent_assignments(id) ON DELETE SET NULL,
          memory_type TEXT NOT NULL CHECK(memory_type IN (
            'GOAL', 'ACCEPTANCE_CRITERION', 'CONSTRAINT', 'COMPLETED_STEP',
            'REMAINING_STEP', 'KNOWN_ISSUE', 'DECISION', 'VERIFICATION_FACT',
            'RECOMMENDED_NEXT_ACTION', 'CUSTOM'
          )),
          key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_ref TEXT,
          revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
          is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_task_memories_task_key ON task_memories(task_id, memory_type, key);
        CREATE INDEX IF NOT EXISTS idx_task_memories_project ON task_memories(project_id);
        CREATE INDEX IF NOT EXISTS idx_task_memories_revision ON task_memories(task_id, memory_type, key, revision);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_active_task_memory ON task_memories(task_id, memory_type, key) WHERE is_active = 1;

        -- 4. Context Snapshots (Immutable frozen context input)
        CREATE TABLE IF NOT EXISTS context_snapshots (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
          assignment_id TEXT REFERENCES agent_assignments(id) ON DELETE SET NULL,
          session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
          purpose TEXT NOT NULL CHECK(purpose IN (
            'EXECUTION', 'REVIEW', 'HANDOFF', 'MANAGER', 'RESEARCH', 'CUSTOM'
          )),
          snapshot_version INTEGER NOT NULL DEFAULT 1 CHECK(snapshot_version >= 1),
          builder_version TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_context_snapshots_task ON context_snapshots(task_id);
        CREATE INDEX IF NOT EXISTS idx_context_snapshots_project ON context_snapshots(project_id);
        CREATE INDEX IF NOT EXISTS idx_context_snapshots_hash ON context_snapshots(content_hash);

        -- 5. Context Items (Ordered members of ContextSnapshot)
        CREATE TABLE IF NOT EXISTS context_items (
          id TEXT PRIMARY KEY,
          snapshot_id TEXT NOT NULL REFERENCES context_snapshots(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
          item_type TEXT NOT NULL CHECK(item_type IN (
            'PROJECT_CONTRACT', 'PROJECT_MEMORY', 'TASK_CORE', 'TASK_MEMORY',
            'CHECKPOINT', 'HANDOFF', 'CONTEXT_FILE_REFERENCE', 'CUSTOM'
          )),
          source_type TEXT NOT NULL,
          source_ref TEXT,
          content_json TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          token_estimate INTEGER,
          created_at TEXT NOT NULL,
          UNIQUE(snapshot_id, ordinal)
        );
        CREATE INDEX IF NOT EXISTS idx_context_items_snapshot_ordinal ON context_items(snapshot_id, ordinal);

        -- 6. Context Manifests (Canonical manifest describing the complete immutable context snapshot)
        CREATE TABLE IF NOT EXISTS context_manifests (
          id TEXT PRIMARY KEY,
          snapshot_id TEXT NOT NULL UNIQUE REFERENCES context_snapshots(id) ON DELETE CASCADE,
          manifest_version TEXT NOT NULL,
          item_count INTEGER NOT NULL CHECK(item_count >= 0),
          manifest_json TEXT NOT NULL,
          manifest_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_context_manifests_hash ON context_manifests(manifest_hash);

        -- 7. Handoff Context (Durable context bridge for cross-agent/model/provider movement)
        CREATE TABLE IF NOT EXISTS handoff_contexts (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
          from_assignment_id TEXT REFERENCES agent_assignments(id) ON DELETE SET NULL,
          to_assignment_id TEXT REFERENCES agent_assignments(id) ON DELETE SET NULL,
          source_snapshot_id TEXT NOT NULL REFERENCES context_snapshots(id) ON DELETE RESTRICT,
          handoff_snapshot_id TEXT REFERENCES context_snapshots(id) ON DELETE SET NULL,
          reason TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('PENDING', 'READY', 'CONSUMED', 'FAILED', 'CANCELLED')) DEFAULT 'PENDING',
          created_at TEXT NOT NULL,
          consumed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_handoff_contexts_task ON handoff_contexts(task_id);
        CREATE INDEX IF NOT EXISTS idx_handoff_contexts_project ON handoff_contexts(project_id);
      `);
    },
  };
