import crypto from 'crypto';
import Database from 'better-sqlite3';
import {
  Project,
  Task,
  TaskLease,
  TaskAttempt,
  Provider,
  ProviderResource,
  ProviderHealthStatus,
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
  ProjectStatus,
  ExecutionAuthorization,
  ExecutionAuthorizationStatus,
  RoleProfile,
  AgentProfile,
  ProviderAccount,
  WorkerSlot,
  AgentAssignment,
  AccountLease,
  RoutePolicy,
  SeparationPolicy,
  FabricRole,
  AccountAuthMode,
  WorkerSlotStatus,
  AgentAssignmentStatus,
  SeparationAffinity,
  Capability,
  RiskLevel,
  AgentSession,
  AgentSessionStatus,
  ProjectMemory,
  ProjectMemoryType,
  TaskMemory,
  TaskMemoryType,
  ContextSnapshot,
  ContextSnapshotPurpose,
  ContextItem,
  ContextItemType,
  ContextManifest,
  HandoffContext,
  HandoffContextStatus,
  FailoverTransition,
  FailoverSuccessorClaimResult,
  ClaimSuccessorParams,
  ProviderHealthObservation
} from '../types/domain';
import {
  computeSha256,
  canonicalJsonStringify,
  computeSnapshotContentHash,
  computeManifestPayloadAndHash,
  assertConsistentAttemptBindings,
} from '../context/ContextIntegrity';
import {
  parseCredentialRef,
  parseNativeProfileRef,
} from '../credentials';

export class Repository {
  constructor(private db: Database.Database) {}

  public runInTransaction<T>(fn: () => T): T {
    const tx = this.db.transaction(fn);
    return tx();
  }

  public runInImmediateTransaction<T>(fn: () => T): T {
    const tx = this.db.transaction(fn);
    return tx.immediate();
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
  // Task Attempts
  // ==========================================
  public createTaskAttempt(attempt: TaskAttempt): void {
    this.db
      .prepare(`
        INSERT INTO task_attempts (id, task_id, attempt_number, agent_id, status, started_at, ended_at, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        attempt.id,
        attempt.task_id,
        attempt.attempt_number,
        attempt.agent_id,
        attempt.status,
        attempt.started_at,
        attempt.ended_at,
        attempt.summary
      );
  }

  public getTaskAttempt(id: string): TaskAttempt | null {
    const row = this.db.prepare('SELECT * FROM task_attempts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      task_id: String(row.task_id),
      attempt_number: Number(row.attempt_number),
      agent_id: String(row.agent_id),
      status: row.status as any,
      started_at: String(row.started_at),
      ended_at: row.ended_at ? String(row.ended_at) : null,
      summary: row.summary ? String(row.summary) : null,
    };
  }

  public getTaskAttemptsByTask(taskId: string): TaskAttempt[] {
    const rows = this.db.prepare('SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt_number ASC').all(taskId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      task_id: String(r.task_id),
      attempt_number: Number(r.attempt_number),
      agent_id: String(r.agent_id),
      status: r.status as any,
      started_at: String(r.started_at),
      ended_at: r.ended_at ? String(r.ended_at) : null,
      summary: r.summary ? String(r.summary) : null,
    }));
  }

  // ==========================================
  // Failover Transitions (Durable Whole-Attempt Lineage)
  // ==========================================
  public getFailoverTransition(id: string): FailoverTransition | null {
    const row = this.db
      .prepare('SELECT * FROM failover_transitions WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      task_id: String(row.task_id),
      root_attempt_id: String(row.root_attempt_id),
      source_attempt_id: String(row.source_attempt_id),
      successor_attempt_id: String(row.successor_attempt_id),
      failover_ordinal: Number(row.failover_ordinal),
      created_at: String(row.created_at),
    };
  }

  public getFailoverTransitionBySource(sourceAttemptId: string): FailoverTransition | null {
    const row = this.db
      .prepare('SELECT * FROM failover_transitions WHERE source_attempt_id = ?')
      .get(sourceAttemptId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      task_id: String(row.task_id),
      root_attempt_id: String(row.root_attempt_id),
      source_attempt_id: String(row.source_attempt_id),
      successor_attempt_id: String(row.successor_attempt_id),
      failover_ordinal: Number(row.failover_ordinal),
      created_at: String(row.created_at),
    };
  }

  public getFailoverTransitionBySuccessor(successorAttemptId: string): FailoverTransition | null {
    const row = this.db
      .prepare('SELECT * FROM failover_transitions WHERE successor_attempt_id = ?')
      .get(successorAttemptId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      task_id: String(row.task_id),
      root_attempt_id: String(row.root_attempt_id),
      source_attempt_id: String(row.source_attempt_id),
      successor_attempt_id: String(row.successor_attempt_id),
      failover_ordinal: Number(row.failover_ordinal),
      created_at: String(row.created_at),
    };
  }

  public getFailoverTransitionsByTask(taskId: string): FailoverTransition[] {
    const rows = this.db
      .prepare('SELECT * FROM failover_transitions WHERE task_id = ? ORDER BY failover_ordinal ASC')
      .all(taskId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      task_id: String(row.task_id),
      root_attempt_id: String(row.root_attempt_id),
      source_attempt_id: String(row.source_attempt_id),
      successor_attempt_id: String(row.successor_attempt_id),
      failover_ordinal: Number(row.failover_ordinal),
      created_at: String(row.created_at),
    }));
  }

  public getFailoverTransitionsByRoot(rootAttemptId: string): FailoverTransition[] {
    const rows = this.db
      .prepare('SELECT * FROM failover_transitions WHERE root_attempt_id = ? ORDER BY failover_ordinal ASC')
      .all(rootAttemptId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      task_id: String(row.task_id),
      root_attempt_id: String(row.root_attempt_id),
      source_attempt_id: String(row.source_attempt_id),
      successor_attempt_id: String(row.successor_attempt_id),
      failover_ordinal: Number(row.failover_ordinal),
      created_at: String(row.created_at),
    }));
  }

  public claimSuccessorTaskAttempt(params: ClaimSuccessorParams): FailoverSuccessorClaimResult {
    // A. Validate input fields
    if (
      !params ||
      typeof params !== 'object' ||
      typeof params.transitionId !== 'string' ||
      params.transitionId.trim().length === 0 ||
      params.transitionId !== params.transitionId.trim() ||
      typeof params.sourceAttemptId !== 'string' ||
      params.sourceAttemptId.trim().length === 0 ||
      params.sourceAttemptId !== params.sourceAttemptId.trim() ||
      typeof params.successorAttemptId !== 'string' ||
      params.successorAttemptId.trim().length === 0 ||
      params.successorAttemptId !== params.successorAttemptId.trim()
    ) {
      return {
        status: 'INVALID_INPUT',
        error: 'INVALID_INPUT: transitionId, sourceAttemptId, and successorAttemptId must be non-empty strings without surrounding whitespace.',
      };
    }

    if (params.sourceAttemptId === params.successorAttemptId) {
      return {
        status: 'INVALID_INPUT',
        error: 'INVALID_INPUT: sourceAttemptId and successorAttemptId cannot be identical.',
      };
    }

    return this.runInImmediateTransaction<FailoverSuccessorClaimResult>(() => {
      // B. Load source TaskAttempt
      const sourceAttempt = this.getTaskAttempt(params.sourceAttemptId);
      if (!sourceAttempt) {
        return {
          status: 'SOURCE_NOT_FOUND',
          error: `Source TaskAttempt "${params.sourceAttemptId}" not found.`,
        };
      }

      // C. Check existing transition by source_attempt_id (Idempotency authority)
      const existingTransition = this.getFailoverTransitionBySource(params.sourceAttemptId);
      if (existingTransition) {
        if (
          existingTransition.source_attempt_id !== sourceAttempt.id ||
          existingTransition.task_id !== sourceAttempt.task_id ||
          existingTransition.failover_ordinal < 1
        ) {
          throw new Error(
            `[FailoverLineageIntegrity] Corrupt existing transition "${existingTransition.id}" for source "${params.sourceAttemptId}": task or ordinal mismatch.`
          );
        }
        const existingSuccessor = this.getTaskAttempt(existingTransition.successor_attempt_id);
        if (!existingSuccessor || existingSuccessor.task_id !== sourceAttempt.task_id) {
          throw new Error(
            `[FailoverLineageIntegrity] Corrupt existing transition "${existingTransition.id}": successor "${existingTransition.successor_attempt_id}" missing or task mismatch.`
          );
        }
        const existingRoot = this.getTaskAttempt(existingTransition.root_attempt_id);
        if (!existingRoot || existingRoot.task_id !== sourceAttempt.task_id) {
          throw new Error(
            `[FailoverLineageIntegrity] Corrupt existing transition "${existingTransition.id}": root "${existingTransition.root_attempt_id}" missing or task mismatch.`
          );
        }
        return {
          status: 'ALREADY_CLAIMED',
          transition: existingTransition,
          successorAttempt: existingSuccessor,
        };
      }

      // D. Check ID conflicts
      const existingTransitionById = this.getFailoverTransition(params.transitionId);
      if (existingTransitionById) {
        return {
          status: 'TRANSITION_ID_CONFLICT',
          error: `Transition with ID "${params.transitionId}" already exists.`,
        };
      }

      const existingTaskAttemptById = this.getTaskAttempt(params.successorAttemptId);
      if (existingTaskAttemptById) {
        return {
          status: 'SUCCESSOR_ID_CONFLICT',
          error: `TaskAttempt with ID "${params.successorAttemptId}" already exists.`,
        };
      }

      const existingTransitionBySuccessor = this.getFailoverTransitionBySuccessor(params.successorAttemptId);
      if (existingTransitionBySuccessor) {
        return {
          status: 'SUCCESSOR_ID_CONFLICT',
          error: `Transition with successor_attempt_id "${params.successorAttemptId}" already exists.`,
        };
      }

      // E. Determine predecessor transition where successor_attempt_id = sourceAttemptId
      const predecessorTransition = this.getFailoverTransitionBySuccessor(params.sourceAttemptId);
      let rootAttemptId: string;
      let failoverOrdinal: number;

      if (!predecessorTransition) {
        rootAttemptId = params.sourceAttemptId;
        failoverOrdinal = 1;
      } else {
        if (
          predecessorTransition.successor_attempt_id !== sourceAttempt.id ||
          predecessorTransition.task_id !== sourceAttempt.task_id ||
          predecessorTransition.failover_ordinal < 1
        ) {
          throw new Error(
            `[FailoverLineageIntegrity] Malformed predecessor transition "${predecessorTransition.id}": task, successor, or ordinal mismatch.`
          );
        }
        const predecessorSource = this.getTaskAttempt(predecessorTransition.source_attempt_id);
        if (!predecessorSource || predecessorSource.task_id !== sourceAttempt.task_id) {
          throw new Error(
            `[FailoverLineageIntegrity] Malformed predecessor transition "${predecessorTransition.id}": source attempt "${predecessorTransition.source_attempt_id}" missing or task mismatch.`
          );
        }
        const predecessorRoot = this.getTaskAttempt(predecessorTransition.root_attempt_id);
        if (!predecessorRoot || predecessorRoot.task_id !== sourceAttempt.task_id) {
          throw new Error(
            `[FailoverLineageIntegrity] Malformed predecessor transition "${predecessorTransition.id}": root attempt "${predecessorTransition.root_attempt_id}" missing or task mismatch.`
          );
        }

        rootAttemptId = predecessorTransition.root_attempt_id;
        failoverOrdinal = predecessorTransition.failover_ordinal + 1;
      }

      // F. Compute next TaskAttempt attempt_number INSIDE the immediate transaction
      const maxRow = this.db
        .prepare(`SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_attempt_number FROM task_attempts WHERE task_id = ?`)
        .get(sourceAttempt.task_id) as { next_attempt_number: number };
      const nextAttemptNumber = Number(maxRow.next_attempt_number);

      const nowIso = params.createdAt ?? new Date().toISOString();
      const startedAt = params.startedAt ?? nowIso;
      const status = params.status ?? 'PENDING';

      // G. Create successor TaskAttempt
      const successorAttempt: TaskAttempt = {
        id: params.successorAttemptId,
        task_id: sourceAttempt.task_id,
        attempt_number: nextAttemptNumber,
        agent_id: sourceAttempt.agent_id,
        status,
        started_at: startedAt,
        ended_at: params.endedAt ?? null,
        summary: params.summary ?? null,
      };

      this.db
        .prepare(`
          INSERT INTO task_attempts (id, task_id, attempt_number, agent_id, status, started_at, ended_at, summary)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          successorAttempt.id,
          successorAttempt.task_id,
          successorAttempt.attempt_number,
          successorAttempt.agent_id,
          successorAttempt.status,
          successorAttempt.started_at,
          successorAttempt.ended_at,
          successorAttempt.summary
        );

      // H. Create failover transition
      const transition: FailoverTransition = {
        id: params.transitionId,
        task_id: sourceAttempt.task_id,
        root_attempt_id: rootAttemptId,
        source_attempt_id: params.sourceAttemptId,
        successor_attempt_id: params.successorAttemptId,
        failover_ordinal: failoverOrdinal,
        created_at: nowIso,
      };

      this.db
        .prepare(`
          INSERT INTO failover_transitions (id, task_id, root_attempt_id, source_attempt_id, successor_attempt_id, failover_ordinal, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          transition.id,
          transition.task_id,
          transition.root_attempt_id,
          transition.source_attempt_id,
          transition.successor_attempt_id,
          transition.failover_ordinal,
          transition.created_at
        );

      return {
        status: 'CREATED',
        transition,
        successorAttempt,
      };
    });
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
    rejectionReason?: string,
    createdAt?: string
  ): void {
    const now = createdAt ?? new Date().toISOString();
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

  public getProtocolMessageByRecordId(id: string): Record<string, unknown> | null {
    const row = this.db.prepare('SELECT * FROM protocol_messages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  public getProtocolMessagesByTask(taskId: string): Record<string, unknown>[] {
    return this.db
      .prepare('SELECT * FROM protocol_messages WHERE task_id = ? ORDER BY created_at ASC, id ASC')
      .all(taskId) as Record<string, unknown>[];
  }

  public getLatestAppliedManagerProtocolMessage(taskId: string, projectId?: string): Record<string, unknown> | null {
    if (projectId) {
      const row = this.db
        .prepare(`
          SELECT * FROM protocol_messages
          WHERE task_id = ?
            AND project_id = ?
            AND protocol = 'manager.v1'
            AND status = 'APPLIED'
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        `)
        .get(taskId, projectId) as Record<string, unknown> | undefined;
      return row ?? null;
    }
    const row = this.db
        .prepare(`
          SELECT * FROM protocol_messages
          WHERE task_id = ?
            AND protocol = 'manager.v1'
            AND status = 'APPLIED'
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        `)
      .get(taskId) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  // ==========================================
  // Providers & Provider Resources
  // ==========================================
  public createProvider(provider: Provider): void {
    this.db
      .prepare('INSERT INTO providers (id, name, adapter_type, enabled, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(provider.id, provider.name, provider.adapter_type, provider.enabled ? 1 : 0, provider.created_at);
  }

  public getProvider(id: string): Provider | null {
    const row = this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      name: String(row.name),
      adapter_type: row.adapter_type as any,
      enabled: Boolean(row.enabled),
      created_at: String(row.created_at),
    };
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
    if (resource.provider_account_id) {
      const provider = this.getProvider(resource.provider_id);
      if (!provider) {
        throw new Error(`Provider '${resource.provider_id}' not found for resource '${resource.id}'`);
      }
      const account = this.getProviderAccount(resource.provider_account_id);
      if (!account) {
        throw new Error(`Provider account '${resource.provider_account_id}' not found for resource '${resource.id}'`);
      }
      if (account.provider_id !== resource.provider_id) {
        throw new Error(
          `Provider mismatch: Resource provider '${resource.provider_id}' does not match Account provider '${account.provider_id}'`
        );
      }
    }

    this.db
      .prepare(`
        INSERT INTO provider_resources (
          id, provider_id, provider_account_id, model_name, health_status, capabilities_json, enabled,
          total_quota, remaining_quota, quota_unit, quota_reset_at, quota_source,
          quota_confidence, last_health_check
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        resource.id,
        resource.provider_id,
        resource.provider_account_id ?? null,
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

  public getProviderResource(id: string): ProviderResource | null {
    const row = this.db.prepare('SELECT * FROM provider_resources WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      provider_id: String(row.provider_id),
      provider_account_id: row.provider_account_id ? String(row.provider_account_id) : null,
      model_name: String(row.model_name),
      health_status: row.health_status as any,
      capabilities: row.capabilities_json ? JSON.parse(String(row.capabilities_json)) : [],
      enabled: Boolean(row.enabled),
      total_quota: row.total_quota !== null ? Number(row.total_quota) : null,
      remaining_quota: row.remaining_quota !== null ? Number(row.remaining_quota) : null,
      quota_unit: String(row.quota_unit),
      quota_reset_at: row.quota_reset_at ? String(row.quota_reset_at) : null,
      quota_source: row.quota_source as any,
      quota_confidence: Number(row.quota_confidence),
      last_health_check: row.last_health_check ? String(row.last_health_check) : null,
    };
  }

  public getProviderResourcesByAccount(accountId: string): ProviderResource[] {
    const rows = this.db.prepare('SELECT * FROM provider_resources WHERE provider_account_id = ? ORDER BY model_name ASC').all(accountId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      provider_id: String(r.provider_id),
      provider_account_id: r.provider_account_id ? String(r.provider_account_id) : null,
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
      last_health_check: r.last_health_check ? String(r.last_health_check) : null,
    }));
  }

  public getAllProviderResources(): ProviderResource[] {
    const rows = this.db.prepare('SELECT * FROM provider_resources ORDER BY model_name ASC').all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      provider_id: String(r.provider_id),
      provider_account_id: r.provider_account_id ? String(r.provider_account_id) : null,
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
      last_health_check: r.last_health_check ? String(r.last_health_check) : null,
    }));
  }

  public updateProviderResourceAccount(id: string, accountId: string | null): void {
    const resource = this.getProviderResource(id);
    if (!resource) {
      throw new Error(`Provider resource '${id}' not found`);
    }
    if (accountId !== null) {
      const account = this.getProviderAccount(accountId);
      if (!account) {
        throw new Error(`Provider account '${accountId}' not found`);
      }
      if (account.provider_id !== resource.provider_id) {
        throw new Error(
          `Provider mismatch: Resource provider '${resource.provider_id}' does not match Account provider '${account.provider_id}'`
        );
      }
    }

    this.db
      .prepare('UPDATE provider_resources SET provider_account_id = ? WHERE id = ?')
      .run(accountId, id);
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

  public getEvidenceById(id: string): Evidence | null {
    const r = this.db.prepare('SELECT * FROM evidence WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
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
    };
  }

  public getEvidence(id: string): Evidence | null {
    return this.getEvidenceById(id);
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

  public getEvent(id: string): EventRecord | null {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      project_id: String(row.project_id),
      task_id: row.task_id ? String(row.task_id) : null,
      agent_id: row.agent_id ? String(row.agent_id) : null,
      type: String(row.type),
      summary: String(row.summary),
      structured_payload: row.structured_payload_json ? JSON.parse(String(row.structured_payload_json)) : {},
      timestamp: String(row.timestamp),
    };
  }

  public getRoutingDecisionEvent(decisionId: string): EventRecord | null {
    const row = this.db
      .prepare(`
        SELECT * FROM events
        WHERE type = 'PROVIDER_ROUTING_DECISION'
          AND (id = ? OR json_extract(structured_payload_json, '$.decisionId') = ?)
        ORDER BY timestamp DESC
        LIMIT 1
      `)
      .get(decisionId, decisionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      project_id: String(row.project_id),
      task_id: row.task_id ? String(row.task_id) : null,
      agent_id: row.agent_id ? String(row.agent_id) : null,
      type: String(row.type),
      summary: String(row.summary),
      structured_payload: row.structured_payload_json ? JSON.parse(String(row.structured_payload_json)) : {},
      timestamp: String(row.timestamp),
    };
  }

  public getLatestRoutingDecisionEventByTask(projectId: string, taskId: string): EventRecord | null {
    const row = this.db
      .prepare(`
        SELECT * FROM events
        WHERE project_id = ?
          AND task_id = ?
          AND type = 'PROVIDER_ROUTING_DECISION'
        ORDER BY timestamp DESC, rowid DESC
        LIMIT 1
      `)
      .get(projectId, taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      project_id: String(row.project_id),
      task_id: row.task_id ? String(row.task_id) : null,
      agent_id: row.agent_id ? String(row.agent_id) : null,
      type: String(row.type),
      summary: String(row.summary),
      structured_payload: row.structured_payload_json ? JSON.parse(String(row.structured_payload_json)) : {},
      timestamp: String(row.timestamp),
    };
  }

  // ==========================================
  // Execution Authorizations (PR #7)
  // ==========================================
  public createExecutionAuthorization(auth: ExecutionAuthorization): void {
    this.db
      .prepare(`
        INSERT INTO execution_authorizations (
          id, project_id, task_id, attempt_id, task_revision, base_sha,
          repository_head_sha, manager_message_id, manager_payload_hash,
          routing_decision_id, selected_resource_id, selected_provider_id,
          instruction_payload_hash, context_manifest_hash,
          canonical_instructions_json, context_files_json, canonical_payload_json, status,
          created_at, dispatched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        auth.id,
        auth.project_id,
        auth.task_id,
        auth.attempt_id,
        auth.task_revision,
        auth.base_sha,
        auth.repository_head_sha,
        auth.manager_message_id,
        auth.manager_payload_hash,
        auth.routing_decision_id,
        auth.selected_resource_id,
        auth.selected_provider_id,
        auth.instruction_payload_hash,
        auth.context_manifest_hash,
        auth.canonical_instructions_json,
        auth.context_files_json,
        auth.canonical_payload_json ?? null,
        auth.status,
        auth.created_at,
        auth.dispatched_at
      );
  }

  public getExecutionAuthorization(id: string): ExecutionAuthorization | null {
    const row = this.db.prepare('SELECT * FROM execution_authorizations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      project_id: String(row.project_id),
      task_id: String(row.task_id),
      attempt_id: row.attempt_id ? String(row.attempt_id) : null,
      task_revision: Number(row.task_revision),
      base_sha: String(row.base_sha),
      repository_head_sha: String(row.repository_head_sha),
      manager_message_id: String(row.manager_message_id),
      manager_payload_hash: String(row.manager_payload_hash),
      routing_decision_id: String(row.routing_decision_id),
      selected_resource_id: String(row.selected_resource_id),
      selected_provider_id: String(row.selected_provider_id),
      instruction_payload_hash: String(row.instruction_payload_hash),
      context_manifest_hash: String(row.context_manifest_hash),
      canonical_instructions_json: String(row.canonical_instructions_json),
      context_files_json: String(row.context_files_json),
      canonical_payload_json: row.canonical_payload_json != null ? String(row.canonical_payload_json) : null,
      status: row.status as ExecutionAuthorizationStatus,
      created_at: String(row.created_at),
      dispatched_at: row.dispatched_at ? String(row.dispatched_at) : null,
    };
  }

  public claimExecutionAuthorization(id: string, dispatchedAt: string): boolean {
    const res = this.db
      .prepare(`
        UPDATE execution_authorizations
        SET status = 'DISPATCHED', dispatched_at = ?
        WHERE id = ? AND status = 'AUTHORIZED'
      `)
      .run(dispatchedAt, id);
    return res.changes === 1;
  }

  public invalidateExecutionAuthorization(id: string): boolean {
    const res = this.db
      .prepare(`
        UPDATE execution_authorizations
        SET status = 'INVALIDATED'
        WHERE id = ? AND status = 'AUTHORIZED'
      `)
      .run(id);
    return res.changes === 1;
  }

  public invalidateAuthorizedExecutionAuthorizationsForTask(taskId: string): number {
    const res = this.db
      .prepare(`
        UPDATE execution_authorizations
        SET status = 'INVALIDATED'
        WHERE task_id = ? AND status = 'AUTHORIZED'
      `)
      .run(taskId);
    return res.changes;
  }

  public updateExecutionAuthorizationStatus(id: string, status: ExecutionAuthorizationStatus): void {
    this.db
      .prepare(`
        UPDATE execution_authorizations
        SET status = ?
        WHERE id = ?
      `)
      .run(status, id);
  }

  public getExecutionAuthorizationsByTask(taskId: string): ExecutionAuthorization[] {
    const rows = this.db
      .prepare('SELECT * FROM execution_authorizations WHERE task_id = ? ORDER BY created_at DESC')
      .all(taskId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      project_id: String(row.project_id),
      task_id: String(row.task_id),
      attempt_id: row.attempt_id ? String(row.attempt_id) : null,
      task_revision: Number(row.task_revision),
      base_sha: String(row.base_sha),
      repository_head_sha: String(row.repository_head_sha),
      manager_message_id: String(row.manager_message_id),
      manager_payload_hash: String(row.manager_payload_hash),
      routing_decision_id: String(row.routing_decision_id),
      selected_resource_id: String(row.selected_resource_id),
      selected_provider_id: String(row.selected_provider_id),
      instruction_payload_hash: String(row.instruction_payload_hash),
      context_manifest_hash: String(row.context_manifest_hash),
      canonical_instructions_json: String(row.canonical_instructions_json),
      context_files_json: String(row.context_files_json),
      canonical_payload_json: row.canonical_payload_json != null ? String(row.canonical_payload_json) : null,
      status: row.status as ExecutionAuthorizationStatus,
      created_at: String(row.created_at),
      dispatched_at: row.dispatched_at ? String(row.dispatched_at) : null,
    }));
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

  public setProjectVerificationCommands(
    projectId: string,
    commands: {
      TEST?: { executable: string; args: string[] } | null;
      LINT?: { executable: string; args: string[] } | null;
      BUILD?: { executable: string; args: string[] } | null;
    }
  ): any[] {
    return this.runInTransaction(() => {
      const managedTypes: Array<'TEST' | 'LINT' | 'BUILD'> = ['TEST', 'LINT', 'BUILD'];

      for (const type of managedTypes) {
        if (type in commands) {
          const cmdData = commands[type];
          if (cmdData) {
            const existing = this.db
              .prepare('SELECT id FROM verification_commands WHERE project_id = ? AND command_type = ?')
              .get(projectId, type) as { id: string } | undefined;

            if (existing) {
              this.db
                .prepare(`
                  UPDATE verification_commands
                  SET executable = ?, args_json = ?, timeout_ms = 120000, enabled = 1
                  WHERE id = ?
                `)
                .run(cmdData.executable, JSON.stringify(cmdData.args), existing.id);
            } else {
              const id = `vc-${crypto.randomUUID().substring(0, 8)}`;
              const typeName = `${type.charAt(0) + type.slice(1).toLowerCase()} Suite`;
              this.db
                .prepare(`
                  INSERT INTO verification_commands (id, project_id, name, command_type, executable, args_json, timeout_ms, enabled)
                  VALUES (?, ?, ?, ?, ?, ?, 120000, 1)
                `)
                .run(id, projectId, typeName, type, cmdData.executable, JSON.stringify(cmdData.args));
            }
          } else {
            this.db
              .prepare('DELETE FROM verification_commands WHERE project_id = ? AND command_type = ?')
              .run(projectId, type);
          }
        }
      }

      return this.getVerificationCommandsByProject(projectId);
    });
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
      .prepare('SELECT * FROM test_runs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
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
      .prepare('SELECT * FROM evidence WHERE task_id = ? AND evidence_type = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
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
    project_id?: string | null;
    task_id?: string | null;
    attempt_id?: string | null;
    command: string;
    working_directory: string;
    status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
    start_time: string;
  }): void {
    this.db
      .prepare(`
        INSERT INTO process_runs (id, pid, project_id, task_id, attempt_id, command, working_directory, status, start_time, end_time, exit_code, stdout_evidence_id, stderr_evidence_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)
      `)
      .run(
        run.id,
        run.pid,
        run.project_id ?? null,
        run.task_id ?? null,
        run.attempt_id ?? null,
        run.command,
        run.working_directory,
        run.status,
        run.start_time,
        run.start_time
      );
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

  public getAllProcessRuns(): any[] {
    return this.db.prepare('SELECT * FROM process_runs ORDER BY start_time DESC').all();
  }

  public getProcessRunsByTask(taskId: string): any[] {
    return this.db
      .prepare('SELECT * FROM process_runs WHERE task_id = ? ORDER BY start_time DESC')
      .all(taskId);
  }

  public getProcessRunsByProject(projectId: string): any[] {
    return this.db
      .prepare('SELECT * FROM process_runs WHERE project_id = ? ORDER BY start_time DESC')
      .all(projectId);
  }

  // ==========================================
  // Role Profiles (R5A)
  // ==========================================
  public createRoleProfile(profile: RoleProfile): void {
    this.db
      .prepare(`
        INSERT INTO role_profiles (
          id, role, display_name, required_capabilities_json, preferred_capabilities_json,
          authority_scope_json, permissions_json, output_protocol, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        profile.id,
        profile.role,
        profile.display_name,
        JSON.stringify(profile.required_capabilities || []),
        JSON.stringify(profile.preferred_capabilities || []),
        profile.authority_scope ? JSON.stringify(profile.authority_scope) : null,
        JSON.stringify(profile.permissions || []),
        profile.output_protocol ?? null,
        profile.enabled ? 1 : 0,
        profile.created_at,
        profile.updated_at
      );
  }

  public getRoleProfile(id: string): RoleProfile | null {
    const row = this.db.prepare('SELECT * FROM role_profiles WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRoleProfile(row) : null;
  }

  public getRoleProfilesByRole(role: FabricRole): RoleProfile[] {
    const rows = this.db.prepare('SELECT * FROM role_profiles WHERE role = ? ORDER BY created_at ASC').all(role) as Record<string, unknown>[];
    return rows.map((r) => this.mapRoleProfile(r));
  }

  public getAllRoleProfiles(): RoleProfile[] {
    const rows = this.db.prepare('SELECT * FROM role_profiles ORDER BY role ASC, display_name ASC').all() as Record<string, unknown>[];
    return rows.map((r) => this.mapRoleProfile(r));
  }

  public updateRoleProfile(
    id: string,
    updates: Partial<Pick<RoleProfile, 'display_name' | 'required_capabilities' | 'preferred_capabilities' | 'authority_scope' | 'permissions' | 'output_protocol' | 'enabled'>>
  ): void {
    const existing = this.getRoleProfile(id);
    if (!existing) return;

    this.db
      .prepare(`
        UPDATE role_profiles
        SET display_name = ?,
            required_capabilities_json = ?,
            preferred_capabilities_json = ?,
            authority_scope_json = ?,
            permissions_json = ?,
            output_protocol = ?,
            enabled = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(
        updates.display_name ?? existing.display_name,
        updates.required_capabilities !== undefined ? JSON.stringify(updates.required_capabilities) : JSON.stringify(existing.required_capabilities),
        updates.preferred_capabilities !== undefined ? JSON.stringify(updates.preferred_capabilities) : JSON.stringify(existing.preferred_capabilities),
        updates.authority_scope !== undefined ? (updates.authority_scope ? JSON.stringify(updates.authority_scope) : null) : (existing.authority_scope ? JSON.stringify(existing.authority_scope) : null),
        updates.permissions !== undefined ? JSON.stringify(updates.permissions) : JSON.stringify(existing.permissions),
        updates.output_protocol !== undefined ? updates.output_protocol : existing.output_protocol,
        updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : (existing.enabled ? 1 : 0),
        new Date().toISOString(),
        id
      );
  }

  private mapRoleProfile(row: Record<string, unknown>): RoleProfile {
    return {
      id: String(row.id),
      role: row.role as FabricRole,
      display_name: String(row.display_name),
      required_capabilities: JSON.parse(String(row.required_capabilities_json)) as Capability[],
      preferred_capabilities: JSON.parse(String(row.preferred_capabilities_json)) as Capability[],
      authority_scope: row.authority_scope_json ? (JSON.parse(String(row.authority_scope_json)) as Record<string, unknown>) : null,
      permissions: JSON.parse(String(row.permissions_json)) as string[],
      output_protocol: row.output_protocol ? String(row.output_protocol) : null,
      enabled: Boolean(row.enabled),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  // ==========================================
  // Agent Profiles (R5A)
  // ==========================================
  public createAgentProfile(profile: AgentProfile): void {
    this.db
      .prepare(`
        INSERT INTO agent_profiles (
          id, role_profile_id, name, prompt_template, config_json, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        profile.id,
        profile.role_profile_id,
        profile.name,
        profile.prompt_template ?? null,
        profile.config ? JSON.stringify(profile.config) : null,
        profile.enabled ? 1 : 0,
        profile.created_at,
        profile.updated_at
      );
  }

  public getAgentProfile(id: string): AgentProfile | null {
    const row = this.db.prepare('SELECT * FROM agent_profiles WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapAgentProfile(row) : null;
  }

  public getAgentProfilesByRoleProfile(roleProfileId: string): AgentProfile[] {
    const rows = this.db.prepare('SELECT * FROM agent_profiles WHERE role_profile_id = ? ORDER BY name ASC').all(roleProfileId) as Record<string, unknown>[];
    return rows.map((r) => this.mapAgentProfile(r));
  }

  public getAllAgentProfiles(): AgentProfile[] {
    const rows = this.db.prepare('SELECT * FROM agent_profiles ORDER BY name ASC').all() as Record<string, unknown>[];
    return rows.map((r) => this.mapAgentProfile(r));
  }

  public updateAgentProfile(
    id: string,
    updates: Partial<Pick<AgentProfile, 'name' | 'prompt_template' | 'config' | 'enabled'>>
  ): void {
    const existing = this.getAgentProfile(id);
    if (!existing) return;

    this.db
      .prepare(`
        UPDATE agent_profiles
        SET name = ?,
            prompt_template = ?,
            config_json = ?,
            enabled = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(
        updates.name ?? existing.name,
        updates.prompt_template !== undefined ? updates.prompt_template : existing.prompt_template,
        updates.config !== undefined ? (updates.config ? JSON.stringify(updates.config) : null) : (existing.config ? JSON.stringify(existing.config) : null),
        updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : (existing.enabled ? 1 : 0),
        new Date().toISOString(),
        id
      );
  }

  private mapAgentProfile(row: Record<string, unknown>): AgentProfile {
    return {
      id: String(row.id),
      role_profile_id: String(row.role_profile_id),
      name: String(row.name),
      prompt_template: row.prompt_template ? String(row.prompt_template) : null,
      config: row.config_json ? (JSON.parse(String(row.config_json)) as Record<string, unknown>) : null,
      enabled: Boolean(row.enabled),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  // ==========================================
  // Provider Accounts (R5A)
  // ==========================================
  public createProviderAccount(account: ProviderAccount): void {
    const provider = this.getProvider(account.provider_id);
    if (!provider) {
      throw new Error(`[Repository] createProviderAccount failed: Provider "${account.provider_id}" not found.`);
    }

    let finalCredentialRef: string | null = null;
    let finalProfileRef: string | null = null;

    if (account.auth_mode === 'API_CREDENTIAL') {
      if (account.profile_ref !== null && account.profile_ref !== undefined) {
        throw new Error(
          `[Repository] createProviderAccount failed: auth_mode "API_CREDENTIAL" requires null profile_ref.`
        );
      }
      if (account.enabled) {
        if (!account.credential_ref || account.credential_ref.trim().length === 0) {
          throw new Error(
            `[Repository] createProviderAccount failed: enabled auth_mode "API_CREDENTIAL" requires a valid canonical credential_ref.`
          );
        }
      }
      if (account.credential_ref) {
        finalCredentialRef = parseCredentialRef(account.credential_ref).toUriString();
      }
    } else if (account.auth_mode === 'NATIVE_PROFILE') {
      if (account.credential_ref !== null && account.credential_ref !== undefined) {
        throw new Error(
          `[Repository] createProviderAccount failed: auth_mode "NATIVE_PROFILE" requires null credential_ref.`
        );
      }
      if (account.enabled) {
        if (!account.profile_ref || account.profile_ref.trim().length === 0) {
          throw new Error(
            `[Repository] createProviderAccount failed: enabled auth_mode "NATIVE_PROFILE" requires a valid canonical profile_ref.`
          );
        }
      }
      if (account.profile_ref) {
        finalProfileRef = parseNativeProfileRef(account.profile_ref).toUriString();
      }
    } else {
      throw new Error(
        `[Repository] createProviderAccount failed: unsupported auth_mode "${account.auth_mode}".`
      );
    }

    this.db
      .prepare(`
        INSERT INTO provider_accounts (
          id, provider_id, label, auth_mode, credential_ref, profile_ref,
          enabled, priority, health_status, cooldown_until, concurrency_limit,
          last_success_at, last_failure_at, last_failure_code, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        account.id,
        account.provider_id,
        account.label,
        account.auth_mode,
        finalCredentialRef,
        finalProfileRef,
        account.enabled ? 1 : 0,
        account.priority ?? 0,
        account.health_status,
        account.cooldown_until ?? null,
        account.concurrency_limit ?? 1,
        account.last_success_at ?? null,
        account.last_failure_at ?? null,
        account.last_failure_code ?? null,
        account.created_at,
        account.updated_at
      );
  }

  public getProviderAccount(id: string): ProviderAccount | null {
    const row = this.db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapProviderAccount(row) : null;
  }

  public getProviderAccountsByProvider(providerId: string): ProviderAccount[] {
    const rows = this.db.prepare('SELECT * FROM provider_accounts WHERE provider_id = ? ORDER BY priority DESC, created_at ASC').all(providerId) as Record<string, unknown>[];
    return rows.map((r) => this.mapProviderAccount(r));
  }

  public getAllProviderAccounts(): ProviderAccount[] {
    const rows = this.db.prepare('SELECT * FROM provider_accounts ORDER BY priority DESC, created_at ASC').all() as Record<string, unknown>[];
    return rows.map((r) => this.mapProviderAccount(r));
  }

  public updateProviderAccountHealth(
    id: string,
    healthStatus: ProviderHealthStatus,
    cooldownUntil?: string | null,
    failureCode?: string | null
  ): void {
    const now = new Date().toISOString();
    if (healthStatus === 'AVAILABLE') {
      this.db
        .prepare(`
          UPDATE provider_accounts
          SET health_status = ?, cooldown_until = NULL, last_success_at = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(healthStatus, now, now, id);
    } else {
      this.db
        .prepare(`
          UPDATE provider_accounts
          SET health_status = ?, cooldown_until = ?, last_failure_at = ?, last_failure_code = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(healthStatus, cooldownUntil ?? null, now, failureCode ?? null, now, id);
    }
  }

  public updateProviderAccount(
    id: string,
    updates: Partial<Pick<ProviderAccount, 'label' | 'auth_mode' | 'credential_ref' | 'profile_ref' | 'enabled' | 'priority' | 'health_status' | 'cooldown_until' | 'concurrency_limit' | 'last_success_at' | 'last_failure_at' | 'last_failure_code'>>
  ): void {
    const existing = this.getProviderAccount(id);
    if (!existing) return;

    const isSecurityUpdate =
      updates.auth_mode !== undefined ||
      updates.credential_ref !== undefined ||
      updates.profile_ref !== undefined;
    const isEnabling = updates.enabled === true && !existing.enabled;

    let finalCredentialRef = updates.credential_ref !== undefined ? updates.credential_ref : existing.credential_ref;
    let finalProfileRef = updates.profile_ref !== undefined ? updates.profile_ref : existing.profile_ref;

    if (isSecurityUpdate || isEnabling) {
      const mergedAuthMode = updates.auth_mode ?? existing.auth_mode;
      const mergedCredRef = updates.credential_ref !== undefined ? updates.credential_ref : existing.credential_ref;
      const mergedProfRef = updates.profile_ref !== undefined ? updates.profile_ref : existing.profile_ref;
      const mergedEnabled = updates.enabled !== undefined ? updates.enabled : existing.enabled;

      if (mergedAuthMode === 'API_CREDENTIAL') {
        if (mergedProfRef !== null && mergedProfRef !== undefined) {
          throw new Error(
            `[Repository] updateProviderAccount failed: auth_mode "API_CREDENTIAL" requires null profile_ref.`
          );
        }
        if (mergedEnabled) {
          if (!mergedCredRef || mergedCredRef.trim().length === 0) {
            throw new Error(
              `[Repository] updateProviderAccount failed: enabled auth_mode "API_CREDENTIAL" requires a valid canonical credential_ref.`
            );
          }
        }
        if (mergedCredRef) {
          finalCredentialRef = parseCredentialRef(mergedCredRef).toUriString();
        } else {
          finalCredentialRef = null;
        }
        finalProfileRef = null;
      } else if (mergedAuthMode === 'NATIVE_PROFILE') {
        if (mergedCredRef !== null && mergedCredRef !== undefined) {
          throw new Error(
            `[Repository] updateProviderAccount failed: auth_mode "NATIVE_PROFILE" requires null credential_ref.`
          );
        }
        if (mergedEnabled) {
          if (!mergedProfRef || mergedProfRef.trim().length === 0) {
            throw new Error(
              `[Repository] updateProviderAccount failed: enabled auth_mode "NATIVE_PROFILE" requires a valid canonical profile_ref.`
            );
          }
        }
        if (mergedProfRef) {
          finalProfileRef = parseNativeProfileRef(mergedProfRef).toUriString();
        } else {
          finalProfileRef = null;
        }
        finalCredentialRef = null;
      } else {
        throw new Error(
          `[Repository] updateProviderAccount failed: unsupported auth_mode "${mergedAuthMode}".`
        );
      }
    }

    this.db
      .prepare(`
        UPDATE provider_accounts
        SET label = ?,
            auth_mode = ?,
            credential_ref = ?,
            profile_ref = ?,
            enabled = ?,
            priority = ?,
            health_status = ?,
            cooldown_until = ?,
            concurrency_limit = ?,
            last_success_at = ?,
            last_failure_at = ?,
            last_failure_code = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(
        updates.label ?? existing.label,
        updates.auth_mode ?? existing.auth_mode,
        finalCredentialRef,
        finalProfileRef,
        updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : (existing.enabled ? 1 : 0),
        updates.priority !== undefined ? updates.priority : existing.priority,
        updates.health_status ?? existing.health_status,
        updates.cooldown_until !== undefined ? updates.cooldown_until : existing.cooldown_until,
        updates.concurrency_limit !== undefined ? updates.concurrency_limit : existing.concurrency_limit,
        updates.last_success_at !== undefined ? updates.last_success_at : existing.last_success_at,
        updates.last_failure_at !== undefined ? updates.last_failure_at : existing.last_failure_at,
        updates.last_failure_code !== undefined ? updates.last_failure_code : existing.last_failure_code,
        new Date().toISOString(),
        id
      );
  }

  private mapProviderAccount(row: Record<string, unknown>): ProviderAccount {
    return {
      id: String(row.id),
      provider_id: String(row.provider_id),
      label: String(row.label),
      auth_mode: row.auth_mode as AccountAuthMode,
      credential_ref: row.credential_ref ? String(row.credential_ref) : null,
      profile_ref: row.profile_ref ? String(row.profile_ref) : null,
      enabled: Boolean(row.enabled),
      priority: Number(row.priority),
      health_status: row.health_status as ProviderHealthStatus,
      cooldown_until: row.cooldown_until ? String(row.cooldown_until) : null,
      concurrency_limit: Number(row.concurrency_limit),
      last_success_at: row.last_success_at ? String(row.last_success_at) : null,
      last_failure_at: row.last_failure_at ? String(row.last_failure_at) : null,
      last_failure_code: row.last_failure_code ? String(row.last_failure_code) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  // ==========================================
  // Worker Slots (R5A)
  // ==========================================
  public createWorkerSlot(slot: WorkerSlot): void {
    const account = this.getProviderAccount(slot.provider_account_id);
    if (!account) {
      throw new Error(`Provider account '${slot.provider_account_id}' not found for worker slot '${slot.id}'`);
    }
    if (slot.provider_resource_id) {
      const resource = this.getProviderResource(slot.provider_resource_id);
      if (!resource) {
        throw new Error(`Provider resource '${slot.provider_resource_id}' not found for worker slot '${slot.id}'`);
      }
      if (resource.provider_account_id !== slot.provider_account_id) {
        throw new Error(
          `Slot resource account mismatch: Resource account '${resource.provider_account_id}' does not match slot account '${slot.provider_account_id}'`
        );
      }
      if (resource.provider_id !== account.provider_id) {
        throw new Error(
          `Slot resource provider mismatch: Resource provider '${resource.provider_id}' does not match account provider '${account.provider_id}'`
        );
      }
    }

    this.db
      .prepare(`
        INSERT INTO worker_slots (
          id, provider_account_id, provider_resource_id, slot_index, status,
          current_assignment_id, current_execution_id, heartbeat_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        slot.id,
        slot.provider_account_id,
        slot.provider_resource_id ?? null,
        slot.slot_index,
        slot.status,
        slot.current_assignment_id ?? null,
        slot.current_execution_id ?? null,
        slot.heartbeat_at ?? null,
        slot.created_at,
        slot.updated_at
      );
  }

  public getWorkerSlot(id: string): WorkerSlot | null {
    const row = this.db.prepare('SELECT * FROM worker_slots WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapWorkerSlot(row) : null;
  }

  public getWorkerSlotsByAccount(accountId: string): WorkerSlot[] {
    const rows = this.db.prepare('SELECT * FROM worker_slots WHERE provider_account_id = ? ORDER BY slot_index ASC').all(accountId) as Record<string, unknown>[];
    return rows.map((r) => this.mapWorkerSlot(r));
  }

  public getAllWorkerSlots(): WorkerSlot[] {
    const rows = this.db.prepare('SELECT * FROM worker_slots ORDER BY provider_account_id ASC, slot_index ASC').all() as Record<string, unknown>[];
    return rows.map((r) => this.mapWorkerSlot(r));
  }

  public updateWorkerSlotStatus(
    id: string,
    status: WorkerSlotStatus,
    currentAssignmentId?: string | null,
    currentExecutionId?: string | null,
    heartbeatAt?: string | null
  ): void {
    const existing = this.getWorkerSlot(id);
    if (!existing) return;

    const newAssignmentId = currentAssignmentId !== undefined ? currentAssignmentId : existing.current_assignment_id;
    const newExecutionId = currentExecutionId !== undefined ? currentExecutionId : existing.current_execution_id;
    const newHeartbeatAt = heartbeatAt !== undefined ? heartbeatAt : existing.heartbeat_at;

    this.db
      .prepare(`
        UPDATE worker_slots
        SET status = ?,
            current_assignment_id = ?,
            current_execution_id = ?,
            heartbeat_at = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(
        status,
        newAssignmentId,
        newExecutionId,
        newHeartbeatAt,
        new Date().toISOString(),
        id
      );
  }

  public updateWorkerSlotHeartbeat(id: string, heartbeatAt?: string): void {
    const now = heartbeatAt ?? new Date().toISOString();
    this.db
      .prepare(`
        UPDATE worker_slots
        SET heartbeat_at = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(now, new Date().toISOString(), id);
  }

  private mapWorkerSlot(row: Record<string, unknown>): WorkerSlot {
    return {
      id: String(row.id),
      provider_account_id: String(row.provider_account_id),
      provider_resource_id: row.provider_resource_id ? String(row.provider_resource_id) : null,
      slot_index: Number(row.slot_index),
      status: row.status as WorkerSlotStatus,
      current_assignment_id: row.current_assignment_id ? String(row.current_assignment_id) : null,
      current_execution_id: row.current_execution_id ? String(row.current_execution_id) : null,
      heartbeat_at: row.heartbeat_at ? String(row.heartbeat_at) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  // ==========================================
  // Agent Assignments (R5A)
  // ==========================================
  public createAgentAssignment(assignment: AgentAssignment): void {
    // B3: Project / Task / Attempt chain
    const project = this.getProject(assignment.project_id);
    if (!project) {
      throw new Error(`Project '${assignment.project_id}' not found for assignment '${assignment.id}'`);
    }
    const task = this.getTask(assignment.task_id);
    if (!task) {
      throw new Error(`Task '${assignment.task_id}' not found for assignment '${assignment.id}'`);
    }
    if (task.project_id !== assignment.project_id) {
      throw new Error(
        `Project task mismatch: Task project '${task.project_id}' does not match assignment project '${assignment.project_id}'`
      );
    }
    if (assignment.attempt_id) {
      const attempt = this.getTaskAttempt(assignment.attempt_id);
      if (!attempt) {
        throw new Error(`Task attempt '${assignment.attempt_id}' not found for assignment '${assignment.id}'`);
      }
      if (attempt.task_id !== assignment.task_id) {
        throw new Error(
          `Task attempt mismatch: Attempt task '${attempt.task_id}' does not match assignment task '${assignment.task_id}'`
        );
      }
    }

    // B4: Role / Profile chain
    const roleProfile = this.getRoleProfile(assignment.role_profile_id);
    if (!roleProfile) {
      throw new Error(`Role profile '${assignment.role_profile_id}' not found for assignment '${assignment.id}'`);
    }
    if (assignment.agent_profile_id) {
      const agentProfile = this.getAgentProfile(assignment.agent_profile_id);
      if (!agentProfile) {
        throw new Error(`Agent profile '${assignment.agent_profile_id}' not found for assignment '${assignment.id}'`);
      }
      if (agentProfile.role_profile_id !== assignment.role_profile_id) {
        throw new Error(
          `Role profile mismatch: Agent profile role '${agentProfile.role_profile_id}' does not match assignment role profile '${assignment.role_profile_id}'`
        );
      }
    }

    // B5: Provider / Account / Resource chain
    const provider = this.getProvider(assignment.selected_provider_id);
    if (!provider) {
      throw new Error(`Provider '${assignment.selected_provider_id}' not found for assignment '${assignment.id}'`);
    }
    const account = this.getProviderAccount(assignment.selected_account_id);
    if (!account) {
      throw new Error(`Provider account '${assignment.selected_account_id}' not found for assignment '${assignment.id}'`);
    }
    if (account.provider_id !== assignment.selected_provider_id) {
      throw new Error(
        `Provider account mismatch: Account provider '${account.provider_id}' does not match selected provider '${assignment.selected_provider_id}'`
      );
    }
    const resource = this.getProviderResource(assignment.selected_resource_id);
    if (!resource) {
      throw new Error(`Provider resource '${assignment.selected_resource_id}' not found for assignment '${assignment.id}'`);
    }
    if (resource.provider_id !== assignment.selected_provider_id) {
      throw new Error(
        `Provider resource mismatch: Resource provider '${resource.provider_id}' does not match selected provider '${assignment.selected_provider_id}'`
      );
    }
    if (!resource.provider_account_id || resource.provider_account_id !== assignment.selected_account_id) {
      throw new Error(
        `Account resource mismatch: Resource account '${resource.provider_account_id}' must be non-null and match selected account '${assignment.selected_account_id}'`
      );
    }

    // B6: Worker slot chain
    if (assignment.selected_worker_slot_id) {
      const slot = this.getWorkerSlot(assignment.selected_worker_slot_id);
      if (!slot) {
        throw new Error(`Worker slot '${assignment.selected_worker_slot_id}' not found for assignment '${assignment.id}'`);
      }
      if (slot.provider_account_id !== assignment.selected_account_id) {
        throw new Error(
          `Assignment slot account mismatch: Slot account '${slot.provider_account_id}' does not match selected account '${assignment.selected_account_id}'`
        );
      }
      if (slot.provider_resource_id && slot.provider_resource_id !== assignment.selected_resource_id) {
        throw new Error(
          `Assignment slot resource mismatch: Slot resource '${slot.provider_resource_id}' does not match selected resource '${assignment.selected_resource_id}'`
        );
      }
    }

    this.db
      .prepare(`
        INSERT INTO agent_assignments (
          id, project_id, task_id, attempt_id, role_profile_id, agent_profile_id,
          selected_provider_id, selected_account_id, selected_resource_id,
          selected_worker_slot_id, routing_decision_id, preferred_metadata_json,
          status, created_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        assignment.id,
        assignment.project_id,
        assignment.task_id,
        assignment.attempt_id ?? null,
        assignment.role_profile_id,
        assignment.agent_profile_id ?? null,
        assignment.selected_provider_id,
        assignment.selected_account_id,
        assignment.selected_resource_id,
        assignment.selected_worker_slot_id ?? null,
        assignment.routing_decision_id ?? null,
        assignment.preferred_metadata ? JSON.stringify(assignment.preferred_metadata) : null,
        assignment.status,
        assignment.created_at,
        assignment.ended_at ?? null
      );
  }

  public getAgentAssignment(id: string): AgentAssignment | null {
    const row = this.db.prepare('SELECT * FROM agent_assignments WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapAgentAssignment(row) : null;
  }

  public getAgentAssignmentsByTask(taskId: string): AgentAssignment[] {
    const rows = this.db.prepare('SELECT * FROM agent_assignments WHERE task_id = ? ORDER BY created_at DESC').all(taskId) as Record<string, unknown>[];
    return rows.map((r) => this.mapAgentAssignment(r));
  }

  public getAgentAssignmentsByProject(projectId: string): AgentAssignment[] {
    const rows = this.db.prepare('SELECT * FROM agent_assignments WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Record<string, unknown>[];
    return rows.map((r) => this.mapAgentAssignment(r));
  }

  public getAllAgentAssignments(): AgentAssignment[] {
    const rows = this.db.prepare('SELECT * FROM agent_assignments ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map((r) => this.mapAgentAssignment(r));
  }

  public updateAgentAssignmentStatus(id: string, status: AgentAssignmentStatus, endedAt?: string | null): void {
    this.db
      .prepare(`
        UPDATE agent_assignments
        SET status = ?, ended_at = ?
        WHERE id = ?
      `)
      .run(status, endedAt !== undefined ? endedAt : (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED' ? new Date().toISOString() : null), id);
  }

  public bindAgentAssignmentWorkerSlotIfUnbound(assignmentId: string, workerSlotId: string): boolean {
    const result = this.db
      .prepare(`
        UPDATE agent_assignments
        SET selected_worker_slot_id = ?
        WHERE id = ?
          AND selected_worker_slot_id IS NULL
          AND status = 'ASSIGNED'
      `)
      .run(workerSlotId, assignmentId);
    return result.changes === 1;
  }

  private mapAgentAssignment(row: Record<string, unknown>): AgentAssignment {
    return {
      id: String(row.id),
      project_id: String(row.project_id),
      task_id: String(row.task_id),
      attempt_id: row.attempt_id ? String(row.attempt_id) : null,
      role_profile_id: String(row.role_profile_id),
      agent_profile_id: row.agent_profile_id ? String(row.agent_profile_id) : null,
      selected_provider_id: String(row.selected_provider_id),
      selected_account_id: String(row.selected_account_id),
      selected_resource_id: String(row.selected_resource_id),
      selected_worker_slot_id: row.selected_worker_slot_id ? String(row.selected_worker_slot_id) : null,
      routing_decision_id: row.routing_decision_id ? String(row.routing_decision_id) : null,
      preferred_metadata: row.preferred_metadata_json ? (JSON.parse(String(row.preferred_metadata_json)) as Record<string, unknown>) : null,
      status: row.status as AgentAssignmentStatus,
      created_at: String(row.created_at),
      ended_at: row.ended_at ? String(row.ended_at) : null,
    };
  }

  // ==========================================
  // Account Leases (R5A)
  // ==========================================
  public createAccountLease(lease: AccountLease): void {
    const assignment = this.getAgentAssignment(lease.assignment_id);
    if (!assignment) {
      throw new Error(`Agent assignment '${lease.assignment_id}' not found for lease '${lease.id}'`);
    }
    const account = this.getProviderAccount(lease.provider_account_id);
    if (!account) {
      throw new Error(`Provider account '${lease.provider_account_id}' not found for lease '${lease.id}'`);
    }
    const slot = this.getWorkerSlot(lease.worker_slot_id);
    if (!slot) {
      throw new Error(`Worker slot '${lease.worker_slot_id}' not found for lease '${lease.id}'`);
    }
    if (lease.provider_account_id !== assignment.selected_account_id) {
      throw new Error(
        `Lease account mismatch: Lease account '${lease.provider_account_id}' does not match assignment account '${assignment.selected_account_id}'`
      );
    }
    if (lease.worker_slot_id !== assignment.selected_worker_slot_id) {
      throw new Error(
        `Lease slot mismatch: Lease slot '${lease.worker_slot_id}' does not match assignment slot '${assignment.selected_worker_slot_id}'`
      );
    }
    if (slot.provider_account_id !== lease.provider_account_id) {
      throw new Error(
        `Slot account mismatch: Slot account '${slot.provider_account_id}' does not match lease account '${lease.provider_account_id}'`
      );
    }

    this.db
      .prepare(`
        INSERT INTO account_leases (
          id, assignment_id, provider_account_id, worker_slot_id,
          lease_token, acquired_at, expires_at, heartbeat_at, released_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        lease.id,
        lease.assignment_id,
        lease.provider_account_id,
        lease.worker_slot_id,
        lease.lease_token,
        lease.acquired_at,
        lease.expires_at,
        lease.heartbeat_at,
        lease.released_at ?? null
      );
  }

  public getAccountLease(id: string): AccountLease | null {
    const row = this.db.prepare('SELECT * FROM account_leases WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapAccountLease(row) : null;
  }

  public getActiveLeaseForSlot(slotId: string): AccountLease | null {
    const row = this.db.prepare('SELECT * FROM account_leases WHERE worker_slot_id = ? AND released_at IS NULL').get(slotId) as Record<string, unknown> | undefined;
    return row ? this.mapAccountLease(row) : null;
  }

  public getActiveLeaseForAssignment(assignmentId: string): AccountLease | null {
    const row = this.db
      .prepare('SELECT * FROM account_leases WHERE assignment_id = ? AND released_at IS NULL')
      .get(assignmentId) as Record<string, unknown> | undefined;
    return row ? this.mapAccountLease(row) : null;
  }

  public getUnreleasedAccountLeasesByAccount(accountId: string): AccountLease[] {
    const rows = this.db
      .prepare('SELECT * FROM account_leases WHERE provider_account_id = ? AND released_at IS NULL ORDER BY acquired_at DESC')
      .all(accountId) as Record<string, unknown>[];
    return rows.map((r) => this.mapAccountLease(r));
  }

  public getAccountLeasesByAssignment(assignmentId: string): AccountLease[] {
    const rows = this.db.prepare('SELECT * FROM account_leases WHERE assignment_id = ? ORDER BY acquired_at DESC').all(assignmentId) as Record<string, unknown>[];
    return rows.map((r) => this.mapAccountLease(r));
  }

  public releaseAccountLease(id: string, releasedAt?: string): void {
    this.db
      .prepare('UPDATE account_leases SET released_at = ? WHERE id = ?')
      .run(releasedAt ?? new Date().toISOString(), id);
  }

  public updateAccountLeaseHeartbeat(
    leaseId: string,
    leaseToken: string,
    heartbeatAt: string,
    expiresAt: string
  ): boolean {
    const result = this.db
      .prepare(`
        UPDATE account_leases
        SET heartbeat_at = ?, expires_at = ?
        WHERE id = ? AND lease_token = ? AND released_at IS NULL
      `)
      .run(heartbeatAt, expiresAt, leaseId, leaseToken);
    return result.changes === 1;
  }

  public releaseAccountLeaseWithToken(leaseId: string, leaseToken: string, releasedAt?: string): boolean {
    const result = this.db
      .prepare(`
        UPDATE account_leases
        SET released_at = ?
        WHERE id = ? AND lease_token = ? AND released_at IS NULL
      `)
      .run(releasedAt ?? new Date().toISOString(), leaseId, leaseToken);
    return result.changes === 1;
  }

  private mapAccountLease(row: Record<string, unknown>): AccountLease {
    return {
      id: String(row.id),
      assignment_id: String(row.assignment_id),
      provider_account_id: String(row.provider_account_id),
      worker_slot_id: String(row.worker_slot_id),
      lease_token: String(row.lease_token),
      acquired_at: String(row.acquired_at),
      expires_at: String(row.expires_at),
      heartbeat_at: String(row.heartbeat_at),
      released_at: row.released_at ? String(row.released_at) : null,
    };
  }

  // ==========================================
  // Route Policies (R5A)
  // ==========================================
  public createRoutePolicy(policy: RoutePolicy): void {
    this.db
      .prepare(`
        INSERT INTO route_policies (
          id, name, required_capabilities_json, preferred_capabilities_json,
          provider_account_policy_json, allow_manual_bridge, failover_policy_json,
          risk_policy_json, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        policy.id,
        policy.name,
        JSON.stringify(policy.required_capabilities || []),
        JSON.stringify(policy.preferred_capabilities || []),
        policy.provider_account_policy ? JSON.stringify(policy.provider_account_policy) : null,
        policy.allow_manual_bridge ? 1 : 0,
        policy.failover_policy ? JSON.stringify(policy.failover_policy) : null,
        policy.risk_policy ? JSON.stringify(policy.risk_policy) : null,
        policy.enabled ? 1 : 0,
        policy.created_at,
        policy.updated_at
      );
  }

  public getRoutePolicy(id: string): RoutePolicy | null {
    const row = this.db.prepare('SELECT * FROM route_policies WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRoutePolicy(row) : null;
  }

  public getAllRoutePolicies(): RoutePolicy[] {
    const rows = this.db.prepare('SELECT * FROM route_policies ORDER BY name ASC').all() as Record<string, unknown>[];
    return rows.map((r) => this.mapRoutePolicy(r));
  }

  public updateRoutePolicy(
    id: string,
    updates: Partial<Pick<RoutePolicy, 'name' | 'required_capabilities' | 'preferred_capabilities' | 'provider_account_policy' | 'allow_manual_bridge' | 'failover_policy' | 'risk_policy' | 'enabled'>>
  ): void {
    const existing = this.getRoutePolicy(id);
    if (!existing) return;

    this.db
      .prepare(`
        UPDATE route_policies
        SET name = ?,
            required_capabilities_json = ?,
            preferred_capabilities_json = ?,
            provider_account_policy_json = ?,
            allow_manual_bridge = ?,
            failover_policy_json = ?,
            risk_policy_json = ?,
            enabled = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(
        updates.name ?? existing.name,
        updates.required_capabilities !== undefined ? JSON.stringify(updates.required_capabilities) : JSON.stringify(existing.required_capabilities),
        updates.preferred_capabilities !== undefined ? JSON.stringify(updates.preferred_capabilities) : JSON.stringify(existing.preferred_capabilities),
        updates.provider_account_policy !== undefined ? (updates.provider_account_policy ? JSON.stringify(updates.provider_account_policy) : null) : (existing.provider_account_policy ? JSON.stringify(existing.provider_account_policy) : null),
        updates.allow_manual_bridge !== undefined ? (updates.allow_manual_bridge ? 1 : 0) : (existing.allow_manual_bridge ? 1 : 0),
        updates.failover_policy !== undefined ? (updates.failover_policy ? JSON.stringify(updates.failover_policy) : null) : (existing.failover_policy ? JSON.stringify(existing.failover_policy) : null),
        updates.risk_policy !== undefined ? (updates.risk_policy ? JSON.stringify(updates.risk_policy) : null) : (existing.risk_policy ? JSON.stringify(existing.risk_policy) : null),
        updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : (existing.enabled ? 1 : 0),
        new Date().toISOString(),
        id
      );
  }

  private mapRoutePolicy(row: Record<string, unknown>): RoutePolicy {
    return {
      id: String(row.id),
      name: String(row.name),
      required_capabilities: JSON.parse(String(row.required_capabilities_json)) as Capability[],
      preferred_capabilities: JSON.parse(String(row.preferred_capabilities_json)) as Capability[],
      provider_account_policy: row.provider_account_policy_json ? (JSON.parse(String(row.provider_account_policy_json)) as Record<string, unknown>) : null,
      allow_manual_bridge: Boolean(row.allow_manual_bridge),
      failover_policy: row.failover_policy_json ? (JSON.parse(String(row.failover_policy_json)) as Record<string, unknown>) : null,
      risk_policy: row.risk_policy_json ? (JSON.parse(String(row.risk_policy_json)) as Record<string, unknown>) : null,
      enabled: Boolean(row.enabled),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  // ==========================================
  // Separation Policies (R5A)
  // ==========================================
  public createSeparationPolicy(policy: SeparationPolicy): void {
    this.db
      .prepare(`
        INSERT INTO separation_policies (
          id, name, same_execution_forbidden, same_session_forbidden,
          same_account_policy, same_provider_policy, same_model_policy,
          risk_threshold, applicability_json, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        policy.id,
        policy.name,
        policy.same_execution_forbidden ? 1 : 0,
        policy.same_session_forbidden ? 1 : 0,
        policy.same_account_policy,
        policy.same_provider_policy,
        policy.same_model_policy,
        policy.risk_threshold,
        policy.applicability ? JSON.stringify(policy.applicability) : null,
        policy.enabled ? 1 : 0,
        policy.created_at,
        policy.updated_at
      );
  }

  public getSeparationPolicy(id: string): SeparationPolicy | null {
    const row = this.db.prepare('SELECT * FROM separation_policies WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapSeparationPolicy(row) : null;
  }

  public getAllSeparationPolicies(): SeparationPolicy[] {
    const rows = this.db.prepare('SELECT * FROM separation_policies ORDER BY name ASC').all() as Record<string, unknown>[];
    return rows.map((r) => this.mapSeparationPolicy(r));
  }

  public updateSeparationPolicy(
    id: string,
    updates: Partial<Pick<SeparationPolicy, 'name' | 'same_execution_forbidden' | 'same_session_forbidden' | 'same_account_policy' | 'same_provider_policy' | 'same_model_policy' | 'risk_threshold' | 'applicability' | 'enabled'>>
  ): void {
    const existing = this.getSeparationPolicy(id);
    if (!existing) return;

    this.db
      .prepare(`
        UPDATE separation_policies
        SET name = ?,
            same_execution_forbidden = ?,
            same_session_forbidden = ?,
            same_account_policy = ?,
            same_provider_policy = ?,
            same_model_policy = ?,
            risk_threshold = ?,
            applicability_json = ?,
            enabled = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(
        updates.name ?? existing.name,
        updates.same_execution_forbidden !== undefined ? (updates.same_execution_forbidden ? 1 : 0) : (existing.same_execution_forbidden ? 1 : 0),
        updates.same_session_forbidden !== undefined ? (updates.same_session_forbidden ? 1 : 0) : (existing.same_session_forbidden ? 1 : 0),
        updates.same_account_policy ?? existing.same_account_policy,
        updates.same_provider_policy ?? existing.same_provider_policy,
        updates.same_model_policy ?? existing.same_model_policy,
        updates.risk_threshold ?? existing.risk_threshold,
        updates.applicability !== undefined ? (updates.applicability ? JSON.stringify(updates.applicability) : null) : (existing.applicability ? JSON.stringify(existing.applicability) : null),
        updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : (existing.enabled ? 1 : 0),
        new Date().toISOString(),
        id
      );
  }

  private mapSeparationPolicy(row: Record<string, unknown>): SeparationPolicy {
    return {
      id: String(row.id),
      name: String(row.name),
      same_execution_forbidden: Boolean(row.same_execution_forbidden),
      same_session_forbidden: Boolean(row.same_session_forbidden),
      same_account_policy: row.same_account_policy as SeparationAffinity,
      same_provider_policy: row.same_provider_policy as SeparationAffinity,
      same_model_policy: row.same_model_policy as SeparationAffinity,
      risk_threshold: row.risk_threshold as RiskLevel,
      applicability: row.applicability_json ? (JSON.parse(String(row.applicability_json)) as Record<string, unknown>) : null,
      enabled: Boolean(row.enabled),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  // ==========================================
  // R5B Durable Memory & Context Fabric
  // ==========================================

  // 1. Agent Sessions
  public createAgentSession(session: AgentSession): void {
    const project = this.getProject(session.project_id);
    if (!project) {
      throw new Error(`[Repository] createAgentSession failed: Project "${session.project_id}" not found.`);
    }

    const task = this.getTask(session.task_id);
    if (!task) {
      throw new Error(`[Repository] createAgentSession failed: Task "${session.task_id}" not found.`);
    }
    if (task.project_id !== session.project_id) {
      throw new Error(`[Repository] createAgentSession failed: Task "${session.task_id}" belongs to project "${task.project_id}", expected "${session.project_id}".`);
    }

    if (session.attempt_id) {
      const attempt = this.getTaskAttempt(session.attempt_id);
      if (!attempt) {
        throw new Error(`[Repository] createAgentSession failed: TaskAttempt "${session.attempt_id}" not found.`);
      }
      if (attempt.task_id !== session.task_id) {
        throw new Error(`[Repository] createAgentSession failed: TaskAttempt "${session.attempt_id}" belongs to task "${attempt.task_id}", expected "${session.task_id}".`);
      }
    }

    let assignment: AgentAssignment | null = null;
    if (session.assignment_id) {
      assignment = this.getAgentAssignment(session.assignment_id);
      if (!assignment) {
        throw new Error(`[Repository] createAgentSession failed: AgentAssignment "${session.assignment_id}" not found.`);
      }
      if (assignment.task_id !== session.task_id || assignment.project_id !== session.project_id) {
        throw new Error(`[Repository] createAgentSession failed: AgentAssignment "${session.assignment_id}" does not match project/task.`);
      }
      if (session.attempt_id && assignment.attempt_id && session.attempt_id !== assignment.attempt_id) {
        throw new Error(`[Repository] createAgentSession failed: AgentAssignment attempt "${assignment.attempt_id}" does not match session attempt "${session.attempt_id}".`);
      }
    }

    // Provider tuple provenance validation
    if (session.provider_account_id) {
      const account = this.getProviderAccount(session.provider_account_id);
      if (!account) {
        throw new Error(`[Repository] createAgentSession failed: ProviderAccount "${session.provider_account_id}" not found.`);
      }
      if (session.provider_id && account.provider_id !== session.provider_id) {
        throw new Error(`[Repository] createAgentSession failed: ProviderAccount "${session.provider_account_id}" belongs to provider "${account.provider_id}", expected "${session.provider_id}".`);
      }
    }

    if (session.provider_resource_id) {
      const resource = this.getProviderResource(session.provider_resource_id);
      if (!resource) {
        throw new Error(`[Repository] createAgentSession failed: ProviderResource "${session.provider_resource_id}" not found.`);
      }
      if (session.provider_id && resource.provider_id !== session.provider_id) {
        throw new Error(`[Repository] createAgentSession failed: ProviderResource "${session.provider_resource_id}" belongs to provider "${resource.provider_id}", expected "${session.provider_id}".`);
      }
      if (session.provider_account_id && resource.provider_account_id && resource.provider_account_id !== session.provider_account_id) {
        throw new Error(`[Repository] createAgentSession failed: ProviderResource account "${resource.provider_account_id}" does not match session account "${session.provider_account_id}".`);
      }
    }

    if (assignment) {
      if (session.provider_id && session.provider_id !== assignment.selected_provider_id) {
        throw new Error(`[Repository] createAgentSession failed: Session provider "${session.provider_id}" does not match assignment provider "${assignment.selected_provider_id}".`);
      }
      if (session.provider_account_id && session.provider_account_id !== assignment.selected_account_id) {
        throw new Error(`[Repository] createAgentSession failed: Session account "${session.provider_account_id}" does not match assignment account "${assignment.selected_account_id}".`);
      }
      if (session.provider_resource_id && session.provider_resource_id !== assignment.selected_resource_id) {
        throw new Error(`[Repository] createAgentSession failed: Session resource "${session.provider_resource_id}" does not match assignment resource "${assignment.selected_resource_id}".`);
      }
    }

    this.db
      .prepare(`
        INSERT INTO agent_sessions (
          id, project_id, task_id, attempt_id, assignment_id, provider_id,
          provider_account_id, provider_resource_id, external_session_ref,
          status, started_at, ended_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        session.id,
        session.project_id,
        session.task_id,
        session.attempt_id,
        session.assignment_id,
        session.provider_id,
        session.provider_account_id,
        session.provider_resource_id,
        session.external_session_ref,
        session.status,
        session.started_at,
        session.ended_at,
        session.created_at,
        session.updated_at
      );
  }

  public getAgentSession(id: string): AgentSession | null {
    const row = this.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapAgentSession(row);
  }

  public getAgentSessionsByTask(taskId: string): AgentSession[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_sessions WHERE task_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => this.mapAgentSession(r));
  }

  public getAgentSessionsByProject(projectId: string): AgentSession[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_sessions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(projectId) as Record<string, unknown>[];
    return rows.map((r) => this.mapAgentSession(r));
  }

  public updateAgentSessionStatus(id: string, status: AgentSessionStatus, endedAt?: string | null): void {
    const existing = this.getAgentSession(id);
    if (!existing) return;

    this.db
      .prepare('UPDATE agent_sessions SET status = ?, ended_at = ?, updated_at = ? WHERE id = ?')
      .run(status, endedAt !== undefined ? endedAt : existing.ended_at, new Date().toISOString(), id);
  }

  private mapAgentSession(row: Record<string, unknown>): AgentSession {
    return {
      id: String(row.id),
      project_id: String(row.project_id),
      task_id: String(row.task_id),
      attempt_id: row.attempt_id ? String(row.attempt_id) : null,
      assignment_id: row.assignment_id ? String(row.assignment_id) : null,
      provider_id: row.provider_id ? String(row.provider_id) : null,
      provider_account_id: row.provider_account_id ? String(row.provider_account_id) : null,
      provider_resource_id: row.provider_resource_id ? String(row.provider_resource_id) : null,
      external_session_ref: row.external_session_ref ? String(row.external_session_ref) : null,
      status: row.status as AgentSessionStatus,
      started_at: String(row.started_at),
      ended_at: row.ended_at ? String(row.ended_at) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  // 2. Project Memory
  public createProjectMemory(memory: ProjectMemory): void {
    try {
      JSON.parse(memory.value_json);
    } catch (e) {
      throw new Error(`[Repository] createProjectMemory failed: value_json is not valid JSON.`);
    }

    const project = this.getProject(memory.project_id);
    if (!project) {
      throw new Error(`[Repository] createProjectMemory failed: Project "${memory.project_id}" not found.`);
    }

    this.runInTransaction(() => {
      const active = this.db
        .prepare(`
          SELECT * FROM project_memories
          WHERE project_id = ? AND memory_type = ? AND key = ? AND is_active = 1
          ORDER BY revision DESC, rowid DESC LIMIT 1
        `)
        .get(memory.project_id, memory.memory_type, memory.key) as Record<string, unknown> | undefined;

      let revision = 1;
      if (active) {
        revision = Number(active.revision) + 1;
        this.db
          .prepare('UPDATE project_memories SET is_active = 0, updated_at = ? WHERE id = ?')
          .run(memory.created_at || new Date().toISOString(), String(active.id));
      }

      this.db
        .prepare(`
          INSERT INTO project_memories (
            id, project_id, memory_type, key, value_json, source_type,
            source_ref, revision, is_active, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          memory.id,
          memory.project_id,
          memory.memory_type,
          memory.key,
          memory.value_json,
          memory.source_type,
          memory.source_ref,
          revision,
          1,
          memory.created_at,
          memory.updated_at
        );
    });
  }

  public getProjectMemory(id: string): ProjectMemory | null {
    const row = this.db.prepare('SELECT * FROM project_memories WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapProjectMemory(row);
  }

  public getActiveProjectMemories(projectId: string): ProjectMemory[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM project_memories
        WHERE project_id = ? AND is_active = 1
        ORDER BY memory_type ASC, key ASC, revision DESC, rowid DESC
      `)
      .all(projectId) as Record<string, unknown>[];
    return rows.map((r) => this.mapProjectMemory(r));
  }

  public getActiveProjectMemoryByKey(projectId: string, memoryType: ProjectMemoryType, key: string): ProjectMemory | null {
    const row = this.db
      .prepare(`
        SELECT * FROM project_memories
        WHERE project_id = ? AND memory_type = ? AND key = ? AND is_active = 1
        ORDER BY revision DESC, rowid DESC LIMIT 1
      `)
      .get(projectId, memoryType, key) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapProjectMemory(row);
  }

  public getProjectMemoryHistory(projectId: string, memoryType: ProjectMemoryType, key: string): ProjectMemory[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM project_memories
        WHERE project_id = ? AND memory_type = ? AND key = ?
        ORDER BY revision DESC, rowid DESC
      `)
      .all(projectId, memoryType, key) as Record<string, unknown>[];
    return rows.map((r) => this.mapProjectMemory(r));
  }

  private mapProjectMemory(row: Record<string, unknown>): ProjectMemory {
    return {
      id: String(row.id),
      project_id: String(row.project_id),
      memory_type: row.memory_type as ProjectMemoryType,
      key: String(row.key),
      value_json: String(row.value_json),
      source_type: String(row.source_type),
      source_ref: row.source_ref ? String(row.source_ref) : null,
      revision: Number(row.revision),
      is_active: Boolean(row.is_active),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  // 3. Task Memory
  public createTaskMemory(memory: TaskMemory): void {
    try {
      JSON.parse(memory.value_json);
    } catch (e) {
      throw new Error(`[Repository] createTaskMemory failed: value_json is not valid JSON.`);
    }

    const task = this.getTask(memory.task_id);
    if (!task) {
      throw new Error(`[Repository] createTaskMemory failed: Task "${memory.task_id}" not found.`);
    }
    if (task.project_id !== memory.project_id) {
      throw new Error(`[Repository] createTaskMemory failed: Task "${memory.task_id}" belongs to project "${task.project_id}", expected "${memory.project_id}".`);
    }

    if (memory.attempt_id) {
      const attempt = this.getTaskAttempt(memory.attempt_id);
      if (!attempt) {
        throw new Error(`[Repository] createTaskMemory failed: TaskAttempt "${memory.attempt_id}" not found.`);
      }
      if (attempt.task_id !== memory.task_id) {
        throw new Error(`[Repository] createTaskMemory failed: TaskAttempt "${memory.attempt_id}" belongs to task "${attempt.task_id}", expected "${memory.task_id}".`);
      }
    }

    if (memory.assignment_id) {
      const assignment = this.getAgentAssignment(memory.assignment_id);
      if (!assignment) {
        throw new Error(`[Repository] createTaskMemory failed: AgentAssignment "${memory.assignment_id}" not found.`);
      }
      if (assignment.task_id !== memory.task_id || assignment.project_id !== memory.project_id) {
        throw new Error(`[Repository] createTaskMemory failed: AgentAssignment "${memory.assignment_id}" does not match project/task.`);
      }
      if (memory.attempt_id && assignment.attempt_id && memory.attempt_id !== assignment.attempt_id) {
        throw new Error(`[Repository] createTaskMemory failed: AgentAssignment attempt "${assignment.attempt_id}" does not match memory attempt "${memory.attempt_id}".`);
      }
    }

    this.runInTransaction(() => {
      const active = this.db
        .prepare(`
          SELECT * FROM task_memories
          WHERE task_id = ? AND memory_type = ? AND key = ? AND is_active = 1
          ORDER BY revision DESC, rowid DESC LIMIT 1
        `)
        .get(memory.task_id, memory.memory_type, memory.key) as Record<string, unknown> | undefined;

      let revision = 1;
      if (active) {
        revision = Number(active.revision) + 1;
        this.db
          .prepare('UPDATE task_memories SET is_active = 0, updated_at = ? WHERE id = ?')
          .run(memory.created_at || new Date().toISOString(), String(active.id));
      }

      this.db
        .prepare(`
          INSERT INTO task_memories (
            id, project_id, task_id, attempt_id, assignment_id, memory_type,
            key, value_json, source_type, source_ref, revision, is_active,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          memory.id,
          memory.project_id,
          memory.task_id,
          memory.attempt_id,
          memory.assignment_id,
          memory.memory_type,
          memory.key,
          memory.value_json,
          memory.source_type,
          memory.source_ref,
          revision,
          1,
          memory.created_at,
          memory.updated_at
        );
    });
  }

  public getTaskMemory(id: string): TaskMemory | null {
    const row = this.db.prepare('SELECT * FROM task_memories WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapTaskMemory(row);
  }

  public getActiveTaskMemories(taskId: string): TaskMemory[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM task_memories
        WHERE task_id = ? AND is_active = 1
        ORDER BY memory_type ASC, key ASC, revision DESC, rowid DESC
      `)
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => this.mapTaskMemory(r));
  }

  public getActiveTaskMemoryByKey(taskId: string, memoryType: TaskMemoryType, key: string): TaskMemory | null {
    const row = this.db
      .prepare(`
        SELECT * FROM task_memories
        WHERE task_id = ? AND memory_type = ? AND key = ? AND is_active = 1
        ORDER BY revision DESC, rowid DESC LIMIT 1
      `)
      .get(taskId, memoryType, key) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapTaskMemory(row);
  }

  public getTaskMemoryHistory(taskId: string, memoryType: TaskMemoryType, key: string): TaskMemory[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM task_memories
        WHERE task_id = ? AND memory_type = ? AND key = ?
        ORDER BY revision DESC, rowid DESC
      `)
      .all(taskId, memoryType, key) as Record<string, unknown>[];
    return rows.map((r) => this.mapTaskMemory(r));
  }

  private mapTaskMemory(row: Record<string, unknown>): TaskMemory {
    return {
      id: String(row.id),
      project_id: String(row.project_id),
      task_id: String(row.task_id),
      attempt_id: row.attempt_id ? String(row.attempt_id) : null,
      assignment_id: row.assignment_id ? String(row.assignment_id) : null,
      memory_type: row.memory_type as TaskMemoryType,
      key: String(row.key),
      value_json: String(row.value_json),
      source_type: String(row.source_type),
      source_ref: row.source_ref ? String(row.source_ref) : null,
      revision: Number(row.revision),
      is_active: Boolean(row.is_active),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  // 4. Context Snapshots
  public createContextSnapshot(snapshot: ContextSnapshot): void {
    const project = this.getProject(snapshot.project_id);
    if (!project) {
      throw new Error(`[Repository] createContextSnapshot failed: Project "${snapshot.project_id}" not found.`);
    }

    const task = this.getTask(snapshot.task_id);
    if (!task) {
      throw new Error(`[Repository] createContextSnapshot failed: Task "${snapshot.task_id}" not found.`);
    }
    if (task.project_id !== snapshot.project_id) {
      throw new Error(`[Repository] createContextSnapshot failed: Task "${snapshot.task_id}" belongs to project "${task.project_id}", expected "${snapshot.project_id}".`);
    }

    if (snapshot.attempt_id) {
      const attempt = this.getTaskAttempt(snapshot.attempt_id);
      if (!attempt) {
        throw new Error(`[Repository] createContextSnapshot failed: TaskAttempt "${snapshot.attempt_id}" not found.`);
      }
      if (attempt.task_id !== snapshot.task_id) {
        throw new Error(`[Repository] createContextSnapshot failed: TaskAttempt "${snapshot.attempt_id}" belongs to task "${attempt.task_id}", expected "${snapshot.task_id}".`);
      }
    }

    let assignment: AgentAssignment | null = null;
    if (snapshot.assignment_id) {
      assignment = this.getAgentAssignment(snapshot.assignment_id);
      if (!assignment) {
        throw new Error(`[Repository] createContextSnapshot failed: AgentAssignment "${snapshot.assignment_id}" not found.`);
      }
      if (assignment.project_id !== snapshot.project_id || assignment.task_id !== snapshot.task_id) {
        throw new Error(`[Repository] createContextSnapshot failed: AgentAssignment "${snapshot.assignment_id}" does not match project/task.`);
      }
    }

    let session: AgentSession | null = null;
    if (snapshot.session_id) {
      session = this.getAgentSession(snapshot.session_id);
      if (!session) {
        throw new Error(`[Repository] createContextSnapshot failed: AgentSession "${snapshot.session_id}" not found.`);
      }
      if (session.project_id !== snapshot.project_id || session.task_id !== snapshot.task_id) {
        throw new Error(`[Repository] createContextSnapshot failed: AgentSession "${snapshot.session_id}" does not match project/task.`);
      }
      if (snapshot.assignment_id && session.assignment_id && snapshot.assignment_id !== session.assignment_id) {
        throw new Error(`[Repository] createContextSnapshot failed: AgentSession assignment "${session.assignment_id}" does not match snapshot assignment "${snapshot.assignment_id}".`);
      }
    }

    assertConsistentAttemptBindings('createContextSnapshot', [
      { label: 'Snapshot attempt', attemptId: snapshot.attempt_id },
      { label: 'AgentAssignment attempt', attemptId: assignment?.attempt_id },
      { label: 'AgentSession attempt', attemptId: session?.attempt_id },
    ]);

    this.db
      .prepare(`
        INSERT INTO context_snapshots (
          id, project_id, task_id, attempt_id, assignment_id, session_id,
          purpose, snapshot_version, builder_version, content_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        snapshot.id,
        snapshot.project_id,
        snapshot.task_id,
        snapshot.attempt_id,
        snapshot.assignment_id,
        snapshot.session_id,
        snapshot.purpose,
        snapshot.snapshot_version,
        snapshot.builder_version,
        snapshot.content_hash,
        snapshot.created_at
      );
  }

  public getContextSnapshot(id: string): ContextSnapshot | null {
    const row = this.db.prepare('SELECT * FROM context_snapshots WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapContextSnapshot(row);
  }

  public getContextSnapshotsByTask(taskId: string): ContextSnapshot[] {
    const rows = this.db
      .prepare('SELECT * FROM context_snapshots WHERE task_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => this.mapContextSnapshot(r));
  }

  public getContextSnapshotsByProject(projectId: string): ContextSnapshot[] {
    const rows = this.db
      .prepare('SELECT * FROM context_snapshots WHERE project_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(projectId) as Record<string, unknown>[];
    return rows.map((r) => this.mapContextSnapshot(r));
  }

  private mapContextSnapshot(row: Record<string, unknown>): ContextSnapshot {
    return {
      id: String(row.id),
      project_id: String(row.project_id),
      task_id: String(row.task_id),
      attempt_id: row.attempt_id ? String(row.attempt_id) : null,
      assignment_id: row.assignment_id ? String(row.assignment_id) : null,
      session_id: row.session_id ? String(row.session_id) : null,
      purpose: row.purpose as ContextSnapshotPurpose,
      snapshot_version: Number(row.snapshot_version),
      builder_version: String(row.builder_version),
      content_hash: String(row.content_hash),
      created_at: String(row.created_at),
    };
  }

  // 5. Context Items
  public createContextItem(item: ContextItem): void {
    const snapshot = this.getContextSnapshot(item.snapshot_id);
    if (!snapshot) {
      throw new Error(`[Repository] createContextItem failed: ContextSnapshot "${item.snapshot_id}" not found.`);
    }

    const existingManifest = this.getContextManifestBySnapshotId(item.snapshot_id);
    if (existingManifest) {
      throw new Error(`[Repository] createContextItem failed: ContextSnapshot "${item.snapshot_id}" is sealed by manifest "${existingManifest.id}" and cannot accept new items.`);
    }

    try {
      JSON.parse(item.content_json);
    } catch (e) {
      throw new Error(`[Repository] createContextItem failed: content_json is not valid JSON.`);
    }

    const expectedHash = computeSha256(item.content_json);
    if (item.content_hash !== expectedHash) {
      throw new Error(`[Repository] createContextItem failed: content_hash "${item.content_hash}" does not match SHA-256 of content_json ("${expectedHash}").`);
    }

    this.db
      .prepare(`
        INSERT INTO context_items (
          id, snapshot_id, ordinal, item_type, source_type, source_ref,
          content_json, content_hash, token_estimate, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        item.id,
        item.snapshot_id,
        item.ordinal,
        item.item_type,
        item.source_type,
        item.source_ref,
        item.content_json,
        item.content_hash,
        item.token_estimate,
        item.created_at
      );
  }

  public getContextItemsBySnapshot(snapshotId: string): ContextItem[] {
    const rows = this.db
      .prepare('SELECT * FROM context_items WHERE snapshot_id = ? ORDER BY ordinal ASC')
      .all(snapshotId) as Record<string, unknown>[];
    return rows.map((r) => this.mapContextItem(r));
  }

  private mapContextItem(row: Record<string, unknown>): ContextItem {
    return {
      id: String(row.id),
      snapshot_id: String(row.snapshot_id),
      ordinal: Number(row.ordinal),
      item_type: row.item_type as ContextItemType,
      source_type: String(row.source_type),
      source_ref: row.source_ref ? String(row.source_ref) : null,
      content_json: String(row.content_json),
      content_hash: String(row.content_hash),
      token_estimate: row.token_estimate !== null && row.token_estimate !== undefined ? Number(row.token_estimate) : null,
      created_at: String(row.created_at),
    };
  }

  // 6. Context Manifests
  public createContextManifest(manifest: ContextManifest): void {
    const snapshot = this.getContextSnapshot(manifest.snapshot_id);
    if (!snapshot) {
      throw new Error(`[Repository] createContextManifest failed: ContextSnapshot "${manifest.snapshot_id}" not found.`);
    }

    const existingManifest = this.getContextManifestBySnapshotId(manifest.snapshot_id);
    if (existingManifest) {
      throw new Error(`[Repository] createContextManifest failed: ContextSnapshot "${manifest.snapshot_id}" is already sealed by manifest "${existingManifest.id}".`);
    }

    try {
      JSON.parse(manifest.manifest_json);
    } catch (e) {
      throw new Error(`[Repository] createContextManifest failed: manifest_json is not valid JSON.`);
    }

    const items = this.getContextItemsBySnapshot(manifest.snapshot_id);
    if (manifest.item_count !== items.length) {
      throw new Error(`[Repository] createContextManifest failed: manifest item_count (${manifest.item_count}) does not match actual item count (${items.length}).`);
    }

    for (let i = 0; i < items.length; i++) {
      if (items[i].ordinal !== i) {
        throw new Error(`[Repository] createContextManifest failed: context items ordinals are not contiguous (expected ${i}, found ${items[i].ordinal}).`);
      }
    }

    for (const item of items) {
      const itemHash = computeSha256(item.content_json);
      if (item.content_hash !== itemHash) {
        throw new Error(`[Repository] createContextManifest failed: item "${item.id}" content_hash mismatch.`);
      }
    }

    const expectedSnapshotHash = computeSnapshotContentHash({
      projectId: snapshot.project_id,
      taskId: snapshot.task_id,
      attemptId: snapshot.attempt_id,
      assignmentId: snapshot.assignment_id,
      purpose: snapshot.purpose,
      builderVersion: snapshot.builder_version,
      items: items.map((i) => ({
        ordinal: i.ordinal,
        itemType: i.item_type,
        sourceType: i.source_type,
        sourceRef: i.source_ref,
        contentHash: i.content_hash,
      })),
    });

    if (snapshot.content_hash !== expectedSnapshotHash) {
      throw new Error(`[Repository] createContextManifest failed: snapshot content_hash "${snapshot.content_hash}" does not match recomputed hash "${expectedSnapshotHash}".`);
    }

    const { manifestJson: expectedManifestJson, manifestHash: expectedManifestHash } =
      computeManifestPayloadAndHash({
        manifest_version: manifest.manifest_version,
        project_id: snapshot.project_id,
        task_id: snapshot.task_id,
        attempt_id: snapshot.attempt_id,
        assignment_id: snapshot.assignment_id,
        purpose: snapshot.purpose,
        builder_version: snapshot.builder_version,
        item_count: items.length,
        items: items.map((i) => ({
          ordinal: i.ordinal,
          item_type: i.item_type,
          source_type: i.source_type,
          source_ref: i.source_ref,
          content_hash: i.content_hash,
          token_estimate: i.token_estimate,
        })),
      });

    if (manifest.manifest_hash !== expectedManifestHash) {
      throw new Error(`[Repository] createContextManifest failed: manifest_hash "${manifest.manifest_hash}" does not match recomputed canonical hash "${expectedManifestHash}".`);
    }

    const parsedManifest = JSON.parse(manifest.manifest_json);
    if (canonicalJsonStringify(parsedManifest) !== expectedManifestJson) {
      throw new Error(`[Repository] createContextManifest failed: manifest_json does not match canonical descriptor.`);
    }

    this.db
      .prepare(`
        INSERT INTO context_manifests (
          id, snapshot_id, manifest_version, item_count, manifest_json, manifest_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        manifest.id,
        manifest.snapshot_id,
        manifest.manifest_version,
        manifest.item_count,
        manifest.manifest_json,
        manifest.manifest_hash,
        manifest.created_at
      );
  }

  public getContextManifest(id: string): ContextManifest | null {
    const row = this.db.prepare('SELECT * FROM context_manifests WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapContextManifest(row);
  }

  public getContextManifestBySnapshotId(snapshotId: string): ContextManifest | null {
    const row = this.db.prepare('SELECT * FROM context_manifests WHERE snapshot_id = ?').get(snapshotId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapContextManifest(row);
  }

  public getContextManifestByHash(hash: string): ContextManifest | null {
    const row = this.db
      .prepare('SELECT * FROM context_manifests WHERE manifest_hash = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(hash) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapContextManifest(row);
  }

  private mapContextManifest(row: Record<string, unknown>): ContextManifest {
    return {
      id: String(row.id),
      snapshot_id: String(row.snapshot_id),
      manifest_version: String(row.manifest_version),
      item_count: Number(row.item_count),
      manifest_json: String(row.manifest_json),
      manifest_hash: String(row.manifest_hash),
      created_at: String(row.created_at),
    };
  }

  // 7. Handoff Context
  public createHandoffContext(handoff: HandoffContext): void {
    const project = this.getProject(handoff.project_id);
    if (!project) {
      throw new Error(`[Repository] createHandoffContext failed: Project "${handoff.project_id}" not found.`);
    }

    const task = this.getTask(handoff.task_id);
    if (!task) {
      throw new Error(`[Repository] createHandoffContext failed: Task "${handoff.task_id}" not found.`);
    }
    if (task.project_id !== handoff.project_id) {
      throw new Error(`[Repository] createHandoffContext failed: Task "${handoff.task_id}" belongs to project "${task.project_id}", expected "${handoff.project_id}".`);
    }

    if (handoff.attempt_id) {
      const attempt = this.getTaskAttempt(handoff.attempt_id);
      if (!attempt) {
        throw new Error(`[Repository] createHandoffContext failed: TaskAttempt "${handoff.attempt_id}" not found.`);
      }
      if (attempt.task_id !== handoff.task_id) {
        throw new Error(`[Repository] createHandoffContext failed: TaskAttempt "${handoff.attempt_id}" belongs to task "${attempt.task_id}", expected "${handoff.task_id}".`);
      }
    }

    let fromAsgn: AgentAssignment | null = null;
    if (handoff.from_assignment_id) {
      fromAsgn = this.getAgentAssignment(handoff.from_assignment_id);
      if (!fromAsgn) {
        throw new Error(`[Repository] createHandoffContext failed: From AgentAssignment "${handoff.from_assignment_id}" not found.`);
      }
      if (fromAsgn.project_id !== handoff.project_id || fromAsgn.task_id !== handoff.task_id) {
        throw new Error(`[Repository] createHandoffContext failed: From AgentAssignment "${handoff.from_assignment_id}" does not match project/task.`);
      }
    }

    let toAsgn: AgentAssignment | null = null;
    if (handoff.to_assignment_id) {
      toAsgn = this.getAgentAssignment(handoff.to_assignment_id);
      if (!toAsgn) {
        throw new Error(`[Repository] createHandoffContext failed: To AgentAssignment "${handoff.to_assignment_id}" not found.`);
      }
      if (toAsgn.project_id !== handoff.project_id || toAsgn.task_id !== handoff.task_id) {
        throw new Error(`[Repository] createHandoffContext failed: To AgentAssignment "${handoff.to_assignment_id}" does not match project/task.`);
      }
    }

    const sourceSnapshot = this.getContextSnapshot(handoff.source_snapshot_id);
    if (!sourceSnapshot) {
      throw new Error(`[Repository] createHandoffContext failed: Source ContextSnapshot "${handoff.source_snapshot_id}" not found.`);
    }
    if (sourceSnapshot.project_id !== handoff.project_id || sourceSnapshot.task_id !== handoff.task_id) {
      throw new Error(`[Repository] createHandoffContext failed: Source ContextSnapshot "${handoff.source_snapshot_id}" does not match project/task.`);
    }

    let handoffSnapshot: ContextSnapshot | null = null;
    if (handoff.handoff_snapshot_id) {
      handoffSnapshot = this.getContextSnapshot(handoff.handoff_snapshot_id);
      if (!handoffSnapshot) {
        throw new Error(`[Repository] createHandoffContext failed: Handoff ContextSnapshot "${handoff.handoff_snapshot_id}" not found.`);
      }
      if (handoffSnapshot.project_id !== handoff.project_id || handoffSnapshot.task_id !== handoff.task_id) {
        throw new Error(`[Repository] createHandoffContext failed: Handoff ContextSnapshot "${handoff.handoff_snapshot_id}" does not match project/task.`);
      }
    }

    assertConsistentAttemptBindings('createHandoffContext', [
      { label: 'Handoff attempt', attemptId: handoff.attempt_id },
      { label: 'From AgentAssignment attempt', attemptId: fromAsgn?.attempt_id },
      { label: 'To AgentAssignment attempt', attemptId: toAsgn?.attempt_id },
      { label: 'Source ContextSnapshot attempt', attemptId: sourceSnapshot?.attempt_id },
      { label: 'Handoff ContextSnapshot attempt', attemptId: handoffSnapshot?.attempt_id },
    ]);

    this.db
      .prepare(`
        INSERT INTO handoff_contexts (
          id, project_id, task_id, attempt_id, from_assignment_id, to_assignment_id,
          source_snapshot_id, handoff_snapshot_id, reason, status, created_at, consumed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        handoff.id,
        handoff.project_id,
        handoff.task_id,
        handoff.attempt_id,
        handoff.from_assignment_id,
        handoff.to_assignment_id,
        handoff.source_snapshot_id,
        handoff.handoff_snapshot_id,
        handoff.reason,
        handoff.status,
        handoff.created_at,
        handoff.consumed_at
      );
  }

  public getHandoffContext(id: string): HandoffContext | null {
    const row = this.db.prepare('SELECT * FROM handoff_contexts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapHandoffContext(row);
  }

  public getHandoffContextsByTask(taskId: string): HandoffContext[] {
    const rows = this.db
      .prepare('SELECT * FROM handoff_contexts WHERE task_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => this.mapHandoffContext(r));
  }

  public updateHandoffContextStatus(id: string, status: HandoffContextStatus, consumedAt?: string | null): void {
    const existing = this.getHandoffContext(id);
    if (!existing) return;

    this.db
      .prepare('UPDATE handoff_contexts SET status = ?, consumed_at = ? WHERE id = ?')
      .run(status, consumedAt !== undefined ? consumedAt : existing.consumed_at, id);
  }

  private mapHandoffContext(row: Record<string, unknown>): HandoffContext {
    return {
      id: String(row.id),
      project_id: String(row.project_id),
      task_id: String(row.task_id),
      attempt_id: row.attempt_id ? String(row.attempt_id) : null,
      from_assignment_id: row.from_assignment_id ? String(row.from_assignment_id) : null,
      to_assignment_id: row.to_assignment_id ? String(row.to_assignment_id) : null,
      source_snapshot_id: String(row.source_snapshot_id),
      handoff_snapshot_id: row.handoff_snapshot_id ? String(row.handoff_snapshot_id) : null,
      reason: String(row.reason),
      status: row.status as HandoffContextStatus,
      created_at: String(row.created_at),
      consumed_at: row.consumed_at ? String(row.consumed_at) : null,
    };
  }

  public getProviderHealthObservation(authorizationId: string): ProviderHealthObservation | null {
    const row = this.db
      .prepare('SELECT * FROM provider_health_observations WHERE authorization_id = ?')
      .get(authorizationId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapProviderHealthObservation(row);
  }

  public getProviderHealthObservationsForAccount(accountId: string, limit: number = 100): ProviderHealthObservation[] {
    const rows = this.db
      .prepare('SELECT * FROM provider_health_observations WHERE account_id = ? ORDER BY observed_at DESC, rowid DESC LIMIT ?')
      .all(accountId, limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapProviderHealthObservation(r));
  }

  public claimProviderHealthObservation(observation: ProviderHealthObservation): 'RECORDED' | 'ALREADY_RECORDED' {
    return this.runInImmediateTransaction(() => {
      // 1. Runtime shape validation
      if (
        !observation ||
        typeof observation.authorization_id !== 'string' ||
        observation.authorization_id.trim() === '' ||
        typeof observation.execution_id !== 'string' ||
        observation.execution_id.trim() === '' ||
        typeof observation.account_id !== 'string' ||
        observation.account_id.trim() === '' ||
        typeof observation.provider_id !== 'string' ||
        observation.provider_id.trim() === '' ||
        typeof observation.resource_id !== 'string' ||
        observation.resource_id.trim() === '' ||
        typeof observation.assignment_id !== 'string' ||
        observation.assignment_id.trim() === '' ||
        typeof observation.routing_decision_id !== 'string' ||
        observation.routing_decision_id.trim() === '' ||
        observation.provenance_version !== 1 ||
        observation.provenance_source !== 'PROVIDER_DISPATCH_SERVICE' ||
        (observation.mode !== 'LEGACY' && observation.mode !== 'SCHEDULED') ||
        (observation.adapter_invocation !== 'RETURNED' && observation.adapter_invocation !== 'THREW') ||
        typeof observation.observed_at !== 'string' ||
        observation.observed_at.trim() === '' ||
        isNaN(Date.parse(observation.observed_at))
      ) {
        throw new Error('INVALID_OBSERVATION_SHAPE: Observation fails runtime shape validation.');
      }

      // 2. Bounded result_status validation
      const VALID_RESULT_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'AWAITING_OWNER']);
      if (!VALID_RESULT_STATUSES.has(observation.result_status)) {
        throw new Error(`INVALID_RESULT_STATUS: Unsupported result_status "${observation.result_status}".`);
      }

      // 3. Bounded classified_category validation
      const VALID_OBSERVATION_CATEGORIES = new Set<string>([
        'SUCCESS',
        'AWAITING_OWNER',
        'ADAPTER_THROW',
        'RATE_LIMITED',
        'QUOTA_EXHAUSTED',
        'AUTHENTICATION_FAILURE',
        'RESOURCE_UNAVAILABLE',
        'CANCELLED',
        'POLICY_DENIAL',
        'PROTOCOL_INVALID',
        'LOCAL_PROCESS_FAILURE',
        'TIMEOUT',
        'NONZERO_EXIT',
        'OUTPUT_LIMIT_EXCEEDED',
        'UNKNOWN',
      ]);
      if (!VALID_OBSERVATION_CATEGORIES.has(observation.classified_category)) {
        throw new Error(`INVALID_CLASSIFIED_CATEGORY: Unsupported classified_category "${observation.classified_category}".`);
      }

      // 4. Duplicate-first check
      const existingRow = this.db
        .prepare('SELECT * FROM provider_health_observations WHERE authorization_id = ?')
        .get(observation.authorization_id) as Record<string, unknown> | undefined;

      if (existingRow) {
        const existing = this.mapProviderHealthObservation(existingRow);
        const isIdentical =
          existing.execution_id === observation.execution_id &&
          existing.account_id === observation.account_id &&
          existing.provider_id === observation.provider_id &&
          existing.resource_id === observation.resource_id &&
          existing.assignment_id === observation.assignment_id &&
          existing.attempt_id === observation.attempt_id &&
          existing.routing_decision_id === observation.routing_decision_id &&
          existing.provenance_version === observation.provenance_version &&
          existing.provenance_source === observation.provenance_source &&
          existing.mode === observation.mode &&
          existing.adapter_invocation === observation.adapter_invocation &&
          existing.result_status === observation.result_status &&
          existing.classified_category === observation.classified_category;

        if (isIdentical) {
          return 'ALREADY_RECORDED';
        }

        throw new Error(
          `OBSERVATION_INTEGRITY_MISMATCH: Duplicate observation for authorization "${observation.authorization_id}" with conflicting content.`
        );
      }

      // 5. ExecutionAuthorization lookup + validation
      const auth = this.getExecutionAuthorization(observation.authorization_id);
      if (!auth) {
        throw new Error(`AUTHORIZATION_NOT_FOUND: ExecutionAuthorization "${observation.authorization_id}" not found.`);
      }

      if (auth.status !== 'DISPATCHED') {
        throw new Error(
          `AUTHORIZATION_NOT_DISPATCHED: ExecutionAuthorization "${auth.id}" status is "${auth.status}", expected "DISPATCHED".`
        );
      }

      if (auth.routing_decision_id !== observation.routing_decision_id) {
        throw new Error(
          `ROUTING_DECISION_ID_MISMATCH: Authorization routing_decision_id "${auth.routing_decision_id}" does not match observation routing_decision_id "${observation.routing_decision_id}".`
        );
      }

      if (auth.selected_provider_id !== observation.provider_id) {
        throw new Error(
          `PROVIDER_ID_MISMATCH: Authorization selected_provider_id "${auth.selected_provider_id}" does not match observation provider_id "${observation.provider_id}".`
        );
      }

      if (auth.selected_resource_id !== observation.resource_id) {
        throw new Error(
          `RESOURCE_ID_MISMATCH: Authorization selected_resource_id "${auth.selected_resource_id}" does not match observation resource_id "${observation.resource_id}".`
        );
      }

      if (auth.attempt_id !== observation.attempt_id) {
        throw new Error(
          `ATTEMPT_ID_MISMATCH: Authorization attempt_id "${auth.attempt_id}" does not match observation attempt_id "${observation.attempt_id}".`
        );
      }

      // 6. AgentAssignment lookup + validation
      const assignment = this.getAgentAssignment(observation.assignment_id);
      if (!assignment) {
        throw new Error(`ASSIGNMENT_NOT_FOUND: AgentAssignment "${observation.assignment_id}" not found.`);
      }

      if (assignment.project_id !== auth.project_id) {
        throw new Error(
          `PROJECT_ID_MISMATCH: Assignment project_id "${assignment.project_id}" does not match authorization project_id "${auth.project_id}".`
        );
      }

      if (assignment.task_id !== auth.task_id) {
        throw new Error(
          `TASK_ID_MISMATCH: Assignment task_id "${assignment.task_id}" does not match authorization task_id "${auth.task_id}".`
        );
      }

      if (assignment.attempt_id !== auth.attempt_id) {
        throw new Error(
          `ATTEMPT_ID_MISMATCH: Assignment attempt_id "${assignment.attempt_id}" does not match authorization attempt_id "${auth.attempt_id}".`
        );
      }

      if (assignment.routing_decision_id !== auth.routing_decision_id) {
        throw new Error(
          `ROUTING_DECISION_ID_MISMATCH: Assignment routing_decision_id "${assignment.routing_decision_id}" does not match authorization routing_decision_id "${auth.routing_decision_id}".`
        );
      }

      if (assignment.selected_provider_id !== observation.provider_id) {
        throw new Error(
          `ASSIGNMENT_PROVIDER_ID_MISMATCH: Assignment selected_provider_id "${assignment.selected_provider_id}" does not match observation provider_id "${observation.provider_id}".`
        );
      }

      if (assignment.selected_account_id !== observation.account_id) {
        throw new Error(
          `ASSIGNMENT_ACCOUNT_ID_MISMATCH: Assignment selected_account_id "${assignment.selected_account_id}" does not match observation account_id "${observation.account_id}".`
        );
      }

      if (assignment.selected_resource_id !== observation.resource_id) {
        throw new Error(
          `ASSIGNMENT_RESOURCE_ID_MISMATCH: Assignment selected_resource_id "${assignment.selected_resource_id}" does not match observation resource_id "${observation.resource_id}".`
        );
      }

      // 7. TaskAttempt coherence when attempt_id non-null
      if (observation.attempt_id != null) {
        const attempt = this.getTaskAttempt(observation.attempt_id);
        if (!attempt) {
          throw new Error(`TASK_ATTEMPT_NOT_FOUND: TaskAttempt "${observation.attempt_id}" not found.`);
        }
        if (attempt.task_id !== auth.task_id) {
          throw new Error(
            `TASK_ATTEMPT_TASK_MISMATCH: TaskAttempt task_id "${attempt.task_id}" does not match authorization task_id "${auth.task_id}".`
          );
        }
      }

      // 8. ProviderAccount coherence
      const account = this.getProviderAccount(observation.account_id);
      if (!account) {
        throw new Error(`PROVIDER_ACCOUNT_NOT_FOUND: ProviderAccount "${observation.account_id}" not found.`);
      }
      if (account.provider_id !== observation.provider_id) {
        throw new Error(
          `ACCOUNT_PROVIDER_MISMATCH: ProviderAccount provider_id "${account.provider_id}" does not match observation provider_id "${observation.provider_id}".`
        );
      }

      // 9. Provider coherence
      const provider = this.getProvider(observation.provider_id);
      if (!provider) {
        throw new Error(`PROVIDER_NOT_FOUND: Provider "${observation.provider_id}" not found.`);
      }

      // 10. ProviderResource coherence
      const resource = this.getProviderResource(observation.resource_id);
      if (!resource) {
        throw new Error(`PROVIDER_RESOURCE_NOT_FOUND: ProviderResource "${observation.resource_id}" not found.`);
      }
      if (resource.provider_id !== observation.provider_id) {
        throw new Error(
          `RESOURCE_PROVIDER_MISMATCH: ProviderResource provider_id "${resource.provider_id}" does not match observation provider_id "${observation.provider_id}".`
        );
      }
      if (resource.provider_account_id != null && resource.provider_account_id !== observation.account_id) {
        throw new Error(
          `RESOURCE_ACCOUNT_MISMATCH: ProviderResource provider_account_id "${resource.provider_account_id}" does not match observation account_id "${observation.account_id}".`
        );
      }

      // 11. Insert row
      this.db
        .prepare(`
          INSERT INTO provider_health_observations (
            authorization_id,
            execution_id,
            account_id,
            provider_id,
            resource_id,
            assignment_id,
            attempt_id,
            routing_decision_id,
            provenance_version,
            provenance_source,
            mode,
            adapter_invocation,
            result_status,
            classified_category,
            observed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          observation.authorization_id,
          observation.execution_id,
          observation.account_id,
          observation.provider_id,
          observation.resource_id,
          observation.assignment_id,
          observation.attempt_id ?? null,
          observation.routing_decision_id,
          observation.provenance_version,
          observation.provenance_source,
          observation.mode,
          observation.adapter_invocation,
          observation.result_status,
          observation.classified_category,
          observation.observed_at
        );

      return 'RECORDED';
    });
  }

  private mapProviderHealthObservation(row: Record<string, unknown>): ProviderHealthObservation {
    return {
      authorization_id: String(row.authorization_id),
      execution_id: String(row.execution_id),
      account_id: String(row.account_id),
      provider_id: String(row.provider_id),
      resource_id: String(row.resource_id),
      assignment_id: String(row.assignment_id),
      attempt_id: row.attempt_id ? String(row.attempt_id) : null,
      routing_decision_id: String(row.routing_decision_id),
      provenance_version: Number(row.provenance_version) as 1,
      provenance_source: String(row.provenance_source) as 'PROVIDER_DISPATCH_SERVICE',
      mode: String(row.mode) as 'LEGACY' | 'SCHEDULED',
      adapter_invocation: String(row.adapter_invocation) as 'RETURNED' | 'THREW',
      result_status: String(row.result_status),
      classified_category: String(row.classified_category) as ProviderHealthObservation['classified_category'],
      observed_at: String(row.observed_at),
    };
  }
}
