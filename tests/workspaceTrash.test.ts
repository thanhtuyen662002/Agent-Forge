import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { WorkspaceManagementService } from '../src/core/services/WorkspaceManagementService';
import type { TaskState } from '../src/core/types/domain';

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
  });
});
