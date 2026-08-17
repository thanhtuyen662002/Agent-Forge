import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { EventService } from '../src/core/services/EventService';
import { TaskService } from '../src/core/services/TaskService';
import { CoderProtocol } from '../src/core/types/protocols';
import { Project, Task } from '../src/core/types/domain';

describe('Coder Protocol Status Semantics', () => {
  let db: Database.Database;
  let repo: Repository;
  let eventService: EventService;
  let taskService: TaskService;
  let project: Project;
  let task: Task;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    eventService = new EventService(repo);
    taskService = new TaskService(repo, eventService);

    project = {
      id: 'PROJ-CDR',
      name: 'Coder Semantics Project',
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

    task = {
      id: 'TSK-CDR-001',
      project_id: 'PROJ-CDR',
      milestone_id: null,
      title: 'Coder Status Task',
      description: null,
      state: 'CODING',
      paused_from_state: null,
      priority: 'MEDIUM',
      risk: 'LOW',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 10,
      progress_computed_at: new Date().toISOString(),
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

  it('COMPLETED status with review_requested: true transitions task to VALIDATING', () => {
    const msg: CoderProtocol = {
      protocol: 'coder.v1',
      message_id: 'msg-completed-1',
      project_id: 'PROJ-CDR',
      task_id: 'TSK-CDR-001',
      attempt: 1,
      status: 'COMPLETED',
      completed: ['All feature tasks done'],
      remaining: [],
      files_claimed_changed: ['src/app.ts'],
      tests_claimed: ['Unit tests passed'],
      blockers: [],
      review_requested: true,
      expected_task_state: 'CODING',
      expected_revision: 0,
    };

    const res = taskService.applyCoderReport(msg, JSON.stringify(msg));
    expect(res.success).toBe(true);
    expect(repo.getTask('TSK-CDR-001')!.state).toBe('VALIDATING');
  });

  it('IN_PROGRESS status records checkpoint/protocol and leaves task in CODING state', () => {
    const msg: CoderProtocol = {
      protocol: 'coder.v1',
      message_id: 'msg-in-prog-1',
      project_id: 'PROJ-CDR',
      task_id: 'TSK-CDR-001',
      attempt: 1,
      status: 'IN_PROGRESS',
      completed: ['Initial scaffolding'],
      remaining: ['Implement business logic'],
      files_claimed_changed: ['src/scaffold.ts'],
      tests_claimed: [],
      blockers: [],
      review_requested: false,
      expected_task_state: 'CODING',
      expected_revision: 0,
    };

    const res = taskService.applyCoderReport(msg, JSON.stringify(msg));
    expect(res.success).toBe(true);
    expect(repo.getTask('TSK-CDR-001')!.state).toBe('CODING');

    // Verify protocol ledger recorded
    const ledger = repo.getProtocolMessagesByTask('TSK-CDR-001');
    expect(ledger.length).toBe(1);
    expect(ledger[0].status).toBe('APPLIED');
  });

  it('BLOCKED status transitions task to BLOCKED state', () => {
    const msg: CoderProtocol = {
      protocol: 'coder.v1',
      message_id: 'msg-blocked-1',
      project_id: 'PROJ-CDR',
      task_id: 'TSK-CDR-001',
      attempt: 1,
      status: 'BLOCKED',
      completed: [],
      remaining: ['All'],
      files_claimed_changed: [],
      tests_claimed: [],
      blockers: ['Missing database credentials in environment'],
      review_requested: false,
      expected_task_state: 'CODING',
      expected_revision: 0,
    };

    const res = taskService.applyCoderReport(msg, JSON.stringify(msg));
    expect(res.success).toBe(true);
    expect(repo.getTask('TSK-CDR-001')!.state).toBe('BLOCKED');
  });

  it('FAILED status increments revision and returns to CODING or escalates to NEEDS_HUMAN', () => {
    const msg: CoderProtocol = {
      protocol: 'coder.v1',
      message_id: 'msg-failed-1',
      project_id: 'PROJ-CDR',
      task_id: 'TSK-CDR-001',
      attempt: 1,
      status: 'FAILED',
      completed: [],
      remaining: ['Retry required'],
      files_claimed_changed: [],
      tests_claimed: ['Tests failed with syntax error'],
      blockers: [],
      review_requested: false,
      expected_task_state: 'CODING',
      expected_revision: 0,
    };

    const res = taskService.applyCoderReport(msg, JSON.stringify(msg));
    expect(res.success).toBe(true);

    const updatedTask = repo.getTask('TSK-CDR-001')!;
    expect(updatedTask.state).toBe('CODING');
    expect(updatedTask.revision_count).toBe(1); // Revision incremented
  });
});
