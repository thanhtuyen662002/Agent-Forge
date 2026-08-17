import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { EventService } from '../src/core/services/EventService';
import { TaskService } from '../src/core/services/TaskService';
import { PackageGenerator } from '../src/core/protocol/packageGenerator';
import { Project, Task } from '../src/core/types/domain';

describe('Cross-Project Integrity Guards', () => {
  let db: Database.Database;
  let repo: Repository;
  let eventService: EventService;
  let taskService: TaskService;
  let projA: Project;
  let projB: Project;
  let taskB: Task;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    eventService = new EventService(repo);
    taskService = new TaskService(repo, eventService);

    projA = {
      id: 'PROJ-A',
      name: 'Project A',
      description: null,
      repository_path: 'd:/repo-a',
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      completed_at: null,
    };
    repo.createProject(projA);

    projB = {
      id: 'PROJ-B',
      name: 'Project B',
      description: null,
      repository_path: 'd:/repo-b',
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      completed_at: null,
    };
    repo.createProject(projB);

    taskB = {
      id: 'TSK-B-001',
      project_id: 'PROJ-B',
      milestone_id: null,
      title: 'Task on Project B',
      description: null,
      state: 'REVIEW_READY',
      paused_from_state: null,
      priority: 'MEDIUM',
      risk: 'LOW',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 50,
      progress_computed_at: new Date().toISOString(),
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createTask(taskB);
  });

  afterEach(() => {
    db.close();
  });

  it('should reject startReview if target task belongs to another project and leave task state unchanged', () => {
    // Attempt to start review on Task B targeting Project A
    const res = taskService.startReview('TSK-B-001', 'PROJ-A');
    expect(res.success).toBe(false);
    expect(res.error).toContain('Cross-project guard');

    // Assert task state is unchanged in SQLite
    const currentTask = repo.getTask('TSK-B-001')!;
    expect(currentTask.state).toBe('REVIEW_READY');

    // Assert no review event created
    const events = repo.getEvents('PROJ-A');
    expect(events.length).toBe(0);
  });

  it('should reject validation flow if task belongs to another project', async () => {
    await expect(
      taskService.executeValidationFlow('TSK-B-001', undefined, 'PROJ-A')
    ).rejects.toThrow(/Cross-project guard/);

    const currentTask = repo.getTask('TSK-B-001')!;
    expect(currentTask.state).toBe('REVIEW_READY');
  });
});
