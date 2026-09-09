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
  foreignKeyMode?: 'ENFORCED' | 'DISABLED_FOR_REBUILD';
}

const ALL_MIGRATIONS_LIST: Migration[] = [
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
  {
    version: 12,
    name: '012_r5h4_provider_health_observation_ordering_authority',
    up: (db: Database.Database) => {
      db.exec(`
        ALTER TABLE provider_health_observations
        ADD COLUMN account_order INTEGER NULL;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_health_observations_account_order
        ON provider_health_observations(account_id, account_order)
        WHERE account_order IS NOT NULL;
      `);
    },
  },
  {
    version: 13,
    name: '013_r5h4_durable_provider_health_action_plan_authority',
    up: (db: Database.Database) => {
      db.exec(`
        ALTER TABLE provider_health_observations
        ADD COLUMN health_action_plan_version INTEGER NULL CHECK(health_action_plan_version IS NULL OR health_action_plan_version = 1);

        ALTER TABLE provider_health_observations
        ADD COLUMN health_action TEXT NULL CHECK(health_action IS NULL OR health_action IN (
          'NO_MUTATION', 'RECORD_SUCCESS', 'RECORD_RATE_LIMITED', 'RECORD_QUOTA_EXHAUSTED', 'RECORD_AUTH_ERROR'
        ));

        ALTER TABLE provider_health_observations
        ADD COLUMN health_action_cooldown_duration_ms INTEGER NULL CHECK(
          health_action_cooldown_duration_ms IS NULL OR health_action_cooldown_duration_ms > 0
        );
      `);
    },
  },
  {
    version: 14,
    name: '014_r5h4_provider_health_cooldown_replay_authority',
    up: (db: Database.Database) => {
      db.exec(`
        ALTER TABLE provider_health_observations
        ADD COLUMN health_action_cooldown_anchor_at TEXT NULL;
      `);
    },
  },
  {
    version: 15,
    name: '015_r5h4_ordered_provider_health_application_idempotency',
    up: (db: Database.Database) => {
      db.exec(`
        ALTER TABLE provider_accounts
        ADD COLUMN last_applied_action_account_order INTEGER NULL CHECK(
          last_applied_action_account_order IS NULL OR last_applied_action_account_order > 0
        );

        ALTER TABLE provider_accounts
        ADD COLUMN last_applied_action_authorization_id TEXT NULL;
      `);
    },
  },
  {
    version: 16,
    name: '016_r5i_durable_handoff_ownership_and_execution_authority',
    foreignKeyMode: 'DISABLED_FOR_REBUILD',
    up: (db: Database.Database) => {
      // 1. Rebuild task_attempts to support nullable agent_id + nullable agent_profile_id with identity check
      db.exec(`
        CREATE TABLE task_attempts_new (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          attempt_number INTEGER NOT NULL,
          agent_id TEXT NULL,
          agent_profile_id TEXT NULL REFERENCES agent_profiles(id) ON DELETE SET NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          summary TEXT,
          CHECK(agent_id IS NOT NULL OR agent_profile_id IS NOT NULL)
        );

        INSERT INTO task_attempts_new (
          id, task_id, attempt_number, agent_id, agent_profile_id, status, started_at, ended_at, summary
        )
        SELECT id, task_id, attempt_number, agent_id, NULL, status, started_at, ended_at, summary
        FROM task_attempts;

        DROP TABLE task_attempts;

        ALTER TABLE task_attempts_new RENAME TO task_attempts;

        CREATE INDEX IF NOT EXISTS idx_attempts_task ON task_attempts(task_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_task_attempts_task_number_unique ON task_attempts(task_id, attempt_number);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_task_attempts_task_id_id_unique ON task_attempts(task_id, id);
        CREATE INDEX IF NOT EXISTS idx_task_attempts_agent_profile ON task_attempts(agent_profile_id);
      `);

      // 2. Add durable task ownership epoch to tasks
      db.exec(`
        ALTER TABLE tasks ADD COLUMN ownership_epoch INTEGER NOT NULL DEFAULT 1;
      `);

      // 3. Extend execution_authorizations with execution lifecycle and termination fields
      db.exec(`
        ALTER TABLE execution_authorizations ADD COLUMN task_ownership_epoch INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE execution_authorizations ADD COLUMN execution_id TEXT NULL;
        ALTER TABLE execution_authorizations ADD COLUMN adapter_started_at TEXT NULL;
        ALTER TABLE execution_authorizations ADD COLUMN adapter_finished_at TEXT NULL;
        ALTER TABLE execution_authorizations ADD COLUMN adapter_outcome TEXT NULL CHECK(
          adapter_outcome IS NULL OR adapter_outcome IN ('RETURNED', 'THREW', 'CANCELLED', 'TIMED_OUT', 'UNKNOWN')
        );
        ALTER TABLE execution_authorizations ADD COLUMN cancellation_requested_at TEXT NULL;
        ALTER TABLE execution_authorizations ADD COLUMN termination_confirmed_at TEXT NULL;
        ALTER TABLE execution_authorizations ADD COLUMN termination_status TEXT NULL CHECK(
          termination_status IS NULL OR termination_status IN ('CONFIRMED_TERMINATED', 'UNRESOLVED')
        );
        ALTER TABLE execution_authorizations ADD COLUMN termination_source TEXT NULL;
      `);

      // 4. Create dedicated handoff_transfers table
      db.exec(`
        CREATE TABLE IF NOT EXISTS handoff_transfers (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          source_attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
          successor_attempt_id TEXT NULL REFERENCES task_attempts(id) ON DELETE SET NULL,
          source_assignment_id TEXT NOT NULL REFERENCES agent_assignments(id) ON DELETE CASCADE,
          successor_assignment_id TEXT NULL REFERENCES agent_assignments(id) ON DELETE SET NULL,
          successor_role_profile_id TEXT NULL REFERENCES role_profiles(id) ON DELETE SET NULL,
          successor_agent_profile_id TEXT NULL REFERENCES agent_profiles(id) ON DELETE SET NULL,
          successor_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
          handoff_context_id TEXT NOT NULL REFERENCES handoff_contexts(id) ON DELETE RESTRICT,
          checkpoint_id TEXT NULL REFERENCES checkpoints(id) ON DELETE SET NULL,
          source_authorization_id TEXT NULL REFERENCES execution_authorizations(id) ON DELETE SET NULL,
          successor_authorization_id TEXT NULL REFERENCES execution_authorizations(id) ON DELETE SET NULL,
          reason TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN (
            'REQUESTED', 'FROZEN', 'QUIESCING', 'RELINQUISHED', 'SUCCESSOR_PREPARED',
            'ROUTED', 'AUTHORIZED', 'ACCEPTED', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'
          )) DEFAULT 'REQUESTED',
          source_ownership_epoch INTEGER NOT NULL DEFAULT 1,
          successor_ownership_epoch INTEGER NULL,
          version INTEGER NOT NULL DEFAULT 1,
          frozen_at TEXT NULL,
          quiescing_at TEXT NULL,
          relinquished_at TEXT NULL,
          accepted_at TEXT NULL,
          completed_at TEXT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_active_handoff_transfer_source
          ON handoff_transfers(source_attempt_id)
          WHERE status IN ('REQUESTED', 'FROZEN', 'QUIESCING', 'RELINQUISHED', 'SUCCESSOR_PREPARED', 'ROUTED', 'AUTHORIZED', 'ACCEPTED');

        CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_transfers_successor_attempt
          ON handoff_transfers(successor_attempt_id)
          WHERE successor_attempt_id IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_handoff_transfers_task ON handoff_transfers(task_id);
        CREATE INDEX IF NOT EXISTS idx_handoff_transfers_status ON handoff_transfers(status);
      `);
    },
  },
  {
    version: 17,
    name: '017_r5i_handoff_authority_corrective_hardening',
    foreignKeyMode: 'DISABLED_FOR_REBUILD',
    up: (db: Database.Database) => {
      // 1. Rebuild handoff_transfers:
      //    - Make handoff_context_id NULLABLE REFERENCES handoff_contexts(id) ON DELETE RESTRICT
      //    - Remove legacy successor_agent_id (successor logical authority is role/agent profiles)
      //    - Update active transfer uniqueness index: active status OR relinquished_at IS NOT NULL
      db.exec(`
        CREATE TABLE handoff_transfers_new (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          source_attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
          successor_attempt_id TEXT NULL REFERENCES task_attempts(id) ON DELETE SET NULL,
          source_assignment_id TEXT NOT NULL REFERENCES agent_assignments(id) ON DELETE CASCADE,
          successor_assignment_id TEXT NULL REFERENCES agent_assignments(id) ON DELETE SET NULL,
          successor_role_profile_id TEXT NULL REFERENCES role_profiles(id) ON DELETE SET NULL,
          successor_agent_profile_id TEXT NULL REFERENCES agent_profiles(id) ON DELETE SET NULL,
          handoff_context_id TEXT NULL REFERENCES handoff_contexts(id) ON DELETE RESTRICT,
          checkpoint_id TEXT NULL REFERENCES checkpoints(id) ON DELETE SET NULL,
          source_authorization_id TEXT NULL REFERENCES execution_authorizations(id) ON DELETE SET NULL,
          successor_authorization_id TEXT NULL REFERENCES execution_authorizations(id) ON DELETE SET NULL,
          reason TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN (
            'REQUESTED', 'FROZEN', 'QUIESCING', 'RELINQUISHED', 'SUCCESSOR_PREPARED',
            'ROUTED', 'AUTHORIZED', 'ACCEPTED', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'
          )) DEFAULT 'REQUESTED',
          source_ownership_epoch INTEGER NOT NULL DEFAULT 1,
          successor_ownership_epoch INTEGER NULL,
          version INTEGER NOT NULL DEFAULT 1,
          frozen_at TEXT NULL,
          quiescing_at TEXT NULL,
          relinquished_at TEXT NULL,
          accepted_at TEXT NULL,
          completed_at TEXT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO handoff_transfers_new (
          id, request_id, task_id, source_attempt_id, successor_attempt_id,
          source_assignment_id, successor_assignment_id, successor_role_profile_id,
          successor_agent_profile_id, handoff_context_id, checkpoint_id,
          source_authorization_id, successor_authorization_id, reason, status,
          source_ownership_epoch, successor_ownership_epoch, version,
          frozen_at, quiescing_at, relinquished_at, accepted_at, completed_at,
          created_at, updated_at
        )
        SELECT
          id, request_id, task_id, source_attempt_id, successor_attempt_id,
          source_assignment_id, successor_assignment_id, successor_role_profile_id,
          successor_agent_profile_id, handoff_context_id, checkpoint_id,
          source_authorization_id, successor_authorization_id, reason, status,
          source_ownership_epoch, successor_ownership_epoch, version,
          frozen_at, quiescing_at, relinquished_at, accepted_at, completed_at,
          created_at, updated_at
        FROM handoff_transfers;

        DROP TABLE handoff_transfers;

        ALTER TABLE handoff_transfers_new RENAME TO handoff_transfers;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_active_handoff_transfer_source
          ON handoff_transfers(source_attempt_id)
          WHERE status IN ('REQUESTED', 'FROZEN', 'QUIESCING', 'RELINQUISHED', 'SUCCESSOR_PREPARED', 'ROUTED', 'AUTHORIZED', 'ACCEPTED')
             OR relinquished_at IS NOT NULL;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_transfers_successor_attempt
          ON handoff_transfers(successor_attempt_id)
          WHERE successor_attempt_id IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_handoff_transfers_task ON handoff_transfers(task_id);
        CREATE INDEX IF NOT EXISTS idx_handoff_transfers_status ON handoff_transfers(status);
      `);
    },
  },
  {
    version: 18,
    name: '018_r5i_successor_context_authority',
    up: (db: Database.Database) => {
      db.exec(`
        ALTER TABLE handoff_transfers
        ADD COLUMN successor_context_snapshot_id TEXT NULL REFERENCES context_snapshots(id) ON DELETE RESTRICT;

        ALTER TABLE handoff_transfers
        ADD COLUMN successor_context_spec_hash TEXT NULL;

        CREATE INDEX IF NOT EXISTS idx_handoff_transfers_context_snapshot
        ON handoff_transfers(successor_context_snapshot_id);
      `);
    },
  },
  {
    version: 19,
    name: '019_r5i_execution_authorization_assignment_and_unique_successor_auth',
    up: (db: Database.Database) => {
      db.exec(`
        ALTER TABLE execution_authorizations
        ADD COLUMN assignment_id TEXT NULL REFERENCES agent_assignments(id) ON DELETE RESTRICT;

        CREATE INDEX IF NOT EXISTS idx_exec_auth_assignment
        ON execution_authorizations(assignment_id);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_transfers_successor_auth
        ON handoff_transfers(successor_authorization_id)
        WHERE successor_authorization_id IS NOT NULL;
      `);
    },
  },
  {
    version: 20,
    name: '020_r5i_crash_recovery_and_execution_lifecycle_authority',
    up: (db: Database.Database) => {
      db.exec(`
        -- 1. Extend execution_authorizations with selected_account_id and lifecycle protocol fields
        ALTER TABLE execution_authorizations
        ADD COLUMN selected_account_id TEXT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT;

        ALTER TABLE execution_authorizations
        ADD COLUMN lifecycle_version INTEGER NULL CHECK (
          lifecycle_version IS NULL OR (
            lifecycle_version = 1 AND
            assignment_id IS NOT NULL AND
            selected_account_id IS NOT NULL AND
            task_ownership_epoch IS NOT NULL AND
            task_ownership_epoch > 0
          )
        );

        CREATE TRIGGER IF NOT EXISTS trg_exec_auth_lifecycle_default
        AFTER INSERT ON execution_authorizations
        FOR EACH ROW
        WHEN NEW.lifecycle_version IS NULL
          AND NEW.assignment_id IS NOT NULL
          AND NEW.selected_account_id IS NOT NULL
          AND NEW.task_ownership_epoch IS NOT NULL
          AND NEW.task_ownership_epoch > 0
        BEGIN
          UPDATE execution_authorizations
          SET lifecycle_version = 1
          WHERE id = NEW.id;
        END;

        ALTER TABLE execution_authorizations
        ADD COLUMN adapter_error_json TEXT NULL;

        ALTER TABLE execution_authorizations
        ADD COLUMN settlement_status TEXT NULL CHECK (settlement_status IS NULL OR settlement_status IN ('COMPLETED', 'FAILED', 'CANCELLED'));

        ALTER TABLE execution_authorizations
        ADD COLUMN termination_reason TEXT NULL CHECK (termination_reason IS NULL OR termination_reason IN (
          'EXECUTION_TIMEOUT',
          'EXECUTION_CANCELLED',
          'HEARTBEAT_TIMEOUT',
          'MANUAL_INTERVENTION'
        ));

        ALTER TABLE execution_authorizations
        ADD COLUMN termination_proof_source TEXT NULL CHECK (termination_proof_source IS NULL OR termination_proof_source IN (
          'LOCAL_PROCESS_EXIT',
          'PROVIDER_FINAL_ACK',
          'TIMEOUT_UNACKNOWLEDGED',
          'CANCEL_UNACKNOWLEDGED',
          'DISCONNECT_UNKNOWN'
        ));

        ALTER TABLE execution_authorizations
        ADD COLUMN termination_evidence_json TEXT NULL;

        ALTER TABLE execution_authorizations
        ADD COLUMN terminated_at TEXT NULL;

        -- Convert unprovable legacy migration-19 termination rows to clean unresolved state
        UPDATE execution_authorizations
        SET termination_status = 'UNRESOLVED',
            termination_confirmed_at = NULL,
            terminated_at = NULL,
            termination_proof_source = 'DISCONNECT_UNKNOWN'
        WHERE termination_status = 'CONFIRMED_TERMINATED'
          AND (
            termination_proof_source IS NULL OR
            termination_proof_source NOT IN ('LOCAL_PROCESS_EXIT', 'PROVIDER_FINAL_ACK')
          );

        UPDATE execution_authorizations
        SET termination_confirmed_at = NULL,
            terminated_at = NULL
        WHERE termination_status = 'UNRESOLVED'
          AND (termination_confirmed_at IS NOT NULL OR terminated_at IS NOT NULL);

        ALTER TABLE execution_authorizations
        ADD COLUMN termination_evidence_hash TEXT NULL CHECK (
          (
            termination_status IS NULL AND
            termination_source IS NULL AND
            termination_reason IS NULL AND
            termination_proof_source IS NULL AND
            termination_confirmed_at IS NULL AND
            terminated_at IS NULL AND
            termination_evidence_json IS NULL AND
            termination_evidence_hash IS NULL
          ) OR (
            termination_status = 'UNRESOLVED' AND
            termination_confirmed_at IS NULL AND
            terminated_at IS NULL AND
            (termination_proof_source IS NULL OR termination_proof_source IN ('TIMEOUT_UNACKNOWLEDGED', 'CANCEL_UNACKNOWLEDGED', 'DISCONNECT_UNKNOWN')) AND
            (
              (termination_evidence_json IS NULL AND termination_evidence_hash IS NULL) OR
              (termination_evidence_json IS NOT NULL AND termination_evidence_hash IS NOT NULL AND length(termination_evidence_hash) = 64 AND termination_evidence_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')
            )
          ) OR (
            termination_status = 'CONFIRMED_TERMINATED' AND
            termination_source IS NOT NULL AND
            termination_reason IS NOT NULL AND
            termination_proof_source IN ('LOCAL_PROCESS_EXIT', 'PROVIDER_FINAL_ACK') AND
            termination_confirmed_at IS NOT NULL AND
            terminated_at IS NOT NULL AND
            termination_evidence_json IS NOT NULL AND
            termination_evidence_hash IS NOT NULL AND
            length(termination_evidence_hash) = 64 AND
            termination_evidence_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          )
        );

        ALTER TABLE execution_authorizations
        ADD COLUMN settled_at TEXT NULL;

        ALTER TABLE execution_authorizations
        ADD COLUMN settlement_evidence_json TEXT NULL;

        ALTER TABLE execution_authorizations
        ADD COLUMN settlement_evidence_hash TEXT NULL CHECK (
          (settlement_status IS NULL AND settled_at IS NULL AND settlement_evidence_json IS NULL AND settlement_evidence_hash IS NULL) OR (
            settlement_status IS NOT NULL AND
            settled_at IS NOT NULL AND
            settlement_evidence_json IS NOT NULL AND
            settlement_evidence_hash IS NOT NULL AND
            length(settlement_evidence_hash) = 64 AND
            settlement_evidence_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          )
        );

        CREATE INDEX IF NOT EXISTS idx_exec_auth_lifecycle
        ON execution_authorizations(lifecycle_version);

        CREATE INDEX IF NOT EXISTS idx_exec_auth_settlement_status
        ON execution_authorizations(settlement_status);

        -- 2. Durable per-authorization recovery state ledger
        CREATE TABLE IF NOT EXISTS execution_recovery_states (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL UNIQUE REFERENCES execution_authorizations(id) ON DELETE RESTRICT,
          transfer_id TEXT NOT NULL REFERENCES handoff_transfers(id) ON DELETE RESTRICT,
          execution_id TEXT NULL,
          lifecycle_version INTEGER NULL CHECK (lifecycle_version IS NULL OR lifecycle_version = 1),
          recovery_classification TEXT NOT NULL CHECK (recovery_classification IN (
            'PRE_ADAPTER_NOT_STARTED',
            'ADAPTER_IN_FLIGHT_UNRESOLVED',
            'ADAPTER_TERMINATED_AFTER_TIMEOUT',
            'ADAPTER_FINISHED_RESULT_MISSING',
            'RESULT_PERSISTED_STATE_INCOMPLETE',
            'ALREADY_RECONCILED',
            'LEGACY_UNCLASSIFIABLE',
            'AUTHORITY_CONFLICT'
          )),
          disposition TEXT NOT NULL CHECK (disposition IN (
            'TERMINALIZED_SAFE_EXPIRED',
            'UNRESOLVED_FENCED',
            'TERMINALIZED_CONFIRMED_TIMEOUT',
            'TERMINALIZED_CONFIRMED_CANCELLED',
            'RESULT_MISSING_FENCED',
            'TERMINAL_STATE_RECONCILED',
            'NO_OP_ALREADY_RECONCILED',
            'LEGACY_UNRESOLVED_FENCED',
            'REJECTED_INTEGRITY_CONFLICT'
          )),
          canonical_evidence_json TEXT NOT NULL,
          evidence_hash TEXT NOT NULL CHECK (
            length(evidence_hash) = 64 AND
            evidence_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          recovery_version INTEGER NOT NULL DEFAULT 1 CHECK (recovery_version >= 1),
          mutated_terminal_state INTEGER NOT NULL DEFAULT 0 CHECK (mutated_terminal_state IN (0, 1)),
          mutated_resources INTEGER NOT NULL DEFAULT 0 CHECK (mutated_resources IN (0, 1)),
          first_detected_at TEXT NOT NULL,
          last_scanned_at TEXT NOT NULL,
          resolved_at TEXT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_exec_recovery_transfer
        ON execution_recovery_states(transfer_id);

        CREATE INDEX IF NOT EXISTS idx_exec_recovery_classification
        ON execution_recovery_states(recovery_classification);

        CREATE INDEX IF NOT EXISTS idx_exec_recovery_disposition
        ON execution_recovery_states(disposition);

        CREATE INDEX IF NOT EXISTS idx_exec_recovery_evidence_hash
        ON execution_recovery_states(evidence_hash);
      `);
    },
  },
  {
    version: 21,
    name: '021_r5j_mcp_client_session_authority',
    up: (db: Database.Database) => {
      db.exec(`
        CREATE TABLE mcp_client_sessions (
          id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL REFERENCES execution_authorizations(id) ON DELETE RESTRICT,
          scope TEXT NOT NULL CHECK (scope = 'AUTHORIZED_CONTEXT_READ'),
          token_hash TEXT NOT NULL CHECK (
            length(token_hash) = 64 AND
            token_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          authorization_fingerprint TEXT NOT NULL CHECK (
            length(authorization_fingerprint) = 64 AND
            authorization_fingerprint GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          issued_at TEXT NOT NULL CHECK (length(issued_at) > 0),
          expires_at TEXT NOT NULL CHECK (length(expires_at) > 0 AND expires_at > issued_at),
          revoked_at TEXT NULL CHECK (revoked_at IS NULL OR (length(revoked_at) > 0 AND revoked_at >= issued_at))
        );

        CREATE UNIQUE INDEX uq_mcp_client_sessions_active_auth
        ON mcp_client_sessions(authorization_id)
        WHERE revoked_at IS NULL;

        CREATE UNIQUE INDEX idx_mcp_client_sessions_token_hash
        ON mcp_client_sessions(token_hash);

        CREATE INDEX idx_mcp_client_sessions_expires_at
        ON mcp_client_sessions(expires_at);

        CREATE INDEX idx_mcp_client_sessions_auth_id
        ON mcp_client_sessions(authorization_id);
      `);
    },
  },
  {
    version: 22,
    name: '022_r5j_coder_submission_authority',
    up: (db: Database.Database) => {
      db.exec(`
        -- 1. MCP Submission Sessions Table
        CREATE TABLE mcp_submission_sessions (
          id TEXT PRIMARY KEY CHECK (
            length(id) = 36 AND
            id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          authorization_id TEXT NOT NULL REFERENCES execution_authorizations(id) ON DELETE RESTRICT,
          scope TEXT NOT NULL CHECK (scope = 'CODER_SUBMISSION'),
          issuer_identity TEXT NOT NULL CHECK (issuer_identity = 'OWNER_LOCAL_CLI'),
          token_hash TEXT NOT NULL CHECK (
            length(token_hash) = 64 AND
            token_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          authorization_fingerprint TEXT NOT NULL CHECK (
            length(authorization_fingerprint) = 64 AND
            authorization_fingerprint GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          issued_at TEXT NOT NULL CHECK (
            length(issued_at) = 24 AND
            issued_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
            unixepoch(issued_at) IS NOT NULL AND
            strftime('%Y-%m-%dT%H:%M:%fZ', issued_at) = issued_at
          ),
          expires_at TEXT NOT NULL CHECK (
            length(expires_at) = 24 AND
            expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
            unixepoch(expires_at) IS NOT NULL AND
            strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at AND
            (unixepoch(expires_at) - unixepoch(issued_at)) >= 300 AND
            (unixepoch(expires_at) - unixepoch(issued_at)) <= 86400
          ),
          revoked_at TEXT NULL,
          revocation_reason TEXT NULL,
          CHECK (
            (revoked_at IS NULL AND revocation_reason IS NULL) OR (
              revoked_at IS NOT NULL AND
              revocation_reason IS NOT NULL AND
              length(revoked_at) = 24 AND
              revoked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
              unixepoch(revoked_at) IS NOT NULL AND
              strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) = revoked_at AND
              unixepoch(revoked_at) >= unixepoch(issued_at) AND
              length(revocation_reason) >= 1 AND
              length(revocation_reason) <= 128
            )
          )
        );

        CREATE UNIQUE INDEX uq_mcp_submission_sessions_active_auth
        ON mcp_submission_sessions(authorization_id)
        WHERE revoked_at IS NULL;

        CREATE UNIQUE INDEX idx_mcp_submission_sessions_token_hash
        ON mcp_submission_sessions(token_hash);

        CREATE INDEX idx_mcp_submission_sessions_expires_at
        ON mcp_submission_sessions(expires_at);

        CREATE INDEX idx_mcp_submission_sessions_auth_id
        ON mcp_submission_sessions(authorization_id);

        CREATE TRIGGER trg_mcp_submission_sessions_no_delete
        BEFORE DELETE ON mcp_submission_sessions
        BEGIN
          SELECT RAISE(ABORT, 'MCP_SUBMISSION_SESSION_DELETE_FORBIDDEN');
        END;

        CREATE TRIGGER trg_mcp_submission_sessions_immutable_update
        BEFORE UPDATE ON mcp_submission_sessions
        BEGIN
          SELECT CASE
            WHEN OLD.revoked_at IS NOT NULL THEN
              RAISE(ABORT, 'MCP_SUBMISSION_SESSION_ALREADY_REVOKED')
            WHEN NEW.id != OLD.id
              OR NEW.authorization_id != OLD.authorization_id
              OR NEW.scope != OLD.scope
              OR NEW.issuer_identity != OLD.issuer_identity
              OR NEW.token_hash != OLD.token_hash
              OR NEW.authorization_fingerprint != OLD.authorization_fingerprint
              OR NEW.issued_at != OLD.issued_at
              OR NEW.expires_at != OLD.expires_at
              OR NEW.revoked_at IS NULL
              OR NEW.revocation_reason IS NULL THEN
              RAISE(ABORT, 'MCP_SUBMISSION_SESSION_MUTATION_FORBIDDEN')
          END;
        END;

        -- 2. Coder Submissions Quarantined Ledger Table
        CREATE TABLE coder_submissions (
          id TEXT PRIMARY KEY CHECK (
            length(id) = 36 AND
            id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          authorization_id TEXT NOT NULL REFERENCES execution_authorizations(id) ON DELETE RESTRICT,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
          task_ownership_epoch INTEGER NOT NULL CHECK (task_ownership_epoch >= 1),
          session_id TEXT NOT NULL REFERENCES mcp_submission_sessions(id) ON DELETE RESTRICT,
          lifecycle_version INTEGER NULL CHECK (lifecycle_version IS NULL OR lifecycle_version = 1),
          execution_id TEXT NULL,
          attempt_id TEXT NULL REFERENCES task_attempts(id) ON DELETE RESTRICT,
          assignment_id TEXT NULL REFERENCES agent_assignments(id) ON DELETE RESTRICT,
          selected_provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
          selected_account_id TEXT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
          selected_resource_id TEXT NOT NULL REFERENCES provider_resources(id) ON DELETE RESTRICT,
          manager_message_id TEXT NOT NULL,
          routing_decision_id TEXT NOT NULL,
          base_sha TEXT NOT NULL CHECK (
            length(base_sha) = 40 AND
            base_sha GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          authorized_head_sha TEXT NOT NULL CHECK (
            length(authorized_head_sha) = 40 AND
            authorized_head_sha GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          schema_version INTEGER NOT NULL CHECK (schema_version = 1),
          authorization_status TEXT NOT NULL CHECK (authorization_status = 'DISPATCHED'),
          dispatched_at TEXT NOT NULL CHECK (
            length(dispatched_at) = 24 AND
            dispatched_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
            unixepoch(dispatched_at) IS NOT NULL AND
            strftime('%Y-%m-%dT%H:%M:%fZ', dispatched_at) = dispatched_at
          ),
          authority_fingerprint TEXT NOT NULL CHECK (
            length(authority_fingerprint) = 64 AND
            authority_fingerprint GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          manager_payload_hash TEXT NOT NULL CHECK (
            length(manager_payload_hash) = 64 AND
            manager_payload_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          task_revision INTEGER NOT NULL CHECK (task_revision >= 0),
          claimed_status TEXT NOT NULL CHECK (claimed_status IN ('COMPLETED', 'IN_PROGRESS', 'BLOCKED', 'FAILED')),
          quarantine_status TEXT NOT NULL CHECK (quarantine_status = 'QUARANTINED'),
          summary TEXT NOT NULL CHECK (
            length(summary) >= 1 AND
            length(summary) <= 4096 AND
            length(trim(summary)) > 0
          ),
          changed_files_count INTEGER NOT NULL CHECK (changed_files_count >= 0 AND changed_files_count <= 1000),
          tests_claimed_count INTEGER NOT NULL CHECK (tests_claimed_count >= 0 AND tests_claimed_count <= 1000),
          blockers_count INTEGER NOT NULL CHECK (blockers_count >= 0 AND blockers_count <= 1000),
          review_requested INTEGER NOT NULL CHECK (review_requested IN (0, 1)),
          claim_content_hash TEXT NOT NULL CHECK (
            length(claim_content_hash) = 64 AND
            claim_content_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          canonical_envelope_hash TEXT NOT NULL CHECK (
            length(canonical_envelope_hash) = 64 AND
            canonical_envelope_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          claim_content_json TEXT NOT NULL CHECK (
            json_valid(claim_content_json) = 1 AND
            json_type(claim_content_json) = 'object'
          ),
          canonical_envelope_json TEXT NOT NULL CHECK (
            json_valid(canonical_envelope_json) = 1 AND
            json_type(canonical_envelope_json) = 'object'
          ),
          canonical_arguments_bytes INTEGER NOT NULL CHECK (
            canonical_arguments_bytes >= 1 AND
            canonical_arguments_bytes <= 65536
          ),
          submitted_at TEXT NOT NULL CHECK (
            length(submitted_at) = 24 AND
            submitted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
            unixepoch(submitted_at) IS NOT NULL AND
            strftime('%Y-%m-%dT%H:%M:%fZ', submitted_at) = submitted_at
          ),
          CHECK (
            (lifecycle_version IS NULL AND execution_id IS NULL AND attempt_id IS NULL AND assignment_id IS NULL AND selected_account_id IS NULL) OR (
              lifecycle_version = 1 AND
              execution_id IS NOT NULL AND
              attempt_id IS NOT NULL AND
              assignment_id IS NOT NULL AND
              selected_account_id IS NOT NULL
            )
          )
        );

        CREATE INDEX idx_coder_submissions_auth_id
        ON coder_submissions(authorization_id);

        CREATE INDEX idx_coder_submissions_task_id
        ON coder_submissions(task_id);

        CREATE INDEX idx_coder_submissions_session_id
        ON coder_submissions(session_id);

        CREATE INDEX idx_coder_submissions_content_hash
        ON coder_submissions(claim_content_hash);

        CREATE INDEX idx_coder_submissions_envelope_hash
        ON coder_submissions(canonical_envelope_hash);

        CREATE INDEX idx_coder_submissions_submitted_at
        ON coder_submissions(submitted_at);

        CREATE TRIGGER trg_coder_submissions_no_update
        BEFORE UPDATE ON coder_submissions
        BEGIN
          SELECT RAISE(ABORT, 'coder_submissions is strictly append-only: UPDATE is prohibited');
        END;

        CREATE TRIGGER trg_coder_submissions_no_delete
        BEFORE DELETE ON coder_submissions
        BEGIN
          SELECT RAISE(ABORT, 'coder_submissions is strictly append-only: DELETE is prohibited');
        END;

        -- 3. Coder Submission Dispositions Ledger Table
        CREATE TABLE coder_submission_dispositions (
          id TEXT PRIMARY KEY CHECK (
            length(id) = 36 AND
            id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          submission_id TEXT NOT NULL REFERENCES coder_submissions(id) ON DELETE RESTRICT,
          disposition_event TEXT NOT NULL,
          disposition_reason TEXT NOT NULL,
          actor_type TEXT NOT NULL CHECK (actor_type IN ('SYSTEM', 'MCP_CLIENT', 'OPERATOR')),
          actor_id TEXT NOT NULL CHECK (length(actor_id) >= 1 AND length(actor_id) <= 128),
          disposition_metadata_json TEXT NULL CHECK (
            disposition_metadata_json IS NULL OR (
              json_valid(disposition_metadata_json) = 1 AND
              json_type(disposition_metadata_json) = 'object'
            )
          ),
          created_at TEXT NOT NULL CHECK (
            length(created_at) = 24 AND
            created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
            unixepoch(created_at) IS NOT NULL AND
            strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
          ),
          CHECK (
            (disposition_event = 'SUBMITTED' AND disposition_reason = 'INITIAL_SUBMISSION') OR
            (disposition_event = 'REJECTED' AND disposition_reason IN ('INTEGRITY_MISMATCH', 'FENCED_PRECONDITION', 'COLLISION_CONFLICT')) OR
            (disposition_event = 'SETTLED' AND disposition_reason IN ('ACCEPTED_VERIFIED', 'SUPERSEDED_SUBMISSION', 'MANUAL_OVERRIDE'))
          )
        );

        CREATE INDEX idx_coder_submission_dispositions_submission
        ON coder_submission_dispositions(submission_id);

        CREATE INDEX idx_coder_submission_dispositions_event
        ON coder_submission_dispositions(disposition_event);

        CREATE INDEX idx_coder_submission_dispositions_created_at
        ON coder_submission_dispositions(created_at);

        CREATE TRIGGER trg_coder_submission_dispositions_no_update
        BEFORE UPDATE ON coder_submission_dispositions
        BEGIN
          SELECT RAISE(ABORT, 'coder_submission_dispositions is strictly append-only: UPDATE is prohibited');
        END;

        CREATE TRIGGER trg_coder_submission_dispositions_no_delete
        BEFORE DELETE ON coder_submission_dispositions
        BEGIN
          SELECT RAISE(ABORT, 'coder_submission_dispositions is strictly append-only: DELETE is prohibited');
        END;
      `);
    },
  },
  {
    version: 23,
    name: '023_r5j_quarantined_submission_adjudication_and_verification_admission',
    up: (db: Database.Database) => {
      db.exec(`
        -- 1. Coder Submission Adjudications Table
        CREATE TABLE coder_submission_adjudications (
          id TEXT PRIMARY KEY CHECK (
            length(id) = 36 AND
            id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          request_id TEXT NOT NULL UNIQUE CHECK (
            length(request_id) = 36 AND
            request_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          submission_id TEXT NOT NULL REFERENCES coder_submissions(id) ON DELETE RESTRICT,
          authorization_id TEXT NOT NULL REFERENCES execution_authorizations(id) ON DELETE RESTRICT,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
          attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE RESTRICT,
          assignment_id TEXT NOT NULL REFERENCES agent_assignments(id) ON DELETE RESTRICT,
          task_ownership_epoch INTEGER NOT NULL CHECK (task_ownership_epoch > 0),
          action TEXT NOT NULL CHECK (action IN ('ADMIT_VERIFICATION', 'REJECT', 'SUPERSEDE')),
          status TEXT NOT NULL CHECK (status IN ('ADMITTED', 'VERIFYING', 'VERIFIED', 'VERIFICATION_FAILED', 'RECOVERY_FENCED', 'REJECTED', 'SUPERSEDED')),
          lifecycle_version INTEGER NOT NULL CHECK (lifecycle_version >= 1),
          authority_snapshot_json TEXT NOT NULL CHECK (
            json_valid(authority_snapshot_json) = 1 AND
            json_type(authority_snapshot_json) = 'object'
          ),
          authority_snapshot_hash TEXT NOT NULL CHECK (
            length(authority_snapshot_hash) = 64 AND
            authority_snapshot_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          verification_commands_json TEXT NULL CHECK (
            verification_commands_json IS NULL OR (
              json_valid(verification_commands_json) = 1 AND
              json_type(verification_commands_json) = 'object'
            )
          ),
          verification_commands_hash TEXT NULL CHECK (
            verification_commands_hash IS NULL OR (
              length(verification_commands_hash) = 64 AND
              verification_commands_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
            )
          ),
          workspace_snapshot_before_json TEXT NULL CHECK (
            workspace_snapshot_before_json IS NULL OR (
              json_valid(workspace_snapshot_before_json) = 1 AND
              json_type(workspace_snapshot_before_json) = 'object'
            )
          ),
          workspace_snapshot_before_hash TEXT NULL CHECK (
            workspace_snapshot_before_hash IS NULL OR (
              length(workspace_snapshot_before_hash) = 64 AND
              workspace_snapshot_before_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
            )
          ),
          verification_result_envelope_json TEXT NULL CHECK (
            verification_result_envelope_json IS NULL OR (
              json_valid(verification_result_envelope_json) = 1 AND
              json_type(verification_result_envelope_json) = 'object'
            )
          ),
          verification_result_envelope_hash TEXT NULL CHECK (
            verification_result_envelope_hash IS NULL OR (
              length(verification_result_envelope_hash) = 64 AND
              verification_result_envelope_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
            )
          ),
          verification_execution_id TEXT NULL,
          protocol_message_id TEXT NULL REFERENCES protocol_messages(id) ON DELETE SET NULL,
          test_run_id TEXT NULL REFERENCES test_runs(id) ON DELETE SET NULL,
          git_status_evidence_id TEXT NULL REFERENCES evidence(id) ON DELETE SET NULL,
          git_diff_evidence_id TEXT NULL REFERENCES evidence(id) ON DELETE SET NULL,
          failure_code TEXT NULL,
          failure_json TEXT NULL CHECK (
            failure_json IS NULL OR (
              json_valid(failure_json) = 1 AND
              json_type(failure_json) = 'object'
            )
          ),
          created_at TEXT NOT NULL CHECK (
            length(created_at) = 24 AND
            created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
            unixepoch(created_at) IS NOT NULL AND
            strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
          ),
          verification_started_at TEXT NULL CHECK (
            verification_started_at IS NULL OR (
              length(verification_started_at) = 24 AND
              verification_started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
              unixepoch(verification_started_at) IS NOT NULL AND
              strftime('%Y-%m-%dT%H:%M:%fZ', verification_started_at) = verification_started_at AND
              verification_started_at >= created_at
            )
          ),
          completed_at TEXT NULL CHECK (
            completed_at IS NULL OR (
              length(completed_at) = 24 AND
              completed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
              unixepoch(completed_at) IS NOT NULL AND
              strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at AND
              completed_at >= created_at
            )
          ),
          recovery_fenced_at TEXT NULL CHECK (
            recovery_fenced_at IS NULL OR (
              length(recovery_fenced_at) = 24 AND
              recovery_fenced_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
              unixepoch(recovery_fenced_at) IS NOT NULL AND
              strftime('%Y-%m-%dT%H:%M:%fZ', recovery_fenced_at) = recovery_fenced_at AND
              recovery_fenced_at >= created_at
            )
          ),
          resolution_action TEXT NULL CHECK (resolution_action IS NULL OR resolution_action IN ('ACKNOWLEDGE', 'CANCEL')),
          resolution_timestamp TEXT NULL CHECK (
            resolution_timestamp IS NULL OR (
              length(resolution_timestamp) = 24 AND
              resolution_timestamp GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
              unixepoch(resolution_timestamp) IS NOT NULL AND
              strftime('%Y-%m-%dT%H:%M:%fZ', resolution_timestamp) = resolution_timestamp AND
              resolution_timestamp >= created_at
            )
          ),
          resolution_evidence_json TEXT NULL CHECK (
            resolution_evidence_json IS NULL OR (
              json_valid(resolution_evidence_json) = 1 AND
              json_type(resolution_evidence_json) = 'object'
            )
          ),
          resolution_evidence_hash TEXT NULL CHECK (
            resolution_evidence_hash IS NULL OR (
              length(resolution_evidence_hash) = 64 AND
              resolution_evidence_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
            )
          ),
          resolver_id TEXT NULL,
          artifact_manifest_json TEXT NULL CHECK (
            artifact_manifest_json IS NULL OR (
              json_valid(artifact_manifest_json) = 1 AND
              json_type(artifact_manifest_json) = 'object'
            )
          ),
          artifact_manifest_hash TEXT NULL CHECK (
            artifact_manifest_hash IS NULL OR (
              length(artifact_manifest_hash) = 64 AND
              artifact_manifest_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
            )
          ),
          workspace_lease_id TEXT NULL REFERENCES coder_submission_workspace_leases(id) ON DELETE SET NULL,
          CHECK (
            (action = 'ADMIT_VERIFICATION' AND verification_commands_json IS NOT NULL AND verification_commands_hash IS NOT NULL) OR
            (action IN ('REJECT', 'SUPERSEDE') AND verification_commands_json IS NULL AND verification_commands_hash IS NULL)
          ),
          CHECK (
            (status = 'ADMITTED' AND verification_started_at IS NULL AND completed_at IS NULL AND recovery_fenced_at IS NULL AND verification_execution_id IS NULL) OR
            (status = 'VERIFYING' AND verification_started_at IS NOT NULL AND completed_at IS NULL AND recovery_fenced_at IS NULL AND verification_execution_id IS NOT NULL AND workspace_snapshot_before_json IS NOT NULL AND workspace_snapshot_before_hash IS NOT NULL) OR
            (status = 'VERIFIED' AND verification_started_at IS NOT NULL AND completed_at IS NOT NULL AND recovery_fenced_at IS NULL AND test_run_id IS NOT NULL AND git_status_evidence_id IS NOT NULL AND git_diff_evidence_id IS NOT NULL AND verification_result_envelope_json IS NOT NULL AND verification_result_envelope_hash IS NOT NULL AND artifact_manifest_json IS NOT NULL AND artifact_manifest_hash IS NOT NULL) OR
            (status = 'VERIFICATION_FAILED' AND completed_at IS NOT NULL AND failure_code IS NOT NULL) OR
            (status = 'RECOVERY_FENCED' AND recovery_fenced_at IS NOT NULL AND failure_code IS NOT NULL) OR
            (status IN ('REJECTED', 'SUPERSEDED') AND completed_at IS NOT NULL AND recovery_fenced_at IS NULL)
          )
        );

        CREATE INDEX idx_coder_submission_adjudications_submission
        ON coder_submission_adjudications(submission_id);

        CREATE INDEX idx_coder_submission_adjudications_task
        ON coder_submission_adjudications(task_id);

        CREATE INDEX idx_coder_submission_adjudications_auth
        ON coder_submission_adjudications(authorization_id);

        CREATE INDEX idx_coder_submission_adjudications_status
        ON coder_submission_adjudications(status);

        CREATE UNIQUE INDEX idx_coder_submission_adjudications_active
        ON coder_submission_adjudications(submission_id)
        WHERE status IN ('ADMITTED', 'VERIFYING', 'RECOVERY_FENCED');

        CREATE TRIGGER trg_coder_submission_adjudications_no_delete
        BEFORE DELETE ON coder_submission_adjudications
        BEGIN
          SELECT RAISE(ABORT, 'coder_submission_adjudications is strictly append-only: DELETE is prohibited');
        END;

        CREATE TRIGGER trg_coder_submission_adjudications_lifecycle_cas
        BEFORE UPDATE ON coder_submission_adjudications
        BEGIN
          SELECT CASE
            WHEN NEW.lifecycle_version != OLD.lifecycle_version + 1
            THEN RAISE(ABORT, 'Adjudication lifecycle_version must increment by exactly 1')
            WHEN NOT (
              (OLD.status = 'ADMITTED' AND NEW.status IN ('VERIFYING', 'RECOVERY_FENCED')) OR
              (OLD.status = 'VERIFYING' AND NEW.status IN ('VERIFIED', 'VERIFICATION_FAILED', 'RECOVERY_FENCED')) OR
              (OLD.status = 'VERIFIED' AND NEW.status = 'RECOVERY_FENCED') OR
              (OLD.status = 'VERIFICATION_FAILED' AND NEW.status = 'RECOVERY_FENCED') OR
              (OLD.status = 'RECOVERY_FENCED' AND NEW.status IN ('VERIFICATION_FAILED', 'RECOVERY_FENCED'))
            )
            THEN RAISE(ABORT, 'Invalid adjudication lifecycle status transition')
          END;
        END;

        CREATE TRIGGER trg_coder_submission_adjudications_immutable_fields
        BEFORE UPDATE ON coder_submission_adjudications
        BEGIN
          SELECT CASE
            WHEN OLD.id != NEW.id OR
                 OLD.request_id != NEW.request_id OR
                 OLD.submission_id != NEW.submission_id OR
                 OLD.authorization_id != NEW.authorization_id OR
                 OLD.project_id != NEW.project_id OR
                 OLD.task_id != NEW.task_id OR
                 OLD.attempt_id != NEW.attempt_id OR
                 OLD.assignment_id != NEW.assignment_id OR
                 OLD.task_ownership_epoch != NEW.task_ownership_epoch OR
                 OLD.action != NEW.action OR
                 OLD.authority_snapshot_json != NEW.authority_snapshot_json OR
                 OLD.authority_snapshot_hash != NEW.authority_snapshot_hash OR
                 OLD.created_at != NEW.created_at
            THEN RAISE(ABORT, 'coder_submission_adjudications immutable decision and binding fields cannot be updated')
            WHEN (OLD.verification_execution_id IS NOT NULL AND (NEW.verification_execution_id IS NULL OR NEW.verification_execution_id != OLD.verification_execution_id)) OR
                 (OLD.verification_started_at IS NOT NULL AND (NEW.verification_started_at IS NULL OR NEW.verification_started_at != OLD.verification_started_at)) OR
                 (OLD.recovery_fenced_at IS NOT NULL AND (NEW.recovery_fenced_at IS NULL OR NEW.recovery_fenced_at != OLD.recovery_fenced_at))
            THEN RAISE(ABORT, 'coder_submission_adjudications execution and fence markers cannot be altered or cleared once set')
            WHEN (OLD.resolution_action IS NOT NULL AND (NEW.resolution_action IS NULL OR NEW.resolution_action != OLD.resolution_action)) OR
                 (OLD.resolution_timestamp IS NOT NULL AND (NEW.resolution_timestamp IS NULL OR NEW.resolution_timestamp != OLD.resolution_timestamp))
            THEN RAISE(ABORT, 'coder_submission_adjudications resolution records cannot be altered or cleared once set')
            WHEN (OLD.artifact_manifest_hash IS NOT NULL AND (NEW.artifact_manifest_hash IS NULL OR NEW.artifact_manifest_hash != OLD.artifact_manifest_hash)) OR
                 (OLD.artifact_manifest_json IS NOT NULL AND (NEW.artifact_manifest_json IS NULL OR NEW.artifact_manifest_json != OLD.artifact_manifest_json))
            THEN RAISE(ABORT, 'coder_submission_adjudications artifact manifest cannot be altered or cleared once set')
          END;
        END;

        -- 2. Coder Submission Workspace Leases Table
        CREATE TABLE coder_submission_workspace_leases (
          id TEXT PRIMARY KEY CHECK (
            length(id) = 36 AND
            id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          adjudication_id TEXT NOT NULL REFERENCES coder_submission_adjudications(id) ON DELETE RESTRICT,
          worktree_identity_hash TEXT NOT NULL CHECK (
            length(worktree_identity_hash) = 64 AND
            worktree_identity_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          admitted_workspace_fingerprint_hash TEXT NOT NULL CHECK (
            length(admitted_workspace_fingerprint_hash) = 64 AND
            admitted_workspace_fingerprint_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          pre_execution_fingerprint_hash TEXT NULL CHECK (
            pre_execution_fingerprint_hash IS NULL OR (
              length(pre_execution_fingerprint_hash) = 64 AND
              pre_execution_fingerprint_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
            )
          ),
          claim_nonce TEXT NOT NULL CHECK (length(claim_nonce) >= 16),
          execution_id TEXT NOT NULL CHECK (length(execution_id) >= 1),
          lease_owner_identity TEXT NOT NULL CHECK (length(lease_owner_identity) >= 1),
          assignment_id TEXT NOT NULL REFERENCES agent_assignments(id) ON DELETE RESTRICT,
          authorization_id TEXT NOT NULL REFERENCES execution_authorizations(id) ON DELETE RESTRICT,
          acquired_at TEXT NOT NULL CHECK (
            length(acquired_at) = 24 AND
            acquired_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
            unixepoch(acquired_at) IS NOT NULL AND
            strftime('%Y-%m-%dT%H:%M:%fZ', acquired_at) = acquired_at
          ),
          released_at TEXT NULL CHECK (
            released_at IS NULL OR (
              length(released_at) = 24 AND
              released_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
              unixepoch(released_at) IS NOT NULL AND
              strftime('%Y-%m-%dT%H:%M:%fZ', released_at) = released_at AND
              released_at >= acquired_at
            )
          ),
          lifecycle_version INTEGER NOT NULL CHECK (lifecycle_version >= 1),
          state TEXT NOT NULL CHECK (state IN ('ACQUIRED', 'VERIFYING', 'RELEASED', 'FENCED')),
          failure_code TEXT NULL,
          failure_evidence_hash TEXT NULL CHECK (
            failure_evidence_hash IS NULL OR (
              length(failure_evidence_hash) = 64 AND
              failure_evidence_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
            )
          ),
          CHECK (
            (state = 'ACQUIRED' AND pre_execution_fingerprint_hash IS NULL AND released_at IS NULL) OR
            (state = 'VERIFYING' AND pre_execution_fingerprint_hash IS NOT NULL AND released_at IS NULL) OR
            (state = 'RELEASED' AND released_at IS NOT NULL) OR
            (state = 'FENCED' AND failure_code IS NOT NULL)
          )
        );

        CREATE UNIQUE INDEX idx_coder_submission_workspace_leases_active
        ON coder_submission_workspace_leases(worktree_identity_hash)
        WHERE state IN ('ACQUIRED', 'VERIFYING');

        CREATE INDEX idx_coder_submission_workspace_leases_adj
        ON coder_submission_workspace_leases(adjudication_id);

        CREATE INDEX idx_coder_submission_workspace_leases_state
        ON coder_submission_workspace_leases(state);

        CREATE TRIGGER trg_coder_submission_workspace_leases_no_delete
        BEFORE DELETE ON coder_submission_workspace_leases
        BEGIN
          SELECT RAISE(ABORT, 'coder_submission_workspace_leases is strictly append-only: DELETE is prohibited');
        END;

        CREATE TRIGGER trg_coder_submission_workspace_leases_immutable
        BEFORE UPDATE ON coder_submission_workspace_leases
        BEGIN
          SELECT CASE
            WHEN OLD.id != NEW.id OR
                 OLD.adjudication_id != NEW.adjudication_id OR
                 OLD.worktree_identity_hash != NEW.worktree_identity_hash OR
                 OLD.admitted_workspace_fingerprint_hash != NEW.admitted_workspace_fingerprint_hash OR
                 OLD.claim_nonce != NEW.claim_nonce OR
                 OLD.execution_id != NEW.execution_id OR
                 OLD.lease_owner_identity != NEW.lease_owner_identity OR
                 OLD.assignment_id != NEW.assignment_id OR
                 OLD.authorization_id != NEW.authorization_id OR
                 OLD.acquired_at != NEW.acquired_at
            THEN RAISE(ABORT, 'coder_submission_workspace_leases immutable claim and binding fields cannot be updated')
            WHEN NEW.lifecycle_version != OLD.lifecycle_version + 1
            THEN RAISE(ABORT, 'coder_submission_workspace_leases lifecycle_version must increment by exactly 1')
          END;
        END;

        -- 3. Coder Submission Adjudication Events Table (Append-Only)
        CREATE TABLE coder_submission_adjudication_events (
          id TEXT PRIMARY KEY CHECK (
            length(id) = 36 AND
            id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          adjudication_id TEXT NOT NULL REFERENCES coder_submission_adjudications(id) ON DELETE RESTRICT,
          sequence INTEGER NOT NULL CHECK (sequence >= 1),
          event_type TEXT NOT NULL CHECK (event_type IN ('ADMITTED', 'VERIFICATION_CLAIMED', 'VERIFICATION_SUCCEEDED', 'VERIFICATION_FAILED', 'RECOVERY_FENCED', 'REJECTED', 'SUPERSEDED')),
          payload_json TEXT NOT NULL CHECK (
            json_valid(payload_json) = 1 AND
            json_type(payload_json) = 'object'
          ),
          payload_hash TEXT NOT NULL CHECK (
            length(payload_hash) = 64 AND
            payload_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ),
          created_at TEXT NOT NULL CHECK (
            length(created_at) = 24 AND
            created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND
            unixepoch(created_at) IS NOT NULL AND
            strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
          ),
          UNIQUE (adjudication_id, sequence)
        );

        CREATE INDEX idx_coder_submission_adjudication_events_adj
        ON coder_submission_adjudication_events(adjudication_id);

        CREATE INDEX idx_coder_submission_adjudication_events_type
        ON coder_submission_adjudication_events(event_type);

        CREATE TRIGGER trg_coder_submission_adjudication_events_no_update
        BEFORE UPDATE ON coder_submission_adjudication_events
        BEGIN
          SELECT RAISE(ABORT, 'coder_submission_adjudication_events is strictly append-only: UPDATE is prohibited');
        END;

        CREATE TRIGGER trg_coder_submission_adjudication_events_no_delete
        BEFORE DELETE ON coder_submission_adjudication_events
        BEGIN
          SELECT RAISE(ABORT, 'coder_submission_adjudication_events is strictly append-only: DELETE is prohibited');
        END;
      `);
    },
  },
];

export const MIGRATIONS: readonly Migration[] = ALL_MIGRATIONS_LIST;

export function verifyMigration21SchemaAuthority(db: Database.Database): void {
  // 1. Exact ledger table and version 21 row existence
  const ledgerTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { name: string } | undefined;
  if (!ledgerTable) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Database is missing Migration 21 ledger authority (021_r5j_mcp_client_session_authority)');
  }

  const v21Row = db
    .prepare("SELECT version, name FROM schema_migrations WHERE version = 21 AND name = '021_r5j_mcp_client_session_authority'")
    .get() as { version: number; name: string } | undefined;
  if (!v21Row) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Database is missing Migration 21 ledger authority (021_r5j_mcp_client_session_authority)');
  }

  // 2. Table existence
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mcp_client_sessions'")
    .get() as { name: string } | undefined;
  if (!table) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions is missing');
  }

  // 3. Exactly eight required columns, PK, notnull, type
  const columns = db.prepare("PRAGMA table_info(mcp_client_sessions)").all() as {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  if (columns.length !== 8) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions missing column authority: expected exactly 8 columns (found ${columns.length})`);
  }
  const colMap = new Map(columns.map((c) => [c.name, c]));

  const requiredCols: Array<{ name: string; type: string; notnull: number; pk: number }> = [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'authorization_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'scope', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'token_hash', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'authorization_fingerprint', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'issued_at', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'expires_at', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'revoked_at', type: 'TEXT', notnull: 0, pk: 0 },
  ];

  for (let i = 0; i < requiredCols.length; i++) {
    const req = requiredCols[i];
    const col = colMap.get(req.name);
    if (!col) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions missing column "${req.name}"`);
    }
    if (col.type !== req.type) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" has unexpected type "${col.type}" (expected "${req.type}")`);
    }
    if (col.pk !== req.pk) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" pk authority mismatch (expected ${req.pk}, got ${col.pk})`);
    }
    if (col.notnull !== req.notnull) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" notnull authority mismatch (expected ${req.notnull}, got ${col.notnull})`);
    }
    if (col.cid !== i) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" cid order authority mismatch (expected ${i}, got ${col.cid})`);
    }
  }

  // 4. Foreign key on authorization_id -> execution_authorizations(id) with RESTRICT
  const fks = db.prepare("PRAGMA foreign_key_list(mcp_client_sessions)").all() as {
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
    match: string;
  }[];
  if (fks.length !== 1) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions must have exactly 1 foreign key (found ${fks.length})`);
  }
  const authFk = fks[0];
  if (
    authFk.table !== 'execution_authorizations' ||
    authFk.from !== 'authorization_id' ||
    authFk.to !== 'id' ||
    authFk.on_delete !== 'RESTRICT' ||
    authFk.on_update !== 'NO ACTION' ||
    authFk.match !== 'NONE'
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions foreign key authority mismatch on authorization_id -> execution_authorizations(id)');
  }

  // 5. Indexes verification via PRAGMA index_list, index_xinfo, and sqlite_master
  const indexes = db.prepare("PRAGMA index_list(mcp_client_sessions)").all() as {
    seq: number;
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }[];

  // Must have exactly 5 indexes total: exactly 4 user-defined ('c') + exactly 1 primary key ('pk')
  // Reject every origin-u autoindex and every extra index.
  if (indexes.length !== 5) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions must have exactly 5 indexes (found ${indexes.length})`);
  }

  const userDefinedIndexes = indexes.filter((idx) => idx.origin === 'c');
  if (userDefinedIndexes.length !== 4) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions must have exactly 4 user-defined indexes (found ${userDefinedIndexes.length})`);
  }

  const pkIndexes = indexes.filter((idx) => idx.origin === 'pk');
  if (pkIndexes.length !== 1) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions must have exactly 1 primary-key index (found ${pkIndexes.length})`);
  }

  const originUIndexes = indexes.filter((idx) => idx.origin === 'u');
  if (originUIndexes.length > 0) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions contains forbidden origin-u autoindex: ${originUIndexes[0].name}`);
  }

  const unexpectedOrigin = indexes.filter((idx) => idx.origin !== 'c' && idx.origin !== 'pk');
  if (unexpectedOrigin.length > 0) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions contains unexpected index origin: ${unexpectedOrigin[0].origin}`);
  }

  const expectedIndexNames = new Set([
    'uq_mcp_client_sessions_active_auth',
    'idx_mcp_client_sessions_token_hash',
    'idx_mcp_client_sessions_expires_at',
    'idx_mcp_client_sessions_auth_id',
  ]);

  for (const idx of userDefinedIndexes) {
    if (!expectedIndexNames.has(idx.name)) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions contains unexpected user-defined index "${idx.name}"`);
    }
  }

  const idxMap = new Map(indexes.map((idx) => [idx.name, idx]));

  interface XInfoRow {
    seqno: number;
    cid: number;
    name: string | null;
    desc: number;
    coll: string;
    key: number;
  }

  // 5.0 Implicit primary-key index verification via PRAGMA index_xinfo
  const pkIdxName = pkIndexes[0].name;
  const pkXInfo = db.prepare(`PRAGMA index_xinfo('${pkIdxName}')`).all() as XInfoRow[];
  const pkKeyCols = pkXInfo.filter((r) => r.key === 1);
  if (
    pkKeyCols.length !== 1 ||
    pkKeyCols[0].name !== 'id' ||
    pkKeyCols[0].coll !== 'BINARY' ||
    pkKeyCols[0].desc !== 0
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Primary key index on mcp_client_sessions must index exactly [id] ascending with BINARY collation and no extra key expression');
  }

  // 5.1 uq_mcp_client_sessions_active_auth
  const activeAuthIdx = idxMap.get('uq_mcp_client_sessions_active_auth');
  if (!activeAuthIdx || activeAuthIdx.unique !== 1 || activeAuthIdx.partial !== 1) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions missing unique partial index uq_mcp_client_sessions_active_auth');
  }
  const activeAuthXInfo = db.prepare("PRAGMA index_xinfo('uq_mcp_client_sessions_active_auth')").all() as XInfoRow[];
  const activeAuthKeyCols = activeAuthXInfo.filter((r) => r.key === 1);
  if (
    activeAuthKeyCols.length !== 1 ||
    activeAuthKeyCols[0].name !== 'authorization_id' ||
    activeAuthKeyCols[0].coll !== 'BINARY' ||
    activeAuthKeyCols[0].desc !== 0
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Index uq_mcp_client_sessions_active_auth must index exactly [authorization_id] with BINARY collation');
  }
  const activeAuthSqlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'uq_mcp_client_sessions_active_auth'")
    .get() as { sql: string } | undefined;
  const activeAuthSql = (activeAuthSqlRow?.sql ?? '').replace(/\s+/g, ' ').trim();
  if (!/WHERE\s+revoked_at\s+IS\s+NULL$/i.test(activeAuthSql) || /WHERE.*(?:OR|AND).*revoked_at\s+IS\s+NULL/i.test(activeAuthSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Index uq_mcp_client_sessions_active_auth must have exact partial predicate WHERE revoked_at IS NULL');
  }

  // 5.2 idx_mcp_client_sessions_token_hash
  const tokenHashIdx = idxMap.get('idx_mcp_client_sessions_token_hash');
  if (!tokenHashIdx || tokenHashIdx.unique !== 1 || tokenHashIdx.partial !== 0) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions missing unique index idx_mcp_client_sessions_token_hash');
  }
  const tokenHashXInfo = db.prepare("PRAGMA index_xinfo('idx_mcp_client_sessions_token_hash')").all() as XInfoRow[];
  const tokenHashKeyCols = tokenHashXInfo.filter((r) => r.key === 1);
  if (
    tokenHashKeyCols.length !== 1 ||
    tokenHashKeyCols[0].name !== 'token_hash' ||
    tokenHashKeyCols[0].coll !== 'BINARY' ||
    tokenHashKeyCols[0].desc !== 0
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Index idx_mcp_client_sessions_token_hash must index exactly [token_hash] with BINARY collation');
  }

  // 5.3 idx_mcp_client_sessions_expires_at
  const expiresAtIdx = idxMap.get('idx_mcp_client_sessions_expires_at');
  if (!expiresAtIdx || expiresAtIdx.unique !== 0 || expiresAtIdx.partial !== 0) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions missing index idx_mcp_client_sessions_expires_at');
  }
  const expiresAtXInfo = db.prepare("PRAGMA index_xinfo('idx_mcp_client_sessions_expires_at')").all() as XInfoRow[];
  const expiresAtKeyCols = expiresAtXInfo.filter((r) => r.key === 1);
  if (
    expiresAtKeyCols.length !== 1 ||
    expiresAtKeyCols[0].name !== 'expires_at' ||
    expiresAtKeyCols[0].coll !== 'BINARY' ||
    expiresAtKeyCols[0].desc !== 0
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Index idx_mcp_client_sessions_expires_at must index exactly [expires_at] with BINARY collation');
  }

  // 5.4 idx_mcp_client_sessions_auth_id
  const authIdIdx = idxMap.get('idx_mcp_client_sessions_auth_id');
  if (!authIdIdx || authIdIdx.unique !== 0 || authIdIdx.partial !== 0) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions missing index idx_mcp_client_sessions_auth_id');
  }
  const authIdXInfo = db.prepare("PRAGMA index_xinfo('idx_mcp_client_sessions_auth_id')").all() as XInfoRow[];
  const authIdKeyCols = authIdXInfo.filter((r) => r.key === 1);
  if (
    authIdKeyCols.length !== 1 ||
    authIdKeyCols[0].name !== 'authorization_id' ||
    authIdKeyCols[0].coll !== 'BINARY' ||
    authIdKeyCols[0].desc !== 0
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Index idx_mcp_client_sessions_auth_id must index exactly [authorization_id] with BINARY collation');
  }

  // 6. CHECK constraints in table sql (must be exactly 6 canonical constraints)
  const tableSqlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mcp_client_sessions'")
    .get() as { sql: string } | undefined;
  const sql = (tableSqlRow?.sql ?? '').replace(/\s+/g, ' ');

  const checkMatches = sql.match(/\bCHECK\s*\(/gi);
  if (!checkMatches || checkMatches.length !== 6) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions must contain exactly 6 CHECK constraints (found ${checkMatches?.length ?? 0})`);
  }

  if (!/CHECK\s*\(\s*scope\s*=\s*'AUTHORIZED_CONTEXT_READ'\s*\)/i.test(sql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions missing scope CHECK constraint');
  }
  if (!/CHECK\s*\(\s*length\(token_hash\)\s*=\s*64\s+AND\s+token_hash\s+GLOB\s+'(\[0-9a-f\]){64}'\s*\)/i.test(sql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions missing token_hash CHECK constraint');
  }
  if (!/CHECK\s*\(\s*length\(authorization_fingerprint\)\s*=\s*64\s+AND\s+authorization_fingerprint\s+GLOB\s+'(\[0-9a-f\]){64}'\s*\)/i.test(sql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions missing authorization_fingerprint CHECK constraint');
  }
  if (!/CHECK\s*\(\s*length\(issued_at\)\s*>\s*0\s*\)/i.test(sql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions missing issued_at CHECK constraint');
  }
  if (!/CHECK\s*\(\s*length\(expires_at\)\s*>\s*0\s+AND\s+expires_at\s*>\s*issued_at\s*\)/i.test(sql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions missing expires_at CHECK constraint');
  }
  if (!/CHECK\s*\(\s*revoked_at\s+IS\s+NULL\s+OR\s+\(\s*length\(revoked_at\)\s*>\s*0\s+AND\s+revoked_at\s*>=\s*issued_at\s*\)\s*\)/i.test(sql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions missing revoked_at CHECK constraint');
  }

  // 7. Contiguous, unique migration ledger 1..21 whose names match MIGRATIONS
  const ledgerRows = db
    .prepare('SELECT version, name FROM schema_migrations ORDER BY version ASC')
    .all() as { version: number; name: string }[];

  if (ledgerRows.length !== 21) {
    const isCanonical22 = ledgerRows.length === 22 && ledgerRows[21]?.version === 22 && ledgerRows[21]?.name === '022_r5j_coder_submission_authority';
    const isCanonical23 = ledgerRows.length === 23 && ledgerRows[21]?.version === 22 && ledgerRows[21]?.name === '022_r5j_coder_submission_authority' && ledgerRows[22]?.version === 23 && ledgerRows[22]?.name === '023_r5j_quarantined_submission_adjudication_and_verification_admission';
    if (!isCanonical22 && !isCanonical23) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Database schema migrations ledger must contain exactly 21 migrations (found ${ledgerRows.length})`);
    }
  }

  const checkCount = Math.min(ledgerRows.length, 21);
  for (let i = 0; i < checkCount; i++) {
    const expectedVersion = i + 1;
    const expectedMigration = MIGRATIONS[i];
    if (ledgerRows[i].version !== expectedVersion) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Database schema ledger is not contiguous: expected version ${expectedVersion}, got ${ledgerRows[i].version}`);
    }
    if (ledgerRows[i].name !== expectedMigration.name) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Database schema ledger migration name mismatch at version ${expectedVersion}: expected "${expectedMigration.name}", got "${ledgerRows[i].name}"`);
    }
  }
}

export function verifyMigration22SchemaAuthority(db: Database.Database): void {
  // 1. Exact ledger table and version 22 row existence
  const ledgerTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { name: string } | undefined;
  if (!ledgerTable) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Database is missing Migration 22 ledger authority (022_r5j_coder_submission_authority)');
  }

  const v22Row = db
    .prepare("SELECT version, name FROM schema_migrations WHERE version = 22 AND name = '022_r5j_coder_submission_authority'")
    .get() as { version: number; name: string } | undefined;
  if (!v22Row) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Database is missing Migration 22 ledger authority (022_r5j_coder_submission_authority)');
  }

  // Contiguous, unique migration ledger 1..22 whose names match MIGRATIONS
  const ledgerRows = db
    .prepare('SELECT version, name FROM schema_migrations ORDER BY version ASC')
    .all() as { version: number; name: string }[];

  if (ledgerRows.length !== 22) {
    const isCanonical23 = ledgerRows.length === 23 && ledgerRows[22]?.version === 23 && ledgerRows[22]?.name === '023_r5j_quarantined_submission_adjudication_and_verification_admission';
    if (!isCanonical23) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Database schema migrations ledger must contain exactly 22 migrations (found ${ledgerRows.length})`);
    }
  }

  for (let i = 0; i < ledgerRows.length; i++) {
    const expectedVersion = i + 1;
    const expectedMigration = MIGRATIONS[i];
    if (ledgerRows[i].version !== expectedVersion) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Database schema ledger is not contiguous: expected version ${expectedVersion}, got ${ledgerRows[i].version}`);
    }
    if (ledgerRows[i].name !== expectedMigration.name) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Database schema ledger migration name mismatch at version ${expectedVersion}: expected "${expectedMigration.name}", got "${ledgerRows[i].name}"`);
    }
  }

  // Helper type for pragma index info
  interface XInfoRow {
    seqno: number;
    cid: number;
    name: string | null;
    desc: number;
    coll: string;
    key: number;
  }

  // 2. Table: mcp_submission_sessions
  const sessTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mcp_submission_sessions'")
    .get() as { name: string } | undefined;
  if (!sessTable) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions is missing');
  }

  const sessColumns = db.prepare("PRAGMA table_info(mcp_submission_sessions)").all() as {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  if (sessColumns.length !== 10) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing column authority: expected exactly 10 columns (found ${sessColumns.length})`);
  }
  const sessColMap = new Map(sessColumns.map((c) => [c.name, c]));
  const reqSessCols: Array<{ name: string; type: string; notnull: number; pk: number }> = [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'authorization_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'scope', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'issuer_identity', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'token_hash', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'authorization_fingerprint', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'issued_at', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'expires_at', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'revoked_at', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'revocation_reason', type: 'TEXT', notnull: 0, pk: 0 },
  ];

  for (let i = 0; i < reqSessCols.length; i++) {
    const req = reqSessCols[i];
    const col = sessColMap.get(req.name);
    if (!col) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing column "${req.name}"`);
    }
    if (col.type !== req.type) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" has unexpected type "${col.type}" (expected "${req.type}")`);
    }
    if (col.pk !== req.pk) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" pk authority mismatch (expected ${req.pk}, got ${col.pk})`);
    }
    if (col.notnull !== req.notnull) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" notnull authority mismatch (expected ${req.notnull}, got ${col.notnull})`);
    }
    if (col.cid !== i) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" cid order authority mismatch (expected ${i}, got ${col.cid})`);
    }
  }

  // FK on mcp_submission_sessions
  const sessFks = db.prepare("PRAGMA foreign_key_list(mcp_submission_sessions)").all() as {
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
    match: string;
  }[];
  if (sessFks.length !== 1) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions must contain exactly 1 foreign key (found ${sessFks.length})`);
  }
  const sessFk = sessFks[0];
  if (
    sessFk.table !== 'execution_authorizations' ||
    sessFk.from !== 'authorization_id' ||
    sessFk.to !== 'id' ||
    sessFk.on_delete.toUpperCase() !== 'RESTRICT' ||
    sessFk.on_update.toUpperCase() !== 'NO ACTION' ||
    sessFk.match !== 'NONE'
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions foreign key on authorization_id must reference execution_authorizations(id) ON DELETE RESTRICT');
  }

  // Indexes on mcp_submission_sessions
  const sessIdxList = db.prepare("PRAGMA index_list(mcp_submission_sessions)").all() as {
    seq: number;
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }[];
  if (sessIdxList.length !== 5) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions must have exactly 5 indexes total (found ${sessIdxList.length})`);
  }
  const sessUserIdxs = sessIdxList.filter((idx) => idx.origin === 'c');
  if (sessUserIdxs.length !== 4) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions must have exactly 4 user-defined indexes (found ${sessUserIdxs.length})`);
  }
  const sessPkIdxs = sessIdxList.filter((idx) => idx.origin === 'pk');
  if (sessPkIdxs.length !== 1) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions must have exactly 1 primary-key index (found ${sessPkIdxs.length})`);
  }
  const autoIdxs = sessIdxList.filter((idx) => idx.origin === 'u');
  if (autoIdxs.length > 0) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions contains unexpected auto-indexes (origin = "u")');
  }

  const sessIdxMap = new Map(sessIdxList.map((idx) => [idx.name, idx]));
  const uqActive = sessIdxMap.get('uq_mcp_submission_sessions_active_auth');
  if (!uqActive || uqActive.unique !== 1 || uqActive.partial !== 1) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing partial unique index uq_mcp_submission_sessions_active_auth');
  }
  const uqActiveXInfo = db.prepare("PRAGMA index_xinfo('uq_mcp_submission_sessions_active_auth')").all() as XInfoRow[];
  const uqActiveKeyCols = uqActiveXInfo.filter((r) => r.key === 1);
  if (
    uqActiveKeyCols.length !== 1 ||
    uqActiveKeyCols[0].name !== 'authorization_id' ||
    uqActiveKeyCols[0].coll !== 'BINARY' ||
    uqActiveKeyCols[0].desc !== 0
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Index uq_mcp_submission_sessions_active_auth must index [authorization_id] with BINARY collation');
  }
  const uqActiveSqlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'uq_mcp_submission_sessions_active_auth'")
    .get() as { sql: string } | undefined;
  if (!uqActiveSqlRow || !/WHERE\s+revoked_at\s+IS\s+NULL/i.test(uqActiveSqlRow.sql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Index uq_mcp_submission_sessions_active_auth missing WHERE revoked_at IS NULL predicate');
  }

  const tokenHashIdx = sessIdxMap.get('idx_mcp_submission_sessions_token_hash');
  if (!tokenHashIdx || tokenHashIdx.unique !== 1 || tokenHashIdx.partial !== 0) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing unique index idx_mcp_submission_sessions_token_hash');
  }
  const tokenHashXInfo = db.prepare("PRAGMA index_xinfo('idx_mcp_submission_sessions_token_hash')").all() as XInfoRow[];
  const tokenHashKeyCols = tokenHashXInfo.filter((r) => r.key === 1);
  if (
    tokenHashKeyCols.length !== 1 ||
    tokenHashKeyCols[0].name !== 'token_hash' ||
    tokenHashKeyCols[0].coll !== 'BINARY' ||
    tokenHashKeyCols[0].desc !== 0
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Index idx_mcp_submission_sessions_token_hash must index [token_hash] with BINARY collation');
  }

  const expiresAtIdx = sessIdxMap.get('idx_mcp_submission_sessions_expires_at');
  if (!expiresAtIdx || expiresAtIdx.unique !== 0 || expiresAtIdx.partial !== 0) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing index idx_mcp_submission_sessions_expires_at');
  }
  const expiresAtXInfo = db.prepare("PRAGMA index_xinfo('idx_mcp_submission_sessions_expires_at')").all() as XInfoRow[];
  const expiresAtKeyCols = expiresAtXInfo.filter((r) => r.key === 1);
  if (
    expiresAtKeyCols.length !== 1 ||
    expiresAtKeyCols[0].name !== 'expires_at' ||
    expiresAtKeyCols[0].coll !== 'BINARY' ||
    expiresAtKeyCols[0].desc !== 0
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Index idx_mcp_submission_sessions_expires_at must index [expires_at] with BINARY collation');
  }

  const authIdIdx = sessIdxMap.get('idx_mcp_submission_sessions_auth_id');
  if (!authIdIdx || authIdIdx.unique !== 0 || authIdIdx.partial !== 0) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing index idx_mcp_submission_sessions_auth_id');
  }
  const authIdXInfo = db.prepare("PRAGMA index_xinfo('idx_mcp_submission_sessions_auth_id')").all() as XInfoRow[];
  const authIdKeyCols = authIdXInfo.filter((r) => r.key === 1);
  if (
    authIdKeyCols.length !== 1 ||
    authIdKeyCols[0].name !== 'authorization_id' ||
    authIdKeyCols[0].coll !== 'BINARY' ||
    authIdKeyCols[0].desc !== 0
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Index idx_mcp_submission_sessions_auth_id must index [authorization_id] with BINARY collation');
  }

  // CHECK constraints on mcp_submission_sessions
  const sessSqlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mcp_submission_sessions'")
    .get() as { sql: string } | undefined;
  const sessSql = (sessSqlRow?.sql ?? '').replace(/\s+/g, ' ');
  const sessChecks = sessSql.match(/\bCHECK\s*\(/gi);
  if (!sessChecks || sessChecks.length !== 8) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions must contain exactly 8 CHECK constraints (found ${sessChecks?.length ?? 0})`);
  }
  if (!/scope\s*=\s*'CODER_SUBMISSION'/i.test(sessSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing scope CHECK constraint');
  }
  if (!/issuer_identity\s*=\s*'OWNER_LOCAL_CLI'/i.test(sessSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing issuer_identity CHECK constraint');
  }
  if (!/length\(token_hash\)\s*=\s*64\s+AND\s+token_hash\s+GLOB\s+'(\[0-9a-f\]){64}'/i.test(sessSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing token_hash CHECK constraint');
  }
  if (!/length\(authorization_fingerprint\)\s*=\s*64\s+AND\s+authorization_fingerprint\s+GLOB\s+'(\[0-9a-f\]){64}'/i.test(sessSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing authorization_fingerprint CHECK constraint');
  }
  if (!/strftime\('%Y-%m-%dT%H:%M:%fZ',\s*issued_at\)\s*=\s*issued_at/i.test(sessSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing issued_at round-trip CHECK constraint');
  }
  if (!/strftime\('%Y-%m-%dT%H:%M:%fZ',\s*expires_at\)\s*=\s*expires_at/i.test(sessSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing expires_at round-trip CHECK constraint');
  }
  if (!/\(unixepoch\(expires_at\)\s*-\s*unixepoch\(issued_at\)\)\s*>=\s*300\s+AND\s+\(unixepoch\(expires_at\)\s*-\s*unixepoch\(issued_at\)\)\s*<=\s*86400/i.test(sessSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing TTL bounds CHECK constraint');
  }
  if (!/revoked_at\s+IS\s+NULL\s+AND\s+revocation_reason\s+IS\s+NULL/i.test(sessSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing revoked_at CHECK constraint');
  }

  // Triggers on mcp_submission_sessions
  const sessTriggers = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'mcp_submission_sessions'")
    .all() as { name: string; sql: string }[];
  const sessTrigMap = new Map(sessTriggers.map((t) => [t.name, t]));
  if (!sessTrigMap.has('trg_mcp_submission_sessions_no_delete') || !sessTrigMap.has('trg_mcp_submission_sessions_immutable_update')) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing required triggers');
  }
  if (sessTriggers.length !== 2) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions has unexpected triggers (found ${sessTriggers.length})`);
  }
  const noDeleteTrig = sessTrigMap.get('trg_mcp_submission_sessions_no_delete')!;
  if (!/BEFORE\s+DELETE\s+ON\s+mcp_submission_sessions/i.test(noDeleteTrig.sql) || !/MCP_SUBMISSION_SESSION_DELETE_FORBIDDEN/i.test(noDeleteTrig.sql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Trigger trg_mcp_submission_sessions_no_delete authority mismatch');
  }
  const immutableUpdateTrig = sessTrigMap.get('trg_mcp_submission_sessions_immutable_update')!;
  if (
    !/BEFORE\s+UPDATE\s+ON\s+mcp_submission_sessions/i.test(immutableUpdateTrig.sql) ||
    !/MCP_SUBMISSION_SESSION_ALREADY_REVOKED/i.test(immutableUpdateTrig.sql) ||
    !/MCP_SUBMISSION_SESSION_MUTATION_FORBIDDEN/i.test(immutableUpdateTrig.sql) ||
    !/NEW\.issuer_identity\s*!=\s*OLD\.issuer_identity/i.test(immutableUpdateTrig.sql)
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Trigger trg_mcp_submission_sessions_immutable_update authority mismatch');
  }

  // 3. Table: coder_submissions
  const subTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coder_submissions'")
    .get() as { name: string } | undefined;
  if (!subTable) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions is missing');
  }

  const subColumns = db.prepare("PRAGMA table_info(coder_submissions)").all() as {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  if (subColumns.length !== 36) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing column authority: expected exactly 36 columns (found ${subColumns.length})`);
  }
  const subColMap = new Map(subColumns.map((c) => [c.name, c]));
  const reqSubCols: Array<{ name: string; type: string; notnull: number; pk: number }> = [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'authorization_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'project_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'task_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'task_ownership_epoch', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'session_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'lifecycle_version', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'execution_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'attempt_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'assignment_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'selected_provider_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'selected_account_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'selected_resource_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'manager_message_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'routing_decision_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'base_sha', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'authorized_head_sha', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'schema_version', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'authorization_status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'dispatched_at', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'authority_fingerprint', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'manager_payload_hash', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'task_revision', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'claimed_status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'quarantine_status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'summary', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'changed_files_count', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'tests_claimed_count', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'blockers_count', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'review_requested', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'claim_content_hash', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'canonical_envelope_hash', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'claim_content_json', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'canonical_envelope_json', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'canonical_arguments_bytes', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'submitted_at', type: 'TEXT', notnull: 1, pk: 0 },
  ];

  for (let i = 0; i < reqSubCols.length; i++) {
    const req = reqSubCols[i];
    const col = subColMap.get(req.name);
    if (!col) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing column "${req.name}"`);
    }
    if (col.type !== req.type) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" has unexpected type "${col.type}" (expected "${req.type}")`);
    }
    if (col.pk !== req.pk) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" pk authority mismatch (expected ${req.pk}, got ${col.pk})`);
    }
    if (col.notnull !== req.notnull) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" notnull authority mismatch (expected ${req.notnull}, got ${col.notnull})`);
    }
    if (col.cid !== i) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" cid order authority mismatch (expected ${i}, got ${col.cid})`);
    }
  }

  // FKs on coder_submissions: exactly 9 FKs
  const subFks = db.prepare("PRAGMA foreign_key_list(coder_submissions)").all() as {
    id: number;
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
    match: string;
  }[];
  if (subFks.length !== 9) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions must contain exactly 9 foreign keys (found ${subFks.length})`);
  }
  const expectedFkMap = new Map([
    ['authorization_id', { table: 'execution_authorizations', to: 'id' }],
    ['project_id', { table: 'projects', to: 'id' }],
    ['task_id', { table: 'tasks', to: 'id' }],
    ['session_id', { table: 'mcp_submission_sessions', to: 'id' }],
    ['attempt_id', { table: 'task_attempts', to: 'id' }],
    ['assignment_id', { table: 'agent_assignments', to: 'id' }],
    ['selected_provider_id', { table: 'providers', to: 'id' }],
    ['selected_account_id', { table: 'provider_accounts', to: 'id' }],
    ['selected_resource_id', { table: 'provider_resources', to: 'id' }],
  ]);
  for (const fk of subFks) {
    if (fk.on_delete.toUpperCase() !== 'RESTRICT' || fk.on_update.toUpperCase() !== 'NO ACTION' || fk.match !== 'NONE') {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Foreign key on "${fk.from}" must be ON DELETE RESTRICT (got ${fk.on_delete})`);
    }
    const exp = expectedFkMap.get(fk.from);
    if (!exp || exp.table !== fk.table || exp.to !== fk.to) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Foreign key on "${fk.from}" references unexpected table "${fk.table}"("${fk.to}")`);
    }
  }

  // Indexes on coder_submissions
  const subIdxList = db.prepare("PRAGMA index_list(coder_submissions)").all() as {
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }[];
  if (subIdxList.length !== 7) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions must have exactly 7 indexes total (found ${subIdxList.length})`);
  }
  const subUserIdxs = subIdxList.filter((idx) => idx.origin === 'c');
  if (subUserIdxs.length !== 6) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions must have exactly 6 user-defined indexes (found ${subUserIdxs.length})`);
  }
  const subPkIdxs = subIdxList.filter((idx) => idx.origin === 'pk');
  if (subPkIdxs.length !== 1) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions must have exactly 1 primary-key index (found ${subPkIdxs.length})`);
  }
  const subAutoIdxs = subIdxList.filter((idx) => idx.origin === 'u');
  if (subAutoIdxs.length > 0) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions contains unexpected auto-indexes (origin = "u")');
  }

  const expectedSubIndexes = new Map([
    ['idx_coder_submissions_auth_id', 'authorization_id'],
    ['idx_coder_submissions_task_id', 'task_id'],
    ['idx_coder_submissions_session_id', 'session_id'],
    ['idx_coder_submissions_content_hash', 'claim_content_hash'],
    ['idx_coder_submissions_envelope_hash', 'canonical_envelope_hash'],
    ['idx_coder_submissions_submitted_at', 'submitted_at'],
  ]);

  for (const [idxName, colName] of expectedSubIndexes.entries()) {
    const idx = subIdxList.find((i) => i.name === idxName);
    if (!idx || idx.unique !== 0 || idx.partial !== 0) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Index "${idxName}" on coder_submissions missing or not non-unique non-partial`);
    }
    const xinfo = db.prepare(`PRAGMA index_xinfo('${idxName}')`).all() as XInfoRow[];
    const keyCols = xinfo.filter((r) => r.key === 1);
    if (keyCols.length !== 1 || keyCols[0].name !== colName || keyCols[0].coll !== 'BINARY' || keyCols[0].desc !== 0) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Index "${idxName}" must index [${colName}] with BINARY collation`);
    }
  }

  // CHECK constraints on coder_submissions
  const subSqlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'coder_submissions'")
    .get() as { sql: string } | undefined;
  const subSql = (subSqlRow?.sql ?? '').replace(/\s+/g, ' ');
  const subChecks = subSql.match(/\bCHECK\s*\(/gi);
  if (!subChecks || subChecks.length !== 25) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions must contain exactly 25 CHECK constraints (found ${subChecks?.length ?? 0})`);
  }
  if (!/schema_version\s*=\s*1/i.test(subSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing schema_version CHECK constraint');
  }
  if (!/authorization_status\s*=\s*'DISPATCHED'/i.test(subSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing authorization_status CHECK constraint');
  }
  if (!/strftime\('%Y-%m-%dT%H:%M:%fZ',\s*dispatched_at\)\s*=\s*dispatched_at/i.test(subSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing dispatched_at round-trip CHECK constraint');
  }
  if (!/length\(authority_fingerprint\)\s*=\s*64\s+AND\s+authority_fingerprint\s+GLOB\s+'(\[0-9a-f\]){64}'/i.test(subSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing authority_fingerprint CHECK constraint');
  }
  if (!/length\(manager_payload_hash\)\s*=\s*64\s+AND\s+manager_payload_hash\s+GLOB\s+'(\[0-9a-f\]){64}'/i.test(subSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing manager_payload_hash CHECK constraint');
  }
  if (!/task_revision\s*>=\s*0/i.test(subSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing task_revision CHECK constraint');
  }
  if (!/strftime\('%Y-%m-%dT%H:%M:%fZ',\s*submitted_at\)\s*=\s*submitted_at/i.test(subSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing submitted_at round-trip CHECK constraint');
  }
  if (!/quarantine_status\s*=\s*'QUARANTINED'/i.test(subSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing quarantine_status CHECK constraint');
  }
  if (!/json_valid\(claim_content_json\)\s*=\s*1\s+AND\s+json_type\(claim_content_json\)\s*=\s*'object'/i.test(subSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing claim_content_json object CHECK constraint');
  }
  if (!/json_valid\(canonical_envelope_json\)\s*=\s*1\s+AND\s+json_type\(canonical_envelope_json\)\s*=\s*'object'/i.test(subSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing canonical_envelope_json object CHECK constraint');
  }

  // Triggers on coder_submissions
  const subTriggers = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'coder_submissions'")
    .all() as { name: string; sql: string }[];
  const subTrigMap = new Map(subTriggers.map((t) => [t.name, t]));
  if (!subTrigMap.has('trg_coder_submissions_no_update') || !subTrigMap.has('trg_coder_submissions_no_delete')) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing required triggers');
  }
  if (subTriggers.length !== 2) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions has unexpected triggers (found ${subTriggers.length})`);
  }
  const subNoUpdateTrig = subTrigMap.get('trg_coder_submissions_no_update')!;
  if (!/BEFORE\s+UPDATE\s+ON\s+coder_submissions/i.test(subNoUpdateTrig.sql) || !/coder_submissions is strictly append-only: UPDATE is prohibited/i.test(subNoUpdateTrig.sql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Trigger trg_coder_submissions_no_update authority mismatch');
  }
  const subNoDeleteTrig = subTrigMap.get('trg_coder_submissions_no_delete')!;
  if (!/BEFORE\s+DELETE\s+ON\s+coder_submissions/i.test(subNoDeleteTrig.sql) || !/coder_submissions is strictly append-only: DELETE is prohibited/i.test(subNoDeleteTrig.sql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Trigger trg_coder_submissions_no_delete authority mismatch');
  }

  // 4. Table: coder_submission_dispositions
  const dispTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coder_submission_dispositions'")
    .get() as { name: string } | undefined;
  if (!dispTable) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions is missing');
  }

  const dispColumns = db.prepare("PRAGMA table_info(coder_submission_dispositions)").all() as {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  if (dispColumns.length !== 8) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions missing column authority: expected exactly 8 columns (found ${dispColumns.length})`);
  }
  const dispColMap = new Map(dispColumns.map((c) => [c.name, c]));
  const reqDispCols: Array<{ name: string; type: string; notnull: number; pk: number }> = [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'submission_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'disposition_event', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'disposition_reason', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'actor_type', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'actor_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'disposition_metadata_json', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'created_at', type: 'TEXT', notnull: 1, pk: 0 },
  ];

  for (let i = 0; i < reqDispCols.length; i++) {
    const req = reqDispCols[i];
    const col = dispColMap.get(req.name);
    if (!col) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions missing column "${req.name}"`);
    }
    if (col.type !== req.type) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" has unexpected type "${col.type}" (expected "${req.type}")`);
    }
    if (col.pk !== req.pk) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" pk authority mismatch (expected ${req.pk}, got ${col.pk})`);
    }
    if (col.notnull !== req.notnull) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" notnull authority mismatch (expected ${req.notnull}, got ${col.notnull})`);
    }
    if (col.cid !== i) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" cid order authority mismatch (expected ${i}, got ${col.cid})`);
    }
  }

  // FK on coder_submission_dispositions
  const dispFks = db.prepare("PRAGMA foreign_key_list(coder_submission_dispositions)").all() as {
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
    match: string;
  }[];
  if (dispFks.length !== 1) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions must contain exactly 1 foreign key (found ${dispFks.length})`);
  }
  if (
    dispFks[0].table !== 'coder_submissions' ||
    dispFks[0].from !== 'submission_id' ||
    dispFks[0].to !== 'id' ||
    dispFks[0].on_delete.toUpperCase() !== 'RESTRICT' ||
    dispFks[0].on_update.toUpperCase() !== 'NO ACTION' ||
    dispFks[0].match !== 'NONE'
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions foreign key must reference coder_submissions(id) ON DELETE RESTRICT');
  }

  // Indexes on coder_submission_dispositions
  const dispIdxList = db.prepare("PRAGMA index_list(coder_submission_dispositions)").all() as {
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }[];
  if (dispIdxList.length !== 4) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions must have exactly 4 indexes total (found ${dispIdxList.length})`);
  }
  const dispUserIdxs = dispIdxList.filter((idx) => idx.origin === 'c');
  if (dispUserIdxs.length !== 3) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions must have exactly 3 user-defined indexes (found ${dispUserIdxs.length})`);
  }
  const dispPkIdxs = dispIdxList.filter((idx) => idx.origin === 'pk');
  if (dispPkIdxs.length !== 1) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions must have exactly 1 primary-key index (found ${dispPkIdxs.length})`);
  }
  const dispAutoIdxs = dispIdxList.filter((idx) => idx.origin === 'u');
  if (dispAutoIdxs.length > 0) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions contains unexpected auto-indexes (origin = "u")');
  }

  const expectedDispIndexes = new Map([
    ['idx_coder_submission_dispositions_submission', 'submission_id'],
    ['idx_coder_submission_dispositions_event', 'disposition_event'],
    ['idx_coder_submission_dispositions_created_at', 'created_at'],
  ]);

  for (const [idxName, colName] of expectedDispIndexes.entries()) {
    const idx = dispIdxList.find((i) => i.name === idxName);
    if (!idx || idx.unique !== 0 || idx.partial !== 0) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Index "${idxName}" on coder_submission_dispositions missing or invalid`);
    }
    const xinfo = db.prepare(`PRAGMA index_xinfo('${idxName}')`).all() as XInfoRow[];
    const keyCols = xinfo.filter((r) => r.key === 1);
    if (keyCols.length !== 1 || keyCols[0].name !== colName || keyCols[0].coll !== 'BINARY' || keyCols[0].desc !== 0) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Index "${idxName}" must index [${colName}] with BINARY collation`);
    }
  }

  // CHECK constraints on coder_submission_dispositions
  const dispSqlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'coder_submission_dispositions'")
    .get() as { sql: string } | undefined;
  const dispSql = (dispSqlRow?.sql ?? '').replace(/\s+/g, ' ');
  const dispChecks = dispSql.match(/\bCHECK\s*\(/gi);
  if (!dispChecks || dispChecks.length !== 6) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions must contain exactly 6 CHECK constraints (found ${dispChecks?.length ?? 0})`);
  }
  if (!/strftime\('%Y-%m-%dT%H:%M:%fZ',\s*created_at\)\s*=\s*created_at/i.test(dispSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions missing created_at round-trip CHECK constraint');
  }
  if (!/actor_type\s+IN\s+\('SYSTEM',\s*'MCP_CLIENT',\s*'OPERATOR'\)/i.test(dispSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions missing actor_type CHECK constraint');
  }

  // Triggers on coder_submission_dispositions
  const dispTriggers = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'coder_submission_dispositions'")
    .all() as { name: string; sql: string }[];
  const dispTrigMap = new Map(dispTriggers.map((t) => [t.name, t]));
  if (!dispTrigMap.has('trg_coder_submission_dispositions_no_update') || !dispTrigMap.has('trg_coder_submission_dispositions_no_delete')) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions missing required triggers');
  }
  if (dispTriggers.length !== 2) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions has unexpected triggers (found ${dispTriggers.length})`);
  }
  const dispNoUpdateTrig = dispTrigMap.get('trg_coder_submission_dispositions_no_update')!;
  if (!/BEFORE\s+UPDATE\s+ON\s+coder_submission_dispositions/i.test(dispNoUpdateTrig.sql) || !/coder_submission_dispositions is strictly append-only: UPDATE is prohibited/i.test(dispNoUpdateTrig.sql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Trigger trg_coder_submission_dispositions_no_update authority mismatch');
  }
  const dispNoDeleteTrig = dispTrigMap.get('trg_coder_submission_dispositions_no_delete')!;
  if (!/BEFORE\s+DELETE\s+ON\s+coder_submission_dispositions/i.test(dispNoDeleteTrig.sql) || !/coder_submission_dispositions is strictly append-only: DELETE is prohibited/i.test(dispNoDeleteTrig.sql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Trigger trg_coder_submission_dispositions_no_delete authority mismatch');
  }

  // 5. Prohibit unexpected extra tables, indexes, or triggers in sqlite_master
  const allMasterRows = db
    .prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger')")
    .all() as { type: string; name: string; tbl_name: string }[];

  const v22Tables = new Set(['mcp_submission_sessions', 'coder_submissions', 'coder_submission_dispositions']);
  const allowedAuthorityTables = new Set(v22Tables);
  if (ledgerRows.length >= 23) {
    allowedAuthorityTables.add('coder_submission_adjudications');
    allowedAuthorityTables.add('coder_submission_adjudication_events');
    allowedAuthorityTables.add('coder_submission_workspace_leases');
  }
  for (const row of allMasterRows) {
    if (row.type === 'table') {
      if ((row.name.startsWith('mcp_sub') || row.name.startsWith('coder_sub')) && !allowedAuthorityTables.has(row.name)) {
        throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Unexpected authority table in schema: "${row.name}"`);
      }
    } else if (row.type === 'trigger') {
      if (v22Tables.has(row.tbl_name)) {
        const allowedTriggers = new Set([
          'trg_mcp_submission_sessions_no_delete',
          'trg_mcp_submission_sessions_immutable_update',
          'trg_coder_submissions_no_update',
          'trg_coder_submissions_no_delete',
          'trg_coder_submission_dispositions_no_update',
          'trg_coder_submission_dispositions_no_delete',
        ]);
        if (!allowedTriggers.has(row.name)) {
          throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Unexpected authority trigger: "${row.name}" on table "${row.tbl_name}"`);
        }
      }
    } else if (row.type === 'index') {
      if (v22Tables.has(row.tbl_name)) {
        const allowedIndexes = new Set([
          'uq_mcp_submission_sessions_active_auth',
          'idx_mcp_submission_sessions_token_hash',
          'idx_mcp_submission_sessions_expires_at',
          'idx_mcp_submission_sessions_auth_id',
          'idx_coder_submissions_auth_id',
          'idx_coder_submissions_task_id',
          'idx_coder_submissions_session_id',
          'idx_coder_submissions_content_hash',
          'idx_coder_submissions_envelope_hash',
          'idx_coder_submissions_submitted_at',
          'idx_coder_submission_dispositions_submission',
          'idx_coder_submission_dispositions_event',
          'idx_coder_submission_dispositions_created_at',
        ]);
        if (!allowedIndexes.has(row.name) && !row.name.startsWith('sqlite_autoindex_')) {
          throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Unexpected authority index: "${row.name}" on table "${row.tbl_name}"`);
        }
      }
    }
  }
}

export function verifyMigration23SchemaAuthority(db: Database.Database): void {
  // 1. Exact ledger entry
  const v23Row = db
    .prepare("SELECT version, name FROM schema_migrations WHERE version = 23 AND name = '023_r5j_quarantined_submission_adjudication_and_verification_admission'")
    .get() as { version: number; name: string } | undefined;
  if (!v23Row) {
    throw new Error('[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Database is missing Migration 23 ledger authority (023_r5j_quarantined_submission_adjudication_and_verification_admission)');
  }

  // 2. Table existence
  const adjTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coder_submission_adjudications'").get();
  if (!adjTable) {
    throw new Error('[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Table coder_submission_adjudications is missing');
  }

  const eventsTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coder_submission_adjudication_events'").get();
  if (!eventsTable) {
    throw new Error('[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Table coder_submission_adjudication_events is missing');
  }

  const leaseTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coder_submission_workspace_leases'").get();
  if (!leaseTable) {
    throw new Error('[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Table coder_submission_workspace_leases is missing');
  }

  // 3. Columns on coder_submission_adjudications: exactly 39 columns
  const adjColumns = db.prepare("PRAGMA table_info(coder_submission_adjudications)").all() as {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  if (adjColumns.length !== 39) {
    throw new Error(`[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Table coder_submission_adjudications missing column authority: expected exactly 39 columns (found ${adjColumns.length})`);
  }

  const expectedAdjColumns: Record<string, { type: string; notnull: number; pk: number }> = {
    id: { type: 'TEXT', notnull: 0, pk: 1 },
    request_id: { type: 'TEXT', notnull: 1, pk: 0 },
    submission_id: { type: 'TEXT', notnull: 1, pk: 0 },
    authorization_id: { type: 'TEXT', notnull: 1, pk: 0 },
    project_id: { type: 'TEXT', notnull: 1, pk: 0 },
    task_id: { type: 'TEXT', notnull: 1, pk: 0 },
    attempt_id: { type: 'TEXT', notnull: 1, pk: 0 },
    assignment_id: { type: 'TEXT', notnull: 1, pk: 0 },
    task_ownership_epoch: { type: 'INTEGER', notnull: 1, pk: 0 },
    action: { type: 'TEXT', notnull: 1, pk: 0 },
    status: { type: 'TEXT', notnull: 1, pk: 0 },
    lifecycle_version: { type: 'INTEGER', notnull: 1, pk: 0 },
    authority_snapshot_json: { type: 'TEXT', notnull: 1, pk: 0 },
    authority_snapshot_hash: { type: 'TEXT', notnull: 1, pk: 0 },
    verification_commands_json: { type: 'TEXT', notnull: 0, pk: 0 },
    verification_commands_hash: { type: 'TEXT', notnull: 0, pk: 0 },
    workspace_snapshot_before_json: { type: 'TEXT', notnull: 0, pk: 0 },
    workspace_snapshot_before_hash: { type: 'TEXT', notnull: 0, pk: 0 },
    verification_result_envelope_json: { type: 'TEXT', notnull: 0, pk: 0 },
    verification_result_envelope_hash: { type: 'TEXT', notnull: 0, pk: 0 },
    verification_execution_id: { type: 'TEXT', notnull: 0, pk: 0 },
    protocol_message_id: { type: 'TEXT', notnull: 0, pk: 0 },
    test_run_id: { type: 'TEXT', notnull: 0, pk: 0 },
    git_status_evidence_id: { type: 'TEXT', notnull: 0, pk: 0 },
    git_diff_evidence_id: { type: 'TEXT', notnull: 0, pk: 0 },
    failure_code: { type: 'TEXT', notnull: 0, pk: 0 },
    failure_json: { type: 'TEXT', notnull: 0, pk: 0 },
    created_at: { type: 'TEXT', notnull: 1, pk: 0 },
    verification_started_at: { type: 'TEXT', notnull: 0, pk: 0 },
    completed_at: { type: 'TEXT', notnull: 0, pk: 0 },
    recovery_fenced_at: { type: 'TEXT', notnull: 0, pk: 0 },
    resolution_action: { type: 'TEXT', notnull: 0, pk: 0 },
    resolution_timestamp: { type: 'TEXT', notnull: 0, pk: 0 },
    resolution_evidence_json: { type: 'TEXT', notnull: 0, pk: 0 },
    resolution_evidence_hash: { type: 'TEXT', notnull: 0, pk: 0 },
    resolver_id: { type: 'TEXT', notnull: 0, pk: 0 },
    artifact_manifest_json: { type: 'TEXT', notnull: 0, pk: 0 },
    artifact_manifest_hash: { type: 'TEXT', notnull: 0, pk: 0 },
    workspace_lease_id: { type: 'TEXT', notnull: 0, pk: 0 },
  };

  for (const [colName, expected] of Object.entries(expectedAdjColumns)) {
    const col = adjColumns.find((c) => c.name === colName);
    if (!col) {
      throw new Error(`[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Table coder_submission_adjudications missing column "${colName}"`);
    }
    if (col.type !== expected.type || col.notnull !== expected.notnull || col.pk !== expected.pk) {
      throw new Error(`[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Table coder_submission_adjudications column "${colName}" attributes mismatch`);
    }
  }

  // 4. FKs on coder_submission_adjudications: exactly 11 foreign keys
  const adjFks = db.prepare("PRAGMA foreign_key_list(coder_submission_adjudications)").all() as {
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }[];
  if (adjFks.length !== 11) {
    throw new Error(`[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Table coder_submission_adjudications must contain exactly 11 foreign keys (found ${adjFks.length})`);
  }

  // 5. Indexes on coder_submission_adjudications
  const adjIdxs = db.prepare("PRAGMA index_list(coder_submission_adjudications)").all() as {
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }[];
  const activePartialIdx = adjIdxs.find((i) => i.name === 'idx_coder_submission_adjudications_active');
  if (!activePartialIdx || activePartialIdx.unique !== 1 || activePartialIdx.partial !== 1) {
    throw new Error('[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Partial unique index idx_coder_submission_adjudications_active missing or invalid');
  }

  // 6. Triggers on coder_submission_adjudications
  const adjTriggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'coder_submission_adjudications'").all() as { name: string }[];
  const expectedAdjTriggers = new Set([
    'trg_coder_submission_adjudications_no_delete',
    'trg_coder_submission_adjudications_immutable_fields',
    'trg_coder_submission_adjudications_lifecycle_cas',
  ]);
  if (adjTriggers.length !== expectedAdjTriggers.size || adjTriggers.some((t) => !expectedAdjTriggers.has(t.name))) {
    throw new Error('[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Triggers on coder_submission_adjudications mismatch expected authority');
  }

  // 7. Columns on coder_submission_workspace_leases: exactly 16 columns
  const leaseColumns = db.prepare("PRAGMA table_info(coder_submission_workspace_leases)").all() as {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  if (leaseColumns.length !== 16) {
    throw new Error(`[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Table coder_submission_workspace_leases missing column authority: expected exactly 16 columns (found ${leaseColumns.length})`);
  }

  const expectedLeaseColumns: Record<string, { type: string; notnull: number; pk: number }> = {
    id: { type: 'TEXT', notnull: 0, pk: 1 },
    adjudication_id: { type: 'TEXT', notnull: 1, pk: 0 },
    worktree_identity_hash: { type: 'TEXT', notnull: 1, pk: 0 },
    admitted_workspace_fingerprint_hash: { type: 'TEXT', notnull: 1, pk: 0 },
    pre_execution_fingerprint_hash: { type: 'TEXT', notnull: 0, pk: 0 },
    claim_nonce: { type: 'TEXT', notnull: 1, pk: 0 },
    execution_id: { type: 'TEXT', notnull: 1, pk: 0 },
    lease_owner_identity: { type: 'TEXT', notnull: 1, pk: 0 },
    assignment_id: { type: 'TEXT', notnull: 1, pk: 0 },
    authorization_id: { type: 'TEXT', notnull: 1, pk: 0 },
    acquired_at: { type: 'TEXT', notnull: 1, pk: 0 },
    released_at: { type: 'TEXT', notnull: 0, pk: 0 },
    lifecycle_version: { type: 'INTEGER', notnull: 1, pk: 0 },
    state: { type: 'TEXT', notnull: 1, pk: 0 },
    failure_code: { type: 'TEXT', notnull: 0, pk: 0 },
    failure_evidence_hash: { type: 'TEXT', notnull: 0, pk: 0 },
  };

  for (const [colName, expected] of Object.entries(expectedLeaseColumns)) {
    const col = leaseColumns.find((c) => c.name === colName);
    if (!col) {
      throw new Error(`[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Table coder_submission_workspace_leases missing column "${colName}"`);
    }
    if (col.type !== expected.type || col.notnull !== expected.notnull || col.pk !== expected.pk) {
      throw new Error(`[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Table coder_submission_workspace_leases column "${colName}" attributes mismatch`);
    }
  }

  // 8. FKs on coder_submission_workspace_leases: exactly 3 foreign keys
  const leaseFks = db.prepare("PRAGMA foreign_key_list(coder_submission_workspace_leases)").all() as {
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }[];
  if (leaseFks.length !== 3) {
    throw new Error(`[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Table coder_submission_workspace_leases must contain exactly 3 foreign keys (found ${leaseFks.length})`);
  }

  // 9. Indexes on coder_submission_workspace_leases: exactly 3 indexes
  const leaseIdxs = db.prepare("PRAGMA index_list(coder_submission_workspace_leases)").all() as {
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }[];
  const activeLeaseIdx = leaseIdxs.find((i) => i.name === 'idx_coder_submission_workspace_leases_active');
  if (!activeLeaseIdx || activeLeaseIdx.unique !== 1 || activeLeaseIdx.partial !== 1) {
    throw new Error('[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Partial unique index idx_coder_submission_workspace_leases_active missing or invalid');
  }

  // 10. Triggers on coder_submission_workspace_leases
  const leaseTriggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'coder_submission_workspace_leases'").all() as { name: string }[];
  const expectedLeaseTriggers = new Set([
    'trg_coder_submission_workspace_leases_no_delete',
    'trg_coder_submission_workspace_leases_immutable',
  ]);
  if (leaseTriggers.length !== expectedLeaseTriggers.size || leaseTriggers.some((t) => !expectedLeaseTriggers.has(t.name))) {
    throw new Error('[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Triggers on coder_submission_workspace_leases mismatch expected authority');
  }

  // 11. Columns on coder_submission_adjudication_events: exactly 7 columns
  const evColumns = db.prepare("PRAGMA table_info(coder_submission_adjudication_events)").all() as {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  if (evColumns.length !== 7) {
    throw new Error(`[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Table coder_submission_adjudication_events missing column authority: expected exactly 7 columns (found ${evColumns.length})`);
  }

  // 12. Triggers on coder_submission_adjudication_events
  const evTriggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'coder_submission_adjudication_events'").all() as { name: string }[];
  const expectedEvTriggers = new Set([
    'trg_coder_submission_adjudication_events_no_update',
    'trg_coder_submission_adjudication_events_no_delete',
  ]);
  if (evTriggers.length !== expectedEvTriggers.size || evTriggers.some((t) => !expectedEvTriggers.has(t.name))) {
    throw new Error('[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Triggers on coder_submission_adjudication_events mismatch expected authority');
  }
}

export class MigrationRunner {
  public static run(db: Database.Database, maxVersion?: number): void {
    const limit = maxVersion ?? MIGRATIONS.length;

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
      if (migration.version > limit) {
        break;
      }
      if (!appliedVersions.has(migration.version)) {
        console.log(`[Migrations] Applying migration ${migration.version}: ${migration.name}...`);

        if (migration.foreignKeyMode === 'DISABLED_FOR_REBUILD') {
          // Explicit rebuild mode: Capture original FK state and disable FKs BEFORE beginning transaction
          const originalFkState = db.pragma('foreign_keys', { simple: true }) as number;
          db.pragma('foreign_keys = OFF');
          const disabledFkState = db.pragma('foreign_keys', { simple: true }) as number;
          if (disabledFkState !== 0) {
            throw new Error(`[Migrations] Failed to disable foreign keys before migration ${migration.version}`);
          }

          try {
            const runTx = db.transaction(() => {
              migration.up(db);

              // Validate foreign keys before commit
              const fkViolations = db.pragma('foreign_key_check') as unknown[];
              if (fkViolations.length > 0) {
                throw new Error(
                  `[Migrations] Foreign key integrity check failed inside migration ${migration.version} with ${fkViolations.length} violation(s): ${JSON.stringify(fkViolations)}`
                );
              }

              db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
                migration.version,
                migration.name,
                new Date().toISOString()
              );
            });
            runTx();
          } finally {
            // Restore original foreign keys state
            db.pragma(`foreign_keys = ${originalFkState === 1 ? 'ON' : 'OFF'}`);
            const restoredFkState = db.pragma('foreign_keys', { simple: true }) as number;
            if (restoredFkState !== originalFkState) {
              throw new Error(
                `[Migrations] Failed to restore foreign_keys pragma state after migration ${migration.version}. Expected ${originalFkState}, got ${restoredFkState}`
              );
            }
          }

          // Final post-migration foreign key verification when restored ON
          if (originalFkState === 1) {
            const postFkViolations = db.pragma('foreign_key_check') as unknown[];
            if (postFkViolations.length > 0) {
              throw new Error(
                `[Migrations] Post-migration foreign key check failed after migration ${migration.version} with ${postFkViolations.length} violation(s)`
              );
            }
          }
        } else {
          // Standard migration mode: FK enforcement remains completely untouched (ON by default)
          const runTx = db.transaction(() => {
            migration.up(db);
            db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
              migration.version,
              migration.name,
              new Date().toISOString()
            );
          });
          runTx();
        }

        console.log(`[Migrations] Successfully applied migration ${migration.version}`);
      }
    }
  }
}
