import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { EventService } from '../src/core/services/EventService';
import { EmergencyStopService } from '../src/core/services/EmergencyStopService';
import { ProjectService } from '../src/core/services/ProjectService';
import {
  ProjectStopFenceService,
  sanitizeProjectStopReason,
} from '../src/core/services/ProjectStopFenceService';
import { ProcessRunner } from '../src/core/services/ProcessRunner';

function now(): string {
  return new Date().toISOString();
}

describe('ProjectStopFenceService', () => {
  let db: Database.Database;
  let repo: Repository;
  let fence: ProjectStopFenceService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    fence = new ProjectStopFenceService(repo);

    const createdAt = now();
    for (const projectId of ['PROJ-STOP-A', 'PROJ-STOP-B']) {
      repo.createProject({
        id: projectId,
        name: projectId,
        description: null,
        repository_path: 'D:/agent-forge-test',
        default_branch: 'main',
        status: 'RUNNING',
        contract: null,
        created_at: createdAt,
        updated_at: createdAt,
        started_at: createdAt,
        completed_at: null,
      });
    }

    repo.createTask({
      id: 'TASK-STOP-A',
      project_id: 'PROJ-STOP-A',
      milestone_id: null,
      title: 'Active task',
      description: null,
      state: 'CODING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'HIGH',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: createdAt,
      updated_at: createdAt,
    });
  });

  afterEach(() => db.close());

  it('creates a durable latch before termination, pauses tasks atomically, and preserves sanitized audit data', async () => {
    const eventService = new EventService(repo);
    const emergencyStop = new EmergencyStopService(repo, eventService);
    const terminate = vi
      .spyOn(ProcessRunner, 'terminateAllProcesses')
      .mockImplementation(async () => {
        const snapshot = fence.getFence('PROJ-STOP-A');
        expect(snapshot?.latched).toBe(true);
        expect(snapshot?.epoch).toBe(1);
        expect(repo.getTask('TASK-STOP-A')?.state).toBe('PAUSED');
        return { count: 1, unproven: 1, allTerminatedProven: false };
      });

    const result = await emergencyStop.triggerEmergencyStop(' owner\u0000 supplied\nreason ');

    expect(result.stopEpochs['PROJ-STOP-A']).toBe(1);
    expect(result.unprovenProcesses).toBe(1);
    expect(result.allTerminatedProven).toBe(false);
    expect(fence.getFence('PROJ-STOP-A')).toMatchObject({ epoch: 1, latched: true });
    expect(sanitizeProjectStopReason(' owner\u0000 supplied\nreason ')).toBe('owner  supplied reason');
    expect(repo.getEvents('PROJ-STOP-A').map((event) => event.type)).toEqual(
      expect.arrayContaining(['EMERGENCY_STOP_REQUESTED', 'TASK_PAUSED', 'EMERGENCY_STOP'])
    );

    terminate.mockRestore();
  });

  it('is idempotent, fences stale resume, advances epoch on resume, and isolates projects', () => {
    const first = fence.requestStopForProject('PROJ-STOP-A', 'stop A');
    expect(first.projects[0]).toMatchObject({ status: 'STOPPED', previousEpoch: 0, epoch: 1 });
    expect(fence.getFence('PROJ-STOP-B')).toMatchObject({ epoch: 0, latched: false });

    const repeated = fence.requestStopForProject('PROJ-STOP-A', 'different reason');
    expect(repeated.projects[0]).toMatchObject({ status: 'ALREADY_STOPPED', previousEpoch: 1, epoch: 1 });
    expect(fence.getFence('PROJ-STOP-A')?.reason).toBe('stop A');

    const staleResume = fence.resumeProject('PROJ-STOP-A', 0);
    expect(staleResume.status).toBe('STALE_EPOCH');
    expect(fence.getFence('PROJ-STOP-A')).toMatchObject({ epoch: 1, latched: true });

    const resumed = fence.resumeProject('PROJ-STOP-A', 1);
    expect(resumed).toMatchObject({ status: 'RESUMED', previousEpoch: 1, epoch: 2 });
    expect(repo.getTask('TASK-STOP-A')).toMatchObject({ state: 'CODING', paused_from_state: null });
    expect(fence.resumeProject('PROJ-STOP-A', 2).status).toBe('ALREADY_RESUMED');
    expect(new EmergencyStopService(repo, new EventService(repo)).resumeProject('PROJ-STOP-B')).toBe(false);
  });

  it('does not let the normal project state machine bypass an emergency latch', () => {
    const projectService = new ProjectService(repo, new EventService(repo));
    fence.requestStopForProject('PROJ-STOP-A', 'owner stop');

    expect(() => projectService.transitionStatus('PROJ-STOP-A', 'RESUME')).toThrow('PROJECT_EMERGENCY_STOP_LATCHED');
    expect(fence.getFence('PROJ-STOP-A')).toMatchObject({ epoch: 1, latched: true, projectStatus: 'PAUSED' });
    expect(() => repo.updateProjectStatus('PROJ-STOP-A', 'RUNNING')).toThrow('PROJECT_STOP_FENCE_REJECTED');

    const baseProject = repo.getProject('PROJ-STOP-B')!;
    const runningTransitions = [
      ['PROJ-STOP-BLOCKED', 'BLOCKED', 'BLOCKER_RESOLVED'],
      ['PROJ-STOP-CAPACITY', 'WAITING_FOR_CAPACITY', 'CAPACITY_RESTORED'],
      ['PROJ-STOP-OWNER', 'WAITING_FOR_OWNER', 'OWNER_APPROVED'],
      ['PROJ-STOP-REVIEW', 'FINAL_REVIEW', 'FINAL_FIX_REQUIRED'],
    ] as const;
    for (const [projectId, status, trigger] of runningTransitions) {
      repo.createProject({ ...baseProject, id: projectId, name: projectId, status, updated_at: now() });
      fence.requestStopForProject(projectId, 'owner stop');
      expect(() => projectService.transitionStatus(projectId, trigger)).toThrow('PROJECT_EMERGENCY_STOP_LATCHED');
      expect(repo.getProject(projectId)?.status).toBe(status);
    }
  });

  it('does not widen an explicitly scoped stop when target ids are empty or invalid', () => {
    const empty = fence.requestStopForAllProjects('empty target list', undefined, now(), []);
    const invalid = fence.requestStopForAllProjects('invalid target list', undefined, now(), [' ', '']);

    expect(empty.projects).toEqual([]);
    expect(invalid.projects).toEqual([]);
    expect(fence.getFence('PROJ-STOP-A')).toMatchObject({ epoch: 0, latched: false });
    expect(fence.getFence('PROJ-STOP-B')).toMatchObject({ epoch: 0, latched: false });
  });

  it('rejects a stale authorization claim at the SQLite linearization point', () => {
    const createdAt = now();
    repo.createProvider({
      id: 'PROVIDER-STOP',
      name: 'Stop Test Provider',
      adapter_type: 'MOCK',
      enabled: true,
      created_at: createdAt,
    });
    repo.createProviderResource({
      id: 'RESOURCE-STOP',
      provider_id: 'PROVIDER-STOP',
      model_name: 'stop-test',
      health_status: 'AVAILABLE',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 0,
      last_health_check: createdAt,
    });
    repo.recordProtocolMessage(
      'MANAGER-STOP-RECORD',
      'MANAGER-STOP-MESSAGE',
      'manager.v1',
      'PROJ-STOP-A',
      'TASK-STOP-A',
      'CODING',
      0,
      'payload-hash',
      '{}',
      'APPLIED',
      undefined,
      createdAt
    );
    repo.createExecutionAuthorization({
      id: 'AUTH-STOP-STALE',
      project_id: 'PROJ-STOP-A',
      task_id: 'TASK-STOP-A',
      attempt_id: null,
      task_revision: 0,
      base_sha: 'base',
      repository_head_sha: 'head',
      manager_message_id: 'MANAGER-STOP-RECORD',
      manager_payload_hash: 'payload-hash',
      routing_decision_id: 'route-stop',
      selected_resource_id: 'RESOURCE-STOP',
      selected_provider_id: 'PROVIDER-STOP',
      instruction_payload_hash: 'instruction-hash',
      context_manifest_hash: 'context-hash',
      canonical_instructions_json: '[]',
      context_files_json: '[]',
      canonical_payload_json: null,
      status: 'AUTHORIZED',
      created_at: createdAt,
      dispatched_at: null,
      task_ownership_epoch: 1,
      assignment_id: null,
      lifecycle_version: null,
    });
    expect(fence.bindAuthorization('AUTH-STOP-STALE', 'PROJ-STOP-A', 0).admitted).toBe(true);

    fence.requestStopForProject('PROJ-STOP-A', 'stop before claim');

    expect(() => repo.claimExecutionAuthorization('AUTH-STOP-STALE', now())).toThrow('PROJECT_STOP_FENCE_REJECTED');
    expect(repo.getExecutionAuthorization('AUTH-STOP-STALE')?.status).toBe('AUTHORIZED');
    expect(fence.assertDispatchAdmission('AUTH-STOP-STALE')).toMatchObject({ admitted: false, epoch: 1 });
  });
});
