import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { EventService } from '../src/core/services/EventService';
import { TaskService, captureAuthorizedTaskTransitionBinding } from '../src/core/services/TaskService';
import { GitService } from '../src/core/services/GitService';
import { ProgressService } from '../src/core/services/ProgressService';
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

    vi.spyOn(GitService, 'getHeadSha').mockResolvedValue({ status: 'SUCCESS', sha: 'commit-sha-123' });

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
    vi.restoreAllMocks();
    db.close();
  });

  it('commits one authorized transition and replays only its still-current exact result', () => {
    const binding = captureAuthorizedTaskTransitionBinding(repo.getTask('TSK-001')!);
    const first = taskService.transitionAuthorizedTask(binding.taskId, 'START_CODING', binding);
    expect(first.success).toBe(true);
    const committed = repo.getTask(binding.taskId)!;
    expect(committed.state).toBe('CODING');
    expect(taskService.transitionAuthorizedTask(binding.taskId, 'START_CODING', binding)).toMatchObject({
      success: true, isDuplicate: true, task: committed,
    });
    expect(repo.getEvents(binding.projectId).filter((e) => e.type === 'AUTHORIZED_AUTONOMY_TASK_TRANSITION')).toHaveLength(1);
    const current = captureAuthorizedTaskTransitionBinding(committed);
    expect(taskService.transitionAuthorizedTask(current.taskId, 'SUBMIT_REPORT', current).success).toBe(true);
    const after = repo.getTask(binding.taskId);
    expect(taskService.transitionAuthorizedTask(binding.taskId, 'START_CODING', binding)).toMatchObject({
      success: false, errorCode: 'STALE_TASK_TRANSITION',
    });
    expect(repo.getTask(binding.taskId)).toEqual(after);
  });

  it('allows one winner for two same-epoch conflicting callers without duplicate events', async () => {
    const binding = captureAuthorizedTaskTransitionBinding(repo.getTask('TSK-001')!);
    const results = await Promise.all([
      Promise.resolve().then(() => taskService.transitionAuthorizedTask(binding.taskId, 'START_CODING', binding)),
      Promise.resolve().then(() => taskService.transitionAuthorizedTask(binding.taskId, 'APPROVE', binding)),
    ]);
    expect(results.map((r) => r.success)).toEqual([true, false]);
    expect(results[1].errorCode).toBe('STALE_TASK_TRANSITION');
    expect(repo.getTask(binding.taskId)?.state).toBe('CODING');
    expect(repo.getEvents(binding.projectId).filter((e) => e.type === 'AUTHORIZED_AUTONOMY_TASK_TRANSITION')).toHaveLength(1);
  });

  it.each(['project', 'revision', 'state', 'epoch', 'policy', 'paused'])(
    'rejects stale %s binding without task or event writes', (field) => {
      const binding = captureAuthorizedTaskTransitionBinding(repo.getTask('TSK-001')!);
      const stale = { ...binding };
      if (field === 'project') stale.projectId = 'different-project';
      if (field === 'revision') stale.expectedRevision += 1;
      if (field === 'state') stale.expectedState = 'APPROVED';
      if (field === 'epoch') stale.expectedOwnershipEpoch += 1;
      if (field === 'policy') stale.expectedMaxRevisions += 1;
      if (field === 'paused') stale.expectedPausedFromState = 'CODING';
      const before = repo.getTask(binding.taskId);
      const events = repo.getEvents(binding.projectId);
      expect(taskService.transitionAuthorizedTask(binding.taskId, 'START_CODING', stale)).toMatchObject({
        success: false, errorCode: 'STALE_TASK_TRANSITION',
      });
      expect(repo.getTask(binding.taskId)).toEqual(before);
      expect(repo.getEvents(binding.projectId)).toEqual(events);
    },
  );

  it('rejects ID-only and cross-task bindings before any mutation', () => {
    const binding = captureAuthorizedTaskTransitionBinding(repo.getTask('TSK-001')!);
    const before = repo.getTask(binding.taskId);
    for (const invalid of [1, null, {}, { ...binding, taskId: 'another-task' }, { ...binding, expectedRevision: Number.NaN }]) {
      expect(taskService.transitionAuthorizedTask(binding.taskId, 'START_CODING', invalid as typeof binding)).toMatchObject({
        success: false, errorCode: 'INVALID_TASK_TRANSITION_BINDING',
      });
    }
    expect(repo.getTask(binding.taskId)).toEqual(before);
    expect(repo.getEvents(binding.projectId)).toHaveLength(0);
    expect(Object.isFrozen(binding)).toBe(true);
  });

  it('rolls task state and revision back if transition event persistence fails', () => {
    repo.updateTaskState('TSK-001', 'CODING');
    const binding = captureAuthorizedTaskTransitionBinding(repo.getTask('TSK-001')!);
    const before = repo.getTask(binding.taskId);
    vi.spyOn(repo, 'createDeterministicGenericEvent').mockImplementationOnce(() => { throw new Error('injected event failure'); });
    expect(taskService.transitionAuthorizedTask(binding.taskId, 'TESTS_FAILED', binding)).toMatchObject({
      success: false, errorCode: 'TASK_TRANSITION_FAILED',
    });
    expect(repo.getTask(binding.taskId)).toEqual(before);
    expect(repo.getEvents(binding.projectId)).toHaveLength(0);
    expect(taskService.transitionAuthorizedTask(binding.taskId, 'TESTS_FAILED', binding)).toMatchObject({
      success: true, task: expect.objectContaining({ state: 'CODING', revision_count: 1 }),
    });
  });

  it('keeps a no-op START_CODING repeat idempotent with exactly one event', () => {
    repo.updateTaskState('TSK-001', 'CODING');
    const binding = captureAuthorizedTaskTransitionBinding(repo.getTask('TSK-001')!);
    expect(taskService.transitionAuthorizedTask(binding.taskId, 'START_CODING', binding).success).toBe(true);
    const before = repo.getTask(binding.taskId);
    expect(taskService.transitionAuthorizedTask(binding.taskId, 'START_CODING', binding).isDuplicate).toBe(true);
    expect(repo.getTask(binding.taskId)).toEqual(before);
    expect(repo.getEvents(binding.projectId)).toHaveLength(1);
  });

  it('enforces every binding field in the repository SQL CAS boundary', () => {
    const binding = captureAuthorizedTaskTransitionBinding(repo.getTask('TSK-001')!);
    for (const invalid of [
      { ...binding, projectId: 'different-project' },
      { ...binding, expectedOwnershipEpoch: 2 },
      { ...binding, expectedRevision: 1 },
      { ...binding, expectedState: 'CODING' as const },
      { ...binding, expectedPausedFromState: 'CODING' as const },
      { ...binding, expectedMaxRevisions: 4 },
    ]) expect(repo.compareAndSwapAuthorizedTaskState(invalid, 'APPROVED', null, false)).toBe(false);
    expect(repo.getTask(binding.taskId)?.state).toBe('PLANNED');
    expect(repo.compareAndSwapAuthorizedTaskState(binding, 'APPROVED', null, false)).toBe(true);
  });

  it('should apply manager EXECUTE decision, bind HEAD SHA, and transition task to CODING', async () => {
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

    const res = await taskService.applyManagerDecision(managerMsg, JSON.stringify(managerMsg));
    expect(res.success).toBe(true);

    const updated = repo.getTask('TSK-001')!;
    expect(updated.state).toBe('CODING');
    expect(updated.base_sha).toBe('commit-sha-123');
  });

  it('should be idempotent when duplicate message ID is received', async () => {
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

    const res1 = await taskService.applyManagerDecision(managerMsg, JSON.stringify(managerMsg));
    expect(res1.success).toBe(true);
    expect(res1.isDuplicate).toBeFalsy();

    // Second apply with identical message_id
    const res2 = await taskService.applyManagerDecision(managerMsg, JSON.stringify(managerMsg));
    expect(res2.success).toBe(true);
    expect(res2.isDuplicate).toBe(true);
  });

  it('should compare the canonical manager binding before accepting a duplicate', async () => {
    const managerMsg: ManagerProtocol = {
      protocol: 'manager.v1',
      message_id: 'msg-manager-replay-binding',
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

    await taskService.applyManagerDecision(managerMsg, JSON.stringify(managerMsg));
    const taskBeforeConflicts = repo.getTask('TSK-001')!;
    const ledgerBeforeConflicts = repo.getProtocolMessagesByTask('TSK-001');

    taskService.createTask({ projectId: 'PROJ-TEST', id: 'TSK-002', title: 'Other task' });
    const conflictVariants: Array<[string, ManagerProtocol]> = [
      ['payload', { ...managerMsg, instructions: ['replace the approved instructions'] }],
      ['protocol', { ...managerMsg, protocol: 'coder.v1' as 'manager.v1' }],
      ['project', { ...managerMsg, project_id: 'PROJ-OTHER' }],
      ['task', { ...managerMsg, task_id: 'TSK-002' }],
      ['state binding', { ...managerMsg, expected_task_state: 'CODING' }],
      ['revision binding', { ...managerMsg, expected_revision: 1 }],
    ];

    for (const [field, conflictingMessage] of conflictVariants) {
      const result = await taskService.applyManagerDecision(
        conflictingMessage,
        JSON.stringify(conflictingMessage),
      );
      expect(result.success, field).toBe(false);
      expect(result.errorCode, field).toBe('PROTOCOL_REPLAY_CONFLICT');
      expect(result.error, field).toContain('PROTOCOL_REPLAY_CONFLICT');
      expect(repo.getTask('TSK-001'), field).toEqual(taskBeforeConflicts);
      expect(repo.getProtocolMessagesByTask('TSK-001'), field).toEqual(ledgerBeforeConflicts);
    }

    // The payload hash is canonicalized from the validated protocol object,
    // so JSON key order/whitespace in the transport envelope is irrelevant.
    const reorderedRawPayload = JSON.stringify({
      expected_revision: managerMsg.expected_revision,
      expected_task_state: managerMsg.expected_task_state,
      ...managerMsg,
    });
    const duplicate = await taskService.applyManagerDecision(managerMsg, reorderedRawPayload);
    expect(duplicate).toMatchObject({ success: true, isDuplicate: true });
    expect(repo.getProtocolMessagesByTask('TSK-001')).toEqual(ledgerBeforeConflicts);
  });

  it('should compare the canonical coder binding before accepting a duplicate', () => {
    repo.updateTaskState('TSK-001', 'CODING');
    const coderMsg: CoderProtocol = {
      protocol: 'coder.v1',
      message_id: 'msg-coder-replay-binding',
      project_id: 'PROJ-TEST',
      task_id: 'TSK-001',
      attempt: 1,
      status: 'COMPLETED',
      completed: ['Done'],
      remaining: [],
      files_claimed_changed: ['auth.ts'],
      tests_claimed: ['npm test'],
      blockers: [],
      review_requested: true,
      expected_task_state: 'CODING',
      expected_revision: 0,
    };

    taskService.applyCoderReport(coderMsg, JSON.stringify(coderMsg));
    const taskBeforeConflicts = repo.getTask('TSK-001')!;
    const ledgerBeforeConflicts = repo.getProtocolMessagesByTask('TSK-001');

    taskService.createTask({ projectId: 'PROJ-TEST', id: 'TSK-002', title: 'Other task' });
    repo.updateTaskState('TSK-002', 'CODING');
    const conflictVariants: Array<[string, CoderProtocol]> = [
      ['payload', { ...coderMsg, completed: ['tampered completion'] }],
      ['protocol', { ...coderMsg, protocol: 'manager.v1' as 'coder.v1' }],
      ['project', { ...coderMsg, project_id: 'PROJ-OTHER' }],
      ['task', { ...coderMsg, task_id: 'TSK-002' }],
      ['state binding', { ...coderMsg, expected_task_state: 'VALIDATING' }],
      ['revision binding', { ...coderMsg, expected_revision: 1 }],
    ];

    for (const [field, conflictingMessage] of conflictVariants) {
      const result = taskService.applyCoderReport(
        conflictingMessage,
        JSON.stringify(conflictingMessage),
      );
      expect(result.success, field).toBe(false);
      expect(result.errorCode, field).toBe('PROTOCOL_REPLAY_CONFLICT');
      expect(result.error, field).toContain('PROTOCOL_REPLAY_CONFLICT');
      expect(repo.getTask('TSK-001'), field).toEqual(taskBeforeConflicts);
      expect(repo.getProtocolMessagesByTask('TSK-001'), field).toEqual(ledgerBeforeConflicts);
    }
  });

  it('should allow only one winner when concurrent manager replays disagree', async () => {
    const original: ManagerProtocol = {
      protocol: 'manager.v1',
      message_id: 'msg-manager-concurrent-replay',
      project_id: 'PROJ-TEST',
      task_id: 'TSK-001',
      decision: 'EXECUTE',
      priority: 'HIGH',
      risk: 'MEDIUM',
      instructions: ['approved'],
      acceptance_criteria: [],
      constraints: [],
      review_issues: [],
      expected_task_state: 'PLANNED',
      expected_revision: 0,
    };
    const conflicting = { ...original, instructions: ['attacker payload'] };

    const results = await Promise.all([
      taskService.applyManagerDecision(original, JSON.stringify(original)),
      taskService.applyManagerDecision(conflicting, JSON.stringify(conflicting)),
    ]);

    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(results.filter((result) => result.errorCode === 'PROTOCOL_REPLAY_CONFLICT')).toHaveLength(1);
    expect(repo.getTask('TSK-001')!.state).toBe('CODING');
    const ledger = repo.getProtocolMessagesByTask('TSK-001');
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe('APPLIED');
  });

  it('should reject stale Manager decision targeting obsolete task state', async () => {
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

    const res = await taskService.applyManagerDecision(managerMsg, JSON.stringify(managerMsg));
    expect(res.success).toBe(false);
    expect(res.error).toContain('Stale state conflict');
  });

  it('should reject cross-project protocol message targeting wrong project', async () => {
    const managerMsg: ManagerProtocol = {
      protocol: 'manager.v1',
      message_id: 'msg-xproj-1',
      project_id: 'PROJ-OTHER',
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

    const res = await taskService.applyManagerDecision(managerMsg, JSON.stringify(managerMsg));
    expect(res.success).toBe(false);
    expect(res.error).toContain('Cross-project conflict');
  });

  it('should process coder report and transition task to VALIDATING', () => {
    // First move task to CODING
    repo.updateTaskState('TSK-001', 'CODING');

    const coderMsg: CoderProtocol = {
      protocol: 'coder.v1',
      message_id: 'msg-coder-1',
      project_id: 'PROJ-TEST',
      task_id: 'TSK-001',
      attempt: 1,
      status: 'COMPLETED',
      completed: ['Done JWT'],
      remaining: [],
      files_claimed_changed: ['auth.ts'],
      tests_claimed: ['npm test'],
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
    repo.updateTaskState('TSK-001', 'CODING', null, true); // revision_count is now 1

    const coderMsg: CoderProtocol = {
      protocol: 'coder.v1',
      message_id: 'msg-coder-stale-rev',
      project_id: 'PROJ-TEST',
      task_id: 'TSK-001',
      attempt: 1,
      status: 'COMPLETED',
      completed: [],
      remaining: [],
      files_claimed_changed: [],
      tests_claimed: [],
      blockers: [],
      review_requested: true,
      expected_task_state: 'CODING',
      expected_revision: 0, // Stale!
    };

    const res = taskService.applyCoderReport(coderMsg, JSON.stringify(coderMsg));
    expect(res.success).toBe(false);
    expect(res.error).toContain('Stale revision conflict');
  });

  it('should rollback transaction on injected failure and allow clean retry', async () => {
    const managerMsg: ManagerProtocol = {
      protocol: 'manager.v1',
      message_id: 'msg-rollback-test',
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

    // Inject a failure during transaction by mocking updateTaskProgressCache
    const originalProgress = repo.updateTaskProgressCache.bind(repo);
    vi.spyOn(repo, 'updateTaskProgressCache').mockImplementationOnce(() => {
      throw new Error('Injected SQLite Crash during transaction');
    });

    const res = await taskService.applyManagerDecision(managerMsg, JSON.stringify(managerMsg));
    expect(res.success).toBe(false);
    expect(res.error).toContain('Injected SQLite Crash');

    // Verify task state was NOT updated (clean rollback!)
    const taskAfterFail = repo.getTask('TSK-001')!;
    expect(taskAfterFail.state).toBe('PLANNED');

    // Verify protocol message was NOT permanently committed
    const msgRecord = repo.getProtocolMessageById('msg-rollback-test');
    expect(msgRecord).toBeNull();

    // Now retry cleanly without failure
    const retryRes = await taskService.applyManagerDecision(managerMsg, JSON.stringify(managerMsg));
    expect(retryRes.success).toBe(true);
    expect(repo.getTask('TSK-001')!.state).toBe('CODING');
  });

  it('should transition REVIEW_READY to REVIEWING via startReview', () => {
    repo.updateTaskState('TSK-001', 'REVIEW_READY');

    const res = taskService.startReview('TSK-001');
    expect(res.success).toBe(true);
    expect(res.task!.state).toBe('REVIEWING');
    expect(repo.getTask('TSK-001')!.state).toBe('REVIEWING');
  });

  it('serializes concurrent review starts into one authoritative transition and event', () => {
    repo.updateTaskState('TSK-001', 'REVIEW_READY');
    const task = repo.getTask('TSK-001')!;
    const binding = {
      expectedRevision: task.revision_count,
      expectedOwnershipEpoch: task.ownership_epoch ?? 1,
      expectedState: task.state,
      executionId: 'review-execution-1',
    };

    const first = taskService.startReview(task.id, task.project_id, binding);
    const second = taskService.startReview(task.id, task.project_id, {
      ...binding,
      executionId: 'review-execution-2',
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.task?.state).toBe('REVIEWING');
    expect(repo.getEvents(task.project_id, 100).filter((event) => event.type === 'REVIEW_STARTED')).toHaveLength(1);
  });

  it('discards a validation result after ownership reassignment without writing evidence or TestRun', async () => {
    repo.updateTaskState('TSK-001', 'VALIDATING');
    vi.spyOn(GitService, 'getStatus').mockResolvedValue({
      status: 'SUCCESS',
      branch: 'main',
      isClean: true,
      modifiedFiles: [],
      untrackedFiles: [],
      aheadCount: 0,
      behindCount: 0,
    });
    vi.spyOn(GitService, 'getDiff').mockResolvedValue({
      status: 'SUCCESS',
      diffStat: '',
      diffContent: '',
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    });

    let releaseTestRun!: () => void;
    let entered!: () => void;
    const testStarted = new Promise<void>((resolve) => { entered = resolve; });
    const testRelease = new Promise<void>((resolve) => { releaseTestRun = resolve; });
    const verificationService = {
      getArtifactStore: () => undefined,
      runTests: vi.fn(async () => {
        entered();
        await testRelease;
        return {
          id: 'stale-test-run',
          task_id: 'TSK-001',
          command: 'npm test',
          passed_count: 1,
          failed_count: 0,
          skipped_count: 0,
          duration_ms: 1,
          exit_code: 0,
          evidence_id: 'stale-test-evidence',
          created_at: new Date().toISOString(),
          pending_evidence: {
            id: 'stale-test-evidence',
            project_id: 'PROJ-TEST',
            task_id: 'TSK-001',
            attempt_id: null,
            evidence_type: 'TEST_RESULT',
            storage_type: 'INLINE',
            file_path: null,
            hash: 'stale-hash',
            byte_size: 0,
            content_type: 'text/plain',
            summary: 'stale',
            raw_payload: '',
            created_at: new Date().toISOString(),
          },
        };
      }),
    };
    const fencedTaskService = new TaskService(repo, eventService, verificationService as any);
    const task = repo.getTask('TSK-001')!;
    const validation = fencedTaskService.executeValidationFlow(task.id, undefined, task.project_id, {
      expectedRevision: task.revision_count,
      expectedOwnershipEpoch: task.ownership_epoch ?? 1,
      expectedState: task.state,
      executionId: 'validation-execution-stale',
    });

    await testStarted;
    expect(repo.bumpTaskOwnershipEpoch(task.id, task.ownership_epoch ?? 1).success).toBe(true);
    releaseTestRun();
    const result = await validation;

    expect(result).toMatchObject({
      success: false,
      stale: true,
      executionId: 'validation-execution-stale',
      error: 'STALE_VALIDATION_RESULT',
    });
    expect(repo.getTask(task.id)?.state).toBe('VALIDATING');
    expect(repo.getLatestTestRun(task.id)).toBeNull();
    expect(repo.getEvidenceByTask(task.id)).toHaveLength(0);
    expect(repo.getEvents(task.project_id, 100).some((event) => event.type === 'VALIDATION_STALE_RESULT')).toBe(true);
  });

  it('discards validation evidence when repository HEAD changes during test execution', async () => {
    repo.updateTaskState('TSK-001', 'VALIDATING');
    vi.spyOn(GitService, 'getStatus').mockResolvedValue({
      status: 'SUCCESS',
      branch: 'main',
      isClean: false,
      modifiedFiles: ['feature.ts'],
      untrackedFiles: [],
      aheadCount: 0,
      behindCount: 0,
    });
    vi.spyOn(GitService, 'getDiff').mockResolvedValue({
      status: 'SUCCESS',
      diffStat: '1 file changed',
      diffContent: 'diff --git a/feature.ts b/feature.ts',
      filesChanged: ['feature.ts'],
      insertions: 1,
      deletions: 0,
    });
    vi.mocked(GitService.getHeadSha)
      .mockResolvedValueOnce({ status: 'SUCCESS', sha: 'sha-before-tests' })
      .mockResolvedValueOnce({ status: 'SUCCESS', sha: 'sha-after-tests' });

    const verificationService = {
      getArtifactStore: () => undefined,
      runTests: vi.fn(async () => ({
        id: 'head-drift-test-run',
        task_id: 'TSK-001',
        command: 'npm test',
        passed_count: 1,
        failed_count: 0,
        skipped_count: 0,
        duration_ms: 1,
        exit_code: 0,
        evidence_id: 'head-drift-test-evidence',
        created_at: new Date().toISOString(),
        pending_evidence: {
          id: 'head-drift-test-evidence',
          project_id: 'PROJ-TEST',
          task_id: 'TSK-001',
          attempt_id: null,
          evidence_type: 'TEST_RESULT',
          storage_type: 'INLINE',
          file_path: null,
          hash: 'head-drift-hash',
          byte_size: 0,
          content_type: 'text/plain',
          summary: 'head drift',
          raw_payload: '',
          created_at: new Date().toISOString(),
        },
      })),
    };
    const fencedTaskService = new TaskService(repo, eventService, verificationService as any);
    const task = repo.getTask('TSK-001')!;
    const result = await fencedTaskService.executeValidationFlow(task.id, undefined, task.project_id, {
      expectedRevision: task.revision_count,
      expectedOwnershipEpoch: task.ownership_epoch ?? 1,
      expectedState: task.state,
      executionId: 'head-drift-execution',
    });

    expect(result).toMatchObject({
      success: false,
      stale: true,
      executionId: 'head-drift-execution',
      error: 'STALE_VALIDATION_RESULT',
    });
    expect(repo.getTask(task.id)?.state).toBe('VALIDATING');
    expect(repo.getLatestTestRun(task.id)).toBeNull();
    expect(repo.getEvidenceByTask(task.id)).toHaveLength(0);
    expect(repo.getEvents(task.project_id, 100).some((event) => event.type === 'VALIDATION_STALE_RESULT')).toBe(true);
  });

  it('should NOT award test progress or fake lint pass when Manager PASS is applied without passing TestRun evidence', async () => {
    repo.updateTaskState('TSK-001', 'REVIEWING');

    // No TestRun was ever recorded for TSK-001
    expect(repo.getLatestTestRun('TSK-001')).toBeNull();

    const managerPassMsg: ManagerProtocol = {
      protocol: 'manager.v1',
      message_id: 'msg-pass-no-test',
      project_id: 'PROJ-TEST',
      task_id: 'TSK-001',
      decision: 'PASS',
      priority: 'HIGH',
      risk: 'MEDIUM',
      instructions: ['Manual owner approval without automated tests'],
      acceptance_criteria: [],
      constraints: [],
      review_issues: [],
      expected_task_state: 'REVIEWING',
      expected_revision: 0,
    };

    const res = await taskService.applyManagerDecision(managerPassMsg, JSON.stringify(managerPassMsg));
    expect(res.success).toBe(true);

    const taskDone = repo.getTask('TSK-001')!;
    expect(taskDone.state).toBe('DONE');

    // Re-evaluate breakdown: targetedTesting MUST be 0 and regressionAndLint MUST be 0
    const latestTest = repo.getLatestTestRun('TSK-001');
    const latestDiffEv = repo.getLatestEvidence('TSK-001', 'GIT_DIFF');
    const breakdown = ProgressService.calculateTaskProgress(taskDone, {
      hasGitDiff: Boolean(latestDiffEv) || taskDone.current_sha !== null,
      testsPassed: latestTest?.exit_code === 0,
      hasEvidence: Boolean(latestDiffEv),
      excludeUnconfiguredLint: true,
      lintPassed: false,
    });

    expect(breakdown.breakdown.targetedTesting).toBe(0);
    expect(breakdown.breakdown.regressionAndLint).toBe(0);
    expect(breakdown.breakdown.managerReview).toBe(10);
    // Planning (10) + ManagerReview (10) = 20 points earned out of 85 applicable = 24%
    expect(taskDone.progress_cache_percent).toBe(24);
  });

  it('atomically fences concurrent Manager decisions with the same state and revision', async () => {
    const managerMessages: ManagerProtocol[] = ['msg-manager-race-a', 'msg-manager-race-b'].map((message_id) => ({
      protocol: 'manager.v1',
      message_id,
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
    }));

    const results = await Promise.all(
      managerMessages.map((message) => taskService.applyManagerDecision(message, JSON.stringify(message)))
    );

    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(results.filter((result) => !result.success)).toHaveLength(1);
    expect(results.find((result) => !result.success)?.error).toMatch(/Stale (state|task) conflict/);

    const task = repo.getTask('TSK-001')!;
    expect(task.state).toBe('CODING');
    expect(task.revision_count).toBe(0);

    const ledger = repo.getProtocolMessagesByTask('TSK-001');
    expect(ledger).toHaveLength(2);
    expect(ledger.filter((message) => message.status === 'APPLIED')).toHaveLength(1);
    expect(ledger.filter((message) => message.status === 'REJECTED')).toHaveLength(1);
  });

  it('atomically fences concurrent Coder reports with the same state and revision', async () => {
    repo.updateTaskState('TSK-001', 'CODING');
    const coderMessages: CoderProtocol[] = ['msg-coder-race-a', 'msg-coder-race-b'].map((message_id) => ({
      protocol: 'coder.v1',
      message_id,
      project_id: 'PROJ-TEST',
      task_id: 'TSK-001',
      attempt: 1,
      status: 'COMPLETED',
      completed: ['Done'],
      remaining: [],
      files_claimed_changed: ['auth.ts'],
      tests_claimed: ['npm test'],
      blockers: [],
      review_requested: true,
      expected_task_state: 'CODING',
      expected_revision: 0,
    }));

    const results = await Promise.all(
      coderMessages.map((message) => Promise.resolve().then(() => taskService.applyCoderReport(message, JSON.stringify(message))))
    );

    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(results.filter((result) => !result.success)).toHaveLength(1);
    expect(results.find((result) => !result.success)?.error).toMatch(/Stale (state|task) conflict/);

    const task = repo.getTask('TSK-001')!;
    expect(task.state).toBe('VALIDATING');
    expect(task.revision_count).toBe(0);

    const ledger = repo.getProtocolMessagesByTask('TSK-001');
    expect(ledger).toHaveLength(2);
    expect(ledger.filter((message) => message.status === 'APPLIED')).toHaveLength(1);
    expect(ledger.filter((message) => message.status === 'REJECTED')).toHaveLength(1);
  });
});
