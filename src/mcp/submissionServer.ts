import fs from 'fs';
import Database from 'better-sqlite3';
import { McpServer, fromJsonSchema, ResourceTemplate } from '@modelcontextprotocol/server';
import { Repository } from '../core/database/repositories';
import { verifyMigration22SchemaAuthority } from '../core/database/migrations';
import {
  CODER_SUBMISSION_INPUT_JSON_SCHEMA,
  CODER_SUBMISSION_STATUS_INPUT_JSON_SCHEMA,
  SUBMISSION_STATUS_TOOL_NAME,
  SUBMISSION_STATUS_TOOL_DESCRIPTION,
  SUBMISSION_STATUS_TOOL_ANNOTATIONS,
  SUBMISSION_STATUS_RESOURCE_NAME,
  SUBMISSION_STATUS_URI_TEMPLATE,
  SUBMISSION_STATUS_MIME_TYPE,
  SubmissionResult,
  SubmissionStatusResult,
  canonicalJsonStringify,
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

  server.registerTool(
    SUBMISSION_STATUS_TOOL_NAME,
    {
      description: SUBMISSION_STATUS_TOOL_DESCRIPTION,
      inputSchema: fromJsonSchema(CODER_SUBMISSION_STATUS_INPUT_JSON_SCHEMA as any),
      annotations: SUBMISSION_STATUS_TOOL_ANNOTATIONS,
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
            ok: false,
            error_code: 'INVALID_SUBMISSION_TOKEN',
            message,
            retryable: false,
          },
        };
      }

      const token = context.getSubmissionToken();
      const result: SubmissionStatusResult = service.getSubmissionStatus(rawArgs, token);

      const explanation = result.ok
        ? `[${result.lifecycle_status}] Submission ${result.submission_id}: lifecycle=${result.lifecycle_status}, terminal=${result.terminal_outcome ?? 'none'}, task_state=${result.task_state}.`
        : `[${result.error_code}] ${result.message}`;

      const response: Record<string, unknown> = {
        content: [
          {
            type: 'text' as const,
            text: explanation,
          },
        ],
        structuredContent: result,
        isError: !result.ok,
      };

      return response as any;
    }
  );

  const statusResourceTemplate = new ResourceTemplate(
    SUBMISSION_STATUS_URI_TEMPLATE,
    { list: undefined }
  );

  server.registerResource(
    SUBMISSION_STATUS_RESOURCE_NAME,
    statusResourceTemplate,
    {
      description: 'Observe quarantined coder submission lifecycle and sanitized verification feedback.',
      mimeType: SUBMISSION_STATUS_MIME_TYPE,
    },
    async (uri, vars) => {
      let service: McpSubmissionAuthorityService;
      const uriString = typeof uri === 'string' ? uri : (uri as { href: string }).href;
      try {
        service = context.getOrCreateService();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'MCP configuration invalid';
        const failObj: SubmissionStatusResult = {
          ok: false,
          error_code: 'INVALID_SUBMISSION_TOKEN',
          message,
          retryable: false,
        };
        return {
          contents: [
            {
              uri: uriString,
              mimeType: SUBMISSION_STATUS_MIME_TYPE,
              text: canonicalJsonStringify(failObj),
            },
          ],
        };
      }

      const token = context.getSubmissionToken();
      const submissionId = typeof vars.submission_id === 'string' ? vars.submission_id : String(vars.submission_id ?? '');
      const rawArgs = { submission_id: submissionId };
      const result: SubmissionStatusResult = service.getSubmissionStatus(rawArgs, token);

      return {
        contents: [
          {
            uri: uriString,
            mimeType: SUBMISSION_STATUS_MIME_TYPE,
            text: canonicalJsonStringify(result),
          },
        ],
      };
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
