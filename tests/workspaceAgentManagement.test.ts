import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import { BootstrapService } from '../src/core/services/BootstrapService';
import { WorkspaceManagementService } from '../src/core/services/WorkspaceManagementService';

const NOW = '2026-10-24T08:00:00.000Z';

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

describe('owner agent roster management', () => {
  let dir: string;
  let dbPath: string;
  let db: Database.Database;
  let repo: Repository;
  let service: WorkspaceManagementService;

  const open = () => {
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
    service = new WorkspaceManagementService(repo, () => NOW);
  };

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'af-agent-roster-')));
    dbPath = path.join(dir, 'agent-forge.db');
    open();
    BootstrapService.seedDefaultResources(repo);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const createCodex = (overrides: Record<string, unknown> = {}) => service.createAgent({
    displayName: 'Lập trình viên Chính',
    role: 'CODER',
    connection: 'CODEX_CLI',
    modelName: 'gpt-5-codex',
    workerSlots: 2,
    instructions: 'Prefer small changes.',
    ...overrides,
  });

  it('creates a Manual Bridge agent with separated role/profile/resource identities and no worker slots', () => {
    const result = service.createAgent({ displayName: 'Planner', role: 'PRIMARY_MANAGER', connection: 'MANUAL_BRIDGE', modelName: 'ChatGPT' });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const entry = service.listAgents().find((item) => item.agent.id === result.agent.id)!;
    expect(entry.connection).toBe('MANUAL_BRIDGE');
    expect(entry.agent).toMatchObject({ role: 'PRIMARY_MANAGER', status: 'IDLE', removed_at: null });
    expect(entry.roleProfile?.role).toBe('MANAGER');
    expect(entry.agentProfile?.name).toBe('Planner');
    expect(entry.provider?.id).toBe('prov-manual-bridge');
    expect(entry.account).toBeNull();
    expect(entry.workerSlots).toEqual([]);
    expect(entry.resource).toMatchObject({ modelName: 'ChatGPT', enabled: true, healthStatus: 'UNKNOWN' });
    const resource = repo.getProviderResource(entry.resource!.id)!;
    expect(resource.quota_source).toBe('UNKNOWN');
    expect(resource.remaining_quota).toBeNull();
  });

  it('creates a Codex CLI agent bound to its own native profile account and bounded worker slots', () => {
    const result = createCodex({ profileId: 'Main-Coder' });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const entry = service.listAgents().find((item) => item.agent.id === result.agent.id)!;
    expect(entry.connection).toBe('CODEX_CLI');
    expect(repo.getProvider('prov-codex-cli')).toMatchObject({ adapter_type: 'LOCAL_CLI', enabled: true });
    expect(entry.account).toMatchObject({ authMode: 'NATIVE_PROFILE', profileRef: 'native-profile://codex/main-coder', healthStatus: 'UNKNOWN' });
    const account = repo.getProviderAccount(entry.account!.id)!;
    expect(account.credential_ref).toBeNull();
    expect(account.concurrency_limit).toBe(2);
    expect(repo.getProviderResource(entry.resource!.id)!.provider_account_id).toBe(account.id);
    expect(entry.workerSlots.map((slot) => [slot.slotIndex, slot.status])).toEqual([[1, 'IDLE'], [2, 'IDLE']]);
    expect(entry.agentProfile?.instructions).toBe('Prefer small changes.');
    expect(entry.resource?.capabilities).toContain('CODING');
  });

  it('derives a valid default profile from a Vietnamese display name', () => {
    const result = createCodex({ workerSlots: 1 });
    expect(result.success).toBe(true);
    const entry = service.listAgents().find((item) => result.success && item.agent.id === result.agent.id)!;
    expect(entry.account?.profileRef).toMatch(/^native-profile:\/\/codex\/lap-trinh-vien-chinh-[0-9a-f]{8}$/);
  });

  it('rejects a reused native profile atomically without leaving partial identities', () => {
    expect(createCodex({ profileId: 'shared' }).success).toBe(true);
    const before = ['agents', 'agent_profiles', 'provider_accounts', 'provider_resources', 'worker_slots'].map((t) => count(db, t));
    const duplicate = createCodex({ profileId: 'SHARED', displayName: 'Second' });
    expect(duplicate).toMatchObject({ success: false, errorCode: 'PROFILE_ALREADY_IN_USE' });
    const after = ['agents', 'agent_profiles', 'provider_accounts', 'provider_resources', 'worker_slots'].map((t) => count(db, t));
    expect(after).toEqual(before);
  });

  it.each([
    [{ displayName: '   ' }],
    [{ role: 'OWNER' }],
    [{ connection: 'CHATGPT_WEB' }],
    [{ workerSlots: 11 }],
    [{ profileId: 'a..b' }],
    [{ profileId: 'bad/name' }],
    [{ modelName: '' }],
    [{ unexpected: true }],
  ])('rejects malformed create input %j without persisting anything', (overrides) => {
    const agentsBefore = count(db, 'agents');
    expect(createCodex(overrides)).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
    expect(count(db, 'agents')).toBe(agentsBefore);
  });

  it('keeps created agents across a database reopen', () => {
    const result = createCodex();
    expect(result.success).toBe(true);
    db.close();
    open();
    const ids = service.listAgents().map((entry) => entry.agent.id);
    expect(ids).toContain(result.success ? result.agent.id : '');
  });

  it('removes an idle agent from the active roster reversibly and takes its resource out of routing', () => {
    const result = createCodex();
    if (!result.success) throw new Error('setup failed');
    const id = result.agent.id;

    const removed = service.removeAgent({ agentId: id });
    expect(removed).toMatchObject({ success: true, agent: { id, status: 'OFFLINE', removed_at: NOW } });
    expect(service.listAgents().some((entry) => entry.agent.id === id)).toBe(false);
    const hidden = service.listAgents({ includeRemoved: true }).find((entry) => entry.agent.id === id)!;
    expect(hidden.resource?.enabled).toBe(false);
    expect(hidden.workerSlots.every((slot) => slot.status === 'DISABLED')).toBe(true);
    expect(repo.getAgentProfile(hidden.agentProfile!.id)!.enabled).toBe(false);
    // History-bearing rows are retained, not deleted.
    expect(repo.getAgent(id)).not.toBeNull();
    expect(repo.getProviderAccount(hidden.account!.id)).not.toBeNull();

    expect(service.removeAgent({ agentId: id })).toMatchObject({ success: false, errorCode: 'AGENT_ALREADY_REMOVED' });
    expect(service.updateAgent({ agentId: id, displayName: 'Renamed' })).toMatchObject({ success: false, errorCode: 'AGENT_ALREADY_REMOVED' });

    const restored = service.restoreAgent({ agentId: id });
    expect(restored).toMatchObject({ success: true, agent: { id, status: 'IDLE', removed_at: null } });
    const back = service.listAgents().find((entry) => entry.agent.id === id)!;
    expect(back.resource?.enabled).toBe(true);
    expect(back.workerSlots.every((slot) => slot.status === 'IDLE')).toBe(true);
    expect(service.restoreAgent({ agentId: id })).toMatchObject({ success: false, errorCode: 'AGENT_NOT_REMOVED' });
  });

  it('refuses to remove an agent with active work and explains each blocker', () => {
    const result = createCodex();
    if (!result.success) throw new Error('setup failed');
    const entry = service.listAgents().find((item) => item.agent.id === result.agent.id)!;

    repo.updateAgentStatus(result.agent.id, 'BUSY');
    repo.updateWorkerSlotStatus(entry.workerSlots[0].id, 'RUNNING');

    const blocked = service.removeAgent({ agentId: result.agent.id });
    expect(blocked.success).toBe(false);
    if (blocked.success) return;
    expect(blocked.errorCode).toBe('AGENT_HAS_ACTIVE_WORK');
    expect(blocked.blockers?.map((b) => b.code).sort()).toEqual(['AGENT_BUSY', 'BUSY_WORKER_SLOT']);
    expect(repo.getAgent(result.agent.id)!.removed_at).toBeNull();
    expect(repo.getProviderResource(entry.resource!.id)!.enabled).toBe(true);
    expect(service.listAgents().find((item) => item.agent.id === result.agent.id)!.blockers).toHaveLength(2);
  });

  it('treats an unreleased account lease as active work even after it expired', () => {
    const result = createCodex();
    if (!result.success) throw new Error('setup failed');
    const entry = service.listAgents().find((item) => item.agent.id === result.agent.id)!;
    // The lease's assignment fixture is irrelevant here; only the slot binding is read.
    db.pragma('foreign_keys = OFF');
    db.prepare(`
      INSERT INTO account_leases (id, assignment_id, provider_account_id, worker_slot_id, lease_token, acquired_at, expires_at, heartbeat_at, released_at)
      VALUES ('lease-1', 'assignment-x', ?, ?, 'token-1', '2026-10-01T00:00:00.000Z', '2026-10-01T01:00:00.000Z', '2026-10-01T00:00:00.000Z', NULL)
    `).run(entry.account!.id, entry.workerSlots[0].id);
    db.pragma('foreign_keys = ON');

    expect(service.removeAgent({ agentId: result.agent.id })).toMatchObject({
      success: false, errorCode: 'AGENT_HAS_ACTIVE_WORK', blockers: [{ code: 'ACTIVE_ACCOUNT_LEASE', reference: 'lease-1' }],
    });
    db.prepare("UPDATE account_leases SET released_at = '2026-10-01T00:30:00.000Z' WHERE id = 'lease-1'").run();
    expect(service.removeAgent({ agentId: result.agent.id }).success).toBe(true);
  });

  it('resizes worker slots up to 10, reusing disabled slots, and never takes a busy one (#306)', () => {
    const result = createCodex({ workerSlots: 1 });
    if (!result.success) throw new Error('setup failed');
    const id = result.agent.id;
    const accountId = repo.getProviderResource(result.agent.provider_resource_id!)!.provider_account_id!;
    const active = () => repo.getWorkerSlotsByAccount(accountId).filter((slot) => slot.status !== 'DISABLED').map((slot) => slot.slot_index).sort((a, b) => a - b);

    expect(service.updateAgent({ agentId: id, workerSlots: 10 }).success).toBe(true);
    expect(active()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(repo.getProviderAccount(accountId)!.concurrency_limit).toBe(10);

    expect(service.updateAgent({ agentId: id, workerSlots: 3 }).success).toBe(true);
    expect(active()).toEqual([1, 2, 3]);
    expect(service.updateAgent({ agentId: id, workerSlots: 4 }).success).toBe(true);
    expect(active()).toEqual([1, 2, 3, 4]);
    expect(repo.getWorkerSlotsByAccount(accountId)).toHaveLength(10); // Disabled slots are reused, not duplicated.

    const fourth = repo.getWorkerSlotsByAccount(accountId).find((slot) => slot.slot_index === 4)!;
    repo.updateWorkerSlotStatus(fourth.id, 'LEASED');
    expect(service.updateAgent({ agentId: id, workerSlots: 2 })).toMatchObject({ success: false, errorCode: 'AGENT_HAS_ACTIVE_WORK' });
    expect(active()).toEqual([1, 2, 3, 4]);
    expect(service.updateAgent({ agentId: id, workerSlots: 11 })).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
  });

  it('edits names and instructions, but locks the model while work is active', () => {
    const result = createCodex();
    if (!result.success) throw new Error('setup failed');
    const id = result.agent.id;
    const entry = service.listAgents().find((item) => item.agent.id === id)!;

    expect(service.updateAgent({ agentId: id, displayName: 'Coder A', instructions: 'Always add tests.' }))
      .toMatchObject({ success: true, agent: { display_name: 'Coder A' } });
    const profile = repo.getAgentProfile(entry.agentProfile!.id)!;
    expect(profile).toMatchObject({ name: 'Coder A', prompt_template: 'Always add tests.' });

    repo.updateWorkerSlotStatus(entry.workerSlots[0].id, 'LEASED');
    expect(service.updateAgent({ agentId: id, modelName: 'gpt-6' })).toMatchObject({ success: false, errorCode: 'AGENT_HAS_ACTIVE_WORK' });
    expect(repo.getProviderResource(entry.resource!.id)!.model_name).toBe('gpt-5-codex');

    repo.updateWorkerSlotStatus(entry.workerSlots[0].id, 'IDLE');
    expect(service.updateAgent({ agentId: id, modelName: 'gpt-6' }).success).toBe(true);
    expect(repo.getProviderResource(entry.resource!.id)!.model_name).toBe('gpt-6');
  });

  it('lets the owner remove a seeded agent without bootstrap resurrecting it', () => {
    expect(service.removeAgent({ agentId: 'agent-gemini-coder' }).success).toBe(true);
    BootstrapService.seedDefaultResources(repo);
    expect(repo.getAgent('agent-gemini-coder')!.removed_at).toBe(NOW);
    expect(service.listAgents().map((entry) => entry.agent.id)).toEqual(['agent-primary-manager']);
    expect(service.updateAgent({ agentId: 'agent-primary-manager', instructions: 'Plan in small steps.' }).success).toBe(true);
    const manager = repo.getAgent('agent-primary-manager')!;
    expect(repo.getAgentProfile(manager.agent_profile_id!)!.prompt_template).toBe('Plan in small steps.');
  });

  it('reports unknown agents with a typed error', () => {
    expect(service.removeAgent({ agentId: 'missing' })).toMatchObject({ success: false, errorCode: 'AGENT_NOT_FOUND' });
    expect(service.removeAgent({})).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
  });
});
