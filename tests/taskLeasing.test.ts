import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { Task, Project } from '../src/core/types/domain';

describe('Task Leasing & Concurrency Control', () => {
  let db: Database.Database;
  let repo: Repository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);

    const project: Project = {
      id: 'PROJ-LEASE',
      name: 'Lease Test Project',
      description: null,
      repository_path: 'd:/test',
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      completed_at: null,
    };
    repo.createProject(project);

    const task: Task = {
      id: 'TSK-LEASE-1',
      project_id: 'PROJ-LEASE',
      milestone_id: null,
      title: 'Lease Task',
      description: null,
      state: 'CODING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createTask(task);
  });

  afterEach(() => {
    db.close();
  });

  it('should acquire lease for an unleased task and assign agent', () => {
    const ok = repo.acquireTaskLease('TSK-LEASE-1', 'agent-1', 'token-123', 60000);
    expect(ok).toBe(true);

    const task = repo.getTask('TSK-LEASE-1')!;
    expect(task.assigned_agent_id).toBe('agent-1');
  });

  it('should reject second agent attempting to acquire active lease', () => {
    const ok1 = repo.acquireTaskLease('TSK-LEASE-1', 'agent-1', 'token-123', 60000);
    expect(ok1).toBe(true);

    const ok2 = repo.acquireTaskLease('TSK-LEASE-1', 'agent-2', 'token-456', 60000);
    expect(ok2).toBe(false);

    const task = repo.getTask('TSK-LEASE-1')!;
    expect(task.assigned_agent_id).toBe('agent-1');
  });

  it('should allow lease acquisition after previous lease is released', () => {
    repo.acquireTaskLease('TSK-LEASE-1', 'agent-1', 'token-123', 60000);
    repo.releaseTaskLease('TSK-LEASE-1', 'token-123');

    const ok = repo.acquireTaskLease('TSK-LEASE-1', 'agent-2', 'token-456', 60000);
    expect(ok).toBe(true);

    const task = repo.getTask('TSK-LEASE-1')!;
    expect(task.assigned_agent_id).toBe('agent-2');
  });
});
