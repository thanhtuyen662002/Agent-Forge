import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { EventService } from '../src/core/services/EventService';
import { TaskService } from '../src/core/services/TaskService';
import { ManagerProtocol, CoderProtocol } from '../src/core/types/protocols';
import { Task, Project } from '../src/core/types/domain';

describe('TaskService & Protocol Idempotency', () => {
  let db: Database.Database;
  let repo: Repository;
  let eventService: EventService;
  let taskService: TaskService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    eventService = new EventService(repo);
    taskService = new TaskService(repo, eventService);

    // Create a base project and task
    const proj: Project = {
      id: 'PROJ-TEST',
      name: 'Test Project',
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
    repo.createProject(proj);

    const task: Task = {
      id: 'TSK-001',
      project_id: 'PROJ-TEST',
      milestone_id: null,
      title: 'Auth Middleware',
      description: 'Implement JWT',
      state: 'PLANNED',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 10,
      progress_computed_at: new Date().toISOString(),
      acceptance_criteria: ['JWT verified'],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createTask(task);
  });

  afterEach(() => {
    db.close();
  });

  it('should apply manager EXECUTE decision and transition task to CODING', () => {
    const managerMsg: ManagerProtocol = {
      protocol: 'manager.v1',
      message_id: 'msg-exec-1',
      project_id: 'PROJ-TEST',
      task_id: 'TSK-001',
      decision: 'EXECUTE',
      priority: 'HIGH',
      risk: 'MEDIUM',
      instructions: ['Implement code'],
      acceptance_criteria: ['JWT verified'],
      constraints: [],
      review_issues: [],
      expected_task_state: 'PLANNED',
      expected_revision: 0,
    };

    const res = taskService.applyManagerDecision(managerMsg, JSON.stringify(managerMsg));
    expect(res.success).toBe(true);

    const updated = repo.getTask('TSK-001')!;
    expect(updated.state).toBe('CODING');
  });

  it('should be idempotent when duplicate message ID is received', () => {
    const managerMsg: ManagerProtocol = {
      protocol: 'manager.v1',
      message_id: 'msg-dup-1',
      project_id: 'PROJ-TEST',
      task_id: 'TSK-001',
      decision: 'EXECUTE',
      priority: 'HIGH',
      risk: 'MEDIUM',
      instructions: [],
      acceptance_criteria: [],
      constraints: [],
      review_issues: [],
      expected_task_state: 'PLANNED',
      expected_revision: 0,
    };

    const res1 = taskService.applyManagerDecision(managerMsg, JSON.stringify(managerMsg));
    expect(res1.success).toBe(true);
    expect(res1.isDuplicate).toBeFalsy();

    // Second apply with identical message_id
    const res2 = taskService.applyManagerDecision(managerMsg, JSON.stringify(managerMsg));
    expect(res2.success).toBe(true);
    expect(res2.isDuplicate).toBe(true);
  });

  it('should reject stale Manager decision targeting obsolete task state', () => {
    const managerMsg: ManagerProtocol = {
      protocol: 'manager.v1',
      message_id: 'msg-stale-1',
      project_id: 'PROJ-TEST',
      task_id: 'TSK-001',
      decision: 'PASS',
      priority: 'HIGH',
      risk: 'MEDIUM',
      instructions: [],
      acceptance_criteria: [],
      constraints: [],
      review_issues: [],
      expected_task_state: 'REVIEWING', // Task is actually PLANNED
      expected_revision: 0,
    };

    const res = taskService.applyManagerDecision(managerMsg, JSON.stringify(managerMsg));
    expect(res.success).toBe(false);
    expect(res.error).toContain('Stale state conflict');
  });

  it('should reject cross-project protocol message targeting wrong project', () => {
    const managerMsg: ManagerProtocol = {
      protocol: 'manager.v1',
      message_id: 'msg-cross-1',
      project_id: 'PROJ-WRONG',
      task_id: 'TSK-001',
      decision: 'EXECUTE',
      priority: 'HIGH',
      risk: 'MEDIUM',
      instructions: [],
      acceptance_criteria: [],
      constraints: [],
      review_issues: [],
      expected_task_state: 'PLANNED',
      expected_revision: 0,
    };

    const res = taskService.applyManagerDecision(managerMsg, JSON.stringify(managerMsg));
    expect(res.success).toBe(false);
    expect(res.error).toContain('Cross-project conflict');
  });

  it('should process coder report and transition task to VALIDATING', () => {
    repo.updateTaskState('TSK-001', 'CODING');

    const coderMsg: CoderProtocol = {
      protocol: 'coder.v1',
      message_id: 'msg-cdr-1',
      project_id: 'PROJ-TEST',
      task_id: 'TSK-001',
      attempt: 1,
      status: 'COMPLETED',
      completed: ['Done'],
      remaining: [],
      files_claimed_changed: ['src/auth.ts'],
      tests_claimed: ['All pass'],
      blockers: [],
      review_requested: true,
      expected_task_state: 'CODING',
      expected_revision: 0,
    };

    const res = taskService.applyCoderReport(coderMsg, JSON.stringify(coderMsg));
    expect(res.success).toBe(true);

    const updated = repo.getTask('TSK-001')!;
    expect(updated.state).toBe('VALIDATING');
  });

  it('should reject coder report with stale revision count', () => {
    repo.updateTaskState('TSK-001', 'CODING');

    const coderMsg: CoderProtocol = {
      protocol: 'coder.v1',
      message_id: 'msg-cdr-stale',
      project_id: 'PROJ-TEST',
      task_id: 'TSK-001',
      attempt: 1,
      status: 'COMPLETED',
      completed: ['Done'],
      remaining: [],
      files_claimed_changed: ['src/auth.ts'],
      tests_claimed: ['All pass'],
      blockers: [],
      review_requested: true,
      expected_task_state: 'CODING',
      expected_revision: 5, // Task is at revision 0
    };

    const res = taskService.applyCoderReport(coderMsg, JSON.stringify(coderMsg));
    expect(res.success).toBe(false);
    expect(res.error).toContain('Stale revision conflict');
  });

  it('should rollback transaction on injected failure and allow clean retry', () => {
    const managerMsg: ManagerProtocol = {
      protocol: 'manager.v1',
      message_id: 'msg-fail-inject-1',
      project_id: 'PROJ-TEST',
      task_id: 'TSK-001',
      decision: 'EXECUTE',
      priority: 'HIGH',
      risk: 'MEDIUM',
      instructions: ['Execute feature'],
      acceptance_criteria: [],
      constraints: [],
      review_issues: [],
      expected_task_state: 'PLANNED',
      expected_revision: 0,
    };

    // Inject failure into recordProtocolMessage midway through mutation
    const origRecord = repo.recordProtocolMessage.bind(repo);
    const spy = vi.spyOn(repo, 'recordProtocolMessage').mockImplementation(() => {
      throw new Error('Injected Database Write Failure');
    });

    const res1 = taskService.applyManagerDecision(managerMsg, JSON.stringify(managerMsg));
    expect(res1.success).toBe(false);
    expect(res1.error).toContain('Injected Database Write Failure');

    // Assert complete rollback
    const taskAfterFail = repo.getTask('TSK-001')!;
    expect(taskAfterFail.state).toBe('PLANNED'); // Unchanged!

    const events = repo.getEvents('PROJ-TEST');
    expect(events.filter((e) => e.type === 'MANAGER_DECISION_APPLIED').length).toBe(0);

    const msgs = repo.getProtocolMessagesByTask('TSK-001');
    expect(msgs.length).toBe(0);

    // Restore original method and retry
    spy.mockRestore();

    const res2 = taskService.applyManagerDecision(managerMsg, JSON.stringify(managerMsg));
    expect(res2.success).toBe(true);

    const taskAfterSuccess = repo.getTask('TSK-001')!;
    expect(taskAfterSuccess.state).toBe('CODING');
    expect(repo.getProtocolMessagesByTask('TSK-001').length).toBe(1);
  });

  it('should transition REVIEW_READY to REVIEWING via startReview', () => {
    repo.updateTaskState('TSK-001', 'REVIEW_READY');

    const res = taskService.startReview('TSK-001');
    expect(res.success).toBe(true);
    expect(res.task!.state).toBe('REVIEWING');

    const dbTask = repo.getTask('TSK-001')!;
    expect(dbTask.state).toBe('REVIEWING');
  });
});
