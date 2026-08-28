import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import {
  HandoffTransferService,
  HandoffRequestParams,
  HandoffFreezeParams,
  HandoffBeginQuiescenceParams,
  HandoffRelinquishParams,
  HandoffCancelParams,
} from '../src/core/services/HandoffTransferService';
import {
  Task,
  TaskAttempt,
  ExecutionAuthorization,
  AgentAssignment,
  Checkpoint,
  AdapterOutcome,
  ProviderTerminationStatus,
} from '../src/core/types/domain';

describe('R5I2 Predecessor Handoff Freeze, Quiescence, and Relinquishment', () => {
  let db: Database.Database;
  let repo: Repository;
  let service: HandoffTransferService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    service = new HandoffTransferService(repo);
  });

  afterEach(() => {
    db.close();
  });

  // Helper to seed base project, task, role, account, resource, attempt, assignment
  function seedBaseEntities(params?: {
    taskId?: string;
    attemptId?: string;
    assignmentId?: string;
    ownershipEpoch?: number;
  }) {
    const taskId = params?.taskId ?? 'task-1';
    const attemptId = params?.attemptId ?? 'att-1';
    const assignmentId = params?.assignmentId ?? 'asgn-1';
    const epoch = params?.ownershipEpoch ?? 1;
    const nowIso = '2026-08-28T00:00:00Z';

    repo.createProject({
      id: 'proj-1',
      name: 'Project 1',
      description: null,
      repository_path: '/repo',
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: nowIso,
      updated_at: nowIso,
      started_at: nowIso,
      completed_at: null,
    });

    repo.createRoleProfile({
      id: 'rp-coder',
      role: 'CODER',
      display_name: 'Coder Role',
      authority_scope: {},
      output_protocol: 'coder.v1',
      required_capabilities: [],
      preferred_capabilities: [],
      permissions: [],
      enabled: true,
      created_at: nowIso,
      updated_at: nowIso,
    });

    repo.createAgentProfile({
      id: 'prof-1',
      role_profile_id: 'rp-coder',
      name: 'Primary Coder',
      prompt_template: 'coder-prompt',
      config: {},
      enabled: true,
      created_at: nowIso,
      updated_at: nowIso,
    });

    repo.createProvider({
      id: 'prov-1',
      name: 'Provider 1',
      adapter_type: 'API',
      enabled: true,
      created_at: nowIso,
    });

    repo.createProviderAccount({
      id: 'acc-1',
      provider_id: 'prov-1',
      label: 'Account 1',
      auth_mode: 'NATIVE_PROFILE',
      credential_ref: null,
      profile_ref: 'native-profile://test-provider/default',
      health_status: 'AVAILABLE',
      priority: 100,
      cooldown_until: null,
      concurrency_limit: 5,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      enabled: true,
      created_at: nowIso,
      updated_at: nowIso,
    });

    repo.createProviderResource({
      id: 'res-1',
      provider_id: 'prov-1',
      provider_account_id: 'acc-1',
      model_name: 'claude-3-5-sonnet',
      health_status: 'AVAILABLE',
      capabilities: [],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'TOKENS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 0,
      last_health_check: null,
    });

    repo.createTask({
      id: taskId,
      project_id: 'proj-1',
      milestone_id: null,
      title: 'Task Title',
      description: null,
      state: 'CODING',
      paused_from_state: null,
      priority: 'MEDIUM',
      risk: 'LOW',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 5,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 0.0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      ownership_epoch: epoch,
      created_at: nowIso,
      updated_at: nowIso,
    });

    repo.createTaskAttempt({
      id: attemptId,
      task_id: taskId,
      attempt_number: 1,
      agent_id: null,
      agent_profile_id: 'prof-1',
      status: 'RUNNING',
      started_at: nowIso,
      ended_at: null,
      summary: 'Summary',
    });

    repo.createAgentAssignment({
      id: assignmentId,
      project_id: 'proj-1',
      task_id: taskId,
      attempt_id: attemptId,
      role_profile_id: 'rp-coder',
      agent_profile_id: 'prof-1',
      selected_provider_id: 'prov-1',
      selected_account_id: 'acc-1',
      selected_resource_id: 'res-1',
      selected_worker_slot_id: null,
      routing_decision_id: null,
      preferred_metadata: {},
      status: 'ASSIGNED',
      created_at: nowIso,
      ended_at: null,
    });

    repo.recordProtocolMessage(
      'msg-1',
      'msg-id-1',
      'manager.v1',
      'proj-1',
      taskId,
      'CODING',
      0,
      'payload-hash-1',
      '{}',
      'APPLIED',
      undefined,
      nowIso
    );

    return { taskId, attemptId, assignmentId, epoch };
  }

  // Helper to create an execution authorization
  function seedExecutionAuth(params: {
    authId: string;
    taskId: string;
    attemptId: string;
    epoch?: number;
    status?: 'AUTHORIZED' | 'DISPATCHED';
    executionId?: string;
    adapterStartedAt?: string | null;
    adapterFinishedAt?: string | null;
    adapterOutcome?: AdapterOutcome | null;
    cancellationRequestedAt?: string | null;
    terminationConfirmedAt?: string | null;
    terminationStatus?: ProviderTerminationStatus | null;
    terminationSource?: string | null;
  }) {
    const epoch = params.epoch ?? 1;
    const status = params.status ?? 'AUTHORIZED';

    db.prepare(`
      INSERT INTO execution_authorizations (
        id, project_id, task_id, attempt_id, task_revision, base_sha,
        repository_head_sha, manager_message_id, manager_payload_hash,
        routing_decision_id, selected_resource_id, selected_provider_id,
        instruction_payload_hash, context_manifest_hash,
        canonical_instructions_json, context_files_json, canonical_payload_json, status,
        task_ownership_epoch, execution_id, adapter_started_at, adapter_finished_at,
        adapter_outcome, cancellation_requested_at, termination_confirmed_at,
        termination_status, termination_source, created_at, dispatched_at
      ) VALUES (
        ?, 'proj-1', ?, ?, 0, 'sha-base',
        'sha-head', 'msg-1', 'hash-1',
        'rd-1', 'res-1', 'prov-1',
        'inst-hash', 'ctx-hash',
        '{}', '[]', '{}', ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, '2026-08-28T00:00:00Z', ?
      )
    `).run(
      params.authId,
      params.taskId,
      params.attemptId,
      status,
      epoch,
      params.executionId ?? null,
      params.adapterStartedAt ?? null,
      params.adapterFinishedAt ?? null,
      params.adapterOutcome ?? null,
      params.cancellationRequestedAt ?? null,
      params.terminationConfirmedAt ?? null,
      params.terminationStatus ?? null,
      params.terminationSource ?? null,
      status === 'DISPATCHED' ? '2026-08-28T00:01:00Z' : null
    );
  }

  // =========================================================================
  // Section 1: Predecessor Handoff Request & Validation (Tests 1..4)
  // =========================================================================
  describe('Predecessor Handoff Request & Validation', () => {
    it('1. request with correct source epoch succeeds', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      const res = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Context window nearing exhaustion',
        expectedSourceEpoch: 1,
      });

      expect(res.success).toBe(true);
      expect(res.duplicate).toBe(false);
      expect(res.transfer).toBeDefined();
      expect(res.transfer?.status).toBe('REQUESTED');
      expect(res.transfer?.source_ownership_epoch).toBe(1);
      expect(res.transfer?.source_attempt_id).toBe('att-1');
      expect(res.transfer?.source_assignment_id).toBe('asgn-1');
      expect(res.transfer?.version).toBe(1);
      expect(res.transfer?.handoff_context_id).toBeNull();
      expect(res.transfer?.successor_attempt_id).toBeNull();

      // Verify task ownership epoch remains 1
      expect(repo.getTaskOwnershipEpoch('task-1')).toBe(1);
    });

    it('2. request-id identical replay idempotent', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      const res1 = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Context window nearing exhaustion',
        expectedSourceEpoch: 1,
      });
      expect(res1.success).toBe(true);
      expect(res1.duplicate).toBe(false);

      // Replay identical request
      const res2 = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Context window nearing exhaustion',
        expectedSourceEpoch: 1,
      });

      expect(res2.success).toBe(true);
      expect(res2.duplicate).toBe(true);
      expect(res2.transfer?.id).toBe(res1.transfer?.id);
      expect(res2.transfer?.version).toBe(1);
    });

    it('3. request-id conflicting replay fails closed', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      const res1 = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Reason A',
        expectedSourceEpoch: 1,
      });
      expect(res1.success).toBe(true);

      // Same request-id with conflicting reason
      const res2 = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Reason B (Conflicting)',
        expectedSourceEpoch: 1,
      });

      expect(res2.success).toBe(false);
      expect(res2.duplicate).toBe(false);
      expect(res2.errorCode).toBe('REQUEST_ID_CONFLICT');
      expect(res2.error).toContain('REQUEST_ID_CONFLICT');
    });

    it('4. stale source ownership epoch request rejected', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 2 });

      const res = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Stale epoch request',
        expectedSourceEpoch: 1, // Stale! Current task epoch is 2
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('STALE_OWNERSHIP_EPOCH');
      expect(res.error).toContain('STALE_OWNERSHIP_EPOCH');
    });

    it('4b. request with terminal assignment or mismatching task fails closed', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      // Mark assignment HANDED_OFF
      repo.updateAgentAssignmentStatus('asgn-1', 'HANDED_OFF');

      const res = service.requestHandoff({
        requestId: 'req-term',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Attempt with terminal assignment',
        expectedSourceEpoch: 1,
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe('ASSIGNMENT_TERMINAL');
    });
  });

  // =========================================================================
  // Section 2: Freeze Predecessor Authority & Bindings (Tests 5..9)
  // =========================================================================
  describe('Freeze Predecessor Authority & Bindings', () => {
    it('5. REQUESTED -> FROZEN succeeds with valid checkpoint and authorization bindings', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      // Seed checkpoint
      repo.createCheckpoint({
        id: 'cp-1',
        task_id: 'task-1',
        attempt_id: 'att-1',
        sha: 'sha-checkpoint',
        tree_metadata: {},
        completed_steps: ['step 1'],
        remaining_steps: ['step 2'],
        tests_passing: 10,
        tests_failing: 0,
        known_issues: [],
        recommended_next_action: null,
        created_at: '2026-08-28T00:05:00Z',
      });

      // Seed authorization
      seedExecutionAuth({
        authId: 'auth-1',
        taskId: 'task-1',
        attemptId: 'att-1',
        epoch: 1,
        status: 'DISPATCHED',
      });

      const reqRes = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Freeze test',
        expectedSourceEpoch: 1,
      });
      expect(reqRes.success).toBe(true);
      const transferId = reqRes.transfer!.id;

      // Freeze handoff
      const freezeRes = service.freezeHandoff({
        transferId,
        expectedVersion: 1,
        checkpointId: 'cp-1',
        sourceAuthorizationId: 'auth-1',
      });

      expect(freezeRes.success).toBe(true);
      expect(freezeRes.transfer?.status).toBe('FROZEN');
      expect(freezeRes.transfer?.version).toBe(2);
      expect(freezeRes.transfer?.checkpoint_id).toBe('cp-1');
      expect(freezeRes.transfer?.source_authorization_id).toBe('auth-1');
      expect(freezeRes.transfer?.frozen_at).toBeDefined();
      expect(freezeRes.transfer?.handoff_context_id).toBeNull(); // Still NULL in R5I2
    });

    it('6. freeze stale version rejected (CAS failure)', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      const reqRes = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Freeze test',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      // Stale expectedVersion: 99
      const freezeRes = service.freezeHandoff({
        transferId,
        expectedVersion: 99,
      });

      expect(freezeRes.success).toBe(false);
      expect(freezeRes.errorCode).toBe('VERSION_CONFLICT');
    });

    it('7. checkpoint cross-task binding rejected', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      // Checkpoint belonging to task-2
      repo.createTask({
        id: 'task-2',
        project_id: 'proj-1',
        milestone_id: null,
        title: 'Task 2',
        description: null,
        state: 'CODING',
        paused_from_state: null,
        priority: 'MEDIUM',
        risk: 'LOW',
        assigned_agent_id: null,
        revision_count: 0,
        max_revisions: 5,
        base_sha: null,
        current_sha: null,
        progress_cache_percent: 0.0,
        progress_computed_at: null,
        acceptance_criteria: [],
        constraints: [],
        ownership_epoch: 1,
        created_at: '2026-08-28T00:00:00Z',
        updated_at: '2026-08-28T00:00:00Z',
      });
      repo.createCheckpoint({
        id: 'cp-cross',
        task_id: 'task-2',
        attempt_id: null,
        sha: 'sha-cp',
        tree_metadata: {},
        completed_steps: [],
        remaining_steps: [],
        tests_passing: 0,
        tests_failing: 0,
        known_issues: [],
        recommended_next_action: null,
        created_at: '2026-08-28T00:05:00Z',
      });

      const reqRes = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Cross checkpoint test',
        expectedSourceEpoch: 1,
      });

      const freezeRes = service.freezeHandoff({
        transferId: reqRes.transfer!.id,
        expectedVersion: 1,
        checkpointId: 'cp-cross',
      });

      expect(freezeRes.success).toBe(false);
      expect(freezeRes.errorCode).toBe('CHECKPOINT_MISMATCH');
    });

    it('8. source authorization cross-attempt binding rejected', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      // Create attempt 2
      repo.createTaskAttempt({
        id: 'att-2',
        task_id: 'task-1',
        attempt_number: 2,
        agent_id: null,
        agent_profile_id: 'prof-1',
        status: 'RUNNING',
        started_at: '2026-08-28T00:00:00Z',
        ended_at: null,
        summary: 'Summary 2',
      });

      // Auth bound to att-2
      seedExecutionAuth({
        authId: 'auth-att-2',
        taskId: 'task-1',
        attemptId: 'att-2',
        epoch: 1,
      });

      const reqRes = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Cross auth test',
        expectedSourceEpoch: 1,
      });

      const freezeRes = service.freezeHandoff({
        transferId: reqRes.transfer!.id,
        expectedVersion: 1,
        sourceAuthorizationId: 'auth-att-2',
      });

      expect(freezeRes.success).toBe(false);
      expect(freezeRes.errorCode).toBe('AUTHORIZATION_MISMATCH');
    });

    it('9. FROZEN -> QUIESCING succeeds', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      const reqRes = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Quiescence test',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      service.freezeHandoff({ transferId, expectedVersion: 1 });

      const quiesceRes = service.beginQuiescence({
        transferId,
        expectedVersion: 2,
      });

      expect(quiesceRes.success).toBe(true);
      expect(quiesceRes.transfer?.status).toBe('QUIESCING');
      expect(quiesceRes.transfer?.version).toBe(3);
      expect(quiesceRes.transfer?.quiescing_at).toBeDefined();

      // Epoch must still be 1 (no epoch bump yet!)
      expect(repo.getTaskOwnershipEpoch('task-1')).toBe(1);
    });
  });

  // =========================================================================
  // Section 3: Provider-Neutral Quiescence Evaluation (Tests 10..16)
  // =========================================================================
  describe('Provider-Neutral Quiescence Evaluation', () => {
    it('10. no started execution => quiescence safe', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      // Unstarted authorization (adapter_started_at is null)
      seedExecutionAuth({
        authId: 'auth-unstarted',
        taskId: 'task-1',
        attemptId: 'att-1',
        epoch: 1,
        adapterStartedAt: null,
      });

      const reqRes = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Quiescence eval',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      const evalRes = service.evaluatePredecessorQuiescence(transferId);
      expect(evalRes.safeToRelinquish).toBe(true);
      expect(evalRes.authorizations.length).toBe(1);
      expect(evalRes.authorizations[0].state).toBe('NOT_STARTED');
      expect(evalRes.unresolvedAuthorizationIds).toEqual([]);
    });

    it('11. started + CONFIRMED_TERMINATED with non-null timestamp => safe', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      seedExecutionAuth({
        authId: 'auth-terminated',
        taskId: 'task-1',
        attemptId: 'att-1',
        epoch: 1,
        executionId: 'exec-1',
        adapterStartedAt: '2026-08-28T00:02:00Z',
        terminationConfirmedAt: '2026-08-28T00:05:00Z',
        terminationStatus: 'CONFIRMED_TERMINATED',
        terminationSource: 'PROVIDER_API',
      });

      const reqRes = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Quiescence eval',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      const evalRes = service.evaluatePredecessorQuiescence(transferId);
      expect(evalRes.safeToRelinquish).toBe(true);
      expect(evalRes.authorizations[0].state).toBe('CONFIRMED_TERMINATED');
    });

    it('12. started + no termination status => blocked', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      seedExecutionAuth({
        authId: 'auth-running',
        taskId: 'task-1',
        attemptId: 'att-1',
        epoch: 1,
        executionId: 'exec-1',
        adapterStartedAt: '2026-08-28T00:02:00Z',
        terminationStatus: null,
      });

      const reqRes = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Quiescence eval',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      const evalRes = service.evaluatePredecessorQuiescence(transferId);
      expect(evalRes.safeToRelinquish).toBe(false);
      expect(evalRes.authorizations[0].state).toBe('UNRESOLVED_ACTIVE_EXECUTION');
      expect(evalRes.unresolvedAuthorizationIds).toContain('auth-running');
    });

    it('13. started + UNRESOLVED => blocked', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      seedExecutionAuth({
        authId: 'auth-unresolved',
        taskId: 'task-1',
        attemptId: 'att-1',
        epoch: 1,
        executionId: 'exec-1',
        adapterStartedAt: '2026-08-28T00:02:00Z',
        terminationStatus: 'UNRESOLVED',
        terminationSource: 'TIMEOUT',
      });

      const reqRes = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Quiescence eval',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      const evalRes = service.evaluatePredecessorQuiescence(transferId);
      expect(evalRes.safeToRelinquish).toBe(false);
      expect(evalRes.authorizations[0].state).toBe('UNRESOLVED_ACTIVE_EXECUTION');
    });

    it('14. adapter_finished_at without confirmed termination => blocked', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      // Adapter returned outcome COMPLETED, but provider termination has not been confirmed!
      seedExecutionAuth({
        authId: 'auth-finished-only',
        taskId: 'task-1',
        attemptId: 'att-1',
        epoch: 1,
        executionId: 'exec-1',
        adapterStartedAt: '2026-08-28T00:02:00Z',
        adapterFinishedAt: '2026-08-28T00:04:00Z',
        adapterOutcome: 'RETURNED',
        terminationStatus: null,
      });

      const reqRes = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Quiescence eval',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      const evalRes = service.evaluatePredecessorQuiescence(transferId);
      expect(evalRes.safeToRelinquish).toBe(false);
      expect(evalRes.authorizations[0].state).toBe('UNRESOLVED_ACTIVE_EXECUTION');
    });

    it('15. cancellation_requested_at without confirmed termination => blocked', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      seedExecutionAuth({
        authId: 'auth-cancelled-only',
        taskId: 'task-1',
        attemptId: 'att-1',
        epoch: 1,
        executionId: 'exec-1',
        adapterStartedAt: '2026-08-28T00:02:00Z',
        cancellationRequestedAt: '2026-08-28T00:03:00Z',
        terminationStatus: null,
      });

      const reqRes = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Quiescence eval',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      const evalRes = service.evaluatePredecessorQuiescence(transferId);
      expect(evalRes.safeToRelinquish).toBe(false);
      expect(evalRes.authorizations[0].state).toBe('UNRESOLVED_ACTIVE_EXECUTION');
    });

    it('16. one safe + one unresolved execution => blocked', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      // Safe auth
      seedExecutionAuth({
        authId: 'auth-safe',
        taskId: 'task-1',
        attemptId: 'att-1',
        epoch: 1,
        executionId: 'exec-1',
        adapterStartedAt: '2026-08-28T00:02:00Z',
        terminationConfirmedAt: '2026-08-28T00:05:00Z',
        terminationStatus: 'CONFIRMED_TERMINATED',
        terminationSource: 'PROVIDER_API',
      });

      // Unresolved auth
      seedExecutionAuth({
        authId: 'auth-unresolved',
        taskId: 'task-1',
        attemptId: 'att-1',
        epoch: 1,
        executionId: 'exec-2',
        adapterStartedAt: '2026-08-28T00:06:00Z',
        terminationStatus: null,
      });

      const reqRes = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Quiescence eval',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      const evalRes = service.evaluatePredecessorQuiescence(transferId);
      expect(evalRes.safeToRelinquish).toBe(false);
      expect(evalRes.unresolvedAuthorizationIds).toEqual(['auth-unresolved']);
    });
  });

  // =========================================================================
  // Section 4: Atomic Relinquishment Linearization & Ownership Fencing (Tests 17..28)
  // =========================================================================
  describe('Atomic Relinquishment Linearization & Ownership Fencing', () => {
    it('17-20. unresolved execution blocks relinquishment, preserving epoch, assignment, and lease', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      // Acquire active task lease
      repo.acquireTaskLease('task-1', 'prof-1', 'lease-token-1');

      // Unresolved started auth
      seedExecutionAuth({
        authId: 'auth-running',
        taskId: 'task-1',
        attemptId: 'att-1',
        epoch: 1,
        executionId: 'exec-1',
        adapterStartedAt: '2026-08-28T00:02:00Z',
      });

      const reqRes = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Relinquish test',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      service.freezeHandoff({ transferId, expectedVersion: 1 });
      service.beginQuiescence({ transferId, expectedVersion: 2 });

      // Attempt relinquishment with expected lease token
      const relRes = service.relinquishPredecessorOwnership({
        transferId,
        expectedVersion: 3,
        expectedSourceEpoch: 1,
        expectedTaskLeaseToken: 'lease-token-1',
      });

      // 17. Must fail with PREDECESSOR_EXECUTION_UNRESOLVED
      expect(relRes.success).toBe(false);
      expect(relRes.errorCode).toBe('PREDECESSOR_EXECUTION_UNRESOLVED');
      expect(relRes.unresolvedAuthorizations).toEqual(['auth-running']);

      // 18. Blocked relinquishment does NOT bump ownership epoch
      expect(repo.getTaskOwnershipEpoch('task-1')).toBe(1);

      // 19. Blocked relinquishment does NOT mark assignment HANDED_OFF
      const asgn = repo.getAgentAssignment('asgn-1');
      expect(asgn?.status).toBe('ASSIGNED');

      // 20. Blocked relinquishment does NOT release task lease
      const lease = repo.getTaskLease('task-1');
      expect(lease?.released_at).toBeNull();

      // Transfer remains QUIESCING at version 3
      const transfer = repo.getHandoffTransfer(transferId);
      expect(transfer?.status).toBe('QUIESCING');
      expect(transfer?.version).toBe(3);
      expect(transfer?.relinquished_at).toBeNull();
    });

    it('21-26. safe relinquishment atomically bumps epoch, marks assignment HANDED_OFF, releases lease, sets RELINQUISHED & increments version', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      // Acquire task lease
      repo.acquireTaskLease('task-1', 'prof-1', 'lease-token-1');

      // Safe terminated execution
      seedExecutionAuth({
        authId: 'auth-done',
        taskId: 'task-1',
        attemptId: 'att-1',
        epoch: 1,
        executionId: 'exec-1',
        adapterStartedAt: '2026-08-28T00:02:00Z',
        terminationConfirmedAt: '2026-08-28T00:05:00Z',
        terminationStatus: 'CONFIRMED_TERMINATED',
        terminationSource: 'PROVIDER_API',
      });

      const reqRes = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Relinquish test',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      service.freezeHandoff({ transferId, expectedVersion: 1 });
      service.beginQuiescence({ transferId, expectedVersion: 2 });

      // Relinquish with valid lease token
      const relRes = service.relinquishPredecessorOwnership({
        transferId,
        expectedVersion: 3,
        expectedSourceEpoch: 1,
        expectedTaskLeaseToken: 'lease-token-1',
      });

      expect(relRes.success).toBe(true);
      expect(relRes.alreadyRelinquished).toBe(false);

      // 21. Bumps epoch exactly once: 1 -> 2
      expect(relRes.newEpoch).toBe(2);
      expect(repo.getTaskOwnershipEpoch('task-1')).toBe(2);

      // 22. Marks bound source assignment HANDED_OFF
      const asgn = repo.getAgentAssignment('asgn-1');
      expect(asgn?.status).toBe('HANDED_OFF');
      expect(asgn?.ended_at).toBeDefined();

      // 23. Releases active task lease
      const lease = repo.getTaskLease('task-1');
      expect(lease?.released_at).not.toBeNull();

      // 24. Transfer becomes RELINQUISHED
      const transfer = repo.getHandoffTransfer(transferId);
      expect(transfer?.status).toBe('RELINQUISHED');

      // 25. Relinquished_at is persisted
      expect(transfer?.relinquished_at).toBeDefined();

      // 26. Version increments: 3 -> 4
      expect(transfer?.version).toBe(4);
      expect(transfer?.source_ownership_epoch).toBe(1); // Historical predecessor epoch preserved
    });

    it('27-28. exact relinquishment replay is idempotent and does not bump epoch twice', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      const reqRes = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Relinquish test',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      service.freezeHandoff({ transferId, expectedVersion: 1 });
      service.beginQuiescence({ transferId, expectedVersion: 2 });

      const relRes1 = service.relinquishPredecessorOwnership({
        transferId,
        expectedVersion: 3,
        expectedSourceEpoch: 1,
      });
      expect(relRes1.success).toBe(true);
      expect(relRes1.newEpoch).toBe(2);

      // 27. Replay exact same relinquishment (expectedVersion 3 matches pre-relinquishment version 3)
      const relRes2 = service.relinquishPredecessorOwnership({
        transferId,
        expectedVersion: 3,
        expectedSourceEpoch: 1,
      });

      expect(relRes2.success).toBe(true);
      expect(relRes2.alreadyRelinquished).toBe(true);

      // 28. Does NOT bump epoch a second time
      expect(relRes2.newEpoch).toBe(2);
      expect(repo.getTaskOwnershipEpoch('task-1')).toBe(2);
    });

    // -----------------------------------------------------------------------
    // Section 10: Adversarial Assignment Drift & Authority Validation Tests
    // -----------------------------------------------------------------------
    it('28a. source assignment becomes COMPLETED before relinquishment -> fails closed with SOURCE_ASSIGNMENT_STATE_CONFLICT', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });
      repo.acquireTaskLease('task-1', 'prof-1', 'lease-token-1');

      const reqRes = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Assignment drift test',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      service.freezeHandoff({ transferId, expectedVersion: 1 });
      service.beginQuiescence({ transferId, expectedVersion: 2 });

      // Mutate assignment to COMPLETED before relinquishment occurs
      db.prepare("UPDATE agent_assignments SET status = 'COMPLETED' WHERE id = 'asgn-1'").run();

      const relRes = service.relinquishPredecessorOwnership({
        transferId,
        expectedVersion: 3,
        expectedSourceEpoch: 1,
        expectedTaskLeaseToken: 'lease-token-1',
      });

      expect(relRes.success).toBe(false);
      expect(relRes.errorCode).toBe('SOURCE_ASSIGNMENT_STATE_CONFLICT');

      // Assert fail-closed state
      expect(repo.getTaskOwnershipEpoch('task-1')).toBe(1);
      const asgn = repo.getAgentAssignment('asgn-1');
      expect(asgn?.status).toBe('COMPLETED');
      const lease = repo.getTaskLease('task-1');
      expect(lease?.released_at).toBeNull();
      const transfer = repo.getHandoffTransfer(transferId);
      expect(transfer?.status).toBe('QUIESCING');
      expect(transfer?.relinquished_at).toBeNull();
      expect(transfer?.version).toBe(3);
    });

    it('28b. source assignment becomes FAILED, CANCELLED, or HANDED_OFF before relinquishment -> fails closed', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      for (const terminalStatus of ['FAILED', 'CANCELLED', 'HANDED_OFF']) {
        const taskId = `task-${terminalStatus.toLowerCase()}`;
        const attId = `att-${terminalStatus.toLowerCase()}`;
        const asgnId = `asgn-${terminalStatus.toLowerCase()}`;
        const reqId = `req-${terminalStatus.toLowerCase()}`;

        repo.createTask({
          id: taskId,
          project_id: 'proj-1',
          milestone_id: null,
          title: `Task ${terminalStatus}`,
          description: null,
          state: 'CODING',
          paused_from_state: null,
          priority: 'MEDIUM',
          risk: 'LOW',
          assigned_agent_id: null,
          revision_count: 0,
          max_revisions: 5,
          base_sha: null,
          current_sha: null,
          progress_cache_percent: 0.0,
          progress_computed_at: null,
          acceptance_criteria: [],
          constraints: [],
          ownership_epoch: 1,
          created_at: '2026-08-28T00:00:00Z',
          updated_at: '2026-08-28T00:00:00Z',
        });

        repo.createTaskAttempt({
          id: attId,
          task_id: taskId,
          attempt_number: 1,
          agent_id: null,
          agent_profile_id: 'prof-1',
          status: 'RUNNING',
          started_at: '2026-08-28T00:00:00Z',
          ended_at: null,
          summary: 'Summary',
        });

        repo.createAgentAssignment({
          id: asgnId,
          project_id: 'proj-1',
          task_id: taskId,
          attempt_id: attId,
          role_profile_id: 'rp-coder',
          agent_profile_id: 'prof-1',
          selected_provider_id: 'prov-1',
          selected_account_id: 'acc-1',
          selected_resource_id: 'res-1',
          selected_worker_slot_id: null,
          routing_decision_id: null,
          preferred_metadata: {},
          status: 'ASSIGNED',
          created_at: '2026-08-28T00:00:00Z',
          ended_at: null,
        });

        const reqRes = service.requestHandoff({
          requestId: reqId,
          taskId,
          sourceAttemptId: attId,
          sourceAssignmentId: asgnId,
          reason: `Terminal status ${terminalStatus} test`,
          expectedSourceEpoch: 1,
        });
        const transferId = reqRes.transfer!.id;

        service.freezeHandoff({ transferId, expectedVersion: 1 });
        service.beginQuiescence({ transferId, expectedVersion: 2 });

        // Mutate status to terminal
        db.prepare(`UPDATE agent_assignments SET status = '${terminalStatus}' WHERE id = ?`).run(asgnId);

        const relRes = service.relinquishPredecessorOwnership({
          transferId,
          expectedVersion: 3,
          expectedSourceEpoch: 1,
        });

        expect(relRes.success).toBe(false);
        expect(relRes.errorCode).toBe('SOURCE_ASSIGNMENT_STATE_CONFLICT');
      }
    });

    it('28c. source assignment task_id binding mismatch fails closed with SOURCE_ASSIGNMENT_BINDING_MISMATCH', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      // Create a second task
      repo.createTask({
        id: 'task-mismatch',
        project_id: 'proj-1',
        milestone_id: null,
        title: 'Task Mismatch',
        description: null,
        state: 'CODING',
        paused_from_state: null,
        priority: 'MEDIUM',
        risk: 'LOW',
        assigned_agent_id: null,
        revision_count: 0,
        max_revisions: 5,
        base_sha: null,
        current_sha: null,
        progress_cache_percent: 0.0,
        progress_computed_at: null,
        acceptance_criteria: [],
        constraints: [],
        ownership_epoch: 1,
        created_at: '2026-08-28T00:00:00Z',
        updated_at: '2026-08-28T00:00:00Z',
      });

      const reqRes = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Mismatch test',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      service.freezeHandoff({ transferId, expectedVersion: 1 });
      service.beginQuiescence({ transferId, expectedVersion: 2 });

      // Adversarially point assignment to task-mismatch
      db.prepare("UPDATE agent_assignments SET task_id = 'task-mismatch' WHERE id = 'asgn-1'").run();

      const relRes = service.relinquishPredecessorOwnership({
        transferId,
        expectedVersion: 3,
        expectedSourceEpoch: 1,
      });

      expect(relRes.success).toBe(false);
      expect(relRes.errorCode).toBe('SOURCE_ASSIGNMENT_BINDING_MISMATCH');
      expect(repo.getTaskOwnershipEpoch('task-1')).toBe(1);
    });

    it('28d. source assignment attempt_id binding mismatch fails closed with SOURCE_ASSIGNMENT_BINDING_MISMATCH', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      repo.createTaskAttempt({
        id: 'att-other',
        task_id: 'task-1',
        attempt_number: 2,
        agent_id: null,
        agent_profile_id: 'prof-1',
        status: 'RUNNING',
        started_at: '2026-08-28T00:00:00Z',
        ended_at: null,
        summary: 'Other attempt',
      });

      const reqRes = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Attempt mismatch test',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      service.freezeHandoff({ transferId, expectedVersion: 1 });
      service.beginQuiescence({ transferId, expectedVersion: 2 });

      // Point assignment to att-other
      db.prepare("UPDATE agent_assignments SET attempt_id = 'att-other' WHERE id = 'asgn-1'").run();

      const relRes = service.relinquishPredecessorOwnership({
        transferId,
        expectedVersion: 3,
        expectedSourceEpoch: 1,
      });

      expect(relRes.success).toBe(false);
      expect(relRes.errorCode).toBe('SOURCE_ASSIGNMENT_BINDING_MISMATCH');
    });

    it('28e. source attempt task_id binding mismatch fails closed with SOURCE_ATTEMPT_BINDING_MISMATCH', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      repo.createTask({
        id: 'task-other-2',
        project_id: 'proj-1',
        milestone_id: null,
        title: 'Task Other 2',
        description: null,
        state: 'CODING',
        paused_from_state: null,
        priority: 'MEDIUM',
        risk: 'LOW',
        assigned_agent_id: null,
        revision_count: 0,
        max_revisions: 5,
        base_sha: null,
        current_sha: null,
        progress_cache_percent: 0.0,
        progress_computed_at: null,
        acceptance_criteria: [],
        constraints: [],
        ownership_epoch: 1,
        created_at: '2026-08-28T00:00:00Z',
        updated_at: '2026-08-28T00:00:00Z',
      });

      const reqRes = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Attempt task mismatch',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      service.freezeHandoff({ transferId, expectedVersion: 1 });
      service.beginQuiescence({ transferId, expectedVersion: 2 });

      // Point attempt to task-other-2
      db.prepare("UPDATE task_attempts SET task_id = 'task-other-2' WHERE id = 'att-1'").run();

      const relRes = service.relinquishPredecessorOwnership({
        transferId,
        expectedVersion: 3,
        expectedSourceEpoch: 1,
      });

      expect(relRes.success).toBe(false);
      expect(relRes.errorCode).toBe('SOURCE_ATTEMPT_BINDING_MISMATCH');
    });

    // -----------------------------------------------------------------------
    // Section 11: Task Lease Authority Tests
    // -----------------------------------------------------------------------
    it('28f. no task lease exists: safe relinquishment succeeds without lease mutation', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      const reqRes = service.requestHandoff({
        requestId: 'req-no-lease',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'No lease relinquishment',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      service.freezeHandoff({ transferId, expectedVersion: 1 });
      service.beginQuiescence({ transferId, expectedVersion: 2 });

      // Relinquish without expectedTaskLeaseToken (no lease exists)
      const relRes = service.relinquishPredecessorOwnership({
        transferId,
        expectedVersion: 3,
        expectedSourceEpoch: 1,
      });

      expect(relRes.success).toBe(true);
      expect(relRes.newEpoch).toBe(2);
      expect(repo.getTaskLease('task-1')).toBeNull();
    });

    it('28g. active task lease exists with matching expected lease token: safe relinquishment succeeds and releases lease', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });
      repo.acquireTaskLease('task-1', 'prof-1', 'lease-token-valid');

      const reqRes = service.requestHandoff({
        requestId: 'req-with-lease',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Lease token valid',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      service.freezeHandoff({ transferId, expectedVersion: 1 });
      service.beginQuiescence({ transferId, expectedVersion: 2 });

      const relRes = service.relinquishPredecessorOwnership({
        transferId,
        expectedVersion: 3,
        expectedSourceEpoch: 1,
        expectedTaskLeaseToken: 'lease-token-valid',
      });

      expect(relRes.success).toBe(true);
      expect(relRes.newEpoch).toBe(2);
      const lease = repo.getTaskLease('task-1');
      expect(lease?.released_at).not.toBeNull();
    });

    it('28h. active task lease exists but expected token omitted: fails closed with TASK_LEASE_AUTHORITY_UNVERIFIED', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });
      repo.acquireTaskLease('task-1', 'prof-1', 'lease-token-secret-1');

      const reqRes = service.requestHandoff({
        requestId: 'req-lease-omitted',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Omitted lease token test',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      service.freezeHandoff({ transferId, expectedVersion: 1 });
      service.beginQuiescence({ transferId, expectedVersion: 2 });

      // Omit expectedTaskLeaseToken
      const relRes = service.relinquishPredecessorOwnership({
        transferId,
        expectedVersion: 3,
        expectedSourceEpoch: 1,
      });

      expect(relRes.success).toBe(false);
      expect(relRes.errorCode).toBe('TASK_LEASE_AUTHORITY_UNVERIFIED');

      // Assert fail-closed state
      expect(repo.getTaskOwnershipEpoch('task-1')).toBe(1);
      const asgn = repo.getAgentAssignment('asgn-1');
      expect(asgn?.status).toBe('ASSIGNED');
      const lease = repo.getTaskLease('task-1');
      expect(lease?.released_at).toBeNull();
      const transfer = repo.getHandoffTransfer(transferId);
      expect(transfer?.status).toBe('QUIESCING');
      expect(transfer?.version).toBe(3);
    });

    it('28i. active task lease exists with mismatching expected token: fails closed with TASK_LEASE_TOKEN_MISMATCH', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });
      repo.acquireTaskLease('task-1', 'prof-1', 'lease-token-correct');

      const reqRes = service.requestHandoff({
        requestId: 'req-lease-mismatch',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Mismatching lease token test',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      service.freezeHandoff({ transferId, expectedVersion: 1 });
      service.beginQuiescence({ transferId, expectedVersion: 2 });

      // Pass wrong token
      const relRes = service.relinquishPredecessorOwnership({
        transferId,
        expectedVersion: 3,
        expectedSourceEpoch: 1,
        expectedTaskLeaseToken: 'lease-token-wrong',
      });

      expect(relRes.success).toBe(false);
      expect(relRes.errorCode).toBe('TASK_LEASE_TOKEN_MISMATCH');

      // Assert fail-closed state
      expect(repo.getTaskOwnershipEpoch('task-1')).toBe(1);
      const asgn = repo.getAgentAssignment('asgn-1');
      expect(asgn?.status).toBe('ASSIGNED');
      const lease = repo.getTaskLease('task-1');
      expect(lease?.released_at).toBeNull();
      const transfer = repo.getHandoffTransfer(transferId);
      expect(transfer?.status).toBe('QUIESCING');
      expect(transfer?.version).toBe(3);
    });

    it('28j. lease token confidentiality: error message does not expose lease token', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });
      const secretToken = 'super-secret-task-lease-token-12345';
      repo.acquireTaskLease('task-1', 'prof-1', secretToken);

      const reqRes = service.requestHandoff({
        requestId: 'req-confidential',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Confidentiality test',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      service.freezeHandoff({ transferId, expectedVersion: 1 });
      service.beginQuiescence({ transferId, expectedVersion: 2 });

      const relRes = service.relinquishPredecessorOwnership({
        transferId,
        expectedVersion: 3,
        expectedSourceEpoch: 1,
        expectedTaskLeaseToken: 'wrong-token',
      });

      expect(relRes.success).toBe(false);
      expect(relRes.error).not.toContain(secretToken);
      expect(relRes.error).not.toContain('wrong-token');
    });

    // -----------------------------------------------------------------------
    // Section 12: Replay Version & Epoch Validation Tests
    // -----------------------------------------------------------------------
    it('28k. replay with mismatching expectedVersion fails closed with VERSION_CONFLICT and does not mutate state', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      const reqRes = service.requestHandoff({
        requestId: 'req-replay-ver',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Replay version test',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      service.freezeHandoff({ transferId, expectedVersion: 1 });
      service.beginQuiescence({ transferId, expectedVersion: 2 });

      // Successful relinquishment at expectedVersion 3 (transfer becomes version 4)
      const relRes1 = service.relinquishPredecessorOwnership({
        transferId,
        expectedVersion: 3,
        expectedSourceEpoch: 1,
      });
      expect(relRes1.success).toBe(true);
      expect(relRes1.newEpoch).toBe(2);

      // Replay with mismatching expectedVersion (e.g. 4 or 99 instead of original 3)
      const relRes2 = service.relinquishPredecessorOwnership({
        transferId,
        expectedVersion: 4,
        expectedSourceEpoch: 1,
      });

      expect(relRes2.success).toBe(false);
      expect(relRes2.errorCode).toBe('VERSION_CONFLICT');
      expect(repo.getTaskOwnershipEpoch('task-1')).toBe(2); // Epoch remains 2 (no second bump)
      const transfer = repo.getHandoffTransfer(transferId);
      expect(transfer?.version).toBe(4); // Transfer version remains 4
    });

    it('28l. replay with mismatching expectedSourceEpoch fails closed with STALE_OWNERSHIP_EPOCH', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      const reqRes = service.requestHandoff({
        requestId: 'req-replay-epoch',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Replay epoch test',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      service.freezeHandoff({ transferId, expectedVersion: 1 });
      service.beginQuiescence({ transferId, expectedVersion: 2 });

      const relRes1 = service.relinquishPredecessorOwnership({
        transferId,
        expectedVersion: 3,
        expectedSourceEpoch: 1,
      });
      expect(relRes1.success).toBe(true);

      // Replay with mismatching expectedSourceEpoch (e.g. 2 instead of original source epoch 1)
      const relRes2 = service.relinquishPredecessorOwnership({
        transferId,
        expectedVersion: 3,
        expectedSourceEpoch: 2,
      });

      expect(relRes2.success).toBe(false);
      expect(relRes2.errorCode).toBe('STALE_OWNERSHIP_EPOCH');
    });
  });

  // =========================================================================
  // Section 5: Start-vs-Relinquishment Race & Serialization Proof (Tests 29..31)
  // =========================================================================
  describe('Start-vs-Relinquishment Race & Serialization Proof', () => {
    it('29. execution-start wins race first: relinquishment blocks', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      // Create dispatched authorization
      seedExecutionAuth({
        authId: 'auth-race',
        taskId: 'task-1',
        attemptId: 'att-1',
        epoch: 1,
        status: 'DISPATCHED',
      });

      const reqRes = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Race test',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      service.freezeHandoff({ transferId, expectedVersion: 1 });
      service.beginQuiescence({ transferId, expectedVersion: 2 });

      // Step 1: Adapter start claim wins first
      const startRes = repo.claimAdapterExecutionStart({
        authorizationId: 'auth-race',
        executionId: 'exec-race-1',
        expectedEpoch: 1,
      });
      expect(startRes.success).toBe(true);

      // Step 2: Relinquishment runs next
      const relRes = service.relinquishPredecessorOwnership({
        transferId,
        expectedVersion: 3,
        expectedSourceEpoch: 1,
      });

      // Relinquishment MUST see the started execution and block
      expect(relRes.success).toBe(false);
      expect(relRes.errorCode).toBe('PREDECESSOR_EXECUTION_UNRESOLVED');
      expect(repo.getTaskOwnershipEpoch('task-1')).toBe(1); // Unmutated epoch
    });

    it('30. relinquishment wins race first: stale old authorization cannot claim adapter start', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      // Create dispatched authorization (epoch 1)
      seedExecutionAuth({
        authId: 'auth-race-2',
        taskId: 'task-1',
        attemptId: 'att-1',
        epoch: 1,
        status: 'DISPATCHED',
      });

      const reqRes = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Race test',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      service.freezeHandoff({ transferId, expectedVersion: 1 });
      service.beginQuiescence({ transferId, expectedVersion: 2 });

      // Step 1: Relinquishment wins first
      const relRes = service.relinquishPredecessorOwnership({
        transferId,
        expectedVersion: 3,
        expectedSourceEpoch: 1,
      });
      expect(relRes.success).toBe(true);
      expect(repo.getTaskOwnershipEpoch('task-1')).toBe(2);

      // Step 2: Adapter start claim runs with expectedEpoch 1
      const startRes = repo.claimAdapterExecutionStart({
        authorizationId: 'auth-race-2',
        executionId: 'exec-race-2',
        expectedEpoch: 1,
      });

      // Start claim MUST fail with OWNERSHIP_EPOCH_MISMATCH
      expect(startRes.success).toBe(false);
      expect(startRes.error).toContain('OWNERSHIP_EPOCH_MISMATCH');

      // Authorization adapter_started_at remains null
      const auth = repo.getExecutionAuthorization('auth-race-2');
      expect(auth?.adapter_started_at).toBeNull();
    });

    it('31. unstarted old authorization is fenced by new epoch', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      seedExecutionAuth({
        authId: 'auth-old-unstarted',
        taskId: 'task-1',
        attemptId: 'att-1',
        epoch: 1,
        status: 'DISPATCHED',
      });

      const reqRes = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Epoch fence test',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      service.freezeHandoff({ transferId, expectedVersion: 1 });
      service.beginQuiescence({ transferId, expectedVersion: 2 });
      service.relinquishPredecessorOwnership({
        transferId,
        expectedVersion: 3,
        expectedSourceEpoch: 1,
      });

      expect(repo.getTaskOwnershipEpoch('task-1')).toBe(2);

      // Even if adapter passes current task epoch (2), auth row has epoch 1 -> fails closed!
      const startRes = repo.claimAdapterExecutionStart({
        authorizationId: 'auth-old-unstarted',
        executionId: 'exec-old',
        expectedEpoch: 2,
      });

      expect(startRes.success).toBe(false);
      expect(startRes.error).toContain('OWNERSHIP_EPOCH_MISMATCH');
    });
  });

  // =========================================================================
  // Section 6: Pre-Relinquishment Cancellation (Tests 32..34)
  // =========================================================================
  describe('Pre-Relinquishment Cancellation', () => {
    it('32-33. pre-relinquishment CANCELLED does not bump epoch and source remains owner', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      const reqRes = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Cancel test',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      service.freezeHandoff({ transferId, expectedVersion: 1 });
      service.beginQuiescence({ transferId, expectedVersion: 2 });

      // Cancel before relinquishment
      const cancelRes = service.cancelHandoff({
        transferId,
        expectedVersion: 3,
        reason: 'Predecessor decided to continue',
      });

      expect(cancelRes.success).toBe(true);
      expect(cancelRes.transfer?.status).toBe('CANCELLED');
      expect(cancelRes.transfer?.version).toBe(4);
      expect(cancelRes.transfer?.relinquished_at).toBeNull();

      // 32. Epoch does NOT bump
      expect(repo.getTaskOwnershipEpoch('task-1')).toBe(1);

      // 33. Source assignment remains ASSIGNED (not HANDED_OFF)
      const asgn = repo.getAgentAssignment('asgn-1');
      expect(asgn?.status).toBe('ASSIGNED');
    });

    it('34. later distinct request is allowed after cancelled pre-relinquish transfer', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      const reqRes1 = service.requestHandoff({
        requestId: 'req-initial',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Initial handoff request',
        expectedSourceEpoch: 1,
      });
      const transferId1 = reqRes1.transfer!.id;

      // Cancel pre-relinquish transfer
      service.cancelHandoff({ transferId: transferId1, expectedVersion: 1 });

      // New distinct request from same source attempt
      const reqRes2 = service.requestHandoff({
        requestId: 'req-retry',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Retry handoff request',
        expectedSourceEpoch: 1,
      });

      expect(reqRes2.success).toBe(true);
      expect(reqRes2.transfer?.id).not.toBe(transferId1);
      expect(reqRes2.transfer?.status).toBe('REQUESTED');
    });

    it('34b. post-relinquishment cancellation is forbidden', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      const reqRes = service.requestHandoff({
        requestId: 'req-1',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Relinquish then cancel',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      service.freezeHandoff({ transferId, expectedVersion: 1 });
      service.beginQuiescence({ transferId, expectedVersion: 2 });
      service.relinquishPredecessorOwnership({
        transferId,
        expectedVersion: 3,
        expectedSourceEpoch: 1,
      });

      const cancelRes = service.cancelHandoff({
        transferId,
        expectedVersion: 4,
      });

      expect(cancelRes.success).toBe(false);
      expect(cancelRes.errorCode).toBe('ALREADY_RELINQUISHED');
    });
  });

  // =========================================================================
  // Section 7: No-Runtime-Activation & No Successor Creation Proof (Tests 35..39)
  // =========================================================================
  describe('No-Runtime-Activation & No Successor Creation Proof', () => {
    it('35-39. full predecessor lifecycle creates zero successor records and zero context snapshots', () => {
      seedBaseEntities({ taskId: 'task-1', attemptId: 'att-1', assignmentId: 'asgn-1', ownershipEpoch: 1 });

      const reqRes = service.requestHandoff({
        requestId: 'req-lifecycle',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Lifecycle proof',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      service.freezeHandoff({ transferId, expectedVersion: 1 });
      service.beginQuiescence({ transferId, expectedVersion: 2 });
      const relRes = service.relinquishPredecessorOwnership({
        transferId,
        expectedVersion: 3,
        expectedSourceEpoch: 1,
      });

      expect(relRes.success).toBe(true);

      // 35. No successor TaskAttempt created
      const attempts = db.prepare('SELECT * FROM task_attempts WHERE task_id = ?').all('task-1');
      expect(attempts.length).toBe(1); // Only original att-1

      // 36. No successor assignment created
      const assignments = db.prepare('SELECT * FROM agent_assignments WHERE task_id = ?').all('task-1');
      expect(assignments.length).toBe(1); // Only original asgn-1

      // 37. No routing decision created
      const decisions = db.prepare('SELECT * FROM decisions').all();
      expect(decisions.length).toBe(0);

      // 38. No new execution authorization created
      const auths = db.prepare('SELECT * FROM execution_authorizations').all();
      expect(auths.length).toBe(0);

      // 39. No ContextBuilder successor snapshot created
      const snapshots = db.prepare('SELECT * FROM context_snapshots').all();
      expect(snapshots.length).toBe(0);
      const manifests = db.prepare('SELECT * FROM context_manifests').all();
      expect(manifests.length).toBe(0);
      const handoffContexts = db.prepare('SELECT * FROM handoff_contexts').all();
      expect(handoffContexts.length).toBe(0);
    });
  });
});
