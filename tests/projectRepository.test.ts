import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository, ProjectRepository } from '../src/core/database/repositories';
import { Project, ProjectContract } from '../src/core/types/domain';

describe('ProjectRepository extraction contract', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('preserves project CRUD mapping, ordering, JSON contract, and status timestamps', () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);

    const facade = new Repository(db);
    const extracted = new ProjectRepository(db);
    const contract: ProjectContract = {
      goal: 'prove project persistence extraction',
      architecture_constraints: ['same sqlite handle'],
      technical_constraints: ['no schema changes'],
      security_requirements: ['preserve authorization boundaries'],
      acceptance_criteria: ['facade behavior remains stable'],
      non_goals: ['migration rewrite'],
      definition_of_done: ['focused test passes'],
      testing_requirements: ['typecheck'],
      owner_policies: ['manual release'],
    };
    const older: Project = {
      id: 'project-older',
      name: 'Older project',
      description: null,
      repository_path: 'C:/projects/older',
      default_branch: 'main',
      status: 'DRAFT',
      contract: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      started_at: null,
      completed_at: null,
    };
    const newer: Project = {
      id: 'project-newer',
      name: 'Newer project',
      description: 'contract round-trip',
      repository_path: 'C:/projects/newer',
      default_branch: 'main',
      status: 'READY',
      contract,
      created_at: '2026-02-01T00:00:00.000Z',
      updated_at: '2026-02-01T00:00:00.000Z',
      started_at: null,
      completed_at: null,
    };

    facade.createProject(older);
    extracted.createProject(newer);

    expect(facade.getProject(older.id)).toEqual(older);
    expect(extracted.getProject(newer.id)).toEqual(newer);
    expect(facade.getProject('missing-project')).toBeNull();
    expect(facade.getAllProjects().map((project) => project.id)).toEqual(['project-newer', 'project-older']);

    const rolledBack: Project = {
      ...older,
      id: 'project-rolled-back',
      name: 'Rolled-back project',
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:00:00.000Z',
    };
    expect(() =>
      facade.runInTransaction(() => {
        facade.createProject(rolledBack);
        throw new Error('rollback project transaction');
      })
    ).toThrow('rollback project transaction');
    expect(facade.getProject(rolledBack.id)).toBeNull();

    facade.updateProjectStatus(newer.id, 'RUNNING', '2026-02-02T10:00:00.000Z');
    const running = extracted.getProject(newer.id)!;
    expect(running.status).toBe('RUNNING');
    expect(running.started_at).toBe('2026-02-02T10:00:00.000Z');
    expect(running.completed_at).toBeNull();
    expect(running.updated_at).not.toBe(newer.updated_at);

    extracted.updateProjectStatus(newer.id, 'COMPLETED', undefined, '2026-02-03T10:00:00.000Z');
    const completed = facade.getProject(newer.id)!;
    expect(completed.status).toBe('COMPLETED');
    expect(completed.started_at).toBe('2026-02-02T10:00:00.000Z');
    expect(completed.completed_at).toBe('2026-02-03T10:00:00.000Z');

    const replacementContract = { ...contract, goal: 'updated goal' };
    facade.updateProjectContract(newer.id, replacementContract);
    expect(extracted.getProject(newer.id)!.contract).toEqual(replacementContract);
  });
});
