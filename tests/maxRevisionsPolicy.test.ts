import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { EventService } from '../src/core/services/EventService';
import { TaskService } from '../src/core/services/TaskService';
import {
  GetMaxRevisionsIpcSchema,
  SaveMaxRevisionsIpcSchema,
} from '../src/core/types/ipc';
import {
  DEFAULT_MAX_REVISIONS,
  MAX_MAX_REVISIONS,
  MIN_MAX_REVISIONS,
  parseMaxRevisions,
} from '../src/shared/revisionPolicy';
import { Project } from '../src/core/types/domain';

function project(id: string): Project {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    description: null,
    repository_path: `C:\\repos\\${id}`,
    default_branch: 'main',
    status: 'READY',
    contract: null,
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
  };
}

describe('project max-revisions policy', () => {
  it('accepts only finite whole values inside the product bounds', () => {
    expect(parseMaxRevisions('1')).toBe(MIN_MAX_REVISIONS);
    expect(parseMaxRevisions(String(MAX_MAX_REVISIONS))).toBe(MAX_MAX_REVISIONS);
    expect(parseMaxRevisions('')).toBeNull();
    expect(parseMaxRevisions('2.5')).toBeNull();
    expect(parseMaxRevisions('-1')).toBeNull();
    expect(parseMaxRevisions('11')).toBeNull();
    expect(parseMaxRevisions('Infinity')).toBeNull();
    expect(parseMaxRevisions(Number.NaN)).toBeNull();
  });

  it('rejects invalid IPC values before persistence', () => {
    expect(GetMaxRevisionsIpcSchema.safeParse({ projectId: 'p1' }).success).toBe(true);
    for (const maxRevisions of [0, -1, 2.5, 11, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(SaveMaxRevisionsIpcSchema.safeParse({ projectId: 'p1', maxRevisions }).success).toBe(false);
    }
    expect(SaveMaxRevisionsIpcSchema.safeParse({ projectId: 'p1', maxRevisions: 4 }).success).toBe(true);
    expect(SaveMaxRevisionsIpcSchema.safeParse({ projectId: 'p1', maxRevisions: '4' }).success).toBe(false);
  });

  it('round-trips per-project settings and leaves the previous value unchanged on invalid input', () => {
    const db = new Database(':memory:');
    MigrationRunner.run(db);
    const repo = new Repository(db);
    repo.createProject(project('PROJECT-A'));
    repo.createProject(project('PROJECT-B'));

    expect(repo.getProjectMaxRevisions('PROJECT-A')).toBe(DEFAULT_MAX_REVISIONS);
    expect(repo.getProjectMaxRevisions('PROJECT-B')).toBe(DEFAULT_MAX_REVISIONS);
    expect(repo.setProjectMaxRevisions('PROJECT-A', 7)).toBe(7);
    expect(repo.getProjectMaxRevisions('PROJECT-A')).toBe(7);
    expect(repo.getProjectMaxRevisions('PROJECT-B')).toBe(DEFAULT_MAX_REVISIONS);

    expect(() => repo.setProjectMaxRevisions('PROJECT-A', 2.5)).toThrow(/MAX_REVISIONS_INVALID/);
    expect(() => repo.setProjectMaxRevisions('PROJECT-A', 99)).toThrow(/MAX_REVISIONS_INVALID/);
    expect(repo.getProjectMaxRevisions('PROJECT-A')).toBe(7);
    expect(() => repo.setProjectMaxRevisions('MISSING', 4)).toThrow(/not found/i);

    db.prepare(
      "UPDATE project_settings SET value_json = ? WHERE project_id = ? AND key = 'max_revisions'",
    ).run(JSON.stringify(999), 'PROJECT-A');
    expect(repo.getProjectMaxRevisions('PROJECT-A')).toBe(DEFAULT_MAX_REVISIONS);
    db.close();
  });

  it('uses the persisted project policy when creating new tasks', () => {
    const db = new Database(':memory:');
    MigrationRunner.run(db);
    const repo = new Repository(db);
    repo.createProject(project('PROJECT-A'));
    repo.createProject(project('PROJECT-B'));
    repo.setProjectMaxRevisions('PROJECT-A', 8);

    const taskService = new TaskService(repo, new EventService(repo));
    expect(taskService.createTask({ projectId: 'PROJECT-A', title: 'Uses saved policy' }).max_revisions).toBe(8);
    expect(taskService.createTask({ projectId: 'PROJECT-B', title: 'Uses default policy' }).max_revisions).toBe(
      DEFAULT_MAX_REVISIONS,
    );
    db.close();
  });
});
