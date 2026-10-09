import { captureRepositoryRoot } from '../src/core/services/RepositoryRootIdentity';
import { execFileSync as initializeFixtureGit } from 'node:child_process';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { ExecutionRecoveryScanner } from '../src/core/services/ExecutionRecoveryScanner';

describe('non-handoff execution restart discovery', () => {
  let root: string;
  let db: Database.Database;
  let repo: Repository;
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-direct-recovery-')));
    db = new Database(path.join(root, 'state.sqlite'));
    db.pragma('foreign_keys=ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    const now = new Date().toISOString();
    if (!fs.existsSync(path.join(root, '.git'))) initializeFixtureGit('git', ['init', '-q', '--template=', '--initial-branch=main'], { cwd: root, stdio: 'ignore', windowsHide: true });
    repo.createProject({ id: 'P', name: 'Recovery fixture', description: null, repository_path: root,
      default_branch: 'main', status: 'RUNNING', contract: null, created_at: now, updated_at: now,
      started_at: now, completed_at: null }, captureRepositoryRoot(root));
    repo.createTask({ id: 'T', project_id: 'P', milestone_id: null, title: 'Direct execution', description: null,
      state: 'CODING', paused_from_state: null, priority: 'HIGH', risk: 'LOW', assigned_agent_id: null,
      revision_count: 0, max_revisions: 3, base_sha: 'a'.repeat(40), current_sha: 'a'.repeat(40),
      progress_cache_percent: 0, progress_computed_at: null, acceptance_criteria: [], constraints: [],
      created_at: now, updated_at: now });
    repo.createProvider({ id: 'provider', name: 'Fixture', adapter_type: 'MOCK', enabled: true, created_at: now });
    repo.createProviderAccount({ id: 'account', provider_id: 'provider', label: 'Fixture account',
      auth_mode: 'NATIVE_PROFILE', credential_ref: null, profile_ref: 'native-profile://mock/recovery', health_status: 'AVAILABLE',
      priority: 1, concurrency_limit: 1, cooldown_until: null, last_success_at: null, last_failure_at: null,
      last_failure_code: null, enabled: true, created_at: now, updated_at: now });
    repo.createProviderResource({ id: 'resource', provider_id: 'provider', provider_account_id: 'account', model_name: 'fixture',
      health_status: 'AVAILABLE', capabilities: [], enabled: true, total_quota: null, remaining_quota: null,
      quota_unit: 'REQUESTS', quota_reset_at: null, quota_source: 'UNKNOWN', quota_confidence: 0, last_health_check: null });
    repo.createRoleProfile({ id: 'role', role: 'CODER', display_name: 'Fixture coder', required_capabilities: [],
      preferred_capabilities: [], authority_scope: null, permissions: [], output_protocol: 'coder.v1',
      enabled: true, created_at: now, updated_at: now });
    repo.createAgentAssignment({ id: 'assignment', project_id: 'P', task_id: 'T', attempt_id: null,
      role_profile_id: 'role', agent_profile_id: null, selected_provider_id: 'provider',
      selected_account_id: 'account', selected_resource_id: 'resource', selected_worker_slot_id: null,
      routing_decision_id: 'route', preferred_metadata: null, status: 'ASSIGNED', created_at: now, ended_at: null });
    repo.recordProtocolMessage('manager', 'manager', 'manager.v1', 'P', 'T', 'CODING', 0, 'b'.repeat(64), '{}', 'APPLIED');
  });
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    if (fs.realpathSync.native(root) !== root || !path.basename(root).startsWith('af-direct-recovery-')) {
      throw new Error('FIXTURE_BOUNDARY_CHANGED');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  function authorize(id: string, lifecycle: 1 | null, status: 'AUTHORIZED' | 'DISPATCHED') {
    repo.createExecutionAuthorization({ id, project_id: 'P', task_id: 'T', attempt_id: null,
      task_revision: 0, base_sha: 'a'.repeat(40), repository_head_sha: 'a'.repeat(40), manager_message_id: 'manager',
      manager_payload_hash: 'b'.repeat(64), routing_decision_id: 'route', selected_resource_id: 'resource',
      selected_provider_id: 'provider', selected_account_id: lifecycle === 1 ? 'account' : undefined,
      assignment_id: lifecycle === 1 ? 'assignment' : null, task_ownership_epoch: 1, lifecycle_version: lifecycle,
      instruction_payload_hash: 'c'.repeat(64), context_manifest_hash: 'd'.repeat(64), canonical_instructions_json: '[]',
      context_files_json: '[]', canonical_payload_json: '{}', status, created_at: new Date().toISOString(),
      dispatched_at: status === 'DISPATCHED' ? new Date().toISOString() : null });
  }
  function reopen() {
    db.close();
    db = new Database(path.join(root, 'state.sqlite'));
    db.pragma('foreign_keys=ON');
    repo = new Repository(db);
    return new ExecutionRecoveryScanner(db, repo);
  }

  it('discovers a historical legacy claim after reopening SQLite and preserves an explicit idempotent fence', () => {
    authorize('legacy', null, 'DISPATCHED');
    const scanner = reopen();
    const first = scanner.scanAndReconcile();
    expect(first.items).toContainEqual(expect.objectContaining({ authorizationId: 'legacy',
      classification: 'LEGACY_UNCLASSIFIABLE', disposition: 'LEGACY_UNRESOLVED_FENCED', mutatedResources: false }));
    expect(repo.getExecutionAuthorization('legacy')?.settled_at).toBeNull();
    const events = repo.getEvents('P', 100);
    expect(events.some(event => event.type === 'NON_HANDOFF_EXECUTION_RECOVERY')).toBe(true);
    scanner.scanAndReconcile();
    expect(repo.getEvents('P', 100)).toEqual(events);
    expect(repo.getTask('T')?.state).toBe('CODING');
  });

  it('does not throw or abort an unrelated pending lifecycle-v1 authorization without a handoff transfer', () => {
    authorize('pending-direct', 1, 'AUTHORIZED');
    const scanner = reopen();
    expect(() => scanner.scanAndReconcile()).not.toThrow();
    expect(repo.getExecutionAuthorization('pending-direct')?.status).toBe('AUTHORIZED');
    expect(repo.getAgentAssignment('assignment')?.status).toBe('ASSIGNED');
    expect(repo.getTask('T')?.state).toBe('CODING');
  });

  it('keeps an old direct claim fenced without changing a newer ownership epoch or assignment', () => {
    authorize('stale-direct', 1, 'DISPATCHED');
    expect(repo.bumpTaskOwnershipEpoch('T', 1)).toMatchObject({ success: true, newEpoch: 2 });
    const report = reopen().scanAndReconcile();
    expect(report.items).toContainEqual(expect.objectContaining({ authorizationId: 'stale-direct',
      classification: 'AUTHORITY_CONFLICT', mutatedResources: false, mutatedTerminalState: false }));
    expect(repo.getTaskOwnershipEpoch('T')).toBe(2);
    expect(repo.getAgentAssignment('assignment')?.status).toBe('ASSIGNED');
  });

  it('preserves the corruption boundary when a handoff authorization loses its transfer', () => {
    authorize('auth-handoff-orphan', 1, 'AUTHORIZED');
    const scanner = reopen();
    const before = repo.getEvents('P', 100);
    expect(() => scanner.reconcileAuthorization('auth-handoff-orphan')).toThrow(/HandoffTransfer for successor authorization/);
    expect(repo.getEvents('P', 100)).toEqual(before);
    expect(repo.getAgentAssignment('assignment')?.status).toBe('ASSIGNED');
  });
});
