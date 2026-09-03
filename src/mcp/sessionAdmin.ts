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
  // 1. Help must be a sole canonical invocation
  const hasHelpFlag = args.includes('--help') || args.includes('-h') || args.includes('help');
  if (hasHelpFlag) {
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h' || args[0] === 'help')) {
      return { command: 'help', jsonOutput: false };
    }
    throw new Error('Help flag cannot be combined with other arguments or commands');
  }

  if (args.length === 0) {
    return { command: 'help', jsonOutput: false };
  }

  // 2. First non-flag argument must be command (issue or revoke)
  let command: 'issue' | 'revoke' | null = null;
  let dbPath: string | undefined = process.env.AGENTFORGE_MCP_DB_PATH;
  let authorizationId: string | undefined;
  let sessionId: string | undefined;
  let ttlSeconds: number | undefined;
  let jsonOutput = false;

  const seenFlags = new Set<string>();
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('-')) {
      const normalizedFlag =
        arg === '-d' ? '--db'
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
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new Error(`Missing value for flag "${arg}"`);
        const val = args[++i];
        if (val.trim().length === 0) throw new Error(`Flag "${arg}" cannot be whitespace-only`);
        dbPath = val.trim();
      } else if (arg === '--auth' || arg === '-a') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new Error(`Missing value for flag "${arg}"`);
        const val = args[++i];
        if (val.trim().length === 0) throw new Error(`Flag "${arg}" cannot be whitespace-only`);
        authorizationId = val.trim();
      } else if (arg === '--session' || arg === '-s') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new Error(`Missing value for flag "${arg}"`);
        const val = args[++i];
        if (val.trim().length === 0) throw new Error(`Flag "${arg}" cannot be whitespace-only`);
        sessionId = val.trim();
      } else if (arg === '--ttl' || arg === '-t') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new Error(`Missing value for flag "${arg}"`);
        const val = args[++i];
        if (val.trim().length === 0) throw new Error(`Flag "${arg}" cannot be whitespace-only`);
        ttlSeconds = validateTtlSeconds(val);
      } else {
        throw new Error(`Unknown flag "${arg}"`);
      }
    } else {
      positional.push(arg);
    }
  }

  if (positional.length === 0) {
    throw new Error('Missing command (expected "issue" or "revoke")');
  }

  const rawCmd = positional[0].toLowerCase();
  if (rawCmd === 'issue' || rawCmd === 'revoke') {
    command = rawCmd;
  } else {
    throw new Error(`Unknown command "${positional[0]}"`);
  }

  if (positional.length > 1) {
    throw new Error(`Surplus positional argument "${positional[1]}"`);
  }

  // 3. Command-specific closed grammar validation
  if (command === 'issue') {
    if (sessionId) {
      throw new Error('Flag --session is not valid for issue command');
    }
    if (!authorizationId) {
      throw new Error('Issue command requires --auth <authorization-id>');
    }
    if (!dbPath) {
      throw new Error('Issue command requires --db <database-path>');
    }
  }

  if (command === 'revoke') {
    if (ttlSeconds !== undefined || seenFlags.has('--ttl')) {
      throw new Error('Flag --ttl is not valid for revoke command');
    }
    const hasSession = Boolean(sessionId);
    const hasAuth = Boolean(authorizationId);
    if ((hasSession && hasAuth) || (!hasSession && !hasAuth)) {
      throw new Error('Revoke requires exactly one selector: --session XOR --auth');
    }
    if (!dbPath) {
      throw new Error('Revoke command requires --db <database-path>');
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
    process.stderr.write(`ERROR: [MCP_CONFIGURATION_INVALID] ${msg}\n`);
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
    process.stderr.write('ERROR: [MCP_CONFIGURATION_INVALID] Missing required --db path\n');
    return 1;
  }

  const resolvedDbPath = path.resolve(options.dbPath.trim());
  if (!fs.existsSync(resolvedDbPath)) {
    process.stderr.write('ERROR: [MCP_CONFIGURATION_INVALID] Database file does not exist\n');
    return 1;
  }

  let db: Database.Database | null = null;
  try {
    try {
      db = new Database(resolvedDbPath, { fileMustExist: true });
    } catch {
      process.stderr.write('ERROR: [MCP_CONFIGURATION_INVALID] Failed to open database\n');
      return 1;
    }

    // 1. Enable and verify PRAGMA foreign_keys = ON
    db.pragma('foreign_keys = ON');
    const fkState = db.pragma('foreign_keys', { simple: true }) as number;
    if (fkState !== 1) {
      process.stderr.write('ERROR: [MCP_CONFIGURATION_INVALID] Failed to enable foreign keys\n');
      return 1;
    }

    // 2. Shared schema-authority verifier
    try {
      verifyMigration21SchemaAuthority(db);
    } catch {
      process.stderr.write('ERROR: [MCP_CONFIGURATION_INVALID] Database schema authority verification failed\n');
      return 1;
    }

    const repo = new Repository(db);
    const service = new McpSessionAuthorityService(repo, db);

    if (options.command === 'issue') {
      if (!options.authorizationId) {
        process.stderr.write('ERROR: [MCP_CONFIGURATION_INVALID] Missing required authorization ID\n');
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
    if (error instanceof McpAuthorityError) {
      process.stderr.write(`ERROR: [${error.category}] ${error.rawMessage}\n`);
    } else {
      process.stderr.write('ERROR: [MCP_AUTHORITY_FENCED] Administration operation failed\n');
    }
    return 1;
  } finally {
    if (db) {
      try {
        if (db.open) {
          db.close();
        }
      } catch {
        process.stderr.write('ERROR: [MCP_INTERNAL_ERROR] Database close failed\n');
        return 1;
      }
    }
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  const exitCode = runSessionAdmin(process.argv.slice(2));
  process.exit(exitCode);
}
