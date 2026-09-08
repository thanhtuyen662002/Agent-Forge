import fs from 'fs';
import Database from 'better-sqlite3';
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { Repository } from '../core/database/repositories';
import { verifyMigration22SchemaAuthority } from '../core/database/migrations';
import {
  CODER_SUBMISSION_INPUT_JSON_SCHEMA,
  SubmissionResult,
} from './submissionProtocol';
import { McpSubmissionAuthorityService } from '../core/services/McpSubmissionAuthorityService';

export const SUBMISSION_SERVER_NAME = 'agentforge-submit';
export const SUBMISSION_SERVER_VERSION = '0.1.0';
export const SUBMISSION_TOOL_NAME = 'agentforge_submit_coder_claim';
export const SUBMISSION_TOOL_DESCRIPTION =
  'Submit an untrusted coder execution claim and report to AgentForge for quarantined evaluation.';

export const SUBMISSION_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

export interface SubmissionServerContextOptions {
  dbPath?: string;
  submissionToken?: string;
  db?: Database.Database;
  repo?: Repository;
  service?: McpSubmissionAuthorityService;
}

export class SubmissionMcpAuthorityContext {
  private db: Database.Database | null = null;
  private repo: Repository | null = null;
  private service: McpSubmissionAuthorityService | null = null;
  private ownsDb = false;

  constructor(private readonly options?: SubmissionServerContextOptions) {
    if (options?.service) {
      this.service = options.service;
    }
    if (options?.db) {
      this.db = options.db;
      this.repo = options?.repo ?? new Repository(this.db);
      if (!this.service) {
        this.service = new McpSubmissionAuthorityService(this.repo, this.db);
      }
    }
  }

  public getSubmissionToken(): string | undefined {
    return this.options?.submissionToken ?? process.env.AGENTFORGE_MCP_SUBMISSION_TOKEN;
  }

  public getDbPath(): string | undefined {
    return this.options?.dbPath ?? process.env.AGENTFORGE_MCP_DB_PATH;
  }

  public getOrCreateService(): McpSubmissionAuthorityService {
    if (this.service) {
      return this.service;
    }

    const dbPath = this.getDbPath();
    if (!dbPath || typeof dbPath !== 'string' || dbPath.trim().length === 0) {
      throw new Error('[MCP_CONFIGURATION_INVALID] Missing database path configuration');
    }

    const trimmedPath = dbPath.trim();
    if (!fs.existsSync(trimmedPath)) {
      throw new Error('[MCP_CONFIGURATION_INVALID] Database file does not exist');
    }

    let db: Database.Database;
    try {
      db = new Database(trimmedPath, { fileMustExist: true });
    } catch {
      throw new Error('[MCP_CONFIGURATION_INVALID] Failed to open database');
    }

    try {
      db.pragma('foreign_keys = ON');
    } catch {
      db.close();
      throw new Error('[MCP_CONFIGURATION_INVALID] Failed to set foreign_keys pragma');
    }

    const fkState = db.pragma('foreign_keys', { simple: true }) as number;
    if (fkState !== 1) {
      db.close();
      throw new Error('[MCP_CONFIGURATION_INVALID] Failed to verify foreign_keys pragma');
    }

    try {
      verifyMigration22SchemaAuthority(db);
    } catch (err) {
      db.close();
      throw new Error(`[MCP_CONFIGURATION_INVALID] Database schema authority verification failed: ${(err as Error).message}`);
    }

    this.db = db;
    this.ownsDb = true;
    this.repo = new Repository(this.db);
    this.service = new McpSubmissionAuthorityService(this.repo, this.db);
    return this.service;
  }

  public close(): void {
    if (this.ownsDb && this.db && this.db.open) {
      try {
        this.db.close();
      } finally {
        this.db = null;
        this.repo = null;
        this.service = null;
      }
    }
  }
}

export function registerSubmissionCapabilities(
  server: McpServer,
  context: SubmissionMcpAuthorityContext
): void {
  server.registerTool(
    SUBMISSION_TOOL_NAME,
    {
      description: SUBMISSION_TOOL_DESCRIPTION,
      inputSchema: fromJsonSchema(CODER_SUBMISSION_INPUT_JSON_SCHEMA as any),
      annotations: SUBMISSION_TOOL_ANNOTATIONS,
    },
    async (rawArgs: unknown) => {
      let service: McpSubmissionAuthorityService;
      try {
        service = context.getOrCreateService();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'MCP configuration invalid';
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `[MCP_CONFIGURATION_INVALID] ${message}`,
            },
          ],
          structuredContent: {
            accepted: false,
            error_code: 'INVALID_SUBMISSION_TOKEN',
            message,
            retryable: false,
          },
        };
      }

      const token = context.getSubmissionToken();
      const result: SubmissionResult = service.submitCoderClaim(rawArgs, token);

      const explanation = result.accepted
        ? `[QUARANTINED] Coder claim ${result.submission_id} accepted and quarantined. Duplicate: ${result.is_duplicate}. Envelope: ${result.canonical_envelope_hash}.`
        : `[${result.error_code}] ${result.message}`;

      const response: Record<string, unknown> = {
        content: [
          {
            type: 'text' as const,
            text: explanation,
          },
        ],
        structuredContent: result,
        isError: !result.accepted,
      };

      // Ensure structuredData is NEVER emitted per Section 2.7
      return response as any;
    }
  );
}

export function buildAgentForgeSubmissionMcpServer(
  options?: SubmissionServerContextOptions
): McpServer {
  const server = new McpServer({
    name: SUBMISSION_SERVER_NAME,
    version: SUBMISSION_SERVER_VERSION,
  });

  const context = new SubmissionMcpAuthorityContext(options);
  registerSubmissionCapabilities(server, context);

  return server;
}

export function createSubmissionMcpServer(
  options?: SubmissionServerContextOptions
): McpServer {
  return buildAgentForgeSubmissionMcpServer(options);
}
