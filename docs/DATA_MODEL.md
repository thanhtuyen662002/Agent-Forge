# Durable Data Model & Schema Specification

Agent-Forge utilizes SQLite as the single durable relational store for all project metadata, task lifecycles, provider resources, transactional leases, audit logs, and protocol ledgers.

---

## 1. Schema Definitions (DDL)

```sql
-- Pragmas
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- 1. Schema Migrations Ledger
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
);

-- 2. Projects
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

-- 3. Milestones
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

-- 4. Tasks
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

-- 5. Task Dependencies
CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY(task_id, depends_on_task_id)
);

-- 6. Task Leases (Real Concurrency Locks)
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

-- 7. Task Attempts
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

-- 8. Providers
CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    adapter_type TEXT NOT NULL CHECK(adapter_type IN ('MANUAL_BRIDGE', 'LOCAL_CLI', 'API', 'MOCK')),
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

-- 9. Provider Resources / Models
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

-- 10. Agents
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('PRIMARY_MANAGER', 'BACKUP_MANAGER', 'CODER', 'REVIEWER', 'TOOL')),
    provider_resource_id TEXT REFERENCES provider_resources(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK(status IN ('IDLE', 'ACTIVE', 'BUSY', 'PAUSED', 'OFFLINE')) DEFAULT 'IDLE',
    current_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    last_seen_at TEXT NOT NULL
);

-- 11. Protocol Messages / Idempotent Inbox Ledger
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

-- 12. Decisions
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

-- 13. Reviews
CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
    reviewer_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    verdict TEXT NOT NULL CHECK(verdict IN ('PASS', 'FIX_REQUIRED', 'BLOCKED', 'NEEDS_OWNER')),
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- 14. Review Issues
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

-- 15. Evidence
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

-- 16. Test Runs
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

-- 17. Process Runs
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

-- 18. Checkpoints
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

-- 19. Handoffs
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

-- 20. Events (Immutable Audit Stream)
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

-- 21. Approvals
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

-- 22. Policies
CREATE TABLE IF NOT EXISTS policies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    policy_type TEXT NOT NULL,
    action TEXT NOT NULL,
    rule_expression TEXT NOT NULL,
    default_decision TEXT NOT NULL CHECK(default_decision IN ('ALLOW', 'DENY', 'REQUIRES_OWNER_APPROVAL')),
    created_at TEXT NOT NULL
);

-- 23. Project Settings
CREATE TABLE IF NOT EXISTS project_settings (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    PRIMARY KEY(project_id, key)
);

-- 24. Providers & Worker Slots (R5A / R5G / R5I)
CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    adapter_type TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_accounts (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    auth_mode TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 0,
    health_status TEXT NOT NULL DEFAULT 'AVAILABLE',
    concurrency_limit INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_resources (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    provider_account_id TEXT REFERENCES provider_accounts(id) ON DELETE SET NULL,
    model_name TEXT NOT NULL,
    health_status TEXT NOT NULL DEFAULT 'AVAILABLE',
    capabilities_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    total_quota REAL,
    remaining_quota REAL,
    quota_source TEXT NOT NULL,
    quota_confidence REAL NOT NULL DEFAULT 1.0,
    last_health_check TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_slots (
    id TEXT PRIMARY KEY,
    provider_account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
    provider_resource_id TEXT REFERENCES provider_resources(id) ON DELETE SET NULL,
    slot_index INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('IDLE', 'LEASED', 'OFFLINE', 'DRAINING')) DEFAULT 'IDLE',
    current_assignment_id TEXT,
    current_execution_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(provider_account_id, slot_index)
);

CREATE TABLE IF NOT EXISTS account_leases (
    id TEXT PRIMARY KEY,
    provider_account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
    worker_slot_id TEXT NOT NULL REFERENCES worker_slots(id) ON DELETE CASCADE,
    assignment_id TEXT NOT NULL,
    lease_token TEXT NOT NULL UNIQUE,
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    released_at TEXT,
    created_at TEXT NOT NULL
);

-- 25. Agent Fabric & Assignments (R5A / R5I)
CREATE TABLE IF NOT EXISTS role_profiles (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    display_name TEXT NOT NULL,
    authority_scope_json TEXT NOT NULL,
    output_protocol TEXT NOT NULL,
    required_capabilities_json TEXT NOT NULL,
    preferred_capabilities_json TEXT NOT NULL,
    permissions_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_profiles (
    id TEXT PRIMARY KEY,
    role_profile_id TEXT NOT NULL REFERENCES role_profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    prompt_template TEXT NOT NULL,
    config_json TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_assignments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL,
    agent_id TEXT,
    role_profile_id TEXT NOT NULL REFERENCES role_profiles(id),
    agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
    selected_provider_id TEXT NOT NULL REFERENCES providers(id),
    selected_account_id TEXT NOT NULL REFERENCES provider_accounts(id),
    selected_resource_id TEXT NOT NULL REFERENCES provider_resources(id),
    selected_worker_slot_id TEXT REFERENCES worker_slots(id),
    routing_decision_id TEXT NOT NULL,
    preferred_metadata_json TEXT,
    status TEXT NOT NULL CHECK(status IN ('ASSIGNED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'HANDED_OFF')),
    created_at TEXT NOT NULL,
    ended_at TEXT
);

-- 26. Context Fabric (R5B / R5I)
CREATE TABLE IF NOT EXISTS context_snapshots (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    attempt_id TEXT,
    purpose TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_manifests (
    id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL REFERENCES context_snapshots(id) ON DELETE CASCADE,
    manifest_hash TEXT NOT NULL,
    items_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- 27. Handoff Transfers (R5I)
CREATE TABLE IF NOT EXISTS handoff_transfers (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    source_attempt_id TEXT NOT NULL,
    successor_attempt_id TEXT,
    source_assignment_id TEXT NOT NULL,
    successor_assignment_id TEXT,
    successor_role_profile_id TEXT REFERENCES role_profiles(id),
    successor_agent_profile_id TEXT REFERENCES agent_profiles(id),
    successor_context_snapshot_id TEXT REFERENCES context_snapshots(id),
    successor_context_spec_hash TEXT,
    handoff_context_id TEXT,
    checkpoint_id TEXT,
    source_authorization_id TEXT,
    successor_authorization_id TEXT,
    reason TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN (
        'REQUESTED', 'FROZEN', 'QUIESCING', 'RELINQUISHED',
        'ROUTED', 'AUTHORIZED', 'ACCEPTED', 'COMPLETED', 'CANCELLED'
    )),
    source_ownership_epoch INTEGER NOT NULL DEFAULT 1,
    successor_ownership_epoch INTEGER NOT NULL DEFAULT 2,
    version INTEGER NOT NULL DEFAULT 1,
    frozen_at TEXT,
    quiescing_at TEXT,
    relinquished_at TEXT,
    accepted_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- 28. Execution Authorizations (R5I Extended)
CREATE TABLE IF NOT EXISTS execution_authorizations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    attempt_id TEXT,
    task_revision INTEGER NOT NULL DEFAULT 0,
    base_sha TEXT NOT NULL,
    repository_head_sha TEXT NOT NULL,
    manager_message_id TEXT NOT NULL,
    manager_payload_hash TEXT NOT NULL,
    routing_decision_id TEXT NOT NULL,
    selected_provider_id TEXT NOT NULL,
    selected_account_id TEXT,
    selected_resource_id TEXT NOT NULL,
    instruction_payload_hash TEXT NOT NULL,
    context_manifest_hash TEXT NOT NULL,
    canonical_instructions_json TEXT NOT NULL,
    context_files_json TEXT NOT NULL,
    canonical_payload_json TEXT,
    status TEXT NOT NULL CHECK(status IN (
        'AUTHORIZED', 'DISPATCHED', 'EXECUTED', 'FAILED', 'REVOKED', 'REJECTED', 'EXPIRED'
    )),
    created_at TEXT NOT NULL,
    dispatched_at TEXT,
    task_ownership_epoch INTEGER NOT NULL DEFAULT 1,
    assignment_id TEXT,
    lifecycle_version INTEGER NOT NULL DEFAULT 0,
    execution_id TEXT,
    adapter_started_at TEXT,
    adapter_finished_at TEXT,
    adapter_outcome TEXT CHECK(adapter_outcome IN ('RETURNED', 'THREW', 'CANCELLED', 'TIMED_OUT', NULL)),
    adapter_error_json TEXT,
    settled_at TEXT,
    settlement_status TEXT CHECK(settlement_status IN ('COMPLETED', 'FAILED', 'CANCELLED', NULL)),
    settlement_evidence_json TEXT,
    settlement_evidence_hash TEXT
);

-- 29. Execution Recovery States (R5I)
CREATE TABLE IF NOT EXISTS execution_recovery_states (
    id TEXT PRIMARY KEY,
    authorization_id TEXT NOT NULL UNIQUE REFERENCES execution_authorizations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    attempt_id TEXT,
    assignment_id TEXT,
    transfer_id TEXT,
    reconciled_at TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK(disposition IN (
        'NO_OP', 'REVOKED_UNSTARTED', 'UNRESOLVED_FENCED',
        'TERMINAL_STATE_RECONCILED', 'ERROR_FAILED'
    )),
    classification TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
```
