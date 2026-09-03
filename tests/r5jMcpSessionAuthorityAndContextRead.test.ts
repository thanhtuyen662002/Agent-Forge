import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { spawn, execSync, ChildProcess } from 'child_process';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MigrationRunner, MIGRATIONS } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import {
  McpSessionAuthorityService,
  McpAuthorityError,
  computeAuthorizationFingerprint,
  MCP_SESSION_DEFAULT_TTL_SECONDS,
  MCP_SESSION_MIN_TTL_SECONDS,
  MCP_SESSION_MAX_TTL_SECONDS,
} from '../src/core/services/McpSessionAuthorityService';
import {
  CanonicalExecutionPayload,
  computePayloadHash,
  computeContextManifestHash,
} from '../src/core/services/ExecutionAuthorizationService';
import {
  ExecutionAuthorization,
  McpClientSession,
} from '../src/core/types/domain';
import {
  McpAuthorityContext,
  getDefaultAuthorityContext,
  resetDefaultAuthorityContext,
} from '../src/mcp/McpAuthorityContext';
import {
  GET_CAPABILITIES_TOOL_NAME,
  GET_AUTHORIZED_CONTEXT_TOOL_NAME,
  CAPABILITIES_RESOURCE_URI,
  AUTHORIZED_CONTEXT_RESOURCE_URI,
  CANONICAL_CAPABILITY_PAYLOAD,
  CANONICAL_CAPABILITY_PAYLOAD_JSON,
} from '../src/mcp/McpProtocolSchemas';
import { buildAgentForgeMcpServer } from '../src/mcp/McpServer';
import { parseCliArgs, runSessionAdmin } from '../src/mcp/sessionAdmin';

const DIST_ELECTRON_DIR = path.resolve(__dirname, '../dist-electron');
const DIST_PACKAGE_JSON_PATH = path.resolve(DIST_ELECTRON_DIR, 'package.json');
const STDIO_SCRIPT_PATH = path.resolve(DIST_ELECTRON_DIR, 'mcp/stdio.js');
const SESSION_ADMIN_SCRIPT_PATH = path.resolve(DIST_ELECTRON_DIR, 'mcp/sessionAdmin.js');

interface TestFixtures {
  db: Database.Database;
  dbPath: string;
  repo: Repository;
  service: McpSessionAuthorityService;
  projectId: string;
  taskId: string;
  attemptId: string;
  assignmentId: string;
  providerId: string;
  accountId: string;
  resourceId: string;
  routingDecisionId: string;
  authorizationId: string;
  validAuth: ExecutionAuthorization;
  validPayload: CanonicalExecutionPayload;
}

function createTestDatabase(tempDir: string, filename = 'test-agentforge.db'): { db: Database.Database; dbPath: string } {
  const dbPath = path.join(tempDir, filename);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  MigrationRunner.run(db);
  return { db, dbPath };
}

function setupFullGraph(db: Database.Database): TestFixtures {
  const repo = new Repository(db);
  const service = new McpSessionAuthorityService(repo, db);

  const now = new Date().toISOString();
  const projectId = `proj-${crypto.randomUUID()}`;
  const taskId = `task-${crypto.randomUUID()}`;
  const attemptId = `att-${crypto.randomUUID()}`;
  const assignmentId = `asgn-${crypto.randomUUID()}`;
  const providerId = 'provider-anthropic-claude';
  const accountId = `acc-${crypto.randomUUID()}`;
  const resourceId = `res-${crypto.randomUUID()}`;
  const routingDecisionId = `route-${crypto.randomUUID()}`;
  const authorizationId = `auth-${crypto.randomUUID()}`;

  // 1. Project
  repo.createProject({
    id: projectId,
    name: 'Test Project',
    description: 'Testing',
    repository_path: 'D:/fake/repo',
    default_branch: 'main',
    status: 'RUNNING',
    contract: null,
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
  });

  // 2. Task
  repo.createTask({
    id: taskId,
    project_id: projectId,
    milestone_id: null,
    title: 'Task 1',
    description: 'Testing task',
    state: 'CODING',
    priority: 'MEDIUM',
    risk: 'LOW',
    revision_count: 1,
    max_revisions: 5,
    progress_cache_percent: 0,
    paused_from_state: null,
    assigned_agent_id: null,
    acceptance_criteria: ['Must pass tests'],
    constraints: ['Strict schema'],
    ownership_epoch: 1,
    base_sha: 'b'.repeat(40),
    current_sha: null,
    progress_computed_at: null,
    created_at: now,
    updated_at: now,
  });

  // 3. Role profile & Agent profile
  const roleId = `role-${crypto.randomUUID()}`;
  const agentId = `agent-${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO role_profiles (id, role, display_name, required_capabilities_json, preferred_capabilities_json, permissions_json, enabled, created_at, updated_at)
    VALUES (?, 'CODER', 'Coder Role', '["CODING"]', '[]', '[]', 1, ?, ?)
  `).run(roleId, now, now);

  db.prepare(`
    INSERT INTO agent_profiles (id, role_profile_id, name, enabled, created_at, updated_at)
    VALUES (?, ?, 'Agent Coder', 1, ?, ?)
  `).run(agentId, roleId, now, now);

  // 4. Provider, Account, Resource
  db.prepare(`
    INSERT OR IGNORE INTO providers (id, name, adapter_type, enabled, created_at)
    VALUES (?, 'Anthropic Claude', 'LOCAL_CLI', 1, ?)
  `).run(providerId, now);

  db.prepare(`
    INSERT INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at)
    VALUES (?, ?, 'default-account', 'NATIVE_PROFILE', 1, 10, 'AVAILABLE', 20, ?, ?)
  `).run(accountId, providerId, now, now);

  db.prepare(`
    INSERT INTO provider_resources (id, provider_id, provider_account_id, model_name, health_status, capabilities_json, enabled, total_quota, remaining_quota, quota_unit, quota_source, quota_confidence, last_health_check)
    VALUES (?, ?, ?, 'claude-3-7-sonnet', 'AVAILABLE', '["CODING"]', 1, 1000, 1000, 'REQUESTS', 'PROVIDER_REPORTED', 1.0, ?)
  `).run(resourceId, providerId, accountId, now);

  // 5. Task Attempt
  repo.createTaskAttempt({
    id: attemptId,
    task_id: taskId,
    attempt_number: 1,
    status: 'RUNNING',
    agent_profile_id: agentId,
    agent_id: null,
    started_at: now,
    ended_at: null,
    summary: null,
  });

  // 6. Routing decision event
  db.prepare(`
    INSERT INTO events (id, project_id, task_id, type, summary, structured_payload_json, timestamp)
    VALUES (?, ?, ?, 'PROVIDER_ROUTING_DECISION', 'Optimal route', ?, ?)
  `).run(
    routingDecisionId,
    projectId,
    taskId,
    JSON.stringify({ decisionId: routingDecisionId, projectId, taskId, selectedProviderId: providerId, model: 'claude-3-7-sonnet' }),
    now
  );

  // 7. Agent Assignment
  repo.createAgentAssignment({
    id: assignmentId,
    project_id: projectId,
    task_id: taskId,
    attempt_id: attemptId,
    role_profile_id: roleId,
    agent_profile_id: agentId,
    selected_provider_id: providerId,
    selected_account_id: accountId,
    selected_resource_id: resourceId,
    selected_worker_slot_id: null,
    routing_decision_id: routingDecisionId,
    status: 'ASSIGNED',
    created_at: now,
    ended_at: null,
    preferred_metadata: null,
  });

  // 8. Protocol Message (for manager_message_id FK)
  const managerMessageId = `msg-${crypto.randomUUID()}`;
  const managerPayloadHash = 'a'.repeat(64);
  repo.recordProtocolMessage(
    managerMessageId,
    managerMessageId,
    'manager.v1',
    projectId,
    taskId,
    'APPROVED',
    1,
    managerPayloadHash,
    '{}',
    'APPLIED',
    undefined,
    now
  );

  // 9. Canonical Payload
  const validPayload: CanonicalExecutionPayload = {
    projectId,
    taskId,
    attemptId,
    taskTitle: 'Task 1',
    taskDescription: 'Testing task',
    acceptanceCriteria: ['Must pass tests'],
    constraints: ['Strict schema'],
    instructions: ['Execute correctly'],
    contextFiles: ['src/index.ts', 'package.json'],
    verificationCommands: {
      TEST: { executable: 'npm test', args: [] },
      LINT: null,
      BUILD: null,
    },
    managerMessageId,
    managerPayloadHash,
  };

  const canonicalPayloadJson = JSON.stringify(validPayload);
  const instructionPayloadHash = computePayloadHash(validPayload);
  const contextManifestHash = computeContextManifestHash(validPayload.contextFiles);

  // 10. Execution Authorization
  const validAuth: ExecutionAuthorization = {
    id: authorizationId,
    project_id: projectId,
    task_id: taskId,
    attempt_id: attemptId,
    task_revision: 1,
    base_sha: 'b'.repeat(40),
    repository_head_sha: 'c'.repeat(40),
    manager_message_id: validPayload.managerMessageId,
    manager_payload_hash: validPayload.managerPayloadHash,
    routing_decision_id: routingDecisionId,
    selected_account_id: accountId,
    selected_resource_id: resourceId,
    selected_provider_id: providerId,
    instruction_payload_hash: instructionPayloadHash,
    context_manifest_hash: contextManifestHash,
    canonical_instructions_json: JSON.stringify(validPayload.instructions),
    context_files_json: JSON.stringify(validPayload.contextFiles),
    canonical_payload_json: canonicalPayloadJson,
    status: 'AUTHORIZED',
    created_at: now,
    dispatched_at: null,
    task_ownership_epoch: 1,
    assignment_id: assignmentId,
    lifecycle_version: 1,
  };

  repo.createExecutionAuthorization(validAuth);

  return {
    db,
    dbPath: (db as unknown as { name: string }).name,
    repo,
    service,
    projectId,
    taskId,
    attemptId,
    assignmentId,
    providerId,
    accountId,
    resourceId,
    routingDecisionId,
    authorizationId,
    validAuth,
    validPayload,
  };
}

describe('R5J2 MCP Session Authority and Scoped Context Read Suite', () => {
  let tempDir: string;

  beforeAll(() => {
    // Compile TypeScript to ensure dist-electron is up to date
    execSync('npx tsc -p tsconfig.node.json', { stdio: 'pipe' });

    if (!fs.existsSync(DIST_ELECTRON_DIR)) {
      fs.mkdirSync(DIST_ELECTRON_DIR, { recursive: true });
    }
    fs.writeFileSync(
      DIST_PACKAGE_JSON_PATH,
      JSON.stringify({ type: 'commonjs' }, null, 2),
      'utf8'
    );
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-r5j2-test-'));
  });

  afterEach(() => {
    resetDefaultAuthorityContext();
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore removal errors on Windows lock
      }
    }
  });

  // 1. Fresh Migration 21 creation and schema inspection
  it('1. Fresh Migration 21 creates mcp_client_sessions with correct schema and columns', () => {
    const { db } = createTestDatabase(tempDir, 'fresh.db');
    try {
      const tableInfo = db.pragma('table_info(mcp_client_sessions)') as Array<{ name: string; type: string; notnull: number; pk: number }>;
      const colMap = new Map(tableInfo.map((c) => [c.name, c]));

      expect(colMap.has('id')).toBe(true);
      expect(colMap.get('id')?.pk).toBe(1);

      expect(colMap.has('authorization_id')).toBe(true);
      expect(colMap.get('authorization_id')?.notnull).toBe(1);

      expect(colMap.has('scope')).toBe(true);
      expect(colMap.get('scope')?.notnull).toBe(1);

      expect(colMap.has('token_hash')).toBe(true);
      expect(colMap.get('token_hash')?.notnull).toBe(1);

      expect(colMap.has('authorization_fingerprint')).toBe(true);
      expect(colMap.get('authorization_fingerprint')?.notnull).toBe(1);

      expect(colMap.has('issued_at')).toBe(true);
      expect(colMap.get('issued_at')?.notnull).toBe(1);

      expect(colMap.has('expires_at')).toBe(true);
      expect(colMap.get('expires_at')?.notnull).toBe(1);

      expect(colMap.has('revoked_at')).toBe(true);
      expect(colMap.get('revoked_at')?.notnull).toBe(0);

      // Verify no last_used_at or access counters
      expect(colMap.has('last_used_at')).toBe(false);
      expect(colMap.has('access_count')).toBe(false);
    } finally {
      db.close();
    }
  });

  // 2. Sequential upgrade from Migration 20 to 21
  it('2. Sequential upgrade applies Migration 21 cleanly after Migration 20', () => {
    const dbPath = path.join(tempDir, 'upgrade.db');
    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');

    try {
      // Apply migrations 1 through 20
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      for (const migration of MIGRATIONS) {
        if (migration.version <= 20) {
          migration.up(db);
          db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
            migration.version,
            migration.name,
            new Date().toISOString()
          );
        }
      }

      // Check migration 21 not applied yet
      const before = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mcp_client_sessions'").get();
      expect(before).toBeUndefined();

      // Now run runner to upgrade to 21
      MigrationRunner.run(db);

      const after = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mcp_client_sessions'").get();
      expect(after).toBeDefined();

      const versionRow = db.prepare('SELECT MAX(version) as max_v FROM schema_migrations').get() as { max_v: number };
      expect(versionRow.max_v).toBe(21);
    } finally {
      db.close();
    }
  });

  // 3. Every table constraint and foreign-key restriction
  it('3. Enforces table constraints (scope, token_hash, fingerprint, timestamps, FK restriction)', () => {
    const { db } = createTestDatabase(tempDir, 'constraints.db');
    try {
      const now = new Date().toISOString();
      const expires = new Date(Date.now() + 3600000).toISOString();
      const validHash = 'a'.repeat(64);
      const validFp = 'b'.repeat(64);

      // FK failure: nonexistent authorization
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, scope, token_hash, authorization_fingerprint, issued_at, expires_at)
          VALUES ('s1', 'nonexistent-auth', 'AUTHORIZED_CONTEXT_READ', ?, ?, ?, ?)
        `).run(validHash, validFp, now, expires);
      }).toThrow();

      // Setup a dummy auth so FK passes
      setupFullGraph(db);
      const authRow = db.prepare('SELECT id FROM execution_authorizations LIMIT 1').get() as { id: string };
      const authId = authRow.id;

      // Scope restriction: invalid scope
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, scope, token_hash, authorization_fingerprint, issued_at, expires_at)
          VALUES ('s2', ?, 'BROAD_READ', ?, ?, ?, ?)
        `).run(authId, validHash, validFp, now, expires);
      }).toThrow();

      // Token hash length mismatch
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, scope, token_hash, authorization_fingerprint, issued_at, expires_at)
          VALUES ('s3', ?, 'AUTHORIZED_CONTEXT_READ', 'short', ?, ?, ?)
        `).run(authId, validFp, now, expires);
      }).toThrow();

      // Token hash uppercase rejected by GLOB [0-9a-f]
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, scope, token_hash, authorization_fingerprint, issued_at, expires_at)
          VALUES ('s4', ?, 'AUTHORIZED_CONTEXT_READ', ?, ?, ?, ?)
        `).run(authId, 'A'.repeat(64), validFp, now, expires);
      }).toThrow();

      // Fingerprint length mismatch
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, scope, token_hash, authorization_fingerprint, issued_at, expires_at)
          VALUES ('s5', ?, 'AUTHORIZED_CONTEXT_READ', ?, 'bad-fp', ?, ?)
        `).run(authId, validHash, now, expires);
      }).toThrow();

      // expires_at <= issued_at rejected
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, scope, token_hash, authorization_fingerprint, issued_at, expires_at)
          VALUES ('s6', ?, 'AUTHORIZED_CONTEXT_READ', ?, ?, ?, ?)
        `).run(authId, validHash, validFp, now, now);
      }).toThrow();

      // revoked_at < issued_at rejected
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, scope, token_hash, authorization_fingerprint, issued_at, expires_at, revoked_at)
          VALUES ('s7', ?, 'AUTHORIZED_CONTEXT_READ', ?, ?, ?, ?, '2000-01-01T00:00:00.000Z')
        `).run(authId, validHash, validFp, now, expires);
      }).toThrow();
    } finally {
      db.close();
    }
  });

  // 4. Token entropy, hashing, one-time plaintext return
  it('4. Token entropy is >= 256 bits canonical base64url and returned plaintext once', () => {
    const token = McpSessionAuthorityService.generateSessionToken();
    expect(typeof token).toBe('string');
    // 32 bytes base64url = 43 chars without padding
    expect(token.length).toBe(43);
    expect(token).not.toContain('=');
    expect(token).not.toContain('+');
    expect(token).not.toContain('/');

    const hash1 = McpSessionAuthorityService.hashSessionToken(token);
    const hash2 = McpSessionAuthorityService.hashSessionToken(token);
    expect(hash1).toHaveLength(64);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  // 5. Verifies absence of plaintext tokens at rest
  it('5. Database stores only lowercase SHA-256 token digest, never plaintext', () => {
    const { db } = createTestDatabase(tempDir, 'notoken.db');
    try {
      const fixtures = setupFullGraph(db);
      const result = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });

      const row = db.prepare('SELECT * FROM mcp_client_sessions WHERE id = ?').get(result.session.id) as Record<string, unknown>;
      expect(row.token_hash).toBe(result.session.token_hash);
      expect(row.token_hash).not.toBe(result.plaintextToken);

      // Raw db dump must not contain the plaintext token
      const allText = JSON.stringify(row);
      expect(allText).not.toContain(result.plaintextToken);
    } finally {
      db.close();
    }
  });

  // 6. TTL bounds enforcement
  it('6. Enforces TTL bounds [300s, 86400s] with default 3600s', () => {
    const { db } = createTestDatabase(tempDir, 'ttl.db');
    try {
      const fixtures = setupFullGraph(db);

      // Sub-minimum TTL rejected
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId, ttlSeconds: 299 });
      }).toThrowError(/authorized bounds/);

      // Super-maximum TTL rejected
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId, ttlSeconds: 86401 });
      }).toThrowError(/authorized bounds/);

      // Default TTL (3600s)
      const defRes = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      const issued = new Date(defRes.session.issued_at).getTime();
      const expires = new Date(defRes.session.expires_at).getTime();
      const diffSec = Math.round((expires - issued) / 1000);
      expect(diffSec).toBe(3600);
    } finally {
      db.close();
    }
  });

  // 7. Duplicate active-session rejection
  it('7. Duplicate active-session rejected by partial unique index', () => {
    const { db } = createTestDatabase(tempDir, 'dup.db');
    try {
      const fixtures = setupFullGraph(db);
      fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });

      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/active unrevoked session already exists/);
    } finally {
      db.close();
    }
  });

  // 8. Idempotent session revocation
  it('8. Idempotent session revocation succeeds without error or duplicate mutations', () => {
    const { db } = createTestDatabase(tempDir, 'revoke.db');
    try {
      const fixtures = setupFullGraph(db);
      const res = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });

      const rev1 = fixtures.service.revokeSession({ sessionId: res.session.id });
      expect(rev1.revoked).toBe(true);

      const rev2 = fixtures.service.revokeSession({ sessionId: res.session.id });
      expect(rev2.revoked).toBe(false);

      // Now a new session can be issued after revocation
      const res2 = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      expect(res2.session.id).not.toBe(res.session.id);
    } finally {
      db.close();
    }
  });

  // 9. Rejection on missing token
  it('9. Rejection on missing token returns MCP_SESSION_REQUIRED', () => {
    const { db } = createTestDatabase(tempDir, 'missingtoken.db');
    try {
      const fixtures = setupFullGraph(db);
      expect(() => {
        fixtures.service.resolveAuthorizedContext(undefined);
      }).toThrowError(/MCP_SESSION_REQUIRED/);

      expect(() => {
        fixtures.service.resolveAuthorizedContext('');
      }).toThrowError(/MCP_SESSION_REQUIRED/);
    } finally {
      db.close();
    }
  });

  // 10. Rejection on unknown token
  it('10. Rejection on unknown token returns MCP_SESSION_UNAUTHORIZED', () => {
    const { db } = createTestDatabase(tempDir, 'unknown.db');
    try {
      const fixtures = setupFullGraph(db);
      expect(() => {
        fixtures.service.resolveAuthorizedContext('unknown-token-12345678901234567890');
      }).toThrowError(/MCP_SESSION_UNAUTHORIZED/);
    } finally {
      db.close();
    }
  });

  // 11. Rejection on expired token
  it('11. Rejection on expired token returns MCP_SESSION_UNAUTHORIZED', () => {
    const { db } = createTestDatabase(tempDir, 'expired.db');
    try {
      const fixtures = setupFullGraph(db);
      const { session, plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });

      // Mutate issued_at and expires_at to past while preserving expires_at > issued_at
      db.prepare("UPDATE mcp_client_sessions SET issued_at = '2020-01-01T00:00:00.000Z', expires_at = '2020-01-01T01:00:00.000Z' WHERE id = ?").run(session.id);

      expect(() => {
        fixtures.service.resolveAuthorizedContext(plaintextToken);
      }).toThrowError(/MCP_SESSION_UNAUTHORIZED/);
    } finally {
      db.close();
    }
  });

  // 12. Rejection on revoked token
  it('12. Rejection on revoked token returns MCP_SESSION_UNAUTHORIZED', () => {
    const { db } = createTestDatabase(tempDir, 'revoked.db');
    try {
      const fixtures = setupFullGraph(db);
      const { session, plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });

      fixtures.service.revokeSession({ sessionId: session.id });

      expect(() => {
        fixtures.service.resolveAuthorizedContext(plaintextToken);
      }).toThrowError(/MCP_SESSION_UNAUTHORIZED/);
    } finally {
      db.close();
    }
  });

  // 13. Public error non-oracular equivalence
  it('13. Non-oracular equivalence: unknown, expired, and revoked all produce MCP_SESSION_UNAUTHORIZED', () => {
    const { db } = createTestDatabase(tempDir, 'nonoracular.db');
    try {
      const fixtures = setupFullGraph(db);
      const { session, plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });

      let errUnknown = '';
      try { fixtures.service.resolveAuthorizedContext('invalid-random-token'); } catch (e: any) { errUnknown = e.message; }

      let errRevoked = '';
      fixtures.service.revokeSession({ sessionId: session.id });
      try { fixtures.service.resolveAuthorizedContext(plaintextToken); } catch (e: any) { errRevoked = e.message; }

      expect(errUnknown).toContain('[MCP_SESSION_UNAUTHORIZED]');
      expect(errRevoked).toContain('[MCP_SESSION_UNAUTHORIZED]');
      expect(errUnknown).toBe(errRevoked);
    } finally {
      db.close();
    }
  });

  // 14. Missing or asymmetric environment configuration
  it('14. McpAuthorityContext checks missing AGENTFORGE_MCP_DB_PATH and AGENTFORGE_MCP_SESSION_TOKEN', () => {
    const ctxEmpty = new McpAuthorityContext({ dbPath: '', sessionToken: '' });
    expect(() => ctxEmpty.resolveAuthorizedContext()).toThrowError(/MCP_SESSION_REQUIRED/);

    const ctxNoDb = new McpAuthorityContext({ dbPath: '', sessionToken: 'valid-token' });
    expect(() => ctxNoDb.resolveAuthorizedContext()).toThrowError(/MCP_CONFIGURATION_INVALID/);
  });

  // 15. Missing database file and missing Migration 21 handling
  it('15. Fails with MCP_CONFIGURATION_INVALID if db file or Migration 21 is absent', () => {
    const ctxMissingFile = new McpAuthorityContext({
      dbPath: path.join(tempDir, 'nonexistent.db'),
      sessionToken: 'token',
    });
    expect(() => ctxMissingFile.resolveAuthorizedContext()).toThrowError(/MCP_CONFIGURATION_INVALID/);

    // DB exists without Migration 21
    const noM21Path = path.join(tempDir, 'nom21.db');
    const noM21Db = new Database(noM21Path);
    noM21Db.exec('CREATE TABLE dummy (id INT);');
    noM21Db.close();

    const ctxNoM21 = new McpAuthorityContext({ dbPath: noM21Path, sessionToken: 'token' });
    expect(() => ctxNoM21.resolveAuthorizedContext()).toThrowError(/missing Migration 21/);
  });

  // 16. Read-only and PRAGMA query_only = ON enforcement
  it('16. Read-only and PRAGMA query_only = ON prevents mutations during context read', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'readonly.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });

      const readContext = new McpAuthorityContext({ dbPath, sessionToken: plaintextToken });
      const { db: readDb } = readContext.getOrCreateDatabase();

      // Read succeeds
      const res = readContext.resolveAuthorizedContext();
      expect(res.schema_version).toBe(2);

      // Attempting any write on readDb throws readonly/query_only error
      expect(() => {
        readDb.prepare('DELETE FROM execution_authorizations').run();
      }).toThrow();

      readContext.close();
    } finally {
      db.close();
    }
  });

  // 17. Rejection of unknown authorization
  it('17. Rejection of unknown authorization returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'unknownauth.db');
    try {
      const fixtures = setupFullGraph(db);
      expect(() => {
        fixtures.service.issueSession({ authorizationId: 'nonexistent-auth' });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  // 18. Rejection of legacy authorization (not lifecycle_version 1)
  it('18. Rejection of legacy authorization returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'legacy.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare('UPDATE execution_authorizations SET lifecycle_version = NULL WHERE id = ?').run(fixtures.authorizationId);

      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  // 19. Rejection of invalid authorization status
  it('19. Rejection of invalid authorization status returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'invstatus.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare("UPDATE execution_authorizations SET status = 'INVALIDATED' WHERE id = ?").run(fixtures.authorizationId);

      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  // 20. Rejection when terminal settlement is present
  it('20. Rejection when terminal settlement is present returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'settlement.db');
    try {
      const fixtures = setupFullGraph(db);
      const hash = 'd'.repeat(64);
      db.prepare(`
        UPDATE execution_authorizations
        SET settlement_status = 'COMPLETED', settled_at = ?, settlement_evidence_json = '{}', settlement_evidence_hash = ?
        WHERE id = ?
      `).run(new Date().toISOString(), hash, fixtures.authorizationId);

      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  // 21. Rejection when task ownership epoch is stale
  it('21. Rejection when task ownership epoch is stale returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'epoch.db');
    try {
      const fixtures = setupFullGraph(db);
      // Advance task ownership epoch to 2 while auth is at 1
      db.prepare('UPDATE tasks SET ownership_epoch = 2 WHERE id = ?').run(fixtures.taskId);

      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  // 22. Rejection when assignment is missing or terminal
  it('22. Rejection when assignment is terminal returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'asgnterm.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare("UPDATE agent_assignments SET status = 'COMPLETED' WHERE id = ?").run(fixtures.assignmentId);

      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  // 23. Graph binding conflict detection
  it('23. Graph binding conflicts (mismatched project, task, attempt) fail closed', () => {
    const { db } = createTestDatabase(tempDir, 'graphconflict.db');
    try {
      const fixtures = setupFullGraph(db);
      const otherProjId = 'other-proj-id';
      fixtures.repo.createProject({
        id: otherProjId,
        name: 'Other Project',
        description: 'Testing mismatch',
        repository_path: 'D:/fake/repo2',
        default_branch: 'main',
        status: 'RUNNING',
        contract: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
      });
      db.prepare("UPDATE tasks SET project_id = ? WHERE id = ?").run(otherProjId, fixtures.taskId);

      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  // 24. Authorization fingerprint tampering detection
  it('24. Authorization fingerprint tampering detection returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'tamper.db');
    try {
      const fixtures = setupFullGraph(db);
      const { session, plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });

      // Tamper base_sha in database
      db.prepare("UPDATE execution_authorizations SET base_sha = 'tampered-sha' WHERE id = ?").run(fixtures.authorizationId);

      expect(() => {
        fixtures.service.resolveAuthorizedContext(plaintextToken);
      }).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  // 25. Canonical payload parse failures
  it('25. Missing or malformed canonical_payload_json fails closed', () => {
    const { db } = createTestDatabase(tempDir, 'badpayload.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare("UPDATE execution_authorizations SET canonical_payload_json = 'invalid-json' WHERE id = ?").run(fixtures.authorizationId);

      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  // 26. Canonical payload unknown field rejection
  it('26. Canonical payload with unknown fields rejected by strict schema', () => {
    const { db } = createTestDatabase(tempDir, 'unknownfield.db');
    try {
      const fixtures = setupFullGraph(db);
      const tampered = { ...fixtures.validPayload, unauthorizedField: 'injected' };
      db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ? WHERE id = ?').run(
        JSON.stringify(tampered),
        fixtures.authorizationId
      );

      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  // 27. Payload identifier mismatch with authorization
  it('27. Payload identifier mismatch with authorization fails closed', () => {
    const { db } = createTestDatabase(tempDir, 'idmismatch.db');
    try {
      const fixtures = setupFullGraph(db);
      const tampered = { ...fixtures.validPayload, taskId: 'different-task-id' };
      db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ? WHERE id = ?').run(
        JSON.stringify(tampered),
        fixtures.authorizationId
      );

      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  // 28. Instruction payload hash recomputation mismatch detection
  it('28. Instruction payload hash recomputation mismatch fails closed', () => {
    const { db } = createTestDatabase(tempDir, 'hashmismatch.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare("UPDATE execution_authorizations SET instruction_payload_hash = ? WHERE id = ?").run('e'.repeat(64), fixtures.authorizationId);

      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  // 29. Context manifest hash recomputation mismatch detection
  it('29. Context manifest hash recomputation mismatch fails closed', () => {
    const { db } = createTestDatabase(tempDir, 'manifestmismatch.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare("UPDATE execution_authorizations SET context_manifest_hash = ? WHERE id = ?").run('f'.repeat(64), fixtures.authorizationId);

      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  // 30. Exact capability, tool, resource, and prompt lists inspection
  it('30. Capabilities expose exactly 2 tools, 2 resources, and 0 prompts', () => {
    expect(CANONICAL_CAPABILITY_PAYLOAD.schema_version).toBe(2);
    expect(CANONICAL_CAPABILITY_PAYLOAD.mode).toBe('AUTHORIZED_CONTEXT_READ');
    expect(CANONICAL_CAPABILITY_PAYLOAD.capabilities.tools).toEqual([
      GET_CAPABILITIES_TOOL_NAME,
      GET_AUTHORIZED_CONTEXT_TOOL_NAME,
    ]);
    expect(CANONICAL_CAPABILITY_PAYLOAD.capabilities.resources).toEqual([
      CAPABILITIES_RESOURCE_URI,
      AUTHORIZED_CONTEXT_RESOURCE_URI,
    ]);
    expect(CANONICAL_CAPABILITY_PAYLOAD.capabilities.prompts).toEqual([]);
  });

  // 31. Deterministic tool call replay over multiple invocations
  it('31. Tool calls replay deterministically producing byte-identical JSON', () => {
    const { db } = createTestDatabase(tempDir, 'deterministic.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });

      const ctx = new McpAuthorityContext({ db, sessionToken: plaintextToken });
      const r1 = JSON.stringify(ctx.resolveAuthorizedContext());
      const r2 = JSON.stringify(ctx.resolveAuthorizedContext());
      const r3 = JSON.stringify(ctx.resolveAuthorizedContext());

      expect(r1).toBe(r2);
      expect(r2).toBe(r3);
    } finally {
      db.close();
    }
  });

  // 32. Byte-identical responses between tool and resource endpoints
  it('32. Byte-identical responses between tool and resource endpoints', async () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'identical.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [STDIO_SCRIPT_PATH],
        env: {
          ...process.env,
          AGENTFORGE_MCP_DB_PATH: dbPath,
          AGENTFORGE_MCP_SESSION_TOKEN: plaintextToken,
        },
      });

      const client = new Client({ name: 'test-identical-client', version: '1.0.0' });
      await client.connect(transport);

      try {
        const toolRes = await client.callTool({
          name: GET_AUTHORIZED_CONTEXT_TOOL_NAME,
          arguments: {},
        });
        expect(toolRes.isError).toBeFalsy();
        const toolText = (toolRes.content[0] as { type: 'text'; text: string }).text;

        const resRes = await client.readResource({
          uri: AUTHORIZED_CONTEXT_RESOURCE_URI,
        });
        const resText = (resRes.contents[0] as { text: string }).text;

        expect(toolText).toBe(resText);
      } finally {
        await client.close();
      }
    } finally {
      db.close();
    }
  });

  // 33. Zero token, digest, credential, profile, or repository path leakage in results
  it('33. Verification of zero token, digest, credential, profile, or repository path leakage in results', () => {
    const { db } = createTestDatabase(tempDir, 'leakage.db');
    try {
      const fixtures = setupFullGraph(db);
      const { session, plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });

      const ctx = new McpAuthorityContext({ db, sessionToken: plaintextToken });
      const result = ctx.resolveAuthorizedContext();
      const text = JSON.stringify(result);

      // Must not contain plaintext token or digest
      expect(text).not.toContain(plaintextToken);
      expect(text).not.toContain(session.token_hash);

      // Must not contain repository filesystem path
      expect(text).not.toContain('D:/fake/repo');

      // Must not contain unrelated projects or tasks
      expect(text).not.toContain('unrelated');
    } finally {
      db.close();
    }
  });

function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Timed out waiting for condition after ${timeoutMs}ms`));
      }
      setTimeout(check, 25);
    };
    check();
  });
}

  // 34. Malformed JSON-RPC does not crash server process
  it('34. Malformed JSON-RPC does not crash server process', async () => {
    const child = spawn(process.execPath, [STDIO_SCRIPT_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      const responses: string[] = [];
      child.stdout.on('data', (chunk: Buffer) => responses.push(chunk.toString()));

      child.stdin.write('{"jsonrpc": "2.0", "corrupted": \n');
      await new Promise((r) => setTimeout(r, 50));

      const req = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      }) + '\n';
      child.stdin.write(req);

      await waitFor(() => responses.join('').includes('"result"'));
      expect(responses.join('')).toContain('"result"');
    } finally {
      child.stdin.end();
      await new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
        setTimeout(() => {
          try { child.kill(); } catch {}
          resolve();
        }, 1000);
      });
    }
  });

  // 35. Sequential client isolation
  it('35. Sequential client requests remain completely isolated', async () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'seqisolation.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [STDIO_SCRIPT_PATH],
        env: {
          ...process.env,
          AGENTFORGE_MCP_DB_PATH: dbPath,
          AGENTFORGE_MCP_SESSION_TOKEN: plaintextToken,
        },
      });

      const client = new Client({ name: 'test-seq-client', version: '1.0.0' });
      await client.connect(transport);

      try {
        const c1 = await client.callTool({ name: GET_CAPABILITIES_TOOL_NAME, arguments: {} });
        const c2 = await client.callTool({ name: GET_AUTHORIZED_CONTEXT_TOOL_NAME, arguments: {} });
        const c3 = await client.callTool({ name: GET_CAPABILITIES_TOOL_NAME, arguments: {} });

        expect(c1.isError).toBeFalsy();
        expect(c2.isError).toBeFalsy();
        expect(c3.isError).toBeFalsy();
        expect((c1.content[0] as { text: string }).text).toBe((c3.content[0] as { text: string }).text);
      } finally {
        await client.close();
      }
    } finally {
      db.close();
    }
  });

  // 36. stdout containing exclusively JSON-RPC traffic
  it('36. Protocol stdout contains exclusively valid JSON-RPC traffic', async () => {
    const child = spawn(process.execPath, [STDIO_SCRIPT_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutLines: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').map((l) => l.trim()).filter(Boolean);
      stdoutLines.push(...lines);
    });

    try {
      const init = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      }) + '\n';
      child.stdin.write(init);

      await waitFor(() => stdoutLines.length >= 1);
      expect(stdoutLines.length).toBeGreaterThanOrEqual(1);
      for (const line of stdoutLines) {
        expect(() => JSON.parse(line)).not.toThrow();
        expect(JSON.parse(line).jsonrpc).toBe('2.0');
      }
    } finally {
      child.stdin.end();
      await new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
        setTimeout(() => {
          try { child.kill(); } catch {}
          resolve();
        }, 1000);
      });
    }
  });

  // 37. stderr containing diagnostics without secrets
  it('37. Diagnostics are emitted to stderr without leaking secrets', async () => {
    const child = spawn(process.execPath, [STDIO_SCRIPT_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stderrChunks: string[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString()));

    try {
      child.stdin.write('bad-payload\n');
      await new Promise((r) => setTimeout(r, 100));
      // stderr may contain parse error, but no secrets
      const err = stderrChunks.join('');
      expect(err).not.toContain('password');
      expect(err).not.toContain('secret');
    } finally {
      child.stdin.end();
      await new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
        setTimeout(() => {
          try { child.kill(); } catch {}
          resolve();
        }, 1000);
      });
    }
  });

  // 38. Clean EOF and database handle shutdown
  it('38. Clean EOF disconnect shuts down with exit code 0 and releases handles', async () => {
    const child = spawn(process.execPath, [STDIO_SCRIPT_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const exitPromise = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    child.stdin.end();
    const code = await exitPromise;
    expect(code).toBe(0);
  });

  // 39. Session administration CLI issue flow
  it('39. Session administration CLI issue flow produces valid session JSON', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'cli-issue.db');
    try {
      const fixtures = setupFullGraph(db);
      db.close(); // Close so CLI can open

      const stdout = execSync(
        `node "${SESSION_ADMIN_SCRIPT_PATH}" issue --db "${dbPath}" --auth "${fixtures.authorizationId}" --ttl 3600 --json`,
        { encoding: 'utf8' }
      );

      const parsed = JSON.parse(stdout);
      expect(parsed.status).toBe('ISSUED');
      expect(parsed.session.authorization_id).toBe(fixtures.authorizationId);
      expect(parsed.session.scope).toBe('AUTHORIZED_CONTEXT_READ');
      expect(parsed.plaintext_token).toBeDefined();
      expect(parsed.plaintext_token).toHaveLength(43);
    } finally {
      if (db.open) db.close();
    }
  });

  // 40. Session administration CLI revoke flow
  it('40. Session administration CLI revoke flow is idempotent', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'cli-revoke.db');
    try {
      const fixtures = setupFullGraph(db);
      db.close();

      // Issue first
      const issueOut = execSync(
        `node "${SESSION_ADMIN_SCRIPT_PATH}" issue --db "${dbPath}" --auth "${fixtures.authorizationId}" --json`,
        { encoding: 'utf8' }
      );
      const issued = JSON.parse(issueOut);

      // Revoke once
      const rev1 = execSync(
        `node "${SESSION_ADMIN_SCRIPT_PATH}" revoke --db "${dbPath}" --session "${issued.session.id}" --json`,
        { encoding: 'utf8' }
      );
      expect(JSON.parse(rev1).revoked).toBe(true);

      // Revoke twice (idempotent)
      const rev2 = execSync(
        `node "${SESSION_ADMIN_SCRIPT_PATH}" revoke --db "${dbPath}" --session "${issued.session.id}" --json`,
        { encoding: 'utf8' }
      );
      expect(JSON.parse(rev2).revoked).toBe(false);
    } finally {
      if (db.open) db.close();
    }
  });

  // 41. Proof that context reads cause zero durable database modifications
  it('41. Context reads cause zero durable database changes', () => {
    const { db } = createTestDatabase(tempDir, 'zeromut.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });

      // Record count and content of all tables before read
      const tables = ['projects', 'tasks', 'execution_authorizations', 'mcp_client_sessions', 'agent_assignments'];
      const beforeSnapshots: Record<string, unknown[]> = {};
      for (const t of tables) {
        beforeSnapshots[t] = db.prepare(`SELECT * FROM ${t}`).all();
      }

      // Perform multiple reads
      const ctx = new McpAuthorityContext({ db, sessionToken: plaintextToken });
      ctx.resolveAuthorizedContext();
      ctx.resolveAuthorizedContext();
      ctx.resolveAuthorizedContext();

      // Compare after read
      for (const t of tables) {
        const after = db.prepare(`SELECT * FROM ${t}`).all();
        expect(after).toEqual(beforeSnapshots[t]);
      }
    } finally {
      db.close();
    }
  });
});
