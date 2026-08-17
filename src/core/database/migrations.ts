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
      // 1. Back up agent-to-resource associations in a temp table
      db.exec(`
        CREATE TEMP TABLE IF NOT EXISTS temp_agent_resource_backup (
          agent_id TEXT PRIMARY KEY,
          provider_resource_id TEXT
        );
        INSERT INTO temp_agent_resource_backup (agent_id, provider_resource_id)
        SELECT id, provider_resource_id FROM agents WHERE provider_resource_id IS NOT NULL;
      `);

      // 2. Rebuild provider_resources table with nullable last_health_check
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

      // 3. Restore agent-to-resource associations after provider_resources is reconstituted
      db.exec(`
        UPDATE agents
        SET provider_resource_id = (
          SELECT provider_resource_id FROM temp_agent_resource_backup WHERE agent_id = agents.id
        )
        WHERE id IN (SELECT agent_id FROM temp_agent_resource_backup);

        DROP TABLE IF EXISTS temp_agent_resource_backup;
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
