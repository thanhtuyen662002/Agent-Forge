import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner, MIGRATIONS } from '../src/core/database/migrations';

describe('Database Migrations & Upgrade Integrity', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  it('should run all migrations cleanly and create all tables (v1 through v12)', () => {
    MigrationRunner.run(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name ASC")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('projects');
    expect(tableNames).toContain('tasks');
    expect(tableNames).toContain('task_leases');
    expect(tableNames).toContain('provider_resources');
    expect(tableNames).toContain('agents');
    expect(tableNames).toContain('protocol_messages');
    expect(tableNames).toContain('evidence');
    expect(tableNames).toContain('events');
    expect(tableNames).toContain('decisions');
    expect(tableNames).toContain('verification_commands');
    expect(tableNames).toContain('process_runs');
    expect(tableNames).toContain('execution_authorizations');
    expect(tableNames).toContain('role_profiles');
    expect(tableNames).toContain('agent_profiles');
    expect(tableNames).toContain('provider_accounts');
    expect(tableNames).toContain('worker_slots');
    expect(tableNames).toContain('agent_assignments');
    expect(tableNames).toContain('account_leases');
    expect(tableNames).toContain('route_policies');
    expect(tableNames).toContain('separation_policies');
    expect(tableNames).toContain('agent_sessions');
    expect(tableNames).toContain('project_memories');
    expect(tableNames).toContain('task_memories');
    expect(tableNames).toContain('context_snapshots');
    expect(tableNames).toContain('context_items');
    expect(tableNames).toContain('context_manifests');
    expect(tableNames).toContain('handoff_contexts');
    expect(tableNames).toContain('failover_transitions');
    expect(tableNames).toContain('provider_health_observations');
    expect(tableNames).toContain('schema_migrations');

    const indexList = db.prepare('PRAGMA index_list(task_attempts)').all() as { name: string; unique: number }[];
    const uniqueTaskAttemptIdx = indexList.find((i) => i.name === 'idx_task_attempts_task_number_unique');
    expect(uniqueTaskAttemptIdx).toBeDefined();
    expect(uniqueTaskAttemptIdx?.unique).toBe(1);

    const obsIndexList = db.prepare('PRAGMA index_list(provider_health_observations)').all() as { name: string; unique: number }[];
    const uniqueAccountOrderIdx = obsIndexList.find((i) => i.name === 'idx_provider_health_observations_account_order');
    expect(uniqueAccountOrderIdx).toBeDefined();
    expect(uniqueAccountOrderIdx?.unique).toBe(1);

    const applied = db.prepare('SELECT COUNT(*) as count FROM schema_migrations').get() as { count: number };
    expect(applied.count).toBe(12);

    // Foreign key integrity check
    const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
    expect(fkViolations).toHaveLength(0);

    // Idempotency check: running MigrationRunner again applies 0 new migrations
    MigrationRunner.run(db);
    const appliedAgain = db.prepare('SELECT COUNT(*) as count FROM schema_migrations').get() as { count: number };
    expect(appliedAgain.count).toBe(12);
  });

  it('should cleanly upgrade an existing database through historical path (v1 -> v2 -> original v3 -> v4 -> v5 -> v6 -> v7 -> v8 -> v9 -> v10 -> v11 -> v12) and repair default agent links', () => {
    // 1. Manually apply v1 schema
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const v1 = MIGRATIONS.find((m) => m.version === 1)!;
    v1.up(db);
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      1,
      v1.name,
      new Date().toISOString()
    );

    // Insert sample project, task, provider, supported default resources, and agents in v1 schema
    db.exec(`
      INSERT INTO projects (id, name, repository_path, default_branch, status, created_at, updated_at)
      VALUES ('PROJ-MIG-1', 'Upgrade Test Project', 'd:/test', 'main', 'READY', '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z');

      INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, acceptance_criteria_json, constraints_json, created_at, updated_at)
      VALUES ('TSK-MIG-1', 'PROJ-MIG-1', 'Migrated Task', 'PLANNED', 'HIGH', 'MEDIUM', 0, 3, 0, '[]', '[]', '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z');

      INSERT INTO providers (id, name, adapter_type, enabled, created_at)
      VALUES ('prov-manual-bridge', 'Manual Bridge', 'MANUAL_BRIDGE', 1, '2026-08-17T00:00:00Z');

      INSERT INTO provider_resources (id, provider_id, model_name, health_status, capabilities_json, enabled, total_quota, remaining_quota, quota_unit, quota_reset_at, quota_source, quota_confidence, last_health_check)
      VALUES ('res-chatgpt-manager', 'prov-manual-bridge', 'ChatGPT-4o', 'AVAILABLE', '[]', 1, 100, 50, 'REQUESTS', NULL, 'MANUAL', 1.0, '2026-08-17T00:00:00Z');

      INSERT INTO provider_resources (id, provider_id, model_name, health_status, capabilities_json, enabled, total_quota, remaining_quota, quota_unit, quota_reset_at, quota_source, quota_confidence, last_health_check)
      VALUES ('res-gemini-coder', 'prov-manual-bridge', 'Gemini 2.5 Pro', 'AVAILABLE', '[]', 1, 500, 450, 'REQUESTS', NULL, 'MANUAL', 1.0, '2026-08-17T00:00:00Z');

      INSERT INTO agents (id, display_name, role, provider_resource_id, status, current_task_id, last_seen_at)
      VALUES ('agent-primary-manager', 'Lead Architect', 'PRIMARY_MANAGER', 'res-chatgpt-manager', 'IDLE', NULL, '2026-08-17T00:00:00Z');

      INSERT INTO agents (id, display_name, role, provider_resource_id, status, current_task_id, last_seen_at)
      VALUES ('agent-gemini-coder', 'Implementation Coder', 'CODER', 'res-gemini-coder', 'IDLE', NULL, '2026-08-17T00:00:00Z');

      INSERT INTO evidence (id, project_id, task_id, evidence_type, storage_type, hash, byte_size, content_type, summary, raw_payload, created_at)
      VALUES ('EV-MIG-1', 'PROJ-MIG-1', 'TSK-MIG-1', 'GIT_STATUS', 'INLINE', 'sha123', 10, 'text/plain', 'Initial Evidence', 'clean', '2026-08-17T00:00:00Z');
    `);

    // Verify initial agent-resource mappings BEFORE upgrade
    const mgrBefore = db.prepare('SELECT * FROM agents WHERE id = ?').get('agent-primary-manager') as any;
    expect(mgrBefore.provider_resource_id).toBe('res-chatgpt-manager');

    // 2. Run MigrationRunner to upgrade from v1 to latest (v12)
    MigrationRunner.run(db);

    // 3. Assert migrations applied
    const v12Tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    expect(v12Tables).toContain('verification_commands');
    expect(v12Tables).toContain('provider_resources');
    expect(v12Tables).toContain('process_runs');
    expect(v12Tables).toContain('execution_authorizations');
    expect(v12Tables).toContain('role_profiles');
    expect(v12Tables).toContain('agent_profiles');
    expect(v12Tables).toContain('provider_accounts');
    expect(v12Tables).toContain('worker_slots');
    expect(v12Tables).toContain('agent_assignments');
    expect(v12Tables).toContain('account_leases');
    expect(v12Tables).toContain('route_policies');
    expect(v12Tables).toContain('separation_policies');
    expect(v12Tables).toContain('agent_sessions');
    expect(v12Tables).toContain('project_memories');
    expect(v12Tables).toContain('task_memories');
    expect(v12Tables).toContain('context_snapshots');
    expect(v12Tables).toContain('context_items');
    expect(v12Tables).toContain('context_manifests');
    expect(v12Tables).toContain('handoff_contexts');
    expect(v12Tables).toContain('failover_transitions');
    expect(v12Tables).toContain('provider_health_observations');

    const migrationCount = (db.prepare('SELECT COUNT(*) as count FROM schema_migrations').get() as { count: number }).count;
    expect(migrationCount).toBe(12);

    // 4. Assert default agent links are repaired by migration 005
    const mgrAfter = db.prepare('SELECT * FROM agents WHERE id = ?').get('agent-primary-manager') as any;
    expect(mgrAfter.provider_resource_id).toBe('res-chatgpt-manager');

    const coderAfter = db.prepare('SELECT * FROM agents WHERE id = ?').get('agent-gemini-coder') as any;
    expect(coderAfter.provider_resource_id).toBe('res-gemini-coder');

    // 5. Assert absent legacy Claude records are NOT created
    const absentClaudeResource = db.prepare('SELECT * FROM provider_resources WHERE id = ?').get('res-claude-reviewer');
    expect(absentClaudeResource).toBeUndefined();

    // 6. Assert resource metadata is preserved
    const res = db.prepare('SELECT * FROM provider_resources WHERE id = ?').get('res-chatgpt-manager') as any;
    expect(res.model_name).toBe('ChatGPT-4o');
    expect(res.remaining_quota).toBe(50);
    expect(res.health_status).toBe('AVAILABLE');

    // 7. Assert PRAGMA foreign_key_check passes with 0 violations
    const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
    expect(fkViolations).toHaveLength(0);
  });
});
