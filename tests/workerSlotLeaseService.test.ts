import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Repository } from '../src/core/database/repositories';
import { MigrationRunner } from '../src/core/database/migrations';
import {
  WorkerSlotLeaseService,
  DEFAULT_LEASE_TTL_MS,
  MIN_LEASE_TTL_MS,
  MAX_LEASE_TTL_MS,
} from '../src/core/services/WorkerSlotLeaseService';
import {
  Project,
  Task,
  Provider,
  ProviderAccount,
  ProviderResource,
  RoleProfile,
  AgentAssignment,
  WorkerSlot,
  AccountLease,
} from '../src/core/types/domain';

describe('R5G1A — WorkerSlotLeaseService Contract & Invariant Suite', () => {
  let db: Database.Database;
  let repo: Repository;
  let service: WorkerSlotLeaseService;
  let currentTime: Date;

  const mockClock = () => currentTime;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    currentTime = new Date('2026-08-25T12:00:00.000Z');
    service = new WorkerSlotLeaseService(repo, { clock: mockClock });

    // Seed standard test entities
    const project: Project = {
      id: 'proj-1',
      name: 'Test Project',
      description: 'Test Description',
      repository_path: '/repo/test',
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: currentTime.toISOString(),
      updated_at: currentTime.toISOString(),
      started_at: currentTime.toISOString(),
      completed_at: null,
    };
    repo.createProject(project);

    const task: Task = {
      id: 'task-1',
      project_id: 'proj-1',
      milestone_id: null,
      title: 'Task 1',
      description: 'Test Task',
      state: 'APPROVED',
      paused_from_state: null,
      priority: 'MEDIUM',
      risk: 'LOW',
      assigned_agent_id: null,
      revision_count: 1,
      max_revisions: 3,
      base_sha: '6068f583e0f51f146691870e5066c4bc324f847e',
      current_sha: '6068f583e0f51f146691870e5066c4bc324f847e',
      progress_cache_percent: 0.0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: currentTime.toISOString(),
      updated_at: currentTime.toISOString(),
    };
    repo.createTask(task);

    const provider: Provider = {
      id: 'prov-mock',
      name: 'Mock Provider',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: currentTime.toISOString(),
    };
    repo.createProvider(provider);

    const account: ProviderAccount = {
      id: 'acc-1',
      provider_id: 'prov-mock',
      label: 'Account 1',
      auth_mode: 'NATIVE_PROFILE',
      credential_ref: null,
      profile_ref: 'native-profile://mock/p1',
      health_status: 'AVAILABLE',
      priority: 10,
      cooldown_until: null,
      concurrency_limit: 2,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      enabled: true,
      created_at: currentTime.toISOString(),
      updated_at: currentTime.toISOString(),
    };
    repo.createProviderAccount(account);

    const resource1: ProviderResource = {
      id: 'res-1',
      provider_id: 'prov-mock',
      provider_account_id: 'acc-1',
      model_name: 'mock-model-1',
      health_status: 'AVAILABLE',
      capabilities: ['CODING', 'FILESYSTEM_EDIT'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 0,
      last_health_check: currentTime.toISOString(),
    };
    repo.createProviderResource(resource1);

    const resource2: ProviderResource = {
      id: 'res-2',
      provider_id: 'prov-mock',
      provider_account_id: 'acc-1',
      model_name: 'mock-model-2',
      health_status: 'AVAILABLE',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 0,
      last_health_check: currentTime.toISOString(),
    };
    repo.createProviderResource(resource2);

    const roleProfile: RoleProfile = {
      id: 'role-coder',
      role: 'CODER',
      display_name: 'Coder Role',
      required_capabilities: ['CODING'],
      preferred_capabilities: [],
      authority_scope: null,
      permissions: ['read', 'write'],
      output_protocol: 'coder.v1',
      enabled: true,
      created_at: currentTime.toISOString(),
      updated_at: currentTime.toISOString(),
    };
    repo.createRoleProfile(roleProfile);
  });

  afterEach(() => {
    db.close();
  });

  function createAssignment(id: string, resourceId: string = 'res-1', preBoundSlotId: string | null = null): AgentAssignment {
    const assignment: AgentAssignment = {
      id,
      project_id: 'proj-1',
      task_id: 'task-1',
      attempt_id: null,
      role_profile_id: 'role-coder',
      agent_profile_id: null,
      selected_provider_id: 'prov-mock',
      selected_account_id: 'acc-1',
      selected_resource_id: resourceId,
      selected_worker_slot_id: preBoundSlotId,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: currentTime.toISOString(),
      ended_at: null,
    };
    repo.createAgentAssignment(assignment);
    return assignment;
  }

  function createSlot(id: string, accountId: string, slotIndex: number, resourceId: string | null = null): WorkerSlot {
    const slot: WorkerSlot = {
      id,
      provider_account_id: accountId,
      provider_resource_id: resourceId,
      slot_index: slotIndex,
      status: 'IDLE',
      current_assignment_id: null,
      current_execution_id: null,
      heartbeat_at: null,
      created_at: currentTime.toISOString(),
      updated_at: currentTime.toISOString(),
    };
    repo.createWorkerSlot(slot);
    return slot;
  }

  // =========================================================================
  // 1. Fresh Allocation & Invariant Checks
  // =========================================================================

  it('1. Fresh ASSIGNED assignment claims eligible slot', () => {
    createSlot('slot-1', 'acc-1', 0);
    const asgn = createAssignment('asgn-1');

    const result = service.acquireForAssignment(asgn.id);
    expect(result.status).toBe('ACQUIRED');
    if (result.status === 'ACQUIRED') {
      expect(result.slot.id).toBe('slot-1');
      expect(result.lease.assignment_id).toBe('asgn-1');
      expect(result.lease.worker_slot_id).toBe('slot-1');
      expect(result.lease.provider_account_id).toBe('acc-1');
    }
  });

  it('2. assignment.selected_worker_slot_id becomes claimed slot', () => {
    createSlot('slot-1', 'acc-1', 0);
    const asgn = createAssignment('asgn-1');

    const result = service.acquireForAssignment(asgn.id);
    expect(result.status).toBe('ACQUIRED');

    const updatedAsgn = repo.getAgentAssignment('asgn-1')!;
    expect(updatedAsgn.selected_worker_slot_id).toBe('slot-1');
  });

  it('3. AccountLease inserted with correct assignment/account/slot chain', () => {
    createSlot('slot-1', 'acc-1', 0);
    const asgn = createAssignment('asgn-1');

    const result = service.acquireForAssignment(asgn.id);
    expect(result.status).toBe('ACQUIRED');
    if (result.status === 'ACQUIRED') {
      const lease = repo.getAccountLease(result.lease.id)!;
      expect(lease).toBeDefined();
      expect(lease.assignment_id).toBe('asgn-1');
      expect(lease.provider_account_id).toBe('acc-1');
      expect(lease.worker_slot_id).toBe('slot-1');
      expect(lease.released_at).toBeNull();
      expect(lease.acquired_at).toBe(currentTime.toISOString());
      expect(lease.expires_at).toBe(new Date(currentTime.getTime() + DEFAULT_LEASE_TTL_MS).toISOString());
    }
  });

  it('4. WorkerSlot becomes LEASED with correct current_assignment_id', () => {
    createSlot('slot-1', 'acc-1', 0);
    const asgn = createAssignment('asgn-1');

    service.acquireForAssignment(asgn.id);
    const slot = repo.getWorkerSlot('slot-1')!;
    expect(slot.status).toBe('LEASED');
    expect(slot.current_assignment_id).toBe('asgn-1');
    expect(slot.heartbeat_at).toBe(currentTime.toISOString());
  });

  it('5. current_execution_id remains null', () => {
    createSlot('slot-1', 'acc-1', 0);
    const asgn = createAssignment('asgn-1');

    service.acquireForAssignment(asgn.id);
    const slot = repo.getWorkerSlot('slot-1')!;
    expect(slot.current_execution_id).toBeNull();
  });

  // =========================================================================
  // 2. Deterministic Slot Selection & Resource Compatibility
  // =========================================================================

  it('6. Deterministic lowest slot_index then ID selection', () => {
    createSlot('slot-b', 'acc-1', 2);
    createSlot('slot-a', 'acc-1', 1);
    createSlot('slot-c', 'acc-1', 0);
    const asgn = createAssignment('asgn-1');

    const result = service.acquireForAssignment(asgn.id);
    expect(result.status).toBe('ACQUIRED');
    if (result.status === 'ACQUIRED') {
      // slot-c has slot_index 0 < slot-a (1) < slot-b (2)
      expect(result.slot.id).toBe('slot-c');
    }
  });

  it('7. Resource-bound incompatible slot excluded', () => {
    // slot-1 is dedicated to res-2, but asgn-1 needs res-1
    createSlot('slot-1', 'acc-1', 0, 'res-2');
    const asgn = createAssignment('asgn-1', 'res-1');

    const result = service.acquireForAssignment(asgn.id);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.code).toBe('NO_ELIGIBLE_SLOT');
    }
  });

  it('8. Generic account slot with provider_resource_id null is eligible', () => {
    createSlot('slot-generic', 'acc-1', 0, null);
    const asgn = createAssignment('asgn-1', 'res-1');

    const result = service.acquireForAssignment(asgn.id);
    expect(result.status).toBe('ACQUIRED');
    if (result.status === 'ACQUIRED') {
      expect(result.slot.id).toBe('slot-generic');
    }
  });

  // =========================================================================
  // 3. Account Schedulability & Capacity Guards
  // =========================================================================

  it('9. Disabled account denied (ACCOUNT_UNAVAILABLE)', () => {
    db.prepare('UPDATE provider_accounts SET enabled = 0 WHERE id = ?').run('acc-1');
    createSlot('slot-1', 'acc-1', 0);
    const asgn = createAssignment('asgn-1');

    const result = service.acquireForAssignment(asgn.id);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.code).toBe('ACCOUNT_UNAVAILABLE');
    }
  });

  it('10. AUTH_ERROR denied distinctly with no fallback (ACCOUNT_AUTH_ERROR)', () => {
    db.prepare("UPDATE provider_accounts SET health_status = 'AUTH_ERROR' WHERE id = ?").run('acc-1');
    createSlot('slot-1', 'acc-1', 0);
    const asgn = createAssignment('asgn-1');

    const result = service.acquireForAssignment(asgn.id);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.code).toBe('ACCOUNT_AUTH_ERROR');
    }
  });

  it('11. Future cooldown_until denied (ACCOUNT_COOLDOWN)', () => {
    const futureIso = new Date(currentTime.getTime() + 60_000).toISOString();
    db.prepare('UPDATE provider_accounts SET cooldown_until = ? WHERE id = ?').run(futureIso, 'acc-1');
    createSlot('slot-1', 'acc-1', 0);
    const asgn = createAssignment('asgn-1');

    const result = service.acquireForAssignment(asgn.id);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.code).toBe('ACCOUNT_COOLDOWN');
    }
  });

  it('12. Account concurrency_limit enforced (ACCOUNT_CAPACITY_EXHAUSTED)', () => {
    // acc-1 has concurrency_limit: 2
    createSlot('slot-1', 'acc-1', 0);
    createSlot('slot-2', 'acc-1', 1);
    createSlot('slot-3', 'acc-1', 2);

    const asgn1 = createAssignment('asgn-1');
    const asgn2 = createAssignment('asgn-2');
    const asgn3 = createAssignment('asgn-3');

    expect(service.acquireForAssignment(asgn1.id).status).toBe('ACQUIRED');
    expect(service.acquireForAssignment(asgn2.id).status).toBe('ACQUIRED');

    const res3 = service.acquireForAssignment(asgn3.id);
    expect(res3.status).toBe('FAILED');
    if (res3.status === 'FAILED') {
      expect(res3.code).toBe('ACCOUNT_CAPACITY_EXHAUSTED');
    }
  });

  // =========================================================================
  // 4. Double Lease & Rebind Protections
  // =========================================================================

  it('13. Same slot cannot receive two unreleased leases', () => {
    createSlot('slot-1', 'acc-1', 0);
    const asgn1 = createAssignment('asgn-1');
    const asgn2 = createAssignment('asgn-2');

    expect(service.acquireForAssignment(asgn1.id).status).toBe('ACQUIRED');

    const res2 = service.acquireForAssignment(asgn2.id);
    expect(res2.status).toBe('FAILED');
    if (res2.status === 'FAILED') {
      expect(resultMatches(res2.code, ['NO_ELIGIBLE_SLOT', 'ACCOUNT_CAPACITY_EXHAUSTED'])).toBe(true);
    }
  });

  it('14. Same assignment cannot receive two simultaneous active leases (ASSIGNMENT_ALREADY_LEASED)', () => {
    createSlot('slot-1', 'acc-1', 0);
    createSlot('slot-2', 'acc-1', 1);
    const asgn1 = createAssignment('asgn-1');

    expect(service.acquireForAssignment(asgn1.id).status).toBe('ACQUIRED');

    const res2 = service.acquireForAssignment(asgn1.id);
    expect(res2.status).toBe('FAILED');
    if (res2.status === 'FAILED') {
      expect(res2.code).toBe('ASSIGNMENT_ALREADY_LEASED');
    }
  });

  it("15. Second fresh assignment cannot overwrite another assignment's slot", () => {
    createSlot('slot-1', 'acc-1', 0);
    const asgn1 = createAssignment('asgn-1');
    const asgn2 = createAssignment('asgn-2');

    service.acquireForAssignment(asgn1.id);
    service.acquireForAssignment(asgn2.id);

    const checkAsgn2 = repo.getAgentAssignment('asgn-2')!;
    expect(checkAsgn2.selected_worker_slot_id).toBeNull();
  });

  it('16. Pre-bound assignment is never rebound to another slot', () => {
    createSlot('slot-1', 'acc-1', 0);
    createSlot('slot-2', 'acc-1', 1);
    const asgn = createAssignment('asgn-1', 'res-1', 'slot-2');

    const res = service.acquireForAssignment(asgn.id);
    expect(res.status).toBe('ACQUIRED');
    if (res.status === 'ACQUIRED') {
      expect(res.slot.id).toBe('slot-2');
    }
  });

  it('17. Pre-bound released assignment may reacquire only its same slot', () => {
    createSlot('slot-1', 'acc-1', 0);
    createSlot('slot-2', 'acc-1', 1);
    const asgn = createAssignment('asgn-1');

    const acq1 = service.acquireForAssignment(asgn.id);
    expect(acq1.status).toBe('ACQUIRED');
    if (acq1.status === 'ACQUIRED') {
      expect(acq1.slot.id).toBe('slot-1');
      service.release(acq1.lease.id, acq1.lease.lease_token);
    }

    // Now slot-1 is released and asgn-1 is pre-bound to slot-1
    // Even if slot-0 exists with lower index, asgn-1 must reacquire slot-1
    createSlot('slot-0', 'acc-1', -1);
    const acq2 = service.acquireForAssignment(asgn.id);
    expect(acq2.status).toBe('ACQUIRED');
    if (acq2.status === 'ACQUIRED') {
      expect(acq2.slot.id).toBe('slot-1');
    }
  });

  // =========================================================================
  // 5. Stale / Expired Lease Policy & Heartbeat Semantics
  // =========================================================================

  it('18. Expired unreleased lease is NOT automatically reclaimed (STALE_LEASE_REQUIRES_RECOVERY)', () => {
    createSlot('slot-1', 'acc-1', 0);
    const asgn1 = createAssignment('asgn-1');
    const acq1 = service.acquireForAssignment(asgn1.id, 10_000);
    expect(acq1.status).toBe('ACQUIRED');

    // Advance clock past expiration
    currentTime = new Date(currentTime.getTime() + 15_000);

    const asgn2 = createAssignment('asgn-2');
    const acq2 = service.acquireForAssignment(asgn2.id);
    expect(acq2.status).toBe('FAILED');
    if (acq2.status === 'FAILED') {
      expect(acq2.code).toBe('STALE_LEASE_REQUIRES_RECOVERY');
    }
  });

  it('19. Expired lease heartbeat cannot resurrect it (LEASE_EXPIRED)', () => {
    createSlot('slot-1', 'acc-1', 0);
    const asgn1 = createAssignment('asgn-1');
    const acq1 = service.acquireForAssignment(asgn1.id, 10_000);
    expect(acq1.status).toBe('ACQUIRED');

    if (acq1.status === 'ACQUIRED') {
      currentTime = new Date(currentTime.getTime() + 15_000);
      const hb = service.heartbeat(acq1.lease.id, acq1.lease.lease_token);
      expect(hb.status).toBe('FAILED');
      if (hb.status === 'FAILED') {
        expect(hb.code).toBe('LEASE_EXPIRED');
      }
    }
  });

  it('20. Heartbeat with correct token extends lease and updates heartbeat', () => {
    createSlot('slot-1', 'acc-1', 0);
    const asgn1 = createAssignment('asgn-1');
    const acq1 = service.acquireForAssignment(asgn1.id, 10_000);
    expect(acq1.status).toBe('ACQUIRED');

    if (acq1.status === 'ACQUIRED') {
      currentTime = new Date(currentTime.getTime() + 5_000);
      const hb = service.heartbeat(acq1.lease.id, acq1.lease.lease_token, 20_000);
      expect(hb.status).toBe('HEARTBEAT_ACKNOWLEDGED');
      if (hb.status === 'HEARTBEAT_ACKNOWLEDGED') {
        expect(hb.lease.heartbeat_at).toBe(currentTime.toISOString());
        expect(hb.lease.expires_at).toBe(new Date(currentTime.getTime() + 20_000).toISOString());
        expect(hb.slot.heartbeat_at).toBe(currentTime.toISOString());
      }
    }
  });

  it('21. Heartbeat with wrong token mutates nothing (LEASE_TOKEN_MISMATCH)', () => {
    createSlot('slot-1', 'acc-1', 0);
    const asgn1 = createAssignment('asgn-1');
    const acq1 = service.acquireForAssignment(asgn1.id, 10_000);
    expect(acq1.status).toBe('ACQUIRED');

    if (acq1.status === 'ACQUIRED') {
      const origExpires = acq1.lease.expires_at;
      const hb = service.heartbeat(acq1.lease.id, 'wrong-token');
      expect(hb.status).toBe('FAILED');
      if (hb.status === 'FAILED') {
        expect(hb.code).toBe('LEASE_TOKEN_MISMATCH');
      }

      const lease = repo.getAccountLease(acq1.lease.id)!;
      expect(lease.expires_at).toBe(origExpires);
    }
  });

  // =========================================================================
  // 6. Release Semantics
  // =========================================================================

  it('22. Release with correct token releases lease and returns slot to IDLE', () => {
    createSlot('slot-1', 'acc-1', 0);
    const asgn1 = createAssignment('asgn-1');
    const acq1 = service.acquireForAssignment(asgn1.id);
    expect(acq1.status).toBe('ACQUIRED');

    if (acq1.status === 'ACQUIRED') {
      currentTime = new Date(currentTime.getTime() + 1_000);
      const rel = service.release(acq1.lease.id, acq1.lease.lease_token);
      expect(rel.status).toBe('RELEASED');
      if (rel.status === 'RELEASED') {
        expect(rel.lease.released_at).toBe(currentTime.toISOString());
        expect(rel.slot.status).toBe('IDLE');
        expect(rel.slot.current_assignment_id).toBeNull();
        expect(rel.slot.current_execution_id).toBeNull();
      }
    }
  });

  it('23. Release retains assignment.selected_worker_slot_id', () => {
    createSlot('slot-1', 'acc-1', 0);
    const asgn1 = createAssignment('asgn-1');
    const acq1 = service.acquireForAssignment(asgn1.id);
    expect(acq1.status).toBe('ACQUIRED');

    if (acq1.status === 'ACQUIRED') {
      service.release(acq1.lease.id, acq1.lease.lease_token);
      const asgn = repo.getAgentAssignment('asgn-1')!;
      expect(asgn.selected_worker_slot_id).toBe('slot-1');
    }
  });

  it('24. Release with wrong token mutates nothing (LEASE_TOKEN_MISMATCH)', () => {
    createSlot('slot-1', 'acc-1', 0);
    const asgn1 = createAssignment('asgn-1');
    const acq1 = service.acquireForAssignment(asgn1.id);
    expect(acq1.status).toBe('ACQUIRED');

    if (acq1.status === 'ACQUIRED') {
      const rel = service.release(acq1.lease.id, 'bad-token');
      expect(rel.status).toBe('FAILED');
      if (rel.status === 'FAILED') {
        expect(rel.code).toBe('LEASE_TOKEN_MISMATCH');
      }

      const lease = repo.getAccountLease(acq1.lease.id)!;
      expect(lease.released_at).toBeNull();
      const slot = repo.getWorkerSlot('slot-1')!;
      expect(slot.status).toBe('LEASED');
    }
  });

  // =========================================================================
  // 7. Invariants, Rollback & Direct Constraints
  // =========================================================================

  it('25. Slot/assignment/lease chain mismatch fails closed', () => {
    createSlot('slot-1', 'acc-1', 0);
    const asgn1 = createAssignment('asgn-1');
    const acq1 = service.acquireForAssignment(asgn1.id);
    expect(acq1.status).toBe('ACQUIRED');

    if (acq1.status === 'ACQUIRED') {
      // Corrupt slot assignment
      db.prepare("UPDATE worker_slots SET current_assignment_id = 'other-asgn' WHERE id = ?").run('slot-1');
      const rel = service.release(acq1.lease.id, acq1.lease.lease_token);
      expect(rel.status).toBe('FAILED');
      if (rel.status === 'FAILED') {
        expect(rel.code).toBe('SLOT_STATE_MISMATCH');
      }
    }
  });

  it('26. Failed claim transaction leaves zero partial binding (atomic rollback)', () => {
    createSlot('slot-1', 'acc-1', 0);
    const asgn1 = createAssignment('asgn-1');

    // Simulate token factory crash to trigger rollback during transaction
    const faultService = new WorkerSlotLeaseService(repo, {
      tokenFactory: () => {
        throw new Error('Simulated token crash');
      },
    });

    expect(() => faultService.acquireForAssignment(asgn1.id)).toThrow('Simulated token crash');

    const asgn = repo.getAgentAssignment('asgn-1')!;
    expect(asgn.selected_worker_slot_id).toBeNull();

    const slot = repo.getWorkerSlot('slot-1')!;
    expect(slot.status).toBe('IDLE');
    expect(slot.current_assignment_id).toBeNull();

    const leases = repo.getAccountLeasesByAssignment('asgn-1');
    expect(leases.length).toBe(0);
  });

  it('27. Active-slot unique DB constraint still rejects direct duplicate active lease insertion', () => {
    createSlot('slot-1', 'acc-1', 0);
    createAssignment('asgn-1', 'res-1', 'slot-1');
    createAssignment('asgn-2', 'res-1', 'slot-1');

    const lease1: AccountLease = {
      id: 'lease-1',
      assignment_id: 'asgn-1',
      provider_account_id: 'acc-1',
      worker_slot_id: 'slot-1',
      lease_token: 'tok-1',
      acquired_at: currentTime.toISOString(),
      expires_at: new Date(currentTime.getTime() + 10_000).toISOString(),
      heartbeat_at: currentTime.toISOString(),
      released_at: null,
    };
    repo.createAccountLease(lease1);

    const lease2: AccountLease = {
      id: 'lease-2',
      assignment_id: 'asgn-2',
      provider_account_id: 'acc-1',
      worker_slot_id: 'slot-1',
      lease_token: 'tok-2',
      acquired_at: currentTime.toISOString(),
      expires_at: new Date(currentTime.getTime() + 10_000).toISOString(),
      heartbeat_at: currentTime.toISOString(),
      released_at: null,
    };
    expect(() => repo.createAccountLease(lease2)).toThrow(/UNIQUE constraint failed/);
  });

  it('28. ProviderDispatchService is not called / not imported in WorkerSlotLeaseService', async () => {
    const fs = await import('fs');
    const serviceSource = fs.readFileSync('src/core/services/WorkerSlotLeaseService.ts', 'utf8');
    expect(serviceSource).not.toContain('ProviderDispatchService');
    expect(serviceSource).not.toContain('dispatch');
  });

  it('29. No git worktree is created during slot lease lifecycle', async () => {
    const fs = await import('fs');
    const serviceSource = fs.readFileSync('src/core/services/WorkerSlotLeaseService.ts', 'utf8');
    expect(serviceSource).not.toContain('worktree');
    expect(serviceSource).not.toContain('git');
  });

  it('30. No provider-specific selection logic exists (agnostic slot leasing)', () => {
    // Test with a second provider type (API/MOCK)
    const providerApi: Provider = {
      id: 'prov-api',
      name: 'API Provider',
      adapter_type: 'API',
      enabled: true,
      created_at: currentTime.toISOString(),
    };
    repo.createProvider(providerApi);

    const accountApi: ProviderAccount = {
      id: 'acc-api',
      provider_id: 'prov-api',
      label: 'API Account',
      auth_mode: 'NATIVE_PROFILE',
      credential_ref: null,
      profile_ref: 'native-profile://api/p1',
      health_status: 'AVAILABLE',
      priority: 10,
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      enabled: true,
      created_at: currentTime.toISOString(),
      updated_at: currentTime.toISOString(),
    };
    repo.createProviderAccount(accountApi);

    const resApi: ProviderResource = {
      id: 'res-api',
      provider_id: 'prov-api',
      provider_account_id: 'acc-api',
      model_name: 'api-model',
      health_status: 'AVAILABLE',
      capabilities: ['CODING'],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'UNKNOWN',
      quota_confidence: 0,
      last_health_check: currentTime.toISOString(),
    };
    repo.createProviderResource(resApi);

    createSlot('slot-api', 'acc-api', 0);

    const asgnApi: AgentAssignment = {
      id: 'asgn-api',
      project_id: 'proj-1',
      task_id: 'task-1',
      attempt_id: null,
      role_profile_id: 'role-coder',
      agent_profile_id: null,
      selected_provider_id: 'prov-api',
      selected_account_id: 'acc-api',
      selected_resource_id: 'res-api',
      selected_worker_slot_id: null,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: currentTime.toISOString(),
      ended_at: null,
    };
    repo.createAgentAssignment(asgnApi);

    const result = service.acquireForAssignment(asgnApi.id);
    expect(result.status).toBe('ACQUIRED');
    if (result.status === 'ACQUIRED') {
      expect(result.slot.id).toBe('slot-api');
      expect(result.lease.provider_account_id).toBe('acc-api');
    }
  });

  // =========================================================================
  // 8. TTL Bounds Validation
  // =========================================================================

  it('31. Invalid TTL bounds rejected (INVALID_TTL)', () => {
    createSlot('slot-1', 'acc-1', 0);
    const asgn = createAssignment('asgn-1');

    expect(service.acquireForAssignment(asgn.id, 0).status).toBe('FAILED');
    expect(service.acquireForAssignment(asgn.id, -100).status).toBe('FAILED');
    expect(service.acquireForAssignment(asgn.id, NaN).status).toBe('FAILED');
    expect(service.acquireForAssignment(asgn.id, Infinity).status).toBe('FAILED');
    expect(service.acquireForAssignment(asgn.id, MIN_LEASE_TTL_MS - 1).status).toBe('FAILED');
    expect(service.acquireForAssignment(asgn.id, MAX_LEASE_TTL_MS + 1).status).toBe('FAILED');
  });
});

function resultMatches(actual: string, expected: string[]): boolean {
  return expected.includes(actual);
}
