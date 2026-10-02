import crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Repository } from '../src/core/database/repositories';
import { MigrationRunner } from '../src/core/database/migrations';
import { AccountLease } from '../src/core/types/domain';
import { DEFAULT_LEASE_TTL_MS, WorkerSlotLeaseService } from '../src/core/services/WorkerSlotLeaseService';
import {
  createProductLeaseRecoveryMarkerEvent,
  PRODUCT_LEASE_RECOVERY_REQUIRED_EVENT,
  PRODUCT_LEASE_RECOVERY_RESOLVED_EVENT,
  ProductLeaseRecoveryScanner,
} from '../src/core/services/ProductLeaseRecoveryScanner';

describe('Product lease recovery release/evidence atomicity', () => {
  let db: Database.Database;
  let repo: Repository;
  let service: WorkerSlotLeaseService;
  let lease: AccountLease;
  let now: Date;
  const clock = () => now;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    now = new Date('2026-08-25T12:00:00.000Z');
    const timestamp = now.toISOString();
    repo.createProject({
      id: 'atomic-project', name: 'Recovery atomicity', description: null,
      repository_path: '/repo/recovery-atomicity', default_branch: 'main',
      status: 'RUNNING', contract: null, created_at: timestamp,
      updated_at: timestamp, started_at: timestamp, completed_at: null,
    });
    repo.createTask({
      id: 'atomic-task', project_id: 'atomic-project', milestone_id: null,
      title: 'Recover a lease', description: 'Synthetic recovery fixture',
      state: 'APPROVED', paused_from_state: null, priority: 'MEDIUM', risk: 'LOW',
      assigned_agent_id: null, revision_count: 1, max_revisions: 3,
      base_sha: '6068f583e0f51f146691870e5066c4bc324f847e',
      current_sha: '6068f583e0f51f146691870e5066c4bc324f847e',
      progress_cache_percent: 0, progress_computed_at: null,
      acceptance_criteria: [], constraints: [], created_at: timestamp, updated_at: timestamp,
    });
    repo.createProvider({
      id: 'atomic-provider', name: 'Synthetic provider', adapter_type: 'LOCAL_CLI',
      enabled: true, created_at: timestamp,
    });
    repo.createProviderAccount({
      id: 'atomic-account', provider_id: 'atomic-provider', label: 'Synthetic account',
      auth_mode: 'NATIVE_PROFILE', credential_ref: null, profile_ref: 'native-profile://mock/p1',
      health_status: 'AVAILABLE', priority: 10, cooldown_until: null, concurrency_limit: 1,
      last_success_at: null, last_failure_at: null, last_failure_code: null,
      enabled: true, created_at: timestamp, updated_at: timestamp,
    });
    repo.createProviderResource({
      id: 'atomic-resource', provider_id: 'atomic-provider', provider_account_id: 'atomic-account',
      model_name: 'synthetic-model', health_status: 'AVAILABLE', capabilities: ['CODING'],
      enabled: true, total_quota: null, remaining_quota: null, quota_unit: 'REQUESTS',
      quota_reset_at: null, quota_source: 'UNKNOWN', quota_confidence: 0,
      last_health_check: timestamp,
    });
    repo.createRoleProfile({
      id: 'atomic-role', role: 'CODER', display_name: 'Synthetic coder',
      required_capabilities: ['CODING'], preferred_capabilities: [], authority_scope: null,
      permissions: ['read', 'write'], output_protocol: 'coder.v1', enabled: true,
      created_at: timestamp, updated_at: timestamp,
    });
    repo.createWorkerSlot({
      id: 'atomic-slot', provider_account_id: 'atomic-account', provider_resource_id: null,
      slot_index: 0, status: 'IDLE', current_assignment_id: null,
      current_execution_id: null, heartbeat_at: null, created_at: timestamp, updated_at: timestamp,
    });
    repo.createAgentAssignment({
      id: 'atomic-assignment', project_id: 'atomic-project', task_id: 'atomic-task',
      attempt_id: null, role_profile_id: 'atomic-role', agent_profile_id: null,
      selected_provider_id: 'atomic-provider', selected_account_id: 'atomic-account',
      selected_resource_id: 'atomic-resource', selected_worker_slot_id: null,
      routing_decision_id: null, preferred_metadata: null, status: 'ASSIGNED',
      created_at: timestamp, ended_at: null,
    });
    service = new WorkerSlotLeaseService(repo, { clock });
    const acquired = service.acquireForAssignment('atomic-assignment');
    if (acquired.status !== 'ACQUIRED') throw new Error('Synthetic fixture lease acquisition failed');
    lease = acquired.lease;
    now = new Date(now.getTime() + DEFAULT_LEASE_TTL_MS + 1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  function scanner(): ProductLeaseRecoveryScanner {
    return new ProductLeaseRecoveryScanner(db, repo, { leaseService: service, clock });
  }

  function markRecoveryRequired(): string {
    const marker = createProductLeaseRecoveryMarkerEvent({
      leaseId: lease.id, assignmentId: lease.assignment_id, taskId: 'atomic-task',
      projectId: 'atomic-project', accountId: lease.provider_account_id,
      workerSlotId: lease.worker_slot_id, leaseToken: lease.lease_token,
      reasonCode: 'INJECTED_CLEANUP_FAILURE', reason: 'Synthetic cleanup failure',
      observedAt: now.toISOString(),
    });
    repo.createDeterministicGenericEvent(marker);
    return marker.id;
  }

  function countEvents(type: string): number {
    return (db.prepare('SELECT COUNT(*) AS count FROM events WHERE type = ?').get(type) as { count: number }).count;
  }

  it.each(['before insert', 'after insert'] as const)(
    'rolls back release when resolution fails %s and retries exactly once',
    (failurePoint) => {
      const markerId = markRecoveryRequired();
      const originalWrite = repo.createDeterministicGenericEvent.bind(repo);
      const write = vi.spyOn(repo, 'createDeterministicGenericEvent').mockImplementation((event) => {
        if (event.type === PRODUCT_LEASE_RECOVERY_RESOLVED_EVENT) {
          if (failurePoint === 'after insert') originalWrite(event);
          throw new Error('INJECTED_RESOLUTION_WRITE_FAILURE');
        }
        return originalWrite(event);
      });

      const failed = scanner().scanAndReconcile();
      expect(failed.releasedCount).toBe(0);
      expect(failed.deferredCount).toBe(1);
      expect(failed.items[0].reason).toContain('INJECTED_RESOLUTION_WRITE_FAILURE');
      expect(repo.getAccountLease(lease.id)?.released_at).toBeNull();
      expect(repo.getWorkerSlot(lease.worker_slot_id)).toMatchObject({
        status: 'LEASED', current_assignment_id: lease.assignment_id, current_execution_id: null,
      });
      expect(countEvents(PRODUCT_LEASE_RECOVERY_REQUIRED_EVENT)).toBe(1);
      expect(countEvents(PRODUCT_LEASE_RECOVERY_RESOLVED_EVENT)).toBe(0);
      expect(db.inTransaction).toBe(false);

      write.mockRestore();
      // A fresh scanner models the next recovery pass; the unreleased row
      // must still be discoverable, without replaying provider execution.
      const retried = scanner().scanAndReconcile();
      expect(retried.releasedCount).toBe(1);
      expect(retried.items[0].markerEventId).toBe(markerId);
      expect(repo.getAccountLease(lease.id)?.released_at).not.toBeNull();
      expect(repo.getWorkerSlot(lease.worker_slot_id)).toMatchObject({
        status: 'IDLE', current_assignment_id: null, current_execution_id: null,
      });
      expect(countEvents(PRODUCT_LEASE_RECOVERY_RESOLVED_EVENT)).toBe(1);
      expect(scanner().scanAndReconcile().scannedCount).toBe(0);
      expect(countEvents(PRODUCT_LEASE_RECOVERY_RESOLVED_EVENT)).toBe(1);
    },
  );

  it('writes closure inside the same transaction as release and preserves the required marker', () => {
    const markerId = markRecoveryRequired();
    const originalWrite = repo.createDeterministicGenericEvent.bind(repo);
    let observedAtomicClosure = false;
    vi.spyOn(repo, 'createDeterministicGenericEvent').mockImplementation((event) => {
      if (event.type === PRODUCT_LEASE_RECOVERY_RESOLVED_EVENT) {
        // Recording a boolean rather than throwing here ensures the former
        // swallow-errors helper cannot hide a failed assertion in the spy.
        observedAtomicClosure = db.inTransaction
          && repo.getAccountLease(lease.id)?.released_at != null
          && repo.getWorkerSlot(lease.worker_slot_id)?.status === 'IDLE';
        expect(event.structured_payload).toMatchObject({ recovery_marker_event_id: markerId });
        expect(JSON.stringify(event)).not.toContain(lease.lease_token);
      }
      return originalWrite(event);
    });
    expect(scanner().scanAndReconcile().releasedCount).toBe(1);
    expect(observedAtomicClosure).toBe(true);
    expect(countEvents(PRODUCT_LEASE_RECOVERY_REQUIRED_EVENT)).toBe(1);
    expect(countEvents(PRODUCT_LEASE_RECOVERY_RESOLVED_EVENT)).toBe(1);
    expect(db.inTransaction).toBe(false);
  });

  it('does not invent a resolution event for a lease with no recovery marker', () => {
    expect(scanner().scanAndReconcile().releasedCount).toBe(1);
    expect(countEvents(PRODUCT_LEASE_RECOVERY_REQUIRED_EVENT)).toBe(0);
    expect(countEvents(PRODUCT_LEASE_RECOVERY_RESOLVED_EVENT)).toBe(0);
    expect(scanner().scanAndReconcile().scannedCount).toBe(0);
  });

  it('does not resolve an old marker or release capacity after the owner token changes', () => {
    markRecoveryRequired();
    const originalRecover = service.recoverExpiredLease.bind(service);
    const successorToken = crypto.randomUUID();
    vi.spyOn(service, 'recoverExpiredLease').mockImplementation((id, token, recoveredAt, options) => {
      // Replace ownership after candidate capture, immediately before the
      // actual service performs its token fence. No ID-only cleanup is valid.
      db.prepare('UPDATE account_leases SET lease_token = ? WHERE id = ?').run(successorToken, id);
      return originalRecover(id, token, recoveredAt, options);
    });
    const report = scanner().scanAndReconcile();
    expect(report.releasedCount).toBe(0);
    expect(report.quarantinedCount).toBe(1);
    expect(repo.getAccountLease(lease.id)?.released_at).toBeNull();
    expect(repo.getAccountLease(lease.id)?.lease_token === successorToken).toBe(true);
    expect(repo.getWorkerSlot(lease.worker_slot_id)?.status).toBe('LEASED');
    expect(countEvents(PRODUCT_LEASE_RECOVERY_RESOLVED_EVENT)).toBe(0);
  });
});
