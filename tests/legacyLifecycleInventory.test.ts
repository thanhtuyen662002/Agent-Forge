import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { AutonomyStore } from '../src/core/autonomy/store';

const LEGACY_TABLES = [
  'autonomy_work_orders',
  'autonomy_slots',
  'autonomy_runs',
  'autonomy_reviews',
  'autonomy_ci_watches',
  'autonomy_ci_reconciliations',
  'autonomy_claims',
  'autonomy_events',
  'autonomy_manager_resources',
  'autonomy_manager_attempts',
  'autonomy_manager_contexts',
  'autonomy_trial_runs',
  'autonomy_trial_run_events',
  'autonomy_review_capacity_waits',
] as const;

describe('legacy autonomy lifecycle inventory', () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('enumerates every retained table and never reports a legacy lifecycle authority', () => {
    const database = new Database(':memory:');
    databases.push(database);
    const store = new AutonomyStore(database);

    const report = store.inventoryLegacyState();

    expect(report.tables.map((table) => table.tableName)).toEqual([...LEGACY_TABLES]);
    expect(new Set(report.tables.map((table) => table.tableName)).size).toBe(LEGACY_TABLES.length);
    expect(report.tables.every((table) => table.isAuthoritative === false)).toBe(true);
    expect(report.tables.every((table) => store.isLegacyTableAuthoritative(table.tableName) === false)).toBe(true);
    expect(report.totalRetainedRows).toBe(0);
    expect(report.activeRetainedCount).toBe(0);
  });

  it('keeps the compatibility inventory itself separate from legacy lifecycle tables', () => {
    const database = new Database(':memory:');
    databases.push(database);
    const store = new AutonomyStore(database);

    store.inventoryLegacyState();

    const inventoryRows = database
      .prepare('SELECT table_name, is_lifecycle_authoritative FROM autonomy_compatibility_inventory ORDER BY table_name')
      .all() as Array<{ table_name: string; is_lifecycle_authoritative: number }>;
    expect(inventoryRows.map((row) => row.table_name)).toEqual([...LEGACY_TABLES].sort());
    expect(inventoryRows.every((row) => row.is_lifecycle_authoritative === 0)).toBe(true);
    expect(database.prepare('SELECT COUNT(*) AS count FROM autonomy_work_orders').get()).toEqual({ count: 0 });
  });
});
