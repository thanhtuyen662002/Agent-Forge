import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { Repository } from '../core/database/repositories';
import { verifyMigration22SchemaAuthority } from '../core/database/migrations';
import {
  generateSubmissionToken,
  computeSha256,
  computeAuthorityFingerprint,
} from './submissionProtocol';
import {
  generateSubmissionClientConfig,
  generateSubmissionClientConfigEnvelope,
} from './clientBridge';

export const SUBMISSION_SESSION_MIN_TTL_SECONDS = 60;
export const SUBMISSION_SESSION_DEFAULT_TTL_SECONDS = 3600;
export const SUBMISSION_SESSION_MAX_TTL_SECONDS = 86400;

export function validateSubmissionTtlSeconds(ttlValue: unknown): number {
  if (ttlValue === undefined || ttlValue === null) {
    return SUBMISSION_SESSION_DEFAULT_TTL_SECONDS;
  }
  const numericTtl = typeof ttlValue === 'string' ? Number(ttlValue) : Number(ttlValue);
  if (!Number.isInteger(numericTtl)) {
    throw new Error('TTL must be an integer number of seconds');
  }
  if (
    numericTtl < SUBMISSION_SESSION_MIN_TTL_SECONDS ||
    numericTtl > SUBMISSION_SESSION_MAX_TTL_SECONDS
  ) {
    throw new Error(
      `Session TTL ${numericTtl}s is out of authorized bounds [${SUBMISSION_SESSION_MIN_TTL_SECONDS}, ${SUBMISSION_SESSION_MAX_TTL_SECONDS}]`
    );
  }
  return numericTtl;
}

export interface SubmissionCliArgs {
  command: 'issue' | 'revoke' | 'configure-client' | 'help';
  client?: string;
  dbPath?: string;
  authorizationId?: string;
  sessionId?: string;
  reason?: string;
  ttlSeconds?: number;
  jsonOutput: boolean;
}

export function parseSubmissionCliArgs(args: string[]): SubmissionCliArgs {
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

  let command: 'issue' | 'revoke' | 'configure-client' | null = null;
  let client: string | undefined;
  let rawCliDbPath: string | undefined;
  let authorizationId: string | undefined;
  let sessionId: string | undefined;
  let reason: string | undefined;
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
      if (arg === '--token') {
        throw new Error('Flag --token is forbidden to protect credential secrecy');
      }

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
        if (arg !== '--client' && arg !== '--db' && arg !== '--json') {
          throw new Error(`Unknown flag "${arg}" for configure-client command`);
        }
      }

      const normalizedFlag =
        arg === '-d' ? '--db'
        : arg === '-a' ? '--auth'
        : arg === '-s' ? '--session'
        : arg === '-t' ? '--ttl'
        : arg === '-c' ? '--client'
        : arg === '-r' ? '--reason'
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
      } else if (arg === '--reason' || arg === '-r') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new Error('Missing value for flag');
        const val = args[++i];
        if (val.trim().length === 0) throw new Error('Flag cannot be whitespace-only');
        reason = val.trim();
      } else if (arg === '--ttl' || arg === '-t') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new Error('Missing value for flag');
        const val = args[++i];
        if (val.trim().length === 0) throw new Error('Flag cannot be whitespace-only');
        ttlSeconds = validateSubmissionTtlSeconds(val);
      } else {
        throw new Error(`Unknown flag "${arg}"`);
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
    if (reason !== undefined || seenFlags.has('--reason')) {
      throw new Error('Flag --reason is not valid for issue command');
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
    reason,
    ttlSeconds,
    jsonOutput,
  };
}

export function runSubmissionAdmin(
  args: string[],
  testOverrides?: { executablePath?: string; stdioScriptPath?: string }
): number {
  let options: SubmissionCliArgs;
  try {
    options = parseSubmissionCliArgs(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ERROR: [MCP_CONFIGURATION_INVALID] ${msg}\n`);
    return 1;
  }

  if (options.command === 'help') {
    const usage = `
AgentForge MCP Coder Submission Administration CLI

Usage:
  node submissionAdmin.js configure-client --client <antigravity|cursor|claude> [--db <db-path>] [--json]
  node submissionAdmin.js issue --db <db-path> --auth <auth-id> [--ttl <seconds>] [--json]
  node submissionAdmin.js revoke --db <db-path> (--session <session-id> | --auth <auth-id>) [--reason <reason>] [--json]
`;
    process.stdout.write(usage);
    return 0;
  }

  if (options.command === 'configure-client') {
    try {
      if (options.jsonOutput) {
        const envelope = generateSubmissionClientConfigEnvelope({
          client: options.client!,
          dbPath: options.dbPath,
          executablePath: testOverrides?.executablePath,
          stdioScriptPath: testOverrides?.stdioScriptPath,
        });
        process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
      } else {
        const template = generateSubmissionClientConfig({
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

    db.pragma('foreign_keys = ON');
    const fkState = db.pragma('foreign_keys', { simple: true }) as number;
    if (fkState !== 1) {
      process.stderr.write('ERROR: [MCP_CONFIGURATION_INVALID] Failed to enable foreign keys\n');
      return 1;
    }

    try {
      verifyMigration22SchemaAuthority(db);
    } catch {
      process.stderr.write('ERROR: [MCP_CONFIGURATION_INVALID] Database schema authority verification failed\n');
      return 1;
    }

    const repo = new Repository(db);

    if (options.command === 'issue') {
      const authId = options.authorizationId!;
      const auth = repo.getExecutionAuthorization(authId);
      if (!auth) {
        process.stderr.write(`ERROR: [MCP_AUTHORITY_FENCED] Execution authorization "${authId}" not found\n`);
        return 1;
      }

      const ttl = options.ttlSeconds ?? SUBMISSION_SESSION_DEFAULT_TTL_SECONDS;
      const plaintextToken = generateSubmissionToken();
      const tokenHash = computeSha256(plaintextToken);
      const sessionId = crypto.randomUUID();
      const task = repo.getTask(auth.task_id);
      if (!task || task.ownership_epoch === undefined || task.ownership_epoch <= 0) {
        process.stderr.write(`ERROR: [MCP_AUTHORITY_FENCED] Task ownership epoch missing or non-positive\n`);
        return 1;
      }
      if (task.ownership_epoch !== auth.task_ownership_epoch) {
        process.stderr.write(`ERROR: [MCP_AUTHORITY_FENCED] Task ownership epoch mismatch with authorization\n`);
        return 1;
      }
      const authorizationFingerprint = computeAuthorityFingerprint({
        assignment_id: auth.assignment_id ?? null,
        attempt_id: auth.attempt_id ?? null,
        authorization_id: auth.id,
        authorization_status: auth.status,
        base_sha: auth.base_sha,
        dispatched_at: auth.dispatched_at ?? '',
        execution_id: auth.execution_id ?? null,
        lifecycle_version: auth.lifecycle_version ?? null,
        manager_message_id: auth.manager_message_id,
        manager_payload_hash: auth.manager_payload_hash,
        project_id: auth.project_id,
        repository_head_sha: auth.repository_head_sha,
        routing_decision_id: auth.routing_decision_id,
        selected_account_id: auth.selected_account_id ?? null,
        selected_provider_id: auth.selected_provider_id,
        selected_resource_id: auth.selected_resource_id,
        task_id: auth.task_id,
        task_ownership_epoch: auth.task_ownership_epoch,
        task_revision: auth.task_revision,
      });

      const session = repo.runInImmediateTransaction(() => {
        const nowIso = new Date().toISOString();
        // Atomic replacement: revoke any unrevoked session for this authorization
        const activeExisting = repo.getActiveMcpSubmissionSessionByAuthorizationId(authId);
        if (activeExisting) {
          repo.revokeMcpSubmissionSession(activeExisting.id, nowIso, 'SUPERSEDED_BY_NEW_SESSION');
        }

        const expiresAt = new Date(Date.parse(nowIso) + ttl * 1000).toISOString();
        return repo.createMcpSubmissionSession({
          id: sessionId,
          authorization_id: authId,
          scope: 'CODER_SUBMISSION',
          issuer_identity: 'OWNER_LOCAL_CLI',
          token_hash: tokenHash,
          authorization_fingerprint: authorizationFingerprint,
          issued_at: nowIso,
          expires_at: expiresAt,
          revoked_at: null,
          revocation_reason: null,
        });
      });

      if (options.jsonOutput) {
        const output = {
          status: 'ISSUED',
          session: {
            id: session.id,
            authorization_id: session.authorization_id,
            scope: session.scope,
            issued_at: session.issued_at,
            expires_at: session.expires_at,
          },
          plaintext_token: plaintextToken,
        };
        process.stdout.write(JSON.stringify(output, null, 2) + '\n');
      } else {
        process.stdout.write(`Submission session issued successfully:\n`);
        process.stdout.write(`  Session ID:       ${session.id}\n`);
        process.stdout.write(`  Authorization ID: ${session.authorization_id}\n`);
        process.stdout.write(`  Scope:            ${session.scope}\n`);
        process.stdout.write(`  Issued At:        ${session.issued_at}\n`);
        process.stdout.write(`  Expires At:       ${session.expires_at}\n`);
        process.stdout.write(`  Plaintext Token:  ${plaintextToken}\n`);
      }
      return 0;
    }

    if (options.command === 'revoke') {
      const reason = options.reason ?? 'MANUAL_REVOCATION';
      let revokedCount = 0;

      repo.runInImmediateTransaction(() => {
        const nowIso = new Date().toISOString();
        if (options.sessionId) {
          const sess = repo.getMcpSubmissionSessionById(options.sessionId);
          if (sess && sess.revoked_at === null) {
            const ok = repo.revokeMcpSubmissionSession(options.sessionId, nowIso, reason);
            if (ok) revokedCount++;
          }
        } else if (options.authorizationId) {
          const sess = repo.getActiveMcpSubmissionSessionByAuthorizationId(options.authorizationId);
          if (sess && sess.revoked_at === null) {
            const ok = repo.revokeMcpSubmissionSession(sess.id, nowIso, reason);
            if (ok) revokedCount++;
          }
        }
      });

      if (options.jsonOutput) {
        const output = {
          status: 'REVOKED',
          revoked: revokedCount > 0,
          revoked_count: revokedCount,
        };
        process.stdout.write(JSON.stringify(output, null, 2) + '\n');
      } else {
        process.stdout.write(`Submission session revoked (changed: ${revokedCount > 0})\n`);
      }
      return 0;
    }

    return 1;
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Authority verification failed';
    process.stderr.write(`ERROR: [MCP_AUTHORITY_FENCED] ${msg}\n`);
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
  const exitCode = runSubmissionAdmin(process.argv.slice(2));
  process.exit(exitCode);
}
