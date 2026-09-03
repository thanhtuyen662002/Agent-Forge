import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { Repository } from '../core/database/repositories';
import {
  McpSessionAuthorityService,
  McpAuthorityError,
  validateTtlSeconds,
} from '../core/services/McpSessionAuthorityService';
import { verifyMigration21SchemaAuthority } from '../core/database/migrations';

export interface CliArgs {
  command: 'issue' | 'revoke' | 'help';
  dbPath?: string;
  authorizationId?: string;
  sessionId?: string;
  ttlSeconds?: number;
  jsonOutput: boolean;
}

export function parseCliArgs(args: string[]): CliArgs {
  let command: 'issue' | 'revoke' | 'help' | null = null;
  let dbPath: string | undefined = process.env.AGENTFORGE_MCP_DB_PATH;
  let authorizationId: string | undefined;
  let sessionId: string | undefined;
  let ttlSeconds: number | undefined;
  let jsonOutput = false;

  const seenFlags = new Set<string>();
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      return { command: 'help', jsonOutput: false };
    }

    if (arg.startsWith('-')) {
      // Flag handling
      const normalizedFlag = arg === '-d' ? '--db'
        : arg === '-a' ? '--auth'
        : arg === '-s' ? '--session'
        : arg === '-t' ? '--ttl'
        : arg;

      if (seenFlags.has(normalizedFlag)) {
        throw new Error(`Duplicate flag "${arg}"`);
      }
      seenFlags.add(normalizedFlag);

      if (arg === '--json') {
        jsonOutput = true;
      } else if (arg === '--db' || arg === '-d') {
        const val = args[++i];
        if (!val || val.startsWith('-')) throw new Error(`Missing value for flag "${arg}"`);
        dbPath = val;
      } else if (arg === '--auth' || arg === '-a') {
        const val = args[++i];
        if (!val || val.startsWith('-')) throw new Error(`Missing value for flag "${arg}"`);
        authorizationId = val;
      } else if (arg === '--session' || arg === '-s') {
        const val = args[++i];
        if (!val || val.startsWith('-')) throw new Error(`Missing value for flag "${arg}"`);
        sessionId = val;
      } else if (arg === '--ttl' || arg === '-t') {
        const val = args[++i];
        if (!val || val.startsWith('-')) throw new Error(`Missing value for flag "${arg}"`);
        ttlSeconds = validateTtlSeconds(val);
      } else {
        throw new Error(`Unknown flag "${arg}"`);
      }
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 0) {
    const cmd = positional[0].toLowerCase();
    if (cmd === 'issue' || cmd === 'revoke' || cmd === 'help') {
      command = cmd;
    } else {
      throw new Error(`Unknown command "${positional[0]}"`);
    }

    if (positional.length > 1) {
      throw new Error(`Surplus positional argument "${positional[1]}"`);
    }
  }

  if (!command) {
    command = 'help';
  }

  if (command === 'revoke') {
    const hasSession = Boolean(sessionId);
    const hasAuth = Boolean(authorizationId);
    if ((hasSession && hasAuth) || (!hasSession && !hasAuth)) {
      throw new Error('Revoke requires exactly one selector: --session XOR --auth');
    }
  }

  if (command === 'issue') {
    if (sessionId) {
      throw new Error('Flag --session is not valid for issue command');
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
  let options: CliArgs;
  try {
    options = parseCliArgs(rawArgs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ERROR: ${msg}\n`);
    return 1;
  }

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
    process.stderr.write('ERROR: Missing required --db path or AGENTFORGE_MCP_DB_PATH environment variable\n');
    return 1;
  }

  const resolvedDbPath = path.resolve(options.dbPath.trim());
  if (!fs.existsSync(resolvedDbPath)) {
    process.stderr.write(`ERROR: Database file does not exist at "${resolvedDbPath}"\n`);
    return 1;
  }

  let db: Database.Database;
  try {
    db = new Database(resolvedDbPath, { fileMustExist: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ERROR: Failed to open database: ${msg}\n`);
    return 1;
  }

  try {
    // 1. Enable and verify PRAGMA foreign_keys = ON
    db.pragma('foreign_keys = ON');
    const fkState = db.pragma('foreign_keys', { simple: true }) as number;
    if (fkState !== 1) {
      process.stderr.write('ERROR: Failed to enable foreign_keys pragma on database connection\n');
      return 1;
    }

    // 2. Shared schema-authority verifier (fails closed on missing ledger or malformed schema)
    try {
      verifyMigration21SchemaAuthority(db);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`ERROR: Database schema authority check failed: ${msg}\n`);
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
    const msg = error instanceof McpAuthorityError ? error.rawMessage : error instanceof Error ? error.message : String(error);
    process.stderr.write(`ERROR: ${msg}\n`);
    return 1;
  } finally {
    try {
      if (db.open) {
        db.close();
      }
    } catch {
      // Ignore cleanup error during shutdown
    }
  }
}

if (require.main === module) {
  const exitCode = runSessionAdmin(process.argv.slice(2));
  process.exit(exitCode);
}
