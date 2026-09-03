import fs from 'fs';
import Database from 'better-sqlite3';
import { Repository } from '../core/database/repositories';
import {
  McpSessionAuthorityService,
  McpAuthorityError,
  validateCanonicalSessionToken,
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
      } catch {
        throw new McpAuthorityError('MCP_CONFIGURATION_INVALID', 'Database schema authority verification failed');
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
      throw new McpAuthorityError('MCP_CONFIGURATION_INVALID', 'Missing database path configuration');
    }

    const trimmedPath = dbPath.trim();
    if (!fs.existsSync(trimmedPath)) {
      throw new McpAuthorityError('MCP_CONFIGURATION_INVALID', 'Database file does not exist');
    }

    let db: Database.Database;
    try {
      db = new Database(trimmedPath, { readonly: true, fileMustExist: true });
    } catch {
      throw new McpAuthorityError('MCP_CONFIGURATION_INVALID', 'Failed to open database');
    }

    try {
      db.pragma('query_only = ON');
    } catch {
      db.close();
      throw new McpAuthorityError('MCP_CONFIGURATION_INVALID', 'Failed to set query_only pragma');
    }

    const queryOnly = db.pragma('query_only', { simple: true }) as number;
    if (queryOnly !== 1) {
      db.close();
      throw new McpAuthorityError('MCP_CONFIGURATION_INVALID', 'Failed to verify query_only pragma');
    }

    // Verify exact Migration 21 ledger and schema authority
    try {
      verifyMigration21SchemaAuthority(db);
    } catch {
      db.close();
      throw new McpAuthorityError('MCP_CONFIGURATION_INVALID', 'Database schema authority verification failed');
    }

    const repo = new Repository(db);
    const service = new McpSessionAuthorityService(repo, db);

    this.db = db;
    this.service = service;

    return { db, service };
  }

  /**
   * Resolves the authorized context using the configured session token and database.
   * Session token is strictly validated before touching or opening the database.
   */
  public resolveAuthorizedContext(): AuthorizedContextResponse {
    const sessionToken = this.getSessionToken();
    const validatedToken = validateCanonicalSessionToken(sessionToken);
    const { db, service } = this.getOrCreateDatabase();

    const changesBefore = db.pragma('total_changes', { simple: true }) as number;
    const response = service.resolveAuthorizedContext(validatedToken);
    const changesAfter = db.pragma('total_changes', { simple: true }) as number;

    if (changesBefore !== changesAfter) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Database mutation detected during context read');
    }

    return response;
  }

  /**
   * Safely closes the database handle. Observable diagnostic on failure without leaking details.
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
        process.stderr.write('[agentforge-mcp-context] Database close failed: MCP_INTERNAL_ERROR\n');
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
