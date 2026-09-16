import fs from 'fs';
import Database from 'better-sqlite3';
import { McpServer, fromJsonSchema, ResourceTemplate } from '@modelcontextprotocol/server';
import { Repository } from '../core/database/repositories';
import { verifyMigration24SchemaAuthority } from '../core/database/migrations';
import {
  REVIEWER_SERVER_NAME,
  REVIEWER_SERVER_VERSION,
  REVIEWER_TOOL_NAME,
  REVIEWER_TOOL_DESCRIPTION,
  REVIEWER_TOOL_ANNOTATIONS,
  REVIEWER_TOOL_INPUT_SCHEMA,
  REVIEWER_RESOURCE_NAME,
  REVIEWER_RESOURCE_DESCRIPTION,
  REVIEWER_URI_TEMPLATE,
  REVIEWER_MIME_TYPE,
  validateReviewerToolArgs,
  validateReviewerResourceUri,
} from './reviewerProtocol';
import {
  ReviewerAuthorityService,
  scrubReviewerDiagnostics,
  ReviewerAuthorityError,
} from './reviewerAuthority';
import { REVIEWER_TOKEN_ENV } from '../types/reviewer';

export interface ReviewerServerContextOptions {
  dbPath?: string;
  reviewerToken?: string;
  db?: Database.Database;
  repo?: Repository;
  authorityService?: ReviewerAuthorityService;
}

export class ReviewerMcpAuthorityContext {
  private db: Database.Database | null = null;
  private repo: Repository | null = null;
  private authorityService: ReviewerAuthorityService | null = null;
  private ownsDb = false;

  constructor(private readonly options?: ReviewerServerContextOptions) {
    if (options?.authorityService) {
      this.authorityService = options.authorityService;
    }
    if (options?.db) {
      verifyMigration24SchemaAuthority(options.db);
      this.db = options.db;
      this.repo = options?.repo ?? new Repository(this.db);
      if (!this.authorityService) {
        this.authorityService = new ReviewerAuthorityService(this.repo);
      }
    }
  }

  public getReviewerToken(): string | undefined {
    return this.options?.reviewerToken ?? process.env[REVIEWER_TOKEN_ENV];
  }

  public getDbPath(): string | undefined {
    return this.options?.dbPath ?? process.env.AGENTFORGE_MCP_DB_PATH;
  }

  public getOrCreateAuthorityService(): ReviewerAuthorityService {
    if (this.authorityService) {
      return this.authorityService;
    }

    const dbPath = this.getDbPath();
    if (!dbPath || typeof dbPath !== 'string' || dbPath.trim().length === 0) {
      throw new ReviewerAuthorityError('CONFIG_ERROR', 'Missing database path configuration');
    }

    const trimmedPath = dbPath.trim();
    if (!fs.existsSync(trimmedPath)) {
      throw new ReviewerAuthorityError('CONFIG_ERROR', 'Database file does not exist');
    }

    let db: Database.Database;
    try {
      db = new Database(trimmedPath, { fileMustExist: true });
    } catch {
      throw new ReviewerAuthorityError('CONFIG_ERROR', 'Failed to open database');
    }

    try {
      db.pragma('foreign_keys = ON');
    } catch {
      db.close();
      throw new ReviewerAuthorityError('CONFIG_ERROR', 'Failed to set foreign_keys pragma');
    }

    verifyMigration24SchemaAuthority(db);

    this.db = db;
    this.ownsDb = true;
    this.repo = new Repository(db);
    this.authorityService = new ReviewerAuthorityService(this.repo);
    return this.authorityService;
  }

  public close(): void {
    if (this.ownsDb && this.db) {
      try {
        this.db.close();
      } catch {}
      this.db = null;
    }
  }
}

export function registerReviewerCapabilities(
  server: McpServer,
  context: ReviewerMcpAuthorityContext
): void {
  // Register strictly the single approved MCP tool: agentforge_get_review_package
  server.registerTool(
    REVIEWER_TOOL_NAME,
    {
      description: REVIEWER_TOOL_DESCRIPTION,
      inputSchema: fromJsonSchema(REVIEWER_TOOL_INPUT_SCHEMA as any),
      annotations: REVIEWER_TOOL_ANNOTATIONS,
    },
    async (rawArgs: unknown) => {
      let authorityService: ReviewerAuthorityService;
      try {
        authorityService = context.getOrCreateAuthorityService();
      } catch (err: unknown) {
        const message = scrubReviewerDiagnostics(err instanceof Error ? err.message : String(err));
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `[MCP_CONFIGURATION_INVALID] ${message}`,
            },
          ],
        };
      }

      const token = context.getReviewerToken();
      if (!token) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: '[AUTH_FAILED] Missing reviewer authentication token',
            },
          ],
        };
      }

      let validatedArgs: { adjudication_id: string };
      try {
        validatedArgs = validateReviewerToolArgs(rawArgs);
      } catch (err: unknown) {
        const message = scrubReviewerDiagnostics(err instanceof Error ? err.message : String(err));
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `[InvalidParams] ${message}`,
            },
          ],
        };
      }

      try {
        const session = authorityService.authenticateToken(token);
        const { projection_json } = authorityService.getReviewPackage(session, validatedArgs.adjudication_id);

        return {
          content: [
            {
              type: 'text' as const,
              text: projection_json,
            },
          ],
          isError: false,
        };
      } catch (err: unknown) {
        const code = err instanceof ReviewerAuthorityError ? err.code : 'INTERNAL_ERROR';
        const message = scrubReviewerDiagnostics(err instanceof Error ? err.message : String(err));
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `[${code}] ${message}`,
            },
          ],
        };
      }
    }
  );

  // Register strictly the single approved review package resource template
  const reviewPackageTemplate = new ResourceTemplate(
    REVIEWER_URI_TEMPLATE,
    { list: undefined }
  );

  server.registerResource(
    REVIEWER_RESOURCE_NAME,
    reviewPackageTemplate,
    {
      description: REVIEWER_RESOURCE_DESCRIPTION,
      mimeType: REVIEWER_MIME_TYPE,
    },
    async (uri, vars) => {
      const uriString = typeof uri === 'string' ? uri : (uri as { href: string }).href;

      let authorityService: ReviewerAuthorityService;
      try {
        authorityService = context.getOrCreateAuthorityService();
      } catch (err: unknown) {
        const message = scrubReviewerDiagnostics(err instanceof Error ? err.message : String(err));
        return {
          contents: [
            {
              uri: uriString,
              mimeType: REVIEWER_MIME_TYPE,
              text: JSON.stringify({ isError: true, error: `[MCP_CONFIGURATION_INVALID] ${message}` }),
            },
          ],
        };
      }

      const token = context.getReviewerToken();
      if (!token) {
        return {
          contents: [
            {
              uri: uriString,
              mimeType: REVIEWER_MIME_TYPE,
              text: JSON.stringify({ isError: true, error: '[AUTH_FAILED] Missing reviewer authentication token' }),
            },
          ],
        };
      }

      let adjudicationId: string;
      try {
        adjudicationId = validateReviewerResourceUri(uriString);
      } catch (err: unknown) {
        const message = scrubReviewerDiagnostics(err instanceof Error ? err.message : String(err));
        return {
          contents: [
            {
              uri: uriString,
              mimeType: REVIEWER_MIME_TYPE,
              text: JSON.stringify({ isError: true, error: `[InvalidParams] ${message}` }),
            },
          ],
        };
      }

      try {
        const session = authorityService.authenticateToken(token);
        const { projection_json } = authorityService.getReviewPackage(session, adjudicationId);

        return {
          contents: [
            {
              uri: uriString,
              mimeType: REVIEWER_MIME_TYPE,
              text: projection_json,
            },
          ],
        };
      } catch (err: unknown) {
        const code = err instanceof ReviewerAuthorityError ? err.code : 'INTERNAL_ERROR';
        const message = scrubReviewerDiagnostics(err instanceof Error ? err.message : String(err));
        return {
          contents: [
            {
              uri: uriString,
              mimeType: REVIEWER_MIME_TYPE,
              text: JSON.stringify({ isError: true, error: `[${code}] ${message}` }),
            },
          ],
        };
      }
    }
  );
}

export function buildAgentForgeReviewerMcpServer(
  options?: ReviewerServerContextOptions
): McpServer {
  const server = new McpServer({
    name: REVIEWER_SERVER_NAME,
    version: REVIEWER_SERVER_VERSION,
  });

  const context = new ReviewerMcpAuthorityContext(options);
  registerReviewerCapabilities(server, context);

  return server;
}

export function createReviewerMcpServer(
  options?: ReviewerServerContextOptions
): McpServer {
  return buildAgentForgeReviewerMcpServer(options);
}
