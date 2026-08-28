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
  ProviderHealthObservation,
  ProviderHealthObservationRecord,
  ProviderHealthObservationCategory,
  FailoverPolicyAuthoritySnapshotV1,
  ProviderAccountHealthAction,
  FailoverPolicyParseResult,
  ProviderHealthObservationApplicationStatus,
  ProviderHealthObservationApplicationResult,
  ProviderHealthRoutingSafetyStatus,
  ProviderHealthRoutingSafetyEvaluation,
  HandoffTransfer,
  HandoffTransferStatus,
  AdapterOutcome,
  ProviderTerminationStatus,
} from '../types/domain';
import type { ProviderDispatchExecutionResult } from '../services/ProviderDispatchService';
import { ExecutionFailureClassifier } from '../services/ExecutionFailureClassifier';
import { FailureHealthMutationPolicyService } from '../services/FailureHealthMutationPolicyService';
import { FailoverPolicyParser } from '../services/FailoverPolicyParser';
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
    const tableInfo = this.db.pragma('table_info(tasks)') as { name: string }[];
    const columnNames = new Set(tableInfo.map((c) => c.name));

    if (columnNames.has('ownership_epoch')) {
      this.db
        .prepare(`
          INSERT INTO tasks (
            id, project_id, milestone_id, title, description, state, paused_from_state,
            priority, risk, assigned_agent_id, revision_count, max_revisions,
            base_sha, current_sha, progress_cache_percent, progress_computed_at,
            acceptance_criteria_json, constraints_json, ownership_epoch, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          task.ownership_epoch ?? 1,
          task.created_at,
          task.updated_at
        );
    } else {
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

  public getTaskOwnershipEpoch(taskId: string): number {
    const row = this.db.prepare('SELECT ownership_epoch FROM tasks WHERE id = ?').get(taskId) as { ownership_epoch: number } | undefined;
    if (!row) {
      throw new Error(`[TaskOwnershipEpoch] Task "${taskId}" not found.`);
    }
    return Number(row.ownership_epoch);
  }

  public bumpTaskOwnershipEpoch(taskId: string, expectedEpoch: number): { success: boolean; newEpoch: number } {
    return this.runInImmediateTransaction(() => {
      const current = this.getTaskOwnershipEpoch(taskId);
      if (current !== expectedEpoch) {
        return { success: false, newEpoch: current };
      }
      const newEpoch = current + 1;
      const now = new Date().toISOString();
      const info = this.db
        .prepare('UPDATE tasks SET ownership_epoch = ?, updated_at = ? WHERE id = ? AND ownership_epoch = ?')
        .run(newEpoch, now, taskId, expectedEpoch);
      if (info.changes === 0) {
        return { success: false, newEpoch: this.getTaskOwnershipEpoch(taskId) };
      }
      return { success: true, newEpoch };
    });
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
      ownership_epoch: row.ownership_epoch !== undefined && row.ownership_epoch !== null ? Number(row.ownership_epoch) : 1,
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
        INSERT INTO task_attempts (id, task_id, attempt_number, agent_id, agent_profile_id, status, started_at, ended_at, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        attempt.id,
        attempt.task_id,
        attempt.attempt_number,
        attempt.agent_id ?? null,
        attempt.agent_profile_id ?? null,
        attempt.status,
        attempt.started_at,
        attempt.ended_at ?? null,
        attempt.summary ?? null
      );
  }

  public getTaskAttempt(id: string): TaskAttempt | null {
    const row = this.db.prepare('SELECT * FROM task_attempts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      task_id: String(row.task_id),
      attempt_number: Number(row.attempt_number),
      agent_id: row.agent_id !== null && row.agent_id !== undefined ? String(row.agent_id) : null,
      agent_profile_id: row.agent_profile_id !== null && row.agent_profile_id !== undefined ? String(row.agent_profile_id) : null,
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
      agent_id: r.agent_id !== null && r.agent_id !== undefined ? String(r.agent_id) : null,
      agent_profile_id: r.agent_profile_id !== null && r.agent_profile_id !== undefined ? String(r.agent_profile_id) : null,
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
        agent_profile_id: sourceAttempt.agent_profile_id ?? null,
        status,
        started_at: startedAt,
        ended_at: params.endedAt ?? null,
        summary: params.summary ?? null,
      };

      this.db
        .prepare(`
          INSERT INTO task_attempts (id, task_id, attempt_number, agent_id, agent_profile_id, status, started_at, ended_at, summary)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          successorAttempt.id,
          successorAttempt.task_id,
          successorAttempt.attempt_number,
          successorAttempt.agent_id,
          successorAttempt.agent_profile_id,
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
    return this.runInImmediateTransaction(() => {
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
    });
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
    const tableInfo = this.db.pragma('table_info(execution_authorizations)') as { name: string }[];
    const columnNames = new Set(tableInfo.map((c) => c.name));

    if (columnNames.has('task_ownership_epoch')) {
      this.db
        .prepare(`
          INSERT INTO execution_authorizations (
            id, project_id, task_id, attempt_id, task_revision, base_sha,
            repository_head_sha, manager_message_id, manager_payload_hash,
            routing_decision_id, selected_resource_id, selected_provider_id,
            instruction_payload_hash, context_manifest_hash,
            canonical_instructions_json, context_files_json, canonical_payload_json, status,
            created_at, dispatched_at, task_ownership_epoch, execution_id,
            adapter_started_at, adapter_finished_at, adapter_outcome,
            cancellation_requested_at, termination_confirmed_at,
            termination_status, termination_source
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          auth.dispatched_at,
          auth.task_ownership_epoch ?? 1,
          auth.execution_id ?? null,
          auth.adapter_started_at ?? null,
          auth.adapter_finished_at ?? null,
          auth.adapter_outcome ?? null,
          auth.cancellation_requested_at ?? null,
          auth.termination_confirmed_at ?? null,
          auth.termination_status ?? null,
          auth.termination_source ?? null
        );
    } else {
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
  }

  public getExecutionAuthorization(id: string): ExecutionAuthorization | null {
    const row = this.db.prepare('SELECT * FROM execution_authorizations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapExecutionAuthorization(row);
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

  public claimAdapterExecutionStart(params: {
    authorizationId: string;
    executionId: string;
    expectedEpoch: number;
    startedAt?: string;
  }): { success: boolean; alreadyClaimed: boolean; error?: string } {
    return this.runInImmediateTransaction(() => {
      const auth = this.getExecutionAuthorization(params.authorizationId);
      if (!auth) {
        return { success: false, alreadyClaimed: false, error: 'AUTHORIZATION_NOT_FOUND' };
      }

      // Status Fencing: start claim may succeed ONLY when status === 'DISPATCHED'
      if (auth.status !== 'DISPATCHED') {
        return {
          success: false,
          alreadyClaimed: false,
          error: `AUTHORIZATION_NOT_DISPATCHED: expected status DISPATCHED, found ${auth.status}`,
        };
      }

      // Check current task ownership epoch
      const currentTaskEpoch = this.getTaskOwnershipEpoch(auth.task_id);
      if (currentTaskEpoch !== params.expectedEpoch || auth.task_ownership_epoch !== params.expectedEpoch) {
        return {
          success: false,
          alreadyClaimed: false,
          error: `OWNERSHIP_EPOCH_MISMATCH: expected ${params.expectedEpoch}, current task epoch is ${currentTaskEpoch}, auth epoch is ${auth.task_ownership_epoch}`,
        };
      }

      // Check if already started
      if (auth.adapter_started_at) {
        if (auth.execution_id === params.executionId) {
          return { success: true, alreadyClaimed: true };
        }
        return {
          success: false,
          alreadyClaimed: false,
          error: `EXECUTION_ID_CONFLICT: already claimed with execution_id ${auth.execution_id}`,
        };
      }

      const startedAt = params.startedAt ?? new Date().toISOString();
      const res = this.db
        .prepare(`
          UPDATE execution_authorizations
          SET execution_id = ?, adapter_started_at = ?
          WHERE id = ? AND adapter_started_at IS NULL AND task_ownership_epoch = ? AND status = 'DISPATCHED'
        `)
        .run(params.executionId, startedAt, params.authorizationId, params.expectedEpoch);

      if (res.changes === 0) {
        return { success: false, alreadyClaimed: false, error: 'START_CLAIM_CAS_FAILED' };
      }

      return { success: true, alreadyClaimed: false };
    });
  }

  public completeAdapterExecution(params: {
    authorizationId: string;
    executionId: string;
    outcome: AdapterOutcome;
    finishedAt?: string;
  }): { success: boolean; alreadyCompleted: boolean; error?: string } {
    return this.runInImmediateTransaction(() => {
      const auth = this.getExecutionAuthorization(params.authorizationId);
      if (!auth) {
        return { success: false, alreadyCompleted: false, error: 'AUTHORIZATION_NOT_FOUND' };
      }

      if (!auth.adapter_started_at) {
        return { success: false, alreadyCompleted: false, error: 'EXECUTION_NEVER_STARTED' };
      }

      if (auth.execution_id !== params.executionId) {
        return {
          success: false,
          alreadyCompleted: false,
          error: `EXECUTION_ID_MISMATCH: expected ${auth.execution_id}, got ${params.executionId}`,
        };
      }

      if (auth.adapter_finished_at) {
        if (auth.adapter_outcome === params.outcome) {
          return { success: true, alreadyCompleted: true };
        }
        return {
          success: false,
          alreadyCompleted: false,
          error: `OUTCOME_CONFLICT: already completed with outcome ${auth.adapter_outcome}, attempted ${params.outcome}`,
        };
      }

      const finishedAt = params.finishedAt ?? new Date().toISOString();
      const res = this.db
        .prepare(`
          UPDATE execution_authorizations
          SET adapter_finished_at = ?, adapter_outcome = ?
          WHERE id = ? AND execution_id = ? AND adapter_finished_at IS NULL
        `)
        .run(finishedAt, params.outcome, params.authorizationId, params.executionId);

      if (res.changes === 0) {
        return { success: false, alreadyCompleted: false, error: 'COMPLETION_CAS_FAILED' };
      }

      return { success: true, alreadyCompleted: false };
    });
  }

  public markCancellationRequested(params: {
    authorizationId: string;
    executionId: string;
    requestedAt?: string;
  }): { success: boolean; alreadyRequested: boolean; error?: string } {
    return this.runInImmediateTransaction(() => {
      const auth = this.getExecutionAuthorization(params.authorizationId);
      if (!auth) {
        return { success: false, alreadyRequested: false, error: 'AUTHORIZATION_NOT_FOUND' };
      }

      if (!auth.adapter_started_at) {
        return {
          success: false,
          alreadyRequested: false,
          error: 'EXECUTION_NOT_STARTED',
        };
      }

      if (auth.execution_id !== params.executionId) {
        return {
          success: false,
          alreadyRequested: false,
          error: `EXECUTION_ID_MISMATCH: expected ${auth.execution_id}, got ${params.executionId}`,
        };
      }

      if (auth.cancellation_requested_at) {
        return { success: true, alreadyRequested: true };
      }

      const requestedAt = params.requestedAt ?? new Date().toISOString();
      const res = this.db
        .prepare(`
          UPDATE execution_authorizations
          SET cancellation_requested_at = ?
          WHERE id = ? AND execution_id = ? AND cancellation_requested_at IS NULL
        `)
        .run(requestedAt, params.authorizationId, params.executionId);

      return { success: res.changes === 1, alreadyRequested: false };
    });
  }

  public confirmExecutionTermination(params: {
    authorizationId: string;
    executionId: string;
    terminationStatus: ProviderTerminationStatus;
    terminationSource: string;
    confirmedAt?: string;
  }): { success: boolean; alreadyConfirmed: boolean; error?: string } {
    return this.runInImmediateTransaction(() => {
      const auth = this.getExecutionAuthorization(params.authorizationId);
      if (!auth) {
        return { success: false, alreadyConfirmed: false, error: 'AUTHORIZATION_NOT_FOUND' };
      }

      if (!auth.adapter_started_at) {
        return {
          success: false,
          alreadyConfirmed: false,
          error: 'EXECUTION_NOT_STARTED',
        };
      }

      if (auth.execution_id !== params.executionId) {
        return {
          success: false,
          alreadyConfirmed: false,
          error: `EXECUTION_ID_MISMATCH: expected ${auth.execution_id}, got ${params.executionId}`,
        };
      }

      if (auth.termination_status === 'CONFIRMED_TERMINATED') {
        if (params.terminationStatus === 'CONFIRMED_TERMINATED') {
          if (auth.termination_source === params.terminationSource) {
            return { success: true, alreadyConfirmed: true };
          }
          return {
            success: false,
            alreadyConfirmed: false,
            error: `TERMINATION_SOURCE_CONFLICT: already confirmed by ${auth.termination_source}, contradictory source ${params.terminationSource}`,
          };
        }
        return {
          success: false,
          alreadyConfirmed: false,
          error: 'TERMINATION_STATUS_CONFLICT: cannot transition CONFIRMED_TERMINATED to UNRESOLVED',
        };
      }

      if (auth.termination_status === 'UNRESOLVED') {
        if (params.terminationStatus === 'UNRESOLVED') {
          if (auth.termination_source === params.terminationSource) {
            return { success: true, alreadyConfirmed: true };
          }
          return {
            success: false,
            alreadyConfirmed: false,
            error: `TERMINATION_SOURCE_CONFLICT: already UNRESOLVED with source ${auth.termination_source}, contradictory source ${params.terminationSource}`,
          };
        }
      }

      if (params.terminationStatus === 'UNRESOLVED') {
        const res = this.db
          .prepare(`
            UPDATE execution_authorizations
            SET termination_status = 'UNRESOLVED',
                termination_source = ?,
                termination_confirmed_at = NULL
            WHERE id = ? AND execution_id = ?
          `)
          .run(params.terminationSource, params.authorizationId, params.executionId);

        return { success: res.changes === 1, alreadyConfirmed: false };
      }

      if (params.terminationStatus === 'CONFIRMED_TERMINATED') {
        const confirmedAt = params.confirmedAt ?? new Date().toISOString();
        const res = this.db
          .prepare(`
            UPDATE execution_authorizations
            SET termination_status = 'CONFIRMED_TERMINATED',
                termination_source = ?,
                termination_confirmed_at = ?
            WHERE id = ? AND execution_id = ?
          `)
          .run(params.terminationSource, confirmedAt, params.authorizationId, params.executionId);

        return { success: res.changes === 1, alreadyConfirmed: false };
      }

      return { success: false, alreadyConfirmed: false, error: 'INVALID_TERMINATION_STATUS' };
    });
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
    return rows.map((row) => this.mapExecutionAuthorization(row));
  }

  public getExecutionAuthorizationsByAttempt(attemptId: string): ExecutionAuthorization[] {
    const rows = this.db
      .prepare('SELECT * FROM execution_authorizations WHERE attempt_id = ? ORDER BY created_at DESC')
      .all(attemptId) as Record<string, unknown>[];
    return rows.map((row) => this.mapExecutionAuthorization(row));
  }

  private mapExecutionAuthorization(row: Record<string, unknown>): ExecutionAuthorization {
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
      task_ownership_epoch: row.task_ownership_epoch !== undefined && row.task_ownership_epoch !== null ? Number(row.task_ownership_epoch) : 1,
      execution_id: row.execution_id ? String(row.execution_id) : null,
      adapter_started_at: row.adapter_started_at ? String(row.adapter_started_at) : null,
      adapter_finished_at: row.adapter_finished_at ? String(row.adapter_finished_at) : null,
      adapter_outcome: row.adapter_outcome ? (row.adapter_outcome as AdapterOutcome) : null,
      cancellation_requested_at: row.cancellation_requested_at ? String(row.cancellation_requested_at) : null,
      termination_confirmed_at: row.termination_confirmed_at ? String(row.termination_confirmed_at) : null,
      termination_status: row.termination_status ? (row.termination_status as ProviderTerminationStatus) : null,
      termination_source: row.termination_source ? String(row.termination_source) : null,
    };
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

  public getCheckpoint(id: string): Checkpoint | null {
    const row = this.db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      task_id: String(row.task_id),
      attempt_id: row.attempt_id ? String(row.attempt_id) : null,
      sha: String(row.sha),
      tree_metadata: row.tree_metadata_json ? JSON.parse(String(row.tree_metadata_json)) : {},
      completed_steps: row.completed_steps_json ? JSON.parse(String(row.completed_steps_json)) : [],
      remaining_steps: row.remaining_steps_json ? JSON.parse(String(row.remaining_steps_json)) : [],
      tests_passing: Number(row.tests_passing),
      tests_failing: Number(row.tests_failing),
      known_issues: row.known_issues_json ? JSON.parse(String(row.known_issues_json)) : [],
      recommended_next_action: row.recommended_next_action ? String(row.recommended_next_action) : null,
      created_at: String(row.created_at),
    };
  }

  public createHandoff(h: Handoff): void {
    this.db
      .prepare(`
        INSERT INTO handoffs (id, task_id, attempt_id, previous_agent_id, reason, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(h.id, h.task_id, h.attempt_id, h.previous_agent_id, h.reason, JSON.stringify(h.payload), h.created_at);
  }

  // ==========================================
  // Handoff Transfers (R5I Durable Authority)
  // ==========================================
  public createHandoffTransfer(transfer: HandoffTransfer): { success: boolean; transfer: HandoffTransfer; duplicate: boolean; error?: string } {
    return this.runInImmediateTransaction(() => {
      const existing = this.getHandoffTransferByRequestId(transfer.request_id);
      if (existing) {
        const matches =
          existing.task_id === transfer.task_id &&
          existing.source_attempt_id === transfer.source_attempt_id &&
          existing.source_assignment_id === transfer.source_assignment_id &&
          existing.reason === transfer.reason &&
          existing.source_ownership_epoch === transfer.source_ownership_epoch;

        if (matches) {
          return { success: true, transfer: existing, duplicate: true };
        }

        return {
          success: false,
          transfer: existing,
          duplicate: false,
          error: `REQUEST_ID_CONFLICT: immutable request attributes do not match existing transfer for request_id ${transfer.request_id}`,
        };
      }

      this.db
        .prepare(`
          INSERT INTO handoff_transfers (
            id, request_id, task_id, source_attempt_id, successor_attempt_id,
            source_assignment_id, successor_assignment_id, successor_role_profile_id,
            successor_agent_profile_id, successor_context_snapshot_id, successor_context_spec_hash,
            handoff_context_id, checkpoint_id, source_authorization_id, successor_authorization_id,
            reason, status, source_ownership_epoch, successor_ownership_epoch,
            version, frozen_at, quiescing_at, relinquished_at, accepted_at,
            completed_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          transfer.id,
          transfer.request_id,
          transfer.task_id,
          transfer.source_attempt_id,
          transfer.successor_attempt_id ?? null,
          transfer.source_assignment_id,
          transfer.successor_assignment_id ?? null,
          transfer.successor_role_profile_id ?? null,
          transfer.successor_agent_profile_id ?? null,
          transfer.successor_context_snapshot_id ?? null,
          transfer.successor_context_spec_hash ?? null,
          transfer.handoff_context_id ?? null,
          transfer.checkpoint_id ?? null,
          transfer.source_authorization_id ?? null,
          transfer.successor_authorization_id ?? null,
          transfer.reason,
          transfer.status,
          transfer.source_ownership_epoch,
          transfer.successor_ownership_epoch ?? null,
          transfer.version ?? 1,
          transfer.frozen_at ?? null,
          transfer.quiescing_at ?? null,
          transfer.relinquished_at ?? null,
          transfer.accepted_at ?? null,
          transfer.completed_at ?? null,
          transfer.created_at,
          transfer.updated_at
        );

      return { success: true, transfer, duplicate: false };
    });
  }

  public getHandoffTransfer(id: string): HandoffTransfer | null {
    const row = this.db.prepare('SELECT * FROM handoff_transfers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapHandoffTransfer(row);
  }

  public getHandoffTransferByRequestId(requestId: string): HandoffTransfer | null {
    const row = this.db.prepare('SELECT * FROM handoff_transfers WHERE request_id = ?').get(requestId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapHandoffTransfer(row);
  }

  public getActiveHandoffTransferForSourceAttempt(sourceAttemptId: string): HandoffTransfer | null {
    const row = this.db
      .prepare(`
        SELECT * FROM handoff_transfers
        WHERE source_attempt_id = ?
          AND (
            status IN ('REQUESTED', 'FROZEN', 'QUIESCING', 'RELINQUISHED', 'SUCCESSOR_PREPARED', 'ROUTED', 'AUTHORIZED', 'ACCEPTED')
            OR relinquished_at IS NOT NULL
          )
        LIMIT 1
      `)
      .get(sourceAttemptId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapHandoffTransfer(row);
  }

  public getHandoffTransfersByTask(taskId: string): HandoffTransfer[] {
    const rows = this.db
      .prepare('SELECT * FROM handoff_transfers WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => this.mapHandoffTransfer(r));
  }

  public updateHandoffTransferStatus(params: {
    id: string;
    fromStatus: HandoffTransferStatus | HandoffTransferStatus[];
    toStatus: HandoffTransferStatus;
    expectedVersion: number;
    additionalFields?: Partial<HandoffTransfer>;
  }): { success: boolean; transfer?: HandoffTransfer; error?: string } {
    return this.runInImmediateTransaction(() => {
      const existing = this.getHandoffTransfer(params.id);
      if (!existing) {
        return { success: false, error: 'HANDOFF_TRANSFER_NOT_FOUND' };
      }

      const allowedStatuses = Array.isArray(params.fromStatus) ? params.fromStatus : [params.fromStatus];
      if (!allowedStatuses.includes(existing.status)) {
        return {
          success: false,
          error: `STATUS_PRECONDITION_FAILED: expected one of [${allowedStatuses.join(', ')}], found ${existing.status}`,
        };
      }

      if (existing.version !== params.expectedVersion) {
        return {
          success: false,
          error: `VERSION_CONFLICT: expected version ${params.expectedVersion}, found ${existing.version}`,
        };
      }

      const newVersion = existing.version + 1;
      const nowIso = new Date().toISOString();
      const fields = params.additionalFields ?? {};

      const sourceAssignmentId = fields.source_assignment_id !== undefined ? fields.source_assignment_id : existing.source_assignment_id;
      const successorAttemptId = fields.successor_attempt_id !== undefined ? fields.successor_attempt_id : existing.successor_attempt_id;
      const successorAssignmentId = fields.successor_assignment_id !== undefined ? fields.successor_assignment_id : existing.successor_assignment_id;
      const successorRoleProfileId = fields.successor_role_profile_id !== undefined ? fields.successor_role_profile_id : existing.successor_role_profile_id;
      const successorAgentProfileId = fields.successor_agent_profile_id !== undefined ? fields.successor_agent_profile_id : existing.successor_agent_profile_id;
      const successorContextSnapshotId = fields.successor_context_snapshot_id !== undefined ? fields.successor_context_snapshot_id : existing.successor_context_snapshot_id;
      const successorContextSpecHash = fields.successor_context_spec_hash !== undefined ? fields.successor_context_spec_hash : existing.successor_context_spec_hash;
      const handoffContextId = fields.handoff_context_id !== undefined ? fields.handoff_context_id : existing.handoff_context_id;
      const checkpointId = fields.checkpoint_id !== undefined ? fields.checkpoint_id : existing.checkpoint_id;
      const sourceAuthorizationId = fields.source_authorization_id !== undefined ? fields.source_authorization_id : existing.source_authorization_id;
      const successorAuthorizationId = fields.successor_authorization_id !== undefined ? fields.successor_authorization_id : existing.successor_authorization_id;
      const successorOwnershipEpoch = fields.successor_ownership_epoch !== undefined ? fields.successor_ownership_epoch : existing.successor_ownership_epoch;
      const frozenAt = fields.frozen_at !== undefined ? fields.frozen_at : existing.frozen_at;
      const quiescingAt = fields.quiescing_at !== undefined ? fields.quiescing_at : existing.quiescing_at;
      const relinquishedAt = fields.relinquished_at !== undefined ? fields.relinquished_at : existing.relinquished_at;
      const acceptedAt = fields.accepted_at !== undefined ? fields.accepted_at : existing.accepted_at;
      const completedAt = fields.completed_at !== undefined ? fields.completed_at : existing.completed_at;

      const res = this.db
        .prepare(`
          UPDATE handoff_transfers
          SET status = ?,
              source_assignment_id = ?,
              successor_attempt_id = ?,
              successor_assignment_id = ?,
              successor_role_profile_id = ?,
              successor_agent_profile_id = ?,
              successor_context_snapshot_id = ?,
              successor_context_spec_hash = ?,
              handoff_context_id = ?,
              checkpoint_id = ?,
              source_authorization_id = ?,
              successor_authorization_id = ?,
              successor_ownership_epoch = ?,
              version = ?,
              frozen_at = ?,
              quiescing_at = ?,
              relinquished_at = ?,
              accepted_at = ?,
              completed_at = ?,
              updated_at = ?
          WHERE id = ? AND version = ?
        `)
        .run(
          params.toStatus,
          sourceAssignmentId,
          successorAttemptId,
          successorAssignmentId,
          successorRoleProfileId,
          successorAgentProfileId,
          successorContextSnapshotId,
          successorContextSpecHash,
          handoffContextId,
          checkpointId,
          sourceAuthorizationId,
          successorAuthorizationId,
          successorOwnershipEpoch,
          newVersion,
          frozenAt,
          quiescingAt,
          relinquishedAt,
          acceptedAt,
          completedAt,
          nowIso,
          params.id,
          params.expectedVersion
        );

      if (res.changes === 0) {
        return { success: false, error: 'CONCURRENT_UPDATE_CONFLICT' };
      }

      return { success: true, transfer: this.getHandoffTransfer(params.id)! };
    });
  }

  public relinquishPredecessorOwnership(params: {
    transferId: string;
    expectedVersion: number;
    expectedSourceEpoch: number;
    expectedTaskLeaseToken?: string;
    relinquishedAt?: string;
  }): {
    success: boolean;
    transfer?: HandoffTransfer;
    newEpoch?: number;
    alreadyRelinquished?: boolean;
    error?: string;
    errorCode?:
      | 'TRANSFER_NOT_FOUND'
      | 'STATUS_CONFLICT'
      | 'VERSION_CONFLICT'
      | 'STALE_OWNERSHIP_EPOCH'
      | 'TASK_NOT_FOUND'
      | 'SOURCE_ATTEMPT_NOT_FOUND'
      | 'SOURCE_ATTEMPT_BINDING_MISMATCH'
      | 'SOURCE_ASSIGNMENT_NOT_FOUND'
      | 'SOURCE_ASSIGNMENT_BINDING_MISMATCH'
      | 'SOURCE_ASSIGNMENT_STATE_CONFLICT'
      | 'PREDECESSOR_EXECUTION_UNRESOLVED'
      | 'TASK_LEASE_AUTHORITY_UNVERIFIED'
      | 'TASK_LEASE_TOKEN_MISMATCH'
      | 'INTERNAL_ERROR';
    unresolvedAuthorizations?: string[];
  } {
    return this.runInImmediateTransaction(() => {
      // 1. Re-read handoff transfer
      const transfer = this.getHandoffTransfer(params.transferId);
      if (!transfer) {
        return {
          success: false,
          errorCode: 'TRANSFER_NOT_FOUND',
          error: `Handoff transfer "${params.transferId}" not found.`,
        };
      }

      // Idempotent replay check: if already RELINQUISHED with same expected source epoch and exact version
      if (transfer.status === 'RELINQUISHED' && transfer.relinquished_at !== null) {
        if (transfer.source_ownership_epoch !== params.expectedSourceEpoch) {
          return {
            success: false,
            errorCode: 'STALE_OWNERSHIP_EPOCH',
            error: `Transfer is already relinquished with historical source epoch ${transfer.source_ownership_epoch}, expected ${params.expectedSourceEpoch}.`,
          };
        }
        if (params.expectedVersion !== transfer.version - 1) {
          return {
            success: false,
            errorCode: 'VERSION_CONFLICT',
            error: `VERSION_CONFLICT: Replay expectedVersion ${params.expectedVersion} does not match pre-relinquishment version ${transfer.version - 1}.`,
          };
        }
        const currentEpoch = this.getTaskOwnershipEpoch(transfer.task_id);
        return {
          success: true,
          transfer,
          newEpoch: currentEpoch,
          alreadyRelinquished: true,
        };
      }

      // State check: must be QUIESCING
      if (transfer.status !== 'QUIESCING') {
        return {
          success: false,
          errorCode: 'STATUS_CONFLICT',
          error: `STATUS_CONFLICT: Expected transfer status QUIESCING, found ${transfer.status}.`,
        };
      }

      // Version CAS check
      if (transfer.version !== params.expectedVersion) {
        return {
          success: false,
          errorCode: 'VERSION_CONFLICT',
          error: `VERSION_CONFLICT: Expected transfer version ${params.expectedVersion}, found ${transfer.version}.`,
        };
      }

      // 2. Re-read Task
      const task = this.getTask(transfer.task_id);
      if (!task) {
        return {
          success: false,
          errorCode: 'TASK_NOT_FOUND',
          error: `Task "${transfer.task_id}" not found.`,
        };
      }

      const currentTaskEpoch = task.ownership_epoch ?? 1;
      if (
        currentTaskEpoch !== params.expectedSourceEpoch ||
        transfer.source_ownership_epoch !== params.expectedSourceEpoch
      ) {
        return {
          success: false,
          errorCode: 'STALE_OWNERSHIP_EPOCH',
          error: `STALE_OWNERSHIP_EPOCH: Expected epoch ${params.expectedSourceEpoch}, task current epoch is ${currentTaskEpoch}, transfer source epoch is ${transfer.source_ownership_epoch}.`,
        };
      }

      // 3. Re-read Source TaskAttempt inside transaction
      const attemptRow = this.db
        .prepare('SELECT * FROM task_attempts WHERE id = ?')
        .get(transfer.source_attempt_id) as Record<string, unknown> | undefined;
      if (!attemptRow) {
        return {
          success: false,
          errorCode: 'SOURCE_ATTEMPT_NOT_FOUND',
          error: `SOURCE_ATTEMPT_NOT_FOUND: Source attempt "${transfer.source_attempt_id}" not found.`,
        };
      }
      if (String(attemptRow.task_id) !== transfer.task_id) {
        return {
          success: false,
          errorCode: 'SOURCE_ATTEMPT_BINDING_MISMATCH',
          error: `SOURCE_ATTEMPT_BINDING_MISMATCH: Source attempt task_id "${attemptRow.task_id}" does not match transfer task_id "${transfer.task_id}".`,
        };
      }

      // 4. Re-read Source AgentAssignment inside transaction (if bound)
      if (transfer.source_assignment_id) {
        const assignmentRow = this.db
          .prepare('SELECT * FROM agent_assignments WHERE id = ?')
          .get(transfer.source_assignment_id) as Record<string, unknown> | undefined;
        if (!assignmentRow) {
          return {
            success: false,
            errorCode: 'SOURCE_ASSIGNMENT_NOT_FOUND',
            error: `SOURCE_ASSIGNMENT_NOT_FOUND: Source assignment "${transfer.source_assignment_id}" not found.`,
          };
        }
        if (String(assignmentRow.task_id) !== transfer.task_id) {
          return {
            success: false,
            errorCode: 'SOURCE_ASSIGNMENT_BINDING_MISMATCH',
            error: `SOURCE_ASSIGNMENT_BINDING_MISMATCH: Source assignment task_id "${assignmentRow.task_id}" does not match transfer task_id "${transfer.task_id}".`,
          };
        }
        if (
          assignmentRow.attempt_id !== null &&
          assignmentRow.attempt_id !== undefined &&
          String(assignmentRow.attempt_id) !== transfer.source_attempt_id
        ) {
          return {
            success: false,
            errorCode: 'SOURCE_ASSIGNMENT_BINDING_MISMATCH',
            error: `SOURCE_ASSIGNMENT_BINDING_MISMATCH: Source assignment attempt_id "${assignmentRow.attempt_id}" does not match transfer source_attempt_id "${transfer.source_attempt_id}".`,
          };
        }
        const asgnStatus = String(assignmentRow.status);
        if (asgnStatus !== 'ASSIGNED' && asgnStatus !== 'RUNNING') {
          return {
            success: false,
            errorCode: 'SOURCE_ASSIGNMENT_STATE_CONFLICT',
            error: `SOURCE_ASSIGNMENT_STATE_CONFLICT: Source assignment status is "${asgnStatus}", expected "ASSIGNED" or "RUNNING".`,
          };
        }
      }

      // 5. Recheck quiescence condition INSIDE this immediate transaction
      const authRows = this.db
        .prepare('SELECT * FROM execution_authorizations WHERE attempt_id = ?')
        .all(transfer.source_attempt_id) as Record<string, unknown>[];

      const unresolvedAuthIds: string[] = [];
      for (const aRow of authRows) {
        const auth = this.mapExecutionAuthorization(aRow);
        if (auth.adapter_started_at) {
          // Started execution must have CONFIRMED_TERMINATED and non-null termination_confirmed_at
          const isTerminated =
            auth.termination_status === 'CONFIRMED_TERMINATED' &&
            auth.termination_confirmed_at !== null &&
            auth.termination_confirmed_at !== undefined;

          if (!isTerminated) {
            unresolvedAuthIds.push(auth.id);
          }
        }
      }

      if (unresolvedAuthIds.length > 0) {
        return {
          success: false,
          errorCode: 'PREDECESSOR_EXECUTION_UNRESOLVED',
          unresolvedAuthorizations: unresolvedAuthIds,
          error: `PREDECESSOR_EXECUTION_UNRESOLVED: Source attempt "${transfer.source_attempt_id}" has ${unresolvedAuthIds.length} unresolved active execution(s): [${unresolvedAuthIds.join(', ')}].`,
        };
      }

      // 6. Check Task Lease authority (if unreleased lease exists)
      const activeLeaseRow = this.db
        .prepare('SELECT * FROM task_leases WHERE task_id = ? AND released_at IS NULL')
        .get(transfer.task_id) as { task_id: string; lease_token: string } | undefined;

      if (activeLeaseRow) {
        if (!params.expectedTaskLeaseToken) {
          return {
            success: false,
            errorCode: 'TASK_LEASE_AUTHORITY_UNVERIFIED',
            error: 'TASK_LEASE_AUTHORITY_UNVERIFIED: Active task lease exists but expectedTaskLeaseToken was omitted.',
          };
        }
        if (params.expectedTaskLeaseToken !== activeLeaseRow.lease_token) {
          return {
            success: false,
            errorCode: 'TASK_LEASE_TOKEN_MISMATCH',
            error: 'TASK_LEASE_TOKEN_MISMATCH: Provided lease token does not match active task lease.',
          };
        }
      }

      // 7. Atomic Linearization
      const nowIso = params.relinquishedAt ?? new Date().toISOString();
      const newEpoch = currentTaskEpoch + 1;

      // 7a. Bump task ownership epoch
      const epochRes = this.db
        .prepare('UPDATE tasks SET ownership_epoch = ?, updated_at = ? WHERE id = ? AND ownership_epoch = ?')
        .run(newEpoch, nowIso, transfer.task_id, currentTaskEpoch);

      if (epochRes.changes !== 1) {
        return {
          success: false,
          errorCode: 'STALE_OWNERSHIP_EPOCH',
          error: 'CONCURRENT_EPOCH_MUTATION',
        };
      }

      // 7b. Source assignment transition to HANDED_OFF (if bound)
      if (transfer.source_assignment_id) {
        const asgnRes = this.db
          .prepare(`
            UPDATE agent_assignments
            SET status = 'HANDED_OFF', ended_at = ?
            WHERE id = ? AND task_id = ? AND status IN ('ASSIGNED', 'RUNNING')
          `)
          .run(nowIso, transfer.source_assignment_id, transfer.task_id);

        if (asgnRes.changes !== 1) {
          throw new Error(
            `[HandoffRelinquish] Failed to update source assignment "${transfer.source_assignment_id}" to HANDED_OFF.`
          );
        }
      }

      // 7c. Release active task lease if one exists
      if (activeLeaseRow) {
        const leaseRes = this.db
          .prepare('UPDATE task_leases SET released_at = ? WHERE task_id = ? AND lease_token = ? AND released_at IS NULL')
          .run(nowIso, transfer.task_id, params.expectedTaskLeaseToken);

        if (leaseRes.changes !== 1) {
          throw new Error(
            `[HandoffRelinquish] Failed to release active task lease for task "${transfer.task_id}".`
          );
        }
      }

      // 7d. Update transfer to RELINQUISHED
      const newVersion = transfer.version + 1;
      const transferRes = this.db
        .prepare(`
          UPDATE handoff_transfers
          SET status = 'RELINQUISHED',
              relinquished_at = ?,
              version = ?,
              updated_at = ?
          WHERE id = ? AND version = ?
        `)
        .run(nowIso, newVersion, nowIso, transfer.id, transfer.version);

      if (transferRes.changes !== 1) {
        throw new Error(
          `[HandoffRelinquish] Failed to update transfer "${transfer.id}" status to RELINQUISHED.`
        );
      }

      const updatedTransfer = this.getHandoffTransfer(transfer.id)!;
      return {
        success: true,
        transfer: updatedTransfer,
        newEpoch,
        alreadyRelinquished: false,
      };
    });
  }

  public prepareHandoffSuccessor(params: {
    transferId: string;
    expectedVersion: number;
    expectedSuccessorEpoch: number;
    successorRoleProfileId: string;
    successorAgentProfileId: string;
    successorAttemptId?: string;
    preparedAt?: string;
  }): {
    success: boolean;
    transfer?: HandoffTransfer;
    successorAttempt?: TaskAttempt;
    alreadyPrepared?: boolean;
    error?: string;
    errorCode?:
      | 'TRANSFER_NOT_FOUND'
      | 'STATUS_CONFLICT'
      | 'VERSION_CONFLICT'
      | 'STALE_OWNERSHIP_EPOCH'
      | 'TASK_NOT_FOUND'
      | 'ROLE_PROFILE_NOT_FOUND'
      | 'ROLE_PROFILE_DISABLED'
      | 'AGENT_PROFILE_NOT_FOUND'
      | 'AGENT_PROFILE_DISABLED'
      | 'AGENT_PROFILE_ROLE_MISMATCH'
      | 'ATTEMPT_ID_ALREADY_EXISTS'
      | 'CONFLICTING_SUCCESSOR_PROFILE'
      | 'CONFLICTING_SUCCESSOR_ROLE'
      | 'INTERNAL_ERROR';
  } {
    return this.runInImmediateTransaction(() => {
      // 1. Re-read handoff transfer
      const transfer = this.getHandoffTransfer(params.transferId);
      if (!transfer) {
        return {
          success: false,
          errorCode: 'TRANSFER_NOT_FOUND',
          error: `Handoff transfer "${params.transferId}" not found.`,
        };
      }

      // Idempotent replay check: if already SUCCESSOR_PREPARED
      if (transfer.status === 'SUCCESSOR_PREPARED' && transfer.successor_attempt_id !== null) {
        if (transfer.successor_role_profile_id !== params.successorRoleProfileId) {
          return {
            success: false,
            errorCode: 'CONFLICTING_SUCCESSOR_ROLE',
            error: `Transfer is already prepared with successor role profile "${transfer.successor_role_profile_id}", expected "${params.successorRoleProfileId}".`,
          };
        }
        if (transfer.successor_agent_profile_id !== params.successorAgentProfileId) {
          return {
            success: false,
            errorCode: 'CONFLICTING_SUCCESSOR_PROFILE',
            error: `Transfer is already prepared with successor agent profile "${transfer.successor_agent_profile_id}", expected "${params.successorAgentProfileId}".`,
          };
        }
        if (transfer.successor_ownership_epoch !== params.expectedSuccessorEpoch) {
          return {
            success: false,
            errorCode: 'STALE_OWNERSHIP_EPOCH',
            error: `Transfer is already prepared with successor ownership epoch ${transfer.successor_ownership_epoch}, expected ${params.expectedSuccessorEpoch}.`,
          };
        }
        // If transfer already reached version + 1 (or + 2 if context bound), verify replay version
        if (params.expectedVersion < 1 || params.expectedVersion > transfer.version) {
          return {
            success: false,
            errorCode: 'VERSION_CONFLICT',
            error: `VERSION_CONFLICT: Replay expectedVersion ${params.expectedVersion} is invalid for current version ${transfer.version}.`,
          };
        }

        const existingAttempt = this.getTaskAttempt(transfer.successor_attempt_id);
        if (!existingAttempt) {
          return {
            success: false,
            errorCode: 'INTERNAL_ERROR',
            error: `Successor attempt "${transfer.successor_attempt_id}" not found in database.`,
          };
        }

        return {
          success: true,
          transfer,
          successorAttempt: existingAttempt,
          alreadyPrepared: true,
        };
      }

      // Precondition: status must be RELINQUISHED and relinquished_at must not be null
      if (transfer.status !== 'RELINQUISHED' || transfer.relinquished_at === null) {
        return {
          success: false,
          errorCode: 'STATUS_CONFLICT',
          error: `STATUS_CONFLICT: Expected transfer status RELINQUISHED with non-null relinquished_at, found status "${transfer.status}" (relinquished_at: ${transfer.relinquished_at}).`,
        };
      }

      // Version CAS check
      if (transfer.version !== params.expectedVersion) {
        return {
          success: false,
          errorCode: 'VERSION_CONFLICT',
          error: `VERSION_CONFLICT: Expected transfer version ${params.expectedVersion}, found ${transfer.version}.`,
        };
      }

      // 2. Re-read Task
      const task = this.getTask(transfer.task_id);
      if (!task) {
        return {
          success: false,
          errorCode: 'TASK_NOT_FOUND',
          error: `Task "${transfer.task_id}" not found.`,
        };
      }

      const currentTaskEpoch = task.ownership_epoch ?? 1;
      if (
        currentTaskEpoch !== params.expectedSuccessorEpoch ||
        currentTaskEpoch !== transfer.source_ownership_epoch + 1
      ) {
        return {
          success: false,
          errorCode: 'STALE_OWNERSHIP_EPOCH',
          error: `STALE_OWNERSHIP_EPOCH: Expected successor epoch ${params.expectedSuccessorEpoch}, current task epoch is ${currentTaskEpoch}, transfer source epoch was ${transfer.source_ownership_epoch}.`,
        };
      }

      // 3. Successor RoleProfile & AgentProfile validation inside transaction
      const roleProfile = this.getRoleProfile(params.successorRoleProfileId);
      if (!roleProfile) {
        return {
          success: false,
          errorCode: 'ROLE_PROFILE_NOT_FOUND',
          error: `ROLE_PROFILE_NOT_FOUND: Successor RoleProfile "${params.successorRoleProfileId}" not found.`,
        };
      }
      if (!roleProfile.enabled) {
        return {
          success: false,
          errorCode: 'ROLE_PROFILE_DISABLED',
          error: `ROLE_PROFILE_DISABLED: Successor RoleProfile "${params.successorRoleProfileId}" is disabled.`,
        };
      }

      const agentProfile = this.getAgentProfile(params.successorAgentProfileId);
      if (!agentProfile) {
        return {
          success: false,
          errorCode: 'AGENT_PROFILE_NOT_FOUND',
          error: `AGENT_PROFILE_NOT_FOUND: Successor AgentProfile "${params.successorAgentProfileId}" not found.`,
        };
      }
      if (!agentProfile.enabled) {
        return {
          success: false,
          errorCode: 'AGENT_PROFILE_DISABLED',
          error: `AGENT_PROFILE_DISABLED: Successor AgentProfile "${params.successorAgentProfileId}" is disabled.`,
        };
      }
      if (agentProfile.role_profile_id !== params.successorRoleProfileId) {
        return {
          success: false,
          errorCode: 'AGENT_PROFILE_ROLE_MISMATCH',
          error: `AGENT_PROFILE_ROLE_MISMATCH: Successor AgentProfile "${params.successorAgentProfileId}" role_profile_id is "${agentProfile.role_profile_id}", expected "${params.successorRoleProfileId}".`,
        };
      }

      // 4. Compute next attempt_number atomically
      const maxRow = this.db
        .prepare('SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_attempt_number FROM task_attempts WHERE task_id = ?')
        .get(transfer.task_id) as { next_attempt_number: number };
      const nextAttemptNumber = Number(maxRow.next_attempt_number);

      const successorAttemptId = params.successorAttemptId ?? ('att-' + crypto.randomUUID());

      // Check if attempt id already exists
      const existingAttempt = this.getTaskAttempt(successorAttemptId);
      if (existingAttempt) {
        return {
          success: false,
          errorCode: 'ATTEMPT_ID_ALREADY_EXISTS',
          error: `TaskAttempt with ID "${successorAttemptId}" already exists.`,
        };
      }

      const nowIso = params.preparedAt ?? new Date().toISOString();

      // 5. Create TaskAttempt N+1 ALWAYS in PENDING initial state
      const successorAttempt: TaskAttempt = {
        id: successorAttemptId,
        task_id: transfer.task_id,
        attempt_number: nextAttemptNumber,
        agent_id: null,
        agent_profile_id: params.successorAgentProfileId,
        status: 'PENDING',
        started_at: nowIso,
        ended_at: null,
        summary: null,
      };

      this.db
        .prepare(`
          INSERT INTO task_attempts (id, task_id, attempt_number, agent_id, agent_profile_id, status, started_at, ended_at, summary)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          successorAttempt.id,
          successorAttempt.task_id,
          successorAttempt.attempt_number,
          successorAttempt.agent_id,
          successorAttempt.agent_profile_id,
          successorAttempt.status,
          successorAttempt.started_at,
          successorAttempt.ended_at,
          successorAttempt.summary
        );

      // 6. Update handoff_transfers CAS
      const newVersion = transfer.version + 1;
      const transferRes = this.db
        .prepare(`
          UPDATE handoff_transfers
          SET status = 'SUCCESSOR_PREPARED',
              successor_attempt_id = ?,
              successor_role_profile_id = ?,
              successor_agent_profile_id = ?,
              successor_ownership_epoch = ?,
              version = ?,
              updated_at = ?
          WHERE id = ? AND version = ? AND status = 'RELINQUISHED'
        `)
        .run(
          successorAttemptId,
          params.successorRoleProfileId,
          params.successorAgentProfileId,
          currentTaskEpoch,
          newVersion,
          nowIso,
          transfer.id,
          transfer.version
        );

      if (transferRes.changes !== 1) {
        throw new Error(
          `[HandoffPrepareSuccessor] Failed to update transfer "${transfer.id}" status to SUCCESSOR_PREPARED.`
        );
      }

      const updatedTransfer = this.getHandoffTransfer(transfer.id)!;
      return {
        success: true,
        transfer: updatedTransfer,
        successorAttempt,
        alreadyPrepared: false,
      };
    });
  }

  public bindHandoffSuccessorContext(params: {
    transferId: string;
    expectedVersion: number;
    successorContextSnapshotId: string;
    successorContextSpecHash: string;
    boundAt?: string;
  }): {
    success: boolean;
    transfer?: HandoffTransfer;
    alreadyBound?: boolean;
    error?: string;
    errorCode?:
      | 'TRANSFER_NOT_FOUND'
      | 'STATUS_CONFLICT'
      | 'VERSION_CONFLICT'
      | 'STALE_OWNERSHIP_EPOCH'
      | 'TASK_NOT_FOUND'
      | 'SUCCESSOR_NOT_PREPARED'
      | 'CONTEXT_SNAPSHOT_NOT_FOUND'
      | 'CONTEXT_SNAPSHOT_INTEGRITY_MISMATCH'
      | 'CONTEXT_MANIFEST_NOT_FOUND'
      | 'SUCCESSOR_CONTEXT_SPEC_CONFLICT'
      | 'INTERNAL_ERROR';
  } {
    return this.runInImmediateTransaction(() => {
      const transfer = this.getHandoffTransfer(params.transferId);
      if (!transfer) {
        return {
          success: false,
          errorCode: 'TRANSFER_NOT_FOUND',
          error: `Handoff transfer "${params.transferId}" not found.`,
        };
      }

      if (transfer.status !== 'SUCCESSOR_PREPARED') {
        return {
          success: false,
          errorCode: 'STATUS_CONFLICT',
          error: `STATUS_CONFLICT: Expected transfer status SUCCESSOR_PREPARED, found "${transfer.status}".`,
        };
      }

      if (!transfer.successor_attempt_id) {
        return {
          success: false,
          errorCode: 'SUCCESSOR_NOT_PREPARED',
          error: `SUCCESSOR_NOT_PREPARED: Transfer "${params.transferId}" has no successor_attempt_id.`,
        };
      }

      const task = this.getTask(transfer.task_id);
      if (!task) {
        return {
          success: false,
          errorCode: 'TASK_NOT_FOUND',
          error: `Task "${transfer.task_id}" not found.`,
        };
      }

      if (task.ownership_epoch !== transfer.successor_ownership_epoch) {
        return {
          success: false,
          errorCode: 'STALE_OWNERSHIP_EPOCH',
          error: `STALE_OWNERSHIP_EPOCH: Current task epoch ${task.ownership_epoch} does not match transfer successor epoch ${transfer.successor_ownership_epoch}.`,
        };
      }

      // Check if already bound
      if (transfer.successor_context_snapshot_id !== null) {
        if (transfer.successor_context_snapshot_id !== params.successorContextSnapshotId) {
          return {
            success: false,
            errorCode: 'SUCCESSOR_CONTEXT_SPEC_CONFLICT',
            error: `SUCCESSOR_CONTEXT_SPEC_CONFLICT: Transfer is already bound to snapshot "${transfer.successor_context_snapshot_id}", cannot bind "${params.successorContextSnapshotId}".`,
          };
        }

        if (transfer.successor_context_spec_hash !== params.successorContextSpecHash) {
          return {
            success: false,
            errorCode: 'SUCCESSOR_CONTEXT_SPEC_CONFLICT',
            error: `SUCCESSOR_CONTEXT_SPEC_CONFLICT: Persisted spec hash "${transfer.successor_context_spec_hash}" does not match requested spec hash "${params.successorContextSpecHash}".`,
          };
        }

        // Validate persisted authoritative ContextSnapshot
        const snapshot = this.getContextSnapshot(params.successorContextSnapshotId);
        if (!snapshot) {
          return {
            success: false,
            errorCode: 'CONTEXT_SNAPSHOT_NOT_FOUND',
            error: `ContextSnapshot "${params.successorContextSnapshotId}" not found.`,
          };
        }

        if (
          snapshot.task_id !== transfer.task_id ||
          snapshot.attempt_id !== transfer.successor_attempt_id ||
          snapshot.purpose !== 'HANDOFF'
        ) {
          return {
            success: false,
            errorCode: 'CONTEXT_SNAPSHOT_INTEGRITY_MISMATCH',
            error: `ContextSnapshot integrity mismatch: task=${snapshot.task_id} (expected ${transfer.task_id}), attempt=${snapshot.attempt_id} (expected ${transfer.successor_attempt_id}), purpose=${snapshot.purpose} (expected HANDOFF).`,
          };
        }

        // Validate persisted authoritative ContextManifest
        const manifest = this.getContextManifestBySnapshotId(snapshot.id);
        if (!manifest) {
          return {
            success: false,
            errorCode: 'CONTEXT_MANIFEST_NOT_FOUND',
            error: `ContextManifest for snapshot "${snapshot.id}" not found.`,
          };
        }

        return {
          success: true,
          transfer,
          alreadyBound: true,
        };
      }

      // Unbound path: Version CAS check
      if (transfer.version !== params.expectedVersion) {
        return {
          success: false,
          errorCode: 'VERSION_CONFLICT',
          error: `VERSION_CONFLICT: Expected transfer version ${params.expectedVersion}, found ${transfer.version}.`,
        };
      }

      // Validate candidate ContextSnapshot
      const snapshot = this.getContextSnapshot(params.successorContextSnapshotId);
      if (!snapshot) {
        return {
          success: false,
          errorCode: 'CONTEXT_SNAPSHOT_NOT_FOUND',
          error: `ContextSnapshot "${params.successorContextSnapshotId}" not found.`,
        };
      }

      if (
        snapshot.task_id !== transfer.task_id ||
        snapshot.attempt_id !== transfer.successor_attempt_id ||
        snapshot.purpose !== 'HANDOFF'
      ) {
        return {
          success: false,
          errorCode: 'CONTEXT_SNAPSHOT_INTEGRITY_MISMATCH',
          error: `ContextSnapshot integrity mismatch: task=${snapshot.task_id} (expected ${transfer.task_id}), attempt=${snapshot.attempt_id} (expected ${transfer.successor_attempt_id}), purpose=${snapshot.purpose} (expected HANDOFF).`,
        };
      }

      // Validate candidate ContextManifest
      const manifest = this.getContextManifestBySnapshotId(snapshot.id);
      if (!manifest) {
        return {
          success: false,
          errorCode: 'CONTEXT_MANIFEST_NOT_FOUND',
          error: `ContextManifest for snapshot "${snapshot.id}" not found.`,
        };
      }

      const nowIso = params.boundAt ?? new Date().toISOString();
      const newVersion = transfer.version + 1;

      const res = this.db
        .prepare(`
          UPDATE handoff_transfers
          SET successor_context_snapshot_id = ?,
              successor_context_spec_hash = ?,
              version = ?,
              updated_at = ?
          WHERE id = ? AND version = ? AND status = 'SUCCESSOR_PREPARED' AND successor_context_snapshot_id IS NULL
        `)
        .run(
          params.successorContextSnapshotId,
          params.successorContextSpecHash,
          newVersion,
          nowIso,
          transfer.id,
          transfer.version
        );

      if (res.changes !== 1) {
        throw new Error(
          `[HandoffBindContext] Failed to update transfer "${transfer.id}" successor context pointer.`
        );
      }

      const updated = this.getHandoffTransfer(transfer.id)!;
      return {
        success: true,
        transfer: updated,
        alreadyBound: false,
      };
    });
  }

  public bindHandoffSuccessorRoute(params: {
    transferId: string;
    expectedVersion: number;
    expectedSuccessorEpoch: number;
    sourceAssignmentId: string;
    sourceProviderId: string;
    successorAttemptId: string;
    successorRoleProfileId: string;
    successorAgentProfileId: string;
    successorContextSnapshotId: string;
    successorContextSpecHash: string;
    selectedProviderId: string;
    selectedAccountId: string;
    selectedResourceId: string;
    routingDecisionId: string;
    routeSpecHash: string;
    canonicalRouteSpec: Record<string, unknown>;
    nowIso?: string;
  }): {
    success: boolean;
    transfer?: HandoffTransfer;
    assignment?: AgentAssignment;
    alreadyRouted?: boolean;
    errorCode?:
      | 'TRANSFER_NOT_FOUND'
      | 'TASK_NOT_FOUND'
      | 'STALE_OWNERSHIP_EPOCH'
      | 'STATUS_CONFLICT'
      | 'VERSION_CONFLICT'
      | 'SUCCESSOR_ROUTE_CONFLICT'
      | 'SOURCE_ASSIGNMENT_NOT_FOUND'
      | 'SOURCE_ASSIGNMENT_STATUS_MISMATCH'
      | 'SOURCE_PROVIDER_MISMATCH'
      | 'CROSS_PROVIDER_VIOLATION'
      | 'SUCCESSOR_ATTEMPT_NOT_FOUND'
      | 'SUCCESSOR_ATTEMPT_STATUS_MISMATCH'
      | 'ROLE_PROFILE_NOT_FOUND'
      | 'ROLE_PROFILE_DISABLED'
      | 'AGENT_PROFILE_NOT_FOUND'
      | 'AGENT_PROFILE_DISABLED'
      | 'AGENT_PROFILE_ROLE_MISMATCH'
      | 'CONTEXT_SNAPSHOT_NOT_FOUND'
      | 'CONTEXT_SNAPSHOT_INTEGRITY_MISMATCH'
      | 'CONTEXT_MANIFEST_NOT_FOUND'
      | 'SUCCESSOR_CONTEXT_SPEC_CONFLICT'
      | 'PROVIDER_NOT_FOUND'
      | 'PROVIDER_DISABLED'
      | 'PROVIDER_ACCOUNT_NOT_FOUND'
      | 'PROVIDER_ACCOUNT_MISMATCH'
      | 'PROVIDER_ACCOUNT_DISABLED'
      | 'PROVIDER_ACCOUNT_UNSAFE_HEALTH'
      | 'PROVIDER_RESOURCE_NOT_FOUND'
      | 'PROVIDER_RESOURCE_MISMATCH'
      | 'PROVIDER_RESOURCE_DISABLED'
      | 'PROVIDER_RESOURCE_UNSAFE_HEALTH'
      | 'PROVIDER_RESOURCE_QUOTA_EXHAUSTED'
      | 'PROVIDER_HEALTH_UNRESOLVED_AUTHORITY'
      | 'ROUTE_METADATA_CORRUPTION'
      | 'INTERNAL_ERROR';
    error?: string;
  } {
    return this.runInImmediateTransaction(() => {
      const transfer = this.getHandoffTransfer(params.transferId);
      if (!transfer) {
        return {
          success: false,
          errorCode: 'TRANSFER_NOT_FOUND',
          error: `Handoff transfer "${params.transferId}" not found.`,
        };
      }

      // 1. Idempotent replay on already ROUTED transfer
      if (transfer.status === 'ROUTED') {
        if (params.expectedVersion !== transfer.version - 1) {
          return {
            success: false,
            transfer,
            errorCode: 'VERSION_CONFLICT',
            error: `VERSION_CONFLICT: Expected pre-routing version ${transfer.version - 1}, received ${params.expectedVersion}.`,
          };
        }

        if (!transfer.successor_assignment_id) {
          return {
            success: false,
            transfer,
            errorCode: 'ROUTE_METADATA_CORRUPTION',
            error: `ROUTE_METADATA_CORRUPTION: Transfer "${params.transferId}" is ROUTED but successor_assignment_id is NULL.`,
          };
        }

        const existingAssignment = this.getAgentAssignment(transfer.successor_assignment_id);
        if (!existingAssignment) {
          return {
            success: false,
            transfer,
            errorCode: 'ROUTE_METADATA_CORRUPTION',
            error: `ROUTE_METADATA_CORRUPTION: Bound assignment "${transfer.successor_assignment_id}" not found in database.`,
          };
        }

        if (
          existingAssignment.task_id !== transfer.task_id ||
          existingAssignment.attempt_id !== params.successorAttemptId ||
          existingAssignment.role_profile_id !== params.successorRoleProfileId ||
          existingAssignment.agent_profile_id !== params.successorAgentProfileId
        ) {
          return {
            success: false,
            transfer,
            errorCode: 'ROUTE_METADATA_CORRUPTION',
            error: 'ROUTE_METADATA_CORRUPTION: Bound assignment attributes do not match transfer successor bindings.',
          };
        }

        const meta = existingAssignment.preferred_metadata;
        if (
          !meta ||
          typeof meta !== 'object' ||
          meta.handoff_route_spec_version !== 1 ||
          typeof meta.handoff_route_spec_hash !== 'string' ||
          !meta.handoff_route_spec ||
          typeof meta.handoff_route_spec !== 'object'
        ) {
          return {
            success: false,
            transfer,
            errorCode: 'ROUTE_METADATA_CORRUPTION',
            error: 'ROUTE_METADATA_CORRUPTION: Bound assignment preferred_metadata is missing or has invalid route spec structure.',
          };
        }

        const recomputedHash = computeSha256(canonicalJsonStringify(meta.handoff_route_spec));
        if (recomputedHash !== meta.handoff_route_spec_hash) {
          return {
            success: false,
            transfer,
            errorCode: 'ROUTE_METADATA_CORRUPTION',
            error: `ROUTE_METADATA_CORRUPTION: Stored route spec hash "${meta.handoff_route_spec_hash}" does not match recomputed hash "${recomputedHash}".`,
          };
        }

        if (meta.handoff_route_spec_hash !== params.routeSpecHash) {
          return {
            success: false,
            transfer,
            errorCode: 'SUCCESSOR_ROUTE_CONFLICT',
            error: `SUCCESSOR_ROUTE_CONFLICT: Transfer "${params.transferId}" already routed with spec hash "${meta.handoff_route_spec_hash}", cannot route with "${params.routeSpecHash}".`,
          };
        }

        if (existingAssignment.selected_provider_id === params.sourceProviderId) {
          return {
            success: false,
            transfer,
            errorCode: 'CROSS_PROVIDER_VIOLATION',
            error: `CROSS_PROVIDER_VIOLATION: Existing assignment selected provider "${existingAssignment.selected_provider_id}" matches source provider "${params.sourceProviderId}".`,
          };
        }

        return {
          success: true,
          transfer,
          assignment: existingAssignment,
          alreadyRouted: true,
        };
      }

      // 2. Transfer status check: must be SUCCESSOR_PREPARED
      if (transfer.status !== 'SUCCESSOR_PREPARED') {
        return {
          success: false,
          transfer,
          errorCode: 'STATUS_CONFLICT',
          error: `STATUS_CONFLICT: Expected transfer status SUCCESSOR_PREPARED, found "${transfer.status}".`,
        };
      }

      // 3. Version CAS check
      if (transfer.version !== params.expectedVersion) {
        return {
          success: false,
          transfer,
          errorCode: 'VERSION_CONFLICT',
          error: `VERSION_CONFLICT: Expected transfer version ${params.expectedVersion}, found ${transfer.version}.`,
        };
      }

      // 4. Successor ownership epoch check
      if (transfer.successor_ownership_epoch !== params.expectedSuccessorEpoch) {
        return {
          success: false,
          transfer,
          errorCode: 'STALE_OWNERSHIP_EPOCH',
          error: `STALE_OWNERSHIP_EPOCH: Expected successor epoch ${params.expectedSuccessorEpoch}, found ${transfer.successor_ownership_epoch}.`,
        };
      }

      // 5. Transfer pointer integrity checks
      if (transfer.source_assignment_id !== params.sourceAssignmentId) {
        return {
          success: false,
          transfer,
          errorCode: 'SOURCE_ASSIGNMENT_NOT_FOUND',
          error: `SOURCE_ASSIGNMENT_NOT_FOUND: Transfer source_assignment_id "${transfer.source_assignment_id}" does not match requested "${params.sourceAssignmentId}".`,
        };
      }

      if (transfer.successor_attempt_id !== params.successorAttemptId) {
        return {
          success: false,
          transfer,
          errorCode: 'SUCCESSOR_ATTEMPT_NOT_FOUND',
          error: `SUCCESSOR_ATTEMPT_NOT_FOUND: Transfer successor_attempt_id "${transfer.successor_attempt_id}" does not match requested "${params.successorAttemptId}".`,
        };
      }

      if (transfer.successor_role_profile_id !== params.successorRoleProfileId) {
        return {
          success: false,
          transfer,
          errorCode: 'ROLE_PROFILE_NOT_FOUND',
          error: `ROLE_PROFILE_NOT_FOUND: Transfer successor_role_profile_id "${transfer.successor_role_profile_id}" does not match requested "${params.successorRoleProfileId}".`,
        };
      }

      if (transfer.successor_agent_profile_id !== params.successorAgentProfileId) {
        return {
          success: false,
          transfer,
          errorCode: 'AGENT_PROFILE_NOT_FOUND',
          error: `AGENT_PROFILE_NOT_FOUND: Transfer successor_agent_profile_id "${transfer.successor_agent_profile_id}" does not match requested "${params.successorAgentProfileId}".`,
        };
      }

      if (transfer.successor_context_snapshot_id !== params.successorContextSnapshotId) {
        return {
          success: false,
          transfer,
          errorCode: 'CONTEXT_SNAPSHOT_NOT_FOUND',
          error: `CONTEXT_SNAPSHOT_NOT_FOUND: Transfer successor_context_snapshot_id "${transfer.successor_context_snapshot_id}" does not match requested "${params.successorContextSnapshotId}".`,
        };
      }

      if (transfer.successor_context_spec_hash !== params.successorContextSpecHash) {
        return {
          success: false,
          transfer,
          errorCode: 'SUCCESSOR_CONTEXT_SPEC_CONFLICT',
          error: `SUCCESSOR_CONTEXT_SPEC_CONFLICT: Transfer successor_context_spec_hash "${transfer.successor_context_spec_hash}" does not match requested "${params.successorContextSpecHash}".`,
        };
      }

      if (transfer.successor_assignment_id !== null) {
        return {
          success: false,
          transfer,
          errorCode: 'STATUS_CONFLICT',
          error: 'STATUS_CONFLICT: Transfer already has a non-null successor_assignment_id.',
        };
      }

      if (transfer.successor_authorization_id !== null) {
        return {
          success: false,
          transfer,
          errorCode: 'STATUS_CONFLICT',
          error: 'STATUS_CONFLICT: Transfer already has a non-null successor_authorization_id.',
        };
      }

      // 6. Task authority check
      const task = this.getTask(transfer.task_id);
      if (!task) {
        return {
          success: false,
          transfer,
          errorCode: 'TASK_NOT_FOUND',
          error: `Task "${transfer.task_id}" not found.`,
        };
      }

      if (task.ownership_epoch !== params.expectedSuccessorEpoch) {
        return {
          success: false,
          transfer,
          errorCode: 'STALE_OWNERSHIP_EPOCH',
          error: `STALE_OWNERSHIP_EPOCH: Current task epoch ${task.ownership_epoch} does not match expected successor epoch ${params.expectedSuccessorEpoch}.`,
        };
      }

      // 7. Source AgentAssignment validation
      const sourceAsgn = this.getAgentAssignment(params.sourceAssignmentId);
      if (
        !sourceAsgn ||
        sourceAsgn.task_id !== transfer.task_id ||
        sourceAsgn.attempt_id !== transfer.source_attempt_id
      ) {
        return {
          success: false,
          transfer,
          errorCode: 'SOURCE_ASSIGNMENT_NOT_FOUND',
          error: `SOURCE_ASSIGNMENT_NOT_FOUND: Source assignment "${params.sourceAssignmentId}" not found or does not match task/attempt.`,
        };
      }

      if (sourceAsgn.status !== 'HANDED_OFF') {
        return {
          success: false,
          transfer,
          errorCode: 'SOURCE_ASSIGNMENT_STATUS_MISMATCH',
          error: `SOURCE_ASSIGNMENT_STATUS_MISMATCH: Source assignment "${sourceAsgn.id}" status is "${sourceAsgn.status}", expected "HANDED_OFF".`,
        };
      }

      if (sourceAsgn.selected_provider_id !== params.sourceProviderId) {
        return {
          success: false,
          transfer,
          errorCode: 'SOURCE_PROVIDER_MISMATCH',
          error: `SOURCE_PROVIDER_MISMATCH: Source assignment provider "${sourceAsgn.selected_provider_id}" does not match requested "${params.sourceProviderId}".`,
        };
      }

      // 8. Successor TaskAttempt validation
      const succAttempt = this.getTaskAttempt(params.successorAttemptId);
      if (!succAttempt || succAttempt.task_id !== transfer.task_id) {
        return {
          success: false,
          transfer,
          errorCode: 'SUCCESSOR_ATTEMPT_NOT_FOUND',
          error: `SUCCESSOR_ATTEMPT_NOT_FOUND: Successor attempt "${params.successorAttemptId}" not found for task "${transfer.task_id}".`,
        };
      }

      if (succAttempt.status !== 'PENDING' || succAttempt.agent_id !== null) {
        return {
          success: false,
          transfer,
          errorCode: 'SUCCESSOR_ATTEMPT_STATUS_MISMATCH',
          error: `SUCCESSOR_ATTEMPT_STATUS_MISMATCH: Successor attempt status is "${succAttempt.status}", agent_id is "${succAttempt.agent_id}", expected status "PENDING" and NULL agent_id.`,
        };
      }

      // 9. RoleProfile & AgentProfile validation
      const roleProfile = this.getRoleProfile(params.successorRoleProfileId);
      if (!roleProfile) {
        return {
          success: false,
          transfer,
          errorCode: 'ROLE_PROFILE_NOT_FOUND',
          error: `ROLE_PROFILE_NOT_FOUND: Successor RoleProfile "${params.successorRoleProfileId}" not found.`,
        };
      }
      if (!roleProfile.enabled) {
        return {
          success: false,
          transfer,
          errorCode: 'ROLE_PROFILE_DISABLED',
          error: `ROLE_PROFILE_DISABLED: Successor RoleProfile "${params.successorRoleProfileId}" is disabled.`,
        };
      }

      const agentProfile = this.getAgentProfile(params.successorAgentProfileId);
      if (!agentProfile) {
        return {
          success: false,
          transfer,
          errorCode: 'AGENT_PROFILE_NOT_FOUND',
          error: `AGENT_PROFILE_NOT_FOUND: Successor AgentProfile "${params.successorAgentProfileId}" not found.`,
        };
      }
      if (!agentProfile.enabled) {
        return {
          success: false,
          transfer,
          errorCode: 'AGENT_PROFILE_DISABLED',
          error: `AGENT_PROFILE_DISABLED: Successor AgentProfile "${params.successorAgentProfileId}" is disabled.`,
        };
      }
      if (agentProfile.role_profile_id !== params.successorRoleProfileId) {
        return {
          success: false,
          transfer,
          errorCode: 'AGENT_PROFILE_ROLE_MISMATCH',
          error: `AGENT_PROFILE_ROLE_MISMATCH: AgentProfile role_profile_id "${agentProfile.role_profile_id}" does not match "${params.successorRoleProfileId}".`,
        };
      }

      // 10. Successor Context authority validation
      const snapshot = this.getContextSnapshot(params.successorContextSnapshotId);
      if (!snapshot) {
        return {
          success: false,
          transfer,
          errorCode: 'CONTEXT_SNAPSHOT_NOT_FOUND',
          error: `CONTEXT_SNAPSHOT_NOT_FOUND: ContextSnapshot "${params.successorContextSnapshotId}" not found.`,
        };
      }
      if (
        snapshot.task_id !== transfer.task_id ||
        snapshot.attempt_id !== params.successorAttemptId ||
        snapshot.purpose !== 'HANDOFF'
      ) {
        return {
          success: false,
          transfer,
          errorCode: 'CONTEXT_SNAPSHOT_INTEGRITY_MISMATCH',
          error: `CONTEXT_SNAPSHOT_INTEGRITY_MISMATCH: ContextSnapshot integrity mismatch for "${snapshot.id}".`,
        };
      }

      const manifest = this.getContextManifestBySnapshotId(snapshot.id);
      if (!manifest) {
        return {
          success: false,
          transfer,
          errorCode: 'CONTEXT_MANIFEST_NOT_FOUND',
          error: `CONTEXT_MANIFEST_NOT_FOUND: ContextManifest for snapshot "${snapshot.id}" not found.`,
        };
      }

      // 11. Selected Provider validation
      const provider = this.getProvider(params.selectedProviderId);
      if (!provider) {
        return {
          success: false,
          transfer,
          errorCode: 'PROVIDER_NOT_FOUND',
          error: `PROVIDER_NOT_FOUND: Provider "${params.selectedProviderId}" not found.`,
        };
      }
      if (!provider.enabled) {
        return {
          success: false,
          transfer,
          errorCode: 'PROVIDER_DISABLED',
          error: `PROVIDER_DISABLED: Provider "${params.selectedProviderId}" is disabled.`,
        };
      }
      if (params.selectedProviderId === params.sourceProviderId) {
        return {
          success: false,
          transfer,
          errorCode: 'CROSS_PROVIDER_VIOLATION',
          error: `CROSS_PROVIDER_VIOLATION: Selected provider "${params.selectedProviderId}" matches source provider "${params.sourceProviderId}".`,
        };
      }

      // 12. Selected ProviderAccount validation
      const account = this.getProviderAccount(params.selectedAccountId);
      if (!account) {
        return {
          success: false,
          transfer,
          errorCode: 'PROVIDER_ACCOUNT_NOT_FOUND',
          error: `PROVIDER_ACCOUNT_NOT_FOUND: ProviderAccount "${params.selectedAccountId}" not found.`,
        };
      }
      if (account.provider_id !== params.selectedProviderId) {
        return {
          success: false,
          transfer,
          errorCode: 'PROVIDER_ACCOUNT_MISMATCH',
          error: `PROVIDER_ACCOUNT_MISMATCH: Account provider_id "${account.provider_id}" does not match selected provider "${params.selectedProviderId}".`,
        };
      }
      if (!account.enabled) {
        return {
          success: false,
          transfer,
          errorCode: 'PROVIDER_ACCOUNT_DISABLED',
          error: `PROVIDER_ACCOUNT_DISABLED: ProviderAccount "${account.id}" is disabled.`,
        };
      }
      if (
        account.health_status === 'DISABLED' ||
        account.health_status === 'OFFLINE' ||
        account.health_status === 'UNHEALTHY' ||
        account.health_status === 'QUOTA_EXHAUSTED' ||
        account.health_status === 'AUTH_ERROR'
      ) {
        return {
          success: false,
          transfer,
          errorCode: 'PROVIDER_ACCOUNT_UNSAFE_HEALTH',
          error: `PROVIDER_ACCOUNT_UNSAFE_HEALTH: ProviderAccount "${account.id}" health status is "${account.health_status}".`,
        };
      }
      if (account.health_status === 'RATE_LIMITED' || account.health_status === 'COOLDOWN') {
        if (!account.cooldown_until) {
          return {
            success: false,
            transfer,
            errorCode: 'PROVIDER_ACCOUNT_UNSAFE_HEALTH',
            error: `PROVIDER_ACCOUNT_UNSAFE_HEALTH: ProviderAccount "${account.id}" is in "${account.health_status}" without cooldown_until.`,
          };
        }
        const cdMs = Date.parse(account.cooldown_until);
        const nowTime = params.nowIso ? Date.parse(params.nowIso) : Date.now();
        if (isNaN(cdMs) || cdMs > nowTime) {
          return {
            success: false,
            transfer,
            errorCode: 'PROVIDER_ACCOUNT_UNSAFE_HEALTH',
            error: `PROVIDER_ACCOUNT_UNSAFE_HEALTH: ProviderAccount "${account.id}" cooldown is active until ${account.cooldown_until}.`,
          };
        }
      }

      // 13. Selected ProviderResource validation
      const resource = this.getProviderResource(params.selectedResourceId);
      if (!resource) {
        return {
          success: false,
          transfer,
          errorCode: 'PROVIDER_RESOURCE_NOT_FOUND',
          error: `PROVIDER_RESOURCE_NOT_FOUND: ProviderResource "${params.selectedResourceId}" not found.`,
        };
      }
      if (resource.provider_id !== params.selectedProviderId) {
        return {
          success: false,
          transfer,
          errorCode: 'PROVIDER_RESOURCE_MISMATCH',
          error: `PROVIDER_RESOURCE_MISMATCH: Resource provider_id "${resource.provider_id}" does not match selected provider "${params.selectedProviderId}".`,
        };
      }
      if (!resource.provider_account_id || resource.provider_account_id !== params.selectedAccountId) {
        return {
          success: false,
          transfer,
          errorCode: 'PROVIDER_RESOURCE_MISMATCH',
          error: `PROVIDER_RESOURCE_MISMATCH: Resource provider_account_id "${resource.provider_account_id}" does not match selected account "${params.selectedAccountId}".`,
        };
      }
      if (!resource.enabled) {
        return {
          success: false,
          transfer,
          errorCode: 'PROVIDER_RESOURCE_DISABLED',
          error: `PROVIDER_RESOURCE_DISABLED: ProviderResource "${resource.id}" is disabled.`,
        };
      }
      if (
        resource.health_status === 'DISABLED' ||
        resource.health_status === 'OFFLINE' ||
        resource.health_status === 'UNHEALTHY' ||
        resource.health_status === 'QUOTA_EXHAUSTED' ||
        resource.health_status === 'AUTH_ERROR'
      ) {
        return {
          success: false,
          transfer,
          errorCode: 'PROVIDER_RESOURCE_UNSAFE_HEALTH',
          error: `PROVIDER_RESOURCE_UNSAFE_HEALTH: ProviderResource "${resource.id}" health status is "${resource.health_status}".`,
        };
      }
      if (['MEASURED', 'PROVIDER_REPORTED', 'MANUAL'].includes(resource.quota_source)) {
        if (resource.remaining_quota !== null && resource.remaining_quota !== undefined && resource.remaining_quota <= 0) {
          return {
            success: false,
            transfer,
            errorCode: 'PROVIDER_RESOURCE_QUOTA_EXHAUSTED',
            error: `PROVIDER_RESOURCE_QUOTA_EXHAUSTED: ProviderResource "${resource.id}" quota is exhausted (remaining_quota: ${resource.remaining_quota}, source: ${resource.quota_source}).`,
          };
        }
      }

      // 14. Provider health routing safety check
      const safety = this.evaluateProviderHealthRoutingSafety(params.selectedAccountId);
      if (safety.status !== 'SAFE') {
        return {
          success: false,
          transfer,
          errorCode: 'PROVIDER_HEALTH_UNRESOLVED_AUTHORITY',
          error: `PROVIDER_HEALTH_UNRESOLVED_AUTHORITY: Account "${params.selectedAccountId}" routing safety check returned "${safety.status}": ${safety.reason ?? ''}`.trim(),
        };
      }

      // 15. Create AgentAssignment
      const assignmentId = 'asgn-' + crypto.randomUUID();
      const nowIso = params.nowIso ?? new Date().toISOString();
      const assignment: AgentAssignment = {
        id: assignmentId,
        project_id: task.project_id,
        task_id: transfer.task_id,
        attempt_id: params.successorAttemptId,
        role_profile_id: params.successorRoleProfileId,
        agent_profile_id: params.successorAgentProfileId,
        selected_provider_id: params.selectedProviderId,
        selected_account_id: params.selectedAccountId,
        selected_resource_id: params.selectedResourceId,
        selected_worker_slot_id: null,
        routing_decision_id: params.routingDecisionId,
        preferred_metadata: {
          handoff_route_spec_version: 1,
          handoff_route_spec_hash: params.routeSpecHash,
          handoff_route_spec: params.canonicalRouteSpec,
        },
        status: 'ASSIGNED',
        created_at: nowIso,
        ended_at: null,
      };
      this.createAgentAssignment(assignment);

      // 16. Update transfer status CAS to ROUTED
      const newVersion = transfer.version + 1;
      const res = this.db
        .prepare(`
          UPDATE handoff_transfers
          SET status = 'ROUTED',
              successor_assignment_id = ?,
              version = ?,
              updated_at = ?
          WHERE id = ? AND version = ? AND status = 'SUCCESSOR_PREPARED'
        `)
        .run(
          assignmentId,
          newVersion,
          nowIso,
          transfer.id,
          transfer.version
        );

      if (res.changes !== 1) {
        throw new Error(
          `[HandoffBindRoute] Failed to update transfer "${transfer.id}" status to ROUTED.`
        );
      }

      const updatedTransfer = this.getHandoffTransfer(transfer.id)!;
      return {
        success: true,
        transfer: updatedTransfer,
        assignment,
        alreadyRouted: false,
      };
    });
  }

  private mapHandoffTransfer(row: Record<string, unknown>): HandoffTransfer {
    return {
      id: String(row.id),
      request_id: String(row.request_id),
      task_id: String(row.task_id),
      source_attempt_id: String(row.source_attempt_id),
      successor_attempt_id: row.successor_attempt_id ? String(row.successor_attempt_id) : null,
      source_assignment_id: String(row.source_assignment_id),
      successor_assignment_id: row.successor_assignment_id ? String(row.successor_assignment_id) : null,
      successor_role_profile_id: row.successor_role_profile_id ? String(row.successor_role_profile_id) : null,
      successor_agent_profile_id: row.successor_agent_profile_id ? String(row.successor_agent_profile_id) : null,
      successor_context_snapshot_id: row.successor_context_snapshot_id ? String(row.successor_context_snapshot_id) : null,
      successor_context_spec_hash: row.successor_context_spec_hash ? String(row.successor_context_spec_hash) : null,
      handoff_context_id: row.handoff_context_id ? String(row.handoff_context_id) : null,
      checkpoint_id: row.checkpoint_id ? String(row.checkpoint_id) : null,
      source_authorization_id: row.source_authorization_id ? String(row.source_authorization_id) : null,
      successor_authorization_id: row.successor_authorization_id ? String(row.successor_authorization_id) : null,
      reason: String(row.reason),
      status: row.status as HandoffTransferStatus,
      source_ownership_epoch: Number(row.source_ownership_epoch),
      successor_ownership_epoch: row.successor_ownership_epoch !== null && row.successor_ownership_epoch !== undefined ? Number(row.successor_ownership_epoch) : null,
      version: Number(row.version),
      frozen_at: row.frozen_at ? String(row.frozen_at) : null,
      quiescing_at: row.quiescing_at ? String(row.quiescing_at) : null,
      relinquished_at: row.relinquished_at ? String(row.relinquished_at) : null,
      accepted_at: row.accepted_at ? String(row.accepted_at) : null,
      completed_at: row.completed_at ? String(row.completed_at) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
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
    updates: Partial<Pick<ProviderAccount, 'label' | 'auth_mode' | 'credential_ref' | 'profile_ref' | 'enabled' | 'priority' | 'concurrency_limit'>>
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
            concurrency_limit = ?,
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
        updates.concurrency_limit !== undefined ? updates.concurrency_limit : existing.concurrency_limit,
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
      last_applied_action_account_order:
        row.last_applied_action_account_order !== null && row.last_applied_action_account_order !== undefined
          ? Number(row.last_applied_action_account_order)
          : null,
      last_applied_action_authorization_id:
        row.last_applied_action_authorization_id !== null && row.last_applied_action_authorization_id !== undefined
          ? String(row.last_applied_action_authorization_id)
          : null,
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
      source_ref: row.source_ref !== null && row.source_ref !== undefined ? String(row.source_ref) : null,
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

  public getProviderHealthObservation(authorizationId: string): ProviderHealthObservationRecord | null {
    const row = this.db
      .prepare('SELECT * FROM provider_health_observations WHERE authorization_id = ?')
      .get(authorizationId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapProviderHealthObservation(row);
  }

  public getProviderHealthObservationsForAccount(accountId: string, limit: number = 100): ProviderHealthObservationRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM provider_health_observations WHERE account_id = ? ORDER BY account_order ASC NULLS FIRST, observed_at ASC LIMIT ?')
      .all(accountId, limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapProviderHealthObservation(r));
  }

  public claimProviderHealthObservation(
    observation: ProviderHealthObservation,
    providerResult?: ProviderDispatchExecutionResult
  ): 'RECORDED' | 'ALREADY_RECORDED' {
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

      // 5. Provider result evidence verification & Category Authenticity
      if (!providerResult || typeof providerResult !== 'object') {
        throw new Error('PROVIDER_RESULT_REQUIRED: ProviderDispatchExecutionResult evidence is required for new observation claim.');
      }

      const prov = providerResult.providerExecutionProvenance;
      if (!prov || typeof prov !== 'object') {
        throw new Error('PROVENANCE_MISSING: Result has no provider execution provenance.');
      }

      if (prov.version !== 1) {
        throw new Error(`MALFORMED_PROVENANCE_VERSION: Unsupported provenance version ${prov.version}.`);
      }

      if (prov.source !== 'PROVIDER_DISPATCH_SERVICE') {
        throw new Error(`MALFORMED_PROVENANCE_SOURCE: Invalid provenance source "${prov.source}".`);
      }

      if (prov.executionId !== observation.execution_id || providerResult.executionId !== observation.execution_id) {
        throw new Error(
          `EXECUTION_ID_MISMATCH: Result/Provenance executionId ("${providerResult.executionId}" / "${prov.executionId}") does not match observation execution_id "${observation.execution_id}".`
        );
      }

      if (prov.authorizationId !== observation.authorization_id) {
        throw new Error(
          `AUTHORIZATION_ID_MISMATCH: Provenance authorizationId "${prov.authorizationId}" does not match observation authorization_id "${observation.authorization_id}".`
        );
      }

      if (prov.accountId !== observation.account_id) {
        throw new Error(
          `ACCOUNT_ID_MISMATCH: Provenance accountId "${prov.accountId}" does not match observation account_id "${observation.account_id}".`
        );
      }

      if (prov.providerId !== observation.provider_id) {
        throw new Error(
          `PROVIDER_ID_MISMATCH: Provenance providerId "${prov.providerId}" does not match observation provider_id "${observation.provider_id}".`
        );
      }

      if (prov.resourceId !== observation.resource_id) {
        throw new Error(
          `RESOURCE_ID_MISMATCH: Provenance resourceId "${prov.resourceId}" does not match observation resource_id "${observation.resource_id}".`
        );
      }

      if (prov.assignmentId !== observation.assignment_id) {
        throw new Error(
          `ASSIGNMENT_ID_MISMATCH: Provenance assignmentId "${prov.assignmentId}" does not match observation assignment_id "${observation.assignment_id}".`
        );
      }

      if ((prov.attemptId ?? null) !== (observation.attempt_id ?? null)) {
        throw new Error(
          `ATTEMPT_ID_MISMATCH: Provenance attemptId "${prov.attemptId}" does not match observation attempt_id "${observation.attempt_id}".`
        );
      }

      if (prov.routingDecisionId !== observation.routing_decision_id) {
        throw new Error(
          `ROUTING_DECISION_ID_MISMATCH: Provenance routingDecisionId "${prov.routingDecisionId}" does not match observation routing_decision_id "${observation.routing_decision_id}".`
        );
      }

      if (prov.mode !== observation.mode) {
        throw new Error(
          `MODE_MISMATCH: Provenance mode "${prov.mode}" does not match observation mode "${observation.mode}".`
        );
      }

      if (prov.adapterInvocation !== observation.adapter_invocation) {
        throw new Error(
          `ADAPTER_INVOCATION_MISMATCH: Provenance adapterInvocation "${prov.adapterInvocation}" does not match observation adapter_invocation "${observation.adapter_invocation}".`
        );
      }

      // 5b. Provider result status runtime bounding
      const VALID_PROVIDER_RESULT_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'AWAITING_OWNER']);
      if (typeof (providerResult as any).status !== 'string' || !VALID_PROVIDER_RESULT_STATUSES.has(providerResult.status)) {
        throw new Error(
          `INVALID_PROVIDER_RESULT_STATUS: Unsupported providerResult.status "${(providerResult as any).status}".`
        );
      }

      // 5c. Exact result status equality
      if (providerResult.status !== observation.result_status) {
        throw new Error(
          `PROVIDER_RESULT_STATUS_MISMATCH: providerResult.status "${providerResult.status}" does not match observation.result_status "${observation.result_status}".`
        );
      }

      // Independent category & result status derivation
      let expectedCategory: ProviderHealthObservationCategory;
      let expectedResultStatus: string;

      if (prov.adapterInvocation === 'THREW') {
        if (providerResult.status !== 'FAILED') {
          throw new Error(
            `PROVIDER_RESULT_STATUS_MISMATCH: THREW invocation requires providerResult.status "FAILED", got "${providerResult.status}".`
          );
        }
        expectedCategory = 'ADAPTER_THROW';
        expectedResultStatus = 'FAILED';
      } else if (providerResult.status === 'COMPLETED') {
        expectedCategory = 'SUCCESS';
        expectedResultStatus = 'COMPLETED';
      } else if (providerResult.status === 'AWAITING_OWNER') {
        expectedCategory = 'AWAITING_OWNER';
        expectedResultStatus = 'AWAITING_OWNER';
      } else if (providerResult.status === 'CANCELLED') {
        const classification = ExecutionFailureClassifier.classify(providerResult);
        expectedCategory = classification.category;
        expectedResultStatus = 'CANCELLED';
      } else if (providerResult.status === 'FAILED') {
        const classification = ExecutionFailureClassifier.classify(providerResult);
        expectedCategory = classification.category;
        expectedResultStatus = 'FAILED';
      } else {
        throw new Error(
          `INVALID_PROVIDER_RESULT_STATUS: Unsupported providerResult.status "${providerResult.status}".`
        );
      }

      if (observation.result_status !== expectedResultStatus) {
        throw new Error(
          `OBSERVATION_RESULT_STATUS_MISMATCH: Observation result_status "${observation.result_status}" does not match expected result_status "${expectedResultStatus}".`
        );
      }

      if (observation.classified_category !== expectedCategory) {
        throw new Error(
          `OBSERVATION_CATEGORY_MISMATCH: Observation classified_category "${observation.classified_category}" does not match canonical derived category "${expectedCategory}".`
        );
      }

      // 6. ExecutionAuthorization lookup + validation
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

      // 7. AgentAssignment lookup + validation
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

      // 8. TaskAttempt coherence when attempt_id non-null
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

      // 9. ProviderAccount coherence
      const account = this.getProviderAccount(observation.account_id);
      if (!account) {
        throw new Error(`PROVIDER_ACCOUNT_NOT_FOUND: ProviderAccount "${observation.account_id}" not found.`);
      }
      if (account.provider_id !== observation.provider_id) {
        throw new Error(
          `ACCOUNT_PROVIDER_MISMATCH: ProviderAccount provider_id "${account.provider_id}" does not match observation provider_id "${observation.provider_id}".`
        );
      }

      // 10. Provider coherence
      const provider = this.getProvider(observation.provider_id);
      if (!provider) {
        throw new Error(`PROVIDER_NOT_FOUND: Provider "${observation.provider_id}" not found.`);
      }

      // 11. ProviderResource coherence
      const resource = this.getProviderResource(observation.resource_id);
      if (!resource) {
        throw new Error(`PROVIDER_RESOURCE_NOT_FOUND: ProviderResource "${observation.resource_id}" not found.`);
      }
      if (resource.provider_id !== observation.provider_id) {
        throw new Error(
          `RESOURCE_PROVIDER_MISMATCH: ProviderResource provider_id "${resource.provider_id}" does not match observation provider_id "${observation.provider_id}".`
        );
      }
      if (resource.provider_account_id !== observation.account_id) {
        throw new Error(
          `RESOURCE_ACCOUNT_MISMATCH: ProviderResource provider_account_id "${resource.provider_account_id}" does not match observation account_id "${observation.account_id}".`
        );
      }

      // 12. Policy snapshot resolution and Action-Plan derivation from durable routing event
      let healthActionPlanVersion: 1 | null = null;
      let healthAction: ProviderAccountHealthAction | null = null;
      let healthActionCooldownDurationMs: number | null = null;
      let healthActionCooldownAnchorAt: string | null = null;

      const routingEventRow = this.db
        .prepare(`
          SELECT * FROM events
          WHERE (id = ? OR json_extract(structured_payload_json, '$.decisionId') = ?)
            AND type IN ('ROLE_AWARE_ROUTING_DECISION', 'PROVIDER_ROUTING_DECISION')
          ORDER BY timestamp DESC
          LIMIT 1
        `)
        .get(observation.routing_decision_id, observation.routing_decision_id) as Record<string, unknown> | undefined;

      if (routingEventRow) {
        const eventProjectId = routingEventRow.project_id ? String(routingEventRow.project_id) : null;
        const eventTaskId = routingEventRow.task_id ? String(routingEventRow.task_id) : null;
        if (eventProjectId === auth.project_id && (!eventTaskId || eventTaskId === auth.task_id)) {
          const payload = routingEventRow.structured_payload_json
            ? JSON.parse(String(routingEventRow.structured_payload_json))
            : {};

          const snapshot = payload.failoverPolicyAuthoritySnapshot;
          if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) && snapshot.version === 1) {
            let policyResult: FailoverPolicyParseResult | null = null;
            if (snapshot.status === 'VALID' && snapshot.policy && typeof snapshot.policy === 'object') {
              const revalidated = FailoverPolicyParser.parse(snapshot.policy);
              if (revalidated.status === 'VALID') {
                policyResult = { status: 'VALID', policy: revalidated.policy };
              } else {
                policyResult = { status: 'INVALID', error: 'SNAPSHOT_REVALIDATION_FAILED' };
              }
            } else if (snapshot.status === 'ABSENT') {
              policyResult = { status: 'ABSENT' };
            } else if (snapshot.status === 'INVALID') {
              policyResult = { status: 'INVALID', error: 'SNAPSHOT_STATUS_INVALID' };
            }

            if (policyResult) {
              const plan = FailureHealthMutationPolicyService.evaluate({
                providerResult,
                policyResult,
              });

              const planCategory = (plan.category === 'UNKNOWN' && observation.classified_category === 'ADAPTER_THROW')
                ? 'ADAPTER_THROW'
                : plan.category;

              if (
                plan.accountId === observation.account_id &&
                plan.executionId === observation.execution_id &&
                plan.authorizationId === observation.authorization_id &&
                planCategory === observation.classified_category
              ) {
                healthActionPlanVersion = 1;
                healthAction = plan.action;
                healthActionCooldownDurationMs = plan.cooldownDurationMs ?? null;
                if (
                  plan.action === 'RECORD_RATE_LIMITED' &&
                  plan.cooldownDurationMs !== null &&
                  plan.cooldownDurationMs !== undefined &&
                  plan.cooldownDurationMs > 0
                ) {
                  healthActionCooldownAnchorAt = new Date().toISOString();
                }
              }
            }
          }
        }
      }

      // 13. Calculate next account_order for this account
      const orderRow = this.db
        .prepare('SELECT COALESCE(MAX(account_order), 0) + 1 AS next_order FROM provider_health_observations WHERE account_id = ?')
        .get(observation.account_id) as { next_order: number };
      const nextOrder = Number(orderRow.next_order);

      // 14. Insert row
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
            observed_at,
            account_order,
            health_action_plan_version,
            health_action,
            health_action_cooldown_duration_ms,
            health_action_cooldown_anchor_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          observation.observed_at,
          nextOrder,
          healthActionPlanVersion,
          healthAction,
          healthActionCooldownDurationMs,
          healthActionCooldownAnchorAt
        );

      return 'RECORDED';
    });
  }

  private mapProviderHealthObservation(row: Record<string, unknown>): ProviderHealthObservationRecord {
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
      classified_category: String(row.classified_category) as ProviderHealthObservationCategory,
      observed_at: String(row.observed_at),
      account_order: row.account_order !== null && row.account_order !== undefined ? Number(row.account_order) : null,
      health_action_plan_version: row.health_action_plan_version !== null && row.health_action_plan_version !== undefined ? Number(row.health_action_plan_version) as 1 : null,
      health_action: row.health_action ? String(row.health_action) as ProviderAccountHealthAction : null,
      health_action_cooldown_duration_ms: row.health_action_cooldown_duration_ms !== null && row.health_action_cooldown_duration_ms !== undefined ? Number(row.health_action_cooldown_duration_ms) : null,
      health_action_cooldown_anchor_at: row.health_action_cooldown_anchor_at ? String(row.health_action_cooldown_anchor_at) : null,
    };
  }

  public applyDurableProviderHealthObservation(
    authorizationId: string
  ): ProviderHealthObservationApplicationResult {
    return this.runInImmediateTransaction(() => {
      // 1. Re-read durable observation
      const obs = this.getProviderHealthObservation(authorizationId);
      if (!obs) {
        return {
          status: 'REJECTED',
          accountId: 'UNKNOWN',
          authorizationId,
          accountOrder: null,
          healthAction: null,
          reason: `OBSERVATION_NOT_FOUND: Observation for authorization "${authorizationId}" does not exist.`,
        };
      }

      const accountId = obs.account_id;
      const account = this.getProviderAccount(accountId);
      if (!account) {
        return {
          status: 'REJECTED',
          accountId,
          authorizationId,
          accountOrder: obs.account_order,
          healthAction: obs.health_action,
          reason: `PROVIDER_ACCOUNT_NOT_FOUND: Account "${accountId}" does not exist.`,
        };
      }

      // 2. Validate Watermark Pair Coherence invariant: both absent OR both valid non-empty
      const currentWatermarkOrder = account.last_applied_action_account_order ?? null;
      const currentWatermarkAuth = account.last_applied_action_authorization_id ?? null;

      const hasWatermarkOrder = currentWatermarkOrder !== null && currentWatermarkOrder !== undefined;
      const authPresent = currentWatermarkAuth !== null && currentWatermarkAuth !== undefined;
      const authValid = authPresent && typeof currentWatermarkAuth === 'string' && currentWatermarkAuth.trim().length > 0;

      const isBothAbsent = !hasWatermarkOrder && !authPresent;
      const isBothValid = hasWatermarkOrder && authValid;

      if (!isBothAbsent && !isBothValid) {
        return {
          status: 'REJECTED',
          accountId,
          authorizationId,
          accountOrder: obs.account_order ?? null,
          healthAction: obs.health_action ?? null,
          watermarkAccountOrder: currentWatermarkOrder,
          watermarkAuthorizationId: currentWatermarkAuth,
          reason: `WATERMARK_PAIR_INTEGRITY_MISMATCH: ProviderAccount "${accountId}" has malformed or invalid watermark pair (order=${currentWatermarkOrder}, auth=${currentWatermarkAuth}).`,
        };
      }

      // 3. Check legacy unordered
      if (obs.account_order === null || obs.account_order === undefined) {
        return {
          status: 'LEGACY_UNORDERED',
          accountId,
          authorizationId,
          accountOrder: null,
          healthAction: obs.health_action,
          watermarkAccountOrder: currentWatermarkOrder,
          watermarkAuthorizationId: currentWatermarkAuth,
          reason: 'LEGACY_UNORDERED: Observation does not have a durable account_order.',
        };
      }

      // 4. Check action authority
      if (
        obs.health_action_plan_version !== 1 ||
        !obs.health_action ||
        !['RECORD_SUCCESS', 'RECORD_RATE_LIMITED', 'RECORD_QUOTA_EXHAUSTED', 'RECORD_AUTH_ERROR', 'NO_MUTATION'].includes(obs.health_action)
      ) {
        return {
          status: 'ACTION_AUTHORITY_UNKNOWN',
          accountId,
          authorizationId,
          accountOrder: obs.account_order,
          healthAction: obs.health_action ?? null,
          watermarkAccountOrder: currentWatermarkOrder,
          watermarkAuthorizationId: currentWatermarkAuth,
          reason: 'ACTION_AUTHORITY_UNKNOWN: Observation does not have valid plan_version 1 or known health_action.',
        };
      }

      // 5. Check temporal authority for RATE_LIMITED
      if (obs.health_action === 'RECORD_RATE_LIMITED') {
        if (
          !obs.health_action_cooldown_anchor_at ||
          obs.health_action_cooldown_duration_ms === null ||
          obs.health_action_cooldown_duration_ms === undefined ||
          obs.health_action_cooldown_duration_ms <= 0 ||
          Number.isNaN(Date.parse(obs.health_action_cooldown_anchor_at))
        ) {
          return {
            status: 'TEMPORAL_AUTHORITY_UNKNOWN',
            accountId,
            authorizationId,
            accountOrder: obs.account_order,
            healthAction: obs.health_action,
            watermarkAccountOrder: currentWatermarkOrder,
            watermarkAuthorizationId: currentWatermarkAuth,
            reason: 'TEMPORAL_AUTHORITY_UNKNOWN: RECORD_RATE_LIMITED requires non-null positive cooldown duration and valid anchor.',
          };
        }
      }

      // 6. Check NO_MUTATION
      if (obs.health_action === 'NO_MUTATION') {
        return {
          status: 'NO_MUTATION',
          accountId,
          authorizationId,
          accountOrder: obs.account_order,
          healthAction: 'NO_MUTATION',
          watermarkAccountOrder: currentWatermarkOrder,
          watermarkAuthorizationId: currentWatermarkAuth,
          reason: 'NO_MUTATION: Plan dictates no health state change.',
        };
      }

      // 7. Check existing watermark idempotency
      if (currentWatermarkOrder !== null && currentWatermarkOrder !== undefined) {
        if (obs.account_order === currentWatermarkOrder) {
          if (obs.authorization_id === currentWatermarkAuth) {
            return {
              status: 'ALREADY_APPLIED',
              accountId,
              authorizationId,
              accountOrder: obs.account_order,
              healthAction: obs.health_action,
              appliedHealthStatus: account.health_status,
              appliedCooldownUntil: account.cooldown_until,
              watermarkAccountOrder: currentWatermarkOrder,
              watermarkAuthorizationId: currentWatermarkAuth,
            };
          } else {
            return {
              status: 'REJECTED',
              accountId,
              authorizationId,
              accountOrder: obs.account_order,
              healthAction: obs.health_action,
              watermarkAccountOrder: currentWatermarkOrder,
              watermarkAuthorizationId: currentWatermarkAuth,
              reason: `WATERMARK_INTEGRITY_MISMATCH: Same account_order ${obs.account_order} already applied for different authorization "${currentWatermarkAuth}".`,
            };
          }
        }

        if (obs.account_order < currentWatermarkOrder) {
          return {
            status: 'STALE',
            accountId,
            authorizationId,
            accountOrder: obs.account_order,
            healthAction: obs.health_action,
            appliedHealthStatus: account.health_status,
            appliedCooldownUntil: account.cooldown_until,
            watermarkAccountOrder: currentWatermarkOrder,
            watermarkAuthorizationId: currentWatermarkAuth,
            reason: `STALE: Target account_order ${obs.account_order} is older than current applied watermark ${currentWatermarkOrder}.`,
          };
        }
      }

      // 7. Inspect newer ordered observations on the account (in account_order DESC)
      const newerRows = this.db
        .prepare(`
          SELECT * FROM provider_health_observations
          WHERE account_id = ? AND account_order IS NOT NULL AND account_order > ?
          ORDER BY account_order DESC
        `)
        .all(accountId, obs.account_order) as Record<string, unknown>[];

      for (const nRow of newerRows) {
        const nObs = this.mapProviderHealthObservation(nRow);
        if (nObs.health_action_plan_version === 1 && nObs.health_action === 'NO_MUTATION') {
          continue; // transparent
        }
        const isActionable =
          nObs.health_action_plan_version === 1 &&
          nObs.health_action &&
          ['RECORD_SUCCESS', 'RECORD_QUOTA_EXHAUSTED', 'RECORD_AUTH_ERROR', 'RECORD_RATE_LIMITED'].includes(nObs.health_action);

        if (isActionable) {
          if (nObs.health_action === 'RECORD_RATE_LIMITED') {
            const validTemporal =
              nObs.health_action_cooldown_anchor_at &&
              nObs.health_action_cooldown_duration_ms &&
              nObs.health_action_cooldown_duration_ms > 0 &&
              !Number.isNaN(Date.parse(nObs.health_action_cooldown_anchor_at));
            if (!validTemporal) {
              return {
                status: 'DEFERRED_BY_NEWER_UNKNOWN_AUTHORITY',
                accountId,
                authorizationId,
                accountOrder: obs.account_order,
                healthAction: obs.health_action,
                watermarkAccountOrder: currentWatermarkOrder,
                watermarkAuthorizationId: currentWatermarkAuth,
                reason: `DEFERRED_BY_NEWER_UNKNOWN_AUTHORITY: Newer observation ${nObs.authorization_id} (order ${nObs.account_order}) has unknown temporal authority.`,
              };
            }
          }
          return {
            status: 'STALE',
            accountId,
            authorizationId,
            accountOrder: obs.account_order,
            healthAction: obs.health_action,
            appliedHealthStatus: account.health_status,
            appliedCooldownUntil: account.cooldown_until,
            watermarkAccountOrder: currentWatermarkOrder,
            watermarkAuthorizationId: currentWatermarkAuth,
            reason: `STALE: Newer actionable observation ${nObs.authorization_id} (order ${nObs.account_order}) supersedes target order ${obs.account_order}.`,
          };
        } else {
          return {
            status: 'DEFERRED_BY_NEWER_UNKNOWN_AUTHORITY',
            accountId,
            authorizationId,
            accountOrder: obs.account_order,
            healthAction: obs.health_action,
            watermarkAccountOrder: currentWatermarkOrder,
            watermarkAuthorizationId: currentWatermarkAuth,
            reason: `DEFERRED_BY_NEWER_UNKNOWN_AUTHORITY: Newer observation ${nObs.authorization_id} (order ${nObs.account_order}) has unknown action authority.`,
          };
        }
      }

      // 8. Target is the newest effective candidate! Apply mutation and advance watermark atomically
      const now = new Date().toISOString();
      let targetHealthStatus: ProviderHealthStatus;
      let targetCooldownUntil: string | null = null;
      let targetFailureCode: string | null = null;

      if (obs.health_action === 'RECORD_SUCCESS') {
        targetHealthStatus = 'AVAILABLE';
        targetCooldownUntil = null;
        this.db
          .prepare(`
            UPDATE provider_accounts
            SET health_status = ?,
                cooldown_until = NULL,
                last_success_at = ?,
                updated_at = ?,
                last_applied_action_account_order = ?,
                last_applied_action_authorization_id = ?
            WHERE id = ?
          `)
          .run(
            targetHealthStatus,
            now,
            now,
            obs.account_order,
            obs.authorization_id,
            accountId
          );
      } else if (obs.health_action === 'RECORD_RATE_LIMITED') {
        targetHealthStatus = 'RATE_LIMITED';
        targetFailureCode = 'RATE_LIMITED';
        const anchorMs = Date.parse(obs.health_action_cooldown_anchor_at!);
        targetCooldownUntil = new Date(anchorMs + obs.health_action_cooldown_duration_ms!).toISOString();
        this.db
          .prepare(`
            UPDATE provider_accounts
            SET health_status = ?,
                cooldown_until = ?,
                last_failure_at = ?,
                last_failure_code = ?,
                updated_at = ?,
                last_applied_action_account_order = ?,
                last_applied_action_authorization_id = ?
            WHERE id = ?
          `)
          .run(
            targetHealthStatus,
            targetCooldownUntil,
            now,
            targetFailureCode,
            now,
            obs.account_order,
            obs.authorization_id,
            accountId
          );
      } else if (obs.health_action === 'RECORD_QUOTA_EXHAUSTED') {
        targetHealthStatus = 'QUOTA_EXHAUSTED';
        targetFailureCode = 'QUOTA_EXHAUSTED';
        targetCooldownUntil = null;
        this.db
          .prepare(`
            UPDATE provider_accounts
            SET health_status = ?,
                cooldown_until = NULL,
                last_failure_at = ?,
                last_failure_code = ?,
                updated_at = ?,
                last_applied_action_account_order = ?,
                last_applied_action_authorization_id = ?
            WHERE id = ?
          `)
          .run(
            targetHealthStatus,
            now,
            targetFailureCode,
            now,
            obs.account_order,
            obs.authorization_id,
            accountId
          );
      } else if (obs.health_action === 'RECORD_AUTH_ERROR') {
        targetHealthStatus = 'AUTH_ERROR';
        targetFailureCode = 'AUTHENTICATION_FAILURE';
        targetCooldownUntil = null;
        this.db
          .prepare(`
            UPDATE provider_accounts
            SET health_status = ?,
                cooldown_until = NULL,
                last_failure_at = ?,
                last_failure_code = ?,
                updated_at = ?,
                last_applied_action_account_order = ?,
                last_applied_action_authorization_id = ?
            WHERE id = ?
          `)
          .run(
            targetHealthStatus,
            now,
            targetFailureCode,
            now,
            obs.account_order,
            obs.authorization_id,
            accountId
          );
      } else {
        throw new Error(`UNEXPECTED_ACTION: Action "${obs.health_action}" cannot be applied.`);
      }

      return {
        status: 'APPLIED',
        accountId,
        authorizationId,
        accountOrder: obs.account_order,
        healthAction: obs.health_action,
        appliedHealthStatus: targetHealthStatus,
        appliedCooldownUntil: targetCooldownUntil,
        watermarkAccountOrder: obs.account_order,
        watermarkAuthorizationId: obs.authorization_id,
      };
    });
  }

  /**
   * Evaluates routing safety for a ProviderAccount by comparing the durable effective
   * health observation head against the account's persisted application watermark.
   *
   * Pure read-only operation: never mutates ProviderAccount state.
   */
  public evaluateProviderHealthRoutingSafety(accountId: string): ProviderHealthRoutingSafetyEvaluation {
    const account = this.getProviderAccount(accountId);
    if (!account) {
      return {
        status: 'SAFE',
        accountId,
        watermarkAccountOrder: null,
        watermarkAuthorizationId: null,
        effectiveHeadAccountOrder: null,
        effectiveHeadAuthorizationId: null,
        effectiveHeadHealthAction: null,
        reason: `ACCOUNT_NOT_FOUND: ProviderAccount "${accountId}" not found.`,
      };
    }

    const watermarkOrder = account.last_applied_action_account_order ?? null;
    const watermarkAuth = account.last_applied_action_authorization_id ?? null;

    const hasWatermarkOrder = watermarkOrder !== null && watermarkOrder !== undefined;
    const authPresent = watermarkAuth !== null && watermarkAuth !== undefined;
    const authValid = authPresent && typeof watermarkAuth === 'string' && watermarkAuth.trim().length > 0;

    const isBothAbsent = !hasWatermarkOrder && !authPresent;
    const isBothValid = hasWatermarkOrder && authValid;

    // 1. Watermark structural validation
    if (!isBothAbsent && !isBothValid) {
      return {
        status: 'WATERMARK_INTEGRITY_MISMATCH',
        accountId,
        watermarkAccountOrder: watermarkOrder,
        watermarkAuthorizationId: watermarkAuth,
        effectiveHeadAccountOrder: null,
        effectiveHeadAuthorizationId: null,
        effectiveHeadHealthAction: null,
        reason: `WATERMARK_INTEGRITY_MISMATCH: Malformed watermark pair (order=${watermarkOrder}, auth=${JSON.stringify(watermarkAuth)}).`,
      };
    }

    // 2. Watermark reference integrity (if non-null)
    if (isBothValid) {
      const watermarkedObs = this.getProviderHealthObservation(watermarkAuth!);
      if (!watermarkedObs) {
        return {
          status: 'WATERMARK_INTEGRITY_MISMATCH',
          accountId,
          watermarkAccountOrder: watermarkOrder,
          watermarkAuthorizationId: watermarkAuth,
          effectiveHeadAccountOrder: null,
          effectiveHeadAuthorizationId: null,
          effectiveHeadHealthAction: null,
          reason: `WATERMARK_INTEGRITY_MISMATCH: Watermark references non-existent observation "${watermarkAuth}".`,
        };
      }

      if (watermarkedObs.account_id !== accountId) {
        return {
          status: 'WATERMARK_INTEGRITY_MISMATCH',
          accountId,
          watermarkAccountOrder: watermarkOrder,
          watermarkAuthorizationId: watermarkAuth,
          effectiveHeadAccountOrder: null,
          effectiveHeadAuthorizationId: null,
          effectiveHeadHealthAction: null,
          reason: `WATERMARK_INTEGRITY_MISMATCH: Watermark references observation for different account "${watermarkedObs.account_id}".`,
        };
      }

      if (watermarkedObs.account_order !== watermarkOrder) {
        return {
          status: 'WATERMARK_INTEGRITY_MISMATCH',
          accountId,
          watermarkAccountOrder: watermarkOrder,
          watermarkAuthorizationId: watermarkAuth,
          effectiveHeadAccountOrder: null,
          effectiveHeadAuthorizationId: null,
          effectiveHeadHealthAction: null,
          reason: `WATERMARK_INTEGRITY_MISMATCH: Watermark order ${watermarkOrder} does not match referenced observation order ${watermarkedObs.account_order}.`,
        };
      }

      if (
        watermarkedObs.health_action_plan_version === 1 &&
        watermarkedObs.health_action === 'NO_MUTATION'
      ) {
        return {
          status: 'WATERMARK_INTEGRITY_MISMATCH',
          accountId,
          watermarkAccountOrder: watermarkOrder,
          watermarkAuthorizationId: watermarkAuth,
          effectiveHeadAccountOrder: null,
          effectiveHeadAuthorizationId: null,
          effectiveHeadHealthAction: null,
          reason: 'WATERMARK_INTEGRITY_MISMATCH: Watermark cannot point to a NO_MUTATION observation.',
        };
      }
    }

    // 3. Scan ordered observations for this account (newest -> oldest, NO LIMIT) to find effective head
    const rows = this.db
      .prepare(`
        SELECT authorization_id, account_id, account_order, health_action_plan_version, health_action,
               health_action_cooldown_duration_ms, health_action_cooldown_anchor_at
        FROM provider_health_observations
        WHERE account_id = ?
          AND account_order IS NOT NULL
        ORDER BY account_order DESC
      `)
      .all(accountId) as Record<string, unknown>[];

    let effectiveHead: Record<string, unknown> | null = null;
    for (const row of rows) {
      const planVer = row.health_action_plan_version !== null && row.health_action_plan_version !== undefined
        ? Number(row.health_action_plan_version)
        : null;
      const action = row.health_action ? String(row.health_action) : null;

      // Explicit valid NO_MUTATION is transparent
      if (planVer === 1 && action === 'NO_MUTATION') {
        continue;
      }

      // First non-NO_MUTATION ordered row is the effective head
      effectiveHead = row;
      break;
    }

    // 4. Case: No effective ordered head
    if (!effectiveHead) {
      if (isBothAbsent) {
        return {
          status: 'SAFE',
          accountId,
          watermarkAccountOrder: null,
          watermarkAuthorizationId: null,
          effectiveHeadAccountOrder: null,
          effectiveHeadAuthorizationId: null,
          effectiveHeadHealthAction: null,
        };
      } else {
        // Watermark exists but no non-NO_MUTATION head exists
        return {
          status: 'WATERMARK_INTEGRITY_MISMATCH',
          accountId,
          watermarkAccountOrder: watermarkOrder,
          watermarkAuthorizationId: watermarkAuth,
          effectiveHeadAccountOrder: null,
          effectiveHeadAuthorizationId: null,
          effectiveHeadHealthAction: null,
          reason: 'WATERMARK_INTEGRITY_MISMATCH: Watermark exists but no effective ordered observations found.',
        };
      }
    }

    const headOrder = Number(effectiveHead.account_order);
    const headAuth = String(effectiveHead.authorization_id);
    const headPlanVer = effectiveHead.health_action_plan_version !== null && effectiveHead.health_action_plan_version !== undefined
      ? Number(effectiveHead.health_action_plan_version)
      : null;
    const headAction = effectiveHead.health_action ? String(effectiveHead.health_action) : null;
    const headDuration = effectiveHead.health_action_cooldown_duration_ms !== null && effectiveHead.health_action_cooldown_duration_ms !== undefined
      ? Number(effectiveHead.health_action_cooldown_duration_ms)
      : null;
    const headAnchor = effectiveHead.health_action_cooldown_anchor_at ? String(effectiveHead.health_action_cooldown_anchor_at) : null;

    // 5. Watermark ahead of effective head check
    if (hasWatermarkOrder && watermarkOrder! > headOrder) {
      return {
        status: 'WATERMARK_INTEGRITY_MISMATCH',
        accountId,
        watermarkAccountOrder: watermarkOrder,
        watermarkAuthorizationId: watermarkAuth,
        effectiveHeadAccountOrder: headOrder,
        effectiveHeadAuthorizationId: headAuth,
        effectiveHeadHealthAction: headAction,
        reason: `WATERMARK_INTEGRITY_MISMATCH: Watermark order ${watermarkOrder} is ahead of effective head order ${headOrder}.`,
      };
    }

    // 6. Same order different authorization check
    if (hasWatermarkOrder && watermarkOrder === headOrder && watermarkAuth !== headAuth) {
      return {
        status: 'WATERMARK_INTEGRITY_MISMATCH',
        accountId,
        watermarkAccountOrder: watermarkOrder,
        watermarkAuthorizationId: watermarkAuth,
        effectiveHeadAccountOrder: headOrder,
        effectiveHeadAuthorizationId: headAuth,
        effectiveHeadHealthAction: headAction,
        reason: `WATERMARK_INTEGRITY_MISMATCH: Watermark auth "${watermarkAuth}" does not match effective head auth "${headAuth}" at order ${headOrder}.`,
      };
    }

    // 7. Check if effective head has unknown action authority
    const validActions = ['RECORD_SUCCESS', 'RECORD_QUOTA_EXHAUSTED', 'RECORD_AUTH_ERROR', 'RECORD_RATE_LIMITED'];
    if (headPlanVer !== 1 || !headAction || !validActions.includes(headAction)) {
      return {
        status: 'ACTION_AUTHORITY_UNKNOWN',
        accountId,
        watermarkAccountOrder: watermarkOrder,
        watermarkAuthorizationId: watermarkAuth,
        effectiveHeadAccountOrder: headOrder,
        effectiveHeadAuthorizationId: headAuth,
        effectiveHeadHealthAction: headAction,
        reason: `ACTION_AUTHORITY_UNKNOWN: Effective head observation "${headAuth}" has unknown action authority (planVer=${headPlanVer}, action=${headAction}).`,
      };
    }

    // 8. Check temporal authority for RECORD_RATE_LIMITED
    if (headAction === 'RECORD_RATE_LIMITED') {
      const isAnchorValid = headAnchor !== null && !isNaN(Date.parse(headAnchor));
      const isDurationValid = headDuration !== null && headDuration > 0;
      if (!isAnchorValid || !isDurationValid) {
        return {
          status: 'TEMPORAL_AUTHORITY_UNKNOWN',
          accountId,
          watermarkAccountOrder: watermarkOrder,
          watermarkAuthorizationId: watermarkAuth,
          effectiveHeadAccountOrder: headOrder,
          effectiveHeadAuthorizationId: headAuth,
          effectiveHeadHealthAction: headAction,
          reason: `TEMPORAL_AUTHORITY_UNKNOWN: Effective head observation "${headAuth}" has invalid cooldown anchor/duration.`,
        };
      }
    }

    // 9. Check if watermark is current with effective head
    if (hasWatermarkOrder && watermarkOrder === headOrder && watermarkAuth === headAuth) {
      return {
        status: 'SAFE',
        accountId,
        watermarkAccountOrder: watermarkOrder,
        watermarkAuthorizationId: watermarkAuth,
        effectiveHeadAccountOrder: headOrder,
        effectiveHeadAuthorizationId: headAuth,
        effectiveHeadHealthAction: headAction,
      };
    }

    // 10. Watermark is null or older than effective head
    return {
      status: 'PENDING_APPLICATION',
      accountId,
      watermarkAccountOrder: watermarkOrder,
      watermarkAuthorizationId: watermarkAuth,
      effectiveHeadAccountOrder: headOrder,
      effectiveHeadAuthorizationId: headAuth,
      effectiveHeadHealthAction: headAction,
      reason: `PENDING_APPLICATION: Effective head observation "${headAuth}" (order ${headOrder}) has not yet been applied to account watermark (order ${watermarkOrder}).`,
    };
  }
}
