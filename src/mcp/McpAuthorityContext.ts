import fs from 'fs';
import Database from 'better-sqlite3';
import { Repository } from '../core/database/repositories';
import {
  McpSessionAuthorityService,
  McpAuthorityError,
} from '../core/services/McpSessionAuthorityService';
import { AuthorizedContextResponse, McpSessionErrorCode } from '../core/types/domain';

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

    // Verify Migration 21 exists
    try {
      const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mcp_client_sessions'").get();
      if (!row) {
        db.close();
        throw new McpAuthorityError('MCP_CONFIGURATION_INVALID', 'Database is missing Migration 21 (mcp_client_sessions table absent)');
      }
    } catch (err) {
      if (err instanceof McpAuthorityError) throw err;
      db.close();
      const msg = err instanceof Error ? err.message : String(err);
      throw new McpAuthorityError('MCP_CONFIGURATION_INVALID', `Database verification failed: ${msg}`);
    }

    const repo = new Repository(db);
    const service = new McpSessionAuthorityService(repo, db);

    this.db = db;
    this.service = service;

    return { db, service };
  }

  /**
   * Resolves the authorized context using the configured session token and database.
   */
  public resolveAuthorizedContext(): AuthorizedContextResponse {
    const sessionToken = this.getSessionToken();
    if (!sessionToken || sessionToken.trim().length === 0) {
      throw new McpAuthorityError('MCP_SESSION_REQUIRED', 'Missing AGENTFORGE_MCP_SESSION_TOKEN environment variable');
    }

    const { service } = this.getOrCreateDatabase();
    return service.resolveAuthorizedContext(sessionToken.trim());
  }

  /**
   * Safely closes the database handle.
   */
  public close(): void {
    if (this.db) {
      try {
        if (this.db.open) {
          this.db.close();
        }
      } catch {
        // Ignore close errors during teardown
      }
      this.db = null;
      this.service = null;
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
