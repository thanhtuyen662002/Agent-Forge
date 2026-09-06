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
import {
  generateClientConfig,
  generateClientConfigEnvelope,
} from './clientBridge';

export interface CliArgs {
  command: 'issue' | 'revoke' | 'configure-client' | 'help';
  client?: string;
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

  // 2. Parse flags and positionals
  let command: 'issue' | 'revoke' | 'configure-client' | null = null;
  let client: string | undefined;
  let rawCliDbPath: string | undefined;
  let authorizationId: string | undefined;
  let sessionId: string | undefined;
  let ttlSeconds: number | undefined;
  let jsonOutput = false;

  const seenFlags = new Set<string>();
  const positional: string[] = [];

  const isConfigureClient = args.some(
    (a) => a.toLowerCase() === 'configure-client'
  );

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('-')) {
      if (isConfigureClient) {
        if (arg === '--auth' || arg === '-a') {
          throw new Error('Flag --auth is not valid for configure-client command');
        }
        if (arg === '--session' || arg === '-s') {
          throw new Error('Flag --session is not valid for configure-client command');
        }
        if (arg === '--ttl' || arg === '-t') {
          throw new Error('Flag --ttl is not valid for configure-client command');
        }
        if (arg === '-c' || arg === '-d' || arg === '-j') {
          throw new Error(`Short flag ${arg} is not supported for configure-client command`);
        }
        // Closed grammar for configure-client: only --client, --db, and --json permitted
        if (arg !== '--client' && arg !== '--db' && arg !== '--json') {
          throw new Error('Unknown flag');
        }
      }

      const normalizedFlag =
        arg === '-d' ? '--db'
        : arg === '-a' ? '--auth'
        : arg === '-s' ? '--session'
        : arg === '-t' ? '--ttl'
        : arg === '-c' ? '--client'
        : arg;

      if (seenFlags.has(normalizedFlag)) {
        throw new Error('Duplicate flag');
      }
      seenFlags.add(normalizedFlag);

      if (arg === '--json') {
        jsonOutput = true;
      } else if (arg === '--client' || (!isConfigureClient && arg === '-c')) {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new Error('Missing value for flag');
        const val = args[++i];
        if (val.trim().length === 0) throw new Error('Flag cannot be whitespace-only');
        client = val.trim();
      } else if (arg === '--db' || (!isConfigureClient && arg === '-d')) {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new Error('Missing value for flag');
        const val = args[++i];
        if (val.trim().length === 0) throw new Error('Flag cannot be whitespace-only');
        rawCliDbPath = val.trim();
      } else if (arg === '--auth' || arg === '-a') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new Error('Missing value for flag');
        const val = args[++i];
        if (val.trim().length === 0) throw new Error('Flag cannot be whitespace-only');
        authorizationId = val.trim();
      } else if (arg === '--session' || arg === '-s') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new Error('Missing value for flag');
        const val = args[++i];
        if (val.trim().length === 0) throw new Error('Flag cannot be whitespace-only');
        sessionId = val.trim();
      } else if (arg === '--ttl' || arg === '-t') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new Error('Missing value for flag');
        const val = args[++i];
        if (val.trim().length === 0) throw new Error('Flag cannot be whitespace-only');
        ttlSeconds = validateTtlSeconds(val);
      } else {
        throw new Error('Unknown flag');
      }
    } else {
      positional.push(arg);
    }
  }

  if (positional.length === 0) {
    throw new Error('Missing command (expected "issue", "revoke", or "configure-client")');
  }

  const rawCmd = positional[0].toLowerCase();
  if (rawCmd === 'issue' || rawCmd === 'revoke' || rawCmd === 'configure-client') {
    command = rawCmd;
  } else {
    throw new Error('Unknown command');
  }

  if (positional.length > 1) {
    throw new Error('Surplus positional argument');
  }

  // 3. Command-specific closed grammar validation
  let dbPath: string | undefined;

  if (command === 'configure-client') {
    if (authorizationId !== undefined || seenFlags.has('--auth')) {
      throw new Error('Flag --auth is not valid for configure-client command');
    }
    if (sessionId !== undefined || seenFlags.has('--session')) {
      throw new Error('Flag --session is not valid for configure-client command');
    }
    if (ttlSeconds !== undefined || seenFlags.has('--ttl')) {
      throw new Error('Flag --ttl is not valid for configure-client command');
    }
    if (!client) {
      throw new Error('Configure-client requires --client <antigravity|cursor|claude>');
    }
    dbPath = rawCliDbPath;
  } else if (command === 'issue') {
    if (client !== undefined || seenFlags.has('--client')) {
      throw new Error('Flag --client is not valid for issue command');
    }
    if (sessionId) {
      throw new Error('Flag --session is not valid for issue command');
    }
    if (!authorizationId) {
      throw new Error('Issue command requires --auth <authorization-id>');
    }
    dbPath = rawCliDbPath ?? process.env.AGENTFORGE_MCP_DB_PATH;
    if (!dbPath) {
      throw new Error('Issue command requires --db <database-path>');
    }
  } else if (command === 'revoke') {
    if (client !== undefined || seenFlags.has('--client')) {
      throw new Error('Flag --client is not valid for revoke command');
    }
    if (ttlSeconds !== undefined || seenFlags.has('--ttl')) {
      throw new Error('Flag --ttl is not valid for revoke command');
    }
    const hasSession = Boolean(sessionId);
    const hasAuth = Boolean(authorizationId);
    if ((hasSession && hasAuth) || (!hasSession && !hasAuth)) {
      throw new Error('Revoke requires exactly one selector: --session XOR --auth');
    }
    dbPath = rawCliDbPath ?? process.env.AGENTFORGE_MCP_DB_PATH;
    if (!dbPath) {
      throw new Error('Revoke command requires --db <database-path>');
    }
  }

  return {
    command: command!,
    client,
    dbPath,
    authorizationId,
    sessionId,
    ttlSeconds,
    jsonOutput,
  };
}

export function getCanonicalAdminErrorMessage(category: string): string {
  switch (category) {
    case 'MCP_CONFIGURATION_INVALID':
      return 'Invalid configuration or CLI arguments';
    case 'MCP_AUTHORITY_FENCED':
      return 'Authority verification failed';
    case 'MCP_SESSION_UNAUTHORIZED':
      return 'Session authentication failed';
    case 'MCP_CONTEXT_INTEGRITY_FAILED':
      return 'Authority integrity verification failed';
    case 'MCP_CLEANUP_FAILED':
      return 'Database cleanup failed';
    default:
      return 'Internal error occurred';
  }
}

export function runSessionAdmin(
  args: string[],
  testOverrides?: { executablePath?: string; stdioScriptPath?: string }
): number {
  const isConfigureClient = args.some(
    (a) => a.toLowerCase() === 'configure-client'
  );

  let options: CliArgs;
  try {
    options = parseCliArgs(args);
  } catch (err) {
    if (isConfigureClient) {
      process.stderr.write(
        'ERROR: [MCP_CONFIGURATION_INVALID] Invalid configuration or CLI arguments\n'
      );
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`ERROR: [MCP_CONFIGURATION_INVALID] ${msg}\n`);
    }
    return 1;
  }

  if (options.command === 'help') {
    const usage = `
AgentForge MCP Session Administration CLI

Usage:
  node sessionAdmin.js configure-client --client <antigravity|cursor|claude> [--db <db-path>] [--json]
  node sessionAdmin.js issue --db <db-path> --auth <auth-id> [--ttl <seconds>] [--json]
  node sessionAdmin.js revoke --db <db-path> (--session <session-id> | --auth <auth-id>) [--json]
`;
    process.stdout.write(usage);
    return 0;
  }

  if (options.command === 'configure-client') {
    try {
      if (options.jsonOutput) {
        const envelope = generateClientConfigEnvelope({
          client: options.client!,
          dbPath: options.dbPath,
          executablePath: testOverrides?.executablePath,
          stdioScriptPath: testOverrides?.stdioScriptPath,
        });
        process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
      } else {
        const template = generateClientConfig({
          client: options.client!,
          dbPath: options.dbPath,
          executablePath: testOverrides?.executablePath,
          stdioScriptPath: testOverrides?.stdioScriptPath,
        });
        process.stdout.write(JSON.stringify(template, null, 2) + '\n');
      }
      return 0;
    } catch {
      process.stderr.write('ERROR: [MCP_CONFIGURATION_INVALID] Invalid configuration or CLI arguments\n');
      return 1;
    }
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
      process.stderr.write(`ERROR: [${error.category}] ${getCanonicalAdminErrorMessage(error.category)}\n`);
    } else {
      process.stderr.write('ERROR: [MCP_AUTHORITY_FENCED] Authority verification failed\n');
    }
    return 1;
  } finally {
    if (db) {
      try {
        if (db.open) {
          db.close();
        }
      } catch {
        process.stderr.write('ERROR: [MCP_CLEANUP_FAILED] Database cleanup failed\n');
        return 1;
      }
    }
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  const exitCode = runSessionAdmin(process.argv.slice(2));
  process.exit(exitCode);
}
