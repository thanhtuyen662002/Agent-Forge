import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner, MIGRATIONS } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import {
  HandoffTransferService,
  computeSuccessorContextSpecHash,
  sortSuccessorCustomItems,
} from '../src/core/services/HandoffTransferService';
import {
  ContextBuilderService,
  canonicalJsonStringify,
  computeSha256,
} from '../src/core/services/ContextBuilderService';
import {
  HandoffTransfer,
  HandoffTransferStatus,
  TaskAttempt,
  ContextSnapshot,
  ContextSnapshotPurpose,
  HandoffContext,
} from '../src/core/types/domain';

describe('R5I3 Corrective Durable Successor Context Authority and Attempt State Hardening', () => {
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
  // Section 26: Migration 18 & Schema Authority Tests (1..10)
  // =========================================================================
  describe('Migration 18 & Schema Authority', () => {
    it('1-8. fresh DB and upgrade DB migrations 1..18 apply cleanly, new columns exist, legacy rows receive nulls, FKs enforced, and count == 18', () => {
      // 1. Fresh DB test
      const freshDb = new Database(':memory:');
      freshDb.pragma('foreign_keys = ON');
      MigrationRunner.run(freshDb);

      const columns = (freshDb.prepare("PRAGMA table_info(handoff_transfers)").all() as { name: string }[]).map((c) => c.name);
      expect(columns).toContain('successor_context_snapshot_id');
      expect(columns).toContain('successor_context_spec_hash');

      // 8. Migration ledger count == 18
      const applied = freshDb.prepare('SELECT COUNT(*) as count FROM schema_migrations').get() as { count: number };
      expect(applied.count).toBe(18);

      // 7. foreign_key_check is zero
      const fkViolations = freshDb.prepare('PRAGMA foreign_key_check').all();
      expect(fkViolations).toHaveLength(0);

      freshDb.close();

      // 2-4. Existing DB (1..17 -> 18) test
      const upgradeDb = new Database(':memory:');
      upgradeDb.pragma('foreign_keys = ON');
      // Apply migrations 1..17 manually
      upgradeDb.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      for (const m of MIGRATIONS.filter((m) => m.version <= 17)) {
        if (m.foreignKeyMode === 'DISABLED_FOR_REBUILD') {
          upgradeDb.pragma('foreign_keys = OFF');
          m.up(upgradeDb);
          upgradeDb.pragma('foreign_keys = ON');
        } else {
          m.up(upgradeDb);
        }
        upgradeDb.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          m.version,
          m.name,
          new Date().toISOString()
        );
      }

      // Seed project, task, and a legacy handoff_transfer in v17 DB
      upgradeDb.exec(`
        INSERT INTO projects (id, name, repository_path, default_branch, status, created_at, updated_at)
        VALUES ('proj-legacy', 'Legacy Proj', '/repo', 'main', 'RUNNING', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z');
        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, acceptance_criteria_json, constraints_json, created_at, updated_at)
        VALUES ('task-legacy', 'proj-legacy', 'Legacy Task', 'CODING', 'MEDIUM', 'LOW', 0, 5, 0, '[]', '[]', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z');
        INSERT INTO role_profiles (id, role, display_name, required_capabilities_json, preferred_capabilities_json, permissions_json, enabled, created_at, updated_at)
        VALUES ('rp-legacy', 'CODER', 'Coder', '[]', '[]', '[]', 1, '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z');
        INSERT INTO agent_profiles (id, role_profile_id, name, prompt_template, config_json, enabled, created_at, updated_at)
        VALUES ('prof-legacy', 'rp-legacy', 'Legacy Profile', 'prompt', '{}', 1, '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z');
        INSERT INTO task_attempts (id, task_id, attempt_number, agent_profile_id, status, started_at)
        VALUES ('att-legacy-1', 'task-legacy', 1, 'prof-legacy', 'RUNNING', '2026-08-28T00:00:00Z');
        INSERT INTO providers (id, name, adapter_type, enabled, created_at)
        VALUES ('prov-leg', 'Provider Leg', 'API', 1, '2026-08-28T00:00:00Z');
        INSERT INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at)
        VALUES ('acc-leg', 'prov-leg', 'Account Leg', 'NATIVE_PROFILE', 1, 100, 'AVAILABLE', 5, '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z');
        INSERT INTO provider_resources (id, provider_id, provider_account_id, model_name, health_status, capabilities_json, enabled, quota_unit, quota_confidence)
        VALUES ('res-leg', 'prov-leg', 'acc-leg', 'claude-3-5', 'AVAILABLE', '[]', 1, 'TOKENS', 0);
        INSERT INTO agent_assignments (id, project_id, task_id, attempt_id, role_profile_id, selected_provider_id, selected_account_id, selected_resource_id, status, created_at)
        VALUES ('asgn-leg', 'proj-legacy', 'task-legacy', 'att-legacy-1', 'rp-legacy', 'prov-leg', 'acc-leg', 'res-leg', 'ASSIGNED', '2026-08-28T00:00:00Z');
        INSERT INTO handoff_transfers (id, request_id, task_id, source_attempt_id, source_assignment_id, reason, status, source_ownership_epoch, version, created_at, updated_at)
        VALUES ('ho-legacy-1', 'req-leg-1', 'task-legacy', 'att-legacy-1', 'asgn-leg', 'legacy reason', 'REQUESTED', 1, 1, '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z');
      `);

      // Now run MigrationRunner to execute 17 -> 18
      MigrationRunner.run(upgradeDb);

      // 4. Legacy handoff transfer receives NULL pointer and hash
      const legacyRow = upgradeDb.prepare('SELECT successor_context_snapshot_id, successor_context_spec_hash FROM handoff_transfers WHERE id = ?').get('ho-legacy-1') as { successor_context_snapshot_id: string | null; successor_context_spec_hash: string | null };
      expect(legacyRow.successor_context_snapshot_id).toBeNull();
      expect(legacyRow.successor_context_spec_hash).toBeNull();

      // 5-6. Foreign key enforcement on successor_context_snapshot_id
      // Valid snapshot FK is accepted
      upgradeDb.exec(`
        INSERT INTO context_snapshots (id, project_id, task_id, attempt_id, purpose, snapshot_version, builder_version, content_hash, created_at)
        VALUES ('snap-valid', 'proj-legacy', 'task-legacy', 'att-legacy-1', 'HANDOFF', 1, 'r5b-v1.1', 'hash1', '2026-08-28T00:00:00Z');
        UPDATE handoff_transfers SET successor_context_snapshot_id = 'snap-valid' WHERE id = 'ho-legacy-1';
      `);
      expect(upgradeDb.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);

      // Invalid snapshot FK throws error on insert/update
      expect(() => {
        upgradeDb.prepare("UPDATE handoff_transfers SET successor_context_snapshot_id = 'snap-nonexistent' WHERE id = 'ho-legacy-1'").run();
      }).toThrow();

      upgradeDb.close();
    });

    it('9-10. Migration 16 and Migration 17 remain unchanged', () => {
      const m16 = MIGRATIONS.find((m) => m.version === 16);
      const m17 = MIGRATIONS.find((m) => m.version === 17);
      expect(m16?.name).toBe('016_r5i_durable_handoff_ownership_and_execution_authority');
      expect(m17?.name).toBe('017_r5i_handoff_authority_corrective_hardening');
      expect(MIGRATIONS.length).toBe(18);
    });
  });

  // =========================================================================
  // Section 27: Required Context Authority & Fencing Tests (11..29)
  // =========================================================================
  describe('Context Authority & Fencing', () => {
    it('11-15. first context build binds durable snapshot pointer, verifies task/attempt/purpose, and resolves manifest', () => {
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
      expect(prepRes.alreadyPrepared).toBe(false);
      expect(prepRes.contextSnapshot).toBeDefined();
      expect(prepRes.contextManifest).toBeDefined();

      const transfer = repo.getHandoffTransfer(transferId)!;
      // 11. Durable pointer bound in handoff_transfers
      expect(transfer.successor_context_snapshot_id).toBe(prepRes.contextSnapshot?.id);
      expect(transfer.successor_context_spec_hash).not.toBeNull();
      // Version was incremented twice: 4 -> 5 (preparation CAS) -> 6 (context pointer bind CAS)
      expect(transfer.version).toBe(6);

      // 12. Pointer snapshot task == transfer task
      expect(prepRes.contextSnapshot?.task_id).toBe('task-1');
      // 13. Pointer snapshot attempt == successor Attempt N+1
      expect(prepRes.contextSnapshot?.attempt_id).toBe(prepRes.successorAttempt?.id);
      // 14. Pointer snapshot purpose == HANDOFF
      expect(prepRes.contextSnapshot?.purpose).toBe('HANDOFF');

      // 15. Manifest resolves from pointer snapshot
      const manifest = repo.getContextManifestBySnapshotId(transfer.successor_context_snapshot_id!);
      expect(manifest).not.toBeNull();
      expect(manifest?.snapshot_id).toBe(transfer.successor_context_snapshot_id);
    });

    it('16-19. exact context replay returns same snapshot ID, same manifest, creates zero new snapshots and no N+2', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      const prepRes1 = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: true,
      });
      expect(prepRes1.success).toBe(true);
      const snapId1 = prepRes1.contextSnapshot!.id;
      const manId1 = prepRes1.contextManifest!.id;
      const attemptId1 = prepRes1.successorAttempt!.id;

      // Replay with identical parameters
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
      // 16. Returns same snapshot ID
      expect(prepRes2.contextSnapshot?.id).toBe(snapId1);
      // 17. Returns same manifest ID
      expect(prepRes2.contextManifest?.id).toBe(manId1);
      // 18. Zero new snapshots created (only 1 snapshot for task-1)
      const snapshots = db.prepare('SELECT * FROM context_snapshots WHERE task_id = ?').all('task-1');
      expect(snapshots.length).toBe(1);
      // 19. No N+2 created
      const attempts = repo.getTaskAttemptsByTask('task-1');
      expect(attempts.length).toBe(2);
      expect(prepRes2.successorAttempt?.id).toBe(attemptId1);
    });

    it('20. conflicting context spec replay fails closed', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      // First build with empty context files
      const prepRes1 = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        contextFiles: [],
        buildContext: true,
      });
      expect(prepRes1.success).toBe(true);

      // Replay with different contextFiles (conflicting spec)
      const prepRes2 = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        contextFiles: ['src/fileA.ts'],
        buildContext: true,
      });

      expect(prepRes2.success).toBe(false);
      expect(prepRes2.errorCode).toBe('SUCCESSOR_CONTEXT_SPEC_CONFLICT');
    });

    it('21-22. transfer-bound handoff context is used explicitly and latest unrelated same-task HandoffContext is NOT auto-selected', () => {
      seedBaseEntities();

      // Create snapshot for HandoffContext
      const snapInit = contextBuilder.buildContextSnapshot({
        projectId: 'proj-1',
        taskId: 'task-1',
        attemptId: 'att-1',
        purpose: 'EXECUTION',
      });

      // Create bound HandoffContext
      repo.createHandoffContext({
        id: 'ho-ctx-bound',
        project_id: 'proj-1',
        task_id: 'task-1',
        attempt_id: 'att-1',
        from_assignment_id: 'asgn-1',
        to_assignment_id: null,
        source_snapshot_id: snapInit.snapshot.id,
        handoff_snapshot_id: null,
        reason: 'Bound handover',
        status: 'READY',
        created_at: '2026-08-28T00:00:00Z',
        consumed_at: null,
      });

      // Create a newer, unrelated HandoffContext on the same task
      repo.createHandoffContext({
        id: 'ho-ctx-unrelated-newer',
        project_id: 'proj-1',
        task_id: 'task-1',
        attempt_id: 'att-1',
        from_assignment_id: 'asgn-1',
        to_assignment_id: null,
        source_snapshot_id: snapInit.snapshot.id,
        handoff_snapshot_id: null,
        reason: 'Unrelated newer handover',
        status: 'READY',
        created_at: '2026-08-28T01:00:00Z',
        consumed_at: null,
      });

      // Relinquish with bound ho-ctx-bound (transfer.handoff_context_id = 'ho-ctx-bound')
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      // Manually bind ho-ctx-bound to transfer in DB to test transfer-bound usage
      db.prepare('UPDATE handoff_transfers SET handoff_context_id = ? WHERE id = ?').run('ho-ctx-bound', transferId);

      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: true,
      });

      expect(prepRes.success).toBe(true);
      const handoffItems = prepRes.contextItems!.filter((i) => i.item_type === 'HANDOFF');
      expect(handoffItems.length).toBe(1);
      // 21. Uses bound ho-ctx-bound
      expect(handoffItems[0].source_ref).toBe('ho-ctx-bound');
      // 22. Did NOT auto-select ho-ctx-unrelated-newer
      expect(handoffItems[0].source_ref).not.toBe('ho-ctx-unrelated-newer');
    });

    it('23-24. caller cannot override bound HandoffContext or inject unbound HandoffContext (including empty string)', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      // Case 24a: Transfer has handoff_context_id = NULL. Caller supplies string -> FAIL CLOSED
      const prepRes1 = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        handoffContextId: 'ho-injected',
        buildContext: true,
      });
      expect(prepRes1.success).toBe(false);
      expect(prepRes1.errorCode).toBe('UNBOUND_HANDOFF_CONTEXT_OVERRIDE');

      // Case 24b: Transfer has handoff_context_id = NULL. Caller supplies empty string -> FAIL CLOSED (Defect C)
      const prepResEmpty = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        handoffContextId: '',
        buildContext: true,
      });
      expect(prepResEmpty.success).toBe(false);
      expect(prepResEmpty.errorCode).toBe('UNBOUND_HANDOFF_CONTEXT_OVERRIDE');

      // Case 23: Transfer has handoff_context_id = 'ho-ctx-1'. Caller supplies 'ho-ctx-override' -> FAIL CLOSED
      const snapInit = contextBuilder.buildContextSnapshot({
        projectId: 'proj-1',
        taskId: 'task-1',
        attemptId: 'att-1',
        purpose: 'EXECUTION',
      });
      repo.createHandoffContext({
        id: 'ho-ctx-1',
        project_id: 'proj-1',
        task_id: 'task-1',
        attempt_id: 'att-1',
        from_assignment_id: 'asgn-1',
        to_assignment_id: null,
        source_snapshot_id: snapInit.snapshot.id,
        handoff_snapshot_id: null,
        reason: 'Bound handover 1',
        status: 'READY',
        created_at: '2026-08-28T00:00:00Z',
        consumed_at: null,
      });

      db.prepare('UPDATE handoff_transfers SET handoff_context_id = ? WHERE id = ?').run('ho-ctx-1', transferId);
      const prepRes2 = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        handoffContextId: 'ho-ctx-override',
        buildContext: true,
      });
      expect(prepRes2.success).toBe(false);
      expect(prepRes2.errorCode).toBe('BOUND_HANDOFF_CONTEXT_OVERRIDE_FORBIDDEN');
    });

    it('25-27. bound checkpoint is used explicitly, latest checkpoint fallback is disabled, and caller cannot override bound checkpoint (including empty string)', () => {
      seedBaseEntities();

      // Create Checkpoint 1
      repo.createCheckpoint({
        id: 'cp-bound-1',
        task_id: 'task-1',
        attempt_id: 'att-1',
        sha: 'sha-cp-1',
        tree_metadata: {},
        completed_steps: [],
        remaining_steps: [],
        tests_passing: 1,
        tests_failing: 0,
        known_issues: [],
        recommended_next_action: null,
        created_at: '2026-08-28T00:00:00Z',
      });

      // Create Checkpoint 2 (newer)
      repo.createCheckpoint({
        id: 'cp-newer-2',
        task_id: 'task-1',
        attempt_id: 'att-1',
        sha: 'sha-cp-2',
        tree_metadata: {},
        completed_steps: [],
        remaining_steps: [],
        tests_passing: 2,
        tests_failing: 0,
        known_issues: [],
        recommended_next_action: null,
        created_at: '2026-08-28T01:00:00Z',
      });

      const { transferId, version, newEpoch } = seedRelinquishedHandoff({
        checkpointId: 'cp-bound-1',
      });

      // 25-26. Context build uses bound cp-bound-1 and does NOT pull cp-newer-2
      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: true,
      });

      expect(prepRes.success).toBe(true);
      const cpItems = prepRes.contextItems!.filter((i) => i.item_type === 'CHECKPOINT');
      expect(cpItems.length).toBe(1);
      expect(cpItems[0].source_ref).toBe('cp-bound-1');

      // 27a. Caller cannot override bound checkpoint on a separate task/transfer
      repo.createTask({
        id: 'task-cp-ovr',
        project_id: 'proj-1',
        milestone_id: null,
        title: 'Task CP Ovr',
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
        id: 'att-cp-ovr',
        task_id: 'task-cp-ovr',
        attempt_number: 1,
        agent_id: null,
        agent_profile_id: 'prof-coder-1',
        status: 'RUNNING',
        started_at: '2026-08-28T00:00:00Z',
        ended_at: null,
        summary: null,
      });
      repo.createAgentAssignment({
        id: 'asgn-cp-ovr',
        project_id: 'proj-1',
        task_id: 'task-cp-ovr',
        attempt_id: 'att-cp-ovr',
        role_profile_id: 'rp-coder',
        agent_profile_id: 'prof-coder-1',
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

      repo.createCheckpoint({
        id: 'cp-ovr-bound',
        task_id: 'task-cp-ovr',
        attempt_id: 'att-cp-ovr',
        sha: 'sha-cp-ovr',
        tree_metadata: {},
        completed_steps: [],
        remaining_steps: [],
        tests_passing: 1,
        tests_failing: 0,
        known_issues: [],
        recommended_next_action: null,
        created_at: '2026-08-28T00:00:00Z',
      });

      const { transferId: t2, version: v2, newEpoch: e2 } = seedRelinquishedHandoff({
        requestId: 'req-cp-override-test',
        taskId: 'task-cp-ovr',
        attemptId: 'att-cp-ovr',
        assignmentId: 'asgn-cp-ovr',
        leaseToken: 'lease-cp-ovr',
        checkpointId: 'cp-ovr-bound',
      });

      const overrideRes = service.prepareHandoffSuccessor({
        transferId: t2,
        expectedVersion: v2,
        expectedSuccessorEpoch: e2,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        checkpointId: 'cp-newer-2',
        buildContext: true,
      });
      expect(overrideRes.success).toBe(false);
      expect(overrideRes.errorCode).toBe('BOUND_CHECKPOINT_OVERRIDE_FORBIDDEN');

      // 27b. Caller cannot inject unbound checkpoint with empty string (Defect C)
      repo.createTask({
        id: 'task-cp-null',
        project_id: 'proj-1',
        milestone_id: null,
        title: 'Task CP Null',
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
        id: 'att-cp-null',
        task_id: 'task-cp-null',
        attempt_number: 1,
        agent_id: null,
        agent_profile_id: 'prof-coder-1',
        status: 'RUNNING',
        started_at: '2026-08-28T00:00:00Z',
        ended_at: null,
        summary: null,
      });
      repo.createAgentAssignment({
        id: 'asgn-cp-null',
        project_id: 'proj-1',
        task_id: 'task-cp-null',
        attempt_id: 'att-cp-null',
        role_profile_id: 'rp-coder',
        agent_profile_id: 'prof-coder-1',
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

      const { transferId: t3, version: v3, newEpoch: e3 } = seedRelinquishedHandoff({
        requestId: 'req-cp-null-test',
        taskId: 'task-cp-null',
        attemptId: 'att-cp-null',
        assignmentId: 'asgn-cp-null',
        leaseToken: 'lease-cp-null',
      });
      const emptyCpRes = service.prepareHandoffSuccessor({
        transferId: t3,
        expectedVersion: v3,
        expectedSuccessorEpoch: e3,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        checkpointId: '',
        buildContext: true,
      });
      expect(emptyCpRes.success).toBe(false);
      expect(emptyCpRes.errorCode).toBe('UNBOUND_CHECKPOINT_OVERRIDE');
    });

    it('28-29. HandoffContext NULL attempt_id, wrong source attempt, and cross-task are rejected fail closed', () => {
      seedBaseEntities();

      // Create second task
      repo.createTask({
        id: 'task-other-2',
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

      const snapInit = contextBuilder.buildContextSnapshot({
        projectId: 'proj-1',
        taskId: 'task-1',
        attemptId: 'att-1',
        purpose: 'EXECUTION',
      });

      // 28. Cross-task handoff context
      const snapOther = contextBuilder.buildContextSnapshot({
        projectId: 'proj-1',
        taskId: 'task-other-2',
        attemptId: null,
        purpose: 'EXECUTION',
      });
      repo.createHandoffContext({
        id: 'ho-ctx-cross-task',
        project_id: 'proj-1',
        task_id: 'task-other-2',
        attempt_id: null,
        from_assignment_id: null,
        to_assignment_id: null,
        source_snapshot_id: snapOther.snapshot.id,
        handoff_snapshot_id: null,
        reason: 'Cross task',
        status: 'READY',
        created_at: '2026-08-28T00:00:00Z',
        consumed_at: null,
      });

      const { transferId, version, newEpoch } = seedRelinquishedHandoff();
      db.prepare('UPDATE handoff_transfers SET handoff_context_id = ? WHERE id = ?').run('ho-ctx-cross-task', transferId);

      const prepRes1 = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: true,
      });
      expect(prepRes1.success).toBe(false);
      expect(prepRes1.errorCode).toBe('CROSS_TASK_HANDOFF_CONTEXT_FORBIDDEN');

      // 29a. Cross-source-attempt handoff context (attempt_id on same task is att-prior-0, not att-1)
      repo.createTaskAttempt({
        id: 'att-prior-0',
        task_id: 'task-1',
        attempt_number: 99,
        agent_id: null,
        agent_profile_id: 'prof-coder-1',
        status: 'RUNNING',
        started_at: '2026-08-28T00:00:00Z',
        ended_at: null,
        summary: null,
      });
      const snapPrior = contextBuilder.buildContextSnapshot({
        projectId: 'proj-1',
        taskId: 'task-1',
        attemptId: 'att-prior-0',
        purpose: 'EXECUTION',
      });
      repo.createHandoffContext({
        id: 'ho-ctx-wrong-attempt',
        project_id: 'proj-1',
        task_id: 'task-1',
        attempt_id: 'att-prior-0',
        from_assignment_id: null,
        to_assignment_id: null,
        source_snapshot_id: snapPrior.snapshot.id,
        handoff_snapshot_id: null,
        reason: 'Wrong attempt',
        status: 'READY',
        created_at: '2026-08-28T00:00:00Z',
        consumed_at: null,
      });

      db.prepare('UPDATE handoff_transfers SET handoff_context_id = ? WHERE id = ?').run('ho-ctx-wrong-attempt', transferId);

      const prepRes2 = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: true,
      });
      expect(prepRes2.success).toBe(false);
      expect(prepRes2.errorCode).toBe('HANDOFF_CONTEXT_SOURCE_MISMATCH');

      // 29b. NULL attempt_id on HandoffContext is rejected fail closed (Defect A)
      const snapNullAttempt = contextBuilder.buildContextSnapshot({
        projectId: 'proj-1',
        taskId: 'task-1',
        attemptId: null,
        purpose: 'EXECUTION',
      });
      repo.createHandoffContext({
        id: 'ho-ctx-null-attempt',
        project_id: 'proj-1',
        task_id: 'task-1',
        attempt_id: null,
        from_assignment_id: null,
        to_assignment_id: null,
        source_snapshot_id: snapNullAttempt.snapshot.id,
        handoff_snapshot_id: null,
        reason: 'Null attempt',
        status: 'READY',
        created_at: '2026-08-28T00:00:00Z',
        consumed_at: null,
      });

      db.prepare('UPDATE handoff_transfers SET handoff_context_id = ? WHERE id = ?').run('ho-ctx-null-attempt', transferId);
      const prepResNullAttempt = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: true,
      });
      expect(prepResNullAttempt.success).toBe(false);
      expect(prepResNullAttempt.errorCode).toBe('HANDOFF_CONTEXT_SOURCE_MISMATCH');
    });

    it('Defect D. customItems permutation differing only by null vs empty sourceRef produces identical spec hash and identical context item ordering', () => {
      seedBaseEntities();

      const itemNull = {
        sourceType: 'CUSTOM_TEST',
        sourceRef: null,
        content: { key: 'same_content' },
        tokenEstimate: 10,
      };
      const itemEmpty = {
        sourceType: 'CUSTOM_TEST',
        sourceRef: '',
        content: { key: 'same_content' },
        tokenEstimate: 10,
      };

      // Permutation 1: [itemNull, itemEmpty]
      const hash1 = computeSuccessorContextSpecHash({
        transferId: 'ht-test-1',
        successorAttemptId: 'att-succ-1',
        purpose: 'HANDOFF',
        handoffContextId: null,
        checkpointId: null,
        contextFiles: [],
        customItems: [itemNull, itemEmpty],
      });

      // Permutation 2: [itemEmpty, itemNull]
      const hash2 = computeSuccessorContextSpecHash({
        transferId: 'ht-test-1',
        successorAttemptId: 'att-succ-1',
        purpose: 'HANDOFF',
        handoffContextId: null,
        checkpointId: null,
        contextFiles: [],
        customItems: [itemEmpty, itemNull],
      });

      // Both permutations must produce exact same spec hash
      expect(hash1).toBe(hash2);

      // Verify sortSuccessorCustomItems produces identical canonical order
      const sorted1 = sortSuccessorCustomItems([itemNull, itemEmpty]);
      const sorted2 = sortSuccessorCustomItems([itemEmpty, itemNull]);
      expect(sorted1).toEqual(sorted2);

      // Verify that building successor context with both permutations yields the same context item ordering
      const { transferId: t1, version: v1, newEpoch: e1 } = seedRelinquishedHandoff({
        requestId: 'req-perm-1',
      });
      const res1 = service.prepareHandoffSuccessor({
        transferId: t1,
        expectedVersion: v1,
        expectedSuccessorEpoch: e1,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        customItems: [itemNull, itemEmpty],
        buildContext: true,
      });

      repo.createTask({
        id: 'task-perm-2',
        project_id: 'proj-1',
        milestone_id: null,
        title: 'Task Perm 2',
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
        id: 'att-perm-2',
        task_id: 'task-perm-2',
        attempt_number: 1,
        agent_id: null,
        agent_profile_id: 'prof-coder-1',
        status: 'RUNNING',
        started_at: '2026-08-28T00:00:00Z',
        ended_at: null,
        summary: null,
      });
      repo.createAgentAssignment({
        id: 'asgn-perm-2',
        project_id: 'proj-1',
        task_id: 'task-perm-2',
        attempt_id: 'att-perm-2',
        role_profile_id: 'rp-coder',
        agent_profile_id: 'prof-coder-1',
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

      const { transferId: t2, version: v2, newEpoch: e2 } = seedRelinquishedHandoff({
        requestId: 'req-perm-2',
        taskId: 'task-perm-2',
        attemptId: 'att-perm-2',
        assignmentId: 'asgn-perm-2',
        leaseToken: 'lease-perm-2',
      });
      const res2 = service.prepareHandoffSuccessor({
        transferId: t2,
        expectedVersion: v2,
        expectedSuccessorEpoch: e2,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        customItems: [itemEmpty, itemNull],
        buildContext: true,
      });

      expect(res1.success).toBe(true);
      expect(res2.success).toBe(true);

      const items1 = res1.contextItems!.filter((i) => i.source_type === 'CUSTOM_TEST');
      const items2 = res2.contextItems!.filter((i) => i.source_type === 'CUSTOM_TEST');
      expect(items1.map((i) => i.source_ref)).toEqual(items2.map((i) => i.source_ref));
    });
  });

  // =========================================================================
  // Section 28: Crash / Recovery & Replay Authority Tests (30..36 + Defect B)
  // =========================================================================
  describe('Crash / Recovery & Replay Authority Tests', () => {
    it('30-34. deterministic candidate snapshot persists, recovers after simulated interruption before pointer bind, and binds without duplicating', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      // Step A: Prepare successor attempt first (Attempt N+1 created)
      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: false,
      });
      expect(prepRes.success).toBe(true);
      const successorAttemptId = prepRes.successorAttempt!.id;

      // Step B: Derive deterministic IDs
      const specHash = computeSuccessorContextSpecHash({
        transferId,
        successorAttemptId,
        purpose: 'HANDOFF',
        handoffContextId: null,
        checkpointId: null,
        contextFiles: [],
        customItems: [],
      });
      const deterministicSnapId = `ctx-snap-ho-${computeSha256(`r5i-successor-context:${transferId}:${specHash}`).slice(0, 32)}`;
      const deterministicManId = `ctx-man-ho-${computeSha256(`r5i-successor-manifest:${transferId}:${specHash}`).slice(0, 32)}`;

      // Step C: Simulate ContextBuilder building and persisting the candidate snapshot,
      // but the process crashes before handoff_transfer pointer CAS is executed
      const ctxRes = contextBuilder.buildContextSnapshot({
        projectId: 'proj-1',
        taskId: 'task-1',
        attemptId: successorAttemptId,
        purpose: 'HANDOFF',
        includeLatestHandoff: false,
        includeLatestCheckpoint: false,
        snapshotId: deterministicSnapId,
        manifestId: deterministicManId,
      });
      expect(ctxRes.snapshot.id).toBe(deterministicSnapId);

      // Verify transfer pointer is still NULL in DB (simulating interrupted crash state)
      expect(repo.getHandoffTransfer(transferId)?.successor_context_snapshot_id).toBeNull();

      // Step D: Retry prepareHandoffSuccessor with buildContext: true
      const retryRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: true,
      });

      expect(retryRes.success).toBe(true);
      // 32-34. Discovered and bound the pre-existing deterministic snapshot
      expect(retryRes.contextSnapshot?.id).toBe(deterministicSnapId);
      expect(retryRes.transfer?.successor_context_snapshot_id).toBe(deterministicSnapId);

      // 33. Did NOT create duplicate snapshots in DB
      const snaps = db.prepare('SELECT * FROM context_snapshots WHERE task_id = ?').all('task-1');
      expect(snaps.length).toBe(1);
    });

    it('35. missing manifest for candidate fails integrity check', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      // Prepare attempt
      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: false,
      });
      const successorAttemptId = prepRes.successorAttempt!.id;

      const specHash = computeSuccessorContextSpecHash({
        transferId,
        successorAttemptId,
        purpose: 'HANDOFF',
        handoffContextId: null,
        checkpointId: null,
        contextFiles: [],
        customItems: [],
      });
      const deterministicSnapId = `ctx-snap-ho-${computeSha256(`r5i-successor-context:${transferId}:${specHash}`).slice(0, 32)}`;

      // Insert corrupted candidate snapshot without a manifest
      db.prepare(`
        INSERT INTO context_snapshots (id, project_id, task_id, attempt_id, purpose, snapshot_version, builder_version, content_hash, created_at)
        VALUES (?, 'proj-1', 'task-1', ?, 'HANDOFF', 1, 'r5b-v1.1', 'corrupt_hash', '2026-08-28T00:00:00Z')
      `).run(deterministicSnapId, successorAttemptId);

      const retryRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: true,
      });

      expect(retryRes.success).toBe(false);
      expect(retryRes.errorCode).toBe('SUCCESSOR_CONTEXT_AUTHORITY_INTEGRITY_MISMATCH');
    });

    it('36. wrong task/attempt/purpose candidate fails integrity check', () => {
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
      const successorAttemptId = prepRes.successorAttempt!.id;

      const specHash = computeSuccessorContextSpecHash({
        transferId,
        successorAttemptId,
        purpose: 'HANDOFF',
        handoffContextId: null,
        checkpointId: null,
        contextFiles: [],
        customItems: [],
      });
      const deterministicSnapId = `ctx-snap-ho-${computeSha256(`r5i-successor-context:${transferId}:${specHash}`).slice(0, 32)}`;

      // Insert candidate snapshot with wrong purpose (EXECUTION instead of HANDOFF)
      db.prepare(`
        INSERT INTO context_snapshots (id, project_id, task_id, attempt_id, purpose, snapshot_version, builder_version, content_hash, created_at)
        VALUES (?, 'proj-1', 'task-1', ?, 'EXECUTION', 1, 'r5b-v1.1', 'wrong_purpose_hash', '2026-08-28T00:00:00Z')
      `).run(deterministicSnapId, successorAttemptId);

      const retryRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: true,
      });

      expect(retryRes.success).toBe(false);
      expect(retryRes.errorCode).toBe('SUCCESSOR_CONTEXT_AUTHORITY_INTEGRITY_MISMATCH');
    });

    it('Defect B. already-bound repository replay validates snapshot exists, manifest exists, and task/attempt/purpose integrity before returning alreadyBound', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      // Successfully bind initial context
      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: true,
      });
      expect(prepRes.success).toBe(true);

      const boundSnapshotId = prepRes.contextSnapshot!.id;
      const boundSpecHash = prepRes.transfer!.successor_context_spec_hash!;

      // 1. Valid exact replay at repository level returns alreadyBound: true
      const repoReplay = repo.bindHandoffSuccessorContext({
        transferId,
        expectedVersion: prepRes.transfer!.version,
        successorContextSnapshotId: boundSnapshotId,
        successorContextSpecHash: boundSpecHash,
      });
      expect(repoReplay.success).toBe(true);
      expect(repoReplay.alreadyBound).toBe(true);

      // 2. If manifest is missing for already-bound snapshot, repository fails closed with CONTEXT_MANIFEST_NOT_FOUND
      db.prepare('DELETE FROM context_manifests WHERE snapshot_id = ?').run(boundSnapshotId);
      const replayNoManifest = repo.bindHandoffSuccessorContext({
        transferId,
        expectedVersion: prepRes.transfer!.version,
        successorContextSnapshotId: boundSnapshotId,
        successorContextSpecHash: boundSpecHash,
      });
      expect(replayNoManifest.success).toBe(false);
      expect(replayNoManifest.errorCode).toBe('CONTEXT_MANIFEST_NOT_FOUND');

      // 3. If snapshot itself is missing, repository fails closed with CONTEXT_SNAPSHOT_NOT_FOUND
      db.pragma('foreign_keys = OFF');
      db.prepare('DELETE FROM context_items WHERE snapshot_id = ?').run(boundSnapshotId);
      db.prepare('DELETE FROM context_snapshots WHERE id = ?').run(boundSnapshotId);

      const replayNoSnapshot = repo.bindHandoffSuccessorContext({
        transferId,
        expectedVersion: prepRes.transfer!.version,
        successorContextSnapshotId: boundSnapshotId,
        successorContextSpecHash: boundSpecHash,
      });
      db.pragma('foreign_keys = ON');

      expect(replayNoSnapshot.success).toBe(false);
      expect(replayNoSnapshot.errorCode).toBe('CONTEXT_SNAPSHOT_NOT_FOUND');
    });
  });

  // =========================================================================
  // Section 29: Concurrency, Stale CAS & Version Fencing (37..41 + Defect E & F)
  // =========================================================================
  describe('Concurrency & CAS Binding', () => {
    it('37 & Defect E. race-shaped concurrent preparation from two independent service instances converges to one authority without duplicating snapshots, manifests, or attempts', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      // Instantiate two independent service and repository instances against the same database
      const repo1 = new Repository(db);
      const builder1 = new ContextBuilderService(repo1);
      const service1 = new HandoffTransferService(repo1, builder1);

      const repo2 = new Repository(db);
      const builder2 = new ContextBuilderService(repo2);
      const service2 = new HandoffTransferService(repo2, builder2);

      // Both contenders execute preparation based on the exact same pre-bind relinquished transfer state
      const res1 = service1.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: true,
      });
      expect(res1.success).toBe(true);

      const res2 = service2.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: true,
      });
      expect(res2.success).toBe(true);

      // Both converge to the exact same authoritative pointer
      expect(res2.contextSnapshot?.id).toBe(res1.contextSnapshot?.id);
      expect(res2.contextManifest?.id).toBe(res1.contextManifest?.id);

      // Exactly 1 ContextSnapshot exists
      const snapshots = db.prepare('SELECT * FROM context_snapshots WHERE task_id = ?').all('task-1');
      expect(snapshots.length).toBe(1);

      // Exactly 1 ContextManifest exists
      const manifests = db.prepare('SELECT * FROM context_manifests WHERE snapshot_id = ?').all(res1.contextSnapshot!.id);
      expect(manifests.length).toBe(1);

      // Exactly 2 total attempts exist on task (Attempt 1 predecessor + Attempt 2 successor, no N+2)
      const attempts = repo.getTaskAttemptsByTask('task-1');
      expect(attempts.length).toBe(2);
      expect(res2.successorAttempt?.id).toBe(res1.successorAttempt?.id);
    });

    it('38. conflicting context specs cannot both bind', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      const res1 = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        contextFiles: ['src/specA.ts'],
        buildContext: true,
      });
      expect(res1.success).toBe(true);

      const res2 = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        contextFiles: ['src/specB.ts'],
        buildContext: true,
      });
      expect(res2.success).toBe(false);
      expect(res2.errorCode).toBe('SUCCESSOR_CONTEXT_SPEC_CONFLICT');
    });

    it('39-41. pointer cannot be overwritten after successful binding, and failed bind leaves authority unchanged', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      const res1 = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: true,
      });
      expect(res1.success).toBe(true);
      const boundSnapshotId = res1.contextSnapshot!.id;

      // Overwrite attempt with different snapshot ID fails
      const bindOverwrite = repo.bindHandoffSuccessorContext({
        transferId,
        expectedVersion: res1.transfer!.version,
        successorContextSnapshotId: 'ctx-snap-different',
        successorContextSpecHash: 'different_hash',
      });
      expect(bindOverwrite.success).toBe(false);
      expect(bindOverwrite.errorCode).toBe('SUCCESSOR_CONTEXT_SPEC_CONFLICT');

      // Pointer is unchanged in database
      const transfer = repo.getHandoffTransfer(transferId)!;
      expect(transfer.successor_context_snapshot_id).toBe(boundSnapshotId);
    });

    it('Defect F. stale expectedVersion on prepared transfer with pointer NULL returns VERSION_CONFLICT and leaves pointer NULL', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      // Step A: Prepare successor attempt (status -> SUCCESSOR_PREPARED, version -> 5, pointer -> NULL)
      const prepRes = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version, // 4
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        buildContext: false,
      });
      expect(prepRes.success).toBe(true);
      expect(prepRes.transfer?.version).toBe(5);
      expect(prepRes.transfer?.successor_context_snapshot_id).toBeNull();
      const successorAttemptId = prepRes.successorAttempt!.id;

      // Step B: Create a valid candidate snapshot and manifest
      const candidate = contextBuilder.buildContextSnapshot({
        projectId: 'proj-1',
        taskId: 'task-1',
        attemptId: successorAttemptId,
        purpose: 'HANDOFF',
        includeLatestHandoff: false,
        includeLatestCheckpoint: false,
      });

      // Step C: Call bindHandoffSuccessorContext with stale version = 4 (current is 5)
      const bindStale = repo.bindHandoffSuccessorContext({
        transferId,
        expectedVersion: 4, // Stale version!
        successorContextSnapshotId: candidate.snapshot.id,
        successorContextSpecHash: 'spec_hash_123',
      });

      expect(bindStale.success).toBe(false);
      expect(bindStale.errorCode).toBe('VERSION_CONFLICT');

      // Verify transfer pointer and spec hash remain NULL in database
      const transfer = repo.getHandoffTransfer(transferId)!;
      expect(transfer.successor_context_snapshot_id).toBeNull();
      expect(transfer.successor_context_spec_hash).toBeNull();
      expect(transfer.version).toBe(5);
    });
  });

  // =========================================================================
  // Section 30: Successor Attempt State Tests (42..47 + Defect G)
  // =========================================================================
  describe('Successor Attempt State Fencing', () => {
    it('42-47. successor Attempt N+1 is always created in PENDING status with agent_id = NULL and agent_profile_id bound', () => {
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
      const attempt = prepRes.successorAttempt!;
      // 42. Initial status == PENDING
      expect(attempt.status).toBe('PENDING');
      // 45. agent_id remains NULL
      expect(attempt.agent_id).toBeNull();
      // 46. agent_profile_id bound
      expect(attempt.agent_profile_id).toBe('prof-reviewer-1');
      // 47. Total attempts == 2 (no N+2)
      expect(repo.getTaskAttemptsByTask('task-1').length).toBe(2);
    });

    it('Defect G. adversarial runtime caller injecting RUNNING or terminal status cannot override PENDING status', () => {
      seedBaseEntities();
      const { transferId, version, newEpoch } = seedRelinquishedHandoff();

      // Adversarial attempt 1: Inject status: 'RUNNING'
      const prepResRunning = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        status: 'RUNNING', // Injected
        buildContext: false,
      } as any);

      expect(prepResRunning.success).toBe(true);
      expect(prepResRunning.successorAttempt?.status).toBe('PENDING');
      expect(prepResRunning.successorAttempt?.agent_id).toBeNull();
      expect(prepResRunning.successorAttempt?.agent_profile_id).toBe('prof-reviewer-1');

      // Adversarial attempt 2: Inject status: 'COMPLETED'
      const prepResCompleted = service.prepareHandoffSuccessor({
        transferId,
        expectedVersion: prepResRunning.transfer!.version,
        expectedSuccessorEpoch: newEpoch,
        successorRoleProfileId: 'rp-reviewer',
        successorAgentProfileId: 'prof-reviewer-1',
        status: 'COMPLETED', // Injected
        buildContext: false,
      } as any);

      expect(prepResCompleted.success).toBe(true);
      expect(prepResCompleted.successorAttempt?.status).toBe('PENDING');
      expect(prepResCompleted.successorAttempt?.agent_id).toBeNull();
      expect(prepResCompleted.successorAttempt?.agent_profile_id).toBe('prof-reviewer-1');
      expect(repo.getTaskAttemptsByTask('task-1').length).toBe(2);
    });
  });

  // =========================================================================
  // Section 31: Non-Goals Verification (48..54)
  // =========================================================================
  describe('Non-Goals Verification', () => {
    it('48-54. creates zero assignments, zero decisions, zero auths, acquires zero leases, accepts zero ownership, and performs zero execution', () => {
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

      // 48. Zero new AgentAssignments
      const assignments = db.prepare('SELECT * FROM agent_assignments WHERE task_id = ?').all('task-1');
      expect(assignments.length).toBe(1); // Only initial predecessor assignment
      const transfer = repo.getHandoffTransfer(transferId)!;
      expect(transfer.successor_assignment_id).toBeNull();

      // 49. Zero routing decisions
      const decisions = db.prepare('SELECT * FROM decisions').all();
      expect(decisions.length).toBe(0);

      // 50. Zero ExecutionAuthorizations
      const auths = db.prepare('SELECT * FROM execution_authorizations').all();
      expect(auths.length).toBe(0);
      expect(transfer.successor_authorization_id).toBeNull();

      // 51. Zero successor task leases
      const lease = repo.getTaskLease('task-1');
      expect(lease?.released_at).not.toBeNull();

      // 52. Ownership NOT accepted
      expect(transfer.accepted_at).toBeNull();
      expect(transfer.status).toBe('SUCCESSOR_PREPARED');

      // 53-54. Zero process runs / test runs
      expect(db.prepare('SELECT * FROM process_runs').all()).toHaveLength(0);
      expect(db.prepare('SELECT * FROM test_runs').all()).toHaveLength(0);
    });
  });
});
