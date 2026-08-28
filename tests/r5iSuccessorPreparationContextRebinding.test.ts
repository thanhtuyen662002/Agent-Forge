import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import {
  HandoffTransferService,
} from '../src/core/services/HandoffTransferService';
import { ContextBuilderService } from '../src/core/services/ContextBuilderService';
import {
  HandoffTransfer,
  HandoffTransferStatus,
  TaskAttempt,
  ContextSnapshot,
  ContextSnapshotPurpose,
  HandoffContext,
} from '../src/core/types/domain';

describe('R5I3 Successor Preparation, Attempt N+1, and Context Rebinding', () => {
  let db: Database.Database;
  let repo: Repository;
  let contextBuilder: ContextBuilderService;
  let service: HandoffTransferService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    contextBuilder = new ContextBuilderService(repo);
    service = new HandoffTransferService(repo, contextBuilder);
  });

  afterEach(() => {
    db.close();
  });

  function seedBaseEntities(params?: {
    taskId?: string;
    attemptId?: string;
    assignmentId?: string;
    ownershipEpoch?: number;
    sourceRoleProfileId?: string;
    sourceAgentProfileId?: string;
    successorRoleProfileId?: string;
    successorAgentProfileId?: string;
  }) {
    const taskId = params?.taskId ?? 'task-1';
    const attemptId = params?.attemptId ?? 'att-1';
    const assignmentId = params?.assignmentId ?? 'asgn-1';
    const epoch = params?.ownershipEpoch ?? 1;
    const sourceRoleProfileId = params?.sourceRoleProfileId ?? 'rp-coder';
    const sourceAgentProfileId = params?.sourceAgentProfileId ?? 'prof-coder-1';
    const successorRoleProfileId = params?.successorRoleProfileId ?? 'rp-reviewer';
    const successorAgentProfileId = params?.successorAgentProfileId ?? 'prof-reviewer-1';
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

    // Source Role Profile & Agent Profile
    repo.createRoleProfile({
      id: sourceRoleProfileId,
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
      id: sourceAgentProfileId,
      role_profile_id: sourceRoleProfileId,
      name: 'Primary Coder Agent',
      prompt_template: 'coder-prompt',
      config: {},
      enabled: true,
      created_at: nowIso,
      updated_at: nowIso,
    });

    // Successor Role Profile & Agent Profile
    repo.createRoleProfile({
      id: successorRoleProfileId,
      role: 'REVIEWER',
      display_name: 'Reviewer Role',
      authority_scope: {},
      output_protocol: 'reviewer.v1',
      required_capabilities: [],
      preferred_capabilities: [],
      permissions: [],
      enabled: true,
      created_at: nowIso,
      updated_at: nowIso,
    });

    repo.createAgentProfile({
      id: successorAgentProfileId,
      role_profile_id: successorRoleProfileId,
      name: 'Primary Reviewer Agent',
      prompt_template: 'reviewer-prompt',
      config: {},
      enabled: true,
      created_at: nowIso,
      updated_at: nowIso,
    });

    // Provider, Provider Account, Provider Resource
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

    // Task
    repo.createTask({
      id: taskId,
      project_id: 'proj-1',
      milestone_id: null,
      title: 'Task 1',
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

    // Source Task Attempt (Attempt 1)
    repo.createTaskAttempt({
      id: attemptId,
      task_id: taskId,
      attempt_number: 1,
      agent_id: null,
      agent_profile_id: sourceAgentProfileId,
      status: 'RUNNING',
      started_at: nowIso,
      ended_at: null,
      summary: null,
    });

    // Source Agent Assignment
    repo.createAgentAssignment({
      id: assignmentId,
      project_id: 'proj-1',
      task_id: taskId,
      attempt_id: attemptId,
      role_profile_id: sourceRoleProfileId,
      agent_profile_id: sourceAgentProfileId,
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
  }

  /**
   * Helper to execute full predecessor lifecycle to reach RELINQUISHED state (version 4, epoch bumped to 2)
   */
  function seedRelinquishedHandoff(params?: {
    requestId?: string;
    taskId?: string;
    attemptId?: string;
    assignmentId?: string;
    leaseToken?: string;
    handoffContextId?: string | null;
    checkpointId?: string | null;
  }): { transferId: string; version: number; newEpoch: number } {
    const taskId = params?.taskId ?? 'task-1';
    const attemptId = params?.attemptId ?? 'att-1';
    const assignmentId = params?.assignmentId ?? 'asgn-1';
    const leaseToken = params?.leaseToken ?? 'lease-token-1';
    const reqId = params?.requestId ?? 'req-relinquished-1';

    // 1. Request
    const reqRes = service.requestHandoff({
      requestId: reqId,
      taskId,
      sourceAttemptId: attemptId,
      sourceAssignmentId: assignmentId,
      reason: 'Standard handoff',
      expectedSourceEpoch: 1,
    });
    const transferId = reqRes.transfer!.id;

    // Acquire task lease
    repo.acquireTaskLease(taskId, 'prof-coder-1', leaseToken);

    // 2. Freeze
    service.freezeHandoff({
      transferId,
      expectedVersion: 1,
      checkpointId: params?.checkpointId ?? null,
    });

    // 3. Begin Quiescence
    service.beginQuiescence({
      transferId,
      expectedVersion: 2,
    });

    // 4. Relinquish
    const relRes = service.relinquishPredecessorOwnership({
      transferId,
      expectedVersion: 3,
      expectedSourceEpoch: 1,
      expectedTaskLeaseToken: leaseToken,
    });

    expect(relRes.success).toBe(true);
    expect(relRes.newEpoch).toBe(2);
    expect(relRes.transfer?.status).toBe('RELINQUISHED');
    expect(relRes.transfer?.version).toBe(4);

    return {
      transferId,
      version: relRes.transfer!.version,
      newEpoch: relRes.newEpoch!,
    };
  }

  // =========================================================================
  // Section 26: Successor Attempt Creation & Input Authority (Tests 1..16)
  // =========================================================================
  describe('Successor Attempt Creation & Input Authority', () => {
    it('1-4. RELINQUISHED transfer prepares successor successfully with attempt N+1, agent_profile_id, and null agent_id', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: false,
      });

      // 1. Prepares successor successfully
      expect(prepRes.success).toBe(true);
      expect(prepRes.alreadyPrepared).toBe(false);
      expect(prepRes.successorAttempt).toBeDefined();

      const attempt = prepRes.successorAttempt!;
      // 2. Attempt number is previous max (1) + 1 = 2
      expect(attempt.attempt_number).toBe(2);
      expect(attempt.task_id).toBe('task-1');

      // 3. Uses agent_profile_id
      expect(attempt.agent_profile_id).toBe('prof-reviewer-1');

      // 4. agent_id remains NULL (legacy Agent ID is NOT invented)
      expect(attempt.agent_id).toBeNull();
      expect(attempt.status).toBe('PENDING');
    });

    it('5. successor AgentProfile role mismatch is rejected', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      // prof-reviewer-1 belongs to rp-reviewer, not rp-coder
      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-coder',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: false,
      });

      expect(prepRes.success).toBe(false);
      expect(prepRes.errorCode).toBe('AGENT_PROFILE_ROLE_MISMATCH');
      expect(prepRes.error).toContain('AGENT_PROFILE_ROLE_MISMATCH');

      // Assert no attempt was created
      const attempts = repo.getTaskAttemptsByTask('task-1');
      expect(attempts.length).toBe(1); // Only original att-1
    });

    it('6. disabled AgentProfile is rejected', () => {
      seedBaseEntities();
      // Disable prof-reviewer-1
      repo.updateAgentProfile('prof-reviewer-1', { enabled: false });

      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: false,
      });

      expect(prepRes.success).toBe(false);
      expect(prepRes.errorCode).toBe('AGENT_PROFILE_DISABLED');
    });

    it('7. missing AgentProfile is rejected', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-non-existent',
        buildContext: false,
      });

      expect(prepRes.success).toBe(false);
      expect(prepRes.errorCode).toBe('AGENT_PROFILE_NOT_FOUND');
    });

    it('8. missing RoleProfile is rejected', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-non-existent',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: false,
      });

      expect(prepRes.success).toBe(false);
      expect(prepRes.errorCode).toBe('ROLE_PROFILE_NOT_FOUND');
    });

    it('9. non-RELINQUISHED transfer is rejected', () => {
      seedBaseEntities();

      // Case A: REQUESTED transfer
      const reqRes = service.requestHandoff({
        requestId: 'req-unrelinquished',
        taskId: 'task-1',
        sourceAttemptId: 'att-1',
        sourceAssignmentId: 'asgn-1',
        reason: 'Still requested',
        expectedSourceEpoch: 1,
      });
      const transferId = reqRes.transfer!.id;

      const prepRes1 = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: 1,
        expectedSuccessorEpoch: 1,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: false,
      });

      expect(prepRes1.success).toBe(false);
      expect(prepRes1.errorCode).toBe('STATUS_CONFLICT');

      // Case B: CANCELLED transfer
      service.cancelHandoff({ transferId, expectedVersion: 1 });
      const prepRes2 = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: 2,
        expectedSuccessorEpoch: 1,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: false,
      });

      expect(prepRes2.success).toBe(false);
      expect(prepRes2.errorCode).toBe('STATUS_CONFLICT');
    });

    it('10. current task epoch mismatch is rejected', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      // Pass wrong expectedSuccessorEpoch (e.g. 1 instead of 2, or 3 instead of 2)
      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: 99,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: false,
      });

      expect(prepRes.success).toBe(false);
      expect(prepRes.errorCode).toBe('STALE_OWNERSHIP_EPOCH');
    });

    it('11. successful preparation updates transfer to SUCCESSOR_PREPARED, sets all successor bindings, and increments version', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: false,
      });

      expect(prepRes.success).toBe(true);

      const transfer = repo.getHandoffTransfer(transferId);
      expect(transfer).not.toBeNull();
      // status -> SUCCESSOR_PREPARED
      expect(transfer?.status).toBe('SUCCESSOR_PREPARED');
      // successor_attempt_id set
      expect(transfer?.successor_attempt_id).toBe(prepRes.successorAttempt?.id);
      // successor_role_profile_id set
      expect(transfer?.successor_role_profile_id).toBe('rp-reviewer');
      // successor_agent_profile_id set
      expect(transfer?.successor_agent_profile_id).toBe('prof-reviewer-1');
      // successor_ownership_epoch set
      expect(transfer?.successor_ownership_epoch).toBe(2);
      // historical predecessor epoch preserved
      expect(transfer?.source_ownership_epoch).toBe(1);
      // version incremented: 4 -> 5
      expect(transfer?.version).toBe(5);
    });

    it('12-13. exact preparation replay returns same attempt and does not create Attempt N+2', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      const prepRes1 = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: false,
      });
      expect(prepRes1.success).toBe(true);
      const attempt1 = prepRes1.successorAttempt!;
      expect(attempt1.attempt_number).toBe(2);

      // 12. Replay exact preparation (with original expectedVersion 4)
      const prepRes2 = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: false,
      });

      expect(prepRes2.success).toBe(true);
      expect(prepRes2.alreadyPrepared).toBe(true);
      expect(prepRes2.successorAttempt?.id).toBe(attempt1.id);
      expect(prepRes2.successorAttempt?.attempt_number).toBe(2);

      // 13. Total attempts for task remains 2 (att-1 and attempt1, no N+2 created)
      const attempts = repo.getTaskAttemptsByTask('task-1');
      expect(attempts.length).toBe(2);
    });

    it('14. conflicting successor profile replay fails closed', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: false,
      });

      // Create a second reviewer agent profile
      repo.createAgentProfile({
        id: 'prof-reviewer-2',
        role_profile_id: 'rp-reviewer',
        name: 'Secondary Reviewer Agent',
        prompt_template: 'reviewer-prompt',
        config: {},
        enabled: true,
        created_at: '2026-08-28T00:00:00Z',
        updated_at: '2026-08-28T00:00:00Z',
      });

      // Replay with different agent profile
      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-2',
        buildContext: false,
      });

      expect(prepRes.success).toBe(false);
      expect(prepRes.errorCode).toBe('CONFLICTING_SUCCESSOR_PROFILE');
    });

    it('15. conflicting successor role replay fails closed', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: false,
      });

      // Replay with different role profile
      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-coder',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: false,
      });

      expect(prepRes.success).toBe(false);
      expect(prepRes.errorCode).toBe('CONFLICTING_SUCCESSOR_ROLE');
    });

    it('16. conflicting ownership epoch replay fails closed', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: false,
      });

      // Replay with different expectedSuccessorEpoch
      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: 99,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: false,
      });

      expect(prepRes.success).toBe(false);
      expect(prepRes.errorCode).toBe('STALE_OWNERSHIP_EPOCH');
    });
  });

  // =========================================================================
  // Section 27: Transactionality & Race Protection (Tests 17..19)
  // =========================================================================
  describe('Transactionality & Race Protection', () => {
    it('17. forced transfer CAS failure leaves no orphan successor attempt', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      // Mutate transfer version in DB directly to simulate concurrent CAS race
      db.prepare('UPDATE handoff_transfers SET version = version + 10 WHERE id = ?').run(transferId);

      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: false,
      });

      expect(prepRes.success).toBe(false);
      expect(prepRes.errorCode).toBe('VERSION_CONFLICT');

      // Assert that NO orphan TaskAttempt was committed to the DB
      const attempts = repo.getTaskAttemptsByTask('task-1');
      expect(attempts.length).toBe(1); // Only original att-1
    });

    it('18. duplicate attempt number constraint protects DB against race', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      // Insert an attempt number 2 manually
      repo.createTaskAttempt({
        id: 'att-manual-2',
        task_id: 'task-1',
        attempt_number: 2,
        agent_id: null,
        agent_profile_id: 'prof-coder-1',
        status: 'RUNNING',
        started_at: '2026-08-28T00:00:00Z',
        ended_at: null,
        summary: null,
      });

      // Prepare successor should atomically calculate nextAttemptNumber = 3
      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: false,
      });

      expect(prepRes.success).toBe(true);
      expect(prepRes.successorAttempt?.attempt_number).toBe(3);
    });

    it('19. concurrent successor preparation attempts produce at most one authoritative successor attempt for the transfer', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      // First preparation succeeds
      const prepRes1 = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: false,
      });

      expect(prepRes1.success).toBe(true);
      const attemptId1 = prepRes1.successorAttempt!.id;

      // Second attempt with different successorAttemptId or replay
      const prepRes2 = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        successorAttemptId: 'att-competing-attempt-id',
        buildContext: false,
      });

      expect(prepRes2.success).toBe(true);
      expect(prepRes2.alreadyPrepared).toBe(true);
      // Returns original attempt ID, not competing attempt ID
      expect(prepRes2.successorAttempt?.id).toBe(attemptId1);

      // Competing attempt was NOT inserted
      expect(repo.getTaskAttempt('att-competing-attempt-id')).toBeNull();
    });
  });

  // =========================================================================
  // Section 28: Context Rebinding & Snapshot Invariants (Tests 20..28)
  // =========================================================================
  describe('Context Rebinding & Snapshot Invariants', () => {
    it('20-22. successor HANDOFF snapshot binds attempt N+1 with purpose HANDOFF and matching task', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: true,
      });

      expect(prepRes.success).toBe(true);
      expect(prepRes.contextSnapshot).toBeDefined();
      expect(prepRes.contextManifest).toBeDefined();

      const snap = prepRes.contextSnapshot!;
      // 20. Snapshot binds attempt N+1
      expect(snap.attempt_id).toBe(prepRes.successorAttempt?.id);
      // 21. Snapshot purpose == HANDOFF
      expect(snap.purpose).toBe('HANDOFF');
      // 22. Snapshot task matches transfer task
      expect(snap.task_id).toBe('task-1');
      expect(snap.project_id).toBe('proj-1');
    });

    it('23. predecessor handoff context can be referenced and included in context items', () => {
      seedBaseEntities();

      // Create initial execution snapshot
      const snapResult = contextBuilder.buildContextSnapshot({
        projectId: 'proj-1',
        taskId: 'task-1',
        attemptId: 'att-1',
        purpose: 'EXECUTION',
      });

      // Create a predecessor HandoffContext
      repo.createHandoffContext({
        id: 'ho-ctx-1',
        project_id: 'proj-1',
        task_id: 'task-1',
        attempt_id: 'att-1',
        from_assignment_id: 'asgn-1',
        to_assignment_id: null,
        source_snapshot_id: snapResult.snapshot.id,
        handoff_snapshot_id: null,
        reason: 'Architecture pivot handover',
        status: 'READY',
        created_at: '2026-08-28T00:00:00Z',
        consumed_at: null,
      });

      const { transferId, version, newEpoch } = seedRelinquishedHandoff({
        handoffContextId: 'ho-ctx-1',
      });

      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        handoffContextId: 'ho-ctx-1',
        buildContext: true,
      });

      expect(prepRes.success).toBe(true);
      expect(prepRes.contextItems).toBeDefined();

      const handoffItem = prepRes.contextItems!.find((item) => item.item_type === 'HANDOFF');
      expect(handoffItem).toBeDefined();
      expect(handoffItem?.source_ref).toBe('ho-ctx-1');
    });

    it('24. cross-task handoff context is rejected', () => {
      seedBaseEntities();

      // Create a second task
      repo.createTask({
        id: 'task-other',
        project_id: 'proj-1',
        milestone_id: null,
        title: 'Other Task',
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

      const snapResultOther = contextBuilder.buildContextSnapshot({
        projectId: 'proj-1',
        taskId: 'task-other',
        attemptId: null,
        purpose: 'EXECUTION',
      });

      // Create a HandoffContext for task-other
      repo.createHandoffContext({
        id: 'ho-ctx-other-task',
        project_id: 'proj-1',
        task_id: 'task-other',
        attempt_id: null,
        from_assignment_id: null,
        to_assignment_id: null,
        source_snapshot_id: snapResultOther.snapshot.id,
        handoff_snapshot_id: null,
        reason: 'Other task handover',
        status: 'READY',
        created_at: '2026-08-28T00:00:00Z',
        consumed_at: null,
      });

      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        handoffContextId: 'ho-ctx-other-task',
        buildContext: true,
      });

      expect(prepRes.success).toBe(false);
      expect(prepRes.errorCode).toBe('CROSS_TASK_HANDOFF_CONTEXT_FORBIDDEN');
    });

    it('25. successor snapshot does not use predecessor attempt N', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: true,
      });

      expect(prepRes.success).toBe(true);
      const snap = prepRes.contextSnapshot!;
      expect(snap.attempt_id).not.toBe('att-1');
      expect(snap.attempt_id).toBe(prepRes.successorAttempt?.id);
    });

    it('26. context build failure does not create Attempt N+2 and leaves successor prepared', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      // Pass an invalid custom item or cross-task context to cause context build error
      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        contextFiles: ['../../outside/repo/file.ts'], // Path traversal will fail sanitization
        buildContext: true,
      });

      expect(prepRes.success).toBe(false);
      expect(prepRes.errorCode).toBe('CONTEXT_BUILD_FAILED');

      // Successor attempt was created (N+1 = 2) and transfer is SUCCESSOR_PREPARED
      expect(prepRes.successorAttempt?.attempt_number).toBe(2);
      const attempts = repo.getTaskAttemptsByTask('task-1');
      expect(attempts.length).toBe(2);
      expect(repo.getHandoffTransfer(transferId)?.status).toBe('SUCCESSOR_PREPARED');
    });

    it('27. context retry reuses the same successor attempt without creating N+2', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      // Step 1: Failed context build
      const prepRes1 = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        contextFiles: ['../../invalid.ts'],
        buildContext: true,
      });
      expect(prepRes1.success).toBe(false);
      const attemptId = prepRes1.successorAttempt!.id;

      // Step 2: Retry with valid context parameters
      const prepRes2 = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: true,
      });

      expect(prepRes2.success).toBe(true);
      expect(prepRes2.alreadyPrepared).toBe(true);
      expect(prepRes2.successorAttempt?.id).toBe(attemptId);
      expect(prepRes2.contextSnapshot).toBeDefined();
      expect(prepRes2.contextSnapshot?.attempt_id).toBe(attemptId);

      // Verify no Attempt 3 was created
      const attempts = repo.getTaskAttemptsByTask('task-1');
      expect(attempts.length).toBe(2);
    });

    it('28. no new ContextSnapshotPurpose introduced: purpose is verified as HANDOFF', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: true,
      });

      expect(prepRes.success).toBe(true);
      expect(prepRes.contextSnapshot?.purpose).toBe('HANDOFF');

      // Check DB row directly
      const row = db.prepare('SELECT purpose FROM context_snapshots WHERE id = ?').get(prepRes.contextSnapshot!.id) as { purpose: string };
      expect(row.purpose).toBe('HANDOFF');
    });
  });

  // =========================================================================
  // Section 29: Negative Non-Goals Verification (Tests 29..35)
  // =========================================================================
  describe('Negative Non-Goals Verification', () => {
    it('29-35. successor preparation creates zero assignments, zero routing decisions, zero auths, acquires zero leases, and accepts zero ownership', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: true,
      });

      expect(prepRes.success).toBe(true);

      // 29. No AgentAssignment created (only original predecessor asgn-1 exists)
      const assignments = db.prepare('SELECT * FROM agent_assignments WHERE task_id = ?').all('task-1') as Record<string, unknown>[];
      expect(assignments.length).toBe(1);
      expect(assignments[0].id).toBe('asgn-1');
      const transfer = repo.getHandoffTransfer(transferId);
      expect(transfer?.successor_assignment_id).toBeNull();

      // 30. No routing decision created
      const decisions = db.prepare('SELECT * FROM decisions').all();
      expect(decisions.length).toBe(0);

      // 31. No ExecutionAuthorization created
      const auths = db.prepare('SELECT * FROM execution_authorizations').all();
      expect(auths.length).toBe(0);
      expect(transfer?.successor_authorization_id).toBeNull();

      // 32. No task lease acquired for successor
      const lease = repo.getTaskLease('task-1');
      // Predecessor lease was released during relinquishment and no new unreleased lease exists
      expect(lease?.released_at).not.toBeNull();

      // 33. accepted_at remains NULL
      expect(transfer?.accepted_at).toBeNull();
      expect(transfer?.status).toBe('SUCCESSOR_PREPARED');

      // 34. No adapter execution performed (process_runs empty)
      const processRuns = db.prepare('SELECT * FROM process_runs').all();
      expect(processRuns.length).toBe(0);

      // 35. No test runs or provider dispatch records
      const testRuns = db.prepare('SELECT * FROM test_runs').all();
      expect(testRuns.length).toBe(0);
    });
  });
});
