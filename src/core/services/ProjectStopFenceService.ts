import crypto from 'crypto';
import Database from 'better-sqlite3';
import type { Repository } from '../database/repositories';

/**
 * Durable project admission fence used by emergency stop, authorization, and
 * provider dispatch.  The fence deliberately lives in a small service rather
 * than in the in-memory supervisor so a second process can make the same
 * decision after a restart.
 */
export interface ProjectStopFenceSnapshot {
  projectId: string;
  projectStatus: string;
  epoch: number;
  latched: boolean;
  reason: string | null;
  requestedAt: string | null;
}

export type ProjectStopMutationStatus =
  | 'STOPPED'
  | 'ALREADY_STOPPED'
  | 'RESUMED'
  | 'ALREADY_RESUMED'
  | 'STALE_EPOCH'
  | 'NOT_FOUND';

export interface ProjectStopMutation {
  projectId: string;
  status: ProjectStopMutationStatus;
  previousEpoch: number | null;
  epoch: number | null;
  tasksPaused: string[];
  tasksResumed: string[];
  error?: string;
}

export interface ProjectStopRequestResult {
  projects: ProjectStopMutation[];
  projectIds: string[];
  tasksPaused: string[];
}

export interface AuthorizationFenceResult {
  admitted: boolean;
  projectId: string;
  authorizationId: string;
  epoch: number | null;
  reason?: string;
}

export interface DispatchFenceResult {
  admitted: boolean;
  authorizationId: string;
  projectId: string | null;
  epoch: number | null;
  reason?: string;
}

type ProjectRow = {
  id: string;
  status: string;
  emergency_stop_epoch: number;
  emergency_stop_latched: number;
  emergency_stop_reason: string | null;
  emergency_stop_requested_at: string | null;
};

const ACTIVE_TASK_STATES = ['DISPATCHED', 'CODING', 'VALIDATING', 'REVIEWING'] as const;
const TERMINAL_PROJECT_STATES = ['COMPLETED', 'FAILED', 'CANCELLED'] as const;

export function sanitizeProjectStopReason(reason: string): string {
  const normalized = typeof reason === 'string' ? reason : String(reason ?? '');
  const safe = normalized.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return (safe.length > 512 ? safe.slice(0, 512) : safe) || 'Owner Emergency Stop Triggered';
}

function assertEpoch(epoch: unknown): number {
  if (!Number.isSafeInteger(epoch) || Number(epoch) < 0) {
    throw new Error(`PROJECT_STOP_EPOCH_INVALID: expected a non-negative safe integer, got ${String(epoch)}`);
  }
  return Number(epoch);
}

/**
 * SQLite-backed emergency-stop latch.  `ensureSchema` is intentionally
 * idempotent and runs under SQLite's immediate writer lock so an upgrade from
 * an older installation cannot race two supervisor processes.
 */
export class ProjectStopFenceService {
  private readonly db: Database.Database;

  public constructor(private readonly repo: Repository) {
    this.db = repo.getDatabase();
    this.ensureSchema();
  }

  private ensureSchema(): void {
    const tx = this.db.transaction(() => {
      const projectTable = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
        .get() as { name?: string } | undefined;
      if (!projectTable) {
        throw new Error('PROJECT_STOP_SCHEMA_MISSING: projects table is required before initializing the stop fence.');
      }

      const columns = new Set(
        (this.db.pragma('table_info(projects)') as Array<{ name: string }>).map((column) => column.name)
      );
      if (!columns.has('emergency_stop_epoch')) {
        this.db.exec(
          'ALTER TABLE projects ADD COLUMN emergency_stop_epoch INTEGER NOT NULL DEFAULT 0 CHECK (emergency_stop_epoch >= 0)'
        );
      }
      if (!columns.has('emergency_stop_latched')) {
        this.db.exec(
          'ALTER TABLE projects ADD COLUMN emergency_stop_latched INTEGER NOT NULL DEFAULT 0 CHECK (emergency_stop_latched IN (0, 1))'
        );
      }
      if (!columns.has('emergency_stop_reason')) {
        this.db.exec('ALTER TABLE projects ADD COLUMN emergency_stop_reason TEXT NULL');
      }
      if (!columns.has('emergency_stop_requested_at')) {
        this.db.exec('ALTER TABLE projects ADD COLUMN emergency_stop_requested_at TEXT NULL');
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS project_stop_admissions (
          authorization_id TEXT PRIMARY KEY REFERENCES execution_authorizations(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
          stop_epoch INTEGER NOT NULL CHECK (stop_epoch >= 0),
          captured_at TEXT NOT NULL,
          UNIQUE (authorization_id, project_id)
        );
        CREATE INDEX IF NOT EXISTS idx_project_stop_admissions_project
          ON project_stop_admissions(project_id, stop_epoch);

        CREATE TRIGGER IF NOT EXISTS trg_project_stop_dispatch_admission
        BEFORE UPDATE OF status ON execution_authorizations
        WHEN NEW.status = 'DISPATCHED' AND OLD.status = 'AUTHORIZED'
          AND EXISTS (
            SELECT 1
              FROM projects p
              LEFT JOIN project_stop_admissions a ON a.authorization_id = OLD.id
             WHERE p.id = OLD.project_id
               AND (
                 p.emergency_stop_latched = 1 OR
                 p.status = 'PAUSED' OR
                 p.emergency_stop_epoch <> COALESCE(a.stop_epoch, 0)
               )
          )
        BEGIN
          SELECT RAISE(ABORT, 'PROJECT_STOP_FENCE_REJECTED');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_project_stop_adapter_start_admission
        BEFORE UPDATE OF adapter_started_at, execution_id ON execution_authorizations
        WHEN NEW.adapter_started_at IS NOT NULL AND OLD.adapter_started_at IS NULL
          AND EXISTS (
            SELECT 1
              FROM projects p
              LEFT JOIN project_stop_admissions a ON a.authorization_id = OLD.id
             WHERE p.id = OLD.project_id
               AND (
                 p.emergency_stop_latched = 1 OR
                 p.status = 'PAUSED' OR
                 p.emergency_stop_epoch <> COALESCE(a.stop_epoch, 0)
               )
          )
        BEGIN
          SELECT RAISE(ABORT, 'PROJECT_STOP_FENCE_REJECTED');
        END;
      `);
    });
    tx.immediate();
  }

  public getFence(projectId: string): ProjectStopFenceSnapshot | null {
    const row = this.db
      .prepare(
        `SELECT id, status, emergency_stop_epoch, emergency_stop_latched,
                emergency_stop_reason, emergency_stop_requested_at
           FROM projects WHERE id = ?`
      )
      .get(projectId) as ProjectRow | undefined;
    if (!row) return null;
    return this.mapFence(row);
  }

  /**
   * Lifecycle admission used by ProjectService before any transition enters
   * RUNNING. A non-emergency pause is represented by the normal project state
   * and is therefore allowed to follow its ordinary state-machine transition;
   * the durable emergency latch always wins.
   */
  public assertProjectRunningAllowed(projectId: string): void {
    const fence = this.getFence(projectId);
    if (!fence) throw new Error(`PROJECT_NOT_FOUND: Project "${projectId}" was not found.`);
    if (fence.latched) {
      throw new Error(
        `PROJECT_EMERGENCY_STOP_LATCHED: Project "${projectId}" is emergency-stopped at epoch ${fence.epoch}. Resume it before starting.`
      );
    }
  }

  /**
   * Sets the latch and pauses active project/task state before any process kill
   * is attempted. Repeating the call is idempotent at the same epoch; active
   * tasks left behind by an uncertain first kill are reconciled on retry.
   */
  public requestStopForAllProjects(
    reason: string,
    expectedEpochByProject?: Readonly<Record<string, number>>,
    now: string = new Date().toISOString(),
    projectIds?: readonly string[]
  ): ProjectStopRequestResult {
    const safeReason = sanitizeProjectStopReason(reason);
    const tx = this.db.transaction(() => {
      const requestedProjectIds = projectIds !== undefined;
      const ids = requestedProjectIds
        ? Array.from(new Set(projectIds.filter((id) => typeof id === 'string' && id.trim() !== '')))
        : [];
      // An explicit target list is a scoped operation. An empty/invalid list
      // must be a no-op rather than silently widening to every project.
      const where = requestedProjectIds
        ? ids.length > 0
          ? `WHERE id IN (${ids.map(() => '?').join(', ')}) AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')`
          : `WHERE 1 = 0`
        : `WHERE status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')`;
      const rows = this.db
        .prepare(
          `SELECT id, status, emergency_stop_epoch, emergency_stop_latched,
                  emergency_stop_reason, emergency_stop_requested_at
             FROM projects
            ${where}
            ORDER BY id ASC`
        )
        .all(...ids) as ProjectRow[];
      const mutations: ProjectStopMutation[] = [];
      const allTasksPaused: string[] = [];

      for (const row of rows) {
        const expected = expectedEpochByProject?.[row.id];
        const previousEpoch = this.readEpoch(row.emergency_stop_epoch);
        if (expected !== undefined && previousEpoch !== assertEpoch(expected)) {
          mutations.push({
            projectId: row.id,
            status: 'STALE_EPOCH',
            previousEpoch,
            epoch: previousEpoch,
            tasksPaused: [],
            tasksResumed: [],
            error: `Expected epoch ${expected}, current epoch is ${previousEpoch}.`,
          });
          continue;
        }

        const alreadyLatched = Number(row.emergency_stop_latched) === 1;
        const nextEpoch = alreadyLatched ? previousEpoch : this.nextEpoch(previousEpoch);
        const status = alreadyLatched ? 'ALREADY_STOPPED' : 'STOPPED';
        this.db
          .prepare(
            `UPDATE projects
                SET status = CASE WHEN status = 'RUNNING' THEN 'PAUSED' ELSE status END,
                    emergency_stop_epoch = ?,
                    emergency_stop_latched = 1,
                    emergency_stop_reason = ?,
                    emergency_stop_requested_at = ?,
                    updated_at = ?
              WHERE id = ? AND emergency_stop_epoch = ?`
          )
          .run(
            nextEpoch,
            alreadyLatched ? row.emergency_stop_reason : safeReason,
            alreadyLatched ? row.emergency_stop_requested_at : now,
            now,
            row.id,
            previousEpoch
          );

        const tasksPaused = this.pauseActiveTasks(row.id, now);
        allTasksPaused.push(...tasksPaused);

        if (!alreadyLatched) {
          this.insertEvent(
            row.id,
            'EMERGENCY_STOP_REQUESTED',
            `Emergency stop admission fence latched for project ${row.id}.`,
            { projectId: row.id, stopEpoch: nextEpoch, latched: true, reason: safeReason },
            now
          );
        } else if (tasksPaused.length > 0) {
          this.insertEvent(
            row.id,
            'EMERGENCY_STOP_RECONCILED',
            `Emergency stop fence reconciliation paused ${tasksPaused.length} active task(s).`,
            { projectId: row.id, stopEpoch: nextEpoch, latched: true, reconciledTaskCount: tasksPaused.length },
            now
          );
        }

        mutations.push({
          projectId: row.id,
          status,
          previousEpoch,
          epoch: nextEpoch,
          tasksPaused,
          tasksResumed: [],
        });
      }

      return {
        projects: mutations,
        projectIds: mutations.filter((mutation) => mutation.epoch !== null).map((mutation) => mutation.projectId),
        tasksPaused: allTasksPaused,
      };
    });
    return tx.immediate();
  }

  public requestStopForProject(
    projectId: string,
    reason: string,
    expectedEpoch?: number,
    now: string = new Date().toISOString()
  ): ProjectStopRequestResult {
    const expected = expectedEpoch === undefined ? undefined : assertEpoch(expectedEpoch);
    return this.requestStopForAllProjects(
      reason,
      expected === undefined ? undefined : { [projectId]: expected },
      now,
      [projectId]
    );
  }

  public resumeProject(
    projectId: string,
    expectedEpoch?: number,
    now: string = new Date().toISOString()
  ): ProjectStopMutation {
    const expected = expectedEpoch === undefined ? undefined : assertEpoch(expectedEpoch);
    const tx = this.db.transaction(() => {
      const row = this.getProjectRow(projectId);
      if (!row) {
        return {
          projectId,
          status: 'NOT_FOUND' as const,
          previousEpoch: null,
          epoch: null,
          tasksPaused: [],
          tasksResumed: [],
        };
      }
      const previousEpoch = this.readEpoch(row.emergency_stop_epoch);
      if (expected !== undefined && expected !== previousEpoch) {
        return {
          projectId,
          status: 'STALE_EPOCH' as const,
          previousEpoch,
          epoch: previousEpoch,
          tasksPaused: [],
          tasksResumed: [],
          error: `Expected epoch ${expected}, current epoch is ${previousEpoch}.`,
        };
      }

      const latched = Number(row.emergency_stop_latched) === 1;
      if (!latched && row.status !== 'PAUSED') {
        return {
          projectId,
          status: 'ALREADY_RESUMED' as const,
          previousEpoch,
          epoch: previousEpoch,
          tasksPaused: [],
          tasksResumed: [],
        };
      }

      const nextEpoch = latched ? this.nextEpoch(previousEpoch) : previousEpoch;
      this.db
        .prepare(
          `UPDATE projects
              SET status = CASE WHEN status = 'PAUSED' THEN 'RUNNING' ELSE status END,
                  emergency_stop_epoch = ?,
                  emergency_stop_latched = 0,
                  emergency_stop_reason = NULL,
                  emergency_stop_requested_at = NULL,
                  updated_at = ?
            WHERE id = ? AND emergency_stop_epoch = ?`
        )
        .run(nextEpoch, now, projectId, previousEpoch);

      const tasksResumed = this.resumePausedTasks(projectId, now);
      this.insertEvent(
        projectId,
        'PROJECT_RESUMED',
        `Project ${projectId} resumed from emergency stop fence.`,
        { projectId, previousStopEpoch: previousEpoch, stopEpoch: nextEpoch, latched: false },
        now
      );
      return {
        projectId,
        status: 'RESUMED' as const,
        previousEpoch,
        epoch: nextEpoch,
        tasksPaused: [],
        tasksResumed,
      };
    });
    return tx.immediate();
  }

  /**
   * Bind a newly-created authorization to the epoch observed during its
   * asynchronous validation. The check and insert share one writer lock, so a
   * stop that wins the race invalidates the authorization rather than leaving
   * a stale admission behind.
   */
  public bindAuthorization(
    authorizationId: string,
    projectId: string,
    expectedEpoch: number,
    capturedAt: string = new Date().toISOString()
  ): AuthorizationFenceResult {
    const epoch = assertEpoch(expectedEpoch);
    const tx = this.db.transaction(() => {
      const project = this.getProjectRow(projectId);
      const auth = this.db
        .prepare('SELECT id, project_id, status FROM execution_authorizations WHERE id = ?')
        .get(authorizationId) as { id?: string; project_id?: string; status?: string } | undefined;
      if (!auth || auth.project_id !== projectId) {
        return this.authorizationFenceFailure(authorizationId, projectId, null, 'AUTHORIZATION_NOT_FOUND');
      }
      if (!project) {
        this.invalidateAuthorization(authorizationId);
        return this.authorizationFenceFailure(authorizationId, projectId, null, 'PROJECT_NOT_FOUND');
      }

      const currentEpoch = this.readEpoch(project.emergency_stop_epoch);
      if (Number(project.emergency_stop_latched) === 1 || project.status === 'PAUSED') {
        this.invalidateAuthorization(authorizationId);
        return this.authorizationFenceFailure(
          authorizationId,
          projectId,
          currentEpoch,
          `PROJECT_EMERGENCY_STOP_LATCHED: project is paused or latched at epoch ${currentEpoch}`
        );
      }
      if (currentEpoch !== epoch) {
        this.invalidateAuthorization(authorizationId);
        return this.authorizationFenceFailure(
          authorizationId,
          projectId,
          currentEpoch,
          `PROJECT_STOP_EPOCH_MISMATCH: expected ${epoch}, current epoch is ${currentEpoch}`
        );
      }

      const existing = this.db
        .prepare('SELECT project_id, stop_epoch FROM project_stop_admissions WHERE authorization_id = ?')
        .get(authorizationId) as { project_id?: string; stop_epoch?: number } | undefined;
      if (existing) {
        if (existing.project_id !== projectId || Number(existing.stop_epoch) !== epoch) {
          this.invalidateAuthorization(authorizationId);
          return this.authorizationFenceFailure(
            authorizationId,
            projectId,
            currentEpoch,
            'AUTHORIZATION_FENCE_CONFLICT: immutable authorization fence differs from the requested project epoch'
          );
        }
        return { admitted: true, projectId, authorizationId, epoch: currentEpoch };
      }

      this.db
        .prepare(
          `INSERT INTO project_stop_admissions (authorization_id, project_id, stop_epoch, captured_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(authorizationId, projectId, epoch, capturedAt);
      return { admitted: true, projectId, authorizationId, epoch: currentEpoch };
    });
    return tx.immediate();
  }

  /**
   * Atomic dispatch admission. SQLite serializes this writer transaction with
   * a concurrent stop/resume, making the epoch comparison the linearization
   * point for provider execution.
   */
  public claimAuthorization(
    authorizationId: string,
    dispatchedAt: string = new Date().toISOString()
  ): { claimed: boolean; projectId: string | null; epoch: number | null; reason?: string } {
    const tx = this.db.transaction(() => {
      const auth = this.db
        .prepare('SELECT id, project_id, status FROM execution_authorizations WHERE id = ?')
        .get(authorizationId) as { id?: string; project_id?: string; status?: string } | undefined;
      if (!auth) return { claimed: false, projectId: null, epoch: null, reason: 'AUTHORIZATION_NOT_FOUND' };
      const project = this.getProjectRow(String(auth.project_id));
      if (!project) return { claimed: false, projectId: String(auth.project_id), epoch: null, reason: 'PROJECT_NOT_FOUND' };
      const currentEpoch = this.readEpoch(project.emergency_stop_epoch);
      if (auth.status !== 'AUTHORIZED') {
        return {
          claimed: false,
          projectId: String(auth.project_id),
          epoch: currentEpoch,
          reason: `AUTHORIZATION_STATUS_${String(auth.status ?? 'UNKNOWN')}`,
        };
      }
      if (Number(project.emergency_stop_latched) === 1 || project.status === 'PAUSED') {
        return {
          claimed: false,
          projectId: String(auth.project_id),
          epoch: currentEpoch,
          reason: `PROJECT_EMERGENCY_STOP_LATCHED: project is paused or latched at epoch ${currentEpoch}`,
        };
      }

      const fence = this.db
        .prepare('SELECT project_id, stop_epoch FROM project_stop_admissions WHERE authorization_id = ?')
        .get(authorizationId) as { project_id?: string; stop_epoch?: number } | undefined;
      const boundEpoch = fence ? Number(fence.stop_epoch) : 0;
      if ((fence && fence.project_id !== auth.project_id) || currentEpoch !== boundEpoch) {
        return {
          claimed: false,
          projectId: String(auth.project_id),
          epoch: currentEpoch,
          reason: `PROJECT_STOP_EPOCH_MISMATCH: authorization epoch ${boundEpoch}, current epoch ${currentEpoch}`,
        };
      }

      const update = this.db
        .prepare(
          `UPDATE execution_authorizations
              SET status = 'DISPATCHED', dispatched_at = ?
            WHERE id = ? AND status = 'AUTHORIZED'`
        )
        .run(dispatchedAt, authorizationId);
      return {
        claimed: update.changes === 1,
        projectId: String(auth.project_id),
        epoch: currentEpoch,
        reason: update.changes === 1 ? undefined : 'AUTHORIZATION_CLAIM_CAS_FAILED',
      };
    });
    return tx.immediate();
  }

  public assertDispatchAdmission(authorizationId: string): DispatchFenceResult {
    const auth = this.db
      .prepare('SELECT id, project_id FROM execution_authorizations WHERE id = ?')
      .get(authorizationId) as { id?: string; project_id?: string } | undefined;
    if (!auth) return { admitted: false, authorizationId, projectId: null, epoch: null, reason: 'AUTHORIZATION_NOT_FOUND' };
    const project = this.getProjectRow(String(auth.project_id));
    if (!project) {
      return { admitted: false, authorizationId, projectId: String(auth.project_id), epoch: null, reason: 'PROJECT_NOT_FOUND' };
    }
    const currentEpoch = this.readEpoch(project.emergency_stop_epoch);
    if (Number(project.emergency_stop_latched) === 1 || project.status === 'PAUSED') {
      return {
        admitted: false,
        authorizationId,
        projectId: String(auth.project_id),
        epoch: currentEpoch,
        reason: `PROJECT_EMERGENCY_STOP_LATCHED: project is paused or latched at epoch ${currentEpoch}`,
      };
    }
    const fence = this.db
      .prepare('SELECT project_id, stop_epoch FROM project_stop_admissions WHERE authorization_id = ?')
      .get(authorizationId) as { project_id?: string; stop_epoch?: number } | undefined;
    const boundEpoch = fence ? Number(fence.stop_epoch) : 0;
    if ((fence && fence.project_id !== auth.project_id) || currentEpoch !== boundEpoch) {
      return {
        admitted: false,
        authorizationId,
        projectId: String(auth.project_id),
        epoch: currentEpoch,
        reason: `PROJECT_STOP_EPOCH_MISMATCH: authorization epoch ${boundEpoch}, current epoch ${currentEpoch}`,
      };
    }
    return { admitted: true, authorizationId, projectId: String(auth.project_id), epoch: currentEpoch };
  }

  private getProjectRow(projectId: string): ProjectRow | undefined {
    return this.db
      .prepare(
        `SELECT id, status, emergency_stop_epoch, emergency_stop_latched,
                emergency_stop_reason, emergency_stop_requested_at
           FROM projects WHERE id = ?`
      )
      .get(projectId) as ProjectRow | undefined;
  }

  private mapFence(row: ProjectRow): ProjectStopFenceSnapshot {
    return {
      projectId: row.id,
      projectStatus: row.status,
      epoch: this.readEpoch(row.emergency_stop_epoch),
      latched: Number(row.emergency_stop_latched) === 1,
      reason: row.emergency_stop_reason == null ? null : sanitizeProjectStopReason(String(row.emergency_stop_reason)),
      requestedAt: row.emergency_stop_requested_at == null ? null : String(row.emergency_stop_requested_at),
    };
  }

  private readEpoch(value: unknown): number {
    if (!Number.isSafeInteger(Number(value)) || Number(value) < 0) {
      throw new Error(`PROJECT_STOP_EPOCH_CORRUPT: persisted epoch is not a non-negative safe integer (${String(value)})`);
    }
    return Number(value);
  }

  private nextEpoch(current: number): number {
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new Error('PROJECT_STOP_EPOCH_EXHAUSTED: project stop epoch reached the safe integer limit.');
    }
    return current + 1;
  }

  private pauseActiveTasks(projectId: string, now: string): string[] {
    const placeholders = ACTIVE_TASK_STATES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT id, state FROM tasks WHERE project_id = ? AND state IN (${placeholders}) ORDER BY id ASC`)
      .all(projectId, ...ACTIVE_TASK_STATES) as Array<{ id: string; state: string }>;
    const pause = this.db.prepare(
      `UPDATE tasks SET state = 'PAUSED', paused_from_state = ?, updated_at = ? WHERE id = ? AND state = ?`
    );
    const taskIds: string[] = [];
    for (const task of rows) {
      const changed = pause.run(task.state, now, task.id, task.state);
      if (changed.changes !== 1) continue;
      taskIds.push(String(task.id));
      this.insertEvent(
        projectId,
        'TASK_PAUSED',
        `Task ${task.id} paused due to emergency stop (was in ${task.state}).`,
        { taskId: task.id, pausedFrom: task.state },
        now,
        task.id
      );
    }
    return taskIds;
  }

  private resumePausedTasks(projectId: string, now: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT id, paused_from_state FROM tasks
           WHERE project_id = ? AND state = 'PAUSED' AND paused_from_state IS NOT NULL
           ORDER BY id ASC`
      )
      .all(projectId) as Array<{ id: string; paused_from_state: string }>;
    const resume = this.db.prepare(
      `UPDATE tasks SET state = ?, paused_from_state = NULL, updated_at = ? WHERE id = ? AND state = 'PAUSED'`
    );
    const taskIds: string[] = [];
    for (const task of rows) {
      const changed = resume.run(task.paused_from_state, now, task.id);
      if (changed.changes !== 1) continue;
      taskIds.push(String(task.id));
      this.insertEvent(
        projectId,
        'TASK_RESUMED',
        `Task ${task.id} resumed after emergency stop.`,
        { taskId: task.id, resumedTo: task.paused_from_state },
        now,
        task.id
      );
    }
    return taskIds;
  }

  private insertEvent(
    projectId: string,
    type: string,
    summary: string,
    payload: Record<string, unknown>,
    timestamp: string,
    taskId: string | null = null
  ): void {
    this.db
      .prepare(
        `INSERT INTO events (id, project_id, task_id, agent_id, type, summary, structured_payload_json, timestamp)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`
      )
      .run(crypto.randomUUID(), projectId, taskId, type, summary, JSON.stringify(payload), timestamp);
  }

  private invalidateAuthorization(authorizationId: string): void {
    this.db
      .prepare("UPDATE execution_authorizations SET status = 'INVALIDATED' WHERE id = ? AND status = 'AUTHORIZED'")
      .run(authorizationId);
  }

  private authorizationFenceFailure(
    authorizationId: string,
    projectId: string,
    epoch: number | null,
    reason: string
  ): AuthorizationFenceResult {
    return { admitted: false, projectId, authorizationId, epoch, reason };
  }
}
