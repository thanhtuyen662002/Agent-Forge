import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { Repository } from '../core/database/repositories';
import { verifyMigration24SchemaAuthority } from '../core/database/migrations';
import {
  ReviewerAuthorityService,
  ReviewerAuthorityError,
  scrubReviewerDiagnostics,
} from './reviewerAuthority';
import {
  SESSION_DURATION_MIN_SECONDS,
  SESSION_DURATION_MAX_SECONDS,
  SESSION_DURATION_DEFAULT_SECONDS,
} from '../types/reviewer';
import {
  generateReviewerClientConfig,
  generateReviewerClientConfigEnvelope,
} from './clientBridge';

export interface ReviewerCliArgs {
  command: 'issue' | 'revoke' | 'list' | 'configure-client' | 'help';
  client?: string;
  dbPath?: string;
  adjudicationId?: string;
  sessionId?: string;
  reviewerAgentId?: string;
  reviewerProviderId?: string;
  reviewerAccountId?: string;
  reviewerResourceId?: string;
  reason?: string;
  ttlSeconds?: number;
  jsonOutput: boolean;
}

export const FORBIDDEN_COMMANDS = new Set([
  'inspect',
  'sweep',
  'cleanup',
  'rotate',
  'adjudicate',
  'submit-verdict',
  'promote',
  'commit',
  'push',
  'apply',
]);

export function parseReviewerCliArgs(args: string[]): ReviewerCliArgs {
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

  let command: 'issue' | 'revoke' | 'list' | 'configure-client' | null = null;
  let client: string | undefined;
  let rawCliDbPath: string | undefined;
  let adjudicationId: string | undefined;
  let sessionId: string | undefined;
  let reviewerAgentId: string | undefined;
  let reviewerProviderId: string | undefined;
  let reviewerAccountId: string | undefined;
  let reviewerResourceId: string | undefined;
  let reason: string | undefined;
  let ttlSeconds: number | undefined;
  let jsonOutput = false;

  const seenFlags = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('-')) {
      if (arg === '--token') {
        throw new Error('Flag --token is forbidden to protect credential secrecy');
      }

      const normalizedFlag =
        arg === '-d' ? '--db'
        : arg === '-c' ? '--client'
        : arg === '-j' ? '--json'
        : arg === '-a' ? '--adjudication'
        : arg === '-s' ? '--session'
        : arg === '-r' ? '--reason'
        : arg === '-t' ? '--ttl'
        : arg;

      if (seenFlags.has(normalizedFlag)) {
        throw new Error(`Duplicate flag ${arg}`);
      }
      seenFlags.add(normalizedFlag);

      if (normalizedFlag === '--json') {
        jsonOutput = true;
      } else if (normalizedFlag === '--client') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new Error('Missing value for --client');
        client = args[++i].trim();
        if (!client) throw new Error('--client cannot be empty');
      } else if (normalizedFlag === '--db') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new Error('Missing value for --db');
        rawCliDbPath = args[++i].trim();
        if (!rawCliDbPath) throw new Error('--db cannot be empty');
      } else if (normalizedFlag === '--adjudication' || normalizedFlag === '--adjudication-id') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new Error('Missing value for --adjudication');
        adjudicationId = args[++i].trim();
        if (!adjudicationId) throw new Error('--adjudication cannot be empty');
      } else if (normalizedFlag === '--session' || normalizedFlag === '--session-id') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new Error('Missing value for --session');
        sessionId = args[++i].trim();
        if (!sessionId) throw new Error('--session cannot be empty');
      } else if (normalizedFlag === '--agent' || normalizedFlag === '--reviewer-agent-id') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new Error('Missing value for --agent');
        reviewerAgentId = args[++i].trim();
        if (!reviewerAgentId) throw new Error('--agent cannot be empty');
      } else if (normalizedFlag === '--provider' || normalizedFlag === '--reviewer-provider-id') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new Error('Missing value for --provider');
        reviewerProviderId = args[++i].trim();
        if (!reviewerProviderId) throw new Error('--provider cannot be empty');
      } else if (normalizedFlag === '--account' || normalizedFlag === '--reviewer-account-id') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new Error('Missing value for --account');
        reviewerAccountId = args[++i].trim();
        if (!reviewerAccountId) throw new Error('--account cannot be empty');
      } else if (normalizedFlag === '--resource' || normalizedFlag === '--reviewer-resource-id') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new Error('Missing value for --resource');
        reviewerResourceId = args[++i].trim();
        if (!reviewerResourceId) throw new Error('--resource cannot be empty');
      } else if (normalizedFlag === '--reason') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new Error('Missing value for --reason');
        reason = args[++i].trim();
        if (!reason) throw new Error('--reason cannot be empty');
      } else if (normalizedFlag === '--ttl' || normalizedFlag === '--duration') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new Error('Missing value for --ttl');
        const val = Number(args[++i].trim());
        if (!Number.isInteger(val)) throw new Error('--ttl must be an integer');
        ttlSeconds = val;
      } else {
        throw new Error(`Unknown flag: ${arg}`);
      }
    } else {
      if (command === null) {
        const cmd = arg.toLowerCase();
        if (FORBIDDEN_COMMANDS.has(cmd)) {
          throw new Error(`Command "${arg}" is forbidden in R5J7 reviewer admin CLI`);
        }
        if (cmd === 'issue' || cmd === 'revoke' || cmd === 'list' || cmd === 'configure-client') {
          command = cmd;
        } else {
          throw new Error(`Unknown command "${arg}"`);
        }
      } else {
        throw new Error(`Unexpected positional argument "${arg}"`);
      }
    }
  }

  if (command === null) {
    throw new Error('No command specified');
  }

  let dbPath: string | undefined;

  if (command === 'configure-client') {
    if (!client) {
      throw new Error('Command configure-client requires --client <antigravity|cursor|claude>');
    }
    if (adjudicationId || sessionId || reviewerAgentId || reviewerProviderId || reviewerAccountId || reviewerResourceId || reason || ttlSeconds) {
      throw new Error('Invalid flag for configure-client command');
    }
    dbPath = rawCliDbPath ?? process.env.AGENTFORGE_MCP_DB_PATH;
  } else if (command === 'issue') {
    if (client !== undefined) {
      throw new Error('Flag --client is not valid for issue command');
    }
    if (reason !== undefined) {
      throw new Error('Flag --reason is not valid for issue command');
    }
    if (sessionId !== undefined) {
      throw new Error('Flag --session is not valid for issue command');
    }
    if (!adjudicationId) {
      throw new Error('Issue command requires --adjudication <adjudication-id>');
    }
    if (ttlSeconds !== undefined && (ttlSeconds < SESSION_DURATION_MIN_SECONDS || ttlSeconds > SESSION_DURATION_MAX_SECONDS)) {
      throw new Error(`TTL ${ttlSeconds}s is out of authorized bounds [${SESSION_DURATION_MIN_SECONDS}, ${SESSION_DURATION_MAX_SECONDS}]`);
    }
    dbPath = rawCliDbPath ?? process.env.AGENTFORGE_MCP_DB_PATH;
    if (!dbPath) {
      throw new Error('Issue command requires --db <database-path>');
    }
  } else if (command === 'revoke') {
    if (client !== undefined) {
      throw new Error('Flag --client is not valid for revoke command');
    }
    if (ttlSeconds !== undefined) {
      throw new Error('Flag --ttl is not valid for revoke command');
    }
    if (!reason || reason.trim().length === 0) {
      throw new Error('Revoke command requires a non-empty --reason <reason>');
    }
    const hasSession = Boolean(sessionId);
    const hasAdj = Boolean(adjudicationId);
    if ((hasSession && hasAdj) || (!hasSession && !hasAdj)) {
      throw new Error('Revoke requires exactly one selector: --session XOR --adjudication');
    }
    dbPath = rawCliDbPath ?? process.env.AGENTFORGE_MCP_DB_PATH;
    if (!dbPath) {
      throw new Error('Revoke command requires --db <database-path>');
    }
  } else if (command === 'list') {
    if (client !== undefined) {
      throw new Error('Flag --client is not valid for list command');
    }
    if (reason !== undefined) {
      throw new Error('Flag --reason is not valid for list command');
    }
    if (ttlSeconds !== undefined) {
      throw new Error('Flag --ttl is not valid for list command');
    }
    dbPath = rawCliDbPath ?? process.env.AGENTFORGE_MCP_DB_PATH;
    if (!dbPath) {
      throw new Error('List command requires --db <database-path>');
    }
  }

  return {
    command,
    client,
    dbPath,
    adjudicationId,
    sessionId,
    reviewerAgentId,
    reviewerProviderId,
    reviewerAccountId,
    reviewerResourceId,
    reason,
    ttlSeconds,
    jsonOutput,
  };
}

export function runReviewerAdmin(
  args: string[],
  testOverrides?: { executablePath?: string; stdioScriptPath?: string; db?: Database.Database }
): number {
  let options: ReviewerCliArgs;
  try {
    options = parseReviewerCliArgs(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ERROR: [MCP_CONFIGURATION_INVALID] ${scrubReviewerDiagnostics(msg)}\n`);
    return 1;
  }

  if (options.command === 'help') {
    const usage = `
AgentForge MCP Reviewer Administration CLI

Usage:
  node reviewerAdmin.js configure-client --client <antigravity|cursor|claude> [--db <db-path>] [--json]
  node reviewerAdmin.js issue --db <db-path> --adjudication <adjudication-id> [--agent <agent-id>] [--provider <provider-id>] [--account <account-id>] [--resource <resource-id>] [--ttl <seconds>] [--json]
  node reviewerAdmin.js revoke --db <db-path> (--session <session-id> | --adjudication <adjudication-id>) --reason <reason> [--json]
  node reviewerAdmin.js list --db <db-path> [--session <session-id>] [--adjudication <adjudication-id>] [--json]
`;
    process.stdout.write(usage);
    return 0;
  }

  if (options.command === 'configure-client') {
    try {
      if (options.jsonOutput) {
        const envelope = generateReviewerClientConfigEnvelope({
          client: options.client!,
          dbPath: options.dbPath,
          executablePath: testOverrides?.executablePath,
          stdioScriptPath: testOverrides?.stdioScriptPath,
        });
        process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
      } else {
        const template = generateReviewerClientConfig({
          client: options.client!,
          dbPath: options.dbPath,
          executablePath: testOverrides?.executablePath,
          stdioScriptPath: testOverrides?.stdioScriptPath,
        });
        process.stdout.write(JSON.stringify(template, null, 2) + '\n');
      }
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`ERROR: [MCP_CONFIGURATION_INVALID] ${scrubReviewerDiagnostics(msg)}\n`);
      return 1;
    }
  }

  if (!options.dbPath || typeof options.dbPath !== 'string' || options.dbPath.trim().length === 0) {
    process.stderr.write('ERROR: [MCP_CONFIGURATION_INVALID] Missing required --db path\n');
    return 1;
  }

  const resolvedDbPath = path.resolve(options.dbPath.trim());
  let db: Database.Database | null = null;
  let closeDb = false;

  try {
    if (testOverrides?.db) {
      db = testOverrides.db;
    } else {
      if (!fs.existsSync(resolvedDbPath)) {
        process.stderr.write('ERROR: [MCP_CONFIGURATION_INVALID] Database file does not exist\n');
        return 1;
      }
      try {
        db = new Database(resolvedDbPath, { fileMustExist: true });
        closeDb = true;
      } catch {
        process.stderr.write('ERROR: [MCP_CONFIGURATION_INVALID] Failed to open database\n');
        return 1;
      }
    }

    db.pragma('foreign_keys = ON');
    const fkState = db.pragma('foreign_keys', { simple: true }) as number;
    if (fkState !== 1) {
      process.stderr.write('ERROR: [MCP_CONFIGURATION_INVALID] Failed to enable foreign keys\n');
      return 1;
    }

    try {
      verifyMigration24SchemaAuthority(db);
    } catch {
      process.stderr.write('ERROR: [MCP_CONFIGURATION_INVALID] Database schema authority verification failed\n');
      return 1;
    }

    const repo = new Repository(db);
    const service = new ReviewerAuthorityService(repo);

    if (options.command === 'issue') {
      try {
        // Resolve default reviewer authority tuple from database if not explicitly provided
        const adj = repo.getCoderSubmissionAdjudicationById(options.adjudicationId!);
        if (!adj) {
          process.stderr.write(`ERROR: [MCP_AUTHORITY_FENCED] Adjudication "${options.adjudicationId}" not found\n`);
          return 2;
        }

        let agentId = options.reviewerAgentId;
        let providerId = options.reviewerProviderId;
        let accountId = options.reviewerAccountId;
        let resourceId = options.reviewerResourceId;

        if (!agentId || !providerId || !accountId || !resourceId) {
          // Look for an eligible reviewer agent/provider/account/resource in repo
          const eligible = db.prepare(`
            SELECT a.id as agent_id, a.provider_id, pa.id as account_id, pr.id as resource_id
            FROM agents a
            JOIN providers p ON p.id = a.provider_id AND p.enabled = 1
            JOIN provider_accounts pa ON pa.provider_id = p.id AND pa.enabled = 1 AND pa.health_status IN ('AVAILABLE', 'BUSY', 'LOW_QUOTA')
            JOIN provider_resources pr ON pr.provider_id = p.id AND pr.enabled = 1 AND pr.health_status IN ('AVAILABLE', 'BUSY', 'LOW_QUOTA')
            WHERE a.role = 'REVIEWER' AND a.status != 'OFFLINE'
            ORDER BY a.id ASC
            LIMIT 1
          `).get() as { agent_id: string; provider_id: string; account_id: string; resource_id: string } | undefined;

          if (eligible) {
            agentId = agentId ?? eligible.agent_id;
            providerId = providerId ?? eligible.provider_id;
            accountId = accountId ?? eligible.account_id;
            resourceId = resourceId ?? eligible.resource_id;
          }
        }

        if (!agentId || !providerId || !accountId || !resourceId) {
          process.stderr.write('ERROR: [MCP_AUTHORITY_FENCED] Could not resolve reviewer authority tuple\n');
          return 2;
        }

        const issuance = service.issueReviewerSession({
          adjudication_id: options.adjudicationId!,
          reviewer_agent_id: agentId,
          reviewer_provider_id: providerId,
          reviewer_account_id: accountId,
          reviewer_resource_id: resourceId,
          duration_seconds: options.ttlSeconds ?? SESSION_DURATION_DEFAULT_SECONDS,
        });

        if (options.jsonOutput) {
          const output = {
            status: 'ISSUED',
            session: {
              id: issuance.session.id,
              adjudication_id: issuance.session.adjudication_id,
              submission_id: issuance.session.submission_id,
              reviewer_agent_id: issuance.session.reviewer_agent_id,
              reviewer_provider_id: issuance.session.reviewer_provider_id,
              reviewer_account_id: issuance.session.reviewer_account_id,
              reviewer_resource_id: issuance.session.reviewer_resource_id,
              scope: issuance.session.scope,
              projection_schema: issuance.session.projection_schema,
              projection_hash: issuance.session.projection_hash,
              issued_at: issuance.session.issued_at,
              expires_at: issuance.session.expires_at,
            },
            plaintext_token: issuance.raw_token,
          };
          process.stdout.write(JSON.stringify(output, null, 2) + '\n');
        } else {
          process.stdout.write('Reviewer session issued successfully:\n');
          process.stdout.write(`  Session ID:       ${issuance.session.id}\n`);
          process.stdout.write(`  Adjudication ID:  ${issuance.session.adjudication_id}\n`);
          process.stdout.write(`  Reviewer Agent:   ${issuance.session.reviewer_agent_id}\n`);
          process.stdout.write(`  Scope:            ${issuance.session.scope}\n`);
          process.stdout.write(`  Issued At:        ${issuance.session.issued_at}\n`);
          process.stdout.write(`  Expires At:       ${issuance.session.expires_at}\n`);
          process.stdout.write(`  Plaintext Token:  ${issuance.raw_token}\n`);
        }
        return 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`ERROR: [MCP_AUTHORITY_FENCED] ${scrubReviewerDiagnostics(msg)}\n`);
        return 2;
      }
    }

    if (options.command === 'revoke') {
      try {
        let targetSessionId: string | null = null;
        if (options.sessionId) {
          targetSessionId = options.sessionId;
        } else if (options.adjudicationId) {
          const activeSessions = repo.listMcpReviewerSessions({ adjudicationId: options.adjudicationId, activeOnly: true });
          if (activeSessions.length > 0) {
            targetSessionId = activeSessions[0].id;
          }
        }

        if (!targetSessionId) {
          process.stderr.write('ERROR: [MCP_AUTHORITY_FENCED] No matching active session found to revoke\n');
          return 2;
        }

        const revoked = service.revokeSession(targetSessionId, options.reason!);
        if (!revoked) {
          process.stderr.write('ERROR: [MCP_AUTHORITY_FENCED] Failed to revoke session or session already revoked\n');
          return 2;
        }

        if (options.jsonOutput) {
          const output = {
            status: 'REVOKED',
            session_id: targetSessionId,
            revoked: true,
          };
          process.stdout.write(JSON.stringify(output, null, 2) + '\n');
        } else {
          process.stdout.write(`Reviewer session "${targetSessionId}" revoked successfully\n`);
        }
        return 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`ERROR: [MCP_AUTHORITY_FENCED] ${scrubReviewerDiagnostics(msg)}\n`);
        return 2;
      }
    }

    if (options.command === 'list') {
      try {
        const sessions = service.listSessions({
          session_id: options.sessionId,
          adjudication_id: options.adjudicationId,
        });

        if (options.jsonOutput) {
          process.stdout.write(JSON.stringify({ status: 'OK', sessions }, null, 2) + '\n');
        } else {
          process.stdout.write(`Reviewer sessions (count: ${sessions.length}):\n`);
          for (const s of sessions) {
            process.stdout.write(
              `  - ID: ${s.id} | Adj: ${s.adjudication_id} | Agent: ${s.reviewer_agent_id} | Active: ${s.is_active} | Expires: ${s.expires_at}${s.revoked_at ? ` | Revoked: ${s.revoked_at}` : ''}\n`
            );
          }
        }
        return 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`ERROR: [MCP_AUTHORITY_FENCED] ${scrubReviewerDiagnostics(msg)}\n`);
        return 2;
      }
    }

    return 1;
  } finally {
    if (closeDb && db && db.open) {
      try {
        db.close();
      } catch {
        // cleanup suppression
      }
    }
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  const exitCode = runReviewerAdmin(process.argv.slice(2));
  process.exit(exitCode);
}
