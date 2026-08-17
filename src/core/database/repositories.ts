import Database from 'better-sqlite3';
import {
  Project,
  Task,
  TaskLease,
  TaskAttempt,
  Provider,
  ProviderResource,
  Agent,
  Decision,
  Review,
  ReviewIssue,
  Evidence,
  TestRun,
  ProcessRun,
  Checkpoint,
  Handoff,
  EventRecord,
  ProjectContract,
  TaskState,
  ProjectStatus
} from '../types/domain';

export class Repository {
  constructor(private db: Database.Database) {}

  public runInTransaction<T>(fn: () => T): T {
    const tx = this.db.transaction(fn);
    return tx();
  }

  // ==========================================
  // Projects
  // ==========================================
  public createProject(project: Project): void {
    this.db
      .prepare(`
        INSERT INTO projects (
          id, name, description, repository_path, default_branch, 
          status, contract_json, created_at, updated_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        project.id,
        project.name,
        project.description,
        project.repository_path,
        project.default_branch,
        project.status,
        project.contract ? JSON.stringify(project.contract) : null,
        project.created_at,
        project.updated_at,
        project.started_at,
        project.completed_at
      );
  }

  public getProject(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapProject(row);
  }

  public getAllProjects(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map((r) => this.mapProject(r));
  }

  public updateProjectStatus(id: string, status: ProjectStatus, startedAt?: string, completedAt?: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        UPDATE projects 
        SET status = ?, updated_at = ?,
            started_at = COALESCE(?, started_at),
            completed_at = COALESCE(?, completed_at)
        WHERE id = ?
      `)
      .run(status, now, startedAt ?? null, completedAt ?? null, id);
  }

  public updateProjectContract(id: string, contract: ProjectContract): void {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE projects SET contract_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(contract), now, id);
  }

  private mapProject(row: Record<string, unknown>): Project {
    return {
      id: String(row.id),
      name: String(row.name),
      description: row.description ? String(row.description) : null,
      repository_path: String(row.repository_path),
      default_branch: String(row.default_branch),
      status: row.status as ProjectStatus,
      contract: row.contract_json ? (JSON.parse(String(row.contract_json)) as ProjectContract) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      started_at: row.started_at ? String(row.started_at) : null,
      completed_at: row.completed_at ? String(row.completed_at) : null,
    };
  }

  // ==========================================
  // Tasks
  // ==========================================
  public createTask(task: Task): void {
    this.db
      .prepare(`
        INSERT INTO tasks (
          id, project_id, milestone_id, title, description, state, paused_from_state,
          priority, risk, assigned_agent_id, revision_count, max_revisions,
          base_sha, current_sha, progress_cache_percent, progress_computed_at,
          acceptance_criteria_json, constraints_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        task.id,
        task.project_id,
        task.milestone_id,
        task.title,
        task.description,
        task.state,
        task.paused_from_state,
        task.priority,
        task.risk,
        task.assigned_agent_id,
        task.revision_count,
        task.max_revisions,
        task.base_sha,
        task.current_sha,
        task.progress_cache_percent,
        task.progress_computed_at,
        JSON.stringify(task.acceptance_criteria),
        JSON.stringify(task.constraints),
        task.created_at,
        task.updated_at
      );
  }

  public getTask(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapTask(row);
  }

  public getTasksByProject(projectId: string): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as Record<string, unknown>[];
    return rows.map((r) => this.mapTask(r));
  }

  public updateTaskState(
    id: string,
    state: TaskState,
    pausedFromState: string | null = null,
    incrementRevision: boolean = false
  ): void {
    const now = new Date().toISOString();
    if (incrementRevision) {
      this.db
        .prepare(`
          UPDATE tasks 
          SET state = ?, paused_from_state = ?, revision_count = revision_count + 1, updated_at = ?
          WHERE id = ?
        `)
        .run(state, pausedFromState, now, id);
    } else {
      this.db
        .prepare(`
          UPDATE tasks 
          SET state = ?, paused_from_state = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(state, pausedFromState, now, id);
    }
  }

  public updateTaskShas(id: string, baseSha?: string | null, currentSha?: string | null): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        UPDATE tasks 
        SET base_sha = COALESCE(?, base_sha),
            current_sha = COALESCE(?, current_sha),
            updated_at = ?
        WHERE id = ?
      `)
      .run(baseSha ?? null, currentSha ?? null, now, id);
  }

  public updateTaskProgressCache(id: string, progressPercent: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE tasks SET progress_cache_percent = ?, progress_computed_at = ?, updated_at = ? WHERE id = ?')
      .run(progressPercent, now, now, id);
  }

  private mapTask(row: Record<string, unknown>): Task {
    return {
      id: String(row.id),
      project_id: String(row.project_id),
      milestone_id: row.milestone_id ? String(row.milestone_id) : null,
      title: String(row.title),
      description: row.description ? String(row.description) : null,
      state: row.state as TaskState,
      paused_from_state: row.paused_from_state as any,
      priority: row.priority as any,
      risk: row.risk as any,
      assigned_agent_id: row.assigned_agent_id ? String(row.assigned_agent_id) : null,
      revision_count: Number(row.revision_count),
      max_revisions: Number(row.max_revisions),
      base_sha: row.base_sha ? String(row.base_sha) : null,
      current_sha: row.current_sha ? String(row.current_sha) : null,
      progress_cache_percent: Number(row.progress_cache_percent),
      progress_computed_at: row.progress_computed_at ? String(row.progress_computed_at) : null,
      acceptance_criteria: row.acceptance_criteria_json ? JSON.parse(String(row.acceptance_criteria_json)) : [],
      constraints: row.constraints_json ? JSON.parse(String(row.constraints_json)) : [],
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  // ==========================================
  // Task Leases (Real Concurrency Locks)
  // ==========================================
  public acquireTaskLease(taskId: string, agentId: string, leaseToken: string, ttlMs: number = 300000): boolean {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const nowIso = now.toISOString();

    const existing = this.db.prepare('SELECT * FROM task_leases WHERE task_id = ?').get(taskId) as Record<string, unknown> | undefined;

    if (!existing || existing.released_at !== null || new Date(String(existing.expires_at)) < now) {
      // Lease is available or expired
      this.db
        .prepare(`
          INSERT INTO task_leases (task_id, agent_id, lease_token, acquired_at, expires_at, heartbeat_at, released_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(task_id) DO UPDATE SET
            agent_id = excluded.agent_id,
            lease_token = excluded.lease_token,
            acquired_at = excluded.acquired_at,
            expires_at = excluded.expires_at,
            heartbeat_at = excluded.heartbeat_at,
            released_at = NULL
        `)
        .run(taskId, agentId, leaseToken, nowIso, expiresAt, nowIso);

      this.db.prepare('UPDATE tasks SET assigned_agent_id = ? WHERE id = ?').run(agentId, taskId);
      return true;
    }

    if (existing.agent_id === agentId && existing.lease_token === leaseToken) {
      // Re-acquired / refreshed by same agent
      this.db
        .prepare('UPDATE task_leases SET expires_at = ?, heartbeat_at = ? WHERE task_id = ?')
        .run(expiresAt, nowIso, taskId);
      return true;
    }

    return false; // Active lease held by another agent
  }

  public releaseTaskLease(taskId: string, leaseToken: string): boolean {
    const now = new Date().toISOString();
    const info = this.db
      .prepare('UPDATE task_leases SET released_at = ? WHERE task_id = ? AND lease_token = ?')
      .run(now, taskId, leaseToken);
    return info.changes > 0;
  }

  public getTaskLease(taskId: string): TaskLease | null {
    const row = this.db.prepare('SELECT * FROM task_leases WHERE task_id = ?').get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      task_id: String(row.task_id),
      agent_id: String(row.agent_id),
      lease_token: String(row.lease_token),
      acquired_at: String(row.acquired_at),
      expires_at: String(row.expires_at),
      heartbeat_at: String(row.heartbeat_at),
      released_at: row.released_at ? String(row.released_at) : null,
    };
  }

  // ==========================================
  // Protocol Messages / Inbox Ledger
  // ==========================================
  public recordProtocolMessage(
    id: string,
    messageId: string,
    protocol: string,
    projectId: string,
    taskId: string | null,
    expectedTaskState: string | null,
    expectedRevision: number | null,
    payloadHash: string,
    rawPayload: string,
    status: 'APPLIED' | 'REJECTED' | 'DUPLICATE',
    rejectionReason?: string
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO protocol_messages (
          id, message_id, protocol, project_id, task_id,
          expected_task_state, expected_revision, payload_hash,
          raw_payload, status, rejection_reason, created_at, processed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        messageId,
        protocol,
        projectId,
        taskId,
        expectedTaskState,
        expectedRevision,
        payloadHash,
        rawPayload,
        status,
        rejectionReason ?? null,
        now,
        now
      );
  }

  public getProtocolMessageById(messageId: string): Record<string, unknown> | null {
    const row = this.db.prepare('SELECT * FROM protocol_messages WHERE message_id = ?').get(messageId) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  public getProtocolMessagesByTask(taskId: string): Record<string, unknown>[] {
    return this.db
      .prepare('SELECT * FROM protocol_messages WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as Record<string, unknown>[];
  }

  // ==========================================
  // Providers & Provider Resources
  // ==========================================
  public createProvider(provider: Provider): void {
    this.db
      .prepare('INSERT INTO providers (id, name, adapter_type, enabled, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(provider.id, provider.name, provider.adapter_type, provider.enabled ? 1 : 0, provider.created_at);
  }

  public getAllProviders(): Provider[] {
    const rows = this.db.prepare('SELECT * FROM providers ORDER BY name ASC').all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      adapter_type: r.adapter_type as any,
      enabled: Boolean(r.enabled),
      created_at: String(r.created_at),
    }));
  }

  public createProviderResource(resource: ProviderResource): void {
    this.db
      .prepare(`
        INSERT INTO provider_resources (
          id, provider_id, model_name, health_status, capabilities_json, enabled,
          total_quota, remaining_quota, quota_unit, quota_reset_at, quota_source,
          quota_confidence, last_health_check
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        resource.id,
        resource.provider_id,
        resource.model_name,
        resource.health_status,
        JSON.stringify(resource.capabilities),
        resource.enabled ? 1 : 0,
        resource.total_quota,
        resource.remaining_quota,
        resource.quota_unit,
        resource.quota_reset_at,
        resource.quota_source,
        resource.quota_confidence,
        resource.last_health_check
      );
  }

  public getAllProviderResources(): ProviderResource[] {
    const rows = this.db.prepare('SELECT * FROM provider_resources ORDER BY model_name ASC').all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      provider_id: String(r.provider_id),
      model_name: String(r.model_name),
      health_status: r.health_status as any,
      capabilities: r.capabilities_json ? JSON.parse(String(r.capabilities_json)) : [],
      enabled: Boolean(r.enabled),
      total_quota: r.total_quota !== null ? Number(r.total_quota) : null,
      remaining_quota: r.remaining_quota !== null ? Number(r.remaining_quota) : null,
      quota_unit: String(r.quota_unit),
      quota_reset_at: r.quota_reset_at ? String(r.quota_reset_at) : null,
      quota_source: r.quota_source as any,
      quota_confidence: Number(r.quota_confidence),
      last_health_check: String(r.last_health_check),
    }));
  }

  public updateProviderResourceQuota(
    id: string,
    remaining: number | null,
    total: number | null,
    source: string,
    confidence: number
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        UPDATE provider_resources 
        SET remaining_quota = ?, total_quota = ?, quota_source = ?, quota_confidence = ?, last_health_check = ?
        WHERE id = ?
      `)
      .run(remaining, total, source, confidence, now, id);
  }

  // ==========================================
  // Agents
  // ==========================================
  public createAgent(agent: Agent): void {
    this.db
      .prepare(`
        INSERT INTO agents (id, display_name, role, provider_resource_id, status, current_task_id, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(agent.id, agent.display_name, agent.role, agent.provider_resource_id, agent.status, agent.current_task_id, agent.last_seen_at);
  }

  public getAllAgents(): Agent[] {
    const rows = this.db.prepare('SELECT * FROM agents ORDER BY display_name ASC').all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      display_name: String(r.display_name),
      role: r.role as any,
      provider_resource_id: r.provider_resource_id ? String(r.provider_resource_id) : null,
      status: r.status as any,
      current_task_id: r.current_task_id ? String(r.current_task_id) : null,
      last_seen_at: String(r.last_seen_at),
    }));
  }

  public updateAgentStatus(id: string, status: string, currentTaskId: string | null = null): void {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE agents SET status = ?, current_task_id = ?, last_seen_at = ? WHERE id = ?')
      .run(status, currentTaskId, now, id);
  }

  // ==========================================
  // Evidence & Large Artifacts
  // ==========================================
  public createEvidence(evidence: Evidence): void {
    this.db
      .prepare(`
        INSERT INTO evidence (
          id, project_id, task_id, attempt_id, evidence_type, storage_type,
          file_path, hash, byte_size, content_type, summary, raw_payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        evidence.id,
        evidence.project_id,
        evidence.task_id,
        evidence.attempt_id,
        evidence.evidence_type,
        evidence.storage_type,
        evidence.file_path,
        evidence.hash,
        evidence.byte_size,
        evidence.content_type,
        evidence.summary,
        evidence.raw_payload,
        evidence.created_at
      );
  }

  public getEvidenceByTask(taskId: string): Evidence[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence WHERE task_id = ? ORDER BY created_at DESC')
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      project_id: String(r.project_id),
      task_id: r.task_id ? String(r.task_id) : null,
      attempt_id: r.attempt_id ? String(r.attempt_id) : null,
      evidence_type: r.evidence_type as any,
      storage_type: r.storage_type as any,
      file_path: r.file_path ? String(r.file_path) : null,
      hash: String(r.hash),
      byte_size: Number(r.byte_size),
      content_type: String(r.content_type),
      summary: String(r.summary),
      raw_payload: r.raw_payload ? String(r.raw_payload) : null,
      created_at: String(r.created_at),
    }));
  }

  public getAllEvidence(projectId: string): Evidence[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      project_id: String(r.project_id),
      task_id: r.task_id ? String(r.task_id) : null,
      attempt_id: r.attempt_id ? String(r.attempt_id) : null,
      evidence_type: r.evidence_type as any,
      storage_type: r.storage_type as any,
      file_path: r.file_path ? String(r.file_path) : null,
      hash: String(r.hash),
      byte_size: Number(r.byte_size),
      content_type: String(r.content_type),
      summary: String(r.summary),
      raw_payload: r.raw_payload ? String(r.raw_payload) : null,
      created_at: String(r.created_at),
    }));
  }

  public getEvidenceByProject(projectId: string): Evidence[] {
    return this.getAllEvidence(projectId);
  }

  // ==========================================
  // Reviews & Issues
  // ==========================================
  public createReview(review: Review): void {
    this.db
      .prepare(`
        INSERT INTO reviews (id, task_id, attempt_id, reviewer_agent_id, verdict, summary, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        review.id,
        review.task_id,
        review.attempt_id,
        review.reviewer_agent_id,
        review.verdict,
        review.summary,
        review.created_at
      );

    if (review.issues && review.issues.length > 0) {
      const stmt = this.db.prepare(`
        INSERT INTO review_issues (id, review_id, severity, title, file_path, line_number, description, resolved)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `);
      for (const issue of review.issues) {
        stmt.run(
          issue.id,
          review.id,
          issue.severity,
          issue.title,
          issue.file_path ?? null,
          issue.line_number ?? null,
          issue.description
        );
      }
    }
  }

  public getReviewsByTask(taskId: string): Review[] {
    const reviews = this.db
      .prepare('SELECT * FROM reviews WHERE task_id = ? ORDER BY created_at DESC')
      .all(taskId) as Record<string, unknown>[];

    return reviews.map((r) => {
      const issues = this.db
        .prepare('SELECT * FROM review_issues WHERE review_id = ?')
        .all(r.id) as Record<string, unknown>[];
      return {
        id: String(r.id),
        task_id: String(r.task_id),
        attempt_id: r.attempt_id ? String(r.attempt_id) : null,
        reviewer_agent_id: r.reviewer_agent_id ? String(r.reviewer_agent_id) : null,
        verdict: r.verdict as any,
        summary: String(r.summary),
        issues: issues.map((i) => ({
          id: String(i.id),
          review_id: String(i.review_id),
          severity: i.severity as any,
          title: String(i.title),
          file_path: i.file_path ? String(i.file_path) : null,
          line_number: i.line_number ? Number(i.line_number) : null,
          description: String(i.description),
          resolved: Boolean(i.resolved),
        })),
        created_at: String(r.created_at),
      };
    });
  }

  // ==========================================
  // Events (Audit Stream)
  // ==========================================
  public createEvent(event: EventRecord): void {
    this.db
      .prepare(`
        INSERT INTO events (id, project_id, task_id, agent_id, type, summary, structured_payload_json, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.project_id,
        event.task_id,
        event.agent_id,
        event.type,
        event.summary,
        JSON.stringify(event.structured_payload),
        event.timestamp
      );
  }

  public getEvents(projectId?: string, limit: number = 100): EventRecord[] {
    let query = 'SELECT * FROM events';
    const params: unknown[] = [];
    if (projectId) {
      query += ' WHERE project_id = ?';
      params.push(projectId);
    }
    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      project_id: String(r.project_id),
      task_id: r.task_id ? String(r.task_id) : null,
      agent_id: r.agent_id ? String(r.agent_id) : null,
      type: String(r.type),
      summary: String(r.summary),
      structured_payload: r.structured_payload_json ? JSON.parse(String(r.structured_payload_json)) : {},
      timestamp: String(r.timestamp),
    }));
  }

  public getEventsByProject(projectId: string, limit: number = 100): EventRecord[] {
    return this.getEvents(projectId, limit);
  }

  // ==========================================
  // Checkpoints & Handoffs
  // ==========================================
  public createCheckpoint(cp: Checkpoint): void {
    this.db
      .prepare(`
        INSERT INTO checkpoints (
          id, task_id, attempt_id, sha, tree_metadata_json, completed_steps_json,
          remaining_steps_json, tests_passing, tests_failing, known_issues_json,
          recommended_next_action, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        cp.id,
        cp.task_id,
        cp.attempt_id,
        cp.sha,
        JSON.stringify(cp.tree_metadata),
        JSON.stringify(cp.completed_steps),
        JSON.stringify(cp.remaining_steps),
        cp.tests_passing,
        cp.tests_failing,
        JSON.stringify(cp.known_issues),
        cp.recommended_next_action,
        cp.created_at
      );
  }

  public getCheckpointsByTask(taskId: string): Checkpoint[] {
    const rows = this.db
      .prepare('SELECT * FROM checkpoints WHERE task_id = ? ORDER BY created_at DESC')
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      task_id: String(r.task_id),
      attempt_id: r.attempt_id ? String(r.attempt_id) : null,
      sha: String(r.sha),
      tree_metadata: r.tree_metadata_json ? JSON.parse(String(r.tree_metadata_json)) : {},
      completed_steps: r.completed_steps_json ? JSON.parse(String(r.completed_steps_json)) : [],
      remaining_steps: r.remaining_steps_json ? JSON.parse(String(r.remaining_steps_json)) : [],
      tests_passing: Number(r.tests_passing),
      tests_failing: Number(r.tests_failing),
      known_issues: r.known_issues_json ? JSON.parse(String(r.known_issues_json)) : [],
      recommended_next_action: r.recommended_next_action ? String(r.recommended_next_action) : null,
      created_at: String(r.created_at),
    }));
  }

  public createHandoff(h: Handoff): void {
    this.db
      .prepare(`
        INSERT INTO handoffs (id, task_id, attempt_id, previous_agent_id, reason, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(h.id, h.task_id, h.attempt_id, h.previous_agent_id, h.reason, JSON.stringify(h.payload), h.created_at);
  }

  public getAgent(id: string): Agent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      display_name: String(row.display_name),
      role: row.role as any,
      provider_resource_id: row.provider_resource_id ? String(row.provider_resource_id) : null,
      status: row.status as any,
      current_task_id: row.current_task_id ? String(row.current_task_id) : null,
      last_seen_at: String(row.last_seen_at),
    };
  }

  // ==========================================
  // Verification Commands
  // ==========================================
  public createVerificationCommand(cmd: {
    id: string;
    project_id: string;
    name: string;
    command_type: string;
    executable: string;
    args: string[];
    timeout_ms?: number;
    enabled?: boolean;
  }): void {
    this.db
      .prepare(`
        INSERT INTO verification_commands (id, project_id, name, command_type, executable, args_json, timeout_ms, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        cmd.id,
        cmd.project_id,
        cmd.name,
        cmd.command_type,
        cmd.executable,
        JSON.stringify(cmd.args),
        cmd.timeout_ms ?? 60000,
        cmd.enabled !== false ? 1 : 0
      );
  }

  public getVerificationCommandsByProject(projectId: string): any[] {
    const rows = this.db
      .prepare('SELECT * FROM verification_commands WHERE project_id = ? AND enabled = 1')
      .all(projectId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      project_id: String(r.project_id),
      name: String(r.name),
      command_type: String(r.command_type),
      executable: String(r.executable),
      args: r.args_json ? JSON.parse(String(r.args_json)) : [],
      timeout_ms: Number(r.timeout_ms),
      enabled: Boolean(r.enabled),
    }));
  }

  public getVerificationCommandById(id: string): any | null {
    const row = this.db.prepare('SELECT * FROM verification_commands WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      project_id: String(row.project_id),
      name: String(row.name),
      command_type: String(row.command_type),
      executable: String(row.executable),
      args: row.args_json ? JSON.parse(String(row.args_json)) : [],
      timeout_ms: Number(row.timeout_ms),
      enabled: Boolean(row.enabled),
    };
  }

  // ==========================================
  // Test Runs
  // ==========================================
  public createTestRun(testRun: TestRun): void {
    this.db
      .prepare(`
        INSERT INTO test_runs (id, task_id, command, passed_count, failed_count, skipped_count, duration_ms, exit_code, evidence_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        testRun.id,
        testRun.task_id,
        testRun.command,
        testRun.passed_count,
        testRun.failed_count,
        testRun.skipped_count,
        testRun.duration_ms,
        testRun.exit_code,
        testRun.evidence_id,
        testRun.created_at
      );
  }

  public getLatestTestRun(taskId: string): TestRun | null {
    const row = this.db
      .prepare('SELECT * FROM test_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      task_id: String(row.task_id),
      command: String(row.command),
      passed_count: Number(row.passed_count),
      failed_count: Number(row.failed_count),
      skipped_count: Number(row.skipped_count),
      duration_ms: Number(row.duration_ms),
      exit_code: Number(row.exit_code),
      evidence_id: row.evidence_id ? String(row.evidence_id) : null,
      created_at: String(row.created_at),
    };
  }

  public getLatestEvidence(taskId: string, evidenceType: string): Evidence | null {
    const row = this.db
      .prepare('SELECT * FROM evidence WHERE task_id = ? AND evidence_type = ? ORDER BY created_at DESC LIMIT 1')
      .get(taskId, evidenceType) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      project_id: String(row.project_id),
      task_id: row.task_id ? String(row.task_id) : null,
      attempt_id: row.attempt_id ? String(row.attempt_id) : null,
      evidence_type: row.evidence_type as any,
      storage_type: row.storage_type as any,
      file_path: row.file_path ? String(row.file_path) : null,
      hash: String(row.hash),
      byte_size: Number(row.byte_size),
      content_type: String(row.content_type),
      summary: String(row.summary),
      raw_payload: row.raw_payload ? String(row.raw_payload) : null,
      created_at: String(row.created_at),
    };
  }

  // ==========================================
  // Process Runs
  // ==========================================
  public createProcessRun(run: {
    id: string;
    pid: number | null;
    command: string;
    working_directory: string;
    status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
    start_time: string;
  }): void {
    this.db
      .prepare(`
        INSERT INTO process_runs (id, pid, command, working_directory, status, start_time, end_time, exit_code, stdout_evidence_id, stderr_evidence_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)
      `)
      .run(run.id, run.pid, run.command, run.working_directory, run.status, run.start_time, run.start_time);
  }

  public updateProcessRunPid(id: string, pid: number): void {
    this.db.prepare('UPDATE process_runs SET pid = ? WHERE id = ?').run(pid, id);
  }

  public updateProcessRun(
    id: string,
    status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT',
    exitCode: number | null,
    endTime: string,
    stdoutEvidenceId?: string | null,
    stderrEvidenceId?: string | null
  ): void {
    this.db
      .prepare(`
        UPDATE process_runs
        SET status = ?, exit_code = ?, end_time = ?, stdout_evidence_id = COALESCE(?, stdout_evidence_id), stderr_evidence_id = COALESCE(?, stderr_evidence_id)
        WHERE id = ?
      `)
      .run(status, exitCode, endTime, stdoutEvidenceId ?? null, stderrEvidenceId ?? null, id);
  }

  public getProcessRun(id: string): any | null {
    const row = this.db.prepare('SELECT * FROM process_runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ?? null;
  }
}
