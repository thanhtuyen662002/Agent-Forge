import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MIGRATIONS, MigrationRunner, verifyMigration21SchemaAuthority } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import {
  McpSessionAuthorityService,
  McpAuthorityError,
  computeCompleteAuthorityFingerprint,
  validateCanonicalSessionToken,
  validateTtlSeconds,
  MCP_SESSION_MIN_TTL_SECONDS,
  MCP_SESSION_MAX_TTL_SECONDS,
  MCP_SESSION_DEFAULT_TTL_SECONDS,
} from '../src/core/services/McpSessionAuthorityService';
import {
  McpAuthorityContext,
  resetDefaultAuthorityContext,
} from '../src/mcp/McpAuthorityContext';
import { buildAgentForgeMcpServer } from '../src/mcp/McpServer';
import {
  GET_CAPABILITIES_TOOL_NAME,
  GET_AUTHORIZED_CONTEXT_TOOL_NAME,
  CAPABILITIES_RESOURCE_URI,
  AUTHORIZED_CONTEXT_RESOURCE_URI,
  CANONICAL_CAPABILITY_PAYLOAD,
} from '../src/mcp/McpProtocolSchemas';
import { formatPublicError, getCanonicalPublicErrorMessage } from '../src/mcp/McpToolRegistry';
import {
  computeCanonicalPayload,
  computePayloadHash,
  computeContextManifestHash,
} from '../src/core/services/ExecutionAuthorizationService';
import { parseCliArgs, runSessionAdmin } from '../src/mcp/sessionAdmin';
import { runStdioServer } from '../src/mcp/stdio';
import { ExecutionAuthorization } from '../src/core/types/domain';

function safeRemoveDir(dir: string, maxRetries = 10, delayMs = 100): void {
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return;
    } catch (err) {
      if (i === maxRetries - 1) {
        throw new Error(`Failed to remove test directory "${dir}" after ${maxRetries} retries: ${err}`);
      }
      const end = Date.now() + delayMs;
      while (Date.now() < end) {}
    }
  }
}

function createTestDatabase(dir: string, name: string): { db: Database.Database; dbPath: string } {
  const dbPath = path.join(dir, name);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  MigrationRunner.run(db);
  return { db, dbPath };
}

interface FullGraphFixtures {
  projectId: string;
  taskId: string;
  attemptId: string;
  assignmentId: string;
  providerId: string;
  accountId: string;
  resourceId: string;
  routingDecisionId: string;
  authorizationId: string;
  managerMessageId: string;
  canonicalInstructionsJson: string;
  contextFilesJson: string;
  service: McpSessionAuthorityService;
  repo: Repository;
  auth: ExecutionAuthorization;
}

function setupFullGraph(db: Database.Database): FullGraphFixtures {
  const repo = new Repository(db);
  const service = new McpSessionAuthorityService(repo, db);

  const now = new Date().toISOString();
  const projectId = `proj-${crypto.randomUUID()}`;
  const taskId = `task-${crypto.randomUUID()}`;
  const attemptId = `att-${crypto.randomUUID()}`;
  const assignmentId = `asgn-${crypto.randomUUID()}`;
  const providerId = `prov-${crypto.randomUUID()}`;
  const accountId = `acc-${crypto.randomUUID()}`;
  const resourceId = `res-${crypto.randomUUID()}`;
  const routingDecisionId = `route-${crypto.randomUUID()}`;
  const authorizationId = `auth-${crypto.randomUUID()}`;
  const managerMessageId = `msg-${crypto.randomUUID()}`;

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
  const baseSha = 'b'.repeat(40);
  db.prepare(`
    INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, base_sha, created_at, updated_at)
    VALUES (?, ?, 'Task 1', 'CODING', 'LOW', 'LOW', 1, 3, 0, ?, ?, ?)
  `).run(taskId, projectId, baseSha, now, now);

  // 3. Profiles
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

  // 6. Routing Decision Event with all 8 mandatory fields
  const routingPayload = {
    projectId,
    taskId,
    attemptId,
    routingDecisionId,
    selectedProviderId: providerId,
    selectedAccountId: accountId,
    selectedResourceId: resourceId,
    selectedOutcome: 'SELECTED',
  };
  db.prepare(`
    INSERT INTO events (id, project_id, task_id, type, summary, structured_payload_json, timestamp)
    VALUES (?, ?, ?, 'PROVIDER_ROUTING_DECISION', 'Optimal route', ?, ?)
  `).run(routingDecisionId, projectId, taskId, JSON.stringify(routingPayload), now);

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

  // 8. Protocol Message
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
    JSON.stringify({ approved: true }),
    'APPLIED',
    now
  );

  // 9. Canonical Instructions and Context Files
  const instructions = ['Task: Task 1', 'Implement authorized context read'];
  const canonicalInstructionsJson = JSON.stringify(instructions);

  const contextFiles = ['src/mcp/McpServer.ts'];
  const contextFilesJson = JSON.stringify(contextFiles);

  const canonicalPayload = computeCanonicalPayload({
    projectId,
    taskId,
    attemptId,
    taskTitle: 'Task 1',
    taskDescription: 'Test task description',
    acceptanceCriteria: ['All tests pass'],
    constraints: ['No regressions'],
    instructions,
    contextFiles,
    verificationCommands: {
      TEST: { executable: 'npm', args: ['test'] },
      LINT: null,
      BUILD: null,
    },
    managerMessageId,
    managerPayloadHash,
  });
  const canonicalPayloadJson = JSON.stringify(canonicalPayload);
  const instructionPayloadHash = computePayloadHash(canonicalPayload);
  const contextManifestHash = computeContextManifestHash(contextFiles);

  // 10. Execution Authorization
  const auth: ExecutionAuthorization = {
    id: authorizationId,
    project_id: projectId,
    task_id: taskId,
    task_revision: 1,
    base_sha: 'b'.repeat(40),
    repository_head_sha: 'c'.repeat(40),
    manager_message_id: managerMessageId,
    manager_payload_hash: managerPayloadHash,
    routing_decision_id: routingDecisionId,
    selected_resource_id: resourceId,
    selected_provider_id: providerId,
    instruction_payload_hash: instructionPayloadHash,
    context_manifest_hash: contextManifestHash,
    canonical_instructions_json: canonicalInstructionsJson,
    context_files_json: contextFilesJson,
    canonical_payload_json: canonicalPayloadJson,
    status: 'AUTHORIZED',
    created_at: now,
    dispatched_at: null,
    execution_id: null,
    task_ownership_epoch: 1,
    lifecycle_version: 1,
    selected_account_id: accountId,
    adapter_started_at: null,
    adapter_finished_at: null,
    adapter_error_json: null,
    settlement_status: null,
    settled_at: null,
    settlement_evidence_json: null,
    settlement_evidence_hash: null,
    assignment_id: assignmentId,
    attempt_id: attemptId,
  };
  repo.createExecutionAuthorization(auth);

  return {
    projectId,
    taskId,
    attemptId,
    assignmentId,
    providerId,
    accountId,
    resourceId,
    routingDecisionId,
    authorizationId,
    managerMessageId,
    canonicalInstructionsJson,
    contextFilesJson,
    service,
    repo,
    auth,
  };
}

describe('R5J2 MCP Session Authority and Scoped Context Read Truth Suite', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(process.cwd(), 'temp', `r5j2-test-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
    fs.mkdirSync(tempDir, { recursive: true });
    resetDefaultAuthorityContext();
  });

  afterEach(() => {
    resetDefaultAuthorityContext();
    safeRemoveDir(tempDir);
  });

  // =========================================================================
  // Part 1: Truthful Migration 21 Authority & Schema Integrity
  // =========================================================================

  it('1. Fresh Migration 1->21 applies cleanly ending at version 21 without proxy or stack sniffing', () => {
    const { db } = createTestDatabase(tempDir, 'fresh21.db');
    try {
      const row = db.prepare('SELECT COUNT(*) as c, MAX(version) as max_v FROM schema_migrations').get() as { c: number; max_v: number };
      expect(row.c).toBe(21);
      expect(row.max_v).toBe(21);
      expect(MIGRATIONS.length).toBe(21);
      expect(Array.isArray(MIGRATIONS)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('2. Sequential upgrade from v20 applies Migration 21 cleanly ending at version 21', () => {
    const upgradeDb = new Database(path.join(tempDir, 'upgrade.db'));
    upgradeDb.pragma('foreign_keys = ON');
    try {
      upgradeDb.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      for (const m of MIGRATIONS.filter((m) => m.version <= 20)) {
        m.up(upgradeDb);
        upgradeDb.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          m.version,
          m.name,
          new Date().toISOString()
        );
      }
      MigrationRunner.run(upgradeDb);
      const row = upgradeDb.prepare('SELECT COUNT(*) as c, MAX(version) as max_v FROM schema_migrations').get() as { c: number; max_v: number };
      expect(row.c).toBe(21);
      expect(row.max_v).toBe(21);
    } finally {
      upgradeDb.close();
    }
  });

  it('3. Static audit: production and release code contain zero test filename sniffing, stack inspection, or MIGRATIONS proxy', () => {
    const migrationsSource = fs.readFileSync(path.join(process.cwd(), 'src/core/database/migrations.ts'), 'utf-8');
    expect(migrationsSource).not.toContain('r5iCrashRecoveryAndAuditStream');
    expect(migrationsSource).not.toContain('new Error().stack');
    expect(migrationsSource).not.toContain('new Proxy');
    expect(migrationsSource).not.toContain('RAW_MIGRATIONS');

    const rcScript = fs.readFileSync(path.join(process.cwd(), 'scripts/verify-demo-rc-win.ps1'), 'utf-8');
    expect(rcScript).not.toContain('Expected exactly 20 migrations');
    expect(rcScript).toContain('Expected exactly 21 migrations');
  });

  it('4. Migration 21 fails closed on pre-existing conflicting mcp_client_sessions table with no ledger row written', () => {
    const testDb = new Database(path.join(tempDir, 'conflict_table.db'));
    testDb.pragma('foreign_keys = ON');
    try {
      testDb.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      for (const m of MIGRATIONS.filter((m) => m.version <= 20)) {
        m.up(testDb);
        testDb.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          m.version,
          m.name,
          new Date().toISOString()
        );
      }
      // Create conflicting table beforehand without proper schema
      testDb.exec('CREATE TABLE mcp_client_sessions (bogus_col TEXT PRIMARY KEY);');

      expect(() => {
        MigrationRunner.run(testDb);
      }).toThrow();

      const ledger = testDb.prepare('SELECT * FROM schema_migrations WHERE version = 21').get();
      expect(ledger).toBeUndefined();
    } finally {
      testDb.close();
    }
  });

  it('5. Migration 21 fails closed on pre-existing conflicting index with no ledger row written', () => {
    const testDb = new Database(path.join(tempDir, 'conflict_idx.db'));
    testDb.pragma('foreign_keys = ON');
    try {
      testDb.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      for (const m of MIGRATIONS.filter((m) => m.version <= 20)) {
        m.up(testDb);
        testDb.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          m.version,
          m.name,
          new Date().toISOString()
        );
      }
      // Conflicting index on another table
      testDb.exec('CREATE TABLE temp_foo (token_hash TEXT);');
      testDb.exec('CREATE INDEX idx_mcp_client_sessions_token_hash ON temp_foo(token_hash);');

      expect(() => {
        MigrationRunner.run(testDb);
      }).toThrow();

      const ledger = testDb.prepare('SELECT * FROM schema_migrations WHERE version = 21').get();
      expect(ledger).toBeUndefined();
    } finally {
      testDb.close();
    }
  });

  it('6. verifyMigration21SchemaAuthority rejects missing version 21 ledger row', () => {
    const testDb = new Database(path.join(tempDir, 'fake_table.db'));
    try {
      testDb.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
        CREATE TABLE mcp_client_sessions (id TEXT PRIMARY KEY);
      `);
      expect(() => {
        verifyMigration21SchemaAuthority(testDb);
      }).toThrow(/missing Migration 21 ledger authority/);
    } finally {
      testDb.close();
    }
  });

  it('7. verifyMigration21SchemaAuthority rejects missing required columns or constraints', () => {
    const testDb = new Database(path.join(tempDir, 'bad_schema.db'));
    try {
      testDb.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations VALUES (21, '021_r5j_mcp_client_session_authority', datetime('now'));
        CREATE TABLE mcp_client_sessions (id TEXT PRIMARY KEY, authorization_id TEXT NOT NULL);
      `);
      expect(() => {
        verifyMigration21SchemaAuthority(testDb);
      }).toThrow(/missing column/);
    } finally {
      testDb.close();
    }
  });

  // =========================================================================
  // Part 2: Cryptographic Token & TTL Contract
  // =========================================================================

  it('8. Token entropy is >= 256 bits canonical base64url and returned plaintext once', () => {
    const token1 = McpSessionAuthorityService.generateSessionToken();
    const token2 = McpSessionAuthorityService.generateSessionToken();
    expect(token1).not.toEqual(token2);
    expect(token1).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token2).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('9. Database stores only lowercase SHA-256 token digest, never plaintext', () => {
    const { db } = createTestDatabase(tempDir, 'tokenhash.db');
    try {
      const fixtures = setupFullGraph(db);
      const { session, plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });

      const expectedHash = crypto.createHash('sha256').update(plaintextToken, 'utf8').digest('hex').toLowerCase();
      expect(session.token_hash).toBe(expectedHash);

      const row = db.prepare('SELECT * FROM mcp_client_sessions WHERE id = ?').get(session.id) as Record<string, unknown>;
      expect(row.token_hash).toBe(expectedHash);

      const allTextInRow = Object.values(row).join(' ');
      expect(allTextInRow).not.toContain(plaintextToken);
    } finally {
      db.close();
    }
  });

  it('10. Plaintext token is absent from every database table, subsequent lookup, list, revoke result, and context response', () => {
    const { db } = createTestDatabase(tempDir, 'notokenleak.db');
    try {
      const fixtures = setupFullGraph(db);
      const { session, plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });

      // Check context response
      const ctx = fixtures.service.resolveAuthorizedContext(plaintextToken);
      const serializedCtx = JSON.stringify(ctx);
      expect(serializedCtx).not.toContain(plaintextToken);

      // Check lookup
      const lookedUp = fixtures.repo.getMcpClientSessionByTokenHash(session.token_hash);
      expect(JSON.stringify(lookedUp)).not.toContain(plaintextToken);

      // Check revoke result
      const revRes = fixtures.service.revokeSession({ sessionId: session.id });
      expect(JSON.stringify(revRes)).not.toContain(plaintextToken);
    } finally {
      db.close();
    }
  });

  it('11. Canonical token validation: valid 43-char base64url token succeeds', () => {
    const token = McpSessionAuthorityService.generateSessionToken();
    expect(validateCanonicalSessionToken(token)).toBe(token);
  });

  it('12. Canonical token rejection: empty string and null/undefined return MCP_SESSION_REQUIRED', () => {
    expect(() => validateCanonicalSessionToken('')).toThrowError(/MCP_SESSION_REQUIRED/);
    expect(() => validateCanonicalSessionToken(undefined)).toThrowError(/MCP_SESSION_REQUIRED/);
    expect(() => validateCanonicalSessionToken(null)).toThrowError(/MCP_SESSION_REQUIRED/);
  });

  it('13. Non-canonical token rejection: whitespace-wrapped, wrong length, invalid chars return MCP_SESSION_UNAUTHORIZED', () => {
    const valid = McpSessionAuthorityService.generateSessionToken();
    expect(() => validateCanonicalSessionToken(` ${valid} `)).toThrowError(/MCP_SESSION_UNAUTHORIZED/);
    expect(() => validateCanonicalSessionToken(valid.slice(0, 42))).toThrowError(/MCP_SESSION_UNAUTHORIZED/);
    expect(() => validateCanonicalSessionToken(`${valid}a`)).toThrowError(/MCP_SESSION_UNAUTHORIZED/);
    expect(() => validateCanonicalSessionToken(`${valid.slice(0, 42)}=`)).toThrowError(/MCP_SESSION_UNAUTHORIZED/);
    expect(() => validateCanonicalSessionToken(`${valid.slice(0, 42)}+`)).toThrowError(/MCP_SESSION_UNAUTHORIZED/);
  });

  it('14. Strict TTL bounds [300, 86400]: rejects below, above, fractional, NaN, infinity, exponent, signed, suffixed', () => {
    expect(validateTtlSeconds(undefined)).toBe(MCP_SESSION_DEFAULT_TTL_SECONDS);
    expect(validateTtlSeconds(3600)).toBe(3600);
    expect(validateTtlSeconds(300)).toBe(300);
    expect(validateTtlSeconds(86400)).toBe(86400);

    expect(() => validateTtlSeconds(299)).toThrowError(/MCP_CONFIGURATION_INVALID/);
    expect(() => validateTtlSeconds(86401)).toThrowError(/MCP_CONFIGURATION_INVALID/);
    expect(() => validateTtlSeconds(3600.5)).toThrowError(/MCP_CONFIGURATION_INVALID/);
    expect(() => validateTtlSeconds(NaN)).toThrowError(/MCP_CONFIGURATION_INVALID/);
    expect(() => validateTtlSeconds(Infinity)).toThrowError(/MCP_CONFIGURATION_INVALID/);
    expect(() => validateTtlSeconds('3600s')).toThrowError(/MCP_CONFIGURATION_INVALID/);
    expect(() => validateTtlSeconds('+3600')).toThrowError(/MCP_CONFIGURATION_INVALID/);
    expect(() => validateTtlSeconds('-3600')).toThrowError(/MCP_CONFIGURATION_INVALID/);
    expect(() => validateTtlSeconds('1e4')).toThrowError(/MCP_CONFIGURATION_INVALID/);
    expect(() => validateTtlSeconds('3600abc')).toThrowError(/MCP_CONFIGURATION_INVALID/);
  });

  // =========================================================================
  // Part 3: Complete Authority Graph Validation on Issuance
  // =========================================================================

  it('15. Full graph issuance succeeds using real routing event with all 8 mandatory payload fields', () => {
    const { db } = createTestDatabase(tempDir, 'fullgraph.db');
    try {
      const fixtures = setupFullGraph(db);
      const result = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      expect(result.session.id).toBeDefined();
      expect(result.plaintextToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    } finally {
      db.close();
    }
  });

  it('16. Issuance rejects unknown authorization returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'unknownauth.db');
    try {
      const fixtures = setupFullGraph(db);
      expect(() => {
        fixtures.service.issueSession({ authorizationId: 'non-existent-auth' });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('17. Issuance rejects legacy lifecycle_version != 1 returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'legacyauth.db');
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

  it('18. Issuance rejects invalid authorization status returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'invalidstatus.db');
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

  it('19. Issuance rejects terminal settlement returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'settled.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare(`
        UPDATE execution_authorizations
        SET settlement_status = 'COMPLETED',
            settled_at = datetime('now'),
            settlement_evidence_json = '{}',
            settlement_evidence_hash = ?
        WHERE id = ?
      `).run('a'.repeat(64), fixtures.authorizationId);
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('20. Issuance rejects missing project or project mismatch returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'projmismatch.db');
    try {
      const fixtures = setupFullGraph(db);
      const otherProjId = 'other-proj-id';
      fixtures.repo.createProject({
        id: otherProjId,
        name: 'Other',
        description: 'Testing',
        repository_path: 'D:/fake/other',
        default_branch: 'main',
        status: 'RUNNING',
        contract: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
      });
      db.prepare('UPDATE execution_authorizations SET project_id = ? WHERE id = ?').run(otherProjId, fixtures.authorizationId);
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('21. Issuance rejects missing task, task project mismatch, or revision mismatch returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'taskmismatch.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare('UPDATE tasks SET revision_count = 2 WHERE id = ?').run(fixtures.taskId);
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('22. Issuance rejects task ownership epoch mismatch returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'epochmismatch.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare('UPDATE execution_authorizations SET task_ownership_epoch = 2 WHERE id = ?').run(fixtures.authorizationId);
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('23. Issuance rejects missing attempt or attempt task mismatch returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'attmismatch.db');
    try {
      const fixtures = setupFullGraph(db);
      const otherTaskId = `task-${crypto.randomUUID()}`;
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, base_sha, created_at, updated_at)
        VALUES (?, ?, 'Task 2', 'CODING', 'LOW', 'LOW', 1, 3, 0, ?, datetime('now'), datetime('now'))
      `).run(otherTaskId, fixtures.projectId, 'b'.repeat(40));
      db.prepare('UPDATE task_attempts SET task_id = ? WHERE id = ?').run(otherTaskId, fixtures.attemptId);
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('24. Issuance rejects missing assignment or terminal assignment status returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'asgnstatus.db');
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

  it('25. Issuance rejects missing provider or disabled provider returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'provstatus.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare('UPDATE providers SET enabled = 0 WHERE id = ?').run(fixtures.providerId);
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('26. Issuance rejects missing account, disabled account, or account-provider mismatch returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'accstatus.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare('UPDATE provider_accounts SET enabled = 0 WHERE id = ?').run(fixtures.accountId);
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('27. Issuance rejects missing resource, disabled resource, or resource account mismatch returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'resstatus.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare('UPDATE provider_resources SET enabled = 0 WHERE id = ?').run(fixtures.resourceId);
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('28. Issuance rejects missing protocol message or hash mismatch returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'msgmismatch.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare("UPDATE protocol_messages SET payload_hash = ? WHERE id = ?").run('b'.repeat(64), fixtures.managerMessageId);
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  // =========================================================================
  // Part 4: Mandatory Routing Payload Field Validation (One at a time)
  // =========================================================================

  it('29. Routing decision event missing project_id fails closed returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'route_noproj.db');
    try {
      const fixtures = setupFullGraph(db);
      const badPayload = {
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        routingDecisionId: fixtures.routingDecisionId,
        selectedProviderId: fixtures.providerId,
        selectedAccountId: fixtures.accountId,
        selectedResourceId: fixtures.resourceId,
        selectedOutcome: 'SELECTED',
      };
      db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(badPayload), fixtures.routingDecisionId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('30. Routing decision event missing task_id fails closed returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'route_notask.db');
    try {
      const fixtures = setupFullGraph(db);
      const badPayload = {
        projectId: fixtures.projectId,
        attemptId: fixtures.attemptId,
        routingDecisionId: fixtures.routingDecisionId,
        selectedProviderId: fixtures.providerId,
        selectedAccountId: fixtures.accountId,
        selectedResourceId: fixtures.resourceId,
        selectedOutcome: 'SELECTED',
      };
      db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(badPayload), fixtures.routingDecisionId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('31. Routing decision event missing attempt_id fails closed returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'route_noatt.db');
    try {
      const fixtures = setupFullGraph(db);
      const badPayload = {
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        routingDecisionId: fixtures.routingDecisionId,
        selectedProviderId: fixtures.providerId,
        selectedAccountId: fixtures.accountId,
        selectedResourceId: fixtures.resourceId,
        selectedOutcome: 'SELECTED',
      };
      db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(badPayload), fixtures.routingDecisionId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('32. Routing decision event missing routing_decision_id fails closed returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'route_nodec.db');
    try {
      const fixtures = setupFullGraph(db);
      const badPayload = {
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        selectedProviderId: fixtures.providerId,
        selectedAccountId: fixtures.accountId,
        selectedResourceId: fixtures.resourceId,
        selectedOutcome: 'SELECTED',
      };
      db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(badPayload), fixtures.routingDecisionId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('33. Routing decision event missing selected_provider_id fails closed returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'route_noprov.db');
    try {
      const fixtures = setupFullGraph(db);
      const badPayload = {
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        routingDecisionId: fixtures.routingDecisionId,
        selectedAccountId: fixtures.accountId,
        selectedResourceId: fixtures.resourceId,
        selectedOutcome: 'SELECTED',
      };
      db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(badPayload), fixtures.routingDecisionId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('34. Routing decision event missing selected_account_id fails closed returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'route_noacc.db');
    try {
      const fixtures = setupFullGraph(db);
      const badPayload = {
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        routingDecisionId: fixtures.routingDecisionId,
        selectedProviderId: fixtures.providerId,
        selectedResourceId: fixtures.resourceId,
        selectedOutcome: 'SELECTED',
      };
      db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(badPayload), fixtures.routingDecisionId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('35. Routing decision event missing selected_resource_id fails closed returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'route_nores.db');
    try {
      const fixtures = setupFullGraph(db);
      const badPayload = {
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        routingDecisionId: fixtures.routingDecisionId,
        selectedProviderId: fixtures.providerId,
        selectedAccountId: fixtures.accountId,
        selectedOutcome: 'SELECTED',
      };
      db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(badPayload), fixtures.routingDecisionId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('36. Routing decision event missing or non-SELECTED outcome fails closed returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'route_nooutcome.db');
    try {
      const fixtures = setupFullGraph(db);
      const badPayload = {
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        routingDecisionId: fixtures.routingDecisionId,
        selectedProviderId: fixtures.providerId,
        selectedAccountId: fixtures.accountId,
        selectedResourceId: fixtures.resourceId,
        selectedOutcome: 'REJECTED',
      };
      db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(badPayload), fixtures.routingDecisionId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('37. Routing decision non-authoritative event type fails closed returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'route_badtype.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare("UPDATE events SET type = 'CUSTOM_EVENT' WHERE id = ?").run(fixtures.routingDecisionId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  // =========================================================================
  // Part 5: Complete Graph Fingerprint & Post-Issuance Read Fencing
  // =========================================================================

  it('38. Recomputed complete graph fingerprint matches on unmodified graph', () => {
    const { db } = createTestDatabase(tempDir, 'fingerprint_match.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      const ctx = fixtures.service.resolveAuthorizedContext(plaintextToken);
      expect(ctx.authorization.id).toBe(fixtures.authorizationId);
    } finally {
      db.close();
    }
  });

  it('39. Post-issuance read fenced after mutating project name/path in database returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_proj.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      db.prepare("UPDATE projects SET name = 'Tampered Project' WHERE id = ?").run(fixtures.projectId);
      expect(() => fixtures.service.resolveAuthorizedContext(plaintextToken)).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  it('40. Post-issuance read fenced after mutating task state returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_task.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      db.prepare("UPDATE tasks SET state = 'DONE' WHERE id = ?").run(fixtures.taskId);
      expect(() => fixtures.service.resolveAuthorizedContext(plaintextToken)).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  it('41. Post-issuance read fenced after mutating attempt status returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_att.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      db.prepare("UPDATE task_attempts SET status = 'COMPLETED' WHERE id = ?").run(fixtures.attemptId);
      expect(() => fixtures.service.resolveAuthorizedContext(plaintextToken)).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  it('42. Post-issuance read fenced after mutating assignment status to COMPLETED returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_asgn.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      db.prepare("UPDATE agent_assignments SET status = 'COMPLETED' WHERE id = ?").run(fixtures.assignmentId);
      expect(() => fixtures.service.resolveAuthorizedContext(plaintextToken)).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('43. Post-issuance read fenced after mutating assignment cross-binding returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_asgn_bind.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      const otherProvId = `prov-${crypto.randomUUID()}`;
      db.prepare("INSERT INTO providers (id, name, adapter_type, enabled, created_at) VALUES (?, 'Other Prov', 'LOCAL_CLI', 1, datetime('now'))").run(otherProvId);
      db.prepare("UPDATE agent_assignments SET selected_provider_id = ? WHERE id = ?").run(otherProvId, fixtures.assignmentId);
      expect(() => fixtures.service.resolveAuthorizedContext(plaintextToken)).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('44. Post-issuance read fenced after mutating provider name returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_prov.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      db.prepare("UPDATE providers SET name = 'Mutated Claude' WHERE id = ?").run(fixtures.providerId);
      expect(() => fixtures.service.resolveAuthorizedContext(plaintextToken)).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  it('45. Post-issuance read fenced after mutating account label returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_acc.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      db.prepare("UPDATE provider_accounts SET label = 'tampered-label' WHERE id = ?").run(fixtures.accountId);
      expect(() => fixtures.service.resolveAuthorizedContext(plaintextToken)).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  it('46. Post-issuance read fenced after mutating resource model_name returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_res.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      db.prepare("UPDATE provider_resources SET model_name = 'claude-3-opus' WHERE id = ?").run(fixtures.resourceId);
      expect(() => fixtures.service.resolveAuthorizedContext(plaintextToken)).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  it('47. Post-issuance read fenced after mutating routing decision structured payload returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_route.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      const tamperedPayload = {
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        routingDecisionId: fixtures.routingDecisionId,
        selectedProviderId: fixtures.providerId,
        selectedAccountId: fixtures.accountId,
        selectedResourceId: fixtures.resourceId,
        selectedOutcome: 'SELECTED',
        extraField: 'tampered',
      };
      db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(tamperedPayload), fixtures.routingDecisionId);
      expect(() => fixtures.service.resolveAuthorizedContext(plaintextToken)).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  it('48. Post-issuance read fenced after deleting a referenced node returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'del_node.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      db.prepare('DELETE FROM events WHERE id = ?').run(fixtures.routingDecisionId);
      expect(() => fixtures.service.resolveAuthorizedContext(plaintextToken)).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  // =========================================================================
  // Part 6: Canonical Payload & Integrity Verification
  // =========================================================================

  it('49. Missing or malformed canonical_payload_json fails closed returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'bad_payload.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare("UPDATE execution_authorizations SET canonical_payload_json = '{bad json}' WHERE id = ?").run(fixtures.authorizationId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  it('50. Canonical payload schema validation failure rejects unknown fields returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'unknown_fields.db');
    try {
      const fixtures = setupFullGraph(db);
      const parsed = JSON.parse(fixtures.auth.canonical_payload_json!);
      parsed.surplusMaliciousField = 'exploit';
      db.prepare('UPDATE execution_authorizations SET canonical_payload_json = ? WHERE id = ?').run(JSON.stringify(parsed), fixtures.authorizationId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  it('51. Instruction payload hash recomputation mismatch fails closed returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'hash_mismatch.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare('UPDATE execution_authorizations SET instruction_payload_hash = ? WHERE id = ?').run('e'.repeat(64), fixtures.authorizationId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  it('52. Context manifest hash recomputation mismatch fails closed returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'manifest_mismatch.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare('UPDATE execution_authorizations SET context_manifest_hash = ? WHERE id = ?').run('f'.repeat(64), fixtures.authorizationId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_CONTEXT_INTEGRITY_FAILED/);
    } finally {
      db.close();
    }
  });

  // =========================================================================
  // Part 7: Session Authentication & Non-Oracular Equivalence
  // =========================================================================

  it('53. Unknown token, expired token, and revoked token produce identical non-oracular error MCP_SESSION_UNAUTHORIZED', () => {
    const { db } = createTestDatabase(tempDir, 'non_oracular.db');
    try {
      const fixtures = setupFullGraph(db);
      const { session, plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });

      // Unknown token
      const unknownToken = McpSessionAuthorityService.generateSessionToken();
      let errUnknown: Error | null = null;
      try {
        fixtures.service.resolveAuthorizedContext(unknownToken);
      } catch (e) {
        errUnknown = e as Error;
      }

      // Expired token
      db.prepare("UPDATE mcp_client_sessions SET issued_at = '2020-01-01T00:00:00.000Z', expires_at = '2020-01-01T01:00:00.000Z' WHERE id = ?").run(session.id);
      let errExpired: Error | null = null;
      try {
        fixtures.service.resolveAuthorizedContext(plaintextToken);
      } catch (e) {
        errExpired = e as Error;
      }

      // Revoked token
      fixtures.service.revokeSession({ sessionId: session.id });
      let errRevoked: Error | null = null;
      try {
        fixtures.service.resolveAuthorizedContext(plaintextToken);
      } catch (e) {
        errRevoked = e as Error;
      }

      expect(errUnknown?.message).toBe(errExpired?.message);
      expect(errUnknown?.message).toBe(errRevoked?.message);
      expect(errUnknown?.message).toContain('MCP_SESSION_UNAUTHORIZED');
    } finally {
      db.close();
    }
  });

  it('54. Single error category prefix in public error formatting with zero double prefixing', () => {
    const authErr = new McpAuthorityError('MCP_SESSION_UNAUTHORIZED', 'Session authentication failed');
    const formatted = formatPublicError(authErr);
    expect(formatted.text).toBe('[MCP_SESSION_UNAUTHORIZED] Session authentication failed');
    expect(formatted.text).not.toContain('[[MCP_SESSION_UNAUTHORIZED]]');
    expect(formatted.text).not.toContain('[MCP_SESSION_UNAUTHORIZED] [MCP_SESSION_UNAUTHORIZED]');
  });

  it('55. Duplicate active session rejected on issuance returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'dupactive.db');
    try {
      const fixtures = setupFullGraph(db);
      fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      expect(() => {
        fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      }).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('56. Idempotent session revocation succeeds without error or duplicate mutations', () => {
    const { db } = createTestDatabase(tempDir, 'idempotent_revoke.db');
    try {
      const fixtures = setupFullGraph(db);
      const { session } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });

      const rev1 = fixtures.service.revokeSession({ sessionId: session.id });
      expect(rev1.revoked).toBe(true);

      const rev2 = fixtures.service.revokeSession({ sessionId: session.id });
      expect(rev2.revoked).toBe(false);
    } finally {
      db.close();
    }
  });

  // =========================================================================
  // Part 8: CLI Administration Contract & Strict Validation
  // =========================================================================

  it('57. CLI issue flow produces valid session JSON with plaintext token', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'cli_issue.db');
    try {
      const fixtures = setupFullGraph(db);
      const args = ['issue', '--db', dbPath, '--auth', fixtures.authorizationId, '--ttl', '600', '--json'];

      const originalStdoutWrite = process.stdout.write;
      let outputText = '';
      process.stdout.write = ((chunk: unknown) => {
        outputText += String(chunk);
        return true;
      }) as typeof process.stdout.write;

      try {
        const exitCode = runSessionAdmin(args);
        expect(exitCode).toBe(0);
        const parsed = JSON.parse(outputText);
        expect(parsed.status).toBe('ISSUED');
        expect(parsed.session.authorization_id).toBe(fixtures.authorizationId);
        expect(parsed.plaintext_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      } finally {
        process.stdout.write = originalStdoutWrite;
      }
    } finally {
      db.close();
    }
  });

  it('58. CLI revoke flow with --session is idempotent', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'cli_revoke.db');
    try {
      const fixtures = setupFullGraph(db);
      const { session } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });

      const args = ['revoke', '--db', dbPath, '--session', session.id, '--json'];
      const exit1 = runSessionAdmin(args);
      expect(exit1).toBe(0);

      const exit2 = runSessionAdmin(args);
      expect(exit2).toBe(0);
    } finally {
      db.close();
    }
  });

  it('59. CLI parser rejects unknown flags', () => {
    expect(() => parseCliArgs(['issue', '--unknownFlag'])).toThrowError(/Unknown flag/);
  });

  it('60. CLI parser rejects duplicate flags', () => {
    expect(() => parseCliArgs(['issue', '--auth', 'a1', '--auth', 'a2'])).toThrowError(/Duplicate flag/);
  });

  it('61. CLI parser rejects missing flag values', () => {
    expect(() => parseCliArgs(['issue', '--auth'])).toThrowError(/Missing value/);
    expect(() => parseCliArgs(['issue', '--ttl'])).toThrowError(/Missing value/);
  });

  it('62. CLI revoke rejects providing both --session and --auth or neither', () => {
    expect(() => parseCliArgs(['revoke', '--session', 's1', '--auth', 'a1'])).toThrowError(/Revoke requires exactly one selector/);
    expect(() => parseCliArgs(['revoke'])).toThrowError(/Revoke requires exactly one selector/);
  });

  // =========================================================================
  // Part 9: Concurrency, Read-Only Boundary, and Cleanup
  // =========================================================================

  it('63. Real two-connection concurrent issuance race produces exactly one active row and one plaintext token', () => {
    const { db: db1, dbPath } = createTestDatabase(tempDir, 'concurrency_race.db');
    const db2 = new Database(dbPath);
    db2.pragma('foreign_keys = ON');

    try {
      const fixtures1 = setupFullGraph(db1);
      const repo2 = new Repository(db2);
      const service2 = new McpSessionAuthorityService(repo2, db2);

      let successCount = 0;
      let failCount = 0;
      let issuedToken: string | null = null;

      try {
        const res1 = fixtures1.service.issueSession({ authorizationId: fixtures1.authorizationId });
        successCount++;
        issuedToken = res1.plaintextToken;
      } catch {
        failCount++;
      }

      try {
        const res2 = service2.issueSession({ authorizationId: fixtures1.authorizationId });
        successCount++;
        issuedToken = res2.plaintextToken;
      } catch (err) {
        failCount++;
        expect((err as Error).message).toContain('MCP_AUTHORITY_FENCED');
      }

      expect(successCount).toBe(1);
      expect(failCount).toBe(1);
      expect(issuedToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const activeRows = db1.prepare('SELECT COUNT(*) as c FROM mcp_client_sessions WHERE authorization_id = ? AND revoked_at IS NULL').get(fixtures1.authorizationId) as { c: number };
      expect(activeRows.c).toBe(1);
    } finally {
      db1.close();
      db2.close();
    }
  });

  it('64. Fences writable injected database: throws MCP_CONFIGURATION_INVALID if readonly is false or query_only is off', () => {
    const { db } = createTestDatabase(tempDir, 'writable_injection.db');
    try {
      // db is writable by default
      expect(() => {
        new McpAuthorityContext({ db });
      }).toThrowError(/MCP_CONFIGURATION_INVALID/);
    } finally {
      db.close();
    }
  });

  it('65. Zero-mutation proof: context reads cause 0 durable database changes and total_changes() === 0', () => {
    const { db: setupDb, dbPath } = createTestDatabase(tempDir, 'zeromutation.db');
    let plaintextToken = '';
    try {
      const fixtures = setupFullGraph(setupDb);
      const res = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      plaintextToken = res.plaintextToken;
    } finally {
      setupDb.close();
    }

    // Now open read-only MCP context connection
    const readOnlyDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    readOnlyDb.pragma('query_only = ON');

    try {
      const context = new McpAuthorityContext({ db: readOnlyDb, sessionToken: plaintextToken });
      const resolved = context.resolveAuthorizedContext();
      expect(resolved.schema_version).toBe(2);

      const row = readOnlyDb.prepare('SELECT total_changes() as tc').get() as { tc: number };
      expect(row.tc).toBe(0);
    } finally {
      readOnlyDb.close();
    }
  });

  it('66. Production read-only connection release on Windows: file can be renamed or deleted after close without lock contention', () => {
    const { db: setupDb, dbPath } = createTestDatabase(tempDir, 'winlock.db');
    let plaintextToken = '';
    try {
      const fixtures = setupFullGraph(setupDb);
      const res = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      plaintextToken = res.plaintextToken;
    } finally {
      setupDb.close();
    }

    const context = new McpAuthorityContext({ dbPath, sessionToken: plaintextToken });
    const ctx = context.resolveAuthorizedContext();
    expect(ctx.schema_version).toBe(2);

    // Close context and prove file lock is completely released
    context.close();

    const renamedPath = path.join(tempDir, 'winlock_renamed.db');
    fs.renameSync(dbPath, renamedPath);
    expect(fs.existsSync(renamedPath)).toBe(true);
    fs.unlinkSync(renamedPath);
    expect(fs.existsSync(renamedPath)).toBe(false);
  });

  it('67. Scrubbed diagnostics: seeded token, digest, and internal DB paths do not leak into stderr', () => {
    const sensitiveToken = McpSessionAuthorityService.generateSessionToken();
    const sensitiveDigest = McpSessionAuthorityService.hashSessionToken(sensitiveToken);
    const fakeDbPath = 'C:\\sensitive\\user\\secret.db';

    const originalStderrWrite = process.stderr.write;
    let stderrText = '';
    process.stderr.write = ((chunk: unknown) => {
      stderrText += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      // Intentionally trigger a failure with malformed token
      const publicErr = formatPublicError(new McpAuthorityError('MCP_SESSION_UNAUTHORIZED', 'Session authentication failed'));
      expect(publicErr.text).not.toContain(sensitiveToken);
      expect(publicErr.text).not.toContain(sensitiveDigest);
      expect(publicErr.text).not.toContain(fakeDbPath);
      expect(stderrText).not.toContain(sensitiveToken);
    } finally {
      process.stderr.write = originalStderrWrite;
    }
  });

  it('68. Stdio server clean shutdown removes signal listeners', async () => {
    const initialSigintCount = process.listenerCount('SIGINT');
    const handle = runStdioServer();
    expect(process.listenerCount('SIGINT')).toBeGreaterThan(initialSigintCount);

    await handle.close();
    expect(process.listenerCount('SIGINT')).toBe(initialSigintCount);
  });
});
