import fs from 'fs';
import Database from 'better-sqlite3';
import { Repository } from '../core/database/repositories';
import {
  McpSessionAuthorityService,
  McpAuthorityError,
} from '../core/services/McpSessionAuthorityService';
import { verifyMigration21SchemaAuthority } from '../core/database/migrations';
import { AuthorizedContextResponse } from '../core/types/domain';

export interface McpAuthorityContextOptions {
  dbPath?: string;
  sessionToken?: string;
  db?: Database.Database;
}

export class McpAuthorityContext {
  private db: Database.Database | null = null;
  private service: McpSessionAuthorityService | null = null;
  private readonly configuredDbPath?: string;
  private readonly configuredSessionToken?: string;

  constructor(options?: McpAuthorityContextOptions) {
    this.configuredDbPath = options?.dbPath;
    this.configuredSessionToken = options?.sessionToken;
    if (options?.db) {
      // Enforce production read-only boundary on injected connection
      if (!options.db.readonly) {
        throw new McpAuthorityError(
          'MCP_CONFIGURATION_INVALID',
          'Database connection must be opened with readonly: true'
        );
      }
      const queryOnly = options.db.pragma('query_only', { simple: true }) as number;
      if (queryOnly !== 1) {
        throw new McpAuthorityError(
          'MCP_CONFIGURATION_INVALID',
          'Database connection must have PRAGMA query_only = ON'
        );
      }
      try {
        verifyMigration21SchemaAuthority(options.db);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new McpAuthorityError('MCP_CONFIGURATION_INVALID', `Database schema verification failed: ${msg}`);
      }

      this.db = options.db;
      const repo = new Repository(this.db);
      this.service = new McpSessionAuthorityService(repo, this.db);
    }
  }

  public getSessionToken(): string | undefined {
    return this.configuredSessionToken ?? process.env.AGENTFORGE_MCP_SESSION_TOKEN;
  }

  public getDbPath(): string | undefined {
    return this.configuredDbPath ?? process.env.AGENTFORGE_MCP_DB_PATH;
  }

  /**
   * Initializes or returns the existing read-only, query-only database connection.
   */
  public getOrCreateDatabase(): { db: Database.Database; service: McpSessionAuthorityService } {
    if (this.db && this.service) {
      return { db: this.db, service: this.service };
    }

    const dbPath = this.getDbPath();
    if (!dbPath || typeof dbPath !== 'string' || dbPath.trim().length === 0) {
      throw new McpAuthorityError('MCP_CONFIGURATION_INVALID', 'Missing AGENTFORGE_MCP_DB_PATH environment variable');
    }

    const trimmedPath = dbPath.trim();
    if (!fs.existsSync(trimmedPath)) {
      throw new McpAuthorityError('MCP_CONFIGURATION_INVALID', `Database file does not exist at "${trimmedPath}"`);
    }

    let db: Database.Database;
    try {
      db = new Database(trimmedPath, { readonly: true, fileMustExist: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new McpAuthorityError('MCP_CONFIGURATION_INVALID', `Failed to open database: ${msg}`);
    }

    try {
      db.pragma('query_only = ON');
    } catch (err) {
      db.close();
      const msg = err instanceof Error ? err.message : String(err);
      throw new McpAuthorityError('MCP_CONFIGURATION_INVALID', `Failed to set query_only pragma: ${msg}`);
    }

    // Verify exact Migration 21 ledger and schema authority
    try {
      verifyMigration21SchemaAuthority(db);
    } catch (err) {
      db.close();
      const msg = err instanceof Error ? err.message : String(err);
      throw new McpAuthorityError('MCP_CONFIGURATION_INVALID', `Database schema verification failed: ${msg}`);
    }

    const repo = new Repository(db);
    const service = new McpSessionAuthorityService(repo, db);

    this.db = db;
    this.service = service;

    return { db, service };
  }

  /**
   * Resolves the authorized context using the configured session token and database.
   * Token is passed canonically without trimming or normalization.
   */
  public resolveAuthorizedContext(): AuthorizedContextResponse {
    const sessionToken = this.getSessionToken();
    const { service } = this.getOrCreateDatabase();
    return service.resolveAuthorizedContext(sessionToken);
  }

  /**
   * Safely closes the database handle. Observable diagnostic on failure.
   */
  public close(): void {
    if (this.db) {
      const dbToClose = this.db;
      this.db = null;
      this.service = null;
      try {
        if (dbToClose.open) {
          dbToClose.close();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[agentforge-mcp-context] Failed to close database: ${msg}\n`);
        throw err;
      }
    }
  }
}

let defaultContextInstance: McpAuthorityContext | null = null;

export function getDefaultAuthorityContext(): McpAuthorityContext {
  if (!defaultContextInstance) {
    defaultContextInstance = new McpAuthorityContext();
  }
  return defaultContextInstance;
}

export function resetDefaultAuthorityContext(): void {
  if (defaultContextInstance) {
    defaultContextInstance.close();
    defaultContextInstance = null;
  }
}
