import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { EventService } from '../src/core/services/EventService';
import { EmergencyStopService } from '../src/core/services/EmergencyStopService';
import { Project, Task } from '../src/core/types/domain';

describe('EmergencyStopService', () => {
  let db: Database.Database;
  let repo: Repository;
  let eventService: EventService;
  let emergencyStopService: EmergencyStopService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    eventService = new EventService(repo);
    emergencyStopService = new EmergencyStopService(repo, eventService);

    const proj: Project = {
      id: 'PROJ-RUNNING',
      name: 'Running Project',
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

    const t1: Task = {
      id: 'TASK-CODING',
      project_id: 'PROJ-RUNNING',
      milestone_id: null,
      title: 'Active Coding Task',
      description: null,
      state: 'CODING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: 'gemini-1',
      revision_count: 0,
      max_revisions: 3,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 40,
      progress_computed_at: new Date().toISOString(),
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createTask(t1);

    const t2: Task = {
      id: 'TASK-VALIDATING',
      project_id: 'PROJ-RUNNING',
      milestone_id: null,
      title: 'Validating Task',
      description: null,
      state: 'VALIDATING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: 'gemini-1',
      revision_count: 0,
      max_revisions: 3,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 70,
      progress_computed_at: new Date().toISOString(),
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createTask(t2);
  });

  afterEach(() => {
    db.close();
  });

  it('should safely pause all active tasks and projects on Emergency Stop', () => {
    const res = emergencyStopService.triggerEmergencyStop('Manual Test Trigger');
    expect(res.projectsPaused).toContain('PROJ-RUNNING');
    expect(res.tasksPaused).toContain('TASK-CODING');
    expect(res.tasksPaused).toContain('TASK-VALIDATING');

    const updatedProj = repo.getProject('PROJ-RUNNING')!;
    expect(updatedProj.status).toBe('PAUSED');

    const updatedT1 = repo.getTask('TASK-CODING')!;
    expect(updatedT1.state).toBe('PAUSED');
    expect(updatedT1.paused_from_state).toBe('CODING');

    const updatedT2 = repo.getTask('TASK-VALIDATING')!;
    expect(updatedT2.state).toBe('PAUSED');
    expect(updatedT2.paused_from_state).toBe('VALIDATING');
  });

  it('should deterministically resume paused tasks to their exact prior state', () => {
    emergencyStopService.triggerEmergencyStop('Manual Pause');
    emergencyStopService.resumeProject('PROJ-RUNNING');

    const updatedProj = repo.getProject('PROJ-RUNNING')!;
    expect(updatedProj.status).toBe('RUNNING');

    const updatedT1 = repo.getTask('TASK-CODING')!;
    expect(updatedT1.state).toBe('CODING');
    expect(updatedT1.paused_from_state).toBeNull();

    const updatedT2 = repo.getTask('TASK-VALIDATING')!;
    expect(updatedT2.state).toBe('VALIDATING');
    expect(updatedT2.paused_from_state).toBeNull();
  });
});
