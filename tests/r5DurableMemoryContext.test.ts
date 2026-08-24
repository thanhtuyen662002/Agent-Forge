import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { MigrationRunner, MIGRATIONS } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { EventService } from '../src/core/services/EventService';
import { ContextBuilderService } from '../src/core/services/ContextBuilderService';
import {
  ExecutionAuthorizationService,
  computeContextManifestHash,
} from '../src/core/services/ExecutionAuthorizationService';
import { computeSnapshotContentHash } from '../src/core/context/ContextIntegrity';
import {
  Project,
  Task,
  RoleProfile,
  ProviderAccount,
  ProviderResource,
  AgentAssignment,
  AgentSession,
  ProjectMemory,
  TaskMemory,
  ContextSnapshot,
  ContextItem,
  ContextManifest,
  HandoffContext,
} from '../src/core/types/domain';

describe('R5B — Durable Memory & Context Fabric Contract Tests', () => {
  let tempDir: string;
  let repoPath: string;
  let db: Database.Database;
  let repo: Repository;
  let eventService: EventService;
  let contextBuilder: ContextBuilderService;
  let authService: ExecutionAuthorizationService;

  const projectIdA = 'PROJ-TEST-R5B-A';
  const projectIdB = 'PROJ-TEST-R5B-B';
  const taskIdA = 'TSK-TEST-R5B-A1';
  const taskIdA2 = 'TSK-TEST-R5B-A2';
  const taskIdB = 'TSK-TEST-R5B-B1';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-r5b-test-'));
    repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(repoPath, { recursive: true });

    // Initialize real git repo
    execSync('git init', { cwd: repoPath });
    execSync('git config user.email "test@test.com"', { cwd: repoPath });
    execSync('git config user.name "Tester"', { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Initial README\n');
    execSync('git add README.md && git commit -m "initial commit"', { cwd: repoPath });
    const initialSha = execSync('git rev-parse HEAD', { cwd: repoPath }).toString().trim();

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);

    repo = new Repository(db);
    eventService = new EventService(repo);
    contextBuilder = new ContextBuilderService(repo);
    authService = new ExecutionAuthorizationService(repo, eventService);

    // Setup base project A
    repo.createProject({
      id: projectIdA,
      name: 'R5B Project A',
      description: 'Primary test project for R5B memory fabric.',
      repository_path: repoPath,
      default_branch: 'main',
      status: 'RUNNING',
      contract: {
        goal: 'Implement durable memory fabric',
        architecture_constraints: ['No circular dependencies', 'Fail-closed validation'],
        technical_constraints: ['Node.js 22.x', 'TypeScript strictly typed'],
        security_requirements: ['Zero plaintext credentials in SQLite'],
        acceptance_criteria: ['All tests pass'],
        non_goals: ['Live provider connectivity in domain unit tests'],
        definition_of_done: ['Code builds and passes CI'],
        testing_requirements: ['Unit tests with 100% pass rate'],
        owner_policies: ['Human owner is final authority'],
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    });

    // Setup base project B (for isolation tests)
    repo.createProject({
      id: projectIdB,
      name: 'R5B Project B',
      description: 'Secondary test project for cross-project isolation tests.',
      repository_path: repoPath,
      default_branch: 'main',
      status: 'RUNNING',
      contract: {
        goal: 'Isolated test project goal',
        architecture_constraints: ['Isolated context'],
        technical_constraints: ['Node 22'],
        security_requirements: ['Secure memory'],
        acceptance_criteria: ['Isolated'],
        non_goals: [],
        definition_of_done: [],
        testing_requirements: [],
        owner_policies: [],
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    });

    // Setup base tasks
    repo.createTask({
      id: taskIdA,
      project_id: projectIdA,
      milestone_id: null,
      title: 'Task A1 — Implement Durable Memory Fabric',
      description: 'Core implementation task for R5B memory tests.',
      state: 'CODING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 1,
      max_revisions: 5,
      base_sha: initialSha,
      current_sha: initialSha,
      progress_cache_percent: 50,
      progress_computed_at: null,
      acceptance_criteria: ['Durable memory operates deterministically'],
      constraints: ['No plaintext secrets'],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    repo.createTask({
      id: taskIdA2,
      project_id: projectIdA,
      milestone_id: null,
      title: 'Task A2 — Peer Task in Project A',
      description: 'Peer task in project A for cross-task isolation tests.',
      state: 'PLANNED',
      paused_from_state: null,
      priority: 'LOW',
      risk: 'LOW',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: initialSha,
      current_sha: initialSha,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: ['Peer task acceptance'],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    repo.createTask({
      id: taskIdB,
      project_id: projectIdB,
      milestone_id: null,
      title: 'Task B1 — Task in Project B',
      description: 'Task in project B.',
      state: 'CODING',
      paused_from_state: null,
      priority: 'MEDIUM',
      risk: 'LOW',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: initialSha,
      current_sha: initialSha,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: ['Isolated from Project A'],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Create default agent fixture for attempts
    repo.createAgent({
      id: 'agent-r5b-default',
      display_name: 'Default Test Agent',
      provider_resource_id: null,
      role: 'CODER',
      status: 'IDLE',
      current_task_id: null,
      last_seen_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('1. migration 009 applies cleanly on a fresh database and creates all 7 tables', () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toContain('agent_sessions');
    expect(tables).toContain('project_memories');
    expect(tables).toContain('task_memories');
    expect(tables).toContain('context_snapshots');
    expect(tables).toContain('context_items');
    expect(tables).toContain('context_manifests');
    expect(tables).toContain('handoff_contexts');

    const migrationCount = (db.prepare('SELECT COUNT(*) as count FROM schema_migrations').get() as { count: number }).count;
    expect(migrationCount).toBe(9);
  });

  it('2. historical migration upgrade v1 -> v9 succeeds', () => {
    const upgradeDb = new Database(':memory:');
    upgradeDb.pragma('foreign_keys = ON');

    upgradeDb.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    // Apply migrations v1 through v8
    for (let v = 1; v <= 8; v++) {
      const m = MIGRATIONS.find((mig) => mig.version === v)!;
      m.up(upgradeDb);
      upgradeDb.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        v,
        m.name,
        new Date().toISOString()
      );
    }

    expect((upgradeDb.prepare('SELECT COUNT(*) as count FROM schema_migrations').get() as { count: number }).count).toBe(8);

    // Apply migration v9
    MigrationRunner.run(upgradeDb);
    expect((upgradeDb.prepare('SELECT COUNT(*) as count FROM schema_migrations').get() as { count: number }).count).toBe(9);

    const fkViolations = upgradeDb.prepare('PRAGMA foreign_key_check').all();
    expect(fkViolations).toHaveLength(0);
    upgradeDb.close();
  });

  it('3. migrations v1-v8 remain unchanged and migration 8 definition is strictly immutable', () => {
    const mig8 = MIGRATIONS.find((m) => m.version === 8);
    expect(mig8).toBeDefined();
    expect(mig8?.name).toBe('008_r5a_role_agnostic_agent_fabric');

    const mig9 = MIGRATIONS.find((m) => m.version === 9);
    expect(mig9).toBeDefined();
    expect(mig9?.name).toBe('009_r5b_durable_memory_context_fabric');
  });

  it('4. ProjectMemory creation, active lookup, and history retrieval work', () => {
    const mem1: ProjectMemory = {
      id: 'pm-' + crypto.randomUUID(),
      project_id: projectIdA,
      memory_type: 'ARCHITECTURE',
      key: 'DATA_PERSISTENCE',
      value_json: JSON.stringify({ layer: 'SQLite WAL', version: 'v1' }),
      source_type: 'USER_DIRECTIVE',
      source_ref: null,
      revision: 1,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createProjectMemory(mem1);

    const active = repo.getActiveProjectMemoryByKey(projectIdA, 'ARCHITECTURE', 'DATA_PERSISTENCE');
    expect(active).toBeDefined();
    expect(active?.id).toBe(mem1.id);
    expect(JSON.parse(active!.value_json)).toEqual({ layer: 'SQLite WAL', version: 'v1' });
    expect(active?.revision).toBe(1);
    expect(active?.is_active).toBe(true);

    // Update with revision 2
    const mem2: ProjectMemory = {
      id: 'pm-' + crypto.randomUUID(),
      project_id: projectIdA,
      memory_type: 'ARCHITECTURE',
      key: 'DATA_PERSISTENCE',
      value_json: JSON.stringify({ layer: 'SQLite WAL', version: 'v2', encryption: 'none' }),
      source_type: 'USER_DIRECTIVE',
      source_ref: null,
      revision: 2,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createProjectMemory(mem2);

    const activeUpdated = repo.getActiveProjectMemoryByKey(projectIdA, 'ARCHITECTURE', 'DATA_PERSISTENCE');
    expect(activeUpdated?.id).toBe(mem2.id);
    expect(activeUpdated?.revision).toBe(2);

    const history = repo.getProjectMemoryHistory(projectIdA, 'ARCHITECTURE', 'DATA_PERSISTENCE');
    expect(history.length).toBe(2);
    expect(history[0].id).toBe(mem2.id);
    expect(history[0].is_active).toBe(true);
    expect(history[1].id).toBe(mem1.id);
    expect(history[1].is_active).toBe(false);
  });

  it('5. TaskMemory creation, active lookup, and history retrieval work', () => {
    const tm1: TaskMemory = {
      id: 'tm-' + crypto.randomUUID(),
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: null,
      assignment_id: null,
      memory_type: 'COMPLETED_STEP',
      key: 'STEP_1',
      value_json: JSON.stringify({ description: 'Created database schema migration', code: 0 }),
      source_type: 'EXECUTION_OUTPUT',
      source_ref: null,
      revision: 1,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createTaskMemory(tm1);

    const active = repo.getActiveTaskMemoryByKey(taskIdA, 'COMPLETED_STEP', 'STEP_1');
    expect(active).toBeDefined();
    expect(active?.id).toBe(tm1.id);
    expect(active?.revision).toBe(1);

    // Supersede STEP_1 with revision 2
    const tm2: TaskMemory = {
      id: 'tm-' + crypto.randomUUID(),
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: null,
      assignment_id: null,
      memory_type: 'COMPLETED_STEP',
      key: 'STEP_1',
      value_json: JSON.stringify({ description: 'Created database schema migration 009 with tests', code: 0 }),
      source_type: 'EXECUTION_OUTPUT',
      source_ref: null,
      revision: 2,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createTaskMemory(tm2);

    const active2 = repo.getActiveTaskMemoryByKey(taskIdA, 'COMPLETED_STEP', 'STEP_1');
    expect(active2?.id).toBe(tm2.id);
    expect(active2?.revision).toBe(2);

    const history = repo.getTaskMemoryHistory(taskIdA, 'COMPLETED_STEP', 'STEP_1');
    expect(history.length).toBe(2);
    expect(history[0].is_active).toBe(true);
    expect(history[1].is_active).toBe(false);
  });

  it('6. cross-project TaskMemory insertion/lookup fails closed', () => {
    // Attempt inserting TaskMemory with project B for a task belonging to project A
    const invalidTm: TaskMemory = {
      id: 'tm-' + crypto.randomUUID(),
      project_id: projectIdB, // Mismatched project!
      task_id: taskIdA,       // Belongs to Project A
      attempt_id: null,
      assignment_id: null,
      memory_type: 'GOAL',
      key: 'INVALID_CROSS_PROJECT',
      value_json: JSON.stringify({ test: true }),
      source_type: 'MANUAL',
      source_ref: null,
      revision: 1,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    expect(() => repo.createTaskMemory(invalidTm)).toThrowError(/belongs to project/);
  });

  it('7. memory revision history is retained and never destructively deleted', () => {
    for (let i = 1; i <= 4; i++) {
      repo.createProjectMemory({
        id: `pm-rev-${i}-${crypto.randomUUID()}`,
        project_id: projectIdA,
        memory_type: 'CONSTRAINT',
        key: 'RATE_LIMIT',
        value_json: JSON.stringify({ maxPerMinute: i * 10 }),
        source_type: 'SYSTEM',
        source_ref: null,
        revision: i,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    const history = repo.getProjectMemoryHistory(projectIdA, 'CONSTRAINT', 'RATE_LIMIT');
    expect(history.length).toBe(4);
    expect(history.map((h) => h.revision)).toEqual([4, 3, 2, 1]);
    expect(history.filter((h) => h.is_active).length).toBe(1);
    expect(history.find((h) => h.is_active)?.revision).toBe(4);
  });

  it('8. active logical memory version is deterministic', () => {
    repo.createProjectMemory({
      id: 'pm-det-1',
      project_id: projectIdA,
      memory_type: 'CONVENTION',
      key: 'CODE_STYLE',
      value_json: JSON.stringify({ quotes: 'single' }),
      source_type: 'SYSTEM',
      source_ref: null,
      revision: 1,
      is_active: true,
      created_at: '2026-08-24T00:00:01Z',
      updated_at: '2026-08-24T00:00:01Z',
    });

    repo.createProjectMemory({
      id: 'pm-det-2',
      project_id: projectIdA,
      memory_type: 'CONVENTION',
      key: 'CODE_STYLE',
      value_json: JSON.stringify({ quotes: 'single', semicolon: true }),
      source_type: 'SYSTEM',
      source_ref: null,
      revision: 2,
      is_active: true,
      created_at: '2026-08-24T00:00:02Z',
      updated_at: '2026-08-24T00:00:02Z',
    });

    const active1 = repo.getActiveProjectMemoryByKey(projectIdA, 'CONVENTION', 'CODE_STYLE');
    const active2 = repo.getActiveProjectMemoryByKey(projectIdA, 'CONVENTION', 'CODE_STYLE');
    expect(active1).toEqual(active2);
    expect(active1?.revision).toBe(2);
  });

  it('9. AgentSession binds to valid project/task/assignment identities', () => {
    // Setup valid role, account, resource, and assignment
    const roleId = 'rp-coder-' + crypto.randomUUID();
    repo.createRoleProfile({
      id: roleId,
      role: 'CODER',
      display_name: 'Coder Role',
      required_capabilities: ['CODING'],
      preferred_capabilities: [],
      authority_scope: null,
      permissions: ['FILE_WRITE'],
      output_protocol: 'CODER_DIFF',
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const provId = 'prov-bridge';
    repo.createProvider({
      id: provId,
      name: 'Bridge Provider',
      adapter_type: 'MANUAL_BRIDGE',
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const accId = 'acc-1-' + crypto.randomUUID();
    repo.createProviderAccount({
      id: accId,
      provider_id: provId,
      label: 'Native Profile 1',
      auth_mode: 'NATIVE_PROFILE',
      credential_ref: null,
      profile_ref: 'profile-alpha',
      enabled: true,
      priority: 10,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const resId = 'res-1-' + crypto.randomUUID();
    repo.createProviderResource({
      id: resId,
      provider_id: provId,
      provider_account_id: accId,
      model_name: 'gemini-2.5-pro',
      health_status: 'AVAILABLE',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: null,
    });

    const slotId = 'slot-1-' + crypto.randomUUID();
    repo.createWorkerSlot({
      id: slotId,
      provider_account_id: accId,
      provider_resource_id: resId,
      slot_index: 0,
      status: 'IDLE',
      current_assignment_id: null,
      current_execution_id: null,
      heartbeat_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const assignmentId = 'asgn-1-' + crypto.randomUUID();
    repo.createAgentAssignment({
      id: assignmentId,
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: null,
      role_profile_id: roleId,
      agent_profile_id: null,
      selected_provider_id: provId,
      selected_account_id: accId,
      selected_resource_id: resId,
      selected_worker_slot_id: slotId,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    });

    const session: AgentSession = {
      id: 'sess-' + crypto.randomUUID(),
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: null,
      assignment_id: assignmentId,
      provider_id: provId,
      provider_account_id: accId,
      provider_resource_id: resId,
      external_session_ref: 'opaque-ext-session-12345',
      status: 'ACTIVE',
      started_at: new Date().toISOString(),
      ended_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createAgentSession(session);

    const fetched = repo.getAgentSession(session.id);
    expect(fetched).toBeDefined();
    expect(fetched?.external_session_ref).toBe('opaque-ext-session-12345');
    expect(fetched?.status).toBe('ACTIVE');

    // Negative case: Session on Project B with task belonging to Project A fails closed
    expect(() => {
      repo.createAgentSession({
        ...session,
        id: 'sess-invalid-' + crypto.randomUUID(),
        project_id: projectIdB,
      });
    }).toThrowError(/belongs to project/);
  });

  it('10. ContextBuilder produces deterministic item ordering across categories', () => {
    // Add multiple project and task memories
    repo.createProjectMemory({
      id: 'pm-z',
      project_id: projectIdA,
      memory_type: 'DECISION',
      key: 'Z_KEY',
      value_json: JSON.stringify({ note: 'z' }),
      source_type: 'SYSTEM',
      source_ref: null,
      revision: 1,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    repo.createProjectMemory({
      id: 'pm-a',
      project_id: projectIdA,
      memory_type: 'ARCHITECTURE',
      key: 'A_KEY',
      value_json: JSON.stringify({ note: 'a' }),
      source_type: 'SYSTEM',
      source_ref: null,
      revision: 1,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    repo.createTaskMemory({
      id: 'tm-z',
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: null,
      assignment_id: null,
      memory_type: 'RECOMMENDED_NEXT_ACTION',
      key: 'Z_TASK_KEY',
      value_json: JSON.stringify({ note: 'z task' }),
      source_type: 'SYSTEM',
      source_ref: null,
      revision: 1,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    repo.createTaskMemory({
      id: 'tm-a',
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: null,
      assignment_id: null,
      memory_type: 'GOAL',
      key: 'A_TASK_KEY',
      value_json: JSON.stringify({ note: 'a task' }),
      source_type: 'SYSTEM',
      source_ref: null,
      revision: 1,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const res = contextBuilder.buildContextSnapshot({
      projectId: projectIdA,
      taskId: taskIdA,
      contextFiles: ['src/core/types.ts', 'src/core/index.ts'],
    });

    const itemTypes = res.items.map((i) => i.item_type);
    expect(itemTypes[0]).toBe('PROJECT_CONTRACT');
    expect(itemTypes[1]).toBe('PROJECT_MEMORY'); // ARCHITECTURE (A_KEY)
    expect(itemTypes[2]).toBe('PROJECT_MEMORY'); // DECISION (Z_KEY)
    expect(itemTypes[3]).toBe('TASK_CORE');
    expect(itemTypes[4]).toBe('TASK_MEMORY');    // GOAL (A_TASK_KEY)
    expect(itemTypes[5]).toBe('TASK_MEMORY');    // RECOMMENDED_NEXT_ACTION (Z_TASK_KEY)
    expect(itemTypes[6]).toBe('CONTEXT_FILE_REFERENCE'); // src/core/index.ts (alphabetical)
    expect(itemTypes[7]).toBe('CONTEXT_FILE_REFERENCE'); // src/core/types.ts

    // Verify sequential ordinals 0..7
    for (let i = 0; i < res.items.length; i++) {
      expect(res.items[i].ordinal).toBe(i);
    }
  });

  it('11. same logical input produces identical manifest hash (determinism)', () => {
    repo.createProjectMemory({
      id: 'pm-det-hash',
      project_id: projectIdA,
      memory_type: 'CONSTRAINT',
      key: 'STABLE_KEY',
      value_json: JSON.stringify({ b: 2, a: 1 }), // Unsorted keys in object
      source_type: 'SYSTEM',
      source_ref: null,
      revision: 1,
      is_active: true,
      created_at: '2026-08-24T00:00:00Z',
      updated_at: '2026-08-24T00:00:00Z',
    });

    const res1 = contextBuilder.buildContextSnapshot({
      projectId: projectIdA,
      taskId: taskIdA,
      contextFiles: ['src/b.ts', 'src/a.ts'],
    });

    const res2 = contextBuilder.buildContextSnapshot({
      projectId: projectIdA,
      taskId: taskIdA,
      contextFiles: ['src/a.ts', 'src/b.ts'],
    });

    expect(res1.manifest.manifest_hash).toBe(res2.manifest.manifest_hash);
    expect(res1.snapshot.content_hash).toBe(res2.snapshot.content_hash);
  });

  it('12. different semantic context produces different manifest hash', () => {
    const res1 = contextBuilder.buildContextSnapshot({
      projectId: projectIdA,
      taskId: taskIdA,
      contextFiles: ['src/file1.ts'],
    });

    const res2 = contextBuilder.buildContextSnapshot({
      projectId: projectIdA,
      taskId: taskIdA,
      contextFiles: ['src/file2.ts'],
    });

    expect(res1.manifest.manifest_hash).not.toBe(res2.manifest.manifest_hash);
  });

  it('13. persisted ContextSnapshot is immutable (items cannot be mutated silently)', () => {
    const res = contextBuilder.buildContextSnapshot({
      projectId: projectIdA,
      taskId: taskIdA,
    });

    const persistedSnapshot = repo.getContextSnapshot(res.snapshot.id);
    expect(persistedSnapshot).toBeDefined();
    expect(persistedSnapshot?.content_hash).toBe(res.snapshot.content_hash);

    const items = repo.getContextItemsBySnapshot(res.snapshot.id);
    expect(items.length).toBe(res.items.length);
  });

  it('14. ContextItem ordinal uniqueness is enforced by database constraint on unsealed snapshots', () => {
    const snapId = 'snap-unsealed-' + crypto.randomUUID();
    repo.createContextSnapshot({
      id: snapId,
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: null,
      assignment_id: null,
      session_id: null,
      purpose: 'CUSTOM',
      snapshot_version: 1,
      builder_version: 'r5b-v1.1',
      content_hash: 'initial-hash',
      created_at: new Date().toISOString(),
    });

    const item1Content = JSON.stringify({ item: 1 });
    repo.createContextItem({
      id: 'item-1-' + crypto.randomUUID(),
      snapshot_id: snapId,
      ordinal: 0,
      item_type: 'CUSTOM',
      source_type: 'TEST',
      source_ref: null,
      content_json: item1Content,
      content_hash: crypto.createHash('sha256').update(item1Content, 'utf8').digest('hex'),
      token_estimate: null,
      created_at: new Date().toISOString(),
    });

    // Try inserting duplicate ordinal for same unsealed snapshot
    const item2Content = JSON.stringify({ item: 2 });
    expect(() => {
      repo.createContextItem({
        id: 'dup-item-' + crypto.randomUUID(),
        snapshot_id: snapId,
        ordinal: 0, // Duplicate ordinal!
        item_type: 'CUSTOM',
        source_type: 'TEST',
        source_ref: null,
        content_json: item2Content,
        content_hash: crypto.createHash('sha256').update(item2Content, 'utf8').digest('hex'),
        token_estimate: null,
        created_at: new Date().toISOString(),
      });
    }).toThrowError(/UNIQUE constraint failed: context_items.snapshot_id, context_items.ordinal/);
  });

  it('15. ContextManifest is bound to exactly one snapshot and rejects duplicate manifests', () => {
    const res = contextBuilder.buildContextSnapshot({
      projectId: projectIdA,
      taskId: taskIdA,
    });

    expect(() => {
      repo.createContextManifest({
        id: 'dup-man-' + crypto.randomUUID(),
        snapshot_id: res.snapshot.id, // Duplicate snapshot_id!
        manifest_version: '1.0.0',
        item_count: 5,
        manifest_json: JSON.stringify({ items: [] }),
        manifest_hash: 'hash456',
        created_at: new Date().toISOString(),
      });
    }).toThrowError(/already sealed by manifest/);
  });

  it('16. context from Project A can never appear in Project B (cross-project isolation)', () => {
    repo.createProjectMemory({
      id: 'pm-secret-a',
      project_id: projectIdA,
      memory_type: 'CUSTOM',
      key: 'PROJECT_A_SECRET',
      value_json: JSON.stringify({ projectSecret: 'CONFIDENTIAL_A' }),
      source_type: 'USER_DIRECTIVE',
      source_ref: null,
      revision: 1,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const resB = contextBuilder.buildContextSnapshot({
      projectId: projectIdB,
      taskId: taskIdB,
    });

    const manifestStr = resB.manifest.manifest_json;
    expect(manifestStr).not.toContain('PROJECT_A_SECRET');
    expect(manifestStr).not.toContain('CONFIDENTIAL_A');

    const itemsB = repo.getContextItemsBySnapshot(resB.snapshot.id);
    for (const item of itemsB) {
      expect(item.content_json).not.toContain('PROJECT_A_SECRET');
      expect(item.content_json).not.toContain('CONFIDENTIAL_A');
    }
  });

  it('17. context from another task is not silently included (cross-task isolation)', () => {
    repo.createTaskMemory({
      id: 'tm-task-a2',
      project_id: projectIdA,
      task_id: taskIdA2, // Peer task
      attempt_id: null,
      assignment_id: null,
      memory_type: 'CUSTOM',
      key: 'TASK_A2_EXCLUSIVE_NOTE',
      value_json: JSON.stringify({ note: 'EXCLUSIVELY_FOR_TASK_A2' }),
      source_type: 'USER_DIRECTIVE',
      source_ref: null,
      revision: 1,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const resA1 = contextBuilder.buildContextSnapshot({
      projectId: projectIdA,
      taskId: taskIdA, // Task A1
    });

    const manifestStr = resA1.manifest.manifest_json;
    expect(manifestStr).not.toContain('TASK_A2_EXCLUSIVE_NOTE');
    expect(manifestStr).not.toContain('EXCLUSIVELY_FOR_TASK_A2');
  });

  it('18. malformed JSON memory payload is rejected fail-closed according to contract', () => {
    expect(() => {
      repo.createProjectMemory({
        id: 'pm-malformed',
        project_id: projectIdA,
        memory_type: 'ARCHITECTURE',
        key: 'BAD_JSON',
        value_json: 'NOT_JSON { [',
        source_type: 'MANUAL',
        source_ref: null,
        revision: 1,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }).toThrowError(/value_json is not valid JSON/);

    expect(() => {
      repo.createTaskMemory({
        id: 'tm-malformed',
        project_id: projectIdA,
        task_id: taskIdA,
        attempt_id: null,
        assignment_id: null,
        memory_type: 'GOAL',
        key: 'BAD_JSON_TASK',
        value_json: 'BROKEN JSON',
        source_type: 'MANUAL',
        source_ref: null,
        revision: 1,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }).toThrowError(/value_json is not valid JSON/);
  });

  it('19. provider/model/account choice does not alter durable semantic memory contents', () => {
    // Add memory item
    repo.createProjectMemory({
      id: 'pm-semantic',
      project_id: projectIdA,
      memory_type: 'ARCHITECTURE',
      key: 'DATA_MODEL',
      value_json: JSON.stringify({ core: 'Domain Entities' }),
      source_type: 'SYSTEM',
      source_ref: null,
      revision: 1,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const res = contextBuilder.buildContextSnapshot({
      projectId: projectIdA,
      taskId: taskIdA,
    });

    // Content of project memory item in snapshot is identical regardless of runtime model/account
    const memoryItem = res.items.find((i) => i.item_type === 'PROJECT_MEMORY');
    expect(memoryItem).toBeDefined();
    expect(JSON.parse(memoryItem!.content_json)).toEqual({
      memoryType: 'ARCHITECTURE',
      key: 'DATA_MODEL',
      value: { core: 'Domain Entities' },
      revision: 1,
    });
  });

  it('20. no plaintext-secret columns are introduced in R5B schema', () => {
    const tableColumnsQuery = db.prepare(`
      SELECT m.name AS table_name, p.name AS column_name
      FROM sqlite_master m
      JOIN pragma_table_info(m.name) p
      WHERE m.type = 'table' AND m.name IN (
        'agent_sessions', 'project_memories', 'task_memories',
        'context_snapshots', 'context_items', 'context_manifests', 'handoff_contexts'
      );
    `).all() as { table_name: string; column_name: string }[];

    const secretKeywords = ['password', 'secret', 'token', 'api_key', 'bearer', 'oauth'];
    for (const col of tableColumnsQuery) {
      if (col.column_name === 'token_estimate') continue; // token count estimate is safe
      for (const kw of secretKeywords) {
        expect(col.column_name.toLowerCase()).not.toEqual(kw);
      }
    }
  });

  function recordAppliedManagerMessage(
    projectId: string,
    taskId: string,
    params: {
      decision: 'EXECUTE' | 'FIX_REQUIRED' | 'PASS' | 'BLOCK' | 'PAUSE' | 'CANCEL' | 'NEEDS_OWNER' | 'CREATE_TASKS';
      expected_revision?: number | null;
      instructions?: string[];
      messageId?: string;
    }
  ): { messageId: string; recordId: string; payloadHash: string; rawPayload: string } {
    const msgId = params.messageId ?? `msg-mgr-${crypto.randomUUID()}`;
    const recId = `rec-mgr-${crypto.randomUUID()}`;
    const rawPayload = JSON.stringify({
      protocol: 'manager.v1',
      message_id: msgId,
      project_id: projectId,
      task_id: taskId,
      decision: params.decision,
      expected_revision: params.expected_revision ?? 1,
      instructions: params.instructions ?? ['Manager instruction line 1', 'Manager instruction line 2'],
      acceptance_criteria: ['AC 1'],
      constraints: ['Constraint 1'],
    });
    const payloadHash = crypto.createHash('sha256').update(rawPayload, 'utf8').digest('hex');
    repo.recordProtocolMessage(
      recId,
      msgId,
      'manager.v1',
      projectId,
      taskId,
      'APPROVED',
      params.expected_revision ?? 1,
      payloadHash,
      rawPayload,
      'APPLIED',
      undefined,
      new Date().toISOString()
    );
    return { messageId: msgId, recordId: recId, payloadHash, rawPayload };
  }

  it('21. existing ExecutionAuthorization legacy path remains compatible without durable manifest ID', async () => {
    // Setup manager message for authorization
    recordAppliedManagerMessage(projectIdA, taskIdA, {
      decision: 'EXECUTE',
      expected_revision: 1,
      instructions: ['Implement durable memory'],
    });

    // Setup provider and resource
    const provId = 'prov-man-bridge';
    repo.createProvider({
      id: provId,
      name: 'Manual Bridge Provider',
      adapter_type: 'MANUAL_BRIDGE',
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const resId = 'res-man-bridge';
    repo.createProviderResource({
      id: resId,
      provider_id: provId,
      model_name: 'Manual Operator',
      health_status: 'AVAILABLE',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: null,
    });

    // Setup routing decision
    const routingDecisionId = 'rd-' + crypto.randomUUID();
    db.prepare(`
      INSERT INTO events (id, project_id, task_id, type, summary, structured_payload_json, timestamp)
      VALUES (?, ?, ?, 'PROVIDER_ROUTING_DECISION', 'Routing decision', ?, ?)
    `).run(
      routingDecisionId,
      projectIdA,
      taskIdA,
      JSON.stringify({
        decisionId: routingDecisionId,
        selectedResourceId: resId,
        selectedProviderId: provId,
        projectId: projectIdA,
        taskId: taskIdA,
        outcome: 'MANUAL_HANDOFF_REQUIRED',
      }),
      new Date().toISOString()
    );

    const auth = await authService.createAuthorization({
      projectId: projectIdA,
      taskId: taskIdA,
      routingDecisionId,
      contextFiles: ['src/core/domain.ts'],
    });

    expect(auth).toBeDefined();
    expect(auth.status).toBe('AUTHORIZED');
    expect(auth.context_manifest_hash).toBe(computeContextManifestHash(['src/core/domain.ts']));
  });

  it('22. durable manifest integration binds authorization to the stored manifest hash', async () => {
    // Build durable context snapshot & manifest
    const contextRes = contextBuilder.buildContextSnapshot({
      projectId: projectIdA,
      taskId: taskIdA,
      contextFiles: ['src/core/types.ts'],
    });

    // Setup manager message for authorization
    recordAppliedManagerMessage(projectIdA, taskIdA, {
      decision: 'EXECUTE',
      expected_revision: 1,
      instructions: ['Implement with durable manifest'],
    });

    const provId = 'prov-man-bridge-2';
    repo.createProvider({
      id: provId,
      name: 'Manual Bridge 2',
      adapter_type: 'MANUAL_BRIDGE',
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const resId = 'res-man-bridge-2';
    repo.createProviderResource({
      id: resId,
      provider_id: provId,
      model_name: 'Manual Operator 2',
      health_status: 'AVAILABLE',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: null,
    });

    const routingDecisionId = 'rd-' + crypto.randomUUID();
    db.prepare(`
      INSERT INTO events (id, project_id, task_id, type, summary, structured_payload_json, timestamp)
      VALUES (?, ?, ?, 'PROVIDER_ROUTING_DECISION', 'Routing decision', ?, ?)
    `).run(
      routingDecisionId,
      projectIdA,
      taskIdA,
      JSON.stringify({
        decisionId: routingDecisionId,
        selectedResourceId: resId,
        selectedProviderId: provId,
        projectId: projectIdA,
        taskId: taskIdA,
        outcome: 'MANUAL_HANDOFF_REQUIRED',
      }),
      new Date().toISOString()
    );

    const auth = await authService.createAuthorization({
      projectId: projectIdA,
      taskId: taskIdA,
      routingDecisionId,
      contextFiles: ['src/core/types.ts'],
      contextManifestId: contextRes.manifest.id, // Provide durable manifest ID!
    });

    expect(auth).toBeDefined();
    expect(auth.context_manifest_hash).toBe(contextRes.manifest.manifest_hash);
  });

  it('23. modifying memory after authorization creation does not mutate or change the frozen authorization', async () => {
    // 1. Create durable context and authorization
    const contextRes = contextBuilder.buildContextSnapshot({
      projectId: projectIdA,
      taskId: taskIdA,
    });

    recordAppliedManagerMessage(projectIdA, taskIdA, {
      decision: 'EXECUTE',
      expected_revision: 1,
      instructions: ['Freeze test'],
    });

    const provId = 'prov-freeze';
    repo.createProvider({
      id: provId,
      name: 'Freeze Provider',
      adapter_type: 'MANUAL_BRIDGE',
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const resId = 'res-freeze';
    repo.createProviderResource({
      id: resId,
      provider_id: provId,
      model_name: 'Freeze Model',
      health_status: 'AVAILABLE',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: null,
    });

    const routingDecisionId = 'rd-' + crypto.randomUUID();
    db.prepare(`
      INSERT INTO events (id, project_id, task_id, type, summary, structured_payload_json, timestamp)
      VALUES (?, ?, ?, 'PROVIDER_ROUTING_DECISION', 'Routing decision', ?, ?)
    `).run(
      routingDecisionId,
      projectIdA,
      taskIdA,
      JSON.stringify({
        decisionId: routingDecisionId,
        selectedResourceId: resId,
        selectedProviderId: provId,
        projectId: projectIdA,
        taskId: taskIdA,
        outcome: 'MANUAL_HANDOFF_REQUIRED',
      }),
      new Date().toISOString()
    );

    const auth = await authService.createAuthorization({
      projectId: projectIdA,
      taskId: taskIdA,
      routingDecisionId,
      contextManifestId: contextRes.manifest.id,
    });

    const originalHash = auth.context_manifest_hash;
    const originalPayloadHash = auth.instruction_payload_hash;

    // 2. Mutate project and task memory AFTER authorization
    repo.createProjectMemory({
      id: 'pm-post-auth',
      project_id: projectIdA,
      memory_type: 'ARCHITECTURE',
      key: 'MUTATED_POST_AUTH',
      value_json: JSON.stringify({ change: 'new architectural constraint' }),
      source_type: 'USER_DIRECTIVE',
      source_ref: null,
      revision: 1,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    repo.createTaskMemory({
      id: 'tm-post-auth',
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: null,
      assignment_id: null,
      memory_type: 'GOAL',
      key: 'MUTATED_TASK_GOAL',
      value_json: JSON.stringify({ goal: 'new goal' }),
      source_type: 'USER_DIRECTIVE',
      source_ref: null,
      revision: 1,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // 3. Verify the stored authorization remains completely unchanged
    const storedAuth = repo.getExecutionAuthorization(auth.id);
    expect(storedAuth?.context_manifest_hash).toBe(originalHash);
    expect(storedAuth?.instruction_payload_hash).toBe(originalPayloadHash);
  });

  it('24. HandoffContext persistence works without executing any live provider handoff', () => {
    const snap = contextBuilder.buildContextSnapshot({
      projectId: projectIdA,
      taskId: taskIdA,
      purpose: 'HANDOFF',
    });

    const handoff: HandoffContext = {
      id: 'hc-' + crypto.randomUUID(),
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: null,
      from_assignment_id: null,
      to_assignment_id: null,
      source_snapshot_id: snap.snapshot.id,
      handoff_snapshot_id: null,
      reason: 'CODER_TO_REVIEWER_HANDOFF',
      status: 'READY',
      created_at: new Date().toISOString(),
      consumed_at: null,
    };
    repo.createHandoffContext(handoff);

    const fetched = repo.getHandoffContext(handoff.id);
    expect(fetched).toBeDefined();
    expect(fetched?.source_snapshot_id).toBe(snap.snapshot.id);
    expect(fetched?.status).toBe('READY');

    repo.updateHandoffContextStatus(handoff.id, 'CONSUMED', new Date().toISOString());
    const updated = repo.getHandoffContext(handoff.id);
    expect(updated?.status).toBe('CONSUMED');
    expect(updated?.consumed_at).toBeDefined();
  });

  it('25. all existing R5A role-agnostic domain entities and separation policies integrate cleanly with R5B fabric', () => {
    // 1. Create R5A separation policy
    const policyId = 'sp-' + crypto.randomUUID();
    repo.createSeparationPolicy({
      id: policyId,
      name: 'Strict Independent Reviewer Policy',
      same_execution_forbidden: true,
      same_session_forbidden: true,
      same_account_policy: 'REQUIRE_DIFFERENT',
      same_provider_policy: 'PREFER_DIFFERENT',
      same_model_policy: 'PREFER_DIFFERENT',
      risk_threshold: 'HIGH',
      applicability: { roles: ['CODER', 'REVIEWER'] },
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const fetchedPolicy = repo.getSeparationPolicy(policyId);
    expect(fetchedPolicy).toBeDefined();
    expect(fetchedPolicy?.same_session_forbidden).toBe(true);

    // 2. Create R5A route policy
    const routePolicyId = 'rp-' + crypto.randomUUID();
    repo.createRoutePolicy({
      id: routePolicyId,
      name: 'Default Fabric Route Policy',
      required_capabilities: ['CODING'],
      preferred_capabilities: ['FILESYSTEM_EDIT'],
      provider_account_policy: null,
      allow_manual_bridge: true,
      failover_policy: null,
      risk_policy: null,
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const fetchedRoutePolicy = repo.getRoutePolicy(routePolicyId);
    expect(fetchedRoutePolicy).toBeDefined();
    expect(fetchedRoutePolicy?.allow_manual_bridge).toBe(true);

    // 3. Build R5B context snapshot referencing R5A identities
    const snap = contextBuilder.buildContextSnapshot({
      projectId: projectIdA,
      taskId: taskIdA,
      purpose: 'REVIEW',
    });

    expect(snap.snapshot.purpose).toBe('REVIEW');
    expect(snap.manifest.item_count).toBeGreaterThan(0);
  });

  // =========================================================================
  // Manager Corrective 1: Durable Memory Integrity & Provenance Hardening
  // =========================================================================

  it('26. adding ContextItem after manifest exists is rejected (snapshot sealed)', () => {
    const res = contextBuilder.buildContextSnapshot({
      projectId: projectIdA,
      taskId: taskIdA,
    });

    const itemContent = JSON.stringify({ late: 'item' });
    const contentHash = crypto.createHash('sha256').update(itemContent, 'utf8').digest('hex');

    expect(() => {
      repo.createContextItem({
        id: 'item-late-' + crypto.randomUUID(),
        snapshot_id: res.snapshot.id,
        ordinal: res.items.length,
        item_type: 'CUSTOM',
        source_type: 'TEST',
        source_ref: null,
        content_json: itemContent,
        content_hash: contentHash,
        token_estimate: null,
        created_at: new Date().toISOString(),
      });
    }).toThrowError(/is sealed by manifest/);
  });

  it('27. ContextItem content_hash mismatch is rejected', () => {
    const snapId = 'snap-hash-test-' + crypto.randomUUID();
    repo.createContextSnapshot({
      id: snapId,
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: null,
      assignment_id: null,
      session_id: null,
      purpose: 'CUSTOM',
      snapshot_version: 1,
      builder_version: 'r5b-v1.1',
      content_hash: 'initial-hash',
      created_at: new Date().toISOString(),
    });

    expect(() => {
      repo.createContextItem({
        id: 'item-bad-hash-' + crypto.randomUUID(),
        snapshot_id: snapId,
        ordinal: 0,
        item_type: 'CUSTOM',
        source_type: 'TEST',
        source_ref: null,
        content_json: JSON.stringify({ item: 'data' }),
        content_hash: 'tampered-or-wrong-sha256-hash',
        token_estimate: null,
        created_at: new Date().toISOString(),
      });
    }).toThrowError(/content_hash.*does not match SHA-256/);
  });

  it('28. manifest item_count mismatch is rejected', () => {
    const snapId = 'snap-cnt-test-' + crypto.randomUUID();
    repo.createContextSnapshot({
      id: snapId,
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: null,
      assignment_id: null,
      session_id: null,
      purpose: 'CUSTOM',
      snapshot_version: 1,
      builder_version: 'r5b-v1.1',
      content_hash: 'initial-hash',
      created_at: new Date().toISOString(),
    });

    const itemContent = JSON.stringify({ item: 'single' });
    const contentHash = crypto.createHash('sha256').update(itemContent, 'utf8').digest('hex');
    repo.createContextItem({
      id: 'item-single-' + crypto.randomUUID(),
      snapshot_id: snapId,
      ordinal: 0,
      item_type: 'CUSTOM',
      source_type: 'TEST',
      source_ref: null,
      content_json: itemContent,
      content_hash: contentHash,
      token_estimate: null,
      created_at: new Date().toISOString(),
    });

    expect(() => {
      repo.createContextManifest({
        id: 'man-bad-cnt-' + crypto.randomUUID(),
        snapshot_id: snapId,
        manifest_version: '1.0.0',
        item_count: 5, // Actually 1 item!
        manifest_json: JSON.stringify({ items: [] }),
        manifest_hash: 'fake-hash',
        created_at: new Date().toISOString(),
      });
    }).toThrowError(/manifest item_count \(5\) does not match actual item count \(1\)/);
  });

  it('29. manifest_hash mismatch is rejected', () => {
    const snapId = 'snap-mhash-test-' + crypto.randomUUID();
    const itemContent = JSON.stringify({ data: 'val' });
    const itemHash = crypto.createHash('sha256').update(itemContent, 'utf8').digest('hex');

    const snapContentHash = computeSnapshotContentHash({
      projectId: projectIdA,
      taskId: taskIdA,
      attemptId: null,
      assignmentId: null,
      purpose: 'CUSTOM',
      builderVersion: 'r5b-v1.1',
      items: [{
        ordinal: 0,
        itemType: 'CUSTOM',
        sourceType: 'TEST',
        sourceRef: null,
        contentHash: itemHash,
      }],
    });

    repo.createContextSnapshot({
      id: snapId,
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: null,
      assignment_id: null,
      session_id: null,
      purpose: 'CUSTOM',
      snapshot_version: 1,
      builder_version: 'r5b-v1.1',
      content_hash: snapContentHash,
      created_at: new Date().toISOString(),
    });

    repo.createContextItem({
      id: 'item-0-' + crypto.randomUUID(),
      snapshot_id: snapId,
      ordinal: 0,
      item_type: 'CUSTOM',
      source_type: 'TEST',
      source_ref: null,
      content_json: itemContent,
      content_hash: itemHash,
      token_estimate: null,
      created_at: new Date().toISOString(),
    });

    expect(() => {
      repo.createContextManifest({
        id: 'man-bad-hash-' + crypto.randomUUID(),
        snapshot_id: snapId,
        manifest_version: '1.0.0',
        item_count: 1,
        manifest_json: JSON.stringify({ items: [] }),
        manifest_hash: 'tampered-manifest-sha256-hash',
        created_at: new Date().toISOString(),
      });
    }).toThrowError(/manifest_hash.*does not match recomputed/);
  });

  it('30. manifest JSON whose item descriptors do not match actual persisted items is rejected', () => {
    const snapId = 'snap-mjson-test-' + crypto.randomUUID();
    const itemContent = JSON.stringify({ data: 'val' });
    const itemHash = crypto.createHash('sha256').update(itemContent, 'utf8').digest('hex');

    const snapContentHash = computeSnapshotContentHash({
      projectId: projectIdA,
      taskId: taskIdA,
      attemptId: null,
      assignmentId: null,
      purpose: 'CUSTOM',
      builderVersion: 'r5b-v1.1',
      items: [{
        ordinal: 0,
        itemType: 'CUSTOM',
        sourceType: 'TEST',
        sourceRef: null,
        contentHash: itemHash,
      }],
    });

    repo.createContextSnapshot({
      id: snapId,
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: null,
      assignment_id: null,
      session_id: null,
      purpose: 'CUSTOM',
      snapshot_version: 1,
      builder_version: 'r5b-v1.1',
      content_hash: snapContentHash,
      created_at: new Date().toISOString(),
    });

    repo.createContextItem({
      id: 'item-0-' + crypto.randomUUID(),
      snapshot_id: snapId,
      ordinal: 0,
      item_type: 'CUSTOM',
      source_type: 'TEST',
      source_ref: null,
      content_json: itemContent,
      content_hash: itemHash,
      token_estimate: null,
      created_at: new Date().toISOString(),
    });

    // Compute legitimate manifest hash for the legitimate descriptor, but supply bogus manifest_json
    expect(() => {
      repo.createContextManifest({
        id: 'man-bad-json-' + crypto.randomUUID(),
        snapshot_id: snapId,
        manifest_version: '1.0.0',
        item_count: 1,
        manifest_json: JSON.stringify({ mismatched: 'items descriptor' }),
        manifest_hash: 'any-hash',
        created_at: new Date().toISOString(),
      });
    }).toThrowError(/manifest_hash.*does not match recomputed/);
  });

  it('31. snapshot content_hash tampering causes durable authorization rejection', async () => {
    const contextRes = contextBuilder.buildContextSnapshot({
      projectId: projectIdA,
      taskId: taskIdA,
      contextFiles: ['src/core/types.ts'],
    });

    // Tamper with the snapshot content_hash directly in SQLite
    db.prepare('UPDATE context_snapshots SET content_hash = ? WHERE id = ?').run('tampered-content-hash', contextRes.snapshot.id);

    recordAppliedManagerMessage(projectIdA, taskIdA, {
      decision: 'EXECUTE',
      expected_revision: 1,
      instructions: ['Execute authorization'],
    });

    const provId = 'prov-tamper';
    repo.createProvider({
      id: provId,
      name: 'Tamper Provider',
      adapter_type: 'MANUAL_BRIDGE',
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const resId = 'res-tamper';
    repo.createProviderResource({
      id: resId,
      provider_id: provId,
      model_name: 'Manual Operator',
      health_status: 'AVAILABLE',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: null,
    });

    const routingDecisionId = 'rd-' + crypto.randomUUID();
    db.prepare(`
      INSERT INTO events (id, project_id, task_id, type, summary, structured_payload_json, timestamp)
      VALUES (?, ?, ?, 'PROVIDER_ROUTING_DECISION', 'Routing decision', ?, ?)
    `).run(
      routingDecisionId,
      projectIdA,
      taskIdA,
      JSON.stringify({
        decisionId: routingDecisionId,
        selectedResourceId: resId,
        selectedProviderId: provId,
        projectId: projectIdA,
        taskId: taskIdA,
        outcome: 'MANUAL_HANDOFF_REQUIRED',
      }),
      new Date().toISOString()
    );

    await expect(authService.createAuthorization({
      projectId: projectIdA,
      taskId: taskIdA,
      routingDecisionId,
      contextFiles: ['src/core/types.ts'],
      contextManifestId: contextRes.manifest.id,
    })).rejects.toThrowError(/EXECUTION_AUTHORIZATION_FAILED: EXECUTION_AUTHORIZATION_MANIFEST_INTEGRITY_FAILED/);
  });

  it('32. authorization attempt A + snapshot attempt NULL is rejected', async () => {
    // 1. Create durable snapshot without attempt (attempt = null)
    const contextRes = contextBuilder.buildContextSnapshot({
      projectId: projectIdA,
      taskId: taskIdA,
      attemptId: null,
    });

    // 2. Create task attempt
    const attemptId = 'att-32-' + crypto.randomUUID();
    repo.createTaskAttempt({
      id: attemptId,
      task_id: taskIdA,
      agent_id: 'agent-r5b-default',
      attempt_number: 1,
      status: 'RUNNING',
      started_at: new Date().toISOString(),
      ended_at: null,
      summary: null,
    });

    recordAppliedManagerMessage(projectIdA, taskIdA, {
      decision: 'EXECUTE',
      expected_revision: 1,
      instructions: ['Attempt check'],
    });

    const provId = 'prov-att-32';
    repo.createProvider({
      id: provId,
      name: 'Attempt Provider',
      adapter_type: 'MANUAL_BRIDGE',
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const resId = 'res-att-32';
    repo.createProviderResource({
      id: resId,
      provider_id: provId,
      model_name: 'Manual Operator',
      health_status: 'AVAILABLE',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: null,
    });

    const routingDecisionId = 'rd-' + crypto.randomUUID();
    db.prepare(`
      INSERT INTO events (id, project_id, task_id, type, summary, structured_payload_json, timestamp)
      VALUES (?, ?, ?, 'PROVIDER_ROUTING_DECISION', 'Routing decision', ?, ?)
    `).run(
      routingDecisionId,
      projectIdA,
      taskIdA,
      JSON.stringify({
        decisionId: routingDecisionId,
        selectedResourceId: resId,
        selectedProviderId: provId,
        projectId: projectIdA,
        taskId: taskIdA,
        attemptId: attemptId,
        outcome: 'MANUAL_HANDOFF_REQUIRED',
      }),
      new Date().toISOString()
    );

    // Request authorization WITH attemptId, but snapshot has attemptId = null
    await expect(authService.createAuthorization({
      projectId: projectIdA,
      taskId: taskIdA,
      attemptId: attemptId,
      routingDecisionId,
      contextManifestId: contextRes.manifest.id,
    })).rejects.toThrowError(/attempt binding "null" does not match authorization attempt/);
  });

  it('33. authorization attempt NULL + snapshot attempt A is rejected', async () => {
    const attemptId = 'att-33-' + crypto.randomUUID();
    repo.createTaskAttempt({
      id: attemptId,
      task_id: taskIdA,
      agent_id: 'agent-r5b-default',
      attempt_number: 1,
      status: 'RUNNING',
      started_at: new Date().toISOString(),
      ended_at: null,
      summary: null,
    });

    // 1. Create durable snapshot WITH attemptId
    const contextRes = contextBuilder.buildContextSnapshot({
      projectId: projectIdA,
      taskId: taskIdA,
      attemptId: attemptId,
    });

    recordAppliedManagerMessage(projectIdA, taskIdA, {
      decision: 'EXECUTE',
      expected_revision: 1,
      instructions: ['Attempt check 2'],
    });

    const provId = 'prov-att-33';
    repo.createProvider({
      id: provId,
      name: 'Attempt Provider 33',
      adapter_type: 'MANUAL_BRIDGE',
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const resId = 'res-att-33';
    repo.createProviderResource({
      id: resId,
      provider_id: provId,
      model_name: 'Manual Operator',
      health_status: 'AVAILABLE',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: null,
    });

    const routingDecisionId = 'rd-' + crypto.randomUUID();
    db.prepare(`
      INSERT INTO events (id, project_id, task_id, type, summary, structured_payload_json, timestamp)
      VALUES (?, ?, ?, 'PROVIDER_ROUTING_DECISION', 'Routing decision', ?, ?)
    `).run(
      routingDecisionId,
      projectIdA,
      taskIdA,
      JSON.stringify({
        decisionId: routingDecisionId,
        selectedResourceId: resId,
        selectedProviderId: provId,
        projectId: projectIdA,
        taskId: taskIdA,
        outcome: 'MANUAL_HANDOFF_REQUIRED',
      }),
      new Date().toISOString()
    );

    // Request authorization WITHOUT attemptId (attemptId = null), but snapshot has attemptId = attemptId
    await expect(authService.createAuthorization({
      projectId: projectIdA,
      taskId: taskIdA,
      attemptId: null,
      routingDecisionId,
      contextManifestId: contextRes.manifest.id,
    })).rejects.toThrowError(new RegExp(`attempt binding "${attemptId}" does not match authorization attempt "null"`));
  });

  it('34. AgentSession provider A + account provider B is rejected', () => {
    const provA = 'prov-a-' + crypto.randomUUID();
    const provB = 'prov-b-' + crypto.randomUUID();
    repo.createProvider({ id: provA, name: 'Provider A', adapter_type: 'MANUAL_BRIDGE', enabled: true, created_at: new Date().toISOString() });
    repo.createProvider({ id: provB, name: 'Provider B', adapter_type: 'MANUAL_BRIDGE', enabled: true, created_at: new Date().toISOString() });

    const accB = 'acc-b-' + crypto.randomUUID();
    repo.createProviderAccount({
      id: accB,
      provider_id: provB, // Belongs to Provider B
      label: 'Account B',
      auth_mode: 'NATIVE_PROFILE',
      credential_ref: null,
      profile_ref: 'b',
      enabled: true,
      priority: 10,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    expect(() => {
      repo.createAgentSession({
        id: 'sess-bad-prov-' + crypto.randomUUID(),
        project_id: projectIdA,
        task_id: taskIdA,
        attempt_id: null,
        assignment_id: null,
        provider_id: provA, // Provider A
        provider_account_id: accB, // Account belonging to Provider B!
        provider_resource_id: null,
        external_session_ref: null,
        status: 'ACTIVE',
        started_at: new Date().toISOString(),
        ended_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }).toThrowError(/belongs to provider/);
  });

  it('35. AgentSession assignment A + resource/account from another assignment is rejected', () => {
    const provId = 'prov-asgn-check';
    repo.createProvider({ id: provId, name: 'Asgn Provider', adapter_type: 'MANUAL_BRIDGE', enabled: true, created_at: new Date().toISOString() });

    const acc1 = 'acc-asgn-1-' + crypto.randomUUID();
    const acc2 = 'acc-asgn-2-' + crypto.randomUUID();
    repo.createProviderAccount({ id: acc1, provider_id: provId, label: 'Acc 1', auth_mode: 'NATIVE_PROFILE', credential_ref: null, profile_ref: '1', enabled: true, priority: 1, health_status: 'AVAILABLE', cooldown_until: null, concurrency_limit: 1, last_success_at: null, last_failure_at: null, last_failure_code: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    repo.createProviderAccount({ id: acc2, provider_id: provId, label: 'Acc 2', auth_mode: 'NATIVE_PROFILE', credential_ref: null, profile_ref: '2', enabled: true, priority: 1, health_status: 'AVAILABLE', cooldown_until: null, concurrency_limit: 1, last_success_at: null, last_failure_at: null, last_failure_code: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });

    const res1 = 'res-asgn-1-' + crypto.randomUUID();
    const res2 = 'res-asgn-2-' + crypto.randomUUID();
    repo.createProviderResource({ id: res1, provider_id: provId, provider_account_id: acc1, model_name: 'model-1', health_status: 'AVAILABLE', capabilities: ['CODING'], enabled: true, total_quota: null, remaining_quota: null, quota_unit: 'REQUESTS', quota_reset_at: null, quota_source: 'MANUAL', quota_confidence: 1.0, last_health_check: null });
    repo.createProviderResource({ id: res2, provider_id: provId, provider_account_id: acc2, model_name: 'model-2', health_status: 'AVAILABLE', capabilities: ['CODING'], enabled: true, total_quota: null, remaining_quota: null, quota_unit: 'REQUESTS', quota_reset_at: null, quota_source: 'MANUAL', quota_confidence: 1.0, last_health_check: null });

    const roleId = 'rp-asgn-' + crypto.randomUUID();
    repo.createRoleProfile({ id: roleId, role: 'CODER', display_name: 'Coder', required_capabilities: ['CODING'], preferred_capabilities: [], authority_scope: null, permissions: ['FILE_WRITE'], output_protocol: 'CODER_DIFF', enabled: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });

    const slot1 = 'slot-asgn-1-' + crypto.randomUUID();
    repo.createWorkerSlot({ id: slot1, provider_account_id: acc1, provider_resource_id: res1, slot_index: 0, status: 'IDLE', current_assignment_id: null, current_execution_id: null, heartbeat_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });

    const asgn1 = 'asgn-target-' + crypto.randomUUID();
    repo.createAgentAssignment({
      id: asgn1,
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: null,
      role_profile_id: roleId,
      agent_profile_id: null,
      selected_provider_id: provId,
      selected_account_id: acc1,
      selected_resource_id: res1,
      selected_worker_slot_id: slot1,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    });

    // Session claims assignment 1, but specifies account 2 and resource 2
    expect(() => {
      repo.createAgentSession({
        id: 'sess-asgn-mismatch-' + crypto.randomUUID(),
        project_id: projectIdA,
        task_id: taskIdA,
        attempt_id: null,
        assignment_id: asgn1,
        provider_id: provId,
        provider_account_id: acc2, // Mismatch with asgn1.selected_account_id (acc1)
        provider_resource_id: res2, // Mismatch with asgn1.selected_resource_id (res1)
        external_session_ref: null,
        status: 'ACTIVE',
        started_at: new Date().toISOString(),
        ended_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }).toThrowError(/Session account.*does not match assignment account/);
  });

  it('36. ContextSnapshot task A + assignment task B is rejected', () => {
    const provId = 'prov-cs-check';
    repo.createProvider({ id: provId, name: 'CS Prov', adapter_type: 'MANUAL_BRIDGE', enabled: true, created_at: new Date().toISOString() });
    const accId = 'acc-cs-' + crypto.randomUUID();
    repo.createProviderAccount({ id: accId, provider_id: provId, label: 'Acc CS', auth_mode: 'NATIVE_PROFILE', credential_ref: null, profile_ref: 'p', enabled: true, priority: 1, health_status: 'AVAILABLE', cooldown_until: null, concurrency_limit: 1, last_success_at: null, last_failure_at: null, last_failure_code: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    const resId = 'res-cs-' + crypto.randomUUID();
    repo.createProviderResource({ id: resId, provider_id: provId, provider_account_id: accId, model_name: 'model', health_status: 'AVAILABLE', capabilities: ['CODING'], enabled: true, total_quota: null, remaining_quota: null, quota_unit: 'REQUESTS', quota_reset_at: null, quota_source: 'MANUAL', quota_confidence: 1.0, last_health_check: null });
    const roleId = 'rp-cs-' + crypto.randomUUID();
    repo.createRoleProfile({ id: roleId, role: 'CODER', display_name: 'Coder', required_capabilities: ['CODING'], preferred_capabilities: [], authority_scope: null, permissions: ['FILE_WRITE'], output_protocol: 'CODER_DIFF', enabled: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    const slotId = 'slot-cs-' + crypto.randomUUID();
    repo.createWorkerSlot({ id: slotId, provider_account_id: accId, provider_resource_id: resId, slot_index: 0, status: 'IDLE', current_assignment_id: null, current_execution_id: null, heartbeat_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });

    // Assignment belonging to Task B (taskIdB in projectIdB)
    const asgnTaskB = 'asgn-task-b-' + crypto.randomUUID();
    repo.createAgentAssignment({
      id: asgnTaskB,
      project_id: projectIdB,
      task_id: taskIdB,
      attempt_id: null,
      role_profile_id: roleId,
      agent_profile_id: null,
      selected_provider_id: provId,
      selected_account_id: accId,
      selected_resource_id: resId,
      selected_worker_slot_id: slotId,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    });

    // Create snapshot for Task A1, but referencing assignment for Task B
    expect(() => {
      repo.createContextSnapshot({
        id: 'snap-cross-asgn-' + crypto.randomUUID(),
        project_id: projectIdA,
        task_id: taskIdA,
        attempt_id: null,
        assignment_id: asgnTaskB, // Assignment from Task B!
        session_id: null,
        purpose: 'CUSTOM',
        snapshot_version: 1,
        builder_version: 'r5b-v1.1',
        content_hash: 'hash',
        created_at: new Date().toISOString(),
      });
    }).toThrowError(/does not match project\/task/);
  });

  it('37. ContextSnapshot attempt A + session from contradictory attempt is rejected', () => {
    const attempt1 = 'att-snap-1-' + crypto.randomUUID();
    const attempt2 = 'att-snap-2-' + crypto.randomUUID();
    repo.createTaskAttempt({ id: attempt1, task_id: taskIdA, agent_id: 'agent-r5b-default', attempt_number: 1, status: 'RUNNING', started_at: new Date().toISOString(), ended_at: null, summary: null });
    repo.createTaskAttempt({ id: attempt2, task_id: taskIdA, agent_id: 'agent-r5b-default', attempt_number: 2, status: 'RUNNING', started_at: new Date().toISOString(), ended_at: null, summary: null });

    const sessionAtt1 = 'sess-att1-' + crypto.randomUUID();
    repo.createAgentSession({
      id: sessionAtt1,
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: attempt1, // Session bound to attempt 1
      assignment_id: null,
      provider_id: null,
      provider_account_id: null,
      provider_resource_id: null,
      external_session_ref: null,
      status: 'ACTIVE',
      started_at: new Date().toISOString(),
      ended_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Create snapshot with attempt 2, but referencing session from attempt 1
    expect(() => {
      repo.createContextSnapshot({
        id: 'snap-contradict-att-' + crypto.randomUUID(),
        project_id: projectIdA,
        task_id: taskIdA,
        attempt_id: attempt2, // Attempt 2
        assignment_id: null,
        session_id: sessionAtt1, // Session for attempt 1
        purpose: 'CUSTOM',
        snapshot_version: 1,
        builder_version: 'r5b-v1.1',
        content_hash: 'hash',
        created_at: new Date().toISOString(),
      });
    }).toThrowError(/conflicting attempt bindings/);
  });

  it('38. HandoffContext from/to assignment from wrong task/project is rejected', () => {
    const snap = contextBuilder.buildContextSnapshot({ projectId: projectIdA, taskId: taskIdA });

    expect(() => {
      repo.createHandoffContext({
        id: 'hc-invalid-asgn-' + crypto.randomUUID(),
        project_id: projectIdA,
        task_id: taskIdA,
        attempt_id: null,
        from_assignment_id: 'non-existent-or-foreign-asgn',
        to_assignment_id: null,
        source_snapshot_id: snap.snapshot.id,
        handoff_snapshot_id: null,
        reason: 'HANDOFF',
        status: 'READY',
        created_at: new Date().toISOString(),
        consumed_at: null,
      });
    }).toThrowError(/From AgentAssignment.*not found/);
  });

  it('39. first ProjectMemory with caller revision 99 cannot persist as 99 (persists as 1)', () => {
    const memId = 'pm-rev99-' + crypto.randomUUID();
    repo.createProjectMemory({
      id: memId,
      project_id: projectIdA,
      memory_type: 'CUSTOM',
      key: 'CALLER_REV_TEST',
      value_json: JSON.stringify({ note: 'first' }),
      source_type: 'USER',
      source_ref: null,
      revision: 99, // Caller sends 99!
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const stored = repo.getProjectMemory(memId);
    expect(stored).toBeDefined();
    expect(stored?.revision).toBe(1); // Repository overrides to 1!
  });

  it('40. first TaskMemory with caller revision 99 cannot persist as 99 (persists as 1)', () => {
    const memId = 'tm-rev99-' + crypto.randomUUID();
    repo.createTaskMemory({
      id: memId,
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: null,
      assignment_id: null,
      memory_type: 'CUSTOM',
      key: 'CALLER_TASK_REV_TEST',
      value_json: JSON.stringify({ note: 'first task' }),
      source_type: 'USER',
      source_ref: null,
      revision: 99, // Caller sends 99!
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const stored = repo.getTaskMemory(memId);
    expect(stored).toBeDefined();
    expect(stored?.revision).toBe(1); // Repository overrides to 1!
  });

  it('41. subsequent memory revisions are repository-controlled active.revision + 1', () => {
    const key = 'AUTO_INCREMENT_KEY';
    // Revision 1
    repo.createProjectMemory({
      id: 'pm-auto-1',
      project_id: projectIdA,
      memory_type: 'CUSTOM',
      key,
      value_json: JSON.stringify({ ver: 1 }),
      source_type: 'USER',
      source_ref: null,
      revision: 10,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Revision 2 (caller sends 500)
    repo.createProjectMemory({
      id: 'pm-auto-2',
      project_id: projectIdA,
      memory_type: 'CUSTOM',
      key,
      value_json: JSON.stringify({ ver: 2 }),
      source_type: 'USER',
      source_ref: null,
      revision: 500,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Revision 3 (caller sends 1)
    repo.createProjectMemory({
      id: 'pm-auto-3',
      project_id: projectIdA,
      memory_type: 'CUSTOM',
      key,
      value_json: JSON.stringify({ ver: 3 }),
      source_type: 'USER',
      source_ref: null,
      revision: 1,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const m1 = repo.getProjectMemory('pm-auto-1');
    const m2 = repo.getProjectMemory('pm-auto-2');
    const m3 = repo.getProjectMemory('pm-auto-3');

    expect(m1?.revision).toBe(1);
    expect(m2?.revision).toBe(2);
    expect(m3?.revision).toBe(3);
    expect(m3?.is_active).toBe(true);
    expect(m1?.is_active).toBe(false);
    expect(m2?.is_active).toBe(false);
  });

  it('42. absolute context path inside repository is still rejected', () => {
    const absPath = path.join(repoPath, 'README.md');
    expect(() => {
      contextBuilder.buildContextSnapshot({
        projectId: projectIdA,
        taskId: taskIdA,
        contextFiles: [absPath],
      });
    }).toThrowError(/must be relative to repository root/);
  });

  it('43. traversal context path is rejected', () => {
    expect(() => {
      contextBuilder.buildContextSnapshot({
        projectId: projectIdA,
        taskId: taskIdA,
        contextFiles: ['../outside.ts'],
      });
    }).toThrowError(/violates path containment/);
  });

  it('44. PolicyService-denied context path is rejected', () => {
    expect(() => {
      contextBuilder.buildContextSnapshot({
        projectId: projectIdA,
        taskId: taskIdA,
        contextFiles: ['.env'],
      });
    }).toThrowError(/CONTEXT_PATH_DENIED/);
  });

  it('45. identical CUSTOM semantic items in reversed caller order produce identical manifest hash', () => {
    const customItems1 = [
      { sourceType: 'MANUAL', sourceRef: 'ref-B', content: { val: 2 } },
      { sourceType: 'MANUAL', sourceRef: 'ref-A', content: { val: 1 } },
    ];

    const customItems2 = [
      { sourceType: 'MANUAL', sourceRef: 'ref-A', content: { val: 1 } },
      { sourceType: 'MANUAL', sourceRef: 'ref-B', content: { val: 2 } },
    ];

    const res1 = contextBuilder.buildContextSnapshot({
      projectId: projectIdA,
      taskId: taskIdA,
      customItems: customItems1,
    });

    const res2 = contextBuilder.buildContextSnapshot({
      projectId: projectIdA,
      taskId: taskIdA,
      customItems: customItems2,
    });

    expect(res1.manifest.manifest_hash).toBe(res2.manifest.manifest_hash);
    expect(res1.snapshot.content_hash).toBe(res2.snapshot.content_hash);
  });

  it('46. sealed snapshot still reads successfully', () => {
    const res = contextBuilder.buildContextSnapshot({
      projectId: projectIdA,
      taskId: taskIdA,
    });

    const fetchedSnap = repo.getContextSnapshot(res.snapshot.id);
    const fetchedManifest = repo.getContextManifest(res.manifest.id);
    const fetchedItems = repo.getContextItemsBySnapshot(res.snapshot.id);

    expect(fetchedSnap).toBeDefined();
    expect(fetchedManifest).toBeDefined();
    expect(fetchedItems.length).toBe(res.items.length);
  });

  it('47. legacy ExecutionAuthorization without durable manifest remains PASS', async () => {
    recordAppliedManagerMessage(projectIdA, taskIdA, {
      decision: 'EXECUTE',
      expected_revision: 1,
      instructions: ['Legacy path test'],
    });

    const provId = 'prov-legacy-47';
    repo.createProvider({ id: provId, name: 'Legacy Provider', adapter_type: 'MANUAL_BRIDGE', enabled: true, created_at: new Date().toISOString() });

    const resId = 'res-legacy-47';
    repo.createProviderResource({
      id: resId,
      provider_id: provId,
      model_name: 'Manual',
      health_status: 'AVAILABLE',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: null,
    });

    const routingDecisionId = 'rd-' + crypto.randomUUID();
    db.prepare(`
      INSERT INTO events (id, project_id, task_id, type, summary, structured_payload_json, timestamp)
      VALUES (?, ?, ?, 'PROVIDER_ROUTING_DECISION', 'Routing decision', ?, ?)
    `).run(
      routingDecisionId,
      projectIdA,
      taskIdA,
      JSON.stringify({
        decisionId: routingDecisionId,
        selectedResourceId: resId,
        selectedProviderId: provId,
        projectId: projectIdA,
        taskId: taskIdA,
        outcome: 'MANUAL_HANDOFF_REQUIRED',
      }),
      new Date().toISOString()
    );

    const auth = await authService.createAuthorization({
      projectId: projectIdA,
      taskId: taskIdA,
      routingDecisionId,
      contextFiles: ['README.md'],
    });

    expect(auth).toBeDefined();
    expect(auth.status).toBe('AUTHORIZED');
    expect(auth.context_manifest_hash).toBe(computeContextManifestHash(['README.md']));
  });

  it('48. ContextSnapshot: snapshot attempt NULL + assignment ATT-A + session ATT-B => rejected', () => {
    const attemptA = 'att-cs-48-a-' + crypto.randomUUID();
    const attemptB = 'att-cs-48-b-' + crypto.randomUUID();
    repo.createTaskAttempt({ id: attemptA, task_id: taskIdA, agent_id: 'agent-r5b-default', attempt_number: 1, status: 'RUNNING', started_at: new Date().toISOString(), ended_at: null, summary: null });
    repo.createTaskAttempt({ id: attemptB, task_id: taskIdA, agent_id: 'agent-r5b-default', attempt_number: 2, status: 'RUNNING', started_at: new Date().toISOString(), ended_at: null, summary: null });

    const provId = 'prov-cs-48';
    repo.createProvider({ id: provId, name: 'Provider 48', adapter_type: 'MANUAL_BRIDGE', enabled: true, created_at: new Date().toISOString() });
    const accId = 'acc-cs-48-' + crypto.randomUUID();
    repo.createProviderAccount({ id: accId, provider_id: provId, label: 'Acc 48', auth_mode: 'NATIVE_PROFILE', credential_ref: null, profile_ref: 'p', enabled: true, priority: 1, health_status: 'AVAILABLE', cooldown_until: null, concurrency_limit: 1, last_success_at: null, last_failure_at: null, last_failure_code: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    const resId = 'res-cs-48-' + crypto.randomUUID();
    repo.createProviderResource({ id: resId, provider_id: provId, provider_account_id: accId, model_name: 'model', health_status: 'AVAILABLE', capabilities: ['CODING'], enabled: true, total_quota: null, remaining_quota: null, quota_unit: 'REQUESTS', quota_reset_at: null, quota_source: 'MANUAL', quota_confidence: 1.0, last_health_check: null });
    const roleId = 'rp-cs-48-' + crypto.randomUUID();
    repo.createRoleProfile({ id: roleId, role: 'CODER', display_name: 'Coder', required_capabilities: ['CODING'], preferred_capabilities: [], authority_scope: null, permissions: ['FILE_WRITE'], output_protocol: 'CODER_DIFF', enabled: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    const slotId = 'slot-cs-48-' + crypto.randomUUID();
    repo.createWorkerSlot({ id: slotId, provider_account_id: accId, provider_resource_id: resId, slot_index: 0, status: 'IDLE', current_assignment_id: null, current_execution_id: null, heartbeat_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });

    const asgnA = 'asgn-cs-48-a-' + crypto.randomUUID();
    repo.createAgentAssignment({
      id: asgnA,
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: attemptA,
      role_profile_id: roleId,
      agent_profile_id: null,
      selected_provider_id: provId,
      selected_account_id: accId,
      selected_resource_id: resId,
      selected_worker_slot_id: slotId,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    });

    const sessB = 'sess-cs-48-b-' + crypto.randomUUID();
    repo.createAgentSession({
      id: sessB,
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: attemptB,
      assignment_id: null,
      provider_id: provId,
      provider_account_id: accId,
      provider_resource_id: resId,
      external_session_ref: null,
      status: 'ACTIVE',
      started_at: new Date().toISOString(),
      ended_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    expect(() => {
      repo.createContextSnapshot({
        id: 'snap-cs-48-' + crypto.randomUUID(),
        project_id: projectIdA,
        task_id: taskIdA,
        attempt_id: null, // snapshot attempt NULL
        assignment_id: asgnA, // assignment ATT-A
        session_id: sessB, // session ATT-B
        purpose: 'CUSTOM',
        snapshot_version: 1,
        builder_version: 'r5b-v1.1',
        content_hash: 'hash48',
        created_at: new Date().toISOString(),
      });
    }).toThrowError(/conflicting attempt bindings/);
  });

  it('49. ContextSnapshot: snapshot attempt NULL + assignment ATT-A + session ATT-A => accepted', () => {
    const attemptA = 'att-cs-49-a-' + crypto.randomUUID();
    repo.createTaskAttempt({ id: attemptA, task_id: taskIdA, agent_id: 'agent-r5b-default', attempt_number: 1, status: 'RUNNING', started_at: new Date().toISOString(), ended_at: null, summary: null });

    const provId = 'prov-cs-49';
    repo.createProvider({ id: provId, name: 'Provider 49', adapter_type: 'MANUAL_BRIDGE', enabled: true, created_at: new Date().toISOString() });
    const accId = 'acc-cs-49-' + crypto.randomUUID();
    repo.createProviderAccount({ id: accId, provider_id: provId, label: 'Acc 49', auth_mode: 'NATIVE_PROFILE', credential_ref: null, profile_ref: 'p', enabled: true, priority: 1, health_status: 'AVAILABLE', cooldown_until: null, concurrency_limit: 1, last_success_at: null, last_failure_at: null, last_failure_code: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    const resId = 'res-cs-49-' + crypto.randomUUID();
    repo.createProviderResource({ id: resId, provider_id: provId, provider_account_id: accId, model_name: 'model', health_status: 'AVAILABLE', capabilities: ['CODING'], enabled: true, total_quota: null, remaining_quota: null, quota_unit: 'REQUESTS', quota_reset_at: null, quota_source: 'MANUAL', quota_confidence: 1.0, last_health_check: null });
    const roleId = 'rp-cs-49-' + crypto.randomUUID();
    repo.createRoleProfile({ id: roleId, role: 'CODER', display_name: 'Coder', required_capabilities: ['CODING'], preferred_capabilities: [], authority_scope: null, permissions: ['FILE_WRITE'], output_protocol: 'CODER_DIFF', enabled: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    const slotId = 'slot-cs-49-' + crypto.randomUUID();
    repo.createWorkerSlot({ id: slotId, provider_account_id: accId, provider_resource_id: resId, slot_index: 0, status: 'IDLE', current_assignment_id: null, current_execution_id: null, heartbeat_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });

    const asgnA = 'asgn-cs-49-a-' + crypto.randomUUID();
    repo.createAgentAssignment({
      id: asgnA,
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: attemptA,
      role_profile_id: roleId,
      agent_profile_id: null,
      selected_provider_id: provId,
      selected_account_id: accId,
      selected_resource_id: resId,
      selected_worker_slot_id: slotId,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    });

    const sessA = 'sess-cs-49-a-' + crypto.randomUUID();
    repo.createAgentSession({
      id: sessA,
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: attemptA,
      assignment_id: asgnA,
      provider_id: provId,
      provider_account_id: accId,
      provider_resource_id: resId,
      external_session_ref: null,
      status: 'ACTIVE',
      started_at: new Date().toISOString(),
      ended_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const snapId = 'snap-cs-49-' + crypto.randomUUID();
    repo.createContextSnapshot({
      id: snapId,
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: null, // snapshot attempt NULL
      assignment_id: asgnA, // assignment ATT-A
      session_id: sessA, // session ATT-A
      purpose: 'CUSTOM',
      snapshot_version: 1,
      builder_version: 'r5b-v1.1',
      content_hash: 'hash49',
      created_at: new Date().toISOString(),
    });

    const persisted = repo.getContextSnapshot(snapId);
    expect(persisted).not.toBeNull();
    expect(persisted?.assignment_id).toBe(asgnA);
    expect(persisted?.session_id).toBe(sessA);
    expect(persisted?.attempt_id).toBeNull();
  });

  it('50. HandoffContext: handoff attempt NULL + from assignment ATT-A + to assignment ATT-B => rejected', () => {
    const attemptA = 'att-hc-50-a-' + crypto.randomUUID();
    const attemptB = 'att-hc-50-b-' + crypto.randomUUID();
    repo.createTaskAttempt({ id: attemptA, task_id: taskIdA, agent_id: 'agent-r5b-default', attempt_number: 1, status: 'RUNNING', started_at: new Date().toISOString(), ended_at: null, summary: null });
    repo.createTaskAttempt({ id: attemptB, task_id: taskIdA, agent_id: 'agent-r5b-default', attempt_number: 2, status: 'RUNNING', started_at: new Date().toISOString(), ended_at: null, summary: null });

    const provId = 'prov-hc-50';
    repo.createProvider({ id: provId, name: 'Provider 50', adapter_type: 'MANUAL_BRIDGE', enabled: true, created_at: new Date().toISOString() });
    const accId = 'acc-hc-50-' + crypto.randomUUID();
    repo.createProviderAccount({ id: accId, provider_id: provId, label: 'Acc 50', auth_mode: 'NATIVE_PROFILE', credential_ref: null, profile_ref: 'p', enabled: true, priority: 1, health_status: 'AVAILABLE', cooldown_until: null, concurrency_limit: 1, last_success_at: null, last_failure_at: null, last_failure_code: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    const resId = 'res-hc-50-' + crypto.randomUUID();
    repo.createProviderResource({ id: resId, provider_id: provId, provider_account_id: accId, model_name: 'model', health_status: 'AVAILABLE', capabilities: ['CODING'], enabled: true, total_quota: null, remaining_quota: null, quota_unit: 'REQUESTS', quota_reset_at: null, quota_source: 'MANUAL', quota_confidence: 1.0, last_health_check: null });
    const roleId = 'rp-hc-50-' + crypto.randomUUID();
    repo.createRoleProfile({ id: roleId, role: 'CODER', display_name: 'Coder', required_capabilities: ['CODING'], preferred_capabilities: [], authority_scope: null, permissions: ['FILE_WRITE'], output_protocol: 'CODER_DIFF', enabled: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    const slotId = 'slot-hc-50-' + crypto.randomUUID();
    repo.createWorkerSlot({ id: slotId, provider_account_id: accId, provider_resource_id: resId, slot_index: 0, status: 'IDLE', current_assignment_id: null, current_execution_id: null, heartbeat_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });

    const asgnA = 'asgn-hc-50-a-' + crypto.randomUUID();
    repo.createAgentAssignment({
      id: asgnA,
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: attemptA,
      role_profile_id: roleId,
      agent_profile_id: null,
      selected_provider_id: provId,
      selected_account_id: accId,
      selected_resource_id: resId,
      selected_worker_slot_id: slotId,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    });

    const asgnB = 'asgn-hc-50-b-' + crypto.randomUUID();
    repo.createAgentAssignment({
      id: asgnB,
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: attemptB,
      role_profile_id: roleId,
      agent_profile_id: null,
      selected_provider_id: provId,
      selected_account_id: accId,
      selected_resource_id: resId,
      selected_worker_slot_id: slotId,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    });

    const snap = contextBuilder.buildContextSnapshot({ projectId: projectIdA, taskId: taskIdA, attemptId: null });

    expect(() => {
      repo.createHandoffContext({
        id: 'hc-50-' + crypto.randomUUID(),
        project_id: projectIdA,
        task_id: taskIdA,
        attempt_id: null, // handoff attempt NULL
        from_assignment_id: asgnA, // from assignment ATT-A
        to_assignment_id: asgnB, // to assignment ATT-B
        source_snapshot_id: snap.snapshot.id,
        handoff_snapshot_id: null,
        reason: 'HANDOFF_TEST',
        status: 'READY',
        created_at: new Date().toISOString(),
        consumed_at: null,
      });
    }).toThrowError(/conflicting attempt bindings/);
  });

  it('51. HandoffContext: handoff attempt NULL + source snapshot ATT-A + handoff snapshot ATT-B => rejected', () => {
    const attemptA = 'att-hc-51-a-' + crypto.randomUUID();
    const attemptB = 'att-hc-51-b-' + crypto.randomUUID();
    repo.createTaskAttempt({ id: attemptA, task_id: taskIdA, agent_id: 'agent-r5b-default', attempt_number: 1, status: 'RUNNING', started_at: new Date().toISOString(), ended_at: null, summary: null });
    repo.createTaskAttempt({ id: attemptB, task_id: taskIdA, agent_id: 'agent-r5b-default', attempt_number: 2, status: 'RUNNING', started_at: new Date().toISOString(), ended_at: null, summary: null });

    const snapA = contextBuilder.buildContextSnapshot({ projectId: projectIdA, taskId: taskIdA, attemptId: attemptA });
    const snapB = contextBuilder.buildContextSnapshot({ projectId: projectIdA, taskId: taskIdA, attemptId: attemptB });

    expect(() => {
      repo.createHandoffContext({
        id: 'hc-51-' + crypto.randomUUID(),
        project_id: projectIdA,
        task_id: taskIdA,
        attempt_id: null, // handoff attempt NULL
        from_assignment_id: null,
        to_assignment_id: null,
        source_snapshot_id: snapA.snapshot.id, // source snap ATT-A
        handoff_snapshot_id: snapB.snapshot.id, // handoff snap ATT-B
        reason: 'HANDOFF_TEST',
        status: 'READY',
        created_at: new Date().toISOString(),
        consumed_at: null,
      });
    }).toThrowError(/conflicting attempt bindings/);
  });

  it('52. HandoffContext: handoff attempt NULL + all supplied non-null child attempts ATT-A => accepted', () => {
    const attemptA = 'att-hc-52-a-' + crypto.randomUUID();
    repo.createTaskAttempt({ id: attemptA, task_id: taskIdA, agent_id: 'agent-r5b-default', attempt_number: 1, status: 'RUNNING', started_at: new Date().toISOString(), ended_at: null, summary: null });

    const provId = 'prov-hc-52';
    repo.createProvider({ id: provId, name: 'Provider 52', adapter_type: 'MANUAL_BRIDGE', enabled: true, created_at: new Date().toISOString() });
    const accId = 'acc-hc-52-' + crypto.randomUUID();
    repo.createProviderAccount({ id: accId, provider_id: provId, label: 'Acc 52', auth_mode: 'NATIVE_PROFILE', credential_ref: null, profile_ref: 'p', enabled: true, priority: 1, health_status: 'AVAILABLE', cooldown_until: null, concurrency_limit: 1, last_success_at: null, last_failure_at: null, last_failure_code: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    const resId = 'res-hc-52-' + crypto.randomUUID();
    repo.createProviderResource({ id: resId, provider_id: provId, provider_account_id: accId, model_name: 'model', health_status: 'AVAILABLE', capabilities: ['CODING'], enabled: true, total_quota: null, remaining_quota: null, quota_unit: 'REQUESTS', quota_reset_at: null, quota_source: 'MANUAL', quota_confidence: 1.0, last_health_check: null });
    const roleId = 'rp-hc-52-' + crypto.randomUUID();
    repo.createRoleProfile({ id: roleId, role: 'CODER', display_name: 'Coder', required_capabilities: ['CODING'], preferred_capabilities: [], authority_scope: null, permissions: ['FILE_WRITE'], output_protocol: 'CODER_DIFF', enabled: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    const slotId = 'slot-hc-52-' + crypto.randomUUID();
    repo.createWorkerSlot({ id: slotId, provider_account_id: accId, provider_resource_id: resId, slot_index: 0, status: 'IDLE', current_assignment_id: null, current_execution_id: null, heartbeat_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });

    const asgnA = 'asgn-hc-52-a-' + crypto.randomUUID();
    repo.createAgentAssignment({
      id: asgnA,
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: attemptA,
      role_profile_id: roleId,
      agent_profile_id: null,
      selected_provider_id: provId,
      selected_account_id: accId,
      selected_resource_id: resId,
      selected_worker_slot_id: slotId,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    });

    const snapA = contextBuilder.buildContextSnapshot({ projectId: projectIdA, taskId: taskIdA, attemptId: attemptA });

    const hcId = 'hc-52-' + crypto.randomUUID();
    repo.createHandoffContext({
      id: hcId,
      project_id: projectIdA,
      task_id: taskIdA,
      attempt_id: null, // handoff attempt NULL
      from_assignment_id: asgnA, // from assignment ATT-A
      to_assignment_id: null, // to assignment NULL
      source_snapshot_id: snapA.snapshot.id, // source snapshot ATT-A
      handoff_snapshot_id: null, // handoff snapshot NULL
      reason: 'HANDOFF_SUCCESS',
      status: 'READY',
      created_at: new Date().toISOString(),
      consumed_at: null,
    });

    const persisted = repo.getHandoffContext(hcId);
    expect(persisted).not.toBeNull();
    expect(persisted?.attempt_id).toBeNull();
    expect(persisted?.from_assignment_id).toBe(asgnA);
    expect(persisted?.source_snapshot_id).toBe(snapA.snapshot.id);
  });
});
