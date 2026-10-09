import Database from 'better-sqlite3';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository, ProjectRepository } from '../src/core/database/repositories';
import { Project, ProjectContract } from '../src/core/types/domain';
import { captureRepositoryRoot } from '../src/core/services/RepositoryRootIdentity';
import { ProjectService } from '../src/core/services/ProjectService';
import { EventService } from '../src/core/services/EventService';
import { EmergencyStopService } from '../src/core/services/EmergencyStopService';
import { ProcessRunner } from '../src/core/services/ProcessRunner';

describe('ProjectRepository extraction contract', () => {
  let db: Database.Database | undefined;
  const fixtures: string[] = [];

  afterEach(() => {
    db?.close();
    db = undefined;
    vi.restoreAllMocks();
    for (const fixture of fixtures.splice(0)) {
      if (fs.realpathSync.native(fixture) !== fixture || !path.basename(fixture).startsWith('af-project-root-')) throw new Error('FIXTURE_BOUNDARY_CHANGED');
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  function fixtureRoot(): { fixture: string; root: string } {
    const fixture = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-project-root-')));
    fixtures.push(fixture);
    const root = path.join(fixture, 'repository'); fs.mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore', windowsHide: true });
    fs.writeFileSync(path.join(root, 'sentinel'), 'selected-owner');
    return { fixture, root };
  }

  function services(databasePath = ':memory:') {
    db = new Database(databasePath); db.pragma('foreign_keys = ON'); MigrationRunner.run(db);
    const repository = new Repository(db);
    const events = new EventService(repository);
    return { repository, events, projects: new ProjectService(repository, events) };
  }

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

  it('persists the selected component identities atomically and validates them after database restart', () => {
    const { fixture, root } = fixtureRoot();
    const databasePath = path.join(fixture, 'project.sqlite');
    const identity = captureRepositoryRoot(root);
    const first = services(databasePath);
    const project = first.projects.createProject('Selected repository', 'Identity fixture', root, 'main', identity);
    expect(first.repository.getProjectRepositoryIdentity(project.id)).toEqual(identity);
    expect(first.repository.getEvents(project.id).map(event => event.type)).toContain('PROJECT_CREATED');
    db!.close(); db = undefined;
    const restarted = services(databasePath);
    expect(restarted.repository.getProject(project.id)).toEqual(project);
    expect(restarted.repository.getProjectRepositoryIdentity(project.id)).toEqual(identity);
    expect(db!.prepare('SELECT COUNT(*) AS count FROM project_repository_identities').get()).toEqual({ count: 1 });
  });

  it('retains a stale bound project for display but rejects its replacement root after restart', () => {
    const { fixture, root } = fixtureRoot();
    const databasePath = path.join(fixture, 'project.sqlite');
    const first = services(databasePath);
    const project = first.projects.createProject('Selected repository', 'Identity fixture', root, 'main', captureRepositoryRoot(root));
    db!.close(); db = undefined;
    fs.renameSync(root, root + '-original'); fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'sentinel'), 'replacement-owner');
    const restarted = services(databasePath);
    expect(() => restarted.repository.getProject(project.id)).toThrow('REPOSITORY_ROOT_IDENTITY_CHANGED');
    expect(() => restarted.repository.getProjectRepositoryIdentity(project.id)).toThrow('REPOSITORY_ROOT_IDENTITY_CHANGED');
    expect(restarted.repository.getAllProjects()).toEqual([project]);
    expect(fs.readFileSync(path.join(root + '-original', 'sentinel'), 'utf8')).toBe('selected-owner');
    expect(fs.readFileSync(path.join(root, 'sentinel'), 'utf8')).toBe('replacement-owner');
  });

  it('does not persist a project, root receipt or creation event from a stale native selection', () => {
    const { root } = fixtureRoot();
    const identity = captureRepositoryRoot(root);
    fs.renameSync(root, root + '-original'); fs.mkdirSync(root);
    const current = services();
    expect(() => current.projects.createProject('Stale selected root', '', root, 'main', identity)).toThrow('REPOSITORY_ROOT_IDENTITY_CHANGED');
    for (const table of ['projects', 'project_repository_identities', 'events']) {
      expect(db!.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(fs.readFileSync(path.join(root + '-original', 'sentinel'), 'utf8')).toBe('selected-owner');
  });

  it('rolls the bound project and receipt back when its durable creation event fails', () => {
    const { root } = fixtureRoot();
    const current = services();
    vi.spyOn(current.events, 'record').mockImplementationOnce(() => { throw new Error('INJECTED_EVENT_FAILURE'); });
    expect(() => current.projects.createProject('Failed event', '', root, 'main', captureRepositoryRoot(root))).toThrow('INJECTED_EVENT_FAILURE');
    for (const table of ['projects', 'project_repository_identities', 'events']) {
      expect(db!.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it('holds selected root authority through the real project, receipt and event transaction', () => {
    const { root } = fixtureRoot();
    const current = services();
    const record = current.events.record.bind(current.events);
    let reached = false;
    vi.spyOn(current.events, 'record').mockImplementationOnce((...args) => {
      reached = true;
      if (process.platform === 'win32') expect(() => fs.renameSync(root, root + '-original')).toThrow();
      else { fs.renameSync(root, root + '-original'); fs.mkdirSync(root); }
      return record(...args);
    });
    const create = () => current.projects.createProject('Pinned transaction', 'Authority fixture', root, 'main', captureRepositoryRoot(root));
    if (process.platform === 'win32') {
      const project = create();
      expect(current.repository.getProjectRepositoryIdentity(project.id).canonicalPath).toBe(root);
      expect(current.repository.getEvents(project.id).map(event => event.type)).toContain('PROJECT_CREATED');
      fs.renameSync(root, root + '-original');
      expect(fs.readFileSync(path.join(root + '-original', 'sentinel'), 'utf8')).toBe('selected-owner');
    } else {
      expect(create).toThrow('REPOSITORY_ROOT_IDENTITY_CHANGED');
      for (const table of ['projects', 'project_repository_identities', 'events']) {
        expect(db!.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
    }
    expect(reached).toBe(true);
  });

  it('does not adopt a historical metadata path without a selected identity', () => {
    const { root } = fixtureRoot();
    const current = services();
    const metadata = current.projects.createProject('Unbound metadata', 'Metadata fixture', root);
    expect(current.repository.getProject(metadata.id)).toEqual(metadata);
    expect(() => current.repository.getProjectRepositoryIdentity(metadata.id)).toThrow('REPOSITORY_ROOT_UNBOUND');
    expect(db!.prepare('SELECT COUNT(*) AS count FROM project_repository_identities').get()).toEqual({ count: 0 });
  });

  it('rejects corrupted durable root evidence instead of acquiring the current path', () => {
    const { root } = fixtureRoot();
    const current = services();
    const project = current.projects.createProject('Bound evidence', '', root, 'main', captureRepositoryRoot(root));
    db!.prepare('UPDATE project_repository_identities SET identity_json=? WHERE project_id=?').run('{broken', project.id);
    expect(() => current.repository.getProject(project.id)).toThrow('REPOSITORY_ROOT_IDENTITY_UNAVAILABLE');
    expect(() => current.repository.getProjectRepositoryIdentity(project.id)).toThrow('REPOSITORY_ROOT_IDENTITY_UNAVAILABLE');
    expect(fs.readFileSync(path.join(root, 'sentinel'), 'utf8')).toBe('selected-owner');
  });

  it('explicitly binds a historical inactive project without changing its metadata and is idempotent after restart', () => {
    const { fixture, root } = fixtureRoot();
    const databasePath = path.join(fixture, 'binding.sqlite');
    const current = services(databasePath);
    const project = current.projects.createProject('Historical project', 'Original metadata', root);
    const identity = captureRepositoryRoot(root);
    expect(() => current.repository.getProjectRepositoryIdentity(project.id)).toThrow('REPOSITORY_ROOT_UNBOUND');
    expect(current.projects.bindRepository(project.id, identity)).toEqual(project);
    expect(current.repository.getProjectRepositoryIdentity(project.id)).toEqual(identity);
    expect(current.repository.getEvents(project.id).filter(event => event.type === 'PROJECT_REPOSITORY_BOUND')).toHaveLength(1);
    db!.close(); db = undefined;
    const restarted = services(databasePath);
    expect(restarted.projects.bindRepository(project.id, captureRepositoryRoot(root))).toEqual(project);
    expect(restarted.repository.getEvents(project.id).filter(event => event.type === 'PROJECT_REPOSITORY_BOUND')).toHaveLength(1);
    expect(restarted.repository.getProject(project.id)).toEqual(project);
  });

  it('rejects a different selected folder and does not retarget a historical project', () => {
    const { root } = fixtureRoot(); const other = fixtureRoot().root;
    const current = services();
    const project = current.projects.createProject('Configured folder', 'Original metadata', root);
    const events = current.repository.getEvents(project.id);
    expect(() => current.projects.bindRepository(project.id, captureRepositoryRoot(other))).toThrow('REPOSITORY_ROOT_IDENTITY_CHANGED');
    expect(current.repository.getProjectMetadata(project.id)).toEqual(project);
    expect(current.repository.getEvents(project.id)).toEqual(events);
    expect(() => current.repository.getProjectRepositoryIdentity(project.id)).toThrow('REPOSITORY_ROOT_UNBOUND');
  });

  it('cannot overwrite a persisted identity with a new native selection of its replacement', () => {
    const { root } = fixtureRoot();
    const current = services();
    const project = current.projects.createProject('Immutable binding', 'Original metadata', root, 'main', captureRepositoryRoot(root));
    const receipt = db!.prepare('SELECT * FROM project_repository_identities WHERE project_id=?').get(project.id);
    const events = current.repository.getEvents(project.id);
    fs.renameSync(root, root + '-original'); fs.mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore', windowsHide: true });
    expect(() => current.projects.bindRepository(project.id, captureRepositoryRoot(root))).toThrow('REPOSITORY_ROOT_IDENTITY_CHANGED');
    expect(db!.prepare('SELECT * FROM project_repository_identities WHERE project_id=?').get(project.id)).toEqual(receipt);
    expect(current.repository.getEvents(project.id)).toEqual(events);
    expect(current.repository.getProjectMetadata(project.id)).toEqual(project);
  });

  it('rolls back first binding when its audit event fails', () => {
    const { root } = fixtureRoot();
    const current = services();
    const project = current.projects.createProject('Binding audit', 'Original metadata', root);
    const events = current.repository.getEvents(project.id);
    vi.spyOn(current.events, 'record').mockImplementationOnce(() => { throw new Error('INJECTED_BINDING_AUDIT_FAILURE'); });
    expect(() => current.projects.bindRepository(project.id, captureRepositoryRoot(root))).toThrow('INJECTED_BINDING_AUDIT_FAILURE');
    expect(current.repository.getEvents(project.id)).toEqual(events);
    expect(() => current.repository.getProjectRepositoryIdentity(project.id)).toThrow('REPOSITORY_ROOT_UNBOUND');
    expect(current.repository.getProjectMetadata(project.id)).toEqual(project);
  });

  it('holds the native root through binding audit and final transaction commit', () => {
    const { root } = fixtureRoot();
    const current = services();
    const project = current.projects.createProject('Binding race', 'Original metadata', root);
    const record = current.events.record.bind(current.events);
    let reached = false;
    vi.spyOn(current.events, 'record').mockImplementationOnce((...args) => {
      reached = true;
      if (process.platform === 'win32') expect(() => fs.renameSync(root, root + '-original')).toThrow();
      else { fs.renameSync(root, root + '-original'); fs.mkdirSync(root); }
      return record(...args);
    });
    const bind = () => current.projects.bindRepository(project.id, captureRepositoryRoot(root));
    if (process.platform === 'win32') {
      expect(bind()).toEqual(project);
      expect(current.repository.getProjectRepositoryIdentity(project.id).canonicalPath).toBe(root);
      fs.renameSync(root, root + '-released');
    } else {
      expect(bind).toThrow('REPOSITORY_ROOT_IDENTITY_CHANGED');
      expect(() => current.repository.getProjectRepositoryIdentity(project.id)).toThrow('REPOSITORY_ROOT_UNBOUND');
      expect(current.repository.getEvents(project.id).filter(event => event.type === 'PROJECT_REPOSITORY_BOUND')).toHaveLength(0);
    }
    expect(reached).toBe(true);
  });

  it('blocks initial binding of active projects and preserves terminal execution history', () => {
    const { root } = fixtureRoot();
    const current = services();
    const project = current.projects.createProject('Execution history', 'Original metadata', root);
    const identity = captureRepositoryRoot(root);
    current.repository.updateProjectStatus(project.id, 'RUNNING');
    expect(() => current.projects.bindRepository(project.id, identity)).toThrow('REPOSITORY_ROOT_BINDING_BLOCKED');
    current.repository.updateProjectStatus(project.id, 'READY');
    db!.prepare(`INSERT INTO process_runs (id, project_id, command, working_directory, status, start_time, end_time, exit_code, created_at)
      VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?, 0, ?)`).run('old-process', project.id, 'git status', root, project.created_at, project.created_at, project.created_at);
    const history = current.repository.getProcessRun('old-process');
    expect(() => current.projects.bindRepository(project.id, identity)).toThrow('REPOSITORY_ROOT_BINDING_BLOCKED');
    expect(current.repository.getProcessRun('old-process')).toEqual(history);
    expect(() => current.repository.getProjectRepositoryIdentity(project.id)).toThrow('REPOSITORY_ROOT_UNBOUND');
    expect(current.repository.getEvents(project.id).filter(event => event.type === 'PROJECT_REPOSITORY_BOUND')).toHaveLength(0);
  });

  it('keeps the real durable Emergency Stop latch and audit available after a bound root replacement', async () => {
    const { root } = fixtureRoot();
    const current = services();
    const project = current.projects.createProject('Stale root stop', 'Stop fixture', root, 'main', captureRepositoryRoot(root));
    current.repository.updateProjectStatus(project.id, 'RUNNING');
    fs.renameSync(root, root + '-original'); fs.mkdirSync(root);
    expect(() => current.repository.getProject(project.id)).toThrow('REPOSITORY_ROOT_IDENTITY_CHANGED');
    // Isolate the fixture from unrelated host processes. Durable stop and audit
    // use the actual services/SQLite; no process-termination proof is inferred.
    vi.spyOn(ProcessRunner, 'terminateAllProcesses').mockResolvedValue({ count: 0, unproven: 0, allTerminatedProven: true });
    const stop = new EmergencyStopService(current.repository, current.events);
    const result = await stop.triggerEmergencyStop('Stale root fixture stop');
    expect(result.projectsPaused).toContain(project.id);
    expect(stop.getStopFence(project.id)).toMatchObject({ latched: true, epoch: 1, projectStatus: 'PAUSED' });
    expect(current.repository.getProjectMetadata(project.id)?.status).toBe('PAUSED');
    expect(current.repository.getEvents(project.id).map(event => event.type)).toContain('EMERGENCY_STOP');
    expect(() => current.repository.getProjectRepositoryIdentity(project.id)).toThrow('REPOSITORY_ROOT_IDENTITY_CHANGED');
  });
});
