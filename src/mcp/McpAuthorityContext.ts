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
  private unauthorizedMutationDetected = false;

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
      const fkState = options.db.pragma('foreign_keys', { simple: true }) as number;
      if (fkState !== 1) {
        throw new McpAuthorityError(
          'MCP_CONFIGURATION_INVALID',
          'Database connection must have PRAGMA foreign_keys = ON'
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

    try {
      db.pragma('foreign_keys = ON');
    } catch {
      db.close();
      throw new McpAuthorityError('MCP_CONFIGURATION_INVALID', 'Failed to set foreign_keys pragma');
    }

    const fkState = db.pragma('foreign_keys', { simple: true }) as number;
    if (fkState !== 1) {
      db.close();
      throw new McpAuthorityError('MCP_CONFIGURATION_INVALID', 'Failed to verify foreign_keys pragma');
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

  private getRuntimeTotalChanges(db: Database.Database): number {
    try {
      const row = db.prepare('SELECT total_changes() AS total_changes').get() as { total_changes?: unknown } | undefined;
      if (
        !row ||
        typeof row.total_changes !== 'number' ||
        !Number.isFinite(row.total_changes) ||
        row.total_changes < 0 ||
        !Number.isInteger(row.total_changes)
      ) {
        throw new McpAuthorityError('MCP_CONFIGURATION_INVALID', 'Failed to read total_changes');
      }
      return row.total_changes;
    } catch (err) {
      if (err instanceof McpAuthorityError) {
        throw err;
      }
      throw new McpAuthorityError('MCP_CONFIGURATION_INVALID', 'Failed to read total_changes');
    }
  }

  /**
   * Resolves the authorized context using the configured session token and database.
   * Session token is strictly validated before touching or opening the database.
   * Connection-local mutations are strictly fenced using SELECT total_changes().
   */
  public resolveAuthorizedContext(): AuthorizedContextResponse {
    if (this.unauthorizedMutationDetected) {
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Database mutation detected during context read');
    }

    const sessionToken = this.getSessionToken();
    const validatedToken = validateCanonicalSessionToken(sessionToken);
    const { db, service } = this.getOrCreateDatabase();

    const changesBefore = this.getRuntimeTotalChanges(db);
    let serviceErr: unknown = null;
    let response: AuthorizedContextResponse | null = null;

    try {
      response = service.resolveAuthorizedContext(validatedToken);
    } catch (err) {
      serviceErr = err;
    }

    let changesAfter: number;
    try {
      changesAfter = this.getRuntimeTotalChanges(db);
    } catch {
      this.unauthorizedMutationDetected = true;
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Database mutation verification failed');
    }

    if (changesBefore !== changesAfter) {
      this.unauthorizedMutationDetected = true;
      throw new McpAuthorityError('MCP_AUTHORITY_FENCED', 'Database mutation detected during context read');
    }

    if (serviceErr) {
      throw serviceErr;
    }

    return response!;
  }

  public hasDetectedUnauthorizedMutation(): boolean {
    return this.unauthorizedMutationDetected;
  }

  /**
   * Safely closes the database handle with bounded retry for Windows file locks.
   * Observable diagnostic on failure without leaking details.
   * Retains database and service references on failure for subsequent retry.
   */
  public close(): void {
    if (!this.db) {
      return;
    }

    if (!this.db.open) {
      this.db = null;
      this.service = null;
      return;
    }

    const maxRetries = 5;
    const retryDelayMs = 25;
    let closedSuccessfully = false;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (this.db.open) {
          this.db.close();
        }
        closedSuccessfully = true;
        break;
      } catch {
        if (attempt < maxRetries - 1) {
          try {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryDelayMs);
          } catch {
            // fallback if SharedArrayBuffer unavailable
          }
        }
      }
    }

    if (closedSuccessfully || !this.db.open) {
      this.db = null;
      this.service = null;
      return;
    }

    process.stderr.write('[agentforge-mcp-context] Database close failed: MCP_CLEANUP_FAILED\n');
    throw new McpAuthorityError('MCP_CLEANUP_FAILED', 'Database close failed');
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
