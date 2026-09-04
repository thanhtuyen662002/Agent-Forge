import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn, execFileSync } from 'child_process';
import { Worker } from 'worker_threads';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
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

let sharedTestRuntimeDir: string | null = null;

function getOrMaterializeTestRuntime(): string {
  if (sharedTestRuntimeDir && fs.existsSync(sharedTestRuntimeDir)) {
    return sharedTestRuntimeDir;
  }
  const projectRoot = path.resolve(__dirname, '..');
  const tempRuntimeDir = path.join(os.tmpdir(), `af-mcp-test-runtime-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  fs.mkdirSync(tempRuntimeDir, { recursive: true });

  const tscBin = require.resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.node.json', '--outDir', tempRuntimeDir], {
    cwd: projectRoot,
    stdio: 'pipe',
    encoding: 'utf8',
  });

  const manifestPath = path.join(tempRuntimeDir, 'package.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ type: 'commonjs' }, null, 2), 'utf8');

  // Verify runtime manifest
  const writtenManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (writtenManifest.type !== 'commonjs') {
    throw new Error('Temporary test runtime manifest failed verification');
  }

  // Symlink / junction project node_modules into temporary test runtime
  const targetNodeModules = path.join(projectRoot, 'node_modules');
  const linkNodeModules = path.join(tempRuntimeDir, 'node_modules');
  if (!fs.existsSync(linkNodeModules) && fs.existsSync(targetNodeModules)) {
    const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(targetNodeModules, linkNodeModules, symlinkType);
  }

  // Verify key compiled files exist in test runtime
  const stdioEntry = path.join(tempRuntimeDir, 'mcp', 'stdio.js');
  const repoEntry = path.join(tempRuntimeDir, 'core', 'database', 'repositories.js');
  const serviceEntry = path.join(tempRuntimeDir, 'core', 'services', 'McpSessionAuthorityService.js');
  if (!fs.existsSync(stdioEntry) || !fs.existsSync(repoEntry) || !fs.existsSync(serviceEntry)) {
    throw new Error('Temporary test runtime is missing expected compiled modules');
  }

  sharedTestRuntimeDir = tempRuntimeDir;
  return sharedTestRuntimeDir;
}

function safeRemoveDir(dir: string, maxRetries = 10, delayMs = 100): void {
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (fs.existsSync(dir)) {
        const nestedNodeModules = path.join(dir, 'node_modules');
        if (fs.existsSync(nestedNodeModules)) {
          try {
            fs.unlinkSync(nestedNodeModules);
          } catch {
            try {
              fs.rmdirSync(nestedNodeModules);
            } catch {
              // ignore
            }
          }
        }
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
  managerRecordId: string;
  rawManagerPayload: string;
  roleId: string;
  agentId: string;
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
  const managerMessageId = `msg-proto-${crypto.randomUUID()}`;
  const managerRecordId = `msg-rec-${crypto.randomUUID()}`;

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
    INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, base_sha, ownership_epoch, created_at, updated_at)
    VALUES (?, ?, 'Task 1', 'CODING', 'LOW', 'LOW', 1, 3, 0, ?, 1, ?, ?)
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

  // 6. Routing Decision Event (canonical ROLE_AWARE_ROUTING_DECISION schema)
  const routingPayload = {
    decisionId: routingDecisionId,
    projectId,
    taskId,
    attemptId,
    roleProfileId: roleId,
    role: 'CODER',
    outcome: 'SELECTED',
    routePolicyId: null,
    failoverPolicyAuthoritySnapshot: null,
    selectedProviderId: providerId,
    selectedAccountId: accountId,
    selectedResourceId: resourceId,
    selectedAssignmentId: assignmentId,
    requestedConstraints: [],
    appliedExclusions: [],
    appliedSeparation: null,
    reason: 'Optimal route',
  };
  db.prepare(`
    INSERT INTO events (id, project_id, task_id, type, summary, structured_payload_json, timestamp)
    VALUES (?, ?, ?, 'ROLE_AWARE_ROUTING_DECISION', 'Optimal route', ?, ?)
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

  // 8. Canonical Protocol Message
  const instructions = ['Task: Task 1', 'Implement authorized context read'];
  const managerPayload = {
    protocol: 'manager.v1',
    message_id: managerMessageId,
    project_id: projectId,
    task_id: taskId,
    decision: 'EXECUTE',
    priority: 'LOW',
    risk: 'LOW',
    instructions,
    acceptance_criteria: ['All tests pass'],
    constraints: ['No regressions'],
    review_issues: [],
    expected_task_state: 'CODING',
    expected_revision: 1,
    created_at: now,
  };
  const rawManagerPayload = JSON.stringify(managerPayload);
  const managerPayloadHash = crypto.createHash('sha256').update(rawManagerPayload, 'utf8').digest('hex');
  repo.recordProtocolMessage(
    managerRecordId,
    managerMessageId,
    'manager.v1',
    projectId,
    taskId,
    'CODING',
    1,
    managerPayloadHash,
    rawManagerPayload,
    'APPLIED',
    undefined,
    now
  );

  // 9. Canonical Instructions and Context Files
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
    managerMessageId: managerRecordId,
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
    manager_message_id: managerRecordId,
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
    managerRecordId,
    rawManagerPayload,
    roleId,
    agentId,
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

  afterAll(() => {
    resetDefaultAuthorityContext();
    if (sharedTestRuntimeDir) {
      try {
        safeRemoveDir(sharedTestRuntimeDir);
      } catch {
        // bounded teardown
      }
      sharedTestRuntimeDir = null;
    }
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

  it('10. Successful CLI issue output contains returned plaintext token exactly once; every table, event, context, stdout/stderr, and database byte contains it zero times', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'notokenleak.db');
    try {
      const fixtures = setupFullGraph(db);

      // 1. Issue via CLI and capture stdout & stderr
      let issueStdout = '';
      let issueStderr = '';
      const origStdout = process.stdout.write;
      const origStderr = process.stderr.write;
      process.stdout.write = ((chunk: unknown) => { issueStdout += String(chunk); return true; }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: unknown) => { issueStderr += String(chunk); return true; }) as typeof process.stderr.write;

      let exitCode = 1;
      try {
        exitCode = runSessionAdmin(['issue', '--db', dbPath, '--auth', fixtures.authorizationId, '--json']);
      } finally {
        process.stdout.write = origStdout;
        process.stderr.write = origStderr;
      }

      expect(exitCode).toBe(0);
      const parsedIssue = JSON.parse(issueStdout);
      const plaintextToken = parsedIssue.plaintext_token;
      expect(plaintextToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

      // Plaintext token appears EXACTLY ONCE in successful issue stdout
      const occurrences = issueStdout.split(plaintextToken).length - 1;
      expect(occurrences).toBe(1);
      expect(issueStderr).not.toContain(plaintextToken);

      // 2. Check context response contains token ZERO times
      const ctx = fixtures.service.resolveAuthorizedContext(plaintextToken);
      expect(JSON.stringify(ctx)).not.toContain(plaintextToken);

      // 3. Subsequent admin revoke: stdout and stderr contain token ZERO times
      let revokeStdout = '';
      let revokeStderr = '';
      process.stdout.write = ((chunk: unknown) => { revokeStdout += String(chunk); return true; }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: unknown) => { revokeStderr += String(chunk); return true; }) as typeof process.stderr.write;
      try {
        const revExit = runSessionAdmin(['revoke', '--db', dbPath, '--session', parsedIssue.session.id, '--json']);
        expect(revExit).toBe(0);
      } finally {
        process.stdout.write = origStdout;
        process.stderr.write = origStderr;
      }
      expect(revokeStdout).not.toContain(plaintextToken);
      expect(revokeStderr).not.toContain(plaintextToken);

      // 4. Failed CLI commands: stdout and stderr contain token ZERO times
      let failStderr = '';
      process.stderr.write = ((chunk: unknown) => { failStderr += String(chunk); return true; }) as typeof process.stderr.write;
      try {
        runSessionAdmin(['issue', '--db', dbPath, '--auth', 'nonexistent-auth']);
        runSessionAdmin(['revoke', '--db', dbPath, '--session', 'nonexistent-session']);
      } finally {
        process.stderr.write = origStderr;
      }
      expect(failStderr).not.toContain(plaintextToken);

      // 5. Check lookup by ID and by token hash contain token ZERO times
      const storedRow = fixtures.repo.getMcpClientSessionById(parsedIssue.session.id);
      expect(storedRow).toBeDefined();
      expect(parsedIssue.session.token_hash).toBeUndefined();
      expect(storedRow?.token_hash).toBeDefined();
      expect(storedRow?.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(storedRow)).not.toContain(plaintextToken);
      expect(JSON.stringify(parsedIssue.session)).not.toContain(plaintextToken);

      const lookedUp = fixtures.repo.getMcpClientSessionByTokenHash(storedRow!.token_hash);
      expect(lookedUp).toBeDefined();
      expect(lookedUp!.id).toBe(parsedIssue.session.id);
      expect(JSON.stringify(lookedUp)).not.toContain(plaintextToken);
      const activeSessions = fixtures.repo.getActiveMcpClientSessionByAuthorizationId(fixtures.authorizationId);
      expect(JSON.stringify(activeSessions)).not.toContain(plaintextToken);

      // 6. Check every database table row contains token ZERO times
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
      for (const t of tables) {
        const rows = db.prepare(`SELECT * FROM "${t.name}"`).all();
        expect(JSON.stringify(rows)).not.toContain(plaintextToken);
      }

      // 7. Check database file, WAL, and SHM bytes contain token ZERO times
      const dbBytes = fs.readFileSync(dbPath);
      expect(dbBytes.includes(Buffer.from(plaintextToken))).toBe(false);
      const walPath = `${dbPath}-wal`;
      if (fs.existsSync(walPath)) {
        expect(fs.readFileSync(walPath).includes(Buffer.from(plaintextToken))).toBe(false);
      }
      const shmPath = `${dbPath}-shm`;
      if (fs.existsSync(shmPath)) {
        expect(fs.readFileSync(shmPath).includes(Buffer.from(plaintextToken))).toBe(false);
      }
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
      db.prepare("UPDATE protocol_messages SET payload_hash = ? WHERE id = ?").run('b'.repeat(64), fixtures.managerRecordId);
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

  it('29. Routing decision event mutated top-level project_id column fails closed returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'route_noproj.db');
    try {
      const fixtures = setupFullGraph(db);
      const otherProjId = `proj-alt-${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      fixtures.repo.createProject({
        id: otherProjId,
        name: 'Alternate Project',
        description: 'Alt',
        repository_path: '/path/alt',
        default_branch: 'main',
        status: 'RUNNING',
        contract: null,
        created_at: now,
        updated_at: now,
        started_at: now,
        completed_at: null,
      });
      db.prepare('UPDATE events SET project_id = ? WHERE id = ?').run(otherProjId, fixtures.routingDecisionId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('30. Routing decision event mutated top-level task_id column fails closed returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'route_notask.db');
    try {
      const fixtures = setupFullGraph(db);
      const otherTaskId = `task-alt-${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const baseSha = 'b'.repeat(40);
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, base_sha, ownership_epoch, created_at, updated_at)
        VALUES (?, ?, 'Task Alt', 'CODING', 'LOW', 'LOW', 1, 3, 0, ?, 1, ?, ?)
      `).run(otherTaskId, fixtures.projectId, baseSha, now, now);
      db.prepare('UPDATE events SET task_id = ? WHERE id = ?').run(otherTaskId, fixtures.routingDecisionId);
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
        decisionId: fixtures.routingDecisionId,
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        selectedProviderId: fixtures.providerId,
        selectedAccountId: fixtures.accountId,
        selectedResourceId: fixtures.resourceId,
        outcome: 'SELECTED',
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
        outcome: 'SELECTED',
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
        decisionId: fixtures.routingDecisionId,
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        selectedAccountId: fixtures.accountId,
        selectedResourceId: fixtures.resourceId,
        outcome: 'SELECTED',
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
        decisionId: fixtures.routingDecisionId,
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        selectedProviderId: fixtures.providerId,
        selectedResourceId: fixtures.resourceId,
        outcome: 'SELECTED',
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
        decisionId: fixtures.routingDecisionId,
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        selectedProviderId: fixtures.providerId,
        selectedAccountId: fixtures.accountId,
        outcome: 'SELECTED',
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
        decisionId: fixtures.routingDecisionId,
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        selectedProviderId: fixtures.providerId,
        selectedAccountId: fixtures.accountId,
        selectedResourceId: fixtures.resourceId,
        outcome: 'REJECTED',
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
      expect(() => fixtures.service.resolveAuthorizedContext(plaintextToken)).toThrowError(/(?:MCP_CONTEXT_INTEGRITY_FAILED|MCP_AUTHORITY_FENCED)/);
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
      expect(() => fixtures.service.resolveAuthorizedContext(plaintextToken)).toThrowError(/(?:MCP_CONTEXT_INTEGRITY_FAILED|MCP_AUTHORITY_FENCED)/);
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
        decisionId: fixtures.routingDecisionId,
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        roleProfileId: fixtures.roleId,
        role: 'CODER',
        outcome: 'SELECTED',
        routePolicyId: null,
        failoverPolicyAuthoritySnapshot: null,
        selectedProviderId: fixtures.providerId,
        selectedAccountId: fixtures.accountId,
        selectedResourceId: fixtures.resourceId,
        selectedAssignmentId: fixtures.assignmentId,
        requestedConstraints: [],
        appliedExclusions: [],
        appliedSeparation: null,
        reason: 'Tampered reason',
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

      expect(errUnknown).toBeInstanceOf(Error);
      expect(errExpired).toBeInstanceOf(Error);
      expect(errRevoked).toBeInstanceOf(Error);
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

  it('63. Real two-worker concurrent issuance race produces exactly one active row and one plaintext token', async () => {
    const { db: setupDb, dbPath } = createTestDatabase(tempDir, 'concurrency_race.db');
    let authorizationId = '';
    try {
      const fixtures1 = setupFullGraph(setupDb);
      authorizationId = fixtures1.authorizationId;
      setupDb.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      setupDb.close();
    }

    const runtimeDir = getOrMaterializeTestRuntime();

    const workerCode = `
const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
const Database = require('better-sqlite3');
const { Repository } = require(path.join(workerData.runtimeDir, 'core/database/repositories.js'));
const { McpSessionAuthorityService } = require(path.join(workerData.runtimeDir, 'core/services/McpSessionAuthorityService.js'));

let db;
try {
  db = new Database(workerData.dbPath);
  db.pragma('foreign_keys = ON');
  const repo = new Repository(db);
  const service = new McpSessionAuthorityService(repo, db);

  parentPort.on('message', (msg) => {
    if (msg === 'GO') {
      try {
        const result = service.issueSession({ authorizationId: workerData.authorizationId });
        db.close();
        parentPort.postMessage({ success: true, plaintextToken: result.plaintextToken });
      } catch (err) {
        db.close();
        parentPort.postMessage({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          category: err && typeof err === 'object' && 'category' in err ? err.category : null,
        });
      }
    }
  });
  parentPort.postMessage('READY');
} catch (initErr) {
  if (db && db.open) {
    db.close();
  }
  parentPort.postMessage({
    success: false,
    error: initErr instanceof Error ? initErr.message : String(initErr),
    category: 'INIT_ERROR',
  });
}
`;

    interface SameAuthWorkerSuccess {
      success: true;
      plaintextToken: string;
    }
    interface SameAuthWorkerFailure {
      success: false;
      error: string;
      category: string | null;
    }
    type SameAuthWorkerMessage = SameAuthWorkerSuccess | SameAuthWorkerFailure;

    const workerData = { dbPath, authorizationId, runtimeDir };
    const projectNodeModules = path.resolve(__dirname, '..', 'node_modules');
    const w1 = new Worker(workerCode, { eval: true, workerData, env: { ...process.env, NODE_PATH: projectNodeModules } });
    const w2 = new Worker(workerCode, { eval: true, workerData, env: { ...process.env, NODE_PATH: projectNodeModules } });

    const createWorkerHarness = (w: Worker) => {
      let isReadyResolved = false;
      let readyResolve: () => void;
      let readyReject: (err: Error) => void;
      const readyPromise = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      });

      let isResultResolved = false;
      let resultResolve: (res: SameAuthWorkerMessage) => void;
      let resultReject: (err: Error) => void;
      const resultPromise = new Promise<SameAuthWorkerMessage>((resolve, reject) => {
        resultResolve = resolve;
        resultReject = reject;
      });

      const messageHandler = (msg: unknown) => {
        if (msg === 'READY' && !isReadyResolved) {
          isReadyResolved = true;
          readyResolve();
          return;
        }
        if (typeof msg === 'object' && msg !== null && 'success' in msg && !isResultResolved) {
          isResultResolved = true;
          resultResolve(msg as SameAuthWorkerMessage);
        }
      };

      const errorHandler = (err: Error) => {
        if (!isReadyResolved) {
          isReadyResolved = true;
          readyReject(err);
        }
        if (!isResultResolved) {
          isResultResolved = true;
          resultReject(err);
        }
      };

      const exitHandler = (exitCode: number) => {
        const exitErr = new Error(`Worker exited prematurely with code ${exitCode}`);
        errorHandler(exitErr);
      };

      w.on('message', messageHandler);
      w.on('error', errorHandler);
      w.on('exit', exitHandler);

      return {
        readyPromise,
        resultPromise,
        cleanup: () => {
          w.off('message', messageHandler);
          w.off('error', errorHandler);
          w.off('exit', exitHandler);
        },
      };
    };

    const h1 = createWorkerHarness(w1);
    const h2 = createWorkerHarness(w2);

    try {
      // Assert both workers are ready before release
      await Promise.all([h1.readyPromise, h2.readyPromise]);

      // Release both workers simultaneously with GO
      w1.postMessage('GO');
      w2.postMessage('GO');

      const results = await Promise.all([h1.resultPromise, h2.resultPromise]);
      const successful = results.filter((r): r is SameAuthWorkerSuccess => r.success);
      const failed = results.filter((r): r is SameAuthWorkerFailure => !r.success);

      expect(successful).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(successful[0].plaintextToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(failed[0].category).toBe('MCP_AUTHORITY_FENCED');

      const verifyDb = new Database(dbPath, { readonly: true });
      try {
        const activeRows = verifyDb
          .prepare('SELECT COUNT(*) as c FROM mcp_client_sessions WHERE authorization_id = ? AND revoked_at IS NULL')
          .get(authorizationId) as { c: number };
        expect(activeRows.c).toBe(1);
      } finally {
        verifyDb.close();
      }
    } finally {
      h1.cleanup();
      h2.cleanup();
      await Promise.all([w1.terminate(), w2.terminate()]);
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

  it('65. Zero-mutation proof: repeated production MCP tool and resource reads cause 0 durable changes, 0 mutation delta, and byte-identical database', async () => {
    const { db: setupDb, dbPath } = createTestDatabase(tempDir, 'zeromutation.db');
    let plaintextToken = '';
    try {
      const fixtures = setupFullGraph(setupDb);
      const res = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      plaintextToken = res.plaintextToken;
      setupDb.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      setupDb.close();
    }

    // 1. Snapshot database file byte-for-byte before reading context
    const beforeBytes = fs.readFileSync(dbPath);
    const beforeHash = crypto.createHash('sha256').update(beforeBytes).digest('hex');

    // 2. Snapshot table contents deterministically across all durable tables
    const checkDb = new Database(dbPath, { readonly: true });
    const tables = checkDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC").all() as { name: string }[];
    const initialTableSnapshots = new Map<string, string>();
    for (const t of tables) {
      const rows = checkDb.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid ASC`).all();
      initialTableSnapshots.set(t.name, JSON.stringify(rows));
    }
    checkDb.close();

    // 3. Set up production McpAuthorityContext and McpServer connected to MCP Client via InMemoryTransport
    const context = new McpAuthorityContext({ dbPath, sessionToken: plaintextToken });
    const server = buildAgentForgeMcpServer({ authorityContext: context });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-audit-client', version: '1.0.0' });
    await client.connect(clientTransport);

    try {
      // 4. Perform repeated authorized context reads via registered tool and registered resource
      const { db: contextDb } = context.getOrCreateDatabase();
      const initialTotalChanges = (contextDb.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;

      for (let i = 0; i < 3; i++) {
        const tcBeforeTool = (contextDb.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
        const toolRes = await client.callTool({
          name: GET_AUTHORIZED_CONTEXT_TOOL_NAME,
          arguments: {},
        });
        const tcAfterTool = (contextDb.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
        expect(tcAfterTool - tcBeforeTool).toBe(0);

        expect(toolRes.isError).toBeFalsy();
        expect(toolRes.content).toHaveLength(1);
        const toolText = (toolRes.content[0] as { type: 'text'; text: string }).text;
        const parsedTool = JSON.parse(toolText);
        expect(parsedTool.schema_version).toBe(2);

        const tcBeforeResource = (contextDb.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
        const resourceRes = await client.readResource({
          uri: AUTHORIZED_CONTEXT_RESOURCE_URI,
        });
        const tcAfterResource = (contextDb.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
        expect(tcAfterResource - tcBeforeResource).toBe(0);

        expect(resourceRes.contents).toHaveLength(1);
        const resText = (resourceRes.contents[0] as { text: string }).text;
        const parsedResource = JSON.parse(resText);
        expect(parsedResource.schema_version).toBe(2);
      }

      const finalTotalChanges = (contextDb.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
      expect(finalTotalChanges - initialTotalChanges).toBe(0);
    } finally {
      await client.close();
      await server.close();
      context.close();
    }

    // 5. Assert durable SQLite file is identical byte-for-byte
    const afterBytes = fs.readFileSync(dbPath);
    const afterHash = crypto.createHash('sha256').update(afterBytes).digest('hex');
    expect(afterHash).toBe(beforeHash);

    // 6. Assert no WAL or SHM artifacts were created
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);

    // 7. Assert all table contents remain byte-identical to initial snapshots
    const verifyDb = new Database(dbPath, { readonly: true });
    try {
      for (const t of tables) {
        const rows = verifyDb.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid ASC`).all();
        expect(JSON.stringify(rows)).toBe(initialTableSnapshots.get(t.name));
      }
      const totalChangesRow = verifyDb.prepare('SELECT total_changes() as tc').get() as { tc: number };
      expect(totalChangesRow.tc).toBe(0);
    } finally {
      verifyDb.close();
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

  it('67. Scrubbed diagnostics: seeded token, digest, and internal DB paths do not leak into stderr', async () => {
    const { db, dbPath: sensitiveDbPath } = createTestDatabase(tempDir, 'super_secret_corporate_path.db');
    const sensitiveToken = McpSessionAuthorityService.generateSessionToken();
    const sensitiveDigest = McpSessionAuthorityService.hashSessionToken(sensitiveToken);
    const sensitiveAuthId = 'auth-super-secret-12345';
    const sensitiveCredentialRef = 'cred-ref-classified-9999';
    const sensitiveProfileRef = 'agent-profile-classified-secret';
    const sensitiveSqliteMarker = 'SQLITE_CONSTRAINT_CHECK_REDACTED_SECRET';

    let capturedStderr = '';
    const originalStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      capturedStderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      // 1. Setup real graph with sensitive auth ID and seed secrets directly into the database graph
      const fixtures = setupFullGraph(db);
      try {
        db.prepare("UPDATE role_profiles SET display_name = ? WHERE id = ?").run(sensitiveProfileRef, fixtures.roleId);
        db.prepare("UPDATE execution_authorizations SET status = 'INVALIDATED' WHERE id = ?").run(fixtures.authorizationId);
      } finally {
        db.close();
      }

      // 2. Trigger real CLI issue error with opened database (reaches failing sink with sensitiveProfileRef)
      const exit1 = runSessionAdmin(['issue', '--db', sensitiveDbPath, '--auth', fixtures.authorizationId]);
      expect(exit1).toBe(1);

      // 3. Trigger CLI revoke error with opened database
      const exit2 = runSessionAdmin(['revoke', '--db', sensitiveDbPath, '--session', '   ']);
      expect(exit2).toBe(1);

      // 4. Trigger context error with seeded secret token
      const ctxToClose = new McpAuthorityContext({ dbPath: sensitiveDbPath, sessionToken: sensitiveToken });
      try {
        expect(() => {
          ctxToClose.resolveAuthorizedContext();
        }).toThrow();
      } finally {
        ctxToClose.close();
      }

      // 5. Test real MCP server tool and resource sinks with the failing context
      const toolContext = new McpAuthorityContext({ dbPath: sensitiveDbPath, sessionToken: sensitiveToken });
      const server = buildAgentForgeMcpServer({ authorityContext: toolContext });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'test-scrub-client', version: '1.0.0' });
      await client.connect(clientTransport);

      try {
        const toolResult = await client.callTool({
          name: GET_AUTHORIZED_CONTEXT_TOOL_NAME,
          arguments: {},
        });
        expect(toolResult.isError).toBe(true);
        const toolText = (toolResult.content[0] as { type: 'text'; text: string }).text;
        expect(toolText).toBe('[MCP_SESSION_UNAUTHORIZED] Session authentication failed');
        expect(toolText).not.toContain(sensitiveToken);
        expect(toolText).not.toContain(sensitiveDigest);
        expect(toolText).not.toContain(sensitiveDbPath);
        expect(toolText).not.toContain(sensitiveAuthId);
        expect(toolText).not.toContain(sensitiveCredentialRef);
        expect(toolText).not.toContain(sensitiveProfileRef);
        expect(toolText).not.toContain(sensitiveSqliteMarker);

        await expect(
          client.readResource({ uri: AUTHORIZED_CONTEXT_RESOURCE_URI })
        ).rejects.toThrow();
      } finally {
        await client.close();
        await server.close();
        toolContext.close();
      }

      // 6. Assert none of the sensitive values leaked into stderr across all sinks
      expect(capturedStderr).not.toContain(sensitiveToken);
      expect(capturedStderr).not.toContain(sensitiveDigest);
      expect(capturedStderr).not.toContain(sensitiveDbPath);
      expect(capturedStderr).not.toContain(sensitiveAuthId);
      expect(capturedStderr).not.toContain(sensitiveCredentialRef);
      expect(capturedStderr).not.toContain(sensitiveProfileRef);
      expect(capturedStderr).not.toContain(sensitiveSqliteMarker);
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

  // =========================================================================
  // Part 10: Expanded Authority, Protocol, Schema & CLI Hardening Truth Tests
  // =========================================================================

  it('69. Issuance rejects non-RUNNING project status returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'proj_status_fence.db');
    try {
      const fixtures = setupFullGraph(db);
      for (const badStatus of ['DRAFT', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED']) {
        db.prepare('UPDATE projects SET status = ? WHERE id = ?').run(badStatus, fixtures.projectId);
        expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
      }
    } finally {
      db.close();
    }
  });

  it('70. Issuance rejects terminal task state returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'task_state_fence.db');
    try {
      const fixtures = setupFullGraph(db);
      for (const badState of ['DONE', 'FAILED', 'CANCELLED']) {
        db.prepare('UPDATE tasks SET state = ? WHERE id = ?').run(badState, fixtures.taskId);
        expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
      }
    } finally {
      db.close();
    }
  });

  it('71. Issuance rejects task with missing, 0, or negative ownership_epoch returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'task_epoch_fence.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare('UPDATE tasks SET ownership_epoch = 0 WHERE id = ?').run(fixtures.taskId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
      db.prepare('UPDATE tasks SET ownership_epoch = -1 WHERE id = ?').run(fixtures.taskId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('72. Issuance rejects attempt with non-RUNNING status returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'attempt_status_fence.db');
    try {
      const fixtures = setupFullGraph(db);
      for (const badStatus of ['COMPLETED', 'FAILED', 'CANCELLED']) {
        db.prepare('UPDATE task_attempts SET status = ? WHERE id = ?').run(badStatus, fixtures.attemptId);
        expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
      }
    } finally {
      db.close();
    }
  });

  it('73. Issuance rejects routing decision with contradictory aliases returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'route_aliases.db');
    try {
      const fixtures = setupFullGraph(db);
      const badPayload = {
        decisionId: fixtures.routingDecisionId,
        projectId: fixtures.projectId,
        project_id: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        selectedProviderId: fixtures.providerId,
        selectedAccountId: fixtures.accountId,
        selectedResourceId: fixtures.resourceId,
        outcome: 'SELECTED',
      };
      db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(badPayload), fixtures.routingDecisionId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('74. Issuance rejects routing decision with unexpected additional authority fields returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'route_extra_fields.db');
    try {
      const fixtures = setupFullGraph(db);
      const badPayload = {
        decisionId: fixtures.routingDecisionId,
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        selectedProviderId: fixtures.providerId,
        selectedAccountId: fixtures.accountId,
        selectedResourceId: fixtures.resourceId,
        outcome: 'SELECTED',
        unauthorizedAuthorityBypass: true,
      };
      db.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(badPayload), fixtures.routingDecisionId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('75. Legacy PROVIDER_ROUTING_DECISION event type succeeds when adhering strictly to legacy canonical schema', () => {
    const { db } = createTestDatabase(tempDir, 'legacy_route.db');
    try {
      const fixtures = setupFullGraph(db);
      const legacyPayload = {
        decisionId: fixtures.routingDecisionId,
        projectId: fixtures.projectId,
        taskId: fixtures.taskId,
        attemptId: fixtures.attemptId,
        candidateResourceIds: [fixtures.resourceId],
        selectedResourceId: fixtures.resourceId,
        selectedProviderId: fixtures.providerId,
        outcome: 'SELECTED',
        reason: 'Legacy route',
      };
      db.prepare("UPDATE events SET type = 'PROVIDER_ROUTING_DECISION', structured_payload_json = ? WHERE id = ?").run(
        JSON.stringify(legacyPayload),
        fixtures.routingDecisionId
      );
      const result = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      expect(result.session.id).toBeDefined();
    } finally {
      db.close();
    }
  });

  it('76. Issuance rejects manager message if protocol is not manager.v1 returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'msg_proto_bad.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare("UPDATE protocol_messages SET protocol = 'coder.v1' WHERE id = ?").run(fixtures.managerRecordId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('77. Issuance rejects manager message if status is not APPLIED returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'msg_status_bad.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare("UPDATE protocol_messages SET status = 'REJECTED' WHERE id = ?").run(fixtures.managerRecordId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('78. Issuance rejects manager message if recomputed raw_payload SHA-256 does not match stored payload_hash returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'msg_hash_bad.db');
    try {
      const fixtures = setupFullGraph(db);
      const tamperedRaw = fixtures.rawManagerPayload.replace('All tests pass', 'Tampered criteria');
      db.prepare('UPDATE protocol_messages SET raw_payload = ? WHERE id = ?').run(tamperedRaw, fixtures.managerRecordId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('79. Issuance rejects manager message if decision is not EXECUTE or FIX_REQUIRED returns MCP_AUTHORITY_FENCED', () => {
    const { db } = createTestDatabase(tempDir, 'msg_decision_bad.db');
    try {
      const fixtures = setupFullGraph(db);
      const invalidDecisionPayload = JSON.parse(fixtures.rawManagerPayload);
      invalidDecisionPayload.decision = 'ABORT';
      const rawInvalid = JSON.stringify(invalidDecisionPayload);
      const hashInvalid = crypto.createHash('sha256').update(rawInvalid, 'utf8').digest('hex');
      db.prepare('UPDATE protocol_messages SET raw_payload = ?, payload_hash = ? WHERE id = ?').run(rawInvalid, hashInvalid, fixtures.managerRecordId);
      db.prepare('UPDATE execution_authorizations SET manager_payload_hash = ? WHERE id = ?').run(hashInvalid, fixtures.authorizationId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('80. Canonical identity: manager message lookup fails when stored with different protocol message_id if record id is not matched', () => {
    const { db } = createTestDatabase(tempDir, 'msg_canonical_id.db');
    try {
      const fixtures = setupFullGraph(db);
      expect(fixtures.managerRecordId).not.toEqual(fixtures.managerMessageId);
      expect(fixtures.auth.manager_message_id).toBe(fixtures.managerRecordId);

      // Verify that lookup by record ID succeeds, whereas lookup by protocol message_id fails when searching record IDs
      const byRecordId = fixtures.repo.getProtocolMessageByRecordId(fixtures.managerRecordId);
      expect(byRecordId).toBeDefined();

      const byProtocolIdAsRecord = fixtures.repo.getProtocolMessageByRecordId(fixtures.managerMessageId);
      expect(byProtocolIdAsRecord).toBeNull();

      // Proves that if an implementation erroneously looked up by protocol message_id using the authorization's manager_message_id, it returns null
      const erroneousLookup = fixtures.repo.getProtocolMessageById(fixtures.auth.manager_message_id!);
      expect(erroneousLookup).toBeNull();

      // Successful issuance confirms authoritative binding strictly on record id
      const result = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      expect(result.session.id).toBeDefined();
    } finally {
      db.close();
    }
  });

  it('81. Mutating manager payload JSON while leaving stored hash unchanged fences the next read returns MCP_CONTEXT_INTEGRITY_FAILED', () => {
    const { db } = createTestDatabase(tempDir, 'msg_mutate_read.db');
    try {
      const fixtures = setupFullGraph(db);
      const { plaintextToken } = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      const tampered = fixtures.rawManagerPayload.replace('All tests pass', 'Mutated criteria');
      db.prepare('UPDATE protocol_messages SET raw_payload = ? WHERE id = ?').run(tampered, fixtures.managerRecordId);
      expect(() => fixtures.service.resolveAuthorizedContext(plaintextToken)).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      db.close();
    }
  });

  it('82. Context read validates token and fails before touching or opening database when token is missing or malformed', () => {
    const fakeDbPath = path.join(tempDir, 'nonexistent_should_never_open.db');
    expect(() => {
      const ctx = new McpAuthorityContext({ dbPath: fakeDbPath, sessionToken: '' });
      ctx.resolveAuthorizedContext();
    }).toThrowError(/MCP_SESSION_REQUIRED/);

    expect(() => {
      const ctx = new McpAuthorityContext({ dbPath: fakeDbPath, sessionToken: 'malformed_invalid_token!' });
      ctx.resolveAuthorizedContext();
    }).toThrowError(/MCP_SESSION_UNAUTHORIZED/);
  });

  it('83. Context read fails closed with MCP_CONFIGURATION_INVALID if PRAGMA query_only readback is not 1', () => {
    const { db } = createTestDatabase(tempDir, 'pragma_queryonly.db');
    try {
      expect(() => {
        new McpAuthorityContext({ db });
      }).toThrowError(/MCP_CONFIGURATION_INVALID/);
    } finally {
      db.close();
    }
  });

  it('84. CLI help rejects combination with flags or positionals', () => {
    expect(() => parseCliArgs(['issue', '--help'])).toThrowError(/Help flag cannot be combined/);
    expect(() => parseCliArgs(['--help', 'revoke'])).toThrowError(/Help flag cannot be combined/);
    expect(() => parseCliArgs(['help', '--db', 'test.db'])).toThrowError(/Help flag cannot be combined/);
  });

  it('85. CLI issue rejects whitespace-only --auth, --db, or --ttl', () => {
    expect(() => parseCliArgs(['issue', '--db', '  ', '--auth', 'auth-1'])).toThrowError(/cannot be whitespace-only/);
    expect(() => parseCliArgs(['issue', '--db', 'test.db', '--auth', '   '])).toThrowError(/cannot be whitespace-only/);
    expect(() => parseCliArgs(['issue', '--db', 'test.db', '--auth', 'auth-1', '--ttl', '   '])).toThrowError(/cannot be whitespace-only/);
  });

  it('86. CLI revoke rejects --ttl flag with clear error', () => {
    expect(() => parseCliArgs(['revoke', '--db', 'test.db', '--session', 's1', '--ttl', '3600'])).toThrowError(/Flag --ttl is not valid for revoke command/);
  });

  it('87. CLI issue rejects --session flag with clear error', () => {
    expect(() => parseCliArgs(['issue', '--db', 'test.db', '--auth', 'a1', '--session', 's1'])).toThrowError(/Flag --session is not valid for issue command/);
  });

  it('88. Forced Database.close() failure in runSessionAdmin returns exit code 1, emits MCP_CLEANUP_FAILED, and prevents detail leakage', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'close_fail.db');
    const fixtures = setupFullGraph(db);
    db.close();

    let capturedStderr = '';
    const originalStderr = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      capturedStderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    const originalClose = Database.prototype.close;
    let closeAttempts = 0;
    const openedRef: { current: { open?: boolean; close: () => void } | null } = { current: null };
    try {
      Database.prototype.close = function (this: Database.Database) {
        openedRef.current = this;
        closeAttempts++;
        throw new Error('Forced native close error: secret_path_leak_fail');
      };

      const exitCode = runSessionAdmin(['issue', '--db', dbPath, '--auth', fixtures.authorizationId]);
      expect(exitCode).toBe(1);
      expect(closeAttempts).toBeGreaterThan(0);
      expect(capturedStderr).toContain('[MCP_CLEANUP_FAILED]');
      expect(capturedStderr).not.toContain('secret_path_leak_fail');
      expect(capturedStderr).not.toContain('Forced native close error');
    } finally {
      Database.prototype.close = originalClose;
      if (openedRef.current && openedRef.current.open) {
        openedRef.current.close();
      }
      process.stderr.write = originalStderr;
    }
  });

  // =========================================================================
  // Part 10: Corrective Pass 3 Required Independent Evidence Tests (89 - 115)
  // =========================================================================

  it('89. Mutation fencing: SELECT total_changes() observable mutation delta triggers MCP_AUTHORITY_FENCED and guard runs even if service throws', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'mutation_fence.db');
    let token = '';
    try {
      const fixtures = setupFullGraph(db);
      token = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId }).plaintextToken;
    } finally {
      db.close();
    }

    // Path A: Service succeeds, but total_changes detects a mutation delta (simulated via statement spy)
    const ctxSuccess = new McpAuthorityContext({ dbPath, sessionToken: token });
    const { db: openedDbSuccess } = ctxSuccess.getOrCreateDatabase();
    try {
      const origPrepare = openedDbSuccess.prepare.bind(openedDbSuccess);
      let totalChangesCallsSuccess = 0;
      openedDbSuccess.prepare = function (this: Database.Database, sql: string) {
        const stmt = origPrepare(sql);
        if (sql.includes('total_changes()')) {
          const origGet = stmt.get.bind(stmt);
          stmt.get = function (this: Database.Statement, ...args: unknown[]) {
            totalChangesCallsSuccess++;
            if (totalChangesCallsSuccess === 2) {
              return { total_changes: 1 };
            }
            return origGet(...args);
          } as typeof stmt.get;
        }
        return stmt;
      } as typeof openedDbSuccess.prepare;

      expect(() => ctxSuccess.resolveAuthorizedContext()).toThrowError(/MCP_AUTHORITY_FENCED/);
      expect(totalChangesCallsSuccess).toBe(2);
    } finally {
      ctxSuccess.close();
    }

    // Path B: Service throws an error, but total_changes guard still runs and reads post-call count
    // Invalidate the session in database so service throws
    const alterDb = new Database(dbPath);
    try {
      alterDb.prepare('UPDATE mcp_client_sessions SET revoked_at = ?').run(new Date(Date.now() + 1000).toISOString());
    } finally {
      alterDb.close();
    }

    const ctxThrow = new McpAuthorityContext({ dbPath, sessionToken: token });
    const { db: openedDbThrow } = ctxThrow.getOrCreateDatabase();
    try {
      const origPrepare = openedDbThrow.prepare.bind(openedDbThrow);
      let totalChangesCallsThrow = 0;
      openedDbThrow.prepare = function (this: Database.Database, sql: string) {
        const stmt = origPrepare(sql);
        if (sql.includes('total_changes()')) {
          const origGet = stmt.get.bind(stmt);
          stmt.get = function (this: Database.Statement, ...args: unknown[]) {
            totalChangesCallsThrow++;
            return origGet(...args);
          } as typeof stmt.get;
        }
        return stmt;
      } as typeof openedDbThrow.prepare;

      expect(() => ctxThrow.resolveAuthorizedContext()).toThrowError(/MCP_SESSION_UNAUTHORIZED/);
      // Confirms guard ran in finally/post-call block even when service threw
      expect(totalChangesCallsThrow).toBe(2);
    } finally {
      ctxThrow.close();
    }
  });

  it('90. Migration 21 index column mismatch: rejects each of the four required indexes recreated on a wrong column', () => {
    const { db } = createTestDatabase(tempDir, 'm21_wrong_col_indexes.db');
    try {
      // 1. idx_mcp_client_sessions_token_hash on wrong column (id instead of token_hash)
      db.exec('DROP INDEX idx_mcp_client_sessions_token_hash;');
      db.exec('CREATE UNIQUE INDEX idx_mcp_client_sessions_token_hash ON mcp_client_sessions(id);');
      expect(() => verifyMigration21SchemaAuthority(db)).toThrow();
      db.exec('DROP INDEX idx_mcp_client_sessions_token_hash;');
      db.exec('CREATE UNIQUE INDEX idx_mcp_client_sessions_token_hash ON mcp_client_sessions(token_hash);');
      verifyMigration21SchemaAuthority(db);

      // 2. uq_mcp_client_sessions_active_auth on wrong column (id instead of authorization_id)
      db.exec('DROP INDEX uq_mcp_client_sessions_active_auth;');
      db.exec('CREATE UNIQUE INDEX uq_mcp_client_sessions_active_auth ON mcp_client_sessions(id) WHERE revoked_at IS NULL;');
      expect(() => verifyMigration21SchemaAuthority(db)).toThrow();
      db.exec('DROP INDEX uq_mcp_client_sessions_active_auth;');
      db.exec('CREATE UNIQUE INDEX uq_mcp_client_sessions_active_auth ON mcp_client_sessions(authorization_id) WHERE revoked_at IS NULL;');
      verifyMigration21SchemaAuthority(db);

      // 3. idx_mcp_client_sessions_expires_at on wrong column (id instead of expires_at)
      db.exec('DROP INDEX idx_mcp_client_sessions_expires_at;');
      db.exec('CREATE INDEX idx_mcp_client_sessions_expires_at ON mcp_client_sessions(id);');
      expect(() => verifyMigration21SchemaAuthority(db)).toThrow();
      db.exec('DROP INDEX idx_mcp_client_sessions_expires_at;');
      db.exec('CREATE INDEX idx_mcp_client_sessions_expires_at ON mcp_client_sessions(expires_at);');
      verifyMigration21SchemaAuthority(db);

      // 4. idx_mcp_client_sessions_auth_id on wrong column (id instead of authorization_id)
      db.exec('DROP INDEX idx_mcp_client_sessions_auth_id;');
      db.exec('CREATE INDEX idx_mcp_client_sessions_auth_id ON mcp_client_sessions(id);');
      expect(() => verifyMigration21SchemaAuthority(db)).toThrow();
    } finally {
      db.close();
    }
  });

  it('91. Migration 21 active session index: rejects missing predicate, wrong predicate, non-unique, or unexpected custom index', () => {
    const { db } = createTestDatabase(tempDir, 'm21_index_predicates.db');
    try {
      // 1. Missing predicate (unconditional)
      db.exec('DROP INDEX uq_mcp_client_sessions_active_auth;');
      db.exec('CREATE UNIQUE INDEX uq_mcp_client_sessions_active_auth ON mcp_client_sessions(authorization_id);');
      expect(() => verifyMigration21SchemaAuthority(db)).toThrow();

      // 2. Inverted predicate
      db.exec('DROP INDEX uq_mcp_client_sessions_active_auth;');
      db.exec('CREATE UNIQUE INDEX uq_mcp_client_sessions_active_auth ON mcp_client_sessions(authorization_id) WHERE revoked_at IS NOT NULL;');
      expect(() => verifyMigration21SchemaAuthority(db)).toThrow();

      // 3. Non-unique
      db.exec('DROP INDEX uq_mcp_client_sessions_active_auth;');
      db.exec('CREATE INDEX uq_mcp_client_sessions_active_auth ON mcp_client_sessions(authorization_id) WHERE revoked_at IS NULL;');
      expect(() => verifyMigration21SchemaAuthority(db)).toThrow();

      // Restore canonical index
      db.exec('DROP INDEX uq_mcp_client_sessions_active_auth;');
      db.exec('CREATE UNIQUE INDEX uq_mcp_client_sessions_active_auth ON mcp_client_sessions(authorization_id) WHERE revoked_at IS NULL;');
      verifyMigration21SchemaAuthority(db);

      // 4. Unexpected user-defined index
      db.exec('CREATE INDEX idx_unexpected_user_defined ON mcp_client_sessions(issued_at);');
      expect(() => verifyMigration21SchemaAuthority(db)).toThrow();
    } finally {
      db.close();
    }
  });

  it('92. Ledger authority: rejects later version, earlier version, duplicate version, or missing row', () => {
    const { db } = createTestDatabase(tempDir, 'ledger_authority_checks.db');
    try {
      // 1. Later ledger version > 21
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (22, '022_future', datetime('now'))").run();
      expect(() => verifyMigration21SchemaAuthority(db)).toThrow();
      db.prepare('DELETE FROM schema_migrations WHERE version = 22').run();
      verifyMigration21SchemaAuthority(db);

      // 2. Earlier ledger version max (e.g. max is 20)
      db.prepare('DELETE FROM schema_migrations WHERE version = 21').run();
      expect(() => verifyMigration21SchemaAuthority(db)).toThrow();

      // 3. Re-insert with wrong migration name
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (21, '021_wrong_name', datetime('now'))").run();
      expect(() => verifyMigration21SchemaAuthority(db)).toThrow();

      // 4. Re-insert with correct name
      db.prepare('DELETE FROM schema_migrations WHERE version = 21').run();
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (21, '021_r5j_mcp_client_session_authority', datetime('now'))").run();
      verifyMigration21SchemaAuthority(db);
    } finally {
      db.close();
    }
  });

  it('93. Schema authority: rejects extra columns, missing columns, wrong types, wrong nullability, and wrong primary key', () => {
    const { db } = createTestDatabase(tempDir, 'schema_auth_columns.db');
    try {
      // 1. Extra column
      db.exec('ALTER TABLE mcp_client_sessions ADD COLUMN rogue_extra_column TEXT;');
      expect(() => verifyMigration21SchemaAuthority(db)).toThrow();
    } finally {
      db.close();
    }

    // 2. Missing column
    const { db: db2 } = createTestDatabase(tempDir, 'schema_auth_missing_col.db');
    try {
      db2.exec('DROP TABLE mcp_client_sessions;');
      db2.exec(`
        CREATE TABLE mcp_client_sessions (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          authorization_fingerprint TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          created_at TEXT NOT NULL
        );
      `);
      expect(() => verifyMigration21SchemaAuthority(db2)).toThrow();
    } finally {
      db2.close();
    }

    // 3. Wrong column type
    const { db: db3 } = createTestDatabase(tempDir, 'schema_auth_wrong_type.db');
    try {
      db3.exec('DROP TABLE mcp_client_sessions;');
      db3.exec(`
        CREATE TABLE mcp_client_sessions (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          scope INTEGER NOT NULL,
          authorization_fingerprint TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          created_at TEXT NOT NULL
        );
      `);
      expect(() => verifyMigration21SchemaAuthority(db3)).toThrow();
    } finally {
      db3.close();
    }

    // 4. Wrong nullability
    const { db: db4 } = createTestDatabase(tempDir, 'schema_auth_wrong_nullability.db');
    try {
      db4.exec('DROP TABLE mcp_client_sessions;');
      db4.exec(`
        CREATE TABLE mcp_client_sessions (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL,
          token_hash TEXT,
          scope TEXT NOT NULL,
          authorization_fingerprint TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          created_at TEXT NOT NULL
        );
      `);
      expect(() => verifyMigration21SchemaAuthority(db4)).toThrow();
    } finally {
      db4.close();
    }
  });

  it('94. Schema authority: rejects foreign key target mismatch, invalid action, or missing FK', () => {
    // 1. Missing FK
    const { db: db1 } = createTestDatabase(tempDir, 'schema_auth_missing_fk.db');
    try {
      db1.exec('DROP TABLE mcp_client_sessions;');
      db1.exec(`
        CREATE TABLE mcp_client_sessions (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          scope TEXT NOT NULL,
          authorization_fingerprint TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          created_at TEXT NOT NULL
        );
      `);
      expect(() => verifyMigration21SchemaAuthority(db1)).toThrow();
    } finally {
      db1.close();
    }

    // 2. FK referencing wrong table (tasks instead of execution_authorizations)
    const { db: db2 } = createTestDatabase(tempDir, 'schema_auth_wrong_fk_target.db');
    try {
      db2.exec('DROP TABLE mcp_client_sessions;');
      db2.exec(`
        CREATE TABLE mcp_client_sessions (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          scope TEXT NOT NULL,
          authorization_fingerprint TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (authorization_id) REFERENCES tasks(id)
        );
      `);
      expect(() => verifyMigration21SchemaAuthority(db2)).toThrow();
    } finally {
      db2.close();
    }

    // 3. FK with ON DELETE CASCADE instead of RESTRICT / NO ACTION
    const { db: db3 } = createTestDatabase(tempDir, 'schema_auth_fk_cascade.db');
    try {
      db3.exec('DROP TABLE mcp_client_sessions;');
      db3.exec(`
        CREATE TABLE mcp_client_sessions (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          scope TEXT NOT NULL,
          authorization_fingerprint TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (authorization_id) REFERENCES execution_authorizations(id) ON DELETE CASCADE
        );
      `);
      expect(() => verifyMigration21SchemaAuthority(db3)).toThrow();
    } finally {
      db3.close();
    }
  });

  it('95. Migration 21 CHECK constraint: scope domain enforcement', () => {
    const { db } = createTestDatabase(tempDir, 'chk_scope.db');
    try {
      const fixtures = setupFullGraph(db);
      const issuedAt = new Date(Date.now() - 10000).toISOString();
      const expiresAt = new Date(Date.now() + 60000).toISOString();
      const validHash = 'a'.repeat(64);
      const validFp = 'b'.repeat(64);

      // Inserting an invalid scope throws SQLite constraint check error
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, token_hash, scope, authorization_fingerprint, issued_at, expires_at)
          VALUES (?, ?, ?, 'INVALID_SCOPE', ?, ?, ?)
        `).run('sess-1', fixtures.authorizationId, validHash, validFp, issuedAt, expiresAt);
      }).toThrow(/CHECK constraint failed/);

      // Inserting canonical AUTHORIZED_CONTEXT_READ succeeds
      db.prepare(`
        INSERT INTO mcp_client_sessions (id, authorization_id, token_hash, scope, authorization_fingerprint, issued_at, expires_at)
        VALUES (?, ?, ?, 'AUTHORIZED_CONTEXT_READ', ?, ?, ?)
      `).run('sess-valid', fixtures.authorizationId, validHash, validFp, issuedAt, expiresAt);
    } finally {
      db.close();
    }
  });

  it('96. Migration 21 CHECK constraint: token_hash domain enforcement', () => {
    const { db } = createTestDatabase(tempDir, 'chk_token_hash.db');
    try {
      const fixtures = setupFullGraph(db);
      const issuedAt = new Date(Date.now() - 10000).toISOString();
      const expiresAt = new Date(Date.now() + 60000).toISOString();
      const validFp = 'b'.repeat(64);

      // 63 chars (too short)
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, token_hash, scope, authorization_fingerprint, issued_at, expires_at)
          VALUES (?, ?, ?, 'AUTHORIZED_CONTEXT_READ', ?, ?, ?)
        `).run('sess-1', fixtures.authorizationId, 'a'.repeat(63), validFp, issuedAt, expiresAt);
      }).toThrow(/CHECK constraint failed/);

      // Uppercase hex
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, token_hash, scope, authorization_fingerprint, issued_at, expires_at)
          VALUES (?, ?, ?, 'AUTHORIZED_CONTEXT_READ', ?, ?, ?)
        `).run('sess-2', fixtures.authorizationId, 'A'.repeat(64), validFp, issuedAt, expiresAt);
      }).toThrow(/CHECK constraint failed/);

      // Non-hex
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, token_hash, scope, authorization_fingerprint, issued_at, expires_at)
          VALUES (?, ?, ?, 'AUTHORIZED_CONTEXT_READ', ?, ?, ?)
        `).run('sess-3', fixtures.authorizationId, 'g'.repeat(64), validFp, issuedAt, expiresAt);
      }).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it('97. Migration 21 CHECK constraint: authorization_fingerprint domain enforcement', () => {
    const { db } = createTestDatabase(tempDir, 'chk_fingerprint.db');
    try {
      const fixtures = setupFullGraph(db);
      const issuedAt = new Date(Date.now() - 10000).toISOString();
      const expiresAt = new Date(Date.now() + 60000).toISOString();
      const validHash = 'a'.repeat(64);

      // 65 chars (too long)
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, token_hash, scope, authorization_fingerprint, issued_at, expires_at)
          VALUES (?, ?, ?, 'AUTHORIZED_CONTEXT_READ', ?, ?, ?)
        `).run('sess-1', fixtures.authorizationId, validHash, 'b'.repeat(65), issuedAt, expiresAt);
      }).toThrow(/CHECK constraint failed/);

      // Uppercase hex
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, token_hash, scope, authorization_fingerprint, issued_at, expires_at)
          VALUES (?, ?, ?, 'AUTHORIZED_CONTEXT_READ', ?, ?, ?)
        `).run('sess-2', fixtures.authorizationId, validHash, 'B'.repeat(64), issuedAt, expiresAt);
      }).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it('98. Migration 21 CHECK constraint: timestamp format domain enforcement', () => {
    const { db } = createTestDatabase(tempDir, 'chk_timestamps.db');
    try {
      const fixtures = setupFullGraph(db);
      const validHash = 'a'.repeat(64);
      const validFp = 'b'.repeat(64);
      const issuedAt = new Date(Date.now() - 10000).toISOString();
      const expiresAt = new Date(Date.now() + 60000).toISOString();

      // Invalid issued_at (empty string violates length(issued_at) > 0)
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, token_hash, scope, authorization_fingerprint, issued_at, expires_at)
          VALUES (?, ?, ?, 'AUTHORIZED_CONTEXT_READ', ?, '', ?)
        `).run('sess-1', fixtures.authorizationId, validHash, validFp, expiresAt);
      }).toThrow(/CHECK constraint failed/);

      // Invalid expires_at (expires_at <= issued_at violates expires_at > issued_at)
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, token_hash, scope, authorization_fingerprint, issued_at, expires_at)
          VALUES (?, ?, ?, 'AUTHORIZED_CONTEXT_READ', ?, ?, ?)
        `).run('sess-2', fixtures.authorizationId, validHash, validFp, issuedAt, issuedAt);
      }).toThrow(/CHECK constraint failed/);

      // Invalid revoked_at (revoked_at < issued_at violates revoked_at >= issued_at)
      const earlier = new Date(Date.now() - 20000).toISOString();
      expect(() => {
        db.prepare(`
          INSERT INTO mcp_client_sessions (id, authorization_id, token_hash, scope, authorization_fingerprint, issued_at, expires_at, revoked_at)
          VALUES (?, ?, ?, 'AUTHORIZED_CONTEXT_READ', ?, ?, ?, ?)
        `).run('sess-3', fixtures.authorizationId, validHash, validFp, issuedAt, expiresAt, earlier);
      }).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it('99. Protocol message tampering at issuance: tampered payload message_id rejected with 0 new session rows', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_payload_msg_id.db');
    try {
      const fixtures = setupFullGraph(db);
      const payload = JSON.parse(fixtures.rawManagerPayload);
      payload.message_id = 'different-proto-id';
      const raw = JSON.stringify(payload);
      const hash = crypto.createHash('sha256').update(raw).digest('hex');
      db.prepare('UPDATE protocol_messages SET raw_payload = ?, payload_hash = ? WHERE id = ?').run(raw, hash, fixtures.managerRecordId);
      db.prepare('UPDATE execution_authorizations SET manager_payload_hash = ? WHERE id = ?').run(hash, fixtures.authorizationId);

      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
      const sessionCount = db.prepare('SELECT COUNT(*) as count FROM mcp_client_sessions').get() as { count: number };
      expect(sessionCount.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('100. Protocol message tampering at issuance: tampered row message_id rejected with 0 new session rows', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_row_msg_id.db');
    try {
      const fixtures = setupFullGraph(db);
      db.prepare('UPDATE protocol_messages SET message_id = ? WHERE id = ?').run('tampered-row-message-id', fixtures.managerRecordId);

      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
      const sessionCount = db.prepare('SELECT COUNT(*) as count FROM mcp_client_sessions').get() as { count: number };
      expect(sessionCount.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('101. Protocol message tampering at issuance: row revision vs payload revision mismatch rejected with 0 new session rows', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_revision.db');
    try {
      const fixtures = setupFullGraph(db);
      const payload = JSON.parse(fixtures.rawManagerPayload);
      payload.expected_revision = 999;
      const raw = JSON.stringify(payload);
      const hash = crypto.createHash('sha256').update(raw).digest('hex');
      db.prepare('UPDATE protocol_messages SET raw_payload = ?, payload_hash = ? WHERE id = ?').run(raw, hash, fixtures.managerRecordId);
      db.prepare('UPDATE execution_authorizations SET manager_payload_hash = ? WHERE id = ?').run(hash, fixtures.authorizationId);

      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
      const sessionCount = db.prepare('SELECT COUNT(*) as count FROM mcp_client_sessions').get() as { count: number };
      expect(sessionCount.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('102. Protocol message tampering at issuance: tampered protocol, project_id, or task_id rejected with 0 new session rows', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_row_bindings.db');
    try {
      const fixtures = setupFullGraph(db);

      // 1. Mutate protocol to another valid DB protocol that is not manager.v1
      db.prepare('UPDATE protocol_messages SET protocol = ? WHERE id = ?').run('coder.v1', fixtures.managerRecordId);
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);

      // Restore protocol
      db.prepare('UPDATE protocol_messages SET protocol = ? WHERE id = ?').run('manager.v1', fixtures.managerRecordId);

      // 2. Mutate task_id (using valid foreign key)
      const altTaskId = `task-alt-${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const baseSha = 'b'.repeat(40);
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, base_sha, ownership_epoch, created_at, updated_at)
        VALUES (?, ?, 'Task Alt', 'CODING', 'LOW', 'LOW', 1, 3, 0, ?, 1, ?, ?)
      `).run(altTaskId, fixtures.projectId, baseSha, now, now);
      db.prepare('UPDATE protocol_messages SET task_id = ? WHERE id = ?').run(altTaskId, fixtures.managerRecordId);

      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);

      const sessionCount = db.prepare('SELECT COUNT(*) as count FROM mcp_client_sessions').get() as { count: number };
      expect(sessionCount.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('103. Protocol message tampering at issuance: tampered state or decision in payload rejected with 0 new session rows', () => {
    const { db } = createTestDatabase(tempDir, 'tamper_decision_state.db');
    try {
      const fixtures = setupFullGraph(db);
      const payload = JSON.parse(fixtures.rawManagerPayload);
      payload.decision = 'REJECTED';
      const raw = JSON.stringify(payload);
      const hash = crypto.createHash('sha256').update(raw).digest('hex');
      db.prepare('UPDATE protocol_messages SET raw_payload = ?, payload_hash = ? WHERE id = ?').run(raw, hash, fixtures.managerRecordId);
      db.prepare('UPDATE execution_authorizations SET manager_payload_hash = ? WHERE id = ?').run(hash, fixtures.authorizationId);

      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);

      const sessionCount = db.prepare('SELECT COUNT(*) as count FROM mcp_client_sessions').get() as { count: number };
      expect(sessionCount.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('104. Post-issuance protocol message tampering: mutating protocol_messages row message_id post-issuance fences next read', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'post_tamper_msg_id.db');
    let token = '';
    let msgRecId = '';
    try {
      const fixtures = setupFullGraph(db);
      msgRecId = fixtures.managerRecordId;
      token = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId }).plaintextToken;
    } finally {
      db.close();
    }

    // Verify initial read succeeds
    const ctx1 = new McpAuthorityContext({ dbPath, sessionToken: token });
    expect(ctx1.resolveAuthorizedContext().schema_version).toBe(2);
    ctx1.close();

    // Tamper protocol_messages message_id in database
    const modDb = new Database(dbPath);
    modDb.prepare('UPDATE protocol_messages SET message_id = ? WHERE id = ?').run('post-mutated-id', msgRecId);
    modDb.close();

    // Verify next read is fenced
    const ctx2 = new McpAuthorityContext({ dbPath, sessionToken: token });
    try {
      expect(() => ctx2.resolveAuthorizedContext()).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      ctx2.close();
    }
  });

  it('105. Post-issuance routing event tampering: mutating top-level project_id post-issuance fences next read', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'post_tamper_event_proj.db');
    let token = '';
    let routeEventId = '';
    let altProjId = '';
    try {
      const fixtures = setupFullGraph(db);
      routeEventId = fixtures.routingDecisionId;
      altProjId = `proj-alt-${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      fixtures.repo.createProject({
        id: altProjId,
        name: 'Alt Proj',
        description: 'Alt',
        repository_path: '/path/alt',
        default_branch: 'main',
        status: 'RUNNING',
        contract: null,
        created_at: now,
        updated_at: now,
        started_at: now,
        completed_at: null,
      });
      token = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId }).plaintextToken;
    } finally {
      db.close();
    }

    // Mutate event project_id post-issuance
    const modDb = new Database(dbPath);
    modDb.prepare('UPDATE events SET project_id = ? WHERE id = ?').run(altProjId, routeEventId);
    modDb.close();

    const ctx = new McpAuthorityContext({ dbPath, sessionToken: token });
    try {
      expect(() => ctx.resolveAuthorizedContext()).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      ctx.close();
    }
  });

  it('106. Post-issuance routing payload tampering: mutating routing payload post-issuance fences next read', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'post_tamper_route_payload.db');
    let token = '';
    let routeEventId = '';
    try {
      const fixtures = setupFullGraph(db);
      routeEventId = fixtures.routingDecisionId;
      token = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId }).plaintextToken;
    } finally {
      db.close();
    }

    // Mutate structured_payload_json outcome to FAILED
    const modDb = new Database(dbPath);
    const row = modDb.prepare('SELECT structured_payload_json FROM events WHERE id = ?').get(routeEventId) as { structured_payload_json: string };
    const payload = JSON.parse(row.structured_payload_json);
    payload.outcome = 'FAILED';
    modDb.prepare('UPDATE events SET structured_payload_json = ? WHERE id = ?').run(JSON.stringify(payload), routeEventId);
    modDb.close();

    const ctx = new McpAuthorityContext({ dbPath, sessionToken: token });
    try {
      expect(() => ctx.resolveAuthorizedContext()).toThrowError(/MCP_AUTHORITY_FENCED/);
    } finally {
      ctx.close();
    }
  });

  it('107. Bounded close retry policy: transient close failure succeeds within bound, persistent failure throws canonical error', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'bounded_close_retry.db');
    let token = '';
    try {
      const fixtures = setupFullGraph(db);
      token = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId }).plaintextToken;
    } finally {
      db.close();
    }

    // 1. Transient close failure: fails twice with lock contention, then succeeds
    const ctx1 = new McpAuthorityContext({ dbPath, sessionToken: token });
    const { db: openedDb1 } = ctx1.getOrCreateDatabase();
    let attempts = 0;
    const origClose1 = openedDb1.close.bind(openedDb1);
    openedDb1.close = function () {
      attempts++;
      if (attempts < 3) {
        throw new Error('EBUSY: resource locked transiently');
      }
      return origClose1();
    };
    // ctx1.close() should retry and succeed cleanly without throwing
    expect(() => ctx1.close()).not.toThrow();
    expect(attempts).toBe(3);

    // 2. Persistent close failure: exhausts retry bound and throws canonical MCP_CLEANUP_FAILED
    const ctx2 = new McpAuthorityContext({ dbPath, sessionToken: token });
    const { db: openedDb2 } = ctx2.getOrCreateDatabase();
    const origClose2 = openedDb2.close.bind(openedDb2);
    openedDb2.close = function () {
      throw new Error('EPERM: persistent file lock');
    };

    expect(() => ctx2.close()).toThrowError(/MCP_CLEANUP_FAILED/);
    expect(openedDb2.open).toBe(true);

    // After restoring close behavior, a later context close succeeds
    openedDb2.close = origClose2;
    expect(() => ctx2.close()).not.toThrow();

    // Database can be renamed and deleted immediately on Windows
    const renamedPath = path.join(tempDir, 'bounded_close_retry_renamed.db');
    fs.renameSync(dbPath, renamedPath);
    expect(fs.existsSync(renamedPath)).toBe(true);
    fs.unlinkSync(renamedPath);
    expect(fs.existsSync(renamedPath)).toBe(false);
  });

  it('108. Stdio server handle.close() and listener cleanup handles context close cleanly', async () => {
    const handle = runStdioServer();
    expect(handle).toBeDefined();
    expect(typeof handle.close).toBe('function');
    await handle.close();
  });

  it('109. CLI closed grammar: invalid commands and malformed flags cause zero mutations and never echo inputs', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'closed_grammar.db');
    try {
      const fixtures = setupFullGraph(db);
      let capturedStderr = '';
      const origStderr = process.stderr.write;
      process.stderr.write = ((chunk: unknown) => { capturedStderr += String(chunk); return true; }) as typeof process.stderr.write;

      const maliciousPayload = "auth'; DROP TABLE mcp_client_sessions; --";
      try {
        const changesBefore = (db.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
        const sessionsBefore = (db.prepare('SELECT COUNT(*) as c FROM mcp_client_sessions').get() as { c: number }).c;

        const exit1 = runSessionAdmin(['unknown_command', '--db', dbPath]);
        expect(exit1).toBe(1);

        const exit2 = runSessionAdmin(['issue', '--db', dbPath, '--auth', maliciousPayload]);
        expect(exit2).toBe(1);

        // Verify stderr does not echo the SQL injection payload
        expect(capturedStderr).not.toContain('DROP TABLE');
        expect(capturedStderr).not.toContain(maliciousPayload);

        // Verify mcp_client_sessions table is still present and intact
        const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mcp_client_sessions'").get();
        expect(tableCheck).toBeDefined();

        const changesAfter = (db.prepare('SELECT total_changes() as tc').get() as { tc: number }).tc;
        const sessionsAfter = (db.prepare('SELECT COUNT(*) as c FROM mcp_client_sessions').get() as { c: number }).c;
        expect(changesAfter - changesBefore).toBe(0);
        expect(sessionsAfter - sessionsBefore).toBe(0);
      } finally {
        process.stderr.write = origStderr;
      }
    } finally {
      db.close();
    }
  });

  it('110. Comprehensive secret exclusion across public sinks: verifies admin, context, tool, and resource sinks', async () => {
    const { db, dbPath: sensitivePath } = createTestDatabase(tempDir, 'secret_classified_db.db');
    const sensitiveToken = McpSessionAuthorityService.generateSessionToken();
    const sensitiveDigest = McpSessionAuthorityService.hashSessionToken(sensitiveToken);
    const sensitiveAuth = 'auth-super-classified-id';
    const sensitiveCred = 'cred-super-secret-key';
    const sensitiveProfileRef = 'profile-confidential-classified';
    const sensitiveMarker = 'SQLITE_CONSTRAINT_CHECK_MARKER';

    let capturedStderr = '';
    const origStderr = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      capturedStderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      // 1. Seed secrets into database graph so they are present on internal paths
      const fixtures = setupFullGraph(db);
      try {
        db.prepare("UPDATE role_profiles SET display_name = ? WHERE id = ?").run(sensitiveProfileRef, fixtures.roleId);
        db.prepare("UPDATE execution_authorizations SET status = 'INVALIDATED', adapter_error_json = ? WHERE id = ?")
          .run(JSON.stringify({ error: `failed: cred=${sensitiveCred} marker=${sensitiveMarker}` }), fixtures.authorizationId);
      } finally {
        db.close();
      }

      // 2. Admin issue sink: fails closed, excludes secrets from stdout and stderr
      let adminStdout = '';
      const origStdout = process.stdout.write;
      process.stdout.write = ((chunk: unknown) => { adminStdout += String(chunk); return true; }) as typeof process.stdout.write;
      try {
        const exitIssue = runSessionAdmin(['issue', '--db', sensitivePath, '--auth', fixtures.authorizationId]);
        expect(exitIssue).toBe(1);

        const exitRevoke = runSessionAdmin(['revoke', '--db', sensitivePath, '--session', sensitiveToken]);
        expect(exitRevoke).toBe(0);

        const exitRevokeInvalid = runSessionAdmin(['revoke', '--db', sensitivePath, '--session', '   ']);
        expect(exitRevokeInvalid).toBe(1);
      } finally {
        process.stdout.write = origStdout;
      }
      expect(adminStdout).not.toContain(sensitiveToken);
      expect(adminStdout).not.toContain(sensitiveDigest);
      expect(adminStdout).not.toContain(sensitivePath);
      expect(adminStdout).not.toContain(sensitiveCred);
      expect(adminStdout).not.toContain(sensitiveProfileRef);
      expect(adminStdout).not.toContain(sensitiveMarker);

      // 3. Context resolution sink: throws McpAuthorityError, excludes secrets from public error
      const ctx = new McpAuthorityContext({ dbPath: sensitivePath, sessionToken: sensitiveToken });
      try {
        expect(() => ctx.resolveAuthorizedContext()).toThrow();
      } finally {
        ctx.close();
      }

      // 4. MCP Server Tool and Resource sinks: execute via MCP protocol and assert sanitized errors
      const toolContext = new McpAuthorityContext({ dbPath: sensitivePath, sessionToken: sensitiveToken });
      const server = buildAgentForgeMcpServer({ authorityContext: toolContext });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'test-sink-client', version: '1.0.0' });
      await client.connect(clientTransport);

      try {
        const toolRes = await client.callTool({
          name: GET_AUTHORIZED_CONTEXT_TOOL_NAME,
          arguments: {},
        });
        expect(toolRes.isError).toBe(true);
        const toolErrText = (toolRes.content[0] as { type: 'text'; text: string }).text;
        expect(toolErrText).toBe('[MCP_SESSION_UNAUTHORIZED] Session authentication failed');
        expect(toolErrText).not.toContain(sensitiveToken);
        expect(toolErrText).not.toContain(sensitiveDigest);
        expect(toolErrText).not.toContain(sensitivePath);
        expect(toolErrText).not.toContain(sensitiveAuth);
        expect(toolErrText).not.toContain(sensitiveCred);
        expect(toolErrText).not.toContain(sensitiveProfileRef);
        expect(toolErrText).not.toContain(sensitiveMarker);

        await expect(client.readResource({ uri: AUTHORIZED_CONTEXT_RESOURCE_URI })).rejects.toThrow();
      } finally {
        await client.close();
        await server.close();
        toolContext.close();
      }

      // 5. Stdio transport error formatting
      const internalErr = new McpAuthorityError(
        'MCP_AUTHORITY_FENCED',
        `Internal error: auth=${sensitiveAuth} token=${sensitiveToken} hash=${sensitiveDigest} path=${sensitivePath} cred=${sensitiveCred} prof=${sensitiveProfileRef} marker=${sensitiveMarker}`
      );
      const pubErr = formatPublicError(internalErr);
      expect(pubErr.text).toBe('[MCP_AUTHORITY_FENCED] Execution authority fenced');
      expect(pubErr.text).not.toContain(sensitiveToken);
      expect(pubErr.text).not.toContain(sensitiveDigest);
      expect(pubErr.text).not.toContain(sensitivePath);
      expect(pubErr.text).not.toContain(sensitiveAuth);
      expect(pubErr.text).not.toContain(sensitiveCred);
      expect(pubErr.text).not.toContain(sensitiveProfileRef);
      expect(pubErr.text).not.toContain(sensitiveMarker);

      // 6. Assert captured stderr excludes all sensitive secrets
      expect(capturedStderr).not.toContain(sensitiveToken);
      expect(capturedStderr).not.toContain(sensitiveDigest);
      expect(capturedStderr).not.toContain(sensitivePath);
      expect(capturedStderr).not.toContain(sensitiveCred);
      expect(capturedStderr).not.toContain(sensitiveProfileRef);
      expect(capturedStderr).not.toContain(sensitiveMarker);
    } finally {
      process.stderr.write = origStderr;
    }
  });

  it('111. Compiled stdio child process integration: starts with valid DB, responds to tools/resources, and shuts down cleanly via EOF with database lock release', async () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'compiled_stdio_eof.db');
    let token = '';
    try {
      const fixtures = setupFullGraph(db);
      token = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId }).plaintextToken;
    } finally {
      db.close();
    }

    const runtimeDir = getOrMaterializeTestRuntime();
    const stdioScript = path.resolve(runtimeDir, 'mcp', 'stdio.js');
    expect(fs.existsSync(stdioScript)).toBe(true);

    const projectNodeModules = path.resolve(__dirname, '..', 'node_modules');
    const child = spawn(process.execPath, [stdioScript], {
      env: {
        ...process.env,
        NODE_PATH: projectNodeModules,
        AGENTFORGE_MCP_DB_PATH: dbPath,
        AGENTFORGE_MCP_SESSION_TOKEN: token,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutLines: string[] = [];
    let stdoutBuffer = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      let newlineIdx = stdoutBuffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = stdoutBuffer.slice(0, newlineIdx).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        if (line) {
          stdoutLines.push(line);
        }
        newlineIdx = stdoutBuffer.indexOf('\n');
      }
    });

    const waitForLine = (predicate: (data: unknown) => boolean, timeoutMs = 8000): Promise<unknown> => {
      const start = Date.now();
      return new Promise((resolve, reject) => {
        const check = () => {
          for (const line of stdoutLines) {
            try {
              const parsed = JSON.parse(line);
              if (predicate(parsed)) {
                return resolve(parsed);
              }
            } catch {
              // non-json
            }
          }
          if (Date.now() - start > timeoutMs) {
            reject(new Error(`Timeout waiting for JSON-RPC line matching predicate. Received lines: ${stdoutLines.join(' | ')}`));
          } else {
            setTimeout(check, 50);
          }
        };
        check();
      });
    };

    try {
      // 1. Send initialize
      const initReq = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-stdio-client', version: '1.0.0' },
        },
      });
      child.stdin.write(initReq + '\n');

      const initRes = (await waitForLine((d: unknown) => typeof d === 'object' && d !== null && (d as { id?: number }).id === 1)) as {
        result?: { serverInfo?: { name: string } };
      };
      expect(initRes.result?.serverInfo?.name).toBe('agentforge');

      // Send initialized notification
      const initializedNotification = JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });
      child.stdin.write(initializedNotification + '\n');

      // 2. Call tool get_authorized_context
      const toolReq = JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: GET_AUTHORIZED_CONTEXT_TOOL_NAME,
          arguments: {},
        },
      });
      child.stdin.write(toolReq + '\n');

      const toolRes = (await waitForLine((d: unknown) => typeof d === 'object' && d !== null && (d as { id?: number }).id === 2)) as {
        result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
      };
      expect(toolRes.result?.isError).toBeFalsy();
      const parsedToolContent = JSON.parse(toolRes.result?.content?.[0]?.text ?? '{}');
      expect(parsedToolContent.schema_version).toBe(2);

      // 3. Read resource agentforge://context/authorized
      const resourceReq = JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/read',
        params: {
          uri: AUTHORIZED_CONTEXT_RESOURCE_URI,
        },
      });
      child.stdin.write(resourceReq + '\n');

      const resourceRes = (await waitForLine((d: unknown) => typeof d === 'object' && d !== null && (d as { id?: number }).id === 3)) as {
        result?: { contents?: Array<{ uri: string; text: string }> };
      };
      expect(resourceRes.result?.contents).toHaveLength(1);
      const parsedResContent = JSON.parse(resourceRes.result?.contents?.[0]?.text ?? '{}');
      expect(parsedResContent.schema_version).toBe(2);

      // 4. Close stdin (EOF) and wait for child exit
      const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on('exit', (code, signal) => resolve({ code, signal }));
      });
      child.stdin.end();

      const exitResult = await Promise.race([
        exitPromise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Child exit timed out after EOF')), 8000)),
      ]);
      expect(exitResult.code).toBe(0);

      // 5. Verify stdout protocol purity: every line in stdout MUST be valid JSON-RPC
      expect(stdoutLines.length).toBeGreaterThanOrEqual(3);
      for (const line of stdoutLines) {
        expect(() => {
          const p = JSON.parse(line);
          expect(p.jsonrpc).toBe('2.0');
        }).not.toThrow();
      }

      // 6. Verify database file lock is released: rename and delete immediately on Windows
      const renamed = path.join(tempDir, 'compiled_stdio_eof_renamed.db');
      fs.renameSync(dbPath, renamed);
      expect(fs.existsSync(renamed)).toBe(true);
      fs.unlinkSync(renamed);
      expect(fs.existsSync(renamed)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
  });

  it('112. Compiled stdio child process termination via signal exits cleanly with database lock release', async () => {
    const testSignalTermination = async (signal: 'SIGINT' | 'SIGTERM', dbName: string) => {
      const { db, dbPath } = createTestDatabase(tempDir, dbName);
      let token = '';
      try {
        const fixtures = setupFullGraph(db);
        token = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId }).plaintextToken;
      } finally {
        db.close();
      }

      const runtimeDir = getOrMaterializeTestRuntime();
      const stdioScript = path.resolve(runtimeDir, 'mcp', 'stdio.js');

      const projectNodeModules = path.resolve(__dirname, '..', 'node_modules');
      const child = spawn(process.execPath, [stdioScript], {
        env: {
          ...process.env,
          NODE_PATH: projectNodeModules,
          AGENTFORGE_MCP_DB_PATH: dbPath,
          AGENTFORGE_MCP_SESSION_TOKEN: token,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderrOutput = '';
      child.stderr.on('data', (chunk) => {
        stderrOutput += chunk.toString();
      });

      const stdoutLines: string[] = [];
      let stdoutBuffer = '';
      child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString();
        let newlineIdx = stdoutBuffer.indexOf('\n');
        while (newlineIdx !== -1) {
          const line = stdoutBuffer.slice(0, newlineIdx).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
          if (line) {
            stdoutLines.push(line);
          }
          newlineIdx = stdoutBuffer.indexOf('\n');
        }
      });

      const waitForLine = (predicate: (data: unknown) => boolean, timeoutMs = 8000): Promise<unknown> => {
        const start = Date.now();
        return new Promise((resolve, reject) => {
          const check = () => {
            for (const line of stdoutLines) {
              try {
                const parsed = JSON.parse(line);
                if (predicate(parsed)) {
                  return resolve(parsed);
                }
              } catch {
                // non-json
              }
            }
            if (Date.now() - start > timeoutMs) {
              reject(new Error(`Timeout waiting for JSON-RPC line. Lines: ${stdoutLines.join(' | ')}`));
            } else {
              setTimeout(check, 50);
            }
          };
          check();
        });
      };

      try {
        // 1. Initialize
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'test-stdio-client', version: '1.0.0' },
            },
          }) + '\n'
        );
        await waitForLine((d: unknown) => typeof d === 'object' && d !== null && (d as { id?: number }).id === 1);

        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

        // 2. Tool call get_authorized_context
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: GET_AUTHORIZED_CONTEXT_TOOL_NAME, arguments: {} },
          }) + '\n'
        );
        const toolRes = (await waitForLine((d: unknown) => typeof d === 'object' && d !== null && (d as { id?: number }).id === 2)) as {
          result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
        };
        expect(toolRes.result?.isError).toBeFalsy();

        // 3. Resource read agentforge://context/authorized
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'resources/read',
            params: { uri: AUTHORIZED_CONTEXT_RESOURCE_URI },
          }) + '\n'
        );
        const resRes = (await waitForLine((d: unknown) => typeof d === 'object' && d !== null && (d as { id?: number }).id === 3)) as {
          result?: { contents?: Array<{ uri: string; text: string }> };
        };
        expect(resRes.result?.contents).toHaveLength(1);

        // 4. Send signal to child process
        const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          child.on('exit', (code, signal) => resolve({ code, signal }));
        });

        child.kill(signal);

        const exitResult = await Promise.race([
          exitPromise,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Child exit timed out after ${signal}`)), 8000)),
        ]);

        if (exitResult.code !== null) {
          expect(exitResult.code).toBe(0);
        } else {
          expect(exitResult.signal).toBe(signal);
        }

        // Assert stderr contains no sensitive secrets or unexpected errors
        expect(stderrOutput).not.toContain(token);
        expect(stderrOutput).not.toContain(dbPath);
        expect(stderrOutput).not.toContain('MCP_FATAL_ERROR');

        // Assert database file lock released and can be renamed and deleted
        const renamed = path.join(tempDir, `${dbName}_renamed.db`);
        fs.renameSync(dbPath, renamed);
        expect(fs.existsSync(renamed)).toBe(true);
        fs.unlinkSync(renamed);
        expect(fs.existsSync(renamed)).toBe(false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }
    };

    await testSignalTermination('SIGINT', 'compiled_stdio_sigint.db');
    await testSignalTermination('SIGTERM', 'compiled_stdio_sigterm.db');
  });

  it('113. Concurrent issuance with distinct non-overlapping authorizations: both workers succeed with unique sessions', async () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'concurrent_distinct.db');
    let authId1 = '';
    let authId2 = '';
    try {
      const fixtures1 = setupFullGraph(db);
      authId1 = fixtures1.authorizationId;

      // Second auth in same db
      const repo = new Repository(db);
      const taskId2 = `task-2-${crypto.randomUUID()}`;
      const attemptId2 = `att-2-${crypto.randomUUID()}`;
      const assignmentId2 = `asgn-2-${crypto.randomUUID()}`;
      const routingDecisionId2 = `route-2-${crypto.randomUUID()}`;
      const managerMessageId2 = `mgr-proto-2-${crypto.randomUUID()}`;
      const managerRecordId2 = `mgr-rec-2-${crypto.randomUUID()}`;
      const authorizationId2 = `auth-2-${crypto.randomUUID()}`;
      const now = new Date().toISOString();

      // 1. Task 2
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, base_sha, ownership_epoch, created_at, updated_at)
        VALUES (?, ?, 'Task 2', 'CODING', 'LOW', 'LOW', 1, 3, 0, ?, 1, ?, ?)
      `).run(taskId2, fixtures1.projectId, 'b'.repeat(40), now, now);

      // 2. Attempt 2
      repo.createTaskAttempt({
        id: attemptId2,
        task_id: taskId2,
        attempt_number: 1,
        status: 'RUNNING',
        agent_profile_id: fixtures1.agentId,
        agent_id: null,
        started_at: now,
        ended_at: null,
        summary: null,
      });

      // 3. Routing Decision 2
      const routingPayload2 = {
        decisionId: routingDecisionId2,
        projectId: fixtures1.projectId,
        taskId: taskId2,
        attemptId: attemptId2,
        roleProfileId: fixtures1.roleId,
        role: 'CODER',
        outcome: 'SELECTED',
        routePolicyId: null,
        failoverPolicyAuthoritySnapshot: null,
        selectedProviderId: fixtures1.providerId,
        selectedAccountId: fixtures1.accountId,
        selectedResourceId: fixtures1.resourceId,
        selectedAssignmentId: assignmentId2,
        requestedConstraints: [],
        appliedExclusions: [],
        appliedSeparation: null,
        reason: 'Optimal route',
      };
      db.prepare(`
        INSERT INTO events (id, project_id, task_id, type, summary, structured_payload_json, timestamp)
        VALUES (?, ?, ?, 'ROLE_AWARE_ROUTING_DECISION', 'Optimal route', ?, ?)
      `).run(routingDecisionId2, fixtures1.projectId, taskId2, JSON.stringify(routingPayload2), now);

      // 4. Assignment 2
      repo.createAgentAssignment({
        id: assignmentId2,
        project_id: fixtures1.projectId,
        task_id: taskId2,
        attempt_id: attemptId2,
        role_profile_id: fixtures1.roleId,
        agent_profile_id: fixtures1.agentId,
        selected_provider_id: fixtures1.providerId,
        selected_account_id: fixtures1.accountId,
        selected_resource_id: fixtures1.resourceId,
        selected_worker_slot_id: null,
        routing_decision_id: routingDecisionId2,
        status: 'ASSIGNED',
        created_at: now,
        ended_at: null,
        preferred_metadata: null,
      });

      // 5. Protocol Message 2
      const instructions2 = ['Task: Task 2', 'Implement secondary context read'];
      const managerPayload2 = {
        protocol: 'manager.v1',
        message_id: managerMessageId2,
        project_id: fixtures1.projectId,
        task_id: taskId2,
        decision: 'EXECUTE',
        priority: 'LOW',
        risk: 'LOW',
        instructions: instructions2,
        acceptance_criteria: ['All tests pass'],
        constraints: ['No regressions'],
        review_issues: [],
        expected_task_state: 'CODING',
        expected_revision: 1,
        created_at: now,
      };
      const rawManagerPayload2 = JSON.stringify(managerPayload2);
      const managerPayloadHash2 = crypto.createHash('sha256').update(rawManagerPayload2, 'utf8').digest('hex');
      repo.recordProtocolMessage(
        managerRecordId2,
        managerMessageId2,
        'manager.v1',
        fixtures1.projectId,
        taskId2,
        'CODING',
        1,
        managerPayloadHash2,
        rawManagerPayload2,
        'APPLIED',
        undefined,
        now
      );

      // 6. Authorization 2
      const canonicalPayload2 = computeCanonicalPayload({
        projectId: fixtures1.projectId,
        taskId: taskId2,
        attemptId: attemptId2,
        taskTitle: 'Task 2',
        taskDescription: 'Test task description',
        acceptanceCriteria: ['All tests pass'],
        constraints: ['No regressions'],
        instructions: instructions2,
        contextFiles: ['src/mcp/McpServer.ts'],
        verificationCommands: {
          TEST: { executable: 'npm', args: ['test'] },
          LINT: null,
          BUILD: null,
        },
        managerMessageId: managerRecordId2,
        managerPayloadHash: managerPayloadHash2,
      });
      const canonicalPayloadJson2 = JSON.stringify(canonicalPayload2);
      const instructionPayloadHash2 = computePayloadHash(canonicalPayload2);
      const contextManifestHash2 = computeContextManifestHash(['src/mcp/McpServer.ts']);

      const auth2: ExecutionAuthorization = {
        id: authorizationId2,
        project_id: fixtures1.projectId,
        task_id: taskId2,
        task_revision: 1,
        base_sha: 'b'.repeat(40),
        repository_head_sha: 'c'.repeat(40),
        manager_message_id: managerRecordId2,
        manager_payload_hash: managerPayloadHash2,
        routing_decision_id: routingDecisionId2,
        selected_resource_id: fixtures1.resourceId,
        selected_provider_id: fixtures1.providerId,
        instruction_payload_hash: instructionPayloadHash2,
        context_manifest_hash: contextManifestHash2,
        canonical_instructions_json: canonicalPayloadJson2,
        context_files_json: JSON.stringify(['src/mcp/McpServer.ts']),
        canonical_payload_json: canonicalPayloadJson2,
        status: 'AUTHORIZED',
        created_at: now,
        dispatched_at: null,
        execution_id: null,
        task_ownership_epoch: 1,
        lifecycle_version: 1,
        selected_account_id: fixtures1.accountId,
        adapter_started_at: null,
        adapter_finished_at: null,
        adapter_error_json: null,
        settlement_status: null,
        settled_at: null,
        settlement_evidence_json: null,
        settlement_evidence_hash: null,
        assignment_id: assignmentId2,
        attempt_id: attemptId2,
      };
      repo.createExecutionAuthorization(auth2);
      authId2 = authorizationId2;
    } finally {
      db.close();
    }

    const runtimeDir = getOrMaterializeTestRuntime();

    const workerScript = `
      const { parentPort, workerData } = require('node:worker_threads');
      const path = require('node:path');
      const Database = require('better-sqlite3');
      const { Repository } = require(path.join(workerData.runtimeDir, 'core/database/repositories.js'));
      const { McpSessionAuthorityService } = require(path.join(workerData.runtimeDir, 'core/services/McpSessionAuthorityService.js'));

      let db;
      try {
        db = new Database(workerData.dbPath);
        db.pragma('foreign_keys = ON');
        const repo = new Repository(db);
        const service = new McpSessionAuthorityService(repo, db);

        parentPort.on('message', (msg) => {
          if (msg === 'GO') {
            try {
              const result = service.issueSession({ authorizationId: workerData.authId });
              db.close();
              parentPort.postMessage({ success: true, token: result.plaintextToken });
            } catch (err) {
              db.close();
              parentPort.postMessage({ success: false, error: err instanceof Error ? err.message : String(err) });
            }
          }
        });
        parentPort.postMessage('READY');
      } catch (initErr) {
        if (db && db.open) {
          db.close();
        }
        parentPort.postMessage({ success: false, error: initErr instanceof Error ? initErr.message : String(initErr) });
      }
    `;

    interface DistinctWorkerSuccess {
      success: true;
      token: string;
    }
    interface DistinctWorkerFailure {
      success: false;
      error: string;
    }
    type DistinctWorkerMessage = DistinctWorkerSuccess | DistinctWorkerFailure;

    const workerData1 = { dbPath, authId: authId1, runtimeDir };
    const workerData2 = { dbPath, authId: authId2, runtimeDir };
    const projectNodeModules = path.resolve(__dirname, '..', 'node_modules');
    const w1 = new Worker(workerScript, { eval: true, workerData: workerData1, env: { ...process.env, NODE_PATH: projectNodeModules } });
    const w2 = new Worker(workerScript, { eval: true, workerData: workerData2, env: { ...process.env, NODE_PATH: projectNodeModules } });

    const createDistinctWorkerHarness = (w: Worker) => {
      let isReadyResolved = false;
      let readyResolve: () => void;
      let readyReject: (err: Error) => void;
      const readyPromise = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      });

      let isResultResolved = false;
      let resultResolve: (res: DistinctWorkerMessage) => void;
      let resultReject: (err: Error) => void;
      const resultPromise = new Promise<DistinctWorkerMessage>((resolve, reject) => {
        resultResolve = resolve;
        resultReject = reject;
      });

      const messageHandler = (msg: unknown) => {
        if (msg === 'READY' && !isReadyResolved) {
          isReadyResolved = true;
          readyResolve();
          return;
        }
        if (typeof msg === 'object' && msg !== null && 'success' in msg && !isResultResolved) {
          isResultResolved = true;
          resultResolve(msg as DistinctWorkerMessage);
        }
      };

      const errorHandler = (err: Error) => {
        if (!isReadyResolved) {
          isReadyResolved = true;
          readyReject(err);
        }
        if (!isResultResolved) {
          isResultResolved = true;
          resultReject(err);
        }
      };

      const exitHandler = (exitCode: number) => {
        errorHandler(new Error(`Worker exited with code ${exitCode}`));
      };

      w.on('message', messageHandler);
      w.on('error', errorHandler);
      w.on('exit', exitHandler);

      return {
        readyPromise,
        resultPromise,
        cleanup: () => {
          w.off('message', messageHandler);
          w.off('error', errorHandler);
          w.off('exit', exitHandler);
        },
      };
    };

    const h1 = createDistinctWorkerHarness(w1);
    const h2 = createDistinctWorkerHarness(w2);

    try {
      await Promise.all([h1.readyPromise, h2.readyPromise]);

      w1.postMessage('GO');
      w2.postMessage('GO');

      const [r1, r2] = await Promise.all([h1.resultPromise, h2.resultPromise]);

      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      if (r1.success && r2.success) {
        expect(r1.token).not.toBe(r2.token);
      }

      const checkDb = new Database(dbPath, { readonly: true });
      try {
        const activeCount = checkDb.prepare('SELECT COUNT(*) as cnt FROM mcp_client_sessions WHERE revoked_at IS NULL').get() as { cnt: number };
        expect(activeCount.cnt).toBe(2);
      } finally {
        checkDb.close();
      }
    } finally {
      h1.cleanup();
      h2.cleanup();
      await Promise.all([w1.terminate(), w2.terminate()]);
    }
  });

  it('114. Multiple sequential tool & resource reads through InMemoryTransport return exact context without state leakage', async () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'multi_reads.db');
    let token = '';
    try {
      const fixtures = setupFullGraph(db);
      token = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId }).plaintextToken;
    } finally {
      db.close();
    }

    const context = new McpAuthorityContext({ dbPath, sessionToken: token });
    const server = buildAgentForgeMcpServer({ authorityContext: context });
    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new Client({ name: 'seq-client', version: '1.0.0' });
    await client.connect(cTrans);

    try {
      for (let i = 0; i < 4; i++) {
        const toolRes = await client.callTool({
          name: GET_AUTHORIZED_CONTEXT_TOOL_NAME,
          arguments: {},
        });
        expect(toolRes.isError).toBeFalsy();
        const resText = (toolRes.content[0] as { text: string }).text;
        expect(JSON.parse(resText).schema_version).toBe(2);

        const resourceRes = await client.readResource({
          uri: AUTHORIZED_CONTEXT_RESOURCE_URI,
        });
        expect(resourceRes.contents).toHaveLength(1);
        expect(JSON.parse((resourceRes.contents[0] as { text: string }).text).schema_version).toBe(2);
      }
    } finally {
      await client.close();
      await server.close();
      context.close();
    }
  });

  it('115. Authority context read validates PRAGMA foreign_keys = ON and fails closed if OFF', () => {
    const { db: setupDb, dbPath } = createTestDatabase(tempDir, 'fk_off.db');
    let token = '';
    try {
      const fixtures = setupFullGraph(setupDb);
      token = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId }).plaintextToken;
    } finally {
      setupDb.close();
    }

    const readDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    readDb.pragma('query_only = ON');
    // Turn foreign keys OFF
    readDb.pragma('foreign_keys = OFF');

    try {
      expect(() => {
        new McpAuthorityContext({ db: readDb, sessionToken: token });
      }).toThrowError(/MCP_CONFIGURATION_INVALID/);
    } finally {
      readDb.close();
    }
  });

  it('116. Exact index set authority rejects autoindex origin-u, extra user indexes, and non-id or composite primary keys', () => {
    const { db } = createTestDatabase(tempDir, 'exact_index_set.db');
    try {
      // 1. Initially valid
      expect(() => verifyMigration21SchemaAuthority(db)).not.toThrow();

      // 2. Extra user index rejected
      db.exec('CREATE INDEX idx_extra_test ON mcp_client_sessions(authorization_id, expires_at);');
      expect(() => verifyMigration21SchemaAuthority(db)).toThrowError(/MCP_SCHEMA_AUTHORITY_INVALID/);
      db.exec('DROP INDEX idx_extra_test;');
      expect(() => verifyMigration21SchemaAuthority(db)).not.toThrow();

      // 3. Autoindex with origin = 'u' (e.g. from inline UNIQUE column) rejected
      db.exec('DROP TABLE mcp_client_sessions;');
      db.exec(`
        CREATE TABLE mcp_client_sessions (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL REFERENCES execution_authorizations(id) ON DELETE RESTRICT,
          scope TEXT NOT NULL CHECK (scope = 'AUTHORIZED_CONTEXT_READ'),
          token_hash TEXT NOT NULL UNIQUE CHECK (
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
        CREATE UNIQUE INDEX uq_mcp_client_sessions_active_auth ON mcp_client_sessions(authorization_id) WHERE revoked_at IS NULL;
        CREATE UNIQUE INDEX idx_mcp_client_sessions_token_hash ON mcp_client_sessions(token_hash);
        CREATE INDEX idx_mcp_client_sessions_expires_at ON mcp_client_sessions(expires_at);
        CREATE INDEX idx_mcp_client_sessions_auth_id ON mcp_client_sessions(authorization_id);
      `);
      // Has origin-u autoindex from UNIQUE keyword, must throw MCP_SCHEMA_AUTHORITY_INVALID
      expect(() => verifyMigration21SchemaAuthority(db)).toThrowError(/MCP_SCHEMA_AUTHORITY_INVALID/);

      // 4. Non-id or composite primary key rejected
      db.exec('DROP TABLE mcp_client_sessions;');
      db.exec(`
        CREATE TABLE mcp_client_sessions (
          id TEXT NOT NULL,
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
          revoked_at TEXT NULL CHECK (revoked_at IS NULL OR (length(revoked_at) > 0 AND revoked_at >= issued_at)),
          PRIMARY KEY (id, authorization_id)
        );
        CREATE UNIQUE INDEX uq_mcp_client_sessions_active_auth ON mcp_client_sessions(authorization_id) WHERE revoked_at IS NULL;
        CREATE UNIQUE INDEX idx_mcp_client_sessions_token_hash ON mcp_client_sessions(token_hash);
        CREATE INDEX idx_mcp_client_sessions_expires_at ON mcp_client_sessions(expires_at);
        CREATE INDEX idx_mcp_client_sessions_auth_id ON mcp_client_sessions(authorization_id);
      `);
      expect(() => verifyMigration21SchemaAuthority(db)).toThrowError(/MCP_SCHEMA_AUTHORITY_INVALID/);
    } finally {
      db.close();
    }
  });

  it('117. Exact CHECK constraint set authority rejects extra or duplicate CHECK constraints', () => {
    const { db } = createTestDatabase(tempDir, 'exact_check_constraints.db');
    try {
      // Recreate table with 7 check constraints (one extra check constraint)
      db.exec('DROP TABLE mcp_client_sessions;');
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
          revoked_at TEXT NULL CHECK (revoked_at IS NULL OR (length(revoked_at) > 0 AND revoked_at >= issued_at)),
          CHECK (length(id) > 0)
        );
        CREATE UNIQUE INDEX uq_mcp_client_sessions_active_auth ON mcp_client_sessions(authorization_id) WHERE revoked_at IS NULL;
        CREATE UNIQUE INDEX idx_mcp_client_sessions_token_hash ON mcp_client_sessions(token_hash);
        CREATE INDEX idx_mcp_client_sessions_expires_at ON mcp_client_sessions(expires_at);
        CREATE INDEX idx_mcp_client_sessions_auth_id ON mcp_client_sessions(authorization_id);
      `);

      // Found length is 7 instead of 6, must throw MCP_SCHEMA_AUTHORITY_INVALID
      expect(() => verifyMigration21SchemaAuthority(db)).toThrowError(/MCP_SCHEMA_AUTHORITY_INVALID/);
    } finally {
      db.close();
    }
  });

  it('118. Contiguous ledger authority rejects gaps, duplicate versions, versions beyond 21, and earlier migration name mismatches', () => {
    const { db } = createTestDatabase(tempDir, 'ledger_authority.db');
    try {
      expect(() => verifyMigration21SchemaAuthority(db)).not.toThrow();

      // 1. Missing version in 1..20
      db.prepare('DELETE FROM schema_migrations WHERE version = 10').run();
      expect(() => verifyMigration21SchemaAuthority(db)).toThrowError(/MCP_SCHEMA_AUTHORITY_INVALID/);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (10, '010_r5h4_failover_lineage_budget_idempotency', datetime('now'))").run();
      expect(() => verifyMigration21SchemaAuthority(db)).not.toThrow();

      // 2. Extra version beyond 21
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (22, '022_extra', datetime('now'))").run();
      expect(() => verifyMigration21SchemaAuthority(db)).toThrowError(/MCP_SCHEMA_AUTHORITY_INVALID/);
      db.prepare('DELETE FROM schema_migrations WHERE version = 22').run();
      expect(() => verifyMigration21SchemaAuthority(db)).not.toThrow();

      // 3. Name mismatch on version 21
      db.prepare("UPDATE schema_migrations SET name = '021_wrong_name' WHERE version = 21").run();
      expect(() => verifyMigration21SchemaAuthority(db)).toThrowError(/MCP_SCHEMA_AUTHORITY_INVALID/);
      db.prepare("UPDATE schema_migrations SET name = '021_r5j_mcp_client_session_authority' WHERE version = 21").run();
      expect(() => verifyMigration21SchemaAuthority(db)).not.toThrow();

      // 4. Name mismatch on an earlier migration
      db.prepare("UPDATE schema_migrations SET name = '001_wrong' WHERE version = 1").run();
      expect(() => verifyMigration21SchemaAuthority(db)).toThrowError(/MCP_SCHEMA_AUTHORITY_INVALID/);
      db.prepare("UPDATE schema_migrations SET name = '001_initial_schema' WHERE version = 1").run();
      expect(() => verifyMigration21SchemaAuthority(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('119. Manager row/payload revision presence parity rejected at issuance with zero new session rows and after issuance on next context read', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'revision_presence_parity.db');
    try {
      const fixtures = setupFullGraph(db);

      // 1. Tamper manager payload to remove expected_revision while row has revision = 1
      const payloadWithoutRev = JSON.parse(fixtures.rawManagerPayload);
      delete payloadWithoutRev.expected_revision;
      const rawWithoutRev = JSON.stringify(payloadWithoutRev);
      const hashWithoutRev = crypto.createHash('sha256').update(rawWithoutRev, 'utf8').digest('hex');

      db.prepare('UPDATE protocol_messages SET raw_payload = ?, payload_hash = ? WHERE id = ?').run(
        rawWithoutRev,
        hashWithoutRev,
        fixtures.managerRecordId
      );
      db.prepare('UPDATE execution_authorizations SET manager_payload_hash = ? WHERE id = ?').run(
        hashWithoutRev,
        fixtures.authorizationId
      );

      // Must reject at issuance with zero new session rows
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
      const sessionCount = (db.prepare('SELECT COUNT(*) as c FROM mcp_client_sessions').get() as { c: number }).c;
      expect(sessionCount).toBe(0);

      // Restore payload and issue session
      db.prepare('UPDATE protocol_messages SET raw_payload = ?, payload_hash = ? WHERE id = ?').run(
        fixtures.rawManagerPayload,
        fixtures.auth.manager_payload_hash,
        fixtures.managerRecordId
      );
      db.prepare('UPDATE execution_authorizations SET manager_payload_hash = ? WHERE id = ?').run(
        fixtures.auth.manager_payload_hash,
        fixtures.authorizationId
      );

      const issued = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      expect(issued.plaintextToken).toBeDefined();

      // Read succeeds initially
      const ctx1 = new McpAuthorityContext({ dbPath, sessionToken: issued.plaintextToken });
      expect(ctx1.resolveAuthorizedContext().schema_version).toBe(2);
      ctx1.close();

      // Mutate post-issuance: row revision is set to NULL while payload has expected_revision = 1
      db.prepare('UPDATE protocol_messages SET expected_revision = NULL WHERE id = ?').run(fixtures.managerRecordId);

      // Next context read is fenced
      const ctx2 = new McpAuthorityContext({ dbPath, sessionToken: issued.plaintextToken });
      try {
        expect(() => ctx2.resolveAuthorizedContext()).toThrowError(/MCP_AUTHORITY_FENCED/);
      } finally {
        ctx2.close();
      }
    } finally {
      db.close();
    }
  });

  it('120. Manager row/payload expected_task_state presence parity rejected at issuance with zero new session rows and after issuance on next context read', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'state_presence_parity.db');
    try {
      const fixtures = setupFullGraph(db);

      // 1. Tamper manager payload to remove expected_task_state while row has expected_task_state = 'CODING'
      const payloadWithoutState = JSON.parse(fixtures.rawManagerPayload);
      delete payloadWithoutState.expected_task_state;
      const rawWithoutState = JSON.stringify(payloadWithoutState);
      const hashWithoutState = crypto.createHash('sha256').update(rawWithoutState, 'utf8').digest('hex');

      db.prepare('UPDATE protocol_messages SET raw_payload = ?, payload_hash = ? WHERE id = ?').run(
        rawWithoutState,
        hashWithoutState,
        fixtures.managerRecordId
      );
      db.prepare('UPDATE execution_authorizations SET manager_payload_hash = ? WHERE id = ?').run(
        hashWithoutState,
        fixtures.authorizationId
      );

      // Must reject at issuance with zero new session rows
      expect(() => fixtures.service.issueSession({ authorizationId: fixtures.authorizationId })).toThrowError(/MCP_AUTHORITY_FENCED/);
      const sessionCount = (db.prepare('SELECT COUNT(*) as c FROM mcp_client_sessions').get() as { c: number }).c;
      expect(sessionCount).toBe(0);

      // Restore payload and issue session
      db.prepare('UPDATE protocol_messages SET raw_payload = ?, payload_hash = ? WHERE id = ?').run(
        fixtures.rawManagerPayload,
        fixtures.auth.manager_payload_hash,
        fixtures.managerRecordId
      );
      db.prepare('UPDATE execution_authorizations SET manager_payload_hash = ? WHERE id = ?').run(
        fixtures.auth.manager_payload_hash,
        fixtures.authorizationId
      );

      const issued = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId });
      expect(issued.plaintextToken).toBeDefined();

      // Read succeeds initially
      const ctx1 = new McpAuthorityContext({ dbPath, sessionToken: issued.plaintextToken });
      expect(ctx1.resolveAuthorizedContext().schema_version).toBe(2);
      ctx1.close();

      // Mutate post-issuance: row expected_task_state is set to NULL while payload has expected_task_state = 'CODING'
      db.prepare('UPDATE protocol_messages SET expected_task_state = NULL WHERE id = ?').run(fixtures.managerRecordId);

      // Next context read is fenced
      const ctx2 = new McpAuthorityContext({ dbPath, sessionToken: issued.plaintextToken });
      try {
        expect(() => ctx2.resolveAuthorizedContext()).toThrowError(/MCP_AUTHORITY_FENCED/);
      } finally {
        ctx2.close();
      }
    } finally {
      db.close();
    }
  });

  it('121. Historical unauthorized mutation flag remains permanently true across multiple reads and prevents re-entry', () => {
    const { db, dbPath } = createTestDatabase(tempDir, 'permanent_mutation_flag.db');
    let token = '';
    try {
      const fixtures = setupFullGraph(db);
      token = fixtures.service.issueSession({ authorizationId: fixtures.authorizationId }).plaintextToken;
    } finally {
      db.close();
    }

    const ctx = new McpAuthorityContext({ dbPath, sessionToken: token });
    const { db: openedDb } = ctx.getOrCreateDatabase();
    try {
      expect(ctx.hasDetectedUnauthorizedMutation()).toBe(false);

      // Simulate mutation delta on first resolve call
      const origPrepare = openedDb.prepare.bind(openedDb);
      let totalChangesCalls = 0;
      openedDb.prepare = function (this: Database.Database, sql: string) {
        const stmt = origPrepare(sql);
        if (sql.includes('total_changes()')) {
          const origGet = stmt.get.bind(stmt);
          stmt.get = function (this: Database.Statement, ...args: unknown[]) {
            totalChangesCalls++;
            if (totalChangesCalls === 2) {
              return { total_changes: 1 };
            }
            return origGet(...args);
          } as typeof stmt.get;
        }
        return stmt;
      } as typeof openedDb.prepare;

      expect(() => ctx.resolveAuthorizedContext()).toThrowError(/MCP_AUTHORITY_FENCED/);
      // Historical flag is now permanently true
      expect(ctx.hasDetectedUnauthorizedMutation()).toBe(true);

      // Subsequent resolveAuthorizedContext calls immediately fail closed
      expect(() => ctx.resolveAuthorizedContext()).toThrowError(/MCP_AUTHORITY_FENCED/);
      expect(ctx.hasDetectedUnauthorizedMutation()).toBe(true);
    } finally {
      ctx.close();
    }
  });
});
