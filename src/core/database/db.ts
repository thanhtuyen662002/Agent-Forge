import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export class DatabaseEngine {
  private db: Database.Database | null = null;
  private dbPath: string;

  constructor(customPath?: string) {
    if (customPath) {
      this.dbPath = customPath;
    } else {
      const defaultDir = path.resolve(process.cwd(), '.agent-forge');
      if (!fs.existsSync(defaultDir)) {
        fs.mkdirSync(defaultDir, { recursive: true });
      }
      this.dbPath = path.join(defaultDir, 'agent-forge.db');
    }
  }

  public init(): Database.Database {
    try {
      if (this.db) {
        return this.db;
      }

      if (this.dbPath !== ':memory:') {
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }

      this.db = new Database(this.dbPath, {
        verbose: process.env.DEBUG_SQL ? console.log : undefined,
      });

      // Enforce security, concurrency, and integrity pragmas
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('temp_store = MEMORY');

      return this.db;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[Agent-Forge] Fatal Database Initialization Error:', errorMsg);
      throw new Error(
        `[Agent-Forge DatabaseEngine] Failed to initialize SQLite database at "${this.dbPath}". ` +
        `Ensure better-sqlite3 native bindings are built for your Node/Electron runtime.\n` +
        `Original error: ${errorMsg}`
      );
    }
  }

  public getDb(): Database.Database {
    if (!this.db) {
      return this.init();
    }
    return this.db;
  }

  public close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  public runInTransaction<T>(fn: () => T): T {
    const db = this.getDb();
    const transaction = db.transaction(fn);
    return transaction();
  }
}

export const defaultDb = new DatabaseEngine();
