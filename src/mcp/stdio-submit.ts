import fs from 'fs';
import Database from 'better-sqlite3';
import { serveStdio, StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { Repository } from '../core/database/repositories';
import { verifyMigration22SchemaAuthority } from '../core/database/migrations';
import { McpSubmissionAuthorityService } from '../core/services/McpSubmissionAuthorityService';
import { buildAgentForgeSubmissionMcpServer } from './submissionServer';

let activeDatabase: Database.Database | null = null;

export function getActiveSubmissionDatabase(): Database.Database | null {
  return activeDatabase;
}

export function closeActiveSubmissionDatabase(): boolean {
  if (activeDatabase && activeDatabase.open) {
    try {
      activeDatabase.close();
      activeDatabase = null;
      return true;
    } catch {
      process.stderr.write('[agentforge-submit] Cleanup diagnostic: MCP_CLEANUP_FAILED\n');
      return false;
    }
  }
  activeDatabase = null;
  return true;
}

export function runSubmissionStdioServer(): StdioServerHandle {
  let isCleaningUp = false;
  let cleanupSuccess = true;

  const removeSignalListeners = () => {
    process.off('exit', onExit);
    process.off('SIGINT', onSigInt);
    process.off('SIGTERM', onSigTerm);
  };

  const cleanup = (): boolean => {
    if (isCleaningUp) return cleanupSuccess;
    isCleaningUp = true;
    removeSignalListeners();
    try {
      const ok = closeActiveSubmissionDatabase();
      cleanupSuccess = ok;
    } catch {
      cleanupSuccess = false;
      process.stderr.write('[agentforge-submit] Cleanup diagnostic: MCP_CLEANUP_FAILED\n');
    }
    return cleanupSuccess;
  };

  const onSigInt = () => {
    const success = cleanup();
    process.exit(success ? 0 : 1);
  };

  const onSigTerm = () => {
    const success = cleanup();
    process.exit(success ? 0 : 1);
  };

  const onExit = () => {
    const success = cleanup();
    if (!success) {
      process.exitCode = 1;
    }
  };

  process.once('exit', onExit);
  process.once('SIGINT', onSigInt);
  process.once('SIGTERM', onSigTerm);

  try {
    const dbPath = process.env.AGENTFORGE_MCP_DB_PATH;
    if (!dbPath || typeof dbPath !== 'string' || dbPath.trim().length === 0) {
      process.stderr.write('[agentforge-submit-fatal] Startup failure: AGENTFORGE_MCP_DB_PATH required\n');
      cleanup();
      process.exit(1);
    }

    const trimmedDbPath = dbPath.trim();
    if (!fs.existsSync(trimmedDbPath)) {
      process.stderr.write('[agentforge-submit-fatal] Startup failure: Database file does not exist\n');
      cleanup();
      process.exit(1);
    }

    let db: Database.Database;
    try {
      db = new Database(trimmedDbPath, { fileMustExist: true });
    } catch {
      process.stderr.write('[agentforge-submit-fatal] Startup failure: Failed to open database\n');
      cleanup();
      process.exit(1);
    }

    try {
      db.pragma('foreign_keys = ON');
    } catch {
      db.close();
      process.stderr.write('[agentforge-submit-fatal] Startup failure: Failed to set foreign_keys pragma\n');
      cleanup();
      process.exit(1);
    }

    const fkState = db.pragma('foreign_keys', { simple: true }) as number;
    if (fkState !== 1) {
      db.close();
      process.stderr.write('[agentforge-submit-fatal] Startup failure: Failed to verify foreign_keys pragma\n');
      cleanup();
      process.exit(1);
    }

    try {
      verifyMigration22SchemaAuthority(db);
    } catch {
      db.close();
      process.stderr.write('[agentforge-submit-fatal] Startup failure: Schema authority verification failed\n');
      cleanup();
      process.exit(1);
    }

    activeDatabase = db;
    const repo = new Repository(db);
    const service = new McpSubmissionAuthorityService(repo, db);

    const handle = serveStdio(
      () =>
        buildAgentForgeSubmissionMcpServer({
          db,
          repo,
          service,
        }),
      {
        onerror: () => {
          process.stderr.write('[agentforge-submit] MCP_SERVER_ERROR\n');
        },
      }
    );

    const originalClose = handle.close.bind(handle);
    handle.close = async () => {
      const success = cleanup();
      let closeErr: unknown = null;
      try {
        await originalClose();
      } catch (err) {
        closeErr = err;
      }
      if (!success) {
        throw new Error('Cleanup failed: MCP_CLEANUP_FAILED');
      }
      if (closeErr) {
        throw closeErr;
      }
    };

    return handle;
  } catch {
    process.stderr.write('[agentforge-submit-fatal] Startup failure: MCP_STARTUP_FAILED\n');
    cleanup();
    process.exit(1);
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  try {
    runSubmissionStdioServer();
  } catch {
    process.stderr.write('[agentforge-submit-fatal] MCP_FATAL_ERROR\n');
    process.exit(1);
  }
}
