import Database from 'better-sqlite3';
import type { Migration } from './types';

export const migration008: Migration = {
    version: 8,
    name: '008_r5a_role_agnostic_agent_fabric',
    up: (db: Database.Database) => {
      db.exec(`
        -- 1. Role Profiles
        CREATE TABLE IF NOT EXISTS role_profiles (
          id TEXT PRIMARY KEY,
          role TEXT NOT NULL CHECK(role IN (
            'MANAGER', 'PLANNER', 'CODER', 'REVIEWER', 'SECURITY_REVIEWER',
            'RESEARCHER', 'RELEASE_MANAGER', 'MONITOR', 'TOOL'
          )),
          display_name TEXT NOT NULL,
          required_capabilities_json TEXT NOT NULL,
          preferred_capabilities_json TEXT NOT NULL,
          authority_scope_json TEXT,
          permissions_json TEXT NOT NULL,
          output_protocol TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_role_profiles_role ON role_profiles(role);
        CREATE INDEX IF NOT EXISTS idx_role_profiles_enabled ON role_profiles(enabled);

        -- 2. Agent Profiles
        CREATE TABLE IF NOT EXISTS agent_profiles (
          id TEXT PRIMARY KEY,
          role_profile_id TEXT NOT NULL REFERENCES role_profiles(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          prompt_template TEXT,
          config_json TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_profiles_role_profile ON agent_profiles(role_profile_id);
        CREATE INDEX IF NOT EXISTS idx_agent_profiles_enabled ON agent_profiles(enabled);

        -- 3. Provider Accounts
        CREATE TABLE IF NOT EXISTS provider_accounts (
          id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
          label TEXT NOT NULL,
          auth_mode TEXT NOT NULL CHECK(auth_mode IN ('NATIVE_PROFILE', 'API_CREDENTIAL')),
          credential_ref TEXT,
          profile_ref TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          priority INTEGER NOT NULL DEFAULT 0,
          health_status TEXT NOT NULL CHECK(health_status IN (
            'AVAILABLE', 'BUSY', 'LOW_QUOTA', 'RATE_LIMITED', 'QUOTA_EXHAUSTED',
            'AUTH_ERROR', 'OFFLINE', 'UNHEALTHY', 'COOLDOWN', 'DISABLED', 'UNKNOWN'
          )) DEFAULT 'UNKNOWN',
          cooldown_until TEXT,
          concurrency_limit INTEGER NOT NULL DEFAULT 1 CHECK(concurrency_limit >= 1),
          last_success_at TEXT,
          last_failure_at TEXT,
          last_failure_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_provider_accounts_provider ON provider_accounts(provider_id);
        CREATE INDEX IF NOT EXISTS idx_provider_accounts_health ON provider_accounts(health_status);
        CREATE INDEX IF NOT EXISTS idx_provider_accounts_enabled ON provider_accounts(enabled);

        -- 4. Extend Provider Resources with nullable provider_account_id
        ALTER TABLE provider_resources
        ADD COLUMN provider_account_id TEXT REFERENCES provider_accounts(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_resources_account ON provider_resources(provider_account_id);

        -- 5. Worker Slots
        CREATE TABLE IF NOT EXISTS worker_slots (
          id TEXT PRIMARY KEY,
          provider_account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
          provider_resource_id TEXT REFERENCES provider_resources(id) ON DELETE SET NULL,
          slot_index INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN (
            'IDLE', 'LEASED', 'RUNNING', 'COOLDOWN', 'OFFLINE', 'DISABLED'
          )) DEFAULT 'IDLE',
          current_assignment_id TEXT,
          current_execution_id TEXT,
          heartbeat_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(provider_account_id, slot_index)
        );
        CREATE INDEX IF NOT EXISTS idx_worker_slots_account ON worker_slots(provider_account_id);
        CREATE INDEX IF NOT EXISTS idx_worker_slots_resource ON worker_slots(provider_resource_id);
        CREATE INDEX IF NOT EXISTS idx_worker_slots_status ON worker_slots(status);

        -- 6. Agent Assignments
        CREATE TABLE IF NOT EXISTS agent_assignments (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
          role_profile_id TEXT NOT NULL REFERENCES role_profiles(id),
          agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL,
          selected_provider_id TEXT NOT NULL REFERENCES providers(id),
          selected_account_id TEXT NOT NULL REFERENCES provider_accounts(id),
          selected_resource_id TEXT NOT NULL REFERENCES provider_resources(id),
          selected_worker_slot_id TEXT REFERENCES worker_slots(id) ON DELETE SET NULL,
          routing_decision_id TEXT,
          preferred_metadata_json TEXT,
          status TEXT NOT NULL CHECK(status IN (
            'ASSIGNED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'HANDED_OFF'
          )) DEFAULT 'ASSIGNED',
          created_at TEXT NOT NULL,
          ended_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_agent_assignments_task ON agent_assignments(task_id);
        CREATE INDEX IF NOT EXISTS idx_agent_assignments_project ON agent_assignments(project_id);
        CREATE INDEX IF NOT EXISTS idx_agent_assignments_role ON agent_assignments(role_profile_id);
        CREATE INDEX IF NOT EXISTS idx_agent_assignments_account ON agent_assignments(selected_account_id);
        CREATE INDEX IF NOT EXISTS idx_agent_assignments_resource ON agent_assignments(selected_resource_id);

        -- 7. Account Leases (with partial unique index on active slot lease)
        CREATE TABLE IF NOT EXISTS account_leases (
          id TEXT PRIMARY KEY,
          assignment_id TEXT NOT NULL REFERENCES agent_assignments(id) ON DELETE CASCADE,
          provider_account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
          worker_slot_id TEXT NOT NULL REFERENCES worker_slots(id) ON DELETE CASCADE,
          lease_token TEXT NOT NULL UNIQUE,
          acquired_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          heartbeat_at TEXT NOT NULL,
          released_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_account_leases_assignment ON account_leases(assignment_id);
        CREATE INDEX IF NOT EXISTS idx_account_leases_account ON account_leases(provider_account_id);
        CREATE INDEX IF NOT EXISTS idx_account_leases_token ON account_leases(lease_token);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_active_slot_lease ON account_leases(worker_slot_id) WHERE released_at IS NULL;

        -- 8. Route Policies
        CREATE TABLE IF NOT EXISTS route_policies (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          required_capabilities_json TEXT NOT NULL,
          preferred_capabilities_json TEXT NOT NULL,
          provider_account_policy_json TEXT,
          allow_manual_bridge INTEGER NOT NULL DEFAULT 1,
          failover_policy_json TEXT,
          risk_policy_json TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_route_policies_enabled ON route_policies(enabled);

        -- 9. Separation Policies
        CREATE TABLE IF NOT EXISTS separation_policies (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          same_execution_forbidden INTEGER NOT NULL DEFAULT 1,
          same_session_forbidden INTEGER NOT NULL DEFAULT 1,
          same_account_policy TEXT NOT NULL CHECK(same_account_policy IN ('ALLOW', 'PREFER_DIFFERENT', 'REQUIRE_DIFFERENT')) DEFAULT 'REQUIRE_DIFFERENT',
          same_provider_policy TEXT NOT NULL CHECK(same_provider_policy IN ('ALLOW', 'PREFER_DIFFERENT', 'REQUIRE_DIFFERENT')) DEFAULT 'PREFER_DIFFERENT',
          same_model_policy TEXT NOT NULL CHECK(same_model_policy IN ('ALLOW', 'PREFER_DIFFERENT', 'REQUIRE_DIFFERENT')) DEFAULT 'PREFER_DIFFERENT',
          risk_threshold TEXT NOT NULL CHECK(risk_threshold IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')) DEFAULT 'HIGH',
          applicability_json TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_separation_policies_enabled ON separation_policies(enabled);
      `);
    },
  };
