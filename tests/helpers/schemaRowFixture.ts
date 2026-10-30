import type Database from 'better-sqlite3';

interface ColumnInfo { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }
export interface ForeignKeyInfo { table: string; from: string; to: string | null }

let counter = 0;

export function tableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

export function columnsOf(db: Database.Database, table: string): ColumnInfo[] {
  return db.pragma(`table_info(${table})`) as ColumnInfo[];
}

export function foreignKeysOf(db: Database.Database, table: string): ForeignKeyInfo[] {
  return db.pragma(`foreign_key_list(${table})`) as ForeignKeyInfo[];
}

export function primaryKeyOf(db: Database.Database, table: string): string {
  return columnsOf(db, table).find((column) => column.pk === 1)?.name ?? 'rowid';
}

/**
 * Inserts one row, filling every NOT NULL column without a default with a
 * unique placeholder. Foreign keys and CHECK constraints are suspended for the
 * insert only, so a test can build an exact reference graph by hand; callers
 * prove the graph with PRAGMA foreign_key_check. Must run outside a transaction.
 */
export function insertFixtureRow(db: Database.Database, table: string, values: Record<string, unknown> = {}): Record<string, unknown> {
  const columns = columnsOf(db, table);
  const row: Record<string, unknown> = {};
  for (const column of columns) {
    if (column.name in values) row[column.name] = values[column.name];
    else if ((column.notnull || column.pk) && column.dflt_value === null && !(column.pk && /INT/i.test(column.type))) {
      counter += 1;
      row[column.name] = /INT|REAL|NUM|BOOL/i.test(column.type) ? 0
        : column.name.endsWith('_json') ? '{}'
          : `${table}.${column.name}.${counter}`;
    }
  }
  const names = Object.keys(row);
  db.pragma('foreign_keys = OFF');
  db.pragma('ignore_check_constraints = ON');
  try {
    const sql = names.length === 0
      ? `INSERT INTO ${table} DEFAULT VALUES`
      : `INSERT INTO ${table} (${names.map((name) => `"${name}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`;
    const info = db.prepare(sql).run(...names.map((name) => (typeof row[name] === 'boolean' ? (row[name] ? 1 : 0) : row[name])));
    const pk = columns.find((column) => column.pk === 1);
    if (pk && !(pk.name in row)) row[pk.name] = Number(info.lastInsertRowid);
  } finally {
    db.pragma('ignore_check_constraints = OFF');
    db.pragma('foreign_keys = ON');
  }
  return row;
}
