import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner, MIGRATIONS } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';
import {
  RoleProfile,
  AgentProfile,
  ProviderAccount,
  WorkerSlot,
  AgentAssignment,
  AccountLease,
  RoutePolicy,
  SeparationPolicy,
  Provider,
  ProviderResource,
  Agent,
  Project,
  Task,
  FabricRole,
  AccountAuthMode,
  WorkerSlotStatus,
  AgentAssignmentStatus,
  SeparationAffinity,
  Capability,
  RiskLevel,
} from '../src/core/types/domain';

describe('R5A — Role-Agnostic Agent Fabric Domain Foundation', () => {
  let db: Database.Database;
  let repo: Repository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    MigrationRunner.run(db);
    repo = new Repository(db);
  });

  afterEach(() => {
    db.close();
  });

  // 1. Fresh DB migration creates every R5A table/index/column/link
  it('1. Fresh DB migration creates every R5A table, index, column, and link', () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (t) => t.name
    );

    const expectedR5ATables = [
      'role_profiles',
      'agent_profiles',
      'provider_accounts',
      'worker_slots',
      'agent_assignments',
      'account_leases',
      'route_policies',
      'separation_policies',
    ];

    for (const tbl of expectedR5ATables) {
      expect(tables).toContain(tbl);
    }

    // Verify provider_resources has provider_account_id column
    const prColumns = (db.prepare("PRAGMA table_info('provider_resources')").all() as { name: string }[]).map(
      (c) => c.name
    );
    expect(prColumns).toContain('provider_account_id');

    // Verify indexes exist
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map(
      (i) => i.name
    );
    expect(indexes).toContain('idx_resources_account');
    expect(indexes).toContain('idx_active_slot_lease');
    expect(indexes).toContain('idx_role_profiles_role');
    expect(indexes).toContain('idx_agent_profiles_role_profile');
    expect(indexes).toContain('idx_provider_accounts_provider');
    expect(indexes).toContain('idx_worker_slots_account');
    expect(indexes).toContain('idx_agent_assignments_task');
    expect(indexes).toContain('idx_account_leases_assignment');
    expect(indexes).toContain('idx_route_policies_enabled');
    expect(indexes).toContain('idx_separation_policies_enabled');

    // FK integrity
    const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
    expect(fkViolations).toHaveLength(0);
  });

  // 2. Existing pre-R5A DB upgrades without deleting legacy rows
  it('2. Existing pre-R5A DB upgrades without deleting legacy rows', () => {
    const legacyDb = new Database(':memory:');
    legacyDb.pragma('foreign_keys = ON');

    // Run migrations 1 through 7 manually
    legacyDb.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    for (const m of MIGRATIONS.filter((m) => m.version <= 7)) {
      m.up(legacyDb);
      legacyDb
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(m.version, m.name, new Date().toISOString());
    }

    // Seed pre-R5A legacy data
    legacyDb.exec(`
      INSERT INTO projects (id, name, repository_path, default_branch, status, created_at, updated_at)
      VALUES ('p-legacy', 'Legacy Project', 'd:/repo', 'main', 'READY', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');

      INSERT INTO tasks (id, project_id, title, state, priority, risk, revision_count, max_revisions, progress_cache_percent, created_at, updated_at)
      VALUES ('t-legacy', 'p-legacy', 'Legacy Task', 'DISPATCHED', 'HIGH', 'MEDIUM', 1, 3, 0, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');

      INSERT INTO providers (id, name, adapter_type, enabled, created_at)
      VALUES ('prov-1', 'Test Provider', 'API', 1, '2026-08-01T00:00:00Z');

      INSERT INTO provider_resources (id, provider_id, model_name, health_status, capabilities_json, enabled, quota_source, quota_confidence, last_health_check)
      VALUES ('res-1', 'prov-1', 'gpt-4o', 'AVAILABLE', '["PLANNING"]', 1, 'MANUAL', 1.0, '2026-08-01T00:00:00Z');

      INSERT INTO agents (id, display_name, role, provider_resource_id, status, last_seen_at)
      VALUES ('agent-1', 'Coder Agent', 'CODER', 'res-1', 'IDLE', '2026-08-01T00:00:00Z');
    `);

    // Upgrade with MigrationRunner
    MigrationRunner.run(legacyDb);

    // Verify all legacy rows survived unchanged
    const proj = legacyDb.prepare('SELECT * FROM projects WHERE id = ?').get('p-legacy') as Record<string, unknown>;
    expect(proj.name).toBe('Legacy Project');

    const task = legacyDb.prepare('SELECT * FROM tasks WHERE id = ?').get('t-legacy') as Record<string, unknown>;
    expect(task.title).toBe('Legacy Task');

    const prov = legacyDb.prepare('SELECT * FROM providers WHERE id = ?').get('prov-1') as Record<string, unknown>;
    expect(prov.name).toBe('Test Provider');

    const res = legacyDb.prepare('SELECT * FROM provider_resources WHERE id = ?').get('res-1') as Record<string, unknown>;
    expect(res.model_name).toBe('gpt-4o');
    expect(res.provider_account_id).toBeNull();

    const ag = legacyDb.prepare('SELECT * FROM agents WHERE id = ?').get('agent-1') as Record<string, unknown>;
    expect(ag.display_name).toBe('Coder Agent');
    expect(ag.provider_resource_id).toBe('res-1');

    legacyDb.close();
  });

  // 3. Existing Provider remains intact
  it('3. Existing Provider remains intact with legacy API and repository operations', () => {
    const prov: Provider = {
      id: 'prov-openai',
      name: 'OpenAI Production',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    repo.createProvider(prov);

    const loaded = repo.getProvider('prov-openai');
    expect(loaded).toBeDefined();
    expect(loaded?.name).toBe('OpenAI Production');
    expect(loaded?.adapter_type).toBe('API');
  });

  // 4. Existing ProviderResource remains intact and may exist without ProviderAccount
  it('4. Existing ProviderResource remains intact and may exist without ProviderAccount', () => {
    const prov: Provider = {
      id: 'prov-anthropic',
      name: 'Anthropic',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    repo.createProvider(prov);

    const resource: ProviderResource = {
      id: 'res-claude-3-7-sonnet',
      provider_id: 'prov-anthropic',
      provider_account_id: null,
      model_name: 'claude-3-7-sonnet',
      health_status: 'AVAILABLE',
      capabilities: ['CODING' as Capability, 'REVIEW' as Capability],
      enabled: true,
      total_quota: 1000,
      remaining_quota: 850,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'PROVIDER_REPORTED',
      quota_confidence: 0.95,
      last_health_check: new Date().toISOString(),
    };
    repo.createProviderResource(resource);

    const loaded = repo.getProviderResource('res-claude-3-7-sonnet');
    expect(loaded).toBeDefined();
    expect(loaded?.provider_account_id).toBeNull();
    expect(loaded?.model_name).toBe('claude-3-7-sonnet');
    expect(loaded?.capabilities).toEqual(['CODING', 'REVIEW']);
  });

  // 5. Existing Agent fixed-role row remains intact
  it('5. Existing Agent fixed-role row remains intact', () => {
    const prov: Provider = {
      id: 'prov-local',
      name: 'Local Provider',
      adapter_type: 'LOCAL_CLI',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    repo.createProvider(prov);

    const res: ProviderResource = {
      id: 'res-local-model',
      provider_id: 'prov-local',
      model_name: 'local-codex',
      health_status: 'AVAILABLE',
      capabilities: ['CODING' as Capability],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: new Date().toISOString(),
    };
    repo.createProviderResource(res);

    const legacyAgent: Agent = {
      id: 'agent-fixed-coder',
      display_name: 'Fixed Coder',
      role: 'CODER',
      provider_resource_id: 'res-local-model',
      status: 'IDLE',
      current_task_id: null,
      last_seen_at: new Date().toISOString(),
    };
    repo.createAgent(legacyAgent);

    const loaded = repo.getAllAgents().find((a) => a.id === 'agent-fixed-coder');
    expect(loaded).toBeDefined();
    expect(loaded?.role).toBe('CODER');
    expect(loaded?.provider_resource_id).toBe('res-local-model');
  });

  // 6. RoleProfile can be created without provider/account/resource
  it('6. RoleProfile can be created without provider/account/resource', () => {
    const roleProf: RoleProfile = {
      id: 'rp-security-reviewer',
      role: 'SECURITY_REVIEWER',
      display_name: 'Lead Security Reviewer',
      required_capabilities: ['SECURITY_REVIEW' as Capability, 'REVIEW' as Capability],
      preferred_capabilities: ['CODING' as Capability],
      authority_scope: { can_veto: true, max_risk: 'CRITICAL' },
      permissions: ['READ_ALL', 'COMMENT', 'APPROVE_SECURITY'],
      output_protocol: 'reviewer.v1',
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createRoleProfile(roleProf);

    const loaded = repo.getRoleProfile('rp-security-reviewer');
    expect(loaded).toBeDefined();
    expect(loaded?.role).toBe('SECURITY_REVIEWER');
    expect(loaded?.display_name).toBe('Lead Security Reviewer');
    expect(loaded?.required_capabilities).toEqual(['SECURITY_REVIEW', 'REVIEW']);
    expect(loaded?.authority_scope).toEqual({ can_veto: true, max_risk: 'CRITICAL' });
    expect(loaded?.permissions).toEqual(['READ_ALL', 'COMMENT', 'APPROVE_SECURITY']);
  });

  // 7. ProviderAccount can be created without role
  it('7. ProviderAccount can be created without role', () => {
    const prov: Provider = {
      id: 'prov-google',
      name: 'Google Gemini',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    repo.createProvider(prov);

    const acct: ProviderAccount = {
      id: 'acct-gemini-work',
      provider_id: 'prov-google',
      label: 'Gemini Workspace Team Account',
      auth_mode: 'NATIVE_PROFILE',
      credential_ref: 'cred-handle-0912',
      profile_ref: 'profile-gemini-prod',
      enabled: true,
      priority: 10,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 4,
      last_success_at: new Date().toISOString(),
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createProviderAccount(acct);

    const loaded = repo.getProviderAccount('acct-gemini-work');
    expect(loaded).toBeDefined();
    expect(loaded?.provider_id).toBe('prov-google');
    expect(loaded?.label).toBe('Gemini Workspace Team Account');
    expect(loaded?.concurrency_limit).toBe(4);
    expect(loaded?.credential_ref).toBe('cred-handle-0912');
  });

  // 8. AgentAssignment stores role/profile/provider/account/resource as distinct fields
  it('8. AgentAssignment stores role/profile/provider/account/resource as distinct fields', () => {
    // Setup references
    const proj: Project = {
      id: 'proj-r5a',
      name: 'R5A Project',
      description: 'Fabric test',
      repository_path: 'd:/proj',
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    };
    repo.createProject(proj);

    const task: Task = {
      id: 'task-r5a',
      project_id: 'proj-r5a',
      milestone_id: null,
      title: 'Fabric task',
      description: 'Test assignment',
      state: 'DISPATCHED',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 1,
      max_revisions: 3,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createTask(task);

    const roleProf: RoleProfile = {
      id: 'rp-coder',
      role: 'CODER',
      display_name: 'Coder Role',
      required_capabilities: ['CODING' as Capability],
      preferred_capabilities: [],
      authority_scope: null,
      permissions: ['WRITE_CODE'],
      output_protocol: 'coder.v1',
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createRoleProfile(roleProf);

    const agentProf: AgentProfile = {
      id: 'ap-python-expert',
      role_profile_id: 'rp-coder',
      name: 'Python Senior Engineer',
      prompt_template: 'System prompt template v1',
      config: { temperature: 0.2, top_p: 0.95 },
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createAgentProfile(agentProf);

    const prov: Provider = {
      id: 'prov-openai-r5a',
      name: 'OpenAI R5A',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    repo.createProvider(prov);

    const acct: ProviderAccount = {
      id: 'acct-openai-primary',
      provider_id: 'prov-openai-r5a',
      label: 'OpenAI Primary',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: 'cred-key-ref-9876',
      profile_ref: null,
      enabled: true,
      priority: 1,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 2,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createProviderAccount(acct);

    const res: ProviderResource = {
      id: 'res-gpt4o-r5a',
      provider_id: 'prov-openai-r5a',
      provider_account_id: 'acct-openai-primary',
      model_name: 'gpt-4o',
      health_status: 'AVAILABLE',
      capabilities: ['CODING' as Capability],
      enabled: true,
      total_quota: 100,
      remaining_quota: 90,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: new Date().toISOString(),
    };
    repo.createProviderResource(res);

    const slot: WorkerSlot = {
      id: 'slot-1',
      provider_account_id: 'acct-openai-primary',
      provider_resource_id: 'res-gpt4o-r5a',
      slot_index: 0,
      status: 'IDLE',
      current_assignment_id: null,
      current_execution_id: null,
      heartbeat_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createWorkerSlot(slot);

    const assignment: AgentAssignment = {
      id: 'asgn-001',
      project_id: 'proj-r5a',
      task_id: 'task-r5a',
      attempt_id: null,
      role_profile_id: 'rp-coder',
      agent_profile_id: 'ap-python-expert',
      selected_provider_id: 'prov-openai-r5a',
      selected_account_id: 'acct-openai-primary',
      selected_resource_id: 'res-gpt4o-r5a',
      selected_worker_slot_id: 'slot-1',
      routing_decision_id: 'rd-12345',
      preferred_metadata: { latency_tier: 'low' },
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    };
    repo.createAgentAssignment(assignment);

    const loaded = repo.getAgentAssignment('asgn-001');
    expect(loaded).toBeDefined();
    expect(loaded?.role_profile_id).toBe('rp-coder');
    expect(loaded?.agent_profile_id).toBe('ap-python-expert');
    expect(loaded?.selected_provider_id).toBe('prov-openai-r5a');
    expect(loaded?.selected_account_id).toBe('acct-openai-primary');
    expect(loaded?.selected_resource_id).toBe('res-gpt4o-r5a');
    expect(loaded?.selected_worker_slot_id).toBe('slot-1');
    expect(loaded?.preferred_metadata).toEqual({ latency_tier: 'low' });
    expect(loaded?.status).toBe('ASSIGNED');
  });

  // 9. Invalid foreign keys fail closed
  it('9. Invalid foreign keys fail closed when foreign_keys = ON', () => {
    const invalidAssignment: AgentAssignment = {
      id: 'asgn-invalid',
      project_id: 'proj-nonexistent',
      task_id: 'task-nonexistent',
      attempt_id: null,
      role_profile_id: 'rp-nonexistent',
      agent_profile_id: null,
      selected_provider_id: 'prov-nonexistent',
      selected_account_id: 'acct-nonexistent',
      selected_resource_id: 'res-nonexistent',
      selected_worker_slot_id: null,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    };

    expect(() => repo.createAgentAssignment(invalidAssignment)).toThrow();
  });

  // 10. Duplicate account slot index rejected
  it('10. Duplicate account slot index is rejected by unique constraint', () => {
    const prov: Provider = {
      id: 'prov-slot-test',
      name: 'Slot Provider',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    repo.createProvider(prov);

    const acct: ProviderAccount = {
      id: 'acct-slot-test',
      provider_id: 'prov-slot-test',
      label: 'Slot Account',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: null,
      profile_ref: null,
      enabled: true,
      priority: 1,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 2,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createProviderAccount(acct);

    const slot0: WorkerSlot = {
      id: 'slot-acc-0',
      provider_account_id: 'acct-slot-test',
      provider_resource_id: null,
      slot_index: 0,
      status: 'IDLE',
      current_assignment_id: null,
      current_execution_id: null,
      heartbeat_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createWorkerSlot(slot0);

    const dupSlot0: WorkerSlot = {
      id: 'slot-acc-0-dup',
      provider_account_id: 'acct-slot-test',
      provider_resource_id: null,
      slot_index: 0,
      status: 'IDLE',
      current_assignment_id: null,
      current_execution_id: null,
      heartbeat_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    expect(() => repo.createWorkerSlot(dupSlot0)).toThrow();
  });

  // 11. Duplicate active slot lease prevented
  it('11. Duplicate active slot lease prevented by partial unique index', () => {
    // Setup prerequisite entities
    const proj: Project = {
      id: 'p-lease',
      name: 'Lease Proj',
      description: null,
      repository_path: 'd:/p',
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    };
    repo.createProject(proj);

    const task: Task = {
      id: 't-lease',
      project_id: 'p-lease',
      milestone_id: null,
      title: 'Lease Task',
      description: null,
      state: 'DISPATCHED',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 1,
      max_revisions: 3,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createTask(task);

    const roleProf: RoleProfile = {
      id: 'rp-lease',
      role: 'CODER',
      display_name: 'Coder',
      required_capabilities: ['CODING' as Capability],
      preferred_capabilities: [],
      authority_scope: null,
      permissions: [],
      output_protocol: null,
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createRoleProfile(roleProf);

    const prov: Provider = {
      id: 'prov-lease',
      name: 'Prov Lease',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    repo.createProvider(prov);

    const acct: ProviderAccount = {
      id: 'acct-lease',
      provider_id: 'prov-lease',
      label: 'Acct Lease',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: null,
      profile_ref: null,
      enabled: true,
      priority: 1,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createProviderAccount(acct);

    const res: ProviderResource = {
      id: 'res-lease',
      provider_id: 'prov-lease',
      provider_account_id: 'acct-lease',
      model_name: 'model-lease',
      health_status: 'AVAILABLE',
      capabilities: ['CODING' as Capability],
      enabled: true,
      total_quota: 100,
      remaining_quota: 100,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: new Date().toISOString(),
    };
    repo.createProviderResource(res);

    const slot: WorkerSlot = {
      id: 'slot-lease-1',
      provider_account_id: 'acct-lease',
      provider_resource_id: 'res-lease',
      slot_index: 0,
      status: 'IDLE',
      current_assignment_id: null,
      current_execution_id: null,
      heartbeat_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createWorkerSlot(slot);

    const asgn1: AgentAssignment = {
      id: 'asgn-lease-1',
      project_id: 'p-lease',
      task_id: 't-lease',
      attempt_id: null,
      role_profile_id: 'rp-lease',
      agent_profile_id: null,
      selected_provider_id: 'prov-lease',
      selected_account_id: 'acct-lease',
      selected_resource_id: 'res-lease',
      selected_worker_slot_id: 'slot-lease-1',
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    };
    repo.createAgentAssignment(asgn1);

    const asgn2: AgentAssignment = {
      id: 'asgn-lease-2',
      project_id: 'p-lease',
      task_id: 't-lease',
      attempt_id: null,
      role_profile_id: 'rp-lease',
      agent_profile_id: null,
      selected_provider_id: 'prov-lease',
      selected_account_id: 'acct-lease',
      selected_resource_id: 'res-lease',
      selected_worker_slot_id: 'slot-lease-1',
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    };
    repo.createAgentAssignment(asgn2);

    // First active lease on slot-lease-1
    const lease1: AccountLease = {
      id: 'lease-001',
      assignment_id: 'asgn-lease-1',
      provider_account_id: 'acct-lease',
      worker_slot_id: 'slot-lease-1',
      lease_token: 'token-abc-123',
      acquired_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
      heartbeat_at: new Date().toISOString(),
      released_at: null,
    };
    repo.createAccountLease(lease1);

    // Second active lease on the same worker slot must fail due to idx_active_slot_lease
    const lease2: AccountLease = {
      id: 'lease-002',
      assignment_id: 'asgn-lease-2',
      provider_account_id: 'acct-lease',
      worker_slot_id: 'slot-lease-1',
      lease_token: 'token-xyz-789',
      acquired_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
      heartbeat_at: new Date().toISOString(),
      released_at: null,
    };

    expect(() => repo.createAccountLease(lease2)).toThrow();
  });

  // 12. Released/expired lease behavior is represented correctly
  it('12. Released lease allows a new active lease on that same worker slot', () => {
    const proj: Project = {
      id: 'p-lease-2',
      name: 'Lease Proj 2',
      description: null,
      repository_path: 'd:/p',
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    };
    repo.createProject(proj);

    const task: Task = {
      id: 't-lease-2',
      project_id: 'p-lease-2',
      milestone_id: null,
      title: 'Lease Task 2',
      description: null,
      state: 'DISPATCHED',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 1,
      max_revisions: 3,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createTask(task);

    const roleProf: RoleProfile = {
      id: 'rp-lease-2',
      role: 'CODER',
      display_name: 'Coder 2',
      required_capabilities: ['CODING' as Capability],
      preferred_capabilities: [],
      authority_scope: null,
      permissions: [],
      output_protocol: null,
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createRoleProfile(roleProf);

    const prov: Provider = {
      id: 'prov-lease-2',
      name: 'Prov Lease 2',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    repo.createProvider(prov);

    const acct: ProviderAccount = {
      id: 'acct-lease-2',
      provider_id: 'prov-lease-2',
      label: 'Acct Lease 2',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: null,
      profile_ref: null,
      enabled: true,
      priority: 1,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createProviderAccount(acct);

    const res: ProviderResource = {
      id: 'res-lease-2',
      provider_id: 'prov-lease-2',
      provider_account_id: 'acct-lease-2',
      model_name: 'model-lease-2',
      health_status: 'AVAILABLE',
      capabilities: ['CODING' as Capability],
      enabled: true,
      total_quota: 100,
      remaining_quota: 100,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: new Date().toISOString(),
    };
    repo.createProviderResource(res);

    const slot: WorkerSlot = {
      id: 'slot-lease-2',
      provider_account_id: 'acct-lease-2',
      provider_resource_id: 'res-lease-2',
      slot_index: 0,
      status: 'IDLE',
      current_assignment_id: null,
      current_execution_id: null,
      heartbeat_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createWorkerSlot(slot);

    const asgn1: AgentAssignment = {
      id: 'asgn-lease-2a',
      project_id: 'p-lease-2',
      task_id: 't-lease-2',
      attempt_id: null,
      role_profile_id: 'rp-lease-2',
      agent_profile_id: null,
      selected_provider_id: 'prov-lease-2',
      selected_account_id: 'acct-lease-2',
      selected_resource_id: 'res-lease-2',
      selected_worker_slot_id: 'slot-lease-2',
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    };
    repo.createAgentAssignment(asgn1);

    const asgn2: AgentAssignment = {
      id: 'asgn-lease-2b',
      project_id: 'p-lease-2',
      task_id: 't-lease-2',
      attempt_id: null,
      role_profile_id: 'rp-lease-2',
      agent_profile_id: null,
      selected_provider_id: 'prov-lease-2',
      selected_account_id: 'acct-lease-2',
      selected_resource_id: 'res-lease-2',
      selected_worker_slot_id: 'slot-lease-2',
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    };
    repo.createAgentAssignment(asgn2);

    const lease1: AccountLease = {
      id: 'lease-201',
      assignment_id: 'asgn-lease-2a',
      provider_account_id: 'acct-lease-2',
      worker_slot_id: 'slot-lease-2',
      lease_token: 'token-201',
      acquired_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
      heartbeat_at: new Date().toISOString(),
      released_at: null,
    };
    repo.createAccountLease(lease1);

    const activeLease = repo.getActiveLeaseForSlot('slot-lease-2');
    expect(activeLease).toBeDefined();
    expect(activeLease?.id).toBe('lease-201');

    // Release lease1
    repo.releaseAccountLease('lease-201');

    const activeAfterRelease = repo.getActiveLeaseForSlot('slot-lease-2');
    expect(activeAfterRelease).toBeNull();

    // Now acquiring a second lease on slot-lease-2 succeeds
    const lease2: AccountLease = {
      id: 'lease-202',
      assignment_id: 'asgn-lease-2b',
      provider_account_id: 'acct-lease-2',
      worker_slot_id: 'slot-lease-2',
      lease_token: 'token-202',
      acquired_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
      heartbeat_at: new Date().toISOString(),
      released_at: null,
    };
    expect(() => repo.createAccountLease(lease2)).not.toThrow();

    const loadedLease2 = repo.getActiveLeaseForSlot('slot-lease-2');
    expect(loadedLease2?.id).toBe('lease-202');
  });

  // 13. SeparationPolicy round-trips exactly
  it('13. SeparationPolicy round-trips exactly with all fields', () => {
    const sepPolicy: SeparationPolicy = {
      id: 'sp-strict-audit',
      name: 'Strict Reviewer / Coder Separation',
      same_execution_forbidden: true,
      same_session_forbidden: true,
      same_account_policy: 'REQUIRE_DIFFERENT',
      same_provider_policy: 'PREFER_DIFFERENT',
      same_model_policy: 'REQUIRE_DIFFERENT',
      risk_threshold: 'HIGH',
      applicability: { environments: ['production', 'staging'], min_loc: 50 },
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createSeparationPolicy(sepPolicy);

    const loaded = repo.getSeparationPolicy('sp-strict-audit');
    expect(loaded).toEqual(sepPolicy);

    // Update
    repo.updateSeparationPolicy('sp-strict-audit', {
      same_provider_policy: 'REQUIRE_DIFFERENT',
      risk_threshold: 'CRITICAL',
    });

    const updated = repo.getSeparationPolicy('sp-strict-audit');
    expect(updated?.same_provider_policy).toBe('REQUIRE_DIFFERENT');
    expect(updated?.risk_threshold).toBe('CRITICAL');
  });

  // 14. RoutePolicy round-trips exactly
  it('14. RoutePolicy round-trips exactly with JSON configuration and failover metadata', () => {
    const routePol: RoutePolicy = {
      id: 'rp-standard-coder',
      name: 'Standard Coder Routing Policy',
      required_capabilities: ['CODING' as Capability],
      preferred_capabilities: ['PLANNING' as Capability],
      provider_account_policy: { preferred_tier: 'tier_1', max_cost_per_req: 0.05 },
      allow_manual_bridge: true,
      failover_policy: { auto_retry_count: 2, fallback_providers: ['prov-gemini', 'prov-anthropic'] },
      risk_policy: { high_risk_requires_confirmation: true },
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createRoutePolicy(routePol);

    const loaded = repo.getRoutePolicy('rp-standard-coder');
    expect(loaded).toEqual(routePol);

    // Update
    repo.updateRoutePolicy('rp-standard-coder', {
      allow_manual_bridge: false,
      failover_policy: { auto_retry_count: 3 },
    });

    const updated = repo.getRoutePolicy('rp-standard-coder');
    expect(updated?.allow_manual_bridge).toBe(false);
    expect(updated?.failover_policy).toEqual({ auto_retry_count: 3 });
  });

  // 15. JSON capability/config fields round-trip exactly
  it('15. JSON capability/config fields round-trip exactly for AgentProfile and RoleProfile', () => {
    const roleProf: RoleProfile = {
      id: 'rp-complex-json',
      role: 'RESEARCHER',
      display_name: 'Lead Researcher',
      required_capabilities: ['PLANNING' as Capability, 'REVIEW' as Capability],
      preferred_capabilities: ['CODING' as Capability],
      authority_scope: { scope_depth: 3, allowed_directories: ['src', 'docs', 'specs'] },
      permissions: ['READ_ALL', 'INDEX_CODEBASE'],
      output_protocol: 'researcher.v1',
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createRoleProfile(roleProf);

    const agentProf: AgentProfile = {
      id: 'ap-complex-config',
      role_profile_id: 'rp-complex-json',
      name: 'Researcher Profile 1',
      prompt_template: 'Deep Research System Instructions {{query}}',
      config: {
        retrieval: { top_k: 10, rerank: true },
        generation: { max_tokens: 4096, temperature: 0.1 },
      },
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createAgentProfile(agentProf);

    const loadedRole = repo.getRoleProfile('rp-complex-json');
    expect(loadedRole?.required_capabilities).toEqual(['PLANNING', 'REVIEW']);
    expect(loadedRole?.authority_scope).toEqual({ scope_depth: 3, allowed_directories: ['src', 'docs', 'specs'] });

    const loadedAgent = repo.getAgentProfile('ap-complex-config');
    expect(loadedAgent?.config).toEqual({
      retrieval: { top_k: 10, rerank: true },
      generation: { max_tokens: 4096, temperature: 0.1 },
    });
  });

  // 16. No secret plaintext columns exist in new schema
  it('16. No secret plaintext columns exist anywhere in the database schema', () => {
    const forbiddenColumns = ['password', 'access_token', 'refresh_token', 'bearer_token', 'api_key', 'oauth_token'];

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (t) => t.name
    );

    for (const tableName of tables) {
      const columns = (db.prepare(`PRAGMA table_info('${tableName}')`).all() as { name: string }[]).map((c) =>
        c.name.toLowerCase()
      );

      for (const forbidden of forbiddenColumns) {
        expect(columns).not.toContain(forbidden);
      }
    }
  });

  // 17. Legacy routing unit tests still pass with same expected selections
  it('17. Legacy provider resource lookup and account linkage queries function seamlessly', () => {
    const prov: Provider = {
      id: 'prov-linkage',
      name: 'Linkage Provider',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    repo.createProvider(prov);

    const acct1: ProviderAccount = {
      id: 'acct-link-1',
      provider_id: 'prov-linkage',
      label: 'Acct 1',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: 'cred-1',
      profile_ref: null,
      enabled: true,
      priority: 10,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 2,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createProviderAccount(acct1);

    const acct2: ProviderAccount = {
      id: 'acct-link-2',
      provider_id: 'prov-linkage',
      label: 'Acct 2',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: 'cred-2',
      profile_ref: null,
      enabled: true,
      priority: 5,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 2,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createProviderAccount(acct2);

    const resA: ProviderResource = {
      id: 'res-link-a',
      provider_id: 'prov-linkage',
      provider_account_id: 'acct-link-1',
      model_name: 'model-a',
      health_status: 'AVAILABLE',
      capabilities: ['CODING' as Capability],
      enabled: true,
      total_quota: 500,
      remaining_quota: 500,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: new Date().toISOString(),
    };
    repo.createProviderResource(resA);

    const resB: ProviderResource = {
      id: 'res-link-b',
      provider_id: 'prov-linkage',
      provider_account_id: 'acct-link-2',
      model_name: 'model-b',
      health_status: 'AVAILABLE',
      capabilities: ['CODING' as Capability],
      enabled: true,
      total_quota: 500,
      remaining_quota: 500,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: new Date().toISOString(),
    };
    repo.createProviderResource(resB);

    // Lookup resources by account
    const acct1Resources = repo.getProviderResourcesByAccount('acct-link-1');
    expect(acct1Resources).toHaveLength(1);
    expect(acct1Resources[0].id).toBe('res-link-a');

    const acct2Resources = repo.getProviderResourcesByAccount('acct-link-2');
    expect(acct2Resources).toHaveLength(1);
    expect(acct2Resources[0].id).toBe('res-link-b');

    // Update resource account linkage
    repo.updateProviderResourceAccount('res-link-a', 'acct-link-2');
    const updatedAcct2Resources = repo.getProviderResourcesByAccount('acct-link-2');
    expect(updatedAcct2Resources).toHaveLength(2);
  });

  // 18. Legacy migration tests pass
  it('18. Full migration chain from v1 through v8 executes idempotently and PRAGMA foreign_key_check is zero', () => {
    // MigrationRunner was already run in beforeEach, run again to test idempotency
    MigrationRunner.run(db);

    const applied = db.prepare('SELECT COUNT(*) as count FROM schema_migrations').get() as { count: number };
    expect(applied.count).toBe(8);

    const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
    expect(fkViolations).toHaveLength(0);
  });

  // =========================================================================
  // Manager Corrective 1: Relational Chain Validation & Safe Update Semantics
  // =========================================================================

  // 19. resource provider A + account from provider B rejected
  it('19. createProviderResource rejects resource provider A with account from provider B', () => {
    const provA: Provider = {
      id: 'prov-a-19',
      name: 'Provider A',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    const provB: Provider = {
      id: 'prov-b-19',
      name: 'Provider B',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    repo.createProvider(provA);
    repo.createProvider(provB);

    const acctB: ProviderAccount = {
      id: 'acct-b-19',
      provider_id: 'prov-b-19',
      label: 'Account B',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: null,
      profile_ref: null,
      enabled: true,
      priority: 1,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createProviderAccount(acctB);

    const mismatchedRes: ProviderResource = {
      id: 'res-mismatch-19',
      provider_id: 'prov-a-19', // mismatch with acct-b-19 (prov-b-19)
      provider_account_id: 'acct-b-19',
      model_name: 'model-x',
      health_status: 'AVAILABLE',
      capabilities: ['CODING' as Capability],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: new Date().toISOString(),
    };

    expect(() => repo.createProviderResource(mismatchedRes)).toThrow(/Provider mismatch/);
  });

  // 20. update resource to account from wrong provider rejected
  it('20. updateProviderResourceAccount rejects updating resource to account of a different provider', () => {
    const provA: Provider = {
      id: 'prov-a-20',
      name: 'Provider A',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    const provB: Provider = {
      id: 'prov-b-20',
      name: 'Provider B',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    repo.createProvider(provA);
    repo.createProvider(provB);

    const acctA: ProviderAccount = {
      id: 'acct-a-20',
      provider_id: 'prov-a-20',
      label: 'Account A',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: null,
      profile_ref: null,
      enabled: true,
      priority: 1,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const acctB: ProviderAccount = {
      id: 'acct-b-20',
      provider_id: 'prov-b-20',
      label: 'Account B',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: null,
      profile_ref: null,
      enabled: true,
      priority: 1,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createProviderAccount(acctA);
    repo.createProviderAccount(acctB);

    const resA: ProviderResource = {
      id: 'res-a-20',
      provider_id: 'prov-a-20',
      provider_account_id: 'acct-a-20',
      model_name: 'model-a',
      health_status: 'AVAILABLE',
      capabilities: ['CODING' as Capability],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: new Date().toISOString(),
    };
    repo.createProviderResource(resA);

    // Attempting to re-point resA (prov-a) to acctB (prov-b) must fail closed
    expect(() => repo.updateProviderResourceAccount('res-a-20', 'acct-b-20')).toThrow(/Provider mismatch/);
  });

  // 21. worker slot account A + resource from account B rejected
  it('21. createWorkerSlot rejects slot on account A bound to resource of account B', () => {
    const prov: Provider = {
      id: 'prov-21',
      name: 'Provider 21',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    repo.createProvider(prov);

    const acctA: ProviderAccount = {
      id: 'acct-a-21',
      provider_id: 'prov-21',
      label: 'Account A',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: null,
      profile_ref: null,
      enabled: true,
      priority: 1,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const acctB: ProviderAccount = {
      id: 'acct-b-21',
      provider_id: 'prov-21',
      label: 'Account B',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: null,
      profile_ref: null,
      enabled: true,
      priority: 1,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createProviderAccount(acctA);
    repo.createProviderAccount(acctB);

    const resB: ProviderResource = {
      id: 'res-b-21',
      provider_id: 'prov-21',
      provider_account_id: 'acct-b-21',
      model_name: 'model-b',
      health_status: 'AVAILABLE',
      capabilities: ['CODING' as Capability],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: new Date().toISOString(),
    };
    repo.createProviderResource(resB);

    const slotMismatched: WorkerSlot = {
      id: 'slot-mismatched-21',
      provider_account_id: 'acct-a-21', // Account A
      provider_resource_id: 'res-b-21', // Belongs to Account B
      slot_index: 0,
      status: 'IDLE',
      current_assignment_id: null,
      current_execution_id: null,
      heartbeat_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    expect(() => repo.createWorkerSlot(slotMismatched)).toThrow(/Slot resource account mismatch/);
  });

  // 22. assignment.project A + task belonging to project B rejected
  it('22. createAgentAssignment rejects project A with task belonging to project B', () => {
    const projA: Project = {
      id: 'proj-a-22',
      name: 'Project A',
      description: null,
      repository_path: 'd:/a',
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    };
    const projB: Project = {
      id: 'proj-b-22',
      name: 'Project B',
      description: null,
      repository_path: 'd:/b',
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    };
    repo.createProject(projA);
    repo.createProject(projB);

    const taskB: Task = {
      id: 'task-b-22',
      project_id: 'proj-b-22',
      milestone_id: null,
      title: 'Task B',
      description: null,
      state: 'DISPATCHED',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 1,
      max_revisions: 3,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createTask(taskB);

    const roleProf: RoleProfile = {
      id: 'rp-22',
      role: 'CODER',
      display_name: 'Coder 22',
      required_capabilities: ['CODING' as Capability],
      preferred_capabilities: [],
      authority_scope: null,
      permissions: [],
      output_protocol: null,
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createRoleProfile(roleProf);

    const prov: Provider = {
      id: 'prov-22',
      name: 'Provider 22',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    repo.createProvider(prov);

    const acct: ProviderAccount = {
      id: 'acct-22',
      provider_id: 'prov-22',
      label: 'Account 22',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: null,
      profile_ref: null,
      enabled: true,
      priority: 1,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createProviderAccount(acct);

    const res: ProviderResource = {
      id: 'res-22',
      provider_id: 'prov-22',
      provider_account_id: 'acct-22',
      model_name: 'model-22',
      health_status: 'AVAILABLE',
      capabilities: ['CODING' as Capability],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: new Date().toISOString(),
    };
    repo.createProviderResource(res);

    const mismatchedAssignment: AgentAssignment = {
      id: 'asgn-mismatch-22',
      project_id: 'proj-a-22', // Project A
      task_id: 'task-b-22', // Belongs to Project B
      attempt_id: null,
      role_profile_id: 'rp-22',
      agent_profile_id: null,
      selected_provider_id: 'prov-22',
      selected_account_id: 'acct-22',
      selected_resource_id: 'res-22',
      selected_worker_slot_id: null,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    };

    expect(() => repo.createAgentAssignment(mismatchedAssignment)).toThrow(/Project task mismatch/);
  });

  // 23. assignment task A + attempt belonging to task B rejected
  it('23. createAgentAssignment rejects task A with attempt belonging to task B', () => {
    const proj: Project = {
      id: 'proj-23',
      name: 'Project 23',
      description: null,
      repository_path: 'd:/p',
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    };
    repo.createProject(proj);

    const taskA: Task = {
      id: 'task-a-23',
      project_id: 'proj-23',
      milestone_id: null,
      title: 'Task A',
      description: null,
      state: 'DISPATCHED',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 1,
      max_revisions: 3,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const taskB: Task = {
      id: 'task-b-23',
      project_id: 'proj-23',
      milestone_id: null,
      title: 'Task B',
      description: null,
      state: 'DISPATCHED',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 1,
      max_revisions: 3,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createTask(taskA);
    repo.createTask(taskB);

    const prov: Provider = {
      id: 'prov-23',
      name: 'Provider 23',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    repo.createProvider(prov);

    const res: ProviderResource = {
      id: 'res-23',
      provider_id: 'prov-23',
      provider_account_id: null,
      model_name: 'model-23',
      health_status: 'AVAILABLE',
      capabilities: ['CODING' as Capability],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: new Date().toISOString(),
    };
    repo.createProviderResource(res);

    const legacyAgent: Agent = {
      id: 'agent-23',
      display_name: 'Agent 23',
      role: 'CODER',
      provider_resource_id: 'res-23',
      status: 'IDLE',
      current_task_id: null,
      last_seen_at: new Date().toISOString(),
    };
    repo.createAgent(legacyAgent);

    const attemptB = {
      id: 'attempt-b-23',
      task_id: 'task-b-23',
      attempt_number: 1,
      agent_id: 'agent-23',
      status: 'IN_PROGRESS' as const,
      started_at: new Date().toISOString(),
      ended_at: null,
      summary: null,
    };
    repo.createTaskAttempt(attemptB);

    const roleProf: RoleProfile = {
      id: 'rp-23',
      role: 'CODER',
      display_name: 'Coder 23',
      required_capabilities: ['CODING' as Capability],
      preferred_capabilities: [],
      authority_scope: null,
      permissions: [],
      output_protocol: null,
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createRoleProfile(roleProf);

    const acct: ProviderAccount = {
      id: 'acct-23',
      provider_id: 'prov-23',
      label: 'Account 23',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: null,
      profile_ref: null,
      enabled: true,
      priority: 1,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createProviderAccount(acct);

    const resLinked: ProviderResource = {
      id: 'res-linked-23',
      provider_id: 'prov-23',
      provider_account_id: 'acct-23',
      model_name: 'model-linked-23',
      health_status: 'AVAILABLE',
      capabilities: ['CODING' as Capability],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: new Date().toISOString(),
    };
    repo.createProviderResource(resLinked);

    const mismatchedAssignment: AgentAssignment = {
      id: 'asgn-mismatch-23',
      project_id: 'proj-23',
      task_id: 'task-a-23', // Task A
      attempt_id: 'attempt-b-23', // Belongs to Task B
      role_profile_id: 'rp-23',
      agent_profile_id: null,
      selected_provider_id: 'prov-23',
      selected_account_id: 'acct-23',
      selected_resource_id: 'res-linked-23',
      selected_worker_slot_id: null,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    };

    expect(() => repo.createAgentAssignment(mismatchedAssignment)).toThrow(/Task attempt mismatch/);
  });

  // 24. role profile A + agent profile belonging to role profile B rejected
  it('24. createAgentAssignment rejects role profile A with agent profile of role profile B', () => {
    const proj: Project = {
      id: 'proj-24',
      name: 'Project 24',
      description: null,
      repository_path: 'd:/p',
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    };
    repo.createProject(proj);

    const task: Task = {
      id: 'task-24',
      project_id: 'proj-24',
      milestone_id: null,
      title: 'Task 24',
      description: null,
      state: 'DISPATCHED',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 1,
      max_revisions: 3,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createTask(task);

    const roleA: RoleProfile = {
      id: 'rp-a-24',
      role: 'CODER',
      display_name: 'Coder 24',
      required_capabilities: ['CODING' as Capability],
      preferred_capabilities: [],
      authority_scope: null,
      permissions: [],
      output_protocol: null,
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const roleB: RoleProfile = {
      id: 'rp-b-24',
      role: 'REVIEWER',
      display_name: 'Reviewer 24',
      required_capabilities: ['REVIEW' as Capability],
      preferred_capabilities: [],
      authority_scope: null,
      permissions: [],
      output_protocol: null,
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createRoleProfile(roleA);
    repo.createRoleProfile(roleB);

    const agentProfB: AgentProfile = {
      id: 'ap-b-24',
      role_profile_id: 'rp-b-24', // Under Role B
      name: 'Reviewer Profile',
      prompt_template: null,
      config: null,
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createAgentProfile(agentProfB);

    const prov: Provider = {
      id: 'prov-24',
      name: 'Provider 24',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    repo.createProvider(prov);

    const acct: ProviderAccount = {
      id: 'acct-24',
      provider_id: 'prov-24',
      label: 'Account 24',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: null,
      profile_ref: null,
      enabled: true,
      priority: 1,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createProviderAccount(acct);

    const res: ProviderResource = {
      id: 'res-24',
      provider_id: 'prov-24',
      provider_account_id: 'acct-24',
      model_name: 'model-24',
      health_status: 'AVAILABLE',
      capabilities: ['CODING' as Capability],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: new Date().toISOString(),
    };
    repo.createProviderResource(res);

    const mismatchedAssignment: AgentAssignment = {
      id: 'asgn-mismatch-24',
      project_id: 'proj-24',
      task_id: 'task-24',
      attempt_id: null,
      role_profile_id: 'rp-a-24', // Role A
      agent_profile_id: 'ap-b-24', // Profile belongs to Role B
      selected_provider_id: 'prov-24',
      selected_account_id: 'acct-24',
      selected_resource_id: 'res-24',
      selected_worker_slot_id: null,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    };

    expect(() => repo.createAgentAssignment(mismatchedAssignment)).toThrow(/Role profile mismatch/);
  });

  // 25. selected provider A + selected account provider B rejected
  it('25. createAgentAssignment rejects selected provider A with account belonging to provider B', () => {
    const proj: Project = {
      id: 'proj-25',
      name: 'Project 25',
      description: null,
      repository_path: 'd:/p',
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    };
    repo.createProject(proj);

    const task: Task = {
      id: 'task-25',
      project_id: 'proj-25',
      milestone_id: null,
      title: 'Task 25',
      description: null,
      state: 'DISPATCHED',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 1,
      max_revisions: 3,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createTask(task);

    const role: RoleProfile = {
      id: 'rp-25',
      role: 'CODER',
      display_name: 'Coder 25',
      required_capabilities: ['CODING' as Capability],
      preferred_capabilities: [],
      authority_scope: null,
      permissions: [],
      output_protocol: null,
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createRoleProfile(role);

    const provA: Provider = {
      id: 'prov-a-25',
      name: 'Provider A',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    const provB: Provider = {
      id: 'prov-b-25',
      name: 'Provider B',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    repo.createProvider(provA);
    repo.createProvider(provB);

    const acctB: ProviderAccount = {
      id: 'acct-b-25',
      provider_id: 'prov-b-25', // Belongs to Prov B
      label: 'Account B',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: null,
      profile_ref: null,
      enabled: true,
      priority: 1,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createProviderAccount(acctB);

    const resB: ProviderResource = {
      id: 'res-b-25',
      provider_id: 'prov-b-25',
      provider_account_id: 'acct-b-25',
      model_name: 'model-b',
      health_status: 'AVAILABLE',
      capabilities: ['CODING' as Capability],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: new Date().toISOString(),
    };
    repo.createProviderResource(resB);

    const mismatchedAssignment: AgentAssignment = {
      id: 'asgn-mismatch-25',
      project_id: 'proj-25',
      task_id: 'task-25',
      attempt_id: null,
      role_profile_id: 'rp-25',
      agent_profile_id: null,
      selected_provider_id: 'prov-a-25', // Selected Provider A (mismatch with Account B from Prov B)
      selected_account_id: 'acct-b-25',
      selected_resource_id: 'res-b-25',
      selected_worker_slot_id: null,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    };

    expect(() => repo.createAgentAssignment(mismatchedAssignment)).toThrow(/Provider account mismatch/);
  });

  // 26. selected account A + selected resource account B rejected
  it('26. createAgentAssignment rejects selected account A with resource belonging to account B', () => {
    const proj: Project = {
      id: 'proj-26',
      name: 'Project 26',
      description: null,
      repository_path: 'd:/p',
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    };
    repo.createProject(proj);

    const task: Task = {
      id: 'task-26',
      project_id: 'proj-26',
      milestone_id: null,
      title: 'Task 26',
      description: null,
      state: 'DISPATCHED',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 1,
      max_revisions: 3,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createTask(task);

    const role: RoleProfile = {
      id: 'rp-26',
      role: 'CODER',
      display_name: 'Coder 26',
      required_capabilities: ['CODING' as Capability],
      preferred_capabilities: [],
      authority_scope: null,
      permissions: [],
      output_protocol: null,
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createRoleProfile(role);

    const prov: Provider = {
      id: 'prov-26',
      name: 'Provider 26',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    repo.createProvider(prov);

    const acct1: ProviderAccount = {
      id: 'acct-1-26',
      provider_id: 'prov-26',
      label: 'Account 1',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: null,
      profile_ref: null,
      enabled: true,
      priority: 1,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const acct2: ProviderAccount = {
      id: 'acct-2-26',
      provider_id: 'prov-26',
      label: 'Account 2',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: null,
      profile_ref: null,
      enabled: true,
      priority: 1,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createProviderAccount(acct1);
    repo.createProviderAccount(acct2);

    const res2: ProviderResource = {
      id: 'res-2-26',
      provider_id: 'prov-26',
      provider_account_id: 'acct-2-26', // Resource belongs to Account 2
      model_name: 'model-2',
      health_status: 'AVAILABLE',
      capabilities: ['CODING' as Capability],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: new Date().toISOString(),
    };
    repo.createProviderResource(res2);

    const mismatchedAssignment: AgentAssignment = {
      id: 'asgn-mismatch-26',
      project_id: 'proj-26',
      task_id: 'task-26',
      attempt_id: null,
      role_profile_id: 'rp-26',
      agent_profile_id: null,
      selected_provider_id: 'prov-26',
      selected_account_id: 'acct-1-26', // Selected Account 1 (mismatch with res-2-26 on Account 2)
      selected_resource_id: 'res-2-26',
      selected_worker_slot_id: null,
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    };

    expect(() => repo.createAgentAssignment(mismatchedAssignment)).toThrow(/Account resource mismatch/);
  });

  // 27. selected worker slot account B for assignment account A rejected
  it('27. createAgentAssignment rejects selected worker slot on account B for assignment account A', () => {
    const proj: Project = {
      id: 'proj-27',
      name: 'Project 27',
      description: null,
      repository_path: 'd:/p',
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    };
    repo.createProject(proj);

    const task: Task = {
      id: 'task-27',
      project_id: 'proj-27',
      milestone_id: null,
      title: 'Task 27',
      description: null,
      state: 'DISPATCHED',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 1,
      max_revisions: 3,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createTask(task);

    const role: RoleProfile = {
      id: 'rp-27',
      role: 'CODER',
      display_name: 'Coder 27',
      required_capabilities: ['CODING' as Capability],
      preferred_capabilities: [],
      authority_scope: null,
      permissions: [],
      output_protocol: null,
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createRoleProfile(role);

    const prov: Provider = {
      id: 'prov-27',
      name: 'Provider 27',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    repo.createProvider(prov);

    const acct1: ProviderAccount = {
      id: 'acct-1-27',
      provider_id: 'prov-27',
      label: 'Account 1',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: null,
      profile_ref: null,
      enabled: true,
      priority: 1,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const acct2: ProviderAccount = {
      id: 'acct-2-27',
      provider_id: 'prov-27',
      label: 'Account 2',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: null,
      profile_ref: null,
      enabled: true,
      priority: 1,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createProviderAccount(acct1);
    repo.createProviderAccount(acct2);

    const res1: ProviderResource = {
      id: 'res-1-27',
      provider_id: 'prov-27',
      provider_account_id: 'acct-1-27',
      model_name: 'model-1',
      health_status: 'AVAILABLE',
      capabilities: ['CODING' as Capability],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: new Date().toISOString(),
    };
    const res2: ProviderResource = {
      id: 'res-2-27',
      provider_id: 'prov-27',
      provider_account_id: 'acct-2-27',
      model_name: 'model-2',
      health_status: 'AVAILABLE',
      capabilities: ['CODING' as Capability],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: new Date().toISOString(),
    };
    repo.createProviderResource(res1);
    repo.createProviderResource(res2);

    const slot2: WorkerSlot = {
      id: 'slot-2-27',
      provider_account_id: 'acct-2-27', // Slot on Account 2
      provider_resource_id: 'res-2-27',
      slot_index: 0,
      status: 'IDLE',
      current_assignment_id: null,
      current_execution_id: null,
      heartbeat_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createWorkerSlot(slot2);

    const mismatchedAssignment: AgentAssignment = {
      id: 'asgn-mismatch-27',
      project_id: 'proj-27',
      task_id: 'task-27',
      attempt_id: null,
      role_profile_id: 'rp-27',
      agent_profile_id: null,
      selected_provider_id: 'prov-27',
      selected_account_id: 'acct-1-27', // Assignment on Account 1
      selected_resource_id: 'res-1-27',
      selected_worker_slot_id: 'slot-2-27', // Slot on Account 2
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    };

    expect(() => repo.createAgentAssignment(mismatchedAssignment)).toThrow(/Assignment slot account mismatch/);
  });

  // 28. account lease account/slot inconsistent with assignment rejected
  it('28. createAccountLease rejects lease account or slot inconsistent with assignment bindings', () => {
    const proj: Project = {
      id: 'proj-28',
      name: 'Project 28',
      description: null,
      repository_path: 'd:/p',
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    };
    repo.createProject(proj);

    const task: Task = {
      id: 'task-28',
      project_id: 'proj-28',
      milestone_id: null,
      title: 'Task 28',
      description: null,
      state: 'DISPATCHED',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 1,
      max_revisions: 3,
      base_sha: null,
      current_sha: null,
      progress_cache_percent: 0,
      progress_computed_at: null,
      acceptance_criteria: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createTask(task);

    const role: RoleProfile = {
      id: 'rp-28',
      role: 'CODER',
      display_name: 'Coder 28',
      required_capabilities: ['CODING' as Capability],
      preferred_capabilities: [],
      authority_scope: null,
      permissions: [],
      output_protocol: null,
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createRoleProfile(role);

    const prov: Provider = {
      id: 'prov-28',
      name: 'Provider 28',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    repo.createProvider(prov);

    const acct1: ProviderAccount = {
      id: 'acct-1-28',
      provider_id: 'prov-28',
      label: 'Account 1',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: null,
      profile_ref: null,
      enabled: true,
      priority: 1,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const acct2: ProviderAccount = {
      id: 'acct-2-28',
      provider_id: 'prov-28',
      label: 'Account 2',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: null,
      profile_ref: null,
      enabled: true,
      priority: 1,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createProviderAccount(acct1);
    repo.createProviderAccount(acct2);

    const res1: ProviderResource = {
      id: 'res-1-28',
      provider_id: 'prov-28',
      provider_account_id: 'acct-1-28',
      model_name: 'model-1',
      health_status: 'AVAILABLE',
      capabilities: ['CODING' as Capability],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: new Date().toISOString(),
    };
    const res2: ProviderResource = {
      id: 'res-2-28',
      provider_id: 'prov-28',
      provider_account_id: 'acct-2-28',
      model_name: 'model-2',
      health_status: 'AVAILABLE',
      capabilities: ['CODING' as Capability],
      enabled: true,
      total_quota: null,
      remaining_quota: null,
      quota_unit: 'REQUESTS',
      quota_reset_at: null,
      quota_source: 'MANUAL',
      quota_confidence: 1.0,
      last_health_check: new Date().toISOString(),
    };
    repo.createProviderResource(res1);
    repo.createProviderResource(res2);

    const slot1: WorkerSlot = {
      id: 'slot-1-28',
      provider_account_id: 'acct-1-28',
      provider_resource_id: 'res-1-28',
      slot_index: 0,
      status: 'IDLE',
      current_assignment_id: null,
      current_execution_id: null,
      heartbeat_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const slot2: WorkerSlot = {
      id: 'slot-2-28',
      provider_account_id: 'acct-2-28',
      provider_resource_id: 'res-2-28',
      slot_index: 0,
      status: 'IDLE',
      current_assignment_id: null,
      current_execution_id: null,
      heartbeat_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createWorkerSlot(slot1);
    repo.createWorkerSlot(slot2);

    const validAsgn: AgentAssignment = {
      id: 'asgn-valid-28',
      project_id: 'proj-28',
      task_id: 'task-28',
      attempt_id: null,
      role_profile_id: 'rp-28',
      agent_profile_id: null,
      selected_provider_id: 'prov-28',
      selected_account_id: 'acct-1-28',
      selected_resource_id: 'res-1-28',
      selected_worker_slot_id: 'slot-1-28',
      routing_decision_id: null,
      preferred_metadata: null,
      status: 'ASSIGNED',
      created_at: new Date().toISOString(),
      ended_at: null,
    };
    repo.createAgentAssignment(validAsgn);

    // Mismatched account
    const leaseWrongAccount: AccountLease = {
      id: 'lease-bad-acct-28',
      assignment_id: 'asgn-valid-28',
      provider_account_id: 'acct-2-28', // Mismatch with assignment acct-1-28
      worker_slot_id: 'slot-1-28',
      lease_token: 'tok-bad-acct',
      acquired_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
      heartbeat_at: new Date().toISOString(),
      released_at: null,
    };
    expect(() => repo.createAccountLease(leaseWrongAccount)).toThrow(/Lease account mismatch/);

    // Mismatched slot
    const leaseWrongSlot: AccountLease = {
      id: 'lease-bad-slot-28',
      assignment_id: 'asgn-valid-28',
      provider_account_id: 'acct-1-28',
      worker_slot_id: 'slot-2-28', // Mismatch with assignment slot-1-28
      lease_token: 'tok-bad-slot',
      acquired_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
      heartbeat_at: new Date().toISOString(),
      released_at: null,
    };
    expect(() => repo.createAccountLease(leaseWrongSlot)).toThrow(/Lease slot mismatch/);
  });

  // 29. status-only worker-slot update preserves assignment/execution IDs
  it('29. updateWorkerSlotStatus preserves assignment, execution, and heartbeat when omitted (undefined)', () => {
    const prov: Provider = {
      id: 'prov-29',
      name: 'Provider 29',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    repo.createProvider(prov);

    const acct: ProviderAccount = {
      id: 'acct-29',
      provider_id: 'prov-29',
      label: 'Account 29',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: null,
      profile_ref: null,
      enabled: true,
      priority: 1,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createProviderAccount(acct);

    const initialHeartbeat = '2026-08-20T00:00:00.000Z';
    const slot: WorkerSlot = {
      id: 'slot-29',
      provider_account_id: 'acct-29',
      provider_resource_id: null,
      slot_index: 0,
      status: 'IDLE',
      current_assignment_id: 'asgn-existing-29',
      current_execution_id: 'exec-existing-29',
      heartbeat_at: initialHeartbeat,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createWorkerSlot(slot);

    // Status-only update (all other args undefined)
    repo.updateWorkerSlotStatus('slot-29', 'RUNNING');

    const updated = repo.getWorkerSlot('slot-29');
    expect(updated).toBeDefined();
    expect(updated?.status).toBe('RUNNING');
    expect(updated?.current_assignment_id).toBe('asgn-existing-29'); // PRESERVED
    expect(updated?.current_execution_id).toBe('exec-existing-29'); // PRESERVED
    expect(updated?.heartbeat_at).toBe(initialHeartbeat); // PRESERVED
  });

  // 30. explicit null worker-slot update clears intended IDs and explicit string sets new IDs
  it('30. updateWorkerSlotStatus clears fields with explicit null and sets fields with explicit strings', () => {
    const prov: Provider = {
      id: 'prov-30',
      name: 'Provider 30',
      adapter_type: 'API',
      enabled: true,
      created_at: new Date().toISOString(),
    };
    repo.createProvider(prov);

    const acct: ProviderAccount = {
      id: 'acct-30',
      provider_id: 'prov-30',
      label: 'Account 30',
      auth_mode: 'API_CREDENTIAL',
      credential_ref: null,
      profile_ref: null,
      enabled: true,
      priority: 1,
      health_status: 'AVAILABLE',
      cooldown_until: null,
      concurrency_limit: 1,
      last_success_at: null,
      last_failure_at: null,
      last_failure_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createProviderAccount(acct);

    const slot: WorkerSlot = {
      id: 'slot-30',
      provider_account_id: 'acct-30',
      provider_resource_id: null,
      slot_index: 0,
      status: 'RUNNING',
      current_assignment_id: 'asgn-to-clear-30',
      current_execution_id: 'exec-to-clear-30',
      heartbeat_at: '2026-08-20T00:00:00.000Z',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createWorkerSlot(slot);

    // 1. Explicit null to clear assignment and execution bindings
    const customHeartbeat = '2026-08-23T12:00:00.000Z';
    repo.updateWorkerSlotStatus('slot-30', 'IDLE', null, null, customHeartbeat);

    let current = repo.getWorkerSlot('slot-30');
    expect(current?.status).toBe('IDLE');
    expect(current?.current_assignment_id).toBeNull(); // CLEARED
    expect(current?.current_execution_id).toBeNull(); // CLEARED
    expect(current?.heartbeat_at).toBe(customHeartbeat); // UPDATED

    // 2. Explicit string to set new assignment and execution bindings
    repo.updateWorkerSlotStatus('slot-30', 'LEASED', 'asgn-new-30', 'exec-new-30');

    current = repo.getWorkerSlot('slot-30');
    expect(current?.status).toBe('LEASED');
    expect(current?.current_assignment_id).toBe('asgn-new-30'); // SET
    expect(current?.current_execution_id).toBe('exec-new-30'); // SET
    expect(current?.heartbeat_at).toBe(customHeartbeat); // PRESERVED (since heartbeat was undefined)

    // 3. Explicit heartbeat update method
    const finalHeartbeat = '2026-08-23T15:30:00.000Z';
    repo.updateWorkerSlotHeartbeat('slot-30', finalHeartbeat);

    current = repo.getWorkerSlot('slot-30');
    expect(current?.heartbeat_at).toBe(finalHeartbeat); // UPDATED
    expect(current?.current_assignment_id).toBe('asgn-new-30'); // PRESERVED
    expect(current?.current_execution_id).toBe('exec-new-30'); // PRESERVED
  });
});
