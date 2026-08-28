import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS, MigrationRunner, Migration } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import {
  Task,
  TaskAttempt,
  ExecutionAuthorization,
  HandoffTransfer,
  HandoffTransferStatus,
} from '../src/core/types/domain';

describe('R5I1 Durable Handoff Ownership and Execution Authority Primitives', () => {
  let db: Database.Database;
  let repo: Repository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    repo = new Repository(db);
  });

  afterEach(() => {
    db.close();
  });

  // =========================================================================
  // 1. Migration 16 & 17 Schema Rebuild, FK Integrity & Rollback Tests
  // =========================================================================
  describe('Migration 16 & 17 Schema Rebuild & FK Safety', () => {
    it('25. fresh database migrates 1 -> 17 cleanly with zero errors', () => {
      MigrationRunner.run(db);

      const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as { version: number }[];
      expect(rows.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));

      // 27. foreign_key_check is zero
      const fkCheck = db.pragma('foreign_key_check') as unknown[];
      expect(fkCheck).toEqual([]);

      // 28. FK state restored ON
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    });

    it('26. populated database migrates 1 -> 16 -> 17 preserving all existing data and inbound FKs', () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);

      // Apply migrations 1 to 15 first
      const migrations1To15 = MIGRATIONS.filter((m) => m.version <= 15);
      for (const m of migrations1To15) {
        const tx = db.transaction(() => {
          m.up(db);
          db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
            m.version,
            m.name,
            new Date().toISOString()
          );
        });
        tx();
      }

      // Populate base data
      db.exec(`
        INSERT INTO projects (id, name, repository_path, default_branch, status, created_at, updated_at)
        VALUES ('proj-1', 'Project 1', '/repo', 'main', 'RUNNING', '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');

        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, created_at, updated_at)
        VALUES ('task-1', 'proj-1', 'Task 1', 'CODING', 'MEDIUM', 'LOW', 0, 5, 0.0, '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');

        INSERT INTO task_attempts (id, task_id, attempt_number, agent_id, status, started_at, summary)
        VALUES ('att-1', 'task-1', 1, 'agent-legacy-coder', 'COMPLETED', '2026-08-27T00:00:00Z', 'Legacy summary 1');

        INSERT INTO task_attempts (id, task_id, attempt_number, agent_id, status, started_at, summary)
        VALUES ('att-2', 'task-1', 2, 'agent-legacy-coder', 'RUNNING', '2026-08-27T01:00:00Z', 'Legacy summary 2');

        -- Inbound simple FK references
        INSERT INTO process_runs (id, attempt_id, command, working_directory, status, start_time, created_at)
        VALUES ('pr-1', 'att-1', 'npm test', '/repo', 'COMPLETED', '2026-08-27T00:05:00Z', '2026-08-27T00:05:00Z');

        -- Inbound composite FK references
        INSERT INTO failover_transitions (id, task_id, root_attempt_id, source_attempt_id, successor_attempt_id, failover_ordinal, created_at)
        VALUES ('ft-1', 'task-1', 'att-1', 'att-1', 'att-2', 1, '2026-08-27T01:00:00Z');
      `);

      // Run migrations 16 and 17 via MigrationRunner
      MigrationRunner.run(db);

      // Verify migration ledger
      const applied16 = db.prepare('SELECT version FROM schema_migrations WHERE version = 16').get();
      expect(applied16).toBeDefined();
      const applied17 = db.prepare('SELECT version FROM schema_migrations WHERE version = 17').get();
      expect(applied17).toBeDefined();

      // Legacy TaskAttempt survives with same ID/data
      const legacyAtt1 = repo.getTaskAttempt('att-1');
      expect(legacyAtt1).toEqual({
        id: 'att-1',
        task_id: 'task-1',
        attempt_number: 1,
        agent_id: 'agent-legacy-coder',
        agent_profile_id: null,
        status: 'COMPLETED',
        started_at: '2026-08-27T00:00:00Z',
        ended_at: null,
        summary: 'Legacy summary 1',
      });

      // Simple inbound FKs survive
      const prRow = db.prepare('SELECT p.*, a.agent_id FROM process_runs p JOIN task_attempts a ON p.attempt_id = a.id WHERE p.id = ?').get('pr-1') as Record<string, unknown>;
      expect(prRow.agent_id).toBe('agent-legacy-coder');

      // Composite inbound FKs survive
      const ftRow = db.prepare('SELECT f.*, a.status FROM failover_transitions f JOIN task_attempts a ON f.task_id = a.task_id AND f.source_attempt_id = a.id WHERE f.id = ?').get('ft-1') as Record<string, unknown>;
      expect(ftRow.status).toBe('COMPLETED');

      // Foreign key check returns zero rows
      const fkCheck = db.pragma('foreign_key_check') as unknown[];
      expect(fkCheck).toEqual([]);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    });

    it('29. Migration 16 remains strictly unchanged in MIGRATIONS list', () => {
      const m16 = MIGRATIONS.find((m) => m.version === 16);
      expect(m16).toBeDefined();
      expect(m16?.name).toBe('016_r5i_durable_handoff_ownership_and_execution_authority');
      expect(m16?.foreignKeyMode).toBe('DISABLED_FOR_REBUILD');

      const m17 = MIGRATIONS.find((m) => m.version === 17);
      expect(m17).toBeDefined();
      expect(m17?.name).toBe('017_r5i_handoff_authority_corrective_hardening');
      expect(m17?.foreignKeyMode).toBe('DISABLED_FOR_REBUILD');
    });

    it('16. successor_agent_id no longer exists in final handoff_transfers schema', () => {
      MigrationRunner.run(db);

      const columns = (db.prepare('PRAGMA table_info(handoff_transfers)').all() as { name: string }[]).map((c) => c.name);
      expect(columns).not.toContain('successor_agent_id');
      expect(columns).toContain('successor_role_profile_id');
      expect(columns).toContain('successor_agent_profile_id');
      expect(columns).toContain('handoff_context_id');
    });

    it('30. profile-only TaskAttempt AgentProfile delete behavior is fail-closed and preserves historical attempt identity', () => {
      MigrationRunner.run(db);

      db.exec(`
        INSERT INTO projects (id, name, repository_path, status, created_at, updated_at)
        VALUES ('p1', 'P1', '/repo', 'RUNNING', '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, created_at, updated_at)
        VALUES ('t1', 'p1', 'T1', 'CODING', 'MEDIUM', 'LOW', 0, 5, 0.0, '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
        INSERT INTO role_profiles (id, role, display_name, required_capabilities_json, preferred_capabilities_json, permissions_json, enabled, created_at, updated_at)
        VALUES ('role-coder', 'CODER', 'Coder Role', '[]', '[]', '[]', 1, '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
        INSERT INTO agent_profiles (id, role_profile_id, name, enabled, created_at, updated_at)
        VALUES ('prof-diag-coder', 'role-coder', 'Diagnostic Profile', 1, '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
      `);

      repo.createTaskAttempt({
        id: 'att-profile-diag',
        task_id: 't1',
        attempt_number: 1,
        agent_id: null,
        agent_profile_id: 'prof-diag-coder',
        status: 'RUNNING',
        started_at: '2026-08-27T00:00:00Z',
        ended_at: null,
        summary: null,
      });

      // Attempting to delete the referenced AgentProfile:
      // ON DELETE SET NULL tries to set agent_profile_id = NULL on att-profile-diag,
      // which violates CHECK(agent_id IS NOT NULL OR agent_profile_id IS NOT NULL).
      // SQLite raises a CHECK constraint failure, aborting the delete and preserving identity!
      expect(() => {
        db.prepare("DELETE FROM agent_profiles WHERE id = 'prof-diag-coder'").run();
      }).toThrow(/CHECK constraint failed/);

      // Verify historical attempt identity is completely preserved
      const fetched = repo.getTaskAttempt('att-profile-diag');
      expect(fetched?.agent_profile_id).toBe('prof-diag-coder');
      expect(fetched?.agent_id).toBeNull();
    });

    it('legacy agent_id-only TaskAttempt remains valid', () => {
      MigrationRunner.run(db);

      db.exec(`
        INSERT INTO projects (id, name, repository_path, status, created_at, updated_at)
        VALUES ('p1', 'P1', '/repo', 'RUNNING', '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, created_at, updated_at)
        VALUES ('t1', 'p1', 'T1', 'CODING', 'MEDIUM', 'LOW', 0, 5, 0.0, '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
      `);

      repo.createTaskAttempt({
        id: 'att-legacy',
        task_id: 't1',
        attempt_number: 1,
        agent_id: 'legacy-agent-123',
        agent_profile_id: null,
        status: 'RUNNING',
        started_at: '2026-08-27T00:00:00Z',
        ended_at: null,
        summary: null,
      });

      const fetched = repo.getTaskAttempt('att-legacy');
      expect(fetched?.agent_id).toBe('legacy-agent-123');
      expect(fetched?.agent_profile_id).toBeNull();
    });

    it('both agent_id and agent_profile_id NULL is rejected by CHECK constraint', () => {
      MigrationRunner.run(db);

      db.exec(`
        INSERT INTO projects (id, name, repository_path, status, created_at, updated_at)
        VALUES ('p1', 'P1', '/repo', 'RUNNING', '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, created_at, updated_at)
        VALUES ('t1', 'p1', 'T1', 'CODING', 'MEDIUM', 'LOW', 0, 5, 0.0, '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
      `);

      expect(() => {
        repo.createTaskAttempt({
          id: 'att-invalid-nulls',
          task_id: 't1',
          attempt_number: 1,
          agent_id: null,
          agent_profile_id: null,
          status: 'RUNNING',
          started_at: '2026-08-27T00:00:00Z',
          ended_at: null,
          summary: null,
        });
      }).toThrow(/CHECK constraint failed/);
    });

    it('UNIQUE(task_id, attempt_number) survives and rejects duplicate attempt numbers per task', () => {
      MigrationRunner.run(db);

      db.exec(`
        INSERT INTO projects (id, name, repository_path, status, created_at, updated_at)
        VALUES ('p1', 'P1', '/repo', 'RUNNING', '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, created_at, updated_at)
        VALUES ('t1', 'p1', 'T1', 'CODING', 'MEDIUM', 'LOW', 0, 5, 0.0, '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
      `);

      repo.createTaskAttempt({
        id: 'att-1',
        task_id: 't1',
        attempt_number: 1,
        agent_id: 'agent-1',
        status: 'RUNNING',
        started_at: '2026-08-27T00:00:00Z',
        ended_at: null,
        summary: null,
      });

      expect(() => {
        repo.createTaskAttempt({
          id: 'att-1-dup',
          task_id: 't1',
          attempt_number: 1,
          agent_id: 'agent-2',
          status: 'RUNNING',
          started_at: '2026-08-27T00:00:00Z',
          ended_at: null,
          summary: null,
        });
      }).toThrow(/UNIQUE constraint failed/);
    });
  });

  // =========================================================================
  // 2. Task Ownership Epoch Primitives
  // =========================================================================
  describe('Task Ownership Epoch Primitives', () => {
    beforeEach(() => {
      MigrationRunner.run(db);
      db.exec(`
        INSERT INTO projects (id, name, repository_path, status, created_at, updated_at)
        VALUES ('p1', 'P1', '/repo', 'RUNNING', '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, created_at, updated_at)
        VALUES ('t1', 'p1', 'T1', 'CODING', 'MEDIUM', 'LOW', 0, 5, 0.0, '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
      `);
    });

    it('task ownership epoch default is 1, getTaskOwnershipEpoch and bumpTaskOwnershipEpoch succeed', () => {
      expect(repo.getTaskOwnershipEpoch('t1')).toBe(1);

      const bump1 = repo.bumpTaskOwnershipEpoch('t1', 1);
      expect(bump1.success).toBe(true);
      expect(bump1.newEpoch).toBe(2);
      expect(repo.getTaskOwnershipEpoch('t1')).toBe(2);

      const task = repo.getTask('t1');
      expect(task?.ownership_epoch).toBe(2);
    });

    it('4. stale ownership epoch CAS fails and returns current epoch', () => {
      repo.bumpTaskOwnershipEpoch('t1', 1); // Epoch is now 2

      const staleBump = repo.bumpTaskOwnershipEpoch('t1', 1); // Expected 1, but actual is 2
      expect(staleBump.success).toBe(false);
      expect(staleBump.newEpoch).toBe(2);
      expect(repo.getTaskOwnershipEpoch('t1')).toBe(2);
    });
  });

  // =========================================================================
  // 3. Execution Start Barrier & Status Fencing Tests
  // =========================================================================
  describe('Execution Start Barrier & Status Fencing Primitives', () => {
    let auth: ExecutionAuthorization;

    beforeEach(() => {
      MigrationRunner.run(db);
      db.exec(`
        INSERT INTO projects (id, name, repository_path, status, created_at, updated_at)
        VALUES ('p1', 'P1', '/repo', 'RUNNING', '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, created_at, updated_at)
        VALUES ('t1', 'p1', 'T1', 'CODING', 'MEDIUM', 'LOW', 0, 5, 0.0, '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
        INSERT INTO task_attempts (id, task_id, attempt_number, agent_id, status, started_at)
        VALUES ('att-1', 't1', 1, 'agent-1', 'RUNNING', '2026-08-27T00:00:00Z');
        INSERT INTO protocol_messages (id, message_id, protocol, project_id, task_id, payload_hash, raw_payload, status, created_at, processed_at)
        VALUES ('msg-1', 'msg-id-1', 'manager.v1', 'p1', 't1', 'hash-mgr', '{}', 'APPLIED', '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
        INSERT INTO providers (id, name, adapter_type, enabled, created_at)
        VALUES ('prov-1', 'CLI Provider', 'LOCAL_CLI', 1, '2026-08-27T00:00:00Z');
        INSERT INTO provider_resources (id, provider_id, model_name, health_status, capabilities_json, enabled, quota_source, quota_confidence, last_health_check)
        VALUES ('res-1', 'prov-1', 'gpt-4o', 'AVAILABLE', '[]', 1, 'UNKNOWN', 0.0, '2026-08-27T00:00:00Z');
      `);

      auth = {
        id: 'auth-1',
        project_id: 'p1',
        task_id: 't1',
        attempt_id: 'att-1',
        task_revision: 1,
        base_sha: 'sha-base',
        repository_head_sha: 'sha-head',
        manager_message_id: 'msg-1',
        manager_payload_hash: 'hash-mgr',
        routing_decision_id: 'route-1',
        selected_resource_id: 'res-1',
        selected_provider_id: 'prov-1',
        instruction_payload_hash: 'hash-inst',
        context_manifest_hash: 'hash-ctx',
        canonical_instructions_json: '[]',
        context_files_json: '[]',
        canonical_payload_json: null,
        status: 'AUTHORIZED',
        created_at: '2026-08-27T00:00:00Z',
        dispatched_at: null,
        task_ownership_epoch: 1,
      };
      repo.createExecutionAuthorization(auth);
    });

    it('1. AUTHORIZED authorization cannot claim adapter start (fails closed)', () => {
      const claim = repo.claimAdapterExecutionStart({
        authorizationId: 'auth-1',
        executionId: 'exec-1',
        expectedEpoch: 1,
      });
      expect(claim.success).toBe(false);
      expect(claim.error).toContain('AUTHORIZATION_NOT_DISPATCHED');

      const currentAuth = repo.getExecutionAuthorization('auth-1');
      expect(currentAuth?.adapter_started_at).toBeNull();
      expect(currentAuth?.execution_id).toBeNull();
    });

    it('2. DISPATCHED authorization can claim adapter start exactly once', () => {
      // Transition from AUTHORIZED to DISPATCHED
      const claimed = repo.claimExecutionAuthorization('auth-1', '2026-08-27T00:01:00Z');
      expect(claimed).toBe(true);

      const startClaim = repo.claimAdapterExecutionStart({
        authorizationId: 'auth-1',
        executionId: 'exec-1',
        expectedEpoch: 1,
      });
      expect(startClaim).toEqual({ success: true, alreadyClaimed: false });

      const updated = repo.getExecutionAuthorization('auth-1');
      expect(updated?.execution_id).toBe('exec-1');
      expect(updated?.adapter_started_at).toBeDefined();
    });

    it('3. INVALIDATED authorization cannot claim adapter start (fails closed)', () => {
      // Invalidate the authorization
      repo.invalidateExecutionAuthorization('auth-1');

      const claim = repo.claimAdapterExecutionStart({
        authorizationId: 'auth-1',
        executionId: 'exec-1',
        expectedEpoch: 1,
      });
      expect(claim.success).toBe(false);
      expect(claim.error).toContain('AUTHORIZATION_NOT_DISPATCHED');
    });

    it('4. stale task epoch blocks execution-start claim', () => {
      repo.claimExecutionAuthorization('auth-1', '2026-08-27T00:01:00Z');
      // Bump task epoch to 2
      repo.bumpTaskOwnershipEpoch('t1', 1);

      const claim = repo.claimAdapterExecutionStart({
        authorizationId: 'auth-1',
        executionId: 'exec-1',
        expectedEpoch: 1, // Stale! Task is at epoch 2
      });
      expect(claim.success).toBe(false);
      expect(claim.error).toContain('OWNERSHIP_EPOCH_MISMATCH');
    });

    it('5. identical started execution replay remains deterministic where valid, conflicting execution_id fails closed', () => {
      repo.claimExecutionAuthorization('auth-1', '2026-08-27T00:01:00Z');

      const claim1 = repo.claimAdapterExecutionStart({
        authorizationId: 'auth-1',
        executionId: 'exec-1',
        expectedEpoch: 1,
      });
      expect(claim1).toEqual({ success: true, alreadyClaimed: false });

      // Identical replay succeeds idempotently
      const replay = repo.claimAdapterExecutionStart({
        authorizationId: 'auth-1',
        executionId: 'exec-1',
        expectedEpoch: 1,
      });
      expect(replay).toEqual({ success: true, alreadyClaimed: true });

      // Conflicting execution_id fails closed
      const conflict = repo.claimAdapterExecutionStart({
        authorizationId: 'auth-1',
        executionId: 'exec-2',
        expectedEpoch: 1,
      });
      expect(conflict.success).toBe(false);
      expect(conflict.error).toContain('EXECUTION_ID_CONFLICT');
    });
  });

  // =========================================================================
  // 4. Execution Finish, Cancellation & Termination Authority Tests
  // =========================================================================
  describe('Execution Finish, Cancellation & Termination Authority', () => {
    beforeEach(() => {
      MigrationRunner.run(db);
      db.exec(`
        INSERT INTO projects (id, name, repository_path, status, created_at, updated_at)
        VALUES ('p1', 'P1', '/repo', 'RUNNING', '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, created_at, updated_at)
        VALUES ('t1', 'p1', 'T1', 'CODING', 'MEDIUM', 'LOW', 0, 5, 0.0, '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
        INSERT INTO task_attempts (id, task_id, attempt_number, agent_id, status, started_at)
        VALUES ('att-1', 't1', 1, 'agent-1', 'RUNNING', '2026-08-27T00:00:00Z');
        INSERT INTO protocol_messages (id, message_id, protocol, project_id, task_id, payload_hash, raw_payload, status, created_at, processed_at)
        VALUES ('msg-1', 'msg-id-1', 'manager.v1', 'p1', 't1', 'hash-mgr', '{}', 'APPLIED', '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
        INSERT INTO providers (id, name, adapter_type, enabled, created_at)
        VALUES ('prov-1', 'CLI Provider', 'LOCAL_CLI', 1, '2026-08-27T00:00:00Z');
        INSERT INTO provider_resources (id, provider_id, model_name, health_status, capabilities_json, enabled, quota_source, quota_confidence, last_health_check)
        VALUES ('res-1', 'prov-1', 'gpt-4o', 'AVAILABLE', '[]', 1, 'UNKNOWN', 0.0, '2026-08-27T00:00:00Z');
      `);

      const auth: ExecutionAuthorization = {
        id: 'auth-1',
        project_id: 'p1',
        task_id: 't1',
        attempt_id: 'att-1',
        task_revision: 1,
        base_sha: 'sha-base',
        repository_head_sha: 'sha-head',
        manager_message_id: 'msg-1',
        manager_payload_hash: 'hash-mgr',
        routing_decision_id: 'route-1',
        selected_resource_id: 'res-1',
        selected_provider_id: 'prov-1',
        instruction_payload_hash: 'hash-inst',
        context_manifest_hash: 'hash-ctx',
        canonical_instructions_json: '[]',
        context_files_json: '[]',
        canonical_payload_json: null,
        status: 'AUTHORIZED',
        created_at: '2026-08-27T00:00:00Z',
        dispatched_at: null,
        task_ownership_epoch: 1,
      };
      repo.createExecutionAuthorization(auth);
    });

    it('6. termination on unstarted execution fails (EXECUTION_NOT_STARTED)', () => {
      const term = repo.confirmExecutionTermination({
        authorizationId: 'auth-1',
        executionId: 'exec-random',
        terminationStatus: 'CONFIRMED_TERMINATED',
        terminationSource: 'LOCAL_PROCESS_EXIT',
      });
      expect(term.success).toBe(false);
      expect(term.error).toBe('EXECUTION_NOT_STARTED');
    });

    it('7. mismatched execution ID termination fails (EXECUTION_ID_MISMATCH)', () => {
      repo.claimExecutionAuthorization('auth-1', '2026-08-27T00:01:00Z');
      repo.claimAdapterExecutionStart({
        authorizationId: 'auth-1',
        executionId: 'exec-real',
        expectedEpoch: 1,
      });

      const term = repo.confirmExecutionTermination({
        authorizationId: 'auth-1',
        executionId: 'exec-wrong',
        terminationStatus: 'CONFIRMED_TERMINATED',
        terminationSource: 'LOCAL_PROCESS_EXIT',
      });
      expect(term.success).toBe(false);
      expect(term.error).toContain('EXECUTION_ID_MISMATCH');
    });

    it('8-9. UNRESOLVED leaves termination_confirmed_at NULL and does NOT synthesize adapter_finished_at', () => {
      repo.claimExecutionAuthorization('auth-1', '2026-08-27T00:01:00Z');
      repo.claimAdapterExecutionStart({
        authorizationId: 'auth-1',
        executionId: 'exec-real',
        expectedEpoch: 1,
      });

      const term = repo.confirmExecutionTermination({
        authorizationId: 'auth-1',
        executionId: 'exec-real',
        terminationStatus: 'UNRESOLVED',
        terminationSource: 'TIMEOUT_INSPECTION_PENDING',
      });
      expect(term).toEqual({ success: true, alreadyConfirmed: false });

      const currentAuth = repo.getExecutionAuthorization('auth-1');
      expect(currentAuth?.termination_status).toBe('UNRESOLVED');
      expect(currentAuth?.termination_source).toBe('TIMEOUT_INSPECTION_PENDING');
      // 8. termination_confirmed_at must be NULL
      expect(currentAuth?.termination_confirmed_at).toBeNull();
      // 9. must not synthesize adapter_finished_at or adapter_outcome
      expect(currentAuth?.adapter_finished_at).toBeNull();
      expect(currentAuth?.adapter_outcome).toBeNull();
    });

    it('10-11. UNRESOLVED -> CONFIRMED_TERMINATED succeeds, and identical replay succeeds', () => {
      repo.claimExecutionAuthorization('auth-1', '2026-08-27T00:01:00Z');
      repo.claimAdapterExecutionStart({
        authorizationId: 'auth-1',
        executionId: 'exec-real',
        expectedEpoch: 1,
      });

      repo.confirmExecutionTermination({
        authorizationId: 'auth-1',
        executionId: 'exec-real',
        terminationStatus: 'UNRESOLVED',
        terminationSource: 'INITIAL_UNKNOWN',
      });

      // 10. Transition to CONFIRMED_TERMINATED
      const confirmResult = repo.confirmExecutionTermination({
        authorizationId: 'auth-1',
        executionId: 'exec-real',
        terminationStatus: 'CONFIRMED_TERMINATED',
        terminationSource: 'PROCESS_EXIT_0',
        confirmedAt: '2026-08-27T00:05:00Z',
      });
      expect(confirmResult).toEqual({ success: true, alreadyConfirmed: false });

      const authConfirmed = repo.getExecutionAuthorization('auth-1');
      expect(authConfirmed?.termination_status).toBe('CONFIRMED_TERMINATED');
      expect(authConfirmed?.termination_source).toBe('PROCESS_EXIT_0');
      expect(authConfirmed?.termination_confirmed_at).toBe('2026-08-27T00:05:00Z');

      // 11. Identical replay
      const replay = repo.confirmExecutionTermination({
        authorizationId: 'auth-1',
        executionId: 'exec-real',
        terminationStatus: 'CONFIRMED_TERMINATED',
        terminationSource: 'PROCESS_EXIT_0',
      });
      expect(replay).toEqual({ success: true, alreadyConfirmed: true });
    });

    it('12. contradictory termination source/evidence fails closed, and CONFIRMED -> UNRESOLVED is rejected', () => {
      repo.claimExecutionAuthorization('auth-1', '2026-08-27T00:01:00Z');
      repo.claimAdapterExecutionStart({
        authorizationId: 'auth-1',
        executionId: 'exec-real',
        expectedEpoch: 1,
      });

      repo.confirmExecutionTermination({
        authorizationId: 'auth-1',
        executionId: 'exec-real',
        terminationStatus: 'CONFIRMED_TERMINATED',
        terminationSource: 'LOCAL_PROCESS_EXIT',
      });

      // Contradictory source on CONFIRMED_TERMINATED
      const sourceConflict = repo.confirmExecutionTermination({
        authorizationId: 'auth-1',
        executionId: 'exec-real',
        terminationStatus: 'CONFIRMED_TERMINATED',
        terminationSource: 'REMOTE_API_REPORT',
      });
      expect(sourceConflict.success).toBe(false);
      expect(sourceConflict.error).toContain('TERMINATION_SOURCE_CONFLICT');

      // CONFIRMED_TERMINATED -> UNRESOLVED is forbidden
      const statusConflict = repo.confirmExecutionTermination({
        authorizationId: 'auth-1',
        executionId: 'exec-real',
        terminationStatus: 'UNRESOLVED',
        terminationSource: 'LOCAL_PROCESS_EXIT',
      });
      expect(statusConflict.success).toBe(false);
      expect(statusConflict.error).toContain('TERMINATION_STATUS_CONFLICT');
    });

    it('13. confirmation does not synthesize adapter finish', () => {
      repo.claimExecutionAuthorization('auth-1', '2026-08-27T00:01:00Z');
      repo.claimAdapterExecutionStart({
        authorizationId: 'auth-1',
        executionId: 'exec-real',
        expectedEpoch: 1,
      });

      repo.confirmExecutionTermination({
        authorizationId: 'auth-1',
        executionId: 'exec-real',
        terminationStatus: 'CONFIRMED_TERMINATED',
        terminationSource: 'LOCAL_PROCESS_EXIT',
      });

      const currentAuth = repo.getExecutionAuthorization('auth-1');
      expect(currentAuth?.adapter_finished_at).toBeNull();
      expect(currentAuth?.adapter_outcome).toBeNull();
    });

    it('14. cancellation request requires matching started execution', () => {
      // Unstarted cancellation fails
      const cancelUnstarted = repo.markCancellationRequested({
        authorizationId: 'auth-1',
        executionId: 'exec-real',
      });
      expect(cancelUnstarted.success).toBe(false);
      expect(cancelUnstarted.error).toBe('EXECUTION_NOT_STARTED');

      // Start execution
      repo.claimExecutionAuthorization('auth-1', '2026-08-27T00:01:00Z');
      repo.claimAdapterExecutionStart({
        authorizationId: 'auth-1',
        executionId: 'exec-real',
        expectedEpoch: 1,
      });

      // Mismatched execution ID fails
      const cancelMismatch = repo.markCancellationRequested({
        authorizationId: 'auth-1',
        executionId: 'exec-wrong',
      });
      expect(cancelMismatch.success).toBe(false);
      expect(cancelMismatch.error).toContain('EXECUTION_ID_MISMATCH');

      // Correct matching cancellation succeeds
      const cancelSuccess = repo.markCancellationRequested({
        authorizationId: 'auth-1',
        executionId: 'exec-real',
        requestedAt: '2026-08-27T00:02:00Z',
      });
      expect(cancelSuccess).toEqual({ success: true, alreadyRequested: false });

      // Replay is idempotent
      const cancelReplay = repo.markCancellationRequested({
        authorizationId: 'auth-1',
        executionId: 'exec-real',
      });
      expect(cancelReplay).toEqual({ success: true, alreadyRequested: true });
    });

    it('execution finish requires matching execution_id and is idempotent', () => {
      repo.claimExecutionAuthorization('auth-1', '2026-08-27T00:01:00Z');
      repo.claimAdapterExecutionStart({
        authorizationId: 'auth-1',
        executionId: 'exec-1',
        expectedEpoch: 1,
      });

      const finishMismatch = repo.completeAdapterExecution({
        authorizationId: 'auth-1',
        executionId: 'exec-wrong',
        outcome: 'RETURNED',
      });
      expect(finishMismatch.success).toBe(false);
      expect(finishMismatch.error).toContain('EXECUTION_ID_MISMATCH');

      const finishSuccess = repo.completeAdapterExecution({
        authorizationId: 'auth-1',
        executionId: 'exec-1',
        outcome: 'RETURNED',
      });
      expect(finishSuccess).toEqual({ success: true, alreadyCompleted: false });

      const replay = repo.completeAdapterExecution({
        authorizationId: 'auth-1',
        executionId: 'exec-1',
        outcome: 'RETURNED',
      });
      expect(replay).toEqual({ success: true, alreadyCompleted: true });
    });
  });

  // =========================================================================
  // 5. Handoff Transfer Schema, Idempotency & Relinquishment Uniqueness Tests
  // =========================================================================
  describe('Handoff Transfer Durable Authority, Idempotency & Relinquishment', () => {
    beforeEach(() => {
      MigrationRunner.run(db);
      db.exec(`
        INSERT INTO projects (id, name, repository_path, status, created_at, updated_at)
        VALUES ('p1', 'P1', '/repo', 'RUNNING', '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, created_at, updated_at)
        VALUES ('t1', 'p1', 'T1', 'CODING', 'MEDIUM', 'LOW', 0, 5, 0.0, '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
        INSERT INTO task_attempts (id, task_id, attempt_number, agent_id, status, started_at)
        VALUES ('att-1', 't1', 1, 'agent-1', 'RUNNING', '2026-08-27T00:00:00Z');
        INSERT INTO role_profiles (id, role, display_name, required_capabilities_json, preferred_capabilities_json, permissions_json, enabled, created_at, updated_at)
        VALUES ('role-coder', 'CODER', 'Coder Role', '[]', '[]', '[]', 1, '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
        INSERT INTO agent_profiles (id, role_profile_id, name, enabled, created_at, updated_at)
        VALUES ('prof-1', 'role-coder', 'Profile 1', 1, '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
        INSERT INTO providers (id, name, adapter_type, enabled, created_at)
        VALUES ('prov-1', 'CLI', 'LOCAL_CLI', 1, '2026-08-27T00:00:00Z');
        INSERT INTO provider_accounts (id, provider_id, label, auth_mode, enabled, priority, health_status, concurrency_limit, created_at, updated_at)
        VALUES ('acc-1', 'prov-1', 'Account 1', 'NATIVE_PROFILE', 1, 100, 'AVAILABLE', 1, '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
        INSERT INTO provider_resources (id, provider_id, model_name, health_status, capabilities_json, enabled, quota_source, quota_confidence, last_health_check)
        VALUES ('res-1', 'prov-1', 'gpt-4o', 'AVAILABLE', '[]', 1, 'UNKNOWN', 0.0, '2026-08-27T00:00:00Z');
        INSERT INTO agent_assignments (id, project_id, task_id, attempt_id, role_profile_id, agent_profile_id, selected_provider_id, selected_account_id, selected_resource_id, status, created_at)
        VALUES ('asgn-1', 'p1', 't1', 'att-1', 'role-coder', 'prof-1', 'prov-1', 'acc-1', 'res-1', 'RUNNING', '2026-08-27T00:00:00Z');
      `);
    });

    it('15. REQUESTED transfer with handoff_context_id NULL succeeds', () => {
      const transfer: HandoffTransfer = {
        id: 'ht-null-ctx',
        request_id: 'req-null-ctx-1',
        task_id: 't1',
        source_attempt_id: 'att-1',
        successor_attempt_id: null,
        source_assignment_id: 'asgn-1',
        successor_assignment_id: null,
        successor_role_profile_id: null,
        successor_agent_profile_id: null,
        successor_context_snapshot_id: null,
        successor_context_spec_hash: null,
        handoff_context_id: null, // Nullable context!
        checkpoint_id: null,
        source_authorization_id: null,
        successor_authorization_id: null,
        reason: 'QUOTA_EXHAUSTED',
        status: 'REQUESTED',
        source_ownership_epoch: 1,
        successor_ownership_epoch: null,
        version: 1,
        frozen_at: null,
        quiescing_at: null,
        relinquished_at: null,
        accepted_at: null,
        completed_at: null,
        created_at: '2026-08-27T00:00:00Z',
        updated_at: '2026-08-27T00:00:00Z',
      };

      const res = repo.createHandoffTransfer(transfer);
      expect(res.success).toBe(true);
      expect(res.duplicate).toBe(false);

      const fetched = repo.getHandoffTransfer('ht-null-ctx');
      expect(fetched?.handoff_context_id).toBeNull();
    });

    it('17. request-id identical replay succeeds', () => {
      const transfer: HandoffTransfer = {
        id: 'ht-1',
        request_id: 'req-unique-123',
        task_id: 't1',
        source_attempt_id: 'att-1',
        successor_attempt_id: null,
        source_assignment_id: 'asgn-1',
        successor_assignment_id: null,
        successor_role_profile_id: null,
        successor_agent_profile_id: null,
        successor_context_snapshot_id: null,
        successor_context_spec_hash: null,
        handoff_context_id: null,
        checkpoint_id: null,
        source_authorization_id: null,
        successor_authorization_id: null,
        reason: 'CONTEXT_EXHAUSTED',
        status: 'REQUESTED',
        source_ownership_epoch: 1,
        successor_ownership_epoch: null,
        version: 1,
        frozen_at: null,
        quiescing_at: null,
        relinquished_at: null,
        accepted_at: null,
        completed_at: null,
        created_at: '2026-08-27T00:00:00Z',
        updated_at: '2026-08-27T00:00:00Z',
      };

      const res1 = repo.createHandoffTransfer(transfer);
      expect(res1).toEqual({ success: true, transfer, duplicate: false });

      // Replay with identical request_id and identical immutable fields
      const res2 = repo.createHandoffTransfer({
        ...transfer,
        id: 'ht-duplicate-id',
      });
      expect(res2.duplicate).toBe(true);
      expect(res2.success).toBe(true);
      expect(res2.transfer.id).toBe('ht-1');
    });

    it('18-20. same request-id with conflicting task_id, source_attempt_id, reason, or epoch fails closed', () => {
      const transfer: HandoffTransfer = {
        id: 'ht-orig',
        request_id: 'req-immutable-test',
        task_id: 't1',
        source_attempt_id: 'att-1',
        successor_attempt_id: null,
        source_assignment_id: 'asgn-1',
        successor_assignment_id: null,
        successor_role_profile_id: null,
        successor_agent_profile_id: null,
        successor_context_snapshot_id: null,
        successor_context_spec_hash: null,
        handoff_context_id: null,
        checkpoint_id: null,
        source_authorization_id: null,
        successor_authorization_id: null,
        reason: 'CONTEXT_EXHAUSTED',
        status: 'REQUESTED',
        source_ownership_epoch: 1,
        successor_ownership_epoch: null,
        version: 1,
        frozen_at: null,
        quiescing_at: null,
        relinquished_at: null,
        accepted_at: null,
        completed_at: null,
        created_at: '2026-08-27T00:00:00Z',
        updated_at: '2026-08-27T00:00:00Z',
      };
      repo.createHandoffTransfer(transfer);

      // 18. Conflicting task_id
      const conflictTask = repo.createHandoffTransfer({
        ...transfer,
        task_id: 't2-different',
      });
      expect(conflictTask.success).toBe(false);
      expect(conflictTask.error).toContain('REQUEST_ID_CONFLICT');

      // 19. Conflicting source_attempt_id
      const conflictAttempt = repo.createHandoffTransfer({
        ...transfer,
        source_attempt_id: 'att-2-different',
      });
      expect(conflictAttempt.success).toBe(false);
      expect(conflictAttempt.error).toContain('REQUEST_ID_CONFLICT');

      // 20. Conflicting reason or epoch
      const conflictReason = repo.createHandoffTransfer({
        ...transfer,
        reason: 'DIFFERENT_REASON',
      });
      expect(conflictReason.success).toBe(false);
      expect(conflictReason.error).toContain('REQUEST_ID_CONFLICT');

      const conflictEpoch = repo.createHandoffTransfer({
        ...transfer,
        source_ownership_epoch: 2,
      });
      expect(conflictEpoch.success).toBe(false);
      expect(conflictEpoch.error).toContain('REQUEST_ID_CONFLICT');
    });

    it('21-22. pre-relinquishment CANCELLED or FAILED permits a later request from same source attempt', () => {
      const transfer1: HandoffTransfer = {
        id: 'ht-pre-relinq',
        request_id: 'req-pre-relinq-1',
        task_id: 't1',
        source_attempt_id: 'att-1',
        successor_attempt_id: null,
        source_assignment_id: 'asgn-1',
        successor_assignment_id: null,
        successor_role_profile_id: null,
        successor_agent_profile_id: null,
        successor_context_snapshot_id: null,
        successor_context_spec_hash: null,
        handoff_context_id: null,
        checkpoint_id: null,
        source_authorization_id: null,
        successor_authorization_id: null,
        reason: 'CONTEXT_EXHAUSTED',
        status: 'REQUESTED',
        source_ownership_epoch: 1,
        successor_ownership_epoch: null,
        version: 1,
        frozen_at: null,
        quiescing_at: null,
        relinquished_at: null, // Not relinquished!
        accepted_at: null,
        completed_at: null,
        created_at: '2026-08-27T00:00:00Z',
        updated_at: '2026-08-27T00:00:00Z',
      };
      repo.createHandoffTransfer(transfer1);

      // 21. Cancel before relinquishment
      repo.updateHandoffTransferStatus({
        id: 'ht-pre-relinq',
        fromStatus: 'REQUESTED',
        toStatus: 'CANCELLED',
        expectedVersion: 1,
      });

      // Distinct later transfer from same source attempt succeeds
      const transfer2: HandoffTransfer = {
        ...transfer1,
        id: 'ht-pre-relinq-2',
        request_id: 'req-pre-relinq-2',
      };
      const res2 = repo.createHandoffTransfer(transfer2);
      expect(res2.success).toBe(true);
      expect(res2.duplicate).toBe(false);

      // 22. Fail before relinquishment
      repo.updateHandoffTransferStatus({
        id: 'ht-pre-relinq-2',
        fromStatus: 'REQUESTED',
        toStatus: 'FAILED',
        expectedVersion: 1,
      });

      // Distinct later transfer succeeds again
      const transfer3: HandoffTransfer = {
        ...transfer1,
        id: 'ht-pre-relinq-3',
        request_id: 'req-pre-relinq-3',
      };
      const res3 = repo.createHandoffTransfer(transfer3);
      expect(res3.success).toBe(true);
      expect(res3.duplicate).toBe(false);
    });

    it('23-24. post-relinquishment FAILED or COMPLETED permanently blocks new independent transfer from same source attempt', () => {
      const transfer: HandoffTransfer = {
        id: 'ht-relinq-test',
        request_id: 'req-relinq-1',
        task_id: 't1',
        source_attempt_id: 'att-1',
        successor_attempt_id: null,
        source_assignment_id: 'asgn-1',
        successor_assignment_id: null,
        successor_role_profile_id: null,
        successor_agent_profile_id: null,
        successor_context_snapshot_id: null,
        successor_context_spec_hash: null,
        handoff_context_id: null,
        checkpoint_id: null,
        source_authorization_id: null,
        successor_authorization_id: null,
        reason: 'CONTEXT_EXHAUSTED',
        status: 'REQUESTED',
        source_ownership_epoch: 1,
        successor_ownership_epoch: null,
        version: 1,
        frozen_at: null,
        quiescing_at: null,
        relinquished_at: null,
        accepted_at: null,
        completed_at: null,
        created_at: '2026-08-27T00:00:00Z',
        updated_at: '2026-08-27T00:00:00Z',
      };
      repo.createHandoffTransfer(transfer);

      // Transition to RELINQUISHED (relinquished_at is set)
      repo.updateHandoffTransferStatus({
        id: 'ht-relinq-test',
        fromStatus: 'REQUESTED',
        toStatus: 'RELINQUISHED',
        expectedVersion: 1,
        additionalFields: {
          relinquished_at: '2026-08-27T00:02:00Z',
        },
      });

      // 23. Transition from RELINQUISHED to FAILED
      repo.updateHandoffTransferStatus({
        id: 'ht-relinq-test',
        fromStatus: 'RELINQUISHED',
        toStatus: 'FAILED',
        expectedVersion: 2,
      });

      // A new independent transfer from the same source attempt MUST fail because relinquished_at IS NOT NULL
      expect(() => {
        repo.createHandoffTransfer({
          ...transfer,
          id: 'ht-relinq-illegal-new',
          request_id: 'req-relinq-new-attempt',
        });
      }).toThrow(/UNIQUE constraint failed/);

      // Active query also returns the relinquished transfer
      const activeTransfer = repo.getActiveHandoffTransferForSourceAttempt('att-1');
      expect(activeTransfer?.id).toBe('ht-relinq-test');
      expect(activeTransfer?.relinquished_at).toBe('2026-08-27T00:02:00Z');
    });
  });
});
