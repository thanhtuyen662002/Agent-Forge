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

  it('should run initial migrations cleanly and create all tables', () => {
    MigrationRunner.run(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name ASC")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('projects');
    expect(tableNames).toContain('tasks');
    expect(tableNames).toContain('task_leases');
    expect(tableNames).toContain('provider_resources');
    expect(tableNames).toContain('protocol_messages');
    expect(tableNames).toContain('evidence');
    expect(tableNames).toContain('events');
    expect(tableNames).toContain('decisions');
    expect(tableNames).toContain('verification_commands');
    expect(tableNames).toContain('schema_migrations');

    const applied = db.prepare('SELECT COUNT(*) as count FROM schema_migrations').get() as { count: number };
    expect(applied.count).toBe(2);
  });

  it('should cleanly upgrade an existing database from schema v1 to v2 while preserving data', () => {
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

    // Insert sample project, task, and evidence in v1 schema
    db.exec(`
      INSERT INTO projects (id, name, repository_path, default_branch, status, created_at, updated_at)
      VALUES ('PROJ-MIG-1', 'Upgrade Test Project', 'd:/test', 'main', 'READY', '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z');

      INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, acceptance_criteria_json, constraints_json, created_at, updated_at)
      VALUES ('TSK-MIG-1', 'PROJ-MIG-1', 'Migrated Task', 'PLANNED', 'HIGH', 'MEDIUM', 0, 3, 0, '[]', '[]', '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z');

      INSERT INTO evidence (id, project_id, task_id, evidence_type, storage_type, hash, byte_size, content_type, summary, raw_payload, created_at)
      VALUES ('EV-MIG-1', 'PROJ-MIG-1', 'TSK-MIG-1', 'GIT_STATUS', 'INLINE', 'sha123', 10, 'text/plain', 'Initial Evidence', 'clean', '2026-08-17T00:00:00Z');
    `);

    // Verify verification_commands does NOT exist yet in v1
    const v1Tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    expect(v1Tables).not.toContain('verification_commands');

    // 2. Run MigrationRunner to upgrade to v2
    MigrationRunner.run(db);

    // 3. Assert migration v2 applied
    const v2Tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    expect(v2Tables).toContain('verification_commands');

    const migrationCount = (db.prepare('SELECT COUNT(*) as count FROM schema_migrations').get() as { count: number }).count;
    expect(migrationCount).toBe(2);

    // 4. Assert pre-existing data survived unchanged
    const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get('PROJ-MIG-1') as any;
    expect(proj.name).toBe('Upgrade Test Project');

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('TSK-MIG-1') as any;
    expect(task.title).toBe('Migrated Task');

    const ev = db.prepare('SELECT * FROM evidence WHERE id = ?').get('EV-MIG-1') as any;
    expect(ev.summary).toBe('Initial Evidence');

    // 5. Run MigrationRunner again and prove idempotency
    expect(() => MigrationRunner.run(db)).not.toThrow();
    const finalCount = (db.prepare('SELECT COUNT(*) as count FROM schema_migrations').get() as { count: number }).count;
    expect(finalCount).toBe(2);
  });
});
