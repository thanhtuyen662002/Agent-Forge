/**
 * MIGRATION IMMUTABILITY RULE:
 * Once a migration version has been published/pushed to a review branch or release,
 * DO NOT EDIT OR IMPROVE IT. Always append a new migration version for subsequent
 * schema changes or data repairs.
 */

import Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: '001_initial_schema',
    up: (db: Database.Database) => {
      // 1. Projects
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          repository_path TEXT NOT NULL,
          default_branch TEXT NOT NULL DEFAULT 'main',
          status TEXT NOT NULL CHECK(status IN (
            'DRAFT', 'PLANNING', 'READY', 'RUNNING', 'PAUSED', 
            'BLOCKED', 'WAITING_FOR_CAPACITY', 'WAITING_FOR_OWNER', 
            'FINAL_REVIEW', 'COMPLETED', 'FAILED', 'CANCELLED'
          )),
          contract_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        );
      `);

      // 2. Milestones
      db.exec(`
        CREATE TABLE IF NOT EXISTS milestones (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          description TEXT,
          target_date TEXT,
          status TEXT NOT NULL DEFAULT 'PLANNED',
          weight REAL NOT NULL DEFAULT 1.0,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones(project_id);
      `);

      // 3. Tasks
      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          description TEXT,
          state TEXT NOT NULL CHECK(state IN (
            'CREATED', 'PLANNED', 'APPROVED', 'QUEUED', 'DISPATCHED', 
            'CODING', 'VALIDATING', 'REVIEW_READY', 'REVIEWING', 'PAUSED',
            'FIX_REQUIRED', 'HANDOFF_REQUIRED', 'WAITING_FOR_CAPACITY', 
            'WAITING_FOR_AUTHORITY', 'BLOCKED', 'NEEDS_HUMAN', 'DONE', 
            'FAILED', 'CANCELLED'
          )),
          paused_from_state TEXT CHECK(paused_from_state IN (
            'CODING', 'VALIDATING', 'REVIEWING', 'DISPATCHED', NULL
          )),
          priority TEXT NOT NULL CHECK(priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')) DEFAULT 'MEDIUM',
          risk TEXT NOT NULL CHECK(risk IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')) DEFAULT 'MEDIUM',
          assigned_agent_id TEXT,
          revision_count INTEGER NOT NULL DEFAULT 0,
          max_revisions INTEGER NOT NULL DEFAULT 3,
          base_sha TEXT,
          current_sha TEXT,
          progress_cache_percent REAL NOT NULL DEFAULT 0.0,
          progress_computed_at TEXT,
          acceptance_criteria_json TEXT,
          constraints_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
      `);

      // 4. Task Dependencies
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_dependencies (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          PRIMARY KEY(task_id, depends_on_task_id)
        );
      `);

      // 5. Task Leases (Real Concurrency Locks)
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_leases (
          task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL,
          lease_token TEXT NOT NULL UNIQUE,
          acquired_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          heartbeat_at TEXT NOT NULL,
          released_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_leases_agent ON task_leases(agent_id);
      `);

      // 6. Task Attempts
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_attempts (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          attempt_number INTEGER NOT NULL,
          agent_id TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          summary TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_attempts_task ON task_attempts(task_id);
      `);

      // 7. Providers
      db.exec(`
        CREATE TABLE IF NOT EXISTS providers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          adapter_type TEXT NOT NULL CHECK(adapter_type IN ('MANUAL_BRIDGE', 'LOCAL_CLI', 'API', 'MOCK')),
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        );
      `);

      // 8. Provider Resources / Models
      db.exec(`
        CREATE TABLE IF NOT EXISTS provider_resources (
          id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
          model_name TEXT NOT NULL,
          health_status TEXT NOT NULL CHECK(health_status IN (
            'AVAILABLE', 'BUSY', 'LOW_QUOTA', 'RATE_LIMITED', 'QUOTA_EXHAUSTED', 
            'AUTH_ERROR', 'OFFLINE', 'UNHEALTHY', 'COOLDOWN', 'DISABLED', 'UNKNOWN'
          )),
          capabilities_json TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          total_quota REAL,
          remaining_quota REAL,
          quota_unit TEXT DEFAULT 'REQUESTS',
          quota_reset_at TEXT,
          quota_source TEXT NOT NULL CHECK(quota_source IN (
            'MEASURED', 'PROVIDER_REPORTED', 'MANUAL', 'ESTIMATED', 'UNKNOWN'
          )) DEFAULT 'UNKNOWN',
          quota_confidence REAL NOT NULL DEFAULT 0.0,
          last_health_check TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_resources_provider ON provider_resources(provider_id);
      `);

      // 9. Agents
      db.exec(`
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('PRIMARY_MANAGER', 'BACKUP_MANAGER', 'CODER', 'REVIEWER', 'TOOL')),
          provider_resource_id TEXT REFERENCES provider_resources(id) ON DELETE SET NULL,
          status TEXT NOT NULL CHECK(status IN ('IDLE', 'ACTIVE', 'BUSY', 'PAUSED', 'OFFLINE')) DEFAULT 'IDLE',
          current_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          last_seen_at TEXT NOT NULL
        );
      `);

      // 10. Protocol Messages / Idempotent Ledger
      db.exec(`
        CREATE TABLE IF NOT EXISTS protocol_messages (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL UNIQUE,
          protocol TEXT NOT NULL CHECK(protocol IN ('manager.v1', 'coder.v1', 'handoff.v1', 'coder-report.v1')),
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
          expected_task_state TEXT,
          expected_revision INTEGER,
          payload_hash TEXT NOT NULL,
          raw_payload TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('APPLIED', 'REJECTED', 'DUPLICATE')),
          rejection_reason TEXT,
          created_at TEXT NOT NULL,
          processed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_protocol_msg_id ON protocol_messages(message_id);
        CREATE INDEX IF NOT EXISTS idx_protocol_hash ON protocol_messages(payload_hash);
      `);

      // 11. Decisions
      db.exec(`
        CREATE TABLE IF NOT EXISTS decisions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
          author_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          authority_level TEXT NOT NULL CHECK(authority_level IN ('CODER', 'REVIEWER', 'PRIMARY_MANAGER', 'OWNER')),
          decision_type TEXT NOT NULL,
          title TEXT NOT NULL,
          rationale TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED')) DEFAULT 'PENDING',
          reconciliation_needed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
      `);

      // 12. Reviews
      db.exec(`
        CREATE TABLE IF NOT EXISTS reviews (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
          reviewer_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          verdict TEXT NOT NULL CHECK(verdict IN ('PASS', 'FIX_REQUIRED', 'BLOCKED', 'NEEDS_OWNER')),
          summary TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);

      // 13. Review Issues
      db.exec(`
        CREATE TABLE IF NOT EXISTS review_issues (
          id TEXT PRIMARY KEY,
          review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
          severity TEXT NOT NULL CHECK(severity IN ('BLOCKER', 'REQUIRED', 'OPTIONAL', 'NIT')),
          title TEXT NOT NULL,
          file_path TEXT,
          line_number INTEGER,
          description TEXT NOT NULL,
          resolved INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_issues_review ON review_issues(review_id);
      `);

      // 14. Evidence
      db.exec(`
        CREATE TABLE IF NOT EXISTS evidence (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
          attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
          evidence_type TEXT NOT NULL CHECK(evidence_type IN (
            'GIT_DIFF', 'GIT_STATUS', 'GIT_SHA', 'TEST_RESULT', 'LINT_RESULT', 
            'TYPECHECK_RESULT', 'BUILD_RESULT', 'SECURITY_SCAN', 'PROCESS_LOG', 'FILE_SNAPSHOT', 'CUSTOM'
          )),
          storage_type TEXT NOT NULL CHECK(storage_type IN ('INLINE', 'FILE')),
          file_path TEXT,
          hash TEXT NOT NULL,
          byte_size INTEGER NOT NULL,
          content_type TEXT NOT NULL DEFAULT 'text/plain',
          summary TEXT NOT NULL,
          raw_payload TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence(task_id);
      `);

      // 15. Test Runs
      db.exec(`
        CREATE TABLE IF NOT EXISTS test_runs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          command TEXT NOT NULL,
          passed_count INTEGER NOT NULL DEFAULT 0,
          failed_count INTEGER NOT NULL DEFAULT 0,
          skipped_count INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          exit_code INTEGER NOT NULL,
          evidence_id TEXT REFERENCES evidence(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL
        );
      `);

      // 16. Process Runs
      db.exec(`
        CREATE TABLE IF NOT EXISTS process_runs (
          id TEXT PRIMARY KEY,
          pid INTEGER,
          command TEXT NOT NULL,
          working_directory TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT')),
          start_time TEXT NOT NULL,
          end_time TEXT,
          exit_code INTEGER,
          stdout_evidence_id TEXT REFERENCES evidence(id) ON DELETE SET NULL,
          stderr_evidence_id TEXT REFERENCES evidence(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL
        );
      `);

      // 17. Checkpoints
      db.exec(`
        CREATE TABLE IF NOT EXISTS checkpoints (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
          sha TEXT NOT NULL,
          tree_metadata_json TEXT NOT NULL,
          completed_steps_json TEXT NOT NULL,
          remaining_steps_json TEXT NOT NULL,
          tests_passing INTEGER NOT NULL DEFAULT 0,
          tests_failing INTEGER NOT NULL DEFAULT 0,
          known_issues_json TEXT,
          recommended_next_action TEXT,
          created_at TEXT NOT NULL
        );
      `);

      // 18. Handoffs
      db.exec(`
        CREATE TABLE IF NOT EXISTS handoffs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
          previous_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          reason TEXT NOT NULL CHECK(reason IN (
            'QUOTA_EXHAUSTED', 'CONTEXT_EXHAUSTED', 'AUTH_ERROR', 'TIMEOUT', 'MANUAL', 'PROCESS_CRASH'
          )),
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);

      // 19. Events (Immutable Audit Stream)
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
          agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          type TEXT NOT NULL,
          summary TEXT NOT NULL,
          structured_payload_json TEXT NOT NULL,
          timestamp TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      `);

      // 20. Approvals
      db.exec(`
        CREATE TABLE IF NOT EXISTS approvals (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
          requested_by TEXT REFERENCES agents(id) ON DELETE SET NULL,
          approved_by TEXT,
          action_type TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('PENDING', 'APPROVED', 'REJECTED')) DEFAULT 'PENDING',
          rationale TEXT,
          created_at TEXT NOT NULL,
          responded_at TEXT
        );
      `);

      // 21. Policies
      db.exec(`
        CREATE TABLE IF NOT EXISTS policies (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          policy_type TEXT NOT NULL,
          action TEXT NOT NULL,
          rule_expression TEXT NOT NULL,
          default_decision TEXT NOT NULL CHECK(default_decision IN ('ALLOW', 'DENY', 'REQUIRES_OWNER_APPROVAL')),
          created_at TEXT NOT NULL
        );
      `);

      // 22. Project Settings
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_settings (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          PRIMARY KEY(project_id, key)
        );
      `);
    },
  },
  {
    version: 2,
    name: '002_verification_commands',
    up: (db: Database.Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS verification_commands (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          command_type TEXT NOT NULL CHECK(command_type IN ('TEST', 'LINT', 'TYPECHECK', 'BUILD')),
          executable TEXT NOT NULL,
          args_json TEXT NOT NULL,
          timeout_ms INTEGER NOT NULL DEFAULT 60000,
          enabled INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_verif_cmds_project ON verification_commands(project_id);
      `);
    },
  },
  {
    version: 3,
    name: '003_nullable_health_check',
    up: (db: Database.Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS provider_resources_new (
          id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
          model_name TEXT NOT NULL,
          health_status TEXT NOT NULL CHECK(health_status IN (
            'AVAILABLE', 'BUSY', 'LOW_QUOTA', 'RATE_LIMITED', 'QUOTA_EXHAUSTED',
            'AUTH_ERROR', 'OFFLINE', 'UNHEALTHY', 'COOLDOWN', 'DISABLED', 'UNKNOWN'
          )),
          capabilities_json TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          total_quota REAL,
          remaining_quota REAL,
          quota_unit TEXT DEFAULT 'REQUESTS',
          quota_reset_at TEXT,
          quota_source TEXT NOT NULL CHECK(quota_source IN (
            'MEASURED', 'PROVIDER_REPORTED', 'MANUAL', 'ESTIMATED', 'UNKNOWN'
          )) DEFAULT 'UNKNOWN',
          quota_confidence REAL NOT NULL DEFAULT 0.0,
          last_health_check TEXT
        );

        INSERT INTO provider_resources_new SELECT * FROM provider_resources;
        DROP TABLE provider_resources;
        ALTER TABLE provider_resources_new RENAME TO provider_resources;
        CREATE INDEX IF NOT EXISTS idx_resources_provider ON provider_resources(provider_id);
      `);
    },
  },
  {
    version: 4,
    name: '004_process_run_ownership',
    up: (db: Database.Database) => {
      db.exec(`
        ALTER TABLE process_runs ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
        ALTER TABLE process_runs ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE;
        ALTER TABLE process_runs ADD COLUMN attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_process_runs_task ON process_runs(task_id);
        CREATE INDEX IF NOT EXISTS idx_process_runs_project ON process_runs(project_id);
      `);
    },
  },
  {
    version: 5,
    name: '005_repair_default_agent_resource_links',
    up: (db: Database.Database) => {
      // Repair supported default Agent -> ProviderResource relationships for databases
      // that previously executed original migration v3 and had provider_resource_id set to NULL.
      // Operates ONLY when both expected records exist, and does NOT overwrite existing valid IDs.
      db.exec(`
        UPDATE agents
        SET provider_resource_id = 'res-chatgpt-manager'
        WHERE id = 'agent-primary-manager'
          AND provider_resource_id IS NULL
          AND EXISTS (SELECT 1 FROM provider_resources WHERE id = 'res-chatgpt-manager');

        UPDATE agents
        SET provider_resource_id = 'res-gemini-coder'
        WHERE id = 'agent-gemini-coder'
          AND provider_resource_id IS NULL
          AND EXISTS (SELECT 1 FROM provider_resources WHERE id = 'res-gemini-coder');

        UPDATE agents
        SET provider_resource_id = 'res-claude-reviewer'
        WHERE id = 'agent-claude-reviewer'
          AND provider_resource_id IS NULL
          AND EXISTS (SELECT 1 FROM provider_resources WHERE id = 'res-claude-reviewer');
      `);
    },
  },
  {
    version: 6,
    name: '006_execution_authorizations',
    up: (db: Database.Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS execution_authorizations (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
          attempt_id TEXT REFERENCES task_attempts(id) ON DELETE RESTRICT,
          task_revision INTEGER NOT NULL,
          base_sha TEXT NOT NULL,
          repository_head_sha TEXT NOT NULL,
          manager_message_id TEXT NOT NULL REFERENCES protocol_messages(id) ON DELETE RESTRICT,
          manager_payload_hash TEXT NOT NULL,
          routing_decision_id TEXT NOT NULL,
          selected_resource_id TEXT NOT NULL REFERENCES provider_resources(id) ON DELETE RESTRICT,
          selected_provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
          instruction_payload_hash TEXT NOT NULL,
          context_manifest_hash TEXT NOT NULL,
          canonical_instructions_json TEXT NOT NULL,
          context_files_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('AUTHORIZED', 'DISPATCHED', 'INVALIDATED')) DEFAULT 'AUTHORIZED',
          created_at TEXT NOT NULL,
          dispatched_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_exec_auth_task ON execution_authorizations(task_id);
        CREATE INDEX IF NOT EXISTS idx_exec_auth_project ON execution_authorizations(project_id);
        CREATE INDEX IF NOT EXISTS idx_exec_auth_routing ON execution_authorizations(routing_decision_id);
        CREATE INDEX IF NOT EXISTS idx_exec_auth_manager_msg ON execution_authorizations(manager_message_id);
      `);
    },
  },
  {
    version: 7,
    name: '007_execution_authorization_canonical_payload',
    up: (db: Database.Database) => {
      db.exec(`
        ALTER TABLE execution_authorizations
        ADD COLUMN canonical_payload_json TEXT NULL;
      `);
    },
  },
  {
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
  },
  {
    version: 9,
    name: '009_r5b_durable_memory_context_fabric',
    up: (db: Database.Database) => {
      db.exec(`
        -- 1. Agent Sessions (Logical execution sessions decoupled from external conversations)
        CREATE TABLE IF NOT EXISTS agent_sessions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
          assignment_id TEXT REFERENCES agent_assignments(id) ON DELETE SET NULL,
          provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
          provider_account_id TEXT REFERENCES provider_accounts(id) ON DELETE SET NULL,
          provider_resource_id TEXT REFERENCES provider_resources(id) ON DELETE SET NULL,
          external_session_ref TEXT,
          status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'ENDED', 'FAILED', 'SUSPENDED')) DEFAULT 'ACTIVE',
          started_at TEXT NOT NULL,
          ended_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_sessions_task ON agent_sessions(task_id);
        CREATE INDEX IF NOT EXISTS idx_agent_sessions_project ON agent_sessions(project_id);
        CREATE INDEX IF NOT EXISTS idx_agent_sessions_assignment ON agent_sessions(assignment_id);

        -- 2. Project Memory (Durable, versioned project-level knowledge)
        CREATE TABLE IF NOT EXISTS project_memories (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          memory_type TEXT NOT NULL CHECK(memory_type IN (
            'ARCHITECTURE', 'OWNER_POLICY', 'CONSTRAINT', 'DECISION',
            'CONVENTION', 'REPOSITORY_FACT', 'CUSTOM'
          )),
          key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_ref TEXT,
          revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
          is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_project_memories_project_key ON project_memories(project_id, memory_type, key);
        CREATE INDEX IF NOT EXISTS idx_project_memories_revision ON project_memories(project_id, memory_type, key, revision);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_active_project_memory ON project_memories(project_id, memory_type, key) WHERE is_active = 1;

        -- 3. Task Memory (Durable, versioned task-specific operational memory)
        CREATE TABLE IF NOT EXISTS task_memories (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
          assignment_id TEXT REFERENCES agent_assignments(id) ON DELETE SET NULL,
          memory_type TEXT NOT NULL CHECK(memory_type IN (
            'GOAL', 'ACCEPTANCE_CRITERION', 'CONSTRAINT', 'COMPLETED_STEP',
            'REMAINING_STEP', 'KNOWN_ISSUE', 'DECISION', 'VERIFICATION_FACT',
            'RECOMMENDED_NEXT_ACTION', 'CUSTOM'
          )),
          key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_ref TEXT,
          revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
          is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_task_memories_task_key ON task_memories(task_id, memory_type, key);
        CREATE INDEX IF NOT EXISTS idx_task_memories_project ON task_memories(project_id);
        CREATE INDEX IF NOT EXISTS idx_task_memories_revision ON task_memories(task_id, memory_type, key, revision);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_active_task_memory ON task_memories(task_id, memory_type, key) WHERE is_active = 1;

        -- 4. Context Snapshots (Immutable frozen context input)
        CREATE TABLE IF NOT EXISTS context_snapshots (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
          assignment_id TEXT REFERENCES agent_assignments(id) ON DELETE SET NULL,
          session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
          purpose TEXT NOT NULL CHECK(purpose IN (
            'EXECUTION', 'REVIEW', 'HANDOFF', 'MANAGER', 'RESEARCH', 'CUSTOM'
          )),
          snapshot_version INTEGER NOT NULL DEFAULT 1 CHECK(snapshot_version >= 1),
          builder_version TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_context_snapshots_task ON context_snapshots(task_id);
        CREATE INDEX IF NOT EXISTS idx_context_snapshots_project ON context_snapshots(project_id);
        CREATE INDEX IF NOT EXISTS idx_context_snapshots_hash ON context_snapshots(content_hash);

        -- 5. Context Items (Ordered members of ContextSnapshot)
        CREATE TABLE IF NOT EXISTS context_items (
          id TEXT PRIMARY KEY,
          snapshot_id TEXT NOT NULL REFERENCES context_snapshots(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
          item_type TEXT NOT NULL CHECK(item_type IN (
            'PROJECT_CONTRACT', 'PROJECT_MEMORY', 'TASK_CORE', 'TASK_MEMORY',
            'CHECKPOINT', 'HANDOFF', 'CONTEXT_FILE_REFERENCE', 'CUSTOM'
          )),
          source_type TEXT NOT NULL,
          source_ref TEXT,
          content_json TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          token_estimate INTEGER,
          created_at TEXT NOT NULL,
          UNIQUE(snapshot_id, ordinal)
        );
        CREATE INDEX IF NOT EXISTS idx_context_items_snapshot_ordinal ON context_items(snapshot_id, ordinal);

        -- 6. Context Manifests (Canonical manifest describing the complete immutable context snapshot)
        CREATE TABLE IF NOT EXISTS context_manifests (
          id TEXT PRIMARY KEY,
          snapshot_id TEXT NOT NULL UNIQUE REFERENCES context_snapshots(id) ON DELETE CASCADE,
          manifest_version TEXT NOT NULL,
          item_count INTEGER NOT NULL CHECK(item_count >= 0),
          manifest_json TEXT NOT NULL,
          manifest_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_context_manifests_hash ON context_manifests(manifest_hash);

        -- 7. Handoff Context (Durable context bridge for cross-agent/model/provider movement)
        CREATE TABLE IF NOT EXISTS handoff_contexts (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
          from_assignment_id TEXT REFERENCES agent_assignments(id) ON DELETE SET NULL,
          to_assignment_id TEXT REFERENCES agent_assignments(id) ON DELETE SET NULL,
          source_snapshot_id TEXT NOT NULL REFERENCES context_snapshots(id) ON DELETE RESTRICT,
          handoff_snapshot_id TEXT REFERENCES context_snapshots(id) ON DELETE SET NULL,
          reason TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('PENDING', 'READY', 'CONSUMED', 'FAILED', 'CANCELLED')) DEFAULT 'PENDING',
          created_at TEXT NOT NULL,
          consumed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_handoff_contexts_task ON handoff_contexts(task_id);
        CREATE INDEX IF NOT EXISTS idx_handoff_contexts_project ON handoff_contexts(project_id);
      `);
    },
  },
  {
    version: 10,
    name: '010_r5h4_failover_lineage_budget_idempotency',
    up: (db: Database.Database) => {
      // 1. Check for legacy duplicate attempt numbers on task_attempts before creating unique index
      const duplicate = db
        .prepare(`
          SELECT task_id, attempt_number, COUNT(*) AS count
          FROM task_attempts
          GROUP BY task_id, attempt_number
          HAVING COUNT(*) > 1
          LIMIT 1
        `)
        .get() as { task_id: string; attempt_number: number; count: number } | undefined;

      if (duplicate) {
        throw new Error(
          `[Migration 10] Cannot apply unique index on task_attempts(task_id, attempt_number): duplicate attempt_number ${duplicate.attempt_number} found for task_id "${duplicate.task_id}" (${duplicate.count} occurrences).`
        );
      }

      // 2. Create unique indexes on task_attempts
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_task_attempts_task_number_unique ON task_attempts(task_id, attempt_number);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_task_attempts_task_id_id_unique ON task_attempts(task_id, id);
      `);

      // 3. Create failover_transitions table with composite foreign keys to guarantee same-task integrity
      db.exec(`
        CREATE TABLE IF NOT EXISTS failover_transitions (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          root_attempt_id TEXT NOT NULL,
          source_attempt_id TEXT NOT NULL,
          successor_attempt_id TEXT NOT NULL,
          failover_ordinal INTEGER NOT NULL CHECK(failover_ordinal >= 1),
          created_at TEXT NOT NULL,
          FOREIGN KEY (task_id, root_attempt_id) REFERENCES task_attempts(task_id, id) ON DELETE CASCADE,
          FOREIGN KEY (task_id, source_attempt_id) REFERENCES task_attempts(task_id, id) ON DELETE CASCADE,
          FOREIGN KEY (task_id, successor_attempt_id) REFERENCES task_attempts(task_id, id) ON DELETE CASCADE,
          UNIQUE(source_attempt_id),
          UNIQUE(successor_attempt_id),
          UNIQUE(root_attempt_id, failover_ordinal)
        );
        CREATE INDEX IF NOT EXISTS idx_failover_transitions_task ON failover_transitions(task_id);
      `);
    },
  },
  {
    version: 11,
    name: '011_r5h4_durable_provider_health_observations',
    up: (db: Database.Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS provider_health_observations (
          authorization_id TEXT PRIMARY KEY REFERENCES execution_authorizations(id) ON DELETE CASCADE,
          execution_id TEXT NOT NULL,
          account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
          provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
          resource_id TEXT NOT NULL REFERENCES provider_resources(id) ON DELETE CASCADE,
          assignment_id TEXT NOT NULL REFERENCES agent_assignments(id) ON DELETE CASCADE,
          attempt_id TEXT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
          routing_decision_id TEXT NOT NULL,
          provenance_version INTEGER NOT NULL CHECK(provenance_version = 1),
          provenance_source TEXT NOT NULL CHECK(provenance_source = 'PROVIDER_DISPATCH_SERVICE'),
          mode TEXT NOT NULL CHECK(mode IN ('LEGACY', 'SCHEDULED')),
          adapter_invocation TEXT NOT NULL CHECK(adapter_invocation IN ('RETURNED', 'THREW')),
          result_status TEXT NOT NULL,
          classified_category TEXT NOT NULL,
          observed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_provider_health_observations_account ON provider_health_observations(account_id);
        CREATE INDEX IF NOT EXISTS idx_provider_health_observations_provider ON provider_health_observations(provider_id);
        CREATE INDEX IF NOT EXISTS idx_provider_health_observations_assignment ON provider_health_observations(assignment_id);
      `);
    },
  },
];

export class MigrationRunner {
  public static run(db: Database.Database): void {
    // 1. Ensure migrations ledger exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const appliedRows = db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as { version: number }[];
    const appliedVersions = new Set(appliedRows.map((r) => r.version));

    for (const migration of MIGRATIONS) {
      if (!appliedVersions.has(migration.version)) {
        console.log(`[Migrations] Applying migration ${migration.version}: ${migration.name}...`);
        const runTx = db.transaction(() => {
          migration.up(db);
          db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
            migration.version,
            migration.name,
            new Date().toISOString()
          );
        });
        runTx();
        console.log(`[Migrations] Successfully applied migration ${migration.version}`);
      }
    }
  }
}
