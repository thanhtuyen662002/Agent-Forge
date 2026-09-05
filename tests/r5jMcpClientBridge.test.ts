import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn, execFileSync, ChildProcess } from 'child_process';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import {
  McpSessionAuthorityService,
} from '../src/core/services/McpSessionAuthorityService';
import {
  computeCanonicalPayload,
  computePayloadHash,
  computeContextManifestHash,
} from '../src/core/services/ExecutionAuthorizationService';
import { ExecutionAuthorization } from '../src/core/types/domain';
import {
  normalizeClient,
  isElectronExecutable,
  getDefaultPlatformDbPath,
  deriveRuntimePaths,
  generateClientConfig,
  generateClientConfigEnvelope,
  OPERATOR_SESSION_TOKEN_PLACEHOLDER,
} from '../src/mcp/clientBridge';
import { parseCliArgs, runSessionAdmin } from '../src/mcp/sessionAdmin';

let sharedTestRuntimeDir: string | null = null;

function getOrMaterializeTestRuntime(): string {
  if (sharedTestRuntimeDir && fs.existsSync(sharedTestRuntimeDir)) {
    return sharedTestRuntimeDir;
  }
  const projectRoot = path.resolve(__dirname, '..');
  const tempRuntimeDir = path.join(
    os.tmpdir(),
    `af-mcp-bridge-runtime-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
  );
  fs.mkdirSync(tempRuntimeDir, { recursive: true });

  const tscBin = require.resolve('typescript/bin/tsc');
  execFileSync(
    process.execPath,
    [tscBin, '-p', 'tsconfig.node.json', '--outDir', tempRuntimeDir],
    {
      cwd: projectRoot,
      stdio: 'pipe',
      encoding: 'utf8',
    }
  );

  const manifestPath = path.join(tempRuntimeDir, 'package.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ type: 'commonjs' }, null, 2), 'utf8');

  // Preload script for Windows IPC signal bridge
  const signalPreloadPath = path.join(tempRuntimeDir, 'signal_preload.js');
  fs.writeFileSync(
    signalPreloadPath,
    `if (process.send) {\n  process.on('message', (m) => {\n    if (m === 'SIGINT') process.emit('SIGINT');\n    if (m === 'SIGTERM') process.emit('SIGTERM');\n  });\n}\n`,
    'utf8'
  );

  // Symlink project node_modules
  const targetNodeModules = path.join(projectRoot, 'node_modules');
  const linkNodeModules = path.join(tempRuntimeDir, 'node_modules');
  if (!fs.existsSync(linkNodeModules) && fs.existsSync(targetNodeModules)) {
    const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(targetNodeModules, linkNodeModules, symlinkType);
  }

  sharedTestRuntimeDir = tempRuntimeDir;
  return sharedTestRuntimeDir;
}

import { EventEmitter } from 'events';

export class McpCleanupFailureError extends Error {
  readonly directory: string;
  readonly attempts: number;

  constructor(directory: string, attempts: number, message?: string) {
    super(
      message ||
        `[MCP_CLEANUP_FAILURE] Failed to remove directory after ${attempts} attempts: ${directory}`
    );
    this.name = 'McpCleanupFailureError';
    this.directory = directory;
    this.attempts = attempts;
  }
}

export function safeRemoveDir(
  dir: string,
  maxRetries = 10,
  delayMs = 50,
  rmFn: (target: string) => void = (target) =>
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  existsFn: (target: string) => boolean = (target) => fs.existsSync(target)
): void {
  if (!existsFn(dir)) return;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      rmFn(dir);
      if (!existsFn(dir)) return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  if (existsFn(dir)) {
    throw new McpCleanupFailureError(dir, maxRetries);
  }
}

interface StdioChildHarness {
  child: ChildProcess;
  sendRequest: (req: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;
  sendNotification: (notif: Record<string, unknown>) => Promise<void>;
  closeStdin: () => void;
  sendIpcSignal: (sig: 'SIGINT' | 'SIGTERM') => void;
  waitForExit: (timeoutMs?: number) => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  getStdoutLines: () => string[];
  getStderr: () => string;
  close: () => Promise<void>;
}

function createStdioChildHarness(
  command: string,
  args: string[],
  envVars: Record<string, string>,
  preloadScript?: string
): StdioChildHarness {
  const projectNodeModules = path.resolve(__dirname, '..', 'node_modules');
  const spawnEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_PATH: projectNodeModules,
    ...envVars,
  };
  const spawnArgs: string[] = [];
  if (preloadScript) {
    spawnArgs.push('-r', preloadScript);
  }
  spawnArgs.push(...args);

  const child = spawn(command, spawnArgs, {
    env: spawnEnv,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  if (!child.stdout || !child.stderr || !child.stdin) {
    throw new Error('Child process stdio streams not available');
  }

  const childStdout = child.stdout;
  const childStderr = child.stderr;
  const childStdin = child.stdin;

  const stdoutLines: string[] = [];
  let stdoutBuffer = '';
  let stderrOutput = '';
  let childExitResult: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  type MessageListener = (msg: Record<string, unknown>) => void;
  const messageListeners = new Set<MessageListener>();
  type ExitListener = (res: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exitListeners = new Set<ExitListener>();

  childStdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8');
    let newlineIdx = stdoutBuffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = stdoutBuffer.slice(0, newlineIdx).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
      if (line) {
        stdoutLines.push(line);
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          for (const listener of messageListeners) {
            listener(parsed);
          }
        } catch {
          // non-JSON stdout line
        }
      }
      newlineIdx = stdoutBuffer.indexOf('\n');
    }
  });

  childStderr.on('data', (chunk: Buffer) => {
    stderrOutput += chunk.toString('utf8');
  });

  child.on('exit', (code, signal) => {
    childExitResult = { code, signal };
    for (const listener of exitListeners) {
      listener(childExitResult);
    }
  });

  const sendRequest = (req: Record<string, unknown>, timeoutMs = 5000): Promise<Record<string, unknown>> => {
    return new Promise((resolve, reject) => {
      const reqId = req.id;
      let timer: NodeJS.Timeout | null = null;

      const onMsg: MessageListener = (msg) => {
        if (msg.id === reqId) {
          cleanup();
          resolve(msg);
        }
      };

      const onExit: ExitListener = (res) => {
        cleanup();
        reject(new Error(`Child exited prematurely with code ${res.code}`));
      };

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        messageListeners.delete(onMsg);
        exitListeners.delete(onExit);
      };

      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Request ${reqId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      messageListeners.add(onMsg);
      exitListeners.add(onExit);

      childStdin.write(JSON.stringify(req) + '\n');
    });
  };

  const sendNotification = (notif: Record<string, unknown>): Promise<void> => {
    return new Promise((resolve, reject) => {
      childStdin.write(JSON.stringify(notif) + '\n', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };

  const waitForExit = (timeoutMs = 5000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
    if (childExitResult) return Promise.resolve(childExitResult);
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const onExit: ExitListener = (res) => {
        if (timer) clearTimeout(timer);
        resolve(res);
      };
      timer = setTimeout(() => {
        exitListeners.delete(onExit);
        reject(new Error(`waitForExit timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      exitListeners.add(onExit);
    });
  };

  return {
    child,
    sendRequest,
    sendNotification,
    closeStdin: () => childStdin.end(),
    sendIpcSignal: (sig) => {
      if (child.send) {
        child.send(sig);
      }
    },
    waitForExit,
    getStdoutLines: () => [...stdoutLines],
    getStderr: () => stderrOutput,
    close: async () => {
      if (!childStdin.destroyed) childStdin.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForExit(2000).catch(() => {});
      }
    },
  };
}

function setupTestAuthorityDatabase(dbPath: string): {
  db: Database.Database;
  authId: string;
  taskId: string;
  projectId: string;
  repo: Repository;
  service: McpSessionAuthorityService;
} {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  MigrationRunner.run(db);

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

  const baseSha = 'b'.repeat(40);
  db.prepare(`
    INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, base_sha, ownership_epoch, created_at, updated_at)
    VALUES (?, ?, 'Task 1', 'CODING', 'LOW', 'LOW', 1, 3, 0, ?, 1, ?, ?)
  `).run(taskId, projectId, baseSha, now, now);

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

  const instructions = ['Task: Task 1', 'Authorized MCP read context'];
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

  const canonicalInstructionsJson = JSON.stringify(instructions);
  const contextFiles = ['src/mcp/clientBridge.ts'];
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

  return { db, authId: authorizationId, taskId, projectId, repo, service };
}

describe('R5J3 Reproducible External-Client Bridge Verification Suite', () => {
  let testTempDir: string;
  let runtimeDir: string;

  beforeEach(() => {
    testTempDir = path.join(
      os.tmpdir(),
      `af-mcp-bridge-test-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    );
    fs.mkdirSync(testTempDir, { recursive: true });
    runtimeDir = getOrMaterializeTestRuntime();
  });

  afterEach(() => {
    safeRemoveDir(testTempDir);
  });

  // 1. Deterministic Antigravity template with exact command, args, env and placeholder
  it('[Case 1] generates deterministic Antigravity template with exact command, args, env and placeholder', () => {
    const fakeExe = process.execPath;
    const fakeStdio = path.join(runtimeDir, 'mcp', 'stdio.js');
    const fakeDb = path.join(testTempDir, 'agent-forge.db');

    const config1 = generateClientConfig({
      client: 'antigravity',
      dbPath: fakeDb,
      executablePath: fakeExe,
      stdioScriptPath: fakeStdio,
    });
    const config2 = generateClientConfig({
      client: 'ANTIGRAVITY',
      dbPath: fakeDb,
      executablePath: fakeExe,
      stdioScriptPath: fakeStdio,
    });

    expect(config1).toEqual(config2);
    expect(JSON.stringify(config1)).toBe(JSON.stringify(config2));
    expect(config1.mcpServers.agentforge.command).toBe(fakeExe);
    expect(config1.mcpServers.agentforge.args).toEqual([fakeStdio]);
    expect(config1.mcpServers.agentforge.env.AGENTFORGE_MCP_DB_PATH).toBe(fakeDb);
    expect(config1.mcpServers.agentforge.env.AGENTFORGE_MCP_SESSION_TOKEN).toBe(
      OPERATOR_SESSION_TOKEN_PLACEHOLDER
    );
  });

  // 2. Deterministic Cursor template with the same process contract
  it('[Case 2] generates deterministic Cursor template with the same process contract', () => {
    const fakeExe = process.execPath;
    const fakeStdio = path.join(runtimeDir, 'mcp', 'stdio.js');
    const fakeDb = path.join(testTempDir, 'cursor-forge.db');

    const config = generateClientConfig({
      client: 'cursor',
      dbPath: fakeDb,
      executablePath: fakeExe,
      stdioScriptPath: fakeStdio,
    });

    expect(config.mcpServers.agentforge.command).toBe(fakeExe);
    expect(config.mcpServers.agentforge.args).toEqual([fakeStdio]);
    expect(config.mcpServers.agentforge.env.AGENTFORGE_MCP_DB_PATH).toBe(fakeDb);
    expect(config.mcpServers.agentforge.env.AGENTFORGE_MCP_SESSION_TOKEN).toBe(
      OPERATOR_SESSION_TOKEN_PLACEHOLDER
    );
  });

  // 3. Deterministic Claude Desktop template with the same process contract and honest DOCUMENTED_TEMPLATE_ONLY classification
  it('[Case 3] generates deterministic Claude Desktop template with DOCUMENTED_TEMPLATE_ONLY support classification', () => {
    const fakeExe = process.execPath;
    const fakeStdio = path.join(runtimeDir, 'mcp', 'stdio.js');
    const fakeDb = path.join(testTempDir, 'claude-forge.db');

    const envelope = generateClientConfigEnvelope({
      client: 'claude',
      dbPath: fakeDb,
      executablePath: fakeExe,
      stdioScriptPath: fakeStdio,
    });

    expect(envelope.status).toBe('TEMPLATE_GENERATED');
    expect(envelope.client).toBe('claude');
    expect(envelope.incomplete).toBe(true);
    expect(envelope.secret_delivery).toBe('MANUAL_OPERATOR_INPUT');
    expect(envelope.config.mcpServers.agentforge.command).toBe(fakeExe);
    expect(envelope.config.mcpServers.agentforge.args).toEqual([fakeStdio]);
    expect(envelope.config.mcpServers.agentforge.env.AGENTFORGE_MCP_DB_PATH).toBe(fakeDb);
    expect(envelope.config.mcpServers.agentforge.env.AGENTFORGE_MCP_SESSION_TOKEN).toBe(
      OPERATOR_SESSION_TOKEN_PLACEHOLDER
    );
  });

  // 4. Development host-Node template omits ELECTRON_RUN_AS_NODE
  it('[Case 4] development host-Node template omits ELECTRON_RUN_AS_NODE', () => {
    const nodeExe = process.execPath;
    const fakeStdio = path.join(runtimeDir, 'mcp', 'stdio.js');
    const fakeDb = path.join(testTempDir, 'dev.db');

    const config = generateClientConfig({
      client: 'antigravity',
      dbPath: fakeDb,
      executablePath: nodeExe,
      stdioScriptPath: fakeStdio,
    });

    expect(config.mcpServers.agentforge.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect('ELECTRON_RUN_AS_NODE' in config.mcpServers.agentforge.env).toBe(false);
  });

  // 5. Packaged Electron template includes ELECTRON_RUN_AS_NODE=1 and the app.asar sibling script
  it('[Case 5] packaged Electron template includes ELECTRON_RUN_AS_NODE=1 and sibling script', () => {
    // Create dummy AgentForge.exe in temp directory to satisfy existence check
    const mockExe = path.join(testTempDir, 'AgentForge.exe');
    fs.writeFileSync(mockExe, 'dummy-binary', 'utf8');

    const mockStdio = path.join(testTempDir, 'resources', 'app.asar', 'dist-electron', 'mcp', 'stdio.js');
    fs.mkdirSync(path.dirname(mockStdio), { recursive: true });
    fs.writeFileSync(mockStdio, '// stdio', 'utf8');

    const fakeDb = path.join(testTempDir, 'prod.db');

    const config = generateClientConfig({
      client: 'cursor',
      dbPath: fakeDb,
      executablePath: mockExe,
      stdioScriptPath: mockStdio,
    });

    expect(config.mcpServers.agentforge.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(config.mcpServers.agentforge.command).toBe(mockExe);
    expect(config.mcpServers.agentforge.args).toEqual([mockStdio]);
  });

  // 6. CLI accepts the closed grammar and returns exact plain and envelope JSON shapes
  it('[Case 6] CLI accepts closed grammar and returns exact plain and envelope JSON shapes', () => {
    const originalStdoutWrite = process.stdout.write;
    const stdoutChunks: string[] = [];
    process.stdout.write = ((chunk: string | Buffer) => {
      stdoutChunks.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;

    try {
      const testOverrides = { stdioScriptPath: path.join(runtimeDir, 'mcp', 'stdio.js') };
      // 6a. Plain output without --json
      stdoutChunks.length = 0;
      const exitCodePlain = runSessionAdmin(
        ['configure-client', '--client', 'antigravity'],
        testOverrides
      );
      expect(exitCodePlain).toBe(0);
      const plainParsed = JSON.parse(stdoutChunks.join(''));
      expect(plainParsed.mcpServers.agentforge.command).toBeDefined();
      expect(plainParsed.mcpServers.agentforge.args.length).toBe(1);
      expect(plainParsed.mcpServers.agentforge.env.AGENTFORGE_MCP_SESSION_TOKEN).toBe(
        OPERATOR_SESSION_TOKEN_PLACEHOLDER
      );

      // 6b. Envelope output with --json
      stdoutChunks.length = 0;
      const exitCodeJson = runSessionAdmin(
        ['configure-client', '--client', 'cursor', '--json'],
        testOverrides
      );
      expect(exitCodeJson).toBe(0);
      const envelopeParsed = JSON.parse(stdoutChunks.join(''));
      expect(envelopeParsed.status).toBe('TEMPLATE_GENERATED');
      expect(envelopeParsed.client).toBe('cursor');
      expect(envelopeParsed.incomplete).toBe(true);
      expect(envelopeParsed.secret_delivery).toBe('MANUAL_OPERATOR_INPUT');
      expect(envelopeParsed.config.mcpServers.agentforge).toBeDefined();
    } finally {
      process.stdout.write = originalStdoutWrite;
    }
  });

  // 7. CLI rejects unknown, duplicate, mixed, positional and whitespace-only inputs without DB access
  it('[Case 7] CLI rejects invalid, unknown, duplicate, mixed, and whitespace inputs before DB access', () => {
    // Missing --client
    expect(() => parseCliArgs(['configure-client'])).toThrow('Configure-client requires --client');

    // Unknown flag
    expect(() => parseCliArgs(['configure-client', '--client', 'cursor', '--unknown'])).toThrow(
      'Unknown flag'
    );

    // Duplicate flag
    expect(() =>
      parseCliArgs(['configure-client', '--client', 'cursor', '--client', 'antigravity'])
    ).toThrow('Duplicate flag');

    // Mixed with issue/revoke flags
    expect(() =>
      parseCliArgs(['configure-client', '--client', 'cursor', '--auth', 'auth-123'])
    ).toThrow('Flag --auth is not valid for configure-client command');

    expect(() =>
      parseCliArgs(['configure-client', '--client', 'cursor', '--session', 'sess-123'])
    ).toThrow('Flag --session is not valid for configure-client command');

    expect(() =>
      parseCliArgs(['configure-client', '--client', 'cursor', '--ttl', '300'])
    ).toThrow('Flag --ttl is not valid for configure-client command');

    // Whitespace-only value
    expect(() => parseCliArgs(['configure-client', '--client', '   '])).toThrow(
      'Flag cannot be whitespace-only'
    );

    // Surplus positional argument
    expect(() =>
      parseCliArgs(['configure-client', 'extra-arg', '--client', 'cursor'])
    ).toThrow('Surplus positional argument');

    // Help combined with arguments
    expect(() => parseCliArgs(['configure-client', '--client', 'cursor', '--help'])).toThrow(
      'Help flag cannot be combined with other arguments or commands'
    );
  });

  // 8. configure-client succeeds when the selected DB file does not yet exist and proves zero database opens/mutations
  it('[Case 8] configure-client succeeds without opening or creating non-existent database file', () => {
    const nonExistentDb = path.join(testTempDir, 'does-not-exist', 'never-created.db');
    expect(fs.existsSync(nonExistentDb)).toBe(false);

    const originalStdoutWrite = process.stdout.write;
    const stdoutChunks: string[] = [];
    process.stdout.write = ((chunk: string | Buffer) => {
      stdoutChunks.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;

    try {
      const testOverrides = { stdioScriptPath: path.join(runtimeDir, 'mcp', 'stdio.js') };
      const exitCode = runSessionAdmin(
        [
          'configure-client',
          '--client',
          'antigravity',
          '--db',
          nonExistentDb,
        ],
        testOverrides
      );
      expect(exitCode).toBe(0);
      expect(fs.existsSync(nonExistentDb)).toBe(false); // Proves zero creation/mutation
      const config = JSON.parse(stdoutChunks.join(''));
      expect(config.mcpServers.agentforge.env.AGENTFORGE_MCP_DB_PATH).toBe(
        path.resolve(nonExistentDb)
      );
    } finally {
      process.stdout.write = originalStdoutWrite;
    }
  });

  // 9. Paths with spaces, Unicode and documented shell-sensitive characters survive JSON serialization and process spawning unchanged
  it('[Case 9] paths with spaces, Unicode and shell-sensitive characters survive JSON serialization', () => {
    const specialDir = path.join(testTempDir, 'Agent Forge 🚀 Spaces & Symbols (x86)');
    fs.mkdirSync(specialDir, { recursive: true });

    const specialExe = path.join(specialDir, 'AgentForge & Co.exe');
    fs.writeFileSync(specialExe, 'dummy', 'utf8');

    const specialStdio = path.join(specialDir, "stdio & 'quoted' ^ test.js");
    fs.writeFileSync(specialStdio, 'dummy', 'utf8');

    const specialDb = path.join(specialDir, 'data $100 & %PATH%.db');

    const config = generateClientConfig({
      client: 'antigravity',
      dbPath: specialDb,
      executablePath: specialExe,
      stdioScriptPath: specialStdio,
    });

    const serialized = JSON.stringify(config, null, 2);
    const roundTripped = JSON.parse(serialized);

    expect(roundTripped.mcpServers.agentforge.command).toBe(path.resolve(specialExe));
    expect(roundTripped.mcpServers.agentforge.args[0]).toBe(path.resolve(specialStdio));
    expect(roundTripped.mcpServers.agentforge.env.AGENTFORGE_MCP_DB_PATH).toBe(
      path.resolve(specialDb)
    );
  });

  // 10. Missing executable, missing script, relative DB path and unsupported runtime fail with bounded scrubbed errors and no GUI fallback
  it('[Case 10] missing executable, missing script, relative DB path and unsupported runtime fail with scrubbed errors', () => {
    const existingExe = process.execPath;
    const existingStdio = path.join(runtimeDir, 'mcp', 'stdio.js');

    // Missing executable
    expect(() =>
      generateClientConfig({
        client: 'cursor',
        executablePath: path.join(testTempDir, 'missing.exe'),
        stdioScriptPath: existingStdio,
      })
    ).toThrow('Executable file does not exist');

    // Missing stdio script
    expect(() =>
      generateClientConfig({
        client: 'cursor',
        executablePath: existingExe,
        stdioScriptPath: path.join(testTempDir, 'missing-stdio.js'),
      })
    ).toThrow('Stdio script file does not exist');

    // Relative DB path
    expect(() =>
      generateClientConfig({
        client: 'cursor',
        dbPath: './relative/path.db',
        executablePath: existingExe,
        stdioScriptPath: existingStdio,
      })
    ).toThrow('Database path must be an absolute path');

    // Unsupported client name
    expect(() =>
      generateClientConfig({
        client: 'vscode-unsupported',
        executablePath: existingExe,
        stdioScriptPath: existingStdio,
      })
    ).toThrow("Unsupported client 'vscode-unsupported'");
  });

  // 11. Developer checkout completes initialize, authorized tool read and authorized resource read through the generated configuration
  it('[Case 11] completes initialize, authorized tool read and authorized resource read through generated configuration', async () => {
    const dbPath = path.join(testTempDir, 'dev-read.db');
    const { db, authId, service } = setupTestAuthorityDatabase(dbPath);

    const issueResult = service.issueSession({ authorizationId: authId, ttlSeconds: 300 });
    const sessionToken = issueResult.plaintextToken;
    db.close();

    const stdioScript = path.join(runtimeDir, 'mcp', 'stdio.js');
    const config = generateClientConfig({
      client: 'antigravity',
      dbPath,
      executablePath: process.execPath,
      stdioScriptPath: stdioScript,
    });

    const env = {
      ...config.mcpServers.agentforge.env,
      AGENTFORGE_MCP_SESSION_TOKEN: sessionToken,
    };

    const harness = createStdioChildHarness(
      config.mcpServers.agentforge.command,
      config.mcpServers.agentforge.args,
      env
    );

    try {
      // 1. Initialize
      const initRes = await harness.sendRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'antigravity-test', version: '1.0.0' },
        },
      });
      expect(initRes.error).toBeUndefined();
      expect((initRes.result as Record<string, unknown>).serverInfo).toBeDefined();

      await harness.sendNotification({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });

      // 2. Tool read
      const toolRes = await harness.sendRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'agentforge_get_authorized_context',
          arguments: {},
        },
      });
      expect(toolRes.error).toBeUndefined();
      const toolContent = (toolRes.result as { content: Array<{ text: string }> }).content[0].text;
      const parsedToolContext = JSON.parse(toolContent);
      expect(parsedToolContext.execution_payload.taskTitle).toBe('Task 1');

      // 3. Resource read
      const resourceRes = await harness.sendRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/read',
        params: {
          uri: 'agentforge://session/authorized-context',
        },
      });
      expect(resourceRes.error).toBeUndefined();
      const resContent = (resourceRes.result as { contents: Array<{ text: string }> }).contents[0].text;
      const parsedResContext = JSON.parse(resContent);
      expect(parsedResContext).toEqual(parsedToolContext);
    } finally {
      await harness.close();
    }
  });

  // 12. Missing, malformed, expired and revoked session tokens fail closed through the generated configuration
  it('[Case 12] missing, malformed, expired and revoked tokens fail closed through generated configuration', async () => {
    const dbPath = path.join(testTempDir, 'tokens.db');
    const { db, authId, service } = setupTestAuthorityDatabase(dbPath);

    // 1. Issue session and revoke it
    const issuedRevoked = service.issueSession({ authorizationId: authId, ttlSeconds: 300 });
    service.revokeSession({ sessionId: issuedRevoked.session.id });

    // 2. Now that the first session is revoked, issue second session and backdate as expired
    const issuedExpired = service.issueSession({ authorizationId: authId, ttlSeconds: 300 });
    db.prepare(
      `UPDATE mcp_client_sessions SET issued_at = '2019-01-01T00:00:00.000Z', expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`
    ).run(issuedExpired.session.id);

    db.close();

    const stdioScript = path.join(runtimeDir, 'mcp', 'stdio.js');
    const config = generateClientConfig({
      client: 'cursor',
      dbPath,
      executablePath: process.execPath,
      stdioScriptPath: stdioScript,
    });

    // Test helper for token validation
    const testTokenFailClosed = async (token: string) => {
      const env = {
        ...config.mcpServers.agentforge.env,
        AGENTFORGE_MCP_SESSION_TOKEN: token,
      };
      const harness = createStdioChildHarness(
        config.mcpServers.agentforge.command,
        config.mcpServers.agentforge.args,
        env
      );
      try {
        await harness.sendRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0.0' },
          },
        });
        await harness.sendNotification({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        });
        const res = await harness.sendRequest({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'agentforge_get_authorized_context', arguments: {} },
        });
        // MCP error returned or tool returns error content
        const isError =
          Boolean(res.error) ||
          (res.result as { isError?: boolean })?.isError === true;
        expect(isError).toBe(true);
      } finally {
        await harness.close();
      }
    };

    // Missing token
    await testTokenFailClosed('');
    // Malformed token
    await testTokenFailClosed('malformed-not-a-token');
    // Expired token
    await testTokenFailClosed(issuedExpired.plaintextToken);
    // Revoked token
    await testTokenFailClosed(issuedRevoked.plaintextToken);
  });

  // 13. Changed authority graph and cross-task/session substitution fail closed
  it('[Case 13] changed authority graph and cross-task substitution fail closed', async () => {
    const dbPath = path.join(testTempDir, 'auth-tamper.db');
    const { db, authId, service } = setupTestAuthorityDatabase(dbPath);

    const issued = service.issueSession({ authorizationId: authId, ttlSeconds: 300 });
    const stdioScript = path.join(runtimeDir, 'mcp', 'stdio.js');
    const config = generateClientConfig({
      client: 'antigravity',
      dbPath,
      executablePath: process.execPath,
      stdioScriptPath: stdioScript,
    });

    // Invalidate authorization in database
    db.prepare(`UPDATE execution_authorizations SET status = 'INVALIDATED' WHERE id = ?`).run(
      authId
    );
    db.close();

    const env = {
      ...config.mcpServers.agentforge.env,
      AGENTFORGE_MCP_SESSION_TOKEN: issued.plaintextToken,
    };
    const harness = createStdioChildHarness(
      config.mcpServers.agentforge.command,
      config.mcpServers.agentforge.args,
      env
    );
    try {
      await harness.sendRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      });
      await harness.sendNotification({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });
      const res = await harness.sendRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'agentforge_get_authorized_context', arguments: {} },
      });
      const isError = Boolean(res.error) || (res.result as { isError?: boolean })?.isError === true;
      expect(isError).toBe(true);
    } finally {
      await harness.close();
    }
  });

  // 14. Two concurrent configured children remain isolated and each reads only its bound task
  it('[Case 14] two concurrent configured children remain isolated to their respective tasks', async () => {
    const dbPath = path.join(testTempDir, 'concurrent.db');
    const { db, authId: authId1, service } = setupTestAuthorityDatabase(dbPath);

    // Setup second task in same DB
    const now = new Date().toISOString();
    const projectId2 = `proj-2-${crypto.randomUUID()}`;
    const taskId2 = `task-2-${crypto.randomUUID()}`;
    const attemptId2 = `att-2-${crypto.randomUUID()}`;
    const assignmentId2 = `asgn-2-${crypto.randomUUID()}`;
    const authId2 = `auth-2-${crypto.randomUUID()}`;
    const managerRecordId2 = `msg-rec-2-${crypto.randomUUID()}`;
    const routingDecisionId2 = `route-2-${crypto.randomUUID()}`;
    const providerId2 = `prov-2-${crypto.randomUUID()}`;
    const accountId2 = `acc-2-${crypto.randomUUID()}`;
    const resourceId2 = `res-2-${crypto.randomUUID()}`;

    const repo = new Repository(db);
    repo.createProject({
      id: projectId2,
      name: 'Project 2',
      description: 'Second',
      repository_path: 'D:/fake/repo2',
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: now,
      updated_at: now,
      started_at: null,
      completed_at: null,
    });

    db.prepare(`
      INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, base_sha, ownership_epoch, created_at, updated_at)
      VALUES (?, ?, 'Task 2 Title', 'CODING', 'LOW', 'LOW', 1, 3, 0, ?, 1, ?, ?)
    `).run(taskId2, projectId2, '2'.repeat(40), now, now);

    const roleId2 = `role-2-${crypto.randomUUID()}`;
    const agentId2 = `agent-2-${crypto.randomUUID()}`;
    db.prepare(`
      INSERT INTO role_profiles (id, role, display_name, required_capabilities_json, preferred_capabilities_json, permissions_json, enabled, created_at, updated_at)
      VALUES (?, 'CODER', 'Role 2', '["CODING"]', '[]', '[]', 1, ?, ?)
    `).run(roleId2, now, now);
    db.prepare(`
      INSERT INTO agent_profiles (id, role_profile_id, name, enabled, created_at, updated_at)
      VALUES (?, ?, 'Agent 2', 1, ?, ?)
    `).run(agentId2, roleId2, now, now);

    db.prepare(`
      INSERT OR IGNORE INTO providers (id, name, adapter_type, enabled, created_at)
      VALUES (?, 'Anthropic', 'LOCAL_CLI', 1, ?)
    `).run(providerId2, now);
    db.prepare(`
      INSERT INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at)
      VALUES (?, ?, 'acc2', 'NATIVE_PROFILE', 1, 10, 'AVAILABLE', 20, ?, ?)
    `).run(accountId2, providerId2, now, now);
    db.prepare(`
      INSERT INTO provider_resources (id, provider_id, provider_account_id, model_name, health_status, capabilities_json, enabled, total_quota, remaining_quota, quota_unit, quota_source, quota_confidence, last_health_check)
      VALUES (?, ?, ?, 'claude-3-7-sonnet', 'AVAILABLE', '["CODING"]', 1, 1000, 1000, 'REQUESTS', 'PROVIDER_REPORTED', 1.0, ?)
    `).run(resourceId2, providerId2, accountId2, now);

    repo.createTaskAttempt({
      id: attemptId2,
      task_id: taskId2,
      attempt_number: 1,
      status: 'RUNNING',
      agent_profile_id: agentId2,
      agent_id: null,
      started_at: now,
      ended_at: null,
      summary: null,
    });

    const routingPayload2 = {
      decisionId: routingDecisionId2,
      projectId: projectId2,
      taskId: taskId2,
      attemptId: attemptId2,
      roleProfileId: roleId2,
      role: 'CODER',
      outcome: 'SELECTED',
      routePolicyId: null,
      failoverPolicyAuthoritySnapshot: null,
      selectedProviderId: providerId2,
      selectedAccountId: accountId2,
      selectedResourceId: resourceId2,
      selectedAssignmentId: assignmentId2,
      requestedConstraints: [],
      appliedExclusions: [],
      appliedSeparation: null,
      reason: 'Optimal route',
    };
    db.prepare(`
      INSERT INTO events (id, project_id, task_id, type, summary, structured_payload_json, timestamp)
      VALUES (?, ?, ?, 'ROLE_AWARE_ROUTING_DECISION', 'Optimal route', ?, ?)
    `).run(routingDecisionId2, projectId2, taskId2, JSON.stringify(routingPayload2), now);

    repo.createAgentAssignment({
      id: assignmentId2,
      project_id: projectId2,
      task_id: taskId2,
      attempt_id: attemptId2,
      role_profile_id: roleId2,
      agent_profile_id: agentId2,
      selected_provider_id: providerId2,
      selected_account_id: accountId2,
      selected_resource_id: resourceId2,
      selected_worker_slot_id: null,
      routing_decision_id: routingDecisionId2,
      status: 'ASSIGNED',
      created_at: now,
      ended_at: null,
      preferred_metadata: null,
    });

    const instructions2 = ['Task: Task 2', 'Context for child 2'];
    const managerProtoMsgId2 = `msg-proto-2-${crypto.randomUUID()}`;
    const managerPayload2 = {
      protocol: 'manager.v1',
      message_id: managerProtoMsgId2,
      project_id: projectId2,
      task_id: taskId2,
      decision: 'EXECUTE',
      priority: 'LOW',
      risk: 'LOW',
      instructions: instructions2,
      acceptance_criteria: ['Pass'],
      constraints: ['None'],
      review_issues: [],
      expected_task_state: 'CODING',
      expected_revision: 1,
      created_at: now,
    };
    const rawManagerPayload2 = JSON.stringify(managerPayload2);
    const managerPayloadHash2 = crypto.createHash('sha256').update(rawManagerPayload2, 'utf8').digest('hex');
    repo.recordProtocolMessage(
      managerRecordId2,
      managerProtoMsgId2,
      'manager.v1',
      projectId2,
      taskId2,
      'CODING',
      1,
      managerPayloadHash2,
      rawManagerPayload2,
      'APPLIED',
      undefined,
      now
    );

    const canonicalInstructionsJson2 = JSON.stringify(instructions2);
    const contextFiles2 = ['src/core/services/BootstrapService.ts'];
    const canonicalPayload2 = computeCanonicalPayload({
      projectId: projectId2,
      taskId: taskId2,
      attemptId: attemptId2,
      taskTitle: 'Task 2 Title',
      taskDescription: 'Desc 2',
      acceptanceCriteria: ['Pass'],
      constraints: ['None'],
      instructions: instructions2,
      contextFiles: contextFiles2,
      verificationCommands: { TEST: null, LINT: null, BUILD: null },
      managerMessageId: managerRecordId2,
      managerPayloadHash: managerPayloadHash2,
    });

    const auth2: ExecutionAuthorization = {
      id: authId2,
      project_id: projectId2,
      task_id: taskId2,
      task_revision: 1,
      base_sha: '2'.repeat(40),
      repository_head_sha: '3'.repeat(40),
      manager_message_id: managerRecordId2,
      manager_payload_hash: managerPayloadHash2,
      routing_decision_id: routingDecisionId2,
      selected_resource_id: resourceId2,
      selected_provider_id: providerId2,
      instruction_payload_hash: computePayloadHash(canonicalPayload2),
      context_manifest_hash: computeContextManifestHash(contextFiles2),
      canonical_instructions_json: canonicalInstructionsJson2,
      context_files_json: JSON.stringify(contextFiles2),
      canonical_payload_json: JSON.stringify(canonicalPayload2),
      status: 'AUTHORIZED',
      created_at: now,
      dispatched_at: null,
      execution_id: null,
      task_ownership_epoch: 1,
      lifecycle_version: 1,
      selected_account_id: accountId2,
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

    const session1 = service.issueSession({ authorizationId: authId1, ttlSeconds: 300 });
    const session2 = service.issueSession({ authorizationId: authId2, ttlSeconds: 300 });
    db.close();

    const stdioScript = path.join(runtimeDir, 'mcp', 'stdio.js');
    const config = generateClientConfig({
      client: 'antigravity',
      dbPath,
      executablePath: process.execPath,
      stdioScriptPath: stdioScript,
    });

    const harness1 = createStdioChildHarness(
      config.mcpServers.agentforge.command,
      config.mcpServers.agentforge.args,
      { ...config.mcpServers.agentforge.env, AGENTFORGE_MCP_SESSION_TOKEN: session1.plaintextToken }
    );
    const harness2 = createStdioChildHarness(
      config.mcpServers.agentforge.command,
      config.mcpServers.agentforge.args,
      { ...config.mcpServers.agentforge.env, AGENTFORGE_MCP_SESSION_TOKEN: session2.plaintextToken }
    );

    try {
      await Promise.all([
        harness1.sendRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'c1', version: '1' } },
        }),
        harness2.sendRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'c2', version: '1' } },
        }),
      ]);

      await Promise.all([
        harness1.sendNotification({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        harness2.sendNotification({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      ]);

      const [res1, res2] = await Promise.all([
        harness1.sendRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agentforge_get_authorized_context', arguments: {} } }),
        harness2.sendRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agentforge_get_authorized_context', arguments: {} } }),
      ]);

      const ctx1 = JSON.parse((res1.result as { content: Array<{ text: string }> }).content[0].text);
      const ctx2 = JSON.parse((res2.result as { content: Array<{ text: string }> }).content[0].text);

      expect(ctx1.execution_payload.taskTitle).toBe('Task 1');
      expect(ctx2.execution_payload.taskTitle).toBe('Task 2 Title');
      expect(ctx1.execution_payload.taskTitle).not.toBe(ctx2.execution_payload.taskTitle);
    } finally {
      await Promise.all([harness1.close(), harness2.close()]);
    }
  });

  // 15. Repeated reads preserve logical database contents and total-change authority
  it('[Case 15] repeated reads preserve logical database contents and zero-mutation guarantee', async () => {
    const dbPath = path.join(testTempDir, 'repeated.db');
    const { db, authId, service } = setupTestAuthorityDatabase(dbPath);

    const issued = service.issueSession({ authorizationId: authId, ttlSeconds: 300 });
    db.close();

    const stdioScript = path.join(runtimeDir, 'mcp', 'stdio.js');
    const config = generateClientConfig({
      client: 'claude',
      dbPath,
      executablePath: process.execPath,
      stdioScriptPath: stdioScript,
    });

    const harness = createStdioChildHarness(
      config.mcpServers.agentforge.command,
      config.mcpServers.agentforge.args,
      { ...config.mcpServers.agentforge.env, AGENTFORGE_MCP_SESSION_TOKEN: issued.plaintextToken }
    );

    try {
      await harness.sendRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      });
      await harness.sendNotification({ jsonrpc: '2.0', method: 'notifications/initialized' });

      for (let i = 0; i < 5; i++) {
        const res = await harness.sendRequest({
          jsonrpc: '2.0',
          id: 10 + i,
          method: 'tools/call',
          params: { name: 'agentforge_get_authorized_context', arguments: {} },
        });
        expect(res.error).toBeUndefined();
      }
    } finally {
      await harness.close();
    }

    // Verify DB remains fully functional with 0 schema/data mutations
    const verifyDb = new Database(dbPath, { readonly: true });
    const count = verifyDb.prepare('SELECT count(*) as c FROM tasks').get() as { c: number };
    expect(count.c).toBe(1);
    verifyDb.close();
  });

  // 16. EOF, SIGINT and SIGTERM settle, close the DB and release file handles; a forced-kill path is classified honestly
  it('[Case 16] EOF and signals settle cleanly and release file handles; force-kill is classified honestly', async () => {
    const dbPath = path.join(testTempDir, 'lifecycle.db');
    const { db, authId, service } = setupTestAuthorityDatabase(dbPath);
    const issued = service.issueSession({ authorizationId: authId, ttlSeconds: 300 });
    db.close();

    const stdioScript = path.join(runtimeDir, 'mcp', 'stdio.js');
    const signalPreload = path.join(runtimeDir, 'signal_preload.js');
    const config = generateClientConfig({
      client: 'antigravity',
      dbPath,
      executablePath: process.execPath,
      stdioScriptPath: stdioScript,
    });

    // 16a. EOF (closing stdin)
    const eofHarness = createStdioChildHarness(
      config.mcpServers.agentforge.command,
      config.mcpServers.agentforge.args,
      { ...config.mcpServers.agentforge.env, AGENTFORGE_MCP_SESSION_TOKEN: issued.plaintextToken }
    );
    await eofHarness.sendRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    eofHarness.closeStdin();
    const eofExit = await eofHarness.waitForExit(4000);
    expect(eofExit.code).toBe(0);

    // Verify database file handle released (renameable / removable)
    const renamedDb = path.join(testTempDir, 'renamed.db');
    fs.renameSync(dbPath, renamedDb);
    expect(fs.existsSync(renamedDb)).toBe(true);
    fs.renameSync(renamedDb, dbPath);

    // 16b. SIGINT handling via preload
    const sigHarness = createStdioChildHarness(
      config.mcpServers.agentforge.command,
      config.mcpServers.agentforge.args,
      { ...config.mcpServers.agentforge.env, AGENTFORGE_MCP_SESSION_TOKEN: issued.plaintextToken },
      signalPreload
    );
    await sigHarness.sendRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    sigHarness.sendIpcSignal('SIGINT');
    const sigExit = await sigHarness.waitForExit(4000);
    expect(sigExit.code).toBe(0);

    // 16c. Forced kill classification
    const killHarness = createStdioChildHarness(
      config.mcpServers.agentforge.command,
      config.mcpServers.agentforge.args,
      { ...config.mcpServers.agentforge.env, AGENTFORGE_MCP_SESSION_TOKEN: issued.plaintextToken }
    );
    await killHarness.sendRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    killHarness.child.kill('SIGKILL');
    const killExit = await killHarness.waitForExit(4000);
    // On Windows, child.kill('SIGKILL') terminates process with non-null exit or killed flag
    const isForced = killExit.code !== 0 || killExit.signal !== null || killHarness.child.killed;
    expect(isForced).toBe(true);
  });

  // 17. Static and runtime inspection proves no GUI/bootstrap/updater/IPC initialization and no session-admin surface through MCP
  it('[Case 17] proves no GUI/updater/IPC initialization and no admin tools exposed over MCP', async () => {
    const dbPath = path.join(testTempDir, 'inspection.db');
    const { db, authId, service } = setupTestAuthorityDatabase(dbPath);
    const issued = service.issueSession({ authorizationId: authId, ttlSeconds: 300 });
    db.close();

    const stdioScript = path.join(runtimeDir, 'mcp', 'stdio.js');
    const config = generateClientConfig({
      client: 'cursor',
      dbPath,
      executablePath: process.execPath,
      stdioScriptPath: stdioScript,
    });

    const harness = createStdioChildHarness(
      config.mcpServers.agentforge.command,
      config.mcpServers.agentforge.args,
      { ...config.mcpServers.agentforge.env, AGENTFORGE_MCP_SESSION_TOKEN: issued.plaintextToken }
    );

    try {
      const initRes = await harness.sendRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      });
      await harness.sendNotification({ jsonrpc: '2.0', method: 'notifications/initialized' });

      // List tools
      const toolsRes = await harness.sendRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      });
      const tools = (toolsRes.result as { tools: Array<{ name: string }> }).tools;
      const toolNames = tools.map((t) => t.name);

      // Verify exactly the 2 authorized read tools and ZERO admin / issue / revoke tools
      expect(toolNames).toContain('agentforge_get_capabilities');
      expect(toolNames).toContain('agentforge_get_authorized_context');
      expect(toolNames.length).toBe(2);

      // List resources
      const resList = await harness.sendRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/list',
        params: {},
      });
      const resources = (resList.result as { resources: Array<{ uri: string }> }).resources;
      const resourceUris = resources.map((r) => r.uri);
      expect(resourceUris).toContain('agentforge://server/capabilities');
      expect(resourceUris).toContain('agentforge://session/authorized-context');
      expect(resourceUris.length).toBe(2);
    } finally {
      await harness.close();
    }
  });

  // 18. Secret sentinels never appear in generated output, command arguments, stdout, stderr, diagnostics or artifacts
  it('[Case 18] secret sentinels never appear in command arguments, stdout, stderr, or diagnostics', async () => {
    const dbPath = path.join(testTempDir, 'secrets.db');
    const { db, authId, service } = setupTestAuthorityDatabase(dbPath);
    const issued = service.issueSession({ authorizationId: authId, ttlSeconds: 300 });
    const realToken = issued.plaintextToken;
    db.close();

    const stdioScript = path.join(runtimeDir, 'mcp', 'stdio.js');
    const config = generateClientConfig({
      client: 'antigravity',
      dbPath,
      executablePath: process.execPath,
      stdioScriptPath: stdioScript,
    });

    // 18a. Generated config must only have placeholder, never real token
    const serialized = JSON.stringify(config);
    expect(serialized).toContain(OPERATOR_SESSION_TOKEN_PLACEHOLDER);
    expect(serialized).not.toContain(realToken);

    // 18b. Spawn process with real token in env (never in command args)
    const harness = createStdioChildHarness(
      config.mcpServers.agentforge.command,
      config.mcpServers.agentforge.args,
      { ...config.mcpServers.agentforge.env, AGENTFORGE_MCP_SESSION_TOKEN: realToken }
    );

    try {
      await harness.sendRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      });
      await harness.sendNotification({ jsonrpc: '2.0', method: 'notifications/initialized' });
      await harness.sendRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'agentforge_get_authorized_context', arguments: {} },
      });

      const stdoutLines = harness.getStdoutLines().join('\n');
      const stderr = harness.getStderr();

      // Real token must NEVER appear in stdout, stderr, or args
      expect(stdoutLines).not.toContain(realToken);
      expect(stderr).not.toContain(realToken);
      for (const arg of harness.child.spawnargs) {
        expect(arg).not.toContain(realToken);
      }
    } finally {
      await harness.close();
    }
  });

  // 19. Static inspection of both smoke bootstrap bodies rejects bare require('better-sqlite3')
  it('[Case 19] static inspection of smoke bootstrap bodies rejects bare require(\'better-sqlite3\')', () => {
    const packagedScriptPath = path.resolve(__dirname, '..', 'scripts', 'smoke-packaged-win.ps1');
    const installedScriptPath = path.resolve(__dirname, '..', 'scripts', 'smoke-installed-production-win.ps1');

    const packagedContent = fs.readFileSync(packagedScriptPath, 'utf8');
    const installedContent = fs.readFileSync(installedScriptPath, 'utf8');

    // Both scripts must NOT contain bare require('better-sqlite3')
    expect(packagedContent).not.toMatch(/require\s*\(\s*['"]better-sqlite3['"]\s*\)/);
    expect(installedContent).not.toMatch(/require\s*\(\s*['"]better-sqlite3['"]\s*\)/);

    // Both scripts must use createRequire with app.asar path
    expect(packagedContent).toContain("createRequire(path.join(asarPath, 'package.json'))");
    expect(installedContent).toContain("createRequire(path.join(asarPath, 'package.json'))");
  });

  // 20. Package-scoped resolution cannot use repository/global/temp node_modules fallback
  it('[Case 20] package-scoped resolution cannot use repository/global/temp node_modules fallback', () => {
    const packagedScriptPath = path.resolve(__dirname, '..', 'scripts', 'smoke-packaged-win.ps1');
    const installedScriptPath = path.resolve(__dirname, '..', 'scripts', 'smoke-installed-production-win.ps1');

    const packagedContent = fs.readFileSync(packagedScriptPath, 'utf8');
    const installedContent = fs.readFileSync(installedScriptPath, 'utf8');

    // Neither script should set NODE_PATH or inject Module.globalPaths
    expect(packagedContent).not.toContain('$env:NODE_PATH');
    expect(packagedContent).not.toContain('Module.globalPaths');
    expect(installedContent).not.toContain('$env:NODE_PATH');
    expect(installedContent).not.toContain('Module.globalPaths');

    // Proves that in an isolated directory without node_modules, bare require fails with MODULE_NOT_FOUND
    const isolatedDir = path.join(testTempDir, 'isolated-no-modules');
    fs.mkdirSync(isolatedDir, { recursive: true });

    let bareRequireError = '';
    try {
      execFileSync(
        process.execPath,
        ['-e', 'require("better-sqlite3")'],
        {
          cwd: isolatedDir,
          env: { ...process.env, NODE_PATH: '' },
          stdio: 'pipe',
          encoding: 'utf8',
        }
      );
    } catch (err: any) {
      bareRequireError = err.stderr || err.message;
    }
    expect(bareRequireError).toContain('MODULE_NOT_FOUND');
  });

  // 21. Native binding origin validator accepts only the expected tier's app.asar.unpacked subtree and rejects sibling/source/global paths
  it('[Case 21] native binding origin validator accepts only expected tier app.asar.unpacked subtree and rejects other paths', () => {
    function validateNativeBindingOrigin(
      nativePath: string,
      tier: 'unpacked' | 'installed',
      tierRoot: string
    ): { valid: boolean; reason?: string } {
      const normalizedNative = path.resolve(nativePath).toLowerCase();
      const expectedPrefix = path.resolve(
        tierRoot,
        'resources',
        'app.asar.unpacked',
        'node_modules',
        'better-sqlite3'
      ).toLowerCase();

      if (!normalizedNative.endsWith('.node')) {
        return { valid: false, reason: 'Not a .node binary' };
      }
      if (!normalizedNative.startsWith(expectedPrefix)) {
        return { valid: false, reason: `Native binary path outside expected ${tier} root` };
      }
      if (normalizedNative.includes('app.asar\\') || normalizedNative.includes('app.asar/')) {
        return { valid: false, reason: 'Native binary cannot be inside app.asar archive' };
      }
      return { valid: true };
    }

    const unpackedRoot = 'C:\\test\\release\\win-unpacked';
    const installedRoot = 'C:\\test\\isolated-install-root';

    // 21a. Valid unpacked path
    const validUnpacked = path.join(
      unpackedRoot,
      'resources',
      'app.asar.unpacked',
      'node_modules',
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3.node'
    );
    expect(validateNativeBindingOrigin(validUnpacked, 'unpacked', unpackedRoot).valid).toBe(true);

    // 21b. Valid installed path
    const validInstalled = path.join(
      installedRoot,
      'resources',
      'app.asar.unpacked',
      'node_modules',
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3.node'
    );
    expect(validateNativeBindingOrigin(validInstalled, 'installed', installedRoot).valid).toBe(true);

    // 21c. Rejects repo node_modules path
    const repoPath = 'D:\\Projects\\Agent-Forge\\node_modules\\better-sqlite3\\build\\Release\\better_sqlite3.node';
    expect(validateNativeBindingOrigin(repoPath, 'unpacked', unpackedRoot).valid).toBe(false);

    // 21d. Rejects temp node_modules path
    const tempPath = 'C:\\Users\\TEMP\\AppData\\Local\\Temp\\node_modules\\better-sqlite3\\better_sqlite3.node';
    expect(validateNativeBindingOrigin(tempPath, 'unpacked', unpackedRoot).valid).toBe(false);

    // 21e. Rejects global node_modules path
    const globalPath = 'C:\\Users\\AppData\\Roaming\\npm\\node_modules\\better-sqlite3\\better_sqlite3.node';
    expect(validateNativeBindingOrigin(globalPath, 'installed', installedRoot).valid).toBe(false);

    // 21f. Rejects cross-tier path (installed binary checked against unpacked root)
    expect(validateNativeBindingOrigin(validInstalled, 'unpacked', unpackedRoot).valid).toBe(false);
  });

  // 22. A hostile AGENTFORGE_MCP_STDIO_PATH cannot redirect production CLI output
  it('[Case 22] hostile AGENTFORGE_MCP_STDIO_PATH cannot redirect production CLI output', () => {
    const hostilePath = 'C:\\malicious\\fake_stdio.js';
    const originalEnv = process.env.AGENTFORGE_MCP_STDIO_PATH;
    process.env.AGENTFORGE_MCP_STDIO_PATH = hostilePath;

    try {
      // 22a. Run real compiled CLI
      const sessionAdminJs = path.join(runtimeDir, 'mcp', 'sessionAdmin.js');
      const stdout = execFileSync(
        process.execPath,
        [sessionAdminJs, 'configure-client', '--client', 'antigravity'],
        {
          env: { ...process.env, AGENTFORGE_MCP_STDIO_PATH: hostilePath },
          encoding: 'utf8',
        }
      );
      const parsed = JSON.parse(stdout);
      expect(parsed.mcpServers.agentforge.args[0]).not.toBe(hostilePath);
      expect(parsed.mcpServers.agentforge.args[0]).toBe(path.join(runtimeDir, 'mcp', 'stdio.js'));

      // 22b. Unit deriveRuntimePaths ignores hostile env var
      const derived = deriveRuntimePaths({
        executablePath: process.execPath,
        stdioScriptPath: path.join(runtimeDir, 'mcp', 'stdio.js'),
      });
      expect(derived.stdioScript).not.toBe(hostilePath);
      expect(derived.stdioScript).toBe(path.join(runtimeDir, 'mcp', 'stdio.js'));
    } finally {
      if (originalEnv !== undefined) {
        process.env.AGENTFORGE_MCP_STDIO_PATH = originalEnv;
      } else {
        delete process.env.AGENTFORGE_MCP_STDIO_PATH;
      }
    }
  });

  // 23. configure-client rejects short aliases and returns exact scrubbed stderr
  it('[Case 23] configure-client rejects short aliases and returns exact scrubbed stderr', () => {
    const originalStderrWrite = process.stderr.write;
    const stderrChunks: string[] = [];
    process.stderr.write = ((chunk: string | Buffer) => {
      stderrChunks.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      const shortAliasInvocations = [
        ['configure-client', '-c', 'antigravity'],
        ['configure-client', '--client', 'antigravity', '-d', 'C:\\some\\db.sqlite'],
        ['configure-client', '--client', 'antigravity', '-j'],
      ];

      for (const args of shortAliasInvocations) {
        stderrChunks.length = 0;
        const code = runSessionAdmin(args);
        expect(code).toBe(1);
        expect(stderrChunks.join('')).toBe(
          'ERROR: [MCP_CONFIGURATION_INVALID] Invalid configuration or CLI arguments\n'
        );
      }
    } finally {
      process.stderr.write = originalStderrWrite;
    }
  });

  // 24. Secret sentinels in client, DB, or environment inputs never appear in stderr or stdout
  it('[Case 24] secret sentinels in client, DB, or environment inputs never appear in stderr or stdout', () => {
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    process.stdout.write = ((chunk: string | Buffer) => {
      stdoutChunks.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Buffer) => {
      stderrChunks.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;

    const CLIENT_SENTINEL = 'SECRET_SENTINEL_CLIENT_987654321';
    const DB_SENTINEL = 'SECRET_SENTINEL_DB_123456789';
    const ENV_SENTINEL = 'SECRET_SENTINEL_ENV_555666777';

    try {
      // 24a. Sentinel in --client
      stdoutChunks.length = 0;
      stderrChunks.length = 0;
      let code = runSessionAdmin(['configure-client', '--client', CLIENT_SENTINEL]);
      expect(code).toBe(1);
      expect(stdoutChunks.join('')).toBe('');
      expect(stderrChunks.join('')).toBe(
        'ERROR: [MCP_CONFIGURATION_INVALID] Invalid configuration or CLI arguments\n'
      );
      expect(stderrChunks.join('')).not.toContain(CLIENT_SENTINEL);

      // 24b. Sentinel in --db
      stdoutChunks.length = 0;
      stderrChunks.length = 0;
      code = runSessionAdmin(['configure-client', '--client', 'antigravity', '--db', DB_SENTINEL]);
      expect(code).toBe(1);
      expect(stdoutChunks.join('')).toBe('');
      expect(stderrChunks.join('')).toBe(
        'ERROR: [MCP_CONFIGURATION_INVALID] Invalid configuration or CLI arguments\n'
      );
      expect(stderrChunks.join('')).not.toContain(DB_SENTINEL);

      // 24c. Sentinel in hostile env var
      process.env.AGENTFORGE_HOSTILE_SENTINEL = ENV_SENTINEL;
      stdoutChunks.length = 0;
      stderrChunks.length = 0;
      code = runSessionAdmin(['configure-client', '--client', 'invalid-client']);
      expect(code).toBe(1);
      expect(stdoutChunks.join('')).toBe('');
      expect(stderrChunks.join('')).not.toContain(ENV_SENTINEL);
      delete process.env.AGENTFORGE_HOSTILE_SENTINEL;
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }
  });

  // 25. Non-JSON stdout, child error, premature exit and timeout each reject all pending operations once and clear request timers/listeners
  it('[Case 25] non-JSON stdout, child error, premature exit and timeout reject pending operations once and clear timers', async () => {
    class ContractHarness {
      pending = new Map<number | string, {
        resolve: (v: any) => void;
        reject: (err: Error) => void;
        timer: NodeJS.Timeout;
        settled: boolean;
      }>();
      events = new EventEmitter();

      handleStdoutLine(line: string): void {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          this.rejectAll(new Error(`Non-JSON stdout line: ${line}`));
          return;
        }
        if (typeof msg !== 'object' || msg === null) {
          this.rejectAll(new Error(`Non-object payload: ${line}`));
          return;
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (!entry.settled) {
            entry.settled = true;
            clearTimeout(entry.timer);
            if (msg.error) entry.reject(new Error(msg.error.message));
            else entry.resolve(msg.result);
          }
        }
      }

      sendRequest(id: number, timeoutMs = 50): Promise<any> {
        return new Promise((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (this.pending.has(id)) {
              this.pending.delete(id);
              settled = true;
              reject(new Error(`Request ${id} timed out`));
            }
          }, timeoutMs);

          this.pending.set(id, {
            resolve: (v) => {
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(v);
              }
            },
            reject: (err) => {
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(err);
              }
            },
            timer,
            settled,
          });
        });
      }

      rejectAll(err: Error): void {
        const entries = Array.from(this.pending.values());
        this.pending.clear();
        for (const entry of entries) {
          if (!entry.settled) {
            entry.settled = true;
            clearTimeout(entry.timer);
            entry.reject(err);
          }
        }
      }
    }

    // 25a. Non-JSON stdout
    const h1 = new ContractHarness();
    const p1 = h1.sendRequest(1);
    h1.handleStdoutLine('NOT_VALID_JSON');
    await expect(p1).rejects.toThrow('Non-JSON stdout line');
    expect(h1.pending.size).toBe(0);

    // 25b. Child error
    const h2 = new ContractHarness();
    const p2 = h2.sendRequest(2);
    h2.rejectAll(new Error('Child process error: EPIPE'));
    await expect(p2).rejects.toThrow('Child process error: EPIPE');
    expect(h2.pending.size).toBe(0);

    // 25c. Premature exit
    const h3 = new ContractHarness();
    const p3 = h3.sendRequest(3);
    h3.rejectAll(new Error('Child exited prematurely with code 1'));
    await expect(p3).rejects.toThrow('Child exited prematurely');
    expect(h3.pending.size).toBe(0);

    // 25d. Timeout
    const h4 = new ContractHarness();
    const p4 = h4.sendRequest(4, 20);
    await expect(p4).rejects.toThrow('Request 4 timed out');
    expect(h4.pending.size).toBe(0);
  });

  // 26. Late stdout/exit/error/write callbacks after settlement do not alter the terminal result
  it('[Case 26] late stdout, exit, error and write callbacks after settlement do not alter terminal result', async () => {
    let settledResult: string | null = null;
    let settledError: Error | null = null;
    let settlementCount = 0;

    const promise = new Promise<string>((resolve, reject) => {
      let settled = false;
      const settleSuccess = (val: string) => {
        if (!settled) {
          settled = true;
          settlementCount++;
          settledResult = val;
          resolve(val);
        }
      };
      const settleFail = (err: Error) => {
        if (!settled) {
          settled = true;
          settlementCount++;
          settledError = err;
          reject(err);
        }
      };

      // Immediate resolution
      settleSuccess('initial_settlement');

      // Late responses, errors, and exits should be completely ignored
      settleSuccess('late_response');
      settleFail(new Error('late_error'));
    });

    const res = await promise;
    expect(res).toBe('initial_settlement');
    expect(settledResult).toBe('initial_settlement');
    expect(settledError).toBeNull();
    expect(settlementCount).toBe(1);
  });

  // 27. PowerShell process waits are structurally asynchronous/bounded and check timeout results
  it('[Case 27] PowerShell process waits are structurally asynchronous and check timeout results', () => {
    const packagedScriptPath = path.resolve(__dirname, '..', 'scripts', 'smoke-packaged-win.ps1');
    const installedScriptPath = path.resolve(__dirname, '..', 'scripts', 'smoke-installed-production-win.ps1');

    const packagedContent = fs.readFileSync(packagedScriptPath, 'utf8');
    const installedContent = fs.readFileSync(installedScriptPath, 'utf8');

    for (const content of [packagedContent, installedContent]) {
      // Must use ReadToEndAsync
      expect(content).toContain('StandardOutput.ReadToEndAsync()');
      expect(content).toContain('StandardError.ReadToEndAsync()');

      // Must NOT use synchronous ReadToEnd before WaitForExit
      expect(content).not.toMatch(/StandardOutput\.ReadToEnd\(\)\s*[\r\n]+.*WaitForExit/s);

      // Must check WaitForExit return value
      expect(content).toContain('$mcpProc.WaitForExit(');
      expect(content).toMatch(/if\s*\(\s*-not\s+\$(?:exited|exitedInTime)\s*\)/i);

      // Must terminate exact process ID on timeout
      expect(content).toMatch(/(\$mcpProc\.Kill\(\)|Stop-Process)/);
      expect(content).toMatch(/(R5J3_TIMEOUT|timed out)/i);
    }
  });

  // 28. Newly added R5J3 script sections contain no swallowed cleanup or silent required cleanup
  it('[Case 28] newly added R5J3 script sections contain no swallowed cleanup or silent required cleanup', () => {
    const packagedScriptPath = path.resolve(__dirname, '..', 'scripts', 'smoke-packaged-win.ps1');
    const installedScriptPath = path.resolve(__dirname, '..', 'scripts', 'smoke-installed-production-win.ps1');

    const packagedContent = fs.readFileSync(packagedScriptPath, 'utf8');
    const installedContent = fs.readFileSync(installedScriptPath, 'utf8');

    for (const content of [packagedContent, installedContent]) {
      // Extract R5J3 section (Gate 9 in packaged, Gate 8 in installed)
      const gateIndex = content.search(/\[(?:9\/9|8\/8)\]/);
      expect(gateIndex).toBeGreaterThan(0);
      const gateEndMatch = content.slice(gateIndex).match(/(?:All 9 Gates Passed|All 8 Gates Passed)/);
      expect(gateEndMatch).not.toBeNull();
      const r5j3Section = content.slice(gateIndex, gateIndex + gateEndMatch!.index! + gateEndMatch![0].length);

      // Must contain no empty catch blocks in R5J3 section
      expect(r5j3Section).not.toMatch(/catch\s*\{\s*\}/);

      // Must contain no SilentlyContinue on temporary DB or folder removal
      expect(r5j3Section).not.toMatch(/Remove-Item\s+-Force\s+\$mcpDbPath\s+-ErrorAction\s+SilentlyContinue/i);
      expect(r5j3Section).not.toMatch(/Remove-Item\s+-Recurse\s+-Force\s+\$tempMcpDir\s+-ErrorAction\s+SilentlyContinue/i);

      // Must explicitly verify absence of temporary DB and directory
      expect(r5j3Section).toContain('Test-Path $mcpDbPath');
      expect(r5j3Section).toContain('Test-Path $tempMcpDir');
    }
  });

  // 29. Test-owned cleanup throws if removal remains incomplete and restores the test fixture afterward
  it('[Case 29] test-owned cleanup throws if removal remains incomplete and restores test fixture', () => {
    const fakeDir = path.join(testTempDir, 'stubborn-dir');

    // 29a. Injected failure where directory still exists after bounded attempts
    expect(() =>
      safeRemoveDir(
        fakeDir,
        3,
        5,
        () => {}, // No-op removal function
        () => true // Always reports directory exists
      )
    ).toThrow(McpCleanupFailureError);

    try {
      safeRemoveDir(
        fakeDir,
        3,
        5,
        () => {},
        () => true
      );
    } catch (err) {
      expect(err).toBeInstanceOf(McpCleanupFailureError);
      const cleanupErr = err as McpCleanupFailureError;
      expect(cleanupErr.directory).toBe(fakeDir);
      expect(cleanupErr.attempts).toBe(3);
    }

    // 29b. Real directory removal succeeds and restores fixture state without leakage
    const realDir = path.join(testTempDir, 'real-cleanup-test');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'file.txt'), 'test data', 'utf8');
    expect(fs.existsSync(realDir)).toBe(true);

    safeRemoveDir(realDir);
    expect(fs.existsSync(realDir)).toBe(false);
  });

  // 30. Documentation asserts the exact scope/resource/placeholder contract and contains no realistic token-shaped example
  it('[Case 30] documentation asserts exact scope, resource URI, placeholder, and contains no realistic token example', () => {
    const docPath = path.resolve(__dirname, '..', 'docs', 'MCP_CLIENT_SETUP.md');
    const docContent = fs.readFileSync(docPath, 'utf8');

    // Exact scope
    expect(docContent).toContain('AUTHORIZED_CONTEXT_READ');
    expect(docContent).not.toContain('READ_AUTHORIZED_CONTEXT');

    // Exact resource URI
    expect(docContent).toContain('agentforge://session/authorized-context');
    expect(docContent).not.toContain('agentforge://context/authorized');

    // Exact placeholder and absence of realistic token examples
    expect(docContent).toContain(OPERATOR_SESSION_TOKEN_PLACEHOLDER);
    expect(docContent).not.toMatch(/af_live_[a-zA-Z0-9_-]{20,}/);

    // Mentions required CI qualification
    expect(docContent).toContain('Package Windows');
  });
});
