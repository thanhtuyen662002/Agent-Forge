import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';

describe('Database Migrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  it('should run initial migration cleanly and create all tables', () => {
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
    expect(tableNames).toContain('schema_migrations');
  });

  it('should be idempotent and not re-run already applied migrations', () => {
    MigrationRunner.run(db);
    // Running a second time should succeed without error
    expect(() => MigrationRunner.run(db)).not.toThrow();

    const applied = db.prepare('SELECT COUNT(*) as count FROM schema_migrations').get() as { count: number };
    expect(applied.count).toBe(1);
  });
});
