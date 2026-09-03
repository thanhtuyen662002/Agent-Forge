import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { Repository } from '../core/database/repositories';
import {
  McpSessionAuthorityService,
  McpAuthorityError,
} from '../core/services/McpSessionAuthorityService';

export interface CliArgs {
  command: 'issue' | 'revoke' | 'help';
  dbPath?: string;
  authorizationId?: string;
  sessionId?: string;
  ttlSeconds?: number;
  jsonOutput: boolean;
}

export function parseCliArgs(args: string[]): CliArgs {
  let command: 'issue' | 'revoke' | 'help' = 'help';
  let dbPath: string | undefined = process.env.AGENTFORGE_MCP_DB_PATH;
  let authorizationId: string | undefined;
  let sessionId: string | undefined;
  let ttlSeconds: number | undefined;
  let jsonOutput = false;

  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      jsonOutput = true;
    } else if (arg === '--db' || arg === '-d') {
      dbPath = args[++i];
    } else if (arg === '--auth' || arg === '-a') {
      authorizationId = args[++i];
    } else if (arg === '--session' || arg === '-s') {
      sessionId = args[++i];
    } else if (arg === '--ttl' || arg === '-t') {
      const parsed = parseInt(args[++i], 10);
      if (!Number.isNaN(parsed)) {
        ttlSeconds = parsed;
      }
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (positional.length > 0) {
    const cmd = positional[0].toLowerCase();
    if (cmd === 'issue' || cmd === 'revoke' || cmd === 'help') {
      command = cmd;
    }
  }

  return {
    command,
    dbPath,
    authorizationId,
    sessionId,
    ttlSeconds,
    jsonOutput,
  };
}

export function runSessionAdmin(rawArgs: string[]): number {
  const options = parseCliArgs(rawArgs);

  if (options.command === 'help') {
    const usage = `
AgentForge MCP Session Administration CLI

Usage:
  node sessionAdmin.js issue --db <db-path> --auth <auth-id> [--ttl <seconds>] [--json]
  node sessionAdmin.js revoke --db <db-path> (--session <session-id> | --auth <auth-id>) [--json]
`;
    process.stdout.write(usage);
    return 0;
  }

  if (!options.dbPath || typeof options.dbPath !== 'string' || options.dbPath.trim().length === 0) {
    const err = 'ERROR: Missing required --db path or AGENTFORGE_MCP_DB_PATH environment variable\n';
    process.stderr.write(err);
    return 1;
  }

  const resolvedDbPath = path.resolve(options.dbPath.trim());
  if (!fs.existsSync(resolvedDbPath)) {
    const err = `ERROR: Database file does not exist at "${resolvedDbPath}"\n`;
    process.stderr.write(err);
    return 1;
  }

  let db: Database.Database;
  try {
    // Open existing database without auto-creating
    db = new Database(resolvedDbPath, { fileMustExist: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ERROR: Failed to open database: ${msg}\n`);
    return 1;
  }

  try {
    // Fail if Migration 21 is absent - never auto-migrate
    const migrationCheck = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mcp_client_sessions'")
      .get();
    if (!migrationCheck) {
      process.stderr.write('ERROR: Database is missing Migration 21 (table mcp_client_sessions does not exist)\n');
      return 1;
    }

    const repo = new Repository(db);
    const service = new McpSessionAuthorityService(repo, db);

    if (options.command === 'issue') {
      if (!options.authorizationId) {
        process.stderr.write('ERROR: Missing required --auth <authorization-id> argument for issue\n');
        return 1;
      }

      const result = service.issueSession({
        authorizationId: options.authorizationId,
        ttlSeconds: options.ttlSeconds,
      });

      if (options.jsonOutput) {
        const output = {
          status: 'ISSUED',
          session: {
            id: result.session.id,
            authorization_id: result.session.authorization_id,
            scope: result.session.scope,
            issued_at: result.session.issued_at,
            expires_at: result.session.expires_at,
          },
          plaintext_token: result.plaintextToken,
        };
        process.stdout.write(JSON.stringify(output, null, 2) + '\n');
      } else {
        process.stdout.write(`Session issued successfully:\n`);
        process.stdout.write(`  Session ID:       ${result.session.id}\n`);
        process.stdout.write(`  Authorization ID: ${result.session.authorization_id}\n`);
        process.stdout.write(`  Scope:            ${result.session.scope}\n`);
        process.stdout.write(`  Issued At:        ${result.session.issued_at}\n`);
        process.stdout.write(`  Expires At:       ${result.session.expires_at}\n`);
        process.stdout.write(`  Plaintext Token:  ${result.plaintextToken}\n`);
      }
      return 0;
    }

    if (options.command === 'revoke') {
      if (!options.sessionId && !options.authorizationId) {
        process.stderr.write('ERROR: Revoke requires either --session <session-id> or --auth <auth-id>\n');
        return 1;
      }

      const result = service.revokeSession({
        sessionId: options.sessionId,
        authorizationId: options.authorizationId,
      });

      if (options.jsonOutput) {
        const output = {
          status: 'REVOKED',
          revoked: result.revoked,
        };
        process.stdout.write(JSON.stringify(output, null, 2) + '\n');
      } else {
        process.stdout.write(`Session revoked (changed: ${result.revoked})\n`);
      }
      return 0;
    }

    return 1;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ERROR: ${msg}\n`);
    return 1;
  } finally {
    try {
      if (db.open) {
        db.close();
      }
    } catch {
      // Ignore cleanup error
    }
  }
}

if (require.main === module) {
  const exitCode = runSessionAdmin(process.argv.slice(2));
  process.exit(exitCode);
}
