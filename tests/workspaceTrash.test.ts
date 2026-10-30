import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { WorkspaceManagementService } from '../src/core/services/WorkspaceManagementService';
import { ProjectStopFenceService } from '../src/core/services/ProjectStopFenceService';
import type { TaskState } from '../src/core/types/domain';
import { columnsOf, foreignKeysOf, insertFixtureRow, primaryKeyOf, tableNames } from './helpers/schemaRowFixture';

const NOW = '2026-10-24T09:00:00.000Z';

describe('owner trash for projects and tasks', () => {
  let dir: string;
  let dbPath: string;
  let db: Database.Database;
  let repo: Repository;
  let service: WorkspaceManagementService;

  const open = () => {
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    service = new WorkspaceManagementService(repo, () => NOW);
  };

  const project = (id: string, status = 'PLANNING') => repo.createProject({
    id, name: `Project ${id}`, description: 'Owner project', repository_path: path.join(dir, id), default_branch: 'main',
    status: status as any, contract: null, created_at: NOW, updated_at: NOW, started_at: null, completed_at: null,
  });

  const task = (id: string, projectId: string, state: TaskState = 'CREATED') => repo.createTask({
    id, project_id: projectId, milestone_id: null, title: `Task ${id}`, description: null, state, paused_from_state: null,
    priority: 'MEDIUM', risk: 'LOW', assigned_agent_id: null, revision_count: 0, max_revisions: 3, base_sha: null,
    current_sha: null, progress_cache_percent: 0, progress_computed_at: null, constraints: [], acceptance_criteria: [],
    created_at: NOW, updated_at: NOW,
  });

  /** Minimal AUTHORIZED row; its FK fixtures are irrelevant to the trash fence. */
  const authorization = (id: string, projectId: string, taskId: string, status = 'AUTHORIZED') => {
    db.pragma('foreign_keys = OFF');
    db.prepare(`
      INSERT INTO execution_authorizations (
        id, project_id, task_id, attempt_id, task_revision, base_sha, repository_head_sha, manager_message_id,
        manager_payload_hash, routing_decision_id, selected_resource_id, selected_provider_id,
        instruction_payload_hash, context_manifest_hash, canonical_instructions_json, context_files_json, status, created_at
      ) VALUES (?, ?, ?, NULL, 0, 'sha', 'sha', 'msg', 'h', 'route', 'res', 'prov', 'h', 'h', '{}', '[]', ?, ?)
    `).run(id, projectId, taskId, status, NOW);
    db.pragma('foreign_keys = ON');
  };
  const authStatus = (id: string) => (db.prepare('SELECT status FROM execution_authorizations WHERE id = ?').get(id) as { status: string }).status;

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-trash-')));
    dbPath = path.join(dir, 'agent-forge.db');
    open();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('trashes and restores a finished task without deleting it, and records audit events', () => {
    project('P1');
    task('T1', 'P1', 'DONE');
    const tasksBefore = (db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number }).c;

    expect(service.trashTask({ taskId: 'T1' })).toEqual({ success: true, entityType: 'TASK', entityId: 'T1', invalidatedAuthorizations: 0 });
    expect(repo.isTaskTrashed('T1')).toBe(true);
    expect(repo.getTask('T1')).toMatchObject({ id: 'T1', state: 'DONE' });
    expect((db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number }).c).toBe(tasksBefore);
    expect(service.listTrash().tasks).toEqual([
      { id: 'T1', title: 'Task T1', state: 'DONE', projectId: 'P1', projectName: 'Project P1', trashedAt: NOW },
    ]);
    expect(service.trashTask({ taskId: 'T1' })).toMatchObject({ success: false, errorCode: 'ALREADY_IN_TRASH' });

    expect(service.restoreTask({ taskId: 'T1' })).toMatchObject({ success: true, entityId: 'T1' });
    expect(repo.isTaskTrashed('T1')).toBe(false);
    expect(service.restoreTask({ taskId: 'T1' })).toMatchObject({ success: false, errorCode: 'NOT_IN_TRASH' });
    const types = (db.prepare("SELECT type FROM events WHERE project_id = 'P1' ORDER BY timestamp, rowid").all() as Array<{ type: string }>).map((r) => r.type);
    expect(types).toEqual(['TASK_TRASHED', 'TASK_RESTORED']);
  });

  it.each(['QUEUED', 'APPROVED', 'DISPATCHED', 'CODING', 'VALIDATING', 'REVIEWING', 'PAUSED', 'BLOCKED'] as TaskState[])(
    'refuses to trash a %s task and changes nothing', (state) => {
      project('P1');
      task('T1', 'P1', state);
      const result = service.trashTask({ taskId: 'T1' });
      expect(result).toMatchObject({ success: false, errorCode: 'HAS_ACTIVE_WORK', blockers: [{ code: 'TASK_ACTIVE_STATE', reference: state }] });
      expect(repo.isTaskTrashed('T1')).toBe(false);
    },
  );

  it('invalidates pending authorizations on trash so restore cannot revive approved work', () => {
    project('P1');
    task('T1', 'P1', 'PLANNED');
    authorization('A1', 'P1', 'T1');

    expect(service.trashTask({ taskId: 'T1' })).toMatchObject({ success: true, invalidatedAuthorizations: 1 });
    expect(authStatus('A1')).toBe('INVALIDATED');
    expect(service.restoreTask({ taskId: 'T1' }).success).toBe(true);
    expect(authStatus('A1')).toBe('INVALIDATED');
  });

  it('blocks trash while an execution is in flight', () => {
    project('P1');
    task('T1', 'P1', 'DONE');
    authorization('A1', 'P1', 'T1', 'DISPATCHED');
    db.prepare("UPDATE execution_authorizations SET adapter_started_at = ? WHERE id = 'A1'").run(NOW);
    expect(service.trashTask({ taskId: 'T1' })).toMatchObject({
      success: false, errorCode: 'HAS_ACTIVE_WORK', blockers: [{ code: 'IN_FLIGHT_EXECUTION', reference: 'A1' }],
    });
  });

  it('trashes a whole project, hides its tasks, and restores it with task-level trash preserved', () => {
    project('P1');
    task('T1', 'P1', 'CREATED');
    task('T2', 'P1', 'DONE');
    authorization('A1', 'P1', 'T1');
    expect(service.trashTask({ taskId: 'T2' }).success).toBe(true);

    expect(service.trashProject({ projectId: 'P1' })).toMatchObject({ success: true, entityType: 'PROJECT', invalidatedAuthorizations: 1 });
    expect(repo.isProjectTrashed('P1')).toBe(true);
    expect(repo.isTaskTrashed('T1')).toBe(true);
    expect(service.trashTask({ taskId: 'T1' })).toMatchObject({ success: false, errorCode: 'ALREADY_IN_TRASH' });
    expect(service.restoreTask({ taskId: 'T2' })).toMatchObject({ success: false, errorCode: 'PROJECT_IN_TRASH' });
    expect(service.listTrash().projects.map((p) => p.id)).toEqual(['P1']);
    expect(repo.getProjectMetadata('P1')).not.toBeNull();

    expect(service.restoreProject({ projectId: 'P1' }).success).toBe(true);
    expect(repo.isTaskTrashed('T1')).toBe(false);
    expect(repo.isTaskTrashed('T2')).toBe(true);
    expect(authStatus('A1')).toBe('INVALIDATED');
  });

  it('refuses to trash a running project or one with active tasks, listing every blocker', () => {
    project('P1', 'RUNNING');
    task('T1', 'P1', 'CODING');
    task('T2', 'P1', 'DONE');
    const result = service.trashProject({ projectId: 'P1' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorCode).toBe('HAS_ACTIVE_WORK');
    expect(result.blockers).toEqual([
      { code: 'PROJECT_RUNNING', reference: 'RUNNING' },
      { code: 'TASK_ACTIVE_STATE', reference: 'CODING', taskId: 'T1' },
    ]);
    expect(repo.isProjectTrashed('P1')).toBe(false);
  });

  it('does not count an approved planning record already in the trash as active work (found in the trial)', () => {
    project('P1', 'PAUSED');
    task('PLAN', 'P1', 'APPROVED');
    repo.insertTrashEntry('TASK', 'PLAN', 'P1', NOW); // The #245 planning record leaves the active list this way.
    task('T1', 'P1', 'PLANNED');
    expect(service.trashProject({ projectId: 'P1' })).toMatchObject({ success: true });
    expect(repo.isProjectTrashed('P1')).toBe(true);
  });

  it('still blocks on live work of a task that is already in the trash', () => {
    project('P1', 'PAUSED');
    task('PLAN', 'P1', 'APPROVED');
    repo.insertTrashEntry('TASK', 'PLAN', 'P1', NOW);
    db.prepare("INSERT INTO task_leases (task_id, agent_id, lease_token, acquired_at, expires_at, heartbeat_at, released_at) VALUES ('PLAN', 'agent-w', 'token-w', ?, ?, ?, NULL)").run(NOW, NOW, NOW);
    const result = service.trashProject({ projectId: 'P1' });
    expect(result).toMatchObject({ success: false, errorCode: 'HAS_ACTIVE_WORK', blockers: [{ code: 'ACTIVE_TASK_LEASE', taskId: 'PLAN' }] });
  });

  it('keeps trash across a database reopen', () => {
    project('P1');
    expect(service.trashProject({ projectId: 'P1' }).success).toBe(true);
    db.close();
    open();
    expect(repo.isProjectTrashed('P1')).toBe(true);
    expect(service.listTrash().projects).toHaveLength(1);
  });

  it('rejects malformed and unknown targets with typed errors', () => {
    expect(service.trashProject({})).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
    expect(service.trashTask({ taskId: 'x', extra: 1 })).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
    expect(service.trashProject({ projectId: 'missing' })).toMatchObject({ success: false, errorCode: 'PROJECT_NOT_FOUND' });
    expect(service.restoreTask({ taskId: 'missing' })).toMatchObject({ success: false, errorCode: 'TASK_NOT_FOUND' });
    expect(service.purgeProject({ projectId: 'missing' })).toMatchObject({ success: false, errorCode: 'PROJECT_NOT_FOUND' });
    expect(service.purgeProject({ projectId: 1 })).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
  });

  describe('a paused project (#344)', () => {
    it('can be trashed although its tasks are PAUSED or waiting for the owner', () => {
      project('P1', 'PAUSED');
      task('T1', 'P1', 'PAUSED');
      task('T2', 'P1', 'NEEDS_HUMAN');
      task('T3', 'P1', 'QUEUED');
      authorization('A1', 'P1', 'T1');
      expect(service.trashProject({ projectId: 'P1' })).toMatchObject({ success: true, entityType: 'PROJECT', invalidatedAuthorizations: 1 });
      expect(repo.isProjectTrashed('P1')).toBe(true);
      expect(authStatus('A1')).toBe('INVALIDATED');
    });

    it('still refuses while a worker holds a lease or an execution is in flight', () => {
      project('P1', 'PAUSED');
      task('T1', 'P1', 'PAUSED');
      task('T2', 'P1', 'CODING');
      db.prepare("INSERT INTO task_leases (task_id, agent_id, lease_token, acquired_at, expires_at, heartbeat_at, released_at) VALUES ('T1', 'agent-w', 'token-w', ?, ?, ?, NULL)").run(NOW, NOW, NOW);
      authorization('A2', 'P1', 'T2', 'DISPATCHED');
      db.prepare("UPDATE execution_authorizations SET adapter_started_at = ? WHERE id = 'A2'").run(NOW);
      expect(service.trashProject({ projectId: 'P1' })).toEqual({
        success: false, errorCode: 'HAS_ACTIVE_WORK', error: 'The project still has active work.',
        blockers: [
          { code: 'ACTIVE_TASK_LEASE', reference: 'T1', taskId: 'T1' },
          { code: 'IN_FLIGHT_EXECUTION', reference: 'A2', taskId: 'T2' },
        ],
      });
      expect(repo.isProjectTrashed('P1')).toBe(false);
    });

    it('keeps the task-level rule: a PAUSED task alone cannot be trashed', () => {
      project('P1', 'PAUSED');
      task('T1', 'P1', 'PAUSED');
      expect(service.trashTask({ taskId: 'T1' })).toMatchObject({ success: false, errorCode: 'HAS_ACTIVE_WORK', blockers: [{ code: 'TASK_ACTIVE_STATE' }] });
    });
  });

  describe('permanent delete of a trashed project (#344)', () => {
    const LEDGERS = new Set([
      'coder_submissions', 'coder_submission_dispositions', 'coder_submission_adjudications',
      'coder_submission_adjudication_events', 'coder_submission_workspace_leases', 'mcp_submission_sessions', 'mcp_reviewer_sessions',
    ]);
    const CORE = new Set(['projects', 'tasks']);

    const counts = () => Object.fromEntries(tableNames(db).map((table) => [table, (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c]));

    /** Every project-side table: one with a project_id/task_id column, or one that references such a table. */
    const projectTables = () => {
      const tables = tableNames(db).filter((table) => !LEDGERS.has(table) && !CORE.has(table) && table !== 'agents');
      const scoped = new Set(tables.filter((table) => columnsOf(db, table).some((column) => column.name === 'project_id' || column.name === 'task_id')));
      for (let grew = true; grew;) {
        grew = false;
        for (const table of tables) {
          if (scoped.has(table)) continue;
          if (foreignKeysOf(db, table).some((fk) => scoped.has(fk.table) || CORE.has(fk.table))) { scoped.add(table); grew = true; }
        }
      }
      return scoped;
    };

    const sharedRows = new Map<string, Record<string, unknown>>();
    const sharedRow = (table: string, scoped: Set<string>): Record<string, unknown> => {
      const existing = sharedRows.get(table);
      if (existing) return existing;
      const values: Record<string, unknown> = {};
      for (const fk of foreignKeysOf(db, table)) {
        if (scoped.has(fk.table) || CORE.has(fk.table) || LEDGERS.has(fk.table) || fk.table === table) continue;
        values[fk.from] = sharedRow(fk.table, scoped)[fk.to ?? primaryKeyOf(db, fk.table)];
      }
      if (table === 'agents') Object.assign(values, { status: 'IDLE', current_task_id: null, removed_at: null });
      const row = insertFixtureRow(db, table, values);
      sharedRows.set(table, row);
      return row;
    };

    /**
     * Builds one row in every project-side table for a project, wired through
     * real foreign keys (including every RESTRICT chain), plus the shared
     * provider/agent rows they point at.
     */
    const buildProjectGraph = (projectId: string) => {
      project(projectId, 'PAUSED');
      const taskId = `${projectId}-T`;
      task(taskId, projectId, 'PAUSED');
      const scoped = projectTables();
      const rows: Record<string, Record<string, unknown>> = {
        projects: db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown>,
        tasks: db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown>,
      };
      const overrides: Record<string, Record<string, unknown>> = {
        task_leases: { released_at: NOW },
        account_leases: { released_at: NOW },
        agent_assignments: { status: 'COMPLETED' },
        execution_authorizations: { status: 'INVALIDATED', adapter_started_at: null, adapter_finished_at: null },
        workspace_trash: { entity_type: 'TASK', entity_id: taskId },
        task_dependencies: { depends_on_task_id: taskId },
      };
      const pending = [...scoped];
      while (pending.length > 0) {
        const ready = pending.findIndex((table) => foreignKeysOf(db, table).every((fk) => {
          if (!scoped.has(fk.table) || rows[fk.table] || fk.table === table) return true;
          const column = columnsOf(db, table).find((candidate) => candidate.name === fk.from);
          return !column?.notnull && !column?.pk;
        }));
        if (ready < 0) throw new Error(`No insert order for: ${pending.join(', ')}`);
        const [table] = pending.splice(ready, 1);
        const columns = columnsOf(db, table).map((column) => column.name);
        if (columns.includes('project_id')) {
          const existing = db.prepare(`SELECT * FROM ${table} WHERE project_id = ?`).get(projectId) as Record<string, unknown> | undefined;
          if (existing) { rows[table] = existing; continue; }
        }
        const values: Record<string, unknown> = {};
        if (columns.includes('project_id')) values.project_id = projectId;
        if (columns.includes('task_id')) values.task_id = taskId;
        for (const fk of foreignKeysOf(db, table)) {
          if (fk.table === table || LEDGERS.has(fk.table)) continue;
          const target = scoped.has(fk.table) || CORE.has(fk.table) ? rows[fk.table] : sharedRow(fk.table, scoped);
          if (target) values[fk.from] = target[fk.to ?? primaryKeyOf(db, fk.table)];
        }
        rows[table] = insertFixtureRow(db, table, { ...values, ...overrides[table] });
      }
      expect(db.pragma('foreign_key_check')).toEqual([]);
      return { taskId, rows, scoped };
    };

    /** Rows anywhere whose project_id or *task_id column names the project or one of its tasks. */
    const referencesTo = (projectId: string, taskIds: string[]) => {
      const hits: string[] = [];
      for (const table of tableNames(db)) {
        for (const column of columnsOf(db, table)) {
          if (column.name === 'project_id') {
            const c = (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE project_id = ?`).get(projectId) as { c: number }).c;
            if (c > 0) hits.push(`${table}.project_id`);
          } else if (column.name.endsWith('task_id') && taskIds.length > 0) {
            const c = (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE "${column.name}" IN (${taskIds.map(() => '?').join(', ')})`).get(...taskIds) as { c: number }).c;
            if (c > 0) hits.push(`${table}.${column.name}`);
          }
        }
      }
      return hits;
    };

    beforeEach(() => {
      sharedRows.clear();
      new ProjectStopFenceService(repo); // Creates the runtime project_stop_admissions table, so the purge must cover it.
    });

    it('erases every row of the project and its tasks, and nothing of another project', () => {
      buildProjectGraph('P2');
      const before = counts();
      const { taskId, scoped } = buildProjectGraph('P1');
      expect(scoped.has('execution_recovery_states')).toBe(true);
      expect(scoped.has('mcp_client_sessions')).toBe(true);
      expect(scoped.has('project_stop_admissions')).toBe(true);
      expect(referencesTo('P1', [taskId]).length).toBeGreaterThan(20);
      repo.insertTrashEntry('PROJECT', 'P1', 'P1', NOW);

      expect(service.purgeProject({ projectId: 'P1' })).toEqual({ success: true, entityType: 'PROJECT', entityId: 'P1', invalidatedAuthorizations: 0 });
      expect(referencesTo('P1', [taskId])).toEqual([]);
      expect(db.prepare("SELECT COUNT(*) AS c FROM workspace_trash WHERE entity_id IN ('P1', ?)").get(taskId)).toEqual({ c: 0 });
      expect(counts()).toEqual(before);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(repo.getProjectMetadata('P2')).not.toBeNull();
      expect(service.listTrash().projects).toEqual([]);
      expect(service.purgeProject({ projectId: 'P1' })).toMatchObject({ success: false, errorCode: 'PROJECT_NOT_FOUND' });
    });

    it('refuses a project that is not in the trash and changes nothing', () => {
      buildProjectGraph('P1');
      const before = counts();
      expect(service.purgeProject({ projectId: 'P1' })).toMatchObject({ success: false, errorCode: 'NOT_IN_TRASH' });
      expect(counts()).toEqual(before);
    });

    it('re-checks live work before deleting', () => {
      const { taskId } = buildProjectGraph('P1');
      repo.insertTrashEntry('PROJECT', 'P1', 'P1', NOW);
      db.prepare('UPDATE task_leases SET released_at = NULL WHERE task_id = ?').run(taskId);
      const before = counts();
      expect(service.purgeProject({ projectId: 'P1' })).toMatchObject({
        success: false, errorCode: 'HAS_ACTIVE_WORK', blockers: [{ code: 'ACTIVE_TASK_LEASE', taskId }],
      });
      expect(counts()).toEqual(before);
    });

    it.each(['coder_submissions', 'mcp_submission_sessions'])('refuses a project with a %s audit row and leaves everything in place', (ledger) => {
      const { taskId, rows } = buildProjectGraph('P1');
      repo.insertTrashEntry('PROJECT', 'P1', 'P1', NOW);
      const values: Record<string, unknown> = { authorization_id: rows.execution_authorizations.id };
      if (ledger === 'coder_submissions') {
        Object.assign(values, {
          project_id: 'P1', task_id: taskId, attempt_id: rows.task_attempts.id, assignment_id: rows.agent_assignments.id,
          session_id: insertFixtureRow(db, 'mcp_submission_sessions', { authorization_id: rows.execution_authorizations.id }).id,
        });
      }
      insertFixtureRow(db, ledger, values);
      const before = counts();

      expect(service.purgeProject({ projectId: 'P1' })).toMatchObject({ success: false, errorCode: 'PROJECT_HAS_AUDIT_LEDGER' });
      expect(counts()).toEqual(before);
      expect(repo.isProjectTrashed('P1')).toBe(true);
    });
  });
});
