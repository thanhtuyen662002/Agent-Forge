import Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
  foreignKeyMode?: 'ENFORCED' | 'DISABLED_FOR_REBUILD';
}
