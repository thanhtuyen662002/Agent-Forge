import Database from 'better-sqlite3';
import type { Migration } from './types';

export const migration021: Migration = {
    version: 21,
    name: '021_r5j_mcp_client_session_authority',
    up: (db: Database.Database) => {
      db.exec(`
        CREATE TABLE mcp_client_sessions (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL REFERENCES execution_authorizations(id) ON DELETE RESTRICT,
          scope TEXT NOT NULL CHECK (scope = 'AUTHORIZED_CONTEXT_READ'),
          token_hash TEXT NOT NULL CHECK (
            length(token_hash) = 64 AND
            token_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          authorization_fingerprint TEXT NOT NULL CHECK (
            length(authorization_fingerprint) = 64 AND
            authorization_fingerprint GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          issued_at TEXT NOT NULL CHECK (length(issued_at) > 0),
          expires_at TEXT NOT NULL CHECK (length(expires_at) > 0 AND expires_at > issued_at),
          revoked_at TEXT NULL CHECK (revoked_at IS NULL OR (length(revoked_at) > 0 AND revoked_at >= issued_at))
        );

        CREATE UNIQUE INDEX uq_mcp_client_sessions_active_auth
        ON mcp_client_sessions(authorization_id)
        WHERE revoked_at IS NULL;

        CREATE UNIQUE INDEX idx_mcp_client_sessions_token_hash
        ON mcp_client_sessions(token_hash);

        CREATE INDEX idx_mcp_client_sessions_expires_at
        ON mcp_client_sessions(expires_at);

        CREATE INDEX idx_mcp_client_sessions_auth_id
        ON mcp_client_sessions(authorization_id);
      `);
    },
  };
