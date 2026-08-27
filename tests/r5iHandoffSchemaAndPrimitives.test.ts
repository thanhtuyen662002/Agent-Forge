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
  // 1. Migration 16 Rebuild, FK Integrity & Rollback Tests
  // =========================================================================
  describe('Migration 16 Schema Rebuild & FK Safety', () => {
    it('1. fresh database migrates 1 -> 16 cleanly with zero errors', () => {
      MigrationRunner.run(db);

      const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as { version: number }[];
      expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

      const fkCheck = db.pragma('foreign_key_check') as unknown[];
      expect(fkCheck).toEqual([]);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    });

    it('2. populated database migrates 1 -> 15 -> 16 preserving all existing data and inbound FKs', () => {
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

      // Now run migration 16 via MigrationRunner
      MigrationRunner.run(db);

      // Verify migration ledger
      const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = 16').get();
      expect(applied).toBeDefined();

      // 3. Legacy TaskAttempt survives with same ID/data
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

      // 7. Simple inbound FKs survive
      const prRow = db.prepare('SELECT p.*, a.agent_id FROM process_runs p JOIN task_attempts a ON p.attempt_id = a.id WHERE p.id = ?').get('pr-1') as Record<string, unknown>;
      expect(prRow.agent_id).toBe('agent-legacy-coder');

      // 8. Composite inbound FKs survive
      const ftRow = db.prepare('SELECT f.*, a.status FROM failover_transitions f JOIN task_attempts a ON f.task_id = a.task_id AND f.source_attempt_id = a.id WHERE f.id = ?').get('ft-1') as Record<string, unknown>;
      expect(ftRow.status).toBe('COMPLETED');

      // 30. Foreign key check returns zero rows
      const fkCheck = db.pragma('foreign_key_check') as unknown[];
      expect(fkCheck).toEqual([]);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    });

    it('4. legacy agent_id-only TaskAttempt remains valid', () => {
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

    it('5. R5I agent_profile_id-only TaskAttempt is valid', () => {
      MigrationRunner.run(db);

      db.exec(`
        INSERT INTO projects (id, name, repository_path, status, created_at, updated_at)
        VALUES ('p1', 'P1', '/repo', 'RUNNING', '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, created_at, updated_at)
        VALUES ('t1', 'p1', 'T1', 'CODING', 'MEDIUM', 'LOW', 0, 5, 0.0, '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
        INSERT INTO role_profiles (id, role, display_name, required_capabilities_json, preferred_capabilities_json, permissions_json, enabled, created_at, updated_at)
        VALUES ('role-coder', 'CODER', 'Coder Role', '[]', '[]', '[]', 1, '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
        INSERT INTO agent_profiles (id, role_profile_id, name, enabled, created_at, updated_at)
        VALUES ('prof-gemini-coder', 'role-coder', 'Gemini Coder Profile', 1, '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
      `);

      repo.createTaskAttempt({
        id: 'att-profile-only',
        task_id: 't1',
        attempt_number: 1,
        agent_id: null,
        agent_profile_id: 'prof-gemini-coder',
        status: 'RUNNING',
        started_at: '2026-08-27T00:00:00Z',
        ended_at: null,
        summary: null,
      });

      const fetched = repo.getTaskAttempt('att-profile-only');
      expect(fetched?.agent_id).toBeNull();
      expect(fetched?.agent_profile_id).toBe('prof-gemini-coder');
    });

    it('6. both agent_id and agent_profile_id NULL is rejected by CHECK constraint', () => {
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

    it('9. UNIQUE(task_id, attempt_number) survives and rejects duplicate attempt numbers per task', () => {
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

    it('26-29. migration failure rolls back transaction, preserves ledger, and restores foreign_keys ON', () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);

      // Apply 1..15
      for (const m of MIGRATIONS.filter((m) => m.version <= 15)) {
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

      // Seed task and attempt
      db.exec(`
        INSERT INTO projects (id, name, repository_path, status, created_at, updated_at)
        VALUES ('p1', 'P1', '/repo', 'RUNNING', '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, created_at, updated_at)
        VALUES ('t1', 'p1', 'T1', 'CODING', 'MEDIUM', 'LOW', 0, 5, 0.0, '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
        INSERT INTO task_attempts (id, task_id, attempt_number, agent_id, status, started_at, summary)
        VALUES ('att-orig', 't1', 1, 'agent-orig', 'COMPLETED', '2026-08-27T00:00:00Z', 'Orig summary');
      `);

      // Mock a failing migration 16 that throws mid-execution
      const failingMigration16: Migration = {
        version: 16,
        name: '016_failing_migration',
        foreignKeyMode: 'DISABLED_FOR_REBUILD',
        up: (database) => {
          database.exec(`
            CREATE TABLE task_attempts_new (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, agent_id TEXT NULL, agent_profile_id TEXT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, summary TEXT);
            DROP TABLE task_attempts;
            ALTER TABLE task_attempts_new RENAME TO task_attempts;
          `);
          throw new Error('SIMULATED_MIGRATION_ERROR');
        },
      };

      // Replace migration 16 temporarily
      const origM16 = MIGRATIONS.find((m) => m.version === 16)!;
      const m16Index = MIGRATIONS.indexOf(origM16);
      MIGRATIONS[m16Index] = failingMigration16;

      try {
        expect(() => {
          MigrationRunner.run(db);
        }).toThrow('SIMULATED_MIGRATION_ERROR');
      } finally {
        MIGRATIONS[m16Index] = origM16;
      }

      // 27. Migration ledger is not advanced
      const ledgerRows = db.prepare('SELECT version FROM schema_migrations WHERE version = 16').all();
      expect(ledgerRows.length).toBe(0);

      // 26. Data and schema rolled back
      const origAttempt = repo.getTaskAttempt('att-orig');
      expect(origAttempt?.agent_id).toBe('agent-orig');

      // 29. Foreign keys restored ON after failure
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    });

    it('31. ordinary migration FK enforcement remains ON by default (special mode is opt-in only)', () => {
      MigrationRunner.run(db);

      // Verify that ordinary migrations run under FK enforcement
      const ordinaryMigration: Migration = {
        version: 99,
        name: '099_ordinary_migration_test',
        // foreignKeyMode is undefined (defaults to ENFORCED)
        up: (database) => {
          // Attempting to insert invalid FK should throw immediately
          database.exec(`
            INSERT INTO process_runs (id, attempt_id, command, working_directory, status, start_time, created_at)
            VALUES ('pr-invalid-fk', 'non-existent-attempt', 'npm test', '/repo', 'COMPLETED', '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
          `);
        },
      };

      MIGRATIONS.push(ordinaryMigration);

      try {
        expect(() => {
          MigrationRunner.run(db);
        }).toThrow(/FOREIGN KEY constraint failed/);
      } finally {
        MIGRATIONS.pop();
      }
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

    it('10. task ownership epoch default is 1, getTaskOwnershipEpoch and bumpTaskOwnershipEpoch succeed', () => {
      expect(repo.getTaskOwnershipEpoch('t1')).toBe(1);

      const bump1 = repo.bumpTaskOwnershipEpoch('t1', 1);
      expect(bump1.success).toBe(true);
      expect(bump1.newEpoch).toBe(2);
      expect(repo.getTaskOwnershipEpoch('t1')).toBe(2);

      const task = repo.getTask('t1');
      expect(task?.ownership_epoch).toBe(2);
    });

    it('11. stale ownership epoch CAS fails and returns current epoch', () => {
      repo.bumpTaskOwnershipEpoch('t1', 1); // Epoch is now 2

      const staleBump = repo.bumpTaskOwnershipEpoch('t1', 1); // Expected 1, but actual is 2
      expect(staleBump.success).toBe(false);
      expect(staleBump.newEpoch).toBe(2);
      expect(repo.getTaskOwnershipEpoch('t1')).toBe(2);
    });
  });

  // =========================================================================
  // 3. Task Lease Hardening
  // =========================================================================
  describe('Task Lease Concurrency Hardening', () => {
    beforeEach(() => {
      MigrationRunner.run(db);
      db.exec(`
        INSERT INTO projects (id, name, repository_path, status, created_at, updated_at)
        VALUES ('p1', 'P1', '/repo', 'RUNNING', '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
        INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, created_at, updated_at)
        VALUES ('t1', 'p1', 'T1', 'CODING', 'MEDIUM', 'LOW', 0, 5, 0.0, '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
      `);
    });

    it('25. task lease competing acquisition yields at most one success', () => {
      const lease1 = repo.acquireTaskLease('t1', 'agent-1', 'token-1', 60000);
      expect(lease1).toBe(true);

      // Competing agent trying to acquire lease on same task fails
      const lease2 = repo.acquireTaskLease('t1', 'agent-2', 'token-2', 60000);
      expect(lease2).toBe(false);

      // Same agent refreshing lease succeeds
      const refresh = repo.acquireTaskLease('t1', 'agent-1', 'token-1', 60000);
      expect(refresh).toBe(true);

      // Release lease
      const released = repo.releaseTaskLease('t1', 'token-1');
      expect(released).toBe(true);

      // New agent can now acquire
      const lease3 = repo.acquireTaskLease('t1', 'agent-2', 'token-2', 60000);
      expect(lease3).toBe(true);
    });
  });

  // =========================================================================
  // 4. Execution Start Barrier & Finish/Termination CAS Primitives
  // =========================================================================
  describe('Execution Start Barrier & Finish/Termination CAS Primitives', () => {
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

    it('16. execution-start claim succeeds exactly once', () => {
      const claim1 = repo.claimAdapterExecutionStart({
        authorizationId: 'auth-1',
        executionId: 'exec-1',
        expectedEpoch: 1,
      });
      expect(claim1).toEqual({ success: true, alreadyClaimed: false });

      const updated = repo.getExecutionAuthorization('auth-1');
      expect(updated?.execution_id).toBe('exec-1');
      expect(updated?.adapter_started_at).toBeDefined();
    });

    it('17. stale ownership epoch blocks execution-start claim', () => {
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

    it('18. conflicting execution_id replay fails closed', () => {
      repo.claimAdapterExecutionStart({
        authorizationId: 'auth-1',
        executionId: 'exec-1',
        expectedEpoch: 1,
      });

      const claimConflict = repo.claimAdapterExecutionStart({
        authorizationId: 'auth-1',
        executionId: 'exec-2', // Conflicting ID!
        expectedEpoch: 1,
      });
      expect(claimConflict.success).toBe(false);
      expect(claimConflict.error).toContain('EXECUTION_ID_CONFLICT');
    });

    it('19. identical execution-start replay is deterministic / idempotent', () => {
      repo.claimAdapterExecutionStart({
        authorizationId: 'auth-1',
        executionId: 'exec-1',
        expectedEpoch: 1,
      });

      const replay = repo.claimAdapterExecutionStart({
        authorizationId: 'auth-1',
        executionId: 'exec-1',
        expectedEpoch: 1,
      });
      expect(replay).toEqual({ success: true, alreadyClaimed: true });
    });

    it('20. execution finish requires matching execution_id', () => {
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

      const finishedAuth = repo.getExecutionAuthorization('auth-1');
      expect(finishedAuth?.adapter_finished_at).toBeDefined();
      expect(finishedAuth?.adapter_outcome).toBe('RETURNED');
    });

    it('21. identical finish replay is idempotent', () => {
      repo.claimAdapterExecutionStart({
        authorizationId: 'auth-1',
        executionId: 'exec-1',
        expectedEpoch: 1,
      });

      repo.completeAdapterExecution({
        authorizationId: 'auth-1',
        executionId: 'exec-1',
        outcome: 'RETURNED',
      });

      const replay = repo.completeAdapterExecution({
        authorizationId: 'auth-1',
        executionId: 'exec-1',
        outcome: 'RETURNED',
      });
      expect(replay).toEqual({ success: true, alreadyCompleted: true });
    });

    it('22. finish does NOT silently assert termination (termination_status remains null until confirmed)', () => {
      repo.claimAdapterExecutionStart({
        authorizationId: 'auth-1',
        executionId: 'exec-1',
        expectedEpoch: 1,
      });

      repo.completeAdapterExecution({
        authorizationId: 'auth-1',
        executionId: 'exec-1',
        outcome: 'RETURNED',
      });

      const authAfterFinish = repo.getExecutionAuthorization('auth-1');
      expect(authAfterFinish?.adapter_finished_at).toBeDefined();
      expect(authAfterFinish?.termination_status).toBeNull();
      expect(authAfterFinish?.termination_confirmed_at).toBeNull();
    });

    it('23-24. termination confirmation is idempotent, and conflicting evidence fails closed', () => {
      repo.claimAdapterExecutionStart({
        authorizationId: 'auth-1',
        executionId: 'exec-1',
        expectedEpoch: 1,
      });

      // Cancellation request
      const cancelReq = repo.markCancellationRequested({
        authorizationId: 'auth-1',
        executionId: 'exec-1',
      });
      expect(cancelReq.success).toBe(true);

      // Confirm termination
      const termConfirm = repo.confirmExecutionTermination({
        authorizationId: 'auth-1',
        executionId: 'exec-1',
        terminationStatus: 'CONFIRMED_TERMINATED',
        terminationSource: 'LOCAL_PROCESS_EXIT',
        outcome: 'CANCELLED',
      });
      expect(termConfirm).toEqual({ success: true, alreadyConfirmed: false });

      const authConfirmed = repo.getExecutionAuthorization('auth-1');
      expect(authConfirmed?.termination_status).toBe('CONFIRMED_TERMINATED');
      expect(authConfirmed?.termination_source).toBe('LOCAL_PROCESS_EXIT');
      expect(authConfirmed?.termination_confirmed_at).toBeDefined();
      expect(authConfirmed?.adapter_outcome).toBe('CANCELLED');

      // 23. Idempotent replay
      const termReplay = repo.confirmExecutionTermination({
        authorizationId: 'auth-1',
        executionId: 'exec-1',
        terminationStatus: 'CONFIRMED_TERMINATED',
        terminationSource: 'LOCAL_PROCESS_EXIT',
      });
      expect(termReplay).toEqual({ success: true, alreadyConfirmed: true });

      // 24. Conflicting status fails closed
      const termConflict = repo.confirmExecutionTermination({
        authorizationId: 'auth-1',
        executionId: 'exec-1',
        terminationStatus: 'UNRESOLVED',
        terminationSource: 'TIMEOUT',
      });
      expect(termConflict.success).toBe(false);
      expect(termConflict.error).toContain('TERMINATION_STATUS_CONFLICT');
    });
  });

  // =========================================================================
  // 5. Handoff Transfer Schema, Idempotency & Partial Unique Index Tests
  // =========================================================================
  describe('Handoff Transfer Durable Authority & Idempotency', () => {
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
        INSERT INTO context_snapshots (id, project_id, task_id, attempt_id, purpose, snapshot_version, builder_version, content_hash, created_at)
        VALUES ('snap-1', 'p1', 't1', 'att-1', 'HANDOFF', 1, '1.0.0', 'hash-1', '2026-08-27T00:00:00Z');
        INSERT INTO handoff_contexts (id, project_id, task_id, attempt_id, source_snapshot_id, reason, status, created_at)
        VALUES ('hc-1', 'p1', 't1', 'att-1', 'snap-1', 'CONTEXT_EXHAUSTED', 'READY', '2026-08-27T00:00:00Z');
      `);
    });

    it('12. handoff request_id replay is idempotent', () => {
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
        successor_agent_id: null,
        handoff_context_id: 'hc-1',
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

      // Replay with identical request_id
      const res2 = repo.createHandoffTransfer({
        ...transfer,
        id: 'ht-duplicate-id',
      });
      expect(res2.duplicate).toBe(true);
      expect(res2.transfer.id).toBe('ht-1');
    });

    it('13-14. active-transfer partial unique index enforces at most one active handoff, allowing new handoff after cancellation', () => {
      const transfer1: HandoffTransfer = {
        id: 'ht-active-1',
        request_id: 'req-1',
        task_id: 't1',
        source_attempt_id: 'att-1',
        successor_attempt_id: null,
        source_assignment_id: 'asgn-1',
        successor_assignment_id: null,
        successor_role_profile_id: null,
        successor_agent_profile_id: null,
        successor_agent_id: null,
        handoff_context_id: 'hc-1',
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

      repo.createHandoffTransfer(transfer1);

      // 14. Second active handoff on same source attempt is rejected by partial unique index
      expect(() => {
        repo.createHandoffTransfer({
          ...transfer1,
          id: 'ht-active-2',
          request_id: 'req-2',
        });
      }).toThrow(/UNIQUE constraint failed/);

      // Cancel the first transfer
      const updateResult = repo.updateHandoffTransferStatus({
        id: 'ht-active-1',
        fromStatus: 'REQUESTED',
        toStatus: 'CANCELLED',
        expectedVersion: 1,
      });
      expect(updateResult.success).toBe(true);
      expect(updateResult.transfer?.status).toBe('CANCELLED');

      // 13. Now a distinct later handoff request from same source attempt succeeds
      const transfer2: HandoffTransfer = {
        ...transfer1,
        id: 'ht-active-3',
        request_id: 'req-3',
        status: 'REQUESTED',
        version: 1,
      };
      const res3 = repo.createHandoffTransfer(transfer2);
      expect(res3.success).toBe(true);
      expect(res3.duplicate).toBe(false);
    });

    it('15. successor_attempt_id uniqueness rejects duplicate successor attempt bindings', () => {
      // Create successor attempt 2
      repo.createTaskAttempt({
        id: 'att-2',
        task_id: 't1',
        attempt_number: 2,
        agent_id: 'agent-2',
        status: 'INITIALIZED',
        started_at: '2026-08-27T01:00:00Z',
        ended_at: null,
        summary: null,
      });

      const transfer1: HandoffTransfer = {
        id: 'ht-succ-1',
        request_id: 'req-succ-1',
        task_id: 't1',
        source_attempt_id: 'att-1',
        successor_attempt_id: 'att-2',
        source_assignment_id: 'asgn-1',
        successor_assignment_id: null,
        successor_role_profile_id: null,
        successor_agent_profile_id: null,
        successor_agent_id: null,
        handoff_context_id: 'hc-1',
        checkpoint_id: null,
        source_authorization_id: null,
        successor_authorization_id: null,
        reason: 'CONTEXT_EXHAUSTED',
        status: 'COMPLETED',
        source_ownership_epoch: 1,
        successor_ownership_epoch: 2,
        version: 1,
        frozen_at: null,
        quiescing_at: null,
        relinquished_at: null,
        accepted_at: null,
        completed_at: '2026-08-27T01:30:00Z',
        created_at: '2026-08-27T00:00:00Z',
        updated_at: '2026-08-27T00:00:00Z',
      };
      repo.createHandoffTransfer(transfer1);

      // Create another attempt 3
      repo.createTaskAttempt({
        id: 'att-3',
        task_id: 't1',
        attempt_number: 3,
        agent_id: 'agent-3',
        status: 'INITIALIZED',
        started_at: '2026-08-27T02:00:00Z',
        ended_at: null,
        summary: null,
      });

      // Attempting to bind the same successor_attempt_id 'att-2' to another transfer must fail UNIQUE(successor_attempt_id)
      expect(() => {
        repo.createHandoffTransfer({
          ...transfer1,
          id: 'ht-succ-2',
          request_id: 'req-succ-2',
          source_attempt_id: 'att-3',
          successor_attempt_id: 'att-2', // Already bound to ht-succ-1!
        });
      }).toThrow(/UNIQUE constraint failed/);
    });
  });
});
