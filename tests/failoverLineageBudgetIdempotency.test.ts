import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MigrationRunner, MIGRATIONS } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { FailoverLineageService } from '../src/core/services/FailoverLineageService';
import { Task, Project, TaskAttempt } from '../src/core/types/domain';

function createInMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  MigrationRunner.run(db);
  return db;
}

function safeRmDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {}
}

function seedBaseProjectAndTask(
  repo: Repository,
  db: Database.Database,
  taskId = 'task-1',
  projectId = 'project-1'
): { project: Project; task: Task } {
  const existingProject = repo.getProject(projectId);
  let project: Project;
  if (existingProject) {
    project = existingProject;
  } else {
    project = {
      id: projectId,
      name: 'Test Project ' + projectId,
      description: 'Test Description',
      repository_path: '/repo/test',
      default_branch: 'main',
      status: 'READY',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    };
    repo.createProject(project);
  }

  const task: Task = {
    id: taskId,
    project_id: project.id,
    milestone_id: null,
    title: 'Test Task ' + taskId,
    description: 'Task Description',
    state: 'APPROVED',
    paused_from_state: null,
    priority: 'HIGH',
    risk: 'HIGH',
    assigned_agent_id: null,
    revision_count: 1,
    max_revisions: 3,
    base_sha: '8cec7fcbe9edb51a7e3e03d7205eb5da425fb697',
    current_sha: '8cec7fcbe9edb51a7e3e03d7205eb5da425fb697',
    progress_cache_percent: 0.0,
    progress_computed_at: null,
    acceptance_criteria: ['Test Criteria'],
    constraints: ['Test Constraints'],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  repo.createTask(task);

  return { project, task };
}

function rawInsertTransition(
  database: Database.Database,
  t: {
    id: string;
    task_id: string;
    root_attempt_id: string;
    source_attempt_id: string;
    successor_attempt_id: string;
    failover_ordinal: number;
    created_at?: string;
  }
): void {
  database
    .prepare(`
      INSERT INTO failover_transitions (
        id, task_id, root_attempt_id, source_attempt_id, successor_attempt_id, failover_ordinal, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      t.id,
      t.task_id,
      t.root_attempt_id,
      t.source_attempt_id,
      t.successor_attempt_id,
      t.failover_ordinal,
      t.created_at ?? new Date().toISOString()
    );
}

describe('Failover Lineage, Budget, and Idempotency Contract (R5H4)', () => {
  let db: Database.Database;
  let repo: Repository;
  let service: FailoverLineageService;

  beforeEach(() => {
    db = createInMemoryDb();
    repo = new Repository(db);
    service = new FailoverLineageService(repo);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  // =========================================================================
  // 1. Migration 10 & Schema Uniqueness
  // =========================================================================
  describe('Migration 10 & Schema Uniqueness', () => {
    it('1. applies migration 10 and creates failover_transitions table with expected indexes', () => {
      const tableInfo = db.prepare(`PRAGMA table_info(failover_transitions)`).all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
      const columnNames = tableInfo.map((c) => c.name);

      expect(columnNames).toContain('id');
      expect(columnNames).toContain('task_id');
      expect(columnNames).toContain('root_attempt_id');
      expect(columnNames).toContain('source_attempt_id');
      expect(columnNames).toContain('successor_attempt_id');
      expect(columnNames).toContain('failover_ordinal');
      expect(columnNames).toContain('created_at');

      const indexList = db.prepare(`PRAGMA index_list(failover_transitions)`).all() as Array<{ name: string; unique: number }>;
      const indexNames = indexList.map((i) => i.name);
      expect(indexNames).toContain('idx_failover_transitions_task');
    });

    it('2. creates unique index on task_attempts(task_id, attempt_number)', () => {
      const indexList = db.prepare(`PRAGMA index_list(task_attempts)`).all() as Array<{ name: string; unique: number }>;
      const uniqueIdx = indexList.find((i) => i.name === 'idx_task_attempts_task_number_unique');
      expect(uniqueIdx).toBeDefined();
      expect(uniqueIdx?.unique).toBe(1);
    });

    it('3. fails closed if migration 10 encounters legacy duplicate attempt numbers', () => {
      const rawDb = new Database(':memory:');
      rawDb.pragma('foreign_keys = ON');

      // Run migrations 1 through 9 manually
      for (const migration of MIGRATIONS.slice(0, 9)) {
        rawDb.transaction(() => {
          migration.up(rawDb);
        })();
      }

      // Seed project, task, and DUPLICATE task_attempts with attempt_number = 1
      rawDb.prepare(`
        INSERT INTO projects (id, name, description, repository_path, default_branch, status, created_at, updated_at)
        VALUES ('p1', 'P1', 'Desc', '/repo', 'main', 'READY', '2026-08-26T00:00:00Z', '2026-08-26T00:00:00Z')
      `).run();

      rawDb.prepare(`
        INSERT INTO tasks (id, project_id, title, description, state, priority, risk, created_at, updated_at)
        VALUES ('t1', 'p1', 'T1', 'Desc', 'APPROVED', 'HIGH', 'HIGH', '2026-08-26T00:00:00Z', '2026-08-26T00:00:00Z')
      `).run();

      rawDb.prepare(`
        INSERT INTO task_attempts (id, task_id, attempt_number, agent_id, status, started_at)
        VALUES ('att-1', 't1', 1, 'agent-1', 'FAILED', '2026-08-26T00:00:00Z')
      `).run();

      rawDb.prepare(`
        INSERT INTO task_attempts (id, task_id, attempt_number, agent_id, status, started_at)
        VALUES ('att-2', 't1', 1, 'agent-1', 'FAILED', '2026-08-26T00:01:00Z')
      `).run();

      // Now run migration 10 and expect bounded fail-closed error
      const migration10 = MIGRATIONS.find((m) => m.version === 10)!;
      expect(() => {
        rawDb.transaction(() => {
          migration10.up(rawDb);
        })();
      }).toThrow(/Cannot apply unique index on task_attempts.*duplicate attempt_number 1/);

      rawDb.close();
    });

    it('3b. preserves valid historical TaskAttempt attempt_number values without renumbering or row replacement', () => {
      const rawDb = new Database(':memory:');
      rawDb.pragma('foreign_keys = ON');

      // Run migrations 1 through 9 manually
      for (const migration of MIGRATIONS.slice(0, 9)) {
        rawDb.transaction(() => {
          migration.up(rawDb);
        })();
      }

      // Seed project and task
      rawDb.prepare(`
        INSERT INTO projects (id, name, description, repository_path, default_branch, status, created_at, updated_at)
        VALUES ('p-hist', 'Historical Project', 'Desc', '/repo', 'main', 'READY', '2026-08-26T00:00:00Z', '2026-08-26T00:00:00Z')
      `).run();

      rawDb.prepare(`
        INSERT INTO tasks (id, project_id, title, description, state, priority, risk, created_at, updated_at)
        VALUES ('t-hist', 'p-hist', 'Historical Task', 'Desc', 'APPROVED', 'HIGH', 'HIGH', '2026-08-26T00:00:00Z', '2026-08-26T00:00:00Z')
      `).run();

      // Seed valid historical attempts with distinct non-sequential attempt_numbers: 1, 4, 9
      const historicalAttempts = [
        { id: 'att-hist-1', task_id: 't-hist', attempt_number: 1, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:01:00Z' },
        { id: 'att-hist-4', task_id: 't-hist', attempt_number: 4, agent_id: 'agent-2', status: 'FAILED', started_at: '2026-08-26T00:04:00Z' },
        { id: 'att-hist-9', task_id: 't-hist', attempt_number: 9, agent_id: 'agent-3', status: 'COMPLETED', started_at: '2026-08-26T00:09:00Z' },
      ];

      for (const a of historicalAttempts) {
        rawDb.prepare(`
          INSERT INTO task_attempts (id, task_id, attempt_number, agent_id, status, started_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(a.id, a.task_id, a.attempt_number, a.agent_id, a.status, a.started_at);
      }

      // Run migration 10
      const migration10 = MIGRATIONS.find((m) => m.version === 10)!;
      rawDb.transaction(() => {
        migration10.up(rawDb);
      })();

      // Verify all rows are intact, untampered, and identical
      const rowsAfter = rawDb.prepare(`SELECT * FROM task_attempts WHERE task_id = 't-hist' ORDER BY attempt_number ASC`).all() as Array<{
        id: string;
        task_id: string;
        attempt_number: number;
        agent_id: string;
        status: string;
        started_at: string;
      }>;

      expect(rowsAfter).toHaveLength(3);
      expect(rowsAfter.map((r) => r.attempt_number)).toEqual([1, 4, 9]);
      expect(rowsAfter[0].id).toBe('att-hist-1');
      expect(rowsAfter[0].agent_id).toBe('agent-1');
      expect(rowsAfter[0].status).toBe('FAILED');
      expect(rowsAfter[1].id).toBe('att-hist-4');
      expect(rowsAfter[1].agent_id).toBe('agent-2');
      expect(rowsAfter[1].status).toBe('FAILED');
      expect(rowsAfter[2].id).toBe('att-hist-9');
      expect(rowsAfter[2].agent_id).toBe('agent-3');
      expect(rowsAfter[2].status).toBe('COMPLETED');

      rawDb.close();
    });

    it('4. enforces DB-level uniqueness on source_attempt_id and successor_attempt_id in failover_transitions', () => {
      seedBaseProjectAndTask(repo, db, 'task-1');
      repo.createTaskAttempt({
        id: 'att-1',
        task_id: 'task-1',
        attempt_number: 1,
        agent_id: 'agent-1',
        status: 'FAILED',
        started_at: new Date().toISOString(),
        ended_at: null,
        summary: null,
      });
      repo.createTaskAttempt({
        id: 'att-2',
        task_id: 'task-1',
        attempt_number: 2,
        agent_id: 'agent-1',
        status: 'RUNNING',
        started_at: new Date().toISOString(),
        ended_at: null,
        summary: null,
      });
      repo.createTaskAttempt({
        id: 'att-3',
        task_id: 'task-1',
        attempt_number: 3,
        agent_id: 'agent-1',
        status: 'RUNNING',
        started_at: new Date().toISOString(),
        ended_at: null,
        summary: null,
      });

      rawInsertTransition(db, {
        id: 'ft-1',
        task_id: 'task-1',
        root_attempt_id: 'att-1',
        source_attempt_id: 'att-1',
        successor_attempt_id: 'att-2',
        failover_ordinal: 1,
        created_at: new Date().toISOString(),
      });

      // Attempt duplicate source_attempt_id
      expect(() => {
        rawInsertTransition(db, {
          id: 'ft-2',
          task_id: 'task-1',
          root_attempt_id: 'att-1',
          source_attempt_id: 'att-1',
          successor_attempt_id: 'att-3',
          failover_ordinal: 2,
          created_at: new Date().toISOString(),
        });
      }).toThrow(/UNIQUE constraint failed: failover_transitions\.source_attempt_id/);

      // Attempt duplicate successor_attempt_id
      expect(() => {
        rawInsertTransition(db, {
          id: 'ft-3',
          task_id: 'task-1',
          root_attempt_id: 'att-2',
          source_attempt_id: 'att-2',
          successor_attempt_id: 'att-2',
          failover_ordinal: 1,
          created_at: new Date().toISOString(),
        });
      }).toThrow(/UNIQUE constraint failed: failover_transitions\.successor_attempt_id/);
    });

    it('5. enforces DB-level uniqueness on (root_attempt_id, failover_ordinal)', () => {
      seedBaseProjectAndTask(repo, db, 'task-1');
      repo.createTaskAttempt({ id: 'att-1', task_id: 'task-1', attempt_number: 1, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:00:00Z', ended_at: null, summary: null });
      repo.createTaskAttempt({ id: 'att-2', task_id: 'task-1', attempt_number: 2, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:01:00Z', ended_at: null, summary: null });
      repo.createTaskAttempt({ id: 'att-3', task_id: 'task-1', attempt_number: 3, agent_id: 'agent-1', status: 'RUNNING', started_at: '2026-08-26T00:02:00Z', ended_at: null, summary: null });

      rawInsertTransition(db, {
        id: 'ft-1',
        task_id: 'task-1',
        root_attempt_id: 'att-1',
        source_attempt_id: 'att-1',
        successor_attempt_id: 'att-2',
        failover_ordinal: 1,
        created_at: '2026-08-26T00:01:00Z',
      });

      // Attempt to insert duplicate ordinal 1 for root att-1
      expect(() => {
        rawInsertTransition(db, {
          id: 'ft-2',
          task_id: 'task-1',
          root_attempt_id: 'att-1',
          source_attempt_id: 'att-2',
          successor_attempt_id: 'att-3',
          failover_ordinal: 1, // duplicate ordinal for root att-1!
          created_at: '2026-08-26T00:02:00Z',
        });
      }).toThrow(/UNIQUE constraint failed: failover_transitions\.root_attempt_id, failover_transitions\.failover_ordinal/);
    });

    it('5b. rejects cross-task root_attempt_id via composite foreign key constraint', () => {
      seedBaseProjectAndTask(repo, db, 'task-A');
      seedBaseProjectAndTask(repo, db, 'task-B');
      repo.createTaskAttempt({ id: 'att-A1', task_id: 'task-A', attempt_number: 1, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:00:00Z', ended_at: null, summary: null });
      repo.createTaskAttempt({ id: 'att-A2', task_id: 'task-A', attempt_number: 2, agent_id: 'agent-1', status: 'RUNNING', started_at: '2026-08-26T00:01:00Z', ended_at: null, summary: null });
      repo.createTaskAttempt({ id: 'att-B1', task_id: 'task-B', attempt_number: 1, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:00:00Z', ended_at: null, summary: null });

      expect(() => {
        rawInsertTransition(db, {
          id: 'trans-cross-root',
          task_id: 'task-A',
          root_attempt_id: 'att-B1', // Cross-task root!
          source_attempt_id: 'att-A1',
          successor_attempt_id: 'att-A2',
          failover_ordinal: 1,
        });
      }).toThrow(/FOREIGN KEY constraint failed/i);
    });

    it('5c. rejects cross-task source_attempt_id via composite foreign key constraint', () => {
      seedBaseProjectAndTask(repo, db, 'task-A');
      seedBaseProjectAndTask(repo, db, 'task-B');
      repo.createTaskAttempt({ id: 'att-A1', task_id: 'task-A', attempt_number: 1, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:00:00Z', ended_at: null, summary: null });
      repo.createTaskAttempt({ id: 'att-A2', task_id: 'task-A', attempt_number: 2, agent_id: 'agent-1', status: 'RUNNING', started_at: '2026-08-26T00:01:00Z', ended_at: null, summary: null });
      repo.createTaskAttempt({ id: 'att-B1', task_id: 'task-B', attempt_number: 1, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:00:00Z', ended_at: null, summary: null });

      expect(() => {
        rawInsertTransition(db, {
          id: 'trans-cross-source',
          task_id: 'task-A',
          root_attempt_id: 'att-A1',
          source_attempt_id: 'att-B1', // Cross-task source!
          successor_attempt_id: 'att-A2',
          failover_ordinal: 1,
        });
      }).toThrow(/FOREIGN KEY constraint failed/i);
    });

    it('5d. rejects cross-task successor_attempt_id via composite foreign key constraint', () => {
      seedBaseProjectAndTask(repo, db, 'task-A');
      seedBaseProjectAndTask(repo, db, 'task-B');
      repo.createTaskAttempt({ id: 'att-A1', task_id: 'task-A', attempt_number: 1, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:00:00Z', ended_at: null, summary: null });
      repo.createTaskAttempt({ id: 'att-A2', task_id: 'task-A', attempt_number: 2, agent_id: 'agent-1', status: 'RUNNING', started_at: '2026-08-26T00:01:00Z', ended_at: null, summary: null });
      repo.createTaskAttempt({ id: 'att-B1', task_id: 'task-B', attempt_number: 1, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:00:00Z', ended_at: null, summary: null });

      expect(() => {
        rawInsertTransition(db, {
          id: 'trans-cross-succ',
          task_id: 'task-A',
          root_attempt_id: 'att-A1',
          source_attempt_id: 'att-A1',
          successor_attempt_id: 'att-B1', // Cross-task successor!
          failover_ordinal: 1,
        });
      }).toThrow(/FOREIGN KEY constraint failed/i);
    });
  });

  // =========================================================================
  // 2. Atomic Successor Claim & Lineage Creation
  // =========================================================================
  describe('Atomic Successor Claim', () => {
    it('6. creates first successor with root = source, ordinal = 1, and computed attempt_number = 2', () => {
      seedBaseProjectAndTask(repo, db, 'task-1');
      repo.createTaskAttempt({
        id: 'att-1',
        task_id: 'task-1',
        attempt_number: 1,
        agent_id: 'agent-codex',
        status: 'FAILED',
        started_at: '2026-08-26T00:00:00Z',
        ended_at: '2026-08-26T00:01:00Z',
        summary: 'Failed attempt 1',
      });

      const res = service.claimSuccessor({
        transitionId: 'trans-1',
        sourceAttemptId: 'att-1',
        successorAttemptId: 'att-2',
        status: 'PENDING',
        startedAt: '2026-08-26T00:01:05Z',
      });

      expect(res.status).toBe('CREATED');
      expect(res.transition).toBeDefined();
      expect(res.transition?.id).toBe('trans-1');
      expect(res.transition?.root_attempt_id).toBe('att-1');
      expect(res.transition?.source_attempt_id).toBe('att-1');
      expect(res.transition?.successor_attempt_id).toBe('att-2');
      expect(res.transition?.failover_ordinal).toBe(1);

      expect(res.successorAttempt).toBeDefined();
      expect(res.successorAttempt?.id).toBe('att-2');
      expect(res.successorAttempt?.task_id).toBe('task-1');
      expect(res.successorAttempt?.agent_id).toBe('agent-codex');
      expect(res.successorAttempt?.attempt_number).toBe(2);
      expect(res.successorAttempt?.status).toBe('PENDING');

      // Verify in DB
      const loadedAttempt = repo.getTaskAttempt('att-2');
      expect(loadedAttempt).toEqual(res.successorAttempt);

      const loadedTransition = repo.getFailoverTransition('trans-1');
      expect(loadedTransition).toEqual(res.transition);
    });

    it('7. chains second and third successors preserving root and incrementing ordinal', () => {
      seedBaseProjectAndTask(repo, db, 'task-1');
      repo.createTaskAttempt({
        id: 'att-1',
        task_id: 'task-1',
        attempt_number: 1,
        agent_id: 'agent-codex',
        status: 'FAILED',
        started_at: '2026-08-26T00:00:00Z',
        ended_at: null,
        summary: null,
      });

      // Claim 1: att-1 -> att-2
      const res1 = service.claimSuccessor({
        transitionId: 'trans-1',
        sourceAttemptId: 'att-1',
        successorAttemptId: 'att-2',
      });
      expect(res1.status).toBe('CREATED');
      expect(res1.transition?.root_attempt_id).toBe('att-1');
      expect(res1.transition?.failover_ordinal).toBe(1);
      expect(res1.successorAttempt?.attempt_number).toBe(2);

      // Claim 2: att-2 -> att-3
      const res2 = service.claimSuccessor({
        transitionId: 'trans-2',
        sourceAttemptId: 'att-2',
        successorAttemptId: 'att-3',
      });
      expect(res2.status).toBe('CREATED');
      expect(res2.transition?.root_attempt_id).toBe('att-1');
      expect(res2.transition?.source_attempt_id).toBe('att-2');
      expect(res2.transition?.successor_attempt_id).toBe('att-3');
      expect(res2.transition?.failover_ordinal).toBe(2);
      expect(res2.successorAttempt?.attempt_number).toBe(3);

      // Claim 3: att-3 -> att-4
      const res3 = service.claimSuccessor({
        transitionId: 'trans-3',
        sourceAttemptId: 'att-3',
        successorAttemptId: 'att-4',
      });
      expect(res3.status).toBe('CREATED');
      expect(res3.transition?.root_attempt_id).toBe('att-1');
      expect(res3.transition?.source_attempt_id).toBe('att-3');
      expect(res3.transition?.successor_attempt_id).toBe('att-4');
      expect(res3.transition?.failover_ordinal).toBe(3);
      expect(res3.successorAttempt?.attempt_number).toBe(4);
    });
  });

  // =========================================================================
  // 3. Idempotency Authority
  // =========================================================================
  describe('Idempotency Authority', () => {
    it('8. returns ALREADY_CLAIMED on repeated calls with identical parameters', () => {
      seedBaseProjectAndTask(repo, db, 'task-1');
      repo.createTaskAttempt({
        id: 'att-1',
        task_id: 'task-1',
        attempt_number: 1,
        agent_id: 'agent-1',
        status: 'FAILED',
        started_at: '2026-08-26T00:00:00Z',
        ended_at: null,
        summary: null,
      });

      const res1 = service.claimSuccessor({
        transitionId: 'trans-1',
        sourceAttemptId: 'att-1',
        successorAttemptId: 'att-2',
      });
      expect(res1.status).toBe('CREATED');

      const res2 = service.claimSuccessor({
        transitionId: 'trans-1',
        sourceAttemptId: 'att-1',
        successorAttemptId: 'att-2',
      });
      expect(res2.status).toBe('ALREADY_CLAIMED');
      expect(res2.transition?.id).toBe('trans-1');
      expect(res2.successorAttempt?.id).toBe('att-2');

      const attempts = repo.getTaskAttemptsByTask('task-1');
      expect(attempts).toHaveLength(2);
      const transitions = repo.getFailoverTransitionsByTask('task-1');
      expect(transitions).toHaveLength(1);
    });

    it('9. returns ALREADY_CLAIMED and existing successor when called with different transitionId', () => {
      seedBaseProjectAndTask(repo, db, 'task-1');
      repo.createTaskAttempt({
        id: 'att-1',
        task_id: 'task-1',
        attempt_number: 1,
        agent_id: 'agent-1',
        status: 'FAILED',
        started_at: '2026-08-26T00:00:00Z',
        ended_at: null,
        summary: null,
      });

      const res1 = service.claimSuccessor({
        transitionId: 'trans-original',
        sourceAttemptId: 'att-1',
        successorAttemptId: 'att-2',
      });
      expect(res1.status).toBe('CREATED');

      const res2 = service.claimSuccessor({
        transitionId: 'trans-different',
        sourceAttemptId: 'att-1',
        successorAttemptId: 'att-2',
      });
      expect(res2.status).toBe('ALREADY_CLAIMED');
      expect(res2.transition?.id).toBe('trans-original');
      expect(res2.successorAttempt?.id).toBe('att-2');
    });

    it('10. returns ALREADY_CLAIMED and original successor when called with different successorAttemptId', () => {
      seedBaseProjectAndTask(repo, db, 'task-1');
      repo.createTaskAttempt({
        id: 'att-1',
        task_id: 'task-1',
        attempt_number: 1,
        agent_id: 'agent-1',
        status: 'FAILED',
        started_at: '2026-08-26T00:00:00Z',
        ended_at: null,
        summary: null,
      });

      const res1 = service.claimSuccessor({
        transitionId: 'trans-1',
        sourceAttemptId: 'att-1',
        successorAttemptId: 'att-first-successor',
      });
      expect(res1.status).toBe('CREATED');

      const res2 = service.claimSuccessor({
        transitionId: 'trans-2',
        sourceAttemptId: 'att-1',
        successorAttemptId: 'att-second-successor',
      });
      expect(res2.status).toBe('ALREADY_CLAIMED');
      expect(res2.transition?.successor_attempt_id).toBe('att-first-successor');
      expect(res2.successorAttempt?.id).toBe('att-first-successor');

      // att-second-successor was NOT created
      expect(repo.getTaskAttempt('att-second-successor')).toBeNull();
    });
  });

  // =========================================================================
  // 4. Restart Idempotency Simulation
  // =========================================================================
  describe('Process Restart Simulation', () => {
    it('11. survives repository and service instance recreation on file-backed SQLite database', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-r5h4-test-'));
      const dbPath = path.join(tempDir, 'restart_test.db');

      try {
        // Instance 1
        const db1 = new Database(dbPath);
        db1.pragma('foreign_keys = ON');
        MigrationRunner.run(db1);
        const repo1 = new Repository(db1);
        const service1 = new FailoverLineageService(repo1);

        seedBaseProjectAndTask(repo1, db1, 'task-restart');
        repo1.createTaskAttempt({
          id: 'att-root',
          task_id: 'task-restart',
          attempt_number: 1,
          agent_id: 'agent-1',
          status: 'FAILED',
          started_at: '2026-08-26T00:00:00Z',
          ended_at: null,
          summary: null,
        });

        const claim1 = service1.claimSuccessor({
          transitionId: 'trans-root-to-2',
          sourceAttemptId: 'att-root',
          successorAttemptId: 'att-successor-2',
        });
        expect(claim1.status).toBe('CREATED');
        expect(claim1.transition?.id).toBe('trans-root-to-2');

        db1.close();

        // Instance 2 (Simulated process restart)
        const db2 = new Database(dbPath);
        db2.pragma('foreign_keys = ON');
        MigrationRunner.run(db2);
        const repo2 = new Repository(db2);
        const service2 = new FailoverLineageService(repo2);

        // Attempt same claim with different requested IDs
        const claim2 = service2.claimSuccessor({
          transitionId: 'trans-new-attempt',
          sourceAttemptId: 'att-root',
          successorAttemptId: 'att-new-attempt',
        });

        expect(claim2.status).toBe('ALREADY_CLAIMED');
        expect(claim2.transition?.id).toBe('trans-root-to-2');
        expect(claim2.successorAttempt?.id).toBe('att-successor-2');

        const context = service2.getLineageContext('att-successor-2');
        expect(context.failoverAttemptsUsed).toBe(1);
        expect(context.rootAttemptId).toBe('att-root');

        db2.close();
      } finally {
        safeRmDir(tempDir);
      }
    });
  });

  // =========================================================================
  // 5. Lineage Counter & Context Querying
  // =========================================================================
  describe('Lineage Counter & Context Querying', () => {
    it('12. calculates failoverAttemptsUsed = 0, 1, 2 for chain A -> B -> C', () => {
      seedBaseProjectAndTask(repo, db, 'task-chain');
      repo.createTaskAttempt({
        id: 'att-A',
        task_id: 'task-chain',
        attempt_number: 1,
        agent_id: 'agent-1',
        status: 'FAILED',
        started_at: '2026-08-26T00:00:00Z',
        ended_at: null,
        summary: null,
      });

      service.claimSuccessor({
        transitionId: 'trans-A-B',
        sourceAttemptId: 'att-A',
        successorAttemptId: 'att-B',
      });

      service.claimSuccessor({
        transitionId: 'trans-B-C',
        sourceAttemptId: 'att-B',
        successorAttemptId: 'att-C',
      });

      const contextA = service.getLineageContext('att-A');
      expect(contextA.currentAttemptId).toBe('att-A');
      expect(contextA.rootAttemptId).toBe('att-A');
      expect(contextA.failoverAttemptsUsed).toBe(0);
      expect(contextA.transitions).toHaveLength(0);

      const contextB = service.getLineageContext('att-B');
      expect(contextB.currentAttemptId).toBe('att-B');
      expect(contextB.rootAttemptId).toBe('att-A');
      expect(contextB.failoverAttemptsUsed).toBe(1);
      expect(contextB.transitions).toHaveLength(1);
      expect(contextB.transitions[0].id).toBe('trans-A-B');
      expect(contextB.transitions[0].failover_ordinal).toBe(1);

      const contextC = service.getLineageContext('att-C');
      expect(contextC.currentAttemptId).toBe('att-C');
      expect(contextC.rootAttemptId).toBe('att-A');
      expect(contextC.failoverAttemptsUsed).toBe(2);
      expect(contextC.transitions).toHaveLength(2);
      expect(contextC.transitions[0].id).toBe('trans-A-B');
      expect(contextC.transitions[0].failover_ordinal).toBe(1);
      expect(contextC.transitions[1].id).toBe('trans-B-C');
      expect(contextC.transitions[1].failover_ordinal).toBe(2);
    });

    it('13. returns failoverAttemptsUsed = 0 for unrelated task attempt on same task', () => {
      seedBaseProjectAndTask(repo, db, 'task-chain');
      repo.createTaskAttempt({ id: 'att-A', task_id: 'task-chain', attempt_number: 1, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:00:00Z', ended_at: null, summary: null });
      service.claimSuccessor({ transitionId: 'trans-A-B', sourceAttemptId: 'att-A', successorAttemptId: 'att-B' });

      // Create an independent manual attempt D for the same task
      repo.createTaskAttempt({
        id: 'att-D',
        task_id: 'task-chain',
        attempt_number: 3,
        agent_id: 'agent-1',
        status: 'RUNNING',
        started_at: '2026-08-26T00:10:00Z',
        ended_at: null,
        summary: null,
      });

      const contextD = service.getLineageContext('att-D');
      expect(contextD.currentAttemptId).toBe('att-D');
      expect(contextD.rootAttemptId).toBe('att-D');
      expect(contextD.failoverAttemptsUsed).toBe(0);
      expect(contextD.transitions).toHaveLength(0);

      // Total attempts in task is 3, but D's failover budget consumed is 0
      const attempts = repo.getTaskAttemptsByTask('task-chain');
      expect(attempts).toHaveLength(3);
    });

    it('14. supports getTransitionsByRoot, getTransitionsByTask, and individual lookups', () => {
      seedBaseProjectAndTask(repo, db, 'task-chain');
      repo.createTaskAttempt({ id: 'att-A', task_id: 'task-chain', attempt_number: 1, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:00:00Z', ended_at: null, summary: null });
      service.claimSuccessor({ transitionId: 'trans-1', sourceAttemptId: 'att-A', successorAttemptId: 'att-B' });
      service.claimSuccessor({ transitionId: 'trans-2', sourceAttemptId: 'att-B', successorAttemptId: 'att-C' });

      const rootTransitions = service.getTransitionsByRoot('att-A');
      expect(rootTransitions).toHaveLength(2);
      expect(rootTransitions[0].id).toBe('trans-1');
      expect(rootTransitions[1].id).toBe('trans-2');

      const taskTransitions = service.getTransitionsByTask('task-chain');
      expect(taskTransitions).toHaveLength(2);

      const bySource = service.getTransitionBySource('att-A');
      expect(bySource?.id).toBe('trans-1');

      const bySuccessor = service.getTransitionBySuccessor('att-C');
      expect(bySuccessor?.id).toBe('trans-2');
    });
  });

  // =========================================================================
  // 6. Concurrency and Atomic Rollback
  // =========================================================================
  describe('Concurrency and Atomic Rollback', () => {
    it('15. exercises genuine SQLite contention with dual database handles rejecting concurrent IMMEDIATE writer and ensuring serialized attempt numbers', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-r5h4-concurrency-'));
      const dbPath = path.join(tempDir, 'concurrency_test.db');

      try {
        const db1 = new Database(dbPath);
        db1.pragma('foreign_keys = ON');
        MigrationRunner.run(db1);
        const repo1 = new Repository(db1);
        const service1 = new FailoverLineageService(repo1);

        const db2 = new Database(dbPath);
        db2.pragma('foreign_keys = ON');
        db2.pragma('busy_timeout = 0'); // Fail immediately on write lock contention
        const repo2 = new Repository(db2);
        const service2 = new FailoverLineageService(repo2);

        seedBaseProjectAndTask(repo1, db1, 'task-concurrency');
        repo1.createTaskAttempt({ id: 'att-1', task_id: 'task-concurrency', attempt_number: 1, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:00:00Z', ended_at: null, summary: null });
        repo1.createTaskAttempt({ id: 'att-2', task_id: 'task-concurrency', attempt_number: 2, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:01:00Z', ended_at: null, summary: null });

        // Step 1: db1 acquires write reservation via BEGIN IMMEDIATE
        db1.exec('BEGIN IMMEDIATE');

        // Step 2: while db1 holds write lock, db2 attempts claimSuccessor (which uses BEGIN IMMEDIATE)
        // With busy_timeout = 0, db2 cannot acquire write lock and must throw SQLITE_BUSY / database locked
        expect(() => {
          service2.claimSuccessor({
            transitionId: 'trans-blocked',
            sourceAttemptId: 'att-2',
            successorAttemptId: 'att-blocked',
          });
        }).toThrow(/database is locked|busy/i);

        // Verify att-blocked was not created on db2 or db1
        expect(repo1.getTaskAttempt('att-blocked')).toBeNull();

        // Step 3: db1 rolls back / releases the held write reservation
        db1.exec('ROLLBACK');

        // Step 4: After lock release, perform two valid claims on the two handles
        const claim1 = service1.claimSuccessor({
          transitionId: 'trans-from-1',
          sourceAttemptId: 'att-1',
          successorAttemptId: 'att-from-1',
        });
        expect(claim1.status).toBe('CREATED');
        expect(claim1.successorAttempt?.attempt_number).toBe(3);

        const claim2 = service2.claimSuccessor({
          transitionId: 'trans-from-2',
          sourceAttemptId: 'att-2',
          successorAttemptId: 'att-from-2',
        });
        expect(claim2.status).toBe('CREATED');
        expect(claim2.successorAttempt?.attempt_number).toBe(4);

        const allAttempts = repo1.getTaskAttemptsByTask('task-concurrency');
        const attemptNumbers = allAttempts.map((a) => a.attempt_number);
        expect(attemptNumbers).toEqual([1, 2, 3, 4]);

        db1.close();
        db2.close();
      } finally {
        safeRmDir(tempDir);
      }
    });

    it('16. executes true atomic rollback when successor TaskAttempt insertion succeeds but transition insertion fails on UNIQUE(root_attempt_id, failover_ordinal)', () => {
      seedBaseProjectAndTask(repo, db, 'task-1');
      // Step A: Seed initial attempts A, B, and transition A -> B (root=A, ordinal=1)
      repo.createTaskAttempt({ id: 'att-A', task_id: 'task-1', attempt_number: 1, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:00:00Z', ended_at: null, summary: null });
      repo.createTaskAttempt({ id: 'att-B', task_id: 'task-1', attempt_number: 2, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:01:00Z', ended_at: null, summary: null });
      rawInsertTransition(db, {
        id: 'trans-A-B',
        task_id: 'task-1',
        root_attempt_id: 'att-A',
        source_attempt_id: 'att-A',
        successor_attempt_id: 'att-B',
        failover_ordinal: 1,
        created_at: '2026-08-26T00:01:00Z',
      });

      // Step B: Seed additional valid attempts X, Y and pre-seed a transition that occupies (root_attempt_id=A, failover_ordinal=2)
      repo.createTaskAttempt({ id: 'att-X', task_id: 'task-1', attempt_number: 3, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:02:00Z', ended_at: null, summary: null });
      repo.createTaskAttempt({ id: 'att-Y', task_id: 'task-1', attempt_number: 4, agent_id: 'agent-1', status: 'RUNNING', started_at: '2026-08-26T00:02:30Z', ended_at: null, summary: null });
      rawInsertTransition(db, {
        id: 'trans-X-Y-conflict',
        task_id: 'task-1',
        root_attempt_id: 'att-A',
        source_attempt_id: 'att-X',
        successor_attempt_id: 'att-Y',
        failover_ordinal: 2, // Pre-occupies ordinal 2 for root att-A!
        created_at: '2026-08-26T00:02:30Z',
      });

      const attemptCountBefore = repo.getTaskAttemptsByTask('task-1').length;
      expect(attemptCountBefore).toBe(4);

      // Step C: Call claimSuccessor for source att-B with fresh transitionId and fresh successorAttemptId att-Z
      expect(() => {
        service.claimSuccessor({
          transitionId: 'trans-B-Z',
          sourceAttemptId: 'att-B',
          successorAttemptId: 'att-Z',
        });
      }).toThrow(/UNIQUE constraint failed: failover_transitions\.root_attempt_id, failover_transitions\.failover_ordinal/);

      // Step D: Verify atomic rollback - NO orphan successor att-Z exists
      expect(repo.getTaskAttempt('att-Z')).toBeNull();

      // Verify no transition was recorded for source att-B
      expect(repo.getFailoverTransitionBySource('att-B')).toBeNull();
      expect(repo.getFailoverTransition('trans-B-Z')).toBeNull();

      // Verify attempt count in task is unchanged
      const attemptCountAfter = repo.getTaskAttemptsByTask('task-1').length;
      expect(attemptCountAfter).toBe(attemptCountBefore);
    });

    it('16b. fails closed with bounded integrity error when existing predecessor transition state is malformed', () => {
      seedBaseProjectAndTask(repo, db, 'task-1');
      repo.createTaskAttempt({ id: 'att-1', task_id: 'task-1', attempt_number: 1, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:00:00Z', ended_at: null, summary: null });
      repo.createTaskAttempt({ id: 'att-2', task_id: 'task-1', attempt_number: 2, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:01:00Z', ended_at: null, summary: null });

      // Temporarily disable FK enforcement to insert corrupt predecessor row
      db.pragma('foreign_keys = OFF');
      rawInsertTransition(db, {
        id: 'trans-corrupt-pred',
        task_id: 'task-corrupt',
        root_attempt_id: 'att-1',
        source_attempt_id: 'att-1',
        successor_attempt_id: 'att-2',
        failover_ordinal: 1,
      });
      db.pragma('foreign_keys = ON');

      const attemptCountBefore = repo.getTaskAttemptsByTask('task-1').length;

      expect(() => {
        service.claimSuccessor({
          transitionId: 'trans-from-2',
          sourceAttemptId: 'att-2',
          successorAttemptId: 'att-3',
        });
      }).toThrow(/\[FailoverLineageIntegrity\]/i);

      // Verify 0 writes occurred
      expect(repo.getTaskAttempt('att-3')).toBeNull();
      expect(repo.getTaskAttemptsByTask('task-1')).toHaveLength(attemptCountBefore);
    });

    it('16c. fails closed with bounded integrity error when existing outgoing idempotent transition is corrupt', () => {
      seedBaseProjectAndTask(repo, db, 'task-1');
      repo.createTaskAttempt({ id: 'att-1', task_id: 'task-1', attempt_number: 1, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:00:00Z', ended_at: null, summary: null });

      // Temporarily disable FK enforcement to insert corrupt outgoing transition with missing successor
      db.pragma('foreign_keys = OFF');
      rawInsertTransition(db, {
        id: 'trans-corrupt-outgoing',
        task_id: 'task-1',
        root_attempt_id: 'att-1',
        source_attempt_id: 'att-1',
        successor_attempt_id: 'att-nonexistent-succ',
        failover_ordinal: 1,
      });
      db.pragma('foreign_keys = ON');

      expect(() => {
        service.claimSuccessor({
          transitionId: 'trans-new',
          sourceAttemptId: 'att-1',
          successorAttemptId: 'att-fresh',
        });
      }).toThrow(/\[FailoverLineageIntegrity\]/i);

      // Verify 0 writes
      expect(repo.getTaskAttempt('att-fresh')).toBeNull();
    });
  });

  // =========================================================================
  // 7. Input Validation and Failure Modes
  // =========================================================================
  describe('Input Validation and Failure Modes', () => {
    it('17. rejects empty or invalid ID inputs fail-closed', () => {
      const r1 = service.claimSuccessor({ transitionId: '', sourceAttemptId: 's', successorAttemptId: 'd' });
      expect(r1.status).toBe('INVALID_INPUT');

      const r2 = service.claimSuccessor({ transitionId: 't', sourceAttemptId: '   ', successorAttemptId: 'd' });
      expect(r2.status).toBe('INVALID_INPUT');

      const r3 = service.claimSuccessor({ transitionId: 't', sourceAttemptId: 's', successorAttemptId: 's' });
      expect(r3.status).toBe('INVALID_INPUT');

      const r4 = service.claimSuccessor(null as any);
      expect(r4.status).toBe('INVALID_INPUT');
    });

    it('18. returns SOURCE_NOT_FOUND when source task attempt does not exist', () => {
      const res = service.claimSuccessor({
        transitionId: 'trans-1',
        sourceAttemptId: 'nonexistent-source',
        successorAttemptId: 'succ-1',
      });
      expect(res.status).toBe('SOURCE_NOT_FOUND');
      expect(res.error).toContain('Source TaskAttempt "nonexistent-source" not found');
    });

    it('19. returns SUCCESSOR_ID_CONFLICT when successorAttemptId already exists in task_attempts', () => {
      seedBaseProjectAndTask(repo, db, 'task-1');
      repo.createTaskAttempt({ id: 'att-1', task_id: 'task-1', attempt_number: 1, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:00:00Z', ended_at: null, summary: null });
      repo.createTaskAttempt({ id: 'att-2', task_id: 'task-1', attempt_number: 2, agent_id: 'agent-1', status: 'RUNNING', started_at: '2026-08-26T00:01:00Z', ended_at: null, summary: null });

      const res = service.claimSuccessor({
        transitionId: 'trans-1',
        sourceAttemptId: 'att-1',
        successorAttemptId: 'att-2', // already exists!
      });
      expect(res.status).toBe('SUCCESSOR_ID_CONFLICT');
    });

    it('20. throws error on getLineageContext with non-existent attemptId', () => {
      expect(() => {
        service.getLineageContext('nonexistent-attempt');
      }).toThrow(/TaskAttempt "nonexistent-attempt" not found/);
    });

    it('20b. detects cycle in lineage graph and throws bounded integrity error immediately', () => {
      seedBaseProjectAndTask(repo, db, 'task-1');
      repo.createTaskAttempt({ id: 'att-A', task_id: 'task-1', attempt_number: 1, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:00:00Z', ended_at: null, summary: null });
      repo.createTaskAttempt({ id: 'att-B', task_id: 'task-1', attempt_number: 2, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:01:00Z', ended_at: null, summary: null });

      rawInsertTransition(db, {
        id: 'trans-A-B',
        task_id: 'task-1',
        root_attempt_id: 'att-A',
        source_attempt_id: 'att-A',
        successor_attempt_id: 'att-B',
        failover_ordinal: 1,
      });

      rawInsertTransition(db, {
        id: 'trans-B-A',
        task_id: 'task-1',
        root_attempt_id: 'att-A',
        source_attempt_id: 'att-B',
        successor_attempt_id: 'att-A',
        failover_ordinal: 2,
      });

      expect(() => {
        service.getLineageContext('att-A');
      }).toThrow(/\[FailoverLineageIntegrity\].*cycle/i);
    });

    it('20c. fails closed with bounded integrity error when an ordinal gap exists in the lineage chain', () => {
      seedBaseProjectAndTask(repo, db, 'task-1');
      repo.createTaskAttempt({ id: 'att-A', task_id: 'task-1', attempt_number: 1, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:00:00Z', ended_at: null, summary: null });
      repo.createTaskAttempt({ id: 'att-B', task_id: 'task-1', attempt_number: 2, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:01:00Z', ended_at: null, summary: null });
      repo.createTaskAttempt({ id: 'att-C', task_id: 'task-1', attempt_number: 3, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:02:00Z', ended_at: null, summary: null });

      rawInsertTransition(db, {
        id: 'trans-A-B',
        task_id: 'task-1',
        root_attempt_id: 'att-A',
        source_attempt_id: 'att-A',
        successor_attempt_id: 'att-B',
        failover_ordinal: 1,
      });

      rawInsertTransition(db, {
        id: 'trans-B-C',
        task_id: 'task-1',
        root_attempt_id: 'att-A',
        source_attempt_id: 'att-B',
        successor_attempt_id: 'att-C',
        failover_ordinal: 3, // Ordinal gap: 3 instead of 2!
      });

      expect(() => {
        service.getLineageContext('att-C');
      }).toThrow(/\[FailoverLineageIntegrity\].*ordinal gap/i);
    });

    it('20d. fails closed with bounded integrity error when a root attempt mismatch exists across the lineage chain', () => {
      seedBaseProjectAndTask(repo, db, 'task-1');
      repo.createTaskAttempt({ id: 'att-A', task_id: 'task-1', attempt_number: 1, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:00:00Z', ended_at: null, summary: null });
      repo.createTaskAttempt({ id: 'att-B', task_id: 'task-1', attempt_number: 2, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:01:00Z', ended_at: null, summary: null });
      repo.createTaskAttempt({ id: 'att-C', task_id: 'task-1', attempt_number: 3, agent_id: 'agent-1', status: 'FAILED', started_at: '2026-08-26T00:02:00Z', ended_at: null, summary: null });

      rawInsertTransition(db, {
        id: 'trans-A-B',
        task_id: 'task-1',
        root_attempt_id: 'att-A',
        source_attempt_id: 'att-A',
        successor_attempt_id: 'att-B',
        failover_ordinal: 1,
      });

      rawInsertTransition(db, {
        id: 'trans-B-C',
        task_id: 'task-1',
        root_attempt_id: 'att-B', // Root mismatch: att-B instead of att-A!
        source_attempt_id: 'att-B',
        successor_attempt_id: 'att-C',
        failover_ordinal: 2,
      });

      expect(() => {
        service.getLineageContext('att-C');
      }).toThrow(/\[FailoverLineageIntegrity\].*root mismatch/i);
    });
  });

  // =========================================================================
  // 8. Architectural and Scope Boundaries
  // =========================================================================
  describe('Architectural and Scope Boundaries', () => {
    it('21. verifies FailoverLineageService has zero forbidden imports', () => {
      const serviceFilePath = path.join(__dirname, '../src/core/services/FailoverLineageService.ts');
      const content = fs.readFileSync(serviceFilePath, 'utf8');

      expect(content).not.toContain('RoleAwareRoutingService');
      expect(content).not.toContain('FailoverDecisionService');
      expect(content).not.toContain('FailoverPolicyParser');
      expect(content).not.toContain('ExecutionFailureClassifier');
      expect(content).not.toContain('AccountHealthService');
      expect(content).not.toContain('ExecutionAuthorizationService');
      expect(content).not.toContain('ConcurrentExecutionScheduler');
      expect(content).not.toContain('ProviderDispatchService');
      expect(content).not.toContain('WorkerSlotLeaseService');
      expect(content).not.toContain('GitWorktreeService');
      expect(content).not.toContain('EventService');
    });

    it('22. verifies FailoverTransition does not contain secret-bearing or raw error fields', () => {
      const transition: any = {
        id: 't1',
        task_id: 'task-1',
        root_attempt_id: 'a1',
        source_attempt_id: 'a1',
        successor_attempt_id: 'a2',
        failover_ordinal: 1,
        created_at: '2026-08-26T00:00:00Z',
      };

      const forbiddenKeys = [
        'credential_ref',
        'profile_ref',
        'token',
        'secret',
        'password',
        'error',
        'stdout',
        'stderr',
        'raw_payload',
      ];

      for (const key of forbiddenKeys) {
        expect(key in transition).toBe(false);
      }
    });
  });
});
